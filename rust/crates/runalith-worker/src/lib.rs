//! Fenced worker-side execution of authenticated Control claims.
//!
//! Authentication and current lease/plan authority are supplied by an injected
//! verifier. This module enforces the claim's structural binding and executes
//! its exact command through the sandbox capability; it never dispatches a
//! provider or changes workflow lifecycle state.

pub mod config;
pub mod control_http;
/// Versioned Workstream 3 semantic observations. Shared wire envelopes and
/// transport remain owned by the protocol/gateway workstream.
pub mod observations;
pub use observations::{
    LocalStoreHealthV1, ProcessObservationV1, ProcessStopReceiptV1, ProcessStopScopeV1,
    WorkerClaimAcceptedV1, WorkerHealthScopeV1, WorkerHealthV1,
};
pub mod providers;
pub mod sessions;
pub mod store;
pub mod supervisor;
pub mod workspaces;
pub use config::{WorkerConfig, WorkerConfigError};
pub use control_http::HttpControlPlane;
pub use providers::{
    ProviderPollError, ProviderPollReport, ProviderPoller, ProviderResultCollector,
    ProviderTerminalResult,
};
pub use sessions::{
    SessionDeliveryControl, SessionDeliveryError, SessionDeliveryOutcome, SessionDeliveryResult,
    SessionDeliveryWorker,
};
pub use store::{
    ExecutionWorkspaceRecord, ExecutionWorkspaceState, FencedProviderIntent, InboxState,
    OutboxLease, ProviderResultEvent, ProviderResultLease, SessionDeliveryEnvelope,
    SessionDeliveryLease, WorkerResultEvent, WorkerStore, WorkerStoreError,
};
pub use supervisor::{
    ControlPlane, ControlPlaneError, ExecutionFence, ExecutionFenceCompletion,
    ExecutionFenceCompletionReceipt, ExecutionFenceKind, ExecutionFenceRequest,
    ExecutionFenceState, LeaseRenewal, PublishResult, RunOutcome, SupervisorConfig,
    SupervisorError, WorkerSupervisor,
};
pub use workspaces::{
    ExecutionWorkspaceLease, ExecutionWorkspaceLimits, ExecutionWorkspaceManager,
    ProjectQuotaBackend, WorkspaceManagerError,
};

use std::sync::atomic::{AtomicBool, Ordering};

use chrono::{DateTime, Utc};
use runalith_artifacts::{ArtifactError, ArtifactStore, StoredArtifact};
use runalith_domain::content_hash;
use runalith_sandbox::{
    CommandRequest, ObservedCommandResult, SandboxError, SandboxExecutor, SandboxProcessObservation,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

/// Current worker claim contract version.
pub const TASK_CLAIM_SCHEMA_VERSION: u32 = 3;

/// Authenticated, Control-issued permission to execute one exact task attempt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskClaimEnvelope {
    /// Contract version.
    pub schema_version: u32,
    /// Stable claim identity used for deduplication by the worker inbox.
    pub claim_id: String,
    /// Authenticated Control service identity.
    pub issuer: String,
    /// Intended worker identity.
    pub audience: String,
    /// Claim issue time in RFC 3339 format.
    pub issued_at: String,
    /// Claim expiry in RFC 3339 format.
    pub expires_at: String,
    /// Workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Fenced attempt number.
    pub attempt: u64,
    /// Monotonic lease owner epoch.
    pub owner_epoch: u64,
    /// Exact Control lease identity.
    pub lease_id: String,
    /// Worker identity bound to the lease.
    pub worker_id: String,
    /// Approved immutable plan digest.
    pub plan_sha256: String,
    /// Digest of the exact command request.
    pub command_sha256: String,
    /// Stable cross-service idempotency identity.
    pub idempotency_key: String,
    /// Opaque authenticated evidence, interpreted only by the verifier.
    pub authenticator: Value,
    /// Exact sandbox command authorized by the immutable plan.
    pub command: CommandRequest,
    /// Optional provider side effect authorized by the same immutable Control claim.
    #[serde(default)]
    pub provider_dispatch: Option<runalith_providers::ProviderDispatchRequest>,
    /// Session messages authorized by this claim and durably queued before execution.
    #[serde(default)]
    pub session_messages: Vec<SessionDeliveryEnvelope>,
}

/// Verifies issuer authenticity and current Control authority for a claim.
/// Implementations must check exact lease, plan, attempt, epoch and audience
/// against authoritative Control state. A structural check is not authority.
pub trait TaskClaimVerifier: Send + Sync {
    /// Verify signature/authentication and current fenced claim binding.
    fn verify(&self, claim: &TaskClaimEnvelope) -> Result<(), String>;
}

/// Claim accepted for one in-process execution attempt.
///
/// The private fields prevent callers from constructing a verified claim. The
/// atomic one-use fence prevents duplicate execution through this instance;
/// durable cross-process deduplication still belongs in the Execution inbox.
pub struct VerifiedTaskClaim {
    envelope: TaskClaimEnvelope,
    consumed: AtomicBool,
}

impl VerifiedTaskClaim {
    /// Verify an authenticated claim and bind it to this worker and current time.
    pub fn verify(
        envelope: TaskClaimEnvelope,
        worker_id: &str,
        now: DateTime<Utc>,
        verifier: &dyn TaskClaimVerifier,
    ) -> Result<Self, WorkerExecutionError> {
        validate_claim(&envelope, worker_id, now)?;
        verifier
            .verify(&envelope)
            .map_err(WorkerExecutionError::Unauthorized)?;
        Ok(Self {
            envelope,
            consumed: AtomicBool::new(false),
        })
    }

    /// Exact immutable claim identity, safe for logs and correlation.
    pub fn claim_id(&self) -> &str {
        &self.envelope.claim_id
    }

    /// Read-only access to the exact envelope after structural and authority
    /// verification. The authenticator remains opaque to observation builders.
    pub(crate) fn as_envelope(&self) -> &TaskClaimEnvelope {
        &self.envelope
    }
}

/// Process outcome classification. UNKNOWN must be reconciled before retry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WorkerOutcome {
    /// Process exited successfully.
    Succeeded,
    /// Process completed with a non-zero exit or timed out.
    Failed,
    /// Process may have started but completion could not be established.
    Unknown,
    /// Sandbox proves process was not started.
    NotStarted,
}

/// Content-addressed execution evidence manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerExecutionEvidence {
    /// Claim identity.
    pub claim_id: String,
    /// Workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Attempt and lease fencing epoch.
    pub attempt: u64,
    /// Monotonic owner epoch.
    pub owner_epoch: u64,
    /// Lease identity.
    pub lease_id: String,
    /// Worker identity.
    pub worker_id: String,
    /// Approved plan digest.
    pub plan_sha256: String,
    /// Exact command digest.
    pub command_sha256: String,
    /// Classified process outcome.
    pub outcome: WorkerOutcome,
    /// Process exit code, if known.
    pub exit_code: Option<i32>,
    /// Whether process timed out.
    pub timed_out: bool,
    /// Whether lease cancellation was observed after process start.
    /// Runtime-only: persisted in the W3 evidence manifest, never in the legacy
    /// W2 task-result envelope until its contract owner ratifies new fields.
    #[serde(skip)]
    pub cancelled_after_start: bool,
    /// Exact process identity and local cgroup-quiescence observation, when
    /// the configured backend can prove it. This never proves provider terminality.
    /// Runtime-only: persisted in the W3 evidence manifest, not the task-result wire DTO.
    #[serde(skip)]
    pub process_observation: Option<SandboxProcessObservation>,
    /// Captured stdout artifact.
    pub stdout: Option<StoredArtifact>,
    /// Captured stderr artifact.
    pub stderr: Option<StoredArtifact>,
    /// Whether either output stream was truncated.
    pub output_truncated: bool,
    /// Sandbox backend identity.
    pub sandbox_backend: Option<String>,
    /// SHA-256 of the complete evidence manifest bytes.
    pub manifest_sha256: String,
    /// Content-addressed manifest artifact.
    pub manifest: StoredArtifact,
}

/// Worker execution failure.
#[derive(Debug, Error)]
pub enum WorkerExecutionError {
    /// Claim failed structural, temporal or worker binding checks.
    #[error("worker claim rejected: {0}")]
    InvalidClaim(&'static str),
    /// Authenticator or authoritative Control check rejected the claim.
    #[error("worker claim authentication failed: {0}")]
    Unauthorized(String),
    /// This verified claim was already consumed in this process.
    #[error("worker claim was already consumed")]
    AlreadyConsumed,
    /// Artifact persistence failed after process execution.
    #[error("worker evidence persistence failed: {0}")]
    Artifact(#[from] ArtifactError),
    /// Evidence serialization failed.
    #[error("worker evidence serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
    /// Evidence digest could not be computed.
    #[error("worker evidence digest failed: {0}")]
    Evidence(String),
    /// Per-execution workspace allocation or cleanup failed.
    #[error("execution workspace failed: {0}")]
    Workspace(String),
}

/// Per-execution filesystem workspace allocator used by the sandbox supervisor.
pub trait ExecutionWorkspaceAllocator: Send + Sync {
    /// Allocate a unique workspace and verify its kernel hard limits before returning.
    fn allocate(&self, claim: &TaskClaimEnvelope) -> Result<ExecutionWorkspaceLease, String>;
    /// Release a known terminal workspace or quarantine an ambiguous one.
    fn finish(&self, lease: &ExecutionWorkspaceLease, outcome: WorkerOutcome)
    -> Result<(), String>;
}

/// Executes verified claims through the configured sandbox and stores evidence.
pub struct WorkerExecutor<'a> {
    sandbox: &'a dyn SandboxExecutor,
    artifacts: &'a ArtifactStore,
    workspaces: Option<&'a dyn ExecutionWorkspaceAllocator>,
}

impl<'a> WorkerExecutor<'a> {
    /// Bind an already-provisioned sandbox and private artifact store.
    pub fn new(sandbox: &'a dyn SandboxExecutor, artifacts: &'a ArtifactStore) -> Self {
        Self {
            sandbox,
            artifacts,
            workspaces: None,
        }
    }

    /// Attach the production per-execution workspace allocator.
    pub fn with_workspace_allocator(
        mut self,
        allocator: &'a dyn ExecutionWorkspaceAllocator,
    ) -> Self {
        self.workspaces = Some(allocator);
        self
    }

    /// Return the exact effective sandbox policy digest used for fenced start.
    pub fn execution_profile_sha256(&self) -> Option<String> {
        self.sandbox.execution_profile_sha256()
    }

    /// Allocate an isolated workspace when this sandbox backend requires one.
    pub fn allocate_workspace(
        &self,
        claim: &TaskClaimEnvelope,
    ) -> Result<Option<ExecutionWorkspaceLease>, WorkerExecutionError> {
        if let Some(allocator) = self.workspaces {
            return allocator
                .allocate(claim)
                .map(Some)
                .map_err(WorkerExecutionError::Workspace);
        }
        if self.sandbox.requires_isolated_workspace() {
            return Err(WorkerExecutionError::Workspace(
                "sandbox requires a per-execution quota workspace but no allocator is configured"
                    .into(),
            ));
        }
        Ok(None)
    }

    /// Compute a profile digest over the exact dynamic workspace and quota assignment.
    pub fn execution_profile_sha256_for_workspace(
        &self,
        workspace: Option<&ExecutionWorkspaceLease>,
    ) -> Option<String> {
        let Some(workspace) = workspace else {
            return self.sandbox.execution_profile_sha256();
        };
        let base = self
            .sandbox
            .execution_profile_sha256_for_workspace(&workspace.record.workspace_path)?;
        content_hash(&serde_json::json!({
            "schema_version":1,
            "sandbox_profile_sha256":base,
            "workspace_device":workspace.record.device?,
            "workspace_inode":workspace.record.inode?,
            "project_id":workspace.record.project_id,
            "byte_limit":workspace.record.byte_limit,
            "inode_limit":workspace.record.inode_limit
        }))
        .ok()
    }

    /// Release a workspace when no sandbox process was started, or quarantine an ambiguous outcome.
    pub fn finish_workspace(
        &self,
        workspace: Option<&ExecutionWorkspaceLease>,
        outcome: WorkerOutcome,
    ) -> Result<(), WorkerExecutionError> {
        let (Some(workspace), Some(allocator)) = (workspace, self.workspaces) else {
            return Ok(());
        };
        allocator
            .finish(workspace, outcome)
            .map_err(WorkerExecutionError::Workspace)
    }

    /// Execute a claim at most once per verified in-memory claim instance.
    ///
    /// A persistence failure after process completion returns an error and must
    /// be reconciled from the worker inbox/process inventory before any retry.
    pub fn execute(
        &self,
        claim: &VerifiedTaskClaim,
    ) -> Result<WorkerExecutionEvidence, WorkerExecutionError> {
        self.execute_cancellable(claim, &AtomicBool::new(false))
    }

    /// Execute while observing the supervisor's lease-loss cancellation fence.
    pub fn execute_cancellable(
        &self,
        claim: &VerifiedTaskClaim,
        cancelled: &AtomicBool,
    ) -> Result<WorkerExecutionEvidence, WorkerExecutionError> {
        let workspace = self.allocate_workspace(&claim.envelope)?;
        self.execute_cancellable_in_workspace(claim, cancelled, workspace.as_ref())
    }

    /// Execute using a pre-allocated, quota-verified workspace supplied by the supervisor.
    pub fn execute_cancellable_in_workspace(
        &self,
        claim: &VerifiedTaskClaim,
        cancelled: &AtomicBool,
        workspace: Option<&ExecutionWorkspaceLease>,
    ) -> Result<WorkerExecutionEvidence, WorkerExecutionError> {
        if self.sandbox.requires_isolated_workspace() && workspace.is_none() {
            return Err(WorkerExecutionError::Workspace(
                "sandbox execution attempted without an isolated workspace".into(),
            ));
        }
        claim
            .consumed
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| WorkerExecutionError::AlreadyConsumed)?;

        let execution = match workspace {
            Some(workspace) => self.sandbox.execute_cancellable_observed_in_workspace(
                claim.envelope.command.clone(),
                &workspace.record.workspace_path,
                workspace.record.device.zip(workspace.record.inode),
                cancelled,
            ),
            None => self
                .sandbox
                .execute_cancellable_observed(claim.envelope.command.clone(), cancelled),
        };
        let (outcome, result, diagnostic) = match execution {
            Ok(result) => {
                let outcome = if result.cancelled_after_start {
                    WorkerOutcome::Unknown
                } else if result.result.timed_out || result.result.exit_code != Some(0) {
                    WorkerOutcome::Failed
                } else {
                    WorkerOutcome::Succeeded
                };
                (outcome, Some(result), None)
            }
            Err(SandboxError::Spawn(error)) => {
                (WorkerOutcome::NotStarted, None, Some(error.to_string()))
            }
            Err(error @ SandboxError::CancelledBeforeStart) => {
                (WorkerOutcome::NotStarted, None, Some(error.to_string()))
            }
            Err(error @ (SandboxError::BackendUnavailable(_) | SandboxError::Policy(_))) => {
                (WorkerOutcome::NotStarted, None, Some(error.to_string()))
            }
            Err(error) => (WorkerOutcome::Unknown, None, Some(error.to_string())),
        };
        self.finish_workspace(workspace, outcome)?;
        self.persist_evidence(claim, outcome, result.as_ref(), diagnostic.as_deref())
    }

    fn persist_evidence(
        &self,
        claim: &VerifiedTaskClaim,
        outcome: WorkerOutcome,
        result: Option<&ObservedCommandResult>,
        diagnostic: Option<&str>,
    ) -> Result<WorkerExecutionEvidence, WorkerExecutionError> {
        let command_result = result.map(|observed| &observed.result);
        let process_observation = result.and_then(|observed| observed.process.clone());
        let stdout = command_result
            .map(|value| {
                self.artifacts
                    .put("application/octet-stream", &value.stdout_bytes)
            })
            .transpose()?;
        let stderr = command_result
            .map(|value| {
                self.artifacts
                    .put("application/octet-stream", &value.stderr_bytes)
            })
            .transpose()?;
        if let (Some(result), Some(stdout)) = (command_result, stdout.as_ref()) {
            if result.stdout_sha256 != stdout.sha256 {
                return Err(WorkerExecutionError::Evidence(
                    "sandbox stdout digest does not match content-addressed bytes".into(),
                ));
            }
        }
        if let (Some(result), Some(stderr)) = (command_result, stderr.as_ref()) {
            if result.stderr_sha256 != stderr.sha256 {
                return Err(WorkerExecutionError::Evidence(
                    "sandbox stderr digest does not match content-addressed bytes".into(),
                ));
            }
        }
        let manifest_value = serde_json::json!({
            "schema_version": 2,
            "claim_id": claim.envelope.claim_id,
            "workflow_id": claim.envelope.workflow_id,
            "task_id": claim.envelope.task_id,
            "attempt": claim.envelope.attempt,
            "owner_epoch": claim.envelope.owner_epoch,
            "lease_id": claim.envelope.lease_id,
            "worker_id": claim.envelope.worker_id,
            "plan_sha256": claim.envelope.plan_sha256,
            "command_sha256": claim.envelope.command_sha256,
            "outcome": outcome,
            "exit_code": command_result.and_then(|value| value.exit_code),
            "timed_out": command_result.is_some_and(|value| value.timed_out),
            "cancelled_after_start": result.is_some_and(|value| value.cancelled_after_start),
            "process_observation": process_observation,
            "stdout": stdout,
            "stderr": stderr,
            "stdout_sha256": stdout.as_ref().map(|artifact| artifact.sha256.as_str()),
            "stderr_sha256": stderr.as_ref().map(|artifact| artifact.sha256.as_str()),
            "output_truncated": command_result.is_some_and(|value| value.stdout_truncated || value.stderr_truncated),
            "sandbox_backend": command_result.map(|value| value.sandbox_backend.as_str()),
            "diagnostic": diagnostic,
        });
        let manifest_bytes = serde_json::to_vec(&manifest_value)?;
        let manifest = self.artifacts.put("application/json", &manifest_bytes)?;
        let manifest_sha256 = manifest.sha256.clone();
        Ok(WorkerExecutionEvidence {
            claim_id: claim.envelope.claim_id.clone(),
            workflow_id: claim.envelope.workflow_id.clone(),
            task_id: claim.envelope.task_id.clone(),
            attempt: claim.envelope.attempt,
            owner_epoch: claim.envelope.owner_epoch,
            lease_id: claim.envelope.lease_id.clone(),
            worker_id: claim.envelope.worker_id.clone(),
            plan_sha256: claim.envelope.plan_sha256.clone(),
            command_sha256: claim.envelope.command_sha256.clone(),
            outcome,
            exit_code: command_result.and_then(|value| value.exit_code),
            timed_out: command_result.is_some_and(|value| value.timed_out),
            cancelled_after_start: result.is_some_and(|value| value.cancelled_after_start),
            process_observation,
            stdout,
            stderr,
            output_truncated: command_result
                .is_some_and(|value| value.stdout_truncated || value.stderr_truncated),
            sandbox_backend: command_result.map(|value| value.sandbox_backend.clone()),
            manifest_sha256,
            manifest,
        })
    }
}

fn validate_claim(
    claim: &TaskClaimEnvelope,
    worker_id: &str,
    now: DateTime<Utc>,
) -> Result<(), WorkerExecutionError> {
    for (value, field) in [
        (claim.claim_id.as_str(), "claim_id"),
        (claim.issuer.as_str(), "issuer"),
        (claim.audience.as_str(), "audience"),
        (claim.workflow_id.as_str(), "workflow_id"),
        (claim.task_id.as_str(), "task_id"),
        (claim.lease_id.as_str(), "lease_id"),
        (claim.worker_id.as_str(), "worker_id"),
        (claim.idempotency_key.as_str(), "idempotency_key"),
    ] {
        if value.trim().is_empty() || value.len() > 256 {
            return Err(WorkerExecutionError::InvalidClaim(field));
        }
    }
    if claim.schema_version != TASK_CLAIM_SCHEMA_VERSION {
        return Err(WorkerExecutionError::InvalidClaim("schema_version"));
    }
    if claim.attempt == 0
        || claim.owner_epoch == 0
        || claim.attempt > i64::MAX as u64
        || claim.owner_epoch > i64::MAX as u64
    {
        return Err(WorkerExecutionError::InvalidClaim("attempt_or_owner_epoch"));
    }
    if claim.worker_id != worker_id || claim.audience != worker_id {
        return Err(WorkerExecutionError::InvalidClaim("worker_binding"));
    }
    for (digest, field) in [
        (&claim.plan_sha256, "plan_sha256"),
        (&claim.command_sha256, "command_sha256"),
    ] {
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(WorkerExecutionError::InvalidClaim(field));
        }
    }
    let command_sha256 = content_hash(&claim.command)
        .map_err(|_| WorkerExecutionError::InvalidClaim("command_sha256"))?;
    if command_sha256 != claim.command_sha256 {
        return Err(WorkerExecutionError::InvalidClaim("command_binding"));
    }
    let issued_at = DateTime::parse_from_rfc3339(&claim.issued_at)
        .map_err(|_| WorkerExecutionError::InvalidClaim("issued_at"))?;
    let expires_at = DateTime::parse_from_rfc3339(&claim.expires_at)
        .map_err(|_| WorkerExecutionError::InvalidClaim("expires_at"))?;
    if expires_at <= issued_at
        || issued_at.with_timezone(&Utc) > now
        || expires_at.with_timezone(&Utc) <= now
        || (expires_at - issued_at).num_seconds() > 600
    {
        return Err(WorkerExecutionError::InvalidClaim("claim_time_window"));
    }
    if !claim.authenticator.is_object()
        || claim
            .authenticator
            .get("acl_sha256")
            .and_then(Value::as_str)
            .is_none_or(|digest| {
                digest.len() != 64
                    || !digest
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
    {
        return Err(WorkerExecutionError::InvalidClaim("authenticator"));
    }
    if let Some(provider) = &claim.provider_dispatch {
        if provider.provider_id.trim().is_empty()
            || provider.provider_id.len() > 128
            || provider.idempotency_key.trim().is_empty()
            || provider.idempotency_key.len() > 256
            || provider.workflow_id != claim.workflow_id
            || provider.task_id != claim.task_id
            || provider.attempt != claim.attempt
            || provider.lease_id != claim.lease_id
            || provider.worker_id != claim.worker_id
            || provider.plan_sha256 != claim.plan_sha256
            || runalith_providers::validate_payload(&provider.payload, &provider.request_sha256)
                .is_err()
        {
            return Err(WorkerExecutionError::InvalidClaim(
                "provider_dispatch_binding",
            ));
        }
    }
    if claim.session_messages.len() > 64 {
        return Err(WorkerExecutionError::InvalidClaim("session_message_count"));
    }
    let mut message_ids = std::collections::BTreeSet::new();
    let mut idempotency_keys = std::collections::BTreeSet::new();
    for message in &claim.session_messages {
        let valid_identity = [
            (&message.message_id, 256),
            (&message.idempotency_key, 256),
            (&message.session_id, 256),
            (&message.recipient_role, 128),
            (&message.message_type, 128),
        ]
        .iter()
        .all(|(value, max)| !value.trim().is_empty() && value.len() <= *max);
        let expires_at = DateTime::parse_from_rfc3339(&message.expires_at)
            .map(|value| value.with_timezone(&Utc));
        if !valid_identity
            || !message_ids.insert(message.message_id.as_str())
            || !idempotency_keys.insert(message.idempotency_key.as_str())
            || message.workflow_id != claim.workflow_id
            || message.task_id != claim.task_id
            || message.attempt != claim.attempt
            || message.owner_epoch != claim.owner_epoch
            || message.lease_id != claim.lease_id
            || message.worker_id != claim.worker_id
            || !message.payload.is_object()
            || serde_json::to_vec(&message.payload).map_or(true, |bytes| bytes.len() > 65_536)
            || expires_at.map_or(true, |expiry| {
                expiry <= now || expiry > now + chrono::Duration::hours(24)
            })
        {
            return Err(WorkerExecutionError::InvalidClaim(
                "session_message_binding",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use runalith_sandbox::{
        CgroupCleanupEvidence, CommandResult, ObservedCommandResult, SandboxProcessObservation,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct AcceptClaim;
    impl TaskClaimVerifier for AcceptClaim {
        fn verify(&self, _claim: &TaskClaimEnvelope) -> Result<(), String> {
            Ok(())
        }
    }

    struct RejectClaim;
    impl TaskClaimVerifier for RejectClaim {
        fn verify(&self, _claim: &TaskClaimEnvelope) -> Result<(), String> {
            Err("signature or Control binding rejected".into())
        }
    }

    pub(crate) struct FakeSandbox {
        pub(crate) calls: AtomicUsize,
        pub(crate) result: Result<CommandResult, &'static str>,
    }
    impl SandboxExecutor for FakeSandbox {
        fn execute(&self, _request: CommandRequest) -> Result<CommandResult, SandboxError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            match &self.result {
                Ok(result) => Ok(result.clone()),
                Err(_) => Err(SandboxError::ProcessUnknown(
                    "simulated post-spawn uncertainty".into(),
                )),
            }
        }

        fn execution_profile_sha256(&self) -> Option<String> {
            Some("c".repeat(64))
        }
    }

    struct IsolatedFakeSandbox {
        calls: AtomicUsize,
    }

    impl SandboxExecutor for IsolatedFakeSandbox {
        fn execute(&self, _: CommandRequest) -> Result<CommandResult, SandboxError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(result())
        }

        fn execution_profile_sha256(&self) -> Option<String> {
            Some("c".repeat(64))
        }

        fn requires_isolated_workspace(&self) -> bool {
            true
        }
    }

    struct CancelledObservedSandbox;

    impl SandboxExecutor for CancelledObservedSandbox {
        fn execute(&self, _request: CommandRequest) -> Result<CommandResult, SandboxError> {
            Ok(result())
        }

        fn execution_profile_sha256(&self) -> Option<String> {
            Some("c".repeat(64))
        }

        fn execute_cancellable_observed(
            &self,
            _request: CommandRequest,
            _cancelled: &AtomicBool,
        ) -> Result<ObservedCommandResult, SandboxError> {
            Ok(ObservedCommandResult {
                result: result(),
                process: Some(SandboxProcessObservation {
                    process_id: 4242,
                    started_at_unix_ms: 100,
                    finished_at_unix_ms: 140,
                    cgroup: CgroupCleanupEvidence {
                        cgroup_id: "runalith-cancelled-test".into(),
                        kill_requested_at_unix_ms: 120,
                        populated_zero_observed_at_unix_ms: 130,
                    },
                }),
                cancelled_after_start: true,
            })
        }
    }

    pub(crate) fn envelope(now: DateTime<Utc>) -> TaskClaimEnvelope {
        let command = CommandRequest {
            executable: "/usr/bin/true".into(),
            arguments: vec![],
            working_directory: ".".into(),
            environment: Default::default(),
            stdin: vec![],
        };
        TaskClaimEnvelope {
            schema_version: TASK_CLAIM_SCHEMA_VERSION,
            claim_id: "claim-1".into(),
            issuer: "control".into(),
            audience: "worker-1".into(),
            issued_at: now.to_rfc3339(),
            expires_at: (now + chrono::Duration::minutes(1)).to_rfc3339(),
            workflow_id: "workflow-1".into(),
            task_id: "task-1".into(),
            attempt: 1,
            owner_epoch: 7,
            lease_id: "lease-1".into(),
            worker_id: "worker-1".into(),
            plan_sha256: "a".repeat(64),
            command_sha256: content_hash(&command).unwrap(),
            idempotency_key: "idem-1".into(),
            authenticator: serde_json::json!({"signature":"opaque","acl_sha256":"b".repeat(64)}),
            command,
            provider_dispatch: None,
            session_messages: Vec::new(),
        }
    }

    pub(crate) fn result() -> CommandResult {
        CommandResult {
            exit_code: Some(0),
            timed_out: false,
            stdout: "�\0".into(),
            stderr: String::new(),
            stdout_bytes: vec![0xff, 0x00],
            stderr_bytes: vec![],
            stdout_sha256: "ea5dbf9596d187e9500f23e9a680109475341cf4e81f7e043f7d97152c10772f"
                .into(),
            stderr_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                .into(),
            stdout_truncated: false,
            stderr_truncated: false,
            sandbox_backend: "fake".into(),
        }
    }

    #[test]
    fn claim_verification_rejects_wrong_worker_expiry_and_command_tampering() {
        let now = Utc::now();
        let mut claim = envelope(now);
        assert!(VerifiedTaskClaim::verify(claim.clone(), "worker-1", now, &AcceptClaim).is_ok());
        assert!(VerifiedTaskClaim::verify(claim.clone(), "worker-2", now, &AcceptClaim).is_err());
        claim.expires_at = (now - chrono::Duration::seconds(1)).to_rfc3339();
        assert!(VerifiedTaskClaim::verify(claim.clone(), "worker-1", now, &AcceptClaim).is_err());
        claim = envelope(now);
        claim.command.arguments.push("tampered".into());
        assert!(VerifiedTaskClaim::verify(claim, "worker-1", now, &AcceptClaim).is_err());

        claim = envelope(now);
        claim.expires_at = (now + chrono::Duration::minutes(11)).to_rfc3339();
        assert!(VerifiedTaskClaim::verify(claim, "worker-1", now, &AcceptClaim).is_err());

        claim = envelope(now);
        claim.authenticator["acl_sha256"] = Value::String("not-a-digest".into());
        assert!(VerifiedTaskClaim::verify(claim, "worker-1", now, &AcceptClaim).is_err());

        claim = envelope(now);
        claim
            .authenticator
            .as_object_mut()
            .unwrap()
            .remove("acl_sha256");
        assert!(VerifiedTaskClaim::verify(claim, "worker-1", now, &AcceptClaim).is_err());

        assert!(matches!(
            VerifiedTaskClaim::verify(envelope(now), "worker-1", now, &RejectClaim),
            Err(WorkerExecutionError::Unauthorized(_))
        ));
    }

    #[test]
    fn executes_verified_claim_once_and_persists_content_addressed_evidence() {
        let now = Utc::now();
        let claim =
            VerifiedTaskClaim::verify(envelope(now), "worker-1", now, &AcceptClaim).unwrap();
        let sandbox = FakeSandbox {
            calls: AtomicUsize::new(0),
            result: Ok(result()),
        };
        let directory = tempfile::tempdir().unwrap();
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let executor = WorkerExecutor::new(&sandbox, &artifacts);
        let evidence = executor.execute(&claim).unwrap();
        assert_eq!(evidence.outcome, WorkerOutcome::Succeeded);
        assert_eq!(evidence.attempt, 1);
        assert_eq!(evidence.owner_epoch, 7);
        assert_eq!(evidence.manifest.sha256, evidence.manifest_sha256);
        assert_eq!(
            artifacts.read(evidence.stdout.as_ref().unwrap()).unwrap(),
            &[0xff, 0x00]
        );
        assert_eq!(
            evidence.stdout.as_ref().unwrap().sha256,
            result().stdout_sha256
        );
        assert!(artifacts.read(&evidence.manifest).is_ok());
        assert!(matches!(
            executor.execute(&claim),
            Err(WorkerExecutionError::AlreadyConsumed)
        ));
        assert_eq!(sandbox.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn lease_loss_after_process_start_stays_unknown_and_persists_local_stop_proof() {
        let now = Utc::now();
        let claim =
            VerifiedTaskClaim::verify(envelope(now), "worker-1", now, &AcceptClaim).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let evidence = WorkerExecutor::new(&CancelledObservedSandbox, &artifacts)
            .execute(&claim)
            .unwrap();

        assert_eq!(evidence.outcome, WorkerOutcome::Unknown);
        assert!(evidence.cancelled_after_start);
        let process = evidence
            .process_observation
            .as_ref()
            .expect("backend cgroup proof should be retained in memory");
        assert_eq!(process.process_id, 4242);

        let manifest_bytes = artifacts.read(&evidence.manifest).unwrap();
        let manifest: Value = serde_json::from_slice(&manifest_bytes).unwrap();
        assert_eq!(manifest["schema_version"], 2);
        assert_eq!(manifest["cancelled_after_start"], true);
        assert_eq!(manifest["process_observation"]["process_id"], 4242);

        let wire_payload = serde_json::to_value(&evidence).unwrap();
        assert!(wire_payload.get("cancelled_after_start").is_none());
        assert!(wire_payload.get("process_observation").is_none());
        let restored: WorkerExecutionEvidence = serde_json::from_value(wire_payload).unwrap();
        let observation =
            crate::ProcessObservationV1::from_evidence_manifest(&restored, &manifest_bytes)
                .unwrap();
        assert_eq!(observation.outcome, WorkerOutcome::Unknown);
        assert!(observation.cancelled_after_start);
        assert_eq!(observation.process.as_ref().unwrap().process_id, 4242);
        let receipt = crate::ProcessStopReceiptV1::from_observation(&observation)
            .unwrap()
            .unwrap();
        assert_eq!(
            receipt.scope,
            crate::ProcessStopScopeV1::LocalWorkerProcessTree
        );
    }

    #[test]
    fn isolated_sandbox_refuses_execution_when_project_quota_allocator_is_missing() {
        let directory = tempfile::tempdir().unwrap();
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let sandbox = IsolatedFakeSandbox {
            calls: AtomicUsize::new(0),
        };
        let executor = WorkerExecutor::new(&sandbox, &artifacts);
        let claim =
            VerifiedTaskClaim::verify(envelope(Utc::now()), "worker-1", Utc::now(), &AcceptClaim)
                .unwrap();

        let error = executor.allocate_workspace(&claim.envelope).unwrap_err();
        assert!(matches!(error, WorkerExecutionError::Workspace(_)));
        assert!(
            executor
                .execute_cancellable(&claim, &AtomicBool::new(false))
                .is_err()
        );
        assert_eq!(sandbox.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn ambiguous_sandbox_failure_is_recorded_as_unknown() {
        let now = Utc::now();
        let claim =
            VerifiedTaskClaim::verify(envelope(now), "worker-1", now, &AcceptClaim).unwrap();
        let sandbox = FakeSandbox {
            calls: AtomicUsize::new(0),
            result: Err("unknown"),
        };
        let directory = tempfile::tempdir().unwrap();
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let evidence = WorkerExecutor::new(&sandbox, &artifacts)
            .execute(&claim)
            .unwrap();
        assert_eq!(evidence.outcome, WorkerOutcome::Unknown);
        assert!(evidence.stdout.is_none());
    }

    #[test]
    fn rejects_sandbox_output_digest_that_does_not_match_persisted_bytes() {
        let now = Utc::now();
        let claim =
            VerifiedTaskClaim::verify(envelope(now), "worker-1", now, &AcceptClaim).unwrap();
        let mut output = result();
        output.stdout_sha256 = "0".repeat(64);
        let sandbox = FakeSandbox {
            calls: AtomicUsize::new(0),
            result: Ok(output),
        };
        let directory = tempfile::tempdir().unwrap();
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let error = WorkerExecutor::new(&sandbox, &artifacts)
            .execute(&claim)
            .unwrap_err();
        assert!(
            matches!(error, WorkerExecutionError::Evidence(message) if message.contains("stdout digest"))
        );
    }

    #[test]
    fn provider_and_session_side_effects_must_be_bound_to_authenticated_claim() {
        let now = Utc::now();
        let mut claim = envelope(now);
        let payload = serde_json::json!({"workflow":"release.yml","ref":"main"});
        claim.provider_dispatch = Some(runalith_providers::ProviderDispatchRequest {
            provider_id: "github-actions".into(),
            idempotency_key: "provider-key".into(),
            workflow_id: claim.workflow_id.clone(),
            task_id: claim.task_id.clone(),
            attempt: claim.attempt,
            lease_id: claim.lease_id.clone(),
            worker_id: claim.worker_id.clone(),
            plan_sha256: claim.plan_sha256.clone(),
            request_sha256: content_hash(&payload).unwrap(),
            payload,
        });
        let session_message = crate::SessionDeliveryEnvelope {
            message_id: "message-1".into(),
            idempotency_key: "message-key".into(),
            workflow_id: claim.workflow_id.clone(),
            task_id: claim.task_id.clone(),
            attempt: claim.attempt,
            owner_epoch: claim.owner_epoch,
            lease_id: claim.lease_id.clone(),
            worker_id: claim.worker_id.clone(),
            session_id: "session-1".into(),
            recipient_role: "qa".into(),
            message_type: "task.completed".into(),
            payload: serde_json::json!({"text":"done"}),
            expires_at: (now + chrono::Duration::minutes(20)).to_rfc3339(),
        };
        claim.session_messages.push(session_message);
        assert!(VerifiedTaskClaim::verify(claim.clone(), "worker-1", now, &AcceptClaim).is_ok());

        let mut forged_provider = claim.clone();
        forged_provider.provider_dispatch.as_mut().unwrap().task_id = "other-task".into();
        assert!(matches!(
            VerifiedTaskClaim::verify(forged_provider, "worker-1", now, &AcceptClaim),
            Err(WorkerExecutionError::InvalidClaim(
                "provider_dispatch_binding"
            ))
        ));

        let mut stale_session = claim;
        stale_session.session_messages[0].owner_epoch += 1;
        assert!(matches!(
            VerifiedTaskClaim::verify(stale_session, "worker-1", now, &AcceptClaim),
            Err(WorkerExecutionError::InvalidClaim(
                "session_message_binding"
            ))
        ));
    }
}
