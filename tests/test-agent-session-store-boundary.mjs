import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-session-store-boundary-'));
fs.chmodSync(dataDir, 0o700);
process.env.WORKFLOW_DATA_DIR = dataDir;
process.env.WORKFLOW_DB = path.join(dataDir, 'workflow.db');
process.env.NODE_ENV = 'test';

const [{ WorkflowStore }, { AGENT_SESSION_API_VERSION, createAgentSessionPort, createAgentSessionApi,
  createAgentSessionLifecycleParticipant, AGENT_SESSION_DELIVERY_HOOKS }] = await Promise.all([
  import(pathToFileURL(path.join(root, 'job-store.js'))),
  import(pathToFileURL(path.join(root, 'src/runtime/agent-session-api.js')))
]);
const { WorkflowStore: WorkflowStoreCore } = await import(pathToFileURL(path.join(root, 'src/runtime/job-store.js')));
const { AgentSessionStore } = await import(pathToFileURL(path.join(root, 'src/runtime/agent-session-store.js')));
const { createWorkflowStatePort } = await import(pathToFileURL(path.join(root, 'src/runtime/workflow-state-port.js')));

const store = new WorkflowStore();
const job = store.createJob({ conversationKey: `agent-session-boundary-${process.pid}`, title: 'Agent session owner boundary' });
store.transition(job.job_id, 'PROPOSED');
store.approve(job.job_id, 'approved for disposable owner-boundary test');
const task = store.dispatch(job.job_id, { role: 'cto', description: 'Create durable agent session' });
const sessionKey = `agent:cto:subagent:owner-boundary-${process.pid}`;
store.attachOpenClawRun(job.job_id, { runId: `run-owner-boundary-${process.pid}`, sessionKey });
const compatibilitySession = store.getSessionByTask(task.task_id);
assert.ok(compatibilitySession, 'WorkflowStore compatibility facade returns the AgentSessionStore record');

const sessionStore = store.agentSessions;
assert.equal(sessionStore.version, AGENT_SESSION_API_VERSION, 'composition host must expose the versioned Agent Session API');
assert.equal(Object.isFrozen(sessionStore), true, 'public Agent Session API v1 must be immutable');
assert.equal(Object.hasOwn(sessionStore, 'db'), false, 'Agent Session API must not expose DatabaseSync handle');
assert.equal(Object.hasOwn(sessionStore, 'workflowPort'), false, 'Agent Session API must not expose Workflow port');
assert.equal(Object.hasOwn(sessionStore, 'lockSession'), false, 'Workflow-only lifecycle hooks must not leak into public Agent Session API');
assert.equal(Object.hasOwn(sessionStore, 'updateRetryAttempt'), false, 'retry participant must not leak into public Agent Session API');
assert.equal(Object.hasOwn(sessionStore, 'terminateSessionsForTask'), false, 'terminalization participant must not leak into public Agent Session API');
assert.equal(sessionStore.unrecognizedLifecycleMethod, undefined, 'unknown lifecycle methods must not be exposed');
assert.equal(sessionStore.getSession(compatibilitySession.session_id).session_id, compatibilitySession.session_id);
assert.equal(Object.hasOwn(WorkflowStoreCore.prototype, 'listAgentSessions'), false,
  'WorkflowStore core must not declare Agent Session compatibility facade methods');
assert.equal(typeof store.listAgentSessions, 'function',
  'host compatibility facade must preserve the legacy WorkflowStore method path');
assert.equal(store.listAgentSessions({ jobId: compatibilitySession.job_id, limit: 10 }).some(row => row.session_id === compatibilitySession.session_id), true);
const compatibilityDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(store), 'listAgentSessions');
assert.equal(compatibilityDescriptor.writable, true, 'host facade must preserve legacy instance monkey-patching');
assert.equal(compatibilityDescriptor.configurable, true, 'host facade must remain replaceable during compatibility migration');
const originalListAgentSessions = store.listAgentSessions;
store.listAgentSessions = () => ['host-override'];
assert.deepEqual(store.listAgentSessions(), ['host-override'], 'instance override must take precedence over host facade wrapper');
delete store.listAgentSessions;
assert.equal(store.listAgentSessions, originalListAgentSessions, 'deleting instance override must restore host facade wrapper');

const access = sessionStore.grantSessionAccess(compatibilitySession.session_id, {
  accessorRole: 'architect', permission: 'MESSAGE', grantedBy: 'cto'
});
assert.equal(store.getSessionAccess(access.access_id).access_id, access.access_id,
  'WorkflowStore retains a compatibility API; AgentSessionStore remains the row owner');
const message = sessionStore.enqueueSessionMessage(compatibilitySession.session_id, {
  senderRole: 'cto', recipientRole: 'architect', payload: { boundary: 'agent-owned' }, dedupeKey: 'owner-boundary'
});
assert.equal(store.getSessionMessage(message.message_id).message_id, message.message_id);

const sessionTables = store.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'
  AND name IN ('agent_sessions','session_access','session_messages') ORDER BY name`).all().map(row => row.name);
assert.deepEqual(sessionTables, ['agent_sessions', 'session_access', 'session_messages']);
const queueEvent = store.db.prepare("SELECT event_id,payload_json FROM events WHERE job_id=? AND type='session.message_queued'").get(job.job_id);
assert.ok(queueEvent, 'AgentSessionStore must append the Workflow-owned queue event through WorkflowStatePort');
assert.equal(JSON.parse(queueEvent.payload_json).messageId, message.message_id);

const workflowSource = fs.readFileSync(path.join(root, 'src/runtime/job-store.js'), 'utf8');
const workflowPortSource = fs.readFileSync(path.join(root, 'src/runtime/workflow-state-port.js'), 'utf8');
const compositionSource = fs.readFileSync(path.join(root, 'src/runtime/runalith-runtime-composition.js'), 'utf8');
const agentSource = fs.readFileSync(path.join(root, 'src/runtime/agent-session-store.js'), 'utf8');
const apiSource = fs.readFileSync(path.join(root, 'src/runtime/agent-session-api.js'), 'utf8');
const policySource = fs.readFileSync(path.join(root, 'src/runtime/agent-session-policy.js'), 'utf8');
assert.doesNotMatch(workflowSource, /import[^\n]*agent-session-store|new AgentSessionStore|createWorkflowStatePort/,
  'WorkflowStore must not import, construct or initialize AgentSessionStore');
assert.match(compositionSource, /new AgentSessionStore\(\{/,
  'the composition host must own AgentSessionStore construction');
assert.match(compositionSource, /createAgentSessionPort\(agentSessionStore\)/);
assert.match(compositionSource, /createAgentSessionLifecycleParticipant\(agentSessionStore\)/,
  'host must compose a separate internal transaction participant');
assert.match(compositionSource, /attachAgentSessionDomainPort\(port\)/,
  'Workflow domain queries must consume the versioned Agent Session domain port');
assert.match(compositionSource, /AGENT_SESSION_API_METHODS/);
assert.match(compositionSource, /agentSessionCompatibilityFacade/);
assert.match(compositionSource, /createWorkflowStatePort\(this, \{ executionPersistenceStore \}\)/,
  'the host must inject WorkflowStatePort and the Execution persistence owner instead of AgentSessionStore reaching into WorkflowStore');
assert.doesNotMatch(workflowSource, /CREATE TABLE IF NOT EXISTS (?:agent_sessions|session_access|session_messages)/,
  'WorkflowStore must not own Agent Runtime table schemas');
assert.doesNotMatch(workflowSource, /(?:FROM|UPDATE|INTO|JOIN)\s+(?:agent_sessions|session_access|session_messages)\b/i,
  'WorkflowStore must not query or mutate Agent Runtime tables directly');
assert.match(workflowPortSource, /listActiveAgentSessionsForJob\(jobId\)[\s\S]*?#invoke\('listActiveAgentSessionsForJob'/,
  'WorkflowStatePort must read Agent Runtime state through the owner API');
assert.match(agentSource, /const AGENT_SESSION_SCHEMA/);
assert.match(agentSource, /CREATE TABLE IF NOT EXISTS agent_sessions/);
assert.match(agentSource, /CREATE TABLE IF NOT EXISTS session_access/);
assert.match(agentSource, /CREATE TABLE IF NOT EXISTS session_messages/);
assert.doesNotMatch(agentSource, /workflow\/governance\.js|facade/i,
  'Agent Session implementation must not depend on Workflow governance module or WorkflowStore compatibility facade');
assert.doesNotMatch(agentSource, /(?:FROM|UPDATE|INTO|JOIN)\s+(?:events|tasks|jobs|attempts|task_leases)\b/i,
  'AgentSessionStore must not issue SQL against Workflow/Execution-owned tables');
assert.match(apiSource, /AGENT_SESSION_API_VERSION = 1/);
assert.match(apiSource, /AGENT_SESSION_LIFECYCLE_METHODS/);
assert.match(apiSource, /createAgentSessionLifecycleParticipant/);
assert.match(policySource, /agent-contracts-public-api\.js/,
  'Agent Session policy must depend on public Agent Contracts, not Workflow governance internals');
assert.throws(() => createAgentSessionPort({}), /must provide getSession\(\)/,
  'port construction must reject incomplete implementations');
const lifecycleImplementation = Object.fromEntries(['lockSession', 'updateRetryAttempt', 'terminateSessionsForTask']
  .map(method => [method, () => ({ changes: 1 })]));
const lifecycleParticipant = createAgentSessionLifecycleParticipant(lifecycleImplementation);
assert.equal(lifecycleParticipant.kind, 'agent-session-lifecycle-participant');
assert.equal(lifecycleParticipant.version, 1);
assert.equal(Object.isFrozen(lifecycleParticipant), true, 'internal lifecycle participant must be immutable');
assert.equal(Object.hasOwn(lifecycleParticipant, 'db'), false, 'lifecycle participant must not expose a DB handle');
assert.equal(Object.hasOwn(lifecycleParticipant, 'getSession'), false, 'lifecycle participant must not expose domain API methods');
assert.throws(() => createAgentSessionLifecycleParticipant({}), /must provide lockSession\(\)/,
  'participant construction must reject incomplete lifecycle implementations');
assert.throws(() => createAgentSessionApi(lifecycleParticipant), /must provide getSession\(\)/,
  'internal lifecycle participant must not be accepted as public domain API');
assert.throws(() => createAgentSessionApi({ version: AGENT_SESSION_API_VERSION + 1 }), /unsupported Agent Session API version/,
  'API construction must reject unsupported versions');

const isolatedCore = new WorkflowStoreCore(store.db);
assert.throws(() => isolatedCore.attachAgentSessionLifecycleParticipant({
  kind: 'agent-session-lifecycle-participant', version: 1, db: store.db,
  lockSession() {}, updateRetryAttempt() {}, terminateSessionsForTask() {}
}), /without a DB handle/, 'Workflow must reject lifecycle participants that expose persistence handles');
assert.throws(() => isolatedCore.attachAgentSessionLifecycleParticipant({
  kind: 'agent-session-lifecycle-participant', version: 1, lockSession() {}, updateRetryAttempt() {}
}), /must provide terminateSessionsForTask\(\)/, 'Workflow must reject incomplete lifecycle participants');
isolatedCore.attachAgentSessionLifecycleParticipant(lifecycleParticipant);
assert.throws(() => isolatedCore.attachAgentSessionLifecycleParticipant(lifecycleParticipant), /already attached/,
  'Workflow must not permit lifecycle participant replacement');

const isolatedDomainCore = new WorkflowStoreCore(store.db);
const domainPort = createAgentSessionPort(sessionStore);
assert.equal(Object.isFrozen(domainPort), true);
assert.equal(Object.hasOwn(domainPort, 'lockSession'), false);
assert.throws(() => isolatedDomainCore.attachAgentSessionDomainPort({
  version: 1, db: store.db, listActiveAgentSessionsForJob() {}, getSessionTraceForJob() {}
}), /without a DB handle/, 'Workflow must reject domain ports that expose persistence handles');
assert.throws(() => isolatedDomainCore.attachAgentSessionDomainPort({
  version: 1, listActiveAgentSessionsForJob() {}
}), /must provide getSessionTraceForJob\(\)/, 'Workflow must reject incomplete domain query ports');
isolatedDomainCore.attachAgentSessionDomainPort(domainPort);
assert.throws(() => isolatedDomainCore.attachAgentSessionDomainPort(domainPort), /already attached/,
  'Workflow must not permit domain port replacement');

const workflowPort = createWorkflowStatePort(store);
const deliveryHooks = Object.fromEntries(AGENT_SESSION_DELIVERY_HOOKS.map(method => [method, () => ({ changes: 1 })]));
assert.equal(Object.hasOwn(workflowPort, 'db'), false, 'Agent Session Workflow port must not expose the DB handle');
assert.equal(workflowPort.transaction, undefined, 'Agent Session Workflow port must not expose generic transactions');
assert.equal(workflowPort.assertSharedConnection(store.db), true,
  'the legitimate host composition must prove its exact shared SQLite connection');
const mismatchedDatabase = new DatabaseSync(':memory:');
try {
  assert.throws(() => new AgentSessionStore({ database: mismatchedDatabase, workflowPort, deliveryHooks }),
    /must share the WorkflowStatePort SQLite connection/,
    'AgentSessionStore must reject a DB handle different from the Workflow event/task owner connection');
} finally {
  mismatchedDatabase.close();
}
for (const method of AGENT_SESSION_DELIVERY_HOOKS) {
  const incompleteHooks = { ...deliveryHooks };
  delete incompleteHooks[method];
  assert.throws(() => new AgentSessionStore({ database: store.db, workflowPort, deliveryHooks: incompleteHooks }),
    new RegExp(`deliveryHooks\\.${method} must be a function`),
    `AgentSessionStore must fail closed when delivery hook ${method} is absent`);
}

store.db.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log('Agent Session API, host composition, Workflow port and compatibility facade boundary PASS');
