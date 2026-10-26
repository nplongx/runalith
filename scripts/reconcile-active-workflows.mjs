#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const DEFAULT_DB = path.join(process.env.HOME || '/tmp', '.chat-on-steroids', 'agent-orchestrator', 'workflow.db');
const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const EVENT_KEYS = /^(task_?id|task|attempt_?id|attempt|result_?id|artifact_?id|lease_?id|worker_?id|session_?id|run_?id|role|phase|status|decision|reason|error_?code|recovery|owner|actor|exit_?code|execution_?status)$/i;
const MAX_REPORT_JOBS = 200;

function fail(code, message) { throw Object.assign(new Error(`${code}: ${message}`), { code }); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function parseJson(value) { try { return JSON.parse(value); } catch { return null; } }
function timestampMs(value) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function ageMs(value, nowMs) {
  const parsed = timestampMs(value);
  return parsed == null ? null : Math.max(0, nowMs - parsed);
}
function newestTimestamp(values) {
  return values.filter(value => timestampMs(value) != null).sort((a, b) => timestampMs(b) - timestampMs(a))[0] || null;
}
function firstDefined(...values) { return values.find(value => value !== undefined && value !== null && value !== '') ?? null; }

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}
function tableColumns(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name));
}
function requireColumns(db, table, required) {
  const available = tableColumns(db, table);
  const missing = required.filter(column => !available.has(column));
  if (missing.length) fail('RECONCILIATION_SCHEMA_UNSUPPORTED', `table ${table} is missing required columns: ${missing.join(', ')}`);
}
function selectAvailable(db, table, columns, whereSql, parameters = [], orderSql = '', limitSql = '') {
  const available = tableColumns(db, table);
  if (!available.size) return [];
  const selected = columns.filter(column => available.has(column));
  if (!selected.length) return [];
  return db.prepare(`SELECT ${selected.map(column => `"${column}"`).join(',')} FROM "${table}" ${whereSql || ''} ${orderSql} ${limitSql}`).all(...parameters);
}

function summarizePayload(value, result = {}, depth = 0) {
  if (!isRecord(value) || depth > 5 || Object.keys(result).length >= 32) return result;
  for (const [key, item] of Object.entries(value)) {
    if (EVENT_KEYS.test(key)) {
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item === null) {
        result[key] = typeof item === 'string' ? item.slice(0, 240) : item;
      } else if (isRecord(item)) {
        for (const [childKey, childValue] of Object.entries(item)) {
          if (/^(id|task_?id|attempt_?id|result_?id|artifact_?id|lease_?id|status|role|type)$/i.test(childKey) &&
              (typeof childValue === 'string' || typeof childValue === 'number' || typeof childValue === 'boolean')) {
            result[`${key}.${childKey}`] = String(childValue).slice(0, 240);
          }
        }
      }
    }
    if (isRecord(item)) summarizePayload(item, result, depth + 1);
    else if (Array.isArray(item)) for (const child of item.slice(0, 5)) if (isRecord(child)) summarizePayload(child, result, depth + 1);
    if (Object.keys(result).length >= 32) break;
  }
  return result;
}

function correlatedTaskId(event) {
  const payload = parseJson(event.payload_json || '{}');
  const fields = summarizePayload(payload);
  return firstDefined(fields.task_id, fields.taskId, fields.task, fields['task.id'], fields['task.task_id'], fields['task.taskId']);
}

function processObservation(pid, procRoot) {
  if (!Number.isSafeInteger(pid) || pid < 2) return { observed: false, reason: 'no_valid_execution_pid_recorded' };
  try {
    const base = path.join(procRoot, String(pid));
    const cmdline = fs.readFileSync(path.join(base, 'cmdline'));
    const status = fs.readFileSync(path.join(base, 'status'), 'utf8');
    const statLine = fs.readFileSync(path.join(base, 'stat'), 'utf8');
    const closeParen = statLine.lastIndexOf(')');
    const statFieldsAfterCommand = closeParen >= 0 ? statLine.slice(closeParen + 2).trim().split(/\s+/) : [];
    const startTimeTicks = statFieldsAfterCommand[19] || null; // /proc/<pid>/stat field 22 (starttime)
    const processName = /^Name:\s*(.+)$/m.exec(status)?.[1] || null;
    return { observed: true, identityVerified: false, reason: 'pid_starttime_not_bound_to_persisted_execution_identity',
      pid, processName, startTimeTicks, commandHash: hash(cmdline), cmdlineBytes: cmdline.length };
  } catch (error) {
    return { observed: false, pid, reason: error?.code === 'ENOENT' ? 'proc_entry_not_found' : 'proc_entry_unreadable' };
  }
}

function listTaskRows(db, jobId, { nowMs, procRoot }) {
  const tasks = selectAvailable(db, 'tasks', [
    'task_id', 'job_id', 'role', 'status', 'openclaw_run_id', 'openclaw_session_key', 'parent_task_id',
    'dependency_json', 'metadata_json', 'created_at', 'updated_at', 'execution_session_id', 'execution_status',
    'execution_attempt', 'execution_pid', 'execution_exit_code', 'execution_started_at', 'execution_finished_at'
  ], 'WHERE job_id=?', [jobId], 'ORDER BY created_at, task_id');
  return tasks.map(task => {
    const attempts = selectAvailable(db, 'attempts', ['attempt_id', 'task_id', 'status', 'openclaw_run_id', 'started_at', 'finished_at', 'error'],
      'WHERE task_id=?', [task.task_id], 'ORDER BY started_at DESC, rowid DESC', 'LIMIT 5');
    const results = selectAvailable(db, 'results', ['result_id', 'task_id', 'outcome', 'created_at'],
      'WHERE task_id=?', [task.task_id], 'ORDER BY created_at DESC, rowid DESC', 'LIMIT 5');
    const artifacts = selectAvailable(db, 'artifacts', ['artifact_id', 'job_id', 'task_id', 'kind', 'created_at', 'schema_version',
      'producer_role', 'status', 'supersedes', 'content_hash'], 'WHERE task_id=?', [task.task_id], 'ORDER BY created_at DESC, rowid DESC', 'LIMIT 8');
    const leases = selectAvailable(db, 'task_leases', ['lease_id', 'task_id', 'job_id', 'attempt', 'worker_id', 'state', 'issued_at',
      'heartbeat_at', 'expires_at', 'released_at', 'last_error', 'owner_epoch'], 'WHERE task_id=?', [task.task_id], 'ORDER BY rowid DESC', 'LIMIT 5');
    const latestAttempt = attempts[0] || null;
    const activeLeases = leases.filter(lease => String(lease.state || '').toUpperCase() === 'ACTIVE');
    const updatedAge = ageMs(task.updated_at, nowMs);
    const flags = [];
    if (task.status === 'running' && Number(task.execution_attempt ?? 0) === 0 && !task.execution_started_at && task.execution_pid == null && !task.execution_session_id) {
      flags.push('RUNNING_TASK_WITHOUT_EXECUTION_METADATA');
    }
    if (task.status === 'running' && latestAttempt && ['started', 'running', 'executing'].includes(String(latestAttempt.status || '').toLowerCase()) && activeLeases.length === 0) {
      flags.push('ACTIVE_ATTEMPT_WITHOUT_ACTIVE_LEASE');
    }
    if (task.status === 'running' && activeLeases.length > 0 && activeLeases.every(lease =>
      timestampMs(lease.expires_at) == null || timestampMs(lease.expires_at) <= nowMs)) {
      flags.push('RUNNING_TASK_WITH_EXPIRED_OR_INVALID_LEASE');
    }
    const crossJobArtifacts = artifacts.filter(artifact => artifact.job_id && artifact.job_id !== jobId);
    if (crossJobArtifacts.length) flags.push('ARTIFACT_JOB_TASK_LINEAGE_MISMATCH');
    const producerRoleMismatches = artifacts.filter(artifact => artifact.producer_role && task.role &&
      String(artifact.producer_role).toLowerCase() !== String(task.role).toLowerCase());
    if (producerRoleMismatches.length) flags.push('ARTIFACT_PRODUCER_ROLE_MISMATCH');
    const successfulResultsWhileRunning = task.status === 'running' && results.some(result =>
      ['success', 'succeeded', 'completed'].includes(String(result.outcome || '').toLowerCase()));
    if (successfulResultsWhileRunning) flags.push('SUCCESS_RESULT_WITH_NONTERMINAL_TASK');
    const mismatchedLeases = leases.filter(lease => String(lease.state || '').toUpperCase() === 'ACTIVE' &&
      lease.attempt != null && task.execution_attempt != null && Number(lease.attempt) !== Number(task.execution_attempt));
    if (mismatchedLeases.length) flags.push('ACTIVE_LEASE_ATTEMPT_MISMATCH');
    const observedCounts = {
      attempts: selectAvailable(db, 'attempts', ['attempt_id'], 'WHERE task_id=?', [task.task_id]).length,
      results: selectAvailable(db, 'results', ['result_id'], 'WHERE task_id=?', [task.task_id]).length,
      artifacts: selectAvailable(db, 'artifacts', ['artifact_id'], 'WHERE task_id=?', [task.task_id]).length,
      leases: selectAvailable(db, 'task_leases', ['lease_id'], 'WHERE task_id=?', [task.task_id]).length
    };
    return {
      task: {
        taskId: task.task_id, role: task.role, status: task.status, updatedAt: task.updated_at, ageSinceUpdateMs: updatedAge,
        executionAttempt: task.execution_attempt ?? null, executionStatus: task.execution_status ?? null,
        executionStartedAt: task.execution_started_at ?? null, executionFinishedAt: task.execution_finished_at ?? null,
        executionExitCode: task.execution_exit_code ?? null, executionPid: task.execution_pid ?? null,
        executionProcess: processObservation(task.execution_pid, procRoot),
        executionSessionId: task.execution_session_id ?? null,
        openClawRunId: task.openclaw_run_id ?? null,
        openClawSessionKey: task.openclaw_session_key ?? null,
        parentTaskId: task.parent_task_id ?? null,
        dependencyIds: parseJson(task.dependency_json || '[]')
      },
      latestAttempt: latestAttempt ? {
        attemptId: latestAttempt.attempt_id, status: latestAttempt.status, runId: latestAttempt.openclaw_run_id ?? null,
        startedAt: latestAttempt.started_at, finishedAt: latestAttempt.finished_at,
        durationMs: timestampMs(latestAttempt.finished_at) != null && timestampMs(latestAttempt.started_at) != null
          ? Math.max(0, timestampMs(latestAttempt.finished_at) - timestampMs(latestAttempt.started_at)) : null,
        hasError: Boolean(latestAttempt.error)
      } : null,
      attemptsObserved: attempts.length,
      recentResults: results.map(result => ({ resultId: result.result_id, outcome: result.outcome, createdAt: result.created_at })),
      recentArtifacts: artifacts.map(artifact => ({ artifactId: artifact.artifact_id, jobId: artifact.job_id ?? null,
        taskId: artifact.task_id ?? null, kind: artifact.kind, schemaVersion: artifact.schema_version,
        producerRole: artifact.producer_role, status: artifact.status, supersedes: artifact.supersedes ?? null,
        contentHash: artifact.content_hash ?? null, createdAt: artifact.created_at })),
      leases: leases.map(lease => ({ leaseId: lease.lease_id, jobId: lease.job_id ?? null, taskId: lease.task_id ?? null,
        state: lease.state, attempt: lease.attempt, workerId: lease.worker_id ?? null, ownerEpoch: lease.owner_epoch ?? null,
        issuedAt: lease.issued_at, heartbeatAt: lease.heartbeat_at, expiresAt: lease.expires_at,
        expiredOrInvalid: String(lease.state || '').toUpperCase() === 'ACTIVE' &&
          (timestampMs(lease.expires_at) == null || timestampMs(lease.expires_at) <= nowMs), hasLastError: Boolean(lease.last_error) })),
      lineageAssessment: {
        taskId: task.task_id,
        attemptIds: attempts.map(attempt => attempt.attempt_id),
        resultIds: results.map(result => result.result_id),
        artifactIds: artifacts.map(artifact => artifact.artifact_id),
        leaseIds: leases.map(lease => lease.lease_id),
        artifactJobTaskLineage: crossJobArtifacts.length ? 'mismatch' : 'consistent_or_job_id_unavailable',
        artifactProducerRoleLineage: producerRoleMismatches.length ? 'mismatch' : 'consistent_or_role_unavailable',
        successfulResultWithRunningTask: successfulResultsWhileRunning,
        activeLeaseAttemptMismatchIds: mismatchedLeases.map(lease => lease.lease_id),
        observedCounts,
        truncated: { attempts: observedCounts.attempts > attempts.length, results: observedCounts.results > results.length,
          artifacts: observedCounts.artifacts > artifacts.length, leases: observedCounts.leases > leases.length },
        ownerAuthority: 'not_persisted_in_supported_workflow_schema',
        providerIdentity: 'not_persisted_in_supported_workflow_schema'
      },
      flags
    };
  });
}

function reportJob(db, job, { nowMs, staleAfterMs, procRoot }) {
  const tasks = listTaskRows(db, job.job_id, { nowMs, procRoot });
  // The compact latestEvents window is useful for display, but must not be
  // used as the complete event identity for reconciliation. Correlate every
  // durable event that names a task, retaining identifiers and bounded payload
  // summaries only (never result bodies or arbitrary event content).
  const allJobEvents = selectAvailable(db, 'events', ['event_id', 'job_id', 'type', 'payload_json', 'created_at'],
    'WHERE job_id=?', [job.job_id], 'ORDER BY created_at, rowid');
  const eventsByTaskId = new Map();
  for (const event of allJobEvents) {
    const taskId = correlatedTaskId(event);
    if (!taskId) continue;
    const list = eventsByTaskId.get(taskId) || [];
    list.push(event);
    eventsByTaskId.set(taskId, list);
  }
  for (const entry of tasks) {
    const correlated = eventsByTaskId.get(entry.task.taskId) || [];
    entry.eventLineage = {
      taskId: entry.task.taskId,
      eventIds: correlated.map(event => event.event_id),
      eventTypes: correlated.map(event => event.type),
      eventCount: correlated.length,
      firstEventAt: correlated[0]?.created_at || null,
      latestEventAt: correlated.at(-1)?.created_at || null,
      truncated: false,
      correlation: 'payload_task_id_exact_match'
    };
  }
  const runtime = selectAvailable(db, 'workflow_runtime_state', ['job_id', 'phase', 'attempt', 'resume_after', 'last_error', 'updated_at'],
    'WHERE job_id=?', [job.job_id], 'ORDER BY updated_at DESC', 'LIMIT 1')[0] || null;
  const events = selectAvailable(db, 'events', ['event_id', 'job_id', 'type', 'payload_json', 'created_at'],
    'WHERE job_id=?', [job.job_id], 'ORDER BY created_at DESC, rowid DESC', 'LIMIT 12');
  const completionEvents = selectAvailable(db, 'events', ['event_id', 'job_id', 'type', 'payload_json', 'created_at'],
    "WHERE job_id=? AND lower(type) LIKE '%completed%'", [job.job_id], 'ORDER BY created_at DESC, rowid DESC');
  const approvals = selectAvailable(db, 'approvals', ['approval_id', 'job_id', 'decision', 'actor', 'proposal_hash', 'created_at'],
    'WHERE job_id=?', [job.job_id], 'ORDER BY created_at DESC, rowid DESC', 'LIMIT 8');
  const activeLeases = tasks.flatMap(entry => entry.leases).filter(lease => String(lease.state || '').toUpperCase() === 'ACTIVE');
  const runningTasks = tasks.filter(entry => String(entry.task.status).toLowerCase() === 'running');
  const currentTaskEntry = tasks.find(entry => entry.task.taskId === job.active_task_id) || null;
  const taskTimes = tasks.map(entry => entry.task.updatedAt);
  const latestEventTime = events[0]?.created_at || null;
  const lastActivityAt = newestTimestamp([job.updated_at, runtime?.updated_at, latestEventTime, ...taskTimes,
    ...activeLeases.map(lease => lease.heartbeatAt)]);
  const activityAgeMs = ageMs(lastActivityAt, nowMs);
  const state = String(job.state || '').toUpperCase();
  const status = String(job.status || '').toLowerCase();
  const flags = [...new Set(tasks.flatMap(entry => entry.flags))];
  const activeTaskCompletionAfterUpdate = currentTaskEntry && completionEvents.some(event => {
    const taskId = correlatedTaskId(event);
    return taskId === job.active_task_id && timestampMs(event.created_at) != null &&
      timestampMs(currentTaskEntry.task.updatedAt) != null && timestampMs(event.created_at) > timestampMs(currentTaskEntry.task.updatedAt);
  });
  if (activeTaskCompletionAfterUpdate) flags.push('COMPLETION_EVENT_NEWER_THAN_ACTIVE_TASK_ROW');
  if (state === 'EXECUTING' && runningTasks.length === 0) flags.push('EXECUTING_JOB_WITHOUT_RUNNING_TASKS');
  if (state === 'EXECUTING' && currentTaskEntry && currentTaskEntry.task.status !== 'running') flags.push('ACTIVE_TASK_POINTER_NOT_RUNNING');
  if (state === 'EXECUTING' && runningTasks.length && !activeLeases.length) flags.push('RUNNING_TASKS_WITHOUT_ACTIVE_LEASES');
  if (state === 'EXECUTING' && !currentTaskEntry) flags.push('ACTIVE_TASK_POINTER_MISSING_OR_UNRESOLVED');
  if (runtime?.last_error) flags.push('WORKFLOW_RUNTIME_HAS_LAST_ERROR');

  let classification = 'active_non_executing_state';
  let ownerAction = 'Inspect the current proposal/approval state; do not dispatch from diagnostics.';
  if (status !== 'active' || TERMINAL_STATES.has(state)) {
    classification = 'terminal_or_inactive';
    ownerAction = 'No lifecycle action suggested by this report.';
  } else if (state === 'PROPOSED' || state === 'IDLE') {
    classification = 'awaiting_proposal_or_approval';
  } else if (state === 'APPROVED') {
    classification = 'awaiting_dispatch';
  } else if (Number(job.provider_waiting) === 1) {
    const retryAt = timestampMs(job.provider_retry_at);
    classification = retryAt != null && retryAt <= nowMs ? 'provider_retry_due' : 'provider_waiting';
    ownerAction = 'Inspect the external provider/run ID and retry contract; do not automatically retry or dispatch.';
  } else if (state === 'EXECUTING' && flags.length) {
    classification = activityAgeMs != null && activityAgeMs >= staleAfterMs
      ? 'stale_candidate_reconciliation_required' : 'lifecycle_reconciliation_required';
    ownerAction = 'Compare current task row, attempt records, result/artifact records, completion events, active leases and host-side worker identity. Preserve evidence and require the responsible owner to choose a documented lifecycle path.';
  } else if (state === 'EXECUTING' && activeLeases.length) {
    const newestHeartbeat = newestTimestamp(activeLeases.map(lease => lease.heartbeatAt));
    if (ageMs(newestHeartbeat, nowMs) != null && ageMs(newestHeartbeat, nowMs) < staleAfterMs) {
      classification = 'live_lease_heartbeat';
      ownerAction = 'Current lease heartbeat exists; continue ordinary monitoring and re-check if progress stops.';
    } else {
      classification = 'stale_lease_heartbeat_candidate';
      ownerAction = 'Verify process identity and attempt fencing with the owner before intervention; no lease or job is changed here.';
    }
  } else if (state === 'EXECUTING' && activityAgeMs != null && activityAgeMs >= staleAfterMs) {
    classification = 'stale_candidate';
    ownerAction = 'No fresh durable activity or active lease is visible. Verify host/provider worker and exact attempt/result lineage with the owner; age alone is not proof of death.';
  } else if (state === 'EXECUTING') {
    classification = runningTasks.length ? 'executing_without_lease_recent_activity' : 'executing_idle_recent_activity';
    ownerAction = 'Monitor durable events and ask the owner to confirm worker progress; do not infer success from the active state.';
  }

  return {
    jobId: job.job_id, title: job.title, state: job.state, status: job.status, phase: runtime?.phase || null,
    createdAt: job.created_at, updatedAt: job.updated_at, lastActivityAt, activityAgeMs, staleAfterMs,
    activeTaskId: job.active_task_id || null, providerWaiting: Boolean(Number(job.provider_waiting)), providerRetryAt: job.provider_retry_at || null,
    ownerBinding: { authority: 'unresolved_owner_identity_not_persisted', conversationKeyPresent: Boolean(job.conversation_key),
      conversationKeySha256: job.conversation_key ? hash(job.conversation_key) : null,
      currentTaskHasOpenClawRunId: Boolean(currentTaskEntry?.task.openClawRunId),
      currentTaskHasOpenClawSessionKey: Boolean(currentTaskEntry?.task.openClawSessionKey),
      currentTaskExecutionPid: currentTaskEntry?.task.executionPid ?? null,
      activeLeaseWorkerIdsPresent: activeLeases.some(lease => lease.workerId) },
    runtimeObservation: runtime ? { phase: runtime.phase ?? null, attempt: runtime.attempt ?? null,
      resumeAfter: runtime.resume_after ?? null, lastErrorPresent: Boolean(runtime.last_error), updatedAt: runtime.updated_at ?? null,
      providerIdentity: 'not_persisted_in_workflow_runtime_state_schema' } : { status: 'missing' },
    taskCounts: tasks.reduce((acc, entry) => { acc[entry.task.status] = (acc[entry.task.status] || 0) + 1; return acc; }, {}),
    runningTaskCount: runningTasks.length, activeLeaseCount: activeLeases.length,
    resultCount: selectAvailable(db, 'results', ['result_id'], 'WHERE task_id IN (SELECT task_id FROM tasks WHERE job_id=?)', [job.job_id]).length,
    artifactCount: selectAvailable(db, 'artifacts', ['artifact_id'], 'WHERE job_id=? AND (status IS NULL OR status<>?)', [job.job_id, 'inactive']).length,
    latestApproval: approvals[0] ? { decision: approvals[0].decision, actor: approvals[0].actor, createdAt: approvals[0].created_at,
      proposalHash: approvals[0].proposal_hash ?? null } : null,
    allJobEventIds: allJobEvents.map(event => event.event_id),
    latestEvents: events.reverse().map(event => ({ type: event.type, createdAt: event.created_at, eventId: event.event_id,
      payloadSummary: summarizePayload(parseJson(event.payload_json || '{}')) })),
    completionEventEvidence: { scannedCount: completionEvents.length, truncated: false,
      matchingActiveTaskEventIds: completionEvents.filter(event => correlatedTaskId(event) === job.active_task_id).map(event => event.event_id) },
    tasks, flags: [...new Set(flags)], classification, ownerAction
  };
}

export function buildActiveWorkflowReconciliationReport(db, { jobId = null, limit = 200, staleAfterMs = 900_000,
  now = new Date().toISOString(), procRoot = '/proc' } = {}) {
  if (!db || typeof db.prepare !== 'function') fail('RECONCILIATION_DB_REQUIRED', 'a SQLite read-only connection is required');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REPORT_JOBS) fail('RECONCILIATION_LIMIT_INVALID', `limit must be 1..${MAX_REPORT_JOBS}`);
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 60_000 || staleAfterMs > 7 * 24 * 60 * 60 * 1000) fail('RECONCILIATION_STALE_AFTER_INVALID', 'stale_after_ms must be 60,000..604,800,000');
  const nowMs = timestampMs(now);
  if (nowMs == null) fail('RECONCILIATION_NOW_INVALID', 'now must be a valid ISO timestamp');
  if (!tableExists(db, 'jobs') || !tableExists(db, 'tasks') || !tableExists(db, 'events')) {
    fail('RECONCILIATION_SCHEMA_UNSUPPORTED', 'database must contain jobs, tasks and events tables');
  }
  requireColumns(db, 'jobs', ['job_id', 'state', 'status', 'created_at', 'updated_at']);
  requireColumns(db, 'tasks', ['task_id', 'job_id', 'status', 'created_at', 'updated_at']);
  requireColumns(db, 'events', ['event_id', 'job_id', 'type', 'payload_json', 'created_at']);
  const jobs = jobId
    ? selectAvailable(db, 'jobs', ['job_id', 'conversation_key', 'title', 'state', 'status', 'active_task_id', 'provider_waiting', 'provider_retry_at', 'created_at', 'updated_at'],
      'WHERE job_id=?', [jobId], '', 'LIMIT 1')
    : selectAvailable(db, 'jobs', ['job_id', 'conversation_key', 'title', 'state', 'status', 'active_task_id', 'provider_waiting', 'provider_retry_at', 'created_at', 'updated_at'],
      "WHERE status='active'", [limit], 'ORDER BY COALESCE(updated_at,created_at) ASC', 'LIMIT ?');
  if (jobId && !jobs.length) fail('RECONCILIATION_JOB_NOT_FOUND', `job not found: ${jobId}`);
  const diagnostics = jobs.map(job => reportJob(db, job, { nowMs, staleAfterMs, procRoot }));
  const recoveryPlan = diagnostics.map(item => {
    const identity = {
      jobId: item.jobId, state: item.state, status: item.status, activeTaskId: item.activeTaskId,
      taskIds: item.tasks.map(entry => entry.task.taskId),
      taskEventIds: item.tasks.map(entry => ({ taskId: entry.task.taskId, eventIds: entry.eventLineage.eventIds })),
      attemptIds: item.tasks.flatMap(entry => entry.lineageAssessment.attemptIds),
      resultIds: item.tasks.flatMap(entry => entry.lineageAssessment.resultIds),
      artifactIds: item.tasks.flatMap(entry => entry.lineageAssessment.artifactIds),
      leaseIds: item.tasks.flatMap(entry => entry.lineageAssessment.leaseIds),
      latestEventIds: item.latestEvents.map(event => event.eventId).sort(),
      allJobEventIds: item.allJobEventIds
    };
    return {
      jobId: item.jobId,
      action: 'HOLD_FOR_OWNER_RECONCILIATION',
      authorizationGranted: false,
      idempotencyKey: `reconcile-${hash(JSON.stringify(identity))}`,
      observedIdentity: identity,
      requiredChecks: [
        'Confirm responsible owner and provider/runtime identity through host-owned records; the workflow schema does not persist authoritative owner/provider IDs.',
        'Re-query job, task, attempt, result, artifact, event and lease rows; compare IDs and timestamps against this report.',
        'Verify worker/process identity and lease fencing with the host/provider before any intervention.',
        'Establish outcome from authoritative attempt/result/artifact lineage and review blockers/approval decision.',
        'Use only the documented owner-authorized lifecycle transition; rerun diagnostics and confirm idempotent outcome.'
      ],
      prohibitedWithoutEvidenceAndAuthority: ['reset', 'terminalize', 'retry', 'approve', 'dispatch', 'kill_process'],
      staleAfterReport: true
    };
  });
  const countBy = key => diagnostics.reduce((counts, item) => { counts[item[key]] = (counts[item[key]] || 0) + 1; return counts; }, {});
  const tableSummary = Object.fromEntries(['jobs', 'events', 'tasks', 'results', 'artifacts', 'attempts', 'task_leases', 'approvals']
    .map(table => [table, tableExists(db, table) ? db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count : null]));
  return {
    schemaVersion: 1, generatedAt: new Date(nowMs).toISOString(), readOnly: true,
    purpose: 'owner-guided reconciliation; diagnostic report only; no lifecycle changes, lease changes, retries, approvals, or dispatch',
    scope: jobId ? 'single_job' : 'active_jobs', jobFilter: jobId, limit, staleAfterMs,
    dbPath: null, tableCounts: tableSummary,
    summary: { consideredJobs: diagnostics.length, byClassification: countBy('classification'),
      jobsFlaggedForReconciliation: diagnostics.filter(item => item.flags.length > 0).length,
      staleCandidates: diagnostics.filter(item => item.classification === 'stale_candidate' || item.classification === 'stale_candidate_reconciliation_required').length,
      jobsWithRunningTasksButNoActiveLeases: diagnostics.filter(item => item.runningTaskCount > 0 && item.activeLeaseCount === 0).length },
    policy: { staleCandidateIsNotProofOfWorkerDeath: true, missingLeaseDoesNotAuthorizeTerminalization: true,
      callerMustVerifyHostAndProviderState: true, noAutomaticRecovery: true },
    diagnostics,
    recoveryPlan
  };
}

function parseArgs(argv) {
  const args = { db: DEFAULT_DB, jobId: null, limit: 200, staleAfterMs: 900_000, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    const key = ({ '--db': 'db', '--job-id': 'jobId', '--limit': 'limit', '--stale-after-ms': 'staleAfterMs', '--out': 'out' })[arg];
    if (!key) fail('RECONCILIATION_ARGUMENT_INVALID', `unknown argument: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) fail('RECONCILIATION_ARGUMENT_MISSING', `${arg} requires a value`);
    if (key === 'limit' || key === 'staleAfterMs') {
      if (!/^[0-9]+$/.test(value)) fail('RECONCILIATION_ARGUMENT_INVALID', `${arg} must be an integer`);
      args[key] = Number(value);
    } else args[key] = value;
  }
  return args;
}

function writeExclusive(outPath, contents) {
  const absolute = path.resolve(outPath);
  const parent = path.dirname(absolute);
  if (fs.realpathSync(parent) !== parent) fail('RECONCILIATION_OUTPUT_PATH_UNSAFE', 'output parent must be canonical and not symlinked');
  if (fs.existsSync(absolute)) fail('RECONCILIATION_OUTPUT_EXISTS', `refusing to overwrite ${absolute}`);
  const fd = fs.openSync(absolute, 'wx', 0o600);
  try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); }
  catch (error) { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(absolute); } catch {} throw error; }
  fs.closeSync(fd);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('Usage: node scripts/reconcile-active-workflows.mjs [--db PATH] [--job-id ID] [--limit 1..200] [--stale-after-ms 60000..604800000] [--out NEW_PATH]\nRead-only SQLite diagnostic. Never mutates workflow state or attempts recovery.\n');
    return 0;
  }
  const dbPath = path.resolve(args.db);
  const stat = fs.lstatSync(dbPath);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(dbPath) !== dbPath) {
    fail('RECONCILIATION_DB_PATH_UNSAFE', 'database path must be a canonical regular file, not a symlink');
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const report = buildActiveWorkflowReconciliationReport(db, args);
    report.dbPath = dbPath;
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (args.out) {
      writeExclusive(args.out, serialized);
      process.stdout.write(`${JSON.stringify({ result: 'PASS', readOnly: true, output: path.resolve(args.out), reportSha256: hash(serialized),
        summary: report.summary }, null, 2)}\n`);
    } else process.stdout.write(serialized);
    return 0;
  } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ result: 'FAIL', code: error?.code || 'RECONCILIATION_FAILED', message: String(error?.message || error) }, null, 2)}\n`);
    process.exitCode = 2;
  }
}
