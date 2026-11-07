//! D-01 transactional Governance decision and signed-receipt persistence.

use chrono::DateTime;
use runalith_protocol::agg_checkpoint_v2::canonicalize;
use runalith_protocol::governance_v1::{GovernanceApprovalReceiptV1, GovernanceApprovalRequestV1};
use runalith_trust::governance_service::{
    GovernanceAuthenticator, GovernanceDecisionBackend, GovernanceDecisionVerificationMode,
    GovernanceDecisionVerifier, GovernanceServiceError, sign_governance_receipt,
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{Store, ensure_store_not_quarantined};

/// Concrete Store backend for Governance decisions on the D-01 SQLite file.
///
/// The injected verifier is responsible for current-candidate resolution and
/// cryptographic/policy/reviewer verification. It receives the exact writer
/// transaction used for nonce consumption, receipt signing, and persistence.
pub struct StoreGovernanceDecisionBackend<'a, V: ?Sized> {
    store: &'a Store,
    service_id: String,
    verifier: &'a V,
}

impl<'a, V> StoreGovernanceDecisionBackend<'a, V>
where
    V: GovernanceDecisionVerifier + ?Sized,
{
    /// Bind a transaction-aware verifier to this Store and stable service ID.
    pub fn new(
        store: &'a Store,
        service_id: impl Into<String>,
        verifier: &'a V,
    ) -> Result<Self, GovernanceServiceError> {
        let service_id = service_id.into();
        if service_id.trim().is_empty() || service_id.len() > 256 {
            return Err(GovernanceServiceError::InvalidConfiguration);
        }
        Ok(Self {
            store,
            service_id,
            verifier,
        })
    }
}

impl<V> GovernanceDecisionBackend for StoreGovernanceDecisionBackend<'_, V>
where
    V: GovernanceDecisionVerifier + ?Sized,
{
    fn evaluate_and_commit(
        &self,
        request: &GovernanceApprovalRequestV1,
        evidence: &Value,
        now: &str,
        service_id: &str,
        signer: &dyn GovernanceAuthenticator,
    ) -> Result<GovernanceApprovalReceiptV1, GovernanceServiceError> {
        request.validate()?;
        if service_id != self.service_id || request.audience != self.service_id {
            return Err(backend_error(
                "Governance service identity does not match request audience",
            ));
        }
        let current =
            DateTime::parse_from_rfc3339(now).map_err(|_| GovernanceServiceError::InvalidClock)?;
        let issued = DateTime::parse_from_rfc3339(&request.issued_at)
            .map_err(|_| GovernanceServiceError::InvalidClock)?;
        let expires = DateTime::parse_from_rfc3339(&request.expires_at)
            .map_err(|_| GovernanceServiceError::InvalidClock)?;
        if issued > current || expires <= current {
            return Err(GovernanceServiceError::RequestExpired);
        }

        let request_value =
            serde_json::to_value(request).map_err(|error| backend_error(error.to_string()))?;
        let request_json = canonical_json(&request_value)?;
        let subject_json = canonical_json(
            &serde_json::to_value(&request.subject)
                .map_err(|error| backend_error(error.to_string()))?,
        )?;
        let evidence_json = canonical_json(evidence)?;
        let request_sha256 = digest(request_json.as_bytes());
        let evidence_sha256 = digest(evidence_json.as_bytes());
        if evidence_sha256 != request.evidence_sha256 {
            return Err(GovernanceServiceError::EvidenceDigestMismatch);
        }

        let mut connection = self
            .store
            .connection
            .lock()
            .map_err(|_| backend_error("workflow database lock poisoned"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| backend_error(error.to_string()))?;
        ensure_store_not_quarantined(&transaction)
            .map_err(|error| backend_error(error.to_string()))?;

        let existing: Option<(String, String, String, String, String, Option<String>)> =
            transaction
                .query_row(
                    "SELECT request_id,request_sha256,evidence_sha256,subject_json,outcome_json,receipt_json
                     FROM governance_decisions WHERE idempotency_key=?1",
                    params![request.idempotency_key],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                        ))
                    },
                )
                .optional()
                .map_err(|error| backend_error(error.to_string()))?;

        if let Some((
            stored_request_id,
            stored_request_hash,
            stored_evidence_hash,
            stored_subject,
            stored_outcome,
            stored_receipt,
        )) = existing
        {
            if stored_request_id != request.request_id
                || stored_request_hash != request_sha256
                || stored_evidence_hash != evidence_sha256
                || stored_subject != subject_json
            {
                return Err(backend_error(
                    "Governance idempotency key is bound to a different request",
                ));
            }
            let outcome = self.verifier.verify_in_transaction(
                &transaction,
                request,
                evidence,
                now,
                GovernanceDecisionVerificationMode::Revalidate,
            )?;
            if canonical_json(
                &serde_json::to_value(&outcome)
                    .map_err(|error| backend_error(error.to_string()))?,
            )? != stored_outcome
            {
                return Err(backend_error(
                    "revalidated Governance outcome differs from immutable decision",
                ));
            }
            let stored_receipt = stored_receipt
                .as_deref()
                .ok_or_else(|| backend_error("stored Governance decision has no signed receipt"))?;
            let receipt: GovernanceApprovalReceiptV1 = serde_json::from_str(stored_receipt)
                .map_err(|error| backend_error(error.to_string()))?;
            receipt.validate_for(request, now)?;
            let mut expected_reviewer_subjects = outcome.reviewer_subjects.clone();
            expected_reviewer_subjects.sort();
            if receipt.decision_id != format!("govdec_{}", request.request_id)
                || receipt.decision != outcome.decision
                || receipt.policy_id != outcome.policy_id
                || receipt.policy_version != outcome.policy_version
                || receipt.policy_sha256 != outcome.policy_sha256
                || receipt.reviewer_subjects != expected_reviewer_subjects
            {
                return Err(backend_error(
                    "stored Governance receipt does not match revalidated decision",
                ));
            }
            verify_committed_event(
                &transaction,
                &receipt,
                &digest(stored_receipt.as_bytes()),
                &request_sha256,
                &evidence_sha256,
                &request.idempotency_key,
            )?;
            transaction
                .commit()
                .map_err(|error| backend_error(error.to_string()))?;
            return Ok(receipt);
        }

        let request_id_exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM governance_decisions WHERE request_id=?1)",
                params![request.request_id],
                |row| row.get(0),
            )
            .map_err(|error| backend_error(error.to_string()))?;
        if request_id_exists {
            return Err(backend_error(
                "Governance request ID is already bound to another idempotency key",
            ));
        }

        let outcome = self.verifier.verify_in_transaction(
            &transaction,
            request,
            evidence,
            now,
            GovernanceDecisionVerificationMode::Consume,
        )?;
        let outcome_json = canonical_json(
            &serde_json::to_value(&outcome).map_err(|error| backend_error(error.to_string()))?,
        )?;
        let receipt = sign_governance_receipt(request, &outcome, now, &self.service_id, signer)?;
        let receipt_json = canonical_json(
            &serde_json::to_value(&receipt).map_err(|error| backend_error(error.to_string()))?,
        )?;
        let receipt_sha256 = digest(receipt_json.as_bytes());
        let decision_id = receipt.decision_id.clone();
        let created_at = now.to_owned();
        transaction
            .execute(
                "INSERT INTO governance_decisions
                 (decision_id,request_id,idempotency_key,request_sha256,evidence_sha256,subject_json,outcome_json,created_at,receipt_json)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    decision_id,
                    request.request_id,
                    request.idempotency_key,
                    request_sha256,
                    evidence_sha256,
                    subject_json,
                    outcome_json,
                    created_at,
                    receipt_json,
                ],
            )
            .map_err(|error| backend_error(error.to_string()))?;
        let event_payload = serde_json::json!({
            "request_id": request.request_id,
            "idempotency_key": request.idempotency_key,
            "request_sha256": request_sha256,
            "evidence_sha256": evidence_sha256,
            "receipt_sha256": receipt_sha256,
            "decision": receipt.decision,
        });
        transaction
            .execute(
                "INSERT INTO governance_decision_events(event_id,decision_id,event_type,payload_json,created_at)
                 VALUES(?1,?2,'committed',?3,?4)",
                params![
                    Uuid::new_v4().simple().to_string(),
                    decision_id,
                    canonical_json(&event_payload)?,
                    created_at,
                ],
            )
            .map_err(|error| backend_error(error.to_string()))?;
        transaction
            .commit()
            .map_err(|error| backend_error(error.to_string()))?;
        Ok(receipt)
    }
}

fn canonical_json(value: &Value) -> Result<String, GovernanceServiceError> {
    canonicalize(value).map_err(|error| backend_error(error.to_string()))
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn verify_committed_event(
    transaction: &rusqlite::Transaction<'_>,
    receipt: &GovernanceApprovalReceiptV1,
    receipt_sha256: &str,
    request_sha256: &str,
    evidence_sha256: &str,
    idempotency_key: &str,
) -> Result<(), GovernanceServiceError> {
    let count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM governance_decision_events
             WHERE decision_id=?1 AND event_type='committed'",
            params![receipt.decision_id],
            |row| row.get(0),
        )
        .map_err(|error| backend_error(error.to_string()))?;
    if count != 1 {
        return Err(backend_error(
            "Governance decision must have exactly one committed event",
        ));
    }
    let raw: String = transaction
        .query_row(
            "SELECT payload_json FROM governance_decision_events
             WHERE decision_id=?1 AND event_type='committed' LIMIT 1",
            params![receipt.decision_id],
            |row| row.get(0),
        )
        .map_err(|error| backend_error(error.to_string()))?;
    let payload: Value =
        serde_json::from_str(&raw).map_err(|error| backend_error(error.to_string()))?;
    let decision =
        serde_json::to_value(receipt.decision).map_err(|error| backend_error(error.to_string()))?;
    if payload.get("request_id").and_then(Value::as_str) != Some(receipt.request_id.as_str())
        || payload.get("idempotency_key").and_then(Value::as_str) != Some(idempotency_key)
        || payload.get("request_sha256").and_then(Value::as_str) != Some(request_sha256)
        || payload.get("evidence_sha256").and_then(Value::as_str) != Some(evidence_sha256)
        || payload.get("receipt_sha256").and_then(Value::as_str) != Some(receipt_sha256)
        || payload.get("decision") != Some(&decision)
    {
        return Err(backend_error(
            "Governance committed event does not bind the persisted receipt and request",
        ));
    }
    Ok(())
}

fn backend_error(message: impl Into<String>) -> GovernanceServiceError {
    GovernanceServiceError::Backend(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use runalith_protocol::governance_v1::{ApprovalSubjectV1, GovernanceDecision};
    use runalith_trust::governance_service::VerifiedGovernanceOutcome;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const NOW: &str = "2026-11-01T10:01:00Z";

    struct Verifier {
        calls: AtomicUsize,
        modes: std::sync::Mutex<Vec<GovernanceDecisionVerificationMode>>,
        write_nonce: bool,
    }

    impl GovernanceDecisionVerifier for Verifier {
        fn verify_in_transaction(
            &self,
            transaction: &rusqlite::Transaction<'_>,
            _: &GovernanceApprovalRequestV1,
            _: &Value,
            _: &str,
            mode: GovernanceDecisionVerificationMode,
        ) -> Result<VerifiedGovernanceOutcome, GovernanceServiceError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.modes.lock().unwrap().push(mode);
            if self.write_nonce && mode == GovernanceDecisionVerificationMode::Consume {
                transaction
                    .execute(
                        "INSERT INTO agg_attestation_nonces(nonce,operation_id,checkpoint_sha256,consumed_at)
                         VALUES(?1,'governance-test',?2,?3)",
                        params!["a".repeat(64), "b".repeat(64), NOW],
                    )
                    .map_err(|error| backend_error(error.to_string()))?;
            }
            Ok(VerifiedGovernanceOutcome {
                decision: GovernanceDecision::Approved,
                policy_id: "policy-prod".into(),
                policy_version: 3,
                policy_sha256: "e".repeat(64),
                reviewer_subjects: vec!["maker".into(), "checker".into()],
                valid_until: "2026-11-01T10:04:00Z".into(),
            })
        }
    }

    struct Signer {
        fail: bool,
        calls: AtomicUsize,
    }

    impl GovernanceAuthenticator for Signer {
        fn authenticate_control(
            &self,
            _: &GovernanceApprovalRequestV1,
        ) -> Result<(), GovernanceServiceError> {
            Ok(())
        }

        fn sign_receipt(
            &self,
            _: &GovernanceApprovalReceiptV1,
        ) -> Result<Value, GovernanceServiceError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                return Err(GovernanceServiceError::Signing);
            }
            Ok(serde_json::json!({"signature":"test-only"}))
        }
    }

    fn request(evidence: &Value) -> GovernanceApprovalRequestV1 {
        GovernanceApprovalRequestV1 {
            schema_version: 1,
            request_id: "govreq_store_01".into(),
            producer: "workflow-control".into(),
            audience: "governance".into(),
            correlation_id: "corr_store_01".into(),
            idempotency_key: "idem_store_01".into(),
            subject: ApprovalSubjectV1 {
                workflow_id: "job_store_01".into(),
                candidate_id: "candidate_store_01".into(),
                candidate_sha256: "a".repeat(64),
                plan_sha256: "b".repeat(64),
                source_snapshot_sha256: "c".repeat(64),
                action_scope: "workflow.execute".into(),
            },
            evidence_sha256: digest(canonicalize(evidence).unwrap().as_bytes()),
            authenticator: serde_json::json!({"signature":"opaque-test"}),
            issued_at: "2026-11-01T10:00:00Z".into(),
            expires_at: "2026-11-01T10:05:00Z".into(),
        }
    }

    fn verifier(write_nonce: bool) -> Verifier {
        Verifier {
            calls: AtomicUsize::new(0),
            modes: std::sync::Mutex::new(Vec::new()),
            write_nonce,
        }
    }

    fn signer(fail: bool) -> Signer {
        Signer {
            fail,
            calls: AtomicUsize::new(0),
        }
    }

    #[test]
    fn decision_receipt_and_event_commit_atomically_and_exact_replay_returns_original() {
        let store = Store::in_memory().unwrap();
        let evidence = serde_json::json!({"schema_version":1,"policy":{},"maker_attestation":{},"decisions":[]});
        let request = request(&evidence);
        let verifier = verifier(false);
        let backend = StoreGovernanceDecisionBackend::new(&store, "governance", &verifier).unwrap();
        let signer = signer(false);

        let first = backend
            .evaluate_and_commit(&request, &evidence, NOW, "governance", &signer)
            .unwrap();
        assert_eq!(first.decision, GovernanceDecision::Approved);
        assert_eq!(
            first.reviewer_subjects,
            vec!["checker".to_owned(), "maker".to_owned()]
        );
        let replay = backend
            .evaluate_and_commit(&request, &evidence, NOW, "governance", &signer)
            .unwrap();
        assert_eq!(replay, first);
        assert_eq!(verifier.calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            *verifier.modes.lock().unwrap(),
            vec![
                GovernanceDecisionVerificationMode::Consume,
                GovernanceDecisionVerificationMode::Revalidate
            ]
        );
        assert_eq!(signer.calls.load(Ordering::SeqCst), 1);

        let connection = store.connection.lock().unwrap();
        let decisions: i64 = connection
            .query_row("SELECT COUNT(*) FROM governance_decisions", [], |row| {
                row.get(0)
            })
            .unwrap();
        let events: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM governance_decision_events",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let receipts: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM governance_decisions WHERE receipt_json IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((decisions, events, receipts), (1, 1, 1));
    }

    #[test]
    fn concurrent_exact_request_on_independent_store_connections_commits_once() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("governance-concurrency.sqlite");
        drop(Store::create_new(&path).unwrap());
        let left_store = std::sync::Arc::new(Store::open_existing(&path).unwrap());
        let right_store = std::sync::Arc::new(Store::open_existing(&path).unwrap());
        let evidence = serde_json::json!({"schema_version":1,"policy":{},"maker_attestation":{},"decisions":[]});
        let request = request(&evidence);
        let verifier = std::sync::Arc::new(verifier(false));
        let signer = std::sync::Arc::new(signer(false));

        let left = {
            let store = std::sync::Arc::clone(&left_store);
            let verifier = std::sync::Arc::clone(&verifier);
            let signer = std::sync::Arc::clone(&signer);
            let request = request.clone();
            let evidence = evidence.clone();
            std::thread::spawn(move || {
                let backend =
                    StoreGovernanceDecisionBackend::new(&store, "governance", verifier.as_ref())
                        .unwrap();
                backend.evaluate_and_commit(&request, &evidence, NOW, "governance", signer.as_ref())
            })
        };
        let right = {
            let store = std::sync::Arc::clone(&right_store);
            let verifier = std::sync::Arc::clone(&verifier);
            let signer = std::sync::Arc::clone(&signer);
            std::thread::spawn(move || {
                let backend =
                    StoreGovernanceDecisionBackend::new(&store, "governance", verifier.as_ref())
                        .unwrap();
                backend.evaluate_and_commit(&request, &evidence, NOW, "governance", signer.as_ref())
            })
        };

        let left_receipt = left.join().unwrap().unwrap();
        let right_receipt = right.join().unwrap().unwrap();
        assert_eq!(left_receipt, right_receipt);
        assert_eq!(signer.calls.load(Ordering::SeqCst), 1);
        assert_eq!(verifier.calls.load(Ordering::SeqCst), 2);

        let connection = left_store.connection.lock().unwrap();
        let decisions: i64 = connection
            .query_row("SELECT COUNT(*) FROM governance_decisions", [], |row| {
                row.get(0)
            })
            .unwrap();
        let events: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM governance_decision_events",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((decisions, events), (1, 1));
    }

    #[test]
    fn signer_failure_rolls_back_verifier_nonce_consumption_and_decision() {
        let store = Store::in_memory().unwrap();
        let evidence = serde_json::json!({"schema_version":1,"policy":{},"maker_attestation":{},"decisions":[]});
        let request = request(&evidence);
        let verifier = verifier(true);
        let backend = StoreGovernanceDecisionBackend::new(&store, "governance", &verifier).unwrap();
        let signer = signer(true);

        assert!(matches!(
            backend.evaluate_and_commit(&request, &evidence, NOW, "governance", &signer),
            Err(GovernanceServiceError::Signing)
        ));
        let connection = store.connection.lock().unwrap();
        let nonce_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM agg_attestation_nonces", [], |row| {
                row.get(0)
            })
            .unwrap();
        let decision_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM governance_decisions", [], |row| {
                row.get(0)
            })
            .unwrap();
        let event_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM governance_decision_events",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((nonce_count, decision_count, event_count), (0, 0, 0));
    }

    #[test]
    fn idempotency_key_cannot_be_rebound_to_changed_request_or_evidence() {
        let store = Store::in_memory().unwrap();
        let evidence = serde_json::json!({"schema_version":1,"policy":{},"maker_attestation":{},"decisions":[]});
        let request = request(&evidence);
        let verifier = verifier(false);
        let backend = StoreGovernanceDecisionBackend::new(&store, "governance", &verifier).unwrap();
        let signer = signer(false);
        backend
            .evaluate_and_commit(&request, &evidence, NOW, "governance", &signer)
            .unwrap();

        let mut changed = request.clone();
        changed.subject.candidate_id = "different-candidate".into();
        assert!(
            backend
                .evaluate_and_commit(&changed, &evidence, NOW, "governance", &signer)
                .is_err()
        );
        assert_eq!(verifier.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn replay_rejects_persisted_receipt_tampering_even_if_sql_trigger_is_bypassed() {
        let store = Store::in_memory().unwrap();
        let evidence = serde_json::json!({"schema_version":1,"policy":{},"maker_attestation":{},"decisions":[]});
        let request = request(&evidence);
        let verifier = verifier(false);
        let backend = StoreGovernanceDecisionBackend::new(&store, "governance", &verifier).unwrap();
        let signer = signer(false);
        backend
            .evaluate_and_commit(&request, &evidence, NOW, "governance", &signer)
            .unwrap();

        let connection = store.connection.lock().unwrap();
        connection
            .execute_batch("DROP TRIGGER governance_decisions_no_update;")
            .unwrap();
        let raw: String = connection
            .query_row(
                "SELECT receipt_json FROM governance_decisions WHERE request_id=?1",
                params![request.request_id],
                |row| row.get(0),
            )
            .unwrap();
        let mut receipt: Value = serde_json::from_str(&raw).unwrap();
        receipt["authenticator"]["signature"] = serde_json::json!("tampered");
        connection
            .execute(
                "UPDATE governance_decisions SET receipt_json=?1 WHERE request_id=?2",
                params![canonical_json(&receipt).unwrap(), request.request_id],
            )
            .unwrap();
        drop(connection);

        assert!(
            backend
                .evaluate_and_commit(&request, &evidence, NOW, "governance", &signer)
                .is_err()
        );
    }

    #[test]
    fn replay_rejects_committed_event_decision_tampering_even_if_trigger_is_bypassed() {
        let store = Store::in_memory().unwrap();
        let evidence = serde_json::json!({"schema_version":1,"policy":{},"maker_attestation":{},"decisions":[]});
        let request = request(&evidence);
        let verifier = verifier(false);
        let backend = StoreGovernanceDecisionBackend::new(&store, "governance", &verifier).unwrap();
        let signer = signer(false);
        backend
            .evaluate_and_commit(&request, &evidence, NOW, "governance", &signer)
            .unwrap();

        let connection = store.connection.lock().unwrap();
        connection
            .execute_batch("DROP TRIGGER governance_decision_events_no_update;")
            .unwrap();
        let raw: String = connection
            .query_row(
                "SELECT payload_json FROM governance_decision_events WHERE event_type='committed'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let mut payload: Value = serde_json::from_str(&raw).unwrap();
        payload["decision"] = serde_json::json!("rejected");
        connection
            .execute(
                "UPDATE governance_decision_events SET payload_json=?1 WHERE event_type='committed'",
                params![canonical_json(&payload).unwrap()],
            )
            .unwrap();
        drop(connection);

        assert!(
            backend
                .evaluate_and_commit(&request, &evidence, NOW, "governance", &signer)
                .is_err()
        );
    }
}
