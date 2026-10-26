import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test, { after, before } from 'node:test';
import {
  compareBundleToDirectory,
  createInstalledRollbackSnapshot,
  evaluateRolloutGate,
  inspectBundle,
  inspectHost,
  inspectRuntimeTrustConfiguration,
  listRuntimeProcesses,
  simulateRolloutInRoot,
  smokeCandidate,
  validateExternalAntiRollbackAnchorReport,
  workflowDbSummary
} from '../scripts/runalith-rollout.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
let testRoot;
let candidatePath;
let workflowDbPath;
const temporaryRollbacks = [];

function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function fakeRuntimeSource(version) {
  return `import readline from 'node:readline';
const tools = [{name:'orchestrator_health',description:'Isolated test runtime health probe',inputSchema:{type:'object',properties:{},additionalProperties:false}}];
const rl = readline.createInterface({input:process.stdin,crlfDelay:Infinity});
for await (const line of rl) {
  let msg; try { msg = JSON.parse(line); } catch { continue; }
  if (msg.id === undefined || msg.method?.startsWith('notifications/')) continue;
  let result;
  if (msg.method === 'initialize') result = {protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'runalith-agent-orchestrator',version:${JSON.stringify(version)}}};
  else if (msg.method === 'tools/list') result = {tools};
  else if (msg.method === 'tools/call' && msg.params?.name === 'orchestrator_health') {
    const health = {status:'ok',mode:'local-only-mcp',database:process.env.RUNALITH_WORKFLOW_DB};
    result = {structuredContent:health,content:[{type:'text',text:JSON.stringify(health)}]};
  } else result = {tools:[]};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n');
}`;
}

function zipDirectory(source, destination, roots) {
  const result = spawnSync('zip', ['-X', '-q', '-r', destination, ...roots], { cwd: source, encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout || 'zip failed');
}

function createBundle({ version = '1.0.9-rc.8', entryPoint = 'server/index-v1.0.9-rc.8.js', useRealHistorical = true } = {}) {
  const source = path.join(testRoot, `bundle-source-${crypto.randomUUID()}`);
  fs.mkdirSync(path.join(source, 'server'), { recursive: true, mode: 0o700 });
  const manifest = {
    name: 'runalith-agent-orchestrator', version,
    server: { type: 'node', entry_point: entryPoint, mcp_config: { command: 'node', args: ['${__dirname}/' + entryPoint] } },
    tools: [{ name: 'orchestrator_health', description: 'Isolated test runtime health probe' }]
  };
  fs.writeFileSync(path.join(source, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(source, 'package.json'), `${JSON.stringify({ name: 'runalith-agent-orchestrator', version, type: 'module', main: entryPoint }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.copyFileSync(path.join(ROOT, 'server/index.js'), path.join(source, 'server/index.js'));
  if (useRealHistorical) fs.writeFileSync(path.join(source, entryPoint), fakeRuntimeSource(version), { flag: 'wx', mode: 0o600 });
  else fs.writeFileSync(path.join(source, entryPoint), 'export {};\n', { flag: 'wx', mode: 0o600 });
  const out = path.join(testRoot, `candidate-${crypto.randomUUID()}.mcpb`);
  zipDirectory(source, out, ['manifest.json', 'package.json', 'server']);
  return out;
}

function makePrivateRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runalith-rollout-test-'));
}

function writeTestDb(dbPath, { executing = true } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE jobs(job_id TEXT PRIMARY KEY,state TEXT NOT NULL,status TEXT NOT NULL);
    CREATE TABLE events(event_id TEXT PRIMARY KEY);
    CREATE TABLE tasks(task_id TEXT PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE artifacts(artifact_id TEXT PRIMARY KEY);
    CREATE TABLE results(result_id TEXT PRIMARY KEY);
    CREATE TABLE task_leases(lease_id TEXT PRIMARY KEY,state TEXT NOT NULL,expires_at TEXT);`);
  db.prepare('INSERT INTO jobs(job_id,state,status) VALUES(?,?,?)').run('j-active', executing ? 'EXECUTING' : 'COMPLETED', executing ? 'active' : 'completed');
  db.prepare('INSERT INTO jobs(job_id,state,status) VALUES(?,?,?)').run('j-idle', 'IDLE', 'active');
  db.prepare('INSERT INTO events(event_id) VALUES(?)').run('e1');
  db.prepare('INSERT INTO events(event_id) VALUES(?)').run('e2');
  db.prepare('INSERT INTO tasks(task_id,status) VALUES(?,?)').run('t-running', executing ? 'running' : 'completed');
  db.prepare('INSERT INTO tasks(task_id,status) VALUES(?,?)').run('t-pending', 'pending');
  db.prepare('INSERT INTO artifacts(artifact_id) VALUES(?)').run('a1');
  db.prepare('INSERT INTO results(result_id) VALUES(?)').run('r1');
  db.prepare('INSERT INTO results(result_id) VALUES(?)').run('r2');
  db.prepare('INSERT INTO task_leases(lease_id,state,expires_at) VALUES(?,?,?)')
    .run('lease-1', executing ? 'active' : 'released', '2099-01-01T00:00:00.000Z');
  db.close();
}

function makeFakeHost({ appRoot, procRoot, workflowDb, version = '1.0.9-rc.5' }) {
  const pluginId = 'plugin-test-83ea5bbc';
  const generationRoot = path.join(appRoot, 'plugins', pluginId, 'g-test');
  fs.mkdirSync(path.join(generationRoot, 'server'), { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(ROOT, 'server/index.js'), path.join(generationRoot, 'server/index.js'));
  const manifest = { name: 'runalith-agent-orchestrator', version, server: { type: 'node', entry_point: 'server/index.js', mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'] } },
    tools: [{ name: 'orchestrator_health', description: 'Test fixture only', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
  fs.writeFileSync(path.join(generationRoot, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(generationRoot, 'package.json'), JSON.stringify({ name: 'runalith-agent-orchestrator', version, type: 'module', main: 'server/index.js' }), { flag: 'wx', mode: 0o600 });
  fs.mkdirSync(path.join(appRoot, 'state'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(appRoot, 'state', 'plugins.json'), JSON.stringify([{ id: pluginId, name: 'Runalith', version,
    enabled: true, status: 'ready', source: { kind: 'mcpb', path: 'runalith-current.mcpb', args: [] } }]), { flag: 'wx', mode: 0o600 });
  fs.mkdirSync(path.join(procRoot, '4242'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(procRoot, '4242', 'cmdline'), `node\0${path.join(generationRoot, 'server/index.js')}\0`, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(procRoot, '4242', 'status'), 'Name:\tnode\nPPid:\t100\n', { flag: 'wx', mode: 0o600 });
  fs.mkdirSync(path.join(procRoot, '100'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(procRoot, '100', 'cmdline'), '/opt/Chat On Steroids/chat-on-steroids\0', { flag: 'wx', mode: 0o600 });
  const sourcePair = crypto.generateKeyPairSync('ed25519');
  const reviewerPair = crypto.generateKeyPairSync('ed25519');
  const now = Date.now();
  const pem = pair => pair.publicKey.export({ type: 'spki', format: 'pem' });
  const trustConfig = (domain, providerId, publicKeyPem, scope, keyId) => JSON.stringify({
    schema_version: 1, domain, provider_id: providerId, config_version: 1,
    updated_at: new Date(now - 1000).toISOString(), updated_by: 'rollout-test-admin',
    change_reference: `TEST-${domain}-1`,
    keys: [{ key_id: keyId, public_key_pem: publicKeyPem, scopes: [scope],
      not_before: new Date(now - 60_000).toISOString(), not_after: null, revoked_at: null }]
  });
  const trustEnvironment = {
    AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON: trustConfig('goal_idea_verifier', 'rollout-test-source-provider',
      pem(sourcePair), 'agg.goal_idea_graph.verify', 'rollout-source-key'),
    AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON: trustConfig('action_intent_reviewer', 'rollout-test-reviewer-provider',
      pem(reviewerPair), 'agg.action_intent.review', 'rollout-reviewer-key')
  };
  const trustEnvironmentPath = path.join(procRoot, '4242', 'environ');
  fs.writeFileSync(trustEnvironmentPath, Buffer.from(Object.entries(trustEnvironment).map(([key, value]) => `${key}=${value}`).join('\0') + '\0'),
    { flag: 'wx', mode: 0o600 });
  return { pluginId, generationRoot, entryPoint: path.join(generationRoot, 'server/index.js'), trustEnvironmentPath };
}

test('read-only host process discovery recognizes versioned RC.8 entry points and retains the historical entry point', () => {
  const procRoot = path.join(testRoot, `fake-proc-versioned-${crypto.randomUUID()}`);
  const pluginId = 'plugin-versioned-entry-test';
  const generationRoot = path.join(testRoot, 'fake-host-versioned', 'plugins', pluginId, 'g-rc8');
  const entryPoint = path.join(generationRoot, 'server', 'index-v1.0.9-rc.8.js');
  fs.mkdirSync(path.dirname(entryPoint), { recursive: true, mode: 0o700 });
  fs.writeFileSync(entryPoint, 'export {};\n', { flag: 'wx', mode: 0o600 });
  fs.mkdirSync(path.join(procRoot, '4242'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(procRoot, '100'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(procRoot, '4242', 'cmdline'), `node\0${entryPoint}\0`, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(procRoot, '4242', 'status'), 'Name:\tnode\nPPid:\t100\n', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(procRoot, '100', 'cmdline'), '/opt/Chat On Steroids/chat-on-steroids\0', { flag: 'wx', mode: 0o600 });

  const found = listRuntimeProcesses(pluginId, procRoot);
  assert.equal(found.length, 1, 'the versioned runtime process must be discovered');
  assert.equal(found[0].entryPoint, entryPoint);
  assert.equal(found[0].generationRoot, generationRoot);
  assert.equal(found[0].parentLooksLikeHost, true);

  // Keep explicit coverage for the legacy entry point. The production fix
  // must extend discovery for versioned packages without dropping older ones.
  const legacyEntryPoint = path.join(generationRoot, 'server', 'index.js');
  fs.writeFileSync(legacyEntryPoint, 'export {};\n', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(procRoot, '4242', 'cmdline'), `node\0${legacyEntryPoint}\0`, { flag: 'w' });
  const legacyFound = listRuntimeProcesses(pluginId, procRoot);
  assert.equal(legacyFound.length, 1, 'the historical server/index.js runtime must remain discoverable');
  assert.equal(legacyFound[0].entryPoint, legacyEntryPoint);

  fs.writeFileSync(path.join(procRoot, '4242', 'cmdline'), `node\0${path.join(generationRoot, 'server', 'index-other.js')}\0`, { flag: 'w' });
  assert.equal(listRuntimeProcesses(pluginId, procRoot).length, 0,
    'unrecognized entry point names must not be treated as the active runtime');
  fs.rmSync(procRoot, { recursive: true, force: true });
});

before(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runalith-rollout-unit-'));
  fs.chmodSync(testRoot, 0o700);
  candidatePath = createBundle();
  workflowDbPath = path.join(testRoot, 'workflow.db');
  writeTestDb(workflowDbPath);
});

after(() => {
  for (const item of temporaryRollbacks) {
    for (const candidate of [item, `${item}.manifest.json`]) {
      try { fs.unlinkSync(candidate); } catch {}
    }
  }
  if (testRoot) fs.rmSync(testRoot, { recursive: true, force: true });
});

test('candidate package verification and extracted runtime health are bound to exact archive bytes', async () => {
  const before = inspectBundle(candidatePath);
  assert.equal(before.version, '1.0.9-rc.8');
  assert.equal(before.entryPoint, 'server/index-v1.0.9-rc.8.js');
  assert.equal(before.toolCount, 1);
  assert.equal(hash(fs.readFileSync(candidatePath)), before.sha256);
  const smoke = smokeCandidate(candidatePath, 30_000);
  assert.equal(smoke.passed, true, smoke.output);
  assert.equal(inspectBundle(candidatePath, { requireCurrentSource: false }).sha256, before.sha256);
});

test('simulation has idempotent activation and rolls back at each tested failure boundary', () => {
  const successfulRoot = makePrivateRoot();
  const success = simulateRolloutInRoot({ bundlePath: candidatePath, root: successfulRoot, smoke: () => ({ passed: true }) });
  assert.equal(success.status, 'ROLLOUT_SIMULATED');
  assert.equal(success.rollbackPerformed, false);
  assert.equal(success.current.version, '1.0.9-rc.8');
  assert.deepEqual(success.phases, ['preflight', 'staged-and-hash-verified', 'switched-atomically', 'health-check-passed', 'post-switch-readback-passed']);
  const beforeRepeat = fs.readdirSync(path.join(successfulRoot, 'generations')).sort();
  const repeated = simulateRolloutInRoot({ bundlePath: candidatePath, root: successfulRoot, smoke: () => ({ passed: true }) });
  assert.equal(repeated.status, 'ALREADY_ACTIVE');
  assert.equal(repeated.idempotent, true);
  assert.deepEqual(fs.readdirSync(path.join(successfulRoot, 'generations')).sort(), beforeRepeat);

  const beforeSwitchRoot = makePrivateRoot();
  const preSwitchFailure = simulateRolloutInRoot({ bundlePath: candidatePath, root: beforeSwitchRoot, failpoint: 'after-stage', smoke: () => ({ passed: true }) });
  assert.equal(preSwitchFailure.status, 'ROLLOUT_FAILED_ROLLED_BACK');
  assert.equal(preSwitchFailure.rollbackPerformed, false);
  assert.equal(preSwitchFailure.current.version, '1.0.9-rc.5');
  assert.match(preSwitchFailure.failure, /SIMULATED_FAILURE_AFTER_STAGE/);

  for (const failpoint of ['after-switch', 'health-check']) {
    const root = makePrivateRoot();
    const result = simulateRolloutInRoot({ bundlePath: candidatePath, root, failpoint, smoke: () => ({ passed: true }) });
    assert.equal(result.status, 'ROLLOUT_FAILED_ROLLED_BACK');
    assert.equal(result.rollbackPerformed, true);
    assert.equal(result.prior.version, '1.0.9-rc.5');
    assert.equal(result.current.version, '1.0.9-rc.5');
    assert.ok(result.phases.includes('rollback-performed'));
    const active = JSON.parse(fs.readFileSync(path.join(root, 'active-generation.json'), 'utf8'));
    assert.equal(active.version, '1.0.9-rc.5');
    assert.equal(active.packageSha256, 'test-only-baseline');
  }
  const failedSmokeRoot = makePrivateRoot();
  const failedSmoke = simulateRolloutInRoot({ bundlePath: candidatePath, root: failedSmokeRoot, smoke: () => ({ passed: false }) });
  assert.equal(failedSmoke.status, 'ROLLOUT_FAILED_ROLLED_BACK');
  assert.equal(failedSmoke.rollbackPerformed, true);
  assert.equal(failedSmoke.current.version, '1.0.9-rc.5');
  assert.match(failedSmoke.failure, /health smoke did not report passed/);
  for (const root of [successfulRoot, beforeSwitchRoot, failedSmokeRoot]) fs.rmSync(root, { recursive: true, force: true });
});

test('workflow database preflight is read-only and reports jobs, running tasks, leases and integrity', () => {
  const beforeHash = hash(fs.readFileSync(workflowDbPath));
  const summary = workflowDbSummary(workflowDbPath);
  const afterHash = hash(fs.readFileSync(workflowDbPath));
  assert.equal(summary.readable, true, JSON.stringify(summary));
  assert.deepEqual(summary.integrityCheck, ['ok']);
  assert.equal(summary.foreignKeyViolations, 0);
  assert.equal(summary.jobs, 2);
  assert.equal(summary.events, 2);
  assert.equal(summary.tasks, 2);
  assert.equal(summary.artifacts, 1);
  assert.equal(summary.results, 2);
  assert.equal(summary.executingJobs, 1);
  assert.equal(summary.runningTasks, 1);
  assert.equal(summary.activeLeases, 1);
  const malformedLease = new DatabaseSync(workflowDbPath);
  malformedLease.prepare('UPDATE task_leases SET expires_at=? WHERE lease_id=?').run('', 'lease-1');
  malformedLease.close();
  assert.equal(workflowDbSummary(workflowDbPath).activeLeases, 1,
    'malformed expiry must remain a rollout blocker rather than be mistaken for an expired lease');
  const malformedLeaseRestore = new DatabaseSync(workflowDbPath);
  malformedLeaseRestore.prepare('UPDATE task_leases SET expires_at=? WHERE lease_id=?').run('2099-01-01T00:00:00.000Z', 'lease-1');
  malformedLeaseRestore.close();
  assert.equal(afterHash, beforeHash, 'the rollout preflight must not modify any SQLite bytes');
});

test('host identity plus active execution blockers keep live activation fail-closed until drained', () => {
  const appRoot = path.join(testRoot, 'fake-host');
  const procRoot = path.join(testRoot, 'fake-proc');
  fs.mkdirSync(appRoot, { recursive: true, mode: 0o700 });
  const installed = makeFakeHost({ appRoot, procRoot, workflowDb: workflowDbPath });
  assert.equal(fs.existsSync(installed.entryPoint), true);
  const live = inspectHost({ appRoot, procRoot, workflowDb: workflowDbPath });
  assert.equal(live.plugin.id, installed.pluginId);
  assert.equal(live.processes.length, 1);
  assert.equal(live.processes[0].parentLooksLikeHost, true);
  assert.equal(live.processes[0].ppid, 100);
  assert.equal(live.installedGeneration.manifestVersion, '1.0.9-rc.5');
  assert.equal(live.trustConfiguration.available, true, JSON.stringify(live.trustConfiguration));
  assert.equal(live.trustConfiguration.domains.goal_idea_verifier.configurationSource, 'admin_json_environment');
  assert.equal(live.trustConfiguration.separation.publicRootsDisjoint, true);
  const blocked = evaluateRolloutGate({
    candidate: { verified: true, version: '1.0.9-rc.8' },
    rollback: { verified: true, version: '1.0.9-rc.5' }, host: live
  });
  assert.equal(blocked.status, 'BLOCKED');
  assert.ok(blocked.blockers.includes('ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN'));
  assert.ok(blocked.blockers.includes('RUNNING_TASKS_MUST_DRAIN'));
  assert.ok(blocked.blockers.includes('ACTIVE_TASK_LEASES_MUST_DRAIN'));
  assert.ok(blocked.blockers.includes('PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED'));

  const db = new DatabaseSync(workflowDbPath);
  db.prepare("UPDATE jobs SET state='COMPLETED',status='completed' WHERE state='EXECUTING'").run();
  db.prepare("UPDATE tasks SET status='completed' WHERE status='running'").run();
  db.prepare("UPDATE task_leases SET state='released' WHERE state='active'").run();
  db.close();
  const drainedHost = inspectHost({ appRoot, procRoot, workflowDb: workflowDbPath });
  const drainedButUnanchored = evaluateRolloutGate({ candidate: { verified: true, version: '1.0.9-rc.8' },
    rollback: { verified: true, version: '1.0.9-rc.5' }, host: drainedHost });
  assert.equal(drainedButUnanchored.status, 'BLOCKED', 'trust config plus drained workflows is insufficient without an independent ledger anchor');
  assert.ok(drainedButUnanchored.blockers.includes('PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED'));
  // A caller-authored JSON object cannot prove checkpoint signature validity or
  // monotonic continuity, even when every field and self-asserted boolean looks
  // valid. Only a host-owned cryptographic verifier integration may open this gate.
  const testCandidate = { verified: true, version: '1.0.9-rc.8', sha256: 'a'.repeat(64) };
  const testRollback = { verified: true, version: '1.0.9-rc.5', sha256: 'b'.repeat(64) };
  const testOnlyAnchor = { verified: true, status: 'VERIFIED', source: 'host_monotonic_checkpoint_service',
    authorityId: 'test-only-independent-anchor-fixture', checkpointSequence: 7,
    checkpointDigest: 'c'.repeat(64), previousCheckpointDigest: 'd'.repeat(64), ledgerStateSha256: 'e'.repeat(64),
    trustDomainStateSha256: 'f'.repeat(64), candidateSha256: testCandidate.sha256, rollbackSha256: testRollback.sha256,
    signatureVerified: true, independentOfLocalLedger: true, observedAt: new Date().toISOString() };
  assert.equal(validateExternalAntiRollbackAnchorReport({ verified: true }, {
    candidateSha256: testCandidate.sha256, rollbackSha256: testRollback.sha256
  }).verified, false, 'a bare verified boolean must not satisfy the checkpoint report contract');
  const structurallyValidButSelfAsserted = validateExternalAntiRollbackAnchorReport(testOnlyAnchor, {
    candidateSha256: testCandidate.sha256, rollbackSha256: testRollback.sha256
  });
  assert.equal(structurallyValidButSelfAsserted.shapeValid, true);
  assert.equal(structurallyValidButSelfAsserted.verified, false,
    'a structurally valid report with self-asserted signature booleans must not prove independent cryptographic verification');
  assert.ok(structurallyValidButSelfAsserted.blockers.includes('EXTERNAL_TRUST_ANCHOR_CRYPTOGRAPHIC_VERIFIER_NOT_CONFIGURED'));
  assert.equal(validateExternalAntiRollbackAnchorReport({ ...testOnlyAnchor, candidateSha256: '0'.repeat(64) }, {
    candidateSha256: testCandidate.sha256, rollbackSha256: testRollback.sha256
  }).verified, false, 'checkpoint evidence must bind the exact candidate bytes');
  assert.equal(validateExternalAntiRollbackAnchorReport({ ...testOnlyAnchor, observedAt: new Date(Date.now() - 10 * 60_000).toISOString() }, {
    candidateSha256: testCandidate.sha256, rollbackSha256: testRollback.sha256
  }).verified, false, 'stale checkpoint observations must fail closed');
  const anchoredTestHost = { ...drainedHost, trustConfiguration: { ...drainedHost.trustConfiguration,
    externalAntiRollbackAnchor: testOnlyAnchor } };
  const selfAssertedAnchorGate = evaluateRolloutGate({ candidate: testCandidate, rollback: testRollback, host: anchoredTestHost });
  assert.equal(selfAssertedAnchorGate.status, 'BLOCKED', JSON.stringify(selfAssertedAnchorGate, null, 2));
  assert.equal(selfAssertedAnchorGate.canActivateNow, false);
  assert.ok(selfAssertedAnchorGate.blockers.includes('PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED'));

  const trustEnvironmentBytes = fs.readFileSync(installed.trustEnvironmentPath);
  fs.unlinkSync(installed.trustEnvironmentPath);
  const drainedButUntrustedHost = inspectHost({ appRoot, procRoot, workflowDb: workflowDbPath });
  const trustBlocked = evaluateRolloutGate({ candidate: { verified: true, version: '1.0.9-rc.8' },
    rollback: { verified: true, version: '1.0.9-rc.5' }, host: drainedButUntrustedHost });
  assert.equal(trustBlocked.status, 'BLOCKED');
  assert.ok(trustBlocked.blockers.includes('PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED'));
  fs.writeFileSync(installed.trustEnvironmentPath, trustEnvironmentBytes, { flag: 'wx', mode: 0o600 });

  const parentCmdline = path.join(procRoot, '100', 'cmdline');
  fs.writeFileSync(parentCmdline, '/usr/bin/node\0', { flag: 'w' });
  const unknownOwnerHost = inspectHost({ appRoot, procRoot, workflowDb: workflowDbPath });
  assert.ok(unknownOwnerHost.blockers.includes('HOST_PROCESS_OWNER_NOT_VERIFIED'));
  const ownerGate = evaluateRolloutGate({ candidate: { verified: true, version: '1.0.9-rc.8' },
    rollback: { verified: true, version: '1.0.9-rc.5' }, host: unknownOwnerHost });
  assert.equal(ownerGate.status, 'BLOCKED');
  assert.ok(ownerGate.blockers.includes('HOST_PROCESS_OWNER_NOT_VERIFIED'));
});

test('active-runtime trust preflight rejects malformed, legacy-only, colliding, revoked and expired trust inputs without leaking PEM', () => {
  const appRoot = path.join(testRoot, 'fake-host-trust-negatives');
  const procRoot = path.join(testRoot, 'fake-proc-trust-negatives');
  fs.mkdirSync(appRoot, { recursive: true, mode: 0o700 });
  const installed = makeFakeHost({ appRoot, procRoot, workflowDb: workflowDbPath });
  const readEnvironment = () => Object.fromEntries(fs.readFileSync(installed.trustEnvironmentPath, 'utf8').split('\0').filter(Boolean).map(item => {
    const separator = item.indexOf('='); return [item.slice(0, separator), item.slice(separator + 1)];
  }));
  const writeEnvironment = values => fs.writeFileSync(installed.trustEnvironmentPath,
    Buffer.from(Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\0') + '\0'), { flag: 'w', mode: 0o600 });
  const baseline = readEnvironment();
  const inspect = values => {
    writeEnvironment(values);
    return inspectRuntimeTrustConfiguration(4242, { procRoot });
  };
  try {
    const malformed = inspect({ ...baseline, AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON: '{' });
    assert.equal(malformed.available, false);
    assert.equal(malformed.status, 'BLOCKED');
    assert.equal(malformed.externalAntiRollbackAnchor.status, 'NOT_CONFIGURED',
      'anchor status must remain visible even when trust JSON itself is malformed');
    assert.ok(malformed.externalAntiRollbackAnchor.requiredFields.includes('candidateSha256'));
    assert.equal(JSON.stringify(malformed).includes('BEGIN PUBLIC KEY'), false);

    const source = JSON.parse(baseline.AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON);
    const reviewer = JSON.parse(baseline.AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON);
    const legacyOnly = {
      AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID: source.provider_id,
      AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM: source.keys[0].public_key_pem,
      AGG_REVIEW_IDENTITY_PROVIDER_ID: reviewer.provider_id,
      AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM: reviewer.keys[0].public_key_pem
    };
    const legacy = inspect(legacyOnly);
    assert.equal(legacy.available, false);
    assert.ok(legacy.blockers.some(blocker => blocker.code === 'PRODUCTION_AGG_TRUST_JSON_CONFIGURATION_REQUIRED'));

    const providerCollision = { ...baseline,
      AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON: JSON.stringify({ ...reviewer, provider_id: source.provider_id }) };
    const sameProvider = inspect(providerCollision);
    assert.equal(sameProvider.available, false);
    assert.ok(sameProvider.blockers.some(blocker => blocker.code === 'AGG_TRUST_DOMAINS_PROVIDER_COLLISION'));

    const rootCollision = { ...baseline,
      AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON: JSON.stringify({ ...reviewer,
        keys: [{ ...reviewer.keys[0], public_key_pem: source.keys[0].public_key_pem }] }) };
    const sameRoot = inspect(rootCollision);
    assert.equal(sameRoot.available, false);
    assert.ok(sameRoot.blockers.some(blocker => blocker.code === 'AGG_TRUST_DOMAINS_ROOT_COLLISION'));

    const revoked = { ...baseline,
      AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON: JSON.stringify({ ...reviewer,
        keys: [{ ...reviewer.keys[0], revoked_at: new Date(Date.now() - 1000).toISOString() }] }) };
    const revokedReport = inspect(revoked);
    assert.equal(revokedReport.available, false);
    assert.ok(revokedReport.blockers.some(blocker => blocker.code === 'PRODUCTION_AGG_TRUST_ROOT_NOT_CURRENT'));

    const expired = { ...baseline,
      AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON: JSON.stringify({ ...reviewer,
        keys: [{ ...reviewer.keys[0], not_after: new Date(Date.now() - 1000).toISOString() }] }) };
    const expiredReport = inspect(expired);
    assert.equal(expiredReport.available, false);
    assert.ok(expiredReport.blockers.some(blocker => blocker.code === 'PRODUCTION_AGG_TRUST_ROOT_NOT_CURRENT'));
    for (const report of [legacy, sameProvider, sameRoot, revokedReport, expiredReport]) {
      assert.equal(JSON.stringify(report).includes('BEGIN PUBLIC KEY'), false, 'preflight reports must never disclose public PEM material');
    }
  } finally { writeEnvironment(baseline); }
});

test('rollback snapshot captures exact installed file bytes and never overwrites prior bundles', () => {
  const appRoot = path.join(testRoot, 'fake-host-backup');
  const procRoot = path.join(testRoot, 'fake-proc-backup');
  fs.mkdirSync(appRoot, { recursive: true, mode: 0o700 });
  makeFakeHost({ appRoot, procRoot, workflowDb: workflowDbPath });
  const out = path.join(os.tmpdir(), `runalith-rollback-unit-${process.pid}-${crypto.randomUUID()}.mcpb`);
  temporaryRollbacks.push(out);
  const snapshot = createInstalledRollbackSnapshot({ outPath: out, appRoot, procRoot, workflowDb: workflowDbPath,
    smoke: () => ({ passed: true, output: 'test stub; live generation bytes compared independently' }) });
  assert.equal(snapshot.status, 'ROLLBACK_SNAPSHOT_READY');
  assert.equal(snapshot.version, '1.0.9-rc.5');
  assert.equal(snapshot.fileCount, 3);
  const bundle = inspectBundle(out);
  assert.equal(bundle.sha256, snapshot.archiveSha256);
  const parity = compareBundleToDirectory(bundle, path.join(appRoot, 'plugins', 'plugin-test-83ea5bbc', 'g-test'));
  assert.equal(parity.matches, true, JSON.stringify(parity));
  assert.throws(() => createInstalledRollbackSnapshot({ outPath: out, appRoot, procRoot, workflowDb: workflowDbPath,
    smoke: () => ({ passed: true }) }), /refusing to overwrite/);
});
