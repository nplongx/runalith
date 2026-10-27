import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import {
  IN_TOTO_DSSE_PAYLOAD_TYPE, IN_TOTO_STATEMENT_V1, RUNALITH_CANDIDATE_VERIFICATION_PREDICATE,
  RUNALITH_RELEASE_APPROVAL_PREDICATE, RUNALITH_RELEASE_POLICY_CONTRACT, SLSA_PROVENANCE_V1,
  dssePreAuthenticationEncoding, parseRunalithReleaseEvidenceJson, validateRunalithReleasePolicy,
  verifyRunalithDsseEnvelope, verifyRunalithReleaseEvidence
} from '../scripts/lib/runalith-release-trust-contract.mjs';

const NOW = Date.now();
const NOW_ISO = new Date(NOW).toISOString();
const before = new Date(NOW - 60_000).toISOString();
const after = new Date(NOW + 60 * 60_000).toISOString();
const NONCE = '0123456789abcdef0123456789abcdef';
const REPOSITORY = 'https://github.com/nplongx/runalith';
const REQUIRED_TESTS = ['npm:test', 'source:alignment', 'inventory:frozen'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonicalJson = value => Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
    : JSON.stringify(value);

const keys = Object.fromEntries(['builder', 'verifier', 'release_authority'].map(role => {
  const pair = generateKeyPairSync('ed25519');
  return [role, { role, key_id: `${role}-test-key`, identity: `test://${role}-authority`,
    public_key_pem: pair.publicKey.export({ type: 'spki', format: 'pem' }), privateKey: pair.privateKey }];
}));

function signEnvelope(statement, signer) {
  const payloadBytes = Buffer.from(JSON.stringify(statement));
  const signature = sign(null, dssePreAuthenticationEncoding(IN_TOTO_DSSE_PAYLOAD_TYPE, payloadBytes), signer.privateKey).toString('base64');
  return { payloadType: IN_TOTO_DSSE_PAYLOAD_TYPE, payload: payloadBytes.toString('base64'),
    signatures: [{ keyid: signer.key_id, sig: signature }] };
}

function statement(candidateSha256, predicateType, predicate) {
  return { _type: IN_TOTO_STATEMENT_V1, subject: [{ name: 'runalith.mcpb', digest: { sha256: candidateSha256 } }],
    predicateType, predicate };
}

function createFixture(overrides = {}) {
  const candidateBytes = Buffer.from('candidate MCPB bytes for contract test');
  const baselineBytes = Buffer.from('installed baseline MCPB bytes');
  const candidateSha256 = sha256(candidateBytes);
  const baselineSha256 = sha256(baselineBytes);
  const policy = {
    schema_version: 1,
    contract: RUNALITH_RELEASE_POLICY_CONTRACT,
    policy_version: 4,
    source_repository: REPOSITORY,
    subject_name: 'runalith.mcpb',
    expected_build_type: 'https://runalith.dev/build/mcpb/v1',
    target_environment: 'production',
    required_tests: [...REQUIRED_TESTS],
    max_approval_ttl_seconds: 3600,
    trusted_signers: Object.values(keys).map(({ privateKey, ...trusted }) => ({ ...trusted,
      not_before: before, not_after: null, revoked_at: null }))
  };
  const policyBytes = Buffer.from(JSON.stringify(policy));
  const policySha256 = sha256(policyBytes);
  const snapshotSha256 = 'd'.repeat(64);
  const commit = 'c'.repeat(40);
  const treeSha256 = 'e'.repeat(64);
  const emptySha256 = sha256(Buffer.alloc(0));
  const provenance = signEnvelope(statement(candidateSha256, SLSA_PROVENANCE_V1, {
    buildDefinition: {
      buildType: policy.expected_build_type,
      externalParameters: { source: { repository: REPOSITORY, commit, tree_sha256: treeSha256,
        snapshot_sha256: snapshotSha256, working_tree_clean: true,
        tracked_diff_sha256: emptySha256, working_tree_status_sha256: emptySha256 } },
      resolvedDependencies: [{ uri: REPOSITORY, digest: { gitCommit: commit } }]
    },
    runDetails: { builder: { id: keys.builder.identity }, metadata: {
      invocationId: 'test-build-123', startedOn: before, finishedOn: NOW_ISO
    } }
  }), keys.builder);
  const provenanceEnvelopeBytes = Buffer.from(JSON.stringify(provenance));
  const verification = signEnvelope(statement(candidateSha256, RUNALITH_CANDIDATE_VERIFICATION_PREDICATE, {
    result: 'PASS', candidate_sha256: candidateSha256, source_snapshot_sha256: snapshotSha256,
    policy_sha256: policySha256, entry_inventory_sha256: 'a'.repeat(64),
    source_alignment: { status: 'PASS', candidate_sha256: candidateSha256,
      source_snapshot_sha256: snapshotSha256, working_tree_clean: true },
    tests: REQUIRED_TESTS.map(name => ({ name, status: 'PASS', exit_code: 0, candidate_sha256: candidateSha256 }))
  }), keys.verifier);
  const verificationEnvelopeBytes = Buffer.from(JSON.stringify(verification));
  const evidenceBundleSha256 = sha256(Buffer.from(canonicalJson({ candidate_sha256: candidateSha256,
    policy_sha256: policySha256, provenance_envelope_sha256: sha256(provenanceEnvelopeBytes),
    verification_envelope_sha256: sha256(verificationEnvelopeBytes) })));
  const approval = signEnvelope(statement(candidateSha256, RUNALITH_RELEASE_APPROVAL_PREDICATE, {
    decision: 'APPROVE', candidate_sha256: candidateSha256,
    provenance_envelope_sha256: sha256(provenanceEnvelopeBytes),
    verification_envelope_sha256: sha256(verificationEnvelopeBytes), evidence_bundle_sha256: evidenceBundleSha256,
    policy_sha256: policySha256, policy_version: policy.policy_version, target_environment: policy.target_environment,
    baseline: { version: '1.0.9-rc.11', sha256: baselineSha256 },
    rollback: { version: '1.0.9-rc.11', sha256: baselineSha256 },
    issued_at: NOW_ISO, expires_at: after, nonce: NONCE, approver_identity: keys.release_authority.identity
  }), keys.release_authority);
  const approvalEnvelopeBytes = Buffer.from(JSON.stringify(approval));
  return {
    candidateBytes, policy, policyBytes, provenanceEnvelope: provenance, provenanceEnvelopeBytes, rollbackBytes: baselineBytes,
    verificationEnvelope: verification, verificationEnvelopeBytes, approvalEnvelope: approval, approvalEnvelopeBytes,
    expectedNonce: NONCE, baselineVersion: '1.0.9-rc.11', baselineSha256,
    rollbackVersion: '1.0.9-rc.11', rollbackSha256: baselineSha256,
    now: NOW, _candidateSha256: candidateSha256, _snapshotSha256: snapshotSha256, _baselineBytes: baselineBytes,
    ...overrides
  };
}

test('valid DSSE/SLSA + test report + independent release approval verifies evidence but never production authority', () => {
  const result = verifyRunalithReleaseEvidence(createFixture());
  assert.equal(result.cryptographicEvidenceVerified, true, JSON.stringify(result.evidenceBlockers));
  assert.equal(result.status, 'EVIDENCE_VERIFIED_BUT_PRODUCTION_BLOCKED');
  assert.equal(result.productionReleaseEligible, false);
  assert.equal(result.productionAuthorityEstablished, false);
  assert.equal(result.hostTrustContextAuthenticated, false);
  assert.equal(result.monotonicCheckpointAuthenticated, false);
  assert.deepEqual(result.productionBlockers, [
    'HOST_TRUST_POLICY_PROVISIONING_NOT_AUTHENTICATED', 'HOST_MONOTONIC_CHECKPOINT_NOT_VERIFIED'
  ]);
  assert.equal(result.gates.provenance.status, 'PASS');
  assert.equal(result.gates.candidateVerification.status, 'PASS');
  assert.equal(result.gates.releaseApproval.status, 'PASS');
});

test('direct DSSE verifier rejects hostile object envelopes without invoking accessors', () => {
  const fixture = createFixture();
  const validatedPolicy = validateRunalithReleasePolicy(fixture.policy, { now: NOW });
  let getterCalls = 0;
  const hostile = {
    payloadType: IN_TOTO_DSSE_PAYLOAD_TYPE,
    signatures: fixture.provenanceEnvelope.signatures
  };
  Object.defineProperty(hostile, 'payload', { enumerable: true, get() { getterCalls += 1; return fixture.provenanceEnvelope.payload; } });
  assert.throws(() => verifyRunalithDsseEnvelope(hostile, validatedPolicy, 'builder', { now: NOW }),
    error => error.code === 'RELEASE_EVIDENCE_SCHEMA_INVALID');
  assert.equal(getterCalls, 0, 'strict canonicalization must reject the accessor without executing it');

  const hidden = { ...fixture.provenanceEnvelope };
  Object.defineProperty(hidden, 'unexpected', { enumerable: false, value: 'not JSON-visible' });
  assert.throws(() => verifyRunalithDsseEnvelope(hidden, validatedPolicy, 'builder', { now: NOW }),
    error => error.code === 'RELEASE_EVIDENCE_SCHEMA_INVALID');
});

test('fails closed when candidate bytes or signed in-toto subject are substituted', () => {
  const fixture = createFixture({ candidateBytes: Buffer.from('replacement MCPB bytes') });
  const result = verifyRunalithReleaseEvidence(fixture);
  assert.equal(result.cryptographicEvidenceVerified, false);
  assert.ok(result.evidenceBlockers.includes('RELEASE_EVIDENCE_SUBJECT_MISMATCH'));
  assert.equal(result.productionReleaseEligible, false);
});

test('rejects dirty source snapshots and unexpected repository/build materials', () => {
  const dirty = createFixture();
  const dirtyPayload = JSON.parse(Buffer.from(dirty.provenanceEnvelope.payload, 'base64').toString('utf8'));
  dirtyPayload.predicate.buildDefinition.externalParameters.source.working_tree_clean = false;
  dirtyPayload.predicate.buildDefinition.externalParameters.source.tracked_diff_sha256 = '1'.repeat(64);
  dirty.provenanceEnvelope = signEnvelope(dirtyPayload, keys.builder);
  dirty.provenanceEnvelopeBytes = Buffer.from(JSON.stringify(dirty.provenanceEnvelope));
  const result = verifyRunalithReleaseEvidence(dirty);
  assert.ok(result.evidenceBlockers.includes('RELEASE_EVIDENCE_SOURCE_SNAPSHOT_INVALID'));

  const wrongRepo = createFixture();
  const wrongRepoPayload = JSON.parse(Buffer.from(wrongRepo.provenanceEnvelope.payload, 'base64').toString('utf8'));
  wrongRepoPayload.predicate.buildDefinition.externalParameters.source.repository = 'https://example.invalid/untrusted';
  wrongRepo.provenanceEnvelope = signEnvelope(wrongRepoPayload, keys.builder);
  wrongRepo.provenanceEnvelopeBytes = Buffer.from(JSON.stringify(wrongRepo.provenanceEnvelope));
  assert.ok(verifyRunalithReleaseEvidence(wrongRepo).evidenceBlockers.includes('RELEASE_EVIDENCE_SOURCE_SNAPSHOT_INVALID'));

  const futureBuild = createFixture();
  const futurePayload = JSON.parse(Buffer.from(futureBuild.provenanceEnvelope.payload, 'base64').toString('utf8'));
  futurePayload.predicate.runDetails.metadata.finishedOn = new Date(NOW + 10_000).toISOString();
  futureBuild.provenanceEnvelope = signEnvelope(futurePayload, keys.builder);
  futureBuild.provenanceEnvelopeBytes = Buffer.from(JSON.stringify(futureBuild.provenanceEnvelope));
  assert.ok(verifyRunalithReleaseEvidence(futureBuild).evidenceBlockers.includes('RELEASE_EVIDENCE_BUILD_TIME_INVALID'));
});

test('rejects ambiguous SLSA material inventories and dependencies without SHA-256 digests', () => {
  const duplicateSource = createFixture();
  const duplicatePayload = JSON.parse(Buffer.from(duplicateSource.provenanceEnvelope.payload, 'base64').toString('utf8'));
  duplicatePayload.predicate.buildDefinition.resolvedDependencies.push({ uri: REPOSITORY, digest: { gitCommit: 'c'.repeat(40) } });
  duplicateSource.provenanceEnvelope = signEnvelope(duplicatePayload, keys.builder);
  duplicateSource.provenanceEnvelopeBytes = Buffer.from(JSON.stringify(duplicateSource.provenanceEnvelope));
  assert.ok(verifyRunalithReleaseEvidence(duplicateSource).evidenceBlockers.includes('RELEASE_EVIDENCE_MATERIALS_INVALID'),
    'two records for the source URI must not leave source-material selection ambiguous');

  const missingDigest = createFixture();
  const missingDigestPayload = JSON.parse(Buffer.from(missingDigest.provenanceEnvelope.payload, 'base64').toString('utf8'));
  missingDigestPayload.predicate.buildDefinition.resolvedDependencies.push({ uri: 'pkg:npm/example@1.2.3', digest: {} });
  missingDigest.provenanceEnvelope = signEnvelope(missingDigestPayload, keys.builder);
  missingDigest.provenanceEnvelopeBytes = Buffer.from(JSON.stringify(missingDigest.provenanceEnvelope));
  assert.ok(verifyRunalithReleaseEvidence(missingDigest).evidenceBlockers.includes('RELEASE_EVIDENCE_MATERIAL_DIGEST_INVALID'),
    'every non-source build material must be pinned by a SHA-256 digest');

  const wrongCommit = createFixture();
  const wrongCommitPayload = JSON.parse(Buffer.from(wrongCommit.provenanceEnvelope.payload, 'base64').toString('utf8'));
  wrongCommitPayload.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'f'.repeat(40);
  wrongCommit.provenanceEnvelope = signEnvelope(wrongCommitPayload, keys.builder);
  wrongCommit.provenanceEnvelopeBytes = Buffer.from(JSON.stringify(wrongCommit.provenanceEnvelope));
  assert.ok(verifyRunalithReleaseEvidence(wrongCommit).evidenceBlockers.includes('RELEASE_EVIDENCE_SOURCE_MATERIAL_MISMATCH'));
});

test('rejects missing test records, non-zero exit statuses and candidate-mismatched test evidence', () => {
  const fixture = createFixture();
  const report = JSON.parse(Buffer.from(fixture.verificationEnvelope.payload, 'base64').toString('utf8'));
  report.predicate.tests = report.predicate.tests.filter(item => item.name !== REQUIRED_TESTS[1]);
  fixture.verificationEnvelope = signEnvelope(report, keys.verifier);
  fixture.verificationEnvelopeBytes = Buffer.from(JSON.stringify(fixture.verificationEnvelope));
  assert.ok(verifyRunalithReleaseEvidence(fixture).evidenceBlockers.includes('RELEASE_EVIDENCE_REQUIRED_TEST_MISSING'));

  const nonzero = createFixture();
  const failingReport = JSON.parse(Buffer.from(nonzero.verificationEnvelope.payload, 'base64').toString('utf8'));
  failingReport.predicate.tests[0].exit_code = 1;
  nonzero.verificationEnvelope = signEnvelope(failingReport, keys.verifier);
  nonzero.verificationEnvelopeBytes = Buffer.from(JSON.stringify(nonzero.verificationEnvelope));
  assert.ok(verifyRunalithReleaseEvidence(nonzero).evidenceBlockers.includes('RELEASE_EVIDENCE_REQUIRED_TEST_MISSING'));
});

test('rejects approval replay, policy drift, expiry and baseline/rollback substitution', () => {
  const replay = verifyRunalithReleaseEvidence(createFixture({ expectedNonce: 'f'.repeat(32) }));
  assert.ok(replay.evidenceBlockers.includes('RELEASE_EVIDENCE_APPROVAL_NONCE_MISMATCH'));

  const expired = createFixture();
  const expiredPayload = JSON.parse(Buffer.from(expired.approvalEnvelope.payload, 'base64').toString('utf8'));
  expiredPayload.predicate.expires_at = new Date(NOW - 1_000).toISOString();
  expired.approvalEnvelope = signEnvelope(expiredPayload, keys.release_authority);
  expired.approvalEnvelopeBytes = Buffer.from(JSON.stringify(expired.approvalEnvelope));
  assert.ok(verifyRunalithReleaseEvidence(expired).evidenceBlockers.includes('RELEASE_EVIDENCE_APPROVAL_EXPIRED_OR_INVALID'));

  const policyDrift = createFixture();
  policyDrift.policy.policy_version += 1;
  policyDrift.policyBytes = Buffer.from(JSON.stringify(policyDrift.policy));
  assert.ok(verifyRunalithReleaseEvidence(policyDrift).evidenceBlockers.some(code => code.startsWith('RELEASE_EVIDENCE_')));

  const incompatibleRollback = createFixture({ rollbackVersion: '1.0.9-rc.8', rollbackSha256: 'b'.repeat(64) });
  assert.ok(verifyRunalithReleaseEvidence(incompatibleRollback).evidenceBlockers.includes('RELEASE_EVIDENCE_BASELINE_ROLLBACK_MISMATCH'));
});

test('binds the validated policy object to the exact raw policy bytes before checking signed evidence', () => {
  const fixture = createFixture();
  fixture.policyBytes = Buffer.from(JSON.stringify({ ...fixture.policy, target_environment: 'staging' }));
  const result = verifyRunalithReleaseEvidence(fixture);
  assert.equal(result.gates.policy.status, 'BLOCKED');
  assert.ok(result.evidenceBlockers.includes('RELEASE_EVIDENCE_POLICY_BYTES_MISMATCH'));
  assert.equal(result.cryptographicEvidenceVerified, false,
    'a digest for a different policy must not be combined with trust decisions from the caller-supplied object');
});

test('rejects hostile in-memory policy objects without executing accessors', () => {
  const fixture = createFixture();
  let getterCalls = 0;
  const hostilePolicy = { ...fixture.policy };
  Object.defineProperty(hostilePolicy, 'target_environment', {
    enumerable: true,
    configurable: true,
    get() { getterCalls++; return 'production'; }
  });
  const result = verifyRunalithReleaseEvidence({ ...fixture, policy: hostilePolicy });
  assert.equal(getterCalls, 0, 'the verifier must not execute caller-controlled policy getters');
  assert.equal(result.cryptographicEvidenceVerified, false);
  assert.ok(result.evidenceBlockers.includes('RELEASE_EVIDENCE_SCHEMA_INVALID'));
  assert.throws(() => validateRunalithReleasePolicy(hostilePolicy, { now: NOW }),
    error => error.code === 'RELEASE_EVIDENCE_SCHEMA_INVALID');
  assert.equal(getterCalls, 0, 'direct policy validation must not execute caller-controlled getters either');

  const sparse = createFixture();
  sparse.policy.required_tests = new Array(3);
  sparse.policyBytes = Buffer.from('{}');
  const sparseResult = verifyRunalithReleaseEvidence(sparse);
  assert.equal(sparseResult.cryptographicEvidenceVerified, false);
  assert.ok(sparseResult.evidenceBlockers.some(code => code.startsWith('RELEASE_EVIDENCE_') || code.startsWith('RELEASE_POLICY_')));
});

test('rejects invalid signatures, signer role collisions and duplicate JSON keys', () => {
  const tampered = createFixture();
  tampered.provenanceEnvelope.signatures[0].sig = Buffer.alloc(64).toString('base64');
  tampered.provenanceEnvelopeBytes = Buffer.from(JSON.stringify(tampered.provenanceEnvelope));
  assert.ok(verifyRunalithReleaseEvidence(tampered).evidenceBlockers.includes('RELEASE_EVIDENCE_SIGNATURE_INVALID'));

  const overlapping = createFixture();
  const builderKey = overlapping.policy.trusted_signers.find(item => item.role === 'builder');
  const reviewerKey = overlapping.policy.trusted_signers.find(item => item.role === 'release_authority');
  reviewerKey.public_key_pem = builderKey.public_key_pem;
  overlapping.policyBytes = Buffer.from(JSON.stringify(overlapping.policy));
  const result = verifyRunalithReleaseEvidence(overlapping);
  assert.equal(result.gates.policy.status, 'BLOCKED');
  assert.ok(result.evidenceBlockers.includes('RELEASE_POLICY_AUTHORITY_SEPARATION_FAILED'));

  assert.throws(() => parseRunalithReleaseEvidenceJson(Buffer.from('{"schema_version":1,"schema_version":2}'), 'duplicate-key test'));
});

test('DSSE verification requires a policy object validated in this module instance', () => {
  const fixture = createFixture();
  assert.throws(() => verifyRunalithDsseEnvelope(fixture.provenanceEnvelope,
    { policyValidated: true, signers: fixture.policy.trusted_signers }, 'builder', { now: NOW }),
  error => error.code === 'RELEASE_EVIDENCE_VERIFIER_CONFIGURATION_INVALID');
  const validated = validateRunalithReleasePolicy(fixture.policy, { now: NOW });
  assert.equal(validated.policyValidated, true);
  assert.equal(validated.authorityProvisioningAuthenticated, false);
});
