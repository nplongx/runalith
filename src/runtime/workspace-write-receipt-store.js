function requiredId(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

const HASH_RE = /^[a-f0-9]{64}$/;
const OUTCOMES = new Set(['created', 'replaced', 'already_present', 'reconciled_after_restart']);

/**
 * Owns durable receipts for plan-authorized workspace writes.
 *
 * Filesystem mutation cannot be committed atomically with SQLite. The named
 * transaction lifecycle lets the composition use case hold the SQLite writer
 * reservation across approval/task rechecks, file mutation, receipt insert and
 * workflow event append without exposing a DB handle or generic transaction(fn).
 */
export class WorkspaceWriteReceiptStore {
  #db;

  constructor(workflowStore) {
    const db = workflowStore?.db;
    if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
      throw new TypeError('WorkspaceWriteReceiptStore requires a WorkflowStore with SQLite-compatible storage');
    }
    this.#db = db;
    this.ensureSchema();
  }

  ensureSchema() {
    this.#db.exec(`CREATE TABLE IF NOT EXISTS workspace_write_receipts (
      receipt_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      plan_hash TEXT NOT NULL,
      patch_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      path TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('created','replaced','already_present','reconciled_after_restart')),
      before_sha256 TEXT NOT NULL,
      after_sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(job_id, task_id, patch_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_write_receipts_job ON workspace_write_receipts(job_id, created_at);
    CREATE TABLE IF NOT EXISTS workspace_write_intents (
      receipt_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      plan_hash TEXT NOT NULL,
      patch_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      path TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('created','replaced','already_present')),
      before_sha256 TEXT NOT NULL,
      after_sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      owner_pid INTEGER,
      owner_start_ticks TEXT,
      owner_boot_id TEXT,
      UNIQUE(job_id, task_id, patch_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_write_intents_job ON workspace_write_intents(job_id, created_at);`);
    const intentColumns = new Set(this.#db.prepare('PRAGMA table_info(workspace_write_intents)').all().map(row => row.name));
    for (const [name, type] of [['owner_pid', 'INTEGER'], ['owner_start_ticks', 'TEXT'], ['owner_boot_id', 'TEXT']]) {
      if (!intentColumns.has(name)) this.#db.exec(`ALTER TABLE workspace_write_intents ADD COLUMN ${name} ${type}`);
    }
  }

  find({ jobId, taskId, patchId, path }) {
    const job = requiredId(jobId, 'jobId');
    const task = requiredId(taskId, 'taskId');
    const patch = requiredId(patchId, 'patchId');
    const target = requiredId(path, 'path');
    return this.#db.prepare(`SELECT * FROM workspace_write_receipts
      WHERE job_id=? AND task_id=? AND patch_id=? AND path=?`).get(job, task, patch, target) || null;
  }

  insert(receipt) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      throw new TypeError('workspace write receipt must be an object');
    }
    const row = {
      receipt_id: requiredId(receipt.receipt_id, 'receipt_id'),
      job_id: requiredId(receipt.job_id, 'job_id'),
      task_id: requiredId(receipt.task_id, 'task_id'),
      plan_hash: requiredId(receipt.plan_hash, 'plan_hash'),
      patch_id: requiredId(receipt.patch_id, 'patch_id'),
      request_hash: requiredId(receipt.request_hash, 'request_hash'),
      path: requiredId(receipt.path, 'path'),
      outcome: receipt.outcome,
      before_sha256: requiredId(receipt.before_sha256, 'before_sha256'),
      after_sha256: requiredId(receipt.after_sha256, 'after_sha256'),
      size_bytes: receipt.size_bytes,
      created_at: requiredId(receipt.created_at, 'created_at')
    };
    for (const field of ['plan_hash', 'request_hash', 'before_sha256', 'after_sha256']) {
      if (!HASH_RE.test(row[field]) && !(field === 'before_sha256' && row[field] === 'ABSENT')) {
        throw new TypeError(`${field} must be a lowercase SHA-256 digest${field === 'before_sha256' ? ' or ABSENT' : ''}`);
      }
    }
    if (!OUTCOMES.has(row.outcome)) throw new TypeError('workspace write receipt outcome is unsupported');
    if (!Number.isSafeInteger(row.size_bytes) || row.size_bytes < 0) throw new TypeError('size_bytes must be a non-negative safe integer');
    if (!Number.isFinite(Date.parse(row.created_at)) || new Date(row.created_at).toISOString() !== row.created_at) {
      throw new TypeError('created_at must be a canonical UTC timestamp');
    }
    this.#db.prepare(`INSERT INTO workspace_write_receipts
      (receipt_id,job_id,task_id,plan_hash,patch_id,request_hash,path,outcome,before_sha256,after_sha256,size_bytes,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.receipt_id, row.job_id, row.task_id, row.plan_hash, row.patch_id, row.request_hash,
      row.path, row.outcome, row.before_sha256, row.after_sha256, row.size_bytes, row.created_at
    );
    const persisted = this.#db.prepare('SELECT * FROM workspace_write_receipts WHERE receipt_id=?').get(row.receipt_id);
    if (!persisted || Object.keys(row).some(key => persisted[key] !== row[key])) {
      throw new Error(`workspace write receipt failed exact durable readback: ${row.receipt_id}`);
    }
    return persisted;
  }

  insertIntent(intent) {
    if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
      throw new TypeError('workspace write intent must be an object');
    }
    const row = {
      receipt_id: requiredId(intent.receipt_id, 'receipt_id'),
      job_id: requiredId(intent.job_id, 'job_id'),
      task_id: requiredId(intent.task_id, 'task_id'),
      plan_hash: requiredId(intent.plan_hash, 'plan_hash'),
      patch_id: requiredId(intent.patch_id, 'patch_id'),
      request_hash: requiredId(intent.request_hash, 'request_hash'),
      workspace_root: requiredId(intent.workspace_root, 'workspace_root'),
      path: requiredId(intent.path, 'path'),
      outcome: intent.outcome,
      before_sha256: requiredId(intent.before_sha256, 'before_sha256'),
      after_sha256: requiredId(intent.after_sha256, 'after_sha256'),
      size_bytes: intent.size_bytes,
      created_at: requiredId(intent.created_at, 'created_at'),
      owner_pid: intent.owner_pid ?? null,
      owner_start_ticks: intent.owner_start_ticks ?? null,
      owner_boot_id: intent.owner_boot_id ?? null
    };
    for (const field of ['plan_hash', 'request_hash', 'before_sha256', 'after_sha256']) {
      if (!HASH_RE.test(row[field]) && !(field === 'before_sha256' && row[field] === 'ABSENT')) {
        throw new TypeError(`${field} must be a lowercase SHA-256 digest${field === 'before_sha256' ? ' or ABSENT' : ''}`);
      }
    }
    if (!['created', 'replaced', 'already_present'].includes(row.outcome)) throw new TypeError('workspace write intent outcome is unsupported');
    if (!Number.isSafeInteger(row.size_bytes) || row.size_bytes < 0) throw new TypeError('size_bytes must be a non-negative safe integer');
    if (row.owner_pid !== null && (!Number.isSafeInteger(row.owner_pid) || row.owner_pid < 1)) throw new TypeError('owner_pid must be a positive safe integer or null');
    const ownerFields = [row.owner_pid, row.owner_start_ticks, row.owner_boot_id];
    if (ownerFields.some(value => value === null) && ownerFields.some(value => value !== null)) throw new TypeError('intent owner identity fields must be all present or all null');
    if (row.owner_start_ticks !== null && !/^\d+$/.test(row.owner_start_ticks)) throw new TypeError('owner_start_ticks must be an unsigned integer string');
    if (row.owner_boot_id !== null && !/^[0-9a-f-]{36}$/.test(row.owner_boot_id)) throw new TypeError('owner_boot_id must be a UUID');
    if (!Number.isFinite(Date.parse(row.created_at)) || new Date(row.created_at).toISOString() !== row.created_at) {
      throw new TypeError('created_at must be a canonical UTC timestamp');
    }
    this.#db.prepare(`INSERT INTO workspace_write_intents
      (receipt_id,job_id,task_id,plan_hash,patch_id,request_hash,workspace_root,path,outcome,before_sha256,after_sha256,size_bytes,created_at,owner_pid,owner_start_ticks,owner_boot_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.receipt_id, row.job_id, row.task_id, row.plan_hash, row.patch_id, row.request_hash,
      row.workspace_root, row.path, row.outcome, row.before_sha256, row.after_sha256, row.size_bytes, row.created_at,
      row.owner_pid, row.owner_start_ticks, row.owner_boot_id
    );
    const persisted = this.#db.prepare('SELECT * FROM workspace_write_intents WHERE receipt_id=?').get(row.receipt_id);
    if (!persisted || Object.keys(row).some(key => persisted[key] !== row[key])) {
      throw new Error(`workspace write intent failed exact durable readback: ${row.receipt_id}`);
    }
    return persisted;
  }

  listPendingIntentsForJob(jobId) {
    const job = requiredId(jobId, 'jobId');
    return this.#db.prepare('SELECT * FROM workspace_write_intents WHERE job_id=? ORDER BY created_at,receipt_id').all(job);
  }

  getByReceiptId(receiptId) {
    const id = requiredId(receiptId, 'receiptId');
    return this.#db.prepare('SELECT * FROM workspace_write_receipts WHERE receipt_id=?').get(id) || null;
  }

  deleteIntent(receiptId) {
    const id = requiredId(receiptId, 'receiptId');
    this.#db.prepare('DELETE FROM workspace_write_intents WHERE receipt_id=?').run(id);
  }

  releaseIntentOwner(receiptId) {
    const id = requiredId(receiptId, 'receiptId');
    this.#db.prepare('UPDATE workspace_write_intents SET owner_pid=NULL,owner_start_ticks=NULL,owner_boot_id=NULL WHERE receipt_id=?').run(id);
  }

  listForJob(jobId) {
    const job = requiredId(jobId, 'jobId');
    return this.#db.prepare('SELECT * FROM workspace_write_receipts WHERE job_id=? ORDER BY created_at,receipt_id').all(job);
  }

  listForTaskPlan({ jobId, taskId, planHash }) {
    const job = requiredId(jobId, 'jobId');
    const task = requiredId(taskId, 'taskId');
    const hash = requiredId(planHash, 'planHash');
    if (!HASH_RE.test(hash)) throw new TypeError('planHash must be a lowercase SHA-256 digest');
    return this.#db.prepare(`SELECT receipt_id FROM workspace_write_receipts
      WHERE job_id=? AND task_id=? AND plan_hash=? ORDER BY created_at,receipt_id`).all(job, task, hash);
  }

  listForTask({ jobId, taskId }) {
    const job = requiredId(jobId, 'jobId');
    const task = requiredId(taskId, 'taskId');
    return this.#db.prepare(`SELECT * FROM workspace_write_receipts
      WHERE job_id=? AND task_id=? ORDER BY created_at,receipt_id`).all(job, task);
  }

  listForJobPlan(jobId, planHash) {
    const job = requiredId(jobId, 'jobId');
    const hash = requiredId(planHash, 'planHash');
    if (!HASH_RE.test(hash)) throw new TypeError('planHash must be a lowercase SHA-256 digest');
    return this.#db.prepare(`SELECT receipt_id,task_id FROM workspace_write_receipts
      WHERE job_id=? AND plan_hash=? ORDER BY created_at,receipt_id`).all(job, hash);
  }

  beginWriteTransaction() { this.#db.exec('BEGIN IMMEDIATE'); }
  commitWriteTransaction() { this.#db.exec('COMMIT'); }
  rollbackWriteTransaction() {
    try { this.#db.exec('ROLLBACK'); } catch {}
  }
}

export function createWorkspaceWriteReceiptStore(workflowStore) {
  return new WorkspaceWriteReceiptStore(workflowStore);
}
