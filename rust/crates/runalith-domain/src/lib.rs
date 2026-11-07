//! Runalith's domain model and invariants.
//!
//! This crate has no database, transport, provider, filesystem, or process
//! dependencies. Policy and trust verification are deliberately outside the
//! domain model; a well-formed value is not an authorization decision.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Node-compatible typed workflow artifact content contracts.
pub mod artifact_contract;
/// Strict custom-role/custom-workflow catalog contract.
pub mod custom_workflow;
/// Node public built-in workflow compiler host-task DAG parity oracle.
#[cfg(test)]
mod node_builtin_workflow;
/// Explicit compatibility projections for legacy Node workflow lifecycle semantics.
pub mod node_compat;
/// Typed read-only adapter for legacy Node deterministic execution metadata.
pub mod node_execution;
/// Node-compatible canonical JSON for immutable workflow-plan values.
pub mod node_plan_canonical_json;
/// Read-only differential model for Node's runnable-task candidate projection.
pub mod node_scheduler;
/// Read-only differential model for Node's same-task agent retry preflight.
pub mod node_task_retry;
/// Typed workflow catalog, validation, and immutable plan compiler.
pub mod workflow;
/// Versioned workflow catalog/compiler contract with trusted-skill content pins.
pub mod workflow_catalog_v1;
/// Pure workflow-local policy and success-contract schema/composition.
pub mod workflow_policy_v1;

/// Stable workflow lifecycle states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WorkflowState {
    /// Proposal exists but has no approval.
    Proposed,
    /// Exact proposal and immutable plan have an approval record.
    Approved,
    /// At least one task has been claimed for execution.
    Executing,
    /// Every task has verified success evidence.
    Completed,
    /// Workflow ended with a known failure.
    Failed,
    /// Workflow was explicitly cancelled.
    Cancelled,
}

impl WorkflowState {
    /// Whether the workflow can accept further lifecycle transitions.
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }

    /// Whether a transition is part of the supported lifecycle.
    #[must_use]
    pub const fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Proposed, Self::Approved | Self::Cancelled)
                | (Self::Approved, Self::Executing | Self::Cancelled)
                | (
                    Self::Executing,
                    Self::Completed | Self::Failed | Self::Cancelled
                )
        )
    }

    /// Canonical database representation.
    #[must_use]
    pub const fn as_db(self) -> &'static str {
        match self {
            Self::Proposed => "PROPOSED",
            Self::Approved => "APPROVED",
            Self::Executing => "EXECUTING",
            Self::Completed => "COMPLETED",
            Self::Failed => "FAILED",
            Self::Cancelled => "CANCELLED",
        }
    }
}

/// Durable task lifecycle states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TaskState {
    /// Task has not been claimed.
    Pending,
    /// Task is owned by the exact lease and worker identity.
    Running,
    /// Task has verified success evidence.
    Succeeded,
    /// Task has a known failure.
    Failed,
    /// External outcome is ambiguous; automatic replay is forbidden.
    Unknown,
    /// Task was explicitly cancelled.
    Cancelled,
}

impl TaskState {
    /// Canonical database representation.
    #[must_use]
    pub const fn as_db(self) -> &'static str {
        match self {
            Self::Pending => "PENDING",
            Self::Running => "RUNNING",
            Self::Succeeded => "SUCCEEDED",
            Self::Failed => "FAILED",
            Self::Unknown => "UNKNOWN",
            Self::Cancelled => "CANCELLED",
        }
    }
}

/// Typed task outcome. `Unknown` is a quarantine state, not a retry signal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TaskOutcome {
    /// Execution completed and has required evidence.
    Succeeded,
    /// Execution ended with a known failure.
    Failed,
    /// Provider or process outcome cannot be established.
    Unknown,
}

impl TaskOutcome {
    /// Corresponding persisted task state.
    #[must_use]
    pub const fn task_state(self) -> TaskState {
        match self {
            Self::Succeeded => TaskState::Succeeded,
            Self::Failed => TaskState::Failed,
            Self::Unknown => TaskState::Unknown,
        }
    }
}

/// One bounded task in an immutable workflow plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskSpec {
    /// Stable task identifier, unique within its workflow.
    pub task_id: String,
    /// Role required to perform the task.
    pub role: String,
    /// Human-readable bounded task description.
    pub description: String,
    /// Tasks that must have succeeded before this task can be claimed.
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// Required evidence kinds for a successful result.
    #[serde(default)]
    pub required_evidence: Vec<String>,
    /// Typed task inputs. Secrets must not be placed here.
    #[serde(default)]
    pub inputs: BTreeMap<String, Value>,
}

/// User-authored workflow proposal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowProposal {
    /// Stable workflow identifier.
    pub workflow_id: String,
    /// Short display title.
    pub title: String,
    /// Goal statement from the requester.
    pub goal: String,
    /// Proposed bounded tasks.
    pub tasks: Vec<TaskSpec>,
    /// Non-authoritative user metadata.
    #[serde(default)]
    pub metadata: BTreeMap<String, Value>,
}

impl WorkflowProposal {
    /// Validate identity and task graph before persistence.
    pub fn validate(&self) -> Result<(), DomainError> {
        validate_non_empty(&self.workflow_id, "workflow_id")?;
        if !self.workflow_id.starts_with("job_")
            || self.workflow_id.len() <= 4
            || !self.workflow_id[4..]
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            return Err(DomainError::InvalidWorkflowId);
        }
        validate_non_empty(&self.title, "title")?;
        validate_non_empty(&self.goal, "goal")?;
        WorkflowPlan {
            schema_version: 1,
            tasks: self.tasks.clone(),
        }
        .validate()
    }
}

/// Versioned immutable execution plan derived from a proposal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowPlan {
    /// Plan schema version.
    pub schema_version: u32,
    /// Exact task definitions and dependency graph.
    pub tasks: Vec<TaskSpec>,
}

impl WorkflowPlan {
    /// Validate uniqueness, references, bounds, and acyclic dependencies.
    pub fn validate(&self) -> Result<(), DomainError> {
        if self.schema_version != 1 {
            return Err(DomainError::UnsupportedPlanVersion(self.schema_version));
        }
        if self.tasks.is_empty() || self.tasks.len() > 256 {
            return Err(DomainError::TaskCount(self.tasks.len()));
        }

        let mut by_id = BTreeMap::new();
        for (index, task) in self.tasks.iter().enumerate() {
            validate_non_empty(&task.task_id, "task_id")?;
            validate_non_empty(&task.role, "role")?;
            validate_non_empty(&task.description, "description")?;
            if task.task_id.len() > 128 || task.role.len() > 128 || task.description.len() > 16_384
            {
                return Err(DomainError::FieldTooLong(task.task_id.clone()));
            }
            if task.depends_on.len() > 64 || task.required_evidence.len() > 64 {
                return Err(DomainError::TaskFieldCount(task.task_id.clone()));
            }
            let mut evidence_kinds = BTreeSet::new();
            for kind in &task.required_evidence {
                validate_non_empty(kind, "required_evidence kind")?;
                if !evidence_kinds.insert(kind) {
                    return Err(DomainError::DuplicateEvidenceKind {
                        task_id: task.task_id.clone(),
                        kind: kind.clone(),
                    });
                }
            }
            if by_id.insert(task.task_id.as_str(), index).is_some() {
                return Err(DomainError::DuplicateTask(task.task_id.clone()));
            }
        }

        let mut indegree = vec![0_usize; self.tasks.len()];
        let mut outgoing = vec![Vec::new(); self.tasks.len()];
        for (index, task) in self.tasks.iter().enumerate() {
            let mut dependencies = BTreeSet::new();
            for dependency in &task.depends_on {
                if dependency == &task.task_id {
                    return Err(DomainError::SelfDependency(task.task_id.clone()));
                }
                if !dependencies.insert(dependency) {
                    return Err(DomainError::DuplicateDependency {
                        task_id: task.task_id.clone(),
                        dependency: dependency.clone(),
                    });
                }
                let Some(&dependency_index) = by_id.get(dependency.as_str()) else {
                    return Err(DomainError::UnknownDependency {
                        task_id: task.task_id.clone(),
                        dependency: dependency.clone(),
                    });
                };
                indegree[index] += 1;
                outgoing[dependency_index].push(index);
            }
        }

        let mut ready = VecDeque::new();
        for (index, degree) in indegree.iter().enumerate() {
            if *degree == 0 {
                ready.push_back(index);
            }
        }
        let mut visited = 0;
        while let Some(index) = ready.pop_front() {
            visited += 1;
            for &dependent in &outgoing[index] {
                indegree[dependent] -= 1;
                if indegree[dependent] == 0 {
                    ready.push_back(dependent);
                }
            }
        }
        if visited != self.tasks.len() {
            return Err(DomainError::DependencyCycle);
        }
        Ok(())
    }
}

/// Human approval after an external authority verifier has accepted evidence.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Approval {
    /// Unique approval record identifier.
    pub approval_id: String,
    /// Authenticated actor identifier.
    pub actor: String,
    /// Exact proposal digest reviewed by the actor.
    pub proposal_hash: String,
    /// Exact immutable plan digest reviewed by the actor.
    pub plan_hash: String,
    /// Evidence returned by the configured approval verifier.
    pub evidence: Value,
    /// RFC 3339 UTC timestamp.
    pub approved_at: String,
}

/// Content-addressed artifact evidence attached to a task result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceRef {
    /// Stable artifact identifier.
    pub artifact_id: String,
    /// Lowercase SHA-256 digest of exact artifact bytes.
    pub sha256: String,
    /// Task that produced the artifact.
    pub producer_task_id: String,
    /// Exact producer attempt.
    pub producer_attempt: u64,
    /// Evidence category.
    pub kind: String,
}

impl EvidenceRef {
    /// Validate content address and producer lineage.
    pub fn validate_for(&self, task_id: &str, attempt: u64) -> Result<(), DomainError> {
        validate_non_empty(&self.artifact_id, "artifact_id")?;
        validate_non_empty(&self.kind, "evidence.kind")?;
        if self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(DomainError::InvalidDigest(self.artifact_id.clone()));
        }
        if self.producer_task_id != task_id || self.producer_attempt != attempt {
            return Err(DomainError::EvidenceLineageMismatch(
                self.artifact_id.clone(),
            ));
        }
        Ok(())
    }
}

/// Durable task outcome and evidence.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskResult {
    /// Exact task attempt.
    pub attempt: u64,
    /// Terminal or quarantined outcome.
    pub outcome: TaskOutcome,
    /// Evidence references produced by this attempt.
    #[serde(default)]
    pub evidence: Vec<EvidenceRef>,
    /// Diagnostic detail; not a machine-readable authority signal.
    pub error: Option<String>,
    /// RFC 3339 UTC completion/observation timestamp.
    pub recorded_at: String,
}

/// Node classes across the Goal/Idea, Plan, and Execution graph layers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GraphNodeKind {
    /// User objective and measurable success intent.
    Goal,
    /// Research hypothesis, option, or proposed approach.
    Idea,
    /// Immutable plan candidate or approved plan snapshot.
    Plan,
    /// Execution unit, task, attempt, or verified outcome.
    Execution,
    /// Content-addressed artifact or evidence bundle.
    Artifact,
    /// Human or machine decision record.
    Decision,
}

/// Typed relationship between graph nodes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GraphEdgeKind {
    /// Nominal-success transition between planning states.
    NextStep,
    /// All incoming source prerequisites must be satisfied.
    RequiresAll,
    /// Mutually exclusive alternative.
    AlternativeTo,
    /// Capability enables a successor.
    Enables,
    /// Hypothesis is tested by an experiment.
    TestedBy,
    /// Conditional recovery transition; excluded from nominal success paths.
    RecoversTo,
    /// Node is a refinement of another node.
    Refines,
    /// Evidence or reasoning supports a node.
    Supports,
    /// Evidence or reasoning contradicts a node.
    Contradicts,
    /// Parent contains child node.
    Contains,
    /// Source node must complete before target node.
    DependsOn,
    /// Target node was derived from source node.
    DerivedFrom,
    /// Source execution produced target artifact.
    Produces,
    /// Source evidence verifies target claim.
    Verifies,
    /// Source decision authorizes target action.
    Authorizes,
}

/// Immutable, content-addressed revision of one graph node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphNodeRevision {
    /// Stable node identity across revisions.
    pub node_id: String,
    /// Graph layer and node category.
    pub kind: GraphNodeKind,
    /// One-based monotonically increasing node revision.
    pub revision: u64,
    /// Human-readable node title.
    pub title: String,
    /// Typed node content. Secrets and bearer credentials must never be stored here.
    pub content: Value,
    /// SHA-256 of canonical serialized `content`.
    pub content_sha256: String,
    /// Previous revision's complete node-record digest; absent only for revision one.
    pub previous_revision_sha256: Option<String>,
}

impl GraphNodeRevision {
    /// Verify revision identity, sequence linkage, and exact content digest.
    pub fn validate(&self) -> Result<(), DomainError> {
        validate_non_empty(&self.node_id, "graph.node_id")?;
        validate_non_empty(&self.title, "graph.title")?;
        if self.revision == 0 {
            return Err(DomainError::InvalidGraphRevision(self.node_id.clone()));
        }
        if self.revision == 1 && self.previous_revision_sha256.is_some() {
            return Err(DomainError::InvalidGraphRevision(self.node_id.clone()));
        }
        if self.revision > 1 {
            let Some(previous) = self.previous_revision_sha256.as_deref() else {
                return Err(DomainError::InvalidGraphRevision(self.node_id.clone()));
            };
            validate_sha256(previous, &self.node_id)?;
        }
        let expected = content_hash(&self.content)?;
        if self.content_sha256 != expected {
            return Err(DomainError::GraphContentHashMismatch(self.node_id.clone()));
        }
        Ok(())
    }

    /// Digest of the complete immutable revision record, used by the next revision.
    pub fn record_hash(&self) -> Result<String, DomainError> {
        content_hash(self)
    }
}

/// Typed graph relationship. Edges are append-only once included in a snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphEdge {
    /// Stable edge identity.
    pub edge_id: String,
    /// Source node identity.
    pub from_node_id: String,
    /// Target node identity.
    pub to_node_id: String,
    /// Relationship semantics.
    pub kind: GraphEdgeKind,
}

/// Evidence classification. `Verified` is valid only with a verifier receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EvidenceVerification {
    /// Captured but not yet verified against the claim.
    Unverified,
    /// An identified verifier attested to the claim/evidence binding.
    Verified,
    /// An identified verifier rejected the claim/evidence binding.
    Rejected,
    /// Evidence was not retrievable or is outside verifier scope.
    Unavailable,
}

/// Source evidence and its independently recorded claim-verification state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphEvidence {
    /// Stable evidence identity.
    pub evidence_id: String,
    /// Graph node whose claim this evidence evaluates.
    pub node_id: String,
    /// Source locator, not proof that the source is durable or retrievable.
    pub source_uri: String,
    /// SHA-256 of exact source bytes captured by the evidence collector.
    pub source_sha256: String,
    /// Claim this evidence is intended to support or contradict.
    pub claim: String,
    /// Verification classification; defaults must be `Unverified`.
    pub verification: EvidenceVerification,
    /// Identity of independent verifier, if one evaluated the claim.
    pub verifier_id: Option<String>,
    /// SHA-256 of verifier receipt binding claim, source digest, and decision.
    pub verification_receipt_sha256: Option<String>,
}

impl GraphEvidence {
    /// Validate digest syntax and require verifier provenance for a verified/rejected claim.
    pub fn validate(&self) -> Result<(), DomainError> {
        validate_non_empty(&self.evidence_id, "graph.evidence_id")?;
        validate_non_empty(&self.node_id, "graph.evidence.node_id")?;
        validate_non_empty(&self.source_uri, "graph.source_uri")?;
        validate_non_empty(&self.claim, "graph.claim")?;
        validate_sha256(&self.source_sha256, &self.evidence_id)?;
        match self.verification {
            EvidenceVerification::Verified | EvidenceVerification::Rejected => {
                if self.verifier_id.as_deref().is_none_or(str::is_empty) {
                    return Err(DomainError::MissingEvidenceVerifier(
                        self.evidence_id.clone(),
                    ));
                }
                let Some(receipt) = self.verification_receipt_sha256.as_deref() else {
                    return Err(DomainError::MissingEvidenceVerifier(
                        self.evidence_id.clone(),
                    ));
                };
                validate_sha256(receipt, &self.evidence_id)?;
            }
            EvidenceVerification::Unverified | EvidenceVerification::Unavailable => {
                if self.verification_receipt_sha256.is_some() {
                    return Err(DomainError::UnexpectedEvidenceVerifier(
                        self.evidence_id.clone(),
                    ));
                }
            }
        }
        Ok(())
    }
}

/// Immutable, content-addressed snapshot of the latest graph revisions and edges.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphSnapshot {
    /// Stable graph identity.
    pub graph_id: String,
    /// Monotonically increasing graph revision.
    pub revision: u64,
    /// Exact node revisions pinned by this snapshot.
    pub nodes: Vec<GraphNodeRevision>,
    /// Typed graph relationships pinned by this snapshot.
    pub edges: Vec<GraphEdge>,
    /// Evidence and claim-verification states pinned by this snapshot.
    pub evidence: Vec<GraphEvidence>,
    /// Previous persisted snapshot's graph revision; absent only for the first snapshot.
    pub previous_snapshot_revision: Option<u64>,
    /// Previous graph snapshot digest; absent only for the first snapshot.
    pub previous_snapshot_sha256: Option<String>,
    /// RFC 3339 timestamp supplied by the trusted snapshot writer.
    pub created_at: String,
    /// SHA-256 of the complete snapshot payload excluding this field.
    pub snapshot_sha256: String,
}

/// Unsealed snapshot input. Call [`GraphSnapshot::seal`] to validate and digest it.
#[derive(Debug, Clone)]
pub struct GraphSnapshotDraft {
    /// Stable graph identity.
    pub graph_id: String,
    /// Current graph revision being pinned.
    pub revision: u64,
    /// Current immutable node revisions.
    pub nodes: Vec<GraphNodeRevision>,
    /// Current typed graph edges.
    pub edges: Vec<GraphEdge>,
    /// Current captured evidence.
    pub evidence: Vec<GraphEvidence>,
    /// Previous persisted snapshot revision.
    pub previous_snapshot_revision: Option<u64>,
    /// Previous persisted snapshot digest.
    pub previous_snapshot_sha256: Option<String>,
    /// RFC 3339 timestamp supplied by the snapshot writer.
    pub created_at: String,
}

#[derive(Serialize)]
struct GraphSnapshotPayload<'a> {
    graph_id: &'a str,
    revision: u64,
    nodes: &'a [GraphNodeRevision],
    edges: &'a [GraphEdge],
    evidence: &'a [GraphEvidence],
    previous_snapshot_revision: Option<u64>,
    previous_snapshot_sha256: Option<&'a str>,
    created_at: &'a str,
}

impl GraphSnapshot {
    /// Seal a new immutable snapshot after validating graph and provenance invariants.
    pub fn seal(draft: GraphSnapshotDraft) -> Result<Self, DomainError> {
        let mut snapshot = Self {
            graph_id: draft.graph_id,
            revision: draft.revision,
            nodes: draft.nodes,
            edges: draft.edges,
            evidence: draft.evidence,
            previous_snapshot_revision: draft.previous_snapshot_revision,
            previous_snapshot_sha256: draft.previous_snapshot_sha256,
            created_at: draft.created_at,
            snapshot_sha256: String::new(),
        };
        snapshot.snapshot_sha256 = snapshot.calculate_hash()?;
        snapshot.validate()?;
        Ok(snapshot)
    }

    /// Calculate snapshot digest over every pinned node, edge, evidence item, and timestamp.
    pub fn calculate_hash(&self) -> Result<String, DomainError> {
        content_hash(&GraphSnapshotPayload {
            graph_id: &self.graph_id,
            revision: self.revision,
            nodes: &self.nodes,
            edges: &self.edges,
            evidence: &self.evidence,
            previous_snapshot_revision: self.previous_snapshot_revision,
            previous_snapshot_sha256: self.previous_snapshot_sha256.as_deref(),
            created_at: &self.created_at,
        })
    }

    /// Validate graph membership, required DAGs, evidence status, and exact snapshot digest.
    pub fn validate(&self) -> Result<(), DomainError> {
        validate_non_empty(&self.graph_id, "graph_id")?;
        validate_non_empty(&self.created_at, "graph.created_at")?;
        if self.revision == 0 || self.nodes.is_empty() || self.nodes.len() > 4096 {
            return Err(DomainError::InvalidGraphSnapshot(self.graph_id.clone()));
        }
        if let Some(previous_revision) = self.previous_snapshot_revision {
            if previous_revision >= self.revision {
                return Err(DomainError::InvalidGraphRevision(self.graph_id.clone()));
            }
            let Some(previous) = self.previous_snapshot_sha256.as_deref() else {
                return Err(DomainError::InvalidGraphRevision(self.graph_id.clone()));
            };
            validate_sha256(previous, &self.graph_id)?;
        } else if self.previous_snapshot_sha256.is_some() {
            return Err(DomainError::InvalidGraphRevision(self.graph_id.clone()));
        }
        if self.edges.len() > 16_384 || self.evidence.len() > 16_384 {
            return Err(DomainError::GraphSizeLimit(self.graph_id.clone()));
        }

        let mut node_ids = BTreeSet::new();
        for node in &self.nodes {
            node.validate()?;
            if !node_ids.insert(node.node_id.as_str()) {
                return Err(DomainError::DuplicateGraphNode(node.node_id.clone()));
            }
        }

        let mut edge_ids = BTreeSet::new();
        let mut edge_tuples = BTreeSet::new();
        let mut indegree = vec![0_usize; self.nodes.len()];
        let mut outgoing = vec![Vec::new(); self.nodes.len()];
        let node_positions: BTreeMap<&str, usize> = self
            .nodes
            .iter()
            .enumerate()
            .map(|(index, node)| (node.node_id.as_str(), index))
            .collect();
        for edge in &self.edges {
            validate_non_empty(&edge.edge_id, "graph.edge_id")?;
            if !edge_ids.insert(edge.edge_id.as_str()) {
                return Err(DomainError::DuplicateGraphEdge(edge.edge_id.clone()));
            }
            if edge.from_node_id == edge.to_node_id {
                return Err(DomainError::SelfGraphEdge(edge.edge_id.clone()));
            }
            let Some(&from) = node_positions.get(edge.from_node_id.as_str()) else {
                return Err(DomainError::DanglingGraphEdge(edge.edge_id.clone()));
            };
            let Some(&to) = node_positions.get(edge.to_node_id.as_str()) else {
                return Err(DomainError::DanglingGraphEdge(edge.edge_id.clone()));
            };
            if !edge_tuples.insert((
                edge.from_node_id.as_str(),
                edge.to_node_id.as_str(),
                edge.kind,
            )) {
                return Err(DomainError::DuplicateGraphEdge(edge.edge_id.clone()));
            }
            if matches!(
                edge.kind,
                GraphEdgeKind::DependsOn | GraphEdgeKind::Contains | GraphEdgeKind::DerivedFrom
            ) {
                indegree[to] += 1;
                outgoing[from].push(to);
            }
        }

        let mut ready = VecDeque::new();
        for (index, degree) in indegree.iter().enumerate() {
            if *degree == 0 {
                ready.push_back(index);
            }
        }
        let mut visited = 0;
        while let Some(index) = ready.pop_front() {
            visited += 1;
            for &dependent in &outgoing[index] {
                indegree[dependent] -= 1;
                if indegree[dependent] == 0 {
                    ready.push_back(dependent);
                }
            }
        }
        if visited != self.nodes.len() {
            return Err(DomainError::GraphDependencyCycle);
        }

        let mut evidence_ids = BTreeSet::new();
        for evidence in &self.evidence {
            evidence.validate()?;
            if !node_ids.contains(evidence.node_id.as_str()) {
                return Err(DomainError::DanglingGraphEvidence(
                    evidence.evidence_id.clone(),
                ));
            }
            if !evidence_ids.insert(evidence.evidence_id.as_str()) {
                return Err(DomainError::DuplicateGraphEvidence(
                    evidence.evidence_id.clone(),
                ));
            }
        }
        validate_sha256(&self.snapshot_sha256, &self.graph_id)?;
        if self.calculate_hash()? != self.snapshot_sha256 {
            return Err(DomainError::GraphSnapshotHashMismatch(
                self.graph_id.clone(),
            ));
        }
        Ok(())
    }
}

/// Domain validation error.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum DomainError {
    /// Required text field is empty.
    #[error("{0} must be a non-empty string")]
    EmptyField(&'static str),
    /// Workflow ID does not use the COS-AP v1 `job_` identity form.
    #[error("workflow_id must use the job_ prefix and URL-safe ASCII suffix")]
    InvalidWorkflowId,
    /// A string exceeds its contract limit.
    #[error("field exceeds its contract limit: {0}")]
    FieldTooLong(String),
    /// Unsupported immutable plan schema version.
    #[error("unsupported workflow plan schema version: {0}")]
    UnsupportedPlanVersion(u32),
    /// Plan contains no tasks or too many tasks.
    #[error("workflow plan task count is outside [1, 256]: {0}")]
    TaskCount(usize),
    /// Task dependency/evidence arrays exceed their limit.
    #[error("task dependency/evidence count exceeds limit: {0}")]
    TaskFieldCount(String),
    /// Two task definitions use the same ID.
    #[error("duplicate task ID: {0}")]
    DuplicateTask(String),
    /// Task depends on itself.
    #[error("task cannot depend on itself: {0}")]
    SelfDependency(String),
    /// A dependency does not exist in the plan.
    #[error("task {task_id} references unknown dependency {dependency}")]
    UnknownDependency {
        /// Task containing the invalid dependency reference.
        task_id: String,
        /// Referenced task ID that is absent from the plan.
        dependency: String,
    },
    /// Same dependency occurs more than once.
    #[error("task {task_id} repeats dependency {dependency}")]
    DuplicateDependency {
        /// Task containing the duplicate dependency.
        task_id: String,
        /// Repeated dependency task ID.
        dependency: String,
    },
    /// Task repeats a required evidence kind.
    #[error("task {task_id} repeats required evidence kind {kind}")]
    DuplicateEvidenceKind {
        /// Task containing the duplicate evidence requirement.
        task_id: String,
        /// Repeated required evidence category.
        kind: String,
    },
    /// Dependency graph contains a cycle.
    #[error("workflow plan dependency graph contains a cycle")]
    DependencyCycle,
    /// Evidence digest is malformed.
    #[error("evidence has invalid SHA-256 digest: {0}")]
    InvalidDigest(String),
    /// Evidence does not belong to this task attempt.
    #[error("evidence producer lineage mismatch: {0}")]
    EvidenceLineageMismatch(String),
    /// Revision number and previous revision digest do not form a valid chain.
    #[error("invalid node revision chain: {0}")]
    InvalidGraphRevision(String),
    /// Node body does not match its content digest.
    #[error("graph node content digest mismatch: {0}")]
    GraphContentHashMismatch(String),
    /// A verified/rejected claim has no identified verifier receipt.
    #[error("evidence is marked verified/rejected without verifier receipt: {0}")]
    MissingEvidenceVerifier(String),
    /// An unverified/unavailable claim includes an unexpected verification receipt.
    #[error("evidence has an unexpected verifier receipt: {0}")]
    UnexpectedEvidenceVerifier(String),
    /// Graph node identity is repeated in one snapshot.
    #[error("duplicate graph node ID: {0}")]
    DuplicateGraphNode(String),
    /// Graph edge identity or typed relationship is repeated.
    #[error("duplicate graph edge: {0}")]
    DuplicateGraphEdge(String),
    /// Graph edge references a node outside the snapshot.
    #[error("graph edge references missing node: {0}")]
    DanglingGraphEdge(String),
    /// Graph edge connects a node to itself.
    #[error("graph edge cannot connect a node to itself: {0}")]
    SelfGraphEdge(String),
    /// A dependency/containment/derivation relationship contains a cycle.
    #[error("graph contains a dependency/containment/derivation cycle")]
    GraphDependencyCycle,
    /// Graph evidence identity is repeated in one snapshot.
    #[error("duplicate graph evidence ID: {0}")]
    DuplicateGraphEvidence(String),
    /// Evidence references a claim node not pinned by the snapshot.
    #[error("graph evidence references missing claim node: {0}")]
    DanglingGraphEvidence(String),
    /// Snapshot revision or graph membership is invalid.
    #[error("invalid graph snapshot: {0}")]
    InvalidGraphSnapshot(String),
    /// Node/edge/evidence count exceeds its hard bound.
    #[error("graph snapshot exceeds configured size bounds: {0}")]
    GraphSizeLimit(String),
    /// Snapshot payload does not match its content hash.
    #[error("graph snapshot digest mismatch: {0}")]
    GraphSnapshotHashMismatch(String),
    /// Canonical serialization failed.
    #[error("cannot serialize value for hashing: {0}")]
    Serialization(String),
}

/// SHA-256 over the deterministic serde representation of a typed value.
pub fn content_hash<T: Serialize>(value: &T) -> Result<String, DomainError> {
    let bytes =
        serde_json::to_vec(value).map_err(|error| DomainError::Serialization(error.to_string()))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn validate_sha256(value: &str, subject: &str) -> Result<(), DomainError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(DomainError::InvalidDigest(subject.to_owned()));
    }
    Ok(())
}

fn validate_non_empty(value: &str, field: &'static str) -> Result<(), DomainError> {
    if value.trim().is_empty() {
        return Err(DomainError::EmptyField(field));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(task_id: &str, depends_on: &[&str]) -> TaskSpec {
        TaskSpec {
            task_id: task_id.into(),
            role: "engineer".into(),
            description: format!("Do {task_id}"),
            depends_on: depends_on.iter().map(|value| (*value).into()).collect(),
            required_evidence: vec!["artifact".into()],
            inputs: BTreeMap::new(),
        }
    }

    #[test]
    fn accepts_a_valid_dependency_dag() {
        let plan = WorkflowPlan {
            schema_version: 1,
            tasks: vec![task("a", &[]), task("b", &["a"])],
        };
        assert_eq!(plan.validate(), Ok(()));
    }

    #[test]
    fn rejects_cycles_and_missing_dependencies() {
        let cycle = WorkflowPlan {
            schema_version: 1,
            tasks: vec![task("a", &["b"]), task("b", &["a"])],
        };
        assert_eq!(cycle.validate(), Err(DomainError::DependencyCycle));

        let missing = WorkflowPlan {
            schema_version: 1,
            tasks: vec![task("a", &["missing"])],
        };
        assert!(matches!(
            missing.validate(),
            Err(DomainError::UnknownDependency { .. })
        ));
    }

    #[test]
    fn evidence_must_bind_exact_producer_attempt() {
        let evidence = EvidenceRef {
            artifact_id: "artifact-1".into(),
            sha256: "a".repeat(64),
            producer_task_id: "task-1".into(),
            producer_attempt: 2,
            kind: "report".into(),
        };
        assert_eq!(evidence.validate_for("task-1", 2), Ok(()));
        assert_eq!(
            evidence.validate_for("task-1", 1),
            Err(DomainError::EvidenceLineageMismatch("artifact-1".into()))
        );
    }

    #[test]
    fn workflow_transitions_are_explicit_and_terminal_states_do_not_reopen() {
        assert!(WorkflowState::Proposed.can_transition_to(WorkflowState::Approved));
        assert!(!WorkflowState::Proposed.can_transition_to(WorkflowState::Executing));
        assert!(!WorkflowState::Completed.can_transition_to(WorkflowState::Executing));
    }

    fn graph_node(node_id: &str, kind: GraphNodeKind) -> GraphNodeRevision {
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

    fn valid_graph_snapshot() -> GraphSnapshot {
        let nodes = vec![
            graph_node("goal_1", GraphNodeKind::Goal),
            graph_node("idea_1", GraphNodeKind::Idea),
            graph_node("plan_1", GraphNodeKind::Plan),
            graph_node("execution_1", GraphNodeKind::Execution),
        ];
        let edges = vec![
            GraphEdge {
                edge_id: "edge_1".into(),
                from_node_id: "goal_1".into(),
                to_node_id: "idea_1".into(),
                kind: GraphEdgeKind::Refines,
            },
            GraphEdge {
                edge_id: "edge_2".into(),
                from_node_id: "idea_1".into(),
                to_node_id: "plan_1".into(),
                kind: GraphEdgeKind::DerivedFrom,
            },
            GraphEdge {
                edge_id: "edge_3".into(),
                from_node_id: "plan_1".into(),
                to_node_id: "execution_1".into(),
                kind: GraphEdgeKind::Contains,
            },
        ];
        let evidence = vec![GraphEvidence {
            evidence_id: "evidence_1".into(),
            node_id: "goal_1".into(),
            source_uri: "artifact://sha256/source-1".into(),
            source_sha256: "a".repeat(64),
            claim: "Captured source supports the initial goal".into(),
            verification: EvidenceVerification::Unverified,
            verifier_id: None,
            verification_receipt_sha256: None,
        }];
        GraphSnapshot::seal(GraphSnapshotDraft {
            graph_id: "graph_1".into(),
            revision: 1,
            nodes,
            edges,
            evidence,
            previous_snapshot_revision: None,
            previous_snapshot_sha256: None,
            created_at: "2026-11-01T09:00:00Z".into(),
        })
        .unwrap()
    }

    #[test]
    fn graph_snapshot_pins_goal_idea_plan_execution_and_source_evidence() {
        let snapshot = valid_graph_snapshot();
        assert_eq!(snapshot.validate(), Ok(()));
        assert_eq!(snapshot.nodes[0].kind, GraphNodeKind::Goal);
        assert_eq!(snapshot.nodes[1].kind, GraphNodeKind::Idea);
        assert_eq!(snapshot.nodes[2].kind, GraphNodeKind::Plan);
        assert_eq!(snapshot.nodes[3].kind, GraphNodeKind::Execution);
        assert_eq!(
            snapshot.evidence[0].verification,
            EvidenceVerification::Unverified
        );

        let mut tampered = snapshot;
        tampered.nodes[0].title.push_str(" edited");
        assert_eq!(
            tampered.validate(),
            Err(DomainError::GraphSnapshotHashMismatch("graph_1".into()))
        );
    }

    #[test]
    fn graph_rejects_dependency_cycles_dangling_edges_and_unverified_receipts() {
        let mut cycle = valid_graph_snapshot();
        cycle.edges.push(GraphEdge {
            edge_id: "edge_4".into(),
            from_node_id: "execution_1".into(),
            to_node_id: "plan_1".into(),
            kind: GraphEdgeKind::Contains,
        });
        cycle.snapshot_sha256 = cycle.calculate_hash().unwrap();
        assert_eq!(cycle.validate(), Err(DomainError::GraphDependencyCycle));

        let mut dangling = valid_graph_snapshot();
        dangling.edges[0].to_node_id = "missing".into();
        dangling.snapshot_sha256 = dangling.calculate_hash().unwrap();
        assert_eq!(
            dangling.validate(),
            Err(DomainError::DanglingGraphEdge("edge_1".into()))
        );

        let mut forged = valid_graph_snapshot();
        forged.evidence[0].verification = EvidenceVerification::Verified;
        forged.snapshot_sha256 = forged.calculate_hash().unwrap();
        assert_eq!(
            forged.validate(),
            Err(DomainError::MissingEvidenceVerifier("evidence_1".into()))
        );
    }

    #[test]
    fn graph_node_revision_requires_exact_previous_digest() {
        let mut node = graph_node("idea_2", GraphNodeKind::Idea);
        node.revision = 2;
        assert_eq!(
            node.validate(),
            Err(DomainError::InvalidGraphRevision("idea_2".into()))
        );
        node.previous_revision_sha256 = Some("b".repeat(64));
        assert_eq!(node.validate(), Ok(()));
        node.content["objective"] = serde_json::json!("tampered");
        assert_eq!(
            node.validate(),
            Err(DomainError::GraphContentHashMismatch("idea_2".into()))
        );
    }
}
