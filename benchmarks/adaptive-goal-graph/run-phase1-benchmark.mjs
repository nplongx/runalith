#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseStrictJson } from '../../src/runtime/strict-json.js';
import { searchAdaptiveGoalGraph } from '../../src/runtime/adaptive-goal-graph.js';
import { createAdaptiveGoalKnowledgeStore } from '../../src/runtime/adaptive-goal-knowledge-store.js';
import { computeTaskOracle, verifySelectedPath } from './oracle.mjs';
import { pairedOutcomeAnalysis } from './phase1-statistics.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const catalogPath = path.join(here, 'fixtures/phase1-task-catalog.json');

const SOURCE_INPUTS = Object.freeze({
  catalog: 'benchmarks/adaptive-goal-graph/fixtures/phase1-task-catalog.json',
  runner: 'benchmarks/adaptive-goal-graph/run-phase1-benchmark.mjs',
  graphRuntime: 'src/runtime/adaptive-goal-graph.js',
  knowledgeStore: 'src/runtime/adaptive-goal-knowledge-store.js',
  oracle: 'benchmarks/adaptive-goal-graph/oracle.mjs',
  statistics: 'benchmarks/adaptive-goal-graph/phase1-statistics.mjs',
  plan: 'docs/plugin-workflow-benchmark-plan.md',
  freeze: 'docs/plugin-workflow-benchmark-phase1-freeze.md',
  ledgerIntegrity: 'benchmarks/adaptive-goal-graph/phase1-ledger-integrity.mjs',
  ledgerVerifier: 'benchmarks/adaptive-goal-graph/verify-phase1-ledger.mjs',
  strictJson: 'src/runtime/strict-json.js'
});

function readStableRegularFile(filePath, label, maxBytes = 128 * 1024 * 1024) {
  const resolved = path.resolve(filePath);
  let pathBefore;
  try { pathBefore = fs.lstatSync(resolved, { bigint: true }); }
  catch { throw new Error(`${label} is missing or unreadable: ${resolved}`); }
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || fs.realpathSync(resolved) !== resolved || pathBefore.size > BigInt(maxBytes)) {
    throw new Error(`${label} must be a canonical regular non-symlink file within ${maxBytes} bytes: ${resolved}`);
  }
  let fd;
  try {
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino || before.size > BigInt(maxBytes)) {
      throw new Error(`${label} identity or size changed before reading: ${resolved}`);
    }
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > maxBytes) throw new Error(`${label} exceeded ${maxBytes} bytes while reading: ${resolved}`);
      chunks.push(chunk.subarray(0, count));
    }
    const bytes = Buffer.concat(chunks, total);
    const after = fs.fstatSync(fd, { bigint: true });
    const pathAfter = fs.lstatSync(resolved, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || bytes.byteLength !== Number(after.size) ||
        pathAfter.isSymbolicLink() || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino ||
        pathAfter.size !== before.size || pathAfter.mtimeNs !== before.mtimeNs || pathAfter.ctimeNs !== before.ctimeNs ||
        fs.realpathSync(resolved) !== resolved) {
      throw new Error(`${label} changed during descriptor read: ${resolved}`);
    }
    return { bytes, sizeBytes: bytes.byteLength, mode: Number(before.mode & 0o777n) };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const sourceBytesAtStart = new Map(Object.entries(SOURCE_INPUTS).map(([key, relative]) =>
  [key, readStableRegularFile(path.join(repo, relative), `AGG Phase 1 source input ${relative}`).bytes]));
const catalogBytesAtStart = sourceBytesAtStart.get('catalog');
const catalog = parseStrictJson(catalogBytesAtStart, 'frozen AGG Phase 1 task catalog');
const config = Object.freeze({
  maxDepth: catalog.searchBudget.maxDepth,
  maxExpansions: catalog.searchBudget.maxExpansions,
  beamWidths: [...catalog.searchBudget.aggBeamWidths],
  iterations: catalog.iterations,
  repeatSeeds: [...catalog.repeatSeeds],
  seedSemantics: 'catalog base seed plus repeat seed controls paired graph-metric variation; every method sees the same graph in a task/repeat pair; repeat seed also controls baseline tie-breaking; AGG is deterministic for a fixed graph',
  equalBudgetUnit: catalog.searchBudget.expansionUnit,
  maxModelCalls: 0,
  maxNetworkCalls: 0
});

let outputPath = null;
let reportPath = null;
let manifestPath = null;
const cliArgs = process.argv.slice(2);
for (let i = 0; i < cliArgs.length; i++) {
  const arg = cliArgs[i];
  if (arg === '--output' && cliArgs[i + 1]) outputPath = path.resolve(cliArgs[++i]);
  else if (arg === '--report' && cliArgs[i + 1]) reportPath = path.resolve(cliArgs[++i]);
  else if (arg === '--manifest' && cliArgs[i + 1]) manifestPath = path.resolve(cliArgs[++i]);
  else if (arg === '--help') {
    console.log('Usage: node benchmarks/adaptive-goal-graph/run-phase1-benchmark.mjs [--output RAW.json] [--report SUMMARY.md] [--manifest MANIFEST.json]\nEach output path is created exclusively; existing files are never overwritten. With --output, a SHA-256 manifest is written to RAW.json.manifest.json unless --manifest is supplied. Without --output, JSON is written to stdout and no sidecar manifest is created.');
    process.exit(0);
  } else throw new Error(`Unknown or incomplete argument: ${arg}`);
}
if (manifestPath && !outputPath) throw new Error('--manifest requires --output so its raw-result hash has an unambiguous target');
if (outputPath && !manifestPath) manifestPath = `${outputPath}.manifest.json`;
const outputDestinations = [outputPath, reportPath, manifestPath].filter(Boolean);
if (new Set(outputDestinations).size !== outputDestinations.length) throw new Error('raw, report and manifest destinations must be different files');
for (const destination of outputDestinations) {
  if (!destination.startsWith(`${repo}${path.sep}`)) throw new Error(`output must stay inside the repository: ${destination}`);
  const relative = path.relative(repo, destination).split(path.sep);
  if (relative[0] === 'dist') throw new Error('benchmark outputs must not be written to dist/');
  if (fs.existsSync(destination)) throw new Error(`Refusing to overwrite existing output: ${destination}`);
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sourceDigest(key) {
  const bytes = sourceBytesAtStart.get(key);
  if (!bytes) throw new Error(`source snapshot input was not captured: ${key}`);
  return sha256(bytes);
}
function assertSourceInputSnapshotStillMatches() {
  for (const [key, relative] of Object.entries(SOURCE_INPUTS)) {
    const current = readStableRegularFile(path.join(repo, relative), `AGG Phase 1 source recheck ${relative}`);
    if (!current.bytes.equals(sourceBytesAtStart.get(key))) {
      throw new Error(`AGG Phase 1 source drift detected between start and end of benchmark run: ${relative}`);
    }
  }
}
function rngFor(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
function seededShuffle(items, seed) {
  const values = [...items];
  const random = rngFor(seed);
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}
function metricNoise(random, low, high) { return Number((low + (high - low) * random()).toFixed(4)); }
function metricNode(id, type, label, random, overrides = {}) {
  return {
    id, type, label,
    estimatedCost: overrides.estimatedCost ?? metricNoise(random, 0.3, 1.5),
    estimatedRisk: overrides.estimatedRisk ?? metricNoise(random, 0.01, 0.09),
    estimatedSuccessConfidence: overrides.estimatedSuccessConfidence ?? metricNoise(random, 0.88, 0.97),
    reusePotential: overrides.reusePotential ?? metricNoise(random, 0.1, 0.8),
    informationValue: overrides.informationValue ?? metricNoise(random, 0.1, 0.9),
    ...(overrides.evidenceRefs ? { evidenceRefs: [...overrides.evidenceRefs] } : {})
  };
}

function buildTaskCatalog(repeatSeed = 0) {
  const tasks = [];
  catalog.families.forEach((family, familyIndex) => {
    for (let variant = 1; variant <= catalog.variantsPerFamily; variant++) {
      const variantContract = catalog.variants.find(item => item.id === variant);
      if (!variantContract) throw new Error(`catalog has no oracle contract for variant ${variant}`);
      // Fixed repeat seeds vary graph-visible metrics across paired repetitions.
      // Every method in a task/repeat pair receives the same exact graph; AGG
      // remains deterministic for a fixed graph.
      const seed = catalog.baseSeed + familyIndex * 100 + variant + repeatSeed * 1000;
      const random = rngFor(seed);
      const id = `${family.id}-${String(variant).padStart(2, '0')}`;
      const stageIds = variantContract.kind === 'additional_provenance_stage' ? [...family.stageIds, 'inspect-source-provenance'] : [...family.stageIds];
      const requiredEvidenceTypes = variantContract.kind === 'additional_provenance_stage' ? [...family.evidenceTypes, 'source-provenance'] : [...family.evidenceTypes];
      const requiredEvidenceRefs = requiredEvidenceTypes.map(type => `evidence:${type}:${variant}`);
      const alternativeStageIds = variantContract.kind === 'competing_nominal_routes' ? stageIds.map(stageId => `${stageId}-alternative`) : null;
      const nodes = [
        { id: 'start', type: 'goal', label: `Start: ${family.title}`, estimatedCost: 0, estimatedRisk: 0, estimatedSuccessConfidence: 1, reusePotential: 0.2, informationValue: 0 },
        metricNode('a-greedy-dead-end', 'task', `Tempting dead end (${family.deadEndProfile})`, random,
          family.deadEndProfile === 'high-confidence'
            ? { estimatedCost: 0.01, estimatedRisk: 0.01, estimatedSuccessConfidence: 0.995, reusePotential: 0.01, informationValue: 0.01 }
            : family.deadEndProfile === 'low-confidence'
              ? { estimatedCost: 1.5, estimatedRisk: 0.95, estimatedSuccessConfidence: 0.35, reusePotential: 0.01, informationValue: 0.01 }
              : { estimatedCost: 0.08, estimatedRisk: 0.45, estimatedSuccessConfidence: 0.9, reusePotential: 0.01, informationValue: 0.01 }),
        ...stageIds.map((stageId, index) => metricNode(stageId, 'task', `${requiredEvidenceTypes[index]} source inspection`, random,
          { evidenceRefs: [`evidence:${requiredEvidenceTypes[index]}:${variant}`] })),
        metricNode('validate-prerequisites', 'experiment', 'Validate all required typed artifact and prerequisite contracts', random),
        metricNode('draft-plan', 'candidate', 'Construct a bounded feasible plan from the checked inputs', random),
        metricNode('review-gate', 'task', 'Obtain separate human review and preserve approval boundary', random),
        metricNode('sandbox-run', 'experiment', 'Execute only the deterministic benchmark action in the isolated sandbox', random),
        { id: 'goal', type: 'goal', label: `Completed: ${family.title}`, estimatedCost: 0, estimatedRisk: 0, estimatedSuccessConfidence: 1, reusePotential: 0.2, informationValue: 0 },
        metricNode('m-prerequisite-shortcut', 'experiment', 'Shortcut that is blocked by an unavailable prerequisite', random,
          { estimatedCost: 0.02, estimatedRisk: 0.4, estimatedSuccessConfidence: 0.7, reusePotential: 0, informationValue: 0 }),
        metricNode('unavailable-prerequisite', 'condition', 'A prerequisite intentionally unavailable in this task fixture', random,
          { estimatedCost: 0, estimatedRisk: 0.1, estimatedSuccessConfidence: 0.2, reusePotential: 0, informationValue: 0 }),
        metricNode('z-unverified-shortcut', 'idea', 'Unverified shortcut that claims completion without required evidence', random,
          { estimatedCost: 0.01, estimatedRisk: 0.95, estimatedSuccessConfidence: 0.62, reusePotential: 0, informationValue: 0 })
      ];
      const edges = [
        { from: 'start', to: 'a-greedy-dead-end', type: 'next_step' },
        { from: 'start', to: stageIds[0], type: 'next_step' },
        { from: 'start', to: 'm-prerequisite-shortcut', type: 'next_step' },
        { from: 'start', to: 'z-unverified-shortcut', type: 'next_step' },
        { from: 'm-prerequisite-shortcut', to: 'goal', type: 'next_step' },
        { from: 'unavailable-prerequisite', to: 'm-prerequisite-shortcut', type: 'requires_all' },
        { from: 'z-unverified-shortcut', to: 'goal', type: 'next_step' }
      ];
      for (let index = 1; index < stageIds.length; index++) {
        edges.push({ from: stageIds[index - 1], to: stageIds[index], type: 'next_step' });
      }
      edges.push({ from: stageIds.at(-1), to: 'validate-prerequisites', type: 'next_step' });
      for (const stageId of stageIds) edges.push({ from: stageId, to: 'validate-prerequisites', type: 'requires_all' });
      edges.push(
        { from: 'validate-prerequisites', to: 'draft-plan', type: 'next_step' },
        { from: 'draft-plan', to: 'review-gate', type: 'next_step' },
        { from: 'review-gate', to: 'sandbox-run', type: 'next_step' },
        { from: 'sandbox-run', to: 'goal', type: 'next_step' },
        { from: 'z-unverified-shortcut', to: 'review-gate', type: 'contradicts' },
        { from: 'z-unverified-shortcut', to: 'goal', type: 'contradicts' },
        { from: stageIds[0], to: 'goal', type: 'supports' }
      );
      const acceptableRouteStageSets = [stageIds];
      if (alternativeStageIds) {
        nodes.push(...alternativeStageIds.map((stageId, index) => metricNode(stageId, 'task', `Alternative ${requiredEvidenceTypes[index]} source inspection`, random,
          { evidenceRefs: [`evidence:${requiredEvidenceTypes[index]}:${variant}`] })));
        nodes.push(metricNode('validate-prerequisites-alternative', 'experiment', 'Validate the competing source-inspection route', random));
        edges.push({ from: 'start', to: alternativeStageIds[0], type: 'next_step' });
        for (let index = 1; index < alternativeStageIds.length; index++) {
          edges.push({ from: alternativeStageIds[index - 1], to: alternativeStageIds[index], type: 'next_step' });
        }
        edges.push({ from: alternativeStageIds.at(-1), to: 'validate-prerequisites-alternative', type: 'next_step' });
        for (const stageId of alternativeStageIds) edges.push({ from: stageId, to: 'validate-prerequisites-alternative', type: 'requires_all' });
        edges.push(
          { from: 'validate-prerequisites-alternative', to: 'draft-plan', type: 'next_step' },
          { from: stageIds[0], to: alternativeStageIds[0], type: 'alternative_to' }
        );
        acceptableRouteStageSets.push(alternativeStageIds);
      }
      const expectedOutcome = variantContract.expectedOutcome;
      if (variant === 4) {
        // The independent oracle must prove this case unsatisfiable because a
        // mandatory prerequisite has no nominal incoming path, not because a
        // solver happened to time out or prune the route.
        edges.push({ from: 'unavailable-prerequisite', to: 'validate-prerequisites', type: 'requires_all' });
        if (alternativeStageIds) edges.push({ from: 'unavailable-prerequisite', to: 'validate-prerequisites-alternative', type: 'requires_all' });
      }
      if (familyIndex === 2 || familyIndex === 5) {
        nodes.push(metricNode('recovery-evidence-review', 'evidence', 'Outcome-gated recovery review branch', random,
          { evidenceRefs: [`recovery:${id}`] }));
        edges.push({ from: 'validate-prerequisites', to: 'recovery-evidence-review', type: 'recovers_to',
          condition: { onOutcome: 'evidence_missing', requiresEvidenceNodeIds: [], requiresAllNodeIds: [] } });
      }
      if (family.includesStaleProvenanceShortcut) {
        nodes.push(metricNode('stale-provenance-shortcut', 'evidence',
          'Stale source snapshot reusing current-looking evidence labels', random,
          { estimatedCost: 0.01, estimatedRisk: 0.01, estimatedSuccessConfidence: 0.999,
            reusePotential: 0.99, informationValue: 0.99, evidenceRefs: [...requiredEvidenceRefs] }));
        edges.push(
          { from: 'start', to: 'stale-provenance-shortcut', type: 'next_step' },
          { from: 'stale-provenance-shortcut', to: 'goal', type: 'next_step' },
          { from: 'stale-provenance-shortcut', to: 'goal', type: 'contradicts' },
          { from: 'stale-provenance-shortcut', to: stageIds[0], type: 'contradicts' }
        );
      }
      const graph = { schemaVersion: 1, startNodeId: 'start', goalNodeId: 'goal', nodes, edges };
      const expectedPath = expectedOutcome === 'solution'
        ? ['start', ...stageIds, 'validate-prerequisites', 'draft-plan', 'review-gate', 'sandbox-run', 'goal']
        : null;
      tasks.push({
        id, familyId: family.id, title: `${family.title} (variant ${variant}: ${variantContract.kind})`, seed,
        variant, expectedOutcome,
        variantKind: variantContract.kind,
        requiredEvidenceTypes, requiredEvidenceRefs, requiredStageNodeIds: [...stageIds], acceptableRouteStageSets, expectedPath,
        forbiddenNodeIds: [...catalog.oracleContract.forbiddenNodeIds],
        graph
      });
    }
  });
  return tasks;
}

function validateAndAttachOracle(taskCatalog) {
  if (taskCatalog.length < 20 || taskCatalog.length > 30) {
  throw new Error(`Phase 1 benchmark requires the catalog-defined 20–30 tasks; generated ${taskCatalog.length}`);
}
  const oracleByTaskId = new Map(taskCatalog.map(task => [task.id, computeTaskOracle(task)]));
  for (const task of taskCatalog) {
    const oracle = oracleByTaskId.get(task.id);
    if (task.expectedOutcome === 'solution' && !oracle.validPathCount) throw new Error(`fixture declares a solution with no oracle path: ${task.id}`);
    if (task.expectedOutcome === 'no_solution' && oracle.validPathCount) throw new Error(`fixture declares no solution but oracle found a valid path: ${task.id}`);
    task.oracle = oracle;
    if (task.expectedPath) {
      const expected = verifySelectedPath(task, task.expectedPath);
      if (!expected.valid) throw new Error(`fixture expected path invalid under independent verifier for ${task.id}: ${expected.reasons.join(',')}`);
    }
  }
  return taskCatalog;
}
const taskCatalog = validateAndAttachOracle(buildTaskCatalog());

function nominalTransitions(graph) {
  return graph.edges.filter(edge => ['next_step', 'enables'].includes(edge.type));
}
function graphNodeById(graph) { return new Map(graph.nodes.map(node => [node.id, node])); }
function requirementsByTarget(graph) {
  const required = new Map(graph.nodes.map(node => [node.id, []]));
  for (const edge of graph.edges) {
    if (edge.type === 'requires_all') required.get(edge.to).push(edge.from);
    if (edge.type === 'depends_on') required.get(edge.from).push(edge.to);
  }
  return required;
}
function pathFeasibility(path, graph) {
  if (!Array.isArray(path) || path.length === 0 || path[0] !== graph.startNodeId) return false;
  const transitions = nominalTransitions(graph);
  const required = requirementsByTarget(graph);
  const conflictEdges = graph.edges.filter(edge => ['contradicts', 'alternative_to'].includes(edge.type));
  for (let index = 0; index < path.length; index++) {
    const nodeId = path[index];
    if (index > 0 && !transitions.some(edge => edge.from === path[index - 1] && edge.to === nodeId)) return false;
    if (path.slice(0, index).includes(nodeId)) return false;
    if (!required.get(nodeId).every(id => path.slice(0, index).includes(id))) return false;
    if (conflictEdges.some(edge => (edge.from === nodeId && path.slice(0, index).includes(edge.to)) ||
      (edge.to === nodeId && path.slice(0, index).includes(edge.from)))) return false;
  }
  return true;
}
function evidenceCoverage(path, task) {
  const byId = graphNodeById(task.graph);
  const refs = new Set(path.flatMap(id => byId.get(id)?.evidenceRefs || []));
  return {
    covered: task.requiredEvidenceRefs.filter(ref => refs.has(ref)).sort(),
    missing: task.requiredEvidenceRefs.filter(ref => !refs.has(ref)).sort(),
    count: task.requiredEvidenceRefs.filter(ref => refs.has(ref)).length,
    ratio: task.requiredEvidenceRefs.length === 0 ? 1 : task.requiredEvidenceRefs.filter(ref => refs.has(ref)).length / task.requiredEvidenceRefs.length
  };
}
function evaluatePath(path, task) {
  const reachedGoal = path?.at(-1) === task.graph.goalNodeId;
  const structurallyFeasible = pathFeasibility(path, task.graph);
  const evidence = evidenceCoverage(path || [], task);
  const requiredStagesVisited = task.acceptableRouteStageSets.some(stages => stages.every(id => path.includes(id)));
  const independentPathCheck = reachedGoal ? verifySelectedPath(task, path) : { valid: false, reasons: ['goal_not_reached'] };
  const groundTruthPathValid = reachedGoal && structurallyFeasible && evidence.missing.length === 0 && requiredStagesVisited && independentPathCheck.valid;
  const forbiddenNodesAvoided = !(path || []).some(id => task.forbiddenNodeIds.includes(id));
  // Compare route length against the oracle's shortest valid path length, not
  // a fixture-selected canonical expectedPath. Equal-length valid alternatives
  // receive the same plan-length points.
  const planLengthOptimal = reachedGoal && independentPathCheck.valid && Number.isInteger(task.oracle.minimumValidPathLength) &&
    path.length === task.oracle.minimumValidPathLength;
  const qualityMax = 9 + task.requiredEvidenceRefs.length;
  const qualityScore = (reachedGoal ? 2 : 0) + (structurallyFeasible ? 3 : 0) + evidence.count +
    (forbiddenNodesAvoided ? 2 : 0) + (planLengthOptimal ? 2 : 0);
  return {
    goalReached: reachedGoal,
    feasiblePlan: reachedGoal && structurallyFeasible && evidence.missing.length === 0 && independentPathCheck.valid,
    groundTruthPathValid,
    qualityScore,
    qualityMax,
    evidenceCoverage: evidence.ratio,
    evidenceRefsCovered: evidence.covered,
    evidenceRefsMissing: evidence.missing,
    forbiddenNodesAvoided,
    requiredStagesVisited,
    independentPathCheck,
    oracleOutcome: task.oracle.outcome,
    oracleValidPathCount: task.oracle.validPathCount,
    evidenceClaimsVerified: false,
    evidenceSemantics: 'fixture oracle verifies that reference labels occur on a feasible path; it does not prove claim truth or independent attestation',
    modelBasedReasoning: false
  };
}

function feasibleSuccessorCount(path, graph, required, transitions, conflicts, remainingBudget) {
  const current = path.at(-1);
  let checks = 0;
  let feasible = 0;
  const available = new Set(path);
  for (const edge of transitions.filter(item => item.from === current)) {
    if (checks >= remainingBudget) break;
    checks++;
    if (available.has(edge.to) || !(required.get(edge.to) || []).every(id => available.has(id))) continue;
    if (conflicts.some(conflict => (conflict.from === edge.to && available.has(conflict.to)) ||
      (conflict.to === edge.to && available.has(conflict.from)))) continue;
    feasible++;
  }
  return { feasible, checks };
}

function cotLinear(graph, seed) {
  const byId = graphNodeById(graph);
  const required = requirementsByTarget(graph);
  const transitions = nominalTransitions(graph);
  const conflicts = graph.edges.filter(edge => ['contradicts', 'alternative_to'].includes(edge.type));
  const random = rngFor(seed);
  let path = [graph.startNodeId];
  let expansionCount = 0;
  let deadEnds = 0;
  let budgetExhausted = false;
  while (path.at(-1) !== graph.goalNodeId && path.length <= config.maxDepth && expansionCount < config.maxExpansions) {
    const current = path.at(-1);
    const candidates = transitions.filter(edge => edge.from === current);
    const admissible = [];
    for (const edge of candidates) {
      if (expansionCount >= config.maxExpansions) { budgetExhausted = true; break; }
      expansionCount++;
      if (path.includes(edge.to) || !required.get(edge.to).every(id => path.includes(id))) continue;
      if (conflicts.some(conflict => (conflict.from === edge.to && path.includes(conflict.to)) || (conflict.to === edge.to && path.includes(conflict.from)))) continue;
      const node = byId.get(edge.to);
      const nextPath = [...path, edge.to];
      const continuation = feasibleSuccessorCount(nextPath, graph, required, transitions, conflicts, config.maxExpansions - expansionCount);
      expansionCount += continuation.checks;
      const refsBefore = new Set(path.flatMap(id => byId.get(id)?.evidenceRefs || []));
      const newRefCount = (node.evidenceRefs || []).filter(ref => !refsBefore.has(ref)).length;
      const score = edge.to === graph.goalNodeId ? 10000
        : (continuation.feasible ? 1.0 : -5.0) + newRefCount * 0.75 +
          (node.informationValue ?? 0) * 0.2 + (node.estimatedSuccessConfidence ?? 0.5) * 0.1 -
          (node.estimatedRisk ?? 0.5) * 0.25 - (node.estimatedCost ?? 1) * 0.005;
      admissible.push({ id: edge.to, score, tie: random(), continuationCount: continuation.feasible });
      if (expansionCount >= config.maxExpansions) { budgetExhausted = true; break; }
    }
    admissible.sort((a, b) => b.score - a.score || a.tie - b.tie || a.id.localeCompare(b.id));
    if (!admissible.length) { deadEnds++; break; }
    path = [...path, admissible[0].id];
    // This baseline evaluates only the immediate continuation and picks one
    // chain. It does not preserve alternative partial paths or backtrack.
    if (path.at(-1) !== graph.goalNodeId && admissible[0].continuationCount === 0) { deadEnds++; break; }
  }
  return { path, foundSolution: path.at(-1) === graph.goalNodeId, claimedNoSolution: false,
    expansionCount, pruneCount: 0, backtrackCount: 0, treeNodesVisited: path.length,
    budgetExhausted: budgetExhausted || expansionCount >= config.maxExpansions, deadEnds,
    searchComplete: false,
    searchAlgorithm: 'single-chain greedy with graph-only one-step continuation scoring; no alternative-path retention or backtracking' };
}

function shortestDistanceToGoal(graph) {
  const transitions = nominalTransitions(graph);
  const incoming = new Map(graph.nodes.map(node => [node.id, []]));
  for (const edge of transitions) incoming.get(edge.to).push(edge.from);
  const distance = new Map([[graph.goalNodeId, 0]]);
  const queue = [graph.goalNodeId];
  // This is method-specific heuristic work before search expansion. Report its
  // edge-inspection proxy separately. The frozen catalog's expansion budget
  // counts search successor examinations only, not this preprocessing. The
  // measured wall/CPU duration around totTreeSearch does include it; this is
  // not a claim of equal total graph-inspection work across algorithms.
  let heuristicPreprocessingEdgeVisits = graph.edges.length + transitions.length;
  while (queue.length) {
    const current = queue.shift();
    for (const parent of incoming.get(current)) {
      heuristicPreprocessingEdgeVisits++;
      if (!distance.has(parent)) {
        distance.set(parent, distance.get(current) + 1);
        queue.push(parent);
      }
    }
  }
  return { distance, heuristicPreprocessingEdgeVisits };
}
function pathStateScore(path, graph, distances) {
  const current = path.at(-1);
  const distance = distances.get(current);
  const byId = graphNodeById(graph);
  const graphReferences = new Set(graph.nodes.flatMap(node => node.evidenceRefs || []));
  const pathReferences = new Set(path.flatMap(id => byId.get(id)?.evidenceRefs || []));
  const declaredReferenceCoverage = graphReferences.size ? pathReferences.size / graphReferences.size : 0;
  const risk = path.reduce((sum, id) => sum + (byId.get(id)?.estimatedRisk ?? 0.5), 0);
  const cost = path.reduce((sum, id) => sum + (byId.get(id)?.estimatedCost ?? 1), 0);
  const confidence = path.slice(1).reduce((sum, id) => sum + (byId.get(id)?.estimatedSuccessConfidence ?? 0.5), 0);
  if (current === graph.goalNodeId) return 10000 - path.length - 0.2 * cost;
  if (distance === undefined) return -10000 - path.length;
  // Score uses only graph-visible fields and declared graph reachability. It
  // does not receive task.oracle, requiredEvidenceRefs or expected paths.
  return 5 * declaredReferenceCoverage - 1.75 * distance - 1.5 * risk - 0.2 * cost +
    0.1 * confidence - 0.15 * path.length;
}
function totTreeSearch(graph, seed) {
  const transitions = nominalTransitions(graph);
  const required = requirementsByTarget(graph);
  const conflicts = graph.edges.filter(edge => ['contradicts', 'alternative_to'].includes(edge.type));
  const distanceData = shortestDistanceToGoal(graph);
  const distances = distanceData.distance;
  let frontier = [{ path: [graph.startNodeId], score: 0, sequence: 0 }];
  let expansionCount = 0;
  let pruneCount = 0;
  let backtrackCount = 0;
  let treeNodesVisited = 0;
  let seq = 1;
  let selectedPath = [graph.startNodeId];
  const visitedSeedTie = rngFor(seed);
  let budgetExhausted = false;
  let depthCutoff = false;
  let foundSolution = false;
  while (frontier.length) {
    frontier.sort((a, b) => b.score - a.score || a.tie - b.tie || a.sequence - b.sequence);
    const state = frontier.shift();
    treeNodesVisited++;
    selectedPath = state.path;
    const current = state.path.at(-1);
    if (current === graph.goalNodeId) { foundSolution = true; break; }
    if (state.path.length - 1 >= config.maxDepth) { depthCutoff = true; continue; }
    const successors = transitions.filter(edge => edge.from === current);
    let generatedSuccessors = 0;
    for (const edge of successors) {
      if (expansionCount >= config.maxExpansions) { budgetExhausted = true; break; }
      expansionCount++;
      if (state.path.includes(edge.to) || !required.get(edge.to).every(id => state.path.includes(id))) { pruneCount++; continue; }
      if (conflicts.some(conflict => (conflict.from === edge.to && state.path.includes(conflict.to)) || (conflict.to === edge.to && state.path.includes(conflict.from)))) { pruneCount++; continue; }
      const nextPath = [...state.path, edge.to];
      frontier.push({ path: nextPath, score: pathStateScore(nextPath, graph, distances), tie: visitedSeedTie(), sequence: seq++ });
      generatedSuccessors++;
    }
    if (generatedSuccessors === 0 && frontier.length > 0) backtrackCount++;
  }
  if (expansionCount >= config.maxExpansions && frontier.length && !foundSolution) budgetExhausted = true;
  const searchComplete = !foundSolution && frontier.length === 0 && !budgetExhausted && !depthCutoff;
  return { path: selectedPath, foundSolution, claimedNoSolution: searchComplete,
    expansionCount, pruneCount, backtrackCount, treeNodesVisited, budgetExhausted, searchComplete,
    heuristicPreprocessingEdgeVisits: distanceData.heuristicPreprocessingEdgeVisits,
    searchAlgorithm: 'best-first tree search over explicit partial paths; graph-only evaluator; seeded tie-breaking; preserves alternatives and backtracks by frontier selection' };
}

function runOne(task, method, iteration, seed, beamWidth = null) {
  const cpuBefore = process.resourceUsage();
  const memoryBefore = process.memoryUsage();
  const started = process.hrtime.bigint();
  let result;
  let selectedPath;
  if (method === 'cot-linear') {
    result = cotLinear(task.graph, seed); selectedPath = result.path;
  } else if (method === 'tot-tree') {
    result = totTreeSearch(task.graph, seed); selectedPath = result.path;
  } else {
    const output = searchAdaptiveGoalGraph(task.graph, { maxDepth: config.maxDepth, maxExpansions: config.maxExpansions, beamWidth,
      maxAuditEvents: 1000 });
    selectedPath = output.candidates[0]?.pathNodeIds || output.bestPartialCandidates[0]?.pathNodeIds || [task.graph.startNodeId];
    result = {
      path: selectedPath, expansionCount: output.search.expansions, pruneCount: output.search.prunedStates,
      backtrackCount: output.search.prunedStates, treeNodesVisited: output.search.generatedStates,
      budgetExhausted: output.status === 'budget_exhausted', searchStatus: output.status,
      exhaustive: output.search.exhaustive, terminationReason: output.search.terminationReason,
      foundSolution: output.candidates.length > 0,
      claimedNoSolution: output.status === 'no_solution_found' && output.search.exhaustive === true,
      searchComplete: output.search.exhaustive === true && output.status === 'no_solution_found',
      deferredRecoveryEdges: output.search.conditionalRecoveryEdgesExcluded,
      auditTrace: output.auditTrace
    };
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const cpuAfter = process.resourceUsage();
  const memoryAfter = process.memoryUsage();
  const cpuUserTimeMs = (cpuAfter.userCPUTime - cpuBefore.userCPUTime) / 1000;
  const cpuSystemTimeMs = (cpuAfter.systemCPUTime - cpuBefore.systemCPUTime) / 1000;
  const evaluated = evaluatePath(selectedPath, task);
  const nodeById = graphNodeById(task.graph);
  const estimatedPathCost = selectedPath.slice(1).reduce((sum, id) => sum + (nodeById.get(id)?.estimatedCost ?? 0), 0);
  const claimedNoSolution = result.claimedNoSolution === true;
  const foundSolution = result.foundSolution === true || selectedPath.at(-1) === task.graph.goalNodeId;
  const taskOutcomeCorrect = task.oracle.outcome === 'solution'
    ? (foundSolution && evaluated.groundTruthPathValid)
    : (claimedNoSolution && !foundSolution);
  const outcomeQualityScore = task.oracle.outcome === 'no_solution'
    ? (taskOutcomeCorrect ? evaluated.qualityMax : 0)
    : evaluated.qualityScore;
  return {
    taskId: task.id, taskFamily: task.familyId, taskSeed: task.seed,
    inputGraphSha256: sha256(JSON.stringify(task.graph)), iteration, seed, method,
    ...(beamWidth === null ? {} : { beamWidth }),
    budget: {
      maxDepth: config.maxDepth,
      maxExpansions: config.maxExpansions,
      expansionUnit: config.equalBudgetUnit,
      budgetScope: 'successor-expansion-counter-only',
      heuristicPreprocessingCharged: false,
      cpuAndWallTimeIncludePreprocessing: true
    },
    ...evaluated,
    pathQualityScore: evaluated.qualityScore,
    qualityScore: outcomeQualityScore,
    expectedOutcome: task.oracle.outcome,
    independentOracle: { oracleId: task.oracle.oracleId, exhaustive: task.oracle.exhaustive, validPathCount: task.oracle.validPathCount },
    foundSolution,
    claimedNoSolution,
    searchComplete: result.searchComplete === true,
    taskOutcomeCorrect,
    pathNodeIds: selectedPath,
    expectedPathNodeIds: task.expectedPath,
    oracleVerifiedExpectedOutcome: task.expectedOutcome === task.oracle.outcome,
    expansionCount: result.expansionCount,
    pruneCount: result.pruneCount,
    backtrackCount: result.backtrackCount,
    treeNodesVisited: result.treeNodesVisited,
    heuristicPreprocessingEdgeVisits: result.heuristicPreprocessingEdgeVisits ?? 0,
    estimatedPathCost: Number(estimatedPathCost.toFixed(4)),
    costProvenance: 'sum of unverified caller-supplied per-node estimates; expansionCount is the comparable algorithmic budget/cost proxy',
    runtimeMs: Number(elapsedMs.toFixed(5)),
    cpuUserTimeMs: Number(cpuUserTimeMs.toFixed(5)),
    cpuSystemTimeMs: Number(cpuSystemTimeMs.toFixed(5)),
    cpuTimeMs: Number((cpuUserTimeMs + cpuSystemTimeMs).toFixed(5)),
    rssBeforeBytes: memoryBefore.rss,
    rssAfterBytes: memoryAfter.rss,
    heapUsedBeforeBytes: memoryBefore.heapUsed,
    heapUsedAfterBytes: memoryAfter.heapUsed,
    heapUsedDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
    budgetExhausted: result.budgetExhausted === true,
    ...(result.searchStatus ? { searchStatus: result.searchStatus } : {}),
    ...(result.terminationReason ? { terminationReason: result.terminationReason } : {}),
    ...(result.deferredRecoveryEdges !== undefined ? { deferredRecoveryEdges: result.deferredRecoveryEdges } : {}),
    ...(result.searchAlgorithm ? { searchAlgorithm: result.searchAlgorithm } : {}),
    ...(result.auditTrace ? { auditTrace: result.auditTrace } : {})
  };
}

function mean(rows, field) { return rows.reduce((sum, row) => sum + row[field], 0) / Math.max(1, rows.length); }
function percentile(values, quantile) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)] : null;
}
function summarize(records) {
  const keys = [...new Set(records.map(row => `${row.method}:${row.beamWidth ?? '-'}`))];
  return keys.map(key => {
    const group = records.filter(row => `${row.method}:${row.beamWidth ?? '-'}` === key);
    const solutionRecords = group.filter(row => row.expectedOutcome === 'solution');
    const noSolutionRecords = group.filter(row => row.expectedOutcome === 'no_solution');
    const successfulFeasibleCosts = solutionRecords.filter(row => row.goalReached && row.feasiblePlan).map(row => row.estimatedPathCost);
    const tasks = [...new Set(group.map(row => row.taskId))];
    const perTaskRuns = tasks.map(taskId => group.filter(row => row.taskId === taskId));
    const pathStability = perTaskRuns.map(rows => {
      const frequencies = new Map();
      for (const row of rows) {
        const signature = JSON.stringify(row.pathNodeIds);
        frequencies.set(signature, (frequencies.get(signature) || 0) + 1);
      }
      return Math.max(0, ...frequencies.values()) / Math.max(1, rows.length);
    });
    return {
      variant: key, method: group[0].method, beamWidth: group[0].beamWidth ?? null,
      runs: group.length, tasks: tasks.length,
      taskOutcomeAccuracy: mean(group, 'taskOutcomeCorrect'),
      successRate: mean(group, 'taskOutcomeCorrect'),
      goalCompletionRateOnSolvableTasks: mean(solutionRecords, 'goalReached'),
      feasiblePlanRateOnSolvableTasks: mean(solutionRecords, 'feasiblePlan'),
      groundTruthPathValidityRateOnSolvableTasks: mean(solutionRecords, 'groundTruthPathValid'),
      correctNoSolutionRate: noSolutionRecords.length ? mean(noSolutionRecords, 'claimedNoSolution') : null,
      solutionTaskCount: solutionRecords.length,
      noSolutionTaskCount: noSolutionRecords.length,
      incorrectOutcomeRunCount: group.filter(row => !row.taskOutcomeCorrect).length,
      meanQualityScore: Number(mean(group, 'qualityScore').toFixed(4)),
      meanQualityMax: Number(mean(group, 'qualityMax').toFixed(4)),
      meanEvidenceCoverage: Number(mean(group, 'evidenceCoverage').toFixed(4)),
      meanExpansionCount: Number(mean(group, 'expansionCount').toFixed(4)),
      meanPruneCount: Number(mean(group, 'pruneCount').toFixed(4)),
      meanBacktrackCount: Number(mean(group, 'backtrackCount').toFixed(4)),
      meanTreeNodesVisited: Number(mean(group, 'treeNodesVisited').toFixed(4)),
      meanHeuristicPreprocessingEdgeVisits: Number(mean(group, 'heuristicPreprocessingEdgeVisits').toFixed(4)),
      meanEstimatedPathCostOnFeasiblePaths: successfulFeasibleCosts.length
        ? Number((successfulFeasibleCosts.reduce((sum, value) => sum + value, 0) / successfulFeasibleCosts.length).toFixed(4)) : null,
      feasiblePathCostRunCount: successfulFeasibleCosts.length,
      meanRuntimeMs: Number(mean(group, 'runtimeMs').toFixed(5)),
      p95RuntimeMs: Number(percentile(group.map(row => row.runtimeMs), 0.95).toFixed(5)),
      meanCpuUserTimeMs: Number(mean(group, 'cpuUserTimeMs').toFixed(5)),
      meanCpuSystemTimeMs: Number(mean(group, 'cpuSystemTimeMs').toFixed(5)),
      meanCpuTimeMs: Number(mean(group, 'cpuTimeMs').toFixed(5)),
      meanRssAfterBytes: Math.round(mean(group, 'rssAfterBytes')),
      meanHeapUsedAfterBytes: Math.round(mean(group, 'heapUsedAfterBytes')),
      meanHeapUsedDeltaBytes: Math.round(mean(group, 'heapUsedDeltaBytes')),
      budgetExhaustionRate: mean(group, 'budgetExhausted'),
      outcomeStabilityRate: Number((perTaskRuns.reduce((sum, rows) => {
        const frequencies = new Map();
        for (const row of rows) {
          const outcome = `${row.taskOutcomeCorrect}:${row.goalReached}:${row.claimedNoSolution}`;
          frequencies.set(outcome, (frequencies.get(outcome) || 0) + 1);
        }
        return sum + Math.max(0, ...frequencies.values()) / Math.max(1, rows.length);
      }, 0) / tasks.length).toFixed(4)),
      pathStabilityRate: Number((pathStability.reduce((sum, value) => sum + value, 0) / pathStability.length).toFixed(4)),
      evidenceClaimsVerifiedRate: mean(group, 'evidenceClaimsVerified'),
      modelCalls: 0, tokenCost: null
    };
  });
}

function bootstrapPairedDifference(records, methodA, methodB, field, seed = 776655, samples = 10000) {
  const families = [...new Set(records.map(row => row.taskFamily))].sort();
  if (families.length === 0) throw new Error('paired bootstrap requires at least one task-family cluster');
  const familyMean = method => new Map(families.map(family => {
    const rows = records.filter(row => row.taskFamily === family && row.methodKey === method);
    if (!rows.length) throw new Error(`paired bootstrap has missing records for ${method} in family ${family}`);
    return [family, mean(rows, field)];
  }));
  const avgA = familyMean(methodA);
  const avgB = familyMean(methodB);
  const differences = families.map(family => avgA.get(family) - avgB.get(family));
  const observed = differences.reduce((sum, v) => sum + v, 0) / differences.length;
  const random = rngFor(seed);
  const boot = Array.from({ length: samples }, () => {
    let sum = 0;
    for (let index = 0; index < differences.length; index++) sum += differences[Math.floor(random() * differences.length)];
    return sum / differences.length;
  }).sort((a, b) => a - b);
  return { methodA, methodB, field, pairedMeanDifferenceAminusB: Number(observed.toFixed(5)),
    bootstrap95PercentileCI: [Number(percentile(boot, 0.025).toFixed(5)), Number(percentile(boot, 0.975).toFixed(5))],
    familyClusters: families.length, tasks: [...new Set(records.map(row => row.taskId))].length,
    bootstrapSamples: samples, bootstrapSeed: seed,
    method: `paired family-cluster percentile bootstrap: draw ${families.length} task-family clusters with replacement and preserve matched task-template/seed records within each selected cluster`,
    interpretation: `descriptive interval over ${families.length} synthetic task-family clusters; cluster count is small and the catalog is not a representative production sample; not confirmatory significance` };
}

function markdownReport(output) {
  const lines = [
    '# Runalith AGG Phase 1 benchmark', '',
    `- Fixture: \`${output.benchmark}\``,
    `- Tasks: ${output.taskCount}; repetitions per task/method: ${output.config.iterations}; raw runs: ${output.records.length}`,
    `- Equal budget: maxDepth=${output.config.maxDepth}, maxExpansions=${output.config.maxExpansions} successor-edge examinations per run` ,
    `- Model/network calls: ${output.modelCalls}/${output.networkCalls}; token/monetary cost: not measured (no model calls)`,
    `- Catalog SHA-256: \`${output.provenance.catalogSha256}\``,
    `- Runner SHA-256: \`${output.provenance.runnerSha256}\``, '',
    '## Summary', '',
    '| Method | Runs | Correct task outcome | Goal completion (solvable tasks) | Feasible plan (solvable tasks) | Correct no-solution decisions | Quality mean / max | Mean successor expansions | ToT heuristic precompute edge visits | Mean estimated cost on feasible paths | Mean time (ms) | P95 time (ms) | Mean process CPU (ms) | Mean RSS after (MiB) | Outcome stability | Path stability |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
  ];
  for (const row of output.summaries) lines.push(`| ${row.variant} | ${row.runs} | ${(100*row.taskOutcomeAccuracy).toFixed(1)}% | ${(100*row.goalCompletionRateOnSolvableTasks).toFixed(1)}% | ${(100*row.feasiblePlanRateOnSolvableTasks).toFixed(1)}% | ${row.correctNoSolutionRate == null ? 'n/a' : `${(100*row.correctNoSolutionRate).toFixed(1)}%`} | ${row.meanQualityScore} / ${row.meanQualityMax} | ${row.meanExpansionCount} | ${row.meanHeuristicPreprocessingEdgeVisits} | ${row.meanEstimatedPathCostOnFeasiblePaths ?? 'n/a'} (n=${row.feasiblePathCostRunCount}) | ${row.meanRuntimeMs} | ${row.p95RuntimeMs} | ${row.meanCpuTimeMs} | ${(row.meanRssAfterBytes / (1024*1024)).toFixed(2)} | ${(100*row.outcomeStabilityRate).toFixed(1)}% | ${(100*row.pathStabilityRate).toFixed(1)}% |`);
  lines.push('', '## Paired comparisons', '', '| Contrast | Metric | Mean difference (A − B) | Bootstrap 95% CI |', '|---|---|---:|---:|');
  for (const row of output.inference.pairedComparisons) lines.push(`| ${row.methodA} − ${row.methodB} | ${row.field} | ${row.pairedMeanDifferenceAminusB} | [${row.bootstrap95PercentileCI.join(', ')}] |`);
  lines.push('', '## Paired success outcomes', '',
    '| Contrast (A − B) | Matched graph instances | Both correct | Only A correct | Only B correct | Both incorrect | Success-rate difference | Family-cluster bootstrap 95% CI | Independent family clusters |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of output.inference.pairedSuccessComparisons) {
    lines.push(`| ${row.methodA} − ${row.methodB} | ${row.pairedTaskInstances} | ${row.contingency.bothCorrect} | ${row.contingency.aOnlyCorrect} | ${row.contingency.bOnlyCorrect} | ${row.contingency.bothIncorrect} | ${row.pairedSuccessRateDifferenceAminusB} | [${row.bootstrap95PercentileCI.join(', ')}] | ${row.independentTaskFamilyClusters} |`);
  }
  lines.push('', '## Methodology and limitations', '',
    '- **CoT-style baseline** is a deterministic single-chain heuristic, with one-step continuation scoring but no retained alternatives or backtracking. It does not generate an LLM Chain-of-Thought transcript.',
    '- **ToT baseline** is an explicit best-first tree search over partial paths, using graph-visible metrics, graph-reachable distance and declared-reference coverage with seeded tie-breaking and alternative retention. It receives only the graph: no oracle fields, expected paths, expected evidence list or expected outcome. This is not model-backed LLM ToT.',
    '- **AGG** uses `searchAdaptiveGoalGraph` at widths 1, 2 and 4. Every method has max depth 10 and max 80 successor-expansion examinations. This is a shared search-counter cap, not an equal-total-work budget: ToT graph-wide reverse-distance preprocessing is recorded separately rather than deducted from the cap, while its wall/CPU time is included; CoT has its own graph-filtering and continuation-lookahead overhead. We therefore report whole-method wall/CPU/memory alongside success and the frozen expansion count, and do not claim equal total graph inspections or computation. Wall time uses `process.hrtime.bigint`; user/system process CPU deltas use `process.resourceUsage`; RSS/heap are sampled before/after each synchronous run. A process-level maxRSS high-water mark is also reported; memory fields are sampled, not a per-method peak attribution.',
    '- The 28 tasks are seven synthetic family templates × four variants. Dead-end decoy confidence/risk differs across families; the stale-provenance family includes a forbidden stale snapshot with current-looking reference labels; variants also include competing routes, extra provenance stage and a genuinely unsatisfiable prerequisite. The independent path enumerator in `oracle.mjs` enumerates valid nominal paths and refuses truncated oracle results. Seven family clusters still do not represent production workloads.',
    '- Task graphs are regenerated under each fixed repeat seed; every method sees the same `inputGraphSha256` for a paired task/seed. Each record has a unique `taskInstanceId` and `trialId`. The 140 generated graph instances are nested in only seven synthetic task-family clusters; the five seed variants do not create 140 independent production tasks. A separate owner-approved holdout is not declared.',
    '- Estimated path cost is the sum of caller-supplied node estimates and is **not calibrated**. Comparable algorithmic cost is edge examinations; CPU/wall-time measures actual host compute but is noisy on a shared machine. Token/monetary costs are unavailable because no model/API calls occur.',
    '- Evidence coverage counts required references on the selected path. `evidenceClaimsVerifiedRate=0`; no claim is declared true by this benchmark.',
    '- The paired success table separates both-correct, AGG-only, baseline-only and both-incorrect outcomes. The percentile bootstrap resamples the seven task families as clusters and preserves all matched template/seed observations in each sampled cluster. Seven clusters yield coarse intervals; an interval containing zero is inconclusive, not equivalence. A sample-size/power estimate is not made: the current set has only seven synthetic clusters, no owner-approved minimum important AGG effect target, and the one-task local model pilot is not valid power evidence. No AGG-specific numeric acceptance threshold was found in the checked-in AGG documentation. The separate original workflow benchmark requires plugin-enabled vs basic-tools A/B across ten operational scenarios, the exact 100-point rubric and all five hard-fail conditions; this algorithm-only fixture does not satisfy that protocol.',
    '', '## Reproduction', '',
    '```sh',
    'node benchmarks/adaptive-goal-graph/run-phase1-benchmark.mjs --output artifacts/phase1-benchmark-raw.json --report artifacts/phase1-benchmark-report.md',
    'node benchmarks/adaptive-goal-graph/verify-phase1-ledger.mjs --raw artifacts/phase1-benchmark-raw.json --manifest artifacts/phase1-benchmark-raw.json.manifest.json',
    'node --test tests/test-adaptive-goal-phase1-benchmark.mjs tests/test-adaptive-goal-benchmark-integrity.mjs',
    '```', '',
    `Raw benchmark schema: ${output.schemaVersion}; search fixture seed: ${output.catalogSeed}; repeat seeds: ${output.config.repeatSeeds.join(', ')}.`, '');
  return lines.join('\n');
}

const methodSpecs = [
  { method: 'cot-linear', beamWidth: null },
  { method: 'tot-tree', beamWidth: null },
  ...config.beamWidths.map(beamWidth => ({ method: 'agg-beam', beamWidth }))
];
// Explicit unscored warm-up prevents the first method from receiving all of
// the JIT cold-start penalty. Warm-up records are not included in outcomes.
for (const spec of methodSpecs) runOne(taskCatalog[0], spec.method, 0, config.repeatSeeds[0], spec.beamWidth);
const runStartedAt = new Date().toISOString();
const records = [];
const taskInstances = [];
for (const [iteration, seed] of config.repeatSeeds.entries()) {
  const repeatCatalog = validateAndAttachOracle(buildTaskCatalog(seed));
  for (const task of repeatCatalog) {
    taskInstances.push({
      iteration: iteration + 1, repeatSeed: seed,
      taskInstanceId: `${task.id}::seed-${seed}`,
      id: task.id, familyId: task.familyId, title: task.title, taskSeed: task.seed,
      variant: task.variant, expectedOutcome: task.oracle.outcome, oracle: task.oracle,
      requiredEvidenceTypes: task.requiredEvidenceTypes, requiredEvidenceRefs: task.requiredEvidenceRefs,
      requiredStageNodeIds: task.requiredStageNodeIds, acceptableRouteStageSets: task.acceptableRouteStageSets,
      expectedPath: task.expectedPath, forbiddenNodeIds: task.forbiddenNodeIds, graph: task.graph
    });
    const orderSeed = task.seed ^ seed ^ 0x51A7E;
    const order = seededShuffle(methodSpecs, orderSeed);
    for (const [executionOrderIndex, spec] of order.entries()) {
      const row = runOne(task, spec.method, iteration + 1, seed, spec.beamWidth);
      row.executionOrderIndex = executionOrderIndex;
      row.executionOrderSeed = orderSeed;
      records.push(row);
    }
  }
}
for (const row of records) {
  row.methodKey = `${row.method}:${row.beamWidth ?? '-'}`;
  row.taskInstanceId = `${row.taskId}::seed-${row.seed}`;
  row.taskTemplateId = row.taskId;
  row.trialId = `${row.taskInstanceId}::${row.methodKey}`;
  row.trialKind = 'seeded_graph_variant';
  row.attemptCount = 1;
  row.retryCount = 0;
  row.retryBudget = 0;
  row.trialExitCode = 0;
  row.trialError = null;
  row.timedOut = false;
}
const summaries = summarize(records);
const knowledgeDb = new DatabaseSync(':memory:');
const knowledgeStore = createAdaptiveGoalKnowledgeStore(knowledgeDb);
let reuse;
try {
  for (const task of taskCatalog) knowledgeStore.saveNode({
    goalId: task.id, stableKey: 'validate-prerequisite-contracts', type: 'capability',
    content: { label: 'Validate prerequisite contracts before review-only planning', capabilityVersion: 1 },
    provenance: { source: catalog.fixtureId, actor: 'offline-phase1-benchmark', reference: 'checked-in task catalog and deterministic oracle' },
    evidenceRefs: []
  });
  const snapshot = knowledgeStore.search({ includeUnverified: true, limit: 500 });
  reuse = {
    goalCount: taskCatalog.length,
    crossGoalReusedNodeCount: snapshot.reusedNodes.length,
    reusedNodes: snapshot.reusedNodes.map(node => ({ ...node, verified: false, usableForPlanning: false })),
    interpretation: 'cross-goal reuse counts stable knowledge identity/membership only; cost savings are not inferred; no independent verifier exists; reused nodes remain unverified and unavailable to planning authority'
  };
} finally { knowledgeDb.close(); }

const comparisonSpecs = [
  ['agg-beam:2', 'cot-linear:-', 'taskOutcomeCorrect'],
  ['agg-beam:2', 'tot-tree:-', 'taskOutcomeCorrect'],
  ['agg-beam:2', 'cot-linear:-', 'qualityScore'],
  ['agg-beam:2', 'tot-tree:-', 'qualityScore'],
  ['agg-beam:2', 'tot-tree:-', 'expansionCount'],
  ['agg-beam:2', 'tot-tree:-', 'runtimeMs'],
  ['agg-beam:2', 'tot-tree:-', 'cpuTimeMs']
];
const inference = { pairedComparisons: comparisonSpecs.map(([a,b,field], index) => bootstrapPairedDifference(
  records, a, b, field, 776655 + index)) };
inference.pairedSuccessComparisons = [
  pairedOutcomeAnalysis(records, 'agg-beam:2', 'cot-linear:-', { bootstrapSeed: 887701, bootstrapSamples: 10_000 }),
  pairedOutcomeAnalysis(records, 'agg-beam:2', 'tot-tree:-', { bootstrapSeed: 887702, bootstrapSamples: 10_000 })
];

const provenance = {
  catalogPath: SOURCE_INPUTS.catalog, catalogSha256: sourceDigest('catalog'),
  runnerPath: SOURCE_INPUTS.runner, runnerSha256: sourceDigest('runner'),
  graphRuntimePath: SOURCE_INPUTS.graphRuntime, graphRuntimeSha256: sourceDigest('graphRuntime'),
  knowledgeStorePath: SOURCE_INPUTS.knowledgeStore, knowledgeStoreSha256: sourceDigest('knowledgeStore'),
  oraclePath: SOURCE_INPUTS.oracle, oracleSha256: sourceDigest('oracle'),
  statisticsPath: SOURCE_INPUTS.statistics, statisticsSha256: sourceDigest('statistics'),
  planPath: SOURCE_INPUTS.plan, planSha256: sourceDigest('plan'),
  freezePath: SOURCE_INPUTS.freeze, freezeSha256: sourceDigest('freeze'),
  ledgerIntegrityPath: SOURCE_INPUTS.ledgerIntegrity, ledgerIntegritySha256: sourceDigest('ledgerIntegrity'),
  ledgerVerifierPath: SOURCE_INPUTS.ledgerVerifier, ledgerVerifierSha256: sourceDigest('ledgerVerifier'),
  strictJsonPath: SOURCE_INPUTS.strictJson, strictJsonSha256: sourceDigest('strictJson')
};
const sourceSetSha256 = sha256(JSON.stringify(provenance));
const taskGraphInstancesSha256 = sha256(JSON.stringify(taskInstances));
const budgetPolicy = {
  frozenUnit: config.equalBudgetUnit,
  maxDepth: config.maxDepth,
  maxExpansionsPerMethod: config.maxExpansions,
  scope: 'successor-expansion-counter-only',
  heuristicPreprocessingCharged: false,
  wallAndCpuMeasurePreprocessing: true,
  totalComputeBudgetEqualized: false
};
const configuration = {
  benchmark: catalog.fixtureId,
  catalogSeed: catalog.baseSeed,
  config,
  methods: methodSpecs.map(spec => ({ methodKey: `${spec.method}:${spec.beamWidth ?? '-'}`, ...spec })),
  budgetPolicy,
  corpusSha256: provenance.catalogSha256,
  graderSha256: provenance.oracleSha256,
  datasetRole: 'frozen-synthetic-development-regression-only; no owner-approved holdout partition is declared'
};
const configurationSha256 = sha256(JSON.stringify(configuration));
for (const row of records) {
  row.configurationSha256 = configurationSha256;
  row.taskGraphInstancesSha256 = taskGraphInstancesSha256;
  row.sourceSetSha256 = sourceSetSha256;
  row.graderSha256 = provenance.oracleSha256;
}

const output = {
  schemaVersion: 5,
  benchmark: catalog.fixtureId,
  taskCount: taskCatalog.length,
  catalogSeed: catalog.baseSeed,
  deterministic: true,
  modelCalls: 0,
  networkCalls: 0,
  monetaryCost: null,
  tokenCost: null,
  config,
  configuration,
  datasetDesign: {
    datasetRole: 'frozen synthetic development/regression only; not an owner-approved holdout and not operational A/B evidence',
    templateCount: taskCatalog.length,
    independentTaskFamilyCount: new Set(taskCatalog.map(task => task.familyId)).size,
    graphInstanceCount: taskInstances.length,
    methodTrials: records.length,
    taskUnit: 'task template/variant; task-family is the cluster used for uncertainty estimates',
    graphInstanceUnit: 'task template/variant regenerated under a fixed repeat seed; seed variants share task-family structure and are not independent task families',
    developmentSet: 'the complete frozen 28-template synthetic regression catalog',
    holdout: 'not declared or claimed; owner approval is required before introducing an acceptance holdout',
    initialState: 'the exact validated input graph embedded on each taskInstance record; every paired method receives the same graph hash',
    retryPolicy: 'no retries; deterministic local algorithm calls execute once per task-instance/method pair; exceptions fail the run rather than being silently replaced',
    timeoutPolicy: 'no per-method timeout in this in-process algorithm benchmark; the outer test process has a bounded timeout',
    successContract: 'solution tasks require an oracle-valid goal path, prerequisite ordering, non-conflicting nodes, required route stages and declared evidence references; no-solution counts only when the method explicitly reports exhaustive completion and the oracle proves zero valid paths',
    modelAndNetworkCalls: 0
  },
  environment: {
    nodeVersion: process.version,
    v8Version: process.versions.v8,
    platform: process.platform,
    architecture: process.arch,
    osRelease: process.release?.name ?? null
  },
  budgetAccounting: {
    ...budgetPolicy,
    interpretation: 'The common hard cap applies to the method-specific successor-expansion counter, not total graph-inspection/computation. ToT graph-wide reverse-distance preprocessing is separately counted in heuristicPreprocessingEdgeVisits and is included in whole-method wall/CPU time but is not charged against maxExpansions. CoT lookahead/filtering and other implementation-specific work also differ. Interpret success under the frozen successor-expansion cap together with wall/CPU measurements; this run does not claim equal total computation.',
    preprocessingCountedInFrozenExpansionBudget: false,
    wallAndCpuMeasureWholeSynchronousMethod: true
  },
  resourceTelemetry: {
    perRunCpuClock: 'process.resourceUsage userCPUTime/systemCPUTime delta; milliseconds, measured immediately before/after the synchronous method call',
    perRunMemory: 'process.memoryUsage RSS and heap-used snapshots immediately before/after the method call; not a per-run peak or causal allocation count',
    processMaxRssKiBAtExit: process.resourceUsage().maxRSS,
    rssBytesAtExit: process.memoryUsage().rss,
    heapUsedBytesAtExit: process.memoryUsage().heapUsed,
    caveat: 'process maximum RSS is a whole-benchmark process high-water mark and cannot be attributed to one method; sampled memory can miss transient peaks. The successor-expansion budget is not a total-computation budget; whole-method CPU/wall time includes preprocessing and method-specific overhead.'
  },
  provenance,
  integrity: {
    configurationSha256,
    taskGraphInstancesSha256,
    sourceSetSha256,
    graderSha256: provenance.oracleSha256,
    recordIdentity: 'trialId = taskInstanceId + methodKey; duplicate identities are invalid',
    rawLedger: 'per-task-instance, method and seed records are embedded in raw JSON; output files receive a SHA-256 sidecar manifest'
  },
  methods: {
    'cot-linear:-': { algorithm: 'single-chain greedy with one-step continuation scoring; no alternative retention/backtracking', modelBacked: false, description: 'CoT-style deterministic linear baseline, not an LLM-generated CoT run', inputs: 'graph only; no oracle or expected-path fields' },
    'tot-tree:-': { algorithm: 'best-first tree of explicit partial paths with graph-only heuristic, seeded tie-break and frontier-based alternative exploration', modelBacked: false, description: 'actual tree-search implementation; not an LLM-generated ToT run', inputs: 'graph only; no oracle or expected-path fields' },
    'agg-beam:1': { algorithm: 'searchAdaptiveGoalGraph', modelBacked: false, beamWidth: 1 },
    'agg-beam:2': { algorithm: 'searchAdaptiveGoalGraph', modelBacked: false, beamWidth: 2 },
    'agg-beam:4': { algorithm: 'searchAdaptiveGoalGraph', modelBacked: false, beamWidth: 4 }
  },
  taskCatalog: taskCatalog.map(task => ({ id: task.id, familyId: task.familyId, title: task.title, seed: task.seed, variant: task.variant,
    expectedOutcome: task.oracle.outcome, oracle: task.oracle,
    requiredEvidenceTypes: task.requiredEvidenceTypes, requiredEvidenceRefs: task.requiredEvidenceRefs, requiredStageNodeIds: task.requiredStageNodeIds,
    acceptableRouteStageSets: task.acceptableRouteStageSets, expectedPath: task.expectedPath,
    forbiddenNodeIds: task.forbiddenNodeIds, graph: task.graph })),
  taskInstances,
  reuse,
  summaries,
  inference,
  interpretationNotes: {
    equalBudget: `All methods receive the same maxDepth=${config.maxDepth} and maxExpansions=${config.maxExpansions} cap on the search's method-specific successor-expansion counter. This is not a total graph-inspection/computation budget: ToT's graph-wide heuristic preprocessing is reported separately and not charged against maxExpansions, while wall/CPU time includes it; CoT lookahead and graph filtering also have method-specific work. Interpret success under the frozen expansion cap together with whole-method wall/CPU measurements. No equal-total-compute claim is made. Methods can terminate early.`,
    estimatedPathCost: 'sum of explicitly supplied unverified node cost estimates; not calibrated monetary/model cost',
    runtime: 'host-dependent process.hrtime wall-clock plus process.resourceUsage CPU deltas; RSS/heap are pre/post snapshots and process maxRSS is whole-process high-water only',
    evidence: 'evidence reference coverage is oracle-checkable; claim truth and independent attestation are never verified here',
    groundTruth: 'the fixture oracle is checked before each run and validates path completion, transitions, required prerequisite ordering, evidence reference coverage, forbidden decoys and contradiction exclusion',
    inference: 'paired family-cluster percentile bootstrap intervals resample seven related synthetic task families and are descriptive only; intervals containing zero are inconclusive, not proof of equivalence; no power-based sample-size estimate is made from the current seven-cluster synthetic set or one-task model pilot',
    acceptanceBoundary: 'docs/plugin-workflow-benchmark-plan.md specifies plugin-enabled versus basic-tools A/B across ten scenarios and a 100-point operational rubric; this AGG graph benchmark is not that A/B, and no distinct numerical AGG acceptance threshold was found in the checked-in AGG planning material',
    recovery: 'nominal search intentionally excludes recovers_to. Optional recovery edges are counted as deferred by AGG rather than treated as success transitions.'
  },
  summariesAndRawRuns: { iterationsPerTaskMethod: config.iterations, unscoredWarmupRuns: methodSpecs.length, scoredRuns: records.length,
    taskGraphInstances: taskInstances.length,
    taskFamilyCount: new Set(taskCatalog.map(task => task.familyId)).size, unsatisfiableTaskCount: taskCatalog.filter(task => task.oracle.outcome === 'no_solution').length }
};
output.records = records;
assertSourceInputSnapshotStillMatches();
const serialized = `${JSON.stringify(output, null, 2)}\n`;
if (outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const fd = fs.openSync(outputPath, 'wx', 0o600);
  try { fs.writeFileSync(fd, serialized, 'utf8'); } finally { fs.closeSync(fd); }
} else process.stdout.write(serialized);
if (reportPath) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const fd = fs.openSync(reportPath, 'wx', 0o600);
  try { fs.writeFileSync(fd, markdownReport(output), 'utf8'); } finally { fs.closeSync(fd); }
}
assertSourceInputSnapshotStillMatches();
if (outputPath && manifestPath) {
  const completedAt = new Date().toISOString();
  const describeFile = filePath => ({
    path: path.relative(repo, filePath),
    sha256: sha256(fs.readFileSync(filePath)),
    bytes: fs.statSync(filePath).size
  });
  const manifest = {
    manifestSchemaVersion: 1,
    runId: `agg-phase1-${sha256(`${runStartedAt}|${process.pid}|${serialized}`).slice(0, 24)}`,
    startedAt: runStartedAt,
    completedAt,
    exitCode: 0,
    decision: 'SUPPLEMENTAL_EVIDENCE_NOT_ACCEPTANCE',
    command: [process.execPath, ...process.argv.slice(1)],
    benchmark: output.benchmark,
    nodeVersion: process.version,
    outputs: {
      raw: describeFile(outputPath),
      ...(reportPath ? { report: describeFile(reportPath) } : {})
    },
    counts: {
      taskTemplates: output.taskCount,
      taskFamilyClusters: output.datasetDesign.independentTaskFamilyCount,
      taskGraphInstances: output.taskInstances.length,
      scoredTrials: output.records.length,
      methodKeys: Object.keys(output.methods).sort(),
      repeatSeeds: [...output.config.repeatSeeds]
    },
    hashes: {
      configurationSha256: output.integrity.configurationSha256,
      taskGraphInstancesSha256: output.integrity.taskGraphInstancesSha256,
      sourceSetSha256: output.integrity.sourceSetSha256,
      graderSha256: output.integrity.graderSha256,
      catalogSha256: output.provenance.catalogSha256
    },
    provenance: output.provenance
  };
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const fd = fs.openSync(manifestPath, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'); } finally { fs.closeSync(fd); }
  process.stderr.write(`PHASE1_MANIFEST=${path.relative(repo, manifestPath)}\n`);
}
