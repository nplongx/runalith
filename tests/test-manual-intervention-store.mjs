import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ManualInterventionStore } from '../src/runtime/manual-intervention-store.js';

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE events(event_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL)');
const store = new ManualInterventionStore({ db });
const createdAt = '2026-10-31T10:00:00.000Z';
const intervention = {
  intervention_id: 'manual-1', job_id: 'job-1', task_id: 'task-1', actor: 'operator',
  reason: 'Provider was unavailable', workaround: 'Paused dispatch and escalated',
  proposed_automation: 'Add bounded retry diagnostics', duration_minutes: 12.5, created_at: createdAt
};

assert.deepEqual({ ...store.record(intervention) }, {
  ...intervention, duration_minutes: 12.5
});
assert.deepEqual(store.list({ jobId: 'job-1' }).map(row => row.intervention_id), ['manual-1']);
assert.deepEqual(store.list({ limit: 1 }).map(row => row.intervention_id), ['manual-1']);
assert.throws(() => store.record({ ...intervention, intervention_id: 'manual-2', duration_minutes: -1 }),
  /duration_minutes must be a finite non-negative number/);
assert.throws(() => store.record({ ...intervention, intervention_id: 'manual-3', created_at: 'yesterday' }),
  /canonical UTC timestamp/);
assert.throws(() => store.list({ limit: 201 }), /limit must be an integer in 1\.\.200/);
assert.throws(() => store.record(intervention), /UNIQUE|constraint/i,
  'duplicate intervention identity must not be silently overwritten');

store.beginRecordTransaction();
try {
  store.record({ ...intervention, intervention_id: 'manual-rollback' });
  db.prepare('INSERT INTO events(event_id,payload_json) VALUES(?,?)').run('event-rollback', '{}');
  store.rollbackRecordTransaction();
} catch (error) {
  store.rollbackRecordTransaction();
  throw error;
}
assert.equal(store.list({ jobId: 'job-1' }).some(row => row.intervention_id === 'manual-rollback'), false,
  'manual intervention row must roll back with its associated workflow event');
assert.equal(db.prepare('SELECT 1 FROM events WHERE event_id=?').get('event-rollback'), undefined);

store.beginRecordTransaction();
store.record({ ...intervention, intervention_id: 'manual-atomic-commit' });
db.prepare('INSERT INTO events(event_id,payload_json) VALUES(?,?)').run('event-atomic-commit', '{}');
store.commitRecordTransaction();
assert.equal(store.list({ jobId: 'job-1' }).some(row => row.intervention_id === 'manual-atomic-commit'), true);
assert.ok(db.prepare('SELECT 1 FROM events WHERE event_id=?').get('event-atomic-commit'));

db.close();
console.log('manual-intervention-store contract PASS');
