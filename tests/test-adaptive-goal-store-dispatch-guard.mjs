import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-store-dispatch-guard-'));
fs.chmodSync(testRoot, 0o700);
const workspace = path.join(testRoot, 'workspace');
fs.mkdirSync(workspace, { mode: 0o700 });
process.env.WORKFLOW_DB = path.join(testRoot, 'default-workflow.db');
process.env.WORKFLOW_DATA_DIR = testRoot;
process.env.WORKFLOW_WORKSPACE = workspace;
const legacyDb = new DatabaseSync(process.env.WORKFLOW_DB);
legacyDb.exec(`
  CREATE TABLE events(event_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TRIGGER agg_approval_security_events_no_replace BEFORE INSERT ON events
    WHEN EXISTS (SELECT 1 FROM events existing WHERE existing.event_id=NEW.event_id
      AND existing.type IN ('approval.approved','adaptive_goal.approval_policy_version_observed'))
    BEGIN SELECT RAISE(IGNORE); END;
  CREATE TRIGGER agg_approval_security_events_no_update BEFORE UPDATE ON events
    WHEN OLD.type IN ('approval.approved','adaptive_goal.approval_policy_version_observed')
    BEGIN SELECT RAISE(ABORT,'AGG approval security events are append-only'); END;
  CREATE TRIGGER agg_approval_security_events_no_delete BEFORE DELETE ON events
    WHEN OLD.type IN ('approval.approved','adaptive_goal.approval_policy_version_observed')
    BEGIN SELECT RAISE(ABORT,'AGG approval security events are append-only'); END;
`);
const legacyReviewerPayload = JSON.stringify({ schema_version: 1, nonce: '00000000-0000-4000-8000-000000000003' });
legacyDb.prepare('INSERT INTO events(event_id,job_id,type,payload_json,created_at) VALUES(?,?,?,?,?)')
  .run('legacy-reviewer-event', 'legacy-reviewer-job', 'adaptive_goal.action_intent_review_authorized', legacyReviewerPayload, new Date().toISOString());
legacyDb.close();
fs.chmodSync(process.env.WORKFLOW_DB, 0o600);
const { workflowStore: store } = await import('../job-store.js');
after(() => {
  try { store.db.close(); } catch {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});

function createJob(title = 'Engineering standard dispatch guard regression') {
  const job = store.createJob({ conversationKey: `dispatch-guard:${title}`, title });
  return job;
}

test('WorkflowStore adds reviewer nonce guards to existing databases with legacy approval-only triggers', () => {
  const triggerNames = new Set(store.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map(row => row.name));
  assert.ok(triggerNames.has('agg_approval_security_events_no_delete'), 'legacy trigger remains intact');
  assert.ok(triggerNames.has('agg_approval_reviewer_security_events_no_delete'), 'additive reviewer trigger is installed');
  assert.ok(triggerNames.has('agg_approval_reviewer_security_events_no_replace'), 'additive REPLACE guard is installed');
  assert.throws(() => store.db.prepare('DELETE FROM events WHERE event_id=?').run('legacy-reviewer-event'),
    /AGG approval security events are append-only/);
  assert.throws(() => store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?')
    .run('{"tampered":true}', 'legacy-reviewer-event'), /AGG approval security events are append-only/);
  const replacement = store.db.prepare(`INSERT OR REPLACE INTO events(event_id,job_id,type,payload_json,created_at)
    VALUES(?,?,?,?,?)`).run('legacy-reviewer-event', 'legacy-reviewer-job', 'adaptive_goal.action_intent_review_authorized',
      '{"tampered":true}', new Date().toISOString());
  assert.equal(replacement.changes, 0, 'same-ID REPLACE is ignored before SQLite conflict resolution');
  assert.equal(store.db.prepare('SELECT payload_json FROM events WHERE event_id=?').get('legacy-reviewer-event').payload_json,
    legacyReviewerPayload, 'existing reviewer nonce evidence survives the additive schema upgrade');
});

test('low-level WorkflowStore refuses Plan Graph dispatch even without the MCP handler', () => {
  const job = createJob();
  {
    store.recordEvent(job.job_id, 'job.proposal_requested', {
      task: 'Plan Graph remains review-only',
      adaptive_goal_plan_proposal: { kind: 'adaptive_goal_plan_proposal' }
    }, 'plan-graph-review-wrapper');
    assert.throws(() => store.dispatch(job.job_id, { role: 'cto', description: 'must remain review-only' }),
      /AGG_PLAN_GRAPH_REVIEW_WRAPPER_NOT_DISPATCHABLE/);
    assert.equal(store.getJob(job.job_id).state, 'IDLE');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE job_id=?').get(job.job_id).n, 0);
  }
});

test('low-level WorkflowStore refuses Execution Graph dispatch when typed action intents are absent', () => {
  const job = createJob();
  {
    store.recordEvent(job.job_id, 'job.proposal_requested', {
      task: 'Execution Graph candidate whose typed bindings were stripped',
      adaptive_goal_execution_graph_proposal: { kind: 'adaptive_goal_execution_graph_proposal' }
    }, 'execution-graph-review-wrapper');
    const plan = store.compileExecutionPlan(job.job_id, { workspace: process.cwd() });
    assert.ok(plan.children.length > 0);
    assert.equal(plan.children.some(task => Object.hasOwn(task.execution || {}, 'action_intent')), false);

    const proposalHash = store.getCurrentProposal(job.job_id).proposalHash;
    const stamp = new Date().toISOString();
    store.db.prepare("UPDATE jobs SET state='APPROVED',approved_at=?,updated_at=? WHERE job_id=?")
      .run(stamp, stamp, job.job_id);
    store.db.prepare(`INSERT INTO approvals(approval_id,job_id,decision,actor,raw_text,proposal_hash,created_at)
      VALUES(?,?,'approved',?,?,?,?)`).run('approval-fixture', job.job_id, 'test-only', 'approved for boundary fixture', proposalHash, stamp);

    assert.throws(() => store.dispatch(job.job_id, { role: 'cto', description: 'must fail at store boundary' }),
      /AGG_EXECUTION_GRAPH_ACTION_INTENT_MISSING/);
    assert.equal(store.getJob(job.job_id).state, 'APPROVED');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE job_id=?').get(job.job_id).n, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='task.dispatched'").get(job.job_id).n, 0);
  }
});

test('workflow database keeps approval nonce and policy high-water events append-only', () => {
  const job = createJob('Approval security event immutability regression');
  for (const [type, payload, key] of [
    ['approval.approved', { proposalHash: 'a'.repeat(64) }, 'approval-row'],
    ['adaptive_goal.approval_policy_version_observed', {
      schema_version: 1, policy_id: 'policy-test', policy_version: 1, policy_hash: 'b'.repeat(64),
      nonce: '00000000-0000-4000-8000-000000000001', observed_at: new Date().toISOString()
    }, 'policy-observation'],
    ['adaptive_goal.action_intent_review_authorized', {
      schema_version: 1, provider_id: 'reviewer-provider-test', nonce: '00000000-0000-4000-8000-000000000002'
    }, 'reviewer-observation']
  ]) {
    const eventId = store.recordEvent(job.job_id, type, payload, key);
    assert.throws(() => store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?')
      .run(JSON.stringify({ tampered: true }), eventId), /AGG approval security events are append-only/);
    assert.throws(() => store.db.prepare('DELETE FROM events WHERE event_id=?').run(eventId),
      /AGG approval security events are append-only/);
    store.db.prepare(`INSERT OR REPLACE INTO events(event_id,job_id,type,payload_json,created_at)
      VALUES(?,?,?,?,?)`).run(eventId, job.job_id, type, JSON.stringify({ tampered: true }), new Date().toISOString());
    assert.equal(store.recordEvent(job.job_id, type, payload, key), eventId,
      `${type} exact retries must remain idempotent`);
    assert.equal(store.db.prepare('SELECT payload_json FROM events WHERE event_id=?').get(eventId).payload_json,
      JSON.stringify(payload), `${type} must resist INSERT OR REPLACE and retain its original canonical payload`);
  }
});
