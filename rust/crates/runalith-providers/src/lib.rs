//! Provider adapter contracts and provider-specific dispatch/reconciliation logic.
//! No network transport or production adapter is registered by the default host.
//!
//! Adapters must receive a stable idempotency key and return an explicit
//! accepted/rejected/unknown outcome. Transport errors are ambiguous unless an
//! adapter can prove the request was never sent.

use runalith_domain::content_hash;
use runalith_execution_persistence::ProviderIntentRecord;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

/// Versioned W4 request, observation, run-reference and terminal-proof contracts.
pub mod contract_v1;

pub use contract_v1::{
    MAX_PROVIDER_OBSERVATION_BYTES, MAX_PROVIDER_REQUEST_BYTES, MAX_PROVIDER_TERMINAL_BYTES,
    PROVIDER_EFFECT_CONTRACT_V1, ProviderAdapterV1, ProviderContractError,
    ProviderControlFenceStateV1, ProviderControlFenceV1, ProviderDispatchObservationV1,
    ProviderDispatchOutcomeV1, ProviderDispatchRequestV1, ProviderEffectSubjectV1,
    ProviderNotSentEvidenceV1, ProviderProofVerificationError, ProviderRunRefV1,
    ProviderTerminalProofV1, ProviderTerminalProofVerificationV1, ProviderTerminalProofVerifier,
    verify_terminal_proof,
};

/// Exact, fenced provider dispatch request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderDispatchRequest {
    /// Stable provider adapter identifier.
    pub provider_id: String,
    /// Stable idempotency key reused for reconciliation, never blind replay.
    pub idempotency_key: String,
    /// Workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Fenced attempt number.
    pub attempt: u64,
    /// Exact worker lease identity.
    pub lease_id: String,
    /// Exact worker identity.
    pub worker_id: String,
    /// Exact approved immutable plan digest.
    pub plan_sha256: String,
    /// Digest of the exact provider payload.
    pub request_sha256: String,
    /// Provider-specific payload. Secrets must be resolved by adapter capability, not embedded here.
    pub payload: Value,
}

impl ProviderDispatchRequest {
    /// Check exact identity and payload equality against the durable reservation.
    /// A mismatch is a pre-send failure; adapters must not contact the provider.
    pub fn validate_against_intent(
        &self,
        intent: &ProviderIntentRecord,
    ) -> Result<(), ProviderAdapterError> {
        let expected = &intent.request;
        let matches = self.provider_id == expected.provider_id
            && self.idempotency_key == expected.idempotency_key
            && self.workflow_id == expected.workflow_id
            && self.task_id == expected.task_id
            && self.attempt == expected.attempt
            && self.lease_id == expected.lease_id
            && self.worker_id == expected.worker_id
            && self.plan_sha256 == expected.plan_sha256
            && self.request_sha256 == expected.request_sha256
            && expected.payload.as_ref() == Some(&self.payload);
        if !matches {
            return Err(ProviderAdapterError::NotSent(
                "dispatch request does not match the exact durable provider intent".into(),
            ));
        }
        validate_payload(&self.payload, &self.request_sha256)
    }
}

/// Validate a provider payload as a bounded, hash-pinned JSON object.
pub fn validate_payload(
    payload: &Value,
    expected_sha256: &str,
) -> Result<(), ProviderAdapterError> {
    if !payload.is_object() {
        return Err(ProviderAdapterError::NotSent(
            "provider payload must be a JSON object".into(),
        ));
    }
    if expected_sha256.len() != 64 || !expected_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(ProviderAdapterError::NotSent(
            "provider payload digest is malformed".into(),
        ));
    }
    let bytes = serde_json::to_vec(payload)
        .map_err(|error| ProviderAdapterError::NotSent(error.to_string()))?;
    if bytes.len() > 1_048_576 {
        return Err(ProviderAdapterError::NotSent(
            "provider payload exceeds 1 MiB".into(),
        ));
    }
    let actual =
        content_hash(payload).map_err(|error| ProviderAdapterError::NotSent(error.to_string()))?;
    if actual != expected_sha256.to_ascii_lowercase() {
        return Err(ProviderAdapterError::NotSent(
            "provider payload digest does not match immutable request_sha256".into(),
        ));
    }
    Ok(())
}

/// Provider dispatch result. `Unknown` is terminal for automatic dispatch and requires reconciliation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "SCREAMING_SNAKE_CASE",
    deny_unknown_fields
)]
pub enum ProviderDispatchResponse {
    /// Provider accepted request and returned durable run identity.
    Accepted {
        /// Durable provider run identifier.
        provider_run_id: String,
    },
    /// Provider authoritatively rejected request without starting work.
    Rejected {
        /// Stable provider rejection code.
        reason_code: String,
        /// Human-readable diagnostic.
        diagnostic: String,
    },
    /// Request may have reached provider; never automatically replay.
    Unknown {
        /// Reason exact outcome could not be established.
        diagnostic: String,
    },
}

/// Provider lookup response for reconciliation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "SCREAMING_SNAKE_CASE",
    deny_unknown_fields
)]
pub enum ProviderLookupResponse {
    /// Provider confirms an exact durable dispatch result.
    Found {
        /// Authoritative dispatch outcome.
        outcome: ProviderDispatchResponse,
        /// Provider-native lifecycle state, when available.
        provider_status: Option<String>,
        /// Provider-native completion conclusion, when available.
        conclusion: Option<String>,
        /// Provider run URL, when available.
        run_url: Option<String>,
    },
    /// Provider completed a full authoritative lookup scope and found no run.
    NotFound {
        /// Must be true; incomplete queries must return UNKNOWN instead.
        authoritative: bool,
        /// Number of provider pages searched.
        pages_scanned: u32,
        /// Exact repository/workflow/ref scope searched.
        query_scope: String,
    },
    /// Provider cannot establish exact outcome.
    Unknown {
        /// Reason reconciliation could not establish outcome.
        diagnostic: String,
    },
}

/// Adapter transport or contract failure.
#[derive(Debug, Error)]
pub enum ProviderAdapterError {
    /// Adapter could not establish whether request reached provider.
    #[error("provider outcome is ambiguous: {0}")]
    Ambiguous(String),
    /// Adapter can prove request was rejected before transmission.
    #[error("provider rejected request before transmission: {0}")]
    NotSent(String),
}

/// Provider integration boundary. Implementations must not retry ambiguous requests.
pub trait ProviderAdapter: Send + Sync {
    /// Stable adapter ID used in persisted dispatch intents.
    fn provider_id(&self) -> &'static str;

    /// Dispatch one exact request. Caller persists intent before invoking this method.
    fn dispatch(
        &self,
        request: &ProviderDispatchRequest,
    ) -> Result<ProviderDispatchResponse, ProviderAdapterError>;

    /// Reconcile an immutable persisted intent without starting new work.
    /// The full record includes exact non-secret payload metadata; legacy
    /// records without persisted payload must remain UNKNOWN.
    fn lookup(
        &self,
        intent: &ProviderIntentRecord,
    ) -> Result<ProviderLookupResponse, ProviderAdapterError>;

    /// Collect immutable terminal provider-run evidence after lookup confirms completion.
    /// Default adapters without result collection return `None` and remain ACCEPTED.
    fn collect_terminal_result(
        &self,
        _intent: &ProviderIntentRecord,
        _provider_run_id: &str,
    ) -> Result<Option<ProviderTerminalArtifact>, ProviderAdapterError> {
        Ok(None)
    }
}

/// Content-addressable terminal provider-run evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderTerminalArtifact {
    /// Exact provider run identity.
    pub provider_run_id: String,
    /// Provider terminal status, expected `completed`.
    pub status: String,
    /// Provider terminal conclusion.
    pub conclusion: String,
    /// Exact provider response bytes.
    pub bytes: Vec<u8>,
    /// Evidence media type.
    pub media_type: String,
}

/// GitHub Actions workflow-dispatch adapter with an injected transport.
pub mod github_actions;

pub use github_actions::{
    CurlGitHubHttpExecutor, GitHubActionsAdapter, GitHubActionsDispatch,
    GitHubActionsHttpTransport, GitHubActionsLookup, GitHubActionsTarget, GitHubActionsTransport,
};

#[cfg(test)]
mod tests {
    use super::*;
    use runalith_execution_persistence::{ProviderDispatchState, ProviderIntentRequest};

    fn fixture() -> (ProviderIntentRecord, ProviderDispatchRequest) {
        let payload = serde_json::json!({
            "input_commit": "0123456789abcdef0123456789abcdef01234567",
            "workflow": "p3-worker.yml",
            "ref": "main",
            "required_evidence": ["report.json"]
        });
        let request_sha256 = content_hash(&payload).unwrap();
        let intent_request = ProviderIntentRequest {
            workflow_id: "workflow-1".into(),
            task_id: "task-1".into(),
            attempt: 2,
            provider_id: "github-actions".into(),
            idempotency_key: "runalith-test-key".into(),
            lease_id: "lease-2".into(),
            worker_id: "worker-1".into(),
            plan_sha256: "a".repeat(64),
            request_sha256: request_sha256.clone(),
            payload: Some(payload.clone()),
        };
        let intent = ProviderIntentRecord {
            intent_id: "intent-1".into(),
            request: intent_request,
            state: ProviderDispatchState::Reserved,
            provider_run_id: None,
            outcome: None,
            created_at: "2026-11-01T00:00:00Z".into(),
            updated_at: "2026-11-01T00:00:00Z".into(),
        };
        let request = ProviderDispatchRequest {
            provider_id: "github-actions".into(),
            idempotency_key: "runalith-test-key".into(),
            workflow_id: "workflow-1".into(),
            task_id: "task-1".into(),
            attempt: 2,
            lease_id: "lease-2".into(),
            worker_id: "worker-1".into(),
            plan_sha256: "a".repeat(64),
            request_sha256,
            payload,
        };
        (intent, request)
    }

    #[test]
    fn dispatch_request_must_match_exact_durable_intent() {
        let (intent, request) = fixture();
        assert!(request.validate_against_intent(&intent).is_ok());

        let mut altered = request.clone();
        altered.lease_id = "other-lease".into();
        assert!(matches!(
            altered.validate_against_intent(&intent),
            Err(ProviderAdapterError::NotSent(_))
        ));

        let mut altered = request.clone();
        altered.payload["ref"] = serde_json::json!("attacker-branch");
        assert!(matches!(
            altered.validate_against_intent(&intent),
            Err(ProviderAdapterError::NotSent(_))
        ));
    }

    #[test]
    fn payload_validation_rejects_non_object_oversized_and_forged_digest() {
        assert!(validate_payload(&serde_json::json!([]), &"a".repeat(64)).is_err());
        let oversized = serde_json::json!({"content":"x".repeat(1_048_600)});
        assert!(validate_payload(&oversized, &"a".repeat(64)).is_err());
        let payload = serde_json::json!({"ref":"main"});
        assert!(validate_payload(&payload, &"a".repeat(64)).is_err());
    }

    #[test]
    fn migrated_intent_without_exact_payload_cannot_be_dispatch_validated() {
        let (mut intent, request) = fixture();
        intent.request.payload = None;
        assert!(matches!(
            request.validate_against_intent(&intent),
            Err(ProviderAdapterError::NotSent(_))
        ));
    }
}
