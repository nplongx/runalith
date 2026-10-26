#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeTaskOracle, verifySelectedPath } from './oracle.mjs';
import { pairedOutcomeAnalysis } from './phase1-statistics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNNER = 'benchmarks/adaptive-goal-graph/run-local-llm-phase1-benchmark.mjs';
const ORACLE = 'benchmarks/adaptive-goal-graph/oracle.mjs';
const GRAPH_RUNTIME = 'src/runtime/adaptive-goal-graph.js';
const HASH = /^[a-f0-9]{64}$/;

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function shaJson(value) { return sha256(Buffer.from(JSON.stringify(value))); }
function methodKey(row) { return row.methodKey ?? row.method; }
function expectedDataset(task) {
  return {
    taskId: task.id, familyId: task.familyId, variant: task.variant, seed: task.seed,
    expectedOutcome: task.expectedOutcome, graph: task.graph,
    requiredEvidenceRefs: task.requiredEvidenceRefs, requiredStageNodeIds: task.requiredStageNodeIds,
    acceptableRouteStageSets: task.acceptableRouteStageSets, forbiddenNodeIds: task.forbiddenNodeIds
  };
}
function actualFileHash(root, relative) {
  const resolvedRoot = path.resolve(root);
  const full = path.resolve(resolvedRoot, relative);
  if (!full.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`path escapes source root: ${relative}`);
  const stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`not a regular non-symlink file: ${relative}`);
  return sha256(fs.readFileSync(full));
}
function add(errors, condition, message) { if (!condition) errors.push(message); }

/** Read-only integrity auditor for completed local model-backed graph-selection runs. */
export function auditLocalLLMPhase1Ledger(raw, {
  rawBytes = Buffer.from(JSON.stringify(raw)),
  rawPath,
  manifest,
  manifestPath,
  sourceRoot = ROOT
} = {}) {
  const errors = [];
  const warnings = [];
  const root = path.resolve(sourceRoot);
  const fail = message => errors.push(message);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { status: 'FAIL', errors: ['raw ledger must be a JSON object'], warnings };
  if (raw.protocol !== 'agg-local-llm-graph-selection@1') fail('unexpected local LLM protocol id');
  if (raw.decision !== 'SUPPLEMENTAL_EVIDENCE_NOT_ACCEPTANCE') fail('completed local model run must remain explicitly non-acceptance evidence');
  if (!Array.isArray(raw.records) || !Array.isArray(raw.taskIds) || !Array.isArray(raw.summaries)) return { status: 'FAIL', errors: ['raw ledger is missing records/taskIds/summaries'], warnings };
  if (!manifest || typeof manifest !== 'object') fail('required completed-run manifest is missing');
  if (!raw.configuration || !raw.modelConfiguration) fail('model configuration is missing');
  else if (JSON.stringify(raw.configuration) !== JSON.stringify(raw.modelConfiguration)) fail('duplicated model configuration fields diverge');
  if (!HASH.test(raw.configurationSha256 ?? '') || raw.configurationSha256 !== shaJson(raw.configuration)) fail('model configuration hash mismatch');
  if (!HASH.test(raw.datasetSha256 ?? '') || !HASH.test(raw.sourceSetSha256 ?? '') || !HASH.test(raw.graderSha256 ?? '')) fail('dataset/source/grader SHA-256 fields are missing or malformed');
  if (!raw.sourceHashes || !raw.sourcePaths) fail('source provenance or source path map missing');
  else {
    if (raw.sourceSetSha256 !== shaJson(raw.sourceHashes)) fail('source-set hash does not match sourceHashes');
    if (raw.graderSha256 !== raw.sourceHashes.oracleSha256) fail('grader hash differs from the oracle source hash');
    const sourceChecks = [
      ['runnerSha256', raw.sourcePaths.runner], ['oracleSha256', raw.sourcePaths.oracle],
      ['graphRuntimeSha256', raw.sourcePaths.graphRuntime]
    ];
    for (const [field, relative] of sourceChecks) {
      try {
        const actual = actualFileHash(root, relative);
        if (raw.sourceHashes[field] !== actual) fail(`current source hash mismatch: ${field}`);
      } catch (error) { fail(`source file cannot be checked (${field}): ${error.message}`); }
    }
  }

  let inputLedger = null;
  let actualInputHash = null;
  try {
    const inputPath = path.resolve(root, raw.inputPath);
    if (!inputPath.startsWith(`${root}${path.sep}`)) throw new Error('input path escapes source root');
    const inputStat = fs.lstatSync(inputPath);
    if (!inputStat.isFile() || inputStat.isSymbolicLink()) throw new Error('input path is not a regular file');
    const inputBytes = fs.readFileSync(inputPath);
    actualInputHash = sha256(inputBytes);
    inputLedger = JSON.parse(inputBytes.toString('utf8'));
    if (actualInputHash !== raw.inputSha256 || actualInputHash !== raw.sourceHashes?.inputLedgerSha256) fail('input ledger SHA-256 mismatch');
  } catch (error) { fail(`input ledger cannot be loaded/verified: ${error.message}`); }

  const selectedTasks = [];
  if (inputLedger?.taskCatalog) {
    const tasksById = new Map(inputLedger.taskCatalog.map(task => [task.id, task]));
    if (new Set(raw.taskIds).size !== raw.taskIds.length) fail('duplicate task ID in taskIds');
    for (const id of raw.taskIds) {
      const task = tasksById.get(id);
      if (!task) fail(`taskId missing from frozen input catalog: ${id}`);
      else selectedTasks.push(task);
    }
    const datasetHash = shaJson(selectedTasks.map(expectedDataset));
    if (datasetHash !== raw.datasetSha256) fail('selected task graph dataset hash mismatch');
    if (raw.taskCount !== selectedTasks.length || raw.datasetDesign?.taskTemplates !== selectedTasks.length) fail('task count differs from selected catalog tasks');
    if (raw.datasetDesign?.holdout !== 'not used or claimed') fail('holdout state is ambiguous or falsely declared');
  }

  const requiredMethods = ['llm-chain', 'llm-tot-prompted', 'agg-beam:4'];
  const methodCounts = Object.fromEntries(requiredMethods.map(key => [key, 0]));
  const trialIds = new Set();
  const recordIndex = new Map();
  let modelCallAttempts = 0;
  let measuredPromptTokens = 0;
  let measuredOutputTokens = 0;
  let promptTokenComplete = true;
  let outputTokenComplete = true;
  const taskById = new Map(selectedTasks.map(task => [task.id, task]));

  for (const row of raw.records) {
    const method = methodKey(row);
    if (!Object.hasOwn(methodCounts, method)) { fail(`unexpected method: ${method}`); continue; }
    methodCounts[method] += 1;
    const id = `${row.taskInstanceId}::${method}`;
    if (trialIds.has(row.trialId ?? id)) fail(`duplicate trial identity: ${row.trialId ?? id}`);
    trialIds.add(row.trialId ?? id);
    const canonicalTaskInstance = `${row.taskId}::catalog-seed-${inputLedger?.catalogSeed}`;
    if (row.taskId !== row.taskTemplateId || row.taskInstanceId !== canonicalTaskInstance || row.trialId !== id) fail(`task/trial identity mismatch: ${id}`);
    if (row.attemptCount !== 1 || row.retryCount !== 0 || row.retryBudget !== 0) fail(`attempt/retry policy violated: ${id}`);
    if (row.trialExitCode !== 0 || row.trialError !== null || row.timedOut !== false || row.status !== 'completed') fail(`completed raw trial has failure/timeout status: ${id}`);
    if (row.configurationSha256 !== raw.configurationSha256 || row.datasetSha256 !== raw.datasetSha256 ||
        row.sourceSetSha256 !== raw.sourceSetSha256 || row.graderSha256 !== raw.graderSha256) fail(`record provenance hash mismatch: ${id}`);
    const task = taskById.get(row.taskId);
    if (!task) { fail(`record references task outside dataset: ${id}`); continue; }
    if (row.taskFamily !== task.familyId || row.familyId !== task.familyId || row.variant !== task.variant ||
        row.taskSeed !== task.seed || row.seed !== task.seed || row.expectedOutcome !== task.expectedOutcome || row.iteration !== 1) {
      fail(`task family/template/seed/outcome mismatch: ${id}`);
    }
    const oracle = computeTaskOracle(task);
    if (oracle.outcome !== task.expectedOutcome || row.oracleOutcome !== oracle.outcome || row.oracleValidPathCount !== oracle.validPathCount) fail(`oracle mismatch: ${id}`);
    const computedGraphHash = shaJson(task.graph);
    if (row.inputGraphSha256 !== computedGraphHash) fail(`input graph hash mismatch: ${id}`);
    if (method !== 'agg-beam:4') {
      if (row.provider !== 'ollama-local' || row.providerVersion !== raw.ollamaVersion ||
          row.modelName !== raw.model?.name || row.modelDigest !== raw.model?.digest) fail(`model/provider identity mismatch: ${id}`);
      if (row.modelCallAttempts !== 1) fail(`model trial must have exactly one call attempt: ${id}`);
      modelCallAttempts += row.modelCallAttempts ?? 0;
      if (!HASH.test(row.promptSha256 ?? '') || !HASH.test(row.outputSha256 ?? '')) fail(`prompt/output hash missing or malformed: ${id}`);
      for (const [field, currentSum, assign] of [
        ['promptEvalCount', measuredPromptTokens, value => { measuredPromptTokens = value; }],
        ['outputEvalCount', measuredOutputTokens, value => { measuredOutputTokens = value; }]
      ]) {
        if (Number.isSafeInteger(row[field]) && row[field] >= 0) assign(currentSum + row[field]);
        else if (field === 'promptEvalCount') promptTokenComplete = false;
        else outputTokenComplete = false;
      }
      if (row.tokenCost !== null || row.monetaryCost !== null || row.costStatus !== 'NOT_MEASURED_LOCAL_INFERENCE') fail(`model cost is being misrepresented: ${id}`);
      if (row.budget?.maxModelCalls !== 1 || row.budget?.maxToolCalls !== 0 || row.budget?.retryBudget !== 0) fail(`model budget differs from the predeclared configuration: ${id}`);
    } else {
      if (row.provider !== null || row.modelDigest !== null || row.modelCallAttempts !== undefined) fail(`algorithm comparator was mislabeled as model-backed: ${id}`);
      if (row.budget?.maxExpansions !== 80 || row.budget?.maxDepth !== 10 || row.budget?.maxModelCalls !== 0 || row.budget?.retryBudget !== 0) fail(`AGG comparator budget differs from declared budget: ${id}`);
    }

    if (typeof row.taskOutcomeCorrect !== 'boolean') fail(`completed trial must have a binary outcome: ${id}`);
    let pathResult = { valid: false, reasons: ['no-solution-or-path-missing'] };
    if (row.answerStatus === 'solution' && Array.isArray(row.pathNodeIds)) pathResult = verifySelectedPath(task, row.pathNodeIds);
    const validSolution = row.answerStatus === 'solution' && pathResult.valid;
    const correctNoSolution = row.answerStatus === 'no_solution' && oracle.outcome === 'no_solution' && oracle.validPathCount === 0 && oracle.exhaustive;
    if (row.validSolution !== validSolution) fail(`validSolution flag conflicts with independent path check: ${id}`);
    if (row.correctNoSolution !== correctNoSolution) fail(`correctNoSolution flag conflicts with independent oracle: ${id}`);
    const expectedCorrect = oracle.outcome === 'solution' ? validSolution : correctNoSolution;
    if (row.taskOutcomeCorrect !== expectedCorrect) fail(`taskOutcomeCorrect conflicts with independent oracle: ${id}`);
    if (row.groundTruthPathValid !== undefined && row.groundTruthPathValid !== (row.answerStatus === 'solution' && pathResult.valid)) fail(`groundTruthPathValid metric is inconsistent: ${id}`);
    const key = `${row.taskInstanceId}::${method}`;
    if (recordIndex.has(key)) fail(`duplicate paired record key: ${key}`);
    recordIndex.set(key, row);
  }

  const expectedRowCount = selectedTasks.length * requiredMethods.length;
  if (raw.records.length !== expectedRowCount) fail(`record count mismatch: expected ${expectedRowCount}, found ${raw.records.length}`);
  for (const method of requiredMethods) if (methodCounts[method] !== selectedTasks.length) fail(`${method} record count mismatch`);
  for (const task of selectedTasks) {
    const taskInstanceId = `${task.id}::catalog-seed-${inputLedger?.catalogSeed}`;
    for (const method of requiredMethods) if (!recordIndex.has(`${taskInstanceId}::${method}`)) fail(`missing task/method record: ${taskInstanceId}/${method}`);
    const hashes = requiredMethods.map(method => recordIndex.get(`${taskInstanceId}::${method}`)?.inputGraphSha256);
    if (new Set(hashes).size !== 1 || hashes[0] === undefined) fail(`paired methods received different input graph: ${taskInstanceId}`);
  }

  const expectedModelCalls = selectedTasks.length * 2;
  if (modelCallAttempts !== expectedModelCalls || raw.modelCalls !== expectedModelCalls) fail('model-call count differs from declared one-call-per-model-trial policy');
  if (raw.modelCallFailures !== 0) fail('completed run incorrectly reports model-call failures');
  if (raw.localHttpRequests !== expectedModelCalls + 2 || raw.externalNetworkCalls !== 0 || raw.toolCalls !== 0) fail('local HTTP/model/tool call counters are inconsistent');
  if (raw.measuredInputTokens !== (promptTokenComplete ? measuredPromptTokens : null)) fail('measured input token total does not match per-trial records');
  if (raw.measuredOutputTokens !== (outputTokenComplete ? measuredOutputTokens : null)) fail('measured output token total does not match per-trial records');
  if (raw.tokenCost !== null || raw.monetaryCost !== null || raw.monetaryCostStatus !== 'NOT_MEASURED_NO_VERIFIED_PRICE_SOURCE') fail('run-level monetary cost must remain unknown');

  for (const [methodA, methodB, seed] of [['llm-chain','agg-beam:4',992201], ['llm-tot-prompted','agg-beam:4',992202]]) {
    try {
      const expected = pairedOutcomeAnalysis(raw.records, methodA, methodB, { bootstrapSeed: seed, bootstrapSamples: 10_000 });
      const found = raw.inference?.pairedSuccessComparisons?.find(row => row.methodA === methodA && row.methodB === methodB);
      if (!found) fail(`missing paired outcome table: ${methodA}/${methodB}`);
      else assert.deepEqual(found, expected);
    } catch (error) { fail(`paired outcome analysis mismatch (${methodA}/${methodB}): ${error.message}`); }
  }

  for (const method of requiredMethods) {
    const summary = raw.summaries.find(row => row.method === method);
    const rows = raw.records.filter(row => methodKey(row) === method);
    if (!summary || summary.tasks !== rows.length) { fail(`missing/inconsistent method summary: ${method}`); continue; }
    const accuracy = rows.filter(row => row.taskOutcomeCorrect).length / rows.length;
    if (Math.abs(summary.taskOutcomeAccuracy - accuracy) > 1e-12) fail(`summary success rate does not match task-level outcomes: ${method}`);
  }

  if (!manifest || manifest.manifestSchemaVersion !== 1 || manifest.status !== 'COMPLETE' || manifest.exitCode !== 0 ||
      manifest.decision !== 'SUPPLEMENTAL_EVIDENCE_NOT_ACCEPTANCE') fail('manifest must declare a completed, non-acceptance run with exit code 0');
  if (manifest?.hashes?.rawSha256 !== sha256(rawBytes) || manifest?.outputs?.raw?.sha256 !== sha256(rawBytes)) fail('manifest raw file SHA-256 mismatch');
  if (manifest?.outputs?.raw?.bytes !== rawBytes.byteLength) fail('manifest raw file byte count mismatch');
  if (rawPath && manifest?.outputs?.raw?.path !== path.relative(root, rawPath)) fail('manifest raw path mismatch');
  if (manifest?.hashes?.configurationSha256 !== raw.configurationSha256 || manifest?.hashes?.datasetSha256 !== raw.datasetSha256 ||
      manifest?.hashes?.sourceSetSha256 !== raw.sourceSetSha256 || manifest?.hashes?.graderSha256 !== raw.graderSha256 ||
      manifest?.hashes?.inputLedgerSha256 !== actualInputHash) fail('manifest provenance hash mismatch');
  if (manifest?.counts?.records !== raw.records.length || manifest?.counts?.modelCalls !== raw.modelCalls ||
      manifest?.counts?.taskTemplates !== raw.taskCount) fail('manifest count mismatch');
  if (manifestPath && path.resolve(manifestPath) === path.resolve(rawPath ?? '')) fail('manifest path aliases raw result');
  if (manifest?.outputs?.report) {
    try {
      const reportPath = path.resolve(root, manifest.outputs.report.path);
      if (!reportPath.startsWith(`${root}${path.sep}`)) throw new Error('report path escapes source root');
      const stat = fs.lstatSync(reportPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('report is not a regular file');
      const bytes = fs.readFileSync(reportPath);
      if (sha256(bytes) !== manifest.outputs.report.sha256 || bytes.byteLength !== manifest.outputs.report.bytes) fail('manifest report hash/size mismatch');
    } catch (error) { fail(`report cannot be verified: ${error.message}`); }
  }

  return {
    status: errors.length ? 'FAIL' : 'PASS_INTEGRITY_ONLY_NOT_ACCEPTANCE',
    protocol: raw.protocol,
    counts: { taskTemplates: selectedTasks.length, taskFamilyClusters: new Set(selectedTasks.map(task => task.familyId)).size, records: raw.records.length, methodCounts, modelCalls: modelCallAttempts },
    hashes: { rawSha256: sha256(rawBytes), inputLedgerSha256: actualInputHash, configurationSha256: raw.configurationSha256, datasetSha256: raw.datasetSha256, sourceSetSha256: raw.sourceSetSha256, graderSha256: raw.graderSha256 },
    warnings: [...warnings, 'Model-backed evidence is still supplemental: graph generation and end-to-end workflow/tool cost are excluded, a one-shot ToT-style prompt is not canonical multi-call ToT, and seven synthetic family clusters do not prove acceptance.'],
    errors
  };
}

function main() {
  const args = process.argv.slice(2);
  let rawPath = null;
  let manifestPath = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--raw' && args[index + 1]) rawPath = path.resolve(args[++index]);
    else if (args[index] === '--manifest' && args[index + 1]) manifestPath = path.resolve(args[++index]);
    else if (args[index] === '--help') {
      console.log('Usage: node benchmarks/adaptive-goal-graph/verify-local-llm-phase1-ledger.mjs --raw artifacts/local-model-run.json --manifest artifacts/local-model-run.json.manifest.json');
      process.exit(0);
    } else throw new Error(`unknown or incomplete argument: ${args[index]}`);
  }
  if (!rawPath || !manifestPath) throw new Error('--raw and --manifest are required');
  for (const filename of [rawPath, manifestPath]) {
    if (!filename.startsWith(`${ROOT}${path.sep}`)) throw new Error('raw and manifest paths must remain inside the repository');
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('raw and manifest must be regular non-symlink files');
  }
  const rawBytes = fs.readFileSync(rawPath);
  const raw = JSON.parse(rawBytes.toString('utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const result = auditLocalLLMPhase1Ledger(raw, { rawBytes, rawPath, manifest, manifestPath, sourceRoot: ROOT });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === 'FAIL') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`LOCAL_LLM_LEDGER_AUDIT=FAIL\n${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}
