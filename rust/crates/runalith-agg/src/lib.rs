//! Adaptive Goal Graph (AGG) shadow planner.
//!
//! This crate ranks bounded nominal-success paths. It cannot verify evidence,
//! approve plans, create executable workflows, or dispatch provider work.

use std::collections::{BTreeMap, BTreeSet};

use runalith_domain::{GraphEdge, GraphEdgeKind, GraphNodeRevision};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

pub mod custody;
pub mod discriminator;
pub mod evidence_integrity;
pub mod evidence_resolution;
pub mod graph_contract_v1;
pub mod mcts;
pub mod phase2;

const MAX_NODES: usize = 500;
const MAX_EDGES: usize = 2_000;
const MAX_DEPTH: usize = 100;
const MAX_BEAM: usize = 100;
const MAX_EXPANSIONS: usize = 10_000;

/// AGG semantic node class. It is intentionally independent from workflow task roles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AggNodeKind {
    /// Objective to be achieved.
    Goal,
    /// Idea or hypothesis to investigate.
    Idea,
    /// Explicit hypothesis node with independent semantic identity.
    Hypothesis,
    /// Candidate approach.
    Candidate,
    /// Experiment or validation action.
    Experiment,
    /// Reusable capability.
    Capability,
    /// Evidence item.
    Evidence,
    /// Required condition.
    Condition,
    /// Bounded executable task description; still review-only.
    Task,
}

/// AGG edge semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AggEdgeKind {
    /// Nominal success transition.
    NextStep,
    /// Every incoming prerequisite must be available.
    RequiresAll,
    /// Dependency edge.
    DependsOn,
    /// Positive evidence relation.
    Supports,
    /// Mutually exclusive alternative.
    AlternativeTo,
    /// Capability enables a successor.
    Enables,
    /// Hypothesis is tested by experiment.
    TestedBy,
    /// Conditional recovery transition; excluded from nominal search.
    RecoversTo,
    /// Contradictory evidence relation.
    Contradicts,
}

/// Node in a validated AGG planning input.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AggNode {
    /// Lowercase stable slug.
    pub id: String,
    /// Semantic type.
    pub kind: AggNodeKind,
    /// Optional display label.
    pub label: Option<String>,
    /// Estimated cost; null means unknown.
    pub estimated_cost: Option<f64>,
    /// Estimated risk in [0,1]; null means unknown.
    pub estimated_risk: Option<f64>,
    /// Estimated success confidence in [0,1]; null means unknown.
    pub estimated_success_confidence: Option<f64>,
    /// Reuse potential in [0,1]; null means unknown.
    pub reuse_potential: Option<f64>,
    /// Information value in [0,1]; null means unknown.
    pub information_value: Option<f64>,
    /// Declared source references; none are trusted by this crate.
    #[serde(default)]
    pub evidence_refs: Vec<String>,
}

/// Typed AGG edge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AggEdge {
    /// Source node.
    pub from: String,
    /// Target node.
    pub to: String,
    /// Relationship type.
    pub kind: AggEdgeKind,
}

/// Input graph; `graph_hash` must bind the caller's immutable source snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AggGraph {
    /// Source snapshot digest.
    pub graph_hash: String,
    /// Start node.
    pub start_node_id: String,
    /// Goal node.
    pub goal_node_id: String,
    /// Bounded graph nodes.
    pub nodes: Vec<AggNode>,
    /// Bounded typed edges.
    pub edges: Vec<AggEdge>,
}

/// Bounded deterministic search options.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SearchOptions {
    /// Maximum path depth (default 12).
    pub max_depth: usize,
    /// Retained beam width per expansion round (default 8).
    pub beam_width: usize,
    /// Maximum total state expansions (default 128).
    pub max_expansions: usize,
    /// Nodes already available outside this plan.
    #[serde(default)]
    pub initially_available_ids: Vec<String>,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            max_depth: 12,
            beam_width: 8,
            max_expansions: 128,
            initially_available_ids: Vec::new(),
        }
    }
}

/// Aggregated path metrics. Unknown remains null rather than being imputed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PathMetrics {
    /// Sum of known costs only when every action node has a cost.
    pub estimated_cost: Option<f64>,
    /// Combined risk `1 - product(1-risk)`.
    pub estimated_risk: Option<f64>,
    /// Combined confidence product.
    pub estimated_success_confidence: Option<f64>,
    /// Capped sum of reuse potential.
    pub reuse_potential: Option<f64>,
    /// Capped sum of information value.
    pub information_value: Option<f64>,
}

/// One review-only candidate. It is never an authorization artifact.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AggCandidate {
    /// Stable candidate digest ID.
    pub plan_id: String,
    /// Proposed path node IDs.
    pub path_node_ids: Vec<String>,
    /// Edge types in path order.
    pub path_edge_types: Vec<AggEdgeKind>,
    /// Path metrics with unknowns preserved.
    pub metrics: PathMetrics,
    /// Path-level semantic coverage; declared evidence remains unverified.
    pub semantics: PathSemantics,
    /// Declared evidence references, all unverified.
    pub supporting_evidence_refs: Vec<String>,
    /// Evidence trust state is always false in shadow search.
    pub evidence_verified: bool,
    /// Workflow approval is still required.
    pub human_review_required: bool,
    /// Dispatch is categorically disabled.
    pub dispatch_allowed: bool,
}

/// Semantic counters used by AGG ranking and reviewer inspection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PathSemantics {
    /// Idea/candidate nodes on path.
    pub hypothesis_count: usize,
    /// Hypotheses connected to experiments also on path.
    pub tested_hypothesis_count: usize,
    /// Evidence nodes on path.
    pub evidence_node_count: usize,
    /// Supporting edges within path or into goal.
    pub support_edge_count: usize,
    /// Contradiction/alternative edges with both endpoints on path.
    pub contradiction_count: usize,
    /// Number of distinct declared references.
    pub declared_evidence_ref_count: usize,
    /// Always zero until an external verifier proves claims.
    pub verified_evidence_ref_count: usize,
}

/// Search result and boundedness report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchResult {
    /// Source graph digest.
    pub graph_hash: String,
    /// Status string.
    pub status: String,
    /// Ranked complete paths.
    pub candidates: Vec<AggCandidate>,
    /// Number of expanded states.
    pub expansions: usize,
    /// Whether search was exhaustive under the supplied bounds.
    pub exhaustive: bool,
    /// Why the bounded search stopped.
    pub termination_reason: String,
    /// Explicit non-authority markers.
    pub execution_authorized: bool,
    /// Explicit non-dispatch marker.
    pub dispatch_allowed: bool,
}

/// One task-like step in a review-only Plan Graph projection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanStepDraft {
    /// Stable task-like step ID.
    pub step_id: String,
    /// Source AGG node.
    pub source_node_id: String,
    /// Task or experiment node type.
    pub kind: AggNodeKind,
    /// Display title.
    pub title: String,
    /// Dependencies on earlier steps in this candidate path.
    pub depends_on: Vec<String>,
    /// Supporting source references, all unverified.
    pub supporting_evidence_refs: Vec<String>,
    /// Execution is disabled until separate compile/approval gates.
    pub execution_enabled: bool,
}

/// Review-only Plan Graph; not an executable workflow plan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanGraphDraft {
    /// Review state; always `review_required` for this projection.
    pub status: String,
    /// Stable content-derived draft ID.
    pub draft_id: String,
    /// Source immutable snapshot digest.
    pub source_graph_hash: String,
    /// Exact AGG candidate ID.
    pub candidate_plan_id: String,
    /// Source path node IDs.
    pub source_path_node_ids: Vec<String>,
    /// Projected task-like steps.
    pub steps: Vec<PlanStepDraft>,
    /// Every evidence ref remains unverified.
    pub evidence_verified: bool,
    /// Human review is mandatory.
    pub human_review_required: bool,
    /// Workflow approval remains a separate gate.
    pub workflow_approval_required: bool,
    /// Immutable workflow execution plan has not been created.
    pub immutable_execution_plan_created: bool,
    /// Dispatch is categorically disabled.
    pub dispatch_allowed: bool,
}

/// AGG input, bound, or search failure.
#[derive(Debug, Error, PartialEq)]
pub enum AggError {
    /// Invalid graph or search parameters.
    #[error("invalid AGG input: {0}")]
    Invalid(String),
}

#[derive(Clone)]
struct State {
    path: Vec<String>,
    edge_kinds: Vec<AggEdgeKind>,
    metrics: PathMetrics,
    semantics: PathSemantics,
}

impl AggGraph {
    /// Validate graph identity, limits, references, and acyclic nominal transitions.
    pub fn validate(&self) -> Result<(), AggError> {
        if !valid_digest(&self.graph_hash) {
            return Err(AggError::Invalid(
                "graph_hash must be lowercase SHA-256".into(),
            ));
        }
        if self.nodes.is_empty() || self.nodes.len() > MAX_NODES || self.edges.len() > MAX_EDGES {
            return Err(AggError::Invalid(
                "node/edge count exceeds AGG bounds".into(),
            ));
        }
        if self.start_node_id == self.goal_node_id {
            return Err(AggError::Invalid("start and goal must differ".into()));
        }
        let mut by_id = BTreeMap::new();
        for node in &self.nodes {
            if !valid_id(&node.id) || by_id.insert(node.id.as_str(), node).is_some() {
                return Err(AggError::Invalid(format!(
                    "invalid or duplicate node ID: {}",
                    node.id
                )));
            }
            if node.evidence_refs.len() > 64
                || node.evidence_refs.iter().any(|r| r.trim().is_empty())
            {
                return Err(AggError::Invalid(format!(
                    "invalid evidence references: {}",
                    node.id
                )));
            }
            for (label, value, max) in [
                ("cost", node.estimated_cost, 1e9),
                ("risk", node.estimated_risk, 1.0),
                ("confidence", node.estimated_success_confidence, 1.0),
                ("reuse", node.reuse_potential, 1.0),
                ("information", node.information_value, 1.0),
            ] {
                if value.is_some_and(|v| !v.is_finite() || v < 0.0 || v > max) {
                    return Err(AggError::Invalid(format!(
                        "invalid {label} metric on {}",
                        node.id
                    )));
                }
            }
        }
        if !by_id.contains_key(self.start_node_id.as_str())
            || !by_id.contains_key(self.goal_node_id.as_str())
            || by_id
                .get(self.goal_node_id.as_str())
                .is_some_and(|node| node.kind != AggNodeKind::Goal)
        {
            return Err(AggError::Invalid(
                "start/goal node reference invalid; goal must be Goal".into(),
            ));
        }
        let mut unique = BTreeSet::new();
        let mut adjacency: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for edge in &self.edges {
            if !by_id.contains_key(edge.from.as_str())
                || !by_id.contains_key(edge.to.as_str())
                || edge.from == edge.to
            {
                return Err(AggError::Invalid(format!(
                    "dangling or self edge: {} -> {}",
                    edge.from, edge.to
                )));
            }
            if !unique.insert((edge.from.as_str(), edge.to.as_str(), edge.kind)) {
                return Err(AggError::Invalid("duplicate edge".into()));
            }
            if matches!(
                edge.kind,
                AggEdgeKind::NextStep | AggEdgeKind::Enables | AggEdgeKind::RecoversTo
            ) {
                adjacency.entry(&edge.from).or_default().push(&edge.to);
            }
            if edge.kind == AggEdgeKind::TestedBy
                && (!matches!(
                    by_id[edge.from.as_str()].kind,
                    AggNodeKind::Idea | AggNodeKind::Hypothesis | AggNodeKind::Candidate
                ) || by_id[edge.to.as_str()].kind != AggNodeKind::Experiment)
            {
                return Err(AggError::Invalid(
                    "tested_by must connect idea/candidate to experiment".into(),
                ));
            }
        }
        let mut visiting = BTreeSet::new();
        let mut visited = BTreeSet::new();
        for id in by_id.keys() {
            visit_acyclic(id, &adjacency, &mut visiting, &mut visited)?;
        }
        let mut prerequisites: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for edge in &self.edges {
            if matches!(edge.kind, AggEdgeKind::RequiresAll | AggEdgeKind::DependsOn) {
                let (prerequisite, dependent) = if edge.kind == AggEdgeKind::RequiresAll {
                    (edge.from.as_str(), edge.to.as_str())
                } else {
                    (edge.to.as_str(), edge.from.as_str())
                };
                prerequisites
                    .entry(dependent)
                    .or_default()
                    .push(prerequisite);
            }
        }
        let mut visiting = BTreeSet::new();
        let mut visited = BTreeSet::new();
        for id in by_id.keys() {
            visit_acyclic(id, &prerequisites, &mut visiting, &mut visited)?;
        }
        Ok(())
    }
}

/// Search nominal paths using deterministic beam search and unknown-aware ranking.
pub fn search(graph: &AggGraph, options: &SearchOptions) -> Result<SearchResult, AggError> {
    graph.validate()?;
    if options.max_depth == 0
        || options.max_depth > MAX_DEPTH
        || options.beam_width == 0
        || options.beam_width > MAX_BEAM
        || options.max_expansions == 0
        || options.max_expansions > MAX_EXPANSIONS
    {
        return Err(AggError::Invalid(
            "search bounds outside supported range".into(),
        ));
    }
    let by_id: BTreeMap<&str, &AggNode> = graph
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    let available: BTreeSet<&str> = options
        .initially_available_ids
        .iter()
        .map(String::as_str)
        .collect();
    if available.len() != options.initially_available_ids.len()
        || available
            .iter()
            .any(|id| !valid_id(id) || !by_id.contains_key(id))
    {
        return Err(AggError::Invalid(
            "initially_available_ids contains unknown node".into(),
        ));
    }
    let mut transitions: BTreeMap<&str, Vec<&AggEdge>> = BTreeMap::new();
    let mut prerequisites: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    let conflicts: Vec<&AggEdge> = graph
        .edges
        .iter()
        .filter(|e| {
            matches!(
                e.kind,
                AggEdgeKind::Contradicts | AggEdgeKind::AlternativeTo
            )
        })
        .collect();
    for edge in &graph.edges {
        if matches!(edge.kind, AggEdgeKind::NextStep | AggEdgeKind::Enables) {
            transitions.entry(&edge.from).or_default().push(edge);
        }
        if matches!(edge.kind, AggEdgeKind::RequiresAll | AggEdgeKind::DependsOn) {
            let (required, target) = if edge.kind == AggEdgeKind::RequiresAll {
                (edge.from.as_str(), edge.to.as_str())
            } else {
                (edge.to.as_str(), edge.from.as_str())
            };
            prerequisites.entry(target).or_default().push(required);
        }
    }
    for edges in transitions.values_mut() {
        edges.sort_by(|a, b| a.to.cmp(&b.to).then(a.kind.cmp(&b.kind)));
    }
    for required in prerequisites.values_mut() {
        required.sort_unstable();
    }

    let mut frontier = vec![State {
        path: vec![graph.start_node_id.clone()],
        edge_kinds: vec![],
        metrics: metrics_for(&[graph.start_node_id.as_str()], &by_id),
        semantics: semantics_for(&[graph.start_node_id.as_str()], graph, &by_id),
    }];
    let mut complete = Vec::new();
    let mut expansions = 0;
    let mut depth_limited = false;
    let mut budget_limited = false;
    let mut beam_pruned = false;
    while !frontier.is_empty() && expansions < options.max_expansions {
        frontier.sort_by(compare_states);
        let mut next_frontier = Vec::new();
        for state in frontier.into_iter().take(options.beam_width) {
            if state
                .path
                .last()
                .is_some_and(|id| id == &graph.goal_node_id)
            {
                complete.push(state);
                continue;
            }
            if state.edge_kinds.len() >= options.max_depth {
                let current = state.path.last().expect("non-empty path").as_str();
                let reached: BTreeSet<&str> = state.path.iter().map(String::as_str).collect();
                let can_expand = transitions.get(current).into_iter().flatten().any(|edge| {
                    !reached.contains(edge.to.as_str())
                        && prerequisites
                            .get(edge.to.as_str())
                            .into_iter()
                            .flatten()
                            .all(|required| {
                                available.contains(required) || reached.contains(required)
                            })
                        && !conflicts.iter().any(|conflict| {
                            (conflict.from == edge.to && reached.contains(conflict.to.as_str()))
                                || (conflict.to == edge.to
                                    && reached.contains(conflict.from.as_str()))
                        })
                });
                depth_limited |= can_expand;
                continue;
            }
            if expansions >= options.max_expansions {
                budget_limited = true;
                break;
            }
            expansions += 1;
            let current = state.path.last().expect("non-empty path").as_str();
            for edge in transitions.get(current).into_iter().flatten() {
                if state.path.iter().any(|id| id == &edge.to) {
                    continue;
                }
                let reached: BTreeSet<&str> = state.path.iter().map(String::as_str).collect();
                if prerequisites
                    .get(edge.to.as_str())
                    .into_iter()
                    .flatten()
                    .any(|required| !available.contains(required) && !reached.contains(required))
                {
                    continue;
                }
                if conflicts.iter().any(|conflict| {
                    (conflict.from == edge.to && reached.contains(conflict.to.as_str()))
                        || (conflict.to == edge.to && reached.contains(conflict.from.as_str()))
                }) {
                    continue;
                }
                let mut child = state.clone();
                child.path.push(edge.to.clone());
                child.edge_kinds.push(edge.kind);
                let path: Vec<&str> = child.path.iter().map(String::as_str).collect();
                child.metrics = metrics_for(&path, &by_id);
                child.semantics = semantics_for(&path, graph, &by_id);
                if edge.to == graph.goal_node_id {
                    complete.push(child);
                } else {
                    next_frontier.push(child);
                }
            }
        }
        next_frontier.sort_by(compare_states);
        next_frontier.dedup_by(|a, b| a.path == b.path);
        if next_frontier.len() > options.beam_width {
            beam_pruned = true;
        }
        next_frontier.truncate(options.beam_width);
        frontier = next_frontier;
    }
    if !frontier.is_empty() && expansions >= options.max_expansions {
        budget_limited = true;
    }
    complete.sort_by(compare_states);
    complete.dedup_by(|a, b| a.path == b.path);
    let candidates = complete
        .into_iter()
        .take(options.beam_width)
        .map(|state| candidate(graph, options, state, &by_id))
        .collect::<Result<Vec<_>, _>>()?;
    let exhaustive = !budget_limited && !depth_limited && !beam_pruned && frontier.is_empty();
    let termination_reason = if budget_limited {
        "max_expansions"
    } else if depth_limited {
        "max_depth"
    } else if beam_pruned {
        "beam_width_pruned"
    } else {
        "frontier_exhausted"
    };
    Ok(SearchResult {
        graph_hash: graph.graph_hash.clone(),
        status: if candidates.is_empty() {
            "no_solution_found"
        } else {
            "proposals_found"
        }
        .into(),
        candidates,
        expansions,
        exhaustive,
        termination_reason: termination_reason.into(),
        execution_authorized: false,
        dispatch_allowed: false,
    })
}

/// Reproduce an exact search result and project one candidate into a review-only Plan Graph.
/// This operation never creates a workflow, approval, executable plan, or dispatch intent.
pub fn project_plan(
    graph: &AggGraph,
    options: &SearchOptions,
    supplied_result: &SearchResult,
    candidate_plan_id: &str,
) -> Result<PlanGraphDraft, AggError> {
    let reproduced = search(graph, options)?;
    if &reproduced != supplied_result {
        return Err(AggError::Invalid(
            "search result does not reproduce from exact graph and options".into(),
        ));
    }
    let candidate = reproduced
        .candidates
        .iter()
        .find(|item| item.plan_id == candidate_plan_id)
        .ok_or_else(|| {
            AggError::Invalid("candidate ID is not present in exact reproduced search".into())
        })?;
    let by_id: BTreeMap<&str, &AggNode> = graph
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    let action_nodes: Vec<&AggNode> = candidate
        .path_node_ids
        .iter()
        .skip(1)
        .filter_map(|id| by_id.get(id.as_str()).copied())
        .filter(|node| matches!(node.kind, AggNodeKind::Task | AggNodeKind::Experiment))
        .collect();
    if action_nodes.is_empty() {
        return Err(AggError::Invalid(
            "candidate path has no task/experiment nodes".into(),
        ));
    }
    let mut task_ids = BTreeMap::new();
    for node in &action_nodes {
        let bytes = serde_json::to_vec(&(&graph.graph_hash, &candidate.plan_id, &node.id))
            .map_err(|error| AggError::Invalid(error.to_string()))?;
        task_ids.insert(
            node.id.as_str(),
            format!("agg-step-{}", &hex_digest(&bytes)[..24]),
        );
    }
    let mut previous_step: Option<String> = None;
    let mut steps = Vec::with_capacity(action_nodes.len());
    for node in action_nodes {
        let step_id = task_ids[node.id.as_str()].clone();
        let mut depends_on = Vec::new();
        if let Some(previous) = previous_step.take() {
            depends_on.push(previous);
        }
        for edge in &graph.edges {
            let prerequisite = match edge.kind {
                AggEdgeKind::RequiresAll if edge.to == node.id => Some(edge.from.as_str()),
                AggEdgeKind::DependsOn if edge.from == node.id => Some(edge.to.as_str()),
                _ => None,
            };
            if let Some(required) = prerequisite {
                if let Some(required_step) = task_ids.get(required) {
                    if !depends_on.contains(required_step) {
                        depends_on.push(required_step.clone());
                    }
                } else if !candidate.path_node_ids.iter().any(|id| id == required) {
                    return Err(AggError::Invalid(format!(
                        "candidate lacks prerequisite {required}"
                    )));
                }
            }
        }
        depends_on.sort();
        let title = node.label.clone().unwrap_or_else(|| node.id.clone());
        steps.push(PlanStepDraft {
            step_id: step_id.clone(),
            source_node_id: node.id.clone(),
            kind: node.kind,
            title,
            depends_on,
            supporting_evidence_refs: node.evidence_refs.clone(),
            execution_enabled: false,
        });
        previous_step = Some(step_id);
    }
    let identity = serde_json::to_vec(&(
        &graph.graph_hash,
        &candidate.plan_id,
        &candidate.path_node_ids,
        &steps,
    ))
    .map_err(|error| AggError::Invalid(error.to_string()))?;
    Ok(PlanGraphDraft {
        status: "review_required".into(),
        draft_id: format!("plan-draft-{}", &hex_digest(&identity)[..24]),
        source_graph_hash: graph.graph_hash.clone(),
        candidate_plan_id: candidate.plan_id.clone(),
        source_path_node_ids: candidate.path_node_ids.clone(),
        steps,
        evidence_verified: false,
        human_review_required: true,
        workflow_approval_required: true,
        immutable_execution_plan_created: false,
        dispatch_allowed: false,
    })
}

/// Convert persisted graph nodes/edges to the AGG planner projection.
/// `content.agg` must carry typed planner fields; absent metrics remain unknown.
pub fn project_snapshot(
    graph_hash: &str,
    start_node_id: &str,
    goal_node_id: &str,
    nodes: &[GraphNodeRevision],
    edges: &[GraphEdge],
) -> Result<AggGraph, AggError> {
    let mut projected_nodes = Vec::with_capacity(nodes.len());
    for node in nodes {
        let agg = node.content.get("agg").unwrap_or(&Value::Null);
        if agg.is_null() {
            continue;
        }
        let kind: AggNodeKind =
            serde_json::from_value(agg.get("kind").cloned().unwrap_or(Value::Null))
                .map_err(|e| AggError::Invalid(format!("node {} agg.kind: {e}", node.node_id)))?;
        let metric = |key: &str| agg.get(key).and_then(Value::as_f64);
        let evidence_refs = agg
            .get("evidence_refs")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        projected_nodes.push(AggNode {
            id: node.node_id.clone(),
            kind,
            label: agg.get("label").and_then(Value::as_str).map(str::to_owned),
            estimated_cost: metric("estimated_cost"),
            estimated_risk: metric("estimated_risk"),
            estimated_success_confidence: metric("estimated_success_confidence"),
            reuse_potential: metric("reuse_potential"),
            information_value: metric("information_value"),
            evidence_refs,
        });
    }
    let mut projected_edges = Vec::with_capacity(edges.len());
    for edge in edges {
        let kind = match edge.kind {
            GraphEdgeKind::NextStep => AggEdgeKind::NextStep,
            GraphEdgeKind::RequiresAll => AggEdgeKind::RequiresAll,
            GraphEdgeKind::DependsOn => AggEdgeKind::DependsOn,
            GraphEdgeKind::Supports => AggEdgeKind::Supports,
            GraphEdgeKind::AlternativeTo => AggEdgeKind::AlternativeTo,
            GraphEdgeKind::Enables => AggEdgeKind::Enables,
            GraphEdgeKind::TestedBy => AggEdgeKind::TestedBy,
            GraphEdgeKind::RecoversTo => AggEdgeKind::RecoversTo,
            GraphEdgeKind::Contradicts => AggEdgeKind::Contradicts,
            _ => continue,
        };
        projected_edges.push(AggEdge {
            from: edge.from_node_id.clone(),
            to: edge.to_node_id.clone(),
            kind,
        });
    }
    let graph = AggGraph {
        graph_hash: graph_hash.into(),
        start_node_id: start_node_id.into(),
        goal_node_id: goal_node_id.into(),
        nodes: projected_nodes,
        edges: projected_edges,
    };
    graph.validate()?;
    Ok(graph)
}

fn candidate(
    graph: &AggGraph,
    options: &SearchOptions,
    state: State,
    by_id: &BTreeMap<&str, &AggNode>,
) -> Result<AggCandidate, AggError> {
    let identity = serde_json::json!({"graph_hash":graph.graph_hash,"options":options,"path":state.path,"edge_kinds":state.edge_kinds});
    let bytes = serde_json::to_vec(&identity).map_err(|e| AggError::Invalid(e.to_string()))?;
    let digest = hex_digest(&bytes);
    let mut evidence_refs = BTreeSet::new();
    for id in &state.path {
        for reference in &by_id[id.as_str()].evidence_refs {
            evidence_refs.insert(reference.clone());
        }
    }
    Ok(AggCandidate {
        plan_id: format!("agg-{}", &digest[..24]),
        path_node_ids: state.path,
        path_edge_types: state.edge_kinds,
        metrics: state.metrics,
        semantics: state.semantics,
        supporting_evidence_refs: evidence_refs.into_iter().collect(),
        evidence_verified: false,
        human_review_required: true,
        dispatch_allowed: false,
    })
}

fn metrics_for(path: &[&str], by_id: &BTreeMap<&str, &AggNode>) -> PathMetrics {
    let actions: Vec<&AggNode> = path
        .iter()
        .skip(1)
        .filter_map(|id| by_id.get(id).copied())
        .filter(|node| node.kind != AggNodeKind::Goal)
        .collect();
    let aggregate = |get: fn(&AggNode) -> Option<f64>, reduce: fn(&[f64]) -> f64| {
        if actions.is_empty() {
            return None;
        }
        let values: Option<Vec<f64>> = actions.iter().map(|node| get(node)).collect();
        values.map(|values| reduce(&values))
    };
    PathMetrics {
        estimated_cost: aggregate(|n| n.estimated_cost, |v| v.iter().sum()),
        estimated_risk: aggregate(
            |n| n.estimated_risk,
            |v| 1.0 - v.iter().fold(1.0, |p, x| p * (1.0 - x)),
        ),
        estimated_success_confidence: aggregate(
            |n| n.estimated_success_confidence,
            |v| v.iter().product(),
        ),
        reuse_potential: aggregate(|n| n.reuse_potential, |v| v.iter().sum::<f64>().min(1.0)),
        information_value: aggregate(|n| n.information_value, |v| v.iter().sum::<f64>().min(1.0)),
    }
}

fn semantics_for(
    path: &[&str],
    graph: &AggGraph,
    by_id: &BTreeMap<&str, &AggNode>,
) -> PathSemantics {
    let path_set: BTreeSet<&str> = path.iter().copied().collect();
    let mut evidence_refs = BTreeSet::new();
    let mut hypothesis_count = 0;
    let mut evidence_node_count = 0;
    for id in path {
        if let Some(node) = by_id.get(id) {
            if matches!(
                node.kind,
                AggNodeKind::Idea | AggNodeKind::Hypothesis | AggNodeKind::Candidate
            ) {
                hypothesis_count += 1;
            }
            if node.kind == AggNodeKind::Evidence {
                evidence_node_count += 1;
            }
            evidence_refs.extend(node.evidence_refs.iter().cloned());
        }
    }
    let support_edge_count = graph
        .edges
        .iter()
        .filter(|edge| {
            edge.kind == AggEdgeKind::Supports
                && path_set.contains(edge.from.as_str())
                && (path_set.contains(edge.to.as_str()) || edge.to == graph.goal_node_id)
        })
        .count();
    let tested_hypothesis_count = graph
        .edges
        .iter()
        .filter(|edge| {
            edge.kind == AggEdgeKind::TestedBy
                && path_set.contains(edge.from.as_str())
                && path_set.contains(edge.to.as_str())
                && by_id.get(edge.from.as_str()).is_some_and(|node| {
                    matches!(
                        node.kind,
                        AggNodeKind::Idea | AggNodeKind::Hypothesis | AggNodeKind::Candidate
                    )
                })
                && by_id
                    .get(edge.to.as_str())
                    .is_some_and(|node| node.kind == AggNodeKind::Experiment)
        })
        .count();
    let contradiction_count = graph
        .edges
        .iter()
        .filter(|edge| {
            matches!(
                edge.kind,
                AggEdgeKind::Contradicts | AggEdgeKind::AlternativeTo
            ) && path_set.contains(edge.from.as_str())
                && path_set.contains(edge.to.as_str())
        })
        .count();
    PathSemantics {
        hypothesis_count,
        tested_hypothesis_count,
        evidence_node_count,
        support_edge_count,
        contradiction_count,
        declared_evidence_ref_count: evidence_refs.len(),
        verified_evidence_ref_count: 0,
    }
}

fn compare_states(a: &State, b: &State) -> std::cmp::Ordering {
    compare_optional(
        b.metrics.estimated_success_confidence,
        a.metrics.estimated_success_confidence,
    )
    .then_with(|| compare_optional(a.metrics.estimated_risk, b.metrics.estimated_risk))
    .then_with(|| compare_optional(a.metrics.estimated_cost, b.metrics.estimated_cost))
    .then_with(|| compare_optional(b.metrics.reuse_potential, a.metrics.reuse_potential))
    .then_with(|| compare_optional(b.metrics.information_value, a.metrics.information_value))
    .then_with(|| {
        b.semantics
            .tested_hypothesis_count
            .cmp(&a.semantics.tested_hypothesis_count)
    })
    .then_with(|| {
        b.semantics
            .support_edge_count
            .cmp(&a.semantics.support_edge_count)
    })
    .then_with(|| a.path.len().cmp(&b.path.len()))
    .then_with(|| a.path.cmp(&b.path))
}

fn compare_optional(a: Option<f64>, b: Option<f64>) -> std::cmp::Ordering {
    match (a, b) {
        (Some(left), Some(right)) => left.total_cmp(&right),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

fn visit_acyclic<'a>(
    id: &'a str,
    adjacency: &BTreeMap<&'a str, Vec<&'a str>>,
    visiting: &mut BTreeSet<&'a str>,
    visited: &mut BTreeSet<&'a str>,
) -> Result<(), AggError> {
    if visiting.contains(id) {
        return Err(AggError::Invalid(format!("cycle at {id}")));
    }
    if visited.contains(id) {
        return Ok(());
    }
    visiting.insert(id);
    if let Some(next) = adjacency.get(id) {
        for target in next {
            visit_acyclic(target, adjacency, visiting, visited)?;
        }
    }
    visiting.remove(id);
    visited.insert(id);
    Ok(())
}

fn valid_id(value: &str) -> bool {
    value.split('-').enumerate().all(|(index, part)| {
        !part.is_empty()
            && part
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            && (index != 0 || part.as_bytes()[0].is_ascii_lowercase())
    })
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn hex_digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph() -> AggGraph {
        AggGraph {
            graph_hash: "a".repeat(64),
            start_node_id: "start".into(),
            goal_node_id: "goal".into(),
            nodes: vec![
                AggNode {
                    id: "start".into(),
                    kind: AggNodeKind::Capability,
                    label: None,
                    estimated_cost: None,
                    estimated_risk: None,
                    estimated_success_confidence: None,
                    reuse_potential: None,
                    information_value: None,
                    evidence_refs: vec![],
                },
                AggNode {
                    id: "cheap".into(),
                    kind: AggNodeKind::Task,
                    label: None,
                    estimated_cost: Some(2.0),
                    estimated_risk: Some(0.1),
                    estimated_success_confidence: Some(0.9),
                    reuse_potential: Some(0.2),
                    information_value: Some(0.3),
                    evidence_refs: vec!["artifact://one".into()],
                },
                AggNode {
                    id: "safe".into(),
                    kind: AggNodeKind::Experiment,
                    label: None,
                    estimated_cost: Some(3.0),
                    estimated_risk: Some(0.02),
                    estimated_success_confidence: Some(0.95),
                    reuse_potential: Some(0.4),
                    information_value: Some(0.5),
                    evidence_refs: vec![],
                },
                AggNode {
                    id: "goal".into(),
                    kind: AggNodeKind::Goal,
                    label: None,
                    estimated_cost: None,
                    estimated_risk: None,
                    estimated_success_confidence: None,
                    reuse_potential: None,
                    information_value: None,
                    evidence_refs: vec![],
                },
            ],
            edges: vec![
                AggEdge {
                    from: "start".into(),
                    to: "cheap".into(),
                    kind: AggEdgeKind::NextStep,
                },
                AggEdge {
                    from: "cheap".into(),
                    to: "goal".into(),
                    kind: AggEdgeKind::NextStep,
                },
                AggEdge {
                    from: "start".into(),
                    to: "safe".into(),
                    kind: AggEdgeKind::NextStep,
                },
                AggEdge {
                    from: "safe".into(),
                    to: "goal".into(),
                    kind: AggEdgeKind::NextStep,
                },
            ],
        }
    }

    #[test]
    fn search_is_deterministic_unknown_aware_and_never_authorizes_dispatch() {
        let graph = graph();
        let options = SearchOptions::default();
        let first = search(&graph, &options).unwrap();
        let second = search(&graph, &options).unwrap();
        assert_eq!(first, second);
        assert_eq!(
            first.candidates[0].path_node_ids,
            vec!["start", "safe", "goal"]
        );
        assert_eq!(first.candidates[0].metrics.estimated_cost, Some(3.0));
        assert!(!first.candidates[0].evidence_verified);
        assert!(first.candidates[0].human_review_required);
        assert!(!first.candidates[0].dispatch_allowed);
        assert!(!first.dispatch_allowed && !first.execution_authorized);
    }

    #[test]
    fn unknown_metric_never_receives_optimistic_imputation() {
        let mut graph = graph();
        graph
            .nodes
            .iter_mut()
            .find(|n| n.id == "safe")
            .unwrap()
            .estimated_cost = None;
        let result = search(&graph, &SearchOptions::default()).unwrap();
        assert_eq!(result.candidates[0].metrics.estimated_cost, None);
    }

    #[test]
    fn requires_all_and_conflicts_prune_paths_and_recovery_edges_are_not_nominal() {
        let mut graph = graph();
        graph.edges.push(AggEdge {
            from: "cheap".into(),
            to: "safe".into(),
            kind: AggEdgeKind::RequiresAll,
        });
        graph.edges.push(AggEdge {
            from: "safe".into(),
            to: "goal".into(),
            kind: AggEdgeKind::RequiresAll,
        });
        graph.edges.push(AggEdge {
            from: "safe".into(),
            to: "cheap".into(),
            kind: AggEdgeKind::AlternativeTo,
        });
        graph.edges.push(AggEdge {
            from: "start".into(),
            to: "goal".into(),
            kind: AggEdgeKind::RecoversTo,
        });
        let result = search(&graph, &SearchOptions::default()).unwrap();
        assert!(result.candidates.is_empty());
    }

    #[test]
    fn rejects_dangling_edges_and_cycles() {
        let mut cyclic = graph();
        cyclic.edges.push(AggEdge {
            from: "goal".into(),
            to: "start".into(),
            kind: AggEdgeKind::NextStep,
        });
        assert!(matches!(cyclic.validate(), Err(AggError::Invalid(_))));
        let mut dangling = graph();
        dangling.edges[0].to = "missing".into();
        assert!(matches!(dangling.validate(), Err(AggError::Invalid(_))));
    }

    #[test]
    fn plan_projection_reproduces_candidate_and_remains_non_executable() {
        let graph = graph();
        let options = SearchOptions::default();
        let result = search(&graph, &options).unwrap();
        let candidate = result.candidates.first().unwrap();
        let draft = project_plan(&graph, &options, &result, &candidate.plan_id).unwrap();
        assert_eq!(draft.steps.len(), 1);
        assert_eq!(draft.steps[0].source_node_id, "safe");
        assert!(!draft.steps[0].execution_enabled);
        assert!(!draft.evidence_verified);
        assert!(draft.human_review_required && draft.workflow_approval_required);
        assert!(!draft.immutable_execution_plan_created && !draft.dispatch_allowed);

        let mut forged = result.clone();
        forged.candidates[0].dispatch_allowed = true;
        assert!(matches!(
            project_plan(&graph, &options, &forged, &candidate.plan_id),
            Err(AggError::Invalid(_))
        ));
    }

    #[test]
    fn beam_width_pruning_is_never_reported_as_exhaustive() {
        let graph = graph();
        let options = SearchOptions {
            beam_width: 1,
            ..SearchOptions::default()
        };
        let result = search(&graph, &options).unwrap();
        assert!(!result.exhaustive);
        assert_eq!(result.termination_reason, "beam_width_pruned");
    }

    #[test]
    fn path_semantics_tracks_tested_hypotheses_support_and_unverified_evidence() {
        let mut graph = graph();
        graph.nodes.push(AggNode {
            id: "idea".into(),
            kind: AggNodeKind::Idea,
            label: Some("Test idea".into()),
            estimated_cost: Some(1.0),
            estimated_risk: Some(0.05),
            estimated_success_confidence: Some(0.8),
            reuse_potential: None,
            information_value: Some(0.7),
            evidence_refs: vec!["artifact://idea-source".into()],
        });
        graph
            .edges
            .retain(|edge| !(edge.from == "start" && edge.to == "safe"));
        graph.edges.push(AggEdge {
            from: "start".into(),
            to: "idea".into(),
            kind: AggEdgeKind::NextStep,
        });
        graph.edges.push(AggEdge {
            from: "idea".into(),
            to: "safe".into(),
            kind: AggEdgeKind::NextStep,
        });
        graph.edges.push(AggEdge {
            from: "idea".into(),
            to: "safe".into(),
            kind: AggEdgeKind::TestedBy,
        });
        graph.edges.push(AggEdge {
            from: "idea".into(),
            to: "goal".into(),
            kind: AggEdgeKind::Supports,
        });
        let result = search(&graph, &SearchOptions::default()).unwrap();
        let candidate = result
            .candidates
            .iter()
            .find(|item| item.path_node_ids.contains(&"idea".into()))
            .unwrap();
        assert_eq!(candidate.semantics.hypothesis_count, 1);
        assert_eq!(candidate.semantics.tested_hypothesis_count, 1);
        assert_eq!(candidate.semantics.support_edge_count, 1);
        assert_eq!(candidate.semantics.declared_evidence_ref_count, 1);
        assert_eq!(candidate.semantics.verified_evidence_ref_count, 0);
    }

    #[test]
    fn explicit_hypothesis_nodes_are_testable_and_count_as_hypotheses() {
        let mut graph = graph();
        graph.nodes.push(AggNode {
            id: "hypothesis".into(),
            kind: AggNodeKind::Hypothesis,
            label: Some("Explicit hypothesis".into()),
            estimated_cost: Some(1.0),
            estimated_risk: Some(0.1),
            estimated_success_confidence: Some(0.8),
            reuse_potential: None,
            information_value: None,
            evidence_refs: vec![],
        });
        graph
            .edges
            .retain(|edge| !(edge.from == "start" && edge.to == "safe"));
        graph.edges.push(AggEdge {
            from: "start".into(),
            to: "hypothesis".into(),
            kind: AggEdgeKind::NextStep,
        });
        graph.edges.push(AggEdge {
            from: "hypothesis".into(),
            to: "safe".into(),
            kind: AggEdgeKind::NextStep,
        });
        graph.edges.push(AggEdge {
            from: "hypothesis".into(),
            to: "safe".into(),
            kind: AggEdgeKind::TestedBy,
        });
        let result = search(&graph, &SearchOptions::default()).unwrap();
        let candidate = result
            .candidates
            .iter()
            .find(|item| item.path_node_ids.contains(&"hypothesis".into()))
            .unwrap();
        assert_eq!(candidate.semantics.hypothesis_count, 1);
        assert_eq!(candidate.semantics.tested_hypothesis_count, 1);
    }
}
