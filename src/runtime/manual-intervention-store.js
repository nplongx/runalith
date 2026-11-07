function requiredText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new TypeError(`${label} exceeds ${maxLength} characters`);
  return normalized;
}

function optionalText(value, label, maxLength) {
  if (value === null || value === undefined) return null;
  return requiredText(value, label, maxLength);
}

/** Owns the manual-intervention audit table and its append/list API. */
export class ManualInterventionStore {
  #db;

  constructor(workflowStore) {
    const db = workflowStore?.db;
    if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
      throw new TypeError('ManualInterventionStore requires a WorkflowStore with SQLite-compatible storage');
    }
    this.#db = db;
    this.ensureSchema();
  }

  ensureSchema() {
    this.#db.exec(`CREATE TABLE IF NOT EXISTS manual_interventions (
      intervention_id TEXT PRIMARY KEY, job_id TEXT, task_id TEXT, actor TEXT NOT NULL,
      reason TEXT NOT NULL, workaround TEXT NOT NULL, proposed_automation TEXT,
      duration_minutes REAL, created_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_manual_interventions_job_created
      ON manual_interventions(job_id, created_at);`);
  }

  record(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('manual intervention must be an object');
    }
    const intervention = {
      intervention_id: requiredText(input.intervention_id, 'intervention_id', 200),
      job_id: optionalText(input.job_id, 'job_id', 200),
      task_id: optionalText(input.task_id, 'task_id', 200),
      actor: requiredText(input.actor, 'actor', 200),
      reason: requiredText(input.reason, 'reason', 4000),
      workaround: requiredText(input.workaround, 'workaround', 8000),
      proposed_automation: optionalText(input.proposed_automation, 'proposed_automation', 8000),
      duration_minutes: input.duration_minutes === null || input.duration_minutes === undefined
        ? null : Number(input.duration_minutes),
      created_at: requiredText(input.created_at, 'created_at', 40)
    };
    if (intervention.duration_minutes !== null &&
        (!Number.isFinite(intervention.duration_minutes) || intervention.duration_minutes < 0)) {
      throw new TypeError('duration_minutes must be a finite non-negative number or null');
    }
    if (!Number.isFinite(Date.parse(intervention.created_at)) ||
        new Date(intervention.created_at).toISOString() !== intervention.created_at) {
      throw new TypeError('created_at must be a canonical UTC timestamp');
    }
    this.#db.prepare(`INSERT INTO manual_interventions
      (intervention_id,job_id,task_id,actor,reason,workaround,proposed_automation,duration_minutes,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      intervention.intervention_id, intervention.job_id, intervention.task_id, intervention.actor,
      intervention.reason, intervention.workaround, intervention.proposed_automation,
      intervention.duration_minutes, intervention.created_at
    );
    const persisted = this.#db.prepare('SELECT * FROM manual_interventions WHERE intervention_id=?')
      .get(intervention.intervention_id);
    if (!persisted || Object.keys(intervention).some(key => persisted[key] !== intervention[key])) {
      throw new Error(`manual intervention failed exact durable readback: ${intervention.intervention_id}`);
    }
    return persisted;
  }

  list({ jobId = null, limit = 50 } = {}) {
    if (jobId !== null) requiredText(jobId, 'jobId', 200);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new TypeError('manual intervention limit must be an integer in 1..200');
    }
    return jobId === null
      ? this.#db.prepare('SELECT * FROM manual_interventions ORDER BY created_at DESC,rowid DESC LIMIT ?').all(limit)
      : this.#db.prepare('SELECT * FROM manual_interventions WHERE job_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?')
        .all(jobId, limit);
  }

  beginRecordTransaction() { this.#db.exec('BEGIN IMMEDIATE'); }
  commitRecordTransaction() { this.#db.exec('COMMIT'); }
  rollbackRecordTransaction() {
    try { this.#db.exec('ROLLBACK'); } catch {}
  }
}

export function createManualInterventionStore(workflowStore) {
  return new ManualInterventionStore(workflowStore);
}
