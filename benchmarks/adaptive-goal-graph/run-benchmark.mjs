#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { searchAdaptiveGoalGraph } from '../../src/runtime/adaptive-goal-graph.js';
import { createAdaptiveGoalKnowledgeStore } from '../../src/runtime/adaptive-goal-knowledge-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
let fixturePath = path.join(here, 'fixtures/recovery-verifier-v68.json');
const MAX_PINNED_SOURCE_BYTES = 2 * 1024 * 1024;
// Frozen v6 scenario identity and oracle are duplicated as verifier constants
// so editing the fixture cannot rewrite both the tested graph and its scoring
// authority in one operation. Extra graph edges remain admissible for negative
// shortcut tests, but the task identities, node identities, evidence contract,
// and accepted path sequences are not caller-controlled.
const FROZEN_TASK_IDS = Object.freeze(['task-verify-consistency', 'task-verify-tamper-regression']);
const FROZEN_RECOVERY_OUTCOMES = Object.freeze(['unknown', 'verification_failed']);
const FROZEN_NODE_IDS = Object.freeze([
  'start', 'inspect-verifier', 'inspect-regression', 'shortcut-guess', 'blocked-check',
  'infeasible-combined-check', 'recovery-probe', 'recovery-outcome-confirmed',
  'cross-check-invariants', 'report-investigation'
]);
const FROZEN_REQUIRED_EVIDENCE = Object.freeze(['verifier-implementation', 'regression-expectations']);
const FROZEN_VALID_GOAL_PATHS = Object.freeze([
  Object.freeze(['start', 'inspect-verifier', 'inspect-regression', 'infeasible-combined-check', 'cross-check-invariants', 'report-investigation']),
  Object.freeze(['start', 'inspect-verifier', 'recovery-probe', 'recovery-outcome-confirmed', 'inspect-regression', 'infeasible-combined-check', 'cross-check-invariants', 'report-investigation'])
]);
const args = process.argv.slice(2);
let outputPath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output' && args[i + 1]) outputPath = path.resolve(args[++i]);
  else if (args[i] === '--fixture' && args[i + 1]) {
    const requested = args[++i];
    if (path.isAbsolute(requested) || requested.includes('\\') || !requested.startsWith('fixtures/') ||
        requested.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('BENCHMARK_FIXTURE_PATH_UNSAFE');
    }
    fixturePath = path.resolve(here, requested);
    const relative = path.relative(here, fixturePath);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('BENCHMARK_FIXTURE_PATH_OUT_OF_SCOPE');
  }
  else if (args[i] === '--help') {
    console.log('Usage: node benchmarks/adaptive-goal-graph/run-benchmark.mjs [--fixture fixtures/recovery-verifier-v68.json] [--output PATH]\nWrites JSON to stdout, or exclusively creates PATH.');
    process.exit(0);
  } else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
}

function readFixtureBytes(filePath) {
  const fixturesRoot = fs.realpathSync(path.join(here, 'fixtures'));
  const absolute = path.resolve(filePath);
  const relative = path.relative(fixturesRoot, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    provenanceError('BENCHMARK_FIXTURE_PATH_OUT_OF_SCOPE');
  }
  let cursor = fixturesRoot;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor, { bigint: true }); }
    catch { provenanceError('BENCHMARK_FIXTURE_MISSING'); }
    if (stat.isSymbolicLink()) provenanceError('BENCHMARK_FIXTURE_SYMLINK');
    if (cursor !== absolute && !stat.isDirectory()) provenanceError('BENCHMARK_FIXTURE_PATH_NOT_DIRECTORY');
    if (cursor === absolute && !stat.isFile()) provenanceError('BENCHMARK_FIXTURE_NOT_REGULAR_FILE');
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let fd;
  try { fd = fs.openSync(absolute, flags); } catch { provenanceError('BENCHMARK_FIXTURE_OPEN_FAILED'); }
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > 8n * 1024n * 1024n) provenanceError('BENCHMARK_FIXTURE_SIZE_INVALID');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let total = 0;
    while (total < bytes.length) {
      const count = fs.readSync(fd, bytes, total, bytes.length - total, total);
      if (count === 0) break;
      total += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const pathAfter = fs.lstatSync(absolute, { bigint: true });
    if (total !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || pathAfter.isSymbolicLink() ||
        pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.size !== before.size ||
        pathAfter.mtimeNs !== before.mtimeNs || pathAfter.ctimeNs !== before.ctimeNs || fs.realpathSync(absolute) !== absolute) {
      provenanceError('BENCHMARK_FIXTURE_CHANGED_DURING_READ');
    }
    return bytes.subarray(0, total);
  } finally { fs.closeSync(fd); }
}

const fixture = JSON.parse(readFixtureBytes(fixturePath).toString('utf8'));

function provenanceError(code, detail = '') {
  throw new Error(`${code}${detail ? `: ${detail}` : ''}`);
}

function sourceMetadata(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
}

function readPinnedSource(root, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source) ||
      typeof source.path !== 'string' || !source.path ||
      !/^[a-f0-9]{64}$/.test(source.sha256) ||
      typeof source.claim !== 'string' || !source.claim.trim()) {
    provenanceError('PROVENANCE_RECORD_INVALID');
  }
  if (path.isAbsolute(source.path) || source.path.includes('\\') ||
      source.path.split('/').some(segment => !segment || segment === '.' || segment === '..') ||
      path.posix.normalize(source.path) !== source.path) {
    provenanceError('PROVENANCE_SOURCE_PATH_UNSAFE', String(source.path));
  }

  const rootReal = fs.realpathSync(root);
  const segments = source.path.split('/');
  let candidate = rootReal;
  let pathStat = null;
  for (let index = 0; index < segments.length; index++) {
    candidate = path.join(candidate, segments[index]);
    try { pathStat = fs.lstatSync(candidate, { bigint: true }); }
    catch { provenanceError('PROVENANCE_SOURCE_MISSING', source.path); }
    if (pathStat.isSymbolicLink()) provenanceError('PROVENANCE_SOURCE_SYMLINK', source.path);
    if (index < segments.length - 1 && !pathStat.isDirectory()) provenanceError('PROVENANCE_SOURCE_PATH_NOT_DIRECTORY', source.path);
    if (index === segments.length - 1 && !pathStat.isFile()) provenanceError('PROVENANCE_SOURCE_NOT_REGULAR_FILE', source.path);
  }
  const relative = path.relative(rootReal, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    provenanceError('PROVENANCE_SOURCE_PATH_OUT_OF_SCOPE', source.path);
  }
  if (pathStat.size > BigInt(MAX_PINNED_SOURCE_BYTES)) provenanceError('PROVENANCE_SOURCE_TOO_LARGE', source.path);

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let fd;
  try { fd = fs.openSync(candidate, flags); }
  catch { provenanceError('PROVENANCE_SOURCE_OPEN_FAILED', source.path); }
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || sourceMetadata(before) !== sourceMetadata(pathStat)) {
      provenanceError('PROVENANCE_SOURCE_CHANGED_BEFORE_READ', source.path);
    }
    if (before.size > BigInt(MAX_PINNED_SOURCE_BYTES)) provenanceError('PROVENANCE_SOURCE_TOO_LARGE', source.path);
    const expectedSize = Number(before.size);
    const buffer = Buffer.alloc(expectedSize + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = fs.readSync(fd, buffer, total, buffer.length - total, total);
      if (count === 0) break;
      total += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    let afterPath;
    try { afterPath = fs.lstatSync(candidate, { bigint: true }); }
    catch { provenanceError('PROVENANCE_SOURCE_CHANGED_DURING_READ', source.path); }
    let realpathAfter;
    try { realpathAfter = fs.realpathSync(candidate); }
    catch { provenanceError('PROVENANCE_SOURCE_CHANGED_DURING_READ', source.path); }
    if (total !== expectedSize || !afterPath.isFile() || afterPath.isSymbolicLink() ||
        sourceMetadata(before) !== sourceMetadata(after) ||
        sourceMetadata(before) !== sourceMetadata(afterPath) || realpathAfter !== candidate) {
      provenanceError('PROVENANCE_SOURCE_CHANGED_DURING_READ', source.path);
    }
    return buffer.subarray(0, total);
  } finally {
    fs.closeSync(fd);
  }
}

function verifySemanticScope(source, bytes) {
  const scope = source.semanticScope;
  if (scope === undefined) return;
  if (!scope || typeof scope !== 'object' ||
      typeof scope.startMarker !== 'string' || !scope.startMarker ||
      typeof scope.endMarker !== 'string' || !scope.endMarker ||
      !/^[a-f0-9]{64}$/.test(scope.sha256)) {
    provenanceError('PROVENANCE_SCOPE_INVALID', source.path);
  }
  const content = bytes.toString('utf8');
  const start = content.indexOf(scope.startMarker);
  const end = start < 0 ? -1 : content.indexOf(scope.endMarker, start + scope.startMarker.length);
  if (start < 0 || end <= start) provenanceError('PROVENANCE_SCOPE_NOT_FOUND', source.path);
  const observed = createHash('sha256').update(content.slice(start, end), 'utf8').digest('hex');
  if (observed !== scope.sha256) {
    provenanceError('PROVENANCE_SCOPE_HASH_MISMATCH', `${source.path}: expected ${scope.sha256}, observed ${observed}`);
  }
}

if (!fixture || !Array.isArray(fixture.provenance) || fixture.provenance.length < 1) {
  provenanceError('PROVENANCE_LEDGER_INVALID');
}
const seenSourcePaths = new Set();
for (const source of fixture.provenance) {
  if (seenSourcePaths.has(source?.path)) provenanceError('PROVENANCE_SOURCE_DUPLICATE', String(source?.path));
  seenSourcePaths.add(source?.path);
  const bytes = readPinnedSource(repo, source);
  const observed = createHash('sha256').update(bytes).digest('hex');
  if (observed !== source.sha256) provenanceError('PROVENANCE_SOURCE_HASH_MISMATCH', `${source.path}: expected ${source.sha256}, observed ${observed}`);
  verifySemanticScope(source, bytes);
}

const config = Object.freeze({ maxDepth: 8, maxExpansions: 80, beamWidths: [1, 2, 4], iterations: 5 });
const requiredEvidence = new Set(fixture.groundTruth.requiredEvidence);

function allowedEdges(task) {
  return task.edges.filter(edge => edge.type !== 'recovers_to' || task.recoveryOutcome === edge.condition?.onOutcome);
}

function toAggGraph(task) {
  return {
    schemaVersion: 1, startNodeId: task.startNodeId, goalNodeId: task.goalNodeId,
    nodes: task.nodes,
    // Current AGG API intentionally excludes all recovers_to edges from nominal
    // success search; retain them in the graph so exclusion is counted/audited.
    edges: task.edges
  };
}

function pathValidity(pathIds, task) {
  if (!pathIds?.length || pathIds[0] !== task.startNodeId || pathIds.at(-1) !== task.goalNodeId) return false;
  const edges = allowedEdges(task);
  for (let i = 1; i < pathIds.length; i++) {
    if (!edges.some(edge => edge.from === pathIds[i - 1] && edge.to === pathIds[i] && ['next_step', 'enables', 'recovers_to'].includes(edge.type))) return false;
    const required = edges.filter(edge => edge.to === pathIds[i] && edge.type === 'requires_all').map(edge => edge.from);
    if (!required.every(id => pathIds.slice(0, i).includes(id))) return false;
  }
  return true;
}

// Validate the fixture's causal contract before any method is scored. Hashes
// over source files are not a substitute for binding a scenario result to its
// declared graph, evidence requirements, and ground-truth oracle.
function validateFixtureContract() {
  const supportedFixtureIdentity = fixture?.schemaVersion === 47 && fixture?.fixtureId === 'recovery-verifier-investigation-v47' ||
    fixture?.schemaVersion === 48 && fixture?.fixtureId === 'recovery-verifier-investigation-v48' ||
    fixture?.schemaVersion === 49 && fixture?.fixtureId === 'recovery-verifier-investigation-v49' ||
    fixture?.schemaVersion === 50 && fixture?.fixtureId === 'recovery-verifier-investigation-v50' ||
    fixture?.schemaVersion === 51 && fixture?.fixtureId === 'recovery-verifier-investigation-v51' ||
    fixture?.schemaVersion === 53 && fixture?.fixtureId === 'recovery-verifier-investigation-v53' ||
    fixture?.schemaVersion === 54 && fixture?.fixtureId === 'recovery-verifier-investigation-v54' ||
    fixture?.schemaVersion === 55 && fixture?.fixtureId === 'recovery-verifier-investigation-v55' ||
    fixture?.schemaVersion === 56 && fixture?.fixtureId === 'recovery-verifier-investigation-v56' ||
    fixture?.schemaVersion === 57 && fixture?.fixtureId === 'recovery-verifier-investigation-v57' ||
    fixture?.schemaVersion === 58 && fixture?.fixtureId === 'recovery-verifier-investigation-v58' ||
    fixture?.schemaVersion === 59 && fixture?.fixtureId === 'recovery-verifier-investigation-v59' ||
    fixture?.schemaVersion === 60 && fixture?.fixtureId === 'recovery-verifier-investigation-v60' ||
    fixture?.schemaVersion === 61 && fixture?.fixtureId === 'recovery-verifier-investigation-v61' ||
    fixture?.schemaVersion === 62 && fixture?.fixtureId === 'recovery-verifier-investigation-v62' ||
    fixture?.schemaVersion === 63 && fixture?.fixtureId === 'recovery-verifier-investigation-v63' ||
    fixture?.schemaVersion === 64 && fixture?.fixtureId === 'recovery-verifier-investigation-v64' ||
    fixture?.schemaVersion === 65 && fixture?.fixtureId === 'recovery-verifier-investigation-v65' ||
    fixture?.schemaVersion === 66 && fixture?.fixtureId === 'recovery-verifier-investigation-v66' ||
    fixture?.schemaVersion === 67 && fixture?.fixtureId === 'recovery-verifier-investigation-v67' ||
    fixture?.schemaVersion === 68 && fixture?.fixtureId === 'recovery-verifier-investigation-v68';
  if (!fixture || !supportedFixtureIdentity ||
      !fixture.groundTruth || !Array.isArray(fixture.groundTruth.requiredEvidence) ||
      fixture.groundTruth.requiredEvidence.length === 0 ||
      new Set(fixture.groundTruth.requiredEvidence).size !== fixture.groundTruth.requiredEvidence.length ||
      fixture.groundTruth.requiredEvidence.some(ref => typeof ref !== 'string' || !ref.trim()) ||
      !Array.isArray(fixture.groundTruth.validGoalPaths) || fixture.groundTruth.validGoalPaths.length === 0 ||
      !Array.isArray(fixture.tasks) || fixture.tasks.length !== 2) {
    provenanceError('BENCHMARK_FIXTURE_CONTRACT_INVALID', 'schema, task count, evidence oracle, or path oracle is malformed');
  }
  if (JSON.stringify(fixture.groundTruth.requiredEvidence) !== JSON.stringify(FROZEN_REQUIRED_EVIDENCE) ||
      JSON.stringify(fixture.groundTruth.validGoalPaths) !== JSON.stringify(FROZEN_VALID_GOAL_PATHS)) {
    provenanceError('BENCHMARK_FROZEN_ORACLE_MISMATCH', 'v6 task evidence requirements and accepted ground-truth paths are immutable verifier inputs');
  }
  if (fixture.groundTruth.qualityRubric?.maxScore !== 11 ||
      fixture.groundTruth.qualityRubric?.goalReached !== 2 ||
      fixture.groundTruth.qualityRubric?.validGroundTruthPath !== 3 ||
      fixture.groundTruth.qualityRubric?.requiredEvidenceCoveragePerItem !== 2 ||
      fixture.groundTruth.qualityRubric?.infeasiblePrerequisiteAvoided !== 1 ||
      fixture.groundTruth.qualityRubric?.unsupportedLiveCauseClaimAvoided !== 1) {
    provenanceError('BENCHMARK_FIXTURE_RUBRIC_INVALID', 'the versioned 11-point scoring rubric changed');
  }
  const taskIds = new Set();
  for (const [taskIndex, task] of fixture.tasks.entries()) {
    if (!task || typeof task.id !== 'string' || !task.id || taskIds.has(task.id) ||
        !Array.isArray(task.nodes) || !Array.isArray(task.edges) ||
        !Array.isArray(task.requiredEvidence) ||
        JSON.stringify([...task.requiredEvidence].sort()) !== JSON.stringify([...fixture.groundTruth.requiredEvidence].sort()) ||
        typeof task.startNodeId !== 'string' || typeof task.goalNodeId !== 'string') {
      provenanceError('BENCHMARK_TASK_CONTRACT_INVALID', String(task?.id || 'unknown task'));
    }
    if (task.id !== FROZEN_TASK_IDS[taskIndex]) {
      provenanceError('BENCHMARK_TASK_IDENTITY_MISMATCH', `task index ${taskIndex} must remain ${FROZEN_TASK_IDS[taskIndex]}`);
    }
    if (task.recoveryOutcome !== FROZEN_RECOVERY_OUTCOMES[taskIndex]) {
      provenanceError('BENCHMARK_TASK_RECOVERY_OUTCOME_MISMATCH',
        `task ${task.id} recovery outcome must remain ${FROZEN_RECOVERY_OUTCOMES[taskIndex]}; caller-supplied outcome labels are not ground truth`);
    }
    taskIds.add(task.id);
    const nodeIds = task.nodes.map(node => node?.id);
    const nodeIdSet = new Set(nodeIds);
    if (nodeIds.some(id => typeof id !== 'string' || !id) || nodeIdSet.size !== nodeIds.length ||
        JSON.stringify(nodeIds) !== JSON.stringify(FROZEN_NODE_IDS) ||
        !nodeIdSet.has(task.startNodeId) || !nodeIdSet.has(task.goalNodeId) ||
        !nodeIdSet.has('blocked-check') || !nodeIdSet.has('shortcut-guess')) {
      provenanceError('BENCHMARK_TASK_NODE_IDENTITY_INVALID', task.id);
    }
    for (const edge of task.edges) {
      if (!edge || !nodeIdSet.has(edge.from) || !nodeIdSet.has(edge.to) ||
          !['next_step', 'enables', 'recovers_to', 'requires_all'].includes(edge.type)) {
        provenanceError('BENCHMARK_TASK_EDGE_INVALID', task.id);
      }
      if (edge.type === 'recovers_to' &&
          (!edge.condition || typeof edge.condition.onOutcome !== 'string' ||
           !Array.isArray(edge.condition.requiresEvidenceNodeIds) || !Array.isArray(edge.condition.requiresAllNodeIds))) {
        provenanceError('BENCHMARK_RECOVERY_GATE_INVALID', task.id);
      }
    }
    const recoveryEvidenceNodeIds = new Set(task.edges.filter(edge => edge.type === 'recovers_to').map(edge => edge.to));
    const allowedEvidence = new Set([...fixture.groundTruth.requiredEvidence,
      ...task.nodes.filter(node => recoveryEvidenceNodeIds.has(node.id) && node.type === 'evidence')
        .flatMap(node => node.evidenceRefs || [])]);
    for (const node of task.nodes) {
      if (node.evidenceRefs !== undefined && (!Array.isArray(node.evidenceRefs) ||
          node.evidenceRefs.some(ref => typeof ref !== 'string' || !allowedEvidence.has(ref)))) {
        provenanceError('BENCHMARK_EVIDENCE_REFERENCE_OUT_OF_SCOPE', `${task.id}:${node.id}`);
      }
    }
    const declaredPaths = new Set();
    for (const ids of fixture.groundTruth.validGoalPaths) {
      if (!Array.isArray(ids) || ids.length < 2 || ids.some(id => !nodeIdSet.has(id)) || new Set(ids).size !== ids.length) {
        provenanceError('BENCHMARK_GROUND_TRUTH_PATH_INVALID', task.id);
      }
      if (ids[0] !== task.startNodeId || ids.at(-1) !== task.goalNodeId) continue;
      const key = ids.join('\0');
      declaredPaths.add(key);
    }
    if (![...declaredPaths].some(key => pathValidity(key.split('\0'), task))) {
      provenanceError('BENCHMARK_GROUND_TRUTH_PATH_UNSATISFIABLE', task.id);
    }
  }
}

validateFixtureContract();

function evaluate(pathIds, task) {
  const pathNodes = pathIds.map(id => task.nodes.find(node => node.id === id)).filter(Boolean);
  const evidence = new Set(pathNodes.flatMap(node => node.evidenceRefs || []));
  const taskRequiredEvidence = new Set(task.requiredEvidence);
  const declaredEvidenceReferenceCoverage = [...taskRequiredEvidence].filter(ref => evidence.has(ref)).length / taskRequiredEvidence.size;
  const pathKey = pathIds.join('\0');
  const declaredGroundTruthPath = fixture.groundTruth.validGoalPaths.some(ids => ids.join('\0') === pathKey);
  const valid = declaredGroundTruthPath && pathValidity(pathIds, task);
  const reached = pathIds.at(-1) === task.goalNodeId;
  const avoidedInfeasible = !pathIds.includes('blocked-check');
  const avoidedUnsupportedCause = !pathIds.includes('shortcut-guess');
  const quality = (reached ? 2 : 0) + (valid ? 3 : 0) + [...taskRequiredEvidence].filter(ref => evidence.has(ref)).length * 2 +
    (avoidedInfeasible ? 1 : 0) + (avoidedUnsupportedCause ? 1 : 0);
  return { completed: reached, groundTruthPathValid: valid, qualityScore: quality, qualityMax: 11,
    declaredEvidenceReferenceCoverage, evidenceCovered: [...taskRequiredEvidence].filter(ref => evidence.has(ref)).sort(),
    evidenceClaimsVerified: false,
    infeasiblePrerequisiteAvoided: avoidedInfeasible, unsupportedLiveCauseClaimAvoided: avoidedUnsupportedCause };
}

function enumeratePaths(task, budget) {
  const edges = allowedEdges(task);
  const transitions = edges.filter(edge => ['next_step', 'enables', 'recovers_to'].includes(edge.type));
  const requirements = new Map(task.nodes.map(node => [node.id, edges.filter(edge => edge.to === node.id && edge.type === 'requires_all').map(edge => edge.from)]));
  const paths = [];
  let expansions = 0;
  const stack = [[task.startNodeId]];
  while (stack.length && expansions < budget) {
    const current = stack.pop();
    const last = current.at(-1);
    if (last === task.goalNodeId) { paths.push(current); continue; }
    for (const edge of transitions.filter(item => item.from === last).reverse()) {
      expansions++;
      if (current.includes(edge.to)) continue;
      if (!requirements.get(edge.to).every(id => current.includes(id))) continue;
      stack.push([...current, edge.to]);
      if (expansions >= budget) break;
    }
  }
  return { paths, expansions, budgetExhausted: stack.length > 0 && expansions >= budget };
}

function baselineSinglePath(task) {
  const edges = allowedEdges(task).filter(edge => ['next_step', 'enables', 'recovers_to'].includes(edge.type));
  const adjacency = new Map(task.nodes.map(node => [node.id, []]));
  for (const edge of edges) adjacency.get(edge.from).push(edge.to);
  for (const values of adjacency.values()) values.sort();
  let expansions = 0;
  const path = [task.startNodeId];
  while (path.at(-1) !== task.goalNodeId && path.length < config.maxDepth + 1 && expansions < config.maxExpansions) {
    const next = (adjacency.get(path.at(-1)) || []).find(id => {
      expansions++;
      const reqs = allowedEdges(task).filter(edge => edge.to === id && edge.type === 'requires_all').map(edge => edge.from);
      return !path.includes(id) && reqs.every(required => path.includes(required));
    });
    if (!next) break;
    path.push(next);
  }
  return { path, expansions };
}

function runOne(task, method, beamWidth = null) {
  const start = process.hrtime.bigint();
  let path = [];
  let expansions = 0;
  let prunes = 0;
  let alternativesNotSelected = 0;
  let searchExhaustive = true;
  let budgetExhausted = false;
  let deferredRecoveryEdges = 0;
  if (method === 'single-path') {
    const result = baselineSinglePath(task); path = result.path; expansions = result.expansions;
  } else if (method === 'topological-tot') {
    const result = enumeratePaths(task, config.maxExpansions); expansions = result.expansions;
    path = result.paths.sort((a, b) => a.length - b.length || a.join('\0').localeCompare(b.join('\0')))[0] || [task.startNodeId];
    alternativesNotSelected = Math.max(0, result.paths.length - 1);
    budgetExhausted = result.budgetExhausted;
    searchExhaustive = !budgetExhausted;
  } else {
    const result = searchAdaptiveGoalGraph(toAggGraph(task), { maxDepth: config.maxDepth, maxExpansions: config.maxExpansions, beamWidth });
    path = result.candidates[0]?.pathNodeIds || result.bestPartialCandidates[0]?.pathNodeIds || [task.startNodeId];
    expansions = result.search.expansions; prunes = result.search.prunedStates;
    alternativesNotSelected = Math.max(0, result.candidates.length - 1);
    searchExhaustive = result.search.exhaustive;
    budgetExhausted = result.status === 'budget_exhausted';
    deferredRecoveryEdges = result.search.conditionalRecoveryEdgesExcluded || 0;
  }
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  return { taskId: task.id, method, ...(beamWidth === null ? {} : { beamWidth }), ...evaluate(path, task), pathNodeIds: path,
    expansionCount: expansions, pruneCount: prunes, alternativesNotSelected, searchExhaustive, budgetExhausted,
    deferredRecoveryEdges, runtimeMs: Number(elapsedMs.toFixed(4)) };
}

const records = [];
for (let iteration = 0; iteration < config.iterations; iteration++) {
  for (const task of fixture.tasks) {
    records.push(runOne(task, 'single-path'));
    records.push(runOne(task, 'topological-tot'));
    for (const width of config.beamWidths) records.push(runOne(task, 'agg-beam', width));
  }
}
const summaries = [...new Set(records.map(row => `${row.method}:${row.beamWidth ?? '-'}`))].map(key => {
  const group = records.filter(row => `${row.method}:${row.beamWidth ?? '-'}` === key);
  const mean = field => group.reduce((sum, row) => sum + row[field], 0) / group.length;
  return { variant: key, runs: group.length, completionRate: mean('completed'), groundTruthPathValidityRate: mean('groundTruthPathValid'),
    meanQualityScore: Number(mean('qualityScore').toFixed(3)), meanExpansionCount: Number(mean('expansionCount').toFixed(3)),
    meanPruneCount: Number(mean('pruneCount').toFixed(3)), meanAlternativesNotSelected: Number(mean('alternativesNotSelected').toFixed(3)),
    exhaustiveRate: Number(mean('searchExhaustive').toFixed(3)), budgetExhaustionRate: Number(mean('budgetExhausted').toFixed(3)),
    meanDeclaredEvidenceReferenceCoverage: Number(mean('declaredEvidenceReferenceCoverage').toFixed(3)),
    evidenceClaimsVerifiedRate: 0,
    meanRuntimeMs: Number(mean('runtimeMs').toFixed(4)) };
});
// Exercise the actual persistent-graph storage contract in an in-memory SQLite
// database. Both benchmark goals reference the same stable capability identity;
// a reused node is measured, but deliberately remains unverified/unusable for
// planning because this benchmark has no independent evidence verifier.
const knowledgeDb = new DatabaseSync(':memory:');
const knowledgeStore = createAdaptiveGoalKnowledgeStore(knowledgeDb);
try {
  const sharedEvidenceRefs = fixture.provenance.map(source =>
    `file:${source.path}#sha256=${source.sha256}`);
  for (const task of fixture.tasks) {
    knowledgeStore.saveNode({
      goalId: task.id,
      stableKey: 'recovery-verifier-source-crosscheck',
      type: 'capability',
      content: { label: 'Cross-check recovery verifier implementation against regression expectations' },
      provenance: { source: fixture.fixtureId, actor: 'offline-benchmark', reference: 'checked-in fixture source hashes' },
      evidenceRefs: sharedEvidenceRefs
    });
  }
  const knowledgeSnapshot = knowledgeStore.search({ includeUnverified: true, limit: 500 });
  const reusedNodes = knowledgeSnapshot.reusedNodes;
  const sharedKnowledgeNode = knowledgeSnapshot.nodes.find(node => node.stableKey === 'recovery-verifier-source-crosscheck');
  const output = {
    schemaVersion: 1, benchmark: fixture.fixtureId, deterministic: true, networkCalls: 0, modelCalls: 0,
    provenance: fixture.provenance, config,
    reuse: {
      taskCount: fixture.tasks.length, iterations: config.iterations, repeatedTaskRuns: records.length,
      crossTaskReusedNodeCount: reusedNodes.length,
      reusedNodes: reusedNodes.map(item => ({ ...item, verified: false, usableForPlanning: false })),
      sharedNodeEvidence: sharedKnowledgeNode ? {
        nodeId: sharedKnowledgeNode.id,
        contentHash: sharedKnowledgeNode.contentHash,
        provenanceHash: sharedKnowledgeNode.provenanceHash,
        evidenceRefs: sharedKnowledgeNode.evidenceRefs,
        verified: false,
        usableForPlanning: false
      } : null,
      allKnowledgeVerified: false,
      note: 'Reuse is measured from globally stable node IDs and append-only goal memberships in the real knowledge-store module. Content hashes verify stored bytes only; without a verifier the shared capability remains unverified and unusable for planning.'
    },
    baselineSemantics: {
      'single-path': 'Deterministic lexical first-successor walk with no backtracking; a simple surrogate for linear planning, not an LLM CoT run.',
      'topological-tot': 'Deterministic bounded path enumerator selecting the shortest valid ground-truth path; a search baseline surrogate, not a model-based ToT run.',
      'agg-beam': 'The checked-in adaptive-goal-graph implementation with fixed options and audit counters.'
    },
    tokenCost: null,
    tokenCostNote: 'No LLM or network calls are made; token cost is not applicable and is not estimated.',
    evidenceMetricNote: 'declaredEvidenceReferenceCoverage measures presence of required reference labels in the selected path only. It does not mean source integrity, artifact lineage, claim truth, or independent attestation has been verified.',
    pruneMetricNote: 'pruneCount counts search states/candidates rejected by a bounded search mechanism. alternativesNotSelected is separate and counts complete alternatives not selected; full enumeration does not call those alternatives pruned.',
    summaries, records
  };
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (outputPath) {
    const fd = fs.openSync(outputPath, 'wx', 0o600);
    try { fs.writeFileSync(fd, serialized, 'utf8'); } finally { fs.closeSync(fd); }
  } else process.stdout.write(serialized);
} finally {
  knowledgeDb.close();
}
