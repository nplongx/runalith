import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('workflow-spawn-authorization-');
process.env.WORKFLOW_DATA_DIR = root;
process.env.WORKFLOW_DB = path.join(root, 'workflow.db');

const { WorkflowStore } = await import('../job-store.js');
const { createWorkflowStatePort } = await import('../src/runtime/workflow-state-port.js');
const store = new WorkflowStore();
const state = createWorkflowStatePort(store);

try {
  const job = store.createJob({ conversationKey: 'spawn-authorization-atomicity', title: 'Spawn authorization atomicity' });
  store.approve(job.job_id, 'isolated test approval', 'test-fixture');
  const parent = store.dispatch(job.job_id, { role: 'cto', description: 'spawn authorization parent' });
  const task = store.createChildTask(job.job_id, {
    parentTaskId: parent.task_id,
    role: 'executor',
    description: 'task with a deliberately missing immutable plan',
    metadata: {
      deterministic: true,
      executor: 'ExecutionManager',
      command: 'node --version',
      workflow_plan_task_id: 'missing-plan-task'
    }
  });

  assert.equal(state.version, 2, 'the WorkflowStatePort contract version changes with the atomic command surface');
  assert.equal(typeof state.authorizeExecutionSpawn, 'function');
  assert.equal(typeof state.beginExecutionSpawnAuthorization, 'undefined');
  assert.equal(typeof state.commitExecutionSpawnAuthorization, 'undefined');
  assert.equal(typeof state.rollbackExecutionSpawnAuthorization, 'undefined');
  assert.equal(Object.hasOwn(state, 'db'), false, 'the command must not expose its SQLite connection');

  const before = store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.spawn_authorized'")
    .get(job.job_id).n;
  assert.throws(() => state.authorizeExecutionSpawn({
    taskId: task.task_id,
    boundaryIdentity: { job_id: job.job_id, approval: null, lease: null },
    attempt: 1,
    command: 'node --version',
    cwd: process.cwd(),
    explicitEnv: {},
    timeoutMs: 1000
  }), /immutable execution plan is missing/,
  'an invalid immutable plan must be rejected inside the Workflow-owned authorization command');
  const after = store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.spawn_authorized'")
    .get(job.job_id).n;
  assert.equal(after, before, 'failed authorization must not leave a durable spawn event');

  assert.doesNotThrow(() => {
    store.db.exec('BEGIN IMMEDIATE');
    store.db.exec('ROLLBACK');
  }, 'failed authorization must roll back its writer transaction before returning');
  console.log('Workflow-owned atomic spawn authorization rollback and API boundary PASS');
} finally {
  store.db.close();
}
