import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAdaptiveGoalKnowledgeStore } from '../src/runtime/adaptive-goal-knowledge-store.js';
import { buildActiveWorkflowReconciliationReport, buildAdaptiveGoalGraphIntegrityReport,
  revalidatePlannerEvidenceLineage } from '../scripts/reconcile-active-workflows.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts/reconcile-active-workflows.mjs');
const NOW = '2026-10-26T05:40:00.000Z';
const OLD = '2026-10-26T01:00:00.000Z';
const COMPLETE_EVENT = '2026-10-26T02:00:00.000Z';

function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function writeFixture(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE jobs(job_id TEXT PRIMARY KEY,conversation_key TEXT,title TEXT,state TEXT,status TEXT,active_task_id TEXT,
      provider_waiting INTEGER,provider_retry_at TEXT,created_at TEXT,updated_at TEXT,approved_at TEXT,completed_at TEXT);
    CREATE TABLE tasks(task_id TEXT PRIMARY KEY,job_id TEXT,role TEXT,status TEXT,openclaw_run_id TEXT,openclaw_session_key TEXT,
      parent_task_id TEXT,dependency_json TEXT,metadata_json TEXT,created_at TEXT,updated_at TEXT,execution_session_id TEXT,
      execution_status TEXT,execution_attempt INTEGER,execution_pid INTEGER,execution_exit_code INTEGER,execution_started_at TEXT,execution_finished_at TEXT);
    CREATE TABLE attempts(attempt_id TEXT PRIMARY KEY,task_id TEXT,status TEXT,openclaw_run_id TEXT,started_at TEXT,finished_at TEXT,error TEXT);
    CREATE TABLE results(result_id TEXT PRIMARY KEY,task_id TEXT,outcome TEXT,content TEXT,created_at TEXT);
    CREATE TABLE events(event_id TEXT PRIMARY KEY,job_id TEXT,type TEXT,payload_json TEXT,created_at TEXT);
    CREATE TABLE task_leases(lease_id TEXT PRIMARY KEY,task_id TEXT,job_id TEXT,attempt INTEGER,worker_id TEXT,state TEXT,issued_at TEXT,heartbeat_at TEXT,expires_at TEXT,released_at TEXT,last_error TEXT,owner_epoch INTEGER);
    CREATE TABLE workflow_runtime_state(job_id TEXT,phase TEXT,attempt INTEGER,resume_after TEXT,last_error TEXT,updated_at TEXT);
    CREATE TABLE artifacts(artifact_id TEXT PRIMARY KEY,job_id TEXT,task_id TEXT,kind TEXT,uri TEXT,metadata_json TEXT,created_at TEXT,
      schema_version INTEGER,producer_role TEXT,content TEXT,evidence_json TEXT,status TEXT,supersedes TEXT,content_hash TEXT);
    CREATE TABLE approvals(approval_id TEXT PRIMARY KEY,job_id TEXT,decision TEXT,actor TEXT,raw_text TEXT,proposal_hash TEXT,created_at TEXT);
  `);
  const insertJob = db.prepare(`INSERT INTO jobs(job_id,conversation_key,title,state,status,active_task_id,provider_waiting,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  const insertTask = db.prepare(`INSERT INTO tasks(task_id,job_id,role,status,openclaw_run_id,openclaw_session_key,parent_task_id,
    dependency_json,metadata_json,created_at,updated_at,execution_session_id,execution_status,execution_attempt,execution_pid,
    execution_started_at,execution_finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertAttempt = db.prepare('INSERT INTO attempts(attempt_id,task_id,status,openclaw_run_id,started_at,finished_at,error) VALUES(?,?,?,?,?,?,?)');
  const insertEvent = db.prepare('INSERT INTO events(event_id,job_id,type,payload_json,created_at) VALUES(?,?,?,?,?)');
  const insertResult = db.prepare('INSERT INTO results(result_id,task_id,outcome,content,created_at) VALUES(?,?,?,?,?)');
  const insertArtifact = db.prepare(`INSERT INTO artifacts(artifact_id,job_id,task_id,kind,uri,metadata_json,created_at,schema_version,
    producer_role,content,evidence_json,status,supersedes,content_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertLease = db.prepare(`INSERT INTO task_leases(lease_id,task_id,job_id,attempt,worker_id,state,issued_at,heartbeat_at,expires_at,
    released_at,last_error,owner_epoch) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  const activeStale = 'job-stale';
  insertJob.run(activeStale, 'conversation:stale', 'stale job with running task but no worker identity', 'EXECUTING', 'active', 'task-stale', 0, OLD, OLD);
  insertTask.run('task-stale', activeStale, 'researcher', 'running', null, null, null, '["task-stale","task-missing"]', '{}', OLD, OLD, null, null, 0, null, null, null);
  insertEvent.run('event-stale', activeStale, 'task.dispatched', JSON.stringify({ taskId: 'task-stale', role: 'researcher' }), OLD);
  insertArtifact.run('artifact-stale-mismatch', 'other-job', 'task-stale', 'architecture', 'artifact://mismatch', '{}', OLD, 1, 'architect',
    '{"components":[]}', '[]', 'active', null, sha('mismatched-artifact'));

  insertJob.run('job-stuck-terminal', 'conversation:complete', 'all tasks completed but job remains executing', 'EXECUTING', 'active', 'task-completed', 0, OLD, OLD);
  insertTask.run('task-completed', 'job-stuck-terminal', 'reviewer', 'completed', 'run-7', 'session-7', null, '[]', '{}', OLD, '2026-10-26T01:30:00.000Z',
    'exec-session-7', 'success', 1, null, OLD, COMPLETE_EVENT);
  insertAttempt.run('attempt-7', 'task-completed', 'completed', 'run-7', OLD, COMPLETE_EVENT, null);
  insertResult.run('result-7', 'task-completed', 'success', 'not copied to the diagnostic output', COMPLETE_EVENT);
  insertArtifact.run('artifact-7', 'job-stuck-terminal', 'task-completed', 'review', 'artifact://7', '{}', COMPLETE_EVENT, 1, 'reviewer',
    '{"decision":"needs_changes"}', '[]', 'active', null, sha('artifact-content'));
  insertEvent.run('event-completed', 'job-stuck-terminal', 'task.local_completed', JSON.stringify({ taskId: 'task-completed', attemptId: 'attempt-7', resultId: 'result-7', artifactId: 'artifact-7' }), COMPLETE_EVENT);
  for (let i = 1; i <= 13; i += 1) {
    insertEvent.run(`event-noise-${i}`, 'job-stuck-terminal', 'workflow.progress', JSON.stringify({ phase: `phase-${i}` }),
      `2026-10-26T02:${String(i).padStart(2, '0')}:00.000Z`);
  }
  db.prepare('INSERT INTO approvals(approval_id,job_id,decision,actor,raw_text,proposal_hash,created_at) VALUES(?,?,?,?,?,?,?)')
    .run('approval-needs-changes', 'job-stuck-terminal', 'needs_changes', 'trusted-reviewer-fixture', 'not copied', sha('plan'), COMPLETE_EVENT);

  insertJob.run('job-live-lease', 'conversation:live', 'active task with current lease', 'EXECUTING', 'active', 'task-live', 0, NOW, NOW);
  insertTask.run('task-live', 'job-live-lease', 'engineer', 'running', 'run-task-mismatch', 'session-live', null, '[]', '{}', NOW, NOW,
    'exec-live', 'running', 1, null, NOW, null);
  insertAttempt.run('attempt-live', 'task-live', 'started', 'run-live', NOW, null, null);
  // Keep the lease future-valid for CLI tests that intentionally use wall-clock
  // `now`; the in-memory deterministic test passes NOW explicitly.
  insertLease.run('lease-live', 'task-live', 'wrong-job-for-lineage-test', 2, 'worker-local', 'ACTIVE', NOW, NOW,
    '2099-10-26T06:10:00.000Z', null, null, null);
  insertEvent.run('event-live', 'job-live-lease', 'attempt.started', JSON.stringify({ taskId: 'task-live', attemptId: 'attempt-live' }), NOW);
  db.prepare('INSERT INTO workflow_runtime_state(job_id,phase,attempt,resume_after,last_error,updated_at) VALUES(?,?,?,?,?,?)')
    .run('job-live-lease', 'executing', 7, null, null, NOW);

  insertJob.run('job-live-lease-good', 'conversation:live-good', 'active task with matching lease', 'EXECUTING', 'active', 'task-live-good', 0, NOW, NOW);
  insertTask.run('task-live-good', 'job-live-lease-good', 'engineer', 'running', 'run-live-good', 'session-live-good', null, '[]', '{}', NOW, NOW,
    'exec-live-good', 'running', 1, null, NOW, null);
  insertAttempt.run('attempt-live-good', 'task-live-good', 'started', 'run-live-good', NOW, null, null);
  insertLease.run('lease-live-good', 'task-live-good', 'job-live-lease-good', 1, 'worker-local-good', 'ACTIVE', NOW, NOW,
    '2099-10-26T06:10:00.000Z', null, null, 4);
  // Six newer released rows push the still-active lease outside the historical
  // LIMIT 5 window. Reconciliation must independently discover that active row.
  for (let i = 1; i <= 6; i += 1) insertLease.run(`lease-live-good-released-${i}`, 'task-live-good', 'job-live-lease-good', 1,
    null, 'RELEASED', `2026-10-26T05:${String(40 + i).padStart(2, '0')}:00.000Z`, NOW, NOW, NOW, null, 4);
  insertEvent.run('event-live-good', 'job-live-lease-good', 'attempt.started', JSON.stringify({ taskId: 'task-live-good', attemptId: 'attempt-live-good' }), NOW);

  insertJob.run('job-approved', 'conversation:approved', 'approved but not dispatched', 'APPROVED', 'active', null, 0, NOW, NOW);

  // Reconciliation must not silently omit an executing job because a stale or
  // inconsistent status column no longer says "active".
  insertJob.run('job-executing-status-mismatch', 'conversation:status-mismatch', 'executing state with inconsistent status',
    'EXECUTING', 'completed', 'task-status-mismatch', 0, OLD, OLD);
  insertTask.run('task-status-mismatch', 'job-executing-status-mismatch', 'engineer', 'running', null, null, null, '[]', '{}', OLD, OLD,
    null, 'running', 1, null, OLD, null);
  insertEvent.run('event-status-mismatch', 'job-executing-status-mismatch', 'task.dispatched',
    JSON.stringify({ taskId: 'task-status-mismatch' }), OLD);
  db.close();
}

test('read-only reconciliation correlates job/task/attempt/result/artifact/event/lease state and does not infer authorization', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'active-workflow-reconciliation-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'workflow.db');
  writeFixture(dbPath);
  const before = sha(fs.readFileSync(dbPath));
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const report = buildActiveWorkflowReconciliationReport(db, { now: NOW, staleAfterMs: 900_000, limit: 20, procRoot: path.join(dir, 'proc') });
  db.close();
  const after = sha(fs.readFileSync(dbPath));
  assert.equal(after, before, 'read-only reconciliation must preserve exact SQLite bytes');
  assert.equal(report.readOnly, true);
  assert.equal(report.policy.staleCandidateIsNotProofOfWorkerDeath, true);
  assert.equal(report.policy.missingLeaseDoesNotAuthorizeTerminalization, true);
  assert.equal(report.summary.consideredJobs, 6);
  assert.equal(report.summary.matchingJobCount, 6);
  assert.equal(report.summary.selectionTruncated, false);
  assert.equal(report.scope, 'active_and_executing_jobs');
  const jobs = new Map(report.diagnostics.map(job => [job.jobId, job]));

  const statusMismatch = jobs.get('job-executing-status-mismatch');
  assert.ok(statusMismatch, 'EXECUTING jobs must be included even when status column is inconsistent');
  assert.equal(statusMismatch.state, 'EXECUTING');
  assert.equal(statusMismatch.status, 'completed');
  assert.equal(statusMismatch.classification, 'executing_state_status_inconsistent');
  assert.ok(statusMismatch.flags.includes('EXECUTING_STATE_STATUS_INCONSISTENT'));
  const statusMismatchFinding = statusMismatch.findings.find(item => item.code === 'EXECUTING_STATE_STATUS_INCONSISTENT');
  assert.equal(statusMismatchFinding?.gate, 'HOLD');
  assert.equal(statusMismatchFinding?.authorizationGranted, false);
  assert.ok(statusMismatch.flags.includes('RUNNING_TASKS_WITHOUT_ACTIVE_LEASES'));

  const stale = jobs.get('job-stale');
  assert.equal(stale.classification, 'stale_candidate_reconciliation_required');
  assert.ok(stale.flags.includes('RUNNING_TASK_WITHOUT_EXECUTION_METADATA'));
  assert.ok(stale.flags.includes('RUNNING_TASKS_WITHOUT_ACTIVE_LEASES'));
  assert.ok(stale.flags.includes('TASK_DEPENDENCY_REFERENCE_INVALID'));
  assert.ok(stale.flags.includes('TASK_DEPENDENCY_CYCLE'));
  assert.equal(stale.tasks[0].latestAttempt, null);
  assert.ok(stale.flags.includes('ARTIFACT_JOB_TASK_LINEAGE_MISMATCH'));
  assert.ok(stale.flags.includes('ARTIFACT_PRODUCER_ROLE_MISMATCH'));
  assert.match(stale.ownerAction, /responsible owner/);
  const artifactFinding = stale.findings.find(item => item.code === 'ARTIFACT_JOB_TASK_LINEAGE_MISMATCH');
  assert.equal(artifactFinding.status, 'UNRESOLVED');
  assert.equal(artifactFinding.gate, 'HOLD');
  assert.equal(artifactFinding.authorizationGranted, false);
  assert.equal(artifactFinding.source.subsystem, 'read_only_workflow_reconciliation');
  assert.ok(artifactFinding.source.tables.includes('artifacts'));
  assert.ok(artifactFinding.source.recordIds.artifactIds.includes('artifact-stale-mismatch'));
  assert.match(artifactFinding.remediation, /authoritative artifact store/);
  assert.match(artifactFinding.findingId, /^reconcile-[a-f0-9]{64}$/);

  const mismatched = jobs.get('job-stuck-terminal');
  assert.equal(mismatched.classification, 'stale_candidate_reconciliation_required');
  assert.ok(mismatched.flags.includes('EXECUTING_JOB_WITHOUT_RUNNING_TASKS'));
  assert.ok(mismatched.flags.includes('ACTIVE_TASK_POINTER_NOT_RUNNING'));
  assert.ok(mismatched.flags.includes('COMPLETION_EVENT_NEWER_THAN_ACTIVE_TASK_ROW'));
  assert.equal(mismatched.resultCount, 1);
  assert.equal(mismatched.artifactCount, 1);
  assert.equal(mismatched.tasks[0].recentResults[0].resultId, 'result-7');
  assert.equal(mismatched.latestApproval.decision, 'needs_changes');
  const completionFinding = mismatched.findings.find(item => item.code === 'COMPLETION_EVENT_NEWER_THAN_ACTIVE_TASK_ROW');
  assert.equal(completionFinding.status, 'UNRESOLVED');
  assert.ok(completionFinding.source.recordIds.eventIds.includes('event-completed'));
  assert.equal(completionFinding.evidence.ownerAuthorityVerified, false);
  assert.ok(mismatched.completionEventEvidence.matchingActiveTaskEventIds.includes('event-completed'),
    'task completion correlation must not lose older completion events behind more than 12 newer events');
  assert.ok(mismatched.tasks[0].eventLineage.eventIds.includes('event-completed'),
    'per-task event lineage must include correlated events outside the compact latest-12 display window');
  assert.equal(mismatched.tasks[0].eventLineage.truncated, false);
  assert.ok(report.recoveryPlan.find(item => item.jobId === 'job-stuck-terminal').observedIdentity.taskEventIds[0].eventIds.includes('event-completed'),
    'reconciliation identity must bind all task-correlated event IDs, not only the latest event window');
  assert.ok(report.recoveryPlan.find(item => item.jobId === 'job-stuck-terminal').observedIdentity.allJobEventIds.includes('event-noise-1'));
  const truncatedDb = new DatabaseSync(dbPath, { readOnly: true });
  const truncated = buildActiveWorkflowReconciliationReport(truncatedDb, { now: NOW, staleAfterMs: 900_000, limit: 3, procRoot: path.join(dir, 'proc') });
  truncatedDb.close();
  assert.equal(truncated.summary.consideredJobs, 3);
  assert.equal(truncated.summary.matchingJobCount, 6);
  assert.equal(truncated.summary.selectionTruncated, true, 'report must disclose when limit omits matching active/executing jobs');
  assert.equal(JSON.stringify(mismatched).includes('not copied'), false, 'diagnostics must not copy result content or approval raw text');

  assert.equal(jobs.get('job-live-lease').classification, 'lifecycle_reconciliation_required');
  assert.ok(jobs.get('job-live-lease').flags.includes('ACTIVE_LEASE_ATTEMPT_MISMATCH'));
  assert.ok(jobs.get('job-live-lease').flags.includes('ACTIVE_LEASE_JOB_TASK_LINEAGE_MISMATCH'));
  assert.ok(jobs.get('job-live-lease').flags.includes('ACTIVE_LEASE_OWNER_EPOCH_UNAVAILABLE'));
  assert.ok(jobs.get('job-live-lease').flags.includes('TASK_ATTEMPT_PROVIDER_RUN_ID_MISMATCH'));
  assert.ok(jobs.get('job-live-lease').flags.includes('RUNTIME_ATTEMPT_ACTIVE_TASK_MISMATCH'));
  assert.equal(jobs.get('job-live-lease').tasks[0].lineageAssessment.providerRunIdentityBinding, 'mismatch');
  assert.equal(jobs.get('job-live-lease').runtimeObservation.activeTaskAttemptMatchesRuntime, false);
  assert.equal(jobs.get('job-live-lease').activeLeaseCount, 1);
  assert.equal(jobs.get('job-live-lease-good').classification, 'lifecycle_reconciliation_required',
    'truncated history is an explicit reconciliation hold even when the active lease itself is found');
  assert.equal(jobs.get('job-live-lease-good').activeLeaseCount, 1,
    'an active lease older than five newer released rows must still be observed');
  assert.ok(!jobs.get('job-live-lease-good').flags.includes('RUNNING_TASKS_WITHOUT_ACTIVE_LEASES'));
  assert.ok(jobs.get('job-live-lease-good').flags.includes('TASK_LINEAGE_INVENTORY_TRUNCATED'),
    'truncated historical lease inventory is an explicit HOLD, not an implicit complete reconciliation');
  assert.equal(jobs.get('job-approved').classification, 'awaiting_dispatch');
  const plan = report.recoveryPlan.find(item => item.jobId === 'job-stuck-terminal');
  assert.equal(plan.action, 'HOLD_FOR_OWNER_RECONCILIATION');
  assert.equal(plan.authorizationGranted, false);
  assert.match(plan.idempotencyKey, /^reconcile-[a-f0-9]{64}$/);
  assert.ok(plan.prohibitedWithoutEvidenceAndAuthority.includes('terminalize'));
  assert.equal(plan.observedIdentity.resultIds[0], 'result-7');
  assert.equal(report.recoveryPlan.find(item => item.jobId === 'job-stuck-terminal').idempotencyKey, plan.idempotencyKey,
    'recovery plan identity key must be deterministic for the same observed lineage');
  const livePlan = report.recoveryPlan.find(item => item.jobId === 'job-live-lease');
  assert.equal(livePlan.observedIdentity.taskLineage[0].providerRunIdentityBinding, 'mismatch');
  assert.equal(livePlan.observedIdentity.taskLineage[0].leases[0].ownerEpoch, null);
  const writer = new DatabaseSync(dbPath);
  writer.prepare('UPDATE tasks SET openclaw_run_id=? WHERE task_id=?').run('run-live', 'task-live');
  writer.close();
  const changedDb = new DatabaseSync(dbPath, { readOnly: true });
  const changedReport = buildActiveWorkflowReconciliationReport(changedDb, { now: NOW, staleAfterMs: 900_000, limit: 20,
    procRoot: path.join(dir, 'proc') });
  changedDb.close();
  const changedLivePlan = changedReport.recoveryPlan.find(item => item.jobId === 'job-live-lease');
  assert.equal(changedLivePlan.observedIdentity.taskLineage[0].providerRunIdentityBinding, 'matching');
  assert.notEqual(changedLivePlan.idempotencyKey, livePlan.idempotencyKey,
    'recovery identity must change when provider-run lineage changes even if task/attempt row IDs remain constant');
});

test('executing-state reconciliation is case-insensitive, overrides inactive status metadata, and covers every rollout-counted executing job', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'executing-job-selection-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'workflow.db');
  writeFixture(dbPath);
  const writer = new DatabaseSync(dbPath);
  // This job has no tasks. Its lowercase state still counts as executing in
  // the rollout gate and therefore must not disappear from reconciliation.
  writer.prepare(`INSERT INTO jobs(job_id,conversation_key,title,state,status,active_task_id,provider_waiting,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run('job-lowercase-executing', 'conversation:lowercase-executing',
      'lowercase executing state with stale status', 'executing', 'completed', null, 0, OLD, OLD);
  const rolloutExecutingIds = writer.prepare("SELECT job_id FROM jobs WHERE UPPER(state)='EXECUTING'").all().map(row => row.job_id);
  writer.close();

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const report = buildActiveWorkflowReconciliationReport(db, {
    now: NOW, staleAfterMs: 900_000, limit: 20, procRoot: path.join(dir, 'proc')
  });
  db.close();

  assert.equal(report.summary.selectionTruncated, false);
  assert.equal(report.summary.matchingJobCount, report.summary.consideredJobs);
  const diagnostics = new Map(report.diagnostics.map(job => [job.jobId, job]));
  for (const jobId of rolloutExecutingIds) {
    assert.ok(diagnostics.has(jobId), `rollout-counted executing job ${jobId} must appear in an untruncated reconciliation report`);
  }
  for (const jobId of ['job-executing-status-mismatch', 'job-lowercase-executing']) {
    const job = diagnostics.get(jobId);
    assert.ok(job, `${jobId} must be inventoried`);
    assert.equal(job.classification, 'executing_state_status_inconsistent');
    assert.ok(job.flags.includes('EXECUTING_STATE_STATUS_INCONSISTENT'));
    const finding = job.findings.find(item => item.code === 'EXECUTING_STATE_STATUS_INCONSISTENT');
    assert.equal(finding?.gate, 'HOLD');
    assert.equal(finding?.authorizationGranted, false);
    assert.match(job.ownerAction, /Durable state says EXECUTING/);
  }
  assert.equal(diagnostics.get('job-stale')?.classification, 'stale_candidate_reconciliation_required',
    'a normally active executing job remains covered by the existing stale reconciliation classification');
});

test('reconciliation surfaces quarantined uncertain-remote-effect leases outside the recent lease window and never authorizes retry', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quarantined-lease-reconciliation-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'workflow.db');
  writeFixture(dbPath);
  const writer = new DatabaseSync(dbPath);
  const insertLease = writer.prepare(`INSERT INTO task_leases(lease_id,task_id,job_id,attempt,worker_id,state,issued_at,heartbeat_at,
    expires_at,released_at,last_error,owner_epoch) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  insertLease.run('lease-quarantined', 'task-completed', 'job-stuck-terminal', 1, 'worker-uncertain', 'FAILED', OLD, OLD,
    OLD, COMPLETE_EVENT, 'REMOTE_EFFECT_UNCERTAIN_REQUIRES_RECONCILIATION: provider status could not be confirmed', 7);
  writer.prepare('INSERT INTO events(event_id,job_id,type,payload_json,created_at) VALUES(?,?,?,?,?)').run(
    'event-lease-quarantined', 'job-stuck-terminal', 'task.lease.quarantined', JSON.stringify({
      taskId: 'task-completed', leaseId: 'lease-quarantined', attempt: 1, remoteEffect: 'uncertain', reconciliationRequired: true
    }), COMPLETE_EVENT);
  for (let index = 1; index <= 5; index++) {
    insertLease.run(`lease-newer-released-${index}`, 'task-completed', 'job-stuck-terminal', index + 1,
      `worker-released-${index}`, 'RELEASED', COMPLETE_EVENT, COMPLETE_EVENT, OLD, COMPLETE_EVENT, null, index + 1);
  }
  writer.close();

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const report = buildActiveWorkflowReconciliationReport(db, { now: NOW, staleAfterMs: 900_000, limit: 20, procRoot: path.join(dir, 'proc') });
  db.close();

  const job = report.diagnostics.find(item => item.jobId === 'job-stuck-terminal');
  const task = job.tasks.find(item => item.task.taskId === 'task-completed');
  assert.ok(task.flags.includes('QUARANTINED_TASK_LEASE_REQUIRES_RECONCILIATION'));
  assert.ok(task.leases.some(lease => lease.leaseId === 'lease-quarantined' && lease.state === 'FAILED'));
  assert.ok(!task.leases.slice(0, 5).some(lease => lease.leaseId === 'lease-quarantined'),
    'quarantined history row is deliberately outside the five newest lease rows');
  assert.ok(task.eventLineage.eventIds.includes('event-lease-quarantined'));
  assert.ok(task.eventLineage.quarantineEventIds.includes('event-lease-quarantined'));
  assert.ok(task.lineageAssessment.quarantinedLeaseIds.includes('lease-quarantined'));
  const finding = job.findings.find(item => item.code === 'QUARANTINED_TASK_LEASE_REQUIRES_RECONCILIATION');
  assert.equal(finding.status, 'UNRESOLVED');
  assert.equal(finding.gate, 'HOLD');
  assert.equal(finding.authorizationGranted, false);
  assert.ok(finding.source.recordIds.leaseIds.includes('lease-quarantined'));
  assert.ok(finding.source.recordIds.eventIds.includes('event-lease-quarantined'));
  assert.match(finding.remediation, /do not retry, release, or terminalize automatically/);
  assert.equal(report.readOnly, true);
});

test('Goal/Idea diagnostics reproduce the canonical live snapshot hash but never treat a stored binding as signature authority', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = createAdaptiveGoalKnowledgeStore(db);
  const provenance = { source: 'test-fixture', actor: 'reconciliation-test' };
  const goal = store.saveNode({ goalId: 'goal-a', stableKey: 'goal-a', type: 'goal', content: { label: 'Goal A' }, provenance });
  const idea = store.saveNode({ goalId: 'goal-a', stableKey: 'idea-a', type: 'idea', content: { label: 'Idea A' }, provenance });
  store.addEdge({ goalId: 'goal-a', fromId: idea.id, toId: goal.id, type: 'supports', provenance, evidenceRefs: [] });

  const expected = store.snapshotForGoal('goal-a');
  const report = buildAdaptiveGoalGraphIntegrityReport(db);
  assert.equal(report.available, true);
  assert.equal(report.status, 'NO_STRUCTURAL_FINDINGS');
  assert.equal(report.counts.nodes, 2);
  assert.equal(report.counts.revisions, 2);
  assert.equal(report.counts.memberships, 2);
  assert.equal(report.counts.edges, 1);
  assert.equal(report.findings.length, 0);
  assert.equal(report.goals[0].snapshotHash, expected.snapshot_hash,
    'read-only diagnostics must independently reproduce the canonical store snapshot hash byte-for-byte');
  assert.equal(report.goals[0].planningAuthority, 'NOT_ESTABLISHED_BY_READ_ONLY_DIAGNOSTICS');
  assert.equal(report.goals[0].evidenceAssessment.status, 'BLOCKED');
  assert.equal(report.goals[0].evidenceAssessment.declaredReferenceCount, 0);
  assert.equal(report.goals[0].evidenceAssessment.eligibleForExternalAttestation, false);
  assert.ok(report.goals[0].evidenceAssessment.blockers.some(item => item.code === 'KNOWLEDGE_EVIDENCE_MANIFEST_EMPTY'));
  assert.equal(report.summary.goalsWithEvidenceIneligible, 1);
  assert.equal(report.policy.signatureVerificationAttempted, false);
  assert.equal(report.summary.planningAuthorityEstablished, false);

  const sourcePath = path.join(ROOT, 'src/runtime/adaptive-goal-knowledge-store.js');
  const sourceRef = `file:src/runtime/adaptive-goal-knowledge-store.js#sha256=${sha(fs.readFileSync(sourcePath))}`;
  store.saveNode({ goalId: 'goal-source-evidence', stableKey: 'source-backed-goal', type: 'goal',
    content: { label: 'Source-backed diagnostic fixture' }, provenance, evidenceRefs: [sourceRef] });
  const sourceEvidenceReport = buildAdaptiveGoalGraphIntegrityReport(db);
  const sourceEvidenceGoal = sourceEvidenceReport.goals.find(item => item.goalId === 'goal-source-evidence');
  assert.equal(sourceEvidenceGoal.evidenceAssessment.status, 'EVIDENCE_MATERIAL_ELIGIBLE_FOR_EXTERNAL_ATTESTATION');
  assert.equal(sourceEvidenceGoal.evidenceAssessment.eligibleForExternalAttestation, true,
    'matching content-addressed source bytes establish evidence material integrity only, not claim truth or independence');
  assert.equal(sourceEvidenceGoal.evidenceAssessment.references[0].status, 'source_bytes_verified_claim_unverified');
  assert.equal(sourceEvidenceGoal.evidenceAssessment.claimTruthVerified, false);
  assert.equal(sourceEvidenceGoal.evidenceAssessment.independenceVerified, false);
  assert.equal(sourceEvidenceGoal.evidenceAssessment.cryptographicSignatureVerificationAttempted, false);

  const fakePayload = { evidence_manifest_hash: 'a'.repeat(64), goal_id: 'goal-a', nonce: 'fixture-nonce',
    provider_id: 'fixture-provider', signature: 'intentionally-not-verified', snapshot_hash: '0'.repeat(64) };
  const fakeId = sha(`${fakePayload.goal_id}|${fakePayload.snapshot_hash}|${fakePayload.provider_id}|${fakePayload.nonce}|${fakePayload.evidence_manifest_hash}`);
  db.prepare(`INSERT INTO adaptive_goal_knowledge_verifications
    (attestation_id,goal_id,snapshot_hash,provider_id,nonce,payload_json,created_at,configuration_fingerprint,trust_key_id,
     trust_config_version,configuration_source,config_change_reference) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    fakeId, fakePayload.goal_id, fakePayload.snapshot_hash, fakePayload.provider_id, fakePayload.nonce,
    JSON.stringify(fakePayload), NOW, 'b'.repeat(64), 'fake-key', 1, 'fixture', 'fixture-only');
  const stale = buildAdaptiveGoalGraphIntegrityReport(db).goals[0].attestations[0];
  assert.equal(stale.identityValid, true, 'record identity is only one integrity check, not signature verification');
  assert.equal(stale.snapshotFresh, false);
  assert.equal(stale.bindingStatus, 'stale_snapshot');
  assert.equal(stale.signatureVerification, 'not_attempted_requires_host_owned_trust_configuration');
});

test('historical planner source mismatches stay redacted by default and become exactly actionable only with explicit sensitive-output opt-in', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  createAdaptiveGoalKnowledgeStore(db);
  db.exec(`
    CREATE TABLE adaptive_goal_planner_runs(run_id TEXT PRIMARY KEY,tool_name TEXT,status TEXT,started_at TEXT,finished_at TEXT,
      goal_id TEXT,input_graph_sha256 TEXT,graph_hash TEXT,candidate_count INTEGER,partial_candidate_count INTEGER,
      search_event_count_recorded INTEGER,search_event_count_omitted INTEGER,search_events_truncated INTEGER,error_code TEXT,
      provenance_json TEXT,process_instance_id TEXT,schema_version INTEGER,goal_node_id TEXT,observed_node_count INTEGER,observed_edge_count INTEGER);
    CREATE TABLE adaptive_goal_planner_run_evidence(run_id TEXT,artifact_id TEXT,source_job_id TEXT,classification TEXT,
      lineage_verified INTEGER,claim_verified INTEGER,content_hash TEXT,reference TEXT,source_node_id TEXT,observation_source TEXT,
      kind TEXT,details_json TEXT);
  `);
  const sourcePath = path.join(ROOT, 'src/runtime/adaptive-goal-knowledge-store.js');
  const sourceRef = `file:src/runtime/adaptive-goal-knowledge-store.js#sha256=${'0'.repeat(64)}`;
  db.prepare(`INSERT INTO adaptive_goal_planner_runs(run_id,tool_name,status,started_at,finished_at,goal_id,input_graph_sha256,
    graph_hash,candidate_count,partial_candidate_count,search_event_count_recorded,search_event_count_omitted,search_events_truncated,
    error_code,provenance_json,process_instance_id,schema_version,goal_node_id,observed_node_count,observed_edge_count)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('planner-source-mismatch', 'adaptive_goal_graph_search', 'completed',
      NOW, NOW, null, sha('input'), sha('graph'), 0, 0, 0, 0, 0, null, '{}', null, 2, 'fixture', 0, 0);
  db.prepare(`INSERT INTO adaptive_goal_planner_run_evidence(run_id,artifact_id,source_job_id,classification,lineage_verified,
    claim_verified,content_hash,reference,source_node_id,observation_source,kind,details_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('planner-source-mismatch', null, null, 'source_bytes_verified_claim_unverified', 0, 0, null, sourceRef, null,
      'runtime_resolver', 'source', '{}');
  const observedSourceHash = sha(fs.readFileSync(sourcePath));
  const conflictingDetailsRef = `file:src/runtime/adaptive-goal-knowledge-store.js#sha256=${observedSourceHash}`;
  db.prepare(`INSERT INTO adaptive_goal_planner_run_evidence(run_id,artifact_id,source_job_id,classification,lineage_verified,
    claim_verified,content_hash,reference,source_node_id,observation_source,kind,details_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('planner-source-mismatch', null, null, 'source_bytes_verified_claim_unverified', 1, 0, null, conflictingDetailsRef, null,
      'runtime_resolver', 'source', JSON.stringify({ sourceBytesSha256: 'f'.repeat(64) }));

  const redacted = buildAdaptiveGoalGraphIntegrityReport(db);
  const redactedEvidence = redacted.plannerRuns[0].evidence[0];
  assert.equal(redactedEvidence.revalidation, 'source_hash_mismatch');
  assert.equal(redacted.plannerRuns[0].evidence.length, 2);
  assert.equal(Object.hasOwn(redactedEvidence, 'sourceReference'), false,
    'sensitive file references must not leak into routine diagnostics');
  assert.equal(redacted.plannerRuns[0].evidence[1].revalidation, 'source_bytes_verified_claim_unverified');
  assert.deepEqual(redacted.plannerRuns[0].evidence[1].blockers, ['PLANNER_SOURCE_EVIDENCE_DECLARED_DIGEST_CONFLICT'],
    'matching source bytes do not clear an immutable mismatch between URI and stored evidence digest');
  assert.equal(redacted.findings.some(item => item.code === 'PLANNER_SOURCE_BYTES_REPORTED_VERIFIED_BUT_CURRENT_SOURCE_INVALID'), true,
    'a contradictory declared digest must produce a durable reconciliation finding');
  assert.equal(redacted.policy.sensitiveSourceIdentifiersIncluded, false);

  const actionable = buildAdaptiveGoalGraphIntegrityReport(db, { includeSensitiveSourceIdentifiers: true });
  const actionableEvidence = actionable.plannerRuns[0].evidence[0];
  assert.equal(actionableEvidence.sourceReference, sourceRef);
  assert.equal(actionableEvidence.expectedSourceSha256, '0'.repeat(64));
  assert.equal(actionableEvidence.observedSourceSha256, sha(fs.readFileSync(sourcePath)));
  assert.equal(actionableEvidence.sourceResolutionStatus, 'source_hash_mismatch');
  const actionableConflict = actionable.plannerRuns[0].evidence[1];
  assert.equal(actionableConflict.uriSourceSha256, observedSourceHash);
  assert.equal(actionableConflict.detailSourceSha256, 'f'.repeat(64));
  assert.equal(actionableConflict.expectedSourceSha256, 'f'.repeat(64));
  assert.equal(actionableConflict.observedSourceSha256, observedSourceHash);
  assert.equal(actionable.policy.sensitiveSourceIdentifiersIncluded, true);
  assert.equal(actionable.policy.sensitiveSourceIdentifiersRequireExplicitOptIn, true);
  assert.equal(actionable.plannerRuns[0].evidence[0].claimTruthVerified, false);
  assert.equal(actionable.plannerRuns[0].evidence[0].independenceVerified, false);
});

test('Goal/Idea diagnostics identify revision hash substitution, provenance corruption and invalid recovery contracts', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = createAdaptiveGoalKnowledgeStore(db);
  const provenance = { source: 'test-fixture', actor: 'reconciliation-test' };
  const goal = store.saveNode({ goalId: 'goal-b', stableKey: 'goal-b', type: 'goal', content: { label: 'Goal B' }, provenance });
  const experiment = store.saveNode({ goalId: 'goal-b', stableKey: 'experiment-b', type: 'experiment', content: { label: 'Experiment B' }, provenance });
  const condition = store.saveNode({ goalId: 'goal-b', stableKey: 'condition-b', type: 'condition', content: { label: 'Condition B' }, provenance });
  store.saveNode({ goalId: 'goal-b', stableKey: 'evidence-b', type: 'evidence', content: { label: 'Evidence B' }, provenance,
    evidenceRefs: ['artifact://evidence'] });
  const edge = store.addEdge({ goalId: 'goal-b', fromId: experiment.id, toId: condition.id, type: 'recovers_to', provenance,
    condition: { when: 'failed', predicate: 'required_evidence_available' },
    outcome: { state: 'recovered', effects: ['reconcile'], evidenceRefs: ['artifact://evidence'] }, evidenceRefs: ['artifact://evidence'] });

  db.exec('DROP TRIGGER adaptive_goal_knowledge_revisions_no_update');
  db.prepare('UPDATE adaptive_goal_knowledge_revisions SET content_json=? WHERE node_id=? AND revision=1')
    .run('{"label":"tampered after save"}', goal.id);
  db.prepare('UPDATE adaptive_goal_knowledge_revisions SET provenance_json=? WHERE node_id=? AND revision=1')
    .run('{"actor":"attacker","extra":"forged","source":"test-fixture"}', experiment.id);
  db.exec('DROP TRIGGER adaptive_goal_knowledge_edges_no_update');
  db.prepare('UPDATE adaptive_goal_knowledge_edges SET outcome_json=? WHERE edge_id=?')
    .run('{"effects":[],"evidenceRefs":[],"state":"recovered"}', edge.edgeId);

  const report = buildAdaptiveGoalGraphIntegrityReport(db);
  const codes = new Set(report.findings.map(item => item.code));
  assert.equal(report.status, 'STRUCTURAL_FINDINGS');
  assert.ok(codes.has('KNOWLEDGE_REVISION_CONTENT_HASH_MISMATCH'));
  assert.ok(codes.has('KNOWLEDGE_REVISION_PROVENANCE_NONCANONICAL') || codes.has('KNOWLEDGE_REVISION_CONTENT_OR_PROVENANCE_INVALID'));
  assert.ok(codes.has('KNOWLEDGE_RECOVERY_EDGE_CONTRACT_INVALID'));
  assert.equal(report.goals[0].graphIntegrity, 'INVALID');
  assert.equal(report.goals[0].evidenceAssessment.status, 'BLOCKED');
  assert.ok(report.goals[0].evidenceAssessment.blockers.some(item => item.code === 'KNOWLEDGE_ACTION_EVIDENCE_MISSING'));
  assert.ok(report.goals[0].evidenceAssessment.blockers.some(item => item.code === 'KNOWLEDGE_ARTIFACT_EVIDENCE_UNRESOLVED'));
});

test('planner evidence reconciliation revalidates stored artifact bytes, producer contract and exact result-attempt-completion lineage', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE artifacts(artifact_id TEXT PRIMARY KEY,job_id TEXT,task_id TEXT,kind TEXT,uri TEXT,metadata_json TEXT,
      created_at TEXT,schema_version INTEGER,producer_role TEXT,content TEXT,evidence_json TEXT,status TEXT,supersedes TEXT,content_hash TEXT);
    CREATE TABLE tasks(task_id TEXT PRIMARY KEY,job_id TEXT,role TEXT,status TEXT);
    CREATE TABLE results(result_id TEXT PRIMARY KEY,task_id TEXT,outcome TEXT,created_at TEXT);
    CREATE TABLE attempts(attempt_id TEXT PRIMARY KEY,task_id TEXT,status TEXT,openclaw_run_id TEXT,started_at TEXT,finished_at TEXT,error TEXT);
    CREATE TABLE events(event_id TEXT PRIMARY KEY,job_id TEXT,type TEXT,payload_json TEXT,created_at TEXT);
  `);
  const jobId = 'job_lineage_fixture';
  const taskId = 'task-producer';
  const resultId = 'result-producer';
  const attemptId = 'attempt-producer';
  const artifactId = 'artifact-producer';
  const startedAt = '2026-10-26T01:00:00.000Z';
  const resultAt = '2026-10-26T02:00:00.000Z';
  const attemptFinishedAt = '2026-10-26T02:05:00.000Z';
  const completionAt = '2026-10-26T02:10:00.000Z';
  const artifactAt = '2026-10-26T02:20:00.000Z';
  const content = JSON.stringify({ summary: 'fixture implementation artifact', files_changed: [], verification: ['fixture schema verified'],
    execution: { exit_code: 0, session_id: 'fixture-session' } });
  const contentHash = sha(content);
  db.prepare('INSERT INTO tasks(task_id,job_id,role,status) VALUES(?,?,?,?)')
    .run(taskId, jobId, 'engineer', 'completed');
  db.prepare('INSERT INTO results(result_id,task_id,outcome,created_at) VALUES(?,?,?,?)')
    .run(resultId, taskId, 'success', resultAt);
  db.prepare('INSERT INTO attempts(attempt_id,task_id,status,openclaw_run_id,started_at,finished_at,error) VALUES(?,?,?,?,?,?,?)')
    .run(attemptId, taskId, 'completed', null, startedAt, attemptFinishedAt, null);
  db.prepare(`INSERT INTO artifacts(artifact_id,job_id,task_id,kind,uri,metadata_json,created_at,schema_version,
    producer_role,content,evidence_json,status,supersedes,content_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    artifactId, jobId, taskId, 'implementation', `artifact://${artifactId}`, '{"schema_version":1}', artifactAt, 1,
    'engineer', content, JSON.stringify([resultId]), 'active', null, contentHash);
  const completionPayload = { attemptId, executor: 'chat-on-steroids-plugin', resultId, taskId };
  const completionEventId = sha(`${jobId}|task.local_completed|${resultId}`);
  db.prepare('INSERT INTO events(event_id,job_id,type,payload_json,created_at) VALUES(?,?,?,?,?)').run(
    completionEventId, jobId, 'task.local_completed', JSON.stringify(completionPayload), completionAt);
  const artifactEventId = sha(`${jobId}|artifact.created|${artifactId}`);
  const artifactPayload = { artifactId, taskId, type: 'implementation', status: 'active', supersedes: null, contentHash };
  db.prepare('INSERT INTO events(event_id,job_id,type,payload_json,created_at) VALUES(?,?,?,?,?)').run(
    artifactEventId, jobId, 'artifact.created', JSON.stringify(artifactPayload), artifactAt);

  const evidence = { reference: `artifact://${artifactId}`, artifact_id: artifactId, source_job_id: jobId,
    content_hash: contentHash, classification: 'durable_artifact_lineage_verified_claim_unverified', lineage_verified: 1, claim_verified: 0 };
  const good = revalidatePlannerEvidenceLineage(db, evidence);
  assert.equal(good.valid, true, JSON.stringify(good.blockers));
  assert.equal(good.status, 'revalidated_durable_lineage_valid');
  assert.equal(good.producerResultId, resultId);
  assert.equal(good.producerAttemptId, attemptId);
  assert.equal(good.producerCompletionEventId, completionEventId);
  assert.equal(good.claimTruthVerified, false);
  assert.equal(good.independenceVerified, false);

  // An attacker can replace artifact bytes and recompute the self-reported
  // content hash. Even if the artifact-created event is updated to match those
  // bytes, the durable typed producer schema must still fail closed.
  const schemaInvalidContent = JSON.stringify({ summary: 'self-hashed but schema-invalid' });
  const schemaInvalidHash = sha(schemaInvalidContent);
  evidence.content_hash = schemaInvalidHash;
  db.prepare('UPDATE artifacts SET content=?,content_hash=? WHERE artifact_id=?')
    .run(schemaInvalidContent, schemaInvalidHash, artifactId);
  const schemaInvalidEvent = { ...artifactPayload, contentHash: schemaInvalidHash };
  db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(JSON.stringify(schemaInvalidEvent), artifactEventId);
  const schemaInvalid = revalidatePlannerEvidenceLineage(db, evidence);
  assert.equal(schemaInvalid.valid, false);
  assert.ok(schemaInvalid.blockers.some(item => item.code === 'PLANNER_EVIDENCE_ARTIFACT_SCHEMA_INVALID'));
  assert.ok(!schemaInvalid.blockers.some(item => item.code === 'PLANNER_EVIDENCE_ARTIFACT_CONTENT_HASH_MISMATCH'),
    'the adversarial fixture must have internally matching bytes/hash');

  db.prepare('UPDATE artifacts SET content=? WHERE artifact_id=?').run('{"implementation":"substituted bytes"}', artifactId);
  db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(JSON.stringify(artifactPayload), artifactEventId);
  const tamperedBytes = revalidatePlannerEvidenceLineage(db, evidence);
  assert.equal(tamperedBytes.valid, false);
  assert.ok(tamperedBytes.blockers.some(item => item.code === 'PLANNER_EVIDENCE_ARTIFACT_CONTENT_HASH_MISMATCH'));

  db.prepare('UPDATE artifacts SET content=?,content_hash=? WHERE artifact_id=?').run(content, contentHash, artifactId);
  evidence.content_hash = contentHash;
  db.prepare('UPDATE events SET payload_json=? WHERE event_id=?')
    .run(JSON.stringify({ attemptId, executor: 'chat-on-steroids-plugin', resultId: 'result-substituted', taskId }), completionEventId);
  const tamperedLineage = revalidatePlannerEvidenceLineage(db, evidence);
  assert.equal(tamperedLineage.valid, false);
  assert.ok(tamperedLineage.blockers.some(item => item.code === 'PLANNER_EVIDENCE_COMPLETION_EVENT_SUBSTITUTION'));
});

test('proposal diagnostics inventory the actual persisted event payload and detect internal fingerprint substitution without granting authority', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  createAdaptiveGoalKnowledgeStore(db);
  db.exec(`CREATE TABLE jobs(job_id TEXT PRIMARY KEY,state TEXT,status TEXT);
    CREATE TABLE events(event_id TEXT PRIMARY KEY,job_id TEXT,type TEXT,payload_json TEXT,created_at TEXT);
    INSERT INTO jobs(job_id,state,status) VALUES('job-plan-proposal','PROPOSED','active');`);
  const source = { candidate_plan_id: `agg-${'1'.repeat(24)}`, graph_hash: sha('graph'), draft_hash: sha('draft'),
    verification: { status: 'unverified', verified: false } };
  const draft = { draftHash: source.draft_hash, steps: Array.from({ length: 9 }, (_, index) => ({
    id: `agg-step-${index.toString(16).padStart(24, '0')}`, sourceNodeId: `task-${index}`,
    dependencies: [], supportingEvidenceRefs: [], evidenceAssessment: { status: 'missing', references: [], verifiedReferenceCount: 0 }
  })) };
  const workspace = { root: '/fixture/workspace' };
  const projectionOptions = { requireCompleteTaskMapping: true };
  const bindingHash = sha('bindings');
  const fields = { schemaVersion: 1, workflowId: 'standard-engineering', workspace,
    candidatePlanId: source.candidate_plan_id, draftHash: source.draft_hash, bindingHash, projectionOptions };
  const planProposal = { schema_version: 1, fingerprint: sha(JSON.stringify(fields)), source,
    workflow_template: { id: 'standard-engineering', version: 1, compatibility_preview_plan_hash: sha('template') },
    binding_hash: bindingHash, bindings: [], source_graph: { nodes: Array.from({ length: 9 }, (_, index) => ({ id: `task-${index}`, type: 'experiment' })), edges: [] }, projection_options: projectionOptions,
    compatibility: { status: 'review_required' }, draft };
  const eventPayload = { workspace, workflowId: 'standard-engineering', adaptive_goal_plan_proposal: planProposal };
  db.prepare('INSERT INTO events(event_id,job_id,type,payload_json,created_at) VALUES(?,?,?,?,?)').run(
    sha('proposal-event'), 'job-plan-proposal', 'job.proposal_requested', JSON.stringify(eventPayload), NOW);

  const first = buildAdaptiveGoalGraphIntegrityReport(db);
  assert.equal(first.proposalSummary.planGraphProposals, 1);
  assert.equal(first.proposalSummary.executionGraphProposals, 0);
  assert.equal(first.proposalFindings.length, 0);
  assert.equal(first.proposalRecords[0].checks.fingerprintMatchesStoredFields, true);
  assert.equal(first.proposalRecords[0].sourceVerificationStatus, 'unverified');
  assert.equal(first.proposalRecords[0].authorizationGranted, false);
  assert.equal(first.proposalRecords[0].readinessAssessment.status, 'BLOCKED');
  assert.equal(first.proposalRecords[0].readinessAssessment.missingEvidenceStepCount, 9);
  assert.equal(first.proposalRecords[0].stepEvidenceAssessments.length, 9);
  assert.equal(first.proposalRecords[0].readinessFindings.filter(item => item.code === 'STEP_EVIDENCE_MISSING').length, 9);
  assert.ok(first.proposalRecords[0].readinessFindings.some(item => item.code === 'GOAL_IDEA_SOURCE_VERIFICATION_NOT_AUTHENTICATED'));
  assert.ok(first.proposalRecords[0].readinessFindings.some(item => item.code === 'GOAL_IDEA_SOURCE_VERIFICATION_NOT_INDEPENDENTLY_REVALIDATED'));
  assert.ok(first.proposalRecords[0].readinessFindings.some(item => item.code === 'GOAL_IDEA_SNAPSHOT_BINDING_MISSING'));
  assert.equal(first.proposalRecords[0].checks.knowledgeSnapshotBound, false);
  assert.equal(first.proposalRecords[0].checks.sourceVerificationMetadataComplete, false);
  assert.equal(first.proposalSummary.planGraphProposalsWithInvalidSourceLineage, 0);
  assert.equal(first.proposalRecords[0].sourceLineage.valid, true);
  assert.equal(first.proposalSummary.planGraphStepsObserved, 9);
  assert.equal(first.proposalSummary.planGraphStepsMissingEvidence, 9);
  assert.equal(first.proposalSummary.planGraphProposalsWithoutAuthenticatedSnapshotBinding, 1);
  assert.equal(first.proposalSummary.planGraphProposalsWithUnverifiedSource, 1);
  assert.equal(first.proposalSummary.planGraphProposalsWithoutIndependentSourceRevalidation, 1);
  assert.equal(first.proposalRecords[0].readinessAssessment.evidenceLineageRevalidationPerformed, false,
    'read-only proposal diagnostics must not claim runtime evidence lineage validation');

  const executionGraph = {
    schemaVersion: 1, fingerprint: 'execution-fingerprint', proposalHash: 'execution-proposal-hash',
    source: { planProposalJobId: 'job-plan-proposal', planProposalFingerprint: planProposal.fingerprint,
      candidatePlanId: source.candidate_plan_id, graphHash: source.graph_hash, draftHash: source.draft_hash,
      verification: { status: 'unverified', verified: false } },
    nodes: draft.steps.map(step => ({ sourceStepId: step.id })), gates: { dispatchAllowed: false, executionAuthorized: false }
  };
  const executionSnapshot = { schema_version: 1, fingerprint: executionGraph.fingerprint, proposal_hash: executionGraph.proposalHash,
    source_plan_proposal_job_id: 'job-plan-proposal', task_bindings: draft.steps.map((step, index) => ({
      step_id: step.id, task_id: `task-${index}`, capability: 'test.capability'
    })), execution_graph_proposal: executionGraph };
  db.prepare('INSERT INTO jobs(job_id,state,status) VALUES(?,?,?)').run('job-execution-proposal', 'PROPOSED', 'active');
  db.prepare('INSERT INTO events(event_id,job_id,type,payload_json,created_at) VALUES(?,?,?,?,?)').run(
    sha('execution-proposal-event'), 'job-execution-proposal', 'job.proposal_requested',
    JSON.stringify({ workspace, workflowId: 'standard-engineering', adaptive_goal_execution_graph_proposal: executionSnapshot }), NOW);
  const crossGraph = buildAdaptiveGoalGraphIntegrityReport(db);
  const executionRecord = crossGraph.proposalRecords.find(item => item.kind === 'execution_graph_proposal');
  assert.ok(executionRecord);
  assert.equal(executionRecord.crossGraphConsistency.checks.sourcePlanProposalResolvedUniquely, true);
  assert.equal(executionRecord.crossGraphConsistency.checks.taskBindingsExactlyCoverPlanSteps, true);
  assert.equal(executionRecord.crossGraphConsistency.status, 'BLOCKED',
    'internally linked proposals still block when no authenticated current Goal/Idea snapshot binding exists');

  const danglingSnapshot = structuredClone(executionSnapshot);
  danglingSnapshot.source_plan_proposal_job_id = 'job-missing-plan';
  danglingSnapshot.execution_graph_proposal.source.planProposalJobId = 'job-missing-plan';
  db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(JSON.stringify({
    workspace, workflowId: 'standard-engineering', adaptive_goal_execution_graph_proposal: danglingSnapshot
  }), sha('execution-proposal-event'));
  const dangling = buildAdaptiveGoalGraphIntegrityReport(db);
  assert.ok(dangling.proposalFindings.some(item => item.code === 'AGG_EXECUTION_GRAPH_SOURCE_PLAN_LINKAGE_INVALID' &&
    item.failedChecks.includes('sourcePlanProposalResolvedUniquely')));

  const tamperedPayload = structuredClone(eventPayload);
  tamperedPayload.adaptive_goal_plan_proposal.source.candidate_plan_id = `agg-${'2'.repeat(24)}`;
  db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(JSON.stringify(tamperedPayload), sha('proposal-event'));
  const second = buildAdaptiveGoalGraphIntegrityReport(db);
  assert.ok(second.proposalFindings.some(item => item.code === 'AGG_PLAN_GRAPH_PROPOSAL_INTERNAL_BINDING_INVALID'));
  assert.equal(second.summary.planningAuthorityEstablished, false);

  const badSourceLineage = structuredClone(eventPayload);
  badSourceLineage.adaptive_goal_plan_proposal.draft.steps[0].sourceNodeId = 'task-not-in-source-graph';
  badSourceLineage.adaptive_goal_plan_proposal.draft.steps[1].dependencies = ['step-not-in-proposal'];
  badSourceLineage.adaptive_goal_plan_proposal.draft.steps[2].dependencies = [badSourceLineage.adaptive_goal_plan_proposal.draft.steps[8].id];
  badSourceLineage.adaptive_goal_plan_proposal.source_graph.edges = [{ from: 'task-3', to: 'task-4', type: 'requires_all' }];
  db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(JSON.stringify(badSourceLineage), sha('proposal-event'));
  const third = buildAdaptiveGoalGraphIntegrityReport(db);
  assert.ok(third.proposalFindings.some(item => item.code === 'AGG_PLAN_GRAPH_PROPOSAL_SOURCE_LINEAGE_INVALID' &&
    item.reason === 'PLAN_STEP_SOURCE_NODE_UNRESOLVED' && item.sourceNodeId === 'task-not-in-source-graph'));
  assert.ok(third.proposalFindings.some(item => item.code === 'AGG_PLAN_GRAPH_PROPOSAL_SOURCE_LINEAGE_INVALID' &&
    item.reason === 'PLAN_STEP_DEPENDENCY_UNRESOLVED' && item.dependencyId === 'step-not-in-proposal'));
  assert.ok(third.proposalFindings.some(item => item.code === 'AGG_PLAN_GRAPH_PROPOSAL_SOURCE_LINEAGE_INVALID' &&
    item.reason === 'PLAN_STEP_DEPENDENCY_ORDER_INVALID'));
  assert.ok(third.proposalFindings.some(item => item.code === 'AGG_PLAN_GRAPH_PROPOSAL_SOURCE_LINEAGE_INVALID' &&
    item.reason === 'SOURCE_GRAPH_PREREQUISITE_NOT_PROJECTED' && item.prerequisiteNodeId === 'task-3' && item.dependentNodeId === 'task-4'));
  assert.equal(third.proposalSummary.planGraphProposalsWithInvalidSourceLineage, 1);
  const thirdPlanRecord = third.proposalRecords.find(item => item.kind === 'plan_graph_proposal');
  assert.equal(thirdPlanRecord.sourceLineage.valid, false);
  assert.equal(thirdPlanRecord.readinessAssessment.status, 'BLOCKED');

  const omittedAction = structuredClone(eventPayload);
  omittedAction.adaptive_goal_plan_proposal.draft.steps = omittedAction.adaptive_goal_plan_proposal.draft.steps
    .filter(step => step.sourceNodeId !== 'task-0');
  db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(JSON.stringify(omittedAction), sha('proposal-event'));
  const omittedActionReport = buildAdaptiveGoalGraphIntegrityReport(db);
  assert.ok(omittedActionReport.proposalFindings.some(item => item.code === 'AGG_PLAN_GRAPH_PROPOSAL_SOURCE_LINEAGE_INVALID' &&
    item.reason === 'SOURCE_ACTION_NODE_NOT_PROJECTED' && item.sourceNodeId === 'task-0'),
  'a proposal must not silently omit a source action node even if all remaining step references resolve');
});

test('CLI writes an exclusive diagnostic report, refuses overwrite and rejects symlinked database paths', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'active-workflow-reconciliation-cli-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'workflow.db');
  writeFixture(dbPath);
  const beforeHash = sha(fs.readFileSync(dbPath));
  const outPath = path.join(dir, 'reconciliation.json');
  const run = spawnSync(process.execPath, [CLI, '--db', dbPath, '--stale-after-ms', '900000', '--limit', '20', '--out', outPath],
    { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const envelope = JSON.parse(run.stdout);
  assert.equal(envelope.result, 'PASS');
  assert.equal(envelope.readOnly, true);
  assert.match(envelope.reportSha256, /^[a-f0-9]{64}$/);
  const report = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(report.dbPath, dbPath);
  assert.equal(report.summary.jobsFlaggedForReconciliation, 5);
  assert.equal(report.summary.selectionTruncated, false);
  assert.equal(fs.statSync(outPath).mode & 0o777, 0o600);
  const duplicate = spawnSync(process.execPath, [CLI, '--db', dbPath, '--out', outPath], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stderr, /RECONCILIATION_OUTPUT_EXISTS/);

  const alias = path.join(dir, 'workflow-alias.db');
  fs.symlinkSync(dbPath, alias);
  const symlink = spawnSync(process.execPath, [CLI, '--db', alias], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
  assert.equal(symlink.status, 2);
  assert.match(symlink.stderr, /RECONCILIATION_DB_PATH_UNSAFE/);
  assert.equal(sha(fs.readFileSync(dbPath)), beforeHash, 'CLI must never mutate the source database');
});

test('rejects malformed bounds and unknown jobs without opening a writable connection', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'active-workflow-reconciliation-invalid-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'workflow.db');
  writeFixture(dbPath);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  assert.throws(() => buildActiveWorkflowReconciliationReport(db, { limit: 201, now: NOW }), /RECONCILIATION_LIMIT_INVALID/);
  assert.throws(() => buildActiveWorkflowReconciliationReport(db, { staleAfterMs: 1000, now: NOW }), /RECONCILIATION_STALE_AFTER_INVALID/);
  assert.throws(() => buildActiveWorkflowReconciliationReport(db, { jobId: 'missing-job', now: NOW }), /RECONCILIATION_JOB_NOT_FOUND/);
  db.close();
});

test('rejects reduced schemas with a precise missing-column contract', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'active-workflow-reconciliation-schema-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'workflow.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE jobs(job_id TEXT,state TEXT); CREATE TABLE tasks(task_id TEXT,job_id TEXT,status TEXT,created_at TEXT,updated_at TEXT); CREATE TABLE events(event_id TEXT,job_id TEXT,type TEXT,payload_json TEXT,created_at TEXT);');
  assert.throws(() => buildActiveWorkflowReconciliationReport(db, { now: NOW }), error =>
    error.code === 'RECONCILIATION_SCHEMA_UNSUPPORTED' && /jobs is missing required columns: status, created_at, updated_at/.test(error.message));
  db.close();
});
