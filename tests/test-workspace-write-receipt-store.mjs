import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceWriteReceiptStore } from '../src/runtime/workspace-write-receipt-store.js';

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE jobs(job_id TEXT PRIMARY KEY);
CREATE TABLE tasks(task_id TEXT PRIMARY KEY);
CREATE TABLE events(event_id TEXT PRIMARY KEY);`);
const store = new WorkspaceWriteReceiptStore({ db });
const receipt = {
  receipt_id: 'wwr-1', job_id: 'job-1', task_id: 'task-1', plan_hash: 'a'.repeat(64),
  patch_id: 'patch-1', request_hash: 'b'.repeat(64), path: 'src/output.txt', outcome: 'created',
  before_sha256: 'ABSENT', after_sha256: 'c'.repeat(64), size_bytes: 7,
  created_at: '2026-10-31T10:00:00.000Z'
};
const intent = {
  receipt_id: 'wwr-intent-1', job_id: 'job-1', task_id: 'task-1', plan_hash: 'a'.repeat(64),
  patch_id: 'patch-intent', request_hash: 'b'.repeat(64), workspace_root: '/workspace',
  path: 'src/pending.txt', outcome: 'created', before_sha256: 'ABSENT', after_sha256: 'c'.repeat(64),
  size_bytes: 7, created_at: '2026-10-31T10:00:00.000Z'
};

store.beginWriteTransaction();
store.insert(receipt);
assert.equal(store.find({ jobId: 'job-1', taskId: 'task-1', patchId: 'patch-1', path: 'src/output.txt' }).receipt_id, 'wwr-1');
store.commitWriteTransaction();

assert.deepEqual(store.listForJob('job-1').map(row => row.receipt_id), ['wwr-1']);
assert.deepEqual(store.listForTaskPlan({ jobId: 'job-1', taskId: 'task-1', planHash: 'a'.repeat(64) }).map(row => row.receipt_id), ['wwr-1']);
assert.deepEqual(store.listForJobPlan('job-1', 'a'.repeat(64)).map(row => ({ ...row })), [{ receipt_id: 'wwr-1', task_id: 'task-1' }]);

store.beginWriteTransaction();
store.insert({ ...receipt, receipt_id: 'wwr-2', patch_id: 'patch-2', path: 'src/rolled-back.txt' });
store.rollbackWriteTransaction();
assert.equal(store.find({ jobId: 'job-1', taskId: 'task-1', patchId: 'patch-2', path: 'src/rolled-back.txt' }), null,
  'rollback must remove receipt rows written in the named workspace transaction');

assert.throws(() => store.insert({ ...receipt, receipt_id: 'wwr-invalid-hash', after_sha256: 'not-a-hash' }), /after_sha256/);
assert.throws(() => store.insert({ ...receipt, receipt_id: 'wwr-invalid-outcome', outcome: 'unknown' }), /outcome is unsupported/);
assert.throws(() => store.insert({ ...receipt, receipt_id: 'wwr-invalid-size', size_bytes: -1 }), /size_bytes/);
assert.throws(() => store.listForTaskPlan({ jobId: 'job-1', taskId: 'task-1', planHash: 'bad' }), /planHash/);
assert.throws(() => store.insert(receipt), /UNIQUE|constraint/i,
  'same job/task/patch/path must not be overwritten');

store.beginWriteTransaction();
store.insertIntent(intent);
assert.deepEqual(store.listPendingIntentsForJob('job-1').map(row => row.receipt_id), ['wwr-intent-1']);
store.commitWriteTransaction();
assert.equal(store.getByReceiptId('wwr-intent-1'), null, 'pending intent is not an accepted receipt');

store.beginWriteTransaction();
store.deleteIntent('wwr-intent-1');
store.rollbackWriteTransaction();
assert.equal(store.listPendingIntentsForJob('job-1').length, 1, 'rollback must preserve durable intent');

store.beginWriteTransaction();
store.deleteIntent('wwr-intent-1');
store.commitWriteTransaction();
assert.equal(store.listPendingIntentsForJob('job-1').length, 0);
assert.throws(() => store.insertIntent({ ...intent, receipt_id: 'bad', after_sha256: 'bad' }), /after_sha256/);

db.close();

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-write-journal-'));
try {
  const databasePath = path.join(temporaryRoot, 'workflow.sqlite');
  const firstDb = new DatabaseSync(databasePath);
  firstDb.exec('CREATE TABLE jobs(job_id TEXT PRIMARY KEY); CREATE TABLE tasks(task_id TEXT PRIMARY KEY); CREATE TABLE events(event_id TEXT PRIMARY KEY);');
  const firstStore = new WorkspaceWriteReceiptStore({ db: firstDb });
  firstStore.beginWriteTransaction();
  firstStore.insertIntent({ ...intent, receipt_id: 'wwr-restart' });
  firstStore.commitWriteTransaction();
  firstDb.close();

  const restartedDb = new DatabaseSync(databasePath);
  const restartedStore = new WorkspaceWriteReceiptStore({ db: restartedDb });
  assert.deepEqual(restartedStore.listPendingIntentsForJob('job-1').map(row => row.receipt_id), ['wwr-restart'],
    'write intent must survive process/database restart');
  restartedStore.beginWriteTransaction();
  restartedStore.deleteIntent('wwr-restart');
  restartedStore.commitWriteTransaction();
  restartedDb.close();
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('workspace-write-receipt-store contract PASS');
