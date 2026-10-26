import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson } from '../src/runtime/workflow/plan.js';
import { hashArtifactContent } from '../src/runtime/workflow/artifacts.js';
import { ADAPTIVE_GOAL_SANDBOX_IMPLEMENTATION_FILES, verifyAdaptiveGoalSandboxReceipt } from '../src/runtime/adaptive-goal-sandbox-executor.js';

// These tests construct stored-receipt fixtures only. They never invoke or authorize
// runAdaptiveGoalSandboxAction / implement-fixture-validator-v1.
const INPUT_LIMIT = 64 * 1024;
const FILE_PATHS = Object.freeze([
  'inputs/requirements.json', 'inputs/architecture.json', 'src/validator.mjs', 'test/validator.test.mjs'
]);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function objectWithExactSerializedLength(targetBytes) {
  let low = 0;
  let high = targetBytes;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const size = Buffer.byteLength(JSON.stringify({ payload: 'x'.repeat(mid) }));
    if (size < targetBytes) low = mid + 1;
    else high = mid;
  }
  const value = { payload: 'x'.repeat(low) };
  assert.equal(Buffer.byteLength(JSON.stringify(value)), targetBytes, 'test must create exact JSON payload size');
  return value;
}

function makeReceiptFixture({ largeRequirements = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-receipt-integrity-'));
  fs.chmodSync(root, 0o700);
  const directory = path.join(root, 'agg-action-fixture01');
  fs.mkdirSync(directory, { mode: 0o700 });
  const requirements = largeRequirements
    ? objectWithExactSerializedLength(INPUT_LIMIT)
    : { scope: 'fixture-only receipt check', acceptance_criteria: ['bytes match'], non_goals: ['no action execution'] };
  const architecture = { boundary: 'stored receipt verification only' };
  const inputContent = { requirements, architecture };
  for (const dir of ['inputs', 'src', 'test']) fs.mkdirSync(path.join(directory, dir), { mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'inputs/requirements.json'), `${JSON.stringify(requirements)}\n`, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(path.join(directory, 'inputs/architecture.json'), `${JSON.stringify(architecture)}\n`, { mode: 0o600, flag: 'wx' });
  for (const [relativePath, source] of Object.entries(ADAPTIVE_GOAL_SANDBOX_IMPLEMENTATION_FILES)) {
    fs.writeFileSync(path.join(directory, relativePath), source.trimStart(), { mode: 0o600, flag: 'wx' });
  }
  const receipt = {
    schemaVersion: 1,
    actionId: 'implement-fixture-validator-v1',
    jobId: 'job-receipt-fixture',
    taskId: 'task-receipt-fixture',
    candidateHash: 'c'.repeat(64),
    immutablePlanHash: 'd'.repeat(64),
    intentHash: 'e'.repeat(64),
    startedAt: '2026-10-23T00:00:00.000Z',
    executor: 'isolated-node-test-fixture',
    sandboxDirectoryName: path.basename(directory),
    timeoutMs: 5000,
    resourceLimits: { maxInputBytesPerArtifact: INPUT_LIMIT, maxInputBytesTotal: 2 * INPUT_LIMIT, maxOutputBytes: 64 * 1024 },
    prerequisites: [
      { type: 'requirements', sourceJobId: 'source-job-fixture', artifactId: 'artifact-requirements', contentHash: hashArtifactContent(requirements), artifactCreatedEventId: 'event-created-requirements', producerRole: 'product-owner', producerTaskId: 'task-requirements', producerResultId: 'result-requirements', producerCompletionEventId: 'event-completed-requirements' },
      { type: 'architecture', sourceJobId: 'source-job-fixture', artifactId: 'artifact-architecture', contentHash: hashArtifactContent(architecture), artifactCreatedEventId: 'event-created-architecture', producerRole: 'architect', producerTaskId: 'task-architecture', producerResultId: 'result-architecture', producerCompletionEventId: 'event-completed-architecture' }
    ],
    files: [],
    execution: {
      exitCode: 0, signal: null, elapsedMs: 1.25, testsPassed: 3, testsFailed: 0,
      nodePermissionModelEnabled: true, filesystemReadRoot: directory, filesystemWriteRoot: directory,
      childProcessAllowed: false, addonsAllowed: false, workersAllowedForTestHarness: false,
      networkPermissionEnforced: false, osCpuMemoryQuotaEnforced: false,
      stdoutSha256: digest(''), stderrSha256: digest(''), stdoutPreview: '', stderrPreview: ''
    }
  };
  const receiptPath = path.join(directory, 'receipt.json');
  function persistReceiptFromObservedFileBytes() {
    receipt.files = FILE_PATHS.map(relativePath => {
      const bytes = fs.readFileSync(path.join(directory, relativePath));
      return { path: relativePath, bytes: bytes.length, sha256: digest(bytes) };
    });
    const bytes = Buffer.from(`${canonicalJson(receipt)}\n`);
    fs.writeFileSync(receiptPath, bytes, { mode: 0o600 });
    return { bytes, sha256: digest(bytes) };
  }
  const persisted = persistReceiptFromObservedFileBytes();
  return { root, directory, receiptPath, receipt, inputContent, persistReceiptFromObservedFileBytes, persisted };
}

function verifyFixture(fixture, persisted = fixture.persisted, overrides = {}) {
  return verifyAdaptiveGoalSandboxReceipt({
    sandboxRoot: fixture.root, receiptPath: fixture.receiptPath, receiptSha256: persisted.sha256,
    jobId: overrides.jobId ?? fixture.receipt.jobId, candidateHash: overrides.candidateHash ?? fixture.receipt.candidateHash,
    immutablePlanHash: overrides.immutablePlanHash ?? fixture.receipt.immutablePlanHash, taskId: overrides.taskId ?? fixture.receipt.taskId,
    intentHash: overrides.intentHash ?? fixture.receipt.intentHash
  });
}

test('verifier accepts exact 64 KiB input payload plus its committed terminal newline', t => {
  const fixture = makeReceiptFixture({ largeRequirements: true });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = verifyFixture(fixture);
  assert.equal(result.valid, true);
  assert.equal(result.filesVerified, 4);
  assert.equal(result.prerequisitesVerified, 2);
  assert.equal(fs.statSync(path.join(fixture.directory, 'inputs/requirements.json')).size, INPUT_LIMIT + 1);
});

test('rejects checksum-valid receipt replay that substitutes allowlisted implementation bytes', t => {
  const fixture = makeReceiptFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  assert.equal(verifyFixture(fixture).valid, true);
  const implementationPath = path.join(fixture.directory, 'src/validator.mjs');
  fs.appendFileSync(implementationPath, '\n// forged implementation extension\n');
  const rewrittenReceipt = fixture.persistReceiptFromObservedFileBytes();
  assert.throws(() => verifyFixture(fixture, rewrittenReceipt), /AGG_SANDBOX_IMPLEMENTATION_BYTES_MISMATCH/,
    'a matching receipt checksum and matching self-declared file digest cannot redefine the allowlisted executable bytes');
});

test('rejects oversized input bytes even when file inventory and receipt digests are recomputed', t => {
  const fixture = makeReceiptFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const inputPath = path.join(fixture.directory, 'inputs/requirements.json');
  fs.writeFileSync(inputPath, `${JSON.stringify(objectWithExactSerializedLength(INPUT_LIMIT + 1))}\n`, { mode: 0o600 });
  const rewrittenReceipt = fixture.persistReceiptFromObservedFileBytes();
  assert.throws(() => verifyFixture(fixture, rewrittenReceipt), /AGG_SANDBOX_OUTPUT_SIZE_MISMATCH/,
    'the verifier must enforce the input byte ceiling independently of receipt-provided hashes');
});

test('rejects semantically equivalent but noncanonical prerequisite JSON even with recomputed hashes', t => {
  const fixture = makeReceiptFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const inputPath = path.join(fixture.directory, 'inputs/requirements.json');
  const content = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  fs.writeFileSync(inputPath, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
  const rewrittenReceipt = fixture.persistReceiptFromObservedFileBytes();
  assert.throws(() => verifyFixture(fixture, rewrittenReceipt), /AGG_SANDBOX_PREREQUISITE_CONTENT_INVALID/,
    'checksums cannot substitute a different byte encoding for the committed input payload');
});


test('rejects receipt replay across job/candidate/plan/intent bindings', t => {
  const fixture = makeReceiptFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  for (const overrides of [
    { jobId: 'job-other' }, { candidateHash: 'f'.repeat(64) },
    { immutablePlanHash: 'a'.repeat(64) }, { intentHash: 'b'.repeat(64) }
  ]) {
    assert.throws(() => verifyFixture(fixture, fixture.persisted, overrides), /AGG_SANDBOX_RECEIPT_BINDING_MISMATCH/,
      `must reject receipt identity override ${Object.keys(overrides).join(',')}`);
  }
});

test('rejects empty prerequisite provenance even when receipt JSON and checksum are valid', t => {
  const fixture = makeReceiptFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fixture.receipt.prerequisites[0].artifactId = '';
  const rewrittenReceipt = fixture.persistReceiptFromObservedFileBytes();
  assert.throws(() => verifyFixture(fixture, rewrittenReceipt), /AGG_SANDBOX_RECEIPT_INVALID/);
});

test('rejects receipt pathname replacement during descriptor read', t => {
  const fixture = makeReceiptFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const displaced = `${fixture.receiptPath}.displaced`;
  const outsideCopy = path.join(fixture.root, 'receipt-outside-copy.json');
  fs.writeFileSync(outsideCopy, fs.readFileSync(fixture.receiptPath), { mode: 0o600, flag: 'wx' });
  const originalReadSync = fs.readSync;
  let replaced = false;
  fs.readSync = function replacePathAfterDescriptorOpen(...args) {
    if (!replaced) {
      replaced = true;
      fs.renameSync(fixture.receiptPath, displaced);
      fs.symlinkSync(outsideCopy, fixture.receiptPath);
    }
    return originalReadSync.apply(this, args);
  };
  try {
    assert.throws(() => verifyFixture(fixture), /AGG_SANDBOX_PATH_CHANGED_DURING_READ/);
  } finally {
    fs.readSync = originalReadSync;
    fs.rmSync(fixture.receiptPath, { force: true });
    if (fs.existsSync(displaced)) fs.renameSync(displaced, fixture.receiptPath);
    fs.rmSync(outsideCopy, { force: true });
  }
  assert.equal(replaced, true, 'the test must mutate the path only after verifier descriptor open');
  assert.deepEqual(fs.readFileSync(fixture.receiptPath), fixture.persisted.bytes, 'exact original receipt bytes must be restored');
});

test('rejects noncanonical timestamp and negative elapsed time', t => {
  const fixture = makeReceiptFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fixture.receipt.startedAt = '2026-10-23';
  let rewrittenReceipt = fixture.persistReceiptFromObservedFileBytes();
  assert.throws(() => verifyFixture(fixture, rewrittenReceipt), /AGG_SANDBOX_RECEIPT_BINDING_MISMATCH/);
  fixture.receipt.startedAt = '2026-10-23T00:00:00.000Z';
  fixture.receipt.execution.elapsedMs = -1;
  rewrittenReceipt = fixture.persistReceiptFromObservedFileBytes();
  assert.throws(() => verifyFixture(fixture, rewrittenReceipt), /AGG_SANDBOX_RECEIPT_BINDING_MISMATCH/);
});
