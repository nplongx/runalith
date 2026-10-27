import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { parseStrictJson } from '../../src/runtime/strict-json.js';
import { computeTaskOracle, verifySelectedPath } from './oracle.mjs';
import { pairedOutcomeAnalysis } from './phase1-statistics.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE_METHOD_KEYS = ['cot-linear:-', 'tot-tree:-', 'agg-beam:1', 'agg-beam:2', 'agg-beam:4'];
const SOURCE_MAP = {
  catalogSha256: 'benchmarks/adaptive-goal-graph/fixtures/phase1-task-catalog.json',
  runnerSha256: 'benchmarks/adaptive-goal-graph/run-phase1-benchmark.mjs',
  graphRuntimeSha256: 'src/runtime/adaptive-goal-graph.js',
  knowledgeStoreSha256: 'src/runtime/adaptive-goal-knowledge-store.js',
  oracleSha256: 'benchmarks/adaptive-goal-graph/oracle.mjs',
  statisticsSha256: 'benchmarks/adaptive-goal-graph/phase1-statistics.mjs',
  planSha256: 'docs/plugin-workflow-benchmark-plan.md',
  freezeSha256: 'docs/plugin-workflow-benchmark-phase1-freeze.md',
  ledgerIntegritySha256: 'benchmarks/adaptive-goal-graph/phase1-ledger-integrity.mjs',
  ledgerVerifierSha256: 'benchmarks/adaptive-goal-graph/verify-phase1-ledger.mjs',
  strictJsonSha256: 'src/runtime/strict-json.js'
};
const HEX_256 = /^[a-f0-9]{64}$/;
const PINNED_PHASE1_FREEZE_SHA256 = '4a2ceb6157afd9c299ccfee50695d0d0ddd1630375d49a211d68b53718fcca62';

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function jsonBytes(value) { return Buffer.from(JSON.stringify(value)); }
function normalizedMethodKey(row) { return row?.methodKey ?? `${row?.method}:${row?.beamWidth ?? '-'}`; }
function taskInstanceKey(row) { return row?.taskInstanceId ?? `${row?.taskId}::seed-${row?.seed}`; }
function mean(rows, field) { return rows.length ? rows.reduce((sum, row) => sum + row[field], 0) / rows.length : null; }
function near(actual, expected, tolerance = 0.00011) {
  return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance;
}

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
        fs.realpathSync(resolved) !== resolved) throw new Error(`${label} changed during descriptor read: ${resolved}`);
    return bytes;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function actualSourceSha(sourceRoot, relativePath) {
  const root = path.resolve(sourceRoot);
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) {
    throw new Error(`source path escapes workspace or is not normalized: ${relativePath}`);
  }
  const filePath = path.resolve(root, relativePath);
  if (!filePath.startsWith(`${root}${path.sep}`) || fs.realpathSync(root) !== root) {
    throw new Error(`source path escapes workspace or source root is not canonical: ${relativePath}`);
  }
  const parts = relativePath.split(path.sep);
  let current = root;
  for (const [index, segment] of parts.entries()) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) || fs.realpathSync(current) !== current) {
      throw new Error(`source path contains missing/non-regular/symlinked component: ${relativePath}`);
    }
  }
  return sha256(readStableRegularFile(filePath, `source provenance input ${relativePath}`));
}

function safeOracle(task, errors, prefix) {
  try {
    const oracle = computeTaskOracle(task);
    if (oracle.outcome !== task.expectedOutcome) errors.push(`${prefix}: declared outcome disagrees with independent oracle`);
    if (task.oracle?.outcome !== oracle.outcome || task.oracle?.validPathCount !== oracle.validPathCount ||
        task.oracle?.minimumValidPathLength !== oracle.minimumValidPathLength || task.oracle?.exhaustive !== true ||
        task.oracle?.oracleId !== oracle.oracleId) {
      errors.push(`${prefix}: embedded oracle summary does not match recomputation`);
    }
    if (task.expectedOutcome === 'no_solution' && oracle.validPathCount !== 0) errors.push(`${prefix}: no-solution claim is not oracle-proven`);
    if (task.expectedOutcome === 'solution' && oracle.validPathCount < 1) errors.push(`${prefix}: solution task has no oracle-valid path`);
    if (task.expectedPath && !verifySelectedPath(task, task.expectedPath).valid) errors.push(`${prefix}: canonical expected path fails independent path validation`);
    return oracle;
  } catch (error) {
    errors.push(`${prefix}: oracle rejected task: ${error?.message ?? String(error)}`);
    return null;
  }
}

function verifyManifest({ manifest, manifestPath, raw, rawPath, rawBytes, sourceRoot, errors, warnings }) {
  if (!manifest || typeof manifest !== 'object') {
    errors.push('manifest: expected a JSON object');
    return;
  }
  if (manifest.manifestSchemaVersion !== 1) errors.push('manifest: unsupported manifestSchemaVersion');
  if (manifest.exitCode !== 0) errors.push('manifest: completed run does not declare exitCode 0');
  if (manifest.decision !== 'SUPPLEMENTAL_EVIDENCE_NOT_ACCEPTANCE') errors.push('manifest: acceptance decision label changed or missing');
  if (manifest.benchmark !== raw.benchmark) errors.push('manifest: benchmark id differs from raw ledger');
  if (!manifest.outputs?.raw || typeof manifest.outputs.raw.path !== 'string') {
    errors.push('manifest: raw output entry is missing');
  } else {
    if (path.resolve(sourceRoot, manifest.outputs.raw.path) !== path.resolve(rawPath)) errors.push('manifest: raw path does not resolve to the supplied raw ledger');
    if (manifest.outputs.raw.sha256 !== sha256(rawBytes)) errors.push('manifest: raw SHA-256 mismatch');
    if (manifest.outputs.raw.bytes !== rawBytes.byteLength) errors.push('manifest: raw byte count mismatch');
  }
  if (manifest.provenance && JSON.stringify(manifest.provenance) !== JSON.stringify(raw.provenance)) {
    errors.push('manifest: provenance differs from raw ledger');
  }
  if (manifest.hashes?.configurationSha256 !== raw.integrity?.configurationSha256) errors.push('manifest: configuration hash mismatch');
  if (manifest.hashes?.taskGraphInstancesSha256 !== raw.integrity?.taskGraphInstancesSha256) errors.push('manifest: realized dataset hash mismatch');
  if (manifest.hashes?.sourceSetSha256 !== raw.integrity?.sourceSetSha256) errors.push('manifest: source-set hash mismatch');
  if (manifest.hashes?.graderSha256 !== raw.integrity?.graderSha256) errors.push('manifest: grader hash mismatch');
  if (manifest.counts?.scoredTrials !== raw.records?.length) errors.push('manifest: scored-trial count mismatch');
  if (manifest.counts?.taskGraphInstances !== raw.taskInstances?.length) errors.push('manifest: task graph-instance count mismatch');
  if (manifest.outputs?.report) {
    const reportPath = path.resolve(sourceRoot, manifest.outputs.report.path);
    if (!reportPath.startsWith(`${path.resolve(sourceRoot)}${path.sep}`)) errors.push('manifest: report path escapes workspace');
    else {
      try {
        const stat = fs.lstatSync(reportPath);
        if (!stat.isFile() || stat.isSymbolicLink()) errors.push('manifest: report is not a regular file');
        else {
          const reportBytes = readStableRegularFile(reportPath, 'benchmark report output', 32 * 1024 * 1024);
          if (sha256(reportBytes) !== manifest.outputs.report.sha256) errors.push('manifest: report SHA-256 mismatch');
          if (reportBytes.byteLength !== manifest.outputs.report.bytes) errors.push('manifest: report byte count mismatch');
        }
      } catch (error) { errors.push(`manifest: report cannot be verified: ${error.message}`); }
    }
  }
  if (manifestPath && path.resolve(manifestPath) === path.resolve(rawPath)) errors.push('manifest path aliases raw ledger');
  if (manifest.outputs?.raw?.sha256 !== sha256(rawBytes)) warnings.push('manifest raw hash is not independently trustworthy until the manifest itself is anchored by an outer SHA256SUMS or signature');
}

/** Verify a schema-v4 historic or schema-v5 manifested raw graph benchmark. */
export function auditPhase1Ledger(raw, {
  rawBytes = jsonBytes(raw),
  rawPath = null,
  manifest = null,
  manifestPath = null,
  sourceRoot = DEFAULT_ROOT,
  allowHistoricalSource = false,
  requireManifest = false
} = {}) {
  const errors = [];
  const warnings = [];
  let sourceVersionStatus = 'UNVERIFIED';
  const root = path.resolve(sourceRoot);
  const fail = message => errors.push(message);

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { status: 'FAIL', errors: ['raw ledger is not a JSON object'], warnings, sourceVersionStatus };
  if (![4, 5].includes(raw.schemaVersion)) fail(`unsupported raw schemaVersion: ${raw.schemaVersion}`);
  if (raw.schemaVersion === 4 && !allowHistoricalSource) fail('schema-v4 ledger is historical; use --allow-historical-source for integrity-only audit, not current-source certification');
  if (raw.benchmark !== 'runalith-agg-phase1-verified-planning-catalog-v2') fail('unexpected benchmark fixture id');
  if (!Array.isArray(raw.records) || !Array.isArray(raw.taskCatalog) || !Array.isArray(raw.taskInstances)) {
    fail('raw ledger is missing records, taskCatalog or taskInstances arrays');
    return { status: 'FAIL', errors, warnings, sourceVersionStatus };
  }

  let catalog;
  try { catalog = parseStrictJson(readStableRegularFile(path.join(root, SOURCE_MAP.catalogSha256), 'frozen AGG Phase 1 task catalog'), 'frozen AGG Phase 1 task catalog'); }
  catch (error) {
    fail(`frozen task catalog cannot be loaded: ${error.message}`);
    return { status: 'FAIL', errors, warnings, sourceVersionStatus };
  }
  const expectedTaskCount = catalog.families.length * catalog.variantsPerFamily;
  const repeatSeeds = catalog.repeatSeeds;
  const expectedMethods = BASE_METHOD_KEYS;
  const expectedGraphInstances = expectedTaskCount * repeatSeeds.length;
  const expectedRecordCount = expectedGraphInstances * expectedMethods.length;
  if (raw.taskCount !== expectedTaskCount || raw.taskCatalog.length !== expectedTaskCount) fail(`task catalog count mismatch: expected ${expectedTaskCount}`);
  if (raw.config?.iterations !== repeatSeeds.length || JSON.stringify(raw.config?.repeatSeeds) !== JSON.stringify(repeatSeeds)) fail('repeat-seed configuration differs from frozen catalog');
  if (raw.taskInstances.length !== expectedGraphInstances) fail(`graph-instance count mismatch: expected ${expectedGraphInstances}`);
  if (raw.records.length !== expectedRecordCount) fail(`raw record count mismatch: expected ${expectedRecordCount}, found ${raw.records.length}`);
  if (raw.summariesAndRawRuns?.scoredRuns !== raw.records.length) fail('summariesAndRawRuns.scoredRuns differs from raw record count');
  if (raw.summariesAndRawRuns?.taskGraphInstances !== raw.taskInstances.length) fail('summariesAndRawRuns.taskGraphInstances differs from taskInstances count');
  if (raw.modelCalls !== 0 || raw.networkCalls !== 0 || raw.monetaryCost !== null || raw.tokenCost !== null) fail('algorithmic benchmark falsely declares model/network calls or measured costs');

  const actualMethods = Object.keys(raw.methods ?? {}).sort();
  if (JSON.stringify(actualMethods) !== JSON.stringify([...expectedMethods].sort())) fail('method set differs from the frozen algorithm comparison');
  for (const key of expectedMethods) {
    if (raw.methods?.[key]?.modelBacked === true) fail(`${key} falsely labelled model-backed in algorithm benchmark`);
    if (raw.methods?.[key]?.inputs && !raw.methods[key].inputs.includes('graph only')) fail(`${key} input contract is not graph-only`);
  }

  const expectedTemplates = new Map();
  for (const family of catalog.families) {
    for (const variant of catalog.variants) {
      expectedTemplates.set(`${family.id}-${String(variant.id).padStart(2, '0')}`, { familyId: family.id, variant: variant.id, expectedOutcome: variant.expectedOutcome });
    }
  }
  const baseById = new Map();
  for (const task of raw.taskCatalog) {
    if (baseById.has(task.id)) fail(`duplicate task template id: ${task.id}`);
    baseById.set(task.id, task);
    const expected = expectedTemplates.get(task.id);
    if (!expected) fail(`task template not present in frozen catalog: ${task.id}`);
    else {
      if (task.familyId !== expected.familyId || task.variant !== expected.variant || task.expectedOutcome !== expected.expectedOutcome) {
        fail(`task template identity or expected outcome differs from frozen catalog: ${task.id}`);
      }
    }
    safeOracle(task, errors, `taskCatalog/${task.id}`);
  }
  for (const missing of expectedTemplates.keys()) if (!baseById.has(missing)) fail(`missing frozen task template: ${missing}`);

  const instanceMap = new Map();
  const actualInstanceHashes = new Map();
  for (const instance of raw.taskInstances) {
    const instanceId = taskInstanceKey({ taskInstanceId: instance.taskInstanceId, taskId: instance.id, seed: instance.repeatSeed });
    if (instanceMap.has(instanceId)) fail(`duplicate task instance: ${instanceId}`);
    instanceMap.set(instanceId, instance);
    const template = baseById.get(instance.id);
    if (!template) fail(`task instance references unknown template: ${instance.id}`);
    else if (instance.familyId !== template.familyId || instance.variant !== template.variant || instance.expectedOutcome !== template.expectedOutcome) {
      fail(`task instance does not match task template: ${instanceId}`);
    }
    const seedIndex = repeatSeeds.indexOf(instance.repeatSeed);
    if (seedIndex < 0 || instance.iteration !== seedIndex + 1) fail(`task instance has invalid seed/iteration pairing: ${instanceId}`);
    const canonicalInstanceId = `${instance.id}::seed-${instance.repeatSeed}`;
    if (raw.schemaVersion >= 5 && instance.taskInstanceId !== canonicalInstanceId) fail(`taskInstanceId does not match template and seed: ${instanceId}`);
    if (!instance.graph || !Array.isArray(instance.graph.nodes) || !Array.isArray(instance.graph.edges)) fail(`task graph missing for ${instanceId}`);
    const graphHash = sha256(jsonBytes(instance.graph));
    actualInstanceHashes.set(instanceId, graphHash);
    safeOracle(instance, errors, `taskInstances/${instanceId}`);
  }

  const recordKeys = new Set();
  const recordsByMethod = new Map(expectedMethods.map(key => [key, []]));
  const pairedKeySets = new Map(expectedMethods.map(key => [key, new Set()]));
  for (const row of raw.records) {
    const methodKey = normalizedMethodKey(row);
    const taskInstanceId = taskInstanceKey(row);
    const identity = `${taskInstanceId}::${methodKey}`;
    if (recordKeys.has(identity)) fail(`duplicate trial identity: ${identity}`);
    recordKeys.add(identity);
    if (!recordsByMethod.has(methodKey)) fail(`unknown method key: ${methodKey}`);
    else recordsByMethod.get(methodKey).push(row);
    if (pairedKeySets.has(methodKey)) pairedKeySets.get(methodKey).add(taskInstanceId);
    const instance = instanceMap.get(taskInstanceId);
    if (!instance) { fail(`record has no matching task instance: ${identity}`); continue; }
    if (raw.schemaVersion >= 5) {
      if (row.taskInstanceId !== taskInstanceId || row.taskTemplateId !== row.taskId || row.trialId !== identity || row.trialKind !== 'seeded_graph_variant') {
        fail(`record trial identity fields mismatch: ${identity}`);
      }
    }
    if (row.taskId !== instance.id || row.taskFamily !== instance.familyId || row.taskSeed !== instance.taskSeed || row.iteration !== instance.iteration || row.seed !== instance.repeatSeed) {
      fail(`record task/family/template/seed identity mismatch: ${identity}`);
    }
    if (row.inputGraphSha256 !== actualInstanceHashes.get(taskInstanceId)) fail(`input graph SHA-256 mismatch: ${identity}`);
    if (row.expectedOutcome !== instance.expectedOutcome || row.oracleValidPathCount !== instance.oracle?.validPathCount) fail(`record oracle outcome mismatch: ${identity}`);
    if (!row.budget || row.budget.maxDepth !== raw.config.maxDepth || row.budget.maxExpansions !== raw.config.maxExpansions || row.budget.expansionUnit !== raw.config.equalBudgetUnit) {
      fail(`method budget differs from run configuration: ${identity}`);
    }
    if (raw.schemaVersion >= 5 && (row.budget?.budgetScope !== 'successor-expansion-counter-only' ||
        row.budget?.heuristicPreprocessingCharged !== false || row.budget?.cpuAndWallTimeIncludePreprocessing !== true)) {
      fail(`budget-accounting scope is missing or misleading: ${identity}`);
    }
    if (!Array.isArray(row.pathNodeIds) || !row.pathNodeIds.length) fail(`raw output path is missing: ${identity}`);
    if (!Number.isSafeInteger(row.expansionCount) || row.expansionCount < 0 || row.expansionCount > raw.config.maxExpansions) fail(`expansion metric outside declared budget: ${identity}`);
    if (!Number.isFinite(row.runtimeMs) || row.runtimeMs < 0 || !Number.isFinite(row.cpuTimeMs) || row.cpuTimeMs < 0) fail(`invalid time metric: ${identity}`);
    if (!Number.isFinite(row.qualityScore) || !Number.isFinite(row.qualityMax) || row.qualityScore < 0 || row.qualityScore > row.qualityMax) fail(`inconsistent quality metric: ${identity}`);
    if (row.evidenceClaimsVerified !== false) fail(`algorithmic reference coverage is being misrepresented as claim-truth verification: ${identity}`);
    if (raw.schemaVersion >= 5) {
      if (row.configurationSha256 !== raw.integrity?.configurationSha256 || row.taskGraphInstancesSha256 !== raw.integrity?.taskGraphInstancesSha256 ||
          row.sourceSetSha256 !== raw.integrity?.sourceSetSha256 || row.graderSha256 !== raw.integrity?.graderSha256) fail(`record provenance hash mismatch: ${identity}`);
      if (row.attemptCount !== 1 || row.retryCount !== 0 || row.retryBudget !== 0) fail(`trial attempt/retry budget invariant violated: ${identity}`);
      if (row.trialExitCode !== 0 || row.trialError !== null || row.timedOut !== false) fail(`trial completion/timeout/error fields are inconsistent: ${identity}`);
    }

    const reachesGoal = row.pathNodeIds.at(-1) === instance.graph.goalNodeId;
    if (row.foundSolution !== reachesGoal) fail(`foundSolution contradicts selected path: ${identity}`);
    if (row.claimedNoSolution && row.searchComplete !== true) fail(`no-solution claim is not marked exhaustive: ${identity}`);
    const checkedPath = reachesGoal ? verifySelectedPath(instance, row.pathNodeIds) : { valid: false, reasons: ['goal_not_reached'] };
    const expectedCorrect = instance.expectedOutcome === 'solution'
      ? row.foundSolution === true && checkedPath.valid
      : row.claimedNoSolution === true && row.foundSolution === false && instance.oracle?.validPathCount === 0;
    if (row.groundTruthPathValid !== (reachesGoal && checkedPath.valid)) fail(`groundTruthPathValid contradicts independent path oracle: ${identity}`);
    if (row.taskOutcomeCorrect !== expectedCorrect) fail(`taskOutcomeCorrect inconsistent with independent oracle and solver output: ${identity}`);
  }

  for (const instance of raw.taskInstances) {
    const id = taskInstanceKey({ taskInstanceId: instance.taskInstanceId, taskId: instance.id, seed: instance.repeatSeed });
    for (const method of expectedMethods) if (!pairedKeySets.get(method)?.has(id)) fail(`missing paired method record for ${id}/${method}`);
  }
  for (const method of expectedMethods) {
    const rows = recordsByMethod.get(method) ?? [];
    if (rows.length !== expectedGraphInstances) fail(`${method} run count mismatch: expected ${expectedGraphInstances}, found ${rows.length}`);
    if (new Set(rows.map(taskInstanceKey)).size !== expectedGraphInstances) fail(`${method} does not have exactly one row per graph instance`);
  }

  const expectedConfigHash = raw.configuration ? sha256(jsonBytes(raw.configuration)) : null;
  const expectedDatasetHash = sha256(jsonBytes(raw.taskInstances));
  const expectedSourceSetHash = raw.provenance ? sha256(jsonBytes(raw.provenance)) : null;
  if (raw.schemaVersion >= 5) {
    if (raw.integrity?.configurationSha256 !== expectedConfigHash) fail('configuration SHA-256 does not match embedded configuration');
    const expectedBudgetPolicy = {
      frozenUnit: raw.config?.equalBudgetUnit,
      maxDepth: raw.config?.maxDepth,
      maxExpansionsPerMethod: raw.config?.maxExpansions,
      scope: 'successor-expansion-counter-only',
      heuristicPreprocessingCharged: false,
      wallAndCpuMeasurePreprocessing: true,
      totalComputeBudgetEqualized: false
    };
    try { assert.deepEqual(raw.configuration?.budgetPolicy, expectedBudgetPolicy); }
    catch { fail('configuration does not cryptographically bind the fixed-budget scope and preprocessing-accounting policy'); }
    for (const key of Object.keys(expectedBudgetPolicy)) {
      if (raw.budgetAccounting?.[key] !== expectedBudgetPolicy[key]) fail(`top-level budget accounting differs from signed configuration policy: ${key}`);
    }
    if (raw.budgetAccounting?.interpretation !== 'The common hard cap applies to the method-specific successor-expansion counter, not total graph-inspection/computation. ToT graph-wide reverse-distance preprocessing is separately counted in heuristicPreprocessingEdgeVisits and is included in whole-method wall/CPU time but is not charged against maxExpansions. CoT lookahead/filtering and other implementation-specific work also differ. Interpret success under the frozen successor-expansion cap together with wall/CPU measurements; this run does not claim equal total computation.') {
      fail('long-form budget interpretation is missing or inconsistent');
    }
    if (raw.integrity?.taskGraphInstancesSha256 !== expectedDatasetHash) fail('realized graph-instance SHA-256 does not match embedded taskInstances');
    if (raw.integrity?.sourceSetSha256 !== expectedSourceSetHash) fail('source-set SHA-256 does not match embedded provenance');
    if (raw.integrity?.graderSha256 !== raw.provenance?.oracleSha256) fail('integrity grader hash does not equal oracle source hash');
  }

  if (raw.inference?.pairedSuccessComparisons) {
    const pairSpecs = [['agg-beam:2', 'cot-linear:-', 887701], ['agg-beam:2', 'tot-tree:-', 887702]];
    if (raw.inference.pairedSuccessComparisons.length !== pairSpecs.length) fail('paired success comparison count mismatch');
    for (const [methodA, methodB, bootstrapSeed] of pairSpecs) {
      try {
        const expected = pairedOutcomeAnalysis(raw.records, methodA, methodB, { bootstrapSeed, bootstrapSamples: 10_000 });
        const found = raw.inference.pairedSuccessComparisons.find(row => row.methodA === methodA && row.methodB === methodB);
        if (!found) fail(`missing paired success table: ${methodA} vs ${methodB}`);
        else {
          for (const key of ['pairedTaskInstances', 'taskTemplates', 'independentTaskFamilyClusters', 'contingency', 'successRateA', 'successRateB', 'pairedSuccessRateDifferenceAminusB', 'familyClusterEqualWeightDifferenceAminusB', 'bootstrap95PercentileCI', 'bootstrapSamples', 'bootstrapSeed', 'familyBreakdown', 'powerAnalysis']) {
            assert.deepEqual(found[key], expected[key]);
          }
        }
      } catch (error) { fail(`paired statistics invalid for ${methodA} vs ${methodB}: ${error.message}`); }
    }
  } else if (raw.schemaVersion >= 5) fail('schema-v5 ledger lacks paired success outcomes/statistics');

  for (const method of expectedMethods) {
    const summary = raw.summaries?.find(item => item.variant === method);
    const rows = recordsByMethod.get(method) ?? [];
    if (!summary) { fail(`missing method summary: ${method}`); continue; }
    if (summary.runs !== rows.length || summary.tasks !== expectedTaskCount) fail(`method summary count mismatch: ${method}`);
    const accuracy = mean(rows, 'taskOutcomeCorrect');
    if (!near(summary.taskOutcomeAccuracy, accuracy)) fail(`summary success rate does not match raw rows: ${method}`);
  }

  let actualHashes = {};
  const provenanceMismatches = [];
  let pinnedProtocolWithoutSourceBytes = false;
  for (const [field, relativePath] of Object.entries(SOURCE_MAP)) {
    if (raw.schemaVersion === 4 && field === 'statisticsSha256') continue;
    if (field === 'freezeSha256' && raw.provenance?.freezeSourceBytesObserved === false) {
      // The offline graph benchmark may carry the immutable protocol digest
      // while the owner-maintained document is intentionally absent from CI.
      // This is not a source-byte match and must be reported as such; a present
      // overlay is checked against the pin, while absence is not promoted into
      // a synthetic current-source hash. Operational Phase-1 scoring remains
      // strict and requires the actual freeze document bytes.
      if (raw.provenance.freezeSha256 !== PINNED_PHASE1_FREEZE_SHA256) {
        fail('frozen Phase-1 protocol digest differs from the immutable pin');
        continue;
      }
      try {
        const observed = actualSourceSha(root, relativePath);
        if (observed !== PINNED_PHASE1_FREEZE_SHA256) {
          fail('present owner-maintained Phase-1 freeze overlay differs from the immutable protocol digest');
          continue;
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          fail(`optional owner-maintained Phase-1 freeze overlay is unsafe or unreadable: ${error.message}`);
          continue;
        }
      }
      pinnedProtocolWithoutSourceBytes = true;
      continue;
    }
    let actual;
    try { actual = actualSourceSha(root, relativePath); }
    catch (error) { fail(`source provenance cannot be verified (${relativePath}): ${error.message}`); continue; }
    actualHashes[field] = actual;
    if (raw.provenance?.[field] !== actual) provenanceMismatches.push({ field, expectedInLedger: raw.provenance?.[field] ?? null, actualCurrentSource: actual });
  }
  if (provenanceMismatches.length) {
    if (allowHistoricalSource) {
      sourceVersionStatus = 'HISTORICAL_SOURCE_VERSION';
      warnings.push('source hashes differ from current workspace; ledger passed content/oracle consistency checks only, not current-source reproduction');
      warnings.push(...provenanceMismatches.map(item => `historical source mismatch ${item.field}: recorded=${item.expectedInLedger ?? 'missing'} current=${item.actualCurrentSource}`));
    } else {
      sourceVersionStatus = 'SOURCE_HASH_MISMATCH';
      fail(`current source hashes differ from raw ledger: ${provenanceMismatches.map(item => item.field).join(', ')}`);
    }
  } else if (pinnedProtocolWithoutSourceBytes) {
    sourceVersionStatus = 'PINNED_PROTOCOL_HASH_WITHOUT_SOURCE_BYTES';
    warnings.push('frozen Phase-1 digest is pinned, but owner-maintained document bytes were not captured by this offline benchmark; this is not current-source-byte reproduction or operational Phase-1 acceptance');
  } else sourceVersionStatus = 'CURRENT_SOURCE_HASHES_MATCH';

  if (raw.schemaVersion >= 5 && !allowHistoricalSource) {
    if (!manifest && requireManifest) fail('required sidecar manifest was not supplied');
    if (manifest) verifyManifest({ manifest, manifestPath, raw, rawPath, rawBytes, sourceRoot: root, errors, warnings });
  } else if (!manifest) {
    warnings.push('no sidecar manifest was supplied; raw ledger can be audited, but file truncation/tampering cannot be checked against an external run manifest');
  } else verifyManifest({ manifest, manifestPath, raw, rawPath, rawBytes, sourceRoot: root, errors, warnings });

  // Re-read the complete source provenance set after oracle/statistical and
  // sidecar checks. This rejects a mixed-version audit if a source input was
  // replaced after its initial hash was captured.
  for (const [field, relativePath] of Object.entries(SOURCE_MAP)) {
    const initialHash = actualHashes[field];
    if (!initialHash) continue;
    try {
      const finalHash = actualSourceSha(root, relativePath);
      if (finalHash !== initialHash) fail(`source changed while benchmark ledger was being audited: ${relativePath}`);
    } catch (error) { fail(`source provenance stability recheck failed (${relativePath}): ${error.message}`); }
  }

  return {
    status: errors.length ? 'FAIL' : 'PASS_INTEGRITY_ONLY_NOT_ACCEPTANCE',
    schemaVersion: raw.schemaVersion,
    benchmark: raw.benchmark,
    sourceVersionStatus,
    counts: {
      taskTemplates: raw.taskCatalog.length,
      taskFamilyClusters: new Set(raw.taskCatalog.map(task => task.familyId)).size,
      taskGraphInstances: raw.taskInstances.length,
      records: raw.records.length,
      methodRecords: Object.fromEntries([...recordsByMethod.entries()].map(([method, rows]) => [method, rows.length]))
    },
    hashes: {
      rawSha256: sha256(rawBytes),
      configurationSha256: raw.integrity?.configurationSha256 ?? null,
      taskGraphInstancesSha256: raw.integrity?.taskGraphInstancesSha256 ?? expectedDatasetHash,
      sourceSetSha256: raw.integrity?.sourceSetSha256 ?? expectedSourceSetHash,
      graderSha256: raw.integrity?.graderSha256 ?? raw.provenance?.oracleSha256 ?? null,
      actualCurrentSources: actualHashes
    },
    errors,
    warnings
  };
}
