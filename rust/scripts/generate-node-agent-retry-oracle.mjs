#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rustRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(rustRoot, '..');
const defaultOutput = path.join(rustRoot, 'crates/runalith-domain/tests/fixtures/node-agent-retry-v1.json');
const outputPath = path.resolve(process.argv[2] || defaultOutput);
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runalith-node-agent-retry-'));

process.env.NODE_ENV = 'test';
process.env.WORKFLOW_DATA_DIR = temporaryRoot;
process.env.WORKFLOW_DB = path.join(temporaryRoot, 'workflow.db');

const { WorkflowStore } = await import(pathToFileURL(path.join(repositoryRoot, 'job-store.js')).href);
const store = new WorkflowStore();

function prepareScenario(label, { attachSession = true, grantTakeover = true, staleSession = true } = {}) {
  const job = store.createJob({
    conversationKey: `node-agent-retry-${label}-${process.pid}`,
    title: 'Node agent retry differential oracle'
  });
  store.transition(job.job_id, 'PROPOSED');
  store.approve(job.job_id, 'approved for local differential oracle');
  const task = store.dispatch(job.job_id, {
    role: 'cto',
    description: `retry preflight case ${label}`
  });

  let session = null;
  let runId = null;
  if (attachSession) {
    runId = `node-agent-retry-run-${label}-${process.pid}`;
    store.attachOpenClawRun(job.job_id, {
      runId,
      sessionKey: `agent:cto:subagent:node-retry-${label}-${process.pid}`
    });
    session = store.getSessionByTask(task.task_id);
    if (!session) throw new Error(`fixture session was not created: ${label}`);
    if (staleSession) {
      store.db.prepare("UPDATE agent_sessions SET state='STALE' WHERE session_id=?")
        .run(session.session_id);
    }
    if (grantTakeover) {
      store.grantSessionAccess(session.session_id, {
        accessorRole: 'architect',
        permission: 'TAKEOVER',
        grantedBy: 'cto'
      });
    }
  }
  return { job, task: store.getTask(task.task_id), session, runId };
}

function readContext(taskId, { actorRole = 'architect', reason = 'Node retry oracle case', hasTakeoverPermission = true } = {}) {
  const task = store.getTask(taskId);
  const job = task ? store.getJob(task.job_id) : null;
  const candidate = task ? store.getSessionByTask(taskId) : null;
  const session = candidate ? store.getSession(candidate.session_id) : null;
  const activeLease = task
    ? store.db.prepare("SELECT lease_id FROM task_leases WHERE task_id=? AND state='ACTIVE' ORDER BY issued_at DESC LIMIT 1").get(taskId)
    : null;
  const activeAttempts = task
    ? store.db.prepare("SELECT attempt_id,openclaw_run_id FROM attempts WHERE task_id=? AND status='started' ORDER BY started_at DESC,rowid DESC").all(taskId)
    : [];

  return {
    task_id: taskId,
    actor_role: actorRole,
    reason,
    task_exists: Boolean(task),
    job_id: task?.job_id ?? null,
    job_exists: Boolean(job),
    job_status: job?.status ?? null,
    job_state: job?.state ?? null,
    task_status: task?.status ?? null,
    session_exists: Boolean(session),
    session_id: session?.session_id ?? null,
    session_task_matches: Boolean(session && session.task_id === taskId),
    session_job_matches: Boolean(session && session.job_id === task?.job_id),
    has_takeover_permission: hasTakeoverPermission,
    session_state: session?.state ?? null,
    active_lease_id: activeLease?.lease_id ?? null,
    task_execution_attempt: task?.execution_attempt ?? null,
    session_attempt: session?.attempt ?? null,
    task_openclaw_run_id: task?.openclaw_run_id ?? null,
    active_attempts: activeAttempts.map(attempt => ({
      attempt_id: attempt.attempt_id,
      openclaw_run_id: attempt.openclaw_run_id ?? null
    }))
  };
}

function classifyError(message) {
  if (message.startsWith('retry taskId must be')) return 'INVALID_TASK_ID';
  if (message.startsWith('retry actorRole must be')) return 'INVALID_ACTOR_ROLE';
  if (message.startsWith('retry reason must be')) return 'INVALID_REASON';
  if (message.startsWith('task not found:')) return 'TASK_NOT_FOUND';
  if (message.startsWith('task retry requires an existing task')) return 'JOB_NOT_EXECUTING';
  if (message.startsWith('task retry is not allowed from task status')) return 'TASK_STATUS_NOT_RETRYABLE';
  if (message.startsWith('agent session not found for task:')) return 'SESSION_NOT_FOUND';
  if (message.startsWith('agent session/task binding changed during retry:')) return 'SESSION_BINDING_CHANGED';
  if (/TAKEOVER|permission/i.test(message)) return 'TAKEOVER_PERMISSION_DENIED';
  if (message.startsWith('same-task retry requires STALE, FAILED, or PAUSED')) return 'SESSION_STATE_NOT_RETRYABLE';
  if (message.startsWith('same-task retry requires the prior task lease')) return 'ACTIVE_LEASE';
  if (message.startsWith('malformed durable retry attempt identity')) return 'MALFORMED_ATTEMPT_IDENTITY';
  if (message.startsWith('task has multiple unresolved runtime attempts')) return 'MULTIPLE_UNRESOLVED_ATTEMPTS';
  if (message.startsWith('stale runtime attempt identity does not match')) return 'ATTEMPT_BINDING_MISMATCH';
  if (message.startsWith('durable retry attempt identity is exhausted')) return 'ATTEMPT_IDENTITY_EXHAUSTED';
  throw new Error(`unclassified Node beginAgentRetry error: ${message}`);
}

function normalizeContext(context) {
  const runValues = [
    context.task_openclaw_run_id,
    ...context.active_attempts.map(attempt => attempt.openclaw_run_id)
  ].filter((value, index, values) => typeof value === 'string' && values.indexOf(value) === index);
  const runTokens = new Map(runValues.map((value, index) => [value, `run-oracle-${index + 1}`]));
  return {
    ...context,
    task_id: context.task_exists ? 'task-oracle' : context.task_id,
    job_id: context.job_exists ? 'job-oracle' : context.job_id,
    session_id: context.session_exists ? 'session-oracle' : context.session_id,
    active_lease_id: context.active_lease_id ? 'lease-oracle' : null,
    task_openclaw_run_id: context.task_openclaw_run_id ? runTokens.get(context.task_openclaw_run_id) : null,
    active_attempts: context.active_attempts.map(attempt => ({
      attempt_id: 'attempt-oracle',
      openclaw_run_id: attempt.openclaw_run_id ? runTokens.get(attempt.openclaw_run_id) : null
    }))
  };
}

function normalizeError(message, context) {
  const replacements = [
    [context.job_id, 'job-oracle'],
    [context.task_id, context.task_exists ? 'task-oracle' : context.task_id],
    [context.session_id, 'session-oracle'],
    [context.active_lease_id, 'lease-oracle']
  ].filter(([from]) => typeof from === 'string' && from.length > 0);
  return replacements.reduce((value, [from, to]) => value.replaceAll(from, to), message);
}

function executeCase(name, scenario, options = {}) {
  const { taskId, mutation = null, actorRole = 'architect', reason = 'Node retry oracle case', grantTakeover = true } = options;
  const fixture = scenario || prepareScenario(name, {
    attachSession: options.attachSession !== false,
    grantTakeover,
    staleSession: options.staleSession !== false
  });
  if (mutation) mutation(fixture);
  const id = taskId || fixture.task?.task_id || `missing-${name}`;
  const rawContext = readContext(id, {
    actorRole,
    reason,
    hasTakeoverPermission: grantTakeover && Boolean(fixture.session)
  });
  const priorAttempt = rawContext.active_attempts[0] || null;
  const context = normalizeContext(rawContext);
  try {
    const result = store.beginAgentRetry(id, { actorRole, reason });
    return {
      name,
      context,
      outcome: 'READY',
      error_code: null,
      next_attempt: result.attempt,
      superseded_attempt_id: priorAttempt ? 'attempt-oracle' : null,
      postcondition: {
        task_status: result.task.status,
        session_state: result.session.state,
        session_attempt: result.session.attempt,
        active_attempt_count: store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(id).n,
        superseded_attempt_status: priorAttempt
          ? store.db.prepare('SELECT status FROM attempts WHERE attempt_id=?').get(priorAttempt.attempt_id)?.status ?? null
          : null
      }
    };
  } catch (error) {
    const message = String(error?.message || error);
    return {
      name,
      context,
      outcome: 'REJECTED',
      error_code: classifyError(message),
      error: normalizeError(message, rawContext),
      next_attempt: null,
      superseded_attempt_id: null,
      postcondition: null
    };
  }
}

try {
  const cases = [];
  cases.push(executeCase('ready-stale-session', prepareScenario('ready-stale-session')));
  cases.push(executeCase('ready-no-open-attempt', prepareScenario('ready-no-open-attempt'), {
    mutation: fixture => store.db.prepare("UPDATE attempts SET status='failed' WHERE task_id=? AND status='started'").run(fixture.task.task_id)
  }));
  cases.push(executeCase('invalid-task-id', prepareScenario('invalid-task-id'), { taskId: '   ' }));
  cases.push(executeCase('invalid-actor-role', prepareScenario('invalid-actor-role'), { actorRole: '  ' }));
  cases.push(executeCase('invalid-reason', prepareScenario('invalid-reason'), { reason: '  ' }));
  cases.push(executeCase('task-not-found', null, { taskId: 'missing-task-for-retry-oracle' }));
  cases.push(executeCase('job-not-executing', prepareScenario('job-not-executing'), {
    mutation: fixture => store.db.prepare("UPDATE jobs SET state='COMPLETED',status='completed' WHERE job_id=?").run(fixture.job.job_id)
  }));
  cases.push(executeCase('task-status-not-retryable', prepareScenario('task-status-not-retryable'), {
    mutation: fixture => store.db.prepare("UPDATE tasks SET status='completed' WHERE task_id=?").run(fixture.task.task_id)
  }));
  cases.push(executeCase('session-not-found', prepareScenario('session-not-found', { attachSession: false, grantTakeover: false }), {
    grantTakeover: false
  }));
  cases.push(executeCase('takeover-permission-denied', prepareScenario('takeover-permission-denied', { grantTakeover: false }), {
    grantTakeover: false
  }));
  cases.push(executeCase('session-state-not-retryable', prepareScenario('session-state-not-retryable', { staleSession: false }), {
    staleSession: false
  }));
  cases.push(executeCase('active-lease', prepareScenario('active-lease'), {
    mutation: fixture => store.acquireTaskLease(fixture.task.task_id, {
      leaseId: `retry-oracle-active-lease-${process.pid}`,
      workerId: 'provider-worker',
      ttlMs: 60_000,
      attempt: 1
    })
  }));
  cases.push(executeCase('malformed-task-attempt', prepareScenario('malformed-task-attempt'), {
    mutation: fixture => store.db.prepare('UPDATE tasks SET execution_attempt=-1 WHERE task_id=?').run(fixture.task.task_id)
  }));
  cases.push(executeCase('fractional-task-attempt', prepareScenario('fractional-task-attempt'), {
    mutation: fixture => store.db.prepare('UPDATE tasks SET execution_attempt=1.5 WHERE task_id=?').run(fixture.task.task_id)
  }));
  cases.push(executeCase('malformed-session-attempt', prepareScenario('malformed-session-attempt'), {
    mutation: fixture => store.db.prepare('UPDATE agent_sessions SET attempt=0 WHERE session_id=?').run(fixture.session.session_id)
  }));
  cases.push(executeCase('non-numeric-session-attempt', prepareScenario('non-numeric-session-attempt'), {
    mutation: fixture => store.db.prepare("UPDATE agent_sessions SET attempt='not-a-number' WHERE session_id=?").run(fixture.session.session_id)
  }));
  cases.push(executeCase('multiple-unresolved-attempts', prepareScenario('multiple-unresolved-attempts'), {
    mutation: fixture => store.db.prepare("INSERT INTO attempts(attempt_id,task_id,status,openclaw_run_id,started_at) VALUES(?,?,'started',?,?)")
      .run(`duplicate-active-attempt-${process.pid}`, fixture.task.task_id, fixture.runId, new Date().toISOString())
  }));
  cases.push(executeCase('attempt-binding-mismatch', prepareScenario('attempt-binding-mismatch'), {
    mutation: fixture => store.db.prepare('UPDATE tasks SET openclaw_run_id=? WHERE task_id=?')
      .run(`different-run-${process.pid}`, fixture.task.task_id)
  }));
  cases.push(executeCase('attempt-identity-exhausted', prepareScenario('attempt-identity-exhausted'), {
    mutation: fixture => store.db.prepare('UPDATE tasks SET execution_attempt=? WHERE task_id=?')
      .run(Number.MAX_SAFE_INTEGER, fixture.task.task_id)
  }));

  const fixture = {
    schema_version: 1,
    generated_by_node: true,
    source: 'src/runtime/job-store.js::WorkflowStore.beginAgentRetry ordered preflight',
    note: 'Models preflight and attempt-number planning only; Node transaction postconditions are included for audit and are not Rust persistence claims.',
    cases
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o644 });
  console.log(JSON.stringify({
    output: outputPath,
    cases: cases.length,
    outcomes: Object.fromEntries(Object.entries(Object.groupBy(cases, item => item.outcome))
      .map(([key, values]) => [key, values.length])),
    error_codes: Object.fromEntries(Object.entries(Object.groupBy(cases.filter(item => item.error_code), item => item.error_code))
      .map(([key, values]) => [key, values.length]))
  }, null, 2));
} finally {
  store.db.close();
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
