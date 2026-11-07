//! Versioned, transport-neutral MCP Gateway to application-service contract.
//!
//! This contract carries no Store/Runtime types. Authorization remains a
//! mandatory service-side decision; a gateway's capability filtering is not an
//! authorization boundary.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

/// Current Gateway-to-service contract version.
pub const MCP_SERVICE_SCHEMA_VERSION: u32 = 1;
/// Maximum serialized service request/response size.
pub const MAX_MCP_SERVICE_MESSAGE_BYTES: usize = 1_048_576;

fn valid_contract_text(value: &str, max_bytes: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
}

/// Application-service operation class.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpServiceOperation {
    /// Return currently authorized capability metadata.
    DiscoverCapabilities,
    /// Invoke one named tool.
    CallTool,
    /// Read one named resource.
    ReadResource,
    /// Render one named prompt.
    GetPrompt,
}

/// Side-effect classification is explicit and checked by the service.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpSideEffectClass {
    /// Operation must not mutate application state or invoke providers.
    ReadOnly,
    /// Operation may mutate state and requires action-specific authorization.
    Mutating,
}

/// Authenticated principal assertion supplied by trusted transport adapter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpPrincipalV1 {
    /// Stable authenticated subject.
    pub subject: String,
    /// Authenticated calling service/client identity.
    pub issuer: String,
    /// Intended receiving application service.
    pub audience: String,
    /// Opaque authentication context reference; never a bearer credential.
    pub authentication_context: String,
}

/// Gateway request to independent application service.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpServiceRequestV1 {
    /// Contract version.
    pub schema_version: u32,
    /// Unique request identity.
    pub request_id: String,
    /// Cross-service trace identity.
    pub correlation_id: String,
    /// Authenticated transport principal.
    pub principal: McpPrincipalV1,
    /// Operation to perform.
    pub operation: McpServiceOperation,
    /// Capability required for this operation.
    pub capability: String,
    /// Explicit side-effect classification expected by the gateway.
    pub side_effect_class: McpSideEffectClass,
    /// Tool/resource/prompt name.
    pub name: Option<String>,
    /// Strict operation arguments.
    pub arguments: Value,
    /// Stable idempotency key; required for mutating operations.
    pub idempotency_key: Option<String>,
}

impl McpServiceRequestV1 {
    /// Validate structural constraints before service authorization.
    pub fn validate(&self) -> Result<(), McpServiceContractError> {
        let encoded = serde_json::to_vec(self)
            .map_err(|_| McpServiceContractError::InvalidField("request"))?;
        if encoded.len() > MAX_MCP_SERVICE_MESSAGE_BYTES {
            return Err(McpServiceContractError::MessageTooLarge);
        }
        if self.schema_version != MCP_SERVICE_SCHEMA_VERSION {
            return Err(McpServiceContractError::InvalidField("schema_version"));
        }
        for (value, field) in [
            (self.request_id.as_str(), "request_id"),
            (self.correlation_id.as_str(), "correlation_id"),
            (self.principal.subject.as_str(), "principal.subject"),
            (self.principal.issuer.as_str(), "principal.issuer"),
            (self.principal.audience.as_str(), "principal.audience"),
            (
                self.principal.authentication_context.as_str(),
                "principal.authentication_context",
            ),
            (self.capability.as_str(), "capability"),
        ] {
            if !valid_contract_text(value, 256) {
                return Err(McpServiceContractError::InvalidField(field));
            }
        }
        if !self.arguments.is_object() {
            return Err(McpServiceContractError::InvalidField("arguments"));
        }
        if self
            .name
            .as_deref()
            .is_some_and(|name| !valid_contract_text(name, 256))
        {
            return Err(McpServiceContractError::InvalidField("name"));
        }
        match self.operation {
            McpServiceOperation::DiscoverCapabilities if self.name.is_some() => {
                return Err(McpServiceContractError::InvalidField("name"));
            }
            McpServiceOperation::CallTool
            | McpServiceOperation::ReadResource
            | McpServiceOperation::GetPrompt
                if self.name.as_deref().is_none_or(str::is_empty) =>
            {
                return Err(McpServiceContractError::InvalidField("name"));
            }
            McpServiceOperation::CallTool
            | McpServiceOperation::ReadResource
            | McpServiceOperation::GetPrompt => {}
            _ => {}
        }
        if self.side_effect_class == McpSideEffectClass::Mutating
            && self
                .idempotency_key
                .as_deref()
                .is_none_or(|key| !valid_contract_text(key, 256))
        {
            return Err(McpServiceContractError::InvalidField("idempotency_key"));
        }
        if self.side_effect_class == McpSideEffectClass::ReadOnly && self.idempotency_key.is_some()
        {
            return Err(McpServiceContractError::InvalidField("idempotency_key"));
        }
        if matches!(
            self.operation,
            McpServiceOperation::ReadResource
                | McpServiceOperation::GetPrompt
                | McpServiceOperation::DiscoverCapabilities
        ) && self.side_effect_class != McpSideEffectClass::ReadOnly
        {
            return Err(McpServiceContractError::ReadOnlyOperationMutating);
        }
        Ok(())
    }
}

/// Service response envelope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpServiceResponseV1 {
    /// Contract version.
    pub schema_version: u32,
    /// Exact request identity.
    pub request_id: String,
    /// Stable service identity.
    pub service_id: String,
    /// Outcome classification.
    pub outcome: McpServiceOutcome,
    /// Structured response result, present only on success.
    pub result: Option<Value>,
    /// Stable error metadata, present only on failure.
    pub error: Option<McpServiceErrorV1>,
}

impl McpServiceResponseV1 {
    /// Validate response envelope against exact request and authenticated service.
    pub fn validate_for(
        &self,
        request: &McpServiceRequestV1,
        expected_service_id: &str,
    ) -> Result<(), McpServiceContractError> {
        request.validate()?;
        let encoded =
            serde_json::to_vec(self).map_err(|_| McpServiceContractError::InvalidResponse)?;
        if encoded.len() > MAX_MCP_SERVICE_MESSAGE_BYTES {
            return Err(McpServiceContractError::MessageTooLarge);
        }
        if self.schema_version != MCP_SERVICE_SCHEMA_VERSION
            || self.request_id != request.request_id
            || !valid_contract_text(&self.request_id, 256)
            || self.service_id != expected_service_id
            || !valid_contract_text(expected_service_id, 256)
        {
            return Err(McpServiceContractError::ResponseBindingMismatch);
        }
        match (self.outcome, self.result.is_some(), self.error.as_ref()) {
            (McpServiceOutcome::Success, true, None) => Ok(()),
            (McpServiceOutcome::Success, _, _) => Err(McpServiceContractError::InvalidResponse),
            (McpServiceOutcome::Denied | McpServiceOutcome::Failed, false, Some(error))
                if valid_contract_text(&error.code, 256)
                    && valid_contract_text(&error.message, 2_048) =>
            {
                Ok(())
            }
            (McpServiceOutcome::Unknown, false, Some(error))
                if request.side_effect_class == McpSideEffectClass::Mutating
                    && request.idempotency_key.is_some()
                    && error.code == "MUTATION_OUTCOME_UNKNOWN"
                    && valid_contract_text(&error.message, 2_048) =>
            {
                Ok(())
            }
            _ => Err(McpServiceContractError::InvalidResponse),
        }
    }
}

/// Explicit service outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpServiceOutcome {
    /// Operation completed and output validated.
    Success,
    /// Authorization denied.
    Denied,
    /// Operation failed without an authorization grant.
    Failed,
    /// Result cannot be determined safely.
    Unknown,
}

/// Stable service error envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpServiceErrorV1 {
    /// Stable machine-readable code.
    pub code: String,
    /// Safe diagnostic, no secrets or raw credentials.
    pub message: String,
}

/// Structural contract failures.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum McpServiceContractError {
    /// Invalid or unsupported field.
    #[error("MCP service contract field violates schema: {0}")]
    InvalidField(&'static str),
    /// A read-only operation cannot be declared mutating.
    #[error("read-only MCP operation cannot be classified as mutating")]
    ReadOnlyOperationMutating,
    /// Response identity or audience does not match request.
    #[error("MCP service response binding mismatch")]
    ResponseBindingMismatch,
    /// Result/error fields conflict with outcome.
    #[error("MCP service response fields are inconsistent")]
    InvalidResponse,
    /// Serialized request/response exceeds the fixed protocol size limit.
    #[error("MCP service message exceeds maximum size")]
    MessageTooLarge,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(operation: McpServiceOperation, effect: McpSideEffectClass) -> McpServiceRequestV1 {
        McpServiceRequestV1 {
            schema_version: 1,
            request_id: "req-1".into(),
            correlation_id: "trace-1".into(),
            principal: McpPrincipalV1 {
                subject: "operator".into(),
                issuer: "gateway".into(),
                audience: "control".into(),
                authentication_context: "mtls-session-1".into(),
            },
            operation,
            capability: "workflow.read".into(),
            side_effect_class: effect,
            name: Some("workflow_get".into()),
            arguments: serde_json::json!({"workflow_id":"job_1"}),
            idempotency_key: None,
        }
    }

    #[test]
    fn read_only_resource_cannot_claim_mutating_side_effects() {
        let mut request = request(
            McpServiceOperation::ReadResource,
            McpSideEffectClass::Mutating,
        );
        request.idempotency_key = Some("key".into());
        assert_eq!(
            request.validate(),
            Err(McpServiceContractError::ReadOnlyOperationMutating)
        );
    }

    #[test]
    fn mutating_tools_require_idempotency_and_unknown_fields_are_rejected() {
        let mut request = request(McpServiceOperation::CallTool, McpSideEffectClass::Mutating);
        assert_eq!(
            request.validate(),
            Err(McpServiceContractError::InvalidField("idempotency_key"))
        );
        request.idempotency_key = Some("key".into());
        assert!(request.validate().is_ok());
        let mut value = serde_json::to_value(request).unwrap();
        value["bypass_authorization"] = Value::Bool(true);
        assert!(serde_json::from_value::<McpServiceRequestV1>(value).is_err());
    }

    #[test]
    fn oversized_service_request_is_rejected_before_dispatch() {
        let mut request = request(McpServiceOperation::CallTool, McpSideEffectClass::ReadOnly);
        request.arguments =
            serde_json::json!({"payload":"x".repeat(MAX_MCP_SERVICE_MESSAGE_BYTES)});
        assert_eq!(
            request.validate(),
            Err(McpServiceContractError::MessageTooLarge)
        );
    }

    #[test]
    fn oversized_success_response_is_rejected_by_the_complete_envelope_limit() {
        let request = request(McpServiceOperation::CallTool, McpSideEffectClass::ReadOnly);
        let response = McpServiceResponseV1 {
            schema_version: MCP_SERVICE_SCHEMA_VERSION,
            request_id: request.request_id.clone(),
            service_id: "control".into(),
            outcome: McpServiceOutcome::Success,
            result: Some(serde_json::json!({
                "payload":"x".repeat(MAX_MCP_SERVICE_MESSAGE_BYTES)
            })),
            error: None,
        };

        assert_eq!(
            response.validate_for(&request, "control"),
            Err(McpServiceContractError::MessageTooLarge)
        );
    }

    #[test]
    fn request_rejects_empty_or_oversized_operation_name() {
        let mut request = request(McpServiceOperation::CallTool, McpSideEffectClass::ReadOnly);
        request.name = Some("  ".into());
        assert_eq!(
            request.validate(),
            Err(McpServiceContractError::InvalidField("name"))
        );
        request.name = Some("x".repeat(257));
        assert_eq!(
            request.validate(),
            Err(McpServiceContractError::InvalidField("name"))
        );
    }

    #[test]
    fn request_rejects_control_characters_in_identity_and_routing_fields() {
        let mut candidate = request(McpServiceOperation::CallTool, McpSideEffectClass::ReadOnly);
        candidate.request_id = "req-1\nforged".into();
        assert_eq!(
            candidate.validate(),
            Err(McpServiceContractError::InvalidField("request_id"))
        );

        candidate = request(McpServiceOperation::CallTool, McpSideEffectClass::ReadOnly);
        candidate.principal.subject = "operator\r\nadmin".into();
        assert_eq!(
            candidate.validate(),
            Err(McpServiceContractError::InvalidField("principal.subject"))
        );

        candidate = request(McpServiceOperation::CallTool, McpSideEffectClass::ReadOnly);
        candidate.correlation_id = "trace-1\ttrace-2".into();
        assert_eq!(
            candidate.validate(),
            Err(McpServiceContractError::InvalidField("correlation_id"))
        );

        candidate = request(McpServiceOperation::CallTool, McpSideEffectClass::ReadOnly);
        candidate.principal.issuer = "gateway\u{0085}proxy".into();
        assert_eq!(
            candidate.validate(),
            Err(McpServiceContractError::InvalidField("principal.issuer"))
        );

        candidate = request(McpServiceOperation::CallTool, McpSideEffectClass::ReadOnly);
        candidate.principal.authentication_context = "mtls\0session".into();
        assert_eq!(
            candidate.validate(),
            Err(McpServiceContractError::InvalidField(
                "principal.authentication_context"
            ))
        );

        candidate = request(McpServiceOperation::CallTool, McpSideEffectClass::ReadOnly);
        candidate.capability = "workflow.read\nworkflow.create".into();
        assert_eq!(
            candidate.validate(),
            Err(McpServiceContractError::InvalidField("capability"))
        );

        candidate = request(McpServiceOperation::CallTool, McpSideEffectClass::ReadOnly);
        candidate.name = Some("workflow_get\r".into());
        assert_eq!(
            candidate.validate(),
            Err(McpServiceContractError::InvalidField("name"))
        );
    }

    #[test]
    fn mutating_request_rejects_control_characters_in_idempotency_key() {
        let mut request = request(McpServiceOperation::CallTool, McpSideEffectClass::Mutating);
        request.idempotency_key = Some("idem-1\nidem-2".into());

        assert_eq!(
            request.validate(),
            Err(McpServiceContractError::InvalidField("idempotency_key"))
        );
    }

    #[test]
    fn response_rejects_empty_or_oversized_error_metadata() {
        let request = request(McpServiceOperation::CallTool, McpSideEffectClass::ReadOnly);
        let mut response = McpServiceResponseV1 {
            schema_version: 1,
            request_id: request.request_id.clone(),
            service_id: "control".into(),
            outcome: McpServiceOutcome::Failed,
            result: None,
            error: Some(McpServiceErrorV1 {
                code: "INTERNAL".into(),
                message: "safe failure".into(),
            }),
        };
        assert!(response.validate_for(&request, "control").is_ok());
        response.error.as_mut().unwrap().code = " ".into();
        assert_eq!(
            response.validate_for(&request, "control"),
            Err(McpServiceContractError::InvalidResponse)
        );
        response.error.as_mut().unwrap().code = "E".repeat(257);
        assert_eq!(
            response.validate_for(&request, "control"),
            Err(McpServiceContractError::InvalidResponse)
        );
        response.error.as_mut().unwrap().code = "INTERNAL".into();
        response.error.as_mut().unwrap().message = "x".repeat(2_049);
        assert_eq!(
            response.validate_for(&request, "control"),
            Err(McpServiceContractError::InvalidResponse)
        );
        response.error.as_mut().unwrap().message = "safe\nforged log line".into();
        assert_eq!(
            response.validate_for(&request, "control"),
            Err(McpServiceContractError::InvalidResponse)
        );
    }

    #[test]
    fn unknown_outcome_is_reserved_for_ambiguous_mutations_and_reconciliation_code() {
        let read_request = request(McpServiceOperation::CallTool, McpSideEffectClass::ReadOnly);
        let mut response = McpServiceResponseV1 {
            schema_version: MCP_SERVICE_SCHEMA_VERSION,
            request_id: read_request.request_id.clone(),
            service_id: "control".into(),
            outcome: McpServiceOutcome::Unknown,
            result: None,
            error: Some(McpServiceErrorV1 {
                code: "MUTATION_OUTCOME_UNKNOWN".into(),
                message: "reconcile before retry".into(),
            }),
        };

        assert_eq!(
            response.validate_for(&read_request, "control"),
            Err(McpServiceContractError::InvalidResponse)
        );

        let mut mutation_request =
            request(McpServiceOperation::CallTool, McpSideEffectClass::Mutating);
        mutation_request.idempotency_key = Some("idem-1".into());
        response.request_id = mutation_request.request_id.clone();
        response.error.as_mut().unwrap().code = "INTERNAL".into();
        assert_eq!(
            response.validate_for(&mutation_request, "control"),
            Err(McpServiceContractError::InvalidResponse)
        );

        response.error.as_mut().unwrap().code = "MUTATION_OUTCOME_UNKNOWN".into();
        assert!(response.validate_for(&mutation_request, "control").is_ok());

        mutation_request.idempotency_key = None;
        assert_eq!(
            response.validate_for(&mutation_request, "control"),
            Err(McpServiceContractError::InvalidField("idempotency_key"))
        );
    }
}
