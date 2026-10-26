import { createHash } from 'node:crypto';

export const ADAPTIVE_GOAL_GRAPH_SCHEMA_VERSION = 1;

export const ADAPTIVE_GOAL_GRAPH_NODE_TYPES = Object.freeze([
  'goal',
  'idea',
  'hypothesis',
  'candidate',
  'experiment',
  'capability',
  'evidence',
  'condition',
  'task'
]);

export const ADAPTIVE_GOAL_GRAPH_EDGE_TYPES = Object.freeze([
  'next_step',
  'requires_all',
  'depends_on',
  'supports',
  'alternative_to',
  'enables',
  'tested_by',
  'contradicts',
  'recovers_to'
]);

const NODE_TYPE_SET = new Set(ADAPTIVE_GOAL_GRAPH_NODE_TYPES);
const EDGE_TYPE_SET = new Set(ADAPTIVE_GOAL_GRAPH_EDGE_TYPES);
// Recovery edges are contingent and never participate in nominal success
// search unless a matching outcome is explicitly observed.
const NOMINAL_TRANSITION_EDGE_TYPES = new Set(['next_step', 'enables']);
const RECOVERY_EDGE_TYPE = 'recovers_to';
const RECOVERY_OUTCOMES = new Set(['failed', 'blocked', 'verification_failed', 'evidence_missing', 'contradicted']);
const REQUIREMENT_EDGE_TYPE = 'requires_all';
const DEPENDENCY_EDGE_TYPE = 'depends_on';
const MAX_NODES = 500;
const MAX_EDGES = 2000;
const MAX_REFERENCES_PER_NODE = 64;
const MAX_SEARCH_DEPTH = 100;
const MAX_BEAM_WIDTH = 100;
const MAX_EXPANSIONS = 10000;
const MAX_LINEAGES_PER_STATE = 16;
const MAX_AUDIT_EVENTS = 2000;
const SHA256 = /^[a-f0-9]{64}$/;
const METRIC_KEYS = Object.freeze([
  'estimatedCost', 'estimatedRisk', 'estimatedSuccessConfidence', 'reusePotential', 'informationValue'
]);

function invalid(message) {
  throw new TypeError(`AdaptiveGoalGraph: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, allowed, field) {
  const unsupported = Object.keys(value).filter(key => !allowed.includes(key));
  if (unsupported.length) invalid(`${field} contains unsupported fields: ${unsupported.sort().join(', ')}`);
}

function identifier(value, field) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)) {
    invalid(`${field} must be a lowercase slug identifier`);
  }
  return value;
}

function boundedNumber(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    invalid(`${field} must be a finite number between ${min} and ${max}`);
  }
  return value;
}

function nullableNumber(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) return null;
  return boundedNumber(value, field, { min, max });
}

function referenceList(value, field, max = MAX_REFERENCES_PER_NODE) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) invalid(`${field} must be an array with at most ${max} entries`);
  const refs = value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim() || item.trim().length > 512) {
      invalid(`${field}[${index}] must be a non-empty string up to 512 characters`);
    }
    return item.trim();
  });
  if (new Set(refs).size !== refs.length) invalid(`${field} must not contain duplicate references`);
  return refs.sort(compareStrings);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalNode(input, index) {
  const field = `nodes[${index}]`;
  if (!isRecord(input)) invalid(`${field} must be an object`);
  assertExactKeys(input, [
    'id', 'type', 'label', 'estimatedCost', 'estimatedRisk',
    'estimatedSuccessConfidence', 'reusePotential', 'informationValue', 'metricProvenance', 'evidenceRefs'
  ], field);

  const id = identifier(input.id, `${field}.id`);
  if (!NODE_TYPE_SET.has(input.type)) invalid(`${field}.type is unsupported`);
  let label;
  if (input.label !== undefined) {
    if (typeof input.label !== 'string' || input.label.trim().length > 500) invalid(`${field}.label must be a string up to 500 characters`);
    label = input.label.trim();
  }

  const metricLimits = {
    estimatedCost: { min: 0, max: 1e9 },
    estimatedRisk: { min: 0, max: 1 },
    estimatedSuccessConfidence: { min: 0, max: 1 },
    reusePotential: { min: 0, max: 1 },
    informationValue: { min: 0, max: 1 }
  };
  const metricProvenanceInput = input.metricProvenance === undefined ? {} : input.metricProvenance;
  if (!isRecord(metricProvenanceInput)) invalid(`${field}.metricProvenance must be an object`);
  assertExactKeys(metricProvenanceInput, METRIC_KEYS, `${field}.metricProvenance`);
  const metricProvenance = {};
  for (const metric of METRIC_KEYS) {
    const suppliedValue = input[metric];
    const explicitValue = suppliedValue !== undefined && suppliedValue !== null;
    const metadata = metricProvenanceInput[metric];
    if (metadata !== undefined) {
      if (!isRecord(metadata)) invalid(`${field}.metricProvenance.${metric} must be an object`);
      assertExactKeys(metadata, ['method', 'sourceRefs', 'confidence'], `${field}.metricProvenance.${metric}`);
      if (metadata.method !== undefined && (typeof metadata.method !== 'string' || metadata.method.trim().length > 240)) {
        invalid(`${field}.metricProvenance.${metric}.method must be a string up to 240 characters`);
      }
      metricProvenance[metric] = {
        classification: explicitValue ? 'caller_estimate_unverified' : 'unknown',
        method: metadata.method?.trim() || (explicitValue ? 'unspecified caller estimate' : null),
        sourceRefs: referenceList(metadata.sourceRefs, `${field}.metricProvenance.${metric}.sourceRefs`, 16),
        confidence: nullableNumber(metadata.confidence, `${field}.metricProvenance.${metric}.confidence`, { min: 0, max: 1 }),
        provenanceVerified: false
      };
    } else {
      metricProvenance[metric] = {
        classification: explicitValue ? 'caller_estimate_unverified' : 'unknown',
        method: explicitValue ? 'unspecified caller estimate' : null,
        sourceRefs: [],
        confidence: null,
        provenanceVerified: false
      };
    }
  }
  return {
    id,
    type: input.type,
    ...(label === undefined ? {} : { label }),
    estimatedCost: nullableNumber(input.estimatedCost, `${field}.estimatedCost`, metricLimits.estimatedCost),
    estimatedRisk: nullableNumber(input.estimatedRisk, `${field}.estimatedRisk`, metricLimits.estimatedRisk),
    estimatedSuccessConfidence: nullableNumber(input.estimatedSuccessConfidence, `${field}.estimatedSuccessConfidence`, metricLimits.estimatedSuccessConfidence),
    reusePotential: nullableNumber(input.reusePotential, `${field}.reusePotential`, metricLimits.reusePotential),
    informationValue: nullableNumber(input.informationValue, `${field}.informationValue`, metricLimits.informationValue),
    metricProvenance,
    evidenceRefs: referenceList(input.evidenceRefs, `${field}.evidenceRefs`)
  };
}

function canonicalEdge(input, index) {
  const field = `edges[${index}]`;
  if (!isRecord(input)) invalid(`${field} must be an object`);
  assertExactKeys(input, ['from', 'to', 'type', 'condition'], field);
  const from = identifier(input.from, `${field}.from`);
  const to = identifier(input.to, `${field}.to`);
  if (!EDGE_TYPE_SET.has(input.type)) invalid(`${field}.type is unsupported`);
  if (from === to) invalid(`${field} must not connect a node to itself`);
  let condition;
  if (input.type === RECOVERY_EDGE_TYPE) {
    if (!isRecord(input.condition)) invalid(`${field}.condition is required for recovers_to`);
    assertExactKeys(input.condition, ['onOutcome', 'requiresEvidenceNodeIds', 'requiresAllNodeIds'], `${field}.condition`);
    if (!RECOVERY_OUTCOMES.has(input.condition.onOutcome)) invalid(`${field}.condition.onOutcome is unsupported`);
    condition = {
      onOutcome: input.condition.onOutcome,
      requiresEvidenceNodeIds: referenceList(input.condition.requiresEvidenceNodeIds, `${field}.condition.requiresEvidenceNodeIds`, MAX_NODES),
      requiresAllNodeIds: referenceList(input.condition.requiresAllNodeIds, `${field}.condition.requiresAllNodeIds`, MAX_NODES)
    };
  } else if (input.condition !== undefined) {
    invalid(`${field}.condition is only valid for recovers_to`);
  }
  return { from, to, type: input.type, ...(condition ? { condition } : {}) };
}

function assertAcyclic(nodeIds, edges, includedTypes, label) {
  const adjacency = new Map(nodeIds.map(id => [id, []]));
  for (const edge of edges) {
    if (includedTypes.has(edge.type)) adjacency.get(edge.from).push(edge.to);
  }
  for (const successors of adjacency.values()) successors.sort(compareStrings);

  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) invalid(`${label} cycle detected at node: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of adjacency.get(id)) visit(next);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of [...nodeIds].sort(compareStrings)) visit(id);
}

/**
 * Validate and canonicalize a typed goal/idea graph.
 *
 * requires_all edges point from each prerequisite to the node that needs it.
 * A target with multiple incoming requires_all edges needs every prerequisite.
 * The returned graph is data only; it is never executable authority.
 */
export function validateAdaptiveGoalGraph(input) {
  if (!isRecord(input)) invalid('input must be an object');
  assertExactKeys(input, ['schemaVersion', 'startNodeId', 'goalNodeId', 'nodes', 'edges', 'graphHash'], 'input');
  if (input.schemaVersion !== ADAPTIVE_GOAL_GRAPH_SCHEMA_VERSION) {
    invalid(`schemaVersion must equal ${ADAPTIVE_GOAL_GRAPH_SCHEMA_VERSION}`);
  }
  const startNodeId = identifier(input.startNodeId, 'startNodeId');
  const goalNodeId = identifier(input.goalNodeId, 'goalNodeId');
  if (!Array.isArray(input.nodes) || input.nodes.length < 1 || input.nodes.length > MAX_NODES) {
    invalid(`nodes must contain 1-${MAX_NODES} entries`);
  }
  if (!Array.isArray(input.edges) || input.edges.length > MAX_EDGES) {
    invalid(`edges must contain 0-${MAX_EDGES} entries`);
  }

  const nodes = input.nodes.map(canonicalNode);
  const ids = nodes.map(node => node.id);
  if (new Set(ids).size !== ids.length) invalid('node IDs must be unique');
  const nodeIdSet = new Set(ids);
  if (!nodeIdSet.has(startNodeId)) invalid(`startNodeId is unknown: ${startNodeId}`);
  if (!nodeIdSet.has(goalNodeId)) invalid(`goalNodeId is unknown: ${goalNodeId}`);
  if (startNodeId === goalNodeId) invalid('startNodeId and goalNodeId must identify distinct nodes');
  if (nodes.find(node => node.id === goalNodeId)?.type !== 'goal') {
    invalid(`goalNodeId must identify a node with type goal: ${goalNodeId}`);
  }

  const edges = input.edges.map(canonicalEdge);
  const edgeKeys = new Set();
  for (const edge of edges) {
    if (!nodeIdSet.has(edge.from)) invalid(`edge.from references an unknown node: ${edge.from}`);
    if (!nodeIdSet.has(edge.to)) invalid(`edge.to references an unknown node: ${edge.to}`);
    if (edge.type === RECOVERY_EDGE_TYPE) {
      for (const id of edge.condition.requiresEvidenceNodeIds) {
        if (!nodeIdSet.has(id)) invalid(`recovery condition references an unknown evidence node: ${id}`);
        if (nodes.find(node => node.id === id)?.type !== 'evidence') invalid(`recovery condition node must have type evidence: ${id}`);
        if (!nodes.find(node => node.id === id)?.evidenceRefs.length) invalid(`recovery condition evidence node requires at least one source reference: ${id}`);
      }
      for (const id of edge.condition.requiresAllNodeIds) {
        if (!nodeIdSet.has(id)) invalid(`recovery condition references an unknown prerequisite node: ${id}`);
      }
    }
    if (edge.type === 'tested_by') {
      const sourceType = nodes.find(node => node.id === edge.from)?.type;
      const targetType = nodes.find(node => node.id === edge.to)?.type;
      if (!['hypothesis', 'idea', 'candidate'].includes(sourceType) || targetType !== 'experiment') {
        invalid(`tested_by must connect a hypothesis/idea/candidate to an experiment: ${edge.from} -> ${edge.to}`);
      }
    }
    const key = `${edge.from}\u0000${edge.type}\u0000${edge.to}`;
    if (edgeKeys.has(key)) invalid(`duplicate edge: ${edge.from} ${edge.type} ${edge.to}`);
    edgeKeys.add(key);
  }
  nodes.sort((a, b) => compareStrings(a.id, b.id));
  edges.sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to) || compareStrings(a.type, b.type));

  const sortedIds = nodes.map(node => node.id);
  assertAcyclic(sortedIds, edges, new Set([...NOMINAL_TRANSITION_EDGE_TYPES, RECOVERY_EDGE_TYPE]), 'transition');
  assertAcyclic(sortedIds, edges, new Set([REQUIREMENT_EDGE_TYPE, DEPENDENCY_EDGE_TYPE]), 'prerequisite');

  const canonical = { schemaVersion: ADAPTIVE_GOAL_GRAPH_SCHEMA_VERSION, startNodeId, goalNodeId, nodes, edges };
  const graphHash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return { ...canonical, graphHash };
}

function normalizeSearchOptions(options, nodeById) {
  if (options === undefined) options = {};
  if (!isRecord(options)) invalid('search options must be an object');
  assertExactKeys(options, ['maxDepth', 'beamWidth', 'maxExpansions', 'maxAuditEvents', 'initiallyAvailableIds'], 'search options');

  const maxDepth = options.maxDepth ?? 12;
  const beamWidth = options.beamWidth ?? 8;
  const maxExpansions = options.maxExpansions ?? 128;
  const maxAuditEvents = options.maxAuditEvents ?? 2000;
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > MAX_SEARCH_DEPTH) {
    invalid(`maxDepth must be an integer between 1 and ${MAX_SEARCH_DEPTH}`);
  }
  if (!Number.isInteger(beamWidth) || beamWidth < 1 || beamWidth > MAX_BEAM_WIDTH) {
    invalid(`beamWidth must be an integer between 1 and ${MAX_BEAM_WIDTH}`);
  }
  if (!Number.isInteger(maxExpansions) || maxExpansions < 1 || maxExpansions > MAX_EXPANSIONS) {
    invalid(`maxExpansions must be an integer between 1 and ${MAX_EXPANSIONS}`);
  }
  if (!Number.isInteger(maxAuditEvents) || maxAuditEvents < 1 || maxAuditEvents > 5000) {
    invalid('maxAuditEvents must be an integer between 1 and 5000');
  }
  const initiallyAvailableIds = options.initiallyAvailableIds === undefined
    ? []
    : referenceList(options.initiallyAvailableIds, 'initiallyAvailableIds', MAX_NODES);
  for (const id of initiallyAvailableIds) {
    identifier(id, 'initiallyAvailableIds entry');
    if (!nodeById.has(id)) invalid(`initiallyAvailableIds references an unknown node: ${id}`);
  }
  return { maxDepth, beamWidth, maxExpansions, maxAuditEvents, initiallyAvailableIds };
}

function pathMetrics(pathNodeIds, nodeById) {
  const steps = pathNodeIds.slice(1).map(id => nodeById.get(id)).filter(node => node.type !== 'goal');
  const aggregate = (key, reducer) => {
    if (!steps.length || steps.some(node => node[key] === null || !Number.isFinite(node[key]))) return null;
    return reducer(steps.map(node => node[key]));
  };
  const metadataFor = key => {
    const metadata = steps.map(node => node.metricProvenance[key]);
    if (!steps.length || steps.some(node => node[key] === null)) {
      return { classification: 'unknown', sourceRefs: [], confidence: null, provenanceVerified: false };
    }
    return {
      classification: metadata.every(item => item.classification === 'caller_estimate_unverified')
        ? 'caller_estimate_unverified' : 'unknown',
      method: key === 'estimatedRisk' && steps.length
        ? '1 - product(1 - node risk); independence and calibration unverified'
        : key === 'estimatedSuccessConfidence' && steps.length
          ? 'product of node-level caller estimates; independence and calibration unverified'
          : key === 'estimatedCost' ? 'sum of node-level caller cost estimates; source and calibration unverified'
            : key === 'reusePotential' || key === 'informationValue'
              ? 'sum of caller estimates capped at 1; source and calibration unverified'
              : 'aggregate of caller-supplied unverified values',
      sourceRefs: [...new Set(metadata.flatMap(item => item.sourceRefs))].sort(compareStrings),
      confidence: metadata.every(item => typeof item.confidence === 'number')
        ? metadata.reduce((sum, item) => sum + item.confidence, 0) / metadata.length : null,
      provenanceVerified: false
    };
  };
  const estimatedRisk = aggregate('estimatedRisk', values => 1 - values.reduce((product, value) => product * (1 - value), 1));
  return {
    estimatedCost: aggregate('estimatedCost', values => values.reduce((sum, value) => sum + value, 0)),
    estimatedRisk,
    estimatedSuccessConfidence: aggregate('estimatedSuccessConfidence', values => values.reduce((product, value) => product * value, 1)),
    reusePotential: aggregate('reusePotential', values => Math.min(1, values.reduce((sum, value) => sum + value, 0))),
    informationValue: aggregate('informationValue', values => Math.min(1, values.reduce((sum, value) => sum + value, 0))),
    metricProvenance: Object.fromEntries(METRIC_KEYS.map(key => [key, metadataFor(key)]))
  };
}

function compareStringsForPath(left, right) {
  return compareStrings(left.join('\u0000'), right.join('\u0000'));
}

function compareNullable(left, right, direction) {
  const leftKnown = typeof left === 'number' && Number.isFinite(left);
  const rightKnown = typeof right === 'number' && Number.isFinite(right);
  if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
  if (!leftKnown) return 0;
  return direction * (left - right);
}

function compareStates(left, right) {
  const a = left.metrics;
  const b = right.metrics;
  return (right.isGoal - left.isGoal)
    || compareNullable(a.estimatedSuccessConfidence, b.estimatedSuccessConfidence, -1)
    || compareNullable(a.estimatedRisk, b.estimatedRisk, 1)
    || compareNullable(a.estimatedCost, b.estimatedCost, 1)
    || compareNullable(a.reusePotential, b.reusePotential, -1)
    || compareNullable(a.informationValue, b.informationValue, -1)
    || (right.semantics.testedHypothesisCount - left.semantics.testedHypothesisCount)
    || (right.semantics.supportEdgeCount - left.semantics.supportEdgeCount)
    || (left.depth - right.depth)
    || compareStringsForPath(left.pathNodeIds, right.pathNodeIds)
    || compareStringsForPath(left.pathEdgeTypes, right.pathEdgeTypes);
}

function buildPathSemanticsIndex(graph, nodeById) {
  const supportsBySource = new Map(graph.nodes.map(node => [node.id, []]));
  const testedExperimentsByHypothesis = new Map(graph.nodes.map(node => [node.id, []]));
  const conflictsByNode = new Map(graph.nodes.map(node => [node.id, []]));
  for (const edge of graph.edges) {
    if (edge.type === 'supports') supportsBySource.get(edge.from).push(edge.to);
    if (edge.type === 'tested_by' &&
        ['hypothesis', 'idea', 'candidate'].includes(nodeById.get(edge.from)?.type) &&
        nodeById.get(edge.to)?.type === 'experiment') {
      testedExperimentsByHypothesis.get(edge.from).push(edge.to);
    }
    if (edge.type === 'contradicts' || edge.type === 'alternative_to') {
      conflictsByNode.get(edge.from).push(edge.to);
      conflictsByNode.get(edge.to).push(edge.from);
    }
  }
  return { goalNodeId: graph.goalNodeId, supportsBySource, testedExperimentsByHypothesis, conflictsByNode };
}

function pathSemantics(pathNodeIds, index, nodeById) {
  const path = new Set(pathNodeIds);
  let supportEdgeCount = 0;
  let testedHypothesisCount = 0;
  let hypothesisCount = 0;
  let evidenceNodeCount = 0;
  let contradictionCount = 0;
  const evidenceRefSet = new Set();
  for (const id of pathNodeIds) {
    const node = nodeById.get(id);
    if (['hypothesis', 'idea', 'candidate'].includes(node.type)) hypothesisCount += 1;
    if (node.type === 'evidence') evidenceNodeCount += 1;
    for (const reference of node.evidenceRefs) evidenceRefSet.add(reference);
    for (const targetId of index.supportsBySource.get(id)) {
      if (path.has(targetId) || targetId === index.goalNodeId) supportEdgeCount += 1;
    }
    for (const targetId of index.testedExperimentsByHypothesis.get(id)) {
      if (path.has(targetId)) testedHypothesisCount += 1;
    }
    // Each conflict edge is indexed at both endpoints. Count it once at the
    // lexically smaller endpoint, preserving multiplicity for opposite-direction edges.
    for (const otherId of index.conflictsByNode.get(id)) {
      if (compareStrings(id, otherId) < 0 && path.has(otherId)) contradictionCount += 1;
    }
  }
  const evidenceRefs = [...evidenceRefSet].sort(compareStrings);
  return {
    supportEdgeCount,
    testedHypothesisCount,
    hypothesisCount,
    untestedHypothesisCount: Math.max(0, hypothesisCount - testedHypothesisCount),
    evidenceNodeCount,
    declaredEvidenceRefCount: evidenceRefs.length,
    unresolvedEvidenceRefCount: evidenceRefs.length,
    verifiedEvidenceRefCount: 0,
    evidenceCoverage: evidenceRefs.length ? 0 : null,
    contradictionCount
  };
}

function stateFor(pathNodeIds, pathEdgeTypes, goalNodeId, nodeById, semanticsIndex) {
  const lineage = { pathNodeIds: [...pathNodeIds], pathEdgeTypes: [...pathEdgeTypes] };
  return {
    pathNodeIds: [...pathNodeIds],
    pathEdgeTypes: [...pathEdgeTypes],
    lineages: [lineage],
    omittedLineageCount: 0,
    depth: pathNodeIds.length - 1,
    isGoal: pathNodeIds[pathNodeIds.length - 1] === goalNodeId ? 1 : 0,
    metrics: pathMetrics(pathNodeIds, nodeById),
    semantics: pathSemantics(pathNodeIds, semanticsIndex, nodeById)
  };
}

function cloneState(state) {
  return {
    ...state,
    pathNodeIds: [...state.pathNodeIds],
    pathEdgeTypes: [...state.pathEdgeTypes],
    lineages: state.lineages.map(lineage => ({
      pathNodeIds: [...lineage.pathNodeIds],
      pathEdgeTypes: [...lineage.pathEdgeTypes]
    })),
    metrics: structuredClone(state.metrics),
    semantics: { ...state.semantics }
  };
}

function lineageKey(lineage) {
  return JSON.stringify([lineage.pathNodeIds, lineage.pathEdgeTypes]);
}

function stateKey(state) {
  const current = state.pathNodeIds[state.pathNodeIds.length - 1];
  const reached = [...new Set(state.pathNodeIds)].sort(compareStrings);
  return JSON.stringify([current, reached]);
}

function addLineage(target, lineage) {
  const key = lineageKey(lineage);
  if (target.lineages.some(existing => lineageKey(existing) === key)) return;
  if (target.lineages.length >= MAX_LINEAGES_PER_STATE) {
    target.omittedLineageCount += 1;
    return;
  }
  target.lineages.push({
    pathNodeIds: [...lineage.pathNodeIds],
    pathEdgeTypes: [...lineage.pathEdgeTypes]
  });
  target.lineages.sort((a, b) =>
    compareStringsForPath(a.pathNodeIds, b.pathNodeIds)
    || compareStringsForPath(a.pathEdgeTypes, b.pathEdgeTypes));
  target.pathNodeIds = [...target.lineages[0].pathNodeIds];
  target.pathEdgeTypes = [...target.lineages[0].pathEdgeTypes];
}

function mergeState(map, state) {
  const key = stateKey(state);
  const existing = map.get(key);
  if (!existing) {
    map.set(key, state);
    return;
  }
  for (const lineage of state.lineages) addLineage(existing, lineage);
  existing.omittedLineageCount += state.omittedLineageCount;
}

function stableHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function classifyAdaptiveGoalEvidenceReference(reference) {
  if (/^(placeholder|todo|tbd|collect|missing):/i.test(reference)) return 'placeholder_not_evidence';
  if (/^file:[^#\s]+#sha256=[a-f0-9]{64}$/.test(reference)) return 'content_addressed_source_unverified';
  // `artifact://<artifact_id>` is the local MCP artifact-store URI used by the
  // runtime resolver. Recognize it as a durable-artifact reference, but never
  // infer that its content or producer lineage has been verified here.
  if (/^artifact:\/\/[A-Za-z0-9._:-]+$/.test(reference)) return 'durable_artifact_unverified';
  if (/^artifact:[A-Za-z0-9._:-]+$/.test(reference)) return 'durable_artifact_unverified';
  return 'unresolved_reference';
}

/**
 * Bind runtime resolver observations to one exact AGG candidate without
 * promoting a proposal's verification state. Source-file digests establish
 * byte identity only; durable artifact lineage establishes producer/result/
 * completion origin only. Neither establishes claim truth or an independent
 * attestation, and the current runtime does not expose an authenticated MCPB
 * archive digest, so the assessment explicitly leaves that target binding null.
 */
export function assessAdaptiveGoalCandidateEvidenceResolution({ graph: graphInput, searchResult, candidatePlanId,
  sourceEvidenceRecords = [],
  artifactEvidenceRecords = []
} = {}) {
  const graph = validateAdaptiveGoalGraph(graphInput);
  if (!isRecord(searchResult) || searchResult.graphHash !== graph.graphHash || !Array.isArray(searchResult.candidates) ||
      !isRecord(searchResult.search) || !isRecord(searchResult.search.options) ||
      typeof candidatePlanId !== 'string' || !/^agg-[a-f0-9]{24}$/.test(candidatePlanId)) {
    invalid('candidate evidence assessment must bind to a search result for the exact canonical graph');
  }
  const reproducedSearch = searchAdaptiveGoalGraph(graphInput, searchResult.search.options);
  if (JSON.stringify(reproducedSearch) !== JSON.stringify(searchResult)) {
    invalid('candidate evidence assessment refuses a search result that does not reproduce from the exact graph and options');
  }
  const matchingCandidates = searchResult.candidates.filter(item => item?.planId === candidatePlanId);
  if (matchingCandidates.length !== 1) invalid('candidate evidence assessment could not resolve one exact candidate from the graph search result');
  const candidate = matchingCandidates[0];
  const graphHash = graph.graphHash;
  if (!isRecord(candidate) || candidate.status !== 'proposed' ||
      candidate.verification?.status !== 'unverified' || candidate.verification?.verified !== false ||
      typeof candidate.planId !== 'string' || !/^agg-[a-f0-9]{24}$/.test(candidate.planId) ||
      !Array.isArray(candidate.supportingEvidenceRefs) || !Array.isArray(candidate.evidence?.ledger) ||
      candidate.evidence.verifiedReferenceCount !== 0 || candidate.evidence.semanticsVerified !== false ||
      !SHA256.test(graphHash || '')) {
    invalid('candidate evidence assessment requires an exact graph-bound, unverified complete candidate');
  }
  if (!Array.isArray(sourceEvidenceRecords) || !Array.isArray(artifactEvidenceRecords) ||
      sourceEvidenceRecords.length > 2048 || artifactEvidenceRecords.length > 2048) {
    invalid('candidate evidence resolver records must be bounded arrays');
  }

  const references = [...new Set(candidate.supportingEvidenceRefs)].sort(compareStrings);
  if (references.length !== candidate.supportingEvidenceRefs.length ||
      candidate.evidence.ledger.length !== references.length ||
      candidate.evidence.ledger.some((item, index) => !isRecord(item) || item.reference !== references[index] || item.verified !== false)) {
    invalid('candidate evidence refs and core unverified ledger do not match exactly');
  }

  function indexRecords(records, key, label) {
    const byReference = new Map();
    for (const [index, record] of records.entries()) {
      if (!isRecord(record) || typeof record[key] !== 'string' || !record[key] || byReference.has(record[key])) {
        invalid(`${label} record ${index} has a missing or duplicate reference`);
      }
      if (!references.includes(record[key]) || (label === 'source evidence' && !record[key].startsWith('file:')) ||
          (label === 'artifact evidence' && record[key].startsWith('file:'))) {
        invalid(`${label} record ${index} is outside the candidate's exact reference set`);
      }
      byReference.set(record[key], record);
    }
    return byReference;
  }
  const sources = indexRecords(sourceEvidenceRecords, 'reference', 'source evidence');
  const artifacts = indexRecords(artifactEvidenceRecords, 'reference', 'artifact evidence');
  const resolutions = [];
  let sourceIntegrityVerifiedCount = 0;
  let durableArtifactLineageVerifiedCount = 0;
  let invalidProvenanceCount = 0;
  let unresolvedReferenceCount = 0;

  for (const reference of references) {
    const artifact = artifacts.get(reference);
    if (artifact?.kind === 'durable_artifact') {
      const integrityFieldsValid = artifact.claimVerified === false && artifact.independentAttestationVerified === false &&
        typeof artifact.artifactId === 'string' && artifact.artifactId.length > 0 &&
        typeof artifact.sourceJobId === 'string' && /^job_[a-f0-9-]{36}$/.test(artifact.sourceJobId) &&
        typeof artifact.artifactType === 'string' && artifact.artifactType.length > 0 &&
        Number.isInteger(artifact.schemaVersion) && artifact.schemaVersion >= 1 &&
        SHA256.test(artifact.contentHash || '') &&
        (artifact.artifactCreatedEventId === null || (typeof artifact.artifactCreatedEventId === 'string' && artifact.artifactCreatedEventId.length > 0)) &&
        (artifact.producerRole === null || (typeof artifact.producerRole === 'string' && artifact.producerRole.length > 0)) &&
        (artifact.producerTaskId === null || (typeof artifact.producerTaskId === 'string' && artifact.producerTaskId.length > 0)) &&
        (artifact.producerTaskStatus === null || typeof artifact.producerTaskStatus === 'string') &&
        typeof artifact.producerTaskCompleted === 'boolean' &&
        typeof artifact.producerContractValid === 'boolean' && typeof artifact.lineageValid === 'boolean' &&
        (artifact.producerResultId === null || typeof artifact.producerResultId === 'string') &&
        (artifact.producerResultOutcome === null || typeof artifact.producerResultOutcome === 'string') &&
        typeof artifact.producerResultLineageValid === 'boolean' &&
        (artifact.producerCompletionEventId === null || typeof artifact.producerCompletionEventId === 'string') &&
        (artifact.producerCompletionEventType === null || typeof artifact.producerCompletionEventType === 'string');
      if (!integrityFieldsValid) invalid(`durable artifact evidence ${reference} violates the exact non-promoting resolver contract`);
      const lineageVerified = artifact.artifactStatus === 'active' && artifact.lineageValid === true &&
        artifact.producerContractValid === true && artifact.producerTaskCompleted === true &&
        artifact.producerTaskStatus === 'completed' && artifact.producerResultId !== null &&
        artifact.producerResultOutcome === 'success' && artifact.producerResultLineageValid === true &&
        artifact.producerCompletionEventId !== null &&
        ['task.completed', 'task.local_completed'].includes(artifact.producerCompletionEventType);
      if (lineageVerified) durableArtifactLineageVerifiedCount += 1;
      else invalidProvenanceCount += 1;
      resolutions.push({
        reference, kind: 'durable_artifact',
        status: lineageVerified ? 'durable_artifact_lineage_verified_claim_unverified' : 'durable_artifact_lineage_invalid',
        artifactId: artifact.artifactId, sourceJobId: artifact.sourceJobId,
        artifactType: artifact.artifactType, schemaVersion: artifact.schemaVersion,
        artifactStatus: artifact.artifactStatus, contentHash: artifact.contentHash,
        artifactCreatedEventId: artifact.artifactCreatedEventId,
        producerRole: artifact.producerRole, producerTaskId: artifact.producerTaskId,
        producerTaskStatus: artifact.producerTaskStatus, producerContractValid: artifact.producerContractValid,
        producerResultId: artifact.producerResultId, producerResultOutcome: artifact.producerResultOutcome,
        producerResultLineageValid: artifact.producerResultLineageValid,
        producerCompletionEventId: artifact.producerCompletionEventId,
        producerCompletionEventType: artifact.producerCompletionEventType,
        lineageVerified, claimVerified: false, independenceVerified: false
      });
      continue;
    }

    if (reference.startsWith('file:')) {
      const source = sources.get(reference);
      if (!source || typeof source.classification !== 'string' || typeof source.integrityVerified !== 'boolean' ||
          source.claimVerified !== false || source.independenceVerified !== false ||
          (source.expectedSha256 !== undefined && !SHA256.test(source.expectedSha256)) ||
          (source.observedSha256 !== undefined && !SHA256.test(source.observedSha256))) {
        invalid(`source evidence ${reference} violates the exact non-promoting source resolver contract`);
      }
      const bytesVerified = source.classification === 'source_bytes_verified_claim_unverified' &&
        source.integrityVerified === true && SHA256.test(source.expectedSha256 || '') &&
        source.observedSha256 === source.expectedSha256;
      if (bytesVerified) sourceIntegrityVerifiedCount += 1;
      else invalidProvenanceCount += 1;
      resolutions.push({
        reference, kind: 'source_file',
        status: bytesVerified ? 'source_integrity_only' : source.classification === 'source_hash_mismatch'
          ? 'source_hash_mismatch_or_stale' : 'source_integrity_unverified',
        classification: source.classification, integrityVerified: bytesVerified,
        expectedSha256: source.expectedSha256 ?? null, observedSha256: source.observedSha256 ?? null,
        claimVerified: false, independenceVerified: false
      });
      continue;
    }

    if (artifact && artifact.kind !== 'declared_reference') {
      invalid(`artifact evidence ${reference} has an unsupported resolver kind`);
    }
    unresolvedReferenceCount += 1;
    resolutions.push({
      reference,
      kind: artifact?.kind === 'declared_reference' ? 'declared_reference' : 'unresolved_reference',
      status: classifyAdaptiveGoalEvidenceReference(reference) === 'placeholder_not_evidence'
        ? 'placeholder_not_evidence' : 'unresolved_reference',
      classification: classifyAdaptiveGoalEvidenceReference(reference),
      resolverClassification: artifact?.classification ?? null,
      integrityVerified: false, lineageVerified: false, claimVerified: false, independenceVerified: false
    });
  }

  const declaredReferenceCount = references.length;
  const ratio = count => declaredReferenceCount ? Number((count / declaredReferenceCount).toFixed(6)) : null;
  const assessment = {
    schemaVersion: 1,
    kind: 'adaptive_goal_candidate_evidence_resolution_assessment',
    status: invalidProvenanceCount || unresolvedReferenceCount ? 'evidence_resolution_incomplete' : 'resolver_observations_complete_claims_unverified',
    targetBinding: {
      graphHash,
      candidatePlanId: candidate.planId,
      runtimeBundleSha256: null,
      runtimeBundleBinding: 'unavailable_at_mcp_runtime_boundary'
    },
    declaredReferenceCount,
    sourceIntegrityVerifiedCount,
    durableArtifactLineageVerifiedCount,
    invalidProvenanceCount,
    unresolvedReferenceCount,
    sourceIntegrityCoverage: ratio(sourceIntegrityVerifiedCount),
    durableArtifactLineageCoverage: ratio(durableArtifactLineageVerifiedCount),
    referenceResolutionCoverage: ratio(sourceIntegrityVerifiedCount + durableArtifactLineageVerifiedCount),
    claimVerifiedReferenceCount: 0,
    independentAttestationVerifiedReferenceCount: 0,
    claimCoverage: ratio(0),
    independentAttestationCoverage: ratio(0),
    candidateVerificationPreserved: true,
    candidateVerified: false,
    resolutions
  };
  assessment.assessmentHash = stableHash(JSON.stringify(assessment));
  return assessment;
}

function proposalFor(state, graph, options, nodeById) {
  const identity = JSON.stringify({
    graphHash: graph.graphHash,
    options,
    pathNodeIds: state.pathNodeIds,
    pathEdgeTypes: state.pathEdgeTypes
  });
  const evidenceRefs = [...new Set(state.pathNodeIds.flatMap(id => nodeById.get(id).evidenceRefs))].sort(compareStrings);
  const evidenceLedger = evidenceRefs.map(reference => ({ reference, classification: classifyAdaptiveGoalEvidenceReference(reference), verified: false }));
  return {
    planId: `agg-${stableHash(identity).slice(0, 24)}`,
    candidateKind: state.isGoal ? 'complete_path_candidate' : 'partial_search_state',
    status: state.isGoal ? 'proposed' : 'partial_proposal',
    pathNodeIds: [...state.pathNodeIds],
    pathEdgeTypes: [...state.pathEdgeTypes],
    alternativeLineages: state.lineages.slice(1).map(lineage => ({
      pathNodeIds: [...lineage.pathNodeIds],
      pathEdgeTypes: [...lineage.pathEdgeTypes]
    })),
    lineageCount: state.lineages.length + state.omittedLineageCount,
    lineageKind: state.lineages.length + state.omittedLineageCount > 1 ? 'convergent_state_lineages' : 'single_lineage',
    omittedLineageCount: state.omittedLineageCount,
    depth: state.depth,
    metrics: { ...state.metrics },
    supportingEvidenceRefs: evidenceRefs,
    evidence: {
      ledger: evidenceLedger,
      declaredReferenceCount: evidenceRefs.length,
      placeholderCount: evidenceLedger.filter(item => item.classification === 'placeholder_not_evidence').length,
      unresolvedReferenceCount: evidenceLedger.filter(item => ['unresolved_reference', 'placeholder_not_evidence'].includes(item.classification)).length,
      verifiedReferenceCount: 0,
      coverage: evidenceRefs.length ? 0 : null,
      semanticsVerified: false
    },
    semantics: { ...state.semantics },
    verification: { status: 'unverified', verified: false, evidenceRefs: [] }
  };
}

function hasFeasibleSuccessor(state, transitionsBySource, requirementsByTarget, availableInitially) {
  const currentId = state.pathNodeIds[state.pathNodeIds.length - 1];
  return transitionsBySource.get(currentId).some(edge => {
    if (state.pathNodeIds.includes(edge.to)) return false;
    return requirementsByTarget.get(edge.to).every(id =>
      availableInitially.has(id) || state.pathNodeIds.includes(id));
  });
}

function pathConflict(pathNodeIds, nextNodeId, conflictEdges) {
  const path = new Set(pathNodeIds);
  return conflictEdges.find(edge =>
    (edge.from === nextNodeId && path.has(edge.to)) || (edge.to === nextNodeId && path.has(edge.from))) || null;
}

/**
 * Resolve a declared recovery edge for an observed outcome. This returns only
 * a review recommendation: the supplied node-availability assertions and the
 * graph's evidence references are not an independent evidence attestation.
 * Runtime execution readiness must still validate durable artifact/result/
 * completion-event lineage before any approval or dispatch can occur.
 */
export function resolveAdaptiveGoalRecovery(input, context) {
  const graph = validateAdaptiveGoalGraph(input);
  if (!isRecord(context)) invalid('recovery context must be an object');
  assertExactKeys(context, ['sourceNodeId', 'outcome', 'availableNodeIds', 'availableEvidenceNodeIds'], 'recovery context');
  const sourceNodeId = identifier(context.sourceNodeId, 'recovery context.sourceNodeId');
  if (!graph.nodes.some(node => node.id === sourceNodeId)) invalid(`recovery source node is unknown: ${sourceNodeId}`);
  if (!RECOVERY_OUTCOMES.has(context.outcome)) invalid('recovery context.outcome is unsupported');
  const availableNodeIds = new Set(referenceList(context.availableNodeIds, 'recovery context.availableNodeIds', MAX_NODES));
  const availableEvidenceNodeIds = new Set(referenceList(context.availableEvidenceNodeIds, 'recovery context.availableEvidenceNodeIds', MAX_NODES));
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  for (const id of [...availableNodeIds, ...availableEvidenceNodeIds]) {
    if (!nodeById.has(id)) invalid(`recovery context references an unknown node: ${id}`);
  }
  for (const id of availableEvidenceNodeIds) {
    if (nodeById.get(id).type !== 'evidence') invalid(`availableEvidenceNodeIds must reference evidence nodes: ${id}`);
  }
  const edges = graph.edges.filter(edge => edge.type === RECOVERY_EDGE_TYPE && edge.from === sourceNodeId);
  const checks = edges.map(edge => {
    const blockers = [];
    if (edge.condition.onOutcome !== context.outcome) blockers.push({ code: 'RECOVERY_OUTCOME_MISMATCH', expected: edge.condition.onOutcome, observed: context.outcome });
    const missingNodes = edge.condition.requiresAllNodeIds.filter(id => !availableNodeIds.has(id));
    if (missingNodes.length) blockers.push({ code: 'RECOVERY_PREREQUISITES_MISSING', nodeIds: missingNodes });
    const missingEvidence = edge.condition.requiresEvidenceNodeIds.filter(id => !availableEvidenceNodeIds.has(id));
    if (missingEvidence.length) blockers.push({ code: 'RECOVERY_EVIDENCE_PREREQUISITES_MISSING', nodeIds: missingEvidence });
    return {
      edge: { from: edge.from, to: edge.to, type: edge.type, condition: structuredClone(edge.condition) },
      eligibleForReview: blockers.length === 0,
      blockers
    };
  });
  const eligible = checks.filter(check => check.eligibleForReview);
  return {
    schemaVersion: ADAPTIVE_GOAL_GRAPH_SCHEMA_VERSION,
    mode: 'shadow',
    status: eligible.length ? 'recovery_options_found' : 'recovery_blocked',
    sourceNodeId,
    observedOutcome: context.outcome,
    options: eligible,
    rejectedOptions: checks.filter(check => !check.eligibleForReview),
    recoveryEdgeCount: edges.length,
    evidenceVerification: 'not_independently_verified',
    executionAuthorized: false,
    dispatchAllowed: false,
    note: 'Eligibility is a planning result only. It does not prove task outcome or evidence truth; durable artifact/result/completion-event lineage and all existing workflow gates remain mandatory.'
  };
}

/**
 * Search the graph without side effects. This function only proposes paths.
 * Ranking is a documented lexicographic heuristic, not an optimality proof.
 */
export function searchAdaptiveGoalGraph(input, options, onAuditEvent = null) {
  const graph = validateAdaptiveGoalGraph(input);
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const searchOptions = normalizeSearchOptions(options, nodeById);
  const availableInitially = new Set(searchOptions.initiallyAvailableIds);
  const requirementsByTarget = new Map(graph.nodes.map(node => [node.id, []]));
  const transitionsBySource = new Map(graph.nodes.map(node => [node.id, []]));
  const conflicts = graph.edges.filter(edge => ['contradicts', 'alternative_to'].includes(edge.type));
  const auditEvents = [];
  const prunedBranches = [];
  let auditEventCount = 0;
  let omittedAuditEventCount = 0;
  let omittedPrunedBranchCount = 0;
  const counters = {
    expandedStates: 0,
    evaluatedEdges: 0,
    generatedLineageStates: 0,
    rejectedCycles: 0,
    rejectedPrerequisites: 0,
    rejectedContradictions: 0,
    prunedByBeamWidth: 0,
    deferredRecoveryEdges: 0
  };
  const recordAudit = event => {
    auditEventCount += 1;
    if (auditEvents.length < searchOptions.maxAuditEvents) {
      const recorded = { sequence: auditEventCount, ...event };
      auditEvents.push(recorded);
      if (typeof onAuditEvent === 'function') onAuditEvent({ ...recorded, observedAt: new Date().toISOString() });
    } else omittedAuditEventCount += 1;
  };
  const recordPruned = branch => {
    if (prunedBranches.length < searchOptions.maxAuditEvents) prunedBranches.push(branch);
    else omittedPrunedBranchCount += 1;
  };

  for (const edge of graph.edges) {
    if (edge.type === REQUIREMENT_EDGE_TYPE) requirementsByTarget.get(edge.to).push(edge.from);
    if (edge.type === DEPENDENCY_EDGE_TYPE) requirementsByTarget.get(edge.from).push(edge.to);
    if (NOMINAL_TRANSITION_EDGE_TYPES.has(edge.type)) transitionsBySource.get(edge.from).push(edge);
    if (edge.type === RECOVERY_EDGE_TYPE) counters.deferredRecoveryEdges += 1;
  }
  for (const required of requirementsByTarget.values()) required.sort(compareStrings);
  for (const transitions of transitionsBySource.values()) {
    transitions.sort((a, b) => compareStrings(a.to, b.to) || compareStrings(a.type, b.type));
  }

  const semanticsIndex = buildPathSemanticsIndex(graph, nodeById);
  const searchRunId = stableHash(JSON.stringify({ graphHash: graph.graphHash, options: searchOptions }));
  const initial = stateFor([graph.startNodeId], [], graph.goalNodeId, nodeById, semanticsIndex);
  let beam = initial.isGoal ? [] : [initial];
  const complete = new Map();
  const partial = new Map();
  if (initial.isGoal) mergeState(complete, initial);
  else mergeState(partial, initial);

  let expansions = 0;
  let generatedStates = 1;
  let prunedStates = 0;
  let budgetExhausted = false;
  let maxDepthReached = false;
  let exploredDepth = 0;

  while (beam.length) {
    if (beam.every(state => state.depth >= searchOptions.maxDepth)) {
      maxDepthReached = beam.some(state =>
        hasFeasibleSuccessor(state, transitionsBySource, requirementsByTarget, availableInitially));
      break;
    }
    const nextStates = new Map();
    const orderedBeam = [...beam].sort(compareStates);
    let stopForBudget = false;

    for (const state of orderedBeam) {
      counters.expandedStates += 1;
      recordAudit({
        type: 'state_expanded', currentNodeId: state.pathNodeIds.at(-1), depth: state.depth,
        pathNodeIds: [...state.pathNodeIds], pathEdgeTypes: [...state.pathEdgeTypes],
        lineageCount: state.lineages.length + state.omittedLineageCount, metrics: structuredClone(state.metrics)
      });
      if (state.isGoal) continue;
      const currentId = state.pathNodeIds[state.pathNodeIds.length - 1];
      const outgoing = transitionsBySource.get(currentId);
      if (state.depth >= searchOptions.maxDepth) {
        if (hasFeasibleSuccessor(state, transitionsBySource, requirementsByTarget, availableInitially)) {
          maxDepthReached = true;
        }
        continue;
      }
      for (const edge of outgoing) {
        if (expansions >= searchOptions.maxExpansions) {
          budgetExhausted = true;
          stopForBudget = true;
          recordAudit({ type: 'search_stopped', reason: 'max_expansions', maxExpansions: searchOptions.maxExpansions });
          break;
        }
        expansions += 1;
        counters.evaluatedEdges += 1;
        const required = requirementsByTarget.get(edge.to);

        // Equivalent reached-node sets have identical successor possibilities.
        // Expand each retained lineage while carrying omitted-lineage counts once
        // per outgoing edge rather than once per retained representative.
        let inheritedLineagesAccounted = false;
        for (const lineage of state.lineages) {
          if (lineage.pathNodeIds.includes(edge.to)) {
            counters.rejectedCycles += 1;
            recordAudit({ type: 'edge_rejected', fromNodeId: currentId, toNodeId: edge.to, edgeType: edge.type,
              reason: 'would_repeat_node', pathNodeIds: [...lineage.pathNodeIds] });
            continue;
          }
          const satisfied = required.every(id =>
            availableInitially.has(id) || lineage.pathNodeIds.includes(id));
          if (!satisfied) {
            counters.rejectedPrerequisites += 1;
            recordAudit({ type: 'edge_rejected', fromNodeId: currentId, toNodeId: edge.to, edgeType: edge.type,
              reason: 'prerequisite_missing', missingPrerequisiteNodeIds: required.filter(id =>
                !availableInitially.has(id) && !lineage.pathNodeIds.includes(id)), pathNodeIds: [...lineage.pathNodeIds] });
            continue;
          }
          const conflict = pathConflict(lineage.pathNodeIds, edge.to, conflicts);
          if (conflict) {
            counters.rejectedContradictions += 1;
            recordAudit({ type: 'edge_rejected', fromNodeId: currentId, toNodeId: edge.to, edgeType: edge.type,
              reason: conflict.type === 'contradicts' ? 'contradictory_nodes_in_same_candidate' : 'mutually_exclusive_alternatives_in_same_candidate',
              conflictingEdge: { from: conflict.from, to: conflict.to, type: conflict.type }, pathNodeIds: [...lineage.pathNodeIds] });
            continue;
          }

          const next = stateFor(
            [...lineage.pathNodeIds, edge.to],
            [...lineage.pathEdgeTypes, edge.type],
            graph.goalNodeId,
            nodeById,
            semanticsIndex
          );
          if (!inheritedLineagesAccounted) {
            next.omittedLineageCount = state.omittedLineageCount;
            inheritedLineagesAccounted = true;
          }
          generatedStates += 1;
          counters.generatedLineageStates += 1;
          recordAudit({ type: 'state_generated', fromNodeId: currentId, toNodeId: edge.to, edgeType: edge.type,
            pathNodeIds: [...next.pathNodeIds], pathEdgeTypes: [...next.pathEdgeTypes], depth: next.depth,
            candidateKind: next.isGoal ? 'complete_path_candidate' : 'frontier_state', metrics: structuredClone(next.metrics), semantics: { ...next.semantics } });
          if (next.isGoal) mergeState(complete, next);
          else {
            // These maps summarize the same logical states independently. Do
            // not share a mutable object: overflowed lineages would otherwise
            // be counted once in each map and inflate omittedLineageCount.
            mergeState(partial, cloneState(next));
            mergeState(nextStates, next);
          }
        }
      }
      if (stopForBudget) break;
    }

    if (stopForBudget) break;
    if (!nextStates.size) {
      beam = [];
      break;
    }
    const orderedNext = [...nextStates.values()].sort(compareStates);
    orderedNext.forEach((state, index) => recordAudit({ type: index < searchOptions.beamWidth ? 'frontier_selected' : 'frontier_pruned',
      rank: index + 1, currentNodeId: state.pathNodeIds.at(-1), depth: state.depth, pathNodeIds: [...state.pathNodeIds],
      pathEdgeTypes: [...state.pathEdgeTypes], metrics: structuredClone(state.metrics), semantics: { ...state.semantics },
      ...(index < searchOptions.beamWidth ? {} : { reason: 'beam_width_exceeded', beamWidth: searchOptions.beamWidth }) }));
    const frontierPruned = orderedNext.slice(searchOptions.beamWidth);
    prunedStates += frontierPruned.length;
    counters.prunedByBeamWidth += frontierPruned.length;
    frontierPruned.forEach((state, index) => recordPruned({ rank: searchOptions.beamWidth + index + 1,
      reason: 'beam_width_exceeded', beamWidth: searchOptions.beamWidth,
      currentNodeId: state.pathNodeIds.at(-1), pathNodeIds: [...state.pathNodeIds], pathEdgeTypes: [...state.pathEdgeTypes],
      metrics: structuredClone(state.metrics), candidateKind: 'frontier_state' }));
    beam = orderedNext.slice(0, searchOptions.beamWidth);
    for (const state of beam) exploredDepth = Math.max(exploredDepth, state.depth);
  }

  const allComplete = [...complete.values()].sort(compareStates);
  if (allComplete.length > searchOptions.beamWidth) {
    prunedStates += allComplete.length - searchOptions.beamWidth;
    counters.prunedByBeamWidth += allComplete.length - searchOptions.beamWidth;
  }
  allComplete.slice(searchOptions.beamWidth).forEach((state, index) => {
    recordAudit({ type: 'candidate_pruned', rank: searchOptions.beamWidth + index + 1,
      pathNodeIds: [...state.pathNodeIds], pathEdgeTypes: [...state.pathEdgeTypes],
      reason: 'completed_candidate_limit', beamWidth: searchOptions.beamWidth, metrics: structuredClone(state.metrics) });
    recordPruned({ rank: searchOptions.beamWidth + index + 1, reason: 'completed_candidate_limit', beamWidth: searchOptions.beamWidth,
      currentNodeId: graph.goalNodeId, pathNodeIds: [...state.pathNodeIds], pathEdgeTypes: [...state.pathEdgeTypes],
      metrics: structuredClone(state.metrics), candidateKind: 'complete_path_candidate' });
  });
  const orderedComplete = allComplete.slice(0, searchOptions.beamWidth);
  const orderedPartial = [...partial.values()]
    .filter(state => !state.isGoal)
    .sort(compareStates)
    .slice(0, Math.min(5, searchOptions.beamWidth));
  const lineagePruned = [...partial.values(), ...complete.values()]
    .some(state => state.omittedLineageCount > 0);

  let terminationReason;
  if (initial.isGoal) terminationReason = 'start_is_goal';
  else if (budgetExhausted) terminationReason = 'max_expansions';
  else if (maxDepthReached) terminationReason = 'max_depth';
  else if (prunedStates > 0 || lineagePruned) terminationReason = 'frontier_exhausted_with_pruning';
  else terminationReason = 'frontier_exhausted';

  let status;
  if (budgetExhausted) status = 'budget_exhausted';
  else if (maxDepthReached) status = 'max_depth_reached';
  else if (orderedComplete.length) status = 'proposals_found';
  else status = 'no_solution_found';

  return {
    schemaVersion: ADAPTIVE_GOAL_GRAPH_SCHEMA_VERSION,
    mode: 'shadow',
    status,
    startNodeId: graph.startNodeId,
    goalNodeId: graph.goalNodeId,
    graphHash: graph.graphHash,
    candidates: orderedComplete.map(state => proposalFor(state, graph, searchOptions, nodeById)),
    bestPartialCandidates: orderedPartial.map(state => proposalFor(state, graph, searchOptions, nodeById)),
    search: {
      options: searchOptions,
      expansions,
      generatedStates,
      prunedStates,
      exploredDepth,
      terminationReason,
      exhaustive: !budgetExhausted && !maxDepthReached && prunedStates === 0 && !lineagePruned,
      searchRunId,
      outcomeMode: 'nominal_success_path',
      heuristicVersion: 'lexicographic-unknown-aware@2',
      conditionalRecoveryEdgesExcluded: counters.deferredRecoveryEdges
    },
    auditTrace: {
      schemaVersion: 1,
      searchRunId,
      deterministic: true,
      heuristicVersion: 'lexicographic-unknown-aware@2',
      ordering: ['goal_first', 'known_success_confidence_desc', 'known_risk_asc', 'known_cost_asc', 'known_reuse_desc', 'known_information_desc', 'tested_hypotheses_desc', 'support_edges_desc', 'depth_asc', 'lexical_path'],
      events: auditEvents,
      eventCount: auditEventCount,
      truncated: omittedAuditEventCount > 0,
      omittedEventCount: omittedAuditEventCount,
      prunedBranches,
      omittedPrunedBranchCount,
      counters
    }
  };
}
