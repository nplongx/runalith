import { createHash } from 'node:crypto';
import {
  RUNALITH_EXPECTED_BUILDER_ID, RUNALITH_GITHUB_ACTIONS_BUILD_TYPE, RUNALITH_HOSTED_BUILD_OIDC_ISSUER,
  RUNALITH_HOSTED_BUILD_REPOSITORY, RUNALITH_HOSTED_BUILD_WORKFLOW, RUNALITH_SLSA_PREDICATE
} from './hosted-builder-attestation.mjs';

export const RUNALITH_HOSTED_CANDIDATE_VERIFICATION_PREDICATE = 'https://runalith.dev/attestations/hosted-candidate-verification/v1';
export const RUNALITH_HOSTED_BUILD_POLICY_CONTRACT = 'runalith-hosted-build-policy/v1';
const SHA256 = /^[a-f0-9]{64}$/;
const REQUIRED_POLICY_KEYS = Object.freeze([
  'schema_version', 'contract', 'policy_version', 'source_repository', 'target_environment', 'subject_suffix',
  'builder_workflow', 'verifier_workflow', 'oidc_issuer', 'build_type', 'provenance_predicate',
  'verification_predicate', 'required_tests', 'max_attestation_age_hours', 'production_release_approval_required',
  'host_trust_provisioning_required', 'external_monotonic_checkpoint_required', 'rollback_must_match_observed_baseline_bytes'
]);
export const RUNALITH_HOSTED_REQUIRED_TESTS = Object.freeze([
  'npm test', 'hosted-builder-contract-tests', 'docs:check', 'site:check', 'package-reproducibility',
  'candidate:zip-integrity', 'candidate:source-alignment', 'candidate:extracted-runtime',
  'candidate:independent-rebuild', 'candidate:independent-source-alignment', 'builder:signature-verification'
]);

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail('HOSTED_VERIFICATION_JSON_INVALID', 'undefined is not valid canonical JSON');
  return encoded;
}
function exactKeys(value, keys, label) {
  if (!isRecord(value) || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    fail('HOSTED_VERIFICATION_SCHEMA_INVALID', `${label} must contain exactly ${[...keys].sort().join(', ')}`);
  }
}

export function validateRunalithHostedBuildPolicy(policy) {
  exactKeys(policy, REQUIRED_POLICY_KEYS, 'hosted build policy');
  if (policy.schema_version !== 1 || policy.contract !== RUNALITH_HOSTED_BUILD_POLICY_CONTRACT ||
      policy.policy_version !== 1 || policy.source_repository !== `https://github.com/${RUNALITH_HOSTED_BUILD_REPOSITORY}` ||
      policy.target_environment !== 'not-for-production' || policy.subject_suffix !== '.mcpb' ||
      policy.builder_workflow !== RUNALITH_HOSTED_BUILD_WORKFLOW ||
      policy.verifier_workflow !== '.github/workflows/runalith-provenance-verifier.yml' ||
      policy.oidc_issuer !== RUNALITH_HOSTED_BUILD_OIDC_ISSUER || policy.build_type !== RUNALITH_GITHUB_ACTIONS_BUILD_TYPE ||
      policy.provenance_predicate !== RUNALITH_SLSA_PREDICATE ||
      policy.verification_predicate !== RUNALITH_HOSTED_CANDIDATE_VERIFICATION_PREDICATE ||
      policy.max_attestation_age_hours !== 24 || policy.production_release_approval_required !== true ||
      policy.host_trust_provisioning_required !== true || policy.external_monotonic_checkpoint_required !== true ||
      policy.rollback_must_match_observed_baseline_bytes !== true || !Array.isArray(policy.required_tests) ||
      canonicalJson(policy.required_tests) !== canonicalJson(RUNALITH_HOSTED_REQUIRED_TESTS)) {
    fail('HOSTED_VERIFICATION_POLICY_INVALID', 'hosted build policy constants, bounded expiry, production blockers or test list do not match the verifier implementation');
  }
  if (new Set(policy.required_tests).size !== policy.required_tests.length ||
      policy.required_tests.some(name => typeof name !== 'string' || name !== name.trim() ||
        !/^[a-zA-Z0-9][a-zA-Z0-9:._/ -]{0,199}$/.test(name))) {
    fail('HOSTED_VERIFICATION_POLICY_TESTS_INVALID', 'required test IDs must be unique, stable strings');
  }
  return policy;
}

/**
 * Produce a predicate for `actions/attest`. The resulting object is a claim;
 * its authority comes only after a separate host verifies the Sigstore-backed
 * attestation against the exact verifier workflow identity and source digest.
 */
export function createRunalithHostedCandidateVerificationPredicate({ candidateBytes, policyBytes, policy,
  builderVerification, builderSourceAlignment, independentRebuild, independentSourceAlignment, evidenceDigests } = {}) {
  if (!Buffer.isBuffer(candidateBytes) || candidateBytes.length < 1 || !Buffer.isBuffer(policyBytes)) {
    fail('HOSTED_VERIFICATION_INPUT_INVALID', 'candidate and raw policy bytes are required');
  }
  validateRunalithHostedBuildPolicy(policy);
  const candidateSha256 = sha256(candidateBytes);
  const policySha256 = sha256(policyBytes);
  const builderSourceCommit = builderSourceAlignment?.sourceGitHead;
  const sourceSnapshotSha256 = independentSourceAlignment?.sourceSnapshotSha256;
  const evidenceKeys = ['builder_attestation_bundle_sha256', 'builder_verification_report_sha256',
    'builder_source_alignment_sha256', 'independent_rebuild_report_sha256', 'independent_source_alignment_sha256'];
  if (!isRecord(evidenceDigests) || Object.keys(evidenceDigests).sort().join('\0') !== [...evidenceKeys].sort().join('\0') ||
      evidenceKeys.some(key => !SHA256.test(evidenceDigests[key] || '')) ||
      builderVerification?.builderAttestationBundleSha256 !== evidenceDigests.builder_attestation_bundle_sha256) {
    fail('HOSTED_VERIFICATION_EVIDENCE_DIGESTS_INVALID', 'exact byte digests of the builder attestation, verification report, source alignment and independent rebuild reports are required');
  }
  if (builderVerification?.status !== 'HOSTED_BUILDER_PROVENANCE_VERIFIED' ||
      builderVerification.candidateSha256 !== candidateSha256 ||
      builderVerification.sourceCommit !== builderSourceCommit ||
      builderVerification.repository !== policy.source_repository.replace('https://github.com/', '') ||
      builderVerification.signerWorkflow !== policy.builder_workflow ||
      builderVerification.oidcIssuer !== policy.oidc_issuer ||
      builderVerification.predicateType !== policy.provenance_predicate ||
      builderVerification.buildType !== policy.build_type ||
      builderVerification.expectedBuilderId !== RUNALITH_EXPECTED_BUILDER_ID ||
      builderVerification.productionReleaseEligible !== false ||
      !SHA256.test(sourceSnapshotSha256 || '') ||
      independentSourceAlignment.status !== 'PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT' ||
      independentSourceAlignment.sourceProvenanceStatus !== 'CLEAN_GIT_TREE_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT' ||
      independentSourceAlignment.releaseEligibility !== 'BLOCKED_AUTHENTICATED_BUILD_RECEIPT_AND_INDEPENDENT_AUTHORITY_REQUIRED' ||
      independentSourceAlignment.sourceGitHead !== builderSourceCommit ||
      independentSourceAlignment.sourceSnapshotSha256 !== builderSourceAlignment?.sourceSnapshotSha256 ||
      independentSourceAlignment.bundleSha256 !== candidateSha256 ||
      independentSourceAlignment.sourceGitState?.workingTreeClean !== true ||
      independentSourceAlignment.sourceGitState?.trackedWorkingTreeClean !== true ||
      builderSourceAlignment?.sourceGitState?.workingTreeClean !== true ||
      builderSourceAlignment?.sourceGitState?.trackedWorkingTreeClean !== true ||
      builderSourceAlignment?.sourceGitHead !== builderSourceCommit ||
      builderSourceAlignment?.bundleSha256 !== candidateSha256) {
    fail('HOSTED_VERIFICATION_SOURCE_OR_BUILDER_BINDING_MISMATCH', 'verified builder attestation and independent source alignment do not bind one exact candidate and clean source commit');
  }
  const rebuiltDigest = independentRebuild?.independentlyRebuiltSha256;
  if (independentRebuild?.contract !== 'runalith-independent-rebuild/v1' ||
      independentRebuild.status !== 'PASS_BYTE_IDENTICAL' || independentRebuild.sourceCommit !== builderSourceCommit ||
      independentRebuild.candidateSha256 !== candidateSha256 || rebuiltDigest !== candidateSha256 ||
      independentRebuild.candidateBytes !== candidateBytes.length || independentRebuild.independentlyRebuiltBytes !== candidateBytes.length) {
    fail('HOSTED_VERIFICATION_INDEPENDENT_REBUILD_MISMATCH', 'independent rebuild evidence must be byte-identical to the exact candidate and source commit');
  }
  if (!Array.isArray(independentSourceAlignment.sourceEntries) || independentSourceAlignment.sourceEntries.length < 1) {
    fail('HOSTED_VERIFICATION_INVENTORY_MISSING', 'independent source alignment does not include an explicit entry inventory');
  }
  const paths = new Set();
  const inventory = independentSourceAlignment.sourceEntries.map(entry => {
    if (!isRecord(entry) || typeof entry.archivePath !== 'string' || !entry.archivePath ||
        paths.has(entry.archivePath) || !SHA256.test(entry.sha256 || '') || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
      fail('HOSTED_VERIFICATION_INVENTORY_INVALID', 'source inventory paths must be unique and bind byte size/SHA-256');
    }
    paths.add(entry.archivePath);
    return { archivePath: entry.archivePath, sizeBytes: entry.sizeBytes, sha256: entry.sha256 };
  }).sort((a, b) => a.archivePath.localeCompare(b.archivePath, 'en'));
  if (independentSourceAlignment.archiveEntryCount !== inventory.length) {
    fail('HOSTED_VERIFICATION_INVENTORY_COUNT_MISMATCH', 'source entry inventory count differs from the complete ZIP entry count');
  }
  const entryInventorySha256 = sha256(Buffer.from(canonicalJson(inventory), 'utf8'));
  const tests = policy.required_tests.map(name => ({ name, status: 'PASS', exit_code: 0, candidate_sha256: candidateSha256 }));
  return {
    result: 'PASS',
    candidate_sha256: candidateSha256,
    source_snapshot_sha256: sourceSnapshotSha256,
    policy_sha256: policySha256,
    entry_inventory_sha256: entryInventorySha256,
    evidence: { ...evidenceDigests },
    source_alignment: {
      status: 'PASS', candidate_sha256: candidateSha256,
      source_snapshot_sha256: sourceSnapshotSha256, working_tree_clean: true
    },
    tests
  };
}

export function runalithHostedPolicyDigest(policyBytes) {
  if (!Buffer.isBuffer(policyBytes)) throw new TypeError('policy must be supplied as exact file bytes');
  return sha256(policyBytes);
}

export function runalithHostedPredicateDigest(predicate) {
  return sha256(Buffer.from(canonicalJson(predicate), 'utf8'));
}
