const SHA256_RE = /^[a-f0-9]{64}$/;

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function canonicalTimestamp(value, label) {
  requiredText(value, label);
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

/**
 * Owns CASE-01 snapshot reservations and downstream consumption acknowledgements.
 *
 * Filesystem snapshots and Workflow artifact/result/event lineage are verified
 * by the CASE-01 use case. This store only owns the domain tables and named
 * writer-transaction controls so those checks and ack rows remain serialized
 * on the same current SQLite connection.
 */
export class Case01SnapshotStore {
  #db;

  constructor(workflowStore) {
    const db = workflowStore?.db;
    if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
      throw new TypeError('Case01SnapshotStore requires a WorkflowStore with SQLite-compatible storage');
    }
    this.#db = db;
    this.ensureSchema();
  }

  ensureSchema() {
    this.#db.exec(`CREATE TABLE IF NOT EXISTS case01_snapshot_reservations (
      snapshot_id TEXT PRIMARY KEY,
      owner_pid INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS case01_consumption_acks (
      job_id TEXT PRIMARY KEY REFERENCES jobs(job_id),
      source_task_id TEXT NOT NULL REFERENCES tasks(task_id),
      source_result_id TEXT NOT NULL REFERENCES results(result_id),
      source_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
      source_attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
      snapshot_id TEXT NOT NULL,
      cto_task_id TEXT NOT NULL REFERENCES tasks(task_id),
      cto_result_id TEXT NOT NULL REFERENCES results(result_id),
      cto_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
      cto_attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
      verified_manifest_sha256 TEXT NOT NULL CHECK(length(verified_manifest_sha256)=64),
      consumed_manifest_sha256 TEXT NOT NULL CHECK(length(consumed_manifest_sha256)=64),
      lineage_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(job_id, snapshot_id, cto_result_id)
    );`);
  }

  reserveSnapshot({ snapshotId, ownerPid = process.pid, createdAt = new Date().toISOString() } = {}) {
    const id = requiredText(snapshotId, 'snapshotId');
    if (!Number.isSafeInteger(ownerPid) || ownerPid < 1) throw new TypeError('ownerPid must be a positive safe integer');
    const timestamp = canonicalTimestamp(createdAt, 'createdAt');
    this.#db.prepare('INSERT INTO case01_snapshot_reservations(snapshot_id,owner_pid,created_at) VALUES(?,?,?)')
      .run(id, ownerPid, timestamp);
    const row = this.#db.prepare('SELECT snapshot_id,owner_pid,created_at FROM case01_snapshot_reservations WHERE snapshot_id=?')
      .get(id);
    if (!row || row.snapshot_id !== id || row.owner_pid !== ownerPid || row.created_at !== timestamp) {
      throw new Error(`CASE-01 snapshot reservation failed exact durable readback: ${id}`);
    }
    return row;
  }

  deleteSnapshotReservation(snapshotId) {
    const id = requiredText(snapshotId, 'snapshotId');
    const result = this.#db.prepare('DELETE FROM case01_snapshot_reservations WHERE snapshot_id=?').run(id);
    return Number(result?.changes || 0);
  }

  listSnapshotReservations() {
    return this.#db.prepare('SELECT snapshot_id,owner_pid,created_at FROM case01_snapshot_reservations ORDER BY created_at ASC,rowid ASC').all();
  }

  listReservedSnapshotIds() {
    return this.#db.prepare('SELECT snapshot_id FROM case01_snapshot_reservations ORDER BY snapshot_id ASC')
      .all().map(row => row.snapshot_id);
  }

  getConsumptionAck(jobId) {
    const id = requiredText(jobId, 'jobId');
    return this.#db.prepare('SELECT * FROM case01_consumption_acks WHERE job_id=?').get(id) || null;
  }

  insertConsumptionAck(ack) {
    if (!ack || typeof ack !== 'object' || Array.isArray(ack)) throw new TypeError('CASE-01 consumption acknowledgement must be an object');
    const columns = [
      'job_id', 'source_task_id', 'source_result_id', 'source_artifact_id', 'source_attempt_id', 'snapshot_id',
      'cto_task_id', 'cto_result_id', 'cto_artifact_id', 'cto_attempt_id', 'verified_manifest_sha256',
      'consumed_manifest_sha256', 'lineage_json', 'created_at'
    ];
    const row = Object.fromEntries(columns.map(column => [column, ack[column]]));
    for (const column of columns.slice(0, 10)) requiredText(row[column], column);
    for (const column of ['verified_manifest_sha256', 'consumed_manifest_sha256']) {
      if (typeof row[column] !== 'string' || !SHA256_RE.test(row[column])) throw new TypeError(`${column} must be a lowercase SHA-256 digest`);
    }
    requiredText(row.lineage_json, 'lineage_json');
    canonicalTimestamp(row.created_at, 'created_at');
    this.#db.prepare(`INSERT INTO case01_consumption_acks(${columns.join(',')})
      VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(column => row[column]));
    const persisted = this.getConsumptionAck(row.job_id);
    if (!persisted || columns.some(column => persisted[column] !== row[column])) {
      throw new Error(`CASE-01 consumption acknowledgement failed exact durable readback: ${row.job_id}`);
    }
    return persisted;
  }

  beginSnapshotCleanupTransaction() { this.#db.exec('BEGIN IMMEDIATE'); }
  commitSnapshotCleanupTransaction() { this.#db.exec('COMMIT'); }
  rollbackSnapshotCleanupTransaction() {
    try { this.#db.exec('ROLLBACK'); } catch {}
  }

  beginConsumptionAckTransaction() { this.#db.exec('BEGIN IMMEDIATE'); }
  commitConsumptionAckTransaction() { this.#db.exec('COMMIT'); }
  rollbackConsumptionAckTransaction() {
    try { this.#db.exec('ROLLBACK'); } catch {}
  }
}

export function createCase01SnapshotStore(workflowStore) {
  return new Case01SnapshotStore(workflowStore);
}
