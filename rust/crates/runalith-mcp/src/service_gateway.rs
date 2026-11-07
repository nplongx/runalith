//! Transport-neutral Gateway boundary over an independent application API.
//!
//! This module imports no Runtime, Store, provider, or execution crate. The
//! concrete service client must authenticate the transport principal and
//! enforce authorization again at the owning service boundary.

use runalith_protocol::mcp_service_v1::{
    McpPrincipalV1, McpServiceContractError, McpServiceOperation, McpServiceOutcome,
    McpServiceRequestV1, McpServiceResponseV1, McpSideEffectClass,
};
use serde::Serialize;
use std::{collections::BTreeSet, sync::Arc};
use thiserror::Error;

/// Bound service-owned capability discovery before serialization and response
/// construction. The protocol frame limit is a second, independent guard.
const MAX_GATEWAY_CAPABILITIES: usize = 256;

/// Transport identity already authenticated by the host before MCP request
/// processing. This value is passed separately from request JSON so a caller
/// cannot authenticate itself by copying principal claims into the envelope.
/// A transport adapter must construct it from accepted connection/session
/// state (for example a verified mTLS peer or host-verified local IPC peer);
/// it must never deserialize these fields from `McpServiceRequestV1`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedMcpTransportContext {
    connection_id: String,
    peer_identity: String,
}

impl AuthenticatedMcpTransportContext {
    /// Create a context from a transport identity the host has already verified.
    pub fn from_authenticated_peer(
        connection_id: impl Into<String>,
        peer_identity: impl Into<String>,
    ) -> Result<Self, McpGatewayError> {
        let connection_id = connection_id.into();
        let peer_identity = peer_identity.into();
        if !valid_transport_identity(&connection_id, 256)
            || !valid_transport_identity(&peer_identity, 256)
        {
            return Err(McpGatewayError::InvalidTransportContext);
        }
        Ok(Self {
            connection_id,
            peer_identity,
        })
    }

    /// Stable connection/session identity supplied by the host.
    #[must_use]
    pub fn connection_id(&self) -> &str {
        &self.connection_id
    }

    /// Authenticated peer identity supplied by the host transport adapter.
    #[must_use]
    pub fn peer_identity(&self) -> &str {
        &self.peer_identity
    }
}

/// Capability visible to one authenticated principal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct McpCapability {
    /// Stable capability identifier.
    pub id: String,
    /// Allowed MCP operation class.
    pub operation: McpServiceOperation,
    /// Explicit side-effect class.
    pub side_effect_class: McpSideEffectClass,
}

/// Host-owned authentication boundary for transport principal assertions.
/// Implementations must derive or verify the principal from authenticated
/// transport state; request JSON alone is not an authentication source. The
/// authenticator instance must be bound to the accepted connection/session
/// identity. A process-wide authenticator shared across multiple principals
/// must obtain the actual per-request transport identity from a host wrapper;
/// it must not authorize a principal merely because its claims are well formed.
pub trait McpTransportPrincipalAuthenticator: Send + Sync {
    /// Bind request principal claims to separately authenticated transport state.
    fn authenticate(
        &self,
        transport: &AuthenticatedMcpTransportContext,
        principal: &McpPrincipalV1,
    ) -> Result<(), McpGatewayError>;
}

/// Independent application API. Read-only and mutating calls use separate
/// methods so a read-only gateway path cannot accidentally reach a write API.
pub trait McpApplicationService: Send + Sync {
    /// Stable authenticated service identity used in response audience binding.
    fn service_id(&self) -> &str;
    /// Return capabilities already filtered for this authenticated principal.
    fn discover_capabilities(
        &self,
        principal: &McpPrincipalV1,
    ) -> Result<Vec<McpCapability>, McpGatewayError>;
    /// Derive the expected side-effect class from the service-owned route
    /// registry for this exact operation/name/arguments. In particular,
    /// implementations must not echo `request.side_effect_class`: that field
    /// is caller input and is checked against this independently derived value
    /// before authorization or dispatch.
    fn expected_side_effect_class(
        &self,
        request: &McpServiceRequestV1,
    ) -> Result<McpSideEffectClass, McpGatewayError>;
    /// Reauthorize the exact request at the service boundary; deny by default.
    /// Implementations must bind `name`, `arguments`, `capability`, and the
    /// expected side-effect class rather than trusting caller classification.
    fn authorize(&self, request: &McpServiceRequestV1) -> Result<(), McpGatewayError>;
    /// Read-only invocation. Implementations must not expose a mutation path.
    fn invoke_read_only(
        &self,
        request: &McpServiceRequestV1,
    ) -> Result<McpServiceResponseV1, McpGatewayError>;
    /// Mutating invocation. Requires service-side authorization and idempotency.
    /// Any transport error after invocation begins is an ambiguous outcome; the
    /// Gateway must not translate it into a definite client-side failure.
    fn invoke_mutating(
        &self,
        request: &McpServiceRequestV1,
    ) -> Result<McpServiceResponseV1, McpGatewayError>;
}

/// Gateway that has no persistence access and forwards only versioned contracts.
pub struct McpGateway<S> {
    service: S,
    authenticator: Arc<dyn McpTransportPrincipalAuthenticator>,
}

impl<S: McpApplicationService> McpGateway<S> {
    /// Compose Gateway with a remote or local IPC service client.
    pub fn new(service: S, authenticator: Arc<dyn McpTransportPrincipalAuthenticator>) -> Self {
        Self {
            service,
            authenticator,
        }
    }

    /// Handle one authenticated service request.
    pub fn handle(
        &self,
        transport: &AuthenticatedMcpTransportContext,
        request: &McpServiceRequestV1,
    ) -> Result<McpServiceResponseV1, McpGatewayError> {
        // The host-authenticated context is separate from caller-controlled
        // request JSON and is mandatory before any service or route access.
        self.authenticator
            .authenticate(transport, &request.principal)?;
        let service_id = self.service.service_id();
        validate_service_identity(service_id)?;
        request.validate()?;
        if request.principal.audience != service_id {
            return Err(McpGatewayError::AudienceMismatch);
        }
        let expected_effect = self.service.expected_side_effect_class(request)?;
        if expected_effect != request.side_effect_class {
            return Err(McpGatewayError::SideEffectClassMismatch);
        }
        if request.operation == McpServiceOperation::DiscoverCapabilities {
            self.service.authorize(request)?;
            let capabilities = self.service.discover_capabilities(&request.principal)?;
            if capabilities.len() > MAX_GATEWAY_CAPABILITIES {
                return Err(McpGatewayError::InvalidCapabilities);
            }
            let mut ids = BTreeSet::new();
            for capability in &capabilities {
                if capability.id.trim().is_empty()
                    || capability.id != capability.id.trim()
                    || capability.id.len() > 256
                    || capability.id.chars().any(char::is_control)
                    || !ids.insert(capability.id.as_str())
                    || (matches!(
                        capability.operation,
                        McpServiceOperation::DiscoverCapabilities
                            | McpServiceOperation::ReadResource
                            | McpServiceOperation::GetPrompt
                    ) && capability.side_effect_class != McpSideEffectClass::ReadOnly)
                {
                    return Err(McpGatewayError::InvalidCapabilities);
                }
            }
            let response = McpServiceResponseV1 {
                schema_version: 1,
                request_id: request.request_id.clone(),
                service_id: self.service.service_id().to_owned(),
                outcome: McpServiceOutcome::Success,
                result: Some(
                    serde_json::to_value(capabilities)
                        .map_err(|_| McpGatewayError::InvalidResponse)?,
                ),
                error: None,
            };
            validate_response(request, self.service.service_id(), &response)?;
            return Ok(response);
        }
        self.service.authorize(request)?;
        let response = match request.side_effect_class {
            McpSideEffectClass::ReadOnly => self.service.invoke_read_only(request)?,
            McpSideEffectClass::Mutating => match self.service.invoke_mutating(request) {
                Ok(response)
                    if validate_response(request, self.service.service_id(), &response).is_ok() =>
                {
                    response
                }
                // Once the mutating call has crossed the service interface, an
                // error or malformed response cannot prove that no commit took
                // place. Return a request-bound UNKNOWN receipt so callers
                // reconcile instead of interpreting the result as failure/retry.
                Ok(_) | Err(_) => unknown_mutation_response(request, self.service.service_id()),
            },
        };
        validate_response(request, self.service.service_id(), &response)?;
        Ok(response)
    }
}

fn unknown_mutation_response(
    request: &McpServiceRequestV1,
    service_id: &str,
) -> McpServiceResponseV1 {
    McpServiceResponseV1 {
        schema_version: 1,
        request_id: request.request_id.clone(),
        service_id: service_id.to_owned(),
        outcome: McpServiceOutcome::Unknown,
        result: None,
        error: Some(runalith_protocol::mcp_service_v1::McpServiceErrorV1 {
            code: "MUTATION_OUTCOME_UNKNOWN".into(),
            message: "mutation outcome is unknown; reconcile durable state before retrying".into(),
        }),
    }
}

fn validate_response(
    request: &McpServiceRequestV1,
    service_id: &str,
    response: &McpServiceResponseV1,
) -> Result<(), McpGatewayError> {
    response.validate_for(request, service_id)?;
    Ok(())
}

/// Fail-closed Gateway failures.
#[derive(Debug, Error)]
pub enum McpGatewayError {
    /// Request contract is invalid.
    #[error(transparent)]
    Contract(#[from] McpServiceContractError),
    /// Transport principal could not be authenticated by the host.
    #[error("MCP transport principal authentication failed")]
    AuthenticationFailed,
    /// The host supplied a malformed or unbounded transport identity.
    #[error("MCP authenticated transport context is invalid")]
    InvalidTransportContext,
    /// Caller is not authorized for exact operation.
    #[error("MCP service authorization denied")]
    AuthorizationDenied,
    /// Caller-declared effect class differs from the service-owned route registry.
    #[error("MCP request side-effect class does not match the service route")]
    SideEffectClassMismatch,
    /// Authenticated principal targets a different application service.
    #[error("MCP principal audience does not match application service")]
    AudienceMismatch,
    /// Application service is unavailable or rejected operation.
    #[error("MCP application service unavailable: {0}")]
    Service(String),
    /// Service returned mismatched or ambiguous response.
    #[error("MCP application service returned invalid response")]
    InvalidResponse,
    /// Service returned duplicate, malformed, or unsafe capability metadata.
    #[error("MCP application service returned invalid capability metadata")]
    InvalidCapabilities,
    /// Application service identity is malformed or unsafe.
    #[error("MCP application service identity is invalid")]
    InvalidServiceIdentity,
}

fn validate_service_identity(service_id: &str) -> Result<(), McpGatewayError> {
    if service_id.trim().is_empty()
        || service_id != service_id.trim()
        || service_id.len() > 256
        || service_id.chars().any(char::is_control)
    {
        return Err(McpGatewayError::InvalidServiceIdentity);
    }
    Ok(())
}

fn valid_transport_identity(identity: &str, max_bytes: usize) -> bool {
    !identity.trim().is_empty()
        && identity == identity.trim()
        && identity.len() <= max_bytes
        && !identity.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Service {
        writes: AtomicUsize,
        reads: AtomicUsize,
        authorizations: AtomicUsize,
        allow: bool,
        wrong_response_binding: bool,
        oversized_capabilities: bool,
    }
    impl McpApplicationService for Service {
        fn service_id(&self) -> &str {
            "control"
        }
        fn discover_capabilities(
            &self,
            _: &McpPrincipalV1,
        ) -> Result<Vec<McpCapability>, McpGatewayError> {
            if self.oversized_capabilities {
                Ok((0..5_000)
                    .map(|index| McpCapability {
                        id: format!("capability-{index:04}-{}", "x".repeat(240)),
                        operation: McpServiceOperation::CallTool,
                        side_effect_class: McpSideEffectClass::ReadOnly,
                    })
                    .collect())
            } else {
                Ok(vec![McpCapability {
                    id: "workflow.read".into(),
                    operation: McpServiceOperation::CallTool,
                    side_effect_class: McpSideEffectClass::ReadOnly,
                }])
            }
        }
        fn expected_side_effect_class(
            &self,
            request: &McpServiceRequestV1,
        ) -> Result<McpSideEffectClass, McpGatewayError> {
            match (request.operation, request.name.as_deref()) {
                (McpServiceOperation::DiscoverCapabilities, None)
                | (McpServiceOperation::ReadResource, Some(_))
                | (McpServiceOperation::GetPrompt, Some(_)) => Ok(McpSideEffectClass::ReadOnly),
                (McpServiceOperation::CallTool, Some("workflow_get")) => {
                    Ok(McpSideEffectClass::ReadOnly)
                }
                (McpServiceOperation::CallTool, Some("workflow_create")) => {
                    Ok(McpSideEffectClass::Mutating)
                }
                _ => Err(McpGatewayError::AuthorizationDenied),
            }
        }
        fn authorize(&self, request: &McpServiceRequestV1) -> Result<(), McpGatewayError> {
            self.authorizations.fetch_add(1, Ordering::SeqCst);
            if !self.allow {
                return Err(McpGatewayError::AuthorizationDenied);
            }
            match (
                request.operation,
                request.capability.as_str(),
                request.name.as_deref(),
                request.side_effect_class,
            ) {
                (
                    McpServiceOperation::DiscoverCapabilities,
                    _,
                    None,
                    McpSideEffectClass::ReadOnly,
                ) => Ok(()),
                (
                    McpServiceOperation::CallTool,
                    "workflow.read",
                    Some("workflow_get"),
                    McpSideEffectClass::ReadOnly,
                ) if request
                    .arguments
                    .get("workflow_id")
                    .and_then(|value| value.as_str())
                    == Some("job_1") =>
                {
                    Ok(())
                }
                (
                    McpServiceOperation::CallTool,
                    "workflow.create",
                    Some("workflow_create"),
                    McpSideEffectClass::Mutating,
                ) => Ok(()),
                _ => Err(McpGatewayError::AuthorizationDenied),
            }
        }
        fn invoke_read_only(
            &self,
            request: &McpServiceRequestV1,
        ) -> Result<McpServiceResponseV1, McpGatewayError> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            let mut response = response(request, Some(serde_json::json!({"ok":true})), None);
            if self.wrong_response_binding {
                response.request_id = "other-request".into();
            }
            Ok(response)
        }
        fn invoke_mutating(
            &self,
            request: &McpServiceRequestV1,
        ) -> Result<McpServiceResponseV1, McpGatewayError> {
            self.writes.fetch_add(1, Ordering::SeqCst);
            let mut response = response(request, Some(serde_json::json!({"ok":true})), None);
            if self.wrong_response_binding {
                response.request_id = "other-request".into();
            }
            Ok(response)
        }
    }

    struct ControlCharacterCapabilityService {
        authorizations: AtomicUsize,
        capability_id: String,
    }

    struct CommitThenErrorService {
        mutations: AtomicUsize,
    }

    impl McpApplicationService for CommitThenErrorService {
        fn service_id(&self) -> &str {
            "control"
        }

        fn discover_capabilities(
            &self,
            _: &McpPrincipalV1,
        ) -> Result<Vec<McpCapability>, McpGatewayError> {
            unreachable!("mutation test does not discover capabilities")
        }

        fn expected_side_effect_class(
            &self,
            request: &McpServiceRequestV1,
        ) -> Result<McpSideEffectClass, McpGatewayError> {
            if request.operation == McpServiceOperation::CallTool
                && request.name.as_deref() == Some("workflow_create")
            {
                Ok(McpSideEffectClass::Mutating)
            } else {
                Err(McpGatewayError::AuthorizationDenied)
            }
        }

        fn authorize(&self, _: &McpServiceRequestV1) -> Result<(), McpGatewayError> {
            Ok(())
        }

        fn invoke_read_only(
            &self,
            _: &McpServiceRequestV1,
        ) -> Result<McpServiceResponseV1, McpGatewayError> {
            unreachable!("mutation test does not invoke a read")
        }

        fn invoke_mutating(
            &self,
            _: &McpServiceRequestV1,
        ) -> Result<McpServiceResponseV1, McpGatewayError> {
            self.mutations.fetch_add(1, Ordering::SeqCst);
            Err(McpGatewayError::Service(
                "connection lost after durable commit".into(),
            ))
        }
    }

    impl McpApplicationService for ControlCharacterCapabilityService {
        fn service_id(&self) -> &str {
            "control"
        }

        fn discover_capabilities(
            &self,
            _: &McpPrincipalV1,
        ) -> Result<Vec<McpCapability>, McpGatewayError> {
            Ok(vec![McpCapability {
                id: self.capability_id.clone(),
                operation: McpServiceOperation::CallTool,
                side_effect_class: McpSideEffectClass::ReadOnly,
            }])
        }

        fn expected_side_effect_class(
            &self,
            request: &McpServiceRequestV1,
        ) -> Result<McpSideEffectClass, McpGatewayError> {
            if request.operation == McpServiceOperation::DiscoverCapabilities {
                Ok(McpSideEffectClass::ReadOnly)
            } else {
                Err(McpGatewayError::AuthorizationDenied)
            }
        }

        fn authorize(&self, _: &McpServiceRequestV1) -> Result<(), McpGatewayError> {
            self.authorizations.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn invoke_read_only(
            &self,
            _: &McpServiceRequestV1,
        ) -> Result<McpServiceResponseV1, McpGatewayError> {
            unreachable!("capability discovery must never invoke a tool")
        }

        fn invoke_mutating(
            &self,
            _: &McpServiceRequestV1,
        ) -> Result<McpServiceResponseV1, McpGatewayError> {
            unreachable!("capability discovery must never invoke a tool")
        }
    }

    struct Authenticator {
        allow: bool,
    }

    impl McpTransportPrincipalAuthenticator for Authenticator {
        fn authenticate(
            &self,
            _: &AuthenticatedMcpTransportContext,
            _: &McpPrincipalV1,
        ) -> Result<(), McpGatewayError> {
            if self.allow {
                Ok(())
            } else {
                Err(McpGatewayError::AuthenticationFailed)
            }
        }
    }

    struct TestGateway<S> {
        inner: McpGateway<S>,
        transport: AuthenticatedMcpTransportContext,
    }

    impl<S: McpApplicationService> TestGateway<S> {
        fn handle(
            &self,
            request: &McpServiceRequestV1,
        ) -> Result<McpServiceResponseV1, McpGatewayError> {
            self.inner.handle(&self.transport, request)
        }
    }

    impl<S> std::ops::Deref for TestGateway<S> {
        type Target = McpGateway<S>;

        fn deref(&self) -> &Self::Target {
            &self.inner
        }
    }

    fn test_transport() -> AuthenticatedMcpTransportContext {
        AuthenticatedMcpTransportContext::from_authenticated_peer("connection-1", "uid:1000")
            .unwrap()
    }

    fn test_gateway<S: McpApplicationService>(
        service: S,
        authenticator: Arc<dyn McpTransportPrincipalAuthenticator>,
    ) -> TestGateway<S> {
        TestGateway {
            inner: McpGateway::new(service, authenticator),
            transport: test_transport(),
        }
    }

    fn gateway(service: Service, authenticated: bool) -> TestGateway<Service> {
        test_gateway(
            service,
            Arc::new(Authenticator {
                allow: authenticated,
            }),
        )
    }

    fn response(
        request: &McpServiceRequestV1,
        result: Option<serde_json::Value>,
        error: Option<runalith_protocol::mcp_service_v1::McpServiceErrorV1>,
    ) -> McpServiceResponseV1 {
        McpServiceResponseV1 {
            schema_version: 1,
            request_id: request.request_id.clone(),
            service_id: "control".into(),
            outcome: if error.is_some() {
                McpServiceOutcome::Denied
            } else {
                McpServiceOutcome::Success
            },
            result,
            error,
        }
    }

    fn request(effect: McpSideEffectClass) -> McpServiceRequestV1 {
        McpServiceRequestV1 {
            schema_version: 1,
            request_id: "req-1".into(),
            correlation_id: "trace-1".into(),
            principal: McpPrincipalV1 {
                subject: "operator".into(),
                issuer: "gateway".into(),
                audience: "control".into(),
                authentication_context: "mtls".into(),
            },
            operation: McpServiceOperation::CallTool,
            capability: "workflow.read".into(),
            side_effect_class: effect,
            name: Some("workflow_get".into()),
            arguments: serde_json::json!({"workflow_id":"job_1"}),
            idempotency_key: if effect == McpSideEffectClass::Mutating {
                Some("idem-1".into())
            } else {
                None
            },
        }
    }

    #[test]
    fn read_only_route_never_calls_mutation_api() {
        let service = Service {
            writes: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
            authorizations: AtomicUsize::new(0),
            allow: true,
            wrong_response_binding: false,
            oversized_capabilities: false,
        };
        let gateway = gateway(service, true);
        gateway
            .handle(&request(McpSideEffectClass::ReadOnly))
            .unwrap();
        assert_eq!(gateway.service.reads.load(Ordering::SeqCst), 1);
        assert_eq!(gateway.service.writes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn authorization_denial_precedes_any_service_invocation() {
        let service = Service {
            writes: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
            authorizations: AtomicUsize::new(0),
            allow: false,
            wrong_response_binding: false,
            oversized_capabilities: false,
        };
        let gateway = gateway(service, true);
        let mut request = request(McpSideEffectClass::Mutating);
        request.name = Some("workflow_create".into());
        request.capability = "workflow.create".into();
        assert!(matches!(
            gateway.handle(&request),
            Err(McpGatewayError::AuthorizationDenied)
        ));
        assert_eq!(gateway.service.reads.load(Ordering::SeqCst), 0);
        assert_eq!(gateway.service.writes.load(Ordering::SeqCst), 0);
        assert_eq!(gateway.service.authorizations.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn transport_authentication_precedes_caller_request_validation() {
        let service = Service {
            writes: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
            authorizations: AtomicUsize::new(0),
            allow: true,
            wrong_response_binding: false,
            oversized_capabilities: false,
        };
        let gateway = gateway(service, false);
        let mut request = request(McpSideEffectClass::ReadOnly);
        request.correlation_id.clear();

        assert!(matches!(
            gateway.handle(&request),
            Err(McpGatewayError::AuthenticationFailed)
        ));
        assert_eq!(gateway.service.authorizations.load(Ordering::SeqCst), 0);
        assert_eq!(gateway.service.reads.load(Ordering::SeqCst), 0);
        assert_eq!(gateway.service.writes.load(Ordering::SeqCst), 0);
    }

    struct BoundAuthenticator {
        connection_id: String,
        peer_identity: String,
        subject: String,
        issuer: String,
        audience: String,
        authentication_context: String,
    }

    impl McpTransportPrincipalAuthenticator for BoundAuthenticator {
        fn authenticate(
            &self,
            transport: &AuthenticatedMcpTransportContext,
            principal: &McpPrincipalV1,
        ) -> Result<(), McpGatewayError> {
            if transport.connection_id() == self.connection_id
                && transport.peer_identity() == self.peer_identity
                && principal.subject == self.subject
                && principal.issuer == self.issuer
                && principal.audience == self.audience
                && principal.authentication_context == self.authentication_context
            {
                Ok(())
            } else {
                Err(McpGatewayError::AuthenticationFailed)
            }
        }
    }

    #[test]
    fn transport_principal_must_match_connection_bound_identity() {
        let service = Service {
            writes: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
            authorizations: AtomicUsize::new(0),
            allow: true,
            wrong_response_binding: false,
            oversized_capabilities: false,
        };
        let request = request(McpSideEffectClass::ReadOnly);
        let expected = request.principal.clone();
        let gateway = McpGateway::new(
            service,
            Arc::new(BoundAuthenticator {
                connection_id: "connection-1".into(),
                peer_identity: "uid:1000".into(),
                subject: expected.subject,
                issuer: expected.issuer,
                audience: expected.audience,
                authentication_context: expected.authentication_context,
            }),
        );

        // Request principal matches its expected claims, but the host-supplied
        // transport context is for a different connection/peer.
        assert!(matches!(
            gateway.handle(
                &AuthenticatedMcpTransportContext::from_authenticated_peer(
                    "connection-2",
                    "uid:2000"
                )
                .unwrap(),
                &request
            ),
            Err(McpGatewayError::AuthenticationFailed)
        ));

        let mut forged_request = request.clone();
        forged_request.principal.subject = "different-principal".into();
        assert!(matches!(
            gateway.handle(&test_transport(), &forged_request),
            Err(McpGatewayError::AuthenticationFailed)
        ));
        assert_eq!(gateway.service.authorizations.load(Ordering::SeqCst), 0);
        assert_eq!(gateway.service.reads.load(Ordering::SeqCst), 0);
        assert_eq!(gateway.service.writes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn authenticated_transport_context_rejects_unbounded_or_controlled_peer_identity() {
        assert!(matches!(
            AuthenticatedMcpTransportContext::from_authenticated_peer(
                "connection-1",
                "peer\nforged"
            ),
            Err(McpGatewayError::InvalidTransportContext)
        ));
        assert!(matches!(
            AuthenticatedMcpTransportContext::from_authenticated_peer("c".repeat(257), "peer-1"),
            Err(McpGatewayError::InvalidTransportContext)
        ));
        assert!(
            AuthenticatedMcpTransportContext::from_authenticated_peer("connection-1", "uid:1000")
                .is_ok()
        );
    }

    #[test]
    fn service_authorization_receives_exact_tool_name_and_effect_class() {
        let service = Service {
            writes: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
            authorizations: AtomicUsize::new(0),
            allow: true,
            wrong_response_binding: false,
            oversized_capabilities: false,
        };
        let gateway = gateway(service, true);
        let mut request = request(McpSideEffectClass::Mutating);
        request.name = Some("workflow_create".into());
        request.capability = "workflow.create".into();
        request.idempotency_key = Some("idem-1".into());

        gateway.handle(&request).unwrap();
        assert_eq!(gateway.service.authorizations.load(Ordering::SeqCst), 1);
        assert_eq!(gateway.service.reads.load(Ordering::SeqCst), 0);
        assert_eq!(gateway.service.writes.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn caller_cannot_downgrade_mutation_or_upgrade_read_to_mutation() {
        let service = Service {
            writes: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
            authorizations: AtomicUsize::new(0),
            allow: true,
            wrong_response_binding: false,
            oversized_capabilities: false,
        };
        let gateway = gateway(service, true);

        let mut downgraded = request(McpSideEffectClass::ReadOnly);
        downgraded.capability = "workflow.create".into();
        downgraded.name = Some("workflow_create".into());
        assert!(matches!(
            gateway.handle(&downgraded),
            Err(McpGatewayError::SideEffectClassMismatch)
        ));

        let mut upgraded = request(McpSideEffectClass::Mutating);
        upgraded.idempotency_key = Some("idem-1".into());
        assert!(matches!(
            gateway.handle(&upgraded),
            Err(McpGatewayError::SideEffectClassMismatch)
        ));

        assert_eq!(gateway.service.authorizations.load(Ordering::SeqCst), 0);
        assert_eq!(gateway.service.reads.load(Ordering::SeqCst), 0);
        assert_eq!(gateway.service.writes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn service_authorization_receives_exact_resource_arguments() {
        let service = Service {
            writes: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
            authorizations: AtomicUsize::new(0),
            allow: true,
            wrong_response_binding: false,
            oversized_capabilities: false,
        };
        let gateway = gateway(service, true);
        let mut request = request(McpSideEffectClass::ReadOnly);
        request.arguments["workflow_id"] = serde_json::json!("job_other");

        assert!(matches!(
            gateway.handle(&request),
            Err(McpGatewayError::AuthorizationDenied)
        ));
        assert_eq!(gateway.service.authorizations.load(Ordering::SeqCst), 1);
        assert_eq!(gateway.service.reads.load(Ordering::SeqCst), 0);
        assert_eq!(gateway.service.writes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn service_authorization_rejects_read_tool_claimed_as_mutating() {
        let service = Service {
            writes: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
            authorizations: AtomicUsize::new(0),
            allow: true,
            wrong_response_binding: false,
            oversized_capabilities: false,
        };
        let gateway = gateway(service, true);
        let request = request(McpSideEffectClass::Mutating);

        assert!(matches!(
            gateway.handle(&request),
            Err(McpGatewayError::SideEffectClassMismatch)
        ));
        assert_eq!(gateway.service.authorizations.load(Ordering::SeqCst), 0);
        assert_eq!(gateway.service.reads.load(Ordering::SeqCst), 0);
        assert_eq!(gateway.service.writes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn correctly_classified_mutating_tool_uses_only_mutation_service_method() {
        let service = Service {
            writes: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
            authorizations: AtomicUsize::new(0),
            allow: true,
            wrong_response_binding: false,
            oversized_capabilities: false,
        };
        let gateway = gateway(service, true);
        let mut request = request(McpSideEffectClass::Mutating);
        request.name = Some("workflow_create".into());
        request.capability = "workflow.create".into();

        gateway.handle(&request).unwrap();

        assert_eq!(gateway.service.authorizations.load(Ordering::SeqCst), 1);
        assert_eq!(gateway.service.reads.load(Ordering::SeqCst), 0);
        assert_eq!(gateway.service.writes.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn mismatched_service_response_cannot_cross_gateway_boundary() {
        let service = Service {
            writes: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
            authorizations: AtomicUsize::new(0),
            allow: true,
            wrong_response_binding: true,
            oversized_capabilities: false,
        };
        let gateway = gateway(service, true);
        assert!(matches!(
            gateway.handle(&request(McpSideEffectClass::ReadOnly)),
            Err(McpGatewayError::Contract(
                McpServiceContractError::ResponseBindingMismatch
            ))
        ));
    }

    #[test]
    fn mutation_transport_error_returns_bound_unknown_outcome_instead_of_client_failure() {
        let service = CommitThenErrorService {
            mutations: AtomicUsize::new(0),
        };
        let gateway = test_gateway(service, Arc::new(Authenticator { allow: true }));
        let mut request = request(McpSideEffectClass::Mutating);
        request.name = Some("workflow_create".into());
        request.capability = "workflow.create".into();

        let response = gateway.handle(&request).unwrap();

        assert_eq!(gateway.service.mutations.load(Ordering::SeqCst), 1);
        assert_eq!(response.request_id, request.request_id);
        assert_eq!(response.service_id, "control");
        assert_eq!(response.outcome, McpServiceOutcome::Unknown);
        assert_eq!(response.result, None);
        assert_eq!(
            response.error.as_ref().map(|error| error.code.as_str()),
            Some("MUTATION_OUTCOME_UNKNOWN")
        );
        response.validate_for(&request, "control").unwrap();
    }

    #[test]
    fn invalid_mutation_response_binding_is_reported_as_unknown_outcome() {
        let service = Service {
            writes: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
            authorizations: AtomicUsize::new(0),
            allow: true,
            wrong_response_binding: true,
            oversized_capabilities: false,
        };
        let gateway = gateway(service, true);
        let mut request = request(McpSideEffectClass::Mutating);
        request.name = Some("workflow_create".into());
        request.capability = "workflow.create".into();

        let response = gateway.handle(&request).unwrap();

        assert_eq!(gateway.service.writes.load(Ordering::SeqCst), 1);
        assert_eq!(response.request_id, request.request_id);
        assert_eq!(response.outcome, McpServiceOutcome::Unknown);
        assert_eq!(
            response.error.as_ref().map(|error| error.code.as_str()),
            Some("MUTATION_OUTCOME_UNKNOWN")
        );
    }

    #[test]
    fn wrong_principal_audience_is_rejected_before_service_call() {
        let service = Service {
            writes: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
            authorizations: AtomicUsize::new(0),
            allow: true,
            wrong_response_binding: false,
            oversized_capabilities: false,
        };
        let gateway = gateway(service, true);
        let mut request = request(McpSideEffectClass::ReadOnly);
        request.principal.audience = "execution".into();
        assert!(matches!(
            gateway.handle(&request),
            Err(McpGatewayError::AudienceMismatch)
        ));
        assert_eq!(gateway.service.reads.load(Ordering::SeqCst), 0);
        assert_eq!(gateway.service.writes.load(Ordering::SeqCst), 0);
        assert_eq!(gateway.service.authorizations.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn capability_discovery_is_authorized_before_catalog_access() {
        let service = Service {
            writes: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
            authorizations: AtomicUsize::new(0),
            allow: false,
            wrong_response_binding: false,
            oversized_capabilities: false,
        };
        let gateway = gateway(service, true);
        let mut request = request(McpSideEffectClass::ReadOnly);
        request.operation = McpServiceOperation::DiscoverCapabilities;
        request.name = None;
        assert!(matches!(
            gateway.handle(&request),
            Err(McpGatewayError::AuthorizationDenied)
        ));
        assert_eq!(gateway.service.reads.load(Ordering::SeqCst), 0);
        assert_eq!(gateway.service.writes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn oversized_capability_catalog_is_rejected_before_gateway_response() {
        let service = Service {
            writes: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
            authorizations: AtomicUsize::new(0),
            allow: true,
            wrong_response_binding: false,
            oversized_capabilities: true,
        };
        let gateway = gateway(service, true);
        let mut request = request(McpSideEffectClass::ReadOnly);
        request.operation = McpServiceOperation::DiscoverCapabilities;
        request.name = None;
        assert!(matches!(
            gateway.handle(&request),
            Err(McpGatewayError::InvalidCapabilities)
        ));
    }

    #[test]
    fn unauthenticated_transport_principal_is_rejected_before_service_access() {
        let service = Service {
            writes: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
            authorizations: AtomicUsize::new(0),
            allow: true,
            wrong_response_binding: false,
            oversized_capabilities: false,
        };
        let gateway = gateway(service, false);
        assert!(matches!(
            gateway.handle(&request(McpSideEffectClass::ReadOnly)),
            Err(McpGatewayError::AuthenticationFailed)
        ));
        assert_eq!(gateway.service.authorizations.load(Ordering::SeqCst), 0);
        assert_eq!(gateway.service.reads.load(Ordering::SeqCst), 0);
        assert_eq!(gateway.service.writes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn service_authorization_rejects_capability_rebinding() {
        let service = Service {
            writes: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
            authorizations: AtomicUsize::new(0),
            allow: true,
            wrong_response_binding: false,
            oversized_capabilities: false,
        };
        let gateway = gateway(service, true);
        let mut request = request(McpSideEffectClass::ReadOnly);
        request.capability = "workflow.create".into();

        assert!(matches!(
            gateway.handle(&request),
            Err(McpGatewayError::AuthorizationDenied)
        ));
        assert_eq!(gateway.service.authorizations.load(Ordering::SeqCst), 1);
        assert_eq!(gateway.service.reads.load(Ordering::SeqCst), 0);
        assert_eq!(gateway.service.writes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn capability_discovery_rejects_control_characters_in_capability_ids() {
        for capability_id in [
            "workflow.read\r\nforged:admin",
            "workflow.read\0forged",
            " workflow.read",
            "workflow.read ",
        ] {
            let service = ControlCharacterCapabilityService {
                authorizations: AtomicUsize::new(0),
                capability_id: capability_id.into(),
            };
            let gateway = test_gateway(service, Arc::new(Authenticator { allow: true }));
            let mut request = request(McpSideEffectClass::ReadOnly);
            request.operation = McpServiceOperation::DiscoverCapabilities;
            request.name = None;

            assert!(matches!(
                gateway.handle(&request),
                Err(McpGatewayError::InvalidCapabilities)
            ));
            assert_eq!(gateway.service.authorizations.load(Ordering::SeqCst), 1);
        }
    }
}
