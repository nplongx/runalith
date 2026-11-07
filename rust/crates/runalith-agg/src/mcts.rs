//! Deterministic, bounded Phase 3 Monte Carlo Tree Search shadow kernel.
//!
//! MCTS explores nominal graph transitions using a validated Phase 2 model
//! estimate. It does not verify evidence, checkpoint provenance, membership,
//! signatures, or authorize execution. Evidence status therefore remains UNKNOWN.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::discriminator::{
    ValidatedDiscriminatorModel, extract_discriminator_features, score_discriminator,
};
use crate::{
    AggCandidate, AggEdge, AggEdgeKind, AggError, AggGraph, AggNode, SearchOptions, State,
    candidate, metrics_for, semantics_for,
};

const MAX_MCTS_ITERATIONS: usize = 10_000;

/// Bounded MCTS parameters. Seed is derived from the immutable graph digest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct MctsOptions {
    /// Number of deterministic selection/expansion/rollout iterations.
    pub iterations: usize,
    /// Maximum transitions in a rollout.
    pub max_depth: usize,
    /// UCB exploration coefficient.
    pub exploration: f64,
    /// Nodes already available outside the candidate path.
    pub initially_available_ids: Vec<String>,
}

impl Default for MctsOptions {
    fn default() -> Self {
        Self {
            iterations: 512,
            max_depth: 12,
            exploration: std::f64::consts::SQRT_2,
            initially_available_ids: Vec::new(),
        }
    }
}

/// One MCTS candidate with sampling statistics and no verification authority.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MctsCandidate {
    /// Exact review-only candidate path.
    pub candidate: AggCandidate,
    /// Number of successful rollouts producing this exact path.
    pub visits: usize,
    /// Mean validated-model reward, still unverified.
    pub mean_reward: f64,
}

/// Bounded Phase 3 MCTS shadow result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MctsSearchResult {
    /// Immutable source graph digest.
    pub graph_hash: String,
    /// Validated Phase 2 model digest.
    pub model_sha256: String,
    /// Candidates sorted by rollout visits, mean reward, then stable ID.
    pub candidates: Vec<MctsCandidate>,
    /// Number of completed MCTS iterations.
    pub iterations: usize,
    /// Number of expanded tree nodes.
    pub expanded_nodes: usize,
    /// MCTS is sampled and never claims exhaustive graph coverage.
    pub exhaustive: bool,
    /// Always `iteration_budget` for a completed bounded run.
    pub termination_reason: String,
    /// No external evidence authority is invoked.
    pub evidence_verification_status: String,
    /// Always false.
    pub evidence_verified: bool,
    /// Always false.
    pub execution_authorized: bool,
    /// Always false.
    pub dispatch_allowed: bool,
}

struct TreeNode {
    state: State,
    parent: Option<usize>,
    children: Vec<usize>,
    untried: Vec<(String, AggEdgeKind)>,
    visits: u64,
    reward_sum: f64,
}

/// Run deterministic MCTS over validated nominal graph transitions. Rollout
/// reward comes only from the validated Phase 2 discriminator; evidence remains
/// UNKNOWN even when a path reaches the goal node.
pub fn mcts_shadow_search(
    graph: &AggGraph,
    options: &MctsOptions,
    model: &ValidatedDiscriminatorModel,
) -> Result<MctsSearchResult, AggError> {
    graph.validate()?;
    if options.iterations == 0
        || options.iterations > MAX_MCTS_ITERATIONS
        || options.max_depth == 0
        || options.max_depth > 100
        || !options.exploration.is_finite()
        || !(0.0..=10.0).contains(&options.exploration)
    {
        return Err(AggError::Invalid(
            "MCTS bounds are outside supported range".into(),
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
        || available.iter().any(|id| !by_id.contains_key(id))
    {
        return Err(AggError::Invalid(
            "MCTS initially_available_ids contains unknown or duplicate node".into(),
        ));
    }
    let mut transitions: BTreeMap<&str, Vec<&AggEdge>> = BTreeMap::new();
    let mut prerequisites: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    let conflicts: Vec<&AggEdge> = graph
        .edges
        .iter()
        .filter(|edge| {
            matches!(
                edge.kind,
                AggEdgeKind::Contradicts | AggEdgeKind::AlternativeTo
            )
        })
        .collect();
    for edge in &graph.edges {
        if matches!(edge.kind, AggEdgeKind::NextStep | AggEdgeKind::Enables) {
            transitions.entry(&edge.from).or_default().push(edge);
        }
        if matches!(edge.kind, AggEdgeKind::RequiresAll | AggEdgeKind::DependsOn) {
            let (required, dependent) = if edge.kind == AggEdgeKind::RequiresAll {
                (edge.from.as_str(), edge.to.as_str())
            } else {
                (edge.to.as_str(), edge.from.as_str())
            };
            prerequisites.entry(dependent).or_default().push(required);
        }
    }
    for edges in transitions.values_mut() {
        edges.sort_by(|left, right| left.to.cmp(&right.to).then(left.kind.cmp(&right.kind)));
    }
    for required in prerequisites.values_mut() {
        required.sort_unstable();
    }
    let search_options = SearchOptions {
        max_depth: options.max_depth,
        beam_width: 100,
        max_expansions: 10_000,
        initially_available_ids: options.initially_available_ids.clone(),
    };
    let start_path = vec![graph.start_node_id.as_str()];
    let root_state = State {
        path: vec![graph.start_node_id.clone()],
        edge_kinds: Vec::new(),
        metrics: metrics_for(&start_path, &by_id),
        semantics: semantics_for(&start_path, graph, &by_id),
    };
    let root_untried = eligible_actions(
        &root_state,
        &available,
        &transitions,
        &prerequisites,
        &conflicts,
    );
    let mut tree = vec![TreeNode {
        state: root_state,
        parent: None,
        children: Vec::new(),
        untried: root_untried,
        visits: 0,
        reward_sum: 0.0,
    }];
    let mut rng = DeterministicRng::from_digest(&graph.graph_hash);
    let mut successful: BTreeMap<String, (AggCandidate, usize, f64)> = BTreeMap::new();

    for _ in 0..options.iterations {
        let mut selected = 0usize;
        loop {
            if !tree[selected].untried.is_empty() {
                let action_index = (rng.next() as usize) % tree[selected].untried.len();
                let (next_id, edge_kind) = tree[selected].untried.remove(action_index);
                let child_state =
                    extend_state(&tree[selected].state, &next_id, edge_kind, graph, &by_id);
                let child_untried = eligible_actions(
                    &child_state,
                    &available,
                    &transitions,
                    &prerequisites,
                    &conflicts,
                );
                let child_index = tree.len();
                tree.push(TreeNode {
                    state: child_state,
                    parent: Some(selected),
                    children: Vec::new(),
                    untried: child_untried,
                    visits: 0,
                    reward_sum: 0.0,
                });
                tree[selected].children.push(child_index);
                selected = child_index;
                break;
            }
            if tree[selected].children.is_empty() {
                break;
            }
            selected = select_ucb_child(selected, &tree, options.exploration);
        }

        let mut rollout_state = tree[selected].state.clone();
        while rollout_state.path.last() != Some(&graph.goal_node_id)
            && rollout_state.edge_kinds.len() < options.max_depth
        {
            let actions = eligible_actions(
                &rollout_state,
                &available,
                &transitions,
                &prerequisites,
                &conflicts,
            );
            if actions.is_empty() {
                break;
            }
            let action_index = (rng.next() as usize) % actions.len();
            let (next_id, edge_kind) = &actions[action_index];
            rollout_state = extend_state(&rollout_state, next_id, *edge_kind, graph, &by_id);
        }
        let reached_goal = rollout_state.path.last() == Some(&graph.goal_node_id);
        let reward = if reached_goal {
            discriminator_reward(&rollout_state, model)?
        } else {
            0.0
        };
        if reached_goal {
            let candidate = candidate(graph, &search_options, rollout_state.clone(), &by_id)?;
            successful
                .entry(candidate.plan_id.clone())
                .and_modify(|(_, visits, reward_sum)| {
                    *visits += 1;
                    *reward_sum += reward;
                })
                .or_insert((candidate, 1, reward));
        }
        let mut cursor = Some(selected);
        while let Some(index) = cursor {
            tree[index].visits = tree[index].visits.saturating_add(1);
            tree[index].reward_sum += reward;
            cursor = tree[index].parent;
        }
    }

    let mut candidates: Vec<MctsCandidate> = successful
        .into_values()
        .map(|(candidate, visits, reward_sum)| MctsCandidate {
            candidate,
            visits,
            mean_reward: reward_sum / visits as f64,
        })
        .collect();
    candidates.sort_by(|left, right| {
        right
            .visits
            .cmp(&left.visits)
            .then_with(|| right.mean_reward.total_cmp(&left.mean_reward))
            .then_with(|| left.candidate.plan_id.cmp(&right.candidate.plan_id))
    });
    Ok(MctsSearchResult {
        graph_hash: graph.graph_hash.clone(),
        model_sha256: model.model_sha256.clone(),
        candidates,
        iterations: options.iterations,
        expanded_nodes: tree.len().saturating_sub(1),
        exhaustive: false,
        termination_reason: "iteration_budget".into(),
        evidence_verification_status: "UNKNOWN".into(),
        evidence_verified: false,
        execution_authorized: false,
        dispatch_allowed: false,
    })
}

fn eligible_actions(
    state: &State,
    available: &BTreeSet<&str>,
    transitions: &BTreeMap<&str, Vec<&AggEdge>>,
    prerequisites: &BTreeMap<&str, Vec<&str>>,
    conflicts: &[&AggEdge],
) -> Vec<(String, AggEdgeKind)> {
    let current = state.path.last().map(String::as_str).unwrap_or_default();
    let reached: BTreeSet<&str> = state.path.iter().map(String::as_str).collect();
    transitions
        .get(current)
        .into_iter()
        .flatten()
        .filter(|edge| {
            !reached.contains(edge.to.as_str())
                && prerequisites
                    .get(edge.to.as_str())
                    .into_iter()
                    .flatten()
                    .all(|required| available.contains(required) || reached.contains(required))
                && !conflicts.iter().any(|conflict| {
                    (conflict.from == edge.to && reached.contains(conflict.to.as_str()))
                        || (conflict.to == edge.to && reached.contains(conflict.from.as_str()))
                })
        })
        .map(|edge| (edge.to.clone(), edge.kind))
        .collect()
}

fn extend_state(
    state: &State,
    next_id: &str,
    edge_kind: AggEdgeKind,
    graph: &AggGraph,
    by_id: &BTreeMap<&str, &AggNode>,
) -> State {
    let mut child = state.clone();
    child.path.push(next_id.to_owned());
    child.edge_kinds.push(edge_kind);
    let path: Vec<&str> = child.path.iter().map(String::as_str).collect();
    child.metrics = metrics_for(&path, by_id);
    child.semantics = semantics_for(&path, graph, by_id);
    child
}

fn select_ucb_child(parent: usize, tree: &[TreeNode], exploration: f64) -> usize {
    let parent_visits = tree[parent].visits.max(1) as f64;
    tree[parent]
        .children
        .iter()
        .copied()
        .max_by(|left, right| {
            let score = |index: usize| {
                let child = &tree[index];
                if child.visits == 0 {
                    f64::INFINITY
                } else {
                    child.reward_sum / child.visits as f64
                        + exploration * (parent_visits.ln() / child.visits as f64).sqrt()
                }
            };
            score(*left)
                .total_cmp(&score(*right))
                .then_with(|| right.cmp(left))
        })
        .expect("non-empty MCTS child list")
}

fn discriminator_reward(
    state: &State,
    model: &ValidatedDiscriminatorModel,
) -> Result<f64, AggError> {
    let features_state = json!({
        "pathNodeIds": state.path,
        "metrics": {
            "estimatedCost": state.metrics.estimated_cost,
            "estimatedRisk": state.metrics.estimated_risk,
            "estimatedSuccessConfidence": state.metrics.estimated_success_confidence,
            "reusePotential": state.metrics.reuse_potential,
            "informationValue": state.metrics.information_value,
        },
        "semantics": {
            "hypothesisCount": state.semantics.hypothesis_count,
            "testedHypothesisCount": state.semantics.tested_hypothesis_count,
            "supportEdgeCount": state.semantics.support_edge_count,
        }
    });
    let features = extract_discriminator_features(&features_state)
        .map_err(|error| AggError::Invalid(error.to_string()))?;
    let score = score_discriminator(
        model,
        &serde_json::to_value(features).map_err(|error| {
            AggError::Invalid(format!("MCTS feature serialization failed: {error}"))
        })?,
    )
    .map_err(|error| AggError::Invalid(error.to_string()))?;
    Ok(score.probability)
}

struct DeterministicRng(u64);

impl DeterministicRng {
    fn from_digest(digest: &str) -> Self {
        let seed = u64::from_str_radix(&digest[..16], 16).unwrap_or(0x9e37_79b9_7f4a_7c15);
        Self(seed ^ 0x9e37_79b9_7f4a_7c15)
    }

    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut value = self.0;
        value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        value ^ (value >> 31)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AggEdgeKind, AggNodeKind};
    use serde_json::Value;

    fn graph() -> AggGraph {
        AggGraph {
            graph_hash: "a".repeat(64),
            start_node_id: "start".into(),
            goal_node_id: "goal".into(),
            nodes: vec![
                node("start", AggNodeKind::Idea, None, None),
                node("fast", AggNodeKind::Task, Some(0.2), Some(0.7)),
                node("safe", AggNodeKind::Task, Some(0.9), Some(0.05)),
                node("goal", AggNodeKind::Goal, None, None),
            ],
            edges: vec![
                edge("start", "fast"),
                edge("fast", "goal"),
                edge("start", "safe"),
                edge("safe", "goal"),
            ],
        }
    }

    fn node(id: &str, kind: AggNodeKind, confidence: Option<f64>, risk: Option<f64>) -> AggNode {
        AggNode {
            id: id.into(),
            kind,
            label: None,
            estimated_cost: Some(1.0),
            estimated_risk: risk,
            estimated_success_confidence: confidence,
            reuse_potential: Some(0.5),
            information_value: Some(0.5),
            evidence_refs: vec![],
        }
    }

    fn edge(from: &str, to: &str) -> AggEdge {
        AggEdge {
            from: from.into(),
            to: to.into(),
            kind: AggEdgeKind::NextStep,
        }
    }

    fn model() -> ValidatedDiscriminatorModel {
        let fixture: Value = serde_json::from_str(include_str!(
            "../fixtures/discriminator-v2-node-golden.json"
        ))
        .unwrap();
        crate::discriminator::validate_discriminator_model(&fixture["model"]).unwrap()
    }

    #[test]
    fn mcts_is_deterministic_bounded_and_never_upgrades_evidence_or_authority() {
        let options = MctsOptions {
            iterations: 256,
            ..MctsOptions::default()
        };
        let first = mcts_shadow_search(&graph(), &options, &model()).unwrap();
        let second = mcts_shadow_search(&graph(), &options, &model()).unwrap();
        assert_eq!(first, second);
        assert!(!first.candidates.is_empty());
        assert!(first.expanded_nodes <= options.iterations);
        assert!(!first.exhaustive);
        assert_eq!(first.evidence_verification_status, "UNKNOWN");
        assert!(!first.evidence_verified && !first.execution_authorized && !first.dispatch_allowed);
        assert!(
            first
                .candidates
                .iter()
                .all(|candidate| !candidate.candidate.evidence_verified
                    && !candidate.candidate.dispatch_allowed)
        );
    }

    #[test]
    fn mcts_rejects_invalid_bounds_and_unknown_initial_availability() {
        let invalid = MctsOptions {
            iterations: 0,
            ..MctsOptions::default()
        };
        assert!(mcts_shadow_search(&graph(), &invalid, &model()).is_err());
        let invalid = MctsOptions {
            initially_available_ids: vec!["missing".into()],
            ..MctsOptions::default()
        };
        assert!(mcts_shadow_search(&graph(), &invalid, &model()).is_err());
    }
}
