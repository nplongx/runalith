import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';
import { validateAdaptiveGoalGraph } from './adaptive-goal-graph.js';
import {
  extractAdaptiveGoalDiscriminatorFeatures,
  scoreAdaptiveGoalDiscriminator,
  validateAdaptiveGoalDiscriminatorModel
} from './adaptive-goal-discriminator.js';

const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const MAX_BEAM_WIDTH = 100;
const MAX_EXPANSIONS = 10000;
const MAX_AUDIT_EVENTS = 5000;

function invalid(message) {
  throw new TypeError(`AdaptiveGoalPhase2Search: ${message}`);
}

function normalizeOptions(options, nodeById) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) invalid('options must be an object');
  const allowed = ['beamWidth', 'maxDepth', 'maxExpansions', 'maxAuditEvents', 'initiallyAvailableIds'];
  const extra = Object.keys(options).filter(key => !allowed.includes(key));
  if (extra.length) invalid(`unsupported options: ${extra.sort().join(', ')}`);
  const beamWidth = options.beamWidth ?? 4;
  const maxDepth = options.maxDepth ?? 12;
  const maxExpansions = options.maxExpansions ?? 128;
  const maxAuditEvents = options.maxAuditEvents ?? 2000;
  if (!Number.isInteger(beamWidth) || beamWidth < 1 || beamWidth > MAX_BEAM_WIDTH) invalid(`beamWidth must be in [1, ${MAX_BEAM_WIDTH}]`);
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 100) invalid('maxDepth must be in [1, 100]');
  if (!Number.isInteger(maxExpansions) || maxExpansions < 1 || maxExpansions > MAX_EXPANSIONS) invalid(`maxExpansions must be in [1, ${MAX_EXPANSIONS}]`);
  if (!Number.isInteger(maxAuditEvents) || maxAuditEvents < 1 || maxAuditEvents > MAX_AUDIT_EVENTS) invalid(`maxAuditEvents must be in [1, ${MAX_AUDIT_EVENTS}]`);
  const initiallyAvailableIds = options.initiallyAvailableIds ?? [];
  if (!Array.isArray(initiallyAvailableIds) || new Set(initiallyAvailableIds).size !== initiallyAvailableIds.length ||
      initiallyAvailableIds.some(id => typeof id !== 'string' || !nodeById.has(id))) invalid('initiallyAvailableIds must contain unique known node IDs');
  return { beamWidth, maxDepth, maxExpansions, maxAuditEvents, initiallyAvailableIds: [...initiallyAvailableIds].sort(compareText) };
}

function pathMetrics(pathNodeIds, nodeById) {
  const steps = pathNodeIds.slice(1).map(id => nodeById.get(id)).filter(node => node.type !== 'goal');
  const aggregate = (key, reducer) => {
    if (!steps.length || steps.some(node => typeof node[key] !== 'number' || !Number.isFinite(node[key]))) return null;
    return reducer(steps.map(node => node[key]));
  };
  return {
    estimatedCost: aggregate('estimatedCost', values => values.reduce((sum, value) => sum + value, 0)),
    estimatedRisk: aggregate('estimatedRisk', values => 1 - values.reduce((product, value) => product * (1 - value), 1)),
    estimatedSuccessConfidence: aggregate('estimatedSuccessConfidence', values => values.reduce((product, value) => product * value, 1)),
    reusePotential: aggregate('reusePotential', values => Math.min(1, values.reduce((sum, value) => sum + value, 0))),
    informationValue: aggregate('informationValue', values => Math.min(1, values.reduce((sum, value) => sum + value, 0)))
  };
}

function pathSemantics(pathNodeIds, graph, nodeById) {
  const pathSet = new Set(pathNodeIds);
  const hypothesisIds = pathNodeIds.filter(id => ['hypothesis', 'idea', 'candidate'].includes(nodeById.get(id)?.type));
  const testedHypothesisCount = hypothesisIds.filter(id => graph.edges.some(edge => edge.type === 'tested_by' && edge.from === id && pathSet.has(edge.to))).length;
  const supportEdgeCount = graph.edges.filter(edge => edge.type === 'supports' && pathSet.has(edge.from) && pathSet.has(edge.to)).length;
  return { hypothesisCount: hypothesisIds.length, testedHypothesisCount, supportEdgeCount };
}

function stateFor(pathNodeIds, pathEdgeTypes, graph, nodeById, model) {
  const state = {
    pathNodeIds,
    pathEdgeTypes,
    depth: pathNodeIds.length - 1,
    isGoal: pathNodeIds.at(-1) === graph.goalNodeId,
    metrics: pathMetrics(pathNodeIds, nodeById),
    semantics: pathSemantics(pathNodeIds, graph, nodeById)
  };
  state.discriminator = scoreAdaptiveGoalDiscriminator(model, extractAdaptiveGoalDiscriminatorFeatures(state));
  return state;
}

function compareStates(a, b) {
  return Number(b.isGoal) - Number(a.isGoal)
    || b.discriminator.probability - a.discriminator.probability
    || compareText(a.pathNodeIds.join('\u0000'), b.pathNodeIds.join('\u0000'))
    || compareText(a.pathEdgeTypes.join('\u0000'), b.pathEdgeTypes.join('\u0000'));
}

function candidateFor(state, graph, options, modelSha256) {
  const identity = { graphHash: graph.graphHash, pathNodeIds: state.pathNodeIds, pathEdgeTypes: state.pathEdgeTypes, options, modelSha256 };
  return {
    planId: `agg-p2-${sha256(identity).slice(0, 24)}`,
    candidateKind: state.isGoal ? 'complete_path_candidate' : 'partial_search_state',
    status: state.isGoal ? 'proposed' : 'partial_proposal',
    pathNodeIds: [...state.pathNodeIds], pathEdgeTypes: [...state.pathEdgeTypes], depth: state.depth,
    metrics: { ...state.metrics }, discriminator: { ...state.discriminator },
    verification: { status: 'unverified', verified: false },
    execution: { enabled: false, authorized: false, dispatched: false },
    provenance: { graphHash: graph.graphHash, modelSha256, rankingMode: 'discriminator_shadow', acceptance: 'offline_shadow_not_acceptance' }
  };
}

/** Build a labelled training row from a path plus an externally adjudicated outcome. */
export function createAdaptiveGoalDiscriminatorExample({ graph: graphInput, pathNodeIds, id, label, initiallyAvailableIds = [] }) {
  const graph = validateAdaptiveGoalGraph(graphInput);
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id)) invalid('example id is invalid');
  if (label !== 0 && label !== 1) invalid('label must be an externally adjudicated 0 or 1');
  if (!Array.isArray(pathNodeIds) || pathNodeIds.length < 2 || pathNodeIds[0] !== graph.startNodeId || pathNodeIds.at(-1) !== graph.goalNodeId ||
      new Set(pathNodeIds).size !== pathNodeIds.length) invalid('pathNodeIds must be a simple start-to-goal path');
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  if (pathNodeIds.some(nodeId => typeof nodeId !== 'string' || !nodeById.has(nodeId))) invalid('pathNodeIds contains an unknown node');
  if (!Array.isArray(initiallyAvailableIds) || new Set(initiallyAvailableIds).size !== initiallyAvailableIds.length ||
      initiallyAvailableIds.some(nodeId => typeof nodeId !== 'string' || !nodeById.has(nodeId))) invalid('initiallyAvailableIds must contain unique known node IDs');
  const pathSet = new Set(pathNodeIds);
  const nominalEdges = graph.edges.filter(edge => ['next_step', 'enables'].includes(edge.type));
  const requirements = new Map(graph.nodes.map(node => [node.id, []]));
  for (const edge of graph.edges) {
    if (edge.type === 'requires_all') requirements.get(edge.to).push(edge.from);
    if (edge.type === 'depends_on') requirements.get(edge.from).push(edge.to);
  }
  for (let index = 1; index < pathNodeIds.length; index++) {
    const from = pathNodeIds[index - 1];
    const to = pathNodeIds[index];
    if (!nominalEdges.some(edge => edge.from === from && edge.to === to)) invalid(`path contains a non-nominal transition: ${from} -> ${to}`);
    const availableBefore = new Set([...initiallyAvailableIds, ...pathNodeIds.slice(0, index)]);
    if (requirements.get(to).some(required => !availableBefore.has(required))) invalid(`path has an unsatisfied prerequisite before ${to}`);
    if (graph.edges.some(edge => ['contradicts', 'alternative_to'].includes(edge.type) &&
      ((edge.from === to && pathSet.has(edge.to)) || (edge.to === to && pathSet.has(edge.from))))) {
      invalid(`path contains contradictory or mutually exclusive nodes at ${to}`);
    }
  }
  const state = {
    pathNodeIds: [...pathNodeIds],
    metrics: pathMetrics(pathNodeIds, nodeById),
    semantics: pathSemantics(pathNodeIds, graph, nodeById)
  };
  return { id, features: extractAdaptiveGoalDiscriminatorFeatures(state), label };
}

/**
 * Independent Phase 2 shadow beam. It intentionally does not modify the frozen
 * Phase 1 search implementation and never returns executable authority.
 */
export function searchAdaptiveGoalGraphPhase2(graphInput, modelInput, optionsInput = {}, onAuditEvent = null) {
  const graph = validateAdaptiveGoalGraph(graphInput);
  const model = validateAdaptiveGoalDiscriminatorModel(modelInput);
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const options = normalizeOptions(optionsInput, nodeById);
  const initiallyAvailable = new Set(options.initiallyAvailableIds);
  const transitions = new Map(graph.nodes.map(node => [node.id, []]));
  const requirements = new Map(graph.nodes.map(node => [node.id, []]));
  const conflicts = graph.edges.filter(edge => ['contradicts', 'alternative_to'].includes(edge.type));
  for (const edge of graph.edges) {
    if (['next_step', 'enables'].includes(edge.type)) transitions.get(edge.from).push(edge);
    if (edge.type === 'requires_all') requirements.get(edge.to).push(edge.from);
    if (edge.type === 'depends_on') requirements.get(edge.from).push(edge.to);
  }
  for (const list of transitions.values()) list.sort((a, b) => compareText(a.to, b.to) || compareText(a.type, b.type));
  for (const list of requirements.values()) list.sort(compareText);

  const start = stateFor([graph.startNodeId], [], graph, nodeById, model);
  let beam = start.isGoal ? [] : [start];
  const complete = new Map();
  const audit = [];
  let auditEventCount = 0;
  let omittedAuditEventCount = 0;
  const recordAudit = event => {
    auditEventCount += 1;
    if (audit.length < options.maxAuditEvents) {
      audit.push(event);
      if (typeof onAuditEvent === 'function') onAuditEvent({ ...event, sequence: auditEventCount, observedAt: new Date().toISOString() });
    } else omittedAuditEventCount += 1;
  };
  if (start.isGoal) complete.set(start.pathNodeIds.join('\u0000'), start);
  let expansions = 0;
  let expandedStates = 0;
  let generatedStates = 1;
  let prunedStates = 0;
  let budgetExhausted = false;
  let maxDepthReached = false;
  while (beam.length) {
    const nextStates = [];
    for (const state of [...beam].sort(compareStates)) {
      expandedStates += 1;
      if (state.isGoal) continue;
      if (state.depth >= options.maxDepth) {
        if (transitions.get(state.pathNodeIds.at(-1)).length) maxDepthReached = true;
        continue;
      }
      for (const edge of transitions.get(state.pathNodeIds.at(-1))) {
        if (expansions >= options.maxExpansions) { budgetExhausted = true; break; }
        expansions += 1;
        if (state.pathNodeIds.includes(edge.to)) { recordAudit({ type: 'edge_rejected', from: edge.from, to: edge.to, reason: 'would_repeat_node' }); continue; }
        const missing = requirements.get(edge.to).filter(id => !initiallyAvailable.has(id) && !state.pathNodeIds.includes(id));
        if (missing.length) { recordAudit({ type: 'edge_rejected', from: edge.from, to: edge.to, reason: 'prerequisite_missing', missingPrerequisiteNodeIds: missing }); continue; }
        const conflict = conflicts.find(item => (item.from === edge.to && state.pathNodeIds.includes(item.to)) || (item.to === edge.to && state.pathNodeIds.includes(item.from)));
        if (conflict) { recordAudit({ type: 'edge_rejected', from: edge.from, to: edge.to, reason: conflict.type }); continue; }
        const next = stateFor([...state.pathNodeIds, edge.to], [...state.pathEdgeTypes, edge.type], graph, nodeById, model);
        generatedStates += 1;
        recordAudit({ type: 'state_scored', pathNodeIds: [...next.pathNodeIds], discriminatorProbability: next.discriminator.probability, modelSha256: model.modelSha256 });
        if (next.isGoal) complete.set(JSON.stringify([next.pathNodeIds, next.pathEdgeTypes]), next);
        else nextStates.push(next);
      }
      if (budgetExhausted) break;
    }
    if (budgetExhausted) break;
    nextStates.sort(compareStates);
    prunedStates += Math.max(0, nextStates.length - options.beamWidth);
    nextStates.forEach((state, index) => recordAudit({ type: index < options.beamWidth ? 'frontier_selected' : 'frontier_pruned', rank: index + 1,
      pathNodeIds: [...state.pathNodeIds], discriminatorProbability: state.discriminator.probability, ...(index >= options.beamWidth ? { reason: 'beam_width_exceeded' } : {}) }));
    beam = nextStates.slice(0, options.beamWidth);
  }
  const candidates = [...complete.values()].sort(compareStates).slice(0, options.beamWidth).map(state => candidateFor(state, graph, options, model.modelSha256));
  const searchRunId = sha256({ graphHash: graph.graphHash, options, modelSha256: model.modelSha256 });
  return {
    schemaVersion: 1,
    mode: 'shadow',
    status: budgetExhausted ? 'budget_exhausted' : candidates.length ? 'proposals_found' : maxDepthReached ? 'max_depth_reached' : 'no_solution_found',
    graphHash: graph.graphHash,
    candidates,
    search: {
      searchRunId, options, rankingMode: 'discriminator_shadow', discriminatorModelSha256: model.modelSha256,
      expansions, expandedStates, generatedStates, prunedStates, maxDepthReached, budgetExhausted,
      exhaustive: !budgetExhausted && !maxDepthReached && prunedStates === 0,
      acceptance: 'offline_shadow_not_acceptance', executionAuthorized: false
    },
    auditTrace: { schemaVersion: 1, deterministic: true, searchRunId, rankingMode: 'discriminator_shadow', modelSha256: model.modelSha256,
      eventCount: auditEventCount, omittedEventCount: omittedAuditEventCount, truncated: omittedAuditEventCount > 0, events: audit }
  };
}
