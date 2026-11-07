import { ensureProviderDispatchIntentColumns, assertProviderDispatchIntent,
  canonicalProviderDispatchRequest, providerDispatchKey } from './provider-dispatch-identity.js';

/** Logical owner of provider-run and provider-dispatch persistence. */
export const EXECUTION_PERSISTENCE_STORE_VERSION = 1;

export const EXECUTION_PERSISTENCE_READ_METHODS = Object.freeze([
  'hasProviderRunLedger',
  'hasProviderDispatchIntentLedger',
  'listProviderRunsForJob',
  'getDispatchLedgerForLease',
  'hasUnresolvedProviderDispatchForJob',
  'hasUnresolvedProviderRunForJob',
  'getProviderRun',
  'listProviderDispatchIntentsForProviderRun',
  'listProviderDispatchIntentsForDispatchKey'
]);

function requiredId(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

export class ExecutionPersistenceStore {
  #db;

  constructor(database) {
    if (!database || typeof database.prepare !== 'function') {
      throw new TypeError('ExecutionPersistenceStore requires an injected DatabaseSync-compatible connection');
    }
    this.#db = database;
    this.ensureSchema();
  }

  get version() { return EXECUTION_PERSISTENCE_STORE_VERSION; }

  /** Execution schema owner; caller supplies the shared host connection. */
  assertSharedConnection(database) {
    if (!database || database !== this.#db) {
      throw new TypeError('Execution persistence participants must share the ExecutionPersistenceStore SQLite connection');
    }
    return true;
  }

  ensureSchema() {
    const db = this.#db;
    if (db.__p6Fake || typeof db.exec !== 'function') return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_runs (
        provider_run_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        job_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        owner_epoch INTEGER,
        input_commit TEXT NOT NULL,
        dispatch_key TEXT,
        request_sha256 TEXT,
        workflow TEXT NOT NULL,
        ref TEXT NOT NULL,
        state TEXT NOT NULL,
        conclusion TEXT,
        html_url TEXT,
        artifact_id TEXT,
        output_commit TEXT,
        run_attempt INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_provider_runs_task ON provider_runs(task_id, attempt);
      CREATE TABLE IF NOT EXISTS provider_dispatch_intents (
        dispatch_key TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        owner_epoch INTEGER,
        provider TEXT NOT NULL,
        input_commit TEXT NOT NULL,
        request_sha256 TEXT,
        request_json TEXT,
        api_base TEXT,
        workflow TEXT,
        repository TEXT,
        event TEXT,
        ref TEXT,
        state TEXT NOT NULL,
        provider_run_id TEXT,
        dispatch_claim_id TEXT,
        dispatch_claimed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_provider_dispatch_intents_state ON provider_dispatch_intents(state, created_at);
    `);
    ensureProviderDispatchIntentColumns(db);
    for (const [column, type] of [['run_attempt', 'INTEGER'], ['dispatch_key', 'TEXT'],
      ['request_sha256', 'TEXT'], ['owner_epoch', 'INTEGER']]) {
      try { db.exec(`ALTER TABLE provider_runs ADD COLUMN ${column} ${type}`); }
      catch (error) {
        if (!new RegExp(`duplicate column name:\\s*${column}`, 'i').test(String(error?.message || error))) throw error;
      }
    }
  }

  hasProviderRunLedger() {
    if (this.#db.__p6Fake) return false;
    return Boolean(this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_runs' LIMIT 1").get());
  }

  hasProviderDispatchIntentLedger() {
    if (this.#db.__p6Fake) return false;
    return Boolean(this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_dispatch_intents' LIMIT 1").get());
  }

  listProviderRunsForJob(jobId) {
    const id = requiredId(jobId, 'jobId');
    if (!this.hasProviderRunLedger()) return [];
    return this.#db.prepare('SELECT * FROM provider_runs WHERE job_id=? ORDER BY created_at ASC').all(id);
  }

  getDispatchLedgerForLease(leaseId) {
    const id = requiredId(leaseId, 'leaseId');
    if (this.#db.__p6Fake) return { providerRuns: [], dispatchIntents: [] };
    const tables = new Set(this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('provider_runs','provider_dispatch_intents')")
      .all().map(row => row.name));
    const providerRuns = tables.has('provider_runs')
      ? this.#db.prepare('SELECT * FROM provider_runs WHERE lease_id=? ORDER BY created_at ASC, rowid ASC').all(id)
      : [];
    const dispatchIntents = tables.has('provider_dispatch_intents')
      ? this.#db.prepare('SELECT * FROM provider_dispatch_intents WHERE lease_id=? ORDER BY created_at ASC, rowid ASC').all(id)
      : [];
    return { providerRuns, dispatchIntents };
  }

  hasUnresolvedProviderDispatchForJob(jobId) {
    const id = requiredId(jobId, 'jobId');
    if (this.#db.__p6Fake || !this.hasProviderDispatchIntentLedger()) return false;
    return Boolean(this.#db.prepare(`SELECT 1 FROM provider_dispatch_intents
      WHERE job_id=? AND state='DISPATCHING' AND provider_run_id IS NULL AND dispatch_claim_id IS NOT NULL LIMIT 1`).get(id));
  }

  hasUnresolvedProviderRunForJob(jobId) {
    const id = requiredId(jobId, 'jobId');
    if (this.#db.__p6Fake || !this.hasProviderRunLedger()) return false;
    return Boolean(this.#db.prepare(`SELECT 1 FROM provider_runs
      WHERE job_id=? AND UPPER(COALESCE(state,'')) NOT IN ('COMPLETED','FAILED','CANCELLED') LIMIT 1`).get(id));
  }

  getProviderRun(providerRunId) {
    const id = requiredId(providerRunId, 'providerRunId');
    if (this.#db.__p6Fake) return null;
    try { return this.#db.prepare('SELECT * FROM provider_runs WHERE provider_run_id=?').get(id) || null; }
    catch (error) {
      if (/no such table:\s*provider_runs/i.test(String(error?.message || error))) return null;
      throw error;
    }
  }

  listProviderDispatchIntentsForProviderRun(providerRunId) {
    const id = requiredId(providerRunId, 'providerRunId');
    if (!this.hasProviderDispatchIntentLedger() || this.#db.__p6Fake) return [];
    return this.#db.prepare('SELECT * FROM provider_dispatch_intents WHERE provider_run_id=? ORDER BY created_at ASC, rowid ASC').all(id);
  }

  listProviderDispatchIntentsForDispatchKey(dispatchKey) {
    const key = requiredId(dispatchKey, 'dispatchKey');
    if (!this.hasProviderDispatchIntentLedger() || this.#db.__p6Fake) return [];
    return this.#db.prepare('SELECT * FROM provider_dispatch_intents WHERE dispatch_key=? ORDER BY created_at ASC, rowid ASC').all(key);
  }

  getProviderDispatchIntent(dispatchKey) {
    const key = requiredId(dispatchKey, 'dispatchKey');
    if (this.#db.__p6Fake) return null;
    return this.#db.prepare('SELECT * FROM provider_dispatch_intents WHERE dispatch_key=?').get(key) || null;
  }

  getProviderDispatchIntentForRun(providerRunId) {
    const id = requiredId(providerRunId, 'providerRunId');
    if (this.#db.__p6Fake) return null;
    return this.#db.prepare('SELECT * FROM provider_dispatch_intents WHERE provider_run_id=?').get(id) || null;
  }

  listProviderDispatchIntents({ state = null } = {}) {
    if (state !== null && (typeof state !== 'string' || !state.trim())) throw new TypeError('dispatch intent state must be a non-empty string or null');
    if (this.#db.__p6Fake) return [];
    return this.#db.prepare(`SELECT * FROM provider_dispatch_intents${state ? ' WHERE state=?' : ''} ORDER BY created_at ASC, rowid ASC`)
      .all(...(state ? [state] : []));
  }

  listSiblingProviderDispatchIntents({ leaseId, taskId, attempt, provider, excludeDispatchKey }) {
    requiredId(leaseId, 'leaseId'); requiredId(taskId, 'taskId');
    requiredId(provider, 'provider'); requiredId(excludeDispatchKey, 'excludeDispatchKey');
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError('attempt must be a positive safe integer');
    if (this.#db.__p6Fake) return [];
    return this.#db.prepare(`SELECT * FROM provider_dispatch_intents
      WHERE lease_id=? AND task_id=? AND attempt=? AND provider=? AND dispatch_key<>?
      ORDER BY created_at ASC, rowid ASC`).all(leaseId, taskId, attempt, provider, excludeDispatchKey);
  }

  /** Reserve one immutable provider intent per execution attempt. */
  reserveProviderDispatchIntent({ dispatchIdentity, request, createdAt = new Date().toISOString() } = {}) {
    if (this.#db.__p6Fake) return null;
    if (!dispatchIdentity || typeof dispatchIdentity !== 'object' || !request || typeof request !== 'object') {
      throw new TypeError('dispatchIdentity and request are required to reserve a provider dispatch intent');
    }
    if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
      throw new TypeError('createdAt must be a canonical UTC timestamp');
    }
    const dispatchKey = providerDispatchKey(dispatchIdentity);
    const requestJson = canonicalProviderDispatchRequest(request);
    this.#db.exec('SAVEPOINT reserve_provider_dispatch_intent');
    try {
      const inserted = this.#db.prepare(`INSERT OR IGNORE INTO provider_dispatch_intents
        (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',?,?)`)
        .run(dispatchKey, dispatchIdentity.job_id, dispatchIdentity.task_id, dispatchIdentity.lease_id,
          dispatchIdentity.attempt, dispatchIdentity.owner_epoch, dispatchIdentity.provider, dispatchIdentity.input_commit,
          dispatchIdentity.request_sha256, requestJson, dispatchIdentity.api_base, dispatchIdentity.workflow,
          dispatchIdentity.repository, dispatchIdentity.event, dispatchIdentity.ref, createdAt, createdAt);
      const existingAttempts = this.#db.prepare(`SELECT * FROM provider_dispatch_intents
        WHERE job_id=? AND task_id=? AND lease_id=? AND attempt=? AND provider=? ORDER BY created_at, rowid`)
        .all(dispatchIdentity.job_id, dispatchIdentity.task_id, dispatchIdentity.lease_id,
          dispatchIdentity.attempt, dispatchIdentity.provider);
      if (existingAttempts.length > 1) {
        throw new Error(`multiple durable dispatch intents claim one execution lease/attempt: ${dispatchIdentity.lease_id}`);
      }
      if (existingAttempts.length === 1) assertProviderDispatchIntent(existingAttempts[0], dispatchIdentity);
      const existingIntent = this.getProviderDispatchIntent(dispatchKey);
      if (existingIntent) assertProviderDispatchIntent(existingIntent, dispatchIdentity);
      const reserved = this.getProviderDispatchIntent(dispatchKey);
      if (!reserved) throw new Error(`durable provider dispatch intent reservation was not persisted: ${dispatchKey}`);
      assertProviderDispatchIntent(reserved, dispatchIdentity);
      this.#db.exec('RELEASE SAVEPOINT reserve_provider_dispatch_intent');
      return { dispatchKey, existingAttempts, intent: reserved, alreadyExisted: inserted.changes !== 1 };
    } catch (error) {
      try { this.#db.exec('ROLLBACK TO SAVEPOINT reserve_provider_dispatch_intent'); } catch {}
      try { this.#db.exec('RELEASE SAVEPOINT reserve_provider_dispatch_intent'); } catch {}
      throw error;
    }
  }

  /** Persist provider dispatch outcome without taking ownership of Workflow state. */
  recordProviderDispatchOutcome({ dispatchKey, providerRunId = null, updatedAt = new Date().toISOString(),
    expectedRequestSha256 = null, expectedClaimId = null } = {}) {
    const key = requiredId(dispatchKey, 'dispatchKey');
    if (providerRunId !== null) requiredId(String(providerRunId), 'providerRunId');
    if (typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt)) || new Date(updatedAt).toISOString() !== updatedAt) {
      throw new TypeError('updatedAt must be a canonical UTC timestamp');
    }
    if (this.#db.__p6Fake) return null;
    if (providerRunId !== null) {
      this.#db.prepare(`UPDATE provider_dispatch_intents SET state='DISPATCHED', provider_run_id=?, updated_at=?
        WHERE dispatch_key=? AND state IN ('DISPATCHING','DISPATCHED') AND (provider_run_id IS NULL OR provider_run_id=?)
          AND (? IS NULL OR request_sha256=?) AND (? IS NULL OR dispatch_claim_id=?)`)
        .run(String(providerRunId), updatedAt, key, String(providerRunId), expectedRequestSha256, expectedRequestSha256, expectedClaimId, expectedClaimId);
    } else {
      this.#db.prepare(`UPDATE provider_dispatch_intents SET state='DISPATCHING', updated_at=?
        WHERE dispatch_key=? AND state='DISPATCHING' AND provider_run_id IS NULL`).run(updatedAt, key);
    }
    const persisted = this.getProviderDispatchIntent(key);
    if (!persisted || (providerRunId !== null
      ? persisted.state !== 'DISPATCHED' || String(persisted.provider_run_id) !== String(providerRunId)
      : persisted.state !== 'DISPATCHING' || persisted.provider_run_id !== null)) {
      throw new Error(`provider dispatch outcome conflicts with its durable intent binding: ${key}`);
    }
    if (expectedRequestSha256 !== null && persisted.request_sha256 !== expectedRequestSha256) {
      throw new Error(`provider dispatch outcome changed immutable request identity: ${key}`);
    }
    if (expectedClaimId !== null && persisted.dispatch_claim_id !== expectedClaimId) {
      throw new Error(`provider dispatch outcome changed one-way send claim: ${key}`);
    }
    return persisted;
  }

  /** Bind an independently reconciled provider run to its exact claimed intent. */
  bindReconciledProviderRun({ dispatchKey, providerRunId, requestSha256, dispatchClaimId,
    updatedAt = new Date().toISOString() } = {}) {
    const key = requiredId(dispatchKey, 'dispatchKey');
    requiredId(String(providerRunId), 'providerRunId');
    requiredId(requestSha256, 'requestSha256');
    requiredId(dispatchClaimId, 'dispatchClaimId');
    if (this.#db.__p6Fake) return null;
    this.#db.prepare(`UPDATE provider_dispatch_intents SET state='DISPATCHED', provider_run_id=?, updated_at=?
      WHERE dispatch_key=? AND state='DISPATCHING' AND provider_run_id IS NULL
        AND request_sha256=? AND dispatch_claim_id=?`)
      .run(String(providerRunId), updatedAt, key, requestSha256, dispatchClaimId);
    const persisted = this.getProviderDispatchIntent(key);
    if (!persisted || persisted.state !== 'DISPATCHED' || String(persisted.provider_run_id) !== String(providerRunId) ||
        persisted.request_sha256 !== requestSha256 || persisted.dispatch_claim_id !== dispatchClaimId) {
      throw new Error(`reconciled provider run conflicts with the durable dispatch-intent binding: ${key}`);
    }
    return persisted;
  }

  releaseProviderDispatchSendClaim({ dispatchKey, claimId, updatedAt = new Date().toISOString() } = {}) {
    const key = requiredId(dispatchKey, 'dispatchKey');
    requiredId(claimId, 'claimId');
    if (this.#db.__p6Fake) return { changes: 0 };
    const result = this.#db.prepare(`UPDATE provider_dispatch_intents
      SET dispatch_claim_id=NULL, dispatch_claimed_at=NULL, updated_at=?
      WHERE dispatch_key=? AND state='DISPATCHING' AND provider_run_id IS NULL AND dispatch_claim_id=?`)
      .run(updatedAt, key, claimId);
    return { changes: Number(result?.changes || 0) };
  }

  /** Persist provider-run identity and terminal evidence with exact readback. */
  persistProviderRun(run, { provider = 'github-actions', updatedAt = null } = {}) {
    if (!run || typeof run !== 'object' || Array.isArray(run)) throw new TypeError('provider run is required');
    requiredId(String(run.provider_run_id || ''), 'providerRunId');
    if (this.#db.__p6Fake) return null;
    const ts = updatedAt || new Date().toISOString();
    const db = this.#db;
    db.exec('SAVEPOINT provider_run_persist_identity');
    try {
      // Acquire SQLite's writer reservation before identity preflight; a
      // competing process must not insert between SELECT and UPSERT.
      db.prepare('UPDATE provider_runs SET updated_at=updated_at WHERE provider_run_id=?')
        .run(String(run.provider_run_id));
      const persisted = db.prepare('SELECT * FROM provider_runs WHERE provider_run_id=?').get(String(run.provider_run_id));
      if (persisted) {
        for (const field of ['provider', 'job_id', 'task_id', 'lease_id', 'attempt', 'owner_epoch', 'input_commit', 'workflow', 'ref', 'dispatch_key', 'request_sha256', 'run_attempt']) {
          const current = field === 'provider' ? persisted.provider : persisted[field];
          const incoming = field === 'provider' ? provider : run[field];
          if (current !== null && current !== undefined && incoming !== null && incoming !== undefined &&
              String(current).toLowerCase() !== String(incoming).toLowerCase()) {
            throw new Error(`provider run ${run.provider_run_id} immutable ${field} binding conflicts with durable ledger`);
          }
        }
        if (persisted.state === 'COMPLETED' &&
            (run.state !== 'COMPLETED' || String(persisted.conclusion ?? '') !== String(run.conclusion ?? ''))) {
          throw new Error(`provider run ${run.provider_run_id} incoming state/conclusion conflicts with durable terminal state`);
        }
        if (persisted.state === 'COMPLETED') {
          for (const field of ['artifact_id', 'output_commit']) {
            if (persisted[field] !== null && persisted[field] !== undefined && run[field] !== null && run[field] !== undefined &&
                String(persisted[field]).toLowerCase() !== String(run[field]).toLowerCase()) {
              throw new Error(`provider run ${run.provider_run_id} incoming ${field} conflicts with durable terminal evidence`);
            }
          }
        }
      }
      const result = db.prepare(`INSERT INTO provider_runs
        (provider_run_id,provider,job_id,task_id,lease_id,attempt,owner_epoch,input_commit,dispatch_key,request_sha256,workflow,ref,state,conclusion,html_url,artifact_id,output_commit,run_attempt,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(provider_run_id) DO UPDATE SET
        state=CASE WHEN provider_runs.state='COMPLETED' OR excluded.state='COMPLETED' THEN 'COMPLETED' ELSE excluded.state END,
        conclusion=CASE WHEN provider_runs.state='COMPLETED' THEN provider_runs.conclusion ELSE excluded.conclusion END,
        html_url=COALESCE(provider_runs.html_url,excluded.html_url),
        artifact_id=COALESCE(provider_runs.artifact_id,excluded.artifact_id),
        output_commit=COALESCE(provider_runs.output_commit,excluded.output_commit),
        dispatch_key=COALESCE(provider_runs.dispatch_key,excluded.dispatch_key),
        request_sha256=COALESCE(provider_runs.request_sha256,excluded.request_sha256),
        owner_epoch=COALESCE(provider_runs.owner_epoch,excluded.owner_epoch),
        run_attempt=COALESCE(provider_runs.run_attempt,excluded.run_attempt), updated_at=excluded.updated_at
        WHERE (provider_runs.dispatch_key IS NULL OR excluded.dispatch_key IS NULL OR provider_runs.dispatch_key=excluded.dispatch_key)
          AND (provider_runs.request_sha256 IS NULL OR excluded.request_sha256 IS NULL OR provider_runs.request_sha256=excluded.request_sha256)`)
        .run(run.provider_run_id, provider, run.job_id, run.task_id, run.lease_id, run.attempt,
          Number.isSafeInteger(Number(run.owner_epoch)) && Number(run.owner_epoch) >= 1 ? Number(run.owner_epoch) : null, run.input_commit,
          run.dispatch_key || null, run.request_sha256 || null, run.workflow, run.ref, run.state, run.conclusion || null,
          run.html_url || null, run.artifact_id || null, run.output_commit || null,
          Number.isSafeInteger(Number(run.run_attempt)) && Number(run.run_attempt) >= 1 ? Number(run.run_attempt) : null,
          run.created_at || ts, ts);
      if (result?.changes === 0) throw new Error(`provider run ${run.provider_run_id} immutable dispatch binding compare-and-set failed`);
      const readback = db.prepare('SELECT * FROM provider_runs WHERE provider_run_id=?').get(String(run.provider_run_id));
      if (!readback) throw new Error(`provider run ${run.provider_run_id} durable readback is missing after persistence`);
      for (const field of ['job_id', 'task_id', 'lease_id', 'attempt', 'owner_epoch', 'input_commit', 'workflow', 'ref', 'dispatch_key', 'request_sha256', 'run_attempt']) {
        const expected = run[field];
        const actual = readback[field];
        if (expected !== null && expected !== undefined && expected !== '' && actual !== null && actual !== undefined &&
            String(actual).toLowerCase() !== String(expected).toLowerCase()) {
          throw new Error(`provider run ${run.provider_run_id} durable readback conflicts with immutable ${field} binding`);
        }
        if (expected !== null && expected !== undefined && expected !== '' &&
            ['job_id', 'task_id', 'lease_id', 'input_commit', 'workflow', 'ref', 'dispatch_key', 'request_sha256'].includes(field) &&
            (actual === null || actual === undefined || actual === '')) {
          throw new Error(`provider run ${run.provider_run_id} durable readback is missing immutable ${field} binding`);
        }
      }
      for (const field of ['artifact_id', 'output_commit']) {
        const expected = run[field];
        const actual = readback[field];
        if (expected !== null && expected !== undefined && actual !== null && actual !== undefined &&
            String(actual).toLowerCase() !== String(expected).toLowerCase()) {
          throw new Error(`provider run ${run.provider_run_id} durable readback conflicts with terminal ${field} evidence`);
        }
      }
      if (readback.state !== 'COMPLETED' && run.state === 'COMPLETED') {
        throw new Error(`provider run ${run.provider_run_id} durable readback failed to preserve terminal state`);
      }
      if (readback.state === 'COMPLETED' &&
          (run.state !== 'COMPLETED' || String(readback.conclusion ?? '') !== String(run.conclusion ?? ''))) {
        throw new Error(`provider run ${run.provider_run_id} durable readback conflicts with terminal state/conclusion`);
      }
      db.exec('RELEASE SAVEPOINT provider_run_persist_identity');
      return readback;
    } catch (error) {
      try { db.exec('ROLLBACK TO SAVEPOINT provider_run_persist_identity'); } catch {}
      try { db.exec('RELEASE SAVEPOINT provider_run_persist_identity'); } catch {}
      throw error;
    }
  }

  /** Atomically bind the provider run and its claimed dispatch intent. */
  bindProviderDispatchRun(intent, run, { updatedAt = new Date().toISOString() } = {}) {
    if (!intent || typeof intent !== 'object' || !run || typeof run !== 'object') {
      throw new TypeError('intent and run are required to bind a provider run');
    }
    if (this.#db.__p6Fake) return run;
    requiredId(intent.dispatch_claim_id, 'intent.dispatch_claim_id');
    assertProviderDispatchIntent(intent, intent);
    const expected = {
      job_id: intent.job_id, task_id: intent.task_id, lease_id: intent.lease_id,
      attempt: Number(intent.attempt), owner_epoch: Number(intent.owner_epoch), input_commit: String(intent.input_commit).toLowerCase(),
      workflow: intent.workflow, ref: intent.ref
    };
    for (const field of ['job_id', 'task_id', 'lease_id', 'attempt', 'owner_epoch', 'input_commit', 'workflow', 'ref']) {
      const matches = field === 'attempt' || field === 'owner_epoch'
        ? Number(run[field]) === expected[field]
        : field === 'input_commit'
          ? String(run[field] ?? '').toLowerCase() === expected[field]
          : String(run[field] ?? '') === String(expected[field] ?? '');
      if (!matches) throw new Error(`GitHub Actions run binding does not match durable ${field} identity`);
    }
    if (!Number.isSafeInteger(Number(run.run_attempt)) || Number(run.run_attempt) < 1) {
      throw new Error('GitHub Actions P3 run binding requires a validated positive run_attempt');
    }
    const db = this.#db;
    db.exec('SAVEPOINT provider_dispatch_run_binding');
    try {
      const reservation = db.prepare('UPDATE provider_dispatch_intents SET updated_at=updated_at WHERE dispatch_key=?')
        .run(String(intent.dispatch_key));
      if (reservation.changes !== 1) throw new Error('GitHub Actions durable dispatch intent disappeared before result binding');
      const current = this.getProviderDispatchIntent(intent.dispatch_key);
      if (!current || current.job_id !== intent.job_id || current.task_id !== intent.task_id ||
          current.lease_id !== intent.lease_id || Number(current.attempt) !== Number(intent.attempt) ||
          Number(current.owner_epoch) !== Number(intent.owner_epoch) || current.provider !== 'github-actions' ||
          current.dispatch_claim_id !== intent.dispatch_claim_id ||
          String(current.input_commit).toLowerCase() !== String(intent.input_commit).toLowerCase() ||
          current.request_sha256 !== intent.request_sha256 || current.request_json !== intent.request_json ||
          current.api_base !== intent.api_base || current.workflow !== intent.workflow || current.repository !== intent.repository ||
          current.event !== intent.event || current.ref !== intent.ref) {
        throw new Error('GitHub Actions dispatch intent changed identity before result binding');
      }
      const existingRun = this.getProviderRun(run.provider_run_id);
      if (existingRun && (existingRun.provider !== 'github-actions' || existingRun.workflow !== run.workflow ||
          existingRun.ref !== run.ref || existingRun.job_id !== run.job_id || existingRun.task_id !== run.task_id ||
          existingRun.lease_id !== run.lease_id || Number(existingRun.attempt) !== Number(run.attempt) ||
          Number(existingRun.owner_epoch) !== Number(run.owner_epoch) ||
          String(existingRun.input_commit).toLowerCase() !== String(run.input_commit).toLowerCase() ||
          String(existingRun.dispatch_key || '') !== String(intent.dispatch_key) ||
          String(existingRun.request_sha256 || '') !== String(intent.request_sha256) ||
          Number(existingRun.run_attempt) !== Number(run.run_attempt))) {
        throw new Error(`GitHub Actions run ${run.provider_run_id} is already bound to a different durable execution attempt`);
      }
      if (current.provider_run_id) {
        if (String(current.provider_run_id) !== String(run.provider_run_id) || !['DISPATCHED', 'COMPLETED'].includes(String(current.state))) {
          throw new Error('GitHub Actions dispatch intent was concurrently bound to a different provider run');
        }
        if (!existingRun) throw new Error('GitHub Actions dispatch intent points to a provider run missing from the durable run ledger');
        db.exec('RELEASE SAVEPOINT provider_dispatch_run_binding');
        return existingRun;
      }
      if (current.state !== 'DISPATCHING') throw new Error(`GitHub Actions dispatch intent cannot bind a run from state ${String(current.state)}`);
      const update = db.prepare(`UPDATE provider_dispatch_intents SET state='DISPATCHED', provider_run_id=?, updated_at=?
        WHERE dispatch_key=? AND state='DISPATCHING' AND provider_run_id IS NULL AND dispatch_claim_id=?`)
        .run(String(run.provider_run_id), updatedAt, String(intent.dispatch_key), intent.dispatch_claim_id);
      if (update.changes !== 1) throw new Error('GitHub Actions dispatch intent compare-and-set failed during result binding');
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_PROVIDER_INTENT_BIND_CAS === 'SIGKILL') {
        process.kill(process.pid, 'SIGKILL');
      }
      this.persistProviderRun({ ...run, dispatch_key: String(intent.dispatch_key), request_sha256: String(intent.request_sha256) },
        { provider: 'github-actions', updatedAt });
      const persistedRun = this.getProviderRun(run.provider_run_id);
      if (!persistedRun || persistedRun.provider !== 'github-actions' || persistedRun.workflow !== run.workflow ||
          persistedRun.ref !== run.ref || persistedRun.job_id !== run.job_id || persistedRun.task_id !== run.task_id ||
          persistedRun.lease_id !== run.lease_id || Number(persistedRun.attempt) !== Number(run.attempt) ||
          String(persistedRun.input_commit).toLowerCase() !== String(run.input_commit).toLowerCase() ||
          String(persistedRun.dispatch_key || '') !== String(intent.dispatch_key) ||
          String(persistedRun.request_sha256 || '') !== String(intent.request_sha256) ||
          Number(persistedRun.run_attempt) !== Number(run.run_attempt)) {
        throw new Error('GitHub Actions provider-run ledger readback does not match the exact dispatch binding');
      }
      db.exec('RELEASE SAVEPOINT provider_dispatch_run_binding');
      return run;
    } catch (error) {
      try { db.exec('ROLLBACK TO SAVEPOINT provider_dispatch_run_binding'); } catch {}
      try { db.exec('RELEASE SAVEPOINT provider_dispatch_run_binding'); } catch {}
      throw error;
    }
  }
}
