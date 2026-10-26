import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditPhase1Ledger } from '../benchmarks/adaptive-goal-graph/phase1-ledger-integrity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(root, 'benchmarks/adaptive-goal-graph/run-phase1-benchmark.mjs');
const verifierCli = path.join(root, 'benchmarks/adaptive-goal-graph/verify-phase1-ledger.mjs');
let tempDir;
let rawPath;
let reportPath;
let manifestPath;
let rawBytes;
let raw;
let manifest;

before(() => {
  fs.mkdirSync(path.join(root, '.test-tmp'), { recursive: true });
  tempDir = fs.mkdtempSync(path.join(root, '.test-tmp', 'agg-ledger-integrity-'));
  rawPath = path.join(tempDir, 'raw.json');
  reportPath = path.join(tempDir, 'report.md');
  manifestPath = `${rawPath}.manifest.json`;
  const generated = spawnSync(process.execPath, [runner, '--output', rawPath, '--report', reportPath], {
    cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 96 * 1024 * 1024
  });
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  rawBytes = fs.readFileSync(rawPath);
  raw = JSON.parse(rawBytes.toString('utf8'));
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
});

after(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function auditMutation(mutator, options = {}) {
  const corrupted = structuredClone(raw);
  mutator(corrupted);
  return auditPhase1Ledger(corrupted, {
    rawBytes: Buffer.from(`${JSON.stringify(corrupted)}\n`),
    rawPath,
    sourceRoot: root,
    ...options
  });
}

test('fresh schema-v5 ledger passes independent content, oracle, pairing and manifest verification', () => {
  const result = auditPhase1Ledger(raw, {
    rawBytes, rawPath, manifest, manifestPath, sourceRoot: root, requireManifest: true
  });
  assert.equal(result.status, 'PASS_INTEGRITY_ONLY_NOT_ACCEPTANCE', JSON.stringify(result.errors, null, 2));
  assert.equal(result.sourceVersionStatus, 'CURRENT_SOURCE_HASHES_MATCH');
  assert.equal(result.counts.taskTemplates, 28);
  assert.equal(result.counts.taskFamilyClusters, 7);
  assert.equal(result.counts.taskGraphInstances, 140);
  assert.equal(result.counts.records, 700);
  assert.deepEqual(Object.values(result.counts.methodRecords), [140, 140, 140, 140, 140]);
  assert.equal(result.warnings.length, 0);
});

test('missing trial is rejected and is not silently dropped from denominators', () => {
  const result = auditMutation(ledger => { ledger.records.pop(); });
  assert.equal(result.status, 'FAIL');
  assert.ok(result.errors.some(message => message.includes('raw record count mismatch')));
  assert.ok(result.errors.some(message => message.includes('missing paired method record')));
});

test('duplicate trial identity is rejected', () => {
  const result = auditMutation(ledger => { ledger.records.push(structuredClone(ledger.records[0])); });
  assert.equal(result.status, 'FAIL');
  assert.ok(result.errors.some(message => message.includes('duplicate trial identity')));
});

test('graph hash mismatch and missing task graph data are rejected', () => {
  const mismatchedHash = auditMutation(ledger => { ledger.records[0].inputGraphSha256 = '0'.repeat(64); });
  assert.equal(mismatchedHash.status, 'FAIL');
  assert.ok(mismatchedHash.errors.some(message => message.includes('input graph SHA-256 mismatch')));

  const missingGraph = auditMutation(ledger => { ledger.taskInstances.pop(); });
  assert.equal(missingGraph.status, 'FAIL');
  assert.ok(missingGraph.errors.some(message => message.includes('graph-instance count mismatch')));
  assert.ok(missingGraph.errors.some(message => message.includes('record has no matching task instance')));
});

test('invalid or self-contradicting oracle output is rejected', () => {
  const result = auditMutation(ledger => { ledger.taskInstances[0].oracle.validPathCount = 0; });
  assert.equal(result.status, 'FAIL');
  assert.ok(result.errors.some(message => message.includes('embedded oracle summary does not match recomputation')));
});

test('retry count beyond the declared zero-retry policy is rejected', () => {
  const result = auditMutation(ledger => { ledger.records[0].retryCount = 1; });
  assert.equal(result.status, 'FAIL');
  assert.ok(result.errors.some(message => message.includes('attempt/retry budget invariant violated')));
});

test('inconsistent outcomes and summaries are rejected', () => {
  const result = auditMutation(ledger => {
    const pairedRow = ledger.records.find(row => row.methodKey === 'agg-beam:2');
    pairedRow.taskOutcomeCorrect = !pairedRow.taskOutcomeCorrect;
    ledger.summaries.find(row => row.variant === 'agg-beam:2').taskOutcomeAccuracy = 1;
  });
  assert.equal(result.status, 'FAIL');
  assert.ok(result.errors.some(message => message.includes('taskOutcomeCorrect inconsistent')));
  assert.ok(result.errors.some(message => message.includes('summary success rate does not match raw rows')));
  assert.ok(result.errors.some(message => message.includes('paired statistics invalid')));
});

test('tampered manifest hashes and incomplete manifest are rejected', () => {
  const tampered = structuredClone(manifest);
  tampered.outputs.raw.sha256 = 'f'.repeat(64);
  const withTamperedManifest = auditPhase1Ledger(raw, {
    rawBytes, rawPath, manifest: tampered, manifestPath, sourceRoot: root, requireManifest: true
  });
  assert.equal(withTamperedManifest.status, 'FAIL');
  assert.ok(withTamperedManifest.errors.some(message => message.includes('manifest: raw SHA-256 mismatch')));

  const missingOutput = structuredClone(manifest);
  delete missingOutput.outputs.raw;
  const withIncompleteManifest = auditPhase1Ledger(raw, {
    rawBytes, rawPath, manifest: missingOutput, manifestPath, sourceRoot: root, requireManifest: true
  });
  assert.equal(withIncompleteManifest.status, 'FAIL');
  assert.ok(withIncompleteManifest.errors.some(message => message.includes('manifest: raw output entry is missing')));
});

test('CLI rejects duplicate JSON members before interpreting a benchmark ledger or sidecar', () => {
  const duplicateRawPath = path.join(tempDir, 'duplicate-json-raw.json');
  const duplicateRaw = rawBytes.toString('utf8').replace('"schemaVersion": 5,', '"schemaVersion": 5,\n  "schemaVersion": 5,');
  assert.notEqual(duplicateRaw, rawBytes.toString('utf8'), 'fixture must alter one top-level JSON member name without changing ledger semantics');
  fs.writeFileSync(duplicateRawPath, duplicateRaw, { flag: 'wx', mode: 0o600 });
  const result = spawnSync(process.execPath, [verifierCli, '--raw', duplicateRawPath], {
    cwd: root, encoding: 'utf8', timeout: 10_000
  });
  assert.notEqual(result.status, 0, 'CLI must reject ambiguous raw JSON before audit/scoring');
  assert.match(result.stderr, /duplicate decoded object key "schemaVersion"/);
});
