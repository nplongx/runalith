//! External checkpoint custody contracts and deterministic continuity checks.
//!
//! This module never emulates an authority. A deployment must inject an
//! independently administered authority and attestation verifier. Missing or
//! incomplete authority evidence is UNKNOWN, not VERIFIED.

use std::collections::BTreeMap;
use std::io::{self, Write};

use serde::{Deserialize, Serialize};
use sha2::Digest;
use thiserror::Error;

use runalith_protocol::agg_checkpoint_v2::{canonicalize, parse_json};

const MAX_JS_SAFE_INTEGER_U64: u64 = 9_007_199_254_740_991;
const MAX_CHECKPOINT_COMPONENTS: usize = 256;
const MAX_CHECKPOINT_NONCE_BYTES: usize = 256;
const MAX_CUSTODY_ID_BYTES: usize = 256;
const MAX_CUSTODY_AUTHENTICATOR_BYTES: usize = 64 * 1024;

/// Stable authority head returned by an authenticated external custody API.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorityHead {
    /// External authority sequence.
    pub sequence: u64,
    /// Digest of the exact checkpoint at this sequence.
    pub checkpoint_sha256: String,
    /// Authority's logical database identity.
    pub logical_db_id: String,
    /// Monotonic database generation.
    pub db_generation: u64,
    /// Monotonic restore/fork epoch.
    pub restore_epoch: u64,
    /// Authenticated authority response envelope.
    pub authenticator: serde_json::Value,
}

/// Measured checkpoint component set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckpointMeasurement {
    /// Exact active logical database identity.
    pub logical_db_id: String,
    /// Database generation.
    pub db_generation: u64,
    /// Restore/fork epoch.
    pub restore_epoch: u64,
    /// Version of the normative projection manifest.
    pub manifest_version: u64,
    /// Component domain to SHA-256 digest.
    pub component_digests: BTreeMap<String, String>,
    /// Aggregate digest over the exact component set.
    pub aggregate_sha256: String,
}

/// Independently appraised attestation claims. Cryptographic appraisal is
/// performed by an injected verifier, not inferred from these fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttestationClaims {
    /// Fresh challenge nonce, lowercase hex encoding of at least 32 bytes.
    pub nonce: String,
    /// Intended relying-party audience.
    pub audience: String,
    /// Unique authority operation identity.
    pub operation_id: String,
    /// Measured database identity/generation/restore epoch.
    pub logical_db_id: String,
    /// Database generation.
    pub db_generation: u64,
    /// Restore epoch.
    pub restore_epoch: u64,
    /// Projection manifest version.
    pub manifest_version: u64,
    /// Digest of measured component set.
    pub aggregate_sha256: String,
    /// Attester identity.
    pub attester_id: String,
    /// Independent verifier identity.
    pub verifier_id: String,
    /// Appraisal policy identity and version.
    pub appraisal_policy: String,
    /// Appraisal result; only literal `pass` may be accepted.
    pub appraisal_result: String,
    /// Measurement issue and expiry times, Unix milliseconds.
    pub issued_at_ms: i64,
    /// Expiry time, Unix milliseconds.
    pub expires_at_ms: i64,
    /// Revocation state as appraised by independent verifier.
    pub revoked: bool,
}

/// Checkpoint prepared/finalized by external authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckpointRecord {
    /// Authority sequence.
    pub sequence: u64,
    /// Previous authoritative checkpoint digest; absent only for genesis.
    pub previous_sha256: Option<String>,
    /// Exact checkpoint digest.
    pub checkpoint_sha256: String,
    /// Measured component set.
    pub measurement: CheckpointMeasurement,
    /// Independently appraised claims.
    pub attestation: AttestationClaims,
    /// Signed authority receipt.
    pub authority_receipt: serde_json::Value,
}

/// Exact canonical request reserved by external authority before local mutation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrepareRequest {
    /// Stable operation ID reused unchanged during reconciliation.
    pub operation_id: String,
    /// SHA-256 of exact canonical request bytes.
    pub request_sha256: String,
    /// Expected authoritative predecessor sequence and digest.
    pub expected_sequence: u64,
    /// Expected predecessor digest; absent only for genesis.
    pub expected_head_sha256: Option<String>,
    /// Fresh challenge nonce with at least 256 bits of entropy.
    pub nonce: String,
    /// Database identity tuple.
    pub logical_db_id: String,
    /// Database generation.
    pub db_generation: u64,
    /// Restore/fork epoch.
    pub restore_epoch: u64,
    /// Exact intended transition descriptor digest.
    pub transition_sha256: String,
    /// Projection manifest digest and version.
    pub manifest_sha256: String,
    /// Projection manifest version.
    pub manifest_version: u64,
    /// Request expiry, Unix milliseconds.
    pub expires_at_ms: i64,
}

impl PrepareRequest {
    /// Validate exact JCS request bytes and all identity/digest bindings.
    pub fn validate(
        &self,
        canonical_request: &[u8],
        now_ms: i64,
    ) -> Result<(), CustodyRejectReason> {
        if !bounded_custody_identity(&self.operation_id, MAX_CUSTODY_ID_BYTES)
            || !valid_digest(&self.request_sha256)
            || !valid_digest(&self.transition_sha256)
            || !valid_digest(&self.manifest_sha256)
            || !bounded_custody_identity(&self.logical_db_id, MAX_CUSTODY_ID_BYTES)
            || self.db_generation == 0
            || self.db_generation > MAX_JS_SAFE_INTEGER_U64
            || self.expected_sequence > MAX_JS_SAFE_INTEGER_U64
            || (self.expected_sequence == 0) != self.expected_head_sha256.is_none()
            || self.restore_epoch > MAX_JS_SAFE_INTEGER_U64
            || self.manifest_version == 0
            || self.manifest_version > MAX_JS_SAFE_INTEGER_U64
            || now_ms < 0
            || now_ms as u64 > MAX_JS_SAFE_INTEGER_U64
            || self.expires_at_ms <= now_ms
            || self.expires_at_ms as u64 > MAX_JS_SAFE_INTEGER_U64
            || !valid_custody_nonce(&self.nonce)
            || self
                .expected_head_sha256
                .as_deref()
                .is_some_and(|digest| !valid_digest(digest))
        {
            return Err(CustodyRejectReason::AttestationBindingMismatch);
        }
        let parsed = parse_json(canonical_request)
            .map_err(|_| CustodyRejectReason::ProjectionDigestMismatch)?;
        let canonical =
            canonicalize(&parsed).map_err(|_| CustodyRejectReason::ProjectionDigestMismatch)?;
        if canonical.as_bytes() != canonical_request
            || hex::encode(sha2::Sha256::digest(canonical_request)) != self.request_sha256
        {
            return Err(CustodyRejectReason::ProjectionDigestMismatch);
        }
        Ok(())
    }
}

/// Durable external authority operation status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AuthorityOperationStatus {
    /// Durable reservation; public head is unchanged.
    Prepared,
    /// Exact measured state committed to authoritative head.
    Committed,
    /// Explicitly aborted under authority policy.
    Aborted,
    /// Outcome cannot be safely reconciled.
    Quarantined,
}

/// Authenticated immutable authority operation receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorityOperationReceipt {
    /// Stable operation ID.
    pub operation_id: String,
    /// Exact canonical request digest.
    pub request_sha256: String,
    /// Durable authority state.
    pub status: AuthorityOperationStatus,
    /// Authoritative sequence, when committed.
    pub sequence: Option<u64>,
    /// Authoritative checkpoint digest, when committed.
    pub checkpoint_sha256: Option<String>,
    /// Signed authority response envelope.
    pub authenticator: serde_json::Value,
}

/// Fresh challenge and relying-party context expected by local verifier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttestationContext<'a> {
    /// Freshly issued challenge nonce.
    pub nonce: &'a str,
    /// Expected relying-party audience.
    pub audience: &'a str,
    /// Expected authority operation ID.
    pub operation_id: &'a str,
}

/// All external verification dependencies for one checkpoint evaluation.
pub struct CheckpointVerificationContext<'a> {
    /// Trusted wall-clock observation.
    pub now_ms: i64,
    /// Independent platform attestation verifier.
    pub attestation_verifier: Option<&'a dyn AttestationVerifier>,
    /// External authority receipt verifier.
    pub authority_verifier: &'a dyn AuthorityReceiptVerifier,
    /// Durable nonce anti-replay ledger.
    pub nonce_ledger: Option<&'a dyn AttestationNonceLedger>,
    /// Exact challenge, audience and operation binding.
    pub expected_attestation: AttestationContext<'a>,
    /// Approved projection manifest verifier.
    pub digest_verifier: Option<&'a dyn CheckpointDigestVerifier>,
}

/// Complete, authenticated listing metadata for unresolved authority work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutstandingOperations {
    /// All nonterminal operation IDs in the stable authority snapshot.
    pub operation_ids: Vec<String>,
    /// Whether pagination/proof establishes completeness.
    pub complete: bool,
    /// Snapshot identity used across pages.
    pub snapshot_id: String,
    /// Authenticated response envelope.
    pub authenticator: serde_json::Value,
}

/// External custody API. Implementations must guarantee durable, monotonic,
/// authenticated writes and reads, plus complete stable outstanding listings.
pub trait CheckpointCustodyAuthority: Send + Sync {
    /// Durably reserve exact canonical request bytes; changed bytes under the
    /// same operation ID must be rejected.
    fn prepare(
        &self,
        request: &PrepareRequest,
        canonical_request: &[u8],
    ) -> Result<AuthorityOperationReceipt, CustodyError>;
    /// Finalize only exact prepared operation after independent appraisal.
    fn finalize(
        &self,
        operation_id: &str,
        request_sha256: &str,
        measurement: &CheckpointMeasurement,
        attestation: &AttestationClaims,
    ) -> Result<AuthorityOperationReceipt, CustodyError>;
    /// Abort only a valid prepared operation under explicit policy.
    fn abort(
        &self,
        operation_id: &str,
        request_sha256: &str,
    ) -> Result<AuthorityOperationReceipt, CustodyError>;
    /// Authenticated read-only status lookup by operation ID.
    fn operation_status(
        &self,
        operation_id: &str,
    ) -> Result<Option<AuthorityOperationReceipt>, CustodyError>;
    /// Read current authenticated authority head.
    fn head(&self) -> Result<Option<AuthorityHead>, CustodyError>;
    /// Read one immutable checkpoint by exact sequence.
    fn checkpoint(&self, sequence: u64) -> Result<Option<CheckpointRecord>, CustodyError>;
    /// Read all nonterminal operations with authenticated completeness proof.
    fn outstanding_operations(&self) -> Result<OutstandingOperations, CustodyError>;
}

/// Verifies independent attestation chain and appraisal response.
pub trait AttestationVerifier: Send + Sync {
    /// Verify cryptographic chain, policy, nonce, audience, context and claims.
    fn verify(&self, claims: &AttestationClaims) -> Result<bool, CustodyError>;
}

/// Verifies component and aggregate digests against an approved projection
/// manifest. No component inventory or digest labels are guessed here.
pub trait CheckpointDigestVerifier: Send + Sync {
    /// Verify component and aggregate-envelope digest bindings.
    fn verify_measurement(&self, measurement: &CheckpointMeasurement)
    -> Result<bool, CustodyError>;
    /// Verify exact canonical checkpoint bytes and checkpoint digest.
    fn verify_checkpoint_digest(&self, record: &CheckpointRecord) -> Result<bool, CustodyError>;
}

/// Durable anti-replay storage. Implementations must provide an atomic unique
/// insert keyed by nonce; an in-memory set does not satisfy this contract.
pub trait AttestationNonceLedger: Send + Sync {
    /// Consume nonce once, bound to operation and checkpoint digest.
    fn consume_once(
        &self,
        nonce: &str,
        operation_id: &str,
        checkpoint_sha256: &str,
    ) -> Result<bool, CustodyError>;
}

/// Verifies authority receipt authenticity and exact request/head binding.
pub trait AuthorityReceiptVerifier: Send + Sync {
    /// Verify signed authority receipt for this exact checkpoint.
    fn verify(&self, record: &CheckpointRecord) -> Result<bool, CustodyError>;
    /// Verify exact request/operation binding on any authority operation receipt.
    fn verify_operation(
        &self,
        request: &PrepareRequest,
        receipt: &AuthorityOperationReceipt,
    ) -> Result<bool, CustodyError>;
    /// Verify authenticated authority head.
    fn verify_head(&self, head: &AuthorityHead) -> Result<bool, CustodyError>;
    /// Verify completeness proof for outstanding operation listing.
    fn verify_outstanding(&self, listing: &OutstandingOperations) -> Result<bool, CustodyError>;
}

/// Durable local state for one security-projection mutation saga.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalCheckpointOperationState {
    /// Durable local intent exists; no projected mutation applied.
    IntentPending,
    /// External authority reservation confirmed.
    RemoteReserved,
    /// Projected mutation committed but not yet externally anchored.
    AnchorPending,
    /// Exact projection independently anchored.
    Anchored,
    /// Reservation safely aborted before projected mutation.
    Aborted,
    /// Ambiguous state; store-wide quarantine must block all writers/approval.
    Quarantined,
}

/// Fenced host/database transition gate lease. Process-local mutexes do not
/// satisfy this interface; implementation must survive process crashes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransitionGateLease {
    /// Logical database identity.
    pub logical_db_id: String,
    /// Unique lease owner identity.
    pub owner_id: String,
    /// Monotonic fencing token.
    pub fencing_token: u64,
    /// Lease expiry, Unix milliseconds.
    pub expires_at_ms: i64,
}

/// Durable transition gate for D-01 single-database writer serialization.
pub trait SecurityProjectionTransitionGate: Send + Sync {
    /// Acquire exclusive transition ownership below all projected writer paths.
    fn acquire_exclusive(
        &self,
        logical_db_id: &str,
        owner_id: &str,
        now_ms: i64,
        ttl_ms: i64,
    ) -> Result<TransitionGateLease, CustodyError>;
    /// Renew exact lease using fencing-token compare-and-swap.
    fn renew(
        &self,
        lease: &TransitionGateLease,
        now_ms: i64,
        ttl_ms: i64,
    ) -> Result<TransitionGateLease, CustodyError>;
    /// Release only after durable ANCHORED, safely ABORTED, or QUARANTINED state.
    fn release_after_terminal_state(
        &self,
        lease: &TransitionGateLease,
        state: LocalCheckpointOperationState,
    ) -> Result<(), CustodyError>;
}

/// Durable local checkpoint saga repository. Each transition must compare
/// expected state, fencing token, operation identity and exact request digest.
pub trait CheckpointOperationRepository: Send + Sync {
    /// Persist INTENT_PENDING before network I/O.
    fn persist_intent(
        &self,
        lease: &TransitionGateLease,
        request: &PrepareRequest,
    ) -> Result<(), CustodyError>;
    /// Persist authenticated remote reservation.
    fn record_remote_reserved(
        &self,
        lease: &TransitionGateLease,
        receipt: &AuthorityOperationReceipt,
    ) -> Result<(), CustodyError>;
    /// Persist an authenticated abort only while no projection mutation has
    /// been applied. An ANCHOR_PENDING operation must be reconciled separately.
    fn record_aborted(
        &self,
        lease: &TransitionGateLease,
        receipt: &AuthorityOperationReceipt,
    ) -> Result<(), CustodyError>;
    /// Atomically apply exact projection mutation and mark ANCHOR_PENDING.
    fn apply_projection_and_mark_pending(
        &self,
        lease: &TransitionGateLease,
        operation_id: &str,
        request_sha256: &str,
    ) -> Result<CheckpointMeasurement, CustodyError>;
    /// Persist immutable authority receipt and read back exact current projection.
    fn record_anchored_if_projection_matches(
        &self,
        lease: &TransitionGateLease,
        receipt: &AuthorityOperationReceipt,
        measurement: &CheckpointMeasurement,
    ) -> Result<(), CustodyError>;
    /// Quarantine operation and store-wide projected writers atomically.
    fn quarantine_store(
        &self,
        lease: &TransitionGateLease,
        operation_id: &str,
        reason: &str,
    ) -> Result<(), CustodyError>;
}

/// Explicit result. UNKNOWN is intentionally distinct from rejection and pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CustodyVerification {
    /// All cryptographic and continuity checks passed.
    Verified {
        /// Authority sequence.
        sequence: u64,
        /// Exact authoritative checkpoint digest.
        checkpoint_sha256: String,
    },
    /// Required authority/evidence is absent or incomplete.
    Unknown {
        /// Missing evidence or unavailable independent verifier.
        reason: CustodyUnknownReason,
    },
    /// Evidence is present but contradicts the normative contract.
    Rejected {
        /// Specific integrity or continuity violation.
        reason: CustodyRejectReason,
    },
}

/// Why verification cannot establish a trusted result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CustodyUnknownReason {
    /// No external authority head exists.
    MissingAuthorityHead,
    /// Required checkpoint was not returned.
    MissingCheckpoint,
    /// Authority unavailable or failed to authenticate.
    AuthorityUnavailable,
    /// Outstanding operation listing is incomplete.
    IncompleteOutstandingOperations,
    /// No independent attestation verifier configured.
    AttestationVerifierUnavailable,
    /// Durable anti-replay ledger is absent or unavailable.
    NonceLedgerUnavailable,
    /// Approved projection manifest/digest implementation is absent.
    ProjectionVerifierUnavailable,
}

/// Concrete integrity/continuity violations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CustodyRejectReason {
    /// Invalid sequence or predecessor link.
    BrokenContinuity,
    /// Database identity, generation, or restore epoch changed unexpectedly.
    DatabaseIdentityChanged,
    /// Projection digest set is malformed or inconsistent.
    ProjectionDigestMismatch,
    /// Attestation claim does not bind to measurement.
    AttestationBindingMismatch,
    /// Challenge nonce was reused or is not high entropy.
    ReplayOrWeakNonce,
    /// Attestation is expired, revoked, or not passing.
    AttestationNotValid,
    /// Authority receipt signature is invalid.
    InvalidAuthorityReceipt,
    /// Authority head signature is invalid.
    InvalidAuthorityHead,
    /// Outstanding-operation proof is invalid.
    InvalidOutstandingProof,
    /// Authority operation receipt does not bind to exact request.
    AuthorityOperationBindingMismatch,
}

/// Validate an authenticated authority operation receipt against exact request.
pub fn verify_operation_receipt(
    request: &PrepareRequest,
    receipt: &AuthorityOperationReceipt,
    expected_status: AuthorityOperationStatus,
    verifier: &dyn AuthorityReceiptVerifier,
) -> Result<(), CustodyRejectReason> {
    if !bounded_custody_identity(&request.operation_id, MAX_CUSTODY_ID_BYTES)
        || !valid_digest(&request.request_sha256)
        || !bounded_custody_identity(&receipt.operation_id, MAX_CUSTODY_ID_BYTES)
        || !valid_digest(&receipt.request_sha256)
        || receipt.operation_id != request.operation_id
        || receipt.request_sha256 != request.request_sha256
        || receipt.status != expected_status
        || !valid_authenticated_json(&receipt.authenticator, MAX_CUSTODY_AUTHENTICATOR_BYTES)
    {
        return Err(CustodyRejectReason::AuthorityOperationBindingMismatch);
    }
    match expected_status {
        AuthorityOperationStatus::Prepared | AuthorityOperationStatus::Aborted
            if receipt.sequence.is_some() || receipt.checkpoint_sha256.is_some() =>
        {
            return Err(CustodyRejectReason::AuthorityOperationBindingMismatch);
        }
        AuthorityOperationStatus::Committed
            if receipt
                .sequence
                .is_none_or(|sequence| sequence == 0 || sequence > MAX_JS_SAFE_INTEGER_U64)
                || receipt.sequence
                    != request
                        .expected_sequence
                        .checked_add(1)
                        .filter(|sequence| *sequence <= MAX_JS_SAFE_INTEGER_U64)
                || receipt
                    .checkpoint_sha256
                    .as_deref()
                    .is_none_or(|value| !valid_digest(value)) =>
        {
            return Err(CustodyRejectReason::AuthorityOperationBindingMismatch);
        }
        _ => {}
    }
    match verifier.verify_operation(request, receipt) {
        Ok(true) => Ok(()),
        _ => Err(CustodyRejectReason::AuthorityOperationBindingMismatch),
    }
}

/// Verify checkpoint identity, component set, attestation claims and receipt.
pub fn verify_checkpoint(
    previous: Option<&CheckpointRecord>,
    current: &CheckpointRecord,
    context: &CheckpointVerificationContext<'_>,
) -> CustodyVerification {
    let now_ms = context.now_ms;
    if !(0..=MAX_JS_SAFE_INTEGER_U64 as i64).contains(&now_ms) {
        return rejected(CustodyRejectReason::AttestationNotValid);
    }
    if current.sequence == 0
        || current.sequence > MAX_JS_SAFE_INTEGER_U64
        || !valid_digest(&current.checkpoint_sha256)
        || current
            .previous_sha256
            .as_deref()
            .is_some_and(|value| !valid_digest(value))
    {
        return rejected(CustodyRejectReason::BrokenContinuity);
    }
    if !valid_authenticated_json(&current.authority_receipt, MAX_CUSTODY_AUTHENTICATOR_BYTES) {
        return rejected(CustodyRejectReason::InvalidAuthorityReceipt);
    }
    let measurement = &current.measurement;
    if !bounded_custody_identity(&measurement.logical_db_id, MAX_CUSTODY_ID_BYTES)
        || measurement.db_generation == 0
        || measurement.db_generation > MAX_JS_SAFE_INTEGER_U64
        || measurement.restore_epoch > MAX_JS_SAFE_INTEGER_U64
        || measurement.manifest_version == 0
        || measurement.manifest_version > MAX_JS_SAFE_INTEGER_U64
        || measurement.component_digests.is_empty()
        || measurement.component_digests.len() > MAX_CHECKPOINT_COMPONENTS
        || measurement
            .component_digests
            .iter()
            .any(|(component, digest)| {
                !valid_component_identifier(component) || !valid_digest(digest)
            })
        || !valid_digest(&measurement.aggregate_sha256)
    {
        return rejected(CustodyRejectReason::ProjectionDigestMismatch);
    }
    match (
        previous,
        current.sequence,
        current.previous_sha256.as_deref(),
    ) {
        (None, 1, None) => {}
        (Some(prior), sequence, Some(previous_hash))
            if sequence == prior.sequence.saturating_add(1)
                && previous_hash == prior.checkpoint_sha256 =>
        {
            if prior.measurement.logical_db_id != current.measurement.logical_db_id
                || current.measurement.db_generation < prior.measurement.db_generation
                || current.measurement.restore_epoch < prior.measurement.restore_epoch
            {
                return rejected(CustodyRejectReason::DatabaseIdentityChanged);
            }
            if prior.attestation.nonce == current.attestation.nonce {
                return rejected(CustodyRejectReason::ReplayOrWeakNonce);
            }
        }
        _ => return rejected(CustodyRejectReason::BrokenContinuity),
    }
    if !valid_custody_nonce(&current.attestation.nonce) {
        return rejected(CustodyRejectReason::ReplayOrWeakNonce);
    }
    let Some(digest_verifier) = context.digest_verifier else {
        return CustodyVerification::Unknown {
            reason: CustodyUnknownReason::ProjectionVerifierUnavailable,
        };
    };
    match digest_verifier.verify_measurement(&current.measurement) {
        Ok(true) => {}
        Ok(false) => return rejected(CustodyRejectReason::ProjectionDigestMismatch),
        Err(_) => {
            return CustodyVerification::Unknown {
                reason: CustodyUnknownReason::ProjectionVerifierUnavailable,
            };
        }
    }
    match digest_verifier.verify_checkpoint_digest(current) {
        Ok(true) => {}
        Ok(false) => return rejected(CustodyRejectReason::ProjectionDigestMismatch),
        Err(_) => {
            return CustodyVerification::Unknown {
                reason: CustodyUnknownReason::ProjectionVerifierUnavailable,
            };
        }
    }
    let claims = &current.attestation;
    if !bounded_custody_identity(&claims.logical_db_id, MAX_CUSTODY_ID_BYTES)
        || !bounded_custody_identity(&claims.audience, MAX_CUSTODY_ID_BYTES)
        || !bounded_custody_identity(&claims.operation_id, MAX_CUSTODY_ID_BYTES)
        || !bounded_custody_identity(&claims.attester_id, MAX_CUSTODY_ID_BYTES)
        || !bounded_custody_identity(&claims.verifier_id, MAX_CUSTODY_ID_BYTES)
        || !bounded_custody_identity(&claims.appraisal_policy, MAX_CUSTODY_ID_BYTES)
        || claims.logical_db_id != current.measurement.logical_db_id
        || claims.db_generation != current.measurement.db_generation
        || claims.restore_epoch != current.measurement.restore_epoch
        || claims.manifest_version != current.measurement.manifest_version
        || claims.aggregate_sha256 != current.measurement.aggregate_sha256
        || claims.operation_id.trim().is_empty()
        || claims.audience.trim().is_empty()
        || claims.nonce != context.expected_attestation.nonce
        || claims.audience != context.expected_attestation.audience
        || claims.operation_id != context.expected_attestation.operation_id
    {
        return rejected(CustodyRejectReason::AttestationBindingMismatch);
    }
    if claims.issued_at_ms < 0
        || claims.issued_at_ms > MAX_JS_SAFE_INTEGER_U64 as i64
        || claims.expires_at_ms > MAX_JS_SAFE_INTEGER_U64 as i64
        || claims.expires_at_ms <= now_ms
        || claims.issued_at_ms > now_ms
        || claims.expires_at_ms <= claims.issued_at_ms
        || claims.revoked
        || claims.appraisal_result != "pass"
        || claims.attester_id.trim().is_empty()
        || claims.verifier_id.trim().is_empty()
        || claims.appraisal_policy.trim().is_empty()
    {
        return rejected(CustodyRejectReason::AttestationNotValid);
    }
    let Some(attestation_verifier) = context.attestation_verifier else {
        return CustodyVerification::Unknown {
            reason: CustodyUnknownReason::AttestationVerifierUnavailable,
        };
    };
    match attestation_verifier.verify(claims) {
        Ok(true) => {}
        Ok(false) => return rejected(CustodyRejectReason::AttestationNotValid),
        Err(_) => {
            return CustodyVerification::Unknown {
                reason: CustodyUnknownReason::AuthorityUnavailable,
            };
        }
    }
    match context.authority_verifier.verify(current) {
        Ok(true) => {
            let Some(nonce_ledger) = context.nonce_ledger else {
                return CustodyVerification::Unknown {
                    reason: CustodyUnknownReason::NonceLedgerUnavailable,
                };
            };
            match nonce_ledger.consume_once(
                &claims.nonce,
                &claims.operation_id,
                &current.checkpoint_sha256,
            ) {
                Ok(true) => CustodyVerification::Verified {
                    sequence: current.sequence,
                    checkpoint_sha256: current.checkpoint_sha256.clone(),
                },
                Ok(false) => rejected(CustodyRejectReason::ReplayOrWeakNonce),
                Err(_) => CustodyVerification::Unknown {
                    reason: CustodyUnknownReason::NonceLedgerUnavailable,
                },
            }
        }
        Ok(false) => rejected(CustodyRejectReason::InvalidAuthorityReceipt),
        Err(_) => CustodyVerification::Unknown {
            reason: CustodyUnknownReason::AuthorityUnavailable,
        },
    }
}

/// Verify exact checkpoint/head binding before accepting a checkpoint as the
/// current external authority state.
pub fn validate_checkpoint_matches_head(
    head: &AuthorityHead,
    checkpoint: &CheckpointRecord,
) -> Result<(), CustodyRejectReason> {
    if head.sequence != checkpoint.sequence
        || head.checkpoint_sha256 != checkpoint.checkpoint_sha256
        || head.logical_db_id != checkpoint.measurement.logical_db_id
        || head.db_generation != checkpoint.measurement.db_generation
        || head.restore_epoch != checkpoint.measurement.restore_epoch
    {
        return Err(CustodyRejectReason::BrokenContinuity);
    }
    Ok(())
}

/// Validate the fresh external head and complete outstanding-operation view.
pub fn verify_authority_continuity(
    head: Option<&AuthorityHead>,
    listing: Option<&OutstandingOperations>,
    authority_verifier: &dyn AuthorityReceiptVerifier,
) -> CustodyVerification {
    let Some(head) = head else {
        return CustodyVerification::Unknown {
            reason: CustodyUnknownReason::MissingAuthorityHead,
        };
    };
    if !valid_digest(&head.checkpoint_sha256)
        || !bounded_custody_identity(&head.logical_db_id, MAX_CUSTODY_ID_BYTES)
        || head.sequence == 0
        || head.sequence > MAX_JS_SAFE_INTEGER_U64
        || head.db_generation == 0
        || head.db_generation > MAX_JS_SAFE_INTEGER_U64
        || head.restore_epoch > MAX_JS_SAFE_INTEGER_U64
        || !valid_authenticated_json(&head.authenticator, MAX_CUSTODY_AUTHENTICATOR_BYTES)
    {
        return rejected(CustodyRejectReason::InvalidAuthorityHead);
    }
    match authority_verifier.verify_head(head) {
        Ok(true) => {}
        Ok(false) => return rejected(CustodyRejectReason::InvalidAuthorityHead),
        Err(_) => {
            return CustodyVerification::Unknown {
                reason: CustodyUnknownReason::AuthorityUnavailable,
            };
        }
    }
    let Some(listing) = listing else {
        return CustodyVerification::Unknown {
            reason: CustodyUnknownReason::IncompleteOutstandingOperations,
        };
    };
    if !listing.complete
        || !bounded_custody_identity(&listing.snapshot_id, MAX_CUSTODY_ID_BYTES)
        || listing.operation_ids.len() > 4_096
        || listing
            .operation_ids
            .iter()
            .any(|id| !bounded_custody_identity(id, MAX_CUSTODY_ID_BYTES))
        || !valid_authenticated_json(&listing.authenticator, MAX_CUSTODY_AUTHENTICATOR_BYTES)
    {
        return CustodyVerification::Unknown {
            reason: CustodyUnknownReason::IncompleteOutstandingOperations,
        };
    }
    let mut unique_operation_ids = std::collections::BTreeSet::new();
    if listing
        .operation_ids
        .iter()
        .any(|id| !unique_operation_ids.insert(id.as_str()))
    {
        return rejected(CustodyRejectReason::InvalidOutstandingProof);
    }
    match authority_verifier.verify_outstanding(listing) {
        Ok(true) => CustodyVerification::Verified {
            sequence: head.sequence,
            checkpoint_sha256: head.checkpoint_sha256.clone(),
        },
        Ok(false) => rejected(CustodyRejectReason::InvalidOutstandingProof),
        Err(_) => CustodyVerification::Unknown {
            reason: CustodyUnknownReason::AuthorityUnavailable,
        },
    }
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn bounded_custody_identity(value: &str, max_bytes: usize) -> bool {
    !value.trim().is_empty()
        && value == value.trim()
        && value.len() <= max_bytes
        && !value.chars().any(char::is_control)
}

fn valid_custody_nonce(value: &str) -> bool {
    (64..=MAX_CHECKPOINT_NONCE_BYTES).contains(&value.len())
        && value.len() & 1 == 0
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_component_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 96 || !bytes[0].is_ascii_lowercase() {
        return false;
    }
    let mut previous_was_separator = false;
    for byte in bytes.iter().copied().skip(1) {
        if byte.is_ascii_lowercase() || byte.is_ascii_digit() {
            previous_was_separator = false;
        } else if matches!(byte, b'.' | b'_' | b'-') && !previous_was_separator {
            previous_was_separator = true;
        } else {
            return false;
        }
    }
    !previous_was_separator
}

fn valid_authenticated_json(value: &serde_json::Value, max_bytes: usize) -> bool {
    if !value.is_object() || value.as_object().is_none_or(|object| object.is_empty()) {
        return false;
    }
    let mut writer = LimitedJsonWriter {
        written: 0,
        limit: max_bytes,
    };
    serde_json::to_writer(&mut writer, value).is_ok()
}

struct LimitedJsonWriter {
    written: usize,
    limit: usize,
}

impl Write for LimitedJsonWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.written) {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "serialized checkpoint authority envelope exceeds configured limit",
            ));
        }
        self.written += bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn rejected(reason: CustodyRejectReason) -> CustodyVerification {
    CustodyVerification::Rejected { reason }
}

/// Custody contract and validation failures.
#[derive(Debug, Error)]
pub enum CustodyError {
    /// Adapter transport or authenticated authority operation failed.
    #[error("external checkpoint authority unavailable: {0}")]
    Authority(String),
    /// Independent attestation verifier unavailable or failed.
    #[error("independent attestation verification unavailable: {0}")]
    Attestation(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct AcceptVerifier;
    impl AttestationVerifier for AcceptVerifier {
        fn verify(&self, _: &AttestationClaims) -> Result<bool, CustodyError> {
            Ok(true)
        }
    }
    impl CheckpointDigestVerifier for AcceptVerifier {
        fn verify_measurement(&self, _: &CheckpointMeasurement) -> Result<bool, CustodyError> {
            Ok(true)
        }
        fn verify_checkpoint_digest(&self, _: &CheckpointRecord) -> Result<bool, CustodyError> {
            Ok(true)
        }
    }
    impl AuthorityReceiptVerifier for AcceptVerifier {
        fn verify(&self, _: &CheckpointRecord) -> Result<bool, CustodyError> {
            Ok(true)
        }
        fn verify_operation(
            &self,
            _: &PrepareRequest,
            _: &AuthorityOperationReceipt,
        ) -> Result<bool, CustodyError> {
            Ok(true)
        }
        fn verify_head(&self, _: &AuthorityHead) -> Result<bool, CustodyError> {
            Ok(true)
        }
        fn verify_outstanding(&self, _: &OutstandingOperations) -> Result<bool, CustodyError> {
            Ok(true)
        }
    }
    impl AttestationNonceLedger for AcceptVerifier {
        fn consume_once(&self, _: &str, _: &str, _: &str) -> Result<bool, CustodyError> {
            Ok(true)
        }
    }
    struct ReplayedNonce;
    impl AttestationNonceLedger for ReplayedNonce {
        fn consume_once(&self, _: &str, _: &str, _: &str) -> Result<bool, CustodyError> {
            Ok(false)
        }
    }

    #[test]
    fn missing_external_authority_and_incomplete_listing_remain_unknown() {
        assert_eq!(
            verify_authority_continuity(None, None, &AcceptVerifier),
            CustodyVerification::Unknown {
                reason: CustodyUnknownReason::MissingAuthorityHead
            }
        );
        let head = AuthorityHead {
            sequence: 1,
            checkpoint_sha256: "a".repeat(64),
            logical_db_id: "db".into(),
            db_generation: 1,
            restore_epoch: 1,
            authenticator: json!({"sig":"x"}),
        };
        let listing = OutstandingOperations {
            operation_ids: vec![],
            complete: false,
            snapshot_id: "snap".into(),
            authenticator: json!({"sig":"x"}),
        };
        assert_eq!(
            verify_authority_continuity(Some(&head), Some(&listing), &AcceptVerifier),
            CustodyVerification::Unknown {
                reason: CustodyUnknownReason::IncompleteOutstandingOperations
            }
        );
    }

    #[test]
    fn authority_continuity_bounds_and_deduplicates_operation_inventory() {
        let head = AuthorityHead {
            sequence: 1,
            checkpoint_sha256: "a".repeat(64),
            logical_db_id: "db".into(),
            db_generation: 1,
            restore_epoch: 1,
            authenticator: json!({"sig":"x"}),
        };
        let oversized = OutstandingOperations {
            operation_ids: (0..=4_096).map(|index| format!("op-{index}")).collect(),
            complete: true,
            snapshot_id: "snap".into(),
            authenticator: json!({"sig":"x"}),
        };
        assert_eq!(
            verify_authority_continuity(Some(&head), Some(&oversized), &AcceptVerifier),
            CustodyVerification::Unknown {
                reason: CustodyUnknownReason::IncompleteOutstandingOperations
            }
        );

        let duplicate = OutstandingOperations {
            operation_ids: vec!["op-1".into(), "op-1".into()],
            complete: true,
            snapshot_id: "snap".into(),
            authenticator: json!({"sig":"x"}),
        };
        assert_eq!(
            verify_authority_continuity(Some(&head), Some(&duplicate), &AcceptVerifier),
            CustodyVerification::Rejected {
                reason: CustodyRejectReason::InvalidOutstandingProof
            }
        );

        let mut oversized_authenticator = head.clone();
        oversized_authenticator.authenticator =
            json!({"signature":"x".repeat(MAX_CUSTODY_AUTHENTICATOR_BYTES)});
        assert_eq!(
            verify_authority_continuity(
                Some(&oversized_authenticator),
                Some(&OutstandingOperations {
                    operation_ids: Vec::new(),
                    complete: true,
                    snapshot_id: "snap".into(),
                    authenticator: json!({"sig":"x"}),
                }),
                &AcceptVerifier
            ),
            CustodyVerification::Rejected {
                reason: CustodyRejectReason::InvalidAuthorityHead
            }
        );
    }

    #[test]
    fn prepare_requires_exact_canonical_request_bytes_and_bound_receipt() {
        let bytes = br#"{"operation_id":"op-1","transition":"trust.rotate"}"#;
        let request = PrepareRequest {
            operation_id: "op-1".into(),
            request_sha256: hex::encode(sha2::Sha256::digest(bytes)),
            expected_sequence: 0,
            expected_head_sha256: None,
            nonce: "d".repeat(64),
            logical_db_id: "db".into(),
            db_generation: 1,
            restore_epoch: 1,
            transition_sha256: "a".repeat(64),
            manifest_sha256: "b".repeat(64),
            manifest_version: 1,
            expires_at_ms: 100,
        };
        assert!(request.validate(bytes, 10).is_ok());
        let mut inconsistent_genesis = request.clone();
        inconsistent_genesis.expected_head_sha256 = Some("a".repeat(64));
        assert_eq!(
            inconsistent_genesis.validate(bytes, 10),
            Err(CustodyRejectReason::AttestationBindingMismatch)
        );
        let mut missing_predecessor_digest = request.clone();
        missing_predecessor_digest.expected_sequence = 1;
        assert_eq!(
            missing_predecessor_digest.validate(bytes, 10),
            Err(CustodyRejectReason::AttestationBindingMismatch)
        );
        assert_eq!(
            request.validate(
                br#"{ "operation_id":"op-1","transition":"trust.rotate"}"#,
                10
            ),
            Err(CustodyRejectReason::ProjectionDigestMismatch)
        );
        let receipt = AuthorityOperationReceipt {
            operation_id: "op-1".into(),
            request_sha256: request.request_sha256.clone(),
            status: AuthorityOperationStatus::Prepared,
            sequence: None,
            checkpoint_sha256: None,
            authenticator: json!({"signature":"authority"}),
        };
        verify_operation_receipt(
            &request,
            &receipt,
            AuthorityOperationStatus::Prepared,
            &AcceptVerifier,
        )
        .unwrap();

        let mut committed = receipt.clone();
        committed.status = AuthorityOperationStatus::Committed;
        committed.checkpoint_sha256 = Some("e".repeat(64));
        assert_eq!(
            verify_operation_receipt(
                &request,
                &committed,
                AuthorityOperationStatus::Committed,
                &AcceptVerifier,
            ),
            Err(CustodyRejectReason::AuthorityOperationBindingMismatch)
        );

        committed.sequence = Some(0);
        assert_eq!(
            verify_operation_receipt(
                &request,
                &committed,
                AuthorityOperationStatus::Committed,
                &AcceptVerifier,
            ),
            Err(CustodyRejectReason::AuthorityOperationBindingMismatch)
        );

        committed.sequence = Some(2);
        assert_eq!(
            verify_operation_receipt(
                &request,
                &committed,
                AuthorityOperationStatus::Committed,
                &AcceptVerifier,
            ),
            Err(CustodyRejectReason::AuthorityOperationBindingMismatch)
        );

        committed.sequence = Some(MAX_JS_SAFE_INTEGER_U64 + 1);
        assert_eq!(
            verify_operation_receipt(
                &request,
                &committed,
                AuthorityOperationStatus::Committed,
                &AcceptVerifier,
            ),
            Err(CustodyRejectReason::AuthorityOperationBindingMismatch)
        );

        let boundary_request = PrepareRequest {
            expected_sequence: MAX_JS_SAFE_INTEGER_U64 - 1,
            expected_head_sha256: Some("f".repeat(64)),
            ..request.clone()
        };
        committed.sequence = Some(MAX_JS_SAFE_INTEGER_U64);
        verify_operation_receipt(
            &boundary_request,
            &committed,
            AuthorityOperationStatus::Committed,
            &AcceptVerifier,
        )
        .unwrap();

        committed.sequence = Some(1);
        verify_operation_receipt(
            &request,
            &committed,
            AuthorityOperationStatus::Committed,
            &AcceptVerifier,
        )
        .unwrap();

        let mut altered = receipt;
        altered.request_sha256 = "f".repeat(64);
        assert_eq!(
            verify_operation_receipt(
                &request,
                &altered,
                AuthorityOperationStatus::Prepared,
                &AcceptVerifier
            ),
            Err(CustodyRejectReason::AuthorityOperationBindingMismatch)
        );
    }

    #[test]
    fn broken_predecessor_and_replayed_weak_nonce_are_rejected() {
        let mut record = sample_record();
        record.previous_sha256 = Some("f".repeat(64));
        let previous = CheckpointRecord {
            sequence: 1,
            checkpoint_sha256: "a".repeat(64),
            ..sample_record()
        };
        {
            let context = CheckpointVerificationContext {
                now_ms: 10,
                attestation_verifier: Some(&AcceptVerifier),
                authority_verifier: &AcceptVerifier,
                nonce_ledger: Some(&AcceptVerifier),
                expected_attestation: AttestationContext {
                    nonce: &record.attestation.nonce,
                    audience: "relying-party",
                    operation_id: "op_01",
                },
                digest_verifier: Some(&AcceptVerifier),
            };
            assert_eq!(
                verify_checkpoint(Some(&previous), &record, &context),
                CustodyVerification::Rejected {
                    reason: CustodyRejectReason::BrokenContinuity
                }
            );
        }
        record.sequence = 1;
        record.previous_sha256 = None;
        record.attestation.nonce = "deadbeef".into();
        let weak_nonce_context = CheckpointVerificationContext {
            expected_attestation: AttestationContext {
                nonce: &record.attestation.nonce,
                audience: "relying-party",
                operation_id: "op_01",
            },
            now_ms: 10,
            attestation_verifier: Some(&AcceptVerifier),
            authority_verifier: &AcceptVerifier,
            nonce_ledger: Some(&AcceptVerifier),
            digest_verifier: Some(&AcceptVerifier),
        };
        assert_eq!(
            verify_checkpoint(None, &record, &weak_nonce_context),
            CustodyVerification::Rejected {
                reason: CustodyRejectReason::ReplayOrWeakNonce
            }
        );
    }

    #[test]
    fn absent_projection_verifier_or_nonce_ledger_never_yields_verified() {
        let record = sample_record();
        let no_projection_verifier = CheckpointVerificationContext {
            now_ms: 10,
            attestation_verifier: Some(&AcceptVerifier),
            authority_verifier: &AcceptVerifier,
            nonce_ledger: Some(&AcceptVerifier),
            expected_attestation: AttestationContext {
                nonce: &record.attestation.nonce,
                audience: "relying-party",
                operation_id: "op_01",
            },
            digest_verifier: None,
        };
        assert_eq!(
            verify_checkpoint(None, &record, &no_projection_verifier),
            CustodyVerification::Unknown {
                reason: CustodyUnknownReason::ProjectionVerifierUnavailable,
            }
        );
        let no_nonce_ledger = CheckpointVerificationContext {
            nonce_ledger: None,
            digest_verifier: Some(&AcceptVerifier),
            ..no_projection_verifier
        };
        assert_eq!(
            verify_checkpoint(None, &record, &no_nonce_ledger),
            CustodyVerification::Unknown {
                reason: CustodyUnknownReason::NonceLedgerUnavailable,
            }
        );
    }

    #[test]
    fn exact_attestation_context_and_persistent_nonce_replay_are_enforced() {
        let record = sample_record();
        let context = CheckpointVerificationContext {
            now_ms: 10,
            attestation_verifier: Some(&AcceptVerifier),
            authority_verifier: &AcceptVerifier,
            nonce_ledger: Some(&ReplayedNonce),
            expected_attestation: AttestationContext {
                nonce: &record.attestation.nonce,
                audience: "wrong-audience",
                operation_id: "op_01",
            },
            digest_verifier: Some(&AcceptVerifier),
        };
        assert_eq!(
            verify_checkpoint(None, &record, &context),
            CustodyVerification::Rejected {
                reason: CustodyRejectReason::AttestationBindingMismatch,
            }
        );
        let replay_context = CheckpointVerificationContext {
            expected_attestation: AttestationContext {
                audience: "relying-party",
                ..context.expected_attestation.clone()
            },
            ..context
        };
        assert_eq!(
            verify_checkpoint(None, &record, &replay_context),
            CustodyVerification::Rejected {
                reason: CustodyRejectReason::ReplayOrWeakNonce,
            }
        );
    }

    #[test]
    fn checkpoint_rejects_noncanonical_component_and_attestation_identities() {
        let mut invalid_component_record = sample_record();
        invalid_component_record
            .measurement
            .component_digests
            .insert("Trust.Root".into(), "d".repeat(64));
        let component_context = CheckpointVerificationContext {
            now_ms: 10,
            attestation_verifier: Some(&AcceptVerifier),
            authority_verifier: &AcceptVerifier,
            nonce_ledger: Some(&AcceptVerifier),
            expected_attestation: AttestationContext {
                nonce: &invalid_component_record.attestation.nonce,
                audience: "relying-party",
                operation_id: "op_01",
            },
            digest_verifier: Some(&AcceptVerifier),
        };
        assert_eq!(
            verify_checkpoint(None, &invalid_component_record, &component_context),
            CustodyVerification::Rejected {
                reason: CustodyRejectReason::ProjectionDigestMismatch
            }
        );

        let mut invalid_identity_record = sample_record();
        invalid_identity_record.attestation.verifier_id = " verifier".into();
        let identity_context = CheckpointVerificationContext {
            now_ms: 10,
            attestation_verifier: Some(&AcceptVerifier),
            authority_verifier: &AcceptVerifier,
            nonce_ledger: Some(&AcceptVerifier),
            expected_attestation: AttestationContext {
                nonce: &invalid_identity_record.attestation.nonce,
                audience: "relying-party",
                operation_id: "op_01",
            },
            digest_verifier: Some(&AcceptVerifier),
        };
        assert_eq!(
            verify_checkpoint(None, &invalid_identity_record, &identity_context),
            CustodyVerification::Rejected {
                reason: CustodyRejectReason::AttestationBindingMismatch
            }
        );

        let mut invalid_nonce_record = sample_record();
        invalid_nonce_record.attestation.nonce = "C".repeat(64);
        let nonce_context = CheckpointVerificationContext {
            now_ms: 10,
            attestation_verifier: Some(&AcceptVerifier),
            authority_verifier: &AcceptVerifier,
            nonce_ledger: Some(&AcceptVerifier),
            expected_attestation: AttestationContext {
                nonce: &invalid_nonce_record.attestation.nonce,
                audience: "relying-party",
                operation_id: "op_01",
            },
            digest_verifier: Some(&AcceptVerifier),
        };
        assert_eq!(
            verify_checkpoint(None, &invalid_nonce_record, &nonce_context),
            CustodyVerification::Rejected {
                reason: CustodyRejectReason::ReplayOrWeakNonce
            }
        );

        let mut odd_length_nonce_record = sample_record();
        odd_length_nonce_record.attestation.nonce = "a".repeat(65);
        let odd_length_nonce_context = CheckpointVerificationContext {
            now_ms: 10,
            attestation_verifier: Some(&AcceptVerifier),
            authority_verifier: &AcceptVerifier,
            nonce_ledger: Some(&AcceptVerifier),
            expected_attestation: AttestationContext {
                nonce: &odd_length_nonce_record.attestation.nonce,
                audience: "relying-party",
                operation_id: "op_01",
            },
            digest_verifier: Some(&AcceptVerifier),
        };
        assert_eq!(
            verify_checkpoint(None, &odd_length_nonce_record, &odd_length_nonce_context),
            CustodyVerification::Rejected {
                reason: CustodyRejectReason::ReplayOrWeakNonce
            }
        );
    }

    fn sample_record() -> CheckpointRecord {
        let components = BTreeMap::from([("trust".to_owned(), "b".repeat(64))]);
        let measurement = CheckpointMeasurement {
            logical_db_id: "db".into(),
            db_generation: 1,
            restore_epoch: 1,
            manifest_version: 1,
            component_digests: components.clone(),
            aggregate_sha256: "c".repeat(64),
        };
        let aggregate = measurement.aggregate_sha256.clone();
        CheckpointRecord {
            sequence: 1,
            previous_sha256: None,
            checkpoint_sha256: "a".repeat(64),
            measurement: CheckpointMeasurement {
                aggregate_sha256: aggregate.clone(),
                ..measurement
            },
            attestation: AttestationClaims {
                nonce: "c".repeat(64),
                audience: "relying-party".into(),
                operation_id: "op_01".into(),
                logical_db_id: "db".into(),
                db_generation: 1,
                restore_epoch: 1,
                manifest_version: 1,
                aggregate_sha256: aggregate,
                attester_id: "attester".into(),
                verifier_id: "verifier".into(),
                appraisal_policy: "policy-v1".into(),
                appraisal_result: "pass".into(),
                issued_at_ms: 1,
                expires_at_ms: 100,
                revoked: false,
            },
            authority_receipt: json!({"signature":"external"}),
        }
    }
}
