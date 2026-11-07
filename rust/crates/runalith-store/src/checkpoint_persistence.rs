//! Durable D-01 AGG nonce custody in the workflow SQLite database.

use chrono::{SecondsFormat, Utc};
use runalith_agg::custody::{
    AttestationNonceLedger, AuthorityOperationReceipt, AuthorityOperationStatus,
    AuthorityReceiptVerifier, CheckpointMeasurement, CheckpointOperationRepository, CustodyError,
    LocalCheckpointOperationState, PrepareRequest, SecurityProjectionTransitionGate,
    TransitionGateLease,
};
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::Store;

/// Read-only durable operation journal row used by host recovery/reconciliation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CheckpointOperationSnapshot {
    /// Exact persisted request.
    pub request: PrepareRequest,
    /// Durable local state, as stored in the v2 state machine.
    pub state: String,
    /// Authenticated external receipt, if one was verified and persisted.
    pub authority_receipt: Option<AuthorityOperationReceipt>,
    /// Quarantine reason, when present.
    pub reason: Option<String>,
    /// Fencing token that created/owns the operation.
    pub fencing_token: u64,
    /// Operation creation time, Unix milliseconds.
    pub created_at_ms: i64,
    /// Last state transition time, Unix milliseconds.
    pub updated_at_ms: i64,
}

/// Store adapter that requires a real authority receipt verifier before it can
/// persist remote PREPARED/ABORTED observations.
pub struct StoreCheckpointOperationRepository<'a> {
    store: &'a Store,
    authority_verifier: &'a dyn AuthorityReceiptVerifier,
}

impl StoreCheckpointOperationRepository<'_> {
    /// Read local recovery state and independently verify every persisted
    /// authority receipt. Pending intents without a receipt remain unverified;
    /// this does not establish remote head or outstanding-operation completeness.
    pub fn list_operations_with_verified_authority_receipts(
        &self,
        logical_db_id: &str,
        include_terminal: bool,
        limit: u64,
    ) -> Result<Vec<CheckpointOperationSnapshot>, CustodyError> {
        let snapshots =
            self.store
                .list_checkpoint_operations(logical_db_id, include_terminal, limit)?;
        for snapshot in &snapshots {
            if let Some(receipt) = &snapshot.authority_receipt {
                if !self
                    .authority_verifier
                    .verify_operation(&snapshot.request, receipt)?
                {
                    return Err(custody_authority(
                        "persisted checkpoint authority receipt failed independent verification",
                    ));
                }
            }
        }
        Ok(snapshots)
    }
}

impl Store {
    /// Bind the durable local operation repository to an independently
    /// provisioned authority receipt verifier. This does not create an authority.
    pub fn checkpoint_operation_repository<'a>(
        &'a self,
        authority_verifier: &'a dyn AuthorityReceiptVerifier,
    ) -> StoreCheckpointOperationRepository<'a> {
        StoreCheckpointOperationRepository {
            store: self,
            authority_verifier,
        }
    }

    /// Read checkpoint operations for recovery. This is diagnostic state only;
    /// it is not proof of the external authority head or outstanding set.
    pub fn list_checkpoint_operations(
        &self,
        logical_db_id: &str,
        include_terminal: bool,
        limit: u64,
    ) -> Result<Vec<CheckpointOperationSnapshot>, CustodyError> {
        if logical_db_id.trim().is_empty() || logical_db_id.len() > 256 || limit == 0 || limit > 500
        {
            return Err(custody_authority("invalid checkpoint operation query"));
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| custody_authority("workflow database lock poisoned"))?;
        let state_filter = if include_terminal {
            ""
        } else {
            "AND state NOT IN ('ANCHORED','ABORTED','QUARANTINED')"
        };
        let sql = format!(
            "SELECT operation_id,request_sha256,request_json,nonce,db_generation,restore_epoch,
                    expected_sequence,expected_head_sha256,transition_sha256,manifest_sha256,
                    manifest_version,expires_at_ms,owner_id,state,authority_receipt_json,reason,
                    fencing_token,created_at_ms,updated_at_ms
             FROM agg_checkpoint_operations WHERE logical_db_id=?1 {state_filter}
             ORDER BY created_at_ms DESC,operation_id LIMIT ?2"
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| custody_authority(error.to_string()))?;
        let mut rows = statement
            .query(params![logical_db_id, limit as i64])
            .map_err(|error| custody_authority(error.to_string()))?;
        let mut snapshots = Vec::new();
        while let Some(row) = rows
            .next()
            .map_err(|error| custody_authority(error.to_string()))?
        {
            let stored_operation_id: String = row
                .get(0)
                .map_err(|error| custody_authority(error.to_string()))?;
            let stored_request_sha256: String = row
                .get(1)
                .map_err(|error| custody_authority(error.to_string()))?;
            let request_json: String = row
                .get(2)
                .map_err(|error| custody_authority(error.to_string()))?;
            let stored_nonce: String = row
                .get(3)
                .map_err(|error| custody_authority(error.to_string()))?;
            let stored_db_generation: i64 = row
                .get(4)
                .map_err(|error| custody_authority(error.to_string()))?;
            let stored_restore_epoch: i64 = row
                .get(5)
                .map_err(|error| custody_authority(error.to_string()))?;
            let stored_expected_sequence: i64 = row
                .get(6)
                .map_err(|error| custody_authority(error.to_string()))?;
            let stored_expected_head: Option<String> = row
                .get(7)
                .map_err(|error| custody_authority(error.to_string()))?;
            let stored_transition_sha256: String = row
                .get(8)
                .map_err(|error| custody_authority(error.to_string()))?;
            let stored_manifest_sha256: String = row
                .get(9)
                .map_err(|error| custody_authority(error.to_string()))?;
            let stored_manifest_version: i64 = row
                .get(10)
                .map_err(|error| custody_authority(error.to_string()))?;
            let stored_expires_at_ms: i64 = row
                .get(11)
                .map_err(|error| custody_authority(error.to_string()))?;
            let owner_id: String = row
                .get(12)
                .map_err(|error| custody_authority(error.to_string()))?;
            let state: String = row
                .get(13)
                .map_err(|error| custody_authority(error.to_string()))?;
            let receipt_json: Option<String> = row
                .get(14)
                .map_err(|error| custody_authority(error.to_string()))?;
            let reason: Option<String> = row
                .get(15)
                .map_err(|error| custody_authority(error.to_string()))?;
            let fencing_token: i64 = row
                .get(16)
                .map_err(|error| custody_authority(error.to_string()))?;
            let created_at_ms: i64 = row
                .get(17)
                .map_err(|error| custody_authority(error.to_string()))?;
            let updated_at_ms: i64 = row
                .get(18)
                .map_err(|error| custody_authority(error.to_string()))?;
            let request: PrepareRequest = serde_json::from_str(&request_json)
                .map_err(|error| custody_authority(error.to_string()))?;
            let mut canonical_value = serde_json::to_value(&request)
                .map_err(|error| custody_authority(error.to_string()))?;
            canonical_value
                .as_object_mut()
                .ok_or_else(|| custody_authority("stored checkpoint request is not an object"))?
                .remove("request_sha256");
            let canonical = runalith_protocol::agg_checkpoint_v2::canonicalize(&canonical_value)
                .map_err(|error| custody_authority(error.to_string()))?;
            let computed_request_sha256 = hex::encode(Sha256::digest(canonical.as_bytes()));
            if request.logical_db_id != logical_db_id
                || request.operation_id != stored_operation_id
                || request.request_sha256 != stored_request_sha256
                || request.nonce != stored_nonce
                || i64::try_from(request.db_generation).ok() != Some(stored_db_generation)
                || i64::try_from(request.restore_epoch).ok() != Some(stored_restore_epoch)
                || i64::try_from(request.expected_sequence).ok() != Some(stored_expected_sequence)
                || request.expected_head_sha256 != stored_expected_head
                || request.transition_sha256 != stored_transition_sha256
                || request.manifest_sha256 != stored_manifest_sha256
                || i64::try_from(request.manifest_version).ok() != Some(stored_manifest_version)
                || request.expires_at_ms != stored_expires_at_ms
                || request.operation_id.trim().is_empty()
                || request.request_sha256 != computed_request_sha256
                || owner_id.trim().is_empty()
                || owner_id.len() > 256
                || created_at_ms < 0
                || updated_at_ms < created_at_ms
                || fencing_token <= 0
                || request.expires_at_ms <= created_at_ms
                || request
                    .validate(canonical.as_bytes(), created_at_ms)
                    .is_err()
            {
                return Err(custody_authority(
                    "checkpoint operation request or denormalized journal binding is invalid",
                ));
            }
            if !matches!(
                state.as_str(),
                "INTENT_PENDING"
                    | "REMOTE_RESERVED"
                    | "ANCHOR_PENDING"
                    | "ANCHORED"
                    | "ABORTED"
                    | "QUARANTINED"
            ) {
                return Err(custody_authority("unknown checkpoint operation state"));
            }
            let authority_receipt: Option<AuthorityOperationReceipt> = receipt_json
                .map(|raw| serde_json::from_str(&raw))
                .transpose()
                .map_err(|error| custody_authority(error.to_string()))?;
            let receipt_required = matches!(
                state.as_str(),
                "REMOTE_RESERVED" | "ANCHOR_PENDING" | "ANCHORED" | "ABORTED"
            );
            if receipt_required && authority_receipt.is_none() {
                return Err(custody_authority(
                    "checkpoint operation state is missing its authority receipt",
                ));
            }
            if state == "INTENT_PENDING" && authority_receipt.is_some() {
                return Err(custody_authority(
                    "checkpoint intent unexpectedly contains an authority receipt",
                ));
            }
            if let Some(receipt) = &authority_receipt {
                let expected_status = match state.as_str() {
                    "REMOTE_RESERVED" | "ANCHOR_PENDING" => {
                        Some(AuthorityOperationStatus::Prepared)
                    }
                    "ANCHORED" => Some(AuthorityOperationStatus::Committed),
                    "ABORTED" => Some(AuthorityOperationStatus::Aborted),
                    _ => None,
                };
                if receipt.operation_id != request.operation_id
                    || receipt.request_sha256 != request.request_sha256
                    || expected_status.is_some_and(|status| receipt.status != status)
                {
                    return Err(custody_authority(
                        "checkpoint operation receipt is not bound to its durable request/state",
                    ));
                }
            }
            if (state == "QUARANTINED") != reason.is_some() {
                return Err(custody_authority(
                    "checkpoint quarantine reason does not match operation state",
                ));
            }
            let latest_event: Option<(String, String, i64, i64)> = connection
                .query_row(
                    "SELECT event_type,state,fencing_token,created_at_ms
                     FROM agg_checkpoint_operation_events
                     WHERE operation_id=?1 ORDER BY event_seq DESC LIMIT 1",
                    params![request.operation_id],
                    |event| Ok((event.get(0)?, event.get(1)?, event.get(2)?, event.get(3)?)),
                )
                .optional()
                .map_err(|error| custody_authority(error.to_string()))?;
            let Some((event_type, event_state, event_fencing_token, event_created_at_ms)) =
                latest_event
            else {
                return Err(custody_authority(
                    "checkpoint operation has no durable transition event",
                ));
            };
            if event_type != state
                || event_state != state
                || event_fencing_token != fencing_token
                || event_created_at_ms != updated_at_ms
            {
                return Err(custody_authority(
                    "checkpoint operation state does not match its latest fenced event",
                ));
            }
            snapshots.push(CheckpointOperationSnapshot {
                request,
                state,
                authority_receipt,
                reason,
                fencing_token: u64::try_from(fencing_token)
                    .map_err(|_| custody_authority("invalid stored fencing token"))?,
                created_at_ms,
                updated_at_ms,
            });
        }
        Ok(snapshots)
    }

    /// Whether this workflow database has an irreversible local checkpoint
    /// quarantine. Only a separately authorized recovery procedure may clear it.
    pub fn checkpoint_store_quarantine(&self) -> Result<Option<(String, String)>, CustodyError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| custody_authority("workflow database lock poisoned"))?;
        connection
            .query_row(
                "SELECT operation_id,reason FROM agg_checkpoint_store_quarantine WHERE singleton=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| custody_authority(error.to_string()))
    }
}

impl SecurityProjectionTransitionGate for Store {
    fn acquire_exclusive(
        &self,
        logical_db_id: &str,
        owner_id: &str,
        now_ms: i64,
        ttl_ms: i64,
    ) -> Result<TransitionGateLease, CustodyError> {
        validate_gate_request(logical_db_id, owner_id, now_ms, ttl_ms)?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| custody_authority("workflow database lock poisoned"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| custody_authority(error.to_string()))?;
        let quarantined: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agg_checkpoint_store_quarantine WHERE singleton=1)",
                [],
                |row| row.get(0),
            )
            .map_err(|error| custody_authority(error.to_string()))?;
        if quarantined {
            return Err(custody_authority(
                "workflow database is quarantined pending external reconciliation",
            ));
        }
        let existing: Option<(String, i64, i64)> = transaction
            .query_row(
                "SELECT owner_id,fencing_token,expires_at_ms FROM agg_checkpoint_transition_gate WHERE logical_db_id=?1",
                params![logical_db_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| custody_authority(error.to_string()))?;
        let fencing_token = if let Some((current_owner, current_token, expires_at_ms)) = existing {
            if expires_at_ms > now_ms {
                return Err(custody_authority(
                    "checkpoint transition gate is already leased",
                ));
            }
            let unresolved: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM agg_checkpoint_operations WHERE logical_db_id=?1 AND state NOT IN ('ANCHORED','ABORTED','QUARANTINED'))",
                    params![logical_db_id],
                    |row| row.get(0),
                )
                .map_err(|error| custody_authority(error.to_string()))?;
            if unresolved {
                return Err(custody_authority(format!(
                    "expired checkpoint gate owned by {current_owner} has unresolved operations; reconcile authority head and outstanding set before takeover"
                )));
            }
            let next = current_token
                .checked_add(1)
                .ok_or_else(|| custody_authority("checkpoint fencing token exhausted"))?;
            transaction
                .execute(
                    "UPDATE agg_checkpoint_transition_gate SET owner_id=?1,fencing_token=?2,expires_at_ms=?3,updated_at_ms=?4 WHERE logical_db_id=?5 AND fencing_token=?6",
                    params![owner_id, next, now_ms.saturating_add(ttl_ms), now_ms, logical_db_id, current_token],
                )
                .map_err(|error| custody_authority(error.to_string()))?;
            next
        } else {
            transaction
                .execute(
                    "INSERT INTO agg_checkpoint_transition_gate(logical_db_id,owner_id,fencing_token,expires_at_ms,updated_at_ms) VALUES(?1,?2,1,?3,?4)",
                    params![logical_db_id, owner_id, now_ms.saturating_add(ttl_ms), now_ms],
                )
                .map_err(|error| custody_authority(error.to_string()))?;
            1
        };
        transaction
            .commit()
            .map_err(|error| custody_authority(error.to_string()))?;
        Ok(TransitionGateLease {
            logical_db_id: logical_db_id.into(),
            owner_id: owner_id.into(),
            fencing_token: u64::try_from(fencing_token)
                .map_err(|_| custody_authority("invalid allocated fencing token"))?,
            expires_at_ms: now_ms.saturating_add(ttl_ms),
        })
    }

    fn renew(
        &self,
        lease: &TransitionGateLease,
        now_ms: i64,
        ttl_ms: i64,
    ) -> Result<TransitionGateLease, CustodyError> {
        validate_gate_request(&lease.logical_db_id, &lease.owner_id, now_ms, ttl_ms)?;
        if lease.expires_at_ms <= now_ms {
            return Err(custody_authority("checkpoint transition lease has expired"));
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| custody_authority("workflow database lock poisoned"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| custody_authority(error.to_string()))?;
        ensure_not_quarantined(&transaction)?;
        let changed = transaction
            .execute(
                "UPDATE agg_checkpoint_transition_gate SET expires_at_ms=?1,updated_at_ms=?2
                 WHERE logical_db_id=?3 AND owner_id=?4 AND fencing_token=?5 AND expires_at_ms=?6 AND expires_at_ms>?2",
                params![now_ms.saturating_add(ttl_ms), now_ms, lease.logical_db_id, lease.owner_id, lease.fencing_token, lease.expires_at_ms],
            )
            .map_err(|error| custody_authority(error.to_string()))?;
        if changed != 1 {
            return Err(custody_authority(
                "checkpoint transition lease fencing check failed",
            ));
        }
        transaction
            .commit()
            .map_err(|error| custody_authority(error.to_string()))?;
        Ok(TransitionGateLease {
            expires_at_ms: now_ms.saturating_add(ttl_ms),
            ..lease.clone()
        })
    }

    fn release_after_terminal_state(
        &self,
        lease: &TransitionGateLease,
        state: LocalCheckpointOperationState,
    ) -> Result<(), CustodyError> {
        let state = local_state_name(state);
        if !matches!(state, "ANCHORED" | "ABORTED" | "QUARANTINED") {
            return Err(custody_authority(
                "checkpoint gate may be released only after a terminal operation state",
            ));
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| custody_authority("workflow database lock poisoned"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| custody_authority(error.to_string()))?;
        let operation: Option<(String, Option<String>, Option<String>)> = transaction
            .query_row(
                "SELECT state,authority_receipt_json,measurement_json FROM agg_checkpoint_operations
                 WHERE logical_db_id=?1 AND owner_id=?2 AND fencing_token=?3 ORDER BY created_at_ms DESC LIMIT 1",
                params![lease.logical_db_id, lease.owner_id, lease.fencing_token],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| custody_authority(error.to_string()))?;
        let Some((operation_state, receipt, measurement)) = operation else {
            return Err(custody_authority(
                "no checkpoint operation belongs to this gate lease",
            ));
        };
        if operation_state != state {
            return Err(custody_authority(
                "checkpoint operation is not in the requested terminal state",
            ));
        }
        if state == "ANCHORED" && (receipt.is_none() || measurement.is_none()) {
            return Err(custody_authority(
                "anchored operation lacks receipt or measurement binding",
            ));
        }
        if state == "QUARANTINED" {
            let quarantined: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM agg_checkpoint_store_quarantine WHERE logical_db_id=?1 AND fencing_token=?2)",
                    params![lease.logical_db_id, lease.fencing_token],
                    |row| row.get(0),
                )
                .map_err(|error| custody_authority(error.to_string()))?;
            if !quarantined {
                return Err(custody_authority(
                    "quarantined operation has no durable store-wide quarantine",
                ));
            }
        }
        let changed = transaction
            .execute(
                "UPDATE agg_checkpoint_transition_gate SET owner_id='',expires_at_ms=0,updated_at_ms=?1
                 WHERE logical_db_id=?2 AND owner_id=?3 AND fencing_token=?4",
                params![Utc::now().timestamp_millis(), lease.logical_db_id, lease.owner_id, lease.fencing_token],
            )
            .map_err(|error| custody_authority(error.to_string()))?;
        if changed != 1 {
            return Err(custody_authority(
                "checkpoint gate release lost fencing compare-and-swap",
            ));
        }
        transaction
            .commit()
            .map_err(|error| custody_authority(error.to_string()))
    }
}

impl CheckpointOperationRepository for StoreCheckpointOperationRepository<'_> {
    fn persist_intent(
        &self,
        lease: &TransitionGateLease,
        request: &PrepareRequest,
    ) -> Result<(), CustodyError> {
        let now_ms = Utc::now().timestamp_millis();
        if request.logical_db_id != lease.logical_db_id || request.expires_at_ms <= now_ms {
            return Err(custody_authority(
                "checkpoint intent does not match active database or expiry",
            ));
        }
        let value =
            serde_json::to_value(request).map_err(|error| custody_authority(error.to_string()))?;
        let mut canonical_value = value.clone();
        canonical_value
            .as_object_mut()
            .ok_or_else(|| custody_authority("checkpoint request must be a JSON object"))?
            .remove("request_sha256");
        let canonical = runalith_protocol::agg_checkpoint_v2::canonicalize(&canonical_value)
            .map_err(|error| custody_authority(error.to_string()))?;
        request
            .validate(canonical.as_bytes(), now_ms)
            .map_err(|error| custody_authority(format!("invalid checkpoint intent: {error:?}")))?;
        if request.operation_id.len() > 256
            || request.logical_db_id.len() > 256
            || request.nonce.len() > 128
            || !request
                .nonce
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(custody_authority(
                "checkpoint request exceeds local persistence bounds",
            ));
        }
        let expected_sequence = i64::try_from(request.expected_sequence)
            .map_err(|_| custody_authority("checkpoint expected sequence exceeds SQLite range"))?;
        let db_generation = i64::try_from(request.db_generation)
            .map_err(|_| custody_authority("database generation exceeds SQLite range"))?;
        let restore_epoch = i64::try_from(request.restore_epoch)
            .map_err(|_| custody_authority("restore epoch exceeds SQLite range"))?;
        let manifest_version = i64::try_from(request.manifest_version)
            .map_err(|_| custody_authority("manifest version exceeds SQLite range"))?;
        let fencing_token = i64::try_from(lease.fencing_token)
            .map_err(|_| custody_authority("fencing token exceeds SQLite range"))?;
        let mut connection = self
            .store
            .connection
            .lock()
            .map_err(|_| custody_authority("workflow database lock poisoned"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| custody_authority(error.to_string()))?;
        assert_active_lease(&transaction, lease, now_ms)?;
        ensure_not_quarantined(&transaction)?;
        let unresolved: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agg_checkpoint_operations WHERE logical_db_id=?1 AND state NOT IN ('ANCHORED','ABORTED','QUARANTINED'))",
                params![request.logical_db_id],
                |row| row.get(0),
            )
            .map_err(|error| custody_authority(error.to_string()))?;
        if unresolved {
            return Err(custody_authority(
                "another checkpoint operation is unresolved for this logical database",
            ));
        }
        let request_json =
            serde_json::to_string(&value).map_err(|error| custody_authority(error.to_string()))?;
        transaction
            .execute(
                "INSERT INTO agg_checkpoint_operations(
                   operation_id,request_sha256,request_json,nonce,logical_db_id,db_generation,restore_epoch,
                   expected_sequence,expected_head_sha256,transition_sha256,manifest_sha256,manifest_version,
                   expires_at_ms,owner_id,fencing_token,state,created_at_ms,updated_at_ms
                 ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,'INTENT_PENDING',?16,?16)",
                params![
                    request.operation_id, request.request_sha256, request_json, request.nonce,
                    request.logical_db_id, db_generation, restore_epoch,
                    expected_sequence, request.expected_head_sha256, request.transition_sha256,
                    request.manifest_sha256, manifest_version, request.expires_at_ms,
                    lease.owner_id, fencing_token, now_ms
                ],
            )
            .map_err(|error| custody_authority(error.to_string()))?;
        append_operation_event(
            &transaction,
            &request.operation_id,
            "INTENT_PENDING",
            lease,
            &serde_json::json!({"request_sha256":request.request_sha256,"manifest_version":request.manifest_version}),
            now_ms,
        )?;
        transaction
            .commit()
            .map_err(|error| custody_authority(error.to_string()))
    }

    fn record_remote_reserved(
        &self,
        lease: &TransitionGateLease,
        receipt: &AuthorityOperationReceipt,
    ) -> Result<(), CustodyError> {
        if receipt.status != AuthorityOperationStatus::Prepared
            || receipt.sequence.is_some()
            || receipt.checkpoint_sha256.is_some()
        {
            return Err(custody_authority(
                "remote reservation receipt is not PREPARED",
            ));
        }
        let request = self.load_request(&receipt.operation_id)?;
        if request.request_sha256 != receipt.request_sha256
            || request.expires_at_ms <= Utc::now().timestamp_millis()
            || !self
                .authority_verifier
                .verify_operation(&request, receipt)?
        {
            return Err(custody_authority(
                "remote PREPARED receipt failed signature or request binding verification",
            ));
        }
        let now_ms = Utc::now().timestamp_millis();
        let mut connection = self
            .store
            .connection
            .lock()
            .map_err(|_| custody_authority("workflow database lock poisoned"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| custody_authority(error.to_string()))?;
        assert_active_lease(&transaction, lease, now_ms)?;
        ensure_not_quarantined(&transaction)?;
        let state: String = transaction
            .query_row(
                "SELECT state FROM agg_checkpoint_operations WHERE operation_id=?1 AND logical_db_id=?2 AND request_sha256=?3 AND owner_id=?4 AND fencing_token=?5",
                params![receipt.operation_id, lease.logical_db_id, receipt.request_sha256, lease.owner_id, lease.fencing_token],
                |row| row.get(0),
            )
            .map_err(|error| custody_authority(error.to_string()))?;
        if state != "INTENT_PENDING" {
            return Err(custody_authority(
                "checkpoint intent is not awaiting remote reservation",
            ));
        }
        let receipt_json =
            serde_json::to_string(receipt).map_err(|error| custody_authority(error.to_string()))?;
        let changed = transaction
            .execute(
                "UPDATE agg_checkpoint_operations SET state='REMOTE_RESERVED',authority_receipt_json=?1,updated_at_ms=?2
                 WHERE operation_id=?3 AND state='INTENT_PENDING' AND fencing_token=?4",
                params![receipt_json, now_ms, receipt.operation_id, lease.fencing_token],
            )
            .map_err(|error| custody_authority(error.to_string()))?;
        if changed != 1 {
            return Err(custody_authority(
                "remote reservation transition lost compare-and-swap",
            ));
        }
        append_operation_event(
            &transaction,
            &receipt.operation_id,
            "REMOTE_RESERVED",
            lease,
            &serde_json::json!({"request_sha256":receipt.request_sha256}),
            now_ms,
        )?;
        transaction
            .commit()
            .map_err(|error| custody_authority(error.to_string()))
    }

    fn record_aborted(
        &self,
        lease: &TransitionGateLease,
        receipt: &AuthorityOperationReceipt,
    ) -> Result<(), CustodyError> {
        if receipt.status != AuthorityOperationStatus::Aborted
            || receipt.sequence.is_some()
            || receipt.checkpoint_sha256.is_some()
        {
            return Err(custody_authority("authority abort receipt is not ABORTED"));
        }
        let request = self.load_request(&receipt.operation_id)?;
        if request.request_sha256 != receipt.request_sha256
            || !self
                .authority_verifier
                .verify_operation(&request, receipt)?
        {
            return Err(custody_authority(
                "authority ABORTED receipt failed signature or request binding verification",
            ));
        }
        let now_ms = Utc::now().timestamp_millis();
        let mut connection = self
            .store
            .connection
            .lock()
            .map_err(|_| custody_authority("workflow database lock poisoned"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| custody_authority(error.to_string()))?;
        assert_active_lease(&transaction, lease, now_ms)?;
        ensure_not_quarantined(&transaction)?;
        let state: String = transaction
            .query_row(
                "SELECT state FROM agg_checkpoint_operations WHERE operation_id=?1 AND logical_db_id=?2 AND request_sha256=?3 AND owner_id=?4 AND fencing_token=?5",
                params![receipt.operation_id, lease.logical_db_id, receipt.request_sha256, lease.owner_id, lease.fencing_token],
                |row| row.get(0),
            )
            .map_err(|error| custody_authority(error.to_string()))?;
        if !matches!(state.as_str(), "INTENT_PENDING" | "REMOTE_RESERVED") {
            return Err(custody_authority(
                "operation cannot be aborted after projection mutation",
            ));
        }
        let receipt_json =
            serde_json::to_string(receipt).map_err(|error| custody_authority(error.to_string()))?;
        transaction
            .execute(
                "UPDATE agg_checkpoint_operations SET state='ABORTED',authority_receipt_json=?1,updated_at_ms=?2
                 WHERE operation_id=?3 AND state=?4 AND fencing_token=?5",
                params![receipt_json, now_ms, receipt.operation_id, state, lease.fencing_token],
            )
            .map_err(|error| custody_authority(error.to_string()))?;
        append_operation_event(
            &transaction,
            &receipt.operation_id,
            "ABORTED",
            lease,
            &serde_json::json!({"request_sha256":receipt.request_sha256}),
            now_ms,
        )?;
        transaction
            .commit()
            .map_err(|error| custody_authority(error.to_string()))
    }

    fn apply_projection_and_mark_pending(
        &self,
        _: &TransitionGateLease,
        _: &str,
        _: &str,
    ) -> Result<CheckpointMeasurement, CustodyError> {
        Err(custody_authority(
            "projection mutation is disabled: approved v2 projection manifest, complete authorization writer inventory, and transactional mutation descriptor are not available",
        ))
    }

    fn record_anchored_if_projection_matches(
        &self,
        _: &TransitionGateLease,
        _: &AuthorityOperationReceipt,
        _: &CheckpointMeasurement,
    ) -> Result<(), CustodyError> {
        Err(custody_authority(
            "ANCHOR cannot be recorded without an approved projection measurer and current-state equality proof",
        ))
    }

    fn quarantine_store(
        &self,
        lease: &TransitionGateLease,
        operation_id: &str,
        reason: &str,
    ) -> Result<(), CustodyError> {
        if operation_id.trim().is_empty()
            || operation_id.len() > 256
            || reason.trim().is_empty()
            || reason.len() > 2000
        {
            return Err(custody_authority("invalid checkpoint quarantine request"));
        }
        let now_ms = Utc::now().timestamp_millis();
        let mut connection = self
            .store
            .connection
            .lock()
            .map_err(|_| custody_authority("workflow database lock poisoned"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| custody_authority(error.to_string()))?;
        assert_active_lease(&transaction, lease, now_ms)?;
        let state: String = transaction
            .query_row(
                "SELECT state FROM agg_checkpoint_operations WHERE operation_id=?1 AND logical_db_id=?2 AND owner_id=?3 AND fencing_token=?4",
                params![operation_id, lease.logical_db_id, lease.owner_id, lease.fencing_token],
                |row| row.get(0),
            )
            .map_err(|error| custody_authority(error.to_string()))?;
        if matches!(state.as_str(), "ANCHORED" | "ABORTED" | "QUARANTINED") {
            return Err(custody_authority(
                "terminal checkpoint operation cannot be quarantined again",
            ));
        }
        let changed = transaction
            .execute(
                "UPDATE agg_checkpoint_operations SET state='QUARANTINED',reason=?1,updated_at_ms=?2
                 WHERE operation_id=?3 AND state=?4 AND fencing_token=?5",
                params![reason, now_ms, operation_id, state, lease.fencing_token],
            )
            .map_err(|error| custody_authority(error.to_string()))?;
        if changed != 1 {
            return Err(custody_authority(
                "checkpoint quarantine lost compare-and-swap",
            ));
        }
        transaction
            .execute(
                "INSERT INTO agg_checkpoint_store_quarantine(singleton,logical_db_id,operation_id,reason,fencing_token,quarantined_at_ms)
                 VALUES(1,?1,?2,?3,?4,?5)",
                params![lease.logical_db_id, operation_id, reason, lease.fencing_token, now_ms],
            )
            .map_err(|error| custody_authority(error.to_string()))?;
        append_operation_event(
            &transaction,
            operation_id,
            "QUARANTINED",
            lease,
            &serde_json::json!({"reason":reason}),
            now_ms,
        )?;
        transaction
            .commit()
            .map_err(|error| custody_authority(error.to_string()))
    }
}

impl StoreCheckpointOperationRepository<'_> {
    fn load_request(&self, operation_id: &str) -> Result<PrepareRequest, CustodyError> {
        let connection = self
            .store
            .connection
            .lock()
            .map_err(|_| custody_authority("workflow database lock poisoned"))?;
        let raw: String = connection
            .query_row(
                "SELECT request_json FROM agg_checkpoint_operations WHERE operation_id=?1",
                params![operation_id],
                |row| row.get(0),
            )
            .map_err(|error| custody_authority(error.to_string()))?;
        serde_json::from_str(&raw).map_err(|error| custody_authority(error.to_string()))
    }
}

fn validate_gate_request(
    logical_db_id: &str,
    owner_id: &str,
    now_ms: i64,
    ttl_ms: i64,
) -> Result<(), CustodyError> {
    if logical_db_id.trim().is_empty()
        || logical_db_id.len() > 256
        || owner_id.trim().is_empty()
        || owner_id.len() > 256
        || now_ms < 0
        || !(1_000..=300_000).contains(&ttl_ms)
        || now_ms.checked_add(ttl_ms).is_none()
    {
        return Err(custody_authority("invalid checkpoint gate lease request"));
    }
    Ok(())
}

fn assert_active_lease(
    transaction: &Transaction<'_>,
    lease: &TransitionGateLease,
    now_ms: i64,
) -> Result<(), CustodyError> {
    let current: Option<(String, i64, i64)> = transaction
        .query_row(
            "SELECT owner_id,fencing_token,expires_at_ms FROM agg_checkpoint_transition_gate WHERE logical_db_id=?1",
            params![lease.logical_db_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| custody_authority(error.to_string()))?;
    if current
        != Some((
            lease.owner_id.clone(),
            lease.fencing_token as i64,
            lease.expires_at_ms,
        ))
        || lease.expires_at_ms <= now_ms
    {
        return Err(custody_authority(
            "checkpoint transition lease fencing check failed",
        ));
    }
    Ok(())
}

fn ensure_not_quarantined(transaction: &Transaction<'_>) -> Result<(), CustodyError> {
    let quarantined: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agg_checkpoint_store_quarantine WHERE singleton=1)",
            [],
            |row| row.get(0),
        )
        .map_err(|error| custody_authority(error.to_string()))?;
    if quarantined {
        return Err(custody_authority("workflow database is quarantined"));
    }
    Ok(())
}

fn append_operation_event(
    transaction: &Transaction<'_>,
    operation_id: &str,
    event_type: &str,
    lease: &TransitionGateLease,
    payload: &Value,
    now_ms: i64,
) -> Result<(), CustodyError> {
    let state = event_type;
    transaction
        .execute(
            "INSERT INTO agg_checkpoint_operation_events(event_id,operation_id,event_type,state,fencing_token,payload_json,created_at_ms)
             VALUES(?1,?2,?3,?3,?4,?5,?6)",
            params![
                Uuid::new_v4().simple().to_string(),
                operation_id,
                event_type,
                lease.fencing_token,
                serde_json::to_string(payload).map_err(|error| custody_authority(error.to_string()))?,
                now_ms
            ],
        )
        .map_err(|error| custody_authority(format!("checkpoint event {state}: {error}")))?;
    Ok(())
}

fn local_state_name(state: LocalCheckpointOperationState) -> &'static str {
    match state {
        LocalCheckpointOperationState::IntentPending => "INTENT_PENDING",
        LocalCheckpointOperationState::RemoteReserved => "REMOTE_RESERVED",
        LocalCheckpointOperationState::AnchorPending => "ANCHOR_PENDING",
        LocalCheckpointOperationState::Anchored => "ANCHORED",
        LocalCheckpointOperationState::Aborted => "ABORTED",
        LocalCheckpointOperationState::Quarantined => "QUARANTINED",
    }
}

fn custody_authority(message: impl Into<String>) -> CustodyError {
    CustodyError::Authority(message.into())
}

impl AttestationNonceLedger for Store {
    fn consume_once(
        &self,
        nonce: &str,
        operation_id: &str,
        checkpoint_sha256: &str,
    ) -> Result<bool, CustodyError> {
        if !(64..=128).contains(&nonce.len())
            || nonce.len() % 2 != 0
            || !nonce
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || operation_id.trim().is_empty()
            || operation_id.len() > 256
            || checkpoint_sha256.len() != 64
            || !checkpoint_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(CustodyError::Attestation(
                "nonce, operation identity, or checkpoint digest is malformed".into(),
            ));
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| CustodyError::Attestation("workflow database lock poisoned".into()))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| CustodyError::Attestation(error.to_string()))?;
        ensure_not_quarantined(&transaction)?;
        let inserted = transaction
            .execute(
                "INSERT INTO agg_attestation_nonces(nonce,operation_id,checkpoint_sha256,consumed_at)
                 VALUES(?1,?2,?3,?4) ON CONFLICT(nonce) DO NOTHING",
                params![
                    nonce,
                    operation_id,
                    checkpoint_sha256,
                    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
                ],
            )
            .map_err(|error| CustodyError::Attestation(error.to_string()))?;
        transaction
            .commit()
            .map_err(|error| CustodyError::Attestation(error.to_string()))?;
        Ok(inserted == 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::{
        RecoveryDecisionRecordRequest, RecoveryDecisionVerifier, RuntimeSessionBindingRequest,
        Store,
    };
    use runalith_agg::custody::{AuthorityHead, CheckpointRecord, OutstandingOperations};
    use runalith_trust::{
        Ed25519PublicKey,
        trust_config::TrustConfiguration,
        trust_lifecycle::{
            ReviewerIdentity, ReviewerIdentityRepository, ReviewerStatus,
            TrustConfigurationRepository,
        },
    };
    use sha2::{Digest, Sha256};

    const TEST_REVIEWER_PUBLIC_KEY: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAPUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=\n-----END PUBLIC KEY-----\n";

    struct AcceptAuthority;

    struct AcceptRecovery;

    impl RecoveryDecisionVerifier for AcceptRecovery {
        fn verify(
            &self,
            _: &Transaction<'_>,
            _: &RecoveryDecisionRecordRequest,
        ) -> Result<(), crate::StoreError> {
            Ok(())
        }
    }

    impl AuthorityReceiptVerifier for AcceptAuthority {
        fn verify(&self, _: &CheckpointRecord) -> Result<bool, CustodyError> {
            Ok(true)
        }

        fn verify_operation(
            &self,
            request: &PrepareRequest,
            receipt: &AuthorityOperationReceipt,
        ) -> Result<bool, CustodyError> {
            Ok(request.operation_id == receipt.operation_id
                && request.request_sha256 == receipt.request_sha256)
        }

        fn verify_head(&self, _: &AuthorityHead) -> Result<bool, CustodyError> {
            Ok(true)
        }

        fn verify_outstanding(&self, _: &OutstandingOperations) -> Result<bool, CustodyError> {
            Ok(true)
        }
    }

    fn prepare_request(operation_id: &str, now_ms: i64) -> PrepareRequest {
        let mut request = PrepareRequest {
            operation_id: operation_id.into(),
            request_sha256: String::new(),
            expected_sequence: 0,
            expected_head_sha256: None,
            nonce: "ab".repeat(32),
            logical_db_id: "logical-db-test".into(),
            db_generation: 1,
            restore_epoch: 0,
            transition_sha256: "c".repeat(64),
            manifest_sha256: "d".repeat(64),
            manifest_version: 1,
            expires_at_ms: now_ms + 120_000,
        };
        let mut value = serde_json::to_value(&request).unwrap();
        value.as_object_mut().unwrap().remove("request_sha256");
        let canonical = runalith_protocol::agg_checkpoint_v2::canonicalize(&value).unwrap();
        request.request_sha256 = hex::encode(Sha256::digest(canonical.as_bytes()));
        request
    }

    #[test]
    fn nonce_is_consumed_once_across_independent_sqlite_connections() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("checkpoint.sqlite");
        let store = Store::create_new(&path).unwrap();
        let left = Arc::new(Store::open_existing(&path).unwrap());
        let right = Arc::new(Store::open_existing(&path).unwrap());
        let nonce = "ab".repeat(32);
        let checkpoint = "cd".repeat(32);

        let left_store = Arc::clone(&left);
        let left_nonce = nonce.clone();
        let left_checkpoint = checkpoint.clone();
        let first = std::thread::spawn(move || {
            left_store.consume_once(&left_nonce, "operation-1", &left_checkpoint)
        });
        let right_store = Arc::clone(&right);
        let right_nonce = nonce.clone();
        let right_checkpoint = checkpoint.clone();
        let second = std::thread::spawn(move || {
            right_store.consume_once(&right_nonce, "operation-1", &right_checkpoint)
        });
        assert_ne!(
            first.join().unwrap().unwrap(),
            second.join().unwrap().unwrap()
        );
        assert!(
            !store
                .consume_once(&nonce, "operation-1", &checkpoint)
                .unwrap()
        );
        assert!(
            !store
                .consume_once(&nonce, "operation-2", &checkpoint)
                .unwrap()
        );
        assert!(
            store
                .consume_once(&"ef".repeat(32), "operation-3", &checkpoint)
                .unwrap()
        );

        let connection = store.connection.lock().unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM agg_attestation_nonces", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 2);
        assert!(
            connection
                .execute("DELETE FROM agg_attestation_nonces", [])
                .is_err()
        );
        assert!(
            connection
                .execute(
                    "UPDATE agg_attestation_nonces SET operation_id='rewritten'",
                    [],
                )
                .is_err()
        );
    }

    #[test]
    fn malformed_nonce_and_digest_fail_closed() {
        let store = Store::in_memory().unwrap();
        assert!(
            store
                .consume_once(&"A".repeat(64), "operation", &"a".repeat(64))
                .is_err()
        );
        assert!(
            store
                .consume_once(&"a".repeat(64), "operation", &"z".repeat(64))
                .is_err()
        );
        assert!(
            store
                .consume_once(&"a".repeat(63), "operation", &"a".repeat(64))
                .is_err()
        );
    }

    #[test]
    fn schema_v11_requires_explicit_migration_to_install_nonce_ledger() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("schema-v11.sqlite");
        drop(Store::create_new(&path).unwrap());
        {
            let connection = rusqlite::Connection::open(&path).unwrap();
            crate::downgrade_schema_v20_fixture_to_v18(&connection).unwrap();
            connection
                .execute_batch(
                    "DROP TRIGGER agg_attestation_nonces_no_update;
                     DROP TRIGGER agg_attestation_nonces_no_delete;
                     DROP TABLE agg_attestation_nonces;
                     DROP TABLE workflow_result_inbox;
                     DROP TRIGGER custom_role_skill_pins_no_update;
                     DROP TRIGGER custom_role_skill_pins_no_delete;
                     DROP TABLE custom_role_trusted_skill_pins;
                     DROP TRIGGER agg_checkpoint_store_quarantine_no_update;
                     DROP TRIGGER agg_checkpoint_store_quarantine_no_delete;
                     DROP TABLE agg_checkpoint_store_quarantine;
                     DROP TRIGGER agg_checkpoint_transition_gate_fencing;
                     DROP TABLE agg_checkpoint_transition_gate;
                     DROP TRIGGER agg_checkpoint_operation_events_no_update;
                     DROP TRIGGER agg_checkpoint_operation_events_no_delete;
                     DROP TABLE agg_checkpoint_operation_events;
                     DROP TRIGGER agg_checkpoint_operations_identity_immutable;
                     DROP TRIGGER agg_checkpoint_operations_state_transition;
                     DROP TRIGGER agg_checkpoint_operations_no_delete;
                     DROP TABLE agg_checkpoint_operations;
                     DROP TABLE store_connection_probes;
                     DROP TABLE governance_decision_events;
                     DROP TABLE governance_decisions;
                     PRAGMA user_version=11;",
                )
                .unwrap();
        }
        assert!(Store::open_existing(&path).is_err());
        let migrated = Store::migrate_existing_rust_database(&path).unwrap();
        assert!(
            migrated
                .consume_once(&"ab".repeat(32), "migrated-operation", &"cd".repeat(32))
                .unwrap()
        );
    }

    #[test]
    fn schema_v15_requires_explicit_migration_to_verify_two_connection_identity() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("schema-v15.sqlite");
        drop(Store::create_new(&path).unwrap());
        let connection = rusqlite::Connection::open(&path).unwrap();
        crate::downgrade_schema_v20_fixture_to_v18(&connection).unwrap();
        connection
            .execute_batch("DROP TABLE governance_decision_events; DROP TABLE governance_decisions; DROP TABLE store_connection_probes; PRAGMA user_version=15;")
            .unwrap();
        drop(connection);

        assert!(matches!(
            Store::open_existing(&path),
            Err(crate::StoreError::SchemaVersion(15))
        ));
        let migrated = Store::migrate_existing_rust_database(&path).unwrap();
        let connection = migrated.connection.lock().unwrap();
        let probes: i64 = connection
            .query_row("SELECT COUNT(*) FROM store_connection_probes", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(probes, 0);
    }

    #[test]
    fn checkpoint_recovery_readback_rejects_denormalized_request_tampering() {
        let store = Store::in_memory().unwrap();
        let now_ms = Utc::now().timestamp_millis();
        let lease = store
            .acquire_exclusive("logical-db-test", "owner-tamper", now_ms, 60_000)
            .unwrap();
        let request = prepare_request("operation-tamper", now_ms);
        store
            .checkpoint_operation_repository(&AcceptAuthority)
            .persist_intent(&lease, &request)
            .unwrap();

        let connection = store.connection.lock().unwrap();
        connection
            .execute_batch("DROP TRIGGER agg_checkpoint_operations_identity_immutable;")
            .unwrap();
        connection
            .execute(
                "UPDATE agg_checkpoint_operations SET nonce=?1 WHERE operation_id=?2",
                params!["ff".repeat(32), request.operation_id],
            )
            .unwrap();
        drop(connection);

        assert!(
            store
                .list_checkpoint_operations("logical-db-test", false, 10)
                .is_err()
        );
    }

    #[test]
    fn checkpoint_gate_and_operation_journal_are_durable_fenced_and_releasable_after_abort() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("checkpoint-saga.sqlite");
        let store = Store::create_new(&path).unwrap();
        let now_ms = Utc::now().timestamp_millis();
        let lease = store
            .acquire_exclusive("logical-db-test", "owner-a", now_ms, 60_000)
            .unwrap();
        assert_eq!(lease.fencing_token, 1);
        assert!(
            store
                .acquire_exclusive("logical-db-test", "owner-b", now_ms + 1, 60_000)
                .is_err()
        );

        let request = prepare_request("operation-abort-1", now_ms);
        let repository = store.checkpoint_operation_repository(&AcceptAuthority);
        repository.persist_intent(&lease, &request).unwrap();
        assert_eq!(
            store
                .list_checkpoint_operations("logical-db-test", false, 10)
                .unwrap()[0]
                .state,
            "INTENT_PENDING"
        );

        let prepared = AuthorityOperationReceipt {
            operation_id: request.operation_id.clone(),
            request_sha256: request.request_sha256.clone(),
            status: AuthorityOperationStatus::Prepared,
            sequence: None,
            checkpoint_sha256: None,
            authenticator: serde_json::json!({"test_only":true}),
        };
        repository
            .record_remote_reserved(&lease, &prepared)
            .unwrap();
        let recovered = repository
            .list_operations_with_verified_authority_receipts("logical-db-test", false, 10)
            .unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].state, "REMOTE_RESERVED");
        assert_eq!(recovered[0].authority_receipt, Some(prepared.clone()));
        assert!(
            repository
                .apply_projection_and_mark_pending(
                    &lease,
                    &request.operation_id,
                    &request.request_sha256
                )
                .is_err()
        );

        let aborted = AuthorityOperationReceipt {
            status: AuthorityOperationStatus::Aborted,
            ..prepared
        };
        repository.record_aborted(&lease, &aborted).unwrap();
        store
            .release_after_terminal_state(&lease, LocalCheckpointOperationState::Aborted)
            .unwrap();
        let next = store
            .acquire_exclusive("logical-db-test", "owner-b", now_ms + 2, 60_000)
            .unwrap();
        assert_eq!(next.fencing_token, 2);

        drop(store);
        let reopened = Store::open_existing(&path).unwrap();
        let snapshots = reopened
            .list_checkpoint_operations("logical-db-test", true, 10)
            .unwrap();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].state, "ABORTED");
        assert_eq!(
            snapshots[0].authority_receipt.as_ref().unwrap().status,
            AuthorityOperationStatus::Aborted
        );
        let connection = reopened.connection.lock().unwrap();
        let events: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM agg_checkpoint_operation_events WHERE operation_id='operation-abort-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(events, 3);
    }

    #[test]
    fn expired_gate_with_unresolved_operation_fails_closed_for_crash_recovery() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("checkpoint-crash.sqlite");
        let store = Store::create_new(&path).unwrap();
        let now_ms = Utc::now().timestamp_millis();
        let lease = store
            .acquire_exclusive("logical-db-test", "owner-before-crash", now_ms, 1_000)
            .unwrap();
        let request = prepare_request("operation-crash-1", now_ms);
        store
            .checkpoint_operation_repository(&AcceptAuthority)
            .persist_intent(&lease, &request)
            .unwrap();
        drop(store);

        let reopened = Store::open_existing(&path).unwrap();
        assert!(
            reopened
                .acquire_exclusive(
                    "logical-db-test",
                    "owner-after-crash",
                    lease.expires_at_ms + 1,
                    60_000
                )
                .is_err()
        );
        assert_eq!(
            reopened
                .list_checkpoint_operations("logical-db-test", false, 10)
                .unwrap()[0]
                .state,
            "INTENT_PENDING"
        );
    }

    #[test]
    fn checkpoint_quarantine_is_durable_and_prevents_new_gate_acquisition() {
        let store = Store::in_memory().unwrap();
        let now_ms = Utc::now().timestamp_millis();
        let lease = store
            .acquire_exclusive("logical-db-test", "owner-quarantine", now_ms, 60_000)
            .unwrap();
        let other_lease = store
            .acquire_exclusive("logical-db-other", "owner-other", now_ms, 60_000)
            .unwrap();
        let request = prepare_request("operation-quarantine-1", now_ms);
        let mut other_request = prepare_request("operation-quarantine-2", now_ms);
        other_request.logical_db_id = "logical-db-other".into();
        other_request.nonce = "ef".repeat(32);
        let mut canonical_value = serde_json::to_value(&other_request).unwrap();
        canonical_value
            .as_object_mut()
            .unwrap()
            .remove("request_sha256");
        let canonical =
            runalith_protocol::agg_checkpoint_v2::canonicalize(&canonical_value).unwrap();
        other_request.request_sha256 = hex::encode(Sha256::digest(canonical.as_bytes()));
        let repository = store.checkpoint_operation_repository(&AcceptAuthority);
        repository.persist_intent(&lease, &request).unwrap();
        repository
            .persist_intent(&other_lease, &other_request)
            .unwrap();
        repository
            .quarantine_store(&lease, &request.operation_id, "authority outcome ambiguous")
            .unwrap();
        store
            .release_after_terminal_state(&lease, LocalCheckpointOperationState::Quarantined)
            .unwrap();
        assert_eq!(
            store.checkpoint_store_quarantine().unwrap(),
            Some((request.operation_id, "authority outcome ambiguous".into()))
        );
        assert!(
            store
                .acquire_exclusive("logical-db-test", "owner-next", now_ms + 1, 60_000)
                .is_err()
        );
        assert!(
            store
                .acquire_exclusive("logical-db-new", "owner-new", now_ms + 1, 60_000)
                .is_err()
        );
        assert!(
            repository
                .persist_intent(&other_lease, &other_request)
                .is_err()
        );
        let prepared = AuthorityOperationReceipt {
            operation_id: other_request.operation_id.clone(),
            request_sha256: other_request.request_sha256.clone(),
            status: AuthorityOperationStatus::Prepared,
            sequence: None,
            checkpoint_sha256: None,
            authenticator: serde_json::json!({"test_only":true}),
        };
        assert!(
            repository
                .record_remote_reserved(&other_lease, &prepared)
                .is_err()
        );
        assert!(store.renew(&other_lease, now_ms + 1, 60_000).is_err());
        let aborted = AuthorityOperationReceipt {
            status: AuthorityOperationStatus::Aborted,
            ..prepared
        };
        assert!(repository.record_aborted(&other_lease, &aborted).is_err());
        let other_snapshot = store
            .list_checkpoint_operations("logical-db-other", false, 10)
            .unwrap();
        assert_eq!(other_snapshot.len(), 1);
        assert_eq!(other_snapshot[0].state, "INTENT_PENDING");
        assert!(other_snapshot[0].authority_receipt.is_none());
        let proposal = runalith_domain::WorkflowProposal {
            workflow_id: "job_checkpoint_quarantine".into(),
            title: "Quarantine test".into(),
            goal: "Ensure writes stop after ambiguous authority outcome".into(),
            tasks: vec![runalith_domain::TaskSpec {
                task_id: "task_one".into(),
                role: "engineer".into(),
                description: "test".into(),
                depends_on: vec![],
                required_evidence: vec!["report".into()],
                inputs: Default::default(),
            }],
            metadata: Default::default(),
        };
        assert!(store.create_proposal(proposal).is_err());
        assert!(store.create_graph("graph_quarantined").is_err());
        let binding_error = store
            .record_runtime_session_binding(
                "missing-workflow",
                "missing-task",
                RuntimeSessionBindingRequest {
                    attempt: 1,
                    owner_epoch: 1,
                    lease_id: "lease".into(),
                    worker_id: "worker".into(),
                    runtime_id: "runtime".into(),
                    session_id: "session".into(),
                },
            )
            .unwrap_err();
        assert!(binding_error.to_string().contains("checkpoint-quarantined"));
        let recovery_now = Utc::now().timestamp_millis();
        let recovery_error = store
            .record_recovery_decision(
                "missing-workflow",
                "missing-task",
                RecoveryDecisionRecordRequest {
                    expected_task_state: "RUNNING".into(),
                    attempt: 1,
                    owner_epoch: 1,
                    plan_sha256: "11".repeat(32),
                    event_head_sha256: "22".repeat(32),
                    provider_intent_id: None,
                    provider_state: None,
                    session_id: None,
                    lease_id: None,
                    runtime_id: "runtime".into(),
                    runtime_generation: 1,
                    runtime_captured_at_ms: recovery_now,
                    observed_at_ms: recovery_now,
                    decision: "UNKNOWN".into(),
                    evidence_sha256: "33".repeat(32),
                },
                &AcceptRecovery,
            )
            .unwrap_err();
        assert!(
            recovery_error
                .to_string()
                .contains("checkpoint-quarantined")
        );
        assert!(
            store
                .consume_once(&"ef".repeat(32), "quarantined-operation", &"ab".repeat(32))
                .is_err()
        );
    }

    #[test]
    fn governance_trust_and_reviewer_writes_fail_closed_after_store_quarantine() {
        let store = Store::in_memory().unwrap();
        let now_ms = Utc::now().timestamp_millis();
        let lease = store
            .acquire_exclusive("logical-db-test", "owner-governance", now_ms, 60_000)
            .unwrap();
        let request = prepare_request("operation-governance-quarantine", now_ms);
        let repository = store.checkpoint_operation_repository(&AcceptAuthority);
        repository.persist_intent(&lease, &request).unwrap();
        repository
            .quarantine_store(&lease, &request.operation_id, "authority outcome ambiguous")
            .unwrap();

        let trust_config = TrustConfiguration::load_json(
            serde_json::json!({
                "schema_version":1,
                "domain":"execution_approval",
                "provider_id":"test-provider",
                "config_version":1,
                "updated_at":"2026-11-02T00:00:00.000Z",
                "updated_by":"test-admin",
                "change_reference":"CHANGE-QUARANTINE-1",
                "keys":[{
                    "key_id":"test-root",
                    "public_key_pem":TEST_REVIEWER_PUBLIC_KEY,
                    "scopes":["agg.execution.approve"],
                    "not_before":"2026-01-01T00:00:00.000Z",
                    "not_after":null,
                    "revoked_at":null
                }]
            })
            .to_string()
            .as_bytes(),
            "execution_approval",
            "agg.execution.approve",
            now_ms,
        )
        .unwrap();
        let trust_error = store
            .append_if_version("execution_approval", None, &trust_config, now_ms)
            .unwrap_err();
        assert!(trust_error.to_string().contains("checkpoint-quarantined"));

        let public_key = Ed25519PublicKey::from_pem(TEST_REVIEWER_PUBLIC_KEY).unwrap();
        let reviewer = ReviewerIdentity {
            subject: "reviewer-quarantine-test".into(),
            key_id: "reviewer-key-1".into(),
            public_key_pem: TEST_REVIEWER_PUBLIC_KEY.into(),
            public_key_sha256: public_key.fingerprint().to_owned(),
            role: "checker".into(),
            domains: std::collections::BTreeSet::from(["execution_approval".into()]),
            version: 1,
            status: ReviewerStatus::Active,
            registered_at_ms: now_ms - 1_000,
            expires_at_ms: now_ms + 60_000,
            revoked_at_ms: None,
            changed_by: "test-admin".into(),
            change_reference: "CHANGE-REVIEWER-QUARANTINE-1".into(),
        };
        let reviewer_error = store.register_reviewer(&reviewer).unwrap_err();
        assert!(
            reviewer_error
                .to_string()
                .contains("checkpoint-quarantined")
        );

        assert!(store.current("execution_approval").unwrap().is_none());
        assert!(store.current_reviewer(&reviewer.subject).unwrap().is_none());
    }
}
