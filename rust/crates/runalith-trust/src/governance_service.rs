//! Independent Governance application boundary.
//!
//! This module has no dependency on Workflow Control, Runtime, or Store. A
//! deployment supplies authenticated transport, evidence resolution, and a
//! Governance-owned transactional backend. The backend contract deliberately
//! combines nonce consumption and decision persistence into one atomic unit;
//! implementations must not split those writes across databases.

use chrono::DateTime;
use rusqlite::Transaction;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{self, Write};
use thiserror::Error;

use runalith_protocol::agg_checkpoint_v2::{MAX_JSON_BYTES, canonicalize, parse_json};
use runalith_protocol::governance_v1::GovernanceContractError;
pub use runalith_protocol::governance_v1::{
    GovernanceApprovalReceiptV1, GovernanceApprovalRequestV1, GovernanceDecision,
};

/// Upper bound for raw evidence, aligned with the strict shared JCS parser.
pub const MAX_GOVERNANCE_EVIDENCE_BYTES: usize = MAX_JSON_BYTES;
const MAX_GOVERNANCE_AUTHENTICATOR_BYTES: usize = 16 * 1024;
const MAX_GOVERNANCE_RECEIPT_BYTES: usize = 32 * 1024;

/// Authenticated decision material produced by the Governance-owned verifier.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VerifiedGovernanceOutcome {
    /// Final policy decision. UNKNOWN is represented by an error, never PASS.
    pub decision: GovernanceDecision,
    /// Immutable policy identity.
    pub policy_id: String,
    /// Monotonic policy version.
    pub policy_version: u64,
    /// Digest of the exact signed policy.
    pub policy_sha256: String,
    /// Distinct authenticated reviewers in deterministic order.
    pub reviewer_subjects: Vec<String>,
    /// Decision validity end, RFC 3339.
    pub valid_until: String,
}

/// Authenticates Control requests and signs Governance receipts.
///
/// Implementations must bind the authenticated principal to `request.producer`
/// and must use a production-provisioned Governance signing key. Test keys are
/// not production trust roots.
pub trait GovernanceAuthenticator: Send + Sync {
    /// Verify the caller's authenticator and authenticated service identity.
    fn authenticate_control(
        &self,
        request: &GovernanceApprovalRequestV1,
    ) -> Result<(), GovernanceServiceError>;

    /// Sign the canonical receipt payload; return an opaque non-empty object.
    fn sign_receipt(
        &self,
        receipt: &GovernanceApprovalReceiptV1,
    ) -> Result<Value, GovernanceServiceError>;
}

/// Whether the transactional verifier is consuming new nonces or validating an
/// exact previously committed request during idempotent replay.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GovernanceDecisionVerificationMode {
    /// Verify signatures and atomically consume all one-use nonces.
    Consume,
    /// Verify signatures and require exact prior nonce records without writes.
    Revalidate,
}

/// Host-provisioned verifier for the exact current candidate and signed evidence.
///
/// Implementations must use only the supplied transaction for trust high-water,
/// reviewer identity, nonce, and policy reads/writes. Returning an outcome is an
/// assertion that all required authoritative checks passed in this transaction.
pub trait GovernanceDecisionVerifier: Send + Sync {
    /// Verify the request subject and maker/checker evidence in the active tx.
    fn verify_in_transaction(
        &self,
        transaction: &Transaction<'_>,
        request: &GovernanceApprovalRequestV1,
        evidence: &Value,
        now: &str,
        mode: GovernanceDecisionVerificationMode,
    ) -> Result<VerifiedGovernanceOutcome, GovernanceServiceError>;
}

/// Governance-owned evidence and transactional decision boundary.
///
/// `evaluate_and_commit` MUST atomically verify signatures/policy/binding,
/// consume maker/checker nonces, enforce policy high-water, validate the signed
/// receipt size, and persist the immutable result keyed by `idempotency_key`.
/// A duplicate exact request returns the original result; a changed request
/// under the same key fails. The bounded receipt validation must happen before
/// commit so the caller cannot receive a definite failure after an oversized
/// receipt was already made durable.
/// No implementation may treat missing evidence or unverifiable provenance as
/// an approval.
pub trait GovernanceDecisionBackend: Send + Sync {
    /// Verify, consume nonces, sign the exact receipt and persist all records atomically.
    fn evaluate_and_commit(
        &self,
        request: &GovernanceApprovalRequestV1,
        evidence: &Value,
        now: &str,
        service_id: &str,
        signer: &dyn GovernanceAuthenticator,
    ) -> Result<GovernanceApprovalReceiptV1, GovernanceServiceError>;
}

/// Construct, sign, and validate a receipt for an already verified outcome.
/// Call inside the decision transaction so receipt binding can be persisted
/// atomically with the decision and nonce observations.
pub fn sign_governance_receipt(
    request: &GovernanceApprovalRequestV1,
    outcome: &VerifiedGovernanceOutcome,
    now: &str,
    service_id: &str,
    signer: &dyn GovernanceAuthenticator,
) -> Result<GovernanceApprovalReceiptV1, GovernanceServiceError> {
    request.validate()?;
    let current =
        DateTime::parse_from_rfc3339(now).map_err(|_| GovernanceServiceError::InvalidClock)?;
    validate_outcome(outcome, current)?;
    if service_id.trim().is_empty()
        || service_id != service_id.trim()
        || service_id.len() > 256
        || service_id.chars().any(char::is_control)
        || service_id != request.audience
    {
        return Err(GovernanceServiceError::InvalidConfiguration);
    }
    let valid_until = DateTime::parse_from_rfc3339(&outcome.valid_until)
        .map_err(|_| GovernanceServiceError::InvalidOutcome)?;
    let request_expiry = DateTime::parse_from_rfc3339(&request.expires_at)
        .map_err(|_| GovernanceServiceError::InvalidClock)?;
    let receipt_expiry = std::cmp::min(request_expiry, valid_until);
    if receipt_expiry <= current {
        return Err(GovernanceServiceError::RequestExpired);
    }
    let mut reviewer_subjects = outcome.reviewer_subjects.clone();
    reviewer_subjects.sort();
    let mut receipt = GovernanceApprovalReceiptV1 {
        schema_version: 1,
        decision_id: format!("govdec_{}", request.request_id),
        request_id: request.request_id.clone(),
        producer: service_id.to_owned(),
        audience: request.producer.clone(),
        subject: request.subject.clone(),
        evidence_sha256: request.evidence_sha256.clone(),
        decision: outcome.decision,
        policy_id: outcome.policy_id.clone(),
        policy_version: outcome.policy_version,
        policy_sha256: outcome.policy_sha256.clone(),
        reviewer_subjects,
        issued_at: now.to_owned(),
        expires_at: receipt_expiry.to_rfc3339(),
        authenticator: serde_json::json!({"status":"unsigned"}),
    };
    receipt.authenticator = signer.sign_receipt(&receipt)?;
    if !serialized_json_fits(&receipt, MAX_GOVERNANCE_RECEIPT_BYTES) {
        return Err(GovernanceServiceError::ReceiptTooLarge);
    }
    receipt.validate_for(request, now)?;
    Ok(receipt)
}

/// Independent Governance service, usable behind stdio, HTTP, or in-process
/// transport without importing Runtime or Store.
pub struct GovernanceService<A, B> {
    authenticator: A,
    backend: B,
    service_id: String,
}

impl<A, B> GovernanceService<A, B>
where
    A: GovernanceAuthenticator,
    B: GovernanceDecisionBackend,
{
    /// Construct service with an explicit stable identity.
    pub fn new(
        service_id: impl Into<String>,
        authenticator: A,
        backend: B,
    ) -> Result<Self, GovernanceServiceError> {
        let service_id = service_id.into();
        if service_id.trim().is_empty()
            || service_id != service_id.trim()
            || service_id.len() > 256
            || service_id.chars().any(char::is_control)
        {
            return Err(GovernanceServiceError::InvalidConfiguration);
        }
        Ok(Self {
            authenticator,
            backend,
            service_id,
        })
    }

    /// Evaluate one exact Control request and return a signed, bound receipt.
    pub fn decide(
        &self,
        request: &GovernanceApprovalRequestV1,
        evidence_bytes: &[u8],
        now: &str,
    ) -> Result<GovernanceApprovalReceiptV1, GovernanceServiceError> {
        request.validate()?;
        if !serialized_json_fits(&request.authenticator, MAX_GOVERNANCE_AUTHENTICATOR_BYTES) {
            return Err(GovernanceServiceError::RequestAuthenticatorTooLarge);
        }
        if evidence_bytes.len() > MAX_GOVERNANCE_EVIDENCE_BYTES {
            return Err(GovernanceServiceError::EvidenceTooLarge);
        }
        if request.audience != self.service_id {
            return Err(GovernanceServiceError::AudienceMismatch);
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
        self.authenticator.authenticate_control(request)?;
        let evidence =
            parse_json(evidence_bytes).map_err(|_| GovernanceServiceError::EvidenceInvalid)?;
        let canonical =
            canonicalize(&evidence).map_err(|_| GovernanceServiceError::EvidenceInvalid)?;
        let actual_evidence_sha256 = hex::encode(Sha256::digest(canonical.as_bytes()));
        if actual_evidence_sha256 != request.evidence_sha256 {
            return Err(GovernanceServiceError::EvidenceDigestMismatch);
        }
        let receipt = self.backend.evaluate_and_commit(
            request,
            &evidence,
            now,
            &self.service_id,
            &self.authenticator,
        )?;
        if !serialized_json_fits(&receipt, MAX_GOVERNANCE_RECEIPT_BYTES) {
            return Err(GovernanceServiceError::ReceiptTooLarge);
        }
        receipt.validate_for(request, now)?;
        Ok(receipt)
    }
}

fn validate_outcome(
    outcome: &VerifiedGovernanceOutcome,
    now: DateTime<chrono::FixedOffset>,
) -> Result<(), GovernanceServiceError> {
    if outcome.policy_id.trim().is_empty()
        || outcome.policy_id != outcome.policy_id.trim()
        || outcome.policy_id.len() > 256
        || outcome.policy_id.chars().any(char::is_control)
        || outcome.policy_version == 0
        || !is_sha256(&outcome.policy_sha256)
        || outcome.reviewer_subjects.len() < 2
        || outcome.reviewer_subjects.len() > 32
        || outcome.reviewer_subjects.iter().any(|subject| {
            subject.trim().is_empty()
                || subject != subject.trim()
                || subject.len() > 256
                || subject.chars().any(char::is_control)
        })
    {
        return Err(GovernanceServiceError::InvalidOutcome);
    }
    let mut reviewers = outcome.reviewer_subjects.clone();
    reviewers.sort();
    reviewers.dedup();
    if reviewers.len() != outcome.reviewer_subjects.len() {
        return Err(GovernanceServiceError::InvalidOutcome);
    }
    let valid_until = DateTime::parse_from_rfc3339(&outcome.valid_until)
        .map_err(|_| GovernanceServiceError::InvalidOutcome)?;
    if valid_until <= now {
        return Err(GovernanceServiceError::InvalidOutcome);
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn serialized_json_fits<T: Serialize>(value: &T, max_bytes: usize) -> bool {
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
                "serialized Governance JSON exceeds configured limit",
            ));
        }
        self.written += bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Fail-closed Governance application errors.
#[derive(Debug, Error)]
pub enum GovernanceServiceError {
    /// Invalid service identity/configuration.
    #[error("Governance service configuration is invalid")]
    InvalidConfiguration,
    /// Request or host clock is malformed.
    #[error("Governance clock is invalid")]
    InvalidClock,
    /// Request or decision validity window has elapsed.
    #[error("Governance request is expired or not yet valid")]
    RequestExpired,
    /// Caller authentication failed.
    #[error("Governance caller authentication failed")]
    Authentication,
    /// Request is addressed to a different Governance service identity.
    #[error("Governance request audience does not match this service")]
    AudienceMismatch,
    /// Evidence bytes are malformed or outside the strict JCS profile.
    #[error("Governance evidence is invalid")]
    EvidenceInvalid,
    /// Raw evidence exceeds the bounded Governance decision input size.
    #[error("Governance evidence exceeds the configured byte limit")]
    EvidenceTooLarge,
    /// Control authenticator exceeds its configured serialized byte limit.
    #[error("Governance request authenticator exceeds the configured byte limit")]
    RequestAuthenticatorTooLarge,
    /// Canonical evidence digest differs from the authenticated request.
    #[error("Governance evidence digest does not match request")]
    EvidenceDigestMismatch,
    /// Evidence, policy, quorum, nonce, or persistence verification failed.
    #[error("Governance decision backend rejected request: {0}")]
    Backend(String),
    /// Backend returned incomplete, ambiguous, or malformed verified material.
    #[error("Governance backend returned unverifiable decision material")]
    InvalidOutcome,
    /// Receipt signing failed or returned unusable material.
    #[error("Governance receipt signing failed")]
    Signing,
    /// Signed Governance receipt exceeds the bounded response size.
    #[error("Governance approval receipt exceeds the configured byte limit")]
    ReceiptTooLarge,
    /// Receipt/request structural or exact-binding validation failed.
    #[error(transparent)]
    Contract(#[from] GovernanceContractError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use runalith_protocol::governance_v1::ApprovalSubjectV1;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    struct Authenticator {
        allow: AtomicBool,
    }
    impl GovernanceAuthenticator for Authenticator {
        fn authenticate_control(
            &self,
            _: &GovernanceApprovalRequestV1,
        ) -> Result<(), GovernanceServiceError> {
            if self.allow.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(GovernanceServiceError::Authentication)
            }
        }
        fn sign_receipt(
            &self,
            _: &GovernanceApprovalReceiptV1,
        ) -> Result<Value, GovernanceServiceError> {
            Ok(serde_json::json!({"signature":"test-only"}))
        }
    }

    struct Backend;
    impl GovernanceDecisionBackend for Backend {
        fn evaluate_and_commit(
            &self,
            request: &GovernanceApprovalRequestV1,
            _: &Value,
            now: &str,
            service_id: &str,
            signer: &dyn GovernanceAuthenticator,
        ) -> Result<GovernanceApprovalReceiptV1, GovernanceServiceError> {
            let outcome = VerifiedGovernanceOutcome {
                decision: GovernanceDecision::Approved,
                policy_id: "policy".into(),
                policy_version: 1,
                policy_sha256: "e".repeat(64),
                reviewer_subjects: vec!["reviewer-a".into(), "reviewer-b".into()],
                valid_until: "2026-11-01T10:04:00Z".into(),
            };
            sign_governance_receipt(request, &outcome, now, service_id, signer)
        }
    }

    struct CountingBackend {
        calls: Arc<AtomicUsize>,
    }

    impl GovernanceDecisionBackend for CountingBackend {
        fn evaluate_and_commit(
            &self,
            _: &GovernanceApprovalRequestV1,
            _: &Value,
            _: &str,
            _: &str,
            _: &dyn GovernanceAuthenticator,
        ) -> Result<GovernanceApprovalReceiptV1, GovernanceServiceError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err(GovernanceServiceError::Backend(
                "backend should not receive a wrong-audience request".into(),
            ))
        }
    }

    fn request() -> GovernanceApprovalRequestV1 {
        GovernanceApprovalRequestV1 {
            schema_version: 1,
            request_id: "req_01".into(),
            producer: "workflow-control".into(),
            audience: "governance".into(),
            correlation_id: "corr_01".into(),
            idempotency_key: "idem_01".into(),
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

    #[test]
    fn service_emits_exactly_bound_signed_receipt() {
        let service = GovernanceService::new(
            "governance",
            Authenticator {
                allow: AtomicBool::new(true),
            },
            Backend,
        )
        .unwrap();
        let evidence = br#"{"evidence":true}"#;
        let mut request = request();
        request.evidence_sha256 = hex::encode(Sha256::digest(
            canonicalize(&parse_json(evidence).unwrap())
                .unwrap()
                .as_bytes(),
        ));
        let receipt = service
            .decide(&request, evidence, "2026-11-01T10:01:00Z")
            .unwrap();
        receipt
            .validate_for(&request, "2026-11-01T10:02:00Z")
            .unwrap();
        assert_eq!(receipt.decision, GovernanceDecision::Approved);
        assert_eq!(receipt.reviewer_subjects.len(), 2);
    }

    #[test]
    fn service_denies_unauthenticated_control_before_backend() {
        let service = GovernanceService::new(
            "governance",
            Authenticator {
                allow: AtomicBool::new(false),
            },
            Backend,
        )
        .unwrap();
        let evidence = br#"{}"#;
        let mut request = request();
        request.evidence_sha256 = hex::encode(Sha256::digest(
            canonicalize(&parse_json(evidence).unwrap())
                .unwrap()
                .as_bytes(),
        ));
        assert!(matches!(
            service.decide(&request, evidence, "2026-11-01T10:01:00Z"),
            Err(GovernanceServiceError::Authentication)
        ));
    }

    #[test]
    fn service_rejects_wrong_audience_before_backend_invocation() {
        let calls = Arc::new(AtomicUsize::new(0));
        let service = GovernanceService::new(
            "governance",
            Authenticator {
                allow: AtomicBool::new(true),
            },
            CountingBackend {
                calls: Arc::clone(&calls),
            },
        )
        .unwrap();
        let evidence = br#"{}"#;
        let mut request = request();
        request.audience = "different-governance-service".into();
        request.evidence_sha256 = hex::encode(Sha256::digest(
            canonicalize(&parse_json(evidence).unwrap())
                .unwrap()
                .as_bytes(),
        ));

        assert!(
            service
                .decide(&request, evidence, "2026-11-01T10:01:00Z")
                .is_err()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn service_authenticates_control_before_parsing_evidence_payload() {
        let calls = Arc::new(AtomicUsize::new(0));
        let service = GovernanceService::new(
            "governance",
            Authenticator {
                allow: AtomicBool::new(false),
            },
            CountingBackend {
                calls: Arc::clone(&calls),
            },
        )
        .unwrap();

        assert!(matches!(
            service.decide(&request(), b"not-json", "2026-11-01T10:01:00Z"),
            Err(GovernanceServiceError::Authentication)
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn service_rejects_oversized_authenticator_and_evidence_before_backend() {
        let calls = Arc::new(AtomicUsize::new(0));
        let service = GovernanceService::new(
            "governance",
            Authenticator {
                allow: AtomicBool::new(true),
            },
            CountingBackend {
                calls: Arc::clone(&calls),
            },
        )
        .unwrap();

        let mut oversized_auth = request();
        oversized_auth.authenticator =
            serde_json::json!({"signature":"x".repeat(MAX_GOVERNANCE_AUTHENTICATOR_BYTES)});
        assert!(matches!(
            service.decide(&oversized_auth, b"{}", "2026-11-01T10:01:00Z"),
            Err(GovernanceServiceError::RequestAuthenticatorTooLarge)
        ));

        let oversized_evidence = vec![b' '; MAX_GOVERNANCE_EVIDENCE_BYTES + 1];
        assert!(matches!(
            service.decide(&request(), &oversized_evidence, "2026-11-01T10:01:00Z"),
            Err(GovernanceServiceError::EvidenceTooLarge)
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn serialized_receipt_size_check_stops_at_the_configured_bound() {
        let small = serde_json::json!({"signature":"test"});
        assert!(serialized_json_fits(&small, 64));
        let large = serde_json::json!({"signature":"x".repeat(128 * 1024)});
        assert!(!serialized_json_fits(&large, 1_024));
    }

    #[test]
    fn service_identity_must_be_trimmed_and_control_free() {
        for service_id in [" governance", "governance ", "governance\n"] {
            assert!(
                GovernanceService::new(
                    service_id,
                    Authenticator {
                        allow: AtomicBool::new(true),
                    },
                    Backend,
                )
                .is_err()
            );
        }
    }

    #[test]
    fn service_rejects_duplicate_reviewers_and_unknown_policy_digest() {
        let mut outcome = VerifiedGovernanceOutcome {
            decision: GovernanceDecision::Approved,
            policy_id: "p".into(),
            policy_version: 1,
            policy_sha256: "x".into(),
            reviewer_subjects: vec!["same".into(), "same".into()],
            valid_until: "2026-11-01T10:04:00Z".into(),
        };
        assert!(
            validate_outcome(
                &outcome,
                DateTime::parse_from_rfc3339("2026-11-01T10:01:00Z").unwrap()
            )
            .is_err()
        );
        outcome.reviewer_subjects = vec!["a".into(), "b".into()];
        assert!(
            validate_outcome(
                &outcome,
                DateTime::parse_from_rfc3339("2026-11-01T10:01:00Z").unwrap()
            )
            .is_err()
        );

        outcome.policy_sha256 = "e".repeat(64);
        outcome.reviewer_subjects = vec!["reviewer\nforged".into(), "reviewer-b".into()];
        assert!(
            validate_outcome(
                &outcome,
                DateTime::parse_from_rfc3339("2026-11-01T10:01:00Z").unwrap()
            )
            .is_err()
        );

        outcome.reviewer_subjects = vec!["reviewer-b".into(), "reviewer-a".into()];
        assert!(
            validate_outcome(
                &outcome,
                DateTime::parse_from_rfc3339("2026-11-01T10:01:00Z").unwrap()
            )
            .is_ok()
        );

        outcome.reviewer_subjects = vec!["r".repeat(257), "reviewer-b".into()];
        assert!(
            validate_outcome(
                &outcome,
                DateTime::parse_from_rfc3339("2026-11-01T10:01:00Z").unwrap()
            )
            .is_err()
        );

        outcome.reviewer_subjects = vec!["reviewer-a".into(), "reviewer-b".into()];
        outcome.policy_id = "policy\nforged".into();
        assert!(
            validate_outcome(
                &outcome,
                DateTime::parse_from_rfc3339("2026-11-01T10:01:00Z").unwrap()
            )
            .is_err()
        );
    }
}
