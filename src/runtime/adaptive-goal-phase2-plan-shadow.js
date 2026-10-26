import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';
import { classifyAdaptiveGoalEvidenceReference, validateAdaptiveGoalGraph } from './adaptive-goal-graph.js';
import { searchAdaptiveGoalGraphPhase2 } from './adaptive-goal-phase2-search.js';

export const ADAPTIVE_GOAL_PHASE2_PLAN_SHADOW_SCHEMA_VERSION = 1;
const ACTION_NODE_TYPES = new Set(['task', 'experiment']);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
const fail = message => { throw new TypeError(`AdaptiveGoalPhase2PlanShadow: ${message}`); };

function evidenceAssessment(references) {
  const classifications = references.map(reference => ({ reference, classification: classifyAdaptiveGoalEvidenceReference(reference), verified: false }));
  return {
    status: !references.length ? 'missing' : classifications.every(item => item.classification === 'placeholder_not_evidence') ? 'placeholder_only' : 'declared_unverified',
    references: classifications,
    verifiedReferenceCount: 0
  };
}

/** Project only a freshly replayed Phase 2 complete candidate into a non-persisted Plan Graph shadow draft. */
export function projectAdaptiveGoalPhase2CandidateToPlanGraphShadow(graphInput, modelInput, candidateInput, optionsInput = {}) {
  if (!candidateInput || typeof candidateInput !== 'object' || Array.isArray(candidateInput)) fail('candidate must be an object');
  const graph = validateAdaptiveGoalGraph(graphInput);
  const replay = searchAdaptiveGoalGraphPhase2(graphInput, modelInput, optionsInput);
  const candidate = replay.candidates.find(item => item.planId === candidateInput.planId);
  if (!candidate || canonicalJson(candidate) !== canonicalJson(candidateInput)) fail('candidate does not exactly match the replayed Phase 2 search result');
  if (candidate.candidateKind !== 'complete_path_candidate' || candidate.status !== 'proposed' || candidate.verification?.verified !== false ||
      candidate.execution?.enabled !== false || candidate.execution?.authorized !== false || candidate.execution?.dispatched !== false) {
    fail('only complete, unverified, non-executable Phase 2 candidates can be projected');
  }
  if (candidate.pathNodeIds[0] !== graph.startNodeId || candidate.pathNodeIds.at(-1) !== graph.goalNodeId) fail('candidate path does not bind graph start and goal');
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const actionNodes = candidate.pathNodeIds.slice(1, -1).map(id => nodeById.get(id)).filter(node => ACTION_NODE_TYPES.has(node.type));
  if (!actionNodes.length) fail('candidate path has no task or experiment nodes');
  const stepIdByNodeId = new Map(actionNodes.map(node => [node.id, `agg-p2-step-${hash({ graphHash: graph.graphHash, candidatePlanId: candidate.planId, nodeId: node.id }).slice(0, 24)}`]));
  const requirements = new Map(graph.nodes.map(node => [node.id, []]));
  for (const edge of graph.edges) {
    if (edge.type === 'requires_all') requirements.get(edge.to).push(edge.from);
    else if (edge.type === 'depends_on') requirements.get(edge.from).push(edge.to);
  }
  const initiallyAvailable = new Set(replay.search.options.initiallyAvailableIds);
  const steps = actionNodes.map((node, index) => {
    const pathPosition = candidate.pathNodeIds.indexOf(node.id);
    const dependencyNodeIds = new Set(actionNodes.slice(0, index).map(item => item.id));
    for (const requiredNodeId of requirements.get(node.id)) {
      const requiredPosition = candidate.pathNodeIds.indexOf(requiredNodeId);
      if (requiredPosition < 0 && !initiallyAvailable.has(requiredNodeId)) fail(`missing prerequisite ${requiredNodeId} for ${node.id}`);
      if (requiredPosition >= pathPosition && requiredPosition >= 0) fail(`prerequisite ${requiredNodeId} occurs after ${node.id}`);
      if (stepIdByNodeId.has(requiredNodeId)) dependencyNodeIds.add(requiredNodeId);
    }
    const references = [...node.evidenceRefs];
    return {
      id: stepIdByNodeId.get(node.id), sourceNodeId: node.id, kind: node.type, title: node.label || node.id,
      dependencies: [...dependencyNodeIds].map(id => stepIdByNodeId.get(id)).filter(Boolean),
      estimates: { cost: node.estimatedCost, risk: node.estimatedRisk, successConfidence: node.estimatedSuccessConfidence,
        reusePotential: node.reusePotential, informationValue: node.informationValue, metricProvenance: structuredClone(node.metricProvenance) },
      supportingEvidenceRefs: references, evidenceAssessment: evidenceAssessment(references),
      execution: { enabled: false, authorization: 'none', executable: null, args: null }, status: 'proposed'
    };
  });
  const actionNodeIds = new Set(actionNodes.map(node => node.id));
  const contextNodes = candidate.pathNodeIds.filter(id => id !== graph.startNodeId && id !== graph.goalNodeId && !actionNodeIds.has(id)).map(id => {
    const node = nodeById.get(id), references = [...node.evidenceRefs];
    return { id: node.id, type: node.type, ...(node.label === undefined ? {} : { label: node.label }),
      supportingEvidenceRefs: references, evidenceAssessment: evidenceAssessment(references) };
  });
  const goal = nodeById.get(graph.goalNodeId);
  const draft = {
    schemaVersion: ADAPTIVE_GOAL_PHASE2_PLAN_SHADOW_SCHEMA_VERSION, kind: 'adaptive_goal_phase2_plan_graph_shadow_draft',
    status: 'review_required',
    source: { mode: 'shadow', rankingMode: 'discriminator_shadow', graphHash: graph.graphHash, candidatePlanId: candidate.planId,
      modelSha256: candidate.provenance.modelSha256, searchRunId: replay.search.searchRunId, searchStatus: replay.status,
      verification: { status: 'unverified', verified: false }, acceptance: 'offline_shadow_not_acceptance' },
    goal: { nodeId: goal.id, ...(goal.label === undefined ? {} : { label: goal.label }) },
    sourcePathNodeIds: [...candidate.pathNodeIds], contextNodes, steps,
    gates: { humanReviewRequired: true, workflowApprovalRequired: true, immutableExecutionPlanCreated: false,
      dispatchAllowed: false, executionAuthorized: false, persisted: false }
  };
  draft.draftHash = hash(draft);
  return draft;
}
