#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseStrictJson } from '../src/runtime/strict-json.js';
import { canonicalJson } from '../src/runtime/canonical-json.js';
import { readStableRegularFile, writeFileExclusiveAtomic } from '../src/runtime/exclusive-file.js';
import { validateAdaptiveGoalDiscriminatorModel, evaluateAdaptiveGoalDiscriminator, trainAdaptiveGoalDiscriminator } from '../src/runtime/adaptive-goal-discriminator.js';
import { validateAdaptiveGoalPhase2Dataset, validateAdaptiveGoalPhase2ModelArtifact } from '../src/runtime/adaptive-goal-phase2-dataset.js';
import { searchAdaptiveGoalGraph } from '../src/runtime/adaptive-goal-graph.js';
import { createAdaptiveGoalDiscriminatorExample, searchAdaptiveGoalGraphPhase2 } from '../src/runtime/adaptive-goal-phase2-search.js';
import { projectAdaptiveGoalPhase2CandidateToPlanGraphShadow } from '../src/runtime/adaptive-goal-phase2-plan-shadow.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceHash = relative => hash(fs.readFileSync(path.join(repoRoot, relative)));
const args = process.argv.slice(2), values = new Map();
const allowed = ['--dataset', '--model', '--evaluation', '--graph', '--shadow-result', '--corpus', '--benchmark', '--output'];
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (key === '--help') { console.log('Usage: node scripts/verify-agg-phase2-workflow.mjs --dataset DATASET.json --model MODEL.json --evaluation EVALUATION.json --graph GRAPH.json --shadow-result SHADOW.json --corpus CORPUS.json --benchmark BENCHMARK.json --output NEW_REPORT.json'); process.exit(0); }
  if (!allowed.includes(key)) throw new Error(`Unknown argument: ${key}`);
  if (values.has(key)) throw new Error(`Duplicate argument: ${key}`);
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
  values.set(key, path.resolve(args[++i]));
}
for (const key of allowed) if (!values.has(key)) throw new Error(`Required argument missing: ${key}`);
const output = values.get('--output');
const blockers = [], checks = [];
const check = (id, ok, detail) => { checks.push({ id, status: ok ? 'PASS' : 'FAIL', detail }); if (!ok) blockers.push({ id, detail }); };
function readRegular(key, label, maxBytes = 16 * 1024 * 1024) {
  const filePath = values.get(key);
  const bytes = readStableRegularFile(filePath, { maxBytes, label });
  return { path: filePath, bytes, sha256: hash(bytes), value: parseStrictJson(bytes, label, { maxBytes }) };
}
const files = {};
try {
  for (const [key, label, limit] of [
    ['--dataset', 'Phase 2 dataset', 8 * 1024 * 1024], ['--model', 'Phase 2 model', 8 * 1024 * 1024],
    ['--evaluation', 'Phase 2 holdout evaluation', 16 * 1024 * 1024], ['--graph', 'Phase 2 graph', 8 * 1024 * 1024],
    ['--shadow-result', 'Phase 2 shadow result', 16 * 1024 * 1024], ['--corpus', 'Phase 2 benchmark corpus', 16 * 1024 * 1024],
    ['--benchmark', 'Phase 2 paired benchmark', 16 * 1024 * 1024]
  ]) files[key] = readRegular(key, label, limit);
  const dataset = validateAdaptiveGoalPhase2Dataset(files['--dataset'].value);
  const modelArtifact = validateAdaptiveGoalPhase2ModelArtifact(files['--model'].value);
  const model = validateAdaptiveGoalDiscriminatorModel(modelArtifact.model);
  const expectedModelSources = {
    trainerCliSha256: sourceHash('scripts/train-agg-phase2-discriminator.mjs'),
    discriminatorSha256: sourceHash('src/runtime/adaptive-goal-discriminator.js'),
    datasetValidatorSha256: sourceHash('src/runtime/adaptive-goal-phase2-dataset.js'),
    strictJsonParserSha256: sourceHash('src/runtime/strict-json.js'),
    canonicalJsonSha256: sourceHash('src/runtime/canonical-json.js')
  };
  check('MODEL_SOURCE_IDENTITY_CURRENT', canonicalJson(modelArtifact.sourceIdentity) === canonicalJson(expectedModelSources), 'model trainer, discriminator, dataset validator, strict parser and canonical serializer hashes must match current source');
  check('DATASET_FILE_AND_SPLITS_BOUND', modelArtifact.datasetFileSha256 === files['--dataset'].sha256 && modelArtifact.datasetSha256 === dataset.datasetSha256 &&
    modelArtifact.datasetId === dataset.datasetId && model.datasetId === dataset.datasetId &&
    canonicalJson(modelArtifact.labelProvenance) === canonicalJson(dataset.labelProvenance) &&
    canonicalJson(modelArtifact.provenanceAssessment) === canonicalJson(dataset.provenanceAssessment) &&
    model.trainingDataSha256 === dataset.splits.training.sha256 && model.validationDataSha256 === dataset.splits.validation.sha256 &&
    canonicalJson(modelArtifact.splitIdentities) === canonicalJson(dataset.splits), 'exact dataset bytes and all three disjoint split identities match the model provenance');
  check('MODEL_HASH_VALID', model.modelSha256 === modelArtifact.model.modelSha256, 'canonical model hash validates and feature schema is current');
  const retrained = trainAdaptiveGoalDiscriminator({ trainingExamples: dataset.trainingExamples, validationExamples: dataset.validationExamples,
    ...model.trainingConfig, datasetId: dataset.datasetId });
  const replayValidation = evaluateAdaptiveGoalDiscriminator(model, dataset.validationExamples);
  check('TRAINING_AND_VALIDATION_REPLAY', retrained.model.modelSha256 === model.modelSha256 &&
    modelArtifact.training?.dataSha256 === model.trainingDataSha256 && modelArtifact.training?.exampleCount === model.trainingExampleCount &&
    canonicalJson(modelArtifact.training?.metrics) === canonicalJson(model.trainingMetrics) &&
    canonicalJson(modelArtifact.validation) === canonicalJson(replayValidation),
    'fitting is replayed from training rows/config only; validation metrics are independently derived from the validation split');

  const expectedEvaluation = evaluateAdaptiveGoalDiscriminator(model, dataset.holdoutExamples);
  const evaluationArtifact = files['--evaluation'].value;
  const negativeTraining = dataset.trainingExamples.filter(item => item.label === 0);
  const positiveTraining = dataset.trainingExamples.filter(item => item.label === 1);
  const minorityCount = Math.min(negativeTraining.length, positiveTraining.length);
  let expectedImbalance;
  if (negativeTraining.length === positiveTraining.length) expectedImbalance = { status: 'NOT_NEEDED_TRAIN_SPLIT_BALANCED', trainingClassBalance: model.trainingClassCounts, majorityToMinorityRatio: 1, balancedSubsetModelSha256: null, holdoutUsedForSelection: false };
  else if (minorityCount < 2) expectedImbalance = { status: 'INSUFFICIENT_MINORITY_CLASS_FOR_BALANCED_SUBSET', trainingClassBalance: model.trainingClassCounts, majorityToMinorityRatio: Math.max(negativeTraining.length, positiveTraining.length) / minorityCount, balancedSubsetModelSha256: null, holdoutUsedForSelection: false };
  else {
    const balancedTraining = [...negativeTraining.slice(0, minorityCount), ...positiveTraining.slice(0, minorityCount)].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const sensitivityModel = trainAdaptiveGoalDiscriminator({ trainingExamples: balancedTraining, validationExamples: dataset.validationExamples, ...model.trainingConfig, datasetId: 'balanced-sensitivity-diagnostic' }).model;
    expectedImbalance = { status: 'DIAGNOSTIC_RETRAIN_NO_MODEL_SELECTION', trainingClassBalance: model.trainingClassCounts,
      majorityToMinorityRatio: Math.max(negativeTraining.length, positiveTraining.length) / minorityCount,
      balancedSubsetClassBalance: { negative: minorityCount, positive: minorityCount }, balancedSubsetModelSha256: sensitivityModel.modelSha256,
      originalModelHoldoutMetrics: expectedEvaluation.metrics,
      balancedSubsetHoldoutMetrics: evaluateAdaptiveGoalDiscriminator(sensitivityModel, dataset.holdoutExamples).metrics,
      holdoutUsedForSelection: false, note: 'diagnostic comparison only; main model remains unchanged' };
  }
  const expectedEvaluationSources = { evaluatorCliSha256: sourceHash('scripts/evaluate-agg-phase2-discriminator.mjs'), discriminatorSha256: sourceHash('src/runtime/adaptive-goal-discriminator.js'), datasetValidatorSha256: sourceHash('src/runtime/adaptive-goal-phase2-dataset.js'), strictJsonParserSha256: sourceHash('src/runtime/strict-json.js'), canonicalJsonSha256: sourceHash('src/runtime/canonical-json.js') };
  check('HOLDOUT_EVALUATION_REDERIVED', evaluationArtifact?.kind === 'agg_phase2_independent_holdout_evaluation' &&
    evaluationArtifact.datasetFileSha256 === files['--dataset'].sha256 && evaluationArtifact.modelArtifactSha256 === files['--model'].sha256 &&
    evaluationArtifact.datasetSha256 === dataset.datasetSha256 && canonicalJson(evaluationArtifact.splitIdentities) === canonicalJson(dataset.splits) &&
    evaluationArtifact.modelSha256 === model.modelSha256 && JSON.stringify(evaluationArtifact.holdoutEvaluation) === JSON.stringify(expectedEvaluation) &&
    JSON.stringify(evaluationArtifact.classImbalanceSensitivity) === JSON.stringify(expectedImbalance) &&
    canonicalJson(evaluationArtifact.sourceIdentity) === canonicalJson(expectedEvaluationSources) &&
    evaluationArtifact.holdoutUse === 'evaluation_only_no_model_selection', 'holdout metrics are independently recomputed from the holdout split and exact model');

  const graph = files['--graph'].value;
  const shadowArtifact = files['--shadow-result'].value;
  const searchOptions = shadowArtifact?.result?.search?.options;
  const currentShadowSources = {
    runnerCliSha256: sourceHash('scripts/run-agg-phase2-shadow-search.mjs'),
    phase2SearchSha256: sourceHash('src/runtime/adaptive-goal-phase2-search.js'),
    phase2PlanShadowAdapterSha256: sourceHash('src/runtime/adaptive-goal-phase2-plan-shadow.js'),
    phase1SearchSha256: sourceHash('src/runtime/adaptive-goal-graph.js'),
    discriminatorSha256: sourceHash('src/runtime/adaptive-goal-discriminator.js'),
    strictJsonParserSha256: sourceHash('src/runtime/strict-json.js'),
    canonicalJsonSha256: sourceHash('src/runtime/canonical-json.js')
  };
  const replayShadow = searchAdaptiveGoalGraphPhase2(graph, model, searchOptions);
  check('SHADOW_RESULT_REPLAY', shadowArtifact?.schemaVersion === 2 && shadowArtifact.kind === 'agg_phase2_shadow_search_result' &&
    shadowArtifact.graphFileSha256 === files['--graph'].sha256 && shadowArtifact.graphHash === replayShadow.graphHash &&
    shadowArtifact.modelArtifactSha256 === files['--model'].sha256 && shadowArtifact.datasetId === dataset.datasetId &&
    shadowArtifact.datasetFileSha256 === files['--dataset'].sha256 && shadowArtifact.datasetSha256 === dataset.datasetSha256 &&
    shadowArtifact.featureSchemaVersion === dataset.featureSchemaVersion && canonicalJson(shadowArtifact.splitIdentities) === canonicalJson(dataset.splits) &&
    canonicalJson(shadowArtifact.sourceIdentity) === canonicalJson(currentShadowSources) &&
    JSON.stringify(shadowArtifact.result) === JSON.stringify(replayShadow), 'graph/model/source hashes and full deterministic shadow search replay match');
  check('SHADOW_NON_EXECUTABLE', shadowArtifact?.result?.mode === 'shadow' && shadowArtifact.result.search.executionAuthorized === false &&
    shadowArtifact.result.candidates.every(candidate => candidate.execution.enabled === false && candidate.execution.authorized === false && candidate.execution.dispatched === false && candidate.verification.verified === false),
    'all shadow candidates remain unverified, non-executable and unauthorized');
  const expectedPlanGraphDrafts = [], expectedUnprojectableCandidates = [];
  for (const candidate of replayShadow.candidates) {
    try { expectedPlanGraphDrafts.push(projectAdaptiveGoalPhase2CandidateToPlanGraphShadow(graph, model, candidate, replayShadow.search.options)); }
    catch (error) { expectedUnprojectableCandidates.push({ candidatePlanId: candidate.planId, code: 'PHASE2_PLAN_GRAPH_SHADOW_UNPROJECTABLE', reason: String(error?.message || error) }); }
  }
  const planGraphShadow = shadowArtifact?.planGraphShadow;
  check('PLAN_GRAPH_SHADOW_REPLAY', planGraphShadow?.schemaVersion === 1 && planGraphShadow.mode === 'shadow' &&
    JSON.stringify(planGraphShadow.drafts) === JSON.stringify(expectedPlanGraphDrafts) &&
    JSON.stringify(planGraphShadow.unprojectableCandidates) === JSON.stringify(expectedUnprojectableCandidates) &&
    planGraphShadow.gates?.persisted === false && planGraphShadow.gates?.immutableExecutionPlanCreated === false &&
    planGraphShadow.gates?.dispatchAllowed === false && planGraphShadow.gates?.executionAuthorized === false &&
    planGraphShadow.drafts.every(draft => draft.kind === 'adaptive_goal_phase2_plan_graph_shadow_draft' && draft.status === 'review_required' &&
      draft.gates?.persisted === false && draft.gates?.immutableExecutionPlanCreated === false && draft.gates?.dispatchAllowed === false &&
      draft.gates?.executionAuthorized === false && draft.steps.every(step => step.execution?.enabled === false && step.execution?.authorization === 'none')),
    'Plan Graph shadow drafts are reconstructed from exact Phase 2 candidates and remain review-only, unpersisted and non-executable');

  const corpus = files['--corpus'].value, benchmarkArtifact = files['--benchmark'].value;
  const options = benchmarkArtifact?.pairedConfig;
  if (!corpus || !Array.isArray(corpus.cases) || !options) throw new Error('benchmark corpus/result envelope is invalid');
  const seenCaseIds = new Set();
  const replayCases = [];
  for (const [index, item] of corpus.cases.entries()) {
    if (!item || typeof item.caseId !== 'string' || seenCaseIds.has(item.caseId) || !item.oracle || !Array.isArray(item.oracle.successfulPathNodeIds)) throw new Error(`benchmark case ${index} is malformed or duplicated`);
    seenCaseIds.add(item.caseId);
    const oraclePaths = new Set();
    item.oracle.successfulPathNodeIds.forEach((pathIds, pathIndex) => {
      createAdaptiveGoalDiscriminatorExample({ graph: item.graph, pathNodeIds: pathIds, id: `verify-${index}-${pathIndex}`, label: 1 });
      if (oraclePaths.has(JSON.stringify(pathIds))) throw new Error(`benchmark oracle has duplicate path in case ${item.caseId}`);
      oraclePaths.add(JSON.stringify(pathIds));
    });
    const baseline = searchAdaptiveGoalGraph(item.graph, options);
    const phase2 = searchAdaptiveGoalGraphPhase2(item.graph, model, options);
    replayCases.push({ caseId: item.caseId, graphHash: baseline.graphHash,
      baseline: { success: baseline.candidates.some(candidate => oraclePaths.has(JSON.stringify(candidate.pathNodeIds))), status: baseline.status, expansions: baseline.search.expansions, nodesExpanded: baseline.auditTrace.counters.expandedStates, candidates: baseline.candidates.length },
      phase2: { success: phase2.candidates.some(candidate => oraclePaths.has(JSON.stringify(candidate.pathNodeIds))), status: phase2.status, expansions: phase2.search.expansions, nodesExpanded: phase2.search.expandedStates, candidates: phase2.candidates.length } });
  }
  const declaredCases = benchmarkArtifact.cases;
  const pairedCasesMatch = Array.isArray(declaredCases) && declaredCases.length === replayCases.length && replayCases.every((item, index) => {
    const actual = declaredCases[index];
    return actual.caseId === item.caseId && actual.graphHash === item.graphHash &&
      actual.baseline.success === item.baseline.success && actual.baseline.status === item.baseline.status && actual.baseline.expansions === item.baseline.expansions && actual.baseline.nodesExpanded === item.baseline.nodesExpanded && actual.baseline.candidates === item.baseline.candidates &&
      actual.phase2.success === item.phase2.success && actual.phase2.status === item.phase2.status && actual.phase2.expansions === item.phase2.expansions && actual.phase2.nodesExpanded === item.phase2.nodesExpanded && actual.phase2.candidates === item.phase2.candidates &&
      actual.pairedDelta === Number(item.phase2.success) - Number(item.baseline.success);
  });
  const n = replayCases.length;
  const bSuccess = replayCases.filter(item => item.baseline.success).length;
  const pSuccess = replayCases.filter(item => item.phase2.success).length;
  const pairedOutcomes = {
    bothSuccess: replayCases.filter(item => item.baseline.success && item.phase2.success).length,
    phase2Only: replayCases.filter(item => !item.baseline.success && item.phase2.success).length,
    baselineOnly: replayCases.filter(item => item.baseline.success && !item.phase2.success).length,
    bothFail: replayCases.filter(item => !item.baseline.success && !item.phase2.success).length
  };
  const benchmarkMetrics = benchmarkArtifact.metrics;
  const wilson = successes => {
    const p = successes / n, z = 1.959963984540054, denominator = 1 + z * z / n;
    const center = (p + z * z / (2 * n)) / denominator;
    const margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator;
    return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin), method: 'wilson_score' };
  };
  const deltas = replayCases.map(item => Number(item.phase2.success) - Number(item.baseline.success));
  const meanDelta = deltas.reduce((sum, value) => sum + value, 0) / n;
  const deltaVariance = deltas.reduce((sum, value) => sum + (value - meanDelta) ** 2, 0) / Math.max(1, n - 1);
  const expectedDeltaCI = n >= 30 ? { lower: Math.max(-1, (pSuccess - bSuccess) / n - 1.96 * Math.sqrt(deltaVariance / n)), upper: Math.min(1, (pSuccess - bSuccess) / n + 1.96 * Math.sqrt(deltaVariance / n)), method: 'paired_normal_approximation' } : null;
  check('PAIRED_BENCHMARK_REPLAY', benchmarkArtifact?.kind === 'agg_phase2_paired_benchmark' &&
    benchmarkArtifact.corpusFileSha256 === files['--corpus'].sha256 && benchmarkArtifact.modelArtifactSha256 === files['--model'].sha256 &&
    benchmarkArtifact.modelSha256 === model.modelSha256 && benchmarkArtifact.datasetId === dataset.datasetId &&
    benchmarkArtifact.datasetFileSha256 === files['--dataset'].sha256 && benchmarkArtifact.datasetSha256 === dataset.datasetSha256 &&
    benchmarkArtifact.featureSchemaVersion === dataset.featureSchemaVersion && canonicalJson(benchmarkArtifact.splitIdentities) === canonicalJson(dataset.splits) &&
    JSON.stringify(benchmarkArtifact.pairedConfig) === JSON.stringify(options) &&
    canonicalJson(benchmarkArtifact.sourceIdentity) === canonicalJson({ benchmarkCliSha256: sourceHash('scripts/benchmark-agg-phase2-paired.mjs'), phase1SearchSha256: sourceHash('src/runtime/adaptive-goal-graph.js'), phase2SearchSha256: sourceHash('src/runtime/adaptive-goal-phase2-search.js'), discriminatorSha256: sourceHash('src/runtime/adaptive-goal-discriminator.js'), datasetValidatorSha256: sourceHash('src/runtime/adaptive-goal-phase2-dataset.js'), canonicalJsonSha256: sourceHash('src/runtime/canonical-json.js') }) && pairedCasesMatch,
    'each baseline/Phase 2 pair was rerun on the same graph, oracle paths and numeric budget; runtime values are observational only');
  check('PAIRED_METRICS_REDERIVED', benchmarkMetrics.caseCount === n && benchmarkMetrics.baselineSuccessCount === bSuccess && benchmarkMetrics.phase2SuccessCount === pSuccess &&
    benchmarkMetrics.baselineSuccessRate === bSuccess / n && benchmarkMetrics.phase2SuccessRate === pSuccess / n &&
    benchmarkMetrics.baselineSuccessRateCI95 && JSON.stringify(benchmarkMetrics.baselineSuccessRateCI95) === JSON.stringify(wilson(bSuccess)) &&
    JSON.stringify(benchmarkMetrics.phase2SuccessRateCI95) === JSON.stringify(wilson(pSuccess)) &&
    JSON.stringify(benchmarkMetrics.pairedDeltaCI95) === JSON.stringify(expectedDeltaCI) &&
    benchmarkMetrics.pairedSuccessRateDelta === (pSuccess - bSuccess) / n && JSON.stringify(benchmarkMetrics.pairedOutcomes) === JSON.stringify(pairedOutcomes) &&
    benchmarkMetrics.meanBaselineExpansions === replayCases.reduce((sum, item) => sum + item.baseline.expansions, 0) / n &&
    benchmarkMetrics.meanPhase2Expansions === replayCases.reduce((sum, item) => sum + item.phase2.expansions, 0) / n,
    'success rates, Wilson intervals, paired CI, paired delta/outcomes and mean expansion counts recomputed from per-case results');
  let sensitivityReplayMatches = benchmarkArtifact.sensitivity?.evaluatedCaseCount === Math.min(20, corpus.cases.length) &&
    benchmarkArtifact.sensitivity.beamWidth.length === Math.min(20, corpus.cases.length) &&
    benchmarkArtifact.sensitivity.featurePerturbation.length === Math.min(20, corpus.cases.length) &&
    benchmarkArtifact.sensitivity?.modelMismatch?.featureSchemaMismatchRejected === true &&
    benchmarkArtifact.sensitivity.classImbalance?.trainingReweighting === 'none' &&
    benchmarkArtifact.sensitivity.classImbalance.majorityToMinorityRatio === Math.max(model.trainingClassCounts.negative, model.trainingClassCounts.positive) / Math.min(model.trainingClassCounts.negative, model.trainingClassCounts.positive);
  for (const item of corpus.cases.slice(0, 20)) {
    const declared = benchmarkArtifact.sensitivity?.beamWidth?.find(record => record.caseId === item.caseId);
    const widths = [...new Set([1, options.beamWidth, Math.min(100, options.beamWidth + 1)])].sort((a, b) => a - b);
    if (!declared || declared.results.length !== widths.length) { sensitivityReplayMatches = false; continue; }
    for (let index = 0; index < widths.length; index++) {
      const replay = searchAdaptiveGoalGraphPhase2(item.graph, model, { ...options, beamWidth: widths[index] });
      if (declared.results[index].beamWidth !== widths[index] || declared.results[index].status !== replay.status || declared.results[index].expansions !== replay.search.expansions || JSON.stringify(declared.results[index].candidatePaths) !== JSON.stringify(replay.candidates.map(candidate => candidate.pathNodeIds))) sensitivityReplayMatches = false;
    }
    const perturbRecord = benchmarkArtifact.sensitivity?.featurePerturbation?.find(record => record.caseId === item.caseId);
    const base = searchAdaptiveGoalGraphPhase2(item.graph, model, options);
    const perturbedGraph = structuredClone(item.graph);
    let changed = 0;
    for (const node of perturbedGraph.nodes) if (typeof node.informationValue === 'number') { node.informationValue = Math.max(0, Math.min(1, node.informationValue + 0.05)); changed++; }
    const perturbed = changed ? searchAdaptiveGoalGraphPhase2(perturbedGraph, model, options) : null;
    if (!perturbRecord || perturbRecord.changedNodeCount !== changed ||
        JSON.stringify(perturbRecord.baselineTopPath) !== JSON.stringify(base.candidates[0]?.pathNodeIds ?? null) ||
        JSON.stringify(perturbRecord.perturbedTopPath) !== JSON.stringify(perturbed?.candidates[0]?.pathNodeIds ?? null) ||
        perturbRecord.topPathStable !== (JSON.stringify(base.candidates[0]?.pathNodeIds ?? null) === JSON.stringify(perturbed?.candidates[0]?.pathNodeIds ?? null))) sensitivityReplayMatches = false;
  }
  check('SENSITIVITY_REPLAY', sensitivityReplayMatches, 'beam-width sensitivity and feature-perturbation outputs are replayed; feature-schema mismatch is rejected; class imbalance is explicitly reported');
  check('NO_ACCEPTANCE_PROMOTION', evaluationArtifact?.acceptance === 'acceptance_required' && benchmarkArtifact?.acceptance === 'acceptance_required' &&
    benchmarkArtifact.execution?.authorized === false && benchmarkArtifact.evidenceLevel !== 'production_acceptance', 'offline metrics do not promote readiness or execution authority');
} catch (error) {
  blockers.push({ id: 'VERIFIER_INPUT_OR_REPLAY_ERROR', detail: error.message });
}

let git = { head: null, statusSha256: null, trackedPatchSha256: null };
try {
  git.head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  git.statusSha256 = hash(execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repoRoot, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }));
  git.trackedPatchSha256 = hash(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: repoRoot, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }));
} catch (error) { blockers.push({ id: 'GIT_IDENTITY_UNAVAILABLE', detail: error.message }); }
const allPassed = checks.length > 0 && checks.every(item => item.status === 'PASS') && blockers.length === 0;
const evidenceLevel = allPassed && files['--benchmark']?.value?.evidenceLevel === 'synthetic_technical_only' ? 'INTEGRITY_ONLY' : allPassed ? 'offline_unattested' : 'BLOCKED';
const report = {
  schemaVersion: 1, kind: 'agg_phase2_independent_verification_report',
  verificationStatus: allPassed ? 'VERIFIED' : 'BLOCKED', evidenceStatus: evidenceLevel,
  acceptanceStatus: 'ACCEPTANCE_REQUIRED', readiness: 'BLOCKED', executionGate: 'CLOSED',
  generatedAt: new Date().toISOString(), git, inputArtifacts: Object.fromEntries(Object.entries(files).map(([key, value]) => [key, { path: path.relative(repoRoot, value.path), sha256: value.sha256, sizeBytes: value.bytes.length }])),
  checks, blockers, limitations: ['Source-level replay and hashes do not attest label truth or adjudicator identity.', 'Synthetic corpus evidence is technical regression only.', 'No official Phase 1 trust roots, approvals, authorization or operational A/B are created by this workflow.'],
  replay: { command: `node scripts/verify-agg-phase2-workflow.mjs ${allowed.filter(key => key !== '--output').map(key => `${key} <${key.slice(2)}>`).join(' ')} --output <NEW_REPORT.json>`, outputMustBeNew: true }
};
if (fs.existsSync(output) || fs.lstatSync(path.dirname(output)).isSymbolicLink()) {
  console.error(`Output must be a new file in an existing non-symlink directory: ${output}`);
  process.exit(2);
}
if (fs.realpathSync(path.dirname(output)) !== path.dirname(output)) throw new Error('Verifier output parent must be canonical and non-symlinked');
writeFileExclusiveAtomic(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ output, verificationStatus: report.verificationStatus, evidenceStatus: report.evidenceStatus, acceptanceStatus: report.acceptanceStatus, passed: checks.filter(item => item.status === 'PASS').length, failed: checks.filter(item => item.status === 'FAIL').length, blockers }, null, 2));
if (!allPassed) process.exitCode = 2;
