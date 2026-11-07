//! Read-only Execution Graph projection over durable workflow/task state.
//!
//! This crate does not execute processes or dispatch providers. It exposes the
//! exact current task/attempt/lease/result projection and explicitly marks the
//! absence of provider-run history and dispatch authority.

use runalith_domain::{TaskOutcome, TaskState, WorkflowState, content_hash};
use runalith_store::{ProviderDispatchState, ProviderIntentRecord, WorkflowView};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Dependency edge in the execution graph.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionDependency {
    /// Dependent task.
    pub task_id: String,
    /// Required task.
    pub depends_on_task_id: String,
}

/// Latest durable attempt projection. Earlier attempt history is not currently retained by the store.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecutionAttempt {
    /// Monotonic task attempt.
    pub attempt: u64,
    /// Current task state associated with this attempt.
    pub state: TaskState,
    /// Exact lease identity, absent after terminal/quarantined completion.
    pub lease_id: Option<String>,
    /// Exact worker identity, absent after terminal/quarantined completion.
    pub worker_id: Option<String>,
    /// Result outcome, absent while no result is recorded.
    pub outcome: Option<TaskOutcome>,
    /// Content-addressed evidence emitted by this attempt.
    pub evidence: Vec<runalith_domain::EvidenceRef>,
    /// Diagnostic, never interpreted as authority.
    pub diagnostic: Option<String>,
}

/// Task node in the Execution Graph.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecutionTaskNode {
    /// Stable task identity.
    pub task_id: String,
    /// Role pinned in immutable plan.
    pub role: String,
    /// Description pinned in immutable plan.
    pub description: String,
    /// Required evidence kinds.
    pub required_evidence: Vec<String>,
    /// Current task state.
    pub state: TaskState,
    /// Number of attempts issued.
    pub attempt_count: u64,
    /// Latest attempt only; no fabricated historical attempts.
    pub latest_attempt: Option<ExecutionAttempt>,
}

/// Read-only Execution Graph snapshot derived from a workflow's durable records.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecutionGraphSnapshot {
    /// Workflow identity.
    pub workflow_id: String,
    /// Workflow lifecycle state.
    pub workflow_state: WorkflowState,
    /// Exact proposal digest.
    pub proposal_sha256: String,
    /// Exact immutable plan digest, present after approval.
    pub plan_sha256: Option<String>,
    /// Approval record identity, not a standalone authority assertion.
    pub approval_id: Option<String>,
    /// Task nodes in plan order.
    pub tasks: Vec<ExecutionTaskNode>,
    /// Dependency edges.
    pub dependencies: Vec<ExecutionDependency>,
    /// Durable provider dispatch intents across task attempts.
    pub provider_dispatch_intents: Vec<ProviderIntentSummary>,
    /// Current workflow event-chain integrity result.
    pub event_chain_valid: bool,
    /// Historical attempt/provider-run completeness is explicit.
    pub history_completeness: String,
    /// Whether an accepted provider intent has a durable run ID.
    pub provider_run_identity_available: bool,
    /// This projection cannot authorize provider dispatch.
    pub dispatch_allowed: bool,
    /// Content hash of the complete projection.
    pub snapshot_sha256: String,
}

/// Secret-minimized provider intent projection for Execution Graph consumers.
/// Exact payload, idempotency key, lease/worker credentials and raw diagnostics
/// remain in the provider persistence boundary and are never exposed here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderIntentSummary {
    /// Intent identity.
    pub intent_id: String,
    /// Workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Exact task attempt.
    pub attempt: u64,
    /// Provider adapter identity.
    pub provider_id: String,
    /// Immutable plan digest.
    pub plan_sha256: String,
    /// Exact request payload digest.
    pub request_sha256: String,
    /// Durable provider state.
    pub state: ProviderDispatchState,
    /// Provider run identity when accepted.
    pub provider_run_id: Option<String>,
    /// Intent creation timestamp.
    pub created_at: String,
    /// Last intent transition timestamp.
    pub updated_at: String,
}

impl From<&ProviderIntentRecord> for ProviderIntentSummary {
    fn from(intent: &ProviderIntentRecord) -> Self {
        Self {
            intent_id: intent.intent_id.clone(),
            workflow_id: intent.request.workflow_id.clone(),
            task_id: intent.request.task_id.clone(),
            attempt: intent.request.attempt,
            provider_id: intent.request.provider_id.clone(),
            plan_sha256: intent.request.plan_sha256.clone(),
            request_sha256: intent.request.request_sha256.clone(),
            state: intent.state,
            provider_run_id: intent.provider_run_id.clone(),
            created_at: intent.created_at.clone(),
            updated_at: intent.updated_at.clone(),
        }
    }
}

/// Projection validation failure.
#[derive(Debug, Error)]
pub enum ExecutionGraphError {
    /// Durable workflow view failed an invariant.
    #[error("invalid execution graph source: {0}")]
    Invalid(String),
}

impl ExecutionGraphSnapshot {
    /// Project exact current workflow state and independently supplied event-chain status.
    pub fn from_workflow(
        workflow: &WorkflowView,
        event_chain_valid: bool,
    ) -> Result<Self, ExecutionGraphError> {
        Self::from_workflow_with_provider_intents(workflow, event_chain_valid, &[])
    }

    /// Project workflow plus the complete provider-intent ledger supplied by the store.
    pub fn from_workflow_with_provider_intents(
        workflow: &WorkflowView,
        event_chain_valid: bool,
        provider_intents: &[ProviderIntentRecord],
    ) -> Result<Self, ExecutionGraphError> {
        if workflow.workflow_id.trim().is_empty() || workflow.proposal_hash.len() != 64 {
            return Err(ExecutionGraphError::Invalid(
                "workflow identity or proposal digest invalid".into(),
            ));
        }
        let actual_proposal_hash = content_hash(&workflow.proposal)
            .map_err(|error| ExecutionGraphError::Invalid(error.to_string()))?;
        if actual_proposal_hash != workflow.proposal_hash {
            return Err(ExecutionGraphError::Invalid(
                "proposal digest does not match exact proposal".into(),
            ));
        }
        let actual_plan_hash = content_hash(&workflow.plan)
            .map_err(|error| ExecutionGraphError::Invalid(error.to_string()))?;
        if workflow
            .plan_hash
            .as_deref()
            .is_some_and(|hash| hash != actual_plan_hash)
        {
            return Err(ExecutionGraphError::Invalid(
                "plan digest does not match exact immutable plan".into(),
            ));
        }
        if workflow.state != WorkflowState::Proposed
            && workflow
                .plan_hash
                .as_deref()
                .is_none_or(|hash| hash.len() != 64)
        {
            return Err(ExecutionGraphError::Invalid(
                "approved/executing workflow lacks immutable plan digest".into(),
            ));
        }
        if let Some(approval) = &workflow.approval {
            if approval.approval_id.trim().is_empty()
                || approval.proposal_hash != workflow.proposal_hash
                || workflow.plan_hash.as_deref() != Some(approval.plan_hash.as_str())
            {
                return Err(ExecutionGraphError::Invalid(
                    "approval record does not bind current proposal/plan".into(),
                ));
            }
        }
        if provider_intents.iter().any(|intent| {
            intent.request.workflow_id != workflow.workflow_id
                || !workflow.tasks.iter().any(|task| {
                    task.definition.task_id == intent.request.task_id
                        && intent.request.attempt <= task.attempts
                })
                || workflow.plan_hash.as_deref() != Some(intent.request.plan_sha256.as_str())
                || (intent.state == ProviderDispatchState::Accepted)
                    != intent.provider_run_id.is_some()
        }) {
            return Err(ExecutionGraphError::Invalid(
                "provider intent is not bound to this workflow/task or accepted run identity"
                    .into(),
            ));
        }
        let mut tasks = Vec::with_capacity(workflow.tasks.len());
        let mut dependencies = Vec::new();
        for task in &workflow.tasks {
            if task.attempts == 0
                && (task.lease_id.is_some() || task.lease_owner.is_some() || task.result.is_some())
            {
                return Err(ExecutionGraphError::Invalid(format!(
                    "task {} has records without an attempt",
                    task.definition.task_id
                )));
            }
            if task.attempts > 0
                && task
                    .result
                    .as_ref()
                    .is_some_and(|result| result.attempt != task.attempts)
            {
                return Err(ExecutionGraphError::Invalid(format!(
                    "task {} result attempt does not match head",
                    task.definition.task_id
                )));
            }
            dependencies.extend(task.definition.depends_on.iter().map(|dependency| {
                ExecutionDependency {
                    task_id: task.definition.task_id.clone(),
                    depends_on_task_id: dependency.clone(),
                }
            }));
            let latest_attempt = (task.attempts > 0).then(|| ExecutionAttempt {
                attempt: task.attempts,
                state: task.state,
                lease_id: task.lease_id.clone(),
                worker_id: task.lease_owner.clone(),
                outcome: task.result.as_ref().map(|result| result.outcome),
                evidence: task
                    .result
                    .as_ref()
                    .map(|result| result.evidence.clone())
                    .unwrap_or_default(),
                diagnostic: task.result.as_ref().and_then(|result| result.error.clone()),
            });
            tasks.push(ExecutionTaskNode {
                task_id: task.definition.task_id.clone(),
                role: task.definition.role.clone(),
                description: task.definition.description.clone(),
                required_evidence: task.definition.required_evidence.clone(),
                state: task.state,
                attempt_count: task.attempts,
                latest_attempt,
            });
        }
        let provider_dispatch_intents = provider_intents
            .iter()
            .map(ProviderIntentSummary::from)
            .collect::<Vec<_>>();
        let mut snapshot = Self {
            workflow_id: workflow.workflow_id.clone(),
            workflow_state: workflow.state,
            proposal_sha256: workflow.proposal_hash.clone(),
            plan_sha256: workflow.plan_hash.clone(),
            approval_id: workflow
                .approval
                .as_ref()
                .map(|approval| approval.approval_id.clone()),
            tasks,
            dependencies,
            provider_dispatch_intents,
            event_chain_valid,
            history_completeness:
                "latest_task_attempt_projection_plus_persisted_provider_intent_ledger;_prior_non_provider_attempts_unavailable".into(),
            provider_run_identity_available: provider_intents.iter().any(|intent| intent.provider_run_id.is_some()),
            dispatch_allowed: false,
            snapshot_sha256: String::new(),
        };
        snapshot.snapshot_sha256 = content_hash(&snapshot)
            .map_err(|error| ExecutionGraphError::Invalid(error.to_string()))?;
        Ok(snapshot)
    }

    /// Verify projection digest and internal task/dependency references.
    pub fn validate(&self) -> Result<(), ExecutionGraphError> {
        let mut unsigned = self.clone();
        let expected = unsigned.snapshot_sha256.clone();
        unsigned.snapshot_sha256.clear();
        let actual = content_hash(&unsigned)
            .map_err(|error| ExecutionGraphError::Invalid(error.to_string()))?;
        if expected != actual {
            return Err(ExecutionGraphError::Invalid(
                "execution graph snapshot digest mismatch".into(),
            ));
        }
        let ids: std::collections::BTreeSet<&str> = self
            .tasks
            .iter()
            .map(|task| task.task_id.as_str())
            .collect();
        if ids.len() != self.tasks.len()
            || self.dependencies.iter().any(|edge| {
                !ids.contains(edge.task_id.as_str())
                    || !ids.contains(edge.depends_on_task_id.as_str())
            })
        {
            return Err(ExecutionGraphError::Invalid(
                "execution graph task/dependency references invalid".into(),
            ));
        }
        if self.dispatch_allowed {
            return Err(ExecutionGraphError::Invalid(
                "read-only projection cannot assert provider dispatch authority".into(),
            ));
        }
        if self.provider_dispatch_intents.iter().any(|intent| {
            intent.workflow_id != self.workflow_id
                || (intent.state == ProviderDispatchState::Accepted)
                    != intent.provider_run_id.is_some()
                || !self.tasks.iter().any(|task| {
                    task.task_id == intent.task_id && intent.attempt <= task.attempt_count
                })
                || self.plan_sha256.as_deref() != Some(intent.plan_sha256.as_str())
        }) {
            return Err(ExecutionGraphError::Invalid(
                "provider intent workflow/run binding invalid".into(),
            ));
        }
        if self.provider_run_identity_available
            != self
                .provider_dispatch_intents
                .iter()
                .any(|intent| intent.provider_run_id.is_some())
        {
            return Err(ExecutionGraphError::Invalid(
                "provider-run availability flag disagrees with ledger".into(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use runalith_domain::{TaskSpec, WorkflowPlan, WorkflowProposal, content_hash};
    use runalith_store::{
        ApprovalRequest, ApprovalVerificationMode, ApprovalVerifier, ClaimRequest,
        ProviderIntentOutcome, ProviderIntentRequest, Store, StoreError, TaskResultRequest,
        Transaction, VerifiedApproval, WorkflowView,
    };

    struct TestApprovalVerifier;

    impl ApprovalVerifier for TestApprovalVerifier {
        fn verify(
            &self,
            _transaction: &Transaction<'_>,
            _proposal: &WorkflowProposal,
            _plan: &WorkflowPlan,
            request: &ApprovalRequest,
            _mode: ApprovalVerificationMode,
        ) -> Result<VerifiedApproval, StoreError> {
            Ok(VerifiedApproval {
                actor: request.actor.clone(),
                evidence: request.evidence.clone(),
            })
        }
    }

    fn approve(store: &Store, workflow: &WorkflowView) {
        store
            .approve(
                &workflow.workflow_id,
                ApprovalRequest {
                    actor: "test-reviewer".into(),
                    expected_proposal_hash: workflow.proposal_hash.clone(),
                    expected_plan_hash: content_hash(&workflow.plan).unwrap(),
                    evidence: serde_json::json!({"test_only":true}),
                },
                &TestApprovalVerifier,
            )
            .unwrap();
    }

    #[test]
    fn execution_graph_is_derived_from_exact_durable_workflow_and_is_non_dispatchable() {
        let store = Store::in_memory().unwrap();
        let workflow = store
            .create_proposal(WorkflowProposal {
                workflow_id: "job_execution_graph".into(),
                title: "Execution graph".into(),
                goal: "Project tasks".into(),
                tasks: vec![
                    TaskSpec {
                        task_id: "one".into(),
                        role: "builder".into(),
                        description: "build".into(),
                        depends_on: vec![],
                        required_evidence: vec!["report".into()],
                        inputs: Default::default(),
                    },
                    TaskSpec {
                        task_id: "two".into(),
                        role: "reviewer".into(),
                        description: "review".into(),
                        depends_on: vec!["one".into()],
                        required_evidence: vec!["review".into()],
                        inputs: Default::default(),
                    },
                ],
                metadata: Default::default(),
            })
            .unwrap();
        let graph = ExecutionGraphSnapshot::from_workflow(&workflow, true).unwrap();
        assert_eq!(graph.tasks.len(), 2);
        assert_eq!(graph.dependencies[0].depends_on_task_id, "one");
        assert_eq!(graph.workflow_state, WorkflowState::Proposed);
        assert_eq!(
            graph.history_completeness,
            "latest_task_attempt_projection_plus_persisted_provider_intent_ledger;_prior_non_provider_attempts_unavailable"
        );
        assert!(!graph.provider_run_identity_available);
        assert!(!graph.dispatch_allowed);
        assert_eq!(graph.snapshot_sha256.len(), 64);
        assert!(graph.validate().is_ok());
        let mut tampered = graph;
        tampered.tasks[0].description.push_str(" changed");
        assert!(tampered.validate().is_err());
    }

    #[test]
    fn execution_graph_rejects_plan_hash_loss_after_approval() {
        let store = Store::in_memory().unwrap();
        let mut workflow = store
            .create_proposal(WorkflowProposal {
                workflow_id: "job_execution_graph_invalid".into(),
                title: "Invalid".into(),
                goal: "Invalid".into(),
                tasks: vec![TaskSpec {
                    task_id: "one".into(),
                    role: "builder".into(),
                    description: "build".into(),
                    depends_on: vec![],
                    required_evidence: vec![],
                    inputs: Default::default(),
                }],
                metadata: Default::default(),
            })
            .unwrap();
        workflow.state = WorkflowState::Approved;
        workflow.plan_hash = None;
        assert!(ExecutionGraphSnapshot::from_workflow(&workflow, true).is_err());
    }

    #[test]
    fn execution_graph_preserves_fenced_attempt_and_unknown_provider_outcome() {
        let store = Store::in_memory().unwrap();
        let workflow = store
            .create_proposal(WorkflowProposal {
                workflow_id: "job_execution_graph_attempt".into(),
                title: "Attempt".into(),
                goal: "Capture ambiguous provider outcome".into(),
                tasks: vec![TaskSpec {
                    task_id: "dispatch".into(),
                    role: "provider".into(),
                    description: "perform bounded operation".into(),
                    depends_on: vec![],
                    required_evidence: vec![],
                    inputs: Default::default(),
                }],
                metadata: Default::default(),
            })
            .unwrap();
        approve(&store, &workflow);
        let lease = store
            .claim_task(
                &workflow.workflow_id,
                "dispatch",
                ClaimRequest {
                    worker_id: "worker-test".into(),
                    lease_ttl_seconds: 60,
                },
                &TestApprovalVerifier,
            )
            .unwrap();
        let running = store.get_workflow(&workflow.workflow_id).unwrap();
        let running_graph = ExecutionGraphSnapshot::from_workflow(&running, true).unwrap();
        let attempt = running_graph.tasks[0].latest_attempt.as_ref().unwrap();
        assert_eq!(attempt.attempt, lease.attempt);
        assert_eq!(attempt.lease_id.as_deref(), Some(lease.lease_id.as_str()));
        assert_eq!(attempt.worker_id.as_deref(), Some("worker-test"));
        assert_eq!(attempt.outcome, None);

        store
            .record_task_result(
                &workflow.workflow_id,
                "dispatch",
                TaskResultRequest {
                    lease_id: lease.lease_id,
                    worker_id: lease.worker_id,
                    attempt: lease.attempt,
                    outcome: TaskOutcome::Unknown,
                    evidence: vec![],
                    error: Some("provider outcome ambiguous".into()),
                },
            )
            .unwrap();
        let quarantined = store.get_workflow(&workflow.workflow_id).unwrap();
        let graph = ExecutionGraphSnapshot::from_workflow(&quarantined, true).unwrap();
        let attempt = graph.tasks[0].latest_attempt.as_ref().unwrap();
        assert_eq!(attempt.outcome, Some(TaskOutcome::Unknown));
        assert_eq!(attempt.state, TaskState::Unknown);
        assert_eq!(attempt.lease_id, None);
        assert!(!graph.dispatch_allowed);
        assert!(graph.validate().is_ok());
    }

    #[test]
    fn execution_graph_binds_accepted_provider_run_identity_from_ledger() {
        let store = Store::in_memory().unwrap();
        let workflow = store
            .create_proposal(WorkflowProposal {
                workflow_id: "job_execution_graph_provider_run".into(),
                title: "Provider run".into(),
                goal: "Bind accepted provider run".into(),
                tasks: vec![TaskSpec {
                    task_id: "remote".into(),
                    role: "provider".into(),
                    description: "remote call".into(),
                    depends_on: vec![],
                    required_evidence: vec![],
                    inputs: Default::default(),
                }],
                metadata: Default::default(),
            })
            .unwrap();
        let plan_hash = content_hash(&workflow.plan).unwrap();
        approve(&store, &workflow);
        let lease = store
            .claim_task(
                &workflow.workflow_id,
                "remote",
                ClaimRequest {
                    worker_id: "worker-provider".into(),
                    lease_ttl_seconds: 60,
                },
                &TestApprovalVerifier,
            )
            .unwrap();
        let provider_payload = serde_json::json!({"operation":"test"});
        let provider_payload_hash = content_hash(&provider_payload).unwrap();
        let reservation = store
            .reserve_provider_dispatch(
                ProviderIntentRequest {
                    workflow_id: workflow.workflow_id.clone(),
                    task_id: "remote".into(),
                    attempt: lease.attempt,
                    provider_id: "test-provider".into(),
                    idempotency_key: "accepted-provider-run".into(),
                    lease_id: lease.lease_id,
                    worker_id: lease.worker_id,
                    plan_sha256: plan_hash,
                    request_sha256: provider_payload_hash,
                    payload: Some(provider_payload),
                },
                &TestApprovalVerifier,
            )
            .unwrap();
        store
            .record_provider_dispatch_outcome(
                &reservation.record.intent_id,
                ProviderIntentOutcome::Accepted {
                    provider_run_id: "provider-run-42".into(),
                },
            )
            .unwrap();
        let workflow = store.get_workflow(&workflow.workflow_id).unwrap();
        let intents = store
            .list_provider_dispatch_intents(&workflow.workflow_id)
            .unwrap();
        let graph =
            ExecutionGraphSnapshot::from_workflow_with_provider_intents(&workflow, true, &intents)
                .unwrap();
        assert!(graph.provider_run_identity_available);
        let serialized = serde_json::to_value(&graph).unwrap();
        assert!(
            serialized["provider_dispatch_intents"][0]
                .get("request")
                .is_none()
        );
        assert!(
            serialized["provider_dispatch_intents"][0]
                .get("outcome")
                .is_none()
        );
        assert!(!serialized.to_string().contains("test-provider-operation"));
        assert_eq!(
            graph.provider_dispatch_intents[0]
                .provider_run_id
                .as_deref(),
            Some("provider-run-42")
        );
        assert!(!graph.dispatch_allowed);
        assert!(graph.validate().is_ok());
    }
}
