import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test, { after, before } from 'node:test';
import { assertAndRecordAdaptiveGoalTrustConfiguration, initializeAdaptiveGoalTrustConfigurationLedger,
  loadAdaptiveGoalTrustConfiguration } from '../src/runtime/adaptive-goal-trust-configuration.js';
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
  writeExclusiveJsonReport,
  verifyPhase2CustodyForPreflight,
  verifyReleaseEvidenceForPreflight,
  validateExternalAntiRollbackAnchorReport,
  validateExternalCheckpointHostPolicy,
  computeExternalStoreContinuityEvidenceSha256,
  verifyExternalStoreAttestation,
  validateHostPinnedReleasePolicyScope,
  validatePhase2CustodyPolicy,
  workflowDbSummary
} from '../scripts/runalith-rollout.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
let testRoot;
let candidatePath;
let workflowDbPath;
const temporaryRollbacks = [];

function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function canonicalTestJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalTestJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalTestJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

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

function createBundle({ version = '1.0.9-rc.8', entryPoint = 'server/index-v1.0.9-rc.8.js',
  startCommand = `node ${entryPoint}`, useRealHistorical = true } = {}) {
  const source = path.join(testRoot, `bundle-source-${crypto.randomUUID()}`);
  fs.mkdirSync(path.join(source, 'server'), { recursive: true, mode: 0o700 });
  const manifest = {
    name: 'runalith-agent-orchestrator', version,
    server: { type: 'node', entry_point: entryPoint, mcp_config: { command: 'node', args: ['${__dirname}/' + entryPoint] } },
    tools: [{ name: 'orchestrator_health', description: 'Isolated test runtime health probe' }]
  };
  fs.writeFileSync(path.join(source, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(source, 'package.json'), `${JSON.stringify({ name: 'runalith-agent-orchestrator', version, type: 'module', main: entryPoint,
    scripts: { start: startCommand } }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
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
  fs.writeFileSync(path.join(generationRoot, 'package.json'), JSON.stringify({ name: 'runalith-agent-orchestrator', version,
    type: 'module', main: 'server/index.js', scripts: { start: 'node server/index.js' } }), { flag: 'wx', mode: 0o600 });
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
  // The fake host models the ledger actually opened by the active runtime.
  // Its random roots and rows are test-local only and never represent host trust.
  const trustLedgerDirectory = path.join(appRoot, 'private-data');
  fs.mkdirSync(trustLedgerDirectory, { recursive: true, mode: 0o700 });
  const trustLedgerPath = path.join(trustLedgerDirectory, 'agg-trust-configuration.db');
  const trustLedger = new DatabaseSync(trustLedgerPath);
  initializeAdaptiveGoalTrustConfigurationLedger(trustLedger);
  const sourceConfiguration = loadAdaptiveGoalTrustConfiguration({
    configJsonEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON', providerEnv: 'AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID',
    publicKeyEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM', domain: 'goal_idea_verifier',
    scope: 'agg.goal_idea_graph.verify', environment: trustEnvironment, now
  });
  const reviewerConfiguration = loadAdaptiveGoalTrustConfiguration({
    configJsonEnv: 'AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON', providerEnv: 'AGG_REVIEW_IDENTITY_PROVIDER_ID',
    publicKeyEnv: 'AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM', domain: 'action_intent_reviewer',
    scope: 'agg.action_intent.review', environment: trustEnvironment, now
  });
  assertAndRecordAdaptiveGoalTrustConfiguration(trustLedger, sourceConfiguration, { now });
  assertAndRecordAdaptiveGoalTrustConfiguration(trustLedger, reviewerConfiguration, { now });
  trustLedger.close();
  fs.mkdirSync(path.join(procRoot, '4242', 'fd'), { recursive: true, mode: 0o700 });
  fs.symlinkSync(trustLedgerPath, path.join(procRoot, '4242', 'fd', '10'));
  fs.symlinkSync(workflowDb, path.join(procRoot, '4242', 'fd', '11'));
  const trustEnvironmentPath = path.join(procRoot, '4242', 'environ');
  fs.writeFileSync(trustEnvironmentPath, Buffer.from(Object.entries(trustEnvironment).map(([key, value]) => `${key}=${value}`).join('\0') + '\0'),
    { flag: 'wx', mode: 0o600 });
  return { pluginId, generationRoot, entryPoint: path.join(generationRoot, 'server/index.js'), trustEnvironmentPath, trustLedgerPath,
    trustLedgerDescriptorPath: path.join(procRoot, '4242', 'fd', '10') };
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

test('candidate package rejects npm start that points to a different versioned runtime than the manifest', () => {
  const splitIdentity = createBundle({ startCommand: 'node server/index-v1.0.9-rc.5.js' });
  try {
    assert.throws(() => inspectBundle(splitIdentity), /candidate manifest\/package metadata, entry point, args or tool declarations/,
      'a candidate whose npm start diverges from manifest.server.entry_point must fail before activation');
  } finally { fs.rmSync(splitIdentity, { force: true }); }
});

test('preflight diagnostic report publication is exclusive and unsupported options fail closed', () => {
  const destination = path.join(testRoot, `preflight-report-${crypto.randomUUID()}.json`);
  const report = { status: 'BLOCKED', readOnly: true, liveMutationPerformed: false, canActivateNow: false };
  const published = writeExclusiveJsonReport(destination, report);
  assert.equal(published.path, destination);
  assert.equal(published.sha256, hash(fs.readFileSync(destination)));
  assert.deepEqual(JSON.parse(fs.readFileSync(destination, 'utf8')), report);
  assert.equal((fs.statSync(destination).mode & 0o777), 0o600);
  assert.throws(() => writeExclusiveJsonReport(destination, { status: 'READY' }), /refusing to overwrite/);

  const realParent = path.join(testRoot, `report-parent-${crypto.randomUUID()}`);
  const aliasParent = path.join(testRoot, `report-parent-alias-${crypto.randomUUID()}`);
  fs.mkdirSync(realParent, { mode: 0o700 });
  fs.symlinkSync(realParent, aliasParent, 'dir');
  assert.throws(() => writeExclusiveJsonReport(path.join(aliasParent, 'report.json'), report), /canonical directory/);

  const unsupported = spawnSync(process.execPath, [path.join(ROOT, 'scripts/runalith-rollout.mjs'), 'preflight',
    '--candidate', 'not-read.mcpb', '--out', path.join(testRoot, 'must-not-exist.json')], { encoding: 'utf8' });
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr + unsupported.stdout, /unsupported option --out for command preflight/);
  assert.equal(fs.existsSync(path.join(testRoot, 'must-not-exist.json')), false);

  // Parsing the explicit state-changing flag must not itself invoke the host
  // adapter. Omitting the required candidate fails before host inspection.
  const checkpointWithoutCandidate = spawnSync(process.execPath, [path.join(ROOT, 'scripts/runalith-rollout.mjs'),
    'preflight', '--advance-external-checkpoint'], { encoding: 'utf8' });
  assert.notEqual(checkpointWithoutCandidate.status, 0);
  assert.match(checkpointWithoutCandidate.stderr + checkpointWithoutCandidate.stdout, /preflight requires --candidate/);
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
  const inconsistentState = new DatabaseSync(workflowDbPath);
  inconsistentState.prepare('INSERT INTO jobs(job_id,state,status) VALUES(?,?,?)')
    .run('job-executing-status-inconsistent', 'EXECUTING', 'completed');
  inconsistentState.close();
  const inconsistentSummary = workflowDbSummary(workflowDbPath);
  assert.equal(inconsistentSummary.executingJobs, 2,
    'the rollout drain gate must count every EXECUTING state regardless of inconsistent status metadata');
  const restoreInconsistentState = new DatabaseSync(workflowDbPath);
  restoreInconsistentState.prepare('DELETE FROM jobs WHERE job_id=?').run('job-executing-status-inconsistent');
  restoreInconsistentState.close();
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
  assert.ok(blocked.blockers.includes('PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED'),
    'candidate smoke, exact host identity, and local graph/trust readiness do not authenticate the frozen 71-path authority');
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
  assert.ok(selfAssertedAnchorGate.blockers.includes('PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED'),
    'a self-asserted host checkpoint must not clear Phase 2 path authority');
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

test('rollout gate requires release evidence verified from exact signed bytes, not caller-authored booleans', () => {
  const candidate = { verified: true, version: '1.0.9-rc.12', sha256: 'a'.repeat(64) };
  const rollback = { verified: true, version: '1.0.9-rc.11', sha256: 'b'.repeat(64) };
  const host = { registryReadable: true, plugin: { id: 'fixture' },
    installedGeneration: { manifestVersion: '1.0.9-rc.11' },
    database: { readable: true, executingJobs: 0, runningTasks: 0, activeLeases: 0 },
    trustConfiguration: { available: true } };
  const missing = evaluateRolloutGate({ candidate, rollback, host });
  assert.ok(missing.blockers.includes('INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED'));
  assert.equal(missing.canActivateNow, false);

  const callerAuthoredEvidence = { cryptographicEvidenceVerified: true, productionAuthorityEstablished: false,
    candidate: { sha256: candidate.sha256 }, rollback: { sha256: rollback.sha256, version: rollback.version },
    baseline: { version: host.installedGeneration.manifestVersion, sha256: rollback.sha256 } };
  const forged = evaluateRolloutGate({ candidate, rollback, host, releaseEvidence: callerAuthoredEvidence });
  assert.ok(forged.blockers.includes('INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED'),
    'self-asserted result fields must not substitute for the local verifier’s unforgeable in-process result identity');
  assert.ok(forged.blockers.includes('PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED'),
    'a caller-authored release result must not implicitly authorize the frozen path list');
  assert.equal(forged.canActivateNow, false);
});

test('Phase 2 frozen-path gate requires owner evidence and a host-provisioned trust policy', () => {
  const candidateBundle = { path: '/not-read/candidate.mcpb', sha256: 'a'.repeat(64), version: '1.0.9-rc.16' };
  const missing = verifyPhase2CustodyForPreflight({ args: {}, candidateBundle });
  assert.equal(missing.verified, false);
  assert.deepEqual(missing.blockers, ['PHASE2_CUSTODY_EVIDENCE_NOT_PROVIDED']);
  assert.deepEqual(missing.missingArguments, ['phase2Manifest', 'phase2Receipt']);
  assert.equal(missing.requiredHostPolicyPath, '/etc/runalith/phase2-custody-trust.json');

  const partial = verifyPhase2CustodyForPreflight({ args: { phase2Manifest: '/tmp/owner-manifest.json' }, candidateBundle });
  assert.equal(partial.verified, false);
  assert.deepEqual(partial.blockers, ['PHASE2_CUSTODY_ARGUMENT_SET_INCOMPLETE']);
  assert.deepEqual(partial.missingArguments, ['phase2Receipt']);

  const host = { registryReadable: true, plugin: { id: 'fixture' },
    installedGeneration: { manifestVersion: '1.0.9-rc.11' },
    database: { readable: true, executingJobs: 0, runningTasks: 0, activeLeases: 0 },
    trustConfiguration: { available: true } };
  const candidate = { verified: true, version: '1.0.9-rc.16', sha256: candidateBundle.sha256 };
  const rollback = { verified: true, version: '1.0.9-rc.11', sha256: 'b'.repeat(64) };
  const forged = { ...missing, verified: true, status: 'HOST_PINNED_PHASE2_PATH_CONTRACT_VERIFIED',
    authorityKeyProvisioningAuthenticated: true, manifestPathCount: 71, candidateSha256: candidate.sha256,
    sourceCommit: 'c'.repeat(40), sourceTreeOid: 'd'.repeat(40),
    hostPolicy: { sha256: 'e'.repeat(64), ownerUid: 0, mode: 0o600,
      sourceCommit: 'c'.repeat(40), sourceTreeOid: 'd'.repeat(40) } };
  const decision = evaluateRolloutGate({ candidate, rollback, host, phase2CustodyEvidence: forged });
  assert.ok(decision.blockers.includes('PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED'),
    'caller-authored fields cannot impersonate the local verifier result object');
  assert.equal(decision.canActivateNow, false);
});

test('Phase 2 host custody policy is versioned and enforces key validity, revocation, and disjoint roots', () => {
  const now = Date.parse('2026-10-27T12:30:00.000Z');
  const key = () => {
    const pair = crypto.generateKeyPairSync('ed25519');
    const pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    return { pem, fingerprint: hash(pair.publicKey.export({ type: 'spki', format: 'der' })) };
  };
  const authority = key();
  const builder = key();
  const valid = {
    schema_version: 1, contract: 'runalith-phase2-host-custody-policy/v1', policy_version: 7,
    updated_at: '2026-10-27T12:00:00.000Z', updated_by: 'security-admin', change_reference: 'CHG-TEST-7',
    authority_id: 'phase2-owner', builder_identity: 'controlled-builder', repository: 'https://github.com/nplongx/runalith',
    source_commit: 'c'.repeat(40), source_tree_oid: 'd'.repeat(40),
    authority_key_id: 'phase2-authority-7', authority_public_key_pem: authority.pem,
    authority_key_sha256: authority.fingerprint, authority_key_not_before: '2026-10-01T00:00:00.000Z',
    authority_key_not_after: null, authority_key_revoked_at: null,
    builder_key_id: 'phase2-builder-7', builder_public_key_pem: builder.pem,
    builder_key_sha256: builder.fingerprint, builder_key_not_before: '2026-10-01T00:00:00.000Z',
    builder_key_not_after: null, builder_key_revoked_at: null
  };
  const verified = validatePhase2CustodyPolicy(valid, { now, expectedRepository: valid.repository });
  assert.equal(verified.policy_version, 7);
  assert.equal(verified.authorityKeySha256, authority.fingerprint);
  assert.equal(verified.builderKeySha256, builder.fingerprint);

  assert.throws(() => validatePhase2CustodyPolicy({ ...valid, policy_version: 0 }, { now }), /HOST_POLICY_SCHEMA_INVALID/);
  assert.throws(() => validatePhase2CustodyPolicy({ ...valid, change_reference: '' }, { now }), /HOST_POLICY_SCHEMA_INVALID/);
  assert.throws(() => validatePhase2CustodyPolicy({ ...valid, repository: 'https://example.invalid/other/repo' },
    { now, expectedRepository: valid.repository }), /HOST_POLICY_SCHEMA_INVALID/);
  assert.throws(() => validatePhase2CustodyPolicy({ ...valid,
    authority_key_not_after: '2026-10-27T12:00:00.000Z' }, { now }), /HOST_POLICY_KEY_UNAVAILABLE/);
  assert.throws(() => validatePhase2CustodyPolicy({ ...valid,
    builder_key_revoked_at: '2026-10-27T12:29:00.000Z' }, { now }), /HOST_POLICY_KEY_UNAVAILABLE/);
  assert.throws(() => validatePhase2CustodyPolicy({ ...valid,
    builder_key_sha256: authority.fingerprint }, { now }), /HOST_POLICY_KEY_PIN_INVALID/);
  assert.throws(() => validatePhase2CustodyPolicy({ ...valid, unreviewed: true }, { now }), /HOST_POLICY_SCHEMA_INVALID/);
});

test('external checkpoint host policy pins a distinct authority/store root and rejects local endpoints, expiry and revocation', () => {
  const now = Date.parse('2026-10-27T12:45:00.000Z');
  const makeKey = () => {
    const pair = crypto.generateKeyPairSync('ed25519');
    return { pem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      fingerprint: hash(pair.publicKey.export({ type: 'spki', format: 'der' })), privateKey: pair.privateKey };
  };
  const authority = makeKey();
  const store = makeKey();
  const policy = {
    schema_version: 1, contract: 'runalith-external-checkpoint-host-policy/v1', policy_version: 3,
    updated_at: '2026-10-27T12:00:00.000Z', updated_by: 'platform-security-admin', change_reference: 'CHG-ANCHOR-3',
    authority_id: 'checkpoint-authority', authority_key_id: 'checkpoint-root-3',
    authority_public_key_pem: authority.pem, authority_key_sha256: authority.fingerprint,
    authority_key_not_before: '2026-10-01T00:00:00.000Z', authority_key_not_after: null, authority_key_revoked_at: null,
    store_attestation_key_id: 'external-store-root-3', store_attestation_public_key_pem: store.pem,
    store_attestation_key_sha256: store.fingerprint,
    store_attestation_key_not_before: '2026-10-01T00:00:00.000Z', store_attestation_key_not_after: null,
    store_attestation_key_revoked_at: null,
    adapter_path: '/usr/local/libexec/runalith/external-checkpoint-adapter', adapter_sha256: 'a'.repeat(64),
    external_store_id: 'security-store-prod-a', external_service_uri: 'https://checkpoint.security.example/v1',
    max_store_attestation_age_seconds: 3600
  };
  const validated = validateExternalCheckpointHostPolicy(policy, { now });
  assert.equal(validated.policy_version, 3);
  assert.equal(validated.authorityKeySha256 || validated.authority_key_sha256, authority.fingerprint);
  assert.equal(validated.storeAttestationPublicKey.asymmetricKeyType, 'ed25519');

  const continuity = { source: 'host_monotonic_store', authorityId: policy.authority_id,
    highWaterSequence: 12, lastCheckpointDigest: 'b'.repeat(64) };
  const attestationPayload = {
    schema_version: 1, contract: 'runalith-external-monotonic-store-attestation/v1',
    authority_id: policy.authority_id, store_id: policy.external_store_id, service_uri: policy.external_service_uri,
    backend: 'managed_remote_transactional_store', independent_of_plugin_host: true,
    monotonicity_protection: true, restore_rollback_protection: true,
    issued_at: '2026-10-27T12:44:00.000Z', valid_until: '2026-10-27T13:00:00.000Z',
    evidence_sha256: computeExternalStoreContinuityEvidenceSha256({ authorityId: policy.authority_id,
      storeId: policy.external_store_id, serviceUri: policy.external_service_uri, continuity })
  };
  const attestation = { ...attestationPayload,
    signature_base64: crypto.sign(null, Buffer.from(canonicalTestJson(attestationPayload)), store.privateKey).toString('base64') };
  assert.equal(verifyExternalStoreAttestation(attestation, validated, { now, continuity }).storeId, policy.external_store_id,
    'a store signature must attest to the exact high-water and previous-digest record used by the checkpoint verifier');
  assert.throws(() => verifyExternalStoreAttestation(attestation, validated, { now,
    continuity: { ...continuity, lastCheckpointDigest: 'c'.repeat(64) } }),
  /EXTERNAL_CHECKPOINT_STORE_ATTESTATION_BINDING_MISMATCH/);
  assert.throws(() => verifyExternalStoreAttestation({ ...attestation, evidence_sha256: 'd'.repeat(64) }, validated,
    { now, continuity }), /EXTERNAL_CHECKPOINT_STORE_ATTESTATION_BINDING_MISMATCH/);

  assert.throws(() => validateExternalCheckpointHostPolicy({ ...policy, external_service_uri: 'http://checkpoint.security.example/v1' }, { now }),
    /HOST_CHECKPOINT_POLICY_SERVICE_INVALID/);
  assert.throws(() => validateExternalCheckpointHostPolicy({ ...policy, external_service_uri: 'https://127.0.0.1/v1' }, { now }),
    /HOST_CHECKPOINT_POLICY_SERVICE_INVALID/);
  assert.throws(() => validateExternalCheckpointHostPolicy({ ...policy,
    store_attestation_key_sha256: authority.fingerprint, store_attestation_public_key_pem: authority.pem }, { now }),
  /HOST_CHECKPOINT_POLICY_STORE_KEY_PIN_INVALID/);
  assert.throws(() => validateExternalCheckpointHostPolicy({ ...policy,
    authority_key_revoked_at: '2026-10-27T12:44:00.000Z' }, { now }), /HOST_CHECKPOINT_POLICY_KEY_UNAVAILABLE/);
  assert.throws(() => validateExternalCheckpointHostPolicy({ ...policy,
    store_attestation_key_not_after: '2026-10-27T12:44:00.000Z' }, { now }), /HOST_CHECKPOINT_POLICY_STORE_KEY_UNAVAILABLE/);
  assert.throws(() => validateExternalCheckpointHostPolicy({ ...policy,
    adapter_path: '/tmp/untrusted-checkpoint-adapter' }, { now }), /HOST_CHECKPOINT_POLICY_SCHEMA_INVALID/);
  assert.throws(() => validateExternalCheckpointHostPolicy({ ...policy, unreviewed: true }, { now }), /HOST_POLICY_SCHEMA_INVALID/);
});

test('caller-authored anchor reports never open the external checkpoint gate', () => {
  const candidateSha256 = 'a'.repeat(64);
  const rollbackSha256 = 'b'.repeat(64);
  const forged = { verified: true, status: 'VERIFIED', source: 'host_monotonic_checkpoint_service',
    authorityId: 'caller-claimed-authority', checkpointSequence: 9,
    checkpointDigest: 'c'.repeat(64), previousCheckpointDigest: 'd'.repeat(64),
    ledgerStateSha256: 'e'.repeat(64), trustDomainStateSha256: 'f'.repeat(64),
    signatureVerified: true, independentOfLocalLedger: true, candidateSha256, rollbackSha256,
    observedAt: new Date().toISOString(), productionAuthorityEstablished: true,
    externalStoreAttestationVerified: true, commitReceiptVerified: true, checkpointStateAdvanced: true, nonceConsumed: true };
  assert.equal(validateExternalAntiRollbackAnchorReport(forged, { candidateSha256, rollbackSha256 }).verified, false);
});

test('release-evidence preflight rejects missing and partial argument sets before opening any evidence path', () => {
  const candidateBundle = { path: '/not-read/candidate.mcpb', sha256: 'a'.repeat(64), version: '1.0.9-rc.12' };
  const rollback = { path: '/not-read/rollback.mcpb', sha256: 'b'.repeat(64), version: '1.0.9-rc.11', verified: true };
  const host = { installedGeneration: { manifestVersion: '1.0.9-rc.11' } };
  const missing = verifyReleaseEvidenceForPreflight({ args: {}, candidateBundle, rollback, host });
  assert.equal(missing.cryptographicEvidenceVerified, false);
  assert.deepEqual(missing.evidenceBlockers, ['RELEASE_EVIDENCE_NOT_PROVIDED']);
  assert.deepEqual(missing.missingArguments, ['releasePolicy', 'provenance', 'verification', 'approval', 'releaseNonce']);

  const partial = verifyReleaseEvidenceForPreflight({ args: { releasePolicy: '/not-read/policy.json', approval: '/not-read/approval.json' }, candidateBundle, rollback, host });
  assert.equal(partial.cryptographicEvidenceVerified, false);
  assert.deepEqual(partial.evidenceBlockers, ['RELEASE_EVIDENCE_ARGUMENT_SET_INCOMPLETE']);
  assert.deepEqual(partial.missingArguments, ['provenance', 'verification', 'releaseNonce']);

  const callerSelectedPolicy = verifyReleaseEvidenceForPreflight({ args: {
    releasePolicy: '/tmp/self-selected-policy.json', provenance: '/tmp/provenance.json',
    verification: '/tmp/verification.json', approval: '/tmp/approval.json', releaseNonce: 'a'.repeat(32)
  }, candidateBundle, rollback, host });
  assert.equal(callerSelectedPolicy.cryptographicEvidenceVerified, false);
  assert.ok(callerSelectedPolicy.evidenceBlockers.includes('HOST_POLICY_PATH_NOT_AUTHORIZED'),
    'when all evidence arguments are supplied, caller-created signer roots must not be accepted as release policy');
});

test('production release policy scope is pinned to the canonical repository, package subject, build type and production environment', () => {
  const valid = {
    schema_version: 1, contract: 'runalith-release-policy/v1', policy_version: 9,
    source_repository: 'https://github.com/nplongx/runalith', subject_name: 'runalith.mcpb',
    expected_build_type: 'https://runalith.dev/build/mcpb/v1', target_environment: 'production'
  };
  const result = validateHostPinnedReleasePolicyScope(valid);
  assert.equal(result.canonicalScopeVerified, true);
  assert.equal(result.policyVersion, 9);

  for (const [field, value] of [
    ['source_repository', 'https://github.com/attacker/other-repo'],
    ['subject_name', 'other-package.mcpb'],
    ['expected_build_type', 'https://example.invalid/unreviewed-build/v1'],
    ['target_environment', 'staging'],
    ['policy_version', 0]
  ]) {
    assert.throws(() => validateHostPinnedReleasePolicyScope({ ...valid, [field]: value }),
      error => error.code === 'RELEASE_POLICY_SCOPE_NOT_CANONICAL', `${field} substitution must fail closed`);
  }
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
    const current = inspect(baseline);
    assert.equal(current.available, true, JSON.stringify(current));
    assert.equal(current.trustLedger.available, true);
    assert.equal(current.trustLedger.status, 'CURRENT_FOR_ALL_DOMAINS');
    assert.equal(current.trustLedger.source, 'active_runtime_open_file_descriptor');
    assert.equal(current.trustLedger.domains.goal_idea_verifier.verified, true);
    assert.equal(current.trustLedger.domains.action_intent_reviewer.verified, true);

    const sourceConfig = JSON.parse(baseline.AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON);
    const reviewerConfig = JSON.parse(baseline.AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON);
    const unrecordedNextVersion = inspect({ ...baseline,
      AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON: JSON.stringify({ ...sourceConfig, config_version: 2,
        updated_at: new Date(Date.now() - 500).toISOString(), change_reference: 'TEST-UNRECORDED-ROTATION' }) });
    assert.equal(unrecordedNextVersion.available, false,
      'a valid JSON config not yet observed in the active trust ledger must not be production-verified');
    assert.ok(unrecordedNextVersion.blockers.some(blocker => blocker.code === 'PRODUCTION_AGG_TRUST_CONFIGURATION_LEDGER_NOT_CURRENT'));
    assert.equal(unrecordedNextVersion.trustLedger.domains.goal_idea_verifier.latestRecordedConfigVersion, 1);
    assert.equal(unrecordedNextVersion.externalAntiRollbackAnchor.status, 'NOT_CONFIGURED',
      'a current local ledger still does not impersonate an external monotonic anchor');

    const sameVersionReplacement = inspect({ ...baseline,
      AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON: JSON.stringify({ ...sourceConfig,
        provider_id: 'replacement-source-provider-at-same-version' }) });
    assert.equal(sameVersionReplacement.available, false);
    assert.equal(sameVersionReplacement.trustLedger.domains.goal_idea_verifier.status, 'version_reused',
      'same-version trust-provider substitution must be caught by the active ledger');

    const rollbackLedgerDirectory = path.join(path.dirname(installed.trustLedgerPath), 'rollback-fixture');
    fs.mkdirSync(rollbackLedgerDirectory, { recursive: true, mode: 0o700 });
    const rollbackLedgerPath = path.join(rollbackLedgerDirectory, 'agg-trust-configuration.db');
    const rollbackLedger = new DatabaseSync(rollbackLedgerPath);
    initializeAdaptiveGoalTrustConfigurationLedger(rollbackLedger);
    const sourceVersionTwo = loadAdaptiveGoalTrustConfiguration({
      configJsonEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON', providerEnv: 'AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID',
      publicKeyEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM', domain: 'goal_idea_verifier',
      scope: 'agg.goal_idea_graph.verify', environment: { ...baseline,
        AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON: JSON.stringify({ ...sourceConfig, config_version: 2,
          updated_at: new Date(Date.now() - 250).toISOString(), change_reference: 'TEST-RECORDED-V2' }) }
    });
    const reviewerV1 = loadAdaptiveGoalTrustConfiguration({
      configJsonEnv: 'AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON', providerEnv: 'AGG_REVIEW_IDENTITY_PROVIDER_ID',
      publicKeyEnv: 'AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM', domain: 'action_intent_reviewer',
      scope: 'agg.action_intent.review', environment: baseline
    });
    assertAndRecordAdaptiveGoalTrustConfiguration(rollbackLedger, sourceVersionTwo);
    assertAndRecordAdaptiveGoalTrustConfiguration(rollbackLedger, reviewerV1);
    rollbackLedger.close();
    fs.unlinkSync(installed.trustLedgerDescriptorPath);
    fs.symlinkSync(rollbackLedgerPath, installed.trustLedgerDescriptorPath);
    const rolledBack = inspect(baseline);
    assert.equal(rolledBack.available, false);
    assert.equal(rolledBack.trustLedger.domains.goal_idea_verifier.status, 'rollback_detected',
      'a lower effective config version must be blocked against the ledger high-water mark');
    fs.unlinkSync(installed.trustLedgerDescriptorPath);
    fs.symlinkSync(installed.trustLedgerPath, installed.trustLedgerDescriptorPath);

    fs.unlinkSync(installed.trustLedgerDescriptorPath);
    const noOpenLedger = inspect(baseline);
    assert.equal(noOpenLedger.available, false,
      'a well-formed file on disk is not effective anti-rollback evidence when the active process has not opened it');
    assert.ok(noOpenLedger.blockers.some(blocker => blocker.details?.some(item => item.code === 'AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE')));
    fs.symlinkSync(installed.trustLedgerPath, installed.trustLedgerDescriptorPath);

    const malformed = inspect({ ...baseline, AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON: '{' });
    assert.equal(malformed.available, false);
    assert.equal(malformed.status, 'BLOCKED');
    assert.equal(malformed.externalAntiRollbackAnchor.status, 'NOT_CONFIGURED',
      'anchor status must remain visible even when trust JSON itself is malformed');
    assert.ok(malformed.externalAntiRollbackAnchor.requiredFields.includes('candidateSha256'));
    assert.equal(JSON.stringify(malformed).includes('BEGIN PUBLIC KEY'), false);

    const source = sourceConfig;
    const reviewer = reviewerConfig;
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
