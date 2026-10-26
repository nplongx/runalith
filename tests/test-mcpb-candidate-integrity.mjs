import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidateTester = path.join(root, 'scripts/test-mcpb-candidate.mjs');
fs.mkdirSync(path.join(root, '.test-tmp'), { recursive: true });
const tempDir = fs.mkdtempSync(path.join(root, '.test-tmp', 'mcpb-candidate-integrity-'));

function run(args) {
  return spawnSync(process.execPath, [candidateTester, ...args], {
    cwd: root, encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024
  });
}

function zipFrom(directory, target, names) {
  const result = spawnSync('zip', ['-q', target, ...names], {
    cwd: directory, encoding: 'utf8', timeout: 10_000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return target;
}

test('candidate tester rejects an archive missing packaged server entrypoint before runtime launch', () => {
  const sourceDir = path.join(tempDir, 'missing-entry-source');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'manifest.json'), JSON.stringify({ name: 'fixture-only-invalid-candidate' }));
  fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({ type: 'module' }));
  const archive = zipFrom(sourceDir, path.join(tempDir, 'missing-server-entry.mcpb'), ['manifest.json', 'package.json']);
  const result = run([archive]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MCPB is missing server\/index\.js/);
  assert.doesNotMatch(result.stdout + result.stderr, /MCPB_FAST_TEST=PASS/);
});

test('candidate tester rejects truncated/non-ZIP archive and does not create runtime state', () => {
  const archive = path.join(tempDir, 'truncated-candidate.mcpb');
  fs.writeFileSync(archive, Buffer.from('PK\x03\x04deliberately-incomplete-zip-fixture'));
  const result = run([archive]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MCPB_FAST_TEST=FAIL/);
  assert.doesNotMatch(result.stdout + result.stderr, /MCPB_FAST_TEST=PASS/);
});

test('candidate tester refuses symlink bundles instead of dereferencing them', () => {
  const target = path.join(tempDir, 'not-an-mcpb.bin');
  const link = path.join(tempDir, 'symlink-candidate.mcpb');
  fs.writeFileSync(target, 'not a candidate');
  fs.symlinkSync(target, link);
  const result = run([link]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /candidate must be a regular file, not a symlink/);
});

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
