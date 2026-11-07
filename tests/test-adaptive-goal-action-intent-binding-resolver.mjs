import assert from 'node:assert/strict';
import { createAdaptiveGoalActionIntentBindingResolver } from '../src/runtime/adaptive-goal-action-intent-binding-resolver.js';

function makePort(events = []) {
  return {
    listEventsForJob: (_jobId, query) => {
      assert.deepEqual(query, { type: 'adaptive_goal.execution_plan_candidate_created' });
      return events;
    },
    getArtifact() { throw new Error('unexpected artifact lookup'); },
    getArtifactStorageRecord() { throw new Error('unexpected storage lookup'); },
    listArtifactCreatedEvents() { throw new Error('unexpected artifact event lookup'); },
    getTask() { throw new Error('unexpected task lookup'); },
    getResult() { throw new Error('unexpected result lookup'); },
    getEvent() { throw new Error('unexpected event lookup'); }
  };
}

const resolver = createAdaptiveGoalActionIntentBindingResolver({
  workflowPort: makePort(),
  verifyCandidateHash: () => { throw new Error('candidate verifier must not run without a candidate event'); },
  assertReviewerAttestation: () => { throw new Error('reviewer verifier must not run without a candidate event'); }
});

assert.deepEqual(resolver('job-without-agg-candidate'), []);
assert.throws(() => resolver('job-without-agg-candidate', [{ taskId: 'task-1' }]),
  /without a persisted reviewed AGG candidate/);

const duplicateResolver = createAdaptiveGoalActionIntentBindingResolver({
  workflowPort: makePort([
    { event_id: 'one', job_id: 'job-1', type: 'adaptive_goal.execution_plan_candidate_created', payload_json: '{}' },
    { event_id: 'two', job_id: 'job-1', type: 'adaptive_goal.execution_plan_candidate_created', payload_json: '{}' }
  ]),
  verifyCandidateHash: () => true,
  assertReviewerAttestation: () => true
});
assert.throws(() => duplicateResolver('job-1'), /multiple reviewed AGG execution-plan candidates/);

const malformedResolver = createAdaptiveGoalActionIntentBindingResolver({
  workflowPort: makePort([{ event_id: 'event-1', job_id: 'job-1', type: 'adaptive_goal.execution_plan_candidate_created', payload_json: '{' }]),
  verifyCandidateHash: () => true,
  assertReviewerAttestation: () => true
});
assert.throws(() => malformedResolver('job-1'), /JSON|parse/i);

assert.throws(() => createAdaptiveGoalActionIntentBindingResolver({
  workflowPort: makePort(), verifyCandidateHash: () => true
}), /assertReviewerAttestation must be a function/);

console.log('AGG action-intent binding resolver boundary PASS');
