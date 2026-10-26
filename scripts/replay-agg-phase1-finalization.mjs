#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyMcpbSourceAlignment } from './verify-mcpb-source-alignment.mjs';
import { verifyAggPhase1EvidencePack } from './verify-agg-phase1-evidence-pack.mjs';
import { parseStrictJson } from '../src/runtime/strict-json.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_HEAD_EXPECTED = 'ff15b21934e5fd4920eea4b0816f6dc35d7f328a';
const HISTORICAL_CANDIDATE_PATH = 'artifacts/agg-phase1-hardening-20261023T134921Z-end-to-end/runalith-1.0.9-rc.5-agg-phase1-hardened.mcpb';
const HISTORICAL_CANDIDATE_SHA256 = '7fb5f547eda71a717d10358510e1ea7baee46f5f9bcea3efc2891c6293bd3bc0';
// These owner-maintained protocol documents are locally excluded by
// .git/info/exclude rather than tracked. Preserve them explicitly in the
// reproducible overlay; never broaden this into a copy of all ignored files.
const REQUIRED_IGNORED_SOURCE_FILES = Object.freeze([
  'docs/plugin-workflow-benchmark-phase1-freeze.md',
  'docs/plugin-workflow-benchmark-preflight-evidence.md'
]);
let ACTIVE_SOURCE_BINDING = null;

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function fail(message) { const error = new Error(message); error.code = 'AGG_PHASE1_REPLAY_INVALID'; throw error; }

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--help' || key === '-h') return { help: true };
    if (!['--output-dir', '--base-head', '--preserve-existing-candidate'].includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--') || result[key]) {
      fail(`invalid or duplicate argument: ${key}`);
    }
    result[key] = argv[++i];
  }
  if (!result['--output-dir']) fail('Usage: node scripts/replay-agg-phase1-finalization.mjs --output-dir NEW_DIRECTORY [--base-head GIT_COMMIT] [--preserve-existing-candidate PATH]');
  result.baseHead = result['--base-head'] || BASE_HEAD_EXPECTED;
  return result;
}

function listUntrackedSourceFiles() {
  // This repository intentionally carries thousands of untracked historical
  // evidence/source files. The default 1 MiB spawnSync buffer can overflow
  // after the tests finish, turning a valid inventory into a false replay
  // failure. Bound it explicitly above the observed full inventory size.
  const output = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: ROOT, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024
  });
  if (output.status !== 0) fail(`git untracked-source inventory failed: ${String(output.stderr)}`);
  return output.stdout.toString('utf8').split('\0').filter(Boolean)
    .filter(relative => relative !== 'artifacts' && !relative.startsWith('artifacts/'))
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

function readStableSourceFile(relative, maxBytes = 128 * 1024 * 1024) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) ||
      relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) {
    fail(`source snapshot path is not a normalized repository-relative path: ${String(relative)}`);
  }
  const full = path.join(ROOT, relative);
  const parts = relative.split(path.sep);
  let current = ROOT;
  let pathBefore;
  try {
    for (const [index, segment] of parts.entries()) {
      current = path.join(current, segment);
      const st = fs.lstatSync(current, { bigint: true });
      if (st.isSymbolicLink() || (index === parts.length - 1 ? !st.isFile() : !st.isDirectory()) || fs.realpathSync(current) !== current) {
        fail(`source snapshot path is missing, non-regular, symlinked or non-canonical: ${relative}`);
      }
      if (index === parts.length - 1) pathBefore = st;
    }
  } catch (cause) {
    if (cause?.code === 'AGG_PHASE1_REPLAY_INVALID') throw cause;
    fail(`source snapshot path cannot be inspected: ${relative}: ${String(cause?.message || cause)}`);
  }
  let fd;
  try {
    fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino || before.size > BigInt(maxBytes)) {
      fail(`source snapshot path identity or size changed before reading: ${relative}`);
    }
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > maxBytes) fail(`source snapshot file exceeds size limit: ${relative}`);
      chunks.push(chunk.subarray(0, count));
    }
    const bytes = Buffer.concat(chunks, total);
    const after = fs.fstatSync(fd, { bigint: true });
    const pathAfter = fs.lstatSync(full, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || bytes.byteLength !== Number(after.size) ||
        pathAfter.isSymbolicLink() || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino ||
        pathAfter.size !== before.size || pathAfter.mtimeNs !== before.mtimeNs || pathAfter.ctimeNs !== before.ctimeNs ||
        fs.realpathSync(full) !== full) fail(`source snapshot file changed during descriptor read: ${relative}`);
    return { bytes, sizeBytes: bytes.byteLength, mode: Number(before.mode & 0o777n), sha256: sha256(bytes) };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function gitBytes(args, maxBuffer, label) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'buffer', maxBuffer });
  if (result.status !== 0) fail(`${label} failed: ${String(result.stderr || '')}`);
  return result.stdout;
}

function assertSourceSnapshotUnchanged(snapshot) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  if (head.status !== 0 || head.stdout.trim() !== snapshot.baseGitHead) fail('Git HEAD changed while the Phase 1 replay was running');
  const patch = gitBytes(['diff', '--binary', 'HEAD'], 128 * 1024 * 1024, 'tracked working-tree recheck');
  if (sha256(patch) !== snapshot.trackedPatchSha256) fail('tracked working-tree patch changed after source snapshot capture');
  const untracked = listUntrackedSourceFiles();
  const capturedUntracked = snapshot.sourceOverlayEntries.map(item => item.path)
    .filter(relative => !REQUIRED_IGNORED_SOURCE_FILES.includes(relative));
  if (untracked.length !== capturedUntracked.length || untracked.some((relative, index) => relative !== capturedUntracked[index])) {
    fail('untracked source path inventory changed after source snapshot capture (outside historical artifacts/)');
  }
  for (const row of snapshot.sourceOverlayEntries) {
    const current = readStableSourceFile(row.path);
    if (current.sha256 !== row.sha256 || current.sizeBytes !== row.sizeBytes || current.mode !== row.mode) {
      fail(`source file changed after the replay snapshot was captured: ${row.path}`);
    }
  }
}

function createSourceSnapshot(outDir, baseHead) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  if (head.status !== 0) fail(`cannot read Git HEAD: ${head.stderr}`);
  const gitHead = head.stdout.trim();
  if (gitHead !== baseHead) fail(`repository HEAD changed: expected ${baseHead}, found ${gitHead}`);
  const patchBytes = gitBytes(['diff', '--binary', 'HEAD'], 128 * 1024 * 1024, 'tracked patch capture');
  const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (status.status !== 0) fail(`cannot capture full Git status: ${status.stderr}`);
  const normalStatus = spawnSync('git', ['status', '--short', '--untracked-files=normal'], { cwd: ROOT, encoding: 'utf8' });
  if (normalStatus.status !== 0) fail(`cannot capture normal Git status: ${normalStatus.stderr}`);
  const untracked = listUntrackedSourceFiles();
  const overlayFiles = [...new Set([...untracked, ...REQUIRED_IGNORED_SOURCE_FILES])]
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  // Capture Git/source inventory before creating any evidence output. The
  // later output directory lives under artifacts/ and is excluded from the
  // source overlay so it cannot self-contaminate the source snapshot.
  const snapshotDir = path.join(outDir, 'source-snapshot');
  fs.mkdirSync(snapshotDir, { mode: 0o700 });
  const stagingDir = path.join(snapshotDir, '.source-overlay-staging');
  fs.mkdirSync(stagingDir, { mode: 0o700 });
  const sourceOverlayEntries = [];
  for (const relative of overlayFiles) {
    const captured = readStableSourceFile(relative);
    const stagedPath = path.join(stagingDir, relative);
    fs.mkdirSync(path.dirname(stagedPath), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(stagedPath, 'wx', 0o600);
    try { fs.writeFileSync(fd, captured.bytes); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.chmodSync(stagedPath, captured.mode);
    sourceOverlayEntries.push({ path: relative, sizeBytes: captured.sizeBytes, sha256: captured.sha256, mode: captured.mode });
  }
  const patchPath = path.join(snapshotDir, 'tracked-working-tree.patch');
  fs.writeFileSync(patchPath, patchBytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(snapshotDir, 'git-status-all-at-snapshot.txt'), status.stdout, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(snapshotDir, 'git-status-normal-at-snapshot.txt'), normalStatus.stdout, { flag: 'wx', mode: 0o600 });
  const listPath = path.join(snapshotDir, 'untracked-source-files.nul');
  fs.writeFileSync(listPath, Buffer.concat(overlayFiles.map(relative => Buffer.from(`${relative}\0`))), { flag: 'wx', mode: 0o600 });
  const overlayPath = path.join(snapshotDir, 'untracked-source-overlay.tar.gz');
  const overlay = spawnSync('tar', [
    '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
    '--pax-option=delete=atime,delete=ctime', '--null', '-czf', overlayPath, '-C', stagingDir, '-T', listPath
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (overlay.status !== 0) fail(`cannot create deterministic source overlay: ${overlay.stderr}`);
  fs.unlinkSync(listPath);
  const overlayBytes = fs.readFileSync(overlayPath);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  const patchRecheck = gitBytes(['diff', '--binary', 'HEAD'], 128 * 1024 * 1024, 'tracked patch stability recheck');
  const headRecheck = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  if (sha256(patchRecheck) !== sha256(patchBytes) || headRecheck.status !== 0 || headRecheck.stdout.trim() !== gitHead) {
    fail('Git HEAD or tracked patch changed while the source snapshot was being assembled');
  }
  for (const row of sourceOverlayEntries) {
    const current = readStableSourceFile(row.path);
    if (current.sha256 !== row.sha256 || current.sizeBytes !== row.sizeBytes || current.mode !== row.mode) {
      fail(`source overlay member changed while the snapshot archive was assembled: ${row.path}`);
    }
  }
  const untrackedRecheck = listUntrackedSourceFiles();
  if (untracked.length !== untrackedRecheck.length || untracked.some((relative, index) => relative !== untrackedRecheck[index])) {
    fail('untracked source inventory changed while the snapshot overlay was assembled');
  }
  const snapshotSha256 = sha256(Buffer.concat([
    Buffer.from(`${gitHead}\0${sha256(patchBytes)}\0${sha256(overlayBytes)}\0`, 'utf8')
  ]));
  const metadata = {
    schemaVersion: 2,
    baseGitHead: gitHead,
    trackedPatchSha256: sha256(patchBytes),
    trackedPatchBytes: patchBytes.byteLength,
    untrackedSourceFileCount: untracked.length,
    sourceOverlayFileCount: overlayFiles.length,
    sourceOverlayEntries,
    ignoredButRetainedSourceFiles: REQUIRED_IGNORED_SOURCE_FILES.map(relative => ({
      path: relative, sha256: sourceOverlayEntries.find(item => item.path === relative).sha256
    })),
    untrackedSourceOverlaySha256: sha256(overlayBytes),
    untrackedSourceOverlayBytes: overlayBytes.byteLength,
    sourceSnapshotSha256: snapshotSha256,
    historicalArtifactsCopied: false,
    createdFromDirtyWorkingTree: status.stdout.trim().length > 0
  };
  const metadataPath = path.join(snapshotDir, 'snapshot-metadata.json');
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const snapshotArchive = path.join(outDir, 'agg-phase1-source-snapshot.tar.gz');
  const packed = spawnSync('tar', [
    '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
    '--pax-option=delete=atime,delete=ctime', '-czf', snapshotArchive,
    '-C', snapshotDir, 'tracked-working-tree.patch', 'untracked-source-overlay.tar.gz',
    'snapshot-metadata.json', 'git-status-all-at-snapshot.txt', 'git-status-normal-at-snapshot.txt'
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (packed.status !== 0) fail(`cannot package source snapshot: ${packed.stderr}`);
  const result = {
    ...metadata,
    snapshotArchivePath: path.basename(snapshotArchive),
    snapshotArchiveSha256: sha256(fs.readFileSync(snapshotArchive)),
    statusNormalPath: 'source-snapshot/git-status-normal-at-snapshot.txt',
    statusAllPath: 'source-snapshot/git-status-all-at-snapshot.txt'
  };
  assertSourceSnapshotUnchanged(result);
  return result;
}

function runCommand(outDir, commands, name, command, args, envOverrides = {}) {
  const logsDir = path.join(outDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, `${name}.log`);
  const startedAt = new Date().toISOString();
  const start = process.hrtime.bigint();
  const child = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'buffer',
    env: { ...process.env, ...envOverrides },
    maxBuffer: 256 * 1024 * 1024,
  });
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
  const stdout = child.stdout || Buffer.alloc(0);
  const stderr = child.stderr || Buffer.alloc(0);
  const stableEnvOverrides = Object.fromEntries(Object.entries(envOverrides).sort(([a], [b]) => a.localeCompare(b, 'en')));
  const argvSha256 = sha256(Buffer.from(JSON.stringify([command, ...args]), 'utf8'));
  if (!ACTIVE_SOURCE_BINDING) fail('source snapshot binding must be established before any replay command is executed');
  const stdoutPath = path.join(logsDir, `${name}.stdout.bin`);
  const stderrPath = path.join(logsDir, `${name}.stderr.bin`);
  fs.writeFileSync(stdoutPath, stdout, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(stderrPath, stderr, { flag: 'wx', mode: 0o600 });
  const endedAt = new Date().toISOString();
  const log = Buffer.concat([
    Buffer.from(`COMMAND: ${command} ${args.join(' ')}\nCWD: ${ROOT}\nARGV_JSON: ${JSON.stringify([command, ...args])}\nENV_OVERRIDES_JSON: ${JSON.stringify(stableEnvOverrides)}\nARGV_SHA256: ${argvSha256}\nSOURCE_BINDING_JSON: ${JSON.stringify(ACTIVE_SOURCE_BINDING)}\nSTARTED_AT: ${startedAt}\nENDED_AT: ${endedAt}\nEXIT_CODE: ${child.status ?? 'null'}\nSIGNAL: ${child.signal || 'none'}\nERROR: ${child.error?.message || 'none'}\nDURATION_MS: ${durationMs.toFixed(3)}\n--- STDOUT ---\n`),
    stdout, Buffer.from('\n--- STDERR ---\n'), stderr, Buffer.from('\n')
  ]);
  fs.writeFileSync(logPath, log, { flag: 'wx', mode: 0o600 });
  const record = {
    name,
    command,
    args,
    cwd: ROOT,
    envOverrides: stableEnvOverrides,
    argvSha256,
    sourceBinding: { ...ACTIVE_SOURCE_BINDING },
    startedAt,
    endedAt,
    durationMs: Number(durationMs.toFixed(3)),
    exitCode: child.status,
    signal: child.signal || null,
    spawnError: child.error ? String(child.error.message || child.error) : null,
    logPath: path.relative(outDir, logPath).split(path.sep).join('/'),
    stdoutPath: path.relative(outDir, stdoutPath).split(path.sep).join('/'),
    stderrPath: path.relative(outDir, stderrPath).split(path.sep).join('/'),
    logSha256: sha256(log),
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
  };
  commands.push(record);
  return { ...record, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
}

function recordSkippedCommand(outDir, commands, name, reason) {
  const logsDir = path.join(outDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  if (!ACTIVE_SOURCE_BINDING) fail('source snapshot binding must be established before a skipped command is recorded');
  const startedAt = new Date().toISOString();
  const endedAt = startedAt;
  const command = 'NOT_RUN';
  const args = [];
  const envOverrides = {};
  const stdout = Buffer.from(`SKIPPED_REASON: ${reason}\n`, 'utf8');
  const stderr = Buffer.alloc(0);
  const argvSha256 = sha256(Buffer.from(JSON.stringify([command]), 'utf8'));
  const stdoutPath = path.join(logsDir, `${name}.stdout.bin`);
  const stderrPath = path.join(logsDir, `${name}.stderr.bin`);
  const logPath = path.join(logsDir, `${name}.log`);
  fs.writeFileSync(stdoutPath, stdout, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(stderrPath, stderr, { flag: 'wx', mode: 0o600 });
  const log = Buffer.concat([
    Buffer.from(`COMMAND: ${command} ${args.join(' ')}\nCWD: ${ROOT}\nARGV_JSON: ${JSON.stringify([command])}\nENV_OVERRIDES_JSON: {}\nARGV_SHA256: ${argvSha256}\nSOURCE_BINDING_JSON: ${JSON.stringify(ACTIVE_SOURCE_BINDING)}\nSTARTED_AT: ${startedAt}\nENDED_AT: ${endedAt}\nEXIT_CODE: null\nSIGNAL: none\nERROR: none\nDURATION_MS: 0.000\n--- STDOUT ---\n`),
    stdout, Buffer.from('\n--- STDERR ---\n'), stderr, Buffer.from('\n')
  ]);
  fs.writeFileSync(logPath, log, { flag: 'wx', mode: 0o600 });
  const record = {
    name, command, args, cwd: ROOT, envOverrides, argvSha256, sourceBinding: { ...ACTIVE_SOURCE_BINDING },
    startedAt, endedAt, durationMs: 0, exitCode: null, signal: null, spawnError: null,
    executionStatus: 'SKIPPED', skipReason: reason,
    logPath: path.relative(outDir, logPath).split(path.sep).join('/'),
    stdoutPath: path.relative(outDir, stdoutPath).split(path.sep).join('/'),
    stderrPath: path.relative(outDir, stderrPath).split(path.sep).join('/'),
    logSha256: sha256(log), stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr)
  };
  commands.push(record);
  return record;
}

function requireSuccess(result) {
  if (result.exitCode !== 0) fail(`${result.name} failed (exit=${result.exitCode}, signal=${result.signal || 'none'}); see ${result.logPath}`);
}
function readJson(filePath, label) {
  try { return parseStrictJson(fs.readFileSync(filePath), label); }
  catch (cause) { fail(`${label} is missing or not duplicate-free strict JSON: ${String(cause?.message || cause)}`); }
}
function hashFile(filePath) { return sha256(fs.readFileSync(filePath)); }

function collectEvidenceFiles(outDir) {
  const records = [];
  const walk = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (prefix === '' && ['evidence-pack-manifest.json', 'evidence-pack-verification.json', 'SHA256SUMS.txt'].includes(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) fail(`symlink inside evidence pack: ${relative}`);
      if (st.isDirectory()) walk(full, relative);
      else if (st.isFile()) {
        const bytes = fs.readFileSync(full);
        records.push({ path: relative, sizeBytes: bytes.byteLength, sha256: sha256(bytes) });
      } else fail(`special file inside evidence pack: ${relative}`);
    }
  };
  walk(outDir);
  return records.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function writeChecksumList(outDir) {
  const paths = [];
  const walk = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relative === 'SHA256SUMS.txt') continue;
      const full = path.join(directory, entry.name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) fail(`symlink inside evidence pack: ${relative}`);
      if (st.isDirectory()) walk(full, relative);
      else if (st.isFile()) paths.push({ path: relative, sha256: hashFile(full) });
      else fail(`special file inside evidence pack: ${relative}`);
    }
  };
  walk(outDir);
  const bytes = Buffer.from(paths.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(item => `${item.sha256}  ${item.path}`).join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), bytes, { flag: 'wx', mode: 0o600 });
  return { entries: paths.length, sha256: sha256(bytes) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: node scripts/replay-agg-phase1-finalization.mjs --output-dir NEW_DIRECTORY [--base-head GIT_COMMIT]\n');
    return;
  }
  const outputDir = path.resolve(args['--output-dir']);
  if (outputDir === ROOT || !outputDir.startsWith(`${ROOT}${path.sep}`) || outputDir.startsWith(`${path.join(ROOT, 'dist')}${path.sep}`)) {
    fail('output directory must be a new directory inside the repository and outside dist/');
  }
  const parent = path.dirname(outputDir);
  if (!fs.statSync(parent).isDirectory() || fs.realpathSync(parent) !== parent || fs.lstatSync(parent).isSymbolicLink()) {
    fail('output parent must already exist and be a canonical non-symlink directory');
  }
  if (fs.lstatSync(outputDir, { throwIfNoEntry: false })) fail('output directory already exists; refusing to overwrite existing evidence');
  fs.mkdirSync(outputDir, { mode: 0o700 });
  const replayCommand = ['npm', 'run', 'agg:phase1:replay', '--', '--output-dir', args['--output-dir'],
    ...(args['--preserve-existing-candidate'] ? ['--preserve-existing-candidate', path.resolve(args['--preserve-existing-candidate'])] : [])];
  const commands = [];
  const snapshot = createSourceSnapshot(outputDir, args.baseHead);
  ACTIVE_SOURCE_BINDING = {
    baseGitHead: snapshot.baseGitHead,
    sourceSnapshotSha256: snapshot.sourceSnapshotSha256,
    trackedPatchSha256: snapshot.trackedPatchSha256,
    untrackedSourceOverlaySha256: snapshot.untrackedSourceOverlaySha256
  };
  const toolchain = {};
  for (const [name, command, commandArgs] of [
    ['node', process.execPath, ['--version']], ['npm', 'npm', ['--version']], ['git', 'git', ['--version']],
    ['zip', 'zip', ['-v']], ['unzip', 'unzip', ['-v']], ['tar', 'tar', ['--version']], ['platform', 'uname', ['-srmo']]
  ]) {
    const result = runCommand(outputDir, commands, `tool-${name}`, command, commandArgs);
    requireSuccess(result);
    toolchain[name] = result.stdout.trim().split(/\r?\n/).slice(0, 3).join('\n');
  }

  const focused = fs.readdirSync(path.join(ROOT, 'tests'))
    .filter(name => /^test-adaptive-goal-.*\.(?:js|mjs)$/.test(name))
    .map(name => path.join('tests', name))
    .concat([
      'tests/test-mcpb-source-alignment.mjs',
      'tests/test-mcpb-agg-search-integration.mjs',
      'tests/test-mcpb-candidate-integrity.mjs',
      'tests/test-agg-phase1-evidence-pack-verifier.mjs',
      'tests/test-agg-phase1-phase2-package-boundary.mjs',
      'tests/test-phase1-acceptance-protocol-freeze.mjs',
      'tests/test-phase1-execution-provenance-contract.mjs',
      'tests/test-phase1-latest-target-compatibility.mjs',
      'tests/test-phase2-inventory-diagnostic-contract.mjs',
      'tests/test-plugin-workflow-benchmark-phase1-protocol.mjs'
    ]);
  const focusedResult = runCommand(outputDir, commands, 'focused-agg-phase1-tests', process.execPath, ['--test', ...[...new Set(focused)]]);
  requireSuccess(focusedResult);
  const npmTest = runCommand(outputDir, commands, 'npm-test', 'npm', ['test']);
  requireSuccess(npmTest);
  const docs = runCommand(outputDir, commands, 'docs-check', 'npm', ['run', 'docs:check']);
  requireSuccess(docs);
  const diffCheck = runCommand(outputDir, commands, 'git-diff-check', 'git', ['diff', '--check']);
  requireSuccess(diffCheck);
  const preserveCandidateSource = args['--preserve-existing-candidate'] ? path.resolve(args['--preserve-existing-candidate']) : null;
  let reproducibility = null;
  if (preserveCandidateSource) {
    const relativeSource = path.relative(ROOT, preserveCandidateSource).split(path.sep).join('/');
    if (relativeSource !== HISTORICAL_CANDIDATE_PATH || !fs.existsSync(preserveCandidateSource) ||
        fs.lstatSync(preserveCandidateSource).isSymbolicLink() || fs.realpathSync(preserveCandidateSource) !== preserveCandidateSource ||
        hashFile(preserveCandidateSource) !== HISTORICAL_CANDIDATE_SHA256) {
      fail('preserve-existing-candidate requires the exact historical development candidate path and recorded SHA-256; no approval is transferred');
    }
    recordSkippedCommand(outputDir, commands, 'package-reproducibility',
      'MCPB packaged inputs are unchanged; avoid rebuilding solely for a benchmark-only scorer/test change');
  } else {
    reproducibility = runCommand(outputDir, commands, 'package-reproducibility', 'npm', ['run', 'test:package-reproducibility']);
    requireSuccess(reproducibility);
  }
  const noOverwrite = runCommand(outputDir, commands, 'package-no-overwrite', process.execPath, ['tests/test-package-no-overwrite.js']);
  requireSuccess(noOverwrite);

  const candidatePath = path.join(outputDir, 'runalith-1.0.9-rc.5-agg-phase1-hardened.mcpb');
  let candidateAcquisition = 'BUILT_FROM_CURRENT_PACKAGED_INPUTS';
  let build = null;
  let preservationProvenancePath = null;
  let preservationProvenance = null;
  if (preserveCandidateSource) {
    preservationProvenancePath = path.join(outputDir, 'source-binary-preservation-provenance.json');
    const preservationCheck = runCommand(outputDir, commands, 'candidate-preservation-check', process.execPath, [
      'scripts/verify-mcpb-source-alignment.mjs', '--source-root', ROOT, '--bundle', preserveCandidateSource,
      '--output', preservationProvenancePath
    ]);
    requireSuccess(preservationCheck);
    preservationProvenance = readJson(preservationProvenancePath, 'preserved candidate source/binary provenance');
    if (preservationProvenance.status !== 'PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT' ||
        preservationProvenance.bundleSha256 !== HISTORICAL_CANDIDATE_SHA256 ||
        hashFile(preserveCandidateSource) !== HISTORICAL_CANDIDATE_SHA256) {
      fail('historical candidate is not aligned to current packaged inputs; stop and investigate before any build or approval decision');
    }
    fs.copyFileSync(preserveCandidateSource, candidatePath, fs.constants.COPYFILE_EXCL);
    if (hashFile(candidatePath) !== HISTORICAL_CANDIDATE_SHA256) fail('preserved candidate copy differs from its independently verified source bytes');
    candidateAcquisition = 'PRESERVED_EXISTING_CANDIDATE_NO_PACKAGED_INPUT_CHANGES';
    recordSkippedCommand(outputDir, commands, 'mcpb-extracted-fast-smoke',
      'MCPB packaged inputs are unchanged and candidate bytes are preserved; extracted-package E2E is intentionally not rerun');
  } else {
    build = runCommand(outputDir, commands, 'mcpb-build-and-extracted-e2e', 'npm', ['run', 'pack:runalith-mcpb'], {
      PLUGIN_BUNDLE_OUT: candidatePath
    });
    requireSuccess(build);
    if (!fs.existsSync(candidatePath)) fail('candidate build returned success without publishing the new candidate');
  }
  const provenancePath = path.join(outputDir, 'source-binary-provenance.json');
  const alignment = runCommand(outputDir, commands, 'candidate-source-alignment', process.execPath, [
    'scripts/verify-mcpb-source-alignment.mjs', '--source-root', ROOT, '--bundle', candidatePath, '--output', provenancePath
  ]);
  requireSuccess(alignment);
  const provenance = readJson(provenancePath, 'candidate source-to-binary provenance');
  if (provenance.bundleSha256 !== hashFile(candidatePath)) fail('candidate bytes changed after source alignment verification');
  let smoke = null;
  if (!preserveCandidateSource) {
    smoke = runCommand(outputDir, commands, 'mcpb-extracted-fast-smoke', 'npm', ['run', 'test:mcpb-candidate', '--', candidatePath]);
    requireSuccess(smoke);
  }

  const rawPath = path.join(outputDir, 'phase1-algorithm-raw.json');
  const reportPath = path.join(outputDir, 'phase1-algorithm-report.md');
  const benchmark = runCommand(outputDir, commands, 'offline-agg-algorithm-benchmark', process.execPath, [
    'benchmarks/adaptive-goal-graph/run-phase1-benchmark.mjs', '--output', rawPath, '--report', reportPath
  ]);
  requireSuccess(benchmark);
  const benchmarkVerify = runCommand(outputDir, commands, 'offline-agg-ledger-integrity', process.execPath, [
    'benchmarks/adaptive-goal-graph/verify-phase1-ledger.mjs', '--raw', rawPath, '--manifest', `${rawPath}.manifest.json`
  ]);
  requireSuccess(benchmarkVerify);
  const verifyStart = benchmarkVerify.stdout.indexOf('{');
  if (verifyStart < 0) fail('offline benchmark verifier emitted no machine-readable integrity report');
  const benchmarkIntegrity = JSON.parse(benchmarkVerify.stdout.slice(verifyStart));

  const readinessPath = path.join(outputDir, 'official-readiness.json');
  const readiness = runCommand(outputDir, commands, 'official-readiness-fail-closed', process.execPath, [
    'benchmarks/plugin-workflow-benchmark/phase1-protocol-runner.mjs', 'readiness', '--output', readinessPath
  ]);
  requireSuccess(readiness);
  const readinessValue = readJson(readinessPath, 'official readiness result');
  if (readinessValue.sourceProtocol?.targetBinding?.executionGateOpen !== false ||
      readinessValue.sourceProtocol?.targetBinding?.releaseApproved !== false ||
      !String(readinessValue.decision).startsWith('BLOCKED_')) {
    fail('current official readiness no longer explicitly reports blocked execution and release; stop for human governance review');
  }

  const phase2BoundaryPath = path.join(outputDir, 'phase2-package-boundary.json');
  const phase2Diagnostic = runCommand(outputDir, commands, 'phase2-package-boundary-diagnostic', process.execPath, [
    'scripts/verify-agg-phase1-phase2-package-boundary.mjs', '--phase1-bundle', candidatePath, '--output', phase2BoundaryPath
  ]);
  requireSuccess(phase2Diagnostic);
  const phase2Boundary = readJson(phase2BoundaryPath, 'Phase 1 / Phase 2 package boundary diagnosis');
  if (phase2Boundary.status !== 'BLOCKED_PHASE2_FROZEN_COUNT_NOT_APPLICABLE_TO_CURRENT_PHASE1_PACKAGE' ||
      phase2Boundary.phase1?.archiveEntryCount !== provenance.archiveEntryCount ||
      phase2Boundary.phase1?.manifestToolCount !== provenance.manifestToolCount ||
      phase2Boundary.historicalPhase2Reference?.archiveEntryCount !== 71 ||
      phase2Boundary.historicalPhase2Reference?.manifestToolCount !== 59 ||
      phase2Boundary.phase2ContractChanged !== false || phase2Boundary.phase1ArchiveTrimmed !== false ||
      phase2Boundary.observedBoundaryMatchesFrozenHistoricalShape !== true) {
    fail('Phase 1 / Phase 2 package boundary differs from the verified frozen historical package shape; inspect the diagnostic and preserve both contracts');
  }

  assertSourceSnapshotUnchanged(snapshot);

  const candidateReport = {
    path: path.basename(candidatePath),
    sha256: provenance.bundleSha256,
    sizeBytes: provenance.bundleBytes,
    archiveEntryCount: provenance.archiveEntryCount,
    manifestToolCount: provenance.manifestToolCount,
    sourceSnapshotSha256: provenance.sourceSnapshotSha256,
    sourceServerSha256: provenance.sourceServerSha256,
    sourceManifestSha256: provenance.sourceManifestSha256,
    acquisition: candidateAcquisition,
    ...(preserveCandidateSource ? {
      preservedSourcePath: path.relative(ROOT, preserveCandidateSource).split(path.sep).join('/'),
      preservationProvenancePath: path.basename(preservationProvenancePath),
      preservationProvenanceSha256: hashFile(preservationProvenancePath)
    } : {}),
    status: 'SOURCE_ALIGNED_DEVELOPMENT_CANDIDATE_NOT_OFFICIALLY_ACCEPTED'
  };
  const candidateCommandBindings = preserveCandidateSource
    ? [['candidate-preservation-check', 'preserved'], ['candidate-source-alignment', 'verified'], ['phase2-package-boundary-diagnostic', 'compared']]
    : [['mcpb-build-and-extracted-e2e', 'produced'], ['candidate-source-alignment', 'verified'],
      ['mcpb-extracted-fast-smoke', 'consumed'], ['phase2-package-boundary-diagnostic', 'compared']];
  for (const [commandName, relation] of candidateCommandBindings) {
    const receipt = commands.find(item => item.name === commandName);
    if (!receipt) fail(`required candidate-bound command receipt is absent: ${commandName}`);
    receipt.candidateBinding = { path: path.resolve(candidatePath), sha256: candidateReport.sha256, relation };
  }
  const statusNormalText = fs.readFileSync(path.join(outputDir, snapshot.statusNormalPath), 'utf8');
  const statusAllText = fs.readFileSync(path.join(outputDir, snapshot.statusAllPath), 'utf8');
  const normalStatusRows = statusNormalText.split(/\r?\n/).filter(Boolean);
  const allStatusRows = statusAllText.split(/\r?\n/).filter(Boolean);
  const gitStatusAtSnapshot = {
    normalStatusEntries: normalStatusRows.length,
    trackedChangedEntries: normalStatusRows.filter(line => !line.startsWith('?? ')).length,
    untrackedPathEntries: normalStatusRows.filter(line => line.startsWith('?? ')).length,
    recursiveStatusEntries: allStatusRows.length,
    recursiveTrackedEntries: allStatusRows.filter(line => !line.startsWith('?? ')).length,
    recursiveUntrackedEntries: allStatusRows.filter(line => line.startsWith('?? ')).length,
  };
  const statusReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    replayCommand,
    disposition: 'DEVELOPMENT_CANDIDATE_VALIDATED_LOCALLY_NOT_OFFICIALLY_ACCEPTED',
    repository: {
      root: ROOT, baseGitHead: snapshot.baseGitHead, sourceSnapshotSha256: snapshot.sourceSnapshotSha256,
      trackedPatchSha256: snapshot.trackedPatchSha256, untrackedSourceOverlaySha256: snapshot.untrackedSourceOverlaySha256,
      trackedPatchBytes: snapshot.trackedPatchBytes, untrackedSourceFileCount: snapshot.untrackedSourceFileCount,
      sourceOverlayFileCount: snapshot.sourceOverlayFileCount,
      ignoredButRetainedSourceFiles: snapshot.ignoredButRetainedSourceFiles,
      gitStatusAtSnapshot,
      historicalArtifactsCopied: false
    },
    candidate: candidateReport,
    verification: {
      sourceToBinary: provenance.status,
      exactSourceEntryCount: provenance.exactSourceByteMatchCount,
      projectedMetadataEntryCount: provenance.projectedMetadataMatchCount,
      extractedPackageSmoke: preserveCandidateSource ? 'NOT_RUN_PACKAGED_INPUTS_UNCHANGED' : 'PASS',
      packageReproducibility: preserveCandidateSource ? 'NOT_RUN_PACKAGED_INPUTS_UNCHANGED' : 'PASS_TWO_INDEPENDENT_BIT_IDENTICAL_BUILDS',
      mcpbBuildPerformed: !preserveCandidateSource,
      extractedPackageE2ERun: !preserveCandidateSource,
      focusedTestsExitCode: focusedResult.exitCode,
      npmTestExitCode: npmTest.exitCode,
      docsCheckExitCode: docs.exitCode,
      gitDiffCheck: diffCheck.exitCode === 0 ? 'PASS' : 'FAIL',
      gitDiffCheckExitCode: diffCheck.exitCode,
      offlineAlgorithmBenchmarkIntegrity: benchmarkIntegrity.status,
      offlineAlgorithmBenchmarkCounts: benchmarkIntegrity.counts,
      phase2InventoryStatus: phase2Boundary.status,
      phase2CandidateEntries: phase2Boundary.phase1.archiveEntryCount,
      phase2FrozenRequiredEntries: phase2Boundary.frozenPhase2RequiredEntryCount,
      phase2HistoricalReferenceSha256: phase2Boundary.historicalPhase2Reference.sha256,
      phase2HistoricalReferenceToolCount: phase2Boundary.historicalPhase2Reference.manifestToolCount,
      phase2SameVersionStringButDifferentPackageContract: phase2Boundary.sameSemanticVersionString && phase2Boundary.packageContractsDiffer,
      phase2BoundaryShapeVerified: phase2Boundary.observedBoundaryMatchesFrozenHistoricalShape
    },
    sourceSnapshotReconstruction: { status: 'PENDING', candidateSourceSnapshotSha256: provenance.sourceSnapshotSha256,
      repositorySourceSnapshotSha256: snapshot.sourceSnapshotSha256 },
    phase2PackageBoundaryReportPath: path.basename(phase2BoundaryPath),
    readiness: {
      reportPath: path.basename(readinessPath),
      decision: readinessValue.decision,
      executionGateOpen: false,
      releaseApproved: false,
      configuredTargetSha256: readinessValue.sourceProtocol?.targetBinding?.candidateBundleSha256 || null,
      newCandidateMatchesConfiguredTarget: candidateReport.sha256 === readinessValue.sourceProtocol?.targetBinding?.candidateBundleSha256,
      configuredTargetSourceAlignment: readinessValue.sourceProtocol?.targetBinding?.sourceAlignmentStatus || 'UNKNOWN',
      acceptanceGates: readinessValue.acceptanceGates,
      blockers: readinessValue.blockers
    },
    toolchain,
    commands: commands.map(({ stdout, stderr, ...rest }) => rest),
    safetyBoundaries: [
      'No operational A/B scenarios were started by this script.',
      'No approvals, signatures, trust anchors, corpus records, isolation attestations or measured production results were generated.',
      'Offline synthetic algorithm trials are integrity evidence only, not operational acceptance.',
      'Plan Graph remains shadow/review-only; no candidate is promoted to verified or production authorized.'
    ]
  };
  const statusPath = path.join(outputDir, 'candidate-final-status.json');
  fs.writeFileSync(statusPath, `${JSON.stringify(statusReport, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const rawManifestPath = `${rawPath}.manifest.json`;
  const artifactFiles = collectEvidenceFiles(outputDir);
  const manifest = {
    schemaVersion: 2,
    replayCommand,
    status: 'INTEGRITY_VERIFIED_NOT_ACCEPTANCE',
    disposition: statusReport.disposition,
    generatedAt: new Date().toISOString(),
    sourceSnapshot: snapshot,
    candidate: candidateReport,
    provenance: { path: path.basename(provenancePath), sha256: hashFile(provenancePath) },
    readiness: { reportPath: path.basename(readinessPath), decision: readinessValue.decision, executionGateOpen: false, releaseApproved: false },
    offlineBenchmark: { rawPath: path.basename(rawPath), rawSha256: hashFile(rawPath), rawManifestPath: path.basename(rawManifestPath),
      rawManifestSha256: hashFile(rawManifestPath), reportPath: path.basename(reportPath), reportSha256: hashFile(reportPath), integrityStatus: benchmarkIntegrity.status },
    phase2Boundary: { ...phase2Boundary, reportPath: path.basename(phase2BoundaryPath) },
    toolchain,
    commandResults: commands.map(({ stdout, stderr, ...rest }) => rest),
    files: artifactFiles,
    sourceSnapshotReconstruction: {
      commandRequired: 'Create a clean clone at baseGitHead; apply source-snapshot/tracked-working-tree.patch; extract source-snapshot/untracked-source-overlay.tar.gz; run verify:mcpb-source-alignment against the candidate; compare sourceSnapshotSha256.',
      status: 'PENDING_SEPARATE_RECONSTRUCTION_CHECK'
    },
    acceptance: {
      claim: 'NOT_ACCEPTED',
      requiredExternalEvidence: ['protected trust roots', 'fresh current-target owner re-freeze/approval', 'independent current-target review',
        'signed frozen ten-scenario corpus', 'fresh exact-scope operational authorization', 'paired actual plugin_enabled/basic_tools runs',
        'signed independent evaluator adjudication', 'current-run isolation/network-deny/resource-quota attestation']
    }
  };
  const manifestPath = path.join(outputDir, 'evidence-pack-manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const checksums = writeChecksumList(outputDir);

  // Reconstruct the source snapshot in a temporary clone and compare the exact
  // verifier digest before accepting this evidence pack's integrity status.
  const reconstructionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-phase1-source-reconstruct-'));
  try {
    fs.rmSync(reconstructionDir, { recursive: true, force: true });
    const clone = spawnSync('git', ['clone', '--quiet', '--shared', ROOT, reconstructionDir], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (clone.status !== 0) fail(`clean reconstruction clone failed: ${clone.stderr}`);
    const checkout = spawnSync('git', ['checkout', '--quiet', '--detach', snapshot.baseGitHead], { cwd: reconstructionDir, encoding: 'utf8' });
    if (checkout.status !== 0) fail(`clean reconstruction checkout failed: ${checkout.stderr}`);
    const apply = spawnSync('git', ['apply', path.join(outputDir, 'source-snapshot/tracked-working-tree.patch')], { cwd: reconstructionDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (apply.status !== 0) fail(`tracked patch reconstruction failed: ${apply.stderr}`);
    const extract = spawnSync('tar', ['-xzf', path.join(outputDir, 'source-snapshot/untracked-source-overlay.tar.gz'), '-C', reconstructionDir], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (extract.status !== 0) fail(`untracked source overlay reconstruction failed: ${extract.stderr}`);
    const reconstructed = verifyMcpbSourceAlignment({ sourceRoot: reconstructionDir, bundlePath: candidatePath });
    for (const field of ['bundleSha256', 'sourceSnapshotSha256', 'archiveEntryCount', 'exactSourceByteMatchCount',
      'projectedMetadataMatchCount', 'manifestToolCount', 'sourceServerSha256', 'sourceManifestSha256']) {
      if (reconstructed[field] !== provenance[field]) fail(`source reconstruction differs at ${field}`);
    }
    manifest.sourceSnapshotReconstruction = {
      status: 'PASS',
      baseGitHead: snapshot.baseGitHead,
      sourceSnapshotSha256: snapshot.sourceSnapshotSha256,
      candidateSourceSnapshotSha256: reconstructed.sourceSnapshotSha256,
      candidateSha256: reconstructed.bundleSha256,
      comparedFields: ['bundleSha256', 'sourceSnapshotSha256', 'archiveEntryCount', 'exactSourceByteMatchCount',
        'projectedMetadataMatchCount', 'manifestToolCount', 'sourceServerSha256', 'sourceManifestSha256']
    };
  } finally { fs.rmSync(reconstructionDir, { recursive: true, force: true }); }

  statusReport.sourceSnapshotReconstruction = {
    status: 'PASS',
    baseGitHead: snapshot.baseGitHead,
    candidateSha256: provenance.bundleSha256,
    repositorySourceSnapshotSha256: snapshot.sourceSnapshotSha256,
    candidateSourceSnapshotSha256: provenance.sourceSnapshotSha256,
    comparedFields: ['bundleSha256', 'sourceSnapshotSha256', 'archiveEntryCount', 'exactSourceByteMatchCount',
      'projectedMetadataMatchCount', 'manifestToolCount', 'sourceServerSha256', 'sourceManifestSha256']
  };
  statusReport.releaseChecklistPath = 'release-checklist.md';
  fs.writeFileSync(statusPath, `${JSON.stringify(statusReport, null, 2)}\n`, { flag: 'w', mode: 0o600 });

  const checklistLines = [
    '# AGG Phase 1 hardening — release checklist', '',
    '**Disposition:** `DEVELOPMENT_CANDIDATE_VALIDATED_LOCALLY_NOT_OFFICIALLY_ACCEPTED`.', '',
    '## Candidate and source identities', '',
    `- Candidate: \`${candidateReport.path}\`.`,
    `- MCPB SHA-256: \`${candidateReport.sha256}\`; bytes: ${candidateReport.sizeBytes}; ZIP entries: ${candidateReport.archiveEntryCount}; manifest/runtime tools: ${candidateReport.manifestToolCount}/67.`,
    `- Candidate package-source digest: \`${candidateReport.sourceSnapshotSha256}\`.`,
    `- Repository working-tree snapshot digest: \`${snapshot.sourceSnapshotSha256}\`.`,
    `- Packaged server SHA-256: \`${candidateReport.sourceServerSha256}\`; manifest SHA-256: \`${candidateReport.sourceManifestSha256}\`.`,
    `- Alignment: ${provenance.exactSourceByteMatchCount} exact source entries + ${provenance.projectedMetadataMatchCount} documented package metadata projection; status \`${provenance.status}\`.`,
    `- Git base HEAD: \`${snapshot.baseGitHead}\`; tracked patch SHA-256: \`${snapshot.trackedPatchSha256}\`; untracked source overlay SHA-256: \`${snapshot.untrackedSourceOverlaySha256}\`.`,
    `- Git status at snapshot: ${gitStatusAtSnapshot.trackedChangedEntries} tracked entries changed, ${gitStatusAtSnapshot.untrackedPathEntries} untracked paths at normal depth, ${gitStatusAtSnapshot.recursiveUntrackedEntries} recursive untracked entries. Historical \`artifacts/\` contents were not copied or deleted.`, '',
    '## Verified local gates', '',
    `- Focused AGG/Phase 1 regression suite: PASS (exit ${focusedResult.exitCode}).`,
    `- \`npm test\`: PASS (exit ${npmTest.exitCode}).`,
    `- \`npm run docs:check\`: PASS (exit ${docs.exitCode}).`,
    `- \`git diff --check\`: PASS (exit ${diffCheck.exitCode}).`,
    `- Reproducible package builds: ${preserveCandidateSource ? 'NOT RUN — packaged inputs unchanged; avoiding unnecessary rebuilds.' : `PASS; two independent builds bit-identical (exit ${reproducibility.exitCode}).`}`,
    `- Package no-overwrite controls: PASS (exit ${noOverwrite.exitCode}).`,
    `- Candidate acquisition: ${candidateAcquisition}. ${preserveCandidateSource ? `Preserved exact historical bytes from \`${candidateReport.preservedSourcePath}\`; no MCPB build or extracted-package E2E was run because packaged inputs were unchanged.` : `MCPB build + extracted-package E2E: PASS (exit ${build.exitCode}); extracted candidate smoke: PASS (exit ${smoke.exitCode}).`}`,
    `- Clean-clone reconstruction: PASS; candidate/source fields match: ${manifest.sourceSnapshotReconstruction.comparedFields.join(', ')}.`,
    `- Offline graph benchmark: ${benchmarkIntegrity.status}; ${benchmarkIntegrity.counts.taskTemplates} synthetic templates, ${benchmarkIntegrity.counts.taskFamilyClusters} synthetic families, ${benchmarkIntegrity.counts.taskGraphInstances} graph instances, ${benchmarkIntegrity.counts.records} trials. These are integrity-only synthetic results, not production acceptance.`, '',
    '## Readiness and uncompleted acceptance gates', '',
    `- Official readiness: \`${readinessValue.decision}\`; execution gate closed; release approval false.`,
    `- Frozen readiness target SHA-256: \`${readinessValue.sourceProtocol?.targetBinding?.candidateBundleSha256 || 'unavailable'}\`; current development candidate match: ${candidateReport.sha256 === readinessValue.sourceProtocol?.targetBinding?.candidateBundleSha256}.`,
    `- Protected trust anchors: ${readinessValue.trustAnchorConfiguration?.status || 'UNKNOWN'} at \`${readinessValue.trustAnchorConfiguration?.path || 'unknown path'}\`.`,
    ...(readinessValue.blockers || []).map(blocker => `- BLOCKED: ${blocker}`),
    '- Required external evidence remains: protected distinct owner/reviewer/evaluator/isolation-auditor trust roots; current-target re-freeze/owner approval and independent review; signed ten-scenario corpus; fresh exact-scope operational authorization; actual paired `plugin_enabled`/`basic_tools` runs; independent signed adjudication; exact-run OS/container, network-deny and quota attestations.',
    '- No operational A/B was run. No trust root, signature, approval, corpus, measured production result or isolation attestation was created. No plan auto-execution or production authorization occurred.', '',
    '## Adjacent Phase 2 package boundary', '',
    `- Current Phase 1 bundle: ${phase2Boundary.phase1.archiveEntryCount} archive entries and ${phase2Boundary.phase1.manifestToolCount} tools; frozen Phase 2 boundary: ${phase2Boundary.frozenPhase2RequiredEntryCount} entries.`,
    `- Historical Phase 2-shaped reference: SHA-256 \`${phase2Boundary.historicalPhase2Reference.sha256}\`, version \`${phase2Boundary.historicalPhase2Reference.version}\`, ${phase2Boundary.historicalPhase2Reference.archiveEntryCount} entries and ${phase2Boundary.historicalPhase2Reference.manifestToolCount} tools. This reference is historical and not approval/current-source verification.`,
    `- Both manifests say \`${phase2Boundary.phase1.version}\`, but package contracts differ: ${phase2Boundary.pathDelta.phase1Only.length} archive paths and ${phase2Boundary.toolDelta.phase1Only.length} tools added in the Phase 1 candidate. The exact paths and tool names are in \`${path.basename(phase2BoundaryPath)}\`.`,
    '- Frozen Phase 2 contract remains unchanged; archive was not trimmed, and historical `dist/` candidates were not replaced. Do not feed the 76-entry Phase 1 candidate into the exact 71-entry Phase 2 inventory gate. A shared release/version claim requires an owner-approved versioned package/contract boundary and fresh target-bound approvals.', '',
    '## Reproduce and verify', '',
    `- Full command ledger and per-command exit/log hashes are in \`logs/\`; evidence manifest is \`evidence-pack-manifest.json\`; complete SHA-256 list is \`SHA256SUMS.txt\`.`,
    `- Exact replay command: \`${replayCommand.join(' ')}\`.`,
    '- Verify the resulting pack from source root: `npm run agg:phase1:verify-evidence -- --evidence-dir "$PWD/artifacts/agg-phase1-hardening-NEW" --source-root "$PWD"`.',
    '- Integrity verification is not independent acceptance. Keep `PARTIAL_NOT_ACCEPTED` until every trusted operational evidence and approval gate passes.', ''
  ];
  fs.writeFileSync(path.join(outputDir, 'release-checklist.md'), checklistLines.join('\n'), { flag: 'wx', mode: 0o600 });

  manifest.releaseChecklistPath = 'release-checklist.md';
  manifest.sourceSnapshotReconstruction.status = 'PASS';
  manifest.verificationReportPath = 'evidence-pack-verification.json';
  manifest.files = collectEvidenceFiles(outputDir);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'w', mode: 0o600 });
  fs.unlinkSync(path.join(outputDir, 'SHA256SUMS.txt'));
  writeChecksumList(outputDir);

  const preflightCheck = verifyAggPhase1EvidencePack({ evidenceDir: outputDir, sourceRoot: ROOT, allowMissingVerificationReport: true });
  if (preflightCheck.status !== 'PASS_INTEGRITY_ONLY_NOT_ACCEPTANCE') fail('evidence-pack preflight failed');
  const verificationReportPath = path.join(outputDir, manifest.verificationReportPath);
  const verificationReport = {
    schemaVersion: 1,
    status: 'PASS_INTEGRITY_ONLY_NOT_ACCEPTANCE',
    verifiedAt: new Date().toISOString(),
    manifestSha256: hashFile(manifestPath),
    candidateSha256: candidateReport.sha256,
    sourceSnapshotSha256: provenance.sourceSnapshotSha256,
    repositorySourceSnapshotSha256: snapshot.sourceSnapshotSha256,
    readinessDecision: readinessValue.decision,
    checksumVerificationStatus: 'PASS',
    checksumVerificationExitCode: 0,
    cleanCloneReconstructionStatus: 'PASS',
    evidencePackPreflightStatus: preflightCheck.status,
    evidenceFilesVerified: preflightCheck.evidenceFilesVerified,
    acceptanceClaimed: false,
    releaseApproved: false
  };
  fs.writeFileSync(verificationReportPath, `${JSON.stringify(verificationReport, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  let finalChecksums;
  let checksumCheck;
  let packCheck;
  for (let pass = 0; pass < 2; pass += 1) {
    fs.unlinkSync(path.join(outputDir, 'SHA256SUMS.txt'));
    finalChecksums = writeChecksumList(outputDir);
    checksumCheck = spawnSync('sha256sum', ['-c', 'SHA256SUMS.txt'], { cwd: outputDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (checksumCheck.status !== 0) fail(`independent sha256sum verification failed: ${checksumCheck.stderr}`);
    packCheck = verifyAggPhase1EvidencePack({ evidenceDir: outputDir, sourceRoot: ROOT });
    if (packCheck.status !== 'PASS_INTEGRITY_ONLY_NOT_ACCEPTANCE') fail('independent evidence-pack integrity verification did not pass');
    if (pass === 0) {
      statusReport.verification.evidencePackVerification = packCheck.status;
      statusReport.verification.evidencePackVerifierExitCode = 0;
      statusReport.verification.checksumVerification = 'PASS';
      statusReport.verification.checksumVerificationExitCode = 0;
      fs.writeFileSync(statusPath, `${JSON.stringify(statusReport, null, 2)}\n`, { flag: 'w', mode: 0o600 });
      manifest.files = collectEvidenceFiles(outputDir);
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'w', mode: 0o600 });
      verificationReport.manifestSha256 = hashFile(manifestPath);
      verificationReport.evidencePackVerifierStatus = packCheck.status;
      verificationReport.evidencePackVerifierExitCode = 0;
      fs.writeFileSync(verificationReportPath, `${JSON.stringify(verificationReport, null, 2)}\n`, { flag: 'w', mode: 0o600 });
    }
  }
  process.stdout.write(`${JSON.stringify({
    disposition: statusReport.disposition,
    candidateAcquisition,
    candidateSha256: candidateReport.sha256,
    sourceSnapshotSha256: snapshot.sourceSnapshotSha256,
    candidateSourceDigest: provenance.sourceSnapshotSha256,
    readiness: readinessValue.decision,
    executionGateOpen: false,
    releaseApproved: false,
    benchmarkIntegrity: benchmarkIntegrity.status,
    reproducibility: preserveCandidateSource ? 'NOT_RUN_PACKAGED_INPUTS_UNCHANGED' : 'PASS_TWO_INDEPENDENT_BIT_IDENTICAL_BUILDS',
    mcpbBuildPerformed: !preserveCandidateSource,
    extractedPackageE2ERun: !preserveCandidateSource,
    gitDiffCheck: diffCheck.exitCode === 0 ? 'PASS' : 'FAIL',
    sourceSnapshotReconstruction: manifest.sourceSnapshotReconstruction.status,
    phase2Boundary: manifest.phase2Boundary.status,
    checksumsVerified: checksumCheck.status === 0,
    evidencePackVerification: packCheck.status,
    evidencePackFilesVerified: packCheck.evidenceFilesVerified,
    checksumEntriesVerified: packCheck.checksumEntriesVerified,
    evidencePackPath: outputDir,
    checksumsSha256: finalChecksums.sha256
  }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (cause) {
    process.stderr.write(`${cause.code || 'AGG_PHASE1_REPLAY_FAILED'}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 2;
  }
}
