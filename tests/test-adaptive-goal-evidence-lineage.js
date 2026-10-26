import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { validateAdaptiveGoalProducerLineage } from '../src/runtime/adaptive-goal-evidence-lineage.js';

const jobId = 'job_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const taskId = 'task_11111111-1111-4111-8111-111111111111';
const resultId = 'result_22222222-2222-4222-8222-222222222222';
const attemptId = 'attempt_33333333-3333-4333-8333-333333333333';
const baseTime = Date.parse('2026-10-21T10:00:00.000Z');

function fixture(type = 'task.local_completed') {
  const payload = type === 'task.local_completed'
    ? { taskId, resultId, attemptId, executor: 'chat-on-steroids-plugin' }
    : { taskId, resultId, attemptId, runId: 'provider-run-1', sessionKey: null, outcome: 'success', failureClass: null };
  const key = type === 'task.local_completed' ? resultId : `${taskId}|success|${resultId}`;
  const eventId = createHash('sha256').update(`${jobId}|${type}|${key}`).digest('hex');
  return {
    jobId, taskId,
    result: { result_id: resultId, task_id: taskId, outcome: 'success', created_at: new Date(baseTime + 2000).toISOString() },
    completion: { event_id: eventId, job_id: jobId, type, payload, payload_json: JSON.stringify(payload), created_at: new Date(baseTime + 3000).toISOString() },
    attempt: { attempt_id: attemptId, task_id: taskId, status: 'completed', openclaw_run_id: type === 'task.local_completed' ? null : 'provider-run-1', started_at: new Date(baseTime).toISOString(), finished_at: new Date(baseTime + 2500).toISOString(), error: null }
  };
}

test('accepts an exact successful local result → attempt → completion event chain', () => {
  const result = validateAdaptiveGoalProducerLineage(fixture());
  assert.equal(result.valid, true);
  assert.equal(result.attemptId, attemptId);
  assert.equal(result.resultId, resultId);
});

test('accepts a runtime completion only with a matching non-null provider run identity', () => {
  assert.equal(validateAdaptiveGoalProducerLineage(fixture('task.completed')).valid, true);
  const missingProviderRun = fixture('task.completed');
  missingProviderRun.completion.payload.runId = null;
  missingProviderRun.completion.payload_json = JSON.stringify(missingProviderRun.completion.payload);
  missingProviderRun.completion.event_id = createHash('sha256').update(`${jobId}|task.completed|${taskId}|success|${resultId}`).digest('hex');
  missingProviderRun.attempt.openclaw_run_id = null;
  assert.match(validateAdaptiveGoalProducerLineage(missingProviderRun).reason, /provider run identity/);
  const emptyProviderRun = fixture('task.completed');
  emptyProviderRun.completion.payload.runId = '  ';
  emptyProviderRun.completion.payload_json = JSON.stringify(emptyProviderRun.completion.payload);
  emptyProviderRun.completion.event_id = createHash('sha256').update(`${jobId}|task.completed|${taskId}|success|${resultId}`).digest('hex');
  assert.match(validateAdaptiveGoalProducerLineage(emptyProviderRun).reason, /provider run identity/);
  const mismatch = fixture('task.completed');
  mismatch.attempt.openclaw_run_id = 'different-run';
  assert.equal(validateAdaptiveGoalProducerLineage(mismatch).valid, false);
});

test('rejects absent attempt IDs, missing/failed attempts, and failed results', () => {
  const absentAttemptId = fixture();
  absentAttemptId.completion.payload.attemptId = '';
  absentAttemptId.completion.payload_json = JSON.stringify(absentAttemptId.completion.payload);
  assert.match(validateAdaptiveGoalProducerLineage(absentAttemptId).reason, /attempt/);
  const noAttempt = fixture();
  noAttempt.attempt = null;
  assert.equal(validateAdaptiveGoalProducerLineage(noAttempt).valid, false);
  const failedAttempt = fixture();
  failedAttempt.attempt.status = 'failed';
  assert.equal(validateAdaptiveGoalProducerLineage(failedAttempt).valid, false);
  const failedResult = fixture();
  failedResult.result.outcome = 'failure';
  assert.equal(validateAdaptiveGoalProducerLineage(failedResult).valid, false);
});

test('rejects mismatched job/task/result, noncanonical event bytes, and invalid time ordering', () => {
  const wrongJob = fixture(); wrongJob.completion.job_id = 'job_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  assert.equal(validateAdaptiveGoalProducerLineage(wrongJob).valid, false);
  const wrongTask = fixture(); wrongTask.attempt.task_id = 'task_other';
  assert.equal(validateAdaptiveGoalProducerLineage(wrongTask).valid, false);
  const wrongResult = fixture(); wrongResult.completion.payload.resultId = 'result_other';
  assert.equal(validateAdaptiveGoalProducerLineage(wrongResult).valid, false);
  const noncanonical = fixture(); noncanonical.completion.payload_json = '{ "taskId": "x" }';
  assert.equal(validateAdaptiveGoalProducerLineage(noncanonical).valid, false);
  const eventBeforeResult = fixture(); eventBeforeResult.completion.created_at = new Date(baseTime + 1000).toISOString();
  assert.equal(validateAdaptiveGoalProducerLineage(eventBeforeResult).valid, false);
  const resultAfterAttempt = fixture(); resultAfterAttempt.result.created_at = new Date(baseTime + 2600).toISOString();
  assert.match(validateAdaptiveGoalProducerLineage(resultAfterAttempt).reason, /timestamps|ordering/);
  const finishAfterEvent = fixture(); finishAfterEvent.attempt.finished_at = new Date(baseTime + 4000).toISOString();
  assert.equal(validateAdaptiveGoalProducerLineage(finishAfterEvent).valid, false);
});
