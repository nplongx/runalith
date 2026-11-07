import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm12-native-bridge-'));
process.env.WORKFLOW_DATA_DIR = dir;
process.env.WORKFLOW_DB = path.join(dir, 'workflow.db');

const { WorkflowStore } = await import('../job-store.js');
const { M12NativeSpecialistBridge } = await import('../src/runtime/m12-native-specialist-bridge.js');
const { createWorkflowStatePort } = await import('../src/runtime/workflow-state-port.js');
const store = new WorkflowStore();
const state = createWorkflowStatePort(store);
const job = store.createJob({ conversationKey: 'native-bridge-test', title: 'Native bridge' });
const task = store.ensureTask(job.job_id, { role: 'researcher', description: 'native task' });
const lease = store.acquireTaskLease(task.task_id, { leaseId: 'lease-native-bridge', workerId: 'runner', ttlMs: 120000, attempt: 1 });

let starts = 0;
let waits = 0;
let complete = false;
let malformedOutput = false;
const gateway = {
  role: 'node',
  scopes: [],
  async request(method, params) {
    if (method === 'm12.specialist.start') {
      starts++;
      assert.equal(params.taskId, task.task_id);
      assert.equal(params.leaseId, lease.lease_id);
      return {
        taskId: task.task_id, attempt: 1, role: 'researcher', inputCommit: 'abc123',
        environmentId: 'env-native', nodeId: 'node-native', ownerEpoch: lease.owner_epoch,
        leaseId: lease.lease_id, sessionKey: 'agent:m12-test:specialist:1',
        sessionId: 'native-session-real', runId: 'native-run-real',
      };
    }
    if (method === 'm12.specialist.wait') {
      waits++;
      assert.equal(params.runId, 'native-run-real');
      if (!complete) return { taskId: task.task_id, runId: params.runId, status: 'RUNNING' };
      if (malformedOutput) return { taskId: task.task_id, runId: params.runId, sessionId: 'native-session-real', status: 'SUCCEEDED', output: { text: 'not a string' } };
      return { taskId: task.task_id, runId: params.runId, sessionId: 'native-session-real', status: 'SUCCEEDED', output: 'native output' };
    }
    throw new Error(`unexpected Gateway method: ${method}`);
  },
};

const bridge = new M12NativeSpecialistBridge({ store, gateway });
const input = {
  taskId: task.task_id, attempt: 1, leaseId: lease.lease_id,
  environmentId: 'env-native', nodeId: 'node-native', ownerEpoch: lease.owner_epoch,
  inputCommit: 'abc123', role: 'researcher', prompt: 'Research the task',
  admissionIdempotencyKey: 'admission-native-1', timeoutMs: 1000,
};

await assert.rejects(() => new M12NativeSpecialistBridge({ store, gateway }).startOrResume({ ...input, ownerEpoch: '1' }),
  /ownerEpoch must be a positive safe integer/, 'native bridge must not coerce owner-epoch identity from a string');
await assert.rejects(() => new M12NativeSpecialistBridge({ store, gateway }).startOrResume({ ...input, ownerEpoch: lease.owner_epoch + 1 }),
  /owner epoch does not match the exact durable task lease/, 'native bridge must reject an owner epoch not bound to the lease');
await assert.rejects(() => new M12NativeSpecialistBridge({ store, gateway, now: () => Date.parse(lease.expires_at) }).startOrResume(input),
  /lease is expired or has malformed time identity/, 'native bridge must not use an expired lease');
await assert.rejects(() => new M12NativeSpecialistBridge({ store, gateway }).startOrResume({ ...input, timeoutMs: '1000' }),
  /timeoutMs must be a positive safe integer/, 'native bridge must not coerce a string timeout');
assert.equal(starts, 0, 'rejected preflight inputs must not invoke native specialist start');
assert.equal(waits, 0, 'rejected preflight inputs must not invoke native specialist wait');

const first = await bridge.startOrResume(input);
assert.equal(first.status, 'RUNNING');
assert.equal(starts, 1);
assert.equal(waits, 1);
assert.equal(store.getM12NativeSpecialistRuntime(task.task_id, 1).native_session_id, 'native-session-real');
const durableStartIntent = state.getM12NativeSpecialistStartIntent(task.task_id, 1);
assert.equal(durableStartIntent.state, 'STARTED');
const exactReattach = state.attachM12NativeSpecialistRuntime(task.task_id, {
  attempt: 1, sessionKey: 'agent:m12-test:specialist:1', nativeSessionId: 'native-session-real',
  runId: 'native-run-real', environmentId: 'env-native', nodeId: 'node-native',
  leaseId: lease.lease_id, ownerEpoch: lease.owner_epoch,
  admissionIdempotencyKey: 'admission-native-1', startRequestSha256: durableStartIntent.request_sha256,
  startClaimId: durableStartIntent.start_claim_id
});
assert.equal(exactReattach.run_id, 'native-run-real', 'exact repeated native attachment must remain idempotent after STARTED intent');

complete = true;
malformedOutput = true;
await assert.rejects(() => new M12NativeSpecialistBridge({ store, gateway }).startOrResume(input),
  /terminal result output must be a string/, 'native bridge must reject structured output instead of coercing it');
assert.equal(store.getM12NativeSpecialistRuntime(task.task_id, 1).state, 'ACTIVE',
  'malformed terminal output must not complete the persisted runtime');
assert.equal(store.getTaskLease(lease.lease_id).state, 'ACTIVE', 'malformed terminal output must not complete the task lease');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(task.task_id).n, 0,
  'malformed native receipt must not create a result');
malformedOutput = false;
const recovered = await new M12NativeSpecialistBridge({ store, gateway }).startOrResume(input);
assert.equal(recovered.status, 'COMPLETED');
assert.equal(recovered.resumed, true);
assert.equal(starts, 1, 'recovery must not create a replacement native run');
assert.equal(waits, 3);
assert.equal(store.getTask(task.task_id).status, 'completed');
assert.equal(store.getTaskLease(lease.lease_id).state, 'COMPLETED');

assert.throws(() => new M12NativeSpecialistBridge({ store, gateway: { ...gateway, role: 'operator', scopes: ['operator.admin'] } }), /node-role Gateway client/);
const mismatches = [
  { taskId: 'different-task', attempt: 1 },
  { taskId: null, attempt: 2 }
];
for (let index = 0; index < mismatches.length; index++) {
  const mismatchJob = store.createJob({ conversationKey: `native-bridge-response-identity-${index}`, title: 'Reject mismatched Gateway response identity' });
  const mismatchTask = store.ensureTask(mismatchJob.job_id, { role: 'researcher', description: 'response identity fence' });
  const mismatchLease = store.acquireTaskLease(mismatchTask.task_id, {
    leaseId: `lease-native-bridge-response-identity-${index}`, workerId: 'runner-response-identity', ttlMs: 120000, attempt: 1
  });
  const mismatched = index === 0 ? mismatches[index] : { taskId: mismatchTask.task_id, attempt: mismatches[index].attempt };
  const mismatchedGateway = {
    role: 'node', scopes: [],
    async request(method) {
      assert.equal(method, 'm12.specialist.start');
      return {
        ...mismatched,
        environmentId: 'env-native', nodeId: 'node-native', ownerEpoch: mismatchLease.owner_epoch,
        leaseId: mismatchLease.lease_id, sessionKey: 'agent:m12-test:wrong-identity',
        sessionId: 'native-session-wrong-identity', runId: 'native-run-wrong-identity'
      };
    }
  };
  await assert.rejects(() => new M12NativeSpecialistBridge({ store, gateway: mismatchedGateway }).startOrResume({
    ...input, taskId: mismatchTask.task_id, leaseId: mismatchLease.lease_id,
    attempt: 1, ownerEpoch: mismatchLease.owner_epoch, admissionIdempotencyKey: `admission-native-mismatch-${index}`
  }), /Gateway native identity binding mismatch: (taskId|attempt)/,
  'Gateway start response must bind exact task and attempt before durable attachment');
  assert.equal(store.getM12NativeSpecialistRuntime(mismatchTask.task_id, 1), null,
    'mismatched Gateway task/attempt identity must never be attached to the durable task');
}
const lateAttachJob = store.createJob({ conversationKey: 'native-bridge-late-attach', title: 'Reject expired lease after Gateway start' });
const lateAttachTask = store.ensureTask(lateAttachJob.job_id, { role: 'researcher', description: 'late attach fence' });
const lateAttachLease = store.acquireTaskLease(lateAttachTask.task_id, {
  leaseId: 'lease-native-bridge-late-attach', workerId: 'runner-late-attach', ttlMs: 120000, attempt: 1
});
const lateAttachGateway = {
  role: 'node', scopes: [],
  async request(method) {
    assert.equal(method, 'm12.specialist.start');
    store.db.prepare('UPDATE task_leases SET expires_at=? WHERE lease_id=?')
      .run(new Date(Date.now() - 1000).toISOString(), lateAttachLease.lease_id);
    return {
      taskId: lateAttachTask.task_id, attempt: 1,
      environmentId: 'env-native', nodeId: 'node-native', ownerEpoch: lateAttachLease.owner_epoch,
      leaseId: lateAttachLease.lease_id, sessionKey: 'agent:m12-test:late-attach',
      sessionId: 'native-session-late-attach', runId: 'native-run-late-attach'
    };
  }
};
await assert.rejects(() => new M12NativeSpecialistBridge({ store, gateway: lateAttachGateway }).startOrResume({
  ...input, taskId: lateAttachTask.task_id, leaseId: lateAttachLease.lease_id,
  attempt: 1, ownerEpoch: lateAttachLease.owner_epoch, admissionIdempotencyKey: 'admission-native-late-attach'
}), /unexpired lease and live running parent\/task/,
'a lease that expires during the Gateway start round-trip must not accept the returned remote identity');
assert.equal(store.getM12NativeSpecialistRuntime(lateAttachTask.task_id, 1), null,
  'late remote attachment after lease expiry must not be persisted');
const unknownStartJob = store.createJob({ conversationKey: 'native-bridge-unknown-start', title: 'Quarantine unknown Gateway start outcome' });
const unknownStartTask = store.ensureTask(unknownStartJob.job_id, { role: 'researcher', description: 'unknown start outcome' });
const unknownStartLease = store.acquireTaskLease(unknownStartTask.task_id, {
  leaseId: 'lease-native-bridge-unknown-start', workerId: 'runner-unknown-start', ttlMs: 120000, attempt: 1
});
let unknownStartCalls = 0;
const unknownStartGateway = {
  role: 'node', scopes: [],
  async request(method) {
    assert.equal(method, 'm12.specialist.start');
    unknownStartCalls++;
    throw new Error('Gateway response lost after request handoff; remote outcome unknown');
  }
};
const unknownStartInput = {
  ...input, taskId: unknownStartTask.task_id, leaseId: unknownStartLease.lease_id,
  attempt: 1, ownerEpoch: unknownStartLease.owner_epoch, admissionIdempotencyKey: 'admission-native-unknown-start'
};
await assert.rejects(() => new M12NativeSpecialistBridge({ store, gateway: unknownStartGateway }).startOrResume(unknownStartInput),
  /remote outcome unknown/);
await assert.rejects(() => new M12NativeSpecialistBridge({ store, gateway: unknownStartGateway }).startOrResume(unknownStartInput),
  /M12_START_OUTCOME_UNKNOWN_REQUIRES_RECONCILIATION/,
'a retry after an ambiguous native-start result must not issue a duplicate Gateway RPC');
assert.equal(unknownStartCalls, 1, 'the durable STARTING intent permits only one potentially side-effecting RPC');
assert.equal(state.hasUnresolvedDurableExecution(unknownStartJob.job_id), true,
  'a pending native start intent blocks stale Job terminalization');
store.db.prepare('UPDATE task_leases SET expires_at=? WHERE lease_id=?')
  .run(new Date(Date.now() - 1000).toISOString(), unknownStartLease.lease_id);
const unknownStartQuarantine = store.expireTaskLease(unknownStartLease.lease_id, { reason: 'native start outcome unknown' });
assert.equal(unknownStartQuarantine.state, 'FAILED');
assert.match(unknownStartQuarantine.last_error, /^REMOTE_EFFECT_UNCERTAIN_REQUIRES_RECONCILIATION:/,
  'lease reaper must quarantine a possibly accepted M12 start without attached runtime IDs');
const terminalJob = store.createJob({ conversationKey: 'native-bridge-terminal-parent', title: 'Reject terminal parent job' });
const terminalTask = store.ensureTask(terminalJob.job_id, { role: 'researcher', description: 'must not start after parent terminalization' });
const terminalLease = store.acquireTaskLease(terminalTask.task_id, {
  leaseId: 'lease-native-bridge-terminal', workerId: 'runner-terminal', ttlMs: 120000, attempt: 1
});
store.transition(terminalJob.job_id, 'COMPLETED', 'completed');
await assert.rejects(() => new M12NativeSpecialistBridge({ store, gateway }).startOrResume({
  ...input, taskId: terminalTask.task_id, leaseId: terminalLease.lease_id, attempt: 1, ownerEpoch: terminalLease.owner_epoch
}), /live non-terminal parent job/, 'native bridge must fail closed after parent job terminalization');
assert.equal(starts, 1, 'terminal parent job must not trigger a remote native start');
assert.equal(store.getTaskLease(terminalLease.lease_id).state, 'ACTIVE', 'rejected terminal-parent start must not mutate lease state');
const ambiguousJob = store.createJob({ conversationKey: 'native-bridge-ambiguous-lease', title: 'Reject ambiguous lease runtime mapping' });
const ambiguousTask = store.ensureTask(ambiguousJob.job_id, { role: 'researcher', description: 'must not start a second native turn' });
const ambiguousLease = store.acquireTaskLease(ambiguousTask.task_id, {
  leaseId: 'lease-native-bridge-ambiguous', workerId: 'runner-ambiguous', ttlMs: 120000, attempt: 1
});
store.attachM12NativeSpecialistRuntime(ambiguousTask.task_id, {
  attempt: 1, sessionKey: 'agent:m12-test:ambiguous:1', nativeSessionId: 'native-bridge-ambiguous-session-1',
  runId: 'native-bridge-ambiguous-run-1', environmentId: 'env-native', nodeId: 'node-native',
  leaseId: ambiguousLease.lease_id, ownerEpoch: ambiguousLease.owner_epoch,
});
store.db.prepare(`INSERT INTO m12_native_specialist_runtime
  (task_id,attempt,session_key,native_session_id,run_id,environment_id,node_id,lease_id,owner_epoch,state,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,'ACTIVE',?,?)`).run(
    ambiguousTask.task_id, 2, 'agent:m12-test:ambiguous:2', 'native-bridge-ambiguous-session-2',
    'native-bridge-ambiguous-run-2', 'env-native', 'node-native', ambiguousLease.lease_id,
    ambiguousLease.owner_epoch, new Date().toISOString(), new Date().toISOString()
  );
await assert.rejects(() => new M12NativeSpecialistBridge({ store, gateway }).startOrResume({
  ...input, taskId: ambiguousTask.task_id, leaseId: ambiguousLease.lease_id, attempt: 1, ownerEpoch: ambiguousLease.owner_epoch,
}), /ambiguous or mismatched durable runtime/, 'ambiguous reverse mapping must be rejected before Gateway start/wait');
assert.equal(starts, 1, 'ambiguous runtime mapping must not cross the remote start boundary');
assert.equal(waits, 3, 'ambiguous runtime mapping must not call remote wait');
assert.equal(store.getTaskLease(ambiguousLease.lease_id).state, 'ACTIVE', 'preflight rejection must preserve lease state');
console.log('M12 NATIVE SPECIALIST BRIDGE PASS');
store.close?.();
for (const file of [path.join(dir, 'workflow.db'), path.join(dir, 'workflow.db-wal'), path.join(dir, 'workflow.db-shm')]) fs.rmSync(file, { force: true });
