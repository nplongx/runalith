//! Read-only provider polling, reconciliation and terminal evidence collection.

use std::{collections::BTreeMap, sync::Arc};

use chrono::Utc;
use runalith_artifacts::ArtifactStore;
use runalith_execution_persistence::{ProviderIntentRecord, ProviderReconciliationObservation};
use runalith_providers::{
    ProviderAdapter, ProviderAdapterError, ProviderDispatchResponse, ProviderLookupResponse,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    WorkerOutcome, WorkerStore, WorkerStoreError,
    supervisor::{ControlPlane, complete_execution_fence},
};

/// Verified terminal provider result supplied by a provider-specific collector.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderTerminalResult {
    /// Exact provider run identity.
    pub provider_run_id: String,
    /// Classified terminal result.
    pub outcome: WorkerOutcome,
    /// Provider result metadata with secrets removed.
    pub result: Value,
    /// Exact downloaded result artifact bytes.
    pub artifact_bytes: Vec<u8>,
    /// Artifact media type.
    pub media_type: String,
}

/// Collects and verifies result artifacts for an exact terminal provider run.
pub trait ProviderResultCollector: Send + Sync {
    /// Download and validate result artifact against exact immutable intent and run identity.
    fn collect(
        &self,
        intent: &ProviderIntentRecord,
        provider_run_id: &str,
        conclusion: &str,
    ) -> Result<Option<ProviderTerminalResult>, ProviderAdapterError>;
}

/// Provider polling report.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProviderPollReport {
    /// Number of intents queried.
    pub observed: usize,
    /// Number of previously unknown/reserved runs bound to exact provider run IDs.
    pub runs_bound: usize,
    /// Number of terminal result artifacts collected.
    pub results_collected: usize,
    /// Number of unresolved lookup outcomes.
    pub unresolved: usize,
}

/// Provider polling failure.
#[derive(Debug, Error)]
pub enum ProviderPollError {
    /// Worker persistence failed.
    #[error(transparent)]
    Store(#[from] WorkerStoreError),
    /// Provider adapter failed.
    #[error(transparent)]
    Adapter(#[from] ProviderAdapterError),
    /// Content-addressed artifact write failed.
    #[error("provider result artifact persistence failed: {0}")]
    Artifact(String),
    /// Provider returned conflicting or incomplete identity.
    #[error("provider result identity rejected: {0}")]
    Identity(&'static str),
}

/// Reconciles provider intents without dispatching or replaying any request.
pub struct ProviderPoller<'a> {
    store: &'a WorkerStore,
    artifacts: &'a ArtifactStore,
    adapters: BTreeMap<String, Arc<dyn ProviderAdapter>>,
    collector: Option<Arc<dyn ProviderResultCollector>>,
    control: Option<&'a dyn ControlPlane>,
}

impl<'a> ProviderPoller<'a> {
    /// Compose with explicit adapters and optional terminal artifact collector.
    pub fn new(
        store: &'a WorkerStore,
        artifacts: &'a ArtifactStore,
        adapters: BTreeMap<String, Arc<dyn ProviderAdapter>>,
        collector: Option<Arc<dyn ProviderResultCollector>>,
    ) -> Self {
        Self {
            store,
            artifacts,
            adapters,
            collector,
            control: None,
        }
    }

    /// Bind the authoritative Control client used to complete retained provider fences.
    pub fn with_control_plane(mut self, control: &'a dyn ControlPlane) -> Self {
        self.control = Some(control);
        self
    }

    /// Poll bounded pending/accepted/unknown intents. UNKNOWN can resolve from exact lookup evidence but never dispatches again.
    pub fn poll_once(&self, limit: u64) -> Result<ProviderPollReport, ProviderPollError> {
        let intents = self.store.list_provider_intents_for_reconciliation(limit)?;
        let mut report = ProviderPollReport::default();
        for fenced_intent in intents {
            if fenced_intent.owner_epoch == 0 {
                return Err(ProviderPollError::Identity(
                    "provider intent omitted owner epoch",
                ));
            }
            let mut execution_fence = fenced_intent.execution_fence;
            let intent = fenced_intent.intent;
            if let Some(control) = self.control {
                if execution_fence.is_none() {
                    let Some(request) = fenced_intent.execution_fence_request.as_ref() else {
                        // Legacy intents created before request journaling may
                        // already have escaped the old process boundary. Do not
                        // manufacture a reservation after that fact.
                        report.unresolved += 1;
                        continue;
                    };
                    if request.side_effect_id != intent.intent_id
                        || request.kind != crate::ExecutionFenceKind::ProviderDispatch
                        || request.owner_epoch != fenced_intent.owner_epoch
                        || request.lease_id != intent.request.lease_id
                        || request.worker_id != intent.request.worker_id
                        || request.plan_sha256 != intent.request.plan_sha256
                    {
                        return Err(ProviderPollError::Identity(
                            "persisted provider fence request does not match immutable intent",
                        ));
                    }
                    // Re-run Store's full immutable claim/ACL/payload-digest/
                    // idempotency validation on the journal before sending it
                    // back to Control. UNKNOWN is accepted here only for the
                    // exact pre-existing journal; it cannot create a new one.
                    self.store
                        .persist_provider_execution_fence_request(&intent.intent_id, request)?;
                    // The request was durably persisted before the original
                    // Control call. The v1 authority contract requires an
                    // exact retry to return the original durable reservation;
                    // retrying this reservation cannot dispatch the provider.
                    let fence = match control.reserve_execution_fence(request) {
                        Ok(fence) => fence,
                        Err(_) => {
                            report.unresolved += 1;
                            continue;
                        }
                    };
                    self.store
                        .persist_provider_execution_fence(&intent.intent_id, &fence)?;
                    execution_fence = Some(fence);
                }
            }
            let Some(adapter) = self.adapters.get(&intent.request.provider_id) else {
                report.unresolved += 1;
                continue;
            };
            let lookup = adapter.lookup(&intent)?;
            report.observed += 1;
            let response = serde_json::to_value(&lookup)
                .map_err(|_| ProviderPollError::Identity("lookup response serialization"))?;
            let provider_run_id = match &lookup {
                ProviderLookupResponse::Found {
                    outcome: ProviderDispatchResponse::Accepted { provider_run_id },
                    ..
                } => Some(provider_run_id.clone()),
                _ => None,
            };
            let observation = ProviderReconciliationObservation {
                observation_id: Uuid::new_v4().to_string(),
                intent_id: intent.intent_id.clone(),
                provider_id: intent.request.provider_id.clone(),
                idempotency_key: intent.request.idempotency_key.clone(),
                provider_run_id: provider_run_id.clone(),
                response: response.clone(),
                response_sha256: runalith_domain::content_hash(&response)
                    .map_err(|_| ProviderPollError::Identity("lookup response digest"))?,
                observed_at: Utc::now().to_rfc3339(),
            };
            self.store.append_provider_observation(&observation)?;
            match lookup {
                ProviderLookupResponse::Found {
                    outcome: ProviderDispatchResponse::Accepted { provider_run_id },
                    provider_status,
                    conclusion,
                    ..
                } => {
                    if intent.provider_run_id.as_deref() != Some(provider_run_id.as_str()) {
                        self.store.bind_provider_run(
                            &intent.intent_id,
                            &provider_run_id,
                            &observation.observed_at,
                        )?;
                        report.runs_bound += 1;
                    }
                    if provider_status
                        .as_deref()
                        .is_some_and(|status| status.eq_ignore_ascii_case("completed"))
                    {
                        if let Some(conclusion) = conclusion.as_deref() {
                            let collected = if let Some(collector) = &self.collector {
                                collector.collect(&intent, &provider_run_id, conclusion)?
                            } else if let Some(artifact) =
                                adapter.collect_terminal_result(&intent, &provider_run_id)?
                            {
                                let result: Value = serde_json::from_slice(&artifact.bytes)
                                    .map_err(|_| {
                                        ProviderPollError::Identity(
                                            "terminal provider evidence is not valid JSON",
                                        )
                                    })?;
                                let outcome = match artifact.conclusion.as_str() {
                                    "success" => WorkerOutcome::Succeeded,
                                    "failure" | "cancelled" | "timed_out" | "startup_failure"
                                    | "action_required" | "stale" | "neutral" | "skipped" => {
                                        WorkerOutcome::Failed
                                    }
                                    _ => {
                                        report.unresolved += 1;
                                        continue;
                                    }
                                };
                                Some(ProviderTerminalResult {
                                    provider_run_id: artifact.provider_run_id,
                                    outcome,
                                    result,
                                    artifact_bytes: artifact.bytes,
                                    media_type: artifact.media_type,
                                })
                            } else {
                                None
                            };
                            if let Some(result) = collected {
                                if result.provider_run_id != provider_run_id
                                    || !matches!(
                                        result.outcome,
                                        WorkerOutcome::Succeeded | WorkerOutcome::Failed
                                    )
                                    || result.artifact_bytes.is_empty()
                                {
                                    return Err(ProviderPollError::Identity(
                                        "terminal result did not bind exact run or terminal outcome",
                                    ));
                                }
                                if (conclusion == "success")
                                    != (result.outcome == WorkerOutcome::Succeeded)
                                {
                                    return Err(ProviderPollError::Identity(
                                        "terminal result outcome conflicts with provider conclusion",
                                    ));
                                }
                                let artifact = self
                                    .artifacts
                                    .put(&result.media_type, &result.artifact_bytes)
                                    .map_err(|error| {
                                        ProviderPollError::Artifact(error.to_string())
                                    })?;
                                let state = if result.outcome == WorkerOutcome::Succeeded {
                                    "SUCCEEDED"
                                } else {
                                    "FAILED"
                                };
                                let persisted = json!({"provider_run_id":provider_run_id,"conclusion":conclusion,"outcome":result.outcome,"result":result.result,"artifact":artifact});
                                if let Some(fence) = execution_fence.as_ref() {
                                    let Some(control) = self.control else {
                                        report.unresolved += 1;
                                        continue;
                                    };
                                    if fence.side_effect_id != intent.intent_id
                                        || fence.kind != crate::ExecutionFenceKind::ProviderDispatch
                                        || fence.owner_epoch != fenced_intent.owner_epoch
                                        || fence.lease_id != intent.request.lease_id
                                        || fence.worker_id != intent.request.worker_id
                                        || fence.plan_sha256 != intent.request.plan_sha256
                                    {
                                        return Err(ProviderPollError::Identity(
                                            "persisted execution fence does not match provider intent",
                                        ));
                                    }
                                    let event_id = format!(
                                        "provider-terminal:{}:{}",
                                        intent.intent_id, provider_run_id
                                    );
                                    let terminal_observation = json!({
                                        "schema_version": 1,
                                        "intent_id": intent.intent_id,
                                        "provider_id": intent.request.provider_id,
                                        "provider_run_id": provider_run_id,
                                        "owner_epoch": fenced_intent.owner_epoch,
                                        "conclusion": conclusion,
                                        "outcome": result.outcome,
                                        "result": persisted
                                    });
                                    if complete_execution_fence(
                                        control,
                                        fence,
                                        result.outcome,
                                        &event_id,
                                        &terminal_observation,
                                    )
                                    .is_err()
                                    {
                                        // Keep the local intent ACCEPTED/UNKNOWN and
                                        // retry this exact completion on the next poll.
                                        // ArtifactStore.put is content-addressed/idempotent.
                                        report.unresolved += 1;
                                        continue;
                                    }
                                }
                                self.store.finalize_provider_result(
                                    &intent.intent_id,
                                    &provider_run_id,
                                    state,
                                    &persisted,
                                    &Utc::now().to_rfc3339(),
                                )?;
                                report.results_collected += 1;
                            } else {
                                report.unresolved += 1;
                            }
                        } else {
                            report.unresolved += 1;
                        }
                    }
                }
                ProviderLookupResponse::Found {
                    outcome: ProviderDispatchResponse::Rejected { .. },
                    ..
                } => {
                    if let Some(fence) = execution_fence.as_ref() {
                        let Some(control) = self.control else {
                            report.unresolved += 1;
                            continue;
                        };
                        if intent.provider_run_id.is_some()
                            || fence.side_effect_id != intent.intent_id
                            || fence.owner_epoch != fenced_intent.owner_epoch
                        {
                            report.unresolved += 1;
                            continue;
                        }
                        let event_id = format!("provider-rejected:{}", intent.intent_id);
                        let observation = json!({
                            "schema_version": 1,
                            "intent_id": intent.intent_id,
                            "provider_id": intent.request.provider_id,
                            "lookup": response,
                            "owner_epoch": fenced_intent.owner_epoch
                        });
                        if complete_execution_fence(
                            control,
                            fence,
                            WorkerOutcome::NotStarted,
                            &event_id,
                            &observation,
                        )
                        .is_err()
                        {
                            report.unresolved += 1;
                            continue;
                        }
                    }
                    self.store.record_provider_rejection(
                        &intent.intent_id,
                        &response,
                        &observation.observed_at,
                    )?;
                }
                ProviderLookupResponse::NotFound {
                    authoritative: true,
                    pages_scanned,
                    query_scope,
                } => {
                    if pages_scanned == 0 || query_scope.trim().is_empty() {
                        report.unresolved += 1;
                        continue;
                    }
                    if let Some(fence) = execution_fence.as_ref() {
                        let Some(control) = self.control else {
                            report.unresolved += 1;
                            continue;
                        };
                        if intent.provider_run_id.is_some()
                            || fence.side_effect_id != intent.intent_id
                            || fence.owner_epoch != fenced_intent.owner_epoch
                        {
                            report.unresolved += 1;
                            continue;
                        }
                        let event_id = format!("provider-absent:{}", intent.intent_id);
                        let observation = json!({
                            "schema_version": 1,
                            "intent_id": intent.intent_id,
                            "provider_id": intent.request.provider_id,
                            "authoritative": true,
                            "pages_scanned": pages_scanned,
                            "query_scope": query_scope,
                            "owner_epoch": fenced_intent.owner_epoch
                        });
                        if complete_execution_fence(
                            control,
                            fence,
                            WorkerOutcome::NotStarted,
                            &event_id,
                            &observation,
                        )
                        .is_err()
                        {
                            report.unresolved += 1;
                            continue;
                        }
                    }
                    self.store.record_provider_rejection(
                        &intent.intent_id,
                        &response,
                        &observation.observed_at,
                    )?;
                }
                ProviderLookupResponse::Found {
                    outcome: ProviderDispatchResponse::Unknown { .. },
                    ..
                }
                | ProviderLookupResponse::NotFound {
                    authoritative: false,
                    ..
                }
                | ProviderLookupResponse::Unknown { .. } => report.unresolved += 1,
            }
        }
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ControlPlane, ControlPlaneError, ExecutionFence, ExecutionFenceCompletion,
        ExecutionFenceCompletionReceipt, ExecutionFenceKind, ExecutionFenceRequest,
        ExecutionFenceState, LeaseRenewal, PublishResult, TaskClaimEnvelope, TaskClaimVerifier,
        WorkerResultEvent, tests::envelope,
    };
    use runalith_execution_persistence::{ProviderDispatchState, ProviderIntentRequest};
    use runalith_providers::{
        ProviderDispatchRequest, ProviderDispatchResponse, ProviderLookupResponse,
    };
    use std::sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    struct FakeProvider {
        dispatches: AtomicUsize,
        lookup: ProviderLookupResponse,
    }
    impl ProviderAdapter for FakeProvider {
        fn provider_id(&self) -> &'static str {
            "fixture-provider"
        }
        fn dispatch(
            &self,
            _: &ProviderDispatchRequest,
        ) -> Result<ProviderDispatchResponse, ProviderAdapterError> {
            self.dispatches.fetch_add(1, Ordering::SeqCst);
            Ok(ProviderDispatchResponse::Accepted {
                provider_run_id: "should-not-dispatch".into(),
            })
        }
        fn lookup(
            &self,
            _: &ProviderIntentRecord,
        ) -> Result<ProviderLookupResponse, ProviderAdapterError> {
            Ok(self.lookup.clone())
        }
    }
    struct FakeCollector;
    impl ProviderResultCollector for FakeCollector {
        fn collect(
            &self,
            _: &ProviderIntentRecord,
            provider_run_id: &str,
            _: &str,
        ) -> Result<Option<ProviderTerminalResult>, ProviderAdapterError> {
            Ok(Some(ProviderTerminalResult {
                provider_run_id: provider_run_id.into(),
                outcome: WorkerOutcome::Succeeded,
                result: json!({"tests":4}),
                artifact_bytes: b"verified-result".to_vec(),
                media_type: "application/octet-stream".into(),
            }))
        }
    }

    struct FakeFenceControl {
        fail_next_completion: AtomicBool,
        completions: Mutex<Vec<ExecutionFenceCompletion>>,
        reserve_response: Option<ExecutionFence>,
        reservations: Mutex<Vec<ExecutionFenceRequest>>,
    }

    impl TaskClaimVerifier for FakeFenceControl {
        fn verify(&self, _: &TaskClaimEnvelope) -> Result<(), String> {
            Ok(())
        }
    }

    impl ControlPlane for FakeFenceControl {
        fn receive_claim(&self, _: &str) -> Result<Option<TaskClaimEnvelope>, ControlPlaneError> {
            Ok(None)
        }

        fn renew_lease(
            &self,
            _: &TaskClaimEnvelope,
            _: u64,
        ) -> Result<LeaseRenewal, ControlPlaneError> {
            Err(ControlPlaneError::NotSent("not used in poller test".into()))
        }

        fn publish_result(
            &self,
            _: &WorkerResultEvent,
        ) -> Result<PublishResult, ControlPlaneError> {
            Err(ControlPlaneError::NotSent("not used in poller test".into()))
        }

        fn reserve_execution_fence(
            &self,
            request: &ExecutionFenceRequest,
        ) -> Result<ExecutionFence, ControlPlaneError> {
            self.reservations.lock().unwrap().push(request.clone());
            let fence = self.reserve_response.as_ref().ok_or_else(|| {
                ControlPlaneError::NotSent("fence reservation not expected in this test".into())
            })?;
            if fence.claim_id != request.claim_id
                || fence.lease_id != request.lease_id
                || fence.worker_id != request.worker_id
                || fence.owner_epoch != request.owner_epoch
                || fence.plan_sha256 != request.plan_sha256
                || fence.side_effect_id != request.side_effect_id
                || fence.kind != request.kind
                || fence.request_sha256 != request.request_sha256
                || fence.idempotency_key != request.idempotency_key
                || !fence.receipt.is_object()
            {
                return Err(ControlPlaneError::Unknown(
                    "fixture reservation does not match exact idempotent request".into(),
                ));
            }
            Ok(fence.clone())
        }

        fn complete_execution_fence(
            &self,
            fence: &ExecutionFence,
            completion: &ExecutionFenceCompletion,
        ) -> Result<ExecutionFenceCompletionReceipt, ControlPlaneError> {
            self.completions.lock().unwrap().push(completion.clone());
            if self.fail_next_completion.swap(false, Ordering::SeqCst) {
                return Err(ControlPlaneError::Unknown(
                    "simulated lost terminal fence receipt".into(),
                ));
            }
            Ok(ExecutionFenceCompletionReceipt {
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
                receipt: json!({"durable":true}),
            })
        }
    }

    fn provider_fence_request(
        claim: &TaskClaimEnvelope,
        intent: &ProviderIntentRecord,
    ) -> ExecutionFenceRequest {
        let payload = intent.request.payload.clone().unwrap();
        let dispatch = ProviderDispatchRequest {
            provider_id: intent.request.provider_id.clone(),
            idempotency_key: intent.request.idempotency_key.clone(),
            workflow_id: intent.request.workflow_id.clone(),
            task_id: intent.request.task_id.clone(),
            attempt: intent.request.attempt,
            lease_id: intent.request.lease_id.clone(),
            worker_id: intent.request.worker_id.clone(),
            plan_sha256: intent.request.plan_sha256.clone(),
            request_sha256: intent.request.request_sha256.clone(),
            payload,
        };
        let idempotency_identity = json!({
            "claim_id": claim.claim_id,
            "lease_id": claim.lease_id,
            "owner_epoch": claim.owner_epoch,
            "kind": ExecutionFenceKind::ProviderDispatch,
            "side_effect_id": intent.intent_id
        });
        ExecutionFenceRequest {
            claim_id: claim.claim_id.clone(),
            lease_id: claim.lease_id.clone(),
            worker_id: claim.worker_id.clone(),
            owner_epoch: claim.owner_epoch,
            plan_sha256: claim.plan_sha256.clone(),
            side_effect_id: intent.intent_id.clone(),
            kind: ExecutionFenceKind::ProviderDispatch,
            request_sha256: runalith_domain::content_hash(&dispatch).unwrap(),
            idempotency_key: format!(
                "worker-fence:{}",
                runalith_domain::content_hash(&idempotency_identity).unwrap()
            ),
            acl_sha256: claim.authenticator["acl_sha256"].as_str().unwrap().into(),
        }
    }

    fn fence_from_request(fence_id: &str, request: &ExecutionFenceRequest) -> ExecutionFence {
        ExecutionFence {
            fence_id: fence_id.into(),
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
            receipt: json!({"reservation_id":fence_id,"durable":true}),
        }
    }

    #[test]
    fn lost_control_reservation_response_is_retried_exactly_after_restart_without_provider_dispatch()
     {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("worker.db");
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let claim = envelope(Utc::now());
        let payload = json!({"workflow":"build.yml","ref":"main"});
        let intent = ProviderIntentRecord {
            intent_id: "provider-intent-lost-reservation-response".into(),
            request: ProviderIntentRequest {
                workflow_id: claim.workflow_id.clone(),
                task_id: claim.task_id.clone(),
                attempt: claim.attempt,
                provider_id: "fixture-provider".into(),
                idempotency_key: "provider-idempotency-lost-reservation".into(),
                lease_id: claim.lease_id.clone(),
                worker_id: claim.worker_id.clone(),
                plan_sha256: claim.plan_sha256.clone(),
                request_sha256: runalith_domain::content_hash(&payload).unwrap(),
                payload: Some(payload),
            },
            state: ProviderDispatchState::Reserved,
            provider_run_id: None,
            outcome: None,
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        };
        let request = provider_fence_request(&claim, &intent);
        {
            let store = WorkerStore::open(&database).unwrap();
            store.accept_claim(&claim).unwrap();
            store
                .begin_claim(&claim.claim_id, &claim.worker_id, claim.owner_epoch)
                .unwrap();
            store
                .reserve_provider_intent(&intent, claim.owner_epoch)
                .unwrap();
            store
                .persist_provider_execution_fence_request(&intent.intent_id, &request)
                .unwrap();
            store
                .record_provider_dispatch_outcome(
                    &intent.intent_id,
                    &ProviderDispatchResponse::Unknown {
                        diagnostic:
                            "Control may have committed the reservation but its response was lost"
                                .into(),
                    },
                    &Utc::now().to_rfc3339(),
                )
                .unwrap();
            store
                .complete_claim(&WorkerResultEvent {
                    event_id: format!(
                        "execution-result:{}:{}:{}",
                        claim.claim_id, claim.owner_epoch, claim.attempt
                    ),
                    schema_version: 1,
                    producer: claim.worker_id.clone(),
                    workflow_id: claim.workflow_id.clone(),
                    task_id: claim.task_id.clone(),
                    attempt: claim.attempt,
                    owner_epoch: claim.owner_epoch,
                    lease_id: claim.lease_id.clone(),
                    plan_sha256: claim.plan_sha256.clone(),
                    claim_id: claim.claim_id.clone(),
                    worker_id: claim.worker_id.clone(),
                    command_sha256: claim.command_sha256.clone(),
                    idempotency_key: claim.idempotency_key.clone(),
                    outcome: WorkerOutcome::Unknown,
                    evidence: None,
                    diagnostic: Some("Control reservation outcome is unknown".into()),
                    created_at: Utc::now().to_rfc3339(),
                })
                .unwrap();
        }

        let store = WorkerStore::open(&database).unwrap();
        let provider = Arc::new(FakeProvider {
            dispatches: AtomicUsize::new(0),
            lookup: ProviderLookupResponse::NotFound {
                authoritative: true,
                pages_scanned: 1,
                query_scope: "exact provider idempotency key".into(),
            },
        });
        let adapters = BTreeMap::from([(
            "fixture-provider".into(),
            provider.clone() as Arc<dyn ProviderAdapter>,
        )]);
        let fence = fence_from_request("recovered-fence-01", &request);
        let control = FakeFenceControl {
            fail_next_completion: AtomicBool::new(false),
            completions: Mutex::new(Vec::new()),
            reserve_response: Some(fence.clone()),
            reservations: Mutex::new(Vec::new()),
        };
        let poller =
            ProviderPoller::new(&store, &artifacts, adapters, None).with_control_plane(&control);
        let report = poller.poll_once(10).unwrap();

        assert_eq!(report.observed, 1);
        assert_eq!(report.unresolved, 0);
        assert_eq!(provider.dispatches.load(Ordering::SeqCst), 0);
        assert_eq!(*control.reservations.lock().unwrap(), vec![request.clone()]);
        let recovered = store.list_provider_intents_for_reconciliation(10).unwrap();
        assert!(recovered.is_empty());
        let (state, _) = store.provider_result(&intent.intent_id).unwrap().unwrap();
        assert_eq!(state, "REJECTED");
        let completions = control.completions.lock().unwrap();
        assert_eq!(completions.len(), 1);
        assert_eq!(completions[0].fence_id, fence.fence_id);
        assert_eq!(completions[0].outcome, WorkerOutcome::NotStarted);
    }

    #[test]
    fn crash_after_fence_request_journal_before_control_call_recovers_reserved_intent_after_restart()
     {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("worker.db");
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let claim = envelope(Utc::now());
        let payload = json!({"workflow":"build.yml","ref":"main"});
        let intent = ProviderIntentRecord {
            intent_id: "provider-intent-crash-before-control-call".into(),
            request: ProviderIntentRequest {
                workflow_id: claim.workflow_id.clone(),
                task_id: claim.task_id.clone(),
                attempt: claim.attempt,
                provider_id: "fixture-provider".into(),
                idempotency_key: "provider-idempotency-before-control-call".into(),
                lease_id: claim.lease_id.clone(),
                worker_id: claim.worker_id.clone(),
                plan_sha256: claim.plan_sha256.clone(),
                request_sha256: runalith_domain::content_hash(&payload).unwrap(),
                payload: Some(payload),
            },
            state: ProviderDispatchState::Reserved,
            provider_run_id: None,
            outcome: None,
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        };
        let request = provider_fence_request(&claim, &intent);
        {
            let store = WorkerStore::open(&database).unwrap();
            store.accept_claim(&claim).unwrap();
            store
                .begin_claim(&claim.claim_id, &claim.worker_id, claim.owner_epoch)
                .unwrap();
            store
                .reserve_provider_intent(&intent, claim.owner_epoch)
                .unwrap();
            // This is the exact durable boundary immediately before the
            // Control call. The provider intent deliberately remains RESERVED
            // to model process death before a response (or result write).
            store
                .persist_provider_execution_fence_request(&intent.intent_id, &request)
                .unwrap();
            store
                .complete_claim(&WorkerResultEvent {
                    event_id: format!(
                        "execution-result:{}:{}:{}",
                        claim.claim_id, claim.owner_epoch, claim.attempt
                    ),
                    schema_version: 1,
                    producer: claim.worker_id.clone(),
                    workflow_id: claim.workflow_id.clone(),
                    task_id: claim.task_id.clone(),
                    attempt: claim.attempt,
                    owner_epoch: claim.owner_epoch,
                    lease_id: claim.lease_id.clone(),
                    plan_sha256: claim.plan_sha256.clone(),
                    claim_id: claim.claim_id.clone(),
                    worker_id: claim.worker_id.clone(),
                    command_sha256: claim.command_sha256.clone(),
                    idempotency_key: claim.idempotency_key.clone(),
                    outcome: WorkerOutcome::Unknown,
                    evidence: None,
                    diagnostic: Some("worker crashed after the pre-call fence journal".into()),
                    created_at: Utc::now().to_rfc3339(),
                })
                .unwrap();
        }

        let store = WorkerStore::open(&database).unwrap();
        let provider = Arc::new(FakeProvider {
            dispatches: AtomicUsize::new(0),
            lookup: ProviderLookupResponse::NotFound {
                authoritative: true,
                pages_scanned: 1,
                query_scope: "exact provider idempotency key".into(),
            },
        });
        let adapters = BTreeMap::from([(
            "fixture-provider".into(),
            provider.clone() as Arc<dyn ProviderAdapter>,
        )]);
        let fence = fence_from_request("recovered-pre-call-fence", &request);
        let control = FakeFenceControl {
            fail_next_completion: AtomicBool::new(false),
            completions: Mutex::new(Vec::new()),
            reserve_response: Some(fence.clone()),
            reservations: Mutex::new(Vec::new()),
        };
        let poller =
            ProviderPoller::new(&store, &artifacts, adapters, None).with_control_plane(&control);
        let report = poller.poll_once(10).unwrap();

        assert_eq!(report.observed, 1);
        assert_eq!(report.unresolved, 0);
        assert_eq!(*control.reservations.lock().unwrap(), vec![request]);
        assert_eq!(provider.dispatches.load(Ordering::SeqCst), 0);
        let (state, _) = store.provider_result(&intent.intent_id).unwrap().unwrap();
        assert_eq!(state, "REJECTED");
        let completions = control.completions.lock().unwrap();
        assert_eq!(completions.len(), 1);
        assert_eq!(completions[0].fence_id, fence.fence_id);
        assert_eq!(completions[0].outcome, WorkerOutcome::NotStarted);
    }

    #[test]
    fn tampered_persisted_fence_request_is_rejected_before_control_retry() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("worker.db");
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let claim = envelope(Utc::now());
        let payload = json!({"workflow":"build.yml","ref":"main"});
        let intent = ProviderIntentRecord {
            intent_id: "provider-intent-tampered-reservation-journal".into(),
            request: ProviderIntentRequest {
                workflow_id: claim.workflow_id.clone(),
                task_id: claim.task_id.clone(),
                attempt: claim.attempt,
                provider_id: "fixture-provider".into(),
                idempotency_key: "provider-idempotency-tampered-journal".into(),
                lease_id: claim.lease_id.clone(),
                worker_id: claim.worker_id.clone(),
                plan_sha256: claim.plan_sha256.clone(),
                request_sha256: runalith_domain::content_hash(&payload).unwrap(),
                payload: Some(payload),
            },
            state: ProviderDispatchState::Reserved,
            provider_run_id: None,
            outcome: None,
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        };
        let request = provider_fence_request(&claim, &intent);
        {
            let store = WorkerStore::open(&database).unwrap();
            store.accept_claim(&claim).unwrap();
            store
                .begin_claim(&claim.claim_id, &claim.worker_id, claim.owner_epoch)
                .unwrap();
            store
                .reserve_provider_intent(&intent, claim.owner_epoch)
                .unwrap();
            store
                .persist_provider_execution_fence_request(&intent.intent_id, &request)
                .unwrap();
            store
                .record_provider_dispatch_outcome(
                    &intent.intent_id,
                    &ProviderDispatchResponse::Unknown {
                        diagnostic: "Control reservation response was lost".into(),
                    },
                    &Utc::now().to_rfc3339(),
                )
                .unwrap();
            store
                .complete_claim(&WorkerResultEvent {
                    event_id: format!(
                        "execution-result:{}:{}:{}",
                        claim.claim_id, claim.owner_epoch, claim.attempt
                    ),
                    schema_version: 1,
                    producer: claim.worker_id.clone(),
                    workflow_id: claim.workflow_id.clone(),
                    task_id: claim.task_id.clone(),
                    attempt: claim.attempt,
                    owner_epoch: claim.owner_epoch,
                    lease_id: claim.lease_id.clone(),
                    plan_sha256: claim.plan_sha256.clone(),
                    claim_id: claim.claim_id.clone(),
                    worker_id: claim.worker_id.clone(),
                    command_sha256: claim.command_sha256.clone(),
                    idempotency_key: claim.idempotency_key.clone(),
                    outcome: WorkerOutcome::Unknown,
                    evidence: None,
                    diagnostic: Some("Control reservation outcome is unknown".into()),
                    created_at: Utc::now().to_rfc3339(),
                })
                .unwrap();
        }

        let raw = rusqlite::Connection::open(&database).unwrap();
        let stored_json: String = raw
            .query_row(
                "SELECT execution_fence_request_json FROM worker_provider_intents WHERE intent_id=?1",
                [&intent.intent_id],
                |row| row.get(0),
            )
            .unwrap();
        let mut tampered: ExecutionFenceRequest = serde_json::from_str(&stored_json).unwrap();
        tampered.idempotency_key.push_str("-rebound");
        raw.execute(
            "UPDATE worker_provider_intents SET execution_fence_request_json=?2 WHERE intent_id=?1",
            rusqlite::params![intent.intent_id, serde_json::to_string(&tampered).unwrap()],
        )
        .unwrap();
        drop(raw);

        let store = WorkerStore::open(&database).unwrap();
        let provider = Arc::new(FakeProvider {
            dispatches: AtomicUsize::new(0),
            lookup: ProviderLookupResponse::Unknown {
                diagnostic: "provider lookup must not run on a tampered reservation journal".into(),
            },
        });
        let adapters = BTreeMap::from([(
            "fixture-provider".into(),
            provider.clone() as Arc<dyn ProviderAdapter>,
        )]);
        let fence = fence_from_request("must-not-be-requested", &request);
        let control = FakeFenceControl {
            fail_next_completion: AtomicBool::new(false),
            completions: Mutex::new(Vec::new()),
            reserve_response: Some(fence),
            reservations: Mutex::new(Vec::new()),
        };
        let poller =
            ProviderPoller::new(&store, &artifacts, adapters, None).with_control_plane(&control);

        assert!(poller.poll_once(10).is_err());
        assert!(control.reservations.lock().unwrap().is_empty());
        assert!(control.completions.lock().unwrap().is_empty());
        assert_eq!(provider.dispatches.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn legacy_unknown_provider_intent_without_journaled_fence_request_stays_unresolved() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let payload = json!({"workflow":"legacy.yml","ref":"main"});
        let intent = ProviderIntentRecord {
            intent_id: "legacy-provider-intent-no-reservation-request".into(),
            request: ProviderIntentRequest {
                workflow_id: "workflow-legacy".into(),
                task_id: "task-legacy".into(),
                attempt: 1,
                provider_id: "fixture-provider".into(),
                idempotency_key: "legacy-provider-key".into(),
                lease_id: "legacy-lease".into(),
                worker_id: "worker-legacy".into(),
                plan_sha256: "a".repeat(64),
                request_sha256: runalith_domain::content_hash(&payload).unwrap(),
                payload: Some(payload),
            },
            state: ProviderDispatchState::Reserved,
            provider_run_id: None,
            outcome: None,
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        };
        store.reserve_provider_intent(&intent, 4).unwrap();
        store
            .record_provider_dispatch_outcome(
                &intent.intent_id,
                &ProviderDispatchResponse::Unknown {
                    diagnostic: "legacy unresolved reservation state".into(),
                },
                &Utc::now().to_rfc3339(),
            )
            .unwrap();
        let provider = Arc::new(FakeProvider {
            dispatches: AtomicUsize::new(0),
            lookup: ProviderLookupResponse::Unknown {
                diagnostic: "lookup must not run without a recoverable reservation identity".into(),
            },
        });
        let adapters = BTreeMap::from([(
            "fixture-provider".into(),
            provider.clone() as Arc<dyn ProviderAdapter>,
        )]);
        let control = FakeFenceControl {
            fail_next_completion: AtomicBool::new(false),
            completions: Mutex::new(Vec::new()),
            reserve_response: None,
            reservations: Mutex::new(Vec::new()),
        };
        let poller =
            ProviderPoller::new(&store, &artifacts, adapters, None).with_control_plane(&control);
        let report = poller.poll_once(10).unwrap();
        assert_eq!(report.observed, 0);
        assert_eq!(report.unresolved, 1);
        assert!(control.reservations.lock().unwrap().is_empty());
        assert_eq!(provider.dispatches.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn unknown_provider_intent_resolves_by_exact_lookup_and_collects_terminal_artifact_without_dispatch()
     {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let payload = json!({"workflow":"build.yml","ref":"main"});
        let request_sha256 = runalith_domain::content_hash(&payload).unwrap();
        let intent = ProviderIntentRecord {
            intent_id: "intent-7".into(),
            request: ProviderIntentRequest {
                workflow_id: "workflow-7".into(),
                task_id: "task-7".into(),
                attempt: 2,
                provider_id: "fixture-provider".into(),
                idempotency_key: "idempotency-7".into(),
                lease_id: "lease-7".into(),
                worker_id: "worker-7".into(),
                plan_sha256: "a".repeat(64),
                request_sha256: request_sha256.clone(),
                payload: Some(payload),
            },
            state: ProviderDispatchState::Reserved,
            provider_run_id: None,
            outcome: None,
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        };
        assert!(store.reserve_provider_intent(&intent, 9).unwrap());
        store
            .record_provider_dispatch_outcome(
                "intent-7",
                &runalith_providers::ProviderDispatchResponse::Unknown {
                    diagnostic: "send response lost".into(),
                },
                &Utc::now().to_rfc3339(),
            )
            .unwrap();
        let provider = Arc::new(FakeProvider {
            dispatches: AtomicUsize::new(0),
            lookup: ProviderLookupResponse::Found {
                outcome: ProviderDispatchResponse::Accepted {
                    provider_run_id: "provider-run-7".into(),
                },
                provider_status: Some("completed".into()),
                conclusion: Some("success".into()),
                run_url: None,
            },
        });
        let adapters = BTreeMap::from([(
            "fixture-provider".into(),
            provider.clone() as Arc<dyn ProviderAdapter>,
        )]);
        let poller =
            ProviderPoller::new(&store, &artifacts, adapters, Some(Arc::new(FakeCollector)));
        let report = poller.poll_once(10).unwrap();
        assert_eq!(report.runs_bound, 1);
        assert_eq!(report.results_collected, 1);
        assert_eq!(provider.dispatches.load(Ordering::SeqCst), 0);
        let (state, result) = store.provider_result("intent-7").unwrap().unwrap();
        assert_eq!(state, "SUCCEEDED");
        let artifact: runalith_artifacts::StoredArtifact =
            serde_json::from_value(result.unwrap()["artifact"].clone()).unwrap();
        assert_eq!(artifacts.read(&artifact).unwrap(), b"verified-result");
    }

    #[test]
    fn terminal_provider_reconciliation_retries_exact_fence_completion_before_finalizing_result() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let claim = envelope(Utc::now());
        store.accept_claim(&claim).unwrap();
        store
            .begin_claim(&claim.claim_id, &claim.worker_id, claim.owner_epoch)
            .unwrap();
        let payload = json!({"workflow":"build.yml","ref":"main"});
        let payload_sha256 = runalith_domain::content_hash(&payload).unwrap();
        let intent = ProviderIntentRecord {
            intent_id: "provider-intent-fenced".into(),
            request: ProviderIntentRequest {
                workflow_id: claim.workflow_id.clone(),
                task_id: claim.task_id.clone(),
                attempt: claim.attempt,
                provider_id: "fixture-provider".into(),
                idempotency_key: "provider-idem-fenced".into(),
                lease_id: claim.lease_id.clone(),
                worker_id: claim.worker_id.clone(),
                plan_sha256: claim.plan_sha256.clone(),
                request_sha256: payload_sha256.clone(),
                payload: Some(payload.clone()),
            },
            state: ProviderDispatchState::Reserved,
            provider_run_id: None,
            outcome: None,
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        };
        assert!(
            store
                .reserve_provider_intent(&intent, claim.owner_epoch)
                .unwrap()
        );
        let dispatch = ProviderDispatchRequest {
            provider_id: intent.request.provider_id.clone(),
            idempotency_key: intent.request.idempotency_key.clone(),
            workflow_id: intent.request.workflow_id.clone(),
            task_id: intent.request.task_id.clone(),
            attempt: intent.request.attempt,
            lease_id: intent.request.lease_id.clone(),
            worker_id: intent.request.worker_id.clone(),
            plan_sha256: intent.request.plan_sha256.clone(),
            request_sha256: payload_sha256,
            payload,
        };
        let fence = ExecutionFence {
            fence_id: "provider-fence-fenced".into(),
            claim_id: claim.claim_id.clone(),
            lease_id: claim.lease_id.clone(),
            worker_id: claim.worker_id.clone(),
            owner_epoch: claim.owner_epoch,
            plan_sha256: claim.plan_sha256.clone(),
            side_effect_id: intent.intent_id.clone(),
            kind: ExecutionFenceKind::ProviderDispatch,
            request_sha256: runalith_domain::content_hash(&dispatch).unwrap(),
            idempotency_key: "worker-provider-fence-idem".into(),
            state: ExecutionFenceState::Reserved,
            receipt: json!({"reservation_id":"provider-fence-fenced"}),
        };
        store
            .persist_provider_execution_fence(&intent.intent_id, &fence)
            .unwrap();
        store
            .record_provider_dispatch_outcome(
                &intent.intent_id,
                &ProviderDispatchResponse::Unknown {
                    diagnostic: "provider accepted but response was lost".into(),
                },
                &Utc::now().to_rfc3339(),
            )
            .unwrap();

        let provider = Arc::new(FakeProvider {
            dispatches: AtomicUsize::new(0),
            lookup: ProviderLookupResponse::Found {
                outcome: ProviderDispatchResponse::Accepted {
                    provider_run_id: "provider-run-7".into(),
                },
                provider_status: Some("completed".into()),
                conclusion: Some("success".into()),
                run_url: None,
            },
        });
        let adapters = BTreeMap::from([(
            "fixture-provider".into(),
            provider.clone() as Arc<dyn ProviderAdapter>,
        )]);
        let control = FakeFenceControl {
            fail_next_completion: AtomicBool::new(true),
            completions: Mutex::new(Vec::new()),
            reserve_response: None,
            reservations: Mutex::new(Vec::new()),
        };
        let poller =
            ProviderPoller::new(&store, &artifacts, adapters, Some(Arc::new(FakeCollector)))
                .with_control_plane(&control);

        let first = poller.poll_once(10).unwrap();
        assert_eq!(first.observed, 1);
        assert_eq!(first.unresolved, 1);
        assert_eq!(
            store.provider_result(&intent.intent_id).unwrap(),
            Some(("ACCEPTED".into(), None))
        );

        let second = poller.poll_once(10).unwrap();
        assert_eq!(second.results_collected, 1);
        assert_eq!(second.unresolved, 0);
        assert_eq!(provider.dispatches.load(Ordering::SeqCst), 0);
        let completions = control.completions.lock().unwrap();
        assert_eq!(completions.len(), 2);
        assert_eq!(completions[0], completions[1]);
        assert_eq!(completions[1].outcome, WorkerOutcome::Succeeded);
        assert_eq!(
            completions[1].event_id,
            format!("provider-terminal:{}:provider-run-7", intent.intent_id)
        );
        let (state, result) = store.provider_result(&intent.intent_id).unwrap().unwrap();
        assert_eq!(state, "SUCCEEDED");
        let artifact: runalith_artifacts::StoredArtifact =
            serde_json::from_value(result.unwrap()["artifact"].clone()).unwrap();
        assert_eq!(artifacts.read(&artifact).unwrap(), b"verified-result");
    }

    #[test]
    fn rejected_dispatch_keeps_fence_unknown_until_authoritative_lookup_and_stops_reconciling() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let claim = envelope(Utc::now());
        store.accept_claim(&claim).unwrap();
        store
            .begin_claim(&claim.claim_id, &claim.worker_id, claim.owner_epoch)
            .unwrap();
        let payload = json!({"workflow":"build.yml","ref":"main"});
        let payload_sha256 = runalith_domain::content_hash(&payload).unwrap();
        let intent = ProviderIntentRecord {
            intent_id: "provider-intent-rejected".into(),
            request: ProviderIntentRequest {
                workflow_id: claim.workflow_id.clone(),
                task_id: claim.task_id.clone(),
                attempt: claim.attempt,
                provider_id: "fixture-provider".into(),
                idempotency_key: "provider-idem-rejected".into(),
                lease_id: claim.lease_id.clone(),
                worker_id: claim.worker_id.clone(),
                plan_sha256: claim.plan_sha256.clone(),
                request_sha256: payload_sha256.clone(),
                payload: Some(payload.clone()),
            },
            state: ProviderDispatchState::Reserved,
            provider_run_id: None,
            outcome: None,
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        };
        assert!(
            store
                .reserve_provider_intent(&intent, claim.owner_epoch)
                .unwrap()
        );
        let dispatch = ProviderDispatchRequest {
            provider_id: intent.request.provider_id.clone(),
            idempotency_key: intent.request.idempotency_key.clone(),
            workflow_id: intent.request.workflow_id.clone(),
            task_id: intent.request.task_id.clone(),
            attempt: intent.request.attempt,
            lease_id: intent.request.lease_id.clone(),
            worker_id: intent.request.worker_id.clone(),
            plan_sha256: intent.request.plan_sha256.clone(),
            request_sha256: payload_sha256,
            payload,
        };
        let fence = ExecutionFence {
            fence_id: "provider-fence-rejected".into(),
            claim_id: claim.claim_id.clone(),
            lease_id: claim.lease_id.clone(),
            worker_id: claim.worker_id.clone(),
            owner_epoch: claim.owner_epoch,
            plan_sha256: claim.plan_sha256.clone(),
            side_effect_id: intent.intent_id.clone(),
            kind: ExecutionFenceKind::ProviderDispatch,
            request_sha256: runalith_domain::content_hash(&dispatch).unwrap(),
            idempotency_key: "worker-provider-fence-rejected".into(),
            state: ExecutionFenceState::Reserved,
            receipt: json!({"reservation_id":"provider-fence-rejected"}),
        };
        store
            .persist_provider_execution_fence(&intent.intent_id, &fence)
            .unwrap();
        store
            .record_provider_dispatch_outcome(
                &intent.intent_id,
                &ProviderDispatchResponse::Rejected {
                    reason_code: "NOT_SENT".into(),
                    diagnostic: "provider rejected before send".into(),
                },
                &Utc::now().to_rfc3339(),
            )
            .unwrap();
        assert_eq!(
            store
                .list_provider_intents_for_reconciliation(10)
                .unwrap()
                .len(),
            1,
            "rejected intent with a retained execution fence must remain reconcilable"
        );

        let provider = Arc::new(FakeProvider {
            dispatches: AtomicUsize::new(0),
            lookup: ProviderLookupResponse::Found {
                outcome: ProviderDispatchResponse::Rejected {
                    reason_code: "NOT_SENT".into(),
                    diagnostic: "authoritative exact lookup confirms no run".into(),
                },
                provider_status: None,
                conclusion: None,
                run_url: None,
            },
        });
        let adapters = BTreeMap::from([(
            "fixture-provider".into(),
            provider.clone() as Arc<dyn ProviderAdapter>,
        )]);
        let control = FakeFenceControl {
            fail_next_completion: AtomicBool::new(false),
            completions: Mutex::new(Vec::new()),
            reserve_response: None,
            reservations: Mutex::new(Vec::new()),
        };
        let poller =
            ProviderPoller::new(&store, &artifacts, adapters, None).with_control_plane(&control);
        let first = poller.poll_once(10).unwrap();
        assert_eq!(first.observed, 1);
        assert_eq!(first.unresolved, 0);
        assert_eq!(control.completions.lock().unwrap().len(), 1);
        assert_eq!(
            control.completions.lock().unwrap()[0].outcome,
            WorkerOutcome::NotStarted
        );

        let second = poller.poll_once(10).unwrap();
        assert_eq!(second.observed, 0);
        assert!(
            store
                .list_provider_intents_for_reconciliation(10)
                .unwrap()
                .is_empty()
        );
        assert_eq!(provider.dispatches.load(Ordering::SeqCst), 0);
    }
}
