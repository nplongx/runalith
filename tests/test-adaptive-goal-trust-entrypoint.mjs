import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { adaptiveGoalPublicKeyFingerprint } from '../src/runtime/adaptive-goal-trust-configuration.js';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const manifestPath = fs.existsSync(path.join(packageRoot, 'plugin/manifest.json'))
  ? path.join(packageRoot, 'plugin/manifest.json')
  : path.join(packageRoot, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const entryPoint = path.join(packageRoot, manifest.server.entry_point);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-trust-entrypoint-'));
const dataDir = path.join(temp, 'data');
const workspace = path.join(temp, 'workspace');
const execTmp = path.join(temp, 'execution-tmp');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
fs.mkdirSync(execTmp, { recursive: true, mode: 0o700 });

function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function publicKeyPem(pair) { return pair.publicKey.export({ type: 'spki', format: 'pem' }); }
function trustConfig(domain, providerId, publicPem, scope, keyId) {
  const now = Date.now();
  return JSON.stringify({
    schema_version: 1, domain, provider_id: providerId, config_version: 1,
    updated_at: new Date(now - 1000).toISOString(), updated_by: 'disposable-entrypoint-security-admin',
    change_reference: `ISOLATED-TEST-${domain}-1`,
    keys: [{ key_id: keyId, public_key_pem: publicPem, scopes: [scope],
      not_before: new Date(now - 60_000).toISOString(), not_after: null, revoked_at: null }]
  });
}
function createAttestation(request, { keyPair, providerId, pem, nonce = randomUUID(), scope = 'agg.goal_idea_graph.verify' }) {
  const unsigned = {
    schema_version: 1,
    kind: 'adaptive_goal_verified_knowledge_graph_attestation',
    provider_id: providerId,
    trust_root_sha256: adaptiveGoalPublicKeyFingerprint(pem),
    nonce,
    issued_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    scope,
    goal_id: request.snapshot.goal_id,
    snapshot_hash: request.snapshot.snapshot_hash,
    node_ids: request.snapshot.node_ids,
    edge_ids: request.snapshot.edge_ids,
    membership_ids: request.snapshot.membership_ids,
    evidence_manifest_hash: request.evidenceManifestHash,
    claim_status: 'verified',
    independence_status: 'verified',
    signature_algorithm: 'Ed25519'
  };
  return { ...unsigned, signature: sign(null, Buffer.from(canonical(unsigned)), keyPair.privateKey).toString('base64') };
}

const sourceVerifierKey = generateKeyPairSync('ed25519');
const reviewerKey = generateKeyPairSync('ed25519');
const wrongSignerKey = generateKeyPairSync('ed25519');
const sourceVerifierPem = publicKeyPem(sourceVerifierKey);
const reviewerPem = publicKeyPem(reviewerKey);
const sourceEvidencePath = path.join(packageRoot, 'src/runtime/adaptive-goal-knowledge-store.js');
const sourceEvidenceRef = `file:src/runtime/adaptive-goal-knowledge-store.js#sha256=${sha(fs.readFileSync(sourceEvidencePath))}`;
const providerId = 'entrypoint-test-independent-source-verifier';
const reviewerProviderId = 'entrypoint-test-independent-action-reviewer';
const env = {
  ...process.env,
  RUNALITH_DATA_DIR: dataDir,
  RUNALITH_WORKFLOW_DB: path.join(dataDir, 'workflow.db'),
  RUNALITH_WORKSPACE: workspace,
  RUNALITH_EXECUTION_TMP_DIR: execTmp,
  HOME: temp,
  TMPDIR: execTmp,
  OPENAI_API_KEY: '',
  AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON: trustConfig('goal_idea_verifier', providerId, sourceVerifierPem, 'agg.goal_idea_graph.verify', 'source-verifier-test-key'),
  AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON: trustConfig('action_intent_reviewer', reviewerProviderId, reviewerPem, 'agg.action_intent.review', 'action-reviewer-test-key'),
  AGG_PHASE2_SHADOW_TOOL_ENABLED: '0',
  AGG_PHASE3_MCTS_TOOL_ENABLED: '0',
  AGG_PHASE4_KNOWLEDGE_CAPTURE_TOOL_ENABLED: '0'
};
for (const key of [
  'AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID', 'AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM',
  'AGG_REVIEW_IDENTITY_PROVIDER_ID', 'AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM',
  'CHAT_ON_STEROIDS_DATA_DIR', 'CHAT_ON_STEROIDS_WORKFLOW_DB', 'WORKFLOW_DATA_DIR', 'WORKFLOW_DB',
  'CHAT_ON_STEROIDS_WORKSPACE', 'WORKFLOW_WORKSPACE', 'CHAT_ON_STEROIDS_EXECUTION_TMP_DIR', 'EXECUTION_TMP_DIR'
]) delete env[key];

let child;
let outputLines;
const pending = new Map();
const stderrChunks = [];
let nextId = 1;
let exited = null;

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP request ${method}#${id} timed out; stderr=${Buffer.concat(stderrChunks).toString('utf8').slice(-3000)}`));
    }, 10_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
      if (!error) return;
      clearTimeout(timer); pending.delete(id); reject(error);
    });
  });
}
function parseToolResponse(response) {
  const result = response?.result;
  const contentText = Array.isArray(result?.content) ? result.content.filter(item => item.type === 'text').map(item => item.text).join('\n') : '';
  let data = result?.structuredContent;
  if (data === undefined && contentText) {
    try { data = JSON.parse(contentText); } catch { data = null; }
  }
  return { failed: Boolean(response?.error || result?.isError), errorText: [response?.error?.message, contentText].filter(Boolean).join('\n'), data, raw: response };
}
async function call(tool, args = {}) {
  const response = await request('tools/call', { name: tool, arguments: args });
  return parseToolResponse(response);
}
async function expectDenied(tool, args, pattern) {
  const result = await call(tool, args);
  assert.equal(result.failed, true, `${tool} should fail closed; actual=${JSON.stringify(result.raw)}`);
  if (pattern) assert.match(result.errorText, pattern);
  return result;
}

try {
  child = spawn(process.execPath, [entryPoint], { cwd: packageRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
  outputLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  outputLines.on('line', line => {
    let message;
    try { message = JSON.parse(line); }
    catch { stderrChunks.push(Buffer.from(`NON_JSON_STDOUT ${line}\n`)); return; }
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message);
  });
  child.stderr.on('data', chunk => stderrChunks.push(Buffer.from(chunk)));
  child.on('exit', (code, signal) => { exited = { code, signal }; });

  const initialized = await request('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agg-trust-entrypoint-test', version: '1.0.0' }
  });
  assert.equal(initialized.error, undefined, JSON.stringify(initialized));
  assert.equal(initialized.result?.serverInfo?.version, manifest.version);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const toolList = await request('tools/list', {});
  assert.ok(toolList.result?.tools?.some(tool => tool.name === 'adaptive_goal_trust_configuration_status'));

  const trustStatus = await call('adaptive_goal_trust_configuration_status');
  assert.equal(trustStatus.failed, false, trustStatus.errorText);
  assert.equal(trustStatus.data.status, 'configured', JSON.stringify(trustStatus.data));
  assert.equal(trustStatus.data.domains.goal_idea_verifier.configVersion, 1);
  assert.equal(trustStatus.data.domains.action_intent_reviewer.configVersion, 1);
  assert.equal(trustStatus.data.separation.providerIdsDistinct, true);
  assert.equal(trustStatus.data.separation.publicRootsDisjoint, true);
  assert.doesNotMatch(JSON.stringify(trustStatus.data), /BEGIN (?:PRIVATE|RSA PRIVATE|OPENSSH PRIVATE) KEY/);

  const saved = await call('adaptive_goal_knowledge_node_save', {
    goal_id: 'entrypoint-test-goal', stable_key: 'goal-root', node_type: 'goal',
    content: { statement: 'isolated signed-snapshot fixture' },
    provenance: { source: 'isolated-entrypoint-test', actor: 'fixture-producer', reference: 'test-only' },
    evidence_refs: [sourceEvidenceRef]
  });
  assert.equal(saved.failed, false, saved.errorText);
  assert.equal(saved.data.verified, false, 'knowledge creation API never self-verifies caller-authored content');
  assert.equal(saved.data.usableForPlanning, false);

  const request1 = await call('adaptive_goal_knowledge_snapshot_get', { goal_id: 'entrypoint-test-goal' });
  assert.equal(request1.failed, false, request1.errorText);
  assert.equal(request1.data.currentVerification.verified, false);
  const requestPayload1 = request1.data;
  const badSignature = createAttestation(requestPayload1, { keyPair: wrongSignerKey, providerId, pem: sourceVerifierPem });
  await expectDenied('adaptive_goal_knowledge_snapshot_attest', { attestation: badSignature }, /KNOWLEDGE_ATTESTATION_SIGNATURE_INVALID/);
  const badScope = createAttestation(requestPayload1, { keyPair: sourceVerifierKey, providerId, pem: sourceVerifierPem, scope: 'agg.execution.dispatch' });
  await expectDenied('adaptive_goal_knowledge_snapshot_attest', { attestation: badScope }, /scope must be one of the declared enum values/);

  const revised = await call('adaptive_goal_knowledge_node_save', {
    goal_id: 'entrypoint-test-goal', stable_key: 'goal-root', node_type: 'goal',
    content: { statement: 'revised after the first snapshot request' },
    provenance: { source: 'isolated-entrypoint-test', actor: 'fixture-producer', reference: 'test-only-revision-2' },
    expected_revision: 1,
    evidence_refs: [sourceEvidenceRef]
  });
  assert.equal(revised.failed, false, revised.errorText);
  const staleProof = createAttestation(requestPayload1, { keyPair: sourceVerifierKey, providerId, pem: sourceVerifierPem });
  await expectDenied('adaptive_goal_knowledge_snapshot_attest', { attestation: staleProof }, /KNOWLEDGE_ATTESTATION_STALE/);

  const request2 = await call('adaptive_goal_knowledge_snapshot_get', { goal_id: 'entrypoint-test-goal' });
  assert.equal(request2.failed, false, request2.errorText);
  const freshAttestation = createAttestation(request2.data, { keyPair: sourceVerifierKey, providerId, pem: sourceVerifierPem });
  const attested = await call('adaptive_goal_knowledge_snapshot_attest', { attestation: freshAttestation });
  assert.equal(attested.failed, false, attested.errorText);
  assert.equal(attested.data.verified, true, JSON.stringify(attested.data));
  assert.equal(attested.data.trustKeyId, 'source-verifier-test-key');
  assert.equal(attested.data.trustConfigVersion, 1);
  assert.equal(attested.data.configurationChangeReference, 'ISOLATED-TEST-goal_idea_verifier-1');

  const verifiedReadback = await call('adaptive_goal_knowledge_snapshot_get', { goal_id: 'entrypoint-test-goal' });
  assert.equal(verifiedReadback.failed, false, verifiedReadback.errorText);
  assert.equal(verifiedReadback.data.currentVerification.verified, true, JSON.stringify(verifiedReadback.data.currentVerification));

  // Negative-only database tamper simulation: all successful state above was
  // created through the runtime's public tools, not seeded by SQL. Break the
  // append-only guard in this disposable database and alter prior provenance
  // bytes to prove the previously trusted snapshot no longer authorizes use.
  const nodeId = saved.data.id;
  const workflowDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
  try {
    const triggers = workflowDb.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='adaptive_goal_knowledge_revisions'`).all();
    for (const row of triggers) workflowDb.exec(`DROP TRIGGER IF EXISTS "${String(row.name).replaceAll('"', '""')}"`);
    const revision = workflowDb.prepare('SELECT provenance_json FROM adaptive_goal_knowledge_revisions WHERE node_id=? AND revision=1').get(nodeId);
    assert.ok(revision, 'expected durable first revision from the public MCP tool');
    const tampered = JSON.stringify({ ...JSON.parse(revision.provenance_json), actor: 'unauthorized-tamper' });
    workflowDb.prepare('UPDATE adaptive_goal_knowledge_revisions SET provenance_json=? WHERE node_id=? AND revision=1').run(tampered, nodeId);
  } finally { workflowDb.close(); }
  const tamperedReadback = await call('adaptive_goal_knowledge_snapshot_get', { goal_id: 'entrypoint-test-goal' });
  assert.equal(tamperedReadback.failed, false, tamperedReadback.errorText);
  assert.equal(tamperedReadback.data.currentVerification.verified, false,
    'historical provenance mutation must invalidate the previously signed snapshot even if graph rows remain inspectable for diagnosis');
  assert.equal(tamperedReadback.data.currentVerification.status, 'stale');
  const tamperedSnapshotHash = tamperedReadback.data.snapshot.snapshot_hash;
  await expectDenied('adaptive_goal_knowledge_graph_search', {
    goal_id: 'entrypoint-test-goal', start_node_id: nodeId, goal_node_id: `agk-${'0'.repeat(40)}`,
    expected_snapshot_hash: tamperedSnapshotHash
  }, /KNOWLEDGE_GRAPH_NOT_VERIFIED/);

  const revisedAgain = await call('adaptive_goal_knowledge_node_save', {
    goal_id: 'entrypoint-test-goal', stable_key: 'goal-root', node_type: 'goal',
    content: { statement: 'revision drift after attestation' },
    provenance: { source: 'isolated-entrypoint-test', actor: 'fixture-producer', reference: 'test-only-revision-3' },
    expected_revision: 2,
    evidence_refs: [sourceEvidenceRef]
  });
  assert.equal(revisedAgain.failed, false, revisedAgain.errorText);
  const request3 = await call('adaptive_goal_knowledge_snapshot_get', { goal_id: 'entrypoint-test-goal' });
  assert.equal(request3.failed, false, request3.errorText);
  assert.equal(request3.data.currentVerification.verified, false);
  const replayedNonce = createAttestation(request3.data, {
    keyPair: sourceVerifierKey, providerId, pem: sourceVerifierPem, nonce: freshAttestation.nonce
  });
  await expectDenied('adaptive_goal_knowledge_snapshot_attest', { attestation: replayedNonce }, /KNOWLEDGE_ATTESTATION_NONCE_REPLAY/);

  const ledger = new DatabaseSync(path.join(dataDir, 'agg-trust-configuration.db'), { readOnly: true });
  try {
    const rows = ledger.prepare('SELECT domain,config_version,configuration_fingerprint,provider_id,config_change_reference FROM adaptive_goal_trust_configuration_history ORDER BY domain').all();
    assert.deepEqual(rows.map(row => row.domain).sort(), ['action_intent_reviewer', 'goal_idea_verifier']);
    assert.ok(rows.every(row => row.config_version === 1 && /^[a-f0-9]{64}$/.test(row.configuration_fingerprint)));
    assert.equal(rows.some(row => JSON.stringify(row).includes('PUBLIC KEY')), false);
  } finally { ledger.close(); }

  console.log(`AGG_TRUST_ENTRYPOINT_ACCEPTANCE=PASS tools=${toolList.result.tools.length} jsonConfigLoaded=true sourceAttested=true badSignature=denied badScope=denied staleSnapshot=denied nonceReplay=denied provenanceTamperInvalidatesSnapshot=true privateDb=true`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.stdin.end();
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 3000);
      child.once('exit', (code, signal) => { clearTimeout(timer); exited = { code, signal }; resolve(); });
    });
  }
  outputLines?.close();
  fs.rmSync(temp, { recursive: true, force: true });
  if (exited && exited.code !== 0 && exited.signal !== 'SIGTERM') {
    console.error(`isolated entrypoint exited ${JSON.stringify(exited)}: ${Buffer.concat(stderrChunks).toString('utf8').slice(-3000)}`);
  }
}
