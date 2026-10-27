import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { canonicalExternalCheckpointPayload, EXTERNAL_CHECKPOINT_CONTRACT,
  computeExternalTrustCheckpointDigest, verifyExternalTrustCheckpointResponse } from '../scripts/lib/external-trust-checkpoint-contract.mjs';
import { createSqliteExternalCheckpointTransition, SQLITE_EXTERNAL_CHECKPOINT_SCHEMA } from '../scripts/lib/sqlite-external-checkpoint-transition.mjs';

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
  if (!Object.hasOwn(overrides, 'checkpoint_digest')) payload.checkpoint_digest = computeExternalTrustCheckpointDigest(payload);
  const signature = sign(null, Buffer.from(canonicalExternalCheckpointPayload(payload)), privateKey).toString('base64');
  return { ...payload, signature_base64: signature };
}

function checkpointTransitionStore(initialSequence = 6, initialDigest = previousCheckpointDigest) {
  const consumed = new Set();
  const state = { authorityId: 'test-only-checkpoint-authority', candidateSha256, rollbackSha256,
    highWaterSequence: initialSequence, lastCheckpointDigest: initialDigest };
  return {
    state,
    commit({ requestNonce, authorityId, candidateSha256: suppliedCandidateSha256,
      rollbackSha256: suppliedRollbackSha256, expectedHighWaterSequence, expectedPreviousCheckpointDigest,
      checkpointSequence, checkpointDigest, previousCheckpointDigest: suppliedPreviousDigest }) {
      // Test-only synchronous CAS model. It does not prove cross-process or
      // durable-store atomicity; production requires a host-owned transaction.
      if (authorityId !== state.authorityId || suppliedCandidateSha256 !== state.candidateSha256 ||
          suppliedRollbackSha256 !== state.rollbackSha256 || consumed.has(requestNonce) ||
          state.highWaterSequence !== expectedHighWaterSequence ||
          state.lastCheckpointDigest !== expectedPreviousCheckpointDigest ||
          checkpointSequence !== state.highWaterSequence + 1 ||
          suppliedPreviousDigest !== state.lastCheckpointDigest) return false;
      consumed.add(requestNonce);
      state.highWaterSequence = checkpointSequence;
      state.lastCheckpointDigest = checkpointDigest;
      return true;
    }
  };
}

function verify(value, continuity = { source: 'host_monotonic_store', authorityId: 'test-only-checkpoint-authority',
  highWaterSequence: 6, lastCheckpointDigest: previousCheckpointDigest }, overrides = {}, transitionStore = checkpointTransitionStore()) {
  return verifyExternalTrustCheckpointResponse(value, {
    authorityPublicKeyPem,
    expectedAuthorityId: 'test-only-checkpoint-authority',
    requestNonce: '0123456789abcdef0123456789abcdef',
    candidateSha256, rollbackSha256, continuity, now: NOW, ...overrides,
    commitCheckpointTransition: transitionStore.commit.bind(transitionStore)
  });
}

test('verifies exact signed checkpoint challenge, release binding, freshness and monotonic continuity', () => {
  const result = verify(response());
  assert.equal(result.verified, true);
  assert.equal(result.signatureVerified, true);
  assert.equal(result.cryptographicResponseVerified, true);
  assert.equal(result.nonceConsumed, true);
  assert.equal(result.checkpointStateAdvanced, true);
  assert.equal(result.continuityContractValid, true);
  assert.equal(result.checkpointSequence, 7);
  assert.equal(result.continuitySourceAuthenticated, false);
  assert.equal(result.authorityKeyProvisioningAuthenticated, false);
  assert.equal(result.productionAuthorityEstablished, false,
    'test-local signing key and continuity object must never establish host production authority');
});

test('rejects signature tampering and signed release/hash substitution', () => {
  const signed = response();
  assert.ok(verify({ ...signed, ledger_state_sha256: '0'.repeat(64) }).blockers.includes('EXTERNAL_CHECKPOINT_SIGNATURE_INVALID'));
  assert.ok(verify(response({ candidate_sha256: '0'.repeat(64) })).blockers.includes('EXTERNAL_CHECKPOINT_RELEASE_BINDING_MISMATCH'));
  assert.ok(verify(response(), undefined, { rollbackSha256: '9'.repeat(64) }).blockers.includes('EXTERNAL_CHECKPOINT_RELEASE_BINDING_MISMATCH'));
});

test('rejects signed checkpoints whose declared digest does not bind checkpoint sequence, state, and release hashes', () => {
  const good = response();
  assert.equal(good.checkpoint_digest, computeExternalTrustCheckpointDigest(good));
  const wrongDigest = response({ checkpoint_digest: '9'.repeat(64) });
  const result = verify(wrongDigest);
  assert.equal(result.signatureVerified, true, 'fixture must prove this is not merely a bad signature');
  assert.ok(result.blockers.includes('EXTERNAL_CHECKPOINT_DIGEST_MISMATCH'));
  assert.equal(result.verified, false);
});

test('rejects nonce mismatch, stale checkpoint, rollback and broken chain continuity', () => {
  assert.ok(verify(response(), undefined, { requestNonce: 'f'.repeat(32) }).blockers.includes('EXTERNAL_CHECKPOINT_CHALLENGE_MISMATCH'));
  assert.ok(verify(response({ observed_at: new Date(NOW - 6 * 60_000).toISOString() })).blockers.includes('EXTERNAL_CHECKPOINT_STALE_OR_NONCANONICAL'));
  assert.ok(verify(response(), { source: 'host_monotonic_store', authorityId: 'test-only-checkpoint-authority',
    highWaterSequence: 7, lastCheckpointDigest: 'c'.repeat(64) }).blockers.includes('EXTERNAL_CHECKPOINT_ANTI_ROLLBACK_FAILED'));
  assert.ok(verify(response(), { source: 'host_monotonic_store', authorityId: 'test-only-checkpoint-authority',
    highWaterSequence: 6, lastCheckpointDigest: '9'.repeat(64) }).blockers.includes('EXTERNAL_CHECKPOINT_CHAIN_DISCONTINUITY'));
  assert.ok(verify(response(), { source: 'host_monotonic_store', authorityId: 'test-only-checkpoint-authority',
    highWaterSequence: 5, lastCheckpointDigest: previousCheckpointDigest }).blockers.includes('EXTERNAL_CHECKPOINT_SEQUENCE_GAP'));
  assert.ok(verify(response(), { source: 'host_monotonic_store', authorityId: 'test-only-checkpoint-authority',
    highWaterSequence: 0, lastCheckpointDigest: previousCheckpointDigest }).blockers.includes('EXTERNAL_CHECKPOINT_CONTINUITY_SOURCE_UNVERIFIED'));
});

test('a cryptographically valid response cannot replay and checkpoint high-water advances atomically', () => {
  const signed = response();
  const store = checkpointTransitionStore();
  const first = verify(signed, undefined, {}, store);
  assert.equal(first.verified, true);
  assert.equal(first.nonceConsumed, true);
  assert.equal(first.checkpointStateAdvanced, true);
  assert.equal(store.state.highWaterSequence, 7);
  assert.equal(store.state.lastCheckpointDigest, signed.checkpoint_digest);

  const replay = verify(signed, undefined, {}, store);
  assert.equal(replay.cryptographicResponseVerified, true,
    'the exact response remains cryptographically valid; replay rejection is a separate stateful acceptance predicate');
  assert.equal(replay.nonceConsumed, false);
  assert.equal(replay.checkpointStateAdvanced, false);
  assert.equal(replay.verified, false);
  assert.ok(replay.blockers.includes('EXTERNAL_CHECKPOINT_ATOMIC_TRANSITION_REJECTED'));
  assert.equal(replay.productionAuthorityEstablished, false);
});

test('checkpoint response remains blocked when no atomic nonce-and-high-water transition is provisioned', () => {
  const signed = response();
  const result = verifyExternalTrustCheckpointResponse(signed, {
    authorityPublicKeyPem, expectedAuthorityId: 'test-only-checkpoint-authority',
    requestNonce: '0123456789abcdef0123456789abcdef', candidateSha256, rollbackSha256,
    continuity: { source: 'host_monotonic_store', authorityId: 'test-only-checkpoint-authority',
      highWaterSequence: 6, lastCheckpointDigest: previousCheckpointDigest }, now: NOW
  });
  assert.equal(result.cryptographicResponseVerified, true);
  assert.equal(result.nonceConsumed, false);
  assert.equal(result.verified, false);
  assert.ok(result.blockers.includes('EXTERNAL_CHECKPOINT_NONCE_CONSUMER_NOT_CONFIGURED'));
});

test('legacy nonce-only callbacks cannot pass because they do not atomically advance checkpoint state', () => {
  let called = false;
  const result = verifyExternalTrustCheckpointResponse(response(), {
    authorityPublicKeyPem, expectedAuthorityId: 'test-only-checkpoint-authority',
    requestNonce: '0123456789abcdef0123456789abcdef', candidateSha256, rollbackSha256,
    continuity: { source: 'host_monotonic_store', authorityId: 'test-only-checkpoint-authority',
      highWaterSequence: 6, lastCheckpointDigest: previousCheckpointDigest }, now: NOW,
    consumeRequestNonce() { called = true; return true; }
  });
  assert.equal(called, false, 'do not burn nonce in a separate non-atomic operation');
  assert.equal(result.verified, false);
  assert.ok(result.blockers.includes('EXTERNAL_CHECKPOINT_ATOMIC_TRANSITION_NOT_CONFIGURED'));
});

test('concurrent checkpoint commits from the same high-water admit only one winner', async () => {
  const store = checkpointTransitionStore();
  const firstResponse = response();
  const secondResponse = response({ request_nonce: 'fedcba9876543210fedcba9876543210' });
  const verifyWithNonce = value => verifyExternalTrustCheckpointResponse(value, {
    authorityPublicKeyPem, expectedAuthorityId: 'test-only-checkpoint-authority',
    requestNonce: value.request_nonce, candidateSha256, rollbackSha256,
    continuity: { source: 'host_monotonic_store', authorityId: 'test-only-checkpoint-authority',
      highWaterSequence: 6, lastCheckpointDigest: previousCheckpointDigest }, now: NOW,
    commitCheckpointTransition: store.commit.bind(store)
  });
  const results = await Promise.all([Promise.resolve().then(() => verifyWithNonce(firstResponse)),
    Promise.resolve().then(() => verifyWithNonce(secondResponse))]);
  assert.equal(results.filter(result => result.verified).length, 1);
  assert.equal(store.state.highWaterSequence, 7);
  assert.equal(results.filter(result => result.blockers.includes('EXTERNAL_CHECKPOINT_ATOMIC_TRANSITION_REJECTED')).length, 1);
});

test('SQLite checkpoint adapter atomically binds nonce and high-water across independent connections and reopen', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-external-checkpoint-cas-'));
  fs.chmodSync(directory, 0o700);
  const databasePath = path.join(directory, 'host-checkpoint-test-only.db');
  const authorityId = 'test-only-checkpoint-authority';
  const candidate = 'a'.repeat(64);
  const rollback = 'b'.repeat(64);
  const priorDigest = 'd'.repeat(64);
  const firstResponse = response({ request_nonce: '0123456789abcdef0123456789abcdef' });
  const nextDigest = firstResponse.checkpoint_digest;
  const first = new DatabaseSync(databasePath);
  first.exec(SQLITE_EXTERNAL_CHECKPOINT_SCHEMA);
  first.prepare(`INSERT INTO external_trust_checkpoint_state
    (authority_id,candidate_sha256,rollback_sha256,high_water_sequence,last_checkpoint_digest) VALUES(?,?,?,?,?)`)
    .run(authorityId, candidate, rollback, 6, priorDigest);
  const second = new DatabaseSync(databasePath);
  t.after(() => {
    try { first.close(); } catch {}
    try { second.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const transitionA = createSqliteExternalCheckpointTransition(first, { now: () => NOW });
  const transitionB = createSqliteExternalCheckpointTransition(second, { now: () => NOW });
  const input = nonce => ({ requestNonce: nonce, authorityId, candidateSha256: candidate, rollbackSha256: rollback,
    expectedHighWaterSequence: 6, expectedPreviousCheckpointDigest: priorDigest,
    checkpointSequence: 7, checkpointDigest: nextDigest, previousCheckpointDigest: priorDigest });

  const continuity = { source: 'host_monotonic_store', authorityId, highWaterSequence: 6, lastCheckpointDigest: priorDigest };
  const firstVerification = verifyExternalTrustCheckpointResponse(firstResponse, {
    authorityPublicKeyPem, expectedAuthorityId: authorityId, requestNonce: firstResponse.request_nonce,
    candidateSha256: candidate, rollbackSha256: rollback, continuity, now: NOW,
    commitCheckpointTransition: transitionA
  });
  assert.equal(firstVerification.verified, true, JSON.stringify(firstVerification.blockers));
  assert.equal(firstVerification.checkpointStateAdvanced, true);
  const secondResponse = response({ request_nonce: 'fedcba9876543210fedcba9876543210' });
  assert.equal(secondResponse.checkpoint_digest, nextDigest);
  const secondVerification = verifyExternalTrustCheckpointResponse(secondResponse, {
    authorityPublicKeyPem, expectedAuthorityId: authorityId, requestNonce: secondResponse.request_nonce,
    candidateSha256: candidate, rollbackSha256: rollback, continuity, now: NOW,
    commitCheckpointTransition: transitionB
  });
  assert.equal(secondVerification.verified, false);
  assert.ok(secondVerification.blockers.includes('EXTERNAL_CHECKPOINT_ATOMIC_TRANSITION_REJECTED'),
    'a second connection cannot advance from a stale high-water snapshot');
  assert.equal(transitionB(input('0123456789abcdef0123456789abcdef')), false,
    'the nonce and checkpoint sequence are durably consumed together');
  const committedState = first.prepare('SELECT high_water_sequence,last_checkpoint_digest FROM external_trust_checkpoint_state WHERE authority_id=?')
    .get(authorityId);
  assert.equal(committedState.high_water_sequence, 7);
  assert.equal(committedState.last_checkpoint_digest, nextDigest);
  assert.equal(first.prepare('SELECT COUNT(*) AS n FROM external_trust_checkpoint_nonces WHERE authority_id=?').get(authorityId).n, 1);

  first.close();
  const reopened = new DatabaseSync(databasePath);
  try {
    const afterRestart = createSqliteExternalCheckpointTransition(reopened, { now: () => NOW });
    assert.equal(afterRestart(input('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')), false,
      'durable high-water must survive connection/runtime reopen and prevent replay from old state');
    assert.equal(reopened.prepare('SELECT high_water_sequence FROM external_trust_checkpoint_state WHERE authority_id=?').get(authorityId).high_water_sequence, 7);
  } finally { reopened.close(); }
});

test('refuses unverified local continuity and invalid verifier roots', () => {
  const local = verify(response(), { source: 'local_json_file', authorityId: 'test-only-checkpoint-authority',
    highWaterSequence: 6, lastCheckpointDigest: previousCheckpointDigest });
  assert.equal(local.verified, false);
  assert.ok(local.blockers.includes('EXTERNAL_CHECKPOINT_CONTINUITY_SOURCE_UNVERIFIED'));
  assert.ok(verify({ ...response(), unexpected_field: 'not part of v1 contract' }).blockers.includes('EXTERNAL_CHECKPOINT_SCHEMA_INVALID'));
  assert.ok(verify({ ...response(), signature_base64: 'AAAA' }).blockers.includes('EXTERNAL_CHECKPOINT_SIGNATURE_ENCODING_INVALID'));
  const wrongKey = verifyExternalTrustCheckpointResponse(response(), { authorityPublicKeyPem: 'not a key',
    expectedAuthorityId: 'test-only-checkpoint-authority', requestNonce: '0123456789abcdef0123456789abcdef',
    candidateSha256, rollbackSha256,
    continuity: { source: 'host_monotonic_store', authorityId: 'test-only-checkpoint-authority', highWaterSequence: 6,
      lastCheckpointDigest: previousCheckpointDigest }, now: NOW });
  assert.equal(wrongKey.verified, false);
  assert.ok(wrongKey.blockers.includes('EXTERNAL_CHECKPOINT_VERIFIER_CONFIGURATION_INVALID'));
  assert.equal(wrongKey.productionAuthorityEstablished, false);
});

test('rejects caller-supplied clock settings that could widen or disable the freshness contract', () => {
  const signed = response();
  for (const maxAgeMs of [0, -1, 300_001, Number.MAX_SAFE_INTEGER, Infinity, NaN, 1.5]) {
    const result = verify(signed, undefined, { maxAgeMs });
    assert.equal(result.verified, false, `maxAgeMs=${String(maxAgeMs)} must fail closed`);
    assert.ok(result.blockers.includes('EXTERNAL_CHECKPOINT_VERIFIER_CONFIGURATION_INVALID'));
  }
  const invalidClock = verify(signed, undefined, { now: Number.POSITIVE_INFINITY });
  assert.equal(invalidClock.verified, false);
  assert.ok(invalidClock.blockers.includes('EXTERNAL_CHECKPOINT_VERIFIER_CONFIGURATION_INVALID'));
});

test('rejects hostile object graphs before reading checkpoint or continuity fields', () => {
  let getterCalls = 0;
  const hostileResponse = response();
  Object.defineProperty(hostileResponse, 'ledger_state_sha256', {
    enumerable: true, configurable: true,
    get() { getterCalls++; return 'e'.repeat(64); }
  });
  const result = verify(hostileResponse);
  assert.equal(getterCalls, 0, 'untrusted accessors must never execute during verification');
  assert.deepEqual(result.blockers, ['EXTERNAL_CHECKPOINT_JSON_INVALID']);
  assert.equal(result.verified, false);

  let continuityGetterCalls = 0;
  const hostileContinuity = { source: 'host_monotonic_store', authorityId: 'test-only-checkpoint-authority',
    highWaterSequence: 6, lastCheckpointDigest: previousCheckpointDigest };
  Object.defineProperty(hostileContinuity, 'highWaterSequence', {
    enumerable: true, configurable: true,
    get() { continuityGetterCalls++; return 6; }
  });
  assert.deepEqual(verify(response(), hostileContinuity).blockers, ['EXTERNAL_CHECKPOINT_JSON_INVALID']);
  assert.equal(continuityGetterCalls, 0, 'caller-supplied continuity accessors must never execute');

  const hidden = { visible: true };
  Object.defineProperty(hidden, 'security_critical_hidden', { value: true, enumerable: false });
  assert.throws(() => canonicalExternalCheckpointPayload(hidden), /accessors or hidden properties/);
  const shared = { digest: 'a'.repeat(64) };
  assert.throws(() => canonicalExternalCheckpointPayload({ first: shared, second: shared }), /acyclic JSON data/);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => canonicalExternalCheckpointPayload(cyclic), /acyclic JSON data/);
  const decorated = [1, 2]; decorated.extra = true;
  assert.throws(() => canonicalExternalCheckpointPayload(decorated), /dense plain arrays/);
  const symbolKey = { ok: true }; symbolKey[Symbol('security')] = false;
  assert.throws(() => canonicalExternalCheckpointPayload(symbolKey), /symbol\/prototype keys/);
});
