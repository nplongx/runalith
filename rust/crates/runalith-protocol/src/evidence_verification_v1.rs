//! Typed attestation contract for independently verified Goal/Idea evidence.
//!
//! This module validates the signed payload's shape, canonical identity lists,
//! freshness window and exact snapshot binding. It does not authenticate a
//! verifier, resolve evidence sources, or prove producer lineage.

use chrono::{DateTime, SecondsFormat};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Attestation schema used by the Node Goal/Idea knowledge verifier.
pub const EVIDENCE_VERIFICATION_SCHEMA_VERSION: u32 = 1;
/// Scope pinned by the Node verifier and its trust configuration.
pub const EVIDENCE_VERIFICATION_SCOPE: &str = "agg.goal_idea_graph.verify";
/// Signed envelope kind pinned by the Node verifier.
pub const EVIDENCE_VERIFICATION_KIND: &str = "adaptive_goal_verified_knowledge_graph_attestation";
/// Maximum signed attestation lifetime, matching the Node verifier's 30-minute bound.
pub const MAX_EVIDENCE_VERIFICATION_TTL_MS: i64 = 30 * 60 * 1_000;

/// Exact immutable Goal/Idea snapshot and evidence inventory the receipt must bind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceVerificationSubjectV1 {
    /// Stable Goal/Idea graph identity.
    pub goal_id: String,
    /// SHA-256 of the immutable graph snapshot.
    pub snapshot_hash: String,
    /// Sorted unique node identities in the snapshot.
    pub node_ids: Vec<String>,
    /// Sorted unique edge identities in the snapshot.
    pub edge_ids: Vec<String>,
    /// Sorted unique graph-membership provenance identities.
    pub membership_ids: Vec<String>,
    /// SHA-256 of the exact normalized evidence lineage manifest.
    pub evidence_manifest_hash: String,
}

impl EvidenceVerificationSubjectV1 {
    /// Validate exact subject identities and canonical sorted inventories.
    pub fn validate(&self) -> Result<(), EvidenceVerificationContractError> {
        validate_text(&self.goal_id, "goal_id", 200)?;
        validate_digest(&self.snapshot_hash, "snapshot_hash")?;
        validate_digest(&self.evidence_manifest_hash, "evidence_manifest_hash")?;
        validate_sorted_ids(&self.node_ids, "node_ids", 4_096)?;
        validate_sorted_ids(&self.edge_ids, "edge_ids", 16_384)?;
        validate_sorted_ids(&self.membership_ids, "membership_ids", 16_384)?;
        Ok(())
    }
}

/// Independent verifier's conclusion about the evidence-backed claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceClaimStatus {
    /// The independent verifier accepted the claim.
    Verified,
    /// The independent verifier rejected the claim.
    Rejected,
}

/// Whether the verifier independently assessed the claim/evidence relationship.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceIndependenceStatus {
    /// The verifier independently checked the evidence and claim.
    Verified,
    /// Independence was not established; this is never an authorizing receipt.
    Unverified,
}

/// Strict signed Goal/Idea evidence-verification receipt, excluding no signed fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceVerificationReceiptV1 {
    /// Receipt schema version.
    pub schema_version: u32,
    /// Exact signed-envelope kind.
    pub kind: String,
    /// Administrator-configured verifier provider identity.
    pub provider_id: String,
    /// SHA-256 fingerprint of the configured Ed25519 public trust root.
    pub trust_root_sha256: String,
    /// One-use signed nonce.
    pub nonce: String,
    /// Canonical UTC issuance timestamp.
    pub issued_at: String,
    /// Canonical UTC expiry timestamp.
    pub expires_at: String,
    /// Exact Goal/Idea knowledge-verification scope.
    pub scope: String,
    /// Goal/Idea graph identity.
    pub goal_id: String,
    /// Immutable graph snapshot digest.
    pub snapshot_hash: String,
    /// Sorted unique node identities covered by the receipt.
    pub node_ids: Vec<String>,
    /// Sorted unique edge identities covered by the receipt.
    pub edge_ids: Vec<String>,
    /// Sorted unique membership provenance identities covered by the receipt.
    pub membership_ids: Vec<String>,
    /// Digest of the exact durable evidence lineage manifest.
    pub evidence_manifest_hash: String,
    /// Independent claim decision.
    pub claim_status: EvidenceClaimStatus,
    /// Independent evidence/claim assessment status.
    pub independence_status: EvidenceIndependenceStatus,
    /// Signature algorithm required by the Node verifier.
    pub signature_algorithm: String,
    /// Canonical standard Base64 Ed25519 signature over all unsigned fields.
    pub signature: String,
}

impl EvidenceVerificationReceiptV1 {
    /// Validate shape, freshness and exact binding to the current snapshot subject.
    ///
    /// Cryptographic authenticity and nonce consumption are intentionally
    /// performed by `runalith-trust`, after this structural check succeeds.
    pub fn validate_for(
        &self,
        subject: &EvidenceVerificationSubjectV1,
        now: &str,
    ) -> Result<(), EvidenceVerificationContractError> {
        subject.validate()?;
        if self.schema_version != EVIDENCE_VERIFICATION_SCHEMA_VERSION {
            return Err(EvidenceVerificationContractError::InvalidField(
                "schema_version",
            ));
        }
        for (value, field, max_bytes) in [
            (self.kind.as_str(), "kind", 128),
            (self.provider_id.as_str(), "provider_id", 256),
            (self.scope.as_str(), "scope", 128),
            (self.goal_id.as_str(), "goal_id", 200),
            (self.signature_algorithm.as_str(), "signature_algorithm", 32),
        ] {
            validate_text(value, field, max_bytes)?;
        }
        if self.kind != EVIDENCE_VERIFICATION_KIND
            || self.scope != EVIDENCE_VERIFICATION_SCOPE
            || self.signature_algorithm != "Ed25519"
        {
            return Err(EvidenceVerificationContractError::InvalidField(
                "signed_scope",
            ));
        }
        validate_digest(&self.trust_root_sha256, "trust_root_sha256")?;
        validate_digest(&self.snapshot_hash, "snapshot_hash")?;
        validate_digest(&self.evidence_manifest_hash, "evidence_manifest_hash")?;
        validate_uuid(&self.nonce)?;
        validate_sorted_ids(&self.node_ids, "node_ids", 4_096)?;
        validate_sorted_ids(&self.edge_ids, "edge_ids", 16_384)?;
        validate_sorted_ids(&self.membership_ids, "membership_ids", 16_384)?;
        if self.signature.len() != 88
            || !self
                .signature
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
        {
            return Err(EvidenceVerificationContractError::InvalidField("signature"));
        }
        if self.independence_status != EvidenceIndependenceStatus::Verified {
            return Err(EvidenceVerificationContractError::IndependenceNotVerified);
        }
        if self.goal_id != subject.goal_id
            || self.snapshot_hash != subject.snapshot_hash
            || self.node_ids != subject.node_ids
            || self.edge_ids != subject.edge_ids
            || self.membership_ids != subject.membership_ids
            || self.evidence_manifest_hash != subject.evidence_manifest_hash
        {
            return Err(EvidenceVerificationContractError::BindingMismatch);
        }

        let issued_at_ms = parse_canonical_utc(&self.issued_at, "issued_at")?;
        let expires_at_ms = parse_canonical_utc(&self.expires_at, "expires_at")?;
        let now_ms = parse_canonical_utc(now, "now")?;
        if expires_at_ms <= issued_at_ms
            || expires_at_ms.saturating_sub(issued_at_ms) > MAX_EVIDENCE_VERIFICATION_TTL_MS
        {
            return Err(EvidenceVerificationContractError::InvalidFreshness);
        }
        if issued_at_ms > now_ms.saturating_add(60_000) || expires_at_ms <= now_ms {
            return Err(EvidenceVerificationContractError::ExpiredOrFutureDated);
        }
        Ok(())
    }

    /// SHA-256 over the canonical complete receipt, including its signature.
    pub fn canonical_sha256(&self) -> Result<String, EvidenceVerificationContractError> {
        let value = serde_json::to_value(self)
            .map_err(|_| EvidenceVerificationContractError::InvalidField("receipt"))?;
        let canonical = crate::agg_checkpoint_v2::canonicalize(&value)
            .map_err(|_| EvidenceVerificationContractError::InvalidField("receipt"))?;
        Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
    }

    /// Stable identity used by the Node verifier for durable attestation rows.
    pub fn attestation_id(&self) -> Result<String, EvidenceVerificationContractError> {
        let binding = format!(
            "{}|{}|{}|{}|{}",
            self.goal_id,
            self.snapshot_hash,
            self.provider_id,
            self.nonce,
            self.evidence_manifest_hash
        );
        Ok(hex::encode(Sha256::digest(binding.as_bytes())))
    }

    /// Canonical verifier identity derived from the authenticated provider and trusted key ID.
    pub fn verifier_identity(
        &self,
        key_id: &str,
    ) -> Result<String, EvidenceVerificationContractError> {
        validate_text(key_id, "key_id", 128)?;
        let identity = format!("{}/{}", self.provider_id, key_id);
        validate_text(&identity, "verifier_identity", 256)?;
        Ok(identity)
    }
}

/// Structural or binding error in a signed evidence-verification contract.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum EvidenceVerificationContractError {
    /// A field violates its closed schema or value constraints.
    #[error("evidence-verification contract field is invalid: {0}")]
    InvalidField(&'static str),
    /// A receipt does not identify the exact current snapshot and manifest.
    #[error("evidence-verification receipt does not bind the exact current snapshot")]
    BindingMismatch,
    /// A signed receipt did not attest independent verification.
    #[error("evidence-verification receipt does not establish independent verification")]
    IndependenceNotVerified,
    /// A receipt validity interval is empty or exceeds thirty minutes.
    #[error("evidence-verification receipt validity interval is invalid")]
    InvalidFreshness,
    /// A receipt is expired or too far in the future.
    #[error("evidence-verification receipt is expired or future-dated")]
    ExpiredOrFutureDated,
}

fn validate_text(
    value: &str,
    field: &'static str,
    max_bytes: usize,
) -> Result<(), EvidenceVerificationContractError> {
    if value.trim().is_empty()
        || value != value.trim()
        || value.len() > max_bytes
        || value.chars().any(char::is_control)
    {
        return Err(EvidenceVerificationContractError::InvalidField(field));
    }
    Ok(())
}

fn validate_digest(
    value: &str,
    field: &'static str,
) -> Result<(), EvidenceVerificationContractError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(EvidenceVerificationContractError::InvalidField(field));
    }
    Ok(())
}

fn validate_sorted_ids(
    values: &[String],
    field: &'static str,
    max_items: usize,
) -> Result<(), EvidenceVerificationContractError> {
    if values.len() > max_items {
        return Err(EvidenceVerificationContractError::InvalidField(field));
    }
    for value in values {
        validate_text(value, field, 256)?;
    }
    if values
        .windows(2)
        .any(|pair| js_string_order(&pair[0], &pair[1]) != std::cmp::Ordering::Less)
    {
        return Err(EvidenceVerificationContractError::InvalidField(field));
    }
    Ok(())
}

/// JavaScript's default `Array#sort()` compares UTF-16 code units.
fn js_string_order(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn validate_uuid(value: &str) -> Result<(), EvidenceVerificationContractError> {
    let bytes = value.as_bytes();
    let valid = bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
        && matches!(bytes.get(14), Some(b'1'..=b'8'))
        && bytes
            .get(19)
            .is_some_and(|byte| matches!(byte.to_ascii_lowercase(), b'8'..=b'b'))
        && value.bytes().all(|byte| !byte.is_ascii_uppercase());
    if valid {
        Ok(())
    } else {
        Err(EvidenceVerificationContractError::InvalidField("nonce"))
    }
}

fn parse_canonical_utc(
    value: &str,
    field: &'static str,
) -> Result<i64, EvidenceVerificationContractError> {
    let parsed = DateTime::parse_from_rfc3339(value)
        .map_err(|_| EvidenceVerificationContractError::InvalidField(field))?;
    if parsed.to_rfc3339_opts(SecondsFormat::Millis, true) != value {
        return Err(EvidenceVerificationContractError::InvalidField(field));
    }
    Ok(parsed.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subject() -> EvidenceVerificationSubjectV1 {
        EvidenceVerificationSubjectV1 {
            goal_id: "goal-1".into(),
            snapshot_hash: "a".repeat(64),
            node_ids: vec!["node-a".into(), "node-b".into()],
            edge_ids: vec!["edge-a".into()],
            membership_ids: vec!["membership-a".into()],
            evidence_manifest_hash: "b".repeat(64),
        }
    }

    fn receipt() -> EvidenceVerificationReceiptV1 {
        EvidenceVerificationReceiptV1 {
            schema_version: 1,
            kind: EVIDENCE_VERIFICATION_KIND.into(),
            provider_id: "independent-verifier".into(),
            trust_root_sha256: "c".repeat(64),
            nonce: "d4e5f6a7-1234-4abc-8def-1234567890ab".into(),
            issued_at: "2026-11-02T09:00:00.000Z".into(),
            expires_at: "2026-11-02T09:20:00.000Z".into(),
            scope: EVIDENCE_VERIFICATION_SCOPE.into(),
            goal_id: "goal-1".into(),
            snapshot_hash: "a".repeat(64),
            node_ids: vec!["node-a".into(), "node-b".into()],
            edge_ids: vec!["edge-a".into()],
            membership_ids: vec!["membership-a".into()],
            evidence_manifest_hash: "b".repeat(64),
            claim_status: EvidenceClaimStatus::Verified,
            independence_status: EvidenceIndependenceStatus::Verified,
            signature_algorithm: "Ed25519".into(),
            signature: "A".repeat(88),
        }
    }

    #[test]
    fn evidence_verification_receipt_binds_exact_snapshot_and_evidence_inventory() {
        let receipt = receipt();
        let subject = subject();

        receipt
            .validate_for(&subject, "2026-11-02T09:10:00.000Z")
            .unwrap();

        let digest = receipt.canonical_sha256().unwrap();
        assert_eq!(digest.len(), 64);
        assert_eq!(receipt.attestation_id().unwrap().len(), 64);
    }

    #[test]
    fn evidence_verification_receipt_rejects_snapshot_manifest_and_identity_drift() {
        let receipt = receipt();
        let subject = subject();
        let mut changed = subject.clone();
        changed.snapshot_hash = "e".repeat(64);
        assert!(
            receipt
                .validate_for(&changed, "2026-11-02T09:10:00.000Z")
                .is_err()
        );

        let mut changed = subject.clone();
        changed.evidence_manifest_hash = "f".repeat(64);
        assert!(
            receipt
                .validate_for(&changed, "2026-11-02T09:10:00.000Z")
                .is_err()
        );

        let mut changed = receipt.clone();
        changed.goal_id = "different-goal".into();
        assert!(
            changed
                .validate_for(&subject, "2026-11-02T09:10:00.000Z")
                .is_err()
        );
    }

    #[test]
    fn evidence_verification_receipt_rejects_noncanonical_inventory_and_unverified_independence() {
        let subject = subject();
        let mut changed = receipt();
        changed.node_ids.reverse();
        assert!(
            changed
                .validate_for(&subject, "2026-11-02T09:10:00.000Z")
                .is_err()
        );

        let mut changed = receipt();
        changed.independence_status = EvidenceIndependenceStatus::Unverified;
        assert!(
            changed
                .validate_for(&subject, "2026-11-02T09:10:00.000Z")
                .is_err()
        );
    }

    #[test]
    fn evidence_verification_inventory_order_matches_javascript_utf16_sort() {
        let mut subject = subject();
        // U+1F600 is encoded as a UTF-16 surrogate pair beginning D83D;
        // U+E000 sorts after it in JavaScript even though Rust's UTF-8/Unicode
        // scalar ordering puts U+E000 first.
        subject.node_ids = vec!["😀".into(), "\u{e000}".into()];
        subject.validate().unwrap();

        subject.node_ids.reverse();
        assert!(subject.validate().is_err());
    }

    #[test]
    fn evidence_verification_receipt_enforces_expiry_and_bounded_lifetime() {
        let subject = subject();
        let receipt = receipt();
        assert!(
            receipt
                .validate_for(&subject, "2026-11-02T09:20:00.000Z")
                .is_err()
        );
        assert!(
            receipt
                .validate_for(&subject, "2026-11-02T08:58:00.000Z")
                .is_err()
        );

        let mut long_lived = receipt;
        long_lived.expires_at = "2026-11-02T09:31:00.000Z".into();
        assert!(
            long_lived
                .validate_for(&subject, "2026-11-02T09:10:00.000Z")
                .is_err()
        );
    }

    #[test]
    fn evidence_verification_receipt_deserialization_rejects_unknown_fields() {
        let mut value = serde_json::to_value(receipt()).unwrap();
        value["verified"] = serde_json::Value::Bool(true);
        assert!(serde_json::from_value::<EvidenceVerificationReceiptV1>(value).is_err());
    }
}
