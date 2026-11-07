//! Phase 2 discriminator ranking over an exactly reproduced Phase 1 result.

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::discriminator::{
    DiscriminatorScore, ValidatedDiscriminatorModel, extract_discriminator_features,
    score_discriminator,
};
use crate::{AggCandidate, AggError, AggGraph, SearchOptions, SearchResult, search};

/// One Phase 1 candidate ranked by the validated but unverified Phase 2 model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Phase2RankedCandidate {
    /// Exact Phase 1 candidate.
    pub candidate: AggCandidate,
    /// Unverified model estimate and exact feature vector.
    pub score: DiscriminatorScoreView,
}

/// JSON-safe projection of a discriminator score.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiscriminatorScoreView {
    /// Predicted positive-class probability.
    pub probability: f64,
    /// Exact canonical features used.
    pub features: std::collections::BTreeMap<String, f64>,
    /// Validated model digest.
    pub model_sha256: String,
    /// Always `model_estimate_unverified`.
    pub classification: String,
}

impl From<DiscriminatorScore> for DiscriminatorScoreView {
    fn from(score: DiscriminatorScore) -> Self {
        Self {
            probability: score.probability,
            features: score.features,
            model_sha256: score.model_sha256,
            classification: score.classification.into(),
        }
    }
}

/// Phase 2 result. Ranking never upgrades evidence or authorizes execution.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Phase2SearchResult {
    /// Immutable source graph digest.
    pub graph_hash: String,
    /// Validated discriminator model digest.
    pub model_sha256: String,
    /// Candidates sorted by model probability, then stable plan ID.
    pub candidates: Vec<Phase2RankedCandidate>,
    /// Inherited Phase 1 exhaustiveness; model ranking cannot improve it.
    pub search_exhaustive: bool,
    /// Inherited Phase 1 termination reason.
    pub search_termination_reason: String,
    /// Explicit model-only status.
    pub status: String,
    /// Always false; no evidence authority is involved.
    pub evidence_verified: bool,
    /// Always false; this result is not an execution authorization.
    pub execution_authorized: bool,
    /// Always false.
    pub dispatch_allowed: bool,
}

/// Reproduce the exact Phase 1 result, then rank its candidates with the
/// validated Phase 2 discriminator. A forged or stale Phase 1 result is rejected.
pub fn rank_search_candidates(
    graph: &AggGraph,
    options: &SearchOptions,
    supplied: &SearchResult,
    model: &ValidatedDiscriminatorModel,
) -> Result<Phase2SearchResult, AggError> {
    let reproduced = search(graph, options)?;
    if &reproduced != supplied {
        return Err(AggError::Invalid(
            "Phase 2 input does not reproduce from the exact Phase 1 graph and bounds".into(),
        ));
    }
    let mut candidates = Vec::with_capacity(reproduced.candidates.len());
    for candidate in reproduced.candidates {
        let state = json!({
            "pathNodeIds": candidate.path_node_ids,
            "metrics": {
                "estimatedCost": candidate.metrics.estimated_cost,
                "estimatedRisk": candidate.metrics.estimated_risk,
                "estimatedSuccessConfidence": candidate.metrics.estimated_success_confidence,
                "reusePotential": candidate.metrics.reuse_potential,
                "informationValue": candidate.metrics.information_value,
            },
            "semantics": {
                "hypothesisCount": candidate.semantics.hypothesis_count,
                "testedHypothesisCount": candidate.semantics.tested_hypothesis_count,
                "supportEdgeCount": candidate.semantics.support_edge_count,
            }
        });
        let features = extract_discriminator_features(&state)
            .map_err(|error| AggError::Invalid(error.to_string()))?;
        let score = score_discriminator(
            model,
            &serde_json::to_value(features).map_err(|error| {
                AggError::Invalid(format!("Phase 2 feature serialization failed: {error}"))
            })?,
        )
        .map_err(|error| AggError::Invalid(error.to_string()))?;
        candidates.push(Phase2RankedCandidate {
            candidate,
            score: score.into(),
        });
    }
    candidates.sort_by(|left, right| {
        right
            .score
            .probability
            .total_cmp(&left.score.probability)
            .then_with(|| left.candidate.plan_id.cmp(&right.candidate.plan_id))
    });
    Ok(Phase2SearchResult {
        graph_hash: reproduced.graph_hash,
        model_sha256: model.model_sha256.clone(),
        status: if candidates.is_empty() {
            "no_candidate_model_estimate".into()
        } else {
            "model_estimate_unverified".into()
        },
        candidates,
        search_exhaustive: reproduced.exhaustive,
        search_termination_reason: reproduced.termination_reason,
        evidence_verified: false,
        execution_authorized: false,
        dispatch_allowed: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AggEdge, AggEdgeKind, AggNode, AggNodeKind};
    use serde_json::Value;

    fn graph() -> AggGraph {
        AggGraph {
            graph_hash: "a".repeat(64),
            start_node_id: "start".into(),
            goal_node_id: "goal".into(),
            nodes: vec![
                node("start", AggNodeKind::Idea, None, None),
                node("fast", AggNodeKind::Task, Some(0.2), Some(0.7)),
                node("safe", AggNodeKind::Task, Some(0.9), Some(0.98)),
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
    fn phase2_ranking_is_reproducible_and_never_verifies_evidence() {
        let graph = graph();
        let options = SearchOptions::default();
        let phase1 = search(&graph, &options).unwrap();
        let first = rank_search_candidates(&graph, &options, &phase1, &model()).unwrap();
        let second = rank_search_candidates(&graph, &options, &phase1, &model()).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.candidates.len(), 2);
        assert!(!first.evidence_verified && !first.execution_authorized && !first.dispatch_allowed);
        assert!(
            first
                .candidates
                .iter()
                .all(|candidate| candidate.score.classification == "model_estimate_unverified")
        );
    }

    #[test]
    fn phase2_rejects_forged_phase1_candidate_and_preserves_boundedness() {
        let graph = graph();
        let options = SearchOptions {
            beam_width: 1,
            ..SearchOptions::default()
        };
        let mut phase1 = search(&graph, &options).unwrap();
        phase1.candidates[0].dispatch_allowed = true;
        assert!(rank_search_candidates(&graph, &options, &phase1, &model()).is_err());
        let phase1 = search(&graph, &options).unwrap();
        let result = rank_search_candidates(&graph, &options, &phase1, &model()).unwrap();
        assert!(!result.search_exhaustive);
        assert_eq!(result.search_termination_reason, "beam_width_pruned");
    }
}
