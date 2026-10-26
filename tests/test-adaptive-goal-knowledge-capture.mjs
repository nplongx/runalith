import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createAdaptiveGoalKnowledgeStore } from '../src/runtime/adaptive-goal-knowledge-store.js';
import { captureAdaptiveGoalWorkflowOutcome } from '../src/runtime/adaptive-goal-knowledge-capture.js';

const db = new DatabaseSync(':memory:');
const knowledgeStore = createAdaptiveGoalKnowledgeStore(db);
const job = {
  job_id: 'job-123', title: 'Implement bounded search', status: 'completed', state: 'DONE',
  created_at: '2026-10-24T10:00:00.000Z', completed_at: '2026-10-24T10:05:00.000Z'
};
const trace = {
  job,
  tasks: [
    { task_id: 'task-1', role: 'engineer', status: 'completed', description: 'Implement the bounded planner' },
    { task_id: 'task-2', role: 'reviewer', status: 'completed', description: 'Review test evidence' }
  ],
  results: [
    { result_id: 'result-1', task_id: 'task-1', outcome: 'success', content: 'not copied', created_at: '2026-10-24T10:04:00.000Z' },
    { result_id: 'result-2', task_id: 'task-2', outcome: 'partial', content: 'sensitive prose not copied', created_at: '2026-10-24T10:05:00.000Z' }
  ],
  artifacts: [
    { artifact_id: 'artifact-1', task_id: 'task-1', type: 'implementation-summary', status: 'active', content_hash: 'a'.repeat(64), created_at: '2026-10-24T10:04:00.000Z' }
  ]
};
const workflowStore = { getJobTrace: id => id === job.job_id ? trace : null };

try {
  assert.throws(() => captureAdaptiveGoalWorkflowOutcome(null), /input must be an object/);
  assert.throws(() => captureAdaptiveGoalWorkflowOutcome({ goalId: 'goal-a', jobId: job.job_id, extra: true }), /unsupported fields/);
  const node = captureAdaptiveGoalWorkflowOutcome({
    goalId: 'goal-a', jobId: job.job_id, lesson: 'Bound search was easier to review with fixed resource caps.',
    workflowStore, knowledgeStore
  });
  assert.equal(node.type, 'experiment');
  assert.equal(node.revision, 1);
  assert.equal(node.status, 'unverified');
  assert.equal(node.verified, false);
  assert.equal(node.usableForPlanning, false);
  assert.deepEqual(node.memberships, ['goal-a']);
  assert.equal(node.capture.taskCount, 2);
  assert.equal(node.capture.resultCount, 2);
  assert.equal(node.capture.artifactCount, 1);
  assert.equal(node.capture.independentAdjudication, false);
  assert.equal(node.reviewStatus, 'review_required');
  assert.equal(node.content.goalId, 'goal-a');
  assert.equal(node.content.results[0].resultId, 'result-1');
  assert.equal(node.content.artifacts[0].reference, 'workflow://artifacts/artifact-1');
  assert.equal(JSON.stringify(node.content).includes('sensitive prose not copied'), false);
  assert.equal(JSON.stringify(node.content).includes('Implement the bounded planner'), false,
    'task descriptions can contain prompts/secrets and must not be copied');
  assert.equal(JSON.stringify(node.content).includes('Implement bounded search'), false,
    'workflow titles can also contain user-supplied sensitive text');
  assert.deepEqual(node.evidenceRefs, ['workflow://jobs/job-123'],
    'bounded local reference labels remain within Knowledge Store evidenceRefs contract');

  const replay = captureAdaptiveGoalWorkflowOutcome({
    goalId: 'goal-a', jobId: job.job_id, lesson: 'Bound search was easier to review with fixed resource caps.',
    workflowStore, knowledgeStore
  });
  assert.equal(replay.id, node.id);
  assert.equal(replay.revision, 1, 'identical capture should be idempotent');
  const simulatedConcurrentStore = {
    saveNode() {
      const error = new Error('revision conflict: another process committed the initial capture');
      error.code = 'ERR_KNOWLEDGE_REVISION_CONFLICT';
      throw error;
    },
    search: options => knowledgeStore.search(options)
  };
  const concurrentReplay = captureAdaptiveGoalWorkflowOutcome({
    goalId: 'goal-a', jobId: job.job_id, lesson: 'Bound search was easier to review with fixed resource caps.',
    workflowStore, knowledgeStore: simulatedConcurrentStore
  });
  assert.equal(concurrentReplay.id, node.id);
  assert.equal(concurrentReplay.capture.reconciledConcurrentCommit, true,
    'initial capture races reconcile only when the stored content and provenance hashes match');

  const shared = captureAdaptiveGoalWorkflowOutcome({
    goalId: 'goal-b', jobId: job.job_id, lesson: 'Bound search was easier to review with fixed resource caps.',
    workflowStore, knowledgeStore
  });
  assert.notEqual(shared.id, node.id, 'captures are namespaced by goal to avoid implicit cross-goal sharing');
  assert.deepEqual(shared.memberships, ['goal-b']);
  assert.equal(knowledgeStore.search({ goalId: 'goal-b', query: 'resource caps' }).nodes.length, 1);
  assert.equal(knowledgeStore.search({ goalId: 'goal-a' }).nodes[0].id, node.id);
  assert.equal(knowledgeStore.search({ goalId: 'goal-b' }).planning.usableNodeIds.length, 0);

  assert.throws(() => captureAdaptiveGoalWorkflowOutcome({
    goalId: 'goal-a', jobId: job.job_id, lesson: 'Rewritten lesson', workflowStore, knowledgeStore
  }), error => error.code === 'ERR_KNOWLEDGE_REVISION_CONFLICT');
  const revised = captureAdaptiveGoalWorkflowOutcome({
    goalId: 'goal-a', jobId: job.job_id, lesson: 'Rewritten lesson', expectedRevision: 1,
    workflowStore, knowledgeStore
  });
  assert.equal(revised.revision, 2);
  assert.deepEqual(knowledgeStore.history(node.id).map(item => item.revision), [1, 2]);
  assert.equal(revised.usableForPlanning, false, 'revision updates cannot self-verify knowledge');

  assert.throws(() => captureAdaptiveGoalWorkflowOutcome({
    goalId: 'goal-a', jobId: 'missing-job', workflowStore, knowledgeStore
  }), error => error.code === 'ERR_AGG_KNOWLEDGE_CAPTURE_JOB_NOT_FOUND');

  const inconsistentTrace = { ...trace, tasks: trace.tasks.map(task => ({ ...task, job_id: 'another-job' })) };
  assert.throws(() => captureAdaptiveGoalWorkflowOutcome({
    goalId: 'goal-invalid', jobId: job.job_id,
    workflowStore: { getJobTrace: () => inconsistentTrace }, knowledgeStore
  }), /owned by a different job/);

  const duplicateTrace = { ...trace, results: [trace.results[0], trace.results[0]] };
  assert.throws(() => captureAdaptiveGoalWorkflowOutcome({
    goalId: 'goal-invalid', jobId: job.job_id,
    workflowStore: { getJobTrace: () => duplicateTrace }, knowledgeStore
  }), /duplicate result identities/);

  const mismatchedArtifactTrace = { ...trace, artifacts: [{ ...trace.artifacts[0], job_id: 'another-job' }] };
  assert.throws(() => captureAdaptiveGoalWorkflowOutcome({
    goalId: 'goal-invalid', jobId: job.job_id,
    workflowStore: { getJobTrace: () => mismatchedArtifactTrace }, knowledgeStore
  }), /job\/task ownership/);

  const activeTrace = { ...trace, job: { ...job, status: 'active' } };
  const activeStore = { getJobTrace: () => activeTrace };
  assert.throws(() => captureAdaptiveGoalWorkflowOutcome({
    goalId: 'goal-c', jobId: job.job_id, workflowStore: activeStore, knowledgeStore
  }), error => error.code === 'ERR_AGG_KNOWLEDGE_CAPTURE_JOB_NOT_TERMINAL');

  const oversizedTrace = { ...trace, tasks: Array.from({ length: 101 }, (_, i) => ({ task_id: `task-${i}`, status: 'completed' })) };
  assert.throws(() => captureAdaptiveGoalWorkflowOutcome({
    goalId: 'goal-c', jobId: job.job_id, workflowStore: { getJobTrace: () => oversizedTrace }, knowledgeStore
  }), /capture limit/);

  const changingJobStore = {
    getJobTrace: () => trace,
    getJob: () => ({ ...job, status: 'failed' })
  };
  assert.throws(() => captureAdaptiveGoalWorkflowOutcome({
    goalId: 'goal-invalid', jobId: job.job_id, workflowStore: changingJobStore, knowledgeStore
  }), error => error.code === 'ERR_AGG_KNOWLEDGE_CAPTURE_SNAPSHOT_CHANGED');

  assert.throws(() => captureAdaptiveGoalWorkflowOutcome({
    goalId: 'goal-invalid', jobId: job.job_id, lesson: 'x'.repeat(2001), workflowStore, knowledgeStore
  }), /lesson must be/);

  const unicodeLesson = 'Tóm tắt an toàn: không lưu prompt hay hội thoại; dữ liệu đã được xem xét sơ bộ.';
  const unicodeNode = captureAdaptiveGoalWorkflowOutcome({
    goalId: 'goal-unicode', jobId: job.job_id, lesson: unicodeLesson, workflowStore, knowledgeStore
  });
  assert.equal(unicodeNode.content.lesson, unicodeLesson);
  assert.equal(knowledgeStore.search({ goalId: 'goal-unicode', query: 'hội thoại' }).nodes.length, 1);

  const oversizedMetadataTrace = {
    ...trace,
    artifacts: Array.from({ length: 200 }, (_, index) => ({
      artifact_id: `artifact-${String(index).padStart(3, '0')}-` + 'x'.repeat(180),
      task_id: 'task-1', type: 'artifact', status: 'active', content_hash: 'b'.repeat(64)
    }))
  };
  assert.throws(() => captureAdaptiveGoalWorkflowOutcome({
    goalId: 'goal-too-large', jobId: job.job_id,
    workflowStore: { getJobTrace: () => oversizedMetadataTrace }, knowledgeStore
  }), error => error.code === 'ERR_AGG_KNOWLEDGE_CAPTURE_TOO_LARGE');

  // Force a deterministic SQLite write failure and verify transactional rollback.
  db.exec(`CREATE TRIGGER fail_capture_revision BEFORE INSERT ON adaptive_goal_knowledge_revisions
    WHEN NEW.provenance_json LIKE '%adaptive-goal-knowledge-capture%'
    BEGIN SELECT RAISE(ABORT, 'test db failure'); END;`);
  assert.throws(() => captureAdaptiveGoalWorkflowOutcome({
    goalId: 'goal-db-failure', jobId: job.job_id, workflowStore, knowledgeStore
  }), /test db failure/);
  db.exec('DROP TRIGGER fail_capture_revision');
  assert.equal(knowledgeStore.search({ goalId: 'goal-db-failure' }).nodes.length, 0,
    'failed revision insert must not leave a partial knowledge node/membership');
  const retriedAfterDbFailure = captureAdaptiveGoalWorkflowOutcome({
    goalId: 'goal-db-failure', jobId: job.job_id, workflowStore, knowledgeStore
  });
  assert.equal(retriedAfterDbFailure.revision, 1, 'a failed transaction can be safely retried with the same request');

  for (const terminalStatus of ['failed', 'cancelled']) {
    const terminalJobId = `job-${terminalStatus}`;
    const terminalTrace = {
      ...trace,
      job: { ...job, job_id: terminalJobId, status: terminalStatus, state: terminalStatus.toUpperCase() },
      tasks: trace.tasks.map((task, index) => ({
        ...task, task_id: `${terminalJobId}-${index}`,
        status: terminalStatus === 'failed' ? (index === 0 ? 'failed' : 'cancelled') : (index === 0 ? 'cancelled' : 'pending')
      })),
      results: [],
      artifacts: []
    };
    const terminalCapture = captureAdaptiveGoalWorkflowOutcome({
      goalId: `goal-${terminalStatus}`, jobId: terminalJobId,
      workflowStore: { getJobTrace: () => terminalTrace }, knowledgeStore
    });
    assert.equal(terminalCapture.content.terminalStatus, terminalStatus);
    assert.equal(terminalCapture.status, 'unverified');
  }

  console.log('adaptive goal knowledge capture tests passed');
} finally {
  db.close();
}
