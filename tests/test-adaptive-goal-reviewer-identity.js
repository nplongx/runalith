import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { canonicalJson } from '../src/runtime/workflow/plan.js';
import { adaptiveGoalPublicKeyFingerprint } from '../src/runtime/adaptive-goal-trust-configuration.js';
import {
  ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT,
  ADAPTIVE_GOAL_REVIEWER_AUTHORIZATION_SCOPE,
  assertAdaptiveGoalReviewerAttestation,
  ingestAdaptiveGoalReviewerAttestation,
  getAdaptiveGoalReviewerConfigurationStatus,
  expectedAdaptiveGoalReviewerAttestationCandidate,
  configureAdaptiveGoalTrustConfigurationLedger
} from '../src/runtime/adaptive-goal-reviewer-identity.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const PROVIDER_ID = 'integration-test-identity-provider';
const JOB_ID = 'job_123e4567-e89b-42d3-a456-426614174000';
const keyPair = generateKeyPairSync('ed25519');
const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' });
const otherKeyPair = generateKeyPairSync('ed25519');
const now = Date.now();

function candidateFixture() {
  return {
    candidateId: 'agg-epc-0123456789abcdef01234567',
    fingerprint: sha('candidate-fingerprint'),
    candidateHash: sha('candidate-hash'),
    executionPlan: { plan_hash: sha('immutable-plan-hash') },
    hashes: {
      reviewedActionIntentHash: sha('reviewed-action-intent'),
      reviewedTaskInputContractHash: sha('reviewed-input-contract'),
      roleContractHash: sha('role-contracts'),
      semanticPolicyVersion: 1,
      semanticVerificationHash: sha('semantic-verification')
    },
    reviewedTaskInputs: { review: { reviewerId: 'provider-subject-01' } }
  };
}

function storeFixture() {
  const db = new DatabaseSync(':memory:');
  const trustDb = new DatabaseSync(':memory:');
  configureAdaptiveGoalTrustConfigurationLedger(trustDb);
  db.exec(`CREATE TABLE events (
    event_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT '2026-10-21T00:00:00.000Z'
  )`);
  return { db, trustDb };
}

function closeStore(store) {
  store.db.close();
  store.trustDb.close();
}

function environment(t, { configured = true, trustedPem = publicKeyPem } = {}) {
  const oldProvider = process.env.AGG_REVIEW_IDENTITY_PROVIDER_ID;
  const oldRoot = process.env.AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM;
  const oldConfig = process.env.AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON;
  if (configured) {
    delete process.env.AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON;
    process.env.AGG_REVIEW_IDENTITY_PROVIDER_ID = PROVIDER_ID;
    process.env.AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM = trustedPem;
  } else {
    delete process.env.AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON;
    delete process.env.AGG_REVIEW_IDENTITY_PROVIDER_ID;
    delete process.env.AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM;
  }
  t.after(() => {
    if (oldProvider === undefined) delete process.env.AGG_REVIEW_IDENTITY_PROVIDER_ID;
    else process.env.AGG_REVIEW_IDENTITY_PROVIDER_ID = oldProvider;
    if (oldRoot === undefined) delete process.env.AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM;
    else process.env.AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM = oldRoot;
    if (oldConfig === undefined) delete process.env.AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON;
    else process.env.AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON = oldConfig;
  });
}

function signedAttestation(candidate, jobId = JOB_ID, {
  signingKey = keyPair.privateKey,
  scope = ADAPTIVE_GOAL_REVIEWER_AUTHORIZATION_SCOPE,
  issuedAt = new Date(now - 5000).toISOString(),
  expiresAt = new Date(now + 4 * 60_000).toISOString(),
  nonce = randomUUID(),
  decision = 'reviewed_for_candidate_only',
  rootPem = publicKeyPem,
  trustRootSha256 = sha(rootPem),
  providerId = PROVIDER_ID
} = {}) {
  const unsigned = {
    schema_version: 1,
    kind: 'adaptive_goal_verified_reviewer_attestation',
    provider_id: providerId,
    trust_root_sha256: trustRootSha256,
    nonce,
    issued_at: issuedAt,
    expires_at: expiresAt,
    reviewer_subject: 'provider-subject-01',
    scope,
    decision,
    candidate: expectedAdaptiveGoalReviewerAttestationCandidate(jobId, candidate),
    signature_algorithm: 'Ed25519'
  };
  return {
    ...unsigned,
    signature: sign(null, Buffer.from(canonicalJson(unsigned), 'utf8'), signingKey).toString('base64')
  };
}

function persistAttestation(store, attestation, jobId = JOB_ID) {
  const candidateFingerprint = attestation.candidate.candidate_fingerprint;
  const eventId = sha(`${jobId}|${ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT}|${candidateFingerprint}`);
  store.db.prepare('INSERT INTO events(event_id,job_id,type,payload_json) VALUES(?,?,?,?)')
    .run(eventId, jobId, ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT, JSON.stringify(attestation));
  return eventId;
}

test('reviewer attestation validates only with configured trust root and exact candidate fingerprints', t => {
  environment(t);
  const store = storeFixture();
  t.after(() => closeStore(store));
  const candidate = candidateFixture();
  const attestation = signedAttestation(candidate);
  const eventId = persistAttestation(store, attestation);
  const result = assertAdaptiveGoalReviewerAttestation(store, JOB_ID, candidate, { now });
  assert.equal(result.verified, true);
  assert.equal(result.providerId, PROVIDER_ID);
  assert.equal(result.authorizationScope, ADAPTIVE_GOAL_REVIEWER_AUTHORIZATION_SCOPE);
  assert.equal(result.immutablePlanHash, candidate.executionPlan.plan_hash);
  assert.equal(result.attestationEventId, eventId);
});

test('reviewer anti-rollback never falls back to the workflow database when the dedicated trust ledger is absent or aliased', t => {
  environment(t);
  const store = storeFixture();
  t.after(() => closeStore(store));
  const candidate = candidateFixture();
  persistAttestation(store, signedAttestation(candidate));

  assert.throws(() => assertAdaptiveGoalReviewerAttestation(store, JOB_ID, candidate, {
    now, trustConfigurationDb: null
  }), error => error.code === 'AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE');
  assert.throws(() => assertAdaptiveGoalReviewerAttestation(store, JOB_ID, candidate, {
    now, trustConfigurationDb: store.db
  }), error => error.code === 'AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE');
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='adaptive_goal_trust_configuration_history'").get(), undefined,
    'workflow database must not be silently converted into the trust-ledger database');
});

test('reviewer configuration diagnostics report unavailable without anti-rollback ledger instead of trusting the public key alone', t => {
  environment(t);
  const status = getAdaptiveGoalReviewerConfigurationStatus({ now, trustConfigurationDb: null });
  assert.equal(status.available, false);
  assert.equal(status.antiRollback.status, 'unavailable');
  assert.ok(status.blockers.some(item => item.code === 'AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE'));
});

test('blank optional Goal/Idea verifier user_config does not disable independently configured reviewer identity status', t => {
  environment(t);
  const names = ['AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON', 'AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID',
    'AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON = '';
  process.env.AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID = 'ignored-because-json-field-is-blank';
  process.env.AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM = publicKeyPem;
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
  const store = storeFixture();
  t.after(() => closeStore(store));
  const status = getAdaptiveGoalReviewerConfigurationStatus({ now, trustConfigurationDb: store.trustDb });
  assert.equal(status.available, true, JSON.stringify(status));
  assert.equal(status.providerId, PROVIDER_ID);
  assert.equal(status.configurationSource, 'legacy_single_key_environment');
});

test('administered reviewer trust configuration loads a rotated key and revocation disables persisted reviewer identity', t => {
  const oldConfig = process.env.AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON;
  const oldProvider = process.env.AGG_REVIEW_IDENTITY_PROVIDER_ID;
  const oldRoot = process.env.AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM;
  const oldSourceConfig = process.env.AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON;
  const oldSourceProvider = process.env.AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID;
  const oldSourceRoot = process.env.AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM;
  const rotated = generateKeyPairSync('ed25519');
  const rotatedPem = rotated.publicKey.export({ type: 'spki', format: 'pem' });
  const providerId = 'independent-action-reviewer-provider';
  const nowIso = new Date(now - 1000).toISOString();
  const makeConfig = (version, revokedAt = null) => ({
    schema_version: 1, domain: 'action_intent_reviewer', provider_id: providerId, config_version: version,
    updated_at: nowIso, updated_by: 'identity-admin-fixture', change_reference: `IDP-SEC-${version}`,
    keys: [
      { key_id: 'reviewer-primary', public_key_pem: publicKeyPem, scopes: [ADAPTIVE_GOAL_REVIEWER_AUTHORIZATION_SCOPE], not_before: new Date(now - 60_000).toISOString(), not_after: null, revoked_at: null },
      { key_id: 'reviewer-rotated', public_key_pem: rotatedPem, scopes: [ADAPTIVE_GOAL_REVIEWER_AUTHORIZATION_SCOPE], not_before: new Date(now - 60_000).toISOString(), not_after: null, revoked_at: revokedAt }
    ]
  });
  process.env.AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON = JSON.stringify(makeConfig(1));
  delete process.env.AGG_REVIEW_IDENTITY_PROVIDER_ID;
  delete process.env.AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM;
  delete process.env.AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON;
  delete process.env.AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID;
  delete process.env.AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM;
  t.after(() => {
    if (oldConfig === undefined) delete process.env.AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON; else process.env.AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON = oldConfig;
    if (oldProvider === undefined) delete process.env.AGG_REVIEW_IDENTITY_PROVIDER_ID; else process.env.AGG_REVIEW_IDENTITY_PROVIDER_ID = oldProvider;
    if (oldRoot === undefined) delete process.env.AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM; else process.env.AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM = oldRoot;
    if (oldSourceConfig === undefined) delete process.env.AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON; else process.env.AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON = oldSourceConfig;
    if (oldSourceProvider === undefined) delete process.env.AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID; else process.env.AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID = oldSourceProvider;
    if (oldSourceRoot === undefined) delete process.env.AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM; else process.env.AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM = oldSourceRoot;
  });

  const store = storeFixture(); t.after(() => closeStore(store));
  const candidate = candidateFixture();
  const attestation = signedAttestation(candidate, JOB_ID, { signingKey: rotated.privateKey, rootPem: rotatedPem,
    trustRootSha256: adaptiveGoalPublicKeyFingerprint(rotatedPem), providerId });
  persistAttestation(store, attestation);
  const verified = assertAdaptiveGoalReviewerAttestation(store, JOB_ID, candidate, { now });
  assert.equal(verified.verified, true);
  assert.equal(verified.trustKeyId, 'reviewer-rotated');
  assert.equal(verified.trustConfigVersion, 1);
  assert.equal(verified.configurationChangeReference, 'IDP-SEC-1');

  process.env.AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON = JSON.stringify(makeConfig(2, new Date(now - 1000).toISOString()));
  assert.throws(() => assertAdaptiveGoalReviewerAttestation(store, JOB_ID, candidate, { now }), /revoked/);
  process.env.AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON = JSON.stringify(makeConfig(1));
  assert.throws(() => assertAdaptiveGoalReviewerAttestation(store, JOB_ID, candidate, { now }), /rollback/);
});

test('caller claims without a configured provider/trust root never establish reviewer identity', t => {
  environment(t, { configured: false });
  const store = storeFixture();
  t.after(() => closeStore(store));
  const candidate = candidateFixture();
  persistAttestation(store, signedAttestation(candidate));
  assert.throws(() => assertAdaptiveGoalReviewerAttestation(store, JOB_ID, candidate, { now }), /trust root is not configured/);
});

test('wrong trust root and signature from a non-trusted key are rejected', t => {
  environment(t);
  const store = storeFixture();
  t.after(() => closeStore(store));
  const candidate = candidateFixture();
  persistAttestation(store, signedAttestation(candidate, JOB_ID, { signingKey: otherKeyPair.privateKey }));
  assert.throws(() => assertAdaptiveGoalReviewerAttestation(store, JOB_ID, candidate, { now }), /signature does not verify/);

  store.db.exec('DELETE FROM events');
  const attestation = signedAttestation(candidate);
  persistAttestation(store, attestation);
  environment(t, { trustedPem: otherKeyPair.publicKey.export({ type: 'spki', format: 'pem' }) });
  assert.throws(() => assertAdaptiveGoalReviewerAttestation(store, JOB_ID, candidate, { now }), /trust root/);
});

test('reviewer without required scope, stale/future proof, or mismatched candidate/plan is rejected', t => {
  environment(t);
  const store = storeFixture();
  t.after(() => closeStore(store));
  const candidate = candidateFixture();
  persistAttestation(store, signedAttestation(candidate, JOB_ID, { scope: 'workflow.read' }));
  assert.throws(() => assertAdaptiveGoalReviewerAttestation(store, JOB_ID, candidate, { now }), /scope/);

  store.db.exec('DELETE FROM events');
  persistAttestation(store, signedAttestation(candidate, JOB_ID, { expiresAt: new Date(now - 1000).toISOString() }));
  assert.throws(() => assertAdaptiveGoalReviewerAttestation(store, JOB_ID, candidate, { now }), /stale, expired/);

  store.db.exec('DELETE FROM events');
  const validForOldPlan = signedAttestation(candidate);
  persistAttestation(store, validForOldPlan);
  const changedCandidate = structuredClone(candidate);
  changedCandidate.executionPlan.plan_hash = sha('new-plan-hash-after-review');
  assert.throws(() => assertAdaptiveGoalReviewerAttestation(store, JOB_ID, changedCandidate, { now }), /exact candidate/);
});

test('reviewer nonce replay across jobs and multiple same-candidate attestations are rejected', t => {
  environment(t);
  const store = storeFixture();
  t.after(() => closeStore(store));
  const candidate = candidateFixture();
  const attestation = signedAttestation(candidate);
  persistAttestation(store, attestation, JOB_ID);
  persistAttestation(store, attestation, 'job_123e4567-e89b-42d3-a456-426614174001');
  assert.throws(() => assertAdaptiveGoalReviewerAttestation(store, JOB_ID, candidate, { now }), /nonce has been replayed/);
});

function sourceVerificationFixture() {
  return {
    providerId: 'independent-source-verifier-fixture',
    attestationId: sha('source-attestation'),
    snapshotHash: sha('current-source-snapshot'),
    evidenceManifestHash: sha('source-evidence-manifest'),
    trustRootSha256: sha('source-verifier-root'),
    expiresAt: new Date(now + 5 * 60_000).toISOString()
  };
}

function currentCandidateReadback(store, jobId, candidate) {
  const rows = store.db.prepare(`SELECT event_id,job_id,type,payload_json FROM events
    WHERE job_id=? AND type=? ORDER BY created_at ASC,rowid ASC`)
    .all(jobId, ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT);
  let verified = null;
  if (rows.length === 1) {
    try { verified = assertAdaptiveGoalReviewerAttestation(store, jobId, candidate, { now, trustConfigurationDb: store.trustDb }); }
    catch {}
  }
  return {
    found: true,
    status: 'fresh',
    candidate,
    candidateHash: candidate.candidateHash,
    fingerprint: candidate.fingerprint,
    wrapperState: 'IDLE',
    wrapperApproved: false,
    immutablePlanPinned: false,
    taskRowsCreated: false,
    dispatchStarted: false,
    approvalCount: 0,
    reviewerIdentityVerified: Boolean(verified?.verified),
    reviewerAttestation: verified ? { attestationEventId: verified.attestationEventId } : null,
    executionReviewReady: Boolean(verified?.verified && candidate.reviewedTaskInputs?.gates?.actionIntentSemanticEquivalenceVerified === true),
    sourceGraphVerification: sourceVerificationFixture()
  };
}

test('runtime reviewer ingestion atomically persists one provider-signed exact-candidate assertion and is idempotent on exact retry', t => {
  environment(t);
  const store = storeFixture();
  t.after(() => closeStore(store));
  const candidate = candidateFixture();
  candidate.reviewedTaskInputs.gates = { actionIntentSemanticEquivalenceVerified: true };
  const attestation = signedAttestation(candidate);
  const options = { now, trustConfigurationDb: store.trustDb,
    loadCurrentCandidate: () => currentCandidateReadback(store, JOB_ID, candidate) };

  const first = ingestAdaptiveGoalReviewerAttestation(store, JOB_ID, attestation, options);
  assert.equal(first.stored, true);
  assert.equal(first.idempotent, false);
  assert.equal(first.verified, true);
  assert.equal(first.approvalGranted, false);
  assert.equal(first.dispatchStarted, false);
  assert.equal(first.executionAuthorized, false);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM events WHERE job_id=? AND type=?')
    .get(JOB_ID, ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT).count, 1);

  const retry = ingestAdaptiveGoalReviewerAttestation(store, JOB_ID, attestation, options);
  assert.equal(retry.stored, false);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.attestationEventId, first.attestationEventId);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM events WHERE job_id=? AND type=?')
    .get(JOB_ID, ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT).count, 1,
  'exact retry must read back the prior signed assertion without creating a second durable record');
});

test('runtime reviewer ingestion rolls back invalid signatures and candidate/plan mismatches', t => {
  environment(t);
  const store = storeFixture();
  t.after(() => closeStore(store));
  const candidate = candidateFixture();
  candidate.reviewedTaskInputs.gates = { actionIntentSemanticEquivalenceVerified: true };
  const options = { now, trustConfigurationDb: store.trustDb,
    loadCurrentCandidate: () => currentCandidateReadback(store, JOB_ID, candidate) };
  const invalidSignature = signedAttestation(candidate, JOB_ID, { signingKey: otherKeyPair.privateKey });
  assert.throws(() => ingestAdaptiveGoalReviewerAttestation(store, JOB_ID, invalidSignature, options), /signature does not verify/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM events WHERE type=?').get(ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT).count, 0,
    'invalid signature must not leave a durable reviewer assertion');

  const oldPlanAttestation = signedAttestation(candidate);
  candidate.executionPlan.plan_hash = sha('mutated-current-plan-after-signing');
  assert.throws(() => ingestAdaptiveGoalReviewerAttestation(store, JOB_ID, oldPlanAttestation, options), /does not bind the exact candidate/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM events WHERE type=?').get(ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT).count, 0,
    'plan mismatch must roll back the candidate-bound attestation event');
});

test('runtime reviewer ingestion rejects nonce replay across distinct candidate jobs without persisting the second event', t => {
  environment(t);
  const store = storeFixture();
  t.after(() => closeStore(store));
  const candidate = candidateFixture();
  candidate.reviewedTaskInputs.gates = { actionIntentSemanticEquivalenceVerified: true };
  const firstAttestation = signedAttestation(candidate);
  const firstOptions = { now, trustConfigurationDb: store.trustDb,
    loadCurrentCandidate: () => currentCandidateReadback(store, JOB_ID, candidate) };
  ingestAdaptiveGoalReviewerAttestation(store, JOB_ID, firstAttestation, firstOptions);

  const secondJobId = 'job_123e4567-e89b-42d3-a456-426614174001';
  const secondAttestation = signedAttestation(candidate, secondJobId, { nonce: firstAttestation.nonce });
  const secondOptions = { now, trustConfigurationDb: store.trustDb,
    loadCurrentCandidate: () => currentCandidateReadback(store, secondJobId, candidate) };
  assert.throws(() => ingestAdaptiveGoalReviewerAttestation(store, secondJobId, secondAttestation, secondOptions), /nonce already exists/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM events WHERE job_id=? AND type=?')
    .get(secondJobId, ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT).count, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM events WHERE type=?')
    .get(ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT).count, 1);
});

test('runtime reviewer ingestion refuses stale source snapshots and already-approved lifecycle state', t => {
  environment(t);
  const store = storeFixture();
  t.after(() => closeStore(store));
  const candidate = candidateFixture();
  const attestation = signedAttestation(candidate);
  const staleOptions = { now, trustConfigurationDb: store.trustDb,
    loadCurrentCandidate: () => ({ ...currentCandidateReadback(store, JOB_ID, candidate),
      sourceGraphVerification: { ...sourceVerificationFixture(), expiresAt: new Date(now - 1).toISOString() } }) };
  assert.throws(() => ingestAdaptiveGoalReviewerAttestation(store, JOB_ID, attestation, staleOptions), /freshly rebuilt candidate/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 0);

  const advancedOptions = { now, trustConfigurationDb: store.trustDb,
    loadCurrentCandidate: () => ({ ...currentCandidateReadback(store, JOB_ID, candidate), wrapperState: 'APPROVED', wrapperApproved: true }) };
  assert.throws(() => ingestAdaptiveGoalReviewerAttestation(store, JOB_ID, attestation, advancedOptions), /unapproved, unpinned, undispatched/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 0);
});
