//! Control-mediated session delivery with owner-epoch and ACL revalidation.

use chrono::{DateTime, Utc};
use thiserror::Error;

use crate::{SessionDeliveryEnvelope, WorkerStore, WorkerStoreError};

/// Result returned by Control after checking current lease, owner epoch, session identity and ACL.
#[derive(Debug, Clone, PartialEq)]
pub enum SessionDeliveryResult {
    /// Control completed delivery and durably recorded exact receipt.
    Delivered {
        /// Exact durable receipt returned by Control.
        receipt: serde_json::Value,
    },
    /// Control proves owner epoch or session ACL is stale; no delivery occurred.
    RejectedStale,
    /// Control proves transport was not invoked; retry is safe.
    NotSent {
        /// Evidence-backed diagnostic proving transport was not invoked.
        diagnostic: String,
    },
    /// Transport may have delivered; automatic retry is forbidden.
    Unknown {
        /// Diagnostic for an ambiguous transport outcome.
        diagnostic: String,
    },
}

/// Session gateway. Implementation must atomically revalidate current Control lease/epoch,
/// session binding and ACL immediately before invoking transport; message ID is idempotent.
pub trait SessionDeliveryControl: Send + Sync {
    /// Deliver one exact message through Control-owned session transport.
    fn deliver(&self, message: &SessionDeliveryEnvelope) -> Result<SessionDeliveryResult, String>;
}

/// Session delivery failure.
#[derive(Debug, Error)]
pub enum SessionDeliveryError {
    /// Worker persistence failed.
    #[error(transparent)]
    Store(#[from] WorkerStoreError),
    /// Worker identity is invalid.
    #[error("session delivery worker identity is invalid")]
    WorkerIdentity,
}

/// One attempt to deliver a durable session message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionDeliveryOutcome {
    /// No eligible message was available.
    Idle,
    /// Control acknowledged and persisted the exact receipt.
    Acked,
    /// Control rejected stale owner or ACL evidence.
    Rejected,
    /// Message expired or had an invalid expiry before transport was invoked.
    Expired,
    /// Transport was proven not sent and message was safely requeued.
    Retried,
    /// Delivery outcome is ambiguous and automatic retry is forbidden.
    Uncertain,
}

/// Fenced session delivery worker.
pub struct SessionDeliveryWorker<'a> {
    store: &'a WorkerStore,
    control: &'a dyn SessionDeliveryControl,
    worker_id: String,
}

impl<'a> SessionDeliveryWorker<'a> {
    /// Compose delivery against a worker-owned queue and Control gateway.
    pub fn new(
        store: &'a WorkerStore,
        control: &'a dyn SessionDeliveryControl,
        worker_id: impl Into<String>,
    ) -> Result<Self, SessionDeliveryError> {
        let worker_id = worker_id.into();
        if worker_id.trim().is_empty() || worker_id.len() > 256 {
            return Err(SessionDeliveryError::WorkerIdentity);
        }
        Ok(Self {
            store,
            control,
            worker_id,
        })
    }

    /// Deliver one message. Ambiguous transport results are persisted as UNCERTAIN and never retried.
    pub fn deliver_once(&self) -> Result<SessionDeliveryOutcome, SessionDeliveryError> {
        self.deliver_once_with_clock(Utc::now)
    }

    fn deliver_once_with_clock(
        &self,
        mut now: impl FnMut() -> DateTime<Utc>,
    ) -> Result<SessionDeliveryOutcome, SessionDeliveryError> {
        let Some(lease) = self.store.lease_session_delivery(&self.worker_id, 30)? else {
            return Ok(SessionDeliveryOutcome::Idle);
        };
        if lease.message.worker_id != self.worker_id {
            self.store.reject_session_delivery(&lease)?;
            return Ok(SessionDeliveryOutcome::Rejected);
        }
        if session_message_expired_at(&lease.message, now()) {
            // The message may have expired while waiting in the durable queue.
            // Reject locally before setting the transport-start marker so no
            // expired content is handed to a remote session transport.
            self.store.reject_session_delivery(&lease)?;
            return Ok(SessionDeliveryOutcome::Expired);
        }
        self.store.mark_session_delivery_started(&lease)?;
        // Persisting the transport-start marker can itself block behind SQLite
        // contention. Recheck after that write and immediately before the
        // external call so an expiry during marker persistence is still a
        // proven pre-transport rejection rather than a delivery attempt.
        if session_message_expired_at(&lease.message, now()) {
            self.store.reject_session_delivery(&lease)?;
            return Ok(SessionDeliveryOutcome::Expired);
        }
        match self.control.deliver(&lease.message) {
            Ok(SessionDeliveryResult::Delivered { receipt }) => {
                self.store.ack_session_delivery(&lease, &receipt)?;
                Ok(SessionDeliveryOutcome::Acked)
            }
            Ok(SessionDeliveryResult::RejectedStale) => {
                self.store.reject_session_delivery(&lease)?;
                Ok(SessionDeliveryOutcome::Rejected)
            }
            Ok(SessionDeliveryResult::NotSent { .. }) => {
                self.store.retry_session_delivery(&lease, 5)?;
                Ok(SessionDeliveryOutcome::Retried)
            }
            Ok(SessionDeliveryResult::Unknown { .. }) | Err(_) => {
                self.store.mark_session_delivery_uncertain(&lease)?;
                Ok(SessionDeliveryOutcome::Uncertain)
            }
        }
    }
}

fn session_message_expired_at(message: &SessionDeliveryEnvelope, now: DateTime<Utc>) -> bool {
    DateTime::parse_from_rfc3339(&message.expires_at)
        .ok()
        .map(|expiry| expiry.with_timezone(&Utc) <= now)
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Gateway {
        calls: AtomicUsize,
        result: SessionDeliveryResult,
    }
    impl SessionDeliveryControl for Gateway {
        fn deliver(&self, _: &SessionDeliveryEnvelope) -> Result<SessionDeliveryResult, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.result.clone())
        }
    }

    fn message() -> SessionDeliveryEnvelope {
        SessionDeliveryEnvelope {
            message_id: "message-1".into(),
            idempotency_key: "dedupe-1".into(),
            workflow_id: "workflow-1".into(),
            task_id: "task-1".into(),
            attempt: 2,
            owner_epoch: 9,
            lease_id: "lease-1".into(),
            worker_id: "worker-1".into(),
            session_id: "session-1".into(),
            recipient_role: "qa".into(),
            message_type: "session.message".into(),
            payload: serde_json::json!({"artifact":"sha256:abc"}),
            expires_at: (chrono::Utc::now() + chrono::Duration::minutes(1)).to_rfc3339(),
        }
    }

    #[test]
    fn stale_owner_is_rejected_and_ambiguous_delivery_is_quarantined() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        store.enqueue_session_delivery(&message()).unwrap();
        let stale = Gateway {
            calls: AtomicUsize::new(0),
            result: SessionDeliveryResult::RejectedStale,
        };
        let worker = SessionDeliveryWorker::new(&store, &stale, "worker-1").unwrap();
        assert_eq!(
            worker.deliver_once().unwrap(),
            SessionDeliveryOutcome::Rejected
        );
        assert_eq!(
            store
                .session_delivery_state("message-1")
                .unwrap()
                .as_deref(),
            Some("REJECTED")
        );
        assert_eq!(stale.calls.load(Ordering::SeqCst), 1);

        let uncertain_message = SessionDeliveryEnvelope {
            message_id: "message-2".into(),
            idempotency_key: "dedupe-2".into(),
            ..message()
        };
        store.enqueue_session_delivery(&uncertain_message).unwrap();
        let uncertain = Gateway {
            calls: AtomicUsize::new(0),
            result: SessionDeliveryResult::Unknown {
                diagnostic: "connection reset after send".into(),
            },
        };
        let worker = SessionDeliveryWorker::new(&store, &uncertain, "worker-1").unwrap();
        assert_eq!(
            worker.deliver_once().unwrap(),
            SessionDeliveryOutcome::Uncertain
        );
        assert_eq!(
            store
                .session_delivery_state("message-2")
                .unwrap()
                .as_deref(),
            Some("UNCERTAIN")
        );
        assert_eq!(worker.deliver_once().unwrap(), SessionDeliveryOutcome::Idle);
        assert_eq!(uncertain.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn duplicate_enqueue_is_idempotent_and_conflicting_payload_is_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let first = message();
        assert!(store.enqueue_session_delivery(&first).unwrap());
        assert!(!store.enqueue_session_delivery(&first).unwrap());
        let mut changed = first;
        changed.payload["artifact"] = serde_json::json!("sha256:changed");
        assert!(matches!(
            store.enqueue_session_delivery(&changed),
            Err(WorkerStoreError::ClaimConflict)
        ));
    }

    #[test]
    fn expired_queued_message_is_rejected_before_transport_and_malformed_expiry_at_enqueue() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let queued = SessionDeliveryEnvelope {
            message_id: "message-expires-in-queue".into(),
            idempotency_key: "dedupe-expires-in-queue".into(),
            expires_at: (chrono::Utc::now() + chrono::Duration::milliseconds(100)).to_rfc3339(),
            ..message()
        };
        let malformed = SessionDeliveryEnvelope {
            message_id: "message-malformed-expiry".into(),
            idempotency_key: "dedupe-malformed-expiry".into(),
            expires_at: "not-rfc3339".into(),
            ..message()
        };
        store.enqueue_session_delivery(&queued).unwrap();
        assert!(matches!(
            store.enqueue_session_delivery(&malformed),
            Err(WorkerStoreError::Transition(_))
        ));
        drop(store);
        std::thread::sleep(std::time::Duration::from_millis(150));
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();

        let gateway = Gateway {
            calls: AtomicUsize::new(0),
            result: SessionDeliveryResult::Delivered {
                receipt: serde_json::json!({"delivery_id":"should-not-be-called"}),
            },
        };
        let worker = SessionDeliveryWorker::new(&store, &gateway, "worker-1").unwrap();
        assert_eq!(
            worker.deliver_once().unwrap(),
            SessionDeliveryOutcome::Expired
        );
        assert_eq!(gateway.calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            store
                .session_delivery_state("message-expires-in-queue")
                .unwrap()
                .as_deref(),
            Some("REJECTED")
        );
    }

    #[test]
    fn expiry_during_transport_start_persistence_is_rejected_before_gateway() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let expiry = Utc::now() + chrono::Duration::seconds(5);
        let queued = SessionDeliveryEnvelope {
            message_id: "message-expires-during-marker".into(),
            idempotency_key: "dedupe-expires-during-marker".into(),
            expires_at: expiry.to_rfc3339(),
            ..message()
        };
        store.enqueue_session_delivery(&queued).unwrap();

        let gateway = Gateway {
            calls: AtomicUsize::new(0),
            result: SessionDeliveryResult::Delivered {
                receipt: serde_json::json!({"delivery_id":"must-not-be-called"}),
            },
        };
        let worker = SessionDeliveryWorker::new(&store, &gateway, "worker-1").unwrap();
        let clock_values = [expiry - chrono::Duration::milliseconds(1), expiry];
        let mut clock_index = 0;
        assert_eq!(
            worker
                .deliver_once_with_clock(|| {
                    let value = clock_values[clock_index];
                    clock_index += 1;
                    value
                })
                .unwrap(),
            SessionDeliveryOutcome::Expired
        );
        assert_eq!(clock_index, 2);
        assert_eq!(gateway.calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            store
                .session_delivery_state("message-expires-during-marker")
                .unwrap()
                .as_deref(),
            Some("REJECTED")
        );
    }
}
