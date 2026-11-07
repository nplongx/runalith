import crypto from 'node:crypto';
import path from 'node:path';
import {
  assertProviderDispatchIntent,
  canonicalProviderDispatchRequest
} from './provider-dispatch-identity.js';
import { parseStrictJson } from './strict-json.js';
import { canonicalJson, assertTaskDependenciesMatchPlan } from './workflow-plan-public-api.js';
import { findUnresolvedProviderOutcome } from './workflow-state-predicates.js';
import { ExecutionPersistenceStore } from './execution-persistence-store.js';

/**
 * Workflow-owned state API consumed by execution adapters.
 *
 * This is deliberately a same-process/same-database boundary for now. Lease
 * lifecycle transitions remain implemented by WorkflowStore because their
 * BEGIN IMMEDIATE/SAVEPOINT units include task state, dispatch uncertainty,
 * event lineage and durable readback. This port never exposes the DB handle or
 * a generic transaction callback to consumers.
 */
export const WORKFLOW_STATE_PORT_VERSION = 2;

function requiredId(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredJsonPayloadPath(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}(?:\.[A-Za-z][A-Za-z0-9_]{0,63})*$/.test(value)) {
    throw new TypeError('payloadField must be a bounded dotted JSON property path');
  }
  return `$.${value}`;
}

/**
 * Stable semantic facade over the WorkflowStore lease and execution ledgers.
 *
 * Methods that mutate lease lifecycle state delegate to WorkflowStore without
 * opening another transaction. Read methods return row snapshots, never the
 * underlying connection or prepared statements.
 */
export class WorkflowStatePort {
  #store;
  #executionPersistenceStore;

  constructor(store, { executionPersistenceStore = null } = {}) {
    if (!store || typeof store !== 'object' || !store.db ||
        typeof store.db.prepare !== 'function') {
      throw new TypeError('WorkflowStatePort requires a WorkflowStore with a query-capable database');
    }
    this.#store = store;
    this.#executionPersistenceStore = executionPersistenceStore || new ExecutionPersistenceStore(store.db);
    if (this.#executionPersistenceStore.version !== 1 ||
        typeof this.#executionPersistenceStore.assertSharedConnection !== 'function') {
      throw new TypeError('WorkflowStatePort requires ExecutionPersistenceStore v1');
    }
    this.#executionPersistenceStore.assertSharedConnection(store.db);
  }

  get version() { return WORKFLOW_STATE_PORT_VERSION; }
  get isDurable() { return this.#store.db.__p6Fake !== true; }

  /** Validate that a same-connection participant uses this exact SQLite unit. */
  assertSharedConnection(database) {
    if (!database || database !== this.#store.db) {
      throw new TypeError('WorkflowStatePort participants must share the WorkflowStatePort SQLite connection');
    }
    return true;
  }

  ensureM12NativeSpecialistStartIntentSchema() {
    const db = this.#store.db;
    if (!this.isDurable) return;
    db.exec(`CREATE TABLE IF NOT EXISTS m12_native_specialist_start_intents (
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      attempt INTEGER NOT NULL,
      job_id TEXT NOT NULL,
      lease_id TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL,
      environment_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      admission_idempotency_key TEXT NOT NULL UNIQUE,
      request_sha256 TEXT NOT NULL,
      start_claim_id TEXT,
      start_claimed_at TEXT,
      state TEXT NOT NULL CHECK (state IN ('STARTING','STARTED')),
      run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(task_id,attempt)
    );
    CREATE INDEX IF NOT EXISTS idx_m12_native_start_intents_lease ON m12_native_specialist_start_intents(lease_id,state);`);
    for (const column of ['start_claim_id', 'start_claimed_at']) {
      try { db.exec(`ALTER TABLE m12_native_specialist_start_intents ADD COLUMN ${column} TEXT`); }
      catch (error) {
        if (!new RegExp(`duplicate column name:\\s*${column}`, 'i').test(String(error?.message || error))) throw error;
      }
    }
  }

  getM12NativeSpecialistStartIntent(taskId, attempt) {
    const id = requiredId(taskId, 'taskId');
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError('attempt must be a positive safe integer');
    if (!this.isDurable) return null;
    return this.#store.db.prepare('SELECT * FROM m12_native_specialist_start_intents WHERE task_id=? AND attempt=?')
      .get(id, attempt) || null;
  }

  reserveM12NativeSpecialistStart({ jobId, taskId, attempt, leaseId, ownerEpoch, environmentId, nodeId,
    admissionIdempotencyKey, inputCommit, role, prompt, waitTimeoutMs = 0, createdAt = new Date().toISOString() } = {}) {
    for (const [value, label] of [[jobId, 'jobId'], [taskId, 'taskId'], [leaseId, 'leaseId'],
      [environmentId, 'environmentId'], [nodeId, 'nodeId'], [admissionIdempotencyKey, 'admissionIdempotencyKey'],
      [inputCommit, 'inputCommit'], [role, 'role'], [prompt, 'prompt']]) requiredId(value, label);
    if (!Number.isSafeInteger(attempt) || attempt < 1 || !Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1) {
      throw new TypeError('attempt and ownerEpoch must be positive safe integers');
    }
    if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 0 || waitTimeoutMs > 2_147_483_647) {
      throw new TypeError('waitTimeoutMs must be a non-negative safe integer');
    }
    if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
      throw new TypeError('createdAt must be a canonical UTC timestamp');
    }
    if (!this.isDurable) throw new Error('M12 native specialist start requires durable workflow state');
    const requestJson = JSON.stringify({ jobId, taskId, attempt, leaseId, ownerEpoch, environmentId, nodeId,
      admissionIdempotencyKey, inputCommit, role, prompt, waitTimeoutMs });
    const requestSha256 = crypto.createHash('sha256').update(requestJson).digest('hex');
    const db = this.#store.db;
    db.exec('SAVEPOINT reserve_m12_native_specialist_start');
    try {
      const ts = createdAt;
      const inserted = db.prepare(`INSERT OR IGNORE INTO m12_native_specialist_start_intents
        (task_id,attempt,job_id,lease_id,owner_epoch,environment_id,node_id,admission_idempotency_key,request_sha256,state,run_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'STARTING',NULL,?,?)`)
        .run(taskId, attempt, jobId, leaseId, ownerEpoch, environmentId, nodeId, admissionIdempotencyKey, requestSha256, ts, ts);
      const intent = this.getM12NativeSpecialistStartIntent(taskId, attempt);
      if (!intent) throw new Error('M12 start idempotency key is already bound to another task attempt');
      const same = intent.job_id === jobId && intent.task_id === taskId && intent.attempt === attempt &&
        intent.lease_id === leaseId && intent.owner_epoch === ownerEpoch && intent.environment_id === environmentId &&
        intent.node_id === nodeId && intent.admission_idempotency_key === admissionIdempotencyKey &&
        intent.request_sha256 === requestSha256;
      if (!same) throw new Error(`M12 specialist start identity changed for task attempt ${taskId}/${attempt}`);
      if (inserted.changes !== 1) {
        throw new Error(`M12_START_OUTCOME_UNKNOWN_REQUIRES_RECONCILIATION: a prior start intent exists for ${taskId}/${attempt}; refusing a second Gateway start`);
      }
      const lease = this.getTaskLease(leaseId);
      const task = this.getTask(taskId);
      const job = this.getJob(jobId);
      const expiry = typeof lease?.expires_at === 'string' ? Date.parse(lease.expires_at) : NaN;
      if (!lease || lease.state !== 'ACTIVE' || lease.job_id !== jobId || lease.task_id !== taskId ||
          lease.attempt !== attempt || lease.owner_epoch !== ownerEpoch || !Number.isFinite(expiry) ||
          new Date(expiry).toISOString() !== lease.expires_at || expiry <= Date.now() ||
          !task || task.job_id !== jobId || task.status !== 'running' || task.execution_attempt !== attempt ||
          !job || job.status !== 'active' || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(job.state || '').toUpperCase())) {
        throw new Error(`M12 native start reservation requires the exact active lease and live running parent/task: ${taskId}/${attempt}`);
      }
      db.exec('RELEASE SAVEPOINT reserve_m12_native_specialist_start');
      return { intent, requestSha256 };
    } catch (error) {
      try { db.exec('ROLLBACK TO SAVEPOINT reserve_m12_native_specialist_start'); } catch {}
      try { db.exec('RELEASE SAVEPOINT reserve_m12_native_specialist_start'); } catch {}
      throw error;
    }
  }

  claimM12NativeSpecialistStartForSend({ taskId, attempt, leaseId, ownerEpoch, requestSha256,
    claimId = crypto.randomUUID(), claimedAt = new Date().toISOString() } = {}) {
    const taskKey = requiredId(taskId, 'taskId');
    const leaseKey = requiredId(leaseId, 'leaseId');
    requiredId(claimId, 'claimId');
    if (!Number.isSafeInteger(attempt) || attempt < 1 || !Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1) {
      throw new TypeError('attempt and ownerEpoch must be positive safe integers');
    }
    if (!/^[a-f0-9]{64}$/.test(String(requestSha256 || ''))) throw new TypeError('requestSha256 must be a 64-character hexadecimal digest');
    if (typeof claimedAt !== 'string' || !Number.isFinite(Date.parse(claimedAt)) || new Date(claimedAt).toISOString() !== claimedAt) {
      throw new TypeError('claimedAt must be a canonical UTC timestamp');
    }
    const db = this.#store.db;
    if (!this.isDurable) throw new Error('M12 native specialist send claim requires durable workflow state');
    db.exec('SAVEPOINT claim_m12_native_specialist_start_send');
    try {
      // SAVEPOINT alone is deferred. Take the writer reservation before any
      // read so lease expiry/task terminalization cannot win between check/CAS.
      const reservation = db.prepare(`UPDATE m12_native_specialist_start_intents SET updated_at=updated_at
        WHERE task_id=? AND attempt=? AND state='STARTING' AND start_claim_id IS NULL AND request_sha256=?`)
        .run(taskKey, attempt, requestSha256);
      if (reservation.changes !== 1) throw new Error(`M12 native start intent changed before send claim: ${taskKey}/${attempt}`);
      const intent = this.getM12NativeSpecialistStartIntent(taskKey, attempt);
      if (!intent || intent.state !== 'STARTING' || intent.lease_id !== leaseKey ||
          intent.owner_epoch !== ownerEpoch || intent.request_sha256 !== requestSha256) {
        throw new Error(`M12 native start intent changed before send claim: ${taskKey}/${attempt}`);
      }
      if (intent.start_claim_id) {
        throw new Error(`M12_START_OUTCOME_UNKNOWN_REQUIRES_RECONCILIATION: a prior Gateway send claim exists for ${taskKey}/${attempt}`);
      }
      const lease = this.getTaskLease(leaseKey);
      const task = this.getTask(taskKey);
      const job = this.getJob(intent.job_id);
      const expiry = typeof lease?.expires_at === 'string' ? Date.parse(lease.expires_at) : NaN;
      if (!lease || lease.state !== 'ACTIVE' || lease.job_id !== intent.job_id || lease.task_id !== taskKey ||
          lease.attempt !== attempt || lease.owner_epoch !== ownerEpoch || !Number.isFinite(expiry) ||
          new Date(expiry).toISOString() !== lease.expires_at || expiry <= Date.now() ||
          !task || task.job_id !== intent.job_id || task.status !== 'running' || task.execution_attempt !== attempt ||
          !job || job.status !== 'active' || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(job.state || '').toUpperCase())) {
        throw new Error(`M12 native start send claim requires the exact active lease and live running parent/task: ${taskKey}/${attempt}`);
      }
      const updated = db.prepare(`UPDATE m12_native_specialist_start_intents
        SET start_claim_id=?,start_claimed_at=?,updated_at=?
        WHERE task_id=? AND attempt=? AND state='STARTING' AND start_claim_id IS NULL AND request_sha256=?`)
        .run(claimId, claimedAt, claimedAt, taskKey, attempt, requestSha256);
      if (updated.changes !== 1) throw new Error(`M12 native start one-way send claim compare-and-set failed: ${taskKey}/${attempt}`);
      const persisted = this.getM12NativeSpecialistStartIntent(taskKey, attempt);
      if (!persisted || persisted.state !== 'STARTING' || persisted.start_claim_id !== claimId ||
          persisted.start_claimed_at !== claimedAt || persisted.request_sha256 !== requestSha256) {
        throw new Error(`M12 native start send claim durable readback failed: ${taskKey}/${attempt}`);
      }
      db.exec('RELEASE SAVEPOINT claim_m12_native_specialist_start_send');
      return { claimId, intent: persisted };
    } catch (error) {
      try { db.exec('ROLLBACK TO SAVEPOINT claim_m12_native_specialist_start_send'); } catch {}
      try { db.exec('RELEASE SAVEPOINT claim_m12_native_specialist_start_send'); } catch {}
      throw error;
    }
  }

  /** Initialize the workflow-owned provider execution ledgers and additive migrations. */
  ensureProviderExecutionSchema() {
    return this.#executionPersistenceStore.ensureSchema();
  }

  #invoke(method, args) {
    const operation = this.#store[method];
    if (typeof operation !== 'function') throw new TypeError(`WorkflowStatePort store does not implement ${method}()`);
    return operation.apply(this.#store, args);
  }

  getTask(taskId) { return this.#invoke('getTask', [requiredId(taskId, 'taskId')]); }
  getLatestChildTaskForRole(jobId, parentTaskId, role) {
    const jobKey = requiredId(jobId, 'jobId');
    const parentKey = requiredId(parentTaskId, 'parentTaskId');
    const roleKey = requiredId(role, 'role');
    return this.#store.db.prepare(`SELECT * FROM tasks
      WHERE job_id = ? AND parent_task_id = ? AND lower(role) = lower(?)
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(jobKey, parentKey, roleKey) || null;
  }
  getJob(jobId) { return this.#invoke('getJob', [requiredId(jobId, 'jobId')]); }
  getArtifact(artifactId) { return this.#invoke('getArtifact', [requiredId(artifactId, 'artifactId')]); }
  lockTaskForAgentSession(taskId) { return this.#invoke('lockTaskForAgentSession', [requiredId(taskId, 'taskId')]); }
  getTaskLease(leaseId) { return this.#invoke('getTaskLease', [requiredId(leaseId, 'leaseId')]); }
  // Named Execution commands and queries. The same-store adapter keeps the
  // existing WorkflowStore savepoint/transaction owners; callers never receive
  // the raw DatabaseSync handle or issue SQL against these ledgers.
  getExecutionPlan(jobId) { return this.#invoke('getExecutionPlan', [requiredId(jobId, 'jobId')]); }
  getCurrentProposal(jobId) { return this.#invoke('getCurrentProposal', [requiredId(jobId, 'jobId')]); }
  getLatestApproval(jobId) { return this.#invoke('getLatestApproval', [requiredId(jobId, 'jobId')]); }
  assertApprovalCurrent(jobId) { return this.#invoke('assertApprovalCurrent', [requiredId(jobId, 'jobId')]); }
  compileExecutionPlan(jobId, options) { return this.#invoke('compileExecutionPlan', [requiredId(jobId, 'jobId'), options]); }
  hasExecutionAttemptHistory(taskId) { return this.#invoke('hasExecutionAttemptHistory', [requiredId(taskId, 'taskId')]); }
  hasExecutionBatchItemHistory(taskId) { return this.#invoke('hasExecutionBatchItemHistory', [requiredId(taskId, 'taskId')]); }
  getExecutionBatch(batchId) { return this.#invoke('getExecutionBatch', [requiredId(batchId, 'batchId')]); }
  verifyCompletedExecutionBatch(batchId) { return this.#invoke('verifyCompletedExecutionBatch', [requiredId(batchId, 'batchId')]); }
  listExecutionBatchItems(batchId) { return this.#invoke('listExecutionBatchItems', [requiredId(batchId, 'batchId')]); }
  cancelExecutionBatch(batchId, reason) { return this.#invoke('cancelExecutionBatch', [requiredId(batchId, 'batchId'), reason]); }
  prepareExecutionBatchRetry(batchId) { return this.#invoke('prepareExecutionBatchRetry', [requiredId(batchId, 'batchId')]); }
  recoverTerminalExecutionBatchItemFromTask(batchId, itemId, options) {
    return this.#invoke('recoverTerminalExecutionBatchItemFromTask', [requiredId(batchId, 'batchId'), requiredId(itemId, 'itemId'), options]);
  }
  markExecutionBatchItemRunning(batchId, itemId, options) {
    return this.#invoke('markExecutionBatchItemRunning', [requiredId(batchId, 'batchId'), requiredId(itemId, 'itemId'), options]);
  }
  finishExecutionBatchItem(batchId, itemId, outcome) {
    return this.#invoke('finishExecutionBatchItem', [requiredId(batchId, 'batchId'), requiredId(itemId, 'itemId'), outcome]);
  }
  markExecutionBatchWaiting(batchId) { return this.#invoke('markExecutionBatchWaiting', [requiredId(batchId, 'batchId')]); }
  finishExecutionBatch(batchId, outcome) { return this.#invoke('finishExecutionBatch', [requiredId(batchId, 'batchId'), outcome]); }
  recoverUnstartedExecutionBatchClaims(options) { return this.#invoke('recoverUnstartedExecutionBatchClaims', [options]); }
  prepareExecution(taskId, execution) { return this.#invoke('prepareExecution', [requiredId(taskId, 'taskId'), execution]); }
  prepareExecutionForBatchClaim(taskId, execution, claim) {
    return this.#invoke('prepareExecutionForBatchClaim', [requiredId(taskId, 'taskId'), execution, claim]);
  }
  setExecutionPid(taskId, pid, identity) {
    return this.#invoke('setExecutionPid', [requiredId(taskId, 'taskId'), pid, identity]);
  }
  finishExecution(taskId, result) { return this.#invoke('finishExecution', [requiredId(taskId, 'taskId'), result]); }
  // Recovery commands remain implemented by WorkflowStore because each one
  // owns existing task/result/event or report/delivery/terminal transactions.
  getRecoveryJobSnapshot(jobId) {
    const id = requiredId(jobId, 'jobId');
    const job = this.getJob(id);
    return job ? { job, tasks: this.listTasksForJob(id) } : null;
  }
  reconcileRunningTaskForTerminalJob(taskId, reason) {
    return this.#invoke('reconcileRunningTaskForTerminalJob', [requiredId(taskId, 'taskId'), reason]);
  }
  completeTaskByRuntime(jobId, completion) {
    return this.#invoke('completeTaskByRuntime', [requiredId(jobId, 'jobId'), completion]);
  }
  repairResultEvidence(taskId, content, options) {
    return this.#invoke('repairResultEvidence', [requiredId(taskId, 'taskId'), content, options]);
  }
  reconcileFailedTaskByRuntime(taskId, completion) {
    return this.#invoke('reconcileFailedTaskByRuntime', [requiredId(taskId, 'taskId'), completion]);
  }
  setProviderWaiting(jobId, retryAfterMs, reason) {
    return this.#invoke('setProviderWaiting', [requiredId(jobId, 'jobId'), retryAfterMs, reason]);
  }
  clearProviderWaiting(jobId) { return this.#invoke('clearProviderWaiting', [requiredId(jobId, 'jobId')]); }
  createReport(jobId, kind, content) {
    return this.#invoke('createReport', [requiredId(jobId, 'jobId'), kind, content]);
  }
  claimDelivery(jobId, reportId, channel, target) {
    return this.#invoke('claimDelivery', [requiredId(jobId, 'jobId'), reportId, channel, target]);
  }
  terminalizeJob(jobId, outcome) {
    return this.#invoke('terminalizeJob', [requiredId(jobId, 'jobId'), outcome]);
  }
  getM12NativeSpecialistRuntime(taskId, attempt = null) {
    return this.#invoke('getM12NativeSpecialistRuntime', [requiredId(taskId, 'taskId'), attempt]);
  }
  attachM12NativeSpecialistRuntime(taskId, options) {
    return this.#invoke('attachM12NativeSpecialistRuntime', [requiredId(taskId, 'taskId'), options]);
  }
  reconcileM12NativeSpecialistResult(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('M12 native result input must be an object');
    return this.#invoke('reconcileM12NativeSpecialistResult', [input]);
  }

  getEvent(eventId) {
    const id = requiredId(eventId, 'eventId');
    return this.#store.db.prepare('SELECT event_id,job_id,type,payload_json,created_at FROM events WHERE event_id=?').get(id) || null;
  }

  recordEvent(jobId, type, payload = {}, dedupeKey = '') {
    const id = requiredId(jobId, 'jobId');
    requiredId(type, 'event type');
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError('event payload must be an object');
    }
    if (typeof dedupeKey !== 'string') throw new TypeError('event dedupe key must be a string');
    return this.#invoke('recordEvent', [id, type, payload, dedupeKey]);
  }

  clockNow() {
    const value = typeof this.#store.clock === 'function' ? this.#store.clock() : Date.now();
    if (!(typeof value === 'number' || value instanceof Date) || !Number.isFinite(Number(value))) {
      throw new Error('WorkflowStatePort clock returned an invalid timestamp');
    }
    return value;
  }

  listTasksForJob(jobId) {
    const id = requiredId(jobId, 'jobId');
    return this.#store.db.prepare('SELECT * FROM tasks WHERE job_id=? ORDER BY created_at ASC, rowid ASC').all(id);
  }

  listEventsForJob(jobId, { type = null, types = null, limit = 10_000 } = {}) {
    const id = requiredId(jobId, 'jobId');
    if ((type !== null && (typeof type !== 'string' || !type.trim())) ||
        (types !== null && (!Array.isArray(types) || !types.length || types.some(value => typeof value !== 'string' || !value.trim()))) ||
        (type !== null && types !== null)) {
      throw new TypeError('event query requires either one type or a non-empty types array');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50_000) throw new TypeError('event limit must be between 1 and 50000');
    if (types) {
      const placeholders = types.map(() => '?').join(',');
      return this.#store.db.prepare(`SELECT event_id,job_id,type,payload_json,created_at FROM events
        WHERE job_id=? AND type IN (${placeholders}) ORDER BY created_at ASC,rowid ASC LIMIT ?`)
        .all(id, ...types, limit);
    }
    return this.#store.db.prepare(`SELECT event_id,job_id,type,payload_json,created_at FROM events
      WHERE job_id=?${type ? ' AND type=?' : ''} ORDER BY created_at ASC,rowid ASC LIMIT ?`)
      .all(...(type ? [id, type, limit] : [id, limit]));
  }

  listEventsForJobPayload(jobId, type, payloadField, payloadValue, { limit = 10_000 } = {}) {
    const id = requiredId(jobId, 'jobId');
    requiredId(type, 'event type');
    const jsonPath = requiredJsonPayloadPath(payloadField);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50_000) throw new TypeError('event limit must be between 1 and 50000');
    return this.#store.db.prepare(`SELECT event_id,job_id,type,payload_json,created_at FROM events
      WHERE job_id=? AND type=? AND json_valid(payload_json) AND json_extract(payload_json,?)=?
      ORDER BY created_at ASC,rowid ASC LIMIT ?`).all(id, type, jsonPath, payloadValue, limit);
  }

  listEventsForJobTypesPayload(jobId, types, payloadField, payloadValue, { limit = 10_000 } = {}) {
    const id = requiredId(jobId, 'jobId');
    if (!Array.isArray(types) || !types.length || types.some(value => typeof value !== 'string' || !value.trim())) {
      throw new TypeError('types must be a non-empty array of event types');
    }
    const jsonPath = requiredJsonPayloadPath(payloadField);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50_000) throw new TypeError('event limit must be between 1 and 50000');
    const placeholders = types.map(() => '?').join(',');
    return this.#store.db.prepare(`SELECT event_id,job_id,type,payload_json,created_at FROM events
      WHERE job_id=? AND type IN (${placeholders}) AND json_valid(payload_json) AND json_extract(payload_json,?)=?
      ORDER BY created_at ASC,rowid ASC LIMIT ?`).all(id, ...types, jsonPath, payloadValue, limit);
  }

  findEventsByTypePayload(type, payloadField, payloadValue, { limit = 100, newestFirst = false } = {}) {
    requiredId(type, 'event type');
    const jsonPath = requiredJsonPayloadPath(payloadField);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new TypeError('event limit must be between 1 and 10000');
    return this.#store.db.prepare(`SELECT event_id,job_id,type,payload_json,created_at FROM events
      WHERE type=? AND json_valid(payload_json) AND json_extract(payload_json,?)=?
      ORDER BY created_at ${newestFirst ? 'DESC' : 'ASC'},rowid ${newestFirst ? 'DESC' : 'ASC'} LIMIT ?`)
      .all(type, jsonPath, payloadValue, limit);
  }

  countEventsForJobType(jobId, type) {
    const id = requiredId(jobId, 'jobId');
    requiredId(type, 'event type');
    const row = this.#store.db.prepare('SELECT COUNT(*) AS count FROM events WHERE job_id=? AND type=?').get(id, type);
    return Number(row?.count || 0);
  }

  getExecutionBatchLineageEvidence(jobId, batchId) {
    const job = requiredId(jobId, 'jobId');
    const batch = requiredId(batchId, 'batchId');
    return {
      creationEvents: this.listEventsForJobPayload(job, 'execution.batch.created', 'batchId', batch),
      retryEvents: this.listEventsForJobPayload(job, 'execution.batch.retry_started', 'batchId', batch),
      terminalEvents: this.listEventsForJobTypesPayload(job, ['execution.batch.completed', 'execution.batch.failed'], 'batchId', batch),
      workspaceFingerprintEvents: this.listEventsForJobPayload(job, 'execution.batch.workspace_fingerprint', 'batchId', batch),
      items: this.#store.db.prepare('SELECT task_id,status,exit_code FROM execution_batch_items WHERE batch_id=? ORDER BY rowid ASC')
        .all(batch)
    };
  }

  getMandatoryBatchItemForTask(jobId, taskId) {
    const job = requiredId(jobId, 'jobId');
    const task = requiredId(taskId, 'taskId');
    return this.#store.db.prepare(`SELECT i.batch_id,i.task_id,i.command,i.cwd,i.timeout_ms,i.status AS item_status,
        i.execution_session_id,i.execution_pid,i.exit_code,i.attempt AS item_attempt,
        b.job_id AS batch_job_id,b.parent_task_id AS batch_parent_task_id,b.status AS batch_status,b.attempt AS batch_attempt
      FROM execution_batch_items i JOIN execution_batches b ON b.batch_id=i.batch_id
      WHERE i.task_id=? AND b.job_id=?`).all(task, job);
  }

  hasTaskAttemptHistory(taskId) {
    const task = requiredId(taskId, 'taskId');
    return Boolean(this.#store.db.prepare('SELECT 1 FROM attempts WHERE task_id=? LIMIT 1').get(task));
  }

  hasTaskBatchItemHistory(taskId) {
    const task = requiredId(taskId, 'taskId');
    return Boolean(this.#store.db.prepare('SELECT 1 FROM execution_batch_items WHERE task_id=? LIMIT 1').get(task));
  }

  getResult(resultId) {
    const id = requiredId(resultId, 'resultId');
    return this.#store.db.prepare('SELECT result_id,task_id,outcome,content,created_at FROM results WHERE result_id=?').get(id) || null;
  }

  hasSuccessfulTaskResult(resultId, taskId) {
    const result = requiredId(resultId, 'resultId');
    const task = requiredId(taskId, 'taskId');
    return Boolean(this.#store.db.prepare("SELECT 1 FROM results WHERE result_id=? AND task_id=? AND outcome='success'").get(result, task));
  }

  listSuccessfulResultsForTask(taskId) {
    const task = requiredId(taskId, 'taskId');
    return this.#store.db.prepare("SELECT result_id,task_id,outcome,content,created_at FROM results WHERE task_id=? AND outcome='success' ORDER BY created_at ASC,rowid ASC")
      .all(task);
  }

  listResultsForTask(taskId) {
    const task = requiredId(taskId, 'taskId');
    return this.#store.db.prepare('SELECT result_id,task_id,outcome,content,created_at FROM results WHERE task_id=? ORDER BY created_at ASC,rowid ASC')
      .all(task);
  }

  listActiveLocalAttemptsForTask(taskId) {
    const task = requiredId(taskId, 'taskId');
    return this.#store.db.prepare("SELECT attempt_id,task_id,status,openclaw_run_id,started_at,finished_at,error FROM attempts WHERE task_id=? AND status='started' ORDER BY started_at ASC,rowid ASC")
      .all(task);
  }

  countTaskAttempts(taskId) {
    const task = requiredId(taskId, 'taskId');
    return Number(this.#store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(task)?.n || 0);
  }

  countTaskBatchItems(taskId) {
    const task = requiredId(taskId, 'taskId');
    return Number(this.#store.db.prepare('SELECT COUNT(*) AS n FROM execution_batch_items WHERE task_id=?').get(task)?.n || 0);
  }

  getAttempt(attemptId, taskId = null) {
    const attempt = requiredId(attemptId, 'attemptId');
    if (taskId !== null) requiredId(taskId, 'taskId');
    return this.#store.db.prepare(`SELECT attempt_id,task_id,status,openclaw_run_id,started_at,finished_at,error
      FROM attempts WHERE attempt_id=?${taskId === null ? '' : ' AND task_id=?'}`)
      .get(...(taskId === null ? [attempt] : [attempt, taskId])) || null;
  }

  listApprovalsForJob(jobId) {
    const job = requiredId(jobId, 'jobId');
    return this.#store.db.prepare('SELECT approval_id,decision,proposal_hash FROM approvals WHERE job_id=? ORDER BY created_at ASC,rowid ASC')
      .all(job);
  }

  countTasksForJob(jobId) {
    const job = requiredId(jobId, 'jobId');
    return Number(this.#store.db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE job_id=?').get(job)?.count || 0);
  }

  hasWorkflowPlan(jobId) {
    const job = requiredId(jobId, 'jobId');
    return Boolean(this.#store.db.prepare('SELECT 1 AS present FROM workflow_plans WHERE job_id=?').get(job));
  }

  getReport(reportId) {
    const id = requiredId(reportId, 'reportId');
    return this.#store.db.prepare('SELECT report_id,job_id,kind,content FROM reports WHERE report_id=?').get(id) || null;
  }

  listReportsForJob(jobId, { kind = null } = {}) {
    const job = requiredId(jobId, 'jobId');
    if (kind !== null) requiredId(kind, 'report kind');
    return this.#store.db.prepare(`SELECT report_id,job_id,kind,content FROM reports WHERE job_id=?${kind ? ' AND kind=?' : ''}`)
      .all(...(kind ? [job, kind] : [job]));
  }

  getArtifactStorageRecord(artifactId) {
    const id = requiredId(artifactId, 'artifactId');
    return this.#store.db.prepare('SELECT artifact_id,job_id,task_id,uri,metadata_json,content,content_hash FROM artifacts WHERE artifact_id=?').get(id) || null;
  }

  getArtifactIdentity(artifactId) {
    const id = requiredId(artifactId, 'artifactId');
    return this.#store.db.prepare('SELECT artifact_id,job_id FROM artifacts WHERE artifact_id=?').get(id) || null;
  }

  listArtifactContents() {
    return this.#store.db.prepare('SELECT content FROM artifacts ORDER BY created_at ASC,rowid ASC').all();
  }

  listArtifactCreatedEvents(jobId, artifactId = null) {
    const job = requiredId(jobId, 'jobId');
    if (artifactId !== null) requiredId(artifactId, 'artifactId');
    return artifactId === null
      ? this.listEventsForJob(job, { type: 'artifact.created' })
      : this.listEventsForJobPayload(job, 'artifact.created', 'artifactId', artifactId);
  }

  listTaskCompletionEvents(jobId) {
    return this.listEventsForJob(jobId, { types: ['task.completed', 'task.local_completed'] });
  }

  listActiveAgentSessionsForJob(jobId) {
    const job = requiredId(jobId, 'jobId');
    return this.#invoke('listActiveAgentSessionsForJob', [job]);
  }

  listActiveExecutionBatchesForJob(jobId) {
    const job = requiredId(jobId, 'jobId');
    return this.#store.db.prepare("SELECT batch_id FROM execution_batches WHERE job_id=? AND status IN ('RUNNING','WAITING')")
      .all(job);
  }

  cancelPendingTasksForJob(jobId, updatedAt = new Date().toISOString()) {
    const job = requiredId(jobId, 'jobId');
    const result = this.#store.db.prepare("UPDATE tasks SET status='cancelled',updated_at=? WHERE job_id=? AND status='pending'")
      .run(updatedAt, job);
    return Number(result?.changes || 0);
  }

  failOpenTask(taskId, updatedAt = new Date().toISOString()) {
    const task = requiredId(taskId, 'taskId');
    const result = this.#store.db.prepare("UPDATE tasks SET status='failed',updated_at=? WHERE task_id=? AND status IN ('pending','running')")
      .run(updatedAt, task);
    return Number(result?.changes || 0);
  }

  listResultsForJob(jobId) {
    const id = requiredId(jobId, 'jobId');
    return this.#store.db.prepare(`SELECT r.* FROM results r JOIN tasks t ON t.task_id=r.task_id
      WHERE t.job_id=? ORDER BY r.created_at DESC, r.rowid DESC`).all(id);
  }

  listTasksWithOpenClawSession({ status = null } = {}) {
    if (status !== null && (typeof status !== 'string' || !status.trim())) {
      throw new TypeError('task status must be a non-empty string or null');
    }
    return this.#store.db.prepare(`SELECT * FROM tasks WHERE openclaw_session_key IS NOT NULL${status ? ' AND status=?' : ''}`)
      .all(...(status ? [status] : []));
  }

  listJobsByState(state) {
    const value = requiredId(state, 'state');
    return this.#store.db.prepare('SELECT * FROM jobs WHERE state=? ORDER BY updated_at ASC, rowid ASC').all(value);
  }

  listTasksForTerminalJobs() {
    return this.#store.db.prepare(`SELECT t.task_id,t.job_id,t.openclaw_session_key
      FROM tasks t JOIN jobs j ON j.job_id=t.job_id
      WHERE t.status='running' AND j.status IN ('completed','failed','cancelled')`).all();
  }

  listRunningExecutionTasks({ jobId = null } = {}) {
    if (jobId !== null) requiredId(jobId, 'jobId');
    return this.#store.db.prepare(`SELECT * FROM tasks WHERE execution_status='running'${jobId ? ' AND job_id=?' : ''}`)
      .all(...(jobId ? [jobId] : []));
  }

  listActiveTaskLeasesForTask(taskId) {
    const id = requiredId(taskId, 'taskId');
    return this.#store.db.prepare("SELECT * FROM task_leases WHERE task_id=? AND state='ACTIVE'")
      .all(id);
  }

  listExecutionStartedEventsForJob(jobId, { limit = 1000 } = {}) {
    const id = requiredId(jobId, 'jobId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new TypeError('event limit must be between 1 and 10000');
    return this.#store.db.prepare(`SELECT event_id,job_id,type,payload_json FROM events
      WHERE job_id=? AND type='execution.started' ORDER BY created_at DESC,rowid DESC LIMIT ?`).all(id, limit);
  }

  listExecutionStartedEventsForAttempt(jobId, taskId, attempt) {
    const job = requiredId(jobId, 'jobId');
    const task = requiredId(taskId, 'taskId');
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError('attempt must be a positive safe integer');
    return this.#store.db.prepare(`SELECT event_id,job_id,type,payload_json FROM events
      WHERE job_id=? AND type='execution.started' AND json_extract(payload_json,'$.taskId')=?
        AND json_extract(payload_json,'$.attempt')=? ORDER BY created_at ASC,rowid ASC`).all(job, task, attempt);
  }

  listM12NativeSpecialistRuntimesForLease(leaseId) {
    const id = requiredId(leaseId, 'leaseId');
    return this.#store.db.prepare(`SELECT task_id,attempt,lease_id,owner_epoch,run_id
      FROM m12_native_specialist_runtime WHERE lease_id=? ORDER BY attempt ASC,rowid ASC`).all(id);
  }

  listDeterministicTasksInExecutingJobs({ status }) {
    if (!['failed', 'completed'].includes(status)) throw new TypeError('deterministic task status must be failed or completed');
    return this.#store.db.prepare(`SELECT t.* FROM tasks t JOIN jobs j ON j.job_id=t.job_id
      WHERE t.status=? AND t.role IN ('architect','qa') AND j.state='EXECUTING'`).all(status);
  }

  getLatestTaskResult(taskId) {
    const id = requiredId(taskId, 'taskId');
    return this.#store.db.prepare('SELECT outcome,content FROM results WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id) || null;
  }

  updateTaskMetadata(taskId, metadata, updatedAt = new Date().toISOString()) {
    const id = requiredId(taskId, 'taskId');
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new TypeError('task metadata must be an object');
    }
    if (typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt)) || new Date(updatedAt).toISOString() !== updatedAt) {
      throw new TypeError('updatedAt must be a canonical UTC timestamp');
    }
    const encoded = JSON.stringify(metadata);
    if (typeof encoded !== 'string') throw new TypeError('task metadata is not JSON serializable');
    const result = this.#store.db.prepare('UPDATE tasks SET metadata_json=?,updated_at=? WHERE task_id=?')
      .run(encoded, updatedAt, id);
    if (result.changes !== 1) throw new Error(`WorkflowStatePort task metadata update did not match exactly one task: ${id}`);
    const persisted = this.getTask(id);
    if (!persisted || persisted.metadata_json !== encoded || persisted.updated_at !== updatedAt) {
      throw new Error(`WorkflowStatePort task metadata failed exact durable readback: ${id}`);
    }
    return persisted;
  }

  getExecutionBatchItemForTask(taskId) {
    const id = requiredId(taskId, 'taskId');
    return this.#store.db.prepare(`SELECT b.batch_id,b.status,i.status AS item_status
      FROM execution_batch_items i JOIN execution_batches b ON b.batch_id=i.batch_id
      WHERE i.task_id=? ORDER BY b.created_at DESC,b.rowid DESC LIMIT 1`).get(id) || null;
  }

  getExecutionBatchSpawnClaim({ batchId, itemId, taskId } = {}) {
    requiredId(batchId, 'batchId');
    requiredId(itemId, 'itemId');
    requiredId(taskId, 'taskId');
    return this.#store.db.prepare(`SELECT b.batch_id,b.job_id,b.status AS batch_status,b.attempt AS batch_attempt,
        i.item_id,i.task_id,i.command,i.status AS item_status,i.attempt AS item_attempt,
        j.state AS job_state,j.status AS job_status
      FROM execution_batches b JOIN execution_batch_items i ON i.batch_id=b.batch_id
      JOIN jobs j ON j.job_id=b.job_id
      WHERE b.batch_id=? AND i.item_id=? AND i.task_id=?`).get(batchId, itemId, taskId) || null;
  }

  hasExecutionAttemptHistory(taskId) {
    const id = requiredId(taskId, 'taskId');
    return Boolean(this.#store.db.prepare('SELECT 1 FROM attempts WHERE task_id=? LIMIT 1').get(id));
  }

  hasExecutionBatchItemHistory(taskId) {
    const id = requiredId(taskId, 'taskId');
    return Boolean(this.#store.db.prepare('SELECT 1 FROM execution_batch_items WHERE task_id=? LIMIT 1').get(id));
  }

  // Spawn authorization is a single Workflow-owned command below; callers
  // cannot begin, commit or roll back its transaction independently.

  getRunningExecutionSessionIds() {
    return this.#store.db.prepare("SELECT execution_session_id FROM tasks WHERE execution_status='running' AND execution_session_id IS NOT NULL")
      .all().map(row => row.execution_session_id);
  }

  listActiveProviderRunsForJob(jobId) {
    const id = requiredId(jobId, 'jobId');
    return this.#store.db.prepare(`SELECT pr.*, l.lease_id, l.attempt AS lease_attempt,
        l.worker_id,l.state AS lease_state,l.last_error AS lease_last_error
      FROM provider_runs pr JOIN task_leases l ON l.lease_id=pr.lease_id
      WHERE pr.job_id=? AND (l.state='ACTIVE' OR
        (l.state='FAILED' AND l.last_error LIKE 'REMOTE_EFFECT_UNCERTAIN_REQUIRES_RECONCILIATION:%'))`).all(id);
  }

  listProviderRunsForJob(jobId) {
    return this.#executionPersistenceStore.listProviderRunsForJob(requiredId(jobId, 'jobId'));
  }

  hasUnresolvedDurableExecution(jobId) {
    const id = requiredId(jobId, 'jobId');
    if (this.#store.db.__p6Fake) return true;
    try {
      // An active lease is itself an execution owner even before a provider
      // intent/run row exists. Stale-job recovery must preserve the original
      // lease holder rather than treating this as an orphan.
      if (this.#store.db.prepare("SELECT 1 AS present FROM task_leases WHERE job_id=? AND state='ACTIVE' LIMIT 1").get(id)) {
        return true;
      }
      return findUnresolvedProviderOutcome(this.#store.db, id) !== null;
    }
    catch {
      // Ownership uncertainty must defer terminal recovery, never authorize it.
      return true;
    }
  }

  hasUnresolvedProviderDispatchForJob(jobId) {
    return this.#executionPersistenceStore.hasUnresolvedProviderDispatchForJob(requiredId(jobId, 'jobId'));
  }

  hasUnresolvedProviderRunForJob(jobId) {
    return this.#executionPersistenceStore.hasUnresolvedProviderRunForJob(requiredId(jobId, 'jobId'));
  }

  /**
   * Atomically terminalize a stale executing Job only when no OpenClaw or
   * durable provider execution can still own a remote side effect.
   */
  reconcileStaleJob({ jobId, staleMs, nowMs = Date.now(), liveRuntimeSessionKeys = [] } = {}) {
    const id = requiredId(jobId, 'jobId');
    if (!Number.isSafeInteger(staleMs) || staleMs < 1) throw new TypeError('staleMs must be a positive safe integer');
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('nowMs must be a non-negative safe integer');
    if (!Array.isArray(liveRuntimeSessionKeys) || liveRuntimeSessionKeys.some(key => typeof key !== 'string' || !key)) {
      throw new TypeError('liveRuntimeSessionKeys must be an array of non-empty strings');
    }
    const db = this.#store.db;
    const liveKeys = new Set(liveRuntimeSessionKeys);
    db.exec('SAVEPOINT reconcile_stale_job_transition');
    try {
      const reservation = db.prepare(`UPDATE jobs SET updated_at=updated_at
        WHERE job_id=? AND state='EXECUTING' AND status='active'`).run(id);
      if (reservation.changes !== 1) {
        db.exec('RELEASE SAVEPOINT reconcile_stale_job_transition');
        return { status: 'NOT_STALE_OR_TERMINAL' };
      }
      const currentJob = this.#invoke('getJob', [id]);
      const updatedAt = Date.parse(currentJob?.updated_at || '');
      if (!currentJob || currentJob.state !== 'EXECUTING' || currentJob.status !== 'active' ||
          !Number.isFinite(updatedAt) || nowMs - updatedAt <= staleMs) {
        db.exec('RELEASE SAVEPOINT reconcile_stale_job_transition');
        return { status: 'NOT_STALE_OR_TERMINAL' };
      }
      const tasks = this.listTasksForJob(id);
      if (tasks.some(task => task.openclaw_session_key && liveKeys.has(task.openclaw_session_key))) {
        db.exec('RELEASE SAVEPOINT reconcile_stale_job_transition');
        return { status: 'DEFERRED', reason: 'live_openclaw_runtime' };
      }
      if (this.hasUnresolvedDurableExecution(id)) {
        db.exec('RELEASE SAVEPOINT reconcile_stale_job_transition');
        return { status: 'DEFERRED', reason: 'durable_lease_or_provider_outcome_unresolved' };
      }
      const content = [
        '[RECOVERY FAILURE]',
        `Job was EXECUTING for more than ${Math.round(staleMs / 60000)} minutes, but no corresponding live OpenClaw runtime session remains.`,
        'Recovery closed the orphaned Job without spawning replacement work.'
      ].join('\n');
      const completed = this.#invoke('complete', [id, content, 'failure']);
      const payload = {
        outcome: 'failure', reason: 'stale_job_without_live_runtime',
        staleMs: nowMs - updatedAt
      };
      const dedupeKey = `${id}|stale-job-without-live-runtime`;
      const eventId = this.#invoke('recordEvent', [id, 'job.runtime_reconciled', payload, dedupeKey]);
      const event = this.getEvent(eventId);
      const persistedJob = this.#invoke('getJob', [id]);
      if (!completed || !persistedJob || persistedJob.status !== 'failed' || !event || event.job_id !== id || event.type !== 'job.runtime_reconciled' ||
          event.payload_json !== JSON.stringify(payload)) {
        throw new Error(`stale Job recovery failed durable completion/event readback: ${id}`);
      }
      db.exec('RELEASE SAVEPOINT reconcile_stale_job_transition');
      return { status: 'TERMINALIZED', job: persistedJob, eventId };
    } catch (error) {
      try { db.exec('ROLLBACK TO SAVEPOINT reconcile_stale_job_transition'); } catch {}
      try { db.exec('RELEASE SAVEPOINT reconcile_stale_job_transition'); } catch {}
      throw error;
    }
  }

  /** Settle a stale local execution, associated batch item and event atomically. */
  recoverStaleExecution({ task, reason = 'execution supervisor/session missing; recovery terminalized the orphaned attempt as failed' } = {}) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw new TypeError('durable stale task is required');
    const taskId = requiredId(task.task_id, 'task.task_id');
    const jobId = requiredId(task.job_id, 'task.job_id');
    if (!Number.isSafeInteger(task.execution_attempt) || task.execution_attempt < 1 ||
        typeof task.execution_session_id !== 'string' || !task.execution_session_id ||
        typeof task.metadata_json !== 'string') {
      throw new Error(`cannot terminalize stale execution with malformed durable task/session/attempt identity: ${taskId}`);
    }
    const metadata = parseStrictJson(task.metadata_json || '{}', 'stale execution recovery metadata');
    if (typeof metadata.command !== 'string' || !metadata.command.trim()) {
      throw new Error(`cannot terminalize stale execution without a durable command identity: ${taskId}`);
    }
    const db = this.#store.db;
    db.exec('SAVEPOINT recover_stale_execution_transition');
    try {
      const reservation = db.prepare(`UPDATE tasks SET updated_at=updated_at
        WHERE task_id=? AND job_id=? AND status='running' AND execution_attempt=?`)
        .run(taskId, jobId, task.execution_attempt);
      if (reservation.changes !== 1) throw new Error(`stale execution recovery lost task/attempt ownership: ${taskId}`);
      const currentTask = this.#invoke('getTask', [taskId]);
      if (!currentTask || currentTask.execution_session_id !== task.execution_session_id ||
          currentTask.metadata_json !== task.metadata_json) {
        throw new Error(`stale execution identity changed before recovery acquired its writer reservation: ${taskId}`);
      }
      const terminal = this.#invoke('finishExecution', [taskId, {
        executionSessionId: task.execution_session_id,
        attempt: task.execution_attempt,
        command: metadata.command,
        exitCode: null,
        stdout: '',
        stderr: reason,
        status: 'failed',
        error: reason
      }]);
      const recoveredBatchItem = this.#invoke('recoverStaleExecutionBatchItem', [taskId, {
        expectedAttempt: task.execution_attempt, reason
      }]);
      const payload = {
        taskId, executionSessionId: task.execution_session_id,
        attempt: task.execution_attempt, reason: 'tmux execution session missing',
        terminalStatus: terminal.execution_status,
        batchId: recoveredBatchItem?.batch.batch_id || null,
        batchItemId: recoveredBatchItem?.item.item_id || null
      };
      const dedupeKey = `${taskId}|execution-stale|${task.execution_attempt}`;
      const eventId = this.#invoke('recordEvent', [jobId, 'execution.stale', payload, dedupeKey]);
      const event = this.getEvent(eventId);
      if (!terminal || terminal.job_id && terminal.job_id !== jobId ||
          event?.job_id !== jobId || event.type !== 'execution.stale' || event.payload_json !== JSON.stringify(payload)) {
        throw new Error(`stale execution recovery failed durable task/batch/event readback: ${taskId}`);
      }
      db.exec('RELEASE SAVEPOINT recover_stale_execution_transition');
      return { terminal, recoveredBatchItem, eventId };
    } catch (error) {
      try { db.exec('ROLLBACK TO SAVEPOINT recover_stale_execution_transition'); } catch {}
      try { db.exec('RELEASE SAVEPOINT recover_stale_execution_transition'); } catch {}
      throw error;
    }
  }

  getActiveTaskLease(taskId) {
    const id = requiredId(taskId, 'taskId');
    if (this.#store.db.__p6Fake) return null;
    return this.#store.db.prepare("SELECT * FROM task_leases WHERE task_id=? AND state='ACTIVE' LIMIT 1")
      .get(id) || null;
  }

  countActiveTaskLeases() {
    const row = this.#store.db.prepare("SELECT COUNT(*) AS n FROM task_leases WHERE state='ACTIVE'").get();
    if (!row || !Number.isSafeInteger(Number(row.n)) || Number(row.n) < 0) {
      throw new Error('WorkflowStatePort active lease count is malformed');
    }
    return Number(row.n);
  }

  /** Return both ledgers from one lease identity; missing optional tables mean no rows. */
  getDispatchLedgerForLease(leaseId) {
    return this.#executionPersistenceStore.getDispatchLedgerForLease(requiredId(leaseId, 'leaseId'));
  }

  getProviderRun(providerRunId) {
    return this.#executionPersistenceStore.getProviderRun(requiredId(providerRunId, 'providerRunId'));
  }

  hasProviderRunLedger() {
    return this.#executionPersistenceStore.hasProviderRunLedger();
  }

  hasProviderDispatchIntentLedger() {
    return this.#executionPersistenceStore.hasProviderDispatchIntentLedger();
  }

  getProviderDispatchIntent(dispatchKey) {
    return this.#executionPersistenceStore.getProviderDispatchIntent(requiredId(dispatchKey, 'dispatchKey'));
  }

  getProviderDispatchIntentForRun(providerRunId) {
    return this.#executionPersistenceStore.getProviderDispatchIntentForRun(requiredId(providerRunId, 'providerRunId'));
  }

  listProviderDispatchIntentsForProviderRun(providerRunId) {
    return this.#executionPersistenceStore.listProviderDispatchIntentsForProviderRun(requiredId(providerRunId, 'providerRunId'));
  }

  listProviderDispatchIntentsForDispatchKey(dispatchKey) {
    return this.#executionPersistenceStore.listProviderDispatchIntentsForDispatchKey(requiredId(dispatchKey, 'dispatchKey'));
  }

  listProviderDispatchIntents({ state = null } = {}) {
    return this.#executionPersistenceStore.listProviderDispatchIntents({ state });
  }

  listSiblingProviderDispatchIntents({ leaseId, taskId, attempt, provider, excludeDispatchKey }) {
    requiredId(leaseId, 'leaseId');
    requiredId(taskId, 'taskId');
    requiredId(provider, 'provider');
    requiredId(excludeDispatchKey, 'excludeDispatchKey');
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError('attempt must be a positive safe integer');
    return this.#executionPersistenceStore.listSiblingProviderDispatchIntents({ leaseId, taskId, attempt, provider, excludeDispatchKey });
  }

  /** Reserve one immutable intent per execution attempt and verify exact readback. */
  reserveProviderDispatchIntent({ dispatchIdentity, request, createdAt = new Date().toISOString() } = {}) {
    return this.#executionPersistenceStore.reserveProviderDispatchIntent({ dispatchIdentity, request, createdAt });
  }

  recordProviderDispatchOutcome({ dispatchKey, providerRunId = null, updatedAt = new Date().toISOString(),
    expectedRequestSha256 = null, expectedClaimId = null } = {}) {
    return this.#executionPersistenceStore.recordProviderDispatchOutcome({ dispatchKey, providerRunId, updatedAt,
      expectedRequestSha256, expectedClaimId });
  }

  bindReconciledProviderRun({ dispatchKey, providerRunId, requestSha256, dispatchClaimId, updatedAt = new Date().toISOString() } = {}) {
    return this.#executionPersistenceStore.bindReconciledProviderRun({ dispatchKey, providerRunId, requestSha256,
      dispatchClaimId, updatedAt });
  }

  /** One-way compare-and-set immediately before a provider send boundary. */
  claimProviderDispatchForSend({ intent, claimId, claimedAt } = {}) {
    if (!intent || typeof intent !== 'object') throw new TypeError('durable dispatch intent is required');
    requiredId(claimId, 'claimId');
    if (typeof claimedAt !== 'string' || !Number.isFinite(Date.parse(claimedAt)) || new Date(claimedAt).toISOString() !== claimedAt) {
      throw new TypeError('claimedAt must be a canonical UTC timestamp');
    }
    const db = this.#store.db;
    if (db.__p6Fake) return { claimed: true, intent: { ...intent, dispatch_claim_id: claimId, dispatch_claimed_at: claimedAt } };
    const nativeSqlite = typeof db.isOpen === 'boolean';
    const claimSql = `UPDATE provider_dispatch_intents
      SET dispatch_claim_id=?, dispatch_claimed_at=?, updated_at=?
      WHERE dispatch_key=? AND state='DISPATCHING' AND provider_run_id IS NULL AND dispatch_claim_id IS NULL
        AND request_sha256=? AND request_json=?${nativeSqlite ? `
        AND EXISTS (SELECT 1 FROM task_leases lease WHERE lease.lease_id=? AND lease.job_id=? AND lease.task_id=?
          AND lease.attempt=? AND lease.owner_epoch=? AND lease.state='ACTIVE' AND lease.expires_at>?)
        AND EXISTS (SELECT 1 FROM jobs job WHERE job.job_id=? AND job.status='active'
          AND UPPER(COALESCE(job.state,'')) NOT IN ('COMPLETED','FAILED','CANCELLED'))
        AND EXISTS (SELECT 1 FROM tasks task WHERE task.task_id=? AND task.job_id=? AND task.status='running')
        AND NOT EXISTS (SELECT 1 FROM provider_dispatch_intents sibling WHERE sibling.lease_id=? AND sibling.task_id=?
          AND sibling.attempt=? AND sibling.provider=? AND sibling.dispatch_key<>?)` : ''}`;
    const claim = db.prepare(claimSql).run(...[
      claimId, claimedAt, claimedAt, String(intent.dispatch_key), intent.request_sha256, intent.request_json,
      ...(nativeSqlite ? [String(intent.lease_id), String(intent.job_id), String(intent.task_id),
        Number(intent.attempt), Number(intent.owner_epoch), claimedAt,
        String(intent.job_id), String(intent.task_id), String(intent.job_id),
        String(intent.lease_id), String(intent.task_id), Number(intent.attempt),
        String(intent.provider), String(intent.dispatch_key)] : [])
    ]);
    return { claimed: claim.changes === 1, intent: this.getProviderDispatchIntent(intent.dispatch_key) };
  }

  assertActiveProviderDispatchLease(intent, request, checkedAt = new Date().toISOString()) {
    const db = this.#store.db;
    // Narrow provider fakes do not implement durable lease tables. Production
    // DatabaseSync handles expose `isOpen`; only that path can authorize P3.
    if (!db || typeof db.isOpen !== 'boolean') return;
    const lease = this.getTaskLease(String(intent.lease_id));
    const job = this.getJob(String(intent.job_id));
    const task = this.getTask(String(intent.task_id));
    const jobTerminal = !job || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(job.state || '').toUpperCase()) ||
      ['completed', 'failed', 'cancelled'].includes(String(job.status || '').toLowerCase());
    const valid = lease && lease.state === 'ACTIVE' &&
      String(lease.job_id) === String(intent.job_id) && String(lease.task_id) === String(intent.task_id) &&
      Number(lease.attempt) === Number(intent.attempt) && Number(lease.owner_epoch) === Number(intent.owner_epoch) &&
      typeof lease.expires_at === 'string' && lease.expires_at > checkedAt &&
      !jobTerminal && String(job.status).toLowerCase() === 'active' &&
      task && String(task.job_id) === String(intent.job_id) && task.status === 'running' &&
      String(request?.job_id) === String(intent.job_id) && String(request?.task_id) === String(intent.task_id) &&
      String(request?.lease_id) === String(intent.lease_id) && Number(request?.attempt) === Number(intent.attempt) &&
      Number(request?.owner_epoch) === Number(intent.owner_epoch);
    if (!valid) {
      const error = new Error('P3 dispatch requires the exact active, unexpired durable lease and nonterminal live Job/task at the provider send boundary');
      error.remoteOutcome = 'not_sent';
      throw error;
    }
  }

  releaseProviderDispatchSendClaim({ dispatchKey, claimId, updatedAt = new Date().toISOString() } = {}) {
    return this.#executionPersistenceStore.releaseProviderDispatchSendClaim({ dispatchKey, claimId, updatedAt });
  }

  assertP3ProviderResultCollectionLease({ providerRunId, result, expectedOwnerEpoch, providerConfig, nowMs = Date.now() } = {}) {
    const currentRun = this.getProviderRun(String(providerRunId));
    const currentIntent = this.getProviderDispatchIntentForRun(String(providerRunId));
    const lease = this.getTaskLease(result.lease_id);
    const task = this.getTask(result.task_id);
    const parent = this.getJob(result.job_id);
    const expiry = typeof lease?.expires_at === 'string' ? Date.parse(lease.expires_at) : NaN;
    if (!currentRun || !currentIntent || currentRun.provider_run_id !== String(providerRunId) ||
        currentRun.provider !== 'github-actions' || currentRun.state !== 'COMPLETED' ||
        String(currentRun.conclusion || '').toLowerCase() !== 'success' || currentRun.job_id !== result.job_id ||
        currentRun.task_id !== result.task_id || currentRun.lease_id !== result.lease_id ||
        currentRun.attempt !== result.attempt || currentRun.owner_epoch !== expectedOwnerEpoch ||
        currentRun.run_attempt !== result.provider_run_attempt ||
        String(currentRun.input_commit || '').toLowerCase() !== String(result.input_commit || '').toLowerCase() ||
        currentIntent.state !== 'DISPATCHED' || currentIntent.provider_run_id !== String(providerRunId) ||
        currentIntent.job_id !== result.job_id || currentIntent.task_id !== result.task_id ||
        currentIntent.lease_id !== result.lease_id || currentIntent.attempt !== result.attempt ||
        currentIntent.owner_epoch !== expectedOwnerEpoch || currentIntent.dispatch_key !== currentRun.dispatch_key ||
        currentIntent.request_sha256 !== currentRun.request_sha256 ||
        !/^[a-f0-9]{64}$/.test(String(currentIntent.request_sha256 || '')) ||
        !currentIntent.request_json || crypto.createHash('sha256').update(currentIntent.request_json).digest('hex') !== currentIntent.request_sha256 ||
        !lease || lease.state !== 'ACTIVE' || lease.job_id !== result.job_id || lease.task_id !== result.task_id ||
        lease.attempt !== result.attempt || lease.owner_epoch !== expectedOwnerEpoch ||
        !Number.isFinite(expiry) || new Date(expiry).toISOString() !== lease.expires_at || expiry <= nowMs ||
        !task || task.job_id !== result.job_id || task.status !== 'running' || task.execution_attempt !== result.attempt ||
        !parent || parent.status !== 'active' || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(parent.state || '').toUpperCase())) {
      throw new Error(`P3 result collection lost its exact active task/lease/dispatch fence for provider run ${providerRunId}`);
    }
    const request = parseStrictJson(currentIntent.request_json, 'durable P3 execution request at result-collection fence');
    if (canonicalProviderDispatchRequest(request) !== currentIntent.request_json) {
      throw new Error(`P3 result collection found non-canonical immutable request bytes for provider run ${providerRunId}`);
    }
    assertProviderDispatchIntent(currentIntent, {
      job_id: result.job_id, task_id: result.task_id, lease_id: result.lease_id,
      attempt: result.attempt, owner_epoch: expectedOwnerEpoch, input_commit: result.input_commit,
      request_sha256: currentIntent.request_sha256, ...providerConfig
    });
    return { currentRun, currentIntent, lease, task, parent };
  }

  persistProviderRunResultWithLeaseFence({ providerRunId, result, expectedOwnerEpoch, run,
    providerConfig, nowMs = Date.now(), updatedAt = new Date(nowMs).toISOString() } = {}) {
    const db = this.#store.db;
    db.exec('SAVEPOINT p3_result_collection_terminal_fence');
    try {
      const reservation = db.prepare('UPDATE task_leases SET last_error=last_error WHERE lease_id=?')
        .run(String(result.lease_id));
      if (reservation.changes !== 1) throw new Error(`P3 result collection lost its durable lease before fencing: ${providerRunId}`);
      this.assertP3ProviderResultCollectionLease({ providerRunId, result, expectedOwnerEpoch, providerConfig, nowMs });
      this.persistProviderRun(run, { provider: 'github-actions', updatedAt });
      const readback = this.getProviderRun(providerRunId);
      if (!readback || readback.state !== 'COMPLETED' || readback.conclusion !== run.conclusion ||
          String(readback.artifact_id || '') !== String(run.artifact_id || '') ||
          String(readback.output_commit || '') !== String(run.output_commit || '') ||
          readback.owner_epoch !== expectedOwnerEpoch || readback.run_attempt !== result.provider_run_attempt) {
        throw new Error(`P3 result collection terminal readback failed exact artifact/trusted-output/attempt binding for ${providerRunId}`);
      }
      db.exec('RELEASE SAVEPOINT p3_result_collection_terminal_fence');
      return readback;
    } catch (error) {
      try { db.exec('ROLLBACK TO SAVEPOINT p3_result_collection_terminal_fence'); } catch {}
      try { db.exec('RELEASE SAVEPOINT p3_result_collection_terminal_fence'); } catch {}
      throw error;
    }
  }

  persistProviderRun(run, options = {}) {
    return this.#executionPersistenceStore.persistProviderRun(run, options);
  }

  bindProviderDispatchRun(intent, run, options = {}) {
    return this.#executionPersistenceStore.bindProviderDispatchRun(intent, run, options);
  }

  acquireTaskLease(taskId, options) {
    return this.#invoke('acquireTaskLease', [requiredId(taskId, 'taskId'), options]);
  }

  heartbeatTaskLease(leaseId, options) {
    return this.#invoke('heartbeatTaskLease', [requiredId(leaseId, 'leaseId'), options]);
  }

  completeTaskLease(leaseId, options) {
    return this.#invoke('completeTaskLease', [requiredId(leaseId, 'leaseId'), options]);
  }

  expireTaskLease(leaseId, options) {
    return this.#invoke('expireTaskLease', [requiredId(leaseId, 'leaseId'), options]);
  }

  reapExpiredTaskLeases(options) { return this.#invoke('reapExpiredTaskLeases', [options]); }
  listTaskLeases(options) { return this.#invoke('listTaskLeases', [options]); }
  listRunnableTasks(options) { return this.#invoke('listRunnableTasks', [options]); }
  applyVerifiedExecutionResult(result) { return this.#invoke('applyVerifiedExecutionResult', [result]); }

  clearTaskLeaseError(leaseId) {
    const id = requiredId(leaseId, 'leaseId');
    if (!this.isDurable) return { changes: 0 };
    // A provider callback may return after the reaper has quarantined an
    // uncertain remote effect. Never erase that FAILED lease's reconciliation
    // marker; LangGraph deliberately discovers quarantined runs through it.
    const result = this.#store.db.prepare("UPDATE task_leases SET last_error=NULL WHERE lease_id=? AND state='ACTIVE'").run(id);
    return { changes: Number(result?.changes || 0) };
  }

  assertImmutablePlannedExecution(task, options = {}) {
    return assertImmutablePlannedExecution(this, task, options);
  }

  /** Recheck all mutable spawn gates and persist authorization in one writer transaction. */
  authorizeExecutionSpawn({ taskId, boundaryIdentity, attempt, command, cwd, timeoutMs,
    explicitEnv = {}, executable = null, args = null } = {}) {
    const id = requiredId(taskId, 'taskId');
    if (!boundaryIdentity || typeof boundaryIdentity !== 'object' || Array.isArray(boundaryIdentity)) {
      throw new TypeError('spawn authorization boundaryIdentity must be an object');
    }
    const jobId = requiredId(boundaryIdentity.job_id, 'boundaryIdentity.job_id');
    requiredId(command, 'command');
    if (typeof cwd !== 'string' || !cwd.trim()) throw new TypeError('spawn authorization cwd must be a non-empty string');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('spawn authorization timeoutMs must be a positive safe integer');
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError('spawn authorization attempt must be a positive safe integer');
    if (!explicitEnv || typeof explicitEnv !== 'object' || Array.isArray(explicitEnv)) {
      throw new TypeError('spawn authorization explicitEnv must be an object');
    }
    const db = this.#store.db;
    let transactionOpen = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      transactionOpen = true;
      const task = this.getTask(id);
      if (!task) throw new Error(`execution task not found before spawn authorization: ${id}`);
      this.assertImmutablePlannedExecution(task, {
        ...(executable !== null ? { executable } : {}), ...(args !== null ? { args } : {}),
        command, cwd, timeoutMs, env: explicitEnv
      });
      const metadata = parseStrictJson(task.metadata_json || '{}', 'durable task metadata before OS spawn');
      if (task.job_id !== jobId || task.status !== 'running' || task.execution_status !== 'running' ||
          task.execution_attempt !== attempt || metadata.command !== command ||
          canonicalJson(metadata.execution_boundary_identity) !== canonicalJson(boundaryIdentity)) {
        throw new Error(`execution task/session/attempt/boundary changed before spawn authorization: ${id}`);
      }
      if (metadata.execution_batch_claim) {
        const claim = metadata.execution_batch_claim;
        const durableClaim = this.getExecutionBatchSpawnClaim({ batchId: claim.batchId, itemId: claim.itemId, taskId: id });
        if (!durableClaim || durableClaim.job_id !== task.job_id || !['WAITING', 'RUNNING'].includes(durableClaim.batch_status) ||
            durableClaim.batch_attempt !== attempt || durableClaim.item_attempt !== attempt || durableClaim.item_status !== 'RUNNING' ||
            durableClaim.command !== command || durableClaim.job_status !== 'active' || durableClaim.job_state !== 'EXECUTING' ||
            claim.batchAttempt !== attempt || claim.itemAttempt !== attempt) {
          throw new Error(`execution batch/job claim lost before OS spawn authorization: ${id}`);
        }
      }
      const approval = this.getLatestApproval(jobId);
      const proposal = this.getCurrentProposal(jobId);
      const approvalIdentity = approval ? {
        approval_id: approval.approval_id, decision: approval.decision,
        proposal_hash: approval.proposal_hash || null, current_proposal_hash: proposal?.proposalHash || null
      } : null;
      if (canonicalJson(approvalIdentity) !== canonicalJson(boundaryIdentity.approval)) {
        throw new Error(`execution approval/proposal identity changed before spawn authorization: ${id}`);
      }
      const activeLeases = this.listActiveTaskLeasesForTask(id);
      const lease = boundaryIdentity.lease?.lease_id
        ? activeLeases.find(candidate => candidate.lease_id === boundaryIdentity.lease.lease_id)
        : null;
      if (boundaryIdentity.lease?.lease_id) {
        const expiry = Date.parse(lease?.expires_at || '');
        if (!lease || activeLeases.length !== 1 || lease.job_id !== jobId || lease.task_id !== id ||
            lease.worker_id !== boundaryIdentity.lease.worker_id || !Number.isSafeInteger(lease.owner_epoch) ||
            lease.owner_epoch !== boundaryIdentity.lease.owner_epoch || lease.attempt !== attempt ||
            !Number.isFinite(expiry) || expiry <= Date.now()) {
          throw new Error(`execution lease owner/epoch/attempt expired or changed before spawn authorization: ${id}`);
        }
      } else if (activeLeases.some(candidate => Date.parse(candidate.expires_at || '') > Date.now())) {
        throw new Error(`execution acquired an unbound active task lease before local spawn authorization: ${id}`);
      }
      const startedEvents = this.listExecutionStartedEventsForAttempt(jobId, id, attempt);
      if (startedEvents.length !== 1) throw new Error(`exact durable execution.started event missing before spawn authorization: ${id}`);
      const startedPayload = parseStrictJson(startedEvents[0].payload_json, 'durable execution.started payload');
      if (startedEvents[0].job_id !== jobId || startedPayload.executionSessionId !== task.execution_session_id ||
          canonicalJson(startedPayload.executionBoundaryIdentity) !== canonicalJson(boundaryIdentity)) {
        throw new Error(`durable execution.started event does not bind the current spawn authorization: ${id}`);
      }
      const spawnAuthorization = {
        taskId: id, executionSessionId: task.execution_session_id, attempt, command,
        approvalId: boundaryIdentity.approval?.approval_id || null,
        proposalHash: boundaryIdentity.approval?.proposal_hash || null,
        environmentSha256: boundaryIdentity.environment_sha256,
        executableSha256: boundaryIdentity.executable?.sha256,
        tmuxSha256: boundaryIdentity.tmux?.sha256,
        leaseId: lease?.lease_id || null,
        ownerEpoch: lease ? lease.owner_epoch : null,
        authorizedAt: new Date().toISOString()
      };
      const dedupeKey = `${id}|execution-spawn|${attempt}`;
      const authorizedEventId = this.recordEvent(jobId, 'execution.spawn_authorized', spawnAuthorization, dedupeKey);
      const authorizedEvent = this.getEvent(authorizedEventId);
      if (!authorizedEvent || authorizedEvent.job_id !== jobId || authorizedEvent.type !== 'execution.spawn_authorized' ||
          authorizedEvent.payload_json !== JSON.stringify(spawnAuthorization)) {
        throw new Error(`durable execution spawn-authorization event readback mismatch: ${id}`);
      }
      db.exec('COMMIT');
      transactionOpen = false;
      return { eventId: authorizedEventId, payload: spawnAuthorization };
    } catch (error) {
      if (transactionOpen) {
        try { db.exec('ROLLBACK'); } catch (rollbackError) {
          error.rollbackError = String(rollbackError?.message || rollbackError);
        }
      }
      throw error;
    }
  }
}

export function createWorkflowStatePort(store, options = {}) {
  return store instanceof WorkflowStatePort ? store : new WorkflowStatePort(store, options);
}

function shellQuote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }
function structuredCommand(executable, args = []) { return [executable, ...args].map(shellQuote).join(' '); }

function assertImmutablePlannedExecution(state, task, { executable = null, args = null, command = null, cwd, timeoutMs, env = {} } = {}) {
  const metadata = parseStrictJson(task.metadata_json || '{}');
  const plan = state.getExecutionPlan(task.job_id);
  const role = String(task.role || '').toLowerCase();
  const plannedByRole = plan?.children?.find(item => String(item.role || '').toLowerCase() === role) || null;
  const requiresPlanBinding = Boolean(metadata.workflow_plan_task_id) || Boolean(plan && task.parent_task_id) || Boolean(plannedByRole);
  if (!requiresPlanBinding) return null;
  if (!plan) throw new Error(`immutable execution plan is missing for planned task ${task.task_id}`);
  const plannedById = metadata.workflow_plan_task_id
    ? plan.children.find(item => item.id === metadata.workflow_plan_task_id)
    : null;
  if (!metadata.workflow_plan_task_id || !plannedById || !plannedByRole || plannedById.id !== plannedByRole.id) {
    throw new Error(`immutable plan task identity/role binding is invalid for ${task.task_id}`);
  }
  assertTaskDependenciesMatchPlan(task, plannedById, `task ${task.task_id}`);
  const specification = plannedById.execution;
  if (!specification || specification.deterministic !== true || specification.executor !== 'ExecutionManager' ||
      typeof specification.executable !== 'string' || !Array.isArray(specification.args) ||
      typeof specification.cwd !== 'string' || !Number.isSafeInteger(Number(specification.timeout_ms)) || Number(specification.timeout_ms) < 1) {
    throw new Error(`immutable plan does not authorize deterministic execution for ${task.task_id}`);
  }
  if (metadata.deterministic !== true || metadata.executor !== specification.executor ||
      metadata.executable !== specification.executable || JSON.stringify(metadata.args) !== JSON.stringify(specification.args) ||
      path.resolve(String(metadata.cwd || '')) !== path.resolve(specification.cwd) ||
      Number(metadata.timeout_ms) !== Number(specification.timeout_ms)) {
    throw new Error(`task metadata differs from the immutable approved execution plan for ${task.task_id}`);
  }
  const proposal = state.getCurrentProposal(task.job_id);
  if (!proposal?.payload || typeof proposal.payload.workspace !== 'string' || !proposal.payload.workspace) {
    throw new Error(`approved proposal workspace is missing for immutable plan ${task.job_id}`);
  }
  state.assertApprovalCurrent(task.job_id);
  const recompiled = state.compileExecutionPlan(task.job_id, { workspace: proposal.payload.workspace });
  if (!recompiled || recompiled.plan_hash !== plan.plan_hash || recompiled.plan_hash !== state.getExecutionPlan(task.job_id)?.plan_hash) {
    throw new Error(`immutable execution plan no longer matches the approved source plan for ${task.job_id}`);
  }
  if (executable !== null && executable !== specification.executable) {
    throw new Error(`requested executable differs from the immutable approved plan for ${task.task_id}`);
  }
  if (args !== null && JSON.stringify(args) !== JSON.stringify(specification.args)) {
    throw new Error(`requested arguments differ from the immutable approved plan for ${task.task_id}`);
  }
  const expectedCommand = structuredCommand(specification.executable, specification.args);
  if (command !== null && command !== expectedCommand) {
    throw new Error(`requested command differs from the immutable approved plan for ${task.task_id}`);
  }
  if (path.resolve(String(cwd || '')) !== path.resolve(specification.cwd)) {
    throw new Error(`requested working directory differs from the immutable approved plan for ${task.task_id}`);
  }
  if (!Number.isFinite(Number(timeoutMs)) || Number(timeoutMs) < 1 || Number(timeoutMs) > Number(specification.timeout_ms)) {
    throw new Error(`requested timeout exceeds or invalidates the immutable approved plan for ${task.task_id}`);
  }
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.keys(env).length !== 0) {
    throw new Error(`environment overrides are not authorized by the immutable plan for ${task.task_id}`);
  }
  return specification;
}
