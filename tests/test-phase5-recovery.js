import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';

const dir = tempDir('cos-phase5-');
process.env.WORKFLOW_DB = path.join(dir, 'workflow.db');
process.env.WORKFLOW_DATA_DIR = dir;

const { WorkflowStore } = await import('../src/runtime/job-store.js');
const { RecoveryManager } = await import('../src/runtime/recovery-manager.js');

const store = new WorkflowStore();
const job = store.createJob({ conversationKey: 'phase5-recovery', title: 'Phase 5 recovery' });
store.transition(job.job_id, 'PROPOSED');
store.approve(job.job_id, 'Duyệt');
const cto = store.dispatch(job.job_id, { role: 'cto', description: 'recover same task' });
store.startAttempt(job.job_id);
const dispatchEventCount = () => store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='task.dispatched'").get(job.job_id).n;
assert.equal(dispatchEventCount(), 1);
const dispatchRetry = store.dispatch(job.job_id, { role: 'cto', description: 'recover same task' });
assert.equal(dispatchRetry.task_id, cto.task_id, 'a response-loss retry returns the exact active task');
assert.equal(dispatchEventCount(), 1, 'idempotent dispatch retry must not append a duplicate dispatch event');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(cto.task_id).n, 1,
  'idempotent dispatch retry must preserve exactly one started attempt');
assert.throws(() => store.dispatch(job.job_id, { role: 'cto', description: 'different payload must not alias original dispatch' }),
  /dispatch lifecycle is uncertain.*refusing retry/,
  'a retry with changed request payload must not be mistaken for the original durable dispatch');
assert.equal(dispatchEventCount(), 1, 'mismatched retry must not append dispatch events');
store.attachOpenClawRun(job.job_id, { runId: 'cto-run-phase5', sessionKey: 'agent:cto:subagent:phase5' });
const session = store.getSessionByTask(cto.task_id);

// Heartbeat-age reconciliation must mark only the registered session stale.
store.db.prepare("UPDATE agent_sessions SET last_activity_at = ? WHERE session_id = ?")
  .run(new Date(Date.now() - 10 * 60_000).toISOString(), session.session_id);
const recovery = new RecoveryManager(store, { sessionStaleMs: 60_000, executionStaleMs: 60_000, listSessions: async () => [] });
const report = await recovery.reconcile({ jobId: job.job_id });
assert.equal(report.staleSessions.length, 1);
assert.equal(store.getSession(session.session_id).state, 'STALE');

// Takeover must be explicitly granted; no implicit takeover.
assert.throws(() => store.beginAgentRetry(cto.task_id, { actorRole: 'architect' }), /Session access denied/);
store.grantSessionAccess(session.session_id, { accessorRole: 'architect', permission: 'TAKEOVER', grantedBy: 'cto' });
const prepared = store.beginAgentRetry(cto.task_id, { actorRole: 'architect', reason: 'phase5 test' });
assert.equal(prepared.task.task_id, cto.task_id);
assert.equal(prepared.session.session_id, session.session_id);
assert.equal(prepared.session.state, 'ACTIVE');
assert.equal(prepared.attempt, 2);
assert.equal(store.getTask(cto.task_id).status, 'running');
assert.equal(store.db.prepare("SELECT COUNT(*) n FROM attempts WHERE task_id=? AND status='started'").get(cto.task_id).n, 1,
  'same-task retry must settle the stale attempt before creating the new live attempt');
assert.equal(store.db.prepare("SELECT COUNT(*) n FROM tasks WHERE job_id = ? AND task_id = ?").get(job.job_id, cto.task_id).n, 1);
assert.ok(store.getJobTrace(job.job_id).events.some(e => e.type === 'task.retry_started'));

const uncertainDispatchJob = store.createJob({ conversationKey: 'phase5-dispatch-uncertain', title: 'Uncertain dispatch lineage' });
store.transition(uncertainDispatchJob.job_id, 'PROPOSED');
store.approve(uncertainDispatchJob.job_id, 'isolated uncertain-dispatch fixture');
const uncertainTask = store.dispatch(uncertainDispatchJob.job_id, { role: 'cto', description: 'simulated crash before attempt creation' });
store.startAttempt(uncertainDispatchJob.job_id);
store.db.prepare("DELETE FROM attempts WHERE task_id=? AND status='started'").run(uncertainTask.task_id);
const uncertainEventCount = store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='task.dispatched'")
  .get(uncertainDispatchJob.job_id).n;
assert.throws(() => store.dispatch(uncertainDispatchJob.job_id, { role: 'cto', description: 'must fail closed' }),
  /dispatch lifecycle is uncertain.*refusing retry/,
  'an executing task without exact active-attempt lineage must not be silently retried');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='task.dispatched'")
  .get(uncertainDispatchJob.job_id).n, uncertainEventCount, 'uncertain retry must not create a second dispatch event');

// Deterministic execution recovery uses the same durable task, with a new execution attempt.
const execTask = store.createChildTask(job.job_id, {
  parentTaskId: cto.task_id,
  role: 'qa',
  description: 'Run the exact command immediately: node --check /home/long/work/chatgpt-adapter/server.js.',
  metadata: { deterministic: true, command: 'node --check /home/long/work/chatgpt-adapter/server.js' }
});
const staleExecutionBatch = store.createExecutionBatch(job.job_id, {
  parentTaskId: cto.task_id,
  role: 'qa',
  items: [{ taskId: execTask.task_id, command: 'node --check /home/long/work/chatgpt-adapter/server.js', timeout_ms: 5000 }]
});
const staleBatchItem = store.listExecutionBatchItems(staleExecutionBatch.batch_id)[0];
assert.ok(store.markExecutionBatchItemRunning(staleExecutionBatch.batch_id, staleBatchItem.item_id, { expectedAttempt: 1 }));
const started = new Date(Date.now() - 10 * 60_000).toISOString();
store.prepareExecution(execTask.task_id, {
  executionSessionId: 'exec_stale_phase5',
  attempt: 1,
  command: 'node --check /home/long/work/chatgpt-adapter/server.js',
  cwd: '/home/long/work/chatgpt-adapter',
  startedAt: started,
  tmuxName: 'cos-exec-missing-phase5'
});
const execReport = await recovery.reconcile({ jobId: job.job_id });
assert.ok(execReport.staleExecutions.some(t => t.task_id === execTask.task_id));
const terminalizedStale = store.getTask(execTask.task_id);
assert.equal(terminalizedStale.execution_status, 'failed',
  'stale recovery must use the canonical terminal state instead of leaving an unrecognized execution_status');
assert.equal(terminalizedStale.status, 'failed');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(execTask.task_id).n, 0,
  'stale recovery must settle the exact durable attempt, or the retry precondition will remain permanently blocked');
assert.equal(store.getExecutionBatch(staleExecutionBatch.batch_id).status, 'FAILED',
  'recovering the only stale running batch item must atomically terminalize the orphaned batch');
const recoveredStaleBatchItem = store.listExecutionBatchItems(staleExecutionBatch.batch_id)[0];
assert.equal(recoveredStaleBatchItem.status, 'FAILED');
assert.equal(recoveredStaleBatchItem.attempt, 1);
assert.match(recoveredStaleBatchItem.error, /supervisor\/session missing/);
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.failed' AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.attempt')=1")
  .get(job.job_id, execTask.task_id).n, 1, 'stale recovery must create one canonical attempt-terminal event');
const retryPrepared = store.prepareExecution(execTask.task_id, {
  executionSessionId: 'exec_retry_after_stale_phase5',
  attempt: 2,
  command: 'node --check /home/long/work/chatgpt-adapter/server.js',
  cwd: '/home/long/work/chatgpt-adapter',
  tmuxName: 'cos-exec-retry-after-stale-phase5'
});
assert.equal(retryPrepared.execution_status, 'running', 'the same durable task must accept a monotonic retry after stale-attempt recovery');
assert.equal(Number(retryPrepared.execution_attempt), 2);
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(execTask.task_id).n, 1,
  'only the retry attempt should remain open after recovery settles attempt 1');
const retryBatch = store.prepareExecutionBatchRetry(staleExecutionBatch.batch_id);
assert.equal(retryBatch.status, 'RUNNING');
assert.equal(retryBatch.attempt, 2);
const retryBatchItem = store.listExecutionBatchItems(staleExecutionBatch.batch_id)[0];
assert.equal(retryBatchItem.status, 'PENDING');
assert.equal(retryBatchItem.attempt, 2, 'the recovered batch must expose a new monotonic item attempt');

// The stale-attempt reaper must not settle one row from a corrupt task that has
// multiple active attempts, because that could terminalize the task while a
// different attempt still owns the runtime.
const ambiguousJob = store.createJob({ conversationKey: `phase5-ambiguous-stale-${process.pid}`, title: 'Ambiguous stale attempt lineage' });
const ambiguousTask = store.ensureTask(ambiguousJob.job_id, { role: 'qa', description: 'fail closed on multiple started attempts' });
const staleStartedAt = new Date(Date.now() - 10 * 60_000).toISOString();
store.db.prepare("UPDATE tasks SET status='running' WHERE task_id=?").run(ambiguousTask.task_id);
store.db.prepare("INSERT INTO attempts(attempt_id,task_id,status,openclaw_run_id,started_at) VALUES(?,?,'started',NULL,?)")
  .run(`phase5-ambiguous-a-${process.pid}`, ambiguousTask.task_id, staleStartedAt);
store.db.prepare("INSERT INTO attempts(attempt_id,task_id,status,openclaw_run_id,started_at) VALUES(?,?,'started',NULL,?)")
  .run(`phase5-ambiguous-b-${process.pid}`, ambiguousTask.task_id, staleStartedAt);
assert.throws(() => store.reconcileStaleAttempts(60_000), /ambiguous active-attempt lineage/);
assert.throws(() => store.completeActiveAttempt(ambiguousTask.task_id, { reason: 'must not choose one corrupt attempt' }), /ambiguous active-attempt ledger/);
assert.equal(store.getTask(ambiguousTask.task_id).status, 'running');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(ambiguousTask.task_id).n, 2);
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='attempt.timeout' AND json_extract(payload_json,'$.taskId')=?")
  .get(ambiguousJob.job_id, ambiguousTask.task_id).n, 0);
console.log('PASS: stale-attempt reconciliation rejects duplicate active attempts without partial terminalization');
// Remove only this intentionally corrupt, disposable fixture after its invariant
// has been asserted so it cannot prevent independent stale-owner scenarios from
// reaching their own candidate rows.
store.db.prepare('DELETE FROM attempts WHERE task_id=?').run(ambiguousTask.task_id);

// A stale timestamp is not proof of worker death. Keep a stale attempt open
// when it still has an ACTIVE lease, even if the lease is nearing expiry.
const leasedLiveJob = store.createJob({ conversationKey: `phase5-live-lease-${process.pid}`, title: 'Stale reaper must respect active lease' });
store.transition(leasedLiveJob.job_id, 'EXECUTING');
const leasedLiveTask = store.ensureTask(leasedLiveJob.job_id, { role: 'qa', description: 'active lease owns this stale attempt' });
const leasedLive = store.acquireTaskLease(leasedLiveTask.task_id, {
  leaseId: `phase5-live-lease-${process.pid}`, workerId: 'live-worker', ttlMs: 60_000
});
const oldAttemptStart = new Date(Date.now() - 10 * 60_000).toISOString();
const leasedAttemptId = `phase5-live-lease-attempt-${process.pid}`;
store.db.prepare("INSERT INTO attempts(attempt_id,task_id,status,openclaw_run_id,started_at) VALUES(?,?,'started',NULL,?)")
  .run(leasedAttemptId, leasedLiveTask.task_id, oldAttemptStart);
store.db.prepare("UPDATE task_leases SET expires_at=? WHERE lease_id=? AND state='ACTIVE'")
  .run(new Date(Date.now() + 30_000).toISOString(), leasedLive.lease_id);

// Even without a lease row, a running local execution session is an unresolved
// owner. The generic stale-attempt reaper must not make the task terminal while
// that session may still call finishExecution with its durable attempt ID.
const sessionLiveJob = store.createJob({ conversationKey: `phase5-live-session-${process.pid}`, title: 'Stale reaper must respect live execution session' });
store.transition(sessionLiveJob.job_id, 'EXECUTING');
const sessionLiveTask = store.ensureTask(sessionLiveJob.job_id, { role: 'qa', description: 'live session owns this stale attempt' });
const sessionLiveId = `phase5-live-session-${process.pid}`;
const sessionAttemptId = `phase5-live-session-attempt-${process.pid}`;
store.db.prepare("UPDATE tasks SET status='running',execution_status='running',execution_session_id=?,execution_attempt=1,execution_pid=? WHERE task_id=?")
  .run(sessionLiveId, process.pid, sessionLiveTask.task_id);
store.db.prepare("INSERT INTO attempts(attempt_id,task_id,status,openclaw_run_id,started_at) VALUES(?,?,'started',NULL,?)")
  .run(sessionAttemptId, sessionLiveTask.task_id, oldAttemptStart);
const stillRunningCandidates = store.reconcileStaleAttempts(60_000);
assert.ok(stillRunningCandidates >= 2, 'both intentionally stale attempts must have entered the diagnostic candidate set');
for (const [taskId, attemptId] of [[leasedLiveTask.task_id, leasedAttemptId], [sessionLiveTask.task_id, sessionAttemptId]]) {
  assert.equal(store.db.prepare('SELECT status FROM attempts WHERE attempt_id=?').get(attemptId).status, 'started',
    'reaper must preserve durable attempt while runtime/lease ownership is unresolved');
  assert.equal(store.getTask(taskId).status, 'running', 'reaper must not terminalize task with unresolved owner');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=(SELECT job_id FROM tasks WHERE task_id=?) AND type='attempt.timeout' AND json_extract(payload_json,'$.attemptId')=?")
    .get(taskId, attemptId).n, 0, 'reaper must not write timeout evidence without owner reconciliation');
}
assert.equal(store.getTask(sessionLiveTask.task_id).execution_status, 'running');
assert.equal(store.getJob(sessionLiveJob.job_id).status, 'active');
console.log('PASS: stale-attempt reconciliation defers active leases and live execution sessions');

// A quarantined lease remains evidence of an unresolved remote effect even if
// task execution metadata says "failed" and no provider-intent/run row exists.
// This reproduces a legacy-provider/crash window that the old reaper treated
// as an ordinary stale attempt and converted to timeout.
const quarantinedJob = store.createJob({ conversationKey: `phase5-quarantined-lease-${process.pid}`, title: 'Stale reaper must respect quarantined lease' });
store.transition(quarantinedJob.job_id, 'EXECUTING');
const quarantinedTask = store.ensureTask(quarantinedJob.job_id, { role: 'qa', description: 'uncertain remote effect requires owner reconciliation' });
const quarantinedLease = store.acquireTaskLease(quarantinedTask.task_id, {
  leaseId: `phase5-quarantined-lease-${process.pid}`, workerId: 'uncertain-provider-worker', ttlMs: 60_000
});
const quarantinedAttemptId = `phase5-quarantined-attempt-${process.pid}`;
store.db.prepare("INSERT INTO attempts(attempt_id,task_id,status,openclaw_run_id,started_at) VALUES(?,?,'started',NULL,?)")
  .run(quarantinedAttemptId, quarantinedTask.task_id, oldAttemptStart);
store.db.prepare("UPDATE tasks SET status='running',execution_status='failed',execution_finished_at=?,updated_at=? WHERE task_id=?")
  .run(oldAttemptStart, oldAttemptStart, quarantinedTask.task_id);
store.db.prepare("UPDATE task_leases SET state='FAILED',released_at=?,last_error=? WHERE lease_id=?")
  .run(oldAttemptStart, 'REMOTE_EFFECT_UNCERTAIN_REQUIRES_RECONCILIATION: provider status unavailable', quarantinedLease.lease_id);
store.db.prepare("INSERT INTO events(event_id,job_id,type,payload_json,created_at) VALUES(?,?,?,?,?)")
  .run(`phase5-quarantine-event-${process.pid}`, quarantinedJob.job_id, 'task.lease.quarantined',
    JSON.stringify({ taskId: quarantinedTask.task_id, leaseId: quarantinedLease.lease_id, remoteEffect: 'uncertain', reconciliationRequired: true }), oldAttemptStart);
store.reconcileStaleAttempts(60_000);
assert.equal(store.db.prepare('SELECT status FROM attempts WHERE attempt_id=?').get(quarantinedAttemptId).status, 'started',
  'quarantined remote effect must not be converted into an ordinary timeout');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='attempt.timeout' AND json_extract(payload_json,'$.attemptId')=?")
  .get(quarantinedJob.job_id, quarantinedAttemptId).n, 0,
  'quarantined remote effect must not gain fabricated timeout evidence');
console.log('PASS: stale-attempt reconciliation defers quarantined leases without provider ledger rows');

// Native specialist runs use their own durable ledger. Even when task metadata
// and the lease disagree after a crash, an ACTIVE native runtime must fence the
// stale-attempt reaper independently of GitHub provider tables.
const nativeJob = store.createJob({ conversationKey: `phase5-native-runtime-${process.pid}`, title: 'Stale reaper must respect native runtime' });
store.transition(nativeJob.job_id, 'EXECUTING');
const nativeTask = store.ensureTask(nativeJob.job_id, { role: 'researcher', description: 'native remote run remains active' });
const nativeLease = store.acquireTaskLease(nativeTask.task_id, {
  leaseId: `phase5-native-runtime-lease-${process.pid}`, workerId: 'native-runtime-worker', ttlMs: 60_000
});
store.attachM12NativeSpecialistRuntime(nativeTask.task_id, {
  attempt: nativeLease.attempt, sessionKey: 'agent:phase5-native-runtime', nativeSessionId: `phase5-native-session-${process.pid}`,
  runId: `phase5-native-run-${process.pid}`, environmentId: 'fixture-env', nodeId: 'fixture-node',
  leaseId: nativeLease.lease_id, ownerEpoch: nativeLease.owner_epoch
});
store.db.prepare("UPDATE task_leases SET state='RELEASED',released_at=? WHERE lease_id=?")
  .run(oldAttemptStart, nativeLease.lease_id);
store.db.prepare("UPDATE tasks SET status='running',execution_status='failed',execution_finished_at=?,updated_at=? WHERE task_id=?")
  .run(oldAttemptStart, oldAttemptStart, nativeTask.task_id);
store.db.prepare("UPDATE attempts SET started_at=? WHERE task_id=? AND status='started'")
  .run(oldAttemptStart, nativeTask.task_id);
const nativeOpenAttempt = store.db.prepare("SELECT attempt_id FROM attempts WHERE task_id=? AND status='started'").get(nativeTask.task_id);
assert.ok(nativeOpenAttempt);
store.reconcileStaleAttempts(60_000);
assert.equal(store.db.prepare('SELECT status FROM attempts WHERE attempt_id=?').get(nativeOpenAttempt.attempt_id).status, 'started',
  'ACTIVE native runtime row must prevent stale attempt settlement when lease and task metadata disagree');
console.log('PASS: stale-attempt reconciliation defers active native specialist runtime');

fs.rmSync(dir, { recursive: true, force: true });
console.log('test-phase5-recovery: PASS');
