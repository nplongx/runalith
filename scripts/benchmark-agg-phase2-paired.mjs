#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseStrictJson } from '../src/runtime/strict-json.js';
import { canonicalJson } from '../src/runtime/canonical-json.js';
import { readStableRegularFile, writeFileExclusiveAtomic } from '../src/runtime/exclusive-file.js';
import { searchAdaptiveGoalGraph } from '../src/runtime/adaptive-goal-graph.js';
import { validateAdaptiveGoalDiscriminatorModel } from '../src/runtime/adaptive-goal-discriminator.js';
import { validateAdaptiveGoalPhase2ModelArtifact } from '../src/runtime/adaptive-goal-phase2-dataset.js';
import { createAdaptiveGoalDiscriminatorExample, searchAdaptiveGoalGraphPhase2 } from '../src/runtime/adaptive-goal-phase2-search.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceHash = relative => hash(fs.readFileSync(path.join(repoRoot, relative)));
const args = process.argv.slice(2), values = new Map();
const allowed = ['--corpus', '--model', '--output', '--beam-width', '--max-depth', '--max-expansions', '--max-audit-events'];
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (key === '--help') { console.log('Usage: node scripts/benchmark-agg-phase2-paired.mjs --corpus CORPUS.json --model MODEL.json --output NEW_BENCHMARK.json [--beam-width N] [--max-depth N] [--max-expansions N] [--max-audit-events N]'); process.exit(0); }
  if (!allowed.includes(key)) throw new Error(`Unknown argument: ${key}`);
  if (values.has(key)) throw new Error(`Duplicate argument: ${key}`);
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
  values.set(key, args[++i]);
}
for (const key of ['--corpus', '--model', '--output']) if (!values.has(key)) throw new Error(`Required argument missing: ${key}`);
const outputPath = path.resolve(values.get('--output'));
const outputParent = path.dirname(outputPath);
const outputParentStat = fs.lstatSync(outputParent);
if (!outputParentStat.isDirectory() || outputParentStat.isSymbolicLink() || fs.realpathSync(outputParent) !== outputParent || fs.existsSync(outputPath)) throw new Error('Output must be a new file in an existing canonical non-symlink directory');
const integerOption = (key, fallback, min, max) => {
  const value = values.has(key) ? Number(values.get(key)) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer in [${min}, ${max}]`);
  return value;
};
const options = { beamWidth: integerOption('--beam-width', 4, 1, 100), maxDepth: integerOption('--max-depth', 12, 1, 100), maxExpansions: integerOption('--max-expansions', 128, 1, 10000), maxAuditEvents: integerOption('--max-audit-events', 2000, 1, 5000) };
function readRegular(filePath, label) {
  const bytes = readStableRegularFile(filePath, { maxBytes: 16 * 1024 * 1024, label });
  return { bytes, value: parseStrictJson(bytes, label, { maxBytes: 16 * 1024 * 1024 }) };
}
const corpusFile = readRegular(path.resolve(values.get('--corpus')), 'Phase 2 paired benchmark corpus');
const corpus = corpusFile.value;
if (!corpus || typeof corpus !== 'object' || Array.isArray(corpus) || Object.keys(corpus).some(key => !['schemaVersion', 'corpusId', 'provenance', 'cases'].includes(key)) ||
    corpus.schemaVersion !== 1 || typeof corpus.corpusId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(corpus.corpusId)) throw new Error('Invalid benchmark corpus envelope');
if (!corpus.provenance || typeof corpus.provenance !== 'object' || Array.isArray(corpus.provenance) ||
    Object.keys(corpus.provenance).some(key => !['kind', 'source', 'adjudicatorId', 'protocol', 'independent'].includes(key)) ||
    !['synthetic', 'independently_adjudicated'].includes(corpus.provenance.kind) || typeof corpus.provenance.source !== 'string' || !corpus.provenance.source.trim()) {
  throw new Error('Corpus provenance must declare synthetic or independently_adjudicated and a source');
}
if (corpus.provenance.kind === 'independently_adjudicated' && (corpus.provenance.independent !== true || typeof corpus.provenance.adjudicatorId !== 'string' || !corpus.provenance.adjudicatorId.trim() || typeof corpus.provenance.protocol !== 'string' || !corpus.provenance.protocol.trim())) {
  throw new Error('Independent corpus metadata requires adjudicator, protocol, and independent:true; this metadata is not a signature');
}
if (!Array.isArray(corpus.cases) || corpus.cases.length < 1 || corpus.cases.length > 1000) throw new Error('Corpus cases must contain 1-1000 cases');
const caseIds = new Set();
const modelFile = readRegular(path.resolve(values.get('--model')), 'Phase 2 model artifact');
validateAdaptiveGoalPhase2ModelArtifact(modelFile.value);
const model = validateAdaptiveGoalDiscriminatorModel(modelFile.value.model);
const expectedModelSources = {
  trainerCliSha256: sourceHash('scripts/train-agg-phase2-discriminator.mjs'),
  discriminatorSha256: sourceHash('src/runtime/adaptive-goal-discriminator.js'),
  datasetValidatorSha256: sourceHash('src/runtime/adaptive-goal-phase2-dataset.js'),
  strictJsonParserSha256: sourceHash('src/runtime/strict-json.js'),
  canonicalJsonSha256: sourceHash('src/runtime/canonical-json.js')
};
if (canonicalJson(modelFile.value.sourceIdentity) !== canonicalJson(expectedModelSources)) throw new Error('Stale model source identity; retrain from the current source tree');
const caseResults = [];
const started = performance.now();
for (const [index, item] of corpus.cases.entries()) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['caseId', 'graph', 'oracle'].includes(key))) throw new Error(`cases[${index}] has an invalid shape`);
  if (typeof item.caseId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(item.caseId) || caseIds.has(item.caseId)) throw new Error(`cases[${index}].caseId is invalid or duplicated`);
  caseIds.add(item.caseId);
  if (!item.oracle || typeof item.oracle !== 'object' || Array.isArray(item.oracle) || Object.keys(item.oracle).some(key => !['successfulPathNodeIds', 'outcomeRef'].includes(key)) ||
      !Array.isArray(item.oracle.successfulPathNodeIds) || item.oracle.successfulPathNodeIds.length < 1 || typeof item.oracle.outcomeRef !== 'string' || !item.oracle.outcomeRef.trim()) {
    throw new Error(`cases[${index}].oracle must provide independently declared successfulPathNodeIds and outcomeRef`);
  }
  const oraclePaths = new Set();
  for (const [pathIndex, pathIds] of item.oracle.successfulPathNodeIds.entries()) {
    createAdaptiveGoalDiscriminatorExample({ graph: item.graph, pathNodeIds: pathIds, id: `oracle-${index}-${pathIndex}`, label: 1 });
    if (oraclePaths.has(JSON.stringify(pathIds))) throw new Error(`cases[${index}].oracle contains a duplicate successful path`);
    oraclePaths.add(JSON.stringify(pathIds));
  }
  const beforeBaseline = performance.now();
  const baseline = searchAdaptiveGoalGraph(item.graph, options);
  const baselineMs = performance.now() - beforeBaseline;
  const beforePhase2 = performance.now();
  const phase2 = searchAdaptiveGoalGraphPhase2(item.graph, model, options);
  const phase2Ms = performance.now() - beforePhase2;
  const baselineSuccess = baseline.candidates.some(candidate => oraclePaths.has(JSON.stringify(candidate.pathNodeIds)));
  const phase2Success = phase2.candidates.some(candidate => oraclePaths.has(JSON.stringify(candidate.pathNodeIds)));
  caseResults.push({ caseId: item.caseId, graphHash: baseline.graphHash, oracleRef: item.oracle.outcomeRef,
    baseline: { success: baselineSuccess, status: baseline.status, expansions: baseline.search.expansions, nodesExpanded: baseline.auditTrace.counters.expandedStates, candidates: baseline.candidates.length, runtimeMs: baselineMs },
    phase2: { success: phase2Success, status: phase2.status, expansions: phase2.search.expansions, nodesExpanded: phase2.search.expandedStates, candidates: phase2.candidates.length, runtimeMs: phase2Ms },
    pairedDelta: Number(phase2Success) - Number(baselineSuccess) });
}
const count = caseResults.length;
const baselineSuccesses = caseResults.filter(item => item.baseline.success).length;
const phase2Successes = caseResults.filter(item => item.phase2.success).length;
const bothSuccess = caseResults.filter(item => item.baseline.success && item.phase2.success).length;
const phase2Only = caseResults.filter(item => !item.baseline.success && item.phase2.success).length;
const baselineOnly = caseResults.filter(item => item.baseline.success && !item.phase2.success).length;
const bothFail = caseResults.filter(item => !item.baseline.success && !item.phase2.success).length;
const wilson = successes => {
  const p = successes / count, z = 1.959963984540054, denominator = 1 + z * z / count;
  const center = (p + z * z / (2 * count)) / denominator;
  const margin = z * Math.sqrt(p * (1 - p) / count + z * z / (4 * count * count)) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin), method: 'wilson_score' };
};
const delta = (phase2Successes - baselineSuccesses) / count;
const pairedDifferences = caseResults.map(item => item.pairedDelta);
const mean = pairedDifferences.reduce((sum, value) => sum + value, 0) / count;
const variance = pairedDifferences.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, count - 1);
const deltaCI = count >= 30 ? { lower: Math.max(-1, delta - 1.96 * Math.sqrt(variance / count)), upper: Math.min(1, delta + 1.96 * Math.sqrt(variance / count)), method: 'paired_normal_approximation' } : null;
const sensitivityCases = [];
for (const item of corpus.cases.slice(0, 20)) {
  const widths = [...new Set([1, options.beamWidth, Math.min(100, options.beamWidth + 1)])].sort((a, b) => a - b);
  const beamWidthSensitivity = widths.map(width => {
    const result = searchAdaptiveGoalGraphPhase2(item.graph, model, { ...options, beamWidth: width });
    return { beamWidth: width, status: result.status, expansions: result.search.expansions, candidatePaths: result.candidates.map(candidate => candidate.pathNodeIds) };
  });
  const base = searchAdaptiveGoalGraphPhase2(item.graph, model, options);
  const perturbedGraph = structuredClone(item.graph);
  let perturbedFeatureCount = 0;
  for (const node of perturbedGraph.nodes) if (typeof node.informationValue === 'number') {
    node.informationValue = Math.max(0, Math.min(1, node.informationValue + 0.05));
    perturbedFeatureCount += 1;
  }
  const perturbed = perturbedFeatureCount ? searchAdaptiveGoalGraphPhase2(perturbedGraph, model, options) : null;
  sensitivityCases.push({ caseId: item.caseId, beamWidth: beamWidthSensitivity,
    featurePerturbation: { feature: 'informationValue', direction: '+0.05_clamped', changedNodeCount: perturbedFeatureCount,
      baselineTopPath: base.candidates[0]?.pathNodeIds ?? null, perturbedTopPath: perturbed?.candidates[0]?.pathNodeIds ?? null,
      topPathStable: JSON.stringify(base.candidates[0]?.pathNodeIds ?? null) === JSON.stringify(perturbed?.candidates[0]?.pathNodeIds ?? null) } });
}
let modelMismatchRejected = false;
try { validateAdaptiveGoalDiscriminatorModel({ ...model, featureSchemaVersion: model.featureSchemaVersion + 1 }); }
catch { modelMismatchRejected = true; }
const result = {
  schemaVersion: 1, kind: 'agg_phase2_paired_benchmark', corpusId: corpus.corpusId, corpusFileSha256: hash(corpusFile.bytes),
  corpusProvenance: { ...corpus.provenance, independentAttestationPresent: false }, modelArtifactSha256: hash(modelFile.bytes), modelSha256: model.modelSha256,
  datasetId: modelFile.value.datasetId, datasetFileSha256: modelFile.value.datasetFileSha256, datasetSha256: modelFile.value.datasetSha256,
  splitIdentities: modelFile.value.splitIdentities, featureSchemaVersion: modelFile.value.featureSchemaVersion,
  runtime: { nodeVersion: process.version, platform: process.platform, architecture: process.arch },
  sourceIdentity: { benchmarkCliSha256: sourceHash('scripts/benchmark-agg-phase2-paired.mjs'), phase1SearchSha256: sourceHash('src/runtime/adaptive-goal-graph.js'), phase2SearchSha256: sourceHash('src/runtime/adaptive-goal-phase2-search.js'), discriminatorSha256: sourceHash('src/runtime/adaptive-goal-discriminator.js'), datasetValidatorSha256: sourceHash('src/runtime/adaptive-goal-phase2-dataset.js'), canonicalJsonSha256: sourceHash('src/runtime/canonical-json.js') },
  phase1Baseline: { identity: 'searchAdaptiveGoalGraph@source-tree', graphHashes: caseResults.map(item => item.graphHash) },
  phase2: { identity: 'searchAdaptiveGoalGraphPhase2@source-tree', modelSha256: model.modelSha256 },
  pairedConfig: options, sameFrozenGraphPerPair: true, sameExpansionBudgetPerPair: true,
  metrics: {
    caseCount: count, baselineSuccessCount: baselineSuccesses, phase2SuccessCount: phase2Successes,
    baselineSuccessRate: baselineSuccesses / count, phase2SuccessRate: phase2Successes / count,
    baselineSuccessRateCI95: wilson(baselineSuccesses), phase2SuccessRateCI95: wilson(phase2Successes),
    pairedSuccessRateDelta: delta, pairedDeltaCI95: deltaCI,
    pairedOutcomes: { bothSuccess, phase2Only, baselineOnly, bothFail },
    meanBaselineExpansions: caseResults.reduce((sum, item) => sum + item.baseline.expansions, 0) / count,
    meanPhase2Expansions: caseResults.reduce((sum, item) => sum + item.phase2.expansions, 0) / count,
    meanBaselineRuntimeMs: caseResults.reduce((sum, item) => sum + item.baseline.runtimeMs, 0) / count,
    meanPhase2RuntimeMs: caseResults.reduce((sum, item) => sum + item.phase2.runtimeMs, 0) / count
  },
  sensitivity: {
    evaluatedCaseCount: sensitivityCases.length,
    beamWidth: sensitivityCases.map(item => ({ caseId: item.caseId, results: item.beamWidth })),
    featurePerturbation: sensitivityCases.map(item => ({ caseId: item.caseId, ...item.featurePerturbation })),
    classImbalance: { trainingClassBalance: model.trainingClassCounts,
      majorityToMinorityRatio: Math.max(model.trainingClassCounts.negative, model.trainingClassCounts.positive) / Math.min(model.trainingClassCounts.negative, model.trainingClassCounts.positive),
      trainingReweighting: 'none', note: 'class-specific holdout metrics and a separate balanced-subset training sensitivity are reported by the holdout evaluator' },
    modelMismatch: { featureSchemaMismatchRejected: modelMismatchRejected }
  }, cases: caseResults,
  limitations: ['Wall-clock runtime is observational and not deterministic.', 'The corpus oracle is caller-supplied and not cryptographically attested by this harness.',
    'A declared synthetic corpus supports technical regression only, not real-world effectiveness.', 'Search success is not model classification accuracy or operational acceptance.'],
  evidenceLevel: corpus.provenance.kind === 'synthetic' ? 'synthetic_technical_only' : 'unattested_offline_evaluation',
  acceptance: 'acceptance_required', execution: { enabled: false, authorized: false, dispatched: false }, elapsedMs: performance.now() - started
};
writeFileExclusiveAtomic(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ output: outputPath, corpusId: corpus.corpusId, caseCount: count, metrics: result.metrics, evidenceLevel: result.evidenceLevel, acceptance: result.acceptance }, null, 2));
