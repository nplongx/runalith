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
const MAX_LINEAGE_SCAN_NODES = 50_000;
const MAX_LINEAGE_SCAN_DEPTH = 16;
const MAX_LINEAGE_SCAN_ARRAY_ITEMS = 10_000;

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

function correlatedTaskIds(event) {
  const payload = parseJson(event.payload_json || '{}');
  const taskIds = new Set();
  const scan = { visited: 0, truncated: false };
  const visit = (value, parentKey = '', depth = 0) => {
    if (value === null || typeof value !== 'object') return;
    if (depth > MAX_LINEAGE_SCAN_DEPTH || scan.visited >= MAX_LINEAGE_SCAN_NODES) {
      scan.truncated = true;
      return;
    }
    scan.visited += 1;
    if (Array.isArray(value)) {
      if (value.length > MAX_LINEAGE_SCAN_ARRAY_ITEMS) scan.truncated = true;
      for (const child of value.slice(0, MAX_LINEAGE_SCAN_ARRAY_ITEMS)) {
        if (scan.visited >= MAX_LINEAGE_SCAN_NODES) { scan.truncated = true; break; }
        visit(child, parentKey, depth + 1);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (scan.visited >= MAX_LINEAGE_SCAN_NODES) { scan.truncated = true; break; }
      scan.visited += 1;
      const normalized = key.replace(/[^a-z]/gi, '').toLowerCase();
      const normalizedParent = parentKey.replace(/[^a-z]/gi, '').toLowerCase();
      if (typeof child === 'string' && child.trim() &&
          (normalized === 'taskid' || normalized === 'task' || (normalized === 'id' && normalizedParent === 'task'))) {
        taskIds.add(child.trim());
      }
      if (child !== null && typeof child === 'object') visit(child, key, depth + 1);
      if (scan.visited >= MAX_LINEAGE_SCAN_NODES) { scan.truncated = true; break; }
    }
  };
  visit(payload);
  return { taskIds: [...taskIds], truncated: scan.truncated, nodesVisited: scan.visited };
}

function collectLineageReferences(value, result = { attemptIds: new Set(), resultIds: new Set(), artifactIds: new Set(), truncated: false, nodesVisited: 0 }, depth = 0) {
  if (value === null || typeof value !== 'object') return result;
  if (depth > MAX_LINEAGE_SCAN_DEPTH || result.nodesVisited >= MAX_LINEAGE_SCAN_NODES) {
    result.truncated = true;
    return result;
  }
  result.nodesVisited += 1;
  if (Array.isArray(value)) {
    if (value.length > MAX_LINEAGE_SCAN_ARRAY_ITEMS) result.truncated = true;
    for (const child of value.slice(0, MAX_LINEAGE_SCAN_ARRAY_ITEMS)) {
      if (result.nodesVisited >= MAX_LINEAGE_SCAN_NODES) { result.truncated = true; break; }
      collectLineageReferences(child, result, depth + 1);
    }
    return result;
  }
  for (const [key, item] of Object.entries(value)) {
    if (result.nodesVisited >= MAX_LINEAGE_SCAN_NODES) { result.truncated = true; break; }
    result.nodesVisited += 1;
    const normalized = key.replace(/[^a-z]/gi, '').toLowerCase();
    if (typeof item === 'string' && item.trim()) {
      if (normalized === 'attemptid' || normalized === 'attempt') result.attemptIds.add(item);
      else if (normalized === 'resultid') result.resultIds.add(item);
      else if (normalized === 'artifactid') result.artifactIds.add(item);
    }
    if (item !== null && typeof item === 'object') collectLineageReferences(item, result, depth + 1);
    if (result.nodesVisited >= MAX_LINEAGE_SCAN_NODES) { result.truncated = true; break; }
  }
  return result;
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
    // Provider-run schemas evolved over time. Prefer exact task binding; if a
    // legacy table only binds runs to a job, retain the rows as ambiguous
    // evidence rather than silently dropping possible remote side effects.
    const providerRunColumns = tableColumns(db, 'provider_runs');
    let providerRunSchemaStatus = 'TABLE_MISSING';
    let providerRuns = [];
    if (providerRunColumns.size) {
      const providerRunFields = ['provider_run_id', 'provider', 'job_id', 'task_id', 'lease_id', 'attempt', 'run_attempt',
        'input_commit', 'workflow', 'ref', 'state', 'status', 'conclusion', 'dispatch_key', 'request_sha256', 'owner_epoch',
        'created_at', 'updated_at'];
      if (providerRunColumns.has('task_id')) {
        providerRunSchemaStatus = 'TASK_BOUND_SCHEMA';
        // Preserve malformed rows with NULL task IDs. They may represent a
        // remote side effect whose task binding was lost; do not silently drop
        // them from reconciliation just because this schema normally has task_id.
        if (providerRunColumns.has('job_id')) {
          providerRuns = selectAvailable(db, 'provider_runs', providerRunFields,
            'WHERE job_id=? AND (task_id=? OR task_id IS NULL)', [jobId, task.task_id], 'ORDER BY updated_at, rowid')
            .map(run => run.task_id == null ? { ...run, task_binding_status: 'UNBOUND_NULL_TASK_ID' } : run);
        } else {
          providerRuns = selectAvailable(db, 'provider_runs', providerRunFields,
            'WHERE task_id=? OR task_id IS NULL', [task.task_id], 'ORDER BY updated_at, rowid')
            .map(run => run.task_id == null ? { ...run, task_binding_status: 'UNBOUND_NULL_TASK_ID' } : run);
        }
      } else if (providerRunColumns.has('job_id')) {
        providerRunSchemaStatus = 'LEGACY_JOB_ONLY_BINDING';
        providerRuns = selectAvailable(db, 'provider_runs', providerRunFields, 'WHERE job_id=?', [jobId], 'ORDER BY updated_at, rowid')
          .map(run => ({ ...run, task_binding_status: 'UNBOUND_AMBIGUOUS' }));
      } else {
        providerRunSchemaStatus = 'SCHEMA_WITHOUT_TASK_OR_JOB_BINDING';
      }
    }
    const terminalProviderStates = new Set(['COMPLETED', 'SUCCEEDED', 'SUCCESS', 'FAILED', 'CANCELLED', 'CANCELED', 'TERMINAL']);
    const nonterminalProviderRuns = providerRuns.filter(run => {
      const state = String(run.state || run.status || '').trim().toUpperCase();
      return !terminalProviderStates.has(state);
    });
    const latestAttempt = attempts[0] || null;
    const activeLeases = leases.filter(lease => String(lease.state || '').toUpperCase() === 'ACTIVE');
    const updatedAge = ageMs(task.updated_at, nowMs);
    const flags = [];
    if (nonterminalProviderRuns.length) flags.push('NONTERMINAL_PROVIDER_RUN_REQUIRES_RECONCILIATION');
    const nonterminalUnboundProviderRuns = nonterminalProviderRuns.filter(run =>
      run.task_binding_status === 'UNBOUND_AMBIGUOUS' || run.task_binding_status === 'UNBOUND_NULL_TASK_ID');
    if ((providerRunSchemaStatus === 'LEGACY_JOB_ONLY_BINDING' || nonterminalUnboundProviderRuns.length) && nonterminalProviderRuns.length) {
      flags.push('NONTERMINAL_PROVIDER_RUN_WITHOUT_TASK_BINDING');
    }
    const providerRunLeaseMismatches = providerRuns.filter(run => run.lease_id &&
      !activeLeases.some(lease => lease.lease_id === run.lease_id));
    const providerRunEpochMismatches = providerRuns.filter(run => run.lease_id && run.owner_epoch != null && activeLeases.some(lease =>
      lease.lease_id === run.lease_id && lease.owner_epoch != null && Number(lease.owner_epoch) !== Number(run.owner_epoch)));
    if (providerRunLeaseMismatches.length) flags.push('PROVIDER_RUN_LEASE_BINDING_MISMATCH');
    if (providerRunEpochMismatches.length) flags.push('PROVIDER_RUN_OWNER_EPOCH_MISMATCH');
    if (providerRunSchemaStatus === 'SCHEMA_WITHOUT_TASK_OR_JOB_BINDING' && providerRunColumns.size) {
      flags.push('PROVIDER_RUN_SCHEMA_CANNOT_BIND_WORKFLOW_RECORDS');
    }
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
    // Bind the dry-run reconciliation identity to observed row content, not
    // only stable IDs. Hash locally and expose only the digest; never include
    // result bodies, artifact payloads, or lease secrets in the report.
    const rowFingerprint = hash(JSON.stringify({
      task: selectAvailable(db, 'tasks', ['task_id', 'job_id', 'role', 'status', 'openclaw_run_id', 'openclaw_session_key',
        'parent_task_id', 'dependency_json', 'metadata_json', 'created_at', 'updated_at', 'execution_session_id',
        'execution_status', 'execution_attempt', 'execution_pid', 'execution_exit_code', 'execution_started_at', 'execution_finished_at'],
      'WHERE task_id=?', [task.task_id], '', 'LIMIT 2'),
      attempts: selectAvailable(db, 'attempts', ['attempt_id', 'task_id', 'status', 'openclaw_run_id', 'started_at', 'finished_at', 'error'],
        'WHERE task_id=?', [task.task_id], 'ORDER BY started_at, rowid'),
      results: selectAvailable(db, 'results', ['result_id', 'task_id', 'outcome', 'content', 'content_hash', 'created_at'],
        'WHERE task_id=?', [task.task_id], 'ORDER BY created_at, rowid'),
      artifacts: selectAvailable(db, 'artifacts', ['artifact_id', 'job_id', 'task_id', 'kind', 'uri', 'metadata_json', 'created_at',
        'schema_version', 'producer_role', 'content', 'evidence_json', 'status', 'supersedes', 'content_hash'],
      'WHERE task_id=?', [task.task_id], 'ORDER BY created_at, rowid'),
      leases: selectAvailable(db, 'task_leases', ['lease_id', 'task_id', 'job_id', 'attempt', 'worker_id', 'state', 'issued_at',
        'heartbeat_at', 'expires_at', 'released_at', 'last_error', 'owner_epoch'], 'WHERE task_id=?', [task.task_id], 'ORDER BY rowid'),
      providerRuns
    }));
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
        dependencyIds: parseJson(task.dependency_json || '[]'),
        workflowPlanTaskId: (() => {
          const metadata = parseJson(task.metadata_json || '{}');
          return typeof metadata?.workflow_plan_task_id === 'string' ? metadata.workflow_plan_task_id : null;
        })()
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
      providerRuns: providerRuns.map(run => ({ providerRunId: run.provider_run_id ?? null, provider: run.provider ?? null,
        jobId: run.job_id ?? null, taskId: run.task_id ?? null, taskBindingStatus: run.task_binding_status ||
          (providerRunColumns.has('task_id') ? 'TASK_BOUND_BY_ROW' : 'UNBOUND_AMBIGUOUS'), leaseId: run.lease_id ?? null,
        attempt: run.attempt ?? null, runAttempt: run.run_attempt ?? null, state: run.state ?? run.status ?? null,
        conclusion: run.conclusion ?? null, ownerEpoch: run.owner_epoch ?? null, dispatchKeyPresent: Boolean(run.dispatch_key),
        requestSha256: run.request_sha256 ?? null, createdAt: run.created_at ?? null, updatedAt: run.updated_at ?? null })),
      providerRunSchemaStatus,
      lineageAssessment: {
        taskId: task.task_id,
        attemptIds: attempts.map(attempt => attempt.attempt_id),
        resultIds: results.map(result => result.result_id),
        artifactIds: artifacts.map(artifact => artifact.artifact_id),
        leaseIds: leases.map(lease => lease.lease_id),
        providerRunIds: providerRuns.map(run => run.provider_run_id).filter(Boolean),
        providerRunSchemaStatus,
        providerRunTaskBinding: providerRunSchemaStatus === 'TASK_BOUND_SCHEMA' ? 'TASK_BOUND_BY_SCHEMA'
          : providerRunSchemaStatus === 'LEGACY_JOB_ONLY_BINDING' ? 'AMBIGUOUS_JOB_ONLY_BINDING' : providerRunSchemaStatus,
        nonterminalProviderRunIds: nonterminalProviderRuns.map(run => run.provider_run_id).filter(Boolean),
        nonterminalUnboundProviderRunCount: nonterminalUnboundProviderRuns.length,
        providerRunLeaseMismatchIds: providerRunLeaseMismatches.map(run => run.provider_run_id).filter(Boolean),
        providerRunOwnerEpochMismatchIds: providerRunEpochMismatches.map(run => run.provider_run_id).filter(Boolean),
        artifactJobTaskLineage: crossJobArtifacts.length ? 'mismatch' : 'consistent_or_job_id_unavailable',
        artifactProducerRoleLineage: producerRoleMismatches.length ? 'mismatch' : 'consistent_or_role_unavailable',
        successfulResultWithRunningTask: successfulResultsWhileRunning,
        activeLeaseAttemptMismatchIds: mismatchedLeases.map(lease => lease.lease_id),
        observedCounts,
        rowFingerprint,
        truncated: { attempts: observedCounts.attempts > attempts.length, results: observedCounts.results > results.length,
          artifacts: observedCounts.artifacts > artifacts.length, leases: observedCounts.leases > leases.length },
        ownerAuthority: 'not_persisted_in_supported_workflow_schema',
        providerIdentity: 'not_persisted_in_supported_workflow_schema'
      },
      lifecycleEvidence: {
        disposition: 'HOLD_UNKNOWN_UNLESS_AUTHORITATIVE_EVIDENCE_COMPLETE',
        owner: { status: 'UNVERIFIED', reason: 'authoritative owner identity is not persisted in the supported workflow schema' },
        provider: { status: 'UNVERIFIED', reason: providerRunSchemaStatus === 'TASK_BOUND_SCHEMA'
          ? 'provider-run rows are observed but do not independently authenticate provider identity or remote outcome'
          : providerRunSchemaStatus === 'LEGACY_JOB_ONLY_BINDING'
            ? 'legacy provider-run rows lack task binding; any nonterminal run remains ambiguous across tasks in this job'
            : providerRunSchemaStatus === 'TABLE_MISSING'
              ? 'provider_runs table is absent from this workflow database schema'
              : 'provider_runs schema cannot bind rows to this job/task' },
        runtime: task.execution_pid == null && !task.execution_session_id && !task.openclaw_run_id
          ? { status: 'MISSING', reason: 'no persisted execution PID, session ID, or provider run ID' }
          : { status: 'OBSERVED_NOT_AUTHENTICATED', reason: 'persisted identifiers do not independently prove current process/provider ownership' },
        lease: activeLeases.length ? { status: 'PRESENT_REQUIRES_FENCING_VALIDATION' }
          : { status: 'MISSING_NOT_PROOF_OF_WORKER_DEATH' },
        eventReferences: { status: 'PENDING_JOB_EVENT_CORRELATION' },
        automaticLifecycleActionAuthorized: false
      },
      flags
    };
  });
}

function reportJob(db, job, { nowMs, staleAfterMs, procRoot }) {
  const tasks = listTaskRows(db, job.job_id, { nowMs, procRoot });
  const taskById = new Map(tasks.map(entry => [entry.task.taskId, entry]));
  const planRows = selectAvailable(db, 'workflow_plans', ['job_id', 'workflow_id', 'workflow_version', 'plan_hash', 'plan_json'],
    'WHERE job_id=?', [job.job_id], '', 'LIMIT 2');
  let planBinding = { status: 'MISSING_NOT_PROOF_OF_TASK_INVALIDITY', planHash: null, specsById: new Map(), cycleIds: new Set(), blockers: [] };
  if (planRows.length === 1) {
    const row = planRows[0];
    let plan;
    try { plan = JSON.parse(row.plan_json); } catch { plan = null; }
    const children = Array.isArray(plan?.children) ? plan.children : null;
    const planIdentityMatches = plan && plan.job_id === job.job_id && plan.workflow_id === row.workflow_id &&
      Number(plan.workflow_version) === Number(row.workflow_version);
    if (hash(row.plan_json || '') !== row.plan_hash || !planIdentityMatches || !children) {
      planBinding = { status: 'INVALID_HASH_IDENTITY_OR_SCHEMA', planHash: row.plan_hash || null, specsById: new Map(), cycleIds: new Set(), blockers: ['WORKFLOW_PLAN_HASH_IDENTITY_OR_SCHEMA_INVALID'] };
    } else {
      const specs = [...children, ...(plan.synthesis && typeof plan.synthesis === 'object' ? [plan.synthesis] : [])];
      const specsById = new Map();
      let malformed = false;
      for (const spec of specs) {
        if (!spec || typeof spec.id !== 'string' || !spec.id.trim() || specsById.has(spec.id) ||
            !Array.isArray(spec.dependencies ?? [])) { malformed = true; break; }
        const dependencies = spec.dependencies ?? [];
        if (dependencies.some(value => typeof value !== 'string' || !value.trim()) ||
            new Set(dependencies).size !== dependencies.length || dependencies.includes(spec.id)) { malformed = true; break; }
        specsById.set(spec.id, { id: spec.id, dependencies: [...dependencies] });
      }
      if (malformed) {
        planBinding = { status: 'INVALID_PLAN_TASK_SCHEMA', planHash: row.plan_hash || null, specsById: new Map(), cycleIds: new Set(), blockers: ['WORKFLOW_PLAN_TASK_SCHEMA_INVALID'] };
      } else {
        planBinding = { status: 'HASH_BOUND_DIAGNOSTIC_ONLY', planHash: row.plan_hash, specsById, cycleIds: new Set(), blockers: [] };
        const danglingDependencies = [...specsById.values()].flatMap(spec => spec.dependencies
          .filter(dependencyId => !specsById.has(dependencyId))
          .map(dependencyId => ({ taskId: spec.id, dependencyId })));
        if (danglingDependencies.length) {
          planBinding.blockers.push('WORKFLOW_PLAN_DEPENDENCY_TARGET_MISSING');
          planBinding.danglingDependencies = danglingDependencies;
        }
        const colors = new Map(); const stack = [];
        const visit = id => {
          const color = colors.get(id) || 0;
          if (color === 2) return;
          if (color === 1) {
            const start = stack.lastIndexOf(id);
            for (const cycleId of stack.slice(Math.max(0, start))) planBinding.cycleIds.add(cycleId);
            planBinding.cycleIds.add(id);
            return;
          }
          colors.set(id, 1); stack.push(id);
          for (const dependencyId of specsById.get(id)?.dependencies || []) if (specsById.has(dependencyId)) visit(dependencyId);
          stack.pop(); colors.set(id, 2);
        };
        for (const id of specsById.keys()) visit(id);
        if (planBinding.cycleIds.size) planBinding.blockers.push('WORKFLOW_PLAN_DEPENDENCY_CYCLE_DETECTED');
      }
    }
  } else if (planRows.length > 1) {
    planBinding = { status: 'AMBIGUOUS_PLAN_ROWS', planHash: null, specsById: new Map(), cycleIds: new Set(), blockers: ['WORKFLOW_PLAN_ROWS_AMBIGUOUS'] };
  }
  const materializedByPlanId = new Map();
  for (const entry of tasks) {
    const planTaskId = entry.task.workflowPlanTaskId;
    if (!planTaskId) continue;
    if (!materializedByPlanId.has(planTaskId)) materializedByPlanId.set(planTaskId, []);
    materializedByPlanId.get(planTaskId).push(entry);
  }
  for (const entry of tasks) {
    const task = entry.task;
    const hierarchyBlockers = [];
    const parentTaskId = task.parentTaskId;
    let parent = { status: parentTaskId ? 'UNRESOLVED' : 'NOT_APPLICABLE', taskId: parentTaskId || null,
      reason: parentTaskId ? 'parent task ID is not present in the same job task inventory' : null };
    if (parentTaskId) {
      const sameJobParent = taskById.get(parentTaskId);
      if (sameJobParent) {
        parent = { status: 'RESOLVED', taskId: parentTaskId, taskStatus: sameJobParent.task.status };
      } else {
        const externalParent = selectAvailable(db, 'tasks', ['task_id', 'job_id', 'status'],
          'WHERE task_id=?', [parentTaskId], '', 'LIMIT 2');
        if (externalParent.some(row => row.job_id !== job.job_id)) {
          parent = { status: 'CROSS_JOB', taskId: parentTaskId,
            observedJobIds: [...new Set(externalParent.map(row => row.job_id).filter(Boolean))].slice(0, 4) };
          hierarchyBlockers.push('TASK_PARENT_CROSS_JOB');
          entry.flags.push('TASK_PARENT_CROSS_JOB');
        } else {
          parent = { status: 'UNRESOLVED', taskId: parentTaskId, reason: 'parent task row is missing' };
          hierarchyBlockers.push('TASK_PARENT_REFERENCE_UNRESOLVED');
          entry.flags.push('TASK_PARENT_REFERENCE_UNRESOLVED');
        }
      }
    }

    let dependencies = task.dependencyIds;
    const dependenciesSchemaValid = Array.isArray(dependencies) &&
      !dependencies.some(value => typeof value !== 'string' || !value.trim()) &&
      new Set(dependencies).size === dependencies.length && !dependencies.includes(task.workflowPlanTaskId);
    if (!dependenciesSchemaValid) {
      dependencies = Array.isArray(dependencies) ? dependencies : [];
      hierarchyBlockers.push('TASK_DEPENDENCIES_SCHEMA_INVALID');
      entry.flags.push('TASK_DEPENDENCIES_SCHEMA_INVALID');
    }
    let planDependencyBinding = { status: 'NOT_VERIFIABLE', expectedPlanTaskIds: null, observedPlanTaskIds: [...dependencies].sort(), missingPlanTaskIds: [], unexpectedPlanTaskIds: [] };
    const boundPlanSpec = task.workflowPlanTaskId && planBinding.status === 'HASH_BOUND_DIAGNOSTIC_ONLY'
      ? planBinding.specsById.get(task.workflowPlanTaskId) : null;
    if (boundPlanSpec && dependenciesSchemaValid) {
      const expected = [...boundPlanSpec.dependencies].sort();
      const observed = [...dependencies].sort();
      const expectedSet = new Set(expected);
      const observedSet = new Set(observed);
      const missingPlanTaskIds = expected.filter(id => !observedSet.has(id));
      const unexpectedPlanTaskIds = observed.filter(id => !expectedSet.has(id));
      const matched = missingPlanTaskIds.length === 0 && unexpectedPlanTaskIds.length === 0;
      planDependencyBinding = { status: matched ? 'MATCHED_IMMUTABLE_PLAN' : 'MATERIALIZATION_MISMATCH',
        expectedPlanTaskIds: expected, observedPlanTaskIds: observed, missingPlanTaskIds, unexpectedPlanTaskIds };
      if (!matched) {
        hierarchyBlockers.push('TASK_DEPENDENCY_MATERIALIZATION_MISMATCH');
        entry.flags.push('TASK_DEPENDENCY_MATERIALIZATION_MISMATCH');
      }
    }
    const dependencyFindings = [];
    if (dependencies.length && planBinding.status !== 'HASH_BOUND_DIAGNOSTIC_ONLY') {
      hierarchyBlockers.push('TASK_DEPENDENCY_PLAN_UNVERIFIED');
      entry.flags.push('TASK_DEPENDENCY_PLAN_UNVERIFIED');
    }
    if (task.workflowPlanTaskId && planBinding.status === 'HASH_BOUND_DIAGNOSTIC_ONLY' && !planBinding.specsById.has(task.workflowPlanTaskId)) {
      hierarchyBlockers.push('TASK_PLAN_BINDING_NOT_IN_IMMUTABLE_PLAN');
      entry.flags.push('TASK_PLAN_BINDING_NOT_IN_IMMUTABLE_PLAN');
    }
    for (const dependencyId of dependencies) {
      if (typeof dependencyId !== 'string' || !dependencyId.trim()) continue;
      if (planBinding.status !== 'HASH_BOUND_DIAGNOSTIC_ONLY') {
        dependencyFindings.push({ planTaskId: dependencyId, status: 'PLAN_UNVERIFIED' });
        continue;
      }
      if (!planBinding.specsById.has(dependencyId)) {
        dependencyFindings.push({ planTaskId: dependencyId, status: 'NOT_IN_IMMUTABLE_PLAN' });
        hierarchyBlockers.push('TASK_DEPENDENCY_NOT_IN_IMMUTABLE_PLAN');
        entry.flags.push('TASK_DEPENDENCY_NOT_IN_IMMUTABLE_PLAN');
        continue;
      }
      const matchingTasks = materializedByPlanId.get(dependencyId) || [];
      if (matchingTasks.length === 0) {
        dependencyFindings.push({ planTaskId: dependencyId, status: 'NOT_MATERIALIZED' });
        if (['running', 'completed'].includes(String(task.status || '').toLowerCase())) {
          hierarchyBlockers.push('TASK_DEPENDENCY_PRODUCER_NOT_MATERIALIZED');
          entry.flags.push('TASK_DEPENDENCY_PRODUCER_NOT_MATERIALIZED');
        }
      } else if (matchingTasks.length > 1) {
        dependencyFindings.push({ planTaskId: dependencyId, status: 'AMBIGUOUS_MATERIALIZATION', observedTaskCount: matchingTasks.length });
        hierarchyBlockers.push('TASK_DEPENDENCY_PRODUCER_AMBIGUOUS');
        entry.flags.push('TASK_DEPENDENCY_PRODUCER_AMBIGUOUS');
      } else {
        const dependency = matchingTasks[0];
        const depStatus = String(dependency.task.status || '').toLowerCase();
        dependencyFindings.push({ planTaskId: dependencyId, taskId: dependency.task.taskId,
          status: depStatus === 'completed' ? 'SATISFIED' : 'NOT_COMPLETED', taskStatus: dependency.task.status });
        if (['running', 'completed'].includes(String(task.status || '').toLowerCase()) && depStatus !== 'completed') {
          hierarchyBlockers.push('TASK_DEPENDENCY_NOT_COMPLETED');
          entry.flags.push('TASK_DEPENDENCY_NOT_COMPLETED');
        }
      }
    }
    entry.lifecycleEvidence.taskHierarchy = {
      status: hierarchyBlockers.length ? 'CONFLICTING' : 'OBSERVED_CONSISTENT_OR_EMPTY',
      completeness: 'DIAGNOSTIC_ONLY_NOT_EXECUTION_AUTHORIZATION',
      planBinding: { status: planBinding.status, planHash: planBinding.planHash, blockers: planBinding.blockers },
      parent,
      dependencies: dependencyFindings,
      planDependencyBinding,
      dependencyCount: Array.isArray(task.dependencyIds) ? task.dependencyIds.length : null,
      blockers: [...new Set(hierarchyBlockers)],
      automaticLifecycleActionAuthorized: false
    };
  }
  for (const entry of tasks) {
    if (!entry.task.workflowPlanTaskId || !planBinding.cycleIds.has(entry.task.workflowPlanTaskId)) continue;
    entry.flags.push('TASK_DEPENDENCY_CYCLE_DETECTED');
    entry.lifecycleEvidence.taskHierarchy.status = 'CONFLICTING';
    entry.lifecycleEvidence.taskHierarchy.blockers = [...new Set([
      ...entry.lifecycleEvidence.taskHierarchy.blockers, 'TASK_DEPENDENCY_CYCLE_DETECTED'
    ])];
  }
  // The compact latestEvents window is useful for display, but must not be
  // used as the complete event identity for reconciliation. Correlate every
  // durable event that names a task, retaining identifiers and bounded payload
  // summaries only (never result bodies or arbitrary event content).
  const allJobEvents = selectAvailable(db, 'events', ['event_id', 'job_id', 'type', 'payload_json', 'created_at'],
    'WHERE job_id=?', [job.job_id], 'ORDER BY created_at, rowid');
  const allJobEventsPayloadFingerprint = hash(JSON.stringify(allJobEvents.map(event => ({
    eventId: event.event_id, type: event.type, createdAt: event.created_at,
    payloadSha256: hash(event.payload_json || '')
  }))));
  const eventsByTaskId = new Map();
  const incompleteTaskCorrelationEventIds = [];
  const incompleteTaskCorrelationByTaskId = new Set();
  for (const event of allJobEvents) {
    const correlation = correlatedTaskIds(event);
    if (correlation.truncated) {
      incompleteTaskCorrelationEventIds.push(event.event_id);
      for (const taskId of correlation.taskIds) incompleteTaskCorrelationByTaskId.add(taskId);
    }
    for (const taskId of correlation.taskIds) {
      const list = eventsByTaskId.get(taskId) || [];
      list.push(event);
      eventsByTaskId.set(taskId, list);
    }
  }
  for (const entry of tasks) {
    const correlated = eventsByTaskId.get(entry.task.taskId) || [];
    const taskCorrelationTruncated = incompleteTaskCorrelationByTaskId.has(entry.task.taskId);
    const eventPayloadFingerprint = hash(JSON.stringify(correlated.map(event => ({
      eventId: event.event_id, type: event.type, createdAt: event.created_at,
      payloadSha256: hash(event.payload_json || '')
    }))));
    entry.lineageAssessment.eventPayloadFingerprint = eventPayloadFingerprint;
    entry.lineageAssessment.rowFingerprint = hash(JSON.stringify({
      taskAndProducerRowsSha256: entry.lineageAssessment.rowFingerprint,
      correlatedEventPayloadsSha256: eventPayloadFingerprint
    }));
    const references = correlated.reduce((all, event) => {
      const parsed = parseJson(event.payload_json || '{}');
      return collectLineageReferences(parsed, all);
    }, { attemptIds: new Set(), resultIds: new Set(), artifactIds: new Set(), truncated: false, nodesVisited: 0 });
    const durableAttemptIds = new Set(selectAvailable(db, 'attempts', ['attempt_id'], 'WHERE task_id=?', [entry.task.taskId]).map(row => row.attempt_id));
    const durableResultIds = new Set(selectAvailable(db, 'results', ['result_id'], 'WHERE task_id=?', [entry.task.taskId]).map(row => row.result_id));
    const durableArtifactIds = new Set(selectAvailable(db, 'artifacts', ['artifact_id'], 'WHERE task_id=?', [entry.task.taskId]).map(row => row.artifact_id));
    const unresolvedAttemptIds = [...references.attemptIds].filter(id => !durableAttemptIds.has(id));
    const unresolvedResultIds = [...references.resultIds].filter(id => !durableResultIds.has(id));
    const unresolvedArtifactIds = [...references.artifactIds].filter(id => !durableArtifactIds.has(id));
    if (unresolvedAttemptIds.length) entry.flags.push('EVENT_ATTEMPT_REFERENCE_UNRESOLVED');
    if (unresolvedResultIds.length) entry.flags.push('EVENT_RESULT_REFERENCE_UNRESOLVED');
    if (unresolvedArtifactIds.length) entry.flags.push('EVENT_ARTIFACT_REFERENCE_UNRESOLVED');
    if (references.truncated) entry.flags.push('EVENT_LINEAGE_REFERENCE_SCAN_TRUNCATED');
    if (taskCorrelationTruncated) entry.flags.push('EVENT_TASK_CORRELATION_SCAN_TRUNCATED');
    entry.flags = [...new Set(entry.flags)];
    const unresolvedReferenceCount = unresolvedAttemptIds.length + unresolvedResultIds.length + unresolvedArtifactIds.length;
    const totalReferencedCount = references.attemptIds.size + references.resultIds.size + references.artifactIds.size;
    entry.lifecycleEvidence.eventReferences = {
      status: unresolvedReferenceCount ? 'CONFLICTING' : references.truncated || taskCorrelationTruncated ? 'INCOMPLETE_SCAN'
        : totalReferencedCount ? 'ALL_REFERENCES_RESOLVED' : 'NO_REFERENCES_OBSERVED',
      completeness: references.truncated || taskCorrelationTruncated ? 'SCAN_TRUNCATED_RECONCILIATION_INCOMPLETE'
        : totalReferencedCount ? 'OBSERVED_REFERENCES_ONLY_NOT_PROOF_OF_COMPLETE_LINEAGE' : 'ABSENCE_OF_REFERENCES_DOES_NOT_PROVE_COMPLETE_LINEAGE',
      referencedAttemptIds: [...references.attemptIds].sort(), unresolvedAttemptIds: unresolvedAttemptIds.sort(),
      referencedResultIds: [...references.resultIds].sort(), unresolvedResultIds: unresolvedResultIds.sort(),
      referencedArtifactIds: [...references.artifactIds].sort(), unresolvedArtifactIds: unresolvedArtifactIds.sort(),
      scan: { truncated: references.truncated, nodesVisited: references.nodesVisited,
        taskCorrelationTruncated,
        unattributedTruncatedEventIds: incompleteTaskCorrelationEventIds.filter(eventId =>
          !correlated.some(event => event.event_id === eventId)) }
    };
    if (entry.flags.length) entry.lifecycleEvidence.disposition = 'HOLD_CONFLICTING_EVIDENCE';
    entry.eventLineage = {
      taskId: entry.task.taskId,
      eventIds: correlated.map(event => event.event_id),
      eventTypes: correlated.map(event => event.type),
      eventCount: correlated.length,
      firstEventAt: correlated[0]?.created_at || null,
      latestEventAt: correlated.at(-1)?.created_at || null,
      truncated: references.truncated || taskCorrelationTruncated,
      correlation: taskCorrelationTruncated ? 'bounded_recursive_scan_incomplete' : 'recursive_payload_task_id_match',
      unattributedTruncatedEventIds: incompleteTaskCorrelationEventIds.filter(eventId =>
        !correlated.some(event => event.event_id === eventId))
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
  if (incompleteTaskCorrelationEventIds.some(eventId => ![...eventsByTaskId.values()].some(events => events.some(event => event.event_id === eventId)))) {
    flags.push('EVENT_TASK_CORRELATION_SCAN_TRUNCATED');
  }
  const activeTaskCompletionAfterUpdate = currentTaskEntry && completionEvents.some(event => {
    return correlatedTaskIds(event).taskIds.includes(job.active_task_id) && timestampMs(event.created_at) != null &&
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
    allJobEventsPayloadFingerprint,
    latestEvents: events.reverse().map(event => ({ type: event.type, createdAt: event.created_at, eventId: event.event_id,
      payloadSummary: summarizePayload(parseJson(event.payload_json || '{}')) })),
    completionEventEvidence: { scannedCount: completionEvents.length, truncated: false,
      matchingActiveTaskEventIds: completionEvents.filter(event => correlatedTaskIds(event).taskIds.includes(job.active_task_id)).map(event => event.event_id) },
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
      taskRowFingerprints: item.tasks.map(entry => ({ taskId: entry.task.taskId, sha256: entry.lineageAssessment.rowFingerprint })),
      taskEventIds: item.tasks.map(entry => ({ taskId: entry.task.taskId, eventIds: entry.eventLineage.eventIds })),
      attemptIds: item.tasks.flatMap(entry => entry.lineageAssessment.attemptIds),
      resultIds: item.tasks.flatMap(entry => entry.lineageAssessment.resultIds),
      artifactIds: item.tasks.flatMap(entry => entry.lineageAssessment.artifactIds),
      leaseIds: item.tasks.flatMap(entry => entry.lineageAssessment.leaseIds),
      allJobEventsPayloadFingerprint: item.allJobEventsPayloadFingerprint,
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
  const taskEntries = diagnostics.flatMap(item => item.tasks);
  const runningTaskEntries = taskEntries.filter(entry => String(entry.task.status || '').toLowerCase() === 'running');
  const observedActivityAges = diagnostics.map(item => item.activityAgeMs)
    .filter(value => Number.isSafeInteger(value) && value >= 0);
  // These are diagnostic/operability measures only. They deliberately do not
  // infer provider truth, worker death, terminal disposition, or authorization
  // from the local SQLite snapshot. In particular, absent lease rows are a
  // reconciliation signal, not permission to retry or terminalize a task.
  const operabilityMetrics = {
    status: 'DIAGNOSTIC_ONLY_NOT_RELEASE_EVIDENCE',
    jobsWithUnverifiedOwnerIdentity: diagnostics.filter(item =>
      item.ownerBinding?.authority === 'unresolved_owner_identity_not_persisted').length,
    jobsWithProviderIdentityNotPersisted: diagnostics.filter(item =>
      item.runtimeObservation?.providerIdentity === 'not_persisted_in_workflow_runtime_state_schema' ||
      item.runtimeObservation?.status === 'missing').length,
    oldestObservedActivityAgeMs: observedActivityAges.length ? Math.max(...observedActivityAges) : null,
    tasksObserved: taskEntries.length,
    runningTasksObserved: runningTaskEntries.length,
    runningTasksWithoutActiveLeaseRows: runningTaskEntries.filter(entry =>
      entry.lifecycleEvidence?.lease?.status === 'MISSING_NOT_PROOF_OF_WORKER_DEATH').length,
    runningTasksMissingExecutionMetadata: runningTaskEntries.filter(entry =>
      entry.flags.includes('RUNNING_TASK_WITHOUT_EXECUTION_METADATA')).length,
    tasksWithReconciliationFlags: taskEntries.filter(entry => entry.flags.length > 0).length,
    tasksWithConflictingEventReferences: taskEntries.filter(entry =>
      entry.lifecycleEvidence?.eventReferences?.status === 'CONFLICTING').length,
    tasksWithUnverifiedOwnerOrProvider: taskEntries.filter(entry =>
      entry.lifecycleEvidence?.owner?.status !== 'VERIFIED' || entry.lifecycleEvidence?.provider?.status !== 'VERIFIED').length,
    terminalDispositionProof: {
      status: 'NOT_ASSESSED_BY_LOCAL_SQLITE_DIAGNOSTIC',
      verifiedTerminalDispositions: 0,
      note: 'A local diagnostic snapshot does not ingest authenticated host/provider terminal evidence and cannot establish that external effects have stopped.'
    },
    automaticLifecycleActionsAuthorized: false
  };
  const tableSummary = Object.fromEntries(['jobs', 'events', 'tasks', 'results', 'artifacts', 'attempts', 'task_leases', 'approvals']
    .map(table => [table, tableExists(db, table) ? db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count : null]));
  return {
    schemaVersion: 2, generatedAt: new Date(nowMs).toISOString(), readOnly: true,
    liveMutationPerformed: false, workflowDatabaseMutationPerformed: false, externalSecurityStoreMutationPerformed: false,
    purpose: 'owner-guided reconciliation; diagnostic report only; no lifecycle changes, lease changes, retries, approvals, or dispatch',
    scope: jobId ? 'single_job' : 'active_jobs', jobFilter: jobId, limit, staleAfterMs,
    dbPath: null, tableCounts: tableSummary,
    summary: { consideredJobs: diagnostics.length, byClassification: countBy('classification'),
      jobsFlaggedForReconciliation: diagnostics.filter(item => item.flags.length > 0).length,
      staleCandidates: diagnostics.filter(item => item.classification === 'stale_candidate' || item.classification === 'stale_candidate_reconciliation_required').length,
      jobsWithRunningTasksButNoActiveLeases: diagnostics.filter(item => item.runningTaskCount > 0 && item.activeLeaseCount === 0).length },
    operabilityMetrics,
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
