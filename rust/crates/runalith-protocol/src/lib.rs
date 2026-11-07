//! Strict COS-AP v1 wire contracts.
//!
//! Protocol validation establishes structural conformity only. It does not
//! authenticate a sender, authorize a reviewer, verify evidence lineage, or
//! establish that a provider executed a request.

use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub mod agg_checkpoint_v2;
pub mod evidence_resolution_v1;
pub mod evidence_verification_v1;
pub mod governance_v1;
pub mod mcp_service_v1;

/// COS-AP wire protocol identifier.
pub const COS_AP_PROTOCOL: &str = "cos-ap";
/// COS-AP wire protocol version.
pub const COS_AP_VERSION: u32 = 1;
/// Maximum number of execution batch items.
pub const MAX_EXECUTION_BATCH_ITEMS: usize = 32;
/// Maximum command length in Unicode scalar values.
pub const MAX_EXECUTION_COMMAND_CHARS: usize = 32_768;
/// Maximum requested execution timeout in milliseconds.
pub const MAX_EXECUTION_TIMEOUT_MS: u64 = 600_000;
/// Maximum encoded envelope size accepted by the Rust transport.
pub const MAX_ENVELOPE_BYTES: usize = 1_048_576;

/// Recognized COS-AP v1 message types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MessageType {
    /// Workflow proposal created.
    #[serde(rename = "job.proposed")]
    JobProposed,
    /// Workflow approval recorded.
    #[serde(rename = "job.approved")]
    JobApproved,
    /// Agent session spawn requested.
    #[serde(rename = "session.spawn")]
    SessionSpawn,
    /// Agent session message requested.
    #[serde(rename = "session.message")]
    SessionMessage,
    /// Execution batch submitted.
    #[serde(rename = "execution.batch")]
    ExecutionBatch,
    /// Execution result returned.
    #[serde(rename = "execution.result")]
    ExecutionResult,
    /// Child task result returned.
    #[serde(rename = "child.result")]
    ChildResult,
    /// Synthesis requested.
    #[serde(rename = "synthesis.request")]
    SynthesisRequest,
    /// Synthesis result returned.
    #[serde(rename = "synthesis.result")]
    SynthesisResult,
    /// Workflow progress recorded.
    #[serde(rename = "job.progress")]
    JobProgress,
    /// Workflow completed.
    #[serde(rename = "job.completed")]
    JobCompleted,
    /// Workflow failed.
    #[serde(rename = "job.failed")]
    JobFailed,
    /// Provider status reported.
    #[serde(rename = "provider.status")]
    ProviderStatus,
}

/// Strict COS-AP v1 envelope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    /// Protocol identifier; must be `cos-ap`.
    pub protocol: String,
    /// Wire protocol version; must be `1`.
    pub version: u32,
    /// Unique message ID.
    pub message_id: String,
    /// Recognized message type.
    pub message_type: MessageType,
    /// Workflow ID; COS-AP v1 requires the `job_` prefix.
    pub job_id: String,
    /// Optional task identity.
    pub task_id: Option<String>,
    /// Attempt number, starting at one.
    pub attempt: u64,
    /// Sender identity.
    pub sender: String,
    /// Recipient identity.
    pub recipient: String,
    /// Optional correlation identity.
    pub correlation_id: Option<String>,
    /// RFC 3339 timestamp with explicit timezone.
    pub created_at: String,
    /// Message-specific JSON object.
    pub payload: Value,
}

impl Envelope {
    /// Validate all cross-field and payload invariants.
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.protocol != COS_AP_PROTOCOL {
            return Err(ProtocolError::InvalidField("protocol"));
        }
        if self.version != COS_AP_VERSION {
            return Err(ProtocolError::InvalidField("version"));
        }
        require_text(&self.message_id, "message_id")?;
        if !self.job_id.starts_with("job_")
            || !self.job_id[4..]
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
            || self.job_id.len() <= 4
        {
            return Err(ProtocolError::InvalidField("job_id"));
        }
        if let Some(task_id) = &self.task_id {
            require_text(task_id, "task_id")?;
        }
        if self.attempt == 0 || self.attempt > i64::MAX as u64 {
            return Err(ProtocolError::InvalidField("attempt"));
        }
        require_text(&self.sender, "sender")?;
        require_text(&self.recipient, "recipient")?;
        if let Some(correlation_id) = &self.correlation_id {
            require_text(correlation_id, "correlation_id")?;
        }
        DateTime::parse_from_rfc3339(&self.created_at)
            .map_err(|_| ProtocolError::InvalidField("created_at"))?;
        if !self.payload.is_object() {
            return Err(ProtocolError::InvalidField("payload"));
        }
        Ok(())
    }
}

/// Parse and validate one bounded newline-delimited envelope.
pub fn decode_envelope(bytes: &[u8]) -> Result<Envelope, ProtocolError> {
    if bytes.is_empty() || bytes.len() > MAX_ENVELOPE_BYTES {
        return Err(ProtocolError::EnvelopeSize(bytes.len()));
    }
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(ProtocolError::Json)?;
    envelope.validate()?;
    Ok(envelope)
}

/// Strict protocol parsing and validation errors.
#[derive(Debug, Error)]
pub enum ProtocolError {
    /// Encoded message is empty or exceeds the transport bound.
    #[error("COS-AP envelope size outside valid bound: {0} bytes")]
    EnvelopeSize(usize),
    /// JSON is malformed or contains an unknown field/type.
    #[error("invalid COS-AP JSON: {0}")]
    Json(#[from] serde_json::Error),
    /// A field violates the protocol contract.
    #[error("COS-AP field violates contract: {0}")]
    InvalidField(&'static str),
}

fn require_text(value: &str, field: &'static str) -> Result<(), ProtocolError> {
    if value.trim().is_empty() {
        return Err(ProtocolError::InvalidField(field));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_envelope() -> Value {
        json!({
            "protocol": "cos-ap",
            "version": 1,
            "message_id": "msg_01",
            "message_type": "job.proposed",
            "job_id": "job_01",
            "task_id": null,
            "attempt": 1,
            "sender": "planner",
            "recipient": "workflow-runtime",
            "correlation_id": null,
            "created_at": "2026-11-01T09:00:00Z",
            "payload": {"title": "test"}
        })
    }

    #[test]
    fn accepts_valid_v1_envelope() {
        let bytes = serde_json::to_vec(&valid_envelope()).unwrap();
        assert_eq!(
            decode_envelope(&bytes).unwrap().message_type,
            MessageType::JobProposed
        );
    }

    #[test]
    fn rejects_unknown_fields_and_message_types() {
        let mut value = valid_envelope();
        value["unexpected"] = json!(true);
        let bytes = serde_json::to_vec(&value).unwrap();
        assert!(matches!(
            decode_envelope(&bytes),
            Err(ProtocolError::Json(_))
        ));

        let mut value = valid_envelope();
        value["message_type"] = json!("job.execute_without_approval");
        let bytes = serde_json::to_vec(&value).unwrap();
        assert!(matches!(
            decode_envelope(&bytes),
            Err(ProtocolError::Json(_))
        ));
    }

    #[test]
    fn rejects_wrong_identity_timestamp_and_non_object_payload() {
        for (field, value) in [
            ("job_id", json!("not-a-job")),
            ("created_at", json!("2026-11-01T09:00:00")),
            ("payload", json!([])),
            ("attempt", json!(0)),
        ] {
            let mut envelope = valid_envelope();
            envelope[field] = value;
            let bytes = serde_json::to_vec(&envelope).unwrap();
            assert!(
                decode_envelope(&bytes).is_err(),
                "field {field} was accepted"
            );
        }
    }
}
