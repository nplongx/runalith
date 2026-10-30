import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  adaptiveGoalPublicKeyFingerprint,
  initializeAdaptiveGoalTrustConfigurationLedger,
  loadAdaptiveGoalTrustConfiguration
} from '../src/runtime/adaptive-goal-trust-configuration.js';
import { canonicalJson } from '../src/runtime/workflow/plan.js';
import {
  ADAPTIVE_GOAL_APPROVAL_POLICY_SCOPE,
  ADAPTIVE_GOAL_EXECUTION_APPROVAL_SCOPE,
  ADAPTIVE_GOAL_MAKER_AUTHORIZATION_SCOPE,
  assertAdaptiveGoalApprovalPolicyHighWater,
  buildAdaptiveGoalApprovalBinding,
  getAdaptiveGoalApprovalSubsystemConfigurationStatus,
  recordAdaptiveGoalApprovalPolicyHighWater,
  verifyAdaptiveGoalExecutionApprovalEvidence
} from '../src/runtime/adaptive-goal-approval-subsystem.js';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const now = Date.now();
const ts = value => new Date(value).toISOString();

function keyPair() { return crypto.generateKeyPairSync('ed25519'); }
function pem(pair) { return pair.publicKey.export({ type: 'spki', format: 'pem' }); }
function rootHash(pair) { return adaptiveGoalPublicKeyFingerprint(pair.publicKey); }
function sign(unsigned, privateKey) {
  const payload = { ...unsigned, signature_algorithm: 'Ed25519' };
  return { ...payload, signature: crypto.sign(null, Buffer.from(canonicalJson(payload), 'utf8'), privateKey).toString('base64') };
}

function trustConfig({ domain, providerId, scope, pairs, updatedAt = ts(now - 1000), version = 1, revokedAt = null }) {
  return JSON.stringify({
    schema_version: 1, domain, provider_id: providerId, config_version: version,
    updated_at: updatedAt, updated_by: 'isolated-approval-subsystem-test',
    change_reference: `test-${domain}-v${version}`,
    keys: pairs.map(([keyId, pair, keyRevocation = revokedAt]) => ({
      key_id: keyId,
      public_key_pem: pem(pair),
      scopes: [scope],
      not_before: '2020-01-01T00:00:00.000Z',
      not_after: null,
      revoked_at: keyRevocation === null ? null : ts(keyRevocation)
    }))
  });
}

function createFixture({ revokeApproverB = false, omitPolicyConfig = false } = {}) {
  const source = keyPair();
  const reviewerIdentity = keyPair();
  const policyKey = keyPair();
  const makerKey = keyPair();
  const checkerA = keyPair();
  const checkerB = keyPair();
  const env = {
    AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON: trustConfig({ domain: 'goal_idea_verifier', providerId: 'source-provider', scope: 'agg.goal_idea_graph.verify', pairs: [['source-v1', source]] }),
    AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON: trustConfig({ domain: 'action_intent_reviewer', providerId: 'reviewer-provider', scope: 'agg.action_intent.review', pairs: [['reviewer-v1', reviewerIdentity]] }),
    AGG_APPROVAL_POLICY_TRUST_CONFIG_JSON: trustConfig({ domain: 'execution_approval_policy', providerId: 'approval-policy-provider', scope: ADAPTIVE_GOAL_APPROVAL_POLICY_SCOPE, pairs: [['policy-v1', policyKey]] }),
    AGG_ACTION_INTENT_MAKER_TRUST_CONFIG_JSON: trustConfig({ domain: 'action_intent_maker', providerId: 'action-maker-provider', scope: ADAPTIVE_GOAL_MAKER_AUTHORIZATION_SCOPE, pairs: [['maker-v1', makerKey]] }),
    AGG_EXECUTION_APPROVAL_TRUST_CONFIG_JSON: trustConfig({ domain: 'execution_approval', providerId: 'execution-approval-provider', scope: ADAPTIVE_GOAL_EXECUTION_APPROVAL_SCOPE,
      pairs: [['checker-a-v1', checkerA], ['checker-b-v1', checkerB, revokeApproverB ? now - 500 : null]] })
  };
  if (omitPolicyConfig) env.AGG_APPROVAL_POLICY_TRUST_CONFIG_JSON = '';
  const trustDb = new DatabaseSync(':memory:');
  initializeAdaptiveGoalTrustConfigurationLedger(trustDb);
  const sourceConfig = loadAdaptiveGoalTrustConfiguration({ configJsonEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON', providerEnv: 'AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID', publicKeyEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM', domain: 'goal_idea_verifier', scope: 'agg.goal_idea_graph.verify', environment: env });
  const reviewerConfig = loadAdaptiveGoalTrustConfiguration({ configJsonEnv: 'AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON', providerEnv: 'AGG_REVIEW_IDENTITY_PROVIDER_ID', publicKeyEnv: 'AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM', domain: 'action_intent_reviewer', scope: 'agg.action_intent.review', environment: env });
  const status = getAdaptiveGoalApprovalSubsystemConfigurationStatus({ trustConfigurationDb: trustDb,
    verifierConfiguration: sourceConfig, reviewerConfiguration: reviewerConfig, now, environment: env });

  const candidate = {
    candidateId: 'agg-candidate-test-0001',
    fingerprint: sha('candidate-fingerprint'),
    candidateHash: sha('candidate-hash'),
    compiler: { compilerPlanHash: sha('immutable-plan') },
    executionPlan: {
      plan_hash: sha('immutable-plan'), workflow_id: 'standard-engineering', workflow_version: 3,
      required_operations: ['workspace.read', 'workspace.write'], workspace_write_scopes: ['src/runtime/'],
      children: [
        { id: 'step-1', role: 'engineer', dependencies: [], execution: { action_intent: { operation: 'code.modify', target: 'repo' }, executable: 'node', args: ['--check'], executor: 'ExecutionManager' } },
        { id: 'step-2', role: 'security', dependencies: ['step-1'], execution: { action_intent: { operation: 'security.review', target: 'repo' }, executable: 'node', args: ['--test'], executor: 'ExecutionManager' } }
      ]
    },
    hashes: {
      reviewedActionIntentHash: sha('action-intents'),
      reviewedTaskInputContractHash: sha('task-inputs'),
      evidenceHash: sha('evidence'),
      sourceEvidenceHash: sha('source-evidence')
    }
  };
  const sourceGraphVerification = { snapshotHash: sha('source-snapshot'), evidenceManifestHash: sha('evidence-manifest') };
  const jobId = 'job_test_approval_subsystem';
  const proposalHash = sha('proposal-hash');
  const binding = buildAdaptiveGoalApprovalBinding({ jobId, proposalHash, candidate, sourceGraphVerification });
  const policyExpires = ts(now + 10 * 60_000);
  const policy = sign({
    schema_version: 1,
    kind: 'adaptive_goal_execution_approval_policy',
    provider_id: 'approval-policy-provider',
    trust_root_sha256: rootHash(policyKey),
    nonce: crypto.randomUUID(),
    issued_at: ts(now - 1000),
    expires_at: policyExpires,
    scope: ADAPTIVE_GOAL_APPROVAL_POLICY_SCOPE,
    policy_id: 'approval-policy-test-001',
    policy_version: 1,
    required_approval_count: 2,
    required_distinct_trust_domains: 2,
    required_roles: ['security_checker', 'platform_checker'],
    maker_checker_separation: true,
    reject_veto: true,
    max_vote_age_seconds: 300,
    reviewer_registry: [
      { subject: 'reviewer-security', role: 'security_checker', trust_domain: 'security-domain', trust_root_sha256: rootHash(checkerA) },
      { subject: 'reviewer-platform', role: 'platform_checker', trust_domain: 'platform-domain', trust_root_sha256: rootHash(checkerB) }
    ]
  }, policyKey.privateKey);
  const policyHash = sha(canonicalJson(policy));
  const maker = sign({
    schema_version: 1,
    kind: 'adaptive_goal_action_intent_maker_attestation',
    provider_id: 'action-maker-provider',
    trust_root_sha256: rootHash(makerKey),
    nonce: crypto.randomUUID(),
    issued_at: ts(now - 800),
    expires_at: ts(now + 5 * 60_000),
    scope: ADAPTIVE_GOAL_MAKER_AUTHORIZATION_SCOPE,
    maker_subject: 'requester-alice',
    policy_id: policy.policy_id,
    policy_version: policy.policy_version,
    policy_hash: policyHash,
    binding
  }, makerKey.privateKey);
  const decision = (pair, subject, role, trustDomain, decisionValue = 'approve') => sign({
    schema_version: 1,
    kind: 'adaptive_goal_execution_approval_decision',
    provider_id: 'execution-approval-provider',
    trust_root_sha256: rootHash(pair),
    nonce: crypto.randomUUID(),
    issued_at: ts(now - 500),
    expires_at: ts(now + 4 * 60_000),
    scope: ADAPTIVE_GOAL_EXECUTION_APPROVAL_SCOPE,
    policy_id: policy.policy_id,
    policy_version: policy.policy_version,
    policy_hash: policyHash,
    reviewer_subject: subject,
    reviewer_role: role,
    trust_domain: trustDomain,
    decision: decisionValue,
    binding
  }, pair.privateKey);
  const evidence = {
    schema_version: 1,
    policy,
    maker_attestation: maker,
    decisions: [
      decision(checkerA, 'reviewer-security', 'security_checker', 'security-domain'),
      decision(checkerB, 'reviewer-platform', 'platform_checker', 'platform-domain')
    ]
  };
  const workflowDb = new DatabaseSync(':memory:');
  workflowDb.exec('CREATE TABLE events(event_id TEXT PRIMARY KEY,job_id TEXT NOT NULL,type TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL)');
  return { env, trustDb, workflowDb, candidate, sourceGraphVerification, jobId, proposalHash, binding, policy, maker, evidence,
    keys: { source, reviewerIdentity, policyKey, makerKey, checkerA, checkerB }, status,
    verify(overrides = {}) { return verifyAdaptiveGoalExecutionApprovalEvidence({ evidence, jobId, proposalHash, candidate, sourceGraphVerification,
      trustConfigurationDb: trustDb, workflowDb, now, environment: env, ...overrides }); } };
}

test('approval subsystem requires administrator-observed, host-managed policy/maker/checker trust roots and disjoint domains', () => {
  const fixture = createFixture();
  try {
    assert.equal(fixture.status.status, 'configured', JSON.stringify(fixture.status.blockers));
    const result = fixture.verify();
    assert.equal(result.verified, true);
    assert.equal(result.approvalBinding.binding.immutable_plan_hash, fixture.candidate.executionPlan.plan_hash);
    assert.equal(result.approvalBinding.binding.proposal_hash, fixture.proposalHash);
    assert.equal(result.approvalBinding.required_approval_count, 2);
    assert.deepEqual(result.approvalBinding.approved_trust_domains, ['platform-domain', 'security-domain']);
    assert.deepEqual(result.approvalBinding.approved_reviewer_subjects, ['reviewer-platform', 'reviewer-security']);
    assert.equal(result.approvalBinding.maker_subject, 'requester-alice');
    assert.equal(result.approvalBinding.binding_record_hash, sha(canonicalJson({ ...result.approvalBinding, binding_record_hash: undefined })),
      'the durable binding record hash is reproducible independently of serialization order');
  } finally { fixture.trustDb.close(); fixture.workflowDb.close(); }
});

test('approval subsystem fails closed when one trust configuration is missing or was not explicitly observed', () => {
  const missing = createFixture({ omitPolicyConfig: true });
  try {
    assert.equal(missing.status.status, 'blocked');
    assert.throws(() => missing.verify(), /AGG_TRUST_CONFIG_NOT_CONFIGURED|AGG_APPROVAL_TRUST_CONFIG_UNAVAILABLE/);
  } finally { missing.trustDb.close(); missing.workflowDb.close(); }

  const fixture = createFixture();
  try {
    const reviewerDb = new DatabaseSync(':memory:');
    try {
      initializeAdaptiveGoalTrustConfigurationLedger(reviewerDb);
      assert.throws(() => verifyAdaptiveGoalExecutionApprovalEvidence({ evidence: fixture.evidence, jobId: fixture.jobId,
        proposalHash: fixture.proposalHash, candidate: fixture.candidate, sourceGraphVerification: fixture.sourceGraphVerification,
        trustConfigurationDb: reviewerDb, workflowDb: fixture.workflowDb, now, environment: fixture.env }),
      /AGG_APPROVAL_TRUST_CONFIG_NOT_OBSERVED/);
    } finally { reviewerDb.close(); }
  } finally { fixture.trustDb.close(); fixture.workflowDb.close(); }
});

test('approval subsystem fails closed when the host trust ledger or durable policy ledger is unavailable', () => {
  const fixture = createFixture();
  try {
    assert.throws(() => verifyAdaptiveGoalExecutionApprovalEvidence({
      evidence: fixture.evidence, jobId: fixture.jobId, proposalHash: fixture.proposalHash,
      candidate: fixture.candidate, sourceGraphVerification: fixture.sourceGraphVerification,
      trustConfigurationDb: null, workflowDb: fixture.workflowDb, now, environment: fixture.env
    }), /AGG_APPROVAL_TRUST_LEDGER_UNAVAILABLE/,
    'approval verification must fail closed when the host-managed trust ledger is unavailable');

    assert.throws(() => verifyAdaptiveGoalExecutionApprovalEvidence({
      evidence: fixture.evidence, jobId: fixture.jobId, proposalHash: fixture.proposalHash,
      candidate: fixture.candidate, sourceGraphVerification: fixture.sourceGraphVerification,
      trustConfigurationDb: fixture.trustDb, workflowDb: null, now, environment: fixture.env
    }), /AGG_APPROVAL_POLICY_LEDGER_UNAVAILABLE/,
    'approval verification must fail closed when durable policy high-water/replay storage is unavailable');
  } finally { fixture.trustDb.close(); fixture.workflowDb.close(); }
});

test('approval subsystem rejects tampered policy, maker/checker subject reuse, stale action binding and missing quorum', () => {
  const fixture = createFixture();
  try {
    const tamperedPolicy = structuredClone(fixture.evidence);
    tamperedPolicy.policy.required_approval_count = 1;
    assert.throws(() => fixture.verify({ evidence: tamperedPolicy }), /AGG_APPROVAL_SIGNATURE_INVALID/);

    const makerIsChecker = structuredClone(fixture.evidence);
    makerIsChecker.decisions[0].reviewer_subject = makerIsChecker.maker_attestation.maker_subject;
    // Changing the subject without a new trusted vote signature fails before maker/checker checks.
    assert.throws(() => fixture.verify({ evidence: makerIsChecker }), /AGG_APPROVAL_SIGNATURE_INVALID/);

    const staleBinding = structuredClone(fixture.evidence);
    const { signature: priorMakerSignature, ...staleMakerUnsigned } = staleBinding.maker_attestation;
    staleMakerUnsigned.binding.candidate_hash = sha('a different candidate');
    staleBinding.maker_attestation = sign(staleMakerUnsigned, fixture.keys.makerKey.privateKey);
    assert.throws(() => fixture.verify({ evidence: staleBinding }), /AGG_APPROVAL_MAKER_BINDING_MISMATCH/);

    const oneVote = structuredClone(fixture.evidence);
    oneVote.decisions = oneVote.decisions.slice(0, 1);
    assert.throws(() => fixture.verify({ evidence: oneVote }), /AGG_APPROVAL_QUORUM_NOT_MET/);
  } finally { fixture.trustDb.close(); fixture.workflowDb.close(); }
});

test('approval subsystem independently rejects correctly signed but insufficient distinct trust-domain quorum and maker/checker violation', () => {
  const fixture = createFixture();
  try {
    const evidence = structuredClone(fixture.evidence);
    const policyUnsigned = { ...evidence.policy };
    delete policyUnsigned.signature;
    policyUnsigned.reviewer_registry[1].trust_domain = policyUnsigned.reviewer_registry[0].trust_domain;
    evidence.policy = sign(policyUnsigned, fixture.keys.policyKey.privateKey);
    const policyHash = sha(canonicalJson(evidence.policy));
    const makerUnsigned = { ...evidence.maker_attestation, policy_hash: policyHash };
    delete makerUnsigned.signature;
    evidence.maker_attestation = sign(makerUnsigned, fixture.keys.makerKey.privateKey);
    evidence.decisions = evidence.decisions.map(vote => {
      const unsigned = { ...vote, policy_hash: policyHash };
      delete unsigned.signature;
      return sign(unsigned, vote.reviewer_subject === 'reviewer-security' ? fixture.keys.checkerA.privateKey : fixture.keys.checkerB.privateKey);
    });
    assert.throws(() => fixture.verify({ evidence }), /AGG_APPROVAL_POLICY_QUORUM_UNREACHABLE/);

    const validPolicy = structuredClone(fixture.evidence.policy);
    const validMakerUnsigned = { ...fixture.evidence.maker_attestation, maker_subject: 'reviewer-security' };
    delete validMakerUnsigned.signature;
    const forgedMaker = sign(validMakerUnsigned, fixture.keys.makerKey.privateKey);
    assert.throws(() => fixture.verify({ evidence: { ...fixture.evidence, maker_attestation: forgedMaker, policy: validPolicy } }),
      /AGG_APPROVAL_MAKER_CHECKER_VIOLATION/);
  } finally { fixture.trustDb.close(); fixture.workflowDb.close(); }
});

test('approval subsystem rejects expiry, revoked checker roots, and replayed decision nonces', () => {
  const fixture = createFixture();
  try {
    const expired = structuredClone(fixture.evidence);
    const { signature: priorSignature, ...expiredUnsigned } = expired.decisions[0];
    expiredUnsigned.expires_at = ts(now - 1000);
    expired.decisions[0] = sign(expiredUnsigned, fixture.keys.checkerA.privateKey);
    assert.throws(() => fixture.verify({ evidence: expired }), /AGG_APPROVAL_EVIDENCE_EXPIRED/);

    const persistedBinding = fixture.verify().approvalBinding;
    fixture.workflowDb.prepare('INSERT INTO events(event_id,job_id,type,payload_json,created_at) VALUES(?,?,?,?,?)')
      .run('event-prior-approval', 'job_other', 'approval.approved', JSON.stringify({ approvalBinding: persistedBinding }), ts(now));
    assert.throws(() => fixture.verify(), /AGG_APPROVAL_NONCE_REPLAY/);
  } finally { fixture.trustDb.close(); fixture.workflowDb.close(); }

  const revoked = createFixture({ revokeApproverB: true });
  try {
    assert.throws(() => revoked.verify(), /AGG_APPROVAL_POLICY_REVIEWER_ROOT_UNTRUSTED|AGG_APPROVAL_TRUST_CONFIG_UNAVAILABLE|AGG_APPROVAL_TRUST_ROOT_REJECTED|AGG_TRUST_ROOT_REVOKED/);
  } finally { revoked.trustDb.close(); revoked.workflowDb.close(); }
});

test('approval policy high-water is transaction-only, idempotent for the same version, and blocks rollback/version reuse', () => {
  const fixture = createFixture();
  try {
    const policyId = 'high-water-policy-test';
    const versionOneHash = sha('signed-policy-v1');
    assert.throws(() => recordAdaptiveGoalApprovalPolicyHighWater(fixture.workflowDb, {
      jobId: fixture.jobId, policyId, policyVersion: 1, policyHash: versionOneHash, now
    }), /AGG_APPROVAL_POLICY_RECORD_REQUIRES_TRANSACTION/);

    fixture.workflowDb.exec('BEGIN IMMEDIATE');
    const first = recordAdaptiveGoalApprovalPolicyHighWater(fixture.workflowDb, {
      jobId: fixture.jobId, policyId, policyVersion: 1, policyHash: versionOneHash, now
    });
    assert.equal(first.recorded, true);
    assert.equal(fixture.workflowDb.isTransaction, true);
    fixture.workflowDb.exec('COMMIT');
    assert.equal(assertAdaptiveGoalApprovalPolicyHighWater(fixture.workflowDb, {
      policyId, policyVersion: 1, policyHash: versionOneHash, requireObserved: true
    }).status, 'current');

    fixture.workflowDb.exec('BEGIN IMMEDIATE');
    const duplicate = recordAdaptiveGoalApprovalPolicyHighWater(fixture.workflowDb, {
      jobId: 'another-candidate-job', policyId, policyVersion: 1, policyHash: versionOneHash, now: now + 1000
    });
    assert.equal(duplicate.recorded, false, 'same signed policy/version is reusable for a different candidate without hash/version reuse');
    fixture.workflowDb.exec('COMMIT');

    fixture.workflowDb.exec('BEGIN IMMEDIATE');
    assert.throws(() => recordAdaptiveGoalApprovalPolicyHighWater(fixture.workflowDb, {
      jobId: fixture.jobId, policyId, policyVersion: 1, policyHash: sha('different-policy-at-v1'), now: now + 2000
    }), /AGG_APPROVAL_POLICY_VERSION_REUSED/);
    assert.throws(() => recordAdaptiveGoalApprovalPolicyHighWater(fixture.workflowDb, {
      jobId: fixture.jobId, policyId, policyVersion: 3, policyHash: sha('signed-policy-v3'), now: now + 2000
    }), /AGG_APPROVAL_POLICY_VERSION_GAP/);
    assert.throws(() => recordAdaptiveGoalApprovalPolicyHighWater(fixture.workflowDb, {
      jobId: fixture.jobId, policyId, policyVersion: 0, policyHash: versionOneHash, now: now + 2000
    }), /AGG_APPROVAL_POLICY_VERSION_INVALID/);
    fixture.workflowDb.exec('ROLLBACK');

    const versionTwoHash = sha('signed-policy-v2');
    fixture.workflowDb.exec('BEGIN IMMEDIATE');
    const second = recordAdaptiveGoalApprovalPolicyHighWater(fixture.workflowDb, {
      jobId: fixture.jobId, policyId, policyVersion: 2, policyHash: versionTwoHash, now: now + 3000
    });
    assert.equal(second.recorded, true);
    fixture.workflowDb.exec('COMMIT');
    assert.throws(() => assertAdaptiveGoalApprovalPolicyHighWater(fixture.workflowDb, {
      policyId, policyVersion: 1, policyHash: versionOneHash, requireObserved: true
    }), /AGG_APPROVAL_POLICY_ROLLBACK/);
    assert.equal(assertAdaptiveGoalApprovalPolicyHighWater(fixture.workflowDb, {
      policyId, policyVersion: 2, policyHash: versionTwoHash, requireObserved: true
    }).status, 'current');
  } finally { fixture.trustDb.close(); fixture.workflowDb.close(); }
});

test('a reusable signed policy may authorize distinct candidate bindings without reusing maker/checker nonce decisions', () => {
  const fixture = createFixture();
  try {
    const firstVerified = fixture.verify();
    fixture.workflowDb.prepare('INSERT INTO events(event_id,job_id,type,payload_json,created_at) VALUES(?,?,?,?,?)')
      .run('event-reusable-policy-first', fixture.jobId, 'approval.approved', JSON.stringify({
        proposalHash: fixture.proposalHash,
        approvalBinding: firstVerified.approvalBinding
      }), ts(now));

    const candidate2 = structuredClone(fixture.candidate);
    candidate2.candidateId = 'agg-candidate-test-0002';
    candidate2.fingerprint = sha('candidate-fingerprint-two');
    candidate2.candidateHash = sha('candidate-hash-two');
    const planHash2 = sha('immutable-plan-two');
    candidate2.compiler.compilerPlanHash = planHash2;
    candidate2.executionPlan.plan_hash = planHash2;
    candidate2.executionPlan.required_operations = ['workspace.read', 'workspace.write', 'task.execute'];
    candidate2.hashes.reviewedActionIntentHash = sha('action-intents-two');
    candidate2.hashes.reviewedTaskInputContractHash = sha('task-inputs-two');
    candidate2.hashes.evidenceHash = sha('evidence-two');
    candidate2.hashes.sourceEvidenceHash = sha('source-evidence-two');
    const sourceGraphVerification2 = { snapshotHash: sha('source-snapshot-two'), evidenceManifestHash: sha('evidence-manifest-two') };
    const jobId2 = 'job_test_approval_subsystem_two';
    const proposalHash2 = sha('proposal-hash-two');
    const binding2 = buildAdaptiveGoalApprovalBinding({ jobId: jobId2, proposalHash: proposalHash2,
      candidate: candidate2, sourceGraphVerification: sourceGraphVerification2 });
    const policy = fixture.evidence.policy;
    const policyHash = sha(canonicalJson(policy));
    const { signature: makerSignature, ...makerUnsigned } = fixture.evidence.maker_attestation;
    makerUnsigned.nonce = crypto.randomUUID();
    makerUnsigned.issued_at = ts(now + 10);
    makerUnsigned.expires_at = ts(now + 5 * 60_000);
    makerUnsigned.binding = binding2;
    const maker2 = sign(makerUnsigned, fixture.keys.makerKey.privateKey);
    const decisions2 = fixture.evidence.decisions.map(vote => {
      const { signature: voteSignature, ...voteUnsigned } = vote;
      voteUnsigned.nonce = crypto.randomUUID();
      voteUnsigned.issued_at = ts(now + 20);
      voteUnsigned.expires_at = ts(now + 4 * 60_000);
      voteUnsigned.binding = binding2;
      return sign(voteUnsigned, vote.reviewer_subject === 'reviewer-security'
        ? fixture.keys.checkerA.privateKey : fixture.keys.checkerB.privateKey);
    });
    const evidence2 = { schema_version: 1, policy, maker_attestation: maker2, decisions: decisions2 };
    assert.equal(sha(canonicalJson(evidence2.policy)), policyHash, 'the reusable signed policy is byte-stable across candidate bindings');
    const verified2 = verifyAdaptiveGoalExecutionApprovalEvidence({ evidence: evidence2, jobId: jobId2,
      proposalHash: proposalHash2, candidate: candidate2, sourceGraphVerification: sourceGraphVerification2,
      trustConfigurationDb: fixture.trustDb, workflowDb: fixture.workflowDb, now: now + 30, environment: fixture.env });
    assert.equal(verified2.verified, true);
    assert.equal(verified2.approvalBinding.binding.candidate_id, candidate2.candidateId);
    assert.notEqual(verified2.approvalBinding.binding_hash, firstVerified.approvalBinding.binding_hash);
    assert.notEqual(verified2.approvalBinding.binding_record_hash, firstVerified.approvalBinding.binding_record_hash);
  } finally { fixture.trustDb.close(); fixture.workflowDb.close(); }
});
