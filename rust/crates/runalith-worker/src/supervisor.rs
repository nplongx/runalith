//! Lease-aware process supervision and fenced result publication.

use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use chrono::{DateTime, Utc};
use runalith_domain::content_hash;
use runalith_execution_persistence::{
    ProviderDispatchState, ProviderIntentRecord, ProviderIntentRequest,
};
use runalith_providers::{ProviderAdapter, ProviderAdapterError, ProviderDispatchResponse};
use thiserror::Error;

use crate::{
    ProviderResultEvent, TaskClaimEnvelope, TaskClaimVerifier, VerifiedTaskClaim,
    WorkerExecutionEvidence, WorkerExecutor, WorkerOutcome, WorkerResultEvent, WorkerStore,
    WorkerStoreError,
};

/// Result of a lease renewal against authoritative Control state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseRenewal {
    /// Exact lease identity renewed.
    pub lease_id: String,
    /// Current owner epoch.
    pub owner_epoch: u64,
    /// Current worker identity.
    pub worker_id: String,
    /// New authoritative expiry.
    pub expires_at: DateTime<Utc>,
}

/// Fenced result publication response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishResult {
    /// Control durably accepted this exact event.
    Accepted,
    /// Control had already accepted the same event identity and digest.
    AlreadyAccepted,
    /// Control rejected stale ownership; this result can never advance workflow state.
    StaleOwner,
}

/// Exact side effect reserved transactionally by authoritative Control.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionFenceRequest {
    /// Immutable Control claim identity.
    pub claim_id: String,
    /// Active lease identity.
    pub lease_id: String,
    /// Authenticated worker identity.
    pub worker_id: String,
    /// Current monotonic ownership epoch.
    pub owner_epoch: u64,
    /// Immutable execution-plan digest.
    pub plan_sha256: String,
    /// Stable identity of this side effect within the claim.
    pub side_effect_id: String,
    /// Side-effect category.
    pub kind: ExecutionFenceKind,
    /// Canonical digest of the complete side-effect request.
    pub request_sha256: String,
    /// Stable idempotency identity for reservation creation.
    pub idempotency_key: String,
    /// Digest binding the authorization decision inputs.
    pub acl_sha256: String,
}

/// Side-effect kinds covered by the Control transaction fence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionFenceKind {
    /// Start the exact sandbox command.
    SandboxStart,
    /// Dispatch the exact provider request.
    ProviderDispatch,
    /// Publish the exact terminal result event.
    ResultPublish,
    /// Deliver the exact session message.
    SessionDelivery,
}

/// State expected from a newly acquired durable reservation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ExecutionFenceState {
    /// Reservation is durable and currently blocks competing ownership transfer.
    #[serde(rename = "RESERVED")]
    Reserved,
}

/// Durable reservation returned by Control. Receipt binds reservation persistence.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionFence {
    /// Durable reservation identity.
    pub fence_id: String,
    /// Immutable Control claim identity.
    pub claim_id: String,
    /// Active lease identity.
    pub lease_id: String,
    /// Authenticated worker identity.
    pub worker_id: String,
    /// Current monotonic ownership epoch.
    pub owner_epoch: u64,
    /// Immutable execution-plan digest.
    pub plan_sha256: String,
    /// Stable side-effect identity.
    pub side_effect_id: String,
    /// Side-effect category.
    pub kind: ExecutionFenceKind,
    /// Canonical side-effect request digest.
    pub request_sha256: String,
    /// Reservation idempotency key.
    pub idempotency_key: String,
    /// Reservation state returned by Control.
    pub state: ExecutionFenceState,
    /// Durable receipt proving reservation persistence.
    pub receipt: serde_json::Value,
}

/// Exact terminal observation submitted to complete a durable side-effect fence.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionFenceCompletion {
    /// Exact reservation identity.
    pub fence_id: String,
    /// Immutable Control claim identity.
    pub claim_id: String,
    /// Active lease identity from the reservation.
    pub lease_id: String,
    /// Authenticated worker identity.
    pub worker_id: String,
    /// Ownership epoch under which side effect ran.
    pub owner_epoch: u64,
    /// Immutable execution-plan digest.
    pub plan_sha256: String,
    /// Stable side-effect identity.
    pub side_effect_id: String,
    /// Canonical side-effect request digest.
    pub request_sha256: String,
    /// Exact classified terminal outcome.
    pub outcome: crate::WorkerOutcome,
    /// Stable terminal event identity.
    pub event_id: String,
    /// Canonical terminal event digest.
    pub event_sha256: String,
    /// Digest of exact terminal observation/evidence.
    pub outcome_sha256: String,
}

/// Durable Control receipt for an exact fence completion.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionFenceCompletionReceipt {
    /// Exact reservation identity.
    pub fence_id: String,
    /// Immutable Control claim identity.
    pub claim_id: String,
    /// Active lease identity from the reservation.
    pub lease_id: String,
    /// Authenticated worker identity.
    pub worker_id: String,
    /// Ownership epoch under which side effect ran.
    pub owner_epoch: u64,
    /// Immutable execution-plan digest.
    pub plan_sha256: String,
    /// Stable side-effect identity.
    pub side_effect_id: String,
    /// Canonical side-effect request digest.
    pub request_sha256: String,
    /// Stable terminal event identity.
    pub event_id: String,
    /// Canonical terminal event digest.
    pub event_sha256: String,
    /// Digest of exact terminal observation/evidence.
    pub outcome_sha256: String,
    /// Durable receipt proving exact completion.
    pub receipt: serde_json::Value,
}

/// Control service transport error. Calls must have bounded network timeouts.
#[derive(Debug, Error)]
pub enum ControlPlaneError {
    /// Request failed before it could be sent.
    #[error("Control request failed before send: {0}")]
    NotSent(String),
    /// Request outcome is ambiguous; callers retry only idempotent event IDs.
    #[error("Control request outcome is unknown: {0}")]
    Unknown(String),
    /// Control rejected authentication or authorization.
    #[error("Control authorization rejected: {0}")]
    Unauthorized(String),
    /// Control definitively rejected this request; durable outbox events are quarantined.
    #[error("Control permanently rejected request: {0}")]
    Rejected(String),
}

/// Versioned Control API used by the independently deployed worker.
/// Implementations must enforce current lease/plan/attempt/epoch inside each
/// renewal and result-acceptance transaction.
pub trait ControlPlane: TaskClaimVerifier + Send + Sync {
    /// Long-poll or fetch one claim addressed to this worker.
    fn receive_claim(
        &self,
        worker_id: &str,
    ) -> Result<Option<TaskClaimEnvelope>, ControlPlaneError>;
    /// Renew exact lease; stale or revoked ownership is an authorization error.
    fn renew_lease(
        &self,
        claim: &TaskClaimEnvelope,
        lease_seconds: u64,
    ) -> Result<LeaseRenewal, ControlPlaneError>;
    /// Atomically ingest result event into Control inbox after rechecking current fencing state.
    fn publish_result(&self, event: &WorkerResultEvent)
    -> Result<PublishResult, ControlPlaneError>;
    /// Atomically accept provider terminal result after rechecking current lease and owner epoch.
    fn publish_provider_result(
        &self,
        _event: &ProviderResultEvent,
    ) -> Result<PublishResult, ControlPlaneError> {
        Err(ControlPlaneError::NotSent(
            "provider result endpoint is not configured".into(),
        ))
    }
    /// Reserve an externally visible side effect. Default is fail-closed for legacy clients.
    fn reserve_execution_fence(
        &self,
        _request: &ExecutionFenceRequest,
    ) -> Result<ExecutionFence, ControlPlaneError> {
        Err(ControlPlaneError::NotSent(
            "authoritative execution-fence reservation is not configured".into(),
        ))
    }
    /// Complete the exact reservation with a durable Control receipt.
    fn complete_execution_fence(
        &self,
        _fence: &ExecutionFence,
        _completion: &ExecutionFenceCompletion,
    ) -> Result<ExecutionFenceCompletionReceipt, ControlPlaneError> {
        Err(ControlPlaneError::NotSent(
            "authoritative execution-fence completion is not configured".into(),
        ))
    }
}

/// Borrowed verifier adapter that avoids unstable trait-object upcasting on
/// the worker's pinned Rust 1.85 toolchain.
struct ControlPlaneClaimVerifier<'a>(&'a dyn ControlPlane);

impl TaskClaimVerifier for ControlPlaneClaimVerifier<'_> {
    fn verify(&self, claim: &TaskClaimEnvelope) -> Result<(), String> {
        self.0.verify(claim)
    }
}

/// Worker supervisor policy.
#[derive(Debug, Clone)]
pub struct SupervisorConfig {
    /// Lease duration requested from Control, 15..=600 seconds.
    pub lease_seconds: u64,
    /// Maximum time to wait for a Control call is owned by transport implementation.
    pub poll_interval: Duration,
    /// Stable worker identity.
    pub worker_id: String,
}

impl SupervisorConfig {
    /// Validate supervisor settings.
    pub fn validate(&self) -> Result<(), SupervisorError> {
        if self.worker_id.trim().is_empty()
            || self.worker_id.len() > 256
            || !(15..=600).contains(&self.lease_seconds)
            || self.poll_interval < Duration::from_millis(100)
            || self.poll_interval > Duration::from_secs(60)
        {
            return Err(SupervisorError::Configuration);
        }
        Ok(())
    }
}

/// One worker loop iteration result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunOutcome {
    /// No claim was available.
    Idle,
    /// Claim was already durably received by this worker.
    Duplicate,
    /// Claim was executed and its result durably queued for Control.
    Executed(WorkerOutcome),
}

/// Supervisor failure.
#[derive(Debug, Error)]
pub enum SupervisorError {
    /// Invalid worker settings.
    #[error("worker supervisor configuration is invalid")]
    Configuration,
    /// Claim rejected before execution.
    #[error("worker claim rejected: {0}")]
    Claim(String),
    /// Durable local persistence failed.
    #[error(transparent)]
    Store(#[from] WorkerStoreError),
    /// Control transport failed.
    #[error(transparent)]
    Control(#[from] ControlPlaneError),
    /// Worker execution failed before a durable result could be written.
    #[error("worker execution evidence could not be persisted: {0}")]
    Execution(String),
}

/// Lease-aware execution supervisor. It never decides workflow lifecycle state.
pub struct WorkerSupervisor<'a> {
    config: SupervisorConfig,
    control: Arc<dyn ControlPlane>,
    store: &'a WorkerStore,
    executor: &'a WorkerExecutor<'a>,
    provider_adapters: BTreeMap<String, Arc<dyn ProviderAdapter>>,
}

impl<'a> WorkerSupervisor<'a> {
    /// Compose worker with its private database, sandbox and Control API client.
    pub fn new(
        config: SupervisorConfig,
        control: Arc<dyn ControlPlane>,
        store: &'a WorkerStore,
        executor: &'a WorkerExecutor<'a>,
    ) -> Result<Self, SupervisorError> {
        config.validate()?;
        Ok(Self {
            config,
            control,
            store,
            executor,
            provider_adapters: BTreeMap::new(),
        })
    }

    /// Register explicit provider capabilities available to claims on this worker.
    pub fn with_provider_adapters(
        mut self,
        adapters: BTreeMap<String, Arc<dyn ProviderAdapter>>,
    ) -> Self {
        self.provider_adapters = adapters;
        self
    }

    /// Recover interrupted claims, receive and execute at most one new claim, then flush one result.
    pub fn run_once(&self) -> Result<RunOutcome, SupervisorError> {
        self.store.recover_interrupted(&self.config.worker_id)?;
        let (envelope, is_recovered_received) =
            match self.store.next_received_claim(&self.config.worker_id)? {
                Some(claim) => (Some(claim), true),
                None => (self.control.receive_claim(&self.config.worker_id)?, false),
            };
        let Some(envelope) = envelope else {
            self.flush_outbox_once()?;
            return Ok(RunOutcome::Idle);
        };
        let now = Utc::now();
        if is_recovered_received && claim_expired_before_start(&envelope, now) {
            return self.finish_received_not_started(
                &envelope,
                "claim or session message expired before execution began",
            );
        }
        let claim_verifier = ControlPlaneClaimVerifier(self.control.as_ref());
        let verified = VerifiedTaskClaim::verify(
            envelope.clone(),
            &self.config.worker_id,
            now,
            &claim_verifier,
        )
        .map_err(|error| SupervisorError::Claim(error.to_string()))?;
        let initial_renewal = self
            .control
            .renew_lease(&envelope, self.config.lease_seconds)?;
        validate_renewal(&envelope, &initial_renewal, self.config.lease_seconds)?;
        if claim_expired_before_start(&envelope, Utc::now()) {
            if is_recovered_received {
                return self.finish_received_not_started(
                    &envelope,
                    "claim or session message expired before execution began",
                );
            }
            return Err(SupervisorError::Claim(
                "claim or session message expired before durable execution start".into(),
            ));
        }
        let _inserted = self.store.accept_claim(&envelope)?;
        let Some(durable_claim) = self.store.try_begin_claim_with_session_messages(
            verified.claim_id(),
            &self.config.worker_id,
            envelope.owner_epoch,
            &envelope.session_messages,
        )?
        else {
            return Ok(RunOutcome::Duplicate);
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        let (heartbeat_stop, heartbeat_stop_rx) = mpsc::channel();
        let heartbeat = HeartbeatGuard::new(
            heartbeat_stop,
            spawn_heartbeat(
                self.control.clone(),
                durable_claim.clone(),
                self.config.lease_seconds,
                self.config.poll_interval,
                cancelled.clone(),
                heartbeat_stop_rx,
            ),
        );
        let provider_outcome = self.dispatch_provider_once(&durable_claim, &cancelled);
        if let Some((outcome, diagnostic)) = provider_outcome? {
            return self.finish_without_sandbox(&durable_claim, outcome, diagnostic, heartbeat);
        }
        if cancelled.load(Ordering::Acquire) {
            let outcome = if durable_claim.provider_dispatch.is_some() {
                WorkerOutcome::Unknown
            } else {
                WorkerOutcome::NotStarted
            };
            return self.finish_without_sandbox(
                &durable_claim,
                outcome,
                "lease ownership lost before sandbox start".into(),
                heartbeat,
            );
        }
        if let Err(diagnostic) = self.renew_current_lease(&durable_claim) {
            let outcome = if durable_claim.provider_dispatch.is_some() {
                WorkerOutcome::Unknown
            } else {
                WorkerOutcome::NotStarted
            };
            return self.finish_without_sandbox(&durable_claim, outcome, diagnostic, heartbeat);
        }
        if cancelled.load(Ordering::Acquire) {
            let outcome = if durable_claim.provider_dispatch.is_some() {
                WorkerOutcome::Unknown
            } else {
                WorkerOutcome::NotStarted
            };
            return self.finish_without_sandbox(
                &durable_claim,
                outcome,
                "lease ownership lost before sandbox start".into(),
                heartbeat,
            );
        }
        let workspace = match self.executor.allocate_workspace(&durable_claim) {
            Ok(workspace) => workspace,
            Err(error) => {
                return self.finish_without_sandbox(
                    &durable_claim,
                    WorkerOutcome::NotStarted,
                    format!("per-execution quota workspace could not be allocated: {error}"),
                    heartbeat,
                );
            }
        };
        let sandbox_profile_sha256 = self
            .executor
            .execution_profile_sha256_for_workspace(workspace.as_ref());
        let Some(sandbox_profile_sha256) =
            sandbox_profile_sha256.filter(|value| valid_digest(value))
        else {
            let cleanup = self
                .executor
                .finish_workspace(workspace.as_ref(), WorkerOutcome::NotStarted);
            return self.finish_without_sandbox(
                &durable_claim,
                WorkerOutcome::NotStarted,
                format!("sandbox backend did not provide a stable execution profile digest; fenced start was denied; workspace cleanup: {}", cleanup.err().map(|error| error.to_string()).unwrap_or_else(|| "verified".into())),
                heartbeat,
            );
        };
        let sandbox_request_sha256 = content_hash(&serde_json::json!({
            "schema_version": 1,
            "command": durable_claim.command,
            "command_sha256": durable_claim.command_sha256,
            "sandbox_profile_sha256": sandbox_profile_sha256
        }))
        .map_err(|error| SupervisorError::Claim(error.to_string()))?;
        let sandbox_fence = match self.reserve_side_effect_fence(
            &durable_claim,
            ExecutionFenceKind::SandboxStart,
            &format!(
                "sandbox-start:{}:{}:{}",
                durable_claim.claim_id, durable_claim.attempt, durable_claim.owner_epoch
            ),
            &sandbox_request_sha256,
        ) {
            Ok(fence) => fence,
            Err(error) => {
                // The sandbox start call has not happened, so the workspace
                // itself is safe to release even if the reservation response
                // was ambiguous. A failed cleanup quarantines its project ID.
                let cleanup = self
                    .executor
                    .finish_workspace(workspace.as_ref(), WorkerOutcome::NotStarted);
                return self.finish_without_sandbox(
                    &durable_claim,
                    WorkerOutcome::NotStarted,
                    format!(
                        "Control did not provide an authoritative sandbox-start fence: {error}; workspace cleanup: {}",
                        cleanup.err().map(|error| error.to_string()).unwrap_or_else(|| "verified".into())
                    ),
                    heartbeat,
                );
            }
        };
        let execution = self.executor.execute_cancellable_in_workspace(
            &verified,
            &cancelled,
            workspace.as_ref(),
        );
        let heartbeat_result = heartbeat.finish()?;
        let evidence = match execution {
            Ok(evidence) => Some(evidence),
            Err(error) => {
                let diagnostic = format!("execution or evidence persistence failed: {error}");
                let event = result_event(
                    &durable_claim,
                    self.config.worker_id.as_str(),
                    WorkerOutcome::Unknown,
                    None,
                    Some(diagnostic.clone()),
                );
                let observation = serde_json::to_value(&event)
                    .map_err(|error| SupervisorError::Execution(error.to_string()))?;
                self.complete_side_effect_fence(
                    &sandbox_fence,
                    WorkerOutcome::Unknown,
                    &event.event_id,
                    &observation,
                )?;
                self.store.complete_claim(&event)?;
                self.flush_outbox_once()?;
                return Ok(RunOutcome::Executed(WorkerOutcome::Unknown));
            }
        };
        let Some(evidence) = evidence else {
            return Err(SupervisorError::Execution(
                "execution returned neither evidence nor an error".into(),
            ));
        };
        let outcome = if heartbeat_result.is_err() {
            WorkerOutcome::Unknown
        } else {
            evidence.outcome
        };
        let diagnostic = heartbeat_result.err();
        let event = result_event(
            &durable_claim,
            &self.config.worker_id,
            outcome,
            Some(evidence),
            diagnostic,
        );
        let observation = serde_json::to_value(&event)
            .map_err(|error| SupervisorError::Execution(error.to_string()))?;
        self.complete_side_effect_fence(&sandbox_fence, outcome, &event.event_id, &observation)?;
        self.store.complete_claim(&event)?;
        self.flush_outbox_once()?;
        Ok(RunOutcome::Executed(outcome))
    }

    fn renew_current_lease(&self, claim: &TaskClaimEnvelope) -> Result<(), String> {
        let renewal = self
            .control
            .renew_lease(claim, self.config.lease_seconds)
            .map_err(|error| error.to_string())?;
        validate_renewal(claim, &renewal, self.config.lease_seconds)
            .map_err(|error| error.to_string())
    }

    fn reserve_side_effect_fence(
        &self,
        claim: &TaskClaimEnvelope,
        kind: ExecutionFenceKind,
        side_effect_id: &str,
        request_sha256: &str,
    ) -> Result<ExecutionFence, ControlPlaneError> {
        let request =
            self.build_side_effect_fence_request(claim, kind, side_effect_id, request_sha256)?;
        self.control.reserve_execution_fence(&request)
    }

    fn build_side_effect_fence_request(
        &self,
        claim: &TaskClaimEnvelope,
        kind: ExecutionFenceKind,
        side_effect_id: &str,
        request_sha256: &str,
    ) -> Result<ExecutionFenceRequest, ControlPlaneError> {
        let acl_sha256 = claim
            .authenticator
            .get("acl_sha256")
            .and_then(serde_json::Value::as_str)
            .filter(|digest| valid_digest(digest))
            .ok_or_else(|| {
                ControlPlaneError::NotSent(
                    "authenticated claim omitted the signed ACL decision digest".into(),
                )
            })?;
        let idempotency_identity = serde_json::json!({
            "claim_id": claim.claim_id,
            "lease_id": claim.lease_id,
            "owner_epoch": claim.owner_epoch,
            "kind": kind,
            "side_effect_id": side_effect_id
        });
        let idempotency_key = format!(
            "worker-fence:{}",
            content_hash(&idempotency_identity)
                .map_err(|error| ControlPlaneError::NotSent(error.to_string()))?
        );
        Ok(ExecutionFenceRequest {
            claim_id: claim.claim_id.clone(),
            lease_id: claim.lease_id.clone(),
            worker_id: claim.worker_id.clone(),
            owner_epoch: claim.owner_epoch,
            plan_sha256: claim.plan_sha256.clone(),
            side_effect_id: side_effect_id.to_owned(),
            kind,
            request_sha256: request_sha256.to_owned(),
            idempotency_key,
            acl_sha256: acl_sha256.to_owned(),
        })
    }

    fn complete_side_effect_fence(
        &self,
        fence: &ExecutionFence,
        outcome: WorkerOutcome,
        event_id: &str,
        observation: &serde_json::Value,
    ) -> Result<(), ControlPlaneError> {
        complete_execution_fence(self.control.as_ref(), fence, outcome, event_id, observation)
    }

    fn finish_without_sandbox(
        &self,
        claim: &TaskClaimEnvelope,
        outcome: WorkerOutcome,
        diagnostic: String,
        heartbeat: HeartbeatGuard,
    ) -> Result<RunOutcome, SupervisorError> {
        let heartbeat_result = heartbeat.finish()?;
        let diagnostic = heartbeat_result.err().map_or(diagnostic.clone(), |error| {
            format!("{diagnostic}; lease heartbeat: {error}")
        });
        let event = result_event(
            claim,
            &self.config.worker_id,
            outcome,
            None,
            Some(diagnostic),
        );
        self.store.complete_claim(&event)?;
        self.flush_outbox_once()?;
        Ok(RunOutcome::Executed(outcome))
    }

    fn finish_received_not_started(
        &self,
        claim: &TaskClaimEnvelope,
        diagnostic: &str,
    ) -> Result<RunOutcome, SupervisorError> {
        let event = result_event(
            claim,
            &self.config.worker_id,
            WorkerOutcome::NotStarted,
            None,
            Some(diagnostic.into()),
        );
        self.store.complete_received_claim(&event)?;
        self.flush_outbox_once()?;
        Ok(RunOutcome::Executed(WorkerOutcome::NotStarted))
    }

    fn dispatch_provider_once(
        &self,
        claim: &TaskClaimEnvelope,
        cancelled: &AtomicBool,
    ) -> Result<Option<(WorkerOutcome, String)>, SupervisorError> {
        let Some(request) = &claim.provider_dispatch else {
            return Ok(None);
        };
        let Some(adapter) = self.provider_adapters.get(&request.provider_id) else {
            return Ok(Some((
                WorkerOutcome::NotStarted,
                format!(
                    "provider adapter '{}' is not configured on this worker",
                    request.provider_id
                ),
            )));
        };
        if adapter.provider_id() != request.provider_id {
            return Ok(Some((
                WorkerOutcome::NotStarted,
                "provider adapter identity does not match claim".into(),
            )));
        }
        let intent_identity = serde_json::json!({"provider_id":request.provider_id,"idempotency_key":request.idempotency_key});
        let intent_id = format!(
            "provider-intent:{}",
            content_hash(&intent_identity)
                .map_err(|error| SupervisorError::Claim(error.to_string()))?
        );
        let timestamp = claim.issued_at.clone();
        let intent = ProviderIntentRecord {
            intent_id: intent_id.clone(),
            request: ProviderIntentRequest {
                workflow_id: request.workflow_id.clone(),
                task_id: request.task_id.clone(),
                attempt: request.attempt,
                provider_id: request.provider_id.clone(),
                idempotency_key: request.idempotency_key.clone(),
                lease_id: request.lease_id.clone(),
                worker_id: request.worker_id.clone(),
                plan_sha256: request.plan_sha256.clone(),
                request_sha256: request.request_sha256.clone(),
                payload: Some(request.payload.clone()),
            },
            state: ProviderDispatchState::Reserved,
            provider_run_id: None,
            outcome: None,
            created_at: timestamp.clone(),
            updated_at: timestamp.clone(),
        };
        let dispatch = runalith_providers::ProviderDispatchRequest {
            provider_id: request.provider_id.clone(),
            idempotency_key: request.idempotency_key.clone(),
            workflow_id: request.workflow_id.clone(),
            task_id: request.task_id.clone(),
            attempt: request.attempt,
            lease_id: request.lease_id.clone(),
            worker_id: request.worker_id.clone(),
            plan_sha256: request.plan_sha256.clone(),
            request_sha256: request.request_sha256.clone(),
            payload: request.payload.clone(),
        };
        dispatch
            .validate_against_intent(&intent)
            .map_err(|error| SupervisorError::Claim(error.to_string()))?;
        if !self
            .store
            .reserve_provider_intent(&intent, claim.owner_epoch)?
        {
            return Ok(Some((
                WorkerOutcome::Unknown,
                "provider intent already exists; automatic dispatch replay is forbidden".into(),
            )));
        }
        // Renew after durable intent reservation and immediately before the
        // provider adapter call. This narrows the worker-side race window but
        // is not authoritative atomic fencing: Control must keep the owner
        // epoch pinned until this external side effect is terminal/reconciled.
        let not_started = self.renew_current_lease(claim).err().or_else(|| {
            cancelled
                .load(Ordering::Acquire)
                .then(|| "lease ownership lost before provider dispatch".into())
        });
        if let Some(diagnostic) = not_started {
            let response = ProviderDispatchResponse::Rejected {
                reason_code: "NOT_SENT".into(),
                diagnostic: diagnostic.clone(),
            };
            self.store.record_provider_dispatch_outcome(
                &intent_id,
                &response,
                &Utc::now().to_rfc3339(),
            )?;
            return Ok(Some((WorkerOutcome::NotStarted, diagnostic)));
        }
        let fence_request_sha256 =
            content_hash(&dispatch).map_err(|error| SupervisorError::Claim(error.to_string()))?;
        let fence_request = self.build_side_effect_fence_request(
            claim,
            ExecutionFenceKind::ProviderDispatch,
            &intent_id,
            &fence_request_sha256,
        )?;
        // Persist the complete idempotent request before crossing the Control
        // boundary. If Control commits the reservation but its HTTP response
        // is lost, ProviderPoller can repeat this exact request after restart.
        self.store
            .persist_provider_execution_fence_request(&intent_id, &fence_request)?;
        let fence = match self.control.reserve_execution_fence(&fence_request) {
            Ok(fence) => fence,
            Err(error) => {
                let outcome_unknown = matches!(error, ControlPlaneError::Unknown(_));
                let diagnostic = format!(
                    "provider dispatch was blocked because Control did not provide an authoritative fence: {error}"
                );
                let response = if outcome_unknown {
                    ProviderDispatchResponse::Unknown {
                        diagnostic: diagnostic.clone(),
                    }
                } else {
                    ProviderDispatchResponse::Rejected {
                        reason_code: "NOT_SENT".into(),
                        diagnostic: diagnostic.clone(),
                    }
                };
                self.store.record_provider_dispatch_outcome(
                    &intent_id,
                    &response,
                    &Utc::now().to_rfc3339(),
                )?;
                return Ok(Some((
                    if outcome_unknown {
                        WorkerOutcome::Unknown
                    } else {
                        WorkerOutcome::NotStarted
                    },
                    diagnostic,
                )));
            }
        };
        // Persist the remote reservation before the provider call. If the
        // worker crashes after reservation or dispatch, recovery can reconcile
        // and complete this exact fence rather than manufacturing a new one.
        self.store
            .persist_provider_execution_fence(&intent_id, &fence)?;

        let response = match adapter.dispatch(&dispatch) {
            Ok(response) => response,
            Err(ProviderAdapterError::NotSent(diagnostic)) => ProviderDispatchResponse::Rejected {
                reason_code: "NOT_SENT".into(),
                diagnostic,
            },
            Err(ProviderAdapterError::Ambiguous(diagnostic)) => {
                ProviderDispatchResponse::Unknown { diagnostic }
            }
        };
        let (run_outcome, diagnostic) = match &response {
            ProviderDispatchResponse::Accepted { provider_run_id } => (
                // Acceptance proves only that the provider created/accepted a
                // remote run, not that the remote effect is terminal. Keep
                // the authoritative reservation UNKNOWN until ProviderPoller
                // can bind terminal evidence and complete this same fence.
                None,
                Some(format!(
                    "provider dispatch accepted run {provider_run_id}; terminal reconciliation is pending"
                )),
            ),
            ProviderDispatchResponse::Rejected {
                reason_code,
                diagnostic,
            } if reason_code == "NOT_SENT" => (
                Some(WorkerOutcome::NotStarted),
                Some(format!(
                    "provider proved dispatch was not sent: {diagnostic}"
                )),
            ),
            ProviderDispatchResponse::Rejected {
                reason_code,
                diagnostic,
            } => (
                Some(WorkerOutcome::Failed),
                Some(format!(
                    "provider rejected dispatch ({reason_code}): {diagnostic}"
                )),
            ),
            ProviderDispatchResponse::Unknown { diagnostic } => {
                (Some(WorkerOutcome::Unknown), Some(diagnostic.clone()))
            }
        };
        // The initial adapter response is never terminal evidence. Even a
        // definitive rejection is reconciled through the exact provider
        // lookup path before Control releases this reservation; this avoids
        // a lost receipt racing a second, conflicting terminal event.
        let fence_outcome = WorkerOutcome::Unknown;
        let event_id = format!("provider-dispatch:{intent_id}");
        let observation = serde_json::json!({
            "schema_version": 1,
            "event_id": event_id,
            "intent_id": intent_id,
            "dispatch": dispatch,
            "response": response
        });
        if let Err(error) =
            self.complete_side_effect_fence(&fence, fence_outcome, &event_id, &observation)
        {
            return Ok(Some((
                WorkerOutcome::Unknown,
                format!(
                    "provider response was observed but its Control fence completion is unresolved; intent remains RESERVED for exact lookup reconciliation: {error}"
                ),
            )));
        }
        self.store.record_provider_dispatch_outcome(
            &intent_id,
            &response,
            &Utc::now().to_rfc3339(),
        )?;
        Ok(run_outcome.zip(diagnostic))
    }

    /// Publish one durable result. Stale events are acknowledged as rejected and never replayed.
    pub fn flush_outbox_once(&self) -> Result<bool, SupervisorError> {
        let Some(lease) = self.store.lease_outbox(&self.config.worker_id, 30)? else {
            return Ok(false);
        };
        match self.control.publish_result(&lease.event) {
            Ok(
                PublishResult::Accepted
                | PublishResult::AlreadyAccepted
                | PublishResult::StaleOwner,
            ) => self.store.ack_outbox(&lease)?,
            Err(
                ControlPlaneError::NotSent(_)
                | ControlPlaneError::Unknown(_)
                | ControlPlaneError::Unauthorized(_),
            ) => self
                .store
                .retry_outbox(&lease, backoff_seconds(lease.attempts))?,
            Err(ControlPlaneError::Rejected(diagnostic)) => {
                self.store.reject_outbox(&lease, &diagnostic)?;
            }
        }
        Ok(true)
    }

    /// Publish one provider result event through Control's fenced inbox.
    pub fn flush_provider_result_once(&self) -> Result<bool, SupervisorError> {
        let Some(lease) = self
            .store
            .lease_provider_result(&self.config.worker_id, 30)?
        else {
            return Ok(false);
        };
        match self.control.publish_provider_result(&lease.event) {
            Ok(
                PublishResult::Accepted
                | PublishResult::AlreadyAccepted
                | PublishResult::StaleOwner,
            ) => self.store.ack_provider_result(&lease)?,
            Err(
                ControlPlaneError::NotSent(_)
                | ControlPlaneError::Unknown(_)
                | ControlPlaneError::Unauthorized(_),
            ) => self
                .store
                .retry_provider_result(&lease, backoff_seconds(lease.attempts))?,
            Err(ControlPlaneError::Rejected(diagnostic)) => {
                self.store.reject_provider_result(&lease, &diagnostic)?;
            }
        }
        Ok(true)
    }
}

/// Complete an exact Control reservation and verify its durable receipt.
/// Shared with provider terminal reconciliation, which runs outside the task
/// supervisor after the provider's remote run has reached a terminal state.
pub(crate) fn complete_execution_fence(
    control: &dyn ControlPlane,
    fence: &ExecutionFence,
    outcome: WorkerOutcome,
    event_id: &str,
    observation: &serde_json::Value,
) -> Result<(), ControlPlaneError> {
    let event_sha256 =
        content_hash(observation).map_err(|error| ControlPlaneError::NotSent(error.to_string()))?;
    let outcome_sha256 = content_hash(&serde_json::json!({
        "outcome": outcome,
        "event_id": event_id,
        "event_sha256": event_sha256,
        "observation": observation
    }))
    .map_err(|error| ControlPlaneError::NotSent(error.to_string()))?;
    let completion = ExecutionFenceCompletion {
        fence_id: fence.fence_id.clone(),
        claim_id: fence.claim_id.clone(),
        lease_id: fence.lease_id.clone(),
        worker_id: fence.worker_id.clone(),
        owner_epoch: fence.owner_epoch,
        plan_sha256: fence.plan_sha256.clone(),
        side_effect_id: fence.side_effect_id.clone(),
        request_sha256: fence.request_sha256.clone(),
        outcome,
        event_id: event_id.to_owned(),
        event_sha256: event_sha256.clone(),
        outcome_sha256: outcome_sha256.clone(),
    };
    let receipt = control.complete_execution_fence(fence, &completion)?;
    if receipt.fence_id != fence.fence_id
        || receipt.claim_id != fence.claim_id
        || receipt.lease_id != fence.lease_id
        || receipt.worker_id != fence.worker_id
        || receipt.owner_epoch != fence.owner_epoch
        || receipt.plan_sha256 != fence.plan_sha256
        || receipt.side_effect_id != fence.side_effect_id
        || receipt.request_sha256 != fence.request_sha256
        || receipt.event_id != completion.event_id
        || receipt.event_sha256 != event_sha256
        || receipt.outcome_sha256 != outcome_sha256
        || !receipt.receipt.is_object()
    {
        return Err(ControlPlaneError::Unknown(
            "Control fence completion receipt did not bind the exact event and outcome".into(),
        ));
    }
    Ok(())
}

struct HeartbeatGuard {
    stop: Option<Sender<()>>,
    handle: Option<JoinHandle<Result<(), String>>>,
}

impl HeartbeatGuard {
    fn new(stop: Sender<()>, handle: JoinHandle<Result<(), String>>) -> Self {
        Self {
            stop: Some(stop),
            handle: Some(handle),
        }
    }

    fn finish(mut self) -> Result<Result<(), String>, SupervisorError> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.handle
            .take()
            .ok_or_else(|| {
                SupervisorError::Execution("lease heartbeat handle already joined".into())
            })?
            .join()
            .map_err(|_| SupervisorError::Execution("lease heartbeat thread panicked".into()))
    }
}

impl Drop for HeartbeatGuard {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn spawn_heartbeat(
    control: Arc<dyn ControlPlane>,
    claim: TaskClaimEnvelope,
    lease_seconds: u64,
    interval: Duration,
    cancelled: Arc<AtomicBool>,
    stop: Receiver<()>,
) -> thread::JoinHandle<Result<(), String>> {
    thread::spawn(move || {
        let renewal_interval = interval.min(Duration::from_secs((lease_seconds / 3).max(1)));
        loop {
            match stop.recv_timeout(renewal_interval) {
                Ok(()) | Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => {}
            }
            match control.renew_lease(&claim, lease_seconds) {
                Ok(renewal) if validate_renewal(&claim, &renewal, lease_seconds).is_ok() => {}
                Ok(_) => {
                    cancelled.store(true, Ordering::Release);
                    return Err("Control returned a mismatched or expired lease renewal".into());
                }
                Err(error) => {
                    cancelled.store(true, Ordering::Release);
                    return Err(error.to_string());
                }
            }
        }
        Ok(())
    })
}

fn validate_renewal(
    claim: &TaskClaimEnvelope,
    renewal: &LeaseRenewal,
    lease_seconds: u64,
) -> Result<(), SupervisorError> {
    if renewal.lease_id != claim.lease_id
        || renewal.owner_epoch != claim.owner_epoch
        || renewal.worker_id != claim.worker_id
        || renewal.expires_at
            <= Utc::now() + chrono::Duration::seconds((lease_seconds / 2).max(1) as i64)
    {
        return Err(SupervisorError::Claim(
            "Control lease renewal does not match current claim fencing identity".into(),
        ));
    }
    Ok(())
}

fn claim_expired_before_start(claim: &TaskClaimEnvelope, now: DateTime<Utc>) -> bool {
    DateTime::parse_from_rfc3339(&claim.expires_at)
        .map_or(true, |expiry| expiry.with_timezone(&Utc) <= now)
        || claim.session_messages.iter().any(|message| {
            DateTime::parse_from_rfc3339(&message.expires_at)
                .map_or(true, |expiry| expiry.with_timezone(&Utc) <= now)
        })
}

fn result_event(
    claim: &TaskClaimEnvelope,
    worker_id: &str,
    outcome: WorkerOutcome,
    evidence: Option<WorkerExecutionEvidence>,
    diagnostic: Option<String>,
) -> WorkerResultEvent {
    WorkerResultEvent {
        event_id: format!(
            "execution-result:{}:{}:{}",
            claim.claim_id, claim.owner_epoch, claim.attempt
        ),
        schema_version: 1,
        producer: worker_id.into(),
        workflow_id: claim.workflow_id.clone(),
        task_id: claim.task_id.clone(),
        attempt: claim.attempt,
        owner_epoch: claim.owner_epoch,
        lease_id: claim.lease_id.clone(),
        plan_sha256: claim.plan_sha256.clone(),
        claim_id: claim.claim_id.clone(),
        worker_id: worker_id.into(),
        command_sha256: claim.command_sha256.clone(),
        idempotency_key: claim.idempotency_key.clone(),
        outcome,
        evidence,
        diagnostic,
        created_at: Utc::now().to_rfc3339(),
    }
}

fn backoff_seconds(attempt: u64) -> u64 {
    2_u64.saturating_pow(attempt.min(10) as u32).min(900)
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        TaskClaimVerifier,
        tests::{FakeSandbox, envelope, result},
    };
    use runalith_artifacts::ArtifactStore;
    use runalith_providers::{
        ProviderAdapter, ProviderAdapterError, ProviderDispatchRequest, ProviderDispatchResponse,
        ProviderLookupResponse,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FakeControl {
        claim: Mutex<Option<TaskClaimEnvelope>>,
        renewals: AtomicUsize,
        published: Mutex<Vec<WorkerResultEvent>>,
        completed_fences: Mutex<Vec<ExecutionFenceCompletion>>,
        lose_lease: bool,
    }

    struct FenceUnavailableControl {
        claim: Mutex<Option<TaskClaimEnvelope>>,
        published: Mutex<Vec<WorkerResultEvent>>,
    }

    impl TaskClaimVerifier for FenceUnavailableControl {
        fn verify(&self, _: &TaskClaimEnvelope) -> Result<(), String> {
            Ok(())
        }
    }

    impl ControlPlane for FenceUnavailableControl {
        fn receive_claim(&self, _: &str) -> Result<Option<TaskClaimEnvelope>, ControlPlaneError> {
            Ok(self.claim.lock().unwrap().take())
        }

        fn renew_lease(
            &self,
            claim: &TaskClaimEnvelope,
            _: u64,
        ) -> Result<LeaseRenewal, ControlPlaneError> {
            Ok(LeaseRenewal {
                lease_id: claim.lease_id.clone(),
                owner_epoch: claim.owner_epoch,
                worker_id: claim.worker_id.clone(),
                expires_at: Utc::now() + chrono::Duration::minutes(1),
            })
        }

        fn publish_result(
            &self,
            event: &WorkerResultEvent,
        ) -> Result<PublishResult, ControlPlaneError> {
            self.published.lock().unwrap().push(event.clone());
            Ok(PublishResult::Accepted)
        }

        fn reserve_execution_fence(
            &self,
            _: &ExecutionFenceRequest,
        ) -> Result<ExecutionFence, ControlPlaneError> {
            Err(ControlPlaneError::Rejected(
                "worker execution-fence endpoint is unavailable".into(),
            ))
        }
    }

    struct FenceControl {
        claim: Mutex<Option<TaskClaimEnvelope>>,
        renewals: AtomicUsize,
        fail_on_renewal: usize,
        published: Mutex<Vec<WorkerResultEvent>>,
    }

    fn test_fence(request: &ExecutionFenceRequest) -> ExecutionFence {
        ExecutionFence {
            fence_id: format!("fence-{}", request.side_effect_id.replace(':', "-")),
            claim_id: request.claim_id.clone(),
            lease_id: request.lease_id.clone(),
            worker_id: request.worker_id.clone(),
            owner_epoch: request.owner_epoch,
            plan_sha256: request.plan_sha256.clone(),
            side_effect_id: request.side_effect_id.clone(),
            kind: request.kind,
            request_sha256: request.request_sha256.clone(),
            idempotency_key: request.idempotency_key.clone(),
            state: ExecutionFenceState::Reserved,
            receipt: serde_json::json!({"reservation_id":"test"}),
        }
    }

    fn test_fence_completion(
        fence: &ExecutionFence,
        completion: &ExecutionFenceCompletion,
    ) -> ExecutionFenceCompletionReceipt {
        ExecutionFenceCompletionReceipt {
            fence_id: fence.fence_id.clone(),
            claim_id: completion.claim_id.clone(),
            lease_id: completion.lease_id.clone(),
            worker_id: completion.worker_id.clone(),
            owner_epoch: completion.owner_epoch,
            plan_sha256: completion.plan_sha256.clone(),
            side_effect_id: completion.side_effect_id.clone(),
            request_sha256: completion.request_sha256.clone(),
            event_id: completion.event_id.clone(),
            event_sha256: completion.event_sha256.clone(),
            outcome_sha256: completion.outcome_sha256.clone(),
            receipt: serde_json::json!({"completed":true}),
        }
    }

    impl TaskClaimVerifier for FenceControl {
        fn verify(&self, _: &TaskClaimEnvelope) -> Result<(), String> {
            Ok(())
        }
    }
    impl ControlPlane for FenceControl {
        fn receive_claim(&self, _: &str) -> Result<Option<TaskClaimEnvelope>, ControlPlaneError> {
            Ok(self.claim.lock().unwrap().take())
        }
        fn renew_lease(
            &self,
            claim: &TaskClaimEnvelope,
            _: u64,
        ) -> Result<LeaseRenewal, ControlPlaneError> {
            let attempt = self.renewals.fetch_add(1, Ordering::SeqCst) + 1;
            if attempt == self.fail_on_renewal {
                return Err(ControlPlaneError::Unauthorized(
                    "owner epoch changed at side-effect fence".into(),
                ));
            }
            Ok(LeaseRenewal {
                lease_id: claim.lease_id.clone(),
                owner_epoch: claim.owner_epoch,
                worker_id: claim.worker_id.clone(),
                expires_at: Utc::now() + chrono::Duration::minutes(1),
            })
        }
        fn publish_result(
            &self,
            event: &WorkerResultEvent,
        ) -> Result<PublishResult, ControlPlaneError> {
            self.published.lock().unwrap().push(event.clone());
            Ok(PublishResult::Accepted)
        }
        fn reserve_execution_fence(
            &self,
            request: &ExecutionFenceRequest,
        ) -> Result<ExecutionFence, ControlPlaneError> {
            Ok(test_fence(request))
        }
        fn complete_execution_fence(
            &self,
            fence: &ExecutionFence,
            completion: &ExecutionFenceCompletion,
        ) -> Result<ExecutionFenceCompletionReceipt, ControlPlaneError> {
            Ok(test_fence_completion(fence, completion))
        }
    }
    use std::sync::Mutex;
    impl TaskClaimVerifier for FakeControl {
        fn verify(&self, _: &TaskClaimEnvelope) -> Result<(), String> {
            Ok(())
        }
    }
    impl ControlPlane for FakeControl {
        fn receive_claim(&self, _: &str) -> Result<Option<TaskClaimEnvelope>, ControlPlaneError> {
            Ok(self.claim.lock().unwrap().take())
        }
        fn renew_lease(
            &self,
            claim: &TaskClaimEnvelope,
            _: u64,
        ) -> Result<LeaseRenewal, ControlPlaneError> {
            self.renewals.fetch_add(1, Ordering::SeqCst);
            if self.lose_lease {
                return Err(ControlPlaneError::Unauthorized(
                    "owner epoch changed".into(),
                ));
            }
            Ok(LeaseRenewal {
                lease_id: claim.lease_id.clone(),
                owner_epoch: claim.owner_epoch,
                worker_id: claim.worker_id.clone(),
                expires_at: Utc::now() + chrono::Duration::minutes(1),
            })
        }
        fn publish_result(
            &self,
            event: &WorkerResultEvent,
        ) -> Result<PublishResult, ControlPlaneError> {
            self.published.lock().unwrap().push(event.clone());
            Ok(PublishResult::Accepted)
        }
        fn reserve_execution_fence(
            &self,
            request: &ExecutionFenceRequest,
        ) -> Result<ExecutionFence, ControlPlaneError> {
            Ok(test_fence(request))
        }
        fn complete_execution_fence(
            &self,
            fence: &ExecutionFence,
            completion: &ExecutionFenceCompletion,
        ) -> Result<ExecutionFenceCompletionReceipt, ControlPlaneError> {
            self.completed_fences
                .lock()
                .unwrap()
                .push(completion.clone());
            Ok(test_fence_completion(fence, completion))
        }
    }

    #[test]
    fn heartbeat_guard_finish_interrupts_long_idle_wait_without_extra_renewal() {
        let claim = envelope(Utc::now());
        let control = Arc::new(FakeControl {
            claim: Mutex::new(None),
            renewals: AtomicUsize::new(0),
            published: Mutex::new(Vec::new()),
            completed_fences: Mutex::new(Vec::new()),
            lose_lease: false,
        });
        let cancelled = Arc::new(AtomicBool::new(false));
        let (stop, stopped) = mpsc::channel();
        let guard = HeartbeatGuard::new(
            stop,
            spawn_heartbeat(
                control.clone(),
                claim,
                600,
                Duration::from_secs(30),
                cancelled.clone(),
                stopped,
            ),
        );

        let started = std::time::Instant::now();
        guard.finish().unwrap().unwrap();
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "stopping an idle heartbeat should wake its timeout wait immediately"
        );
        assert_eq!(control.renewals.load(Ordering::SeqCst), 0);
        assert!(!cancelled.load(Ordering::Acquire));
    }

    struct FakeProvider {
        calls: AtomicUsize,
        response: ProviderDispatchResponse,
    }
    impl ProviderAdapter for FakeProvider {
        fn provider_id(&self) -> &'static str {
            "fixture-provider"
        }
        fn dispatch(
            &self,
            _: &ProviderDispatchRequest,
        ) -> Result<ProviderDispatchResponse, ProviderAdapterError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.response.clone())
        }
        fn lookup(
            &self,
            _: &runalith_execution_persistence::ProviderIntentRecord,
        ) -> Result<ProviderLookupResponse, ProviderAdapterError> {
            Ok(ProviderLookupResponse::Unknown {
                diagnostic: "fixture lookup".into(),
            })
        }
    }

    fn provider_claim(now: DateTime<Utc>) -> TaskClaimEnvelope {
        let mut claim = envelope(now);
        let payload = serde_json::json!({"workflow":"release.yml","ref":"main","inputs":{"task_id":claim.task_id}});
        claim.provider_dispatch = Some(ProviderDispatchRequest {
            provider_id: "fixture-provider".into(),
            idempotency_key: "provider-idem-1".into(),
            workflow_id: claim.workflow_id.clone(),
            task_id: claim.task_id.clone(),
            attempt: claim.attempt,
            lease_id: claim.lease_id.clone(),
            worker_id: claim.worker_id.clone(),
            plan_sha256: claim.plan_sha256.clone(),
            request_sha256: content_hash(&payload).unwrap(),
            payload,
        });
        claim
    }

    fn session_message(
        claim: &TaskClaimEnvelope,
        now: DateTime<Utc>,
    ) -> crate::SessionDeliveryEnvelope {
        crate::SessionDeliveryEnvelope {
            message_id: "session-message-1".into(),
            idempotency_key: "session-idem-1".into(),
            workflow_id: claim.workflow_id.clone(),
            task_id: claim.task_id.clone(),
            attempt: claim.attempt,
            owner_epoch: claim.owner_epoch,
            lease_id: claim.lease_id.clone(),
            worker_id: claim.worker_id.clone(),
            session_id: "session-1".into(),
            recipient_role: "qa".into(),
            message_type: "task.completed".into(),
            payload: serde_json::json!({"text":"completed"}),
            expires_at: (now + chrono::Duration::minutes(30)).to_rfc3339(),
        }
    }

    #[test]
    fn supervisor_persists_result_before_fenced_publication_and_renews_lease() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let sandbox = FakeSandbox {
            calls: AtomicUsize::new(0),
            result: Ok(result()),
        };
        let executor = WorkerExecutor::new(&sandbox, &artifacts);
        let control = Arc::new(FakeControl {
            claim: Mutex::new(Some(envelope(Utc::now()))),
            renewals: AtomicUsize::new(0),
            published: Mutex::new(Vec::new()),
            completed_fences: Mutex::new(Vec::new()),
            lose_lease: false,
        });
        let supervisor = WorkerSupervisor::new(
            SupervisorConfig {
                worker_id: "worker-1".into(),
                lease_seconds: 15,
                poll_interval: Duration::from_millis(100),
            },
            control.clone(),
            &store,
            &executor,
        )
        .unwrap();
        assert_eq!(
            supervisor.run_once().unwrap(),
            RunOutcome::Executed(WorkerOutcome::Succeeded)
        );
        assert_eq!(control.published.lock().unwrap().len(), 1);
        assert!(control.renewals.load(Ordering::SeqCst) >= 1);
        assert_eq!(store.counts().unwrap()["outbox"], 1);
    }

    #[test]
    fn sandbox_start_is_fail_closed_when_control_fence_endpoint_is_unavailable() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let sandbox = FakeSandbox {
            calls: AtomicUsize::new(0),
            result: Ok(result()),
        };
        let executor = WorkerExecutor::new(&sandbox, &artifacts);
        let control = Arc::new(FenceUnavailableControl {
            claim: Mutex::new(Some(envelope(Utc::now()))),
            published: Mutex::new(Vec::new()),
        });
        let supervisor = WorkerSupervisor::new(
            SupervisorConfig {
                worker_id: "worker-1".into(),
                lease_seconds: 15,
                poll_interval: Duration::from_millis(100),
            },
            control.clone(),
            &store,
            &executor,
        )
        .unwrap();

        assert_eq!(
            supervisor.run_once().unwrap(),
            RunOutcome::Executed(WorkerOutcome::NotStarted)
        );
        assert_eq!(sandbox.calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            control.published.lock().unwrap()[0].outcome,
            WorkerOutcome::NotStarted
        );
    }

    #[test]
    fn provider_adapter_is_never_called_when_control_fence_is_unavailable() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let sandbox = FakeSandbox {
            calls: AtomicUsize::new(0),
            result: Ok(result()),
        };
        let executor = WorkerExecutor::new(&sandbox, &artifacts);
        let provider = Arc::new(FakeProvider {
            calls: AtomicUsize::new(0),
            response: ProviderDispatchResponse::Accepted {
                provider_run_id: "must-not-dispatch".into(),
            },
        });
        let adapters = BTreeMap::from([(
            "fixture-provider".into(),
            provider.clone() as Arc<dyn ProviderAdapter>,
        )]);
        let control = Arc::new(FenceUnavailableControl {
            claim: Mutex::new(Some(provider_claim(Utc::now()))),
            published: Mutex::new(Vec::new()),
        });
        let supervisor = WorkerSupervisor::new(
            SupervisorConfig {
                worker_id: "worker-1".into(),
                lease_seconds: 15,
                poll_interval: Duration::from_millis(100),
            },
            control,
            &store,
            &executor,
        )
        .unwrap()
        .with_provider_adapters(adapters);

        assert_eq!(
            supervisor.run_once().unwrap(),
            RunOutcome::Executed(WorkerOutcome::NotStarted)
        );
        assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
        assert_eq!(sandbox.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn stale_owner_result_is_not_accepted_by_control() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let claim = envelope(Utc::now());
        store.accept_claim(&claim).unwrap();
        store
            .begin_claim(&claim.claim_id, "worker-1", claim.owner_epoch)
            .unwrap();
        let event = result_event(
            &claim,
            "worker-1",
            WorkerOutcome::Unknown,
            None,
            Some("lease lost".into()),
        );
        store.complete_claim(&event).unwrap();
        struct Stale;
        impl TaskClaimVerifier for Stale {
            fn verify(&self, _: &TaskClaimEnvelope) -> Result<(), String> {
                Ok(())
            }
        }
        impl ControlPlane for Stale {
            fn receive_claim(
                &self,
                _: &str,
            ) -> Result<Option<TaskClaimEnvelope>, ControlPlaneError> {
                Ok(None)
            }
            fn renew_lease(
                &self,
                _: &TaskClaimEnvelope,
                _: u64,
            ) -> Result<LeaseRenewal, ControlPlaneError> {
                unreachable!()
            }
            fn publish_result(
                &self,
                _: &WorkerResultEvent,
            ) -> Result<PublishResult, ControlPlaneError> {
                Ok(PublishResult::StaleOwner)
            }
        }
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let sandbox = FakeSandbox {
            calls: AtomicUsize::new(0),
            result: Ok(result()),
        };
        let executor = WorkerExecutor::new(&sandbox, &artifacts);
        let supervisor = WorkerSupervisor::new(
            SupervisorConfig {
                worker_id: "worker-1".into(),
                lease_seconds: 15,
                poll_interval: Duration::from_millis(100),
            },
            Arc::new(Stale),
            &store,
            &executor,
        )
        .unwrap();
        assert!(supervisor.flush_outbox_once().unwrap());
        assert!(store.lease_outbox("worker-1", 30).unwrap().is_none());
    }

    #[test]
    fn permanent_control_rejection_quarantines_result_without_ack_or_retry() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let claim = envelope(Utc::now());
        store.accept_claim(&claim).unwrap();
        store
            .begin_claim(&claim.claim_id, &claim.worker_id, claim.owner_epoch)
            .unwrap();
        store
            .complete_claim(&result_event(
                &claim,
                "worker-1",
                WorkerOutcome::Unknown,
                None,
                Some("fixture".into()),
            ))
            .unwrap();
        struct RejectingControl;
        impl TaskClaimVerifier for RejectingControl {
            fn verify(&self, _: &TaskClaimEnvelope) -> Result<(), String> {
                Ok(())
            }
        }
        impl ControlPlane for RejectingControl {
            fn receive_claim(
                &self,
                _: &str,
            ) -> Result<Option<TaskClaimEnvelope>, ControlPlaneError> {
                Ok(None)
            }
            fn renew_lease(
                &self,
                _: &TaskClaimEnvelope,
                _: u64,
            ) -> Result<LeaseRenewal, ControlPlaneError> {
                unreachable!()
            }
            fn publish_result(
                &self,
                _: &WorkerResultEvent,
            ) -> Result<PublishResult, ControlPlaneError> {
                Err(ControlPlaneError::Rejected("HTTP 422".into()))
            }
        }
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let sandbox = FakeSandbox {
            calls: AtomicUsize::new(0),
            result: Ok(result()),
        };
        let executor = WorkerExecutor::new(&sandbox, &artifacts);
        let supervisor = WorkerSupervisor::new(
            SupervisorConfig {
                worker_id: "worker-1".into(),
                lease_seconds: 15,
                poll_interval: Duration::from_millis(100),
            },
            Arc::new(RejectingControl),
            &store,
            &executor,
        )
        .unwrap();
        assert!(supervisor.flush_outbox_once().unwrap());
        assert!(!supervisor.flush_outbox_once().unwrap());
        assert_eq!(store.counts().unwrap()["outbox_rejected"], 1);
        assert_eq!(store.counts().unwrap()["outbox"], 1);
    }

    #[test]
    fn claim_provider_dispatch_is_reserved_before_one_exact_send() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let sandbox = FakeSandbox {
            calls: AtomicUsize::new(0),
            result: Ok(result()),
        };
        let executor = WorkerExecutor::new(&sandbox, &artifacts);
        let provider = Arc::new(FakeProvider {
            calls: AtomicUsize::new(0),
            response: ProviderDispatchResponse::Accepted {
                provider_run_id: "run-42".into(),
            },
        });
        let adapters = BTreeMap::from([(
            "fixture-provider".into(),
            provider.clone() as Arc<dyn ProviderAdapter>,
        )]);
        let control = Arc::new(FakeControl {
            claim: Mutex::new(Some(provider_claim(Utc::now()))),
            renewals: AtomicUsize::new(0),
            published: Mutex::new(Vec::new()),
            completed_fences: Mutex::new(Vec::new()),
            lose_lease: false,
        });
        let supervisor = WorkerSupervisor::new(
            SupervisorConfig {
                worker_id: "worker-1".into(),
                lease_seconds: 15,
                poll_interval: Duration::from_millis(100),
            },
            control.clone(),
            &store,
            &executor,
        )
        .unwrap()
        .with_provider_adapters(adapters);
        assert_eq!(
            supervisor.run_once().unwrap(),
            RunOutcome::Executed(WorkerOutcome::Succeeded)
        );
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
        let completed_fences = control.completed_fences.lock().unwrap();
        assert!(completed_fences.iter().any(|completion| {
            completion.side_effect_id.starts_with("provider-intent:")
                && completion.outcome == WorkerOutcome::Unknown
        }));
        let intents = store.list_provider_intents_for_reconciliation(10).unwrap();
        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].intent.state, ProviderDispatchState::Accepted);
        assert_eq!(intents[0].intent.provider_run_id.as_deref(), Some("run-42"));
    }

    #[test]
    fn ambiguous_provider_dispatch_is_quarantined_and_stops_following_command_execution() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let sandbox = FakeSandbox {
            calls: AtomicUsize::new(0),
            result: Ok(result()),
        };
        let executor = WorkerExecutor::new(&sandbox, &artifacts);
        let provider = Arc::new(FakeProvider {
            calls: AtomicUsize::new(0),
            response: ProviderDispatchResponse::Unknown {
                diagnostic: "response lost".into(),
            },
        });
        let adapters = BTreeMap::from([(
            "fixture-provider".into(),
            provider.clone() as Arc<dyn ProviderAdapter>,
        )]);
        let control = Arc::new(FakeControl {
            claim: Mutex::new(Some(provider_claim(Utc::now()))),
            renewals: AtomicUsize::new(0),
            published: Mutex::new(Vec::new()),
            completed_fences: Mutex::new(Vec::new()),
            lose_lease: false,
        });
        let supervisor = WorkerSupervisor::new(
            SupervisorConfig {
                worker_id: "worker-1".into(),
                lease_seconds: 15,
                poll_interval: Duration::from_millis(100),
            },
            control,
            &store,
            &executor,
        )
        .unwrap()
        .with_provider_adapters(adapters);
        assert_eq!(
            supervisor.run_once().unwrap(),
            RunOutcome::Executed(WorkerOutcome::Unknown)
        );
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
        assert_eq!(sandbox.calls.load(Ordering::SeqCst), 0);
        let intents = store.list_provider_intents_for_reconciliation(10).unwrap();
        assert_eq!(intents[0].intent.state, ProviderDispatchState::Unknown);
    }

    #[test]
    fn authenticated_claim_session_messages_enter_durable_delivery_queue() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let sandbox = FakeSandbox {
            calls: AtomicUsize::new(0),
            result: Ok(result()),
        };
        let executor = WorkerExecutor::new(&sandbox, &artifacts);
        let now = Utc::now();
        let mut claim = envelope(now);
        let message = session_message(&claim, now);
        claim.session_messages.push(message);
        let control = Arc::new(FakeControl {
            claim: Mutex::new(Some(claim)),
            renewals: AtomicUsize::new(0),
            published: Mutex::new(Vec::new()),
            completed_fences: Mutex::new(Vec::new()),
            lose_lease: false,
        });
        let supervisor = WorkerSupervisor::new(
            SupervisorConfig {
                worker_id: "worker-1".into(),
                lease_seconds: 15,
                poll_interval: Duration::from_millis(100),
            },
            control,
            &store,
            &executor,
        )
        .unwrap();
        assert_eq!(
            supervisor.run_once().unwrap(),
            RunOutcome::Executed(WorkerOutcome::Succeeded)
        );
        let lease = store
            .lease_session_delivery("worker-1", 30)
            .unwrap()
            .unwrap();
        assert_eq!(lease.message.message_id, "session-message-1");
        assert_eq!(lease.message.owner_epoch, 7);
    }

    #[test]
    fn lease_renewal_must_cover_a_safe_fraction_of_requested_ttl() {
        let now = Utc::now();
        let claim = envelope(now);
        let short = LeaseRenewal {
            lease_id: claim.lease_id.clone(),
            owner_epoch: claim.owner_epoch,
            worker_id: claim.worker_id.clone(),
            expires_at: Utc::now() + chrono::Duration::seconds(2),
        };
        assert!(validate_renewal(&claim, &short, 15).is_err());
        let adequate = LeaseRenewal {
            expires_at: Utc::now() + chrono::Duration::seconds(10),
            ..short
        };
        assert!(validate_renewal(&claim, &adequate, 15).is_ok());
    }

    #[test]
    fn accepted_received_claim_is_resumed_after_crash_before_begin() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let claim = envelope(Utc::now());
        assert!(store.accept_claim(&claim).unwrap());
        let sandbox = FakeSandbox {
            calls: AtomicUsize::new(0),
            result: Ok(result()),
        };
        let executor = WorkerExecutor::new(&sandbox, &artifacts);
        let control = Arc::new(FakeControl {
            claim: Mutex::new(None),
            renewals: AtomicUsize::new(0),
            published: Mutex::new(Vec::new()),
            completed_fences: Mutex::new(Vec::new()),
            lose_lease: false,
        });
        let supervisor = WorkerSupervisor::new(
            SupervisorConfig {
                worker_id: "worker-1".into(),
                lease_seconds: 15,
                poll_interval: Duration::from_millis(100),
            },
            control,
            &store,
            &executor,
        )
        .unwrap();
        assert_eq!(
            supervisor.run_once().unwrap(),
            RunOutcome::Executed(WorkerOutcome::Succeeded)
        );
        assert_eq!(sandbox.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn expired_recovered_received_claim_is_finalized_not_started() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let mut claim = envelope(Utc::now());
        claim.expires_at = (Utc::now() - chrono::Duration::seconds(1)).to_rfc3339();
        store.accept_claim(&claim).unwrap();
        let sandbox = FakeSandbox {
            calls: AtomicUsize::new(0),
            result: Ok(result()),
        };
        let executor = WorkerExecutor::new(&sandbox, &artifacts);
        let control = Arc::new(FakeControl {
            claim: Mutex::new(None),
            renewals: AtomicUsize::new(0),
            published: Mutex::new(Vec::new()),
            completed_fences: Mutex::new(Vec::new()),
            lose_lease: false,
        });
        let supervisor = WorkerSupervisor::new(
            SupervisorConfig {
                worker_id: "worker-1".into(),
                lease_seconds: 15,
                poll_interval: Duration::from_millis(100),
            },
            control.clone(),
            &store,
            &executor,
        )
        .unwrap();
        assert_eq!(
            supervisor.run_once().unwrap(),
            RunOutcome::Executed(WorkerOutcome::NotStarted)
        );
        assert_eq!(sandbox.calls.load(Ordering::SeqCst), 0);
        assert_eq!(store.counts().unwrap()["outbox"], 1);
        assert_eq!(
            control.published.lock().unwrap()[0].outcome,
            WorkerOutcome::NotStarted
        );
    }

    #[test]
    fn lease_loss_before_provider_dispatch_prevents_provider_and_sandbox_side_effects() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let sandbox = FakeSandbox {
            calls: AtomicUsize::new(0),
            result: Ok(result()),
        };
        let executor = WorkerExecutor::new(&sandbox, &artifacts);
        let provider = Arc::new(FakeProvider {
            calls: AtomicUsize::new(0),
            response: ProviderDispatchResponse::Accepted {
                provider_run_id: "run-1".into(),
            },
        });
        let adapters = BTreeMap::from([(
            "fixture-provider".into(),
            provider.clone() as Arc<dyn ProviderAdapter>,
        )]);
        let control = Arc::new(FenceControl {
            claim: Mutex::new(Some(provider_claim(Utc::now()))),
            renewals: AtomicUsize::new(0),
            fail_on_renewal: 2,
            published: Mutex::new(Vec::new()),
        });
        let supervisor = WorkerSupervisor::new(
            SupervisorConfig {
                worker_id: "worker-1".into(),
                lease_seconds: 15,
                poll_interval: Duration::from_millis(100),
            },
            control.clone(),
            &store,
            &executor,
        )
        .unwrap()
        .with_provider_adapters(adapters);
        assert_eq!(
            supervisor.run_once().unwrap(),
            RunOutcome::Executed(WorkerOutcome::NotStarted)
        );
        assert_eq!(control.renewals.load(Ordering::SeqCst), 2);
        assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
        assert_eq!(sandbox.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn lease_loss_after_provider_acceptance_prevents_sandbox_start() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let sandbox = FakeSandbox {
            calls: AtomicUsize::new(0),
            result: Ok(result()),
        };
        let executor = WorkerExecutor::new(&sandbox, &artifacts);
        let provider = Arc::new(FakeProvider {
            calls: AtomicUsize::new(0),
            response: ProviderDispatchResponse::Accepted {
                provider_run_id: "run-1".into(),
            },
        });
        let adapters = BTreeMap::from([(
            "fixture-provider".into(),
            provider.clone() as Arc<dyn ProviderAdapter>,
        )]);
        let control = Arc::new(FenceControl {
            claim: Mutex::new(Some(provider_claim(Utc::now()))),
            renewals: AtomicUsize::new(0),
            fail_on_renewal: 3,
            published: Mutex::new(Vec::new()),
        });
        let supervisor = WorkerSupervisor::new(
            SupervisorConfig {
                worker_id: "worker-1".into(),
                lease_seconds: 15,
                poll_interval: Duration::from_millis(100),
            },
            control.clone(),
            &store,
            &executor,
        )
        .unwrap()
        .with_provider_adapters(adapters);
        assert_eq!(
            supervisor.run_once().unwrap(),
            RunOutcome::Executed(WorkerOutcome::Unknown)
        );
        assert_eq!(control.renewals.load(Ordering::SeqCst), 3);
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
        assert_eq!(sandbox.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn provider_reservation_error_stops_and_joins_lease_heartbeat() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let sandbox = FakeSandbox {
            calls: AtomicUsize::new(0),
            result: Ok(result()),
        };
        let executor = WorkerExecutor::new(&sandbox, &artifacts);
        let claim = provider_claim(Utc::now());
        let request = claim.provider_dispatch.as_ref().unwrap();
        let identity = serde_json::json!({"provider_id":request.provider_id,"idempotency_key":request.idempotency_key});
        let payload = serde_json::json!({"conflicting":"request"});
        let intent = ProviderIntentRecord {
            intent_id: format!("provider-intent:{}", content_hash(&identity).unwrap()),
            request: ProviderIntentRequest {
                workflow_id: request.workflow_id.clone(),
                task_id: request.task_id.clone(),
                attempt: request.attempt,
                provider_id: request.provider_id.clone(),
                idempotency_key: request.idempotency_key.clone(),
                lease_id: request.lease_id.clone(),
                worker_id: request.worker_id.clone(),
                plan_sha256: request.plan_sha256.clone(),
                request_sha256: content_hash(&payload).unwrap(),
                payload: Some(payload),
            },
            state: ProviderDispatchState::Reserved,
            provider_run_id: None,
            outcome: None,
            created_at: claim.issued_at.clone(),
            updated_at: claim.issued_at.clone(),
        };
        store
            .reserve_provider_intent(&intent, claim.owner_epoch)
            .unwrap();
        let provider = Arc::new(FakeProvider {
            calls: AtomicUsize::new(0),
            response: ProviderDispatchResponse::Accepted {
                provider_run_id: "run-1".into(),
            },
        });
        let adapters = BTreeMap::from([(
            "fixture-provider".into(),
            provider.clone() as Arc<dyn ProviderAdapter>,
        )]);
        let control = Arc::new(FakeControl {
            claim: Mutex::new(Some(claim)),
            renewals: AtomicUsize::new(0),
            published: Mutex::new(Vec::new()),
            completed_fences: Mutex::new(Vec::new()),
            lose_lease: false,
        });
        let supervisor = WorkerSupervisor::new(
            SupervisorConfig {
                worker_id: "worker-1".into(),
                lease_seconds: 15,
                poll_interval: Duration::from_millis(100),
            },
            control.clone(),
            &store,
            &executor,
        )
        .unwrap()
        .with_provider_adapters(adapters);
        assert!(supervisor.run_once().is_err());
        thread::sleep(Duration::from_millis(150));
        assert_eq!(control.renewals.load(Ordering::SeqCst), 1);
        assert_eq!(sandbox.calls.load(Ordering::SeqCst), 0);
        assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn lease_loss_before_sandbox_start_returns_not_started_without_execution() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let sandbox = FakeSandbox {
            calls: AtomicUsize::new(0),
            result: Ok(result()),
        };
        let executor = WorkerExecutor::new(&sandbox, &artifacts);
        let control = Arc::new(FenceControl {
            claim: Mutex::new(Some(envelope(Utc::now()))),
            renewals: AtomicUsize::new(0),
            fail_on_renewal: 2,
            published: Mutex::new(Vec::new()),
        });
        let supervisor = WorkerSupervisor::new(
            SupervisorConfig {
                worker_id: "worker-1".into(),
                lease_seconds: 15,
                poll_interval: Duration::from_millis(100),
            },
            control,
            &store,
            &executor,
        )
        .unwrap();
        assert_eq!(
            supervisor.run_once().unwrap(),
            RunOutcome::Executed(WorkerOutcome::NotStarted)
        );
        assert_eq!(sandbox.calls.load(Ordering::SeqCst), 0);
    }
}
