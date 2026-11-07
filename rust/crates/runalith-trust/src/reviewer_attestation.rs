//! Strict typed view of the existing checker-vote V1 signed envelope.
//!
//! This is a local trust-verifier input API, not a new cross-service protocol
//! or Common Envelope payload. It preserves the existing Node V1 field names
//! and signed object exactly; it does not add issuer/audience fields or change
//! the unprefixed execution-approval signature profile.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

use runalith_protocol::agg_checkpoint_v2::{AggCheckpointError, parse_json};

/// Exact kind literal used by the existing checker-vote V1 envelope.
pub const REVIEWER_ATTESTATION_KIND_V1: &str = "adaptive_goal_execution_approval_decision";
/// Exact scope literal used by the existing checker-vote V1 envelope.
pub const REVIEWER_ATTESTATION_SCOPE_V1: &str = "agg.execution.approve";

/// Decision disposition encoded in an existing checker-vote V1 envelope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewerAttestationDecisionV1 {
    /// Reviewer approves the bound candidate.
    Approve,
    /// Reviewer rejects the bound candidate.
    Reject,
}

/// Closed, local typed view of the existing 18-field checker-vote V1 object.
///
/// This is not a cross-service protocol DTO and parsing it does not authenticate
/// the vote. Use the typed adapter in `approval_decision` to delegate verification
/// to the existing policy, signature, candidate-binding and nonce verifier.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewerAttestationV1 {
    /// V1 schema marker; must equal 1.
    pub schema_version: u32,
    /// Existing checker-vote kind discriminator.
    pub kind: String,
    /// Provider identifier checked against configured trust.
    pub provider_id: String,
    /// SHA-256 fingerprint of the signing trust root.
    pub trust_root_sha256: String,
    /// Canonical one-use UUID nonce.
    pub nonce: String,
    /// Signed issue timestamp; full time validation belongs to the verifier.
    pub issued_at: String,
    /// Signed expiry timestamp; full time validation belongs to the verifier.
    pub expires_at: String,
    /// Existing execution-approval scope discriminator.
    pub scope: String,
    /// Identifier of the signed approval policy.
    pub policy_id: String,
    /// Positive version of the signed approval policy.
    pub policy_version: u64,
    /// SHA-256 digest of the signed approval policy.
    pub policy_hash: String,
    /// Reviewer identity asserted by the signed vote and checked against policy.
    pub reviewer_subject: String,
    /// Reviewer role asserted by the signed vote and checked against policy.
    pub reviewer_role: String,
    /// Reviewer trust domain asserted by the signed vote and checked against policy.
    pub trust_domain: String,
    /// Approve/reject disposition asserted by the signed vote.
    pub decision: ReviewerAttestationDecisionV1,
    /// Candidate binding asserted by the signed vote.
    pub binding: Value,
    /// Signature algorithm discriminator; must equal `Ed25519`.
    pub signature_algorithm: String,
    /// Standard Base64 encoded Ed25519 signature; verification is delegated.
    pub signature: String,
}

/// Structural parsing or field-validation error for the local V1 view.
#[derive(Debug, Error)]
pub enum ReviewerAttestationError {
    /// Strict JSON syntax, duplicate-key or numeric-token rejection.
    #[error(transparent)]
    Json(#[from] AggCheckpointError),
    /// Closed DTO shape or field type was invalid.
    #[error("reviewer attestation V1 shape is invalid")]
    Shape,
    /// A named structural field failed its local V1 constraint.
    #[error("reviewer attestation V1 field is invalid: {0}")]
    InvalidField(&'static str),
}

impl ReviewerAttestationV1 {
    /// Parse and validate the closed V1 input shape only.
    ///
    /// This does not authenticate the signature, select a trust root, apply
    /// reviewer policy, consume a nonce, or establish an authorization result.
    pub fn parse_json(bytes: &[u8]) -> Result<Self, ReviewerAttestationError> {
        let value = parse_json(bytes)?;
        let attestation: Self =
            serde_json::from_value(value).map_err(|_| ReviewerAttestationError::Shape)?;
        attestation.validate()?;
        Ok(attestation)
    }

    /// Validate structural fields without asserting signature authenticity.
    pub fn validate(&self) -> Result<(), ReviewerAttestationError> {
        if self.schema_version != 1 {
            return Err(ReviewerAttestationError::InvalidField("schema_version"));
        }
        if self.kind != REVIEWER_ATTESTATION_KIND_V1 {
            return Err(ReviewerAttestationError::InvalidField("kind"));
        }
        if self.scope != REVIEWER_ATTESTATION_SCOPE_V1 {
            return Err(ReviewerAttestationError::InvalidField("scope"));
        }
        if self.signature_algorithm != "Ed25519" {
            return Err(ReviewerAttestationError::InvalidField(
                "signature_algorithm",
            ));
        }
        for (value, field, max_len) in [
            (self.provider_id.as_str(), "provider_id", 256),
            (self.policy_id.as_str(), "policy_id", 128),
            (self.reviewer_subject.as_str(), "reviewer_subject", 200),
            (self.reviewer_role.as_str(), "reviewer_role", 120),
            (self.trust_domain.as_str(), "trust_domain", 120),
            (self.issued_at.as_str(), "issued_at", 64),
            (self.expires_at.as_str(), "expires_at", 64),
        ] {
            if value.is_empty()
                || value.len() > max_len
                || value != value.trim()
                || value.chars().any(char::is_control)
            {
                return Err(ReviewerAttestationError::InvalidField(field));
            }
        }
        if self.policy_version == 0 {
            return Err(ReviewerAttestationError::InvalidField("policy_version"));
        }
        for (value, field) in [
            (self.trust_root_sha256.as_str(), "trust_root_sha256"),
            (self.policy_hash.as_str(), "policy_hash"),
        ] {
            if value.len() != 64
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(ReviewerAttestationError::InvalidField(field));
            }
        }
        let nonce = Uuid::parse_str(&self.nonce)
            .map_err(|_| ReviewerAttestationError::InvalidField("nonce"))?;
        if nonce.to_string() != self.nonce {
            return Err(ReviewerAttestationError::InvalidField("nonce"));
        }
        if !self.binding.is_object() {
            return Err(ReviewerAttestationError::InvalidField("binding"));
        }
        if self.signature.len() != 88
            || !self.signature.as_bytes()[..86]
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
            || !self.signature.ends_with("==")
        {
            return Err(ReviewerAttestationError::InvalidField("signature"));
        }
        Ok(())
    }

    /// Convert this validated typed view to the existing verifier's JSON input.
    /// The existing verifier remains responsible for canonical signature bytes.
    pub fn to_value(&self) -> Result<Value, ReviewerAttestationError> {
        self.validate()?;
        serde_json::to_value(self).map_err(|_| ReviewerAttestationError::Shape)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        json!({
            "schema_version": 1,
            "kind": REVIEWER_ATTESTATION_KIND_V1,
            "provider_id": "reviewer-provider",
            "trust_root_sha256": "a".repeat(64),
            "nonce": "123e4567-e89b-42d3-a456-426614174000",
            "issued_at": "2026-11-03T12:00:00.000Z",
            "expires_at": "2026-11-03T12:05:00.000Z",
            "scope": REVIEWER_ATTESTATION_SCOPE_V1,
            "policy_id": "policy-v1",
            "policy_version": 1,
            "policy_hash": "b".repeat(64),
            "reviewer_subject": "reviewer-1",
            "reviewer_role": "reviewer",
            "trust_domain": "reviewer-domain",
            "decision": "approve",
            "binding": {"candidate_sha256": "c".repeat(64)},
            "signature_algorithm": "Ed25519",
            // Shape-only placeholder; this fixture is never treated as signed
            // evidence and is not passed to the cryptographic verifier.
            "signature": "A".repeat(86) + "=="
        })
    }

    #[test]
    fn strict_parse_and_round_trip_preserve_existing_v1_shape() {
        let input = sample();
        let bytes = serde_json::to_vec(&input).unwrap();
        let attestation = ReviewerAttestationV1::parse_json(&bytes).unwrap();
        assert_eq!(attestation.to_value().unwrap(), input);
        assert_eq!(attestation.decision, ReviewerAttestationDecisionV1::Approve);
    }

    #[test]
    fn rejects_unknown_fields_duplicate_keys_and_wrong_types() {
        let mut unknown = sample();
        unknown["audience"] = json!("not-a-v1-field");
        let bytes = serde_json::to_vec(&unknown).unwrap();
        assert!(matches!(
            ReviewerAttestationV1::parse_json(&bytes),
            Err(ReviewerAttestationError::Shape)
        ));

        assert!(matches!(
            ReviewerAttestationV1::parse_json(br#"{"schema_version":1,"schema_version":1}"#),
            Err(ReviewerAttestationError::Json(_))
        ));

        let mut wrong_type = sample();
        wrong_type["policy_version"] = json!("1");
        let bytes = serde_json::to_vec(&wrong_type).unwrap();
        assert!(matches!(
            ReviewerAttestationV1::parse_json(&bytes),
            Err(ReviewerAttestationError::Shape)
        ));
    }

    #[test]
    fn rejects_wrong_constants_hashes_nonce_signature_and_binding() {
        let mut value = sample();
        value["kind"] = json!("other-kind");
        let bytes = serde_json::to_vec(&value).unwrap();
        assert!(matches!(
            ReviewerAttestationV1::parse_json(&bytes),
            Err(ReviewerAttestationError::InvalidField("kind"))
        ));

        let mut value = sample();
        value["trust_root_sha256"] = json!("A".repeat(64));
        let bytes = serde_json::to_vec(&value).unwrap();
        assert!(matches!(
            ReviewerAttestationV1::parse_json(&bytes),
            Err(ReviewerAttestationError::InvalidField("trust_root_sha256"))
        ));

        let mut value = sample();
        value["nonce"] = json!("123E4567-E89B-42D3-A456-426614174000");
        let bytes = serde_json::to_vec(&value).unwrap();
        assert!(matches!(
            ReviewerAttestationV1::parse_json(&bytes),
            Err(ReviewerAttestationError::InvalidField("nonce"))
        ));

        let mut value = sample();
        value["signature"] = json!("not-a-signature");
        let bytes = serde_json::to_vec(&value).unwrap();
        assert!(matches!(
            ReviewerAttestationV1::parse_json(&bytes),
            Err(ReviewerAttestationError::InvalidField("signature"))
        ));

        let mut value = sample();
        value["binding"] = json!([]);
        let bytes = serde_json::to_vec(&value).unwrap();
        assert!(matches!(
            ReviewerAttestationV1::parse_json(&bytes),
            Err(ReviewerAttestationError::InvalidField("binding"))
        ));
    }
}
