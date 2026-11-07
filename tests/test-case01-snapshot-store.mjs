import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Case01SnapshotStore } from '../src/runtime/workflow/case01-snapshot-store.js';

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE jobs(job_id TEXT PRIMARY KEY);
CREATE TABLE tasks(task_id TEXT PRIMARY KEY);
CREATE TABLE results(result_id TEXT PRIMARY KEY);
CREATE TABLE artifacts(artifact_id TEXT PRIMARY KEY);
CREATE TABLE attempts(attempt_id TEXT PRIMARY KEY);`);
db.prepare('INSERT INTO jobs(job_id) VALUES(?)').run('job-1');
for (const id of ['task-source', 'task-cto']) db.prepare('INSERT INTO tasks(task_id) VALUES(?)').run(id);
for (const id of ['result-source', 'result-cto']) db.prepare('INSERT INTO results(result_id) VALUES(?)').run(id);
for (const id of ['artifact-source', 'artifact-cto']) db.prepare('INSERT INTO artifacts(artifact_id) VALUES(?)').run(id);
for (const id of ['attempt-source', 'attempt-cto']) db.prepare('INSERT INTO attempts(attempt_id) VALUES(?)').run(id);
const store = new Case01SnapshotStore({ db });
const createdAt = '2026-10-31T10:00:00.000Z';

const reservation = store.reserveSnapshot({ snapshotId: 'snapshot-1', ownerPid: 123, createdAt });
assert.deepEqual({ ...reservation }, { snapshot_id: 'snapshot-1', owner_pid: 123, created_at: createdAt });
assert.deepEqual(store.listReservedSnapshotIds(), ['snapshot-1']);
assert.equal(store.deleteSnapshotReservation('snapshot-1'), 1);
assert.equal(store.deleteSnapshotReservation('snapshot-1'), 0);
assert.deepEqual(store.listSnapshotReservations(), []);
assert.throws(() => store.reserveSnapshot({ snapshotId: 'bad-timestamp', createdAt: 'yesterday' }), /canonical UTC timestamp/);

const ack = {
  job_id: 'job-1', source_task_id: 'task-source', source_result_id: 'result-source',
  source_artifact_id: 'artifact-source', source_attempt_id: 'attempt-source', snapshot_id: 'snapshot-ack',
  cto_task_id: 'task-cto', cto_result_id: 'result-cto', cto_artifact_id: 'artifact-cto', cto_attempt_id: 'attempt-cto',
  verified_manifest_sha256: 'a'.repeat(64), consumed_manifest_sha256: 'b'.repeat(64),
  lineage_json: '{"source_task_id":"task-source"}', created_at: createdAt
};

store.beginConsumptionAckTransaction();
const persisted = store.insertConsumptionAck(ack);
assert.equal(persisted.job_id, ack.job_id);
assert.equal(store.getConsumptionAck('job-1').lineage_json, ack.lineage_json);
store.rollbackConsumptionAckTransaction();
assert.equal(store.getConsumptionAck('job-1'), null, 'acknowledgement insert must roll back with its lineage transaction');

store.beginConsumptionAckTransaction();
store.insertConsumptionAck(ack);
store.commitConsumptionAckTransaction();
assert.equal(store.getConsumptionAck('job-1').consumed_manifest_sha256, 'b'.repeat(64));
assert.throws(() => store.insertConsumptionAck({ ...ack, consumed_manifest_sha256: 'not-a-hash' }), /consumed_manifest_sha256/);
assert.throws(() => store.insertConsumptionAck({ ...ack, job_id: 'job-2', created_at: 'yesterday' }), /canonical UTC timestamp/);
assert.throws(() => store.insertConsumptionAck(ack), /UNIQUE|constraint/i,
  'duplicate CASE-01 acknowledgement must not be overwritten');

store.beginSnapshotCleanupTransaction();
store.reserveSnapshot({ snapshotId: 'snapshot-rollback', ownerPid: 123, createdAt });
store.rollbackSnapshotCleanupTransaction();
assert.equal(store.listReservedSnapshotIds().includes('snapshot-rollback'), false,
  'snapshot reservations must respect the named cleanup transaction');

db.close();
console.log('CASE-01 snapshot store contract PASS');
