import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { collectAdaptiveGoalEvidenceReferences, resolveAdaptiveGoalSourceEvidence } from '../src/runtime/adaptive-goal-source-evidence.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-source-evidence-'));
fs.mkdirSync(path.join(root, 'src/runtime'), { recursive: true });
fs.writeFileSync(path.join(root, 'src/runtime/example.js'), 'export const source = true;\n');
const digest = createHash('sha256').update(fs.readFileSync(path.join(root, 'src/runtime/example.js'))).digest('hex');
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('validates content-addressed source bytes while keeping claims unverified', () => {
    const [result] = resolveAdaptiveGoalSourceEvidence([`file:src/runtime/example.js#sha256=${digest}`], { root });
    assert.equal(result.classification, 'source_bytes_verified_claim_unverified');
    assert.equal(result.integrityVerified, true);
    assert.equal(result.claimVerified, false);
    assert.equal(result.independenceVerified, false);
});
test('distinguishes hash mismatch, placeholder refs and unpinned refs', () => {
    const results = resolveAdaptiveGoalSourceEvidence([
      'placeholder:collect-log', 'file:src/runtime/example.js#sha256=' + '0'.repeat(64), 'file:src/runtime/example.js'
    ], { root });
  const byReference = new Map(results.map(item => [item.reference, item.classification]));
  assert.equal(byReference.get('placeholder:collect-log'), 'placeholder_not_evidence');
  assert.equal(byReference.get('file:src/runtime/example.js#sha256=' + '0'.repeat(64)), 'source_hash_mismatch');
  assert.equal(byReference.get('file:src/runtime/example.js'), 'not_content_addressed');
});

test('rejects duplicate references and references outside the graph schema length bound', () => {
  const reference = `file:src/runtime/example.js#sha256=${digest}`;
  assert.throws(() => resolveAdaptiveGoalSourceEvidence([reference, reference], { root }), /must not contain duplicates/);
  assert.throws(() => resolveAdaptiveGoalSourceEvidence([`placeholder:${'x'.repeat(512)}`], { root }), /up to 512 characters/);
});

test('evidence-reference collection rejects malformed step fields instead of silently dropping them', () => {
  assert.throws(() => collectAdaptiveGoalEvidenceReferences({ steps: [{ supportingEvidenceRefs: ['artifact://valid'] }, { supportingEvidenceRefs: null }] }),
    error => error.code === 'EVIDENCE_REFERENCE_INVALID');
  assert.throws(() => collectAdaptiveGoalEvidenceReferences({ steps: [{ supportingEvidenceRefs: ['x'.repeat(513)] }] }),
    error => error.code === 'EVIDENCE_REFERENCE_INVALID');
  assert.throws(() => collectAdaptiveGoalEvidenceReferences({ steps: [{ supportingEvidenceRefs: Array(513).fill('artifact://x') }] }),
    error => error.code === 'EVIDENCE_REFERENCE_LIMIT_EXCEEDED');
  assert.throws(() => collectAdaptiveGoalEvidenceReferences({ steps: [] }), error => error.code === 'SOURCE_DRAFT_INVALID');
  assert.deepEqual(collectAdaptiveGoalEvidenceReferences({ steps: [{ supportingEvidenceRefs: ['artifact://a'] }, { supportingEvidenceRefs: [] }] }), ['artifact://a']);
});
test('rejects traversal, absolute paths and symlink sources without reading through them', () => {
    const outside = path.join(root, 'outside.js');
    fs.writeFileSync(outside, 'secret');
    fs.symlinkSync(outside, path.join(root, 'src/runtime/link.js'));
    const results = resolveAdaptiveGoalSourceEvidence([
      'file:../outside.js#sha256=' + createHash('sha256').update('secret').digest('hex'),
      'file:/etc/passwd#sha256=' + 'a'.repeat(64),
      'file:src/runtime/link.js#sha256=' + createHash('sha256').update('secret').digest('hex')
    ], { root });
    assert.ok(results.every(item => !item.integrityVerified && item.classification === 'source_unavailable_or_out_of_scope'));
});

test('fails closed when an opened source path is replaced by a symlink before the read completes', () => {
  const sourcePath = path.join(root, 'src/runtime/example.js');
  const displacedPath = path.join(root, 'src/runtime/example.js.displaced-symlink-test');
  const outsidePath = path.join(root, 'outside-replacement.js');
  const originalBytes = fs.readFileSync(sourcePath);
  const replacementBytes = Buffer.from('export const replacementOutsideRoot = true;\n');
  fs.writeFileSync(outsidePath, replacementBytes);
  const replacementHash = createHash('sha256').update(replacementBytes).digest('hex');
  const originalReadSync = fs.readSync;
  let replaced = false;
  let result;

  fs.readSync = function replaceWithSymlinkAfterOpen(...args) {
    if (!replaced) {
      replaced = true;
      fs.renameSync(sourcePath, displacedPath);
      fs.symlinkSync(outsidePath, sourcePath);
    }
    return originalReadSync.apply(this, args);
  };
  try {
    result = resolveAdaptiveGoalSourceEvidence([`file:src/runtime/example.js#sha256=${replacementHash}`], { root })[0];
  } finally {
    fs.readSync = originalReadSync;
    fs.rmSync(sourcePath, { force: true });
    if (fs.existsSync(displacedPath)) fs.renameSync(displacedPath, sourcePath);
    fs.rmSync(outsidePath, { force: true });
  }

  assert.equal(replaced, true, 'test must replace the path after the resolver opened the original descriptor');
  assert.equal(result.classification, 'source_changed_during_read');
  assert.equal(result.integrityVerified, false, 'bytes from an opened descriptor must not validate a different symlink now occupying the path');
  assert.equal(result.claimVerified, false);
  assert.equal(result.independenceVerified, false);
  assert.deepEqual(fs.readFileSync(sourcePath), originalBytes, 'race fixture must restore original bytes');
});

test('bounds source byte reads and never promotes oversized source files', () => {
  const oversized = path.join(root, 'src/runtime/oversized.js');
  fs.writeFileSync(oversized, Buffer.alloc(1024 * 1024 + 1, 0x61));
  const result = resolveAdaptiveGoalSourceEvidence([
    `file:src/runtime/oversized.js#sha256=${'a'.repeat(64)}`
  ], { root })[0];
  assert.equal(result.classification, 'source_size_limit_exceeded');
  assert.equal(result.integrityVerified, false);
  assert.equal(result.claimVerified, false);
  assert.equal(result.independenceVerified, false);
  assert.equal(result.maxBytes, 1024 * 1024);
});

test('rejects a source path replaced after descriptor open and before bytes are read', () => {
  const sourcePath = path.join(root, 'src/runtime/example.js');
  const displacedPath = path.join(root, 'src/runtime/example.js.displaced-test-source');
  const originalBytes = fs.readFileSync(sourcePath);
  const originalReadSync = fs.readSync;
  const replacementBytes = Buffer.from('export const replacement = true;\n');
  let replaced = false;
  let result;

  fs.readSync = function guardedReadSync(...args) {
    if (!replaced) {
      replaced = true;
      fs.renameSync(sourcePath, displacedPath);
      fs.writeFileSync(sourcePath, replacementBytes, { flag: 'wx' });
    }
    return originalReadSync.apply(this, args);
  };
  try {
    result = resolveAdaptiveGoalSourceEvidence([`file:src/runtime/example.js#sha256=${digest}`], { root })[0];
  } finally {
    fs.readSync = originalReadSync;
    fs.rmSync(sourcePath, { force: true });
    if (fs.existsSync(displacedPath)) fs.renameSync(displacedPath, sourcePath);
  }

  assert.equal(replaced, true, 'test must replace the path only after the resolver has opened its source descriptor');
  assert.equal(result.classification, 'source_changed_during_read');
  assert.equal(result.integrityVerified, false);
  assert.equal(result.claimVerified, false);
  assert.equal(result.independenceVerified, false);
  assert.deepEqual(fs.readFileSync(sourcePath), originalBytes, 'test must restore the source bytes after the race simulation');
});
