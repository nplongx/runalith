import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { canonicalExternalCheckpointPayload, EXTERNAL_CHECKPOINT_CONTRACT,
  verifyExternalTrustCheckpointResponse } from '../scripts/lib/external-trust-checkpoint-contract.mjs';

const NOW = Date.parse('2026-10-26T10:00:00.000Z');
const candidateSha256 = 'a'.repeat(64);
const rollbackSha256 = 'b'.repeat(64);
const previousCheckpointDigest = 'd'.repeat(64);
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const authorityPublicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });

function response(overrides = {}) {
  const payload = {
    schema_version: 1,
    contract: EXTERNAL_CHECKPOINT_CONTRACT,
    authority_id: 'test-only-checkpoint-authority',
    request_nonce: '0123456789abcdef0123456789abcdef',
    checkpoint_sequence: 7,
    checkpoint_digest: 'c'.repeat(64),
    previous_checkpoint_digest: previousCheckpointDigest,
    ledger_state_sha256: 'e'.repeat(64),
    trust_domain_state_sha256: 'f'.repeat(64),
    candidate_sha256: candidateSha256,
    rollback_sha256: rollbackSha256,
    observed_at: new Date(NOW).toISOString(),
    ...overrides
  };
  const signature = sign(null, Buffer.from(canonicalExternalCheckpointPayload(payload)), privateKey).toString('base64');
  return { ...payload, signature_base64: signature };
}

function verify(value, continuity = { source: 'host_monotonic_store', authorityId: 'test-only-checkpoint-authority',
  highWaterSequence: 6, lastCheckpointDigest: previousCheckpointDigest }, overrides = {}) {
  return verifyExternalTrustCheckpointResponse(value, {
    authorityPublicKeyPem,
    expectedAuthorityId: 'test-only-checkpoint-authority',
    requestNonce: '0123456789abcdef0123456789abcdef',
    candidateSha256, rollbackSha256, continuity, now: NOW, ...overrides
  });
}

test('verifies exact signed checkpoint challenge, release binding, freshness and monotonic continuity', () => {
  const result = verify(response());
  assert.equal(result.verified, true);
  assert.equal(result.signatureVerified, true);
  assert.equal(result.continuityContractValid, true);
  assert.equal(result.checkpointSequence, 7);
  assert.equal(result.productionAuthorityEstablished, false,
    'test-local signing key and continuity object must never establish host production authority');
});

test('rejects signature tampering and signed release/hash substitution', () => {
  const signed = response();
  assert.ok(verify({ ...signed, ledger_state_sha256: '0'.repeat(64) }).blockers.includes('EXTERNAL_CHECKPOINT_SIGNATURE_INVALID'));
  assert.ok(verify(response({ candidate_sha256: '0'.repeat(64) })).blockers.includes('EXTERNAL_CHECKPOINT_RELEASE_BINDING_MISMATCH'));
  assert.ok(verify(response(), undefined, { rollbackSha256: '9'.repeat(64) }).blockers.includes('EXTERNAL_CHECKPOINT_RELEASE_BINDING_MISMATCH'));
});

test('rejects replayed nonce, stale checkpoint, rollback and broken chain continuity', () => {
  assert.ok(verify(response(), undefined, { requestNonce: 'f'.repeat(32) }).blockers.includes('EXTERNAL_CHECKPOINT_CHALLENGE_MISMATCH'));
  assert.ok(verify(response({ observed_at: new Date(NOW - 6 * 60_000).toISOString() })).blockers.includes('EXTERNAL_CHECKPOINT_STALE_OR_NONCANONICAL'));
  assert.ok(verify(response(), { source: 'host_monotonic_store', authorityId: 'test-only-checkpoint-authority',
    highWaterSequence: 7, lastCheckpointDigest: 'c'.repeat(64) }).blockers.includes('EXTERNAL_CHECKPOINT_ANTI_ROLLBACK_FAILED'));
  assert.ok(verify(response(), { source: 'host_monotonic_store', authorityId: 'test-only-checkpoint-authority',
    highWaterSequence: 6, lastCheckpointDigest: '9'.repeat(64) }).blockers.includes('EXTERNAL_CHECKPOINT_CHAIN_DISCONTINUITY'));
});

test('refuses unverified local continuity and invalid verifier roots', () => {
  const local = verify(response(), { source: 'local_json_file', authorityId: 'test-only-checkpoint-authority',
    highWaterSequence: 6, lastCheckpointDigest: previousCheckpointDigest });
  assert.equal(local.verified, false);
  assert.ok(local.blockers.includes('EXTERNAL_CHECKPOINT_CONTINUITY_SOURCE_UNVERIFIED'));
  const wrongKey = verifyExternalTrustCheckpointResponse(response(), { authorityPublicKeyPem: 'not a key',
    expectedAuthorityId: 'test-only-checkpoint-authority', requestNonce: '0123456789abcdef0123456789abcdef',
    candidateSha256, rollbackSha256,
    continuity: { source: 'host_monotonic_store', authorityId: 'test-only-checkpoint-authority', highWaterSequence: 6,
      lastCheckpointDigest: previousCheckpointDigest }, now: NOW });
  assert.equal(wrongKey.verified, false);
  assert.ok(wrongKey.blockers.includes('EXTERNAL_CHECKPOINT_VERIFIER_CONFIGURATION_INVALID'));
  assert.equal(wrongKey.productionAuthorityEstablished, false);
});
