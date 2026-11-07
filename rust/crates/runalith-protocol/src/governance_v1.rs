//! Versioned cross-service contracts for Governance approval decisions.
//!
//! These types define the Control/Governance wire boundary. Validation here
//! checks structure and exact subject binding only; callers must authenticate
//! the producer and verify the receipt authenticator before granting authority.

use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

/// Current Governance approval contract version.
pub const GOVERNANCE_APPROVAL_SCHEMA_VERSION: u32 = 1;
/// Maximum allowed request/receipt validity window.
pub const MAX_GOVERNANCE_APPROVAL_WINDOW_MS: i64 = 600_000;

/// Exact immutable Control subject submitted for Governance review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovalSubjectV1 {
    /// Workflow identity in Control.
    pub workflow_id: String,
    /// Stable candidate identity.
    pub candidate_id: String,
    /// Digest of the exact candidate snapshot.
    pub candidate_sha256: String,
    /// Digest of the immutable execution plan.
    pub plan_sha256: String,
    /// Digest of the source graph snapshot used to derive the candidate.
    pub source_snapshot_sha256: String,
    /// Exact operation scope being authorized.
    pub action_scope: String,
}

impl ApprovalSubjectV1 {
    /// Validate all identities, digests and the action scope.
    pub fn validate(&self) -> Result<(), GovernanceContractError> {
        for (value, field) in [
            (self.workflow_id.as_str(), "workflow_id"),
            (self.candidate_id.as_str(), "candidate_id"),
            (self.action_scope.as_str(), "action_scope"),
        ] {
            validate_text(value, field, 256)?;
        }
        for (value, field) in [
            (&self.candidate_sha256, "candidate_sha256"),
            (&self.plan_sha256, "plan_sha256"),
            (&self.source_snapshot_sha256, "source_snapshot_sha256"),
        ] {
            validate_sha256(value, field)?;
        }
        Ok(())
    }
}

/// Authenticated Control request for an approval decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GovernanceApprovalRequestV1 {
    /// Contract version.
    pub schema_version: u32,
    /// Stable request identity.
    pub request_id: String,
    /// Authenticated Control service identity.
    pub producer: String,
    /// Control identity that must receive the decision.
    pub audience: String,
    /// Cross-service trace identity.
    pub correlation_id: String,
    /// Stable deduplication identity for this exact subject/evidence request.
    pub idempotency_key: String,
    /// Exact subject under review.
    pub subject: ApprovalSubjectV1,
    /// Digest of the immutable evidence envelope held by the evidence store.
    pub evidence_sha256: String,
    /// Opaque Control authenticator verified by Governance before processing.
    pub authenticator: Value,
    /// RFC 3339 issue timestamp with explicit timezone.
    pub issued_at: String,
    /// RFC 3339 expiry timestamp with explicit timezone.
    pub expires_at: String,
}

impl GovernanceApprovalRequestV1 {
    /// Validate the request envelope before dispatch to Governance.
    pub fn validate(&self) -> Result<(), GovernanceContractError> {
        if self.schema_version != GOVERNANCE_APPROVAL_SCHEMA_VERSION {
            return Err(GovernanceContractError::InvalidField("schema_version"));
        }
        for (value, field) in [
            (self.request_id.as_str(), "request_id"),
            (self.producer.as_str(), "producer"),
            (self.audience.as_str(), "audience"),
            (self.correlation_id.as_str(), "correlation_id"),
            (self.idempotency_key.as_str(), "idempotency_key"),
        ] {
            validate_text(value, field, 256)?;
        }
        self.subject.validate()?;
        validate_sha256(&self.evidence_sha256, "evidence_sha256")?;
        if !self.authenticator.is_object()
            || self
                .authenticator
                .as_object()
                .is_some_and(|value| value.is_empty())
        {
            return Err(GovernanceContractError::InvalidField("authenticator"));
        }
        validate_time_window(&self.issued_at, &self.expires_at)?;
        Ok(())
    }
}

/// Governance decision returned to the exact Control audience.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GovernanceDecision {
    /// Evidence satisfied the active policy and quorum.
    Approved,
    /// Evidence was rejected or vetoed by policy.
    Rejected,
}

/// Authenticated Governance decision receipt for one exact approval request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GovernanceApprovalReceiptV1 {
    /// Contract version.
    pub schema_version: u32,
    /// Stable Governance decision identity.
    pub decision_id: String,
    /// Exact request identity being answered.
    pub request_id: String,
    /// Authenticated Governance service identity.
    pub producer: String,
    /// Control service identity allowed to consume this receipt.
    pub audience: String,
    /// Exact subject that was reviewed.
    pub subject: ApprovalSubjectV1,
    /// Digest of the exact evidence envelope that was verified.
    pub evidence_sha256: String,
    /// Final policy decision.
    pub decision: GovernanceDecision,
    /// Immutable policy identity and version used for the decision.
    pub policy_id: String,
    /// Monotonic policy version.
    pub policy_version: u64,
    /// Digest of the exact policy snapshot.
    pub policy_sha256: String,
    /// Distinct reviewer identities that participated in the decision.
    pub reviewer_subjects: Vec<String>,
    /// RFC 3339 issue timestamp with explicit timezone.
    pub issued_at: String,
    /// RFC 3339 expiry timestamp with explicit timezone.
    pub expires_at: String,
    /// Opaque signature/authenticator verified by the receiving Control host.
    pub authenticator: Value,
}

impl GovernanceApprovalReceiptV1 {
    /// Validate receipt structure and bind it to the exact originating request.
    ///
    /// This does not verify `authenticator`; Control must use its provisioned
    /// Governance receipt verifier before accepting an approved decision.
    pub fn validate_for(
        &self,
        request: &GovernanceApprovalRequestV1,
        now: &str,
    ) -> Result<(), GovernanceContractError> {
        request.validate()?;
        if self.schema_version != GOVERNANCE_APPROVAL_SCHEMA_VERSION {
            return Err(GovernanceContractError::InvalidField("schema_version"));
        }
        for (value, field) in [
            (self.decision_id.as_str(), "decision_id"),
            (self.request_id.as_str(), "request_id"),
            (self.producer.as_str(), "producer"),
            (self.audience.as_str(), "audience"),
            (self.policy_id.as_str(), "policy_id"),
        ] {
            validate_text(value, field, 256)?;
        }
        self.subject.validate()?;
        validate_sha256(&self.evidence_sha256, "evidence_sha256")?;
        validate_sha256(&self.policy_sha256, "policy_sha256")?;
        validate_time_window(&self.issued_at, &self.expires_at)?;
        let issued = parse_time(&self.issued_at, "issued_at")?;
        let expires = parse_time(&self.expires_at, "expires_at")?;
        let current = parse_time(now, "now")?;
        if issued > current || expires <= current {
            return Err(GovernanceContractError::ReceiptExpired);
        }
        if self.policy_version == 0
            || self.reviewer_subjects.len() < 2
            || self.reviewer_subjects.len() > 32
            || self
                .reviewer_subjects
                .iter()
                .any(|subject| validate_text(subject, "reviewer_subject", 256).is_err())
            || !self.authenticator.is_object()
            || self
                .authenticator
                .as_object()
                .is_some_and(|value| value.is_empty())
        {
            return Err(GovernanceContractError::InvalidField("decision_metadata"));
        }
        let mut reviewers = self.reviewer_subjects.clone();
        reviewers.sort();
        reviewers.dedup();
        if reviewers.len() != self.reviewer_subjects.len() {
            return Err(GovernanceContractError::InvalidField("decision_metadata"));
        }
        if self.request_id != request.request_id
            || self.producer != request.audience
            || self.audience != request.producer
            || self.subject != request.subject
            || self.evidence_sha256 != request.evidence_sha256
        {
            return Err(GovernanceContractError::BindingMismatch);
        }
        if issued < parse_time(&request.issued_at, "issued_at")?
            || expires > parse_time(&request.expires_at, "expires_at")?
        {
            return Err(GovernanceContractError::ReceiptOutsideRequestWindow);
        }
        Ok(())
    }
}

/// Governance contract validation failures.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum GovernanceContractError {
    /// A field violates its structural or semantic contract.
    #[error("Governance contract field violates schema: {0}")]
    InvalidField(&'static str),
    /// Receipt does not bind to the exact originating request.
    #[error("Governance receipt does not match the originating request")]
    BindingMismatch,
    /// Receipt validity window extends beyond request validity.
    #[error("Governance receipt validity exceeds request validity")]
    ReceiptOutsideRequestWindow,
    /// Receipt is not currently valid.
    #[error("Governance receipt is not currently valid")]
    ReceiptExpired,
}

fn validate_text(
    value: &str,
    field: &'static str,
    max: usize,
) -> Result<(), GovernanceContractError> {
    if value.trim().is_empty()
        || value != value.trim()
        || value.len() > max
        || value.chars().any(char::is_control)
    {
        return Err(GovernanceContractError::InvalidField(field));
    }
    Ok(())
}

fn validate_sha256(value: &str, field: &'static str) -> Result<(), GovernanceContractError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(GovernanceContractError::InvalidField(field));
    }
    Ok(())
}

fn parse_time(
    value: &str,
    field: &'static str,
) -> Result<chrono::DateTime<chrono::FixedOffset>, GovernanceContractError> {
    DateTime::parse_from_rfc3339(value).map_err(|_| GovernanceContractError::InvalidField(field))
}

fn validate_time_window(issued_at: &str, expires_at: &str) -> Result<(), GovernanceContractError> {
    let issued = parse_time(issued_at, "issued_at")?;
    let expires = parse_time(expires_at, "expires_at")?;
    let window = expires.signed_duration_since(issued).num_milliseconds();
    if window <= 0 || window > MAX_GOVERNANCE_APPROVAL_WINDOW_MS {
        return Err(GovernanceContractError::InvalidField("time_window"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> GovernanceApprovalRequestV1 {
        GovernanceApprovalRequestV1 {
            schema_version: 1,
            request_id: "govreq_01".into(),
            producer: "workflow-control".into(),
            audience: "governance".into(),
            correlation_id: "corr_01".into(),
            idempotency_key: "approval_01".into(),
            subject: ApprovalSubjectV1 {
                workflow_id: "job_01".into(),
                candidate_id: "candidate_01".into(),
                candidate_sha256: "a".repeat(64),
                plan_sha256: "b".repeat(64),
                source_snapshot_sha256: "c".repeat(64),
                action_scope: "workflow.execute".into(),
            },
            evidence_sha256: "d".repeat(64),
            authenticator: serde_json::json!({"signature":"opaque"}),
            issued_at: "2026-11-01T10:00:00Z".into(),
            expires_at: "2026-11-01T10:05:00Z".into(),
        }
    }

    fn receipt() -> GovernanceApprovalReceiptV1 {
        let request = request();
        GovernanceApprovalReceiptV1 {
            schema_version: 1,
            decision_id: "decision_01".into(),
            request_id: request.request_id,
            producer: "governance".into(),
            audience: request.producer,
            subject: request.subject,
            evidence_sha256: request.evidence_sha256,
            decision: GovernanceDecision::Approved,
            policy_id: "production".into(),
            policy_version: 3,
            policy_sha256: "e".repeat(64),
            reviewer_subjects: vec!["reviewer_a".into(), "reviewer_b".into()],
            issued_at: "2026-11-01T10:01:00Z".into(),
            expires_at: "2026-11-01T10:04:00Z".into(),
            authenticator: serde_json::json!({"signature":"opaque"}),
        }
    }

    #[test]
    fn receipt_must_bind_exact_request_and_current_validity_window() {
        let request = request();
        let receipt = receipt();
        assert!(
            receipt
                .validate_for(&request, "2026-11-01T10:02:00Z")
                .is_ok()
        );

        let mut changed = receipt.clone();
        changed.subject.plan_sha256 = "f".repeat(64);
        assert_eq!(
            changed.validate_for(&request, "2026-11-01T10:02:00Z"),
            Err(GovernanceContractError::BindingMismatch)
        );

        let mut changed = receipt.clone();
        changed.producer = "untrusted-governance".into();
        assert_eq!(
            changed.validate_for(&request, "2026-11-01T10:02:00Z"),
            Err(GovernanceContractError::BindingMismatch)
        );

        assert_eq!(
            receipt.validate_for(&request, "2026-11-01T10:05:00Z"),
            Err(GovernanceContractError::ReceiptExpired)
        );
    }

    #[test]
    fn request_rejects_control_characters_in_identity_and_subject_fields() {
        let mut candidate = request();
        candidate.request_id = "govreq_01\nforged".into();
        assert_eq!(
            candidate.validate(),
            Err(GovernanceContractError::InvalidField("request_id"))
        );

        candidate = request();
        candidate.producer = "workflow-control\r\nadmin".into();
        assert_eq!(
            candidate.validate(),
            Err(GovernanceContractError::InvalidField("producer"))
        );

        candidate = request();
        candidate.subject.workflow_id = "job_01\0forged".into();
        assert_eq!(
            candidate.validate(),
            Err(GovernanceContractError::InvalidField("workflow_id"))
        );

        candidate = request();
        candidate.subject.action_scope = "workflow.execute\u{0085}admin".into();
        assert_eq!(
            candidate.validate(),
            Err(GovernanceContractError::InvalidField("action_scope"))
        );

        candidate = request();
        candidate.producer = " workflow-control".into();
        assert_eq!(
            candidate.validate(),
            Err(GovernanceContractError::InvalidField("producer"))
        );

        candidate = request();
        candidate.subject.workflow_id = "job_01 ".into();
        assert_eq!(
            candidate.validate(),
            Err(GovernanceContractError::InvalidField("workflow_id"))
        );
    }

    #[test]
    fn request_and_receipt_reject_malformed_digests_duplicate_reviewers_and_unknown_fields() {
        let mut malformed_request = request();
        malformed_request.subject.plan_sha256 = "not-a-digest".into();
        assert_eq!(
            malformed_request.validate(),
            Err(GovernanceContractError::InvalidField("plan_sha256"))
        );

        let mut unauthenticated_request = request();
        unauthenticated_request.authenticator = serde_json::json!({});
        assert_eq!(
            unauthenticated_request.validate(),
            Err(GovernanceContractError::InvalidField("authenticator"))
        );

        let request = request();
        let mut duplicate_reviewers = receipt();
        duplicate_reviewers.reviewer_subjects[1] = duplicate_reviewers.reviewer_subjects[0].clone();
        assert_eq!(
            duplicate_reviewers.validate_for(&request, "2026-11-01T10:02:00Z"),
            Err(GovernanceContractError::InvalidField("decision_metadata"))
        );

        let mut control_character_reviewer = receipt();
        control_character_reviewer.reviewer_subjects[0] = "reviewer_a\nforged".into();
        assert_eq!(
            control_character_reviewer.validate_for(&request, "2026-11-01T10:02:00Z"),
            Err(GovernanceContractError::InvalidField("decision_metadata"))
        );

        let mut oversized_reviewer = receipt();
        oversized_reviewer.reviewer_subjects[0] = "r".repeat(257);
        assert_eq!(
            oversized_reviewer.validate_for(&request, "2026-11-01T10:02:00Z"),
            Err(GovernanceContractError::InvalidField("decision_metadata"))
        );

        let mut value = serde_json::to_value(request).unwrap();
        value["unexpected"] = serde_json::json!(true);
        assert!(serde_json::from_value::<GovernanceApprovalRequestV1>(value).is_err());
    }
}
