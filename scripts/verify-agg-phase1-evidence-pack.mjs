#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyMcpbSourceAlignment } from './verify-mcpb-source-alignment.mjs';
import { parseStrictJson } from '../src/runtime/strict-json.js';

function fail(message) {
  const error = new Error(message);
  error.code = 'AGG_PHASE1_EVIDENCE_PACK_INVALID';
  throw error;
}
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function safeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\') &&
    !/^[a-zA-Z]:/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..') &&
    !/[\u0000-\u001f\u007f]/.test(value);
}
function readRegular(root, relative, label, maxBytes = 256 * 1024 * 1024) {
  if (!safeRelativePath(relative)) fail(`${label} has an unsafe relative path: ${String(relative)}`);
  let current = root;
  const pieces = relative.split('/');
  for (const [index, piece] of pieces.entries()) {
    current = path.join(current, piece);
    const st = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink() || (index < pieces.length - 1 ? !st.isDirectory() : !st.isFile()) ||
        fs.realpathSync(current) !== current) {
      fail(`${label} path contains a missing, symlinked or noncanonical component: ${relative}`);
    }
  }
  let fd;
  try {
    fd = fs.openSync(current, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd, { bigint: true });
    const pathBefore = fs.lstatSync(current, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || pathBefore.dev !== before.dev || pathBefore.ino !== before.ino ||
        before.size > BigInt(maxBytes)) fail(`${label} identity or size changed before descriptor read: ${relative}`);
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) fail(`${label} exceeds the size limit: ${relative}`);
      chunks.push(chunk.subarray(0, count));
    }
    const bytes = Buffer.concat(chunks, total);
    const after = fs.fstatSync(fd, { bigint: true });
    const pathAfter = fs.lstatSync(current, { bigint: true });
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || bytes.byteLength !== Number(after.size) ||
        pathAfter.isSymbolicLink() || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino ||
        pathAfter.size !== before.size || pathAfter.mtimeNs !== before.mtimeNs || pathAfter.ctimeNs !== before.ctimeNs ||
        fs.realpathSync(current) !== current) fail(`${label} changed during descriptor read: ${relative}`);
    return bytes;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function inventoryEvidenceTreeOnce(rootPath) {
  const root = path.resolve(rootPath);
  if (fs.realpathSync(root) !== root) fail('evidence root changed to a noncanonical path');
  const entries = [];
  const visit = (fullPath, relativePath) => {
    const st = fs.lstatSync(fullPath, { bigint: true });
    if (st.isSymbolicLink() || fs.realpathSync(fullPath) !== fullPath) {
      fail(`symlink or path substitution inside evidence pack: ${relativePath || '.'}`);
    }
    if (!st.isDirectory() && !st.isFile()) fail(`special file inside evidence pack: ${relativePath || '.'}`);
    entries.push({
      path: relativePath || '.', type: st.isDirectory() ? 'directory' : 'file',
      device: st.dev.toString(), inode: st.ino.toString(), sizeBytes: st.size.toString(),
      mode: st.mode.toString(), uid: st.uid.toString(), gid: st.gid.toString(),
      mtimeNs: st.mtimeNs.toString(), ctimeNs: st.ctimeNs.toString()
    });
    if (st.isDirectory()) {
      const children = fs.readdirSync(fullPath, { withFileTypes: true })
        .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
      for (const child of children) visit(path.join(fullPath, child.name), relativePath ? `${relativePath}/${child.name}` : child.name);
    }
  };
  visit(root, '');
  return entries;
}

// Exported for negative tests and used by the verifier at both decision
// boundaries. Hash equality alone is insufficient: an attacker could replace
// a file or parent directory with same-byte content between reads.
export function captureAggPhase1EvidenceTreeIdentity(rootPath) {
  const first = inventoryEvidenceTreeOnce(rootPath);
  const second = inventoryEvidenceTreeOnce(rootPath);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    fail('evidence inventory identity changed while its snapshot was being captured');
  }
  return first;
}

const REQUIRED_REPLAY_COMMANDS = Object.freeze([
  'tool-node', 'tool-npm', 'tool-git', 'tool-zip', 'tool-unzip', 'tool-tar', 'tool-platform',
  'focused-agg-phase1-tests', 'npm-test', 'docs-check', 'git-diff-check', 'package-reproducibility',
  'package-no-overwrite', 'mcpb-build-and-extracted-e2e', 'candidate-source-alignment', 'mcpb-extracted-fast-smoke',
  'offline-agg-algorithm-benchmark', 'offline-agg-ledger-integrity', 'official-readiness-fail-closed',
  'phase2-package-boundary-diagnostic'
]);

function expectedCommandLog(record, stdout, stderr) {
  return Buffer.concat([
    Buffer.from(`COMMAND: ${record.command} ${record.args.join(' ')}\nCWD: ${record.cwd}\nARGV_JSON: ${JSON.stringify([record.command, ...record.args])}\nENV_OVERRIDES_JSON: ${JSON.stringify(record.envOverrides)}\nARGV_SHA256: ${record.argvSha256}\nSOURCE_BINDING_JSON: ${JSON.stringify(record.sourceBinding)}\nSTARTED_AT: ${record.startedAt}\nENDED_AT: ${record.endedAt}\nEXIT_CODE: ${record.exitCode}\nSIGNAL: ${record.signal || 'none'}\nERROR: ${record.spawnError || 'none'}\nDURATION_MS: ${Number(record.durationMs).toFixed(3)}\n--- STDOUT ---\n`),
    stdout, Buffer.from('\n--- STDERR ---\n'), stderr, Buffer.from('\n')
  ]);
}

function withCapturedFile(bytes, label, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-phase1-captured-'));
  try {
    fs.chmodSync(directory, 0o700);
    const filePath = path.join(directory, 'captured.bin');
    const fd = fs.openSync(filePath, 'wx', 0o400);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    return callback(filePath, directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function withValidatedRegularTar(bytes, label, callback) {
  return withCapturedFile(bytes, label, archivePath => {
    let listOutput;
    let verboseOutput;
    try {
      listOutput = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
      verboseOutput = execFileSync('tar', ['-tvzf', archivePath], { encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
    } catch (cause) { fail(`${label} could not be listed safely: ${String(cause?.message || cause)}`); }
    const names = listOutput.split(/\r?\n/).filter(Boolean);
    const types = verboseOutput.split(/\r?\n/).filter(Boolean);
    if (!names.length || names.length !== types.length || new Set(names).size !== names.length ||
        names.some(name => !safeRelativePath(name) || /[\r\n\0]/.test(name)) ||
        types.some(line => !line.startsWith('-') || line.includes(' -> ') || line.includes(' link to '))) {
      fail(`${label} contains duplicate, unsafe, non-regular or ambiguous TAR entries`);
    }
    return callback({ archivePath, names, readEntry(relative) {
      if (!names.includes(relative)) fail(`${label} does not contain the requested entry: ${relative}`);
      try { return execFileSync('tar', ['-xOzf', archivePath, relative], { encoding: 'buffer', timeout: 15000, maxBuffer: 256 * 1024 * 1024 }); }
      catch (cause) { fail(`${label} entry could not be read: ${relative}: ${String(cause?.message || cause)}`); }
    }});
  });
}

function verifyCommandLedger(manifest, byPath, readEvidence, { evidenceRoot, sourceRoot }) {
  const records = manifest.commandResults;
  const preservedCandidate = manifest.candidate?.acquisition === 'PRESERVED_EXISTING_CANDIDATE_NO_PACKAGED_INPUT_CHANGES';
  if (preservedCandidate) {
    const command = manifest.replayCommand;
    const expectedPrefix = ['npm', 'run', 'agg:phase1:replay', '--', '--output-dir'];
    if (!Array.isArray(command) || command.slice(0, expectedPrefix.length).join('\0') !== expectedPrefix.join('\0') ||
        typeof command[5] !== 'string' || path.resolve(sourceRoot, command[5]) !== evidenceRoot ||
        JSON.stringify(command.slice(6)) !== JSON.stringify(['--preserve-existing-candidate',
          path.resolve(sourceRoot, manifest.candidate.preservedSourcePath)])) {
      fail('machine-readable replay command must exactly bind the evidence output directory and preserved candidate path');
    }
  }
  const requiredCommands = preservedCandidate
    ? [...REQUIRED_REPLAY_COMMANDS.filter(name => name !== 'mcpb-build-and-extracted-e2e'), 'candidate-preservation-check']
    : REQUIRED_REPLAY_COMMANDS;
  if (!Array.isArray(records) || records.length !== requiredCommands.length ||
      records.some(record => !record || typeof record.name !== 'string') ||
      new Set(records.map(record => record.name)).size !== records.length ||
      requiredCommands.some(name => !records.some(record => record.name === name))) {
    fail('command ledger is incomplete: every required toolchain, test, build, smoke, benchmark, readiness and boundary command needs exactly one record');
  }
  const usedPaths = new Set();
  const stdoutByName = new Map();
  const expectedSourceBinding = {
    baseGitHead: manifest.sourceSnapshot?.baseGitHead,
    sourceSnapshotSha256: manifest.sourceSnapshot?.sourceSnapshotSha256,
    trackedPatchSha256: manifest.sourceSnapshot?.trackedPatchSha256,
    untrackedSourceOverlaySha256: manifest.sourceSnapshot?.untrackedSourceOverlaySha256
  };
  for (const record of records) {
    const executionStatus = record.executionStatus || 'EXECUTED';
    const expectedSkipReason = record.name === 'package-reproducibility'
      ? 'MCPB packaged inputs are unchanged; avoid rebuilding solely for a benchmark-only scorer/test change'
      : record.name === 'mcpb-extracted-fast-smoke'
        ? 'MCPB packaged inputs are unchanged and candidate bytes are preserved; extracted-package E2E is intentionally not rerun'
        : null;
    if (typeof record.command !== 'string' || !record.command || !Array.isArray(record.args) || record.args.some(arg => typeof arg !== 'string') ||
        typeof record.cwd !== 'string' || path.resolve(record.cwd) !== sourceRoot || typeof record.envOverrides !== 'object' ||
        record.envOverrides === null || Array.isArray(record.envOverrides) ||
        Object.entries(record.envOverrides).some(([key, value]) => !/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== 'string') ||
        record.argvSha256 !== sha256(Buffer.from(JSON.stringify([record.command, ...record.args]), 'utf8')) ||
        JSON.stringify(record.sourceBinding) !== JSON.stringify(expectedSourceBinding) ||
        !/^[a-f0-9]{40}$/.test(record.sourceBinding?.baseGitHead || '') ||
        !/^[a-f0-9]{64}$/.test(record.sourceBinding?.sourceSnapshotSha256 || '') ||
        !/^[a-f0-9]{64}$/.test(record.sourceBinding?.trackedPatchSha256 || '') ||
        !/^[a-f0-9]{64}$/.test(record.sourceBinding?.untrackedSourceOverlaySha256 || '') ||
        !Number.isFinite(Date.parse(record.startedAt)) || !Number.isFinite(Date.parse(record.endedAt)) ||
        new Date(Date.parse(record.startedAt)).toISOString() !== record.startedAt ||
        new Date(Date.parse(record.endedAt)).toISOString() !== record.endedAt || Date.parse(record.endedAt) < Date.parse(record.startedAt) ||
        !Number.isFinite(record.durationMs) || record.durationMs < 0 || !['EXECUTED', 'SKIPPED'].includes(executionStatus) ||
        (executionStatus === 'EXECUTED' && (record.exitCode !== 0 || record.signal !== null || record.spawnError !== null || record.skipReason != null)) ||
        (executionStatus === 'SKIPPED' && (!preservedCandidate || !expectedSkipReason || record.command !== 'NOT_RUN' ||
          record.args.length !== 0 || record.exitCode !== null || record.signal !== null || record.spawnError !== null ||
          record.durationMs !== 0 || record.skipReason !== expectedSkipReason)) ||
        !/^[a-f0-9]{64}$/.test(record.logSha256 || '') || !/^[a-f0-9]{64}$/.test(record.stdoutSha256 || '') ||
        !/^[a-f0-9]{64}$/.test(record.stderrSha256 || '')) {
      fail(`command ledger record is malformed or has a missing/nonzero exit status: ${record.name}`);
    }
    const requiredPaths = [
      [record.logPath, `logs/${record.name}.log`, 'logPath'],
      [record.stdoutPath, `logs/${record.name}.stdout.bin`, 'stdoutPath'],
      [record.stderrPath, `logs/${record.name}.stderr.bin`, 'stderrPath']
    ];
    const captured = {};
    for (const [relative, expectedPath, field] of requiredPaths) {
      if (relative !== expectedPath || !safeRelativePath(relative) || usedPaths.has(relative) || !byPath.has(relative)) {
        fail(`command ${record.name} is missing its distinct manifest-bound ${field} evidence`);
      }
      usedPaths.add(relative);
      captured[field] = readEvidence(relative, `command ${record.name} ${field}`, 256 * 1024 * 1024);
    }
    if (sha256(captured.stdoutPath) !== record.stdoutSha256 || sha256(captured.stderrPath) !== record.stderrSha256 ||
        sha256(captured.logPath) !== record.logSha256) {
      fail(`command ${record.name} log/stdout/stderr hashes do not match the recorded command receipt`);
    }
    if (!expectedCommandLog(record, captured.stdoutPath, captured.stderrPath).equals(captured.logPath)) {
      fail(`command ${record.name} combined log does not reconstruct byte-for-byte from the raw output sidecars and exit metadata`);
    }
    if (executionStatus === 'SKIPPED' && captured.stdoutPath.toString('utf8') !== `SKIPPED_REASON: ${expectedSkipReason}\n`) {
      fail(`skipped command ${record.name} lacks its exact raw reason; skipped work must never be reported as a passing execution`);
    }
    stdoutByName.set(record.name, captured.stdoutPath.toString('utf8'));
  }
  const exactCommands = new Map([
    ['tool-node', [process.execPath, ['--version']]], ['tool-npm', ['npm', ['--version']]], ['tool-git', ['git', ['--version']]],
    ['tool-zip', ['zip', ['-v']]], ['tool-unzip', ['unzip', ['-v']]], ['tool-tar', ['tar', ['--version']]],
    ['tool-platform', ['uname', ['-srmo']]], ['npm-test', ['npm', ['test']]], ['docs-check', ['npm', ['run', 'docs:check']]],
    ['git-diff-check', ['git', ['diff', '--check']]], ['package-reproducibility', ['npm', ['run', 'test:package-reproducibility']]],
    ['package-no-overwrite', [process.execPath, ['tests/test-package-no-overwrite.js']]],
    ['offline-agg-algorithm-benchmark', [process.execPath, ['benchmarks/adaptive-goal-graph/run-phase1-benchmark.mjs', '--output',
      path.join(evidenceRoot, 'phase1-algorithm-raw.json'), '--report', path.join(evidenceRoot, 'phase1-algorithm-report.md')]]],
    ['offline-agg-ledger-integrity', [process.execPath, ['benchmarks/adaptive-goal-graph/verify-phase1-ledger.mjs', '--raw',
      path.join(evidenceRoot, 'phase1-algorithm-raw.json'), '--manifest', path.join(evidenceRoot, 'phase1-algorithm-raw.json.manifest.json')]]],
    ['official-readiness-fail-closed', [process.execPath, ['benchmarks/plugin-workflow-benchmark/phase1-protocol-runner.mjs', 'readiness', '--output',
      path.join(evidenceRoot, 'official-readiness.json')]]]
  ]);
  for (const [name, [command, args]] of exactCommands) {
    const record = records.find(item => item.name === name);
    if (record?.executionStatus === 'SKIPPED') continue;
    if (record?.command !== command || JSON.stringify(record.args) !== JSON.stringify(args) ||
        Object.keys(record.envOverrides).length !== 0) {
      fail(`command receipt ${name} does not match its required exact invocation`);
    }
  }
  const focused = records.find(record => record.name === 'focused-agg-phase1-tests');
  if (focused?.command !== process.execPath || focused.args[0] !== '--test' ||
      !focused.args.includes('tests/test-plugin-workflow-benchmark-phase1-protocol.mjs') ||
      !focused.args.includes('tests/test-agg-phase1-evidence-pack-verifier.mjs') || Object.keys(focused.envOverrides).length !== 0) {
    fail('focused AGG/Phase 1 test receipt does not invoke the required protocol and verifier regression suites');
  }
  const requiredCandidateReceipts = new Map([
    ...(preservedCandidate ? [['candidate-preservation-check', 'preserved']] : [['mcpb-build-and-extracted-e2e', 'produced']]),
    ['candidate-source-alignment', 'verified'],
    ...(preservedCandidate ? [] : [['mcpb-extracted-fast-smoke', 'consumed']]),
    ['phase2-package-boundary-diagnostic', 'compared']
  ]);
  const candidateBindings = records.filter(record => record.candidateBinding);
  if (candidateBindings.length !== requiredCandidateReceipts.size) fail('candidate-bound command receipt inventory must include build, source alignment, extracted smoke and Phase 2 boundary exactly once');
  for (const [name, relation] of requiredCandidateReceipts) {
    const rows = records.filter(record => record.name === name);
    const binding = rows[0]?.candidateBinding;
    if (rows.length !== 1 || binding?.relation !== relation || !path.isAbsolute(binding.path) || !/^[a-f0-9]{64}$/.test(binding.sha256 || '')) {
      fail(`candidate-bound command receipt is malformed or has the wrong role: ${name}`);
    }
  }
  for (const record of records) {
    if (record.candidateBinding && !requiredCandidateReceipts.has(record.name)) fail(`unexpected candidate-binding claim in unrelated command receipt: ${record.name}`);
    if (!record.candidateBinding && requiredCandidateReceipts.has(record.name)) fail(`candidate-consuming command lacks a candidate-bound receipt: ${record.name}`);
    if (record.candidateBinding && (record.candidateBinding.path !== path.resolve(evidenceRoot, manifest.candidate?.path || '') ||
        record.candidateBinding.sha256 !== manifest.candidate?.sha256)) {
      fail(`candidate command ${record.name} refers to a different candidate path or digest than the evidence pack manifest`);
    }
  }
  const candidatePath = path.resolve(evidenceRoot, manifest.candidate?.path || '');
  const recordByName = new Map(records.map(record => [record.name, record]));
  const build = recordByName.get('mcpb-build-and-extracted-e2e');
  const preservation = recordByName.get('candidate-preservation-check');
  const alignment = recordByName.get('candidate-source-alignment');
  const smoke = recordByName.get('mcpb-extracted-fast-smoke');
  const boundary = recordByName.get('phase2-package-boundary-diagnostic');
  const candidateAcquisitionValid = preservedCandidate
    ? manifest.candidate?.preservedSourcePath === 'artifacts/agg-phase1-hardening-20261023T134921Z-end-to-end/runalith-1.0.9-rc.5-agg-phase1-hardened.mcpb' &&
      manifest.candidate?.sha256 === '7fb5f547eda71a717d10358510e1ea7baee46f5f9bcea3efc2891c6293bd3bc0' &&
      preservation?.command === process.execPath && JSON.stringify(preservation.args) === JSON.stringify([
        'scripts/verify-mcpb-source-alignment.mjs', '--source-root', sourceRoot, '--bundle',
        path.resolve(sourceRoot, manifest.candidate.preservedSourcePath), '--output',
        path.join(evidenceRoot, manifest.candidate.preservationProvenancePath || '')
      ]) && recordByName.get('package-reproducibility')?.executionStatus === 'SKIPPED' &&
      smoke?.executionStatus === 'SKIPPED'
    : build?.command === 'npm' && JSON.stringify(build.args) === JSON.stringify(['run', 'pack:runalith-mcpb']) &&
      build.envOverrides.PLUGIN_BUNDLE_OUT === candidatePath;
  if (!safeRelativePath(manifest.candidate?.path) || !/^[a-f0-9]{64}$/.test(manifest.candidate?.sha256 || '') ||
      !candidateAcquisitionValid ||
      alignment?.command !== process.execPath || JSON.stringify(alignment.args) !== JSON.stringify([
        'scripts/verify-mcpb-source-alignment.mjs', '--source-root', sourceRoot, '--bundle', candidatePath,
        '--output', path.join(evidenceRoot, 'source-binary-provenance.json')
      ]) || (!preservedCandidate && (smoke?.command !== 'npm' || JSON.stringify(smoke.args) !== JSON.stringify(['run', 'test:mcpb-candidate', '--', candidatePath]))) ||
      boundary?.command !== process.execPath || JSON.stringify(boundary.args) !== JSON.stringify([
        'scripts/verify-agg-phase1-phase2-package-boundary.mjs', '--phase1-bundle', candidatePath,
        '--output', path.join(evidenceRoot, manifest.phase2Boundary?.reportPath || '')
      ])) {
    fail('candidate build, byte alignment, extracted smoke and Phase 2 boundary command arguments are not bound to the same exact evidence-pack candidate path');
  }
  const toolchain = {};
  for (const [key, name] of [['node', 'tool-node'], ['npm', 'tool-npm'], ['git', 'tool-git'], ['zip', 'tool-zip'],
    ['unzip', 'tool-unzip'], ['tar', 'tool-tar'], ['platform', 'tool-platform']]) {
    const output = stdoutByName.get(name);
    if (typeof output !== 'string' || !output.trim()) fail(`toolchain receipt has empty raw stdout: ${name}`);
    toolchain[key] = output.trim().split(/\r?\n/).slice(0, 3).join('\n');
  }
  if (JSON.stringify(toolchain) !== JSON.stringify(manifest.toolchain)) fail('manifest toolchain version values do not reconstruct from exact captured tool-version stdout');
  return { status: 'PASS_SELF_CONSISTENT_COMMAND_LEDGER', commandCount: records.length, rawOutputSidecarsVerified: records.length * 2,
    candidateBoundCommandCount: candidateBindings.length, toolchain };
}

function verifySnapshotArchive(archiveBytes, expectedContents) {
  withValidatedRegularTar(archiveBytes, 'source snapshot transport archive', ({ names, readEntry }) => {
    const expectedNames = Object.keys(expectedContents).sort();
    if (names.slice().sort().join('\0') !== expectedNames.join('\0')) {
      fail('source snapshot transport archive entry inventory is incomplete or ambiguous');
    }
    for (const relative of expectedNames) {
      if (!readEntry(relative).equals(expectedContents[relative])) fail(`source snapshot transport archive member differs from its separately recorded file: ${relative}`);
    }
  });
}

function statusWithoutHistoricalArtifacts(bytes) {
  return Buffer.from(bytes.toString('utf8').split(/\r?\n/)
    .filter(line => !/^\?\? artifacts(?:\/|$)/.test(line)).join('\n').replace(/\n*$/, '\n'));
}

function verifyCurrentSourceRootMatchesSnapshot({ sourceRoot, metadata, patchBytes, statusAllBytes, statusNormalBytes }) {
  let head;
  let patch;
  let allStatus;
  let normalStatus;
  let untrackedBytes;
  try {
    head = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    patch = execFileSync('git', ['-C', sourceRoot, 'diff', '--binary', 'HEAD'], { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 });
    allStatus = execFileSync('git', ['-C', sourceRoot, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
    normalStatus = execFileSync('git', ['-C', sourceRoot, 'status', '--short', '--untracked-files=normal'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
    untrackedBytes = execFileSync('git', ['-C', sourceRoot, 'ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
  } catch (cause) { fail(`current source-root Git state cannot be read for drift detection: ${String(cause?.stderr || cause?.message || cause)}`); }
  if (head !== metadata.baseGitHead || !patch.equals(patchBytes)) {
    fail('current Git HEAD or tracked working-tree patch differs from the source snapshot recorded in this evidence pack');
  }
  if (!statusWithoutHistoricalArtifacts(allStatus).equals(statusWithoutHistoricalArtifacts(statusAllBytes)) ||
      !statusWithoutHistoricalArtifacts(normalStatus).equals(statusWithoutHistoricalArtifacts(statusNormalBytes))) {
    fail('current non-artifact Git status differs from the status inventory captured at replay start');
  }

  const ignoredDocs = new Set(['docs/plugin-workflow-benchmark-phase1-freeze.md', 'docs/plugin-workflow-benchmark-preflight-evidence.md']);
  const expectedUntracked = metadata.sourceOverlayEntries.map(row => row.path).filter(relative => !ignoredDocs.has(relative)).sort();
  const currentUntracked = untrackedBytes.toString('utf8').split('\0').filter(Boolean)
    .filter(relative => relative !== 'artifacts' && !relative.startsWith('artifacts/')).sort();
  if (currentUntracked.join('\0') !== expectedUntracked.join('\0')) {
    fail('current non-artifact untracked-source inventory differs from the overlay recorded at replay start');
  }
  for (const row of metadata.sourceOverlayEntries) {
    const currentBytes = readRegular(sourceRoot, row.path, 'current snapshot-bound source overlay file', 32 * 1024 * 1024);
    const currentStat = fs.lstatSync(path.join(sourceRoot, row.path), { bigint: true });
    if (currentBytes.byteLength !== row.sizeBytes || sha256(currentBytes) !== row.sha256 || Number(currentStat.mode & 0o777n) !== row.mode) {
      fail(`current source overlay file differs from the captured source snapshot: ${row.path}`);
    }
  }
  return { status: 'PASS_CURRENT_SOURCE_ROOT_MATCHES_CAPTURED_GIT_AND_OVERLAY_STATE', gitHead: head,
    trackedPatchSha256: sha256(patch), untrackedSourceFileCount: currentUntracked.length };
}

function reconstructAndVerifySourceSnapshot({ sourceRoot, metadata, patchBytes, overlayBytes, candidateBytes, provenance }) {
  const head = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== metadata.baseGitHead) fail(`source snapshot base HEAD differs from the supplied source repository: ${metadata.baseGitHead} != ${head}`);
  const reconstructionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-phase1-independent-reconstruct-'));
  try {
    const clone = execFileSync('git', ['clone', '--quiet', '--shared', '--no-checkout', sourceRoot, reconstructionDir], { encoding: 'utf8', timeout: 60000 });
    void clone;
    execFileSync('git', ['checkout', '--quiet', '--detach', metadata.baseGitHead], { cwd: reconstructionDir, encoding: 'utf8', timeout: 30000 });
    if (patchBytes.byteLength) {
      try {
        withCapturedFile(patchBytes, 'captured tracked working-tree patch', patchPath =>
          execFileSync('git', ['apply', '--binary', patchPath], { cwd: reconstructionDir, encoding: 'utf8', timeout: 30000 }));
      } catch (cause) { fail(`captured tracked working-tree patch cannot be replayed: ${String(cause?.stderr || cause?.message || cause)}`); }
    }

    return withValidatedRegularTar(overlayBytes, 'untracked source overlay', ({ archivePath, names, readEntry }) => {
      if (names.length !== metadata.sourceOverlayFileCount || metadata.untrackedSourceFileCount !== names.length - 2) {
        fail('source overlay file inventory differs from the captured snapshot metadata');
      }
      const overlayRows = metadata.sourceOverlayEntries;
      if (!Array.isArray(overlayRows) || overlayRows.length !== names.length ||
          overlayRows.some(row => !row || !safeRelativePath(row.path) || !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 0 ||
            !/^[a-f0-9]{64}$/.test(row.sha256 || '') || !Number.isInteger(row.mode) || row.mode < 0 || row.mode > 0o777) ||
          new Set(overlayRows.map(row => row.path)).size !== overlayRows.length ||
          overlayRows.map(row => row.path).sort().join('\0') !== [...names].sort().join('\0')) {
        fail('source overlay metadata does not enumerate every regular archived file with size, hash and mode');
      }
      const entryByPath = new Map(overlayRows.map(row => [row.path, row]));
      for (const relative of names) {
        const bytes = readEntry(relative);
        const row = entryByPath.get(relative);
        if (bytes.byteLength !== row.sizeBytes || sha256(bytes) !== row.sha256) {
          fail(`source overlay member differs from its byte-level inventory receipt: ${relative}`);
        }
      }
      const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: reconstructionDir, encoding: 'buffer' }).toString('utf8').split('\0').filter(Boolean));
      for (const relative of names) {
        if (tracked.has(relative) || fs.existsSync(path.join(reconstructionDir, relative))) {
          fail(`source overlay would overwrite a tracked or existing path during reconstruction: ${relative}`);
        }
      }
      try { execFileSync('tar', ['--same-permissions', '-xzf', archivePath, '-C', reconstructionDir], { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 }); }
      catch (cause) { fail(`captured untracked source overlay extraction failed: ${String(cause?.stderr || cause?.message || cause)}`); }
      for (const relative of names) {
        const full = path.join(reconstructionDir, relative);
        const stat = fs.lstatSync(full, { throwIfNoEntry: false });
        if (!stat?.isFile() || stat.isSymbolicLink() || fs.realpathSync(full) !== full ||
            (stat.mode & 0o777) !== entryByPath.get(relative).mode) {
          fail(`reconstructed overlay path is missing, non-regular or non-canonical: ${relative}`);
        }
      }
      const ignoredRows = metadata.ignoredButRetainedSourceFiles;
      for (const required of ['docs/plugin-workflow-benchmark-phase1-freeze.md', 'docs/plugin-workflow-benchmark-preflight-evidence.md']) {
        const row = ignoredRows.find(item => item?.path === required);
        if (!row || sha256(fs.readFileSync(path.join(reconstructionDir, required))) !== row.sha256) {
          fail(`reconstructed ignored source document does not match its captured hash: ${required}`);
        }
      }
      const reconstructed = verifyAlignmentForCapturedBundle(reconstructionDir, candidateBytes);
      for (const field of ['bundleSha256', 'sourceSnapshotSha256', 'archiveEntryCount', 'exactSourceByteMatchCount',
        'projectedMetadataMatchCount', 'manifestToolCount', 'sourceServerSha256', 'sourceManifestSha256']) {
        if (reconstructed[field] !== provenance[field]) fail(`independent clean-clone reconstruction differs from source/binary provenance at ${field}`);
      }
      return {
        status: 'PASS_RECONSTRUCTED_FROM_CAPTURED_PATCH_AND_OVERLAY',
        baseGitHead: metadata.baseGitHead,
        repositorySourceSnapshotSha256: metadata.sourceSnapshotSha256,
        candidateSourceSnapshotSha256: reconstructed.sourceSnapshotSha256,
        candidateSha256: reconstructed.bundleSha256,
        archiveEntryCount: reconstructed.archiveEntryCount,
        manifestToolCount: reconstructed.manifestToolCount
      };
    });
  } catch (cause) {
    if (cause?.code === 'AGG_PHASE1_EVIDENCE_PACK_INVALID') throw cause;
    fail(`independent clean-clone source reconstruction failed: ${String(cause?.stderr || cause?.message || cause)}`);
  } finally {
    fs.rmSync(reconstructionDir, { recursive: true, force: true });
  }
}

function verifyAlignmentForCapturedBundle(sourceRoot, candidateBytes) {
  return withCapturedFile(candidateBytes, 'captured MCPB candidate', bundlePath =>
    verifyMcpbSourceAlignment({ sourceRoot, bundlePath }));
}

export function verifyAggPhase1EvidencePack({ evidenceDir, sourceRoot, allowMissingVerificationReport = false }) {
  const evidenceRoot = path.resolve(evidenceDir);
  const source = path.resolve(sourceRoot);
  if (fs.realpathSync(evidenceRoot) !== evidenceRoot || fs.realpathSync(source) !== source) {
    fail('evidence and source roots must be canonical real directories');
  }
  if (!fs.statSync(evidenceRoot).isDirectory() || !fs.statSync(source).isDirectory()) fail('evidence and source roots must be directories');
  const initialTreeIdentity = captureAggPhase1EvidenceTreeIdentity(evidenceRoot);
  const evidenceCache = new Map();
  const readEvidence = (relative, label, maxBytes = 256 * 1024 * 1024) => {
    if (!evidenceCache.has(relative)) evidenceCache.set(relative, readRegular(evidenceRoot, relative, label, maxBytes));
    return evidenceCache.get(relative);
  };
  const manifestBytes = readEvidence('evidence-pack-manifest.json', 'evidence pack manifest', 8 * 1024 * 1024);
  let manifest;
  try { manifest = parseStrictJson(manifestBytes, 'AGG Phase 1 evidence-pack manifest'); }
  catch (cause) { fail(`evidence-pack-manifest.json is not strict duplicate-free JSON: ${String(cause?.message || cause)}`); }
  if (manifest?.schemaVersion !== 2 || manifest.status !== 'INTEGRITY_VERIFIED_NOT_ACCEPTANCE' ||
      manifest.disposition !== 'DEVELOPMENT_CANDIDATE_VALIDATED_LOCALLY_NOT_OFFICIALLY_ACCEPTED' ||
      !Array.isArray(manifest.files) || !manifest.files.length) {
    fail('evidence pack must be a closed development-only manifest and cannot claim official acceptance');
  }
  const preservedCandidate = manifest.candidate?.acquisition === 'PRESERVED_EXISTING_CANDIDATE_NO_PACKAGED_INPUT_CHANGES';
  if (!manifest.readiness || manifest.readiness.executionGateOpen !== false || manifest.readiness.releaseApproved !== false ||
      typeof manifest.readiness.decision !== 'string' || !manifest.readiness.decision.startsWith('BLOCKED_')) {
    fail('evidence pack readiness must remain explicitly blocked with execution and release gates closed');
  }
  if (manifest.sourceSnapshotReconstruction?.status !== 'PASS' ||
      !/^[a-f0-9]{64}$/.test(manifest.sourceSnapshotReconstruction?.sourceSnapshotSha256 || '') ||
      !/^[a-f0-9]{64}$/.test(manifest.sourceSnapshotReconstruction?.candidateSha256 || '')) {
    fail('evidence pack must include a successful clean-clone source reconstruction bound to exact candidate/source hashes');
  }
  const seen = new Set();
  const verifiedFiles = [];
  for (const entry of manifest.files) {
    if (!entry || !safeRelativePath(entry.path) || seen.has(entry.path) ||
        !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')) {
      fail('evidence-pack manifest file list has malformed or duplicate path/hash/size records');
    }
    seen.add(entry.path);
    const bytes = readEvidence(entry.path, 'manifest-bound evidence file');
    if (bytes.byteLength !== entry.sizeBytes || sha256(bytes) !== entry.sha256) {
      fail(`evidence file hash/size mismatch: ${entry.path}`);
    }
    verifiedFiles.push({ path: entry.path, sizeBytes: bytes.byteLength, sha256: entry.sha256 });
  }
  const sumsBytes = readEvidence('SHA256SUMS.txt', 'evidence pack checksum list', 8 * 1024 * 1024);
  const sumRows = new Map();
  for (const line of sumsBytes.toString('utf8').split(/\r?\n/).filter(Boolean)) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match || !safeRelativePath(match[2]) || sumRows.has(match[2])) fail('SHA256SUMS.txt contains malformed or duplicate rows');
    sumRows.set(match[2], match[1]);
  }
  for (const entry of manifest.files) {
    if (sumRows.get(entry.path) !== entry.sha256) fail(`checksum file does not bind manifest entry: ${entry.path}`);
  }
  const manifestSha = sha256(manifestBytes);
  if (sumRows.get('evidence-pack-manifest.json') !== manifestSha) fail('SHA256SUMS.txt does not bind the exact evidence-pack-manifest.json bytes');
  for (const [relative, expectedHash] of sumRows) {
    if (relative === 'SHA256SUMS.txt') continue;
    const bytes = readEvidence(relative, 'checksum-bound file');
    if (sha256(bytes) !== expectedHash) fail(`SHA256SUMS.txt hash mismatch: ${relative}`);
  }

  // SHA256SUMS is the complete file inventory, not just a list of selected
  // high-value artifacts. Detect files omitted from both the checksum list and
  // the signed-off (hash-bound) manifest to prevent silent evidence injection.
  const actualFiles = new Set();
  const walkActualFiles = (directory, prefix = '', inventory = actualFiles) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) fail(`symlink inside evidence pack: ${relative}`);
      if (st.isDirectory()) walkActualFiles(full, relative, inventory);
      else if (st.isFile()) inventory.add(relative);
      else fail(`special file inside evidence pack: ${relative}`);
    }
  };
  walkActualFiles(evidenceRoot);
  for (const relative of actualFiles) {
    if (relative !== 'SHA256SUMS.txt' && !sumRows.has(relative)) {
      fail(`evidence pack contains a file not listed in SHA256SUMS.txt: ${relative}`);
    }
  }
  for (const relative of sumRows.keys()) {
    if (!actualFiles.has(relative)) fail(`SHA256SUMS.txt lists a missing evidence file: ${relative}`);
  }

  const byPath = new Map(manifest.files.map(item => [item.path, item]));
  const commandLedger = verifyCommandLedger(manifest, byPath, readEvidence, { evidenceRoot, sourceRoot: source });
  const verificationPath = manifest.verificationReportPath;
  if (typeof verificationPath !== 'string' || !safeRelativePath(verificationPath)) {
    fail('evidence pack must name a safe relative evidence-pack verification report path');
  }
  for (const entry of manifest.files) {
    if (!sumRows.has(entry.path)) fail(`manifest-listed evidence file is absent from SHA256SUMS.txt: ${entry.path}`);
  }
  for (const relative of actualFiles) {
    if (relative !== 'SHA256SUMS.txt' && relative !== 'evidence-pack-manifest.json' &&
        relative !== verificationPath && !byPath.has(relative)) {
      fail(`file is not listed in the evidence-pack manifest: ${relative}`);
    }
  }
  for (const relative of sumRows.keys()) {
    if (relative !== 'SHA256SUMS.txt' && relative !== 'evidence-pack-manifest.json' &&
        relative !== manifest.verificationReportPath && !byPath.has(relative)) {
      fail(`checksum-bound file is not listed in evidence-pack-manifest.json: ${relative}`);
    }
  }
  const candidateEntry = byPath.get(manifest.candidate?.path);
  const provenanceEntry = byPath.get(manifest.provenance?.path);
  const readinessEntry = byPath.get(manifest.readiness?.reportPath);
  if (!candidateEntry || !provenanceEntry || !readinessEntry) fail('manifest must bind candidate, source provenance, and machine-readable readiness report');
  const provenanceBytes = readEvidence(manifest.provenance.path, 'source/binary provenance report');
  let provenance;
  try { provenance = parseStrictJson(provenanceBytes, 'AGG Phase 1 source/binary provenance'); }
  catch (cause) { fail(`source/binary provenance report is not strict duplicate-free JSON: ${String(cause?.message || cause)}`); }
  if (manifest.provenance?.sha256 !== sha256(provenanceBytes)) fail('manifest provenance SHA-256 does not match the exact provenance report bytes');
  if (preservedCandidate) {
    const preservationPath = manifest.candidate?.preservationProvenancePath;
    if (!safeRelativePath(preservationPath) || !/^[a-f0-9]{64}$/.test(manifest.candidate?.preservationProvenanceSha256 || '')) {
      fail('preserved candidate must bind a separate source-alignment report for the original candidate bytes');
    }
    const preservationBytes = readEvidence(preservationPath, 'original candidate preservation provenance', 8 * 1024 * 1024);
    let preservationReport;
    try { preservationReport = parseStrictJson(preservationBytes, 'original candidate preservation provenance'); }
    catch (cause) { fail(`original candidate preservation provenance is not strict duplicate-free JSON: ${String(cause?.message || cause)}`); }
    if (sha256(preservationBytes) !== manifest.candidate.preservationProvenanceSha256 ||
        preservationReport.status !== 'PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT' ||
        preservationReport.bundleSha256 !== manifest.candidate.sha256 ||
        preservationReport.bundleSha256 !== '7fb5f547eda71a717d10358510e1ea7baee46f5f9bcea3efc2891c6293bd3bc0' ||
        preservationReport.sourceSnapshotSha256 !== manifest.candidate.sourceSnapshotSha256 ||
        preservationReport.archiveEntryCount !== manifest.candidate.archiveEntryCount ||
        preservationReport.manifestToolCount !== manifest.candidate.manifestToolCount) {
      fail('preserved candidate provenance does not independently establish unchanged packaged inputs and exact historical candidate identity');
    }
  }
  const candidateBytes = readEvidence(manifest.candidate.path, 'MCPB candidate', 64 * 1024 * 1024);
  const candidateSha = sha256(candidateBytes);
  if (candidateSha !== manifest.candidate.sha256 || candidateSha !== provenance.bundleSha256 ||
      candidateBytes.byteLength !== manifest.candidate.sizeBytes ||
      provenance.status !== 'PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT' ||
      provenance.archiveEntryCount !== manifest.candidate.archiveEntryCount ||
      provenance.manifestToolCount !== manifest.candidate.manifestToolCount ||
      provenance.sourceSnapshotSha256 !== manifest.candidate.sourceSnapshotSha256) {
    fail('candidate identity does not match its independent source/binary provenance report');
  }
  const recomputed = verifyAlignmentForCapturedBundle(source, candidateBytes);
  if (recomputed.bundleSha256 !== provenance.bundleSha256 ||
      recomputed.sourceSnapshotSha256 !== provenance.sourceSnapshotSha256 ||
      recomputed.sourceServerSha256 !== provenance.sourceServerSha256 ||
      recomputed.sourceManifestSha256 !== provenance.sourceManifestSha256 ||
      recomputed.archiveEntryCount !== provenance.archiveEntryCount) {
    fail('fresh source-to-binary verification does not match the included provenance report');
  }
  const readinessBytes = readEvidence(manifest.readiness.reportPath, 'machine-readable readiness report', 8 * 1024 * 1024);
  let readiness;
  try { readiness = parseStrictJson(readinessBytes, 'AGG Phase 1 readiness report'); }
  catch (cause) { fail(`machine-readable readiness report is not strict duplicate-free JSON: ${String(cause?.message || cause)}`); }
  if (readiness.decision !== manifest.readiness.decision || !readiness.decision?.startsWith('BLOCKED_') ||
      readiness.sourceProtocol?.targetBinding?.executionGateOpen !== false ||
      readiness.sourceProtocol?.targetBinding?.releaseApproved !== false ||
      !Array.isArray(readiness.blockers) || readiness.blockers.length === 0 ||
      readiness.acceptanceGates?.frozenPhase1ExecutionGateRemainsClosed !== true ||
      readiness.acceptanceGates?.durableOneShotGateConsumptionEvidenceSuppliedToReadiness !== false ||
      readiness.acceptanceGates?.executionGateOpenedByReadinessOrScorer !== false) {
    fail('readiness report differs from manifest or does not keep operational/release gates closed');
  }
  const phase2BoundaryPath = manifest.phase2Boundary?.reportPath;
  if (typeof phase2BoundaryPath !== 'string' || !safeRelativePath(phase2BoundaryPath)) {
    fail('evidence pack must identify a safe relative Phase 1 / Phase 2 package-boundary report');
  }
  const phase2BoundaryBytes = readEvidence(phase2BoundaryPath, 'Phase 1 / Phase 2 package-boundary report', 4 * 1024 * 1024);
  let phase2Boundary;
  try { phase2Boundary = parseStrictJson(phase2BoundaryBytes, 'AGG Phase 1 / Phase 2 package boundary'); }
  catch (cause) { fail(`Phase 1 / Phase 2 package-boundary report is not strict duplicate-free JSON: ${String(cause?.message || cause)}`); }
  if (phase2Boundary.status !== 'BLOCKED_PHASE2_FROZEN_COUNT_NOT_APPLICABLE_TO_CURRENT_PHASE1_PACKAGE' ||
      phase2Boundary.phase2ContractChanged !== false || phase2Boundary.phase1ArchiveTrimmed !== false ||
      phase2Boundary.phase1CandidateSubstitutedAsPhase2Approval !== false || phase2Boundary.officialAcceptanceClaimed !== false ||
      phase2Boundary.phase1?.sha256 !== candidateSha || phase2Boundary.phase1?.archiveEntryCount !== manifest.candidate.archiveEntryCount ||
      phase2Boundary.phase1?.manifestToolCount !== manifest.candidate.manifestToolCount ||
      phase2Boundary.frozenPhase2RequiredEntryCount !== 71 || phase2Boundary.historicalPhase2Reference?.archiveEntryCount !== 71 ||
      phase2Boundary.historicalPhase2Reference?.manifestToolCount !== 59 ||
      phase2Boundary.historicalPhase2Reference?.sha256 !== '2e9937d309e0c3085f9bf789b38ceff21b91c6fc093ba4ee344cf214c173a956' ||
      phase2Boundary.sameSemanticVersionString !== true || phase2Boundary.packageContractsDiffer !== true ||
      phase2Boundary.observedBoundaryMatchesFrozenHistoricalShape !== true) {
    fail('Phase 1 / Phase 2 package-boundary record does not bind the exact candidate and frozen historical 71-entry/59-tool reference');
  }

  const snapshotMetadataRelative = 'source-snapshot/snapshot-metadata.json';
  const patchRelative = 'source-snapshot/tracked-working-tree.patch';
  const overlayRelative = 'source-snapshot/untracked-source-overlay.tar.gz';
  const snapshotMetadataBytes = readEvidence(snapshotMetadataRelative, 'source snapshot metadata', 1024 * 1024);
  let snapshotMetadata;
  try { snapshotMetadata = parseStrictJson(snapshotMetadataBytes, 'AGG Phase 1 source snapshot metadata'); }
  catch (cause) { fail(`source snapshot metadata is not strict duplicate-free JSON: ${String(cause?.message || cause)}`); }
  const patchBytes = readEvidence(patchRelative, 'tracked source patch', 128 * 1024 * 1024);
  const overlayBytes = readEvidence(overlayRelative, 'untracked source overlay', 256 * 1024 * 1024);
  const globalSourceSnapshotSha256 = sha256(Buffer.from(
    `${snapshotMetadata.baseGitHead}\0${sha256(patchBytes)}\0${sha256(overlayBytes)}\0`, 'utf8'));
  if (snapshotMetadata.schemaVersion !== 2 || !/^[a-f0-9]{40}$/.test(snapshotMetadata.baseGitHead || '') ||
      snapshotMetadata.baseGitHead !== manifest.sourceSnapshot?.baseGitHead ||
      snapshotMetadata.sourceSnapshotSha256 !== manifest.sourceSnapshot?.sourceSnapshotSha256 ||
      globalSourceSnapshotSha256 !== snapshotMetadata.sourceSnapshotSha256 ||
      snapshotMetadata.trackedPatchSha256 !== sha256(patchBytes) || snapshotMetadata.trackedPatchBytes !== patchBytes.byteLength ||
      snapshotMetadata.untrackedSourceOverlaySha256 !== sha256(overlayBytes) ||
      snapshotMetadata.untrackedSourceOverlayBytes !== overlayBytes.byteLength ||
      snapshotMetadata.historicalArtifactsCopied !== false ||
      manifest.sourceSnapshotReconstruction.sourceSnapshotSha256 !== snapshotMetadata.sourceSnapshotSha256 ||
      manifest.sourceSnapshotReconstruction.candidateSourceSnapshotSha256 !== provenance.sourceSnapshotSha256 ||
      manifest.sourceSnapshotReconstruction.candidateSha256 !== candidateSha ||
      !Number.isSafeInteger(snapshotMetadata.sourceOverlayFileCount) || snapshotMetadata.sourceOverlayFileCount < 2 ||
      !Number.isSafeInteger(snapshotMetadata.untrackedSourceFileCount) || snapshotMetadata.untrackedSourceFileCount < 0 ||
      !Array.isArray(snapshotMetadata.sourceOverlayEntries) ||
      snapshotMetadata.sourceOverlayEntries.length !== snapshotMetadata.sourceOverlayFileCount) {
    fail('source snapshot metadata, patch/overlay bytes and clean-clone reconstruction hashes do not agree');
  }
  if (manifest.sourceSnapshot?.snapshotArchivePath) {
    const archiveBytes = readEvidence(manifest.sourceSnapshot.snapshotArchivePath, 'source snapshot transport archive', 256 * 1024 * 1024);
    if (sha256(archiveBytes) !== manifest.sourceSnapshot.snapshotArchiveSha256) {
      fail('source snapshot transport archive does not match the captured archive SHA-256');
    }
    const statusAllRelative = manifest.sourceSnapshot.statusAllPath;
    const statusNormalRelative = manifest.sourceSnapshot.statusNormalPath;
    if (statusAllRelative !== 'source-snapshot/git-status-all-at-snapshot.txt' ||
        statusNormalRelative !== 'source-snapshot/git-status-normal-at-snapshot.txt') {
      fail('source snapshot must use the canonical saved full and normal Git-status inventory paths');
    }
    const statusAllBytes = readEvidence(statusAllRelative, 'full Git status inventory', 32 * 1024 * 1024);
    const statusNormalBytes = readEvidence(statusNormalRelative, 'normal Git status inventory', 8 * 1024 * 1024);
    verifySnapshotArchive(archiveBytes, {
      'tracked-working-tree.patch': patchBytes,
      'untracked-source-overlay.tar.gz': overlayBytes,
      'snapshot-metadata.json': snapshotMetadataBytes,
      'git-status-all-at-snapshot.txt': statusAllBytes,
      'git-status-normal-at-snapshot.txt': statusNormalBytes
    });
    var currentSourceState = verifyCurrentSourceRootMatchesSnapshot({
      sourceRoot: source, metadata: snapshotMetadata, patchBytes, statusAllBytes, statusNormalBytes
    });
  } else fail('evidence pack does not identify the reproducible source snapshot transport archive');

  const requiredIgnoredDocuments = [
    'docs/plugin-workflow-benchmark-phase1-freeze.md',
    'docs/plugin-workflow-benchmark-preflight-evidence.md'
  ];
  const ignoredRows = snapshotMetadata.ignoredButRetainedSourceFiles;
  if (!Array.isArray(ignoredRows) || ignoredRows.length !== requiredIgnoredDocuments.length ||
      new Set(ignoredRows.map(item => item?.path)).size !== ignoredRows.length) {
    fail('source snapshot must retain the two explicitly excluded protocol/preflight documents');
  }
  for (const relative of requiredIgnoredDocuments) {
    const row = ignoredRows.find(item => item.path === relative);
    const sourceBytes = readRegular(source, relative, 'locally excluded frozen protocol document', 4 * 1024 * 1024);
    if (!row || !/^[a-f0-9]{64}$/.test(row.sha256 || '') || sha256(sourceBytes) !== row.sha256) {
      fail(`required ignored source document is absent or changed: ${relative}`);
    }
    let archivedBytes;
    try { archivedBytes = withValidatedRegularTar(overlayBytes, 'untracked source overlay', ({ readEntry }) => readEntry(relative)); }
    catch (cause) { fail(`source overlay does not contain required locally excluded document: ${relative}: ${String(cause?.message || cause)}`); }
    if (sha256(archivedBytes) !== row.sha256) fail(`source overlay document hash mismatch: ${relative}`);
  }

  const reconstruction = reconstructAndVerifySourceSnapshot({
    sourceRoot: source, metadata: snapshotMetadata, patchBytes, overlayBytes, candidateBytes, provenance
  });
  if (reconstruction.status !== 'PASS_RECONSTRUCTED_FROM_CAPTURED_PATCH_AND_OVERLAY' ||
      manifest.sourceSnapshotReconstruction?.baseGitHead !== reconstruction.baseGitHead ||
      manifest.sourceSnapshotReconstruction?.sourceSnapshotSha256 !== reconstruction.repositorySourceSnapshotSha256 ||
      manifest.sourceSnapshotReconstruction?.candidateSourceSnapshotSha256 !== reconstruction.candidateSourceSnapshotSha256 ||
      manifest.sourceSnapshotReconstruction?.candidateSha256 !== reconstruction.candidateSha256) {
    fail('independent reconstruction from captured patch and overlay does not agree with the manifest-bound reconstruction claim');
  }

  const statusReportBytes = readEvidence('candidate-final-status.json', 'machine-readable candidate status', 8 * 1024 * 1024);
  let statusReport;
  try { statusReport = parseStrictJson(statusReportBytes, 'AGG Phase 1 final candidate status'); }
  catch (cause) { fail(`candidate-final-status.json is not strict duplicate-free JSON: ${String(cause?.message || cause)}`); }
  if (statusReport.disposition !== 'DEVELOPMENT_CANDIDATE_VALIDATED_LOCALLY_NOT_OFFICIALLY_ACCEPTED' ||
      statusReport.candidate?.sha256 !== candidateSha ||
      statusReport.candidate?.sourceSnapshotSha256 !== provenance.sourceSnapshotSha256 ||
      statusReport.readiness?.decision !== readiness.decision || statusReport.readiness?.executionGateOpen !== false ||
      statusReport.readiness?.releaseApproved !== false || statusReport.sourceSnapshotReconstruction?.status !== 'PASS' ||
      statusReport.verification?.gitDiffCheck !== 'PASS' ||
      statusReport.phase2PackageBoundaryReportPath !== phase2BoundaryPath ||
      statusReport.verification?.phase2BoundaryShapeVerified !== true ||
      statusReport.verification?.phase2InventoryStatus !== phase2Boundary.status ||
      statusReport.repository?.sourceSnapshotSha256 !== snapshotMetadata.sourceSnapshotSha256 ||
      statusReport.sourceSnapshotReconstruction?.candidateSourceSnapshotSha256 !== provenance.sourceSnapshotSha256 ||
      statusReport.sourceSnapshotReconstruction?.repositorySourceSnapshotSha256 !== snapshotMetadata.sourceSnapshotSha256 ||
      statusReport.candidate?.acquisition !== manifest.candidate.acquisition ||
      (preservedCandidate && (JSON.stringify(statusReport.replayCommand) !== JSON.stringify(manifest.replayCommand) ||
        statusReport.verification?.mcpbBuildPerformed !== false || statusReport.verification?.extractedPackageE2ERun !== false)) ||
      (preservedCandidate && (statusReport.verification?.extractedPackageSmoke !== 'NOT_RUN_PACKAGED_INPUTS_UNCHANGED' ||
        statusReport.verification?.packageReproducibility !== 'NOT_RUN_PACKAGED_INPUTS_UNCHANGED'))) {
    fail('machine-readable final status does not bind the verified candidate/source/readiness or omits a passing final diff check');
  }
  if (!Array.isArray(statusReport.commands) || JSON.stringify(statusReport.commands) !== JSON.stringify(manifest.commandResults) ||
      JSON.stringify(statusReport.toolchain) !== JSON.stringify(manifest.toolchain)) {
    fail('machine-readable status and evidence manifest disagree about exact command receipts or toolchain versions');
  }

  const verificationExists = fs.existsSync(path.join(evidenceRoot, verificationPath));
  if (!verificationExists && !allowMissingVerificationReport) fail('evidence-pack-verification.json is missing');
  if (verificationExists) {
    if (!sumRows.has(verificationPath)) fail('evidence-pack verification report is not bound by SHA256SUMS.txt');
    const verificationBytes = readEvidence(verificationPath, 'evidence-pack verification report', 2 * 1024 * 1024);
    let verificationReport;
    try { verificationReport = parseStrictJson(verificationBytes, 'AGG Phase 1 evidence-pack verification report'); }
    catch (cause) { fail(`evidence-pack verification report is not strict duplicate-free JSON: ${String(cause?.message || cause)}`); }
    if (verificationReport.status !== 'PASS_INTEGRITY_ONLY_NOT_ACCEPTANCE' ||
        verificationReport.manifestSha256 !== manifestSha ||
        verificationReport.candidateSha256 !== candidateSha ||
        verificationReport.sourceSnapshotSha256 !== provenance.sourceSnapshotSha256 ||
        verificationReport.repositorySourceSnapshotSha256 !== snapshotMetadata.sourceSnapshotSha256 ||
        verificationReport.readinessDecision !== readiness.decision ||
        verificationReport.acceptanceClaimed !== false || verificationReport.releaseApproved !== false ||
        verificationReport.checksumVerificationStatus !== 'PASS' ||
        verificationReport.cleanCloneReconstructionStatus !== 'PASS') {
      fail('evidence-pack verification report does not bind current hashes/readiness or improperly claims acceptance');
    }
  }
  // Re-read each cached path with a stable descriptor and compare it with the
  // immutable bytes already used above. This catches an evidence-tree swap
  // between inventory, parsing, archive inspection and final report creation.
  for (const [relative, captured] of evidenceCache) {
    const current = readRegular(evidenceRoot, relative, 'final stable evidence recheck');
    if (!current.equals(captured)) fail(`evidence changed after initial verified read: ${relative}`);
  }
  const finalTreeIdentity = captureAggPhase1EvidenceTreeIdentity(evidenceRoot);
  if (JSON.stringify(initialTreeIdentity) !== JSON.stringify(finalTreeIdentity)) {
    fail('evidence path/device/inode/metadata inventory changed after initial snapshot; discard verifier result');
  }
  const finalFiles = new Set();
  walkActualFiles(evidenceRoot, '', finalFiles);
  if (finalFiles.size !== actualFiles.size || [...actualFiles].some(relative => !finalFiles.has(relative))) {
    fail('evidence inventory changed after initial checksum/path verification');
  }
  return {
    schemaVersion: 1,
    status: 'PASS_INTEGRITY_ONLY_NOT_ACCEPTANCE',
    verifiedAt: new Date().toISOString(),
    manifestSha256: manifestSha,
    checksumFileSha256: sha256(sumsBytes),
    evidenceFilesVerified: verifiedFiles.length,
    checksumEntriesVerified: sumRows.size,
    candidateSha256: candidateSha,
    sourceSnapshotSha256: recomputed.sourceSnapshotSha256,
    repositorySourceSnapshotSha256: snapshotMetadata.sourceSnapshotSha256,
    archiveEntryCount: recomputed.archiveEntryCount,
    manifestToolCount: recomputed.manifestToolCount,
    readinessDecision: readiness.decision,
    commandLedgerStatus: commandLedger.status,
    commandCount: commandLedger.commandCount,
    sourceSnapshotReconstructionStatus: reconstruction.status,
    currentSourceRootStatus: currentSourceState.status,
    releaseApproved: false,
    acceptanceClaimed: false
  };
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!['--evidence-dir', '--source-root'].includes(key) || !value || value.startsWith('--') || values[key]) {
      fail(`invalid or duplicate argument: ${key}`);
    }
    values[key] = value;
  }
  if (!values['--evidence-dir'] || !values['--source-root']) fail('Usage: node scripts/verify-agg-phase1-evidence-pack.mjs --evidence-dir DIR --source-root DIR');
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = verifyAggPhase1EvidencePack({ evidenceDir: args['--evidence-dir'], sourceRoot: args['--source-root'] });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (cause) {
    process.stderr.write(`${cause.code || 'AGG_PHASE1_EVIDENCE_PACK_INVALID'}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 2;
  }
}
