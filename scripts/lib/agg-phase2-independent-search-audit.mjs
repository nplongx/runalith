import { createHash } from 'node:crypto';

// Reference implementation for evidence verification. This module deliberately
// imports no production AGG graph, scoring, search, serializer, or Plan Graph
// code. It is an independently maintained executable specification for the
// bounded Phase 2 search result and complete audit trace.
const FEATURES = ['successConfidence', 'riskSafety', 'costEfficiency', 'reusePotential', 'informationValue', 'testedHypothesisRatio', 'supportEdgeRatio'];
const METRICS = ['estimatedCost', 'estimatedRisk', 'estimatedSuccessConfidence', 'reusePotential', 'informationValue'];
const NOMINAL = new Set(['next_step', 'enables']);
const CONFLICTS = new Set(['contradicts', 'alternative_to']);
const NODE_TYPES = new Set(['goal', 'idea', 'hypothesis', 'candidate', 'experiment', 'capability', 'evidence', 'condition', 'task']);
const EDGE_TYPES = new Set(['next_step', 'requires_all', 'depends_on', 'supports', 'alternative_to', 'enables', 'tested_by', 'contradicts', 'recovers_to']);
const textCompare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const clamp = value => Math.max(0, Math.min(1, value));
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : referenceCanonical(value)).digest('hex');

export function referenceCanonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError('reference canonicalizer rejects non-finite and negative-zero numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(referenceCanonical).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('reference canonicalizer accepts JSON values only');
  return `{${Object.keys(value).sort(textCompare).map(key => `${JSON.stringify(key)}:${referenceCanonical(value[key])}`).join(',')}}`;
}

function normalizeGraph(input) {
  if (!input || input.schemaVersion !== 1 || !Array.isArray(input.nodes) || !Array.isArray(input.edges) || input.nodes.length < 1 || input.nodes.length > 500 || input.edges.length > 2000) {
    throw new TypeError('reference graph is malformed or outside resource bounds');
  }
  if (Object.keys(input).some(key => !['schemaVersion', 'startNodeId', 'goalNodeId', 'nodes', 'edges', 'graphHash'].includes(key))) throw new TypeError('reference graph contains unsupported top-level fields');
  const nodes = input.nodes.map((node, index) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new TypeError(`reference graph node ${index} is malformed`);
    if (Object.keys(node).some(key => !['id', 'type', 'label', ...METRICS, 'metricProvenance', 'evidenceRefs'].includes(key))) throw new TypeError(`reference graph node ${index} has unsupported fields`);
    const normalized = { id: node.id, type: node.type, ...(node.label === undefined ? {} : { label: node.label.trim() }) };
    for (const metric of METRICS) normalized[metric] = node[metric] === undefined || node[metric] === null ? null : node[metric];
    const provenance = {};
    for (const metric of METRICS) {
      const explicit = node[metric] !== undefined && node[metric] !== null;
    const meta = node.metricProvenance?.[metric];
    if (node.metricProvenance !== undefined && (!node.metricProvenance || typeof node.metricProvenance !== 'object' || Array.isArray(node.metricProvenance) ||
        Object.keys(node.metricProvenance).some(key => !METRICS.includes(key)))) throw new TypeError(`reference graph node ${index} has invalid metric provenance`);
    if (meta !== undefined && (!meta || typeof meta !== 'object' || Array.isArray(meta) ||
        Object.keys(meta).some(key => !['method', 'sourceRefs', 'confidence'].includes(key)) ||
        meta.method !== undefined && (typeof meta.method !== 'string' || meta.method.trim().length > 240) ||
        meta.confidence !== undefined && meta.confidence !== null && (typeof meta.confidence !== 'number' || !Number.isFinite(meta.confidence) || meta.confidence < 0 || meta.confidence > 1) ||
        meta.sourceRefs !== undefined && (!Array.isArray(meta.sourceRefs) || meta.sourceRefs.length > 16 || meta.sourceRefs.some(ref => typeof ref !== 'string' || !ref.trim() || ref.trim().length > 512) || new Set(meta.sourceRefs.map(ref => ref.trim())).size !== meta.sourceRefs.length))) throw new TypeError(`reference graph node ${index} has invalid metric provenance entry`);
      provenance[metric] = meta === undefined
        ? { classification: explicit ? 'caller_estimate_unverified' : 'unknown', method: explicit ? 'unspecified caller estimate' : null, sourceRefs: [], confidence: null, provenanceVerified: false }
        : { classification: explicit ? 'caller_estimate_unverified' : 'unknown', method: meta.method?.trim() || (explicit ? 'unspecified caller estimate' : null), sourceRefs: [...(meta.sourceRefs ?? [])].map(item => item.trim()).sort(textCompare), confidence: meta.confidence ?? null, provenanceVerified: false };
    }
    normalized.metricProvenance = provenance;
    normalized.evidenceRefs = [...(node.evidenceRefs ?? [])].map(item => item.trim()).sort(textCompare);
    if (typeof node.id !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(node.id) || !NODE_TYPES.has(node.type) ||
        node.label !== undefined && (typeof node.label !== 'string' || node.label.trim().length > 500)) throw new TypeError(`reference graph node ${index} has invalid fields`);
    const ranges = { estimatedCost: [0, 1e9], estimatedRisk: [0, 1], estimatedSuccessConfidence: [0, 1], reusePotential: [0, 1], informationValue: [0, 1] };
    for (const metric of METRICS) if (normalized[metric] !== null && (typeof normalized[metric] !== 'number' || !Number.isFinite(normalized[metric]) || normalized[metric] < ranges[metric][0] || normalized[metric] > ranges[metric][1])) throw new TypeError(`reference graph node ${index} has invalid ${metric}`);
    return normalized;
  }).sort((a, b) => textCompare(a.id, b.id));
  if (new Set(nodes.map(node => node.id)).size !== nodes.length) throw new TypeError('reference graph has duplicate node IDs');
  const ids = new Set(nodes.map(node => node.id));
  if (!ids.has(input.startNodeId) || !ids.has(input.goalNodeId)) throw new TypeError('reference graph start/goal is missing');
  const edges = input.edges.map((edge, index) => {
    if (!edge || typeof edge !== 'object' || !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to || !EDGE_TYPES.has(edge.type)) throw new TypeError(`reference graph edge ${index} is malformed`);
    if (Object.keys(edge).some(key => !['from', 'to', 'type', 'condition'].includes(key))) throw new TypeError(`reference graph edge ${index} has unsupported fields`);
    if (edge.type === 'tested_by' && (!['hypothesis', 'idea', 'candidate'].includes(nodes.find(node => node.id === edge.from)?.type) || nodes.find(node => node.id === edge.to)?.type !== 'experiment')) throw new TypeError('reference graph tested_by edge has invalid endpoint types');
    if (edge.type !== 'recovers_to' && edge.condition !== undefined) throw new TypeError('reference graph has a condition on a non-recovery edge');
    let condition;
    if (edge.type === 'recovers_to') {
      const validOutcomes = ['failed', 'blocked', 'verification_failed', 'evidence_missing', 'contradicted'];
      if (!edge.condition || typeof edge.condition !== 'object' || Array.isArray(edge.condition) ||
          Object.keys(edge.condition).some(key => !['onOutcome', 'requiresEvidenceNodeIds', 'requiresAllNodeIds'].includes(key)) || !validOutcomes.includes(edge.condition.onOutcome)) throw new TypeError('reference recovery edge condition is malformed');
      const normalizeRefs = (refs, label) => {
        if (refs === undefined) refs = [];
        if (!Array.isArray(refs) || refs.length > 500 || refs.some(ref => typeof ref !== 'string' || !ref.trim() || ref.trim().length > 512) || new Set(refs.map(ref => ref.trim())).size !== refs.length) throw new TypeError(`reference recovery ${label} list is malformed`);
        return refs.map(ref => ref.trim()).sort(textCompare);
      };
      condition = { onOutcome: edge.condition.onOutcome, requiresEvidenceNodeIds: normalizeRefs(edge.condition.requiresEvidenceNodeIds, 'evidence'), requiresAllNodeIds: normalizeRefs(edge.condition.requiresAllNodeIds, 'prerequisite') };
      for (const id of condition.requiresEvidenceNodeIds) if (!ids.has(id) || nodes.find(node => node.id === id)?.type !== 'evidence' || !nodes.find(node => node.id === id)?.evidenceRefs.length) throw new TypeError('reference recovery condition references invalid evidence');
      for (const id of condition.requiresAllNodeIds) if (!ids.has(id)) throw new TypeError('reference recovery condition references an unknown prerequisite');
    }
    return { from: edge.from, to: edge.to, type: edge.type, ...(condition ? { condition } : {}) };
  }).sort((a, b) => textCompare(a.from, b.from) || textCompare(a.to, b.to) || textCompare(a.type, b.type));
  if (new Set(edges.map(edge => `${edge.from}\u0000${edge.type}\u0000${edge.to}`)).size !== edges.length) throw new TypeError('reference graph has duplicate edges');
  const assertAcyclic = (included, label) => {
    const adjacency = new Map(nodes.map(node => [node.id, []]));
    for (const edge of edges) if (included.has(edge.type)) adjacency.get(edge.from).push(edge.to);
    const visiting = new Set(), visited = new Set();
    const visit = id => {
      if (visiting.has(id)) throw new TypeError(`reference graph ${label} cycle at ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const next of adjacency.get(id)) visit(next);
      visiting.delete(id); visited.add(id);
    };
    for (const node of nodes) visit(node.id);
  };
  assertAcyclic(new Set([...NOMINAL, 'recovers_to']), 'transition');
  assertAcyclic(new Set(['requires_all', 'depends_on']), 'prerequisite');
  const canonical = { schemaVersion: 1, startNodeId: input.startNodeId, goalNodeId: input.goalNodeId, nodes, edges };
  return { ...canonical, graphHash: createHash('sha256').update(JSON.stringify(canonical)).digest('hex') };
}

function metricsForPath(pathIds, byId) {
  const steps = pathIds.slice(1).map(id => byId.get(id)).filter(node => node.type !== 'goal');
  const aggregate = (key, fn) => !steps.length || steps.some(node => node[key] === null || !Number.isFinite(node[key])) ? null : fn(steps.map(node => node[key]));
  return {
    estimatedCost: aggregate('estimatedCost', values => values.reduce((sum, value) => sum + value, 0)),
    estimatedRisk: aggregate('estimatedRisk', values => 1 - values.reduce((product, value) => product * (1 - value), 1)),
    estimatedSuccessConfidence: aggregate('estimatedSuccessConfidence', values => values.reduce((product, value) => product * value, 1)),
    reusePotential: aggregate('reusePotential', values => Math.min(1, values.reduce((sum, value) => sum + value, 0))),
    informationValue: aggregate('informationValue', values => Math.min(1, values.reduce((sum, value) => sum + value, 0)))
  };
}

function scoreFeatures(pathIds, graph, byId, model) {
  const set = new Set(pathIds), metrics = metricsForPath(pathIds, byId);
  const hypothesisIds = pathIds.filter(id => ['hypothesis', 'idea', 'candidate'].includes(byId.get(id)?.type));
  const tested = hypothesisIds.filter(id => graph.edges.some(edge => edge.type === 'tested_by' && edge.from === id && set.has(edge.to))).length;
  const supports = graph.edges.filter(edge => edge.type === 'supports' && set.has(edge.from) && set.has(edge.to)).length;
  const features = {
    successConfidence: metrics.estimatedSuccessConfidence === null ? 0 : clamp(metrics.estimatedSuccessConfidence),
    riskSafety: metrics.estimatedRisk === null ? 0 : clamp(1 - metrics.estimatedRisk),
    costEfficiency: metrics.estimatedCost === null ? 0 : clamp(1 / (1 + Math.max(0, metrics.estimatedCost))),
    reusePotential: metrics.reusePotential === null ? 0 : clamp(metrics.reusePotential),
    informationValue: metrics.informationValue === null ? 0 : clamp(metrics.informationValue),
    testedHypothesisRatio: clamp(tested / Math.max(1, hypothesisIds.length)),
    supportEdgeRatio: clamp(supports / Math.max(1, pathIds.length - 1))
  };
  let logit = model.intercept;
  for (const feature of FEATURES) logit += model.weights[feature] * ((features[feature] - model.means[feature]) / model.scales[feature]);
  const probability = logit >= 0 ? 1 / (1 + Math.exp(-Math.min(logit, 709))) : Math.exp(Math.max(logit, -745)) / (1 + Math.exp(Math.max(logit, -745)));
  return { metrics, features, probability: clamp(probability), modelSha256: model.modelSha256 };
}

function compareState(a, b) {
  return Number(b.isGoal) - Number(a.isGoal) || b.probability - a.probability ||
    textCompare(a.pathNodeIds.join('\u0000'), b.pathNodeIds.join('\u0000')) || textCompare(a.pathEdgeTypes.join('\u0000'), b.pathEdgeTypes.join('\u0000'));
}

function state(pathNodeIds, pathEdgeTypes, graph, byId, model) {
  const score = scoreFeatures(pathNodeIds, graph, byId, model);
  return { pathNodeIds, pathEdgeTypes, depth: pathNodeIds.length - 1, isGoal: pathNodeIds.at(-1) === graph.goalNodeId, ...score };
}

function candidateFor(item, graph, options, modelSha256) {
  const identity = { graphHash: graph.graphHash, pathNodeIds: item.pathNodeIds, pathEdgeTypes: item.pathEdgeTypes, options, modelSha256 };
  return {
    planId: `agg-p2-${digest(identity).slice(0, 24)}`, candidateKind: 'complete_path_candidate', status: 'proposed',
    pathNodeIds: [...item.pathNodeIds], pathEdgeTypes: [...item.pathEdgeTypes], depth: item.depth, metrics: { ...item.metrics },
    discriminator: { probability: item.probability, features: item.features, modelSha256, classification: 'model_estimate_unverified' },
    verification: { status: 'unverified', verified: false }, execution: { enabled: false, authorized: false, dispatched: false },
    provenance: { graphHash: graph.graphHash, modelSha256, rankingMode: 'discriminator_shadow', acceptance: 'offline_shadow_not_acceptance' }
  };
}

export function independentlyDeriveSearch(graphInput, modelArtifact, optionsInput) {
  const graph = normalizeGraph(graphInput);
  const model = modelArtifact?.model;
  if (!model || typeof model !== 'object' || digest(Object.fromEntries(Object.entries(model).filter(([key]) => key !== 'modelSha256'))) !== model.modelSha256) {
    throw new TypeError('reference search model hash is missing or invalid');
  }
  const { beamWidth, maxDepth, maxExpansions, maxAuditEvents, initiallyAvailableIds } = optionsInput;
  if (![beamWidth, maxDepth, maxExpansions, maxAuditEvents].every(Number.isSafeInteger) || beamWidth < 1 || beamWidth > 100 || maxDepth < 1 || maxDepth > 100 || maxExpansions < 1 || maxExpansions > 10000 || maxAuditEvents < 1 || maxAuditEvents > 5000) throw new TypeError('reference search options exceed resource bounds');
  if (!Array.isArray(initiallyAvailableIds) || new Set(initiallyAvailableIds).size !== initiallyAvailableIds.length || initiallyAvailableIds.some(id => typeof id !== 'string' || !graph.nodes.some(node => node.id === id))) throw new TypeError('reference search availability set is malformed');
  const options = { beamWidth, maxDepth, maxExpansions, maxAuditEvents, initiallyAvailableIds: [...initiallyAvailableIds].sort(textCompare) };
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const transitions = new Map(graph.nodes.map(node => [node.id, []]));
  const requirements = new Map(graph.nodes.map(node => [node.id, []]));
  const conflicts = graph.edges.filter(edge => CONFLICTS.has(edge.type));
  for (const edge of graph.edges) {
    if (NOMINAL.has(edge.type)) transitions.get(edge.from).push(edge);
    if (edge.type === 'requires_all') requirements.get(edge.to).push(edge.from);
    if (edge.type === 'depends_on') requirements.get(edge.from).push(edge.to);
  }
  for (const list of transitions.values()) list.sort((a, b) => textCompare(a.to, b.to) || textCompare(a.type, b.type));
  for (const list of requirements.values()) list.sort(textCompare);
  const available = new Set(options.initiallyAvailableIds);
  const start = state([graph.startNodeId], [], graph, byId, model);
  let beam = start.isGoal ? [] : [start];
  const complete = new Map();
  const events = [];
  let eventCount = 0, omittedEventCount = 0, expansions = 0, expandedStates = 0, generatedStates = 1, prunedStates = 0, budgetExhausted = false, maxDepthReached = false;
  const audit = event => { eventCount++; if (events.length < maxAuditEvents) events.push(event); else omittedEventCount++; };
  if (start.isGoal) complete.set(start.pathNodeIds.join('\u0000'), start);
  while (beam.length) {
    const nextStates = [];
    for (const current of [...beam].sort(compareState)) {
      expandedStates++;
      if (current.isGoal) continue;
      if (current.depth >= maxDepth) { if (transitions.get(current.pathNodeIds.at(-1)).length) maxDepthReached = true; continue; }
      for (const edge of transitions.get(current.pathNodeIds.at(-1))) {
        if (expansions >= maxExpansions) { budgetExhausted = true; break; }
        expansions++;
        if (current.pathNodeIds.includes(edge.to)) { audit({ type: 'edge_rejected', from: edge.from, to: edge.to, reason: 'would_repeat_node' }); continue; }
        const missing = requirements.get(edge.to).filter(id => !available.has(id) && !current.pathNodeIds.includes(id));
        if (missing.length) { audit({ type: 'edge_rejected', from: edge.from, to: edge.to, reason: 'prerequisite_missing', missingPrerequisiteNodeIds: missing }); continue; }
        const conflict = conflicts.find(item => (item.from === edge.to && current.pathNodeIds.includes(item.to)) || (item.to === edge.to && current.pathNodeIds.includes(item.from)));
        if (conflict) { audit({ type: 'edge_rejected', from: edge.from, to: edge.to, reason: conflict.type }); continue; }
        const next = state([...current.pathNodeIds, edge.to], [...current.pathEdgeTypes, edge.type], graph, byId, model);
        generatedStates++;
        audit({ type: 'state_scored', pathNodeIds: [...next.pathNodeIds], discriminatorProbability: next.probability, modelSha256: model.modelSha256 });
        if (next.isGoal) complete.set(JSON.stringify([next.pathNodeIds, next.pathEdgeTypes]), next);
        else nextStates.push(next);
      }
      if (budgetExhausted) break;
    }
    if (budgetExhausted) break;
    nextStates.sort(compareState);
    prunedStates += Math.max(0, nextStates.length - beamWidth);
    nextStates.forEach((item, index) => audit({ type: index < beamWidth ? 'frontier_selected' : 'frontier_pruned', rank: index + 1,
      pathNodeIds: [...item.pathNodeIds], discriminatorProbability: item.probability, ...(index >= beamWidth ? { reason: 'beam_width_exceeded' } : {}) }));
    beam = nextStates.slice(0, beamWidth);
  }
  const modelSha256 = model.modelSha256;
  const candidates = [...complete.values()].sort(compareState).slice(0, beamWidth).map(item => candidateFor(item, graph, options, modelSha256));
  const searchRunId = digest({ graphHash: graph.graphHash, options, modelSha256 });
  const status = budgetExhausted ? 'budget_exhausted' : candidates.length ? 'proposals_found' : maxDepthReached ? 'max_depth_reached' : 'no_solution_found';
  return {
    schemaVersion: 1, mode: 'shadow', status, graphHash: graph.graphHash, candidates,
    search: { searchRunId, options, rankingMode: 'discriminator_shadow', discriminatorModelSha256: modelSha256, expansions, expandedStates,
      generatedStates, prunedStates, maxDepthReached, budgetExhausted, exhaustive: !budgetExhausted && !maxDepthReached && prunedStates === 0,
      acceptance: 'offline_shadow_not_acceptance', executionAuthorized: false },
    auditTrace: { schemaVersion: 1, deterministic: true, searchRunId, rankingMode: 'discriminator_shadow', modelSha256,
      eventCount, omittedEventCount, truncated: omittedEventCount > 0, events }
  };
}
