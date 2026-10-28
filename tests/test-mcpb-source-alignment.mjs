import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializePluginPackageMetadata } from '../scripts/plugin-package-metadata.mjs';
import { validateZipEntryTypes } from '../benchmarks/plugin-workflow-benchmark/phase2-zip-entry-type-safety.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verifier = path.join(repoRoot, 'scripts/verify-mcpb-source-alignment.mjs');

function runVerifier(bundle, sourceRoot, output) {
  const args = [verifier, '--bundle', bundle, '--source-root', sourceRoot];
  if (output) args.push('--output', output);
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

function writeFile(root, relative, contents) {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-source-alignment-'));
try {
  const sourceRoot = path.join(temp, 'source');
  const stage = path.join(temp, 'stage');
  const bundle = path.join(temp, 'candidate.mcpb');
  const report = path.join(temp, 'provenance.json');
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(stage);

  const sourcePackage = {
    name: 'test-package', version: '1.0.0', description: 'fixture', main: 'server/index.js', runtimeEntryPoint: 'server/index.js', type: 'module',
    engines: { node: '>=22.13.0' }, dependencies: { ignored: '1.0.0' },
  };
  const sourceManifest = { version: '1.0.0', server: { entry_point: 'server/index.js' }, tools: [{ name: 'test_tool', description: 'fixture' }] };
  writeFile(sourceRoot, 'package.json', `${JSON.stringify(sourcePackage, null, 2)}\n`);
  writeFile(sourceRoot, 'plugin/manifest.json', `${JSON.stringify(sourceManifest, null, 2)}\n`);
  writeFile(sourceRoot, 'README.md', 'fixture readme\n');
  writeFile(sourceRoot, 'LICENSE', 'fixture license\n');
  writeFile(sourceRoot, 'server/index.js', 'export const fixture = true;\n');
  writeFile(sourceRoot, 'src/runtime/example.js', 'export const exactSourceBytes = true;\n');
  writeFile(sourceRoot, 'link-to-server', 'server/index.js');
  for (const relative of [
    'scripts/package-runalith-mcpb.sh',
    'scripts/collect-plugin-runtime.mjs',
    'scripts/plugin-package-metadata.mjs',
    'scripts/verify-mcpb-source-alignment.mjs',
    'scripts/validate-agg-trust-config.mjs',
    'scripts/reconcile-active-workflows.mjs',
    'benchmarks/plugin-workflow-benchmark/phase2-zip-entry-type-safety.mjs',
    'tests/test-extracted-package-tool-schemas.mjs',
    'benchmarks/plugin-workflow-benchmark/phase1-protocol-runner.mjs',
    'benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v1.json',
    'benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v2.json',
    'docs/plugin-workflow-benchmark-plan.md',
    'scripts/replay-agg-phase1-finalization.mjs',
    'scripts/verify-agg-phase1-evidence-pack.mjs',
    'scripts/verify-agg-phase1-phase2-package-boundary.mjs',
    'scripts/test-mcpb-candidate.mjs',
    'src/runtime/strict-json.js',
    'src/runtime/adaptive-goal-trust-configuration.js',
    'tests/test-adaptive-goal-trust-configuration.mjs',
    'tests/test-adaptive-goal-trust-entrypoint.mjs',
    'tests/test-reconcile-active-workflows.mjs',
    'benchmarks/plugin-workflow-benchmark/phase2-inventory-diagnostics.mjs',
    'benchmarks/plugin-workflow-benchmark/create-phase2-candidate-inventory.mjs',
    'benchmarks/plugin-workflow-benchmark/test-create-phase2-candidate-inventory.mjs',
    'scripts/diagnose-phase2-archive-lineage.mjs',
    'tests/test-phase2-inventory-diagnostic-contract.mjs',
    'tests/test-adaptive-goal-execution-graph-proposal.js',
    'tests/test-agg-phase1-evidence-pack-verifier.mjs',
    'tests/test-agg-phase1-phase2-package-boundary.mjs',
    'tests/test-mcpb-source-alignment.mjs',
    'tests/test-plugin-workflow-benchmark-phase1-protocol.mjs',
    'scripts/lib/runalith-release-trust-contract.mjs',
    'scripts/lib/external-trust-checkpoint-contract.mjs',
    'scripts/lib/sqlite-external-checkpoint-transition.mjs',
    'tests/test-external-trust-checkpoint-contract.mjs',
    'scripts/verify-release-evidence.mjs',
    'scripts/lib/hosted-builder-attestation.mjs',
    'scripts/lib/hosted-verification-predicate.mjs',
    'scripts/lib/phase2-custody-evidence.mjs',
    'scripts/verify-phase2-custody-evidence.mjs',
    'tests/test-phase2-custody-evidence.mjs',
    'benchmarks/plugin-workflow-benchmark/create-phase2-candidate-inventory.mjs',
    'benchmarks/plugin-workflow-benchmark/test-create-phase2-candidate-inventory.mjs',
    'scripts/diagnose-phase2-archive-lineage.mjs',
    'tests/test-phase2-inventory-diagnostic-contract.mjs',
    'tests/test-adaptive-goal-execution-graph-proposal.js',
    'scripts/verify-hosted-builder-provenance.mjs',
    'scripts/create-hosted-candidate-verification-predicate.mjs',
    'scripts/runalith-hosted-build-policy.json',
    'scripts/runalith-rollout.mjs',
    'src/runtime/adaptive-goal-graph.js',
    'src/runtime/adaptive-goal-knowledge-store.js',
    'src/runtime/adaptive-goal-knowledge-verifier.js',
    'src/runtime/adaptive-goal-plan-adapter.js',
    'src/runtime/adaptive-goal-compatibility.js',
    'src/runtime/adaptive-goal-execution-readiness.js',
    'src/runtime/adaptive-goal-execution-graph-proposal.js',
    'src/runtime/adaptive-goal-execution-plan-candidate.js',
    'src/runtime/adaptive-goal-reviewed-task-inputs.js',
    'src/runtime/adaptive-goal-action-intent-policy.js',
    'src/runtime/adaptive-goal-reviewer-identity.js',
    'src/runtime/adaptive-goal-source-evidence.js',
    'src/runtime/adaptive-goal-evidence-lineage.js',
    'src/runtime/adaptive-goal-sandbox-executor.js',
    'tests/test-adaptive-goal-execution-graph-proposal.js',
    'tests/test-adaptive-goal-execution-plan-candidate.js',
    'tests/test-adaptive-goal-current-scope-producer-e2e.mjs',
    'tests/test-adaptive-goal-knowledge-verifier.mjs',
    'tests/test-adaptive-goal-reviewer-identity.js',
    'tests/test-adaptive-goal-evidence-lineage.js',
    'tests/test-runalith-release-trust-contract.mjs',
    'tests/test-hosted-builder-attestation.mjs',
    'tests/test-hosted-verification-predicate.mjs',
    'tests/test-runalith-hosted-workflows.mjs',
    'tests/test-runalith-rollout.mjs',
    '.github/workflows/runalith-provenance-builder.yml',
    '.github/workflows/runalith-provenance-verifier.yml',
    '.github/workflows/runalith-verification-attestation-signer.yml',
    'docs/runalith-provenance-release-trust-design.md',
    'docs/runalith-hosted-builder-pipeline.md',
    'docs/runalith-release-evidence-verifier.md',
    'docs/agg-production-trust-provisioning-runbook.md',
    'scripts/build-agg-readiness-dossier.mjs',
    'tests/test-agg-readiness-dossier.mjs',
    'tests/test-package-no-overwrite.js',
    'tests/test-adaptive-goal-benchmark-integrity.mjs',
    'tests/test-adaptive-goal-compatibility.js',
    'tests/test-adaptive-goal-knowledge-capture-mcp.mjs',
    'tests/test-adaptive-goal-knowledge-capture.mjs',
    'tests/test-adaptive-goal-knowledge-store.js',
    'tests/test-adaptive-goal-local-llm-failure.mjs',
    'tests/test-adaptive-goal-sandbox-executor.mjs',
    'tests/test-adaptive-goal-source-evidence.js',
    'docs/runalith-rollout-rc28-20261028.md',
    'docs/goal-plan-execution-acceptance-rc28-20261028.md',
  ]) {
    writeFile(sourceRoot, relative, fs.readFileSync(path.join(repoRoot, relative)));
  }

  for (const relative of ['README.md', 'LICENSE', 'server/index.js', 'src/runtime/example.js']) {
    writeFile(stage, relative, fs.readFileSync(path.join(sourceRoot, relative)));
  }
  writeFile(stage, 'manifest.json', fs.readFileSync(path.join(sourceRoot, 'plugin/manifest.json')));
  writeFile(stage, 'package.json', serializePluginPackageMetadata(sourcePackage));
  const entries = ['README.md', 'LICENSE', 'manifest.json', 'package.json', 'server/index.js', 'src/runtime/example.js'];
  execFileSync('zip', ['-X', '-q', bundle, ...entries], { cwd: stage });

  execFileSync('git', ['init', '-q'], { cwd: sourceRoot });
  execFileSync('git', ['add', '-A'], { cwd: sourceRoot });
  execFileSync('git', ['-c', 'user.name=Source Alignment Test', '-c', 'user.email=source-alignment@example.invalid',
    'commit', '-qm', 'fixture source baseline'], { cwd: sourceRoot });

  const pass = runVerifier(bundle, sourceRoot, report);
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /MCPB_SOURCE_ALIGNMENT=PASS/);
  assert.match(pass.stdout, /byte_identity=PASS_EXACT_ARCHIVE_ENTRY_BYTES/);
  assert.match(pass.stdout, /release_eligibility=BLOCKED_AUTHENTICATED_BUILD_RECEIPT_AND_INDEPENDENT_AUTHORITY_REQUIRED/);
  const evidence = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(evidence.status, 'PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT');
  assert.equal(evidence.byteIdentityStatus, 'PASS_EXACT_ARCHIVE_ENTRY_BYTES');
  assert.equal(evidence.sourceProvenanceStatus, 'CLEAN_GIT_TREE_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT');
  assert.equal(evidence.releaseEligibility, 'BLOCKED_AUTHENTICATED_BUILD_RECEIPT_AND_INDEPENDENT_AUTHORITY_REQUIRED',
    'exact byte alignment must not be presented as authenticated build provenance or release authority');
  assert.equal(evidence.bundlePathByteIdentityRecheckedAtCompletion, true,
    'reported bundle path must still contain the captured bytes after archive/source verification completes');
  assert.equal(evidence.archiveEntryCount, entries.length);
  assert.equal(evidence.manifestToolCount, 1);
  assert.ok(/^[a-f0-9]{64}$/.test(evidence.sourceSnapshotSha256));
  assert.equal(evidence.sourceGitState.trackedWorkingTreeClean, true);
  assert.equal(evidence.sourceGitState.workingTreeClean, true);
  assert.match(evidence.sourceGitState.trackedDiffSha256, /^[a-f0-9]{64}$/);
  assert.match(evidence.sourceGitState.workingTreeStatusSha256, /^[a-f0-9]{64}$/);
  assert.match(evidence.sourceProvenanceSha256, /^[a-f0-9]{64}$/);
  const releaseTrustInputs = [
    'scripts/lib/runalith-release-trust-contract.mjs',
    'scripts/verify-release-evidence.mjs',
    'scripts/lib/hosted-builder-attestation.mjs',
    'scripts/lib/hosted-verification-predicate.mjs',
    'scripts/lib/phase2-custody-evidence.mjs',
    'scripts/verify-phase2-custody-evidence.mjs',
    'tests/test-phase2-custody-evidence.mjs',
    'scripts/runalith-hosted-build-policy.json',
    'scripts/lib/external-trust-checkpoint-contract.mjs',
    'scripts/lib/sqlite-external-checkpoint-transition.mjs',
    'tests/test-external-trust-checkpoint-contract.mjs',
    'src/runtime/adaptive-goal-graph.js',
    'src/runtime/adaptive-goal-knowledge-store.js',
    'src/runtime/adaptive-goal-knowledge-verifier.js',
    'src/runtime/adaptive-goal-plan-adapter.js',
    'src/runtime/adaptive-goal-compatibility.js',
    'src/runtime/adaptive-goal-execution-readiness.js',
    'src/runtime/adaptive-goal-execution-graph-proposal.js',
    'src/runtime/adaptive-goal-execution-plan-candidate.js',
    'src/runtime/adaptive-goal-reviewed-task-inputs.js',
    'src/runtime/adaptive-goal-action-intent-policy.js',
    'src/runtime/adaptive-goal-reviewer-identity.js',
    'src/runtime/adaptive-goal-source-evidence.js',
    'src/runtime/adaptive-goal-evidence-lineage.js',
    'src/runtime/adaptive-goal-sandbox-executor.js',
    'tests/test-adaptive-goal-execution-graph-proposal.js',
    'tests/test-adaptive-goal-execution-plan-candidate.js',
    'tests/test-adaptive-goal-current-scope-producer-e2e.mjs',
    'tests/test-adaptive-goal-knowledge-verifier.mjs',
    'tests/test-adaptive-goal-reviewer-identity.js',
    'tests/test-adaptive-goal-evidence-lineage.js',
    '.github/workflows/runalith-provenance-builder.yml',
    '.github/workflows/runalith-provenance-verifier.yml',
    '.github/workflows/runalith-verification-attestation-signer.yml',
  ];
  const inputByPath = new Map(evidence.buildInputs.map(item => [item.sourcePath, item]));
  for (const relative of releaseTrustInputs) {
    assert.match(inputByPath.get(relative)?.sha256 || '', /^[a-f0-9]{64}$/,
      `release-critical trust policy/build input must be bound into the source snapshot: ${relative}`);
  }

  // Release policy/verifier code is not an archive entry, but it determines
  // how the archive may be accepted. Its byte changes must therefore change
  // the reconstructible source snapshot digest rather than escaping provenance.
  const policyRoot = path.join(temp, 'policy-input-drift-source');
  fs.cpSync(sourceRoot, policyRoot, { recursive: true });
  writeFile(policyRoot, 'scripts/lib/runalith-release-trust-contract.mjs',
    `${fs.readFileSync(path.join(policyRoot, 'scripts/lib/runalith-release-trust-contract.mjs'), 'utf8')}\n// policy-input drift fixture\n`);
  const policyDriftReportPath = path.join(temp, 'policy-input-drift-provenance.json');
  const policyDrift = runVerifier(bundle, policyRoot, policyDriftReportPath);
  assert.equal(policyDrift.status, 0, policyDrift.stderr);
  const policyDriftEvidence = JSON.parse(fs.readFileSync(policyDriftReportPath, 'utf8'));
  assert.notEqual(policyDriftEvidence.sourceSnapshotSha256, evidence.sourceSnapshotSha256,
    'source snapshot digest must change when release-critical verifier/policy bytes change, even if MCPB payload bytes do not');

  const custodyDriftRoot = path.join(temp, 'custody-input-drift-source');
  fs.cpSync(sourceRoot, custodyDriftRoot, { recursive: true });
  writeFile(custodyDriftRoot, 'scripts/lib/phase2-custody-evidence.mjs',
    `${fs.readFileSync(path.join(custodyDriftRoot, 'scripts/lib/phase2-custody-evidence.mjs'), 'utf8')}\n// custody-input drift fixture\n`);
  const custodyDriftReportPath = path.join(temp, 'custody-input-drift-provenance.json');
  const custodyDrift = runVerifier(bundle, custodyDriftRoot, custodyDriftReportPath);
  assert.equal(custodyDrift.status, 0, custodyDrift.stderr);
  const custodyDriftEvidence = JSON.parse(fs.readFileSync(custodyDriftReportPath, 'utf8'));
  assert.notEqual(custodyDriftEvidence.sourceSnapshotSha256, evidence.sourceSnapshotSha256,
    'source snapshot digest must bind the frozen-inventory custody contract, verifier and tests, not only generic release-trust code');

  const frozenGateDriftRoot = path.join(temp, 'frozen-gate-input-drift-source');
  fs.cpSync(sourceRoot, frozenGateDriftRoot, { recursive: true });
  writeFile(frozenGateDriftRoot, 'tests/test-phase2-inventory-diagnostic-contract.mjs',
    `${fs.readFileSync(path.join(frozenGateDriftRoot, 'tests/test-phase2-inventory-diagnostic-contract.mjs'), 'utf8')}\n// frozen-gate drift fixture\n`);
  const frozenGateDriftReportPath = path.join(temp, 'frozen-gate-input-drift-provenance.json');
  const frozenGateDrift = runVerifier(bundle, frozenGateDriftRoot, frozenGateDriftReportPath);
  assert.equal(frozenGateDrift.status, 0, frozenGateDrift.stderr);
  const frozenGateDriftEvidence = JSON.parse(fs.readFileSync(frozenGateDriftReportPath, 'utf8'));
  assert.notEqual(frozenGateDriftEvidence.sourceSnapshotSha256, evidence.sourceSnapshotSha256,
    'source snapshot digest must bind the frozen 71-path acceptance gate and its regression test');

  // A bundle that matches a modified source tree may still be byte-aligned,
  // but the provenance must not imply that the Git commit alone describes it.
  const dirtySourceBytes = 'export const fixture = "dirty but byte-aligned";\n';
  writeFile(sourceRoot, 'server/index.js', dirtySourceBytes);
  writeFile(stage, 'server/index.js', dirtySourceBytes);
  const dirtyBundle = path.join(temp, 'dirty-source-candidate.mcpb');
  execFileSync('zip', ['-X', '-q', dirtyBundle, ...entries], { cwd: stage });
  const dirtyReportPath = path.join(temp, 'dirty-source-provenance.json');
  const dirtyPass = runVerifier(dirtyBundle, sourceRoot, dirtyReportPath);
  assert.equal(dirtyPass.status, 0, dirtyPass.stderr);
  assert.match(dirtyPass.stdout, /source_provenance=DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT/);
  const dirtyEvidence = JSON.parse(fs.readFileSync(dirtyReportPath, 'utf8'));
  assert.equal(dirtyEvidence.status, 'PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT');
  assert.equal(dirtyEvidence.byteIdentityStatus, 'PASS_EXACT_ARCHIVE_ENTRY_BYTES');
  assert.equal(dirtyEvidence.sourceProvenanceStatus, 'DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT');
  assert.equal(dirtyEvidence.releaseEligibility, 'BLOCKED_AUTHENTICATED_BUILD_RECEIPT_AND_INDEPENDENT_AUTHORITY_REQUIRED');
  assert.equal(dirtyEvidence.sourceGitState.trackedWorkingTreeClean, false);
  assert.equal(dirtyEvidence.sourceGitState.workingTreeClean, false);
  assert.notEqual(dirtyEvidence.sourceGitState.trackedDiffSha256, evidence.sourceGitState.trackedDiffSha256);
  assert.notEqual(dirtyEvidence.sourceSnapshotSha256, evidence.sourceSnapshotSha256,
    'content snapshot digest must change when packaged source bytes change');
  assert.notEqual(dirtyEvidence.sourceProvenanceSha256, evidence.sourceProvenanceSha256,
    'source provenance digest must additionally bind dirty Git state');

  // Duplicate object members must not be silently resolved by JSON.parse:
  // distinct parsers must agree on the exact manifest/package values that
  // were approved and shipped in the archive.
  const duplicateManifestRoot = path.join(temp, 'duplicate-manifest-source');
  fs.cpSync(sourceRoot, duplicateManifestRoot, { recursive: true });
  writeFile(duplicateManifestRoot, 'plugin/manifest.json',
    '{"server":{"entry_point":"server/index.js"},"server":{"entry_point":"server/index.js"},"tools":[{"name":"test_tool","description":"fixture"}]}\n');
  const duplicateManifest = runVerifier(bundle, duplicateManifestRoot);
  assert.notEqual(duplicateManifest.status, 0, 'duplicate keys in the source manifest must fail closed');
  assert.match(duplicateManifest.stderr, /duplicate-free strict JSON/);

  const duplicatePackageRoot = path.join(temp, 'duplicate-package-source');
  fs.cpSync(sourceRoot, duplicatePackageRoot, { recursive: true });
  writeFile(duplicatePackageRoot, 'package.json',
    '{"name":"test-package","name":"attacker-package","version":"1.0.0","description":"fixture","main":"server/index.js","type":"module"}\n');
  const duplicatePackage = runVerifier(bundle, duplicatePackageRoot);
  assert.notEqual(duplicatePackage.status, 0, 'duplicate keys in build metadata must fail closed');
  assert.match(duplicatePackage.stderr, /duplicate-free strict JSON/);

  const bundleSymlink = path.join(temp, 'candidate-link.mcpb');
  fs.symlinkSync(bundle, bundleSymlink);
  assert.notEqual(runVerifier(bundleSymlink, sourceRoot).status, 0, 'candidate pathname symlinks must fail closed');

  // A ZIP symlink can contain the literal link target as its payload. Even if
  // those bytes match the source file, the archive entry must be rejected.
  fs.symlinkSync('server/index.js', path.join(stage, 'link-to-server'));
  const symlinkBundle = path.join(temp, 'symlink.mcpb');
  execFileSync('zip', ['-X', '-y', '-q', symlinkBundle, ...entries, 'link-to-server'], { cwd: stage });
  const symlinkResult = runVerifier(symlinkBundle, sourceRoot);
  assert.notEqual(symlinkResult.status, 0, 'symlink entries must fail before source byte comparison');
  assert.match(symlinkResult.stderr, /symlink or special entry/);
  fs.unlinkSync(path.join(stage, 'link-to-server'));

  const ambiguityStage = path.join(temp, 'ambiguity-stage');
  fs.mkdirSync(ambiguityStage);
  writeFile(ambiguityStage, 'first.txt', 'first payload\n');
  writeFile(ambiguityStage, 'other.txt', 'other payload\n');
  const ambiguityBundle = path.join(temp, 'zip-two-entries.zip');
  execFileSync('zip', ['-X', '-q', ambiguityBundle, 'first.txt', 'other.txt'], { cwd: ambiguityStage });
  const ambiguityBytes = fs.readFileSync(ambiguityBundle);
  const ambiguityEocd = ambiguityBytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(ambiguityEocd >= 0, 'two-entry fixture must contain EOCD');
  let ambiguityCursor = ambiguityBytes.readUInt32LE(ambiguityEocd + 16);
  const ambiguityRows = [];
  for (let i = 0; i < ambiguityBytes.readUInt16LE(ambiguityEocd + 10); i += 1) {
    assert.equal(ambiguityBytes.readUInt32LE(ambiguityCursor), 0x02014b50);
    const nameLength = ambiguityBytes.readUInt16LE(ambiguityCursor + 28);
    const extraLength = ambiguityBytes.readUInt16LE(ambiguityCursor + 30);
    const commentLength = ambiguityBytes.readUInt16LE(ambiguityCursor + 32);
    ambiguityRows.push({
      cursor: ambiguityCursor,
      name: ambiguityBytes.subarray(ambiguityCursor + 46, ambiguityCursor + 46 + nameLength).toString('utf8'),
      nameLength,
      localOffset: ambiguityBytes.readUInt32LE(ambiguityCursor + 42)
    });
    ambiguityCursor += 46 + nameLength + extraLength + commentLength;
  }
  const firstRow = ambiguityRows.find(row => row.name === 'first.txt');
  const otherRow = ambiguityRows.find(row => row.name === 'other.txt');
  assert.ok(firstRow && otherRow && firstRow.nameLength === otherRow.nameLength);
  const localCentralMismatch = Buffer.from(ambiguityBytes);
  Buffer.from(firstRow.name, 'utf8').copy(localCentralMismatch, otherRow.localOffset + 30);
  assert.throws(() => validateZipEntryTypes(localCentralMismatch), /local\/central filenames disagree/);
  const duplicateNameZip = Buffer.from(ambiguityBytes);
  Buffer.from(firstRow.name, 'utf8').copy(duplicateNameZip, otherRow.localOffset + 30);
  Buffer.from(firstRow.name, 'utf8').copy(duplicateNameZip, otherRow.cursor + 46);
  assert.throws(() => validateZipEntryTypes(duplicateNameZip), /duplicate entry name/);

  const reportBefore = fs.readFileSync(report);
  const overwrite = runVerifier(bundle, sourceRoot, report);
  assert.notEqual(overwrite.status, 0, 'existing provenance reports must not be overwritten');
  assert.deepEqual(fs.readFileSync(report), reportBefore);

  fs.writeFileSync(path.join(sourceRoot, 'server/index.js'), 'changed source bytes\n');
  const mismatch = runVerifier(bundle, sourceRoot);
  assert.notEqual(mismatch.status, 0, 'source drift must reject the stale MCPB');
  assert.match(mismatch.stderr, /source\/archive byte mismatch for server\/index.js/);

  console.log('MCPB source-to-binary alignment verification PASS (byte identity, provenance hash, no-overwrite report, drift rejection)');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
