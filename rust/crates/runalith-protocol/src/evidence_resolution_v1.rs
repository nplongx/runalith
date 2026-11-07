//! Versioned read-only evidence-source resolution contract.
//!
//! This contract validates request/response structure, audience binding,
//! content digest metadata and successful producer lineage. It does not
//! authenticate the remote caller, prove URI retrievability, or grant claim
//! verification authority; those guarantees belong to the authenticated
//! Execution adapter and Governance's independent verifier.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Version of the Governance-to-Execution evidence resolution contract.
pub const EVIDENCE_RESOLUTION_SCHEMA_VERSION: u32 = 1;
/// Maximum response byte count Governance may request for one source.
pub const MAX_EVIDENCE_RESOLUTION_BYTES: u64 = 64 * 1024 * 1024;

/// Read-only request to resolve one immutable graph evidence reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceResolutionRequestV1 {
    /// Contract version.
    pub schema_version: u32,
    /// Unique request/correlation identity.
    pub request_id: String,
    /// Authenticated Governance service identity making the request.
    pub requester: String,
    /// Exact Execution evidence service identity expected to answer.
    pub audience: String,
    /// Evidence record identity.
    pub evidence_id: String,
    /// Goal/Idea graph node identity.
    pub node_id: String,
    /// Durable source reference; parsing it does not authenticate it.
    pub source_uri: String,
    /// SHA-256 pinned by the immutable evidence record.
    pub expected_sha256: String,
    /// Caller-enforced upper bound for returned source bytes.
    pub max_bytes: u64,
}

impl EvidenceResolutionRequestV1 {
    /// Validate the closed request schema and supported durable URI schemes.
    pub fn validate(&self) -> Result<(), EvidenceResolutionContractError> {
        if self.schema_version != EVIDENCE_RESOLUTION_SCHEMA_VERSION {
            return Err(EvidenceResolutionContractError::InvalidField(
                "schema_version",
            ));
        }
        for (value, field, max_bytes) in [
            (self.request_id.as_str(), "request_id", 128),
            (self.requester.as_str(), "requester", 256),
            (self.audience.as_str(), "audience", 256),
            (self.evidence_id.as_str(), "evidence_id", 256),
            (self.node_id.as_str(), "node_id", 256),
            (self.source_uri.as_str(), "source_uri", 2_048),
        ] {
            validate_text(value, field, max_bytes)?;
        }
        validate_sha256(&self.expected_sha256, "expected_sha256")?;
        if self.max_bytes == 0 || self.max_bytes > MAX_EVIDENCE_RESOLUTION_BYTES {
            return Err(EvidenceResolutionContractError::InvalidField("max_bytes"));
        }
        validate_supported_source_uri(&self.source_uri, &self.expected_sha256)?;
        Ok(())
    }
}

/// Read-only availability result for one source reference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceSourceAvailability {
    /// The exact requested source was retrieved within the caller's byte bound.
    Available,
    /// The source is not currently retrievable; this is not a negative claim decision.
    Unavailable,
}

/// Successful producer provenance for one content-addressed Execution artifact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceProducerLineageV1 {
    /// Exact immutable artifact URI.
    pub source_uri: String,
    /// Workflow/job identity owning the producer task.
    pub source_job_id: String,
    /// Durable content-addressed artifact identity.
    pub artifact_id: String,
    /// Artifact lifecycle status reported by Execution; must be `active`.
    pub artifact_status: String,
    /// Artifact type recorded by the owning Execution contract.
    pub artifact_type: String,
    /// Durable event identity recording artifact creation.
    pub artifact_created_event_id: String,
    /// Whether Execution validated the complete artifact/task/result lineage.
    pub lineage_valid: bool,
    /// Whether Execution validated the exact producer contract.
    pub producer_contract_valid: bool,
    /// Whether Execution validated the producer result/attempt lineage.
    pub producer_result_lineage_valid: bool,
    /// Producer role recorded by the owning workflow contract.
    pub producer_role: String,
    /// Exact producer task identity.
    pub producer_task_id: String,
    /// Exact execution attempt identity that produced the artifact.
    pub producer_attempt_id: String,
    /// Whether the producer task reached its completed terminal state.
    pub producer_task_completed: bool,
    /// Durable terminal producer task status; must be `completed`.
    pub producer_task_status: String,
    /// Exact successful producer result identity.
    pub producer_result_id: String,
    /// Durable producer result outcome; must be `success`.
    pub producer_result_outcome: String,
    /// Durable task completion event identity.
    pub producer_completion_event_id: String,
    /// Durable event type; must be `task.completed`.
    pub producer_completion_event_type: String,
    /// Digest of the exact producer contract pinned by Execution.
    pub producer_contract_sha256: String,
    /// Digest binding the producer result, task, attempt and completion event.
    pub producer_result_lineage_sha256: String,
    /// Exact source content digest.
    pub content_sha256: String,
    /// Producer-contract schema version.
    pub schema_version: u32,
}

impl EvidenceProducerLineageV1 {
    /// Validate the immutable successful task/attempt/result/artifact chain.
    pub fn validate_for(
        &self,
        source_uri: &str,
        expected_sha256: &str,
    ) -> Result<(), EvidenceResolutionContractError> {
        for (value, field, max_bytes) in [
            (self.source_uri.as_str(), "producer.source_uri", 2_048),
            (self.source_job_id.as_str(), "producer.source_job_id", 256),
            (self.artifact_id.as_str(), "producer.artifact_id", 256),
            (
                self.artifact_status.as_str(),
                "producer.artifact_status",
                32,
            ),
            (self.artifact_type.as_str(), "producer.artifact_type", 128),
            (
                self.artifact_created_event_id.as_str(),
                "producer.artifact_created_event_id",
                256,
            ),
            (self.producer_role.as_str(), "producer.role", 128),
            (self.producer_task_id.as_str(), "producer.task_id", 256),
            (
                self.producer_attempt_id.as_str(),
                "producer.attempt_id",
                256,
            ),
            (
                self.producer_task_status.as_str(),
                "producer.task_status",
                32,
            ),
            (self.producer_result_id.as_str(), "producer.result_id", 256),
            (
                self.producer_result_outcome.as_str(),
                "producer.result_outcome",
                32,
            ),
            (
                self.producer_completion_event_id.as_str(),
                "producer.completion_event_id",
                256,
            ),
            (
                self.producer_completion_event_type.as_str(),
                "producer.completion_event_type",
                64,
            ),
        ] {
            validate_text(value, field, max_bytes)?;
        }
        validate_sha256(&self.producer_contract_sha256, "producer.contract_sha256")?;
        validate_sha256(
            &self.producer_result_lineage_sha256,
            "producer.result_lineage_sha256",
        )?;
        validate_sha256(&self.content_sha256, "producer.content_sha256")?;
        if self.schema_version == 0
            || self.source_uri != source_uri
            || self.artifact_status != "active"
            || !self.lineage_valid
            || !self.producer_contract_valid
            || !self.producer_result_lineage_valid
            || !self.producer_task_completed
            || self.content_sha256 != expected_sha256
            || self.producer_task_status != "completed"
            || self.producer_result_outcome != "success"
            || self.producer_completion_event_type != "task.completed"
        {
            return Err(EvidenceResolutionContractError::ProducerLineageInvalid);
        }
        validate_supported_source_uri(&self.source_uri, expected_sha256)?;
        if !self.source_uri.starts_with("artifact://") {
            return Err(EvidenceResolutionContractError::ProducerLineageInvalid);
        }
        Ok(())
    }
}

/// Read-only response from the authenticated source-owning service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceResolutionResponseV1 {
    /// Contract version.
    pub schema_version: u32,
    /// Exact request identity being answered.
    pub request_id: String,
    /// Authenticated Execution evidence service identity.
    pub responder: String,
    /// Governance service identity allowed to consume this response.
    pub audience: String,
    /// Exact evidence record identity.
    pub evidence_id: String,
    /// Exact graph node identity.
    pub node_id: String,
    /// Exact source reference.
    pub source_uri: String,
    /// Content media type reported by the source owner.
    pub media_type: String,
    /// SHA-256 of exact returned source bytes.
    pub source_sha256: String,
    /// Exact returned source byte count.
    pub size_bytes: u64,
    /// Whether the source was available to the owning service.
    pub availability: EvidenceSourceAvailability,
    /// Required for `artifact://`; prohibited for `file:` sources.
    pub producer_lineage: Option<EvidenceProducerLineageV1>,
}

impl EvidenceResolutionResponseV1 {
    /// Validate exact request/response, audience, digest and URI-specific lineage binding.
    ///
    /// `expected_responder` must be obtained from the authenticated peer identity,
    /// not copied from this response. This method does not itself authenticate
    /// the transport or establish that the peer owns the source.
    pub fn validate_for(
        &self,
        request: &EvidenceResolutionRequestV1,
        expected_responder: &str,
    ) -> Result<(), EvidenceResolutionContractError> {
        request.validate()?;
        validate_text(expected_responder, "expected_responder", 256)?;
        if self.schema_version != EVIDENCE_RESOLUTION_SCHEMA_VERSION {
            return Err(EvidenceResolutionContractError::InvalidField(
                "schema_version",
            ));
        }
        for (value, field, max_bytes) in [
            (self.request_id.as_str(), "request_id", 128),
            (self.responder.as_str(), "responder", 256),
            (self.audience.as_str(), "audience", 256),
            (self.evidence_id.as_str(), "evidence_id", 256),
            (self.node_id.as_str(), "node_id", 256),
            (self.source_uri.as_str(), "source_uri", 2_048),
            (self.media_type.as_str(), "media_type", 128),
        ] {
            validate_text(value, field, max_bytes)?;
        }
        validate_sha256(&self.source_sha256, "source_sha256")?;
        if self.responder != expected_responder {
            return Err(EvidenceResolutionContractError::ResponderUnauthorized);
        }
        if self.request_id != request.request_id
            || self.audience != request.requester
            || self.evidence_id != request.evidence_id
            || self.node_id != request.node_id
            || self.source_uri != request.source_uri
        {
            return Err(EvidenceResolutionContractError::BindingMismatch);
        }
        if self.size_bytes > request.max_bytes || self.size_bytes > MAX_EVIDENCE_RESOLUTION_BYTES {
            return Err(EvidenceResolutionContractError::SourceSizeLimit);
        }
        if self.availability == EvidenceSourceAvailability::Unavailable {
            return Err(EvidenceResolutionContractError::SourceUnavailable);
        }
        if self.source_sha256 != request.expected_sha256 {
            return Err(EvidenceResolutionContractError::SourceDigestMismatch);
        }
        if self.media_type.contains('\r')
            || self.media_type.contains('\n')
            || !self.media_type.contains('/')
        {
            return Err(EvidenceResolutionContractError::InvalidField("media_type"));
        }
        if request.source_uri.starts_with("artifact://") {
            self.producer_lineage
                .as_ref()
                .ok_or(EvidenceResolutionContractError::ProducerLineageInvalid)?
                .validate_for(&request.source_uri, &request.expected_sha256)?;
        } else if self.producer_lineage.is_some() {
            return Err(EvidenceResolutionContractError::ProducerLineageInvalid);
        }
        Ok(())
    }
}

/// Structural, identity or source-resolution contract failure.
#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceResolutionContractError {
    /// A closed-schema field violates its required shape or value constraints.
    #[error("evidence-resolution field is invalid: {0}")]
    InvalidField(&'static str),
    /// Response identities do not bind to the exact originating request.
    #[error("evidence-resolution response is not bound to its request")]
    BindingMismatch,
    /// Authenticated peer is not the expected source-owning service.
    #[error("evidence-resolution responder identity is unauthorized")]
    ResponderUnauthorized,
    /// Source bytes are unavailable; no claim decision is implied.
    #[error("evidence source is unavailable")]
    SourceUnavailable,
    /// Source byte count exceeds the request or protocol limit.
    #[error("evidence source exceeds the requested byte limit")]
    SourceSizeLimit,
    /// Source content does not match the digest pinned by the evidence record.
    #[error("evidence source digest does not match its pinned digest")]
    SourceDigestMismatch,
    /// Artifact producer lineage is missing, malformed or unsuccessful.
    #[error("artifact producer lineage is invalid")]
    ProducerLineageInvalid,
}

fn validate_supported_source_uri(
    value: &str,
    expected_sha256: &str,
) -> Result<(), EvidenceResolutionContractError> {
    if let Some(artifact_reference) = value.strip_prefix("artifact://") {
        if artifact_reference.is_empty()
            || artifact_reference.bytes().any(|byte| {
                byte.is_ascii_whitespace() || byte.is_ascii_control() || matches!(byte, b'#' | b'?')
            })
        {
            return Err(EvidenceResolutionContractError::InvalidField("source_uri"));
        }
        return Ok(());
    }

    let file_reference = value
        .strip_prefix("file:")
        .ok_or(EvidenceResolutionContractError::InvalidField("source_uri"))?;
    let (relative_path, pinned_sha256) = file_reference
        .split_once("#sha256=")
        .ok_or(EvidenceResolutionContractError::InvalidField("source_uri"))?;
    validate_sha256(pinned_sha256, "source_uri.sha256")?;
    let components: Vec<&str> = relative_path.split('/').collect();
    if relative_path.is_empty()
        || relative_path.starts_with('/')
        || relative_path.contains('\\')
        || relative_path.contains(':')
        || components
            .iter()
            .any(|part| part.is_empty() || *part == "." || *part == "..")
        || relative_path
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control() || byte == b'#')
        || pinned_sha256 != expected_sha256
    {
        return Err(EvidenceResolutionContractError::InvalidField("source_uri"));
    }
    Ok(())
}

fn validate_text(
    value: &str,
    field: &'static str,
    max_bytes: usize,
) -> Result<(), EvidenceResolutionContractError> {
    if value.trim().is_empty()
        || value != value.trim()
        || value.len() > max_bytes
        || value.chars().any(char::is_control)
    {
        return Err(EvidenceResolutionContractError::InvalidField(field));
    }
    Ok(())
}

fn validate_sha256(
    value: &str,
    field: &'static str,
) -> Result<(), EvidenceResolutionContractError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(EvidenceResolutionContractError::InvalidField(field));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn artifact_request() -> EvidenceResolutionRequestV1 {
        EvidenceResolutionRequestV1 {
            schema_version: 1,
            request_id: "request-1".into(),
            requester: "governance-a".into(),
            audience: "execution-evidence".into(),
            evidence_id: "evidence-1".into(),
            node_id: "node-1".into(),
            source_uri: "artifact://sha256/artifact-1".into(),
            expected_sha256: "a".repeat(64),
            max_bytes: 1024,
        }
    }

    fn lineage() -> EvidenceProducerLineageV1 {
        EvidenceProducerLineageV1 {
            source_uri: "artifact://sha256/artifact-1".into(),
            source_job_id: "job-1".into(),
            artifact_id: "artifact-1".into(),
            artifact_status: "active".into(),
            artifact_type: "application/json".into(),
            artifact_created_event_id: "event-artifact-1".into(),
            lineage_valid: true,
            producer_contract_valid: true,
            producer_result_lineage_valid: true,
            producer_role: "engineer".into(),
            producer_task_id: "task-1".into(),
            producer_attempt_id: "attempt-1".into(),
            producer_task_completed: true,
            producer_task_status: "completed".into(),
            producer_result_id: "result-1".into(),
            producer_result_outcome: "success".into(),
            producer_completion_event_id: "event-complete-1".into(),
            producer_completion_event_type: "task.completed".into(),
            producer_contract_sha256: "b".repeat(64),
            producer_result_lineage_sha256: "c".repeat(64),
            content_sha256: "a".repeat(64),
            schema_version: 1,
        }
    }

    fn artifact_response() -> EvidenceResolutionResponseV1 {
        EvidenceResolutionResponseV1 {
            schema_version: 1,
            request_id: "request-1".into(),
            responder: "execution-evidence".into(),
            audience: "governance-a".into(),
            evidence_id: "evidence-1".into(),
            node_id: "node-1".into(),
            source_uri: "artifact://sha256/artifact-1".into(),
            media_type: "application/json".into(),
            source_sha256: "a".repeat(64),
            size_bytes: 42,
            availability: EvidenceSourceAvailability::Available,
            producer_lineage: Some(lineage()),
        }
    }

    #[test]
    fn artifact_resolution_requires_exact_completed_successful_attempt_lineage() {
        let request = artifact_request();
        let mut response = artifact_response();
        response
            .validate_for(&request, "execution-evidence")
            .unwrap();

        response
            .producer_lineage
            .as_mut()
            .unwrap()
            .producer_attempt_id
            .clear();
        assert!(
            response
                .validate_for(&request, "execution-evidence")
                .is_err()
        );

        let mut response = artifact_response();
        response
            .producer_lineage
            .as_mut()
            .unwrap()
            .producer_task_completed = false;
        assert!(
            response
                .validate_for(&request, "execution-evidence")
                .is_err()
        );

        let mut response = artifact_response();
        response
            .producer_lineage
            .as_mut()
            .unwrap()
            .producer_task_status = "running".into();
        assert!(
            response
                .validate_for(&request, "execution-evidence")
                .is_err()
        );

        let mut response = artifact_response();
        response
            .producer_lineage
            .as_mut()
            .unwrap()
            .producer_result_outcome = "failed".into();
        assert!(
            response
                .validate_for(&request, "execution-evidence")
                .is_err()
        );

        let mut response = artifact_response();
        response
            .producer_lineage
            .as_mut()
            .unwrap()
            .producer_contract_valid = false;
        assert!(
            response
                .validate_for(&request, "execution-evidence")
                .is_err()
        );

        let mut response = artifact_response();
        response
            .producer_lineage
            .as_mut()
            .unwrap()
            .producer_result_lineage_valid = false;
        assert!(
            response
                .validate_for(&request, "execution-evidence")
                .is_err()
        );

        let mut response = artifact_response();
        response.producer_lineage.as_mut().unwrap().artifact_status = "revoked".into();
        assert!(
            response
                .validate_for(&request, "execution-evidence")
                .is_err()
        );
    }

    #[test]
    fn evidence_resolution_binds_request_audience_responder_and_exact_source_digest() {
        let request = artifact_request();
        let mut response = artifact_response();
        assert!(
            response
                .validate_for(&request, "different-execution-service")
                .is_err()
        );

        response = artifact_response();
        response.audience = "other-governance".into();
        assert!(
            response
                .validate_for(&request, "execution-evidence")
                .is_err()
        );

        response = artifact_response();
        response.source_sha256 = "d".repeat(64);
        assert!(
            response
                .validate_for(&request, "execution-evidence")
                .is_err()
        );
    }

    #[test]
    fn file_resolution_is_content_digest_checked_without_claiming_artifact_lineage() {
        let mut request = artifact_request();
        request.source_uri = format!(
            "file:source/source-1.json#sha256={}",
            request.expected_sha256
        );
        let mut response = artifact_response();
        response.source_uri = request.source_uri.clone();
        response.producer_lineage = None;
        response
            .validate_for(&request, "execution-evidence")
            .unwrap();

        response.producer_lineage = Some(lineage());
        assert!(
            response
                .validate_for(&request, "execution-evidence")
                .is_err()
        );

        let mut unpinned_path = artifact_request();
        unpinned_path.source_uri = "file:source/source-1.json".into();
        assert!(unpinned_path.validate().is_err());

        let mut differently_pinned_path = artifact_request();
        differently_pinned_path.source_uri =
            format!("file:source/source-1.json#sha256={}", "f".repeat(64));
        assert!(differently_pinned_path.validate().is_err());

        let mut traversal_path = artifact_request();
        traversal_path.source_uri = format!(
            "file:../outside.json#sha256={}",
            traversal_path.expected_sha256
        );
        assert!(traversal_path.validate().is_err());
    }

    #[test]
    fn unavailable_or_unsupported_source_is_not_reported_as_verified() {
        let request = artifact_request();
        let mut response = artifact_response();
        response.availability = EvidenceSourceAvailability::Unavailable;
        assert_eq!(
            response
                .validate_for(&request, "execution-evidence")
                .unwrap_err(),
            EvidenceResolutionContractError::SourceUnavailable
        );

        let mut unsupported = request;
        unsupported.source_uri = "https://example.invalid/evidence".into();
        assert!(unsupported.validate().is_err());
    }
}
