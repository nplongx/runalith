//! Independent Part 1 workflow Control API.
//!
//! This crate owns the HTTP boundary and request authentication contract. It
//! does not depend on MCP, worker/provider crates, or Governance authority.
//! Hosts inject principal, approval, worker, cancellation, and result verifiers.

use std::{
    collections::HashSet,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError, TrySendError},
    },
    time::Duration,
};

use runalith_domain::{EvidenceRef, TaskOutcome, WorkflowProposal};
use runalith_domain::{custom_workflow::CustomRoleDefinition, workflow::CustomWorkflowDefinition};
use runalith_runtime::{
    ApprovalRequest, ApprovalVerifier, CoordinatorRequest, CoordinatorWorkerVerifier,
    DenyAllApprovalVerifier, RuntimeError, Store, TaskResultEnvelope, TaskResultProducerVerifier,
    TaskResultRequest, TrustedSkillResolver, WorkflowCancellationRequest,
    WorkflowCancellationVerifier, WorkflowPolicyDefinition, WorkflowService,
};
use serde::{
    Deserialize,
    de::{self, MapAccess, SeqAccess, Visitor},
};
use serde_json::{Value, json};
use thiserror::Error;

const MAX_REQUEST_BYTES: usize = 1_048_576;
const MAX_HEADER_BYTES: usize = 16_384;

/// Authenticated caller identity. Capabilities are host-derived, never request supplied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlPrincipal {
    /// Stable subject from the host identity system.
    pub subject: String,
    /// Issuer or authentication realm.
    pub issuer: String,
    /// Exact capabilities granted by the host.
    pub capabilities: Vec<String>,
}

/// Host-injected credential verifier. No default permissive implementation exists.
pub trait ControlPrincipalVerifier: Send + Sync {
    /// Authenticate an opaque transport credential and return its canonical principal.
    fn authenticate(&self, credential: &str) -> Result<ControlPrincipal, ControlApiError>;
}

/// Failure returned by the host-owned worker authority. The authority must
/// serialize lease/fence mutations and their receipts in its durable database
/// transaction; this HTTP adapter deliberately has no permissive fallback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerControlError {
    /// The principal or claim is not authorized for the requested operation.
    Unauthorized(String),
    /// Current lease, owner epoch, ACL, or immutable binding conflicts.
    Conflict(String),
    /// The host has not configured the durable worker-control authority.
    Unavailable(String),
    /// The authority rejected malformed or unsupported worker input.
    Invalid(String),
    /// A durable operation failed unexpectedly.
    Internal(String),
}

/// Host-owned implementation of the Worker-facing Control API.
///
/// Every mutation method must use one authoritative transaction that rechecks
/// the current lease, owner epoch, plan, worker identity and ACL while holding
/// the same serialization boundary used by owner transfer. Reservations must
/// remain active across UNKNOWN outcomes and survive restart. Implementations
/// must return the original durable receipt for exact idempotent retries.
/// This trait is intentionally injected: ControlApi cannot infer worker claim
/// signatures, session ACL policy, or host trust roots from an opaque bearer.
pub trait WorkerControlAuthority: Send + Sync {
    /// Receive at most one already-authorized claim for the authenticated worker.
    fn receive_claim(
        &self,
        principal: &ControlPrincipal,
        request: &Value,
    ) -> Result<Option<Value>, WorkerControlError>;

    /// Verify the complete signed claim and its current right to start.
    fn verify_claim(
        &self,
        principal: &ControlPrincipal,
        claim: &Value,
    ) -> Result<(), WorkerControlError>;

    /// Renew the exact current lease under the authoritative owner-epoch lock.
    fn renew_lease(
        &self,
        principal: &ControlPrincipal,
        request: &Value,
    ) -> Result<Value, WorkerControlError>;

    /// Accept an exact worker result with a durable idempotent receipt.
    fn publish_result(
        &self,
        principal: &ControlPrincipal,
        event: &Value,
    ) -> Result<Value, WorkerControlError>;

    /// Accept an exact provider terminal result with a durable idempotent receipt.
    fn publish_provider_result(
        &self,
        principal: &ControlPrincipal,
        event: &Value,
    ) -> Result<Value, WorkerControlError>;

    /// Deliver one session message after a transaction-time ACL recheck.
    fn deliver_session_message(
        &self,
        principal: &ControlPrincipal,
        message: &Value,
    ) -> Result<Value, WorkerControlError>;

    /// Reserve one exact externally visible side effect.
    fn reserve_execution_fence(
        &self,
        principal: &ControlPrincipal,
        request: &Value,
    ) -> Result<Value, WorkerControlError>;

    /// Complete/reconcile the exact reservation and return its durable receipt.
    fn complete_execution_fence(
        &self,
        principal: &ControlPrincipal,
        fence_id: &str,
        completion: &Value,
    ) -> Result<Value, WorkerControlError>;
}

/// Part 1 API composition. Every request is authenticated and capability-checked
/// before runtime access; runtime/store authority is independently revalidated.
pub struct ControlApi {
    service: Arc<WorkflowService>,
    principals: Arc<dyn ControlPrincipalVerifier>,
    workers: Arc<dyn CoordinatorWorkerVerifier>,
    results: Arc<dyn TaskResultProducerVerifier>,
    cancellations: Arc<dyn WorkflowCancellationVerifier>,
    trusted_skills: Option<Arc<dyn TrustedSkillResolver>>,
    worker_control: Option<Arc<dyn WorkerControlAuthority>>,
}

impl ControlApi {
    /// Compose an API around an independently owned Rust workflow database.
    /// Opening an existing database never migrates it. A missing DB is not created.
    pub fn open_existing(
        database_path: impl AsRef<std::path::Path>,
        approval: Arc<dyn ApprovalVerifier>,
        principals: Arc<dyn ControlPrincipalVerifier>,
        workers: Arc<dyn CoordinatorWorkerVerifier>,
        results: Arc<dyn TaskResultProducerVerifier>,
        cancellations: Arc<dyn WorkflowCancellationVerifier>,
    ) -> Result<Self, ControlApiError> {
        let store = Arc::new(Store::open_existing(database_path)?);
        Ok(Self::from_store(
            store.clone(),
            approval,
            principals,
            workers,
            results,
            cancellations,
        ))
    }

    /// Compose with a Store created by the owning host. No API-owned hidden DB is opened.
    pub fn from_store(
        store: Arc<Store>,
        approval: Arc<dyn ApprovalVerifier>,
        principals: Arc<dyn ControlPrincipalVerifier>,
        workers: Arc<dyn CoordinatorWorkerVerifier>,
        results: Arc<dyn TaskResultProducerVerifier>,
        cancellations: Arc<dyn WorkflowCancellationVerifier>,
    ) -> Self {
        Self {
            service: Arc::new(WorkflowService::new(store, approval)),
            principals,
            workers,
            results,
            cancellations,
            trusted_skills: None,
            worker_control: None,
        }
    }

    /// Attach host authority for exact trusted-skill resolution and revocation checks.
    #[must_use]
    pub fn with_trusted_skill_resolver(mut self, resolver: Arc<dyn TrustedSkillResolver>) -> Self {
        self.trusted_skills = Some(resolver);
        self
    }

    /// Attach the authoritative worker-control backend. Without it all
    /// `/v1/worker/*` routes fail closed with 503 and no lease or side effect is
    /// acknowledged.
    #[must_use]
    pub fn with_worker_control_authority(
        mut self,
        authority: Arc<dyn WorkerControlAuthority>,
    ) -> Self {
        self.worker_control = Some(authority);
        self
    }

    /// Handle one bounded HTTP/JSON request. Authorization is repeated at this boundary
    /// and all state transitions remain protected by Store transactions/verifiers.
    pub fn handle(&self, request: HttpRequest<'_>) -> HttpResponse {
        // Liveness and readiness are deliberately minimal probe endpoints. They
        // disclose no workflow data and must remain usable by a local service
        // manager before credentials are loaded by its health-check client.
        match (request.method, request.path) {
            ("GET", "/livez") => {
                return HttpResponse::json(200, json!({"status":"live"}));
            }
            ("GET", "/readyz") => {
                return match self.service.check_readiness() {
                    Ok(()) => HttpResponse::json(
                        200,
                        json!({
                            "status":"ready",
                            "store_schema_version":Store::CURRENT_SCHEMA_VERSION
                        }),
                    ),
                    Err(_) => HttpResponse::error(503, "workflow store is not ready"),
                };
            }
            _ => {}
        }

        let principal = match request.bearer_token() {
            Ok(token) => match self.principals.authenticate(token) {
                Ok(principal) if valid_principal(&principal) => principal,
                Ok(_) => return HttpResponse::error(401, "invalid authenticated principal"),
                Err(_) => return HttpResponse::error(401, "authentication failed"),
            },
            Err(_) => return HttpResponse::error(401, "bearer authentication required"),
        };

        if request.path.starts_with("/v1/worker/") {
            return self.route_worker_control(&principal, request);
        }

        match (request.method, request.path) {
            ("GET", "/health") => {
                if !authorized(&principal, "control.health.read") {
                    return HttpResponse::error(403, "forbidden");
                }
                HttpResponse::json(
                    200,
                    json!({
                        "service":"runalith-control-api",
                        "part":"1-workflow-control",
                        "authority":"host-injected",
                        "execution_dispatch":"not_provided_by_control_api"
                    }),
                )
            }
            ("GET", "/v1/catalog/roles") => {
                if !authorized(&principal, "catalog.read") {
                    return forbidden();
                }
                let limit = match query_limit(request.query, 100) {
                    Ok(value) => value,
                    Err(error) => return bad_request(error),
                };
                match self.service.list_custom_roles(true, limit) {
                    Ok(items) => HttpResponse::json(200, json!({"items":items})),
                    Err(error) => runtime_error(error),
                }
            }
            ("GET", "/v1/policies") => {
                if !authorized(&principal, "policy.read") {
                    return forbidden();
                }
                match self.service.list_workflow_policies(
                    true,
                    match query_limit(request.query, 100) {
                        Ok(value) => value,
                        Err(error) => return bad_request(error),
                    },
                    None,
                ) {
                    Ok(items) => HttpResponse::json(200, json!({"items":items})),
                    Err(error) => runtime_error(error),
                }
            }
            ("POST", "/v1/policies") => {
                if !authorized(&principal, "policy.write") {
                    return forbidden();
                }
                let definition: WorkflowPolicyDefinition = match decode_body(request.body) {
                    Ok(value) => value,
                    Err(error) => return bad_request(error),
                };
                match self
                    .service
                    .create_workflow_policy(definition, &principal.subject)
                {
                    Ok(value) => HttpResponse::json(201, json!(value)),
                    Err(error) => runtime_error(error),
                }
            }
            ("POST", "/v1/catalog/roles") => {
                if !authorized(&principal, "catalog.role.write") {
                    return forbidden();
                }
                let Some(resolver) = self.trusted_skills.as_ref() else {
                    return authority_unavailable();
                };
                let definition: CustomRoleDefinition = match decode_body(request.body) {
                    Ok(value) => value,
                    Err(error) => return bad_request(error),
                };
                match self.service.create_custom_role_with_trusted_skills(
                    definition,
                    &principal.subject,
                    resolver.as_ref(),
                ) {
                    Ok(value) => HttpResponse::json(201, json!(value)),
                    Err(error) => runtime_error(error),
                }
            }
            ("GET", "/v1/catalog/workflows") => {
                if !authorized(&principal, "catalog.read") {
                    return forbidden();
                }
                let limit = match query_limit(request.query, 100) {
                    Ok(value) => value,
                    Err(error) => return bad_request(error),
                };
                match self.service.list_custom_workflows(true, limit) {
                    Ok(items) => HttpResponse::json(200, json!({"items":items})),
                    Err(error) => runtime_error(error),
                }
            }
            ("POST", "/v1/catalog/workflows") => {
                if !authorized(&principal, "catalog.workflow.write") {
                    return forbidden();
                }
                let Some(resolver) = self.trusted_skills.as_ref() else {
                    return authority_unavailable();
                };
                let definition: CustomWorkflowDefinition = match decode_body(request.body) {
                    Ok(value) => value,
                    Err(error) => return bad_request(error),
                };
                match self.service.create_custom_workflow_with_trusted_skills(
                    definition,
                    &principal.subject,
                    resolver.as_ref(),
                ) {
                    Ok(value) => HttpResponse::json(201, json!(value)),
                    Err(error) => runtime_error(error),
                }
            }
            ("GET", "/v1/workflows") => {
                if !authorized(&principal, "workflow.read") {
                    return forbidden();
                }
                match self
                    .service
                    .list_active_workflows(match query_limit(request.query, 100) {
                        Ok(value) => value as usize,
                        Err(error) => return bad_request(error),
                    }) {
                    Ok(items) => HttpResponse::json(200, json!({"items":items})),
                    Err(error) => runtime_error(error),
                }
            }
            ("POST", "/v1/workflows") => {
                if !authorized(&principal, "workflow.create") {
                    return forbidden();
                }
                let proposal: WorkflowProposal = match decode_body(request.body) {
                    Ok(value) => value,
                    Err(error) => return bad_request(error),
                };
                match self.service.create_proposal(proposal) {
                    Ok(value) => HttpResponse::json(201, json!(value)),
                    Err(error) => runtime_error(error),
                }
            }
            ("POST", "/v1/workflows/from-catalog-plan") => {
                if !authorized(&principal, "workflow.create") {
                    return forbidden();
                }
                let Some(resolver) = self.trusted_skills.as_ref() else {
                    return authority_unavailable();
                };
                let body: CreateFromCatalogPlanBody = match decode_body(request.body) {
                    Ok(value) => value,
                    Err(error) => return bad_request(error),
                };
                match self.service.create_proposal_from_custom_workflow_plan(
                    &body.plan_id,
                    &body.idempotency_key,
                    &body.title,
                    &body.goal,
                    &principal.subject,
                    resolver.as_ref(),
                ) {
                    Ok(value) => HttpResponse::json(201, json!(value)),
                    Err(error) => runtime_error(error),
                }
            }
            ("POST", "/v1/coordinator/tick") => {
                if !authorized(&principal, "workflow.schedule") {
                    return forbidden();
                }
                let body: CoordinatorBody = match decode_body(request.body) {
                    Ok(value) => value,
                    Err(error) => return bad_request(error),
                };
                let command = CoordinatorRequest {
                    worker_id: principal.subject,
                    lease_ttl_seconds: body.lease_ttl_seconds,
                    max_parallel: body.max_parallel,
                    max_parallel_per_workflow: body.max_parallel_per_workflow,
                };
                match self
                    .service
                    .coordinator_claim_next(command, self.workers.as_ref())
                {
                    Ok(lease) => HttpResponse::json(200, json!({"lease":lease,"dispatch":false})),
                    Err(error) => runtime_error(error),
                }
            }
            _ => self.route_workflow(&principal, request),
        }
    }

    fn route_worker_control(
        &self,
        principal: &ControlPrincipal,
        request: HttpRequest<'_>,
    ) -> HttpResponse {
        let Some(authority) = self.worker_control.as_ref() else {
            return HttpResponse::error(
                503,
                "authoritative worker-control backend is not configured",
            );
        };
        let parsed_body = || -> Result<Value, String> {
            let value: Value = decode_body(request.body)?;
            if !value.is_object() {
                return Err("worker-control request must be a JSON object".into());
            }
            Ok(value)
        };
        let result = match (request.method, request.path) {
            ("POST", "/v1/worker/claims/receive") => {
                if !authorized(principal, "worker.claim.receive") {
                    return forbidden();
                }
                let body = match parsed_body() {
                    Ok(value) => value,
                    Err(error) => return bad_request(error),
                };
                if body.get("worker_id").and_then(Value::as_str) != Some(principal.subject.as_str())
                {
                    return forbidden();
                }
                match authority.receive_claim(principal, &body) {
                    Ok(Some(claim)) if claim.is_object() => {
                        return HttpResponse::json(200, json!({"claim":claim}));
                    }
                    Ok(Some(_)) => {
                        return HttpResponse::error(
                            500,
                            "worker authority returned a non-object claim",
                        );
                    }
                    Ok(None) => {
                        return HttpResponse {
                            status: 204,
                            body: Vec::new(),
                        };
                    }
                    Err(error) => return worker_control_error(error),
                }
            }
            ("POST", "/v1/worker/claims/verify") => {
                if !authorized(principal, "worker.claim.verify") {
                    return forbidden();
                }
                let body = match parsed_body() {
                    Ok(value) => value,
                    Err(error) => return bad_request(error),
                };
                let Some(claim) = body.get("claim").filter(|value| value.is_object()) else {
                    return bad_request("claim must be an object".into());
                };
                if claim.get("worker_id").and_then(Value::as_str)
                    != Some(principal.subject.as_str())
                    || claim.get("audience").and_then(Value::as_str)
                        != Some(principal.subject.as_str())
                {
                    return forbidden();
                }
                match authority.verify_claim(principal, claim) {
                    Ok(()) => return HttpResponse::json(200, json!({"valid":true})),
                    Err(error) => return worker_control_error(error),
                }
            }
            ("POST", "/v1/worker/leases/renew") => {
                if !authorized(principal, "worker.lease.renew") {
                    return forbidden();
                }
                let body = match parsed_body() {
                    Ok(value) => value,
                    Err(error) => return bad_request(error),
                };
                let Some(claim) = body.get("claim").filter(|value| value.is_object()) else {
                    return bad_request("claim must be an object".into());
                };
                let lease_seconds = body.get("lease_seconds").and_then(Value::as_u64);
                let renewal_id = body.get("renewal_id").and_then(Value::as_str);
                if claim.get("worker_id").and_then(Value::as_str)
                    != Some(principal.subject.as_str())
                    || claim.get("audience").and_then(Value::as_str)
                        != Some(principal.subject.as_str())
                    || !(1..=600).contains(&lease_seconds.unwrap_or_default())
                    || renewal_id.is_none_or(|value| {
                        value.trim().is_empty()
                            || value.trim() != value
                            || value.len() > 256
                            || value.chars().any(char::is_control)
                    })
                {
                    return bad_request(
                        "lease renewal identity, idempotency key or TTL is invalid".into(),
                    );
                }
                authority.renew_lease(principal, &body)
            }
            ("POST", "/v1/worker/results") => {
                if !authorized(principal, "worker.result.publish") {
                    return forbidden();
                }
                let body = match parsed_body() {
                    Ok(value) => value,
                    Err(error) => return bad_request(error),
                };
                if !worker_payload_matches(&body, principal) {
                    return forbidden();
                }
                authority.publish_result(principal, &body)
            }
            ("POST", "/v1/worker/provider-results") => {
                if !authorized(principal, "worker.provider_result.publish") {
                    return forbidden();
                }
                let body = match parsed_body() {
                    Ok(value) => value,
                    Err(error) => return bad_request(error),
                };
                if !worker_payload_matches(&body, principal) {
                    return forbidden();
                }
                authority.publish_provider_result(principal, &body)
            }
            ("POST", "/v1/worker/sessions/deliver") => {
                if !authorized(principal, "worker.session.deliver") {
                    return forbidden();
                }
                let body = match parsed_body() {
                    Ok(value) => value,
                    Err(error) => return bad_request(error),
                };
                if !worker_payload_matches(&body, principal) {
                    return forbidden();
                }
                authority.deliver_session_message(principal, &body)
            }
            ("POST", "/v1/worker/execution-fences") => {
                if !authorized(principal, "worker.execution_fence.reserve") {
                    return forbidden();
                }
                let body = match parsed_body() {
                    Ok(value) => value,
                    Err(error) => return bad_request(error),
                };
                if !worker_payload_matches(&body, principal) {
                    return forbidden();
                }
                authority.reserve_execution_fence(principal, &body)
            }
            ("POST", path) if path.starts_with("/v1/worker/execution-fences/") => {
                if !authorized(principal, "worker.execution_fence.complete") {
                    return forbidden();
                }
                let segments = path.trim_matches('/').split('/').collect::<Vec<_>>();
                if segments.len() != 5
                    || segments[0] != "v1"
                    || segments[1] != "worker"
                    || segments[2] != "execution-fences"
                    || segments[4] != "complete"
                    || segments[3].is_empty()
                    || !segments[3]
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                {
                    return HttpResponse::error(404, "not found");
                }
                let body = match parsed_body() {
                    Ok(value) => value,
                    Err(error) => return bad_request(error),
                };
                if body.get("worker_id").and_then(Value::as_str) != Some(principal.subject.as_str())
                    || body.get("fence_id").and_then(Value::as_str) != Some(segments[3])
                {
                    return forbidden();
                }
                authority.complete_execution_fence(principal, segments[3], &body)
            }
            _ => return HttpResponse::error(404, "not found"),
        };
        match result {
            Ok(value) if value.is_object() => HttpResponse::json(200, value),
            Ok(_) => HttpResponse::error(500, "worker authority returned a non-object receipt"),
            Err(error) => worker_control_error(error),
        }
    }

    fn route_workflow(
        &self,
        principal: &ControlPrincipal,
        request: HttpRequest<'_>,
    ) -> HttpResponse {
        let segments = request
            .path
            .trim_matches('/')
            .split('/')
            .collect::<Vec<_>>();
        if segments.len() == 3
            && segments[0] == "v1"
            && segments[1] == "plans"
            && request.method == "GET"
        {
            if !authorized(principal, "catalog.read") {
                return forbidden();
            }
            return match self.service.get_custom_workflow_plan(segments[2]) {
                Ok(value) => HttpResponse::json(200, json!(value)),
                Err(error) => runtime_error(error),
            };
        }
        if segments.len() == 5
            && segments[0] == "v1"
            && segments[1] == "catalog"
            && segments[2] == "workflows"
            && segments[4] == "compile"
            && request.method == "POST"
        {
            if !authorized(principal, "catalog.workflow.compile") {
                return forbidden();
            }
            let Some(resolver) = self.trusted_skills.as_ref() else {
                return authority_unavailable();
            };
            let body: CompileBody = match decode_body(request.body) {
                Ok(value) => value,
                Err(error) => return bad_request(error),
            };
            return match self.service.compile_custom_workflow_with_trusted_skills(
                segments[3],
                Some(body.version),
                &principal.subject,
                resolver.as_ref(),
            ) {
                Ok(value) => HttpResponse::json(201, json!(value)),
                Err(error) => runtime_error(error),
            };
        }
        if segments.len() == 4
            && segments[0] == "v1"
            && segments[1] == "catalog"
            && request.method == "GET"
        {
            if !authorized(principal, "catalog.read") {
                return forbidden();
            }
            let version = match query_version(request.query) {
                Ok(value) => value,
                Err(error) => return bad_request(error),
            };
            return match segments[2] {
                "roles" => match self.service.get_custom_role(segments[3], version) {
                    Ok(value) => HttpResponse::json(200, json!(value)),
                    Err(error) => runtime_error(error),
                },
                "workflows" => match self.service.get_custom_workflow(segments[3], version) {
                    Ok(value) => HttpResponse::json(200, json!(value)),
                    Err(error) => runtime_error(error),
                },
                _ => HttpResponse::error(404, "not found"),
            };
        }
        if segments.len() == 4
            && segments[0] == "v1"
            && segments[1] == "catalog"
            && request.method == "PUT"
        {
            let Some(resolver) = self.trusted_skills.as_ref() else {
                return authority_unavailable();
            };
            return match segments[2] {
                "roles" => {
                    if !authorized(principal, "catalog.role.write") {
                        return forbidden();
                    }
                    let definition: CustomRoleDefinition = match decode_body(request.body) {
                        Ok(value) => value,
                        Err(error) => return bad_request(error),
                    };
                    match self.service.update_custom_role_with_trusted_skills(
                        segments[3],
                        definition,
                        &principal.subject,
                        resolver.as_ref(),
                    ) {
                        Ok(value) => HttpResponse::json(200, json!(value)),
                        Err(error) => runtime_error(error),
                    }
                }
                "workflows" => {
                    if !authorized(principal, "catalog.workflow.write") {
                        return forbidden();
                    }
                    let definition: CustomWorkflowDefinition = match decode_body(request.body) {
                        Ok(value) => value,
                        Err(error) => return bad_request(error),
                    };
                    match self.service.update_custom_workflow_with_trusted_skills(
                        segments[3],
                        definition,
                        &principal.subject,
                        resolver.as_ref(),
                    ) {
                        Ok(value) => HttpResponse::json(200, json!(value)),
                        Err(error) => runtime_error(error),
                    }
                }
                _ => HttpResponse::error(404, "not found"),
            };
        }
        if segments.len() < 3
            || segments[0] != "v1"
            || (segments[1] != "workflows" && segments[1] != "policies")
            || segments[2].is_empty()
        {
            return HttpResponse::error(404, "not found");
        }
        let workflow_id = segments[2];
        if segments.len() == 4
            && segments[0] == "v1"
            && segments[1] == "workflows"
            && segments[3] == "snapshot"
            && request.method == "GET"
        {
            if !authorized(principal, "workflow.read") {
                return forbidden();
            }
            let event_limit = match query_limit(request.query, 100) {
                Ok(value) => value as usize,
                Err(error) => return bad_request(error),
            };
            return match self
                .service
                .inspect_workflow_read_snapshot(workflow_id, event_limit)
            {
                Ok(value) => HttpResponse::json(200, json!(value)),
                Err(error) => runtime_error(error),
            };
        }
        if segments.len() == 3
            && segments[0] == "v1"
            && segments[1] == "policies"
            && request.method == "GET"
        {
            if !authorized(principal, "policy.read") {
                return forbidden();
            }
            let version = match query_version(request.query) {
                Ok(value) => value,
                Err(error) => return bad_request(error),
            };
            return match self.service.get_workflow_policy(workflow_id, version) {
                Ok(value) => HttpResponse::json(200, json!(value)),
                Err(error) => runtime_error(error),
            };
        }
        if segments.len() == 3
            && segments[0] == "v1"
            && segments[1] == "policies"
            && request.method == "PUT"
        {
            if !authorized(principal, "policy.write") {
                return forbidden();
            }
            let definition: WorkflowPolicyDefinition = match decode_body(request.body) {
                Ok(value) => value,
                Err(error) => return bad_request(error),
            };
            return match self.service.update_workflow_policy(
                segments[2],
                definition,
                &principal.subject,
            ) {
                Ok(value) => HttpResponse::json(200, json!(value)),
                Err(error) => runtime_error(error),
            };
        }
        if segments.len() == 4
            && segments[0] == "v1"
            && segments[1] == "workflows"
            && segments[3] == "success-contract"
            && request.method == "GET"
        {
            if !authorized(principal, "workflow.read") {
                return forbidden();
            }
            return match self.service.get_workflow_success_contract(segments[2]) {
                Ok(value) => HttpResponse::json(200, json!({"contract":value})),
                Err(error) => runtime_error(error),
            };
        }
        if segments.len() == 5
            && segments[0] == "v1"
            && segments[1] == "workflows"
            && segments[3] == "policies"
            && request.method == "POST"
        {
            if !authorized(principal, "policy.attach") {
                return forbidden();
            }
            let body: PolicyAttachmentBody = match decode_body(request.body) {
                Ok(value) => value,
                Err(error) => return bad_request(error),
            };
            return match self.service.attach_workflow_policy(
                segments[2],
                segments[4],
                Some(body.version),
                body.base_contract,
                &principal.subject,
            ) {
                Ok(value) => HttpResponse::json(201, json!(value)),
                Err(error) => runtime_error(error),
            };
        }
        if segments.len() == 4 && segments[3] == "events" && request.method == "GET" {
            if !authorized(principal, "workflow.read") {
                return forbidden();
            }
            return match self.service.list_workflow_events(
                workflow_id,
                match query_limit(request.query, 100) {
                    Ok(value) => value as usize,
                    Err(error) => return bad_request(error),
                },
            ) {
                Ok(value) => HttpResponse::json(200, json!({"items":value})),
                Err(error) => runtime_error(error),
            };
        }
        if segments.len() == 3 && request.method == "GET" {
            if !authorized(principal, "workflow.read") {
                return forbidden();
            }
            return match self.service.get_workflow(workflow_id) {
                Ok(value) => HttpResponse::json(200, json!(value)),
                Err(error) => runtime_error(error),
            };
        }
        if segments.len() == 4 {
            match (request.method, segments[3]) {
                ("POST", "approve") => {
                    if !authorized(principal, "workflow.approve") {
                        return forbidden();
                    }
                    let body: ApprovalBody = match decode_body(request.body) {
                        Ok(value) => value,
                        Err(error) => return bad_request(error),
                    };
                    return match self.service.approve(
                        workflow_id,
                        ApprovalRequest {
                            actor: principal.subject.clone(),
                            expected_proposal_hash: body.expected_proposal_hash,
                            expected_plan_hash: body.expected_plan_hash,
                            evidence: body.evidence,
                        },
                    ) {
                        Ok(value) => HttpResponse::json(200, json!(value)),
                        Err(error) => runtime_error(error),
                    };
                }
                ("POST", "admit") => {
                    if !authorized(principal, "workflow.admit") {
                        return forbidden();
                    }
                    return match self.service.admit_workflow(workflow_id) {
                        Ok(value) => HttpResponse::json(200, json!(value)),
                        Err(error) => runtime_error(error),
                    };
                }
                ("POST", "synthesize") => {
                    if !authorized(principal, "workflow.synthesize") {
                        return forbidden();
                    }
                    return match self.service.synthesize_workflow(workflow_id) {
                        Ok(value) => HttpResponse::json(200, value),
                        Err(error) => runtime_error(error),
                    };
                }
                ("POST", "cancel") => {
                    if !authorized(principal, "workflow.cancel") {
                        return forbidden();
                    }
                    let body: CancelBody = match decode_body(request.body) {
                        Ok(value) => value,
                        Err(error) => return bad_request(error),
                    };
                    return match self.service.cancel_workflow(
                        workflow_id,
                        WorkflowCancellationRequest {
                            actor: principal.subject.clone(),
                            reason: body.reason,
                        },
                        self.cancellations.as_ref(),
                    ) {
                        Ok(value) => HttpResponse::json(200, json!(value)),
                        Err(error) => runtime_error(error),
                    };
                }
                _ => {}
            }
        }
        if segments.len() == 5 && segments[3] == "tasks" && request.method == "GET" {
            if !authorized(principal, "workflow.read") {
                return forbidden();
            }
            return match self.service.inspect_task_attempt(workflow_id, segments[4]) {
                Ok(value) => HttpResponse::json(200, json!(value)),
                Err(error) => runtime_error(error),
            };
        }
        if segments.len() == 6
            && segments[3] == "tasks"
            && segments[5] == "recovery"
            && request.method == "GET"
        {
            if !authorized(principal, "workflow.recovery.read") {
                return forbidden();
            }
            return match self.service.inspect_task_attempt(workflow_id, segments[4]) {
                Ok(value) => HttpResponse::json(
                    200,
                    json!({"observation":value,"disposition":"UNRESOLVED","authority":"host_runtime_inventory_required","mutated":false}),
                ),
                Err(error) => runtime_error(error),
            };
        }
        if segments.len() == 6
            && segments[3] == "tasks"
            && segments[5] == "result"
            && request.method == "POST"
        {
            if !authorized(principal, "workflow.result.ingest") {
                return forbidden();
            }
            let body: ResultEnvelopeBody = match decode_body(request.body) {
                Ok(value) => value,
                Err(error) => return bad_request(error),
            };
            let envelope = TaskResultEnvelope {
                event_id: body.event_id,
                producer_id: body.producer_id,
                payload_sha256: body.payload_sha256,
                request: TaskResultRequest {
                    lease_id: body.request.lease_id,
                    worker_id: body.request.worker_id,
                    attempt: body.request.attempt,
                    outcome: body.request.outcome,
                    evidence: body.request.evidence,
                    error: body.request.error,
                },
            };
            return match self.service.record_task_result_envelope(
                workflow_id,
                segments[4],
                envelope,
                self.results.as_ref(),
            ) {
                Ok(value) => HttpResponse::json(200, json!(value)),
                Err(error) => runtime_error(error),
            };
        }
        HttpResponse::error(404, "not found")
    }
}

/// Minimal bounded HTTP request view. Header parsing is performed by `serve`.
pub struct HttpRequest<'a> {
    /// HTTP method.
    pub method: &'a str,
    /// URL path without query.
    pub path: &'a str,
    /// Raw query string.
    pub query: &'a str,
    /// Case-insensitive request headers.
    pub headers: &'a [(String, String)],
    /// Request JSON body bytes.
    pub body: &'a [u8],
}

impl HttpRequest<'_> {
    fn bearer_token(&self) -> Result<&str, ControlApiError> {
        let mut values = self
            .headers
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case("authorization"));
        let value = values
            .next()
            .map(|(_, value)| value.as_str())
            .ok_or(ControlApiError::Authentication)?;
        if values.next().is_some() {
            return Err(ControlApiError::Authentication);
        }
        let (scheme, token) = value
            .split_once(' ')
            .ok_or(ControlApiError::Authentication)?;
        if !scheme.eq_ignore_ascii_case("Bearer")
            || token.is_empty()
            || token.len() > 8192
            || token
                .bytes()
                .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
        {
            return Err(ControlApiError::Authentication);
        }
        Ok(token)
    }
}

/// HTTP response emitted by the Control API.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    /// HTTP status.
    pub status: u16,
    /// JSON response body.
    pub body: Vec<u8>,
}

impl HttpResponse {
    fn json(status: u16, value: Value) -> Self {
        Self {
            status,
            body: serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec()),
        }
    }
    fn error(status: u16, message: &str) -> Self {
        Self::json(status, json!({"error":message}))
    }
}

/// Serve HTTP requests until listener failure or host shutdown. Each connection
/// handles one request; body/header sizes and socket timeouts are bounded.
pub fn serve(listener: TcpListener, api: Arc<ControlApi>) -> Result<(), ControlApiError> {
    serve_until(listener, api, Arc::new(AtomicBool::new(false)))
}

/// Bounded HTTP server with cooperative graceful shutdown. At most eight
/// connections execute concurrently and at most 64 wait in the accept queue.
pub fn serve_until(
    listener: TcpListener,
    api: Arc<ControlApi>,
    shutdown: Arc<AtomicBool>,
) -> Result<(), ControlApiError> {
    if !listener.local_addr()?.ip().is_loopback() {
        return Err(ControlApiError::InsecureBind);
    }
    listener.set_nonblocking(true)?;
    let (sender, receiver) = mpsc::sync_channel::<TcpStream>(64);
    let receiver = Arc::new(Mutex::new(receiver));
    let mut workers = Vec::with_capacity(8);
    for _ in 0..8 {
        let receiver = receiver.clone();
        let api = api.clone();
        let shutdown = shutdown.clone();
        workers.push(std::thread::spawn(move || {
            loop {
                let next = receiver
                    .lock()
                    .map(|rx| rx.recv_timeout(Duration::from_millis(100)));
                match next {
                    Ok(Ok(stream)) => {
                        let _ = serve_one(stream, &api);
                    }
                    Ok(Err(RecvTimeoutError::Timeout)) if shutdown.load(Ordering::Acquire) => break,
                    Ok(Err(RecvTimeoutError::Timeout)) => continue,
                    Ok(Err(RecvTimeoutError::Disconnected)) | Err(_) => break,
                }
            }
        }));
    }
    while !shutdown.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => match sender.try_send(stream) {
                Ok(()) => {}
                Err(TrySendError::Full(mut stream)) => {
                    let _ = write_response(
                        &mut stream,
                        HttpResponse::error(503, "Control API is busy"),
                    );
                }
                Err(TrySendError::Disconnected(_)) => break,
            },
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                drop(sender);
                for worker in workers {
                    let _ = worker.join();
                }
                return Err(error.into());
            }
        }
    }
    drop(sender);
    for worker in workers {
        let _ = worker.join();
    }
    Ok(())
}

/// Explicit handoff boundary to a Part 2 worker host. Implementations must perform
/// only a bounded durable enqueue/acceptance operation and return promptly; this
/// crate never implements provider dispatch or task execution. A handoff error
/// leaves the durable lease untouched and stops the loop; it is never retried.
pub trait ExecutionWorker: Send + Sync {
    /// Accept one already-persisted fenced claim. Implementations must not fabricate
    /// a result and must report ambiguous handoff as an error, not a retry signal.
    fn accept_claim(&self, lease: runalith_runtime::TaskLease) -> Result<(), String>;
}

/// Continuous bounded scheduler over the Store's atomic coordinator claim.
pub struct CoordinatorLoop {
    service: Arc<WorkflowService>,
    request: CoordinatorRequest,
    maximum_claims_per_tick: usize,
    tick_interval: Duration,
}

impl CoordinatorLoop {
    /// Configure bounded scheduling. `request` ceilings are rechecked by Store
    /// on every claim; a tick never exceeds `maximum_claims_per_tick` claims.
    pub fn new(
        service: Arc<WorkflowService>,
        request: CoordinatorRequest,
        maximum_claims_per_tick: usize,
        tick_interval: Duration,
    ) -> Result<Self, CoordinatorLoopError> {
        if !(1..=100).contains(&maximum_claims_per_tick)
            || tick_interval < Duration::from_millis(10)
            || tick_interval > Duration::from_secs(60)
            || request.worker_id.trim().is_empty()
            || !(1..=600).contains(&request.lease_ttl_seconds)
            || request.max_parallel == 0
            || request.max_parallel_per_workflow == 0
        {
            return Err(CoordinatorLoopError::InvalidConfiguration);
        }
        Ok(Self {
            service,
            request,
            maximum_claims_per_tick,
            tick_interval,
        })
    }

    /// Run until cooperative shutdown or the first authority/storage/handoff error.
    /// No ambiguous lease is replayed, retried, revoked, or terminalized.
    pub fn run(
        &self,
        shutdown: &AtomicBool,
        verifier: &dyn CoordinatorWorkerVerifier,
        worker: &dyn ExecutionWorker,
    ) -> Result<(), CoordinatorLoopError> {
        while !shutdown.load(Ordering::Acquire) {
            for _ in 0..self.maximum_claims_per_tick {
                if shutdown.load(Ordering::Acquire) {
                    return Ok(());
                }
                let Some(lease) = self
                    .service
                    .coordinator_claim_next(self.request.clone(), verifier)?
                else {
                    break;
                };
                worker
                    .accept_claim(lease)
                    .map_err(CoordinatorLoopError::Handoff)?;
            }
            let deadline = std::time::Instant::now() + self.tick_interval;
            while !shutdown.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
                std::thread::sleep(
                    Duration::from_millis(10)
                        .min(deadline.saturating_duration_since(std::time::Instant::now())),
                );
            }
        }
        Ok(())
    }
}

/// Coordinator loop failure. A handoff failure intentionally does not alter lease state.
#[derive(Debug, Error)]
pub enum CoordinatorLoopError {
    /// Bounds or worker identity were invalid.
    #[error("coordinator loop configuration is invalid")]
    InvalidConfiguration,
    /// Store rejected claim or authority revalidation.
    #[error(transparent)]
    Runtime(#[from] RuntimeError),
    /// Worker host rejected/failed an already-persisted claim; no automatic retry occurs.
    #[error("worker handoff failed after durable claim: {0}")]
    Handoff(String),
}

fn serve_one(mut stream: TcpStream, api: &ControlApi) -> Result<(), ControlApiError> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 4096];
    let header_end = loop {
        if bytes.len() > MAX_HEADER_BYTES {
            return write_response(&mut stream, HttpResponse::error(431, "headers too large"));
        }
        let count = stream.read(&mut chunk)?;
        if count == 0 {
            return Ok(());
        }
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    if header_end > MAX_HEADER_BYTES {
        return write_response(&mut stream, HttpResponse::error(431, "headers too large"));
    }
    let header = match std::str::from_utf8(&bytes[..header_end]) {
        Ok(value) => value,
        Err(_) => {
            return write_response(
                &mut stream,
                HttpResponse::error(400, "request headers must be valid UTF-8"),
            );
        }
    };
    let mut lines = header.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split(' ');
    let Some(method) = first.next().map(str::to_owned) else {
        return write_response(
            &mut stream,
            HttpResponse::error(400, "invalid request line"),
        );
    };
    let Some(target) = first.next().map(str::to_owned) else {
        return write_response(
            &mut stream,
            HttpResponse::error(400, "invalid request line"),
        );
    };
    if method.is_empty()
        || target.is_empty()
        || first.next() != Some("HTTP/1.1")
        || first.next().is_some()
        || !method.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
        || !target.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
        || !target.starts_with('/')
        || target.starts_with("//")
        || target.len() > 8192
    {
        return write_response(
            &mut stream,
            HttpResponse::error(400, "invalid request line"),
        );
    }
    let mut headers = Vec::new();
    let mut content_length = 0_usize;
    let mut saw_content_length = false;
    let mut saw_host = false;
    let mut saw_content_type = false;
    let mut content_type = None;
    for line in lines.filter(|line| !line.is_empty()) {
        let Some((name, value)) = line.split_once(':') else {
            return write_response(&mut stream, HttpResponse::error(400, "invalid header"));
        };
        if name.is_empty()
            || !name.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(
                        byte,
                        b'!' | b'#'
                            | b'$'
                            | b'%'
                            | b'&'
                            | b'\''
                            | b'*'
                            | b'+'
                            | b'-'
                            | b'.'
                            | b'^'
                            | b'_'
                            | b'`'
                            | b'|'
                            | b'~'
                    )
            })
            || value
                .bytes()
                .any(|byte| byte.is_ascii_control() && byte != b'\t')
        {
            return write_response(
                &mut stream,
                HttpResponse::error(400, "invalid header name or value"),
            );
        }
        if name.eq_ignore_ascii_case("content-length") {
            if saw_content_length {
                return write_response(
                    &mut stream,
                    HttpResponse::error(400, "duplicate content length"),
                );
            }
            saw_content_length = true;
            let raw_length = value.trim();
            if raw_length.is_empty() || !raw_length.bytes().all(|byte| byte.is_ascii_digit()) {
                return write_response(
                    &mut stream,
                    HttpResponse::error(400, "invalid content length"),
                );
            }
            content_length = match raw_length.parse() {
                Ok(value) => value,
                Err(_) => {
                    return write_response(
                        &mut stream,
                        HttpResponse::error(400, "invalid content length"),
                    );
                }
            };
        }
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return write_response(
                &mut stream,
                HttpResponse::error(400, "transfer encoding unsupported"),
            );
        }
        if name.eq_ignore_ascii_case("host") {
            if saw_host {
                return write_response(
                    &mut stream,
                    HttpResponse::error(400, "duplicate host header"),
                );
            }
            saw_host = true;
            if value.trim().is_empty() {
                return write_response(&mut stream, HttpResponse::error(400, "empty host header"));
            }
        }
        if name.eq_ignore_ascii_case("content-type") {
            if saw_content_type {
                return write_response(
                    &mut stream,
                    HttpResponse::error(400, "duplicate content type"),
                );
            }
            saw_content_type = true;
            content_type = Some(value.trim().to_owned());
        }
        if name.eq_ignore_ascii_case("expect") {
            return write_response(
                &mut stream,
                HttpResponse::error(417, "expectation unsupported"),
            );
        }
        headers.push((name.to_owned(), value.trim().to_owned()));
    }
    if !saw_host {
        return write_response(
            &mut stream,
            HttpResponse::error(400, "host header required"),
        );
    }
    if content_length > MAX_REQUEST_BYTES {
        return write_response(&mut stream, HttpResponse::error(413, "request too large"));
    }
    if content_length > 0
        && !content_type.as_deref().is_some_and(|value| {
            value
                .split(';')
                .next()
                .is_some_and(|media| media.trim().eq_ignore_ascii_case("application/json"))
        })
    {
        return write_response(
            &mut stream,
            HttpResponse::error(415, "application/json required"),
        );
    }
    while bytes.len() - header_end < content_length {
        let count = stream.read(&mut chunk)?;
        if count == 0 {
            return write_response(&mut stream, HttpResponse::error(400, "truncated body"));
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.len() - header_end > MAX_REQUEST_BYTES {
            return write_response(&mut stream, HttpResponse::error(413, "request too large"));
        }
    }
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    let response = api.handle(HttpRequest {
        method: &method,
        path,
        query,
        headers: &headers,
        body: &bytes[header_end..header_end + content_length],
    });
    write_response(&mut stream, response)
}

fn write_response(stream: &mut TcpStream, response: HttpResponse) -> Result<(), ControlApiError> {
    let reason = match response.status {
        200 => "OK",
        201 => "Created",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        417 => "Expectation Failed",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Error",
    };
    write!(
        stream,
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\n\r\n",
        response.status,
        reason,
        response.body.len()
    )?;
    stream.write_all(&response.body)?;
    stream.flush()?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CoordinatorBody {
    lease_ttl_seconds: u64,
    max_parallel: u64,
    max_parallel_per_workflow: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApprovalBody {
    expected_proposal_hash: String,
    expected_plan_hash: String,
    evidence: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CancelBody {
    reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CompileBody {
    version: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateFromCatalogPlanBody {
    plan_id: String,
    idempotency_key: String,
    title: String,
    goal: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyAttachmentBody {
    version: u32,
    base_contract: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResultEnvelopeBody {
    event_id: String,
    producer_id: String,
    payload_sha256: String,
    request: ResultRequestBody,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResultRequestBody {
    lease_id: String,
    worker_id: String,
    attempt: u64,
    outcome: TaskOutcome,
    evidence: Vec<EvidenceRef>,
    error: Option<String>,
}

struct DuplicateKeyGuard;

struct DuplicateKeyGuardVisitor;

impl<'de> Deserialize<'de> for DuplicateKeyGuard {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_any(DuplicateKeyGuardVisitor)
    }
}

impl<'de> Visitor<'de> for DuplicateKeyGuardVisitor {
    type Value = DuplicateKeyGuard;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a JSON value with unique object keys")
    }

    fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(DuplicateKeyGuard)
    }

    fn visit_i64<E>(self, _: i64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(DuplicateKeyGuard)
    }

    fn visit_i128<E>(self, _: i128) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(DuplicateKeyGuard)
    }

    fn visit_u64<E>(self, _: u64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(DuplicateKeyGuard)
    }

    fn visit_u128<E>(self, _: u128) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(DuplicateKeyGuard)
    }

    fn visit_f64<E>(self, _: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(DuplicateKeyGuard)
    }

    fn visit_str<E>(self, _: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(DuplicateKeyGuard)
    }

    fn visit_string<E>(self, _: String) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(DuplicateKeyGuard)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(DuplicateKeyGuard)
    }

    fn visit_none<E>(self) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(DuplicateKeyGuard)
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        DuplicateKeyGuard::deserialize(deserializer)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        while sequence.next_element::<DuplicateKeyGuard>()?.is_some() {}
        Ok(DuplicateKeyGuard)
    }

    fn visit_map<A>(self, mut object: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut keys = HashSet::new();
        while let Some(key) = object.next_key::<String>()? {
            if !keys.insert(key) {
                return Err(de::Error::custom("duplicate JSON object key"));
            }
            object.next_value::<DuplicateKeyGuard>()?;
        }
        Ok(DuplicateKeyGuard)
    }
}

fn decode_body<T: for<'de> Deserialize<'de>>(body: &[u8]) -> Result<T, String> {
    if body.is_empty() {
        return Err("request body required".into());
    }
    if body.len() > MAX_REQUEST_BYTES {
        return Err("request body too large".into());
    }
    let mut guard = serde_json::Deserializer::from_slice(body);
    DuplicateKeyGuard::deserialize(&mut guard)
        .map_err(|error| format!("invalid JSON request: {error}"))?;
    guard
        .end()
        .map_err(|error| format!("invalid JSON request: {error}"))?;
    serde_json::from_slice(body).map_err(|error| format!("invalid JSON request: {error}"))
}
fn valid_principal(principal: &ControlPrincipal) -> bool {
    !principal.subject.trim().is_empty()
        && principal.subject.trim() == principal.subject
        && principal.subject.len() <= 256
        && !principal.subject.chars().any(char::is_control)
        && !principal.issuer.trim().is_empty()
        && principal.issuer.trim() == principal.issuer
        && principal.issuer.len() <= 256
        && !principal.issuer.chars().any(char::is_control)
        && principal.capabilities.len() <= 256
        && principal.capabilities.iter().all(|cap| {
            !cap.trim().is_empty()
                && cap.trim() == cap
                && cap.len() <= 128
                && !cap.chars().any(char::is_control)
        })
        && principal
            .capabilities
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            == principal.capabilities.len()
}
fn authorized(principal: &ControlPrincipal, capability: &str) -> bool {
    principal.capabilities.iter().any(|item| item == capability)
}
fn worker_payload_matches(value: &Value, principal: &ControlPrincipal) -> bool {
    value.is_object()
        && value.get("worker_id").and_then(Value::as_str) == Some(principal.subject.as_str())
}
fn query_limit(query: &str, default: u64) -> Result<u64, String> {
    let mut limit = None;
    for part in query.split('&') {
        if let Some(value) = part.strip_prefix("limit=") {
            if limit.is_some() {
                return Err("duplicate limit query parameter".into());
            }
            let parsed = value
                .parse::<u64>()
                .map_err(|_| "limit query parameter must be a positive integer".to_owned())?;
            if !(1..=500).contains(&parsed) {
                return Err("limit query parameter must be between 1 and 500".into());
            }
            limit = Some(parsed);
        }
    }
    Ok(limit.unwrap_or(default))
}
fn query_version(query: &str) -> Result<Option<u32>, String> {
    let mut version = None;
    for part in query.split('&') {
        if let Some(value) = part.strip_prefix("version=") {
            if version.is_some() {
                return Err("duplicate version query parameter".into());
            }
            let parsed = value
                .parse::<u32>()
                .map_err(|_| "version query parameter must be a positive integer".to_owned())?;
            if parsed == 0 {
                return Err("version query parameter must be positive".into());
            }
            version = Some(parsed);
        }
    }
    Ok(version)
}
fn forbidden() -> HttpResponse {
    HttpResponse::error(403, "forbidden")
}
fn authority_unavailable() -> HttpResponse {
    HttpResponse::error(503, "host trusted-skill authority is not configured")
}
fn worker_control_error(error: WorkerControlError) -> HttpResponse {
    match error {
        WorkerControlError::Unauthorized(message) => HttpResponse::error(403, &message),
        WorkerControlError::Conflict(message) => HttpResponse::error(409, &message),
        WorkerControlError::Unavailable(message) => HttpResponse::error(503, &message),
        WorkerControlError::Invalid(message) => HttpResponse::error(400, &message),
        WorkerControlError::Internal(message) => HttpResponse::error(500, &message),
    }
}
fn bad_request(message: String) -> HttpResponse {
    HttpResponse::error(400, &message)
}
fn runtime_error(error: RuntimeError) -> HttpResponse {
    let message = error.to_string();
    let status = match error {
        RuntimeError::ApprovalAuthorityUnavailable => 503,
        RuntimeError::ApprovalRequired => 409,
        RuntimeError::ApprovalBindingMismatch | RuntimeError::InvalidVerifierOutput => 409,
        RuntimeError::InvalidWorker | RuntimeError::InvalidLeaseTtl => 400,
        RuntimeError::Store(_) | RuntimeError::Invariant(_) => 409,
    };
    HttpResponse::error(status, &message)
}

/// Control API failures. Authority and malformed requests are explicit.
#[derive(Debug, Error)]
pub enum ControlApiError {
    /// Host authentication failed.
    #[error("authentication failed")]
    Authentication,
    /// HTTP request framing was malformed.
    #[error("malformed HTTP request")]
    MalformedRequest,
    /// Plain HTTP listener must remain loopback-only; terminate TLS at a trusted proxy.
    #[error("Control API plain HTTP listener must bind to loopback")]
    InsecureBind,
    /// Durable Store could not be opened.
    #[error(transparent)]
    Store(#[from] runalith_runtime::StoreError),
    /// I/O failure.
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// Explicit deny-all approval verifier for unconfigured standalone hosts.
/// It intentionally cannot approve, admit, or claim protected work.
pub fn deny_all_approval_verifier() -> Arc<dyn ApprovalVerifier> {
    Arc::new(DenyAllApprovalVerifier)
}

#[cfg(test)]
mod tests {
    use super::*;
    use runalith_runtime::ClaimRequest;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Auth {
        calls: AtomicUsize,
        capabilities: Vec<String>,
    }
    struct WorkerAuth {
        subject: String,
        capabilities: Vec<String>,
    }
    impl ControlPrincipalVerifier for WorkerAuth {
        fn authenticate(&self, credential: &str) -> Result<ControlPrincipal, ControlApiError> {
            if credential != "worker-test-token" {
                return Err(ControlApiError::Authentication);
            }
            Ok(ControlPrincipal {
                subject: self.subject.clone(),
                issuer: "test-worker-host".into(),
                capabilities: self.capabilities.clone(),
            })
        }
    }

    struct FakeWorkerAuthority {
        calls: AtomicUsize,
    }
    impl FakeWorkerAuthority {
        fn call(&self) {
            self.calls.fetch_add(1, Ordering::SeqCst);
        }
    }
    impl WorkerControlAuthority for FakeWorkerAuthority {
        fn receive_claim(
            &self,
            principal: &ControlPrincipal,
            _: &Value,
        ) -> Result<Option<Value>, WorkerControlError> {
            self.call();
            Ok(Some(
                json!({"claim_id":"claim-01","worker_id":principal.subject}),
            ))
        }
        fn verify_claim(&self, _: &ControlPrincipal, _: &Value) -> Result<(), WorkerControlError> {
            self.call();
            Ok(())
        }
        fn renew_lease(
            &self,
            _: &ControlPrincipal,
            _: &Value,
        ) -> Result<Value, WorkerControlError> {
            self.call();
            Ok(
                json!({"lease_id":"lease-01","worker_id":"worker-01","owner_epoch":7,"expires_at":"2026-11-02T15:00:00Z"}),
            )
        }
        fn publish_result(
            &self,
            _: &ControlPrincipal,
            _: &Value,
        ) -> Result<Value, WorkerControlError> {
            self.call();
            Ok(
                json!({"event_id":"event-01","event_sha256":"a".repeat(64),"receipt":{"durable":true}}),
            )
        }
        fn publish_provider_result(
            &self,
            _: &ControlPrincipal,
            _: &Value,
        ) -> Result<Value, WorkerControlError> {
            self.call();
            Ok(
                json!({"event_id":"provider-event-01","event_sha256":"b".repeat(64),"receipt":{"durable":true}}),
            )
        }
        fn deliver_session_message(
            &self,
            _: &ControlPrincipal,
            _: &Value,
        ) -> Result<Value, WorkerControlError> {
            self.call();
            Ok(
                json!({"message_id":"message-01","session_id":"session-01","lease_id":"lease-01","owner_epoch":7,"receipt":{"delivery_id":"delivery-01"}}),
            )
        }
        fn reserve_execution_fence(
            &self,
            _: &ControlPrincipal,
            request: &Value,
        ) -> Result<Value, WorkerControlError> {
            self.call();
            let mut response = request.clone();
            response["fence_id"] = json!("fence-01");
            response["state"] = json!("RESERVED");
            response["receipt"] = json!({"reservation_id":"fence-01"});
            Ok(response)
        }
        fn complete_execution_fence(
            &self,
            _: &ControlPrincipal,
            fence_id: &str,
            completion: &Value,
        ) -> Result<Value, WorkerControlError> {
            self.call();
            if completion.get("fence_id").and_then(Value::as_str) != Some(fence_id) {
                return Err(WorkerControlError::Conflict("fence id mismatch".into()));
            }
            let mut response = completion.clone();
            response["receipt"] = json!({"completed":true});
            Ok(response)
        }
    }
    impl ControlPrincipalVerifier for Auth {
        fn authenticate(&self, credential: &str) -> Result<ControlPrincipal, ControlApiError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if credential != "opaque-test-token" {
                return Err(ControlApiError::Authentication);
            }
            Ok(ControlPrincipal {
                subject: "host:operator".into(),
                issuer: "test-host".into(),
                capabilities: self.capabilities.clone(),
            })
        }
    }
    struct DenyWorker;
    impl CoordinatorWorkerVerifier for DenyWorker {
        fn authenticate_worker(
            &self,
            _: &runalith_runtime::Transaction<'_>,
            _: &str,
        ) -> Result<String, runalith_runtime::StoreError> {
            Err(runalith_runtime::StoreError::ApprovalAuthorityUnavailable)
        }
    }
    struct DenyResult;
    impl TaskResultProducerVerifier for DenyResult {
        fn authenticate_producer(
            &self,
            _: &runalith_runtime::Transaction<'_>,
            _: &str,
            _: &str,
            _: &runalith_runtime::TaskResultRequest,
        ) -> Result<String, runalith_runtime::StoreError> {
            Err(runalith_runtime::StoreError::ApprovalAuthorityUnavailable)
        }
    }
    struct DenyCancel;
    impl WorkflowCancellationVerifier for DenyCancel {
        fn verify_cancel(
            &self,
            _: &runalith_runtime::Transaction<'_>,
            _: &runalith_runtime::WorkflowView,
            _: &str,
            _: &str,
        ) -> Result<String, runalith_runtime::StoreError> {
            Err(runalith_runtime::StoreError::ApprovalAuthorityUnavailable)
        }
    }
    struct AllowCancel;
    impl WorkflowCancellationVerifier for AllowCancel {
        fn verify_cancel(
            &self,
            _: &runalith_runtime::Transaction<'_>,
            _: &runalith_runtime::WorkflowView,
            asserted_actor: &str,
            _: &str,
        ) -> Result<String, runalith_runtime::StoreError> {
            if asserted_actor == "host:operator" {
                Ok(asserted_actor.to_owned())
            } else {
                Err(runalith_runtime::StoreError::ApprovalAuthorityUnavailable)
            }
        }
    }
    fn api_with_store(
        capabilities: Vec<&str>,
        cancellations: Arc<dyn WorkflowCancellationVerifier>,
    ) -> (ControlApi, Arc<Auth>, Arc<Store>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("control.db");
        let store = Arc::new(Store::create_new(&path).unwrap());
        let auth = Arc::new(Auth {
            calls: AtomicUsize::new(0),
            capabilities: capabilities.into_iter().map(str::to_owned).collect(),
        });
        let api = ControlApi::from_store(
            store.clone(),
            deny_all_approval_verifier(),
            auth.clone(),
            Arc::new(DenyWorker),
            Arc::new(DenyResult),
            cancellations,
        );
        (api, auth, store, dir)
    }
    fn api(capabilities: Vec<&str>) -> (ControlApi, Arc<Auth>, tempfile::TempDir) {
        let (api, auth, _, dir) = api_with_store(capabilities, Arc::new(DenyCancel));
        (api, auth, dir)
    }

    fn worker_api(
        subject: &str,
        capabilities: Vec<&str>,
        authority: Option<Arc<FakeWorkerAuthority>>,
    ) -> (ControlApi, Arc<FakeWorkerAuthority>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::create_new(dir.path().join("worker-control.db")).unwrap());
        let backend = authority.unwrap_or_else(|| {
            Arc::new(FakeWorkerAuthority {
                calls: AtomicUsize::new(0),
            })
        });
        let auth = Arc::new(WorkerAuth {
            subject: subject.into(),
            capabilities: capabilities.into_iter().map(str::to_owned).collect(),
        });
        let api = ControlApi::from_store(
            store,
            deny_all_approval_verifier(),
            auth,
            Arc::new(DenyWorker),
            Arc::new(DenyResult),
            Arc::new(DenyCancel),
        )
        .with_worker_control_authority(backend.clone());
        (api, backend, dir)
    }

    fn worker_request_with_headers<'a>(
        method: &'a str,
        path: &'a str,
        headers: &'a [(String, String)],
        body: &'a [u8],
    ) -> HttpRequest<'a> {
        HttpRequest {
            method,
            path,
            query: "",
            headers,
            body,
        }
    }
    fn request<'a>(
        method: &'a str,
        path: &'a str,
        headers: &'a [(String, String)],
        body: &'a [u8],
    ) -> HttpRequest<'a> {
        HttpRequest {
            method,
            path,
            query: "",
            headers,
            body,
        }
    }
    #[test]
    fn api_authenticates_every_request_and_denies_missing_or_invalid_credentials() {
        let (api, auth, _dir) = api(vec!["control.health.read"]);
        assert_eq!(api.handle(request("GET", "/health", &[], &[])).status, 401);
        let invalid = vec![("Authorization".into(), "Bearer wrong".into())];
        assert_eq!(
            api.handle(request("GET", "/health", &invalid, &[])).status,
            401
        );
        let valid = vec![("Authorization".into(), "Bearer opaque-test-token".into())];
        assert_eq!(
            api.handle(request("GET", "/health", &valid, &[])).status,
            200
        );
        assert_eq!(auth.calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn liveness_and_readiness_probes_are_minimal_and_do_not_require_bearer_auth() {
        let (api, auth, _dir) = api(vec![]);
        assert_eq!(api.handle(request("GET", "/livez", &[], &[])).status, 200);
        let ready = api.handle(request("GET", "/readyz", &[], &[]));
        assert_eq!(ready.status, 200);
        let value: Value = serde_json::from_slice(&ready.body).unwrap();
        assert_eq!(value["status"], "ready");
        assert_eq!(value["store_schema_version"], Store::CURRENT_SCHEMA_VERSION);
        assert_eq!(auth.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn worker_routes_fail_closed_when_authoritative_backend_is_not_configured() {
        let (api, _, _dir) = api(vec!["worker.claim.receive"]);
        let headers = vec![("Authorization".into(), "Bearer opaque-test-token".into())];
        let response = api.handle(request(
            "POST",
            "/v1/worker/claims/receive",
            &headers,
            br#"{"worker_id":"host:operator"}"#,
        ));
        assert_eq!(response.status, 503);
        let body: Value = serde_json::from_slice(&response.body).unwrap();
        assert_eq!(
            body["error"],
            "authoritative worker-control backend is not configured"
        );
    }

    #[test]
    fn worker_claim_routes_bind_authenticated_subject_and_capabilities() {
        let (api, authority, _dir) = worker_api(
            "worker-01",
            vec![
                "worker.claim.receive",
                "worker.claim.verify",
                "worker.lease.renew",
            ],
            None,
        );
        let headers = vec![("Authorization".into(), "Bearer worker-test-token".into())];
        let received = api.handle(worker_request_with_headers(
            "POST",
            "/v1/worker/claims/receive",
            &headers,
            br#"{"worker_id":"worker-01"}"#,
        ));
        assert_eq!(received.status, 200);
        let received_body: Value = serde_json::from_slice(&received.body).unwrap();
        assert_eq!(received_body["claim"]["claim_id"], "claim-01");
        assert_eq!(received_body["claim"]["worker_id"], "worker-01");

        let wrong_worker = api.handle(worker_request_with_headers(
            "POST",
            "/v1/worker/claims/receive",
            &headers,
            br#"{"worker_id":"worker-02"}"#,
        ));
        assert_eq!(wrong_worker.status, 403);

        let valid_claim = api.handle(worker_request_with_headers(
            "POST",
            "/v1/worker/claims/verify",
            &headers,
            br#"{"claim":{"worker_id":"worker-01","audience":"worker-01"}}"#,
        ));
        assert_eq!(valid_claim.status, 200);
        assert_eq!(
            serde_json::from_slice::<Value>(&valid_claim.body).unwrap()["valid"],
            true
        );

        let wrong_audience = api.handle(worker_request_with_headers(
            "POST",
            "/v1/worker/claims/verify",
            &headers,
            br#"{"claim":{"worker_id":"worker-01","audience":"worker-02"}}"#,
        ));
        assert_eq!(wrong_audience.status, 403);

        let missing_renewal_id = api.handle(worker_request_with_headers(
            "POST",
            "/v1/worker/leases/renew",
            &headers,
            br#"{"claim":{"worker_id":"worker-01","audience":"worker-01"},"lease_seconds":120}"#,
        ));
        assert_eq!(missing_renewal_id.status, 400);
        assert_eq!(authority.calls.load(Ordering::SeqCst), 2);

        let renewed = api.handle(worker_request_with_headers(
            "POST",
            "/v1/worker/leases/renew",
            &headers,
            br#"{"renewal_id":"renewal-route-01","claim":{"worker_id":"worker-01","audience":"worker-01"},"lease_seconds":120}"#,
        ));
        assert_eq!(renewed.status, 200);
        assert_eq!(authority.calls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn worker_execution_fence_completion_path_must_match_body_and_worker_identity() {
        let (api, authority, _dir) = worker_api(
            "worker-01",
            vec![
                "worker.execution_fence.reserve",
                "worker.execution_fence.complete",
            ],
            None,
        );
        let headers = vec![("Authorization".into(), "Bearer worker-test-token".into())];
        let reservation = json!({
            "claim_id":"claim-01",
            "lease_id":"lease-01",
            "worker_id":"worker-01",
            "owner_epoch":7,
            "plan_sha256":"a".repeat(64),
            "side_effect_id":"provider-intent-01",
            "kind":"provider_dispatch",
            "request_sha256":"b".repeat(64),
            "idempotency_key":"fence-idem-01",
            "acl_sha256":"c".repeat(64)
        });
        let response = api.handle(worker_request_with_headers(
            "POST",
            "/v1/worker/execution-fences",
            &headers,
            &serde_json::to_vec(&reservation).unwrap(),
        ));
        assert_eq!(response.status, 200);
        assert_eq!(
            serde_json::from_slice::<Value>(&response.body).unwrap()["state"],
            "RESERVED"
        );

        let completion = json!({
            "fence_id":"fence-01",
            "claim_id":"claim-01",
            "lease_id":"lease-01",
            "worker_id":"worker-01",
            "owner_epoch":7,
            "plan_sha256":"a".repeat(64),
            "side_effect_id":"provider-intent-01",
            "request_sha256":"b".repeat(64),
            "outcome":"UNKNOWN",
            "event_id":"provider-dispatch:provider-intent-01",
            "event_sha256":"d".repeat(64),
            "outcome_sha256":"e".repeat(64)
        });
        let completed = api.handle(worker_request_with_headers(
            "POST",
            "/v1/worker/execution-fences/fence-01/complete",
            &headers,
            &serde_json::to_vec(&completion).unwrap(),
        ));
        assert_eq!(completed.status, 200);
        assert_eq!(
            serde_json::from_slice::<Value>(&completed.body).unwrap()["receipt"]["completed"],
            true
        );

        let mismatched_path = api.handle(worker_request_with_headers(
            "POST",
            "/v1/worker/execution-fences/fence-02/complete",
            &headers,
            &serde_json::to_vec(&completion).unwrap(),
        ));
        assert_eq!(mismatched_path.status, 403);
        assert_eq!(authority.calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn bearer_scheme_is_case_insensitive_but_credentials_reject_whitespace() {
        let (api, auth, _dir) = api(vec!["control.health.read"]);
        for scheme in ["Bearer", "bearer", "BEARER", "bEaReR"] {
            let headers = vec![(
                "Authorization".into(),
                format!("{scheme} opaque-test-token"),
            )];
            assert_eq!(
                api.handle(request("GET", "/health", &headers, &[])).status,
                200
            );
        }
        for value in [
            "Bearer ",
            "Bearer token with-space",
            "Bearer token\tvalue",
            "Basic opaque-test-token",
        ] {
            let headers = vec![("Authorization".into(), value.into())];
            assert_eq!(
                api.handle(request("GET", "/health", &headers, &[])).status,
                401
            );
        }
        assert_eq!(auth.calls.load(Ordering::SeqCst), 4);
    }
    #[test]
    fn api_enforces_capabilities_before_touching_workflow_service() {
        let (api, _, _dir) = api(vec!["control.health.read"]);
        let valid = vec![("Authorization".into(), "Bearer opaque-test-token".into())];
        assert_eq!(
            api.handle(request("GET", "/v1/workflows", &valid, &[]))
                .status,
            403
        );
        assert_eq!(
            api.handle(request("POST", "/v1/workflows", &valid, br#"{}"#))
                .status,
            403
        );
        assert_eq!(
            api.handle(request("GET", "/v1/workflows/job_missing", &valid, &[]))
                .status,
            403
        );
    }
    #[test]
    fn api_rejects_oversized_and_unknown_json_fields() {
        let (api, _, _dir) = api(vec!["workflow.create"]);
        let valid = vec![("Authorization".into(), "Bearer opaque-test-token".into())];
        let response = api.handle(request(
            "POST",
            "/v1/workflows",
            &valid,
            br#"{"unexpected":true}"#,
        ));
        assert_eq!(response.status, 400);

        let oversized = vec![b' '; MAX_REQUEST_BYTES + 1];
        let response = api.handle(request("POST", "/v1/workflows", &valid, &oversized));
        assert_eq!(response.status, 400);
    }

    #[test]
    fn api_fails_closed_without_trusted_skill_authority_and_does_not_create_database() {
        let (api, _, _dir) = api(vec!["catalog.role.write"]);
        let valid = vec![("Authorization".into(), "Bearer opaque-test-token".into())];
        assert_eq!(
            api.handle(request("POST", "/v1/catalog/roles", &valid, b"{}"))
                .status,
            503
        );

        let missing_dir = tempfile::tempdir().unwrap();
        let missing = missing_dir.path().join("must-not-create.db");
        let result = ControlApi::open_existing(
            &missing,
            deny_all_approval_verifier(),
            Arc::new(Auth {
                calls: AtomicUsize::new(0),
                capabilities: vec![],
            }),
            Arc::new(DenyWorker),
            Arc::new(DenyResult),
            Arc::new(DenyCancel),
        );
        assert!(result.is_err());
        assert!(!missing.exists());
    }

    #[test]
    fn exact_catalog_version_query_rejects_ambiguous_and_invalid_versions() {
        assert_eq!(query_version("version=3"), Ok(Some(3)));
        assert_eq!(query_version("limit=20"), Ok(None));
        assert!(query_version("version=0").is_err());
        assert!(query_version("version=not-a-number").is_err());
        assert!(query_version("version=2&version=3").is_err());
    }

    #[test]
    fn query_limit_rejects_duplicate_invalid_and_out_of_range_values() {
        assert_eq!(query_limit("", 100), Ok(100));
        assert_eq!(query_limit("cursor=abc&limit=25", 100), Ok(25));
        assert!(query_limit("limit=1&limit=2", 100).is_err());
        assert!(query_limit("limit=0", 100).is_err());
        assert!(query_limit("limit=501", 100).is_err());
        assert!(query_limit("limit=not-a-number", 100).is_err());
    }

    #[test]
    fn workflow_proposal_and_read_routes_use_the_persisted_runtime_service() {
        let (api, _, _dir) = api(vec!["workflow.create", "workflow.read"]);
        let valid = vec![("Authorization".into(), "Bearer opaque-test-token".into())];
        let proposal = br#"{"workflow_id":"job_control_api","title":"API workflow","goal":"exercise durable API","tasks":[{"task_id":"task-1","role":"researcher","description":"collect evidence","depends_on":[],"required_evidence":[],"inputs":{}}],"metadata":{}}"#;
        let created = api.handle(request("POST", "/v1/workflows", &valid, proposal));
        assert_eq!(
            created.status,
            201,
            "{}",
            String::from_utf8_lossy(&created.body)
        );
        let read = api.handle(request("GET", "/v1/workflows/job_control_api", &valid, &[]));
        assert_eq!(read.status, 200, "{}", String::from_utf8_lossy(&read.body));
        let value: Value = serde_json::from_slice(&read.body).unwrap();
        assert_eq!(value["workflow_id"], "job_control_api");
    }

    #[test]
    fn workflow_snapshot_route_is_capability_gated_and_returns_one_read_only_projection() {
        let (create_api, _, store, _dir) =
            api_with_store(vec!["workflow.create"], Arc::new(DenyCancel));
        let valid = vec![("Authorization".into(), "Bearer opaque-test-token".into())];
        let proposal = br#"{"workflow_id":"job_snapshot_http","title":"Snapshot API","goal":"expose one coherent read-only workflow snapshot","tasks":[{"task_id":"task-1","role":"researcher","description":"collect evidence","depends_on":[],"required_evidence":[],"inputs":{}}],"metadata":{}}"#;
        let created = create_api.handle(request("POST", "/v1/workflows", &valid, proposal));
        assert_eq!(
            created.status,
            201,
            "{}",
            String::from_utf8_lossy(&created.body)
        );

        // Creating a workflow does not silently grant the caller read access.
        let denied = create_api.handle(request(
            "GET",
            "/v1/workflows/job_snapshot_http/snapshot",
            &valid,
            &[],
        ));
        assert_eq!(denied.status, 403);

        let read_api = ControlApi::from_store(
            store.clone(),
            deny_all_approval_verifier(),
            Arc::new(Auth {
                calls: AtomicUsize::new(0),
                capabilities: vec!["workflow.read".into()],
            }),
            Arc::new(DenyWorker),
            Arc::new(DenyResult),
            Arc::new(DenyCancel),
        );
        let before = store.list_workflow_events("job_snapshot_http", 20).unwrap();
        let response = read_api.handle(request(
            "GET",
            "/v1/workflows/job_snapshot_http/snapshot",
            &valid,
            &[],
        ));
        assert_eq!(
            response.status,
            200,
            "{}",
            String::from_utf8_lossy(&response.body)
        );
        let value: Value = serde_json::from_slice(&response.body).unwrap();
        assert_eq!(value["schema_version"], 1);
        assert_eq!(value["workflow"]["workflow_id"], "job_snapshot_http");
        assert_eq!(value["workflow"]["state"], "PROPOSED");
        assert_eq!(value["task_attempts"][0]["attempt"], 0);
        assert_eq!(
            value["task_attempts"][0]["attempt_ledger"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert_eq!(value["event_chain"]["valid"], true);
        assert_eq!(value["events_truncated"], false);
        let after = store.list_workflow_events("job_snapshot_http", 20).unwrap();
        assert_eq!(after, before, "read-only snapshot must not append events");

        let invalid_limit = HttpRequest {
            method: "GET",
            path: "/v1/workflows/job_snapshot_http/snapshot",
            query: "limit=501",
            headers: &valid,
            body: &[],
        };
        assert_eq!(read_api.handle(invalid_limit).status, 400);
    }

    #[test]
    fn workflow_cancel_route_enforces_capability_and_returns_durable_request_projection() {
        let (create_api, _, store, _dir) =
            api_with_store(vec!["workflow.create"], Arc::new(DenyCancel));
        let valid = vec![("Authorization".into(), "Bearer opaque-test-token".into())];
        let proposal = br#"{"workflow_id":"job_cancel_http","title":"API cancellation","goal":"exercise authenticated cancellation route","tasks":[{"task_id":"task-1","role":"researcher","description":"collect evidence","depends_on":[],"required_evidence":[],"inputs":{}}],"metadata":{}}"#;
        let created = create_api.handle(request("POST", "/v1/workflows", &valid, proposal));
        assert_eq!(
            created.status,
            201,
            "{}",
            String::from_utf8_lossy(&created.body)
        );

        let cancellation_body = br#"{"reason":"operator requested stop"}"#;
        let denied = create_api.handle(request(
            "POST",
            "/v1/workflows/job_cancel_http/cancel",
            &valid,
            cancellation_body,
        ));
        assert_eq!(denied.status, 403);
        assert_eq!(
            store.get_workflow("job_cancel_http").unwrap().state,
            runalith_domain::WorkflowState::Proposed
        );

        let auth = Arc::new(Auth {
            calls: AtomicUsize::new(0),
            capabilities: vec!["workflow.cancel".into(), "workflow.read".into()],
        });
        let allowed_api = ControlApi::from_store(
            store.clone(),
            deny_all_approval_verifier(),
            auth,
            Arc::new(DenyWorker),
            Arc::new(DenyResult),
            Arc::new(AllowCancel),
        );
        let cancelled = allowed_api.handle(request(
            "POST",
            "/v1/workflows/job_cancel_http/cancel",
            &valid,
            cancellation_body,
        ));
        assert_eq!(
            cancelled.status,
            200,
            "{}",
            String::from_utf8_lossy(&cancelled.body)
        );
        let response: Value = serde_json::from_slice(&cancelled.body).unwrap();
        assert_eq!(response["state"], "CANCELLED");
        assert_eq!(response["cancellation_request"]["actor"], "host:operator");
        assert_eq!(
            response["cancellation_request"]["reason"],
            "operator requested stop"
        );
        assert_eq!(
            response["cancellation_request"]["settlement_status"],
            "NOT_REQUIRED"
        );

        let read = allowed_api.handle(request("GET", "/v1/workflows/job_cancel_http", &valid, &[]));
        assert_eq!(read.status, 200);
        let persisted: Value = serde_json::from_slice(&read.body).unwrap();
        assert_eq!(
            persisted["cancellation_request"],
            response["cancellation_request"]
        );
        let replay = allowed_api.handle(request(
            "POST",
            "/v1/workflows/job_cancel_http/cancel",
            &valid,
            cancellation_body,
        ));
        assert_eq!(replay.status, 200);
        assert_eq!(
            store
                .list_workflow_events("job_cancel_http", 20)
                .unwrap()
                .iter()
                .filter(|event| event.event_type == "workflow.cancel_requested")
                .count(),
            1
        );
    }

    #[test]
    fn recovery_route_requires_its_capability_and_projects_unresolved_without_mutation() {
        let (create_api, _, store, _dir) =
            api_with_store(vec!["workflow.create"], Arc::new(DenyCancel));
        let creator_headers = vec![("Authorization".into(), "Bearer opaque-test-token".into())];
        let proposal = br#"{"workflow_id":"job_recovery_projection","title":"Recovery projection","goal":"Expose exact current attempt without assuming process death","tasks":[{"task_id":"task-1","role":"researcher","description":"Create a running attempt","depends_on":[],"required_evidence":[],"inputs":{}}],"metadata":{}}"#;
        let created =
            create_api.handle(request("POST", "/v1/workflows", &creator_headers, proposal));
        assert_eq!(
            created.status,
            201,
            "{}",
            String::from_utf8_lossy(&created.body)
        );

        let workflow = store.get_workflow("job_recovery_projection").unwrap();
        store
            .approve(
                "job_recovery_projection",
                ApprovalRequest {
                    actor: "host:reviewer".into(),
                    expected_proposal_hash: workflow.proposal_hash.clone(),
                    expected_plan_hash: runalith_domain::content_hash(&workflow.plan).unwrap(),
                    evidence: json!({"host_test_authority":true}),
                },
                &AllowApproval,
            )
            .unwrap();
        let lease = store
            .claim_task(
                "job_recovery_projection",
                "task-1",
                ClaimRequest {
                    worker_id: "worker-recovery-projection".into(),
                    lease_ttl_seconds: 60,
                },
                &AllowApproval,
            )
            .unwrap();

        let recovery_path = "/v1/workflows/job_recovery_projection/tasks/task-1/recovery";
        let read_only_auth = Arc::new(Auth {
            calls: AtomicUsize::new(0),
            capabilities: vec!["workflow.read".into()],
        });
        let read_only_api = ControlApi::from_store(
            store.clone(),
            deny_all_approval_verifier(),
            read_only_auth,
            Arc::new(DenyWorker),
            Arc::new(DenyResult),
            Arc::new(DenyCancel),
        );
        let denied = read_only_api.handle(request("GET", recovery_path, &creator_headers, &[]));
        assert_eq!(denied.status, 403);

        let recovery_auth = Arc::new(Auth {
            calls: AtomicUsize::new(0),
            capabilities: vec!["workflow.recovery.read".into()],
        });
        let recovery_api = ControlApi::from_store(
            store.clone(),
            deny_all_approval_verifier(),
            recovery_auth,
            Arc::new(DenyWorker),
            Arc::new(DenyResult),
            Arc::new(DenyCancel),
        );
        let before_workflow = store.get_workflow("job_recovery_projection").unwrap();
        let before_attempt = store
            .inspect_task_attempt("job_recovery_projection", "task-1")
            .unwrap();
        let before_events = store
            .list_workflow_events("job_recovery_projection", 100)
            .unwrap();

        let response = recovery_api.handle(request("GET", recovery_path, &creator_headers, &[]));
        assert_eq!(
            response.status,
            200,
            "{}",
            String::from_utf8_lossy(&response.body)
        );
        let value: Value = serde_json::from_slice(&response.body).unwrap();
        assert_eq!(value["disposition"], "UNRESOLVED");
        assert_eq!(value["authority"], "host_runtime_inventory_required");
        assert_eq!(value["mutated"], false);
        assert_eq!(value["observation"]["state"], "RUNNING");
        assert_eq!(value["observation"]["attempt"], lease.attempt);
        assert_eq!(value["observation"]["lease_id"], lease.lease_id);
        assert_eq!(value["observation"]["owner_epoch"], lease.owner_epoch);
        assert_eq!(value["observation"]["history_complete"], true);

        let after_workflow = store.get_workflow("job_recovery_projection").unwrap();
        let after_attempt = store
            .inspect_task_attempt("job_recovery_projection", "task-1")
            .unwrap();
        let after_events = store
            .list_workflow_events("job_recovery_projection", 100)
            .unwrap();
        assert_eq!(after_workflow.state, before_workflow.state);
        assert_eq!(after_attempt.state, before_attempt.state);
        assert_eq!(after_attempt.attempt, before_attempt.attempt);
        assert_eq!(after_attempt.owner_epoch, before_attempt.owner_epoch);
        assert_eq!(after_attempt.lease_id, before_attempt.lease_id);
        assert_eq!(
            after_attempt.event_head_sha256,
            before_attempt.event_head_sha256
        );
        assert_eq!(after_events, before_events);
    }

    #[test]
    fn catalog_plan_workflow_creation_requires_skill_authority_and_binds_exact_plan() {
        struct NoSkillResolver;
        impl TrustedSkillResolver for NoSkillResolver {
            fn resolve_and_verify(
                &self,
                _: &runalith_runtime::Transaction<'_>,
                _: &str,
            ) -> Result<runalith_runtime::VerifiedTrustedSkill, runalith_runtime::StoreError>
            {
                Err(runalith_runtime::StoreError::ApprovalAuthorityUnavailable)
            }
        }

        let store = Arc::new(Store::in_memory().unwrap());
        store
            .create_custom_role(
                CustomRoleDefinition {
                    role_id: "api-owner".into(),
                    version: 1,
                    name: "API Owner".into(),
                    description: "Catalog workflow integration test".into(),
                    system_prompt: "Use declared inputs and produce typed output".into(),
                    input_contract: vec![runalith_domain::workflow::ArtifactType::JobRequest],
                    output_artifact_type: runalith_domain::workflow::ArtifactType::Requirements,
                    allowed_capabilities: vec![
                        runalith_domain::workflow::WorkflowCapability::ProductRequirements,
                    ],
                    permissions: vec![
                        runalith_domain::workflow::WorkflowPermission::WorkspaceRead,
                        runalith_domain::workflow::WorkflowPermission::ArtifactCreate,
                    ],
                    allowed_tools: vec!["workflow_get".into()],
                    skills: vec![],
                },
                "catalog-admin",
            )
            .unwrap();
        store
            .create_custom_workflow(
                CustomWorkflowDefinition {
                    workflow_id: "api-catalog-flow".into(),
                    version: 1,
                    name: "API Catalog Flow".into(),
                    description: "Immutable HTTP workflow plan".into(),
                    input_contract: vec![runalith_domain::workflow::ArtifactType::JobRequest],
                    tasks: vec![runalith_domain::workflow::WorkflowTaskDefinition {
                        id: "requirements".into(),
                        role_id: "api-owner".into(),
                        role_version: 1,
                        depends_on: vec![],
                        input_contract: Some(vec![
                            runalith_domain::workflow::ArtifactType::JobRequest,
                        ]),
                        output_artifact_type: Some(
                            runalith_domain::workflow::ArtifactType::Requirements,
                        ),
                    }],
                },
                "catalog-admin",
            )
            .unwrap();
        let compiled = store
            .compile_custom_workflow("api-catalog-flow", Some(1), "planner")
            .unwrap();
        let auth = Arc::new(Auth {
            calls: AtomicUsize::new(0),
            capabilities: vec!["workflow.create".into()],
        });
        let bound_api = ControlApi::from_store(
            store.clone(),
            deny_all_approval_verifier(),
            auth,
            Arc::new(DenyWorker),
            Arc::new(DenyResult),
            Arc::new(DenyCancel),
        )
        .with_trusted_skill_resolver(Arc::new(NoSkillResolver));
        let headers = vec![("Authorization".into(), "Bearer opaque-test-token".into())];
        let body = serde_json::to_vec(&json!({
            "plan_id":compiled.plan_id,
            "idempotency_key":"http-catalog-workflow-create-001",
            "title":"HTTP catalog workflow",
            "goal":"Verify HTTP catalog binding"
        }))
        .unwrap();
        let created = bound_api.handle(request(
            "POST",
            "/v1/workflows/from-catalog-plan",
            &headers,
            &body,
        ));
        assert_eq!(
            created.status,
            201,
            "{}",
            String::from_utf8_lossy(&created.body)
        );
        let value: Value = serde_json::from_slice(&created.body).unwrap();
        let workflow_id = value["workflow_id"].as_str().unwrap();
        assert!(workflow_id.starts_with("job_"));
        let workflow = store.get_workflow(workflow_id).unwrap();
        assert_eq!(workflow.tasks.len(), 1);
        assert_eq!(workflow.tasks[0].definition.task_id, "requirements");
        assert!(
            store
                .list_workflow_events(workflow_id, 20)
                .unwrap()
                .iter()
                .any(|event| event.event_type == "workflow.catalog_plan_bound")
        );
        assert!(store.verify_event_chain(workflow_id).unwrap().valid);
        let replay = bound_api.handle(request(
            "POST",
            "/v1/workflows/from-catalog-plan",
            &headers,
            &body,
        ));
        assert_eq!(replay.status, 201);
        let replay_value: Value = serde_json::from_slice(&replay.body).unwrap();
        assert_eq!(replay_value["workflow_id"], workflow_id);

        let changed_body = serde_json::to_vec(&json!({
            "plan_id":compiled.plan_id,
            "idempotency_key":"http-catalog-workflow-create-001",
            "title":"HTTP catalog workflow",
            "goal":"Changed goal must conflict"
        }))
        .unwrap();
        assert_eq!(
            bound_api
                .handle(request(
                    "POST",
                    "/v1/workflows/from-catalog-plan",
                    &headers,
                    &changed_body,
                ))
                .status,
            409
        );

        let (unconfigured, _, _) = api(vec!["workflow.create"]);
        assert_eq!(
            unconfigured
                .handle(request(
                    "POST",
                    "/v1/workflows/from-catalog-plan",
                    &headers,
                    &body,
                ))
                .status,
            503
        );
    }

    #[test]
    fn policy_api_persists_immutable_versions_and_reads_exact_version() {
        let (api, _, _dir) = api(vec!["policy.write", "policy.read"]);
        let valid = vec![("Authorization".into(), "Bearer opaque-test-token".into())];
        let policy = br#"{"schema_version":1,"policy_id":"api-policy","name":"API policy","description":"","constraints":[{"id":"engineer-required","type":"task_role_present","role":"engineer"}],"success_criteria":[{"id":"all-complete","type":"all_tasks_completed"}]}"#;
        let created = api.handle(request("POST", "/v1/policies", &valid, policy));
        assert_eq!(
            created.status,
            201,
            "{}",
            String::from_utf8_lossy(&created.body)
        );
        let read = api.handle(request("GET", "/v1/policies/api-policy", &valid, &[]));
        assert_eq!(read.status, 200, "{}", String::from_utf8_lossy(&read.body));
        let value: Value = serde_json::from_slice(&read.body).unwrap();
        assert_eq!(value["policy_id"], "api-policy");
        assert_eq!(value["version"], 1);
    }

    struct NoopWorker;
    impl ExecutionWorker for NoopWorker {
        fn accept_claim(&self, _: runalith_runtime::TaskLease) -> Result<(), String> {
            Ok(())
        }
    }

    struct AllowApproval;
    impl ApprovalVerifier for AllowApproval {
        fn verify(
            &self,
            _: &runalith_runtime::Transaction<'_>,
            _: &runalith_domain::WorkflowProposal,
            _: &runalith_domain::WorkflowPlan,
            request: &ApprovalRequest,
            _: runalith_runtime::ApprovalVerificationMode,
        ) -> Result<runalith_runtime::VerifiedApproval, runalith_runtime::StoreError> {
            Ok(runalith_runtime::VerifiedApproval {
                actor: request.actor.clone(),
                evidence: request.evidence.clone(),
            })
        }
    }
    struct AllowWorker;
    impl CoordinatorWorkerVerifier for AllowWorker {
        fn authenticate_worker(
            &self,
            _: &runalith_runtime::Transaction<'_>,
            asserted: &str,
        ) -> Result<String, runalith_runtime::StoreError> {
            if asserted == "host:worker" {
                Ok(asserted.into())
            } else {
                Err(runalith_runtime::StoreError::ApprovalAuthorityUnavailable)
            }
        }
    }
    struct StopAfterClaim {
        shutdown: Arc<AtomicBool>,
        lease: Mutex<Option<runalith_runtime::TaskLease>>,
    }
    impl ExecutionWorker for StopAfterClaim {
        fn accept_claim(&self, lease: runalith_runtime::TaskLease) -> Result<(), String> {
            *self
                .lease
                .lock()
                .map_err(|_| "lease mutex poisoned".to_owned())? = Some(lease);
            self.shutdown.store(true, Ordering::Release);
            Ok(())
        }
    }

    #[test]
    fn coordinator_loop_bounds_work_and_honors_shutdown_before_claiming() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::create_new(dir.path().join("loop.db")).unwrap());
        let service = Arc::new(WorkflowService::new(store, deny_all_approval_verifier()));
        let request = CoordinatorRequest {
            worker_id: "host:worker".into(),
            lease_ttl_seconds: 30,
            max_parallel: 4,
            max_parallel_per_workflow: 2,
        };
        assert!(
            CoordinatorLoop::new(
                service.clone(),
                request.clone(),
                0,
                Duration::from_millis(10)
            )
            .is_err()
        );
        assert!(
            CoordinatorLoop::new(
                service.clone(),
                request.clone(),
                101,
                Duration::from_millis(10)
            )
            .is_err()
        );
        let runner = CoordinatorLoop::new(service, request, 4, Duration::from_millis(10)).unwrap();
        let shutdown = AtomicBool::new(true);
        assert!(runner.run(&shutdown, &DenyWorker, &NoopWorker).is_ok());
    }

    #[test]
    fn coordinator_loop_claims_one_approved_task_and_hands_off_exact_fence() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::create_new(dir.path().join("coordinator.db")).unwrap());
        let service = Arc::new(WorkflowService::new(store, Arc::new(AllowApproval)));
        let proposal: WorkflowProposal = serde_json::from_value(json!({
            "workflow_id":"job_coordinator_loop",
            "title":"Coordinator loop",
            "goal":"exercise claim and handoff",
            "tasks":[{"task_id":"task-one","role":"engineer","description":"perform bounded work","depends_on":[],"required_evidence":[],"inputs":{}}],
            "metadata":{}
        })).unwrap();
        let workflow = service.create_proposal(proposal).unwrap();
        let approval = ApprovalRequest {
            actor: "host:reviewer".into(),
            expected_proposal_hash: workflow.proposal_hash.clone(),
            expected_plan_hash: runalith_domain::content_hash(&workflow.plan).unwrap(),
            evidence: json!({"test_authority":true}),
        };
        service.approve(&workflow.workflow_id, approval).unwrap();
        service.admit_workflow(&workflow.workflow_id).unwrap();

        let shutdown = Arc::new(AtomicBool::new(false));
        let worker = StopAfterClaim {
            shutdown: shutdown.clone(),
            lease: Mutex::new(None),
        };
        let runner = CoordinatorLoop::new(
            service,
            CoordinatorRequest {
                worker_id: "host:worker".into(),
                lease_ttl_seconds: 30,
                max_parallel: 2,
                max_parallel_per_workflow: 1,
            },
            2,
            Duration::from_millis(10),
        )
        .unwrap();
        runner.run(&shutdown, &AllowWorker, &worker).unwrap();
        let lease = worker.lease.lock().unwrap().clone().unwrap();
        assert_eq!(lease.workflow_id, "job_coordinator_loop");
        assert_eq!(lease.task_id, "task-one");
        assert_eq!(lease.worker_id, "host:worker");
        assert_eq!(lease.attempt, 1);
        assert_eq!(lease.owner_epoch, 1);
    }

    #[test]
    fn http_server_is_loopback_only_and_supports_graceful_shutdown() {
        let (api_instance, _, _dir) = api(vec!["control.health.read"]);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let shutdown = Arc::new(AtomicBool::new(true));
        assert!(serve_until(listener, Arc::new(api_instance), shutdown).is_ok());

        let (api, _, _dir) = api(vec![]);
        let listener = TcpListener::bind("0.0.0.0:0").unwrap();
        assert!(matches!(
            serve_until(listener, Arc::new(api), Arc::new(AtomicBool::new(true))),
            Err(ControlApiError::InsecureBind)
        ));
    }

    #[test]
    fn bounded_http_server_authenticates_a_real_http_request() {
        let (api_instance, _, _dir) = api(vec!["control.health.read"]);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let shutdown = Arc::new(AtomicBool::new(false));
        let server_shutdown = shutdown.clone();
        let server = std::thread::spawn(move || {
            serve_until(listener, Arc::new(api_instance), server_shutdown).unwrap();
        });
        std::thread::sleep(Duration::from_millis(30));
        let mut stream = TcpStream::connect(address).unwrap();
        stream.write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer opaque-test-token\r\n\r\n").unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
        assert!(response.contains("runalith-control-api"));
        shutdown.store(true, Ordering::Release);
        server.join().unwrap();
    }

    fn serve_one_raw_request(
        request_bytes: &[u8],
        api_instance: ControlApi,
        dir: tempfile::TempDir,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let _dir = dir;
            let (stream, _) = listener.accept().unwrap();
            let _ = serve_one(stream, &api_instance);
        });
        let mut stream = TcpStream::connect(address).unwrap();
        stream.write_all(request_bytes).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        server.join().unwrap();
        response
    }

    #[test]
    fn http_parser_rejects_header_over_limit_when_terminator_arrives_in_same_read() {
        let (api_instance, _, dir) = api(vec![]);

        let prefix = "GET /livez HTTP/1.1\r\nHost: localhost\r\nX-Padding: ";
        let suffix = "\r\n\r\n";
        let padding_len = MAX_HEADER_BYTES + 1 - prefix.len() - suffix.len();
        let request = format!("{prefix}{}{suffix}", "a".repeat(padding_len));
        assert_eq!(request.len(), MAX_HEADER_BYTES + 1);
        let response = serve_one_raw_request(request.as_bytes(), api_instance, dir);

        assert!(
            response.starts_with("HTTP/1.1 431 Request Header Fields Too Large"),
            "{response}"
        );
    }

    #[test]
    fn http_parser_rejects_malformed_header_names_and_controls_before_authentication() {
        for malformed_header in [
            " Authorization: Bearer opaque-test-token\r\n",
            "Authorization : Bearer opaque-test-token\r\n",
            "X-Bad: \u{1}\r\n",
        ] {
            let (api_instance, _, dir) = api(vec!["control.health.read"]);
            let request =
                format!("GET /health HTTP/1.1\r\nHost: localhost\r\n{malformed_header}\r\n");
            let response = serve_one_raw_request(request.as_bytes(), api_instance, dir);
            assert!(
                response.starts_with("HTTP/1.1 400 Bad Request"),
                "{response}"
            );
        }
    }

    #[test]
    fn http_parser_requires_exact_single_space_request_line_separators() {
        for request_line in [
            "GET\t/livez\tHTTP/1.1",
            " GET /livez HTTP/1.1",
            "GET  /livez HTTP/1.1",
        ] {
            let (api_instance, _, dir) = api(vec![]);
            let request = format!("{request_line}\r\nHost: localhost\r\n\r\n");
            let response = serve_one_raw_request(request.as_bytes(), api_instance, dir);
            assert!(
                response.starts_with("HTTP/1.1 400 Bad Request"),
                "{response}"
            );
        }
    }

    #[test]
    fn http_parser_returns_bad_request_for_invalid_or_overflowing_content_length() {
        for content_length in ["not-a-number", "+0", "18446744073709551616"] {
            let (api_instance, _, dir) = api(vec![]);
            let request = format!(
                "GET /livez HTTP/1.1\r\nHost: localhost\r\nContent-Length: {content_length}\r\n\r\n"
            );
            let response = serve_one_raw_request(request.as_bytes(), api_instance, dir);
            assert!(
                response.starts_with("HTTP/1.1 400 Bad Request"),
                "content_length={content_length}, response={response}"
            );
        }
    }

    #[test]
    fn decode_body_rejects_duplicate_json_keys_recursively() {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Payload {
            idempotency_key: String,
            evidence: Value,
        }

        let nested_duplicate =
            br#"{"idempotency_key":"key-1","evidence":{"actor":"first","actor":"second"}}"#;
        assert!(decode_body::<Payload>(nested_duplicate).is_err());

        let escaped_duplicate =
            br#"{"idempotency_key":"key-1","evidence":{"role":"admin","\u0072ole":"guest"}}"#;
        assert!(decode_body::<Payload>(escaped_duplicate).is_err());

        let top_level_duplicate =
            br#"{"idempotency_key":"first","idempotency_key":"second","evidence":{}}"#;
        assert!(decode_body::<Payload>(top_level_duplicate).is_err());

        let valid = br#"{"idempotency_key":"stable-key","evidence":{"actor":"operator","nested":[{"scope":"workflow"}]}}"#;
        let decoded = decode_body::<Payload>(valid).unwrap();
        assert_eq!(decoded.idempotency_key, "stable-key");
        assert_eq!(decoded.evidence["actor"], "operator");
    }

    #[test]
    fn http_parser_rejects_ambiguous_framing_and_duplicate_headers() {
        for headers in [
            "Content-Length: 0\r\nContent-Length: 0\r\n",
            "Transfer-Encoding: chunked\r\nContent-Length: 0\r\n",
            "Host: localhost\r\nHost: localhost\r\n",
            "Content-Type: application/json\r\nContent-Type: text/plain\r\n",
        ] {
            let (api_instance, _, dir) = api(vec![]);
            let request = format!("GET /livez HTTP/1.1\r\nHost: localhost\r\n{headers}\r\n");
            let response = serve_one_raw_request(request.as_bytes(), api_instance, dir);
            assert!(
                response.starts_with("HTTP/1.1 400 Bad Request"),
                "headers={headers:?}, response={response}"
            );
        }
    }
}
