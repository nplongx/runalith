#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA256 = /^[a-f0-9]{64}$/;
const REQUIRED_GATES = Object.freeze([
  'PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED',
  'INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED',
  'PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED',
  'PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED',
  'ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN',
  'RUNNING_TASKS_MUST_DRAIN'
]);

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function readStableFile(inputPath, label, maxBytes = 16 * 1024 * 1024) {
  const absolute = path.resolve(inputPath);
  const before = fs.lstatSync(absolute, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || fs.realpathSync(absolute) !== absolute ||
      before.size < 1n || before.size > BigInt(maxBytes)) {
    throw new Error(`${label} must be a canonical regular file within ${maxBytes} bytes: ${absolute}`);
  }
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error(`${label} changed before read: ${absolute}`);
    }
    const chunks = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - size));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      size += count;
      if (size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes: ${absolute}`);
      chunks.push(chunk.subarray(0, count));
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(absolute, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
        after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs ||
        current.dev !== opened.dev || current.ino !== opened.ino || current.size !== opened.size ||
        current.mtimeNs !== opened.mtimeNs || current.ctimeNs !== opened.ctimeNs) {
      throw new Error(`${label} changed while being read: ${absolute}`);
    }
    const bytes = Buffer.concat(chunks, size);
    return { path: absolute, bytes, sha256: sha256(bytes), sizeBytes: size };
  } finally { fs.closeSync(fd); }
}

function readJson(inputPath, label) {
  const file = readStableFile(inputPath, label);
  let value;
  try { value = JSON.parse(file.bytes.toString('utf8')); }
  catch (error) { throw new Error(`${label} is not valid JSON: ${String(error?.message || error)}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return { ...file, value };
}

function resolveEvidencePath(inputPath) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) throw new Error('evidence path must be a non-empty string');
  return path.resolve(path.isAbsolute(inputPath) ? inputPath : path.join(ROOT, inputPath));
}

function addCheck(checks, code, passed, detail) { checks.push({ code, passed: Boolean(passed), detail }); }

function compareEmbeddedFile(checks, { label, inputPath, expectedSha256, expectedSizeBytes = null, now,
  maxLiveObservationAgeMs, liveObservation = false }) {
  let file;
  try { file = readStableFile(resolveEvidencePath(inputPath), label); }
  catch (error) {
    addCheck(checks, 'EVIDENCE_FILE_UNAVAILABLE', false, { label, path: inputPath, error: String(error?.message || error) });
    return null;
  }
  const hashMatches = SHA256.test(expectedSha256 || '') && file.sha256 === expectedSha256;
  const sizeMatches = expectedSizeBytes == null || file.sizeBytes === expectedSizeBytes;
  addCheck(checks, 'EVIDENCE_FILE_HASH_MATCH', hashMatches, { label, path: file.path, expectedSha256, actualSha256: file.sha256 });
  if (expectedSizeBytes != null) addCheck(checks, 'EVIDENCE_FILE_SIZE_MATCH', sizeMatches,
    { label, path: file.path, expectedSizeBytes, actualSizeBytes: file.sizeBytes });
  let value = null;
  if (liveObservation) {
    try { value = JSON.parse(file.bytes.toString('utf8')); } catch { value = null; }
    const timestamp = Date.parse(value?.observedAt || value?.generatedAt || value?.checkedAt || '');
    const ageMs = Number.isFinite(timestamp) ? now - timestamp : null;
    const fresh = ageMs !== null && ageMs >= -30_000 && ageMs <= maxLiveObservationAgeMs;
    addCheck(checks, 'LIVE_OBSERVATION_FRESH', fresh, { label, path: file.path, observedAt: value?.observedAt || value?.generatedAt || value?.checkedAt || null,
      ageMs, maxLiveObservationAgeMs, reason: ageMs === null ? 'NO_PARSEABLE_OBSERVATION_TIMESTAMP' : ageMs < -30_000 ? 'OBSERVATION_FROM_FUTURE' : ageMs > maxLiveObservationAgeMs ? 'STALE_LIVE_OBSERVATION' : 'WITHIN_FRESHNESS_WINDOW' });
  }
  return { file, value };
}

/**
 * Cross-check the exact candidate bytes against the acceptance index,
 * source-alignment record, rollout preflight, readiness dossier and repair
 * plan. This is integrity/freshness diagnostics only; it does not establish
 * release authority, production trust or lifecycle disposition.
 */
export function verifyAggAcceptanceConsistency({ candidatePath = null, acceptancePath, alignmentPath, preflightPath,
  dossierPath, remediationPath, now = Date.now(), maxLiveObservationAgeMs = 10 * 60 * 1000 } = {}) {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('now must be a non-negative safe integer');
  if (!Number.isSafeInteger(maxLiveObservationAgeMs) || maxLiveObservationAgeMs < 0) throw new TypeError('maxLiveObservationAgeMs must be a non-negative safe integer');
  const acceptanceFile = readJson(acceptancePath, 'acceptance evidence index');
  const acceptance = acceptanceFile.value;
  if (acceptance.recordType !== 'runalith-rc57-acceptance-evidence-index' &&
      acceptance.recordType !== 'runalith-acceptance-evidence-index') {
    throw new Error(`unsupported acceptance evidence recordType: ${String(acceptance.recordType)}`);
  }
  if (acceptance.schemaVersion !== 1 || !Array.isArray(acceptance.validationResults) || !Array.isArray(acceptance.packagedToolCalls)) {
    throw new Error('acceptance evidence index schema is unsupported');
  }
  const candidateInput = candidatePath || acceptance.candidate?.path;
  const candidateFile = readStableFile(resolveEvidencePath(candidateInput), 'candidate MCPB', 512 * 1024 * 1024);
  const alignmentFile = readJson(alignmentPath, 'source alignment report');
  const preflightFile = readJson(preflightPath, 'rollout preflight report');
  const dossierFile = readJson(dossierPath, 'readiness dossier');
  const remediationFile = readJson(remediationPath, 'remediation plan');
  const { value: alignment } = alignmentFile;
  const { value: preflight } = preflightFile;
  const { value: dossier } = dossierFile;
  const { value: remediation } = remediationFile;
  const checks = [];

  addCheck(checks, 'CANDIDATE_SHA256_MATCHES_ACCEPTANCE', candidateFile.sha256 === acceptance.candidate?.sha256,
    { expected: acceptance.candidate?.sha256, actual: candidateFile.sha256 });
  addCheck(checks, 'CANDIDATE_SIZE_MATCHES_ACCEPTANCE', candidateFile.sizeBytes === acceptance.candidate?.sizeBytes,
    { expected: acceptance.candidate?.sizeBytes, actual: candidateFile.sizeBytes });
  addCheck(checks, 'SOURCE_ALIGNMENT_BINDS_CANDIDATE', alignment.bundleSha256 === candidateFile.sha256 &&
    path.resolve(alignment.bundlePath || '') === candidateFile.path && alignment.byteIdentityStatus === 'PASS_EXACT_ARCHIVE_ENTRY_BYTES',
  { sourceStatus: alignment.sourceStatus, byteIdentityStatus: alignment.byteIdentityStatus,
    alignmentBundleSha256: alignment.bundleSha256, actualCandidateSha256: candidateFile.sha256, alignmentBundlePath: alignment.bundlePath });

  let manifest;
  let archiveEntries;
  let entryPointBytes;
  try {
    execFileSync('unzip', ['-tqq', candidateFile.path], { stdio: 'ignore', timeout: 30_000 });
    archiveEntries = execFileSync('unzip', ['-Z1', candidateFile.path], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000 })
      .split(/\r?\n/).filter(Boolean);
    manifest = JSON.parse(execFileSync('unzip', ['-p', candidateFile.path, 'manifest.json'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 30_000 }));
    const entryPoint = manifest.server?.entry_point;
    if (typeof entryPoint !== 'string' || !entryPoint || entryPoint.startsWith('/') || entryPoint.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) {
      throw new Error('manifest entrypoint is not a safe relative archive path');
    }
    entryPointBytes = execFileSync('unzip', ['-p', candidateFile.path, entryPoint], { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
  } catch (error) {
    addCheck(checks, 'CANDIDATE_ARCHIVE_INTEGRITY', false, { error: String(error?.message || error) });
  }
  if (manifest && Array.isArray(archiveEntries) && entryPointBytes) {
    addCheck(checks, 'CANDIDATE_ARCHIVE_INTEGRITY', true, { archiveEntryCount: archiveEntries.length });
    addCheck(checks, 'CANDIDATE_MANIFEST_IDENTITY_MATCHES_ACCEPTANCE', manifest.version === acceptance.candidate?.version &&
      manifest.server?.entry_point === acceptance.candidate?.entryPoint && manifest.tools?.length === acceptance.candidate?.manifestToolCount,
    { manifestVersion: manifest.version, expectedVersion: acceptance.candidate?.version, entryPoint: manifest.server?.entry_point,
      expectedEntryPoint: acceptance.candidate?.entryPoint, manifestToolCount: manifest.tools?.length, expectedToolCount: acceptance.candidate?.manifestToolCount });
    addCheck(checks, 'CANDIDATE_ENTRYPOINT_HASH_MATCHES_ACCEPTANCE', sha256(entryPointBytes) === acceptance.candidate?.entryPointSha256,
      { entryPoint: manifest.server.entry_point, expectedSha256: acceptance.candidate?.entryPointSha256, actualSha256: sha256(entryPointBytes) });
    for (const [label, count] of [['acceptance', acceptance.candidate?.archiveEntryCount], ['alignment', alignment.archiveEntryCount],
      ['preflight', preflight.candidate?.archiveEntryCount], ['dossier', dossier.candidate?.archiveEntryCount],
      ['remediation', remediation.candidate?.archiveEntryCount]]) {
      addCheck(checks, 'CANDIDATE_ARCHIVE_ENTRY_COUNT_MATCH', count === archiveEntries.length,
        { label, expected: count, actual: archiveEntries.length });
    }
  }

  for (const [label, report] of [['preflight', preflight], ['dossier', dossier], ['remediation', remediation]]) {
    addCheck(checks, 'REPORT_BINDS_EXACT_CANDIDATE', report.candidate?.sha256 === candidateFile.sha256 &&
      (!report.candidate?.path || path.resolve(report.candidate.path) === candidateFile.path),
    { label, candidateSha256: report.candidate?.sha256, actualCandidateSha256: candidateFile.sha256, candidatePath: report.candidate?.path });
  }
  const rollbackInput = acceptance.rollbackBaseline?.path;
  const rollbackFile = readStableFile(resolveEvidencePath(rollbackInput), 'rollback baseline MCPB', 512 * 1024 * 1024);
  addCheck(checks, 'ROLLBACK_SHA256_MATCHES_ALL_RELEASE_RECORDS', rollbackFile.sha256 === acceptance.rollbackBaseline?.sha256 &&
    rollbackFile.sha256 === preflight.rollback?.sha256,
  { path: rollbackFile.path, actualSha256: rollbackFile.sha256, acceptanceSha256: acceptance.rollbackBaseline?.sha256,
    preflightSha256: preflight.rollback?.sha256 });

  const gateLists = [
    ['preflight', preflight.decision?.blockers || []],
    ['dossier', (dossier.rc23Gates || []).map(gate => gate.code)],
    ['remediation', remediation.decision?.blockers || []],
    ['acceptance', acceptance.rollout?.blockers || []]
  ];
  for (const [label, gates] of gateLists) {
    addCheck(checks, 'REQUIRED_AUTHORITY_GATES_RETAINED', REQUIRED_GATES.every(gate => gates.includes(gate)),
      { label, required: REQUIRED_GATES, observed: gates });
  }
  addCheck(checks, 'ROLLOUT_FAILS_CLOSED', preflight.decision?.status === 'BLOCKED' && preflight.decision?.canActivateNow === false &&
    dossier.decision?.canActivateNow === false && remediation.decision?.canActivateNow === false && acceptance.rollout?.canActivateNow === false,
  { preflight: preflight.decision, dossier: dossier.decision, remediation: remediation.decision, acceptance: acceptance.rollout });
  addCheck(checks, 'NO_MUTATION_CLAIMED', preflight.readOnly === true && preflight.liveMutationPerformed === false &&
    preflight.workflowDatabaseMutationPerformed === false && preflight.externalSecurityStoreMutationPerformed === false &&
    remediation.decision?.liveWorkflowDatabaseMutationPerformed === false && remediation.decision?.externalTrustStoreMutationPerformed === false &&
    acceptance.liveMutationPerformed === false && acceptance.workflowDatabaseMutationPerformed === false &&
    acceptance.trustLedgerMutationPerformed === false && acceptance.externalCheckpointTransitionAttempted === false &&
    acceptance.packageInstalledOrActivated === false && acceptance.gitHistoryMutationPerformed === false,
  { preflightReadOnly: preflight.readOnly, preflightMutation: preflight.liveMutationPerformed,
    remediationLiveDbMutation: remediation.decision?.liveWorkflowDatabaseMutationPerformed,
    acceptanceMutationFlags: { live: acceptance.liveMutationPerformed, workflowDb: acceptance.workflowDatabaseMutationPerformed,
      trustLedger: acceptance.trustLedgerMutationPerformed, checkpoint: acceptance.externalCheckpointTransitionAttempted,
      install: acceptance.packageInstalledOrActivated, gitHistory: acceptance.gitHistoryMutationPerformed } });

  for (const result of acceptance.validationResults) {
    if (!Number.isInteger(result.exitCode) || !result.evidence?.path || !SHA256.test(result.evidence?.sha256 || '')) {
      addCheck(checks, 'ACCEPTANCE_VALIDATION_RECORD_SCHEMA', false, { command: result.command || null });
      continue;
    }
    const expectedExitCode = Number.isInteger(result.expectedExitCode) ? result.expectedExitCode :
      (String(result.result || '').startsWith('EXPECTED_') && result.exitCode === 3 ? 3 : 0);
    addCheck(checks, 'VALIDATION_EXIT_CODE_MATCHES_EXPECTATION', result.exitCode === expectedExitCode,
      { command: result.command, result: result.result || null, expectedExitCode, actualExitCode: result.exitCode });
    compareEmbeddedFile(checks, { label: `validation evidence: ${result.command}`, inputPath: result.evidence.path,
      expectedSha256: result.evidence.sha256, expectedSizeBytes: result.evidence.sizeBytes, now, maxLiveObservationAgeMs });
  }
  for (const input of dossier.evidenceInputs || []) {
    if (!input.path || !SHA256.test(input.sha256 || '')) {
      addCheck(checks, 'DOSSIER_EVIDENCE_INPUT_SCHEMA', false, { input });
      continue;
    }
    const liveObservation = /live-snapshot|live-reconciliation|trust-diagnostic/i.test(input.path);
    compareEmbeddedFile(checks, { label: `dossier input: ${input.source || input.path}`, inputPath: input.path,
      expectedSha256: input.sha256, now, maxLiveObservationAgeMs, liveObservation });
  }
  for (const input of remediation.sourceReports || []) {
    if (!input.path || !SHA256.test(input.sha256 || '')) {
      addCheck(checks, 'REMEDIATION_SOURCE_REPORT_SCHEMA', false, { input });
      continue;
    }
    compareEmbeddedFile(checks, { label: `remediation source: ${input.name || input.path}`, inputPath: input.path,
      expectedSha256: input.sha256, expectedSizeBytes: input.sizeBytes, now, maxLiveObservationAgeMs,
      liveObservation: /reconciliation|preflight/i.test(input.name || '') });
  }

  const failures = checks.filter(check => !check.passed);
  const blockers = [...new Set(failures.map(check => check.code))];
  return {
    schemaVersion: 1,
    recordType: 'runalith-acceptance-consistency-verification',
    generatedAt: new Date(now).toISOString(),
    evidenceClass: 'local integrity and freshness diagnostics; not independent release authorization or production evidence',
    result: blockers.length ? 'BLOCKED' : 'PASS',
    candidate: { path: candidateFile.path, sha256: candidateFile.sha256, sizeBytes: candidateFile.sizeBytes,
      version: manifest?.version || null, archiveEntryCount: archiveEntries?.length ?? null, entryPoint: manifest?.server?.entry_point || null,
      entryPointSha256: entryPointBytes ? sha256(entryPointBytes) : null },
    rollout: { status: preflight.decision?.status || null, canActivateNow: preflight.decision?.canActivateNow === true,
      requiredAuthorityGates: REQUIRED_GATES },
    checkedArtifacts: { acceptance: { path: acceptanceFile.path, sha256: acceptanceFile.sha256 },
      sourceAlignment: { path: alignmentFile.path, sha256: alignmentFile.sha256 },
      preflight: { path: preflightFile.path, sha256: preflightFile.sha256 },
      dossier: { path: dossierFile.path, sha256: dossierFile.sha256 },
      remediation: { path: remediationFile.path, sha256: remediationFile.sha256 },
      rollback: { path: rollbackFile.path, sha256: rollbackFile.sha256 } },
    checks, blockers,
    caveats: ['Local hashes and byte alignment establish integrity only, not independent builder provenance or release approval.',
      'A current-looking reconciliation is not owner/provider proof of task disposition; missing leases do not prove worker death.',
      'Any stale live observation keeps this consistency result blocked and requires a fresh authorized read-only observation, not timestamp rewriting.'],
    productionAuthorityGranted: false,
    liveMutationPerformed: false,
    packageInstalledOrActivated: false
  };
}

function parseArgs(argv) {
  const args = {};
  const names = new Map([['--candidate', 'candidatePath'], ['--acceptance', 'acceptancePath'], ['--alignment', 'alignmentPath'],
    ['--preflight', 'preflightPath'], ['--dossier', 'dossierPath'], ['--remediation', 'remediationPath'],
    ['--max-live-age-ms', 'maxLiveObservationAgeMs']]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!names.has(key)) throw new Error(`unsupported argument: ${key}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    const name = names.get(key);
    args[name] = name === 'maxLiveObservationAgeMs' ? Number(value) : value;
  }
  for (const key of ['acceptancePath', 'alignmentPath', 'preflightPath', 'dossierPath', 'remediationPath']) {
    if (!args[key]) throw new Error(`--${key.replace('Path', '').replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} is required`);
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = verifyAggAcceptanceConsistency(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.result !== 'PASS') process.exitCode = 3;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ result: 'FAIL', code: 'AGG_ACCEPTANCE_CONSISTENCY_INPUT_INVALID',
      message: String(error?.message || error), productionAuthorityGranted: false })}\n`);
    process.exitCode = 2;
  }
}
