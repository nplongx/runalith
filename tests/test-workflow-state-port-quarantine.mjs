import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-state-port-quarantine-'));
process.env.WORKFLOW_DB = path.join(root, 'workflow.db');
process.env.WORKFLOW_DATA_DIR = root;
process.env.NODE_ENV = 'test';

const { WorkflowStore } = await import('../job-store.js');
const { createWorkflowStatePort } = await import('../src/runtime/workflow-state-port.js');
const { createExecutionRequest } = await import('../src/runtime/execution-contract.js');
const { createProviderDispatchIdentity } = await import('../src/runtime/provider-dispatch-identity.js');
const store = new WorkflowStore();
const state = createWorkflowStatePort(store);
state.ensureProviderExecutionSchema();

function makeTask(label) {
  const job = store.createJob({ conversationKey: `state-port-${label}`, title: label });
  const task = store.ensureTask(job.job_id, { role: 'executor', description: label });
  const lease = store.acquireTaskLease(task.task_id, {
    leaseId: `lease-state-port-${label}`, workerId: 'state-port-test', ttlMs: 120_000, attempt: 1
  });
  return { job, task, lease };
}

try {
  const uncertain = makeTask('quarantined-provider-outcome');
  const request = createExecutionRequest({
    job_id: uncertain.job.job_id,
    task_id: uncertain.task.task_id,
    lease_id: uncertain.lease.lease_id,
    attempt: uncertain.lease.attempt,
    owner_epoch: uncertain.lease.owner_epoch,
    role: 'executor',
    input_commit: 'a'.repeat(40),
    task_payload_ref: '.worker/tasks/quarantined.json',
    workspace: 'ephemeral',
    required_evidence: ['execution.json']
  });
  const dispatchIdentity = createProviderDispatchIdentity(request, {
    provider: 'github-actions', api_base: 'https://api.github.com', workflow: 'p3-worker.yml',
    repository: 'example/repo', event: 'workflow_dispatch', ref: 'main'
  });
  const reservation = state.reserveProviderDispatchIntent({ dispatchIdentity, request });
  assert.equal(reservation.intent.state, 'DISPATCHING');
  const claim = state.claimProviderDispatchForSend({
    intent: reservation.intent, claimId: 'state-port-one-way-claim', claimedAt: new Date().toISOString()
  });
  assert.equal(claim.claimed, true);

  const quarantined = store.expireTaskLease(uncertain.lease.lease_id, { reason: 'injected ambiguous remote outcome' });
  assert.equal(quarantined.state, 'FAILED');
  assert.match(quarantined.last_error, /^REMOTE_EFFECT_UNCERTAIN_REQUIRES_RECONCILIATION:/);
  assert.equal(state.clearTaskLeaseError(uncertain.lease.lease_id).changes, 0,
    'late provider success callback must not clear a quarantined FAILED lease');
  assert.match(state.getTaskLease(uncertain.lease.lease_id).last_error,
    /^REMOTE_EFFECT_UNCERTAIN_REQUIRES_RECONCILIATION:/);
  assert.equal(state.hasUnresolvedDurableExecution(uncertain.job.job_id), true,
    'stale-job recovery must defer while a claimed provider effect remains uncertain');

  const native = makeTask('active-native-runtime');
  const now = new Date().toISOString();
  store.db.prepare(`INSERT INTO m12_native_specialist_runtime
    (task_id,attempt,session_key,native_session_id,run_id,environment_id,node_id,lease_id,owner_epoch,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,'ACTIVE',?,?)`).run(
      native.task.task_id, native.lease.attempt, 'agent:state-port:native', 'native-session-state-port',
      'native-run-state-port', 'env-state-port', 'node-state-port', native.lease.lease_id,
      native.lease.owner_epoch, now, now
    );
  assert.equal(state.hasUnresolvedDurableExecution(native.job.job_id), true,
    'an ACTIVE M12 native runtime must block stale-job terminalization even without provider_runs');
  store.db.prepare("UPDATE jobs SET state='EXECUTING',status='active',updated_at=? WHERE job_id=?")
    .run(new Date(Date.now() - 60_000).toISOString(), native.job.job_id);
  const staleOutcome = state.reconcileStaleJob({
    jobId: native.job.job_id, staleMs: 1000, nowMs: Date.now(), liveRuntimeSessionKeys: []
  });
  assert.deepEqual(staleOutcome, { status: 'DEFERRED', reason: 'durable_lease_or_provider_outcome_unresolved' });
  assert.equal(store.getJob(native.job.job_id).status, 'active', 'stale recovery must not terminalize an unresolved native run');

  const preSend = makeTask('native-start-lease-expires-before-send-claim');
  state.ensureM12NativeSpecialistStartIntentSchema();
  const startReservation = state.reserveM12NativeSpecialistStart({
    jobId: preSend.job.job_id, taskId: preSend.task.task_id, attempt: preSend.lease.attempt,
    leaseId: preSend.lease.lease_id, ownerEpoch: preSend.lease.owner_epoch,
    environmentId: 'env-pre-send', nodeId: 'node-pre-send',
    admissionIdempotencyKey: 'admission-pre-send-lease-expired', inputCommit: 'd'.repeat(40),
    role: 'researcher', prompt: 'bounded task', waitTimeoutMs: 0
  });
  const expired = store.expireTaskLease(preSend.lease.lease_id, { reason: 'lease expired after reservation before Gateway send claim' });
  assert.equal(expired.state, 'FAILED');
  assert.throws(() => state.claimM12NativeSpecialistStartForSend({
    taskId: preSend.task.task_id, attempt: preSend.lease.attempt,
    leaseId: preSend.lease.lease_id, ownerEpoch: preSend.lease.owner_epoch,
    requestSha256: startReservation.requestSha256
  }), /requires the exact active lease and live running parent\/task/,
  'the Gateway side-effect fence must reject a lease that expires between reservation and send');
  assert.equal(state.getM12NativeSpecialistStartIntent(preSend.task.task_id, 1).start_claim_id, null,
    'expired lease must never acquire a one-way Gateway send claim');

  console.log('workflow-state-port unresolved-outcome contract PASS');
} finally {
  store.close?.();
  fs.rmSync(root, { recursive: true, force: true });
}
