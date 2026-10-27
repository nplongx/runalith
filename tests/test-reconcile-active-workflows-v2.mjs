import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import './test-external-trust-checkpoint-contract.mjs';
import { buildActiveWorkflowReconciliationReport } from '../scripts/reconcile-active-workflows-v2.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts/reconcile-active-workflows-v2.mjs');
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
    CREATE TABLE workflow_plans(job_id TEXT PRIMARY KEY,workflow_id TEXT,workflow_version INTEGER,plan_hash TEXT,plan_json TEXT,created_at TEXT);
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
  insertTask.run('task-stale', activeStale, 'researcher', 'running', null, null, null, '[]', '{}', OLD, OLD, null, null, 0, null, null, null);
  insertEvent.run('event-stale', activeStale, 'task.dispatched', JSON.stringify({ taskId: 'task-stale', role: 'researcher',
    attemptId: 'attempt-does-not-exist', resultId: 'result-does-not-exist', artifactId: 'artifact-does-not-exist' }), OLD);
  insertArtifact.run('artifact-stale-mismatch', 'other-job', 'task-stale', 'architecture', 'artifact://mismatch', '{}', OLD, 1, 'architect',
    '{"components":[]}', '[]', 'active', null, sha('mismatched-artifact'));

  insertJob.run('job-stuck-terminal', 'conversation:complete', 'all tasks completed but job remains executing', 'EXECUTING', 'active', 'task-completed', 0, OLD, OLD);
  insertJob.run('job-hierarchy-conflict', 'conversation:hierarchy', 'dependency and parent lineage conflicts', 'EXECUTING', 'active', 'task-hierarchy-a', 0, OLD, OLD);
  insertTask.run('task-completed', 'job-stuck-terminal', 'reviewer', 'completed', 'run-7', 'session-7', null, '[]', '{}', OLD, '2026-10-26T01:30:00.000Z',
    'exec-session-7', 'success', 1, null, OLD, COMPLETE_EVENT);
  insertAttempt.run('attempt-7', 'task-completed', 'completed', 'run-7', OLD, COMPLETE_EVENT, null);
  insertResult.run('result-7', 'task-completed', 'success', 'not copied to the diagnostic output', COMPLETE_EVENT);
  insertArtifact.run('artifact-7', 'job-stuck-terminal', 'task-completed', 'review', 'artifact://7', '{}', COMPLETE_EVENT, 1, 'reviewer',
    '{"decision":"needs_changes"}', '[]', 'active', null, sha('artifact-content'));
  insertEvent.run('event-completed', 'job-stuck-terminal', 'task.local_completed', JSON.stringify({ taskId: 'task-completed', attemptId: 'attempt-7', resultId: 'result-7', artifactId: 'artifact-7' }), COMPLETE_EVENT);
  // `parent_task_id` is a durable task ID, while dependency_json stores plan
  // task IDs. The test asserts these two namespaces are not conflated.
  // Cross-job/missing parent refs, an unknown plan dependency, a declared plan
  // prerequisite that is not materialized, and a plan dependency cycle all stay
  // inside this disposable DB; the report never authorizes lifecycle action.
  insertJob.run('job-parent-other', 'conversation:parent-other', 'completed parent referenced cross-job', 'COMPLETED', 'completed', null, 0, OLD, COMPLETE_EVENT);
  insertTask.run('task-parent-outside', 'job-parent-other', 'engineer', 'completed', null, null, null, '[]', '{}', OLD, COMPLETE_EVENT, null, 'completed', 1, null, OLD, COMPLETE_EVENT);
  insertTask.run('task-dep-outside', 'job-parent-other', 'researcher', 'completed', null, null, null, '[]', '{}', OLD, COMPLETE_EVENT, null, 'completed', 1, null, OLD, COMPLETE_EVENT);
  const hierarchyPlan = { job_id: 'job-hierarchy-conflict', workflow_id: 'hierarchy-test', workflow_version: 1,
    children: [
      { id: 'plan-a', dependencies: ['plan-b', 'missing-plan-task', 'plan-outside'] },
      { id: 'plan-b', dependencies: ['plan-a'] },
      { id: 'plan-outside', dependencies: [] },
      { id: 'plan-d', dependencies: [] },
      { id: 'plan-unmaterialized', dependencies: ['dangling-unmaterialized'] }
    ] };
  const hierarchyPlanJson = JSON.stringify(hierarchyPlan);
  db.prepare('INSERT INTO workflow_plans(job_id,workflow_id,workflow_version,plan_hash,plan_json,created_at) VALUES(?,?,?,?,?,?)')
    .run(hierarchyPlan.job_id, hierarchyPlan.workflow_id, hierarchyPlan.workflow_version, sha(hierarchyPlanJson), hierarchyPlanJson, OLD);
  insertTask.run('task-hierarchy-a', 'job-hierarchy-conflict', 'engineer', 'running', null, null, 'task-parent-outside',
    JSON.stringify(['plan-b', 'missing-plan-task', 'plan-outside']), JSON.stringify({ workflow_plan_task_id: 'plan-a' }),
    '2026-10-26T03:00:00.000Z', '2026-10-26T03:00:00.000Z', null, 'running', 1, null, OLD, null);
  insertTask.run('task-hierarchy-b', 'job-hierarchy-conflict', 'qa', 'running', null, null, null,
    JSON.stringify([]), JSON.stringify({ workflow_plan_task_id: 'plan-b' }),
    '2026-10-26T03:01:00.000Z', '2026-10-26T03:01:00.000Z', null, 'running', 1, null, OLD, null);
  insertTask.run('task-hierarchy-c', 'job-hierarchy-conflict', 'reviewer', 'pending', null, null, null,
    JSON.stringify(['plan-b']), JSON.stringify({ workflow_plan_task_id: 'plan-d' }),
    '2026-10-26T03:02:00.000Z', '2026-10-26T03:02:00.000Z', null, 'pending', 0, null, OLD, null);
  for (let i = 1; i <= 13; i += 1) {
    insertEvent.run(`event-noise-${i}`, 'job-stuck-terminal', 'workflow.progress', JSON.stringify({ phase: `phase-${i}` }),
      `2026-10-26T02:${String(i).padStart(2, '0')}:00.000Z`);
  }
  db.prepare('INSERT INTO approvals(approval_id,job_id,decision,actor,raw_text,proposal_hash,created_at) VALUES(?,?,?,?,?,?,?)')
    .run('approval-needs-changes', 'job-stuck-terminal', 'needs_changes', 'trusted-reviewer-fixture', 'not copied', sha('plan'), COMPLETE_EVENT);

  insertJob.run('job-live-lease', 'conversation:live', 'active task with current lease', 'EXECUTING', 'active', 'task-live', 0, NOW, NOW);
  insertTask.run('task-live', 'job-live-lease', 'engineer', 'running', 'run-live', 'session-live', null, '[]', '{}', NOW, NOW,
    'exec-live', 'running', 1, null, NOW, null);
  insertAttempt.run('attempt-live', 'task-live', 'started', 'run-live', NOW, null, null);
  // Keep the lease future-valid for CLI tests that intentionally use wall-clock
  // `now`; the in-memory deterministic test passes NOW explicitly.
  insertLease.run('lease-live', 'task-live', 'job-live-lease', 2, 'worker-local', 'ACTIVE', NOW, NOW, '2099-10-26T06:10:00.000Z', null, null, 3);
  insertEvent.run('event-live', 'job-live-lease', 'attempt.started', JSON.stringify({ taskId: 'task-live', attemptId: 'attempt-live' }), NOW);

  insertJob.run('job-live-lease-good', 'conversation:live-good', 'active task with matching lease', 'EXECUTING', 'active', 'task-live-good', 0, NOW, NOW);
  insertTask.run('task-live-good', 'job-live-lease-good', 'engineer', 'running', 'run-live-good', 'session-live-good', null, '[]', '{}', NOW, NOW,
    'exec-live-good', 'running', 1, null, NOW, null);
  insertAttempt.run('attempt-live-good', 'task-live-good', 'started', 'run-live-good', NOW, null, null);
  insertLease.run('lease-live-good', 'task-live-good', 'job-live-lease-good', 1, 'worker-local-good', 'ACTIVE', NOW, NOW,
    '2099-10-26T06:10:00.000Z', null, null, 4);
  insertEvent.run('event-live-good', 'job-live-lease-good', 'attempt.started', JSON.stringify({ taskId: 'task-live-good', attemptId: 'attempt-live-good' }), NOW);

  insertJob.run('job-approved', 'conversation:approved', 'approved but not dispatched', 'APPROVED', 'active', null, 0, NOW, NOW);
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
  const jobs = new Map(report.diagnostics.map(job => [job.jobId, job]));

  const stale = jobs.get('job-stale');
  assert.equal(stale.classification, 'stale_candidate_reconciliation_required');
  assert.ok(stale.flags.includes('RUNNING_TASK_WITHOUT_EXECUTION_METADATA'));
  assert.ok(stale.flags.includes('RUNNING_TASKS_WITHOUT_ACTIVE_LEASES'));
  assert.equal(stale.tasks[0].latestAttempt, null);
  assert.ok(stale.flags.includes('ARTIFACT_JOB_TASK_LINEAGE_MISMATCH'));
  assert.ok(stale.flags.includes('ARTIFACT_PRODUCER_ROLE_MISMATCH'));
  assert.ok(stale.flags.includes('EVENT_ATTEMPT_REFERENCE_UNRESOLVED'));
  assert.ok(stale.flags.includes('EVENT_RESULT_REFERENCE_UNRESOLVED'));
  assert.ok(stale.flags.includes('EVENT_ARTIFACT_REFERENCE_UNRESOLVED'));
  assert.equal(stale.tasks[0].lifecycleEvidence.disposition, 'HOLD_CONFLICTING_EVIDENCE');
  assert.equal(stale.tasks[0].lifecycleEvidence.owner.status, 'UNVERIFIED');
  assert.equal(stale.tasks[0].lifecycleEvidence.provider.status, 'UNVERIFIED');
  assert.equal(stale.tasks[0].lifecycleEvidence.lease.status, 'MISSING_NOT_PROOF_OF_WORKER_DEATH');
  assert.equal(stale.tasks[0].lifecycleEvidence.automaticLifecycleActionAuthorized, false);
  assert.deepEqual(stale.tasks[0].lifecycleEvidence.eventReferences.unresolvedAttemptIds, ['attempt-does-not-exist']);
  assert.match(stale.ownerAction, /responsible owner/);

  const mismatched = jobs.get('job-stuck-terminal');
  assert.equal(mismatched.classification, 'stale_candidate_reconciliation_required');
  assert.ok(mismatched.flags.includes('EXECUTING_JOB_WITHOUT_RUNNING_TASKS'));
  assert.ok(mismatched.flags.includes('ACTIVE_TASK_POINTER_NOT_RUNNING'));
  assert.ok(mismatched.flags.includes('COMPLETION_EVENT_NEWER_THAN_ACTIVE_TASK_ROW'));
  assert.equal(mismatched.resultCount, 1);
  assert.equal(mismatched.artifactCount, 1);
  assert.equal(mismatched.tasks[0].recentResults[0].resultId, 'result-7');
  assert.equal(mismatched.latestApproval.decision, 'needs_changes');
  assert.ok(mismatched.completionEventEvidence.matchingActiveTaskEventIds.includes('event-completed'),
    'task completion correlation must not lose older completion events behind more than 12 newer events');
  assert.ok(mismatched.tasks[0].eventLineage.eventIds.includes('event-completed'),
    'per-task event lineage must include correlated events outside the compact latest-12 display window');
  assert.equal(mismatched.tasks[0].eventLineage.truncated, false);
  assert.ok(report.recoveryPlan.find(item => item.jobId === 'job-stuck-terminal').observedIdentity.taskEventIds[0].eventIds.includes('event-completed'),
    'reconciliation identity must bind all task-correlated event IDs, not only the latest event window');
  assert.ok(report.recoveryPlan.find(item => item.jobId === 'job-stuck-terminal').observedIdentity.allJobEventIds.includes('event-noise-1'));
  assert.equal(JSON.stringify(mismatched).includes('not copied'), false, 'diagnostics must not copy result content or approval raw text');

  const hierarchyJob = jobs.get('job-hierarchy-conflict');
  const hierarchyA = hierarchyJob.tasks.find(task => task.task.taskId === 'task-hierarchy-a');
  const hierarchyB = hierarchyJob.tasks.find(task => task.task.taskId === 'task-hierarchy-b');
  const hierarchyC = hierarchyJob.tasks.find(task => task.task.taskId === 'task-hierarchy-c');
  assert.ok(hierarchyA.flags.includes('TASK_PARENT_CROSS_JOB'));
  assert.ok(hierarchyA.flags.includes('TASK_DEPENDENCY_NOT_IN_IMMUTABLE_PLAN'));
  assert.ok(hierarchyA.flags.includes('TASK_DEPENDENCY_PRODUCER_NOT_MATERIALIZED'));
  assert.ok(!hierarchyA.flags.includes('TASK_DEPENDENCY_CROSS_JOB'),
    'plan-step IDs must not be mistaken for durable task IDs and incorrectly classified cross-job');
  assert.ok(hierarchyA.flags.includes('TASK_DEPENDENCY_CYCLE_DETECTED'));
  assert.ok(hierarchyB.flags.includes('TASK_DEPENDENCY_CYCLE_DETECTED'));
  assert.ok(hierarchyB.flags.includes('TASK_DEPENDENCY_MATERIALIZATION_MISMATCH'));
  assert.ok(hierarchyC.flags.includes('TASK_DEPENDENCY_MATERIALIZATION_MISMATCH'));
  assert.equal(hierarchyA.lifecycleEvidence.taskHierarchy.parent.status, 'CROSS_JOB');
  assert.equal(hierarchyA.lifecycleEvidence.taskHierarchy.planBinding.status, 'HASH_BOUND_DIAGNOSTIC_ONLY');
  assert.ok(hierarchyA.lifecycleEvidence.taskHierarchy.planBinding.blockers.includes('WORKFLOW_PLAN_DEPENDENCY_TARGET_MISSING'),
    'dangling dependencies must be reported at plan scope even when referencing plan steps have no materialized task');
  assert.deepEqual(hierarchyB.lifecycleEvidence.taskHierarchy.planDependencyBinding, {
    status: 'MATERIALIZATION_MISMATCH', expectedPlanTaskIds: ['plan-a'], observedPlanTaskIds: [],
    missingPlanTaskIds: ['plan-a'], unexpectedPlanTaskIds: []
  });
  assert.deepEqual(hierarchyC.lifecycleEvidence.taskHierarchy.planDependencyBinding, {
    status: 'MATERIALIZATION_MISMATCH', expectedPlanTaskIds: [], observedPlanTaskIds: ['plan-b'],
    missingPlanTaskIds: [], unexpectedPlanTaskIds: ['plan-b']
  });
  assert.deepEqual(hierarchyA.lifecycleEvidence.taskHierarchy.dependencies.map(item => item.status),
    ['NOT_COMPLETED', 'NOT_IN_IMMUTABLE_PLAN', 'NOT_MATERIALIZED']);
  assert.equal(hierarchyA.lifecycleEvidence.taskHierarchy.automaticLifecycleActionAuthorized, false);
  assert.equal(hierarchyA.lifecycleEvidence.eventReferences.status, 'NO_REFERENCES_OBSERVED');
  assert.match(hierarchyA.lifecycleEvidence.eventReferences.completeness, /ABSENCE_OF_REFERENCES_DOES_NOT_PROVE_COMPLETE_LINEAGE/);

  assert.equal(jobs.get('job-live-lease').classification, 'lifecycle_reconciliation_required');
  assert.ok(jobs.get('job-live-lease').flags.includes('ACTIVE_LEASE_ATTEMPT_MISMATCH'));
  assert.equal(jobs.get('job-live-lease').activeLeaseCount, 1);
  assert.equal(jobs.get('job-live-lease-good').classification, 'live_lease_heartbeat');
  assert.equal(jobs.get('job-approved').classification, 'awaiting_dispatch');
  const plan = report.recoveryPlan.find(item => item.jobId === 'job-stuck-terminal');
  assert.equal(plan.action, 'HOLD_FOR_OWNER_RECONCILIATION');
  assert.equal(plan.authorizationGranted, false);
  assert.match(plan.idempotencyKey, /^reconcile-[a-f0-9]{64}$/);
  assert.ok(plan.prohibitedWithoutEvidenceAndAuthority.includes('terminalize'));
  assert.equal(plan.observedIdentity.resultIds[0], 'result-7');
  assert.equal(report.recoveryPlan.find(item => item.jobId === 'job-stuck-terminal').idempotencyKey, plan.idempotencyKey,
    'recovery plan identity key must be deterministic for the same observed lineage');

  // Stable row IDs are insufficient for a recovery idempotency key: content
  // can drift while IDs remain constant. The report must force a fresh review.
  const writable = new DatabaseSync(dbPath);
  writable.prepare('UPDATE results SET content=? WHERE result_id=?').run('changed-result-content', 'result-7');
  writable.close();
  const changedDb = new DatabaseSync(dbPath, { readOnly: true });
  const changedReport = buildActiveWorkflowReconciliationReport(changedDb, {
    now: NOW, staleAfterMs: 900_000, limit: 20, procRoot: path.join(dir, 'proc')
  });
  changedDb.close();
  assert.notEqual(changedReport.recoveryPlan.find(item => item.jobId === 'job-stuck-terminal').idempotencyKey,
    plan.idempotencyKey, 'a result-content change with stable row IDs must invalidate the old reconciliation key');
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
  assert.equal(report.summary.jobsFlaggedForReconciliation, 4);
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
