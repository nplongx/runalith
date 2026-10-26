import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('verified-execution-result-atomicity-');
const dbPath = path.join(root, 'workflow.db');
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = root;
const storeModulePath = path.resolve(process.env.PHASE2_TEST_WORKFLOW_STORE_MODULE || fileURLToPath(new URL('../src/runtime/job-store.js', import.meta.url)));
const storeModuleUrl = pathToFileURL(storeModulePath).href;
const { WorkflowStore } = await import(storeModuleUrl);
const store = new WorkflowStore();
const timestamp = () => new Date().toISOString();
const TEST_ONLY_SYNTHETIC_INPUT_COMMIT = 'a'.repeat(40);
const TEST_ONLY_SYNTHETIC_OUTPUT_COMMIT = 'b'.repeat(40);
const TEST_ONLY_SYNTHETIC_EVIDENCE_HASH = 'c'.repeat(64);
const architectureOutput = JSON.stringify({
  components: ['isolated provider result fixture'], interfaces: [], failure_modes: [],
  implementation_boundary: 'test-only; validates durable result/artifact transaction'
});

function makeLease(label) {
  const job = store.createJob({ conversationKey: `verified-result-${label}-${process.pid}`, title: `Verified result ${label}` });
  const task = store.ensureTask(job.job_id, { role: 'architect', description: `Typed provider result ${label}` });
  const metadata = JSON.parse(task.metadata_json || '{}');
  metadata.runtime_owner = 'github-runner';
  store.db.prepare('UPDATE tasks SET metadata_json=? WHERE task_id=?').run(JSON.stringify(metadata), task.task_id);
  const lease = store.acquireTaskLease(task.task_id, {
    leaseId: `lease-${label}-${process.pid}`, workerId: `worker-${label}`, ttlMs: 120000, attempt: 1
  });
  return { job, task: store.getTask(task.task_id), lease };
}

function resultFor({ job, task, lease }, providerRunId) {
  const started = timestamp();
  return {
    schema_version: 1, job_id: job.job_id, task_id: task.task_id, lease_id: lease.lease_id,
    attempt: lease.attempt, owner_epoch: lease.owner_epoch, provider_run_attempt: 1,
    status: 'SUCCEEDED', input_commit: TEST_ONLY_SYNTHETIC_INPUT_COMMIT, output_commit: TEST_ONLY_SYNTHETIC_OUTPUT_COMMIT,
    exit_code: 0, provider_run_id: providerRunId, evidence_artifact: `artifact-${providerRunId}`,
    evidence_refs: ['task-payload.json', 'execution.json', 'stdout.txt', 'stderr.txt', 'git-status.txt'],
    started_at: started, finished_at: timestamp(), agent_output: architectureOutput,
    evidence_verification: { evidence_hash: TEST_ONLY_SYNTHETIC_EVIDENCE_HASH, errors: [], valid: true }
  };
}

function failureResultFor(fixture, providerRunId) {
  const { output_commit: _unattestedCommit, ...withoutOutputCommit } = resultFor(fixture, providerRunId);
  return {
    ...withoutOutputCommit,
    status: 'FAILED',
    exit_code: 1,
    error: 'synthetic provider failure without output commit'
  };
}

function inspectIndependent(taskId, jobId) {
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    return {
      task: db.prepare('SELECT task_id,job_id,status,execution_attempt,execution_status,execution_exit_code FROM tasks WHERE task_id=?').get(taskId),
      results: db.prepare('SELECT result_id,task_id,outcome,content FROM results WHERE task_id=? ORDER BY rowid').all(taskId),
      artifacts: db.prepare('SELECT artifact_id,task_id,kind,status,evidence_json FROM artifacts WHERE task_id=? ORDER BY rowid').all(taskId),
      attempts: db.prepare('SELECT attempt_id,task_id,status,started_at,finished_at,error FROM attempts WHERE task_id=? ORDER BY rowid').all(taskId),
      lease: db.prepare('SELECT lease_id,task_id,attempt,state FROM task_leases WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(taskId),
      completionEvents: db.prepare("SELECT event_id,type,payload_json FROM events WHERE job_id=? AND type IN ('task.completed','task.failed','task.local_completed','task.local_failed') AND json_extract(payload_json,'$.taskId')=? ORDER BY rowid").all(jobId, taskId),
      resultEvents: db.prepare("SELECT event_id,type,payload_json FROM events WHERE job_id=? AND type IN ('task.execution.verified','task.execution.checkpointed','task.execution.rejected') AND json_extract(payload_json,'$.taskId')=? ORDER BY rowid").all(jobId, taskId),
      leaseEvents: db.prepare("SELECT event_id,type,payload_json FROM events WHERE job_id=? AND type IN ('task.lease.completed','task.lease.expired','task.lease.quarantined') AND json_extract(payload_json,'$.taskId')=? ORDER BY rowid").all(jobId, taskId)
    };
  } finally { db.close(); }
}

function assertPristineAfterReject(fixture) {
  const after = inspectIndependent(fixture.task.task_id, fixture.job.job_id);
  assert.equal(after.task.status, 'running');
  assert.equal(after.results.length, 0, 'rejected result must not leave result bytes');
  assert.equal(after.artifacts.length, 0, 'rejected result must not create a typed artifact');
  assert.equal(after.attempts.length, 0, 'rejected result must not leave an attempt row');
  assert.equal(after.lease.state, 'ACTIVE', 'rejected result must leave the lease active for reconciliation');
  assert.equal(after.completionEvents.length, 0);
  assert.equal(after.resultEvents.length, 0);
  assert.equal(after.leaseEvents.length, 0);
}

// There is no independent output_commit attestation contract in the current
// P3 trust domain. Test the real fail-closed behavior, not an unattested success.
{
  const fixture = makeLease('attestation-required');
  const success = resultFor(fixture, `provider-unattested-success-${process.pid}`);
  for (const candidate of [
    success,
    { ...success, output_commit: undefined },
    { ...success, output_commit: null },
    { ...success, output_commit: '' }
  ]) {
    const rejected = store.applyVerifiedExecutionResult(candidate);
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(rejected.reason, 'output_commit_attestation_required');
    assertPristineAfterReject(fixture);
  }
  const failedWithClaim = {
    ...failureResultFor(fixture, `provider-failed-claim-${process.pid}`),
    output_commit: TEST_ONLY_SYNTHETIC_OUTPUT_COMMIT
  };
  assert.equal(store.applyVerifiedExecutionResult(failedWithClaim).reason, 'output_commit_attestation_required');
  const failedWithWorkerMarker = failureResultFor(fixture, `provider-failed-marker-${process.pid}`);
  failedWithWorkerMarker.evidence_verification.output_commit_provenance = 'worker-controlled-marker';
  assert.equal(store.applyVerifiedExecutionResult(failedWithWorkerMarker).reason, 'output_commit_attestation_required');
  assertPristineAfterReject(fixture);
  console.log('VERIFIED RESULT OUTPUT_COMMIT ATTESTATION FAIL-CLOSED / NON-MUTATION PASS');
}

// Failed results without any commit claim can be reconciled. Inject an event
// write failure after the result, attempt, lease and task updates to prove the
// outer savepoint rolls the durable transition back before retry.
{
  const fixture = makeLease('failure-result-rollback');
  const result = failureResultFor(fixture, `provider-failure-rollback-${process.pid}`);
  const originalRecordEvent = store.recordEvent.bind(store);
  store.recordEvent = (jobId, type, payload, dedupeKey) => {
    if (type === 'task.failed') throw new Error('injected task-failure event persistence failure');
    return originalRecordEvent(jobId, type, payload, dedupeKey);
  };
  try {
    assert.throws(() => store.applyVerifiedExecutionResult(result), /injected task-failure event persistence failure/);
  } finally { store.recordEvent = originalRecordEvent; }

  const afterRollback = inspectIndependent(fixture.task.task_id, fixture.job.job_id);
  assert.equal(afterRollback.task.status, 'running');
  assert.equal(afterRollback.results.length, 0);
  assert.equal(afterRollback.artifacts.length, 0);
  assert.equal(afterRollback.attempts.length, 0);
  assert.equal(afterRollback.lease.state, 'ACTIVE');
  assert.equal(afterRollback.completionEvents.length, 0);
  assert.equal(afterRollback.resultEvents.length, 0);
  assert.equal(afterRollback.leaseEvents.length, 0);

  const applied = store.applyVerifiedExecutionResult(result);
  assert.equal(applied.status, 'REJECTED', 'a failed provider outcome is not a verified success');
  const recovered = inspectIndependent(fixture.task.task_id, fixture.job.job_id);
  assert.equal(recovered.task.status, 'failed');
  assert.equal(recovered.task.execution_status, 'failed');
  assert.equal(recovered.task.execution_exit_code, 1);
  assert.equal(recovered.results.length, 1);
  assert.equal(recovered.results[0].outcome, 'failure');
  assert.equal(recovered.artifacts.length, 0);
  assert.equal(recovered.attempts.length, 1);
  assert.equal(recovered.attempts[0].status, 'failed');
  assert.equal(recovered.lease.state, 'FAILED');
  assert.equal(recovered.completionEvents.length, 1);
  assert.equal(recovered.resultEvents.length, 1);
  assert.equal(recovered.leaseEvents.length, 1);
  assert.equal(store.applyVerifiedExecutionResult(result).reason, 'duplicate_provider_result');
  assert.equal(inspectIndependent(fixture.task.task_id, fixture.job.job_id).results.length, 1);
  console.log('FAILED RESULT SAVEPOINT ROLLBACK/RETRY/IDEMPOTENCY PASS');
}

// The writer is killed after the result INSERT but before savepoint release.
// A second connection must not observe an orphan result or half-terminal state.
{
  const fixture = makeLease('failure-result-sigkill');
  const result = failureResultFor(fixture, `provider-failure-sigkill-${process.pid}`);
  const childCode = `
    const { WorkflowStore } = await import(${JSON.stringify(storeModuleUrl)});
    const store = new WorkflowStore();
    store.applyVerifiedExecutionResult(${JSON.stringify(result)});
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: root, NODE_ENV: 'test',
      CHAT_ON_STEROIDS_TEST_CRASH_AFTER_VERIFIED_RESULT_INSERT: 'SIGKILL' }
  });
  assert.equal(child.signal, 'SIGKILL', `writer must die inside result savepoint: ${child.stderr}`);
  const afterCrash = inspectIndependent(fixture.task.task_id, fixture.job.job_id);
  assert.equal(afterCrash.task.status, 'running');
  assert.equal(afterCrash.results.length, 0);
  assert.equal(afterCrash.artifacts.length, 0);
  assert.equal(afterCrash.attempts.length, 0);
  assert.equal(afterCrash.lease.state, 'ACTIVE');
  assert.equal(afterCrash.completionEvents.length, 0);
  assert.equal(afterCrash.resultEvents.length, 0);
  assert.equal(afterCrash.leaseEvents.length, 0);
  assert.equal(store.applyVerifiedExecutionResult(result).status, 'REJECTED');
  const recovered = inspectIndependent(fixture.task.task_id, fixture.job.job_id);
  assert.equal(recovered.task.status, 'failed');
  assert.equal(recovered.results.length, 1);
  assert.equal(recovered.attempts.length, 1);
  assert.equal(recovered.lease.state, 'FAILED');
  assert.equal(recovered.completionEvents.length, 1);
  assert.equal(recovered.resultEvents.length, 1);
  assert.equal(recovered.leaseEvents.length, 1);
  console.log('FAILED RESULT SIGKILL/INDEPENDENT REOPEN/RETRY PASS');
}

// Lease expiry has its own row-state/event atomicity contract.
{
  const fixture = makeLease('expire-rollback');
  const originalRecordEvent = store.recordEvent.bind(store);
  store.recordEvent = (jobId, type, payload, dedupeKey) => {
    if (type === 'task.lease.expired') throw new Error('injected lease-expiry event persistence failure');
    return originalRecordEvent(jobId, type, payload, dedupeKey);
  };
  try {
    assert.throws(() => store.expireTaskLease(fixture.lease.lease_id, { reason: 'injected expiry transaction failure' }), /injected lease-expiry event persistence failure/);
    const afterFailure = inspectIndependent(fixture.task.task_id, fixture.job.job_id);
    assert.equal(afterFailure.lease.state, 'ACTIVE');
    assert.equal(afterFailure.task.status, 'running');
    assert.equal(afterFailure.leaseEvents.length, 0);
  } finally { store.recordEvent = originalRecordEvent; }
  assert.equal(store.expireTaskLease(fixture.lease.lease_id, { reason: 'retry expiry after rolled-back write' }).state, 'EXPIRED');
  const afterRetry = inspectIndependent(fixture.task.task_id, fixture.job.job_id);
  assert.equal(afterRetry.lease.state, 'EXPIRED');
  assert.equal(afterRetry.task.status, 'pending');
  assert.equal(afterRetry.leaseEvents.length, 1);

  const crashFixture = makeLease('expire-sigkill');
  const childCode = `
    const { WorkflowStore } = await import(${JSON.stringify(storeModuleUrl)});
    const store = new WorkflowStore();
    store.expireTaskLease(${JSON.stringify(crashFixture.lease.lease_id)}, { reason: 'writer killed after task reset' });
  `;
  const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: root, NODE_ENV: 'test',
      CHAT_ON_STEROIDS_TEST_CRASH_AFTER_LEASE_EXPIRE_STATE_UPDATE: 'SIGKILL' }
  });
  assert.equal(crashed.signal, 'SIGKILL', `lease expiry child must die inside savepoint: ${crashed.stderr}`);
  const afterProcessDeath = inspectIndependent(crashFixture.task.task_id, crashFixture.job.job_id);
  assert.equal(afterProcessDeath.lease.state, 'ACTIVE');
  assert.equal(afterProcessDeath.task.status, 'running');
  assert.equal(afterProcessDeath.leaseEvents.length, 0);
  assert.equal(store.expireTaskLease(crashFixture.lease.lease_id, { reason: 'recovery expiry after SIGKILL' }).state, 'EXPIRED');
  assert.equal(inspectIndependent(crashFixture.task.task_id, crashFixture.job.job_id).leaseEvents.length, 1);
  console.log('TASK LEASE EXPIRY FAILURE-ROLLBACK/SIGKILL-RECOVERY PASS');
}

// Standalone completion must not persist a terminal lease state without its
// corresponding event, either on exception or real process death.
{
  const fixture = makeLease('complete-rollback');
  const originalRecordEvent = store.recordEvent.bind(store);
  store.recordEvent = (jobId, type, payload, dedupeKey) => {
    if (type === 'task.lease.completed') throw new Error('injected lease-completion event persistence failure');
    return originalRecordEvent(jobId, type, payload, dedupeKey);
  };
  try {
    assert.throws(() => store.completeTaskLease(fixture.lease.lease_id, { workerId: fixture.lease.worker_id, success: true }), /injected lease-completion event persistence failure/);
    const afterFailure = inspectIndependent(fixture.task.task_id, fixture.job.job_id);
    assert.equal(afterFailure.lease.state, 'ACTIVE');
    assert.equal(afterFailure.task.status, 'running');
    assert.equal(afterFailure.leaseEvents.length, 0);
  } finally { store.recordEvent = originalRecordEvent; }
  const completed = store.completeTaskLease(fixture.lease.lease_id, { workerId: fixture.lease.worker_id, success: true });
  assert.equal(completed.ok, true);
  assert.equal(completed.lease.state, 'COMPLETED');
  assert.equal(inspectIndependent(fixture.task.task_id, fixture.job.job_id).leaseEvents.length, 1);

  const crashFixture = makeLease('complete-sigkill');
  const childCode = `
    const { WorkflowStore } = await import(${JSON.stringify(storeModuleUrl)});
    const store = new WorkflowStore();
    store.completeTaskLease(${JSON.stringify(crashFixture.lease.lease_id)}, { workerId: ${JSON.stringify(crashFixture.lease.worker_id)}, success: true });
  `;
  const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: root, NODE_ENV: 'test',
      CHAT_ON_STEROIDS_TEST_CRASH_AFTER_LEASE_COMPLETE_STATE_UPDATE: 'SIGKILL' }
  });
  assert.equal(crashed.signal, 'SIGKILL', `lease completion child must die inside savepoint: ${crashed.stderr}`);
  const afterCrash = inspectIndependent(crashFixture.task.task_id, crashFixture.job.job_id);
  assert.equal(afterCrash.lease.state, 'ACTIVE');
  assert.equal(afterCrash.leaseEvents.length, 0);
  assert.equal(store.completeTaskLease(crashFixture.lease.lease_id, { workerId: crashFixture.lease.worker_id, success: true }).lease.state, 'COMPLETED');
  assert.equal(inspectIndependent(crashFixture.task.task_id, crashFixture.job.job_id).leaseEvents.length, 1);
  console.log('TASK LEASE COMPLETION FAILURE-ROLLBACK/SIGKILL-RECOVERY PASS');
}

// Malformed expiry is quarantined before result persistence.
{
  const fixture = makeLease('malformed-expiry');
  store.db.prepare('UPDATE task_leases SET expires_at=? WHERE lease_id=?')
    .run('not-a-canonical-expiry', fixture.lease.lease_id);
  const rejected = store.applyVerifiedExecutionResult(failureResultFor(fixture, `provider-malformed-expiry-${process.pid}`));
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.reason, 'lease_expiry_malformed');
  const after = inspectIndependent(fixture.task.task_id, fixture.job.job_id);
  assert.equal(after.task.status, 'failed');
  assert.equal(after.lease.state, 'FAILED');
  assert.equal(after.results.length, 0);
  assert.equal(after.artifacts.length, 0);
  assert.equal(after.completionEvents.length, 0);
  assert.equal(after.resultEvents.length, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='task.lease.quarantined' AND json_extract(payload_json,'$.leaseId')=?")
    .get(fixture.job.job_id, fixture.lease.lease_id).n, 1);
  console.log('VERIFIED RESULT MALFORMED LEASE EXPIRY / NO RESULT / QUARANTINE PASS');
}

// A terminal parent job is never revived by a late execution result.
{
  const fixture = makeLease('terminal-parent');
  store.transition(fixture.job.job_id, 'FAILED', 'failed');
  const rejected = store.applyVerifiedExecutionResult(failureResultFor(fixture, `provider-terminal-parent-${process.pid}`));
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.reason, 'parent_job_not_active');
  const after = inspectIndependent(fixture.task.task_id, fixture.job.job_id);
  assert.equal(store.getJob(fixture.job.job_id).status, 'failed');
  assert.equal(after.task.status, 'failed');
  assert.notEqual(after.lease.state, 'ACTIVE');
  assert.equal(after.results.length, 0);
  assert.equal(after.artifacts.length, 0);
  assert.equal(after.completionEvents.length, 0);
  assert.equal(store.applyVerifiedExecutionResult(failureResultFor(fixture, `provider-terminal-parent-repeat-${process.pid}`)).reason, 'lease_not_active');
  console.log('VERIFIED RESULT TERMINAL PARENT / NO FALSE SUCCESS / LEASE SETTLEMENT PASS');
}

console.log('VERIFIED EXECUTION RESULT ATOMICITY PASS');
