//! Draft cross-service signature verification for Governance approval receipts.
//!
//! This is a WS6-owned verifier primitive, not a production signer or ratified
//! cross-service contract. The caller supplies trust configuration, high-water
//! observer, host-authenticated issuer/audience expectations and a durable nonce
//! port. No trust domain, issuer, audience, database or signing key is provisioned.

use chrono::{DateTime, SecondsFormat, Utc};
use runalith_protocol::governance_v1::{GovernanceApprovalReceiptV1, GovernanceApprovalRequestV1};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::TrustError;
use crate::signed_envelope::{
    map_signature_verification_error, verify_observed_signed_envelope, verify_signed_envelope,
};
use crate::trust_config::TrustConfiguration;
use crate::trust_ledger::TrustConfigurationObserver;
use crate::trust_snapshot::TrustSnapshotRefV1;

/// Draft V1 kind for an independently signed Governance approval receipt.
pub const GOVERNANCE_RECEIPT_KIND_V1: &str = "governance_approval_receipt";

/// Exact Ed25519 envelope carried in GovernanceApprovalReceiptV1.authenticator.
///
/// The signature covers canonical JSON of all fields except signature,
/// including exact receipt payload, request/subject digests, snapshot identity
/// and issuer/audience. This schema is DRAFT and requires owner ratification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GovernanceReceiptSignatureEnvelopeV1 {
    /// Signature-envelope schema version.
    pub schema_version: u32,
    /// Exact signed-envelope kind.
    pub kind: String,
    /// Signature algorithm; V1 permits Ed25519 only.
    pub signature_algorithm: String,
    /// Provider identity pinned by the administrator trust configuration.
    pub provider_id: String,
    /// Exact trust-configuration scope.
    pub scope: String,
    /// Authenticated Governance issuer identity.
    pub issuer: String,
    /// Exact Control service audience.
    pub audience: String,
    /// Key ID selected from the configured trust domain.
    pub key_id: String,
    /// Digest of the canonical six-field TrustSnapshotRefV1 object.
    pub trust_snapshot_ref_sha256: String,
    /// Canonical SPKI SHA-256 fingerprint of the signing root.
    pub trust_root_sha256: String,
    /// One-use UUID in the Governance receipt nonce domain.
    pub nonce: String,
    /// Exact receipt issuance timestamp.
    pub issued_at: String,
    /// Exact receipt expiry timestamp.
    pub expires_at: String,
    /// Digest of the complete serialized request, including its authenticator.
    pub request_sha256: String,
    /// Digest of the exact ApprovalSubjectV1 object.
    pub subject_sha256: String,
    /// Digest of the evidence envelope bound by the request and receipt.
    pub evidence_sha256: String,
    /// Digest of the policy used for the decision.
    pub policy_sha256: String,
    /// Digest of the receipt payload with authenticator excluded.
    pub receipt_payload_sha256: String,
    /// Exact receipt fields excluding authenticator.
    pub receipt_payload: Value,
    /// Standard Base64 Ed25519 signature over canonical unsigned envelope JSON.
    pub signature: String,
}

/// Host-owned signing-key port for Governance receipt envelope construction.
///
/// Implementations own private-key custody and must select only the configured
/// key ID. This crate provides no private-key implementation or provisioned
/// credential. The returned Base64 signature is immediately verified against
/// the configured public root before it is returned to the caller.
pub trait GovernanceReceiptSigningPort: Send + Sync {
    /// Sign the exact canonical unsigned envelope bytes using the named key ID.
    fn sign_ed25519(&self, key_id: &str, canonical_message: &[u8]) -> Result<String, TrustError>;
}

/// Build the signature envelope for an already evaluated exact approval receipt.
///
/// Issuer, audience, scope, trust configuration, key ID, root fingerprint,
/// nonce and signing port are supplied by the Governance host. This function
/// does not choose an authority domain, mutate trust state, persist a decision,
/// or provision a signing key. It requires the supplied trust configuration to
/// have been explicitly observed and verifies the signer's result with the
/// configured Ed25519 public root before returning the authenticator object.
#[allow(clippy::too_many_arguments)]
pub fn build_governance_receipt_authenticator_v1(
    request: &GovernanceApprovalRequestV1,
    receipt: &GovernanceApprovalReceiptV1,
    configuration: &TrustConfiguration,
    observer: &dyn TrustConfigurationObserver,
    issuer: &str,
    audience: &str,
    scope: &str,
    key_id: &str,
    trust_root_sha256: &str,
    nonce: &str,
    now_ms: i64,
    signer: &dyn GovernanceReceiptSigningPort,
) -> Result<Value, TrustError> {
    request.validate().map_err(|error| {
        rejected(
            "GOVERNANCE_RECEIPT_REQUEST_INVALID",
            format!("approval request failed schema validation: {error}"),
        )
    })?;
    if now_ms < 0 || now_ms as u64 > 9_007_199_254_740_991 {
        return Err(rejected(
            "GOVERNANCE_RECEIPT_CLOCK_INVALID",
            "signing time is outside the safe-integer range",
        ));
    }
    let now = DateTime::<Utc>::from_timestamp_millis(now_ms)
        .ok_or_else(|| {
            rejected(
                "GOVERNANCE_RECEIPT_CLOCK_INVALID",
                "signing time is invalid",
            )
        })?
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    receipt.validate_for(request, &now).map_err(|error| {
        rejected(
            "GOVERNANCE_RECEIPT_BINDING_INVALID",
            format!("receipt does not bind to exact request: {error}"),
        )
    })?;
    validate_host_identity(issuer, "issuer")?;
    validate_host_identity(audience, "audience")?;
    validate_host_identity(scope, "scope")?;
    validate_host_identity(key_id, "key_id")?;
    configuration.validate_integrity()?;
    if issuer != request.audience
        || audience != request.producer
        || issuer != configuration.provider_id
        || scope != configuration.scope
        || receipt.producer != issuer
        || receipt.audience != audience
    {
        return Err(rejected(
            "GOVERNANCE_RECEIPT_IDENTITY_UNAUTHORIZED",
            "issuer, audience, request and configured trust identities do not agree",
        ));
    }
    observer.assert_observed(configuration)?;
    let root = configuration.find_root(
        trust_root_sha256,
        Some(
            DateTime::parse_from_rfc3339(&receipt.issued_at)
                .map_err(|_| rejected("GOVERNANCE_RECEIPT_TIME_INVALID", "issued_at is invalid"))?
                .timestamp_millis(),
        ),
        now_ms,
    )?;
    if root.key_id != key_id {
        return Err(rejected(
            "GOVERNANCE_RECEIPT_SIGNER_KEY_MISMATCH",
            "requested signing key ID does not identify the selected trust root",
        ));
    }

    let snapshot_ref = TrustSnapshotRefV1::from_configuration(configuration)?;
    let request_value = serde_json::to_value(request).map_err(|error| {
        rejected(
            "GOVERNANCE_RECEIPT_CANONICALIZATION_FAILED",
            format!("request serialization failed: {error}"),
        )
    })?;
    let subject_value = serde_json::to_value(&request.subject).map_err(|error| {
        rejected(
            "GOVERNANCE_RECEIPT_CANONICALIZATION_FAILED",
            format!("subject serialization failed: {error}"),
        )
    })?;
    let receipt_value = serde_json::to_value(receipt).map_err(|error| {
        rejected(
            "GOVERNANCE_RECEIPT_CANONICALIZATION_FAILED",
            format!("receipt serialization failed: {error}"),
        )
    })?;
    let mut receipt_payload = receipt_value;
    receipt_payload
        .as_object_mut()
        .expect("typed receipt serializes as an object")
        .remove("authenticator");
    let request_sha256 = sha256(canonicalize(&request_value)?.as_bytes());
    let subject_sha256 = sha256(canonicalize(&subject_value)?.as_bytes());
    let receipt_payload_sha256 = sha256(canonicalize(&receipt_payload)?.as_bytes());

    let envelope = GovernanceReceiptSignatureEnvelopeV1 {
        schema_version: 1,
        kind: GOVERNANCE_RECEIPT_KIND_V1.to_owned(),
        signature_algorithm: "Ed25519".to_owned(),
        provider_id: configuration.provider_id.clone(),
        scope: scope.to_owned(),
        issuer: issuer.to_owned(),
        audience: audience.to_owned(),
        key_id: key_id.to_owned(),
        trust_snapshot_ref_sha256: snapshot_ref.canonical_sha256()?,
        trust_root_sha256: trust_root_sha256.to_owned(),
        nonce: nonce.to_owned(),
        issued_at: receipt.issued_at.clone(),
        expires_at: receipt.expires_at.clone(),
        request_sha256,
        subject_sha256,
        evidence_sha256: receipt.evidence_sha256.clone(),
        policy_sha256: receipt.policy_sha256.clone(),
        receipt_payload_sha256,
        receipt_payload,
        signature: String::new(),
    };
    let mut unsigned_value = serde_json::to_value(&envelope).map_err(|error| {
        rejected(
            "GOVERNANCE_RECEIPT_CANONICALIZATION_FAILED",
            format!("unsigned envelope serialization failed: {error}"),
        )
    })?;
    unsigned_value
        .as_object_mut()
        .expect("typed envelope serializes as an object")
        .remove("signature");
    let signing_bytes = canonicalize(&unsigned_value)?;
    let signature = signer.sign_ed25519(key_id, signing_bytes.as_bytes())?;
    if !root
        .public_key
        .verify_base64(signing_bytes.as_bytes(), &signature)
        .map_err(|error| {
            map_signature_verification_error(
                error,
                "GOVERNANCE_RECEIPT_SIGNATURE_INVALID",
                "signing port returned an invalid Ed25519 signature encoding",
            )
        })?
    {
        return Err(rejected(
            "GOVERNANCE_RECEIPT_SIGNATURE_INVALID",
            "signing port returned a signature that does not verify under the selected trust root",
        ));
    }
    let mut signed_envelope = envelope;
    signed_envelope.signature = signature;
    let signed_value = serde_json::to_value(signed_envelope).map_err(|error| {
        rejected(
            "GOVERNANCE_RECEIPT_CANONICALIZATION_FAILED",
            format!("signed envelope serialization failed: {error}"),
        )
    })?;
    let verified = verify_signed_envelope(
        configuration,
        &signed_value,
        scope,
        GOVERNANCE_RECEIPT_KIND_V1,
        now_ms,
    )?;
    if verified.key_id != key_id || verified.trust_root_sha256 != trust_root_sha256 {
        return Err(rejected(
            "GOVERNANCE_RECEIPT_SIGNER_KEY_MISMATCH",
            "completed signature envelope did not verify with the selected key and root",
        ));
    }
    Ok(signed_value)
}

/// Durable replay-consumption boundary for Governance approval receipts.
///
/// This nonce domain is distinct from Goal/Idea evidence verification and WS7
/// checkpoint/source-operation nonces. Implementations atomically bind nonce,
/// complete signed-envelope digest, receipt-payload digest and exact request
/// digest. They must survive restart, exact-replay idempotently and conflict on
/// any changed binding. No production adapter is supplied by this crate.
pub trait GovernanceReceiptNonceLedger: Send + Sync {
    /// Atomically consume one nonce or identify an exact replay.
    fn consume_once(
        &self,
        nonce: &str,
        signed_envelope_sha256: &str,
        receipt_payload_sha256: &str,
        request_sha256: &str,
    ) -> Result<GovernanceReceiptNonceDisposition, GovernanceReceiptNonceLedgerError>;
}

/// Successful outcome from the Governance receipt nonce port.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GovernanceReceiptNonceDisposition {
    /// First durable binding for this nonce was inserted.
    Consumed,
    /// Nonce was already bound to these exact signed bytes and request.
    ExactReplay,
}

/// Failure from the Governance receipt nonce port.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GovernanceReceiptNonceLedgerError {
    /// Durable authority was unavailable or could not commit.
    Unavailable,
    /// Nonce exists with a different signed receipt or request.
    BindingConflict,
}

/// Receipt whose issuer, audience, signature, snapshot and replay binding passed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedGovernanceApprovalReceipt {
    request_id: String,
    issuer: String,
    audience: String,
    decision_id: String,
    trust_domain: String,
    trust_config_version: u64,
    trust_snapshot_ref_sha256: String,
    trust_root_sha256: String,
    trust_key_id: String,
    nonce: String,
    issued_at_ms: i64,
    expires_at_ms: i64,
    request_sha256: String,
    receipt_payload_sha256: String,
    signed_envelope_sha256: String,
    receipt_sha256: String,
    exact_replay: bool,
}

impl VerifiedGovernanceApprovalReceipt {
    /// Exact Control request identity.
    #[must_use]
    pub fn request_id(&self) -> &str {
        &self.request_id
    }
    /// Authenticated issuer from the host-pinned expectation.
    #[must_use]
    pub fn issuer(&self) -> &str {
        &self.issuer
    }
    /// Authenticated audience from the host-pinned expectation.
    #[must_use]
    pub fn audience(&self) -> &str {
        &self.audience
    }
    /// Governance decision identity.
    #[must_use]
    pub fn decision_id(&self) -> &str {
        &self.decision_id
    }
    /// Trust domain used by the supplied configuration.
    #[must_use]
    pub fn trust_domain(&self) -> &str {
        &self.trust_domain
    }
    /// Exact administrator configuration version used for verification.
    #[must_use]
    pub const fn trust_config_version(&self) -> u64 {
        self.trust_config_version
    }
    /// Digest of the exact trust snapshot reference.
    #[must_use]
    pub fn trust_snapshot_ref_sha256(&self) -> &str {
        &self.trust_snapshot_ref_sha256
    }
    /// Configured SPKI fingerprint that verified the receipt.
    #[must_use]
    pub fn trust_root_sha256(&self) -> &str {
        &self.trust_root_sha256
    }
    /// Key ID selected from the exact administrator configuration.
    #[must_use]
    pub fn trust_key_id(&self) -> &str {
        &self.trust_key_id
    }
    /// One-use nonce in the Governance receipt nonce domain.
    #[must_use]
    pub fn nonce(&self) -> &str {
        &self.nonce
    }
    /// Signed issue time in Unix milliseconds.
    #[must_use]
    pub const fn issued_at_ms(&self) -> i64 {
        self.issued_at_ms
    }
    /// Signed expiry time in Unix milliseconds.
    #[must_use]
    pub const fn expires_at_ms(&self) -> i64 {
        self.expires_at_ms
    }
    /// SHA-256 of the complete canonical request.
    #[must_use]
    pub fn request_sha256(&self) -> &str {
        &self.request_sha256
    }
    /// SHA-256 of the receipt payload excluding the signature envelope.
    #[must_use]
    pub fn receipt_payload_sha256(&self) -> &str {
        &self.receipt_payload_sha256
    }
    /// SHA-256 of the complete canonical signed envelope.
    #[must_use]
    pub fn signed_envelope_sha256(&self) -> &str {
        &self.signed_envelope_sha256
    }
    /// SHA-256 of the complete canonical receipt including its envelope.
    #[must_use]
    pub fn receipt_sha256(&self) -> &str {
        &self.receipt_sha256
    }
    /// Whether this was an exact byte-for-byte request/receipt replay.
    #[must_use]
    pub const fn exact_replay(&self) -> bool {
        self.exact_replay
    }
}

/// Independently verify one Governance receipt without opening Governance storage.
///
/// Expected issuer, audience and scope come from host-authenticated service
/// configuration, not from the receipt. Observer proves explicit trust
/// high-water. A missing nonce adapter fails closed. This does not commit a
/// Control projection; Control still owns its transaction and ACK decision.
#[allow(clippy::too_many_arguments)]
pub fn verify_governance_approval_receipt(
    request: &GovernanceApprovalRequestV1,
    receipt: &GovernanceApprovalReceiptV1,
    configuration: &TrustConfiguration,
    observer: &dyn TrustConfigurationObserver,
    expected_issuer: &str,
    expected_audience: &str,
    expected_scope: &str,
    now_ms: i64,
    nonce_ledger: Option<&dyn GovernanceReceiptNonceLedger>,
) -> Result<VerifiedGovernanceApprovalReceipt, TrustError> {
    request.validate().map_err(|error| {
        rejected(
            "GOVERNANCE_RECEIPT_REQUEST_INVALID",
            format!("approval request failed schema validation: {error}"),
        )
    })?;
    if now_ms < 0 || now_ms as u64 > 9_007_199_254_740_991 {
        return Err(rejected(
            "GOVERNANCE_RECEIPT_CLOCK_INVALID",
            "verification time is outside the safe-integer range",
        ));
    }
    let now = DateTime::<Utc>::from_timestamp_millis(now_ms)
        .ok_or_else(|| {
            rejected(
                "GOVERNANCE_RECEIPT_CLOCK_INVALID",
                "verification time is invalid",
            )
        })?
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    receipt.validate_for(request, &now).map_err(|error| {
        rejected(
            "GOVERNANCE_RECEIPT_BINDING_INVALID",
            format!("receipt does not bind to exact request: {error}"),
        )
    })?;

    let nonce_ledger = nonce_ledger.ok_or_else(|| {
        rejected(
            "GOVERNANCE_RECEIPT_NONCE_LEDGER_UNAVAILABLE",
            "durable Governance receipt nonce authority is not configured",
        )
    })?;
    validate_host_identity(expected_issuer, "expected_issuer")?;
    validate_host_identity(expected_audience, "expected_audience")?;
    validate_host_identity(expected_scope, "expected_scope")?;
    configuration.validate_integrity()?;

    if expected_issuer != request.audience
        || expected_audience != request.producer
        || expected_scope != configuration.scope
        || configuration.provider_id != expected_issuer
        || receipt.producer != expected_issuer
        || receipt.audience != expected_audience
    {
        return Err(rejected(
            "GOVERNANCE_RECEIPT_IDENTITY_UNAUTHORIZED",
            "host-pinned issuer, audience, request and trust configuration do not agree",
        ));
    }

    let envelope: GovernanceReceiptSignatureEnvelopeV1 =
        serde_json::from_value(receipt.authenticator.clone()).map_err(|error| {
            rejected(
                "GOVERNANCE_RECEIPT_SIGNATURE_ENVELOPE_INVALID",
                format!("authenticator does not match closed V1 envelope: {error}"),
            )
        })?;
    if envelope.schema_version != 1
        || envelope.kind != GOVERNANCE_RECEIPT_KIND_V1
        || envelope.signature_algorithm != "Ed25519"
        || envelope.provider_id != configuration.provider_id
        || envelope.scope != expected_scope
        || envelope.issuer != expected_issuer
        || envelope.audience != expected_audience
        || envelope.issued_at != receipt.issued_at
        || envelope.expires_at != receipt.expires_at
        || envelope.evidence_sha256 != receipt.evidence_sha256
        || envelope.policy_sha256 != receipt.policy_sha256
    {
        return Err(rejected(
            "GOVERNANCE_RECEIPT_SIGNATURE_ENVELOPE_INVALID",
            "algorithm, kind, issuer, audience, scope or receipt timestamps are misbound",
        ));
    }

    let snapshot_ref = TrustSnapshotRefV1::from_configuration(configuration)?;
    let snapshot_digest = snapshot_ref.canonical_sha256()?;
    if envelope.trust_snapshot_ref_sha256 != snapshot_digest {
        return Err(rejected(
            "GOVERNANCE_RECEIPT_TRUST_SNAPSHOT_MISMATCH",
            "envelope does not identify the exact supplied trust configuration snapshot",
        ));
    }

    let receipt_value = serde_json::to_value(receipt).map_err(|error| {
        rejected(
            "GOVERNANCE_RECEIPT_CANONICALIZATION_FAILED",
            format!("receipt serialization failed: {error}"),
        )
    })?;
    let mut expected_payload = receipt_value.clone();
    expected_payload
        .as_object_mut()
        .expect("typed receipt is an object")
        .remove("authenticator");
    if envelope.receipt_payload != expected_payload {
        return Err(rejected(
            "GOVERNANCE_RECEIPT_PAYLOAD_MISMATCH",
            "signed payload differs from exact receipt fields excluding authenticator",
        ));
    }

    let receipt_payload_sha256 = sha256(canonicalize(&envelope.receipt_payload)?.as_bytes());
    let request_value = serde_json::to_value(request).map_err(|error| {
        rejected(
            "GOVERNANCE_RECEIPT_CANONICALIZATION_FAILED",
            format!("request serialization failed: {error}"),
        )
    })?;
    let request_sha256 = sha256(canonicalize(&request_value)?.as_bytes());
    let subject_value = serde_json::to_value(&request.subject).map_err(|error| {
        rejected(
            "GOVERNANCE_RECEIPT_CANONICALIZATION_FAILED",
            format!("subject serialization failed: {error}"),
        )
    })?;
    let subject_sha256 = sha256(canonicalize(&subject_value)?.as_bytes());

    if envelope.request_sha256 != request_sha256
        || envelope.subject_sha256 != subject_sha256
        || envelope.receipt_payload_sha256 != receipt_payload_sha256
    {
        return Err(rejected(
            "GOVERNANCE_RECEIPT_DIGEST_MISMATCH",
            "request, subject or receipt-payload digest differs from canonical bytes",
        ));
    }

    let envelope_value = serde_json::to_value(&envelope).map_err(|error| {
        rejected(
            "GOVERNANCE_RECEIPT_CANONICALIZATION_FAILED",
            format!("signature envelope serialization failed: {error}"),
        )
    })?;
    let verified = verify_observed_signed_envelope(
        configuration,
        observer,
        &envelope_value,
        expected_scope,
        GOVERNANCE_RECEIPT_KIND_V1,
        now_ms,
    )?;
    if verified.key_id != envelope.key_id
        || verified.trust_root_sha256 != envelope.trust_root_sha256
        || verified.nonce != envelope.nonce
    {
        return Err(rejected(
            "GOVERNANCE_RECEIPT_SIGNATURE_BINDING_MISMATCH",
            "verified key, trust root or nonce differs from closed envelope",
        ));
    }

    let signed_envelope_sha256 = sha256(canonicalize(&envelope_value)?.as_bytes());
    if signed_envelope_sha256 != verified.signed_envelope_hash {
        return Err(rejected(
            "GOVERNANCE_RECEIPT_SIGNATURE_DIGEST_MISMATCH",
            "canonical signed-envelope digest differs from verified digest",
        ));
    }
    let receipt_sha256 = sha256(canonicalize(&receipt_value)?.as_bytes());
    let disposition = nonce_ledger
        .consume_once(
            &envelope.nonce,
            &signed_envelope_sha256,
            &receipt_payload_sha256,
            &request_sha256,
        )
        .map_err(|error| match error {
            GovernanceReceiptNonceLedgerError::Unavailable => rejected(
                "GOVERNANCE_RECEIPT_NONCE_LEDGER_UNAVAILABLE",
                "durable Governance receipt nonce authority is unavailable",
            ),
            GovernanceReceiptNonceLedgerError::BindingConflict => rejected(
                "GOVERNANCE_RECEIPT_NONCE_CONFLICT",
                "nonce is already bound to different signed bytes or request",
            ),
        })?;

    let issued_at_ms = DateTime::parse_from_rfc3339(&envelope.issued_at)
        .map_err(|_| rejected("GOVERNANCE_RECEIPT_TIME_INVALID", "issued_at is invalid"))?
        .timestamp_millis();
    let expires_at_ms = DateTime::parse_from_rfc3339(&envelope.expires_at)
        .map_err(|_| rejected("GOVERNANCE_RECEIPT_TIME_INVALID", "expires_at is invalid"))?
        .timestamp_millis();

    Ok(VerifiedGovernanceApprovalReceipt {
        request_id: receipt.request_id.clone(),
        issuer: envelope.issuer,
        audience: envelope.audience,
        decision_id: receipt.decision_id.clone(),
        trust_domain: configuration.domain.clone(),
        trust_config_version: configuration.config_version,
        trust_snapshot_ref_sha256: snapshot_digest,
        trust_root_sha256: verified.trust_root_sha256,
        trust_key_id: verified.key_id,
        nonce: verified.nonce,
        issued_at_ms,
        expires_at_ms,
        request_sha256,
        receipt_payload_sha256,
        signed_envelope_sha256,
        receipt_sha256,
        exact_replay: disposition == GovernanceReceiptNonceDisposition::ExactReplay,
    })
}

fn canonicalize(value: &Value) -> Result<String, TrustError> {
    runalith_protocol::agg_checkpoint_v2::canonicalize(value).map_err(|error| {
        rejected(
            "GOVERNANCE_RECEIPT_CANONICALIZATION_FAILED",
            format!("canonical JSON rejected receipt data: {error}"),
        )
    })
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn validate_host_identity(value: &str, field: &'static str) -> Result<(), TrustError> {
    if value.trim().is_empty()
        || value != value.trim()
        || value.len() > 256
        || value.chars().any(char::is_control)
    {
        return Err(rejected(
            "GOVERNANCE_RECEIPT_IDENTITY_UNAUTHORIZED",
            format!("host-pinned {field} must be a trimmed bounded identity"),
        ));
    }
    Ok(())
}

fn rejected(code: &'static str, message: impl Into<String>) -> TrustError {
    TrustError::rejected(code, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    use rusqlite::{Connection, OptionalExtension, TransactionBehavior};

    use crate::trust_ledger::TrustLedger;

    const ISSUER: &str = "governance-service-test";
    const AUDIENCE: &str = "workflow-control-test";
    const SCOPE: &str = "agg.execution.approve";

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct Binding {
        envelope: String,
        payload: String,
        request: String,
    }

    #[derive(Default)]
    struct MemoryNonceLedger {
        rows: Mutex<BTreeMap<String, Binding>>,
    }

    impl GovernanceReceiptNonceLedger for MemoryNonceLedger {
        fn consume_once(
            &self,
            nonce: &str,
            envelope: &str,
            payload: &str,
            request: &str,
        ) -> Result<GovernanceReceiptNonceDisposition, GovernanceReceiptNonceLedgerError> {
            let binding = Binding {
                envelope: envelope.to_owned(),
                payload: payload.to_owned(),
                request: request.to_owned(),
            };
            let mut rows = self
                .rows
                .lock()
                .map_err(|_| GovernanceReceiptNonceLedgerError::Unavailable)?;
            match rows.get(nonce) {
                None => {
                    rows.insert(nonce.to_owned(), binding);
                    Ok(GovernanceReceiptNonceDisposition::Consumed)
                }
                Some(existing) if existing == &binding => {
                    Ok(GovernanceReceiptNonceDisposition::ExactReplay)
                }
                Some(_) => Err(GovernanceReceiptNonceLedgerError::BindingConflict),
            }
        }
    }

    /// Test-only durable adapter used to exercise the port across independent
    /// SQLite connections and adapter reconstruction. This is not a production
    /// schema, migration, database ownership decision or deployable adapter.
    struct SqliteTestNonceLedger {
        path: PathBuf,
    }

    impl SqliteTestNonceLedger {
        fn create(path: PathBuf) -> Self {
            let connection = Connection::open(&path).unwrap();
            connection.busy_timeout(Duration::from_secs(5)).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE IF NOT EXISTS ws6_test_receipt_nonces (
                        nonce TEXT PRIMARY KEY NOT NULL,
                        signed_envelope_sha256 TEXT NOT NULL,
                        receipt_payload_sha256 TEXT NOT NULL,
                        request_sha256 TEXT NOT NULL
                    ) STRICT;",
                )
                .unwrap();
            drop(connection);
            Self { path }
        }
    }

    impl GovernanceReceiptNonceLedger for SqliteTestNonceLedger {
        fn consume_once(
            &self,
            nonce: &str,
            signed_envelope_sha256: &str,
            receipt_payload_sha256: &str,
            request_sha256: &str,
        ) -> Result<GovernanceReceiptNonceDisposition, GovernanceReceiptNonceLedgerError> {
            let mut connection = Connection::open(&self.path)
                .map_err(|_| GovernanceReceiptNonceLedgerError::Unavailable)?;
            connection
                .busy_timeout(Duration::from_secs(5))
                .map_err(|_| GovernanceReceiptNonceLedgerError::Unavailable)?;
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| GovernanceReceiptNonceLedgerError::Unavailable)?;
            let existing = transaction
                .query_row(
                    "SELECT signed_envelope_sha256, receipt_payload_sha256, request_sha256
                     FROM ws6_test_receipt_nonces WHERE nonce = ?1",
                    [nonce],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()
                .map_err(|_| GovernanceReceiptNonceLedgerError::Unavailable)?;

            let disposition = match existing {
                None => {
                    transaction
                        .execute(
                            "INSERT INTO ws6_test_receipt_nonces
                             (nonce, signed_envelope_sha256, receipt_payload_sha256, request_sha256)
                             VALUES (?1, ?2, ?3, ?4)",
                            rusqlite::params![
                                nonce,
                                signed_envelope_sha256,
                                receipt_payload_sha256,
                                request_sha256
                            ],
                        )
                        .map_err(|_| GovernanceReceiptNonceLedgerError::Unavailable)?;
                    GovernanceReceiptNonceDisposition::Consumed
                }
                Some((existing_envelope, existing_payload, existing_request))
                    if existing_envelope == signed_envelope_sha256
                        && existing_payload == receipt_payload_sha256
                        && existing_request == request_sha256 =>
                {
                    GovernanceReceiptNonceDisposition::ExactReplay
                }
                Some(_) => {
                    return Err(GovernanceReceiptNonceLedgerError::BindingConflict);
                }
            };
            transaction
                .commit()
                .map_err(|_| GovernanceReceiptNonceLedgerError::Unavailable)?;
            Ok(disposition)
        }
    }

    struct UnavailableNonceLedger;
    impl GovernanceReceiptNonceLedger for UnavailableNonceLedger {
        fn consume_once(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: &str,
        ) -> Result<GovernanceReceiptNonceDisposition, GovernanceReceiptNonceLedgerError> {
            Err(GovernanceReceiptNonceLedgerError::Unavailable)
        }
    }

    struct FixtureSigner {
        signature: String,
    }

    impl GovernanceReceiptSigningPort for FixtureSigner {
        fn sign_ed25519(&self, key_id: &str, _: &[u8]) -> Result<String, TrustError> {
            if key_id != "governance-test-key" {
                return Err(TrustError::rejected(
                    "GOVERNANCE_RECEIPT_SIGNER_KEY_MISMATCH",
                    "fixture signer received an unexpected key ID",
                ));
            }
            Ok(self.signature.clone())
        }
    }

    struct Fixtures {
        config: TrustConfiguration,
        request: GovernanceApprovalRequestV1,
        receipt: GovernanceApprovalReceiptV1,
        changed_request: GovernanceApprovalRequestV1,
        changed_receipt: GovernanceApprovalReceiptV1,
        now_ms: i64,
    }

    fn fixtures() -> Fixtures {
        let data: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/governance-approval-receipt-v1-node.json"
        ))
        .unwrap();
        let now_ms = data["now_ms"].as_i64().unwrap();
        let config = TrustConfiguration::load_json(
            data["trust_config_json"].as_str().unwrap().as_bytes(),
            "execution_approval",
            SCOPE,
            now_ms,
        )
        .unwrap();
        let primary = &data["primary"];
        let changed = &data["changed_binding_same_nonce"];
        Fixtures {
            config,
            request: serde_json::from_str(primary["request_json"].as_str().unwrap()).unwrap(),
            receipt: serde_json::from_str(primary["receipt_json"].as_str().unwrap()).unwrap(),
            changed_request: serde_json::from_str(changed["request_json"].as_str().unwrap())
                .unwrap(),
            changed_receipt: serde_json::from_str(changed["receipt_json"].as_str().unwrap())
                .unwrap(),
            now_ms,
        }
    }

    fn observer(config: &TrustConfiguration, now_ms: i64) -> TrustLedger {
        let ledger = TrustLedger::in_memory().unwrap();
        ledger.record(config, now_ms).unwrap();
        ledger
    }

    fn verify(
        f: &Fixtures,
        request: &GovernanceApprovalRequestV1,
        receipt: &GovernanceApprovalReceiptV1,
        observer: &dyn TrustConfigurationObserver,
        nonce: Option<&dyn GovernanceReceiptNonceLedger>,
    ) -> Result<VerifiedGovernanceApprovalReceipt, TrustError> {
        verify_governance_approval_receipt(
            request, receipt, &f.config, observer, ISSUER, AUDIENCE, SCOPE, f.now_ms, nonce,
        )
    }

    #[test]
    fn node_golden_receipt_verifies_issuer_audience_subject_policy_snapshot_and_key() {
        let f = fixtures();
        let observed = observer(&f.config, f.now_ms);
        let nonce = MemoryNonceLedger::default();
        let verified = verify(&f, &f.request, &f.receipt, &observed, Some(&nonce)).unwrap();

        assert_eq!(verified.request_id(), f.request.request_id);
        assert_eq!(verified.issuer(), ISSUER);
        assert_eq!(verified.audience(), AUDIENCE);
        assert_eq!(verified.decision_id(), f.receipt.decision_id);
        assert_eq!(verified.trust_domain(), "execution_approval");
        assert_eq!(verified.trust_config_version(), 1);
        assert_eq!(verified.trust_key_id(), "governance-test-key");
        assert_eq!(
            verified.trust_root_sha256(),
            "90490a2e6735a32667c99779573e102d8d1129cbea8142a73263ebb27bac64be"
        );
        assert_eq!(verified.nonce(), "b17f4af2-2a66-4d4d-8ea1-445566778899");
        assert!(!verified.exact_replay());
    }

    #[test]
    fn signer_port_builder_reproduces_node_envelope_and_rejects_bad_signatures() {
        let f = fixtures();
        let observed = observer(&f.config, f.now_ms);
        let data: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/governance-approval-receipt-v1-node.json"
        ))
        .unwrap();
        let signature = data["primary"]["signature_base64"]
            .as_str()
            .unwrap()
            .to_owned();
        let root = &f.config.roots[0];

        let generated = build_governance_receipt_authenticator_v1(
            &f.request,
            &f.receipt,
            &f.config,
            &observed,
            ISSUER,
            AUDIENCE,
            SCOPE,
            "governance-test-key",
            &root.trust_root_sha256,
            "b17f4af2-2a66-4d4d-8ea1-445566778899",
            f.now_ms,
            &FixtureSigner { signature },
        )
        .unwrap();
        assert_eq!(generated, f.receipt.authenticator);

        let error = build_governance_receipt_authenticator_v1(
            &f.request,
            &f.receipt,
            &f.config,
            &observed,
            ISSUER,
            AUDIENCE,
            SCOPE,
            "governance-test-key",
            &root.trust_root_sha256,
            "b17f4af2-2a66-4d4d-8ea1-445566778899",
            f.now_ms,
            &FixtureSigner {
                signature: "A".repeat(88),
            },
        )
        .unwrap_err();
        assert_eq!(error.code(), "GOVERNANCE_RECEIPT_SIGNATURE_INVALID");
    }

    #[test]
    fn exact_replay_is_idempotent_and_changed_request_same_nonce_conflicts() {
        let f = fixtures();
        let observed = observer(&f.config, f.now_ms);
        let nonce = MemoryNonceLedger::default();
        assert!(
            !verify(&f, &f.request, &f.receipt, &observed, Some(&nonce))
                .unwrap()
                .exact_replay()
        );
        assert!(
            verify(&f, &f.request, &f.receipt, &observed, Some(&nonce))
                .unwrap()
                .exact_replay()
        );
        assert_eq!(
            verify(
                &f,
                &f.changed_request,
                &f.changed_receipt,
                &observed,
                Some(&nonce)
            )
            .unwrap_err()
            .code(),
            "GOVERNANCE_RECEIPT_NONCE_CONFLICT"
        );
    }

    #[test]
    fn tampered_subject_audience_snapshot_or_signature_fails_closed() {
        let f = fixtures();
        let observed = observer(&f.config, f.now_ms);
        let nonce = MemoryNonceLedger::default();

        let mut changed = f.receipt.clone();
        changed.subject.plan_sha256 = "9".repeat(64);
        assert_eq!(
            verify(&f, &f.request, &changed, &observed, Some(&nonce))
                .unwrap_err()
                .code(),
            "GOVERNANCE_RECEIPT_BINDING_INVALID"
        );

        let mut changed = f.receipt.clone();
        changed.authenticator["audience"] = Value::String("attacker".into());
        assert_eq!(
            verify(&f, &f.request, &changed, &observed, Some(&nonce))
                .unwrap_err()
                .code(),
            "GOVERNANCE_RECEIPT_SIGNATURE_ENVELOPE_INVALID"
        );

        let mut changed = f.receipt.clone();
        changed.authenticator["trust_snapshot_ref_sha256"] = Value::String("0".repeat(64));
        assert_eq!(
            verify(&f, &f.request, &changed, &observed, Some(&nonce))
                .unwrap_err()
                .code(),
            "GOVERNANCE_RECEIPT_TRUST_SNAPSHOT_MISMATCH"
        );

        let mut changed = f.receipt.clone();
        changed.authenticator["signature"] = Value::String("A".repeat(88));
        assert_eq!(
            verify(&f, &f.request, &changed, &observed, Some(&nonce))
                .unwrap_err()
                .code(),
            "AGG_APPROVAL_SIGNATURE_INVALID"
        );
    }

    #[test]
    fn missing_or_unavailable_nonce_authority_fails_closed() {
        let f = fixtures();
        let observed = observer(&f.config, f.now_ms);
        assert_eq!(
            verify(&f, &f.request, &f.receipt, &observed, None)
                .unwrap_err()
                .code(),
            "GOVERNANCE_RECEIPT_NONCE_LEDGER_UNAVAILABLE"
        );
        assert_eq!(
            verify(
                &f,
                &f.request,
                &f.receipt,
                &observed,
                Some(&UnavailableNonceLedger)
            )
            .unwrap_err()
            .code(),
            "GOVERNANCE_RECEIPT_NONCE_LEDGER_UNAVAILABLE"
        );
    }

    #[test]
    fn missing_high_water_observation_and_wrong_host_identities_fail_closed() {
        let f = fixtures();
        let unobserved = TrustLedger::in_memory().unwrap();
        assert_eq!(
            verify(
                &f,
                &f.request,
                &f.receipt,
                &unobserved,
                Some(&MemoryNonceLedger::default())
            )
            .unwrap_err()
            .code(),
            "AGG_TRUST_CONFIG_NOT_OBSERVED"
        );

        let observed = observer(&f.config, f.now_ms);
        assert_eq!(
            verify_governance_approval_receipt(
                &f.request,
                &f.receipt,
                &f.config,
                &observed,
                "untrusted-issuer",
                AUDIENCE,
                SCOPE,
                f.now_ms,
                Some(&MemoryNonceLedger::default()),
            )
            .unwrap_err()
            .code(),
            "GOVERNANCE_RECEIPT_IDENTITY_UNAUTHORIZED"
        );
        assert_eq!(
            verify_governance_approval_receipt(
                &f.request,
                &f.receipt,
                &f.config,
                &observed,
                ISSUER,
                "untrusted-audience",
                SCOPE,
                f.now_ms,
                Some(&MemoryNonceLedger::default()),
            )
            .unwrap_err()
            .code(),
            "GOVERNANCE_RECEIPT_IDENTITY_UNAUTHORIZED"
        );
    }

    #[test]
    fn receipt_verification_rejects_revoked_or_expired_roots_and_stale_high_water() {
        let f = fixtures();
        let data: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/governance-approval-receipt-v1-node.json"
        ))
        .unwrap();

        // A signed receipt remains invalid after the exact configured root is
        // revoked, even when the caller supplies an otherwise matching snapshot
        // reference and records that revocation as the observed high-water.
        let mut revoked_json: Value =
            serde_json::from_str(data["trust_config_json"].as_str().unwrap()).unwrap();
        revoked_json["keys"][0]["revoked_at"] = Value::String("2026-11-03T12:01:30.000Z".into());
        let revoked_config = TrustConfiguration::load_json(
            serde_json::to_string(&revoked_json).unwrap().as_bytes(),
            "execution_approval",
            SCOPE,
            f.now_ms,
        )
        .unwrap();
        assert!(!revoked_config.available);
        let revoked_observer = observer(&revoked_config, f.now_ms);
        let mut revoked_receipt = f.receipt.clone();
        revoked_receipt.authenticator["trust_snapshot_ref_sha256"] = Value::String(
            TrustSnapshotRefV1::from_configuration(&revoked_config)
                .unwrap()
                .canonical_sha256()
                .unwrap(),
        );
        assert_eq!(
            verify_governance_approval_receipt(
                &f.request,
                &revoked_receipt,
                &revoked_config,
                &revoked_observer,
                ISSUER,
                AUDIENCE,
                SCOPE,
                f.now_ms,
                Some(&MemoryNonceLedger::default()),
            )
            .unwrap_err()
            .code(),
            "AGG_TRUST_ROOT_REVOKED"
        );

        // A key whose validity ended after the original signing time is still
        // unusable now. The snapshot reference matches this exact expired-key
        // configuration so the rejection specifically exercises key validity.
        let mut expired_json: Value =
            serde_json::from_str(data["trust_config_json"].as_str().unwrap()).unwrap();
        expired_json["keys"][0]["not_after"] = Value::String("2026-11-03T12:01:30.000Z".into());
        let expired_config = TrustConfiguration::load_json(
            serde_json::to_string(&expired_json).unwrap().as_bytes(),
            "execution_approval",
            SCOPE,
            f.now_ms,
        )
        .unwrap();
        assert!(!expired_config.available);
        let expired_observer = observer(&expired_config, f.now_ms);
        let mut expired_receipt = f.receipt.clone();
        expired_receipt.authenticator["trust_snapshot_ref_sha256"] = Value::String(
            TrustSnapshotRefV1::from_configuration(&expired_config)
                .unwrap()
                .canonical_sha256()
                .unwrap(),
        );
        assert_eq!(
            verify_governance_approval_receipt(
                &f.request,
                &expired_receipt,
                &expired_config,
                &expired_observer,
                ISSUER,
                AUDIENCE,
                SCOPE,
                f.now_ms,
                Some(&MemoryNonceLedger::default()),
            )
            .unwrap_err()
            .code(),
            "AGG_TRUST_ROOT_OUTSIDE_VALIDITY"
        );

        // Even a correctly signed prior snapshot is rejected after a newer
        // administrator configuration has advanced the observed high-water.
        let mut newer_json: Value =
            serde_json::from_str(data["trust_config_json"].as_str().unwrap()).unwrap();
        newer_json["config_version"] = Value::from(2);
        newer_json["updated_at"] = Value::String("2026-11-03T12:01:00.000Z".into());
        let newer_config = TrustConfiguration::load_json(
            serde_json::to_string(&newer_json).unwrap().as_bytes(),
            "execution_approval",
            SCOPE,
            f.now_ms,
        )
        .unwrap();
        let high_water = TrustLedger::in_memory().unwrap();
        high_water.record(&f.config, f.now_ms).unwrap();
        high_water.record(&newer_config, f.now_ms).unwrap();
        assert_eq!(
            verify(
                &f,
                &f.request,
                &f.receipt,
                &high_water,
                Some(&MemoryNonceLedger::default()),
            )
            .unwrap_err()
            .code(),
            "AGG_TRUST_CONFIG_ROLLBACK"
        );
    }

    #[test]
    fn receipt_time_window_rejects_future_issuance_and_expiry_boundary() {
        let f = fixtures();
        let observed = observer(&f.config, f.now_ms);
        let nonce = MemoryNonceLedger::default();
        let before_issue_ms = DateTime::parse_from_rfc3339("2026-11-03T12:00:30.000Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(
            verify_governance_approval_receipt(
                &f.request,
                &f.receipt,
                &f.config,
                &observed,
                ISSUER,
                AUDIENCE,
                SCOPE,
                before_issue_ms,
                Some(&nonce),
            )
            .unwrap_err()
            .code(),
            "GOVERNANCE_RECEIPT_BINDING_INVALID"
        );

        let at_expiry_ms = DateTime::parse_from_rfc3339("2026-11-03T12:04:00.000Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(
            verify_governance_approval_receipt(
                &f.request,
                &f.receipt,
                &f.config,
                &observed,
                ISSUER,
                AUDIENCE,
                SCOPE,
                at_expiry_ms,
                Some(&nonce),
            )
            .unwrap_err()
            .code(),
            "GOVERNANCE_RECEIPT_BINDING_INVALID"
        );
    }

    #[test]
    fn nonce_port_serializes_concurrent_exact_replays_and_rejects_rebinding() {
        let ledger = Arc::new(MemoryNonceLedger::default());
        let mut threads = Vec::new();
        for _ in 0..16 {
            let ledger = Arc::clone(&ledger);
            threads.push(thread::spawn(move || {
                ledger
                    .consume_once("nonce-1", "envelope-1", "payload-1", "request-1")
                    .unwrap()
            }));
        }
        let outcomes = threads
            .into_iter()
            .map(|t| t.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            outcomes
                .iter()
                .filter(|x| **x == GovernanceReceiptNonceDisposition::Consumed)
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|x| **x == GovernanceReceiptNonceDisposition::ExactReplay)
                .count(),
            15
        );
        assert_eq!(
            ledger
                .consume_once("nonce-1", "envelope-2", "payload-2", "request-2")
                .unwrap_err(),
            GovernanceReceiptNonceLedgerError::BindingConflict
        );
    }

    #[test]
    fn sqlite_test_nonce_adapter_serializes_independent_connections_and_survives_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("ws6-receipt-nonce-test.sqlite");
        let ledger = Arc::new(SqliteTestNonceLedger::create(database.clone()));
        let mut threads = Vec::new();
        for _ in 0..16 {
            let ledger = Arc::clone(&ledger);
            threads.push(thread::spawn(move || {
                ledger
                    .consume_once("durable-nonce", "signed-1", "payload-1", "request-1")
                    .unwrap()
            }));
        }
        let outcomes = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| **outcome == GovernanceReceiptNonceDisposition::Consumed)
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| **outcome == GovernanceReceiptNonceDisposition::ExactReplay)
                .count(),
            15
        );

        // Reconstruct a new adapter over the same file to model process restart.
        let reopened = SqliteTestNonceLedger::create(database);
        assert_eq!(
            reopened
                .consume_once("durable-nonce", "signed-1", "payload-1", "request-1")
                .unwrap(),
            GovernanceReceiptNonceDisposition::ExactReplay
        );
        assert_eq!(
            reopened
                .consume_once("durable-nonce", "signed-2", "payload-2", "request-2")
                .unwrap_err(),
            GovernanceReceiptNonceLedgerError::BindingConflict
        );
    }

    #[test]
    fn sqlite_nonce_child_process_entrypoint() {
        let Ok(database) = std::env::var("WS6_TEST_RECEIPT_NONCE_DB") else {
            return;
        };
        let ledger = SqliteTestNonceLedger {
            path: PathBuf::from(database),
        };
        match ledger
            .consume_once(
                "cross-process-nonce",
                "signed-cross-process",
                "payload-cross-process",
                "request-cross-process",
            )
            .unwrap()
        {
            GovernanceReceiptNonceDisposition::Consumed => println!("WS6_NONCE_RESULT=Consumed"),
            GovernanceReceiptNonceDisposition::ExactReplay => {
                println!("WS6_NONCE_RESULT=ExactReplay")
            }
        }
    }

    #[test]
    fn sqlite_nonce_replay_and_conflict_are_atomic_across_os_processes() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory
            .path()
            .join("ws6-cross-process-receipt-nonce.sqlite");
        drop(SqliteTestNonceLedger::create(database.clone()));
        let database = Arc::new(database);
        let mut children = Vec::new();
        for _ in 0..16 {
            let database = Arc::clone(&database);
            children.push(thread::spawn(move || {
                let output = Command::new(std::env::current_exe().unwrap())
                    .arg("--exact")
                    .arg("governance_receipt::tests::sqlite_nonce_child_process_entrypoint")
                    .arg("--nocapture")
                    .env("WS6_TEST_RECEIPT_NONCE_DB", database.as_os_str())
                    .output()
                    .expect("spawn isolated test-harness process");
                assert!(
                    output.status.success(),
                    "child test process failed: {}{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
                let stdout = String::from_utf8_lossy(&output.stdout);
                if stdout.contains("WS6_NONCE_RESULT=Consumed") {
                    GovernanceReceiptNonceDisposition::Consumed
                } else if stdout.contains("WS6_NONCE_RESULT=ExactReplay") {
                    GovernanceReceiptNonceDisposition::ExactReplay
                } else {
                    panic!("child did not report a nonce disposition: {stdout}");
                }
            }));
        }
        let outcomes = children
            .into_iter()
            .map(|child| child.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| **outcome == GovernanceReceiptNonceDisposition::Consumed)
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| **outcome == GovernanceReceiptNonceDisposition::ExactReplay)
                .count(),
            15
        );

        let reopened = SqliteTestNonceLedger::create((*database).clone());
        assert_eq!(
            reopened
                .consume_once(
                    "cross-process-nonce",
                    "signed-cross-process",
                    "payload-cross-process",
                    "request-cross-process",
                )
                .unwrap(),
            GovernanceReceiptNonceDisposition::ExactReplay
        );
        assert_eq!(
            reopened
                .consume_once(
                    "cross-process-nonce",
                    "changed-signed-envelope",
                    "payload-cross-process",
                    "request-cross-process",
                )
                .unwrap_err(),
            GovernanceReceiptNonceLedgerError::BindingConflict
        );
    }

    #[test]
    fn full_receipt_verification_replays_exactly_after_sqlite_nonce_adapter_reopen() {
        let f = fixtures();
        let observed = observer(&f.config, f.now_ms);
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("ws6-full-verifier-restart.sqlite");

        let first = {
            let nonce_ledger = SqliteTestNonceLedger::create(database.clone());
            verify(&f, &f.request, &f.receipt, &observed, Some(&nonce_ledger)).unwrap()
        };
        assert!(!first.exact_replay());

        // Recreate the adapter and re-run the entire signature/request/subject
        // verifier. Only the durable nonce state survives adapter reconstruction.
        let reopened = SqliteTestNonceLedger::create(database);
        let exact_replay = verify(&f, &f.request, &f.receipt, &observed, Some(&reopened)).unwrap();
        assert!(exact_replay.exact_replay());
        assert_eq!(exact_replay.receipt_sha256(), first.receipt_sha256());

        assert_eq!(
            verify(
                &f,
                &f.changed_request,
                &f.changed_receipt,
                &observed,
                Some(&reopened),
            )
            .unwrap_err()
            .code(),
            "GOVERNANCE_RECEIPT_NONCE_CONFLICT"
        );
    }

    #[test]
    fn node_fixture_receipt_payload_sha256_matches_canonical_preimage() {
        let data: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/governance-approval-receipt-v1-node.json"
        ))
        .unwrap();
        let receipt: GovernanceApprovalReceiptV1 =
            serde_json::from_str(data["primary"]["receipt_json"].as_str().unwrap()).unwrap();
        let envelope_value = serde_json::to_value(&receipt.authenticator).unwrap();
        let payload = &envelope_value["receipt_payload"];
        assert_eq!(
            sha256(canonicalize(payload).unwrap().as_bytes()),
            data["primary"]["receipt_payload_sha256"].as_str().unwrap()
        );

        let mut unsigned = envelope_value;
        let signature = unsigned
            .as_object_mut()
            .unwrap()
            .remove("signature")
            .unwrap();
        assert_eq!(
            canonicalize(&unsigned).unwrap(),
            data["primary"]["canonical_unsigned_envelope_json"]
                .as_str()
                .unwrap()
        );
        assert_eq!(
            signature.as_str().unwrap(),
            data["primary"]["signature_base64"].as_str().unwrap()
        );
    }
}
