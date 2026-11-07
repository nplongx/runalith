//! Durable Execution-owned session, ACL and delivery facts.
//!
//! The adapter accepts a connection supplied by the Execution host. It never
//! opens or creates a database itself. `initialize_schema` is an explicit
//! schema hook for disposable stores and host-owned Execution schema
//! composition; it is not a database split, migration runner or production
//! cutover authorization.
//!
//! Caller identities passed to permission checks must already have been
//! authenticated by the host. This module records local delivery facts only;
//! it does not authenticate producers, verify provider outcomes, issue claims,
//! or decide whether artifact bytes are trusted evidence.

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::contracts::{
    SessionAclV1, SessionDeliveryOutcomeV1, SessionDeliveryReceiptV1, SessionDeliveryRequestV1,
    SessionExpiryObservationV1, SessionPermissionV1, SessionRefV1,
};

const SESSION_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS w5_session_schema_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL
);
INSERT OR IGNORE INTO w5_session_schema_meta(singleton, schema_version) VALUES (1, 1);

CREATE TABLE IF NOT EXISTS w5_sessions (
    session_id TEXT PRIMARY KEY,
    session_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS w5_session_acls (
    session_id TEXT PRIMARY KEY REFERENCES w5_sessions(session_id),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    acl_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS w5_session_acl_operations (
    session_id TEXT NOT NULL REFERENCES w5_sessions(session_id),
    operation_id TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    resulting_revision INTEGER NOT NULL CHECK (resulting_revision >= 1),
    PRIMARY KEY (session_id, operation_id)
);

CREATE TABLE IF NOT EXISTS w5_session_messages (
    message_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES w5_sessions(session_id),
    sender_subject_id TEXT NOT NULL,
    sender_service_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    request_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('PENDING', 'IN_FLIGHT', 'ACKNOWLEDGED', 'REJECTED', 'UNCERTAIN', 'EXPIRED')),
    delivery_attempt INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempt >= 0),
    delivery_service_id TEXT,
    started_at TEXT,
    UNIQUE (session_id, sender_service_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS w5_session_messages_pending
    ON w5_session_messages(state, session_id, message_id);

CREATE TABLE IF NOT EXISTS w5_session_delivery_receipts (
    message_id TEXT NOT NULL REFERENCES w5_session_messages(message_id),
    delivery_attempt INTEGER NOT NULL CHECK (delivery_attempt >= 1),
    receipt_json TEXT NOT NULL,
    PRIMARY KEY (message_id, delivery_attempt)
);

CREATE TABLE IF NOT EXISTS w5_session_expiry_observations (
    session_id TEXT NOT NULL REFERENCES w5_sessions(session_id),
    observer_service_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    observation_json TEXT NOT NULL,
    PRIMARY KEY (session_id, observer_service_id, observed_at)
);
"#;

/// Session persistence failure. None of these errors implies that delivery
/// occurred; callers must preserve UNKNOWN if a transport may have run.
#[derive(Debug, Error)]
pub enum SessionStoreError {
    /// SQLite operation failed.
    #[error("session persistence error: {0}")]
    Sql(#[from] rusqlite::Error),
    /// Contract or identity validation failed.
    #[error("session contract rejected: {0}")]
    Contract(String),
    /// A stored JSON contract could not be decoded.
    #[error("stored session contract is invalid: {0}")]
    Serialization(#[from] serde_json::Error),
    /// An immutable identity or idempotency key was reused with different data.
    #[error("session idempotency conflict")]
    Conflict,
    /// The session, message or ACL does not exist.
    #[error("session record not found")]
    NotFound,
    /// Persisted session, ACL, delivery or receipt bytes are inconsistent.
    #[error("stored session state failed integrity validation: {0}")]
    Integrity(String),
    /// The authenticated host subject lacks the requested session permission.
    #[error("session permission denied")]
    Forbidden,
    /// The requested delivery state transition is not permitted.
    #[error("session delivery state does not permit this operation")]
    InvalidState,
    /// The expected ACL revision does not match the current revision.
    #[error("session ACL revision conflict")]
    RevisionConflict,
    /// The required W5 tables are absent from the host-provided connection.
    #[error("W5 session schema has not been initialized on the supplied Execution connection")]
    SchemaMissing,
}

/// Result of inserting a session identity and its initial ACL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionRegistration {
    /// New session and ACL revision 1 were committed.
    Created,
    /// Exact duplicate registration; no data was changed.
    IdempotentReplay,
}

/// Current ACL snapshot and its compare-and-swap revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionAclSnapshotV1 {
    /// Monotonic revision, starting at 1.
    pub revision: u64,
    /// Complete explicit ACL state at this revision.
    pub acl: SessionAclV1,
}

/// Result of an ACL replacement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AclUpdateDisposition {
    /// A new ACL revision was committed.
    Updated,
    /// Exact retry of a previously committed operation.
    IdempotentReplay,
}

/// Result of enqueueing a session message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnqueueDisposition {
    /// A new immutable request was committed to the pending queue.
    Enqueued,
    /// Exact duplicate; the existing message identity is returned.
    IdempotentReplay {
        /// Existing immutable message identity.
        message_id: String,
    },
}

/// Result of beginning a one-shot delivery attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeliveryStart {
    /// The request was expired before the transport-start marker was written.
    Expired,
    /// Attempt 1 was durably marked in flight; the caller may now invoke its
    /// authenticated transport exactly once.
    Started {
        /// Exact request whose transport-start marker is durable.
        request: Box<SessionDeliveryRequestV1>,
    },
}

/// Result of writing a delivery receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceiptDisposition {
    /// First receipt for the in-flight attempt was committed.
    Recorded,
    /// Exact duplicate receipt; no data was changed.
    IdempotentReplay,
}

/// Durable message state and its latest receipt, if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionDeliverySnapshotV1 {
    /// Immutable request.
    pub request: SessionDeliveryRequestV1,
    /// `PENDING`, `IN_FLIGHT`, `ACKNOWLEDGED`, `REJECTED`, `UNCERTAIN` or `EXPIRED`.
    pub state: String,
    /// Number of the one allowed local delivery attempt (zero before start).
    pub delivery_attempt: u64,
    /// Authenticated delivery service identity, once started.
    pub delivery_service_id: Option<String>,
    /// Exact durable receipt for attempt 1, if recorded.
    pub receipt: Option<SessionDeliveryReceiptV1>,
}

/// Result of appending an expiry observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExpiryObservationDisposition {
    /// A new append-only observation was committed.
    Recorded,
    /// Exact duplicate observation; no data was changed.
    IdempotentReplay,
}

/// W5 persistence adapter over a host-provided Execution database connection.
pub struct SessionStore {
    connection: Connection,
}

type InFlightDeliveryRow = (String, String, i64, Option<String>, Option<String>);
type DeliveryReadRow = (String, String, String, i64, Option<String>, Option<String>);

impl SessionStore {
    /// Create the W5-owned tables on the supplied connection.
    ///
    /// This function does not open a database. Use it for disposable tests or
    /// from an explicitly authorized Execution schema bootstrap. It must not
    /// be used to create a separate W5 database or bypass migration ownership.
    pub fn initialize_schema(connection: &Connection) -> Result<(), SessionStoreError> {
        connection.execute_batch(SESSION_SCHEMA)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let schema_version: i64 = connection.query_row(
            "SELECT schema_version FROM w5_session_schema_meta WHERE singleton=1",
            [],
            |row| row.get(0),
        )?;
        if schema_version != 1 {
            return Err(SessionStoreError::SchemaMissing);
        }
        Ok(())
    }

    /// Bind to an already-initialized, host-owned Execution connection.
    pub fn from_connection(connection: Connection) -> Result<Self, SessionStoreError> {
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let has_schema_meta: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='w5_session_schema_meta')",
            [],
            |row| row.get(0),
        )?;
        if !has_schema_meta {
            return Err(SessionStoreError::SchemaMissing);
        }
        let schema_version: Option<i64> = connection
            .query_row(
                "SELECT schema_version FROM w5_session_schema_meta WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let table_count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN (\
                'w5_sessions','w5_session_acls','w5_session_acl_operations',\
                'w5_session_messages','w5_session_delivery_receipts','w5_session_expiry_observations'\
             )",
            [],
            |row| row.get(0),
        )?;
        if schema_version != Some(1) || table_count != 6 {
            return Err(SessionStoreError::SchemaMissing);
        }
        Ok(Self { connection })
    }

    /// Register an immutable session identity and initial explicit ACL.
    ///
    /// An exact replay is a no-op. Reusing the session ID with a changed
    /// session binding or ACL is a conflict. No implicit owner permission is
    /// created; an empty grant list denies every subject.
    pub fn register_session(
        &mut self,
        session: &SessionRefV1,
        acl: &SessionAclV1,
    ) -> Result<SessionRegistration, SessionStoreError> {
        session.validate().map_err(SessionStoreError::Contract)?;
        acl.validate().map_err(SessionStoreError::Contract)?;
        if &acl.session != session {
            return Err(SessionStoreError::Contract(
                "initial ACL is not bound to the registered session".into(),
            ));
        }
        let session_json = serde_json::to_string(session)?;
        let acl_json = serde_json::to_string(acl)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(String, String)> = tx
            .query_row(
                "SELECT s.session_json, a.acl_json FROM w5_sessions s \
                 JOIN w5_session_acls a ON a.session_id=s.session_id WHERE s.session_id=?1",
                [&session.session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((stored_session, stored_acl)) = existing {
            if stored_session == session_json && stored_acl == acl_json {
                tx.commit()?;
                return Ok(SessionRegistration::IdempotentReplay);
            }
            return Err(SessionStoreError::Conflict);
        }
        tx.execute(
            "INSERT INTO w5_sessions(session_id, session_json) VALUES (?1, ?2)",
            params![session.session_id, session_json],
        )?;
        tx.execute(
            "INSERT INTO w5_session_acls(session_id, revision, acl_json) VALUES (?1, 1, ?2)",
            params![session.session_id, acl_json],
        )?;
        tx.commit()?;
        Ok(SessionRegistration::Created)
    }

    /// Read the current ACL snapshot after checking the host-authenticated
    /// subject's current `MANAGE_ACL` grant.
    pub fn read_acl(
        &self,
        session_id: &str,
        authenticated_subject_id: &str,
        now: &str,
    ) -> Result<SessionAclSnapshotV1, SessionStoreError> {
        validate_token("authenticated_subject_id", authenticated_subject_id)?;
        validate_timestamp(now)?;
        let snapshot = self.read_acl_record(session_id)?;
        if !snapshot
            .acl
            .allows(
                authenticated_subject_id,
                SessionPermissionV1::ManageAcl,
                now,
            )
            .map_err(SessionStoreError::Contract)?
        {
            return Err(SessionStoreError::Forbidden);
        }
        Ok(snapshot)
    }

    fn read_acl_record(&self, session_id: &str) -> Result<SessionAclSnapshotV1, SessionStoreError> {
        validate_token("session_id", session_id)?;
        let row: Option<(i64, String)> = self
            .connection
            .query_row(
                "SELECT revision, acl_json FROM w5_session_acls WHERE session_id=?1",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (revision, acl_json) = row.ok_or(SessionStoreError::NotFound)?;
        if revision < 1 {
            return Err(SessionStoreError::Integrity(
                "stored ACL revision is not positive".into(),
            ));
        }
        let session = self.read_session_record(session_id)?;
        let acl: SessionAclV1 = serde_json::from_str(&acl_json)?;
        acl.validate().map_err(SessionStoreError::Integrity)?;
        if acl.session != session {
            return Err(SessionStoreError::Integrity(
                "stored ACL is not bound to its immutable session".into(),
            ));
        }
        Ok(SessionAclSnapshotV1 {
            revision: revision as u64,
            acl,
        })
    }

    /// Read one immutable session identity after checking the subject's
    /// current, unexpired `READ` grant.
    pub fn read_session(
        &self,
        session_id: &str,
        authenticated_subject_id: &str,
        now: &str,
    ) -> Result<SessionRefV1, SessionStoreError> {
        validate_token("authenticated_subject_id", authenticated_subject_id)?;
        validate_timestamp(now)?;
        let session = self.read_session_record(session_id)?;
        let acl = self.read_acl_record(session_id)?;
        if !acl
            .acl
            .allows(authenticated_subject_id, SessionPermissionV1::Read, now)
            .map_err(SessionStoreError::Contract)?
        {
            return Err(SessionStoreError::Forbidden);
        }
        Ok(session)
    }

    fn read_session_record(&self, session_id: &str) -> Result<SessionRefV1, SessionStoreError> {
        validate_token("session_id", session_id)?;
        let session_json: Option<String> = self
            .connection
            .query_row(
                "SELECT session_json FROM w5_sessions WHERE session_id=?1",
                [session_id],
                |row| row.get(0),
            )
            .optional()?;
        let session: SessionRefV1 =
            serde_json::from_str(&session_json.ok_or(SessionStoreError::NotFound)?)?;
        session.validate().map_err(SessionStoreError::Integrity)?;
        if session.session_id != session_id {
            return Err(SessionStoreError::Integrity(
                "stored session JSON identity does not match its primary key".into(),
            ));
        }
        Ok(session)
    }

    /// Replace the complete ACL with an authenticated, revision-fenced operation.
    ///
    /// `authenticated_subject_id` must come from the host's authenticated
    /// principal, and the *current* ACL must grant that subject `MANAGE_ACL` at
    /// `now`. The requested replacement ACL cannot grant its own authority.
    /// `operation_id` remains stable across a retry. Removing a subject's grant
    /// is a complete revocation; no wildcard or implicit grant is synthesized.
    pub fn replace_acl(
        &mut self,
        session_id: &str,
        authenticated_subject_id: &str,
        now: &str,
        acl: &SessionAclV1,
        expected_revision: u64,
        operation_id: &str,
    ) -> Result<(u64, AclUpdateDisposition), SessionStoreError> {
        validate_token("operation_id", operation_id)?;
        validate_timestamp(now)?;
        validate_token("authenticated_subject_id", authenticated_subject_id)?;
        acl.validate().map_err(SessionStoreError::Contract)?;
        if acl.session.session_id != session_id {
            return Err(SessionStoreError::Contract(
                "replacement ACL targets a different session".into(),
            ));
        }
        let acl_json = serde_json::to_string(acl)?;
        let request_sha256 = sha256(acl_json.as_bytes());
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let prior_operation: Option<(String, i64)> = tx
            .query_row(
                "SELECT request_sha256, resulting_revision FROM w5_session_acl_operations \
                 WHERE session_id=?1 AND operation_id=?2",
                params![session_id, operation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((prior_digest, prior_revision)) = prior_operation {
            if prior_digest == request_sha256 {
                tx.commit()?;
                return Ok((
                    prior_revision as u64,
                    AclUpdateDisposition::IdempotentReplay,
                ));
            }
            return Err(SessionStoreError::Conflict);
        }
        let stored_session: Option<String> = tx
            .query_row(
                "SELECT session_json FROM w5_sessions WHERE session_id=?1",
                [session_id],
                |row| row.get(0),
            )
            .optional()?;
        let stored_session = stored_session.ok_or(SessionStoreError::NotFound)?;
        let session: SessionRefV1 = serde_json::from_str(&stored_session)?;
        session.validate().map_err(SessionStoreError::Integrity)?;
        if session.session_id != session_id {
            return Err(SessionStoreError::Integrity(
                "stored session JSON identity does not match its primary key".into(),
            ));
        }
        if acl.session != session {
            return Err(SessionStoreError::Contract(
                "replacement ACL changes the immutable session binding".into(),
            ));
        }
        let current_acl_json: String = tx.query_row(
            "SELECT acl_json FROM w5_session_acls WHERE session_id=?1",
            [session_id],
            |row| row.get(0),
        )?;
        let current_acl: SessionAclV1 = serde_json::from_str(&current_acl_json)?;
        current_acl
            .validate()
            .map_err(SessionStoreError::Integrity)?;
        if current_acl.session != session {
            return Err(SessionStoreError::Integrity(
                "stored ACL is not bound to its immutable session".into(),
            ));
        }
        if !current_acl
            .allows(
                authenticated_subject_id,
                SessionPermissionV1::ManageAcl,
                now,
            )
            .map_err(SessionStoreError::Contract)?
        {
            return Err(SessionStoreError::Forbidden);
        }
        let current_revision: i64 = tx.query_row(
            "SELECT revision FROM w5_session_acls WHERE session_id=?1",
            [session_id],
            |row| row.get(0),
        )?;
        if expected_revision != current_revision as u64 {
            return Err(SessionStoreError::RevisionConflict);
        }
        let next_revision = current_revision + 1;
        tx.execute(
            "UPDATE w5_session_acls SET revision=?2, acl_json=?3 WHERE session_id=?1 AND revision=?4",
            params![session_id, next_revision, acl_json, current_revision],
        )?;
        tx.execute(
            "INSERT INTO w5_session_acl_operations(session_id, operation_id, request_sha256, resulting_revision) \
             VALUES (?1, ?2, ?3, ?4)",
            params![session_id, operation_id, request_sha256, next_revision],
        )?;
        tx.commit()?;
        Ok((next_revision as u64, AclUpdateDisposition::Updated))
    }

    /// Enqueue one immutable message after checking explicit sender and
    /// recipient grants at `now`.
    ///
    /// The authenticated host subject is separate from `sender_service_id`;
    /// the latter is producer lineage, not proof of caller identity. Payload
    /// bytes must be verified by `ArtifactStore::read_ref` before enqueue.
    pub fn enqueue(
        &mut self,
        request: &SessionDeliveryRequestV1,
        authenticated_subject_id: &str,
        now: &str,
    ) -> Result<EnqueueDisposition, SessionStoreError> {
        request.validate().map_err(SessionStoreError::Contract)?;
        validate_timestamp(now)?;
        if now < request.created_at.as_str() {
            return Err(SessionStoreError::Contract(
                "enqueue observation predates the immutable request".into(),
            ));
        }
        let request_bytes = request
            .canonical_json_bytes()
            .map_err(SessionStoreError::Contract)?;
        let request_sha256 = sha256(&request_bytes);
        let request_json = String::from_utf8(request_bytes)
            .map_err(|error| SessionStoreError::Contract(error.to_string()))?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let stored_session: Option<String> = tx
            .query_row(
                "SELECT session_json FROM w5_sessions WHERE session_id=?1",
                [&request.session.session_id],
                |row| row.get(0),
            )
            .optional()?;
        let stored_session = stored_session.ok_or(SessionStoreError::NotFound)?;
        let session: SessionRefV1 = serde_json::from_str(&stored_session)?;
        if session != request.session {
            return Err(SessionStoreError::Conflict);
        }
        let acl_json: String = tx.query_row(
            "SELECT acl_json FROM w5_session_acls WHERE session_id=?1",
            [&request.session.session_id],
            |row| row.get(0),
        )?;
        let acl: SessionAclV1 = serde_json::from_str(&acl_json)?;
        if !acl
            .allows(authenticated_subject_id, SessionPermissionV1::Send, now)
            .map_err(SessionStoreError::Contract)?
            || !acl
                .allows(
                    &request.recipient_subject_id,
                    SessionPermissionV1::Read,
                    now,
                )
                .map_err(SessionStoreError::Contract)?
        {
            return Err(SessionStoreError::Forbidden);
        }
        let duplicate: Option<(String, String)> = tx
            .query_row(
                "SELECT message_id, request_sha256 FROM w5_session_messages \
                 WHERE session_id=?1 AND sender_service_id=?2 AND idempotency_key=?3",
                params![
                    request.session.session_id,
                    request.sender_service_id,
                    request.idempotency_key
                ],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((message_id, prior_digest)) = duplicate {
            if prior_digest == request_sha256 && message_id == request.message_id {
                tx.commit()?;
                return Ok(EnqueueDisposition::IdempotentReplay { message_id });
            }
            return Err(SessionStoreError::Conflict);
        }
        let message_exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM w5_session_messages WHERE message_id=?1)",
            [&request.message_id],
            |row| row.get(0),
        )?;
        if message_exists {
            return Err(SessionStoreError::Conflict);
        }
        tx.execute(
            "INSERT INTO w5_session_messages( \
                message_id, session_id, sender_subject_id, sender_service_id, idempotency_key, request_sha256, request_json, state \
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'PENDING')",
            params![
                request.message_id,
                request.session.session_id,
                authenticated_subject_id,
                request.sender_service_id,
                request.idempotency_key,
                request_sha256,
                request_json
            ],
        )?;
        tx.commit()?;
        Ok(EnqueueDisposition::Enqueued)
    }

    /// Persist the one-shot transport-start marker after checking the delivery
    /// worker's explicit ACK grant. No retry is issued by this adapter.
    pub fn begin_delivery(
        &mut self,
        message_id: &str,
        authenticated_delivery_subject_id: &str,
        delivery_service_id: &str,
        now: &str,
    ) -> Result<DeliveryStart, SessionStoreError> {
        validate_token("delivery_service_id", delivery_service_id)?;
        validate_timestamp(now)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(String, String, String, String)> = tx
            .query_row(
                "SELECT m.request_json, m.state, s.acl_json, m.sender_subject_id \
                 FROM w5_session_messages m JOIN w5_session_acls s ON s.session_id=m.session_id \
                 WHERE m.message_id=?1",
                [message_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let (request_json, state, acl_json, sender_subject_id) =
            row.ok_or(SessionStoreError::NotFound)?;
        let request: SessionDeliveryRequestV1 = serde_json::from_str(&request_json)?;
        let acl: SessionAclV1 = serde_json::from_str(&acl_json)?;
        if now < request.created_at.as_str() {
            return Err(SessionStoreError::Contract(
                "delivery start predates the immutable request".into(),
            ));
        }
        if !acl
            .allows(
                authenticated_delivery_subject_id,
                SessionPermissionV1::Acknowledge,
                now,
            )
            .map_err(SessionStoreError::Contract)?
            || !acl
                .allows(&sender_subject_id, SessionPermissionV1::Send, now)
                .map_err(SessionStoreError::Contract)?
            || !acl
                .allows(
                    &request.recipient_subject_id,
                    SessionPermissionV1::Read,
                    now,
                )
                .map_err(SessionStoreError::Contract)?
        {
            return Err(SessionStoreError::Forbidden);
        }
        if state != "PENDING" {
            return Err(SessionStoreError::InvalidState);
        }
        if now >= request.expires_at.as_str() || now >= request.session.expires_at.as_str() {
            tx.execute(
                "UPDATE w5_session_messages SET state='EXPIRED' WHERE message_id=?1 AND state='PENDING'",
                [message_id],
            )?;
            tx.commit()?;
            return Ok(DeliveryStart::Expired);
        }
        let updated = tx.execute(
            "UPDATE w5_session_messages SET state='IN_FLIGHT', delivery_attempt=1, \
             delivery_service_id=?2, started_at=?3 WHERE message_id=?1 AND state='PENDING'",
            params![message_id, delivery_service_id, now],
        )?;
        if updated != 1 {
            return Err(SessionStoreError::InvalidState);
        }
        tx.commit()?;
        Ok(DeliveryStart::Started {
            request: Box::new(request),
        })
    }

    /// Record the exact receipt for attempt 1. Acknowledged, rejected and
    /// uncertain outcomes are terminal here; a successor attempt requires a
    /// separately authorized proof-verification contract and is not exposed.
    pub fn record_receipt(
        &mut self,
        receipt: &SessionDeliveryReceiptV1,
    ) -> Result<ReceiptDisposition, SessionStoreError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<InFlightDeliveryRow> = tx
            .query_row(
                "SELECT request_json, state, delivery_attempt, delivery_service_id, started_at \
                 FROM w5_session_messages WHERE message_id=?1",
                [&receipt.message_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;
        let (request_json, state, attempt, delivery_service_id, started_at) =
            row.ok_or(SessionStoreError::NotFound)?;
        let request: SessionDeliveryRequestV1 = serde_json::from_str(&request_json)?;
        receipt
            .validate_for(&request)
            .map_err(SessionStoreError::Contract)?;
        if receipt.delivery_attempt != 1
            || attempt != 1
            || delivery_service_id.as_deref() != Some(receipt.delivery_service_id.as_str())
            || started_at
                .as_deref()
                .is_none_or(|started| receipt.recorded_at.as_str() < started)
        {
            return Err(SessionStoreError::Conflict);
        }
        let prior_receipt: Option<String> = tx
            .query_row(
                "SELECT receipt_json FROM w5_session_delivery_receipts \
                 WHERE message_id=?1 AND delivery_attempt=1",
                [&receipt.message_id],
                |row| row.get(0),
            )
            .optional()?;
        let receipt_json = serde_json::to_string(receipt)?;
        if let Some(prior_receipt) = prior_receipt {
            if prior_receipt == receipt_json {
                tx.commit()?;
                return Ok(ReceiptDisposition::IdempotentReplay);
            }
            return Err(SessionStoreError::Conflict);
        }
        if state != "IN_FLIGHT" {
            return Err(SessionStoreError::InvalidState);
        }
        let next_state = match &receipt.outcome {
            SessionDeliveryOutcomeV1::Acknowledged { .. } => "ACKNOWLEDGED",
            SessionDeliveryOutcomeV1::Rejected { .. } => "REJECTED",
            SessionDeliveryOutcomeV1::Uncertain { .. } => "UNCERTAIN",
        };
        tx.execute(
            "INSERT INTO w5_session_delivery_receipts(message_id, delivery_attempt, receipt_json) \
             VALUES (?1, 1, ?2)",
            params![receipt.message_id, receipt_json],
        )?;
        tx.execute(
            "UPDATE w5_session_messages SET state=?2 WHERE message_id=?1 AND state='IN_FLIGHT'",
            params![receipt.message_id, next_state],
        )?;
        tx.commit()?;
        Ok(ReceiptDisposition::Recorded)
    }

    /// Convert any delivery left `IN_FLIGHT` by a prior process into a durable
    /// `UNCERTAIN` receipt. Call only during a new host-process recovery pass.
    /// The operation is atomic and never replays transport.
    pub fn reconcile_interrupted_deliveries(
        &mut self,
        recovered_at: &str,
    ) -> Result<usize, SessionStoreError> {
        validate_timestamp(recovered_at)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut statement = tx.prepare(
            "SELECT message_id, request_json, request_sha256, delivery_service_id, started_at \
             FROM w5_session_messages WHERE state='IN_FLIGHT' ORDER BY message_id",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let mut reconciled = 0;
        for (message_id, request_json, request_sha256, delivery_service_id, started_at) in rows {
            let request: SessionDeliveryRequestV1 = serde_json::from_str(&request_json)?;
            let delivery_service_id = delivery_service_id.ok_or(SessionStoreError::InvalidState)?;
            if started_at
                .as_deref()
                .is_none_or(|started| recovered_at < started)
            {
                return Err(SessionStoreError::Contract(
                    "delivery recovery time predates the transport-start marker".into(),
                ));
            }
            let receipt = SessionDeliveryReceiptV1 {
                contract_version: crate::contracts::CONTRACT_VERSION_V1.into(),
                message_id: request.message_id.clone(),
                idempotency_key: request.idempotency_key.clone(),
                request_sha256,
                delivery_attempt: 1,
                delivery_service_id,
                outcome: SessionDeliveryOutcomeV1::Uncertain {
                    reason_code: "PROCESS_RESTART_DURING_DELIVERY".into(),
                },
                recorded_at: recovered_at.into(),
            };
            receipt
                .validate_for(&request)
                .map_err(SessionStoreError::Contract)?;
            tx.execute(
                "INSERT INTO w5_session_delivery_receipts(message_id, delivery_attempt, receipt_json) \
                 VALUES (?1, 1, ?2)",
                params![message_id, serde_json::to_string(&receipt)?],
            )?;
            tx.execute(
                "UPDATE w5_session_messages SET state='UNCERTAIN' \
                 WHERE message_id=?1 AND state='IN_FLIGHT'",
                [&message_id],
            )?;
            reconciled += 1;
        }
        tx.commit()?;
        Ok(reconciled)
    }

    /// Append an explicit ACTIVE/EXPIRED/UNKNOWN observation. Observations are
    /// not promoted to trust decisions or workflow completion facts.
    pub fn record_expiry_observation(
        &mut self,
        observation: &SessionExpiryObservationV1,
    ) -> Result<ExpiryObservationDisposition, SessionStoreError> {
        observation
            .validate()
            .map_err(SessionStoreError::Contract)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let session_json: Option<String> = tx
            .query_row(
                "SELECT session_json FROM w5_sessions WHERE session_id=?1",
                [&observation.session_id],
                |row| row.get(0),
            )
            .optional()?;
        let session_json = session_json.ok_or(SessionStoreError::NotFound)?;
        let session: SessionRefV1 = serde_json::from_str(&session_json)?;
        if session.expires_at != observation.expires_at {
            return Err(SessionStoreError::Conflict);
        }
        let observation_json = serde_json::to_string(observation)?;
        let prior: Option<String> = tx
            .query_row(
                "SELECT observation_json FROM w5_session_expiry_observations \
                 WHERE session_id=?1 AND observer_service_id=?2 AND observed_at=?3",
                params![
                    observation.session_id,
                    observation.observer_service_id,
                    observation.observed_at
                ],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(prior) = prior {
            if prior == observation_json {
                tx.commit()?;
                return Ok(ExpiryObservationDisposition::IdempotentReplay);
            }
            return Err(SessionStoreError::Conflict);
        }
        tx.execute(
            "INSERT INTO w5_session_expiry_observations( \
                session_id, observer_service_id, observed_at, observation_json \
             ) VALUES (?1, ?2, ?3, ?4)",
            params![
                observation.session_id,
                observation.observer_service_id,
                observation.observed_at,
                observation_json
            ],
        )?;
        tx.commit()?;
        Ok(ExpiryObservationDisposition::Recorded)
    }

    /// Read one delivery snapshot after checking the authenticated subject's
    /// current, unexpired `READ` grant on the owning session.
    pub fn read_delivery(
        &self,
        message_id: &str,
        authenticated_subject_id: &str,
        now: &str,
    ) -> Result<SessionDeliverySnapshotV1, SessionStoreError> {
        validate_token("authenticated_subject_id", authenticated_subject_id)?;
        validate_timestamp(now)?;
        let snapshot = self.read_delivery_record(message_id)?;
        let acl = self.read_acl_record(&snapshot.request.session.session_id)?;
        if !acl
            .acl
            .allows(authenticated_subject_id, SessionPermissionV1::Read, now)
            .map_err(SessionStoreError::Contract)?
        {
            return Err(SessionStoreError::Forbidden);
        }
        Ok(snapshot)
    }

    /// Validate one delivery snapshot and its exact receipt from persistence.
    fn read_delivery_record(
        &self,
        message_id: &str,
    ) -> Result<SessionDeliverySnapshotV1, SessionStoreError> {
        validate_token("message_id", message_id)?;
        let row: Option<DeliveryReadRow> = self
            .connection
            .query_row(
                "SELECT session_id, request_json, state, delivery_attempt, delivery_service_id, started_at \
                 FROM w5_session_messages WHERE message_id=?1",
                [message_id],
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
            .optional()?;
        let (session_id, request_json, state, delivery_attempt, delivery_service_id, started_at) =
            row.ok_or(SessionStoreError::NotFound)?;
        let receipt_json: Option<String> = self
            .connection
            .query_row(
                "SELECT receipt_json FROM w5_session_delivery_receipts \
                 WHERE message_id=?1 AND delivery_attempt=1",
                [message_id],
                |row| row.get(0),
            )
            .optional()?;
        let request: SessionDeliveryRequestV1 = serde_json::from_str(&request_json)?;
        request.validate().map_err(SessionStoreError::Integrity)?;
        if request.message_id != message_id || request.session.session_id != session_id {
            return Err(SessionStoreError::Integrity(
                "stored delivery request identity does not match its row".into(),
            ));
        }
        if delivery_attempt < 0 {
            return Err(SessionStoreError::Integrity(
                "stored delivery attempt is negative".into(),
            ));
        }
        let receipt: Option<SessionDeliveryReceiptV1> = receipt_json
            .map(|json| serde_json::from_str(&json))
            .transpose()?;
        if let Some(receipt) = &receipt {
            receipt
                .validate_for(&request)
                .map_err(SessionStoreError::Integrity)?;
            if receipt.delivery_attempt != delivery_attempt as u64
                || delivery_service_id.as_deref() != Some(receipt.delivery_service_id.as_str())
            {
                return Err(SessionStoreError::Integrity(
                    "stored delivery receipt does not match the attempt or transport".into(),
                ));
            }
        }
        if let Some(started_at) = started_at.as_deref() {
            validate_timestamp(started_at).map_err(|error| {
                SessionStoreError::Integrity(format!("invalid transport-start marker: {error}"))
            })?;
            if started_at < request.created_at.as_str()
                || started_at >= request.expires_at.as_str()
                || started_at >= request.session.expires_at.as_str()
            {
                return Err(SessionStoreError::Integrity(
                    "stored transport-start marker is outside the request lifetime".into(),
                ));
            }
            if receipt
                .as_ref()
                .is_some_and(|value| value.recorded_at.as_str() < started_at)
            {
                return Err(SessionStoreError::Integrity(
                    "stored delivery receipt predates its transport-start marker".into(),
                ));
            }
        }
        let consistent = match state.as_str() {
            "PENDING" | "EXPIRED" => {
                delivery_attempt == 0
                    && delivery_service_id.is_none()
                    && started_at.is_none()
                    && receipt.is_none()
            }
            "IN_FLIGHT" => {
                delivery_attempt == 1
                    && delivery_service_id.is_some()
                    && started_at.is_some()
                    && receipt.is_none()
            }
            "ACKNOWLEDGED" => {
                delivery_attempt == 1
                    && delivery_service_id.is_some()
                    && started_at.is_some()
                    && matches!(
                        receipt.as_ref().map(|value| &value.outcome),
                        Some(crate::contracts::SessionDeliveryOutcomeV1::Acknowledged { .. })
                    )
            }
            "REJECTED" => {
                delivery_attempt == 1
                    && delivery_service_id.is_some()
                    && started_at.is_some()
                    && matches!(
                        receipt.as_ref().map(|value| &value.outcome),
                        Some(crate::contracts::SessionDeliveryOutcomeV1::Rejected { .. })
                    )
            }
            "UNCERTAIN" => {
                delivery_attempt == 1
                    && delivery_service_id.is_some()
                    && started_at.is_some()
                    && matches!(
                        receipt.as_ref().map(|value| &value.outcome),
                        Some(crate::contracts::SessionDeliveryOutcomeV1::Uncertain { .. })
                    )
            }
            _ => false,
        };
        if !consistent {
            return Err(SessionStoreError::Integrity(
                "stored delivery state, attempt and receipt are inconsistent".into(),
            ));
        }
        Ok(SessionDeliverySnapshotV1 {
            request,
            state,
            delivery_attempt: delivery_attempt as u64,
            delivery_service_id,
            receipt,
        })
    }

    /// Read a bounded, deterministic page of session delivery facts.
    ///
    /// Results are ordered by immutable `message_id` bytes, not by creation
    /// time or an authoritative event sequence. The optional cursor is an
    /// exclusive lexicographic message ID; callers must not infer chronology.
    pub fn list_deliveries(
        &self,
        session_id: &str,
        authenticated_subject_id: &str,
        now: &str,
        after_message_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<SessionDeliverySnapshotV1>, SessionStoreError> {
        validate_token("session_id", session_id)?;
        validate_token("authenticated_subject_id", authenticated_subject_id)?;
        validate_timestamp(now)?;
        if let Some(cursor) = after_message_id {
            validate_token("after_message_id", cursor)?;
        }
        if !(1..=256).contains(&limit) {
            return Err(SessionStoreError::Contract(
                "delivery history limit must be between 1 and 256".into(),
            ));
        }
        self.read_session_record(session_id)?;
        let acl = self.read_acl_record(session_id)?;
        if !acl
            .acl
            .allows(authenticated_subject_id, SessionPermissionV1::Read, now)
            .map_err(SessionStoreError::Contract)?
        {
            return Err(SessionStoreError::Forbidden);
        }
        let mut statement = self.connection.prepare(
            "SELECT message_id FROM w5_session_messages \
             WHERE session_id=?1 AND (?2 IS NULL OR message_id > ?2) \
             ORDER BY message_id LIMIT ?3",
        )?;
        let rows = statement
            .query_map(params![session_id, after_message_id, limit as i64], |row| {
                row.get::<_, String>(0)
            })?;
        let message_ids = rows.collect::<Result<Vec<_>, _>>()?;
        message_ids
            .iter()
            .map(|message_id| self.read_delivery_record(message_id))
            .collect()
    }

    /// Read all expiry observations for a session in deterministic time order.
    pub fn read_expiry_observations(
        &self,
        session_id: &str,
        authenticated_subject_id: &str,
        now: &str,
    ) -> Result<Vec<SessionExpiryObservationV1>, SessionStoreError> {
        validate_token("session_id", session_id)?;
        validate_token("authenticated_subject_id", authenticated_subject_id)?;
        validate_timestamp(now)?;
        let session = self.read_session_record(session_id)?;
        let acl = self.read_acl_record(session_id)?;
        if !acl
            .acl
            .allows(authenticated_subject_id, SessionPermissionV1::Read, now)
            .map_err(SessionStoreError::Contract)?
        {
            return Err(SessionStoreError::Forbidden);
        }
        let mut statement = self.connection.prepare(
            "SELECT observation_json FROM w5_session_expiry_observations \
             WHERE session_id=?1 ORDER BY observed_at, observer_service_id",
        )?;
        let rows = statement.query_map([session_id], |row| row.get::<_, String>(0))?;
        rows.map(|row| {
            let observation: SessionExpiryObservationV1 = serde_json::from_str(&row?)?;
            observation
                .validate()
                .map_err(SessionStoreError::Integrity)?;
            if observation.session_id != session_id {
                return Err(SessionStoreError::Integrity(
                    "stored expiry observation does not match its session".into(),
                ));
            }
            if observation.expires_at != session.expires_at {
                return Err(SessionStoreError::Integrity(
                    "stored expiry observation changed the immutable session expiry".into(),
                ));
            }
            Ok(observation)
        })
        .collect()
    }
}

fn validate_token(field: &str, value: &str) -> Result<(), SessionStoreError> {
    if value.is_empty()
        || value.len() > 128
        || value.trim() != value
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:@/-".contains(&byte))
    {
        return Err(SessionStoreError::Contract(format!(
            "{field} is not a bounded canonical identifier"
        )));
    }
    Ok(())
}

fn validate_timestamp(value: &str) -> Result<(), SessionStoreError> {
    if value.len() != 20
        || value.as_bytes().get(4) != Some(&b'-')
        || value.as_bytes().get(7) != Some(&b'-')
        || value.as_bytes().get(10) != Some(&b'T')
        || value.as_bytes().get(13) != Some(&b':')
        || value.as_bytes().get(16) != Some(&b':')
        || value.as_bytes().get(19) != Some(&b'Z')
    {
        return Err(SessionStoreError::Contract(
            "timestamp must use canonical UTC-second format".into(),
        ));
    }
    if value
        .bytes()
        .enumerate()
        .any(|(index, byte)| ![4, 7, 10, 13, 16, 19].contains(&index) && !byte.is_ascii_digit())
    {
        return Err(SessionStoreError::Contract(
            "timestamp contains a non-digit component".into(),
        ));
    }
    Ok(())
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{ArtifactRefV1, SessionExpiryStateV1};
    use crate::{ArtifactStore, StoredArtifact};
    use tempfile::tempdir;

    const CREATED: &str = "2026-11-03T03:00:00Z";
    const EXPIRES: &str = "2026-11-03T04:00:00Z";

    fn session() -> SessionRefV1 {
        SessionRefV1 {
            contract_version: crate::contracts::CONTRACT_VERSION_V1.into(),
            session_id: "session-1".into(),
            workflow_id: "workflow-1".into(),
            task_id: "task-1".into(),
            attempt: 2,
            owner_service_id: "execution.worker-1".into(),
            created_at: CREATED.into(),
            expires_at: EXPIRES.into(),
        }
    }

    fn acl() -> SessionAclV1 {
        SessionAclV1 {
            session: session(),
            grants: vec![
                crate::contracts::SessionGrantV1 {
                    subject_id: "sender-subject".into(),
                    permissions: vec![SessionPermissionV1::Send],
                    expires_at: EXPIRES.into(),
                },
                crate::contracts::SessionGrantV1 {
                    subject_id: "recipient-subject".into(),
                    permissions: vec![SessionPermissionV1::Read],
                    expires_at: EXPIRES.into(),
                },
                crate::contracts::SessionGrantV1 {
                    subject_id: "delivery-subject".into(),
                    permissions: vec![SessionPermissionV1::Acknowledge],
                    expires_at: EXPIRES.into(),
                },
                crate::contracts::SessionGrantV1 {
                    subject_id: "acl-manager".into(),
                    permissions: vec![SessionPermissionV1::ManageAcl],
                    expires_at: EXPIRES.into(),
                },
            ],
        }
    }

    fn payload() -> (StoredArtifact, ArtifactRefV1) {
        let directory = tempdir().unwrap();
        let store = ArtifactStore::open_or_create(directory.path().join("objects")).unwrap();
        let bytes = br#"{"answer":"ok"}"#;
        let stored = store.put("application/json", bytes).unwrap();
        let reference = ArtifactRefV1 {
            contract_version: crate::contracts::CONTRACT_VERSION_V1.into(),
            artifact_id: stored.artifact_id.clone(),
            sha256: stored.sha256.clone(),
            byte_len: stored.byte_len,
            media_type: stored.media_type.clone(),
            content_schema_id: Some("runalith.result".into()),
            content_schema_version: Some("1.0".into()),
            source: crate::contracts::ArtifactSourceV1 {
                producer_id: "worker.exec-1".into(),
                workflow_id: "workflow-1".into(),
                task_id: "task-1".into(),
                attempt: 2,
                correlation_id: "correlation-1".into(),
                created_at: CREATED.into(),
            },
        };
        // The artifact is also read through its typed reference before it is
        // handed to the session queue in these tests.
        store.read_ref(&reference).unwrap();
        (stored, reference)
    }

    fn make_request(
        message_id: &str,
        idempotency_key: &str,
        payload: ArtifactRefV1,
    ) -> SessionDeliveryRequestV1 {
        SessionDeliveryRequestV1 {
            contract_version: crate::contracts::CONTRACT_VERSION_V1.into(),
            message_id: message_id.into(),
            idempotency_key: idempotency_key.into(),
            session: session(),
            sender_service_id: "worker.exec-1".into(),
            recipient_subject_id: "recipient-subject".into(),
            payload,
            created_at: "2026-11-03T03:10:00Z".into(),
            expires_at: "2026-11-03T03:50:00Z".into(),
        }
    }

    fn open_store(path: &std::path::Path) -> SessionStore {
        let connection = Connection::open(path).unwrap();
        SessionStore::initialize_schema(&connection).unwrap();
        SessionStore::from_connection(connection).unwrap()
    }

    fn register(store: &mut SessionStore) {
        assert_eq!(
            store.register_session(&session(), &acl()).unwrap(),
            SessionRegistration::Created
        );
    }

    #[test]
    fn session_registration_and_acl_replacement_are_idempotent_and_revision_fenced() {
        let directory = tempdir().unwrap();
        let mut store = open_store(&directory.path().join("execution.db"));
        register(&mut store);
        assert_eq!(
            store.register_session(&session(), &acl()).unwrap(),
            SessionRegistration::IdempotentReplay
        );

        let mut next_acl = acl();
        next_acl
            .grants
            .retain(|grant| grant.subject_id != "recipient-subject");
        assert!(matches!(
            store.replace_acl(
                "session-1",
                "ungranted-subject",
                "2026-11-03T03:20:00Z",
                &next_acl,
                1,
                "acl-op-denied"
            ),
            Err(SessionStoreError::Forbidden)
        ));
        assert_eq!(
            store
                .read_acl("session-1", "acl-manager", "2026-11-03T03:20:00Z")
                .unwrap()
                .revision,
            1
        );
        assert_eq!(
            store
                .replace_acl(
                    "session-1",
                    "acl-manager",
                    "2026-11-03T03:20:00Z",
                    &next_acl,
                    1,
                    "acl-op-1"
                )
                .unwrap(),
            (2, AclUpdateDisposition::Updated)
        );
        assert_eq!(
            store
                .replace_acl(
                    "session-1",
                    "acl-manager",
                    "2026-11-03T03:20:00Z",
                    &next_acl,
                    1,
                    "acl-op-1"
                )
                .unwrap(),
            (2, AclUpdateDisposition::IdempotentReplay)
        );
        assert!(matches!(
            store.replace_acl(
                "session-1",
                "acl-manager",
                "2026-11-03T03:20:00Z",
                &acl(),
                1,
                "acl-op-2"
            ),
            Err(SessionStoreError::RevisionConflict)
        ));
        assert_eq!(
            store
                .read_acl("session-1", "acl-manager", "2026-11-03T03:20:00Z")
                .unwrap()
                .revision,
            2
        );

        // A manager may explicitly revoke its own grant, but the replacement
        // ACL cannot be used to bootstrap authority for a later operation.
        let mut self_revoked_acl = next_acl;
        self_revoked_acl
            .grants
            .retain(|grant| grant.subject_id != "acl-manager");
        assert_eq!(
            store
                .replace_acl(
                    "session-1",
                    "acl-manager",
                    "2026-11-03T03:21:00Z",
                    &self_revoked_acl,
                    2,
                    "acl-op-self-revoke"
                )
                .unwrap(),
            (3, AclUpdateDisposition::Updated)
        );
        assert!(matches!(
            store.replace_acl(
                "session-1",
                "acl-manager",
                "2026-11-03T03:22:00Z",
                &acl(),
                3,
                "acl-op-after-revoke"
            ),
            Err(SessionStoreError::Forbidden)
        ));
        assert_eq!(store.read_acl_record("session-1").unwrap().revision, 3);
    }

    #[test]
    fn session_and_delivery_history_reads_validate_identity_and_use_bounded_stable_cursor() {
        let directory = tempdir().unwrap();
        let mut store = open_store(&directory.path().join("execution.db"));
        register(&mut store);
        assert_eq!(
            store
                .read_session("session-1", "recipient-subject", "2026-11-03T03:20:00Z")
                .unwrap(),
            session()
        );
        assert!(matches!(
            store.read_session("session-1", "sender-subject", "2026-11-03T03:20:00Z"),
            Err(SessionStoreError::Forbidden)
        ));
        assert!(matches!(
            store.read_acl("session-1", "recipient-subject", "2026-11-03T03:20:00Z"),
            Err(SessionStoreError::Forbidden)
        ));

        for id in ["message-a", "message-b", "message-c"] {
            let (_, artifact) = payload();
            let request = make_request(id, &format!("idem-{id}"), artifact);
            store
                .enqueue(&request, "sender-subject", "2026-11-03T03:11:00Z")
                .unwrap();
        }

        let first = store
            .list_deliveries(
                "session-1",
                "recipient-subject",
                "2026-11-03T03:20:00Z",
                None,
                2,
            )
            .unwrap();
        assert_eq!(
            first
                .iter()
                .map(|snapshot| snapshot.request.message_id.as_str())
                .collect::<Vec<_>>(),
            vec!["message-a", "message-b"]
        );
        let second = store
            .list_deliveries(
                "session-1",
                "recipient-subject",
                "2026-11-03T03:20:00Z",
                Some("message-b"),
                2,
            )
            .unwrap();
        assert_eq!(
            second
                .iter()
                .map(|snapshot| snapshot.request.message_id.as_str())
                .collect::<Vec<_>>(),
            vec!["message-c"]
        );
        assert!(matches!(
            store.list_deliveries(
                "session-1",
                "recipient-subject",
                "2026-11-03T03:20:00Z",
                None,
                0
            ),
            Err(SessionStoreError::Contract(_))
        ));
        assert!(matches!(
            store.list_deliveries(
                "missing-session",
                "recipient-subject",
                "2026-11-03T03:20:00Z",
                None,
                10
            ),
            Err(SessionStoreError::NotFound)
        ));
    }

    #[test]
    fn persisted_delivery_read_fails_closed_on_state_receipt_mismatch() {
        let directory = tempdir().unwrap();
        let mut store = open_store(&directory.path().join("execution.db"));
        register(&mut store);
        let (_, artifact) = payload();
        let request = make_request("message-corrupt", "idem-corrupt", artifact);
        store
            .enqueue(&request, "sender-subject", "2026-11-03T03:11:00Z")
            .unwrap();
        store
            .connection
            .execute(
                "UPDATE w5_session_messages SET state='ACKNOWLEDGED' WHERE message_id=?1",
                [&request.message_id],
            )
            .unwrap();
        assert!(matches!(
            store.read_delivery(
                &request.message_id,
                "recipient-subject",
                "2026-11-03T03:20:00Z"
            ),
            Err(SessionStoreError::Integrity(_))
        ));
    }

    #[test]
    fn enqueue_checks_sender_and_recipient_acl_and_rejects_changed_idempotency_body() {
        let directory = tempdir().unwrap();
        let mut store = open_store(&directory.path().join("execution.db"));
        register(&mut store);
        let (_, artifact) = payload();
        let request = make_request("message-1", "idem-1", artifact.clone());
        assert!(matches!(
            store.enqueue(&request, "ungranted-subject", "2026-11-03T03:11:00Z"),
            Err(SessionStoreError::Forbidden)
        ));
        assert_eq!(
            store
                .enqueue(&request, "sender-subject", "2026-11-03T03:11:00Z")
                .unwrap(),
            EnqueueDisposition::Enqueued
        );
        assert_eq!(
            store
                .enqueue(&request, "sender-subject", "2026-11-03T03:11:00Z")
                .unwrap(),
            EnqueueDisposition::IdempotentReplay {
                message_id: "message-1".into()
            }
        );
        let changed = make_request("message-2", "idem-1", artifact);
        assert!(matches!(
            store.enqueue(&changed, "sender-subject", "2026-11-03T03:11:00Z"),
            Err(SessionStoreError::Conflict)
        ));
        assert_eq!(
            store
                .read_delivery("message-1", "recipient-subject", "2026-11-03T03:20:00Z")
                .unwrap()
                .state,
            "PENDING"
        );
    }

    #[test]
    fn delivery_revalidates_current_sender_recipient_and_worker_grants() {
        let directory = tempdir().unwrap();
        let mut store = open_store(&directory.path().join("execution.db"));
        register(&mut store);
        let (_, artifact) = payload();
        let request = make_request("message-acl-revoked", "idem-acl-revoked", artifact);
        store
            .enqueue(&request, "sender-subject", "2026-11-03T03:11:00Z")
            .unwrap();

        let mut revoked = acl();
        revoked
            .grants
            .retain(|grant| grant.subject_id != "recipient-subject");
        store
            .replace_acl(
                "session-1",
                "acl-manager",
                "2026-11-03T03:11:00Z",
                &revoked,
                1,
                "revoke-recipient",
            )
            .unwrap();

        assert!(matches!(
            store.begin_delivery(
                "message-acl-revoked",
                "delivery-subject",
                "execution.delivery-1",
                "2026-11-03T03:12:00Z"
            ),
            Err(SessionStoreError::Forbidden)
        ));
        assert!(matches!(
            store.read_delivery(
                "message-acl-revoked",
                "recipient-subject",
                "2026-11-03T03:12:00Z"
            ),
            Err(SessionStoreError::Forbidden)
        ));
        assert_eq!(
            store
                .read_delivery_record("message-acl-revoked")
                .unwrap()
                .state,
            "PENDING"
        );
    }

    #[test]
    fn crash_reopen_reconciles_in_flight_to_uncertain_without_retry() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("execution.db");
        let (_, artifact) = payload();
        let request = make_request("message-restart", "idem-restart", artifact);
        {
            let mut store = open_store(&database);
            register(&mut store);
            store
                .enqueue(&request, "sender-subject", "2026-11-03T03:11:00Z")
                .unwrap();
            assert!(matches!(
                store
                    .begin_delivery(
                        "message-restart",
                        "delivery-subject",
                        "execution.delivery-1",
                        "2026-11-03T03:12:00Z"
                    )
                    .unwrap(),
                DeliveryStart::Started { .. }
            ));
        }
        let mut reopened = open_store(&database);
        assert_eq!(
            reopened
                .reconcile_interrupted_deliveries("2026-11-03T03:13:00Z")
                .unwrap(),
            1
        );
        assert_eq!(
            reopened
                .reconcile_interrupted_deliveries("2026-11-03T03:14:00Z")
                .unwrap(),
            0
        );
        let snapshot = reopened
            .read_delivery(
                "message-restart",
                "recipient-subject",
                "2026-11-03T03:20:00Z",
            )
            .unwrap();
        assert_eq!(snapshot.state, "UNCERTAIN");
        assert_eq!(snapshot.delivery_attempt, 1);
        assert!(matches!(
            snapshot.receipt.unwrap().outcome,
            SessionDeliveryOutcomeV1::Uncertain { .. }
        ));
        assert!(matches!(
            reopened.begin_delivery(
                "message-restart",
                "delivery-subject",
                "execution.delivery-1",
                "2026-11-03T03:15:00Z"
            ),
            Err(SessionStoreError::InvalidState)
        ));
    }

    #[test]
    fn exact_ack_receipt_is_idempotent_and_conflicting_receipt_is_rejected() {
        let directory = tempdir().unwrap();
        let mut store = open_store(&directory.path().join("execution.db"));
        register(&mut store);
        let (_, artifact) = payload();
        let request = make_request("message-ack", "idem-ack", artifact);
        store
            .enqueue(&request, "sender-subject", "2026-11-03T03:11:00Z")
            .unwrap();
        assert!(matches!(
            store
                .begin_delivery(
                    "message-ack",
                    "delivery-subject",
                    "execution.delivery-1",
                    "2026-11-03T03:12:00Z"
                )
                .unwrap(),
            DeliveryStart::Started { .. }
        ));
        let receipt = SessionDeliveryReceiptV1 {
            contract_version: crate::contracts::CONTRACT_VERSION_V1.into(),
            message_id: request.message_id.clone(),
            idempotency_key: request.idempotency_key.clone(),
            request_sha256: request.digest().unwrap(),
            delivery_attempt: 1,
            delivery_service_id: "execution.delivery-1".into(),
            outcome: SessionDeliveryOutcomeV1::Acknowledged {
                remote_receipt_id: "remote-ack-1".into(),
            },
            recorded_at: "2026-11-03T03:13:00Z".into(),
        };
        assert_eq!(
            store.record_receipt(&receipt).unwrap(),
            ReceiptDisposition::Recorded
        );
        assert_eq!(
            store.record_receipt(&receipt).unwrap(),
            ReceiptDisposition::IdempotentReplay
        );
        let mut conflict = receipt;
        conflict.outcome = SessionDeliveryOutcomeV1::Acknowledged {
            remote_receipt_id: "remote-ack-2".into(),
        };
        assert!(matches!(
            store.record_receipt(&conflict),
            Err(SessionStoreError::Conflict)
        ));
        assert_eq!(
            store
                .read_delivery("message-ack", "recipient-subject", "2026-11-03T03:20:00Z")
                .unwrap()
                .state,
            "ACKNOWLEDGED"
        );
    }

    #[test]
    fn expiry_observations_preserve_unknown_and_are_append_only() {
        let directory = tempdir().unwrap();
        let mut store = open_store(&directory.path().join("execution.db"));
        register(&mut store);
        let unknown = SessionExpiryObservationV1 {
            contract_version: crate::contracts::CONTRACT_VERSION_V1.into(),
            session_id: "session-1".into(),
            observer_service_id: "execution.worker-1".into(),
            expires_at: EXPIRES.into(),
            observed_at: "2026-11-03T03:20:00Z".into(),
            state: SessionExpiryStateV1::Unknown,
        };
        assert_eq!(
            store.record_expiry_observation(&unknown).unwrap(),
            ExpiryObservationDisposition::Recorded
        );
        assert_eq!(
            store.record_expiry_observation(&unknown).unwrap(),
            ExpiryObservationDisposition::IdempotentReplay
        );
        let expired = SessionExpiryObservationV1 {
            observed_at: "2026-11-03T04:01:00Z".into(),
            state: SessionExpiryStateV1::Expired,
            ..unknown
        };
        store.record_expiry_observation(&expired).unwrap();
        let observations = store
            .read_expiry_observations("session-1", "recipient-subject", "2026-11-03T03:30:00Z")
            .unwrap();
        assert_eq!(observations.len(), 2);
        assert_eq!(observations[0].state, SessionExpiryStateV1::Unknown);
        assert_eq!(observations[1].state, SessionExpiryStateV1::Expired);
    }

    #[test]
    fn host_connection_is_required_and_the_store_never_opens_a_private_database() {
        let connection = Connection::open_in_memory().unwrap();
        assert!(matches!(
            SessionStore::from_connection(connection),
            Err(SessionStoreError::SchemaMissing)
        ));
    }
}
