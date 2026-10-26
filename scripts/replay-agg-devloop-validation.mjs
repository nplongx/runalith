#!/usr/bin/env node
// Replays current-source AGG/evidence validation from a separately extracted
// development evidence pack. This is byte/runtime regression evidence only;
// it never opens the official Phase 1 gate or promotes claims/attestations.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { searchAdaptiveGoalGraph } from '../src/runtime/adaptive-goal-graph.js';
import { resolveAdaptiveGoalSourceEvidence } from '../src/runtime/adaptive-goal-source-evidence.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
if (argv[0] !== '--dev-only-not-acceptance' || !argv[1] || argv.length !== 2 ||
    process.env.RUNALITH_EVIDENCE_REPLAY_EXTRACTED_ROOT !== '1') {
  console.error('Usage: RUNALITH_EVIDENCE_REPLAY_EXTRACTED_ROOT=1 node scripts/replay-agg-devloop-validation.mjs --dev-only-not-acceptance artifacts/phase1-dev-only/devloop-validation-<timestamp> (run only from a fresh extracted pack without .git or dist/)');
  process.exit(2);
}
assert.equal(fs.existsSync(path.join(root, '.git')), false, 'replay root must not be the source checkout');
assert.equal(fs.existsSync(path.join(root, 'dist')), false, 'replay root must not depend on dist/');

const validationDir = path.resolve(root, argv[1]);
const allowedRoot = path.join(root, 'artifacts/phase1-dev-only');
assert.ok(validationDir.startsWith(`${allowedRoot}${path.sep}`), 'validation evidence must stay under artifacts/phase1-dev-only');
assert.equal(fs.realpathSync(validationDir), validationDir, 'validation directory must be canonical and not a symlink');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const digestFile = file => hash(fs.readFileSync(file));

function run(command, args, { env = process.env, timeout = 90_000, maxBuffer = 24 * 1024 * 1024 } = {}) {
  return spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout, maxBuffer, env });
}
function runPassing(label, command, args, options = {}) {
  const result = run(command, args, options);
  assert.equal(result.error, undefined, `${label}: process error ${result.error?.message}`);
  assert.equal(result.status, 0, `${label} exited ${result.status ?? result.signal}\nstdout=${(result.stdout || '').slice(-8000)}\nstderr=${(result.stderr || '').slice(-8000)}`);
  return { label, command: [command, ...args], exitCode: result.status, stdoutSha256: hash(Buffer.from(result.stdout || '')),
    stderrSha256: hash(Buffer.from(result.stderr || '')), stdoutBytes: Buffer.byteLength(result.stdout || ''), stderrBytes: Buffer.byteLength(result.stderr || '') };
}

const checks = [];
const sourceResolution = readJson(path.join(validationDir, 'source-evidence-resolution-v5.json'));
assert.equal(sourceResolution.referenceCount, 14);
assert.equal(sourceResolution.records.length, 14);
const resolvedSources = resolveAdaptiveGoalSourceEvidence(sourceResolution.records.map(record => record.reference), { root: fs.realpathSync(root) });
assert.equal(resolvedSources.length, 14);
assert.equal(resolvedSources.filter(record => record.integrityVerified).length, 14, 'all pinned source bytes should reproduce from extracted pack');
assert.equal(resolvedSources.filter(record => record.claimVerified === true).length, 0);
assert.equal(resolvedSources.filter(record => record.independenceVerified === true).length, 0);
for (let i = 0; i < resolvedSources.length; i++) {
  const before = sourceResolution.records.find(item => item.reference === resolvedSources[i].reference);
  assert.ok(before, `source evidence ref ${resolvedSources[i].reference} was not declared`);
  for (const field of ['classification', 'integrityVerified', 'claimVerified', 'independenceVerified', 'path', 'expectedSha256', 'observedSha256', 'sizeBytes']) {
    assert.equal(resolvedSources[i][field], before[field], `source resolver replay changed ${field} for ${before.reference}`);
  }
}
checks.push({ label: 'source-evidence-byte-resolution', count: 14, integrityVerified: 14, claimVerified: 0, independenceVerified: 0,
  sourceResolverSha256: digestFile(path.join(root, 'src/runtime/adaptive-goal-source-evidence.js')) });

const officialCandidateRelative = 'artifacts/runalith-1.0.9-rc.5-candidate-latest-build-20261022T175328+0700.mcpb';
const officialCandidatePath = path.join(root, officialCandidateRelative);
const officialCandidateSha = digestFile(officialCandidatePath);
assert.equal(officialCandidateSha, '9d836dca9daec26b53a104f99028fb30fd11848e8c0a8764c4eb7dedd45e1c37', 'official target reference unexpectedly changed');
const officialSidecar = fs.readFileSync(`${officialCandidatePath}.sha256`, 'utf8').trim().split(/\s+/);
assert.equal(officialSidecar[0], officialCandidateSha);
assert.equal(officialSidecar[1], path.basename(officialCandidatePath));
checks.push({ label: 'official-target-reference-integrity', candidateSha256: officialCandidateSha,
  candidateBytes: fs.statSync(officialCandidatePath).size, sidecarVerified: true, promotionOrSubstitution: false });

const devPackageRecord = readJson(path.join(validationDir, 'dev-only-candidate-package-record-v2.json'));
const devCandidatePath = path.resolve(root, devPackageRecord.candidate.path);
assert.ok(devCandidatePath.startsWith(`${allowedRoot}${path.sep}`), 'dev-only package must stay inside non-release evidence directory');
assert.equal(digestFile(devCandidatePath), devPackageRecord.candidate.sha256);
assert.equal(fs.statSync(devCandidatePath).size, devPackageRecord.candidate.bytes);
const devSidecarPath = `${devCandidatePath}.sha256`;
assert.ok(fs.existsSync(devSidecarPath), 'dev-only candidate sidecar is missing');
const devSidecar = fs.readFileSync(devSidecarPath, 'utf8').trim().split(/\s+/);
assert.equal(devSidecar[0], devPackageRecord.candidate.sha256);
assert.equal(devSidecar[1], path.basename(devCandidatePath));
const manifestBytes = execFileSync('unzip', ['-p', devCandidatePath, 'manifest.json']);
const serverBytes = execFileSync('unzip', ['-p', devCandidatePath, 'server/index.js']);
const packagedGraphBytes = execFileSync('unzip', ['-p', devCandidatePath, 'src/runtime/adaptive-goal-graph.js']);
assert.equal(hash(manifestBytes), devPackageRecord.candidate.manifestSha256);
assert.equal(hash(serverBytes), devPackageRecord.candidate.packagedServerSha256);
assert.equal(hash(packagedGraphBytes), devPackageRecord.candidate.packagedAdaptiveGoalGraphSha256);
assert.equal(devPackageRecord.candidate.zipEntryCount, 76);
assert.equal(devPackageRecord.candidate.manifestToolCount, 67);
assert.notEqual(devPackageRecord.candidate.sha256, officialCandidateSha, 'dev-only package must never be relabelled as the official target');
checks.push({ label: 'development-package-target-integrity', candidateSha256: devPackageRecord.candidate.sha256,
  candidateBytes: devPackageRecord.candidate.bytes, manifestSha256: hash(manifestBytes), serverSha256: hash(serverBytes),
  packedGraphSha256: hash(packagedGraphBytes), manifestTools: 67, archiveEntries: 76, devOnlyNotAcceptance: true });

const rpcEvidencePath = path.join(validationDir, 'packaged-agg-evidence-rpc-v2.json');
const rpcEvidenceBytes = fs.readFileSync(rpcEvidencePath);
const rpcEvidence = JSON.parse(rpcEvidenceBytes.toString('utf8'));
assert.equal(rpcEvidence.source.candidateSha256, devPackageRecord.candidate.sha256);
assert.equal(rpcEvidence.devOnlyNotAcceptance, true);
assert.equal(rpcEvidence.officialAcceptanceEligible, false);
assert.deepEqual(rpcEvidence.caseResults.map(item => item.label), ['exact_source_hash', 'stale_source_hash', 'unresolved_durable_artifact']);
assert.equal(rpcEvidence.caseResults.length, 3);
for (const item of rpcEvidence.caseResults) {
  assert.equal(item.result.graphHash, item.result.candidateEvidenceAssessments[0].targetBinding.graphHash);
  assert.equal(item.result.candidates[0].planId, item.result.candidateEvidenceAssessments[0].targetBinding.candidatePlanId);
  assert.equal(item.result.candidates[0].verification.verified, false);
  assert.equal(item.result.candidates[0].evidence.verifiedReferenceCount, 0);
  assert.equal(item.result.candidates[0].evidence.coverage, 0);
  assert.equal(item.result.candidateEvidenceAssessments[0].claimCoverage, 0);
  assert.equal(item.result.candidateEvidenceAssessments[0].independentAttestationCoverage, 0);
  assert.equal(item.result.candidateEvidenceAssessments[0].candidateVerified, false);
}
const [exact, stale, unresolved] = rpcEvidence.caseResults;
assert.equal(exact.result.candidateEvidenceAssessments[0].sourceIntegrityVerifiedCount, 1);
assert.equal(exact.result.candidateEvidenceAssessments[0].sourceIntegrityCoverage, 1);
assert.equal(stale.result.candidateEvidenceAssessments[0].sourceIntegrityVerifiedCount, 0);
assert.equal(stale.result.candidateEvidenceAssessments[0].invalidProvenanceCount, 1);
assert.equal(stale.result.candidateEvidenceAssessments[0].resolutions[0].status, 'source_hash_mismatch_or_stale');
assert.equal(unresolved.result.candidateEvidenceAssessments[0].unresolvedReferenceCount, 1);
assert.equal(unresolved.result.candidateEvidenceAssessments[0].referenceResolutionCoverage, 0);
assert.equal(unresolved.result.candidateEvidenceAssessments[0].resolutions[0].classification, 'durable_artifact_unverified');
assert.equal(unresolved.result.candidateEvidenceAssessments[0].resolutions[0].resolverClassification, 'not_content_addressed');
assert.equal(rpcEvidence.finalDatabaseAssertions.jobs, 0);
assert.equal(rpcEvidence.finalDatabaseAssertions.tasks, 0);
assert.equal(rpcEvidence.finalDatabaseAssertions.approvals, 0);
assert.equal(rpcEvidence.finalDatabaseAssertions.workflowPlans, 0);
assert.equal(rpcEvidence.finalDatabaseAssertions.executionBatches, 0);
assert.equal(rpcEvidence.finalDatabaseAssertions.workflowCreated, false);
assert.equal(rpcEvidence.finalDatabaseAssertions.approved, false);
assert.equal(rpcEvidence.finalDatabaseAssertions.dispatched, false);
assert.equal(rpcEvidence.finalDatabaseAssertions.actionsExecuted, false);
checks.push({ label: 'actual-packaged-mcp-agg-evidence-rpc', cases: rpcEvidence.caseResults.map(item => ({
  label: item.label, graphHash: item.result.graphHash, planId: item.result.candidates[0].planId,
  resolutionCoverage: item.result.candidateEvidenceAssessments[0].referenceResolutionCoverage,
  claimCoverage: item.result.candidateEvidenceAssessments[0].claimCoverage,
  independentAttestationCoverage: item.result.candidateEvidenceAssessments[0].independentAttestationCoverage
})), rpcTranscriptRecords: rpcEvidence.rpcTranscript.length, rawEvidenceSha256: hash(rpcEvidenceBytes), databaseEffects: false });

for (const [filename, wantedStatus, wantedCandidates] of [
  ['agg-search-round14-phase2-extracted-source-lineage-result.json', 'proposals_found', 1],
  ['agg-search-round15-official-phase1-prerequisites-result.json', 'no_solution_found', 0]
]) {
  const saved = readJson(path.join(validationDir, filename));
  const coreSha = digestFile(path.join(root, 'src/runtime/adaptive-goal-graph.js'));
  assert.equal(saved.sourceModuleSha256, coreSha, `AGG core changed since ${filename} was recorded`);
  const reproduced = searchAdaptiveGoalGraph(saved.input, saved.result.search.options);
  assert.deepEqual(reproduced, saved.result, `AGG search result did not reproduce exactly: ${filename}`);
  assert.equal(reproduced.status, wantedStatus);
  assert.equal(reproduced.candidates.length, wantedCandidates);
  if (filename.startsWith('agg-search-round14')) {
    assert.equal(reproduced.candidates[0].verification.verified, false);
    assert.equal(reproduced.candidates[0].evidence.coverage, 0);
  } else {
    assert.equal(reproduced.search.exhaustive, true);
    assert.equal(reproduced.bestPartialCandidates.length, 1);
  }
  checks.push({ label: `deterministic-${filename}`, graphHash: reproduced.graphHash, status: reproduced.status,
    expansions: reproduced.search.expansions, exhaustive: reproduced.search.exhaustive, candidateCount: reproduced.candidates.length,
    evidenceCoverage: reproduced.candidates[0]?.evidence.coverage ?? null });
}

const readiness = readJson(path.join(validationDir, 'phase1-readiness.json'));
assert.equal(readiness.decision, 'BLOCKED_NO_TRUSTED_CORPUS_OR_REAL_AB_RUNS');
assert.equal(readiness.sourceProtocol.targetBinding.candidateBundleSha256, officialCandidateSha);
assert.equal(readiness.sourceProtocol.targetBinding.executionGateOpen, false);
assert.equal(readiness.sourceProtocol.targetBinding.releaseApproved, false);
assert.equal(readiness.acceptanceGates.protectedTrustAnchorConfigAvailable, false);
assert.equal(readiness.acceptanceGates.exactTargetIndependentReviewAttestationSuppliedToReadiness, false);
assert.equal(readiness.acceptanceGates.freshExactScopeOperationalAuthorizationSuppliedToReadiness, false);
assert.equal(readiness.acceptanceGates.trustedOwnerCorpusAttestationAndPairedOperationalRunsSuppliedToReadiness, false);
assert.equal(readiness.acceptanceGates.independentEvaluatorAttestationAndAcceptedRunLedgerSuppliedToReadiness, false);
checks.push({ label: 'official-readiness-stays-fail-closed', decision: readiness.decision, executionGateOpen: false, releaseApproved: false, realOperationalPairs: 0 });

const phase2Diagnostic = readJson(path.join(validationDir, 'phase2-inventory-contract-diagnostic-v2.json'));
assert.equal(phase2Diagnostic.expectedPhase2EntryCount, 71);
assert.equal(phase2Diagnostic.observedEntryCount, 76);
assert.equal(phase2Diagnostic.officialPhase2GateStatus, 'FAIL');
assert.equal(phase2Diagnostic.currentSourceCandidateAttempt.reachedEntryCountAssertion, true);
const phase2InventoryPath = path.join(root, 'benchmarks/plugin-workflow-benchmark', `.replay-inventory-${process.pid}.json`);
assert.equal(fs.existsSync(phase2InventoryPath), false, 'refusing to overwrite a pre-existing replay inventory');
let phase2Inventory;
let phase2InventoryBytes;
try {
  const buildInventory = run(process.execPath, ['benchmarks/plugin-workflow-benchmark/create-phase2-candidate-inventory.mjs',
    path.relative(root, devCandidatePath), path.relative(root, phase2InventoryPath)], { timeout: 30_000 });
  assert.equal(buildInventory.status, 0, `Phase 2 source/archive byte-lineage inventory did not build on extracted files: ${buildInventory.stderr}`);
  phase2InventoryBytes = fs.readFileSync(phase2InventoryPath);
  phase2Inventory = JSON.parse(phase2InventoryBytes.toString('utf8'));
  assert.equal(phase2Inventory.entries.length, 76);
  assert.equal(phase2Inventory.bundle.sha256, devPackageRecord.candidate.sha256);
  assert.equal(phase2Inventory.source_tree.git_head, null);
  assert.equal(phase2Inventory.source_tree.working_tree_dirty, null,
    'missing git metadata must not be misrepresented as a clean worktree');
  assert.equal(phase2Inventory.source_tree.git_metadata_status, 'unavailable_no_git_metadata');
} finally {
  fs.rmSync(phase2InventoryPath, { force: true });
}
checks.push({ label: 'phase2-extracted-source-byte-lineage-with-explicit-no-git-state', entryCount: phase2Inventory.entries.length,
  bundleSha256: phase2Inventory.bundle.sha256, packagedSourceInventorySha256: phase2Inventory.source_tree.packaged_source_inventory_sha256,
  gitHead: null, workingTreeDirty: null, gitMetadataStatus: phase2Inventory.source_tree.git_metadata_status,
  inventoryJsonSha256: hash(phase2InventoryBytes), inventoryFileRemovedAfterCheck: !fs.existsSync(phase2InventoryPath) });
const phase2Command = run(process.execPath, ['benchmarks/plugin-workflow-benchmark/test-create-phase2-candidate-inventory.mjs'], {
  env: { ...process.env, PHASE2_CANDIDATE_BUNDLE: path.relative(root, devCandidatePath) }, timeout: 30_000
});
assert.equal(phase2Command.status, 1, `Phase 2 inventory should preserve its 71-entry contract against the 76-entry dev package; stdout=${phase2Command.stdout}\nstderr=${phase2Command.stderr}`);
assert.match(phase2Command.stderr, /76 !== 71/);
assert.doesNotMatch(phase2Command.stderr, /source\/archive bytes differ for manifest\.json/,
  'a current-source package should get past source/archive lineage and fail at the distinct entry-count contract');
assert.match(phase2Command.stderr, /current packaged runtime closure|71 entries|76 !== 71/i);
checks.push({ label: 'phase2-inventory-remains-blocked-at-separate-contract', exitCode: phase2Command.status,
  expectedEntries: 71, actualEntries: 76, stderrSha256: hash(Buffer.from(phase2Command.stderr)),
  diagnosis: 'all historical dist candidates are stale at manifest bytes; current source candidate passes byte lineage and then fails the unchanged entry-count contract' });

checks.push(runPassing('focused-agg-source-lineage-tests', process.execPath, ['--test',
  'tests/test-adaptive-goal-graph.js', 'tests/test-adaptive-goal-source-evidence.js', 'tests/test-adaptive-goal-evidence-lineage.js']));
checks.push(runPassing('candidate-no-install-smoke', process.execPath,
  ['scripts/test-mcpb-candidate.mjs', path.relative(root, devCandidatePath)], { timeout: 45_000 }));
checks.push(runPassing('actual-packaged-agg-evidence-rpc-replay', process.execPath,
  ['tests/test-dev-only-mcpb-agg-evidence-assessment.mjs', '--dev-only-not-acceptance', path.relative(root, devCandidatePath)], { timeout: 45_000 }));

const report = {
  schemaVersion: 1,
  replayedAt: new Date().toISOString(),
  developmentOnly: true,
  officialAcceptanceEligible: false,
  extractedRoot: root,
  validationDirectory: path.relative(root, validationDir),
  officialTargetSha256: officialCandidateSha,
  developmentPackageSha256: devPackageRecord.candidate.sha256,
  replayedFromExtractedPackOnly: true,
  replayClassification: {
    sourceHashes: 'byte integrity only; claim truth and independence remain unverified',
    actualMcpCalls: 'replayed against the packaged candidate in disposable temporary DB/workspace',
    aggs: 'deterministic from exact graph inputs and recorded options; all proposed candidates remain unverified',
    phase1Readiness: 'source evidence only; external trusted corpus/review/authorization/isolator/evaluator attestations are not synthesized'
  },
  checks,
  passCount: checks.length,
  failureCount: 0,
  phase1Decision: readiness.decision,
  operationalPairs: 0,
  phase2Inventory: { expectedEntries: 71, observedEntries: 76, status: 'FAIL', gateChanged: false, distChanged: false }
};
console.log(JSON.stringify(report, null, 2));
