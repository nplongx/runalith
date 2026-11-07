import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';
import {
  lstatWithin, openDirectoryWithin, readFileWithin, readlinkWithin, replaceFileWithin, resolveWithinRoot,
  writeFileAtDirectory, writeFileWithin
} from '../src/runtime/secure-filesystem.js';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

const root = tempDir('secure-filesystem-boundary-');
const outside = path.join(root, '..', `secure-filesystem-outside-${process.pid}-${Date.now()}`);
fs.mkdirSync(outside, { mode: 0o700 });
try {
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside bytes\n', { flag: 'wx', mode: 0o600 });
  fs.mkdirSync(path.join(root, 'nested'), { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'nested', 'input.txt'), 'trusted bytes\n', { flag: 'wx', mode: 0o600 });
  assert.equal(readFileWithin(root, 'nested/input.txt').toString(), 'trusted bytes\n');
  assert.equal(lstatWithin(root, 'nested/input.txt').isFile(), true);
  assert.throws(() => resolveWithinRoot(root, '../escape', 'fixture'), /inside the canonical workspace root/);

  const outputDirectory = openDirectoryWithin(root, 'nested', { create: false });
  try {
    writeFileAtDirectory(outputDirectory.fd, 'new-evidence.txt', 'immutable first bytes\n');
    assert.throws(() => writeFileAtDirectory(outputDirectory.fd, 'new-evidence.txt', 'replacement bytes\n'), error => error?.code === 'EEXIST');
    assert.equal(fs.readFileSync(path.join(root, 'nested', 'new-evidence.txt'), 'utf8'), 'immutable first bytes\n');
  } finally { outputDirectory.close(); }

  fs.symlinkSync(outside, path.join(root, 'escape-dir'), 'dir');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape-file'));
  assert.throws(() => openDirectoryWithin(root, 'escape-dir'), /secure directory open refused/,
    'a symlinked parent must not redirect directory access outside the workspace');
  assert.throws(() => readFileWithin(root, 'escape-dir/secret.txt'), /secure directory open refused/,
    'a nested path must not traverse a symlinked directory');
  assert.throws(() => readFileWithin(root, 'escape-file'), /ELOOP|too many levels|secure filesystem input/,
    'a final symlink must not be followed for file reads');
  assert.equal(readlinkWithin(root, 'escape-file'), path.join(outside, 'secret.txt'));
  assert.throws(() => writeFileWithin(root, 'escape-dir/created.txt', 'must not escape\n', { createParents: true }),
    /secure directory open refused/);
  assert.equal(fs.existsSync(path.join(outside, 'created.txt')), false, 'a symlink alias must not create files outside the root');

  fs.mkdirSync(path.join(root, 'new-parent'), { mode: 0o700 });
  writeFileWithin(root, 'new-parent/final.txt', 'durable\n');
  assert.equal(fs.readFileSync(path.join(root, 'new-parent', 'final.txt'), 'utf8'), 'durable\n');

  // Simulate a directory fsync/readback failure after rename has already
  // replaced the target. The helper must tell the caller a mutation may have
  // happened; treating the thrown error as "not modified" is unsafe.
  const mutationPath = path.join(root, 'nested', 'mutation-after-rename.txt');
  const beforeBytes = Buffer.from('before bytes\n');
  const afterBytes = Buffer.from('after bytes\n');
  fs.writeFileSync(mutationPath, beforeBytes, { flag: 'wx', mode: 0o600 });
  const originalRenameSync = fs.renameSync;
  try {
    fs.renameSync = (...args) => {
      originalRenameSync(...args);
      throw Object.assign(new Error('injected fsync-like failure after rename'), { code: 'EIO' });
    };
    assert.throws(() => replaceFileWithin(root, 'nested/mutation-after-rename.txt', afterBytes, {
      expectedSha256: sha256(beforeBytes)
    }), error => error?.workspaceMutationAttempted === true && /injected fsync-like failure/.test(error.message));
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.deepEqual(fs.readFileSync(mutationPath), afterBytes,
    'injected post-rename error must leave the test target changed while reporting possible mutation');

  const rejectedBasePath = path.join(root, 'nested', 'precondition-still-no-mutation.txt');
  fs.writeFileSync(rejectedBasePath, beforeBytes, { flag: 'wx', mode: 0o600 });
  assert.throws(() => replaceFileWithin(root, 'nested/precondition-still-no-mutation.txt', afterBytes, {
    expectedSha256: sha256(Buffer.from('different base'))
  }), error => error?.code === 'WORKSPACE_WRITE_BASE_HASH_MISMATCH' && error.workspaceMutationAttempted !== true);
  assert.deepEqual(fs.readFileSync(rejectedBasePath), beforeBytes,
    'precondition failures before rename/link must remain known no-mutation outcomes');
  console.log('SECURE FILESYSTEM: descriptor-anchored traversal, no-follow reads, exclusive durable writes, and symlink escape rejection PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}
