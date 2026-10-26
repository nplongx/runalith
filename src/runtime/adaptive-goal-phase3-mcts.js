import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';
import { validateAdaptiveGoalGraph } from './adaptive-goal-graph.js';
import {
  extractAdaptiveGoalDiscriminatorFeatures,
  scoreAdaptiveGoalDiscriminator,
  validateAdaptiveGoalDiscriminatorModel
} from './adaptive-goal-discriminator.js';

const MAX_SIMULATIONS = 10_000;
const MAX_EXPANSIONS = 10_000;
const MAX_WORK_UNITS = 1_000_000;
const MAX_DEPTH = 100;
const MAX_AUDIT_EVENTS = 5_000;
const MAX_CANDIDATES = 100;
const MAX_TREE_NODES = MAX_EXPANSIONS + 1;
const MAX_TERMINAL_PATHS = 10_000;
const NOMINAL_EDGE_TYPES = new Set(['next_step', 'enables']);
const CONFLICT_EDGE_TYPES = new Set(['contradicts', 'alternative_to']);
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');

function invalid(message) {
  throw new TypeError(`AdaptiveGoalPhase3MCTS: ${message}`);
}

function normalizeOptions(options, nodeById) {
  if (options === undefined) options = {};
  if (!options || typeof options !== 'object' || Array.isArray(options)) invalid('options must be an object');
  const allowed = [
    'maxSimulations', 'maxDepth', 'maxExpansions', 'maxWorkUnits', 'maxAuditEvents',
    'candidateLimit', 'maxTreeNodes', 'maxTerminalPaths', 'explorationConstant', 'seed', 'initiallyAvailableIds'
  ];
  const extra = Object.keys(options).filter(key => !allowed.includes(key));
  if (extra.length) invalid(`unsupported options: ${extra.sort().join(', ')}`);
  const normalized = {
    maxSimulations: options.maxSimulations ?? 128,
    maxDepth: options.maxDepth ?? 12,
    maxExpansions: options.maxExpansions ?? 128,
    maxWorkUnits: options.maxWorkUnits ?? 100_000,
    maxAuditEvents: options.maxAuditEvents ?? 2000,
    candidateLimit: options.candidateLimit ?? 4,
    maxTreeNodes: options.maxTreeNodes ?? 2048,
    maxTerminalPaths: options.maxTerminalPaths ?? 2048,
    explorationConstant: options.explorationConstant ?? Math.SQRT2,
    seed: options.seed ?? 0,
    initiallyAvailableIds: options.initiallyAvailableIds ?? []
  };
  if (!Number.isInteger(normalized.maxSimulations) || normalized.maxSimulations < 1 || normalized.maxSimulations > MAX_SIMULATIONS) {
    invalid(`maxSimulations must be an integer in [1, ${MAX_SIMULATIONS}]`);
  }
  if (!Number.isInteger(normalized.maxDepth) || normalized.maxDepth < 1 || normalized.maxDepth > MAX_DEPTH) {
    invalid(`maxDepth must be an integer in [1, ${MAX_DEPTH}]`);
  }
  if (!Number.isInteger(normalized.maxExpansions) || normalized.maxExpansions < 1 || normalized.maxExpansions > MAX_EXPANSIONS) {
    invalid(`maxExpansions must be an integer in [1, ${MAX_EXPANSIONS}]`);
  }
  if (!Number.isInteger(normalized.maxWorkUnits) || normalized.maxWorkUnits < 2 || normalized.maxWorkUnits > MAX_WORK_UNITS) {
    invalid(`maxWorkUnits must be an integer in [2, ${MAX_WORK_UNITS}]`);
  }
  if (!Number.isInteger(normalized.maxAuditEvents) || normalized.maxAuditEvents < 1 || normalized.maxAuditEvents > MAX_AUDIT_EVENTS) {
    invalid(`maxAuditEvents must be an integer in [1, ${MAX_AUDIT_EVENTS}]`);
  }
  if (!Number.isInteger(normalized.candidateLimit) || normalized.candidateLimit < 1 || normalized.candidateLimit > MAX_CANDIDATES) {
    invalid(`candidateLimit must be an integer in [1, ${MAX_CANDIDATES}]`);
  }
  if (!Number.isInteger(normalized.maxTreeNodes) || normalized.maxTreeNodes < 1 || normalized.maxTreeNodes > MAX_TREE_NODES) {
    invalid(`maxTreeNodes must be an integer in [1, ${MAX_TREE_NODES}]`);
  }
  if (!Number.isInteger(normalized.maxTerminalPaths) || normalized.maxTerminalPaths < 1 || normalized.maxTerminalPaths > MAX_TERMINAL_PATHS) {
    invalid(`maxTerminalPaths must be an integer in [1, ${MAX_TERMINAL_PATHS}]`);
  }
  if (typeof normalized.explorationConstant !== 'number' || !Number.isFinite(normalized.explorationConstant) ||
      normalized.explorationConstant < 0 || normalized.explorationConstant > 10) {
    invalid('explorationConstant must be finite and in [0, 10]');
  }
  if (!Number.isSafeInteger(normalized.seed) || normalized.seed < 0) invalid('seed must be a non-negative safe integer');
  if (!Array.isArray(normalized.initiallyAvailableIds) || new Set(normalized.initiallyAvailableIds).size !== normalized.initiallyAvailableIds.length ||
      normalized.initiallyAvailableIds.some(id => typeof id !== 'string' || !nodeById.has(id))) {
    invalid('initiallyAvailableIds must contain unique known node IDs');
  }
  normalized.initiallyAvailableIds = [...normalized.initiallyAvailableIds].sort(compareText);
  return normalized;
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

function pathSemantics(pathNodeIds, nodeById, semanticsIndex) {
  const pathSet = new Set(pathNodeIds);
  const hypothesisIds = pathNodeIds.filter(id => ['hypothesis', 'idea', 'candidate'].includes(nodeById.get(id)?.type));
  const testedHypothesisCount = hypothesisIds.filter(id => (semanticsIndex.testedBy.get(id) || []).some(target => pathSet.has(target))).length;
  let supportEdgeCount = 0;
  for (const id of pathNodeIds) supportEdgeCount += (semanticsIndex.supports.get(id) || []).filter(target => pathSet.has(target)).length;
  return { hypothesisCount: hypothesisIds.length, testedHypothesisCount, supportEdgeCount };
}

function makeState(pathNodeIds, pathEdgeTypes, graph, nodeById, model, semanticsIndex, chargeWork) {
  // path metrics, feature extraction and the indexed relation checks scale with path length.
  if (!chargeWork(pathNodeIds.length + 1, 'state_score')) return null;
  const state = {
    pathNodeIds: [...pathNodeIds],
    pathEdgeTypes: [...pathEdgeTypes],
    depth: pathNodeIds.length - 1,
    isGoal: pathNodeIds.at(-1) === graph.goalNodeId,
    metrics: pathMetrics(pathNodeIds, nodeById),
    semantics: pathSemantics(pathNodeIds, nodeById, semanticsIndex)
  };
  state.discriminator = scoreAdaptiveGoalDiscriminator(model, extractAdaptiveGoalDiscriminatorFeatures(state));
  return state;
}

function createPrng(seed) {
  let counter = 0;
  return () => {
    const bytes = createHash('sha256').update(`agg-phase3-mcts|${seed}|${counter++}`).digest();
    return bytes.readUIntBE(0, 6) / 0x1_0000_0000_0000;
  };
}

function pathKey(pathNodeIds, pathEdgeTypes) {
  return JSON.stringify([pathNodeIds, pathEdgeTypes]);
}

/**
 * Bounded, deterministic-seeded Monte Carlo Tree Search over nominal Idea Graph
 * transitions. The learned discriminator is advisory value guidance, not evidence
 * that a path is safe, true, executable, or authorized.
 */
export function searchAdaptiveGoalGraphPhase3MCTS(graphInput, modelInput, optionsInput = {}, onAuditEvent = null) {
  const graph = validateAdaptiveGoalGraph(graphInput);
  const model = validateAdaptiveGoalDiscriminatorModel(modelInput);
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const options = normalizeOptions(optionsInput, nodeById);
  const initiallyAvailable = new Set(options.initiallyAvailableIds);
  const transitions = new Map(graph.nodes.map(node => [node.id, []]));
  const requirements = new Map(graph.nodes.map(node => [node.id, []]));
  const conflictsByNode = new Map(graph.nodes.map(node => [node.id, []]));
  const semanticsIndex = {
    testedBy: new Map(graph.nodes.map(node => [node.id, []])),
    supports: new Map(graph.nodes.map(node => [node.id, []]))
  };
  for (const edge of graph.edges) {
    if (NOMINAL_EDGE_TYPES.has(edge.type)) transitions.get(edge.from).push(edge);
    if (edge.type === 'requires_all') requirements.get(edge.to).push(edge.from);
    if (edge.type === 'depends_on') requirements.get(edge.from).push(edge.to);
    if (CONFLICT_EDGE_TYPES.has(edge.type)) {
      conflictsByNode.get(edge.from).push({ other: edge.to, type: edge.type });
      conflictsByNode.get(edge.to).push({ other: edge.from, type: edge.type });
    }
    if (edge.type === 'tested_by') semanticsIndex.testedBy.get(edge.from).push(edge.to);
    if (edge.type === 'supports') semanticsIndex.supports.get(edge.from).push(edge.to);
  }
  for (const list of transitions.values()) list.sort((a, b) => compareText(a.to, b.to) || compareText(a.type, b.type));
  for (const list of requirements.values()) list.sort(compareText);

  const random = createPrng(options.seed);
  const auditEvents = [];
  let auditEventCount = 0;
  let omittedAuditEventCount = 0;
  const recordAudit = event => {
    auditEventCount++;
    if (auditEvents.length < options.maxAuditEvents) {
      auditEvents.push(event);
      if (typeof onAuditEvent === 'function') onAuditEvent({ ...event, sequence: auditEventCount, observedAt: new Date().toISOString() });
    } else omittedAuditEventCount++;
  };
  let expansions = 0;
  let workUnits = 0;
  let simulations = 0;
  let generatedStates = 1;
  let terminalPathsOmitted = 0;
  let successfulRollouts = 0;
  let expansionBudgetExhausted = false;
  let workBudgetExhausted = false;
  let treeNodeBudgetExhausted = false;
  let terminalPathLimitReached = false;
  let maxDepthReached = false;
  const chargeWork = (units, stage) => {
    if (workBudgetExhausted) return false;
    if (!Number.isSafeInteger(units) || units < 0 || workUnits + units > options.maxWorkUnits) {
      workBudgetExhausted = true;
      recordAudit({ type: 'budget_exhausted', budget: 'maxWorkUnits', limit: options.maxWorkUnits, stage, workUnits });
      return false;
    }
    workUnits += units;
    return true;
  };
  const hasBudgetExhausted = () => expansionBudgetExhausted || workBudgetExhausted || treeNodeBudgetExhausted || terminalPathLimitReached;

  const legalTransitions = (pathNodeIds, fromNodeId, stage) => {
    const available = new Set([...initiallyAvailable, ...pathNodeIds]);
    const successors = [];
    for (const edge of transitions.get(fromNodeId)) {
      if (expansions >= options.maxExpansions) {
        expansionBudgetExhausted = true;
        recordAudit({ type: 'budget_exhausted', budget: 'maxExpansions', limit: options.maxExpansions, stage });
        break;
      }
      const workCost = 1 + pathNodeIds.length + requirements.get(edge.to).length + conflictsByNode.get(edge.to).length;
      if (!chargeWork(workCost, stage)) break;
      expansions++;
      if (pathNodeIds.includes(edge.to)) {
        recordAudit({ type: 'edge_rejected', stage, from: edge.from, to: edge.to, reason: 'would_repeat_node' });
        continue;
      }
      const missing = requirements.get(edge.to).filter(id => !available.has(id));
      if (missing.length) {
        recordAudit({ type: 'edge_rejected', stage, from: edge.from, to: edge.to, reason: 'prerequisite_missing', missingPrerequisiteNodeIds: missing });
        continue;
      }
      const conflict = conflictsByNode.get(edge.to).find(item => pathNodeIds.includes(item.other));
      if (conflict) {
        recordAudit({ type: 'edge_rejected', stage, from: edge.from, to: edge.to, reason: conflict.type, conflictingNodeId: conflict.other });
        continue;
      }
      successors.push(edge);
    }
    return successors;
  };

  const makeTreeNode = (pathNodeIds, pathEdgeTypes, parent = null) => {
    const state = makeState(pathNodeIds, pathEdgeTypes, graph, nodeById, model, semanticsIndex, chargeWork);
    if (!state) return null;
    return {
      ...state, parent, children: [], unvisitedChildren: [], successorsGenerated: false,
      visits: 0, totalReward: 0, meanReward: 0
    };
  };
  const root = makeTreeNode([graph.startNodeId], []);
  if (!root) invalid('maxWorkUnits is too small to score the root state');
  const completePaths = new Map();
  const partialPaths = new Map();
  const rememberPath = (map, state, probability) => {
    const key = pathKey(state.pathNodeIds, state.pathEdgeTypes);
    const previous = map.get(key);
    if (previous) {
      previous.visits++;
      previous.probabilityTotal += probability;
      previous.meanProbability = previous.probabilityTotal / previous.visits;
    } else {
      if (completePaths.size + partialPaths.size >= options.maxTerminalPaths) {
        terminalPathsOmitted++;
        terminalPathLimitReached = true;
        recordAudit({ type: 'terminal_path_not_retained', pathNodeIds: [...state.pathNodeIds], reason: 'maxTerminalPaths', limit: options.maxTerminalPaths });
        return;
      }
      map.set(key, {
        pathNodeIds: [...state.pathNodeIds], pathEdgeTypes: [...state.pathEdgeTypes],
        depth: state.depth, visits: 1, probabilityTotal: probability, meanProbability: probability,
        metrics: { ...state.metrics }, semantics: { ...state.semantics }, discriminator: { ...state.discriminator }
      });
    }
  };
  const rewardFor = state => state.isGoal ? 0.75 + 0.25 * state.discriminator.probability : 0.25 * state.discriminator.probability;

  const generateTreeChildren = node => {
    if (node.successorsGenerated) return;
    node.successorsGenerated = true;
    const successors = legalTransitions(node.pathNodeIds, node.pathNodeIds.at(-1), 'tree');
    for (const edge of successors) {
      if (generatedStates >= options.maxTreeNodes) {
        treeNodeBudgetExhausted = true;
        recordAudit({ type: 'budget_exhausted', budget: 'maxTreeNodes', limit: options.maxTreeNodes, stage: 'tree' });
        break;
      }
      const child = makeTreeNode([...node.pathNodeIds, edge.to], [...node.pathEdgeTypes, edge.type], node);
      if (!child) break;
      node.children.push(child);
      node.unvisitedChildren.push(child);
      generatedStates++;
      recordAudit({ type: 'state_expanded', stage: 'tree', pathNodeIds: child.pathNodeIds,
        discriminatorProbability: child.discriminator.probability, modelSha256: model.modelSha256 });
    }
  };

  const selectUctChild = parent => {
    const n = parent.children.length;
    const comparisonWorkEstimate = Math.max(1, n * Math.ceil(Math.log2(Math.max(2, n))) + n);
    if (!chargeWork(comparisonWorkEstimate, 'uct_select')) return null;
    const logParent = Math.log(Math.max(1, parent.visits));
    return [...parent.children].sort((left, right) => {
      const leftUct = left.meanReward + options.explorationConstant * Math.sqrt(logParent / Math.max(1, left.visits))
        + ((left.discriminator.probability - 0.5) * 0.25) / (left.visits + 1);
      const rightUct = right.meanReward + options.explorationConstant * Math.sqrt(logParent / Math.max(1, right.visits))
        + ((right.discriminator.probability - 0.5) * 0.25) / (right.visits + 1);
      return rightUct - leftUct || compareText(pathKey(left.pathNodeIds, left.pathEdgeTypes), pathKey(right.pathNodeIds, right.pathEdgeTypes));
    })[0];
  };

  const rollout = startState => {
    let pathNodeIds = [...startState.pathNodeIds];
    let pathEdgeTypes = [...startState.pathEdgeTypes];
    let state = startState;
    while (!hasBudgetExhausted() && !state.isGoal && state.depth < options.maxDepth) {
      const successors = legalTransitions(pathNodeIds, pathNodeIds.at(-1), 'rollout');
      if (hasBudgetExhausted()) break;
      if (!successors.length) {
        break;
      }
      const edge = successors[Math.floor(random() * successors.length)];
      const nextPathNodeIds = [...pathNodeIds, edge.to];
      const nextPathEdgeTypes = [...pathEdgeTypes, edge.type];
      const nextState = makeState(nextPathNodeIds, nextPathEdgeTypes, graph, nodeById, model, semanticsIndex, chargeWork);
      if (!nextState) break;
      pathNodeIds = nextPathNodeIds;
      pathEdgeTypes = nextPathEdgeTypes;
      state = nextState;
      recordAudit({ type: 'rollout_step', pathNodeIds: [...pathNodeIds], discriminatorProbability: state.discriminator.probability });
      if (hasBudgetExhausted()) break;
    }
    if (!hasBudgetExhausted() && !state.isGoal && state.depth >= options.maxDepth && transitions.get(pathNodeIds.at(-1)).length) {
      // A raw outgoing edge is not enough to claim depth exhaustion: every
      // continuation may still be disallowed by prerequisites or conflicts.
      const feasibleBeyondDepth = legalTransitions(pathNodeIds, pathNodeIds.at(-1), 'depth_check');
      if (feasibleBeyondDepth.length) maxDepthReached = true;
    }
    if (state.isGoal) {
      successfulRollouts++;
      rememberPath(completePaths, state, state.discriminator.probability);
    } else {
      rememberPath(partialPaths, state, state.discriminator.probability);
    }
    return { state, reward: rewardFor(state) };
  };

  if (root.isGoal) {
    rememberPath(completePaths, root, root.discriminator.probability);
    root.visits = 1;
    root.meanReward = rewardFor(root);
    simulations = 1;
    successfulRollouts = 1;
  } else {
    for (let simulation = 0; simulation < options.maxSimulations; simulation++) {
      if (hasBudgetExhausted()) break;
      let node = root;
      while (!hasBudgetExhausted() && !node.isGoal && node.depth < options.maxDepth) {
        generateTreeChildren(node);
        if (hasBudgetExhausted()) break;
        if (!node.children.length) break;
        if (node.unvisitedChildren.length) {
          const index = Math.floor(random() * node.unvisitedChildren.length);
          node = node.unvisitedChildren.splice(index, 1)[0];
          recordAudit({ type: 'uct_expand', simulation: simulation + 1, pathNodeIds: [...node.pathNodeIds],
            unvisitedChildrenRemaining: node.unvisitedChildren.length });
          break;
        }
        const selected = selectUctChild(node);
        if (!selected) break;
        node = selected;
        recordAudit({ type: 'uct_select', simulation: simulation + 1, pathNodeIds: [...node.pathNodeIds],
          visits: node.visits, meanReward: node.meanReward });
      }
      if (!chargeWork(node.depth + 1, 'backpropagation')) break;
      const result = rollout(node);
      simulations++;
      recordAudit({ type: 'simulation_complete', simulation: simulations, terminalPathNodeIds: result.state.pathNodeIds,
        reachedGoal: result.state.isGoal, reward: result.reward, discriminatorProbability: result.state.discriminator.probability });
      for (let cursor = node; cursor; cursor = cursor.parent) {
        cursor.visits++;
        cursor.totalReward += result.reward;
        cursor.meanReward = cursor.totalReward / cursor.visits;
      }
      if (hasBudgetExhausted()) break;
    }
  }

  const candidateFromPath = (path, isGoal) => {
    const identity = { graphHash: graph.graphHash, pathNodeIds: path.pathNodeIds, pathEdgeTypes: path.pathEdgeTypes, options, modelSha256: model.modelSha256 };
    return {
      planId: `agg-p3-${sha256(identity).slice(0, 24)}`,
      candidateKind: isGoal ? 'complete_path_candidate' : 'partial_search_state',
      status: isGoal ? 'proposed' : 'partial_proposal',
      pathNodeIds: [...path.pathNodeIds], pathEdgeTypes: [...path.pathEdgeTypes], depth: path.depth,
      visitCount: path.visits, meanDiscriminatorProbability: path.meanProbability,
      metrics: { ...path.metrics }, discriminator: { ...path.discriminator },
      verification: { status: 'unverified', verified: false },
      execution: { enabled: false, authorized: false, dispatched: false },
      provenance: { graphHash: graph.graphHash, modelSha256: model.modelSha256,
        rankingMode: 'discriminator_mcts_uct', acceptance: 'offline_shadow_not_acceptance', seed: options.seed }
    };
  };
  const rankedComplete = [...completePaths.values()].sort((left, right) => right.visits - left.visits ||
    right.meanProbability - left.meanProbability || left.depth - right.depth ||
    compareText(pathKey(left.pathNodeIds, left.pathEdgeTypes), pathKey(right.pathNodeIds, right.pathEdgeTypes)))
    .slice(0, options.candidateLimit).map(path => candidateFromPath(path, true));
  const rankedPartial = [...partialPaths.values()].sort((left, right) => right.visits - left.visits ||
    right.meanProbability - left.meanProbability || left.depth - right.depth ||
    compareText(pathKey(left.pathNodeIds, left.pathEdgeTypes), pathKey(right.pathNodeIds, right.pathEdgeTypes)))
    .slice(0, options.candidateLimit).map(path => candidateFromPath(path, false));
  const searchRunId = sha256({ graphHash: graph.graphHash, options, modelSha256: model.modelSha256 });
  const budgetExhausted = hasBudgetExhausted();
  const status = budgetExhausted ? 'budget_exhausted' : rankedComplete.length ? 'proposals_found' : maxDepthReached ? 'max_depth_reached' : 'no_solution_found';
  const terminationReason = expansionBudgetExhausted ? 'max_expansions'
    : workBudgetExhausted ? 'max_work_units'
      : treeNodeBudgetExhausted ? 'max_tree_nodes'
        : terminalPathLimitReached ? 'max_terminal_paths'
          : simulations >= options.maxSimulations ? 'simulation_budget'
            : maxDepthReached ? 'max_depth' : 'tree_exhausted_before_budget';
  return {
    schemaVersion: 1,
    mode: 'shadow',
    status,
    graphHash: graph.graphHash,
    candidates: rankedComplete,
    bestPartialCandidates: rankedPartial,
    search: {
      searchRunId, options, rankingMode: 'discriminator_mcts_uct', discriminatorModelSha256: model.modelSha256,
      simulations, requestedSimulations: options.maxSimulations, expansions, workUnits, maxWorkUnits: options.maxWorkUnits,
      generatedStates, maxTreeNodes: options.maxTreeNodes, retainedTerminalPaths: completePaths.size + partialPaths.size,
      maxTerminalPaths: options.maxTerminalPaths, terminalPathsOmitted, terminalPathLimitReached,
      successfulRollouts, expansionBudgetExhausted, workBudgetExhausted, treeNodeBudgetExhausted,
      budgetExhausted, maxDepthReached, exhaustive: false, terminationReason,
      resourceBounds: {
        maxSimulations: options.maxSimulations, maxExpansions: options.maxExpansions,
        maxWorkUnits: options.maxWorkUnits, maxTreeNodes: options.maxTreeNodes,
        maxTerminalPaths: options.maxTerminalPaths, maxAuditEvents: options.maxAuditEvents,
        osCpuQuotaEnforced: false, osMemoryQuotaEnforced: false
      },
      acceptance: 'offline_shadow_not_acceptance', executionAuthorized: false
    },
    auditTrace: {
      schemaVersion: 1, deterministic: true, searchRunId, rankingMode: 'discriminator_mcts_uct',
      modelSha256: model.modelSha256, seed: options.seed,
      counters: { simulations, expansions, workUnits, generatedStates, retainedTerminalPaths: completePaths.size + partialPaths.size },
      eventCount: auditEventCount, omittedEventCount: omittedAuditEventCount,
      truncated: omittedAuditEventCount > 0, events: auditEvents
    },
    gates: {
      humanReviewRequired: true, workflowApprovalRequired: true,
      immutableExecutionPlanCreated: false, dispatchAllowed: false, executionAuthorized: false
    }
  };
}
