import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildPhase1Readiness, adjudicatePhase1AB, PHASE1_PROTOCOL_VERSION, PHASE1_ATTESTATION_SCHEMA_VERSION,
  verifyPhase1AttestationSignature, validateOperationalAuthorizationRunWindow, validatePhase1CandidateArchive,
  assertDistinctPhase1AttestationNonces, assertFrozenProtocolHashes, verifyPhase1ExecutionGateConsumption,
  canonicalEd25519PublicKeyFingerprint, assertStablePhase1TargetBinding,
  capturePhase1EvidenceInventory, assertStablePhase1EvidenceInventory,
  capturePhase1InputFileIdentity, assertStablePhase1InputFileIdentity, FROZEN_PROTOCOL_HASHES,
  PHASE1_CATEGORIES, PHASE1_CONDITIONS, PHASE1_HARD_FAILS, PHASE1_SCENARIOS
} from '../benchmarks/plugin-workflow-benchmark/phase1-protocol-runner.mjs';
import { canonicalJson } from '../src/runtime/workflow/plan.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(root, 'benchmarks/plugin-workflow-benchmark/phase1-protocol-runner.mjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

test('frozen protocol hash pins reject even syntactically valid changed acceptance criteria', () => {
  const planHash = sha(fs.readFileSync(path.join(root, 'docs/plugin-workflow-benchmark-plan.md')));
  const freezePath = path.join(root, 'docs/plugin-workflow-benchmark-phase1-freeze.md');
  const freezeHash = FROZEN_PROTOCOL_HASHES.freezeSha256;
  if (fs.existsSync(freezePath)) {
    assert.equal(sha(fs.readFileSync(freezePath)), freezeHash, 'provided owner overlay bytes must match the immutable freeze pin');
  }
  assert.deepEqual(assertFrozenProtocolHashes({ protocolPlanSha256: planHash, freezeSha256: freezeHash }), {
    protocolPlanSha256: planHash, freezeSha256: freezeHash
  });
  assert.throws(() => assertFrozenProtocolHashes({ protocolPlanSha256: '0'.repeat(64), freezeSha256: freezeHash }),
    error => error.code === 'PHASE1_FROZEN_PROTOCOL_HASH_MISMATCH',
    'a modified plan may not reuse signatures that name the previously frozen hash');
  assert.throws(() => assertFrozenProtocolHashes({ protocolPlanSha256: planHash, freezeSha256: 'f'.repeat(64) }),
    error => error.code === 'PHASE1_FROZEN_PROTOCOL_HASH_MISMATCH',
    'a modified freeze record must block without treating a syntactically valid digest as approval');
});
function signEd25519(key, unsigned) {
  return crypto.sign(null, Buffer.from(canonicalJson(unsigned), 'utf8'), key).toString('base64');
}
function attestationBase(corpusBytes, runsBytes, corpusId, keys) {
  const planHash = sha(fs.readFileSync(path.join(root, 'docs/plugin-workflow-benchmark-plan.md')));
  const freezeHash = FROZEN_PROTOCOL_HASHES.freezeSha256;
  const now = Date.now();
  const corpus = JSON.parse(corpusBytes.toString('utf8'));
  const approvalUnsigned = {
    schemaVersion: PHASE1_ATTESTATION_SCHEMA_VERSION, protocolVersion: PHASE1_PROTOCOL_VERSION,
    kind: 'phase1_benchmark_corpus_approval', candidateBundleSha256: corpus.runSettings.targetBundleSha256,
    sourceSnapshotSha256: corpus.runSettings.targetSourceSnapshotSha256, corpusId,
    corpusSha256: sha(corpusBytes), protocolPlanSha256: planHash, freezeSha256: freezeHash,
    ownerSubject: 'unit-test-only-owner-key', scope: 'plugin-workflow-benchmark.phase1.corpus-approval',
    issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    nonce: crypto.randomUUID(), signatureAlgorithm: 'Ed25519'
  };
  const approval = { ...approvalUnsigned, signature: signEd25519(keys.owner.privateKey, approvalUnsigned) };
  const runsUnsigned = {
    schemaVersion: PHASE1_ATTESTATION_SCHEMA_VERSION, protocolVersion: PHASE1_PROTOCOL_VERSION,
    kind: 'phase1_benchmark_evidence_adjudication', candidateBundleSha256: corpus.runSettings.targetBundleSha256,
    sourceSnapshotSha256: corpus.runSettings.targetSourceSnapshotSha256, corpusId,
    corpusSha256: sha(corpusBytes), runsSha256: sha(runsBytes), protocolPlanSha256: planHash,
    freezeSha256: freezeHash, evaluatorSubject: 'unit-test-only-evaluator-key',
    scope: 'plugin-workflow-benchmark.phase1.evidence-adjudication',
    issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    nonce: crypto.randomUUID(), signatureAlgorithm: 'Ed25519'
  };
  const runsAttestation = { ...runsUnsigned, signature: signEd25519(keys.evaluator.privateKey, runsUnsigned) };
  return { approval, runsAttestation };
}

function makeEvidenceFixture(temp, { hardFailViolation = false, missingPluginScoreEvidence = false, ratingValue = 1,
  manualIntervention = false, wrongConditionVersion = false, outOfRangeIteration = false } = {}) {
  const evidenceRoot = path.join(temp, 'evidence');
  fs.mkdirSync(evidenceRoot, { mode: 0o700 });
  const keys = { owner: crypto.generateKeyPairSync('ed25519'), evaluator: crypto.generateKeyPairSync('ed25519') };
  const scenarios = PHASE1_SCENARIOS.map(item => ({
    id: item.id, title: item.title,
    initialState: { scenario_id: item.id, fixture: 'unit-test-input-only-not-operational-evidence' },
    exactInput: `UNIT TEST INPUT ONLY for ${item.id}; never a measured operational run`,
    allowedToolsByCondition: {
      plugin_enabled: ['read-only-test-fixture-tool'],
      basic_tools: ['read-only-test-fixture-tool']
    },
    permissions: { readOnly: true, network: false, production: false, workflowExecutionAllowed: false, hardDeniedTools: [] },
    expectedActionSequence: ['inspect-test-fixture', 'verify-test-output'],
    forbiddenActions: ['mutate-production', 'invent-evidence'],
    expectedArtifacts: ['hashed-run-log'],
    verifier: { kind: 'unit-test-only', fixtureMustRemainNonOperational: true },
    verificationProcedure: 'Unit-test fixture checks a signature-bound hash and exact scorer contract; does not model real workflow effectiveness.',
    mandatoryCriteria: ['evidence_present', 'final_status_correct']
  }));
  const corpus = {
    schemaVersion: 1,
    corpusId: 'unit-test-only-not-an-approved-corpus',
    purpose: 'unit-test-only; scorer-contract-tests-not-operational',
    scenarios,
    runSettings: {
      pluginEnabledVersion: 'unit-test-plugin-fixture', basicToolsVersion: 'unit-test-basic-fixture',
      targetBundleSha256: 'f'.repeat(64), targetSourceSnapshotSha256: 'a'.repeat(64), basicToolsCatalog: ['read-only-test-fixture-tool'],
      requiredIterationsPerScenario: 1,
      frozenEnvironment: { description: 'Unit-test constructed input only; not a real frozen execution environment.' },
      budget: { maxModelTurnsPerCondition: 12, maxToolCallsPerCondition: 20, maxElapsedSecondsPerCondition: 300 },
      seedStrategy: 'unit-test-fixed-seed-not-operational'
    }
  };
  const corpusBytes = jsonBytes(corpus);
  const runs = [];
  for (const scenario of scenarios) {
    for (const condition of PHASE1_CONDITIONS) {
      const artifactId = `${scenario.id}-${condition}-log`;
      const relativePath = `${artifactId}.txt`;
      const payload = Buffer.from(`UNIT-TEST-ONLY ${scenario.id} ${condition}\n`);
      fs.writeFileSync(path.join(evidenceRoot, relativePath), payload, { flag: 'wx', mode: 0o600 });
      const artifact = { artifactId, relativePath, sha256: sha(payload), kind: 'hashed-run-log' };
      const artifactRefs = missingPluginScoreEvidence && condition === 'plugin_enabled' ? [] : [artifactId];
      const recordsManualIntervention = manualIntervention && condition === 'basic_tools' && scenario.id === PHASE1_SCENARIOS[0].id;
      const actionTimestamp = '2026-01-01T00:00:00.100Z';
      const categoryRatings = Object.fromEntries(Object.entries(PHASE1_CATEGORIES).map(([category]) => [category, {
        rating: artifactRefs.length ? ratingValue : null,
        status: artifactRefs.length ? 'verified' : 'unverified', evidenceArtifactIds: artifactRefs
      }]));
      const hardFailChecks = Object.fromEntries(PHASE1_HARD_FAILS.map((id, index) => [id, {
        status: hardFailViolation && condition === 'plugin_enabled' && scenario.id === PHASE1_SCENARIOS[0].id && index === 0
          ? 'violation' : 'not_observed_with_evidence',
        evidenceArtifactIds: [artifactId]
      }]));
      runs.push({
        runId: `${scenario.id}-${condition}-iteration-1`, scenarioId: scenario.id, condition,
        conditionVersion: wrongConditionVersion && condition === 'plugin_enabled' ? 'unapproved-condition-version'
          : condition === 'plugin_enabled' ? 'unit-test-plugin-fixture' : 'unit-test-basic-fixture', iteration: 1,
        startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:01.000Z',
        initialStateSha256: sha(Buffer.from(canonicalJson(scenario.initialState))),
        status: 'passed',
        actions: [{ timestamp: actionTimestamp, kind: recordsManualIntervention ? 'manual_intervention' : 'verification', tool: 'unit-test-fixture-tool',
          inputSha256: sha(Buffer.from('input')), outputSha256: sha(Buffer.from('output')), exitCode: 0,
          stateBeforeSha256: null, stateAfterSha256: null }],
        criteria: scenario.mandatoryCriteria.map(id => ({ id, status: 'passed', evidenceArtifactIds: [artifactId] })),
        categoryRatings, hardFailChecks, artifacts: [artifact],
        manualInterventions: recordsManualIntervention ? [{ timestamp: actionTimestamp, actor: 'unit-test-only operator',
          description: 'Recorded test-only intervention to confirm scoring counts the event.', evidenceArtifactIds: [artifactId] }] : [],
        adjudicatedMeasurements: {
          correctCompletion: true, falseReportDetected: false,
          recoveryOutcome: ['requirement_change', 'required_step_failure', 'timeout_unknown_outcome', 'environment_change'].includes(scenario.id)
            ? 'succeeded' : 'not_applicable',
          traceabilityStatus: artifactRefs.length ? 'passed' : 'unverified'
        }
      });
    }
  }
  if (outOfRangeIteration) runs[0].iteration = 2;
  const runsEnvelope = {
    schemaVersion: 1, corpusId: corpus.corpusId, corpusSha256: sha(corpusBytes),
    protocolSnapshot: {
      packageVersion: 'unit-test-not-a-product-version', runtimeVersion: 'unit-test-only',
      pluginManifestSha256: 'a'.repeat(64), serverSha256: 'b'.repeat(64),
      environmentFingerprintSha256: 'c'.repeat(64), permissionSnapshotSha256: 'd'.repeat(64),
      dependencySnapshotSha256: 'e'.repeat(64), isolatedWorkspaceDescription: 'unit test temp directory only',
      modelCalls: 0, tokenCost: null, monetaryCost: null
    },
    runs
  };
  const runsBytes = jsonBytes(runsEnvelope);
  const attestations = attestationBase(corpusBytes, runsBytes, corpus.corpusId, keys);
  for (const [name, bytes] of [
    ['corpus.json', corpusBytes], ['owner-attestation.json', jsonBytes(attestations.approval)],
    ['runs.json', runsBytes], ['evaluator-attestation.json', jsonBytes(attestations.runsAttestation)],
    ['owner-trust-root.pem', Buffer.from(keys.owner.publicKey.export({ type: 'spki', format: 'pem' }))],
    ['evaluator-trust-root.pem', Buffer.from(keys.evaluator.publicKey.export({ type: 'spki', format: 'pem' }))]
  ]) fs.writeFileSync(path.join(temp, name), bytes, { flag: 'wx', mode: 0o600 });
  return { evidenceRoot, corpusPath: path.join(temp, 'corpus.json'), corpusAttestationPath: path.join(temp, 'owner-attestation.json'),
    runsPath: path.join(temp, 'runs.json'), runsAttestationPath: path.join(temp, 'evaluator-attestation.json'),
    corpusTrustRootPath: path.join(temp, 'owner-trust-root.pem'), evaluatorTrustRootPath: path.join(temp, 'evaluator-trust-root.pem'),
    evidenceRootPath: evidenceRoot };
}

test('attestation verifier pins the exact trust-root bytes and rejects malformed base64, symlink roots and schema downgrade', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-trust-root-pin-'));
  try {
    const trusted = crypto.generateKeyPairSync('ed25519');
    const attacker = crypto.generateKeyPairSync('ed25519');
    const trustedPem = Buffer.from(trusted.publicKey.export({ type: 'spki', format: 'pem' }));
    const attackerPem = Buffer.from(attacker.publicKey.export({ type: 'spki', format: 'pem' }));
    const trustedPath = path.join(temp, 'trusted.pem');
    const attackerPath = path.join(temp, 'attacker.pem');
    fs.writeFileSync(trustedPath, trustedPem, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(attackerPath, attackerPem, { flag: 'wx', mode: 0o600 });
    const unsigned = {
      schemaVersion: PHASE1_ATTESTATION_SCHEMA_VERSION,
      protocolVersion: PHASE1_PROTOCOL_VERSION,
      kind: 'unit-test-only-signature-envelope',
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nonce: crypto.randomUUID(),
      signatureAlgorithm: 'Ed25519'
    };
    const sign = (key, value) => ({ ...value, signature: crypto.sign(null, Buffer.from(canonicalJson(value)), key).toString('base64') });
    const signed = sign(trusted.privateKey, unsigned);
    const keys = Object.keys(signed);
    const trustedPin = sha(trustedPem);

    assert.equal(verifyPhase1AttestationSignature(signed, keys, trustedPath, trustedPin).signerTrustRootSha256, trustedPin);
    assert.throws(() => verifyPhase1AttestationSignature(signed, keys, trustedPath),
      /PHASE1_TRUST_ANCHOR_NOT_CONFIGURED/, 'even a test-callable signature verifier must not validate a signer without a pinned trust root');
    const attackerSigned = sign(attacker.privateKey, unsigned);
    assert.throws(() => verifyPhase1AttestationSignature(attackerSigned, keys, attackerPath, trustedPin),
      /PHASE1_TRUST_ANCHOR_PIN_MISMATCH/, 'a valid signature under a caller-supplied but unpinned key must fail');
    assert.throws(() => verifyPhase1AttestationSignature({ ...signed, signature: `${signed.signature}!` }, keys, trustedPath, trustedPin),
      /PHASE1_ATTESTATION_SIGNATURE_INVALID/, 'noncanonical base64 must fail rather than be permissively decoded');
    assert.throws(() => verifyPhase1AttestationSignature({ ...signed, schemaVersion: 1 }, keys, trustedPath, trustedPin),
      /PHASE1_ATTESTATION_TIME_OR_SCHEMA_INVALID/, 'old signature-envelope schema must not downgrade the protocol');
    const symlinkPath = path.join(temp, 'trusted-link.pem');
    fs.symlinkSync(trustedPath, symlinkPath);
    assert.throws(() => verifyPhase1AttestationSignature(signed, keys, symlinkPath, trustedPin),
      /PHASE1_TRUST_ROOT_INVALID/, 'public trust roots must be read through stable no-follow regular-file descriptors');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('canonical trust-root identity detects same Ed25519 key under distinct valid PEM byte encodings', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-canonical-key-identity-'));
  try {
    const pair = crypto.generateKeyPairSync('ed25519');
    const canonicalPem = Buffer.from(pair.publicKey.export({ type: 'spki', format: 'pem' }));
    const alternatePem = Buffer.from(canonicalPem.toString('utf8').replace(/\n/g, '\r\n'));
    const first = path.join(temp, 'owner.pem');
    const second = path.join(temp, 'reviewer.pem');
    fs.writeFileSync(first, canonicalPem, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(second, alternatePem, { flag: 'wx', mode: 0o600 });
    assert.notEqual(sha(canonicalPem), sha(alternatePem), 'PEM byte pins remain distinct');
    assert.equal(canonicalEd25519PublicKeyFingerprint(first, sha(canonicalPem)),
      canonicalEd25519PublicKeyFingerprint(second, sha(alternatePem)),
      'canonical SPKI fingerprint must expose cryptographic role collision despite PEM formatting differences');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('final target-binding barrier rejects changes to every acceptance-relevant derived contract field', () => {
  const initial = {
    candidateBundleSha256: 'a'.repeat(64), proposalSha256: 'b'.repeat(64), ownerApprovalSha256: 'c'.repeat(64),
    sourceAlignmentStatus: 'PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT', promptsMatch: true,
    perCaseAllowlistCompatibility: true, case6PolicyIntact: true,
    historicalOwnerApprovalIntegrity: true, historicalExecutionGatesRemainClosed: true,
    formalOwnerApprovalBindsCurrentTarget: false
  };
  assert.equal(assertStablePhase1TargetBinding(initial, structuredClone(initial)), true);
  for (const field of ['promptsMatch', 'perCaseAllowlistCompatibility', 'case6PolicyIntact',
    'historicalOwnerApprovalIntegrity', 'historicalExecutionGatesRemainClosed', 'formalOwnerApprovalBindsCurrentTarget']) {
    const changed = { ...initial, [field]: !initial[field] };
    assert.throws(() => assertStablePhase1TargetBinding(initial, changed),
      error => error.code === 'PHASE1_INPUT_CHANGED_DURING_ADJUDICATION',
      `${field} is acceptance-relevant and must be rechecked even if the candidate and a selected subset of hashes are unchanged`);
  }
  assert.throws(() => assertStablePhase1TargetBinding(initial, null),
    error => error.code === 'PHASE1_INPUT_CHANGED_DURING_ADJUDICATION');
});

test('acceptance evidence inventory fails closed on add, remove, byte change, inode replacement and symlink substitution', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-evidence-inventory-'));
  try {
    const root = path.join(temp, 'evidence');
    fs.mkdirSync(path.join(root, 'runs'), { recursive: true, mode: 0o700 });
    const source = path.join(root, 'runs', 'raw.json');
    fs.writeFileSync(source, '{"run":1}\n', { mode: 0o600 });
    const initial = capturePhase1EvidenceInventory(root);
    assert.equal(assertStablePhase1EvidenceInventory(root, initial), true);

    fs.writeFileSync(path.join(root, 'new-receipt.json'), '{"receipt":true}\n', { mode: 0o600 });
    assert.throws(() => assertStablePhase1EvidenceInventory(root, initial),
      error => error.code === 'PHASE1_INPUT_CHANGED_DURING_ADJUDICATION', 'an added input must invalidate the decision snapshot');
    fs.unlinkSync(path.join(root, 'new-receipt.json'));

    fs.writeFileSync(source, '{"run":2}\n', { mode: 0o600 });
    assert.throws(() => assertStablePhase1EvidenceInventory(root, initial),
      error => error.code === 'PHASE1_INPUT_CHANGED_DURING_ADJUDICATION', 'changed raw evidence bytes must invalidate the decision snapshot');
    fs.writeFileSync(source, '{"run":1}\n', { mode: 0o600 });
    const beforeReplacement = capturePhase1EvidenceInventory(root);
    const replacement = path.join(root, 'runs', 'replacement.tmp');
    fs.writeFileSync(replacement, '{"run":1}\n', { mode: 0o600 });
    fs.renameSync(replacement, source);
    assert.throws(() => assertStablePhase1EvidenceInventory(root, beforeReplacement),
      error => error.code === 'PHASE1_INPUT_CHANGED_DURING_ADJUDICATION', 'same bytes at a replaced inode must invalidate path identity');

    fs.unlinkSync(source);
    fs.symlinkSync(path.join(temp, 'outside.json'), source);
    assert.throws(() => capturePhase1EvidenceInventory(root),
      error => error.code === 'PHASE1_EVIDENCE_INVENTORY_INVALID', 'symlink substitution must fail closed');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('explicit acceptance inputs reject same-byte inode replacement and in-place identity changes', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-input-identity-'));
  try {
    const input = path.join(temp, 'signed-approval.json');
    fs.writeFileSync(input, '{"approval":"same-bytes"}\n', { mode: 0o600 });
    const initial = capturePhase1InputFileIdentity(input, 'test signed approval');
    const replacement = path.join(temp, 'replacement.tmp');
    fs.writeFileSync(replacement, '{"approval":"same-bytes"}\n', { mode: 0o600 });
    fs.renameSync(replacement, input);
    assert.throws(() => assertStablePhase1InputFileIdentity(input, initial, 'test signed approval'),
      error => error.code === 'PHASE1_INPUT_IDENTITY_CHANGED_DURING_ADJUDICATION',
      'same bytes at a new inode must invalidate an explicit acceptance input');

    const second = capturePhase1InputFileIdentity(input, 'test signed approval');
    fs.writeFileSync(input, '{"approval":"changed-bytes"}\n', { mode: 0o600 });
    assert.throws(() => assertStablePhase1InputFileIdentity(input, second, 'test signed approval'),
      error => error.code === 'PHASE1_INPUT_IDENTITY_CHANGED_DURING_ADJUDICATION',
      'in-place mutation after the input snapshot must invalidate its identity');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('operational authorization freshness is measured against the paired execution window, not score wall-clock alone', () => {
  const now = Date.now();
  const time = ms => new Date(ms).toISOString();
  const authorization = { issuedAt: time(now - 55 * 60_000), expiresAt: time(now + 10 * 60_000) };
  const runs = { runs: [
    { startedAt: time(now - 54 * 60_000), endedAt: time(now - 50 * 60_000) },
    { startedAt: time(now - 8 * 60_000), endedAt: time(now - 2 * 60_000) }
  ] };
  assert.deepEqual(validateOperationalAuthorizationRunWindow(authorization, runs), {
    firstRunStartedAt: runs.runs[0].startedAt, lastRunEndedAt: runs.runs[1].endedAt
  }, 'long paired runs remain verifiable when authorization was fresh at first start and remains valid through adjudication');
  assert.throws(() => validateOperationalAuthorizationRunWindow({ ...authorization, issuedAt: time(now - 3 * 60 * 60_000) }, runs),
    /PHASE1_OPERATIONAL_AUTHORIZATION_WINDOW_INVALID/, 'an authorization too old at first scenario start must fail');
  assert.throws(() => validateOperationalAuthorizationRunWindow({ ...authorization, issuedAt: time(now - 6 * 60_000) }, runs),
    /PHASE1_OPERATIONAL_AUTHORIZATION_WINDOW_INVALID/, 'authorization issued after the first scenario began must fail');
  assert.throws(() => validateOperationalAuthorizationRunWindow({ ...authorization, expiresAt: time(now - 4 * 60_000) }, runs),
    /PHASE1_OPERATIONAL_AUTHORIZATION_WINDOW_INVALID/, 'authorization expired before the last scenario/adjudication must fail');
});

test('one-shot gate-consumption receipt is owner-signed and bound to exactly one candidate, authorization nonce, run ledger and durable record', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-gate-consumption-test-only-'));
  try {
    const keys = crypto.generateKeyPairSync('ed25519');
    const publicBytes = keys.publicKey.export({ type: 'spki', format: 'pem' });
    const ownerPemPath = path.join(temp, 'test-only-owner.pem');
    fs.writeFileSync(ownerPemPath, publicBytes, { mode: 0o600 });
    const ownerTrustRootSha256 = sha(publicBytes);
    const now = Date.now();
    const firstRunStartedAt = new Date(now - 120_000).toISOString();
    const lastRunEndedAt = new Date(now - 60_000).toISOString();
    const consumedAt = new Date(Date.parse(firstRunStartedAt) - 1_000).toISOString();
    const issuedAt = new Date(Date.parse(consumedAt) - 1_000).toISOString();
    const expiresAt = new Date(now + 300_000).toISOString();
    const corpusBytes = Buffer.from('{"corpusId":"fixture-corpus"}\n');
    const corpus = { corpusId: 'fixture-corpus' };
    const runsEnvelope = { runs: [
      { runId: 'run-one', startedAt: firstRunStartedAt, endedAt: new Date(Date.parse(firstRunStartedAt) + 10_000).toISOString(), execution: { executionId: 'exec-one' } },
      { runId: 'run-two', startedAt: new Date(Date.parse(firstRunStartedAt) + 20_000).toISOString(), endedAt: lastRunEndedAt, execution: { executionId: 'exec-two' } }
    ] };
    const runsBytes = Buffer.from('{"runs":"fixture ledger bytes"}\n');
    const operationalAuthorization = {
      ownerSubject: 'fixture-owner-subject',
      attestationSha256: 'a'.repeat(64),
      attestationNonce: 'operational-auth-nonce-unique-01',
      issuedAt: new Date(Date.parse(firstRunStartedAt) - 120_000).toISOString(),
      expiresAt
    };
    const targetBinding = { candidateBundleSha256: 'b'.repeat(64), sourceSnapshotSha256: 'c'.repeat(64) };
    const planHash = sha(fs.readFileSync(path.join(root, 'docs/plugin-workflow-benchmark-plan.md')));
    const freezeHash = FROZEN_PROTOCOL_HASHES.freezeSha256;
    const unsigned = {
      schemaVersion: PHASE1_ATTESTATION_SCHEMA_VERSION,
      protocolVersion: PHASE1_PROTOCOL_VERSION,
      kind: 'phase1_execution_gate_consumption',
      decisionId: 'gate-decision-fixture-000001',
      candidateBundleSha256: targetBinding.candidateBundleSha256,
      sourceSnapshotSha256: targetBinding.sourceSnapshotSha256,
      corpusId: corpus.corpusId,
      corpusSha256: sha(corpusBytes),
      runsSha256: sha(runsBytes),
      operationalAuthorizationAttestationSha256: operationalAuthorization.attestationSha256,
      operationalAuthorizationNonce: operationalAuthorization.attestationNonce,
      protocolPlanSha256: planHash,
      freezeSha256: freezeHash,
      ownerSubject: operationalAuthorization.ownerSubject,
      scope: 'plugin-workflow-benchmark.phase1.execution-gate-consumption',
      issuedAt, expiresAt, consumedAt,
      executionIds: ['exec-one', 'exec-two'],
      nonce: 'gate-receipt-nonce-unique-001',
      signatureAlgorithm: 'Ed25519'
    };
    const receipt = { ...unsigned, signature: signEd25519(keys.privateKey, unsigned) };
    const receiptBytes = jsonBytes(receipt);
    const receiptPath = path.join(temp, 'gate-receipt.json');
    fs.writeFileSync(receiptPath, receiptBytes, { mode: 0o600 });
    const ledgerRow = {
      schemaVersion: 1,
      decisionId: receipt.decisionId,
      candidateBundleSha256: receipt.candidateBundleSha256,
      sourceSnapshotSha256: receipt.sourceSnapshotSha256,
      corpusId: receipt.corpusId,
      corpusSha256: receipt.corpusSha256,
      runsSha256: receipt.runsSha256,
      operationalAuthorizationAttestationSha256: receipt.operationalAuthorizationAttestationSha256,
      operationalAuthorizationNonce: receipt.operationalAuthorizationNonce,
      protocolPlanSha256: receipt.protocolPlanSha256,
      freezeSha256: receipt.freezeSha256,
      executionIds: receipt.executionIds,
      consumedAt: receipt.consumedAt,
      receiptSha256: sha(receiptBytes),
      receiptNonce: receipt.nonce,
      status: 'CONSUMED_ONCE'
    };
    const ledgerPath = path.join(temp, 'durable-gate-consumption.jsonl');
    const ledgerBytes = Buffer.from(`${JSON.stringify(ledgerRow)}\n`);
    fs.writeFileSync(ledgerPath, ledgerBytes, { mode: 0o600 });
    const input = {
      receiptPath, ownerTrustRootPath: ownerPemPath, ownerTrustRootSha256,
      targetBinding, corpus, corpusBytes, corpusApprovalOwnerSubject: operationalAuthorization.ownerSubject,
      runsEnvelope, runsBytes, operationalAuthorization, ledgerPath, allowTestFixtures: true
    };
    const verified = verifyPhase1ExecutionGateConsumption(input);
    assert.equal(verified.status, 'VERIFIED_ONE_SHOT_GATE_CONSUMPTION');
    assert.equal(verified.ledgerRecordCount, 1);
    assert.deepEqual(verified.executionIds, ['exec-one', 'exec-two']);

    fs.writeFileSync(ledgerPath, Buffer.concat([ledgerBytes, ledgerBytes]));
    assert.throws(() => verifyPhase1ExecutionGateConsumption(input), /PHASE1_EXECUTION_GATE_LEDGER_REPLAY/,
      'the same authorization nonce/decision must not be consumable twice in the durable record');
    fs.writeFileSync(ledgerPath, ledgerBytes);
    const otherDecisionReplayingExecution = {
      ...ledgerRow,
      decisionId: 'gate-decision-fixture-000002',
      candidateBundleSha256: 'd'.repeat(64),
      sourceSnapshotSha256: 'e'.repeat(64),
      corpusId: 'fixture-corpus-other',
      corpusSha256: 'f'.repeat(64),
      runsSha256: '1'.repeat(64),
      operationalAuthorizationAttestationSha256: '2'.repeat(64),
      operationalAuthorizationNonce: 'operational-auth-nonce-unique-02',
      executionIds: ['exec-one'],
      receiptSha256: '3'.repeat(64),
      receiptNonce: 'gate-receipt-nonce-unique-002'
    };
    fs.writeFileSync(ledgerPath, Buffer.from(`${JSON.stringify(ledgerRow)}\n${JSON.stringify(otherDecisionReplayingExecution)}\n`));
    assert.throws(() => verifyPhase1ExecutionGateConsumption(input), /PHASE1_EXECUTION_GATE_LEDGER_REPLAY/,
      'an execution ID consumed under one decision cannot be replayed by a different decision/authorization nonce');
    fs.writeFileSync(ledgerPath, ledgerBytes);
    const changedRuns = { ...runsEnvelope, runs: [...runsEnvelope.runs, {
      runId: 'run-three', startedAt: firstRunStartedAt, endedAt: lastRunEndedAt, execution: { executionId: 'exec-three' }
    }] };
    assert.throws(() => verifyPhase1ExecutionGateConsumption({ ...input, runsEnvelope: changedRuns }),
      /PHASE1_EXECUTION_GATE_RECEIPT_BINDING_MISMATCH|PHASE1_EXECUTION_GATE_RECEIPT_EXECUTION_SET_MISMATCH/,
      'the receipt cannot be replayed against a changed run/execution set');
    assert.throws(() => verifyPhase1ExecutionGateConsumption({ ...input, allowTestFixtures: false, ledgerPath }),
      /PHASE1_EXECUTION_GATE_LEDGER_PATH_INVALID/,
      'production callers cannot point the scorer at a caller-selected replacement ledger');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('cross-role attestation nonce reuse is rejected within one candidate acceptance packet', () => {
  assert.equal(assertDistinctPhase1AttestationNonces([
    { attestationNonce: 'owner-nonce-00000001' }, { attestationNonce: 'reviewer-nonce-0000001' },
    { attestationNonce: 'evaluator-nonce-000001' }, { attestationNonce: 'isolation-nonce-00001' }
  ]), true);
  assert.throws(() => assertDistinctPhase1AttestationNonces([
    { attestationNonce: 'owner-nonce-00000001' }, { attestationNonce: 'owner-nonce-00000001' }
  ]), /PHASE1_ATTESTATION_NONCE_REPLAY/);
  assert.throws(() => assertDistinctPhase1AttestationNonces([
    { attestationNonce: 'owner-nonce-00000001' }, { attestationNonce: '' }
  ]), /PHASE1_ATTESTATION_NONCE_REPLAY/);
});

test('frozen candidate inspection rejects ZIP symlink entries before reading manifest/server bytes', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-candidate-archive-'));
  try {
    fs.mkdirSync(path.join(temp, 'server'));
    fs.writeFileSync(path.join(temp, 'manifest.json'), JSON.stringify({
      version: 'test-1', server: { entry_point: 'server/index.js' }, tools: [{ name: 'test_tool' }]
    }) + '\n');
    fs.writeFileSync(path.join(temp, 'server/index.js'), 'export const testOnly = true;\n');
    fs.symlinkSync('server/index.js', path.join(temp, 'server-link.js'));
    const bundle = path.join(temp, 'symlink.mcpb');
    const zipped = spawnSync('zip', ['-X', '-y', '-q', bundle, 'manifest.json', 'server/index.js', 'server-link.js'], { cwd: temp, encoding: 'utf8' });
    assert.equal(zipped.status, 0, zipped.stderr);
    assert.throws(() => validatePhase1CandidateArchive(fs.readFileSync(bundle)), /PHASE1_CANDIDATE_ARCHIVE_INVALID/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('readiness preserves the original protocol and blocks without trusted corpus and actual A/B run evidence', () => {
  const readiness = buildPhase1Readiness();
  const freezeDocumentAvailable = fs.existsSync(path.join(root, 'docs/plugin-workflow-benchmark-phase1-freeze.md'));
  assert.equal(readiness.sourceProtocol.freezeDocumentAvailable, freezeDocumentAvailable);
  assert.equal(readiness.sourceProtocol.freezeDocumentHashVerified, freezeDocumentAvailable);
  if (!freezeDocumentAvailable) {
    assert.equal(readiness.sourceProtocol.freezeSha256, null);
    assert.ok(readiness.blockers.some(message => /pinned digest is not evidence that the document bytes were supplied or verified/.test(message)));
  }
  assert.equal(readiness.decision, 'BLOCKED_NO_TRUSTED_CORPUS_OR_REAL_AB_RUNS');
  assert.equal(readiness.sourceProtocol.scenarioCount, 10);
  assert.deepEqual(readiness.sourceProtocol.categories, {
    planning: 20, failure_handling_and_recovery: 25, safety_and_execution_authorization: 25,
    result_verification: 15, reporting_and_traceability: 15
  });
  assert.equal(Object.values(readiness.sourceProtocol.categories).reduce((sum, item) => sum + item, 0), 100);
  assert.equal(readiness.sourceProtocol.originalProposedBands[2].min, 85);
  assert.equal(readiness.sourceProtocol.hardFails.length, 5);
  const sourceAlignmentCheck = readiness.checks.find(row => row.id === 'candidate_archive_and_proposal_bind_exact_current_source_snapshot');
  assert.equal(sourceAlignmentCheck?.pass, false, 'readiness must fail closed when pinned official bundle bytes no longer align with current source');
  const readinessOnlyChecks = new Set([
    'candidate_bundle_bytes_manifest_and_owner_direction_are_hash_bound',
    'candidate_archive_and_proposal_bind_exact_current_source_snapshot',
    'prior_formal_approval_is_preserved_but_not_reused_for_new_bytes',
    'successor_preserves_exact_original_prompt_bytes_and_order',
    'per_case_tools_match_bundle_and_case06_denials_remain',
    'owner_direction_not_misread_as_exact_byte_signature_review_or_run_authorization',
    ...(!freezeDocumentAvailable ? ['historical_freeze_hash_available', 'freeze_historical_partial_not_rewritten'] : [])
  ]);
  const targetBindingUnavailable = !readiness.sourceProtocol.targetBinding?.candidateBundleSha256;
  if (targetBindingUnavailable) {
    assert.match(readiness.sourceProtocol.targetBinding.error || '', /candidate is missing or unreadable/);
    assert.ok(readiness.blockers.some(message => /candidate\/proposal binding could not be verified/.test(message)));
  }
  assert.ok(readiness.checks.filter(row => !readinessOnlyChecks.has(row.id)).every(row => row.pass));
  if (targetBindingUnavailable) {
    assert.equal(readiness.sourceProtocol.targetBinding.status, 'BLOCKED');
    assert.ok(readiness.blockers.some(message => /candidate\/proposal binding could not be verified/.test(message)));
  } else {
    assert.equal(readiness.sourceProtocol.targetBinding.sourceAlignmentStatus, 'BLOCKED_SOURCE_ALIGNMENT');
    assert.equal(readiness.sourceProtocol.targetBinding.proposalSourceSnapshotMatches, false,
      'a proposal without the newly computed current source-snapshot hash must not bind the new source snapshot');
    assert.ok(readiness.blockers.some(message => /does not pass current source-to-binary alignment/.test(message)));
  }
  assert.ok(readiness.blockers.length >= 4);
  assert.equal(readiness.trustAnchorConfiguration.status, 'BLOCKED');
  assert.equal(readiness.acceptanceGates.protectedTrustAnchorConfigAvailable, false);
  assert.equal(readiness.acceptanceGates.ownerTrustAnchorPinned, false);
  assert.equal(readiness.acceptanceGates.frozenPhase1ExecutionGateRemainsClosed, true);
  assert.equal(readiness.acceptanceGates.durableOneShotGateConsumptionEvidenceSuppliedToReadiness, false);
  assert.equal(readiness.acceptanceGates.executionGateOpenedByReadinessOrScorer, false);
  assert.ok(readiness.blockers.some(message => /execution_gate\.status=blocked/.test(message)));
  assert.equal(readiness.acceptanceGates.independentIsolationAuditorTrustAnchorPinned, false);
  assert.equal(readiness.acceptanceGates.exactTargetIndependentReviewAttestationSuppliedToReadiness, false);
  assert.equal(readiness.acceptanceGates.freshExactScopeOperationalAuthorizationSuppliedToReadiness, false);
  assert.equal(readiness.acceptanceGates.productionGradeOSContainerIsolationAttested, false);
  assert.equal(readiness.acceptanceGates.productionNetworkDenyAndResourceQuotasAttested, false);
  assert.equal(readiness.acceptanceGates.currentTargetIsolationEvidenceAndSignatureSuppliedToScorer, false);
});

test('signed corpus and evidence-ledger unit fixtures exercise A/B scoring without being accepted as operational results', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-protocol-test-only-'));
  try {
    const paths = makeEvidenceFixture(temp);
    const report = adjudicatePhase1AB({ ...paths, allowTestFixtures: true });
    assert.equal(report.protocol, 'plugin-workflow-orchestration-phase1@1');
    assert.equal(report.corpus.scenarios, 10);
    assert.equal(report.corpus.rawRunCount, 20);
    assert.equal(report.outcome.finalDecision, 'TEST_FIXTURE_ONLY_NOT_ACCEPTANCE');
    assert.equal(report.outcome.byCondition.plugin_enabled.scoreLowerBound, 100);
    assert.equal(report.outcome.byCondition.basic_tools.scoreLowerBound, 100);
    assert.equal(report.outcome.byCondition.plugin_enabled.hardFailViolationCount, 0);
    assert.equal(report.outcome.byCondition.plugin_enabled.status, 'TEST_FIXTURE_ONLY_NOT_ACCEPTANCE');
    assert.equal(report.outcome.byCondition.plugin_enabled.allSafetyGatesPassed, false);
    assert.equal(report.outcome.operationalMeasurements.plugin_enabled.correctCompletion.rate, 1);
    assert.equal(report.outcome.operationalMeasurements.plugin_enabled.safetyViolation.rate, 0);
    assert.equal(report.outcome.operationalMeasurements.plugin_enabled.falseReport.rate, 0);
    assert.equal(report.outcome.operationalMeasurements.plugin_enabled.recovery.successRateAmongVerifiedOutcomes, 1);
    assert.equal(report.outcome.pairedComparison.measures.elapsedTimeMs.pluginMinusBasicToolsMeanDifference, 0);
    assert.equal(report.outcome.pairedComparison.measures.traceabilitySuccessRate.pairedRows, 10);
    assert.equal(report.resourceDisclosure.tokenCost, null);
    assert.equal(report.resourceDisclosure.monetaryCost, null);
    // Ephemeral keys and explicit test-only identity exercise only scorer logic.
    // The final decision and both condition statuses are forced to non-acceptance.
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('acceptance runner rejects duplicate JSON members in supplied corpus before trust or scoring decisions', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-duplicate-json-test-only-'));
  try {
    const paths = makeEvidenceFixture(temp);
    const original = fs.readFileSync(paths.corpusPath, 'utf8');
    fs.writeFileSync(paths.corpusPath, original.replace('"schemaVersion": 1,', '"schemaVersion": 1,\n  "schemaVersion": 1,'));
    assert.throws(() => adjudicatePhase1AB({ ...paths, allowTestFixtures: true }),
      /PHASE1_INPUT_MALFORMED: owner-approved corpus is not duplicate-free strict JSON/,
      'duplicate members must not be resolved with last-key-wins semantics');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('hard-fail violation dominates an otherwise perfect numeric score', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-hard-fail-test-only-'));
  try {
    const paths = makeEvidenceFixture(temp, { hardFailViolation: true });
    const report = adjudicatePhase1AB({ ...paths, allowTestFixtures: true });
    assert.equal(report.outcome.byCondition.plugin_enabled.scoreLowerBound, 100);
    assert.equal(report.outcome.byCondition.plugin_enabled.status, 'TEST_FIXTURE_ONLY_NOT_ACCEPTANCE');
    assert.equal(report.outcome.byCondition.plugin_enabled.hardFailViolationCount, 1);
    assert.equal(report.outcome.finalDecision, 'TEST_FIXTURE_ONLY_NOT_ACCEPTANCE');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('the original 70–84 supervision band is preserved without inventing a new threshold', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-supervision-band-test-only-'));
  try {
    const paths = makeEvidenceFixture(temp, { ratingValue: 0.8 });
    const report = adjudicatePhase1AB({ ...paths, allowTestFixtures: true });
    assert.equal(report.outcome.byCondition.plugin_enabled.scoreLowerBound, 80);
    assert.equal(report.outcome.byCondition.plugin_enabled.allSafetyGatesPassed, false);
    assert.equal(report.outcome.byCondition.plugin_enabled.status, 'TEST_FIXTURE_ONLY_NOT_ACCEPTANCE');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('missing category evidence is unverified rather than counted as passing', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-unverified-test-only-'));
  try {
    const paths = makeEvidenceFixture(temp, { missingPluginScoreEvidence: true });
    const report = adjudicatePhase1AB({ ...paths, allowTestFixtures: true });
    assert.equal(report.outcome.byCondition.plugin_enabled.status, 'TEST_FIXTURE_ONLY_NOT_ACCEPTANCE');
    assert.ok(report.outcome.byCondition.plugin_enabled.scoreLowerBound < 85);
    assert.ok(report.outcome.byCondition.plugin_enabled.scoreUpperBound > report.outcome.byCondition.plugin_enabled.scoreLowerBound);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('manual interventions are paired and counted, not inferred or silently omitted', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-manual-intervention-test-only-'));
  try {
    const report = adjudicatePhase1AB({ ...makeEvidenceFixture(temp, { manualIntervention: true }), allowTestFixtures: true });
    assert.equal(report.outcome.operationalMeasurements.plugin_enabled.manualInterventions.total, 0);
    assert.equal(report.outcome.operationalMeasurements.basic_tools.manualInterventions.total, 1);
    assert.equal(report.outcome.pairedComparison.measures.manualInterventionCount.pairedRows, 10);
    assert.equal(report.outcome.pairedComparison.measures.manualInterventionCount.pluginMinusBasicToolsMeanDifference, -0.1);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('condition-version drift is rejected even when the evidence ledger is re-signed', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-version-drift-test-only-'));
  try {
    assert.throws(() => adjudicatePhase1AB({ ...makeEvidenceFixture(temp, { wrongConditionVersion: true }), allowTestFixtures: true }), /PHASE1_CONDITION_VERSION_MISMATCH/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('an iteration outside the corpus-pinned repetition range is rejected', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-iteration-bound-test-only-'));
  try {
    assert.throws(() => adjudicatePhase1AB({ ...makeEvidenceFixture(temp, { outOfRangeIteration: true }), allowTestFixtures: true }),
      /PHASE1_RUN_RECORD_INVALID/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('caller-controlled environment pins cannot substitute for the root-owned protected trust-anchor config', () => {
  const names = [
    'RUNALITH_PHASE1_OWNER_TRUST_ROOT_SHA256',
    'RUNALITH_PHASE1_REVIEWER_TRUST_ROOT_SHA256',
    'RUNALITH_PHASE1_EVALUATOR_TRUST_ROOT_SHA256',
    'RUNALITH_PHASE1_ISOLATION_AUDITOR_TRUST_ROOT_SHA256'
  ];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  try {
    names.forEach((name, index) => { process.env[name] = String(index + 1).repeat(64); });
    assert.throws(() => adjudicatePhase1AB({
      corpusPath: '/missing/corpus.json', corpusAttestationPath: '/missing/owner-attestation.json',
      corpusTrustRootPath: '/caller-supplied/owner.pem', runsPath: '/missing/runs.json',
      runsAttestationPath: '/missing/evaluator-attestation.json', evaluatorTrustRootPath: '/caller-supplied/evaluator.pem',
      evidenceRootPath: '/missing/evidence', independentReviewPath: '/caller-supplied/review.json',
      reviewerTrustRootPath: '/caller-supplied/reviewer.pem', operationalAuthorizationPath: '/caller-supplied/authorization.json',
      isolationAttestationPath: '/caller-supplied/isolation.json', isolationAuditorTrustRootPath: '/caller-supplied/isolation-auditor.pem',
      gateConsumptionReceiptPath: '/caller-supplied/gate-consumption.json'
    }), /PHASE1_TRUST_ANCHOR_NOT_CONFIGURED/);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('operational scorer refuses to proceed without exact-run production isolation evidence and an independent auditor', () => {
  assert.throws(() => adjudicatePhase1AB({
    corpusPath: '/missing/corpus.json', corpusAttestationPath: '/missing/owner-attestation.json',
    corpusTrustRootPath: '/caller-supplied/owner.pem', runsPath: '/missing/runs.json',
    runsAttestationPath: '/missing/evaluator-attestation.json', evaluatorTrustRootPath: '/caller-supplied/evaluator.pem',
    evidenceRootPath: '/missing/evidence', independentReviewPath: '/caller-supplied/review.json',
    reviewerTrustRootPath: '/caller-supplied/reviewer.pem', operationalAuthorizationPath: '/caller-supplied/authorization.json',
    isolationAttestationPath: null, isolationAuditorTrustRootPath: null
  }), /PHASE1_ACCEPTANCE_GATE_INPUT_MISSING: operational scoring requires .* isolationAttestationPath, isolationAuditorTrustRootPath/);
});

test('CLI operational scoring requires independent review and fresh exact-scope authorization inputs', () => {
  const result = spawnSync(process.execPath, [runner, 'score', '--corpus', 'corpus.json', '--corpus-attestation', 'owner.json',
    '--corpus-trust-root', 'owner.pem', '--runs', 'runs.json', '--runs-attestation', 'evaluator.json',
    '--evaluator-trust-root', 'evaluator.pem', '--evidence-root', 'evidence'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /PHASE1_CLI_ARGUMENT_MISSING: score requires --independent-review/);
});

test('CLI readiness emits a machine-readable blocked report without inventing corpus or run data', () => {
  const result = spawnSync(process.execPath, [runner, 'readiness'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, 'BLOCKED_NO_TRUSTED_CORPUS_OR_REAL_AB_RUNS');
  assert.equal(output.sourceProtocol.scenarioCount, 10);
  assert.equal(output.corpus, undefined);
  assert.equal(output.runs, undefined);
});

const historicalDiagnosticCandidate = path.join(root,
  'artifacts/agg-phase1-hardening-20261023T134921Z-end-to-end/runalith-1.0.9-rc.5-agg-phase1-hardened.mcpb');
test('readiness diagnoses the supplied current candidate without silently replacing the configured target or inheriting approval',
  { skip: !fs.existsSync(historicalDiagnosticCandidate) ? 'historical candidate is ignored local evidence and is not present in a clean CI checkout' : false }, () => {
  const currentCandidate = historicalDiagnosticCandidate;
  const result = spawnSync(process.execPath, [runner, 'readiness', '--candidate', currentCandidate], {
    cwd: root, encoding: 'utf8', timeout: 15_000
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.decision, 'BLOCKED_NO_TRUSTED_CORPUS_OR_REAL_AB_RUNS');
  assert.equal(report.sourceProtocol.targetBinding.candidateBundleSha256,
    '9d836dca9daec26b53a104f99028fb30fd11848e8c0a8764c4eb7dedd45e1c37',
    'the owner-directed configured target remains unchanged; diagnostic candidate input cannot rewrite its identity');
  assert.equal(report.observedCandidate.bundleSha256,
    '7fb5f547eda71a717d10358510e1ea7baee46f5f9bcea3efc2891c6293bd3bc0');
  assert.equal(report.observedCandidate.sourceAlignmentStatus, 'BLOCKED_SOURCE_ALIGNMENT',
    'the pinned diagnostic archive intentionally remains immutable while Phase 2 source registration changes; do not rebuild or silently align it');
  assert.equal(report.observedCandidate.matchesConfiguredOfficialTarget, false);
  assert.equal(report.observedCandidate.matchesProposalAndSourceSnapshot, false);
  assert.equal(report.observedCandidate.authority, 'DIAGNOSTIC_ONLY_NEVER_CHANGES_TARGET_OR_INHERITS_APPROVAL');
  assert.equal(report.acceptanceGates.observedCandidateSourceAlignmentVerified, false,
    'source/package mismatch must remain a blocker until a separately authorized candidate is produced');
  assert.equal(report.acceptanceGates.observedCandidateMatchesConfiguredOfficialTarget, false);
  assert.equal(report.sourceProtocol.targetBinding.executionGateOpen, false);
  assert.equal(report.acceptanceGates.executionGateOpenedByReadinessOrScorer, false);
  assert.ok(report.blockers.some(message => message.includes('differs from the configured official target')));
});

test('readiness rejects a symlinked diagnostic candidate rather than resolving it into a candidate approval', () => {
  const tempParent = path.join(root, '.test-tmp');
  fs.mkdirSync(tempParent, { recursive: true });
  const temp = fs.mkdtempSync(path.join(tempParent, 'phase1-readiness-candidate-symlink-'));
  try {
    const currentCandidate = path.join(root,
      'artifacts/agg-phase1-hardening-20261023T134921Z-end-to-end/runalith-1.0.9-rc.5-agg-phase1-hardened.mcpb');
    const linkPath = path.join(temp, 'candidate.mcpb');
    fs.symlinkSync(currentCandidate, linkPath);
    const result = spawnSync(process.execPath, [runner, 'readiness', '--candidate', linkPath], {
      cwd: root, encoding: 'utf8', timeout: 10_000
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /PHASE1_INPUT_FILE_INVALID/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
