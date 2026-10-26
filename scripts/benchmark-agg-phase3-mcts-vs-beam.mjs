#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseStrictJson } from '../src/runtime/strict-json.js';
import { canonicalJson } from '../src/runtime/canonical-json.js';
import { readStableRegularFile, writeFileExclusiveAtomic } from '../src/runtime/exclusive-file.js';
import { trainAdaptiveGoalDiscriminator, validateAdaptiveGoalDiscriminatorModel } from '../src/runtime/adaptive-goal-discriminator.js';
import { validateAdaptiveGoalPhase2Dataset, validateAdaptiveGoalPhase2ModelArtifact } from '../src/runtime/adaptive-goal-phase2-dataset.js';
import { createAdaptiveGoalDiscriminatorExample, searchAdaptiveGoalGraphPhase2 } from '../src/runtime/adaptive-goal-phase2-search.js';
import { validateAdaptiveGoalGraph } from '../src/runtime/adaptive-goal-graph.js';
import { searchAdaptiveGoalGraphPhase3MCTS } from '../src/runtime/adaptive-goal-phase3-mcts.js';

const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_ORACLE_STATES = 100_000;
const MAX_ORACLE_EDGE_CHECKS = 1_000_000;
const MAX_TOTAL_ORACLE_STATES = 500_000;
const MAX_TOTAL_ORACLE_EDGE_CHECKS = 2_000_000;
const MAX_ORACLE_PATHS_PER_CASE = 100;
const MAX_TOTAL_ORACLE_PATHS = 5_000;
const MAX_TOTAL_GRAPH_NODES = 50_000;
const MAX_TOTAL_GRAPH_EDGES = 100_000;
const MAX_CASES = 1000;
const MAX_SEEDS = 20;
const MAX_TOTAL_TRIALS = 10_000;
const MAX_TOTAL_SIMULATIONS = 500_000;
const MAX_TOTAL_WORK_UNITS = 20_000_000;
const BOOTSTRAP_REPLICATES = 10_000;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceHash = relative => hash(fs.readFileSync(path.join(repoRoot, relative)));
const args = process.argv.slice(2);
const values = new Map();
const allowed = [
  '--corpus', '--dataset', '--model', '--output', '--beam-width', '--simulations', '--seeds',
  '--max-depth', '--max-expansions', '--max-work-units', '--max-audit-events', '--max-tree-nodes', '--max-terminal-paths'
];
for (let index = 0; index < args.length; index++) {
  const key = args[index];
  if (key === '--help') {
    console.log('Usage: node scripts/benchmark-agg-phase3-mcts-vs-beam.mjs --corpus CORPUS.json --dataset DATASET.json --model MODEL.json --output NEW_BENCHMARK.json [--beam-width N] [--simulations N] [--seeds 101,202,303,404,505] [--max-depth N] [--max-expansions N] [--max-work-units N] [--max-audit-events N] [--max-tree-nodes N] [--max-terminal-paths N]\n\nRuns repeated, paired Phase 2 discriminator beam vs Phase 3 MCTS trials on each identical graph/oracle, validates model against its exact dataset bytes and replays training identity, validates labelled goal paths, and exhaustively re-derives no-solution labels within fixed oracle enumeration limits. Seed repeats are clustered by task for a deterministic bootstrap interval. Synthetic/caller-declared data remains diagnostic; no metrics authorize execution or acceptance.');
    process.exit(0);
  }
  if (!allowed.includes(key)) throw new Error(`Unknown argument: ${key}`);
  if (values.has(key)) throw new Error(`Duplicate argument: ${key}`);
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
  values.set(key, args[++index]);
}
for (const key of ['--corpus', '--dataset', '--model', '--output']) if (!values.has(key)) throw new Error(`Required argument missing: ${key}`);
const integerOption = (key, fallback, min, max) => {
  const value = values.has(key) ? Number(values.get(key)) : fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer in [${min}, ${max}]`);
  return value;
};
const seedsText = values.get('--seeds') ?? '101,202,303,404,505';
const seeds = seedsText.split(',').map(value => {
  if (!/^\d+$/.test(value.trim())) throw new Error('--seeds must be a comma-separated list of non-negative safe integers');
  const seed = Number(value.trim());
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('--seeds entries must be non-negative safe integers');
  return seed;
});
if (!seeds.length || seeds.length > MAX_SEEDS || new Set(seeds).size !== seeds.length) throw new Error(`--seeds must contain 1-${MAX_SEEDS} unique seeds`);
const options = {
  beamWidth: integerOption('--beam-width', 4, 1, 100),
  maxSimulations: integerOption('--simulations', 128, 1, 10000),
  maxDepth: integerOption('--max-depth', 12, 1, 100),
  maxExpansions: integerOption('--max-expansions', 128, 1, 10000),
  maxWorkUnits: integerOption('--max-work-units', 100000, 2, 1000000),
  maxAuditEvents: integerOption('--max-audit-events', 2000, 1, 5000),
  maxTreeNodes: integerOption('--max-tree-nodes', 2048, 1, 10001),
  maxTerminalPaths: integerOption('--max-terminal-paths', 2048, 1, 10000)
};
const outputPath = path.resolve(values.get('--output'));
const outputParent = path.dirname(outputPath);
const parentStat = fs.lstatSync(outputParent, { throwIfNoEntry: false });
if (!parentStat?.isDirectory() || parentStat.isSymbolicLink() || fs.realpathSync(outputParent) !== outputParent || fs.existsSync(outputPath)) {
  throw new Error('Output must be a new file in an existing canonical non-symlink directory');
}
function readJson(filePath, label) {
  const bytes = readStableRegularFile(path.resolve(filePath), { maxBytes: MAX_INPUT_BYTES, label });
  return { path: path.resolve(filePath), bytes, value: parseStrictJson(bytes, label, { maxBytes: MAX_INPUT_BYTES }) };
}
const corpusFile = readJson(values.get('--corpus'), 'Phase 3 paired benchmark corpus');
const corpus = corpusFile.value;
const exact = (object, keys, label) => {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error(`${label} must be an object`);
  const extra = Object.keys(object).filter(key => !keys.includes(key));
  if (extra.length) throw new Error(`${label} has unsupported fields: ${extra.sort().join(', ')}`);
};
exact(corpus, ['schemaVersion', 'corpusId', 'provenance', 'cases'], 'corpus');
if (corpus.schemaVersion !== 1 || typeof corpus.corpusId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(corpus.corpusId)) {
  throw new Error('Invalid benchmark corpus envelope');
}
exact(corpus.provenance, ['kind', 'source', 'adjudicatorId', 'protocol', 'independent'], 'corpus.provenance');
if (!['synthetic', 'independently_adjudicated'].includes(corpus.provenance.kind) || typeof corpus.provenance.source !== 'string' || !corpus.provenance.source.trim()) {
  throw new Error('Corpus provenance must explicitly declare synthetic or independently_adjudicated and a source');
}
if (corpus.provenance.kind === 'independently_adjudicated' && (corpus.provenance.independent !== true ||
    typeof corpus.provenance.adjudicatorId !== 'string' || !corpus.provenance.adjudicatorId.trim() ||
    typeof corpus.provenance.protocol !== 'string' || !corpus.provenance.protocol.trim())) {
  throw new Error('Independent corpus metadata requires adjudicator, protocol, and independent:true; this is not a signature');
}
if (!Array.isArray(corpus.cases) || corpus.cases.length < 1 || corpus.cases.length > MAX_CASES) throw new Error(`Corpus cases must contain 1-${MAX_CASES} cases`);
if (corpus.cases.length * seeds.length > MAX_TOTAL_TRIALS) throw new Error(`cases × seeds exceeds ${MAX_TOTAL_TRIALS} paired trials`);
if (corpus.cases.length * seeds.length * options.maxSimulations > MAX_TOTAL_SIMULATIONS) throw new Error(`cases × seeds × simulations exceeds ${MAX_TOTAL_SIMULATIONS}`);
if (corpus.cases.length * seeds.length * options.maxWorkUnits > MAX_TOTAL_WORK_UNITS) throw new Error(`cases × seeds × maxWorkUnits exceeds ${MAX_TOTAL_WORK_UNITS}`);

const datasetFile = readJson(values.get('--dataset'), 'Phase 3 model training dataset');
const dataset = validateAdaptiveGoalPhase2Dataset(datasetFile.value);
const modelFile = readJson(values.get('--model'), 'Phase 3 discriminator model artifact');
const modelArtifact = validateAdaptiveGoalPhase2ModelArtifact(modelFile.value);
const model = validateAdaptiveGoalDiscriminatorModel(modelArtifact.model);
const expectedModelSources = {
  trainerCliSha256: sourceHash('scripts/train-agg-phase2-discriminator.mjs'),
  discriminatorSha256: sourceHash('src/runtime/adaptive-goal-discriminator.js'),
  datasetValidatorSha256: sourceHash('src/runtime/adaptive-goal-phase2-dataset.js'),
  strictJsonParserSha256: sourceHash('src/runtime/strict-json.js'),
  canonicalJsonSha256: sourceHash('src/runtime/canonical-json.js')
};
if (canonicalJson(modelArtifact.sourceIdentity) !== canonicalJson(expectedModelSources)) throw new Error('Stale model source identity; retrain from the current Phase 2 source tree');
if (modelArtifact.datasetFileSha256 !== hash(datasetFile.bytes) || modelArtifact.datasetSha256 !== dataset.datasetSha256 ||
    modelArtifact.datasetId !== dataset.datasetId || canonicalJson(modelArtifact.splitIdentities) !== canonicalJson(dataset.splits) ||
    canonicalJson(modelArtifact.labelProvenance) !== canonicalJson(dataset.labelProvenance)) {
  throw new Error('Model artifact is not bound to the exact dataset bytes/splits/provenance supplied to this benchmark');
}
const replayedTraining = trainAdaptiveGoalDiscriminator({
  trainingExamples: dataset.trainingExamples,
  validationExamples: dataset.validationExamples,
  ...model.trainingConfig,
  datasetId: dataset.datasetId
});
if (replayedTraining.model.modelSha256 !== model.modelSha256 || canonicalJson(replayedTraining.model) !== canonicalJson(model)) {
  throw new Error('Model identity does not replay from the bound training split and recorded training configuration');
}

// Independently re-derive reachability for no-solution claims. This deliberately
// does not import either production search implementation.
function enumerateFeasibleGoalPaths(graphInput, { maxStates, maxEdgeChecks, maxGoalPaths }) {
  const graph = validateAdaptiveGoalGraph(graphInput);
  const transitions = new Map(graph.nodes.map(node => [node.id, []]));
  const requirements = new Map(graph.nodes.map(node => [node.id, []]));
  const conflicts = graph.edges.filter(edge => ['contradicts', 'alternative_to'].includes(edge.type));
  for (const edge of graph.edges) {
    if (['next_step', 'enables'].includes(edge.type)) transitions.get(edge.from).push(edge.to);
    if (edge.type === 'requires_all') requirements.get(edge.to).push(edge.from);
    if (edge.type === 'depends_on') requirements.get(edge.from).push(edge.to);
  }
  let states = 0, edgeChecks = 0, limitReached = false;
  const goalPaths = [];
  const walk = pathIds => {
    if (limitReached) return;
    states++;
    if (states > maxStates) { limitReached = true; return; }
    const current = pathIds.at(-1);
    if (current === graph.goalNodeId) {
      if (goalPaths.length >= maxGoalPaths) { limitReached = true; return; }
      goalPaths.push([...pathIds]); return;
    }
    for (const next of transitions.get(current)) {
      edgeChecks++;
      if (edgeChecks > maxEdgeChecks) { limitReached = true; return; }
      if (pathIds.includes(next)) continue;
      const prior = new Set(pathIds);
      if (requirements.get(next).some(required => !prior.has(required))) continue;
      const conflict = conflicts.some(edge =>
        (edge.from === next && prior.has(edge.to)) || (edge.to === next && prior.has(edge.from)));
      if (conflict) continue;
      walk([...pathIds, next]);
      if (limitReached) return;
    }
  };
  walk([graph.startNodeId]);
  return { graph, goalPaths, states, edgeChecks, exhaustive: !limitReached };
}

function validateDeclaredOracleGoalPath(graphInput, pathNodeIds, caseId) {
  const graph = validateAdaptiveGoalGraph(graphInput);
  if (!Array.isArray(pathNodeIds) || pathNodeIds.length < 2 ||
      pathNodeIds.some(id => typeof id !== 'string' || !id) ||
      pathNodeIds[0] !== graph.startNodeId || pathNodeIds.at(-1) !== graph.goalNodeId) {
    throw new Error(`Oracle path for ${caseId} must begin at startNodeId and end at goalNodeId`);
  }
  if (new Set(pathNodeIds).size !== pathNodeIds.length) throw new Error(`Oracle path for ${caseId} repeats a node`);
  const nominal = new Set(graph.edges.filter(edge => ['next_step', 'enables'].includes(edge.type))
    .map(edge => `${edge.from}\0${edge.to}`));
  const prerequisites = new Map(graph.nodes.map(node => [node.id, []]));
  for (const edge of graph.edges) {
    if (edge.type === 'requires_all') prerequisites.get(edge.to).push(edge.from);
    if (edge.type === 'depends_on') prerequisites.get(edge.from).push(edge.to);
  }
  const conflicts = graph.edges.filter(edge => ['contradicts', 'alternative_to'].includes(edge.type));
  const visited = new Set();
  for (const [position, nodeId] of pathNodeIds.entries()) {
    if (position > 0 && !nominal.has(`${pathNodeIds[position - 1]}\0${nodeId}`)) {
      throw new Error(`Oracle path for ${caseId} uses a missing or non-nominal transition at ${pathNodeIds[position - 1]} -> ${nodeId}`);
    }
    const missing = prerequisites.get(nodeId).filter(required => !visited.has(required));
    if (missing.length) throw new Error(`Oracle path for ${caseId} violates prerequisites at ${nodeId}: ${missing.join(', ')}`);
    const conflict = conflicts.find(edge => (edge.from === nodeId && visited.has(edge.to)) || (edge.to === nodeId && visited.has(edge.from)));
    if (conflict) throw new Error(`Oracle path for ${caseId} contains contradictory nodes ${conflict.from} and ${conflict.to}`);
    visited.add(nodeId);
  }
  return { pathNodeIds: [...pathNodeIds], pathDepth: pathNodeIds.length - 1 };
}

const caseIds = new Set(), graphHashes = new Set(), outcomeRefs = new Set();
const caseInputs = [];
let noSolutionCasesExhaustivelyReDerived = 0;
let totalGraphNodes = 0, totalGraphEdges = 0;
let totalOracleStates = 0, totalOracleEdgeChecks = 0, totalDeclaredOraclePaths = 0;
const datasetFeatureFingerprints = new Map();
for (const [splitName, examples] of [['training', dataset.trainingExamples], ['validation', dataset.validationExamples], ['holdout', dataset.holdoutExamples]]) {
  for (const example of examples) datasetFeatureFingerprints.set(hash(canonicalJson(example.features)), splitName);
}
const featureOverlapCounts = { training: 0, validation: 0, holdout: 0 };
for (const [index, item] of corpus.cases.entries()) {
  exact(item, ['caseId', 'graph', 'oracle'], `cases[${index}]`);
  if (typeof item.caseId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(item.caseId) || caseIds.has(item.caseId)) throw new Error(`cases[${index}].caseId is invalid or duplicated`);
  caseIds.add(item.caseId);
  exact(item.oracle, ['successfulPathNodeIds', 'outcomeRef'], `cases[${index}].oracle`);
  if (!Array.isArray(item.oracle.successfulPathNodeIds) || typeof item.oracle.outcomeRef !== 'string' || !item.oracle.outcomeRef.trim()) {
    throw new Error(`cases[${index}].oracle must provide successfulPathNodeIds (empty means expected no-solution) and a non-empty outcomeRef`);
  }
  if (outcomeRefs.has(item.oracle.outcomeRef)) throw new Error(`Duplicate oracle outcomeRef across cases: ${item.oracle.outcomeRef}`);
  outcomeRefs.add(item.oracle.outcomeRef);
  const validatedGraph = validateAdaptiveGoalGraph(item.graph);
  totalGraphNodes += validatedGraph.nodes.length;
  totalGraphEdges += validatedGraph.edges.length;
  if (totalGraphNodes > MAX_TOTAL_GRAPH_NODES) throw new Error(`Corpus total graph nodes exceed ${MAX_TOTAL_GRAPH_NODES}`);
  if (totalGraphEdges > MAX_TOTAL_GRAPH_EDGES) throw new Error(`Corpus total graph edges exceed ${MAX_TOTAL_GRAPH_EDGES}`);
  if (graphHashes.has(validatedGraph.graphHash)) throw new Error(`Duplicate graph identity across benchmark cases: ${item.caseId}`);
  graphHashes.add(validatedGraph.graphHash);
  const oraclePathKeys = new Set();
  const oracleFeatureRows = [];
  if (item.oracle.successfulPathNodeIds.length > MAX_ORACLE_PATHS_PER_CASE) {
    throw new Error(`Oracle for ${item.caseId} exceeds ${MAX_ORACLE_PATHS_PER_CASE} declared successful paths`);
  }
  totalDeclaredOraclePaths += item.oracle.successfulPathNodeIds.length;
  if (totalDeclaredOraclePaths > MAX_TOTAL_ORACLE_PATHS) throw new Error(`Corpus oracle path count exceeds ${MAX_TOTAL_ORACLE_PATHS}`);
  for (const [pathIndex, pathNodeIds] of item.oracle.successfulPathNodeIds.entries()) {
    validateDeclaredOracleGoalPath(item.graph, pathNodeIds, item.caseId);
    const derived = createAdaptiveGoalDiscriminatorExample({ graph: item.graph, pathNodeIds, id: `oracle-${index}-${pathIndex}`, label: 1 });
    const key = JSON.stringify(pathNodeIds);
    if (oraclePathKeys.has(key)) throw new Error(`cases[${index}].oracle contains a duplicate successful path`);
    oraclePathKeys.add(key);
    oracleFeatureRows.push(derived.features);
    const overlapSplit = datasetFeatureFingerprints.get(hash(canonicalJson(derived.features)));
    if (overlapSplit) featureOverlapCounts[overlapSplit]++;
  }
  let noSolutionAudit = null;
  if (oraclePathKeys.size === 0) {
    noSolutionAudit = enumerateFeasibleGoalPaths(item.graph, {
      maxStates: Math.min(MAX_ORACLE_STATES, MAX_TOTAL_ORACLE_STATES - totalOracleStates),
      maxEdgeChecks: Math.min(MAX_ORACLE_EDGE_CHECKS, MAX_TOTAL_ORACLE_EDGE_CHECKS - totalOracleEdgeChecks),
      maxGoalPaths: MAX_ORACLE_PATHS_PER_CASE
    });
    if (!noSolutionAudit.exhaustive) throw new Error(`No-solution oracle for ${item.caseId} could not be exhaustively checked within fixed limits`);
    if (noSolutionAudit.goalPaths.length > 0) throw new Error(`No-solution oracle contradicts independently enumerated feasible paths for ${item.caseId}`);
    totalOracleStates += noSolutionAudit.states;
    totalOracleEdgeChecks += noSolutionAudit.edgeChecks;
    noSolutionCasesExhaustivelyReDerived++;
  } else {
    // Every declared positive path has already been independently checked for
    // start/goal identity, nominal transitions, prerequisites, cycles and conflicts.
  }
  caseInputs.push({ item, graph: validatedGraph, oraclePathKeys, noSolutionAudit, oracleFeatureRows });
}

const trialCount = caseInputs.length * seeds.length;
const startedAt = performance.now();
const cases = [];
for (const [index, item] of caseInputs.entries()) {
  const trialRecords = [];
  for (const seed of seeds) {
    const beamStarted = performance.now();
    const beam = searchAdaptiveGoalGraphPhase2(item.item.graph, model, {
      beamWidth: options.beamWidth, maxDepth: options.maxDepth,
      maxExpansions: options.maxExpansions, maxAuditEvents: options.maxAuditEvents
    });
    const beamRuntimeMs = performance.now() - beamStarted;
    const mctsStarted = performance.now();
    const mcts = searchAdaptiveGoalGraphPhase3MCTS(item.item.graph, model, {
      maxSimulations: options.maxSimulations, maxDepth: options.maxDepth,
      maxExpansions: options.maxExpansions, maxWorkUnits: options.maxWorkUnits,
      maxAuditEvents: options.maxAuditEvents, maxTreeNodes: options.maxTreeNodes,
      maxTerminalPaths: options.maxTerminalPaths, seed
    });
    const mctsRuntimeMs = performance.now() - mctsStarted;
    const expectedNoSolution = item.oraclePathKeys.size === 0;
    const beamSuccess = expectedNoSolution
      ? beam.status === 'no_solution_found' && beam.search.exhaustive === true
      : beam.candidates.some(candidate => item.oraclePathKeys.has(JSON.stringify(candidate.pathNodeIds)));
    // MCTS is non-exhaustive by contract; it is not credited with proving no solution.
    const mctsSuccess = expectedNoSolution
      ? false
      : mcts.candidates.some(candidate => item.oraclePathKeys.has(JSON.stringify(candidate.pathNodeIds)));
    const returnedCorrectBeam = beam.candidates.find(candidate => item.oraclePathKeys.has(JSON.stringify(candidate.pathNodeIds)));
    const returnedCorrectMcts = mcts.candidates.find(candidate => item.oraclePathKeys.has(JSON.stringify(candidate.pathNodeIds)));
    trialRecords.push({
      seed,
      phase2Beam: {
        success: beamSuccess, status: beam.status, expansions: beam.search.expansions,
        candidateCount: beam.candidates.length, exhaustive: beam.search.exhaustive, runtimeMs: beamRuntimeMs,
        correctCandidateDepth: returnedCorrectBeam?.depth ?? null,
        rejectedEdgeEventsObserved: beam.auditTrace.events.filter(event => event.type === 'edge_rejected').length,
        auditTruncated: beam.auditTrace.truncated
      },
      phase3MCTS: {
        success: mctsSuccess, status: mcts.status, simulations: mcts.search.simulations,
        expansions: mcts.search.expansions, workUnits: mcts.search.workUnits,
        candidateCount: mcts.candidates.length, exhaustive: mcts.search.exhaustive,
        terminationReason: mcts.search.terminationReason, budgetExhausted: mcts.search.budgetExhausted,
        runtimeMs: mctsRuntimeMs, correctCandidateDepth: returnedCorrectMcts?.depth ?? null,
        uctSelectionsObserved: mcts.auditTrace.events.filter(event => event.type === 'uct_select').length,
        rolloutStepsObserved: mcts.auditTrace.events.filter(event => event.type === 'rollout_step').length,
        rejectedEdgeEventsObserved: mcts.auditTrace.events.filter(event => event.type === 'edge_rejected').length,
        auditTruncated: mcts.auditTrace.truncated, searchRunId: mcts.search.searchRunId
      },
      pairedDelta: Number(mctsSuccess) - Number(beamSuccess)
    });
  }
  const successRate = key => trialRecords.filter(record => record[key].success).length / seeds.length;
  cases.push({
    caseId: item.item.caseId,
    graphHash: item.graph.graphHash,
    inputGraphFileCanonicalSha256: hash(canonicalJson(item.item.graph)),
    oracleRef: item.item.oracle.outcomeRef,
    oracleSuccessfulPathNodeIds: item.item.oracle.successfulPathNodeIds,
    expectedOutcome: item.oraclePathKeys.size ? 'goal_path' : 'no_solution',
    oracleValidation: item.noSolutionAudit
      ? { status: 'NO_SOLUTION_EXHAUSTIVELY_REDERIVED', enumeratedGoalPathCount: 0, states: item.noSolutionAudit.states, edgeChecks: item.noSolutionAudit.edgeChecks }
      : { status: 'DECLARED_GOAL_PATHS_VALIDATED', validatedPathCount: item.oraclePathKeys.size, groundTruthAttestationPresent: false },
    phase2Beam: {
      successes: trialRecords.filter(record => record.phase2Beam.success).length,
      successRateAcrossSeeds: successRate('phase2Beam'),
      meanExpansions: mean(trialRecords.map(record => record.phase2Beam.expansions)),
      meanRuntimeMs: mean(trialRecords.map(record => record.phase2Beam.runtimeMs)),
      meanCorrectCandidateDepth: meanNullable(trialRecords.map(record => record.phase2Beam.correctCandidateDepth))
    },
    phase3MCTS: {
      successes: trialRecords.filter(record => record.phase3MCTS.success).length,
      successRateAcrossSeeds: successRate('phase3MCTS'),
      meanSimulations: mean(trialRecords.map(record => record.phase3MCTS.simulations)),
      meanExpansions: mean(trialRecords.map(record => record.phase3MCTS.expansions)),
      meanWorkUnits: mean(trialRecords.map(record => record.phase3MCTS.workUnits)),
      meanRuntimeMs: mean(trialRecords.map(record => record.phase3MCTS.runtimeMs)),
      meanCorrectCandidateDepth: meanNullable(trialRecords.map(record => record.phase3MCTS.correctCandidateDepth)),
      budgetExhaustedRuns: trialRecords.filter(record => record.phase3MCTS.budgetExhausted).length
    },
    meanPairedDelta: mean(trialRecords.map(record => record.pairedDelta)),
    trials: trialRecords
  });
}

function mean(values) { return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length); }
function meanNullable(values) { const known = values.filter(value => typeof value === 'number' && Number.isFinite(value)); return known.length ? mean(known) : null; }
function wilson(successes, total) {
  const p = successes / total, z = 1.959963984540054, denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin), method: 'wilson_score_pooled_trial_observations_descriptive_only' };
}
function createPrng(seedText) {
  let counter = 0;
  return () => createHash('sha256').update(`${seedText}|${counter++}`).digest().readUIntBE(0, 6) / 0x1_0000_0000_0000;
}
function percentile(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]; }
function clusterBootstrap(caseValues, seedText) {
  const random = createPrng(seedText);
  const rateDiffSamples = [], beamRateSamples = [], mctsRateSamples = [];
  for (let replicate = 0; replicate < BOOTSTRAP_REPLICATES; replicate++) {
    let beam = 0, mcts = 0, delta = 0;
    for (let index = 0; index < caseValues.length; index++) {
      const selected = caseValues[Math.floor(random() * caseValues.length)];
      beam += selected.beam;
      mcts += selected.mcts;
      delta += selected.delta;
    }
    beamRateSamples.push(beam / caseValues.length);
    mctsRateSamples.push(mcts / caseValues.length);
    rateDiffSamples.push(delta / caseValues.length);
  }
  beamRateSamples.sort((a, b) => a - b); mctsRateSamples.sort((a, b) => a - b); rateDiffSamples.sort((a, b) => a - b);
  return {
    method: 'deterministic_task_cluster_bootstrap_percentile_95_descriptive', replicates: BOOTSTRAP_REPLICATES,
    beamSuccessRateCI95: { lower: percentile(beamRateSamples, 0.025), upper: percentile(beamRateSamples, 0.975) },
    mctsSuccessRateCI95: { lower: percentile(mctsRateSamples, 0.025), upper: percentile(mctsRateSamples, 0.975) },
    pairedDeltaCI95: { lower: percentile(rateDiffSamples, 0.025), upper: percentile(rateDiffSamples, 0.975) }
  };
}

const allTrials = cases.flatMap(item => item.trials.map(trial => ({ ...trial, caseId: item.caseId, expectedOutcome: item.expectedOutcome })));
const beamSuccesses = allTrials.filter(item => item.phase2Beam.success).length;
const mctsSuccesses = allTrials.filter(item => item.phase3MCTS.success).length;
const goalPathTrials = allTrials.filter(item => item.expectedOutcome === 'goal_path');
const noSolutionTrials = allTrials.filter(item => item.expectedOutcome === 'no_solution');
const goalPathBeamSuccesses = goalPathTrials.filter(item => item.phase2Beam.success).length;
const goalPathMctsSuccesses = goalPathTrials.filter(item => item.phase3MCTS.success).length;
const goalPathPairedDeltas = goalPathTrials.map(item => item.pairedDelta);
const goalPathPairedOutcomes = {
  bothSuccess: goalPathTrials.filter(item => item.phase2Beam.success && item.phase3MCTS.success).length,
  mctsOnly: goalPathTrials.filter(item => !item.phase2Beam.success && item.phase3MCTS.success).length,
  beamOnly: goalPathTrials.filter(item => item.phase2Beam.success && !item.phase3MCTS.success).length,
  bothFail: goalPathTrials.filter(item => !item.phase2Beam.success && !item.phase3MCTS.success).length
};
const phase2NoSolutionProofs = noSolutionTrials.filter(item => item.phase2Beam.status === 'no_solution_found' && item.phase2Beam.exhaustive).length;
const phase3NoSolutionProofs = noSolutionTrials.filter(item => item.phase3MCTS.status === 'no_solution_found' && item.phase3MCTS.exhaustive).length;
const mixedOutcomePairedOutcomes = {
  bothSuccess: allTrials.filter(item => item.phase2Beam.success && item.phase3MCTS.success).length,
  mctsOnly: allTrials.filter(item => !item.phase2Beam.success && item.phase3MCTS.success).length,
  beamOnly: allTrials.filter(item => item.phase2Beam.success && !item.phase3MCTS.success).length,
  bothFail: allTrials.filter(item => !item.phase2Beam.success && !item.phase3MCTS.success).length
};
const pairedDeltas = allTrials.map(item => item.pairedDelta);
const taskClusterValues = cases.map(item => ({
  caseId: item.caseId,
  expectedOutcome: item.expectedOutcome,
  beam: item.phase2Beam.successRateAcrossSeeds,
  mcts: item.phase3MCTS.successRateAcrossSeeds,
  delta: item.meanPairedDelta
}));
const outcomes = { goalPath: cases.filter(item => item.expectedOutcome === 'goal_path').length, noSolution: cases.filter(item => item.expectedOutcome === 'no_solution').length };
const bootstrapSeedText = `${hash(corpusFile.bytes)}|${model.modelSha256}|${seeds.join(',')}|${options.seed ?? ''}`;
const clusterIntervals = taskClusterValues.length ? clusterBootstrap(taskClusterValues, bootstrapSeedText) : null;
const goalPathTaskClusterValues = taskClusterValues.filter(item => item.expectedOutcome === 'goal_path');
const goalPathClusterIntervals = goalPathTaskClusterValues.length
  ? clusterBootstrap(goalPathTaskClusterValues, `${bootstrapSeedText}|goal_path_only`) : null;
const outcomeDominance = Math.max(outcomes.goalPath, outcomes.noSolution) / cases.length;
const qualityFlags = [];
if (cases.length < 20) qualityFlags.push('CORPUS_TOO_SMALL_LT_20_TASKS');
if (cases.length > 30) qualityFlags.push('CORPUS_OUTSIDE_RECOMMENDED_20_TO_30_TASKS');
if (corpus.provenance.kind === 'synthetic') qualityFlags.push('SYNTHETIC_CORPUS_NOT_OPERATIONAL_EVIDENCE');
if (corpus.provenance.independent !== true || corpus.provenance.kind !== 'independently_adjudicated') qualityFlags.push('INDEPENDENT_ADJUDICATION_NOT_ESTABLISHED');
if (outcomeDominance > 0.8) qualityFlags.push('OUTCOME_CLASS_IMBALANCE_GT_80_PERCENT');
if (Object.values(featureOverlapCounts).some(count => count > 0)) qualityFlags.push('POSSIBLE_DEVELOPMENT_EVALUATION_FEATURE_OVERLAP');
qualityFlags.push('TASK_LEVEL_DISJOINTNESS_FROM_DATASET_NOT_PROVABLE_FROM_FEATURE_ONLY_DATASET_SCHEMA');
qualityFlags.push('NO_OWNER_SIGNATURE_OR_OUT_OF_BAND_TRUST_ROOT_FOR_CORPUS');

const result = {
  schemaVersion: 1,
  kind: 'agg_phase3_mcts_vs_phase2_beam_paired_benchmark',
  corpusId: corpus.corpusId,
  corpusFileSha256: hash(corpusFile.bytes),
  corpusProvenance: { ...corpus.provenance, independentAttestationPresent: false, trustedOwnerSignaturePresent: false, trustedRootProvisioned: false },
  datasetFileSha256: hash(datasetFile.bytes), datasetId: dataset.datasetId, datasetSha256: dataset.datasetSha256,
  modelArtifactSha256: hash(modelFile.bytes), modelSha256: model.modelSha256,
  featureSchemaVersion: dataset.featureSchemaVersion, splitIdentities: dataset.splits,
  modelIdentityAssessment: {
    modelArtifactHashValidated: true, exactDatasetBytesMatched: true, sourceIdentityMatchedCurrentSource: true,
    deterministicTrainingReplayMatched: true, trainingSplitOnlyFittingPathBound: true,
    modelTrustRootProvisioned: false, independentTrainingLabelAttestationPresent: false
  },
  datasetOverlapAssessment: {
    splitInternalDisjointnessValidated: true,
    exactOracleFeatureVectorOverlaps: featureOverlapCounts,
    exactOracleFeatureVectorOverlapCount: Object.values(featureOverlapCounts).reduce((sum, count) => sum + count, 0),
    taskLevelGraphDisjointnessFromTrainingAndEvaluationRows: 'NOT_VERIFIABLE_SCHEMA_HAS_NO_TASK_OR_GRAPH_IDENTIFIERS'
  },
  runtime: { nodeVersion: process.version, platform: process.platform, architecture: process.arch },
  sourceIdentity: {
    benchmarkCliSha256: sourceHash('scripts/benchmark-agg-phase3-mcts-vs-beam.mjs'),
    phase3MctsSha256: sourceHash('src/runtime/adaptive-goal-phase3-mcts.js'),
    phase2SearchSha256: sourceHash('src/runtime/adaptive-goal-phase2-search.js'),
    discriminatorSha256: sourceHash('src/runtime/adaptive-goal-discriminator.js'),
    datasetValidatorSha256: sourceHash('src/runtime/adaptive-goal-phase2-dataset.js'),
    graphValidatorSha256: sourceHash('src/runtime/adaptive-goal-graph.js'),
    strictJsonParserSha256: sourceHash('src/runtime/strict-json.js'),
    canonicalJsonSha256: sourceHash('src/runtime/canonical-json.js')
  },
  pairedConfig: {
    ...options, seeds, sameGraphHashPerTaskPair: true, sameDepthCap: true, sameEdgeExpansionCap: true,
    phase2AndPhase3BothRepeatedForEverySeed: true, operatingMode: 'offline_shadow',
    independentNoSolutionEnumerationLimits: { states: MAX_ORACLE_STATES, edgeChecks: MAX_ORACLE_EDGE_CHECKS },
    totalBudgetGuards: { maxTrials: MAX_TOTAL_TRIALS, maxTotalSimulations: MAX_TOTAL_SIMULATIONS, maxTotalWorkUnits: MAX_TOTAL_WORK_UNITS }
  },
  corpusAssessment: {
    caseCount: cases.length, uniqueGraphCount: graphHashes.size, uniqueCaseIdCount: caseIds.size,
    uniqueOracleOutcomeRefCount: outcomeRefs.size,
    taskSampleAssessment: cases.length >= 20 && cases.length <= 30 ? 'WITHIN_RECOMMENDED_RANGE_20_TO_30' : 'OUTSIDE_RECOMMENDED_RANGE_20_TO_30',
    outcomeClassCounts: outcomes, dominantOutcomeShare: outcomeDominance,
    noSolutionCasesExhaustivelyReDerived,
    totalGraphNodes, totalGraphEdges, totalOracleStates, totalOracleEdgeChecks, totalDeclaredOraclePaths,
    hardLimits: { maxTotalGraphNodes: MAX_TOTAL_GRAPH_NODES, maxTotalGraphEdges: MAX_TOTAL_GRAPH_EDGES,
      maxTotalOracleStates: MAX_TOTAL_ORACLE_STATES, maxTotalOracleEdgeChecks: MAX_TOTAL_ORACLE_EDGE_CHECKS,
      maxOraclePathsPerCase: MAX_ORACLE_PATHS_PER_CASE, maxTotalOraclePaths: MAX_TOTAL_ORACLE_PATHS },
    duplicateGraphCount: 0, duplicateCaseIdCount: 0, duplicateOracleOutcomeRefCount: 0,
    qualityFlags
  },
  metrics: {
    taskCount: cases.length, seedCount: seeds.length, pairedTrialCount: trialCount,
    phase2BeamSuccessCount: beamSuccesses, phase2BeamSuccessRate: beamSuccesses / trialCount,
    phase2BeamSuccessWilson95: wilson(beamSuccesses, trialCount), phase3MCTSSuccessCount: mctsSuccesses,
    phase3MCTSSuccessRate: mctsSuccesses / trialCount, phase3MCTSSuccessWilson95: wilson(mctsSuccesses, trialCount),
    wilsonInterpretation: 'Pooled repeated-seed trial intervals are descriptive and naive; do not treat repeated seeds on the same task as independent observations.',
    allOutcomeTaskClusterBootstrap: clusterIntervals,
    goalPathOnly: {
      caseCount: outcomes.goalPath,
      pairedTrialCount: goalPathTrials.length,
      phase2BeamSuccessCount: goalPathBeamSuccesses,
      phase2BeamSuccessRate: goalPathTrials.length ? goalPathBeamSuccesses / goalPathTrials.length : null,
      phase2BeamSuccessWilson95: goalPathTrials.length ? wilson(goalPathBeamSuccesses, goalPathTrials.length) : null,
      phase3MCTSSuccessCount: goalPathMctsSuccesses,
      phase3MCTSSuccessRate: goalPathTrials.length ? goalPathMctsSuccesses / goalPathTrials.length : null,
      phase3MCTSSuccessWilson95: goalPathTrials.length ? wilson(goalPathMctsSuccesses, goalPathTrials.length) : null,
      pairedSuccessDelta: goalPathTrials.length ? mean(goalPathPairedDeltas) : null,
      pairedOutcomes: goalPathPairedOutcomes,
      taskClusterBootstrap: goalPathClusterIntervals,
      meanPhase2BeamExpansions: meanNullable(goalPathTrials.map(item => item.phase2Beam.expansions)),
      meanPhase3MCTSExpansions: meanNullable(goalPathTrials.map(item => item.phase3MCTS.expansions)),
      meanPhase3MCTSWorkUnits: meanNullable(goalPathTrials.map(item => item.phase3MCTS.workUnits)),
      meanPhase3MCTSSimulations: meanNullable(goalPathTrials.map(item => item.phase3MCTS.simulations)),
      meanPhase2BeamRuntimeMs: meanNullable(goalPathTrials.map(item => item.phase2Beam.runtimeMs)),
      meanPhase3MCTSRuntimeMs: meanNullable(goalPathTrials.map(item => item.phase3MCTS.runtimeMs))
    },
    noSolutionProofs: {
      caseCount: outcomes.noSolution,
      pairedTrialCount: noSolutionTrials.length,
      phase2BeamExhaustiveProofCount: phase2NoSolutionProofs,
      phase2BeamExhaustiveProofRate: noSolutionTrials.length ? phase2NoSolutionProofs / noSolutionTrials.length : null,
      phase3MCTSExhaustiveProofCount: phase3NoSolutionProofs,
      phase3MCTSExhaustiveProofRate: noSolutionTrials.length ? phase3NoSolutionProofs / noSolutionTrials.length : null,
      phase3MCTSCanClaimNoSolutionProofByContract: false,
      interpretation: 'MCTS is explicitly non-exhaustive; a failure to return a goal path is not evidence that no path exists.'
    },
    mixedOutcomePairedSuccessDelta: mean(pairedDeltas),
    pairedComparisonInterpretation: 'The all-outcome paired delta combines goal-path discovery with exhaustive no-solution proof. It is not a like-for-like MCTS-vs-Beam goal-path efficacy comparison; use metrics.goalPathOnly and metrics.noSolutionProofs separately.',
    meanPhase2BeamExpansions: mean(allTrials.map(item => item.phase2Beam.expansions)),
    meanPhase3MCTSExpansions: mean(allTrials.map(item => item.phase3MCTS.expansions)),
    meanPhase3MCTSWorkUnits: mean(allTrials.map(item => item.phase3MCTS.workUnits)),
    meanPhase3MCTSSimulations: mean(allTrials.map(item => item.phase3MCTS.simulations)),
    meanPhase2BeamRuntimeMs: mean(allTrials.map(item => item.phase2Beam.runtimeMs)),
    meanPhase3MCTSRuntimeMs: mean(allTrials.map(item => item.phase3MCTS.runtimeMs)),
    meanPhase2BeamCorrectPlanDepth: meanNullable(allTrials.map(item => item.phase2Beam.correctCandidateDepth)),
    meanPhase3MCTSCorrectPlanDepth: meanNullable(allTrials.map(item => item.phase3MCTS.correctCandidateDepth)),
    phase3BudgetExhaustedRuns: allTrials.filter(item => item.phase3MCTS.budgetExhausted).length,
    mixedOutcomePairedOutcomes, mixedOutcomeMeanPairedSuccessDelta: mean(pairedDeltas),
    nominalRecoveryTransitionsTraversed: 0,
    llmCalls: 0, tokenUsage: null, monetaryCostUsd: null
  },
  cases,
  durationMs: performance.now() - startedAt,
  status: 'offline_diagnostic_not_acceptance',
  acceptance: 'offline_shadow_not_acceptance',
  evidenceLevel: 'INTEGRITY_AND_SYNTHETIC_REPLAY_ONLY',
  execution: { enabled: false, authorized: false, dispatched: false },
  gates: { immutableExecutionPlanCreated: false, dispatchAllowed: false, executionAuthorized: false }
};
result.artifactSha256 = hash(canonicalJson(result));
writeFileExclusiveAtomic(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ outputPath, corpusId: result.corpusId, cases: cases.length, seeds,
  allOutcomeBeamSuccessRate: result.metrics.phase2BeamSuccessRate,
  allOutcomeMctsSuccessRate: result.metrics.phase3MCTSSuccessRate,
  mixedOutcomePairedDeltaNotLikeForLike: result.metrics.mixedOutcomeMeanPairedSuccessDelta,
  goalPathOnly: result.metrics.goalPathOnly,
  noSolutionProofs: result.metrics.noSolutionProofs,
  taskSampleAssessment: result.corpusAssessment.taskSampleAssessment, qualityFlags,
  acceptance: result.acceptance }, null, 2));
