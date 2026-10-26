/**
 * Independent benchmark oracle.
 *
 * This module intentionally imports neither the AGG search implementation nor
 * either baseline. It exhaustively enumerates simple nominal paths using only
 * the checked-in graph and task acceptance contract. It validates the fixture
 * contract, not external claim truth or production representativeness.
 */

const TRANSITIONS = new Set(['next_step', 'enables']);
const PREREQUISITES = new Set(['requires_all', 'depends_on']);
const CONFLICTS = new Set(['contradicts', 'alternative_to']);
const EDGE_TYPES = new Set([...TRANSITIONS, ...PREREQUISITES, ...CONFLICTS, 'supports', 'tested_by', 'recovers_to']);

function sorted(values) { return [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0); }

export function computeTaskOracle(task, { maxPaths = 100000, maxExpansions = 1000000 } = {}) {
  if (!task || typeof task !== 'object' || !task.graph || !Array.isArray(task.graph.nodes) || !Array.isArray(task.graph.edges)) {
    throw new TypeError('oracle requires a task with a typed graph');
  }
  const graph = task.graph;
  if (!Array.isArray(graph.edges) || typeof graph.startNodeId !== 'string' || typeof graph.goalNodeId !== 'string') {
    throw new Error(`oracle graph contract invalid for ${task.id}`);
  }
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  if (nodeById.size !== graph.nodes.length || graph.nodes.some(node => !node || typeof node.id !== 'string' || !node.id) ||
      !nodeById.has(graph.startNodeId) || !nodeById.has(graph.goalNodeId)) {
    throw new Error(`oracle graph identity invalid for ${task.id}`);
  }
  const requiredByNode = new Map(graph.nodes.map(node => [node.id, []]));
  for (const edge of graph.edges) {
    if (!edge || typeof edge.from !== 'string' || typeof edge.to !== 'string' || !EDGE_TYPES.has(edge.type) ||
        !nodeById.has(edge.from) || !nodeById.has(edge.to)) {
      throw new Error(`oracle found an unsupported or dangling edge in ${task.id}`);
    }
    if (edge.type === 'recovers_to' && (!edge.condition || typeof edge.condition.onOutcome !== 'string' ||
        !Array.isArray(edge.condition.requiresEvidenceNodeIds) || !Array.isArray(edge.condition.requiresAllNodeIds))) {
      throw new Error(`oracle found a malformed conditional recovery edge in ${task.id}`);
    }
    if (PREREQUISITES.has(edge.type)) {
      if (edge.type === 'requires_all') requiredByNode.get(edge.to).push(edge.from);
      else requiredByNode.get(edge.from).push(edge.to);
    }
  }
  for (const values of requiredByNode.values()) values.sort();
  const transitions = new Map(graph.nodes.map(node => [node.id, []]));
  for (const edge of graph.edges) if (TRANSITIONS.has(edge.type)) transitions.get(edge.from).push(edge);
  for (const values of transitions.values()) values.sort((a, b) => a.to.localeCompare(b.to) || a.type.localeCompare(b.type));
  const conflicts = graph.edges.filter(edge => CONFLICTS.has(edge.type));
  const requiredRefs = sorted(task.requiredEvidenceRefs || []);
  const acceptableStageSets = Array.isArray(task.acceptableRouteStageSets)
    ? task.acceptableRouteStageSets.map(set => sorted(set))
    : [sorted(task.requiredStageNodeIds || [])];
  const forbidden = new Set(task.forbiddenNodeIds || []);
  const validPaths = [];
  let expandedEdges = 0;
  let truncated = false;

  const pathValidAtGoal = path => {
    const pathSet = new Set(path);
    if (path.at(-1) !== graph.goalNodeId || path.some(id => forbidden.has(id))) return false;
    if (!acceptableStageSets.some(stages => stages.every(id => pathSet.has(id)))) return false;
    const refs = new Set(path.flatMap(id => nodeById.get(id)?.evidenceRefs || []));
    if (!requiredRefs.every(ref => refs.has(ref))) return false;
    return true;
  };
  const visit = path => {
    if (validPaths.length >= maxPaths || expandedEdges >= maxExpansions) { truncated = true; return; }
    const current = path.at(-1);
    if (current === graph.goalNodeId) {
      if (pathValidAtGoal(path)) validPaths.push([...path]);
      return;
    }
    for (const edge of transitions.get(current) || []) {
      if (expandedEdges >= maxExpansions || validPaths.length >= maxPaths) { truncated = true; return; }
      expandedEdges += 1;
      if (path.includes(edge.to)) continue;
      const pathSet = new Set(path);
      if (!(requiredByNode.get(edge.to) || []).every(id => pathSet.has(id))) continue;
      if (conflicts.some(conflict => (conflict.from === edge.to && pathSet.has(conflict.to)) ||
        (conflict.to === edge.to && pathSet.has(conflict.from)))) continue;
      visit([...path, edge.to]);
    }
  };
  visit([graph.startNodeId]);
  if (truncated) throw new Error(`oracle search was truncated for ${task.id}; acceptance outcome must remain unknown`);
  const expectedOutcome = validPaths.length ? 'solution' : 'no_solution';
  if (task.expectedOutcome && task.expectedOutcome !== expectedOutcome) {
    throw new Error(`fixture expectedOutcome disagrees with independent oracle for ${task.id}: declared=${task.expectedOutcome}, observed=${expectedOutcome}`);
  }
  return {
    taskId: task.id,
    outcome: expectedOutcome,
    solutionExists: validPaths.length > 0,
    validPathCount: validPaths.length,
    minimumValidPathLength: validPaths.length ? Math.min(...validPaths.map(path => path.length)) : null,
    representativeValidPaths: validPaths.slice(0, 8),
    requiredEvidenceRefs: requiredRefs,
    acceptableRouteStageSets: acceptableStageSets,
    oracleExpandedEdges: expandedEdges,
    exhaustive: true,
    oracleId: 'independent-nominal-path-enumerator@1',
    caveat: 'independent fixture verifier; validates graph/path constraints and declared evidence-reference presence, not external claim truth'
  };
}

/** Verify a selected path without reference to any method-specific score. */
export function verifySelectedPath(task, path) {
  if (!Array.isArray(path) || path.length === 0) return { valid: false, reasons: ['empty_path'] };
  const graph = task.graph;
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const required = new Map(graph.nodes.map(node => [node.id, []]));
  for (const edge of graph.edges) {
    if (edge.type === 'requires_all') required.get(edge.to)?.push(edge.from);
    if (edge.type === 'depends_on') required.get(edge.from)?.push(edge.to);
  }
  const conflicts = graph.edges.filter(edge => CONFLICTS.has(edge.type));
  const reasons = [];
  if (path[0] !== graph.startNodeId) reasons.push('wrong_start');
  if (path.at(-1) !== graph.goalNodeId) reasons.push('goal_not_reached');
  if (path.some(id => !nodeById.has(id))) reasons.push('unknown_node');
  if (new Set(path).size !== path.length) reasons.push('repeated_node');
  for (let index = 1; index < path.length; index++) {
    if (!graph.edges.some(edge => TRANSITIONS.has(edge.type) && edge.from === path[index - 1] && edge.to === path[index])) reasons.push(`non_transition:${path[index - 1]}->${path[index]}`);
    const prior = new Set(path.slice(0, index));
    if (!(required.get(path[index]) || []).every(id => prior.has(id))) reasons.push(`missing_prerequisite:${path[index]}`);
    if (conflicts.some(edge => (edge.from === path[index] && prior.has(edge.to)) || (edge.to === path[index] && prior.has(edge.from)))) reasons.push(`conflict:${path[index]}`);
  }
  const forbidden = new Set(task.forbiddenNodeIds || []);
  if (path.some(id => forbidden.has(id))) reasons.push('forbidden_decoy');
  const stages = task.acceptableRouteStageSets || [task.requiredStageNodeIds || []];
  if (!stages.some(set => set.every(id => path.includes(id)))) reasons.push('required_route_stages_missing');
  const refs = new Set(path.flatMap(id => nodeById.get(id)?.evidenceRefs || []));
  if (!(task.requiredEvidenceRefs || []).every(ref => refs.has(ref))) reasons.push('required_evidence_reference_missing');
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)] };
}
