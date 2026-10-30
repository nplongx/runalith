import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createAdaptiveGoalKnowledgeStore } from '../src/runtime/adaptive-goal-knowledge-store.js';
import { searchAdaptiveGoalGraph } from '../src/runtime/adaptive-goal-graph.js';
import { isAuthenticatedAdaptiveGoalPlanDraft, projectAdaptiveGoalCandidateToPlanGraph } from '../src/runtime/adaptive-goal-plan-adapter.js';
import { adaptiveGoalPublicKeyFingerprint } from '../src/runtime/adaptive-goal-trust-configuration.js';
import {
  ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_PROVIDER_ENV,
  ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_SCOPE,
  ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_TRUST_ROOT_ENV,
  ADAPTIVE_GOAL_KNOWLEDGE_TRUST_CONFIG_ENV,
  canonicalAdaptiveGoalKnowledgeJson,
  createAdaptiveGoalKnowledgeVerifier,
  isAuthenticatedAdaptiveGoalKnowledgeVerificationReport
} from '../src/runtime/adaptive-goal-knowledge-verifier.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const keyPair = generateKeyPairSync('ed25519');
const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' });
const otherKeyPair = generateKeyPairSync('ed25519');
const providerId = 'unit-test-verified-knowledge-provider';
const goalId = 'goal-verifier-unit';
const provenance = { source: 'independent-verifier-fixture', actor: 'test-authority', reference: 'fixture://verified-graph' };

function withVerifierEnvironment(t, { configured = true, trustRootPem = publicKeyPem } = {}) {
  const oldProvider = process.env[ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_PROVIDER_ENV];
  const oldRoot = process.env[ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_TRUST_ROOT_ENV];
  if (configured) {
    process.env[ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_PROVIDER_ENV] = providerId;
    process.env[ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_TRUST_ROOT_ENV] = trustRootPem;
  } else {
    delete process.env[ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_PROVIDER_ENV];
    delete process.env[ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_TRUST_ROOT_ENV];
  }
  t.after(() => {
    if (oldProvider === undefined) delete process.env[ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_PROVIDER_ENV];
    else process.env[ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_PROVIDER_ENV] = oldProvider;
    if (oldRoot === undefined) delete process.env[ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_TRUST_ROOT_ENV];
    else process.env[ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_TRUST_ROOT_ENV] = oldRoot;
  });
}

function fixture({ evidenceValid = true, now = () => Date.now() } = {}) {
  const db = new DatabaseSync(':memory:');
  const store = createAdaptiveGoalKnowledgeStore(db);
  const trustDb = new DatabaseSync(':memory:');
  const artifactRefs = new Map();
  function evidenceResolver(input) {
    return input.steps.flatMap(step => step.supportingEvidenceRefs).map(ref => {
      const artifactId = ref.replace(/^artifact:\/\//, '');
      return {
        ref, sourceJobId: 'job-producer-fixture', artifactId, type: 'requirements', schemaVersion: 1,
        status: 'active', contentHash: sha(`bytes:${artifactId}`), lineageValid: evidenceValid,
        artifactCreatedEventId: sha(`artifact:${artifactId}`), producerContractValid: true, producerRole: 'product-owner',
        producerTaskId: `task-${artifactId}`, producerTaskStatus: 'completed', producerTaskCompleted: true,
        producerResultId: `result-${artifactId}`, producerResultOutcome: 'success',
        producerCompletionEventId: sha(`completion:${artifactId}`), producerCompletionEventType: 'task.local_completed',
        producerResultLineageValid: evidenceValid, producerResultLineageFailureReason: evidenceValid ? null : 'injected lineage failure'
      };
    });
  }
  const verifier = createAdaptiveGoalKnowledgeVerifier({
    store, trustConfigurationDb: trustDb, resolveEvidenceRecords: evidenceResolver, resolveSourceRecords: () => [], now
  });
  const createNode = (stableKey, type, content, evidenceRefs = []) => {
    const node = store.saveNode({ goalId, stableKey, type, content, provenance, evidenceRefs, expectedRevision: 0 });
    artifactRefs.set(stableKey, evidenceRefs[0] || null);
    return node;
  };
  const start = createNode('start-node', 'idea', { title: 'Verified pipeline starts from audited provenance' });
  const action = createNode('action-node', 'experiment', { title: 'Produce typed verified evidence', producer: 'product-owner' }, ['artifact://artifact-001']);
  const goal = createNode('finish-goal', 'goal', { title: 'Verified evidence graph reaches its goal' });
  store.addEdge({ goalId, fromId: start.id, toId: action.id, type: 'enables', provenance, evidenceRefs: ['artifact://artifact-001'] });
  store.addEdge({ goalId, fromId: action.id, toId: goal.id, type: 'enables', provenance, evidenceRefs: ['artifact://artifact-001'] });
  return { db, trustDb, store, verifier, start, action, goal, now };
}

function signedAttestation(request, { signingKey = keyPair.privateKey, rootPem = publicKeyPem, trustRootSha256 = sha(rootPem), provider = providerId, nonce = cryptoUuid(), issuedAt, expiresAt } = {}) {
  const snapshot = request.snapshot;
  const unsigned = {
    schema_version: 1,
    kind: 'adaptive_goal_verified_knowledge_graph_attestation',
    provider_id: provider,
    trust_root_sha256: trustRootSha256,
    nonce,
    issued_at: issuedAt || new Date().toISOString(),
    expires_at: expiresAt || new Date(Date.now() + 5 * 60_000).toISOString(),
    scope: ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_SCOPE,
    goal_id: snapshot.goal_id,
    snapshot_hash: snapshot.snapshot_hash,
    node_ids: snapshot.node_ids,
    edge_ids: snapshot.edge_ids,
    membership_ids: snapshot.membership_ids,
    evidence_manifest_hash: request.evidenceManifestHash,
    claim_status: 'verified',
    independence_status: 'verified',
    signature_algorithm: 'Ed25519'
  };
  return { ...unsigned, signature: sign(null, Buffer.from(canonicalAdaptiveGoalKnowledgeJson(unsigned)), signingKey).toString('base64') };
}

function publicTrustConfig(provider, keys, version = 1) {
  return {
    schema_version: 1, domain: 'goal_idea_verifier', provider_id: provider, config_version: version,
    updated_at: new Date().toISOString(), updated_by: 'runtime-integration-security-admin',
    change_reference: `SEC-RUNTIME-${version}`,
    keys: keys.map(({ keyId, pem, notBefore = new Date(Date.now() - 60_000).toISOString(), notAfter = null, revokedAt = null }) => ({
      key_id: keyId, public_key_pem: pem, scopes: [ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_SCOPE],
      not_before: notBefore, not_after: notAfter, revoked_at: revokedAt
    }))
  };
}

function cryptoUuid() { return `${'123e4567-e89b-42d3-a456-426614174000'}`; }

test('knowledge signature canonicalization rejects ambiguous JavaScript objects before reading attacker-controlled values', () => {
  assert.equal(canonicalAdaptiveGoalKnowledgeJson({ z: -0, a: [true, null, 'ok'] }), '{"a":[true,null,"ok"],"z":0}');
  const getter = {};
  let getterInvoked = false;
  Object.defineProperty(getter, 'signature', { enumerable: true, get() { getterInvoked = true; return 'attacker-value'; } });
  assert.throws(() => canonicalAdaptiveGoalKnowledgeJson(getter), /enumerable data properties only/);
  assert.equal(getterInvoked, false, 'canonicalization must inspect descriptors without invoking getters');

  const sparse = new Array(2); sparse[1] = 'value';
  assert.throws(() => canonicalAdaptiveGoalKnowledgeJson(sparse), /dense canonical arrays|must not be sparse/);
  const arrayWithExtraProperty = ['value']; arrayWithExtraProperty.extra = true;
  assert.throws(() => canonicalAdaptiveGoalKnowledgeJson(arrayWithExtraProperty), /extra properties/);
  const symbolKey = { value: true }; symbolKey[Symbol('unserialized')] = 'hidden';
  assert.throws(() => canonicalAdaptiveGoalKnowledgeJson(symbolKey), /forbidden key/);
  const classInstance = new (class SignedPayload { constructor() { this.value = true; } })();
  assert.throws(() => canonicalAdaptiveGoalKnowledgeJson(classInstance), /plain JSON records/);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => canonicalAdaptiveGoalKnowledgeJson(cyclic), /cycle or repeated object identity/);
  const shared = { value: true };
  assert.throws(() => canonicalAdaptiveGoalKnowledgeJson({ first: shared, second: shared }), /cycle or repeated object identity/);
  const forbidden = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => canonicalAdaptiveGoalKnowledgeJson(forbidden), /forbidden key/);
});

test('refuses to place trust anti-rollback history on the same connection as the Goal/Idea workflow database', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = createAdaptiveGoalKnowledgeStore(db);
  assert.throws(() => createAdaptiveGoalKnowledgeVerifier({
    store, trustConfigurationDb: db, resolveEvidenceRecords: () => [], resolveSourceRecords: () => []
  }), error => error.code === 'AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE' && /distinct from the Goal\/Idea workflow database/.test(error.message));
});

test('requires configured verifier and verifies exact snapshot, revisions, memberships, edge provenance and durable artifact lineage', t => {
  const f = fixture(); t.after(() => { f.db.close(); f.trustDb.close(); });
  withVerifierEnvironment(t, { configured: false });
  const unverified = f.verifier.getCurrentVerification(goalId);
  assert.equal(unverified.verified, false);
  assert.equal(unverified.status, 'verifier_unavailable');
  assert.ok(unverified.blockers.some(item => item.code === 'KNOWLEDGE_VERIFIER_NOT_CONFIGURED'));

  withVerifierEnvironment(t);
  const request = f.verifier.getAttestationRequest(goalId);
  assert.equal(request.snapshot.integrity_valid, true);
  assert.equal(request.snapshot.nodes.length, 3);
  assert.equal(request.snapshot.edges.length, 2);
  assert.equal(request.snapshot.memberships.length, 3);
  assert.equal(request.evidenceManifest.length, 1);
  assert.equal(request.evidenceManifest[0].valid, true);
  assert.equal(request.snapshot.nodes.find(node => node.id === f.action.id).evidence_refs[0], 'artifact://artifact-001');
  const attestation = signedAttestation(request);
  const committed = f.verifier.attest(attestation);
  assert.equal(committed.created, true);
  assert.equal(committed.verified, true);
  assert.equal(committed.verifiedNodeCount, 3);
  assert.equal(committed.verifiedEdgeCount, 2);
  assert.equal(committed.verifiedMembershipCount, 3);
  assert.equal(committed.claimVerified, true);
  assert.equal(committed.independenceVerified, true);
  const retry = f.verifier.attest(attestation);
  assert.equal(retry.created, false);
  assert.equal(retry.idempotent, true, 'byte-identical verified attestations must be idempotent');
  const graph = f.verifier.buildVerifiedGraph(goalId, f.start.id, f.goal.id, request.snapshot.snapshot_hash);
  assert.equal(graph.snapshotHash, request.snapshot.snapshot_hash);
  assert.equal(graph.graph.startNodeId, f.start.id);
  assert.equal(graph.graph.goalNodeId, f.goal.id);
  assert.equal(graph.graph.nodes.find(node => node.id === f.action.id).evidenceRefs[0], 'artifact://artifact-001');
  const searchOptions = { beamWidth: 4, maxDepth: 8, maxExpansions: 64 };
  const search = searchAdaptiveGoalGraph(graph.graph, searchOptions);
  assert.ok(search.candidates.length > 0, 'verified source fixture should expose at least one complete candidate');
  const authenticatedDraft = projectAdaptiveGoalCandidateToPlanGraph(
    graph.graph, search.candidates[0], searchOptions, {}, graph.verificationReport
  );
  assert.equal(isAuthenticatedAdaptiveGoalPlanDraft(authenticatedDraft), true);
  assert.equal(Object.isFrozen(authenticatedDraft), true);
  assert.equal(Object.isFrozen(authenticatedDraft.source), true);
  assert.equal(Object.isFrozen(authenticatedDraft.steps), true);
  assert.equal(Object.isFrozen(authenticatedDraft.steps[0]), true);
  assert.throws(() => { authenticatedDraft.steps[0].title = 'caller-mutated label'; }, TypeError,
    'same-process callers must not mutate authenticated draft content while retaining its trusted object identity');
  assert.throws(() => { authenticatedDraft.source.verification.snapshotHash = sha('forged snapshot'); }, TypeError,
    'the upstream attestation binding itself must remain immutable');
  assert.equal(isAuthenticatedAdaptiveGoalPlanDraft(authenticatedDraft), true,
    'a failed mutation attempt must not alter the content bound to the authenticated identity');
  assert.throws(() => f.verifier.buildVerifiedGraph(goalId, f.start.id, f.goal.id, sha('stale snapshot')),
    error => error.code === 'KNOWLEDGE_GRAPH_SNAPSHOT_STALE');
});

test('snapshot request and current-verification getters never write trust-ledger observations', t => {
  const f = fixture(); t.after(() => { f.db.close(); f.trustDb.close(); });
  withVerifierEnvironment(t);
  const countHistory = () => f.trustDb.prepare('SELECT COUNT(*) AS n FROM adaptive_goal_trust_configuration_history').get().n;
  assert.equal(countHistory(), 0);

  const request = f.verifier.getAttestationRequest(goalId);
  assert.equal(request.eligibleForAttestation, true);
  assert.equal(request.verifierConfiguration.audit.mode, 'read_only_no_ledger_write');
  assert.equal(request.verifierConfiguration.observationRequired, true);
  assert.equal(countHistory(), 0, 'building a snapshot/attestation request must not create a trust-ledger row');

  const unobserved = f.verifier.getCurrentVerification(goalId);
  assert.equal(unobserved.verified, false);
  assert.equal(unobserved.status, 'trust_configuration_not_observed');
  assert.ok(unobserved.blockers.some(item => item.code === 'KNOWLEDGE_TRUST_CONFIG_NOT_OBSERVED'));
  assert.equal(countHistory(), 0, 'verification must fail closed when the current config has not been explicitly observed, without observing it itself');

  const explicitObservation = f.verifier.getVerifierConfigurationStatus();
  assert.equal(explicitObservation.currentTrustConfigurationObserved, true);
  assert.equal(explicitObservation.audit.mode, 'explicit_trust_status_observation');
  assert.equal(countHistory(), 1, 'only the explicit trust-status operation may record a trust configuration observation');
  const stillUnattested = f.verifier.getCurrentVerification(goalId);
  assert.equal(stillUnattested.verified, false);
  assert.equal(stillUnattested.status, 'unattested');
  assert.equal(countHistory(), 1, 'a getter must not write a second observation after explicit registration');

  const accepted = f.verifier.attest(signedAttestation(request));
  assert.equal(accepted.verified, true);
  assert.equal(countHistory(), 1, 'the signed attestation path may idempotently verify the already-observed trust version');
  assert.equal(f.verifier.getCurrentVerification(goalId).verified, true);
  assert.equal(countHistory(), 1, 'current attestation readback must remain read-only');
});

test('blank optional reviewer user_config does not disable the independently configured Goal/Idea verifier', t => {
  withVerifierEnvironment(t);
  const envKeys = ['AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON', 'AGG_REVIEW_IDENTITY_PROVIDER_ID', 'AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM'];
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON = '';
  // Legacy values, if inherited from an operator shell, must not override the
  // explicitly blank optional JSON field for peer-domain checking.
  process.env.AGG_REVIEW_IDENTITY_PROVIDER_ID = 'ignored-because-json-field-is-blank';
  process.env.AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM = publicKeyPem;
  t.after(() => {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  const f = fixture();
  t.after(() => { f.db.close(); f.trustDb.close(); });
  const request = f.verifier.getAttestationRequest(goalId);
  assert.equal(request.eligibleForAttestation, true,
    'an empty optional reviewer config only disables reviewer functionality, not source snapshot verification');
  assert.ok(request.requiredSignedFields.length > 0);
});

test('empty evidence remains diagnosable but can never be externally attested or become planning-authoritative', t => {
  const f = fixture(); t.after(() => { f.db.close(); f.trustDb.close(); }); withVerifierEnvironment(t);
  const emptyGoalId = 'goal-empty-evidence-manifest';
  const emptyStart = f.store.saveNode({
    goalId: emptyGoalId, stableKey: 'empty-start', type: 'idea', content: { title: 'No admissible evidence yet' },
    provenance, evidenceRefs: [], expectedRevision: 0
  });
  const emptyGoal = f.store.saveNode({
    goalId: emptyGoalId, stableKey: 'empty-finish', type: 'goal', content: { title: 'Must remain blocked without evidence' },
    provenance, evidenceRefs: [], expectedRevision: 0
  });
  f.store.addEdge({ goalId: emptyGoalId, fromId: emptyStart.id, toId: emptyGoal.id, type: 'enables', provenance, evidenceRefs: [] });

  const request = f.verifier.getAttestationRequest(emptyGoalId);
  assert.equal(request.snapshot.integrity_valid, true, 'the diagnostic snapshot is still available');
  assert.equal(request.snapshot.nodes.length, 2);
  assert.deepEqual(request.evidenceManifest, []);
  assert.equal(request.eligibleForAttestation, false);
  assert.deepEqual(request.requiredSignedFields, []);
  assert.ok(request.attestationBlockers.some(item => item.code === 'KNOWLEDGE_EVIDENCE_MANIFEST_EMPTY'));

  const unusableSignedPayload = signedAttestation(request);
  assert.throws(() => f.verifier.attest(unusableSignedPayload),
    error => error.code === 'KNOWLEDGE_EVIDENCE_MANIFEST_EMPTY');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM adaptive_goal_knowledge_verifications WHERE goal_id=?').get(emptyGoalId).n, 0,
    'an empty manifest must not be persisted as verified, even if a well-formed test signature is supplied');
  const emptyVerification = f.verifier.getCurrentVerification(emptyGoalId);
  assert.equal(emptyVerification.verified, false);
  assert.equal(emptyVerification.status, 'evidence_ineligible');
  assert.ok(emptyVerification.blockers.some(item => item.code === 'KNOWLEDGE_EVIDENCE_MANIFEST_EMPTY'));

  const missingActionEvidenceGoalId = 'goal-action-node-missing-evidence';
  const actionStart = f.store.saveNode({
    goalId: missingActionEvidenceGoalId, stableKey: 'action-empty-start', type: 'idea',
    content: { title: 'Source action has not produced evidence yet' }, provenance, evidenceRefs: [], expectedRevision: 0
  });
  const action = f.store.saveNode({
    goalId: missingActionEvidenceGoalId, stableKey: 'action-empty-experiment', type: 'experiment',
    content: { title: 'Experiment with no artifact binding' }, provenance, evidenceRefs: [], expectedRevision: 0
  });
  f.store.addEdge({ goalId: missingActionEvidenceGoalId, fromId: actionStart.id, toId: action.id, type: 'enables', provenance, evidenceRefs: [] });
  const malformedRequest = f.verifier.getAttestationRequest(missingActionEvidenceGoalId);
  assert.equal(malformedRequest.snapshot.integrity_valid, true);
  assert.equal(malformedRequest.eligibleForAttestation, false);
  assert.ok(malformedRequest.attestationBlockers.some(item => item.code === 'KNOWLEDGE_ACTION_EVIDENCE_MISSING'));
  assert.equal(f.verifier.getCurrentVerification(missingActionEvidenceGoalId).verified, false);
});

test('attestation ingestion rejects accessor-backed signed fields before invoking them or persisting anything', t => {
  const f = fixture(); t.after(() => { f.db.close(); f.trustDb.close(); }); withVerifierEnvironment(t);
  const request = f.verifier.getAttestationRequest(goalId);
  const attestation = signedAttestation(request);
  let getterInvoked = false;
  Object.defineProperty(attestation, 'goal_id', { enumerable: true, configurable: true, get() { getterInvoked = true; return goalId; } });
  assert.throws(() => f.verifier.attest(attestation), error => error.code === 'KNOWLEDGE_ATTESTATION_SHAPE_INVALID');
  assert.equal(getterInvoked, false, 'untrusted getter must not execute before signature validation');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM adaptive_goal_knowledge_verifications').get().n, 0,
    'invalid accessor-backed payload must not create a durable attestation');
});

test('authenticated verification reports are deeply immutable and lose authority at expiry', t => {
  let currentTime = Date.now();
  const f = fixture({ now: () => currentTime }); t.after(() => { f.db.close(); f.trustDb.close(); }); withVerifierEnvironment(t);
  const request = f.verifier.getAttestationRequest(goalId);
  const expiresAt = new Date(currentTime + 10_000).toISOString();
  const attestation = signedAttestation(request, {
    issuedAt: new Date(currentTime).toISOString(), expiresAt
  });
  assert.equal(f.verifier.attest(attestation).verified, true);
  const report = f.verifier.getCurrentVerification(goalId);
  assert.equal(isAuthenticatedAdaptiveGoalKnowledgeVerificationReport(report, { now: currentTime }), true);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.snapshot), true);
  assert.equal(Object.isFrozen(report.snapshot.nodes), true);
  assert.equal(Object.isFrozen(report.snapshot.nodes[0].content), true);
  assert.throws(() => { report.expiresAt = new Date(currentTime + 60_000).toISOString(); }, TypeError,
    'a caller must not extend authenticated report lifetime while retaining its WeakSet identity');
  assert.throws(() => { report.snapshot.nodes[0].content.title = 'caller-mutated signed claim'; }, TypeError,
    'a caller must not mutate snapshot content after its signature was verified');
  assert.throws(() => { report.snapshot.snapshot_hash = sha('forged current snapshot'); }, TypeError,
    'a caller must not replace the signed snapshot hash in place');
  currentTime += 10_001;
  assert.equal(isAuthenticatedAdaptiveGoalKnowledgeVerificationReport(report, { now: currentTime }), false,
    'an in-process report identity must not make an expired attestation current');
});

test('administered multi-key trust config is used for signatures and key revocation invalidates persisted verification with auditable config metadata', t => {
  const f = fixture(); t.after(() => { f.db.close(); f.trustDb.close(); });
  const savedConfig = process.env[ADAPTIVE_GOAL_KNOWLEDGE_TRUST_CONFIG_ENV];
  const savedProvider = process.env[ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_PROVIDER_ENV];
  const savedRoot = process.env[ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_TRUST_ROOT_ENV];
  const savedReviewerConfig = process.env.AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON;
  const savedReviewerProvider = process.env.AGG_REVIEW_IDENTITY_PROVIDER_ID;
  const savedReviewerRoot = process.env.AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM;
  const rotatePair = generateKeyPairSync('ed25519');
  const rotatePem = rotatePair.publicKey.export({ type: 'spki', format: 'pem' });
  const provider = 'independently-administered-source-provider';
  const baseConfig = publicTrustConfig(provider, [
    { keyId: 'source-primary', pem: publicKeyPem }, { keyId: 'source-rotate-in', pem: rotatePem }
  ]);
  process.env[ADAPTIVE_GOAL_KNOWLEDGE_TRUST_CONFIG_ENV] = JSON.stringify(baseConfig);
  delete process.env[ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_PROVIDER_ENV];
  delete process.env[ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_TRUST_ROOT_ENV];
  delete process.env.AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON;
  delete process.env.AGG_REVIEW_IDENTITY_PROVIDER_ID;
  delete process.env.AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM;
  t.after(() => {
    if (savedConfig === undefined) delete process.env[ADAPTIVE_GOAL_KNOWLEDGE_TRUST_CONFIG_ENV]; else process.env[ADAPTIVE_GOAL_KNOWLEDGE_TRUST_CONFIG_ENV] = savedConfig;
    if (savedProvider === undefined) delete process.env[ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_PROVIDER_ENV]; else process.env[ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_PROVIDER_ENV] = savedProvider;
    if (savedRoot === undefined) delete process.env[ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_TRUST_ROOT_ENV]; else process.env[ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_TRUST_ROOT_ENV] = savedRoot;
    if (savedReviewerConfig === undefined) delete process.env.AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON; else process.env.AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON = savedReviewerConfig;
    if (savedReviewerProvider === undefined) delete process.env.AGG_REVIEW_IDENTITY_PROVIDER_ID; else process.env.AGG_REVIEW_IDENTITY_PROVIDER_ID = savedReviewerProvider;
    if (savedReviewerRoot === undefined) delete process.env.AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM; else process.env.AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM = savedReviewerRoot;
  });

  const request = f.verifier.getAttestationRequest(goalId);
  const signedByRotatedKey = signedAttestation(request, { signingKey: rotatePair.privateKey, rootPem: rotatePem,
    trustRootSha256: adaptiveGoalPublicKeyFingerprint(rotatePem), provider });
  const accepted = f.verifier.attest(signedByRotatedKey);
  assert.equal(accepted.verified, true);
  assert.equal(accepted.providerId, provider);
  assert.equal(accepted.trustKeyId, 'source-rotate-in');
  const auditRow = f.db.prepare(`SELECT configuration_fingerprint,trust_key_id,trust_config_version,configuration_source,config_change_reference
    FROM adaptive_goal_knowledge_verifications WHERE attestation_id=?`).get(accepted.attestationId);
  assert.equal(auditRow.configuration_fingerprint.length, 64);
  assert.equal(auditRow.trust_key_id, 'source-rotate-in');
  assert.equal(auditRow.trust_config_version, 1);
  assert.equal(auditRow.configuration_source, 'admin_json_environment');
  assert.equal(auditRow.config_change_reference, 'SEC-RUNTIME-1');

  process.env[ADAPTIVE_GOAL_KNOWLEDGE_TRUST_CONFIG_ENV] = JSON.stringify(publicTrustConfig(provider, [
    { keyId: 'source-primary', pem: publicKeyPem },
    { keyId: 'source-rotate-in', pem: rotatePem, revokedAt: new Date(Date.now() - 1_000).toISOString() }
  ], 2));
  const afterRevocation = f.verifier.getCurrentVerification(goalId);
  assert.equal(afterRevocation.verified, false);
  assert.ok(afterRevocation.blockers.some(item => item.code === 'AGG_TRUST_ROOT_REVOKED'), JSON.stringify(afterRevocation));
  // A read-only verification must not advance the trust ledger merely because
  // it observed version 2. Make the authority-style observation explicit
  // before simulating a rollback to version 1.
  assert.equal(f.trustDb.prepare('SELECT config_version FROM adaptive_goal_trust_configuration_history WHERE domain=?').get('goal_idea_verifier').config_version, 1);
  const observedRevocation = f.verifier.getVerifierConfigurationStatus();
  assert.equal(observedRevocation.currentTrustConfigurationObserved, true);
  assert.equal(f.trustDb.prepare('SELECT config_version FROM adaptive_goal_trust_configuration_history WHERE domain=?').get('goal_idea_verifier').config_version, 2);
  process.env[ADAPTIVE_GOAL_KNOWLEDGE_TRUST_CONFIG_ENV] = JSON.stringify(baseConfig);
  const afterRollback = f.verifier.getCurrentVerification(goalId);
  assert.equal(afterRollback.verified, false);
  assert.ok(afterRollback.blockers.some(item => item.code === 'AGG_TRUST_CONFIG_ROLLBACK'), JSON.stringify(afterRollback));
  process.env[ADAPTIVE_GOAL_KNOWLEDGE_TRUST_CONFIG_ENV] = JSON.stringify(publicTrustConfig(provider, [
    { keyId: 'source-primary', pem: publicKeyPem }, { keyId: 'source-rotate-in', pem: rotatePem }
  ], 4));
  const afterVersionGap = f.verifier.getVerifierConfigurationStatus();
  assert.equal(afterVersionGap.available, false, 'skipping a trust configuration version must block even if the supplied roots are valid');
  assert.equal(afterVersionGap.antiRollback.status, 'version_gap_detected');
  assert.ok(afterVersionGap.blockers.some(item => item.code === 'AGG_TRUST_CONFIG_VERSION_GAP'));
});

test('rejects false evidence lineage, signatures from another key, forged hashes and verifier nonce replay', t => {
  const f = fixture({ evidenceValid: false }); t.after(() => { f.db.close(); f.trustDb.close(); }); withVerifierEnvironment(t);
  const invalidEvidenceRequest = f.verifier.getAttestationRequest(goalId);
  assert.equal(invalidEvidenceRequest.eligibleForAttestation, false);
  assert.ok(invalidEvidenceRequest.attestationBlockers.some(item => item.code === 'KNOWLEDGE_EVIDENCE_LINEAGE_INVALID'));
  assert.throws(() => f.verifier.attest(signedAttestation(invalidEvidenceRequest)),
    error => error.code === 'KNOWLEDGE_EVIDENCE_LINEAGE_INVALID');

  const clean = fixture(); t.after(() => { clean.db.close(); clean.trustDb.close(); });
  const request = clean.verifier.getAttestationRequest(goalId);
  const wrongKey = signedAttestation(request, { signingKey: otherKeyPair.privateKey });
  assert.throws(() => clean.verifier.attest(wrongKey), error => error.code === 'KNOWLEDGE_ATTESTATION_SIGNATURE_INVALID');
  const wrongHash = signedAttestation(request);
  wrongHash.snapshot_hash = sha('forged snapshot');
  const unsigned = { ...wrongHash }; delete unsigned.signature;
  wrongHash.signature = sign(null, Buffer.from(canonicalAdaptiveGoalKnowledgeJson(unsigned)), keyPair.privateKey).toString('base64');
  assert.throws(() => clean.verifier.attest(wrongHash), error => ['KNOWLEDGE_ATTESTATION_SNAPSHOT_MISMATCH','KNOWLEDGE_ATTESTATION_STALE'].includes(error.code));
  const good = signedAttestation(request);
  assert.equal(clean.verifier.attest(good).verified, true);
  const changed = { ...good, nonce: '123e4567-e89b-42d3-a456-426614174001' };
  const changedUnsigned = { ...changed }; delete changedUnsigned.signature;
  changed.signature = sign(null, Buffer.from(canonicalAdaptiveGoalKnowledgeJson(changedUnsigned)), keyPair.privateKey).toString('base64');
  assert.throws(() => clean.verifier.attest(changed), error => error.code === 'KNOWLEDGE_SNAPSHOT_ALREADY_ATTESTED');
});

test('tampered historical/current revisions, memberships, and edge provenance all invalidate the signed snapshot', t => {
  const f = fixture(); t.after(() => { f.db.close(); f.trustDb.close(); }); withVerifierEnvironment(t);
  f.store.saveNode({
    goalId, stableKey: 'start-node', type: 'idea', content: { title: 'Second immutable revision before signing' },
    provenance, evidenceRefs: [], expectedRevision: 1
  });
  const request = f.verifier.getAttestationRequest(goalId);
  assert.equal(f.verifier.attest(signedAttestation(request)).verified, true);

  f.db.exec('DROP TRIGGER adaptive_goal_knowledge_revisions_no_update');
  const originalHistoryRevision = f.db.prepare('SELECT * FROM adaptive_goal_knowledge_revisions WHERE node_id=? AND revision=1').get(f.start.id);
  f.db.prepare('UPDATE adaptive_goal_knowledge_revisions SET content_json=? WHERE node_id=? AND revision=1')
    .run('{"title":"tampered historical revision after signed verification"}', f.start.id);
  const current = f.verifier.getCurrentVerification(goalId);
  assert.equal(current.verified, false);
  assert.ok(current.blockers.some(item => item.code === 'KNOWLEDGE_SNAPSHOT_INTEGRITY_INVALID'));
  assert.throws(() => f.verifier.buildVerifiedGraph(goalId, f.start.id, f.goal.id, request.snapshot.snapshot_hash),
    error => error.code === 'KNOWLEDGE_GRAPH_NOT_VERIFIED');
  f.db.prepare(`UPDATE adaptive_goal_knowledge_revisions SET content_json=?,evidence_refs_json=?,content_hash=?,status=?,provenance_json=?,created_at=?
    WHERE node_id=? AND revision=1`).run(originalHistoryRevision.content_json, originalHistoryRevision.evidence_refs_json,
      originalHistoryRevision.content_hash, originalHistoryRevision.status, originalHistoryRevision.provenance_json,
      originalHistoryRevision.created_at, f.start.id);
  assert.equal(f.verifier.getCurrentVerification(goalId).verified, true, 'restoring exact historical bytes returns to the same signed snapshot');

  f.db.exec('DROP TRIGGER adaptive_goal_knowledge_memberships_no_update');
  const originalMembership = f.db.prepare('SELECT * FROM adaptive_goal_knowledge_memberships WHERE node_id=? AND goal_id=?').get(f.action.id, goalId);
  f.db.prepare('UPDATE adaptive_goal_knowledge_memberships SET provenance_json=? WHERE node_id=? AND goal_id=?')
    .run('{"actor":"changed-membership-actor","source":"changed-membership-source"}', f.action.id, goalId);
  const changedMembership = f.verifier.getCurrentVerification(goalId);
  assert.equal(changedMembership.verified, false);
  assert.ok(changedMembership.blockers.some(item => item.code === 'KNOWLEDGE_ATTESTATION_STALE'), JSON.stringify(changedMembership.blockers));
  f.db.prepare('UPDATE adaptive_goal_knowledge_memberships SET provenance_json=? WHERE node_id=? AND goal_id=?')
    .run(originalMembership.provenance_json, f.action.id, goalId);
  assert.equal(f.verifier.getCurrentVerification(goalId).verified, true);

  f.db.exec('DROP TRIGGER adaptive_goal_knowledge_edges_no_update');
  const originalEdge = f.db.prepare('SELECT * FROM adaptive_goal_knowledge_edges WHERE goal_id=? ORDER BY edge_id LIMIT 1').get(goalId);
  f.db.prepare('UPDATE adaptive_goal_knowledge_edges SET provenance_json=? WHERE edge_id=?')
    .run('{"actor":"changed-edge-actor","source":"changed-edge-source"}', originalEdge.edge_id);
  const changedEdge = f.verifier.getCurrentVerification(goalId);
  assert.equal(changedEdge.verified, false);
  assert.ok(changedEdge.blockers.some(item => item.code === 'KNOWLEDGE_ATTESTATION_STALE'), JSON.stringify(changedEdge.blockers));
  f.db.prepare('UPDATE adaptive_goal_knowledge_edges SET provenance_json=? WHERE edge_id=?')
    .run(originalEdge.provenance_json, originalEdge.edge_id);
  assert.equal(f.verifier.getCurrentVerification(goalId).verified, true);

  const originalEdgeType = f.db.prepare('SELECT edge_id,goal_id,from_id,to_id,type,condition_json,outcome_json FROM adaptive_goal_knowledge_edges WHERE goal_id=? AND from_id=?')
    .get(goalId, f.action.id);
  const invalidEdgeId = `age-${sha(JSON.stringify([
    originalEdgeType.goal_id, originalEdgeType.from_id, originalEdgeType.to_id, 'tested_by',
    originalEdgeType.condition_json, originalEdgeType.outcome_json
  ])).slice(0, 40)}`;
  f.db.prepare('UPDATE adaptive_goal_knowledge_edges SET edge_id=?,type=? WHERE edge_id=?')
    .run(invalidEdgeId, 'tested_by', originalEdgeType.edge_id);
  const invalidSemantics = f.verifier.getCurrentVerification(goalId);
  assert.equal(invalidSemantics.verified, false);
  assert.ok(invalidSemantics.blockers.some(item => item.code === 'KNOWLEDGE_SNAPSHOT_INTEGRITY_INVALID'));
  f.db.prepare('UPDATE adaptive_goal_knowledge_edges SET edge_id=?,type=? WHERE edge_id=?')
    .run(originalEdgeType.edge_id, originalEdgeType.type, invalidEdgeId);
  assert.equal(f.verifier.getCurrentVerification(goalId).verified, true);
});

test('verifier persistence failure rolls back the attestation row and an identical retry is safe', t => {
  const f = fixture(); t.after(() => { f.db.close(); f.trustDb.close(); }); withVerifierEnvironment(t);
  const request = f.verifier.getAttestationRequest(goalId);
  const attestation = signedAttestation(request);
  f.db.exec(`CREATE TRIGGER fail_knowledge_verification_insert BEFORE INSERT ON adaptive_goal_knowledge_verifications
    BEGIN SELECT RAISE(ABORT, 'injected knowledge verifier persistence failure'); END`);
  assert.throws(() => f.verifier.attest(attestation), /injected knowledge verifier persistence failure/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM adaptive_goal_knowledge_verifications').get().n, 0,
    'a failed attestation transaction must not leave a partial verifier record');
  f.db.exec('DROP TRIGGER fail_knowledge_verification_insert');
  const committed = f.verifier.attest(attestation);
  assert.equal(committed.verified, true);
  assert.equal(committed.created, true);
  assert.equal(f.verifier.attest(attestation).idempotent, true);
});

test('expired signed attestations do not authorize and can be refreshed with a new trusted nonce', t => {
  let clock = Date.parse('2026-10-26T03:00:00.000Z');
  const f = fixture({ now: () => clock }); t.after(() => { f.db.close(); f.trustDb.close(); }); withVerifierEnvironment(t);
  const request = f.verifier.getAttestationRequest(goalId);
  const first = signedAttestation(request, { nonce: '123e4567-e89b-42d3-a456-426614174010', issuedAt: new Date(clock - 1000).toISOString(), expiresAt: new Date(clock + 1000).toISOString() });
  assert.equal(f.verifier.attest(first).verified, true);
  clock += 2000;
  assert.equal(f.verifier.getCurrentVerification(goalId).verified, false);
  const refreshed = signedAttestation(request, { nonce: '123e4567-e89b-42d3-a456-426614174011', issuedAt: new Date(clock - 1000).toISOString(), expiresAt: new Date(clock + 60_000).toISOString() });
  assert.equal(f.verifier.attest(refreshed).verified, true);
  assert.equal(f.verifier.getCurrentVerification(goalId).attestationId, sha(`${goalId}|${request.snapshot.snapshot_hash}|${providerId}|${refreshed.nonce}|${refreshed.evidence_manifest_hash}`));
});
