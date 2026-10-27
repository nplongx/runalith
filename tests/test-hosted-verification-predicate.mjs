import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  RUNALITH_EXPECTED_BUILDER_ID, RUNALITH_GITHUB_ACTIONS_BUILD_TYPE, RUNALITH_HOSTED_BUILD_OIDC_ISSUER,
  RUNALITH_HOSTED_BUILD_REPOSITORY, RUNALITH_HOSTED_BUILD_WORKFLOW, RUNALITH_SLSA_PREDICATE
} from '../scripts/lib/hosted-builder-attestation.mjs';
import {
  RUNALITH_HOSTED_CANDIDATE_VERIFICATION_PREDICATE, RUNALITH_HOSTED_REQUIRED_TESTS,
  createRunalithHostedCandidateVerificationPredicate, validateRunalithHostedBuildPolicy
} from '../scripts/lib/hosted-verification-predicate.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const policyPath = path.join(root, 'scripts/runalith-hosted-build-policy.json');
const policyBytes = fs.readFileSync(policyPath);
const policy = JSON.parse(policyBytes.toString('utf8'));
const candidateBytes = Buffer.from('test-only candidate bytes; never a Runalith release');
const sha = value => createHash('sha256').update(value).digest('hex');
const candidateSha256 = sha(candidateBytes);
const sourceCommit = 'a'.repeat(40);
const sourceSnapshotSha256 = 'b'.repeat(64);

function alignment(overrides = {}) {
  return {
    status: 'PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT',
    sourceProvenanceStatus: 'CLEAN_GIT_TREE_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT',
    releaseEligibility: 'BLOCKED_AUTHENTICATED_BUILD_RECEIPT_AND_INDEPENDENT_AUTHORITY_REQUIRED',
    sourceGitHead: sourceCommit,
    sourceGitState: { workingTreeClean: true, trackedWorkingTreeClean: true },
    bundleSha256: candidateSha256,
    sourceSnapshotSha256,
    archiveEntryCount: 2,
    sourceEntries: [
      { archivePath: 'manifest.json', sizeBytes: 100, sha256: 'c'.repeat(64) },
      { archivePath: 'server/index-v1.0.9-rc.11.js', sizeBytes: 200, sha256: 'd'.repeat(64) }
    ],
    ...overrides
  };
}

function fixtures(overrides = {}) {
  const builderSourceAlignment = alignment();
  const independentSourceAlignment = alignment();
  return {
    candidateBytes,
    policyBytes,
    policy,
    builderVerification: {
      status: 'HOSTED_BUILDER_PROVENANCE_VERIFIED',
      candidateSha256,
      sourceCommit,
      repository: RUNALITH_HOSTED_BUILD_REPOSITORY,
      signerWorkflow: RUNALITH_HOSTED_BUILD_WORKFLOW,
      oidcIssuer: RUNALITH_HOSTED_BUILD_OIDC_ISSUER,
      predicateType: RUNALITH_SLSA_PREDICATE,
      buildType: RUNALITH_GITHUB_ACTIONS_BUILD_TYPE,
      expectedBuilderId: RUNALITH_EXPECTED_BUILDER_ID,
      builderAttestationBundleSha256: sha(Buffer.from('builder attestation bundle bytes')),
      productionReleaseEligible: false
    },
    builderSourceAlignment,
    independentRebuild: {
      contract: 'runalith-independent-rebuild/v1', status: 'PASS_BYTE_IDENTICAL', sourceCommit,
      candidateSha256, independentlyRebuiltSha256: candidateSha256,
      candidateBytes: candidateBytes.length, independentlyRebuiltBytes: candidateBytes.length,
      sourceCheckout: 'exact workflow_run.head_sha', productionReleaseEligible: false
    },
    independentSourceAlignment,
    evidenceDigests: {
      builder_attestation_bundle_sha256: sha(Buffer.from('builder attestation bundle bytes')),
      builder_verification_report_sha256: 'e'.repeat(64),
      builder_source_alignment_sha256: 'f'.repeat(64),
      independent_rebuild_report_sha256: '1'.repeat(64),
      independent_source_alignment_sha256: '2'.repeat(64)
    },
    ...overrides
  };
}

test('emits a candidate-bound, inventory-bound hosted-verifier predicate with the fixed required check set', () => {
  const predicate = createRunalithHostedCandidateVerificationPredicate(fixtures());
  assert.equal(predicate.result, 'PASS');
  assert.equal(predicate.candidate_sha256, candidateSha256);
  assert.equal(predicate.source_snapshot_sha256, sourceSnapshotSha256);
  assert.equal(predicate.policy_sha256, sha(policyBytes));
  assert.equal(predicate.source_alignment.status, 'PASS');
  assert.equal(predicate.source_alignment.candidate_sha256, candidateSha256);
  assert.equal(predicate.tests.length, RUNALITH_HOSTED_REQUIRED_TESTS.length);
  assert.deepEqual(predicate.tests.map(item => item.name), [...RUNALITH_HOSTED_REQUIRED_TESTS]);
  assert.ok(predicate.tests.every(item => item.status === 'PASS' && item.exit_code === 0 && item.candidate_sha256 === candidateSha256));
});

test('rejects weakened policy test sets and trust-boundary flags', () => {
  assert.doesNotThrow(() => validateRunalithHostedBuildPolicy(policy));
  const weakened = { ...policy, required_tests: policy.required_tests.slice(1) };
  assert.throws(() => validateRunalithHostedBuildPolicy(weakened), error => error.code === 'HOSTED_VERIFICATION_POLICY_INVALID');
  const production = { ...policy, target_environment: 'production' };
  assert.throws(() => validateRunalithHostedBuildPolicy(production), error => error.code === 'HOSTED_VERIFICATION_POLICY_INVALID');
  const rollbackFlag = { ...policy, rollback_must_match_observed_baseline_bytes: false };
  assert.throws(() => validateRunalithHostedBuildPolicy(rollbackFlag), error => error.code === 'HOSTED_VERIFICATION_POLICY_INVALID');
});

test('rejects candidate substitution, stale/mismatched source snapshot and a non-identical independent rebuild', () => {
  assert.throws(() => createRunalithHostedCandidateVerificationPredicate(fixtures({
    candidateBytes: Buffer.from('substituted candidate')
  })), error => error.code === 'HOSTED_VERIFICATION_SOURCE_OR_BUILDER_BINDING_MISMATCH');

  const wrongSource = fixtures({ independentSourceAlignment: alignment({ sourceGitHead: 'f'.repeat(40) }) });
  assert.throws(() => createRunalithHostedCandidateVerificationPredicate(wrongSource),
    error => error.code === 'HOSTED_VERIFICATION_SOURCE_OR_BUILDER_BINDING_MISMATCH');

  const nonReproducible = fixtures({ independentRebuild: { ...fixtures().independentRebuild,
    independentlyRebuiltSha256: 'e'.repeat(64) } });
  assert.throws(() => createRunalithHostedCandidateVerificationPredicate(nonReproducible),
    error => error.code === 'HOSTED_VERIFICATION_INDEPENDENT_REBUILD_MISMATCH');
});

test('rejects caller-edited builder identity, inventory duplicates, and missing source provenance', () => {
  const wrongBuilder = fixtures({ builderVerification: { ...fixtures().builderVerification,
    expectedBuilderId: 'https://attacker.invalid/forged' } });
  assert.throws(() => createRunalithHostedCandidateVerificationPredicate(wrongBuilder),
    error => error.code === 'HOSTED_VERIFICATION_SOURCE_OR_BUILDER_BINDING_MISMATCH');

  const duplicateEntry = alignment();
  duplicateEntry.sourceEntries.push({ ...duplicateEntry.sourceEntries[0] });
  duplicateEntry.archiveEntryCount = 3;
  const duplicateInventory = fixtures({ independentSourceAlignment: duplicateEntry });
  assert.throws(() => createRunalithHostedCandidateVerificationPredicate(duplicateInventory),
    error => error.code === 'HOSTED_VERIFICATION_INVENTORY_INVALID');

  const noReceipt = fixtures({ independentSourceAlignment: alignment({ sourceProvenanceStatus: 'DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT' }) });
  assert.throws(() => createRunalithHostedCandidateVerificationPredicate(noReceipt),
    error => error.code === 'HOSTED_VERIFICATION_SOURCE_OR_BUILDER_BINDING_MISMATCH');
});

test('rejects missing or substituted content digests for the evidence DAG', () => {
  const noBundleDigest = fixtures({ evidenceDigests: { ...fixtures().evidenceDigests,
    builder_attestation_bundle_sha256: 'a'.repeat(64) } });
  assert.throws(() => createRunalithHostedCandidateVerificationPredicate(noBundleDigest),
    error => error.code === 'HOSTED_VERIFICATION_EVIDENCE_DIGESTS_INVALID');

  const missingReportDigest = fixtures({ evidenceDigests: { ...fixtures().evidenceDigests,
    independent_rebuild_report_sha256: null } });
  assert.throws(() => createRunalithHostedCandidateVerificationPredicate(missingReportDigest),
    error => error.code === 'HOSTED_VERIFICATION_EVIDENCE_DIGESTS_INVALID');
});
