import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createAdaptiveGoalKnowledgeStore } from '../src/runtime/adaptive-goal-knowledge-store.js';
import { adaptiveGoalPublicKeyFingerprint } from '../src/runtime/adaptive-goal-trust-configuration.js';
import {
  ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_PROVIDER_ENV,
  ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_SCOPE,
  ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_TRUST_ROOT_ENV,
  ADAPTIVE_GOAL_KNOWLEDGE_TRUST_CONFIG_ENV,
  canonicalAdaptiveGoalKnowledgeJson,
  createAdaptiveGoalKnowledgeVerifier
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
  assert.throws(() => f.verifier.buildVerifiedGraph(goalId, f.start.id, f.goal.id, sha('stale snapshot')),
    error => error.code === 'KNOWLEDGE_GRAPH_SNAPSHOT_STALE');
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
  process.env[ADAPTIVE_GOAL_KNOWLEDGE_TRUST_CONFIG_ENV] = JSON.stringify(baseConfig);
  const afterRollback = f.verifier.getCurrentVerification(goalId);
  assert.equal(afterRollback.verified, false);
  assert.ok(afterRollback.blockers.some(item => item.code === 'AGG_TRUST_CONFIG_ROLLBACK'), JSON.stringify(afterRollback));
});

test('rejects false evidence lineage, signatures from another key, forged hashes and verifier nonce replay', t => {
  const f = fixture({ evidenceValid: false }); t.after(() => { f.db.close(); f.trustDb.close(); }); withVerifierEnvironment(t);
  assert.throws(() => f.verifier.getAttestationRequest(goalId), error => error.code === 'KNOWLEDGE_EVIDENCE_LINEAGE_INVALID');

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
