import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

function observeReviewerTrust(store, observedAt = now) {
  const status = getAdaptiveGoalReviewerConfigurationStatus({ now: observedAt, trustConfigurationDb: store.trustDb });
  assert.ok(status.antiRollback?.latest, JSON.stringify(status));
  assert.equal(status.antiRollback.status, 'current_or_forward', JSON.stringify(status.antiRollback));
  assert.equal(status.audit?.versionRecorded, true, 'explicit host/admin status operation records the trust high-water mark');
  return status;
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
  observeReviewerTrust(store);
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

test('reviewer verification requires a prior explicit trust observation and never writes the anti-rollback ledger', t => {
  environment(t);
  const store = storeFixture();
  t.after(() => closeStore(store));
  const candidate = candidateFixture();
  const attestation = signedAttestation(candidate);
  persistAttestation(store, attestation);

  assert.throws(() => assertAdaptiveGoalReviewerAttestation(store, JOB_ID, candidate, { now }),
    error => error.code === 'AGG_TRUST_CONFIG_NOT_OBSERVED');
  assert.equal(store.trustDb.prepare('SELECT COUNT(*) AS count FROM adaptive_goal_trust_configuration_history').get().count, 0,
    'verification must not create an implicit trust observation');

  observeReviewerTrust(store);
  const before = store.trustDb.prepare('SELECT COUNT(*) AS count FROM adaptive_goal_trust_configuration_history').get().count;
  const verified = assertAdaptiveGoalReviewerAttestation(store, JOB_ID, candidate, { now });
  const after = store.trustDb.prepare('SELECT COUNT(*) AS count FROM adaptive_goal_trust_configuration_history').get().count;
  assert.equal(verified.verified, true);
  assert.equal(after, before, 'read-only signature verification must not mutate trust history');
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
  observeReviewerTrust(store);
  persistAttestation(store, attestation);
  const verified = assertAdaptiveGoalReviewerAttestation(store, JOB_ID, candidate, { now });
  assert.equal(verified.verified, true);
  assert.equal(verified.trustKeyId, 'reviewer-rotated');
  assert.equal(verified.trustConfigVersion, 1);
  assert.equal(verified.configurationChangeReference, 'IDP-SEC-1');

  process.env.AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON = JSON.stringify(makeConfig(2, new Date(now - 1000).toISOString()));
  const revokedStatus = observeReviewerTrust(store);
  assert.equal(revokedStatus.antiRollback.latest.config_version, 2);
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
  observeReviewerTrust(store);
  persistAttestation(store, signedAttestation(candidate, JOB_ID, { signingKey: otherKeyPair.privateKey }));
  assert.throws(() => assertAdaptiveGoalReviewerAttestation(store, JOB_ID, candidate, { now }), /signature does not verify/);

  store.db.exec('DELETE FROM events');
  const attestation = signedAttestation(candidate);
  persistAttestation(store, attestation);
  environment(t, { trustedPem: otherKeyPair.publicKey.export({ type: 'spki', format: 'pem' }) });
  const alternateTrustDb = new DatabaseSync(':memory:');
  configureAdaptiveGoalTrustConfigurationLedger(alternateTrustDb);
  t.after(() => alternateTrustDb.close());
  const alternateStatus = getAdaptiveGoalReviewerConfigurationStatus({ now, trustConfigurationDb: alternateTrustDb });
  assert.equal(alternateStatus.audit?.versionRecorded, true);
  assert.throws(() => assertAdaptiveGoalReviewerAttestation(store, JOB_ID, candidate, { now, trustConfigurationDb: alternateTrustDb }), /trust root/);
});

test('reviewer without required scope, stale/future proof, or mismatched candidate/plan is rejected', t => {
  environment(t);
  const store = storeFixture();
  t.after(() => closeStore(store));
  const candidate = candidateFixture();
  observeReviewerTrust(store);
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
  observeReviewerTrust(store);
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
  observeReviewerTrust(store);
  const candidate = candidateFixture();
  candidate.reviewedTaskInputs.gates = { actionIntentSemanticEquivalenceVerified: true };
  const attestation = signedAttestation(candidate);
  let readbackOverride = null;
  let candidateLoadCount = 0;
  const options = { now, trustConfigurationDb: store.trustDb,
    loadCurrentCandidate: () => {
      candidateLoadCount += 1;
      if (candidateLoadCount % 2 === 0 && readbackOverride) return readbackOverride;
      return currentCandidateReadback(store, JOB_ID, candidate);
    } };

  const first = ingestAdaptiveGoalReviewerAttestation(store, JOB_ID, attestation, options);
  assert.equal(first.stored, true);
  assert.equal(first.idempotent, false);
  assert.equal(first.verified, true);
  assert.equal(first.approvalGranted, false);
  assert.equal(first.dispatchStarted, false);
  assert.equal(first.executionAuthorized, false);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM events WHERE job_id=? AND type=?')
    .get(JOB_ID, ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT).count, 1);

  readbackOverride = { ...currentCandidateReadback(store, JOB_ID, candidate), executionReviewReady: false };
  assert.throws(() => ingestAdaptiveGoalReviewerAttestation(store, JOB_ID, attestation, options),
    /AGG_REVIEWER_ATTESTATION_INGEST_READBACK_MISMATCH/,
    'an exact signed retry must not claim success if semantic review readiness has fallen false');
  readbackOverride = {
    ...currentCandidateReadback(store, JOB_ID, candidate),
    sourceGraphVerification: { ...sourceVerificationFixture(), snapshotHash: sha('different-source-snapshot') }
  };
  assert.throws(() => ingestAdaptiveGoalReviewerAttestation(store, JOB_ID, attestation, options),
    /AGG_REVIEWER_ATTESTATION_INGEST_READBACK_MISMATCH/,
    'an exact signed retry must not claim success when current source snapshot binding changed');
  readbackOverride = null;

  const retry = ingestAdaptiveGoalReviewerAttestation(store, JOB_ID, attestation, options);
  assert.equal(retry.stored, false);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.attestationEventId, first.attestationEventId);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM events WHERE job_id=? AND type=?')
    .get(JOB_ID, ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT).count, 1,
  'exact retry must read back the prior signed assertion without creating a second durable record');
});

test('reviewer ingestion uses a read-only trust connection while a separate workflow connection owns the same SQLite writer transaction', t => {
  environment(t);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-reviewer-shared-db-'));
  const dbPath = path.join(temp, 'workflow.db');
  const workflowDb = new DatabaseSync(dbPath);
  const trustDb = new DatabaseSync(dbPath);
  configureAdaptiveGoalTrustConfigurationLedger(trustDb);
  workflowDb.exec(`CREATE TABLE events (
    event_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  const store = { db: workflowDb, trustDb };
  t.after(() => {
    workflowDb.close();
    trustDb.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  observeReviewerTrust(store);
  const candidate = candidateFixture();
  candidate.reviewedTaskInputs.gates = { actionIntentSemanticEquivalenceVerified: true };
  const attestation = signedAttestation(candidate);
  const options = { now, trustConfigurationDb: trustDb,
    loadCurrentCandidate: () => currentCandidateReadback(store, JOB_ID, candidate) };

  const ingested = ingestAdaptiveGoalReviewerAttestation(store, JOB_ID, attestation, options);
  assert.equal(ingested.stored, true, JSON.stringify(ingested));
  assert.equal(ingested.verified, true);
  assert.equal(workflowDb.isTransaction, false);
  assert.equal(workflowDb.prepare('SELECT COUNT(*) AS count FROM events WHERE type=?')
    .get(ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT).count, 1);
  const historyCount = trustDb.prepare('SELECT COUNT(*) AS count FROM adaptive_goal_trust_configuration_history').get().count;
  assert.equal(historyCount, 1, 'trust verification under the workflow writer transaction must not append a second observation');
});

test('runtime reviewer ingestion rolls back invalid signatures and candidate/plan mismatches', t => {
  environment(t);
  const store = storeFixture();
  t.after(() => closeStore(store));
  observeReviewerTrust(store);
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
  observeReviewerTrust(store);
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

test('reviewer nonce ingestion is serialized across independent processes and persisted attestation recovers after restart', async t => {
  environment(t);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-reviewer-process-recovery-'));
  const workflowPath = path.join(temp, 'workflow.db');
  const trustPath = path.join(temp, 'trust.db');
  const workflowDb = new DatabaseSync(workflowPath);
  workflowDb.exec(`CREATE TABLE events (
    event_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  const trustDb = new DatabaseSync(trustPath);
  const initialStore = { db: workflowDb, trustDb };
  configureAdaptiveGoalTrustConfigurationLedger(trustDb);
  observeReviewerTrust(initialStore);
  workflowDb.close();
  trustDb.close();
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const candidate = candidateFixture();
  candidate.reviewedTaskInputs.gates = { actionIntentSemanticEquivalenceVerified: true };
  const nonce = randomUUID();
  const jobIds = [JOB_ID, 'job_123e4567-e89b-42d3-a456-426614174001'];
  const attestations = jobIds.map(jobId => signedAttestation(candidate, jobId, { nonce }));
  const reviewerModuleUrl = new URL('../src/runtime/adaptive-goal-reviewer-identity.js', import.meta.url).href;
  const childScript = `
    import { DatabaseSync } from 'node:sqlite';
    const reviewer = await import(${JSON.stringify(reviewerModuleUrl)});
    const db = new DatabaseSync(process.env.TEST_WORKFLOW_DB);
    db.exec('PRAGMA busy_timeout=5000');
    const trustDb = new DatabaseSync(process.env.TEST_TRUST_DB);
    reviewer.configureAdaptiveGoalTrustConfigurationLedger(trustDb);
    const candidate = JSON.parse(process.env.TEST_CANDIDATE);
    const attestation = JSON.parse(process.env.TEST_ATTESTATION);
    const jobId = process.env.TEST_JOB_ID;
    const now = Number(process.env.TEST_NOW);
    const source = JSON.parse(process.env.TEST_SOURCE);
    const originalExec = db.exec.bind(db);
    db.exec = sql => {
      if (sql === 'BEGIN IMMEDIATE') process.stdout.write('BEGIN_ATTEMPT\\n');
      return originalExec(sql);
    };
    const loadCurrentCandidate = () => {
      let verified = null;
      const rows = db.prepare('SELECT event_id FROM events WHERE job_id=? AND type=?')
        .all(jobId, reviewer.ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT);
      if (rows.length === 1) {
        try { verified = reviewer.assertAdaptiveGoalReviewerAttestation({ db }, jobId, candidate, { now, trustConfigurationDb: trustDb }); }
        catch {}
      }
      return {
        found: true, status: 'fresh', candidate, candidateHash: candidate.candidateHash,
        wrapperState: 'IDLE', wrapperApproved: false, immutablePlanPinned: false,
        taskRowsCreated: false, dispatchStarted: false, approvalCount: 0,
        reviewerIdentityVerified: Boolean(verified?.verified),
        reviewerAttestation: verified ? { attestationEventId: verified.attestationEventId } : null,
        executionReviewReady: Boolean(verified?.verified && candidate.reviewedTaskInputs?.gates?.actionIntentSemanticEquivalenceVerified === true),
        sourceGraphVerification: source
      };
    };
    process.stdout.write('READY\\n');
    await new Promise(resolve => process.stdin.once('data', resolve));
    try {
      const result = reviewer.ingestAdaptiveGoalReviewerAttestation({ db }, jobId, attestation, {
        now, trustConfigurationDb: trustDb, loadCurrentCandidate
      });
      process.stdout.write(JSON.stringify({ outcome: 'stored', jobId, eventId: result.attestationEventId }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ outcome: 'rejected', jobId, code: error.code || null, message: String(error.message || error) }));
    } finally { db.close(); trustDb.close(); }
  `;
  const source = sourceVerificationFixture();
  const launchChild = (jobId, attestation) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
      cwd: process.cwd(),
      env: { ...process.env, TEST_WORKFLOW_DB: workflowPath, TEST_TRUST_DB: trustPath,
        TEST_CANDIDATE: JSON.stringify(candidate), TEST_ATTESTATION: JSON.stringify(attestation),
        TEST_JOB_ID: jobId, TEST_NOW: String(now), TEST_SOURCE: JSON.stringify(source) }
    });
    let stdout = '';
    let stderr = '';
    let readySeen = false;
    let beginSeen = false;
    let resolveReady;
    let rejectReady;
    let resolveBegin;
    let rejectBegin;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const beginAttempt = new Promise((resolve, reject) => { resolveBegin = resolve; rejectBegin = reject; });
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk;
      if (!readySeen && stdout.includes('READY\n')) { readySeen = true; resolveReady(); }
      if (!beginSeen && stdout.includes('BEGIN_ATTEMPT\n')) { beginSeen = true; resolveBegin(); }
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const result = new Promise((resolve, reject) => {
      child.once('error', error => { rejectReady(error); reject(error); });
      child.once('close', code => {
        if (!readySeen) rejectReady(new Error(`reviewer child exited before ready (${code}): ${stderr || stdout}`));
        if (!beginSeen) rejectBegin(new Error(`reviewer child exited before BEGIN IMMEDIATE (${code}): ${stderr || stdout}`));
        if (code !== 0) return reject(new Error(`reviewer child exited ${code}: ${stderr || stdout}`));
        try { resolve(JSON.parse(stdout.split(/\r?\n/u).filter(Boolean).at(-1))); }
        catch { reject(new Error(`reviewer child returned invalid output: ${stdout}; ${stderr}`)); }
      });
    });
    return { child, ready, beginAttempt, result };
  };

  const writerFence = new DatabaseSync(workflowPath);
  writerFence.exec('PRAGMA busy_timeout=5000');
  writerFence.exec('BEGIN IMMEDIATE');
  let writerFenceOpen = true;
  t.after(() => {
    if (!writerFenceOpen) return;
    try { if (writerFence.isTransaction) writerFence.exec('ROLLBACK'); }
    finally { writerFence.close(); }
  });
  const children = jobIds.map((jobId, index) => launchChild(jobId, attestations[index]));
  await Promise.all(children.map(item => item.ready));
  // Keep a third connection's writer reservation while both child processes
  // reach the pre-BEGIN marker. Each then immediately calls BEGIN IMMEDIATE;
  // releasing only after both markers forces the two attempts to race at the
  // SQLite writer boundary (the synchronous API cannot acknowledge "blocked").
  for (const item of children) item.child.stdin.end('GO\n');
  await Promise.all(children.map(item => item.beginAttempt));
  writerFence.exec('COMMIT');
  writerFence.close();
  writerFenceOpen = false;
  const concurrent = await Promise.all(children.map(item => item.result));
  assert.equal(concurrent.filter(result => result.outcome === 'stored').length, 1, JSON.stringify(concurrent));
  const replay = concurrent.find(result => result.outcome === 'rejected');
  assert.equal(replay?.code, 'AGG_REVIEWER_ATTESTATION_INGEST_REPLAY', JSON.stringify(concurrent));
  const winner = concurrent.find(result => result.outcome === 'stored');
  const winnerIndex = jobIds.indexOf(winner.jobId);
  const loserIndex = 1 - winnerIndex;

  const reopenedDb = new DatabaseSync(workflowPath);
  const reopenedTrustDb = new DatabaseSync(trustPath);
  configureAdaptiveGoalTrustConfigurationLedger(reopenedTrustDb);
  const reopenedStore = { db: reopenedDb, trustDb: reopenedTrustDb };
  t.after(() => closeStore(reopenedStore));
  assert.equal(reopenedDb.prepare('SELECT COUNT(*) AS count FROM events WHERE type=?')
    .get(ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT).count, 1,
  'only one process may persist a globally unique reviewer nonce');
  const persisted = assertAdaptiveGoalReviewerAttestation(reopenedStore, winner.jobId, candidate, { now, trustConfigurationDb: reopenedTrustDb });
  assert.equal(persisted.attestationEventId, winner.eventId, 'the reviewer event must verify after both databases are reopened');

  const retry = ingestAdaptiveGoalReviewerAttestation(reopenedStore, winner.jobId, attestations[winnerIndex], {
    now, trustConfigurationDb: reopenedTrustDb,
    loadCurrentCandidate: () => currentCandidateReadback(reopenedStore, winner.jobId, candidate)
  });
  assert.equal(retry.idempotent, true, 'exact retry must recover the original durable reviewer assertion after restart');
  assert.throws(() => ingestAdaptiveGoalReviewerAttestation(reopenedStore, jobIds[loserIndex], attestations[loserIndex], {
    now, trustConfigurationDb: reopenedTrustDb,
    loadCurrentCandidate: () => currentCandidateReadback(reopenedStore, jobIds[loserIndex], candidate)
  }), /nonce already exists/, 'the losing process nonce must remain replay-protected after restart');
  assert.equal(reopenedDb.prepare('SELECT COUNT(*) AS count FROM events WHERE type=?')
    .get(ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT).count, 1);
});
