import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { computeTaskOracle, verifySelectedPath } from '../benchmarks/adaptive-goal-graph/oracle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(root, 'benchmarks/adaptive-goal-graph/run-phase1-benchmark.mjs');
const verifier = path.join(root, 'benchmarks/adaptive-goal-graph/verify-phase1-ledger.mjs');
const catalogPath = path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/phase1-task-catalog.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

function run() {
  const result = spawnSync(process.execPath, [runner], { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 96 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || `runner exited ${result.status}`);
  return JSON.parse(result.stdout);
}
function stableProjection(output) {
  return {
    schemaVersion: output.schemaVersion,
    taskCount: output.taskCount,
    catalogSeed: output.catalogSeed,
    config: output.config,
    configuration: output.configuration,
    datasetDesign: output.datasetDesign,
    environment: output.environment,
    integrity: output.integrity,
    provenance: output.provenance,
    methods: output.methods,
    taskCatalog: output.taskCatalog,
    taskInstances: output.taskInstances,
    reuse: output.reuse,
    summaries: output.summaries.map(({ meanRuntimeMs, p95RuntimeMs, meanCpuUserTimeMs, meanCpuSystemTimeMs, meanCpuTimeMs,
      meanRssAfterBytes, meanHeapUsedAfterBytes, meanHeapUsedDeltaBytes, ...summary }) => summary),
    inference: {
      pairedComparisons: output.inference.pairedComparisons.filter(row => !['runtimeMs', 'cpuTimeMs'].includes(row.field)),
      pairedSuccessComparisons: output.inference.pairedSuccessComparisons
    },
    records: output.records.map(({ runtimeMs, cpuUserTimeMs, cpuSystemTimeMs, cpuTimeMs, rssBeforeBytes, rssAfterBytes,
      heapUsedBeforeBytes, heapUsedAfterBytes, heapUsedDeltaBytes, ...record }) => record)
  };
}

test('Phase 1 catalog contains 20–30 oracle-backed tasks over seven families', () => {
  assert.equal(catalog.families.length, 7);
  assert.equal(catalog.families.length * catalog.variantsPerFamily, 28);
  assert.ok(catalog.oracleContract.mustSatisfyAllRequiresAllEdgesBeforeEnteringTarget);
  assert.equal(catalog.searchBudget.maxExpansions, 80);
  assert.equal(catalog.searchBudget.expansionUnit, 'successor-edge examinations');
});

test('runner records all tasks, methods, seeds, raw paths and source hashes reproducibly', () => {
  const first = run();
  const second = run();
  assert.deepEqual(stableProjection(first), stableProjection(second));
  assert.equal(first.schemaVersion, 5);
  assert.equal(first.taskCount, 28);
  assert.equal(first.records.length, 28 * 5 * 5);
  assert.equal(first.records.length, first.summariesAndRawRuns.scoredRuns);
  assert.equal(first.summariesAndRawRuns.unscoredWarmupRuns, 5);
  assert.equal(first.summariesAndRawRuns.taskFamilyCount, 7);
  assert.equal(first.summariesAndRawRuns.unsatisfiableTaskCount, 7);
  assert.equal(first.summariesAndRawRuns.taskGraphInstances, 28 * 5);
  assert.equal(first.taskInstances.length, 28 * 5);
  assert.equal(first.modelCalls, 0);
  assert.equal(first.networkCalls, 0);
  assert.equal(first.tokenCost, null);
  assert.equal(first.monetaryCost, null);
  assert.deepEqual(new Set(first.summaries.map(item => item.variant)), new Set(['cot-linear:-','tot-tree:-','agg-beam:1','agg-beam:2','agg-beam:4']));
  for (const [field, file] of [['catalogSha256', catalogPath], ['runnerSha256', runner], ['graphRuntimeSha256', path.join(root,'src/runtime/adaptive-goal-graph.js')], ['knowledgeStoreSha256', path.join(root,'src/runtime/adaptive-goal-knowledge-store.js')], ['oracleSha256', path.join(root,'benchmarks/adaptive-goal-graph/oracle.mjs')], ['statisticsSha256', path.join(root,'benchmarks/adaptive-goal-graph/phase1-statistics.mjs')], ['planSha256', path.join(root,'docs/plugin-workflow-benchmark-plan.md')]]) {
    assert.equal(first.provenance[field], createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  }
  const freezePath = path.join(root, 'docs/plugin-workflow-benchmark-phase1-freeze.md');
  assert.equal(first.provenance.freezePath, 'docs/plugin-workflow-benchmark-phase1-freeze.md');
  assert.equal(first.provenance.freezeSha256, '4a2ceb6157afd9c299ccfee50695d0d0ddd1630375d49a211d68b53718fcca62');
  assert.equal(first.provenance.freezeSourceBytesObserved, fs.existsSync(freezePath));
  if (fs.existsSync(freezePath)) {
    assert.equal(createHash('sha256').update(fs.readFileSync(freezePath)).digest('hex'), first.provenance.freezeSha256,
      'present owner overlay bytes must match the pinned protocol digest');
  }
  assert.match(first.integrity.configurationSha256, /^[a-f0-9]{64}$/);
  assert.match(first.integrity.taskGraphInstancesSha256, /^[a-f0-9]{64}$/);
  assert.match(first.integrity.sourceSetSha256, /^[a-f0-9]{64}$/);
  assert.equal(first.datasetDesign.templateCount, 28);
  assert.equal(first.datasetDesign.independentTaskFamilyCount, 7);
  assert.equal(first.datasetDesign.graphInstanceCount, 140);
  assert.match(first.datasetDesign.holdout, /not declared or claimed/);
  assert.equal(first.taskCatalog.filter(task => task.expectedOutcome === 'no_solution').length, 7);
  assert.equal(first.taskCatalog.filter(task => task.oracle.validPathCount === 2).length, 7,
    'variant 2 must contain two competing valid paths certified independently');
  assert.ok(first.taskCatalog.filter(task => task.expectedOutcome === 'no_solution').every(task => task.oracle.validPathCount === 0 && task.expectedPath === null));
  assert.ok(first.taskCatalog.filter(task => task.expectedOutcome === 'solution').every(task => task.expectedPath && task.expectedPath.length > 5));
  assert.ok(first.taskCatalog.every(task => task.oracle.exhaustive && task.oracle.oracleId === 'independent-nominal-path-enumerator@1'));
  assert.ok(first.taskCatalog.every(task => task.oracle.minimumValidPathLength === null || Number.isInteger(task.oracle.minimumValidPathLength)));
  assert.ok(first.records.every(row => row.oracleVerifiedExpectedOutcome && row.evidenceClaimsVerified === false));
  assert.ok(first.records.every(row => Number.isSafeInteger(row.executionOrderIndex) && Number.isSafeInteger(row.executionOrderSeed)));
  assert.ok(first.records.every(row => /^[a-f0-9]{64}$/.test(row.inputGraphSha256)));
  assert.ok(first.records.every(row => Number.isFinite(row.cpuTimeMs) && row.cpuTimeMs >= 0 &&
    Number.isSafeInteger(row.rssBeforeBytes) && Number.isSafeInteger(row.rssAfterBytes) &&
    Number.isSafeInteger(row.heapUsedBeforeBytes) && Number.isSafeInteger(row.heapUsedAfterBytes)));
  assert.equal(new Set(first.records.map(row => row.trialId)).size, first.records.length);
  assert.ok(first.records.every(row => row.trialId === `${row.taskInstanceId}::${row.methodKey}` &&
    row.taskTemplateId === row.taskId && row.retryCount === 0 && row.retryBudget === 0 && row.attemptCount === 1 &&
    row.trialExitCode === 0 && row.trialError === null && row.timedOut === false));
  assert.deepEqual([...new Set(first.taskInstances.map(item => item.iteration))].sort(), [1, 2, 3, 4, 5]);
  for (const task of first.taskCatalog) {
    const graphHashes = new Set(first.taskInstances.filter(item => item.id === task.id).map(item =>
      createHash('sha256').update(JSON.stringify(item.graph)).digest('hex')));
    assert.ok(graphHashes.size > 1, `${task.id} must have seed-varied graph inputs across repetitions`);
  }
  for (const record of first.records) {
    const instance = first.taskInstances.find(row => row.id === record.taskId && row.iteration === record.iteration);
    assert.ok(instance, `missing raw graph instance for ${record.taskId} iteration ${record.iteration}`);
    assert.equal(record.inputGraphSha256, createHash('sha256').update(JSON.stringify(instance.graph)).digest('hex'));
  }
});

test('ToT performs bounded tree expansion and keeps alternatives; CoT remains single-chain', () => {
  const output = run();
  const cot = output.records.filter(row => row.method === 'cot-linear');
  const tot = output.records.filter(row => row.method === 'tot-tree');
  assert.equal(cot.length, 28 * 5);
  assert.equal(tot.length, 28 * 5);
  assert.ok(cot.every(row => row.backtrackCount === 0));
  assert.ok(tot.some(row => row.backtrackCount > 0), 'ToT should report actual alternative-frontier/backtracking activity');
  assert.ok(tot.every(row => row.treeNodesVisited >= row.pathNodeIds.length));
  assert.ok(output.methods['tot-tree:-'].algorithm.includes('best-first tree of explicit partial paths'));
  assert.equal(output.methods['tot-tree:-'].modelBacked, false);
  assert.equal(output.methods['tot-tree:-'].inputs, 'graph only; no oracle or expected-path fields');
  assert.equal(output.methods['cot-linear:-'].inputs, 'graph only; no oracle or expected-path fields');
});

test('independent oracle correctly checks satisfiable, competing and genuinely unsatisfiable tasks', () => {
  const output = run();
  for (const task of output.taskCatalog) {
    const oracle = computeTaskOracle(task);
    assert.equal(oracle.outcome, task.expectedOutcome, task.id);
    assert.equal(oracle.validPathCount, task.oracle.validPathCount, task.id);
    assert.equal(oracle.exhaustive, true, task.id);
    if (task.expectedPath) assert.equal(verifySelectedPath(task, task.expectedPath).valid, true, task.id);
  }
  const malformedDanglingEdge = structuredClone(output.taskCatalog[0]);
  malformedDanglingEdge.graph.edges.push({ from: 'missing-node', to: 'goal', type: 'next_step' });
  assert.throws(() => computeTaskOracle(malformedDanglingEdge), /unsupported or dangling edge/,
    'the oracle must fail closed on dangling transition edges, not silently ignore them');
  const malformedEdgeType = structuredClone(output.taskCatalog[0]);
  malformedEdgeType.graph.edges.push({ from: 'start', to: 'goal', type: 'execute_command' });
  assert.throws(() => computeTaskOracle(malformedEdgeType), /unsupported or dangling edge/,
    'the oracle must fail closed on edge types outside its declared contract');
  for (const task of output.taskCatalog.filter(task => task.variant === 4)) {
    assert.equal(task.oracle.validPathCount, 0, `${task.id} must be unsatisfiable because the prerequisite has no reachable producer`);
    for (const record of output.records.filter(row => row.taskId === task.id && row.method === 'tot-tree')) {
      assert.equal(record.claimedNoSolution, true, `ToT must exhaustively detect no solution for ${task.id}`);
      assert.equal(record.taskOutcomeCorrect, true);
    }
  }
});

test('equal per-run search budgets, quality oracle, prerequisite and evidence scoring are explicit', () => {
  const output = run();
  assert.ok(output.records.every(row => row.budget.maxDepth === 10 && row.budget.maxExpansions === 80));
  assert.ok(output.records.every(row => row.budget.expansionUnit === 'successor-edge examinations'));
  assert.ok(output.records.every(row => row.budget.budgetScope === 'successor-expansion-counter-only' &&
    row.budget.heuristicPreprocessingCharged === false && row.budget.cpuAndWallTimeIncludePreprocessing === true));
  assert.equal(output.budgetAccounting.totalComputeBudgetEqualized, false);
  assert.equal(output.configuration.budgetPolicy.totalComputeBudgetEqualized, false);
  assert.equal(output.configuration.budgetPolicy.scope, 'successor-expansion-counter-only');
  assert.equal(output.configuration.budgetPolicy.heuristicPreprocessingCharged, false);
  assert.equal(output.configuration.budgetPolicy.wallAndCpuMeasurePreprocessing, true);
  assert.match(output.interpretationNotes.equalBudget, /not a total graph-inspection\/computation budget/);
  assert.ok(output.records.every(row => Number.isFinite(row.qualityScore) && row.qualityScore <= row.qualityMax));
  assert.ok(output.records.some(row => row.feasiblePlan));
  assert.ok(output.records.some(row => !row.feasiblePlan));
  assert.ok(output.records.every(row => Array.isArray(row.evidenceRefsCovered) && Array.isArray(row.evidenceRefsMissing)));
  assert.equal(output.inference.pairedComparisons.length, 7);
  assert.ok(output.inference.pairedComparisons.every(row => row.tasks === 28 && row.familyClusters === 7 && row.bootstrapSamples === 10000));
  assert.ok(output.records.every(row => row.expansionCount <= row.budget.maxExpansions));
  assert.ok(output.records.filter(row => row.method === 'tot-tree').every(row => row.heuristicPreprocessingEdgeVisits > 0));
  assert.ok(output.records.filter(row => row.method !== 'tot-tree').every(row => row.heuristicPreprocessingEdgeVisits === 0));
  assert.ok(output.records.every(row => row.pathNodeIds.length - 1 <= row.budget.maxDepth));
  assert.ok(output.summaries.find(row => row.variant === 'agg-beam:1').taskOutcomeAccuracy > 0,
    'varied graph difficulty must not force one high-confidence dead-end decoy to make narrow beam fail every task');
  const aggBeamFour = output.summaries.find(row => row.variant === 'agg-beam:4');
  assert.ok(aggBeamFour, 'the pinned AGG beam-4 comparator must be present');
  assert.equal(aggBeamFour.taskOutcomeAccuracy, 1,
    'AGG beam-4 must match the independent oracle on all satisfiable and unsatisfiable seeded catalog instances');
  assert.equal(aggBeamFour.groundTruthPathValidityRateOnSolvableTasks, 1,
    'every AGG beam-4 goal candidate on a satisfiable graph must obey prerequisite and conflict contracts');
  assert.equal(aggBeamFour.correctNoSolutionRate, 1,
    'AGG beam-4 may claim no-solution only after exhaustive search and must resolve all frozen unsatisfiable fixtures');
  assert.equal(aggBeamFour.budgetExhaustionRate, 0,
    'the fixed synthetic catalog should not need to exhaust the AGG beam-4 search budget');
  assert.equal(output.summaries.find(row => row.variant === 'agg-beam:2').meanEstimatedPathCostOnFeasiblePaths > 0, true);
  assert.equal(output.summaries.find(row => row.variant === 'tot-tree:-').taskOutcomeAccuracy, 1,
    'ToT is expected to classify both solution and proven no-solution fixture outcomes correctly');
  assert.equal(output.summaries.find(row => row.variant === 'agg-beam:2').goalCompletionRateOnSolvableTasks, 1);
  assert.equal(output.summaries.find(row => row.variant === 'agg-beam:2').correctNoSolutionRate, 0,
    'AGG beam search must not claim proof of no-solution when pruning makes the search non-exhaustive');
  assert.equal(output.inference.pairedSuccessComparisons.length, 2);
  for (const row of output.inference.pairedSuccessComparisons) {
    assert.equal(row.pairedTaskInstances, 140);
    assert.equal(row.taskTemplates, 28);
    assert.equal(row.independentTaskFamilyClusters, 7);
    assert.equal(Object.values(row.contingency).reduce((sum, value) => sum + value, 0), 140);
    assert.equal(row.bootstrapSamples, 10_000);
    assert.ok(row.bootstrap95PercentileCI[0] <= row.bootstrap95PercentileCI[1]);
    assert.equal(row.powerAnalysis.status, 'NOT_ESTIMATED');
    assert.match(row.interpretation, /seven clusters are too few|inconclusive/);
  }
});

test('reuse is measured but unverified knowledge cannot become planning authority', () => {
  const output = run();
  assert.equal(output.reuse.goalCount, 28);
  assert.equal(output.reuse.crossGoalReusedNodeCount, 1);
  assert.ok(output.reuse.reusedNodes.every(row => row.verified === false && row.usableForPlanning === false));
});

test('raw and markdown reports are created exclusively', () => {
  fs.mkdirSync(path.join(root, '.test-tmp'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, '.test-tmp', 'phase1-report-'));
  const raw = path.join(dir, 'raw.json');
  const report = path.join(dir, 'report.md');
  try {
    const result = spawnSync(process.execPath, [runner, '--output', raw, '--report', report], { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 96 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    const rawBytes = fs.readFileSync(raw);
    assert.equal(JSON.parse(rawBytes.toString('utf8')).records.length, 700);
    assert.match(fs.readFileSync(report, 'utf8'), /Paired comparisons/);
    assert.match(fs.readFileSync(report, 'utf8'), /Paired success outcomes/);
    const manifestPath = `${raw}.manifest.json`;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.outputs.raw.sha256, createHash('sha256').update(rawBytes).digest('hex'));
    assert.equal(manifest.counts.scoredTrials, 700);
    const integrity = spawnSync(process.execPath, [verifier, '--raw', raw, '--manifest', manifestPath], {
      cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024
    });
    assert.equal(integrity.status, 0, integrity.stderr || integrity.stdout);
    assert.equal(JSON.parse(integrity.stdout).status, 'PASS_INTEGRITY_ONLY_NOT_ACCEPTANCE');
    const overwrite = spawnSync(process.execPath, [runner, '--output', raw], { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 96 * 1024 * 1024 });
    assert.notEqual(overwrite.status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
