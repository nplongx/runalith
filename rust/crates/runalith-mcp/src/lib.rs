//! Dual-era MCP stdio host for the Rust Runalith runtime.
//!
//! Implements modern MCP `2026-07-28` per-request metadata and `server/discover`,
//! plus the `2025-11-25` initialize handshake for older clients. It is a local
//! protocol adapter, not a provider-network adapter or a source of trust authority.
//! Optional local execution is injected as a separate fail-closed sandbox capability.

pub mod service_gateway;

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use runalith_agg::discriminator::validate_discriminator_model;
use runalith_agg::mcts::{MctsOptions, mcts_shadow_search};
use runalith_agg::phase2::rank_search_candidates;
use runalith_agg::{SearchOptions, project_plan, project_snapshot, search as search_agg};
use runalith_artifacts::ArtifactStore;
use runalith_domain::{
    EvidenceRef, GraphEdge, GraphEvidence, GraphNodeRevision, TaskOutcome, WorkflowProposal,
};
use runalith_execution::ExecutionGraphSnapshot;
use runalith_protocol::mcp_service_v1::{
    McpPrincipalV1, McpServiceOperation, McpServiceOutcome, McpServiceRequestV1,
    McpServiceResponseV1, McpSideEffectClass,
};
use runalith_providers::ProviderAdapter;
use runalith_runtime::{
    AgentSessionCreateRequest, ApprovalRequest, CatalogAuthorVerifier, ClaimRequest,
    DenyAllApprovalVerifier, RuntimeError, SandboxTaskExecutionRequest, SessionAccessRequest,
    SessionDeliveryReceipt, SessionMessageRequest, SessionPermission, Store, TaskResultEnvelope,
    TaskResultProducerVerifier, TaskResultRequest, TrustedSkillResolver, WorkflowPolicyDefinition,
    WorkflowService,
};
use runalith_sandbox::{CommandRequest, SandboxExecutor};
use serde_json::{Value, json};
use service_gateway::{
    AuthenticatedMcpTransportContext, McpApplicationService, McpCapability, McpGateway,
    McpGatewayError, McpTransportPrincipalAuthenticator,
};
use thiserror::Error;

/// Current stateless MCP protocol revision.
pub const MCP_MODERN_VERSION: &str = "2026-07-28";
/// Previous handshake-based MCP protocol revision.
pub const MCP_LEGACY_VERSION: &str = "2025-11-25";
/// Maximum accepted UTF-8 JSON-RPC frame size.
pub const MAX_MCP_FRAME_BYTES: usize = 1_048_576;

const SERVER_NAME: &str = "runalith";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
const SERVER_INFO_META_KEY: &str = "io.modelcontextprotocol/serverInfo";
const PROTOCOL_VERSION_META_KEY: &str = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META_KEY: &str = "io.modelcontextprotocol/clientCapabilities";

/// Stateful stdio connection adapter. Application workflow state lives in SQLite,
/// not in MCP connection state.
pub struct McpServer {
    service: Arc<WorkflowService>,
    graph_store: Option<Arc<Store>>,
    database_path: Option<PathBuf>,
    sandbox_executor: Option<Arc<dyn SandboxExecutor>>,
    artifact_store: Option<Arc<ArtifactStore>>,
    provider_adapters: BTreeMap<String, Arc<dyn ProviderAdapter>>,
    task_result_verifier: Option<Arc<dyn TaskResultProducerVerifier>>,
    catalog_author_verifier: Option<Arc<dyn CatalogAuthorVerifier>>,
    trusted_skill_resolver: Option<Arc<dyn TrustedSkillResolver>>,
    local_gateway_identity: Option<LocalGatewayIdentity>,
    mode: Mutex<ConnectionMode>,
}

#[derive(Clone)]
struct LocalGatewayIdentity {
    transport: AuthenticatedMcpTransportContext,
    principal: McpPrincipalV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnectionMode {
    Unselected,
    Modern,
    LegacyAwaitingInitialized,
    LegacyReady,
}

/// JSON-RPC request handling error.
#[derive(Debug, Error)]
pub enum McpError {
    /// MCP request frame is too large or empty.
    #[error("MCP frame is empty or exceeds {MAX_MCP_FRAME_BYTES} bytes")]
    FrameSize,
    /// Request is malformed JSON-RPC.
    #[error("invalid JSON-RPC request: {0}")]
    Json(#[from] serde_json::Error),
    /// Internal adapter/runtime failure.
    #[error("MCP request failed: {0}")]
    Runtime(String),
    /// MCP frame has an invalid structure.
    #[error("invalid JSON-RPC request structure: {0}")]
    InvalidRequest(&'static str),
}

impl McpServer {
    /// Create a server with the default reject-all approval authority.
    #[must_use]
    pub fn new(store: Arc<Store>) -> Self {
        let service = Arc::new(WorkflowService::new(
            store.clone(),
            Arc::new(DenyAllApprovalVerifier),
        ));
        Self::with_service_and_store(service, store)
    }

    /// Create a server with an explicitly composed service, useful for host integration and tests.
    #[must_use]
    pub fn with_service(service: Arc<WorkflowService>) -> Self {
        Self {
            service,
            graph_store: None,
            database_path: None,
            sandbox_executor: None,
            artifact_store: None,
            provider_adapters: BTreeMap::new(),
            task_result_verifier: None,
            catalog_author_verifier: None,
            trusted_skill_resolver: None,
            local_gateway_identity: None,
            mode: Mutex::new(ConnectionMode::Unselected),
        }
    }

    /// Compose workflow and graph services over one Rust-owned SQLite database.
    #[must_use]
    pub fn with_service_and_store(service: Arc<WorkflowService>, store: Arc<Store>) -> Self {
        Self {
            service,
            graph_store: Some(store),
            database_path: None,
            sandbox_executor: None,
            artifact_store: None,
            provider_adapters: BTreeMap::new(),
            task_result_verifier: None,
            catalog_author_verifier: None,
            trusted_skill_resolver: None,
            local_gateway_identity: None,
            mode: Mutex::new(ConnectionMode::Unselected),
        }
    }

    /// Provide the host-owned database path for strictly read-only health inspection.
    /// The path is never opened for writing by this capability.
    #[must_use]
    pub fn with_database_path(mut self, path: PathBuf) -> Self {
        self.database_path = Some(path);
        self
    }

    /// Enable result ingestion only with a host-owned producer authenticator.
    #[must_use]
    pub fn with_task_result_verifier(
        mut self,
        verifier: Arc<dyn TaskResultProducerVerifier>,
    ) -> Self {
        self.task_result_verifier = Some(verifier);
        self
    }

    /// Enable catalog mutations only with a host-owned authenticated principal resolver.
    #[must_use]
    pub fn with_catalog_author_verifier(
        mut self,
        verifier: Arc<dyn CatalogAuthorVerifier>,
    ) -> Self {
        self.catalog_author_verifier = Some(verifier);
        self
    }

    /// Enable skill-bearing catalog roles only with a host-owned trusted skill resolver.
    #[must_use]
    pub fn with_trusted_skill_resolver(mut self, resolver: Arc<dyn TrustedSkillResolver>) -> Self {
        self.trusted_skill_resolver = Some(resolver);
        self
    }

    /// Enable sandbox execution only when host explicitly provisions both backend and artifact store.
    #[must_use]
    pub fn with_sandbox_execution(
        mut self,
        executor: Arc<dyn SandboxExecutor>,
        artifacts: Arc<ArtifactStore>,
    ) -> Self {
        self.sandbox_executor = Some(executor);
        self.artifact_store = Some(artifacts);
        self
    }

    /// Register a provider adapter for lookup/reconciliation only when host explicitly provisions it.
    #[must_use]
    pub fn with_provider_adapter(mut self, adapter: Arc<dyn ProviderAdapter>) -> Self {
        self.provider_adapters
            .insert(adapter.provider_id().to_owned(), adapter);
        self
    }

    /// Require every operational stdio request to pass through a local,
    /// authenticated, read-only MCP Gateway. Mutating routes are deliberately
    /// denied until a durable request-idempotency adapter is provisioned by the
    /// owning service. The transport identity must be created by the host from
    /// authenticated OS peer state, never from MCP request JSON.
    #[must_use]
    pub fn with_local_read_only_gateway(
        mut self,
        transport: AuthenticatedMcpTransportContext,
        principal: McpPrincipalV1,
    ) -> Self {
        self.local_gateway_identity = Some(LocalGatewayIdentity {
            transport,
            principal,
        });
        self
    }

    /// Handle one newline-delimited JSON-RPC frame.
    ///
    /// Returns `None` for notifications, which have no JSON-RPC response.
    fn handle_frame(&self, frame: &[u8]) -> Result<Option<Vec<u8>>, McpError> {
        if frame.is_empty() || frame.len() > MAX_MCP_FRAME_BYTES {
            return Err(McpError::FrameSize);
        }
        let request: Value = serde_json::from_slice(frame)?;
        let object = request
            .as_object()
            .ok_or(McpError::InvalidRequest("root must be an object"))?;
        if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Err(McpError::InvalidRequest("jsonrpc must equal 2.0"));
        }
        let method = object
            .get("method")
            .and_then(Value::as_str)
            .ok_or(McpError::InvalidRequest("method must be a string"))?;
        let id = object.get("id").cloned();
        let params = object.get("params").cloned().unwrap_or_else(|| json!({}));

        if let Some(request_id) = id.as_ref()
            && !valid_json_rpc_request_id(request_id)
        {
            return self.protocol_error(
                None,
                -32600,
                "request id must be a bounded string or finite number",
                None,
            );
        }
        if !params.is_object() {
            return self.protocol_error(id, -32602, "params must be an object", None);
        }

        if id.is_none() {
            return self.handle_notification(method, &params);
        }

        let request_id = id.as_ref().expect("request ID exists");

        let response = self.dispatch(method, &params, request_id);
        match response {
            Ok(result) => {
                let response_id = id.expect("request ID exists");
                let response_bytes = match self.success_response_bytes(response_id.clone(), result)
                {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        if mutating_tool_call(method, &params) {
                            return self.mutation_outcome_unknown(response_id);
                        }
                        return Err(error);
                    }
                };
                if response_bytes.len() > MAX_MCP_FRAME_BYTES {
                    if mutating_tool_call(method, &params) {
                        return self.mutation_outcome_unknown(response_id);
                    }
                    return self.protocol_error(
                        Some(response_id),
                        -32603,
                        "MCP response exceeds configured frame byte limit",
                        None,
                    );
                }
                Ok(Some(response_bytes))
            }
            Err(error) => {
                let (code, message, data) = map_error(error);
                self.protocol_error(id, code, &message, data)
            }
        }
    }

    fn mutation_outcome_unknown(&self, request_id: Value) -> Result<Option<Vec<u8>>, McpError> {
        self.protocol_error(
            Some(request_id),
            -32003,
            "mutation outcome is unknown; reconcile durable state before retrying",
            Some(json!({
                "code":"MUTATION_OUTCOME_UNKNOWN",
                "reconciliation_required":true,
                "automatic_retry":false
            })),
        )
    }

    fn handle_notification(
        &self,
        method: &str,
        _params: &Value,
    ) -> Result<Option<Vec<u8>>, McpError> {
        if method == "notifications/initialized" {
            let mut mode = self
                .mode
                .lock()
                .map_err(|_| McpError::Runtime("MCP mode mutex poisoned".into()))?;
            if *mode == ConnectionMode::LegacyAwaitingInitialized {
                *mode = ConnectionMode::LegacyReady;
            }
        }
        // Notifications never receive JSON-RPC responses. Modern MCP 2026 has
        // no legacy server-initiated notification channel.
        Ok(None)
    }

    fn gateway_request(
        &self,
        id: &Value,
        operation: McpServiceOperation,
        capability: &str,
        side_effect_class: McpSideEffectClass,
        name: Option<String>,
        arguments: Value,
    ) -> Result<McpServiceResponseV1, DispatchError> {
        let identity = self
            .local_gateway_identity
            .as_ref()
            .ok_or(DispatchError::Internal(
                "local MCP Gateway identity is not configured".into(),
            ))?;
        let request = McpServiceRequestV1 {
            schema_version: 1,
            request_id: id.to_string(),
            correlation_id: format!("stdio:{}", identity.transport.connection_id()),
            principal: identity.principal.clone(),
            operation,
            capability: capability.to_owned(),
            side_effect_class,
            name,
            arguments,
            // No durable MCP idempotency repository exists in this host. Do
            // not substitute the transient JSON-RPC request ID for one.
            idempotency_key: None,
        };
        let service = LocalMcpApplicationService {
            server: self,
            expected_principal: &identity.principal,
        };
        let authenticator = LocalMcpPrincipalAuthenticator {
            expected_transport: identity.transport.clone(),
            expected_principal: identity.principal.clone(),
        };
        let gateway = McpGateway::new(service, Arc::new(authenticator));
        gateway
            .handle(&identity.transport, &request)
            .map_err(map_gateway_error)
    }

    fn gateway_discover(&self, id: &Value) -> Result<Vec<McpCapability>, DispatchError> {
        let response = self.gateway_request(
            id,
            McpServiceOperation::DiscoverCapabilities,
            "capabilities.read",
            McpSideEffectClass::ReadOnly,
            None,
            json!({}),
        )?;
        serde_json::from_value(response.result.unwrap_or(Value::Null)).map_err(|_| {
            DispatchError::Internal("MCP Gateway capability catalog is invalid".into())
        })
    }

    fn gateway_read(
        &self,
        id: &Value,
        operation: McpServiceOperation,
        capability: &str,
        name: String,
        arguments: Value,
    ) -> Result<Value, DispatchError> {
        let response = self.gateway_request(
            id,
            operation,
            capability,
            McpSideEffectClass::ReadOnly,
            Some(name),
            arguments,
        )?;
        match response.outcome {
            McpServiceOutcome::Success => response.result.ok_or_else(|| {
                DispatchError::Internal("MCP Gateway omitted a success result".into())
            }),
            _ => Err(DispatchError::Internal(
                "MCP Gateway returned a non-success read result".into(),
            )),
        }
    }

    fn dispatch(&self, method: &str, params: &Value, id: &Value) -> Result<Value, DispatchError> {
        match method {
            "server/discover" => {
                self.validate_modern_metadata(params)?;
                *self
                    .mode
                    .lock()
                    .map_err(|_| DispatchError::Internal("MCP mode mutex poisoned".into()))? =
                    ConnectionMode::Modern;
                Ok(json!({
                    "resultType": "complete",
                    "supportedVersions": [MCP_MODERN_VERSION, MCP_LEGACY_VERSION],
                    "capabilities": {"tools": {}, "resources": {}, "prompts": {}},
                    "instructions": "Runalith is a local-first durable workflow runtime. Create a proposal, inspect its immutable plan, obtain externally authenticated approval, then claim only dependency-ready tasks. Approval is fail-closed without a provisioned authority verifier. Unknown provider outcomes are quarantined; never replay them blindly.",
                    "ttlMs": 300_000,
                    "cacheScope": "private"
                }))
            }
            "initialize" => self.initialize(params),
            "tools/list" => {
                self.ensure_request_mode(params)?;
                let tools = if self.local_gateway_identity.is_some() {
                    let capabilities = self.gateway_discover(id)?;
                    let allowed = capabilities
                        .iter()
                        .filter(|capability| capability.operation == McpServiceOperation::CallTool)
                        .map(|capability| capability.id.as_str())
                        .collect::<BTreeSet<_>>();
                    tool_definitions()
                        .into_iter()
                        .filter(|definition| {
                            definition["name"].as_str().is_some_and(|name| {
                                allowed.contains(format!("tool.read.{name}").as_str())
                            })
                        })
                        .collect::<Vec<_>>()
                } else {
                    tool_definitions()
                };
                let mut result = json!({"tools": tools});
                if self.is_modern() {
                    result["resultType"] = json!("complete");
                    result["ttlMs"] = json!(300_000);
                    result["cacheScope"] = json!("private");
                }
                Ok(result)
            }
            "resources/list" => {
                self.ensure_request_mode(params)?;
                let resources = if self.local_gateway_identity.is_some() {
                    let capabilities = self.gateway_discover(id)?;
                    if capabilities
                        .iter()
                        .any(|capability| capability.id == "resource.read")
                    {
                        resource_definitions()
                    } else {
                        Vec::new()
                    }
                } else {
                    resource_definitions()
                };
                let mut result = json!({"resources": resources});
                if self.is_modern() {
                    result["resultType"] = json!("complete");
                    result["ttlMs"] = json!(300_000);
                    result["cacheScope"] = json!("private");
                }
                Ok(result)
            }
            "resources/read" => {
                self.ensure_request_mode(params)?;
                let uri = params.get("uri").and_then(Value::as_str).ok_or(
                    DispatchError::InvalidParams("resources/read requires params.uri"),
                )?;
                if self.local_gateway_identity.is_some() {
                    return self.gateway_read(
                        id,
                        McpServiceOperation::ReadResource,
                        "resource.read",
                        uri.to_owned(),
                        json!({"uri":uri}),
                    );
                }
                let content = resource_content(uri)
                    .ok_or(DispatchError::InvalidParams("unknown resource URI"))?;
                Ok(json!({"contents":[{"uri":uri,"mimeType":"text/markdown","text":content}]}))
            }
            "prompts/list" => {
                self.ensure_request_mode(params)?;
                let prompts = if self.local_gateway_identity.is_some() {
                    let capabilities = self.gateway_discover(id)?;
                    if capabilities
                        .iter()
                        .any(|capability| capability.id == "prompt.read")
                    {
                        prompt_definitions()
                    } else {
                        Vec::new()
                    }
                } else {
                    prompt_definitions()
                };
                let mut result = json!({"prompts": prompts});
                if self.is_modern() {
                    result["resultType"] = json!("complete");
                    result["ttlMs"] = json!(300_000);
                    result["cacheScope"] = json!("private");
                }
                Ok(result)
            }
            "prompts/get" => {
                self.ensure_request_mode(params)?;
                let name = params.get("name").and_then(Value::as_str).ok_or(
                    DispatchError::InvalidParams("prompts/get requires params.name"),
                )?;
                let arguments = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                if !arguments.is_object() {
                    return Err(DispatchError::InvalidParams(
                        "prompt arguments must be an object",
                    ));
                }
                if self.local_gateway_identity.is_some() {
                    return self.gateway_read(
                        id,
                        McpServiceOperation::GetPrompt,
                        "prompt.read",
                        name.to_owned(),
                        arguments,
                    );
                }
                let prompt = prompt_content(name, &arguments).ok_or(
                    DispatchError::InvalidParams("unknown prompt or invalid arguments"),
                )?;
                Ok(prompt)
            }
            "tools/call" => {
                self.ensure_request_mode(params)?;
                let name = params.get("name").and_then(Value::as_str).ok_or(
                    DispatchError::InvalidParams("tools/call requires params.name"),
                )?;
                if !tool_definitions()
                    .iter()
                    .any(|definition| definition["name"].as_str() == Some(name))
                {
                    return Err(DispatchError::InvalidParams("unknown tool name"));
                }
                let arguments = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                if !arguments.is_object() {
                    return Err(DispatchError::InvalidParams(
                        "tool arguments must be an object",
                    ));
                }
                if self.local_gateway_identity.is_some() {
                    let definition = tool_definition(name)
                        .ok_or(DispatchError::InvalidParams("unknown tool name"))?;
                    let read_only = definition
                        .pointer("/annotations/readOnlyHint")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let capability = if read_only {
                        format!("tool.read.{name}")
                    } else {
                        format!("tool.mutate.{name}")
                    };
                    let response = self.gateway_request(
                        id,
                        McpServiceOperation::CallTool,
                        &capability,
                        if read_only {
                            McpSideEffectClass::ReadOnly
                        } else {
                            McpSideEffectClass::Mutating
                        },
                        Some(name.to_owned()),
                        arguments,
                    )?;
                    let value = match response.outcome {
                        McpServiceOutcome::Success => response.result.ok_or_else(|| {
                            DispatchError::Internal("MCP Gateway omitted a success result".into())
                        })?,
                        _ => {
                            return Err(DispatchError::Internal(
                                "MCP Gateway returned a non-success tool result".into(),
                            ));
                        }
                    };
                    return Ok(tool_result(self.is_modern(), value, false));
                }
                let result = self.call_tool(name, &arguments);
                let tool_result = match result {
                    Ok(value) => tool_result(self.is_modern(), value, false),
                    Err(error) => {
                        tool_result(self.is_modern(), json!({"error": error.to_string()}), true)
                    }
                };
                Ok(tool_result)
            }
            _ => Err(DispatchError::MethodNotFound(method.to_owned(), id.clone())),
        }
    }

    fn initialize(&self, params: &Value) -> Result<Value, DispatchError> {
        let mut mode = self
            .mode
            .lock()
            .map_err(|_| DispatchError::Internal("MCP mode mutex poisoned".into()))?;
        if *mode != ConnectionMode::Unselected {
            return Err(DispatchError::InvalidRequest(
                "initialize is only valid as the first legacy request",
            ));
        }
        let requested = params
            .get("protocolVersion")
            .and_then(Value::as_str)
            .ok_or(DispatchError::InvalidParams(
                "initialize requires protocolVersion",
            ))?;
        let negotiated = match requested {
            "2025-11-25" | "2025-06-18" | "2025-03-26" | "2024-11-05" => requested,
            _ => MCP_LEGACY_VERSION,
        };
        *mode = ConnectionMode::LegacyAwaitingInitialized;
        Ok(json!({
            "protocolVersion": negotiated,
            "capabilities": {"tools": {}, "resources": {}, "prompts": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            "instructions": "Runalith Rust runtime. Approval is unavailable until an authenticated authority verifier is provisioned."
        }))
    }

    fn ensure_request_mode(&self, params: &Value) -> Result<(), DispatchError> {
        let mut mode = self
            .mode
            .lock()
            .map_err(|_| DispatchError::Internal("MCP mode mutex poisoned".into()))?;
        match *mode {
            ConnectionMode::LegacyReady => Ok(()),
            ConnectionMode::LegacyAwaitingInitialized => Err(DispatchError::InvalidRequest(
                "legacy client must send notifications/initialized before tool requests",
            )),
            ConnectionMode::Modern => self.validate_modern_metadata(params),
            ConnectionMode::Unselected => {
                self.validate_modern_metadata(params)?;
                *mode = ConnectionMode::Modern;
                Ok(())
            }
        }
    }

    fn validate_modern_metadata(&self, params: &Value) -> Result<(), DispatchError> {
        let meta =
            params
                .get("_meta")
                .and_then(Value::as_object)
                .ok_or(DispatchError::InvalidParams(
                    "modern MCP request requires params._meta",
                ))?;
        if meta.get(PROTOCOL_VERSION_META_KEY).and_then(Value::as_str) != Some(MCP_MODERN_VERSION) {
            return Err(DispatchError::UnsupportedProtocolVersion(
                meta.get(PROTOCOL_VERSION_META_KEY)
                    .and_then(Value::as_str)
                    .unwrap_or("missing")
                    .to_owned(),
            ));
        }
        if !meta
            .get(CLIENT_CAPABILITIES_META_KEY)
            .is_some_and(Value::is_object)
        {
            return Err(DispatchError::InvalidParams(
                "modern MCP _meta requires io.modelcontextprotocol/clientCapabilities object",
            ));
        }
        if let Some(client_info) = meta.get("io.modelcontextprotocol/clientInfo") {
            if !client_info.get("name").is_some_and(Value::is_string)
                || !client_info.get("version").is_some_and(Value::is_string)
            {
                return Err(DispatchError::InvalidParams(
                    "clientInfo must include string name and version",
                ));
            }
        }
        Ok(())
    }

    fn is_modern(&self) -> bool {
        matches!(
            self.mode
                .lock()
                .map(|mode| *mode)
                .unwrap_or(ConnectionMode::Unselected),
            ConnectionMode::Modern | ConnectionMode::Unselected
        )
    }

    fn call_tool(&self, name: &str, arguments: &Value) -> Result<Value, RuntimeError> {
        validate_tool_arguments(name, arguments)?;
        match name {
            "orchestrator_health" => {
                if !arguments
                    .as_object()
                    .is_some_and(|object| object.is_empty())
                {
                    return Err(RuntimeError::Invariant(
                        "orchestrator_health accepts an empty argument object".into(),
                    ));
                }
                let path = self.database_path.as_deref().ok_or_else(|| {
                    RuntimeError::Invariant(
                        "host database path is not configured for read-only health inspection"
                            .into(),
                    )
                })?;
                let snapshot = Store::inspect_health_read_only(path)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let data_dir = path.parent().map(PathBuf::from);
                let workspace = std::env::var("WORKFLOW_WORKSPACE").ok();
                Ok(json!({
                    "status":"ok",
                    "mode":"local-only-rust-mcp",
                    "plugin":{"name":SERVER_NAME,"version":SERVER_VERSION},
                    "runtime_identity":{"runtime":"rust","version":SERVER_VERSION,"startup_manifest_hash":"NOT_PROVIDED","source_hash_scope":"NOT_CHECKED"},
                    "database_path":snapshot.database_path,
                    "data_dir":data_dir,
                    "workspace":workspace,
                    "stats":{
                        "workflows":snapshot.workflows,
                        "tasks":snapshot.tasks,
                        "running_tasks":snapshot.running_tasks,
                        "leased_tasks":snapshot.leased_tasks,
                        "events":snapshot.events,
                        "provider_intents":snapshot.provider_intents,
                        "provider_observations":snapshot.provider_observations,
                        "task_attempts":snapshot.task_attempts,
                        "task_attempt_results":snapshot.task_attempt_results
                    },
                    "store":snapshot,
                    "read_only":true,
                    "migrations_run":false,
                    "database_created":false,
                    "remote_probes":false,
                    "cloud_execution":false,
                    "github_actions_dispatch":false,
                    "external_model_api":false,
                    "event_chain":"NOT_CHECKED",
                    "runtime_sessions":"NOT_CHECKED",
                    "provider_lifecycle":"NOT_CONNECTED",
                    "host_activation":"NOT_CHECKED",
                    "production_authority":"NOT_ESTABLISHED",
                    "scope":"local SQLite quick_check and durable row counts only; no remote probes or workflow evidence verification"
                }))
            }
            "workflow_recommend_resources" => {
                let task = required_string(arguments, "task")
                    .map_err(|error| RuntimeError::Invariant(error.into()))?;
                if task.encode_utf16().count() > 12_000 {
                    return Err(RuntimeError::Invariant(
                        "task exceeds 12000 characters".into(),
                    ));
                }
                let limit = arguments.get("limit").and_then(Value::as_u64).unwrap_or(5);
                if !(1..=10).contains(&limit) {
                    return Err(RuntimeError::Invariant("limit must be from 1 to 10".into()));
                }
                let roles = self
                    .service
                    .list_custom_roles(false, 200)?
                    .into_iter()
                    .map(|record| {
                        serde_json::to_value(record.definition)
                            .map_err(|error| RuntimeError::Invariant(error.to_string()))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let workflows = self
                    .service
                    .list_custom_workflows(false, 200)?
                    .into_iter()
                    .map(|record| {
                        serde_json::to_value(record.definition)
                            .map_err(|error| RuntimeError::Invariant(error.to_string()))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let policies = self
                    .service
                    .list_workflow_policies(false, 200, None)?
                    .into_iter()
                    .map(|record| {
                        serde_json::to_value(record)
                            .map_err(|error| RuntimeError::Invariant(error.to_string()))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(recommend_resources(
                    task,
                    limit as usize,
                    roles,
                    workflows,
                    policies,
                ))
            }
            "custom_role_create" => {
                let actor = self.authenticated_catalog_actor()?;
                let mut value = arguments.clone();
                value["version"] = json!(1);
                let definition: runalith_domain::custom_workflow::CustomRoleDefinition =
                    serde_json::from_value(value)
                        .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let record = if definition.skills.is_empty() {
                    self.service.create_custom_role(definition, &actor)?
                } else {
                    let resolver = self.trusted_skill_resolver.as_deref().ok_or_else(|| {
                        RuntimeError::Invariant(
                            "host trusted skill resolver is not configured".into(),
                        )
                    })?;
                    self.service
                        .create_custom_role_with_trusted_skills(definition, &actor, resolver)?
                };
                Ok(
                    json!({"created":true,"persisted":true,"record":record,"runtime_access_granted":false,"actor_identity":actor}),
                )
            }
            "custom_role_update" => {
                let actor = self.authenticated_catalog_actor()?;
                let role_id = required_string(arguments, "role_id")
                    .map_err(|error| RuntimeError::Invariant(error.into()))?;
                let current = self.service.get_custom_role(role_id, None)?;
                let mut value = serde_json::to_value(current.definition)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let target = value.as_object_mut().ok_or_else(|| {
                    RuntimeError::Invariant("stored role definition is not an object".into())
                })?;
                for (key, field) in arguments
                    .as_object()
                    .ok_or_else(|| RuntimeError::Invariant("arguments must be object".into()))?
                {
                    if key != "role_id" {
                        target.insert(key.clone(), field.clone());
                    }
                }
                let definition: runalith_domain::custom_workflow::CustomRoleDefinition =
                    serde_json::from_value(value)
                        .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let record = if definition.skills.is_empty() {
                    self.service
                        .update_custom_role(role_id, definition, &actor)?
                } else {
                    let resolver = self.trusted_skill_resolver.as_deref().ok_or_else(|| {
                        RuntimeError::Invariant(
                            "host trusted skill resolver is not configured".into(),
                        )
                    })?;
                    self.service.update_custom_role_with_trusted_skills(
                        role_id, definition, &actor, resolver,
                    )?
                };
                Ok(
                    json!({"updated":true,"persisted":true,"record":record,"runtime_access_granted":false,"actor_identity":actor}),
                )
            }
            "custom_role_clone" => {
                ensure_only_keys(
                    arguments,
                    &[
                        "source_role_id",
                        "role_id",
                        "name",
                        "description",
                        "system_prompt",
                        "input_contract",
                        "output_artifact_type",
                        "allowed_capabilities",
                        "permissions",
                        "allowed_tools",
                        "skills",
                    ],
                )?;
                let actor = self.authenticated_catalog_actor()?;
                let source_role_id = required_string(arguments, "source_role_id")
                    .map_err(|error| RuntimeError::Invariant(error.into()))?;
                let role_id = required_string(arguments, "role_id")
                    .map_err(|error| RuntimeError::Invariant(error.into()))?;
                let source = self.service.get_custom_role(source_role_id, None)?;
                let source_version = source.definition.version;
                let mut definition = source.definition;
                definition.role_id = role_id.to_owned();
                definition.version = 1;
                definition.name = arguments
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("{} (copy)", definition.name));
                if let Some(value) = arguments.get("description") {
                    definition.description = serde_json::from_value(value.clone())
                        .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                }
                if let Some(value) = arguments.get("system_prompt") {
                    definition.system_prompt = serde_json::from_value(value.clone())
                        .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                }
                if let Some(value) = arguments.get("input_contract") {
                    definition.input_contract = serde_json::from_value(value.clone())
                        .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                }
                if let Some(value) = arguments.get("output_artifact_type") {
                    definition.output_artifact_type = serde_json::from_value(value.clone())
                        .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                }
                if let Some(value) = arguments.get("allowed_capabilities") {
                    definition.allowed_capabilities = serde_json::from_value(value.clone())
                        .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                }
                if let Some(value) = arguments.get("permissions") {
                    definition.permissions = serde_json::from_value(value.clone())
                        .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                }
                if let Some(value) = arguments.get("allowed_tools") {
                    definition.allowed_tools = serde_json::from_value(value.clone())
                        .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                }
                if let Some(value) = arguments.get("skills") {
                    definition.skills = serde_json::from_value(value.clone())
                        .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                }
                let record = self.service.clone_custom_role(
                    source_role_id,
                    source_version,
                    definition,
                    &actor,
                    self.trusted_skill_resolver.as_deref(),
                )?;
                Ok(json!({
                    "cloned":true,
                    "record":record,
                    "runtime_access_granted":false,
                    "execution_authorized":false,
                    "actor_identity":actor,
                    "note":"Clone is a separate role definition; source versions and verified skill pins remain unchanged. Role declarations do not grant runtime tool access."
                }))
            }
            "custom_role_get" => {
                let version = arguments
                    .get("version")
                    .and_then(Value::as_u64)
                    .map(u32::try_from)
                    .transpose()
                    .map_err(|_| RuntimeError::Invariant("version exceeds u32".into()))?;
                let role_id = required_string(arguments, "role_id")
                    .map_err(|error| RuntimeError::Invariant(error.into()))?;
                let record = self.service.get_custom_role(role_id, version)?;
                Ok(json!({"read_only":true,"record":record,"runtime_access_granted":false}))
            }
            "custom_role_list" => {
                let records = self.service.list_custom_roles(
                    arguments
                        .get("include_versions")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    arguments
                        .get("limit")
                        .and_then(Value::as_u64)
                        .unwrap_or(100),
                )?;
                Ok(json!({"read_only":true,"records":records,"count":records.len()}))
            }
            "custom_workflow_create" => {
                let actor = self.authenticated_catalog_actor()?;
                let mut value = arguments.clone();
                value["version"] = json!(1);
                let definition: runalith_domain::workflow::CustomWorkflowDefinition =
                    serde_json::from_value(value)
                        .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let record = if let Some(resolver) = self.trusted_skill_resolver.as_deref() {
                    self.service
                        .create_custom_workflow_with_trusted_skills(definition, &actor, resolver)?
                } else {
                    self.service.create_custom_workflow(definition, &actor)?
                };
                Ok(
                    json!({"created":true,"persisted":true,"record":record,"execution_authorized":false,"actor_identity":actor}),
                )
            }
            "custom_workflow_update" => {
                let actor = self.authenticated_catalog_actor()?;
                let workflow_id = required_string(arguments, "workflow_id")
                    .map_err(|error| RuntimeError::Invariant(error.into()))?;
                let mut value = arguments.clone();
                value["version"] = json!(1);
                let definition: runalith_domain::workflow::CustomWorkflowDefinition =
                    serde_json::from_value(value)
                        .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let record = if let Some(resolver) = self.trusted_skill_resolver.as_deref() {
                    self.service.update_custom_workflow_with_trusted_skills(
                        workflow_id,
                        definition,
                        &actor,
                        resolver,
                    )?
                } else {
                    self.service
                        .update_custom_workflow(workflow_id, definition, &actor)?
                };
                Ok(
                    json!({"updated":true,"persisted":true,"record":record,"execution_authorized":false,"actor_identity":actor}),
                )
            }
            "custom_workflow_clone" => {
                ensure_only_keys(
                    arguments,
                    &[
                        "source_workflow_id",
                        "workflow_id",
                        "name",
                        "description",
                        "input_contract",
                        "tasks",
                    ],
                )?;
                let actor = self.authenticated_catalog_actor()?;
                let source_workflow_id = required_string(arguments, "source_workflow_id")
                    .map_err(|error| RuntimeError::Invariant(error.into()))?;
                let workflow_id = required_string(arguments, "workflow_id")
                    .map_err(|error| RuntimeError::Invariant(error.into()))?;
                let source = self.service.get_custom_workflow(source_workflow_id, None)?;
                let mut definition = source.definition;
                definition.workflow_id = workflow_id.to_owned();
                definition.version = 1;
                definition.name = arguments
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("{} (copy)", definition.name));
                if let Some(description) = arguments.get("description") {
                    definition.description = serde_json::from_value(description.clone())
                        .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                }
                if let Some(input_contract) = arguments.get("input_contract") {
                    definition.input_contract = serde_json::from_value(input_contract.clone())
                        .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                }
                if let Some(tasks) = arguments.get("tasks") {
                    definition.tasks = serde_json::from_value(tasks.clone())
                        .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                }
                let record = if let Some(resolver) = self.trusted_skill_resolver.as_deref() {
                    self.service
                        .create_custom_workflow_with_trusted_skills(definition, &actor, resolver)?
                } else {
                    self.service.create_custom_workflow(definition, &actor)?
                };
                Ok(json!({
                    "cloned":true,
                    "record":record,
                    "execution_authorized":false,
                    "actor_identity":actor,
                    "note":"Clone is a separate definition; referenced role versions remain pinned. Each run still requires explicit plan and workflow approval."
                }))
            }
            "custom_workflow_get" => {
                let version = arguments
                    .get("version")
                    .and_then(Value::as_u64)
                    .map(u32::try_from)
                    .transpose()
                    .map_err(|_| RuntimeError::Invariant("version exceeds u32".into()))?;
                let workflow_id = required_string(arguments, "workflow_id")
                    .map_err(|error| RuntimeError::Invariant(error.into()))?;
                let record = self.service.get_custom_workflow(workflow_id, version)?;
                Ok(json!({"read_only":true,"record":record,"execution_authorized":false}))
            }
            "custom_workflow_list" => {
                let records = self.service.list_custom_workflows(
                    arguments
                        .get("include_versions")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    arguments
                        .get("limit")
                        .and_then(Value::as_u64)
                        .unwrap_or(100),
                )?;
                Ok(json!({"read_only":true,"records":records,"count":records.len()}))
            }
            "custom_workflow_preview" => {
                let actor = self.authenticated_catalog_actor()?;
                let version = arguments
                    .get("version")
                    .and_then(Value::as_u64)
                    .map(u32::try_from)
                    .transpose()
                    .map_err(|_| RuntimeError::Invariant("version exceeds u32".into()))?;
                let workflow_id = required_string(arguments, "workflow_id")
                    .map_err(|error| RuntimeError::Invariant(error.into()))?;
                let record = if let Some(resolver) = self.trusted_skill_resolver.as_deref() {
                    self.service.compile_custom_workflow_with_trusted_skills(
                        workflow_id,
                        version,
                        &actor,
                        resolver,
                    )?
                } else {
                    self.service
                        .compile_custom_workflow(workflow_id, version, &actor)?
                };
                Ok(
                    json!({"created":true,"persisted":true,"plan":record,"requires_explicit_approval":true,"plan_approved":false,"execution_authorized":false,"dispatch_performed":false,"actor_identity":actor}),
                )
            }
            "workflow_policy_catalog" => {
                ensure_only_keys(arguments, &[])?;
                Ok(Store::workflow_policy_catalog())
            }
            "workflow_policy_create" => {
                ensure_only_keys(
                    arguments,
                    &[
                        "policy_id",
                        "name",
                        "description",
                        "constraints",
                        "success_criteria",
                    ],
                )?;
                let actor = self.authenticated_catalog_actor()?;
                let mut value = arguments.clone();
                value["schema_version"] = json!(1);
                let definition: WorkflowPolicyDefinition =
                    serde_json::from_value(value).map_err(|error| {
                        RuntimeError::Invariant(format!("invalid workflow policy: {error}"))
                    })?;
                let record = self
                    .graph_store()?
                    .create_workflow_policy(definition, &actor)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                Ok(
                    json!({"created":true,"persisted":true,"record":record,"actor_identity":actor,"attached":false,"execution_authorized":false}),
                )
            }
            "workflow_policy_update" => {
                ensure_only_keys(
                    arguments,
                    &[
                        "policy_id",
                        "name",
                        "description",
                        "constraints",
                        "success_criteria",
                    ],
                )?;
                let actor = self.authenticated_catalog_actor()?;
                let policy_id = required_string(arguments, "policy_id")
                    .map_err(|error| RuntimeError::Invariant(error.into()))?;
                let store = self.graph_store()?;
                let current = store
                    .get_workflow_policy(policy_id, None)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let mut value = serde_json::to_value(current.definition)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let target = value.as_object_mut().ok_or_else(|| {
                    RuntimeError::Invariant("stored policy definition is not an object".into())
                })?;
                for (key, field) in arguments
                    .as_object()
                    .ok_or_else(|| RuntimeError::Invariant("arguments must be an object".into()))?
                {
                    if key != "policy_id" {
                        target.insert(key.clone(), field.clone());
                    }
                }
                let definition: WorkflowPolicyDefinition =
                    serde_json::from_value(value).map_err(|error| {
                        RuntimeError::Invariant(format!("invalid workflow policy update: {error}"))
                    })?;
                let record = store
                    .update_workflow_policy(policy_id, definition, &actor)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                Ok(
                    json!({"updated":true,"persisted":true,"record":record,"actor_identity":actor,"previous_versions_immutable":true}),
                )
            }
            "workflow_policy_validate" => {
                ensure_only_keys(
                    arguments,
                    &[
                        "policy_id",
                        "name",
                        "description",
                        "constraints",
                        "success_criteria",
                    ],
                )?;
                let mut value = arguments.clone();
                value["schema_version"] = json!(1);
                let definition: WorkflowPolicyDefinition =
                    serde_json::from_value(value).map_err(|error| {
                        RuntimeError::Invariant(format!("invalid workflow policy: {error}"))
                    })?;
                let digest = Store::validate_workflow_policy(&definition)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                Ok(
                    json!({"valid":true,"persisted":false,"policy_id":definition.policy_id,"definition":definition,"content_sha256_preview":digest,"enforcement":Store::workflow_policy_catalog()}),
                )
            }
            "workflow_policy_list" => {
                ensure_only_keys(arguments, &["include_versions", "limit", "query"])?;
                let include_versions = arguments
                    .get("include_versions")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let limit = arguments
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(100);
                if limit == 0 || limit > 200 {
                    return Err(RuntimeError::Invariant(
                        "limit must be from 1 to 200".into(),
                    ));
                }
                let query = arguments.get("query").and_then(Value::as_str);
                if query.is_some_and(|query| query.len() > 120) {
                    return Err(RuntimeError::Invariant(
                        "query exceeds 120 characters".into(),
                    ));
                }
                let store = self.graph_store()?;
                let records = store
                    .list_workflow_policies(include_versions, limit, query)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let attachments = store
                    .list_workflow_policy_attachments(None, 200)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                Ok(
                    json!({"read_only":true,"records":records,"count":records.len(),"attachments":attachments}),
                )
            }
            "workflow_policy_get" => {
                ensure_only_keys(arguments, &["policy_id", "version"])?;
                let policy_id = required_string(arguments, "policy_id")
                    .map_err(|error| RuntimeError::Invariant(error.into()))?;
                let version = arguments
                    .get("version")
                    .and_then(Value::as_u64)
                    .map(u32::try_from)
                    .transpose()
                    .map_err(|_| RuntimeError::Invariant("version exceeds u32".into()))?;
                let store = self.graph_store()?;
                let record = store
                    .get_workflow_policy(policy_id, version)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let attachments = store
                    .list_workflow_policy_attachments(Some(policy_id), 200)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let events = store
                    .list_workflow_policy_events(Some(policy_id), 100)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                Ok(
                    json!({"read_only":true,"record":record,"attachments":attachments,"events":events,"enforcement":Store::workflow_policy_catalog()}),
                )
            }
            "workflow_policy_attach" => {
                ensure_only_keys(
                    arguments,
                    &["job_id", "policy_id", "version", "base_contract"],
                )?;
                let actor = self.authenticated_catalog_actor()?;
                let workflow_id = required_string(arguments, "job_id")
                    .map_err(|error| RuntimeError::Invariant(error.into()))?;
                let policy_id = required_string(arguments, "policy_id")
                    .map_err(|error| RuntimeError::Invariant(error.into()))?;
                let version = arguments
                    .get("version")
                    .and_then(Value::as_u64)
                    .map(u32::try_from)
                    .transpose()
                    .map_err(|_| RuntimeError::Invariant("version exceeds u32".into()))?;
                let store = self.graph_store()?;
                let workflow = store
                    .get_workflow(workflow_id)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let base_contract = arguments
                    .get("base_contract")
                    .cloned()
                    .unwrap_or_else(|| json!({"goal":workflow.proposal.goal}));
                let attachment = store
                    .attach_workflow_policy(workflow_id, policy_id, version, base_contract, &actor)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let contract = store
                    .get_workflow_success_contract(workflow_id)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                Ok(
                    json!({"attached":true,"persisted":true,"attachment":attachment,"success_contract_snapshot":contract,"actor_identity":actor,"approval_required":true,"dispatch_performed":false,"execution_authorized":false}),
                )
            }
            "workflow_ready_tasks" => {
                let tasks = self.service.list_ready_tasks(
                    arguments
                        .get("limit")
                        .and_then(Value::as_u64)
                        .unwrap_or(100),
                )?;
                Ok(
                    json!({"read_only":true,"tasks":tasks,"count":tasks.len(),"dispatch_performed":false,"claim_performed":false}),
                )
            }
            "workflow_compile" => {
                let definition: runalith_domain::workflow::CustomWorkflowDefinition =
                    serde_json::from_value(
                        arguments.get("workflow").cloned().ok_or_else(|| {
                            RuntimeError::Invariant("workflow is required".into())
                        })?,
                    )
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let roles: Vec<runalith_domain::custom_workflow::CustomRoleDefinition> =
                    serde_json::from_value(
                        arguments
                            .get("roles")
                            .cloned()
                            .ok_or_else(|| RuntimeError::Invariant("roles are required".into()))?,
                    )
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                // No skill resolver is configured in this host; roles with
                // external skill references are rejected by the domain compiler.
                let skills = std::collections::BTreeSet::new();
                let plan = runalith_domain::custom_workflow::compile_custom_workflow(
                    &definition,
                    &roles,
                    &skills,
                )
                .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let canonical_content = plan
                    .canonical_content()
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let plan_hash = plan.plan_hash().to_owned();
                Ok(json!({
                    "read_only":true,
                    "persisted":false,
                    "plan":plan,
                    "canonical_content":canonical_content,
                    "plan_hash":plan_hash,
                    "requires_explicit_approval":true,
                    "execution_enabled":false,
                    "plan_approved":false,
                    "execution_authorized":false,
                    "limitations":["Custom role versions are supplied as input snapshots; no durable custom-role catalog is connected.","No skill resolver is configured; roles with skills are rejected.","Compilation does not authenticate role authorship, approve the plan, or authorize execution."]
                }))
            }
            "workflow_create" => {
                let proposal: WorkflowProposal = serde_json::from_value(arguments.clone())
                    .map_err(|error| {
                        RuntimeError::Invariant(format!("invalid workflow proposal: {error}"))
                    })?;
                let view = self
                    .service
                    .create_proposal(proposal)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                serde_json::to_value(view)
                    .map(redact_event_value)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))
            }
            "workflow_get" => {
                let workflow_id = required_string(arguments, "workflow_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let view = self
                    .service
                    .get_workflow(workflow_id)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                serde_json::to_value(view)
                    .map(redact_event_value)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))
            }
            "workflow_list" => {
                let limit = arguments.get("limit").and_then(Value::as_u64).unwrap_or(25) as usize;
                let workflows = self.service.list_active_workflows(limit)?;
                serde_json::to_value(workflows)
                    .map(redact_event_value)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))
            }
            "workflow_events" => {
                let workflow_id = required_string(arguments, "job_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let limit = arguments
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(100) as usize;
                let events = self.service.list_workflow_events(workflow_id, limit)?;
                let events = events
                    .into_iter()
                    .map(|event| {
                        let payload = redact_event_value(event.payload);
                        let payload = serde_json::to_string(&payload)
                            .unwrap_or_else(|_| "[REDACTED_INVALID_EVENT_PAYLOAD]".into());
                        let payload = payload.chars().take(4_000).collect::<String>();
                        json!({
                            "event_id":event.event_id,
                            "type":event.event_type,
                            "payload":payload,
                            "created_at":event.created_at
                        })
                    })
                    .collect::<Vec<_>>();
                Ok(json!({"job_id":workflow_id,"events":events}))
            }
            "workflow_validate_artifact" => {
                ensure_only_keys(arguments, &["artifact_type", "artifact", "role"])?;
                let artifact_type = required_string(arguments, "artifact_type")
                    .map_err(|error| RuntimeError::Invariant(format!("{error} is required")))?;
                if artifact_type.len() > 100 {
                    return Err(RuntimeError::Invariant(
                        "artifact_type exceeds 100 characters".into(),
                    ));
                }
                let artifact_type = artifact_type.trim();
                let artifact = arguments
                    .get("artifact")
                    .filter(|value| value.is_object())
                    .ok_or_else(|| RuntimeError::Invariant("artifact must be an object".into()))?;
                let fields = runalith_domain::artifact_contract::required_fields(artifact_type)
                    .ok_or_else(|| {
                        RuntimeError::Invariant(format!("unknown artifact type: {artifact_type}"))
                    })?;
                let missing_fields = fields
                    .iter()
                    .filter(|field| {
                        !artifact
                            .as_object()
                            .is_some_and(|object| object.contains_key(**field))
                    })
                    .copied()
                    .collect::<Vec<_>>();
                let semantic_error = if missing_fields.is_empty() {
                    runalith_domain::artifact_contract::validate_content(artifact_type, artifact)
                        .err()
                } else {
                    None
                };
                let expected_type_for_role = match arguments.get("role").and_then(Value::as_str) {
                    Some("") | None => None,
                    Some(role) => {
                        if role.len() > 100 {
                            return Err(RuntimeError::Invariant(
                                "role exceeds 100 characters".into(),
                            ));
                        }
                        let role = role.trim();
                        if role.is_empty() {
                            return Err(RuntimeError::Invariant(
                                "role must be a non-empty string".into(),
                            ));
                        }
                        Some(
                            runalith_domain::artifact_contract::artifact_type_for_role(role)
                                .ok_or_else(|| {
                                    RuntimeError::Invariant(format!("unknown agent role: {role}"))
                                })?,
                        )
                    }
                };
                let role_matches_type = expected_type_for_role
                    .as_deref()
                    .is_none_or(|expected| expected == artifact_type);
                Ok(json!({
                    "valid":missing_fields.is_empty() && semantic_error.is_none() && role_matches_type,
                    "artifact_type":artifact_type,
                    "schema_version":1,
                    "missing_fields":missing_fields,
                    "semantic_error":semantic_error,
                    "expected_type_for_role":expected_type_for_role,
                    "role_matches_type":role_matches_type
                }))
            }
            "workflow_diagnose" => {
                let workflow_id = required_string(arguments, "workflow_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let workflow = self.service.get_workflow(workflow_id)?;
                let mut blockers = Vec::new();
                let mut task_diagnostics = Vec::with_capacity(workflow.tasks.len());
                match workflow.state {
                    runalith_domain::WorkflowState::Proposed => blockers.push(json!({
                        "code":"AWAITING_APPROVAL",
                        "message":"Proposal has not received verified approval; no task can be claimed."
                    })),
                    runalith_domain::WorkflowState::Approved => blockers.push(json!({
                        "code":"AWAITING_TASK_CLAIM",
                        "message":"Workflow is approved; dependency-ready tasks may be claimed under the configured authority."
                    })),
                    runalith_domain::WorkflowState::Executing => {},
                    _ => {}
                }
                for task in &workflow.tasks {
                    let (classification, action) = match task.state {
                        runalith_domain::TaskState::Unknown => (
                            "unknown_outcome_requires_reconciliation",
                            "Inspect durable provider/process evidence. Do not retry or replay this attempt.",
                        ),
                        runalith_domain::TaskState::Failed => (
                            "known_failure_requires_review",
                            "Inspect persisted failure and workflow policy before proposing any new work.",
                        ),
                        runalith_domain::TaskState::Running if task.lease_id.is_none() => (
                            "running_without_lease_metadata",
                            "Lease metadata is absent. This does not prove worker death; inspect runtime ownership and durable events.",
                        ),
                        runalith_domain::TaskState::Running => (
                            "running_with_recorded_lease",
                            "A lease is recorded. Verify worker/session liveness and lease expiry before intervention.",
                        ),
                        runalith_domain::TaskState::Pending => (
                            "pending",
                            "Check dependencies and approval before claiming.",
                        ),
                        runalith_domain::TaskState::Succeeded => (
                            "succeeded",
                            "Verify evidence lineage through the persisted result.",
                        ),
                        runalith_domain::TaskState::Cancelled => (
                            "cancelled",
                            "No automatic recovery is proposed for a cancelled task.",
                        ),
                    };
                    task_diagnostics.push(json!({
                        "task_id":task.definition.task_id,
                        "state":task.state,
                        "attempts":task.attempts,
                        "lease_id":task.lease_id,
                        "lease_owner":task.lease_owner,
                        "lease_expires_at":task.lease_expires_at,
                        "classification":classification,
                        "next_action":action
                    }));
                    if matches!(
                        task.state,
                        runalith_domain::TaskState::Unknown | runalith_domain::TaskState::Failed
                    ) {
                        blockers.push(json!({"task_id":task.definition.task_id,"code":classification,"message":action}));
                    }
                    if task.state == runalith_domain::TaskState::Running && task.lease_id.is_none()
                    {
                        blockers.push(json!({"task_id":task.definition.task_id,"code":"LEASE_METADATA_MISSING_NOT_DEATH_PROOF","message":action}));
                    }
                }
                Ok(json!({
                    "read_only":true,
                    "workflow_id":workflow.workflow_id,
                    "workflow_state":workflow.state,
                    "scope":"durable_rust_workflow_projection_only",
                    "runtime_session_inventory":"unavailable",
                    "heartbeat_inventory":"unavailable",
                    "provider_status":"not_probed",
                    "task_diagnostics":task_diagnostics,
                    "blockers":blockers,
                    "mutations_performed":false,
                    "automatic_retry_allowed":false,
                    "automatic_replay_allowed":false,
                    "limitations":["Does not inspect external runtime sessions or heartbeats.","Does not establish worker death from missing lease metadata.","Does not reconcile providers or infer terminal disposition from missing execution metadata."]
                }))
            }
            "workflow_attempt_inspect" => {
                let workflow_id = required_string(arguments, "workflow_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let task_id = required_string(arguments, "task_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let snapshot = self.service.inspect_task_attempt(workflow_id, task_id)?;
                let provider = snapshot.provider_intent.as_ref().map(|intent| {
                    json!({
                        "intent_id":intent.intent_id,
                        "provider_id":intent.request.provider_id,
                        "state":intent.state,
                        "provider_run_id":intent.provider_run_id
                    })
                });
                let provider_history: Vec<Value> = snapshot
                    .provider_history
                    .iter()
                    .map(|entry| {
                        json!({
                            "attempt":entry.attempt,
                            "intent_id":entry.intent.intent_id,
                            "provider_id":entry.intent.request.provider_id,
                            "state":entry.intent.state,
                            "provider_run_id":entry.intent.provider_run_id,
                            "observation_count":entry.observations.len(),
                            "lineage_matches":entry.lineage_matches
                        })
                    })
                    .collect();
                let attempt_ledger: Vec<Value> = snapshot
                    .attempt_ledger
                    .iter()
                    .map(|entry| {
                        json!({
                            "attempt":entry.attempt,
                            "owner_epoch":entry.owner_epoch,
                            "lease_id":entry.lease_id,
                            "worker_id":entry.worker_id,
                            "lease_expires_at":entry.lease_expires_at,
                            "claimed_at":entry.claimed_at,
                            "result_sha256":entry.result_sha256,
                            "outcome":entry.outcome,
                            "result_recorded_at":entry.result_recorded_at,
                            "session_bound":entry.session_binding.is_some(),
                            "session_runtime_id":entry.session_binding.as_ref().map(|binding| binding.runtime_id.as_str())
                        })
                    })
                    .collect();
                let session_history: Vec<Value> = snapshot
                    .session_history
                    .iter()
                    .map(|history| json!({
                        "session_id":history.session.session_id,
                        "task_id":history.session.task_id,
                        "role":history.session.role,
                        "state":history.session.state,
                        "attempt":history.session.attempt,
                        "access":history.access.iter().map(|grant|json!({
                            "access_id":grant.access_id,"accessor_role":grant.accessor_role,
                            "permission":grant.permission,"expires_at":grant.expires_at,
                            "revoked":grant.revoked_at.is_some()
                        })).collect::<Vec<_>>(),
                        "messages":history.messages.iter().map(|message|json!({
                            "message_id":message.message_id,"sender_role":message.sender_role,
                            "recipient_role":message.recipient_role,"state":message.state,
                            "attempt":message.attempt,"transport_started":message.transport_started_at.is_some(),
                            "receipt_recorded":message.receipt.is_some()
                        })).collect::<Vec<_>>()
                    }))
                    .collect();
                let classification = if snapshot.attempt == 0 {
                    "NO_ATTEMPT_RECORDED"
                } else if snapshot.state == runalith_domain::TaskState::Unknown
                    || snapshot.provider_intent.as_ref().is_some_and(|intent| {
                        matches!(
                            intent.state,
                            runalith_runtime::ProviderDispatchState::Unknown
                                | runalith_runtime::ProviderDispatchState::Reserved
                                | runalith_runtime::ProviderDispatchState::Accepted
                        )
                    })
                {
                    "UNRESOLVED_REQUIRES_AUTHORITATIVE_RECONCILIATION"
                } else if snapshot.lease_id.is_some() {
                    "DURABLE_LEASE_PRESENT"
                } else {
                    "NO_DURABLE_LEASE_OBSERVED_NOT_DEATH_PROOF"
                };
                Ok(json!({
                    "read_only":true,
                    "workflow_id":snapshot.workflow_id,
                    "task_id":snapshot.task_id,
                    "task_state":snapshot.state,
                    "attempt":snapshot.attempt,
                    "owner_epoch":snapshot.owner_epoch,
                    "attempt_ledger":attempt_ledger,
                    "provider_history":provider_history,
                    "session_history":session_history,
                    "history_complete":snapshot.history_complete,
                    "provider_observation_count":snapshot.provider_observations.len(),
                    "plan_sha256":snapshot.plan_sha256,
                    "lease":{"lease_id":snapshot.lease_id,"worker_id":snapshot.lease_owner,"expires_at":snapshot.lease_expires_at},
                    "provider_intent":provider,
                    "runtime_session_inventory":"unavailable",
                    "classification":classification,
                    "mutations_performed":false,
                    "automatic_retry_allowed":false,
                    "automatic_replay_allowed":false,
                    "limitations":["Rust-native session registry, ACL and message history are joined; legacy Node agent-session rows and artifact files are not imported.","No external runtime session or heartbeat inventory is queried.","Missing lease or session metadata does not establish worker death.","Provider ACCEPTED, RESERVED or UNKNOWN is not treated as terminal without authoritative reconciliation."]
                }))
            }
            "agent_session_create" => {
                let request = AgentSessionCreateRequest {
                    runtime_session_key: required_string(arguments, "runtime_session_key")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?
                        .into(),
                    role: required_string(arguments, "role")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?
                        .into(),
                    parent_session_key: arguments
                        .get("parent_session_key")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    attempt: arguments
                        .get("attempt")
                        .and_then(Value::as_u64)
                        .unwrap_or(1),
                };
                let session = self.service.create_agent_session(
                    required_string(arguments, "workflow_id")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                    required_string(arguments, "task_id")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                    request,
                )?;
                serde_json::to_value(session).map_err(|e| RuntimeError::Invariant(e.to_string()))
            }
            "agent_session_list" => {
                let sessions = self.service.list_agent_sessions(
                    arguments.get("workflow_id").and_then(Value::as_str),
                    arguments.get("task_id").and_then(Value::as_str),
                    arguments.get("state").and_then(Value::as_str),
                    arguments
                        .get("limit")
                        .and_then(Value::as_u64)
                        .unwrap_or(100),
                )?;
                serde_json::to_value(sessions).map_err(|e| RuntimeError::Invariant(e.to_string()))
            }
            "agent_session_inspect" => {
                let inspection = self.service.inspect_agent_session(
                    required_string(arguments, "session_id")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                    required_string(arguments, "actor_role")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                    arguments
                        .get("include_revoked_access")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    arguments
                        .get("message_limit")
                        .and_then(Value::as_u64)
                        .unwrap_or(100),
                )?;
                serde_json::to_value(inspection)
                    .map(redact_event_value)
                    .map_err(|e| RuntimeError::Invariant(e.to_string()))
            }
            "agent_session_update" => {
                let session = self.service.update_agent_session(
                    required_string(arguments, "session_id")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                    arguments
                        .get("expected_attempt")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| {
                            RuntimeError::Invariant("expected_attempt is required".into())
                        })?,
                    required_string(arguments, "state")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                    arguments.get("current_turn_id").and_then(Value::as_str),
                    arguments
                        .get("heartbeat")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )?;
                serde_json::to_value(session).map_err(|e| RuntimeError::Invariant(e.to_string()))
            }
            "agent_session_access_grant" => {
                let permission = match required_string(arguments, "permission")
                    .map_err(|e| RuntimeError::Invariant(e.into()))?
                    .to_ascii_uppercase()
                    .as_str()
                {
                    "OBSERVE" => SessionPermission::Observe,
                    "MESSAGE" => SessionPermission::Message,
                    "EXECUTE" => SessionPermission::Execute,
                    "TAKEOVER" => SessionPermission::Takeover,
                    _ => return Err(RuntimeError::Invariant("invalid session permission".into())),
                };
                let access_id = self.service.grant_session_access(
                    required_string(arguments, "session_id")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                    SessionAccessRequest {
                        accessor_role: required_string(arguments, "accessor_role")
                            .map_err(|e| RuntimeError::Invariant(e.into()))?
                            .into(),
                        permission,
                        granted_by: required_string(arguments, "granted_by")
                            .map_err(|e| RuntimeError::Invariant(e.into()))?
                            .into(),
                        expires_at: arguments
                            .get("expires_at")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    },
                )?;
                Ok(json!({"access_id":access_id,"persisted":true}))
            }
            "agent_session_access_revoke" => {
                let revoked = self.service.revoke_session_access(
                    required_string(arguments, "access_id")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                    required_string(arguments, "actor")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                )?;
                Ok(json!({"revoked":revoked}))
            }
            "agent_session_attach" => {
                let attachment = self.service.attach_agent_session(
                    required_string(arguments, "session_id")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                    required_string(arguments, "actor_role")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                    arguments
                        .get("mode")
                        .and_then(Value::as_str)
                        .unwrap_or("OBSERVE"),
                )?;
                serde_json::to_value(attachment).map_err(|e| RuntimeError::Invariant(e.to_string()))
            }
            "agent_session_takeover" => {
                let session = self.service.takeover_agent_session(
                    required_string(arguments, "session_id")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                    required_string(arguments, "actor_role")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                    required_string(arguments, "reason")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                )?;
                serde_json::to_value(session).map_err(|e| RuntimeError::Invariant(e.to_string()))
            }
            "agent_session_message_enqueue" => {
                let request: SessionMessageRequest = serde_json::from_value(
                    arguments
                        .get("message")
                        .cloned()
                        .ok_or_else(|| RuntimeError::Invariant("message is required".into()))?,
                )
                .map_err(|e| RuntimeError::Invariant(e.to_string()))?;
                let message = self.service.enqueue_session_message(
                    required_string(arguments, "session_id")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                    request,
                )?;
                serde_json::to_value(message).map_err(|e| RuntimeError::Invariant(e.to_string()))
            }
            "agent_session_message_claim" => {
                let message = self.service.claim_session_message(
                    required_string(arguments, "message_id")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                    required_string(arguments, "recipient_role")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                    arguments
                        .get("lease_seconds")
                        .and_then(Value::as_u64)
                        .unwrap_or(60),
                )?;
                serde_json::to_value(message).map_err(|e| RuntimeError::Invariant(e.to_string()))
            }
            "agent_session_message_start" => {
                self.service.record_session_message_delivery_start(
                    required_string(arguments, "message_id")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                    arguments
                        .get("attempt")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| RuntimeError::Invariant("attempt is required".into()))?,
                    required_string(arguments, "lease_until")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                )?;
                Ok(json!({"transport_start_persisted":true}))
            }
            "agent_session_message_receipt" => {
                let receipt: SessionDeliveryReceipt = serde_json::from_value(
                    arguments
                        .get("receipt")
                        .cloned()
                        .ok_or_else(|| RuntimeError::Invariant("receipt is required".into()))?,
                )
                .map_err(|e| RuntimeError::Invariant(e.to_string()))?;
                self.service.record_session_message_receipt(
                    required_string(arguments, "message_id")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                    arguments
                        .get("attempt")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| RuntimeError::Invariant("attempt is required".into()))?,
                    required_string(arguments, "lease_until")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                    receipt,
                )?;
                Ok(json!({"receipt_persisted":true}))
            }
            "agent_session_message_ack" => {
                let message = self.service.acknowledge_session_message(
                    required_string(arguments, "message_id")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                    required_string(arguments, "recipient_role")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                    arguments
                        .get("attempt")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| RuntimeError::Invariant("attempt is required".into()))?,
                    required_string(arguments, "lease_until")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                )?;
                serde_json::to_value(message).map_err(|e| RuntimeError::Invariant(e.to_string()))
            }
            "agent_session_message_uncertain" => {
                let message = self.service.mark_session_message_uncertain(
                    required_string(arguments, "message_id")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                    arguments
                        .get("attempt")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| RuntimeError::Invariant("attempt is required".into()))?,
                    required_string(arguments, "reason")
                        .map_err(|e| RuntimeError::Invariant(e.into()))?,
                )?;
                serde_json::to_value(message).map_err(|e| RuntimeError::Invariant(e.to_string()))
            }
            "workflow_approve" => {
                let request = ApprovalRequest {
                    actor: required_string(arguments, "actor")
                        .map_err(|error| RuntimeError::Invariant(error.to_string()))?
                        .into(),
                    expected_proposal_hash: required_string(arguments, "expected_proposal_hash")
                        .map_err(|error| RuntimeError::Invariant(error.to_string()))?
                        .into(),
                    expected_plan_hash: required_string(arguments, "expected_plan_hash")
                        .map_err(|error| RuntimeError::Invariant(error.to_string()))?
                        .into(),
                    evidence: arguments.get("evidence").cloned().unwrap_or(Value::Null),
                };
                let workflow_id = required_string(arguments, "workflow_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let view = self.service.approve(workflow_id, request)?;
                serde_json::to_value(view)
                    .map(redact_event_value)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))
            }
            "workflow_claim_task" => {
                let workflow_id = required_string(arguments, "workflow_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let task_id = required_string(arguments, "task_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let worker_id = required_string(arguments, "worker_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let lease_ttl_seconds = arguments
                    .get("lease_ttl_seconds")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| {
                        RuntimeError::Invariant(
                            "lease_ttl_seconds must be an unsigned integer".into(),
                        )
                    })?;
                let lease = self.service.claim_task(
                    workflow_id,
                    task_id,
                    ClaimRequest {
                        worker_id: worker_id.into(),
                        lease_ttl_seconds,
                    },
                )?;
                serde_json::to_value(lease)
                    .map(redact_event_value)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))
            }
            "workflow_record_task_result" => {
                ensure_only_keys(
                    arguments,
                    &[
                        "workflow_id",
                        "task_id",
                        "lease_id",
                        "worker_id",
                        "attempt",
                        "outcome",
                        "evidence",
                        "error",
                        "event_id",
                        "producer_id",
                        "payload_sha256",
                    ],
                )?;
                let workflow_id = required_string(arguments, "workflow_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let task_id = required_string(arguments, "task_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let outcome: TaskOutcome = serde_json::from_value(
                    arguments.get("outcome").cloned().unwrap_or(Value::Null),
                )
                .map_err(|error| RuntimeError::Invariant(format!("invalid outcome: {error}")))?;
                let evidence: Vec<EvidenceRef> = serde_json::from_value(
                    arguments
                        .get("evidence")
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                )
                .map_err(|error| RuntimeError::Invariant(format!("invalid evidence: {error}")))?;
                let verifier = self.task_result_verifier.as_ref().ok_or_else(|| {
                    RuntimeError::Invariant(
                        "authenticated task-result producer verifier is not configured".into(),
                    )
                })?;
                let envelope = TaskResultEnvelope {
                    event_id: required_string(arguments, "event_id")
                        .map_err(|error| RuntimeError::Invariant(error.to_string()))?
                        .into(),
                    producer_id: required_string(arguments, "producer_id")
                        .map_err(|error| RuntimeError::Invariant(error.to_string()))?
                        .into(),
                    payload_sha256: required_string(arguments, "payload_sha256")
                        .map_err(|error| RuntimeError::Invariant(error.to_string()))?
                        .into(),
                    request: TaskResultRequest {
                        lease_id: required_string(arguments, "lease_id")
                            .map_err(|error| RuntimeError::Invariant(error.to_string()))?
                            .into(),
                        worker_id: required_string(arguments, "worker_id")
                            .map_err(|error| RuntimeError::Invariant(error.to_string()))?
                            .into(),
                        attempt: arguments
                            .get("attempt")
                            .and_then(Value::as_u64)
                            .ok_or_else(|| {
                                RuntimeError::Invariant(
                                    "attempt must be an unsigned integer".into(),
                                )
                            })?,
                        outcome,
                        evidence,
                        error: arguments
                            .get("error")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    },
                };
                let view = self.service.record_task_result_envelope(
                    workflow_id,
                    task_id,
                    envelope,
                    verifier.as_ref(),
                )?;
                serde_json::to_value(view)
                    .map(redact_event_value)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))
            }
            "workflow_recovery_quarantine_expired" => {
                let count = self.service.quarantine_expired_leases()?;
                Ok(json!({"quarantined": count, "replayAllowed": false}))
            }
            "workflow_verify_event_chain" => {
                let workflow_id = required_string(arguments, "workflow_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let report = self.service.verify_event_chain(workflow_id)?;
                serde_json::to_value(report)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))
            }
            "workflow_synthesize" => {
                ensure_only_keys(arguments, &["workflow_id"])?;
                let workflow_id = required_string(arguments, "workflow_id")
                    .map_err(|error| RuntimeError::Invariant(error.into()))?;
                let report = self.service.synthesize_workflow(workflow_id)?;
                Ok(
                    json!({"persisted":true,"report":redact_event_value(report),"dispatch_performed":false,"execution_authorized":false}),
                )
            }
            "graph_create" => {
                let store = self.graph_store()?;
                let graph_id = required_string(arguments, "graph_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let info = store
                    .create_graph(graph_id)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                serde_json::to_value(info)
                    .map(redact_event_value)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))
            }
            "graph_node_append" => {
                let store = self.graph_store()?;
                let graph_id = required_string(arguments, "graph_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let node: GraphNodeRevision =
                    serde_json::from_value(arguments.get("node").cloned().unwrap_or(Value::Null))
                        .map_err(|error| {
                        RuntimeError::Invariant(format!("invalid graph node: {error}"))
                    })?;
                let info = store
                    .append_graph_node_revision(graph_id, node)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                serde_json::to_value(info)
                    .map(redact_event_value)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))
            }
            "graph_edge_append" => {
                let store = self.graph_store()?;
                let graph_id = required_string(arguments, "graph_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let edge: GraphEdge =
                    serde_json::from_value(arguments.get("edge").cloned().unwrap_or(Value::Null))
                        .map_err(|error| {
                        RuntimeError::Invariant(format!("invalid graph edge: {error}"))
                    })?;
                let info = store
                    .append_graph_edge(graph_id, edge)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                serde_json::to_value(info)
                    .map(redact_event_value)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))
            }
            "graph_evidence_capture" => {
                let store = self.graph_store()?;
                let graph_id = required_string(arguments, "graph_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let evidence: GraphEvidence = serde_json::from_value(
                    arguments.get("evidence").cloned().unwrap_or(Value::Null),
                )
                .map_err(|error| {
                    RuntimeError::Invariant(format!("invalid graph evidence: {error}"))
                })?;
                let info = store
                    .capture_graph_evidence(graph_id, evidence)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                serde_json::to_value(info)
                    .map(redact_event_value)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))
            }
            "graph_snapshot_create" => {
                let store = self.graph_store()?;
                let graph_id = required_string(arguments, "graph_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let snapshot = store
                    .create_graph_snapshot(graph_id)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                serde_json::to_value(snapshot)
                    .map(redact_event_value)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))
            }
            "graph_snapshot_get" => {
                let store = self.graph_store()?;
                let graph_id = required_string(arguments, "graph_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let revision = arguments
                    .get("revision")
                    .map(|value| {
                        value.as_u64().ok_or_else(|| {
                            RuntimeError::Invariant(
                                "revision must be a positive safe integer".into(),
                            )
                        })
                    })
                    .transpose()?;
                let snapshot = store
                    .get_graph_snapshot(graph_id, revision)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let snapshot_sha256 = snapshot.snapshot_sha256.clone();
                let snapshot_projection = serde_json::to_value(snapshot)
                    .map(redact_event_value)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                Ok(json!({
                    "read_only":true,
                    "snapshot":snapshot_projection,
                    "snapshot_sha256":snapshot_sha256,
                    "snapshot_payload_redacted":true,
                    "snapshot_created":false,
                    "execution_authorized":false,
                    "dispatch_allowed":false
                }))
            }
            "adaptive_goal_graph_search" => {
                let store = self.graph_store()?;
                let graph_id = required_string(arguments, "graph_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let start = required_string(arguments, "start_node_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let goal = required_string(arguments, "goal_node_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let snapshot = store
                    .get_graph_snapshot(graph_id, None)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let graph = project_snapshot(
                    &snapshot.snapshot_sha256,
                    start,
                    goal,
                    &snapshot.nodes,
                    &snapshot.edges,
                )
                .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let options: SearchOptions = arguments
                    .get("options")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|error| {
                        RuntimeError::Invariant(format!("invalid AGG search options: {error}"))
                    })?
                    .unwrap_or_default();
                let result = search_agg(&graph, &options)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                serde_json::to_value(result)
                    .map(redact_event_value)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))
            }
            "adaptive_goal_phase2_rank" => {
                let store = self.graph_store()?;
                let graph_id = required_string(arguments, "graph_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let start = required_string(arguments, "start_node_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let goal = required_string(arguments, "goal_node_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let snapshot = store
                    .get_graph_snapshot(graph_id, None)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let graph = project_snapshot(
                    &snapshot.snapshot_sha256,
                    start,
                    goal,
                    &snapshot.nodes,
                    &snapshot.edges,
                )
                .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let options: SearchOptions = arguments
                    .get("options")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|error| {
                        RuntimeError::Invariant(format!("invalid AGG search options: {error}"))
                    })?
                    .unwrap_or_default();
                let phase1 = search_agg(&graph, &options)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let model_value = arguments.get("model").cloned().ok_or_else(|| {
                    RuntimeError::Invariant("Phase 2 discriminator model is required".into())
                })?;
                let model = validate_discriminator_model(&model_value)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let result = rank_search_candidates(&graph, &options, &phase1, &model)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                serde_json::to_value(result)
                    .map(redact_event_value)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))
            }
            "adaptive_goal_mcts_shadow_search" => {
                let store = self.graph_store()?;
                let graph_id = required_string(arguments, "graph_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let start = required_string(arguments, "start_node_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let goal = required_string(arguments, "goal_node_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let snapshot = store
                    .get_graph_snapshot(graph_id, None)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let graph = project_snapshot(
                    &snapshot.snapshot_sha256,
                    start,
                    goal,
                    &snapshot.nodes,
                    &snapshot.edges,
                )
                .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let options: MctsOptions = arguments
                    .get("options")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|error| {
                        RuntimeError::Invariant(format!("invalid AGG MCTS options: {error}"))
                    })?
                    .unwrap_or_default();
                let model_value = arguments.get("model").cloned().ok_or_else(|| {
                    RuntimeError::Invariant("Phase 3 discriminator model is required".into())
                })?;
                let model = validate_discriminator_model(&model_value)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let result = mcts_shadow_search(&graph, &options, &model)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                serde_json::to_value(result)
                    .map(redact_event_value)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))
            }
            "adaptive_goal_plan_project" => {
                let store = self.graph_store()?;
                let graph_id = required_string(arguments, "graph_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let start = required_string(arguments, "start_node_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let goal = required_string(arguments, "goal_node_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let candidate_id = required_string(arguments, "candidate_plan_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let snapshot = store
                    .get_graph_snapshot(graph_id, None)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let graph = project_snapshot(
                    &snapshot.snapshot_sha256,
                    start,
                    goal,
                    &snapshot.nodes,
                    &snapshot.edges,
                )
                .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let options: SearchOptions = arguments
                    .get("options")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|error| {
                        RuntimeError::Invariant(format!("invalid AGG search options: {error}"))
                    })?
                    .unwrap_or_default();
                let search_result = search_agg(&graph, &options)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let draft = project_plan(&graph, &options, &search_result, candidate_id)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                serde_json::to_value(draft)
                    .map(redact_event_value)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))
            }
            "workflow_execution_graph_get" => {
                let workflow_id = required_string(arguments, "workflow_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let workflow = self.service.get_workflow(workflow_id)?;
                let chain = self.service.verify_event_chain(workflow_id)?;
                let provider_intents = self.service.list_provider_dispatch_intents(workflow_id)?;
                let graph = ExecutionGraphSnapshot::from_workflow_with_provider_intents(
                    &workflow,
                    chain.valid,
                    &provider_intents,
                )
                .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                serde_json::to_value(graph)
                    .map(redact_event_value)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))
            }
            "workflow_sandbox_execute" => {
                let executor = self.sandbox_executor.as_ref().ok_or_else(|| {
                    RuntimeError::Invariant("sandbox execution is disabled on this host".into())
                })?;
                let artifacts = self.artifact_store.as_ref().ok_or_else(|| {
                    RuntimeError::Invariant("artifact store is not configured on this host".into())
                })?;
                let workflow_id = required_string(arguments, "workflow_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let task_id = required_string(arguments, "task_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let worker_id = required_string(arguments, "worker_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let lease_ttl_seconds = arguments
                    .get("lease_ttl_seconds")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| {
                        RuntimeError::Invariant(
                            "lease_ttl_seconds must be an unsigned integer".into(),
                        )
                    })?;
                let workflow = self.service.get_workflow(workflow_id)?;
                let task = workflow
                    .tasks
                    .iter()
                    .find(|task| task.definition.task_id == task_id)
                    .ok_or_else(|| RuntimeError::Invariant(format!("unknown task {task_id}")))?;
                let request: CommandRequest = serde_json::from_value(
                    task.definition
                        .inputs
                        .get("sandbox_command")
                        .cloned()
                        .unwrap_or(Value::Null),
                )
                .map_err(|error| {
                    RuntimeError::Invariant(format!(
                        "task does not contain a valid pinned sandbox_command: {error}"
                    ))
                })?;
                let view = self.service.execute_sandboxed_task(
                    SandboxTaskExecutionRequest {
                        workflow_id: workflow_id.into(),
                        task_id: task_id.into(),
                        worker_id: worker_id.into(),
                        lease_ttl_seconds,
                        command: request,
                    },
                    executor.as_ref(),
                    artifacts.as_ref(),
                )?;
                serde_json::to_value(view)
                    .map(redact_event_value)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))
            }
            "workflow_provider_reconcile" => {
                let intent_id = required_string(arguments, "intent_id")
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let intent = self.service.get_provider_dispatch_intent(intent_id)?;
                let adapter = self
                    .provider_adapters
                    .get(&intent.request.provider_id)
                    .ok_or_else(|| {
                        RuntimeError::Invariant(format!(
                            "provider adapter {} is not configured on this host",
                            intent.request.provider_id
                        ))
                    })?;
                let (record, observation) = self
                    .service
                    .reconcile_provider_dispatch_intent(intent_id, adapter.as_ref())?;
                serde_json::to_value(json!({
                    "intent":{
                        "intent_id":record.intent_id,
                        "workflow_id":record.request.workflow_id,
                        "task_id":record.request.task_id,
                        "attempt":record.request.attempt,
                        "provider_id":record.request.provider_id,
                        "plan_sha256":record.request.plan_sha256,
                        "request_sha256":record.request.request_sha256,
                        "state":record.state,
                        "provider_run_id":record.provider_run_id,
                        "created_at":record.created_at,
                        "updated_at":record.updated_at
                    },
                    "observation":{
                        "observation_id":observation.observation_id,
                        "intent_id":observation.intent_id,
                        "provider_id":observation.provider_id,
                        "provider_run_id":observation.provider_run_id,
                        "response_sha256":observation.response_sha256,
                        "observed_at":observation.observed_at
                    },
                    "provider_payload_exposed":false,
                    "provider_response_exposed":false,
                    "automatic_replay":false,
                    "unknown_is_terminal":true
                }))
                .map_err(|error| RuntimeError::Invariant(error.to_string()))
            }
            _ => Err(RuntimeError::Invariant(format!("unknown tool: {name}"))),
        }
    }

    fn authenticated_catalog_actor(&self) -> Result<String, RuntimeError> {
        let verifier = self.catalog_author_verifier.as_ref().ok_or_else(|| {
            RuntimeError::Invariant(
                "authenticated catalog author verifier is not configured".into(),
            )
        })?;
        let actor = verifier.authenticated_principal()?;
        if actor.trim().is_empty()
            || actor.trim() != actor
            || actor == "mcp:unattributed"
            || actor.encode_utf16().count() > 200
        {
            return Err(RuntimeError::Invariant(
                "catalog author verifier returned an invalid authenticated principal".into(),
            ));
        }
        Ok(actor)
    }

    fn graph_store(&self) -> Result<&Arc<Store>, RuntimeError> {
        self.graph_store.as_ref().ok_or_else(|| {
            RuntimeError::Invariant("graph store is not configured on this host".into())
        })
    }

    fn success_response_bytes(&self, id: Value, result: Value) -> Result<Vec<u8>, McpError> {
        let mut response = json!({"jsonrpc": "2.0", "id": id, "result": result});
        let mode = *self
            .mode
            .lock()
            .map_err(|_| McpError::Runtime("MCP mode mutex poisoned".into()))?;
        if matches!(mode, ConnectionMode::Modern | ConnectionMode::Unselected) {
            response["result"]["_meta"] = json!({
                SERVER_INFO_META_KEY: {"name": SERVER_NAME, "version": SERVER_VERSION}
            });
        }
        Ok(serde_json::to_vec(&response)?)
    }

    fn protocol_error(
        &self,
        id: Option<Value>,
        code: i64,
        message: &str,
        data: Option<Value>,
    ) -> Result<Option<Vec<u8>>, McpError> {
        let response_id = id.unwrap_or(Value::Null);
        let mut error = json!({"code": code, "message": message});
        if let Some(data) = data {
            error["data"] = data;
        }
        let response = json!({"jsonrpc": "2.0", "id": response_id, "error": error});
        let response_bytes = serde_json::to_vec(&response)?;
        if response_bytes.len() <= MAX_MCP_FRAME_BYTES {
            return Ok(Some(response_bytes));
        }

        // Error details are untrusted and may echo large input. Replace an
        // oversized diagnostic with a small request-bound protocol error.
        let bounded = json!({
            "jsonrpc":"2.0",
            "id":response["id"],
            "error":{
                "code":-32603,
                "message":"MCP error response exceeds configured frame byte limit"
            }
        });
        let bounded_bytes = serde_json::to_vec(&bounded)?;
        if bounded_bytes.len() > MAX_MCP_FRAME_BYTES {
            return Err(McpError::FrameSize);
        }
        Ok(Some(bounded_bytes))
    }
}

struct LocalMcpPrincipalAuthenticator {
    expected_transport: AuthenticatedMcpTransportContext,
    expected_principal: McpPrincipalV1,
}

impl McpTransportPrincipalAuthenticator for LocalMcpPrincipalAuthenticator {
    fn authenticate(
        &self,
        transport: &AuthenticatedMcpTransportContext,
        principal: &McpPrincipalV1,
    ) -> Result<(), McpGatewayError> {
        if transport == &self.expected_transport
            && principal == &self.expected_principal
            && principal.subject == transport.peer_identity()
            && principal.issuer == "linux-stdio-parent-process"
            && principal.audience == "runalith-local"
            && principal.authentication_context == transport.connection_id()
        {
            Ok(())
        } else {
            Err(McpGatewayError::AuthenticationFailed)
        }
    }
}

struct LocalMcpApplicationService<'a> {
    server: &'a McpServer,
    expected_principal: &'a McpPrincipalV1,
}

impl McpApplicationService for LocalMcpApplicationService<'_> {
    fn service_id(&self) -> &str {
        "runalith-local"
    }

    fn discover_capabilities(
        &self,
        principal: &McpPrincipalV1,
    ) -> Result<Vec<McpCapability>, McpGatewayError> {
        if principal != self.expected_principal {
            return Err(McpGatewayError::AuthenticationFailed);
        }
        let mut capabilities = tool_definitions()
            .into_iter()
            .filter_map(|definition| definition["name"].as_str().map(str::to_owned))
            .filter(|name| gateway_read_only_tool(name))
            .map(|name| McpCapability {
                id: format!("tool.read.{name}"),
                operation: McpServiceOperation::CallTool,
                side_effect_class: McpSideEffectClass::ReadOnly,
            })
            .collect::<Vec<_>>();
        capabilities.push(McpCapability {
            id: "resource.read".into(),
            operation: McpServiceOperation::ReadResource,
            side_effect_class: McpSideEffectClass::ReadOnly,
        });
        capabilities.push(McpCapability {
            id: "prompt.read".into(),
            operation: McpServiceOperation::GetPrompt,
            side_effect_class: McpSideEffectClass::ReadOnly,
        });
        Ok(capabilities)
    }

    fn expected_side_effect_class(
        &self,
        request: &McpServiceRequestV1,
    ) -> Result<McpSideEffectClass, McpGatewayError> {
        match request.operation {
            McpServiceOperation::DiscoverCapabilities
            | McpServiceOperation::ReadResource
            | McpServiceOperation::GetPrompt => Ok(McpSideEffectClass::ReadOnly),
            McpServiceOperation::CallTool => {
                let name = request
                    .name
                    .as_deref()
                    .ok_or(McpGatewayError::AuthorizationDenied)?;
                if tool_definition(name).is_none() {
                    return Err(McpGatewayError::AuthorizationDenied);
                }
                Ok(if gateway_read_only_tool(name) {
                    McpSideEffectClass::ReadOnly
                } else {
                    McpSideEffectClass::Mutating
                })
            }
        }
    }

    fn authorize(&self, request: &McpServiceRequestV1) -> Result<(), McpGatewayError> {
        if &request.principal != self.expected_principal {
            return Err(McpGatewayError::AuthenticationFailed);
        }
        match request.operation {
            McpServiceOperation::DiscoverCapabilities
                if request.capability == "capabilities.read"
                    && request.side_effect_class == McpSideEffectClass::ReadOnly =>
            {
                Ok(())
            }
            McpServiceOperation::CallTool => {
                let name = request
                    .name
                    .as_deref()
                    .ok_or(McpGatewayError::AuthorizationDenied)?;
                if tool_definition(name).is_none() {
                    return Err(McpGatewayError::AuthorizationDenied);
                }
                if !gateway_read_only_tool(name)
                    || request.side_effect_class != McpSideEffectClass::ReadOnly
                    || request.capability != format!("tool.read.{name}")
                {
                    return Err(McpGatewayError::AuthorizationDenied);
                }
                Ok(())
            }
            McpServiceOperation::ReadResource => {
                let uri = request
                    .name
                    .as_deref()
                    .ok_or(McpGatewayError::AuthorizationDenied)?;
                if request.capability != "resource.read"
                    || request.side_effect_class != McpSideEffectClass::ReadOnly
                    || resource_content(uri).is_none()
                {
                    return Err(McpGatewayError::AuthorizationDenied);
                }
                Ok(())
            }
            McpServiceOperation::GetPrompt => {
                let name = request
                    .name
                    .as_deref()
                    .ok_or(McpGatewayError::AuthorizationDenied)?;
                if request.capability != "prompt.read"
                    || request.side_effect_class != McpSideEffectClass::ReadOnly
                    || prompt_content(name, &request.arguments).is_none()
                {
                    return Err(McpGatewayError::AuthorizationDenied);
                }
                Ok(())
            }
            _ => Err(McpGatewayError::AuthorizationDenied),
        }
    }

    fn invoke_read_only(
        &self,
        request: &McpServiceRequestV1,
    ) -> Result<McpServiceResponseV1, McpGatewayError> {
        let result = match request.operation {
            McpServiceOperation::CallTool => {
                let name = request
                    .name
                    .as_deref()
                    .ok_or(McpGatewayError::AuthorizationDenied)?;
                self.server
                    .call_tool(name, &request.arguments)
                    .map_err(|error| {
                        McpGatewayError::Service(redact_event_text(&error.to_string()))
                    })?
            }
            McpServiceOperation::ReadResource => {
                let uri = request
                    .name
                    .as_deref()
                    .ok_or(McpGatewayError::AuthorizationDenied)?;
                let text = resource_content(uri).ok_or(McpGatewayError::AuthorizationDenied)?;
                json!({"contents":[{"uri":uri,"mimeType":"text/markdown","text":text}]})
            }
            McpServiceOperation::GetPrompt => {
                let name = request
                    .name
                    .as_deref()
                    .ok_or(McpGatewayError::AuthorizationDenied)?;
                prompt_content(name, &request.arguments)
                    .ok_or(McpGatewayError::AuthorizationDenied)?
            }
            _ => return Err(McpGatewayError::AuthorizationDenied),
        };
        Ok(McpServiceResponseV1 {
            schema_version: 1,
            request_id: request.request_id.clone(),
            service_id: self.service_id().to_owned(),
            outcome: McpServiceOutcome::Success,
            result: Some(result),
            error: None,
        })
    }

    fn invoke_mutating(
        &self,
        _request: &McpServiceRequestV1,
    ) -> Result<McpServiceResponseV1, McpGatewayError> {
        // This host intentionally does not have a durable generic MCP
        // idempotency adapter. Never fall through to WorkflowService/Store.
        Err(McpGatewayError::AuthorizationDenied)
    }
}

fn tool_definition(name: &str) -> Option<Value> {
    tool_definitions()
        .into_iter()
        .find(|definition| definition.get("name").and_then(Value::as_str) == Some(name))
}

/// Security-reviewed allowlist for the local stdio Gateway. Public MCP
/// annotations are discovery metadata and are not themselves authorization.
/// The legacy catalog currently labels recovery quarantine and provider
/// reconciliation as read-only even though they can mutate durable or
/// external state; neither is admitted by this allowlist.
fn gateway_read_only_tool(name: &str) -> bool {
    matches!(
        name,
        "orchestrator_health"
            | "workflow_recommend_resources"
            | "workflow_ready_tasks"
            | "custom_role_list"
            | "custom_workflow_list"
            | "workflow_policy_list"
            | "workflow_compile"
            | "workflow_list"
            | "workflow_events"
            | "workflow_validate_artifact"
            | "workflow_diagnose"
            | "workflow_attempt_inspect"
            | "workflow_verify_event_chain"
            | "graph_snapshot_get"
    )
}

fn map_gateway_error(error: McpGatewayError) -> DispatchError {
    match error {
        McpGatewayError::Contract(
            runalith_protocol::mcp_service_v1::McpServiceContractError::InvalidField(
                "idempotency_key",
            ),
        ) => DispatchError::MutationIdempotencyUnavailable,
        McpGatewayError::AuthenticationFailed
        | McpGatewayError::AuthorizationDenied
        | McpGatewayError::SideEffectClassMismatch
        | McpGatewayError::AudienceMismatch => DispatchError::Forbidden,
        McpGatewayError::Contract(_) => {
            DispatchError::InvalidParams("MCP Gateway request violates its service contract")
        }
        McpGatewayError::Service(message) => DispatchError::Internal(redact_event_text(&message)),
        McpGatewayError::InvalidResponse
        | McpGatewayError::InvalidCapabilities
        | McpGatewayError::InvalidServiceIdentity
        | McpGatewayError::InvalidTransportContext => DispatchError::Internal(
            "MCP Gateway rejected an invalid service boundary response".into(),
        ),
    }
}

#[derive(Debug)]
enum DispatchError {
    InvalidRequest(&'static str),
    InvalidParams(&'static str),
    Forbidden,
    MutationIdempotencyUnavailable,
    UnsupportedProtocolVersion(String),
    MethodNotFound(String, Value),
    Internal(String),
}

impl From<RuntimeError> for DispatchError {
    fn from(value: RuntimeError) -> Self {
        Self::Internal(value.to_string())
    }
}

fn map_error(error: DispatchError) -> (i64, String, Option<Value>) {
    match error {
        DispatchError::InvalidRequest(message) => (-32600, message.into(), None),
        DispatchError::InvalidParams(message) => (-32602, message.into(), None),
        DispatchError::Forbidden => (
            -32001,
            "MCP Gateway authorization denied".into(),
            Some(json!({"code":"MCP_GATEWAY_AUTHORIZATION_DENIED"})),
        ),
        DispatchError::MutationIdempotencyUnavailable => (
            -32004,
            "mutating MCP routes are disabled until durable idempotency is provisioned".into(),
            Some(json!({
                "code":"MUTATION_IDEMPOTENCY_UNAVAILABLE",
                "automatic_retry":false,
                "handler_invoked":false
            })),
        ),
        DispatchError::UnsupportedProtocolVersion(requested) => (
            -32022,
            "Unsupported protocol version".into(),
            Some(
                json!({"supported": [MCP_MODERN_VERSION, MCP_LEGACY_VERSION], "requested": requested}),
            ),
        ),
        DispatchError::MethodNotFound(method, _id) => {
            (-32601, format!("Method not found: {method}"), None)
        }
        DispatchError::Internal(message) => (-32603, message, None),
    }
}

fn valid_json_rpc_request_id(id: &Value) -> bool {
    match id {
        Value::String(value) => {
            !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
        }
        Value::Number(value) => value
            .as_f64()
            .is_some_and(|number| number.is_finite() && number.abs() <= 9_007_199_254_740_991.0),
        _ => false,
    }
}

fn mutating_tool_call(method: &str, params: &Value) -> bool {
    if method != "tools/call" {
        return false;
    }
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return false;
    };
    tool_definitions()
        .into_iter()
        .find(|definition| definition.get("name").and_then(Value::as_str) == Some(name))
        .and_then(|definition| {
            definition
                .pointer("/annotations/readOnlyHint")
                .and_then(Value::as_bool)
        })
        .is_some_and(|read_only| !read_only)
}

fn required_string<'a>(arguments: &'a Value, key: &'static str) -> Result<&'a str, &'static str> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(key)
}

fn ensure_only_keys(arguments: &Value, allowed: &[&str]) -> Result<(), RuntimeError> {
    let object = arguments
        .as_object()
        .ok_or_else(|| RuntimeError::Invariant("tool arguments must be an object".into()))?;
    if let Some(unknown) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(RuntimeError::Invariant(format!(
            "unsupported tool argument: {unknown}"
        )));
    }
    Ok(())
}

fn validate_tool_arguments(name: &str, arguments: &Value) -> Result<(), RuntimeError> {
    let definition = tool_definitions()
        .into_iter()
        .find(|definition| definition.get("name").and_then(Value::as_str) == Some(name))
        .ok_or_else(|| RuntimeError::Invariant(format!("unknown tool: {name}")))?;
    if !arguments.is_object() {
        return Err(RuntimeError::Invariant(format!(
            "{name} arguments must be an object"
        )));
    }
    let schema = definition
        .get("inputSchema")
        .cloned()
        .unwrap_or_else(|| json!({"type":"object"}));
    let mut errors = Vec::new();
    validate_schema_value(
        arguments,
        &schema,
        &format!("{name} arguments"),
        &mut errors,
    );
    if let Some(error) = errors.first() {
        return Err(RuntimeError::Invariant(format!(
            "invalid arguments for {name}: {error}"
        )));
    }
    Ok(())
}

fn validate_schema_value(value: &Value, schema: &Value, label: &str, errors: &mut Vec<String>) {
    if let Some(alternatives) = schema.get("oneOf").and_then(Value::as_array) {
        let matches = alternatives
            .iter()
            .filter(|alternative| {
                let mut alternative_errors = Vec::new();
                validate_schema_value(value, alternative, label, &mut alternative_errors);
                alternative_errors.is_empty()
            })
            .count();
        if matches != 1 {
            errors.push(format!("{label} must match exactly one supported schema"));
        }
        return;
    }

    let schema_type = schema.get("type").and_then(Value::as_str);
    let type_matches = match schema_type {
        Some("object") => value.is_object(),
        Some("array") => value.is_array(),
        Some("string") => value.is_string(),
        Some("boolean") => value.is_boolean(),
        Some("integer") => value.as_f64().is_some_and(|number| {
            number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0
        }),
        Some("number") => value.as_f64().is_some_and(f64::is_finite),
        Some(_) => false,
        None => true,
    };
    if !type_matches {
        errors.push(format!(
            "{label} must be {}",
            schema_type.unwrap_or("a valid value")
        ));
        return;
    }

    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        if !values.iter().any(|candidate| candidate == value) {
            errors.push(format!("{label} must be one of the declared enum values"));
        }
    }

    if let Some(string) = value.as_str() {
        let length = string.encode_utf16().count() as u64;
        if schema
            .get("minLength")
            .and_then(Value::as_u64)
            .is_some_and(|minimum| length < minimum)
        {
            let minimum = schema["minLength"].as_u64().unwrap_or_default();
            errors.push(format!("{label} is shorter than {minimum} characters"));
        }
        if schema
            .get("maxLength")
            .and_then(Value::as_u64)
            .is_some_and(|maximum| length > maximum)
        {
            let maximum = schema["maxLength"].as_u64().unwrap_or_default();
            errors.push(format!("{label} exceeds {maximum} characters"));
        }
        if let Some(pattern) = schema.get("pattern").and_then(Value::as_str) {
            if !matches_schema_pattern(string, pattern) {
                errors.push(format!("{label} does not match the required pattern"));
            }
        }
    }

    if let Some(number) = value.as_f64() {
        if schema
            .get("minimum")
            .and_then(Value::as_f64)
            .is_some_and(|minimum| number < minimum)
        {
            let minimum = schema["minimum"].as_f64().unwrap_or_default();
            errors.push(format!("{label} is below {minimum}"));
        }
        if schema
            .get("maximum")
            .and_then(Value::as_f64)
            .is_some_and(|maximum| number > maximum)
        {
            let maximum = schema["maximum"].as_f64().unwrap_or_default();
            errors.push(format!("{label} exceeds {maximum}"));
        }
    }

    if let Some(items) = value.as_array() {
        let length = items.len() as u64;
        if schema
            .get("minItems")
            .and_then(Value::as_u64)
            .is_some_and(|minimum| length < minimum)
        {
            let minimum = schema["minItems"].as_u64().unwrap_or_default();
            errors.push(format!("{label} has fewer than {minimum} items"));
        }
        if schema
            .get("maxItems")
            .and_then(Value::as_u64)
            .is_some_and(|maximum| length > maximum)
        {
            let maximum = schema["maxItems"].as_u64().unwrap_or_default();
            errors.push(format!("{label} has more than {maximum} items"));
        }
        if let Some(item_schema) = schema.get("items") {
            for (index, item) in items.iter().enumerate() {
                validate_schema_value(item, item_schema, &format!("{label}[{index}]"), errors);
            }
        }
    }

    if let Some(object) = value.as_object() {
        let property_count = object.len() as u64;
        if schema
            .get("minProperties")
            .and_then(Value::as_u64)
            .is_some_and(|minimum| property_count < minimum)
        {
            let minimum = schema["minProperties"].as_u64().unwrap_or_default();
            errors.push(format!("{label} has fewer than {minimum} properties"));
        }
        if schema
            .get("maxProperties")
            .and_then(Value::as_u64)
            .is_some_and(|maximum| property_count > maximum)
        {
            let maximum = schema["maxProperties"].as_u64().unwrap_or_default();
            errors.push(format!("{label} has more than {maximum} properties"));
        }
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            for required_key in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(required_key) {
                    errors.push(format!("{label}.{required_key} is required"));
                }
            }
        }
        if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
            for (key, property_schema) in properties {
                if let Some(property_value) = object.get(key) {
                    validate_schema_value(
                        property_value,
                        property_schema,
                        &format!("{label}.{key}"),
                        errors,
                    );
                }
            }
            if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
                for key in object.keys() {
                    if !properties.contains_key(key) {
                        errors.push(format!("{label}.{key} is not allowed"));
                    }
                }
            }
        }
    }
}

fn matches_schema_pattern(value: &str, pattern: &str) -> bool {
    match pattern {
        "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$" => {
            let mut parts = value.split('-');
            parts.next().is_some_and(|first| {
                !first.is_empty()
                    && first.as_bytes()[0].is_ascii_lowercase()
                    && first
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            }) && parts.all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            })
        }
        "^job_[A-Za-z0-9_-]+$" => value.strip_prefix("job_").is_some_and(|suffix| {
            !suffix.is_empty()
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        }),
        "^[a-f0-9]{64}$" => {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        }
        "^graph_[A-Za-z0-9_-]+$" => value.strip_prefix("graph_").is_some_and(|suffix| {
            !suffix.is_empty()
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        }),
        "^agg-[a-f0-9]{24}$" => {
            value.len() == 28
                && value.starts_with("agg-")
                && value[4..]
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        }
        _ => false,
    }
}

fn redact_event_value(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(redact_event_text(&text)),
        Value::Array(items) => Value::Array(items.into_iter().map(redact_event_value).collect()),
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| {
                    let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
                    let sensitive = [
                        "token",
                        "secret",
                        "password",
                        "apikey",
                        "authorization",
                        "credential",
                        "privatekey",
                        "cookie",
                    ]
                    .iter()
                    .any(|needle| normalized.contains(needle));
                    (
                        key,
                        if sensitive {
                            Value::String("[REDACTED]".into())
                        } else {
                            redact_event_value(value)
                        },
                    )
                })
                .collect(),
        ),
        other => other,
    }
}

fn redact_event_text(input: &str) -> String {
    let mut output = input.to_owned();
    for prefix in ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "sk-"] {
        let mut cursor = 0;
        while cursor < output.len() {
            let Some(offset) = output[cursor..].find(prefix) else {
                break;
            };
            let start = cursor + offset;
            let mut end = start + prefix.len();
            while end < output.len() {
                let byte = output.as_bytes()[end];
                if byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-' {
                    end += 1;
                } else {
                    break;
                }
            }
            if end.saturating_sub(start) >= prefix.len() + 20 {
                output.replace_range(start..end, "[REDACTED_TOKEN]");
                cursor = start + "[REDACTED_TOKEN]".len();
            } else {
                cursor = end.max(start + prefix.len());
            }
        }
    }
    let mut cursor = 0;
    loop {
        let lower = output.to_ascii_lowercase();
        let Some(offset) = lower[cursor..].find("bearer ") else {
            break;
        };
        let start = cursor + offset + "bearer ".len();
        let end = output[start..]
            .find(|character: char| {
                character.is_whitespace() || matches!(character, ',' | ';' | '"' | '\'')
            })
            .map_or(output.len(), |offset| start + offset);
        if end > start {
            output.replace_range(start..end, "[REDACTED]");
            cursor = start + "[REDACTED]".len();
        } else {
            cursor = end.saturating_add(1);
        }
    }
    for key in [
        "api_key",
        "api-key",
        "access_token",
        "refresh_token",
        "password",
        "client_secret",
    ] {
        let mut cursor = 0;
        loop {
            let lower = output.to_ascii_lowercase();
            let Some(offset) = lower[cursor..].find(key) else {
                break;
            };
            let key_start = cursor + offset;
            let after_key = key_start + key.len();
            let Some(separator_offset) = output[after_key..]
                .find([':', '='])
                .filter(|offset| *offset <= 4)
            else {
                cursor = after_key;
                continue;
            };
            let mut value_start = after_key + separator_offset + 1;
            while value_start < output.len() && output.as_bytes()[value_start].is_ascii_whitespace()
            {
                value_start += 1;
            }
            let value_end = output[value_start..]
                .find(|character: char| {
                    character.is_whitespace() || matches!(character, ',' | ';' | '"' | '\'' | '}')
                })
                .map_or(output.len(), |offset| value_start + offset);
            if value_end > value_start {
                output.replace_range(value_start..value_end, "[REDACTED]");
                cursor = value_start + "[REDACTED]".len();
            } else {
                cursor = value_end.saturating_add(1);
            }
        }
    }
    output
}

fn tool_result(modern: bool, value: Value, is_error: bool) -> Value {
    let text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".into());
    let mut result = json!({
        "content": [{"type": "text", "text": text}],
        "isError": is_error
    });
    if modern {
        result["resultType"] = json!("complete");
        result["structuredContent"] = value;
    }
    result
}

fn tool_definitions() -> Vec<Value> {
    vec![
        tool(
            "orchestrator_health",
            "Inspect local Rust runtime and SQLite health",
            "Read-only local database quick_check and durable row counts. No remote probes, workflow evidence verification, startup source hash, or production authority claim. Requires host-injected database path.",
            object_schema(json!({}), &[]),
            true,
            true,
        ),
        tool(
            "workflow_recommend_resources",
            "Recommend reusable workflow resources",
            "Read-only deterministic Vietnamese/English lexical discovery across persisted custom workflows, custom roles and policies plus built-in role contracts. Recommendations are hints only: no resource is attached, permission granted, approved, dispatched or executed. Rust does not yet expose Node skill metadata or role-profile overlay compatibility scoring.",
            object_schema(
                json!({
                    "task":{"type":"string","minLength":1,"maxLength":12000},
                    "limit":{"type":"integer","minimum":1,"maximum":10,"default":5}
                }),
                &["task"],
            ),
            true,
            true,
        ),
        tool(
            "workflow_ready_tasks",
            "List dependency-ready tasks",
            "Read-only coordinator scheduling projection for PENDING tasks in APPROVED/EXECUTING workflows whose predecessors all SUCCEEDED. Does not claim, lease, spawn or dispatch tasks.",
            object_schema(
                json!({"limit":{"type":"integer","minimum":1,"maximum":500,"default":100}}),
                &[],
            ),
            true,
            true,
        ),
        tool(
            "custom_role_create",
            "Create immutable custom role version 1",
            "Persists a validated role contract. Skills must already be resolved by a trusted catalog; this host has no skill resolver and rejects non-empty skills. Role declarations do not grant runtime access. Actor is recorded as unattributed.",
            object_schema(
                json!({
                    "role_id":{"type":"string","pattern":"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$","maxLength":80},
                    "name":{"type":"string","minLength":1,"maxLength":120},"description":{"type":"string","minLength":1,"maxLength":2000},
                    "system_prompt":{"type":"string","minLength":1,"maxLength":12000},
                    "input_contract":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"string","enum":["job.request","requirements","research","architecture","implementation","security-review","qa-report","platform-review","documentation","review","cto-decision"]}},
                    "output_artifact_type":{"type":"string"},"allowed_capabilities":{"type":"array","maxItems":32,"items":{"type":"string"}},
                    "permissions":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"string","enum":["workspace.read","artifact.create"]}},
                    "allowed_tools":{"type":"array","maxItems":32,"items":{"type":"string"}},"skills":{"type":"array","maxItems":32,"items":{"type":"string"}}
                }),
                &[
                    "role_id",
                    "name",
                    "description",
                    "system_prompt",
                    "input_contract",
                    "output_artifact_type",
                ],
            ),
            false,
            false,
        ),
        tool(
            "custom_role_update",
            "Append immutable custom role version",
            "Creates next role version; omitted fields retain prior values. Existing workflow definitions keep exact role-version pins. Actor is recorded as unattributed.",
            object_schema(
                json!({"role_id":{"type":"string"},"name":{"type":"string"},"description":{"type":"string"},"system_prompt":{"type":"string"},"input_contract":{"type":"array","items":{"type":"string"}},"output_artifact_type":{"type":"string"},"allowed_capabilities":{"type":"array","items":{"type":"string"}},"permissions":{"type":"array","items":{"type":"string"}},"allowed_tools":{"type":"array","items":{"type":"string"}},"skills":{"type":"array","items":{"type":"string"}}}),
                &["role_id"],
            ),
            false,
            false,
        ),
        tool(
            "custom_role_clone",
            "Clone immutable custom role definition",
            "Creates a separate version-1 role. Non-empty source skill pins are revalidated against the host resolver before their exact snapshots are copied; replacement skills also require host resolution. Requires host-authenticated catalog author and grants no runtime access.",
            object_schema(
                json!({
                    "source_role_id":{"type":"string","pattern":"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$","maxLength":80},
                    "role_id":{"type":"string","pattern":"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$","maxLength":80},
                    "name":{"type":"string","minLength":1,"maxLength":120},
                    "description":{"type":"string","minLength":1,"maxLength":2000},
                    "system_prompt":{"type":"string","minLength":1,"maxLength":12000},
                    "input_contract":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"string"}},
                    "output_artifact_type":{"type":"string"},
                    "allowed_capabilities":{"type":"array","maxItems":32,"items":{"type":"string"}},
                    "permissions":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"string","enum":["workspace.read","artifact.create"]}},
                    "allowed_tools":{"type":"array","maxItems":32,"items":{"type":"string"}},
                    "skills":{"type":"array","maxItems":32,"items":{"type":"string"}}
                }),
                &["source_role_id", "role_id"],
            ),
            false,
            false,
        ),
        tool(
            "custom_role_get",
            "Read custom role version",
            "Read-only exact or latest immutable custom role definition.",
            object_schema(
                json!({"role_id":{"type":"string"},"version":{"type":"integer","minimum":1}}),
                &["role_id"],
            ),
            true,
            false,
        ),
        tool(
            "custom_role_list",
            "List custom role catalog",
            "Read-only bounded list; include_versions returns immutable history.",
            object_schema(
                json!({"include_versions":{"type":"boolean"},"limit":{"type":"integer","minimum":1,"maximum":200}}),
                &[],
            ),
            true,
            true,
        ),
        tool(
            "custom_workflow_create",
            "Create immutable custom workflow version 1",
            "Persists a typed DAG only when all exact custom role versions exist and contracts compile. Does not approve or execute a workflow.",
            object_schema(
                json!({
                    "workflow_id":{"type":"string","pattern":"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$","maxLength":80},"name":{"type":"string","minLength":1,"maxLength":120},
                    "description":{"type":"string","minLength":1,"maxLength":2000},"input_contract":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"string"}},
                    "tasks":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string"},"role_id":{"type":"string"},"role_version":{"type":"integer","minimum":1},"depends_on":{"type":"array","items":{"type":"string"}},"input_contract":{"type":"array","items":{"type":"string"}},"output_artifact_type":{"type":"string"}},"required":["id","role_id","role_version"]}}
                }),
                &[
                    "workflow_id",
                    "name",
                    "description",
                    "input_contract",
                    "tasks",
                ],
            ),
            false,
            false,
        ),
        tool(
            "custom_workflow_update",
            "Append immutable custom workflow version",
            "Creates next complete definition version. Existing compiled plans remain pinned to historical versions.",
            object_schema(
                json!({"workflow_id":{"type":"string"},"name":{"type":"string"},"description":{"type":"string"},"input_contract":{"type":"array","items":{"type":"string"}},"tasks":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"object"}}}),
                &[
                    "workflow_id",
                    "name",
                    "description",
                    "input_contract",
                    "tasks",
                ],
            ),
            false,
            false,
        ),
        tool(
            "custom_workflow_clone",
            "Clone custom workflow definition",
            "Creates a separate version-1 definition from the latest source version. Referenced custom role versions remain pinned unless a complete replacement task list is supplied. Requires host-authenticated catalog author; clone does not approve or authorize execution.",
            object_schema(
                json!({
                    "source_workflow_id":{"type":"string","minLength":1,"maxLength":80},
                    "workflow_id":{"type":"string","pattern":"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$","maxLength":80},
                    "name":{"type":"string","minLength":1,"maxLength":120},
                    "description":{"type":"string","minLength":1,"maxLength":2000},
                    "input_contract":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"string","enum":["job.request","requirements","research","architecture","implementation","security-review","qa-report","platform-review","documentation","review","cto-decision"]}},
                    "tasks":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string"},"role_id":{"type":"string"},"role_version":{"type":"integer","minimum":1},"depends_on":{"type":"array","items":{"type":"string"}},"input_contract":{"type":"array","items":{"type":"string"}},"output_artifact_type":{"type":"string"}},"required":["id","role_id","role_version"]}}
                }),
                &["source_workflow_id", "workflow_id"],
            ),
            false,
            false,
        ),
        tool(
            "custom_workflow_get",
            "Read custom workflow version",
            "Read-only exact or latest immutable custom workflow definition.",
            object_schema(
                json!({"workflow_id":{"type":"string"},"version":{"type":"integer","minimum":1}}),
                &["workflow_id"],
            ),
            true,
            false,
        ),
        tool(
            "custom_workflow_list",
            "List custom workflow catalog",
            "Read-only bounded list; include_versions returns immutable history.",
            object_schema(
                json!({"include_versions":{"type":"boolean"},"limit":{"type":"integer","minimum":1,"maximum":200}}),
                &[],
            ),
            true,
            true,
        ),
        tool(
            "custom_workflow_preview",
            "Compile and persist custom workflow plan",
            "Compiles exact stored workflow and role versions, persists immutable plan digest and topological order. Preview is not approval or execution authorization.",
            object_schema(
                json!({"workflow_id":{"type":"string"},"version":{"type":"integer","minimum":1}}),
                &["workflow_id"],
            ),
            false,
            false,
        ),
        tool(
            "workflow_policy_catalog",
            "Inspect closed workflow policy predicates",
            "Read-only list of supported predicate schemas and exact Rust enforcement status. Predicates marked UNRESOLVED never satisfy a success contract; use only documented closed fields.",
            object_schema(json!({}), &[]),
            true,
            false,
        ),
        tool(
            "workflow_policy_create",
            "Create immutable workflow policy version 1",
            "Creates a validated immutable policy pack. Requires host-authenticated catalog author; caller-supplied actor fields are rejected. Creation does not attach or authorize execution.",
            object_schema(
                json!({
                    "policy_id":{"type":"string","pattern":"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$","minLength":1,"maxLength":38},
                    "name":{"type":"string","minLength":1,"maxLength":120},"description":{"type":"string","maxLength":2000},
                "constraints":{"type":"array","maxItems":32,"items":{"type":"object"}},
                "success_criteria":{"type":"array","maxItems":32,"items":{"type":"object"}}
                }),
                &["policy_id", "name"],
            ),
            false,
            false,
        ),
        tool(
            "workflow_policy_list",
            "List immutable workflow policy packs",
            "Read-only bounded listing; optionally includes all immutable versions and current workflow attachments.",
            object_schema(
                json!({"include_versions":{"type":"boolean"},"limit":{"type":"integer","minimum":1,"maximum":200},"query":{"type":"string","maxLength":120}}),
                &[],
            ),
            true,
            true,
        ),
        tool(
            "workflow_policy_get",
            "Read exact workflow policy version",
            "Read-only exact/latest immutable definition, digest and workflow attachment records.",
            object_schema(
                json!({"policy_id":{"type":"string","minLength":1,"maxLength":38},"version":{"type":"integer","minimum":1}}),
                &["policy_id"],
            ),
            true,
            false,
        ),
        tool(
            "workflow_policy_update",
            "Append immutable workflow policy version",
            "Creates the next immutable version. Omitted fields retain prior values; exact older pins remain unchanged. Requires host-authenticated catalog author.",
            object_schema(
                json!({
                    "policy_id":{"type":"string","minLength":1,"maxLength":38},"name":{"type":"string","minLength":1,"maxLength":120},
                "description":{"type":"string","maxLength":2000},"constraints":{"type":"array","maxItems":32,"items":{"type":"object"}},
                "success_criteria":{"type":"array","maxItems":32,"items":{"type":"object"}}
                }),
                &["policy_id"],
            ),
            false,
            false,
        ),
        tool(
            "workflow_policy_validate",
            "Validate policy definition without persistence",
            "Read-only closed-schema validation and digest preview. Target plan compatibility is revalidated atomically when attached; unresolved evidence predicates remain fail-closed.",
            object_schema(
                json!({
                    "policy_id":{"type":"string","minLength":1,"maxLength":38},"name":{"type":"string","minLength":1,"maxLength":120},
                "description":{"type":"string","maxLength":2000},"constraints":{"type":"array","maxItems":32,"items":{"type":"object"}},
                "success_criteria":{"type":"array","maxItems":32,"items":{"type":"object"}}
                }),
                &["policy_id", "name"],
            ),
            true,
            false,
        ),
        tool(
            "workflow_policy_attach",
            "Pin exact policy version to proposal",
            "State-changing exact version attachment only to an unapproved proposed workflow. Persists composed success-contract snapshot atomically; approval later pins that snapshot to the immutable plan digest. Requires host-authenticated catalog author.",
            object_schema(
                json!({"job_id":{"type":"string","minLength":1,"maxLength":200},"policy_id":{"type":"string","minLength":1,"maxLength":38},"version":{"type":"integer","minimum":1}}),
                &["job_id", "policy_id"],
            ),
            false,
            false,
        ),
        tool(
            "workflow_compile",
            "Compile a version-pinned custom workflow",
            "Read-only compilation of a strict custom workflow against explicit custom role versions. Validates typed artifact contracts, tool/permission allowlists, dependency DAG and immutable plan digest. No role catalog persistence, approval, trust verification or execution authorization is performed.",
            json!({
                "type":"object",
                "properties":{
                    "workflow":{"type":"object","additionalProperties":false,"properties":{
                        "workflow_id":{"type":"string","minLength":1,"maxLength":80},
                        "version":{"type":"integer","minimum":1},
                        "name":{"type":"string","minLength":1,"maxLength":120},
                        "description":{"type":"string","minLength":1,"maxLength":2000},
                        "input_contract":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"string","enum":["job.request","requirements","research","architecture","implementation","security-review","qa-report","platform-review","documentation","review","cto-decision"]}},
                        "tasks":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"object","additionalProperties":false,"properties":{
                            "id":{"type":"string"},"role_id":{"type":"string"},"role_version":{"type":"integer","minimum":1},
                            "depends_on":{"type":"array","maxItems":32,"items":{"type":"string"}},
                            "input_contract":{"type":"array","maxItems":32,"items":{"type":"string"}},
                            "output_artifact_type":{"type":"string"}
                        },"required":["id","role_id","role_version"]}}
                    },"required":["workflow_id","version","name","description","input_contract","tasks"]},
                    "roles":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"object","additionalProperties":false,"properties":{
                        "role_id":{"type":"string"},"version":{"type":"integer","minimum":1},"name":{"type":"string"},
                        "description":{"type":"string"},"system_prompt":{"type":"string"},
                        "input_contract":{"type":"array","items":{"type":"string"}},"output_artifact_type":{"type":"string"},
                        "allowed_capabilities":{"type":"array","items":{"type":"string","enum":["product.requirements","research.collect","architecture.design","code.modify","security.audit","code.verify","infrastructure.verify","documentation.write","change.review","synthesis.approve"]}},
                        "permissions":{"type":"array","items":{"type":"string","enum":["workspace.read","artifact.create"]}},
                        "allowed_tools":{"type":"array","items":{"type":"string"}},"skills":{"type":"array","items":{"type":"string"}}
                    },"required":["role_id","version","name","description","system_prompt","input_contract","output_artifact_type","allowed_capabilities","permissions","allowed_tools","skills"]}}
                },"required":["workflow","roles"],"additionalProperties":false
            }),
            true,
            true,
        ),
        tool(
            "workflow_create",
            "Create review-only workflow proposal",
            "Persist a typed Goal/Plan candidate. This never approves or dispatches work.",
            json!({
                "type":"object",
                "properties": {
                    "workflow_id":{"type":"string","pattern":"^job_[A-Za-z0-9_-]+$"},
                    "title":{"type":"string","minLength":1},
                    "goal":{"type":"string","minLength":1},
                    "tasks":{"type":"array","minItems":1,"maxItems":256,"items":{
                        "type":"object","additionalProperties":false,
                        "properties": {
                            "task_id":{"type":"string"},"role":{"type":"string"},
                            "description":{"type":"string"},"depends_on":{"type":"array","items":{"type":"string"}},
                            "required_evidence":{"type":"array","items":{"type":"string"}},"inputs":{"type":"object"}
                        },"required":["task_id","role","description"]
                    }},
                    "metadata":{"type":"object"}
                },"required":["workflow_id","title","goal","tasks"],"additionalProperties":false
            }),
            false,
            false,
        ),
        tool(
            "workflow_get",
            "Read workflow and immutable plan",
            "Read workflow state, proposal, immutable plan hash, approval record, task leases and results.",
            object_schema(json!({"workflow_id":{"type":"string"}}), &["workflow_id"]),
            true,
            false,
        ),
        tool(
            "workflow_list",
            "List active workflows",
            "Read-only list of locally stored PROPOSED, APPROVED and EXECUTING workflows, ordered by most recent update.",
            object_schema(
                json!({"limit":{"type":"integer","minimum":1,"maximum":100,"default":25}}),
                &[],
            ),
            true,
            true,
        ),
        tool(
            "workflow_events",
            "Read workflow event history",
            "Read-only chronological slice of immutable workflow events with secret redaction and a 4,000-character payload cap. Use workflow_verify_event_chain separately to verify full journal integrity.",
            object_schema(
                json!({"job_id":{"type":"string","minLength":1,"maxLength":200},"limit":{"type":"integer","minimum":1,"maximum":500,"default":100}}),
                &["job_id"],
            ),
            true,
            true,
        ),
        tool(
            "workflow_validate_artifact",
            "Validate typed artifact content",
            "Read-only Node-compatible validation of known typed artifact content and optional built-in role output type. Does not persist an artifact, authenticate a producer, prove task-attempt lineage, or authorize workflow completion.",
            object_schema(
                json!({
                    "artifact_type":{"type":"string","minLength":1},
                    "artifact":{"type":"object"},
                    "role":{"type":"string"}
                }),
                &["artifact_type", "artifact"],
            ),
            true,
            true,
        ),
        tool(
            "workflow_diagnose",
            "Diagnose durable workflow state",
            "Read-only diagnosis of Rust workflow/task states and persisted lease metadata. It does not inspect external runtime sessions, heartbeats or provider status; missing lease metadata is not proof of worker death. Never retries, replays, dispatches or mutates workflow state.",
            object_schema(
                json!({"workflow_id":{"type":"string","minLength":1,"maxLength":200}}),
                &["workflow_id"],
            ),
            true,
            true,
        ),
        tool(
            "workflow_attempt_inspect",
            "Inspect durable ownership for one task attempt",
            "Read-only inspection of current attempt, independent owner epoch, historical lease/result-digest ledger, immutable plan digest, lease and provider intent. Does not query runtime sessions/heartbeats and never infers worker death from missing metadata; unresolved provider states remain unresolved. Never retries, replays, dispatches or mutates lifecycle state.",
            object_schema(
                json!({"workflow_id":{"type":"string","minLength":1,"maxLength":200},"task_id":{"type":"string","minLength":1,"maxLength":200}}),
                &["workflow_id", "task_id"],
            ),
            true,
            true,
        ),
        tool(
            "agent_session_create",
            "Create durable agent session",
            "Create a Rust-native session registry row and immutable workflow event. Runtime session key is identity only, not liveness evidence.",
            object_schema(
                json!({"workflow_id":{"type":"string"},"task_id":{"type":"string"},"runtime_session_key":{"type":"string"},"role":{"type":"string"},"parent_session_key":{"type":["string","null"]},"attempt":{"type":"integer","minimum":1}}),
                &["workflow_id", "task_id", "runtime_session_key", "role"],
            ),
            false,
            false,
        ),
        tool(
            "agent_session_list",
            "List durable agent sessions",
            "Read-only bounded session registry query. Registry state is not runtime-liveness evidence.",
            object_schema(
                json!({"workflow_id":{"type":"string"},"task_id":{"type":"string"},"state":{"type":"string","enum":["CREATED","ACTIVE","PAUSED","STALE","FAILED","TERMINATED"]},"limit":{"type":"integer","minimum":1,"maximum":500,"default":100}}),
                &[],
            ),
            true,
            false,
        ),
        tool(
            "agent_session_inspect",
            "Inspect agent session and delivery history",
            "Read one session under OBSERVE ACL in a consistent read transaction. Returns bounded chronological messages, access grants and an explicit truncation flag; does not infer liveness or mutate lifecycle.",
            object_schema(
                json!({"session_id":{"type":"string"},"actor_role":{"type":"string"},"include_revoked_access":{"type":"boolean","default":false},"message_limit":{"type":"integer","minimum":1,"maximum":500,"default":100}}),
                &["session_id", "actor_role"],
            ),
            true,
            false,
        ),
        tool(
            "agent_session_update",
            "Update agent session lifecycle",
            "Compare-and-set session lifecycle by expected attempt. Heartbeat records caller assertion only; it does not authenticate runtime liveness.",
            object_schema(
                json!({"session_id":{"type":"string"},"expected_attempt":{"type":"integer","minimum":1},"state":{"type":"string","enum":["CREATED","ACTIVE","PAUSED","STALE","FAILED","TERMINATED"]},"current_turn_id":{"type":["string","null"]},"heartbeat":{"type":"boolean"}}),
                &["session_id", "expected_attempt", "state"],
            ),
            false,
            false,
        ),
        tool(
            "agent_session_access_grant",
            "Grant role-scoped session access",
            "Persist explicit OBSERVE/MESSAGE/EXECUTE/TAKEOVER ACL. Only system/cto or eligible owner grants are accepted; expiry must be canonical UTC.",
            object_schema(
                json!({"session_id":{"type":"string"},"accessor_role":{"type":"string"},"permission":{"type":"string","enum":["OBSERVE","MESSAGE","EXECUTE","TAKEOVER"]},"granted_by":{"type":"string"},"expires_at":{"type":["string","null"]}}),
                &["session_id", "accessor_role", "permission", "granted_by"],
            ),
            false,
            false,
        ),
        tool(
            "agent_session_access_revoke",
            "Revoke session access",
            "Revoke an explicit ACL grant under SQLite writer reservation and append audit event.",
            object_schema(
                json!({"access_id":{"type":"string"},"actor":{"type":"string"}}),
                &["access_id", "actor"],
            ),
            false,
            false,
        ),
        tool(
            "agent_session_attach",
            "Attach to agent session",
            "Attach under explicit OBSERVE, INTERACT or TAKEOVER ACL. Records a durable session.attached event; does not mutate task or session lifecycle.",
            object_schema(
                json!({"session_id":{"type":"string"},"actor_role":{"type":"string"},"mode":{"type":"string","enum":["OBSERVE","INTERACT","TAKEOVER"],"default":"OBSERVE"}}),
                &["session_id", "actor_role"],
            ),
            false,
            false,
        ),
        tool(
            "agent_session_takeover",
            "Take over agent session",
            "Take over only PAUSED, STALE or FAILED session with explicit non-owner TAKEOVER grant. Writes session lifecycle and takeover audit events atomically.",
            object_schema(
                json!({"session_id":{"type":"string"},"actor_role":{"type":"string"},"reason":{"type":"string","minLength":1}}),
                &["session_id", "actor_role", "reason"],
            ),
            false,
            false,
        ),
        tool(
            "agent_session_message_enqueue",
            "Enqueue durable agent message",
            "Enqueue detached JSON-object COS-AP v1 message with per-session dedupe and atomic event journal. Requires sender MESSAGE permission.",
            object_schema(
                json!({"session_id":{"type":"string"},"message":{"type":"object","properties":{"sender_role":{"type":"string"},"recipient_role":{"type":"string"},"message_type":{"type":"string"},"payload":{"type":"object"},"correlation_id":{"type":["string","null"]},"dedupe_key":{"type":["string","null"]},"available_at":{"type":["string","null"]}},"required":["sender_role","recipient_role","message_type","payload"]}}),
                &["session_id", "message"],
            ),
            false,
            false,
        ),
        tool(
            "agent_session_message_claim",
            "Claim queued agent message",
            "Claim one queued message for exact recipient role. Claim lease is durable; expired claims before transport-start may be safely reclaimed, after transport-start become UNCERTAIN.",
            object_schema(
                json!({"message_id":{"type":"string"},"recipient_role":{"type":"string"},"lease_seconds":{"type":"integer","minimum":1,"maximum":86400,"default":60}}),
                &["message_id", "recipient_role"],
            ),
            false,
            false,
        ),
        tool(
            "agent_session_message_start",
            "Record external delivery start",
            "Persist exact attempt/lease transport-start intent before external send. Does not invoke transport.",
            object_schema(
                json!({"message_id":{"type":"string"},"attempt":{"type":"integer","minimum":1},"lease_until":{"type":"string"}}),
                &["message_id", "attempt", "lease_until"],
            ),
            false,
            false,
        ),
        tool(
            "agent_session_message_receipt",
            "Record successful delivery receipt",
            "Persist exact successful run ID receipt for current claim. Receipt must bind the exact session key; run IDs cannot be reused.",
            object_schema(
                json!({"message_id":{"type":"string"},"attempt":{"type":"integer","minimum":1},"lease_until":{"type":"string"},"receipt":{"type":"object","properties":{"run_id":{"type":"string","minLength":1},"session_key":{"type":"string","minLength":1},"response":{},"recorded_at":{"type":"string"}},"required":["run_id","session_key","recorded_at"]}}),
                &["message_id", "attempt", "lease_until", "receipt"],
            ),
            false,
            false,
        ),
        tool(
            "agent_session_message_ack",
            "Acknowledge successful delivery",
            "ACK requires exact recipient, unexpired lease, durable transport-start marker and successful receipt. Does not infer success from a claim alone.",
            object_schema(
                json!({"message_id":{"type":"string"},"recipient_role":{"type":"string"},"attempt":{"type":"integer","minimum":1},"lease_until":{"type":"string"}}),
                &["message_id", "recipient_role", "attempt", "lease_until"],
            ),
            false,
            false,
        ),
        tool(
            "agent_session_message_uncertain",
            "Quarantine ambiguous delivery",
            "Persist UNCERTAIN after transport-start. Uncertain messages are never automatically replayed or retried.",
            object_schema(
                json!({"message_id":{"type":"string"},"attempt":{"type":"integer","minimum":1},"reason":{"type":"string","minLength":1}}),
                &["message_id", "attempt", "reason"],
            ),
            false,
            false,
        ),
        tool(
            "workflow_approve",
            "Approve exact proposal and plan",
            "Requires externally authenticated reviewer identity, policy/quorum verification and exact proposal/plan digest binding. Rejects by default when authority is not provisioned.",
            object_schema(
                json!({
                    "workflow_id":{"type":"string"},"actor":{"type":"string"},
                    "expected_proposal_hash":{"type":"string","pattern":"^[a-f0-9]{64}$"},
                    "expected_plan_hash":{"type":"string","pattern":"^[a-f0-9]{64}$"},
                    "evidence":{"type":"object"}
                }),
                &[
                    "workflow_id",
                    "actor",
                    "expected_proposal_hash",
                    "expected_plan_hash",
                    "evidence",
                ],
            ),
            false,
            false,
        ),
        tool(
            "workflow_claim_task",
            "Claim dependency-ready approved task",
            "Claims a task only under the current approved plan and a fenced worker lease. Does not execute the task.",
            object_schema(
                json!({
                    "workflow_id":{"type":"string"},"task_id":{"type":"string"},"worker_id":{"type":"string"},
                    "lease_ttl_seconds":{"type":"integer","minimum":1,"maximum":600}
                }),
                &["workflow_id", "task_id", "worker_id", "lease_ttl_seconds"],
            ),
            false,
            false,
        ),
        tool(
            "workflow_record_task_result",
            "Record fenced task result",
            "Records result for the exact worker lease and attempt. Success requires every declared evidence category and matching producer lineage. UNKNOWN is quarantined, never replayed.",
            object_schema(
                json!({
                    "workflow_id":{"type":"string"},"task_id":{"type":"string"},"lease_id":{"type":"string"},
                    "worker_id":{"type":"string"},"attempt":{"type":"integer","minimum":1},
                    "event_id":{"type":"string","minLength":1,"maxLength":128},"producer_id":{"type":"string","minLength":1,"maxLength":200},
                    "payload_sha256":{"type":"string","pattern":"^[a-f0-9]{64}$"},
                    "outcome":{"type":"string","enum":["SUCCEEDED","FAILED","UNKNOWN"]},
                    "evidence":{"type":"array","items":{"type":"object"}},"error":{"type":"string"}
                }),
                &[
                    "workflow_id",
                    "task_id",
                    "lease_id",
                    "worker_id",
                    "attempt",
                    "event_id",
                    "producer_id",
                    "payload_sha256",
                    "outcome",
                    "evidence",
                ],
            ),
            false,
            false,
        ),
        tool(
            "workflow_recovery_quarantine_expired",
            "Quarantine expired task leases",
            "Moves expired worker leases to UNKNOWN. Does not infer worker death, dispatch, retry or replay.",
            object_schema(json!({}), &[]),
            false,
            true,
        ),
        tool(
            "workflow_verify_event_chain",
            "Verify append-only workflow event chain",
            "Read-only SHA-256 chain verification for every workflow event. Detects journal tampering and broken event linkage.",
            object_schema(json!({"workflow_id":{"type":"string"}}), &["workflow_id"]),
            true,
            true,
        ),
        tool(
            "workflow_synthesize",
            "Synthesize persisted workflow evidence",
            "Deterministically reconstructs task, attempt, result-inbox, approval, policy and success-contract provenance. Persists an immutable report event. Reports PASSED only when workflow is COMPLETED and every persisted success predicate passes; unsupported evidence remains UNRESOLVED.",
            object_schema(
                json!({"workflow_id":{"type":"string","minLength":1,"maxLength":200}}),
                &["workflow_id"],
            ),
            false,
            false,
        ),
        tool(
            "graph_create",
            "Create empty persistent Goal/Idea graph",
            "Creates graph metadata only in Rust-owned SQLite. No external action or trust is implied.",
            object_schema(
                json!({"graph_id":{"type":"string","pattern":"^graph_[A-Za-z0-9_-]+$"}}),
                &["graph_id"],
            ),
            false,
            false,
        ),
        tool(
            "graph_node_append",
            "Append immutable graph node revision",
            "Appends a content-addressed node revision. Node kind and previous revision digest are fenced.",
            object_schema(
                json!({"graph_id":{"type":"string"},"node":{"type":"object"}}),
                &["graph_id", "node"],
            ),
            false,
            false,
        ),
        tool(
            "graph_edge_append",
            "Append typed graph edge",
            "Appends an immutable typed edge between existing graph nodes.",
            object_schema(
                json!({"graph_id":{"type":"string"},"edge":{"type":"object"}}),
                &["graph_id", "edge"],
            ),
            false,
            false,
        ),
        tool(
            "graph_evidence_capture",
            "Capture unverified graph evidence",
            "Persists source URI and digest as UNVERIFIED. This tool cannot promote evidence to VERIFIED.",
            object_schema(
                json!({"graph_id":{"type":"string"},"evidence":{"type":"object"}}),
                &["graph_id", "evidence"],
            ),
            false,
            false,
        ),
        tool(
            "graph_snapshot_create",
            "Seal immutable graph snapshot",
            "Pins exact node revisions, edges, evidence and predecessor digest. Snapshot is append-only.",
            object_schema(json!({"graph_id":{"type":"string"}}), &["graph_id"]),
            false,
            false,
        ),
        tool(
            "graph_snapshot_get",
            "Read an exact immutable graph snapshot",
            "Read-only lookup of the latest or exact persisted snapshot revision. The Store revalidates the snapshot payload, digest, database binding and predecessor hash; this does not create or mutate a snapshot and does not verify evidence claims. Responses are capped at the 1 MiB MCP frame limit; oversized snapshots fail closed with a bounded protocol error.",
            object_schema(
                json!({
                    "graph_id":{"type":"string","minLength":1,"maxLength":128},
                    "revision":{"type":"integer","minimum":1,"maximum":9_007_199_254_740_991_i64}
                }),
                &["graph_id"],
            ),
            true,
            true,
        ),
        tool(
            "adaptive_goal_graph_search",
            "Search Goal/Idea graph into review-only candidates",
            "Deterministic bounded shadow search over the latest immutable snapshot. Unknown metrics stay unknown; recovery edges excluded; never approves, compiles, or dispatches.",
            object_schema(
                json!({
                    "graph_id":{"type":"string"},"start_node_id":{"type":"string"},"goal_node_id":{"type":"string"},
                    "options":{"type":"object","properties":{
                        "max_depth":{"type":"integer","minimum":1,"maximum":100},
                        "beam_width":{"type":"integer","minimum":1,"maximum":100},
                        "max_expansions":{"type":"integer","minimum":1,"maximum":10000},
                        "initially_available_ids":{"type":"array","items":{"type":"string"}}
                    },"additionalProperties":false}
                }),
                &["graph_id", "start_node_id", "goal_node_id"],
            ),
            true,
            false,
        ),
        tool(
            "adaptive_goal_phase2_rank",
            "Rank exact Phase 1 candidates with validated discriminator model",
            "Reproduces bounded Phase 1 search from the latest immutable snapshot, validates the supplied Node-compatible discriminator model, then ranks candidates. Model estimates remain unverified; no evidence, approval, execution, or dispatch authority.",
            object_schema(
                json!({
                    "graph_id":{"type":"string"},"start_node_id":{"type":"string"},"goal_node_id":{"type":"string"},
                    "options":{"type":"object","properties":{
                        "max_depth":{"type":"integer","minimum":1,"maximum":100},
                        "beam_width":{"type":"integer","minimum":1,"maximum":100},
                        "max_expansions":{"type":"integer","minimum":1,"maximum":10000},
                        "initially_available_ids":{"type":"array","items":{"type":"string"}}
                    },"additionalProperties":false},
                    "model":{"type":"object","description":"Complete discriminator model v2. Strict schema, provenance, metrics and digest validation is performed by the Rust kernel."}
                }),
                &["graph_id", "start_node_id", "goal_node_id", "model"],
            ),
            true,
            false,
        ),
        tool(
            "adaptive_goal_mcts_shadow_search",
            "Run bounded Phase 3 MCTS shadow search",
            "Deterministic digest-seeded MCTS over validated graph transitions using a validated discriminator model as unverified rollout reward. Always non-exhaustive, evidence UNKNOWN, and never execution/dispatch-authorized.",
            object_schema(
                json!({
                    "graph_id":{"type":"string"},"start_node_id":{"type":"string"},"goal_node_id":{"type":"string"},
                    "options":{"type":"object","properties":{
                        "iterations":{"type":"integer","minimum":1,"maximum":10000},
                        "max_depth":{"type":"integer","minimum":1,"maximum":100},
                        "exploration":{"type":"number","minimum":0,"maximum":10},
                        "initially_available_ids":{"type":"array","items":{"type":"string"}}
                    },"additionalProperties":false},
                    "model":{"type":"object","description":"Complete discriminator model v2. Strict schema, provenance, metrics and digest validation is performed by the Rust kernel."}
                }),
                &["graph_id", "start_node_id", "goal_node_id", "model"],
            ),
            true,
            false,
        ),
        tool(
            "adaptive_goal_plan_project",
            "Project exact AGG candidate into review-only Plan Graph",
            "Reproduces search from the exact immutable graph snapshot and candidate ID. Produces a draft only: no immutable workflow plan, approval, execution authorization, or dispatch.",
            object_schema(
                json!({
                    "graph_id":{"type":"string"},"start_node_id":{"type":"string"},"goal_node_id":{"type":"string"},
                    "candidate_plan_id":{"type":"string","pattern":"^agg-[a-f0-9]{24}$"},
                    "options":{"type":"object","properties":{
                        "max_depth":{"type":"integer","minimum":1,"maximum":100},
                        "beam_width":{"type":"integer","minimum":1,"maximum":100},
                        "max_expansions":{"type":"integer","minimum":1,"maximum":10000},
                        "initially_available_ids":{"type":"array","items":{"type":"string"}}
                    },"additionalProperties":false}
                }),
                &[
                    "graph_id",
                    "start_node_id",
                    "goal_node_id",
                    "candidate_plan_id",
                ],
            ),
            true,
            false,
        ),
        tool(
            "workflow_execution_graph_get",
            "Read durable Execution Graph projection",
            "Projects exact workflow plan, task states, latest attempts, leases, evidence and event-chain status. Prior attempts and provider-run identity remain explicitly unavailable; this read never dispatches.",
            object_schema(json!({"workflow_id":{"type":"string"}}), &["workflow_id"]),
            true,
            false,
        ),
        tool(
            "workflow_sandbox_execute",
            "Execute one plan-pinned command in Bubblewrap sandbox",
            "Requires host sandbox/artifact configuration, current approval, exact sandbox_command pinned in immutable task inputs, and sandbox_execution evidence requirement. No shell interpolation or unsandboxed fallback; ambiguous process outcomes quarantine the task.",
            object_schema(
                json!({
                    "workflow_id":{"type":"string"},"task_id":{"type":"string"},
                    "worker_id":{"type":"string"},"lease_ttl_seconds":{"type":"integer","minimum":1,"maximum":600}
                }),
                &["workflow_id", "task_id", "worker_id", "lease_ttl_seconds"],
            ),
            false,
            false,
        ),
        tool(
            "workflow_provider_reconcile",
            "Reconcile an existing provider dispatch intent",
            "Calls only the host-registered adapter lookup for the persisted provider_id and idempotency key. Appends exact lookup evidence. Never dispatches or replays work; UNKNOWN remains terminal.",
            object_schema(
                json!({"intent_id":{"type":"string","minLength":1,"maxLength":256}}),
                &["intent_id"],
            ),
            false,
            true,
        ),
    ]
}

fn resource_definitions() -> Vec<Value> {
    vec![
        json!({
            "uri":"runalith://governance/authority",
            "name":"Governance authority posture",
            "description":"Current Rust host trust and approval boundaries, including fail-closed defaults.",
            "mimeType":"text/markdown"
        }),
        json!({
            "uri":"runalith://governance/part-boundaries",
            "name":"Three-part ownership boundaries",
            "description":"Target ownership and cross-part contract rules for Workflow Control, Execution Workers, and Governance & Interface.",
            "mimeType":"text/markdown"
        }),
        json!({
            "uri":"runalith://interface/operator-guide",
            "name":"Operator inspection guide",
            "description":"Read-only workflow, attempt, event-chain, and unknown-outcome inspection guidance.",
            "mimeType":"text/markdown"
        }),
    ]
}

fn resource_content(uri: &str) -> Option<&'static str> {
    match uri {
        "runalith://governance/authority" => Some(
            "# Governance authority posture\n\n- Approval defaults to deny-all unless the host injects a verifier.\n- Trust configuration and trust-ledger APIs are not connected to production host configuration.\n- A verified signature proves control of a configured key; it does not establish independent evidence truth or external checkpoint custody.\n- AGG estimates and graph hashes do not authorize execution.\n- Missing trust configuration, verifier, candidate binding, or checkpoint continuity must leave authorization blocked.\n- This local Rust host has no production trust provisioning or external checkpoint adapter.\n",
        ),
        "runalith://governance/part-boundaries" => Some(
            "# Three-part ownership boundaries\n\n## Workflow Control\nOwns workflow definitions, immutable plans, workflow/task lifecycle, lease epochs, and lifecycle decisions.\n\n## Execution Workers\nOwns process/provider observations, sessions, delivery state, and immutable artifacts. Unknown external outcomes remain quarantined.\n\n## Governance & Interface\nOwns trust roots and policy verification, approval evidence, AGG/evidence status, checkpoint custody contracts, and MCP/API/operator interfaces.\n\nCross-part calls use authenticated, versioned contracts with stable identity, exact subject binding, idempotency, and durable inbox/outbox. No part reads or writes another part's database. MCP is a gateway and cannot bypass service authorization.\n\nThe current workspace remains an in-process compatibility composition with shared persistence; it is not independently deployable.",
        ),
        "runalith://interface/operator-guide" => Some(
            "# Operator inspection guide\n\nUse `workflow_get`, `workflow_diagnose`, `workflow_attempt_inspect`, `workflow_events`, and `workflow_verify_event_chain` to inspect durable state. Treat these as bounded local projections.\n\nA missing lease does not prove worker death. An UNKNOWN task or ambiguous provider intent must not be retried or replayed. Reconcile exact provider identity and durable observations first.\n\nApproval requires externally authenticated evidence bound to the current candidate and immutable plan. The default host rejects approvals. Inspection tools do not grant authority or perform recovery mutations.",
        ),
        _ => None,
    }
}

fn prompt_definitions() -> Vec<Value> {
    vec![
        json!({
            "name":"inspect_workflow",
            "description":"Build a read-only inspection of workflow state, immutable plan, task attempts, and event history.",
            "arguments":[{"name":"workflow_id","description":"Exact workflow identifier","required":true}]
        }),
        json!({
            "name":"triage_unknown_attempt",
            "description":"Investigate an UNKNOWN task attempt without replaying or changing state.",
            "arguments":[
                {"name":"workflow_id","description":"Exact workflow identifier","required":true},
                {"name":"task_id","description":"Exact task identifier","required":true}
            ]
        }),
        json!({
            "name":"review_approval_readiness",
            "description":"Assess whether current approval evidence is bound to the exact candidate and immutable plan.",
            "arguments":[{"name":"workflow_id","description":"Exact workflow identifier","required":true}]
        }),
    ]
}

fn prompt_content(name: &str, arguments: &Value) -> Option<Value> {
    let allowed_arguments: &[&str] = match name {
        "inspect_workflow" | "review_approval_readiness" => &["workflow_id"],
        "triage_unknown_attempt" => &["workflow_id", "task_id"],
        _ => return None,
    };
    if arguments
        .as_object()?
        .keys()
        .any(|key| !allowed_arguments.contains(&key.as_str()))
    {
        return None;
    }
    let argument = |key: &str| -> Option<&str> {
        arguments
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty() && value.len() <= 200)
    };
    let workflow_id = argument("workflow_id")?;
    let text = match name {
        "inspect_workflow" => format!(
            "Inspect workflow `{workflow_id}` using read-only tools. Call workflow_get, workflow_diagnose, workflow_attempt_inspect for relevant attempts, workflow_events, and workflow_verify_event_chain. Report exact state, plan identity, blockers, and evidence gaps. Do not approve, claim, execute, reconcile, or mutate anything."
        ),
        "triage_unknown_attempt" => {
            let task_id = argument("task_id")?;
            format!(
                "Investigate UNKNOWN attempt for workflow `{workflow_id}`, task `{task_id}`. Use workflow_get, workflow_attempt_inspect, workflow_events, and workflow_verify_event_chain. Identify exact attempt, lease epoch, provider intent, observations, session binding, and unresolved evidence. Missing lease is not proof of worker death. Do not retry, replay, claim, or mutate state."
            )
        }
        "review_approval_readiness" => format!(
            "Assess approval readiness for workflow `{workflow_id}` using workflow_get, workflow_execution_graph_get, adaptive_goal_graph_search, and adaptive_goal_plan_project where applicable. Check exact proposal, candidate, source snapshot, plan digest, reviewer identity, policy version, and evidence freshness. Report fields the current read-only projections cannot establish. Do not call graph_create, graph_node_append, graph_edge_append, graph_evidence_capture, graph_snapshot_create, workflow_approve, or task-claim/execution tools."
        ),
        _ => return None,
    };
    Some(json!({
        "description":"Read-only Runalith operator workflow",
        "messages":[{"role":"user","content":{"type":"text","text":text}}]
    }))
}

/// Number of MCP tools registered by this Rust host build.
#[must_use]
pub fn registered_tool_count() -> usize {
    tool_definitions().len()
}

fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}

fn tool(
    name: &str,
    title: &str,
    description: &str,
    input_schema: Value,
    read_only: bool,
    idempotent: bool,
) -> Value {
    json!({
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": input_schema,
        "annotations": {
            "readOnlyHint": read_only,
            "destructiveHint": !read_only,
            "idempotentHint": idempotent,
            "openWorldHint": false
        }
    })
}

struct ResourceCandidate {
    id: String,
    primary: String,
    secondary: String,
    value: Value,
    resource_type: &'static str,
}

fn normalize_resource_text(value: &str) -> String {
    value
        .chars()
        .flat_map(char::to_lowercase)
        .map(|character| match character {
            'à' | 'á' | 'ạ' | 'ả' | 'ã' | 'â' | 'ầ' | 'ấ' | 'ậ' | 'ẩ' | 'ẫ' | 'ă' | 'ằ' | 'ắ'
            | 'ặ' | 'ẳ' | 'ẵ' => 'a',
            'è' | 'é' | 'ẹ' | 'ẻ' | 'ẽ' | 'ê' | 'ề' | 'ế' | 'ệ' | 'ể' | 'ễ' => {
                'e'
            }
            'ì' | 'í' | 'ị' | 'ỉ' | 'ĩ' => 'i',
            'ò' | 'ó' | 'ọ' | 'ỏ' | 'õ' | 'ô' | 'ồ' | 'ố' | 'ộ' | 'ổ' | 'ỗ' | 'ơ' | 'ờ' | 'ớ'
            | 'ợ' | 'ở' | 'ỡ' => 'o',
            'ù' | 'ú' | 'ụ' | 'ủ' | 'ũ' | 'ư' | 'ừ' | 'ứ' | 'ự' | 'ử' | 'ữ' => {
                'u'
            }
            'ỳ' | 'ý' | 'ỵ' | 'ỷ' | 'ỹ' => 'y',
            'đ' => 'd',
            other => other,
        })
        .collect()
}

fn resource_tokens_ordered(value: &str) -> Vec<String> {
    const STOP_WORDS: &[&str] = &[
        "about",
        "after",
        "all",
        "also",
        "and",
        "any",
        "are",
        "as",
        "at",
        "be",
        "been",
        "before",
        "being",
        "between",
        "both",
        "but",
        "by",
        "can",
        "could",
        "did",
        "do",
        "does",
        "doing",
        "down",
        "during",
        "each",
        "for",
        "from",
        "further",
        "had",
        "has",
        "have",
        "having",
        "he",
        "her",
        "here",
        "him",
        "his",
        "how",
        "i",
        "if",
        "in",
        "into",
        "is",
        "it",
        "its",
        "just",
        "me",
        "more",
        "most",
        "my",
        "no",
        "nor",
        "not",
        "of",
        "off",
        "on",
        "once",
        "only",
        "or",
        "other",
        "our",
        "out",
        "over",
        "own",
        "same",
        "she",
        "should",
        "so",
        "some",
        "such",
        "than",
        "that",
        "the",
        "their",
        "them",
        "then",
        "there",
        "these",
        "they",
        "this",
        "those",
        "through",
        "to",
        "too",
        "under",
        "until",
        "up",
        "very",
        "was",
        "we",
        "were",
        "what",
        "when",
        "where",
        "which",
        "while",
        "who",
        "why",
        "will",
        "with",
        "would",
        "you",
        "your",
        "cua",
        "bao",
        "cach",
        "cac",
        "cho",
        "chinh",
        "chung",
        "cung",
        "da",
        "dang",
        "de",
        "den",
        "dieu",
        "duoc",
        "gi",
        "gio",
        "hay",
        "ho",
        "hoac",
        "khi",
        "khong",
        "la",
        "lam",
        "len",
        "lieu",
        "moi",
        "mot",
        "nay",
        "neu",
        "nhieu",
        "nhung",
        "nhu",
        "noi",
        "qua",
        "rat",
        "sau",
        "se",
        "theo",
        "thi",
        "trong",
        "tu",
        "tren",
        "toi",
        "va",
        "vao",
        "voi",
        "vi",
        "ve",
        "xu",
        "ly",
        "yeu",
        "cau",
        "viec",
        "o",
        "ong",
        "tuyen",
        "am",
        "an",
        "hers",
        "herself",
        "himself",
        "itself",
        "ours",
        "ourselves",
        "theirs",
        "themselves",
        "whom",
        "yours",
        "yourself",
        "yourselves",
    ];
    let normalized = normalize_resource_text(value);
    let mut token = String::new();
    let mut output = Vec::new();
    let mut seen = BTreeSet::new();
    let mut push = |token: &mut String| {
        if !token.is_empty()
            && (token.chars().count() >= 3
                || matches!(token.as_str(), "ai" | "qa" | "ux" | "ui" | "db" | "api"))
            && !STOP_WORDS.contains(&token.as_str())
        {
            let value = std::mem::take(token);
            if seen.insert(value.clone()) {
                output.push(value);
            }
        } else {
            token.clear();
        }
    };
    for character in normalized.chars() {
        if character.is_alphanumeric() {
            token.push(character);
        } else {
            push(&mut token);
        }
    }
    push(&mut token);
    output
}

fn resource_tokens(value: &str) -> BTreeSet<String> {
    resource_tokens_ordered(value).into_iter().collect()
}

fn expand_resource_query(task: &str) -> (Vec<String>, Vec<String>) {
    const SYNONYMS: &[&[&str]] = &[
        &[
            "security",
            "bảo mật",
            "bao mat",
            "an toàn",
            "an toan",
            "vulnerability",
            "threat",
            "audit",
        ],
        &[
            "test",
            "testing",
            "kiểm thử",
            "kiem thu",
            "qa",
            "verify",
            "verification",
            "regression",
        ],
        &[
            "documentation",
            "docs",
            "tài liệu",
            "tai lieu",
            "viết tài liệu",
            "viet tai lieu",
            "writer",
        ],
        &[
            "research",
            "nghiên cứu",
            "nghien cuu",
            "investigate",
            "investigation",
            "source",
        ],
        &[
            "architecture",
            "kiến trúc",
            "kien truc",
            "design",
            "interfaces",
            "tradeoffs",
        ],
        &[
            "implementation",
            "implement",
            "triển khai",
            "trien khai",
            "code",
            "coding",
            "bug",
            "fix",
            "engineer",
        ],
        &[
            "policy",
            "chính sách",
            "chinh sach",
            "quy định",
            "quy dinh",
            "guardrail",
            "constraint",
        ],
        &[
            "recovery",
            "phục hồi",
            "phuc hoi",
            "rollback",
            "retry",
            "repair",
        ],
        &["workflow", "quy trình", "quy trinh", "pipeline", "process"],
        &["skill", "kỹ năng", "ky nang", "instructions", "playbook"],
        &["role", "vai trò", "vai tro", "specialist", "persona"],
    ];
    let normalized = normalize_resource_text(task);
    let original = resource_tokens_ordered(task);
    let mut expanded = original.clone();
    for group in SYNONYMS {
        let matches = group.iter().any(|alias| {
            let alias = normalize_resource_text(alias);
            if alias.contains(' ') {
                normalized.contains(&alias)
            } else {
                expanded.contains(&alias)
            }
        });
        if matches {
            for alias in *group {
                for token in resource_tokens_ordered(alias) {
                    if !expanded.contains(&token) {
                        expanded.push(token);
                    }
                }
            }
        }
    }
    (original, expanded)
}

fn score_resource_candidate(
    original: &[String],
    expanded: &[String],
    candidate: &ResourceCandidate,
) -> Option<(f64, Vec<String>, String)> {
    if original.is_empty() {
        return None;
    }
    let primary = resource_tokens(&format!("{} {}", candidate.primary, candidate.id));
    let mut all = primary.clone();
    all.extend(resource_tokens(&candidate.secondary));
    let matched_original = original
        .iter()
        .filter(|token| all.contains(*token))
        .cloned()
        .collect::<Vec<_>>();
    let matched_expanded = expanded
        .iter()
        .filter(|token| all.contains(*token))
        .cloned()
        .collect::<Vec<_>>();
    if matched_expanded.is_empty() {
        return None;
    }
    let coverage = (matched_expanded.len() as f64 / original.len().clamp(1, 6) as f64).min(1.0);
    let primary_coverage = (primary
        .iter()
        .filter(|token| expanded.contains(token))
        .count() as f64
        / primary.len().clamp(1, 5) as f64)
        .min(1.0);
    let score = ((coverage * 0.78 + primary_coverage * 0.22) * 1000.0).round() / 1000.0;
    let confidence = if score >= 0.5 {
        "high"
    } else if score >= 0.27 {
        "medium"
    } else {
        "low"
    };
    let mut matched = matched_original;
    for token in matched_expanded {
        if !matched.contains(&token) {
            matched.push(token);
        }
    }
    matched.truncate(8);
    Some((score, matched, confidence.into()))
}

fn rank_resource_candidates(
    original: &[String],
    expanded: &[String],
    candidates: Vec<ResourceCandidate>,
    limit: usize,
) -> Vec<Value> {
    let mut ranked = candidates
        .into_iter()
        .filter_map(|candidate| {
            let (score, matched_terms, confidence) =
                score_resource_candidate(original, expanded, &candidate)?;
            if score < 0.14 {
                return None;
            }
            let mut value = candidate.value.as_object()?.clone();
            value.insert("score".into(), json!(score));
            value.insert("confidence".into(), json!(confidence));
            value.insert("matched_terms".into(), json!(matched_terms));
            value.insert("resource_type".into(), json!(candidate.resource_type));
            Some((score, candidate.id, Value::Object(value)))
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        right
            .0
            .total_cmp(&left.0)
            .then_with(|| left.1.cmp(&right.1))
    });
    ranked
        .into_iter()
        .take(limit)
        .map(|(_, _, value)| value)
        .collect()
}

fn recommend_resources(
    task: &str,
    limit: usize,
    roles: Vec<Value>,
    workflows: Vec<Value>,
    policies: Vec<Value>,
) -> Value {
    let (original, expanded) = expand_resource_query(task.trim());
    let custom_roles = roles
        .into_iter()
        .filter_map(|definition| {
            let id = definition.get("role_id")?.as_str()?.to_owned();
            let name = definition
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let description = definition
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let capabilities = definition
                .get("allowed_capabilities")
                .cloned()
                .unwrap_or_else(|| json!([]));
            let inputs = definition
                .get("input_contract")
                .cloned()
                .unwrap_or_else(|| json!([]));
            let output = definition
                .get("output_artifact_type")
                .cloned()
                .unwrap_or(Value::Null);
            let skills = definition
                .get("skills")
                .cloned()
                .unwrap_or_else(|| json!([]));
            let input_types = inputs
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect::<BTreeSet<_>>();
            let output_type = output.as_str();
            let has_system_prompt = definition
                .get("system_prompt")
                .and_then(Value::as_str)
                .is_some_and(|prompt| !prompt.trim().is_empty());
            let compatible_profile_overlay_roles = runalith_domain::workflow::builtin_roles()
                .into_iter()
                .filter(|builtin| builtin.role_id != "cto")
                .filter_map(|builtin| {
                    let builtin_output = serde_json::to_value(builtin.output).ok()?;
                    let builtin_inputs = serde_json::to_value(builtin.inputs).ok()?;
                    let required_inputs = builtin_inputs
                        .as_array()?
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<BTreeSet<_>>();
                    (has_system_prompt
                        && output_type == builtin_output.as_str()
                        && required_inputs.is_subset(&input_types))
                    .then_some(builtin.role_id)
                })
                .collect::<Vec<_>>();
            let secondary = format!("{description} {capabilities} {inputs} {output} {skills}");
            Some(ResourceCandidate {
                id: id.clone(),
                primary: format!("{name} {id}"),
                secondary,
                value: json!({
                    "role_id":id,
                    "version":definition.get("version").cloned().unwrap_or(Value::Null),
                    "name":name,
                    "description":description,
                    "input_contract":inputs,
                    "output_artifact_type":output,
                    "allowed_capabilities":capabilities,
                    "skill_ids":skills,
                    "skill_hints":[],
                    "skill_metadata_available":false,
                    "compatible_profile_overlay_roles":compatible_profile_overlay_roles,
                    "profile_overlay_runtime_supported":false,
                    "reusable_as":"custom workflow role; or immutable profile overlay on a compatible built-in role",
                    "execution_authorized":false
                }),
                resource_type: "custom_role",
            })
        })
        .collect();

    let custom_workflows = workflows
        .into_iter()
        .filter_map(|definition| {
            let id = definition.get("workflow_id")?.as_str()?.to_owned();
            let name = definition.get("name").and_then(Value::as_str).unwrap_or_default();
            let description = definition.get("description").and_then(Value::as_str).unwrap_or_default();
            let inputs = definition.get("input_contract").cloned().unwrap_or_else(|| json!([]));
            let tasks = definition.get("tasks").and_then(Value::as_array).cloned().unwrap_or_default();
            let secondary = format!("{description} {inputs} {}", tasks.iter().map(|task| {
                format!("{} {} {} {}",
                    task.get("id").and_then(Value::as_str).unwrap_or_default(),
                    task.get("role_id").and_then(Value::as_str).unwrap_or_default(),
                    task.get("output_artifact_type").unwrap_or(&Value::Null),
                    task.get("input_contract").unwrap_or(&Value::Null))
            }).collect::<Vec<_>>().join(" "));
            let task_summaries = tasks.iter().map(|task| json!({
                "task_id":task.get("id"),
                "role_id":task.get("role_id"),
                "role_version":task.get("role_version"),
                "output_artifact_type":task.get("output_artifact_type")
            })).collect::<Vec<_>>();
            Some(ResourceCandidate {
                id: id.clone(),
                primary: format!("{name} {id}"),
                secondary,
                value: json!({
                    "workflow_id":id,
                    "version":definition.get("version"),
                    "name":name,
                    "description":description,
                    "input_contract":inputs,
                    "tasks":task_summaries,
                    "reuse_note":"Review the exact version and preview its pinned contract before use; preview/run approvals remain separate."
                }),
                resource_type: "custom_workflow",
            })
        })
        .collect();

    let workflow_policies = policies
        .into_iter()
        .filter_map(|record| {
            let definition = record.get("definition")?;
            let id = definition.get("policy_id")?.as_str()?.to_owned();
            let name = definition.get("name").and_then(Value::as_str).unwrap_or_default();
            let description = definition.get("description").and_then(Value::as_str).unwrap_or_default();
            let mut rules = definition.get("constraints").and_then(Value::as_array).cloned().unwrap_or_default();
            rules.extend(definition.get("success_criteria").and_then(Value::as_array).cloned().unwrap_or_default());
            let rule_types = rules.iter().filter_map(|rule| rule.get("type").and_then(Value::as_str).map(str::to_owned)).collect::<BTreeSet<_>>();
            let secondary = format!("{description} {}", rules.iter().map(|rule| format!("{} {} {} {} {} {} {}",
                rule.get("type").and_then(Value::as_str).unwrap_or_default(),
                rule.get("id").and_then(Value::as_str).unwrap_or_default(),
                rule.get("role").and_then(Value::as_str).unwrap_or_default(),
                rule.get("task_id").and_then(Value::as_str).unwrap_or_default(),
                rule.get("artifact_type").and_then(Value::as_str).unwrap_or_default(),
                rule.get("field").and_then(Value::as_str).unwrap_or_default(),
                rule.get("expected").map(Value::to_string).unwrap_or_default()
            )).collect::<Vec<_>>().join(" "));
            let context_bound = rules.iter().any(|rule| matches!(rule.get("type").and_then(Value::as_str),
                Some("workflow_id_equals" | "task_status_equals" | "execution_exit_code_equals" | "task_role_present" | "task_role_absent")));
            let artifact_bound = rules.iter().any(|rule| {
                rule.get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| kind.starts_with("artifact_field_"))
                    || rule
                        .get("producer_role")
                        .and_then(Value::as_str)
                        .is_some_and(|role| !role.is_empty())
            });
            let (reuse_scope, reuse_note) = if context_bound {
                ("context_bound", "Contains workflow-, task-, or role-specific predicates; inspect and validate against the target plan before attaching.")
            } else if artifact_bound {
                ("compatible_subject_to_plan_validation", "Contains artifact field or producer assumptions; reuse only when artifact schema and producer evidence match.")
            } else {
                ("portable_candidate", "Uses workflow-wide predicates, but still run target-plan compatibility validation before attaching.")
            };
            Some(ResourceCandidate {
                id: id.clone(),
                primary: format!("{name} {id}"),
                secondary,
                value: json!({
                    "policy_id":id,
                    "version":record.get("version"),
                    "name":name,
                    "description":description,
                    "content_hash":record.get("content_sha256"),
                    "rule_types":rule_types,
                    "reuse_scope":reuse_scope,
                    "reuse_note":reuse_note,
                    "auto_attach_candidate":reuse_scope == "portable_candidate",
                    "attachment_requires_target_plan_validation":true
                }),
                resource_type: "workflow_policy",
            })
        })
        .collect();

    let built_in_role_hints = runalith_domain::workflow::builtin_roles()
        .into_iter()
        .filter(|role| role.role_id != "cto")
        .map(|role| {
            let cues = match role.role_id.as_str() {
                "product-owner" => "requirements scope acceptance criteria product need non goals",
                "researcher" => "research investigation sources evidence explore understand discover",
                "architect" => "architecture design interfaces modules tradeoffs failure modes",
                "engineer" => "implementation code change implement fix bug refactor build",
                "security" => "security audit vulnerability threat authentication authorization trust boundary",
                "qa" => "test testing verification regression acceptance checks validation",
                "platform" => "platform runtime packaging deployment operations recovery rollback",
                "writer" => "documentation docs guide reference examples user instructions",
                "reviewer" => "review diff independent findings correctness evidence scope",
                _ => "",
            };
            let capability = serde_json::to_value(role.capability).unwrap_or(Value::Null);
            let inputs = serde_json::to_value(role.inputs).unwrap_or(Value::Null);
            let output = serde_json::to_value(role.output).unwrap_or(Value::Null);
            ResourceCandidate {
                id: role.role_id.clone(),
                primary: format!("{} {}", role.role_id, capability),
                secondary: format!("{cues} {inputs} {output}"),
                value: json!({
                    "role":role.role_id,
                    "capability":capability,
                    "inputs":inputs,
                    "outputs":output,
                    "guidance":cues
                }),
                resource_type: "built_in_role_hint",
            }
        })
        .collect();

    let mut fingerprint = original.to_vec();
    fingerprint.sort();
    json!({
        "read_only":true,
        "task_fingerprint":fingerprint.join(" ").chars().take(240).collect::<String>(),
        "matching_method":"deterministic lexical overlap with Vietnamese-English phrase expansion; not semantic model inference",
        "recommendations":{
            "custom_workflows":rank_resource_candidates(&original,&expanded,custom_workflows,limit),
            "custom_roles_and_skills":rank_resource_candidates(&original,&expanded,custom_roles,limit),
            "workflow_policies":rank_resource_candidates(&original,&expanded,workflow_policies,limit),
            "built_in_role_hints":rank_resource_candidates(&original,&expanded,built_in_role_hints,limit.min(5))
        },
        "limitations":[
            "Rust catalog stores skill identifiers but does not expose Node skill name/description/hash metadata in this API.",
            "Compatible overlay roles are contract-only candidates; the Rust proposal API does not yet support applying Node role-profile bindings.",
            "Lexical recommendations are discovery hints, not semantic compatibility proof or execution authority."
        ],
        "selection_rules":[
            "Prefer a high-confidence, contract-compatible existing resource over creating a near-duplicate.",
            "Treat low-confidence matches as discovery hints only; do not force-fit them.",
            "Use custom roles in custom workflows, or as immutable profile overlays only when input/output contract compatibility is confirmed.",
            "A policy recommendation is not an attachment. Validate against the target plan and attach an exact immutable version before approval.",
            "Skills are supplemental instructions and do not grant tools, permissions, or filesystem access.",
            "No recommendation creates, attaches, approves, dispatches, edits files, or grants execution authorization."
        ]
    })
}

/// Serve the production MCP stdio transport over an authenticated Gateway.
///
/// Direct `McpServer::handle_frame` use remains available for in-process
/// compatibility tests/hosts, but the stdio transport refuses to start unless
/// the caller composes an authenticated transport context and Gateway.
pub fn serve_stdio<R, W>(mut reader: R, mut writer: W, server: &McpServer) -> Result<(), McpError>
where
    R: std::io::BufRead,
    W: std::io::Write,
{
    if server.local_gateway_identity.is_none() {
        return Err(McpError::Runtime(
            "MCP stdio requires an authenticated Gateway context; direct Runtime/Store dispatch is disabled"
                .into(),
        ));
    }
    loop {
        let Some(frame) = read_bounded_frame(&mut reader)
            .map_err(|error| McpError::Runtime(error.to_string()))?
        else {
            return Ok(());
        };
        let response = match server.handle_frame(&frame) {
            Ok(response) => response,
            Err(error) => Some(serde_json::to_vec(&json!({
                "jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":error.to_string()}
            }))?),
        };
        if let Some(response) = response {
            writer
                .write_all(&response)
                .map_err(|error| McpError::Runtime(error.to_string()))?;
            writer
                .write_all(b"\n")
                .map_err(|error| McpError::Runtime(error.to_string()))?;
            writer
                .flush()
                .map_err(|error| McpError::Runtime(error.to_string()))?;
        }
    }
}

fn read_bounded_frame<R: std::io::BufRead>(reader: &mut R) -> std::io::Result<Option<Vec<u8>>> {
    let mut frame = Vec::with_capacity(1024);
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if frame.is_empty() {
                return Ok(None);
            }
            if frame.len() > MAX_MCP_FRAME_BYTES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "MCP frame exceeds configured byte limit",
                ));
            }
            return Ok(Some(frame));
        }
        let count = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        // Permit the LF delimiter and an optional preceding CR outside the
        // JSON payload limit; the bounded payload check follows line stripping.
        if frame.len().saturating_add(count) > MAX_MCP_FRAME_BYTES + 2 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "MCP frame exceeds configured byte limit",
            ));
        }
        let has_newline = available[count - 1] == b'\n';
        frame.extend_from_slice(&available[..count]);
        reader.consume(count);
        if has_newline {
            if frame.last() == Some(&b'\n') {
                frame.pop();
            }
            if frame.last() == Some(&b'\r') {
                frame.pop();
            }
            if frame.len() > MAX_MCP_FRAME_BYTES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "MCP frame exceeds configured byte limit",
                ));
            }
            return Ok(Some(frame));
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Arc;

    use runalith_artifacts::ArtifactStore;
    use runalith_domain::{TaskSpec, WorkflowPlan, WorkflowProposal, content_hash};
    use runalith_providers::{
        ProviderAdapterError, ProviderDispatchRequest, ProviderDispatchResponse,
        ProviderLookupResponse,
    };
    use runalith_runtime::{
        ApprovalVerificationMode, ApprovalVerifier, StoreError, Transaction, VerifiedApproval,
    };
    use runalith_sandbox::{CommandRequest, CommandResult, SandboxError, SandboxExecutor};

    use super::*;

    struct TestVerifier;

    struct LookupProvider {
        dispatches: std::sync::atomic::AtomicUsize,
        lookups: std::sync::atomic::AtomicUsize,
    }

    impl ProviderAdapter for LookupProvider {
        fn provider_id(&self) -> &'static str {
            "mcp-test-provider"
        }

        fn dispatch(
            &self,
            _request: &ProviderDispatchRequest,
        ) -> Result<ProviderDispatchResponse, ProviderAdapterError> {
            self.dispatches
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(ProviderDispatchResponse::Accepted {
                provider_run_id: "mcp-run-42".into(),
            })
        }

        fn lookup(
            &self,
            _intent: &runalith_runtime::ProviderIntentRecord,
        ) -> Result<ProviderLookupResponse, ProviderAdapterError> {
            self.lookups
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(ProviderLookupResponse::Found {
                outcome: ProviderDispatchResponse::Accepted {
                    provider_run_id: "mcp-run-42".into(),
                },
                provider_status: Some("queued".into()),
                conclusion: None,
                run_url: Some("https://github.example/runs/42".into()),
            })
        }
    }

    struct TestSandbox;

    impl SandboxExecutor for TestSandbox {
        fn execute(&self, _request: CommandRequest) -> Result<CommandResult, SandboxError> {
            Ok(CommandResult {
                exit_code: Some(0),
                timed_out: false,
                stdout: "mcp sandbox output".into(),
                stderr: String::new(),
                stdout_bytes: b"mcp sandbox output".to_vec(),
                stderr_bytes: vec![],
                stdout_sha256: "a".repeat(64),
                stderr_sha256: "b".repeat(64),
                stdout_truncated: false,
                stderr_truncated: false,
                sandbox_backend: "test-bubblewrap".into(),
            })
        }
    }

    impl ApprovalVerifier for TestVerifier {
        fn verify(
            &self,
            _transaction: &Transaction<'_>,
            _proposal: &WorkflowProposal,
            _plan: &runalith_domain::WorkflowPlan,
            request: &ApprovalRequest,
            _mode: ApprovalVerificationMode,
        ) -> Result<VerifiedApproval, StoreError> {
            Ok(VerifiedApproval {
                actor: request.actor.clone(),
                evidence: request.evidence.clone(),
            })
        }
    }

    fn server() -> McpServer {
        let store = Arc::new(Store::in_memory().unwrap());
        let service = WorkflowService::new(store.clone(), Arc::new(TestVerifier));
        McpServer::with_service_and_store(Arc::new(service), store)
    }

    fn server_with_local_gateway() -> McpServer {
        let transport = AuthenticatedMcpTransportContext::from_authenticated_peer(
            "stdio:test-server:test-parent",
            "pid:4242:uid:1000",
        )
        .unwrap();
        let principal = McpPrincipalV1 {
            subject: transport.peer_identity().to_owned(),
            issuer: "linux-stdio-parent-process".into(),
            audience: "runalith-local".into(),
            authentication_context: transport.connection_id().to_owned(),
        };
        server().with_local_read_only_gateway(transport, principal)
    }

    #[test]
    fn stdio_gateway_lists_only_read_routes_and_dispatches_reads_through_gateway() {
        let server = server_with_local_gateway();
        let listed: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(1, "tools/list", modern_meta()))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let tools = listed["result"]["tools"].as_array().unwrap();
        assert!(!tools.is_empty());
        assert!(
            tools
                .iter()
                .all(|tool| tool["annotations"]["readOnlyHint"] == true)
        );
        assert!(tools.iter().all(|tool| tool["name"] != "workflow_create"));
        assert!(
            tools
                .iter()
                .all(|tool| tool["name"] != "workflow_recovery_quarantine_expired")
        );
        assert!(
            tools
                .iter()
                .all(|tool| tool["name"] != "workflow_provider_reconcile")
        );

        let mut call = modern_meta();
        call["name"] = json!("workflow_list");
        call["arguments"] = json!({"limit":10});
        let response: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(2, "tools/call", call))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(response["result"]["isError"], false, "{response}");
        assert_eq!(response["result"]["structuredContent"], json!([]));

        let resource: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(
                    3,
                    "resources/read",
                    json!({
                        "_meta":modern_meta()["_meta"],
                        "uri":"runalith://governance/authority"
                    }),
                ))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert!(
            resource["result"]["contents"][0]["text"]
                .as_str()
                .unwrap()
                .contains("Approval defaults to deny-all")
        );

        let prompt: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(
                    4,
                    "prompts/get",
                    json!({
                        "_meta":modern_meta()["_meta"],
                        "name":"inspect_workflow",
                        "arguments":{"workflow_id":"job_prompt_read"}
                    }),
                ))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert!(
            prompt["result"]["messages"][0]["content"]["text"]
                .as_str()
                .unwrap()
                .contains("job_prompt_read")
        );
    }

    #[test]
    fn stdio_gateway_never_bypasses_authorization_for_mutation_without_durable_idempotency() {
        let server = server_with_local_gateway();
        let workflow_id = "job_gateway_mutation_blocked";
        let mut call = modern_meta();
        call["name"] = json!("workflow_create");
        call["arguments"] = json!({
            "workflow_id":workflow_id,
            "title":"Must be blocked by Gateway",
            "goal":"No generic durable MCP idempotency is provisioned",
            "tasks":[{"task_id":"task_1","role":"engineer","description":"Build"}]
        });
        let response: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(8, "tools/call", call))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(response["error"]["code"], -32004, "{response}");
        assert_eq!(
            response["error"]["data"]["code"],
            "MUTATION_IDEMPOTENCY_UNAVAILABLE"
        );
        assert_eq!(response["error"]["data"]["handler_invoked"], false);
        let workflows = server
            .call_tool("workflow_list", &json!({"limit":10}))
            .unwrap();
        assert!(
            workflows
                .as_array()
                .unwrap()
                .iter()
                .all(|workflow| { workflow["workflow_id"] != workflow_id })
        );

        for (request_id, name, arguments) in [
            (
                10,
                "workflow_provider_reconcile",
                json!({"intent_id":"intent-missing"}),
            ),
            (
                11,
                "workflow_recovery_quarantine_expired",
                json!({"workflow_id":"job_missing"}),
            ),
        ] {
            let mut hidden_route = modern_meta();
            hidden_route["name"] = json!(name);
            hidden_route["arguments"] = arguments;
            let denied: Value = serde_json::from_slice(
                &server
                    .handle_frame(&rpc(request_id, "tools/call", hidden_route))
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(denied["error"]["code"], -32004, "{denied}");
            assert_eq!(
                denied["error"]["data"]["code"],
                "MUTATION_IDEMPOTENCY_UNAVAILABLE"
            );
        }
    }

    #[test]
    fn stdio_gateway_rejects_host_principal_not_bound_to_authenticated_os_peer() {
        let transport = AuthenticatedMcpTransportContext::from_authenticated_peer(
            "stdio:test-server:test-parent",
            "pid:4242:uid:1000",
        )
        .unwrap();
        let principal = McpPrincipalV1 {
            subject: "pid:9999:uid:1000".into(),
            issuer: "linux-stdio-parent-process".into(),
            audience: "runalith-local".into(),
            authentication_context: transport.connection_id().to_owned(),
        };
        let server = server().with_local_read_only_gateway(transport, principal);
        let response: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(9, "tools/list", modern_meta()))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(response["error"]["code"], -32001, "{response}");
        assert_eq!(
            response["error"]["data"]["code"],
            "MCP_GATEWAY_AUTHORIZATION_DENIED"
        );
    }

    #[test]
    fn rust_mcp_schema_validator_enforces_nested_types_patterns_and_closed_objects() {
        let schema = json!({
            "type":"object",
            "required":["workflow_id","tasks"],
            "additionalProperties":false,
            "properties":{
                "workflow_id":{"type":"string","pattern":"^job_[A-Za-z0-9_-]+$","minLength":5},
                "tasks":{"type":"array","minItems":1,"maxItems":2,"items":{
                    "type":"object","additionalProperties":false,
                    "required":["attempt"],
                    "properties":{"attempt":{"type":"integer","minimum":1,"maximum":3}}
                }}
            }
        });
        let valid = json!({"workflow_id":"job_valid-1","tasks":[{"attempt":2}]});
        let mut errors = Vec::new();
        validate_schema_value(&valid, &schema, "input", &mut errors);
        assert!(errors.is_empty(), "{errors:?}");

        let invalid = json!({
            "workflow_id":"bad id",
            "tasks":[{"attempt":4,"unknown":true}],
            "extra":true
        });
        let mut errors = Vec::new();
        validate_schema_value(&invalid, &schema, "input", &mut errors);
        assert!(
            errors
                .iter()
                .any(|error| error.contains("required pattern"))
        );
        assert!(errors.iter().any(|error| error.contains("exceeds 3")));
        assert!(
            errors
                .iter()
                .any(|error| error.contains("unknown is not allowed"))
        );
        assert!(
            errors
                .iter()
                .any(|error| error.contains("extra is not allowed"))
        );
    }

    #[test]
    fn workflow_recommend_resources_ranks_real_catalog_entries_without_mutation_or_authority() {
        let server = server();
        let role: runalith_domain::custom_workflow::CustomRoleDefinition =
            serde_json::from_value(json!({
                "role_id":"security-reviewer",
                "version":1,
                "name":"Security Threat Reviewer",
                "description":"Review application security, authentication, authorization, vulnerabilities and trust boundaries.",
                "system_prompt":"Perform an evidence-based security review. Do not execute or mutate files.",
                "input_contract":["job.request","requirements","architecture","implementation"],
                "output_artifact_type":"security-review",
                "allowed_capabilities":["security.audit"],
                "permissions":["workspace.read","artifact.create"],
                "allowed_tools":[],
                "skills":[]
            }))
            .unwrap();
        server
            .service
            .create_custom_role(role, "host:operator")
            .unwrap();
        let workflow: runalith_domain::workflow::CustomWorkflowDefinition =
            serde_json::from_value(json!({
                "workflow_id":"security-review-flow",
                "version":1,
                "name":"Security Review Flow",
                "description":"Review code for vulnerabilities, authentication and authorization boundaries, and write a security report.",
                "input_contract":["job.request"],
                "tasks":[{
                    "id":"security-review",
                    "role_id":"security-reviewer",
                    "role_version":1,
                    "input_contract":["job.request"],
                    "output_artifact_type":"security-review",
                    "depends_on":[]
                }]
            }))
            .unwrap();
        server
            .service
            .create_custom_workflow(workflow, "host:operator")
            .unwrap();
        server
            .service
            .create_workflow_policy(
                WorkflowPolicyDefinition {
                    schema_version: 1,
                    policy_id: "security-review-gates".into(),
                    name: "Security Review Gates".into(),
                    description: "Require all planned tasks to complete successfully and use approved local execution contracts.".into(),
                    constraints: vec![
                        json!({"id":"completed-work","type":"all_tasks_completed"}),
                        json!({"id":"local-only","type":"local_execution_only"}),
                    ],
                    success_criteria: vec![],
                },
                "host:operator",
            )
            .unwrap();

        let roles_before = server.service.list_custom_roles(true, 20).unwrap().len();
        let workflows_before = server
            .service
            .list_custom_workflows(true, 20)
            .unwrap()
            .len();
        let policies_before = server
            .service
            .list_workflow_policies(true, 20, None)
            .unwrap()
            .len();
        let result = server
            .call_tool(
                "workflow_recommend_resources",
                &json!({"task":"Rà soát bảo mật ứng dụng, tìm lỗ hổng và kiểm tra quyền truy cập.","limit":5}),
            )
            .unwrap();

        assert_eq!(result["read_only"], true);
        assert_eq!(
            result["matching_method"],
            "deterministic lexical overlap with Vietnamese-English phrase expansion; not semantic model inference"
        );
        assert!(
            result["recommendations"]["custom_roles_and_skills"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["role_id"] == "security-reviewer")
        );
        assert!(
            result["recommendations"]["custom_workflows"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["workflow_id"] == "security-review-flow")
        );
        assert!(
            result["recommendations"]["workflow_policies"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["policy_id"] == "security-review-gates")
        );
        let recommended_policy = result["recommendations"]["workflow_policies"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["policy_id"] == "security-review-gates")
            .unwrap();
        assert_eq!(recommended_policy["reuse_scope"], "portable_candidate");
        assert!(
            result["recommendations"]["built_in_role_hints"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["role"] == "security")
        );
        assert_eq!(
            result["recommendations"]["built_in_role_hints"][0]["role"],
            "security"
        );
        let recommended_role = result["recommendations"]["custom_roles_and_skills"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["role_id"] == "security-reviewer")
            .unwrap();
        assert_eq!(recommended_role["execution_authorized"], false);
        assert_eq!(recommended_role["skill_metadata_available"], false);
        assert_eq!(
            recommended_role["compatible_profile_overlay_roles"],
            json!(["security"])
        );
        assert_eq!(recommended_role["profile_overlay_runtime_supported"], false);
        assert!(result["limitations"].as_array().unwrap().len() >= 3);
        assert_eq!(
            server.service.list_custom_roles(true, 20).unwrap().len(),
            roles_before
        );
        assert_eq!(
            server
                .service
                .list_custom_workflows(true, 20)
                .unwrap()
                .len(),
            workflows_before
        );
        assert_eq!(
            server
                .service
                .list_workflow_policies(true, 20, None)
                .unwrap()
                .len(),
            policies_before
        );
    }

    #[test]
    fn workflow_recommend_resources_rejects_invalid_limits_and_unknown_arguments() {
        let server = server();
        let invalid_limit = server
            .call_tool(
                "workflow_recommend_resources",
                &json!({"task":"security review","limit":11}),
            )
            .unwrap_err()
            .to_string();
        assert!(invalid_limit.contains("exceeds 10"));

        let unknown = server
            .call_tool(
                "workflow_recommend_resources",
                &json!({"task":"security review","unexpected":true}),
            )
            .unwrap_err()
            .to_string();
        assert!(unknown.contains("unexpected is not allowed"));

        let empty = server
            .call_tool("workflow_recommend_resources", &json!({"task":"  "}))
            .unwrap_err()
            .to_string();
        assert!(empty.contains("task"), "{empty}");
    }

    #[test]
    fn workflow_recommend_resources_is_reachable_through_stdio_dispatch() {
        let server = server();
        let mut params = modern_meta();
        params["name"] = json!("workflow_recommend_resources");
        params["arguments"] = json!({"task":"security review","limit":5});

        let response: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(73, "tools/call", params))
                .unwrap()
                .unwrap(),
        )
        .unwrap();

        assert!(response.get("error").is_none(), "{response}");
        assert_eq!(response["result"]["isError"], false);
    }

    #[test]
    fn every_listed_tool_has_a_stdio_dispatch_route() {
        let server = server();
        let mut params = modern_meta();
        params["arguments"] = json!({"__invalid_probe__":true});
        let mut dispatch_failures = Vec::new();
        let listing: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(74, "tools/list", modern_meta()))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let listed_tools = listing["result"]["tools"]
            .as_array()
            .expect("tools/list must return an array");

        for definition in listed_tools {
            let name = definition["name"].as_str().expect("tool name");
            params["name"] = json!(name);
            let response: Value = serde_json::from_slice(
                &server
                    .handle_frame(&rpc(75, "tools/call", params.clone()))
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();

            if response.get("error").is_some() || response["result"]["isError"] != true {
                dispatch_failures.push(format!("{name}: {response}"));
            }
        }

        assert!(
            dispatch_failures.is_empty(),
            "listed tools must route through schema validation without side effects: {}",
            dispatch_failures.join("; ")
        );
    }

    #[test]
    fn unregistered_stdio_tool_name_is_rejected_before_tool_execution() {
        let server = server();
        let mut params = modern_meta();
        params["name"] = json!("not_a_registered_tool");
        params["arguments"] = json!({});

        let response: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(75, "tools/call", params))
                .unwrap()
                .unwrap(),
        )
        .unwrap();

        assert_eq!(response["error"]["code"], -32602);
        assert_eq!(response["error"]["message"], "unknown tool name");
    }

    #[test]
    fn mcp_tool_call_validates_declared_schema_before_authorization_or_mutation() {
        let server = server();
        let invalid_pattern = server
            .call_tool(
                "custom_role_clone",
                &json!({"source_role_id":"BAD","role_id":"copy"}),
            )
            .unwrap_err()
            .to_string();
        assert!(invalid_pattern.contains("does not match the required pattern"));

        let unknown_field = server
            .call_tool(
                "custom_role_clone",
                &json!({"source_role_id":"source","role_id":"copy","unexpected":true}),
            )
            .unwrap_err()
            .to_string();
        assert!(unknown_field.contains("unexpected is not allowed"));
    }

    struct TestCatalogAuthorVerifier;

    impl CatalogAuthorVerifier for TestCatalogAuthorVerifier {
        fn authenticated_principal(&self) -> Result<String, RuntimeError> {
            Ok("host:operator-a".into())
        }
    }

    fn server_with_catalog_authority() -> McpServer {
        server().with_catalog_author_verifier(Arc::new(TestCatalogAuthorVerifier))
    }

    #[test]
    fn catalog_mutations_fail_closed_without_host_authenticated_identity() {
        let server = server();
        let error = server.call_tool(
            "custom_role_create",
            &json!({
                "role_id":"identity-test","name":"Identity Test","description":"Role for identity boundary test",
                "system_prompt":"No implicit identity","input_contract":["job.request"],
                "output_artifact_type":"requirements","allowed_capabilities":["product.requirements"],
                "permissions":["workspace.read","artifact.create"],"allowed_tools":["workflow_get"],"skills":[]
            }),
        ).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("authenticated catalog author verifier is not configured")
        );
        assert!(
            server
                .service
                .list_custom_roles(true, 10)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn catalog_identity_verifier_output_is_not_allowed_to_be_unattributed() {
        struct Unattributed;
        impl CatalogAuthorVerifier for Unattributed {
            fn authenticated_principal(&self) -> Result<String, RuntimeError> {
                Ok("mcp:unattributed".into())
            }
        }
        let server = server().with_catalog_author_verifier(Arc::new(Unattributed));
        let error = server
            .call_tool("custom_workflow_preview", &json!({"workflow_id":"missing"}))
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("invalid authenticated principal")
        );
    }

    #[test]
    fn workflow_policy_mcp_requires_authenticated_author_and_persists_exact_versions() {
        let definition = json!({
            "policy_id":"mcp-policy","name":"MCP policy","description":"policy fixture",
            "constraints":[{"id":"engineer-present","type":"task_role_present","role":"engineer"}],
            "success_criteria":[{"id":"all-complete","type":"all_tasks_completed"}]
        });
        let denied = server();
        assert!(
            denied
                .call_tool("workflow_policy_create", &definition)
                .unwrap_err()
                .to_string()
                .contains("authenticated catalog author verifier is not configured")
        );
        assert!(
            denied
                .graph_store()
                .unwrap()
                .list_workflow_policies(true, 10, None)
                .unwrap()
                .is_empty()
        );

        let server = server_with_catalog_authority();
        let validated = server
            .call_tool("workflow_policy_validate", &definition)
            .unwrap();
        assert_eq!(validated["valid"], true);
        assert_eq!(validated["persisted"], false);
        let created = server
            .call_tool("workflow_policy_create", &definition)
            .unwrap();
        assert_eq!(created["actor_identity"], "host:operator-a");
        assert_eq!(created["record"]["version"], 1);
        let updated = server
            .call_tool(
                "workflow_policy_update",
                &json!({
                    "policy_id":"mcp-policy","name":"MCP policy revised"
                }),
            )
            .unwrap();
        assert_eq!(updated["record"]["version"], 2);
        assert_eq!(
            updated["record"]["definition"]["constraints"][0]["role"],
            "engineer"
        );
        let exact = server
            .call_tool(
                "workflow_policy_get",
                &json!({"policy_id":"mcp-policy","version":1}),
            )
            .unwrap();
        assert_eq!(exact["record"]["version"], 1);
        assert_eq!(exact["record"]["definition"]["name"], "MCP policy");
        let listed = server
            .call_tool(
                "workflow_policy_list",
                &json!({"include_versions":true,"limit":20}),
            )
            .unwrap();
        assert_eq!(listed["count"], 2);
        assert_eq!(listed["attachments"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn workflow_policy_attach_mcp_persists_exact_pin_before_approval() {
        let server = server_with_catalog_authority();
        let definition = json!({
            "policy_id":"mcp-attach-policy","name":"Attach policy",
            "constraints":[{"id":"engineer-present","type":"task_role_present","role":"engineer"}],
            "success_criteria":[{"id":"all-complete","type":"all_tasks_completed"}]
        });
        server
            .call_tool("workflow_policy_create", &definition)
            .unwrap();
        let workflow = server
            .service
            .create_proposal(WorkflowProposal {
                workflow_id: "job_policy_attach".into(),
                title: "Policy attachment fixture".into(),
                goal: "Verify exact policy pinning".into(),
                tasks: vec![runalith_domain::TaskSpec {
                    task_id: "task-engineer".into(),
                    role: "engineer".into(),
                    description: "Implement policy fixture".into(),
                    depends_on: vec![],
                    required_evidence: vec!["report".into()],
                    inputs: BTreeMap::new(),
                }],
                metadata: BTreeMap::new(),
            })
            .unwrap();
        let attached = server
            .call_tool(
                "workflow_policy_attach",
                &json!({
                    "job_id":workflow.workflow_id,"policy_id":"mcp-attach-policy","version":1
                }),
            )
            .unwrap();
        assert_eq!(attached["attached"], true);
        assert_eq!(attached["approval_required"], true);
        assert_eq!(attached["execution_authorized"], false);
        assert_eq!(attached["attachment"]["version"], 1);
        let refreshed = server
            .graph_store()
            .unwrap()
            .get_workflow("job_policy_attach")
            .unwrap();
        assert_eq!(refreshed.state, runalith_domain::WorkflowState::Proposed);
        let details = server
            .call_tool(
                "workflow_policy_get",
                &json!({"policy_id":"mcp-attach-policy"}),
            )
            .unwrap();
        assert_eq!(details["attachments"].as_array().unwrap().len(), 1);
        assert_eq!(
            details["events"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|event| event["event_type"] == "attached")
                .count(),
            1
        );
    }

    #[test]
    fn task_result_tool_fails_closed_without_host_producer_verifier() {
        let server = server();
        let result = server.call_tool(
            "workflow_record_task_result",
            &json!({
                "workflow_id":"workflow-test",
                "task_id":"task-test",
                "lease_id":"lease-test",
                "worker_id":"worker-test",
                "attempt":1,
                "event_id":"event-test-1",
                "producer_id":"worker-test",
                "payload_sha256":"a".repeat(64),
                "outcome":"UNKNOWN",
                "evidence":[],
                "error":"test observation"
            }),
        );
        assert!(matches!(
            result,
            Err(RuntimeError::Invariant(message))
                if message.contains("authenticated task-result producer verifier is not configured")
        ));
    }

    fn modern_meta() -> Value {
        json!({"_meta": {
            "io.modelcontextprotocol/protocolVersion": MCP_MODERN_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {"name":"test-client","version":"1"}
        }})
    }

    fn rpc(id: u64, method: &str, params: Value) -> Vec<u8> {
        let request = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        serde_json::to_vec(&request).unwrap()
    }

    #[test]
    fn workflow_validate_artifact_checks_node_content_contract_and_optional_role() {
        let server = server();
        let mut params = modern_meta();
        params["name"] = json!("workflow_validate_artifact");
        params["arguments"] = json!({
            "artifact_type":"requirements",
            "artifact":{"scope":"release","acceptance_criteria":[],"non_goals":[]},
            "role":"product-owner"
        });
        let valid: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(1, "tools/call", params))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let valid = &valid["result"]["structuredContent"];
        assert_eq!(valid["valid"], true);
        assert_eq!(valid["schema_version"], 1);
        assert_eq!(valid["expected_type_for_role"], "requirements");
        assert_eq!(valid["role_matches_type"], true);
        assert_eq!(valid["missing_fields"], json!([]));

        let mut params = modern_meta();
        params["name"] = json!("workflow_validate_artifact");
        params["arguments"] = json!({
            "artifact_type":"requirements",
            "artifact":{"scope":"release","acceptance_criteria":[],"non_goals":[]},
            "role":""
        });
        let empty_role: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(2, "tools/call", params))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let empty_role = &empty_role["result"]["structuredContent"];
        assert_eq!(empty_role["valid"], true);
        assert_eq!(empty_role["expected_type_for_role"], Value::Null);

        let mut params = modern_meta();
        params["name"] = json!("workflow_validate_artifact");
        params["arguments"] = json!({
            "artifact_type":"research",
            "artifact":{"findings":[],"sources":[],"limitations":[]},
            "role":"product-owner"
        });
        let mismatch: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(3, "tools/call", params))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let mismatch = &mismatch["result"]["structuredContent"];
        assert_eq!(mismatch["valid"], false);
        assert_eq!(mismatch["expected_type_for_role"], "requirements");
        assert_eq!(mismatch["role_matches_type"], false);

        let mut params = modern_meta();
        params["name"] = json!("workflow_validate_artifact");
        params["arguments"] = json!({
            "artifact_type":"requirements",
            "artifact":{"scope":"release","acceptance_criteria":"not-an-array","non_goals":[]}
        });
        let invalid: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(4, "tools/call", params))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let invalid = &invalid["result"]["structuredContent"];
        assert_eq!(invalid["valid"], false);
        assert_eq!(invalid["missing_fields"], json!([]));
        assert!(
            invalid["semantic_error"]
                .as_str()
                .unwrap()
                .contains("invalid fields")
        );

        let mut params = modern_meta();
        params["name"] = json!("workflow_validate_artifact");
        params["arguments"] = json!({
            "artifact_type":"requirements",
            "artifact":{"scope":"release"}
        });
        let missing: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(5, "tools/call", params))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let missing = &missing["result"]["structuredContent"];
        assert_eq!(missing["valid"], false);
        assert_eq!(
            missing["missing_fields"],
            json!(["acceptance_criteria", "non_goals"])
        );
        assert_eq!(missing["semantic_error"], Value::Null);

        let mut params = modern_meta();
        params["name"] = json!("workflow_validate_artifact");
        params["arguments"] = json!({
            "artifact_type":"requirements",
            "artifact":{"scope":"release","acceptance_criteria":[],"non_goals":[]},
            "role":"unregistered-role"
        });
        let unknown_role: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(6, "tools/call", params))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(unknown_role["result"]["isError"], true);
    }

    #[test]
    fn modern_discovery_and_tool_list_use_current_wire_revision() {
        let server = server();
        let response: Value = serde_json::from_slice(
            server
                .handle_frame(&rpc(1, "server/discover", modern_meta()))
                .unwrap()
                .unwrap()
                .as_slice(),
        )
        .unwrap();
        assert_eq!(
            response["result"]["supportedVersions"][0],
            MCP_MODERN_VERSION
        );
        assert_eq!(
            response["result"]["_meta"][SERVER_INFO_META_KEY]["name"],
            SERVER_NAME
        );
        assert!(response["result"]["capabilities"]["resources"].is_object());
        assert!(response["result"]["capabilities"]["prompts"].is_object());
        let response: Value = serde_json::from_slice(
            server
                .handle_frame(&rpc(2, "tools/list", modern_meta()))
                .unwrap()
                .unwrap()
                .as_slice(),
        )
        .unwrap();
        assert_eq!(response["result"]["resultType"], "complete");
        assert_eq!(
            response["result"]["tools"].as_array().unwrap().len(),
            registered_tool_count()
        );
        assert_eq!(response["result"]["cacheScope"], "private");
    }

    #[test]
    fn mcp_exposes_governance_resources_and_read_only_operator_prompts() {
        let server = server();
        let listed: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(1, "resources/list", modern_meta()))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(listed["result"]["resources"].as_array().unwrap().len(), 3);
        let authority: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(
                    2,
                    "resources/read",
                    json!({"_meta":modern_meta()["_meta"],"uri":"runalith://governance/authority"}),
                ))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let authority_text = authority["result"]["contents"][0]["text"].as_str().unwrap();
        assert!(authority_text.contains("deny-all"));
        assert!(authority_text.contains("external checkpoint adapter"));

        let prompts: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(3, "prompts/list", modern_meta()))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(prompts["result"]["prompts"].as_array().unwrap().len(), 3);
        let prompt: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(
                    4,
                    "prompts/get",
                    json!({
                        "_meta":modern_meta()["_meta"],
                        "name":"triage_unknown_attempt",
                        "arguments":{"workflow_id":"job_unknown","task_id":"task_1"}
                    }),
                ))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let prompt_text = prompt["result"]["messages"][0]["content"]["text"]
            .as_str()
            .unwrap();
        assert!(prompt_text.contains("job_unknown"));
        assert!(prompt_text.contains("Do not retry, replay"));

        let invalid: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(
                    5,
                    "prompts/get",
                    json!({
                        "_meta":modern_meta()["_meta"],
                        "name":"triage_unknown_attempt",
                        "arguments":{"workflow_id":"job_unknown"}
                    }),
                ))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(invalid["error"]["code"], -32602);

        let invalid_extra: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(
                    6,
                    "prompts/get",
                    json!({
                        "_meta":modern_meta()["_meta"],
                        "name":"inspect_workflow",
                        "arguments":{"workflow_id":"job_unknown","unexpected":true}
                    }),
                ))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(invalid_extra["error"]["code"], -32602);
    }

    #[test]
    fn modern_requests_require_protocol_and_client_capability_metadata() {
        let server = server();
        let response: Value = serde_json::from_slice(
            server
                .handle_frame(&rpc(1, "tools/list", json!({})))
                .unwrap()
                .unwrap()
                .as_slice(),
        )
        .unwrap();
        assert_eq!(response["error"]["code"], -32602);
        let response: Value = serde_json::from_slice(
            server
                .handle_frame(&rpc(
                    2,
                    "tools/list",
                    json!({"_meta":{
                        "io.modelcontextprotocol/protocolVersion": MCP_MODERN_VERSION
                    }}),
                ))
                .unwrap()
                .unwrap()
                .as_slice(),
        )
        .unwrap();
        assert_eq!(response["error"]["code"], -32602);
    }

    #[test]
    fn legacy_handshake_is_supported_until_initialized_notification() {
        let server = server();
        let initialize = rpc(
            1,
            "initialize",
            json!({
                "protocolVersion": MCP_LEGACY_VERSION,"capabilities":{},"clientInfo":{"name":"old-client","version":"1"}
            }),
        );
        let response: Value = serde_json::from_slice(
            server
                .handle_frame(&initialize)
                .unwrap()
                .unwrap()
                .as_slice(),
        )
        .unwrap();
        assert_eq!(response["result"]["protocolVersion"], MCP_LEGACY_VERSION);
        assert!(response["result"]["capabilities"]["resources"].is_object());
        assert!(response["result"]["capabilities"]["prompts"].is_object());
        let premature: Value = serde_json::from_slice(
            server
                .handle_frame(&rpc(2, "tools/list", json!({})))
                .unwrap()
                .unwrap()
                .as_slice(),
        )
        .unwrap();
        assert_eq!(premature["error"]["code"], -32600);
        assert!(
            server
                .handle_frame(br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
                .unwrap()
                .is_none()
        );
        let listed: Value = serde_json::from_slice(
            server
                .handle_frame(&rpc(3, "tools/list", json!({})))
                .unwrap()
                .unwrap()
                .as_slice(),
        )
        .unwrap();
        assert!(listed["result"].get("resultType").is_none());
        assert_eq!(
            listed["result"]["tools"].as_array().unwrap().len(),
            registered_tool_count()
        );
        let resources: Value = serde_json::from_slice(
            server
                .handle_frame(&rpc(4, "resources/list", json!({})))
                .unwrap()
                .unwrap()
                .as_slice(),
        )
        .unwrap();
        assert_eq!(
            resources["result"]["resources"].as_array().unwrap().len(),
            3
        );
        let prompts: Value = serde_json::from_slice(
            server
                .handle_frame(&rpc(5, "prompts/list", json!({})))
                .unwrap()
                .unwrap()
                .as_slice(),
        )
        .unwrap();
        assert_eq!(prompts["result"]["prompts"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn mcp_workflow_create_and_get_use_rust_runtime() {
        let server = server();
        let arguments = json!({
            "workflow_id": "job_mcp_01",
            "title": "MCP integration",
            "goal": "Prove end-to-end Rust MCP workflow",
            "tasks": [{
            "task_id":"task_1","role":"engineer","description":"Build a result",
            "depends_on":[],"required_evidence":["report"],"inputs":{}
        }]});
        let mut call_params = modern_meta();
        call_params["name"] = json!("workflow_create");
        call_params["arguments"] = arguments;
        let mut call = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":call_params});
        let created: Value = serde_json::from_slice(
            server
                .handle_frame(&serde_json::to_vec(&call).unwrap())
                .unwrap()
                .unwrap()
                .as_slice(),
        )
        .unwrap();
        assert_eq!(created["result"]["isError"], false);
        let output: Value =
            serde_json::from_str(created["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        assert_eq!(output["state"], "PROPOSED");
        assert_eq!(output["workflow_id"], "job_mcp_01");
        let synthesis = server
            .call_tool("workflow_synthesize", &json!({"workflow_id":"job_mcp_01"}))
            .unwrap();
        assert_eq!(synthesis["persisted"], true);
        assert_eq!(synthesis["report"]["outcome"], "UNRESOLVED");
        assert_eq!(synthesis["report"]["source_event_chain_valid"], true);

        call["params"]["name"] = json!("workflow_get");
        call["params"]["arguments"] = json!({"workflow_id":"job_mcp_01"});
        let read: Value = serde_json::from_slice(
            server
                .handle_frame(&serde_json::to_vec(&call).unwrap())
                .unwrap()
                .unwrap()
                .as_slice(),
        )
        .unwrap();
        let output: Value =
            serde_json::from_str(read["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(output["tasks"][0]["definition"]["task_id"], "task_1");

        call["params"]["name"] = json!("workflow_execution_graph_get");
        call["params"]["arguments"] = json!({"workflow_id":"job_mcp_01"});
        let execution_graph: Value = serde_json::from_slice(
            server
                .handle_frame(&serde_json::to_vec(&call).unwrap())
                .unwrap()
                .unwrap()
                .as_slice(),
        )
        .unwrap();
        let graph: Value = serde_json::from_str(
            execution_graph["result"]["content"][0]["text"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(graph["workflow_state"], "PROPOSED");
        assert_eq!(graph["tasks"][0]["task_id"], "task_1");
        assert_eq!(graph["event_chain_valid"], true);
        assert_eq!(graph["provider_run_identity_available"], false);
        assert_eq!(graph["dispatch_allowed"], false);

        call["params"]["name"] = json!("workflow_verify_event_chain");
        call["params"]["arguments"] = json!({"workflow_id":"job_mcp_01"});
        let verified: Value = serde_json::from_slice(
            server
                .handle_frame(&serde_json::to_vec(&call).unwrap())
                .unwrap()
                .unwrap()
                .as_slice(),
        )
        .unwrap();
        let report: Value =
            serde_json::from_str(verified["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        assert_eq!(report["valid"], true);
        assert_eq!(report["event_count"], 2);
    }

    #[test]
    fn custom_role_workflow_catalog_and_preview_are_durable_and_fail_closed() {
        let server = server_with_catalog_authority();
        let call = |id, name: &str, arguments: Value| {
            let response: Value = serde_json::from_slice(
                &server
                    .handle_frame(&rpc(
                        id,
                        "tools/call",
                        json!({
                            "_meta":modern_meta()["_meta"],"name":name,"arguments":arguments
                        }),
                    ))
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
            response["result"]["structuredContent"].clone()
        };
        let role = call(
            10,
            "custom_role_create",
            json!({
                "role_id":"custom-owner","name":"Custom Owner","description":"MCP catalog role",
                "system_prompt":"Use declared inputs and produce typed output","input_contract":["job.request"],
                "output_artifact_type":"requirements","allowed_capabilities":["product.requirements"],
                "permissions":["workspace.read","artifact.create"],"allowed_tools":["workflow_get"],"skills":[]
            }),
        );
        assert_eq!(role["created"], true);
        assert_eq!(role["record"]["definition"]["version"], 1);
        assert_eq!(role["runtime_access_granted"], false);
        assert_eq!(role["actor_identity"], "host:operator-a");

        let workflow = call(
            11,
            "custom_workflow_create",
            json!({
                "workflow_id":"custom-process","name":"Custom Process","description":"MCP workflow catalog",
                "input_contract":["job.request"],"tasks":[{"id":"requirements","role_id":"custom-owner","role_version":1,
                    "depends_on":[],"input_contract":["job.request"],"output_artifact_type":"requirements"}]
            }),
        );
        assert_eq!(workflow["created"], true);
        assert_eq!(workflow["record"]["definition"]["version"], 1);
        assert_eq!(workflow["actor_identity"], "host:operator-a");

        let preview = call(
            12,
            "custom_workflow_preview",
            json!({"workflow_id":"custom-process"}),
        );
        assert_eq!(preview["created"], true);
        assert_eq!(preview["persisted"], true);
        assert_eq!(preview["requires_explicit_approval"], true);
        assert_eq!(preview["plan_approved"], false);
        assert_eq!(preview["execution_authorized"], false);
        assert_eq!(preview["dispatch_performed"], false);
        assert_eq!(preview["actor_identity"], "host:operator-a");

        let plan_id = preview["plan"]["plan_id"].as_str().unwrap();
        let listed = call(
            13,
            "custom_workflow_list",
            json!({"include_versions":true,"limit":10}),
        );
        assert_eq!(listed["count"], 1);
        let roles = call(
            14,
            "custom_role_list",
            json!({"include_versions":true,"limit":10}),
        );
        assert_eq!(roles["count"], 1);
        assert!(!plan_id.is_empty());

        let cloned_role = call(
            15,
            "custom_role_clone",
            json!({"source_role_id":"custom-owner","role_id":"custom-owner-copy"}),
        );
        assert_eq!(cloned_role["cloned"], true);
        assert_eq!(cloned_role["runtime_access_granted"], false);
        assert_eq!(cloned_role["execution_authorized"], false);
        assert_eq!(cloned_role["actor_identity"], "host:operator-a");
        assert_eq!(
            cloned_role["record"]["definition"]["name"],
            "Custom Owner (copy)"
        );
        assert_eq!(
            cloned_role["record"]["definition"]["role_id"],
            "custom-owner-copy"
        );
    }

    #[test]
    fn custom_workflow_clone_preserves_exact_role_version_pins() {
        let server = server_with_catalog_authority();
        let call = |id, name: &str, arguments: Value| {
            let response: Value = serde_json::from_slice(
                &server
                    .handle_frame(&rpc(
                        id,
                        "tools/call",
                        json!({
                            "_meta":modern_meta()["_meta"],"name":name,"arguments":arguments
                        }),
                    ))
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(response["result"]["isError"], false, "{response}");
            response["result"]["structuredContent"].clone()
        };

        call(
            20,
            "custom_role_create",
            json!({
                "role_id":"clone-role","name":"Clone Role","description":"Source role",
                "system_prompt":"Use declared inputs and produce typed output","input_contract":["job.request"],
                "output_artifact_type":"requirements","allowed_capabilities":["product.requirements"],
                "permissions":["workspace.read","artifact.create"],"allowed_tools":["workflow_get"],"skills":[]
            }),
        );
        let source = call(
            21,
            "custom_workflow_create",
            json!({
                "workflow_id":"source-flow","name":"Source Flow","description":"Source description",
                "input_contract":["job.request"],"tasks":[{"id":"requirements","role_id":"clone-role","role_version":1,
                    "depends_on":[],"input_contract":["job.request"],"output_artifact_type":"requirements"}]
            }),
        );
        assert_eq!(source["record"]["definition"]["version"], 1);

        let cloned = call(
            22,
            "custom_workflow_clone",
            json!({"source_workflow_id":"source-flow","workflow_id":"copied-flow"}),
        );
        let definition = &cloned["record"]["definition"];
        assert_eq!(cloned["cloned"], true);
        assert_eq!(cloned["actor_identity"], "host:operator-a");
        assert_eq!(cloned["execution_authorized"], false);
        assert_eq!(definition["workflow_id"], "copied-flow");
        assert_eq!(definition["version"], 1);
        assert_eq!(definition["name"], "Source Flow (copy)");
        assert_eq!(definition["description"], "Source description");
        assert_eq!(definition["tasks"][0]["role_id"], "clone-role");
        assert_eq!(definition["tasks"][0]["role_version"], 1);

        let unchanged_source = call(
            23,
            "custom_workflow_get",
            json!({"workflow_id":"source-flow"}),
        );
        assert_eq!(
            unchanged_source["record"]["definition"]["name"],
            "Source Flow"
        );
        assert_eq!(
            unchanged_source["record"]["definition"]["workflow_id"],
            "source-flow"
        );
    }

    #[test]
    fn workflow_ready_tasks_is_a_read_only_projection() {
        let server = server();
        let response: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(
                    20,
                    "tools/call",
                    json!({
                        "_meta":modern_meta()["_meta"],
                        "name":"workflow_ready_tasks",
                        "arguments":{"limit":25}
                    }),
                ))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(response["result"]["isError"], false);
        let projection = &response["result"]["structuredContent"];
        assert_eq!(projection["read_only"], true);
        assert_eq!(projection["count"], 0);
        assert_eq!(projection["tasks"].as_array().unwrap().len(), 0);
        assert_eq!(projection["claim_performed"], false);
        assert_eq!(projection["dispatch_performed"], false);
    }

    #[test]
    fn workflow_list_and_events_are_read_only_bounded_projections() {
        let server = server();
        let mut params = modern_meta();
        params["name"] = json!("workflow_create");
        params["arguments"] = json!({
            "workflow_id":"job_readonly_views",
            "title":"Read-only views",
            "goal":"Exercise workflow list and event history",
            "tasks":[{"task_id":"one","role":"reviewer","description":"Review"}]
        });
        let create = rpc(1, "tools/call", params);
        let created: Value =
            serde_json::from_slice(&server.handle_frame(&create).unwrap().unwrap()).unwrap();
        assert_eq!(created["result"]["isError"], false);

        let mut params = modern_meta();
        params["name"] = json!("workflow_list");
        params["arguments"] = json!({"limit":10});
        let listed: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(2, "tools/call", params))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let workflows = &listed["result"]["structuredContent"];
        assert!(
            workflows
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["workflow_id"] == "job_readonly_views")
        );

        let mut params = modern_meta();
        params["name"] = json!("workflow_events");
        params["arguments"] = json!({"job_id":"job_readonly_views","limit":10});
        let events: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(3, "tools/call", params))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            events["result"]["structuredContent"]["job_id"],
            "job_readonly_views"
        );
        let events = events["result"]["structuredContent"]["events"]
            .as_array()
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "workflow.proposed");

        let mut params = modern_meta();
        params["name"] = json!("workflow_diagnose");
        params["arguments"] = json!({"workflow_id":"job_readonly_views"});
        let diagnosis: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(4, "tools/call", params))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let diagnosis = &diagnosis["result"]["structuredContent"];
        assert_eq!(diagnosis["read_only"], true);
        assert_eq!(diagnosis["workflow_state"], "PROPOSED");
        assert_eq!(diagnosis["mutations_performed"], false);
        assert_eq!(diagnosis["automatic_replay_allowed"], false);
        assert_eq!(diagnosis["runtime_session_inventory"], "unavailable");

        let mut params = modern_meta();
        params["name"] = json!("workflow_events");
        params["arguments"] = json!({"job_id":"job_readonly_views","limit":501});
        let invalid: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(5, "tools/call", params))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(invalid["result"]["isError"], true);
    }

    #[test]
    fn workflow_get_redacts_secret_fields_and_embedded_provider_tokens() {
        let server = server();
        let mut create = modern_meta();
        create["name"] = json!("workflow_create");
        create["arguments"] = json!({
            "workflow_id":"job_redaction_test",
            "title":"Redaction test",
            "goal":"Verify MCP secret redaction",
            "tasks":[{"task_id":"task_one","role":"reviewer","description":"Review","required_evidence":[],"inputs":{
                "api_key":"secret-api-key-value",
                "github_token":"ghp_123456789012345678901234",
                "safe_label":"ordinary-value"
            }}],
            "metadata":{"client_secret":"client-secret-value"}
        });
        let created: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(1, "tools/call", create))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(created["result"]["isError"], false);

        let mut get = modern_meta();
        get["name"] = json!("workflow_get");
        get["arguments"] = json!({"workflow_id":"job_redaction_test"});
        let response: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(2, "tools/call", get))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let workflow = &response["result"]["structuredContent"];
        assert_eq!(response["result"]["isError"], false);
        assert_eq!(
            workflow["tasks"][0]["definition"]["inputs"]["api_key"],
            "[REDACTED]"
        );
        assert_eq!(
            workflow["tasks"][0]["definition"]["inputs"]["github_token"],
            "[REDACTED]"
        );
        assert_eq!(
            workflow["proposal"]["metadata"]["client_secret"],
            "[REDACTED]"
        );
        assert_eq!(
            workflow["tasks"][0]["definition"]["inputs"]["safe_label"],
            "ordinary-value"
        );
    }

    #[test]
    fn workflow_attempt_inspect_is_read_only_and_never_infers_worker_death() {
        let server = server();
        let mut create = modern_meta();
        create["name"] = json!("workflow_create");
        create["arguments"] = json!({
            "workflow_id":"job_attempt_inspect",
            "title":"Attempt inspection",
            "goal":"Inspect durable attempt ownership",
            "tasks":[{"task_id":"task_one","role":"reviewer","description":"Review"}]
        });
        let created: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(1, "tools/call", create))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(created["result"]["isError"], false);

        let mut inspect = modern_meta();
        inspect["name"] = json!("workflow_attempt_inspect");
        inspect["arguments"] = json!({"workflow_id":"job_attempt_inspect","task_id":"task_one"});
        let response: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(2, "tools/call", inspect))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let result = &response["result"]["structuredContent"];
        assert_eq!(response["result"]["isError"], false);
        assert_eq!(result["read_only"], true);
        assert_eq!(result["attempt"], 0);
        assert_eq!(result["owner_epoch"], 0);
        assert_eq!(result["attempt_ledger"].as_array().unwrap().len(), 0);
        assert_eq!(result["session_history"].as_array().unwrap().len(), 0);
        assert_eq!(result["history_complete"], true);
        assert_eq!(result["classification"], "NO_ATTEMPT_RECORDED");
        assert_eq!(result["runtime_session_inventory"], "unavailable");
        assert_eq!(result["mutations_performed"], false);
        assert_eq!(result["automatic_retry_allowed"], false);
        assert_eq!(result["automatic_replay_allowed"], false);
        assert!(result.get("provider_payload").is_none());

        let mut invalid = modern_meta();
        invalid["name"] = json!("workflow_attempt_inspect");
        invalid["arguments"] = json!({"workflow_id":"job_attempt_inspect","task_id":"missing"});
        let missing: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(3, "tools/call", invalid))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(missing["result"]["isError"], true);
    }

    #[test]
    fn mcp_agent_session_acl_queue_receipt_and_ack_form_one_durable_flow() {
        let server = server();
        let call = |id, name: &str, arguments: Value| -> Value {
            let mut params = modern_meta();
            params["name"] = json!(name);
            params["arguments"] = arguments;
            let response: Value = serde_json::from_slice(
                &server
                    .handle_frame(&rpc(id, "tools/call", params))
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(response["result"]["isError"], false, "{response}");
            response["result"]["structuredContent"].clone()
        };
        call(
            1,
            "workflow_create",
            json!({
                "workflow_id":"job_agent_session_mcp","title":"Session MCP","goal":"Test durable session lifecycle",
                "tasks":[{"task_id":"task_one","role":"engineer","description":"Test session"}]
            }),
        );
        let session = call(
            2,
            "agent_session_create",
            json!({
                "workflow_id":"job_agent_session_mcp","task_id":"task_one",
                "runtime_session_key":"runtime:mcp:session:1","role":"engineer","attempt":1
            }),
        );
        assert_eq!(session["state"], "CREATED");
        let access = call(
            3,
            "agent_session_access_grant",
            json!({
                "session_id":session["session_id"],"accessor_role":"qa","permission":"MESSAGE","granted_by":"cto"
            }),
        );
        assert_eq!(access["persisted"], true);
        let queued = call(
            4,
            "agent_session_message_enqueue",
            json!({
                "session_id":session["session_id"],"message":{
                    "sender_role":"engineer","recipient_role":"qa","message_type":"session.message",
                    "payload":{"artifact_id":"artifact-1"},"correlation_id":"mcp-e2e","dedupe_key":"artifact-1"
                }
            }),
        );
        assert_eq!(queued["state"], "QUEUED");
        let claimed = call(
            5,
            "agent_session_message_claim",
            json!({
                "message_id":queued["message_id"],"recipient_role":"qa","lease_seconds":60
            }),
        );
        assert_eq!(claimed["state"], "CLAIMED");
        call(
            6,
            "agent_session_message_start",
            json!({
                "message_id":queued["message_id"],"attempt":claimed["attempt"],"lease_until":claimed["lease_until"]
            }),
        );
        call(
            7,
            "agent_session_message_receipt",
            json!({
                "message_id":queued["message_id"],"attempt":claimed["attempt"],"lease_until":claimed["lease_until"],
                "receipt":{"run_id":"mcp-provider-run-1","session_key":"runtime:mcp:session:1","recorded_at":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)}
            }),
        );
        let acked = call(
            8,
            "agent_session_message_ack",
            json!({
                "message_id":queued["message_id"],"recipient_role":"qa","attempt":claimed["attempt"],"lease_until":claimed["lease_until"]
            }),
        );
        assert_eq!(acked["state"], "ACKED");
        let attached = call(
            9,
            "agent_session_attach",
            json!({
                "session_id":session["session_id"],"actor_role":"engineer","mode":"OBSERVE"
            }),
        );
        assert_eq!(attached["permission"], "OBSERVE");
        call(
            10,
            "agent_session_access_grant",
            json!({
                "session_id":session["session_id"],"accessor_role":"qa","permission":"TAKEOVER","granted_by":"cto"
            }),
        );
        call(
            11,
            "agent_session_update",
            json!({
                "session_id":session["session_id"],"expected_attempt":1,"state":"PAUSED"
            }),
        );
        let taken = call(
            12,
            "agent_session_takeover",
            json!({
                "session_id":session["session_id"],"actor_role":"qa","reason":"MCP takeover test"
            }),
        );
        assert_eq!(taken["state"], "ACTIVE");
        let inspected = call(
            13,
            "agent_session_inspect",
            json!({"session_id":session["session_id"],"actor_role":"engineer","message_limit":10}),
        );
        assert_eq!(inspected["messages"].as_array().unwrap().len(), 1);
        assert_eq!(inspected["messages"][0]["state"], "ACKED");
        assert_eq!(inspected["messages_truncated"], false);
        let listed = call(
            14,
            "agent_session_list",
            json!({"workflow_id":"job_agent_session_mcp","state":"ACTIVE","limit":10}),
        );
        assert_eq!(listed.as_array().unwrap().len(), 1);
        assert_eq!(listed[0]["session_id"], session["session_id"]);
    }

    #[test]
    fn workflow_compile_matches_node_custom_workflow_preview_without_authorizing_execution() {
        let server = server();
        let workflow = json!({
            "workflow_id":"custom-research-flow",
            "version":1,
            "name":"Custom research flow",
            "description":"Custom-role compiler golden",
            "input_contract":["job.request"],
            "tasks":[
                {"id":"collect","role_id":"custom-researcher","role_version":1,"depends_on":["requirements"],"input_contract":["requirements"],"output_artifact_type":"research"},
                {"id":"requirements","role_id":"custom-owner","role_version":1,"depends_on":[],"input_contract":["job.request"],"output_artifact_type":"requirements"}
            ]
        });
        let roles = json!([
            {"role_id":"custom-owner","version":1,"name":"Custom Owner","description":"Custom role fixture","system_prompt":"Use only declared artifact inputs and emit typed output","input_contract":["job.request"],"output_artifact_type":"requirements","allowed_capabilities":["product.requirements"],"permissions":["workspace.read","artifact.create"],"allowed_tools":["workflow_get"],"skills":[]},
            {"role_id":"custom-researcher","version":1,"name":"Custom Researcher","description":"Custom role fixture","system_prompt":"Use only declared artifact inputs and emit typed output","input_contract":["requirements"],"output_artifact_type":"research","allowed_capabilities":["research.collect"],"permissions":["workspace.read","artifact.create"],"allowed_tools":["workflow_catalog"],"skills":[]}
        ]);
        let mut params = modern_meta();
        params["name"] = json!("workflow_compile");
        params["arguments"] = json!({"workflow":workflow,"roles":roles});
        let response: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(1, "tools/call", params))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let result = &response["result"]["structuredContent"];
        assert_eq!(response["result"]["isError"], false);
        assert_eq!(result["read_only"], true);
        assert_eq!(result["persisted"], false);
        assert_eq!(
            result["plan_hash"],
            "e67db3ba0b5636f869427d9e430ef93eb7d77e95dbcbc34ea963f66de55f82e6"
        );
        assert_eq!(result["requires_explicit_approval"], true);
        assert_eq!(result["execution_enabled"], false);
        assert_eq!(result["plan_approved"], false);
        assert_eq!(result["execution_authorized"], false);
        assert_eq!(result["plan"]["execution_order"][0], "requirements");

        let tools = modern_meta();
        let listed: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(2, "tools/list", tools))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            listed["result"]["tools"].as_array().unwrap().len(),
            registered_tool_count()
        );
        assert!(
            listed["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["name"] == "workflow_compile")
        );
    }

    #[test]
    fn workflow_event_redaction_masks_structured_and_embedded_secrets() {
        let redacted = redact_event_value(json!({
            "access_token":"opaque-token-value",
            "nested":{"client_secret":"client-secret-value"},
            "message":"ghp_123456789012345678901234 Bearer abc.def.ghi api_key=embedded-secret"
        }));
        assert_eq!(redacted["access_token"], "[REDACTED]");
        assert_eq!(redacted["nested"]["client_secret"], "[REDACTED]");
        let message = redacted["message"].as_str().unwrap();
        assert!(!message.contains("ghp_123456789012345678901234"));
        assert!(!message.contains("abc.def.ghi"));
        assert!(!message.contains("embedded-secret"));
    }

    #[test]
    fn mcp_provider_reconcile_uses_injected_lookup_only_adapter() {
        let store = Arc::new(Store::in_memory().unwrap());
        let service = Arc::new(WorkflowService::new(store.clone(), Arc::new(TestVerifier)));
        let workflow = service
            .create_proposal(WorkflowProposal {
                workflow_id: "job_mcp_provider".into(),
                title: "Provider reconciliation".into(),
                goal: "Verify MCP lookup-only adapter integration".into(),
                tasks: vec![TaskSpec {
                    task_id: "remote".into(),
                    role: "provider".into(),
                    description: "dispatch exact provider payload".into(),
                    depends_on: vec![],
                    required_evidence: vec![],
                    inputs: BTreeMap::new(),
                }],
                metadata: BTreeMap::new(),
            })
            .unwrap();
        service
            .approve(
                &workflow.workflow_id,
                ApprovalRequest {
                    actor: "test-reviewer".into(),
                    expected_proposal_hash: workflow.proposal_hash.clone(),
                    expected_plan_hash: content_hash(&workflow.plan).unwrap(),
                    evidence: json!({"test_only":true}),
                },
            )
            .unwrap();
        let lease = service
            .claim_task(
                &workflow.workflow_id,
                "remote",
                ClaimRequest {
                    worker_id: "provider-worker".into(),
                    lease_ttl_seconds: 60,
                },
            )
            .unwrap();
        let provider = Arc::new(LookupProvider {
            dispatches: std::sync::atomic::AtomicUsize::new(0),
            lookups: std::sync::atomic::AtomicUsize::new(0),
        });
        let intent = service
            .dispatch_provider_task(
                &workflow.workflow_id,
                "remote",
                &lease.lease_id,
                &lease.worker_id,
                provider.as_ref(),
                json!({"operation":"test-provider-operation"}),
            )
            .unwrap();
        assert_eq!(
            provider
                .dispatches
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );

        let server = McpServer::with_service_and_store(service, store)
            .with_provider_adapter(provider.clone());
        let mut params = modern_meta();
        params["name"] = json!("workflow_provider_reconcile");
        params["arguments"] = json!({"intent_id":intent.intent_id});
        let response: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(1, "tools/call", params))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(response["result"]["isError"], false);
        let result = &response["result"]["structuredContent"];
        assert_eq!(result["intent"]["provider_run_id"], "mcp-run-42");
        assert_eq!(
            result["observation"]["response_sha256"]
                .as_str()
                .unwrap()
                .len(),
            64
        );
        assert_eq!(result["observation"].get("response"), None);
        assert_eq!(result["intent"].get("request"), None);
        assert_eq!(result["provider_payload_exposed"], false);
        assert_eq!(result["provider_response_exposed"], false);
        assert_eq!(result["automatic_replay"], false);
        assert_eq!(result["unknown_is_terminal"], true);
        assert_eq!(
            provider
                .dispatches
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        assert_eq!(
            provider.lookups.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
    }

    #[test]
    fn graph_snapshot_get_reads_the_exact_sealed_revision_over_stdio() {
        let server = server();
        let call_tool = |id: u64, name: &str, arguments: Value| -> Value {
            let mut params = modern_meta();
            params["name"] = json!(name);
            params["arguments"] = arguments;
            let response: Value = serde_json::from_slice(
                &server
                    .handle_frame(&rpc(id, "tools/call", params))
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(response["result"]["isError"], false, "{response}");
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap()
        };

        let graph_id = "graph_snapshot_read";
        call_tool(1, "graph_create", json!({"graph_id":graph_id}));
        let content = json!({
            "agg":{"kind":"goal","evidence_refs":[]},
            "credentials":{"api_key":"snapshot-secret-value"}
        });
        call_tool(
            2,
            "graph_node_append",
            json!({
                "graph_id":graph_id,
                "node":{
                    "node_id":"goal",
                    "kind":"GOAL",
                    "revision":1,
                    "title":"goal",
                    "content":content,
                    "content_sha256":content_hash(&content).unwrap(),
                    "previous_revision_sha256":null
                }
            }),
        );
        let first = call_tool(3, "graph_snapshot_create", json!({"graph_id":graph_id}));
        let next_content = json!({"agg":{"kind":"idea","evidence_refs":[]}});
        call_tool(
            4,
            "graph_node_append",
            json!({
                "graph_id":graph_id,
                "node":{
                    "node_id":"idea",
                    "kind":"IDEA",
                    "revision":1,
                    "title":"idea",
                    "content":next_content,
                    "content_sha256":content_hash(&next_content).unwrap(),
                    "previous_revision_sha256":null
                }
            }),
        );
        let second = call_tool(5, "graph_snapshot_create", json!({"graph_id":graph_id}));
        let read_first = call_tool(
            6,
            "graph_snapshot_get",
            json!({"graph_id":graph_id,"revision":first["revision"]}),
        );
        let read_latest = call_tool(7, "graph_snapshot_get", json!({"graph_id":graph_id}));

        assert_eq!(first["revision"], 1);
        assert_eq!(second["revision"], 2);
        assert_eq!(read_first["read_only"], true);
        assert_eq!(read_first["snapshot_payload_redacted"], true);
        assert_eq!(read_first["snapshot_created"], false);
        assert_eq!(read_first["execution_authorized"], false);
        assert_eq!(read_first["dispatch_allowed"], false);
        assert_eq!(read_first["snapshot"], first);
        assert_eq!(
            read_first["snapshot"]["nodes"][0]["content"]["credentials"],
            "[REDACTED]"
        );
        assert_eq!(
            read_first["snapshot"]["snapshot_sha256"],
            first["snapshot_sha256"]
        );
        assert_eq!(read_latest["snapshot"], second);

        let mut missing_params = modern_meta();
        missing_params["name"] = json!("graph_snapshot_get");
        missing_params["arguments"] = json!({"graph_id":graph_id,"revision":99});
        let missing: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(8, "tools/call", missing_params))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(missing["result"]["isError"], true);

        let mut unsafe_revision_params = modern_meta();
        unsafe_revision_params["name"] = json!("graph_snapshot_get");
        unsafe_revision_params["arguments"] = json!({
            "graph_id":graph_id,
            "revision":9_007_199_254_740_992_i64
        });
        let unsafe_revision: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(9, "tools/call", unsafe_revision_params))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(unsafe_revision["result"]["isError"], true);
    }

    #[test]
    fn graph_snapshot_get_rejects_a_response_larger_than_the_mcp_frame_limit() {
        let server = server();
        let store = server.graph_store().unwrap();
        let graph_id = "graph_oversized_snapshot_response";
        store.create_graph(graph_id).unwrap();
        let content = json!({"payload":"x".repeat(super::MAX_MCP_FRAME_BYTES)});
        let node = super::GraphNodeRevision {
            node_id: "goal".into(),
            kind: runalith_domain::GraphNodeKind::Goal,
            revision: 1,
            title: "goal".into(),
            content: content.clone(),
            content_sha256: content_hash(&content).unwrap(),
            previous_revision_sha256: None,
        };
        store.append_graph_node_revision(graph_id, node).unwrap();
        store.create_graph_snapshot(graph_id).unwrap();
        let sealed_before = store.get_graph_snapshot(graph_id, None).unwrap();

        let mut params = modern_meta();
        params["name"] = json!("graph_snapshot_get");
        params["arguments"] = json!({"graph_id":graph_id});
        let response = server
            .handle_frame(&rpc(91, "tools/call", params))
            .unwrap()
            .unwrap();

        assert!(response.len() <= super::MAX_MCP_FRAME_BYTES);
        let decoded: Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(decoded["error"]["code"], -32603);
        assert_eq!(
            decoded["error"]["message"],
            "MCP response exceeds configured frame byte limit"
        );
        assert_eq!(
            store.get_graph_snapshot(graph_id, None).unwrap(),
            sealed_before,
            "oversized read response must not mutate the persisted snapshot"
        );
    }

    #[test]
    fn oversized_mutation_response_returns_bound_unknown_outcome() {
        let server = server();
        let response = server
            .mutation_outcome_unknown(json!("request-overflow-1"))
            .unwrap()
            .unwrap();

        assert!(response.len() <= super::MAX_MCP_FRAME_BYTES);
        let decoded: Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(decoded["id"], "request-overflow-1");
        assert_eq!(decoded["error"]["code"], -32003);
        assert_eq!(decoded["error"]["data"]["code"], "MUTATION_OUTCOME_UNKNOWN");
        assert_eq!(decoded["error"]["data"]["reconciliation_required"], true);
        assert_eq!(decoded["error"]["data"]["automatic_retry"], false);
    }

    #[test]
    fn oversized_protocol_error_is_replaced_with_a_bounded_request_bound_error() {
        let server = server();
        let oversized_message = "x".repeat(super::MAX_MCP_FRAME_BYTES + 1);
        let response = server
            .protocol_error(
                Some(json!("error-frame-1")),
                -32022,
                &oversized_message,
                Some(json!({"diagnostic":"untrusted oversized detail"})),
            )
            .unwrap()
            .unwrap();

        assert!(response.len() <= super::MAX_MCP_FRAME_BYTES);
        let decoded: Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(decoded["id"], "error-frame-1");
        assert_eq!(decoded["error"]["code"], -32603);
        assert_eq!(
            decoded["error"]["message"],
            "MCP error response exceeds configured frame byte limit"
        );
        assert_eq!(decoded["error"].get("data"), None);
    }

    #[test]
    fn response_limit_classification_uses_the_published_tool_effect_class() {
        assert!(super::mutating_tool_call(
            "tools/call",
            &json!({"name":"custom_role_create"})
        ));
        assert!(!super::mutating_tool_call(
            "tools/call",
            &json!({"name":"graph_snapshot_get"})
        ));
        assert!(!super::mutating_tool_call(
            "tools/list",
            &json!({"name":"custom_role_create"})
        ));
    }

    #[test]
    fn json_rpc_request_ids_are_bounded_before_becoming_response_metadata() {
        let server = server();
        let oversized_id = "x".repeat(129);
        let request = json!({
            "jsonrpc":"2.0",
            "id":oversized_id.clone(),
            "method":"tools/list",
            "params":modern_meta()
        });
        let response = server
            .handle_frame(&serde_json::to_vec(&request).unwrap())
            .unwrap()
            .unwrap();

        assert!(response.len() <= super::MAX_MCP_FRAME_BYTES);
        let decoded: Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(decoded["id"], Value::Null);
        assert_eq!(decoded["error"]["code"], -32600);

        let malformed = json!({
            "jsonrpc":"2.0",
            "id":oversized_id,
            "method":"tools/list",
            "params":"not-an-object"
        });
        let response = server
            .handle_frame(&serde_json::to_vec(&malformed).unwrap())
            .unwrap()
            .unwrap();
        assert!(response.len() <= super::MAX_MCP_FRAME_BYTES);
        let decoded: Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(decoded["id"], Value::Null);
        assert_eq!(decoded["error"]["code"], -32600);
    }

    #[test]
    fn mcp_goal_idea_plan_execution_graph_flows_through_rust_agg_shadow_search() {
        let server = server();
        let call_tool = |id: u64, name: &str, arguments: Value| -> Value {
            let mut params = modern_meta();
            params["name"] = json!(name);
            params["arguments"] = arguments;
            let response: Value = serde_json::from_slice(
                &server
                    .handle_frame(&rpc(id, "tools/call", params))
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(response["result"]["isError"], false, "{}", response);
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap()
        };
        let graph_id = "graph_mcp_agg";
        call_tool(1, "graph_create", json!({"graph_id":graph_id}));

        for (id, domain_kind, agg_kind, metrics) in [
            ("start", "IDEA", "capability", json!({})),
            (
                "task",
                "EXECUTION",
                "task",
                json!({
                    "estimated_cost":2.0,"estimated_risk":0.1,"estimated_success_confidence":0.9,
                    "reuse_potential":0.2,"information_value":0.3
                }),
            ),
            ("goal", "GOAL", "goal", json!({})),
        ] {
            let mut agg = json!({"kind":agg_kind,"label":id,"evidence_refs":[]});
            for (key, value) in metrics.as_object().unwrap() {
                agg[key] = value.clone();
            }
            let content = json!({"agg":agg});
            let node = json!({
                "node_id":id,"kind":domain_kind,"revision":1,"title":id,
                "content":content,"content_sha256":content_hash(&content).unwrap(),
                "previous_revision_sha256":null
            });
            call_tool(
                2 + ["start", "task", "goal"]
                    .iter()
                    .position(|candidate| *candidate == id)
                    .unwrap() as u64,
                "graph_node_append",
                json!({"graph_id":graph_id,"node":node}),
            );
        }
        for (id, from, to) in [
            ("edge_start_task", "start", "task"),
            ("edge_task_goal", "task", "goal"),
        ] {
            call_tool(
                5 + if id == "edge_start_task" { 0 } else { 1 },
                "graph_edge_append",
                json!({
                    "graph_id":graph_id,
                    "edge":{"edge_id":id,"from_node_id":from,"to_node_id":to,"kind":"NEXT_STEP"}
                }),
            );
        }
        let snapshot = call_tool(7, "graph_snapshot_create", json!({"graph_id":graph_id}));
        assert_eq!(snapshot["revision"], 5);
        let result = call_tool(
            8,
            "adaptive_goal_graph_search",
            json!({
                "graph_id":graph_id,"start_node_id":"start","goal_node_id":"goal"
            }),
        );
        assert_eq!(result["status"], "proposals_found");
        assert_eq!(
            result["candidates"][0]["path_node_ids"],
            json!(["start", "task", "goal"])
        );
        assert_eq!(result["candidates"][0]["evidence_verified"], false);
        assert_eq!(result["candidates"][0]["dispatch_allowed"], false);
        assert_eq!(result["execution_authorized"], false);
        assert_eq!(result["dispatch_allowed"], false);
        let plan = call_tool(
            9,
            "adaptive_goal_plan_project",
            json!({
                "graph_id":graph_id,"start_node_id":"start","goal_node_id":"goal",
                "candidate_plan_id":result["candidates"][0]["plan_id"]
            }),
        );
        assert_eq!(plan["status"], "review_required");
        assert_eq!(plan["steps"].as_array().unwrap().len(), 1);
        assert_eq!(plan["steps"][0]["source_node_id"], "task");
        assert_eq!(plan["steps"][0]["execution_enabled"], false);
        assert_eq!(plan["immutable_execution_plan_created"], false);
        assert_eq!(plan["dispatch_allowed"], false);
        let model_fixture: Value = serde_json::from_str(include_str!(
            "../../runalith-agg/fixtures/discriminator-v2-node-golden.json"
        ))
        .unwrap();
        let model = model_fixture["model"].clone();
        let phase2 = call_tool(
            10,
            "adaptive_goal_phase2_rank",
            json!({
                "graph_id":graph_id,"start_node_id":"start","goal_node_id":"goal","model":model
            }),
        );
        assert_eq!(phase2["status"], "model_estimate_unverified");
        assert_eq!(
            phase2["candidates"][0]["candidate"]["path_node_ids"],
            json!(["start", "task", "goal"])
        );
        assert_eq!(phase2["evidence_verified"], false);
        assert_eq!(phase2["execution_authorized"], false);
        assert_eq!(phase2["dispatch_allowed"], false);
        let mcts = call_tool(
            11,
            "adaptive_goal_mcts_shadow_search",
            json!({
                "graph_id":graph_id,"start_node_id":"start","goal_node_id":"goal","model":model,
                "options":{"iterations":32,"max_depth":8}
            }),
        );
        assert_eq!(mcts["iterations"], 32);
        assert_eq!(mcts["exhaustive"], false);
        assert_eq!(mcts["evidence_verification_status"], "UNKNOWN");
        assert_eq!(mcts["evidence_verified"], false);
        assert_eq!(mcts["execution_authorized"], false);
        assert_eq!(mcts["dispatch_allowed"], false);
    }

    #[test]
    fn mcp_sandbox_tool_executes_only_the_approved_plan_pinned_command() {
        let store = Arc::new(Store::in_memory().unwrap());
        let service = Arc::new(WorkflowService::new(store.clone(), Arc::new(TestVerifier)));
        let request = CommandRequest {
            executable: "/usr/bin/true".into(),
            arguments: vec![],
            working_directory: ".".into(),
            environment: BTreeMap::new(),
            stdin: vec![],
        };
        let mut inputs = BTreeMap::new();
        inputs.insert(
            "sandbox_command".into(),
            serde_json::to_value(&request).unwrap(),
        );
        let workflow = service
            .create_proposal(WorkflowProposal {
                workflow_id: "job_mcp_sandbox".into(),
                title: "MCP sandbox".into(),
                goal: "Execute approved plan-pinned command".into(),
                tasks: vec![TaskSpec {
                    task_id: "sandbox".into(),
                    role: "sandbox".into(),
                    description: "run command".into(),
                    depends_on: vec![],
                    required_evidence: vec!["sandbox_execution".into()],
                    inputs,
                }],
                metadata: BTreeMap::new(),
            })
            .unwrap();
        service
            .approve(
                &workflow.workflow_id,
                ApprovalRequest {
                    actor: "test-reviewer".into(),
                    expected_proposal_hash: workflow.proposal_hash.clone(),
                    expected_plan_hash: content_hash(&workflow.plan).unwrap(),
                    evidence: json!({"test_only":true}),
                },
            )
            .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let artifacts =
            Arc::new(ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap());
        let server = McpServer::with_service_and_store(service, store)
            .with_sandbox_execution(Arc::new(TestSandbox), artifacts);
        let mut params = modern_meta();
        params["name"] = json!("workflow_sandbox_execute");
        params["arguments"] = json!({
            "workflow_id":"job_mcp_sandbox","task_id":"sandbox",
            "worker_id":"mcp-worker","lease_ttl_seconds":60
        });
        let response: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(1, "tools/call", params))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(response["result"]["isError"], false, "{response}");
        let workflow: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        assert_eq!(workflow["state"], "COMPLETED");
        assert_eq!(workflow["tasks"][0]["state"], "SUCCEEDED");
        assert_eq!(
            workflow["tasks"][0]["result"]["evidence"][0]["kind"],
            "sandbox_execution"
        );
    }

    #[test]
    fn mcp_sandbox_tool_fails_closed_when_host_has_not_enabled_backend() {
        let server = server();
        let mut params = modern_meta();
        params["name"] = json!("workflow_sandbox_execute");
        params["arguments"] = json!({
            "workflow_id":"job_missing","task_id":"task","worker_id":"worker","lease_ttl_seconds":60
        });
        let response: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(1, "tools/call", params))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(response["result"]["isError"], true);
        assert!(
            response["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("sandbox execution is disabled")
        );
    }

    #[test]
    fn absent_approval_authority_is_reported_as_tool_error_not_approved() {
        let server = McpServer::new(Arc::new(Store::in_memory().unwrap()));
        let mut create = json!({
            "jsonrpc":"2.0","id":1,"method":"tools/call",
            "params": {"_meta":{
                "io.modelcontextprotocol/protocolVersion":MCP_MODERN_VERSION,
                "io.modelcontextprotocol/clientCapabilities":{}
            },"name":"workflow_create","arguments":{
                "workflow_id":"job_deny_01","title":"test","goal":"test",
                "tasks":[{"task_id":"one","role":"engineer","description":"test","required_evidence":["report"]}]
            }}
        });
        let created: Value = serde_json::from_slice(
            server
                .handle_frame(&serde_json::to_vec(&create).unwrap())
                .unwrap()
                .unwrap()
                .as_slice(),
        )
        .unwrap();
        let workflow: Value =
            serde_json::from_str(created["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        let proposal_hash = workflow["proposal_hash"].as_str().unwrap();
        let plan: WorkflowPlan = serde_json::from_value(workflow["plan"].clone()).unwrap();
        let plan_hash = content_hash(&plan).unwrap();
        create["id"] = json!(2);
        create["params"]["name"] = json!("workflow_approve");
        create["params"]["arguments"] = json!({
            "workflow_id":"job_deny_01","actor":"not-authenticated",
            "expected_proposal_hash":proposal_hash,"expected_plan_hash":plan_hash,
            "evidence":{"claimed":true}
        });
        let denied: Value = serde_json::from_slice(
            server
                .handle_frame(&serde_json::to_vec(&create).unwrap())
                .unwrap()
                .unwrap()
                .as_slice(),
        )
        .unwrap();
        assert_eq!(denied["result"]["isError"], true);
        assert!(
            denied["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("authority is not configured")
        );
    }

    #[test]
    fn orchestrator_health_is_read_only_and_reports_only_local_evidence() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("workflow-rust.db");
        let store = Arc::new(Store::create_new(&database).unwrap());
        let before = std::fs::metadata(&database).unwrap().modified().unwrap();
        let server = McpServer::new(store).with_database_path(database.clone());
        let mut params = modern_meta();
        params["name"] = json!("orchestrator_health");
        params["arguments"] = json!({});
        let response: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(1, "tools/call", params))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(response["result"]["isError"], false, "{response}");
        let health = &response["result"]["structuredContent"];
        assert_eq!(health["status"], "ok");
        assert_eq!(health["mode"], "local-only-rust-mcp");
        assert_eq!(health["read_only"], true);
        assert_eq!(health["store"]["read_only"], true);
        assert_eq!(health["store"]["quick_check"], "ok");
        assert_eq!(health["remote_probes"], false);
        assert_eq!(health["cloud_execution"], false);
        assert_eq!(health["github_actions_dispatch"], false);
        assert_eq!(health["external_model_api"], false);
        assert_eq!(health["event_chain"], "NOT_CHECKED");
        assert_eq!(health["production_authority"], "NOT_ESTABLISHED");
        assert_eq!(
            health["runtime_identity"]["startup_manifest_hash"],
            "NOT_PROVIDED"
        );
        assert_eq!(
            std::fs::metadata(&database).unwrap().modified().unwrap(),
            before
        );

        let definition = tool_definitions()
            .into_iter()
            .find(|tool| tool["name"] == "orchestrator_health")
            .unwrap();
        assert_eq!(definition["annotations"]["readOnlyHint"], true);
        assert_eq!(definition["annotations"]["idempotentHint"], true);
        assert_eq!(definition["inputSchema"]["additionalProperties"], false);
        assert_eq!(definition["inputSchema"]["properties"], json!({}));
    }

    #[test]
    fn orchestrator_health_fails_closed_without_host_database_path_or_with_arguments() {
        let server = server();
        assert!(server.call_tool("orchestrator_health", &json!({})).is_err());
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("workflow-rust.db");
        let server = McpServer::new(Arc::new(Store::create_new(&database).unwrap()))
            .with_database_path(database);
        assert!(
            server
                .call_tool("orchestrator_health", &json!({"probe_remote":true}))
                .is_err()
        );
    }

    #[test]
    fn stdio_serves_multiple_requests_without_mixing_stdout_with_logs() {
        let server = server_with_local_gateway();
        let input = format!(
            "{}\n{}\n",
            String::from_utf8(rpc(1, "server/discover", modern_meta())).unwrap(),
            String::from_utf8(rpc(2, "tools/list", modern_meta())).unwrap()
        );
        let mut output = Vec::new();
        serve_stdio(std::io::Cursor::new(input), &mut output, &server).unwrap();
        let responses = String::from_utf8(output).unwrap();
        assert_eq!(responses.lines().count(), 2);
        assert!(responses.contains("serverInfo"));
    }

    #[test]
    fn stdio_refuses_to_start_without_authenticated_gateway_context() {
        let server = server();
        let error =
            serve_stdio(std::io::Cursor::new(Vec::<u8>::new()), Vec::new(), &server).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("requires an authenticated Gateway context")
        );
    }

    #[test]
    fn tools_call_notification_without_request_id_never_mutates_workflow_state() {
        let server = server();
        let workflow_id = "job_mcp_notification_must_not_create";
        let mut params = modern_meta();
        params["name"] = json!("workflow_create");
        params["arguments"] = json!({
            "workflow_id":workflow_id,
            "title":"Notification must not execute",
            "goal":"No request ID means no attributable mutation",
            "tasks":[{"task_id":"task_1","role":"engineer","description":"Build"}]
        });
        let notification = json!({
            "jsonrpc":"2.0",
            "method":"tools/call",
            "params":params
        });

        assert!(
            server
                .handle_frame(&serde_json::to_vec(&notification).unwrap())
                .unwrap()
                .is_none()
        );

        let mut list_params = modern_meta();
        list_params["name"] = json!("workflow_list");
        list_params["arguments"] = json!({"limit":10});
        let listed: Value = serde_json::from_slice(
            &server
                .handle_frame(&rpc(92, "tools/call", list_params))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let workflows = listed["result"]["structuredContent"]
            .as_array()
            .expect("workflow_list must return an array");
        assert!(
            workflows
                .iter()
                .all(|item| item["workflow_id"] != workflow_id),
            "a tools/call notification without an ID must not create a workflow: {listed}"
        );
    }

    #[test]
    fn line_reader_rejects_oversized_frames() {
        let bytes = vec![b'x'; MAX_MCP_FRAME_BYTES + 1];
        let mut reader = std::io::Cursor::new(bytes);
        assert!(read_bounded_frame(&mut reader).is_err());
    }

    #[test]
    fn line_reader_excludes_lf_and_crlf_delimiters_from_json_payload_limit() {
        let mut lf_frame = vec![b'x'; MAX_MCP_FRAME_BYTES];
        lf_frame.push(b'\n');
        let mut lf_reader = std::io::Cursor::new(lf_frame);
        assert_eq!(
            read_bounded_frame(&mut lf_reader).unwrap().unwrap().len(),
            MAX_MCP_FRAME_BYTES
        );

        let mut crlf_frame = vec![b'x'; MAX_MCP_FRAME_BYTES];
        crlf_frame.extend_from_slice(b"\r\n");
        let mut crlf_reader = std::io::Cursor::new(crlf_frame);
        assert_eq!(
            read_bounded_frame(&mut crlf_reader).unwrap().unwrap().len(),
            MAX_MCP_FRAME_BYTES
        );

        let mut oversized_frame = vec![b'x'; MAX_MCP_FRAME_BYTES + 1];
        oversized_frame.push(b'\n');
        let mut oversized_reader = std::io::Cursor::new(oversized_frame);
        assert!(read_bounded_frame(&mut oversized_reader).is_err());
    }
}
