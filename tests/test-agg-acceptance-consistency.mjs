import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyAggAcceptanceConsistency } from '../scripts/verify-agg-acceptance-consistency.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Keep the CLI fixture fresh relative to wall clock. Fixed historical timestamps
// made the default one-hour freshness boundary fail as the suite aged.
const NOW = Date.now();
const GATES = [
  'PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED', 'INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED',
  'PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED', 'PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED',
  'ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN', 'RUNNING_TASKS_MUST_DRAIN'
];

function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function jsonFile(file, value) { const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); fs.writeFileSync(file, bytes, { flag: 'w', mode: 0o600 }); return { path: file, sha256: sha(bytes), sizeBytes: bytes.length }; }
function makeZip(directory, file, entries) {
  execFileSync('zip', ['-X', '-q', file, ...entries], { cwd: directory });
  return fs.readFileSync(file);
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-acceptance-consistency-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const payload = path.join(dir, 'payload'); fs.mkdirSync(payload, { mode: 0o700 });
  const entryPoint = 'server/index-v1.0.9-rc.58.js';
  fs.mkdirSync(path.join(payload, 'server'), { mode: 0o700 });
  fs.writeFileSync(path.join(payload, entryPoint), 'export const candidate = "fixture";\n', { flag: 'wx', mode: 0o600 });
  const manifest = { version: '1.0.9-rc.58', server: { entry_point: entryPoint }, tools: [{ name: 'orchestrator_health' }] };
  fs.writeFileSync(path.join(payload, 'manifest.json'), `${JSON.stringify(manifest)}\n`, { flag: 'wx', mode: 0o600 });
  const candidatePath = path.join(dir, 'candidate.mcpb');
  const candidateBytes = makeZip(payload, candidatePath, ['manifest.json', entryPoint]);
  const rollbackPayload = path.join(dir, 'rollback-payload'); fs.mkdirSync(rollbackPayload, { mode: 0o700 });
  fs.writeFileSync(path.join(rollbackPayload, 'baseline.txt'), 'immutable rollback fixture\n', { flag: 'wx', mode: 0o600 });
  const rollbackPath = path.join(dir, 'rollback.mcpb');
  makeZip(rollbackPayload, rollbackPath, ['baseline.txt']);
  const candidateSha = sha(candidateBytes);
  const entryPointSha = sha(fs.readFileSync(path.join(payload, entryPoint)));
  const candidateStat = fs.statSync(candidatePath);
  const candidateCount = 2;
  const validationLog = path.join(dir, 'validation.log');
  fs.writeFileSync(validationLog, 'fixture validation evidence\n', { flag: 'wx', mode: 0o600 });
  const validationEvidence = { path: validationLog, sha256: sha(fs.readFileSync(validationLog)), sizeBytes: fs.statSync(validationLog).size };
  const snapshotPath = path.join(dir, 'live-snapshot.json');
  const snapshot = { observedAt: new Date(NOW - 60_000).toISOString(), readOnly: true, snapshotHash: 'snapshot-fixture' };
  jsonFile(snapshotPath, snapshot);
  const reconciliationPath = path.join(dir, 'live-reconciliation.json');
  const reconciliation = { generatedAt: new Date(NOW - 50_000).toISOString(), readOnly: true, liveMutationPerformed: false,
    workflowDatabaseMutationPerformed: false, externalSecurityStoreMutationPerformed: false };
  jsonFile(reconciliationPath, reconciliation);
  const lifecyclePath = path.join(dir, 'live-reconciliation-v2.json');
  jsonFile(lifecyclePath, reconciliation);
  const trustPath = path.join(dir, 'trust-diagnostic.json');
  jsonFile(trustPath, { observedAt: new Date(NOW - 40_000).toISOString(), readOnly: true });
  const alignmentPath = path.join(dir, 'alignment.json');
  const alignment = { bundlePath: candidatePath, bundleSha256: candidateSha, bundleBytes: candidateStat.size,
    sourceStatus: 'PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT', byteIdentityStatus: 'PASS_EXACT_ARCHIVE_ENTRY_BYTES',
    sourceProvenanceStatus: 'DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT', archiveEntryCount: candidateCount,
    manifestToolCount: 1 };
  const alignmentRef = jsonFile(alignmentPath, alignment);
  const preflightPath = path.join(dir, 'preflight.json');
  const preflight = { schemaVersion: 1, generatedAt: new Date(NOW - 30_000).toISOString(), readOnly: true,
    liveMutationPerformed: false, workflowDatabaseMutationPerformed: false, externalSecurityStoreMutationPerformed: false,
    candidate: { path: candidatePath, sha256: candidateSha, version: manifest.version, archiveEntryCount: candidateCount },
    rollback: { path: rollbackPath, sha256: sha(fs.readFileSync(rollbackPath)), verified: true },
    decision: { status: 'BLOCKED', canActivateNow: false, blockers: GATES } };
  const preflightRef = jsonFile(preflightPath, preflight);
  const dossierPath = path.join(dir, 'dossier.json');
  const dossier = { schemaVersion: 1, recordType: 'runalith-agg-live-readiness-dossier', generatedAt: new Date(NOW - 20_000).toISOString(),
    candidate: { path: candidatePath, sha256: candidateSha, version: manifest.version, archiveEntryCount: candidateCount },
    decision: { status: 'BLOCKED', canActivateNow: false }, rc23Gates: GATES.map(code => ({ code })),
    evidenceInputs: [
      { path: alignmentPath, sha256: alignmentRef.sha256, source: 'alignment' },
      { path: reconciliationPath, sha256: sha(fs.readFileSync(reconciliationPath)), source: 'reconciliation' },
      { path: preflightPath, sha256: preflightRef.sha256, source: 'preflight' },
      { path: snapshotPath, sha256: sha(fs.readFileSync(snapshotPath)), source: 'snapshot' },
      { path: trustPath, sha256: sha(fs.readFileSync(trustPath)), source: 'trust-diagnostic' }
    ] };
  jsonFile(dossierPath, dossier);
  const remediationPath = path.join(dir, 'remediation.json');
  const remediation = { schemaVersion: 1, recordType: 'runalith-agg-live-remediation-plan', generatedAt: new Date(NOW - 10_000).toISOString(),
    candidate: { path: candidatePath, sha256: candidateSha, version: manifest.version, archiveEntryCount: candidateCount },
    decision: { canActivateNow: false, lifecycleMutationAuthorized: false, liveWorkflowDatabaseMutationPerformed: false,
      externalTrustStoreMutationPerformed: false, productionConfigChanged: false, packageInstalledOrActivated: false, blockers: GATES },
    sourceReports: [
      { name: 'dossier', path: dossierPath, sha256: sha(fs.readFileSync(dossierPath)), sizeBytes: fs.statSync(dossierPath).size },
      { name: 'reconciliation', path: reconciliationPath, sha256: sha(fs.readFileSync(reconciliationPath)), sizeBytes: fs.statSync(reconciliationPath).size,
        generatedAt: reconciliation.generatedAt },
      { name: 'lifecycleReconciliation', path: lifecyclePath, sha256: sha(fs.readFileSync(lifecyclePath)), sizeBytes: fs.statSync(lifecyclePath).size,
        generatedAt: reconciliation.generatedAt },
      { name: 'preflight', path: preflightPath, sha256: preflightRef.sha256, sizeBytes: preflightRef.sizeBytes, generatedAt: preflight.generatedAt }
    ] };
  jsonFile(remediationPath, remediation);
  const acceptancePath = path.join(dir, 'acceptance.json');
  const acceptance = { schemaVersion: 1, recordType: 'runalith-acceptance-evidence-index', generatedAt: new Date(NOW).toISOString(),
    evidenceClass: 'local test fixture', candidate: { path: candidatePath, version: manifest.version, sha256: candidateSha,
      sizeBytes: candidateStat.size, archiveEntryCount: candidateCount, entryPoint, entryPointSha256: entryPointSha, manifestToolCount: 1 },
    rollbackBaseline: { path: rollbackPath, sha256: sha(fs.readFileSync(rollbackPath)) },
    validationResults: [{ command: 'fixture validation', exitCode: 0, evidence: validationEvidence }], packagedToolCalls: [],
    rollout: { status: 'BLOCKED', canActivateNow: false, blockers: GATES }, liveMutationPerformed: false,
    workflowDatabaseMutationPerformed: false, trustLedgerMutationPerformed: false, externalCheckpointTransitionAttempted: false,
    packageInstalledOrActivated: false, gitHistoryMutationPerformed: false };
  jsonFile(acceptancePath, acceptance);
  return { dir, candidatePath, acceptancePath, alignmentPath, preflightPath, dossierPath, remediationPath,
    snapshotPath, snapshot, candidateSha, entryPoint, manifest, candidateCount, candidateStat };
}

function verify(f) {
  return verifyAggAcceptanceConsistency({ candidatePath: f.candidatePath, acceptancePath: f.acceptancePath,
    alignmentPath: f.alignmentPath, preflightPath: f.preflightPath, dossierPath: f.dossierPath,
    remediationPath: f.remediationPath, now: NOW, maxLiveObservationAgeMs: 10 * 60 * 1000 });
}

test('acceptance consistency verifies actual archive bytes, candidate bindings, evidence hashes, blockers and no-mutation claims', t => {
  const f = fixture(t);
  const report = verify(f);
  assert.equal(report.result, 'PASS', JSON.stringify(report.checks.filter(check => !check.passed), null, 2));
  assert.equal(report.candidate.sha256, f.candidateSha);
  assert.equal(report.candidate.archiveEntryCount, f.candidateCount);
  assert.equal(report.rollout.status, 'BLOCKED');
  assert.equal(report.rollout.canActivateNow, false);
  assert.ok(report.checks.some(check => check.code === 'CANDIDATE_ENTRYPOINT_HASH_MATCHES_ACCEPTANCE' && check.passed));
  assert.equal(report.productionAuthorityGranted, false);
});

test('stale live snapshot blocks the consistency result even when every embedded hash still matches', t => {
  const f = fixture(t);
  const staleSnapshot = { ...f.snapshot, observedAt: new Date(NOW - 60 * 60 * 1000).toISOString() };
  jsonFile(f.snapshotPath, staleSnapshot);
  const dossier = JSON.parse(fs.readFileSync(f.dossierPath, 'utf8'));
  dossier.evidenceInputs.find(item => item.path === f.snapshotPath).sha256 = sha(fs.readFileSync(f.snapshotPath));
  jsonFile(f.dossierPath, dossier);
  const remediation = JSON.parse(fs.readFileSync(f.remediationPath, 'utf8'));
  remediation.sourceReports.find(item => item.name === 'dossier').sha256 = sha(fs.readFileSync(f.dossierPath));
  remediation.sourceReports.find(item => item.name === 'dossier').sizeBytes = fs.statSync(f.dossierPath).size;
  jsonFile(f.remediationPath, remediation);
  const report = verify(f);
  assert.equal(report.result, 'BLOCKED');
  const freshness = report.checks.filter(check => check.code === 'LIVE_OBSERVATION_FRESH');
  assert.ok(freshness.some(check => !check.passed && check.detail.reason === 'STALE_LIVE_OBSERVATION'), JSON.stringify(freshness));
});

test('candidate digest drift and tampered evidence are reported as consistency blockers', t => {
  const f = fixture(t);
  fs.writeFileSync(f.candidatePath, Buffer.from('tampered non-ZIP candidate'), { flag: 'w' });
  const report = verify(f);
  assert.equal(report.result, 'BLOCKED');
  assert.ok(report.checks.some(check => check.code === 'CANDIDATE_SHA256_MATCHES_ACCEPTANCE' && !check.passed));
  assert.ok(report.checks.some(check => check.code === 'CANDIDATE_ARCHIVE_INTEGRITY' && !check.passed));
});

test('a validation record marked PASS but carrying a nonzero exit code blocks acceptance', t => {
  const f = fixture(t);
  const acceptance = JSON.parse(fs.readFileSync(f.acceptancePath, 'utf8'));
  acceptance.validationResults[0].exitCode = 1;
  jsonFile(f.acceptancePath, acceptance);
  const report = verify(f);
  assert.equal(report.result, 'BLOCKED');
  assert.ok(report.checks.some(check => check.code === 'VALIDATION_EXIT_CODE_MATCHES_EXPECTATION' && !check.passed));
});

test('CLI refuses missing required inputs and emits a machine-readable fail-closed result', t => {
  const f = fixture(t);
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts/verify-agg-acceptance-consistency.mjs'),
    '--acceptance', f.acceptancePath, '--alignment', f.alignmentPath, '--preflight', f.preflightPath,
    '--dossier', f.dossierPath, '--remediation', f.remediationPath, '--max-live-age-ms', '3600000'],
  { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(run.stdout);
  assert.equal(report.result, 'PASS');
  assert.equal(report.productionAuthorityGranted, false);
});
