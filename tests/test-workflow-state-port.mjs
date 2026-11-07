import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-state-port-unit-'));
process.env.WORKFLOW_DB = path.join(dataDir, 'workflow.db');
process.env.WORKFLOW_DATA_DIR = dataDir;
const { WorkflowStatePort, WORKFLOW_STATE_PORT_VERSION, createWorkflowStatePort } = await import('../src/runtime/workflow-state-port.js');

const calls = [];
const tables = new Set(['provider_runs', 'provider_dispatch_intents']);
const lease = { lease_id: 'lease-1', task_id: 'task-1', job_id: 'job-1', state: 'ACTIVE' };
const childTask = { task_id: 'child-1', job_id: 'job-1', parent_task_id: 'parent-1', role: 'architect' };
const providerRun = { provider_run_id: 'run-1', lease_id: 'lease-1' };
const dispatchIntent = { dispatch_key: 'dispatch-1', lease_id: 'lease-1' };
const db = {
  prepare(sql) {
    return {
      get(...args) {
        calls.push({ kind: 'get', sql, args });
        if (sql.includes('COUNT(*) AS n')) return { n: 2 };
        if (sql.includes('FROM task_leases')) return lease;
        if (sql.includes('FROM tasks') && sql.includes('parent_task_id')) return childTask;
        if (sql.includes("sqlite_master") && sql.includes("name='provider_runs'")) return { present: 1 };
        if (sql.includes('FROM provider_runs')) return providerRun;
        if (sql.includes('FROM jobs WHERE job_id = ?')) return { job_id: args[0], state: 'EXECUTING' };
        throw new Error(`unexpected get query: ${sql}`);
      },
      all(...args) {
        calls.push({ kind: 'all', sql, args });
        if (sql.includes('json_extract(payload_json,?)')) {
          return [{ event_id: 'event-1', job_id: 'job-1', type: 'job.proposal_requested', payload_json: '{"adaptive_goal_plan_proposal":{"fingerprint":"abc"}}', created_at: '2026-10-31T00:00:00.000Z' }];
        }
        if (sql.includes("sqlite_master") && sql.includes('provider_dispatch_intents')) {
          return [...tables].map(name => ({ name }));
        }
        if (sql.includes('FROM provider_runs')) return [providerRun];
        if (sql.includes('FROM provider_dispatch_intents')) return [dispatchIntent];
        if (sql.includes('FROM tasks WHERE job_id=?')) return [{ task_id: 'task-1', job_id: args[0] }];
        throw new Error(`unexpected all query: ${sql}`);
      },
      run(...args) {
        calls.push({ kind: 'run', sql, args });
        return { changes: 1 };
      }
    };
  },
  exec() {}
};

const delegated = new Map();
const store = {
  db,
  ...Object.fromEntries([
    'acquireTaskLease', 'heartbeatTaskLease', 'completeTaskLease', 'expireTaskLease',
    'reapExpiredTaskLeases', 'getTaskLease', 'listTaskLeases', 'listRunnableTasks', 'getTask', 'getJob', 'getArtifact',
    'getExecutionPlan', 'getCurrentProposal', 'getLatestApproval', 'assertApprovalCurrent', 'compileExecutionPlan',
    'hasExecutionAttemptHistory', 'hasExecutionBatchItemHistory', 'getExecutionBatch', 'verifyCompletedExecutionBatch',
    'listExecutionBatchItems', 'cancelExecutionBatch', 'prepareExecutionBatchRetry', 'recoverTerminalExecutionBatchItemFromTask',
    'markExecutionBatchItemRunning', 'finishExecutionBatchItem', 'markExecutionBatchWaiting', 'finishExecutionBatch',
    'recoverUnstartedExecutionBatchClaims', 'prepareExecution', 'prepareExecutionForBatchClaim', 'setExecutionPid', 'finishExecution',
    'reconcileRunningTaskForTerminalJob', 'completeTaskByRuntime', 'repairResultEvidence', 'reconcileFailedTaskByRuntime',
    'setProviderWaiting', 'clearProviderWaiting', 'createReport', 'claimDelivery', 'terminalizeJob'
  ].map(name => [name, (...args) => {
    delegated.set(name, args);
    return { method: name, args };
  }]))
};

const port = createWorkflowStatePort(store);
assert.ok(port instanceof WorkflowStatePort);
assert.equal(port.version, WORKFLOW_STATE_PORT_VERSION);
assert.equal(createWorkflowStatePort(port), port, 'port construction must be idempotent');
assert.equal(Object.hasOwn(port, 'db'), false, 'the port must not expose a mutable DB handle');
assert.equal(Object.keys(port).length, 0, 'the wrapped store must remain private');

assert.deepEqual(port.getTask('task-1'), { method: 'getTask', args: ['task-1'] });
assert.equal(port.getLatestChildTaskForRole('job-1', 'parent-1', 'architect'), childTask,
  'provider admission must resolve child task state through a named Workflow query');
assert.match(calls.at(-1).sql, /ORDER BY created_at DESC, rowid DESC LIMIT 1/);
assert.deepEqual(calls.at(-1).args, ['job-1', 'parent-1', 'architect']);
assert.deepEqual(port.getJob('job-1'), { method: 'getJob', args: ['job-1'] });
assert.deepEqual(port.getArtifact('artifact-1'), { method: 'getArtifact', args: ['artifact-1'] });
assert.deepEqual(port.getRecoveryJobSnapshot('job-1'), {
  job: { method: 'getJob', args: ['job-1'] }, tasks: [{ task_id: 'task-1', job_id: 'job-1' }]
});
assert.deepEqual(port.getTaskLease('lease-1'), { method: 'getTaskLease', args: ['lease-1'] });
assert.equal(port.getActiveTaskLease('task-1'), lease);
assert.equal(port.countActiveTaskLeases(), 2);
assert.deepEqual(port.getDispatchLedgerForLease('lease-1'), {
  providerRuns: [providerRun], dispatchIntents: [dispatchIntent]
});
assert.equal(port.getProviderRun('run-1'), providerRun);
const nestedProposalEvents = port.findEventsByTypePayload(
  'job.proposal_requested', 'adaptive_goal_plan_proposal.fingerprint', 'abc'
);
assert.equal(nestedProposalEvents.length, 1, 'nested proposal fingerprint query must return exact event rows');
assert.equal(calls.at(-1).args[1], '$.adaptive_goal_plan_proposal.fingerprint',
  'nested JSON path is bound as a value rather than interpolated into SQL');
assert.throws(() => port.findEventsByTypePayload('job.proposal_requested', 'fingerprint) OR 1=1 --', 'abc'),
  /bounded dotted JSON property path/);

const operationArgs = { workerId: 'worker-1', ttlMs: 5000 };
for (const [method, invoke] of [
  ['acquireTaskLease', () => port.acquireTaskLease('task-1', operationArgs)],
  ['heartbeatTaskLease', () => port.heartbeatTaskLease('lease-1', operationArgs)],
  ['completeTaskLease', () => port.completeTaskLease('lease-1', operationArgs)],
  ['expireTaskLease', () => port.expireTaskLease('lease-1', { reason: 'test' })],
  ['reapExpiredTaskLeases', () => port.reapExpiredTaskLeases({ jobId: 'job-1' })],
  ['listTaskLeases', () => port.listTaskLeases({ taskId: 'task-1' })],
  ['listRunnableTasks', () => port.listRunnableTasks({ limit: 10 })],
  ['getExecutionPlan', () => port.getExecutionPlan('job-1')],
  ['getCurrentProposal', () => port.getCurrentProposal('job-1')],
  ['getLatestApproval', () => port.getLatestApproval('job-1')],
  ['compileExecutionPlan', () => port.compileExecutionPlan('job-1', { workspace: '/tmp/workspace' })],
  ['getExecutionBatch', () => port.getExecutionBatch('batch-1')],
  ['listExecutionBatchItems', () => port.listExecutionBatchItems('batch-1')],
  ['prepareExecution', () => port.prepareExecution('task-1', { executionSessionId: 'exec-1' })],
  ['prepareExecutionForBatchClaim', () => port.prepareExecutionForBatchClaim('task-1', { executionSessionId: 'exec-1' }, { batchId: 'batch-1' })],
  ['setExecutionPid', () => port.setExecutionPid('task-1', 42, { executionSessionId: 'exec-1', attempt: 1 })],
  ['finishExecution', () => port.finishExecution('task-1', { executionSessionId: 'exec-1', attempt: 1 })]
  ,['reconcileRunningTaskForTerminalJob', () => port.reconcileRunningTaskForTerminalJob('task-1', 'terminal')]
  ,['completeTaskByRuntime', () => port.completeTaskByRuntime('job-1', { outcome: 'success' })]
  ,['repairResultEvidence', () => port.repairResultEvidence('task-1', 'evidence', { outcome: 'success' })]
  ,['reconcileFailedTaskByRuntime', () => port.reconcileFailedTaskByRuntime('task-1', { content: 'evidence' })]
  ,['setProviderWaiting', () => port.setProviderWaiting('job-1', 100, 'reason')]
  ,['clearProviderWaiting', () => port.clearProviderWaiting('job-1')]
  ,['createReport', () => port.createReport('job-1', 'summary', 'content')]
  ,['claimDelivery', () => port.claimDelivery('job-1', 'report-1', 'slack', 'target')]
  ,['terminalizeJob', () => port.terminalizeJob('job-1', { outcome: 'success' })]
]) {
  const result = invoke();
  assert.equal(result.method, method);
  assert.equal(delegated.has(method), true);
}

assert.equal(port.clearTaskLeaseError('lease-1').changes, 1);
assert.equal(calls.some(call => call.kind === 'run' && call.sql.includes("last_error=NULL") &&
  call.sql.includes("state='ACTIVE'") && call.args[0] === 'lease-1'), true,
  'late dispatch outcome must not erase a FAILED lease quarantine marker');
assert.throws(() => port.getTask(''), /taskId must be a non-empty string/);
assert.throws(() => port.getLatestChildTaskForRole('', 'parent-1', 'architect'), /jobId must be a non-empty string/);
assert.throws(() => port.getLatestChildTaskForRole('job-1', '', 'architect'), /parentTaskId must be a non-empty string/);
assert.throws(() => port.getLatestChildTaskForRole('job-1', 'parent-1', ''), /role must be a non-empty string/);
assert.throws(() => port.getTaskLease(null), /leaseId must be a non-empty string/);
assert.throws(() => port.finishExecution('', {}), /taskId must be a non-empty string/);

assert.throws(() => new WorkflowStatePort({ db: {} }), /query-capable database/);

console.log('workflow-state-port contract PASS');
fs.rmSync(dataDir, { recursive: true, force: true });
