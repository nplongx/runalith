//! Provider dispatch intent and reconciliation persistence participant.
//!
//! This crate owns provider-specific records, validation, SQL, and schema
//! migrations. Every operation borrows the caller's SQLite connection or
//! transaction; this crate never opens a database or creates a second
//! connection. Workflow approval, lease fencing, and workflow event journaling
//! remain coordinated by `runalith-store` in the same transaction.

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Provider dispatch intent lifecycle. `Unknown` is never automatically replayable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ProviderDispatchState {
    /// Intent durably reserved before provider call.
    Reserved,
    /// Provider acknowledged durable run identity.
    Accepted,
    /// Provider authoritatively rejected request.
    Rejected,
    /// External outcome is ambiguous and quarantined.
    Unknown,
}

/// Fenced request to reserve one provider dispatch intent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderIntentRequest {
    /// Workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Exact active lease attempt.
    pub attempt: u64,
    /// Stable provider adapter ID.
    pub provider_id: String,
    /// Provider idempotency key.
    pub idempotency_key: String,
    /// Exact active lease identity.
    pub lease_id: String,
    /// Exact worker identity.
    pub worker_id: String,
    /// Exact approved immutable plan digest.
    pub plan_sha256: String,
    /// Digest of exact provider request payload.
    pub request_sha256: String,
    /// Exact non-secret provider payload. `None` is accepted only when decoding
    /// historical schema-v5 rows; new reservations require an object payload.
    #[serde(default)]
    pub payload: Option<serde_json::Value>,
}

/// Terminal provider dispatch outcome persisted against one intent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "SCREAMING_SNAKE_CASE",
    deny_unknown_fields
)]
pub enum ProviderIntentOutcome {
    /// Provider accepted and returned a durable run ID.
    Accepted {
        /// Durable provider run identifier.
        provider_run_id: String,
    },
    /// Provider rejected before creating work.
    Rejected {
        /// Stable provider rejection code.
        reason_code: String,
        /// Human-readable diagnostic.
        diagnostic: String,
    },
    /// Outcome may have occurred externally; replay is forbidden.
    Unknown {
        /// Reason exact outcome could not be established.
        diagnostic: String,
    },
}

/// Durable provider intent and its current state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderIntentRecord {
    /// Stable intent record ID.
    pub intent_id: String,
    /// Exact original request binding.
    pub request: ProviderIntentRequest,
    /// Persisted dispatch state.
    pub state: ProviderDispatchState,
    /// Provider run ID, only when accepted.
    pub provider_run_id: Option<String>,
    /// Exact terminal outcome payload.
    pub outcome: Option<ProviderIntentOutcome>,
    /// Creation timestamp.
    pub created_at: String,
    /// Last state transition timestamp.
    pub updated_at: String,
}

/// Result of idempotent intent reservation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderIntentReservation {
    /// Existing or newly reserved intent.
    pub record: ProviderIntentRecord,
    /// True only for the call that inserted the reservation.
    pub created: bool,
}

/// Append-only provider lookup observation. It is evidence for review, not automatic authorization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderReconciliationObservation {
    /// Stable observation ID.
    pub observation_id: String,
    /// Dispatch intent identity.
    pub intent_id: String,
    /// Provider adapter identity.
    pub provider_id: String,
    /// Exact idempotency key queried.
    pub idempotency_key: String,
    /// Provider run identity observed, if any.
    pub provider_run_id: Option<String>,
    /// Exact structured lookup response.
    pub response: serde_json::Value,
    /// Digest of exact response payload.
    pub response_sha256: String,
    /// Observation timestamp.
    pub observed_at: String,
}

/// Provider persistence failure, independent of workflow/store policy errors.
#[derive(Debug, Error)]
pub enum ProviderPersistenceError {
    /// SQLite operation failed.
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// Typed JSON failed to encode/decode.
    #[error("provider persistence JSON error: {0}")]
    Json(#[from] serde_json::Error),
    /// Provider data failed validation.
    #[error("provider persistence invariant rejected operation: {0}")]
    Invalid(String),
    /// An idempotency key or attempt is bound to another request.
    #[error("provider dispatch idempotency binding conflicts with an existing intent")]
    Conflict,
    /// A terminal outcome cannot be replaced.
    #[error("provider dispatch intent already has a different terminal outcome")]
    Finalized,
    /// Provider row was absent.
    #[error("provider persistence record not found: {0}")]
    NotFound(String),
}

/// Provider ledger SQL participant. Stateless; all methods use supplied handles.
pub struct ProviderLedger;

type IntentRow = (
    String,
    String,
    String,
    i64,
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
);

impl ProviderLedger {
    /// Validate provider-owned tables required by an existing schema-v4/v5 file.
    pub fn validate_legacy_schema(
        connection: &Connection,
        version: i64,
    ) -> Result<(), ProviderPersistenceError> {
        let required: &[&str] = match version {
            4 => &["provider_dispatch_intents"],
            5 => &[
                "provider_dispatch_intents",
                "provider_reconciliation_observations",
            ],
            _ => return Ok(()),
        };
        for table in required {
            let exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                params![table],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(ProviderPersistenceError::Invalid(format!(
                    "not a recognized Rust schema-v{version} database: missing {table}"
                )));
            }
        }
        Ok(())
    }

    /// Apply the schema-v3 provider intent migration and advance user_version to 4.
    pub fn migrate_v3_to_v4(connection: &Connection) -> Result<(), ProviderPersistenceError> {
        if let Err(error) = connection.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE provider_dispatch_intents(
               intent_id TEXT PRIMARY KEY,
               workflow_id TEXT NOT NULL,
               task_id TEXT NOT NULL,
               attempt INTEGER NOT NULL CHECK(attempt>0),
               provider_id TEXT NOT NULL,
               idempotency_key TEXT NOT NULL,
               lease_id TEXT NOT NULL,
               worker_id TEXT NOT NULL,
               plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256)=64),
               request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
               state TEXT NOT NULL CHECK(state IN ('RESERVED','ACCEPTED','REJECTED','UNKNOWN')),
               provider_run_id TEXT,
               outcome_json TEXT,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               UNIQUE(provider_id,idempotency_key),
               UNIQUE(workflow_id,task_id,attempt),
               FOREIGN KEY(workflow_id,task_id) REFERENCES tasks(workflow_id,task_id),
               CHECK((state='RESERVED' AND provider_run_id IS NULL AND outcome_json IS NULL) OR
                     (state='ACCEPTED' AND provider_run_id IS NOT NULL AND outcome_json IS NOT NULL) OR
                     (state IN ('REJECTED','UNKNOWN') AND provider_run_id IS NULL AND outcome_json IS NOT NULL))
             );
             CREATE INDEX provider_intents_workflow_task ON provider_dispatch_intents(workflow_id,task_id,attempt);
             CREATE TRIGGER provider_intent_identity_immutable
             BEFORE UPDATE OF intent_id,workflow_id,task_id,attempt,provider_id,idempotency_key,lease_id,worker_id,plan_sha256,request_sha256,created_at
             ON provider_dispatch_intents
             BEGIN SELECT RAISE(ABORT,'provider dispatch intent identity is immutable'); END;
             CREATE TRIGGER provider_intent_state_transition_guard
             BEFORE UPDATE OF state,provider_run_id,outcome_json,updated_at ON provider_dispatch_intents
             WHEN NOT (OLD.state='RESERVED' AND NEW.state IN ('ACCEPTED','REJECTED','UNKNOWN')
               AND OLD.provider_run_id IS NULL AND OLD.outcome_json IS NULL AND NEW.outcome_json IS NOT NULL
               AND ((NEW.state='ACCEPTED' AND NEW.provider_run_id IS NOT NULL) OR
                    (NEW.state IN ('REJECTED','UNKNOWN') AND NEW.provider_run_id IS NULL)))
             BEGIN SELECT RAISE(ABORT,'provider dispatch intent can only be finalized once'); END;
             CREATE TRIGGER provider_intent_append_only_delete
             BEFORE DELETE ON provider_dispatch_intents
             BEGIN SELECT RAISE(ABORT,'provider dispatch intents are append-only'); END;
             PRAGMA user_version=4;
             COMMIT;"
        ) {
            let _ = connection.execute_batch("ROLLBACK;");
            return Err(error.into());
        }
        Ok(())
    }

    /// Apply schema-v4 reconciliation observations and advance user_version to 5.
    pub fn migrate_v4_to_v5(connection: &Connection) -> Result<(), ProviderPersistenceError> {
        if let Err(error) = connection.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE provider_reconciliation_observations(
               observation_id TEXT PRIMARY KEY,
               intent_id TEXT NOT NULL REFERENCES provider_dispatch_intents(intent_id),
               provider_id TEXT NOT NULL,
               idempotency_key TEXT NOT NULL,
               provider_run_id TEXT,
               response_json TEXT NOT NULL,
               response_sha256 TEXT NOT NULL CHECK(length(response_sha256)=64),
               observed_at TEXT NOT NULL,
               UNIQUE(intent_id,response_sha256)
             );
             CREATE INDEX provider_reconciliation_intent ON provider_reconciliation_observations(intent_id,observed_at);
             CREATE TRIGGER provider_reconciliation_append_only_update
             BEFORE UPDATE ON provider_reconciliation_observations
             BEGIN SELECT RAISE(ABORT,'provider reconciliation observations are append-only'); END;
             CREATE TRIGGER provider_reconciliation_append_only_delete
             BEFORE DELETE ON provider_reconciliation_observations
             BEGIN SELECT RAISE(ABORT,'provider reconciliation observations are append-only'); END;
             PRAGMA user_version=5;
             COMMIT;"
        ) {
            let _ = connection.execute_batch("ROLLBACK;");
            return Err(error.into());
        }
        Ok(())
    }

    /// Apply schema-v5 immutable payload binding and advance user_version to 6.
    pub fn migrate_v5_to_v6(connection: &Connection) -> Result<(), ProviderPersistenceError> {
        if let Err(error) = connection.execute_batch(
            "BEGIN IMMEDIATE;
             ALTER TABLE provider_dispatch_intents
               ADD COLUMN payload_json TEXT CHECK(payload_json IS NULL OR json_valid(payload_json));
             DROP TRIGGER provider_intent_identity_immutable;
             CREATE TRIGGER provider_intent_identity_immutable
             BEFORE UPDATE OF intent_id,workflow_id,task_id,attempt,provider_id,idempotency_key,lease_id,worker_id,plan_sha256,request_sha256,payload_json,created_at
             ON provider_dispatch_intents
             BEGIN SELECT RAISE(ABORT,'provider dispatch intent identity is immutable'); END;
             CREATE TRIGGER provider_intent_payload_required
             BEFORE INSERT ON provider_dispatch_intents
             WHEN NEW.payload_json IS NULL
             BEGIN SELECT RAISE(ABORT,'provider dispatch intent payload is required'); END;
             PRAGMA user_version=6;
             COMMIT;"
        ) {
            let _ = connection.execute_batch("ROLLBACK;");
            return Err(error.into());
        }
        Ok(())
    }

    /// Validate exact provider identity, payload bounds, and SHA-256 binding.
    pub fn validate_request(
        request: &ProviderIntentRequest,
    ) -> Result<(), ProviderPersistenceError> {
        for (field, value, max) in [
            ("workflow_id", request.workflow_id.as_str(), 128),
            ("task_id", request.task_id.as_str(), 128),
            ("provider_id", request.provider_id.as_str(), 128),
            ("idempotency_key", request.idempotency_key.as_str(), 256),
            ("lease_id", request.lease_id.as_str(), 128),
            ("worker_id", request.worker_id.as_str(), 128),
        ] {
            if value.trim().is_empty() || value.len() > max {
                return Err(ProviderPersistenceError::Invalid(format!(
                    "provider intent {field} is invalid"
                )));
            }
        }
        if !valid_provider_id(&request.provider_id)
            || request.attempt == 0
            || request.attempt > i64::MAX as u64
            || !valid_sha256(&request.plan_sha256)
            || !valid_sha256(&request.request_sha256)
        {
            return Err(ProviderPersistenceError::Invalid(
                "provider intent identity, attempt, or digest is invalid".into(),
            ));
        }
        let payload = request.payload.as_ref().ok_or_else(|| {
            ProviderPersistenceError::Invalid(
                "provider intent must persist its exact non-secret payload".into(),
            )
        })?;
        if !payload.is_object() {
            return Err(ProviderPersistenceError::Invalid(
                "provider intent payload must be a JSON object".into(),
            ));
        }
        if serde_json::to_vec(payload)?.len() > 1_048_576
            || sha256_json(payload)? != request.request_sha256
        {
            return Err(ProviderPersistenceError::Invalid(
                "provider intent payload size or digest is invalid".into(),
            ));
        }
        Ok(())
    }

    /// Validate terminal provider outcome fields and bounds.
    pub fn validate_outcome(
        outcome: &ProviderIntentOutcome,
    ) -> Result<(), ProviderPersistenceError> {
        let valid = match outcome {
            ProviderIntentOutcome::Accepted { provider_run_id } => {
                !provider_run_id.trim().is_empty() && provider_run_id.len() <= 512
            }
            ProviderIntentOutcome::Rejected {
                reason_code,
                diagnostic,
            } => {
                !reason_code.trim().is_empty()
                    && reason_code.len() <= 128
                    && !diagnostic.trim().is_empty()
                    && diagnostic.len() <= 4096
            }
            ProviderIntentOutcome::Unknown { diagnostic } => {
                !diagnostic.trim().is_empty() && diagnostic.len() <= 4096
            }
        };
        if !valid {
            return Err(ProviderPersistenceError::Invalid(
                "provider dispatch outcome is malformed".into(),
            ));
        }
        Ok(())
    }

    /// Look up by stable intent ID using the caller's connection/transaction.
    pub fn load_by_id(
        connection: &Connection,
        intent_id: &str,
    ) -> Result<Option<ProviderIntentRecord>, ProviderPersistenceError> {
        let row = connection
            .query_row(INTENT_SELECT_BY_ID, params![intent_id], read_intent_row)
            .optional()?;
        row.map(decode_intent_row).transpose()
    }

    /// Look up by provider/idempotency key using the caller's connection/transaction.
    pub fn load_by_key(
        connection: &Connection,
        provider_id: &str,
        idempotency_key: &str,
    ) -> Result<Option<ProviderIntentRecord>, ProviderPersistenceError> {
        let row = connection
            .query_row(
                INTENT_SELECT_BY_KEY,
                params![provider_id, idempotency_key],
                read_intent_row,
            )
            .optional()?;
        row.map(decode_intent_row).transpose()
    }

    /// Look up by workflow/task/attempt using the caller's connection/transaction.
    pub fn load_by_attempt(
        connection: &Connection,
        workflow_id: &str,
        task_id: &str,
        attempt: u64,
    ) -> Result<Option<ProviderIntentRecord>, ProviderPersistenceError> {
        let row = connection
            .query_row(
                INTENT_SELECT_BY_ATTEMPT,
                params![workflow_id, task_id, attempt as i64],
                read_intent_row,
            )
            .optional()?;
        row.map(decode_intent_row).transpose()
    }

    /// Check idempotency bindings before Store performs workflow approval/lease validation.
    pub fn existing_reservation(
        connection: &Connection,
        request: &ProviderIntentRequest,
    ) -> Result<Option<ProviderIntentReservation>, ProviderPersistenceError> {
        let by_key = Self::load_by_key(connection, &request.provider_id, &request.idempotency_key)?;
        let by_attempt = Self::load_by_attempt(
            connection,
            &request.workflow_id,
            &request.task_id,
            request.attempt,
        )?;
        if let (Some(left), Some(right)) = (&by_key, &by_attempt) {
            if left.intent_id != right.intent_id {
                return Err(ProviderPersistenceError::Conflict);
            }
        }
        if let Some(record) = by_key.or(by_attempt) {
            if record.request != *request {
                return Err(ProviderPersistenceError::Conflict);
            }
            return Ok(Some(ProviderIntentReservation {
                record,
                created: false,
            }));
        }
        Ok(None)
    }

    /// Insert a new reservation into the caller's active transaction.
    pub fn insert_reserved(
        transaction: &Transaction<'_>,
        request: &ProviderIntentRequest,
        timestamp: &str,
    ) -> Result<ProviderIntentRecord, ProviderPersistenceError> {
        Self::validate_request(request)?;
        let payload = request.payload.as_ref().ok_or_else(|| {
            ProviderPersistenceError::Invalid(
                "provider intent must persist its exact non-secret payload".into(),
            )
        })?;
        let payload_json = serde_json::to_string(payload)?;
        let record = ProviderIntentRecord {
            intent_id: format!("pdi_{}", uuid::Uuid::new_v4().simple()),
            request: request.clone(),
            state: ProviderDispatchState::Reserved,
            provider_run_id: None,
            outcome: None,
            created_at: timestamp.into(),
            updated_at: timestamp.into(),
        };
        transaction.execute(
            "INSERT INTO provider_dispatch_intents(intent_id,workflow_id,task_id,attempt,provider_id,idempotency_key,lease_id,worker_id,plan_sha256,request_sha256,payload_json,state,provider_run_id,outcome_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'RESERVED',NULL,NULL,?12,?12)",
            params![record.intent_id,request.workflow_id,request.task_id,request.attempt as i64,request.provider_id,request.idempotency_key,request.lease_id,request.worker_id,request.plan_sha256,request.request_sha256,payload_json,timestamp],
        ).map_err(map_insert_error)?;
        Ok(record)
    }

    /// Finalize one reservation with a compare-and-set; identical replay is idempotent.
    pub fn finalize(
        transaction: &Transaction<'_>,
        intent_id: &str,
        outcome: &ProviderIntentOutcome,
        timestamp: &str,
    ) -> Result<(ProviderIntentRecord, bool), ProviderPersistenceError> {
        Self::validate_outcome(outcome)?;
        let current = Self::load_by_id(transaction, intent_id)?.ok_or_else(|| {
            ProviderPersistenceError::NotFound(format!("provider intent {intent_id}"))
        })?;
        if current.state != ProviderDispatchState::Reserved {
            if current.outcome.as_ref() == Some(outcome) {
                return Ok((current, false));
            }
            return Err(ProviderPersistenceError::Finalized);
        }
        let (state, run_id) = match outcome {
            ProviderIntentOutcome::Accepted { provider_run_id } => (
                ProviderDispatchState::Accepted,
                Some(provider_run_id.as_str()),
            ),
            ProviderIntentOutcome::Rejected { .. } => (ProviderDispatchState::Rejected, None),
            ProviderIntentOutcome::Unknown { .. } => (ProviderDispatchState::Unknown, None),
        };
        let changed = transaction.execute(
            "UPDATE provider_dispatch_intents SET state=?1,provider_run_id=?2,outcome_json=?3,updated_at=?4 WHERE intent_id=?5 AND state='RESERVED' AND outcome_json IS NULL",
            params![state_db(state),run_id,serde_json::to_string(outcome)?,timestamp,intent_id],
        )?;
        if changed != 1 {
            return Err(ProviderPersistenceError::Finalized);
        }
        let record = Self::load_by_id(transaction, intent_id)?.ok_or_else(|| {
            ProviderPersistenceError::NotFound(format!("provider intent {intent_id}"))
        })?;
        Ok((record, true))
    }

    /// Read every intent for a workflow in stable creation order.
    pub fn list_by_workflow(
        connection: &Connection,
        workflow_id: &str,
    ) -> Result<Vec<ProviderIntentRecord>, ProviderPersistenceError> {
        let mut statement = connection.prepare("SELECT intent_id FROM provider_dispatch_intents WHERE workflow_id=?1 ORDER BY created_at,intent_id")?;
        let ids = statement
            .query_map(params![workflow_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.iter()
            .map(|id| {
                Self::load_by_id(connection, id)?.ok_or_else(|| {
                    ProviderPersistenceError::NotFound(format!("provider intent {id}"))
                })
            })
            .collect()
    }

    /// Insert or return an identical append-only lookup observation in caller transaction.
    pub fn record_observation(
        transaction: &Transaction<'_>,
        intent_id: &str,
        response: &serde_json::Value,
        provider_run_id: Option<&str>,
        timestamp: &str,
    ) -> Result<(ProviderReconciliationObservation, bool), ProviderPersistenceError> {
        let intent = Self::load_by_id(transaction, intent_id)?.ok_or_else(|| {
            ProviderPersistenceError::NotFound(format!("provider intent {intent_id}"))
        })?;
        let bytes = serde_json::to_vec(response)?;
        if !response.is_object()
            || bytes.len() > 65_536
            || provider_run_id.is_some_and(|value| value.trim().is_empty() || value.len() > 512)
        {
            return Err(ProviderPersistenceError::Invalid(
                "provider reconciliation response exceeds bounds".into(),
            ));
        }
        let digest = sha256_json(response)?;
        let existing: Option<String> = transaction.query_row(
            "SELECT observation_id FROM provider_reconciliation_observations WHERE intent_id=?1 AND response_sha256=?2",
            params![intent.intent_id,digest], |row| row.get(0),
        ).optional()?;
        if let Some(id) = existing {
            let observation = Self::load_observation_by_id(transaction, &id)?.ok_or_else(|| {
                ProviderPersistenceError::NotFound(format!("provider observation {id}"))
            })?;
            if observation.response != *response
                || observation.provider_run_id.as_deref() != provider_run_id
            {
                return Err(ProviderPersistenceError::Conflict);
            }
            return Ok((observation, false));
        }
        let observation = ProviderReconciliationObservation {
            observation_id: format!("pro_{}", uuid::Uuid::new_v4().simple()),
            intent_id: intent.intent_id.clone(),
            provider_id: intent.request.provider_id.clone(),
            idempotency_key: intent.request.idempotency_key.clone(),
            provider_run_id: provider_run_id.map(str::to_owned),
            response: response.clone(),
            response_sha256: digest,
            observed_at: timestamp.into(),
        };
        transaction.execute(
            "INSERT INTO provider_reconciliation_observations(observation_id,intent_id,provider_id,idempotency_key,provider_run_id,response_json,response_sha256,observed_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![observation.observation_id,observation.intent_id,observation.provider_id,observation.idempotency_key,observation.provider_run_id,serde_json::to_string(response)?,observation.response_sha256,observation.observed_at],
        ).map_err(map_insert_error)?;
        Ok((observation, true))
    }

    /// Read and digest-verify one observation.
    pub fn load_observation_by_id(
        connection: &Connection,
        observation_id: &str,
    ) -> Result<Option<ProviderReconciliationObservation>, ProviderPersistenceError> {
        let row = connection.query_row(
            "SELECT observation_id,intent_id,provider_id,idempotency_key,provider_run_id,response_json,response_sha256,observed_at FROM provider_reconciliation_observations WHERE observation_id=?1",
            params![observation_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,Option<String>>(4)?,row.get::<_,String>(5)?,row.get::<_,String>(6)?,row.get::<_,String>(7)?)),
        ).optional()?;
        row.map(
            |(
                observation_id,
                intent_id,
                provider_id,
                idempotency_key,
                provider_run_id,
                response_json,
                response_sha256,
                observed_at,
            )| {
                let response: serde_json::Value = serde_json::from_str(&response_json)?;
                if sha256_json(&response)? != response_sha256 {
                    return Err(ProviderPersistenceError::Invalid(format!(
                        "provider observation digest mismatch: {observation_id}"
                    )));
                }
                let intent = Self::load_by_id(connection, &intent_id)?.ok_or_else(|| {
                    ProviderPersistenceError::NotFound(format!("provider intent {intent_id}"))
                })?;
                if intent.request.provider_id != provider_id
                    || intent.request.idempotency_key != idempotency_key
                {
                    return Err(ProviderPersistenceError::Invalid(format!(
                        "provider observation identity mismatch: {observation_id}"
                    )));
                }
                Ok(ProviderReconciliationObservation {
                    observation_id,
                    intent_id,
                    provider_id,
                    idempotency_key,
                    provider_run_id,
                    response,
                    response_sha256,
                    observed_at,
                })
            },
        )
        .transpose()
    }

    /// List immutable lookup observations in stable observation order.
    pub fn list_observations(
        connection: &Connection,
        intent_id: &str,
    ) -> Result<Vec<ProviderReconciliationObservation>, ProviderPersistenceError> {
        let mut statement = connection.prepare("SELECT observation_id FROM provider_reconciliation_observations WHERE intent_id=?1 ORDER BY observed_at,observation_id")?;
        let ids = statement
            .query_map(params![intent_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.iter()
            .map(|id| {
                Self::load_observation_by_id(connection, id)?.ok_or_else(|| {
                    ProviderPersistenceError::NotFound(format!("provider observation {id}"))
                })
            })
            .collect()
    }
}

const INTENT_SELECT_BY_ID: &str = "SELECT intent_id,workflow_id,task_id,attempt,provider_id,idempotency_key,lease_id,worker_id,plan_sha256,request_sha256,payload_json,state,provider_run_id,outcome_json,created_at,updated_at FROM provider_dispatch_intents WHERE intent_id=?1";
const INTENT_SELECT_BY_KEY: &str = "SELECT intent_id,workflow_id,task_id,attempt,provider_id,idempotency_key,lease_id,worker_id,plan_sha256,request_sha256,payload_json,state,provider_run_id,outcome_json,created_at,updated_at FROM provider_dispatch_intents WHERE provider_id=?1 AND idempotency_key=?2";
const INTENT_SELECT_BY_ATTEMPT: &str = "SELECT intent_id,workflow_id,task_id,attempt,provider_id,idempotency_key,lease_id,worker_id,plan_sha256,request_sha256,payload_json,state,provider_run_id,outcome_json,created_at,updated_at FROM provider_dispatch_intents WHERE workflow_id=?1 AND task_id=?2 AND attempt=?3";

fn read_intent_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<IntentRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
        row.get(10)?,
        row.get(11)?,
        row.get(12)?,
        row.get(13)?,
        row.get(14)?,
        row.get(15)?,
    ))
}

fn decode_intent_row(row: IntentRow) -> Result<ProviderIntentRecord, ProviderPersistenceError> {
    let (
        intent_id,
        workflow_id,
        task_id,
        attempt,
        provider_id,
        idempotency_key,
        lease_id,
        worker_id,
        plan_sha256,
        request_sha256,
        payload_json,
        state,
        provider_run_id,
        outcome_json,
        created_at,
        updated_at,
    ) = row;
    if attempt <= 0 {
        return Err(ProviderPersistenceError::Invalid(
            "provider intent has invalid attempt".into(),
        ));
    }
    let outcome: Option<ProviderIntentOutcome> = outcome_json
        .map(|json| serde_json::from_str(&json))
        .transpose()?;
    let payload: Option<serde_json::Value> = payload_json
        .map(|json| serde_json::from_str(&json))
        .transpose()?;
    if !valid_provider_id(&provider_id)
        || !valid_sha256(&plan_sha256)
        || !valid_sha256(&request_sha256)
    {
        return Err(ProviderPersistenceError::Invalid(format!(
            "provider intent identity/digest is malformed: {intent_id}"
        )));
    }
    if let Some(payload) = &payload {
        if !payload.is_object() || sha256_json(payload)? != request_sha256 {
            return Err(ProviderPersistenceError::Invalid(format!(
                "provider intent payload digest mismatch: {intent_id}"
            )));
        }
    }
    let state = parse_state(&state)?;
    if let Some(value) = &outcome {
        ProviderLedger::validate_outcome(value)?;
    }
    let outcome_matches = match (state, provider_run_id.as_ref(), outcome.as_ref()) {
        (ProviderDispatchState::Reserved, None, None) => true,
        (
            ProviderDispatchState::Accepted,
            Some(run_id),
            Some(ProviderIntentOutcome::Accepted {
                provider_run_id: outcome_run_id,
            }),
        ) => run_id == outcome_run_id,
        (ProviderDispatchState::Rejected, None, Some(ProviderIntentOutcome::Rejected { .. })) => {
            true
        }
        (ProviderDispatchState::Unknown, None, Some(ProviderIntentOutcome::Unknown { .. })) => true,
        _ => false,
    };
    if !outcome_matches {
        return Err(ProviderPersistenceError::Invalid(format!(
            "provider intent state/payload mismatch: {intent_id}"
        )));
    }
    Ok(ProviderIntentRecord {
        intent_id,
        request: ProviderIntentRequest {
            workflow_id,
            task_id,
            attempt: attempt as u64,
            provider_id,
            idempotency_key,
            lease_id,
            worker_id,
            plan_sha256,
            request_sha256,
            payload,
        },
        state,
        provider_run_id,
        outcome,
        created_at,
        updated_at,
    })
}

fn parse_state(value: &str) -> Result<ProviderDispatchState, ProviderPersistenceError> {
    match value {
        "RESERVED" => Ok(ProviderDispatchState::Reserved),
        "ACCEPTED" => Ok(ProviderDispatchState::Accepted),
        "REJECTED" => Ok(ProviderDispatchState::Rejected),
        "UNKNOWN" => Ok(ProviderDispatchState::Unknown),
        _ => Err(ProviderPersistenceError::Invalid(format!(
            "unknown provider intent state {value}"
        ))),
    }
}

fn state_db(value: ProviderDispatchState) -> &'static str {
    match value {
        ProviderDispatchState::Reserved => "RESERVED",
        ProviderDispatchState::Accepted => "ACCEPTED",
        ProviderDispatchState::Rejected => "REJECTED",
        ProviderDispatchState::Unknown => "UNKNOWN",
    }
}

fn valid_provider_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'_'
        })
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_json(value: &serde_json::Value) -> Result<String, ProviderPersistenceError> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(value)?)))
}

fn map_insert_error(error: rusqlite::Error) -> ProviderPersistenceError {
    match &error {
        rusqlite::Error::SqliteFailure(code, _)
            if code.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            ProviderPersistenceError::Conflict
        }
        _ => ProviderPersistenceError::Sqlite(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::TransactionBehavior;

    fn schema() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        install_schema(&connection);
        connection
    }

    fn install_schema(connection: &Connection) {
        connection.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE workflows(workflow_id TEXT PRIMARY KEY); CREATE TABLE tasks(workflow_id TEXT NOT NULL,task_id TEXT NOT NULL,PRIMARY KEY(workflow_id,task_id),FOREIGN KEY(workflow_id) REFERENCES workflows(workflow_id)); INSERT INTO workflows VALUES('wf'); INSERT INTO tasks VALUES('wf','task');").unwrap();
        ProviderLedger::migrate_v3_to_v4(connection).unwrap();
        ProviderLedger::migrate_v4_to_v5(connection).unwrap();
        ProviderLedger::migrate_v5_to_v6(connection).unwrap();
    }

    #[test]
    fn failed_v5_to_v6_migration_rolls_back_ddl_triggers_and_user_version() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE workflows(workflow_id TEXT PRIMARY KEY); CREATE TABLE tasks(workflow_id TEXT NOT NULL,task_id TEXT NOT NULL,PRIMARY KEY(workflow_id,task_id),FOREIGN KEY(workflow_id) REFERENCES workflows(workflow_id)); INSERT INTO workflows VALUES('wf'); INSERT INTO tasks VALUES('wf','task');").unwrap();
        ProviderLedger::migrate_v3_to_v4(&connection).unwrap();
        ProviderLedger::migrate_v4_to_v5(&connection).unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER provider_intent_payload_required BEFORE INSERT ON provider_dispatch_intents BEGIN SELECT RAISE(ABORT,'pre-existing trigger'); END;",
            )
            .unwrap();
        assert!(ProviderLedger::migrate_v5_to_v6(&connection).is_err());
        assert!(connection.is_autocommit());
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 5);
        let has_payload_column: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('provider_dispatch_intents') WHERE name='payload_json')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!has_payload_column);
        let identity_trigger: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='provider_intent_identity_immutable')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(identity_trigger);
    }

    fn request(payload: serde_json::Value) -> ProviderIntentRequest {
        ProviderIntentRequest {
            workflow_id: "wf".into(),
            task_id: "task".into(),
            attempt: 1,
            provider_id: "test-provider".into(),
            idempotency_key: "wf:task:1".into(),
            lease_id: "lease".into(),
            worker_id: "worker".into(),
            plan_sha256: "a".repeat(64),
            request_sha256: sha256_json(&payload).unwrap(),
            payload: Some(payload),
        }
    }

    #[test]
    fn participant_writes_to_callers_exact_connection_and_transaction_rolls_back() {
        let mut connection = schema();
        let request = request(serde_json::json!({"op":"run"}));
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let record =
            ProviderLedger::insert_reserved(&transaction, &request, "2026-01-01T00:00:00Z")
                .unwrap();
        assert!(
            ProviderLedger::load_by_id(&transaction, &record.intent_id)
                .unwrap()
                .is_some()
        );
        drop(transaction);
        assert!(
            ProviderLedger::load_by_id(&connection, &record.intent_id)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn reservation_and_payload_are_immutable_and_sha_verified() {
        let mut connection = schema();
        let request = request(serde_json::json!({"op":"run"}));
        let transaction = connection.transaction().unwrap();
        let record =
            ProviderLedger::insert_reserved(&transaction, &request, "2026-01-01T00:00:00Z")
                .unwrap();
        transaction.commit().unwrap();
        assert!(
            ProviderLedger::existing_reservation(&connection, &request)
                .unwrap()
                .is_some()
        );
        assert!(
            connection
                .execute(
                    "UPDATE provider_dispatch_intents SET payload_json='{}' WHERE intent_id=?1",
                    params![record.intent_id]
                )
                .is_err()
        );
        assert!(
            connection
                .execute(
                    "UPDATE provider_dispatch_intents SET request_sha256=?1 WHERE intent_id=?2",
                    params!["b".repeat(64), record.intent_id]
                )
                .is_err()
        );
        let mut altered = request;
        altered.payload = Some(serde_json::json!({"op":"other"}));
        assert!(matches!(
            ProviderLedger::existing_reservation(&connection, &altered),
            Err(ProviderPersistenceError::Conflict)
        ));
        connection
            .execute_batch("DROP TRIGGER provider_intent_identity_immutable;")
            .unwrap();
        connection
            .execute(
                "UPDATE provider_dispatch_intents SET payload_json='{}' WHERE intent_id=?1",
                params![record.intent_id],
            )
            .unwrap();
        assert!(matches!(
            ProviderLedger::load_by_id(&connection, &record.intent_id),
            Err(ProviderPersistenceError::Invalid(message)) if message.contains("payload digest mismatch")
        ));
    }

    #[test]
    fn reconciliation_observation_requires_bounded_structured_response() {
        let mut connection = schema();
        let request = request(serde_json::json!({"op":"run"}));
        let transaction = connection.transaction().unwrap();
        let record =
            ProviderLedger::insert_reserved(&transaction, &request, "2026-01-01T00:00:00Z")
                .unwrap();
        assert!(matches!(
            ProviderLedger::record_observation(
                &transaction,
                &record.intent_id,
                &serde_json::json!("FOUND"),
                None,
                "2026-01-01T00:00:01Z"
            ),
            Err(ProviderPersistenceError::Invalid(_))
        ));
        transaction.rollback().unwrap();
    }

    #[test]
    fn compare_and_set_finalization_is_single_winner_and_idempotent_for_same_value() {
        let mut connection = schema();
        let request = request(serde_json::json!({"op":"run"}));
        let transaction = connection.transaction().unwrap();
        let record =
            ProviderLedger::insert_reserved(&transaction, &request, "2026-01-01T00:00:00Z")
                .unwrap();
        transaction.commit().unwrap();
        let accepted = ProviderIntentOutcome::Accepted {
            provider_run_id: "run-1".into(),
        };
        let transaction = connection.transaction().unwrap();
        let (finalized, created) = ProviderLedger::finalize(
            &transaction,
            &record.intent_id,
            &accepted,
            "2026-01-01T00:00:01Z",
        )
        .unwrap();
        transaction.commit().unwrap();
        assert!(created);
        assert_eq!(finalized.state, ProviderDispatchState::Accepted);
        let transaction = connection.transaction().unwrap();
        let (repeated, created) = ProviderLedger::finalize(
            &transaction,
            &record.intent_id,
            &accepted,
            "2026-01-01T00:00:02Z",
        )
        .unwrap();
        assert!(!created);
        assert_eq!(repeated, finalized);
        transaction.commit().unwrap();
        let transaction = connection.transaction().unwrap();
        assert!(matches!(
            ProviderLedger::finalize(
                &transaction,
                &record.intent_id,
                &ProviderIntentOutcome::Unknown {
                    diagnostic: "ambiguous".into()
                },
                "2026-01-01T00:00:03Z"
            ),
            Err(ProviderPersistenceError::Finalized)
        ));
    }

    #[test]
    fn competing_connections_are_serialized_and_only_one_terminal_transition_wins() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("provider-ledger.sqlite");
        let mut first = Connection::open(&path).unwrap();
        first
            .busy_timeout(std::time::Duration::from_millis(40))
            .unwrap();
        install_schema(&first);
        let mut second = Connection::open(&path).unwrap();
        second
            .busy_timeout(std::time::Duration::from_millis(40))
            .unwrap();
        let request = request(serde_json::json!({"op":"run"}));
        let transaction = first.transaction().unwrap();
        let record =
            ProviderLedger::insert_reserved(&transaction, &request, "2026-01-01T00:00:00Z")
                .unwrap();
        transaction.commit().unwrap();

        let winner = first
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        ProviderLedger::finalize(
            &winner,
            &record.intent_id,
            &ProviderIntentOutcome::Accepted {
                provider_run_id: "run-winner".into(),
            },
            "2026-01-01T00:00:01Z",
        )
        .unwrap();
        assert!(matches!(
            second.transaction_with_behavior(TransactionBehavior::Immediate),
            Err(rusqlite::Error::SqliteFailure(code, _)) if code.code == rusqlite::ErrorCode::DatabaseBusy
        ));
        winner.commit().unwrap();

        let loser = second
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        assert!(matches!(
            ProviderLedger::finalize(
                &loser,
                &record.intent_id,
                &ProviderIntentOutcome::Rejected {
                    reason_code: "late".into(),
                    diagnostic: "second writer".into(),
                },
                "2026-01-01T00:00:02Z",
            ),
            Err(ProviderPersistenceError::Finalized)
        ));
    }

    #[test]
    fn lookup_observations_are_digest_checked_append_only_and_idempotent() {
        let mut connection = schema();
        let request = request(serde_json::json!({"op":"run"}));
        let transaction = connection.transaction().unwrap();
        let record =
            ProviderLedger::insert_reserved(&transaction, &request, "2026-01-01T00:00:00Z")
                .unwrap();
        transaction.commit().unwrap();
        let response = serde_json::json!({"status":"found","run":"run-1"});
        let transaction = connection.transaction().unwrap();
        let (observation, created) = ProviderLedger::record_observation(
            &transaction,
            &record.intent_id,
            &response,
            Some("run-1"),
            "2026-01-01T00:00:01Z",
        )
        .unwrap();
        assert!(created);
        transaction.commit().unwrap();
        assert_eq!(
            ProviderLedger::load_observation_by_id(&connection, &observation.observation_id)
                .unwrap(),
            Some(observation.clone())
        );
        assert_eq!(
            ProviderLedger::list_observations(&connection, &record.intent_id).unwrap(),
            vec![observation.clone()]
        );
        let transaction = connection.transaction().unwrap();
        let (repeated, created) = ProviderLedger::record_observation(
            &transaction,
            &record.intent_id,
            &response,
            Some("run-1"),
            "2026-01-01T00:00:02Z",
        )
        .unwrap();
        assert!(!created);
        transaction.commit().unwrap();
        assert_eq!(repeated, observation);
        assert!(connection.execute("UPDATE provider_reconciliation_observations SET response_json='{}' WHERE observation_id=?1",params![observation.observation_id]).is_err());
        connection
            .execute_batch("DROP TRIGGER provider_reconciliation_append_only_update;")
            .unwrap();
        connection
            .execute(
                "UPDATE provider_reconciliation_observations SET response_json='{}' WHERE observation_id=?1",
                params![observation.observation_id],
            )
            .unwrap();
        assert!(matches!(
            ProviderLedger::load_observation_by_id(&connection, &observation.observation_id),
            Err(ProviderPersistenceError::Invalid(message)) if message.contains("observation digest mismatch")
        ));
    }
}
