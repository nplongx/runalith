//! SQLite persistence for the Rust Runalith runtime.
//!
//! This crate owns workflow/task/event/graph coordination. Provider intent and
//! reconciliation records are persisted by `runalith-execution-persistence`
//! through the same SQLite connection and transaction. It must never open or
//! migrate the legacy Node.js database.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    path::Path,
    sync::Mutex,
};

use chrono::{Duration, SecondsFormat, Utc};
use runalith_domain::custom_workflow::{
    CustomRoleDefinition, compile_custom_workflow, validate_custom_role,
};
use runalith_domain::workflow::{CompiledWorkflowPlan, CustomWorkflowDefinition};
use runalith_domain::{
    Approval, EvidenceRef, EvidenceVerification, GraphEdge, GraphEvidence, GraphNodeRevision,
    GraphSnapshot, GraphSnapshotDraft, TaskOutcome, TaskResult, TaskSpec, TaskState, WorkflowPlan,
    WorkflowProposal, WorkflowState, content_hash,
};
pub use runalith_execution_persistence::{
    ProviderDispatchState, ProviderIntentOutcome, ProviderIntentRecord, ProviderIntentRequest,
    ProviderIntentReservation, ProviderReconciliationObservation,
};
use runalith_execution_persistence::{ProviderLedger, ProviderPersistenceError};
pub use rusqlite::Transaction;
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

const SCHEMA_VERSION: i64 = 20;

mod checkpoint_persistence;
mod governance_decisions;
mod governance_persistence;
pub use checkpoint_persistence::{CheckpointOperationSnapshot, StoreCheckpointOperationRepository};
pub use governance_decisions::StoreGovernanceDecisionBackend;

/// Node-compatible immutable workflow policy definition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowPolicyDefinition {
    /// Policy schema version.
    pub schema_version: u32,
    /// Stable policy slug.
    pub policy_id: String,
    /// Human-readable policy name.
    pub name: String,
    /// Optional policy description.
    #[serde(default)]
    pub description: String,
    /// Plan and lifecycle constraints.
    #[serde(default)]
    pub constraints: Vec<serde_json::Value>,
    /// Success predicates evaluated against persisted workflow evidence.
    #[serde(default)]
    pub success_criteria: Vec<serde_json::Value>,
}

/// Immutable persisted policy version and its Node-compatible content digest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkflowPolicyVersion {
    /// Stable policy slug.
    pub policy_id: String,
    /// Positive immutable version.
    pub version: u32,
    /// Validated policy definition.
    pub definition: WorkflowPolicyDefinition,
    /// SHA-256 of `{policy_id, version, definition}` canonical JSON.
    pub content_sha256: String,
    /// Authenticated creator principal.
    pub created_by: String,
    /// Creation timestamp.
    pub created_at: String,
}

/// Persisted, exact workflow policy attachment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowPolicyAttachment {
    /// Workflow identity.
    pub workflow_id: String,
    /// Exact policy identity and version.
    pub policy_id: String,
    /// Exact policy version.
    pub version: u32,
    /// Digest pinned at attachment time.
    pub content_sha256: String,
    /// Authenticated attaching principal.
    pub attached_by: String,
    /// Attachment timestamp.
    pub attached_at: String,
}

/// Exact composed success contract attached to a workflow and optionally pinned to approval.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkflowSuccessContractSnapshot {
    /// Workflow identity.
    pub workflow_id: String,
    /// Immutable contract revision.
    pub version: u32,
    /// Original normalized contract before policy composition.
    pub base_contract: serde_json::Value,
    /// Deterministically composed contract.
    pub composed_contract: serde_json::Value,
    /// Exact policy identity/version/content digests.
    pub policy_pins: serde_json::Value,
    /// SHA-256 of base contract, composed contract and exact policy pins.
    pub content_sha256: String,
    /// Exact approved plan digest; absent until approval.
    pub plan_sha256: Option<String>,
    /// Authenticated creator.
    pub created_by: String,
    /// Creation timestamp.
    pub created_at: String,
}

/// Immutable custom role catalog version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomRoleVersion {
    /// Full validated role definition.
    pub definition: CustomRoleDefinition,
    /// Content digest of the exact serialized definition.
    pub definition_sha256: String,
    /// Creator identity supplied by the authenticated caller.
    pub created_by: String,
    /// Creation timestamp.
    pub created_at: String,
}

/// Immutable custom workflow catalog version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomWorkflowVersion {
    /// Full typed workflow definition.
    pub definition: CustomWorkflowDefinition,
    /// Content digest of the exact serialized definition.
    pub definition_sha256: String,
    /// Creator identity supplied by the authenticated caller.
    pub created_by: String,
    /// Creation timestamp.
    pub created_at: String,
}

/// Persisted immutable custom workflow compilation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomWorkflowPlanRecord {
    /// Stable plan identity.
    pub plan_id: String,
    /// Exact workflow version used to compile this plan.
    pub workflow_id: String,
    /// Exact workflow version used to compile this plan.
    pub workflow_version: u32,
    /// Immutable compiled plan snapshot.
    pub plan: CompiledWorkflowPlan,
    /// SHA-256 of canonical compiled plan content.
    pub plan_sha256: String,
    /// Creator identity supplied by the authenticated caller.
    pub created_by: String,
    /// Creation timestamp.
    pub created_at: String,
}

/// Read-only scheduler projection for one dependency-ready task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadyTask {
    /// Parent workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Task ordinal within immutable plan.
    pub ordinal: u64,
    /// Exact immutable workflow plan digest.
    pub plan_sha256: String,
    /// Current parent workflow state.
    pub workflow_state: WorkflowState,
    /// Exact persisted task definition.
    pub definition: TaskSpec,
}

/// SQLite-backed durable store. It never opens or migrates a legacy Runalith database.
pub struct Store {
    connection: Mutex<Connection>,
    /// Dedicated Governance/trust connection to the same physical workflow DB.
    /// Trust writes commit before workflow writer transactions begin; approval
    /// rechecks the observed high-water through `connection` inside its tx.
    trust_connection: Mutex<Connection>,
}

type LeaseRenewalLedgerRow = (
    String,
    String,
    String,
    i64,
    i64,
    String,
    String,
    i64,
    String,
    String,
    String,
);

type CurrentLeaseProjectionRow = (
    String,
    i64,
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
);

type CurrentExecutionFenceProjectionRow = (
    String,
    i64,
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// Read-only health projection of an existing Rust workflow database.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoreHealthSnapshot {
    /// Database path inspected.
    pub database_path: String,
    /// Database file length in bytes.
    pub database_bytes: u64,
    /// SQLite schema version; must equal the current Rust schema.
    pub schema_version: i64,
    /// SQLite quick-check result.
    pub quick_check: String,
    /// Durable workflow count.
    pub workflows: u64,
    /// Durable task count.
    pub tasks: u64,
    /// Tasks currently marked RUNNING.
    pub running_tasks: u64,
    /// Tasks with a durable lease identity.
    pub leased_tasks: u64,
    /// Durable provider intent count.
    pub provider_intents: u64,
    /// Durable provider reconciliation observation count.
    pub provider_observations: u64,
    /// Immutable historical task lease-attempt count.
    pub task_attempts: u64,
    /// Append-only idempotent lease-renewal history count.
    pub task_lease_renewals: u64,
    /// Durable reserved/completed worker execution-fence count.
    pub worker_execution_fences: u64,
    /// Immutable terminal attempt-result count.
    pub task_attempt_results: u64,
    /// Append-only workflow event count.
    pub events: u64,
    /// Durable Rust-native agent session count.
    pub agent_sessions: u64,
    /// Durable session ACL grant count, including revoked grants.
    pub session_access_grants: u64,
    /// Durable session message count, including uncertain outcomes.
    pub session_messages: u64,
    /// Immutable custom role catalog version count.
    pub custom_role_versions: u64,
    /// Immutable custom workflow catalog version count.
    pub custom_workflow_versions: u64,
    /// Persisted immutable custom workflow plan count.
    pub custom_workflow_plans: u64,
    /// Append-only custom catalog audit event count.
    pub control_catalog_events: u64,
    /// Immutable workflow policy versions.
    pub workflow_policy_versions: u64,
    /// Immutable workflow policy attachments.
    pub workflow_policy_attachments: u64,
    /// Immutable success-contract snapshots.
    pub workflow_success_contracts: u64,
    /// Immutable Governance trust-root configuration versions.
    pub governance_trust_configuration_versions: u64,
    /// Immutable Governance reviewer identity versions.
    pub governance_reviewer_identity_versions: u64,
    /// Durable one-use AGG attestation nonces.
    pub agg_attestation_nonces: u64,
    /// Immutable authenticated task-result inbox envelopes.
    pub workflow_result_inbox: u64,
    /// Immutable host-verified skill pins attached to custom role versions.
    pub custom_role_trusted_skill_pins: u64,
    /// Durable local AGG checkpoint operations, including terminal history.
    pub agg_checkpoint_operations: u64,
    /// Durable local AGG checkpoint operation events.
    pub agg_checkpoint_operation_events: u64,
    /// Whether local workflow state is quarantined pending external reconciliation.
    pub agg_checkpoint_store_quarantined: bool,
    /// Immutable Governance decision receipts.
    pub governance_decisions: u64,
    /// Append-only Governance decision commit events.
    pub governance_decision_events: u64,
    /// Always true; this inspection never opens a writable connection.
    pub read_only: bool,
}

/// Read-only workflow and task projection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkflowView {
    /// Workflow identity.
    pub workflow_id: String,
    /// Current lifecycle state.
    pub state: WorkflowState,
    /// Original proposal bytes decoded into its typed representation.
    pub proposal: WorkflowProposal,
    /// Candidate immutable plan. Its hash is pinned at approval.
    pub plan: WorkflowPlan,
    /// Approval record, present only after verified approval.
    pub approval: Option<Approval>,
    /// Proposal SHA-256.
    pub proposal_hash: String,
    /// Plan SHA-256 after approval.
    pub plan_hash: Option<String>,
    /// A durable cancellation request awaiting execution-owned settlement.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancellation_request: Option<WorkflowCancellationView>,
    /// Current task projection.
    pub tasks: Vec<TaskView>,
}

/// Immutable Control-side cancellation request. It does not prove a worker
/// process stopped, revoke a running lease, or settle an external effect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowCancellationView {
    /// Authenticated actor returned by the host cancellation verifier.
    pub actor: String,
    /// Operator-provided cancellation reason.
    pub reason: String,
    /// Original request timestamp from the append-only event journal.
    pub requested_at: String,
    /// Control-side projection only. `UNRESOLVED` is not a process-stop proof.
    pub settlement_status: WorkflowCancellationSettlementStatus,
}

/// Cancellation settlement state observable by Control without granting it
/// Execution authority. No transition to a settled value is inferred here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WorkflowCancellationSettlementStatus {
    /// Cancellation occurred before any task attempt was created.
    NotRequired,
    /// Execution began; an Execution-owned settlement receipt is still absent.
    Unresolved,
}

/// Read-only event projection from the append-only workflow journal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkflowEvent {
    /// Monotonic sequence within the workflow.
    pub sequence: u64,
    /// Stable event identity.
    pub event_id: String,
    /// Optional task identity.
    pub task_id: Option<String>,
    /// Event type.
    pub event_type: String,
    /// Structured event payload.
    pub payload: serde_json::Value,
    /// Event creation timestamp.
    pub created_at: String,
    /// Previous event digest.
    pub previous_sha256: String,
    /// Event digest.
    pub sha256: String,
}

/// Read-only task projection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskView {
    /// Task definition pinned by the plan.
    pub definition: TaskSpec,
    /// Current task state.
    pub state: TaskState,
    /// Number of leases issued.
    pub attempts: u64,
    /// Current lease ID, if still active.
    pub lease_id: Option<String>,
    /// Current worker ID, if still active.
    pub lease_owner: Option<String>,
    /// Lease expiry as RFC 3339 UTC.
    pub lease_expires_at: Option<String>,
    /// Persisted result, including quarantined unknown outcomes.
    pub result: Option<TaskResult>,
}

/// Read-only durable ownership projection for one exact task attempt.
/// Runtime sessions are intentionally not synthesized from absent metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskAttemptSnapshot {
    /// Workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Current durable task state.
    pub state: TaskState,
    /// Current attempt counter; zero means no attempt has been claimed.
    pub attempt: u64,
    /// Independent monotonic lease fencing epoch.
    pub owner_epoch: u64,
    /// Immutable plan digest, when approval pinned one.
    pub plan_sha256: Option<String>,
    /// Current lease identity, if durably present.
    pub lease_id: Option<String>,
    /// Current lease owner, if durably present.
    pub lease_owner: Option<String>,
    /// Current lease expiry, if durably present.
    pub lease_expires_at: Option<String>,
    /// Provider intent for this exact attempt, if one was reserved.
    pub provider_intent: Option<ProviderIntentRecord>,
    /// Persisted task result, including its content-addressed artifact references.
    pub result: Option<TaskResult>,
    /// Workflow journal slice captured in the same SQLite read transaction.
    pub history_events: Vec<WorkflowEvent>,
    /// Actual workflow-wide event-chain head, including other task events.
    pub event_head_sha256: String,
    /// False when the journal exceeds the bounded history window.
    pub history_complete: bool,
    /// Digest-verified provider lookup observations for the current intent.
    pub provider_observations: Vec<ProviderReconciliationObservation>,
    /// Runtime session identity durably bound to this exact attempt, if any.
    pub session_binding: Option<RuntimeSessionBinding>,
    /// Complete immutable attempt/lease history and any terminal result digest.
    pub attempt_ledger: Vec<TaskAttemptLedgerEntry>,
    /// Provider dispatch intents and lookup observations joined to every historical attempt.
    pub provider_history: Vec<ProviderAttemptHistory>,
    /// Agent session registry, ACL and message queue joined in this same read snapshot.
    pub session_history: Vec<AgentSessionHistory>,
}

/// Bounded current task/attempt projection from one workflow read snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskAttemptReadView {
    /// Task identity.
    pub task_id: String,
    /// Current task lifecycle state.
    pub state: TaskState,
    /// Current attempt counter; zero means the task has never been claimed.
    pub attempt: u64,
    /// Current fencing epoch.
    pub owner_epoch: u64,
    /// Immutable plan digest when approved.
    pub plan_sha256: Option<String>,
    /// Current lease identity, if active.
    pub lease_id: Option<String>,
    /// Current lease owner, if active.
    pub lease_owner: Option<String>,
    /// Current lease expiry, if active.
    pub lease_expires_at: Option<String>,
    /// Persisted result, including UNKNOWN outcomes.
    pub result: Option<TaskResult>,
    /// Current-attempt provider intent, when an external provider was reserved.
    pub provider_intent: Option<ProviderIntentRecord>,
    /// Current-attempt provider reconciliation observations.
    pub provider_observations: Vec<ProviderReconciliationObservation>,
    /// Provider intents and observations joined to historical attempts.
    pub provider_history: Vec<ProviderAttemptHistory>,
    /// Runtime session bound to the current attempt, if durably recorded.
    pub session_binding: Option<RuntimeSessionBinding>,
    /// Immutable attempt and result ledger (newest omitted only when truncated).
    pub attempt_ledger: Vec<TaskAttemptLedgerEntry>,
    /// False when more than 500 historical attempts exist for this task.
    pub attempt_history_complete: bool,
    /// Durable session registry, ACL and message history for this task.
    pub session_history: Vec<AgentSessionHistory>,
}

/// One coherent, read-only workflow snapshot captured under a single SQLite
/// read transaction. Every projection and the event-chain verification refer
/// to the same database snapshot; callers must not join separately timed GETs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkflowReadSnapshot {
    /// Version of this aggregate projection contract.
    pub schema_version: u32,
    /// Workflow and current task projections captured in the same transaction.
    pub workflow: WorkflowView,
    /// Current lease and immutable attempt history for every task in the plan.
    pub task_attempts: Vec<TaskAttemptReadView>,
    /// Ready tasks for this workflow; candidates only, never claims or leases.
    pub ready_tasks: Vec<ReadyTask>,
    /// Bounded chronological event slice.
    pub events: Vec<WorkflowEvent>,
    /// Actual workflow journal size, independent of early event-chain failure.
    pub total_event_count: u64,
    /// True when the workflow journal contains events older than this slice.
    pub events_truncated: bool,
    /// Verification of the complete workflow event chain in the same snapshot.
    pub event_chain: EventChainVerification,
}

/// Immutable historical lease record joined to its optional terminal result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskAttemptLedgerEntry {
    /// Monotonic attempt number.
    pub attempt: u64,
    /// Independent monotonic fencing epoch.
    pub owner_epoch: u64,
    /// Exact issued lease identifier.
    pub lease_id: String,
    /// Worker identity bound to the lease.
    pub worker_id: String,
    /// Lease deadline at issuance.
    pub lease_expires_at: String,
    /// Durable claim timestamp.
    pub claimed_at: String,
    /// Authenticated runtime session binding, when the bounded journal proves it.
    pub session_binding: Option<RuntimeSessionBinding>,
    /// Terminal result digest, absent while unresolved.
    pub result_sha256: Option<String>,
    /// Terminal outcome, absent while unresolved.
    pub outcome: Option<String>,
    /// Terminal result timestamp, absent while unresolved.
    pub result_recorded_at: Option<String>,
}

/// Historical provider intent joined to its exact task attempt and observations.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderAttemptHistory {
    /// Attempt number claimed by the provider intent.
    pub attempt: u64,
    /// Durable immutable provider intent.
    pub intent: ProviderIntentRecord,
    /// Digest-verified append-only observations for this intent.
    pub observations: Vec<ProviderReconciliationObservation>,
    /// Whether intent lease/worker lineage matches the historical attempt ledger.
    pub lineage_matches: bool,
}

/// Complete durable session, ACL and message lineage for one task.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentSessionHistory {
    /// Session registry row.
    pub session: AgentSessionRecord,
    /// All current and revoked access grants.
    pub access: Vec<SessionAccessRecord>,
    /// All queued, delivered, acknowledged and uncertain messages.
    pub messages: Vec<SessionMessageRecord>,
}

/// Bounded, ACL-checked read projection for one durable agent session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentSessionInspection {
    /// Session registry row.
    pub session: AgentSessionRecord,
    /// Current or historical grants selected by the caller.
    pub access: Vec<SessionAccessRecord>,
    /// Chronological message slice.
    pub messages: Vec<SessionMessageRecord>,
    /// True when additional messages exist beyond the requested bound.
    pub messages_truncated: bool,
}

/// Result of an authorized session attach operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionAttachment {
    /// Current durable session projection.
    pub session: AgentSessionRecord,
    /// OBSERVE, INTERACT or TAKEOVER.
    pub mode: String,
    /// ACL permission consumed by this attachment.
    pub permission: String,
}

/// Durable session access grant projection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionAccessRecord {
    /// Grant identity.
    pub access_id: String,
    /// Session identity.
    pub session_id: String,
    /// Authorized role.
    pub accessor_role: String,
    /// Permission name.
    pub permission: String,
    /// Explicit grantor.
    pub granted_by: String,
    /// Optional canonical UTC expiry.
    pub expires_at: Option<String>,
    /// Grant creation timestamp.
    pub created_at: String,
    /// Revocation timestamp, if revoked.
    pub revoked_at: Option<String>,
}

/// Immutable runtime-session binding for one exact leased attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeSessionBinding {
    /// Workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Exact claimed task attempt.
    pub attempt: u64,
    /// Independent monotonic lease fencing epoch.
    pub owner_epoch: u64,
    /// Exact lease issued for the attempt.
    pub lease_id: String,
    /// Worker identity holding the lease.
    pub worker_id: String,
    /// Authenticated runtime instance identity.
    pub runtime_id: String,
    /// Runtime session identity.
    pub session_id: String,
    /// Binding journal timestamp.
    pub bound_at: String,
}

/// Binding request accepted only after host-side attestation verification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeSessionBindingRequest {
    /// Exact claimed task attempt.
    pub attempt: u64,
    /// Fencing epoch from the exact durable lease.
    pub owner_epoch: u64,
    /// Exact lease issued for the attempt.
    pub lease_id: String,
    /// Worker identity holding the lease.
    pub worker_id: String,
    /// Authenticated runtime instance identity.
    pub runtime_id: String,
    /// Runtime session identity.
    pub session_id: String,
}

/// Durable Rust-native agent session creation contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSessionCreateRequest {
    /// External runtime session key; this value is identity only, not liveness proof.
    pub runtime_session_key: String,
    /// Session owner role.
    pub role: String,
    /// Optional parent runtime session key.
    pub parent_session_key: Option<String>,
    /// Monotonic logical session attempt.
    pub attempt: u64,
}

/// Durable agent session projection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentSessionRecord {
    /// Stable Rust session identifier.
    pub session_id: String,
    /// Workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Owning role.
    pub role: String,
    /// External runtime session key.
    pub runtime_session_key: String,
    /// Parent runtime session key.
    pub parent_session_key: Option<String>,
    /// Durable lifecycle state.
    pub state: String,
    /// Current runtime turn, when known.
    pub current_turn_id: Option<String>,
    /// Logical session attempt.
    pub attempt: u64,
    /// Last durable activity timestamp.
    pub last_activity_at: String,
}

/// Durable session ACL permission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SessionPermission {
    /// Read session metadata and trace.
    Observe,
    /// Enqueue, receive and acknowledge messages.
    Message,
    /// Request session execution under separate execution policy.
    Execute,
    /// Take over an eligible paused/stale/failed session.
    Takeover,
}

impl SessionPermission {
    fn as_db(self) -> &'static str {
        match self {
            Self::Observe => "OBSERVE",
            Self::Message => "MESSAGE",
            Self::Execute => "EXECUTE",
            Self::Takeover => "TAKEOVER",
        }
    }
}

/// Session ACL grant request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionAccessRequest {
    /// Role receiving access.
    pub accessor_role: String,
    /// Permission being granted.
    pub permission: SessionPermission,
    /// Explicit grantor identity.
    pub granted_by: String,
    /// Optional canonical UTC expiry.
    pub expires_at: Option<String>,
}

/// Durable session message request. Payload must be a JSON object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionMessageRequest {
    /// Sender role.
    pub sender_role: String,
    /// Intended recipient role.
    pub recipient_role: String,
    /// Protocol message type.
    pub message_type: String,
    /// Detached JSON object payload.
    pub payload: serde_json::Value,
    /// Optional correlation identity.
    pub correlation_id: Option<String>,
    /// Optional per-session idempotency key.
    pub dedupe_key: Option<String>,
    /// Earliest delivery timestamp; defaults to now.
    pub available_at: Option<String>,
}

/// Durable session message projection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionMessageRecord {
    /// Message identity.
    pub message_id: String,
    /// Session identity.
    pub session_id: String,
    /// Sender role.
    pub sender_role: String,
    /// Recipient role.
    pub recipient_role: String,
    /// Protocol name.
    pub protocol: String,
    /// Protocol version.
    pub protocol_version: u64,
    /// Message type.
    pub message_type: String,
    /// Detached payload object.
    pub payload: serde_json::Value,
    /// Optional correlation identity.
    pub correlation_id: Option<String>,
    /// Optional dedupe identity.
    pub dedupe_key: Option<String>,
    /// QUEUED, CLAIMED, ACKED, FAILED or UNCERTAIN.
    pub state: String,
    /// Monotonic delivery claim attempt.
    pub attempt: u64,
    /// Earliest eligible delivery time.
    pub available_at: String,
    /// Claim lease expiry.
    pub lease_until: Option<String>,
    /// Durable marker written immediately before external transport invocation.
    pub transport_started_at: Option<String>,
    /// Exact successful transport receipt, if independently observed.
    pub receipt: Option<serde_json::Value>,
    /// True only for the call that acquired this delivery claim.
    pub claim_acquired: bool,
}

/// Transport receipt bound to one exact session-message attempt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionDeliveryReceipt {
    /// External provider run/message identity.
    pub run_id: String,
    /// Exact runtime session key, when the transport reports it.
    pub session_key: String,
    /// Bounded transport response metadata.
    pub response: Option<serde_json::Value>,
    /// Receipt timestamp in canonical UTC.
    pub recorded_at: String,
}

/// Compare-and-record request for an authenticated recovery classification.
/// It records an observation only; it never changes task/session/provider state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryDecisionRecordRequest {
    /// Exact durable task state observed by the classifier.
    pub expected_task_state: String,
    /// Exact current task attempt.
    pub attempt: u64,
    /// Independent lease owner epoch.
    pub owner_epoch: u64,
    /// Exact immutable plan digest.
    pub plan_sha256: String,
    /// Exact current workflow event-chain head digest.
    pub event_head_sha256: String,
    /// Exact provider intent identity/state, if one exists for this attempt.
    pub provider_intent_id: Option<String>,
    /// Exact provider state, if an intent exists.
    pub provider_state: Option<String>,
    /// Exact bound runtime session ID, if present.
    pub session_id: Option<String>,
    /// Exact lease ID, if present.
    pub lease_id: Option<String>,
    /// Host-authenticated runtime identity.
    pub runtime_id: String,
    /// Monotonic runtime inventory generation.
    pub runtime_generation: u64,
    /// Runtime inventory capture time in Unix milliseconds.
    pub runtime_captured_at_ms: i64,
    /// Caller-observed decision time in Unix milliseconds.
    pub observed_at_ms: i64,
    /// Stable classification code, e.g. OWNED / UNKNOWN / NO_KNOWN_OWNER.
    pub decision: String,
    /// Digest of the exact authenticated runtime evidence snapshot.
    pub evidence_sha256: String,
}

/// Mandatory host-side verifier for recovery evidence. No permissive default.
pub trait RecoveryDecisionVerifier: Send + Sync {
    /// Authenticate runtime inventory and bind it to this exact durable snapshot.
    fn verify(
        &self,
        transaction: &Transaction<'_>,
        request: &RecoveryDecisionRecordRequest,
    ) -> Result<(), StoreError>;
}

/// Immutable audit record for one compare-and-record recovery classification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryDecisionRecord {
    /// Workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Durable event identity.
    pub event_id: String,
    /// Exact decision request persisted to the shared event journal.
    pub request: RecoveryDecisionRecordRequest,
    /// Persistence timestamp.
    pub recorded_at: String,
}

/// Fenced task lease.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskLease {
    /// Workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Unique lease identity.
    pub lease_id: String,
    /// Worker identity bound to this lease.
    pub worker_id: String,
    /// Monotonic task attempt.
    pub attempt: u64,
    /// Independent monotonic lease fencing epoch.
    pub owner_epoch: u64,
    /// Lease deadline as RFC 3339 UTC.
    pub expires_at: String,
}

/// Idempotent renewal request bound to one exact task lease and owner epoch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskLeaseRenewalRequest {
    /// Caller-generated identity reused after an ambiguous transport outcome.
    pub renewal_id: String,
    /// Workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Exact lease identity.
    pub lease_id: String,
    /// Authenticated worker identity.
    pub worker_id: String,
    /// Fenced attempt number.
    pub attempt: u64,
    /// Current monotonic owner epoch.
    pub owner_epoch: u64,
    /// Requested lease duration in seconds, bounded to 10 minutes.
    pub lease_ttl_seconds: u64,
}

/// Durable result of one lease renewal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskLeaseRenewal {
    /// Idempotency identity of this renewal request.
    pub renewal_id: String,
    /// Workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Exact lease identity.
    pub lease_id: String,
    /// Authenticated worker identity.
    pub worker_id: String,
    /// Fenced attempt number.
    pub attempt: u64,
    /// Current monotonic owner epoch.
    pub owner_epoch: u64,
    /// Expiry before this renewal.
    pub previous_expires_at: String,
    /// New lease expiry.
    pub expires_at: String,
    /// Persistence timestamp.
    pub renewed_at: String,
}

/// Exact side-effect category covered by an authoritative execution fence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerExecutionFenceKind {
    /// Start the exact sandbox command.
    SandboxStart,
    /// Dispatch the exact provider request.
    ProviderDispatch,
    /// Publish the exact terminal result.
    ResultPublish,
    /// Deliver the exact session message.
    SessionDelivery,
}

impl WorkerExecutionFenceKind {
    fn as_db(self) -> &'static str {
        match self {
            Self::SandboxStart => "sandbox_start",
            Self::ProviderDispatch => "provider_dispatch",
            Self::ResultPublish => "result_publish",
            Self::SessionDelivery => "session_delivery",
        }
    }
}

/// A reservation request is accepted only while the exact lease is current.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerExecutionFenceRequest {
    /// Immutable Control claim identity.
    pub claim_id: String,
    /// Workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Fenced attempt number.
    pub attempt: u64,
    /// Exact active lease identity.
    pub lease_id: String,
    /// Authenticated worker identity.
    pub worker_id: String,
    /// Current monotonic owner epoch.
    pub owner_epoch: u64,
    /// Immutable approved plan digest.
    pub plan_sha256: String,
    /// Stable side-effect identity.
    pub side_effect_id: String,
    /// Category of the protected side effect.
    pub kind: WorkerExecutionFenceKind,
    /// Digest of the exact side-effect request.
    pub request_sha256: String,
    /// Stable idempotency identity.
    pub idempotency_key: String,
    /// Digest of the authenticated ACL decision inputs.
    pub acl_sha256: String,
}

/// Completion evidence for one previously reserved side effect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerExecutionFenceCompletion {
    /// Exact reservation identity.
    pub fence_id: String,
    /// Immutable Control claim identity.
    pub claim_id: String,
    /// Workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Fenced attempt number.
    pub attempt: u64,
    /// Exact lease identity.
    pub lease_id: String,
    /// Authenticated worker identity.
    pub worker_id: String,
    /// Current owner epoch.
    pub owner_epoch: u64,
    /// Immutable plan digest.
    pub plan_sha256: String,
    /// Stable side-effect identity.
    pub side_effect_id: String,
    /// Category of the protected side effect.
    pub kind: WorkerExecutionFenceKind,
    /// Digest of the exact side-effect request.
    pub request_sha256: String,
    /// Exact classified terminal outcome.
    pub outcome: String,
    /// Stable terminal event identity.
    pub event_id: String,
    /// Digest of the exact terminal event.
    pub event_sha256: String,
    /// Digest of the exact outcome observation.
    pub outcome_sha256: String,
}

/// Durable execution-fence state and Control-generated receipt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerExecutionFenceRecord {
    /// Reservation identity.
    pub fence_id: String,
    /// Immutable request binding.
    pub request: WorkerExecutionFenceRequest,
    /// RESERVED or COMPLETED.
    pub state: String,
    /// Canonical completion JSON, if complete.
    pub completion: Option<WorkerExecutionFenceCompletion>,
    /// Digest of canonical completion JSON.
    pub completion_sha256: Option<String>,
    /// Durable Control receipt.
    pub receipt: serde_json::Value,
    /// Creation timestamp.
    pub created_at: String,
    /// Completion timestamp.
    pub completed_at: Option<String>,
}

/// Host-provisioned proof verifier for terminal execution-fence observations.
///
/// Implementations must verify the exact reservation binding and the evidence
/// represented by `completion` (including process/cgroup termination for
/// sandbox execution, or the exact provider run and terminal conclusion for
/// provider dispatch). A digest supplied by the worker is an integrity input,
/// not proof that the side effect is terminal. The verifier runs while the
/// authoritative Store writer transaction is held so owner transfer cannot
/// interleave with the terminal transition.
pub trait WorkerExecutionFenceCompletionVerifier: Send + Sync {
    /// Verify a SUCCEEDED, FAILED, or NOT_STARTED completion before it releases
    /// the exact reservation. Reject NOT_STARTED unless independent evidence
    /// proves the side effect never began.
    fn verify_terminal_completion(
        &self,
        transaction: &Transaction<'_>,
        fence: &WorkerExecutionFenceRecord,
        completion: &WorkerExecutionFenceCompletion,
    ) -> Result<(), StoreError>;
}

/// Durable receipt for one exact execution-fence observation.
///
/// An UNKNOWN (or unverified NOT_STARTED) observation is journaled without
/// changing the fence out of RESERVED. Only a terminal SUCCEEDED/FAILED
/// observation changes the reservation to COMPLETED.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerExecutionFenceCompletionResult {
    /// Current durable reservation projection after recording this observation.
    pub fence: WorkerExecutionFenceRecord,
    /// Exact immutable worker observation that was accepted or replayed.
    pub completion: WorkerExecutionFenceCompletion,
    /// Digest of the canonical completion object.
    pub completion_sha256: String,
    /// Durable receipt specific to this observation (not merely the latest fence receipt).
    pub receipt: serde_json::Value,
    /// Persistence timestamp of the first accepted observation.
    pub recorded_at: String,
    /// True only when this observation completed and released the reservation.
    pub terminal: bool,
}

/// Request to claim one already-approved task.
#[derive(Debug, Clone)]
pub struct ClaimRequest {
    /// Stable worker identity.
    pub worker_id: String,
    /// Lease TTL in seconds, bounded to 10 minutes.
    pub lease_ttl_seconds: u64,
}

/// Bounded coordinator tick. Limits are supplied by the trusted Control host;
/// they are admission ceilings, not provider/execution authorization.
#[derive(Debug, Clone)]
pub struct CoordinatorRequest {
    /// Worker identity assertion; authenticated by `CoordinatorWorkerVerifier`.
    pub worker_id: String,
    /// Lease duration in seconds.
    pub lease_ttl_seconds: u64,
    /// Maximum active leases across this Control store.
    pub max_parallel: u64,
    /// Maximum active leases for one workflow.
    pub max_parallel_per_workflow: u64,
}

/// Host authenticator for coordinator worker identity.
pub trait CoordinatorWorkerVerifier: Send + Sync {
    /// Authenticate the asserted worker and return its canonical identity.
    fn authenticate_worker(
        &self,
        transaction: &Transaction<'_>,
        asserted_worker_id: &str,
    ) -> Result<String, StoreError>;
}

/// Result submitted by a task worker.
#[derive(Debug, Clone, Serialize)]
pub struct TaskResultRequest {
    /// Exact lease ID issued to this worker.
    pub lease_id: String,
    /// Exact worker identity bound to this lease.
    pub worker_id: String,
    /// Fenced attempt number.
    pub attempt: u64,
    /// Known outcome or quarantined unknown outcome.
    pub outcome: TaskOutcome,
    /// Content-addressed evidence from this task attempt.
    pub evidence: Vec<EvidenceRef>,
    /// Diagnostic error for failed/unknown outcomes.
    pub error: Option<String>,
}

/// Immutable external result envelope. `payload_sha256` binds exact request bytes;
/// producer authority and provenance are independently verified by the host.
#[derive(Debug, Clone)]
pub struct TaskResultEnvelope {
    /// Globally unique immutable producer event identity.
    pub event_id: String,
    /// Asserted producer identity; never trusted without verifier output.
    pub producer_id: String,
    /// SHA-256 of canonical `{workflow_id,task_id,event_id,producer_id,request}`.
    pub payload_sha256: String,
    /// Fenced task result request.
    pub request: TaskResultRequest,
}

/// Exact trusted skill identity returned by an independently provisioned host resolver.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerifiedTrustedSkill {
    /// Exact reference supplied in the immutable role version.
    pub reference: String,
    /// Canonical skill identity owned by the external trust catalog.
    pub skill_id: String,
    /// Exact immutable skill version.
    pub version: u32,
    /// Digest of the exact trusted skill content.
    pub content_sha256: String,
}

/// Host-owned resolver for exact trusted skill references.
/// Implementations must reject missing, revoked, substituted or untrusted content.
pub trait TrustedSkillResolver: Send + Sync {
    /// Resolve and authenticate one exact role skill reference inside the active Store transaction.
    fn resolve_and_verify(
        &self,
        transaction: &Transaction<'_>,
        reference: &str,
    ) -> Result<VerifiedTrustedSkill, StoreError>;
}

/// Canonical producer identity and provenance returned by the host verifier.
#[derive(Debug, Clone)]
pub struct VerifiedTaskResultProducer {
    /// Canonical worker identity bound to the current lease.
    pub worker_id: String,
    /// Canonical authenticated producer identity.
    pub producer_id: String,
    /// SHA-256 of verifier-owned provenance/attestation bytes.
    pub provenance_sha256: String,
}

/// Host-owned authenticator for result producers. The verifier must bind the
/// producer to the exact workflow/task/attempt context; no default authority exists.
pub trait TaskResultProducerVerifier: Send + Sync {
    /// Authenticate the asserted producer and return its canonical identity.
    fn authenticate_producer(
        &self,
        transaction: &Transaction<'_>,
        workflow_id: &str,
        task_id: &str,
        request: &TaskResultRequest,
    ) -> Result<String, StoreError>;

    /// Authenticate an immutable event envelope and its provenance. Existing
    /// worker-only verifiers fail closed until they explicitly implement this contract.
    fn authenticate_envelope(
        &self,
        _transaction: &Transaction<'_>,
        _workflow_id: &str,
        _task_id: &str,
        _envelope: &TaskResultEnvelope,
    ) -> Result<VerifiedTaskResultProducer, StoreError> {
        Err(StoreError::ApprovalAuthorityUnavailable)
    }
}

/// Untrusted request to approve an exact proposal and immutable plan.
#[derive(Debug, Clone)]
pub struct ApprovalRequest {
    /// Authenticated actor asserted by the transport adapter.
    pub actor: String,
    /// Exact proposal digest shown to the reviewer.
    pub expected_proposal_hash: String,
    /// Exact plan digest shown to the reviewer.
    pub expected_plan_hash: String,
    /// Raw approval evidence for independent verification.
    pub evidence: serde_json::Value,
}

/// Result emitted only by the configured approval verifier.
#[derive(Debug, Clone)]
pub struct VerifiedApproval {
    /// Authenticated reviewer identity.
    pub actor: String,
    /// Verified authority evidence bound to the proposal and plan.
    pub evidence: serde_json::Value,
}

/// Verification context distinguishes first-time nonce consumption from
/// subsequent read-only authority revalidation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalVerificationMode {
    /// Verify a new decision and consume its nonce/high-water in this transaction.
    Initial,
    /// Revalidate persisted approval at task claim/provider dispatch; do not consume nonce again.
    Revalidate,
}

/// Host-provisioned authority verifier. It runs inside the same SQLite writer
/// transaction as approval/claim/dispatch so nonce and policy high-water writes
/// can be atomic with the protected operation.
pub trait ApprovalVerifier: Send + Sync {
    /// Verify exact proposal/plan binding and optionally persist anti-replay
    /// observations through the supplied active transaction.
    fn verify(
        &self,
        transaction: &Transaction<'_>,
        proposal: &WorkflowProposal,
        plan: &WorkflowPlan,
        request: &ApprovalRequest,
        mode: ApprovalVerificationMode,
    ) -> Result<VerifiedApproval, StoreError>;
}

/// Host authority for a workflow cancellation request. The returned actor must
/// be derived from authenticated caller evidence, never copied from request text.
pub trait WorkflowCancellationVerifier: Send + Sync {
    /// Authenticate the caller and authorize cancellation of this exact workflow.
    fn verify_cancel(
        &self,
        transaction: &Transaction<'_>,
        workflow: &WorkflowView,
        asserted_actor: &str,
        reason: &str,
    ) -> Result<String, StoreError>;
}

/// Explicit workflow cancellation request.
#[derive(Debug, Clone)]
pub struct WorkflowCancellationRequest {
    /// Caller assertion; verifier must authenticate it independently.
    pub actor: String,
    /// Human-readable bounded cancellation reason.
    pub reason: String,
}

/// Reject-all verifier used until production trust is provisioned.
#[derive(Debug, Default)]
pub struct DenyAllApprovalVerifier;

impl ApprovalVerifier for DenyAllApprovalVerifier {
    fn verify(
        &self,
        _transaction: &Transaction<'_>,
        _proposal: &WorkflowProposal,
        _plan: &WorkflowPlan,
        _request: &ApprovalRequest,
        _mode: ApprovalVerificationMode,
    ) -> Result<VerifiedApproval, StoreError> {
        Err(StoreError::ApprovalAuthorityUnavailable)
    }
}

/// Verification result for the append-only per-workflow event hash chain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventChainVerification {
    /// Workflow whose journal was inspected.
    pub workflow_id: String,
    /// Whether every link and event digest verified.
    pub valid: bool,
    /// Number of events inspected.
    pub event_count: u64,
    /// Digest of the final event when the journal is non-empty.
    pub head_hash: Option<String>,
    /// First sequence with an invalid previous hash or content digest.
    pub failure_sequence: Option<i64>,
}

/// Current mutable graph head metadata. Historical snapshots remain immutable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphInfo {
    /// Stable graph identity.
    pub graph_id: String,
    /// Monotonically increasing graph revision.
    pub revision: u64,
    /// RFC 3339 creation timestamp.
    pub created_at: String,
    /// RFC 3339 last mutation timestamp.
    pub updated_at: String,
}

struct StoredGraphSnapshotRow {
    revision: i64,
    previous_revision: Option<i64>,
    previous_hash: Option<String>,
    snapshot_hash: String,
    snapshot_json: String,
}

/// Durable store error.
#[derive(Debug, Error)]
pub enum StoreError {
    /// SQLite operation failed.
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// Filesystem setup failed.
    #[error("database file error: {0}")]
    Io(#[from] std::io::Error),
    /// Typed JSON could not be encoded/decoded.
    #[error("durable JSON error: {0}")]
    Json(#[from] serde_json::Error),
    /// Workflow or task does not exist.
    #[error("not found: {0}")]
    NotFound(String),
    /// State or invariant rejected the operation.
    #[error("workflow invariant rejected operation: {0}")]
    Invariant(String),
    /// Workflow must have an exact current approval.
    #[error("workflow is not approved against its current immutable plan")]
    ApprovalRequired,
    /// No host-provisioned approval authority is available.
    #[error("approval authority is unavailable")]
    ApprovalAuthorityUnavailable,
    /// Signed maker/checker approval evidence failed a stable trust rule.
    #[error("approval evidence rejected ({code}): {message}")]
    ApprovalEvidenceRejected {
        /// Stable rejection code from the trust verifier.
        code: String,
        /// Bounded diagnostic message from the trust verifier.
        message: String,
    },
    /// Approval request is not bound to the current proposal and plan.
    #[error("approval request is not bound to the current proposal and plan")]
    ApprovalBindingMismatch,
    /// Configured verifier returned malformed or differently bound output.
    #[error("approval verifier returned invalid output")]
    InvalidVerifierOutput,
    /// External result envelope failed immutable identity, payload, or provenance checks.
    #[error("task result envelope rejected: {0}")]
    ResultEnvelopeRejected(String),
    /// Task dependencies are not all successful.
    #[error("task dependencies have not all succeeded")]
    DependenciesNotReady,
    /// Task cannot be claimed from its current state.
    #[error("task is not claimable in its current state")]
    TaskNotClaimable,
    /// Worker, attempt, lease, or expiry does not match exactly.
    #[error("task lease fencing check failed")]
    LeaseFenced,
    /// A renewal identity has already been bound to a different request.
    #[error("task lease renewal identity conflicts with an existing request")]
    LeaseRenewalConflict,
    /// An execution-fence identity or request digest conflicts with durable state.
    #[error("worker execution fence conflicts with durable state")]
    WorkerExecutionFenceConflict,
    /// A completed execution fence cannot be completed with different evidence.
    #[error("worker execution fence already has a different completion")]
    WorkerExecutionFenceFinalized,
    /// A terminal execution-fence observation requires an external proof verifier.
    #[error("worker execution-fence terminal completion authority is unavailable")]
    WorkerExecutionFenceCompletionAuthorityUnavailable,
    /// Outcome evidence does not satisfy its producer or success contract.
    #[error("task result evidence is invalid: {0}")]
    InvalidEvidence(String),
    /// Caller attempted to open an existing path using create_new.
    #[error("refusing to replace an existing database file")]
    AlreadyExists,
    /// Database schema version is unsupported.
    #[error("unsupported database schema version: expected {SCHEMA_VERSION}, found {0}")]
    SchemaVersion(i64),
    /// Task attempt cannot fit the signed SQLite integer contract.
    #[error("task attempt exceeds SQLite's signed integer range")]
    InvalidAttempt,
    /// Verified evidence must pass an externally provisioned verifier capability.
    #[error("graph evidence verification authority is not configured")]
    EvidenceAuthorityRequired,
    /// Graph has not changed since the last immutable snapshot.
    #[error("graph has no new revision to snapshot")]
    SnapshotUnchanged,
    /// An idempotency key or task attempt is already bound to a different request.
    #[error("provider dispatch idempotency binding conflicts with an existing intent")]
    ProviderIntentConflict,
    /// A terminal provider outcome cannot be replaced.
    #[error("provider dispatch intent already has a different terminal outcome")]
    ProviderIntentFinalized,
    /// A mutex was poisoned after a panic.
    #[error("database mutex is poisoned")]
    Poisoned,
}

impl Store {
    /// Current schema version for CLI and host compatibility reporting.
    pub const CURRENT_SCHEMA_VERSION: i64 = SCHEMA_VERSION;

    /// Check live database readiness without creating, migrating or checkpointing it.
    /// This is a read-only probe intended for a long-running Control host.
    pub fn check_readiness(&self) -> Result<(), StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let schema_version: i64 =
            connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if schema_version != SCHEMA_VERSION {
            return Err(StoreError::SchemaVersion(schema_version));
        }
        let quick_check: String =
            connection.query_row("PRAGMA quick_check(1)", [], |row| row.get(0))?;
        if quick_check != "ok" {
            return Err(StoreError::Invariant(format!(
                "SQLite quick_check failed: {quick_check}"
            )));
        }
        let mut foreign_keys = connection.prepare("PRAGMA foreign_key_check")?;
        if foreign_keys.query([])?.next()?.is_some() {
            return Err(StoreError::Invariant(
                "SQLite foreign_key_check found a violation".into(),
            ));
        }
        let quarantine: Option<(String, String)> = connection
            .query_row(
                "SELECT operation_id,reason FROM agg_checkpoint_store_quarantine WHERE singleton=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((operation_id, reason)) = quarantine {
            return Err(StoreError::Invariant(format!(
                "workflow database is checkpoint-quarantined by operation {operation_id}: {reason}"
            )));
        }
        Ok(())
    }

    /// Inspect an existing Rust workflow DB without creating, migrating,
    /// checkpointing, or otherwise mutating it.
    pub fn inspect_health_read_only(path: &Path) -> Result<StoreHealthSnapshot, StoreError> {
        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(StoreError::Invariant(
                "health inspection requires a regular database file, not a symlink".into(),
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(StoreError::Invariant(
                    "database permissions are not private (expected owner-only access)".into(),
                ));
            }
        }
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(std::time::Duration::from_secs(2))?;
        connection.pragma_update(None, "query_only", "ON")?;
        let schema_version: i64 =
            connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if schema_version != SCHEMA_VERSION {
            return Err(StoreError::SchemaVersion(schema_version));
        }
        let quick_check: String =
            connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        if quick_check != "ok" {
            return Err(StoreError::Invariant(format!(
                "SQLite quick_check failed: {quick_check}"
            )));
        }
        let count = |sql: &str| -> Result<u64, StoreError> {
            let value: i64 = connection.query_row(sql, [], |row| row.get(0))?;
            u64::try_from(value)
                .map_err(|_| StoreError::Invariant("negative durable record count".into()))
        };
        let optional_count = |table: &str| -> Result<u64, StoreError> {
            let exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                params![table],
                |row| row.get(0),
            )?;
            if exists {
                count(&format!("SELECT COUNT(*) FROM {table}"))
            } else {
                Ok(0)
            }
        };
        Ok(StoreHealthSnapshot {
            database_path: path.to_string_lossy().into_owned(),
            database_bytes: metadata.len(),
            schema_version,
            quick_check,
            workflows: count("SELECT COUNT(*) FROM workflows")?,
            tasks: count("SELECT COUNT(*) FROM tasks")?,
            running_tasks: count("SELECT COUNT(*) FROM tasks WHERE state='RUNNING'")?,
            leased_tasks: count("SELECT COUNT(*) FROM tasks WHERE lease_id IS NOT NULL")?,
            provider_intents: count("SELECT COUNT(*) FROM provider_dispatch_intents")?,
            provider_observations: count(
                "SELECT COUNT(*) FROM provider_reconciliation_observations",
            )?,
            task_attempts: count("SELECT COUNT(*) FROM task_attempts")?,
            task_lease_renewals: count("SELECT COUNT(*) FROM task_lease_renewals")?,
            worker_execution_fences: count("SELECT COUNT(*) FROM worker_execution_fences")?,
            task_attempt_results: count("SELECT COUNT(*) FROM task_attempt_results")?,
            events: count("SELECT COUNT(*) FROM events")?,
            agent_sessions: count("SELECT COUNT(*) FROM agent_sessions")?,
            session_access_grants: count("SELECT COUNT(*) FROM session_access")?,
            session_messages: count("SELECT COUNT(*) FROM session_messages")?,
            custom_role_versions: count("SELECT COUNT(*) FROM custom_role_versions")?,
            custom_workflow_versions: count("SELECT COUNT(*) FROM custom_workflow_versions")?,
            custom_workflow_plans: count("SELECT COUNT(*) FROM custom_workflow_plans")?,
            control_catalog_events: count("SELECT COUNT(*) FROM control_catalog_events")?,
            workflow_policy_versions: optional_count("workflow_policy_versions")?,
            workflow_policy_attachments: optional_count("workflow_policy_attachments")?,
            workflow_success_contracts: optional_count("workflow_success_contracts")?,
            governance_trust_configuration_versions: count(
                "SELECT COUNT(*) FROM governance_trust_configuration_versions",
            )?,
            governance_reviewer_identity_versions: count(
                "SELECT COUNT(*) FROM governance_reviewer_identity_versions",
            )?,
            governance_decisions: optional_count("governance_decisions")?,
            governance_decision_events: optional_count("governance_decision_events")?,
            agg_attestation_nonces: count("SELECT COUNT(*) FROM agg_attestation_nonces")?,
            workflow_result_inbox: optional_count("workflow_result_inbox")?,
            custom_role_trusted_skill_pins: optional_count("custom_role_trusted_skill_pins")?,
            agg_checkpoint_operations: optional_count("agg_checkpoint_operations")?,
            agg_checkpoint_operation_events: optional_count("agg_checkpoint_operation_events")?,
            agg_checkpoint_store_quarantined: optional_count("agg_checkpoint_store_quarantine")?
                > 0,
            read_only: true,
        })
    }

    /// Create an isolated in-memory store for tests and disposable runs.
    pub fn in_memory() -> Result<Self, StoreError> {
        let uri = format!(
            "file:runalith-store-{}?mode=memory&cache=shared",
            Uuid::new_v4().simple()
        );
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_SHARED_CACHE;
        let connection = Connection::open_with_flags(&uri, flags)?;
        configure_connection(&connection)?;
        migrate_new_database(&connection)?;
        let trust_connection = Connection::open_with_flags(&uri, flags)?;
        configure_connection(&trust_connection)?;
        verify_same_database(&connection, &trust_connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
            trust_connection: Mutex::new(trust_connection),
        })
    }

    /// Persist the first immutable version of a Node-compatible workflow policy.
    pub fn create_workflow_policy(
        &self,
        definition: WorkflowPolicyDefinition,
        created_by: &str,
    ) -> Result<WorkflowPolicyVersion, StoreError> {
        validate_catalog_actor(created_by)?;
        validate_workflow_policy_definition(&definition)?;
        let policy_id = definition.policy_id.clone();
        let digest = workflow_policy_digest(&policy_id, 1, &definition)?;
        let definition_json = serde_json::to_string(&definition)?;
        let created_at = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM workflow_policy_versions WHERE policy_id=?1)",
            params![policy_id],
            |row| row.get(0),
        )?;
        if exists {
            return Err(StoreError::Invariant(format!(
                "workflow policy already exists: {policy_id}; append a new version"
            )));
        }
        transaction.execute(
            "INSERT INTO workflow_policy_versions(policy_id,version,definition_json,content_sha256,created_by,created_at) VALUES(?1,1,?2,?3,?4,?5)",
            params![policy_id, definition_json, digest, created_by, created_at],
        )?;
        insert_workflow_policy_event(
            &transaction,
            WorkflowPolicyEvent {
                workflow_id: None,
                policy_id: &policy_id,
                version: Some(1),
                event_type: "created",
                payload: &serde_json::json!({"policy_id":policy_id,"version":1,"content_sha256":digest}),
                actor: created_by,
                created_at: &created_at,
            },
        )?;
        transaction.commit()?;
        Ok(WorkflowPolicyVersion {
            policy_id,
            version: 1,
            definition,
            content_sha256: digest,
            created_by: created_by.into(),
            created_at,
        })
    }

    /// Append an immutable policy version; prior versions and attachments remain pinned.
    pub fn update_workflow_policy(
        &self,
        policy_id: &str,
        definition: WorkflowPolicyDefinition,
        updated_by: &str,
    ) -> Result<WorkflowPolicyVersion, StoreError> {
        validate_catalog_slug(policy_id, "policy_id")?;
        validate_catalog_actor(updated_by)?;
        if definition.policy_id != policy_id {
            return Err(StoreError::Invariant(
                "policy identity cannot change during update".into(),
            ));
        }
        validate_workflow_policy_definition(&definition)?;
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let current = transaction.query_row(
            "SELECT version,definition_json FROM workflow_policy_versions WHERE policy_id=?1 ORDER BY version DESC LIMIT 1",
            params![policy_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        ).optional()?.ok_or_else(|| StoreError::NotFound(format!("workflow policy {policy_id}")))?;
        let current_version = u32::try_from(current.0)
            .map_err(|_| StoreError::Invariant("invalid workflow policy version".into()))?;
        let previous: WorkflowPolicyDefinition = serde_json::from_str(&current.1)?;
        if definition == previous {
            return Err(StoreError::Invariant(
                "workflow policy update contains no changes".into(),
            ));
        }
        let version = current_version
            .checked_add(1)
            .ok_or_else(|| StoreError::Invariant("workflow policy version overflow".into()))?;
        let digest = workflow_policy_digest(policy_id, version, &definition)?;
        let definition_json = serde_json::to_string(&definition)?;
        let created_at = now();
        transaction.execute(
            "INSERT INTO workflow_policy_versions(policy_id,version,definition_json,content_sha256,created_by,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
            params![policy_id, version, definition_json, digest, updated_by, created_at],
        )?;
        insert_workflow_policy_event(
            &transaction,
            WorkflowPolicyEvent {
                workflow_id: None,
                policy_id,
                version: Some(version),
                event_type: "updated",
                payload: &serde_json::json!({"policy_id":policy_id,"previous_version":current_version,"version":version,"content_sha256":digest}),
                actor: updated_by,
                created_at: &created_at,
            },
        )?;
        transaction.commit()?;
        Ok(WorkflowPolicyVersion {
            policy_id: policy_id.into(),
            version,
            definition,
            content_sha256: digest,
            created_by: updated_by.into(),
            created_at,
        })
    }

    /// Read an exact immutable policy version, verifying normalized content and digest.
    pub fn get_workflow_policy(
        &self,
        policy_id: &str,
        version: Option<u32>,
    ) -> Result<WorkflowPolicyVersion, StoreError> {
        validate_catalog_slug(policy_id, "policy_id")?;
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        load_workflow_policy(&connection, policy_id, version)
    }

    /// Validate a closed policy definition and return its version-one content digest.
    pub fn validate_workflow_policy(
        definition: &WorkflowPolicyDefinition,
    ) -> Result<String, StoreError> {
        validate_workflow_policy_definition(definition)?;
        workflow_policy_digest(&definition.policy_id, 1, definition)
    }

    /// Bounded deterministic policy catalog; enforcement status is explicit per predicate.
    pub fn workflow_policy_catalog() -> serde_json::Value {
        serde_json::json!({
            "schema_version":1,
            "supported_rule_count":11,
            "rule_types":[
                {"type":"all_tasks_completed","description":"Every immutable child task must have a successful durable completed result.","required_fields":[],"enforcement":"persisted task result evaluation"},
                {"type":"local_execution_only","description":"Every planned task must use an approved local execution contract.","required_fields":[],"enforcement":"UNRESOLVED: no immutable executor contract in current plan schema"},
                {"type":"workflow_id_equals","description":"The approved plan workflow ID must match the selected slug.","required_fields":["expected"],"enforcement":"attachment/plan compatibility and completion evaluation"},
                {"type":"task_status_equals","description":"A named immutable plan task must be durably completed.","required_fields":["task_id","expected"],"enforcement":"plan compatibility and persisted task-state evaluation"},
                {"type":"execution_exit_code_equals","description":"A named deterministic task must have durable completed execution evidence and exit code zero.","required_fields":["task_id","expected"],"enforcement":"UNRESOLVED: no authoritative execution exit-code field in Workflow Control store"},
                {"type":"task_role_present","description":"The immutable plan must contain the named specialist role.","required_fields":["role"],"enforcement":"attachment/plan compatibility and completion evaluation"},
                {"type":"task_role_absent","description":"The immutable plan must not contain the named role.","required_fields":["role"],"enforcement":"attachment/plan compatibility and completion evaluation"},
                {"type":"artifact_exists","description":"An active validated artifact must be bound to a successful durable producer result.","required_fields":["artifact_type"],"enforcement":"UNRESOLVED: no validated typed artifact registry/provenance join"},
                {"type":"artifact_field_equals","description":"A top-level scalar in an eligible artifact must equal the specified value.","required_fields":["artifact_type","field","expected"],"enforcement":"UNRESOLVED: no validated typed artifact content registry"},
                {"type":"artifact_field_includes","description":"An eligible artifact array must include the specified scalar.","required_fields":["artifact_type","field","expected"],"enforcement":"UNRESOLVED: no validated typed artifact content registry"},
                {"type":"artifact_field_non_empty","description":"A top-level field in an eligible artifact must be a non-empty string, array, or object.","required_fields":["artifact_type","field"],"enforcement":"UNRESOLVED: no validated typed artifact content registry"}
            ]
        })
    }

    /// List immutable policy versions, optionally collapsed to each latest version.
    pub fn list_workflow_policies(
        &self,
        include_versions: bool,
        limit: u64,
        query: Option<&str>,
    ) -> Result<Vec<WorkflowPolicyVersion>, StoreError> {
        let limit = limit.clamp(1, 200) as usize;
        let query = query.unwrap_or_default().trim();
        if query.len() > 120 {
            return Err(StoreError::Invariant(
                "workflow policy query exceeds 120 characters".into(),
            ));
        }
        let escaped = query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let pattern = format!("%{escaped}%");
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let mut statement = if include_versions {
            connection.prepare("SELECT policy_id,version FROM workflow_policy_versions WHERE (?1='' OR policy_id LIKE ?2 ESCAPE '\\' OR json_extract(definition_json,'$.name') LIKE ?2 ESCAPE '\\') ORDER BY policy_id,version DESC LIMIT ?3")?
        } else {
            connection.prepare("SELECT policy_id,version FROM workflow_policy_versions v WHERE version=(SELECT MAX(latest.version) FROM workflow_policy_versions latest WHERE latest.policy_id=v.policy_id) AND (?1='' OR policy_id LIKE ?2 ESCAPE '\\' OR json_extract(definition_json,'$.name') LIKE ?2 ESCAPE '\\') ORDER BY json_extract(definition_json,'$.name') COLLATE NOCASE,policy_id LIMIT ?3")?
        };
        let rows = statement
            .query_map(params![query, pattern, limit as i64], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        rows.into_iter()
            .map(|(policy_id, version)| {
                load_workflow_policy(&connection, &policy_id, Some(version))
            })
            .collect()
    }

    /// Read exact immutable policy attachments with their workflow lifecycle state.
    pub fn list_workflow_policy_attachments(
        &self,
        policy_id: Option<&str>,
        limit: u64,
    ) -> Result<Vec<serde_json::Value>, StoreError> {
        if let Some(policy_id) = policy_id {
            validate_catalog_slug(policy_id, "policy_id")?;
        }
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT a.workflow_id,a.policy_id,a.version,a.content_sha256,a.attached_by,a.attached_at,w.state,w.plan_sha256
             FROM workflow_policy_attachments a JOIN workflows w ON w.workflow_id=a.workflow_id
             WHERE (?1 IS NULL OR a.policy_id=?1) ORDER BY a.attached_at DESC,a.workflow_id LIMIT ?2",
        )?;
        let rows = statement.query_map(params![policy_id,limit.clamp(1,200) as i64], |row| Ok(serde_json::json!({
            "workflow_id":row.get::<_,String>(0)?,"policy_id":row.get::<_,String>(1)?,
            "version":row.get::<_,u32>(2)?,"content_sha256":row.get::<_,String>(3)?,
            "attached_by":row.get::<_,String>(4)?,"attached_at":row.get::<_,String>(5)?,
            "workflow_state":row.get::<_,String>(6)?,"plan_sha256":row.get::<_,Option<String>>(7)?
        })))?.collect::<Result<Vec<_>,_>>()?;
        Ok(rows)
    }

    /// Read append-only policy audit events.
    pub fn list_workflow_policy_events(
        &self,
        policy_id: Option<&str>,
        limit: u64,
    ) -> Result<Vec<serde_json::Value>, StoreError> {
        if let Some(policy_id) = policy_id {
            validate_catalog_slug(policy_id, "policy_id")?;
        }
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT event_id,workflow_id,policy_id,version,event_type,payload_json,actor,created_at
             FROM workflow_policy_events WHERE (?1 IS NULL OR policy_id=?1) ORDER BY event_seq DESC LIMIT ?2",
        )?;
        let rows = statement.query_map(params![policy_id,limit.clamp(1,500) as i64], |row| {
            let payload: String = row.get(5)?;
            Ok(serde_json::json!({
                "event_id":row.get::<_,String>(0)?,"workflow_id":row.get::<_,Option<String>>(1)?,
                "policy_id":row.get::<_,String>(2)?,"version":row.get::<_,Option<u32>>(3)?,
                "event_type":row.get::<_,String>(4)?,"payload":serde_json::from_str::<serde_json::Value>(&payload).unwrap_or(serde_json::Value::Null),
                "actor":row.get::<_,String>(6)?,"created_at":row.get::<_,String>(7)?
            }))
        })?.collect::<Result<Vec<_>,_>>()?;
        Ok(rows)
    }

    /// Read and integrity-check the latest success contract for a workflow.
    pub fn get_workflow_success_contract(
        &self,
        workflow_id: &str,
    ) -> Result<Option<WorkflowSuccessContractSnapshot>, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        verify_workflow_success_contract(&connection, workflow_id, None, false)?;
        let row = connection.query_row(
            "SELECT version,base_contract_json,composed_contract_json,policy_pins_json,content_sha256,plan_sha256,created_by,created_at FROM workflow_success_contracts WHERE workflow_id=?1 ORDER BY version DESC LIMIT 1",
            params![workflow_id],
            |row| Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,Option<String>>(5)?,row.get::<_,String>(6)?,row.get::<_,String>(7)?)),
        ).optional()?;
        row.map(|row| {
            Ok(WorkflowSuccessContractSnapshot {
                workflow_id: workflow_id.into(),
                version: u32::try_from(row.0).map_err(|_| {
                    StoreError::Invariant("invalid success contract version".into())
                })?,
                base_contract: serde_json::from_str(&row.1)?,
                composed_contract: serde_json::from_str(&row.2)?,
                policy_pins: serde_json::from_str(&row.3)?,
                content_sha256: row.4,
                plan_sha256: row.5,
                created_by: row.6,
                created_at: row.7,
            })
        })
        .transpose()
    }

    /// Attach an exact policy version and persist a composed success contract before approval.
    pub fn attach_workflow_policy(
        &self,
        workflow_id: &str,
        policy_id: &str,
        version: Option<u32>,
        base_contract: serde_json::Value,
        attached_by: &str,
    ) -> Result<WorkflowPolicyAttachment, StoreError> {
        validate_catalog_slug(policy_id, "policy_id")?;
        validate_catalog_actor(attached_by)?;
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let workflow = load_workflow_from(&transaction, workflow_id)?;
        if workflow.state != WorkflowState::Proposed
            || workflow.plan_hash.is_some()
            || workflow.approval.is_some()
        {
            return Err(StoreError::Invariant(
                "policy attachment requires an unapproved proposed workflow".into(),
            ));
        }
        let selected = load_workflow_policy(&transaction, policy_id, version)?;
        let duplicate: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM workflow_policy_attachments WHERE workflow_id=?1 AND policy_id=?2)",
            params![workflow_id, policy_id],
            |row| row.get(0),
        )?;
        if duplicate {
            return Err(StoreError::Invariant(format!(
                "workflow policy already attached: {policy_id}"
            )));
        }
        let previous_base: Option<String> = transaction.query_row(
            "SELECT base_contract_json FROM workflow_success_contracts WHERE workflow_id=?1 ORDER BY version DESC LIMIT 1",
            params![workflow_id],
            |row| row.get(0),
        ).optional()?;
        let base = if let Some(previous) = previous_base {
            let stored: serde_json::Value = serde_json::from_str(&previous)?;
            let supplied = normalize_success_contract(base_contract, &workflow.proposal.goal)?;
            if stored != supplied {
                return Err(StoreError::Invariant(
                    "base success contract is immutable after first policy attachment".into(),
                ));
            }
            stored
        } else {
            normalize_success_contract(base_contract, &workflow.proposal.goal)?
        };
        let mut policies = load_workflow_policy_attachments(&transaction, workflow_id)?;
        if policies.len() >= 32 {
            return Err(StoreError::Invariant(
                "a workflow may attach at most 32 policy packs".into(),
            ));
        }
        policies.push(selected.clone());
        policies.sort_by(|left, right| left.policy_id.cmp(&right.policy_id));
        validate_policy_plan_compatibility(&workflow.proposal, &workflow.plan, &policies)?;
        let composed = compose_success_contract(&base, &policies)?;
        let pins: Vec<serde_json::Value> = policies.iter().map(|policy| serde_json::json!({
            "policy_id":policy.policy_id,"version":policy.version,"content_hash":policy.content_sha256
        })).collect();
        let contract_digest = content_hash(&serde_json::json!({
            "base_contract":base,"composed_contract":composed,"policy_pins":pins
        }))
        .map_err(|error| StoreError::Invariant(error.to_string()))?;
        let attachment = WorkflowPolicyAttachment {
            workflow_id: workflow_id.into(),
            policy_id: selected.policy_id.clone(),
            version: selected.version,
            content_sha256: selected.content_sha256.clone(),
            attached_by: attached_by.into(),
            attached_at: now(),
        };
        transaction.execute(
            "INSERT INTO workflow_policy_attachments(workflow_id,policy_id,version,content_sha256,attached_by,attached_at) VALUES(?1,?2,?3,?4,?5,?6)",
            params![attachment.workflow_id,attachment.policy_id,attachment.version,attachment.content_sha256,attachment.attached_by,attachment.attached_at],
        )?;
        let contract_version: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(version),0)+1 FROM workflow_success_contracts WHERE workflow_id=?1",
            params![workflow_id],
            |row| row.get(0),
        )?;
        transaction.execute(
            "INSERT INTO workflow_success_contracts(workflow_id,version,base_contract_json,composed_contract_json,policy_pins_json,content_sha256,plan_sha256,created_by,created_at) VALUES(?1,?2,?3,?4,?5,?6,NULL,?7,?8)",
            params![workflow_id,contract_version,serde_json::to_string(&base)?,serde_json::to_string(&composed)?,serde_json::to_string(&pins)?,contract_digest,attached_by,attachment.attached_at],
        )?;
        insert_workflow_policy_event(
            &transaction,
            WorkflowPolicyEvent {
                workflow_id: Some(workflow_id),
                policy_id,
                version: Some(selected.version),
                event_type: "attached",
                payload: &serde_json::json!({"workflow_id":workflow_id,"policy_id":policy_id,"version":selected.version,"content_sha256":selected.content_sha256,"contract_version":contract_version,"contract_sha256":contract_digest}),
                actor: attached_by,
                created_at: &attachment.attached_at,
            },
        )?;
        insert_event(
            &transaction,
            workflow_id,
            None,
            "workflow.policy_attached",
            &serde_json::json!({"policy_id":policy_id,"version":selected.version,"content_sha256":selected.content_sha256,"contract_version":contract_version,"contract_sha256":contract_digest}),
            &format!("policy-attach:{policy_id}:{}", selected.version),
            &attachment.attached_at,
        )?;
        transaction.commit()?;
        Ok(attachment)
    }

    /// Create a new private SQLite database. Existing paths are never opened or overwritten.
    pub fn create_new(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let path = path.as_ref();
        let parent = path
            .parent()
            .filter(|value| !value.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let canonical_parent = fs::canonicalize(parent)?;
        let filename = path
            .file_name()
            .ok_or_else(|| StoreError::Invariant("database path has no filename".into()))?;
        let canonical_path = canonical_parent.join(filename);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = match options.open(&canonical_path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(StoreError::AlreadyExists);
            }
            Err(error) => return Err(StoreError::Io(error)),
        };
        drop(file);

        let connection = Connection::open_with_flags(
            &canonical_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&canonical_path, fs::Permissions::from_mode(0o600))?;
            let metadata = fs::metadata(&canonical_path)?;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(StoreError::Invariant("database file is not private".into()));
            }
        }
        configure_connection(&connection)?;
        migrate_new_database(&connection)?;
        let trust_connection = open_trust_connection(&canonical_path, &connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
            trust_connection: Mutex::new(trust_connection),
        })
    }

    /// Open an existing Rust-owned database without applying migrations.
    pub fn open_existing(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let path = path.as_ref();
        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(StoreError::Invariant(
                "database path must be a regular non-symlink file".into(),
            ));
        }
        let canonical_path = fs::canonicalize(path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(StoreError::Invariant(
                    "database file permissions expose state to group/world".into(),
                ));
            }
        }
        let connection = Connection::open_with_flags(
            &canonical_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        configure_connection(&connection)?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version != SCHEMA_VERSION {
            return Err(StoreError::SchemaVersion(version));
        }
        let trust_connection = open_trust_connection(&canonical_path, &connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
            trust_connection: Mutex::new(trust_connection),
        })
    }

    /// Explicitly migrate an existing Rust schema-v2 through v20 database to current schema.
    /// This is never called by host startup and refuses every other schema version.
    pub fn migrate_existing_rust_database(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let path = path.as_ref();
        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(StoreError::Invariant(
                "migration path must be a regular non-symlink file".into(),
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(StoreError::Invariant(
                    "migration database permissions expose state to group/world".into(),
                ));
            }
        }
        let canonical_path = fs::canonicalize(path)?;
        let connection = Connection::open_with_flags(
            &canonical_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        configure_connection(&connection)?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if !(2..=20).contains(&version) {
            return Err(StoreError::SchemaVersion(version));
        }
        let required_tables: &[&str] = if version >= 3 {
            &[
                "workflows",
                "tasks",
                "events",
                "graphs",
                "graph_nodes",
                "graph_snapshots",
            ]
        } else {
            &["workflows", "tasks", "events"]
        };
        for table in required_tables {
            let exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                params![table],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(StoreError::Invariant(format!(
                    "not a recognized Rust schema-v{version} database: missing {table}"
                )));
            }
        }
        ProviderLedger::validate_legacy_schema(&connection, version)
            .map_err(provider_store_error)?;
        migrate_new_database(&connection)?;
        let trust_connection = open_trust_connection(&canonical_path, &connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
            trust_connection: Mutex::new(trust_connection),
        })
    }

    /// Persist a validated review-only proposal and initial task projection.
    pub fn create_proposal(&self, proposal: WorkflowProposal) -> Result<WorkflowView, StoreError> {
        proposal
            .validate()
            .map_err(|error| StoreError::Invariant(error.to_string()))?;
        let proposal_hash =
            content_hash(&proposal).map_err(|error| StoreError::Invariant(error.to_string()))?;
        let plan = WorkflowPlan {
            schema_version: 1,
            tasks: proposal.tasks.clone(),
        };
        plan.validate()
            .map_err(|error| StoreError::Invariant(error.to_string()))?;
        let proposal_json = serde_json::to_string(&proposal)?;
        let plan_json = serde_json::to_string(&plan)?;
        let timestamp = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        transaction.execute(
            "INSERT INTO workflows(workflow_id,state,proposal_json,proposal_sha256,plan_json,plan_sha256,approval_json,created_at,updated_at) VALUES(?1,'PROPOSED',?2,?3,?4,NULL,NULL,?5,?5)",
            params![proposal.workflow_id, proposal_json, proposal_hash, plan_json, timestamp],
        )?;
        for (ordinal, task) in plan.tasks.iter().enumerate() {
            transaction.execute(
                "INSERT INTO tasks(task_id,workflow_id,ordinal,definition_json,state,attempts,lease_id,lease_owner,lease_expires_at,result_json) VALUES(?1,?2,?3,?4,'PENDING',0,NULL,NULL,NULL,NULL)",
                params![task.task_id, proposal.workflow_id, ordinal as i64, serde_json::to_string(task)?],
            )?;
        }
        insert_event(
            &transaction,
            &proposal.workflow_id,
            None,
            "workflow.proposed",
            &serde_json::json!({"proposalHash": proposal_hash}),
            &format!("proposal:{proposal_hash}"),
            &timestamp,
        )?;
        transaction.commit()?;
        drop(connection);
        self.get_workflow(&proposal.workflow_id)
    }

    /// Create a workflow instance from one exact immutable custom catalog plan.
    ///
    /// The caller supplies only the persisted plan ID and display text. Control
    /// reloads and recompiles the catalog version under the writer transaction,
    /// revalidates its trusted skills, derives the task projection, then records
    /// the catalog/instance binding in the append-only workflow journal. The
    /// instance ID and catalog workflow identity are never caller asserted.
    pub fn create_proposal_from_custom_workflow_plan(
        &self,
        plan_id: &str,
        idempotency_key: &str,
        title: &str,
        goal: &str,
        created_by: &str,
        resolver: &dyn TrustedSkillResolver,
    ) -> Result<WorkflowView, StoreError> {
        if plan_id.trim().is_empty() || plan_id.trim() != plan_id || plan_id.len() > 128 {
            return Err(StoreError::Invariant(
                "catalog plan ID must be 1 to 128 non-whitespace characters".into(),
            ));
        }
        if idempotency_key.trim().is_empty()
            || idempotency_key.trim() != idempotency_key
            || idempotency_key.len() > 128
        {
            return Err(StoreError::Invariant(
                "workflow creation idempotency key must be 1 to 128 non-whitespace characters"
                    .into(),
            ));
        }
        let created_by = validate_catalog_actor(created_by)?;
        let request_sha256 = content_hash(&serde_json::json!({
            "plan_id":plan_id,"title":title,"goal":goal,"created_by":created_by
        }))
        .map_err(|error| StoreError::Invariant(error.to_string()))?;
        let workflow_identity_sha256 = content_hash(&serde_json::json!({
            "idempotency_key":idempotency_key,"created_by":created_by
        }))
        .map_err(|error| StoreError::Invariant(error.to_string()))?;
        let workflow_id = format!("job_{workflow_identity_sha256}");
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;

        // The generated workflow identity is stable for this authenticated
        // principal/key pair. Exact retries return the original durable result;
        // a key rebound to changed inputs is a conflict, never a second workflow.
        let existing: Option<(String, String)> = transaction
            .query_row(
                "SELECT event_type,payload_json FROM events WHERE workflow_id=?1 AND idempotency_key=?2",
                params![workflow_id, format!("catalog-plan-bound:{workflow_id}")],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((event_type, payload_json)) = existing {
            if event_type != "workflow.catalog_plan_bound" {
                return Err(StoreError::Invariant(
                    "workflow creation idempotency key conflicts with another event".into(),
                ));
            }
            let payload: serde_json::Value = serde_json::from_str(&payload_json)?;
            if payload
                .get("idempotency_key")
                .and_then(serde_json::Value::as_str)
                != Some(idempotency_key)
                || payload
                    .get("request_sha256")
                    .and_then(serde_json::Value::as_str)
                    != Some(request_sha256.as_str())
            {
                return Err(StoreError::Invariant(
                    "workflow creation idempotency key is already bound to a different request"
                        .into(),
                ));
            }
            let workflow = load_workflow_from(&transaction, &workflow_id)?;
            if catalog_workflow_id_for_workflow(&transaction, &workflow)?.is_none() {
                return Err(StoreError::Invariant(
                    "idempotent workflow replay has no verified catalog binding".into(),
                ));
            }
            transaction.commit()?;
            drop(connection);
            return self.get_workflow(&workflow_id);
        }
        let workflow_id_exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM workflows WHERE workflow_id=?1)",
            params![workflow_id],
            |row| row.get(0),
        )?;
        if workflow_id_exists {
            return Err(StoreError::Invariant(
                "workflow creation identity collides with an existing unbound workflow".into(),
            ));
        }

        let (catalog_workflow_id, catalog_workflow_version, stored_plan_sha256, stored_plan_json): (
            String,
            i64,
            String,
            String,
        ) = transaction
            .query_row(
                "SELECT workflow_id,workflow_version,plan_sha256,plan_json FROM custom_workflow_plans WHERE plan_id=?1",
                params![plan_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(format!("custom workflow plan {plan_id}")))?;
        let catalog_workflow_version = u32::try_from(catalog_workflow_version)
            .map_err(|_| StoreError::Invariant("invalid custom workflow version".into()))?;
        let definition_json: String = transaction.query_row(
            "SELECT definition_json FROM custom_workflow_versions WHERE workflow_id=?1 AND version=?2",
            params![catalog_workflow_id, catalog_workflow_version],
            |row| row.get(0),
        )?;
        let definition: CustomWorkflowDefinition = serde_json::from_str(&definition_json)?;
        if definition.workflow_id != catalog_workflow_id
            || definition.version != catalog_workflow_version
        {
            return Err(StoreError::Invariant(
                "custom workflow definition identity does not match its catalog row".into(),
            ));
        }

        let stored_plan: CompiledWorkflowPlan = serde_json::from_str(&stored_plan_json)?;
        stored_plan
            .verify_digest()
            .map_err(|error| StoreError::Invariant(error.to_string()))?;
        if stored_plan.workflow_id() != catalog_workflow_id
            || stored_plan.workflow_version() != catalog_workflow_version
            || stored_plan.plan_hash() != stored_plan_sha256
        {
            return Err(StoreError::Invariant(
                "persisted catalog plan identity or digest mismatch".into(),
            ));
        }

        // Recompile from the exact immutable catalog/role versions in this same
        // transaction. A stale/revoked/substituted skill pin blocks proposal
        // creation before any workflow or journal row is written.
        let compiled =
            compile_custom_workflow_from_catalog(&transaction, &definition, Some(resolver))?;
        if compiled != stored_plan {
            return Err(StoreError::Invariant(
                "persisted custom workflow plan differs from its exact catalog compilation".into(),
            ));
        }

        let tasks = custom_workflow_task_specs(&compiled)?;
        let proposal = WorkflowProposal {
            workflow_id: workflow_id.clone(),
            title: title.to_owned(),
            goal: goal.to_owned(),
            tasks,
            metadata: BTreeMap::new(),
        };
        proposal
            .validate()
            .map_err(|error| StoreError::Invariant(error.to_string()))?;
        let proposal_sha256 =
            content_hash(&proposal).map_err(|error| StoreError::Invariant(error.to_string()))?;
        let plan = WorkflowPlan {
            schema_version: 1,
            tasks: proposal.tasks.clone(),
        };
        plan.validate()
            .map_err(|error| StoreError::Invariant(error.to_string()))?;
        let workflow_plan_sha256 =
            content_hash(&plan).map_err(|error| StoreError::Invariant(error.to_string()))?;
        let proposal_json = serde_json::to_string(&proposal)?;
        let plan_json = serde_json::to_string(&plan)?;
        let timestamp = now();
        transaction.execute(
            "INSERT INTO workflows(workflow_id,state,proposal_json,proposal_sha256,plan_json,plan_sha256,approval_json,created_at,updated_at) VALUES(?1,'PROPOSED',?2,?3,?4,NULL,NULL,?5,?5)",
            params![workflow_id, proposal_json, proposal_sha256, plan_json, timestamp],
        )?;
        for (ordinal, task) in plan.tasks.iter().enumerate() {
            transaction.execute(
                "INSERT INTO tasks(task_id,workflow_id,ordinal,definition_json,state,attempts,lease_id,lease_owner,lease_expires_at,result_json) VALUES(?1,?2,?3,?4,'PENDING',0,NULL,NULL,NULL,NULL)",
                params![task.task_id, workflow_id, ordinal as i64, serde_json::to_string(task)?],
            )?;
        }
        insert_event(
            &transaction,
            &workflow_id,
            None,
            "workflow.proposed",
            &serde_json::json!({"proposalHash": proposal_sha256}),
            &format!("proposal:{proposal_sha256}"),
            &timestamp,
        )?;
        insert_event(
            &transaction,
            &workflow_id,
            None,
            "workflow.catalog_plan_bound",
            &serde_json::json!({
                "catalog_plan_id":plan_id,
                "catalog_workflow_id":catalog_workflow_id,
                "catalog_workflow_version":catalog_workflow_version,
                "catalog_plan_sha256":stored_plan_sha256,
                "workflow_plan_sha256":workflow_plan_sha256,
                "created_by":created_by,
                "idempotency_key":idempotency_key,
                "request_sha256":request_sha256
            }),
            &format!("catalog-plan-bound:{workflow_id}"),
            &timestamp,
        )?;
        transaction.commit()?;
        drop(connection);
        self.get_workflow(&workflow_id)
    }

    /// Create the first immutable version of a custom role.
    pub fn create_custom_role(
        &self,
        mut definition: CustomRoleDefinition,
        created_by: &str,
    ) -> Result<CustomRoleVersion, StoreError> {
        definition.version = 1;
        validate_custom_role_definition(&definition)?;
        let created_by = validate_catalog_actor(created_by)?;
        let definition_json = serde_json::to_string(&definition)?;
        let definition_sha256 =
            content_hash(&definition).map_err(|error| StoreError::Invariant(error.to_string()))?;
        let created_at = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM custom_role_versions WHERE role_id=?1)",
            params![definition.role_id],
            |row| row.get(0),
        )?;
        if exists {
            return Err(StoreError::Invariant(format!(
                "custom role already exists: {}; use update to append a version",
                definition.role_id
            )));
        }
        transaction.execute(
            "INSERT INTO custom_role_versions(role_id,version,definition_json,definition_sha256,created_by,created_at) VALUES(?1,1,?2,?3,?4,?5)",
            params![definition.role_id, definition_json, definition_sha256, created_by, created_at],
        )?;
        insert_catalog_event(
            &transaction,
            "custom_role.created",
            &definition.role_id,
            1,
            created_by,
            &definition_sha256,
            &created_at,
        )?;
        transaction.commit()?;
        Ok(CustomRoleVersion {
            definition,
            definition_sha256,
            created_by: created_by.into(),
            created_at,
        })
    }

    /// Create an immutable role version after independent host verification of every skill.
    pub fn create_custom_role_with_trusted_skills(
        &self,
        mut definition: CustomRoleDefinition,
        created_by: &str,
        resolver: &dyn TrustedSkillResolver,
    ) -> Result<CustomRoleVersion, StoreError> {
        definition.version = 1;
        let created_by = validate_catalog_actor(created_by)?;
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM custom_role_versions WHERE role_id=?1)",
            params![definition.role_id],
            |row| row.get(0),
        )?;
        if exists {
            return Err(StoreError::Invariant(format!(
                "custom role already exists: {}; use update to append a version",
                definition.role_id
            )));
        }
        let created_at = now();
        let definition_json = serde_json::to_string(&definition)?;
        let definition_sha256 =
            content_hash(&definition).map_err(|error| StoreError::Invariant(error.to_string()))?;
        transaction.execute(
            "INSERT INTO custom_role_versions(role_id,version,definition_json,definition_sha256,created_by,created_at) VALUES(?1,1,?2,?3,?4,?5)",
            params![definition.role_id, definition_json, definition_sha256, created_by, created_at],
        )?;
        persist_verified_role_skills(&transaction, &definition, resolver, &created_at)?;
        insert_catalog_event(
            &transaction,
            "custom_role.created",
            &definition.role_id,
            1,
            created_by,
            &definition_sha256,
            &created_at,
        )?;
        transaction.commit()?;
        Ok(CustomRoleVersion {
            definition,
            definition_sha256,
            created_by: created_by.into(),
            created_at,
        })
    }

    /// Clone the latest immutable role definition while preserving its exact
    /// verified skill pins unless the caller supplies replacement skills.
    pub fn clone_custom_role(
        &self,
        source_role_id: &str,
        expected_source_version: u32,
        mut definition: CustomRoleDefinition,
        created_by: &str,
        resolver: Option<&dyn TrustedSkillResolver>,
    ) -> Result<CustomRoleVersion, StoreError> {
        validate_catalog_slug(source_role_id, "source_role_id")?;
        validate_catalog_slug(&definition.role_id, "role_id")?;
        if source_role_id == definition.role_id {
            return Err(StoreError::Invariant(
                "custom role clone must use a different role id".into(),
            ));
        }
        let created_by = validate_catalog_actor(created_by)?;
        definition.version = 1;

        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;

        let (source_version, source_json, source_sha256): (i64, String, String) = transaction
            .query_row(
                "SELECT version,definition_json,definition_sha256 FROM custom_role_versions
                 WHERE role_id=?1 ORDER BY version DESC LIMIT 1",
                params![source_role_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(format!("custom role {source_role_id}")))?;
        let source: CustomRoleDefinition = serde_json::from_str(&source_json)?;
        let source_version_u32 = u32::try_from(source_version)
            .map_err(|_| StoreError::Invariant("invalid source custom role version".into()))?;
        if source_version_u32 != expected_source_version {
            return Err(StoreError::Invariant(
                "source custom role changed during clone; retry from latest version".into(),
            ));
        }
        let source_digest =
            content_hash(&source).map_err(|error| StoreError::Invariant(error.to_string()))?;
        if source.role_id != source_role_id
            || source.version != source_version_u32
            || source_digest != source_sha256
        {
            return Err(StoreError::Invariant(
                "source custom role definition binding mismatch".into(),
            ));
        }

        let mut statement = transaction.prepare(
            "SELECT reference,skill_id,skill_version,content_sha256,verified_at
             FROM custom_role_trusted_skill_pins WHERE role_id=?1 AND role_version=?2
             ORDER BY reference",
        )?;
        let source_pins = statement
            .query_map(params![source_role_id, source_version], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u32>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);

        let mut source_references = BTreeSet::new();
        let mut source_skill_ids = BTreeSet::new();
        for (reference, skill_id, skill_version, content_sha256, verified_at) in &source_pins {
            if reference.trim().is_empty()
                || reference.trim() != reference
                || reference.len() > 2048
                || !source.skills.contains(reference)
                || skill_id.trim().is_empty()
                || skill_id.trim() != skill_id
                || skill_id.len() > 200
                || *skill_version == 0
                || content_sha256.len() != 64
                || !content_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                || verified_at.trim().is_empty()
                || !source_references.insert(reference.clone())
                || !source_skill_ids.insert(skill_id.clone())
            {
                return Err(StoreError::Invariant(
                    "source custom role has invalid trusted skill pin data".into(),
                ));
            }
        }
        if source_references.len() != source.skills.len() {
            return Err(StoreError::Invariant(
                "source custom role trusted skill pin set is incomplete or stale".into(),
            ));
        }

        let preserve_pins = definition.skills == source.skills;
        if preserve_pins && !source.skills.is_empty() {
            let resolver = resolver.ok_or_else(|| {
                StoreError::Invariant(
                    "host trusted skill resolver is required to revalidate cloned source pins"
                        .into(),
                )
            })?;
            revalidate_persisted_role_skills(&transaction, &source, Some(resolver))?;
        }
        let available_skills = if preserve_pins {
            source_references
        } else {
            definition.skills.iter().cloned().collect()
        };
        validate_custom_role(&definition, &available_skills)
            .map_err(|error| StoreError::Invariant(error.to_string()))?;
        if !preserve_pins && !definition.skills.is_empty() && resolver.is_none() {
            return Err(StoreError::Invariant(
                "host trusted skill resolver is required when replacing cloned skill references"
                    .into(),
            ));
        }

        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM custom_role_versions WHERE role_id=?1)",
            params![definition.role_id],
            |row| row.get(0),
        )?;
        if exists {
            return Err(StoreError::Invariant(format!(
                "custom role already exists: {}; use custom_role_update to create a new version",
                definition.role_id
            )));
        }

        let created_at = now();
        let definition_json = serde_json::to_string(&definition)?;
        let definition_sha256 =
            content_hash(&definition).map_err(|error| StoreError::Invariant(error.to_string()))?;
        transaction.execute(
            "INSERT INTO custom_role_versions(role_id,version,definition_json,definition_sha256,created_by,created_at)
             VALUES(?1,1,?2,?3,?4,?5)",
            params![definition.role_id, definition_json, definition_sha256, created_by, created_at],
        )?;
        if preserve_pins {
            for (reference, skill_id, skill_version, content_sha256, verified_at) in source_pins {
                transaction.execute(
                    "INSERT INTO custom_role_trusted_skill_pins
                     (role_id,role_version,reference,skill_id,skill_version,content_sha256,verified_at)
                     VALUES(?1,1,?2,?3,?4,?5,?6)",
                    params![definition.role_id, reference, skill_id, skill_version, content_sha256, verified_at],
                )?;
            }
        } else if let Some(resolver) = resolver {
            persist_verified_role_skills(&transaction, &definition, resolver, &created_at)?;
        }
        insert_catalog_event(
            &transaction,
            "custom_role.created",
            &definition.role_id,
            1,
            created_by,
            &definition_sha256,
            &created_at,
        )?;
        transaction.commit()?;
        Ok(CustomRoleVersion {
            definition,
            definition_sha256,
            created_by: created_by.into(),
            created_at,
        })
    }

    /// Append a new immutable custom role version; historical versions are retained.
    pub fn update_custom_role(
        &self,
        role_id: &str,
        mut definition: CustomRoleDefinition,
        created_by: &str,
    ) -> Result<CustomRoleVersion, StoreError> {
        validate_catalog_slug(role_id, "role_id")?;
        if definition.role_id != role_id {
            return Err(StoreError::Invariant(
                "custom role id cannot change during update".into(),
            ));
        }
        let created_by = validate_catalog_actor(created_by)?;
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let current = transaction.query_row(
            "SELECT version,definition_json FROM custom_role_versions WHERE role_id=?1 ORDER BY version DESC LIMIT 1",
            params![role_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        ).optional()?.ok_or_else(|| StoreError::NotFound(format!("custom role {role_id}")))?;
        let current_version = u32::try_from(current.0)
            .map_err(|_| StoreError::Invariant("invalid custom role version".into()))?;
        let previous: CustomRoleDefinition = serde_json::from_str(&current.1)?;
        definition.version = current_version
            .checked_add(1)
            .ok_or_else(|| StoreError::Invariant("custom role version overflow".into()))?;
        validate_custom_role_definition(&definition)?;
        let mut comparable = definition.clone();
        comparable.version = current_version;
        if comparable == previous {
            return Err(StoreError::Invariant(
                "custom role update contains no changes".into(),
            ));
        }
        let definition_json = serde_json::to_string(&definition)?;
        let definition_sha256 =
            content_hash(&definition).map_err(|error| StoreError::Invariant(error.to_string()))?;
        let created_at = now();
        transaction.execute(
            "INSERT INTO custom_role_versions(role_id,version,definition_json,definition_sha256,created_by,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
            params![role_id, definition.version, definition_json, definition_sha256, created_by, created_at],
        )?;
        insert_catalog_event(
            &transaction,
            "custom_role.versioned",
            role_id,
            definition.version,
            created_by,
            &definition_sha256,
            &created_at,
        )?;
        transaction.commit()?;
        Ok(CustomRoleVersion {
            definition,
            definition_sha256,
            created_by: created_by.into(),
            created_at,
        })
    }

    /// Append a role version after re-verifying exact skill identity and revocation status.
    pub fn update_custom_role_with_trusted_skills(
        &self,
        role_id: &str,
        mut definition: CustomRoleDefinition,
        created_by: &str,
        resolver: &dyn TrustedSkillResolver,
    ) -> Result<CustomRoleVersion, StoreError> {
        validate_catalog_slug(role_id, "role_id")?;
        if definition.role_id != role_id {
            return Err(StoreError::Invariant(
                "custom role id cannot change during update".into(),
            ));
        }
        let created_by = validate_catalog_actor(created_by)?;
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let current = transaction.query_row(
            "SELECT version,definition_json FROM custom_role_versions WHERE role_id=?1 ORDER BY version DESC LIMIT 1",
            params![role_id], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?)),
        ).optional()?.ok_or_else(|| StoreError::NotFound(format!("custom role {role_id}")))?;
        let current_version = u32::try_from(current.0)
            .map_err(|_| StoreError::Invariant("invalid custom role version".into()))?;
        let previous: CustomRoleDefinition = serde_json::from_str(&current.1)?;
        definition.version = current_version
            .checked_add(1)
            .ok_or_else(|| StoreError::Invariant("custom role version overflow".into()))?;
        let created_at = now();
        let mut comparable = definition.clone();
        comparable.version = current_version;
        if comparable == previous {
            return Err(StoreError::Invariant(
                "custom role update contains no changes".into(),
            ));
        }
        let definition_json = serde_json::to_string(&definition)?;
        let definition_sha256 =
            content_hash(&definition).map_err(|error| StoreError::Invariant(error.to_string()))?;
        transaction.execute(
            "INSERT INTO custom_role_versions(role_id,version,definition_json,definition_sha256,created_by,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
            params![role_id, definition.version, definition_json, definition_sha256, created_by, created_at],
        )?;
        persist_verified_role_skills(&transaction, &definition, resolver, &created_at)?;
        insert_catalog_event(
            &transaction,
            "custom_role.versioned",
            role_id,
            definition.version,
            created_by,
            &definition_sha256,
            &created_at,
        )?;
        transaction.commit()?;
        Ok(CustomRoleVersion {
            definition,
            definition_sha256,
            created_by: created_by.into(),
            created_at,
        })
    }

    /// Read an exact or latest custom role version.
    pub fn get_custom_role(
        &self,
        role_id: &str,
        version: Option<u32>,
    ) -> Result<CustomRoleVersion, StoreError> {
        validate_catalog_slug(role_id, "role_id")?;
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let row = if let Some(version) = version {
            connection.query_row(
                "SELECT definition_json,definition_sha256,created_by,created_at FROM custom_role_versions WHERE role_id=?1 AND version=?2",
                params![role_id, version], load_custom_role_row,
            ).optional()?
        } else {
            connection.query_row(
                "SELECT definition_json,definition_sha256,created_by,created_at FROM custom_role_versions WHERE role_id=?1 ORDER BY version DESC LIMIT 1",
                params![role_id], load_custom_role_row,
            ).optional()?
        }.ok_or_else(|| StoreError::NotFound(format!("custom role {role_id}")))?;
        Ok(row)
    }

    /// List latest custom roles or bounded immutable version history.
    pub fn list_custom_roles(
        &self,
        include_versions: bool,
        limit: u64,
    ) -> Result<Vec<CustomRoleVersion>, StoreError> {
        let limit = i64::try_from(limit.clamp(1, 200)).unwrap_or(200);
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let sql = if include_versions {
            "SELECT definition_json,definition_sha256,created_by,created_at FROM custom_role_versions ORDER BY role_id,version DESC LIMIT ?1"
        } else {
            "SELECT v.definition_json,v.definition_sha256,v.created_by,v.created_at FROM custom_role_versions v JOIN (SELECT role_id,MAX(version) version FROM custom_role_versions GROUP BY role_id) latest ON latest.role_id=v.role_id AND latest.version=v.version ORDER BY v.role_id LIMIT ?1"
        };
        let mut statement = connection.prepare(sql)?;
        let rows = statement.query_map(params![limit], load_custom_role_row)?;
        rows.map(|row| row.map_err(StoreError::from)).collect()
    }

    /// Create the first immutable custom workflow version after validating pinned role versions.
    pub fn create_custom_workflow(
        &self,
        definition: CustomWorkflowDefinition,
        created_by: &str,
    ) -> Result<CustomWorkflowVersion, StoreError> {
        self.create_custom_workflow_inner(definition, created_by, None)
    }

    /// Create a workflow after revalidating every exact skill pin of its referenced role versions.
    pub fn create_custom_workflow_with_trusted_skills(
        &self,
        definition: CustomWorkflowDefinition,
        created_by: &str,
        resolver: &dyn TrustedSkillResolver,
    ) -> Result<CustomWorkflowVersion, StoreError> {
        self.create_custom_workflow_inner(definition, created_by, Some(resolver))
    }

    fn create_custom_workflow_inner(
        &self,
        mut definition: CustomWorkflowDefinition,
        created_by: &str,
        skill_resolver: Option<&dyn TrustedSkillResolver>,
    ) -> Result<CustomWorkflowVersion, StoreError> {
        definition.version = 1;
        validate_catalog_slug(&definition.workflow_id, "workflow_id")?;
        let created_by = validate_catalog_actor(created_by)?;
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM custom_workflow_versions WHERE workflow_id=?1)",
            params![definition.workflow_id],
            |row| row.get(0),
        )?;
        if exists {
            return Err(StoreError::Invariant(format!(
                "custom workflow already exists: {}",
                definition.workflow_id
            )));
        }
        validate_custom_workflow_definition(&transaction, &definition, skill_resolver)?;
        let definition_json = serde_json::to_string(&definition)?;
        let definition_sha256 =
            content_hash(&definition).map_err(|error| StoreError::Invariant(error.to_string()))?;
        let created_at = now();
        transaction.execute("INSERT INTO custom_workflow_versions(workflow_id,version,definition_json,definition_sha256,created_by,created_at) VALUES(?1,1,?2,?3,?4,?5)", params![definition.workflow_id, definition_json, definition_sha256, created_by, created_at])?;
        insert_catalog_event(
            &transaction,
            "custom_workflow.created",
            &definition.workflow_id,
            1,
            created_by,
            &definition_sha256,
            &created_at,
        )?;
        transaction.commit()?;
        Ok(CustomWorkflowVersion {
            definition,
            definition_sha256,
            created_by: created_by.into(),
            created_at,
        })
    }

    /// Append a new custom workflow version; role references must resolve to exact immutable versions.
    pub fn update_custom_workflow(
        &self,
        workflow_id: &str,
        definition: CustomWorkflowDefinition,
        created_by: &str,
    ) -> Result<CustomWorkflowVersion, StoreError> {
        self.update_custom_workflow_inner(workflow_id, definition, created_by, None)
    }

    /// Append a workflow version after revalidating exact trusted skill pins of all referenced roles.
    pub fn update_custom_workflow_with_trusted_skills(
        &self,
        workflow_id: &str,
        definition: CustomWorkflowDefinition,
        created_by: &str,
        resolver: &dyn TrustedSkillResolver,
    ) -> Result<CustomWorkflowVersion, StoreError> {
        self.update_custom_workflow_inner(workflow_id, definition, created_by, Some(resolver))
    }

    fn update_custom_workflow_inner(
        &self,
        workflow_id: &str,
        mut definition: CustomWorkflowDefinition,
        created_by: &str,
        skill_resolver: Option<&dyn TrustedSkillResolver>,
    ) -> Result<CustomWorkflowVersion, StoreError> {
        validate_catalog_slug(workflow_id, "workflow_id")?;
        if definition.workflow_id != workflow_id {
            return Err(StoreError::Invariant(
                "custom workflow id cannot change during update".into(),
            ));
        }
        let created_by = validate_catalog_actor(created_by)?;
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let current = transaction.query_row("SELECT version,definition_json FROM custom_workflow_versions WHERE workflow_id=?1 ORDER BY version DESC LIMIT 1", params![workflow_id], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?))).optional()?.ok_or_else(|| StoreError::NotFound(format!("custom workflow {workflow_id}")))?;
        let current_version = u32::try_from(current.0)
            .map_err(|_| StoreError::Invariant("invalid custom workflow version".into()))?;
        let previous: CustomWorkflowDefinition = serde_json::from_str(&current.1)?;
        definition.version = current_version
            .checked_add(1)
            .ok_or_else(|| StoreError::Invariant("custom workflow version overflow".into()))?;
        validate_custom_workflow_definition(&transaction, &definition, skill_resolver)?;
        let mut comparable = definition.clone();
        comparable.version = current_version;
        if comparable == previous {
            return Err(StoreError::Invariant(
                "custom workflow update contains no changes".into(),
            ));
        }
        let definition_json = serde_json::to_string(&definition)?;
        let definition_sha256 =
            content_hash(&definition).map_err(|error| StoreError::Invariant(error.to_string()))?;
        let created_at = now();
        transaction.execute("INSERT INTO custom_workflow_versions(workflow_id,version,definition_json,definition_sha256,created_by,created_at) VALUES(?1,?2,?3,?4,?5,?6)", params![workflow_id, definition.version, definition_json, definition_sha256, created_by, created_at])?;
        insert_catalog_event(
            &transaction,
            "custom_workflow.versioned",
            workflow_id,
            definition.version,
            created_by,
            &definition_sha256,
            &created_at,
        )?;
        transaction.commit()?;
        Ok(CustomWorkflowVersion {
            definition,
            definition_sha256,
            created_by: created_by.into(),
            created_at,
        })
    }

    /// Read an exact or latest custom workflow version.
    pub fn get_custom_workflow(
        &self,
        workflow_id: &str,
        version: Option<u32>,
    ) -> Result<CustomWorkflowVersion, StoreError> {
        validate_catalog_slug(workflow_id, "workflow_id")?;
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let row = if let Some(version) = version {
            connection.query_row("SELECT definition_json,definition_sha256,created_by,created_at FROM custom_workflow_versions WHERE workflow_id=?1 AND version=?2", params![workflow_id,version], load_custom_workflow_row).optional()?
        } else {
            connection.query_row("SELECT definition_json,definition_sha256,created_by,created_at FROM custom_workflow_versions WHERE workflow_id=?1 ORDER BY version DESC LIMIT 1", params![workflow_id], load_custom_workflow_row).optional()?
        }.ok_or_else(|| StoreError::NotFound(format!("custom workflow {workflow_id}")))?;
        Ok(row)
    }

    /// List latest custom workflows or bounded immutable version history.
    pub fn list_custom_workflows(
        &self,
        include_versions: bool,
        limit: u64,
    ) -> Result<Vec<CustomWorkflowVersion>, StoreError> {
        let limit = i64::try_from(limit.clamp(1, 200)).unwrap_or(200);
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let sql = if include_versions {
            "SELECT definition_json,definition_sha256,created_by,created_at FROM custom_workflow_versions ORDER BY workflow_id,version DESC LIMIT ?1"
        } else {
            "SELECT v.definition_json,v.definition_sha256,v.created_by,v.created_at FROM custom_workflow_versions v JOIN (SELECT workflow_id,MAX(version) version FROM custom_workflow_versions GROUP BY workflow_id) latest ON latest.workflow_id=v.workflow_id AND latest.version=v.version ORDER BY v.workflow_id LIMIT ?1"
        };
        let mut statement = connection.prepare(sql)?;
        let rows = statement.query_map(params![limit], load_custom_workflow_row)?;
        rows.map(|row| row.map_err(StoreError::from)).collect()
    }

    /// Compile and persist an immutable plan from exact stored workflow and role versions.
    pub fn compile_custom_workflow(
        &self,
        workflow_id: &str,
        version: Option<u32>,
        created_by: &str,
    ) -> Result<CustomWorkflowPlanRecord, StoreError> {
        self.compile_custom_workflow_inner(workflow_id, version, created_by, None)
    }

    /// Compile after revalidating every exact pinned skill against the current host trust catalog.
    pub fn compile_custom_workflow_with_trusted_skills(
        &self,
        workflow_id: &str,
        version: Option<u32>,
        created_by: &str,
        resolver: &dyn TrustedSkillResolver,
    ) -> Result<CustomWorkflowPlanRecord, StoreError> {
        self.compile_custom_workflow_inner(workflow_id, version, created_by, Some(resolver))
    }

    fn compile_custom_workflow_inner(
        &self,
        workflow_id: &str,
        version: Option<u32>,
        created_by: &str,
        skill_resolver: Option<&dyn TrustedSkillResolver>,
    ) -> Result<CustomWorkflowPlanRecord, StoreError> {
        validate_catalog_actor(created_by)?;
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let row = if let Some(version) = version {
            transaction.query_row("SELECT definition_json FROM custom_workflow_versions WHERE workflow_id=?1 AND version=?2", params![workflow_id,version], |row| row.get::<_,String>(0)).optional()?
        } else {
            transaction.query_row("SELECT definition_json FROM custom_workflow_versions WHERE workflow_id=?1 ORDER BY version DESC LIMIT 1", params![workflow_id], |row| row.get::<_,String>(0)).optional()?
        }.ok_or_else(|| StoreError::NotFound(format!("custom workflow {workflow_id}")))?;
        let definition: CustomWorkflowDefinition = serde_json::from_str(&row)?;
        let plan = compile_custom_workflow_from_catalog(&transaction, &definition, skill_resolver)?;
        plan.verify_digest()
            .map_err(|error| StoreError::Invariant(error.to_string()))?;
        let plan_id = format!("cwp-{}", Uuid::new_v4());
        let plan_sha256 = plan.plan_hash().to_owned();
        let plan_json = serde_json::to_string(&plan)?;
        let created_at = now();
        transaction.execute("INSERT INTO custom_workflow_plans(plan_id,workflow_id,workflow_version,plan_sha256,plan_json,created_by,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![plan_id, definition.workflow_id, definition.version, plan_sha256, plan_json, created_by, created_at])?;
        insert_catalog_event(
            &transaction,
            "custom_workflow.plan_compiled",
            &definition.workflow_id,
            definition.version,
            created_by,
            &plan_sha256,
            &created_at,
        )?;
        transaction.commit()?;
        Ok(CustomWorkflowPlanRecord {
            plan_id,
            workflow_id: definition.workflow_id,
            workflow_version: definition.version,
            plan,
            plan_sha256,
            created_by: created_by.into(),
            created_at,
        })
    }

    /// Read a persisted immutable custom workflow plan and verify its content digest.
    pub fn get_custom_workflow_plan(
        &self,
        plan_id: &str,
    ) -> Result<CustomWorkflowPlanRecord, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let row = connection.query_row("SELECT workflow_id,workflow_version,plan_sha256,plan_json,created_by,created_at FROM custom_workflow_plans WHERE plan_id=?1", params![plan_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?))).optional()?.ok_or_else(|| StoreError::NotFound(format!("custom workflow plan {plan_id}")))?;
        let plan: CompiledWorkflowPlan = serde_json::from_str(&row.3)?;
        plan.verify_digest()
            .map_err(|error| StoreError::Invariant(error.to_string()))?;
        if plan.plan_hash() != row.2 {
            return Err(StoreError::Invariant(
                "persisted custom workflow plan digest mismatch".into(),
            ));
        }
        Ok(CustomWorkflowPlanRecord {
            plan_id: plan_id.into(),
            workflow_id: row.0,
            workflow_version: u32::try_from(row.1)
                .map_err(|_| StoreError::Invariant("invalid plan workflow version".into()))?,
            plan,
            plan_sha256: row.2,
            created_by: row.4,
            created_at: row.5,
        })
    }

    /// Inspect durable ownership and historical evidence in one read snapshot.
    /// This does not inspect host runtime sessions or infer worker death.
    pub fn inspect_task_attempt(
        &self,
        workflow_id: &str,
        task_id: &str,
    ) -> Result<TaskAttemptSnapshot, StoreError> {
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
        let row = transaction.query_row(
            "SELECT t.state,t.attempts,t.owner_epoch,t.lease_id,t.lease_owner,t.lease_expires_at,w.plan_sha256,t.result_json FROM tasks t JOIN workflows w ON w.workflow_id=t.workflow_id WHERE t.workflow_id=?1 AND t.task_id=?2",
            params![workflow_id, task_id],
            |row| Ok((row.get::<_, String>(0)?,row.get::<_, i64>(1)?,row.get::<_, i64>(2)?,row.get::<_, Option<String>>(3)?,row.get::<_, Option<String>>(4)?,row.get::<_, Option<String>>(5)?,row.get::<_, Option<String>>(6)?,row.get::<_, Option<String>>(7)?)),
        ).optional()?.ok_or_else(|| StoreError::NotFound(format!("task {task_id}")))?;
        let state = parse_task_state(&row.0)?;
        let attempt = u64::try_from(row.1)
            .map_err(|_| StoreError::Invariant("negative task attempt counter".into()))?;
        let provider_intent = if attempt == 0 {
            None
        } else {
            ProviderLedger::load_by_attempt(&transaction, workflow_id, task_id, attempt)
                .map_err(provider_store_error)?
        };
        let provider_observations = if let Some(intent) = &provider_intent {
            ProviderLedger::list_observations(&transaction, &intent.intent_id)
                .map_err(provider_store_error)?
        } else {
            Vec::new()
        };
        let mut attempt_statement = transaction.prepare(
            "SELECT a.attempt,a.owner_epoch,a.lease_id,a.worker_id,a.lease_expires_at,a.claimed_at,r.result_sha256,r.outcome,r.recorded_at FROM task_attempts a LEFT JOIN task_attempt_results r ON r.workflow_id=a.workflow_id AND r.task_id=a.task_id AND r.attempt=a.attempt WHERE a.workflow_id=?1 AND a.task_id=?2 ORDER BY a.attempt",
        )?;
        let attempt_ledger = attempt_statement
            .query_map(params![workflow_id, task_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                ))
            })?
            .map(|row| {
                let row = row?;
                Ok::<_, StoreError>(TaskAttemptLedgerEntry {
                    attempt: u64::try_from(row.0).map_err(|_| {
                        StoreError::Invariant("negative attempt ledger index".into())
                    })?,
                    owner_epoch: u64::try_from(row.1).map_err(|_| {
                        StoreError::Invariant("negative attempt owner epoch".into())
                    })?,
                    lease_id: row.2,
                    worker_id: row.3,
                    lease_expires_at: row.4,
                    claimed_at: row.5,
                    session_binding: None,
                    result_sha256: row.6,
                    outcome: row.7,
                    result_recorded_at: row.8,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        drop(attempt_statement);
        if attempt_ledger
            .last()
            .is_some_and(|entry| entry.attempt > attempt)
        {
            return Err(StoreError::Invariant(
                "attempt ledger is ahead of task projection".into(),
            ));
        }
        let provider_history = ProviderLedger::list_by_workflow(&transaction, workflow_id)
            .map_err(provider_store_error)?
            .into_iter()
            .filter(|intent| intent.request.task_id == task_id)
            .map(|intent| {
                let observations =
                    ProviderLedger::list_observations(&transaction, &intent.intent_id)
                        .map_err(provider_store_error)?;
                let lineage_matches = attempt_ledger.iter().any(|entry| {
                    entry.attempt == intent.request.attempt
                        && entry.lease_id == intent.request.lease_id
                        && entry.worker_id == intent.request.worker_id
                });
                Ok::<_, StoreError>(ProviderAttemptHistory {
                    attempt: intent.request.attempt,
                    intent,
                    observations,
                    lineage_matches,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut session_statement = transaction.prepare(
            "SELECT session_id,workflow_id,task_id,role,runtime_session_key,parent_session_key,state,current_turn_id,attempt,last_activity_at FROM agent_sessions WHERE workflow_id=?1 AND task_id=?2 ORDER BY created_at,session_id",
        )?;
        let sessions = session_statement
            .query_map(params![workflow_id, task_id], load_agent_session_row)?
            .collect::<Result<Vec<_>, _>>()?;
        drop(session_statement);
        let mut session_history = Vec::with_capacity(sessions.len());
        for session in sessions {
            let access = load_session_access(&transaction, &session.session_id)?;
            let mut message_statement = transaction.prepare(
                "SELECT message_id FROM session_messages WHERE session_id=?1 ORDER BY created_at,message_id",
            )?;
            let message_ids = message_statement
                .query_map(params![session.session_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            drop(message_statement);
            let messages = message_ids
                .iter()
                .map(|message_id| load_session_message(&transaction, message_id))
                .collect::<Result<Vec<_>, _>>()?;
            session_history.push(AgentSessionHistory {
                session,
                access,
                messages,
            });
        }
        let mut statement = transaction.prepare(
            "SELECT event_seq,event_id,task_id,event_type,payload_json,created_at,event_prev_hash,event_hash FROM events WHERE workflow_id=?1 AND (task_id=?2 OR task_id IS NULL) ORDER BY event_seq DESC LIMIT 501",
        )?;
        let rows = statement.query_map(params![workflow_id, task_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
            ))
        })?;
        let mut history_events = rows
            .map(|row| {
                let (
                    sequence,
                    event_id,
                    event_task_id,
                    event_type,
                    payload,
                    created_at,
                    previous_sha256,
                    sha256,
                ) = row?;
                Ok::<_, StoreError>(WorkflowEvent {
                    sequence: u64::try_from(sequence).map_err(|_| {
                        StoreError::Invariant("negative workflow event sequence".into())
                    })?,
                    event_id,
                    task_id: event_task_id,
                    event_type,
                    payload: serde_json::from_str(&payload)?,
                    created_at,
                    previous_sha256,
                    sha256,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let history_complete = history_events.len() <= 500;
        history_events.truncate(500);
        history_events.reverse();
        let mut session_bindings = BTreeMap::new();
        if history_complete {
            for event in history_events
                .iter()
                .filter(|event| event.event_type == "task.runtime_session_bound")
            {
                let binding: RuntimeSessionBinding = serde_json::from_value(event.payload.clone())?;
                if binding.workflow_id != workflow_id
                    || binding.task_id != task_id
                    || event.task_id.as_deref() != Some(task_id)
                    || binding.owner_epoch == 0
                {
                    return Err(StoreError::Invariant(
                        "runtime session journal binding has invalid task/epoch lineage".into(),
                    ));
                }
                let attempt_entry = attempt_ledger
                    .iter()
                    .find(|entry| entry.attempt == binding.attempt);
                if attempt_entry.is_none_or(|entry| {
                    entry.owner_epoch != binding.owner_epoch
                        || entry.lease_id != binding.lease_id
                        || entry.worker_id != binding.worker_id
                }) {
                    return Err(StoreError::Invariant(
                        "runtime session binding does not join to an exact historical lease".into(),
                    ));
                }
                let registered_session = session_history.iter().find(|history| {
                    history.session.runtime_session_key == binding.session_id
                        && history.session.workflow_id == binding.workflow_id
                        && history.session.task_id == binding.task_id
                        && history.session.attempt == binding.attempt
                });
                if registered_session.is_none() {
                    return Err(StoreError::Invariant(
                        "runtime binding has no exact durable agent-session registry row".into(),
                    ));
                }
                if session_bindings.insert(binding.attempt, binding).is_some() {
                    return Err(StoreError::Invariant(
                        "multiple runtime sessions are bound to one task attempt".into(),
                    ));
                }
            }
        }
        let session_binding = session_bindings.get(&attempt).cloned();
        let attempt_ledger = attempt_ledger
            .into_iter()
            .map(|mut entry| {
                entry.session_binding = session_bindings.remove(&entry.attempt);
                entry
            })
            .collect();
        let result = row
            .7
            .map(|value| serde_json::from_str(&value))
            .transpose()?;
        let event_head_sha256: String = transaction.query_row(
            "SELECT event_hash FROM events WHERE workflow_id=?1 ORDER BY event_seq DESC LIMIT 1",
            params![workflow_id],
            |row| row.get(0),
        )?;
        transaction.commit()?;
        Ok(TaskAttemptSnapshot {
            workflow_id: workflow_id.into(),
            task_id: task_id.into(),
            state,
            attempt,
            owner_epoch: u64::try_from(row.2)
                .map_err(|_| StoreError::Invariant("negative lease owner epoch".into()))?,
            plan_sha256: row.6,
            lease_id: row.3,
            lease_owner: row.4,
            lease_expires_at: row.5,
            provider_intent,
            result,
            history_events,
            event_head_sha256,
            history_complete,
            provider_observations,
            session_binding,
            attempt_ledger,
            provider_history,
            session_history,
        })
    }

    /// Capture workflow, ready-task candidates, attempt ledgers, bounded events
    /// and the complete event-chain verification in one read transaction.
    /// This endpoint is observational only: it does not claim, renew, schedule,
    /// reconcile, or otherwise mutate workflow state.
    pub fn inspect_workflow_read_snapshot(
        &self,
        workflow_id: &str,
        event_limit: usize,
    ) -> Result<WorkflowReadSnapshot, StoreError> {
        if !(1..=500).contains(&event_limit) {
            return Err(StoreError::Invariant(
                "workflow snapshot event limit must be within 1..=500".into(),
            ));
        }
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;

        // The first read pins the SQLite snapshot. All following projections,
        // including hash-chain verification, observe this same database view.
        let workflow = load_workflow_from(&transaction, workflow_id)?;
        let event_chain = verify_event_chain_connection(&transaction, workflow_id)?;
        let total_event_count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM events WHERE workflow_id=?1",
            params![workflow_id],
            |row| row.get(0),
        )?;
        let total_event_count = u64::try_from(total_event_count)
            .map_err(|_| StoreError::Invariant("negative workflow event count".into()))?;

        let mut task_attempts = Vec::with_capacity(workflow.tasks.len());
        for task in &workflow.tasks {
            let owner_epoch: i64 = transaction.query_row(
                "SELECT owner_epoch FROM tasks WHERE workflow_id=?1 AND task_id=?2",
                params![workflow_id, task.definition.task_id],
                |row| row.get(0),
            )?;
            let owner_epoch = u64::try_from(owner_epoch)
                .map_err(|_| StoreError::Invariant("negative lease owner epoch".into()))?;
            let mut statement = transaction.prepare(
                "SELECT a.attempt,a.owner_epoch,a.lease_id,a.worker_id,a.lease_expires_at,
                        a.claimed_at,r.result_sha256,r.outcome,r.recorded_at
                 FROM task_attempts a
                 LEFT JOIN task_attempt_results r
                   ON r.workflow_id=a.workflow_id AND r.task_id=a.task_id AND r.attempt=a.attempt
                 WHERE a.workflow_id=?1 AND a.task_id=?2
                 ORDER BY a.attempt DESC LIMIT 501",
            )?;
            let rows =
                statement.query_map(params![workflow_id, task.definition.task_id], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                    ))
                })?;
            let mut attempt_ledger = rows
                .map(|row| {
                    let row = row?;
                    Ok::<_, StoreError>(TaskAttemptLedgerEntry {
                        attempt: u64::try_from(row.0).map_err(|_| {
                            StoreError::Invariant("negative attempt ledger index".into())
                        })?,
                        owner_epoch: u64::try_from(row.1).map_err(|_| {
                            StoreError::Invariant("negative attempt owner epoch".into())
                        })?,
                        lease_id: row.2,
                        worker_id: row.3,
                        lease_expires_at: row.4,
                        claimed_at: row.5,
                        session_binding: None,
                        result_sha256: row.6,
                        outcome: row.7,
                        result_recorded_at: row.8,
                    })
                })
                .collect::<Result<Vec<_>, StoreError>>()?;
            drop(statement);
            let attempt_history_complete = attempt_ledger.len() <= 500;
            attempt_ledger.truncate(500);
            attempt_ledger.reverse();
            if attempt_ledger.last().map(|entry| entry.attempt) != Some(task.attempts)
                && task.attempts != 0
            {
                return Err(StoreError::Invariant(
                    "latest attempt ledger entry does not match the task projection".into(),
                ));
            }
            if task.attempts == 0 && !attempt_ledger.is_empty() {
                return Err(StoreError::Invariant(
                    "attempt ledger exists for a task that has never been claimed".into(),
                ));
            }
            if attempt_history_complete
                && attempt_ledger
                    .iter()
                    .enumerate()
                    .any(|(index, entry)| entry.attempt != index as u64 + 1)
            {
                return Err(StoreError::Invariant(
                    "complete attempt ledger is not a contiguous sequence from attempt one".into(),
                ));
            }
            if attempt_ledger
                .windows(2)
                .any(|pair| pair[1].attempt != pair[0].attempt.saturating_add(1))
            {
                return Err(StoreError::Invariant(
                    "bounded attempt ledger contains a gap or duplicate attempt".into(),
                ));
            }
            if attempt_ledger
                .last()
                .is_some_and(|entry| entry.owner_epoch != owner_epoch)
            {
                return Err(StoreError::Invariant(
                    "latest attempt ledger fencing epoch does not match the task projection".into(),
                ));
            }
            if task.state == TaskState::Running {
                let latest = attempt_ledger.last().ok_or_else(|| {
                    StoreError::Invariant(
                        "running task has no immutable attempt ledger entry".into(),
                    )
                })?;
                if task.attempts == 0
                    || task.lease_id.as_deref() != Some(latest.lease_id.as_str())
                    || task.lease_owner.as_deref() != Some(latest.worker_id.as_str())
                    || task.lease_expires_at.as_deref() != Some(latest.lease_expires_at.as_str())
                {
                    return Err(StoreError::Invariant(
                        "active task lease tuple does not match its latest immutable attempt"
                            .into(),
                    ));
                }
            }
            if let Some(result) = &task.result {
                let latest = attempt_ledger.last().ok_or_else(|| {
                    StoreError::Invariant(
                        "persisted task result has no immutable attempt ledger entry".into(),
                    )
                })?;
                let expected_outcome = match result.outcome {
                    TaskOutcome::Succeeded => "SUCCEEDED",
                    TaskOutcome::Failed => "FAILED",
                    TaskOutcome::Unknown => "UNKNOWN",
                };
                if result.attempt != task.attempts
                    || latest.outcome.as_deref() != Some(expected_outcome)
                    || latest.result_recorded_at.as_deref() != Some(result.recorded_at.as_str())
                {
                    return Err(StoreError::Invariant(
                        "current task result does not match the latest immutable attempt result"
                            .into(),
                    ));
                }
            }

            let provider_intent = if task.attempts == 0 {
                None
            } else {
                ProviderLedger::load_by_attempt(
                    &transaction,
                    workflow_id,
                    &task.definition.task_id,
                    task.attempts,
                )
                .map_err(provider_store_error)?
            };
            let provider_observations = if let Some(intent) = &provider_intent {
                ProviderLedger::list_observations(&transaction, &intent.intent_id)
                    .map_err(provider_store_error)?
            } else {
                Vec::new()
            };
            let provider_history = ProviderLedger::list_by_workflow(&transaction, workflow_id)
                .map_err(provider_store_error)?
                .into_iter()
                .filter(|intent| intent.request.task_id == task.definition.task_id)
                .map(|intent| {
                    let observations =
                        ProviderLedger::list_observations(&transaction, &intent.intent_id)
                            .map_err(provider_store_error)?;
                    // Verify lineage against the durable attempt table itself,
                    // not only the bounded 500-entry projection. An old provider
                    // intent must not appear mismatched merely because its lease
                    // falls outside the returned history window.
                    let lineage_matches: bool = transaction.query_row(
                        "SELECT EXISTS(
                           SELECT 1 FROM task_attempts
                           WHERE workflow_id=?1 AND task_id=?2 AND attempt=?3
                             AND lease_id=?4 AND worker_id=?5
                         )",
                        params![
                            workflow_id,
                            task.definition.task_id,
                            intent.request.attempt as i64,
                            intent.request.lease_id,
                            intent.request.worker_id
                        ],
                        |row| row.get(0),
                    )?;
                    Ok::<_, StoreError>(ProviderAttemptHistory {
                        attempt: intent.request.attempt,
                        intent,
                        observations,
                        lineage_matches,
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;

            let mut session_statement = transaction.prepare(
                "SELECT session_id,workflow_id,task_id,role,runtime_session_key,parent_session_key,state,current_turn_id,attempt,last_activity_at
                 FROM agent_sessions WHERE workflow_id=?1 AND task_id=?2 ORDER BY created_at,session_id",
            )?;
            let sessions = session_statement
                .query_map(
                    params![workflow_id, task.definition.task_id],
                    load_agent_session_row,
                )?
                .collect::<Result<Vec<_>, _>>()?;
            drop(session_statement);
            let mut session_history = Vec::with_capacity(sessions.len());
            for session in sessions {
                let access = load_session_access(&transaction, &session.session_id)?;
                let mut message_statement = transaction.prepare(
                    "SELECT message_id FROM session_messages WHERE session_id=?1 ORDER BY created_at,message_id",
                )?;
                let message_ids = message_statement
                    .query_map(params![session.session_id], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                drop(message_statement);
                let messages = message_ids
                    .iter()
                    .map(|message_id| load_session_message(&transaction, message_id))
                    .collect::<Result<Vec<_>, _>>()?;
                session_history.push(AgentSessionHistory {
                    session,
                    access,
                    messages,
                });
            }

            // Resolve every session binding from the append-only journal and
            // join it to both the exact historical lease and session registry.
            for entry in &mut attempt_ledger {
                let key = format!(
                    "runtime-session:{}:{}",
                    task.definition.task_id, entry.attempt
                );
                let payload: Option<String> = transaction
                    .query_row(
                        "SELECT payload_json FROM events WHERE workflow_id=?1 AND idempotency_key=?2 AND event_type='task.runtime_session_bound'",
                        params![workflow_id, key],
                        |row| row.get(0),
                    )
                    .optional()?;
                let Some(payload) = payload else { continue };
                let binding: RuntimeSessionBinding = serde_json::from_str(&payload)?;
                if binding.workflow_id != workflow_id
                    || binding.task_id != task.definition.task_id
                    || binding.attempt != entry.attempt
                    || binding.owner_epoch != entry.owner_epoch
                    || binding.lease_id != entry.lease_id
                    || binding.worker_id != entry.worker_id
                    || binding.owner_epoch == 0
                    || !session_history.iter().any(|history| {
                        history.session.runtime_session_key == binding.session_id
                            && history.session.workflow_id == binding.workflow_id
                            && history.session.task_id == binding.task_id
                            && history.session.attempt == binding.attempt
                    })
                {
                    return Err(StoreError::Invariant(
                        "runtime session binding does not join to the exact task attempt and registered session".into(),
                    ));
                }
                entry.session_binding = Some(binding);
            }
            let session_binding = attempt_ledger
                .iter()
                .find(|entry| entry.attempt == task.attempts)
                .and_then(|entry| entry.session_binding.clone());
            task_attempts.push(TaskAttemptReadView {
                task_id: task.definition.task_id.clone(),
                state: task.state,
                attempt: task.attempts,
                owner_epoch,
                plan_sha256: workflow.plan_hash.clone(),
                lease_id: task.lease_id.clone(),
                lease_owner: task.lease_owner.clone(),
                lease_expires_at: task.lease_expires_at.clone(),
                result: task.result.clone(),
                provider_intent,
                provider_observations,
                provider_history,
                session_binding,
                attempt_ledger,
                attempt_history_complete,
                session_history,
            });
        }

        let mut ready_statement = transaction.prepare(
            "SELECT t.task_id,t.ordinal,t.definition_json,w.plan_sha256,w.state
             FROM tasks t JOIN workflows w ON w.workflow_id=t.workflow_id
             WHERE t.workflow_id=?1 AND t.state='PENDING'
               AND w.state IN ('APPROVED','EXECUTING')
               AND w.cancellation_requested_at IS NULL AND w.plan_sha256 IS NOT NULL
               AND NOT EXISTS(
                 SELECT 1 FROM json_each(t.definition_json,'$.depends_on') dependency
                 LEFT JOIN tasks predecessor
                   ON predecessor.workflow_id=t.workflow_id AND predecessor.task_id=dependency.value
                 WHERE predecessor.state IS NULL OR predecessor.state!='SUCCEEDED'
               )
             ORDER BY t.ordinal,t.task_id",
        )?;
        let ready_rows = ready_statement.query_map(params![workflow_id], |row| {
            let ordinal: i64 = row.get(1)?;
            let ordinal = u64::try_from(ordinal).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    1,
                    rusqlite::types::Type::Integer,
                    Box::new(error),
                )
            })?;
            let definition_json: String = row.get(2)?;
            let definition = serde_json::from_str(&definition_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    2,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            let state: String = row.get(4)?;
            let workflow_state = parse_workflow_state(&state).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    4,
                    rusqlite::types::Type::Text,
                    Box::new(std::io::Error::other(error.to_string())),
                )
            })?;
            Ok(ReadyTask {
                workflow_id: workflow_id.to_owned(),
                task_id: row.get(0)?,
                ordinal,
                definition,
                plan_sha256: row.get(3)?,
                workflow_state,
            })
        })?;
        let ready_tasks = ready_rows.collect::<Result<Vec<_>, _>>()?;
        drop(ready_statement);

        let event_limit_i64 = i64::try_from(event_limit)
            .map_err(|_| StoreError::Invariant("workflow snapshot event limit overflow".into()))?;
        let mut event_statement = transaction.prepare(
            "SELECT event_seq,event_id,task_id,event_type,payload_json,created_at,event_prev_hash,event_hash
             FROM events WHERE workflow_id=?1 ORDER BY event_seq DESC LIMIT ?2",
        )?;
        let event_rows =
            event_statement.query_map(params![workflow_id, event_limit_i64], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })?;
        let mut events = event_rows
            .map(|row| {
                let (
                    sequence,
                    event_id,
                    task_id,
                    event_type,
                    payload_json,
                    created_at,
                    previous_sha256,
                    sha256,
                ) = row?;
                Ok::<_, StoreError>(WorkflowEvent {
                    sequence: u64::try_from(sequence).map_err(|_| {
                        StoreError::Invariant("negative workflow event sequence".into())
                    })?,
                    event_id,
                    task_id,
                    event_type,
                    payload: serde_json::from_str(&payload_json)?,
                    created_at,
                    previous_sha256,
                    sha256,
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        drop(event_statement);
        events.reverse();
        let events_truncated = total_event_count > event_limit as u64;

        transaction.commit()?;
        Ok(WorkflowReadSnapshot {
            schema_version: 1,
            workflow,
            task_attempts,
            ready_tasks,
            events,
            total_event_count,
            events_truncated,
            event_chain,
        })
    }

    /// Atomically compare current task/provider/session/journal lineage, invoke
    /// the mandatory host evidence verifier and append an immutable decision
    /// observation. This records no lifecycle disposition and never replays.
    pub fn record_recovery_decision(
        &self,
        workflow_id: &str,
        task_id: &str,
        request: RecoveryDecisionRecordRequest,
        verifier: &dyn RecoveryDecisionVerifier,
    ) -> Result<RecoveryDecisionRecord, StoreError> {
        let valid_digest = |value: &str| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        };
        if request.attempt == 0
            || request.owner_epoch == 0
            || request.runtime_id.trim().is_empty()
            || request.attempt > i64::MAX as u64
            || request.owner_epoch > i64::MAX as u64
            || request.runtime_generation == 0
            || request.runtime_captured_at_ms <= 0
            || request.observed_at_ms < request.runtime_captured_at_ms
            || request.decision.trim().is_empty()
            || !valid_digest(&request.plan_sha256)
            || !valid_digest(&request.event_head_sha256)
            || !valid_digest(&request.evidence_sha256)
        {
            return Err(StoreError::Invariant(
                "recovery decision evidence contract is invalid".into(),
            ));
        }
        let timestamp = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let task = transaction.query_row(
            "SELECT t.state,t.attempts,t.owner_epoch,t.lease_id,w.plan_sha256 FROM tasks t JOIN workflows w ON w.workflow_id=t.workflow_id WHERE t.workflow_id=?1 AND t.task_id=?2",
            params![workflow_id,task_id],
            |row| Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,i64>(2)?,row.get::<_,Option<String>>(3)?,row.get::<_,Option<String>>(4)?)),
        ).optional()?.ok_or_else(||StoreError::NotFound(format!("task {task_id}")))?;
        let chain = verify_event_chain_connection(&transaction, workflow_id)?;
        if !chain.valid {
            return Err(StoreError::Invariant(
                "recovery decision refuses a tampered workflow event chain".into(),
            ));
        }
        let event_head = chain.head_hash.ok_or_else(|| {
            StoreError::Invariant("recovery decision requires a non-empty workflow journal".into())
        })?;
        let idempotency_key = format!(
            "recovery-decision:{task_id}:{}:{}:{}",
            request.attempt, request.owner_epoch, request.evidence_sha256
        );
        let existing: Option<(String,String,String,String)> = transaction.query_row(
            "SELECT event_id,payload_json,event_prev_hash,event_hash FROM events WHERE workflow_id=?1 AND idempotency_key=?2",
            params![workflow_id,idempotency_key],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        ).optional()?;
        let provider =
            ProviderLedger::load_by_attempt(&transaction, workflow_id, task_id, request.attempt)
                .map_err(provider_store_error)?;
        let provider_id = provider.as_ref().map(|intent| intent.intent_id.clone());
        let provider_state = provider
            .as_ref()
            .map(|intent| provider_dispatch_state_db(intent.state).to_owned());
        let binding_payload: Option<String> = transaction.query_row(
            "SELECT payload_json FROM events WHERE workflow_id=?1 AND idempotency_key=?2 AND event_type='task.runtime_session_bound'",
            params![workflow_id,format!("runtime-session:{task_id}:{}",request.attempt)],|row|row.get(0),
        ).optional()?;
        let session_id = binding_payload
            .map(|payload| {
                serde_json::from_str::<RuntimeSessionBinding>(&payload)
                    .map(|binding| binding.session_id)
            })
            .transpose()?;
        if task.0 != request.expected_task_state
            || task.1 != request.attempt as i64
            || task.2 != request.owner_epoch as i64
            || task.4.as_deref() != Some(request.plan_sha256.as_str())
            || !(event_head == request.event_head_sha256
                || existing.as_ref().is_some_and(|entry| {
                    entry.2 == request.event_head_sha256 && entry.3 == event_head
                }))
            || task.3 != request.lease_id
            || provider_id != request.provider_intent_id
            || provider_state != request.provider_state
            || session_id != request.session_id
        {
            return Err(StoreError::LeaseFenced);
        }
        verifier.verify(&transaction, &request)?;
        let payload = serde_json::json!({"workflow_id":workflow_id,"task_id":task_id,"request":request,"recorded_at":timestamp});
        let (event_id, recorded_at) = if let Some((event_id, existing_payload, _, _)) = existing {
            let existing_value: serde_json::Value = serde_json::from_str(&existing_payload)?;
            if existing_value.get("request") != Some(&serde_json::to_value(&request)?)
                || existing_value
                    .get("workflow_id")
                    .and_then(serde_json::Value::as_str)
                    != Some(workflow_id)
                || existing_value
                    .get("task_id")
                    .and_then(serde_json::Value::as_str)
                    != Some(task_id)
            {
                return Err(StoreError::Invariant(
                    "recovery decision idempotency key conflicts with existing evidence".into(),
                ));
            }
            let recorded = existing_value
                .get("recorded_at")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    StoreError::Invariant("recovery decision event timestamp is missing".into())
                })?
                .to_owned();
            (event_id, recorded)
        } else {
            insert_event(
                &transaction,
                workflow_id,
                Some(task_id),
                "recovery.decision_observed",
                &payload,
                &idempotency_key,
                &timestamp,
            )?;
            let event_id = transaction.query_row(
                "SELECT event_id FROM events WHERE workflow_id=?1 AND idempotency_key=?2",
                params![workflow_id, idempotency_key],
                |row| row.get(0),
            )?;
            (event_id, timestamp)
        };
        transaction.commit()?;
        Ok(RecoveryDecisionRecord {
            workflow_id: workflow_id.into(),
            task_id: task_id.into(),
            event_id,
            request,
            recorded_at,
        })
    }

    /// Append an immutable runtime-session binding after host-side verification.
    /// The transaction rechecks the exact active lease to prevent stale binders.
    pub fn record_runtime_session_binding(
        &self,
        workflow_id: &str,
        task_id: &str,
        request: RuntimeSessionBindingRequest,
    ) -> Result<RuntimeSessionBinding, StoreError> {
        if request.runtime_id.trim().is_empty()
            || request.session_id.trim().is_empty()
            || request.worker_id.trim().is_empty()
            || request.lease_id.trim().is_empty()
            || request.attempt == 0
            || request.owner_epoch == 0
        {
            return Err(StoreError::Invariant(
                "runtime session binding identity is invalid".into(),
            ));
        }
        let timestamp = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let task = transaction.query_row(
            "SELECT state,attempts,owner_epoch,lease_id,lease_owner FROM tasks WHERE workflow_id=?1 AND task_id=?2",
            params![workflow_id, task_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, Option<String>>(4)?)),
        ).optional()?.ok_or_else(|| StoreError::NotFound(format!("task {task_id}")))?;
        if task.0 != "RUNNING"
            || task.1 != request.attempt as i64
            || task.2 != request.owner_epoch as i64
            || task.3.as_deref() != Some(request.lease_id.as_str())
            || task.4.as_deref() != Some(request.worker_id.as_str())
        {
            return Err(StoreError::LeaseFenced);
        }
        let registered_session: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_sessions WHERE workflow_id=?1 AND task_id=?2 AND runtime_session_key=?3 AND attempt=?4 AND state IN ('CREATED','ACTIVE','PAUSED','STALE'))",
            params![workflow_id,task_id,request.session_id,request.attempt as i64],
            |row| row.get(0),
        )?;
        if !registered_session {
            return Err(StoreError::LeaseFenced);
        }
        let idempotency_key = format!("runtime-session:{task_id}:{}", request.attempt);
        let existing: Option<String> = transaction
            .query_row(
                "SELECT payload_json FROM events WHERE workflow_id=?1 AND idempotency_key=?2",
                params![workflow_id, idempotency_key],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(payload) = existing {
            let binding: RuntimeSessionBinding = serde_json::from_str(&payload)?;
            if binding.task_id == task_id
                && binding.attempt == request.attempt
                && binding.owner_epoch == request.owner_epoch
                && binding.lease_id == request.lease_id
                && binding.worker_id == request.worker_id
                && binding.runtime_id == request.runtime_id
                && binding.session_id == request.session_id
            {
                transaction.commit()?;
                return Ok(binding);
            }
            return Err(StoreError::LeaseFenced);
        }
        let session_already_bound: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM events WHERE workflow_id=?1 AND event_type='task.runtime_session_bound' AND json_extract(payload_json,'$.session_id')=?2)",
            params![workflow_id, request.session_id],
            |row| row.get(0),
        )?;
        if session_already_bound {
            return Err(StoreError::Invariant(
                "runtime session identity is already bound to another attempt".into(),
            ));
        }
        let binding = RuntimeSessionBinding {
            workflow_id: workflow_id.into(),
            task_id: task_id.into(),
            attempt: request.attempt,
            owner_epoch: request.owner_epoch,
            lease_id: request.lease_id,
            worker_id: request.worker_id,
            runtime_id: request.runtime_id,
            session_id: request.session_id,
            bound_at: timestamp.clone(),
        };
        insert_event(
            &transaction,
            workflow_id,
            Some(task_id),
            "task.runtime_session_bound",
            &binding,
            &idempotency_key,
            &timestamp,
        )?;
        transaction.commit()?;
        Ok(binding)
    }

    /// Create a durable session row and journal event in one transaction.
    /// The runtime key is not treated as evidence that the runtime is alive.
    pub fn create_agent_session(
        &self,
        workflow_id: &str,
        task_id: &str,
        request: AgentSessionCreateRequest,
    ) -> Result<AgentSessionRecord, StoreError> {
        if request.runtime_session_key.trim().is_empty()
            || request.role.trim().is_empty()
            || request.attempt == 0
            || request.attempt > i64::MAX as u64
            || request
                .parent_session_key
                .as_ref()
                .is_some_and(|value| value.trim().is_empty())
        {
            return Err(StoreError::Invariant(
                "invalid agent session identity".into(),
            ));
        }
        let timestamp = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let task_role: String = transaction.query_row(
            "SELECT json_extract(definition_json,'$.role') FROM tasks WHERE workflow_id=?1 AND task_id=?2",
            params![workflow_id, task_id],
            |row| row.get::<_, Option<String>>(0).map(|value| value.unwrap_or_default()),
        ).optional()?.ok_or_else(|| StoreError::NotFound(format!("task {task_id}")))?;
        let role = if request.role.trim().is_empty() {
            task_role
        } else {
            request.role.trim().to_lowercase()
        };
        let existing = transaction.query_row(
            "SELECT session_id,workflow_id,task_id,role,runtime_session_key,parent_session_key,state,current_turn_id,attempt,last_activity_at FROM agent_sessions WHERE runtime_session_key=?1",
            params![request.runtime_session_key],
            load_agent_session_row,
        ).optional()?;
        if let Some(existing) = existing {
            if existing.workflow_id == workflow_id
                && existing.task_id == task_id
                && existing.role == role
                && existing.parent_session_key == request.parent_session_key
                && existing.attempt == request.attempt
            {
                transaction.commit()?;
                return Ok(existing);
            }
            return Err(StoreError::LeaseFenced);
        }
        let session_id = format!("session_{}", Uuid::new_v4().simple());
        transaction.execute(
            "INSERT INTO agent_sessions(session_id,workflow_id,task_id,role,runtime_session_key,parent_session_key,state,current_turn_id,attempt,created_at,updated_at,last_activity_at) VALUES(?1,?2,?3,?4,?5,?6,'CREATED',NULL,?7,?8,?8,?8)",
            params![session_id,workflow_id,task_id,role,request.runtime_session_key,request.parent_session_key,request.attempt as i64,timestamp],
        )?;
        insert_event(
            &transaction,
            workflow_id,
            Some(task_id),
            "session.created",
            &serde_json::json!({
                "sessionId":session_id,"taskId":task_id,"role":role,"sessionKey":request.runtime_session_key,
                "parentSessionKey":request.parent_session_key,"state":"CREATED","attempt":request.attempt
            }),
            &format!("session.created:{session_id}"),
            &timestamp,
        )?;
        let session = load_agent_session(&transaction, &session_id)?;
        transaction.commit()?;
        Ok(session)
    }

    /// List durable sessions with bounded filters. This is read-only and does
    /// not infer runtime liveness from registry state.
    pub fn list_agent_sessions(
        &self,
        workflow_id: Option<&str>,
        task_id: Option<&str>,
        state: Option<&str>,
        limit: u64,
    ) -> Result<Vec<AgentSessionRecord>, StoreError> {
        if limit == 0 || limit > 500 {
            return Err(StoreError::Invariant(
                "session list limit must be between 1 and 500".into(),
            ));
        }
        for (field, value) in [("workflow_id", workflow_id), ("task_id", task_id)] {
            if value.is_some_and(|value| value.trim().is_empty()) {
                return Err(StoreError::Invariant(format!(
                    "{field} filter must not be empty"
                )));
            }
        }
        let state = state.map(str::to_ascii_uppercase);
        if state.as_deref().is_some_and(|state| {
            !matches!(
                state,
                "CREATED" | "ACTIVE" | "PAUSED" | "STALE" | "FAILED" | "TERMINATED"
            )
        }) {
            return Err(StoreError::Invariant(
                "invalid agent session state filter".into(),
            ));
        }
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
        let mut statement = transaction.prepare(
            "SELECT session_id,workflow_id,task_id,role,runtime_session_key,parent_session_key,state,current_turn_id,attempt,last_activity_at FROM agent_sessions WHERE (?1 IS NULL OR workflow_id=?1) AND (?2 IS NULL OR task_id=?2) AND (?3 IS NULL OR state=?3) ORDER BY created_at DESC,session_id DESC LIMIT ?4"
        )?;
        let query_limit = i64::try_from(limit)
            .map_err(|_| StoreError::Invariant("session list limit overflow".into()))?;
        let sessions = statement
            .query_map(
                params![workflow_id, task_id, state, query_limit],
                load_agent_session_row,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        transaction.commit()?;
        Ok(sessions)
    }

    /// Inspect one session under OBSERVE permission and one consistent read
    /// transaction. Message history is bounded and reports truncation.
    pub fn inspect_agent_session(
        &self,
        session_id: &str,
        actor_role: &str,
        include_revoked_access: bool,
        message_limit: u64,
    ) -> Result<AgentSessionInspection, StoreError> {
        if message_limit == 0 || message_limit > 500 {
            return Err(StoreError::Invariant(
                "session message limit must be between 1 and 500".into(),
            ));
        }
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
        let session = load_agent_session(&transaction, session_id)?;
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        require_session_permission(
            &transaction,
            &session,
            actor_role,
            SessionPermission::Observe,
            &now,
        )?;
        let mut access = load_session_access(&transaction, session_id)?;
        if !include_revoked_access {
            access.retain(|grant| grant.revoked_at.is_none());
        }
        let query_limit = i64::try_from(message_limit + 1)
            .map_err(|_| StoreError::Invariant("session message limit overflow".into()))?;
        let mut statement = transaction.prepare(
            "SELECT message_id FROM session_messages WHERE session_id=?1 ORDER BY created_at,message_id LIMIT ?2"
        )?;
        let mut message_ids = statement
            .query_map(params![session_id, query_limit], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let messages_truncated = message_ids.len() > message_limit as usize;
        if messages_truncated {
            message_ids.truncate(message_limit as usize);
        }
        let messages = message_ids
            .iter()
            .map(|message_id| load_session_message(&transaction, message_id))
            .collect::<Result<Vec<_>, _>>()?;
        transaction.commit()?;
        Ok(AgentSessionInspection {
            session,
            access,
            messages,
            messages_truncated,
        })
    }

    /// Apply a compare-and-set session lifecycle update and append its event.
    pub fn update_agent_session(
        &self,
        session_id: &str,
        expected_attempt: u64,
        state: &str,
        current_turn_id: Option<&str>,
        heartbeat: bool,
    ) -> Result<AgentSessionRecord, StoreError> {
        const STATES: &[&str] = &[
            "CREATED",
            "ACTIVE",
            "PAUSED",
            "STALE",
            "FAILED",
            "TERMINATED",
        ];
        if !STATES.contains(&state) || current_turn_id.is_some_and(|value| value.trim().is_empty())
        {
            return Err(StoreError::Invariant(
                "invalid session lifecycle update".into(),
            ));
        }
        let timestamp = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let existing = load_agent_session(&transaction, session_id)?;
        if existing.attempt != expected_attempt {
            return Err(StoreError::LeaseFenced);
        }
        let allowed: &[&str] = match existing.state.as_str() {
            "CREATED" => STATES,
            "ACTIVE" => &["ACTIVE", "PAUSED", "STALE", "FAILED", "TERMINATED"],
            "PAUSED" => &["PAUSED", "ACTIVE", "STALE", "FAILED", "TERMINATED"],
            "STALE" => &["STALE", "ACTIVE", "FAILED", "TERMINATED"],
            "FAILED" => &["FAILED", "ACTIVE", "TERMINATED"],
            "TERMINATED" => &["TERMINATED"],
            _ => &[],
        };
        if !allowed.contains(&state) {
            return Err(StoreError::Invariant(
                "invalid agent session state transition".into(),
            ));
        }
        transaction.execute(
            "UPDATE agent_sessions SET state=?1,current_turn_id=COALESCE(?2,current_turn_id),updated_at=?3,last_activity_at=CASE WHEN ?4 THEN ?3 ELSE last_activity_at END WHERE session_id=?5 AND state=?6 AND attempt=?7",
            params![state,current_turn_id,timestamp,heartbeat,session_id,existing.state,expected_attempt as i64],
        )?;
        if transaction.changes() != 1 {
            return Err(StoreError::LeaseFenced);
        }
        let event_type = if state != existing.state {
            "session.state_changed"
        } else if heartbeat {
            "session.heartbeat"
        } else {
            "session.updated"
        };
        insert_event(
            &transaction,
            &existing.workflow_id,
            Some(&existing.task_id),
            event_type,
            &serde_json::json!({
                "sessionId":session_id,"taskId":existing.task_id,"from":existing.state,"to":state,
                "attempt":expected_attempt,"currentTurnId":current_turn_id,"heartbeat":heartbeat
            }),
            &format!(
                "{event_type}:{session_id}:{}:{}",
                expected_attempt,
                Uuid::new_v4().simple()
            ),
            &timestamp,
        )?;
        let updated = load_agent_session(&transaction, session_id)?;
        transaction.commit()?;
        Ok(updated)
    }

    /// Grant session ACL. Only system/cto or the owner role may grant; takeover
    /// can never be self-granted by the target role.
    pub fn grant_session_access(
        &self,
        session_id: &str,
        request: SessionAccessRequest,
    ) -> Result<String, StoreError> {
        let role = canonical_session_role(&request.accessor_role)?;
        let grantor = canonical_session_role(&request.granted_by)?;
        if request
            .expires_at
            .as_deref()
            .is_some_and(|value| !is_canonical_utc(value))
        {
            return Err(StoreError::Invariant(
                "session ACL expiry must be canonical UTC".into(),
            ));
        }
        if grantor != "system"
            && grantor != "cto"
            && !(grantor == role && request.permission != SessionPermission::Takeover)
        {
            return Err(StoreError::Invariant(
                "session ACL grant authority denied".into(),
            ));
        }
        let timestamp = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let session = load_agent_session(&transaction, session_id)?;
        let existing: Option<(String,String,Option<String>)> = transaction.query_row(
            "SELECT access_id,granted_by,expires_at FROM session_access WHERE session_id=?1 AND accessor_role=?2 AND permission=?3 AND revoked_at IS NULL",
            params![session_id,role,request.permission.as_db()], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))
        ).optional()?;
        let (access_id, event_type, previous) = if let Some((
            access_id,
            existing_grantor,
            existing_expiry,
        )) = existing
        {
            if existing_grantor == grantor && existing_expiry == request.expires_at {
                transaction.commit()?;
                return Ok(access_id);
            }
            transaction.execute("UPDATE session_access SET granted_by=?1,expires_at=?2 WHERE access_id=?3 AND revoked_at IS NULL", params![grantor,request.expires_at,access_id])?;
            (
                access_id,
                "session.access_updated",
                Some((existing_grantor, existing_expiry)),
            )
        } else {
            let access_id = format!("access_{}", Uuid::new_v4().simple());
            transaction.execute("INSERT INTO session_access(access_id,session_id,accessor_role,permission,granted_by,expires_at,created_at,revoked_at) VALUES(?1,?2,?3,?4,?5,?6,?7,NULL)",
                params![access_id,session_id,role,request.permission.as_db(),grantor,request.expires_at,timestamp])?;
            (access_id, "session.access_granted", None)
        };
        let mut event_payload = serde_json::json!({
            "accessId":access_id,"sessionId":session_id,"taskId":session.task_id,"accessorRole":role,
            "permission":request.permission.as_db(),"grantedBy":grantor,"expiresAt":request.expires_at
        });
        if let Some((previous_grantor, previous_expiry)) = previous {
            event_payload["previousGrantedBy"] = serde_json::json!(previous_grantor);
            event_payload["previousExpiresAt"] = serde_json::json!(previous_expiry);
        }
        insert_event(
            &transaction,
            &session.workflow_id,
            Some(&session.task_id),
            event_type,
            &event_payload,
            &format!(
                "session.access:{event_type}:{access_id}:{}",
                Uuid::new_v4().simple()
            ),
            &timestamp,
        )?;
        transaction.commit()?;
        Ok(access_id)
    }

    /// Revoke an active session grant under the same SQLite writer lock used
    /// for permission checks and grant changes.
    pub fn revoke_session_access(&self, access_id: &str, actor: &str) -> Result<bool, StoreError> {
        let actor = canonical_session_role(actor)?;
        let timestamp = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let row=transaction.query_row("SELECT a.session_id,a.accessor_role,a.permission,a.revoked_at,s.workflow_id,s.task_id,s.role FROM session_access a JOIN agent_sessions s ON s.session_id=a.session_id WHERE a.access_id=?1",params![access_id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,Option<String>>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,String>(6)?))).optional()?;
        let Some((session_id, accessor, permission, revoked, workflow_id, task_id, owner_role)) =
            row
        else {
            return Ok(false);
        };
        if revoked.is_some() {
            transaction.commit()?;
            return Ok(false);
        }
        if actor != "system" && actor != "cto" && actor != owner_role && actor != accessor {
            return Err(StoreError::Invariant(
                "session ACL revoke authority denied".into(),
            ));
        }
        transaction.execute(
            "UPDATE session_access SET revoked_at=?1 WHERE access_id=?2 AND revoked_at IS NULL",
            params![timestamp, access_id],
        )?;
        if transaction.changes() != 1 {
            return Err(StoreError::LeaseFenced);
        }
        insert_event(
            &transaction,
            &workflow_id,
            Some(&task_id),
            "session.access_revoked",
            &serde_json::json!({"accessId":access_id,"sessionId":session_id,"taskId":task_id,"accessorRole":accessor,"permission":permission,"actor":actor,"revokedAt":timestamp}),
            &format!("session.access.revoked:{access_id}"),
            &timestamp,
        )?;
        transaction.commit()?;
        Ok(true)
    }

    /// Attach to a session under explicit OBSERVE, MESSAGE or TAKEOVER ACL.
    pub fn attach_agent_session(
        &self,
        session_id: &str,
        actor_role: &str,
        mode: &str,
    ) -> Result<SessionAttachment, StoreError> {
        let actor = canonical_session_role(actor_role)?;
        let mode = match mode.trim().to_ascii_uppercase().as_str() {
            "OBSERVE" => "OBSERVE",
            "INTERACT" => "INTERACT",
            "TAKEOVER" => "TAKEOVER",
            _ => {
                return Err(StoreError::Invariant(
                    "invalid session attachment mode".into(),
                ));
            }
        };
        let permission = match mode {
            "INTERACT" => SessionPermission::Message,
            "TAKEOVER" => SessionPermission::Takeover,
            _ => SessionPermission::Observe,
        };
        let timestamp = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let session = load_agent_session(&transaction, session_id)?;
        require_session_permission(&transaction, &session, &actor, permission, &timestamp)?;
        let payload = serde_json::json!({"sessionId":session_id,"taskId":session.task_id,"actorRole":actor,"mode":mode,"permission":permission.as_db()});
        insert_event(
            &transaction,
            &session.workflow_id,
            Some(&session.task_id),
            "session.attached",
            &payload,
            &format!("session.attached:{session_id}:{actor}:{mode}"),
            &timestamp,
        )?;
        let attachment = SessionAttachment {
            session,
            mode: mode.into(),
            permission: permission.as_db().into(),
        };
        transaction.commit()?;
        Ok(attachment)
    }

    /// Transfer a PAUSED/STALE/FAILED session to an explicitly authorized non-owner.
    pub fn takeover_agent_session(
        &self,
        session_id: &str,
        actor_role: &str,
        reason: &str,
    ) -> Result<AgentSessionRecord, StoreError> {
        let actor = canonical_session_role(actor_role)?;
        if reason.trim().is_empty() {
            return Err(StoreError::Invariant(
                "session takeover reason is required".into(),
            ));
        }
        let timestamp = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let session = load_agent_session(&transaction, session_id)?;
        require_session_permission(
            &transaction,
            &session,
            &actor,
            SessionPermission::Takeover,
            &timestamp,
        )?;
        if actor == session.role {
            return Err(StoreError::Invariant(
                "session owner cannot takeover its own session".into(),
            ));
        }
        if !["PAUSED", "STALE", "FAILED"].contains(&session.state.as_str()) {
            return Err(StoreError::Invariant(format!(
                "session takeover requires PAUSED, STALE or FAILED state; got {}",
                session.state
            )));
        }
        transaction.execute("UPDATE agent_sessions SET state='ACTIVE',updated_at=?1,last_activity_at=?1 WHERE session_id=?2 AND state=?3 AND attempt=?4",params![timestamp,session_id,session.state,session.attempt as i64])?;
        if transaction.changes() != 1 {
            return Err(StoreError::LeaseFenced);
        }
        insert_event(
            &transaction,
            &session.workflow_id,
            Some(&session.task_id),
            "session.state_changed",
            &serde_json::json!({
                "sessionId":session_id,"taskId":session.task_id,"from":session.state,"to":"ACTIVE",
                "previousAttempt":session.attempt,"attempt":session.attempt,"currentTurnId":session.current_turn_id,
                "parentSessionKey":session.parent_session_key
            }),
            &format!(
                "session.takeover.state:{session_id}:{}:{}",
                session.attempt,
                Uuid::new_v4().simple()
            ),
            &timestamp,
        )?;
        insert_event(
            &transaction,
            &session.workflow_id,
            Some(&session.task_id),
            "session.takeover",
            &serde_json::json!({
                "sessionId":session_id,"taskId":session.task_id,"fromRole":session.role,"actorRole":actor,"reason":reason
            }),
            &format!(
                "session.takeover:{session_id}:{actor}:{}",
                Uuid::new_v4().simple()
            ),
            &timestamp,
        )?;
        let updated = load_agent_session(&transaction, session_id)?;
        if updated.state != "ACTIVE" || updated.attempt != session.attempt {
            return Err(StoreError::Invariant(
                "session takeover readback failed".into(),
            ));
        }
        transaction.commit()?;
        Ok(updated)
    }

    /// Enqueue a deduplicated durable message and its event atomically.
    pub fn enqueue_session_message(
        &self,
        session_id: &str,
        request: SessionMessageRequest,
    ) -> Result<SessionMessageRecord, StoreError> {
        if request.sender_role.trim().is_empty()
            || request.recipient_role.trim().is_empty()
            || request.message_type.trim().is_empty()
            || !request.payload.is_object()
            || request
                .correlation_id
                .as_ref()
                .is_some_and(|value| value.trim().is_empty())
            || request
                .dedupe_key
                .as_ref()
                .is_some_and(|value| value.trim().is_empty())
            || request
                .available_at
                .as_deref()
                .is_some_and(|value| !is_canonical_utc(value))
        {
            return Err(StoreError::Invariant(
                "invalid session message contract".into(),
            ));
        }
        let timestamp = now();
        let ready_at = request
            .available_at
            .clone()
            .unwrap_or_else(|| timestamp.clone());
        let payload_json = serde_json::to_string(&request.payload)?;
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let session = load_agent_session(&transaction, session_id)?;
        require_session_permission(
            &transaction,
            &session,
            &request.sender_role,
            SessionPermission::Message,
            &timestamp,
        )?;
        if let Some(dedupe) = request.dedupe_key.as_deref() {
            let existing: Option<String> = transaction
                .query_row(
                    "SELECT message_id FROM session_messages WHERE session_id=?1 AND dedupe_key=?2",
                    params![session_id, dedupe],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(message_id) = existing {
                let record = load_session_message(&transaction, &message_id)?;
                if record.sender_role != request.sender_role
                    || record.recipient_role != request.recipient_role
                    || record.message_type != request.message_type
                    || record.payload != request.payload
                    || record.correlation_id != request.correlation_id
                    || (request.available_at.is_some() && record.available_at != ready_at)
                {
                    return Err(StoreError::ProviderIntentConflict);
                }
                transaction.commit()?;
                return Ok(record);
            }
        }
        let message_id = format!("msg_{}", Uuid::new_v4().simple());
        transaction.execute("INSERT INTO session_messages(message_id,session_id,sender_role,recipient_role,protocol,protocol_version,message_type,payload_json,correlation_id,dedupe_key,state,attempt,available_at,created_at,updated_at) VALUES(?1,?2,?3,?4,'cos-ap',1,?5,?6,?7,?8,'QUEUED',0,?9,?10,?10)",
            params![message_id,session_id,request.sender_role,request.recipient_role,request.message_type,payload_json,request.correlation_id,request.dedupe_key,ready_at,timestamp])?;
        insert_event(
            &transaction,
            &session.workflow_id,
            Some(&session.task_id),
            "session.message_queued",
            &serde_json::json!({
                "messageId":message_id,"sessionId":session_id,"taskId":session.task_id,"senderRole":request.sender_role,
                "recipientRole":request.recipient_role,"messageType":request.message_type,"correlationId":request.correlation_id,
                "dedupeKey":request.dedupe_key
            }),
            &format!("session.message.queued:{message_id}"),
            &timestamp,
        )?;
        let message = load_session_message(&transaction, &message_id)?;
        transaction.commit()?;
        Ok(message)
    }

    /// Claim a queued message. Expired claimed messages become UNCERTAIN and
    /// are never automatically made available for another transport send.
    pub fn claim_session_message(
        &self,
        message_id: &str,
        recipient_role: &str,
        lease_seconds: u64,
    ) -> Result<Option<SessionMessageRecord>, StoreError> {
        if lease_seconds == 0 || lease_seconds > 86_400 {
            return Err(StoreError::Invariant(
                "invalid session message lease".into(),
            ));
        }
        let timestamp = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let current = match load_session_message_optional(&transaction, message_id)? {
            Some(value) => value,
            None => return Ok(None),
        };
        let session = load_agent_session(&transaction, &current.session_id)?;
        require_session_permission(
            &transaction,
            &session,
            recipient_role,
            SessionPermission::Message,
            &timestamp,
        )?;
        if current.recipient_role != recipient_role {
            return Err(StoreError::Invariant(
                "session message recipient mismatch".into(),
            ));
        }
        if current.state == "ACKED" || current.state == "FAILED" || current.state == "UNCERTAIN" {
            transaction.commit()?;
            return Ok(Some(current));
        }
        if current.state == "CLAIMED" {
            if current
                .lease_until
                .as_deref()
                .is_some_and(|expiry| expiry <= timestamp.as_str())
            {
                if current.transport_started_at.is_some() {
                    transaction.execute("UPDATE session_messages SET state='UNCERTAIN',last_error='expired delivery claim after transport start; external send outcome unknown',updated_at=?1 WHERE message_id=?2 AND state='CLAIMED' AND attempt=?3",params![timestamp,message_id,current.attempt as i64])?;
                    insert_event(
                        &transaction,
                        &session.workflow_id,
                        Some(&session.task_id),
                        "session.message_delivery_uncertain",
                        &serde_json::json!({"messageId":message_id,"attempt":current.attempt,"reason":"expired_after_transport_start"}),
                        &format!("session.message.uncertain:{message_id}:{}", current.attempt),
                        &timestamp,
                    )?;
                    let uncertain = load_session_message(&transaction, message_id)?;
                    transaction.commit()?;
                    return Ok(Some(uncertain));
                }
                transaction.execute("UPDATE session_messages SET state='QUEUED',lease_until=NULL,last_error='previous claim expired before transport start',updated_at=?1 WHERE message_id=?2 AND state='CLAIMED' AND attempt=?3 AND transport_started_at IS NULL",params![timestamp,message_id,current.attempt as i64])?;
                if transaction.changes() != 1 {
                    return Err(StoreError::LeaseFenced);
                }
                insert_event(
                    &transaction,
                    &session.workflow_id,
                    Some(&session.task_id),
                    "session.message_retry",
                    &serde_json::json!({"messageId":message_id,"attempt":current.attempt,"reason":"expired_before_transport_start"}),
                    &format!("session.message.retry:{message_id}:{}", current.attempt),
                    &timestamp,
                )?;
            } else {
                transaction.commit()?;
                return Ok(Some(current));
            }
        }
        if !["QUEUED", "CLAIMED"].contains(&current.state.as_str())
            || current.available_at > timestamp
        {
            transaction.commit()?;
            return Ok(Some(current));
        }
        let next_attempt = current
            .attempt
            .checked_add(1)
            .ok_or(StoreError::InvalidAttempt)?;
        let lease_until = (Utc::now() + Duration::seconds(lease_seconds as i64))
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        transaction.execute("UPDATE session_messages SET state='CLAIMED',attempt=?1,lease_until=?2,delivered_at=?3,updated_at=?3,last_error=NULL,transport_started_at=NULL,receipt_json=NULL WHERE message_id=?4 AND state='QUEUED' AND attempt=?5",params![next_attempt as i64,lease_until,timestamp,message_id,current.attempt as i64])?;
        if transaction.changes() != 1 {
            return Err(StoreError::LeaseFenced);
        }
        insert_event(
            &transaction,
            &session.workflow_id,
            Some(&session.task_id),
            "session.message_delivered",
            &serde_json::json!({"messageId":message_id,"sessionId":current.session_id,"recipientRole":recipient_role,"attempt":next_attempt,"leaseUntil":lease_until}),
            &format!("session.message.claimed:{message_id}:{next_attempt}"),
            &timestamp,
        )?;
        let claimed = load_session_message(&transaction, message_id)?;
        transaction.commit()?;
        Ok(Some(SessionMessageRecord {
            claim_acquired: true,
            ..claimed
        }))
    }

    /// Persist the exact transport-start intent before invoking external I/O.
    pub fn record_session_message_delivery_start(
        &self,
        message_id: &str,
        attempt: u64,
        lease_until: &str,
    ) -> Result<(), StoreError> {
        let timestamp = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let current = load_session_message(&transaction, message_id)?;
        let session = load_agent_session(&transaction, &current.session_id)?;
        require_session_permission(
            &transaction,
            &session,
            &current.recipient_role,
            SessionPermission::Message,
            &timestamp,
        )?;
        if current.state != "CLAIMED"
            || current.attempt != attempt
            || current.lease_until.as_deref() != Some(lease_until)
            || lease_until <= timestamp.as_str()
            || current.transport_started_at.is_some()
        {
            return Err(StoreError::LeaseFenced);
        }
        transaction.execute(
            "UPDATE session_messages SET transport_started_at=?1,updated_at=?1 WHERE message_id=?2 AND state='CLAIMED' AND attempt=?3 AND lease_until=?4 AND transport_started_at IS NULL",
            params![timestamp,message_id,attempt as i64,lease_until],
        )?;
        if transaction.changes() != 1 {
            return Err(StoreError::LeaseFenced);
        }
        insert_event(
            &transaction,
            &session.workflow_id,
            Some(&session.task_id),
            "session.message_delivery_started",
            &serde_json::json!({
                "messageId":message_id,"sessionId":session.session_id,"recipientRole":current.recipient_role,
                "attempt":attempt,"leaseUntil":lease_until,"startedAt":timestamp,"idempotencyKey":message_id
            }),
            &format!("session.message.started:{message_id}:{attempt}"),
            &timestamp,
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Record an exact successful transport receipt. Provider run IDs cannot
    /// be reused by another session message.
    pub fn record_session_message_receipt(
        &self,
        message_id: &str,
        attempt: u64,
        lease_until: &str,
        receipt: SessionDeliveryReceipt,
    ) -> Result<(), StoreError> {
        if receipt.run_id.trim().is_empty() || !is_canonical_utc(&receipt.recorded_at) {
            return Err(StoreError::Invariant(
                "invalid session delivery receipt".into(),
            ));
        }
        let timestamp = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let current = load_session_message(&transaction, message_id)?;
        let session = load_agent_session(&transaction, &current.session_id)?;
        if current.state != "CLAIMED"
            || current.attempt != attempt
            || current.lease_until.as_deref() != Some(lease_until)
            || current.transport_started_at.is_none()
            || current.receipt.is_some()
            || receipt.recorded_at < current.transport_started_at.clone().unwrap_or_default()
            || receipt.session_key != session.runtime_session_key
        {
            return Err(StoreError::LeaseFenced);
        }
        let reused: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM session_messages WHERE message_id!=?1 AND json_extract(receipt_json,'$.run_id')=?2)",
            params![message_id,receipt.run_id], |row| row.get(0),
        )?;
        if reused {
            return Err(StoreError::Invariant(
                "provider run ID already belongs to another session message".into(),
            ));
        }
        let receipt_value = serde_json::to_value(&receipt)?;
        let receipt_json = serde_json::to_string(&receipt_value)?;
        transaction.execute(
            "UPDATE session_messages SET receipt_json=?1,updated_at=?2 WHERE message_id=?3 AND state='CLAIMED' AND attempt=?4 AND lease_until=?5 AND receipt_json IS NULL",
            params![receipt_json,timestamp,message_id,attempt as i64,lease_until],
        )?;
        if transaction.changes() != 1 {
            return Err(StoreError::LeaseFenced);
        }
        insert_event(
            &transaction,
            &session.workflow_id,
            Some(&session.task_id),
            "session.message_receipt",
            &serde_json::json!({
                "messageId":message_id,"attempt":attempt,"status":"OK","runId":receipt.run_id,
                "error":serde_json::Value::Null,"sessionKey":receipt.session_key,"response":receipt.response,"recordedAt":receipt.recorded_at
            }),
            &format!("session.message.receipt:{message_id}:{attempt}"),
            &timestamp,
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Acknowledge only an exact active claim with a durable transport-start
    /// marker and successful receipt.
    pub fn acknowledge_session_message(
        &self,
        message_id: &str,
        recipient_role: &str,
        expected_attempt: u64,
        expected_lease_until: &str,
    ) -> Result<SessionMessageRecord, StoreError> {
        let timestamp = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let current = load_session_message(&transaction, message_id)?;
        let session = load_agent_session(&transaction, &current.session_id)?;
        require_session_permission(
            &transaction,
            &session,
            recipient_role,
            SessionPermission::Message,
            &timestamp,
        )?;
        if current.recipient_role != recipient_role
            || current.state != "CLAIMED"
            || current.attempt != expected_attempt
            || current.lease_until.as_deref() != Some(expected_lease_until)
            || expected_lease_until <= timestamp.as_str()
            || current.transport_started_at.is_none()
            || current.receipt.as_ref().is_none_or(|receipt| {
                receipt
                    .get("run_id")
                    .and_then(serde_json::Value::as_str)
                    .is_none_or(str::is_empty)
                    || receipt
                        .get("recorded_at")
                        .and_then(serde_json::Value::as_str)
                        .is_none()
            })
        {
            return Err(StoreError::LeaseFenced);
        }
        let receipt: SessionDeliveryReceipt =
            serde_json::from_value(current.receipt.clone().ok_or(StoreError::LeaseFenced)?)?;
        let started_at = current
            .transport_started_at
            .as_deref()
            .ok_or(StoreError::LeaseFenced)?;
        if receipt.run_id.trim().is_empty()
            || receipt.session_key != session.runtime_session_key
            || !is_canonical_utc(&receipt.recorded_at)
            || receipt.recorded_at.as_str() < started_at
        {
            return Err(StoreError::LeaseFenced);
        }
        let start_payload = serde_json::json!({
            "messageId":message_id,"sessionId":session.session_id,"recipientRole":current.recipient_role,
            "attempt":expected_attempt,"leaseUntil":expected_lease_until,"startedAt":started_at,"idempotencyKey":message_id
        });
        let start_event: Option<(String, String, String)> = transaction.query_row(
            "SELECT event_type,payload_json,task_id FROM events WHERE workflow_id=?1 AND idempotency_key=?2",
            params![session.workflow_id,format!("session.message.started:{message_id}:{expected_attempt}")],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).optional()?;
        let start_payload_json = serde_json::to_string(&start_payload)?;
        if !start_event.as_ref().is_some_and(|event| {
            event.0 == "session.message_delivery_started"
                && event.1 == start_payload_json
                && event.2 == session.task_id
        }) {
            return Err(StoreError::LeaseFenced);
        }
        let receipt_payload = serde_json::json!({
            "messageId":message_id,"attempt":expected_attempt,"status":"OK","runId":receipt.run_id,
            "error":serde_json::Value::Null,"sessionKey":receipt.session_key,"response":receipt.response,"recordedAt":receipt.recorded_at
        });
        let receipt_event: Option<(String, String, String)> = transaction.query_row(
            "SELECT event_type,payload_json,task_id FROM events WHERE workflow_id=?1 AND idempotency_key=?2",
            params![session.workflow_id,format!("session.message.receipt:{message_id}:{expected_attempt}")],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).optional()?;
        let receipt_payload_json = serde_json::to_string(&receipt_payload)?;
        if !receipt_event.as_ref().is_some_and(|event| {
            event.0 == "session.message_receipt"
                && event.1 == receipt_payload_json
                && event.2 == session.task_id
        }) {
            return Err(StoreError::LeaseFenced);
        }
        transaction.execute("UPDATE session_messages SET state='ACKED',acked_at=?1,lease_until=NULL,updated_at=?1 WHERE message_id=?2 AND state='CLAIMED' AND attempt=?3 AND lease_until=?4",params![timestamp,message_id,expected_attempt as i64,expected_lease_until])?;
        if transaction.changes() != 1 {
            return Err(StoreError::LeaseFenced);
        }
        insert_event(
            &transaction,
            &session.workflow_id,
            Some(&session.task_id),
            "session.message_acked",
            &serde_json::json!({"messageId":message_id,"sessionId":session.session_id,"recipientRole":recipient_role,"attempt":expected_attempt}),
            &format!("session.message.acked:{message_id}:{expected_attempt}"),
            &timestamp,
        )?;
        let acked = load_session_message(&transaction, message_id)?;
        transaction.commit()?;
        Ok(acked)
    }

    /// Mark a delivery claim uncertain after an ambiguous external transport result.
    pub fn mark_session_message_uncertain(
        &self,
        message_id: &str,
        expected_attempt: u64,
        reason: &str,
    ) -> Result<SessionMessageRecord, StoreError> {
        if reason.trim().is_empty() {
            return Err(StoreError::Invariant(
                "uncertain delivery requires a reason".into(),
            ));
        }
        let timestamp = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let current = load_session_message(&transaction, message_id)?;
        let session = load_agent_session(&transaction, &current.session_id)?;
        if current.state != "CLAIMED"
            || current.attempt != expected_attempt
            || current.transport_started_at.is_none()
        {
            return Err(StoreError::LeaseFenced);
        }
        transaction.execute("UPDATE session_messages SET state='UNCERTAIN',last_error=?1,updated_at=?2 WHERE message_id=?3 AND state='CLAIMED' AND attempt=?4",params![reason,timestamp,message_id,expected_attempt as i64])?;
        if transaction.changes() != 1 {
            return Err(StoreError::LeaseFenced);
        }
        insert_event(
            &transaction,
            &session.workflow_id,
            Some(&session.task_id),
            "session.message_delivery_uncertain",
            &serde_json::json!({"messageId":message_id,"attempt":expected_attempt,"reason":reason}),
            &format!("session.message.uncertain:{message_id}:{expected_attempt}"),
            &timestamp,
        )?;
        let uncertain = load_session_message(&transaction, message_id)?;
        transaction.commit()?;
        Ok(uncertain)
    }

    /// Verify and persist approval in one writer transaction.
    pub fn approve(
        &self,
        workflow_id: &str,
        request: ApprovalRequest,
        verifier: &dyn ApprovalVerifier,
    ) -> Result<WorkflowView, StoreError> {
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let current = load_workflow_from(&transaction, workflow_id)?;
        if current.state != WorkflowState::Proposed {
            return Err(StoreError::Invariant(
                "only a proposed workflow can be approved".into(),
            ));
        }
        let actual_proposal_hash = content_hash(&current.proposal)
            .map_err(|error| StoreError::Invariant(error.to_string()))?;
        let actual_plan_hash = content_hash(&current.plan)
            .map_err(|error| StoreError::Invariant(error.to_string()))?;
        if request.expected_proposal_hash != actual_proposal_hash
            || request.expected_plan_hash != actual_plan_hash
        {
            return Err(StoreError::ApprovalBindingMismatch);
        }
        let verified = verifier.verify(
            &transaction,
            &current.proposal,
            &current.plan,
            &request,
            ApprovalVerificationMode::Initial,
        )?;
        if verified.actor.trim().is_empty() || !verified.evidence.is_object() {
            return Err(StoreError::InvalidVerifierOutput);
        }
        let approved_at = now();
        let approval = Approval {
            approval_id: format!("approval_{}", Uuid::new_v4().simple()),
            actor: verified.actor,
            proposal_hash: actual_proposal_hash.clone(),
            plan_hash: actual_plan_hash.clone(),
            evidence: verified.evidence,
            approved_at: approved_at.clone(),
        };
        let approval_json = serde_json::to_string(&approval)?;
        let changed = transaction.execute(
            "UPDATE workflows SET state='APPROVED',plan_sha256=?1,approval_json=?2,updated_at=?3 WHERE workflow_id=?4 AND state='PROPOSED' AND proposal_sha256=?5",
            params![actual_plan_hash, approval_json, approved_at, workflow_id, actual_proposal_hash],
        )?;
        if changed != 1 {
            return Err(StoreError::Invariant(
                "approval lost workflow compare-and-set".into(),
            ));
        }
        pin_workflow_success_contract(&transaction, workflow_id, &actual_plan_hash)?;
        transaction.execute(
            "INSERT INTO approvals(approval_id,workflow_id,proposal_sha256,plan_sha256,actor,evidence_json,approved_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![approval.approval_id, workflow_id, actual_proposal_hash, actual_plan_hash, approval.actor, serde_json::to_string(&approval.evidence)?, approved_at],
        )?;
        insert_event(
            &transaction,
            workflow_id,
            None,
            "workflow.approved",
            &serde_json::json!({
                "approvalId": approval.approval_id,
                "actor": approval.actor,
                "proposalHash": actual_proposal_hash,
                "planHash": actual_plan_hash
            }),
            &format!("approval:{actual_proposal_hash}:{actual_plan_hash}"),
            &approved_at,
        )?;
        transaction.commit()?;
        drop(connection);
        self.get_workflow(workflow_id)
    }

    /// Request workflow cancellation under an injected authenticated authority.
    /// Running leases are retained as evidence; this does not kill workers,
    /// revoke leases, synthesize results or infer external process state.
    pub fn cancel_workflow(
        &self,
        workflow_id: &str,
        request: WorkflowCancellationRequest,
        verifier: &dyn WorkflowCancellationVerifier,
    ) -> Result<WorkflowView, StoreError> {
        if request.actor.trim().is_empty()
            || request.reason.trim().is_empty()
            || request.reason.len() > 2000
        {
            return Err(StoreError::Invariant(
                "cancellation requires a non-empty actor and reason (maximum 2000 bytes)".into(),
            ));
        }
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let workflow = load_workflow_from(&transaction, workflow_id)?;
        let actor =
            verifier.verify_cancel(&transaction, &workflow, &request.actor, &request.reason)?;
        if actor.trim().is_empty() || actor.trim() != actor || actor.len() > 200 {
            return Err(StoreError::InvalidVerifierOutput);
        }
        if let Some(existing) = workflow.cancellation_request.as_ref() {
            if existing.actor == actor && existing.reason == request.reason {
                transaction.commit()?;
                return Ok(workflow);
            }
            return Err(StoreError::Invariant(
                "workflow already has a different immutable cancellation request".into(),
            ));
        }
        if !matches!(
            workflow.state,
            WorkflowState::Proposed | WorkflowState::Approved | WorkflowState::Executing
        ) {
            return Err(StoreError::Invariant(
                "terminal workflow cannot be cancelled".into(),
            ));
        }
        let timestamp = now();
        // A proposal that never entered execution can be cancelled terminally.
        // Once a task has been claimed, Control records only the request and
        // keeps workflow state and leases intact until Execution supplies the
        // independently authoritative settlement receipt.
        let changed = match workflow.state {
            WorkflowState::Proposed | WorkflowState::Approved => transaction.execute(
                "UPDATE workflows
                 SET state='CANCELLED',cancellation_requested_at=?1,updated_at=?1
                 WHERE workflow_id=?2 AND state=?3 AND cancellation_requested_at IS NULL",
                params![timestamp, workflow_id, workflow.state.as_db()],
            )?,
            WorkflowState::Executing => transaction.execute(
                "UPDATE workflows
                 SET cancellation_requested_at=?1,updated_at=?1
                 WHERE workflow_id=?2 AND state='EXECUTING' AND cancellation_requested_at IS NULL",
                params![timestamp, workflow_id],
            )?,
            _ => 0,
        };
        if changed != 1 {
            return Err(StoreError::LeaseFenced);
        }
        let plan_sha256 = content_hash(&workflow.plan)
            .map_err(|error| StoreError::Invariant(error.to_string()))?;
        if workflow
            .plan_hash
            .as_deref()
            .is_some_and(|pinned| pinned != plan_sha256)
        {
            return Err(StoreError::Invariant(
                "cancellation request plan does not match the immutable workflow plan".into(),
            ));
        }
        insert_event(
            &transaction,
            workflow_id,
            None,
            "workflow.cancel_requested",
            &serde_json::json!({
                "actor":actor,
                "reason":request.reason,
                "planSha256":plan_sha256,
                "runningLeasesRetained":true,
                "settlementRequired":workflow.state == WorkflowState::Executing
            }),
            &format!("workflow.cancel:{workflow_id}"),
            &timestamp,
        )?;
        transaction.commit()?;
        drop(connection);
        self.get_workflow(workflow_id)
    }

    /// Claim a dependency-ready task under a unique worker lease.
    ///
    /// Admission is a separate persisted checkpoint. It revalidates the exact
    /// approval, attached immutable policy pins and plan-bound success contract
    /// under the same writer transaction before recording admission evidence.
    /// Claim paths repeat the same verification; admission is not a reusable
    /// authorization token.
    pub fn admit_workflow(
        &self,
        workflow_id: &str,
        verifier: &dyn ApprovalVerifier,
    ) -> Result<WorkflowView, StoreError> {
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let workflow = load_workflow_from(&transaction, workflow_id)?;
        if workflow.cancellation_request.is_some() {
            return Err(StoreError::TaskNotClaimable);
        }
        if !matches!(
            workflow.state,
            WorkflowState::Approved | WorkflowState::Executing
        ) {
            return Err(StoreError::ApprovalRequired);
        }
        verify_current_approval(&transaction, &workflow, verifier)?;
        let plan_sha256 = workflow
            .plan_hash
            .as_deref()
            .ok_or(StoreError::ApprovalRequired)?;
        let policy_pins: Vec<serde_json::Value> =
            load_workflow_policy_attachments(&transaction, workflow_id)?
                .iter()
                .map(|policy| {
                    serde_json::json!({
                        "policy_id":policy.policy_id,
                        "version":policy.version,
                        "content_sha256":policy.content_sha256
                    })
                })
                .collect();
        let payload = serde_json::json!({
            "workflow_id":workflow_id,
            "plan_sha256":plan_sha256,
            "policy_pins":policy_pins,
            "approval_id":workflow.approval.as_ref().map(|approval| approval.approval_id.as_str())
        });
        let payload_json = serde_json::to_string(&payload)?;
        let existing: Option<(String, String)> = transaction.query_row(
            "SELECT event_type,payload_json FROM events WHERE workflow_id=?1 AND idempotency_key=?2",
            params![workflow_id, format!("workflow.admitted:{plan_sha256}")],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        match existing {
            Some((event_type, stored_payload))
                if event_type == "workflow.admitted" && stored_payload == payload_json => {}
            Some(_) => {
                return Err(StoreError::Invariant(
                    "persisted workflow admission conflicts with current approval or policy pins"
                        .into(),
                ));
            }
            None => {
                let timestamp = now();
                insert_event(
                    &transaction,
                    workflow_id,
                    None,
                    "workflow.admitted",
                    &payload,
                    &format!("workflow.admitted:{plan_sha256}"),
                    &timestamp,
                )?;
            }
        }
        transaction.commit()?;
        drop(connection);
        self.get_workflow(workflow_id)
    }

    /// Claim a dependency-ready task under a unique worker lease.
    pub fn claim_task(
        &self,
        workflow_id: &str,
        task_id: &str,
        request: ClaimRequest,
        verifier: &dyn ApprovalVerifier,
    ) -> Result<TaskLease, StoreError> {
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let workflow = load_workflow_from(&transaction, workflow_id)?;
        if workflow.cancellation_request.is_some() {
            return Err(StoreError::TaskNotClaimable);
        }
        verify_current_approval(&transaction, &workflow, verifier)?;
        if !matches!(
            workflow.state,
            WorkflowState::Approved | WorkflowState::Executing
        ) {
            return Err(StoreError::ApprovalRequired);
        }
        let task = workflow
            .tasks
            .iter()
            .find(|task| task.definition.task_id == task_id)
            .ok_or_else(|| StoreError::NotFound(format!("task {task_id}")))?;
        if task.state != TaskState::Pending {
            return Err(StoreError::TaskNotClaimable);
        }
        for dependency in &task.definition.depends_on {
            let dependency_task = workflow
                .tasks
                .iter()
                .find(|candidate| candidate.definition.task_id == *dependency)
                .ok_or_else(|| {
                    StoreError::Invariant(format!("plan dependency disappeared: {dependency}"))
                })?;
            if dependency_task.state != TaskState::Succeeded {
                return Err(StoreError::DependenciesNotReady);
            }
        }
        let attempt = task
            .attempts
            .checked_add(1)
            .ok_or_else(|| StoreError::Invariant("task attempt counter overflow".into()))?;
        if attempt > i64::MAX as u64 {
            return Err(StoreError::InvalidAttempt);
        }
        let lease_id = format!("lease_{}", Uuid::new_v4().simple());
        let previous_epoch: i64 = transaction.query_row(
            "SELECT owner_epoch FROM tasks WHERE workflow_id=?1 AND task_id=?2",
            params![workflow_id, task_id],
            |row| row.get(0),
        )?;
        let owner_epoch = u64::try_from(previous_epoch)
            .map_err(|_| StoreError::Invariant("negative lease owner epoch".into()))?
            .checked_add(1)
            .filter(|epoch| *epoch <= i64::MAX as u64)
            .ok_or_else(|| StoreError::Invariant("lease owner epoch overflow".into()))?;
        let expires_at = (Utc::now() + Duration::seconds(request.lease_ttl_seconds as i64))
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        let timestamp = now();
        let changed = transaction.execute(
            "UPDATE tasks SET state='RUNNING',attempts=?1,owner_epoch=?2,lease_id=?3,lease_owner=?4,lease_expires_at=?5 WHERE task_id=?6 AND workflow_id=?7 AND state='PENDING' AND attempts=?8 AND owner_epoch=?9",
            params![attempt as i64, owner_epoch as i64, lease_id, request.worker_id, expires_at, task_id, workflow_id, task.attempts as i64, previous_epoch],
        )?;
        if changed != 1 {
            return Err(StoreError::LeaseFenced);
        }
        transaction.execute(
            "INSERT INTO task_attempts(workflow_id,task_id,attempt,owner_epoch,lease_id,worker_id,lease_expires_at,claimed_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![workflow_id, task_id, attempt as i64, owner_epoch as i64, lease_id, request.worker_id, expires_at, timestamp],
        )?;
        if workflow.state == WorkflowState::Approved {
            let changed = transaction.execute(
                "UPDATE workflows SET state='EXECUTING',updated_at=?1 WHERE workflow_id=?2 AND state='APPROVED' AND plan_sha256=?3",
                params![timestamp, workflow_id, workflow.plan_hash],
            )?;
            if changed != 1 {
                return Err(StoreError::LeaseFenced);
            }
        } else {
            let changed = transaction.execute(
                "UPDATE workflows SET updated_at=?1 WHERE workflow_id=?2 AND state='EXECUTING' AND plan_sha256=?3",
                params![timestamp, workflow_id, workflow.plan_hash],
            )?;
            if changed != 1 {
                return Err(StoreError::LeaseFenced);
            }
        }
        insert_event(
            &transaction,
            workflow_id,
            Some(task_id),
            "task.claimed",
            &serde_json::json!({
                "leaseId": lease_id,
                "workerId": request.worker_id,
                "attempt": attempt,
                "ownerEpoch": owner_epoch,
                "expiresAt": expires_at
            }),
            &format!("claim:{task_id}:{attempt}"),
            &timestamp,
        )?;
        transaction.commit()?;
        Ok(TaskLease {
            workflow_id: workflow_id.into(),
            task_id: task_id.into(),
            lease_id,
            worker_id: request.worker_id,
            attempt,
            owner_epoch,
            expires_at,
        })
    }

    /// Renew one exact, still-live lease and append an immutable renewal event.
    ///
    /// The renewal ID is an idempotency key supplied by the authenticated
    /// Control transport. Ownership checks, expiry check, task projection
    /// update, append-only renewal row and workflow event are committed in one
    /// IMMEDIATE transaction. A duplicate renewal ID returns the original
    /// expiry and cannot extend the lease a second time.
    pub fn renew_task_lease(
        &self,
        request: TaskLeaseRenewalRequest,
    ) -> Result<TaskLeaseRenewal, StoreError> {
        validate_lease_renewal_request(&request)?;
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;

        let existing: Option<LeaseRenewalLedgerRow> = transaction
            .query_row(
                "SELECT renewal_id,workflow_id,task_id,attempt,owner_epoch,lease_id,worker_id,
                        lease_ttl_seconds,previous_expires_at,expires_at,renewed_at
                 FROM task_lease_renewals WHERE renewal_id=?1",
                params![request.renewal_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                        row.get(9)?,
                        row.get(10)?,
                    ))
                },
            )
            .optional()?;
        if let Some(row) = existing {
            let same_request = row.1 == request.workflow_id
                && row.2 == request.task_id
                && row.3 == request.attempt as i64
                && row.4 == request.owner_epoch as i64
                && row.5 == request.lease_id
                && row.6 == request.worker_id
                && row.7 == request.lease_ttl_seconds as i64;
            if !same_request {
                return Err(StoreError::LeaseRenewalConflict);
            }
            let timestamp = now();
            let current_owner: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM tasks WHERE workflow_id=?1 AND task_id=?2
                   AND state='RUNNING' AND attempts=?3 AND owner_epoch=?4
                   AND lease_id=?5 AND lease_owner=?6 AND lease_expires_at>?7)",
                params![
                    request.workflow_id,
                    request.task_id,
                    request.attempt as i64,
                    request.owner_epoch as i64,
                    request.lease_id,
                    request.worker_id,
                    timestamp
                ],
                |row| row.get(0),
            )?;
            if !current_owner {
                return Err(StoreError::LeaseFenced);
            }
            transaction.commit()?;
            return Ok(TaskLeaseRenewal {
                renewal_id: row.0,
                workflow_id: row.1,
                task_id: row.2,
                attempt: row.3 as u64,
                owner_epoch: row.4 as u64,
                lease_id: row.5,
                worker_id: row.6,
                previous_expires_at: row.8,
                expires_at: row.9,
                renewed_at: row.10,
            });
        }

        let current: Option<CurrentLeaseProjectionRow> = transaction
            .query_row(
                "SELECT state,attempts,owner_epoch,lease_id,lease_owner,lease_expires_at
                     FROM tasks WHERE workflow_id=?1 AND task_id=?2",
                params![request.workflow_id, request.task_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((state, attempt, owner_epoch, lease_id, worker_id, previous_expires_at)) = current
        else {
            return Err(StoreError::NotFound(format!("task {}", request.task_id)));
        };
        let timestamp = now();
        if state != "RUNNING"
            || attempt != request.attempt as i64
            || owner_epoch != request.owner_epoch as i64
            || lease_id.as_deref() != Some(request.lease_id.as_str())
            || worker_id.as_deref() != Some(request.worker_id.as_str())
            || previous_expires_at
                .as_deref()
                .is_none_or(|expiry| expiry <= timestamp.as_str())
        {
            return Err(StoreError::LeaseFenced);
        }
        let previous_expires_at = previous_expires_at.ok_or(StoreError::LeaseFenced)?;
        let renewed_at = timestamp;
        let expires_at = (Utc::now() + Duration::seconds(request.lease_ttl_seconds as i64))
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        if expires_at <= previous_expires_at {
            return Err(StoreError::LeaseFenced);
        }
        let changed = transaction.execute(
            "UPDATE tasks SET lease_expires_at=?1
             WHERE workflow_id=?2 AND task_id=?3 AND state='RUNNING'
               AND attempts=?4 AND owner_epoch=?5 AND lease_id=?6 AND lease_owner=?7
               AND lease_expires_at=?8 AND lease_expires_at>?9",
            params![
                expires_at,
                request.workflow_id,
                request.task_id,
                request.attempt as i64,
                request.owner_epoch as i64,
                request.lease_id,
                request.worker_id,
                previous_expires_at,
                renewed_at
            ],
        )?;
        if changed != 1 {
            return Err(StoreError::LeaseFenced);
        }
        transaction.execute(
            "INSERT INTO task_lease_renewals(
                renewal_id,workflow_id,task_id,attempt,owner_epoch,lease_id,worker_id,
                lease_ttl_seconds,previous_expires_at,expires_at,renewed_at
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                request.renewal_id,
                request.workflow_id,
                request.task_id,
                request.attempt as i64,
                request.owner_epoch as i64,
                request.lease_id,
                request.worker_id,
                request.lease_ttl_seconds as i64,
                previous_expires_at,
                expires_at,
                renewed_at
            ],
        )?;
        insert_event(
            &transaction,
            &request.workflow_id,
            Some(&request.task_id),
            "task.lease_renewed",
            &serde_json::json!({
                "renewalId":request.renewal_id,
                "leaseId":request.lease_id,
                "workerId":request.worker_id,
                "attempt":request.attempt,
                "ownerEpoch":request.owner_epoch,
                "previousExpiresAt":previous_expires_at,
                "expiresAt":expires_at,
                "leaseTtlSeconds":request.lease_ttl_seconds
            }),
            &format!("lease.renewal:{}", request.renewal_id),
            &renewed_at,
        )?;
        transaction.commit()?;
        Ok(TaskLeaseRenewal {
            renewal_id: request.renewal_id,
            workflow_id: request.workflow_id,
            task_id: request.task_id,
            lease_id: request.lease_id,
            worker_id: request.worker_id,
            attempt: request.attempt,
            owner_epoch: request.owner_epoch,
            previous_expires_at,
            expires_at,
            renewed_at,
        })
    }

    /// Reserve one exact external side effect while its lease is still live.
    ///
    /// The current lease/epoch/plan read, immutable fence insert and event
    /// append are one IMMEDIATE transaction. Both the idempotency key and the
    /// natural side-effect identity are unique in SQLite; a byte-equivalent
    /// replay returns the original durable receipt.
    pub fn reserve_worker_execution_fence(
        &self,
        request: WorkerExecutionFenceRequest,
    ) -> Result<WorkerExecutionFenceRecord, StoreError> {
        validate_worker_execution_fence_request(&request)?;
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let timestamp = now();
        verify_current_execution_fence_owner(&transaction, &request, &timestamp)?;

        let existing_id: Option<String> = transaction
            .query_row(
                "SELECT fence_id FROM worker_execution_fences WHERE idempotency_key=?1",
                params![request.idempotency_key],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(fence_id) = existing_id {
            let existing = load_worker_execution_fence(&transaction, &fence_id)?;
            if existing.request != request {
                return Err(StoreError::WorkerExecutionFenceConflict);
            }
            transaction.commit()?;
            return Ok(existing);
        }
        let existing_side_effect: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM worker_execution_fences
             WHERE workflow_id=?1 AND task_id=?2 AND attempt=?3 AND owner_epoch=?4
               AND kind=?5 AND side_effect_id=?6)",
            params![
                request.workflow_id,
                request.task_id,
                request.attempt as i64,
                request.owner_epoch as i64,
                request.kind.as_db(),
                request.side_effect_id
            ],
            |row| row.get(0),
        )?;
        if existing_side_effect {
            return Err(StoreError::WorkerExecutionFenceConflict);
        }

        let fence_id = format!("wfx_{}", Uuid::new_v4().simple());
        let receipt = serde_json::json!({
            "type":"worker_execution_fence_reservation",
            "fence_id":fence_id,
            "request_sha256":content_hash(&request)
                .map_err(|error| StoreError::Invariant(error.to_string()))?,
            "durable":true,
            "recorded_at":timestamp
        });
        let receipt_json = serde_json::to_string(&receipt)?;
        transaction.execute(
            "INSERT INTO worker_execution_fences(
               fence_id,claim_id,workflow_id,task_id,attempt,owner_epoch,lease_id,worker_id,
               plan_sha256,side_effect_id,kind,request_sha256,idempotency_key,acl_sha256,
               state,completion_json,completion_sha256,receipt_json,created_at,completed_at
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'RESERVED',NULL,NULL,?15,?16,NULL)",
            params![
                fence_id,request.claim_id,request.workflow_id,request.task_id,
                request.attempt as i64,request.owner_epoch as i64,request.lease_id,
                request.worker_id,request.plan_sha256,request.side_effect_id,
                request.kind.as_db(),request.request_sha256,request.idempotency_key,
                request.acl_sha256,receipt_json,timestamp
            ],
        )?;
        insert_event(
            &transaction,
            &request.workflow_id,
            Some(&request.task_id),
            "worker.execution_fence_reserved",
            &serde_json::json!({"fenceId":fence_id,"claimId":request.claim_id,
                "leaseId":request.lease_id,"ownerEpoch":request.owner_epoch,
                "sideEffectId":request.side_effect_id,"kind":request.kind,
                "requestSha256":request.request_sha256,"idempotencyKey":request.idempotency_key}),
            &format!("worker.execution_fence.reserved:{fence_id}"),
            &timestamp,
        )?;
        transaction.commit()?;
        Ok(WorkerExecutionFenceRecord {
            fence_id,
            request,
            state: "RESERVED".into(),
            completion: None,
            completion_sha256: None,
            receipt,
            created_at: timestamp,
            completed_at: None,
        })
    }

    /// Record one exact observation for a previously reserved side effect.
    ///
    /// UNKNOWN and unverified NOT_STARTED are observations, not terminal proof:
    /// they are appended to the workflow event chain while the fence remains
    /// RESERVED. This method records worker observations without authorizing
    /// terminal release.
    /// UNKNOWN always remains RESERVED. NOT_STARTED remains RESERVED when no
    /// proof verifier is supplied. SUCCEEDED/FAILED are rejected here; callers
    /// must use `complete_worker_execution_fence_verified` so terminal process
    /// or provider evidence is checked inside the same writer transaction.
    /// Each event ID is independently idempotent; historical exact replay
    /// returns its original receipt even after a later terminal observation.
    pub fn complete_worker_execution_fence(
        &self,
        completion: WorkerExecutionFenceCompletion,
    ) -> Result<WorkerExecutionFenceCompletionResult, StoreError> {
        self.complete_worker_execution_fence_inner(completion, None)
    }

    /// Record one exact observation and, when independently verified, release
    /// its reservation for SUCCEEDED, FAILED, or NOT_STARTED.
    pub fn complete_worker_execution_fence_verified(
        &self,
        completion: WorkerExecutionFenceCompletion,
        verifier: &dyn WorkerExecutionFenceCompletionVerifier,
    ) -> Result<WorkerExecutionFenceCompletionResult, StoreError> {
        self.complete_worker_execution_fence_inner(completion, Some(verifier))
    }

    fn complete_worker_execution_fence_inner(
        &self,
        completion: WorkerExecutionFenceCompletion,
        verifier: Option<&dyn WorkerExecutionFenceCompletionVerifier>,
    ) -> Result<WorkerExecutionFenceCompletionResult, StoreError> {
        validate_worker_execution_fence_completion(&completion)?;
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let mut fence = load_worker_execution_fence(&transaction, &completion.fence_id)?;
        if fence.request.claim_id != completion.claim_id
            || fence.request.workflow_id != completion.workflow_id
            || fence.request.task_id != completion.task_id
            || fence.request.attempt != completion.attempt
            || fence.request.lease_id != completion.lease_id
            || fence.request.worker_id != completion.worker_id
            || fence.request.owner_epoch != completion.owner_epoch
            || fence.request.plan_sha256 != completion.plan_sha256
            || fence.request.side_effect_id != completion.side_effect_id
            || fence.request.kind != completion.kind
            || fence.request.request_sha256 != completion.request_sha256
        {
            return Err(StoreError::WorkerExecutionFenceConflict);
        }

        let observation_key = format!(
            "worker.execution_fence.observation:{}:{}",
            completion.fence_id, completion.event_id
        );
        let existing_observation: Option<(String, Option<String>, String, String, String)> =
            transaction
                .query_row(
                    "SELECT event_id,task_id,event_type,payload_json,idempotency_key FROM events
                 WHERE workflow_id=?1 AND idempotency_key=?2",
                    params![completion.workflow_id, observation_key],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .optional()?;
        if let Some((event_row_id, task_id, event_type, payload_json, idempotency_key)) =
            existing_observation
        {
            let chain = verify_event_chain_connection(&transaction, &completion.workflow_id)?;
            if !chain.valid {
                return Err(StoreError::Invariant(format!(
                    "execution-fence replay event chain is invalid at sequence {:?}",
                    chain.failure_sequence
                )));
            }
            let payload: serde_json::Value = serde_json::from_str(&payload_json)?;
            let recorded_completion: WorkerExecutionFenceCompletion =
                serde_json::from_value(payload.get("completion").cloned().ok_or_else(|| {
                    StoreError::Invariant(
                        "execution-fence observation event omitted its completion".into(),
                    )
                })?)?;
            if recorded_completion != completion {
                return Err(StoreError::WorkerExecutionFenceConflict);
            }
            let completion_sha256 = payload
                .get("completion_sha256")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    StoreError::Invariant(
                        "execution-fence observation event omitted its completion digest".into(),
                    )
                })?
                .to_owned();
            let expected_completion_sha256 = content_hash(&completion)
                .map_err(|error| StoreError::Invariant(error.to_string()))?;
            if completion_sha256 != expected_completion_sha256 {
                return Err(StoreError::Invariant(
                    "execution-fence replay completion digest does not match its content".into(),
                ));
            }
            let receipt = payload.get("receipt").cloned().ok_or_else(|| {
                StoreError::Invariant(
                    "execution-fence observation event omitted its durable receipt".into(),
                )
            })?;
            let recorded_at = payload
                .get("recorded_at")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    StoreError::Invariant(
                        "execution-fence observation event omitted its timestamp".into(),
                    )
                })?
                .to_owned();
            let terminal = payload
                .get("terminal")
                .and_then(serde_json::Value::as_bool)
                .ok_or_else(|| {
                    StoreError::Invariant(
                        "execution-fence observation event omitted its terminal classification"
                            .into(),
                    )
                })?;
            let expected_event_type = if terminal {
                "worker.execution_fence_completed"
            } else {
                "worker.execution_fence_observed"
            };
            let expected_receipt = serde_json::json!({
                "type":"worker_execution_fence_observation",
                "fence_id":completion.fence_id,
                "event_id":completion.event_id,
                "event_sha256":completion.event_sha256,
                "outcome":completion.outcome,
                "completion_sha256":expected_completion_sha256,
                "durable":true,
                "recorded_at":recorded_at,
                "terminal":terminal
            });
            let expected_payload = serde_json::json!({
                "fenceId":completion.fence_id,
                "claimId":completion.claim_id,
                "ownerEpoch":completion.owner_epoch,
                "sideEffectId":completion.side_effect_id,
                "kind":completion.kind,
                "completion":completion,
                "completion_sha256":expected_completion_sha256,
                "receipt":expected_receipt,
                "recorded_at":recorded_at,
                "terminal":terminal
            });
            if event_row_id.trim().is_empty()
                || task_id.as_deref() != Some(completion.task_id.as_str())
                || idempotency_key != observation_key
                || event_type != expected_event_type
                || receipt != expected_receipt
                || payload != expected_payload
                || (terminal
                    && (fence.state != "COMPLETED"
                        || fence.completion.as_ref() != Some(&completion)
                        || fence.completion_sha256.as_deref()
                            != Some(expected_completion_sha256.as_str())
                        || fence.receipt != expected_receipt
                        || fence.completed_at.as_deref() != Some(recorded_at.as_str())))
            {
                return Err(StoreError::Invariant(
                    "execution-fence observation event, projection, or durable receipt is inconsistent".into(),
                ));
            }
            transaction.commit()?;
            return Ok(WorkerExecutionFenceCompletionResult {
                fence,
                completion,
                completion_sha256,
                receipt,
                recorded_at,
                terminal,
            });
        }
        if fence.state == "COMPLETED" {
            return Err(StoreError::WorkerExecutionFenceFinalized);
        }
        let owner: Option<(String, i64, i64)> = transaction
            .query_row(
                "SELECT state,attempts,owner_epoch FROM tasks WHERE workflow_id=?1 AND task_id=?2",
                params![completion.workflow_id, completion.task_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((state, attempt, owner_epoch)) = owner else {
            return Err(StoreError::NotFound(format!("task {}", completion.task_id)));
        };
        let historical_owner: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM task_attempts WHERE workflow_id=?1 AND task_id=?2
             AND attempt=?3 AND owner_epoch=?4 AND lease_id=?5 AND worker_id=?6)",
            params![
                completion.workflow_id,
                completion.task_id,
                completion.attempt as i64,
                completion.owner_epoch as i64,
                completion.lease_id,
                completion.worker_id
            ],
            |row| row.get(0),
        )?;
        // A provider dispatch may outlive the worker's local command result.
        // Its reservation remains the authority for that exact remote run and
        // is reconciled by ProviderPoller after the task attempt has already
        // recorded SUCCEEDED/FAILED. Terminal task states cannot be claimed
        // again, and the unchanged attempt/epoch plus historical lease owner
        // keeps this completion bound to the original execution. Other fence
        // kinds (especially sandbox_start) must complete before task result
        // publication and are not allowed this late-reconciliation path.
        let late_provider_reconciliation = fence.request.kind
            == WorkerExecutionFenceKind::ProviderDispatch
            && matches!(state.as_str(), "SUCCEEDED" | "FAILED");
        if !historical_owner
            || attempt != completion.attempt as i64
            || owner_epoch != completion.owner_epoch as i64
            || (!matches!(state.as_str(), "RUNNING" | "UNKNOWN") && !late_provider_reconciliation)
        {
            return Err(StoreError::LeaseFenced);
        }

        let terminal = match completion.outcome.as_str() {
            "SUCCEEDED" | "FAILED" => {
                let verifier = verifier
                    .ok_or(StoreError::WorkerExecutionFenceCompletionAuthorityUnavailable)?;
                verifier.verify_terminal_completion(&transaction, &fence, &completion)?;
                true
            }
            "NOT_STARTED" => {
                if let Some(verifier) = verifier {
                    verifier.verify_terminal_completion(&transaction, &fence, &completion)?;
                    true
                } else {
                    false
                }
            }
            "UNKNOWN" => false,
            _ => return Err(StoreError::WorkerExecutionFenceConflict),
        };
        let timestamp = now();
        let completion_json = serde_json::to_string(&completion)?;
        let completion_sha256 =
            content_hash(&completion).map_err(|error| StoreError::Invariant(error.to_string()))?;
        let receipt = serde_json::json!({
            "type":"worker_execution_fence_observation",
            "fence_id":completion.fence_id,
            "event_id":completion.event_id,
            "event_sha256":completion.event_sha256,
            "outcome":completion.outcome,
            "completion_sha256":completion_sha256,
            "durable":true,
            "recorded_at":timestamp,
            "terminal":terminal
        });
        let receipt_json = serde_json::to_string(&receipt)?;
        let event_payload = serde_json::json!({
            "fenceId":completion.fence_id,
            "claimId":completion.claim_id,
            "ownerEpoch":completion.owner_epoch,
            "sideEffectId":completion.side_effect_id,
            "kind":completion.kind,
            "completion":completion,
            "completion_sha256":completion_sha256,
            "receipt":receipt,
            "recorded_at":timestamp,
            "terminal":terminal
        });
        if terminal {
            let changed = transaction.execute(
                "UPDATE worker_execution_fences SET state='COMPLETED',completion_json=?1,
                   completion_sha256=?2,receipt_json=?3,completed_at=?4
                 WHERE fence_id=?5 AND state='RESERVED'",
                params![
                    completion_json,
                    completion_sha256,
                    receipt_json,
                    timestamp,
                    completion.fence_id
                ],
            )?;
            if changed != 1 {
                return Err(StoreError::WorkerExecutionFenceFinalized);
            }
        }
        insert_event(
            &transaction,
            &completion.workflow_id,
            Some(&completion.task_id),
            if terminal {
                "worker.execution_fence_completed"
            } else {
                "worker.execution_fence_observed"
            },
            &event_payload,
            &observation_key,
            &timestamp,
        )?;
        transaction.commit()?;
        if terminal {
            fence.state = "COMPLETED".into();
            fence.completion = Some(completion.clone());
            fence.completion_sha256 = Some(completion_sha256.clone());
            fence.receipt = receipt.clone();
            fence.completed_at = Some(timestamp.clone());
        }
        Ok(WorkerExecutionFenceCompletionResult {
            fence,
            completion,
            completion_sha256,
            receipt,
            recorded_at: timestamp,
            terminal,
        })
    }

    /// Run one atomic coordinator scheduling tick and claim at most one task.
    ///
    /// Candidate selection, current approval revalidation, global/per-workflow
    /// concurrency checks, dependency checks, lease fencing, attempt ledger,
    /// workflow transition and event append share one IMMEDIATE transaction.
    /// Fairness is oldest-updated workflow first; claiming updates its timestamp
    /// so other eligible workflows receive turns before it is selected again.
    /// This does not dispatch or invoke an execution worker.
    pub fn coordinator_claim_next(
        &self,
        request: CoordinatorRequest,
        verifier: &dyn ApprovalVerifier,
        worker_verifier: &dyn CoordinatorWorkerVerifier,
    ) -> Result<Option<TaskLease>, StoreError> {
        if request.worker_id.trim().is_empty()
            || !(1..=600).contains(&request.lease_ttl_seconds)
            || !(1..=500).contains(&request.max_parallel)
            || !(1..=500).contains(&request.max_parallel_per_workflow)
            || request.max_parallel_per_workflow > request.max_parallel
        {
            return Err(StoreError::Invariant(
                "invalid coordinator identity, lease TTL or concurrency limits".into(),
            ));
        }
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let worker_id = worker_verifier.authenticate_worker(&transaction, &request.worker_id)?;
        if worker_id.trim().is_empty() {
            return Err(StoreError::InvalidVerifierOutput);
        }
        let active: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM tasks WHERE state='RUNNING'",
            [],
            |row| row.get(0),
        )?;
        if active >= request.max_parallel as i64 {
            transaction.commit()?;
            return Ok(None);
        }
        let mut statement = transaction.prepare(
            "SELECT t.workflow_id,t.task_id FROM tasks t JOIN workflows w ON w.workflow_id=t.workflow_id
             WHERE t.state='PENDING' AND w.state IN ('APPROVED','EXECUTING')
               AND w.cancellation_requested_at IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM json_each(t.definition_json,'$.depends_on') d
                 LEFT JOIN tasks p ON p.workflow_id=t.workflow_id AND p.task_id=d.value
                 WHERE p.state IS NULL OR p.state!='SUCCEEDED'
               )
               AND (SELECT COUNT(*) FROM tasks running WHERE running.workflow_id=t.workflow_id AND running.state='RUNNING') < ?1
             ORDER BY w.updated_at ASC,w.workflow_id ASC,t.ordinal ASC,t.task_id ASC"
        )?;
        let candidates = statement
            .query_map(params![request.max_parallel_per_workflow as i64], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        for (workflow_id, task_id) in candidates {
            let workflow = load_workflow_from(&transaction, &workflow_id)?;
            verify_current_approval(&transaction, &workflow, verifier)?;
            if workflow.cancellation_request.is_some()
                || !matches!(
                    workflow.state,
                    WorkflowState::Approved | WorkflowState::Executing
                )
            {
                continue;
            }
            let task = workflow
                .tasks
                .iter()
                .find(|task| task.definition.task_id == task_id)
                .ok_or_else(|| {
                    StoreError::Invariant(
                        "coordinator candidate disappeared from workflow projection".into(),
                    )
                })?;
            if task.state != TaskState::Pending
                || task.definition.depends_on.iter().any(|dependency| {
                    workflow
                        .tasks
                        .iter()
                        .find(|candidate| candidate.definition.task_id == *dependency)
                        .is_none_or(|candidate| candidate.state != TaskState::Succeeded)
                })
            {
                continue;
            }
            let attempt = task
                .attempts
                .checked_add(1)
                .ok_or_else(|| StoreError::Invariant("task attempt counter overflow".into()))?;
            if attempt > i64::MAX as u64 {
                return Err(StoreError::InvalidAttempt);
            }
            let previous_epoch: i64 = transaction.query_row(
                "SELECT owner_epoch FROM tasks WHERE workflow_id=?1 AND task_id=?2",
                params![workflow_id, task_id],
                |row| row.get(0),
            )?;
            let owner_epoch = u64::try_from(previous_epoch)
                .map_err(|_| StoreError::Invariant("negative lease owner epoch".into()))?
                .checked_add(1)
                .filter(|epoch| *epoch <= i64::MAX as u64)
                .ok_or_else(|| StoreError::Invariant("lease owner epoch overflow".into()))?;
            let lease_id = format!("lease_{}", Uuid::new_v4().simple());
            let expires_at = (Utc::now() + Duration::seconds(request.lease_ttl_seconds as i64))
                .to_rfc3339_opts(SecondsFormat::Millis, true);
            let timestamp = now();
            let changed = transaction.execute(
                "UPDATE tasks SET state='RUNNING',attempts=?1,owner_epoch=?2,lease_id=?3,lease_owner=?4,lease_expires_at=?5
                 WHERE workflow_id=?6 AND task_id=?7 AND state='PENDING' AND attempts=?8 AND owner_epoch=?9",
                params![attempt as i64,owner_epoch as i64,lease_id,worker_id,expires_at,workflow_id,task_id,task.attempts as i64,previous_epoch])?;
            if changed != 1 {
                return Err(StoreError::LeaseFenced);
            }
            transaction.execute(
                "INSERT INTO task_attempts(workflow_id,task_id,attempt,owner_epoch,lease_id,worker_id,lease_expires_at,claimed_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![workflow_id,task_id,attempt as i64,owner_epoch as i64,lease_id,worker_id,expires_at,timestamp])?;
            if workflow.state == WorkflowState::Approved {
                let changed = transaction.execute(
                    "UPDATE workflows SET state='EXECUTING',updated_at=?1 WHERE workflow_id=?2 AND state='APPROVED' AND plan_sha256=?3",
                    params![timestamp,workflow_id,workflow.plan_hash])?;
                if changed != 1 {
                    return Err(StoreError::LeaseFenced);
                }
            } else {
                transaction.execute(
                    "UPDATE workflows SET updated_at=?1 WHERE workflow_id=?2 AND state='EXECUTING'",
                    params![timestamp, workflow_id],
                )?;
            }
            insert_event(
                &transaction,
                &workflow_id,
                Some(&task_id),
                "task.claimed",
                &serde_json::json!({"leaseId":lease_id,"workerId":worker_id,"attempt":attempt,"ownerEpoch":owner_epoch,"expiresAt":expires_at,"coordinator":true}),
                &format!("claim:{task_id}:{attempt}"),
                &timestamp,
            )?;
            transaction.commit()?;
            return Ok(Some(TaskLease {
                workflow_id,
                task_id,
                lease_id,
                worker_id,
                attempt,
                owner_epoch,
                expires_at,
            }));
        }
        transaction.commit()?;
        Ok(None)
    }

    /// Record a task outcome, subject to exact lease fencing and evidence contract.
    pub fn record_task_result(
        &self,
        workflow_id: &str,
        task_id: &str,
        request: TaskResultRequest,
    ) -> Result<WorkflowView, StoreError> {
        self.record_task_result_inner(workflow_id, task_id, request, None, None)
    }

    /// Record a result only after a host-owned producer verifier authenticates it.
    pub fn record_task_result_authenticated(
        &self,
        workflow_id: &str,
        task_id: &str,
        request: TaskResultRequest,
        verifier: &dyn TaskResultProducerVerifier,
    ) -> Result<WorkflowView, StoreError> {
        self.record_task_result_inner(workflow_id, task_id, request, Some(verifier), None)
    }

    /// Ingest an immutable, host-authenticated producer envelope and persist it atomically
    /// with the task result, attempt ledger, and workflow event journal.
    pub fn record_task_result_envelope(
        &self,
        workflow_id: &str,
        task_id: &str,
        envelope: TaskResultEnvelope,
        verifier: &dyn TaskResultProducerVerifier,
    ) -> Result<WorkflowView, StoreError> {
        self.record_task_result_inner(
            workflow_id,
            task_id,
            envelope.request.clone(),
            Some(verifier),
            Some(&envelope),
        )
    }

    fn record_task_result_inner(
        &self,
        workflow_id: &str,
        task_id: &str,
        mut request: TaskResultRequest,
        verifier: Option<&dyn TaskResultProducerVerifier>,
        envelope: Option<&TaskResultEnvelope>,
    ) -> Result<WorkflowView, StoreError> {
        if request.attempt == 0 || request.attempt > i64::MAX as u64 {
            return Err(StoreError::InvalidAttempt);
        }
        if request.outcome == TaskOutcome::Succeeded && request.evidence.is_empty() {
            return Err(StoreError::InvalidEvidence(
                "successful result requires at least one evidence reference".into(),
            ));
        }
        if matches!(request.outcome, TaskOutcome::Failed | TaskOutcome::Unknown)
            && request.error.as_deref().is_none_or(str::is_empty)
        {
            return Err(StoreError::InvalidEvidence(
                "failed/unknown result requires a diagnostic".into(),
            ));
        }
        for evidence in &request.evidence {
            evidence
                .validate_for(task_id, request.attempt)
                .map_err(|error| StoreError::InvalidEvidence(error.to_string()))?;
        }
        let timestamp = now();
        let result = TaskResult {
            attempt: request.attempt,
            outcome: request.outcome,
            evidence: request.evidence.clone(),
            error: request.error.clone(),
            recorded_at: timestamp.clone(),
        };
        let result_json = serde_json::to_string(&result)?;
        let envelope_payload = if let Some(envelope) = envelope {
            if envelope.event_id.trim().is_empty()
                || envelope.event_id.trim() != envelope.event_id
                || envelope.event_id.len() > 128
            {
                return Err(StoreError::ResultEnvelopeRejected(
                    "event_id must be 1 to 128 non-whitespace characters".into(),
                ));
            }
            if envelope.producer_id.trim().is_empty()
                || envelope.producer_id.trim() != envelope.producer_id
                || envelope.producer_id.len() > 200
            {
                return Err(StoreError::ResultEnvelopeRejected(
                    "producer_id is invalid".into(),
                ));
            }
            let payload = serde_json::json!({
                "workflow_id":workflow_id,"task_id":task_id,"event_id":envelope.event_id,
                "producer_id":envelope.producer_id,"request":envelope.request
            });
            let digest =
                content_hash(&payload).map_err(|error| StoreError::Invariant(error.to_string()))?;
            if envelope.payload_sha256.len() != 64 || envelope.payload_sha256 != digest {
                return Err(StoreError::ResultEnvelopeRejected(
                    "payload_sha256 does not match canonical envelope bytes".into(),
                ));
            }
            Some((payload, digest))
        } else {
            None
        };
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let mut verified_envelope: Option<VerifiedTaskResultProducer> = None;
        if let (Some(envelope), Some((payload, payload_digest))) =
            (envelope, envelope_payload.as_ref())
        {
            // Authenticate every delivery, including duplicate acknowledgements.
            // Idempotency must not become an unauthenticated read/projection path.
            let verifier = verifier.ok_or(StoreError::ApprovalAuthorityUnavailable)?;
            let verified =
                verifier.authenticate_envelope(&transaction, workflow_id, task_id, envelope)?;
            if verified.worker_id.trim().is_empty()
                || verified.producer_id != envelope.producer_id
                || verified.provenance_sha256.len() != 64
                || !verified
                    .provenance_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            {
                return Err(StoreError::InvalidVerifierOutput);
            }
            request.worker_id = verified.worker_id.clone();
            verified_envelope = Some(verified.clone());

            type ExistingInboxEvent = (
                String,
                String,
                String,
                i64,
                String,
                String,
                String,
                String,
                String,
            );
            let existing: Option<ExistingInboxEvent> = transaction.query_row(
                "SELECT workflow_id,task_id,producer_id,attempt,payload_sha256,provenance_sha256,plan_sha256,payload_json,state FROM workflow_result_inbox WHERE event_id=?1",
                params![envelope.event_id],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?)),
            ).optional()?;
            if let Some((
                stored_workflow,
                stored_task,
                stored_producer,
                stored_attempt,
                stored_digest,
                stored_provenance,
                stored_plan_sha256,
                stored_payload_json,
                stored_state,
            )) = existing
            {
                let current_plan_sha256: String = transaction.query_row(
                    "SELECT plan_sha256 FROM workflows WHERE workflow_id=?1",
                    params![workflow_id],
                    |row| row.get(0),
                )?;
                let attempt_owner: Option<(String, String)> = transaction.query_row(
                    "SELECT lease_id,worker_id FROM task_attempts WHERE workflow_id=?1 AND task_id=?2 AND attempt=?3",
                    params![workflow_id, task_id, request.attempt as i64],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                ).optional()?;
                let durable_result: Option<(String, String, String, String, String)> = transaction
                    .query_row(
                        "SELECT t.state,t.result_json,r.result_sha256,r.outcome,r.recorded_at FROM tasks t JOIN task_attempt_results r ON r.workflow_id=t.workflow_id AND r.task_id=t.task_id AND r.attempt=?3 WHERE t.workflow_id=?1 AND t.task_id=?2",
                        params![workflow_id, task_id, request.attempt as i64],
                        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
                    )
                    .optional()?;
                let result_event: Option<(String, String)> = transaction
                    .query_row(
                        "SELECT event_type,payload_json FROM events WHERE workflow_id=?1 AND task_id=?2 AND idempotency_key=?3",
                        params![workflow_id, task_id, format!("result:{task_id}:{}", request.attempt)],
                        |row| Ok((row.get(0)?,row.get(1)?)),
                    )
                    .optional()?;
                let expected_result_state = request.outcome.task_state().as_db();
                let expected_result_event_type = match request.outcome {
                    TaskOutcome::Succeeded => "task.succeeded",
                    TaskOutcome::Failed => "task.failed",
                    TaskOutcome::Unknown => "task.outcome_unknown",
                };
                let durable_result_matches = durable_result.as_ref().is_some_and(
                    |(task_state, result_json, result_sha256, result_outcome, recorded_at)| {
                        serde_json::from_str::<TaskResult>(result_json).is_ok_and(|stored| {
                            task_state == expected_result_state
                                && result_outcome == expected_result_state
                                && stored.attempt == request.attempt
                                && stored.outcome == request.outcome
                                && stored.evidence == request.evidence
                                && stored.error == request.error
                                && stored.recorded_at == *recorded_at
                                && content_hash(&stored)
                                    .is_ok_and(|digest| digest == *result_sha256)
                                && result_event.as_ref().is_some_and(|(event_type, payload)| {
                                    event_type == expected_result_event_type
                                        && payload == result_json
                                })
                        })
                    },
                );
                let expected_journal_payload = serde_json::json!({
                    "event_id":envelope.event_id,
                    "producer_id":verified.producer_id,
                    "provenance_sha256":verified.provenance_sha256,
                    "payload_sha256":payload_digest,
                    "attempt":request.attempt
                });
                let journal_event: Option<(String, Option<String>, String)> = transaction
                    .query_row(
                        "SELECT event_type,task_id,payload_json FROM events WHERE workflow_id=?1 AND idempotency_key=?2",
                        params![workflow_id, format!("result-inbox:{}", envelope.event_id)],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()?;
                let journal_matches = journal_event.as_ref().is_some_and(
                    |(event_type, event_task_id, payload_json)| {
                        event_type == "task.result_envelope_ingested"
                            && event_task_id.as_deref() == Some(task_id)
                            && serde_json::from_str::<serde_json::Value>(payload_json)
                                .is_ok_and(|payload| payload == expected_journal_payload)
                    },
                );
                let journal_integrity = verify_event_chain_connection(&transaction, workflow_id)?;
                let stored_payload_matches = serde_json::from_str::<serde_json::Value>(
                    &stored_payload_json,
                )
                .is_ok_and(|stored_payload| {
                    stored_payload == *payload
                        && content_hash(&stored_payload)
                            .is_ok_and(|digest| digest == *payload_digest)
                });
                if stored_workflow == workflow_id
                    && stored_task == task_id
                    && stored_producer == envelope.producer_id
                    && stored_attempt == request.attempt as i64
                    && stored_digest == *payload_digest
                    && stored_provenance == verified.provenance_sha256
                    && stored_plan_sha256 == current_plan_sha256
                    && stored_state == "COMMITTED"
                    && stored_payload_matches
                    && attempt_owner.as_ref().is_some_and(|(lease_id, worker_id)| {
                        lease_id == &request.lease_id && worker_id == &verified.worker_id
                    })
                    && durable_result_matches
                    && journal_matches
                    && journal_integrity.valid
                {
                    transaction.commit()?;
                    drop(connection);
                    return self.get_workflow(workflow_id);
                }
                return Err(StoreError::ResultEnvelopeRejected(
                    "event_id was already used for a different payload or binding".into(),
                ));
            }
            let prior_attempt: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM workflow_result_inbox WHERE workflow_id=?1 AND task_id=?2 AND attempt=?3)",
                params![workflow_id,task_id,request.attempt as i64],
                |row| row.get(0),
            )?;
            if prior_attempt {
                return Err(StoreError::ResultEnvelopeRejected(
                    "workflow/task/attempt already has a different inbox event".into(),
                ));
            }
            let _ = payload;
        } else if let Some(verifier) = verifier {
            let canonical_worker =
                verifier.authenticate_producer(&transaction, workflow_id, task_id, &request)?;
            if canonical_worker.trim().is_empty() {
                return Err(StoreError::InvalidVerifierOutput);
            }
            request.worker_id = canonical_worker;
        }
        let task = transaction.query_row(
            "SELECT definition_json,state,attempts,lease_id,lease_owner,lease_expires_at,result_json FROM tasks WHERE workflow_id=?1 AND task_id=?2",
            params![workflow_id, task_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(5)?, row.get::<_, Option<String>>(6)?)),
        ).optional()?.ok_or_else(|| StoreError::NotFound(format!("task {task_id}")))?;
        let definition: TaskSpec = serde_json::from_str(&task.0)?;
        if request.outcome == TaskOutcome::Succeeded {
            for required_kind in &definition.required_evidence {
                if !request
                    .evidence
                    .iter()
                    .any(|evidence| &evidence.kind == required_kind)
                {
                    return Err(StoreError::InvalidEvidence(format!(
                        "successful task is missing required evidence kind {required_kind}"
                    )));
                }
            }
        }
        // A byte-equivalent semantic result for an already-recorded attempt is
        // an idempotent acknowledgement. Conflicting replay remains fenced.
        if task.1 != "RUNNING" {
            if envelope.is_some() {
                return Err(StoreError::ResultEnvelopeRejected(
                    "a different event cannot replay an already recorded attempt".into(),
                ));
            }
            if let Some(existing_json) = task.6.as_deref() {
                let existing: TaskResult = serde_json::from_str(existing_json)?;
                let attempt_row: Option<(String, String)> = transaction
                    .query_row(
                        "SELECT lease_id,worker_id FROM task_attempts WHERE workflow_id=?1 AND task_id=?2 AND attempt=?3",
                        params![workflow_id, task_id, request.attempt as i64],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                let same_attempt_owner = attempt_row.as_ref().is_some_and(|(lease, worker)| {
                    lease == &request.lease_id && worker == &request.worker_id
                });
                let same_result = existing.attempt == result.attempt
                    && existing.outcome == result.outcome
                    && existing.evidence == result.evidence
                    && existing.error == result.error;
                if task.2 == request.attempt as i64 && same_attempt_owner && same_result {
                    transaction.commit()?;
                    drop(connection);
                    return self.get_workflow(workflow_id);
                }
            }
            return Err(StoreError::LeaseFenced);
        }
        if task.1 != "RUNNING"
            || task.2 != request.attempt as i64
            || task.3.as_deref() != Some(request.lease_id.as_str())
            || task.4.as_deref() != Some(request.worker_id.as_str())
            || task
                .5
                .as_deref()
                .is_none_or(|expiry| expiry <= timestamp.as_str())
        {
            return Err(StoreError::LeaseFenced);
        }
        let next_state = request.outcome.task_state().as_db();
        let changed = transaction.execute(
            "UPDATE tasks SET state=?1,lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,result_json=?2 WHERE task_id=?3 AND workflow_id=?4 AND state='RUNNING' AND attempts=?5 AND lease_id=?6 AND lease_owner=?7",
            params![next_state, result_json, task_id, workflow_id, request.attempt as i64, request.lease_id, request.worker_id],
        )?;
        if changed != 1 {
            return Err(StoreError::LeaseFenced);
        }
        let event_type = match request.outcome {
            TaskOutcome::Succeeded => "task.succeeded",
            TaskOutcome::Failed => "task.failed",
            TaskOutcome::Unknown => "task.outcome_unknown",
        };
        insert_event(
            &transaction,
            workflow_id,
            Some(task_id),
            event_type,
            &result,
            &format!("result:{task_id}:{}", request.attempt),
            &timestamp,
        )?;
        let attempt_row: Option<(String, String)> = transaction
            .query_row(
                "SELECT lease_id,worker_id FROM task_attempts WHERE workflow_id=?1 AND task_id=?2 AND attempt=?3",
                params![workflow_id, task_id, request.attempt as i64],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if attempt_row.as_ref().is_none_or(|(lease, worker)| {
            lease != &request.lease_id || worker != &request.worker_id
        }) {
            return Err(StoreError::LeaseFenced);
        }
        let result_hash =
            content_hash(&result).map_err(|error| StoreError::Invariant(error.to_string()))?;
        transaction.execute(
            "INSERT INTO task_attempt_results(workflow_id,task_id,attempt,result_sha256,outcome,recorded_at) VALUES(?1,?2,?3,?4,?5,?6)",
            params![workflow_id, task_id, request.attempt as i64, result_hash, next_state, timestamp],
        )?;
        if let (Some(envelope), Some((payload, payload_digest))) =
            (envelope, envelope_payload.as_ref())
        {
            let verified = verified_envelope
                .as_ref()
                .ok_or(StoreError::InvalidVerifierOutput)?;
            let plan_sha256: String = transaction.query_row(
                "SELECT plan_sha256 FROM workflows WHERE workflow_id=?1",
                params![workflow_id],
                |row| row.get(0),
            )?;
            transaction.execute(
                "INSERT INTO workflow_result_inbox(event_id,workflow_id,plan_sha256,task_id,attempt,producer_id,provenance_sha256,payload_sha256,payload_json,state,recorded_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'COMMITTED',?10)",
                params![envelope.event_id,workflow_id,plan_sha256,task_id,request.attempt as i64,verified.producer_id,verified.provenance_sha256,payload_digest,serde_json::to_string(payload)?,timestamp],
            )?;
            insert_event(
                &transaction,
                workflow_id,
                Some(task_id),
                "task.result_envelope_ingested",
                &serde_json::json!({"event_id":envelope.event_id,"producer_id":verified.producer_id,"provenance_sha256":verified.provenance_sha256,"payload_sha256":payload_digest,"attempt":request.attempt}),
                &format!("result-inbox:{}", envelope.event_id),
                &timestamp,
            )?;
        }

        let cancellation_pending: bool = transaction.query_row(
            "SELECT cancellation_requested_at IS NOT NULL FROM workflows WHERE workflow_id=?1",
            params![workflow_id],
            |row| row.get(0),
        )?;
        if request.outcome == TaskOutcome::Failed && !cancellation_pending {
            transaction.execute("UPDATE workflows SET state='FAILED',updated_at=?1 WHERE workflow_id=?2 AND state='EXECUTING' AND cancellation_requested_at IS NULL", params![timestamp, workflow_id])?;
        } else if request.outcome == TaskOutcome::Succeeded && !cancellation_pending {
            let unfinished: i64 = transaction.query_row(
                "SELECT COUNT(*) FROM tasks WHERE workflow_id=?1 AND state!='SUCCEEDED'",
                params![workflow_id],
                |row| row.get(0),
            )?;
            if unfinished == 0 {
                let policy_count: i64 = transaction.query_row(
                    "SELECT COUNT(*) FROM workflow_policy_attachments WHERE workflow_id=?1",
                    params![workflow_id],
                    |row| row.get(0),
                )?;
                if policy_count == 0 {
                    transaction.execute("UPDATE workflows SET state='COMPLETED',updated_at=?1 WHERE workflow_id=?2 AND state='EXECUTING'", params![timestamp, workflow_id])?;
                } else {
                    let plan_sha256: String = transaction.query_row(
                        "SELECT plan_sha256 FROM workflows WHERE workflow_id=?1",
                        params![workflow_id],
                        |row| row.get(0),
                    )?;
                    verify_workflow_success_contract(
                        &transaction,
                        workflow_id,
                        Some(&plan_sha256),
                        true,
                    )?;
                    let evaluation =
                        evaluate_persisted_success_contract(&transaction, workflow_id)?;
                    let outcome = evaluation
                        .get("outcome")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("UNRESOLVED");
                    let event_type = match outcome {
                        "PASSED" => "workflow.success_contract_passed",
                        "FAILED" => "workflow.success_contract_failed",
                        _ => "workflow.success_contract_unresolved",
                    };
                    let evaluation_sha256 = content_hash(&evaluation)
                        .map_err(|error| StoreError::Invariant(error.to_string()))?;
                    let contract_version: i64 = transaction.query_row(
                        "SELECT MAX(version) FROM workflow_success_contracts WHERE workflow_id=?1",
                        params![workflow_id],
                        |row| row.get(0),
                    )?;
                    insert_event(
                        &transaction,
                        workflow_id,
                        None,
                        event_type,
                        &serde_json::json!({"contract_version":contract_version,"contract_sha256":evaluation.get("contract_sha256"),"plan_sha256":plan_sha256,"evaluation_sha256":evaluation_sha256,"evaluation":evaluation}),
                        &format!("success-contract:{contract_version}:{evaluation_sha256}"),
                        &timestamp,
                    )?;
                    if outcome == "PASSED" {
                        transaction.execute("UPDATE workflows SET state='COMPLETED',updated_at=?1 WHERE workflow_id=?2 AND state='EXECUTING'", params![timestamp, workflow_id])?;
                    } else if outcome == "FAILED" {
                        transaction.execute("UPDATE workflows SET state='FAILED',updated_at=?1 WHERE workflow_id=?2 AND state='EXECUTING'", params![timestamp, workflow_id])?;
                    }
                }
            }
        }
        transaction.commit()?;
        drop(connection);
        self.get_workflow(workflow_id)
    }

    /// Quarantine expired leases as unknown outcomes without automatic replay.
    pub fn quarantine_expired_leases(&self) -> Result<usize, StoreError> {
        let timestamp = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let mut statement = transaction.prepare(
            "SELECT workflow_id,task_id,attempts,lease_id,lease_owner FROM tasks WHERE state='RUNNING' AND lease_expires_at<=?1 ORDER BY workflow_id,task_id",
        )?;
        let rows = statement
            .query_map(params![timestamp], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        for (workflow_id, task_id, attempt, lease_id, worker_id) in &rows {
            let result = TaskResult {
                attempt: *attempt as u64,
                outcome: TaskOutcome::Unknown,
                evidence: vec![],
                error: Some(
                    "lease expired; worker/provider outcome not independently established".into(),
                ),
                recorded_at: timestamp.clone(),
            };
            transaction.execute(
                "UPDATE tasks SET state='UNKNOWN',lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,result_json=?1 WHERE workflow_id=?2 AND task_id=?3 AND state='RUNNING' AND attempts=?4 AND lease_id IS ?5 AND lease_owner IS ?6",
                params![serde_json::to_string(&result)?, workflow_id, task_id, attempt, lease_id, worker_id],
            )?;
            insert_event(
                &transaction,
                workflow_id,
                Some(task_id),
                "task.lease_expired_quarantined",
                &serde_json::json!({
                    "attempt": attempt,
                    "previousLeaseId": lease_id,
                    "previousWorkerId": worker_id,
                    "outcome": "UNKNOWN",
                    "replayAllowed": false
                }),
                &format!("lease-expired:{task_id}:{attempt}"),
                &timestamp,
            )?;
        }
        transaction.commit()?;
        Ok(rows.len())
    }

    /// Read a workflow and validate all typed durable records while decoding them.
    pub fn get_workflow(&self, workflow_id: &str) -> Result<WorkflowView, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        load_workflow_from(&connection, workflow_id)
    }

    /// List active workflows in most-recently-updated order without mutating state.
    pub fn list_active_workflows(&self, limit: usize) -> Result<Vec<WorkflowView>, StoreError> {
        if !(1..=100).contains(&limit) {
            return Err(StoreError::Invariant(
                "workflow list limit must be within 1..=100".into(),
            ));
        }
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT workflow_id FROM workflows WHERE state IN ('PROPOSED','APPROVED','EXECUTING') ORDER BY updated_at DESC,workflow_id LIMIT ?1",
        )?;
        let ids = statement
            .query_map(params![limit as i64], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.iter()
            .map(|id| load_workflow_from(&connection, id))
            .collect()
    }

    /// List dependency-ready pending tasks for approved/executing workflows.
    /// This is a read-only scheduling projection; it never claims or dispatches work.
    pub fn list_ready_tasks(&self, limit: u64) -> Result<Vec<ReadyTask>, StoreError> {
        let limit = i64::try_from(limit.clamp(1, 500)).unwrap_or(500);
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT t.workflow_id,t.task_id,t.ordinal,t.definition_json,w.plan_sha256,w.state
             FROM tasks t JOIN workflows w ON w.workflow_id=t.workflow_id
             WHERE t.state='PENDING' AND w.state IN ('APPROVED','EXECUTING')
               AND w.cancellation_requested_at IS NULL
               AND w.plan_sha256 IS NOT NULL
               AND NOT EXISTS(
                 SELECT 1 FROM json_each(t.definition_json,'$.depends_on') dependency
                 LEFT JOIN tasks predecessor ON predecessor.workflow_id=t.workflow_id AND predecessor.task_id=dependency.value
                 WHERE predecessor.state IS NULL OR predecessor.state!='SUCCEEDED'
               )
             ORDER BY w.updated_at,t.ordinal,t.task_id LIMIT ?1",
        )?;
        let rows = statement.query_map(params![limit], |row| {
            let ordinal: i64 = row.get(2)?;
            let definition_json: String = row.get(3)?;
            let definition = serde_json::from_str(&definition_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    3,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            let state: String = row.get(5)?;
            let workflow_state = parse_workflow_state(&state).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    5,
                    rusqlite::types::Type::Text,
                    Box::new(std::io::Error::other(error.to_string())),
                )
            })?;
            Ok(ReadyTask {
                workflow_id: row.get(0)?,
                task_id: row.get(1)?,
                ordinal: u64::try_from(ordinal).unwrap_or(0),
                definition,
                plan_sha256: row.get(4)?,
                workflow_state,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::Sqlite)
    }

    /// Read a bounded chronological slice of the append-only workflow event journal.
    pub fn list_workflow_events(
        &self,
        workflow_id: &str,
        limit: usize,
    ) -> Result<Vec<WorkflowEvent>, StoreError> {
        if !(1..=500).contains(&limit) {
            return Err(StoreError::Invariant(
                "workflow event limit must be within 1..=500".into(),
            ));
        }
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM workflows WHERE workflow_id=?1)",
            params![workflow_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(StoreError::NotFound(format!("workflow {workflow_id}")));
        }
        let mut statement = connection.prepare(
            "SELECT event_seq,event_id,task_id,event_type,payload_json,created_at,event_prev_hash,event_hash FROM events WHERE workflow_id=?1 ORDER BY event_seq DESC LIMIT ?2",
        )?;
        let rows = statement.query_map(params![workflow_id, limit as i64], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
            ))
        })?;
        let mut events = rows
            .map(|row| {
                let (
                    sequence,
                    event_id,
                    task_id,
                    event_type,
                    payload_json,
                    created_at,
                    previous_sha256,
                    sha256,
                ) = row?;
                Ok(WorkflowEvent {
                    sequence: u64::try_from(sequence).map_err(|_| {
                        StoreError::Invariant("negative workflow event sequence".into())
                    })?,
                    event_id,
                    task_id,
                    event_type,
                    payload: serde_json::from_str(&payload_json)?,
                    created_at,
                    previous_sha256,
                    sha256,
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        events.reverse();
        Ok(events)
    }

    /// Create an empty graph. Graph IDs are unique within the Rust-owned database.
    pub fn create_graph(&self, graph_id: &str) -> Result<GraphInfo, StoreError> {
        if graph_id.trim().is_empty()
            || !graph_id.starts_with("graph_")
            || graph_id.len() <= 6
            || graph_id.len() > 128
            || !graph_id[6..]
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            return Err(StoreError::Invariant(
                "graph_id must use graph_ prefix and URL-safe ASCII suffix".into(),
            ));
        }
        let timestamp = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        transaction.execute(
            "INSERT INTO graphs(graph_id,revision,created_at,updated_at) VALUES(?1,0,?2,?2)",
            params![graph_id, timestamp],
        )?;
        transaction.commit()?;
        drop(connection);
        self.get_graph_info(graph_id)
    }

    /// Read graph head metadata without loading the full snapshot.
    pub fn get_graph_info(&self, graph_id: &str) -> Result<GraphInfo, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        load_graph_info_from(&connection, graph_id)
    }

    /// Append a node revision using optimistic revision fencing and previous-digest linkage.
    pub fn append_graph_node_revision(
        &self,
        graph_id: &str,
        node: GraphNodeRevision,
    ) -> Result<GraphInfo, StoreError> {
        node.validate()
            .map_err(|error| StoreError::Invariant(error.to_string()))?;
        if node.revision > i64::MAX as u64 {
            return Err(StoreError::InvalidAttempt);
        }
        let revision_hash =
            content_hash(&node).map_err(|error| StoreError::Invariant(error.to_string()))?;
        let revision_json = serde_json::to_string(&node)?;
        let kind = serde_json::to_value(node.kind)?
            .as_str()
            .ok_or_else(|| StoreError::Invariant("graph node kind serialization failed".into()))?
            .to_owned();
        let timestamp = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let graph_exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM graphs WHERE graph_id=?1)",
            params![graph_id],
            |row| row.get(0),
        )?;
        if !graph_exists {
            return Err(StoreError::NotFound(format!("graph {graph_id}")));
        }
        transaction.execute(
            "INSERT OR IGNORE INTO graph_nodes(graph_id,node_id,kind,current_revision,current_revision_sha256) VALUES(?1,?2,?3,0,NULL)",
            params![graph_id, node.node_id, kind],
        )?;
        let current: (String, i64, Option<String>) = transaction.query_row(
            "SELECT kind,current_revision,current_revision_sha256 FROM graph_nodes WHERE graph_id=?1 AND node_id=?2",
            params![graph_id, node.node_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        if current.0 != kind {
            return Err(StoreError::Invariant(format!(
                "graph node kind is immutable for {}",
                node.node_id
            )));
        }
        let expected_revision = current
            .1
            .checked_add(1)
            .ok_or_else(|| StoreError::Invariant("graph node revision overflow".into()))?;
        if node.revision != expected_revision as u64 || node.previous_revision_sha256 != current.2 {
            return Err(StoreError::Invariant(format!(
                "stale graph node revision for {}: expected revision {} with previous hash {:?}",
                node.node_id, expected_revision, current.2
            )));
        }
        let changed = transaction.execute(
            "INSERT INTO graph_node_revisions(graph_id,node_id,revision,revision_json,revision_sha256,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
            params![graph_id, node.node_id, node.revision as i64, revision_json, revision_hash, timestamp],
        )?;
        if changed != 1 {
            return Err(StoreError::Invariant(
                "graph node revision insert lost".into(),
            ));
        }
        let changed = transaction.execute(
            "UPDATE graph_nodes SET current_revision=?1,current_revision_sha256=?2 WHERE graph_id=?3 AND node_id=?4 AND current_revision=?5",
            params![node.revision as i64, revision_hash, graph_id, node.node_id, current.1],
        )?;
        if changed != 1 {
            return Err(StoreError::Invariant(
                "graph node revision compare-and-set failed".into(),
            ));
        }
        bump_graph_revision(&transaction, graph_id, &timestamp)?;
        transaction.commit()?;
        drop(connection);
        self.get_graph_info(graph_id)
    }

    /// Append a typed relationship. Endpoint existence is enforced by composite foreign keys.
    pub fn append_graph_edge(
        &self,
        graph_id: &str,
        edge: GraphEdge,
    ) -> Result<GraphInfo, StoreError> {
        if edge.edge_id.trim().is_empty() || edge.from_node_id == edge.to_node_id {
            return Err(StoreError::Invariant(
                "graph edge identity/endpoints are invalid".into(),
            ));
        }
        let edge_json = serde_json::to_string(&edge)?;
        let kind = serde_json::to_value(edge.kind)?
            .as_str()
            .ok_or_else(|| StoreError::Invariant("graph edge kind serialization failed".into()))?
            .to_owned();
        let timestamp = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        transaction.execute(
            "INSERT INTO graph_edges(graph_id,edge_id,from_node_id,to_node_id,kind,edge_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![graph_id, edge.edge_id, edge.from_node_id, edge.to_node_id, kind, edge_json, timestamp],
        )?;
        bump_graph_revision(&transaction, graph_id, &timestamp)?;
        transaction.commit()?;
        drop(connection);
        self.get_graph_info(graph_id)
    }

    /// Capture source evidence as unverified. Verified/rejected states require a future verifier capability.
    pub fn capture_graph_evidence(
        &self,
        graph_id: &str,
        evidence: GraphEvidence,
    ) -> Result<GraphInfo, StoreError> {
        evidence
            .validate()
            .map_err(|error| StoreError::Invariant(error.to_string()))?;
        if !matches!(
            evidence.verification,
            EvidenceVerification::Unverified | EvidenceVerification::Unavailable
        ) {
            return Err(StoreError::EvidenceAuthorityRequired);
        }
        let evidence_json = serde_json::to_string(&evidence)?;
        let timestamp = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        transaction.execute(
            "INSERT INTO graph_evidence(graph_id,evidence_id,node_id,source_uri,source_sha256,verification,evidence_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![graph_id, evidence.evidence_id, evidence.node_id, evidence.source_uri, evidence.source_sha256, serde_json::to_value(evidence.verification)?.as_str(), evidence_json, timestamp],
        )?;
        bump_graph_revision(&transaction, graph_id, &timestamp)?;
        transaction.commit()?;
        drop(connection);
        self.get_graph_info(graph_id)
    }

    /// Seal and persist the current Goal/Idea/Plan/Execution graph state as an immutable snapshot.
    pub fn create_graph_snapshot(&self, graph_id: &str) -> Result<GraphSnapshot, StoreError> {
        let timestamp = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let info = load_graph_info_from(&transaction, graph_id)?;
        let previous_snapshot: Option<(i64, String)> = transaction
            .query_row(
                "SELECT revision,snapshot_sha256 FROM graph_snapshots WHERE graph_id=?1 ORDER BY revision DESC LIMIT 1",
                params![graph_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (previous_revision, previous_hash) = match previous_snapshot {
            Some((revision, hash)) if revision < info.revision as i64 => {
                (Some(revision as u64), Some(hash))
            }
            Some(_) => return Err(StoreError::SnapshotUnchanged),
            None => (None, None),
        };
        let nodes = load_graph_node_revisions(&transaction, graph_id)?;
        let edges = load_graph_edges(&transaction, graph_id)?;
        let evidence = load_graph_evidence(&transaction, graph_id)?;
        let snapshot = GraphSnapshot::seal(GraphSnapshotDraft {
            graph_id: graph_id.into(),
            revision: info.revision,
            nodes,
            edges,
            evidence,
            previous_snapshot_revision: previous_revision,
            previous_snapshot_sha256: previous_hash.clone(),
            created_at: timestamp.clone(),
        })
        .map_err(|error| StoreError::Invariant(error.to_string()))?;
        transaction.execute(
            "INSERT INTO graph_snapshots(graph_id,revision,previous_revision,previous_snapshot_sha256,snapshot_sha256,snapshot_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![graph_id, info.revision as i64, previous_revision.map(|value| value as i64), previous_hash, snapshot.snapshot_sha256, serde_json::to_string(&snapshot)?, timestamp],
        )?;
        transaction.commit()?;
        Ok(snapshot)
    }

    /// Read and revalidate one immutable graph snapshot; `None` selects latest revision.
    pub fn get_graph_snapshot(
        &self,
        graph_id: &str,
        revision: Option<u64>,
    ) -> Result<GraphSnapshot, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let snapshot_row: Option<StoredGraphSnapshotRow> = match revision {
            Some(revision) => connection
                .query_row(
                    "SELECT revision,previous_revision,previous_snapshot_sha256,snapshot_sha256,snapshot_json FROM graph_snapshots WHERE graph_id=?1 AND revision=?2",
                    params![graph_id, revision as i64],
                    |row| Ok(StoredGraphSnapshotRow {
                        revision: row.get(0)?, previous_revision: row.get(1)?,
                        previous_hash: row.get(2)?, snapshot_hash: row.get(3)?,
                        snapshot_json: row.get(4)?,
                    }),
                )
                .optional()?,
            None => connection
                .query_row(
                    "SELECT revision,previous_revision,previous_snapshot_sha256,snapshot_sha256,snapshot_json FROM graph_snapshots WHERE graph_id=?1 ORDER BY revision DESC LIMIT 1",
                    params![graph_id],
                    |row| Ok(StoredGraphSnapshotRow {
                        revision: row.get(0)?, previous_revision: row.get(1)?,
                        previous_hash: row.get(2)?, snapshot_hash: row.get(3)?,
                        snapshot_json: row.get(4)?,
                    }),
                )
                .optional()?,
        };
        let stored = snapshot_row.ok_or_else(|| {
            StoreError::NotFound(format!("graph snapshot {graph_id} revision {revision:?}"))
        })?;
        let snapshot: GraphSnapshot = serde_json::from_str(&stored.snapshot_json)?;
        snapshot
            .validate()
            .map_err(|error| StoreError::Invariant(error.to_string()))?;
        if snapshot.graph_id != graph_id
            || snapshot.revision != stored.revision as u64
            || snapshot.snapshot_sha256 != stored.snapshot_hash
            || snapshot.previous_snapshot_revision
                != stored.previous_revision.map(|value| value as u64)
            || snapshot.previous_snapshot_sha256 != stored.previous_hash
        {
            return Err(StoreError::Invariant(
                "graph snapshot database/payload binding mismatch".into(),
            ));
        }
        if let Some(previous_revision) = stored.previous_revision {
            let previous_hash_in_db: String = connection.query_row(
                "SELECT snapshot_sha256 FROM graph_snapshots WHERE graph_id=?1 AND revision=?2",
                params![graph_id, previous_revision],
                |row| row.get(0),
            )?;
            if snapshot.previous_snapshot_sha256.as_deref() != Some(previous_hash_in_db.as_str()) {
                return Err(StoreError::Invariant(
                    "graph snapshot predecessor hash mismatch".into(),
                ));
            }
        }
        Ok(snapshot)
    }

    /// Durably reserve one provider dispatch intent before any external call.
    /// Repeated reservations return the existing record with `created=false` and
    /// must never trigger another provider dispatch.
    pub fn reserve_provider_dispatch(
        &self,
        request: ProviderIntentRequest,
        verifier: &dyn ApprovalVerifier,
    ) -> Result<ProviderIntentReservation, StoreError> {
        ProviderLedger::validate_request(&request).map_err(provider_store_error)?;
        let timestamp = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        if let Some(existing) = ProviderLedger::existing_reservation(&transaction, &request)
            .map_err(provider_store_error)?
        {
            transaction.commit()?;
            return Ok(existing);
        }

        let workflow = load_workflow_from(&transaction, &request.workflow_id)?;
        if workflow.state != WorkflowState::Executing
            || workflow.plan_hash.as_deref() != Some(request.plan_sha256.as_str())
        {
            return Err(StoreError::ApprovalRequired);
        }
        verify_current_approval(&transaction, &workflow, verifier)?;
        let task: (String, i64, Option<String>, Option<String>, Option<String>) = transaction.query_row(
            "SELECT state,attempts,lease_id,lease_owner,lease_expires_at FROM tasks WHERE workflow_id=?1 AND task_id=?2",
            params![request.workflow_id, request.task_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
        ).optional()?.ok_or_else(|| StoreError::NotFound(format!("task {}", request.task_id)))?;
        if task.0 != "RUNNING"
            || task.1 != request.attempt as i64
            || task.2.as_deref() != Some(request.lease_id.as_str())
            || task.3.as_deref() != Some(request.worker_id.as_str())
            || task
                .4
                .as_deref()
                .is_none_or(|expiry| expiry <= timestamp.as_str())
        {
            return Err(StoreError::LeaseFenced);
        }
        let record = ProviderLedger::insert_reserved(&transaction, &request, &timestamp)
            .map_err(provider_store_error)?;
        insert_event(
            &transaction,
            &request.workflow_id,
            Some(&request.task_id),
            "provider.dispatch_intent_reserved",
            &serde_json::json!({"intentId":record.intent_id,"providerId":request.provider_id,"idempotencyKey":request.idempotency_key,"requestSha256":request.request_sha256}),
            &format!(
                "provider-intent:{}:{}",
                request.provider_id, request.idempotency_key
            ),
            &timestamp,
        )?;
        transaction.commit()?;
        Ok(ProviderIntentReservation {
            record,
            created: true,
        })
    }

    /// Persist one provider outcome. `Unknown` is terminal and never replayable.
    pub fn record_provider_dispatch_outcome(
        &self,
        intent_id: &str,
        outcome: ProviderIntentOutcome,
    ) -> Result<ProviderIntentRecord, StoreError> {
        ProviderLedger::validate_outcome(&outcome).map_err(provider_store_error)?;
        let timestamp = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let (current, created) =
            ProviderLedger::finalize(&transaction, intent_id, &outcome, &timestamp)
                .map_err(provider_store_error)?;
        let state = current.state;
        let provider_run_id = current.provider_run_id.as_deref();
        if created {
            insert_event(
                &transaction,
                &current.request.workflow_id,
                Some(&current.request.task_id),
                "provider.dispatch_outcome_recorded",
                &serde_json::json!({"intentId":intent_id,"state":provider_dispatch_state_db(state),"providerRunId":provider_run_id}),
                &format!("provider-outcome:{intent_id}"),
                &timestamp,
            )?;
        }
        transaction.commit()?;
        Ok(current)
    }

    /// Read one provider dispatch intent without changing its state.
    pub fn get_provider_dispatch_intent(
        &self,
        intent_id: &str,
    ) -> Result<ProviderIntentRecord, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        ProviderLedger::load_by_id(&connection, intent_id)
            .map_err(provider_store_error)?
            .ok_or_else(|| StoreError::NotFound(format!("provider intent {intent_id}")))
    }

    /// Read all persisted provider intents for one workflow in stable creation order.
    pub fn list_provider_dispatch_intents(
        &self,
        workflow_id: &str,
    ) -> Result<Vec<ProviderIntentRecord>, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM workflows WHERE workflow_id=?1)",
            params![workflow_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(StoreError::NotFound(format!("workflow {workflow_id}")));
        }
        ProviderLedger::list_by_workflow(&connection, workflow_id).map_err(provider_store_error)
    }

    /// Persist an append-only provider lookup observation without reopening or rewriting intent.
    pub fn record_provider_reconciliation_observation(
        &self,
        intent_id: &str,
        response: serde_json::Value,
        provider_run_id: Option<String>,
    ) -> Result<ProviderReconciliationObservation, StoreError> {
        let timestamp = now();
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let intent = ProviderLedger::load_by_id(&transaction, intent_id)
            .map_err(provider_store_error)?
            .ok_or_else(|| StoreError::NotFound(format!("provider intent {intent_id}")))?;
        let (observation, created) = ProviderLedger::record_observation(
            &transaction,
            intent_id,
            &response,
            provider_run_id.as_deref(),
            &timestamp,
        )
        .map_err(provider_store_error)?;
        if created {
            insert_event(
                &transaction,
                &intent.request.workflow_id,
                Some(&intent.request.task_id),
                "provider.reconciliation_observed",
                &serde_json::json!({"intentId":intent_id,"observationId":observation.observation_id,"responseSha256":observation.response_sha256,"providerRunId":provider_run_id}),
                &format!(
                    "provider-reconciliation:{intent_id}:{}",
                    observation.response_sha256
                ),
                &timestamp,
            )?;
        }
        transaction.commit()?;
        Ok(observation)
    }

    /// Read every immutable reconciliation observation for one dispatch intent.
    pub fn list_provider_reconciliation_observations(
        &self,
        intent_id: &str,
    ) -> Result<Vec<ProviderReconciliationObservation>, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        ProviderLedger::list_observations(&connection, intent_id).map_err(provider_store_error)
    }

    /// Verify the complete append-only event chain for one workflow.
    pub fn verify_event_chain(
        &self,
        workflow_id: &str,
    ) -> Result<EventChainVerification, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM workflows WHERE workflow_id=?1)",
            params![workflow_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(StoreError::NotFound(format!("workflow {workflow_id}")));
        }
        let mut statement = connection.prepare(
            "SELECT event_seq,event_id,task_id,event_type,payload_json,idempotency_key,created_at,event_prev_hash,event_hash FROM events WHERE workflow_id=?1 ORDER BY event_seq",
        )?;
        let rows = statement.query_map(params![workflow_id], |row| {
            Ok(EventRow {
                sequence: row.get(0)?,
                event_id: row.get(1)?,
                task_id: row.get(2)?,
                event_type: row.get(3)?,
                payload_json: row.get(4)?,
                idempotency_key: row.get(5)?,
                created_at: row.get(6)?,
                previous_hash: row.get(7)?,
                event_hash: row.get(8)?,
            })
        })?;
        let mut previous_hash = "0".repeat(64);
        let mut count = 0_u64;
        let mut head_hash = None;
        let mut failure_sequence = None;
        for row in rows {
            let event = row?;
            count += 1;
            if event.previous_hash != previous_hash {
                failure_sequence = Some(event.sequence);
                break;
            }
            let material = EventHashMaterial {
                workflow_id,
                event_id: &event.event_id,
                task_id: event.task_id.as_deref(),
                event_type: &event.event_type,
                payload_json: &event.payload_json,
                idempotency_key: &event.idempotency_key,
                created_at: &event.created_at,
                previous_hash: &event.previous_hash,
            };
            let expected_hash = hash_event(&material)?;
            if event.event_hash != expected_hash {
                failure_sequence = Some(event.sequence);
                break;
            }
            previous_hash.clone_from(&event.event_hash);
            head_hash = Some(event.event_hash);
        }
        Ok(EventChainVerification {
            workflow_id: workflow_id.into(),
            valid: failure_sequence.is_none(),
            event_count: count,
            head_hash,
            failure_sequence,
        })
    }

    /// Build a deterministic synthesis from persisted task/result/attempt/policy evidence and
    /// retain it in the append-only workflow event journal. No projection or provider response
    /// is accepted as a result source; an invalid source event chain fails closed.
    pub fn synthesize_workflow(&self, workflow_id: &str) -> Result<serde_json::Value, StoreError> {
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_store_not_quarantined(&transaction)?;
        let chain = verify_event_chain_connection(&transaction, workflow_id)?;
        if !chain.valid {
            return Err(StoreError::Invariant(format!(
                "workflow source event chain is invalid at sequence {:?}",
                chain.failure_sequence
            )));
        }
        let workflow = load_workflow_from(&transaction, workflow_id)?;
        let policy_count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM workflow_policy_attachments WHERE workflow_id=?1",
            params![workflow_id],
            |row| row.get(0),
        )?;
        let (contract_version, contract_sha256, policy_pins, evaluation) = if policy_count > 0 {
            let row: Option<(u32,String,String,Option<String>)> = transaction.query_row(
                "SELECT version,content_sha256,policy_pins_json,plan_sha256 FROM workflow_success_contracts WHERE workflow_id=?1 ORDER BY version DESC LIMIT 1",
                params![workflow_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
            ).optional()?;
            if let Some(row) = row {
                if let Some(plan_sha256) = workflow.plan_hash.as_deref() {
                    verify_workflow_success_contract(
                        &transaction,
                        workflow_id,
                        Some(plan_sha256),
                        true,
                    )?;
                    (
                        Some(row.0),
                        Some(row.1),
                        serde_json::from_str(&row.2)?,
                        evaluate_persisted_success_contract(&transaction, workflow_id)?,
                    )
                } else {
                    (
                        Some(row.0),
                        Some(row.1),
                        serde_json::from_str(&row.2)?,
                        serde_json::json!({
                            "outcome":"UNRESOLVED","reason":"immutable plan is not yet approved and pinned"
                        }),
                    )
                }
            } else {
                (
                    None,
                    None,
                    serde_json::json!([]),
                    serde_json::json!({
                        "outcome":"UNRESOLVED","reason":"policy attachment has no persisted success-contract snapshot"
                    }),
                )
            }
        } else {
            (
                None,
                None,
                serde_json::json!([]),
                serde_json::json!({
                    "outcome":"UNRESOLVED","reason":"no persisted success contract is attached to this workflow"
                }),
            )
        };
        let attempt_rows: Vec<serde_json::Value> = {
            let mut statement = transaction.prepare(
                "SELECT a.task_id,a.attempt,a.owner_epoch,a.lease_id,a.worker_id,a.lease_expires_at,a.claimed_at,r.result_sha256,r.outcome,r.recorded_at
                 FROM task_attempts a LEFT JOIN task_attempt_results r
                   ON r.workflow_id=a.workflow_id AND r.task_id=a.task_id AND r.attempt=a.attempt
                 WHERE a.workflow_id=?1 ORDER BY a.task_id,a.attempt",
            )?;
            statement.query_map(params![workflow_id], |row| Ok(serde_json::json!({
                "task_id":row.get::<_,String>(0)?,"attempt":row.get::<_,i64>(1)?,
                "owner_epoch":row.get::<_,i64>(2)?,"lease_id":row.get::<_,String>(3)?,
                "worker_id":row.get::<_,String>(4)?,"lease_expires_at":row.get::<_,String>(5)?,
                "claimed_at":row.get::<_,String>(6)?,"result_sha256":row.get::<_,Option<String>>(7)?,
                "outcome":row.get::<_,Option<String>>(8)?,"result_recorded_at":row.get::<_,Option<String>>(9)?
            })))?.collect::<Result<Vec<_>,_>>()?
        };
        let inbox_rows: Vec<serde_json::Value> = {
            let mut statement = transaction.prepare(
                "SELECT event_id,plan_sha256,task_id,attempt,producer_id,provenance_sha256,payload_sha256,recorded_at
                 FROM workflow_result_inbox WHERE workflow_id=?1 ORDER BY task_id,attempt,event_id",
            )?;
            statement.query_map(params![workflow_id], |row| Ok(serde_json::json!({
                "event_id":row.get::<_,String>(0)?,"plan_sha256":row.get::<_,String>(1)?,
                "task_id":row.get::<_,String>(2)?,"attempt":row.get::<_,i64>(3)?,
                "producer_id":row.get::<_,String>(4)?,"provenance_sha256":row.get::<_,String>(5)?,
                "payload_sha256":row.get::<_,String>(6)?,"recorded_at":row.get::<_,String>(7)?
            })))?.collect::<Result<Vec<_>,_>>()?
        };
        let source_event_count: u64 = transaction.query_row(
            "SELECT COUNT(*) FROM events WHERE workflow_id=?1 AND event_type!='workflow.synthesis_reported'",
            params![workflow_id], |row| row.get(0),
        )?;
        let source_event_head: Option<String> = transaction.query_row(
            "SELECT event_hash FROM events WHERE workflow_id=?1 AND event_type!='workflow.synthesis_reported' ORDER BY event_seq DESC LIMIT 1",
            params![workflow_id], |row| row.get(0),
        ).optional()?;
        let task_evidence: Vec<serde_json::Value> = workflow
            .tasks
            .iter()
            .map(|task| {
                serde_json::json!({
                    "task_id":task.definition.task_id,"role":task.definition.role,
                    "dependencies":task.definition.depends_on,"state":task.state,
                    "attempts":task.attempts,"result":task.result
                })
            })
            .collect();
        let evaluation_outcome = evaluation
            .get("outcome")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("UNRESOLVED");
        let outcome = if workflow.state == WorkflowState::Failed || evaluation_outcome == "FAILED" {
            "FAILED"
        } else if workflow.state == WorkflowState::Completed && evaluation_outcome == "PASSED" {
            "PASSED"
        } else {
            "UNRESOLVED"
        };
        let mut report = serde_json::json!({
            "schema_version":1,"workflow_id":workflow_id,"workflow_state":workflow.state,
            "proposal_sha256":workflow.proposal_hash,"plan_sha256":workflow.plan_hash,
            "approval":workflow.approval.map(|approval| serde_json::json!({
                "approval_id":approval.approval_id,"actor":approval.actor,
                "proposal_sha256":approval.proposal_hash,"plan_sha256":approval.plan_hash
            })),
            "success_contract_version":contract_version,"success_contract_sha256":contract_sha256,
            "policy_pins":policy_pins,"success_evaluation":evaluation,"outcome":outcome,
            "tasks":task_evidence,"attempt_ledger":attempt_rows,"result_inbox":inbox_rows,
            "source_event_chain_valid":true,"source_event_count":source_event_count,
            "source_event_head_sha256":source_event_head
        });
        let report_sha256 =
            content_hash(&report).map_err(|error| StoreError::Invariant(error.to_string()))?;
        report["report_sha256"] = serde_json::Value::String(report_sha256.clone());
        let payload_json = serde_json::to_string(&report)?;
        let idempotency_key = format!("workflow-synthesis:{report_sha256}");
        let existing: Option<(String,String)> = transaction.query_row(
            "SELECT event_type,payload_json FROM events WHERE workflow_id=?1 AND idempotency_key=?2",
            params![workflow_id,idempotency_key], |row| Ok((row.get(0)?,row.get(1)?)),
        ).optional()?;
        if let Some((event_type, existing_payload)) = existing {
            if event_type != "workflow.synthesis_reported" || existing_payload != payload_json {
                return Err(StoreError::Invariant(
                    "synthesis idempotency key is bound to conflicting report content".into(),
                ));
            }
            transaction.commit()?;
            return Ok(report);
        }
        insert_event(
            &transaction,
            workflow_id,
            None,
            "workflow.synthesis_reported",
            &report,
            &idempotency_key,
            &now(),
        )?;
        transaction.commit()?;
        Ok(report)
    }
}

fn configure_connection(connection: &Connection) -> Result<(), StoreError> {
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    let journal_mode: String =
        connection.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
    if journal_mode != "wal" && journal_mode != "memory" {
        return Err(StoreError::Invariant(format!(
            "SQLite refused the required WAL journal mode: {journal_mode}"
        )));
    }
    connection.execute_batch(
        "PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;",
    )?;
    let synchronous: i64 = connection.pragma_query_value(None, "synchronous", |row| row.get(0))?;
    if synchronous != 2 {
        return Err(StoreError::Invariant(
            "SQLite synchronous mode is not FULL".into(),
        ));
    }
    Ok(())
}

fn open_trust_connection(
    path: &Path,
    workflow_connection: &Connection,
) -> Result<Connection, StoreError> {
    let canonical_path = fs::canonicalize(path)?;
    let connection = Connection::open_with_flags(
        &canonical_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    configure_connection(&connection)?;
    verify_same_database(workflow_connection, &connection)?;
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version != SCHEMA_VERSION {
        return Err(StoreError::SchemaVersion(version));
    }
    Ok(connection)
}

fn verify_same_database(
    workflow_connection: &Connection,
    trust_connection: &Connection,
) -> Result<(), StoreError> {
    let main_file = |connection: &Connection| -> Result<String, StoreError> {
        connection
            .query_row(
                "SELECT file FROM pragma_database_list WHERE name='main'",
                [],
                |row| row.get(0),
            )
            .map_err(StoreError::from)
    };
    let workflow_file = main_file(workflow_connection)?;
    let trust_file = main_file(trust_connection)?;
    if workflow_file != trust_file {
        return Err(StoreError::Invariant(
            "workflow and Governance SQLite connections resolve to different database paths".into(),
        ));
    }
    if !workflow_file.is_empty() {
        let workflow_metadata = fs::metadata(&workflow_file)?;
        let trust_metadata = fs::metadata(&trust_file)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if workflow_metadata.dev() != trust_metadata.dev()
                || workflow_metadata.ino() != trust_metadata.ino()
            {
                return Err(StoreError::Invariant(
                    "workflow and Governance SQLite paths do not identify the same file".into(),
                ));
            }
        }
        #[cfg(not(unix))]
        let _ = (workflow_metadata, trust_metadata);
    }
    let probe_id = Uuid::new_v4().simple().to_string();
    let now_ms = chrono::Utc::now().timestamp_millis();
    workflow_connection.execute(
        "DELETE FROM store_connection_probes WHERE created_at_ms<?1",
        params![now_ms.saturating_sub(3_600_000)],
    )?;
    workflow_connection.execute(
        "INSERT INTO store_connection_probes(probe_id,created_at_ms) VALUES(?1,?2)",
        params![probe_id, now_ms],
    )?;
    let probe_visible: rusqlite::Result<bool> = trust_connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM store_connection_probes WHERE probe_id=?1)",
        params![probe_id],
        |row| row.get(0),
    );
    let cleanup = workflow_connection.execute(
        "DELETE FROM store_connection_probes WHERE probe_id=?1",
        params![probe_id],
    );
    let probe_visible = probe_visible?;
    cleanup?;
    if !probe_visible {
        return Err(StoreError::Invariant(
            "workflow and Governance SQLite handles do not observe the same committed database state".into(),
        ));
    }
    Ok(())
}

fn migrate_new_database(connection: &Connection) -> Result<(), StoreError> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version != 0 && !(2..=20).contains(&version) {
        return Err(StoreError::SchemaVersion(version));
    }
    if version == 0 {
        connection.execute_batch(
        "BEGIN IMMEDIATE;
         CREATE TABLE workflows(
           workflow_id TEXT PRIMARY KEY,
           state TEXT NOT NULL CHECK(state IN ('PROPOSED','APPROVED','EXECUTING','COMPLETED','FAILED','CANCELLED')),
           proposal_json TEXT NOT NULL,
           proposal_sha256 TEXT NOT NULL CHECK(length(proposal_sha256)=64),
           plan_json TEXT NOT NULL,
           plan_sha256 TEXT,
           approval_json TEXT,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE TABLE approvals(
           approval_id TEXT PRIMARY KEY,
           workflow_id TEXT NOT NULL UNIQUE REFERENCES workflows(workflow_id),
           proposal_sha256 TEXT NOT NULL CHECK(length(proposal_sha256)=64),
           plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256)=64),
           actor TEXT NOT NULL,
           evidence_json TEXT NOT NULL,
           approved_at TEXT NOT NULL
         );
         CREATE TABLE tasks(
           task_id TEXT NOT NULL,
           workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
           ordinal INTEGER NOT NULL,
           definition_json TEXT NOT NULL,
           state TEXT NOT NULL CHECK(state IN ('PENDING','RUNNING','SUCCEEDED','FAILED','UNKNOWN','CANCELLED')),
           attempts INTEGER NOT NULL CHECK(attempts>=0),
           lease_id TEXT,
           lease_owner TEXT,
           lease_expires_at TEXT,
           result_json TEXT,
           PRIMARY KEY(workflow_id,task_id),
           UNIQUE(workflow_id,ordinal),
           CHECK((state='RUNNING' AND lease_id IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
              OR (state!='RUNNING' AND lease_id IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL))
         );
         CREATE UNIQUE INDEX tasks_active_lease_id ON tasks(lease_id) WHERE lease_id IS NOT NULL;
         CREATE TRIGGER workflow_contract_immutable
         BEFORE UPDATE OF proposal_json,proposal_sha256,plan_json ON workflows
         BEGIN SELECT RAISE(ABORT,'workflow proposal and immutable plan are append-only'); END;
         CREATE TRIGGER workflow_plan_hash_once
         BEFORE UPDATE OF plan_sha256 ON workflows
         WHEN NOT (OLD.state='PROPOSED' AND NEW.state='APPROVED' AND OLD.plan_sha256 IS NULL AND NEW.plan_sha256 IS NOT NULL)
         BEGIN SELECT RAISE(ABORT,'immutable plan hash can only be pinned during first approval'); END;
         CREATE TRIGGER workflow_approval_immutable
         BEFORE UPDATE OF approval_json ON workflows
         WHEN NOT (OLD.state='PROPOSED' AND NEW.state='APPROVED' AND OLD.approval_json IS NULL AND NEW.approval_json IS NOT NULL)
         BEGIN SELECT RAISE(ABORT,'workflow approval is immutable'); END;
         CREATE TRIGGER workflow_state_transition_guard
         BEFORE UPDATE OF state ON workflows
         WHEN NOT (
           (OLD.state='PROPOSED' AND NEW.state IN ('APPROVED','CANCELLED')) OR
           (OLD.state='APPROVED' AND NEW.state IN ('EXECUTING','CANCELLED')) OR
           (OLD.state='EXECUTING' AND NEW.state IN ('COMPLETED','FAILED','CANCELLED'))
         )
         BEGIN SELECT RAISE(ABORT,'invalid workflow state transition'); END;
         CREATE TRIGGER task_definition_immutable
         BEFORE UPDATE OF definition_json,workflow_id,ordinal,task_id ON tasks
         BEGIN SELECT RAISE(ABORT,'task contract is immutable'); END;
         CREATE TRIGGER task_state_transition_guard
         BEFORE UPDATE OF state ON tasks
         WHEN NOT (
           (OLD.state='PENDING' AND NEW.state='RUNNING' AND NEW.attempts=OLD.attempts+1 AND NEW.result_json IS OLD.result_json) OR
           (OLD.state='RUNNING' AND NEW.state IN ('SUCCEEDED','FAILED','UNKNOWN') AND NEW.attempts=OLD.attempts AND NEW.result_json IS NOT NULL)
         )
         BEGIN SELECT RAISE(ABORT,'invalid task state transition'); END;
         CREATE TRIGGER task_lease_fence_guard
         BEFORE UPDATE OF attempts,lease_id,lease_owner,lease_expires_at ON tasks
         WHEN NOT (
           (OLD.state='PENDING' AND NEW.state='RUNNING' AND NEW.attempts=OLD.attempts+1 AND NEW.lease_id IS NOT NULL AND NEW.lease_owner IS NOT NULL AND NEW.lease_expires_at IS NOT NULL) OR
           (OLD.state='RUNNING' AND NEW.state IN ('SUCCEEDED','FAILED','UNKNOWN') AND NEW.attempts=OLD.attempts AND NEW.lease_id IS NULL AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL)
         )
         BEGIN SELECT RAISE(ABORT,'task lease identity is fenced'); END;
         CREATE TRIGGER task_result_append_only
         BEFORE UPDATE OF result_json ON tasks
         WHEN NOT (OLD.state='RUNNING' AND NEW.state IN ('SUCCEEDED','FAILED','UNKNOWN') AND OLD.result_json IS NULL AND NEW.result_json IS NOT NULL)
         BEGIN SELECT RAISE(ABORT,'task result can only be appended once from a running lease'); END;
         CREATE TRIGGER approval_append_only_update
         BEFORE UPDATE ON approvals
         BEGIN SELECT RAISE(ABORT,'approval records are append-only'); END;
         CREATE TRIGGER approval_append_only_delete
         BEFORE DELETE ON approvals
         BEGIN SELECT RAISE(ABORT,'approval records are append-only'); END;
         CREATE TABLE events(
           event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
           event_id TEXT NOT NULL UNIQUE,
           workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
           task_id TEXT,
           event_type TEXT NOT NULL,
           payload_json TEXT NOT NULL,
           idempotency_key TEXT NOT NULL,
           created_at TEXT NOT NULL,
           event_prev_hash TEXT NOT NULL CHECK(length(event_prev_hash)=64),
           event_hash TEXT NOT NULL CHECK(length(event_hash)=64),
           UNIQUE(workflow_id,idempotency_key),
           FOREIGN KEY(workflow_id,task_id) REFERENCES tasks(workflow_id,task_id)
         );
         CREATE TRIGGER event_append_only_update
         BEFORE UPDATE ON events
         BEGIN SELECT RAISE(ABORT,'workflow events are append-only'); END;
         CREATE TRIGGER event_append_only_delete
         BEFORE DELETE ON events
         BEGIN SELECT RAISE(ABORT,'workflow events are append-only'); END;
         CREATE INDEX events_workflow_seq ON events(workflow_id,event_seq);
         PRAGMA user_version=2;
         COMMIT;"
        )?;
    }

    let current_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current_version == 2 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE graphs(
               graph_id TEXT PRIMARY KEY,
               revision INTEGER NOT NULL CHECK(revision>=0),
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE TABLE graph_nodes(
               graph_id TEXT NOT NULL REFERENCES graphs(graph_id),
               node_id TEXT NOT NULL,
               kind TEXT NOT NULL,
               current_revision INTEGER NOT NULL CHECK(current_revision>=0),
               current_revision_sha256 TEXT,
               PRIMARY KEY(graph_id,node_id),
               CHECK((current_revision=0 AND current_revision_sha256 IS NULL) OR
                     (current_revision>0 AND current_revision_sha256 IS NOT NULL AND length(current_revision_sha256)=64))
             );
             CREATE TABLE graph_node_revisions(
               graph_id TEXT NOT NULL,
               node_id TEXT NOT NULL,
               revision INTEGER NOT NULL CHECK(revision>0),
               revision_json TEXT NOT NULL,
               revision_sha256 TEXT NOT NULL CHECK(length(revision_sha256)=64),
               created_at TEXT NOT NULL,
               PRIMARY KEY(graph_id,node_id,revision),
               FOREIGN KEY(graph_id,node_id) REFERENCES graph_nodes(graph_id,node_id)
             );
             CREATE TABLE graph_edges(
               graph_id TEXT NOT NULL REFERENCES graphs(graph_id),
               edge_id TEXT NOT NULL,
               from_node_id TEXT NOT NULL,
               to_node_id TEXT NOT NULL,
               kind TEXT NOT NULL,
               edge_json TEXT NOT NULL,
               created_at TEXT NOT NULL,
               PRIMARY KEY(graph_id,edge_id),
               UNIQUE(graph_id,from_node_id,to_node_id,kind),
               FOREIGN KEY(graph_id,from_node_id) REFERENCES graph_nodes(graph_id,node_id),
               FOREIGN KEY(graph_id,to_node_id) REFERENCES graph_nodes(graph_id,node_id),
               CHECK(from_node_id!=to_node_id)
             );
             CREATE TABLE graph_evidence(
               graph_id TEXT NOT NULL,
               evidence_id TEXT NOT NULL,
               node_id TEXT NOT NULL,
               source_uri TEXT NOT NULL,
               source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
               verification TEXT NOT NULL CHECK(verification IN ('UNVERIFIED','VERIFIED','REJECTED','UNAVAILABLE')),
               evidence_json TEXT NOT NULL,
               created_at TEXT NOT NULL,
               PRIMARY KEY(graph_id,evidence_id),
               FOREIGN KEY(graph_id,node_id) REFERENCES graph_nodes(graph_id,node_id)
             );
             CREATE TABLE graph_snapshots(
               graph_id TEXT NOT NULL REFERENCES graphs(graph_id),
               revision INTEGER NOT NULL CHECK(revision>0),
               previous_revision INTEGER,
               previous_snapshot_sha256 TEXT,
               snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256)=64),
               snapshot_json TEXT NOT NULL,
               created_at TEXT NOT NULL,
               PRIMARY KEY(graph_id,revision),
               CHECK((previous_revision IS NULL AND previous_snapshot_sha256 IS NULL) OR
                     (previous_revision IS NOT NULL AND previous_revision<revision AND previous_snapshot_sha256 IS NOT NULL AND length(previous_snapshot_sha256)=64))
             );
             CREATE TRIGGER graph_revision_increment_guard
             BEFORE UPDATE OF revision ON graphs
             WHEN NEW.revision!=OLD.revision+1
             BEGIN SELECT RAISE(ABORT,'graph revision must increment by one'); END;
             CREATE TRIGGER graph_node_head_increment_guard
             BEFORE UPDATE OF current_revision,current_revision_sha256 ON graph_nodes
             WHEN NEW.current_revision!=OLD.current_revision+1 OR NEW.current_revision_sha256 IS NULL
             BEGIN SELECT RAISE(ABORT,'graph node head must advance exactly one revision'); END;
             CREATE TRIGGER graph_node_revision_append_only_update
             BEFORE UPDATE ON graph_node_revisions
             BEGIN SELECT RAISE(ABORT,'graph node revisions are append-only'); END;
             CREATE TRIGGER graph_node_revision_append_only_delete
             BEFORE DELETE ON graph_node_revisions
             BEGIN SELECT RAISE(ABORT,'graph node revisions are append-only'); END;
             CREATE TRIGGER graph_edge_append_only_update
             BEFORE UPDATE ON graph_edges
             BEGIN SELECT RAISE(ABORT,'graph edges are append-only'); END;
             CREATE TRIGGER graph_edge_append_only_delete
             BEFORE DELETE ON graph_edges
             BEGIN SELECT RAISE(ABORT,'graph edges are append-only'); END;
             CREATE TRIGGER graph_evidence_append_only_update
             BEFORE UPDATE ON graph_evidence
             BEGIN SELECT RAISE(ABORT,'graph evidence is append-only'); END;
             CREATE TRIGGER graph_evidence_append_only_delete
             BEFORE DELETE ON graph_evidence
             BEGIN SELECT RAISE(ABORT,'graph evidence is append-only'); END;
             CREATE TRIGGER graph_snapshot_append_only_update
             BEFORE UPDATE ON graph_snapshots
             BEGIN SELECT RAISE(ABORT,'graph snapshots are immutable'); END;
             CREATE TRIGGER graph_snapshot_append_only_delete
             BEFORE DELETE ON graph_snapshots
             BEGIN SELECT RAISE(ABORT,'graph snapshots are immutable'); END;
             PRAGMA user_version=3;
             COMMIT;"
        )?;
    }
    let current_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current_version == 3 {
        ProviderLedger::migrate_v3_to_v4(connection).map_err(provider_store_error)?;
    }
    let current_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current_version == 4 {
        ProviderLedger::migrate_v4_to_v5(connection).map_err(provider_store_error)?;
    }
    let current_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current_version == 5 {
        ProviderLedger::migrate_v5_to_v6(connection).map_err(provider_store_error)?;
    }
    let current_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current_version == 6 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             ALTER TABLE tasks ADD COLUMN owner_epoch INTEGER NOT NULL DEFAULT 0 CHECK(owner_epoch>=0);
             UPDATE tasks SET owner_epoch=attempts;
             CREATE TABLE task_attempts(
               workflow_id TEXT NOT NULL,
               task_id TEXT NOT NULL,
               attempt INTEGER NOT NULL CHECK(attempt>0),
               owner_epoch INTEGER NOT NULL CHECK(owner_epoch>0),
               lease_id TEXT NOT NULL UNIQUE,
               worker_id TEXT NOT NULL,
               lease_expires_at TEXT NOT NULL,
               claimed_at TEXT NOT NULL,
               PRIMARY KEY(workflow_id,task_id,attempt),
               UNIQUE(workflow_id,task_id,owner_epoch),
               FOREIGN KEY(workflow_id,task_id) REFERENCES tasks(workflow_id,task_id)
             );
             INSERT INTO task_attempts(workflow_id,task_id,attempt,owner_epoch,lease_id,worker_id,lease_expires_at,claimed_at)
               SELECT workflow_id,task_id,CAST(json_extract(payload_json,'$.attempt') AS INTEGER),
                 CAST(json_extract(payload_json,'$.attempt') AS INTEGER),json_extract(payload_json,'$.leaseId'),
                 json_extract(payload_json,'$.workerId'),json_extract(payload_json,'$.expiresAt'),created_at
               FROM events WHERE event_type='task.claimed'
                 AND json_type(payload_json,'$.attempt')='integer'
                 AND json_type(payload_json,'$.leaseId')='text'
                 AND json_type(payload_json,'$.workerId')='text'
                 AND json_type(payload_json,'$.expiresAt')='text';
             CREATE TABLE task_attempt_results(
               workflow_id TEXT NOT NULL,
               task_id TEXT NOT NULL,
               attempt INTEGER NOT NULL,
               result_sha256 TEXT NOT NULL CHECK(length(result_sha256)=64),
               outcome TEXT NOT NULL CHECK(outcome IN ('SUCCEEDED','FAILED','UNKNOWN')),
               recorded_at TEXT NOT NULL,
               PRIMARY KEY(workflow_id,task_id,attempt),
               FOREIGN KEY(workflow_id,task_id,attempt) REFERENCES task_attempts(workflow_id,task_id,attempt)
             );
             CREATE TRIGGER task_attempt_append_only_update BEFORE UPDATE ON task_attempts
               BEGIN SELECT RAISE(ABORT,'task attempt ledger is append-only'); END;
             CREATE TRIGGER task_attempt_append_only_delete BEFORE DELETE ON task_attempts
               BEGIN SELECT RAISE(ABORT,'task attempt ledger is append-only'); END;
             CREATE TRIGGER task_owner_epoch_increment_guard BEFORE UPDATE OF owner_epoch ON tasks
               WHEN NOT (OLD.state='PENDING' AND NEW.state='RUNNING' AND NEW.owner_epoch=OLD.owner_epoch+1
                 AND NEW.attempts=OLD.attempts+1 AND NEW.lease_id IS NOT NULL AND NEW.lease_owner IS NOT NULL)
               BEGIN SELECT RAISE(ABORT,'task owner epoch must advance exactly once with a new lease'); END;
             CREATE TRIGGER task_attempt_insert_fence_guard BEFORE INSERT ON task_attempts
               WHEN NOT EXISTS(SELECT 1 FROM tasks t WHERE t.workflow_id=NEW.workflow_id AND t.task_id=NEW.task_id
                 AND t.state='RUNNING' AND t.attempts=NEW.attempt AND t.owner_epoch=NEW.owner_epoch
                 AND t.lease_id=NEW.lease_id AND t.lease_owner=NEW.worker_id AND t.lease_expires_at=NEW.lease_expires_at)
               BEGIN SELECT RAISE(ABORT,'attempt ledger insert does not match active task lease'); END;
             CREATE TRIGGER task_attempt_result_insert_fence_guard BEFORE INSERT ON task_attempt_results
               WHEN NOT EXISTS(SELECT 1 FROM tasks t WHERE t.workflow_id=NEW.workflow_id AND t.task_id=NEW.task_id
                 AND t.attempts=NEW.attempt AND t.state=NEW.outcome AND t.result_json IS NOT NULL)
               BEGIN SELECT RAISE(ABORT,'attempt result ledger does not match terminal task projection'); END;
             CREATE TRIGGER task_attempt_result_append_only_update BEFORE UPDATE ON task_attempt_results
               BEGIN SELECT RAISE(ABORT,'task attempt result ledger is append-only'); END;
             CREATE TRIGGER task_attempt_result_append_only_delete BEFORE DELETE ON task_attempt_results
               BEGIN SELECT RAISE(ABORT,'task attempt result ledger is append-only'); END;
             CREATE INDEX task_attempts_lease_lookup ON task_attempts(lease_id,worker_id);
             PRAGMA user_version=7;
             COMMIT;"
        )?;
    }
    let current_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current_version == 7 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE agent_sessions(
               session_id TEXT PRIMARY KEY,
               workflow_id TEXT NOT NULL,
               task_id TEXT NOT NULL,
               role TEXT NOT NULL CHECK(length(trim(role))>0),
               runtime_session_key TEXT NOT NULL UNIQUE CHECK(length(trim(runtime_session_key))>0),
               parent_session_key TEXT,
               state TEXT NOT NULL CHECK(state IN ('CREATED','ACTIVE','PAUSED','STALE','FAILED','TERMINATED')),
               current_turn_id TEXT,
               attempt INTEGER NOT NULL CHECK(attempt>0),
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               last_activity_at TEXT NOT NULL,
               FOREIGN KEY(workflow_id,task_id) REFERENCES tasks(workflow_id,task_id)
             );
             CREATE INDEX agent_sessions_workflow ON agent_sessions(workflow_id,created_at,session_id);
             CREATE INDEX agent_sessions_task ON agent_sessions(workflow_id,task_id,created_at);
             CREATE TABLE session_access(
               access_id TEXT PRIMARY KEY,
               session_id TEXT NOT NULL REFERENCES agent_sessions(session_id),
               accessor_role TEXT NOT NULL CHECK(length(trim(accessor_role))>0),
               permission TEXT NOT NULL CHECK(permission IN ('OBSERVE','MESSAGE','EXECUTE','TAKEOVER')),
               granted_by TEXT NOT NULL CHECK(length(trim(granted_by))>0),
               expires_at TEXT,
               created_at TEXT NOT NULL,
               revoked_at TEXT
             );
             CREATE UNIQUE INDEX session_access_active ON session_access(session_id,accessor_role,permission) WHERE revoked_at IS NULL;
             CREATE INDEX session_access_lookup ON session_access(session_id,accessor_role,permission,revoked_at);
             CREATE TABLE session_messages(
               message_id TEXT PRIMARY KEY,
               session_id TEXT NOT NULL REFERENCES agent_sessions(session_id),
               sender_role TEXT NOT NULL,
               recipient_role TEXT NOT NULL,
               protocol TEXT NOT NULL,
               protocol_version INTEGER NOT NULL CHECK(protocol_version>0),
               message_type TEXT NOT NULL,
               payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json)='object'),
               correlation_id TEXT,
               dedupe_key TEXT,
               state TEXT NOT NULL CHECK(state IN ('QUEUED','CLAIMED','ACKED','FAILED','UNCERTAIN')),
               attempt INTEGER NOT NULL CHECK(attempt>=0),
               available_at TEXT NOT NULL,
               lease_until TEXT,
               transport_started_at TEXT,
               receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND json_type(receipt_json)='object')),
               delivered_at TEXT,
               acked_at TEXT,
               last_error TEXT,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               CHECK((state='CLAIMED' AND lease_until IS NOT NULL AND attempt>0) OR state!='CLAIMED')
             );
             CREATE UNIQUE INDEX session_messages_dedupe ON session_messages(session_id,dedupe_key) WHERE dedupe_key IS NOT NULL;
             CREATE INDEX session_messages_inbox ON session_messages(session_id,recipient_role,state,available_at,created_at);
             CREATE INDEX session_messages_correlation ON session_messages(session_id,correlation_id,created_at);
             CREATE TRIGGER agent_sessions_no_delete BEFORE DELETE ON agent_sessions
               BEGIN SELECT RAISE(ABORT,'agent session history is retained'); END;
             CREATE TRIGGER session_messages_no_delete BEFORE DELETE ON session_messages
               BEGIN SELECT RAISE(ABORT,'session message history is retained'); END;
             PRAGMA user_version=8;
             COMMIT;"
        )?;
    }
    let current_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current_version == 8 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE custom_role_versions(
               role_id TEXT NOT NULL,
               version INTEGER NOT NULL CHECK(version>0),
               definition_json TEXT NOT NULL CHECK(json_valid(definition_json) AND json_type(definition_json)='object'),
               definition_sha256 TEXT NOT NULL CHECK(length(definition_sha256)=64),
               created_by TEXT NOT NULL CHECK(length(trim(created_by))>0),
               created_at TEXT NOT NULL,
               PRIMARY KEY(role_id,version)
             );
             CREATE INDEX custom_role_versions_latest ON custom_role_versions(role_id,version DESC);
             CREATE TRIGGER custom_role_versions_no_update BEFORE UPDATE ON custom_role_versions
               BEGIN SELECT RAISE(ABORT,'custom role versions are immutable'); END;
             CREATE TRIGGER custom_role_versions_no_delete BEFORE DELETE ON custom_role_versions
               BEGIN SELECT RAISE(ABORT,'custom role versions are retained'); END;
             CREATE TABLE custom_workflow_versions(
               workflow_id TEXT NOT NULL,
               version INTEGER NOT NULL CHECK(version>0),
               definition_json TEXT NOT NULL CHECK(json_valid(definition_json) AND json_type(definition_json)='object'),
               definition_sha256 TEXT NOT NULL CHECK(length(definition_sha256)=64),
               created_by TEXT NOT NULL CHECK(length(trim(created_by))>0),
               created_at TEXT NOT NULL,
               PRIMARY KEY(workflow_id,version)
             );
             CREATE INDEX custom_workflow_versions_latest ON custom_workflow_versions(workflow_id,version DESC);
             CREATE TRIGGER custom_workflow_versions_no_update BEFORE UPDATE ON custom_workflow_versions
               BEGIN SELECT RAISE(ABORT,'custom workflow versions are immutable'); END;
             CREATE TRIGGER custom_workflow_versions_no_delete BEFORE DELETE ON custom_workflow_versions
               BEGIN SELECT RAISE(ABORT,'custom workflow versions are retained'); END;
             CREATE TABLE custom_workflow_plans(
               plan_id TEXT PRIMARY KEY,
               workflow_id TEXT NOT NULL,
               workflow_version INTEGER NOT NULL CHECK(workflow_version>0),
               plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256)=64),
               plan_json TEXT NOT NULL CHECK(json_valid(plan_json) AND json_type(plan_json)='object'),
               created_by TEXT NOT NULL CHECK(length(trim(created_by))>0),
               created_at TEXT NOT NULL,
               FOREIGN KEY(workflow_id,workflow_version) REFERENCES custom_workflow_versions(workflow_id,version)
             );
             CREATE INDEX custom_workflow_plans_lookup ON custom_workflow_plans(workflow_id,workflow_version,created_at);
             CREATE TRIGGER custom_workflow_plans_no_update BEFORE UPDATE ON custom_workflow_plans
               BEGIN SELECT RAISE(ABORT,'compiled custom workflow plans are immutable'); END;
             CREATE TRIGGER custom_workflow_plans_no_delete BEFORE DELETE ON custom_workflow_plans
               BEGIN SELECT RAISE(ABORT,'compiled custom workflow plans are retained'); END;
             CREATE TABLE control_catalog_events(
               event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
               event_id TEXT NOT NULL UNIQUE,
               event_type TEXT NOT NULL,
               entity_id TEXT NOT NULL,
               entity_version INTEGER NOT NULL CHECK(entity_version>0),
               actor TEXT NOT NULL,
               content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
               created_at TEXT NOT NULL
             );
             CREATE TRIGGER control_catalog_events_no_update BEFORE UPDATE ON control_catalog_events
               BEGIN SELECT RAISE(ABORT,'control catalog events are append-only'); END;
             CREATE TRIGGER control_catalog_events_no_delete BEFORE DELETE ON control_catalog_events
               BEGIN SELECT RAISE(ABORT,'control catalog events are append-only'); END;
             PRAGMA user_version=9;
             COMMIT;"
        )?;
    }
    let current_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current_version == 9 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE governance_trust_configuration_versions(
               domain TEXT NOT NULL CHECK(length(trim(domain))>0),
               config_version INTEGER NOT NULL CHECK(config_version>0),
               provider_id TEXT NOT NULL CHECK(length(trim(provider_id))>0),
               configuration_fingerprint TEXT NOT NULL CHECK(length(configuration_fingerprint)=64),
               configuration_json TEXT NOT NULL CHECK(json_valid(configuration_json) AND json_type(configuration_json)='object'),
               observed_at TEXT NOT NULL,
               PRIMARY KEY(domain,config_version)
             );
             CREATE INDEX governance_trust_configuration_latest
               ON governance_trust_configuration_versions(domain,config_version DESC);
             CREATE TRIGGER governance_trust_configuration_no_update BEFORE UPDATE ON governance_trust_configuration_versions
               BEGIN SELECT RAISE(ABORT,'Governance trust configuration versions are immutable'); END;
             CREATE TRIGGER governance_trust_configuration_no_delete BEFORE DELETE ON governance_trust_configuration_versions
               BEGIN SELECT RAISE(ABORT,'Governance trust configuration versions are retained'); END;
             CREATE TABLE governance_reviewer_identity_versions(
               subject TEXT NOT NULL CHECK(length(trim(subject))>0),
               version INTEGER NOT NULL CHECK(version>0),
               status TEXT NOT NULL CHECK(status IN ('ACTIVE','SUSPENDED','REVOKED')),
               public_key_sha256 TEXT NOT NULL CHECK(length(public_key_sha256)=64),
               identity_json TEXT NOT NULL CHECK(json_valid(identity_json) AND json_type(identity_json)='object'),
               changed_at TEXT NOT NULL,
               PRIMARY KEY(subject,version)
             );
             CREATE INDEX governance_reviewer_identity_latest
               ON governance_reviewer_identity_versions(subject,version DESC);
             CREATE TRIGGER governance_reviewer_identity_no_update BEFORE UPDATE ON governance_reviewer_identity_versions
               BEGIN SELECT RAISE(ABORT,'Governance reviewer identity versions are immutable'); END;
             CREATE TRIGGER governance_reviewer_identity_no_delete BEFORE DELETE ON governance_reviewer_identity_versions
               BEGIN SELECT RAISE(ABORT,'Governance reviewer identity versions are retained'); END;
             PRAGMA user_version=10;
             COMMIT;"
        )?;
    }
    let current_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current_version == 10 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE workflow_policy_versions(
               policy_id TEXT NOT NULL CHECK(length(policy_id) BETWEEN 1 AND 38),
               version INTEGER NOT NULL CHECK(version>0),
               definition_json TEXT NOT NULL CHECK(json_valid(definition_json) AND json_type(definition_json)='object'),
               content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
               created_by TEXT NOT NULL CHECK(length(trim(created_by))>0 AND created_by!='mcp:unattributed'),
               created_at TEXT NOT NULL,
               PRIMARY KEY(policy_id,version)
             );
             CREATE INDEX workflow_policy_versions_latest ON workflow_policy_versions(policy_id,version DESC);
             CREATE TRIGGER workflow_policy_versions_no_update BEFORE UPDATE ON workflow_policy_versions
               BEGIN SELECT RAISE(ABORT,'workflow policy versions are immutable'); END;
             CREATE TRIGGER workflow_policy_versions_no_delete BEFORE DELETE ON workflow_policy_versions
               BEGIN SELECT RAISE(ABORT,'workflow policy versions are retained'); END;
             CREATE TABLE workflow_policy_attachments(
               workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
               policy_id TEXT NOT NULL,
               version INTEGER NOT NULL CHECK(version>0),
               content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
               attached_by TEXT NOT NULL CHECK(length(trim(attached_by))>0 AND attached_by!='mcp:unattributed'),
               attached_at TEXT NOT NULL,
               PRIMARY KEY(workflow_id,policy_id),
               FOREIGN KEY(policy_id,version) REFERENCES workflow_policy_versions(policy_id,version)
             );
             CREATE TRIGGER workflow_policy_attachments_no_update BEFORE UPDATE ON workflow_policy_attachments
               BEGIN SELECT RAISE(ABORT,'workflow policy attachments are immutable'); END;
             CREATE TRIGGER workflow_policy_attachments_no_delete BEFORE DELETE ON workflow_policy_attachments
               BEGIN SELECT RAISE(ABORT,'workflow policy attachments are retained'); END;
             CREATE TABLE workflow_success_contracts(
               workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
               version INTEGER NOT NULL CHECK(version>0),
               base_contract_json TEXT NOT NULL CHECK(json_valid(base_contract_json) AND json_type(base_contract_json)='object'),
               composed_contract_json TEXT NOT NULL CHECK(json_valid(composed_contract_json) AND json_type(composed_contract_json)='object'),
               policy_pins_json TEXT NOT NULL CHECK(json_valid(policy_pins_json) AND json_type(policy_pins_json)='array'),
               content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
               plan_sha256 TEXT CHECK(plan_sha256 IS NULL OR length(plan_sha256)=64),
               created_by TEXT NOT NULL CHECK(length(trim(created_by))>0 AND created_by!='mcp:unattributed'),
               created_at TEXT NOT NULL,
               PRIMARY KEY(workflow_id,version)
             );
             CREATE TRIGGER workflow_success_contracts_no_delete BEFORE DELETE ON workflow_success_contracts
               BEGIN SELECT RAISE(ABORT,'workflow success contracts are retained'); END;
             CREATE TRIGGER workflow_success_contracts_pin_once BEFORE UPDATE ON workflow_success_contracts
               WHEN NOT (OLD.workflow_id=NEW.workflow_id AND OLD.version=NEW.version
                 AND OLD.base_contract_json=NEW.base_contract_json
                 AND OLD.composed_contract_json=NEW.composed_contract_json
                 AND OLD.policy_pins_json=NEW.policy_pins_json
                 AND OLD.content_sha256=NEW.content_sha256
                 AND OLD.created_by=NEW.created_by AND OLD.created_at=NEW.created_at
                 AND OLD.plan_sha256 IS NULL AND NEW.plan_sha256 IS NOT NULL
                 AND EXISTS(SELECT 1 FROM workflows w WHERE w.workflow_id=NEW.workflow_id
                   AND w.state='APPROVED' AND w.plan_sha256=NEW.plan_sha256))
               BEGIN SELECT RAISE(ABORT,'success contract is immutable except for its first approved plan pin'); END;
             CREATE TABLE workflow_policy_events(
               event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
               event_id TEXT NOT NULL UNIQUE,
               workflow_id TEXT REFERENCES workflows(workflow_id),
               policy_id TEXT NOT NULL,
               version INTEGER,
               event_type TEXT NOT NULL,
               payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json)='object'),
               actor TEXT NOT NULL CHECK(length(trim(actor))>0 AND actor!='mcp:unattributed'),
               created_at TEXT NOT NULL
             );
             CREATE TRIGGER workflow_policy_events_no_update BEFORE UPDATE ON workflow_policy_events
               BEGIN SELECT RAISE(ABORT,'workflow policy events are append-only'); END;
             CREATE TRIGGER workflow_policy_events_no_delete BEFORE DELETE ON workflow_policy_events
               BEGIN SELECT RAISE(ABORT,'workflow policy events are append-only'); END;
             CREATE INDEX workflow_policy_events_lookup ON workflow_policy_events(policy_id,event_seq);
             PRAGMA user_version=11;
             COMMIT;"
        )?;
    }
    let current_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current_version == 11 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE agg_attestation_nonces(
               nonce TEXT PRIMARY KEY CHECK(length(nonce) BETWEEN 64 AND 128),
               operation_id TEXT NOT NULL CHECK(length(trim(operation_id))>0),
               checkpoint_sha256 TEXT NOT NULL CHECK(length(checkpoint_sha256)=64),
               consumed_at TEXT NOT NULL
             );
             CREATE TRIGGER agg_attestation_nonces_no_update BEFORE UPDATE ON agg_attestation_nonces
               BEGIN SELECT RAISE(ABORT,'AGG attestation nonce ledger is append-only'); END;
             CREATE TRIGGER agg_attestation_nonces_no_delete BEFORE DELETE ON agg_attestation_nonces
               BEGIN SELECT RAISE(ABORT,'AGG attestation nonce ledger is retained'); END;
             PRAGMA user_version=12;
             COMMIT;",
        )?;
    }
    let current_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current_version == 12 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE workflow_result_inbox(
               event_id TEXT PRIMARY KEY CHECK(length(event_id) BETWEEN 1 AND 128),
               workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
               plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256)=64),
               task_id TEXT NOT NULL,
               attempt INTEGER NOT NULL CHECK(attempt>0),
               producer_id TEXT NOT NULL CHECK(length(trim(producer_id))>0),
               provenance_sha256 TEXT NOT NULL CHECK(length(provenance_sha256)=64),
               payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
               payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json)='object'),
               state TEXT NOT NULL CHECK(state='COMMITTED'),
               recorded_at TEXT NOT NULL,
               UNIQUE(workflow_id,task_id,attempt)
             );
             CREATE INDEX workflow_result_inbox_workflow ON workflow_result_inbox(workflow_id,recorded_at);
             CREATE TRIGGER workflow_result_inbox_no_update BEFORE UPDATE ON workflow_result_inbox
               BEGIN SELECT RAISE(ABORT,'workflow result inbox is immutable'); END;
             CREATE TRIGGER workflow_result_inbox_no_delete BEFORE DELETE ON workflow_result_inbox
               BEGIN SELECT RAISE(ABORT,'workflow result inbox is retained'); END;
             PRAGMA user_version=13;
             COMMIT;"
        )?;
    }
    let current_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current_version == 13 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE custom_role_trusted_skill_pins(
               role_id TEXT NOT NULL,
               role_version INTEGER NOT NULL CHECK(role_version>0),
               reference TEXT NOT NULL CHECK(length(trim(reference)) BETWEEN 1 AND 2048),
               skill_id TEXT NOT NULL CHECK(length(trim(skill_id)) BETWEEN 1 AND 200),
               skill_version INTEGER NOT NULL CHECK(skill_version>0),
               content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
               verified_at TEXT NOT NULL,
               PRIMARY KEY(role_id,role_version,reference),
               FOREIGN KEY(role_id,role_version) REFERENCES custom_role_versions(role_id,version)
             );
             CREATE INDEX custom_role_skill_pins_identity ON custom_role_trusted_skill_pins(skill_id,skill_version);
             CREATE TRIGGER custom_role_skill_pins_no_update BEFORE UPDATE ON custom_role_trusted_skill_pins
               BEGIN SELECT RAISE(ABORT,'trusted skill pins are immutable'); END;
             CREATE TRIGGER custom_role_skill_pins_no_delete BEFORE DELETE ON custom_role_trusted_skill_pins
               BEGIN SELECT RAISE(ABORT,'trusted skill pins are retained'); END;
             PRAGMA user_version=14;
             COMMIT;",
        )?;
    }
    let current_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current_version == 14 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE agg_checkpoint_operations(
               operation_id TEXT PRIMARY KEY CHECK(length(trim(operation_id)) BETWEEN 1 AND 256),
               request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
               request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json)='object'),
               nonce TEXT NOT NULL UNIQUE CHECK(length(nonce) BETWEEN 64 AND 128 AND nonce NOT GLOB '*[^0-9a-f]*'),
               logical_db_id TEXT NOT NULL CHECK(length(trim(logical_db_id)) BETWEEN 1 AND 256),
               db_generation INTEGER NOT NULL CHECK(db_generation>0),
               restore_epoch INTEGER NOT NULL CHECK(restore_epoch>=0),
               expected_sequence INTEGER NOT NULL CHECK(expected_sequence>=0),
               expected_head_sha256 TEXT CHECK(expected_head_sha256 IS NULL OR (length(expected_head_sha256)=64 AND expected_head_sha256 NOT GLOB '*[^0-9a-f]*')),
               transition_sha256 TEXT NOT NULL CHECK(length(transition_sha256)=64 AND transition_sha256 NOT GLOB '*[^0-9a-f]*'),
               manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
               manifest_version INTEGER NOT NULL CHECK(manifest_version>0),
               expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>0),
               owner_id TEXT NOT NULL CHECK(length(trim(owner_id)) BETWEEN 1 AND 256),
               fencing_token INTEGER NOT NULL CHECK(fencing_token>0),
               state TEXT NOT NULL CHECK(state IN ('INTENT_PENDING','REMOTE_RESERVED','ANCHOR_PENDING','ANCHORED','ABORTED','QUARANTINED')),
               authority_receipt_json TEXT CHECK(authority_receipt_json IS NULL OR (json_valid(authority_receipt_json) AND json_type(authority_receipt_json)='object')),
               measurement_json TEXT CHECK(measurement_json IS NULL OR (json_valid(measurement_json) AND json_type(measurement_json)='object')),
               reason TEXT,
               created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
               updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=created_at_ms)
             );
             CREATE INDEX agg_checkpoint_operations_unresolved ON agg_checkpoint_operations(logical_db_id,state,created_at_ms);
             CREATE TRIGGER agg_checkpoint_operations_identity_immutable
               BEFORE UPDATE ON agg_checkpoint_operations
               WHEN OLD.operation_id!=NEW.operation_id OR OLD.request_sha256!=NEW.request_sha256
                 OR OLD.request_json!=NEW.request_json OR OLD.nonce!=NEW.nonce
                 OR OLD.logical_db_id!=NEW.logical_db_id OR OLD.db_generation!=NEW.db_generation
                 OR OLD.restore_epoch!=NEW.restore_epoch OR OLD.expected_sequence!=NEW.expected_sequence
                 OR OLD.expected_head_sha256 IS NOT NEW.expected_head_sha256
                 OR OLD.transition_sha256!=NEW.transition_sha256 OR OLD.manifest_sha256!=NEW.manifest_sha256
                 OR OLD.manifest_version!=NEW.manifest_version OR OLD.expires_at_ms!=NEW.expires_at_ms
                 OR OLD.owner_id!=NEW.owner_id OR OLD.fencing_token!=NEW.fencing_token
               BEGIN SELECT RAISE(ABORT,'checkpoint operation identity is immutable'); END;
             CREATE TRIGGER agg_checkpoint_operations_state_transition
               BEFORE UPDATE OF state ON agg_checkpoint_operations
               WHEN NOT ((OLD.state='INTENT_PENDING' AND NEW.state IN ('REMOTE_RESERVED','ABORTED','QUARANTINED'))
                 OR (OLD.state='REMOTE_RESERVED' AND NEW.state IN ('ANCHOR_PENDING','ABORTED','QUARANTINED'))
                 OR (OLD.state='ANCHOR_PENDING' AND NEW.state IN ('ANCHORED','QUARANTINED')))
               BEGIN SELECT RAISE(ABORT,'invalid checkpoint operation state transition'); END;
             CREATE TRIGGER agg_checkpoint_operations_no_delete BEFORE DELETE ON agg_checkpoint_operations
               BEGIN SELECT RAISE(ABORT,'checkpoint operation history is retained'); END;
             CREATE TABLE agg_checkpoint_operation_events(
               event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
               event_id TEXT NOT NULL UNIQUE,
               operation_id TEXT NOT NULL REFERENCES agg_checkpoint_operations(operation_id),
               event_type TEXT NOT NULL CHECK(event_type IN ('INTENT_PENDING','REMOTE_RESERVED','ABORTED','QUARANTINED')),
               state TEXT NOT NULL CHECK(state IN ('INTENT_PENDING','REMOTE_RESERVED','ABORTED','QUARANTINED')),
               fencing_token INTEGER NOT NULL CHECK(fencing_token>0),
               payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json)='object'),
               created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0)
             );
             CREATE INDEX agg_checkpoint_operation_events_lookup ON agg_checkpoint_operation_events(operation_id,event_seq);
             CREATE TRIGGER agg_checkpoint_operation_events_no_update BEFORE UPDATE ON agg_checkpoint_operation_events
               BEGIN SELECT RAISE(ABORT,'checkpoint operation events are append-only'); END;
             CREATE TRIGGER agg_checkpoint_operation_events_no_delete BEFORE DELETE ON agg_checkpoint_operation_events
               BEGIN SELECT RAISE(ABORT,'checkpoint operation events are append-only'); END;
             CREATE TABLE agg_checkpoint_transition_gate(
               logical_db_id TEXT PRIMARY KEY CHECK(length(trim(logical_db_id)) BETWEEN 1 AND 256),
               owner_id TEXT NOT NULL,
               fencing_token INTEGER NOT NULL CHECK(fencing_token>0),
               expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>=0),
               updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=0)
             );
             CREATE TRIGGER agg_checkpoint_transition_gate_fencing
               BEFORE UPDATE ON agg_checkpoint_transition_gate
               WHEN NEW.fencing_token<OLD.fencing_token
                 OR (NEW.fencing_token=OLD.fencing_token AND OLD.owner_id!='' AND NEW.owner_id NOT IN (OLD.owner_id,''))
               BEGIN SELECT RAISE(ABORT,'checkpoint transition gate fencing token regressed or owner changed'); END;
             CREATE TABLE agg_checkpoint_store_quarantine(
               singleton INTEGER PRIMARY KEY CHECK(singleton=1),
               logical_db_id TEXT NOT NULL,
               operation_id TEXT NOT NULL REFERENCES agg_checkpoint_operations(operation_id),
               reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
               fencing_token INTEGER NOT NULL CHECK(fencing_token>0),
               quarantined_at_ms INTEGER NOT NULL CHECK(quarantined_at_ms>=0)
             );
             CREATE TRIGGER agg_checkpoint_store_quarantine_no_update BEFORE UPDATE ON agg_checkpoint_store_quarantine
               BEGIN SELECT RAISE(ABORT,'checkpoint store quarantine requires an explicit recovery procedure'); END;
             CREATE TRIGGER agg_checkpoint_store_quarantine_no_delete BEFORE DELETE ON agg_checkpoint_store_quarantine
               BEGIN SELECT RAISE(ABORT,'checkpoint store quarantine requires an explicit recovery procedure'); END;
             PRAGMA user_version=15;
             COMMIT;",
        )?;
    }
    let current_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current_version == 15 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE store_connection_probes(
               probe_id TEXT PRIMARY KEY,
               created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0)
             );
             PRAGMA user_version=16;
             COMMIT;",
        )?;
    }
    let current_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current_version == 16 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE governance_decisions(
               decision_id TEXT PRIMARY KEY CHECK(length(trim(decision_id)) BETWEEN 1 AND 256),
               request_id TEXT NOT NULL UNIQUE CHECK(length(trim(request_id)) BETWEEN 1 AND 256),
               idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) BETWEEN 1 AND 256),
               request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
               evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
               subject_json TEXT NOT NULL CHECK(json_valid(subject_json) AND json_type(subject_json)='object'),
               outcome_json TEXT NOT NULL CHECK(json_valid(outcome_json) AND json_type(outcome_json)='object'),
               created_at TEXT NOT NULL
             );
             CREATE TABLE governance_decision_events(
               event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
               event_id TEXT NOT NULL UNIQUE,
               decision_id TEXT NOT NULL REFERENCES governance_decisions(decision_id),
               event_type TEXT NOT NULL CHECK(event_type='committed'),
               payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json)='object'),
               created_at TEXT NOT NULL
             );
             CREATE INDEX governance_decision_events_lookup ON governance_decision_events(decision_id,event_seq);
             CREATE TRIGGER governance_decisions_no_update BEFORE UPDATE ON governance_decisions
               BEGIN SELECT RAISE(ABORT,'Governance decisions are immutable'); END;
             CREATE TRIGGER governance_decisions_no_delete BEFORE DELETE ON governance_decisions
               BEGIN SELECT RAISE(ABORT,'Governance decisions are immutable'); END;
             CREATE TRIGGER governance_decision_events_no_update BEFORE UPDATE ON governance_decision_events
               BEGIN SELECT RAISE(ABORT,'Governance decision events are append-only'); END;
             CREATE TRIGGER governance_decision_events_no_delete BEFORE DELETE ON governance_decision_events
               BEGIN SELECT RAISE(ABORT,'Governance decision events are append-only'); END;
             PRAGMA user_version=17;
             COMMIT;",
        )?;
    }
    let current_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current_version == 17 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             ALTER TABLE governance_decisions ADD COLUMN receipt_json TEXT
               CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND json_type(receipt_json)='object'));
             PRAGMA user_version=18;
             COMMIT;",
        )?;
    }
    let current_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current_version == 18 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             DROP TRIGGER task_lease_fence_guard;
             CREATE TRIGGER task_lease_fence_guard
             BEFORE UPDATE OF attempts,lease_id,lease_owner,lease_expires_at ON tasks
             WHEN NOT (
               (OLD.state='PENDING' AND NEW.state='RUNNING' AND NEW.attempts=OLD.attempts+1
                 AND NEW.lease_id IS NOT NULL AND NEW.lease_owner IS NOT NULL AND NEW.lease_expires_at IS NOT NULL) OR
               (OLD.state='RUNNING' AND NEW.state='RUNNING' AND NEW.attempts=OLD.attempts
                 AND NEW.owner_epoch=OLD.owner_epoch AND NEW.lease_id=OLD.lease_id
                 AND NEW.lease_owner=OLD.lease_owner AND NEW.lease_expires_at>OLD.lease_expires_at) OR
               (OLD.state='RUNNING' AND NEW.state IN ('SUCCEEDED','FAILED','UNKNOWN')
                 AND NEW.attempts=OLD.attempts AND NEW.lease_id IS NULL
                 AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL)
             )
             BEGIN SELECT RAISE(ABORT,'task lease identity is fenced'); END;

             CREATE TABLE task_lease_renewals(
               renewal_id TEXT PRIMARY KEY CHECK(length(trim(renewal_id)) BETWEEN 1 AND 256),
               workflow_id TEXT NOT NULL,
               task_id TEXT NOT NULL,
               attempt INTEGER NOT NULL CHECK(attempt>0),
               owner_epoch INTEGER NOT NULL CHECK(owner_epoch>0),
               lease_id TEXT NOT NULL,
               worker_id TEXT NOT NULL,
               lease_ttl_seconds INTEGER NOT NULL CHECK(lease_ttl_seconds BETWEEN 1 AND 600),
               previous_expires_at TEXT NOT NULL,
               expires_at TEXT NOT NULL CHECK(expires_at>previous_expires_at),
               renewed_at TEXT NOT NULL,
               FOREIGN KEY(workflow_id,task_id,attempt)
                 REFERENCES task_attempts(workflow_id,task_id,attempt)
             );
             CREATE INDEX task_lease_renewals_attempt
               ON task_lease_renewals(workflow_id,task_id,attempt,renewed_at);
             CREATE TRIGGER task_lease_renewals_insert_guard BEFORE INSERT ON task_lease_renewals
               WHEN NOT EXISTS(
                 SELECT 1 FROM tasks t JOIN task_attempts a
                   ON a.workflow_id=t.workflow_id AND a.task_id=t.task_id AND a.attempt=t.attempts
                 WHERE t.workflow_id=NEW.workflow_id AND t.task_id=NEW.task_id
                   AND t.state='RUNNING' AND t.attempts=NEW.attempt
                   AND t.owner_epoch=NEW.owner_epoch AND t.lease_id=NEW.lease_id
                   AND t.lease_owner=NEW.worker_id AND t.lease_expires_at=NEW.expires_at
                   AND a.owner_epoch=NEW.owner_epoch AND a.lease_id=NEW.lease_id
                   AND a.worker_id=NEW.worker_id
               )
               BEGIN SELECT RAISE(ABORT,'lease renewal does not match the current task owner'); END;
             CREATE TRIGGER task_lease_renewals_no_update BEFORE UPDATE ON task_lease_renewals
               BEGIN SELECT RAISE(ABORT,'task lease renewal ledger is append-only'); END;
             CREATE TRIGGER task_lease_renewals_no_delete BEFORE DELETE ON task_lease_renewals
               BEGIN SELECT RAISE(ABORT,'task lease renewal ledger is append-only'); END;

             CREATE TABLE worker_execution_fences(
               fence_id TEXT PRIMARY KEY CHECK(length(trim(fence_id)) BETWEEN 1 AND 256),
               claim_id TEXT NOT NULL CHECK(length(trim(claim_id)) BETWEEN 1 AND 256),
               workflow_id TEXT NOT NULL,
               task_id TEXT NOT NULL,
               attempt INTEGER NOT NULL CHECK(attempt>0),
               owner_epoch INTEGER NOT NULL CHECK(owner_epoch>0),
               lease_id TEXT NOT NULL,
               worker_id TEXT NOT NULL,
               plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256)=64 AND plan_sha256 NOT GLOB '*[^0-9a-f]*'),
               side_effect_id TEXT NOT NULL CHECK(length(trim(side_effect_id)) BETWEEN 1 AND 256),
               kind TEXT NOT NULL CHECK(kind IN ('sandbox_start','provider_dispatch','result_publish','session_delivery')),
               request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
               idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) BETWEEN 1 AND 512),
               acl_sha256 TEXT NOT NULL CHECK(length(acl_sha256)=64 AND acl_sha256 NOT GLOB '*[^0-9a-f]*'),
               state TEXT NOT NULL CHECK(state IN ('RESERVED','COMPLETED')),
               completion_json TEXT CHECK(completion_json IS NULL OR (json_valid(completion_json) AND json_type(completion_json)='object')),
               completion_sha256 TEXT CHECK(completion_sha256 IS NULL OR (length(completion_sha256)=64 AND completion_sha256 NOT GLOB '*[^0-9a-f]*')),
               receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND json_type(receipt_json)='object'),
               created_at TEXT NOT NULL,
               completed_at TEXT,
               UNIQUE(workflow_id,task_id,attempt,owner_epoch,kind,side_effect_id),
               FOREIGN KEY(workflow_id,task_id,attempt)
                 REFERENCES task_attempts(workflow_id,task_id,attempt),
               CHECK((state='RESERVED' AND completion_json IS NULL AND completion_sha256 IS NULL AND completed_at IS NULL)
                  OR (state='COMPLETED' AND completion_json IS NOT NULL AND completion_sha256 IS NOT NULL AND completed_at IS NOT NULL))
             );
             CREATE INDEX worker_execution_fences_attempt
               ON worker_execution_fences(workflow_id,task_id,attempt,owner_epoch,state);
             CREATE TRIGGER worker_execution_fences_insert_guard BEFORE INSERT ON worker_execution_fences
               WHEN NOT EXISTS(
                 SELECT 1 FROM tasks t JOIN task_attempts a
                   ON a.workflow_id=t.workflow_id AND a.task_id=t.task_id AND a.attempt=t.attempts
                 WHERE t.workflow_id=NEW.workflow_id AND t.task_id=NEW.task_id
                   AND t.state='RUNNING' AND t.attempts=NEW.attempt AND t.owner_epoch=NEW.owner_epoch
                   AND t.lease_id=NEW.lease_id AND t.lease_owner=NEW.worker_id
                   AND t.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
                   AND a.lease_id=NEW.lease_id AND a.worker_id=NEW.worker_id
               )
               BEGIN SELECT RAISE(ABORT,'execution fence does not match the current live task lease'); END;
             CREATE TRIGGER worker_execution_fences_update_guard BEFORE UPDATE ON worker_execution_fences
               WHEN NOT (
                 OLD.state='RESERVED' AND NEW.state='COMPLETED'
                 AND NEW.fence_id=OLD.fence_id AND NEW.claim_id=OLD.claim_id
                 AND NEW.workflow_id=OLD.workflow_id AND NEW.task_id=OLD.task_id
                 AND NEW.attempt=OLD.attempt AND NEW.owner_epoch=OLD.owner_epoch
                 AND NEW.lease_id=OLD.lease_id AND NEW.worker_id=OLD.worker_id
                 AND NEW.plan_sha256=OLD.plan_sha256 AND NEW.side_effect_id=OLD.side_effect_id
                 AND NEW.kind=OLD.kind AND NEW.request_sha256=OLD.request_sha256
                 AND NEW.idempotency_key=OLD.idempotency_key AND NEW.acl_sha256=OLD.acl_sha256
                 AND NEW.created_at=OLD.created_at AND NEW.completion_json IS NOT NULL
                 AND NEW.completion_sha256 IS NOT NULL AND NEW.completed_at IS NOT NULL
               )
               BEGIN SELECT RAISE(ABORT,'execution fence can only transition once from RESERVED to COMPLETED'); END;
             CREATE TRIGGER worker_execution_fences_no_delete BEFORE DELETE ON worker_execution_fences
               BEGIN SELECT RAISE(ABORT,'worker execution fences are append-only'); END;
             PRAGMA user_version=19;
             COMMIT;",
        )?;
    }
    let current_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current_version == 19 {
        migrate_v19_to_v20(connection)?;
    }
    let final_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if final_version != SCHEMA_VERSION {
        return Err(StoreError::SchemaVersion(final_version));
    }
    Ok(())
}

fn migrate_v19_to_v20(connection: &Connection) -> Result<(), StoreError> {
    let transaction = connection.unchecked_transaction()?;
    let version: i64 = transaction.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version != 19 {
        return Err(StoreError::SchemaVersion(version));
    }

    transaction.execute_batch(
        "ALTER TABLE workflows ADD COLUMN cancellation_requested_at TEXT;
         DROP TRIGGER workflow_state_transition_guard;",
    )?;

    let mut statement = transaction.prepare(
        "SELECT w.workflow_id,w.plan_sha256,w.plan_json,e.payload_json,e.created_at,
                EXISTS(SELECT 1 FROM tasks t WHERE t.workflow_id=w.workflow_id AND t.attempts>0)
         FROM workflows w
         LEFT JOIN events e
           ON e.workflow_id=w.workflow_id
          AND e.idempotency_key='workflow.cancel:' || w.workflow_id
          AND e.event_type='workflow.cancel_requested'
         WHERE w.state='CANCELLED'
         ORDER BY w.workflow_id",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, bool>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);

    for (workflow_id, pinned_plan_sha256, plan_json, payload_json, requested_at, has_attempts) in
        rows
    {
        let payload_json = payload_json.ok_or_else(|| {
            StoreError::Invariant(format!(
                "legacy cancelled workflow with execution attempts has no cancellation request event: {workflow_id}"
            ))
        })?;
        let requested_at = requested_at.ok_or_else(|| {
            StoreError::Invariant(format!(
                "legacy cancelled workflow has no cancellation event timestamp: {workflow_id}"
            ))
        })?;
        if has_attempts && pinned_plan_sha256.is_none() {
            return Err(StoreError::Invariant(format!(
                "legacy cancelled workflow with execution attempts has no immutable plan: {workflow_id}"
            )));
        }
        let plan: WorkflowPlan = serde_json::from_str(&plan_json)?;
        let plan_content_sha256 =
            content_hash(&plan).map_err(|error| StoreError::Invariant(error.to_string()))?;
        if pinned_plan_sha256
            .as_deref()
            .is_some_and(|pinned| pinned != plan_content_sha256)
        {
            return Err(StoreError::Invariant(format!(
                "legacy cancelled workflow has a plan hash mismatch: {workflow_id}"
            )));
        }
        let payload: serde_json::Value = serde_json::from_str(&payload_json)?;
        let actor = payload
            .get("actor")
            .and_then(serde_json::Value::as_str)
            .filter(|value| {
                !value.trim().is_empty() && value.trim() == *value && value.len() <= 200
            });
        let reason = payload
            .get("reason")
            .and_then(serde_json::Value::as_str)
            .filter(|value| {
                !value.trim().is_empty() && value.trim() == *value && value.len() <= 2000
            });
        let event_plan_sha256 = payload
            .get("planSha256")
            .and_then(serde_json::Value::as_str);
        let plan_binding_matches = match pinned_plan_sha256.as_deref() {
            Some(pinned) => event_plan_sha256 == Some(pinned),
            None => {
                !has_attempts
                    && (event_plan_sha256.is_none()
                        || event_plan_sha256 == Some(plan_content_sha256.as_str()))
            }
        };
        if actor.is_none()
            || reason.is_none()
            || payload
                .get("runningLeasesRetained")
                .and_then(serde_json::Value::as_bool)
                != Some(true)
            || !plan_binding_matches
        {
            return Err(StoreError::Invariant(format!(
                "legacy cancellation request is not bound to its immutable workflow plan: {workflow_id}"
            )));
        }
        let integrity = verify_event_chain_connection(&transaction, &workflow_id)?;
        if !integrity.valid {
            return Err(StoreError::Invariant(format!(
                "cannot migrate a cancelled workflow with an invalid event chain: {workflow_id}"
            )));
        }
        let changed = transaction.execute(
            "UPDATE workflows
             SET state=CASE WHEN ?2 THEN 'EXECUTING' ELSE state END,
                 cancellation_requested_at=?1
             WHERE workflow_id=?3 AND state='CANCELLED' AND cancellation_requested_at IS NULL",
            params![requested_at, has_attempts, workflow_id],
        )?;
        if changed != 1 {
            return Err(StoreError::LeaseFenced);
        }
        if has_attempts {
            let migration_timestamp = now();
            insert_event(
                &transaction,
                &workflow_id,
                None,
                "workflow.cancel_request_reopened_for_reconciliation",
                &serde_json::json!({
                    "sourceSchemaVersion":19,
                    "originalCancellationEventKey":format!("workflow.cancel:{workflow_id}"),
                    "cancellationRequestedAt":requested_at,
                    "planSha256":plan_content_sha256,
                    "runningLeasesRetained":true,
                    "terminalizationReversed":true
                }),
                &format!("migration:v20:cancel-reconciliation:{workflow_id}"),
                &migration_timestamp,
            )?;
        }
    }

    transaction.execute_batch(
        "CREATE TRIGGER workflow_state_transition_guard
         BEFORE UPDATE OF state ON workflows
         WHEN NOT (
           (OLD.state='PROPOSED' AND NEW.state IN ('APPROVED','CANCELLED')) OR
           (OLD.state='APPROVED' AND NEW.state IN ('EXECUTING','CANCELLED')) OR
           (OLD.state='EXECUTING' AND NEW.state IN ('COMPLETED','FAILED','CANCELLED'))
         )
         BEGIN SELECT RAISE(ABORT,'invalid workflow state transition'); END;
         CREATE TRIGGER workflow_cancellation_request_append_only
         BEFORE UPDATE OF cancellation_requested_at ON workflows
         WHEN OLD.cancellation_requested_at IS NOT NULL OR NEW.cancellation_requested_at IS NULL
         BEGIN SELECT RAISE(ABORT,'workflow cancellation request is append-only'); END;
         PRAGMA user_version=20;",
    )?;
    transaction.commit()?;
    Ok(())
}

fn provider_store_error(error: ProviderPersistenceError) -> StoreError {
    match error {
        ProviderPersistenceError::Sqlite(error) => StoreError::Sqlite(error),
        ProviderPersistenceError::Json(error) => StoreError::Json(error),
        ProviderPersistenceError::Invalid(message) => StoreError::Invariant(message),
        ProviderPersistenceError::Conflict => StoreError::ProviderIntentConflict,
        ProviderPersistenceError::Finalized => StoreError::ProviderIntentFinalized,
        ProviderPersistenceError::NotFound(message) => StoreError::NotFound(message),
    }
}

fn ensure_store_not_quarantined(transaction: &Transaction<'_>) -> Result<(), StoreError> {
    let quarantine: Option<(String, String)> = transaction
        .query_row(
            "SELECT operation_id,reason FROM agg_checkpoint_store_quarantine WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((operation_id, reason)) = quarantine {
        return Err(StoreError::Invariant(format!(
            "workflow database is checkpoint-quarantined by operation {operation_id}: {reason}"
        )));
    }
    Ok(())
}

fn load_custom_role_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CustomRoleVersion> {
    let definition_json: String = row.get(0)?;
    let definition = serde_json::from_str(&definition_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(CustomRoleVersion {
        definition,
        definition_sha256: row.get(1)?,
        created_by: row.get(2)?,
        created_at: row.get(3)?,
    })
}

fn load_custom_workflow_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CustomWorkflowVersion> {
    let definition_json: String = row.get(0)?;
    let definition = serde_json::from_str(&definition_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(CustomWorkflowVersion {
        definition,
        definition_sha256: row.get(1)?,
        created_by: row.get(2)?,
        created_at: row.get(3)?,
    })
}

fn validate_catalog_actor(actor: &str) -> Result<&str, StoreError> {
    if actor.trim().is_empty()
        || actor.trim() != actor
        || actor == "mcp:unattributed"
        || actor.encode_utf16().count() > 200
    {
        return Err(StoreError::Invariant(
            "catalog actor must be a bounded non-empty identity".into(),
        ));
    }
    Ok(actor)
}

fn workflow_policy_digest(
    policy_id: &str,
    version: u32,
    definition: &WorkflowPolicyDefinition,
) -> Result<String, StoreError> {
    let definition = serde_json::to_value(definition)?;
    content_hash(&serde_json::json!({
        "policy_id":policy_id,"version":version,"definition":definition
    }))
    .map_err(|error| StoreError::Invariant(error.to_string()))
}

fn validate_workflow_policy_definition(
    definition: &WorkflowPolicyDefinition,
) -> Result<(), StoreError> {
    validate_catalog_slug(&definition.policy_id, "policy_id")?;
    if definition.policy_id.len() > 38 || definition.schema_version != 1 {
        return Err(StoreError::Invariant(
            "policy schema_version must be 1 and policy_id must not exceed 38 characters".into(),
        ));
    }
    if definition.name.trim().is_empty()
        || definition.name.trim() != definition.name
        || definition.name.len() > 120
    {
        return Err(StoreError::Invariant(
            "policy name must be a bounded non-empty string".into(),
        ));
    }
    if definition.description.len() > 2000
        || definition.description.trim() != definition.description
    {
        return Err(StoreError::Invariant(
            "policy description is invalid".into(),
        ));
    }
    if definition.constraints.len() + definition.success_criteria.len() == 0
        || definition.constraints.len() + definition.success_criteria.len() > 32
    {
        return Err(StoreError::Invariant(
            "policy must declare 1 to 32 enforceable rules".into(),
        ));
    }
    let mut ids = BTreeSet::new();
    for (field, rules) in [
        ("constraints", &definition.constraints),
        ("success_criteria", &definition.success_criteria),
    ] {
        for rule in rules {
            let normalized = normalize_policy_predicate(rule, field, 39)?;
            let id = normalized
                .get("id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            if !ids.insert(id.to_owned()) {
                return Err(StoreError::Invariant(format!(
                    "duplicate policy rule id: {id}"
                )));
            }
            if &normalized != rule {
                return Err(StoreError::Invariant(format!(
                    "policy {field} rule is not canonically normalized: {id}"
                )));
            }
        }
    }
    validate_policy_semantic_conflicts(
        definition
            .constraints
            .iter()
            .chain(definition.success_criteria.iter()),
    )?;
    Ok(())
}

fn normalize_policy_predicate(
    input: &serde_json::Value,
    field: &str,
    max_id_length: usize,
) -> Result<serde_json::Value, StoreError> {
    let object = input
        .as_object()
        .ok_or_else(|| StoreError::Invariant(format!("{field} rule must be an object")))?;
    let id = object
        .get("id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| StoreError::Invariant(format!("{field}.id is required")))?;
    validate_catalog_slug(id, "policy rule id")?;
    if id.len() > max_id_length {
        return Err(StoreError::Invariant(format!(
            "{field} rule id exceeds {max_id_length} characters"
        )));
    }
    let kind = object
        .get("type")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| StoreError::Invariant(format!("{field}.type is required")))?;
    let allowed: &[&str] = &[
        "all_tasks_completed",
        "local_execution_only",
        "workflow_id_equals",
        "task_status_equals",
        "execution_exit_code_equals",
        "task_role_present",
        "task_role_absent",
        "artifact_exists",
        "artifact_field_equals",
        "artifact_field_includes",
        "artifact_field_non_empty",
    ];
    if !allowed.contains(&kind) {
        return Err(StoreError::Invariant(format!(
            "unsupported policy predicate: {kind}"
        )));
    }
    let mut permitted = BTreeSet::from(["id", "type", "description"]);
    let require = |key: &str| -> Result<&serde_json::Value, StoreError> {
        object
            .get(key)
            .filter(|value| !value.is_null())
            .ok_or_else(|| StoreError::Invariant(format!("{field}.{key} is required for {kind}")))
    };
    let text = |key: &str, max: usize| -> Result<&str, StoreError> {
        let value = require(key)?
            .as_str()
            .ok_or_else(|| StoreError::Invariant(format!("{field}.{key} must be text")))?;
        if value.trim().is_empty() || value.trim() != value || value.len() > max {
            return Err(StoreError::Invariant(format!("{field}.{key} is invalid")));
        }
        Ok(value)
    };
    if let Some(description) = object.get("description") {
        let value = description
            .as_str()
            .ok_or_else(|| StoreError::Invariant(format!("{field}.description must be text")))?;
        if value.trim().is_empty() || value.trim() != value || value.len() > 2000 {
            return Err(StoreError::Invariant(format!(
                "{field}.description is invalid"
            )));
        }
    }
    match kind {
        "all_tasks_completed" | "local_execution_only" => {}
        "workflow_id_equals" => {
            permitted.insert("expected");
            let expected = text("expected", 80)?;
            validate_catalog_slug(expected, "workflow_id_equals.expected")?;
        }
        "task_status_equals" | "execution_exit_code_equals" => {
            permitted.insert("task_id");
            permitted.insert("expected");
            validate_catalog_slug(text("task_id", 80)?, "policy task_id")?;
            let expected = require("expected")?;
            if (kind == "task_status_equals" && expected.as_str() != Some("completed"))
                || (kind == "execution_exit_code_equals" && expected.as_i64() != Some(0))
            {
                return Err(StoreError::Invariant(format!(
                    "{field}.expected is not a success value"
                )));
            }
        }
        "task_role_present" | "task_role_absent" => {
            permitted.insert("role");
            validate_catalog_slug(text("role", 80)?, "policy role")?;
        }
        "artifact_exists"
        | "artifact_field_equals"
        | "artifact_field_includes"
        | "artifact_field_non_empty" => {
            permitted.insert("artifact_type");
            permitted.insert("producer_role");
            let artifact_type = text("artifact_type", 80)?;
            if ![
                "requirements",
                "research",
                "architecture",
                "implementation",
                "security-review",
                "qa-report",
                "platform-review",
                "documentation",
                "review",
                "cto-decision",
            ]
            .contains(&artifact_type)
            {
                return Err(StoreError::Invariant(
                    "unsupported policy artifact_type".into(),
                ));
            }
            if object.contains_key("producer_role") {
                validate_catalog_slug(text("producer_role", 80)?, "policy producer_role")?;
            }
            if kind != "artifact_exists" {
                permitted.insert("field");
                let field_name = text("field", 80)?;
                let mut chars = field_name.chars();
                if !chars.next().is_some_and(|c| c.is_ascii_alphabetic())
                    || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
                {
                    return Err(StoreError::Invariant(
                        "artifact predicate field must be a top-level JSON field".into(),
                    ));
                }
                if kind != "artifact_field_non_empty" {
                    permitted.insert("expected");
                    let expected = require("expected")?;
                    if !(expected.is_string()
                        || expected.is_boolean()
                        || expected.as_f64().is_some_and(f64::is_finite))
                    {
                        return Err(StoreError::Invariant(
                            "artifact predicate expected value must be a finite scalar".into(),
                        ));
                    }
                    if let Some(value) = expected.as_str() {
                        if value.trim().is_empty() || value.trim() != value || value.len() > 2000 {
                            return Err(StoreError::Invariant(
                                "artifact predicate expected text is invalid".into(),
                            ));
                        }
                    }
                }
            }
        }
        _ => unreachable!(),
    }
    if let Some(unknown) = object.keys().find(|key| !permitted.contains(key.as_str())) {
        return Err(StoreError::Invariant(format!(
            "{field} rule contains unsupported field: {unknown}"
        )));
    }
    Ok(input.clone())
}

fn normalize_success_contract_predicate(
    input: &serde_json::Value,
    field: &str,
) -> Result<serde_json::Value, StoreError> {
    let mut object = input
        .as_object()
        .cloned()
        .ok_or_else(|| StoreError::Invariant(format!("{field} rule must be an object")))?;
    let kind = object
        .get("type")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .map(str::to_owned);
    for key in [
        "id",
        "type",
        "description",
        "task_id",
        "role",
        "producer_role",
        "field",
    ] {
        if object.get(key).is_some_and(serde_json::Value::is_null)
            && matches!(key, "description" | "producer_role")
        {
            object.remove(key);
            continue;
        }
        if let Some(value) = object
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(|value| value.trim().to_owned())
        {
            object.insert(key.to_owned(), serde_json::Value::String(value));
        }
    }
    if matches!(
        kind.as_deref(),
        Some("workflow_id_equals" | "artifact_field_equals" | "artifact_field_includes")
    ) {
        if let Some(value) = object
            .get("expected")
            .and_then(serde_json::Value::as_str)
            .map(|value| value.trim().to_owned())
        {
            object.insert("expected".to_owned(), serde_json::Value::String(value));
        }
    }
    normalize_policy_predicate(&serde_json::Value::Object(object), field, 80)
}

fn normalize_success_contract(
    input: serde_json::Value,
    fallback_goal: &str,
) -> Result<serde_json::Value, StoreError> {
    let object = input
        .as_object()
        .ok_or_else(|| StoreError::Invariant("success contract must be an object".into()))?;
    if object.keys().any(|key| {
        ![
            "schema_version",
            "goal",
            "constraints",
            "success_criteria",
            "criteria",
        ]
        .contains(&key.as_str())
    }) {
        return Err(StoreError::Invariant(
            "success contract contains unsupported fields".into(),
        ));
    }
    if object
        .get("schema_version")
        .is_some_and(|value| value.as_u64() != Some(1))
    {
        return Err(StoreError::Invariant(
            "success_contract schema_version must be 1".into(),
        ));
    }
    let goal_value = object
        .get("goal")
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| serde_json::Value::String(fallback_goal.to_owned()));
    let goal = goal_value
        .as_str()
        .ok_or_else(|| StoreError::Invariant("success contract goal must be text".into()))?
        .trim();
    if goal.is_empty() || goal.len() > 4000 {
        return Err(StoreError::Invariant(
            "success contract goal is invalid".into(),
        ));
    }
    let read_rules =
        |key: &str, alias: Option<&str>| -> Result<Vec<serde_json::Value>, StoreError> {
            let Some(value) = object
                .get(key)
                .filter(|value| !value.is_null())
                .or_else(|| {
                    alias
                        .and_then(|name| object.get(name))
                        .filter(|value| !value.is_null())
                })
            else {
                return Ok(Vec::new());
            };
            let values = value.as_array().ok_or_else(|| {
                StoreError::Invariant(format!("success contract {key} must be an array"))
            })?;
            if values.len() > 32 {
                return Err(StoreError::Invariant(format!(
                    "success contract {key} exceeds 32 entries"
                )));
            }
            let mut ids = BTreeSet::new();
            values
                .iter()
                .map(|rule| {
                    let normalized = normalize_success_contract_predicate(rule, key)?;
                    let id = normalized
                        .get("id")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    if !ids.insert(id.to_owned()) {
                        return Err(StoreError::Invariant(format!(
                            "duplicate success contract rule id: {id}"
                        )));
                    }
                    Ok(normalized)
                })
                .collect()
        };
    let constraints = read_rules("constraints", None)?;
    let success_criteria = read_rules("success_criteria", Some("criteria"))?;
    let mut ids = BTreeSet::new();
    for rule in constraints.iter().chain(success_criteria.iter()) {
        let id = rule
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if !ids.insert(id.to_owned()) {
            return Err(StoreError::Invariant(format!(
                "duplicate success contract rule id: {id}"
            )));
        }
    }
    Ok(
        serde_json::json!({"schema_version":1,"goal":goal,"constraints":constraints,"success_criteria":success_criteria}),
    )
}

fn compose_success_contract(
    base: &serde_json::Value,
    policies: &[WorkflowPolicyVersion],
) -> Result<serde_json::Value, StoreError> {
    let object = base.as_object().ok_or_else(|| {
        StoreError::Invariant("normalized success contract is not an object".into())
    })?;
    let goal = object
        .get("goal")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| StoreError::Invariant("success contract goal is missing".into()))?;
    let mut constraints = object
        .get("constraints")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .ok_or_else(|| StoreError::Invariant("success contract constraints are invalid".into()))?;
    let mut criteria = object
        .get("success_criteria")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .ok_or_else(|| StoreError::Invariant("success contract criteria are invalid".into()))?;
    let mut ids: BTreeSet<String> = constraints
        .iter()
        .chain(criteria.iter())
        .filter_map(|rule| {
            rule.get("id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    for policy in policies {
        for (source, target) in [
            (&policy.definition.constraints, &mut constraints),
            (&policy.definition.success_criteria, &mut criteria),
        ] {
            for rule in source {
                let mut namespaced = rule.clone();
                let rule_id = rule
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| StoreError::Invariant("policy rule id missing".into()))?;
                let id = format!("p-{}-{rule_id}", policy.policy_id);
                if id.len() > 80 || !ids.insert(id.clone()) {
                    return Err(StoreError::Invariant(format!(
                        "policy predicate ID collision: {id}"
                    )));
                }
                namespaced
                    .as_object_mut()
                    .ok_or_else(|| {
                        StoreError::Invariant("policy predicate is not an object".into())
                    })?
                    .insert("id".into(), serde_json::Value::String(id));
                target.push(namespaced);
            }
        }
    }
    validate_policy_semantic_conflicts(constraints.iter().chain(criteria.iter()))?;
    Ok(
        serde_json::json!({"schema_version":1,"goal":goal,"constraints":constraints,"success_criteria":criteria}),
    )
}

fn validate_policy_semantic_conflicts<'a>(
    predicates: impl Iterator<Item = &'a serde_json::Value>,
) -> Result<(), StoreError> {
    let predicates: Vec<&serde_json::Value> = predicates.collect();
    let mut role_presence = BTreeMap::<String, bool>::new();
    let mut workflow_ids = BTreeSet::<String>::new();
    let mut artifact_fields = Vec::new();
    for rule in &predicates {
        let kind = rule
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if matches!(kind, "task_role_present" | "task_role_absent") {
            if let Some(role) = rule.get("role").and_then(serde_json::Value::as_str) {
                let desired = kind == "task_role_present";
                if role_presence
                    .insert(role.into(), desired)
                    .is_some_and(|previous| previous != desired)
                {
                    return Err(StoreError::Invariant(format!(
                        "conflicting policy predicates for role {role}"
                    )));
                }
            }
        }
        if kind == "workflow_id_equals" {
            if let Some(expected) = rule.get("expected").and_then(serde_json::Value::as_str) {
                workflow_ids.insert(expected.into());
            }
        }
        if kind.starts_with("artifact_field_") {
            artifact_fields.push(*rule);
        }
    }
    if workflow_ids.len() > 1 {
        return Err(StoreError::Invariant(
            "conflicting policy predicates require different workflow IDs".into(),
        ));
    }
    for (index, left) in artifact_fields.iter().enumerate() {
        for right in artifact_fields.iter().skip(index + 1) {
            if left.get("artifact_type") != right.get("artifact_type")
                || left.get("field") != right.get("field")
            {
                continue;
            }
            let left_role = left
                .get("producer_role")
                .and_then(serde_json::Value::as_str);
            let right_role = right
                .get("producer_role")
                .and_then(serde_json::Value::as_str);
            if left_role.is_some() && right_role.is_some() && left_role != right_role {
                continue;
            }
            let left_kind = left
                .get("type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let right_kind = right
                .get("type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let left_expected = left.get("expected");
            let right_expected = right.get("expected");
            let conflict =
                if left_kind == "artifact_field_equals" && right_kind == "artifact_field_equals" {
                    left_expected != right_expected
                } else if matches!(
                    (left_kind, right_kind),
                    ("artifact_field_equals", "artifact_field_includes")
                        | ("artifact_field_includes", "artifact_field_equals")
                ) {
                    true
                } else {
                    let equals = if left_kind == "artifact_field_equals" {
                        left_expected
                    } else if right_kind == "artifact_field_equals" {
                        right_expected
                    } else {
                        None
                    };
                    let non_empty = left_kind == "artifact_field_non_empty"
                        || right_kind == "artifact_field_non_empty";
                    equals.is_some_and(|value| non_empty && !value.is_string())
                };
            if conflict {
                let artifact_type = left
                    .get("artifact_type")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown");
                let field = left
                    .get("field")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown");
                return Err(StoreError::Invariant(format!(
                    "conflicting policy predicates for artifact field {artifact_type}.{field}"
                )));
            }
        }
    }
    Ok(())
}

fn validate_policy_plan_compatibility(
    _proposal: &WorkflowProposal,
    plan: &WorkflowPlan,
    policies: &[WorkflowPolicyVersion],
) -> Result<(), StoreError> {
    let task_ids: BTreeSet<&str> = plan
        .tasks
        .iter()
        .map(|task| task.task_id.as_str())
        .collect();
    let roles: BTreeSet<&str> = plan.tasks.iter().map(|task| task.role.as_str()).collect();
    for policy in policies {
        for rule in policy
            .definition
            .constraints
            .iter()
            .chain(policy.definition.success_criteria.iter())
        {
            let kind = rule
                .get("type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            // The catalog workflow slug is not modeled independently from the
            // job_* instance ID in WorkflowProposal. Do not reject or satisfy
            // this predicate using the wrong identity domain; evaluation keeps
            // it UNRESOLVED until the typed workflow kind is persisted.
            if matches!(kind, "task_role_present" | "task_role_absent") {
                let role = rule
                    .get("role")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                let present = roles.contains(role);
                if (kind == "task_role_present" && !present)
                    || (kind == "task_role_absent" && present)
                {
                    return Err(StoreError::Invariant(format!(
                        "policy {} role predicate is incompatible with plan",
                        policy.policy_id
                    )));
                }
            }
            if matches!(kind, "task_status_equals" | "execution_exit_code_equals") {
                let task_id = rule
                    .get("task_id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                if !task_ids.contains(task_id) {
                    return Err(StoreError::Invariant(format!(
                        "policy {} references unknown plan task {task_id}",
                        policy.policy_id
                    )));
                }
            }
            if let Some(role) = rule
                .get("producer_role")
                .and_then(serde_json::Value::as_str)
            {
                if !roles.contains(role) {
                    return Err(StoreError::Invariant(format!(
                        "policy {} references unknown artifact producer role {role}",
                        policy.policy_id
                    )));
                }
            }
        }
    }
    Ok(())
}

fn load_workflow_policy(
    connection: &Connection,
    policy_id: &str,
    version: Option<u32>,
) -> Result<WorkflowPolicyVersion, StoreError> {
    let row = if let Some(version) = version {
        connection.query_row(
            "SELECT version,definition_json,content_sha256,created_by,created_at FROM workflow_policy_versions WHERE policy_id=?1 AND version=?2",
            params![policy_id,version],
            |row| Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?)),
        ).optional()?
    } else {
        connection.query_row(
            "SELECT version,definition_json,content_sha256,created_by,created_at FROM workflow_policy_versions WHERE policy_id=?1 ORDER BY version DESC LIMIT 1",
            params![policy_id],
            |row| Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?)),
        ).optional()?
    }.ok_or_else(|| StoreError::NotFound(format!("workflow policy {policy_id}")))?;
    let version = u32::try_from(row.0)
        .map_err(|_| StoreError::Invariant("invalid workflow policy version".into()))?;
    let definition: WorkflowPolicyDefinition = serde_json::from_str(&row.1)?;
    validate_workflow_policy_definition(&definition)?;
    if definition.policy_id != policy_id
        || serde_json::to_string(&definition)? != row.1
        || workflow_policy_digest(policy_id, version, &definition)? != row.2
    {
        return Err(StoreError::Invariant(format!(
            "workflow policy content integrity failure: {policy_id}@{version}"
        )));
    }
    Ok(WorkflowPolicyVersion {
        policy_id: policy_id.into(),
        version,
        definition,
        content_sha256: row.2,
        created_by: row.3,
        created_at: row.4,
    })
}

fn load_workflow_policy_attachments(
    connection: &Connection,
    workflow_id: &str,
) -> Result<Vec<WorkflowPolicyVersion>, StoreError> {
    let mut statement = connection.prepare("SELECT policy_id,version,content_sha256 FROM workflow_policy_attachments WHERE workflow_id=?1 ORDER BY policy_id")?;
    let rows = statement.query_map(params![workflow_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, u32>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let rows = rows.collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    rows.into_iter()
        .map(|(policy_id, version, digest)| {
            let policy = load_workflow_policy(connection, &policy_id, Some(version))?;
            if policy.content_sha256 != digest {
                return Err(StoreError::Invariant(format!(
                    "stale workflow policy pin: {policy_id}@{version}"
                )));
            }
            Ok(policy)
        })
        .collect()
}

struct WorkflowPolicyEvent<'a> {
    workflow_id: Option<&'a str>,
    policy_id: &'a str,
    version: Option<u32>,
    event_type: &'a str,
    payload: &'a serde_json::Value,
    actor: &'a str,
    created_at: &'a str,
}

fn insert_workflow_policy_event(
    transaction: &Transaction<'_>,
    event: WorkflowPolicyEvent<'_>,
) -> Result<(), StoreError> {
    transaction.execute(
        "INSERT INTO workflow_policy_events(event_id,workflow_id,policy_id,version,event_type,payload_json,actor,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![Uuid::new_v4().to_string(),event.workflow_id,event.policy_id,event.version,event.event_type,serde_json::to_string(event.payload)?,event.actor,event.created_at],
    )?;
    Ok(())
}

fn validate_catalog_slug(value: &str, field: &str) -> Result<(), StoreError> {
    let bytes = value.as_bytes();
    if value.is_empty()
        || value.len() > 80
        || !bytes[0].is_ascii_lowercase()
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        || value.ends_with('-')
        || value.contains("--")
    {
        return Err(StoreError::Invariant(format!(
            "{field} must be a lowercase slug"
        )));
    }
    Ok(())
}

fn custom_workflow_task_specs(plan: &CompiledWorkflowPlan) -> Result<Vec<TaskSpec>, StoreError> {
    plan.verify_digest()
        .map_err(|error| StoreError::Invariant(error.to_string()))?;
    plan.tasks()
        .iter()
        .enumerate()
        .map(|(index, task)| {
            let output_artifact_type = serde_json::to_value(task.output_artifact_type)?;
            let output_kind = output_artifact_type
                .as_str()
                .ok_or_else(|| {
                    StoreError::Invariant("compiled workflow output type is not a string".into())
                })?
                .to_owned();
            let mut inputs = BTreeMap::new();
            inputs.insert("custom_role_id".into(), serde_json::json!(task.role_id));
            inputs.insert(
                "custom_role_version".into(),
                serde_json::json!(task.role_version),
            );
            inputs.insert("custom_role_name".into(), serde_json::json!(task.role_name));
            inputs.insert(
                "input_contract".into(),
                serde_json::to_value(&task.input_contract)?,
            );
            inputs.insert("output_artifact_type".into(), output_artifact_type);
            inputs.insert(
                "execution_mode".into(),
                serde_json::json!(task.execution_mode),
            );
            inputs.insert(
                "deterministic".into(),
                serde_json::json!(task.deterministic),
            );
            Ok(TaskSpec {
                task_id: task.task_id.clone(),
                // Match Node's custom-workflow plan preview role namespace.
                role: format!("custom-task-{}", index + 1),
                description: format!("Execute {} ({})", task.role_name, task.task_id),
                depends_on: task.depends_on.clone(),
                required_evidence: vec![output_kind],
                inputs,
            })
        })
        .collect()
}

/// Return the catalog workflow slug only when an append-only binding event
/// authenticates the exact persisted custom plan and the complete derived task
/// projection. Ordinary proposals and caller-supplied metadata never establish it.
fn catalog_workflow_id_for_workflow(
    connection: &Connection,
    workflow: &WorkflowView,
) -> Result<Option<String>, StoreError> {
    let binding_key = format!("catalog-plan-bound:{}", workflow.workflow_id);
    let binding: Option<(String, String)> = connection
        .query_row(
            "SELECT event_type,payload_json FROM events WHERE workflow_id=?1 AND idempotency_key=?2",
            params![workflow.workflow_id, binding_key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((event_type, payload_json)) = binding else {
        return Ok(None);
    };
    if event_type != "workflow.catalog_plan_bound" {
        return Err(StoreError::Invariant(
            "catalog plan binding event has an unexpected event type".into(),
        ));
    }
    let chain = verify_event_chain_connection(connection, &workflow.workflow_id)?;
    if !chain.valid {
        return Err(StoreError::Invariant(
            "catalog plan binding requires a valid workflow event chain".into(),
        ));
    }
    let binding: serde_json::Value = serde_json::from_str(&payload_json)?;
    let plan_id = binding
        .get("catalog_plan_id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| StoreError::Invariant("catalog plan binding ID is missing".into()))?;
    let catalog_workflow_id = binding
        .get("catalog_workflow_id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| StoreError::Invariant("catalog workflow identity is missing".into()))?;
    validate_catalog_slug(catalog_workflow_id, "catalog_workflow_id")?;
    let catalog_workflow_version = binding
        .get("catalog_workflow_version")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| StoreError::Invariant("catalog workflow version is invalid".into()))?;
    let catalog_plan_sha256 = binding
        .get("catalog_plan_sha256")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| StoreError::Invariant("catalog plan digest is missing".into()))?;
    let workflow_plan_sha256 = binding
        .get("workflow_plan_sha256")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| StoreError::Invariant("workflow plan digest is missing".into()))?;
    if workflow_plan_sha256
        != content_hash(&workflow.plan).map_err(|error| StoreError::Invariant(error.to_string()))?
    {
        return Err(StoreError::Invariant(
            "catalog binding does not match the immutable workflow task plan".into(),
        ));
    }

    let (row_workflow_id, row_version, row_sha256, row_plan_json): (String, i64, String, String) =
        connection.query_row(
            "SELECT workflow_id,workflow_version,plan_sha256,plan_json FROM custom_workflow_plans WHERE plan_id=?1",
            params![plan_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
    let row_version = u32::try_from(row_version).map_err(|_| {
        StoreError::Invariant("persisted catalog workflow version is invalid".into())
    })?;
    let catalog_plan: CompiledWorkflowPlan = serde_json::from_str(&row_plan_json)?;
    catalog_plan
        .verify_digest()
        .map_err(|error| StoreError::Invariant(error.to_string()))?;
    if row_workflow_id != catalog_workflow_id
        || row_version != catalog_workflow_version
        || row_sha256 != catalog_plan_sha256
        || catalog_plan.workflow_id() != catalog_workflow_id
        || catalog_plan.workflow_version() != catalog_workflow_version
        || catalog_plan.plan_hash() != catalog_plan_sha256
        || custom_workflow_task_specs(&catalog_plan)? != workflow.plan.tasks
    {
        return Err(StoreError::Invariant(
            "catalog plan binding does not match its immutable compiled plan and task projection"
                .into(),
        ));
    }
    Ok(Some(catalog_workflow_id.to_owned()))
}

fn validate_custom_role_definition(definition: &CustomRoleDefinition) -> Result<(), StoreError> {
    validate_custom_role(definition, &BTreeSet::new())
        .map_err(|error| StoreError::Invariant(error.to_string()))
}

fn persist_verified_role_skills(
    transaction: &Transaction<'_>,
    definition: &CustomRoleDefinition,
    resolver: &dyn TrustedSkillResolver,
    verified_at: &str,
) -> Result<(), StoreError> {
    let mut available = BTreeSet::new();
    let mut identities = BTreeSet::new();
    for reference in &definition.skills {
        if reference.trim().is_empty() || reference.trim() != reference || reference.len() > 2048 {
            return Err(StoreError::Invariant(
                "trusted skill reference is invalid".into(),
            ));
        }
        let resolved = resolver.resolve_and_verify(transaction, reference)?;
        if resolved.reference != *reference
            || resolved.skill_id.trim().is_empty()
            || resolved.skill_id.trim() != resolved.skill_id
            || resolved.skill_id.len() > 200
            || resolved.version == 0
            || resolved.content_sha256.len() != 64
            || !resolved
                .content_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || !identities.insert(resolved.skill_id.clone())
            || !available.insert(reference.clone())
        {
            return Err(StoreError::Invariant(
                "trusted skill resolver returned a mismatched, duplicate or invalid exact pin"
                    .into(),
            ));
        }
        transaction.execute(
            "INSERT INTO custom_role_trusted_skill_pins(role_id,role_version,reference,skill_id,skill_version,content_sha256,verified_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![definition.role_id,definition.version,reference,resolved.skill_id,resolved.version,resolved.content_sha256,verified_at],
        )?;
    }
    validate_custom_role(definition, &available)
        .map_err(|error| StoreError::Invariant(error.to_string()))
}

fn revalidate_persisted_role_skills(
    transaction: &Transaction<'_>,
    definition: &CustomRoleDefinition,
    resolver: Option<&dyn TrustedSkillResolver>,
) -> Result<BTreeSet<String>, StoreError> {
    if definition.skills.is_empty() {
        let pin_count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM custom_role_trusted_skill_pins WHERE role_id=?1 AND role_version=?2",
            params![definition.role_id,definition.version], |row| row.get(0),
        )?;
        if pin_count != 0 {
            return Err(StoreError::Invariant(
                "trusted skill pins exist for a role with no skill references".into(),
            ));
        }
        return Ok(BTreeSet::new());
    }
    let resolver = resolver.ok_or_else(|| {
        StoreError::Invariant(
            "host trusted skill resolver is required to compile a role with skills".into(),
        )
    })?;
    let mut statement = transaction.prepare(
        "SELECT reference,skill_id,skill_version,content_sha256 FROM custom_role_trusted_skill_pins WHERE role_id=?1 AND role_version=?2 ORDER BY reference",
    )?;
    let pins = statement
        .query_map(params![definition.role_id, definition.version], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, u32>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    if pins.len() != definition.skills.len() {
        return Err(StoreError::Invariant(
            "custom role trusted skill pin set is incomplete or stale".into(),
        ));
    }
    let mut available = BTreeSet::new();
    for (reference, skill_id, version, digest) in pins {
        if !definition.skills.contains(&reference) {
            return Err(StoreError::Invariant(
                "trusted skill pin does not match immutable role reference".into(),
            ));
        }
        let current = resolver.resolve_and_verify(transaction, &reference)?;
        if current.reference != reference
            || current.skill_id != skill_id
            || current.version != version
            || current.content_sha256 != digest
        {
            return Err(StoreError::Invariant(format!(
                "trusted skill pin is revoked, stale or substituted: {skill_id}@{version}"
            )));
        }
        available.insert(reference);
    }
    validate_custom_role(definition, &available)
        .map_err(|error| StoreError::Invariant(error.to_string()))?;
    Ok(available)
}

fn compile_custom_workflow_from_catalog(
    transaction: &Transaction<'_>,
    definition: &CustomWorkflowDefinition,
    skill_resolver: Option<&dyn TrustedSkillResolver>,
) -> Result<CompiledWorkflowPlan, StoreError> {
    let mut roles = Vec::new();
    let mut available_skill_ids = BTreeSet::new();
    let mut seen = BTreeSet::new();
    for task in &definition.tasks {
        if !seen.insert((task.role_id.as_str(), task.role_version)) {
            continue;
        }
        let role_json: String = transaction
            .query_row(
                "SELECT definition_json FROM custom_role_versions WHERE role_id=?1 AND version=?2",
                params![task.role_id, task.role_version],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| {
                StoreError::NotFound(format!(
                    "custom role {}@{}",
                    task.role_id, task.role_version
                ))
            })?;
        let role: CustomRoleDefinition = serde_json::from_str(&role_json)?;
        available_skill_ids.extend(revalidate_persisted_role_skills(
            transaction,
            &role,
            skill_resolver,
        )?);
        roles.push(role);
    }
    compile_custom_workflow(definition, &roles, &available_skill_ids)
        .map_err(|error| StoreError::Invariant(error.to_string()))
}

fn validate_custom_workflow_definition(
    transaction: &Transaction<'_>,
    definition: &CustomWorkflowDefinition,
    skill_resolver: Option<&dyn TrustedSkillResolver>,
) -> Result<(), StoreError> {
    compile_custom_workflow_from_catalog(transaction, definition, skill_resolver).map(|_| ())
}

fn insert_catalog_event(
    transaction: &Transaction<'_>,
    event_type: &str,
    entity_id: &str,
    entity_version: u32,
    actor: &str,
    content_sha256: &str,
    created_at: &str,
) -> Result<(), StoreError> {
    transaction.execute(
        "INSERT INTO control_catalog_events(event_id,event_type,entity_id,entity_version,actor,content_sha256,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![Uuid::new_v4().to_string(), event_type, entity_id, entity_version, actor, content_sha256, created_at],
    )?;
    Ok(())
}

fn load_agent_session_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentSessionRecord> {
    let attempt: i64 = row.get(8)?;
    Ok(AgentSessionRecord {
        session_id: row.get(0)?,
        workflow_id: row.get(1)?,
        task_id: row.get(2)?,
        role: row.get(3)?,
        runtime_session_key: row.get(4)?,
        parent_session_key: row.get(5)?,
        state: row.get(6)?,
        current_turn_id: row.get(7)?,
        attempt: u64::try_from(attempt)
            .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(8, attempt))?,
        last_activity_at: row.get(9)?,
    })
}

fn load_agent_session(
    connection: &Connection,
    session_id: &str,
) -> Result<AgentSessionRecord, StoreError> {
    connection
        .query_row(
            "SELECT session_id,workflow_id,task_id,role,runtime_session_key,parent_session_key,state,current_turn_id,attempt,last_activity_at FROM agent_sessions WHERE session_id=?1",
            params![session_id],
            load_agent_session_row,
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound(format!("agent session {session_id}")))
}

fn canonical_session_role(value: &str) -> Result<String, StoreError> {
    let role = value.trim().to_lowercase();
    let role = if role == "productowner" {
        "product-owner".to_owned()
    } else {
        role
    };
    if role.is_empty()
        || role.len() > 80
        || !role
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err(StoreError::Invariant(
            "invalid session governance role".into(),
        ));
    }
    Ok(role)
}

fn is_canonical_utc(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value).is_ok_and(|parsed| {
        parsed.offset().local_minus_utc() == 0
            && parsed.to_rfc3339_opts(SecondsFormat::Millis, true) == value
    })
}

fn require_session_permission(
    connection: &Connection,
    session: &AgentSessionRecord,
    accessor_role: &str,
    permission: SessionPermission,
    at: &str,
) -> Result<(), StoreError> {
    let role = canonical_session_role(accessor_role)?;
    if role == session.role && permission != SessionPermission::Takeover {
        return Ok(());
    }
    if !is_canonical_utc(at) {
        return Err(StoreError::Invariant(
            "session permission check requires canonical UTC time".into(),
        ));
    }
    let granted: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM session_access WHERE session_id=?1 AND accessor_role=?2 AND permission=?3 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?4))",
        params![session.session_id,role,permission.as_db(),at],
        |row| row.get(0),
    )?;
    if granted {
        Ok(())
    } else {
        Err(StoreError::Invariant("session access denied".into()))
    }
}

fn load_session_message(
    connection: &Connection,
    message_id: &str,
) -> Result<SessionMessageRecord, StoreError> {
    load_session_message_optional(connection, message_id)?
        .ok_or_else(|| StoreError::NotFound(format!("session message {message_id}")))
}

fn load_session_access(
    connection: &Connection,
    session_id: &str,
) -> Result<Vec<SessionAccessRecord>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT access_id,session_id,accessor_role,permission,granted_by,expires_at,created_at,revoked_at FROM session_access WHERE session_id=?1 ORDER BY created_at,access_id",
    )?;
    let rows = statement.query_map(params![session_id], |row| {
        Ok(SessionAccessRecord {
            access_id: row.get(0)?,
            session_id: row.get(1)?,
            accessor_role: row.get(2)?,
            permission: row.get(3)?,
            granted_by: row.get(4)?,
            expires_at: row.get(5)?,
            created_at: row.get(6)?,
            revoked_at: row.get(7)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(StoreError::Sqlite)
}

fn load_session_message_optional(
    connection: &Connection,
    message_id: &str,
) -> Result<Option<SessionMessageRecord>, StoreError> {
    let row = connection.query_row(
        "SELECT message_id,session_id,sender_role,recipient_role,protocol,protocol_version,message_type,payload_json,correlation_id,dedupe_key,state,attempt,available_at,lease_until,transport_started_at,receipt_json FROM session_messages WHERE message_id=?1",
        params![message_id],
        |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,i64>(5)?,row.get::<_,String>(6)?,row.get::<_,String>(7)?,row.get::<_,Option<String>>(8)?,row.get::<_,Option<String>>(9)?,row.get::<_,String>(10)?,row.get::<_,i64>(11)?,row.get::<_,String>(12)?,row.get::<_,Option<String>>(13)?,row.get::<_,Option<String>>(14)?,row.get::<_,Option<String>>(15)?)),
    ).optional()?;
    row.map(|row| {
        Ok(SessionMessageRecord {
            message_id: row.0,
            session_id: row.1,
            sender_role: row.2,
            recipient_role: row.3,
            protocol: row.4,
            protocol_version: u64::try_from(row.5)
                .map_err(|_| StoreError::Invariant("invalid session protocol version".into()))?,
            message_type: row.6,
            payload: serde_json::from_str(&row.7)?,
            correlation_id: row.8,
            dedupe_key: row.9,
            state: row.10,
            attempt: u64::try_from(row.11)
                .map_err(|_| StoreError::Invariant("invalid session message attempt".into()))?,
            available_at: row.12,
            lease_until: row.13,
            transport_started_at: row.14,
            receipt: row
                .15
                .map(|value| serde_json::from_str(&value))
                .transpose()?,
            claim_acquired: false,
        })
    })
    .transpose()
}

fn provider_dispatch_state_db(state: ProviderDispatchState) -> &'static str {
    match state {
        ProviderDispatchState::Reserved => "RESERVED",
        ProviderDispatchState::Accepted => "ACCEPTED",
        ProviderDispatchState::Rejected => "REJECTED",
        ProviderDispatchState::Unknown => "UNKNOWN",
    }
}

fn load_graph_info_from(connection: &Connection, graph_id: &str) -> Result<GraphInfo, StoreError> {
    let row = connection
        .query_row(
            "SELECT revision,created_at,updated_at FROM graphs WHERE graph_id=?1",
            params![graph_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound(format!("graph {graph_id}")))?;
    if row.0 < 0 {
        return Err(StoreError::Invariant("negative graph revision".into()));
    }
    Ok(GraphInfo {
        graph_id: graph_id.into(),
        revision: row.0 as u64,
        created_at: row.1,
        updated_at: row.2,
    })
}

fn load_graph_node_revisions(
    connection: &Connection,
    graph_id: &str,
) -> Result<Vec<GraphNodeRevision>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT n.node_id,n.current_revision,n.current_revision_sha256,r.revision_json,r.revision_sha256 FROM graph_nodes n JOIN graph_node_revisions r ON r.graph_id=n.graph_id AND r.node_id=n.node_id AND r.revision=n.current_revision WHERE n.graph_id=?1 ORDER BY n.node_id",
    )?;
    let rows = statement
        .query_map(params![graph_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut nodes = Vec::with_capacity(rows.len());
    for (node_id, revision, head_hash, revision_json, stored_hash) in rows {
        let node: GraphNodeRevision = serde_json::from_str(&revision_json)?;
        node.validate()
            .map_err(|error| StoreError::Invariant(error.to_string()))?;
        let actual_hash = node
            .record_hash()
            .map_err(|error| StoreError::Invariant(error.to_string()))?;
        if node.node_id != node_id
            || node.revision != revision as u64
            || head_hash.as_deref() != Some(stored_hash.as_str())
            || stored_hash != actual_hash
        {
            return Err(StoreError::Invariant(format!(
                "graph node head/revision binding mismatch: {node_id}"
            )));
        }
        nodes.push(node);
    }
    Ok(nodes)
}

fn load_graph_edges(connection: &Connection, graph_id: &str) -> Result<Vec<GraphEdge>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT edge_id,from_node_id,to_node_id,kind,edge_json FROM graph_edges WHERE graph_id=?1 ORDER BY edge_id",
    )?;
    let rows = statement
        .query_map(params![graph_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut edges = Vec::with_capacity(rows.len());
    for (edge_id, from, to, kind, edge_json) in rows {
        let edge: GraphEdge = serde_json::from_str(&edge_json)?;
        let stored_kind = serde_json::to_value(edge.kind)?;
        if edge.edge_id != edge_id
            || edge.from_node_id != from
            || edge.to_node_id != to
            || stored_kind.as_str() != Some(kind.as_str())
        {
            return Err(StoreError::Invariant(format!(
                "graph edge row/payload binding mismatch: {edge_id}"
            )));
        }
        edges.push(edge);
    }
    Ok(edges)
}

fn load_graph_evidence(
    connection: &Connection,
    graph_id: &str,
) -> Result<Vec<GraphEvidence>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT evidence_id,node_id,source_uri,source_sha256,verification,evidence_json FROM graph_evidence WHERE graph_id=?1 ORDER BY evidence_id",
    )?;
    let rows = statement
        .query_map(params![graph_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut evidence_items = Vec::with_capacity(rows.len());
    for (evidence_id, node_id, source_uri, source_sha256, verification, evidence_json) in rows {
        let evidence: GraphEvidence = serde_json::from_str(&evidence_json)?;
        evidence
            .validate()
            .map_err(|error| StoreError::Invariant(error.to_string()))?;
        let stored_verification = serde_json::to_value(evidence.verification)?;
        if evidence.evidence_id != evidence_id
            || evidence.node_id != node_id
            || evidence.source_uri != source_uri
            || evidence.source_sha256 != source_sha256
            || stored_verification.as_str() != Some(verification.as_str())
        {
            return Err(StoreError::Invariant(format!(
                "graph evidence row/payload binding mismatch: {evidence_id}"
            )));
        }
        evidence_items.push(evidence);
    }
    Ok(evidence_items)
}

fn bump_graph_revision(
    transaction: &Transaction<'_>,
    graph_id: &str,
    timestamp: &str,
) -> Result<(), StoreError> {
    let changed = transaction.execute(
        "UPDATE graphs SET revision=revision+1,updated_at=?1 WHERE graph_id=?2 AND revision<9223372036854775807",
        params![timestamp, graph_id],
    )?;
    if changed != 1 {
        return Err(StoreError::NotFound(format!("graph {graph_id}")));
    }
    Ok(())
}

fn assert_current_approval(workflow: &WorkflowView) -> Result<(), StoreError> {
    let Some(approval) = &workflow.approval else {
        return Err(StoreError::ApprovalRequired);
    };
    let proposal_hash = content_hash(&workflow.proposal)
        .map_err(|error| StoreError::Invariant(error.to_string()))?;
    let plan_hash =
        content_hash(&workflow.plan).map_err(|error| StoreError::Invariant(error.to_string()))?;
    if workflow.proposal_hash != proposal_hash
        || workflow.plan_hash.as_deref() != Some(plan_hash.as_str())
        || approval.proposal_hash != proposal_hash
        || approval.plan_hash != plan_hash
    {
        return Err(StoreError::ApprovalRequired);
    }
    Ok(())
}

fn verify_current_approval(
    transaction: &Transaction<'_>,
    workflow: &WorkflowView,
    verifier: &dyn ApprovalVerifier,
) -> Result<(), StoreError> {
    assert_current_approval(workflow)?;
    let approval = workflow
        .approval
        .as_ref()
        .ok_or(StoreError::ApprovalRequired)?;
    let request = ApprovalRequest {
        actor: approval.actor.clone(),
        expected_proposal_hash: approval.proposal_hash.clone(),
        expected_plan_hash: approval.plan_hash.clone(),
        evidence: approval.evidence.clone(),
    };
    let verified = verifier.verify(
        transaction,
        &workflow.proposal,
        &workflow.plan,
        &request,
        ApprovalVerificationMode::Revalidate,
    )?;
    if verified.actor != approval.actor
        || verified.evidence != approval.evidence
        || verified.actor.trim().is_empty()
        || !verified.evidence.is_object()
    {
        return Err(StoreError::InvalidVerifierOutput);
    }
    verify_workflow_success_contract(
        transaction,
        &workflow.workflow_id,
        workflow.plan_hash.as_deref(),
        true,
    )?;
    Ok(())
}

fn evaluate_persisted_success_contract(
    connection: &Connection,
    workflow_id: &str,
) -> Result<serde_json::Value, StoreError> {
    let workflow = load_workflow_from(connection, workflow_id)?;
    let catalog_workflow_id = catalog_workflow_id_for_workflow(connection, &workflow)?;
    let (contract_version, contract_json, contract_sha256): (i64, String, String) = connection.query_row(
        "SELECT version,composed_contract_json,content_sha256 FROM workflow_success_contracts WHERE workflow_id=?1 ORDER BY version DESC LIMIT 1",
        params![workflow_id],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    )?;
    let contract: serde_json::Value = serde_json::from_str(&contract_json)?;
    let mut results = Vec::new();
    let mut failed = false;
    let mut unresolved = false;
    for (field, rules) in [
        (
            "constraints",
            contract
                .get("constraints")
                .and_then(serde_json::Value::as_array),
        ),
        (
            "success_criteria",
            contract
                .get("success_criteria")
                .and_then(serde_json::Value::as_array),
        ),
    ] {
        let rules = rules.ok_or_else(|| {
            StoreError::Invariant(format!("success contract {field} is missing or malformed"))
        })?;
        for rule in rules {
            let id = rule
                .get("id")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| StoreError::Invariant("success predicate ID is missing".into()))?;
            let kind = rule
                .get("type")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    StoreError::Invariant(format!("success predicate type missing: {id}"))
                })?;
            let mut actual = serde_json::Value::Null;
            let mut passed = false;
            let (disposition, reason) = match kind {
                "all_tasks_completed" => {
                    let incomplete: Vec<&str> = workflow
                        .tasks
                        .iter()
                        .filter(|task| task.state != TaskState::Succeeded)
                        .map(|task| task.definition.task_id.as_str())
                        .collect();
                    actual =
                        serde_json::json!({"planned":workflow.tasks.len(),"incomplete":incomplete});
                    passed = !workflow.tasks.is_empty() && incomplete.is_empty();
                    (
                        if passed { "PASS" } else { "FAIL" },
                        if passed {
                            None
                        } else {
                            Some("one or more immutable plan tasks are not completed")
                        },
                    )
                }
                "workflow_id_equals" => {
                    if let Some(catalog_workflow_id) = catalog_workflow_id.as_deref() {
                        actual = serde_json::Value::String(catalog_workflow_id.to_owned());
                        passed = actual.as_str()
                            == rule.get("expected").and_then(serde_json::Value::as_str);
                        (
                            if passed { "PASS" } else { "FAIL" },
                            if passed {
                                None
                            } else {
                                Some(
                                    "bound immutable catalog workflow slug does not match expected value",
                                )
                            },
                        )
                    } else {
                        // A job_* workflow instance ID is a different identity
                        // domain. Without an append-only exact catalog-plan
                        // binding, this predicate cannot be established.
                        unresolved = true;
                        (
                            "UNRESOLVED",
                            Some("workflow has no verified immutable catalog-plan binding"),
                        )
                    }
                }
                "task_status_equals" => {
                    let task_id = rule
                        .get("task_id")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    let task = workflow
                        .tasks
                        .iter()
                        .find(|task| task.definition.task_id == task_id);
                    actual = serde_json::Value::String(
                        task.map(|task| match task.state {
                            TaskState::Succeeded => "completed",
                            TaskState::Failed => "failed",
                            TaskState::Unknown => "unknown",
                            TaskState::Cancelled => "cancelled",
                            TaskState::Pending => "pending",
                            TaskState::Running => "running",
                        })
                        .unwrap_or("missing")
                        .into(),
                    );
                    passed = actual.as_str() == Some("completed")
                        && rule.get("expected").and_then(serde_json::Value::as_str)
                            == Some("completed");
                    (
                        if passed { "PASS" } else { "FAIL" },
                        if passed {
                            None
                        } else {
                            Some("named immutable plan task is not completed")
                        },
                    )
                }
                "task_role_present" | "task_role_absent" => {
                    let role = rule
                        .get("role")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    let count = workflow
                        .plan
                        .tasks
                        .iter()
                        .filter(|task| task.role == role)
                        .count();
                    actual = serde_json::Value::from(count as u64);
                    passed = if kind == "task_role_present" {
                        count > 0
                    } else {
                        count == 0
                    };
                    (
                        if passed { "PASS" } else { "FAIL" },
                        if passed {
                            None
                        } else {
                            Some("planned role presence does not satisfy predicate")
                        },
                    )
                }
                "execution_exit_code_equals"
                | "local_execution_only"
                | "artifact_exists"
                | "artifact_field_equals"
                | "artifact_field_includes"
                | "artifact_field_non_empty" => (
                    "UNRESOLVED",
                    Some(
                        "required execution/artifact authority is not represented in the persisted Workflow Control evidence model",
                    ),
                ),
                _ => (
                    "UNRESOLVED",
                    Some("unsupported success predicate; fail closed"),
                ),
            };
            if disposition == "FAIL" {
                failed = true;
            }
            if disposition == "UNRESOLVED" {
                unresolved = true;
            }
            results.push(serde_json::json!({
                "id":id,"type":kind,"passed":passed,"actual":actual,
                "disposition":disposition,"reason":reason
            }));
        }
    }
    let outcome = if failed {
        "FAILED"
    } else if unresolved {
        "UNRESOLVED"
    } else {
        "PASSED"
    };
    let attempt_rows: Vec<(String, i64, String)> = {
        let mut statement = connection.prepare(
            "SELECT task_id,attempt,result_sha256 FROM task_attempt_results WHERE workflow_id=?1 ORDER BY task_id,attempt",
        )?;
        statement
            .query_map(params![workflow_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    let evidence_sha256 =
        content_hash(&attempt_rows).map_err(|error| StoreError::Invariant(error.to_string()))?;
    Ok(serde_json::json!({
        "schema_version":1,"workflow_id":workflow_id,"contract_version":contract_version,
        "contract_sha256":contract_sha256,"plan_sha256":workflow.plan_hash,
        "evidence_sha256":evidence_sha256,"outcome":outcome,"predicates":results
    }))
}

fn verify_workflow_success_contract(
    connection: &Connection,
    workflow_id: &str,
    expected_plan_sha256: Option<&str>,
    require_plan_pin: bool,
) -> Result<(), StoreError> {
    let policies = load_workflow_policy_attachments(connection, workflow_id)?;
    let contract = connection.query_row(
        "SELECT version,base_contract_json,composed_contract_json,policy_pins_json,content_sha256,plan_sha256 FROM workflow_success_contracts WHERE workflow_id=?1 ORDER BY version DESC LIMIT 1",
        params![workflow_id],
        |row| Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,Option<String>>(5)?)),
    ).optional()?;
    if policies.is_empty() {
        if contract.is_some() {
            return Err(StoreError::Invariant(
                "success contract exists without policy attachments".into(),
            ));
        }
        return Ok(());
    }
    let (version, base_json, composed_json, pins_json, digest, pinned_plan) =
        contract.ok_or_else(|| {
            StoreError::Invariant("attached policy has no persisted success contract".into())
        })?;
    let version = u32::try_from(version)
        .map_err(|_| StoreError::Invariant("invalid success contract version".into()))?;
    let proposal_json: String = connection.query_row(
        "SELECT proposal_json FROM workflows WHERE workflow_id=?1",
        params![workflow_id],
        |row| row.get(0),
    )?;
    let proposal: WorkflowProposal = serde_json::from_str(&proposal_json)?;
    let base: serde_json::Value = serde_json::from_str(&base_json)?;
    let normalized_base = normalize_success_contract(base.clone(), &proposal.goal)?;
    if normalized_base != base || serde_json::to_string(&base)? != base_json {
        return Err(StoreError::Invariant(
            "persisted success contract base is not canonical".into(),
        ));
    }
    let composed = compose_success_contract(&base, &policies)?;
    let pins: Vec<serde_json::Value> = policies.iter().map(|policy| serde_json::json!({
        "policy_id":policy.policy_id,"version":policy.version,"content_hash":policy.content_sha256
    })).collect();
    let stored_composed: serde_json::Value = serde_json::from_str(&composed_json)?;
    let stored_pins: serde_json::Value = serde_json::from_str(&pins_json)?;
    let expected_digest = content_hash(&serde_json::json!({
        "base_contract":base,"composed_contract":composed,"policy_pins":pins
    }))
    .map_err(|error| StoreError::Invariant(error.to_string()))?;
    if stored_composed != composed
        || serde_json::to_string(&stored_composed)? != composed_json
        || stored_pins != serde_json::Value::Array(pins)
        || serde_json::to_string(&stored_pins)? != pins_json
        || digest != expected_digest
    {
        return Err(StoreError::Invariant(format!(
            "success contract integrity failure: {workflow_id}@{version}"
        )));
    }
    match (pinned_plan.as_deref(), expected_plan_sha256) {
        (Some(actual), Some(expected)) if actual == expected => {}
        (Some(_), None) if !require_plan_pin => {}
        (None, _) if !require_plan_pin => {}
        _ => return Err(StoreError::ApprovalRequired),
    }
    Ok(())
}

fn pin_workflow_success_contract(
    transaction: &Transaction<'_>,
    workflow_id: &str,
    plan_sha256: &str,
) -> Result<(), StoreError> {
    verify_workflow_success_contract(transaction, workflow_id, None, false)?;
    let contract: Option<(i64, Option<String>)> = transaction.query_row(
        "SELECT version,plan_sha256 FROM workflow_success_contracts WHERE workflow_id=?1 ORDER BY version DESC LIMIT 1",
        params![workflow_id],
        |row| Ok((row.get(0)?,row.get(1)?)),
    ).optional()?;
    let Some((version, existing)) = contract else {
        return Ok(());
    };
    if let Some(existing) = existing {
        if existing != plan_sha256 {
            return Err(StoreError::ApprovalBindingMismatch);
        }
    } else {
        let changed = transaction.execute(
            "UPDATE workflow_success_contracts SET plan_sha256=?1 WHERE workflow_id=?2 AND version=?3 AND plan_sha256 IS NULL",
            params![plan_sha256,workflow_id,version],
        )?;
        if changed != 1 {
            return Err(StoreError::ApprovalBindingMismatch);
        }
    }
    verify_workflow_success_contract(transaction, workflow_id, Some(plan_sha256), true)
}

fn load_workflow_from(
    connection: &Connection,
    workflow_id: &str,
) -> Result<WorkflowView, StoreError> {
    let row = connection.query_row(
        "SELECT state,proposal_json,proposal_sha256,plan_json,plan_sha256,approval_json,cancellation_requested_at FROM workflows WHERE workflow_id=?1",
        params![workflow_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(5)?, row.get::<_, Option<String>>(6)?)),
    ).optional()?.ok_or_else(|| StoreError::NotFound(format!("workflow {workflow_id}")))?;
    let state = parse_workflow_state(&row.0)?;
    let proposal: WorkflowProposal = serde_json::from_str(&row.1)?;
    let plan: WorkflowPlan = serde_json::from_str(&row.3)?;
    let plan_content_sha256 =
        content_hash(&plan).map_err(|error| StoreError::Invariant(error.to_string()))?;
    if row
        .4
        .as_deref()
        .is_some_and(|pinned| pinned != plan_content_sha256)
    {
        return Err(StoreError::Invariant(format!(
            "workflow plan bytes do not match the pinned digest: {workflow_id}"
        )));
    }
    let approval: Option<Approval> = row
        .5
        .map(|value| serde_json::from_str(&value))
        .transpose()?;
    let cancellation_request = if let Some(requested_at) = row.6.as_deref() {
        let event: Option<(String, String, String)> = connection
            .query_row(
                "SELECT event_type,payload_json,created_at FROM events
                 WHERE workflow_id=?1 AND idempotency_key=?2",
                params![workflow_id, format!("workflow.cancel:{workflow_id}")],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let (event_type, payload_json, event_created_at) = event.ok_or_else(|| {
            StoreError::Invariant(format!(
                "workflow cancellation marker has no append-only request event: {workflow_id}"
            ))
        })?;
        let payload: serde_json::Value = serde_json::from_str(&payload_json)?;
        let actor = payload
            .get("actor")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty() && value.trim() == *value)
            .ok_or_else(|| {
                StoreError::Invariant(format!(
                    "workflow cancellation event has an invalid actor: {workflow_id}"
                ))
            })?;
        let reason = payload
            .get("reason")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty() && value.len() <= 2000)
            .ok_or_else(|| {
                StoreError::Invariant(format!(
                    "workflow cancellation event has an invalid reason: {workflow_id}"
                ))
            })?;
        let event_plan_sha256 = payload
            .get("planSha256")
            .and_then(serde_json::Value::as_str);
        let plan_binding_matches = match row.4.as_deref() {
            Some(pinned_plan_sha256) => {
                pinned_plan_sha256 == plan_content_sha256
                    && event_plan_sha256 == Some(pinned_plan_sha256)
            }
            // Schema-v19 cancellation events created before approval recorded
            // a null plan hash. Newer requests bind the candidate plan digest.
            None => {
                event_plan_sha256.is_none()
                    || event_plan_sha256 == Some(plan_content_sha256.as_str())
            }
        };
        if event_type != "workflow.cancel_requested"
            || event_created_at != requested_at
            || !plan_binding_matches
        {
            return Err(StoreError::Invariant(format!(
                "workflow cancellation marker does not match its immutable event and plan: {workflow_id}"
            )));
        }
        let has_execution_attempts: bool = connection.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM tasks WHERE workflow_id=?1 AND attempts>0
             )",
            params![workflow_id],
            |row| row.get(0),
        )?;
        Some(WorkflowCancellationView {
            actor: actor.into(),
            reason: reason.into(),
            requested_at: requested_at.into(),
            settlement_status: if has_execution_attempts {
                WorkflowCancellationSettlementStatus::Unresolved
            } else {
                WorkflowCancellationSettlementStatus::NotRequired
            },
        })
    } else {
        None
    };
    let mut statement = connection.prepare(
        "SELECT definition_json,state,attempts,lease_id,lease_owner,lease_expires_at,result_json FROM tasks WHERE workflow_id=?1 ORDER BY ordinal",
    )?;
    let tasks = statement
        .query_map(params![workflow_id], |row| {
            let definition: String = row.get(0)?;
            let state: String = row.get(1)?;
            let result: Option<String> = row.get(6)?;
            Ok((
                definition,
                state,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                result,
            ))
        })?
        .map(|row| {
            let (definition, state, attempts, lease_id, lease_owner, lease_expires_at, result) =
                row?;
            let definition = serde_json::from_str(&definition).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            let result = result
                .map(|value| serde_json::from_str(&value))
                .transpose()
                .map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        6,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
            Ok(TaskView {
                definition,
                state: parse_task_state(&state).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?,
                attempts: attempts as u64,
                lease_id,
                lease_owner,
                lease_expires_at,
                result,
            })
        })
        .collect::<Result<Vec<_>, rusqlite::Error>>()?;
    Ok(WorkflowView {
        workflow_id: workflow_id.into(),
        state,
        proposal,
        plan,
        approval,
        proposal_hash: row.2,
        plan_hash: row.4,
        cancellation_request,
        tasks,
    })
}

fn parse_workflow_state(value: &str) -> Result<WorkflowState, StoreError> {
    match value {
        "PROPOSED" => Ok(WorkflowState::Proposed),
        "APPROVED" => Ok(WorkflowState::Approved),
        "EXECUTING" => Ok(WorkflowState::Executing),
        "COMPLETED" => Ok(WorkflowState::Completed),
        "FAILED" => Ok(WorkflowState::Failed),
        "CANCELLED" => Ok(WorkflowState::Cancelled),
        _ => Err(StoreError::Invariant(format!(
            "unknown workflow state {value}"
        ))),
    }
}

fn parse_task_state(value: &str) -> Result<TaskState, StoreError> {
    match value {
        "PENDING" => Ok(TaskState::Pending),
        "RUNNING" => Ok(TaskState::Running),
        "SUCCEEDED" => Ok(TaskState::Succeeded),
        "FAILED" => Ok(TaskState::Failed),
        "UNKNOWN" => Ok(TaskState::Unknown),
        "CANCELLED" => Ok(TaskState::Cancelled),
        _ => Err(StoreError::Invariant(format!("unknown task state {value}"))),
    }
}

fn insert_event<T: Serialize>(
    transaction: &Transaction<'_>,
    workflow_id: &str,
    task_id: Option<&str>,
    event_type: &str,
    payload: &T,
    idempotency_key: &str,
    timestamp: &str,
) -> Result<(), StoreError> {
    let payload_json = serde_json::to_string(payload)?;
    let event_id = format!("evt_{}", Uuid::new_v4().simple());
    let previous_hash: Option<String> = transaction
        .query_row(
            "SELECT event_hash FROM events WHERE workflow_id=?1 ORDER BY event_seq DESC LIMIT 1",
            params![workflow_id],
            |row| row.get(0),
        )
        .optional()?;
    let previous_hash = previous_hash.unwrap_or_else(|| "0".repeat(64));
    let material = EventHashMaterial {
        workflow_id,
        event_id: &event_id,
        task_id,
        event_type,
        payload_json: &payload_json,
        idempotency_key,
        created_at: timestamp,
        previous_hash: &previous_hash,
    };
    let event_hash = hash_event(&material)?;
    transaction.execute(
        "INSERT INTO events(event_id,workflow_id,task_id,event_type,payload_json,idempotency_key,created_at,event_prev_hash,event_hash) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![event_id, workflow_id, task_id, event_type, payload_json, idempotency_key, timestamp, previous_hash, event_hash],
    )?;
    Ok(())
}

#[derive(Serialize)]
struct EventHashMaterial<'a> {
    workflow_id: &'a str,
    event_id: &'a str,
    task_id: Option<&'a str>,
    event_type: &'a str,
    payload_json: &'a str,
    idempotency_key: &'a str,
    created_at: &'a str,
    previous_hash: &'a str,
}

struct EventRow {
    sequence: i64,
    event_id: String,
    task_id: Option<String>,
    event_type: String,
    payload_json: String,
    idempotency_key: String,
    created_at: String,
    previous_hash: String,
    event_hash: String,
}

fn hash_event(material: &EventHashMaterial<'_>) -> Result<String, StoreError> {
    let bytes = serde_json::to_vec(material)?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn verify_event_chain_connection(
    connection: &Connection,
    workflow_id: &str,
) -> Result<EventChainVerification, StoreError> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM workflows WHERE workflow_id=?1)",
        params![workflow_id],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(StoreError::NotFound(format!("workflow {workflow_id}")));
    }
    let mut statement=connection.prepare(
        "SELECT event_seq,event_id,task_id,event_type,payload_json,idempotency_key,created_at,event_prev_hash,event_hash FROM events WHERE workflow_id=?1 ORDER BY event_seq",
    )?;
    let rows = statement.query_map(params![workflow_id], |row| {
        Ok(EventRow {
            sequence: row.get(0)?,
            event_id: row.get(1)?,
            task_id: row.get(2)?,
            event_type: row.get(3)?,
            payload_json: row.get(4)?,
            idempotency_key: row.get(5)?,
            created_at: row.get(6)?,
            previous_hash: row.get(7)?,
            event_hash: row.get(8)?,
        })
    })?;
    let mut previous_hash = "0".repeat(64);
    let mut count = 0_u64;
    let mut head_hash = None;
    let mut failure_sequence = None;
    for row in rows {
        let event = row?;
        count += 1;
        if event.previous_hash != previous_hash {
            failure_sequence = Some(event.sequence);
            break;
        }
        let material = EventHashMaterial {
            workflow_id,
            event_id: &event.event_id,
            task_id: event.task_id.as_deref(),
            event_type: &event.event_type,
            payload_json: &event.payload_json,
            idempotency_key: &event.idempotency_key,
            created_at: &event.created_at,
            previous_hash: &event.previous_hash,
        };
        let expected = hash_event(&material)?;
        if event.event_hash != expected {
            failure_sequence = Some(event.sequence);
            break;
        }
        previous_hash.clone_from(&event.event_hash);
        head_hash = Some(event.event_hash);
    }
    Ok(EventChainVerification {
        workflow_id: workflow_id.into(),
        valid: failure_sequence.is_none(),
        event_count: count,
        head_hash,
        failure_sequence,
    })
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn valid_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_worker_identity_field(
    value: &str,
    label: &str,
    maximum: usize,
) -> Result<(), StoreError> {
    if value.trim().is_empty()
        || value.trim() != value
        || value.len() > maximum
        || value.chars().any(char::is_control)
    {
        return Err(StoreError::Invariant(format!("{label} is invalid")));
    }
    Ok(())
}

fn validate_lease_renewal_request(request: &TaskLeaseRenewalRequest) -> Result<(), StoreError> {
    validate_worker_identity_field(&request.renewal_id, "lease renewal ID", 256)?;
    validate_worker_identity_field(&request.workflow_id, "workflow ID", 256)?;
    validate_worker_identity_field(&request.task_id, "task ID", 256)?;
    validate_worker_identity_field(&request.lease_id, "lease ID", 256)?;
    validate_worker_identity_field(&request.worker_id, "worker ID", 256)?;
    if request.attempt == 0
        || request.attempt > i64::MAX as u64
        || request.owner_epoch == 0
        || request.owner_epoch > i64::MAX as u64
        || !(1..=600).contains(&request.lease_ttl_seconds)
    {
        return Err(StoreError::Invariant(
            "lease renewal attempt, owner epoch or TTL is outside its supported bounds".into(),
        ));
    }
    Ok(())
}

fn validate_worker_execution_fence_request(
    request: &WorkerExecutionFenceRequest,
) -> Result<(), StoreError> {
    for (value, label, maximum) in [
        (&request.claim_id, "claim ID", 256),
        (&request.workflow_id, "workflow ID", 256),
        (&request.task_id, "task ID", 256),
        (&request.lease_id, "lease ID", 256),
        (&request.worker_id, "worker ID", 256),
        (&request.side_effect_id, "side-effect ID", 256),
        (
            &request.idempotency_key,
            "execution-fence idempotency key",
            512,
        ),
    ] {
        validate_worker_identity_field(value, label, maximum)?;
    }
    if request.attempt == 0
        || request.attempt > i64::MAX as u64
        || request.owner_epoch == 0
        || request.owner_epoch > i64::MAX as u64
        || !valid_lower_sha256(&request.plan_sha256)
        || !valid_lower_sha256(&request.request_sha256)
        || !valid_lower_sha256(&request.acl_sha256)
    {
        return Err(StoreError::Invariant(
            "execution-fence attempt, epoch or digest is invalid".into(),
        ));
    }
    Ok(())
}

fn verify_current_execution_fence_owner(
    transaction: &Transaction<'_>,
    request: &WorkerExecutionFenceRequest,
    timestamp: &str,
) -> Result<(), StoreError> {
    let current: Option<CurrentExecutionFenceProjectionRow> = transaction
        .query_row(
            "SELECT t.state,t.attempts,t.owner_epoch,t.lease_id,t.lease_owner,
                    t.lease_expires_at,w.plan_sha256
             FROM tasks t JOIN workflows w ON w.workflow_id=t.workflow_id
             WHERE t.workflow_id=?1 AND t.task_id=?2",
            params![request.workflow_id, request.task_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()?;
    let Some((state, attempt, owner_epoch, lease_id, worker_id, lease_expiry, plan_sha256)) =
        current
    else {
        return Err(StoreError::NotFound(format!("task {}", request.task_id)));
    };
    if state != "RUNNING"
        || attempt != request.attempt as i64
        || owner_epoch != request.owner_epoch as i64
        || lease_id.as_deref() != Some(request.lease_id.as_str())
        || worker_id.as_deref() != Some(request.worker_id.as_str())
        || plan_sha256.as_deref() != Some(request.plan_sha256.as_str())
        || lease_expiry
            .as_deref()
            .is_none_or(|expiry| expiry <= timestamp)
    {
        return Err(StoreError::LeaseFenced);
    }
    Ok(())
}

fn validate_worker_execution_fence_completion(
    completion: &WorkerExecutionFenceCompletion,
) -> Result<(), StoreError> {
    for (value, label, maximum) in [
        (&completion.fence_id, "fence ID", 256),
        (&completion.claim_id, "claim ID", 256),
        (&completion.workflow_id, "workflow ID", 256),
        (&completion.task_id, "task ID", 256),
        (&completion.lease_id, "lease ID", 256),
        (&completion.worker_id, "worker ID", 256),
        (&completion.side_effect_id, "side-effect ID", 256),
        (&completion.event_id, "execution event ID", 256),
    ] {
        validate_worker_identity_field(value, label, maximum)?;
    }
    if completion.attempt == 0
        || completion.attempt > i64::MAX as u64
        || completion.owner_epoch == 0
        || completion.owner_epoch > i64::MAX as u64
        || !valid_lower_sha256(&completion.plan_sha256)
        || !valid_lower_sha256(&completion.request_sha256)
        || !valid_lower_sha256(&completion.event_sha256)
        || !valid_lower_sha256(&completion.outcome_sha256)
        || !matches!(
            completion.outcome.as_str(),
            "SUCCEEDED" | "FAILED" | "UNKNOWN" | "NOT_STARTED"
        )
    {
        return Err(StoreError::Invariant(
            "execution-fence completion outcome, attempt, epoch or digest is invalid".into(),
        ));
    }
    Ok(())
}

fn load_worker_execution_fence(
    transaction: &Transaction<'_>,
    fence_id: &str,
) -> Result<WorkerExecutionFenceRecord, StoreError> {
    type Row = (
        String,
        String,
        String,
        String,
        i64,
        i64,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
        Option<String>,
    );
    let row: Row = transaction
        .query_row(
            "SELECT fence_id,claim_id,workflow_id,task_id,attempt,owner_epoch,lease_id,worker_id,
                    plan_sha256,side_effect_id,kind,request_sha256,idempotency_key,acl_sha256,
                    state,completion_json,completion_sha256,receipt_json,created_at,completed_at
             FROM worker_execution_fences WHERE fence_id=?1",
            params![fence_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                    row.get(11)?,
                    row.get(12)?,
                    row.get(13)?,
                    row.get(14)?,
                    row.get(15)?,
                    row.get(16)?,
                    row.get(17)?,
                    row.get(18)?,
                    row.get(19)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound(format!("worker execution fence {fence_id}")))?;
    let kind = match row.10.as_str() {
        "sandbox_start" => WorkerExecutionFenceKind::SandboxStart,
        "provider_dispatch" => WorkerExecutionFenceKind::ProviderDispatch,
        "result_publish" => WorkerExecutionFenceKind::ResultPublish,
        "session_delivery" => WorkerExecutionFenceKind::SessionDelivery,
        _ => {
            return Err(StoreError::Invariant(
                "persisted worker execution fence has an unsupported kind".into(),
            ));
        }
    };
    let attempt = u64::try_from(row.4)
        .map_err(|_| StoreError::Invariant("negative execution-fence attempt".into()))?;
    let owner_epoch = u64::try_from(row.5)
        .map_err(|_| StoreError::Invariant("negative execution-fence owner epoch".into()))?;
    let completion = row.15.as_deref().map(serde_json::from_str).transpose()?;
    let receipt = serde_json::from_str(&row.17)?;
    Ok(WorkerExecutionFenceRecord {
        fence_id: row.0,
        request: WorkerExecutionFenceRequest {
            claim_id: row.1,
            workflow_id: row.2,
            task_id: row.3,
            attempt,
            owner_epoch,
            lease_id: row.6,
            worker_id: row.7,
            plan_sha256: row.8,
            side_effect_id: row.9,
            kind,
            request_sha256: row.11,
            idempotency_key: row.12,
            acl_sha256: row.13,
        },
        state: row.14,
        completion,
        completion_sha256: row.16,
        receipt,
        created_at: row.18,
        completed_at: row.19,
    })
}

#[cfg(test)]
pub(crate) fn downgrade_schema_v20_fixture_to_v19(
    connection: &Connection,
) -> Result<(), StoreError> {
    connection.execute_batch(
        "DROP TRIGGER workflow_cancellation_request_append_only;
         ALTER TABLE workflows DROP COLUMN cancellation_requested_at;
         PRAGMA user_version=19;",
    )?;
    Ok(())
}

#[cfg(test)]
pub(crate) fn downgrade_schema_v20_fixture_to_v18(
    connection: &Connection,
) -> Result<(), StoreError> {
    connection.execute_batch(
        "DROP TRIGGER workflow_cancellation_request_append_only;
         ALTER TABLE workflows DROP COLUMN cancellation_requested_at;
         DROP TRIGGER workflow_state_transition_guard;
         CREATE TRIGGER workflow_state_transition_guard
         BEFORE UPDATE OF state ON workflows
         WHEN NOT (
           (OLD.state='PROPOSED' AND NEW.state IN ('APPROVED','CANCELLED')) OR
           (OLD.state='APPROVED' AND NEW.state IN ('EXECUTING','CANCELLED')) OR
           (OLD.state='EXECUTING' AND NEW.state IN ('COMPLETED','FAILED','CANCELLED'))
         )
         BEGIN SELECT RAISE(ABORT,'invalid workflow state transition'); END;
         DROP TRIGGER worker_execution_fences_no_delete;
         DROP TRIGGER worker_execution_fences_update_guard;
         DROP TRIGGER worker_execution_fences_insert_guard;
         DROP INDEX worker_execution_fences_attempt;
         DROP TABLE worker_execution_fences;
         DROP TRIGGER task_lease_renewals_no_delete;
         DROP TRIGGER task_lease_renewals_no_update;
         DROP TRIGGER task_lease_renewals_insert_guard;
         DROP INDEX task_lease_renewals_attempt;
         DROP TABLE task_lease_renewals;
         DROP TRIGGER task_lease_fence_guard;
         CREATE TRIGGER task_lease_fence_guard
         BEFORE UPDATE OF attempts,lease_id,lease_owner,lease_expires_at ON tasks
         WHEN NOT (
           (OLD.state='PENDING' AND NEW.state='RUNNING' AND NEW.attempts=OLD.attempts+1
             AND NEW.lease_id IS NOT NULL AND NEW.lease_owner IS NOT NULL AND NEW.lease_expires_at IS NOT NULL) OR
           (OLD.state='RUNNING' AND NEW.state IN ('SUCCEEDED','FAILED','UNKNOWN')
             AND NEW.attempts=OLD.attempts AND NEW.lease_id IS NULL
             AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL)
         )
         BEGIN SELECT RAISE(ABORT,'task lease identity is fenced'); END;
         PRAGMA user_version=18;",
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Arc;

    use runalith_agg::custody::{CheckpointOperationRepository, SecurityProjectionTransitionGate};

    use super::*;

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

    struct TestExecutionFenceCompletionVerifier;

    impl WorkerExecutionFenceCompletionVerifier for TestExecutionFenceCompletionVerifier {
        fn verify_terminal_completion(
            &self,
            _transaction: &Transaction<'_>,
            fence: &WorkerExecutionFenceRecord,
            completion: &WorkerExecutionFenceCompletion,
        ) -> Result<(), StoreError> {
            if fence.fence_id != completion.fence_id
                || !matches!(
                    completion.outcome.as_str(),
                    "SUCCEEDED" | "FAILED" | "NOT_STARTED"
                )
                || completion.event_sha256.len() != 64
                || completion.outcome_sha256.len() != 64
            {
                return Err(StoreError::InvalidVerifierOutput);
            }
            Ok(())
        }
    }

    struct RejectExecutionFenceCompletionVerifier;

    impl WorkerExecutionFenceCompletionVerifier for RejectExecutionFenceCompletionVerifier {
        fn verify_terminal_completion(
            &self,
            _transaction: &Transaction<'_>,
            _fence: &WorkerExecutionFenceRecord,
            _completion: &WorkerExecutionFenceCompletion,
        ) -> Result<(), StoreError> {
            Err(StoreError::InvalidVerifierOutput)
        }
    }

    struct TestCoordinatorWorkerVerifier;

    impl CoordinatorWorkerVerifier for TestCoordinatorWorkerVerifier {
        fn authenticate_worker(
            &self,
            _transaction: &Transaction<'_>,
            asserted_worker_id: &str,
        ) -> Result<String, StoreError> {
            if asserted_worker_id == "coordinator-worker" {
                Ok(asserted_worker_id.to_owned())
            } else {
                Err(StoreError::ApprovalAuthorityUnavailable)
            }
        }
    }

    struct TestCancellationVerifier;

    impl WorkflowCancellationVerifier for TestCancellationVerifier {
        fn verify_cancel(
            &self,
            _transaction: &Transaction<'_>,
            _workflow: &WorkflowView,
            asserted_actor: &str,
            _reason: &str,
        ) -> Result<String, StoreError> {
            if asserted_actor == "authenticated-operator" {
                Ok(asserted_actor.to_owned())
            } else {
                Err(StoreError::ApprovalAuthorityUnavailable)
            }
        }
    }

    struct TestTrustedSkillResolver {
        revoked: bool,
        substitute: bool,
    }

    impl TrustedSkillResolver for TestTrustedSkillResolver {
        fn resolve_and_verify(
            &self,
            _transaction: &Transaction<'_>,
            reference: &str,
        ) -> Result<VerifiedTrustedSkill, StoreError> {
            if self.revoked {
                return Err(StoreError::ApprovalAuthorityUnavailable);
            }
            Ok(VerifiedTrustedSkill {
                reference: if self.substitute {
                    "skill:substituted@2".into()
                } else {
                    reference.into()
                },
                skill_id: "skill:requirements".into(),
                version: 3,
                content_sha256: "a".repeat(64),
            })
        }
    }

    struct AcceptCheckpointAuthority;

    impl runalith_agg::custody::AuthorityReceiptVerifier for AcceptCheckpointAuthority {
        fn verify(
            &self,
            _record: &runalith_agg::custody::CheckpointRecord,
        ) -> Result<bool, runalith_agg::custody::CustodyError> {
            Ok(true)
        }

        fn verify_operation(
            &self,
            _request: &runalith_agg::custody::PrepareRequest,
            _receipt: &runalith_agg::custody::AuthorityOperationReceipt,
        ) -> Result<bool, runalith_agg::custody::CustodyError> {
            Ok(true)
        }

        fn verify_head(
            &self,
            _head: &runalith_agg::custody::AuthorityHead,
        ) -> Result<bool, runalith_agg::custody::CustodyError> {
            Ok(true)
        }

        fn verify_outstanding(
            &self,
            _listing: &runalith_agg::custody::OutstandingOperations,
        ) -> Result<bool, runalith_agg::custody::CustodyError> {
            Ok(true)
        }
    }

    fn approval_request(workflow: &WorkflowView) -> ApprovalRequest {
        ApprovalRequest {
            actor: "test-reviewer".into(),
            expected_proposal_hash: workflow.proposal_hash.clone(),
            expected_plan_hash: content_hash(&workflow.plan).unwrap(),
            evidence: serde_json::json!({"test_only":true}),
        }
    }

    fn create_approved_claimed_store(
        path: &std::path::Path,
        worker_id: &str,
        lease_ttl_seconds: u64,
    ) -> (Store, WorkflowView, TaskLease) {
        let store = Store::create_new(path).unwrap();
        let workflow = store.create_proposal(proposal()).unwrap();
        store
            .approve(
                &workflow.workflow_id,
                approval_request(&workflow),
                &TestApprovalVerifier,
            )
            .unwrap();
        let lease = store
            .claim_task(
                &workflow.workflow_id,
                "task_one",
                ClaimRequest {
                    worker_id: worker_id.into(),
                    lease_ttl_seconds,
                },
                &TestApprovalVerifier,
            )
            .unwrap();
        (store, workflow, lease)
    }

    fn proposal() -> WorkflowProposal {
        WorkflowProposal {
            workflow_id: "job_store_contract".into(),
            title: "Store contract tests".into(),
            goal: "Verify append-only storage invariants".into(),
            tasks: vec![TaskSpec {
                task_id: "task_one".into(),
                role: "engineer".into(),
                description: "Verify store".into(),
                depends_on: vec![],
                required_evidence: vec!["report".into()],
                inputs: BTreeMap::new(),
            }],
            metadata: BTreeMap::new(),
        }
    }

    fn workflow_policy() -> WorkflowPolicyDefinition {
        WorkflowPolicyDefinition {
            schema_version: 1,
            policy_id: "require-engineer".into(),
            name: "Require engineer role".into(),
            description: "The immutable plan must include engineer role".into(),
            constraints: vec![serde_json::json!({
                "id":"engineer-present","type":"task_role_present","role":"engineer"
            })],
            success_criteria: vec![serde_json::json!({
                "id":"all-complete","type":"all_tasks_completed"
            })],
        }
    }

    #[test]
    fn workflow_read_snapshot_is_coherent_read_only_and_reports_truncation() {
        let store = Store::in_memory().unwrap();
        let proposed = store.create_proposal(proposal()).unwrap();
        let initial = store
            .inspect_workflow_read_snapshot(&proposed.workflow_id, 10)
            .unwrap();
        assert_eq!(initial.schema_version, 1);
        assert_eq!(initial.workflow.state, WorkflowState::Proposed);
        assert!(initial.event_chain.valid);
        assert_eq!(initial.task_attempts.len(), 1);
        assert_eq!(initial.task_attempts[0].attempt, 0);
        assert!(initial.task_attempts[0].attempt_history_complete);
        assert!(initial.ready_tasks.is_empty());
        assert!(!initial.events_truncated);

        let approved = store
            .approve(
                &proposed.workflow_id,
                approval_request(&proposed),
                &TestApprovalVerifier,
            )
            .unwrap();
        let approved_snapshot = store
            .inspect_workflow_read_snapshot(&proposed.workflow_id, 10)
            .unwrap();
        assert_eq!(approved_snapshot.workflow.state, WorkflowState::Approved);
        assert_eq!(approved_snapshot.ready_tasks.len(), 1);
        assert_eq!(approved_snapshot.ready_tasks[0].task_id, "task_one");
        assert_eq!(
            approved_snapshot.ready_tasks[0].workflow_id,
            proposed.workflow_id
        );
        assert_eq!(
            approved_snapshot.ready_tasks[0].plan_sha256.as_str(),
            approved.plan_hash.as_deref().unwrap()
        );
        assert_eq!(approved_snapshot.task_attempts[0].state, TaskState::Pending);
        assert_eq!(approved_snapshot.task_attempts[0].attempt, 0);

        let lease = store
            .claim_task(
                &proposed.workflow_id,
                "task_one",
                ClaimRequest {
                    worker_id: "snapshot-worker".into(),
                    lease_ttl_seconds: 60,
                },
                &TestApprovalVerifier,
            )
            .unwrap();

        let snapshot = store
            .inspect_workflow_read_snapshot(&proposed.workflow_id, 2)
            .unwrap();
        assert_eq!(snapshot.workflow.state, WorkflowState::Executing);
        assert_eq!(snapshot.task_attempts.len(), 1);
        let attempt = &snapshot.task_attempts[0];
        assert_eq!(attempt.state, TaskState::Running);
        assert_eq!(attempt.attempt, lease.attempt);
        assert_eq!(attempt.owner_epoch, lease.owner_epoch);
        assert_eq!(attempt.lease_id.as_deref(), Some(lease.lease_id.as_str()));
        assert_eq!(
            attempt.lease_owner.as_deref(),
            Some(lease.worker_id.as_str())
        );
        assert_eq!(attempt.attempt_ledger.len(), 1);
        assert_eq!(attempt.attempt_ledger[0].lease_id, lease.lease_id);
        assert!(attempt.attempt_history_complete);
        assert!(snapshot.ready_tasks.is_empty());
        assert_eq!(snapshot.events.len(), 2);
        assert!(snapshot.events_truncated);
        assert!(snapshot.event_chain.valid);
        assert!(snapshot.event_chain.event_count > snapshot.events.len() as u64);
        let attempt_snapshot = store
            .inspect_task_attempt(&proposed.workflow_id, "task_one")
            .unwrap();
        assert_eq!(
            snapshot.event_chain.head_hash.as_deref(),
            Some(attempt_snapshot.event_head_sha256.as_str())
        );

        // A second read must not create events, renew leases or otherwise mutate.
        let repeated = store
            .inspect_workflow_read_snapshot(&proposed.workflow_id, 2)
            .unwrap();
        assert_eq!(repeated, snapshot);
        assert!(matches!(
            store.inspect_workflow_read_snapshot(&proposed.workflow_id, 501),
            Err(StoreError::Invariant(_))
        ));
        assert!(matches!(
            store.inspect_workflow_read_snapshot("job_missing", 10),
            Err(StoreError::NotFound(_))
        ));
    }

    #[test]
    fn success_contract_rule_ids_match_node_eighty_character_limit_without_weakening_policy_namespace()
     {
        let forty = "a".repeat(40);
        let eighty = "a".repeat(80);
        let success_rule = serde_json::json!({
            "id":forty,
            "type":"all_tasks_completed"
        });
        assert!(
            normalize_success_contract(
                serde_json::json!({"goal":"Check IDs","success_criteria":[success_rule]}),
                "fallback"
            )
            .is_ok()
        );

        let eighty_rule = serde_json::json!({
            "id":eighty,
            "type":"all_tasks_completed"
        });
        assert!(
            normalize_success_contract(
                serde_json::json!({"goal":"Check IDs","success_criteria":[eighty_rule]}),
                "fallback"
            )
            .is_ok()
        );

        let eighty_one_rule = serde_json::json!({
            "id":"a".repeat(81),
            "type":"all_tasks_completed"
        });
        assert!(
            normalize_success_contract(
                serde_json::json!({"goal":"Check IDs","success_criteria":[eighty_one_rule]}),
                "fallback"
            )
            .is_err()
        );

        assert!(normalize_policy_predicate(&success_rule, "success_criteria", 39).is_err());
    }

    #[test]
    fn success_contract_normalization_matches_node_trim_null_and_criteria_alias_behavior() {
        let normalized = normalize_success_contract(
            serde_json::json!({
                "goal":"  Deliver the workflow  ",
                "constraints":null,
                "success_criteria":null,
                "criteria":[{
                    "id":"  trimmed-rule  ",
                    "type":" all_tasks_completed ",
                    "description":"  every task must finish  "
                }]
            }),
            "unused fallback",
        )
        .unwrap();
        assert_eq!(normalized["goal"], "Deliver the workflow");
        assert_eq!(
            normalized["success_criteria"][0],
            serde_json::json!({
                "id":"trimmed-rule",
                "type":"all_tasks_completed",
                "description":"every task must finish"
            })
        );
        assert_eq!(normalized["constraints"], serde_json::json!([]));

        let fallback = normalize_success_contract(
            serde_json::json!({"goal":null,"constraints":null}),
            "  Fallback goal  ",
        )
        .unwrap();
        assert_eq!(fallback["goal"], "Fallback goal");

        assert!(
            normalize_success_contract(
                serde_json::json!({
                    "success_criteria":[{
                        "id":"strict-status",
                        "type":"task_status_equals",
                        "task_id":"task-one",
                        "expected":" completed "
                    }]
                }),
                "fallback"
            )
            .is_err()
        );
    }

    #[test]
    fn workflow_policy_versions_attach_exactly_and_pin_composed_contract_at_approval() {
        let store = Store::in_memory().unwrap();
        let first = store
            .create_workflow_policy(workflow_policy(), "authenticated-policy-author")
            .unwrap();
        let node_fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/workflow-policy-v1-node.json"
        ))
        .unwrap();
        assert_eq!(first.version, 1);
        assert_eq!(
            first.content_sha256,
            node_fixture["snapshot"]["content_hash"]
        );
        let mut node_definition = node_fixture["snapshot"].clone();
        node_definition.as_object_mut().unwrap().remove("version");
        node_definition
            .as_object_mut()
            .unwrap()
            .remove("content_hash");
        assert_eq!(
            serde_json::to_value(&first.definition).unwrap(),
            node_definition
        );
        let base_contract = serde_json::json!({
            "schema_version":1,
            "goal":"Complete workflow",
            "constraints":[],
            "success_criteria":[]
        });
        assert_eq!(
            compose_success_contract(&base_contract, std::slice::from_ref(&first)).unwrap(),
            node_fixture["composed_success_contract"]
        );
        assert_eq!(
            store
                .get_workflow_policy("require-engineer", Some(1))
                .unwrap(),
            first
        );
        assert_eq!(
            store
                .list_workflow_policies(false, 10, Some("engineer role"))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .list_workflow_policies(true, 10, Some("missing-name"))
                .unwrap()
                .len(),
            0
        );

        let mut revised = workflow_policy();
        revised.description = "Revised policy description".into();
        let second = store
            .update_workflow_policy("require-engineer", revised, "authenticated-policy-author")
            .unwrap();
        assert_eq!(second.version, 2);
        assert_eq!(
            store
                .get_workflow_policy("require-engineer", Some(1))
                .unwrap(),
            first
        );

        let workflow = store.create_proposal(proposal()).unwrap();
        let attachment = store
            .attach_workflow_policy(
                &workflow.workflow_id,
                "require-engineer",
                Some(1),
                serde_json::json!({"goal":"Verify append-only storage invariants"}),
                "authenticated-policy-author",
            )
            .unwrap();
        assert_eq!(attachment.version, 1);
        assert_eq!(attachment.content_sha256, first.content_sha256);

        let duplicate = store.attach_workflow_policy(
            &workflow.workflow_id,
            "require-engineer",
            Some(1),
            serde_json::json!({"goal":"Verify append-only storage invariants"}),
            "authenticated-policy-author",
        );
        assert!(duplicate.is_err());
        let composed: String = store.connection.lock().unwrap().query_row(
            "SELECT composed_contract_json FROM workflow_success_contracts WHERE workflow_id=?1 ORDER BY version DESC LIMIT 1",
            params![workflow.workflow_id],
            |row| row.get(0),
        ).unwrap();
        assert!(composed.contains("p-require-engineer-engineer-present"));

        let approved = store
            .approve(
                &workflow.workflow_id,
                approval_request(&workflow),
                &TestApprovalVerifier,
            )
            .unwrap();
        assert!(matches!(
            store.admit_workflow(&workflow.workflow_id, &DenyAllApprovalVerifier),
            Err(StoreError::ApprovalAuthorityUnavailable)
        ));
        assert_eq!(
            store
                .list_workflow_events(&workflow.workflow_id, 100)
                .unwrap()
                .into_iter()
                .filter(|event| event.event_type == "workflow.admitted")
                .count(),
            0,
            "missing approval authority must fail before admission mutation"
        );
        let admitted = store
            .admit_workflow(&workflow.workflow_id, &TestApprovalVerifier)
            .unwrap();
        assert_eq!(admitted.plan_hash, approved.plan_hash);
        let admission_events = store
            .list_workflow_events(&workflow.workflow_id, 100)
            .unwrap()
            .into_iter()
            .filter(|event| event.event_type == "workflow.admitted")
            .count();
        assert_eq!(admission_events, 1);
        store
            .admit_workflow(&workflow.workflow_id, &TestApprovalVerifier)
            .unwrap();
        assert_eq!(
            store
                .list_workflow_events(&workflow.workflow_id, 100)
                .unwrap()
                .into_iter()
                .filter(|event| event.event_type == "workflow.admitted")
                .count(),
            1,
            "admission checkpoint is idempotent for the exact plan and pins"
        );
        let (pinned_plan, pinned_digest): (Option<String>, String) = store.connection.lock().unwrap().query_row(
            "SELECT plan_sha256,content_sha256 FROM workflow_success_contracts WHERE workflow_id=?1 ORDER BY version DESC LIMIT 1",
            params![workflow.workflow_id],
            |row| Ok((row.get(0)?,row.get(1)?)),
        ).unwrap();
        assert_eq!(pinned_plan.as_deref(), approved.plan_hash.as_deref());
        assert_eq!(pinned_digest.len(), 64);
        assert!(store.connection.lock().unwrap().execute(
            "UPDATE workflow_policy_versions SET definition_json='{}' WHERE policy_id='require-engineer' AND version=1",
            [],
        ).is_err());
        assert!(
            store
                .connection
                .lock()
                .unwrap()
                .execute(
                    "DELETE FROM workflow_policy_attachments WHERE workflow_id=?1",
                    params![workflow.workflow_id],
                )
                .is_err()
        );
        assert!(store.connection.lock().unwrap().execute(
            "UPDATE workflow_success_contracts SET composed_contract_json='{}' WHERE workflow_id=?1 AND version=1",
            params![workflow.workflow_id],
        ).is_err());
        assert!(
            verify_workflow_success_contract(
                &store.connection.lock().unwrap(),
                &workflow.workflow_id,
                approved.plan_hash.as_deref(),
                true,
            )
            .is_ok()
        );
    }

    #[test]
    fn concurrent_policy_updates_serialize_to_distinct_immutable_versions() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("concurrent-policy.db");
        let primary = Arc::new(Store::create_new(&path).unwrap());
        primary
            .create_workflow_policy(workflow_policy(), "authenticated-policy-author")
            .unwrap();
        let secondary = Arc::new(Store::open_existing(&path).unwrap());

        let mut left_definition = workflow_policy();
        left_definition.description = "concurrent writer left".into();
        let mut right_definition = workflow_policy();
        right_definition.description = "concurrent writer right".into();

        let left_store = Arc::clone(&primary);
        let left = std::thread::spawn(move || {
            left_store.update_workflow_policy(
                "require-engineer",
                left_definition,
                "authenticated-policy-author",
            )
        });
        let right_store = Arc::clone(&secondary);
        let right = std::thread::spawn(move || {
            right_store.update_workflow_policy(
                "require-engineer",
                right_definition,
                "authenticated-policy-author",
            )
        });

        let mut versions = [
            left.join().unwrap().unwrap().version,
            right.join().unwrap().unwrap().version,
        ];
        versions.sort_unstable();
        assert_eq!(versions, [2, 3]);
        let history = primary
            .list_workflow_policies(true, 10, Some("require-engineer"))
            .unwrap();
        assert_eq!(history.len(), 3);
        assert_eq!(
            history.iter().map(|item| item.version).collect::<Vec<_>>(),
            [3, 2, 1]
        );
        let event_count: i64 = primary
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM workflow_policy_events WHERE policy_id='require-engineer'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(event_count, 3);
    }

    #[test]
    fn workflow_policy_rejects_incompatible_plan_and_unattributed_actor_without_partial_write() {
        let store = Store::in_memory().unwrap();
        assert!(
            store
                .create_workflow_policy(workflow_policy(), "mcp:unattributed")
                .is_err()
        );
        let mut incompatible = workflow_policy();
        incompatible.policy_id = "require-reviewer".into();
        incompatible.constraints[0]["role"] = serde_json::Value::String("reviewer".into());
        store
            .create_workflow_policy(incompatible, "authenticated-policy-author")
            .unwrap();
        let mut proposed = proposal();
        proposed.tasks[0].task_id = "task-one".into();
        let workflow = store.create_proposal(proposed).unwrap();
        let result = store.attach_workflow_policy(
            &workflow.workflow_id,
            "require-reviewer",
            Some(1),
            serde_json::json!({"goal":"Verify append-only storage invariants"}),
            "authenticated-policy-author",
        );
        assert!(result.is_err());
        let connection = store.connection.lock().unwrap();
        let attachments: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM workflow_policy_attachments WHERE workflow_id=?1",
                params![workflow.workflow_id],
                |row| row.get(0),
            )
            .unwrap();
        let contracts: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM workflow_success_contracts WHERE workflow_id=?1",
                params![workflow.workflow_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(attachments, 0);
        assert_eq!(contracts, 0);
    }

    #[test]
    fn workflow_policy_matches_node_semantic_conflict_rejection() {
        let store = Store::in_memory().unwrap();
        let mut policy = workflow_policy();
        policy.constraints = vec![
            serde_json::json!({
                "id":"artifact-number","type":"artifact_field_equals",
                "artifact_type":"qa-report","field":"score","expected":0
            }),
            serde_json::json!({
                "id":"artifact-non-empty","type":"artifact_field_non_empty",
                "artifact_type":"qa-report","field":"score"
            }),
        ];
        assert!(Store::validate_workflow_policy(&policy).is_err());
        assert!(
            store
                .create_workflow_policy(policy, "authenticated-policy-author")
                .is_err()
        );
        assert!(
            store
                .list_workflow_policies(true, 10, None)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn coordinator_claim_revalidates_policy_pin_and_rolls_back_stale_claim() {
        let store = Store::in_memory().unwrap();
        store
            .create_workflow_policy(workflow_policy(), "authenticated-policy-author")
            .unwrap();
        let workflow = store.create_proposal(proposal()).unwrap();
        store
            .attach_workflow_policy(
                &workflow.workflow_id,
                "require-engineer",
                Some(1),
                serde_json::json!({"goal":"Verify append-only storage invariants"}),
                "authenticated-policy-author",
            )
            .unwrap();
        let preapproval_report = store.synthesize_workflow(&workflow.workflow_id).unwrap();
        assert_eq!(preapproval_report["outcome"], "UNRESOLVED");
        assert!(
            preapproval_report["success_evaluation"]["reason"]
                .as_str()
                .unwrap()
                .contains("not yet approved")
        );
        store
            .approve(
                &workflow.workflow_id,
                approval_request(&workflow),
                &TestApprovalVerifier,
            )
            .unwrap();
        {
            let connection = store.connection.lock().unwrap();
            connection
                .execute_batch("DROP TRIGGER workflow_policy_attachments_no_update;")
                .unwrap();
            connection.execute(
                "UPDATE workflow_policy_attachments SET content_sha256=?1 WHERE workflow_id=?2 AND policy_id='require-engineer'",
                params!["0".repeat(64),workflow.workflow_id],
            ).unwrap();
        }
        let claim = store.claim_task(
            &workflow.workflow_id,
            "task_one",
            ClaimRequest {
                worker_id: "worker-one".into(),
                lease_ttl_seconds: 60,
            },
            &TestApprovalVerifier,
        );
        assert!(claim.is_err());
        let task = store
            .inspect_task_attempt(&workflow.workflow_id, "task_one")
            .unwrap();
        assert_eq!(task.state, TaskState::Pending);
        assert_eq!(task.attempt, 0);
        assert!(task.attempt_ledger.is_empty());
    }

    #[test]
    fn persisted_success_contract_evaluates_durable_task_evidence_before_completion() {
        let store = Store::in_memory().unwrap();
        let mut policy = workflow_policy();
        policy.success_criteria = vec![
            serde_json::json!({"id":"all-complete","type":"all_tasks_completed"}),
            serde_json::json!({"id":"task-status","type":"task_status_equals","task_id":"task-one","expected":"completed"}),
            serde_json::json!({"id":"reviewer-absent","type":"task_role_absent","role":"reviewer"}),
        ];
        store
            .create_workflow_policy(policy, "authenticated-policy-author")
            .unwrap();
        let mut proposed = proposal();
        proposed.tasks[0].task_id = "task-one".into();
        let workflow = store.create_proposal(proposed).unwrap();
        store
            .attach_workflow_policy(
                &workflow.workflow_id,
                "require-engineer",
                Some(1),
                serde_json::json!({"goal":"Verify persisted workflow control evidence","constraints":[],"success_criteria":[]}),
                "authenticated-policy-author",
            )
            .unwrap();
        store
            .approve(
                &workflow.workflow_id,
                approval_request(&workflow),
                &TestApprovalVerifier,
            )
            .unwrap();
        let lease = store
            .claim_task(
                &workflow.workflow_id,
                "task-one",
                ClaimRequest {
                    worker_id: "worker-one".into(),
                    lease_ttl_seconds: 60,
                },
                &TestApprovalVerifier,
            )
            .unwrap();
        let completed = store
            .record_task_result(
                &workflow.workflow_id,
                "task-one",
                TaskResultRequest {
                    lease_id: lease.lease_id,
                    worker_id: lease.worker_id,
                    attempt: lease.attempt,
                    outcome: TaskOutcome::Succeeded,
                    evidence: vec![EvidenceRef {
                        artifact_id: "artifact-task-one".into(),
                        sha256: "a".repeat(64),
                        producer_task_id: "task-one".into(),
                        producer_attempt: lease.attempt,
                        kind: "report".into(),
                    }],
                    error: None,
                },
            )
            .unwrap();
        assert_eq!(completed.state, WorkflowState::Completed);
        assert!(
            store
                .list_workflow_events(&workflow.workflow_id, 50)
                .unwrap()
                .iter()
                .any(|event| event.event_type == "workflow.success_contract_passed")
        );
        let report = store.synthesize_workflow(&workflow.workflow_id).unwrap();
        assert_eq!(report["outcome"], "PASSED");
        let node_fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/success-contract-v1-node.json"
        ))
        .unwrap();
        assert_eq!(
            report["success_evaluation"]["predicates"]
                .as_array()
                .unwrap()
                .len(),
            node_fixture["predicates"].as_array().unwrap().len()
        );
        for (actual, expected) in report["success_evaluation"]["predicates"]
            .as_array()
            .unwrap()
            .iter()
            .zip(node_fixture["predicates"].as_array().unwrap())
        {
            assert_eq!(actual["id"], expected["id"]);
            assert_eq!(actual["type"], expected["type"]);
            assert_eq!(actual["passed"], expected["passed"]);
            assert_eq!(actual["actual"], expected["actual"]);
            assert_eq!(actual["disposition"], "PASS");
        }
        assert_eq!(report["plan_sha256"], completed.plan_hash.unwrap());
        assert_eq!(report["tasks"][0]["state"], "SUCCEEDED");
        assert_eq!(
            report["attempt_ledger"][0]["result_sha256"]
                .as_str()
                .unwrap()
                .len(),
            64
        );
        assert_eq!(report["source_event_chain_valid"], true);
        let repeated = store.synthesize_workflow(&workflow.workflow_id).unwrap();
        assert_eq!(repeated, report);
        assert_eq!(
            store
                .list_workflow_events(&workflow.workflow_id, 100)
                .unwrap()
                .iter()
                .filter(|event| event.event_type == "workflow.synthesis_reported")
                .count(),
            1,
        );
        assert!(
            store
                .verify_event_chain(&workflow.workflow_id)
                .unwrap()
                .valid
        );
    }

    #[test]
    fn lease_renewal_is_atomic_idempotent_and_bound_to_exact_owner_epoch() {
        let store = Store::in_memory().unwrap();
        let workflow = store.create_proposal(proposal()).unwrap();
        store
            .approve(
                &workflow.workflow_id,
                approval_request(&workflow),
                &TestApprovalVerifier,
            )
            .unwrap();
        let lease = store
            .claim_task(
                &workflow.workflow_id,
                "task_one",
                ClaimRequest {
                    worker_id: "renewal-worker".into(),
                    lease_ttl_seconds: 60,
                },
                &TestApprovalVerifier,
            )
            .unwrap();
        let request = TaskLeaseRenewalRequest {
            renewal_id: "renewal-exact-01".into(),
            workflow_id: lease.workflow_id.clone(),
            task_id: lease.task_id.clone(),
            lease_id: lease.lease_id.clone(),
            worker_id: lease.worker_id.clone(),
            attempt: lease.attempt,
            owner_epoch: lease.owner_epoch,
            lease_ttl_seconds: 120,
        };

        let first = store.renew_task_lease(request.clone()).unwrap();
        assert!(first.expires_at > first.previous_expires_at);
        let replay = store.renew_task_lease(request.clone()).unwrap();
        assert_eq!(
            replay, first,
            "ambiguous retry must return original renewal"
        );
        let snapshot = store
            .inspect_task_attempt(&lease.workflow_id, &lease.task_id)
            .unwrap();
        assert_eq!(
            snapshot.lease_expires_at.as_deref(),
            Some(first.expires_at.as_str())
        );

        let mut rebound = request.clone();
        rebound.lease_ttl_seconds = 180;
        assert!(matches!(
            store.renew_task_lease(rebound),
            Err(StoreError::LeaseRenewalConflict)
        ));
        let mut stale_epoch = request.clone();
        stale_epoch.renewal_id = "renewal-stale-epoch".into();
        stale_epoch.owner_epoch += 1;
        assert!(matches!(
            store.renew_task_lease(stale_epoch),
            Err(StoreError::LeaseFenced)
        ));
        let mut wrong_worker = request;
        wrong_worker.renewal_id = "renewal-wrong-worker".into();
        wrong_worker.worker_id = "different-worker".into();
        assert!(matches!(
            store.renew_task_lease(wrong_worker),
            Err(StoreError::LeaseFenced)
        ));

        let connection = store.connection.lock().unwrap();
        let ledger_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM task_lease_renewals WHERE workflow_id=?1 AND task_id=?2",
                params![lease.workflow_id, lease.task_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(ledger_count, 1);
        assert!(connection
            .execute(
                "UPDATE task_lease_renewals SET lease_ttl_seconds=180 WHERE renewal_id='renewal-exact-01'",
                [],
            )
            .is_err());
        assert!(
            connection
                .execute(
                    "DELETE FROM task_lease_renewals WHERE renewal_id='renewal-exact-01'",
                    []
                )
                .is_err()
        );
    }

    #[test]
    fn exact_lease_renewal_receipt_replays_after_store_restart_without_extending_again() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("lease-renewal-restart.sqlite");
        let (store, _workflow, lease) =
            create_approved_claimed_store(&path, "renewal-restart-worker", 60);
        let request = TaskLeaseRenewalRequest {
            renewal_id: "renewal-restart-exact".into(),
            workflow_id: lease.workflow_id.clone(),
            task_id: lease.task_id.clone(),
            lease_id: lease.lease_id.clone(),
            worker_id: lease.worker_id.clone(),
            attempt: lease.attempt,
            owner_epoch: lease.owner_epoch,
            lease_ttl_seconds: 120,
        };
        let first = store.renew_task_lease(request.clone()).unwrap();
        drop(store);

        let reopened = Store::open_existing(&path).unwrap();
        let replay = reopened.renew_task_lease(request.clone()).unwrap();
        assert_eq!(replay, first);
        assert_eq!(
            reopened
                .inspect_task_attempt(&lease.workflow_id, &lease.task_id)
                .unwrap()
                .lease_expires_at
                .as_deref(),
            Some(first.expires_at.as_str()),
            "replay after process restart must not issue a second extension"
        );

        let mut conflicting = request;
        conflicting.lease_ttl_seconds = 180;
        assert!(matches!(
            reopened.renew_task_lease(conflicting),
            Err(StoreError::LeaseRenewalConflict)
        ));
        let connection = reopened.connection.lock().unwrap();
        let ledger_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM task_lease_renewals WHERE renewal_id='renewal-restart-exact'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(ledger_count, 1);
        let event_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM events WHERE idempotency_key='lease.renewal:renewal-restart-exact'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(event_count, 1);
        drop(connection);
        assert!(
            reopened
                .verify_event_chain(&lease.workflow_id)
                .unwrap()
                .valid
        );
    }

    #[test]
    fn lease_renewal_replay_after_expiry_and_quarantine_is_fenced() {
        let store = Store::in_memory().unwrap();
        let workflow = store.create_proposal(proposal()).unwrap();
        store
            .approve(
                &workflow.workflow_id,
                approval_request(&workflow),
                &TestApprovalVerifier,
            )
            .unwrap();
        let lease = store
            .claim_task(
                &workflow.workflow_id,
                "task_one",
                ClaimRequest {
                    worker_id: "renewal-expiry-worker".into(),
                    // Keep setup comfortably inside the initial lease even
                    // under a loaded test runner; expiry is exercised only
                    // after the renewal below has been committed.
                    lease_ttl_seconds: 5,
                },
                &TestApprovalVerifier,
            )
            .unwrap();
        let request = TaskLeaseRenewalRequest {
            renewal_id: "renewal-expiry-idempotency".into(),
            workflow_id: lease.workflow_id.clone(),
            task_id: lease.task_id.clone(),
            lease_id: lease.lease_id.clone(),
            worker_id: lease.worker_id.clone(),
            attempt: lease.attempt,
            owner_epoch: lease.owner_epoch,
            lease_ttl_seconds: 5,
        };
        let original = store.renew_task_lease(request.clone()).unwrap();
        assert!(original.expires_at > original.previous_expires_at);
        std::thread::sleep(std::time::Duration::from_millis(5_100));
        assert_eq!(store.quarantine_expired_leases().unwrap(), 1);
        assert!(matches!(
            store.renew_task_lease(request),
            Err(StoreError::LeaseFenced)
        ));
        let connection = store.connection.lock().unwrap();
        let ledger_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM task_lease_renewals WHERE renewal_id='renewal-expiry-idempotency'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(ledger_count, 1);
    }

    #[test]
    fn worker_execution_fence_is_transactional_idempotent_and_finalized_once() {
        let store = Store::in_memory().unwrap();
        let workflow = store.create_proposal(proposal()).unwrap();
        store
            .approve(
                &workflow.workflow_id,
                approval_request(&workflow),
                &TestApprovalVerifier,
            )
            .unwrap();
        let lease = store
            .claim_task(
                &workflow.workflow_id,
                "task_one",
                ClaimRequest {
                    worker_id: "fence-worker".into(),
                    lease_ttl_seconds: 1,
                },
                &TestApprovalVerifier,
            )
            .unwrap();
        let request = WorkerExecutionFenceRequest {
            claim_id: "claim-fence-01".into(),
            workflow_id: lease.workflow_id.clone(),
            task_id: lease.task_id.clone(),
            attempt: lease.attempt,
            lease_id: lease.lease_id.clone(),
            worker_id: lease.worker_id.clone(),
            owner_epoch: lease.owner_epoch,
            plan_sha256: content_hash(&workflow.plan).unwrap(),
            side_effect_id: "sandbox-start-01".into(),
            kind: WorkerExecutionFenceKind::SandboxStart,
            request_sha256: "a".repeat(64),
            idempotency_key: "fence-idempotency-01".into(),
            acl_sha256: "b".repeat(64),
        };
        let first = store
            .reserve_worker_execution_fence(request.clone())
            .unwrap();
        assert_eq!(first.state, "RESERVED");
        let replay = store
            .reserve_worker_execution_fence(request.clone())
            .unwrap();
        assert_eq!(replay.fence_id, first.fence_id);
        assert_eq!(replay.receipt, first.receipt);

        let mut rebound = request.clone();
        rebound.request_sha256 = "c".repeat(64);
        assert!(matches!(
            store.reserve_worker_execution_fence(rebound),
            Err(StoreError::WorkerExecutionFenceConflict)
        ));
        let mut duplicate_side_effect = request.clone();
        duplicate_side_effect.idempotency_key = "fence-second-idempotency".into();
        assert!(matches!(
            store.reserve_worker_execution_fence(duplicate_side_effect),
            Err(StoreError::WorkerExecutionFenceConflict)
        ));
        let mut stale_owner = request.clone();
        stale_owner.idempotency_key = "fence-stale-owner".into();
        stale_owner.owner_epoch += 1;
        assert!(matches!(
            store.reserve_worker_execution_fence(stale_owner),
            Err(StoreError::LeaseFenced)
        ));

        std::thread::sleep(std::time::Duration::from_millis(1_100));
        assert_eq!(store.quarantine_expired_leases().unwrap(), 1);
        assert!(matches!(
            store.reserve_worker_execution_fence(request.clone()),
            Err(StoreError::LeaseFenced)
        ));

        let completion = WorkerExecutionFenceCompletion {
            fence_id: first.fence_id.clone(),
            claim_id: request.claim_id.clone(),
            workflow_id: request.workflow_id.clone(),
            task_id: request.task_id.clone(),
            attempt: request.attempt,
            lease_id: request.lease_id.clone(),
            worker_id: request.worker_id.clone(),
            owner_epoch: request.owner_epoch,
            plan_sha256: request.plan_sha256.clone(),
            side_effect_id: request.side_effect_id.clone(),
            kind: request.kind,
            request_sha256: request.request_sha256.clone(),
            outcome: "SUCCEEDED".into(),
            event_id: "sandbox-start-event-01".into(),
            event_sha256: "d".repeat(64),
            outcome_sha256: "e".repeat(64),
        };
        let mut unknown_observation = completion.clone();
        unknown_observation.outcome = "UNKNOWN".into();
        unknown_observation.event_id = "sandbox-start-unknown-event-01".into();
        let unknown = store
            .complete_worker_execution_fence(unknown_observation.clone())
            .unwrap();
        assert!(!unknown.terminal);
        assert_eq!(unknown.fence.state, "RESERVED");
        assert!(unknown.fence.completion.is_none());

        let mut unverified_not_started = completion.clone();
        unverified_not_started.outcome = "NOT_STARTED".into();
        unverified_not_started.event_id = "sandbox-start-not-started-event-01".into();
        let not_started = store
            .complete_worker_execution_fence(unverified_not_started.clone())
            .unwrap();
        assert!(!not_started.terminal);
        assert_eq!(not_started.fence.state, "RESERVED");

        assert!(matches!(
            store.complete_worker_execution_fence(completion.clone()),
            Err(StoreError::WorkerExecutionFenceCompletionAuthorityUnavailable)
        ));
        assert!(matches!(
            store.complete_worker_execution_fence_verified(
                completion.clone(),
                &RejectExecutionFenceCompletionVerifier,
            ),
            Err(StoreError::InvalidVerifierOutput)
        ));
        let reserved_after_rejected_proof: String = store
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT state FROM worker_execution_fences WHERE fence_id=?1",
                params![first.fence_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(reserved_after_rejected_proof, "RESERVED");
        let completed = store
            .complete_worker_execution_fence_verified(
                completion.clone(),
                &TestExecutionFenceCompletionVerifier,
            )
            .unwrap();
        assert!(completed.terminal);
        assert_eq!(completed.fence.state, "COMPLETED");
        let replayed_completion = store
            .complete_worker_execution_fence(completion.clone())
            .unwrap();
        assert_eq!(replayed_completion.receipt, completed.receipt);
        let replayed_unknown = store
            .complete_worker_execution_fence(unknown_observation)
            .unwrap();
        assert_eq!(replayed_unknown.receipt, unknown.receipt);
        assert_eq!(replayed_unknown.fence.state, "COMPLETED");
        let replayed_not_started = store
            .complete_worker_execution_fence(unverified_not_started)
            .unwrap();
        assert_eq!(replayed_not_started.receipt, not_started.receipt);

        let mut conflicting_completion = completion.clone();
        conflicting_completion.event_sha256 = "f".repeat(64);
        assert!(matches!(
            store.complete_worker_execution_fence(conflicting_completion),
            Err(StoreError::WorkerExecutionFenceConflict)
        ));
        let mut later_completion = completion;
        later_completion.event_id = "sandbox-start-second-terminal-event".into();
        assert!(matches!(
            store.complete_worker_execution_fence(later_completion),
            Err(StoreError::WorkerExecutionFenceFinalized)
        ));

        let observed_events: i64 = store
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM events WHERE workflow_id=?1 AND event_type='worker.execution_fence_observed'",
                params![lease.workflow_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(observed_events, 2);

        let connection = store.connection.lock().unwrap();
        let fence_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM worker_execution_fences WHERE workflow_id=?1 AND task_id=?2",
                params![lease.workflow_id, lease.task_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(fence_count, 1);
        assert!(
            connection
                .execute(
                    "DELETE FROM worker_execution_fences WHERE fence_id=?1",
                    params![first.fence_id],
                )
                .is_err()
        );
    }

    #[test]
    fn provider_fence_can_finish_after_task_result_but_sandbox_fence_cannot() {
        let store = Store::in_memory().unwrap();
        let workflow = store.create_proposal(proposal()).unwrap();
        store
            .approve(
                &workflow.workflow_id,
                approval_request(&workflow),
                &TestApprovalVerifier,
            )
            .unwrap();
        let lease = store
            .claim_task(
                &workflow.workflow_id,
                "task_one",
                ClaimRequest {
                    worker_id: "late-provider-worker".into(),
                    lease_ttl_seconds: 60,
                },
                &TestApprovalVerifier,
            )
            .unwrap();
        let provider_request = WorkerExecutionFenceRequest {
            claim_id: "claim-late-provider".into(),
            workflow_id: lease.workflow_id.clone(),
            task_id: lease.task_id.clone(),
            attempt: lease.attempt,
            lease_id: lease.lease_id.clone(),
            worker_id: lease.worker_id.clone(),
            owner_epoch: lease.owner_epoch,
            plan_sha256: content_hash(&workflow.plan).unwrap(),
            side_effect_id: "provider-intent-late-terminal".into(),
            kind: WorkerExecutionFenceKind::ProviderDispatch,
            request_sha256: "a".repeat(64),
            idempotency_key: "late-provider-idempotency".into(),
            acl_sha256: "b".repeat(64),
        };
        let provider_fence = store
            .reserve_worker_execution_fence(provider_request.clone())
            .unwrap();
        let mut sandbox_request = provider_request.clone();
        sandbox_request.kind = WorkerExecutionFenceKind::SandboxStart;
        sandbox_request.side_effect_id = "sandbox-start-late-terminal".into();
        sandbox_request.request_sha256 = "c".repeat(64);
        sandbox_request.idempotency_key = "late-sandbox-idempotency".into();
        let sandbox_fence = store
            .reserve_worker_execution_fence(sandbox_request.clone())
            .unwrap();

        let mut provider_unknown = WorkerExecutionFenceCompletion {
            fence_id: provider_fence.fence_id.clone(),
            claim_id: provider_request.claim_id.clone(),
            workflow_id: provider_request.workflow_id.clone(),
            task_id: provider_request.task_id.clone(),
            attempt: provider_request.attempt,
            lease_id: provider_request.lease_id.clone(),
            worker_id: provider_request.worker_id.clone(),
            owner_epoch: provider_request.owner_epoch,
            plan_sha256: provider_request.plan_sha256.clone(),
            side_effect_id: provider_request.side_effect_id.clone(),
            kind: provider_request.kind,
            request_sha256: provider_request.request_sha256.clone(),
            outcome: "UNKNOWN".into(),
            event_id: "provider-dispatch-accepted-unknown".into(),
            event_sha256: "d".repeat(64),
            outcome_sha256: "e".repeat(64),
        };
        let unknown = store
            .complete_worker_execution_fence(provider_unknown.clone())
            .unwrap();
        assert!(!unknown.terminal);
        assert_eq!(unknown.fence.state, "RESERVED");

        // The local worker result may be terminal while the remote provider
        // run is still being polled. This must not erase the provider fence.
        let failed = store
            .record_task_result(
                &lease.workflow_id,
                &lease.task_id,
                TaskResultRequest {
                    lease_id: lease.lease_id.clone(),
                    worker_id: lease.worker_id.clone(),
                    attempt: lease.attempt,
                    outcome: TaskOutcome::Failed,
                    evidence: vec![],
                    error: Some("local command failed after provider acceptance".into()),
                },
            )
            .unwrap();
        assert_eq!(failed.tasks[0].state, TaskState::Failed);

        // The narrow late-provider exception must not authorize a *new*
        // external effect after the task result has terminalized. Only the
        // reservation created while the exact lease was live may reconcile.
        let mut new_provider_request = provider_request.clone();
        new_provider_request.side_effect_id = "provider-intent-after-local-terminal".into();
        new_provider_request.idempotency_key = "late-provider-new-effect-idempotency".into();
        assert!(matches!(
            store.reserve_worker_execution_fence(new_provider_request),
            Err(StoreError::LeaseFenced)
        ));

        provider_unknown.outcome = "SUCCEEDED".into();
        provider_unknown.event_id = "provider-run-late-terminal".into();
        provider_unknown.event_sha256 = "f".repeat(64);
        provider_unknown.outcome_sha256 = "1".repeat(64);
        let reconciled = store
            .complete_worker_execution_fence_verified(
                provider_unknown.clone(),
                &TestExecutionFenceCompletionVerifier,
            )
            .unwrap();
        assert!(reconciled.terminal);
        assert_eq!(reconciled.fence.state, "COMPLETED");
        let replayed_reconciliation = store
            .complete_worker_execution_fence_verified(
                provider_unknown,
                &TestExecutionFenceCompletionVerifier,
            )
            .unwrap();
        assert_eq!(replayed_reconciliation, reconciled);

        let sandbox_completion = WorkerExecutionFenceCompletion {
            fence_id: sandbox_fence.fence_id,
            claim_id: sandbox_request.claim_id,
            workflow_id: sandbox_request.workflow_id,
            task_id: sandbox_request.task_id,
            attempt: sandbox_request.attempt,
            lease_id: sandbox_request.lease_id,
            worker_id: sandbox_request.worker_id,
            owner_epoch: sandbox_request.owner_epoch,
            plan_sha256: sandbox_request.plan_sha256,
            side_effect_id: sandbox_request.side_effect_id,
            kind: sandbox_request.kind,
            request_sha256: sandbox_request.request_sha256,
            outcome: "SUCCEEDED".into(),
            event_id: "sandbox-start-late-terminal".into(),
            event_sha256: "2".repeat(64),
            outcome_sha256: "3".repeat(64),
        };
        assert!(matches!(
            store.complete_worker_execution_fence_verified(
                sandbox_completion,
                &TestExecutionFenceCompletionVerifier,
            ),
            Err(StoreError::LeaseFenced)
        ));
        assert!(store.verify_event_chain(&lease.workflow_id).unwrap().valid);
    }

    #[test]
    fn execution_fence_unknown_observation_receipt_survives_store_restart_and_terminal_reconciliation()
     {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("execution-fence-restart.sqlite");
        let (store, workflow, lease) =
            create_approved_claimed_store(&path, "fence-restart-worker", 60);
        let request = WorkerExecutionFenceRequest {
            claim_id: "claim-fence-restart".into(),
            workflow_id: lease.workflow_id.clone(),
            task_id: lease.task_id.clone(),
            attempt: lease.attempt,
            lease_id: lease.lease_id.clone(),
            worker_id: lease.worker_id.clone(),
            owner_epoch: lease.owner_epoch,
            plan_sha256: content_hash(&workflow.plan).unwrap(),
            side_effect_id: "provider-dispatch-restart".into(),
            kind: WorkerExecutionFenceKind::ProviderDispatch,
            request_sha256: "a".repeat(64),
            idempotency_key: "fence-restart-idempotency".into(),
            acl_sha256: "b".repeat(64),
        };
        let reserved = store
            .reserve_worker_execution_fence(request.clone())
            .unwrap();
        let unknown = WorkerExecutionFenceCompletion {
            fence_id: reserved.fence_id.clone(),
            claim_id: request.claim_id.clone(),
            workflow_id: request.workflow_id.clone(),
            task_id: request.task_id.clone(),
            attempt: request.attempt,
            lease_id: request.lease_id.clone(),
            worker_id: request.worker_id.clone(),
            owner_epoch: request.owner_epoch,
            plan_sha256: request.plan_sha256.clone(),
            side_effect_id: request.side_effect_id.clone(),
            kind: request.kind,
            request_sha256: request.request_sha256.clone(),
            outcome: "UNKNOWN".into(),
            event_id: "provider-dispatch-restart-unknown".into(),
            event_sha256: "c".repeat(64),
            outcome_sha256: "d".repeat(64),
        };
        let first_observation = store
            .complete_worker_execution_fence(unknown.clone())
            .unwrap();
        assert!(!first_observation.terminal);
        assert_eq!(first_observation.fence.state, "RESERVED");
        drop(store);

        // A fresh Store pair models a Control process restart. The durable
        // UNKNOWN observation must not be interpreted as a released fence.
        let reopened = Store::open_existing(&path).unwrap();
        let replayed_unknown = reopened
            .complete_worker_execution_fence(unknown.clone())
            .unwrap();
        assert_eq!(replayed_unknown.receipt, first_observation.receipt);
        assert_eq!(replayed_unknown.recorded_at, first_observation.recorded_at);
        assert_eq!(replayed_unknown.fence.state, "RESERVED");

        let mut terminal = unknown.clone();
        terminal.outcome = "SUCCEEDED".into();
        terminal.event_id = "provider-dispatch-restart-terminal".into();
        terminal.event_sha256 = "e".repeat(64);
        terminal.outcome_sha256 = "f".repeat(64);
        let terminal_result = reopened
            .complete_worker_execution_fence_verified(
                terminal.clone(),
                &TestExecutionFenceCompletionVerifier,
            )
            .unwrap();
        assert!(terminal_result.terminal);
        assert_eq!(terminal_result.fence.state, "COMPLETED");
        drop(reopened);

        let recovered = Store::open_existing(&path).unwrap();
        let exact_unknown_replay = recovered
            .complete_worker_execution_fence(unknown.clone())
            .unwrap();
        assert_eq!(exact_unknown_replay.receipt, first_observation.receipt);
        assert_eq!(exact_unknown_replay.fence.state, "COMPLETED");
        let exact_terminal_replay = recovered
            .complete_worker_execution_fence(terminal.clone())
            .unwrap();
        assert_eq!(exact_terminal_replay.receipt, terminal_result.receipt);
        assert!(exact_terminal_replay.terminal);
        assert!(
            recovered
                .verify_event_chain(&lease.workflow_id)
                .unwrap()
                .valid
        );
        drop(recovered);

        // Even if an external writer bypasses append-only triggers, an exact
        // replay must not return the old receipt from a corrupted event chain.
        let raw = Connection::open(&path).unwrap();
        raw.execute_batch("DROP TRIGGER event_append_only_update;")
            .unwrap();
        let observation_key = format!(
            "worker.execution_fence.observation:{}:{}",
            unknown.fence_id, unknown.event_id
        );
        let payload_json: String = raw
            .query_row(
                "SELECT payload_json FROM events WHERE workflow_id=?1 AND idempotency_key=?2",
                params![lease.workflow_id, observation_key],
                |row| row.get(0),
            )
            .unwrap();
        let mut payload: serde_json::Value = serde_json::from_str(&payload_json).unwrap();
        payload["receipt"]["durable"] = serde_json::Value::Bool(false);
        raw.execute(
            "UPDATE events SET payload_json=?1 WHERE workflow_id=?2 AND idempotency_key=?3",
            params![
                serde_json::to_string(&payload).unwrap(),
                lease.workflow_id,
                observation_key
            ],
        )
        .unwrap();
        drop(raw);

        let tampered = Store::open_existing(&path).unwrap();
        assert!(matches!(
            tampered.complete_worker_execution_fence(unknown),
            Err(StoreError::Invariant(message)) if message.contains("event chain is invalid")
        ));
    }

    #[test]
    fn not_started_execution_fence_releases_only_after_independent_proof_verification() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory
            .path()
            .join("execution-fence-not-started-proof.sqlite");
        let (store, workflow, lease) =
            create_approved_claimed_store(&path, "not-started-proof-worker", 60);
        let request = WorkerExecutionFenceRequest {
            claim_id: "claim-not-started-proof".into(),
            workflow_id: lease.workflow_id.clone(),
            task_id: lease.task_id.clone(),
            attempt: lease.attempt,
            lease_id: lease.lease_id.clone(),
            worker_id: lease.worker_id.clone(),
            owner_epoch: lease.owner_epoch,
            plan_sha256: content_hash(&workflow.plan).unwrap(),
            side_effect_id: "sandbox-start-not-started-proof".into(),
            kind: WorkerExecutionFenceKind::SandboxStart,
            request_sha256: "a".repeat(64),
            idempotency_key: "not-started-proof-reservation".into(),
            acl_sha256: "b".repeat(64),
        };
        let fence = store
            .reserve_worker_execution_fence(request.clone())
            .unwrap();
        let completion = WorkerExecutionFenceCompletion {
            fence_id: fence.fence_id.clone(),
            claim_id: request.claim_id.clone(),
            workflow_id: request.workflow_id.clone(),
            task_id: request.task_id.clone(),
            attempt: request.attempt,
            lease_id: request.lease_id.clone(),
            worker_id: request.worker_id.clone(),
            owner_epoch: request.owner_epoch,
            plan_sha256: request.plan_sha256.clone(),
            side_effect_id: request.side_effect_id.clone(),
            kind: request.kind,
            request_sha256: request.request_sha256.clone(),
            outcome: "NOT_STARTED".into(),
            event_id: "sandbox-start-not-started-observation".into(),
            event_sha256: "c".repeat(64),
            outcome_sha256: "d".repeat(64),
        };
        let observed = store
            .complete_worker_execution_fence(completion.clone())
            .unwrap();
        assert!(!observed.terminal);
        assert_eq!(observed.fence.state, "RESERVED");

        // A proof-bearing terminal observation has a distinct event identity.
        let mut verified_completion = completion;
        verified_completion.event_id = "sandbox-start-not-started-proof".into();
        verified_completion.event_sha256 = "e".repeat(64);
        verified_completion.outcome_sha256 = "f".repeat(64);
        let completed = store
            .complete_worker_execution_fence_verified(
                verified_completion,
                &TestExecutionFenceCompletionVerifier,
            )
            .unwrap();
        assert!(completed.terminal);
        assert_eq!(completed.fence.state, "COMPLETED");
        assert!(store.verify_event_chain(&lease.workflow_id).unwrap().valid);
    }

    #[test]
    fn concurrent_identical_lease_renewal_replay_is_single_commit_across_store_connections() {
        use std::{
            sync::{Arc, Barrier},
            thread,
        };

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("lease-renewal-race.sqlite");
        let (first_store, _workflow, lease) =
            create_approved_claimed_store(&path, "renewal-race-worker", 60);
        let second_store = Store::open_existing(&path).unwrap();
        let first_store = Arc::new(first_store);
        let second_store = Arc::new(second_store);
        let request = TaskLeaseRenewalRequest {
            renewal_id: "renewal-race-idempotency".into(),
            workflow_id: lease.workflow_id.clone(),
            task_id: lease.task_id.clone(),
            lease_id: lease.lease_id.clone(),
            worker_id: lease.worker_id.clone(),
            attempt: lease.attempt,
            owner_epoch: lease.owner_epoch,
            lease_ttl_seconds: 120,
        };
        let barrier = Arc::new(Barrier::new(3));
        let left = {
            let store = first_store.clone();
            let barrier = barrier.clone();
            let request = request.clone();
            thread::spawn(move || {
                barrier.wait();
                store.renew_task_lease(request).unwrap()
            })
        };
        let right = {
            let store = second_store.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                store.renew_task_lease(request).unwrap()
            })
        };
        barrier.wait();
        let first = left.join().unwrap();
        let second = right.join().unwrap();
        assert_eq!(first, second);

        let connection = first_store.connection.lock().unwrap();
        let ledger_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM task_lease_renewals WHERE renewal_id='renewal-race-idempotency'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(ledger_count, 1);
        let event_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM events WHERE idempotency_key='lease.renewal:renewal-race-idempotency'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(event_count, 1);
        drop(connection);
        assert!(
            first_store
                .verify_event_chain(&lease.workflow_id)
                .unwrap()
                .valid
        );
    }

    #[test]
    fn concurrent_conflicting_lease_renewal_payloads_have_one_idempotency_winner() {
        use std::{
            sync::{Arc, Barrier},
            thread,
        };

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("lease-renewal-conflict-race.sqlite");
        let (first_store, _workflow, lease) =
            create_approved_claimed_store(&path, "renewal-conflict-worker", 60);
        let second_store = Store::open_existing(&path).unwrap();
        let first_store = Arc::new(first_store);
        let second_store = Arc::new(second_store);
        let request = TaskLeaseRenewalRequest {
            renewal_id: "renewal-conflict-idempotency".into(),
            workflow_id: lease.workflow_id.clone(),
            task_id: lease.task_id.clone(),
            lease_id: lease.lease_id.clone(),
            worker_id: lease.worker_id.clone(),
            attempt: lease.attempt,
            owner_epoch: lease.owner_epoch,
            lease_ttl_seconds: 120,
        };
        let mut conflicting = request.clone();
        conflicting.lease_ttl_seconds = 180;
        let barrier = Arc::new(Barrier::new(3));
        let left = {
            let store = first_store.clone();
            let barrier = barrier.clone();
            let request = request.clone();
            thread::spawn(move || {
                barrier.wait();
                store.renew_task_lease(request)
            })
        };
        let right = {
            let store = second_store.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                store.renew_task_lease(conflicting)
            })
        };
        barrier.wait();
        let outcomes = [left.join().unwrap(), right.join().unwrap()];
        assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            outcomes
                .iter()
                .filter(|result| matches!(result, Err(StoreError::LeaseRenewalConflict)))
                .count(),
            1
        );

        let connection = first_store.connection.lock().unwrap();
        let ledger: Vec<(i64, String)> = {
            let mut statement = connection
                .prepare("SELECT lease_ttl_seconds,expires_at FROM task_lease_renewals WHERE renewal_id='renewal-conflict-idempotency'")
                .unwrap();
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(ledger.len(), 1);
        assert!(matches!(ledger[0].0, 120 | 180));
        let event_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM events WHERE idempotency_key='lease.renewal:renewal-conflict-idempotency'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(event_count, 1);
        drop(connection);
        assert!(
            first_store
                .verify_event_chain(&lease.workflow_id)
                .unwrap()
                .valid
        );
    }

    #[test]
    fn expired_lease_renewal_races_with_quarantine_and_never_resurrects_owner() {
        use std::{
            sync::{Arc, Barrier},
            thread,
        };

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("lease-expiry-quarantine-race.sqlite");
        let (first_store, _workflow, lease) =
            create_approved_claimed_store(&path, "renewal-quarantine-worker", 1);
        let second_store = Store::open_existing(&path).unwrap();
        let first_store = Arc::new(first_store);
        let second_store = Arc::new(second_store);
        let request = TaskLeaseRenewalRequest {
            renewal_id: "renewal-quarantine-race".into(),
            workflow_id: lease.workflow_id.clone(),
            task_id: lease.task_id.clone(),
            lease_id: lease.lease_id.clone(),
            worker_id: lease.worker_id.clone(),
            attempt: lease.attempt,
            owner_epoch: lease.owner_epoch,
            lease_ttl_seconds: 120,
        };
        std::thread::sleep(std::time::Duration::from_millis(1_100));
        let barrier = Arc::new(Barrier::new(3));
        let renewal = {
            let store = first_store.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                store.renew_task_lease(request)
            })
        };
        let quarantine = {
            let store = second_store.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                store.quarantine_expired_leases()
            })
        };
        barrier.wait();
        let renewal_result = renewal.join().unwrap();
        let quarantine_result = quarantine.join().unwrap().unwrap();
        assert!(matches!(renewal_result, Err(StoreError::LeaseFenced)));
        assert_eq!(quarantine_result, 1);
        let workflow = first_store.get_workflow(&lease.workflow_id).unwrap();
        assert_eq!(workflow.tasks[0].state, TaskState::Unknown);
        let connection = first_store.connection.lock().unwrap();
        let renewal_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM task_lease_renewals WHERE renewal_id='renewal-quarantine-race'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(renewal_count, 0);
    }

    #[test]
    fn concurrent_identical_execution_fence_reservation_and_completion_share_receipts() {
        use std::{
            sync::{Arc, Barrier},
            thread,
        };

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("execution-fence-race.sqlite");
        let (first_store, workflow, lease) =
            create_approved_claimed_store(&path, "fence-race-worker", 60);
        let second_store = Store::open_existing(&path).unwrap();
        let first_store = Arc::new(first_store);
        let second_store = Arc::new(second_store);
        let request = WorkerExecutionFenceRequest {
            claim_id: "claim-concurrent-fence".into(),
            workflow_id: lease.workflow_id.clone(),
            task_id: lease.task_id.clone(),
            attempt: lease.attempt,
            lease_id: lease.lease_id.clone(),
            worker_id: lease.worker_id.clone(),
            owner_epoch: lease.owner_epoch,
            plan_sha256: content_hash(&workflow.plan).unwrap(),
            side_effect_id: "sandbox-concurrent-side-effect".into(),
            kind: WorkerExecutionFenceKind::SandboxStart,
            request_sha256: "1".repeat(64),
            idempotency_key: "fence-concurrent-idempotency".into(),
            acl_sha256: "2".repeat(64),
        };
        let barrier = Arc::new(Barrier::new(3));
        let left = {
            let store = first_store.clone();
            let barrier = barrier.clone();
            let request = request.clone();
            thread::spawn(move || {
                barrier.wait();
                store.reserve_worker_execution_fence(request).unwrap()
            })
        };
        let right = {
            let store = second_store.clone();
            let barrier = barrier.clone();
            let request = request.clone();
            thread::spawn(move || {
                barrier.wait();
                store.reserve_worker_execution_fence(request).unwrap()
            })
        };
        barrier.wait();
        let first = left.join().unwrap();
        let second = right.join().unwrap();
        assert_eq!(first.fence_id, second.fence_id);
        assert_eq!(first.receipt, second.receipt);

        let completion = WorkerExecutionFenceCompletion {
            fence_id: first.fence_id.clone(),
            claim_id: request.claim_id.clone(),
            workflow_id: request.workflow_id.clone(),
            task_id: request.task_id.clone(),
            attempt: request.attempt,
            lease_id: request.lease_id.clone(),
            worker_id: request.worker_id.clone(),
            owner_epoch: request.owner_epoch,
            plan_sha256: request.plan_sha256.clone(),
            side_effect_id: request.side_effect_id.clone(),
            kind: request.kind,
            request_sha256: request.request_sha256.clone(),
            outcome: "UNKNOWN".into(),
            event_id: "sandbox-concurrent-unknown-event".into(),
            event_sha256: "3".repeat(64),
            outcome_sha256: "4".repeat(64),
        };
        let barrier = Arc::new(Barrier::new(3));
        let left = {
            let store = first_store.clone();
            let barrier = barrier.clone();
            let completion = completion.clone();
            thread::spawn(move || {
                barrier.wait();
                store.complete_worker_execution_fence(completion).unwrap()
            })
        };
        let right = {
            let store = second_store.clone();
            let barrier = barrier.clone();
            let completion = completion.clone();
            thread::spawn(move || {
                barrier.wait();
                store.complete_worker_execution_fence(completion).unwrap()
            })
        };
        barrier.wait();
        let first_completion = left.join().unwrap();
        let second_completion = right.join().unwrap();
        assert_eq!(first_completion.receipt, second_completion.receipt);
        assert!(!first_completion.terminal);
        assert_eq!(first_completion.fence.state, "RESERVED");

        // Two independent connections racing to bind the same observation
        // event ID to different bytes must have exactly one durable winner.
        let mut conflicting_left = completion.clone();
        conflicting_left.event_id = "sandbox-concurrent-conflicting-event".into();
        conflicting_left.event_sha256 = "7".repeat(64);
        let mut conflicting_right = conflicting_left.clone();
        conflicting_right.event_sha256 = "8".repeat(64);
        let barrier = Arc::new(Barrier::new(3));
        let left = {
            let store = first_store.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                store.complete_worker_execution_fence(conflicting_left)
            })
        };
        let right = {
            let store = second_store.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                store.complete_worker_execution_fence(conflicting_right)
            })
        };
        barrier.wait();
        let conflicting_results = [left.join().unwrap(), right.join().unwrap()];
        assert_eq!(
            conflicting_results
                .iter()
                .filter(|result| result.is_ok())
                .count(),
            1
        );
        assert_eq!(
            conflicting_results
                .iter()
                .filter(|result| matches!(result, Err(StoreError::WorkerExecutionFenceConflict)))
                .count(),
            1
        );

        let mut terminal_completion = completion.clone();
        terminal_completion.outcome = "SUCCEEDED".into();
        terminal_completion.event_id = "sandbox-concurrent-terminal-event".into();
        terminal_completion.event_sha256 = "5".repeat(64);
        terminal_completion.outcome_sha256 = "6".repeat(64);
        let terminal = second_store
            .complete_worker_execution_fence_verified(
                terminal_completion,
                &TestExecutionFenceCompletionVerifier,
            )
            .unwrap();
        assert!(terminal.terminal);
        assert_eq!(terminal.fence.state, "COMPLETED");
        let replayed_unknown = first_store
            .complete_worker_execution_fence(completion)
            .unwrap();
        assert_eq!(replayed_unknown.receipt, first_completion.receipt);
        assert_eq!(replayed_unknown.fence.state, "COMPLETED");

        let connection = first_store.connection.lock().unwrap();
        let fence_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM worker_execution_fences WHERE idempotency_key='fence-concurrent-idempotency'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(fence_count, 1);
        let reserved_events: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM events WHERE idempotency_key LIKE 'worker.execution_fence.reserved:%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let completed_events: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM events WHERE event_type='worker.execution_fence_completed'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(reserved_events, 1);
        let observed_events: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM events WHERE event_type='worker.execution_fence_observed'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(observed_events, 2);
        assert_eq!(completed_events, 1);
        drop(connection);
        assert!(
            first_store
                .verify_event_chain(&lease.workflow_id)
                .unwrap()
                .valid
        );
    }

    #[test]
    fn node_success_predicate_oracle_fixture_is_consumed_and_covers_all_families() {
        // This guards the checked-in Node oracle inventory. It is not a claim
        // that the Rust evaluator has semantic parity: seven families below
        // still require evidence that the Part 1 store does not model.
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/success-contract-predicate-v1-node.json"
        ))
        .unwrap();
        assert_eq!(fixture["schema_version"], 1);
        assert_eq!(
            fixture["oracle"],
            "src/runtime/workflow/success-contract.js evaluateSuccessPredicate"
        );
        let cases = fixture["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 15);
        let mut types = std::collections::BTreeSet::new();
        let mut ids = std::collections::BTreeSet::new();
        let mut unresolved_types = std::collections::BTreeSet::new();
        for case in cases {
            let id = case["case_id"].as_str().unwrap();
            let kind = case["predicate"]["type"].as_str().unwrap();
            assert!(ids.insert(id), "duplicate Node oracle case {id}");
            types.insert(kind);
            assert_eq!(case["result"]["id"], case["predicate"]["id"]);
            assert_eq!(case["result"]["type"], kind);
            assert!(case["result"]["passed"].is_boolean());
            assert!(case["result"]["evidence_artifact_ids"].is_array());
            if matches!(
                kind,
                "workflow_id_equals"
                    | "local_execution_only"
                    | "execution_exit_code_equals"
                    | "artifact_exists"
                    | "artifact_field_equals"
                    | "artifact_field_includes"
                    | "artifact_field_non_empty"
            ) {
                unresolved_types.insert(kind);
            }
        }
        assert_eq!(types.len(), 11);
        assert_eq!(
            unresolved_types,
            [
                "workflow_id_equals",
                "local_execution_only",
                "execution_exit_code_equals",
                "artifact_exists",
                "artifact_field_equals",
                "artifact_field_includes",
                "artifact_field_non_empty",
            ]
            .into_iter()
            .collect()
        );
    }

    #[test]
    fn node_predicate_fixture_drives_persisted_rust_evaluation_for_supported_evidence() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/success-contract-predicate-v1-node.json"
        ))
        .unwrap();
        let store = Store::in_memory().unwrap();
        for (index, expected) in fixture["cases"].as_array().unwrap().iter().enumerate() {
            let case_id = expected["case_id"].as_str().unwrap();
            if matches!(
                case_id,
                "task-status-missing" | "reviewer-role-forbidden" | "qa-artifact-wrong-role"
            ) {
                // Rust rejects unknown-task, incompatible task-role and
                // unknown artifact-producer references at policy attachment;
                // Node defers them to evaluation and returns FAIL. Keep these
                // compatibility differences explicit instead of bypassing
                // the production validator here.
                continue;
            }
            let mut policy = workflow_policy();
            policy.policy_id = format!("node-diff-policy-{index}");
            policy.success_criteria = vec![expected["predicate"].clone()];
            store
                .create_workflow_policy(policy.clone(), "authenticated-policy-author")
                .unwrap();
            let mut proposed = proposal();
            proposed.workflow_id = format!("job_node_diff_{index}");
            proposed.tasks[0].task_id = "task-one".into();
            proposed.tasks[0].required_evidence.clear();
            proposed.tasks.push(TaskSpec {
                task_id: "task-two".into(),
                role: "reviewer".into(),
                description: "Review persisted workflow evidence".into(),
                depends_on: vec![],
                required_evidence: vec![],
                inputs: BTreeMap::new(),
            });
            let workflow = store.create_proposal(proposed).unwrap();
            store
                .attach_workflow_policy(
                    &workflow.workflow_id,
                    &policy.policy_id,
                    Some(1),
                    serde_json::json!({"goal":"Compare persisted predicates to the Node oracle"}),
                    "authenticated-policy-author",
                )
                .unwrap();
            store
                .approve(
                    &workflow.workflow_id,
                    approval_request(&workflow),
                    &TestApprovalVerifier,
                )
                .unwrap();
            store
                .admit_workflow(&workflow.workflow_id, &TestApprovalVerifier)
                .unwrap();
            for task_id in ["task-one", "task-two"] {
                let lease = store
                    .claim_task(
                        &workflow.workflow_id,
                        task_id,
                        ClaimRequest {
                            worker_id: format!("worker-{index}-{task_id}"),
                            lease_ttl_seconds: 60,
                        },
                        &TestApprovalVerifier,
                    )
                    .unwrap();
                store
                    .record_task_result(
                        &workflow.workflow_id,
                        task_id,
                        TaskResultRequest {
                            lease_id: lease.lease_id,
                            worker_id: lease.worker_id,
                            attempt: lease.attempt,
                            outcome: TaskOutcome::Succeeded,
                            evidence: vec![EvidenceRef {
                                artifact_id: format!("artifact-{index}-{task_id}"),
                                sha256: "c".repeat(64),
                                producer_task_id: task_id.into(),
                                producer_attempt: lease.attempt,
                                kind: "report".into(),
                            }],
                            error: None,
                        },
                    )
                    .unwrap();
            }
            let connection = store.connection.lock().unwrap();
            let report =
                evaluate_persisted_success_contract(&connection, &workflow.workflow_id).unwrap();
            let expected_id = expected["result"]["id"].as_str().unwrap();
            let actual = report["predicates"]
                .as_array()
                .unwrap()
                .iter()
                .find(|predicate| {
                    predicate["id"]
                        .as_str()
                        .is_some_and(|id| id.ends_with(expected_id))
                })
                .unwrap_or_else(|| panic!("missing persisted predicate {case_id}"));
            assert_eq!(actual["type"], expected["result"]["type"], "{case_id}");
            match case_id {
                "all-tasks-completed" => {
                    assert_eq!(actual["disposition"], "PASS");
                    assert_eq!(actual["passed"], true);
                    assert_eq!(actual["actual"], expected["result"]["actual"]);
                }
                "task-status-completed" | "engineer-role-present" | "forbidden-role-absent" => {
                    assert_eq!(actual["disposition"], "PASS", "{case_id}");
                    assert_eq!(actual["passed"], expected["result"]["passed"], "{case_id}");
                    assert_eq!(actual["actual"], expected["result"]["actual"], "{case_id}");
                }
                _ => {
                    // These seven predicate families require catalog-kind,
                    // execution-mode/exit-code or validated artifact authority
                    // not represented by the Part 1 persisted evidence model.
                    // They must stay unresolved, even where the Node fixture
                    // happens to evaluate true or false from richer context.
                    assert_eq!(actual["disposition"], "UNRESOLVED", "{case_id}");
                    assert_eq!(actual["passed"], false, "{case_id}");
                }
            }
            drop(connection);
        }
    }

    #[test]
    fn unsupported_artifact_success_predicate_keeps_workflow_unresolved_not_completed() {
        let store = Store::in_memory().unwrap();
        let mut policy = workflow_policy();
        policy.success_criteria = vec![
            serde_json::json!({
                "id":"catalog-workflow-kind","type":"workflow_id_equals",
                "expected":"standard-engineering"
            }),
            serde_json::json!({
                "id":"local-only","type":"local_execution_only"
            }),
            serde_json::json!({
                "id":"exit-zero","type":"execution_exit_code_equals",
                "task_id":"task-one","expected":0
            }),
            serde_json::json!({
                "id":"validated-qa-report","type":"artifact_exists",
                "artifact_type":"qa-report","producer_role":"engineer"
            }),
            serde_json::json!({
                "id":"qa-score","type":"artifact_field_equals",
                "artifact_type":"qa-report","field":"score","expected":100
            }),
            serde_json::json!({
                "id":"qa-findings","type":"artifact_field_includes",
                "artifact_type":"qa-report","field":"findings","expected":"none"
            }),
            serde_json::json!({
                "id":"qa-summary","type":"artifact_field_non_empty",
                "artifact_type":"qa-report","field":"summary"
            }),
        ];
        store
            .create_workflow_policy(policy, "authenticated-policy-author")
            .unwrap();
        let mut proposed = proposal();
        proposed.tasks[0].task_id = "task-one".into();
        let workflow = store.create_proposal(proposed).unwrap();
        store
            .attach_workflow_policy(
                &workflow.workflow_id,
                "require-engineer",
                Some(1),
                serde_json::json!({"goal":"Verify append-only storage invariants"}),
                "authenticated-policy-author",
            )
            .unwrap();
        store
            .approve(
                &workflow.workflow_id,
                approval_request(&workflow),
                &TestApprovalVerifier,
            )
            .unwrap();
        let lease = store
            .claim_task(
                &workflow.workflow_id,
                "task-one",
                ClaimRequest {
                    worker_id: "worker-one".into(),
                    lease_ttl_seconds: 60,
                },
                &TestApprovalVerifier,
            )
            .unwrap();
        let result = store
            .record_task_result(
                &workflow.workflow_id,
                "task-one",
                TaskResultRequest {
                    lease_id: lease.lease_id,
                    worker_id: lease.worker_id,
                    attempt: lease.attempt,
                    outcome: TaskOutcome::Succeeded,
                    evidence: vec![EvidenceRef {
                        artifact_id: "artifact-task-one".into(),
                        sha256: "b".repeat(64),
                        producer_task_id: "task-one".into(),
                        producer_attempt: lease.attempt,
                        kind: "report".into(),
                    }],
                    error: None,
                },
            )
            .unwrap();
        assert_eq!(result.state, WorkflowState::Executing);
        assert!(
            store
                .list_workflow_events(&workflow.workflow_id, 50)
                .unwrap()
                .iter()
                .any(|event| event.event_type == "workflow.success_contract_unresolved")
        );
        let report = store.synthesize_workflow(&workflow.workflow_id).unwrap();
        assert_eq!(report["outcome"], "UNRESOLVED");
        assert_eq!(report["success_evaluation"]["outcome"], "UNRESOLVED");
        let predicates = report["success_evaluation"]["predicates"]
            .as_array()
            .unwrap();
        assert!(
            [
                "p-require-engineer-catalog-workflow-kind",
                "p-require-engineer-local-only",
                "p-require-engineer-exit-zero",
                "p-require-engineer-validated-qa-report",
                "p-require-engineer-qa-score",
                "p-require-engineer-qa-findings",
                "p-require-engineer-qa-summary",
            ]
            .iter()
            .all(|id| predicates.iter().any(|predicate| predicate["id"] == *id)),
            "missing expected predicate; got {predicates:?}"
        );
        for id in [
            "p-require-engineer-catalog-workflow-kind",
            "p-require-engineer-local-only",
            "p-require-engineer-exit-zero",
            "p-require-engineer-validated-qa-report",
            "p-require-engineer-qa-score",
            "p-require-engineer-qa-findings",
            "p-require-engineer-qa-summary",
        ] {
            let predicate = predicates
                .iter()
                .find(|predicate| predicate["id"] == id)
                .unwrap();
            assert_eq!(predicate["passed"], false, "{id}");
            assert_eq!(predicate["disposition"], "UNRESOLVED", "{id}");
        }
        assert!(predicates.iter().any(|predicate| {
            predicate["type"] == "workflow_id_equals"
                && predicate["reason"]
                    .as_str()
                    .unwrap()
                    .contains("no verified immutable catalog-plan binding")
        }));
        assert!(
            store
                .verify_event_chain(&workflow.workflow_id)
                .unwrap()
                .valid
        );
    }

    #[test]
    fn authenticated_result_envelope_is_durable_idempotent_and_conflict_fenced() {
        struct EnvelopeVerifier {
            calls: std::sync::atomic::AtomicUsize,
            changed_provenance: std::sync::atomic::AtomicBool,
            reject: std::sync::atomic::AtomicBool,
        }
        impl TaskResultProducerVerifier for EnvelopeVerifier {
            fn authenticate_producer(
                &self,
                _transaction: &Transaction<'_>,
                _workflow_id: &str,
                _task_id: &str,
                _request: &TaskResultRequest,
            ) -> Result<String, StoreError> {
                Ok("worker-one".into())
            }
            fn authenticate_envelope(
                &self,
                _transaction: &Transaction<'_>,
                _workflow_id: &str,
                _task_id: &str,
                envelope: &TaskResultEnvelope,
            ) -> Result<VerifiedTaskResultProducer, StoreError> {
                self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if self.reject.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err(StoreError::ApprovalAuthorityUnavailable);
                }
                Ok(VerifiedTaskResultProducer {
                    worker_id: "worker-one".into(),
                    producer_id: envelope.producer_id.clone(),
                    provenance_sha256: if self
                        .changed_provenance
                        .load(std::sync::atomic::Ordering::SeqCst)
                    {
                        "e".repeat(64)
                    } else {
                        "c".repeat(64)
                    },
                })
            }
        }
        let verifier = EnvelopeVerifier {
            calls: std::sync::atomic::AtomicUsize::new(0),
            changed_provenance: std::sync::atomic::AtomicBool::new(false),
            reject: std::sync::atomic::AtomicBool::new(false),
        };
        let store = Store::in_memory().unwrap();
        let workflow = store.create_proposal(proposal()).unwrap();
        store
            .approve(
                &workflow.workflow_id,
                approval_request(&workflow),
                &TestApprovalVerifier,
            )
            .unwrap();
        let lease = store
            .claim_task(
                &workflow.workflow_id,
                "task_one",
                ClaimRequest {
                    worker_id: "worker-one".into(),
                    lease_ttl_seconds: 60,
                },
                &TestApprovalVerifier,
            )
            .unwrap();
        let request = TaskResultRequest {
            lease_id: lease.lease_id,
            worker_id: lease.worker_id,
            attempt: lease.attempt,
            outcome: TaskOutcome::Succeeded,
            evidence: vec![EvidenceRef {
                artifact_id: "artifact-inbox-one".into(),
                sha256: "d".repeat(64),
                producer_task_id: "task_one".into(),
                producer_attempt: lease.attempt,
                kind: "report".into(),
            }],
            error: None,
        };
        let make_envelope = |event_id: &str, request: TaskResultRequest| {
            let payload = serde_json::json!({
                "workflow_id":workflow.workflow_id,"task_id":"task_one","event_id":event_id,
                "producer_id":"runner:unit-test","request":request
            });
            TaskResultEnvelope {
                event_id: event_id.into(),
                producer_id: "runner:unit-test".into(),
                payload_sha256: content_hash(&payload).unwrap(),
                request,
            }
        };
        let envelope = make_envelope("result-event-001", request.clone());
        store
            .record_task_result_envelope(
                &workflow.workflow_id,
                "task_one",
                envelope.clone(),
                &verifier,
            )
            .unwrap();
        assert_eq!(verifier.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        store
            .record_task_result_envelope(
                &workflow.workflow_id,
                "task_one",
                envelope.clone(),
                &verifier,
            )
            .unwrap();
        assert_eq!(
            verifier.calls.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "idempotent replay must reauthenticate producer provenance"
        );
        verifier
            .reject
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(matches!(
            store.record_task_result_envelope(
                &workflow.workflow_id,
                "task_one",
                envelope.clone(),
                &verifier,
            ),
            Err(StoreError::ApprovalAuthorityUnavailable)
        ));
        verifier
            .reject
            .store(false, std::sync::atomic::Ordering::SeqCst);
        verifier
            .changed_provenance
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(matches!(
            store.record_task_result_envelope(
                &workflow.workflow_id,
                "task_one",
                envelope.clone(),
                &verifier,
            ),
            Err(StoreError::ResultEnvelopeRejected(_))
        ));
        verifier
            .changed_provenance
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let mut conflicting = request.clone();
        conflicting.evidence[0].sha256 = "e".repeat(64);
        assert!(
            store
                .record_task_result_envelope(
                    &workflow.workflow_id,
                    "task_one",
                    make_envelope("result-event-001", conflicting),
                    &verifier,
                )
                .is_err()
        );
        assert!(
            store
                .record_task_result_envelope(
                    &workflow.workflow_id,
                    "task_one",
                    make_envelope("result-event-002", request),
                    &verifier,
                )
                .is_err()
        );
        let connection = store.connection.lock().unwrap();
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM workflow_result_inbox WHERE workflow_id=?1",
                params![workflow.workflow_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert!(
            connection
                .execute(
                    "DELETE FROM workflow_result_inbox WHERE event_id='result-event-001'",
                    []
                )
                .is_err()
        );
        drop(connection);
        let connection = store.connection.lock().unwrap();
        let original_payload_json: String = connection
            .query_row(
                "SELECT payload_json FROM workflow_result_inbox WHERE event_id='result-event-001'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        connection
            .execute_batch("DROP TRIGGER workflow_result_inbox_no_update;")
            .unwrap();
        connection
            .execute(
                "UPDATE workflow_result_inbox SET payload_json='{}' WHERE event_id='result-event-001'",
                [],
            )
            .unwrap();
        drop(connection);
        assert!(matches!(
            store.record_task_result_envelope(
                &workflow.workflow_id,
                "task_one",
                envelope.clone(),
                &verifier,
            ),
            Err(StoreError::ResultEnvelopeRejected(_))
        ));
        let connection = store.connection.lock().unwrap();
        connection
            .execute(
                "UPDATE workflow_result_inbox SET payload_json=?1 WHERE event_id='result-event-001'",
                params![original_payload_json],
            )
            .unwrap();
        drop(connection);
        let connection = store.connection.lock().unwrap();
        let original_result_json: String = connection
            .query_row(
                "SELECT result_json FROM tasks WHERE workflow_id=?1 AND task_id='task_one'",
                params![workflow.workflow_id],
                |row| row.get(0),
            )
            .unwrap();
        connection
            .execute_batch("DROP TRIGGER task_result_append_only;")
            .unwrap();
        connection
            .execute(
                "UPDATE tasks SET result_json='{}' WHERE workflow_id=?1 AND task_id='task_one'",
                params![workflow.workflow_id],
            )
            .unwrap();
        drop(connection);
        assert!(matches!(
            store.record_task_result_envelope(
                &workflow.workflow_id,
                "task_one",
                envelope.clone(),
                &verifier,
            ),
            Err(StoreError::ResultEnvelopeRejected(_))
        ));
        let connection = store.connection.lock().unwrap();
        connection
            .execute(
                "UPDATE tasks SET result_json=?1 WHERE workflow_id=?2 AND task_id='task_one'",
                params![original_result_json, workflow.workflow_id],
            )
            .unwrap();
        drop(connection);
        assert!(
            store
                .verify_event_chain(&workflow.workflow_id)
                .unwrap()
                .valid
        );
        let connection = store.connection.lock().unwrap();
        connection
            .execute_batch("DROP TRIGGER event_append_only_update;")
            .unwrap();
        connection
            .execute(
                "UPDATE events SET payload_json='{}' WHERE workflow_id=?1 AND idempotency_key=?2",
                params![workflow.workflow_id, "result-inbox:result-event-001"],
            )
            .unwrap();
        drop(connection);
        assert!(matches!(
            store.record_task_result_envelope(
                &workflow.workflow_id,
                "task_one",
                envelope,
                &verifier,
            ),
            Err(StoreError::ResultEnvelopeRejected(_))
        ));
        assert!(
            !store
                .verify_event_chain(&workflow.workflow_id)
                .unwrap()
                .valid
        );
    }

    #[test]
    fn result_envelope_payload_mismatch_and_verifier_failure_do_not_mutate_task() {
        struct RejectEnvelope;
        impl TaskResultProducerVerifier for RejectEnvelope {
            fn authenticate_producer(
                &self,
                _transaction: &Transaction<'_>,
                _workflow_id: &str,
                _task_id: &str,
                _request: &TaskResultRequest,
            ) -> Result<String, StoreError> {
                Ok("worker-one".into())
            }
            fn authenticate_envelope(
                &self,
                _transaction: &Transaction<'_>,
                _workflow_id: &str,
                _task_id: &str,
                _envelope: &TaskResultEnvelope,
            ) -> Result<VerifiedTaskResultProducer, StoreError> {
                Err(StoreError::ApprovalAuthorityUnavailable)
            }
        }
        let store = Store::in_memory().unwrap();
        let workflow = store.create_proposal(proposal()).unwrap();
        store
            .approve(
                &workflow.workflow_id,
                approval_request(&workflow),
                &TestApprovalVerifier,
            )
            .unwrap();
        let lease = store
            .claim_task(
                &workflow.workflow_id,
                "task_one",
                ClaimRequest {
                    worker_id: "worker-one".into(),
                    lease_ttl_seconds: 60,
                },
                &TestApprovalVerifier,
            )
            .unwrap();
        let request = TaskResultRequest {
            lease_id: lease.lease_id,
            worker_id: lease.worker_id,
            attempt: lease.attempt,
            outcome: TaskOutcome::Succeeded,
            evidence: vec![EvidenceRef {
                artifact_id: "artifact-inbox-two".into(),
                sha256: "f".repeat(64),
                producer_task_id: "task_one".into(),
                producer_attempt: lease.attempt,
                kind: "report".into(),
            }],
            error: None,
        };
        let request_for_envelope = request.clone();
        let payload = serde_json::json!({
            "workflow_id":workflow.workflow_id,"task_id":"task_one","event_id":"result-event-003",
            "producer_id":"runner:unit-test","request":request
        });
        let valid_digest = content_hash(&payload).unwrap();
        let request = request_for_envelope;
        let forged = TaskResultEnvelope {
            event_id: "result-event-003".into(),
            producer_id: "runner:unit-test".into(),
            payload_sha256: "0".repeat(64),
            request: request.clone(),
        };
        assert!(
            store
                .record_task_result_envelope(
                    &workflow.workflow_id,
                    "task_one",
                    forged,
                    &RejectEnvelope
                )
                .is_err()
        );
        let valid = TaskResultEnvelope {
            event_id: "result-event-003".into(),
            producer_id: "runner:unit-test".into(),
            payload_sha256: valid_digest,
            request,
        };
        assert!(matches!(
            store.record_task_result_envelope(
                &workflow.workflow_id,
                "task_one",
                valid,
                &RejectEnvelope
            ),
            Err(StoreError::ApprovalAuthorityUnavailable)
        ));
        let task = store
            .inspect_task_attempt(&workflow.workflow_id, "task_one")
            .unwrap();
        assert_eq!(task.state, TaskState::Running);
        assert_eq!(task.attempt, 1);
        let count: i64 = store
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM workflow_result_inbox WHERE workflow_id=?1",
                params![workflow.workflow_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    fn custom_role() -> CustomRoleDefinition {
        CustomRoleDefinition {
            role_id: "custom-owner".into(),
            version: 1,
            name: "Custom Owner".into(),
            description: "Catalog role fixture".into(),
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
        }
    }

    fn custom_workflow() -> CustomWorkflowDefinition {
        CustomWorkflowDefinition {
            workflow_id: "custom-process".into(),
            version: 1,
            name: "Custom Process".into(),
            description: "Persisted catalog fixture".into(),
            input_contract: vec![runalith_domain::workflow::ArtifactType::JobRequest],
            tasks: vec![runalith_domain::workflow::WorkflowTaskDefinition {
                id: "requirements".into(),
                role_id: "custom-owner".into(),
                role_version: 1,
                depends_on: vec![],
                input_contract: Some(vec![runalith_domain::workflow::ArtifactType::JobRequest]),
                output_artifact_type: Some(runalith_domain::workflow::ArtifactType::Requirements),
            }],
        }
    }

    #[test]
    fn custom_catalog_versions_are_immutable_and_compiled_plans_are_persisted() {
        let store = Store::in_memory().unwrap();
        let role = store
            .create_custom_role(custom_role(), "catalog-admin")
            .unwrap();
        assert_eq!(role.definition.version, 1);
        assert_eq!(store.get_custom_role("custom-owner", None).unwrap(), role);

        let mut role_v2 = custom_role();
        role_v2.description = "Updated description".into();
        let updated_role = store
            .update_custom_role("custom-owner", role_v2, "catalog-admin")
            .unwrap();
        assert_eq!(updated_role.definition.version, 2);
        assert_eq!(
            store.get_custom_role("custom-owner", Some(1)).unwrap(),
            role
        );
        assert_eq!(store.list_custom_roles(true, 10).unwrap().len(), 2);

        let workflow = store
            .create_custom_workflow(custom_workflow(), "catalog-admin")
            .unwrap();
        assert_eq!(workflow.definition.version, 1);
        let compiled = store
            .compile_custom_workflow("custom-process", None, "planner")
            .unwrap();
        assert_eq!(compiled.workflow_version, 1);
        assert_eq!(compiled.plan.execution_order(), ["requirements"]);
        assert_eq!(
            store.get_custom_workflow_plan(&compiled.plan_id).unwrap(),
            compiled
        );

        let mut workflow_v2 = custom_workflow();
        workflow_v2.description = "Second immutable version".into();
        let updated_workflow = store
            .update_custom_workflow("custom-process", workflow_v2, "catalog-admin")
            .unwrap();
        assert_eq!(updated_workflow.definition.version, 2);
        assert_eq!(
            store
                .get_custom_workflow("custom-process", Some(1))
                .unwrap(),
            workflow
        );
        assert_eq!(store.list_custom_workflows(true, 10).unwrap().len(), 2);
        assert_eq!(
            store.get_custom_workflow_plan(&compiled.plan_id).unwrap(),
            compiled
        );
    }

    #[test]
    fn node_predicate_normalization_matches_all_fifteen_oracle_shapes_and_trim_rules() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/success-contract-predicate-v1-node.json"
        ))
        .unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 15);

        for case in cases {
            let case_id = case["case_id"].as_str().unwrap();
            let expected = &case["predicate"];
            let normalized =
                normalize_success_contract_predicate(expected, "Node oracle predicate")
                    .unwrap_or_else(|error| panic!("{case_id}: {error}"));
            assert_eq!(&normalized, expected, "canonical Node fixture: {case_id}");

            let mut padded = expected.as_object().unwrap().clone();
            for key in [
                "id",
                "type",
                "description",
                "task_id",
                "role",
                "producer_role",
                "field",
            ] {
                if let Some(value) = padded.get(key).and_then(serde_json::Value::as_str) {
                    padded.insert(
                        key.to_owned(),
                        serde_json::Value::String(format!("  {value}  ")),
                    );
                }
            }
            if matches!(
                expected["type"].as_str(),
                Some("workflow_id_equals" | "artifact_field_equals" | "artifact_field_includes")
            ) {
                if let Some(value) = padded.get("expected").and_then(serde_json::Value::as_str) {
                    padded.insert(
                        "expected".into(),
                        serde_json::Value::String(format!("  {value}  ")),
                    );
                }
            }
            let normalized_padded = normalize_success_contract_predicate(
                &serde_json::Value::Object(padded.clone()),
                "padded Node oracle predicate",
            )
            .unwrap_or_else(|error| panic!("{case_id} padded: {error}"));
            assert_eq!(normalized_padded, normalized, "trim parity: {case_id}");

            padded.insert("caller_supplied_pass".into(), serde_json::Value::Bool(true));
            assert!(
                normalize_success_contract_predicate(
                    &serde_json::Value::Object(padded),
                    "injected Node oracle predicate"
                )
                .is_err(),
                "unknown field was accepted for {case_id}"
            );
        }
    }

    #[test]
    fn workflow_id_equals_uses_verified_catalog_binding_not_instance_or_metadata() {
        struct NoSkillResolver;
        impl TrustedSkillResolver for NoSkillResolver {
            fn resolve_and_verify(
                &self,
                _: &Transaction<'_>,
                _: &str,
            ) -> Result<VerifiedTrustedSkill, StoreError> {
                Err(StoreError::ApprovalAuthorityUnavailable)
            }
        }

        let store = Store::in_memory().unwrap();
        store
            .create_custom_role(custom_role(), "catalog-admin")
            .unwrap();
        store
            .create_custom_workflow(custom_workflow(), "catalog-admin")
            .unwrap();
        let compiled = store
            .compile_custom_workflow("custom-process", Some(1), "planner")
            .unwrap();
        store
            .create_workflow_policy(
                WorkflowPolicyDefinition {
                    schema_version: 1,
                    policy_id: "catalog-identity".into(),
                    name: "Catalog identity".into(),
                    description: "Compare against exact immutable catalog plan identity".into(),
                    constraints: vec![],
                    success_criteria: vec![serde_json::json!({
                        "id":"catalog-workflow-kind",
                        "type":"workflow_id_equals",
                        "expected":"custom-process"
                    })],
                },
                "authenticated-policy-author",
            )
            .unwrap();

        let bound = store
            .create_proposal_from_custom_workflow_plan(
                &compiled.plan_id,
                "catalog-workflow-create-001",
                "Catalog-bound workflow",
                "Verify exact catalog identity binding",
                "workflow-creator",
                &NoSkillResolver,
            )
            .unwrap();
        assert_ne!(bound.workflow_id, "custom-process");
        assert!(bound.workflow_id.starts_with("job_"));
        let replay = store
            .create_proposal_from_custom_workflow_plan(
                &compiled.plan_id,
                "catalog-workflow-create-001",
                "Catalog-bound workflow",
                "Verify exact catalog identity binding",
                "workflow-creator",
                &NoSkillResolver,
            )
            .unwrap();
        assert_eq!(replay.workflow_id, bound.workflow_id);
        assert!(
            store
                .create_proposal_from_custom_workflow_plan(
                    &compiled.plan_id,
                    "catalog-workflow-create-001",
                    "Changed title",
                    "Verify exact catalog identity binding",
                    "workflow-creator",
                    &NoSkillResolver,
                )
                .is_err()
        );
        store
            .attach_workflow_policy(
                &bound.workflow_id,
                "catalog-identity",
                Some(1),
                serde_json::json!({"goal":"Verify exact catalog identity binding"}),
                "authenticated-policy-author",
            )
            .unwrap();
        store
            .approve(
                &bound.workflow_id,
                approval_request(&bound),
                &TestApprovalVerifier,
            )
            .unwrap();
        let connection = store.connection.lock().unwrap();
        let bound_view = load_workflow_from(&connection, &bound.workflow_id).unwrap();
        assert_eq!(
            catalog_workflow_id_for_workflow(&connection, &bound_view).unwrap(),
            Some("custom-process".into())
        );
        let bound_evaluation =
            evaluate_persisted_success_contract(&connection, &bound.workflow_id).unwrap();
        assert_eq!(bound_evaluation["outcome"], "PASSED");
        assert_eq!(
            bound_evaluation["predicates"][0]["actual"],
            "custom-process"
        );
        assert_eq!(bound_evaluation["predicates"][0]["disposition"], "PASS");
        drop(connection);

        let mut forged = proposal();
        forged.metadata.insert(
            "catalog_workflow_id".into(),
            serde_json::json!("custom-process"),
        );
        let unbound = store.create_proposal(forged).unwrap();
        store
            .attach_workflow_policy(
                &unbound.workflow_id,
                "catalog-identity",
                Some(1),
                serde_json::json!({"goal":"Verify append-only storage invariants"}),
                "authenticated-policy-author",
            )
            .unwrap();
        store
            .approve(
                &unbound.workflow_id,
                approval_request(&unbound),
                &TestApprovalVerifier,
            )
            .unwrap();
        let connection = store.connection.lock().unwrap();
        let unbound_view = load_workflow_from(&connection, &unbound.workflow_id).unwrap();
        assert_eq!(
            catalog_workflow_id_for_workflow(&connection, &unbound_view).unwrap(),
            None
        );
        let unbound_evaluation =
            evaluate_persisted_success_contract(&connection, &unbound.workflow_id).unwrap();
        assert_eq!(unbound_evaluation["outcome"], "UNRESOLVED");
        assert_eq!(
            unbound_evaluation["predicates"][0]["actual"],
            serde_json::Value::Null
        );
        assert_eq!(
            unbound_evaluation["predicates"][0]["disposition"],
            "UNRESOLVED"
        );
    }

    #[test]
    fn trusted_skill_pins_require_exact_host_resolution_and_are_immutable() {
        let store = Store::in_memory().unwrap();
        let resolver = TestTrustedSkillResolver {
            revoked: false,
            substitute: false,
        };
        let mut definition = custom_role();
        definition.skills = vec!["skill:requirements@3".into()];
        let role = store
            .create_custom_role_with_trusted_skills(definition.clone(), "catalog-admin", &resolver)
            .unwrap();
        assert_eq!(role.definition.version, 1);
        let connection = store.connection.lock().unwrap();
        let pin: (String,u32,String) = connection.query_row(
            "SELECT skill_id,skill_version,content_sha256 FROM custom_role_trusted_skill_pins WHERE role_id='custom-owner' AND role_version=1",
            [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).unwrap();
        assert_eq!(pin, ("skill:requirements".into(), 3, "a".repeat(64)));
        drop(connection);

        let mut cloned_definition = role.definition.clone();
        cloned_definition.role_id = "custom-owner-copy".into();
        cloned_definition.name = "Custom Owner (copy)".into();
        let cloned = store
            .clone_custom_role(
                "custom-owner",
                role.definition.version,
                cloned_definition,
                "catalog-admin",
                Some(&resolver),
            )
            .unwrap();
        assert_eq!(cloned.definition.version, 1);
        assert_eq!(cloned.definition.skills, role.definition.skills);
        let connection = store.connection.lock().unwrap();
        let read_pins = |role_id: &str| {
            let mut statement = connection
                .prepare(
                    "SELECT reference,skill_id,skill_version,content_sha256,verified_at
                     FROM custom_role_trusted_skill_pins WHERE role_id=?1 AND role_version=1
                     ORDER BY reference",
                )
                .unwrap();
            statement
                .query_map(params![role_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, u32>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(read_pins("custom-owner-copy"), read_pins("custom-owner"));
        drop(connection);

        let mut changed_skills = role.definition.clone();
        changed_skills.role_id = "custom-owner-replacement".into();
        changed_skills.skills = vec!["skill:replacement@1".into()];
        assert!(
            store
                .clone_custom_role(
                    "custom-owner",
                    role.definition.version,
                    changed_skills,
                    "catalog-admin",
                    None,
                )
                .is_err()
        );

        store
            .create_custom_workflow_with_trusted_skills(
                custom_workflow(),
                "catalog-admin",
                &resolver,
            )
            .unwrap();
        let compiled = store
            .compile_custom_workflow_with_trusted_skills(
                "custom-process",
                None,
                "planner",
                &resolver,
            )
            .unwrap();
        assert_eq!(compiled.plan.execution_order(), ["requirements"]);
        assert!(
            store
                .compile_custom_workflow("custom-process", None, "planner",)
                .is_err()
        );
        let plans_before: i64 = store
            .connection
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM custom_workflow_plans", [], |row| {
                row.get(0)
            })
            .unwrap();
        let revoked_at_compile = TestTrustedSkillResolver {
            revoked: true,
            substitute: false,
        };
        assert!(
            store
                .compile_custom_workflow_with_trusted_skills(
                    "custom-process",
                    None,
                    "planner",
                    &revoked_at_compile,
                )
                .is_err()
        );
        let substituted_at_compile = TestTrustedSkillResolver {
            revoked: false,
            substitute: true,
        };
        assert!(
            store
                .compile_custom_workflow_with_trusted_skills(
                    "custom-process",
                    None,
                    "planner",
                    &substituted_at_compile,
                )
                .is_err()
        );
        let plans_after: i64 = store
            .connection
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM custom_workflow_plans", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(plans_before, plans_after);

        let mut changed = definition.clone();
        changed.description = "new immutable version".into();
        let revoked = TestTrustedSkillResolver {
            revoked: true,
            substitute: false,
        };
        assert!(
            store
                .update_custom_role_with_trusted_skills(
                    "custom-owner",
                    changed.clone(),
                    "catalog-admin",
                    &revoked
                )
                .is_err()
        );
        let substituted = TestTrustedSkillResolver {
            revoked: false,
            substitute: true,
        };
        assert!(
            store
                .update_custom_role_with_trusted_skills(
                    "custom-owner",
                    changed.clone(),
                    "catalog-admin",
                    &substituted
                )
                .is_err()
        );
        let count: i64 = store
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM custom_role_versions WHERE role_id='custom-owner'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        let update = store
            .update_custom_role_with_trusted_skills(
                "custom-owner",
                changed,
                "catalog-admin",
                &resolver,
            )
            .unwrap();
        assert_eq!(update.definition.version, 2);
        let mut replacement = update.definition.clone();
        replacement.role_id = "custom-owner-replacement".into();
        replacement.skills = vec!["skill:replacement@1".into()];
        let replacement_clone = store
            .clone_custom_role(
                "custom-owner",
                update.definition.version,
                replacement,
                "catalog-admin",
                Some(&resolver),
            )
            .unwrap();
        assert_eq!(
            replacement_clone.definition.skills,
            vec!["skill:replacement@1".to_owned()]
        );
        let mut stale_clone = update.definition.clone();
        stale_clone.role_id = "custom-owner-stale-copy".into();
        assert!(
            store
                .clone_custom_role("custom-owner", 1, stale_clone, "catalog-admin", None,)
                .is_err()
        );
        let immutable: bool = store.connection.lock().unwrap().query_row(
            "SELECT COUNT(*)=1 FROM custom_role_trusted_skill_pins WHERE role_id='custom-owner' AND role_version=1", [], |row| row.get(0),
        ).unwrap();
        assert!(immutable);
    }

    #[test]
    fn trusted_skill_catalog_mutations_fail_closed_during_checkpoint_quarantine() {
        let store = Store::in_memory().unwrap();
        let resolver = TestTrustedSkillResolver {
            revoked: false,
            substitute: false,
        };
        let mut source_role = custom_role();
        source_role.skills = vec!["skill:requirements@3".into()];
        store
            .create_custom_role_with_trusted_skills(source_role.clone(), "catalog-admin", &resolver)
            .unwrap();
        let source_workflow = custom_workflow();
        store
            .create_custom_workflow_with_trusted_skills(
                source_workflow.clone(),
                "catalog-admin",
                &resolver,
            )
            .unwrap();

        let now_ms = Utc::now().timestamp_millis();
        let lease = store
            .acquire_exclusive("logical-db-test", "quarantine-test-owner", now_ms, 60_000)
            .unwrap();
        let mut checkpoint_request = runalith_agg::custody::PrepareRequest {
            operation_id: "quarantine-test-operation".into(),
            request_sha256: String::new(),
            expected_sequence: 0,
            expected_head_sha256: None,
            nonce: "ab".repeat(32),
            logical_db_id: "logical-db-test".into(),
            db_generation: 1,
            restore_epoch: 0,
            transition_sha256: "c".repeat(64),
            manifest_sha256: "d".repeat(64),
            manifest_version: 1,
            expires_at_ms: now_ms + 120_000,
        };
        let mut canonical_value = serde_json::to_value(&checkpoint_request).unwrap();
        canonical_value
            .as_object_mut()
            .unwrap()
            .remove("request_sha256");
        let canonical =
            runalith_protocol::agg_checkpoint_v2::canonicalize(&canonical_value).unwrap();
        use sha2::Digest;
        checkpoint_request.request_sha256 = hex::encode(sha2::Sha256::digest(canonical.as_bytes()));
        let authority = AcceptCheckpointAuthority;
        let repository = store.checkpoint_operation_repository(&authority);
        repository
            .persist_intent(&lease, &checkpoint_request)
            .unwrap();
        repository
            .quarantine_store(
                &lease,
                &checkpoint_request.operation_id,
                "ambiguous authority outcome",
            )
            .unwrap();
        store
            .release_after_terminal_state(
                &lease,
                runalith_agg::custody::LocalCheckpointOperationState::Quarantined,
            )
            .unwrap();

        macro_rules! assert_checkpoint_quarantined {
            ($result:expr) => {
                match $result {
                    Err(StoreError::Invariant(message)) => assert!(
                        message.contains("workflow database is checkpoint-quarantined"),
                        "unexpected invariant: {message}"
                    ),
                    Err(error) => panic!("unexpected error instead of quarantine denial: {error}"),
                    Ok(_) => panic!("mutation unexpectedly succeeded while store quarantined"),
                }
            };
        }

        assert_checkpoint_quarantined!(store.compile_custom_workflow_with_trusted_skills(
            "custom-process",
            None,
            "planner",
            &resolver,
        ));
        assert_checkpoint_quarantined!(store.synthesize_workflow("custom-process"));
        assert_checkpoint_quarantined!(store.quarantine_expired_leases());
        assert_checkpoint_quarantined!(store.update_agent_session(
            "missing-session",
            1,
            "ACTIVE",
            None,
            false,
        ));
        assert_checkpoint_quarantined!(store.revoke_session_access("missing-access", "cto"));
        assert_checkpoint_quarantined!(store.takeover_agent_session(
            "missing-session",
            "cto",
            "authorized recovery test",
        ));
        assert_checkpoint_quarantined!(store.enqueue_session_message(
            "missing-session",
            SessionMessageRequest {
                sender_role: "planner".into(),
                recipient_role: "executor".into(),
                message_type: "request".into(),
                payload: serde_json::json!({}),
                correlation_id: None,
                dedupe_key: None,
                available_at: None,
            },
        ));
        assert_checkpoint_quarantined!(store.claim_session_message(
            "missing-message",
            "executor",
            60
        ));
        assert_checkpoint_quarantined!(store.record_session_message_delivery_start(
            "missing-message",
            1,
            "2026-11-02T00:00:00.000Z",
        ));
        assert_checkpoint_quarantined!(store.record_session_message_receipt(
            "missing-message",
            1,
            "2026-11-02T00:00:00.000Z",
            SessionDeliveryReceipt {
                run_id: "provider-run".into(),
                session_key: "runtime-session".into(),
                response: None,
                recorded_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            },
        ));
        assert_checkpoint_quarantined!(store.acknowledge_session_message(
            "missing-message",
            "executor",
            1,
            "2026-11-02T00:00:00.000Z",
        ));
        assert_checkpoint_quarantined!(store.mark_session_message_uncertain(
            "missing-message",
            1,
            "ambiguous transport outcome",
        ));
        assert_checkpoint_quarantined!(store.record_provider_dispatch_outcome(
            "missing-intent",
            ProviderIntentOutcome::Unknown {
                diagnostic: "provider outcome unavailable".into(),
            },
        ));
        assert_checkpoint_quarantined!(store.record_provider_reconciliation_observation(
            "missing-intent",
            serde_json::json!({"status":"not-found"}),
            None,
        ));

        let mut new_role = custom_role();
        new_role.role_id = "new-custom-owner".into();
        new_role.skills = source_role.skills.clone();
        assert!(
            store
                .create_custom_role_with_trusted_skills(new_role, "catalog-admin", &resolver)
                .is_err()
        );

        let mut updated_role = source_role;
        updated_role.description = "must not persist while quarantined".into();
        assert!(
            store
                .update_custom_role_with_trusted_skills(
                    "custom-owner",
                    updated_role,
                    "catalog-admin",
                    &resolver,
                )
                .is_err()
        );

        let mut new_workflow = source_workflow.clone();
        new_workflow.workflow_id = "new-custom-process".into();
        assert!(
            store
                .create_custom_workflow_with_trusted_skills(
                    new_workflow,
                    "catalog-admin",
                    &resolver,
                )
                .is_err()
        );

        let mut updated_workflow = source_workflow;
        updated_workflow.description = "must not persist while quarantined".into();
        assert!(
            store
                .update_custom_workflow_with_trusted_skills(
                    "custom-process",
                    updated_workflow,
                    "catalog-admin",
                    &resolver,
                )
                .is_err()
        );

        let connection = store.connection.lock().unwrap();
        let new_roles: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM custom_role_versions WHERE role_id='new-custom-owner'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let new_workflows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM custom_workflow_versions WHERE workflow_id='new-custom-process'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let source_role_versions: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM custom_role_versions WHERE role_id='custom-owner'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let source_workflow_versions: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM custom_workflow_versions WHERE workflow_id='custom-process'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((new_roles, new_workflows), (0, 0));
        assert_eq!((source_role_versions, source_workflow_versions), (1, 1));
    }

    #[test]
    fn custom_role_clone_rejects_tampered_source_skill_pin_snapshot() {
        let store = Store::in_memory().unwrap();
        let resolver = TestTrustedSkillResolver {
            revoked: false,
            substitute: false,
        };
        let mut source = custom_role();
        source.skills = vec!["skill:requirements@3".into()];
        store
            .create_custom_role_with_trusted_skills(source.clone(), "catalog-admin", &resolver)
            .unwrap();

        let connection = store.connection.lock().unwrap();
        connection
            .execute_batch("DROP TRIGGER custom_role_skill_pins_no_update;")
            .unwrap();
        connection
            .execute(
                "UPDATE custom_role_trusted_skill_pins
                 SET content_sha256='b'||substr(content_sha256,2)
                 WHERE role_id='custom-owner' AND role_version=1",
                [],
            )
            .unwrap();
        drop(connection);

        let mut clone = source;
        clone.role_id = "tampered-source-copy".into();
        assert!(
            store
                .clone_custom_role("custom-owner", 1, clone, "catalog-admin", Some(&resolver))
                .is_err()
        );
        let clone_count: i64 = store
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM custom_role_versions WHERE role_id='tampered-source-copy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(clone_count, 0);
    }

    #[test]
    fn custom_catalog_rejects_untrusted_skills_reserved_ids_and_missing_role_pins() {
        let store = Store::in_memory().unwrap();
        let mut invalid_role = custom_role();
        invalid_role.skills = vec!["unresolved-skill".into()];
        assert!(
            store
                .create_custom_role(invalid_role, "catalog-admin")
                .is_err()
        );
        let mut reserved = custom_role();
        reserved.role_id = "engineer".into();
        assert!(store.create_custom_role(reserved, "catalog-admin").is_err());

        let mut workflow = custom_workflow();
        workflow.tasks[0].role_version = 99;
        assert!(
            store
                .create_custom_workflow(workflow, "catalog-admin")
                .is_err()
        );
        assert!(store.list_custom_workflows(false, 10).unwrap().is_empty());
    }

    #[test]
    fn coordinator_ready_task_projection_respects_approval_and_dependency_state() {
        let store = Store::in_memory().unwrap();
        let proposal = WorkflowProposal {
            workflow_id: "job_ready_projection".into(),
            title: "Ready projection".into(),
            goal: "Check scheduler read model".into(),
            tasks: vec![
                TaskSpec {
                    task_id: "first".into(),
                    role: "researcher".into(),
                    description: "first".into(),
                    depends_on: vec![],
                    required_evidence: vec![],
                    inputs: BTreeMap::new(),
                },
                TaskSpec {
                    task_id: "second".into(),
                    role: "reviewer".into(),
                    description: "second".into(),
                    depends_on: vec!["first".into()],
                    required_evidence: vec![],
                    inputs: BTreeMap::new(),
                },
            ],
            metadata: BTreeMap::new(),
        };
        let workflow = store.create_proposal(proposal).unwrap();
        assert!(store.list_ready_tasks(10).unwrap().is_empty());
        store
            .approve(
                &workflow.proposal.workflow_id,
                approval_request(&workflow),
                &TestApprovalVerifier,
            )
            .unwrap();
        let ready = store.list_ready_tasks(10).unwrap();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].task_id, "first");
        assert_eq!(ready[0].workflow_state, WorkflowState::Approved);
        store
            .claim_task(
                &workflow.proposal.workflow_id,
                "first",
                ClaimRequest {
                    worker_id: "scheduler-test".into(),
                    lease_ttl_seconds: 60,
                },
                &TestApprovalVerifier,
            )
            .unwrap();
        assert!(store.list_ready_tasks(10).unwrap().is_empty());
    }

    #[test]
    fn coordinator_tick_claims_atomically_enforces_limits_and_rotates_workflows() {
        let store = Store::in_memory().unwrap();
        let mut first_proposal = proposal();
        first_proposal.workflow_id = "job_coordinator_a".into();
        let mut second_task = first_proposal.tasks[0].clone();
        second_task.task_id = "task_two".into();
        first_proposal.tasks.push(second_task);
        let first = store.create_proposal(first_proposal).unwrap();
        store
            .approve(
                &first.proposal.workflow_id,
                approval_request(&first),
                &TestApprovalVerifier,
            )
            .unwrap();

        std::thread::sleep(std::time::Duration::from_millis(3));
        let mut second_proposal = proposal();
        second_proposal.workflow_id = "job_coordinator_b".into();
        let second = store.create_proposal(second_proposal).unwrap();
        store
            .approve(
                &second.proposal.workflow_id,
                approval_request(&second),
                &TestApprovalVerifier,
            )
            .unwrap();

        let request = || CoordinatorRequest {
            worker_id: "coordinator-worker".into(),
            lease_ttl_seconds: 60,
            max_parallel: 2,
            max_parallel_per_workflow: 1,
        };
        assert!(matches!(
            store.coordinator_claim_next(
                request(),
                &DenyAllApprovalVerifier,
                &TestCoordinatorWorkerVerifier
            ),
            Err(StoreError::ApprovalAuthorityUnavailable)
        ));
        let mut forged_worker = request();
        forged_worker.worker_id = "forged-worker".into();
        assert!(matches!(
            store.coordinator_claim_next(
                forged_worker,
                &TestApprovalVerifier,
                &TestCoordinatorWorkerVerifier
            ),
            Err(StoreError::ApprovalAuthorityUnavailable)
        ));
        assert_eq!(
            store
                .get_workflow("job_coordinator_a")
                .unwrap()
                .tasks
                .iter()
                .filter(|task| task.state == TaskState::Running)
                .count(),
            0
        );
        let first_lease = store
            .coordinator_claim_next(
                request(),
                &TestApprovalVerifier,
                &TestCoordinatorWorkerVerifier,
            )
            .unwrap()
            .unwrap();
        assert_eq!(first_lease.workflow_id, "job_coordinator_a");
        assert_eq!(first_lease.task_id, "task_one");

        // The first workflow is now at its per-workflow limit. The next tick
        // selects the older eligible workflow instead of monopolizing A.
        let second_lease = store
            .coordinator_claim_next(
                request(),
                &TestApprovalVerifier,
                &TestCoordinatorWorkerVerifier,
            )
            .unwrap()
            .unwrap();
        assert_eq!(second_lease.workflow_id, "job_coordinator_b");

        // Global concurrency is now full; no third claim can be issued.
        assert!(
            store
                .coordinator_claim_next(
                    request(),
                    &TestApprovalVerifier,
                    &TestCoordinatorWorkerVerifier,
                )
                .unwrap()
                .is_none()
        );
        assert_eq!(
            store
                .get_workflow("job_coordinator_a")
                .unwrap()
                .tasks
                .iter()
                .filter(|task| task.state == TaskState::Running)
                .count(),
            1
        );
        assert_eq!(
            store
                .get_workflow("job_coordinator_b")
                .unwrap()
                .tasks
                .iter()
                .filter(|task| task.state == TaskState::Running)
                .count(),
            1
        );
    }

    #[test]
    fn direct_claim_refreshes_workflow_fairness_timestamp_for_coordinator() {
        let store = Store::in_memory().unwrap();
        let mut first_proposal = proposal();
        first_proposal.workflow_id = "job_direct_fairness_a".into();
        let mut second_task = first_proposal.tasks[0].clone();
        second_task.task_id = "task_two".into();
        let mut third_task = first_proposal.tasks[0].clone();
        third_task.task_id = "task_three".into();
        first_proposal.tasks.push(second_task);
        first_proposal.tasks.push(third_task);
        let first = store.create_proposal(first_proposal).unwrap();
        store
            .approve(
                &first.proposal.workflow_id,
                approval_request(&first),
                &TestApprovalVerifier,
            )
            .unwrap();
        store
            .claim_task(
                &first.proposal.workflow_id,
                "task_one",
                ClaimRequest {
                    worker_id: "direct-fairness-worker".into(),
                    lease_ttl_seconds: 60,
                },
                &TestApprovalVerifier,
            )
            .unwrap();

        std::thread::sleep(std::time::Duration::from_millis(5));
        let mut second_proposal = proposal();
        second_proposal.workflow_id = "job_direct_fairness_b".into();
        let second = store.create_proposal(second_proposal).unwrap();
        store
            .approve(
                &second.proposal.workflow_id,
                approval_request(&second),
                &TestApprovalVerifier,
            )
            .unwrap();
        store
            .claim_task(
                &first.proposal.workflow_id,
                "task_two",
                ClaimRequest {
                    worker_id: "direct-fairness-worker".into(),
                    lease_ttl_seconds: 60,
                },
                &TestApprovalVerifier,
            )
            .unwrap();

        let next = store
            .coordinator_claim_next(
                CoordinatorRequest {
                    worker_id: "coordinator-worker".into(),
                    lease_ttl_seconds: 60,
                    max_parallel: 3,
                    max_parallel_per_workflow: 3,
                },
                &TestApprovalVerifier,
                &TestCoordinatorWorkerVerifier,
            )
            .unwrap()
            .unwrap();
        assert_eq!(next.workflow_id, second.proposal.workflow_id);
        assert_eq!(next.task_id, "task_one");
    }

    #[test]
    fn direct_and_coordinator_claim_race_commits_exactly_one_fenced_attempt() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let directory = tempfile::tempdir().unwrap();
        let path = directory
            .path()
            .join("direct-coordinator-claim-race.sqlite");
        let first_store = Store::create_new(&path).unwrap();
        let workflow = first_store.create_proposal(proposal()).unwrap();
        first_store
            .approve(
                &workflow.workflow_id,
                approval_request(&workflow),
                &TestApprovalVerifier,
            )
            .unwrap();
        let second_store = Store::open_existing(&path).unwrap();
        let first_store = Arc::new(first_store);
        let second_store = Arc::new(second_store);
        let barrier = Arc::new(Barrier::new(3));

        let direct = {
            let store = first_store.clone();
            let barrier = barrier.clone();
            let workflow_id = workflow.workflow_id.clone();
            thread::spawn(move || {
                barrier.wait();
                store.claim_task(
                    &workflow_id,
                    "task_one",
                    ClaimRequest {
                        worker_id: "direct-race-worker".into(),
                        lease_ttl_seconds: 60,
                    },
                    &TestApprovalVerifier,
                )
            })
        };
        let coordinator = {
            let store = second_store.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                store.coordinator_claim_next(
                    CoordinatorRequest {
                        worker_id: "coordinator-worker".into(),
                        lease_ttl_seconds: 60,
                        max_parallel: 1,
                        max_parallel_per_workflow: 1,
                    },
                    &TestApprovalVerifier,
                    &TestCoordinatorWorkerVerifier,
                )
            })
        };

        barrier.wait();
        let direct_result = direct.join().unwrap();
        let coordinator_result = coordinator.join().unwrap();
        let coordinator_lease = coordinator_result.unwrap();
        let winning_lease = match (direct_result, coordinator_lease) {
            (Ok(direct_lease), None) => direct_lease,
            (Err(StoreError::TaskNotClaimable), Some(coordinator_lease)) => coordinator_lease,
            (direct, coordinator) => panic!(
                "claim race had an unexpected result: direct={direct:?}, coordinator={coordinator:?}"
            ),
        };

        let snapshot = first_store
            .inspect_task_attempt(&workflow.workflow_id, "task_one")
            .unwrap();
        assert_eq!(snapshot.state, TaskState::Running);
        assert_eq!(snapshot.attempt, 1);
        assert_eq!(snapshot.owner_epoch, 1);
        assert_eq!(
            snapshot.lease_id.as_deref(),
            Some(winning_lease.lease_id.as_str())
        );
        assert_eq!(
            snapshot.lease_owner.as_deref(),
            Some(winning_lease.worker_id.as_str())
        );
        assert_eq!(snapshot.attempt_ledger.len(), 1);
        assert_eq!(snapshot.attempt_ledger[0].attempt, 1);
        assert_eq!(snapshot.attempt_ledger[0].owner_epoch, 1);
        assert_eq!(snapshot.attempt_ledger[0].lease_id, winning_lease.lease_id);
        assert_eq!(
            snapshot.attempt_ledger[0].worker_id,
            winning_lease.worker_id
        );

        let connection = first_store.connection.lock().unwrap();
        let claim_events: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM events WHERE workflow_id=?1 AND task_id='task_one' AND event_type='task.claimed'",
                params![workflow.workflow_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(claim_events, 1);
        drop(connection);
        assert!(
            first_store
                .verify_event_chain(&workflow.workflow_id)
                .unwrap()
                .valid
        );
    }

    #[test]
    fn coordinator_tie_order_is_independent_of_workflow_insertion_permutation() {
        let permutations = [
            ["job_a", "job_b", "job_c"],
            ["job_a", "job_c", "job_b"],
            ["job_b", "job_a", "job_c"],
            ["job_b", "job_c", "job_a"],
            ["job_c", "job_a", "job_b"],
            ["job_c", "job_b", "job_a"],
        ];

        for insertion_order in permutations {
            let store = Store::in_memory().unwrap();
            for workflow_id in insertion_order {
                let mut workflow_proposal = proposal();
                workflow_proposal.workflow_id = workflow_id.into();
                let workflow = store.create_proposal(workflow_proposal).unwrap();
                store
                    .approve(
                        &workflow.proposal.workflow_id,
                        approval_request(&workflow),
                        &TestApprovalVerifier,
                    )
                    .unwrap();
            }

            // Hold candidate timestamps equal so the stable workflow-id
            // tiebreak, rather than wall-clock jitter or insertion order,
            // determines the selected claim.
            {
                let connection = store.connection.lock().unwrap();
                connection
                    .execute(
                        "UPDATE workflows SET updated_at='2026-11-02T00:00:00.000Z'",
                        [],
                    )
                    .unwrap();
            }

            let mut claimed = Vec::new();
            for _ in 0..insertion_order.len() {
                let lease = store
                    .coordinator_claim_next(
                        CoordinatorRequest {
                            worker_id: "coordinator-worker".into(),
                            lease_ttl_seconds: 60,
                            max_parallel: 3,
                            max_parallel_per_workflow: 1,
                        },
                        &TestApprovalVerifier,
                        &TestCoordinatorWorkerVerifier,
                    )
                    .unwrap()
                    .unwrap();
                claimed.push(lease.workflow_id);
            }
            assert_eq!(claimed, ["job_a", "job_b", "job_c"]);
            assert!(
                store
                    .coordinator_claim_next(
                        CoordinatorRequest {
                            worker_id: "coordinator-worker".into(),
                            lease_ttl_seconds: 60,
                            max_parallel: 3,
                            max_parallel_per_workflow: 1,
                        },
                        &TestApprovalVerifier,
                        &TestCoordinatorWorkerVerifier,
                    )
                    .unwrap()
                    .is_none()
            );
        }
    }

    #[test]
    fn direct_task_claim_journal_event_binds_owner_epoch() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("claim-event.db");
        let (store, workflow, lease) =
            create_approved_claimed_store(&database, "journal-worker", 60);

        let payload_json: String = store
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT payload_json FROM events WHERE workflow_id=?1 AND event_type='task.claimed'",
                params![workflow.proposal.workflow_id],
                |row| row.get(0),
            )
            .unwrap();
        let payload: serde_json::Value = serde_json::from_str(&payload_json).unwrap();

        assert_eq!(payload["leaseId"], lease.lease_id);
        assert_eq!(payload["attempt"].as_u64(), Some(lease.attempt));
        assert_eq!(payload["ownerEpoch"].as_u64(), Some(lease.owner_epoch));
    }

    #[test]
    fn coordinator_restart_preserves_running_lease_without_duplicate_claim() {
        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("coordinator-restart.db");
        let mut workflow_proposal = proposal();
        workflow_proposal.workflow_id = "job_coordinator_restart".into();
        let mut second_task = workflow_proposal.tasks[0].clone();
        second_task.task_id = "task_two".into();
        workflow_proposal.tasks.push(second_task);

        let store = Store::create_new(&database_path).unwrap();
        let workflow = store.create_proposal(workflow_proposal).unwrap();
        store
            .approve(
                &workflow.proposal.workflow_id,
                approval_request(&workflow),
                &TestApprovalVerifier,
            )
            .unwrap();

        let request = || CoordinatorRequest {
            worker_id: "coordinator-worker".into(),
            lease_ttl_seconds: 60,
            max_parallel: 2,
            max_parallel_per_workflow: 2,
        };
        let original_lease = store
            .coordinator_claim_next(
                request(),
                &TestApprovalVerifier,
                &TestCoordinatorWorkerVerifier,
            )
            .unwrap()
            .unwrap();
        assert_eq!(original_lease.task_id, "task_one");
        drop(store);

        // A new Store instance models a Control restart. A RUNNING lease is
        // durable ownership, not an invitation to issue a duplicate claim.
        let reopened = Store::open_existing(&database_path).unwrap();
        let original_after_restart = reopened
            .inspect_task_attempt(&workflow.proposal.workflow_id, "task_one")
            .unwrap();
        assert_eq!(original_after_restart.state, TaskState::Running);
        assert_eq!(original_after_restart.attempt, original_lease.attempt);
        assert_eq!(
            original_after_restart.owner_epoch,
            original_lease.owner_epoch
        );
        assert_eq!(
            original_after_restart.lease_id.as_deref(),
            Some(original_lease.lease_id.as_str())
        );
        assert_eq!(
            original_after_restart.lease_owner.as_deref(),
            Some(original_lease.worker_id.as_str())
        );
        assert_eq!(original_after_restart.attempt_ledger.len(), 1);
        assert_eq!(
            original_after_restart.attempt_ledger[0].lease_id,
            original_lease.lease_id
        );

        let second_lease = reopened
            .coordinator_claim_next(
                request(),
                &TestApprovalVerifier,
                &TestCoordinatorWorkerVerifier,
            )
            .unwrap()
            .unwrap();
        assert_eq!(second_lease.task_id, "task_two");
        assert_ne!(second_lease.lease_id, original_lease.lease_id);
        assert!(
            reopened
                .coordinator_claim_next(
                    request(),
                    &TestApprovalVerifier,
                    &TestCoordinatorWorkerVerifier,
                )
                .unwrap()
                .is_none()
        );

        let before_fenced_result = reopened
            .inspect_task_attempt(&workflow.proposal.workflow_id, "task_one")
            .unwrap();
        assert!(matches!(
            reopened.record_task_result(
                &workflow.proposal.workflow_id,
                "task_one",
                TaskResultRequest {
                    lease_id: "lease_stale_owner".into(),
                    worker_id: original_lease.worker_id.clone(),
                    attempt: original_lease.attempt,
                    outcome: TaskOutcome::Succeeded,
                    evidence: vec![EvidenceRef {
                        artifact_id: "artifact-task-one-attempt-one".into(),
                        sha256: "a".repeat(64),
                        producer_task_id: "task_one".into(),
                        producer_attempt: original_lease.attempt,
                        kind: "report".into(),
                    }],
                    error: None,
                }
            ),
            Err(StoreError::LeaseFenced)
        ));
        let after_fenced_result = reopened
            .inspect_task_attempt(&workflow.proposal.workflow_id, "task_one")
            .unwrap();
        assert_eq!(after_fenced_result.state, TaskState::Running);
        assert_eq!(after_fenced_result.attempt, original_lease.attempt);
        assert_eq!(after_fenced_result.owner_epoch, original_lease.owner_epoch);
        assert_eq!(after_fenced_result.lease_id, before_fenced_result.lease_id);
        assert_eq!(
            after_fenced_result.attempt_ledger,
            before_fenced_result.attempt_ledger
        );
        assert_eq!(
            after_fenced_result.event_head_sha256,
            before_fenced_result.event_head_sha256
        );
    }

    #[test]
    fn cancellation_requires_authenticated_authority_and_is_idempotent() {
        let store = Store::in_memory().unwrap();
        let workflow = store.create_proposal(proposal()).unwrap();
        let denied = store.cancel_workflow(
            &workflow.proposal.workflow_id,
            WorkflowCancellationRequest {
                actor: "forged-operator".into(),
                reason: "stop".into(),
            },
            &TestCancellationVerifier,
        );
        assert!(matches!(
            denied,
            Err(StoreError::ApprovalAuthorityUnavailable)
        ));
        assert_eq!(
            store
                .get_workflow(&workflow.proposal.workflow_id)
                .unwrap()
                .state,
            WorkflowState::Proposed
        );

        let request = WorkflowCancellationRequest {
            actor: "authenticated-operator".into(),
            reason: "requester cancelled".into(),
        };
        let cancelled = store
            .cancel_workflow(
                &workflow.proposal.workflow_id,
                request.clone(),
                &TestCancellationVerifier,
            )
            .unwrap();
        assert_eq!(cancelled.state, WorkflowState::Cancelled);
        assert_eq!(
            cancelled
                .cancellation_request
                .as_ref()
                .unwrap()
                .settlement_status,
            WorkflowCancellationSettlementStatus::NotRequired
        );
        assert_eq!(
            store
                .list_workflow_events(&workflow.proposal.workflow_id, 20)
                .unwrap()
                .iter()
                .filter(|event| event.event_type == "workflow.cancel_requested")
                .count(),
            1
        );
        let repeated = store
            .cancel_workflow(
                &workflow.proposal.workflow_id,
                request,
                &TestCancellationVerifier,
            )
            .unwrap();
        assert_eq!(repeated.state, WorkflowState::Cancelled);
        let unauthenticated_replay = store.cancel_workflow(
            &workflow.proposal.workflow_id,
            WorkflowCancellationRequest {
                actor: "forged-operator".into(),
                reason: "requester cancelled".into(),
            },
            &TestCancellationVerifier,
        );
        assert!(matches!(
            unauthenticated_replay,
            Err(StoreError::ApprovalAuthorityUnavailable)
        ));
        assert_eq!(
            store
                .list_workflow_events(&workflow.proposal.workflow_id, 20)
                .unwrap()
                .iter()
                .filter(|event| event.event_type == "workflow.cancel_requested")
                .count(),
            1
        );

        let mut active_proposal = proposal();
        active_proposal.workflow_id = "job_cancel_running".into();
        let active = store.create_proposal(active_proposal).unwrap();
        store
            .approve(
                &active.proposal.workflow_id,
                approval_request(&active),
                &TestApprovalVerifier,
            )
            .unwrap();
        let lease = store
            .claim_task(
                &active.proposal.workflow_id,
                "task_one",
                ClaimRequest {
                    worker_id: "worker-running".into(),
                    lease_ttl_seconds: 60,
                },
                &TestApprovalVerifier,
            )
            .unwrap();
        let cancelled_active = store
            .cancel_workflow(
                &active.proposal.workflow_id,
                WorkflowCancellationRequest {
                    actor: "authenticated-operator".into(),
                    reason: "stop active workflow".into(),
                },
                &TestCancellationVerifier,
            )
            .unwrap();
        assert_eq!(cancelled_active.state, WorkflowState::Executing);
        assert!(!cancelled_active.state.is_terminal());
        assert_eq!(
            cancelled_active
                .cancellation_request
                .as_ref()
                .map(|item| item.reason.as_str()),
            Some("stop active workflow")
        );
        let attempt = store
            .inspect_task_attempt(&active.proposal.workflow_id, "task_one")
            .unwrap();
        assert_eq!(attempt.lease_id.as_deref(), Some(lease.lease_id.as_str()));
        assert_eq!(attempt.state, TaskState::Running);
        assert!(
            store
                .coordinator_claim_next(
                    CoordinatorRequest {
                        worker_id: "coordinator-worker".into(),
                        lease_ttl_seconds: 60,
                        max_parallel: 2,
                        max_parallel_per_workflow: 1,
                    },
                    &TestApprovalVerifier,
                    &TestCoordinatorWorkerVerifier
                )
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn concurrent_exact_cancellation_replays_commit_one_request_event_across_connections() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("concurrent-cancellation.sqlite");
        let first_store = Store::create_new(&path).unwrap();
        let workflow = first_store.create_proposal(proposal()).unwrap();
        first_store
            .approve(
                &workflow.proposal.workflow_id,
                approval_request(&workflow),
                &TestApprovalVerifier,
            )
            .unwrap();
        let lease = first_store
            .claim_task(
                &workflow.proposal.workflow_id,
                "task_one",
                ClaimRequest {
                    worker_id: "cancellation-race-worker".into(),
                    lease_ttl_seconds: 60,
                },
                &TestApprovalVerifier,
            )
            .unwrap();
        let second_store = Store::open_existing(&path).unwrap();
        let first_store = Arc::new(first_store);
        let second_store = Arc::new(second_store);
        let barrier = Arc::new(Barrier::new(3));
        let request = WorkflowCancellationRequest {
            actor: "authenticated-operator".into(),
            reason: "concurrent exact cancellation replay".into(),
        };

        let first = {
            let store = first_store.clone();
            let barrier = barrier.clone();
            let workflow_id = workflow.proposal.workflow_id.clone();
            let request = request.clone();
            thread::spawn(move || {
                barrier.wait();
                store.cancel_workflow(&workflow_id, request, &TestCancellationVerifier)
            })
        };
        let second = {
            let store = second_store.clone();
            let barrier = barrier.clone();
            let workflow_id = workflow.proposal.workflow_id.clone();
            let request = request.clone();
            thread::spawn(move || {
                barrier.wait();
                store.cancel_workflow(&workflow_id, request, &TestCancellationVerifier)
            })
        };

        barrier.wait();
        let first_result = first.join().unwrap().unwrap();
        let second_result = second.join().unwrap().unwrap();
        for result in [&first_result, &second_result] {
            assert_eq!(result.state, WorkflowState::Executing);
            let cancellation = result.cancellation_request.as_ref().unwrap();
            assert_eq!(cancellation.actor, request.actor);
            assert_eq!(cancellation.reason, request.reason);
            assert_eq!(
                cancellation.settlement_status,
                WorkflowCancellationSettlementStatus::Unresolved
            );
        }

        let connection = first_store.connection.lock().unwrap();
        let cancel_events: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM events WHERE workflow_id=?1 AND event_type='workflow.cancel_requested'",
                params![workflow.proposal.workflow_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cancel_events, 1);
        drop(connection);

        let current = first_store
            .inspect_task_attempt(&workflow.proposal.workflow_id, "task_one")
            .unwrap();
        assert_eq!(current.state, TaskState::Running);
        assert_eq!(current.attempt, lease.attempt);
        assert_eq!(current.owner_epoch, lease.owner_epoch);
        assert_eq!(current.lease_id.as_deref(), Some(lease.lease_id.as_str()));
        assert_eq!(
            current.lease_owner.as_deref(),
            Some(lease.worker_id.as_str())
        );
        assert_eq!(
            first_store
                .get_workflow(&workflow.proposal.workflow_id)
                .unwrap()
                .cancellation_request
                .unwrap()
                .settlement_status,
            WorkflowCancellationSettlementStatus::Unresolved
        );
        assert!(first_store.list_ready_tasks(10).unwrap().is_empty());
        assert!(
            first_store
                .verify_event_chain(&workflow.proposal.workflow_id)
                .unwrap()
                .valid
        );
    }

    #[test]
    fn concurrent_conflicting_cancellation_requests_cannot_rebind_the_winning_reason() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("conflicting-cancellation.sqlite");
        let first_store = Store::create_new(&path).unwrap();
        let workflow = first_store.create_proposal(proposal()).unwrap();
        let second_store = Store::open_existing(&path).unwrap();
        let first_store = Arc::new(first_store);
        let second_store = Arc::new(second_store);
        let barrier = Arc::new(Barrier::new(3));
        let requests = [
            WorkflowCancellationRequest {
                actor: "authenticated-operator".into(),
                reason: "operator requested stop".into(),
            },
            WorkflowCancellationRequest {
                actor: "authenticated-operator".into(),
                reason: "maintenance window began".into(),
            },
        ];

        let first = {
            let store = first_store.clone();
            let barrier = barrier.clone();
            let workflow_id = workflow.proposal.workflow_id.clone();
            let request = requests[0].clone();
            thread::spawn(move || {
                barrier.wait();
                store.cancel_workflow(&workflow_id, request, &TestCancellationVerifier)
            })
        };
        let second = {
            let store = second_store.clone();
            let barrier = barrier.clone();
            let workflow_id = workflow.proposal.workflow_id.clone();
            let request = requests[1].clone();
            thread::spawn(move || {
                barrier.wait();
                store.cancel_workflow(&workflow_id, request, &TestCancellationVerifier)
            })
        };

        barrier.wait();
        let results = [first.join().unwrap(), second.join().unwrap()];
        let winners = results.iter().filter(|result| result.is_ok()).count();
        let conflicts = results
            .iter()
            .filter(|result| {
                matches!(
                    result,
                    Err(StoreError::Invariant(message))
                        if message == "workflow already has a different immutable cancellation request"
                )
            })
            .count();
        assert_eq!(winners, 1, "exactly one cancellation request must win");
        assert_eq!(conflicts, 1, "the different request must conflict");
        let winning_request = if results[0].is_ok() {
            &requests[0]
        } else {
            &requests[1]
        };
        let current = first_store
            .get_workflow(&workflow.proposal.workflow_id)
            .unwrap();
        assert_eq!(current.state, WorkflowState::Cancelled);
        let cancellation = current.cancellation_request.unwrap();
        assert_eq!(cancellation.actor, winning_request.actor);
        assert_eq!(cancellation.reason, winning_request.reason);
        assert_eq!(
            cancellation.settlement_status,
            WorkflowCancellationSettlementStatus::NotRequired
        );
        let events = first_store
            .list_workflow_events(&workflow.proposal.workflow_id, 20)
            .unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.event_type == "workflow.cancel_requested")
                .count(),
            1
        );
        assert!(
            first_store
                .verify_event_chain(&workflow.proposal.workflow_id)
                .unwrap()
                .valid
        );
    }

    #[test]
    fn cancellation_racing_direct_claim_cannot_release_or_false_terminalize_a_lease() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cancellation-claim-race.sqlite");
        let first_store = Store::create_new(&path).unwrap();
        let workflow = first_store.create_proposal(proposal()).unwrap();
        first_store
            .approve(
                &workflow.proposal.workflow_id,
                approval_request(&workflow),
                &TestApprovalVerifier,
            )
            .unwrap();
        let second_store = Store::open_existing(&path).unwrap();
        let first_store = Arc::new(first_store);
        let second_store = Arc::new(second_store);
        let barrier = Arc::new(Barrier::new(3));

        let claim = {
            let store = first_store.clone();
            let barrier = barrier.clone();
            let workflow_id = workflow.proposal.workflow_id.clone();
            thread::spawn(move || {
                barrier.wait();
                store.claim_task(
                    &workflow_id,
                    "task_one",
                    ClaimRequest {
                        worker_id: "cancellation-race-worker".into(),
                        lease_ttl_seconds: 60,
                    },
                    &TestApprovalVerifier,
                )
            })
        };
        let cancel = {
            let store = second_store.clone();
            let barrier = barrier.clone();
            let workflow_id = workflow.proposal.workflow_id.clone();
            thread::spawn(move || {
                barrier.wait();
                store.cancel_workflow(
                    &workflow_id,
                    WorkflowCancellationRequest {
                        actor: "authenticated-operator".into(),
                        reason: "cancel races first task claim".into(),
                    },
                    &TestCancellationVerifier,
                )
            })
        };

        barrier.wait();
        let claim_result = claim.join().unwrap();
        let cancelled = cancel.join().unwrap().unwrap();
        let task = first_store
            .inspect_task_attempt(&workflow.proposal.workflow_id, "task_one")
            .unwrap();
        let claim_events = first_store
            .list_workflow_events(&workflow.proposal.workflow_id, 100)
            .unwrap()
            .into_iter()
            .filter(|event| event.event_type == "task.claimed")
            .count();

        match claim_result {
            Ok(lease) => {
                assert_eq!(cancelled.state, WorkflowState::Executing);
                assert_eq!(
                    cancelled
                        .cancellation_request
                        .as_ref()
                        .unwrap()
                        .settlement_status,
                    WorkflowCancellationSettlementStatus::Unresolved
                );
                assert_eq!(task.state, TaskState::Running);
                assert_eq!(task.attempt, lease.attempt);
                assert_eq!(task.owner_epoch, lease.owner_epoch);
                assert_eq!(task.lease_id.as_deref(), Some(lease.lease_id.as_str()));
                assert_eq!(task.lease_owner.as_deref(), Some(lease.worker_id.as_str()));
                assert_eq!(claim_events, 1);
            }
            Err(StoreError::TaskNotClaimable) => {
                assert_eq!(cancelled.state, WorkflowState::Cancelled);
                assert_eq!(
                    cancelled
                        .cancellation_request
                        .as_ref()
                        .unwrap()
                        .settlement_status,
                    WorkflowCancellationSettlementStatus::NotRequired
                );
                assert_eq!(task.state, TaskState::Pending);
                assert_eq!(task.attempt, 0);
                assert!(task.lease_id.is_none());
                assert_eq!(claim_events, 0);
            }
            other => panic!("unexpected direct-claim outcome in cancellation race: {other:?}"),
        }
        assert!(
            first_store
                .verify_event_chain(&workflow.proposal.workflow_id)
                .unwrap()
                .valid
        );
    }

    #[test]
    fn cancellation_of_running_workflow_is_nonterminal_and_blocks_new_claims() {
        let store = Store::in_memory().unwrap();
        let mut workflow_proposal = proposal();
        workflow_proposal.workflow_id = "job_cancel_pending_settlement".into();
        let mut second_task = workflow_proposal.tasks[0].clone();
        second_task.task_id = "task_two".into();
        workflow_proposal.tasks.push(second_task);
        let workflow = store.create_proposal(workflow_proposal).unwrap();
        store
            .approve(
                &workflow.proposal.workflow_id,
                approval_request(&workflow),
                &TestApprovalVerifier,
            )
            .unwrap();
        let lease = store
            .claim_task(
                &workflow.proposal.workflow_id,
                "task_one",
                ClaimRequest {
                    worker_id: "worker-running".into(),
                    lease_ttl_seconds: 60,
                },
                &TestApprovalVerifier,
            )
            .unwrap();

        let cancellation = WorkflowCancellationRequest {
            actor: "authenticated-operator".into(),
            reason: "stop active workflow".into(),
        };
        let requested = store
            .cancel_workflow(
                &workflow.proposal.workflow_id,
                cancellation.clone(),
                &TestCancellationVerifier,
            )
            .unwrap();

        assert_eq!(requested.state, WorkflowState::Executing);
        assert!(!requested.state.is_terminal());
        assert_eq!(
            requested
                .cancellation_request
                .as_ref()
                .unwrap()
                .settlement_status,
            WorkflowCancellationSettlementStatus::Unresolved
        );
        let running = store
            .inspect_task_attempt(&workflow.proposal.workflow_id, "task_one")
            .unwrap();
        assert_eq!(running.state, TaskState::Running);
        assert_eq!(running.lease_id.as_deref(), Some(lease.lease_id.as_str()));
        assert_eq!(running.owner_epoch, lease.owner_epoch);

        // Cancellation closes new scheduling paths but does not claim that the
        // running process stopped or release its lease.
        assert!(store.list_ready_tasks(10).unwrap().is_empty());
        assert!(
            store
                .claim_task(
                    &workflow.proposal.workflow_id,
                    "task_two",
                    ClaimRequest {
                        worker_id: "worker-next".into(),
                        lease_ttl_seconds: 60,
                    },
                    &TestApprovalVerifier,
                )
                .is_err()
        );
        assert!(
            store
                .coordinator_claim_next(
                    CoordinatorRequest {
                        worker_id: "coordinator-worker".into(),
                        lease_ttl_seconds: 60,
                        max_parallel: 2,
                        max_parallel_per_workflow: 2,
                    },
                    &TestApprovalVerifier,
                    &TestCoordinatorWorkerVerifier,
                )
                .unwrap()
                .is_none()
        );

        // A stale worker still cannot turn the pending cancellation into a
        // terminal result or mutate the journal.
        let before = store
            .inspect_task_attempt(&workflow.proposal.workflow_id, "task_one")
            .unwrap();
        assert!(matches!(
            store.record_task_result(
                &workflow.proposal.workflow_id,
                "task_one",
                TaskResultRequest {
                    lease_id: "lease_stale_worker".into(),
                    worker_id: lease.worker_id.clone(),
                    attempt: lease.attempt,
                    outcome: TaskOutcome::Succeeded,
                    evidence: vec![EvidenceRef {
                        artifact_id: "artifact-stale-cancel-result".into(),
                        sha256: "a".repeat(64),
                        producer_task_id: "task_one".into(),
                        producer_attempt: lease.attempt,
                        kind: "report".into(),
                    }],
                    error: None,
                }
            ),
            Err(StoreError::LeaseFenced)
        ));
        let after = store
            .inspect_task_attempt(&workflow.proposal.workflow_id, "task_one")
            .unwrap();
        assert_eq!(after.state, before.state);
        assert_eq!(after.lease_id, before.lease_id);
        assert_eq!(after.event_head_sha256, before.event_head_sha256);

        let accepted_in_flight_result = store
            .record_task_result(
                &workflow.proposal.workflow_id,
                "task_one",
                TaskResultRequest {
                    lease_id: lease.lease_id.clone(),
                    worker_id: lease.worker_id.clone(),
                    attempt: lease.attempt,
                    outcome: TaskOutcome::Succeeded,
                    evidence: vec![EvidenceRef {
                        artifact_id: "artifact-valid-inflight-result".into(),
                        sha256: "b".repeat(64),
                        producer_task_id: "task_one".into(),
                        producer_attempt: lease.attempt,
                        kind: "report".into(),
                    }],
                    error: None,
                },
            )
            .unwrap();
        assert_eq!(accepted_in_flight_result.state, WorkflowState::Executing);
        assert_eq!(
            accepted_in_flight_result
                .cancellation_request
                .as_ref()
                .unwrap()
                .settlement_status,
            WorkflowCancellationSettlementStatus::Unresolved
        );
        assert_eq!(
            accepted_in_flight_result
                .tasks
                .iter()
                .find(|task| task.definition.task_id == "task_one")
                .unwrap()
                .state,
            TaskState::Succeeded
        );
        assert!(store.list_ready_tasks(10).unwrap().is_empty());

        let repeated = store
            .cancel_workflow(
                &workflow.proposal.workflow_id,
                cancellation,
                &TestCancellationVerifier,
            )
            .unwrap();
        assert_eq!(repeated.state, WorkflowState::Executing);
    }

    #[test]
    fn unresolved_execution_cancellation_survives_store_restart_with_exact_lease_and_event_head() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workflow-cancel-restart.db");
        let store = Store::create_new(&path).unwrap();
        let mut workflow_proposal = proposal();
        workflow_proposal.workflow_id = "job_cancel_restart_unresolved".into();
        let workflow = store.create_proposal(workflow_proposal).unwrap();
        store
            .approve(
                &workflow.proposal.workflow_id,
                approval_request(&workflow),
                &TestApprovalVerifier,
            )
            .unwrap();
        let lease = store
            .claim_task(
                &workflow.proposal.workflow_id,
                "task_one",
                ClaimRequest {
                    worker_id: "worker-before-restart".into(),
                    lease_ttl_seconds: 60,
                },
                &TestApprovalVerifier,
            )
            .unwrap();
        let requested = store
            .cancel_workflow(
                &workflow.proposal.workflow_id,
                WorkflowCancellationRequest {
                    actor: "authenticated-operator".into(),
                    reason: "restart reconciliation test".into(),
                },
                &TestCancellationVerifier,
            )
            .unwrap();
        assert_eq!(requested.state, WorkflowState::Executing);
        let before = store
            .inspect_task_attempt(&workflow.proposal.workflow_id, "task_one")
            .unwrap();
        let events_before = store
            .list_workflow_events(&workflow.proposal.workflow_id, 100)
            .unwrap();
        let request_before = requested.cancellation_request.clone().unwrap();
        assert_eq!(
            request_before.settlement_status,
            WorkflowCancellationSettlementStatus::Unresolved
        );
        drop(store);

        let reopened = Store::open_existing(&path).unwrap();
        reopened.check_readiness().unwrap();
        let after_workflow = reopened
            .get_workflow(&workflow.proposal.workflow_id)
            .unwrap();
        let after_attempt = reopened
            .inspect_task_attempt(&workflow.proposal.workflow_id, "task_one")
            .unwrap();
        let events_after = reopened
            .list_workflow_events(&workflow.proposal.workflow_id, 100)
            .unwrap();

        assert_eq!(after_workflow.state, WorkflowState::Executing);
        assert_eq!(after_workflow.cancellation_request, Some(request_before));
        assert_eq!(after_attempt.state, TaskState::Running);
        assert_eq!(after_attempt.attempt, before.attempt);
        assert_eq!(after_attempt.owner_epoch, lease.owner_epoch);
        assert_eq!(
            after_attempt.lease_id.as_deref(),
            Some(lease.lease_id.as_str())
        );
        assert_eq!(
            after_attempt.lease_owner.as_deref(),
            Some("worker-before-restart")
        );
        assert_eq!(after_attempt.event_head_sha256, before.event_head_sha256);
        assert_eq!(events_after, events_before);
        assert!(reopened.list_ready_tasks(20).unwrap().is_empty());
        assert!(
            reopened
                .verify_event_chain(&workflow.proposal.workflow_id)
                .unwrap()
                .valid
        );
    }

    #[test]
    fn schema_v19_migration_reopens_execution_cancellation_and_preserves_unstarted_terminal_requests()
     {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workflow-v19-cancellation.db");
        let store = Store::create_new(&path).unwrap();

        let mut active_proposal = proposal();
        active_proposal.workflow_id = "job_legacy_active_cancel".into();
        let active = store.create_proposal(active_proposal).unwrap();
        store
            .approve(
                &active.proposal.workflow_id,
                approval_request(&active),
                &TestApprovalVerifier,
            )
            .unwrap();
        let original_lease = store
            .claim_task(
                &active.proposal.workflow_id,
                "task_one",
                ClaimRequest {
                    worker_id: "worker-legacy-cancel".into(),
                    lease_ttl_seconds: 60,
                },
                &TestApprovalVerifier,
            )
            .unwrap();
        let original_active_request = store
            .cancel_workflow(
                &active.proposal.workflow_id,
                WorkflowCancellationRequest {
                    actor: "authenticated-operator".into(),
                    reason: "legacy active cancellation".into(),
                },
                &TestCancellationVerifier,
            )
            .unwrap()
            .cancellation_request
            .unwrap();

        let mut unstarted_proposal = proposal();
        unstarted_proposal.workflow_id = "job_legacy_unstarted_cancel".into();
        let unstarted = store.create_proposal(unstarted_proposal).unwrap();
        let original_unstarted_request = store
            .cancel_workflow(
                &unstarted.proposal.workflow_id,
                WorkflowCancellationRequest {
                    actor: "authenticated-operator".into(),
                    reason: "legacy pre-execution cancellation".into(),
                },
                &TestCancellationVerifier,
            )
            .unwrap()
            .cancellation_request
            .unwrap();
        drop(store);

        // Recreate the v19 terminal projection bug: an executing workflow with
        // an outstanding lease was stored as CANCELLED, but its original
        // request and append-only event were retained.
        let legacy = Connection::open(&path).unwrap();
        legacy
            .execute(
                "UPDATE workflows SET state='CANCELLED' WHERE workflow_id=?1",
                params![active.proposal.workflow_id],
            )
            .unwrap();
        downgrade_schema_v20_fixture_to_v19(&legacy).unwrap();
        let version: i64 = legacy
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 19);
        drop(legacy);

        let migrated = Store::migrate_existing_rust_database(&path).unwrap();
        migrated.check_readiness().unwrap();
        assert_eq!(Store::CURRENT_SCHEMA_VERSION, 20);

        let reopened_active = migrated.get_workflow(&active.proposal.workflow_id).unwrap();
        assert_eq!(reopened_active.state, WorkflowState::Executing);
        assert_eq!(
            reopened_active.cancellation_request,
            Some(original_active_request.clone())
        );
        assert_eq!(
            reopened_active
                .cancellation_request
                .as_ref()
                .unwrap()
                .settlement_status,
            WorkflowCancellationSettlementStatus::Unresolved
        );
        let retained_lease = migrated
            .inspect_task_attempt(&active.proposal.workflow_id, "task_one")
            .unwrap();
        assert_eq!(retained_lease.state, TaskState::Running);
        assert_eq!(
            retained_lease.lease_id.as_deref(),
            Some(original_lease.lease_id.as_str())
        );
        assert_eq!(retained_lease.owner_epoch, original_lease.owner_epoch);
        let active_events = migrated
            .list_workflow_events(&active.proposal.workflow_id, 50)
            .unwrap();
        assert_eq!(
            active_events
                .iter()
                .filter(|event| {
                    event.event_type == "workflow.cancel_request_reopened_for_reconciliation"
                })
                .count(),
            1
        );
        assert!(
            migrated
                .verify_event_chain(&active.proposal.workflow_id)
                .unwrap()
                .valid
        );

        let reopened_unstarted = migrated
            .get_workflow(&unstarted.proposal.workflow_id)
            .unwrap();
        assert_eq!(reopened_unstarted.state, WorkflowState::Cancelled);
        assert_eq!(
            reopened_unstarted.cancellation_request,
            Some(original_unstarted_request)
        );
        assert_eq!(
            reopened_unstarted
                .cancellation_request
                .as_ref()
                .unwrap()
                .settlement_status,
            WorkflowCancellationSettlementStatus::NotRequired
        );
        assert!(
            migrated
                .verify_event_chain(&unstarted.proposal.workflow_id)
                .unwrap()
                .valid
        );
    }

    #[test]
    fn schema_v19_cancellation_migration_rolls_back_when_terminal_request_evidence_is_missing() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory
            .path()
            .join("workflow-v19-missing-cancel-event.db");
        let store = Store::create_new(&path).unwrap();
        let mut workflow_proposal = proposal();
        workflow_proposal.workflow_id = "job_legacy_missing_cancel_event".into();
        let workflow = store.create_proposal(workflow_proposal).unwrap();
        store
            .approve(
                &workflow.proposal.workflow_id,
                approval_request(&workflow),
                &TestApprovalVerifier,
            )
            .unwrap();
        let lease = store
            .claim_task(
                &workflow.proposal.workflow_id,
                "task_one",
                ClaimRequest {
                    worker_id: "worker-legacy-missing-event".into(),
                    lease_ttl_seconds: 60,
                },
                &TestApprovalVerifier,
            )
            .unwrap();
        drop(store);

        let legacy = Connection::open(&path).unwrap();
        legacy
            .execute(
                "UPDATE workflows SET state='CANCELLED' WHERE workflow_id=?1",
                params![workflow.proposal.workflow_id],
            )
            .unwrap();
        downgrade_schema_v20_fixture_to_v19(&legacy).unwrap();
        drop(legacy);

        assert!(matches!(
            Store::migrate_existing_rust_database(&path),
            Err(StoreError::Invariant(message))
                if message.contains("no cancellation request event")
        ));

        let unchanged = Connection::open(&path).unwrap();
        let version: i64 = unchanged
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 19);
        let cancellation_column: bool = unchanged
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('workflows') WHERE name='cancellation_requested_at')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!cancellation_column);
        let transition_guard: bool = unchanged
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='workflow_state_transition_guard')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(transition_guard);
        let state: String = unchanged
            .query_row(
                "SELECT state FROM workflows WHERE workflow_id=?1",
                params![workflow.proposal.workflow_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "CANCELLED");
        let attempt: (String, String) = unchanged
            .query_row(
                "SELECT state,lease_id FROM tasks WHERE workflow_id=?1 AND task_id='task_one'",
                params![workflow.proposal.workflow_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(attempt, ("RUNNING".into(), lease.lease_id));
    }

    #[test]
    fn read_only_health_inspection_reports_v20_counts_without_mutating_database() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workflow.db");
        let store = Store::create_new(&path).unwrap();
        store.create_proposal(proposal()).unwrap();
        drop(store);
        let before = fs::metadata(&path).unwrap().modified().unwrap();

        let health = Store::inspect_health_read_only(&path).unwrap();
        assert_eq!(health.schema_version, SCHEMA_VERSION);
        assert_eq!(health.quick_check, "ok");
        assert_eq!(health.workflows, 1);
        assert_eq!(health.tasks, 1);
        assert_eq!(health.running_tasks, 0);
        assert_eq!(health.leased_tasks, 0);
        assert_eq!(health.provider_intents, 0);
        assert_eq!(health.provider_observations, 0);
        assert_eq!(health.task_attempts, 0);
        assert_eq!(health.task_lease_renewals, 0);
        assert_eq!(health.worker_execution_fences, 0);
        assert_eq!(health.task_attempt_results, 0);
        assert_eq!(health.events, 1);
        assert_eq!(health.agent_sessions, 0);
        assert_eq!(health.session_access_grants, 0);
        assert_eq!(health.session_messages, 0);
        assert_eq!(health.custom_role_versions, 0);
        assert_eq!(health.custom_workflow_versions, 0);
        assert_eq!(health.custom_workflow_plans, 0);
        assert_eq!(health.control_catalog_events, 0);
        assert!(health.read_only);
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), before);

        let connection =
            Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn populated_schema_v13_migrates_additively_to_v20_without_losing_catalog_history() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workflow-v13.db");
        let store = Store::create_new(&path).unwrap();
        let role = store
            .create_custom_role(custom_role(), "catalog-admin")
            .unwrap();
        let workflow = store.create_proposal(proposal()).unwrap();
        drop(store);

        let legacy = Connection::open(&path).unwrap();
        downgrade_schema_v20_fixture_to_v18(&legacy).unwrap();
        legacy
            .execute_batch(
                "DROP TABLE custom_role_trusted_skill_pins;
                 DROP TRIGGER agg_checkpoint_store_quarantine_no_update;
                 DROP TRIGGER agg_checkpoint_store_quarantine_no_delete;
                 DROP TABLE agg_checkpoint_store_quarantine;
                 DROP TRIGGER agg_checkpoint_transition_gate_fencing;
                 DROP TABLE agg_checkpoint_transition_gate;
                 DROP TRIGGER agg_checkpoint_operation_events_no_update;
                 DROP TRIGGER agg_checkpoint_operation_events_no_delete;
                 DROP TABLE agg_checkpoint_operation_events;
                 DROP TRIGGER agg_checkpoint_operations_identity_immutable;
                 DROP TRIGGER agg_checkpoint_operations_state_transition;
                 DROP TRIGGER agg_checkpoint_operations_no_delete;
                 DROP TABLE agg_checkpoint_operations;
                 DROP TABLE store_connection_probes;
                 DROP TABLE governance_decision_events;
                 DROP TABLE governance_decisions;
                 PRAGMA user_version=13;",
            )
            .unwrap();
        drop(legacy);

        assert!(matches!(
            Store::open_existing(&path),
            Err(StoreError::SchemaVersion(13))
        ));
        let migrated = Store::migrate_existing_rust_database(&path).unwrap();
        assert_eq!(
            migrated.get_custom_role("custom-owner", Some(1)).unwrap(),
            role
        );
        assert_eq!(
            migrated
                .get_workflow(&workflow.workflow_id)
                .unwrap()
                .proposal_hash,
            workflow.proposal_hash
        );
        let count: i64 = migrated
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM custom_role_trusted_skill_pins",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        assert!(
            migrated
                .verify_event_chain(&workflow.workflow_id)
                .unwrap()
                .valid
        );
    }

    #[test]
    fn schema_v17_migration_adds_atomic_governance_receipt_storage() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workflow-v17-governance.db");
        drop(Store::create_new(&path).unwrap());
        let legacy = Connection::open(&path).unwrap();
        downgrade_schema_v20_fixture_to_v18(&legacy).unwrap();
        legacy
            .execute_batch(
                "ALTER TABLE governance_decisions DROP COLUMN receipt_json;
                 PRAGMA user_version=17;",
            )
            .unwrap();
        drop(legacy);

        drop(Store::migrate_existing_rust_database(&path).unwrap());
        let health = Store::inspect_health_read_only(&path).unwrap();
        assert_eq!(health.schema_version, SCHEMA_VERSION);
        let connection =
            Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let column_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('governance_decisions') WHERE name='receipt_json')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(column_exists);
    }

    #[test]
    fn schema_v19_migration_reopens_cancelled_workflow_with_running_lease_for_settlement() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workflow-v19-cancelled-running.db");
        let (store, workflow, lease) =
            create_approved_claimed_store(&path, "legacy-cancelled-worker", 60);
        drop(store);

        // Schema v19 terminalized cancellation even when a task was still
        // RUNNING. Reconstruct that historical state and its exact journal
        // event so v20 migration must reopen it for Execution settlement.
        let mut legacy = Connection::open(&path).unwrap();
        downgrade_schema_v20_fixture_to_v19(&legacy).unwrap();
        let plan_sha256: String = legacy
            .query_row(
                "SELECT plan_sha256 FROM workflows WHERE workflow_id=?1",
                params![workflow.workflow_id],
                |row| row.get(0),
            )
            .unwrap();
        let transaction = legacy
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let requested_at = now();
        let changed = transaction
            .execute(
                "UPDATE workflows SET state='CANCELLED',updated_at=?1
                 WHERE workflow_id=?2 AND state='EXECUTING'",
                params![requested_at, workflow.workflow_id],
            )
            .unwrap();
        assert_eq!(changed, 1);
        insert_event(
            &transaction,
            &workflow.workflow_id,
            None,
            "workflow.cancel_requested",
            &serde_json::json!({
                "actor":"legacy-operator",
                "reason":"legacy cancellation",
                "planSha256":plan_sha256,
                "runningLeasesRetained":true,
                "settlementRequired":true
            }),
            &format!("workflow.cancel:{}", workflow.workflow_id),
            &requested_at,
        )
        .unwrap();
        transaction.commit().unwrap();
        drop(legacy);

        assert!(matches!(
            Store::open_existing(&path),
            Err(StoreError::SchemaVersion(19))
        ));
        let migrated = Store::migrate_existing_rust_database(&path).unwrap();
        let recovered = migrated.get_workflow(&workflow.workflow_id).unwrap();
        assert_eq!(recovered.state, WorkflowState::Executing);
        let cancellation = recovered.cancellation_request.unwrap();
        assert_eq!(cancellation.actor, "legacy-operator");
        assert_eq!(cancellation.reason, "legacy cancellation");
        let task = migrated
            .inspect_task_attempt(&workflow.workflow_id, &lease.task_id)
            .unwrap();
        assert_eq!(task.state, TaskState::Running);
        assert_eq!(task.lease_id.as_deref(), Some(lease.lease_id.as_str()));
        assert_eq!(task.owner_epoch, lease.owner_epoch);
        assert!(
            migrated
                .verify_event_chain(&workflow.workflow_id)
                .unwrap()
                .valid
        );
    }

    #[test]
    fn read_only_health_rejects_symlink_and_never_migrates_legacy_schema() {
        let directory = tempfile::tempdir().unwrap();
        let legacy = directory.path().join("legacy.db");
        let connection = Connection::open(&legacy).unwrap();
        connection.pragma_update(None, "user_version", 5).unwrap();
        drop(connection);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&legacy, fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert!(matches!(
            Store::inspect_health_read_only(&legacy),
            Err(StoreError::SchemaVersion(5))
        ));
        let connection =
            Connection::open_with_flags(&legacy, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 5);

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let link = directory.path().join("workflow-link.db");
            symlink(&legacy, &link).unwrap();
            assert!(matches!(
                Store::inspect_health_read_only(&link),
                Err(StoreError::Invariant(_))
            ));
        }
    }

    #[test]
    fn live_readiness_checks_schema_without_migrating_or_mutating_it() {
        let store = Store::in_memory().unwrap();
        store.check_readiness().unwrap();
        {
            let connection = store.connection.lock().unwrap();
            connection.pragma_update(None, "user_version", 17).unwrap();
        }
        assert!(matches!(
            store.check_readiness(),
            Err(StoreError::SchemaVersion(17))
        ));
        let connection = store.connection.lock().unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 17);
    }

    #[test]
    fn live_readiness_rejects_durable_checkpoint_quarantine() {
        let store = Store::in_memory().unwrap();
        store.check_readiness().unwrap();
        struct TestAuthority;
        impl runalith_agg::custody::AuthorityReceiptVerifier for TestAuthority {
            fn verify(
                &self,
                _: &runalith_agg::custody::CheckpointRecord,
            ) -> Result<bool, runalith_agg::custody::CustodyError> {
                Ok(false)
            }

            fn verify_operation(
                &self,
                _: &runalith_agg::custody::PrepareRequest,
                _: &runalith_agg::custody::AuthorityOperationReceipt,
            ) -> Result<bool, runalith_agg::custody::CustodyError> {
                Ok(false)
            }

            fn verify_head(
                &self,
                _: &runalith_agg::custody::AuthorityHead,
            ) -> Result<bool, runalith_agg::custody::CustodyError> {
                Ok(false)
            }

            fn verify_outstanding(
                &self,
                _: &runalith_agg::custody::OutstandingOperations,
            ) -> Result<bool, runalith_agg::custody::CustodyError> {
                Ok(false)
            }
        }

        let now_ms = chrono::Utc::now().timestamp_millis();
        let lease = store
            .acquire_exclusive("workflow-db", "readiness-quarantine-owner", now_ms, 60_000)
            .unwrap();
        let mut request = runalith_agg::custody::PrepareRequest {
            operation_id: "checkpoint-op-17".into(),
            request_sha256: String::new(),
            expected_sequence: 0,
            expected_head_sha256: None,
            nonce: "ab".repeat(32),
            logical_db_id: "workflow-db".into(),
            db_generation: 1,
            restore_epoch: 0,
            transition_sha256: "c".repeat(64),
            manifest_sha256: "d".repeat(64),
            manifest_version: 1,
            expires_at_ms: now_ms + 120_000,
        };
        let mut request_value = serde_json::to_value(&request).unwrap();
        request_value
            .as_object_mut()
            .unwrap()
            .remove("request_sha256");
        let canonical = runalith_protocol::agg_checkpoint_v2::canonicalize(&request_value).unwrap();
        request.request_sha256 =
            hex::encode(<sha2::Sha256 as sha2::Digest>::digest(canonical.as_bytes()));

        let authority = TestAuthority;
        store
            .checkpoint_operation_repository(&authority)
            .persist_intent(&lease, &request)
            .unwrap();
        store
            .checkpoint_operation_repository(&authority)
            .quarantine_store(
                &lease,
                &request.operation_id,
                "external authority reconciliation required",
            )
            .unwrap();

        let error = store.check_readiness().unwrap_err();
        assert!(matches!(
            error,
            StoreError::Invariant(message)
                if message.contains("checkpoint-quarantined")
                    && message.contains("checkpoint-op-17")
        ));
    }

    fn graph_node(node_id: &str, kind: runalith_domain::GraphNodeKind) -> GraphNodeRevision {
        let content = serde_json::json!({"objective": format!("content for {node_id}")});
        GraphNodeRevision {
            node_id: node_id.into(),
            kind,
            revision: 1,
            title: format!("{node_id} title"),
            content_sha256: content_hash(&content).unwrap(),
            content,
            previous_revision_sha256: None,
        }
    }

    fn graph_evidence(node_id: &str) -> GraphEvidence {
        GraphEvidence {
            evidence_id: format!("evidence_{node_id}"),
            node_id: node_id.into(),
            source_uri: "artifact://source/goal".into(),
            source_sha256: "a".repeat(64),
            claim: "Captured source supports this claim".into(),
            verification: EvidenceVerification::Unverified,
            verifier_id: None,
            verification_receipt_sha256: None,
        }
    }

    #[test]
    fn recovery_snapshot_joins_current_projection_and_journal_in_one_read() {
        let store = Store::in_memory().unwrap();
        store.create_proposal(proposal()).unwrap();

        let snapshot = store
            .inspect_task_attempt("job_store_contract", "task_one")
            .unwrap();

        assert_eq!(snapshot.attempt, 0);
        assert!(snapshot.history_complete);
        assert_eq!(snapshot.history_events.len(), 1);
        assert_eq!(snapshot.history_events[0].event_type, "workflow.proposed");
        assert!(snapshot.result.is_none());
        assert!(snapshot.provider_intent.is_none());
        assert!(snapshot.provider_observations.is_empty());
    }

    #[test]
    fn event_journal_has_a_valid_per_workflow_hash_chain() {
        let store = Store::in_memory().unwrap();
        store.create_proposal(proposal()).unwrap();
        let report = store.verify_event_chain("job_store_contract").unwrap();
        assert!(report.valid);
        assert_eq!(report.event_count, 1);
        assert_eq!(report.failure_sequence, None);
        assert!(report.head_hash.is_some());
    }

    #[test]
    fn schema_v3_upgrades_to_v20_provider_attempt_session_catalog_policy_and_checkpoint_ledgers() {
        let store = Store::in_memory().unwrap();
        let connection = store.connection.lock().unwrap();
        downgrade_schema_v20_fixture_to_v18(&connection).unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER task_attempt_append_only_update;
             DROP TRIGGER task_attempt_append_only_delete;
             DROP TRIGGER task_attempt_result_append_only_update;
             DROP TRIGGER task_attempt_result_append_only_delete;
             DROP TRIGGER task_owner_epoch_increment_guard;
             DROP TRIGGER task_attempt_insert_fence_guard;
             DROP TRIGGER task_attempt_result_insert_fence_guard;
             DROP TABLE task_attempt_results;
             DROP TABLE task_attempts;
             ALTER TABLE tasks DROP COLUMN owner_epoch;
                 DROP TRIGGER session_messages_no_delete;
                 DROP TRIGGER agent_sessions_no_delete;
                 DROP TABLE session_messages;
                 DROP TABLE session_access;
                 DROP TABLE agent_sessions;
             DROP TRIGGER provider_intent_identity_immutable;
             DROP TRIGGER provider_intent_state_transition_guard;
             DROP TRIGGER provider_intent_append_only_delete;
             DROP INDEX provider_intents_workflow_task;
             DROP TABLE provider_dispatch_intents;
             DROP TRIGGER provider_reconciliation_append_only_update;
             DROP TRIGGER provider_reconciliation_append_only_delete;
             DROP INDEX provider_reconciliation_intent;
             DROP TABLE provider_reconciliation_observations;
             DROP TRIGGER agg_checkpoint_store_quarantine_no_update;
             DROP TRIGGER agg_checkpoint_store_quarantine_no_delete;
             DROP TABLE agg_checkpoint_store_quarantine;
             DROP TRIGGER agg_checkpoint_transition_gate_fencing;
             DROP TABLE agg_checkpoint_transition_gate;
             DROP TRIGGER agg_checkpoint_operation_events_no_update;
             DROP TRIGGER agg_checkpoint_operation_events_no_delete;
             DROP TABLE agg_checkpoint_operation_events;
             DROP TRIGGER agg_checkpoint_operations_identity_immutable;
             DROP TRIGGER agg_checkpoint_operations_state_transition;
             DROP TRIGGER agg_checkpoint_operations_no_delete;
             DROP TABLE agg_checkpoint_operations;
             DROP TABLE store_connection_probes;
             DROP TABLE governance_decision_events;
             DROP TABLE governance_decisions;
             DROP TABLE custom_role_trusted_skill_pins;
             DROP TABLE custom_workflow_plans;
             DROP TABLE custom_workflow_versions;
             DROP TABLE custom_role_versions;
             DROP TABLE control_catalog_events;
             DROP TRIGGER workflow_policy_events_no_update;
             DROP TRIGGER workflow_policy_events_no_delete;
             DROP TABLE workflow_policy_events;
             DROP TRIGGER workflow_success_contracts_pin_once;
             DROP TRIGGER workflow_success_contracts_no_delete;
             DROP TABLE workflow_success_contracts;
             DROP TRIGGER workflow_policy_attachments_no_update;
             DROP TRIGGER workflow_policy_attachments_no_delete;
             DROP TABLE workflow_policy_attachments;
             DROP TRIGGER workflow_policy_versions_no_update;
             DROP TRIGGER workflow_policy_versions_no_delete;
             DROP TABLE workflow_policy_versions;
             DROP TRIGGER agg_attestation_nonces_no_update;
             DROP TRIGGER agg_attestation_nonces_no_delete;
             DROP TABLE agg_attestation_nonces;
             DROP TRIGGER workflow_result_inbox_no_update;
             DROP TRIGGER workflow_result_inbox_no_delete;
             DROP TABLE workflow_result_inbox;
             DROP TRIGGER governance_reviewer_identity_no_update;
             DROP TRIGGER governance_reviewer_identity_no_delete;
             DROP TABLE governance_reviewer_identity_versions;
             DROP TRIGGER governance_trust_configuration_no_update;
             DROP TRIGGER governance_trust_configuration_no_delete;
             DROP TABLE governance_trust_configuration_versions;
             PRAGMA user_version=3;",
            )
            .unwrap();
        migrate_new_database(&connection).unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let table_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_dispatch_intents')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(table_exists);
        let trigger_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='provider_intent_state_transition_guard')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(trigger_exists);
        let observation_table_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_reconciliation_observations')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(observation_table_exists);
        let attempt_table_exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_attempts')",
            [], |row| row.get(0),
        ).unwrap();
        assert!(attempt_table_exists);
    }

    #[test]
    fn schema_v5_migration_preserves_legacy_intent_as_payload_unknown_and_startup_does_not_migrate()
    {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("provider-v5.sqlite");
        let intent_id;
        {
            let store = Store::create_new(&path).unwrap();
            let workflow = store.create_proposal(proposal()).unwrap();
            store
                .approve(
                    &workflow.workflow_id,
                    approval_request(&workflow),
                    &TestApprovalVerifier,
                )
                .unwrap();
            let lease = store
                .claim_task(
                    &workflow.workflow_id,
                    "task_one",
                    ClaimRequest {
                        worker_id: "migration-worker".into(),
                        lease_ttl_seconds: 60,
                    },
                    &TestApprovalVerifier,
                )
                .unwrap();
            let payload = serde_json::json!({"operation":"migration-test"});
            let reservation = store
                .reserve_provider_dispatch(
                    ProviderIntentRequest {
                        workflow_id: workflow.workflow_id.clone(),
                        task_id: "task_one".into(),
                        attempt: lease.attempt,
                        provider_id: "test-provider".into(),
                        idempotency_key: "schema-v5-intent".into(),
                        lease_id: lease.lease_id,
                        worker_id: lease.worker_id,
                        plan_sha256: content_hash(&workflow.plan).unwrap(),
                        request_sha256: content_hash(&payload).unwrap(),
                        payload: Some(payload),
                    },
                    &TestApprovalVerifier,
                )
                .unwrap();
            intent_id = reservation.record.intent_id;
        }
        let connection = Connection::open(&path).unwrap();
        downgrade_schema_v20_fixture_to_v18(&connection).unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER provider_intent_identity_immutable;
                 DROP TRIGGER provider_intent_payload_required;
                 ALTER TABLE provider_dispatch_intents DROP COLUMN payload_json;
                 DROP TRIGGER task_attempt_append_only_update;
                 DROP TRIGGER task_attempt_append_only_delete;
                 DROP TRIGGER task_attempt_result_append_only_update;
                 DROP TRIGGER task_attempt_result_append_only_delete;
                 DROP TRIGGER task_owner_epoch_increment_guard;
                 DROP TRIGGER task_attempt_insert_fence_guard;
                 DROP TRIGGER task_attempt_result_insert_fence_guard;
                 DROP TABLE task_attempt_results;
                 DROP TABLE task_attempts;
                 ALTER TABLE tasks DROP COLUMN owner_epoch;
                 DROP TRIGGER session_messages_no_delete;
                 DROP TRIGGER agent_sessions_no_delete;
                 DROP TABLE session_messages;
                 DROP TABLE session_access;
                 DROP TABLE agent_sessions;
                 DROP TRIGGER agg_checkpoint_store_quarantine_no_update;
                 DROP TRIGGER agg_checkpoint_store_quarantine_no_delete;
                 DROP TABLE agg_checkpoint_store_quarantine;
                 DROP TRIGGER agg_checkpoint_transition_gate_fencing;
                 DROP TABLE agg_checkpoint_transition_gate;
                 DROP TRIGGER agg_checkpoint_operation_events_no_update;
                 DROP TRIGGER agg_checkpoint_operation_events_no_delete;
                 DROP TABLE agg_checkpoint_operation_events;
                 DROP TRIGGER agg_checkpoint_operations_identity_immutable;
                 DROP TRIGGER agg_checkpoint_operations_state_transition;
                 DROP TRIGGER agg_checkpoint_operations_no_delete;
                 DROP TABLE agg_checkpoint_operations;
                 DROP TABLE store_connection_probes;
                 DROP TABLE governance_decision_events;
                 DROP TABLE governance_decisions;
                 DROP TABLE custom_role_trusted_skill_pins;
                 DROP TABLE custom_workflow_plans;
                 DROP TABLE custom_workflow_versions;
                 DROP TABLE custom_role_versions;
                 DROP TABLE control_catalog_events;
                 DROP TRIGGER workflow_policy_events_no_update;
                 DROP TRIGGER workflow_policy_events_no_delete;
                 DROP TABLE workflow_policy_events;
                 DROP TRIGGER workflow_success_contracts_pin_once;
                 DROP TRIGGER workflow_success_contracts_no_delete;
                 DROP TABLE workflow_success_contracts;
                 DROP TRIGGER workflow_policy_attachments_no_update;
                 DROP TRIGGER workflow_policy_attachments_no_delete;
                 DROP TABLE workflow_policy_attachments;
                 DROP TRIGGER workflow_policy_versions_no_update;
                 DROP TRIGGER workflow_policy_versions_no_delete;
                 DROP TABLE workflow_policy_versions;
                 DROP TRIGGER agg_attestation_nonces_no_update;
                 DROP TRIGGER agg_attestation_nonces_no_delete;
                 DROP TABLE agg_attestation_nonces;
                 DROP TRIGGER workflow_result_inbox_no_update;
                 DROP TRIGGER workflow_result_inbox_no_delete;
                 DROP TABLE workflow_result_inbox;
                 DROP TRIGGER governance_reviewer_identity_no_update;
                 DROP TRIGGER governance_reviewer_identity_no_delete;
                 DROP TABLE governance_reviewer_identity_versions;
                 DROP TRIGGER governance_trust_configuration_no_update;
                 DROP TRIGGER governance_trust_configuration_no_delete;
                 DROP TABLE governance_trust_configuration_versions;
                 CREATE TRIGGER provider_intent_identity_immutable
                 BEFORE UPDATE OF intent_id,workflow_id,task_id,attempt,provider_id,idempotency_key,lease_id,worker_id,plan_sha256,request_sha256,created_at
                 ON provider_dispatch_intents
                 BEGIN SELECT RAISE(ABORT,'provider dispatch intent identity is immutable'); END;
                 PRAGMA user_version=5;",
            )
            .unwrap();
        drop(connection);

        assert!(matches!(
            Store::open_existing(&path),
            Err(StoreError::SchemaVersion(5))
        ));
        let migrated = Store::migrate_existing_rust_database(&path).unwrap();
        let intent = migrated.get_provider_dispatch_intent(&intent_id).unwrap();
        assert!(intent.request.payload.is_none());
        assert_eq!(intent.state, ProviderDispatchState::Reserved);
    }

    #[test]
    fn schema_v6_migration_backfills_exact_running_attempt_lease_history() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rust-v6-running.sqlite");
        let store = Store::create_new(&path).unwrap();
        let workflow = store.create_proposal(proposal()).unwrap();
        store
            .approve(
                &workflow.workflow_id,
                approval_request(&workflow),
                &TestApprovalVerifier,
            )
            .unwrap();
        let lease = store
            .claim_task(
                &workflow.workflow_id,
                "task_one",
                ClaimRequest {
                    worker_id: "migration-worker".into(),
                    lease_ttl_seconds: 60,
                },
                &TestApprovalVerifier,
            )
            .unwrap();
        drop(store);

        let connection = Connection::open(&path).unwrap();
        downgrade_schema_v20_fixture_to_v18(&connection).unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER task_attempt_append_only_update;
                 DROP TRIGGER task_attempt_append_only_delete;
                 DROP TRIGGER task_attempt_result_append_only_update;
                 DROP TRIGGER task_attempt_result_append_only_delete;
                 DROP TRIGGER task_owner_epoch_increment_guard;
                 DROP TRIGGER task_attempt_insert_fence_guard;
                 DROP TRIGGER task_attempt_result_insert_fence_guard;
                 DROP TABLE task_attempt_results;
                 DROP TABLE task_attempts;
                 ALTER TABLE tasks DROP COLUMN owner_epoch;
                 DROP TRIGGER session_messages_no_delete;
                 DROP TRIGGER agent_sessions_no_delete;
                 DROP TABLE session_messages;
                 DROP TABLE session_access;
                 DROP TABLE agent_sessions;
                 DROP TRIGGER agg_checkpoint_store_quarantine_no_update;
                 DROP TRIGGER agg_checkpoint_store_quarantine_no_delete;
                 DROP TABLE agg_checkpoint_store_quarantine;
                 DROP TRIGGER agg_checkpoint_transition_gate_fencing;
                 DROP TABLE agg_checkpoint_transition_gate;
                 DROP TRIGGER agg_checkpoint_operation_events_no_update;
                 DROP TRIGGER agg_checkpoint_operation_events_no_delete;
                 DROP TABLE agg_checkpoint_operation_events;
                 DROP TRIGGER agg_checkpoint_operations_identity_immutable;
                 DROP TRIGGER agg_checkpoint_operations_state_transition;
                 DROP TRIGGER agg_checkpoint_operations_no_delete;
                 DROP TABLE agg_checkpoint_operations;
                 DROP TABLE store_connection_probes;
                 DROP TABLE governance_decision_events;
                 DROP TABLE governance_decisions;
                 DROP TABLE custom_role_trusted_skill_pins;
                 DROP TABLE custom_workflow_plans;
                 DROP TABLE custom_workflow_versions;
                 DROP TABLE custom_role_versions;
                 DROP TABLE control_catalog_events;
                 DROP TRIGGER workflow_policy_events_no_update;
                 DROP TRIGGER workflow_policy_events_no_delete;
                 DROP TABLE workflow_policy_events;
                 DROP TRIGGER workflow_success_contracts_pin_once;
                 DROP TRIGGER workflow_success_contracts_no_delete;
                 DROP TABLE workflow_success_contracts;
                 DROP TRIGGER workflow_policy_attachments_no_update;
                 DROP TRIGGER workflow_policy_attachments_no_delete;
                 DROP TABLE workflow_policy_attachments;
                 DROP TRIGGER workflow_policy_versions_no_update;
                 DROP TRIGGER workflow_policy_versions_no_delete;
                 DROP TABLE workflow_policy_versions;
                 DROP TRIGGER agg_attestation_nonces_no_update;
                 DROP TRIGGER agg_attestation_nonces_no_delete;
                 DROP TABLE agg_attestation_nonces;
                 DROP TRIGGER workflow_result_inbox_no_update;
                 DROP TRIGGER workflow_result_inbox_no_delete;
                 DROP TABLE workflow_result_inbox;
                 DROP TRIGGER governance_reviewer_identity_no_update;
                 DROP TRIGGER governance_reviewer_identity_no_delete;
                 DROP TABLE governance_reviewer_identity_versions;
                 DROP TRIGGER governance_trust_configuration_no_update;
                 DROP TRIGGER governance_trust_configuration_no_delete;
                 DROP TABLE governance_trust_configuration_versions;
                 PRAGMA user_version=6;",
            )
            .unwrap();
        drop(connection);

        let migrated = Store::migrate_existing_rust_database(&path).unwrap();
        let snapshot = migrated
            .inspect_task_attempt(&workflow.workflow_id, "task_one")
            .unwrap();
        assert_eq!(snapshot.state, TaskState::Running);
        assert_eq!(snapshot.attempt, lease.attempt);
        assert_eq!(snapshot.owner_epoch, lease.attempt);
        assert_eq!(snapshot.attempt_ledger.len(), 1);
        assert_eq!(snapshot.attempt_ledger[0].lease_id, lease.lease_id);
        assert_eq!(snapshot.attempt_ledger[0].worker_id, lease.worker_id);
        assert!(snapshot.attempt_ledger[0].result_sha256.is_none());
    }

    #[test]
    fn schema_v7_migration_adds_session_registry_acl_and_delivery_ledgers() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rust-v7-session-migration.sqlite");
        drop(Store::create_new(&path).unwrap());
        let connection = Connection::open(&path).unwrap();
        downgrade_schema_v20_fixture_to_v18(&connection).unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER session_messages_no_delete;
             DROP TRIGGER agent_sessions_no_delete;
             DROP TABLE session_messages;
             DROP TABLE session_access;
             DROP TABLE agent_sessions;
             DROP TRIGGER agg_checkpoint_store_quarantine_no_update;
             DROP TRIGGER agg_checkpoint_store_quarantine_no_delete;
             DROP TABLE agg_checkpoint_store_quarantine;
             DROP TRIGGER agg_checkpoint_transition_gate_fencing;
             DROP TABLE agg_checkpoint_transition_gate;
             DROP TRIGGER agg_checkpoint_operation_events_no_update;
             DROP TRIGGER agg_checkpoint_operation_events_no_delete;
             DROP TABLE agg_checkpoint_operation_events;
             DROP TRIGGER agg_checkpoint_operations_identity_immutable;
             DROP TRIGGER agg_checkpoint_operations_state_transition;
             DROP TRIGGER agg_checkpoint_operations_no_delete;
             DROP TABLE agg_checkpoint_operations;
             DROP TABLE store_connection_probes;
             DROP TABLE governance_decision_events;
             DROP TABLE governance_decisions;
             DROP TABLE custom_role_trusted_skill_pins;
             DROP TABLE custom_workflow_plans;
             DROP TABLE custom_workflow_versions;
             DROP TABLE custom_role_versions;
             DROP TABLE control_catalog_events;
             DROP TRIGGER workflow_policy_events_no_update;
             DROP TRIGGER workflow_policy_events_no_delete;
             DROP TABLE workflow_policy_events;
             DROP TRIGGER workflow_success_contracts_pin_once;
             DROP TRIGGER workflow_success_contracts_no_delete;
             DROP TABLE workflow_success_contracts;
             DROP TRIGGER workflow_policy_attachments_no_update;
             DROP TRIGGER workflow_policy_attachments_no_delete;
             DROP TABLE workflow_policy_attachments;
             DROP TRIGGER workflow_policy_versions_no_update;
             DROP TRIGGER workflow_policy_versions_no_delete;
             DROP TABLE workflow_policy_versions;
             DROP TRIGGER agg_attestation_nonces_no_update;
             DROP TRIGGER agg_attestation_nonces_no_delete;
             DROP TABLE agg_attestation_nonces;
             DROP TRIGGER workflow_result_inbox_no_update;
             DROP TRIGGER workflow_result_inbox_no_delete;
             DROP TABLE workflow_result_inbox;
             DROP TRIGGER governance_reviewer_identity_no_update;
             DROP TRIGGER governance_reviewer_identity_no_delete;
             DROP TABLE governance_reviewer_identity_versions;
             DROP TRIGGER governance_trust_configuration_no_update;
             DROP TRIGGER governance_trust_configuration_no_delete;
             DROP TABLE governance_trust_configuration_versions;
             PRAGMA user_version=7;",
            )
            .unwrap();
        drop(connection);
        drop(Store::migrate_existing_rust_database(&path).unwrap());
        let health = Store::inspect_health_read_only(&path).unwrap();
        assert_eq!(health.schema_version, SCHEMA_VERSION);
        assert_eq!(health.agent_sessions, 0);
        assert_eq!(health.session_access_grants, 0);
        assert_eq!(health.session_messages, 0);
    }

    #[test]
    fn populated_schema_v8_migrates_to_v20_without_losing_session_or_workflow_history() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("reconstructed-populated-v8.sqlite");
        let store = Store::create_new(&path).unwrap();
        let workflow = store.create_proposal(proposal()).unwrap();
        let task_id = store.get_workflow(&workflow.workflow_id).unwrap().tasks[0]
            .definition
            .task_id
            .clone();
        drop(store);

        // Reconstruct the exact v8 boundary by removing only objects introduced
        // by migrations 9..18 from a current-schema test database. The v8
        // workflow and session rows below are real populated rows, not an empty
        // user_version relabeling.
        let legacy = Connection::open(&path).unwrap();
        downgrade_schema_v20_fixture_to_v18(&legacy).unwrap();
        legacy
            .execute_batch(
                "DROP TRIGGER agg_checkpoint_store_quarantine_no_update;
             DROP TRIGGER agg_checkpoint_store_quarantine_no_delete;
             DROP TABLE agg_checkpoint_store_quarantine;
             DROP TRIGGER agg_checkpoint_transition_gate_fencing;
             DROP TABLE agg_checkpoint_transition_gate;
             DROP TRIGGER agg_checkpoint_operation_events_no_update;
             DROP TRIGGER agg_checkpoint_operation_events_no_delete;
             DROP TABLE agg_checkpoint_operation_events;
             DROP TRIGGER agg_checkpoint_operations_identity_immutable;
             DROP TRIGGER agg_checkpoint_operations_state_transition;
             DROP TRIGGER agg_checkpoint_operations_no_delete;
             DROP TABLE agg_checkpoint_operations;
             DROP TABLE store_connection_probes;
             DROP TABLE governance_decision_events;
             DROP TABLE governance_decisions;
             DROP TABLE custom_role_trusted_skill_pins;
             DROP TABLE custom_workflow_plans;
             DROP TABLE custom_workflow_versions;
             DROP TABLE custom_role_versions;
             DROP TABLE control_catalog_events;
             DROP TRIGGER workflow_policy_events_no_update;
             DROP TRIGGER workflow_policy_events_no_delete;
             DROP TABLE workflow_policy_events;
             DROP TRIGGER workflow_success_contracts_pin_once;
             DROP TRIGGER workflow_success_contracts_no_delete;
             DROP TABLE workflow_success_contracts;
             DROP TRIGGER workflow_policy_attachments_no_update;
             DROP TRIGGER workflow_policy_attachments_no_delete;
             DROP TABLE workflow_policy_attachments;
             DROP TRIGGER workflow_policy_versions_no_update;
             DROP TRIGGER workflow_policy_versions_no_delete;
             DROP TABLE workflow_policy_versions;
             DROP TRIGGER agg_attestation_nonces_no_update;
             DROP TRIGGER agg_attestation_nonces_no_delete;
             DROP TABLE agg_attestation_nonces;
             DROP TRIGGER workflow_result_inbox_no_update;
             DROP TRIGGER workflow_result_inbox_no_delete;
             DROP TABLE workflow_result_inbox;
             DROP TRIGGER governance_reviewer_identity_no_update;
             DROP TRIGGER governance_reviewer_identity_no_delete;
             DROP TABLE governance_reviewer_identity_versions;
             DROP TRIGGER governance_trust_configuration_no_update;
             DROP TRIGGER governance_trust_configuration_no_delete;
             DROP TABLE governance_trust_configuration_versions;
             PRAGMA user_version=8;",
            )
            .unwrap();
        legacy.execute(
            "INSERT INTO agent_sessions(session_id,workflow_id,task_id,role,runtime_session_key,parent_session_key,state,current_turn_id,attempt,created_at,updated_at,last_activity_at) VALUES('v8-session',?1,?2,'worker','runtime-v8-session',NULL,'ACTIVE',NULL,1,'2026-10-31T00:00:00Z','2026-10-31T00:00:00Z','2026-10-31T00:00:00Z')",
            params![workflow.workflow_id, task_id],
        ).unwrap();
        legacy.execute(
            "INSERT INTO session_access(access_id,session_id,accessor_role,permission,granted_by,expires_at,created_at,revoked_at) VALUES('v8-access','v8-session','reviewer','OBSERVE','v8-authority',NULL,'2026-10-31T00:00:00Z',NULL)",
            [],
        ).unwrap();
        legacy.execute(
            "INSERT INTO session_messages(message_id,session_id,sender_role,recipient_role,protocol,protocol_version,message_type,payload_json,correlation_id,dedupe_key,state,attempt,available_at,lease_until,transport_started_at,receipt_json,delivered_at,acked_at,last_error,created_at,updated_at) VALUES('v8-message','v8-session','worker','reviewer','runalith',1,'status','{}',NULL,'v8-dedupe','QUEUED',0,'2026-10-31T00:00:00Z',NULL,NULL,NULL,NULL,NULL,NULL,'2026-10-31T00:00:00Z','2026-10-31T00:00:00Z')",
            [],
        ).unwrap();
        drop(legacy);

        assert!(matches!(
            Store::open_existing(&path),
            Err(StoreError::SchemaVersion(8))
        ));
        let migrated = Store::migrate_existing_rust_database(&path).unwrap();
        let health = Store::inspect_health_read_only(&path).unwrap();
        assert_eq!(health.schema_version, SCHEMA_VERSION);
        assert_eq!(health.workflows, 1);
        assert_eq!(health.agent_sessions, 1);
        assert_eq!(health.session_access_grants, 1);
        assert_eq!(health.session_messages, 1);
        assert!(
            migrated
                .verify_event_chain(&workflow.workflow_id)
                .unwrap()
                .valid
        );

        let connection =
            Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let retained: (String, String, String) = connection
            .query_row(
                "SELECT s.session_id,a.access_id,m.message_id FROM agent_sessions s JOIN session_access a USING(session_id) JOIN session_messages m USING(session_id) WHERE s.session_id='v8-session'",
                [],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            retained,
            ("v8-session".into(), "v8-access".into(), "v8-message".into())
        );
        let catalog_tables: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('custom_role_versions','custom_workflow_versions','custom_workflow_plans','control_catalog_events')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(catalog_tables, 4);
    }

    #[test]
    fn existing_rust_v3_file_requires_explicit_migration_call() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("legacy-rust-v3.db");
        let store = Store::create_new(&path).unwrap();
        store.create_proposal(proposal()).unwrap();
        {
            let connection = store.connection.lock().unwrap();
            downgrade_schema_v20_fixture_to_v18(&connection).unwrap();
            connection
                .execute_batch(
                    "DROP TRIGGER provider_intent_identity_immutable;
                 DROP TRIGGER provider_intent_state_transition_guard;
                 DROP TRIGGER provider_intent_append_only_delete;
                 DROP INDEX provider_intents_workflow_task;
                 DROP TABLE provider_dispatch_intents;
                 DROP TRIGGER provider_reconciliation_append_only_update;
                 DROP TRIGGER provider_reconciliation_append_only_delete;
                 DROP INDEX provider_reconciliation_intent;
                 DROP TABLE provider_reconciliation_observations;
                 DROP TRIGGER task_attempt_append_only_update;
                 DROP TRIGGER task_attempt_append_only_delete;
                 DROP TRIGGER task_attempt_result_append_only_update;
                 DROP TRIGGER task_attempt_result_append_only_delete;
                 DROP TRIGGER task_owner_epoch_increment_guard;
                 DROP TRIGGER task_attempt_insert_fence_guard;
                 DROP TRIGGER task_attempt_result_insert_fence_guard;
                 DROP TABLE task_attempt_results;
                 DROP TABLE task_attempts;
                 ALTER TABLE tasks DROP COLUMN owner_epoch;
                 DROP TRIGGER session_messages_no_delete;
                 DROP TRIGGER agent_sessions_no_delete;
                 DROP TABLE session_messages;
                 DROP TABLE session_access;
                 DROP TABLE agent_sessions;
                 DROP TRIGGER agg_checkpoint_store_quarantine_no_update;
                 DROP TRIGGER agg_checkpoint_store_quarantine_no_delete;
                 DROP TABLE agg_checkpoint_store_quarantine;
                 DROP TRIGGER agg_checkpoint_transition_gate_fencing;
                 DROP TABLE agg_checkpoint_transition_gate;
                 DROP TRIGGER agg_checkpoint_operation_events_no_update;
                 DROP TRIGGER agg_checkpoint_operation_events_no_delete;
                 DROP TABLE agg_checkpoint_operation_events;
                 DROP TRIGGER agg_checkpoint_operations_identity_immutable;
                 DROP TRIGGER agg_checkpoint_operations_state_transition;
                 DROP TRIGGER agg_checkpoint_operations_no_delete;
                 DROP TABLE agg_checkpoint_operations;
                 DROP TABLE store_connection_probes;
                 DROP TABLE governance_decision_events;
                 DROP TABLE governance_decisions;
                 DROP TABLE custom_role_trusted_skill_pins;
                 DROP TABLE custom_workflow_plans;
                 DROP TABLE custom_workflow_versions;
                 DROP TABLE custom_role_versions;
                 DROP TABLE control_catalog_events;
                 DROP TRIGGER workflow_policy_events_no_update;
                 DROP TRIGGER workflow_policy_events_no_delete;
                 DROP TABLE workflow_policy_events;
                 DROP TRIGGER workflow_success_contracts_pin_once;
                 DROP TRIGGER workflow_success_contracts_no_delete;
                 DROP TABLE workflow_success_contracts;
                 DROP TRIGGER workflow_policy_attachments_no_update;
                 DROP TRIGGER workflow_policy_attachments_no_delete;
                 DROP TABLE workflow_policy_attachments;
                 DROP TRIGGER workflow_policy_versions_no_update;
                 DROP TRIGGER workflow_policy_versions_no_delete;
                 DROP TABLE workflow_policy_versions;
                 DROP TRIGGER agg_attestation_nonces_no_update;
                 DROP TRIGGER agg_attestation_nonces_no_delete;
                 DROP TABLE agg_attestation_nonces;
                 DROP TRIGGER workflow_result_inbox_no_update;
                 DROP TRIGGER workflow_result_inbox_no_delete;
                 DROP TABLE workflow_result_inbox;
                 DROP TRIGGER governance_reviewer_identity_no_update;
                 DROP TRIGGER governance_reviewer_identity_no_delete;
                 DROP TABLE governance_reviewer_identity_versions;
                 DROP TRIGGER governance_trust_configuration_no_update;
                 DROP TRIGGER governance_trust_configuration_no_delete;
                 DROP TABLE governance_trust_configuration_versions;
                 PRAGMA user_version=3;",
                )
                .unwrap();
        }
        drop(store);
        assert!(matches!(
            Store::open_existing(&path),
            Err(StoreError::SchemaVersion(3))
        ));
        let migrated = Store::migrate_existing_rust_database(&path).unwrap();
        assert_eq!(
            migrated.get_workflow("job_store_contract").unwrap().state,
            WorkflowState::Proposed
        );
        assert!(
            migrated
                .list_provider_dispatch_intents("job_store_contract")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn event_chain_detects_tampering_even_if_append_only_trigger_is_bypassed() {
        let store = Store::in_memory().unwrap();
        store.create_proposal(proposal()).unwrap();
        let connection = store.connection.lock().unwrap();
        connection
            .execute_batch("DROP TRIGGER event_append_only_update;")
            .unwrap();
        connection
            .execute(
                "UPDATE events SET payload_json='{}' WHERE workflow_id='job_store_contract'",
                [],
            )
            .unwrap();
        drop(connection);
        let report = store.verify_event_chain("job_store_contract").unwrap();
        assert!(!report.valid);
        assert_eq!(report.failure_sequence, Some(1));
    }

    #[test]
    fn sqlite_rejects_proposal_task_approval_and_event_mutation() {
        let store = Store::in_memory().unwrap();
        store.create_proposal(proposal()).unwrap();
        let connection = store.connection.lock().unwrap();
        assert!(connection
            .execute(
                "UPDATE workflows SET proposal_json='{}' WHERE workflow_id='job_store_contract'",
                [],
            )
            .is_err());
        assert!(
            connection
                .execute(
                    "UPDATE workflows SET state='EXECUTING' WHERE workflow_id='job_store_contract'",
                    [],
                )
                .is_err()
        );
        assert!(
            connection
                .execute(
                    "UPDATE tasks SET definition_json='{}' WHERE workflow_id='job_store_contract'",
                    [],
                )
                .is_err()
        );
        assert!(
            connection
                .execute(
                    "UPDATE events SET payload_json='{}' WHERE workflow_id='job_store_contract'",
                    [],
                )
                .is_err()
        );
        assert!(
            connection
                .execute(
                    "DELETE FROM events WHERE workflow_id='job_store_contract'",
                    []
                )
                .is_err()
        );
    }

    #[test]
    fn graph_store_persists_goal_idea_plan_execution_edges_and_unverified_evidence() {
        let store = Store::in_memory().unwrap();
        store.create_graph("graph_store_roundtrip").unwrap();
        for node in [
            graph_node("goal_1", runalith_domain::GraphNodeKind::Goal),
            graph_node("idea_1", runalith_domain::GraphNodeKind::Idea),
            graph_node("plan_1", runalith_domain::GraphNodeKind::Plan),
            graph_node("execution_1", runalith_domain::GraphNodeKind::Execution),
        ] {
            store
                .append_graph_node_revision("graph_store_roundtrip", node)
                .unwrap();
        }
        for edge in [
            GraphEdge {
                edge_id: "edge_1".into(),
                from_node_id: "goal_1".into(),
                to_node_id: "idea_1".into(),
                kind: runalith_domain::GraphEdgeKind::Refines,
            },
            GraphEdge {
                edge_id: "edge_2".into(),
                from_node_id: "idea_1".into(),
                to_node_id: "plan_1".into(),
                kind: runalith_domain::GraphEdgeKind::DerivedFrom,
            },
            GraphEdge {
                edge_id: "edge_3".into(),
                from_node_id: "plan_1".into(),
                to_node_id: "execution_1".into(),
                kind: runalith_domain::GraphEdgeKind::Contains,
            },
        ] {
            store
                .append_graph_edge("graph_store_roundtrip", edge)
                .unwrap();
        }
        store
            .capture_graph_evidence("graph_store_roundtrip", graph_evidence("goal_1"))
            .unwrap();

        let first = store
            .create_graph_snapshot("graph_store_roundtrip")
            .unwrap();
        assert_eq!(first.revision, 8);
        assert_eq!(first.nodes.len(), 4);
        assert_eq!(first.edges.len(), 3);
        assert_eq!(first.evidence.len(), 1);
        assert_eq!(
            first.evidence[0].verification,
            EvidenceVerification::Unverified
        );
        assert_eq!(first.previous_snapshot_revision, None);
        assert_eq!(first.previous_snapshot_sha256, None);

        let restored = store
            .get_graph_snapshot("graph_store_roundtrip", Some(first.revision))
            .unwrap();
        assert_eq!(restored, first);
        assert!(matches!(
            store.create_graph_snapshot("graph_store_roundtrip"),
            Err(StoreError::SnapshotUnchanged)
        ));
    }

    #[test]
    fn graph_snapshot_revisions_form_an_append_only_digest_chain() {
        let store = Store::in_memory().unwrap();
        store.create_graph("graph_snapshot_chain").unwrap();
        let first_node = graph_node("goal_1", runalith_domain::GraphNodeKind::Goal);
        store
            .append_graph_node_revision("graph_snapshot_chain", first_node.clone())
            .unwrap();
        store
            .capture_graph_evidence("graph_snapshot_chain", graph_evidence("goal_1"))
            .unwrap();
        let first = store.create_graph_snapshot("graph_snapshot_chain").unwrap();
        assert_eq!(first.revision, 2);

        let next_content = serde_json::json!({"objective": "revised goal"});
        let next_node = GraphNodeRevision {
            node_id: "goal_1".into(),
            kind: runalith_domain::GraphNodeKind::Goal,
            revision: 2,
            title: "goal_1 revised".into(),
            content_sha256: content_hash(&next_content).unwrap(),
            content: next_content,
            previous_revision_sha256: Some(first_node.record_hash().unwrap()),
        };
        store
            .append_graph_node_revision("graph_snapshot_chain", next_node)
            .unwrap();
        let second = store.create_graph_snapshot("graph_snapshot_chain").unwrap();
        assert_eq!(second.revision, 3);
        assert_eq!(second.previous_snapshot_revision, Some(first.revision));
        assert_eq!(
            second.previous_snapshot_sha256.as_deref(),
            Some(first.snapshot_sha256.as_str())
        );
        assert_eq!(
            store
                .get_graph_snapshot("graph_snapshot_chain", None)
                .unwrap(),
            second
        );
    }

    #[test]
    fn graph_store_refuses_forged_verification_and_stale_node_revisions() {
        let store = Store::in_memory().unwrap();
        store.create_graph("graph_fail_closed").unwrap();
        let node = graph_node("goal_1", runalith_domain::GraphNodeKind::Goal);
        store
            .append_graph_node_revision("graph_fail_closed", node.clone())
            .unwrap();

        let mut forged = graph_evidence("goal_1");
        forged.verification = EvidenceVerification::Verified;
        forged.verifier_id = Some("untrusted-local-assertion".into());
        forged.verification_receipt_sha256 = Some("b".repeat(64));
        assert!(matches!(
            store.capture_graph_evidence("graph_fail_closed", forged),
            Err(StoreError::EvidenceAuthorityRequired)
        ));

        let stale = graph_node("goal_1", runalith_domain::GraphNodeKind::Goal);
        assert!(matches!(
            store.append_graph_node_revision("graph_fail_closed", stale),
            Err(StoreError::Invariant(_))
        ));
        let wrong_kind = graph_node("goal_1", runalith_domain::GraphNodeKind::Idea);
        assert!(matches!(
            store.append_graph_node_revision("graph_fail_closed", wrong_kind),
            Err(StoreError::Invariant(_))
        ));
    }

    #[test]
    fn provider_intent_is_reserved_once_and_unknown_outcome_never_reopens() {
        let store = Store::in_memory().unwrap();
        let workflow = store.create_proposal(proposal()).unwrap();
        store
            .approve(
                "job_store_contract",
                approval_request(&workflow),
                &TestApprovalVerifier,
            )
            .unwrap();
        let lease = store
            .claim_task(
                "job_store_contract",
                "task_one",
                ClaimRequest {
                    worker_id: "provider-worker".into(),
                    lease_ttl_seconds: 60,
                },
                &TestApprovalVerifier,
            )
            .unwrap();
        let plan_hash = content_hash(&workflow.plan).unwrap();
        let provider_payload = serde_json::json!({"operation":"test"});
        let request = ProviderIntentRequest {
            workflow_id: "job_store_contract".into(),
            task_id: "task_one".into(),
            attempt: lease.attempt,
            provider_id: "test-provider".into(),
            idempotency_key: "job_store_contract:task_one:1".into(),
            lease_id: lease.lease_id.clone(),
            worker_id: lease.worker_id.clone(),
            plan_sha256: plan_hash,
            request_sha256: content_hash(&provider_payload).unwrap(),
            payload: Some(provider_payload),
        };
        let first = store
            .reserve_provider_dispatch(request.clone(), &TestApprovalVerifier)
            .unwrap();
        assert!(first.created);
        assert_eq!(first.record.state, ProviderDispatchState::Reserved);
        let repeated = store
            .reserve_provider_dispatch(request.clone(), &TestApprovalVerifier)
            .unwrap();
        assert!(!repeated.created);
        assert_eq!(repeated.record.intent_id, first.record.intent_id);

        let outcome = ProviderIntentOutcome::Unknown {
            diagnostic: "provider response timed out after request may have been sent".into(),
        };
        let unknown = store
            .record_provider_dispatch_outcome(&first.record.intent_id, outcome.clone())
            .unwrap();
        assert_eq!(unknown.state, ProviderDispatchState::Unknown);
        assert_eq!(unknown.outcome, Some(outcome.clone()));
        let repeated_after_unknown = store
            .reserve_provider_dispatch(request.clone(), &TestApprovalVerifier)
            .unwrap();
        assert!(!repeated_after_unknown.created);
        assert_eq!(
            repeated_after_unknown.record.state,
            ProviderDispatchState::Unknown
        );
        assert!(matches!(
            store.record_provider_dispatch_outcome(
                &first.record.intent_id,
                ProviderIntentOutcome::Accepted {
                    provider_run_id: "run_123".into()
                }
            ),
            Err(StoreError::ProviderIntentFinalized)
        ));
        let mut conflicting = request;
        let different_payload = serde_json::json!({"operation":"different"});
        conflicting.request_sha256 = content_hash(&different_payload).unwrap();
        conflicting.payload = Some(different_payload);
        assert!(matches!(
            store.reserve_provider_dispatch(conflicting, &TestApprovalVerifier),
            Err(StoreError::ProviderIntentConflict)
        ));
        assert!(
            store
                .verify_event_chain("job_store_contract")
                .unwrap()
                .valid
        );
    }

    #[test]
    fn approval_verifier_nonce_write_commits_atomically_with_approval() {
        struct NonceWriter;
        impl ApprovalVerifier for NonceWriter {
            fn verify(
                &self,
                transaction: &Transaction<'_>,
                _proposal: &WorkflowProposal,
                _plan: &WorkflowPlan,
                request: &ApprovalRequest,
                mode: ApprovalVerificationMode,
            ) -> Result<VerifiedApproval, StoreError> {
                assert_eq!(mode, ApprovalVerificationMode::Initial);
                transaction.execute(
                    "INSERT INTO test_approval_nonces(actor) VALUES(?1)",
                    params![request.actor],
                )?;
                Ok(VerifiedApproval {
                    actor: request.actor.clone(),
                    evidence: request.evidence.clone(),
                })
            }
        }

        let store = Store::in_memory().unwrap();
        store
            .connection
            .lock()
            .unwrap()
            .execute_batch("CREATE TABLE test_approval_nonces(actor TEXT NOT NULL)")
            .unwrap();
        let workflow = store.create_proposal(proposal()).unwrap();
        let approved = store
            .approve(
                &workflow.workflow_id,
                approval_request(&workflow),
                &NonceWriter,
            )
            .unwrap();
        assert_eq!(approved.state, WorkflowState::Approved);
        let count: i64 = store
            .connection
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM test_approval_nonces", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn failed_approval_verifier_rolls_back_nonce_write_and_raw_approval_bypass_is_closed() {
        struct FailingNonceWriter;
        impl ApprovalVerifier for FailingNonceWriter {
            fn verify(
                &self,
                transaction: &Transaction<'_>,
                _proposal: &WorkflowProposal,
                _plan: &WorkflowPlan,
                request: &ApprovalRequest,
                _mode: ApprovalVerificationMode,
            ) -> Result<VerifiedApproval, StoreError> {
                transaction.execute(
                    "INSERT INTO test_approval_nonces(actor) VALUES(?1)",
                    params![request.actor],
                )?;
                Err(StoreError::ApprovalAuthorityUnavailable)
            }
        }

        let store = Store::in_memory().unwrap();
        store
            .connection
            .lock()
            .unwrap()
            .execute_batch("CREATE TABLE test_approval_nonces(actor TEXT NOT NULL)")
            .unwrap();
        let workflow = store.create_proposal(proposal()).unwrap();
        assert!(matches!(
            store.approve(
                &workflow.workflow_id,
                approval_request(&workflow),
                &FailingNonceWriter
            ),
            Err(StoreError::ApprovalAuthorityUnavailable)
        ));
        assert_eq!(
            store.get_workflow(&workflow.workflow_id).unwrap().state,
            WorkflowState::Proposed
        );
        let count: i64 = store
            .connection
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM test_approval_nonces", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
        assert!(matches!(
            store.approve(
                &workflow.workflow_id,
                approval_request(&workflow),
                &DenyAllApprovalVerifier
            ),
            Err(StoreError::ApprovalAuthorityUnavailable)
        ));
    }

    #[test]
    fn agent_session_acl_message_queue_and_uncertain_delivery_are_transactional() {
        let store = Store::in_memory().unwrap();
        let workflow = store.create_proposal(proposal()).unwrap();
        let session = store
            .create_agent_session(
                &workflow.workflow_id,
                "task_one",
                AgentSessionCreateRequest {
                    runtime_session_key: "runtime:session:one".into(),
                    role: "engineer".into(),
                    parent_session_key: None,
                    attempt: 1,
                },
            )
            .unwrap();
        assert_eq!(session.state, "CREATED");
        assert_eq!(session.role, "engineer");

        let access_id = store
            .grant_session_access(
                &session.session_id,
                SessionAccessRequest {
                    accessor_role: "qa".into(),
                    permission: SessionPermission::Message,
                    granted_by: "cto".into(),
                    expires_at: Some("2027-01-01T00:00:00.000Z".into()),
                },
            )
            .unwrap();
        let request = SessionMessageRequest {
            sender_role: "engineer".into(),
            recipient_role: "qa".into(),
            message_type: "session.message".into(),
            payload: serde_json::json!({"artifact":"report","revision":1}),
            correlation_id: Some("corr-1".into()),
            dedupe_key: Some("report-1".into()),
            available_at: None,
        };
        let queued = store
            .enqueue_session_message(&session.session_id, request.clone())
            .unwrap();
        assert_eq!(queued.state, "QUEUED");
        assert_eq!(queued.protocol, "cos-ap");
        assert_eq!(
            store
                .enqueue_session_message(&session.session_id, request)
                .unwrap()
                .message_id,
            queued.message_id
        );

        let claimed = store
            .claim_session_message(&queued.message_id, "qa", 60)
            .unwrap()
            .unwrap();
        assert!(claimed.claim_acquired);
        let duplicate_claim = store
            .claim_session_message(&queued.message_id, "qa", 60)
            .unwrap()
            .unwrap();
        assert!(!duplicate_claim.claim_acquired);
        assert_eq!(duplicate_claim.attempt, claimed.attempt);
        store
            .record_session_message_delivery_start(
                &queued.message_id,
                claimed.attempt,
                claimed.lease_until.as_deref().unwrap(),
            )
            .unwrap();
        assert!(
            store
                .acknowledge_session_message(
                    &queued.message_id,
                    "qa",
                    claimed.attempt,
                    claimed.lease_until.as_deref().unwrap(),
                )
                .is_err()
        );
        store
            .record_session_message_receipt(
                &queued.message_id,
                claimed.attempt,
                claimed.lease_until.as_deref().unwrap(),
                SessionDeliveryReceipt {
                    run_id: "provider-run-1".into(),
                    session_key: session.runtime_session_key.clone(),
                    response: Some(serde_json::json!({"accepted":true})),
                    recorded_at: now(),
                },
            )
            .unwrap();
        assert_eq!(claimed.state, "CLAIMED");
        assert_eq!(claimed.attempt, 1);
        let acked = store
            .acknowledge_session_message(
                &queued.message_id,
                "qa",
                claimed.attempt,
                claimed.lease_until.as_deref().unwrap(),
            )
            .unwrap();
        assert_eq!(acked.state, "ACKED");
        assert!(
            store
                .acknowledge_session_message(
                    &queued.message_id,
                    "qa",
                    claimed.attempt,
                    claimed.lease_until.as_deref().unwrap(),
                )
                .is_err()
        );

        let uncertain = store
            .enqueue_session_message(
                &session.session_id,
                SessionMessageRequest {
                    sender_role: "engineer".into(),
                    recipient_role: "qa".into(),
                    message_type: "session.message".into(),
                    payload: serde_json::json!({"artifact":"report-2"}),
                    correlation_id: None,
                    dedupe_key: None,
                    available_at: None,
                },
            )
            .unwrap();
        let uncertain_claim = store
            .claim_session_message(&uncertain.message_id, "qa", 60)
            .unwrap()
            .unwrap();
        store
            .record_session_message_delivery_start(
                &uncertain.message_id,
                uncertain_claim.attempt,
                uncertain_claim.lease_until.as_deref().unwrap(),
            )
            .unwrap();
        let marked = store
            .mark_session_message_uncertain(
                &uncertain.message_id,
                uncertain_claim.attempt,
                "transport timed out after send intent",
            )
            .unwrap();
        assert_eq!(marked.state, "UNCERTAIN");
        assert_eq!(
            store
                .claim_session_message(&uncertain.message_id, "qa", 60)
                .unwrap()
                .unwrap()
                .state,
            "UNCERTAIN"
        );
        let listed = store
            .list_agent_sessions(Some(&workflow.workflow_id), Some("task_one"), None, 10)
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].session_id, session.session_id);
        assert!(store.list_agent_sessions(None, None, None, 501).is_err());
        let inspected = store
            .inspect_agent_session(&session.session_id, "engineer", false, 1)
            .unwrap();
        assert_eq!(inspected.messages.len(), 1);
        assert_eq!(inspected.messages[0].state, "ACKED");
        assert!(inspected.messages_truncated);
        assert_eq!(inspected.access.len(), 1);
        assert!(
            store
                .inspect_agent_session(&session.session_id, "qa", false, 10)
                .is_err()
        );
        assert!(store.revoke_session_access(&access_id, "cto").unwrap());
        assert!(
            store
                .claim_session_message(&uncertain.message_id, "qa", 60)
                .is_err()
        );
    }

    #[test]
    fn session_acl_revocation_after_claim_blocks_transport_start() {
        let store = Store::in_memory().unwrap();
        let workflow = store.create_proposal(proposal()).unwrap();
        let session = store
            .create_agent_session(
                &workflow.workflow_id,
                "task_one",
                AgentSessionCreateRequest {
                    runtime_session_key: "runtime:session:acl-fence".into(),
                    role: "engineer".into(),
                    parent_session_key: None,
                    attempt: 1,
                },
            )
            .unwrap();
        let access_id = store
            .grant_session_access(
                &session.session_id,
                SessionAccessRequest {
                    accessor_role: "qa".into(),
                    permission: SessionPermission::Message,
                    granted_by: "cto".into(),
                    expires_at: None,
                },
            )
            .unwrap();
        let message = store
            .enqueue_session_message(
                &session.session_id,
                SessionMessageRequest {
                    sender_role: "engineer".into(),
                    recipient_role: "qa".into(),
                    message_type: "session.message".into(),
                    payload: serde_json::json!({"content":"must not send"}),
                    correlation_id: None,
                    dedupe_key: None,
                    available_at: None,
                },
            )
            .unwrap();
        let claim = store
            .claim_session_message(&message.message_id, "qa", 60)
            .unwrap()
            .unwrap();
        assert!(store.revoke_session_access(&access_id, "cto").unwrap());

        assert!(
            store
                .record_session_message_delivery_start(
                    &message.message_id,
                    claim.attempt,
                    claim.lease_until.as_deref().unwrap(),
                )
                .is_err()
        );
        let connection = store.connection.lock().unwrap();
        let (state, transport_started_at): (String, Option<String>) = connection
            .query_row(
                "SELECT state,transport_started_at FROM session_messages WHERE message_id=?1",
                params![message.message_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(state, "CLAIMED");
        assert!(transport_started_at.is_none());
    }

    #[test]
    fn agent_session_lifecycle_is_fenced_and_terminated_state_is_final() {
        let store = Store::in_memory().unwrap();
        let workflow = store.create_proposal(proposal()).unwrap();
        let session = store
            .create_agent_session(
                &workflow.workflow_id,
                "task_one",
                AgentSessionCreateRequest {
                    runtime_session_key: "runtime:session:lifecycle".into(),
                    role: "engineer".into(),
                    parent_session_key: None,
                    attempt: 1,
                },
            )
            .unwrap();
        let active = store
            .update_agent_session(&session.session_id, 1, "ACTIVE", Some("turn-1"), true)
            .unwrap();
        assert_eq!(active.state, "ACTIVE");
        assert!(
            store
                .update_agent_session(&session.session_id, 2, "PAUSED", None, false)
                .is_err()
        );
        let terminated = store
            .update_agent_session(&session.session_id, 1, "TERMINATED", None, false)
            .unwrap();
        assert_eq!(terminated.state, "TERMINATED");
        assert!(
            store
                .update_agent_session(&session.session_id, 1, "ACTIVE", None, false)
                .is_err()
        );
    }

    #[test]
    fn expired_message_claim_before_transport_start_can_be_reclaimed_but_not_duplicated() {
        let store = Store::in_memory().unwrap();
        let workflow = store.create_proposal(proposal()).unwrap();
        let session = store
            .create_agent_session(
                &workflow.workflow_id,
                "task_one",
                AgentSessionCreateRequest {
                    runtime_session_key: "runtime:session:expired-prestart".into(),
                    role: "engineer".into(),
                    parent_session_key: None,
                    attempt: 1,
                },
            )
            .unwrap();
        store
            .grant_session_access(
                &session.session_id,
                SessionAccessRequest {
                    accessor_role: "qa".into(),
                    permission: SessionPermission::Message,
                    granted_by: "cto".into(),
                    expires_at: None,
                },
            )
            .unwrap();
        let queued = store
            .enqueue_session_message(
                &session.session_id,
                SessionMessageRequest {
                    sender_role: "engineer".into(),
                    recipient_role: "qa".into(),
                    message_type: "session.message".into(),
                    payload: serde_json::json!({"body":"safe-before-send"}),
                    correlation_id: None,
                    dedupe_key: None,
                    available_at: None,
                },
            )
            .unwrap();
        let first = store
            .claim_session_message(&queued.message_id, "qa", 60)
            .unwrap()
            .unwrap();
        assert!(first.claim_acquired);
        store.connection.lock().unwrap().execute(
            "UPDATE session_messages SET lease_until='2000-01-01T00:00:00.000Z' WHERE message_id=?1",
            params![queued.message_id],
        ).unwrap();
        let reclaimed = store
            .claim_session_message(&queued.message_id, "qa", 60)
            .unwrap()
            .unwrap();
        assert!(reclaimed.claim_acquired);
        assert_eq!(reclaimed.attempt, first.attempt + 1);
        assert!(reclaimed.transport_started_at.is_none());
        let competing = store
            .claim_session_message(&queued.message_id, "qa", 60)
            .unwrap()
            .unwrap();
        assert!(!competing.claim_acquired);
        assert_eq!(competing.attempt, reclaimed.attempt);
    }

    #[test]
    fn concurrent_message_claim_across_connections_has_one_acquirer() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session-claims.sqlite");
        let store = Store::create_new(&path).unwrap();
        let workflow = store.create_proposal(proposal()).unwrap();
        let session = store
            .create_agent_session(
                &workflow.workflow_id,
                "task_one",
                AgentSessionCreateRequest {
                    runtime_session_key: "runtime:session:concurrent".into(),
                    role: "engineer".into(),
                    parent_session_key: None,
                    attempt: 1,
                },
            )
            .unwrap();
        store
            .grant_session_access(
                &session.session_id,
                SessionAccessRequest {
                    accessor_role: "qa".into(),
                    permission: SessionPermission::Message,
                    granted_by: "cto".into(),
                    expires_at: None,
                },
            )
            .unwrap();
        let queued = store
            .enqueue_session_message(
                &session.session_id,
                SessionMessageRequest {
                    sender_role: "engineer".into(),
                    recipient_role: "qa".into(),
                    message_type: "session.message".into(),
                    payload: serde_json::json!({"body":"one-claim"}),
                    correlation_id: None,
                    dedupe_key: None,
                    available_at: None,
                },
            )
            .unwrap();
        let second = Store::open_existing(&path).unwrap();
        let first = Arc::new(store);
        let second = Arc::new(second);
        let barrier = Arc::new(Barrier::new(3));
        let left = {
            let store = first.clone();
            let barrier = barrier.clone();
            let id = queued.message_id.clone();
            thread::spawn(move || {
                barrier.wait();
                store.claim_session_message(&id, "qa", 60).unwrap().unwrap()
            })
        };
        let right = {
            let store = second.clone();
            let barrier = barrier.clone();
            let id = queued.message_id.clone();
            thread::spawn(move || {
                barrier.wait();
                store.claim_session_message(&id, "qa", 60).unwrap().unwrap()
            })
        };
        barrier.wait();
        let a = left.join().unwrap();
        let b = right.join().unwrap();
        assert_ne!(a.claim_acquired, b.claim_acquired);
        assert_eq!(a.attempt, 1);
        assert_eq!(b.attempt, 1);
    }

    #[test]
    fn session_attach_and_takeover_require_explicit_non_owner_authority() {
        let store = Store::in_memory().unwrap();
        let workflow = store.create_proposal(proposal()).unwrap();
        let session = store
            .create_agent_session(
                &workflow.workflow_id,
                "task_one",
                AgentSessionCreateRequest {
                    runtime_session_key: "runtime:session:takeover".into(),
                    role: "engineer".into(),
                    parent_session_key: None,
                    attempt: 1,
                },
            )
            .unwrap();
        let owner_attach = store
            .attach_agent_session(&session.session_id, "engineer", "OBSERVE")
            .unwrap();
        assert_eq!(owner_attach.permission, "OBSERVE");
        assert_eq!(owner_attach.mode, "OBSERVE");
        let takeover_grant = store
            .grant_session_access(
                &session.session_id,
                SessionAccessRequest {
                    accessor_role: "qa".into(),
                    permission: SessionPermission::Takeover,
                    granted_by: "cto".into(),
                    expires_at: Some("2027-01-01T00:00:00.000Z".into()),
                },
            )
            .unwrap();
        let before = store
            .list_workflow_events(&workflow.workflow_id, 100)
            .unwrap()
            .len();
        assert_eq!(
            store
                .grant_session_access(
                    &session.session_id,
                    SessionAccessRequest {
                        accessor_role: "qa".into(),
                        permission: SessionPermission::Takeover,
                        granted_by: "cto".into(),
                        expires_at: Some("2027-01-01T00:00:00.000Z".into())
                    }
                )
                .unwrap(),
            takeover_grant
        );
        assert_eq!(
            store
                .list_workflow_events(&workflow.workflow_id, 100)
                .unwrap()
                .len(),
            before
        );
        store
            .grant_session_access(
                &session.session_id,
                SessionAccessRequest {
                    accessor_role: "qa".into(),
                    permission: SessionPermission::Takeover,
                    granted_by: "cto".into(),
                    expires_at: Some("2028-01-01T00:00:00.000Z".into()),
                },
            )
            .unwrap();
        let updated_event = store
            .list_workflow_events(&workflow.workflow_id, 100)
            .unwrap()
            .into_iter()
            .find(|event| event.event_type == "session.access_updated")
            .unwrap();
        assert_eq!(
            updated_event.payload["previousExpiresAt"],
            "2027-01-01T00:00:00.000Z"
        );
        assert_eq!(
            updated_event.payload["expiresAt"],
            "2028-01-01T00:00:00.000Z"
        );
        assert!(
            store
                .takeover_agent_session(&session.session_id, "engineer", "owner cannot take over")
                .is_err()
        );
        assert!(
            store
                .takeover_agent_session(
                    &session.session_id,
                    "qa",
                    "active session cannot be taken over"
                )
                .is_err()
        );
        store
            .update_agent_session(&session.session_id, 1, "PAUSED", None, false)
            .unwrap();
        let taken = store
            .takeover_agent_session(&session.session_id, "qa", "owner handoff accepted")
            .unwrap();
        assert_eq!(taken.state, "ACTIVE");
        assert_eq!(taken.attempt, 1);
        assert!(
            store
                .list_workflow_events(&workflow.workflow_id, 100)
                .unwrap()
                .iter()
                .any(|event| event.event_type == "session.takeover")
        );
    }
}
