#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rustRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(rustRoot, '..');
const defaultOutput = path.join(rustRoot, 'crates/runalith-domain/tests/fixtures/node-runnable-task-v1.json');
const outputPath = path.resolve(process.argv[2] || defaultOutput);
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runalith-node-runnable-task-'));

process.env.NODE_ENV = 'test';
process.env.WORKFLOW_DATA_DIR = temporaryRoot;
process.env.WORKFLOW_DB = path.join(temporaryRoot, 'workflow.db');

const { WorkflowStore } = await import(pathToFileURL(path.join(repositoryRoot, 'job-store.js')).href);
const store = new WorkflowStore();

const taskNames = new Map();
const jobNames = new Map();
const scenarios = [
  { name: 'pending-oldest', status: 'pending', createdAt: '2026-01-01T00:00:01.000Z' },
  { name: 'pending-newer', status: 'pending', createdAt: '2026-01-01T00:00:02.000Z' },
  { name: 'pending-terminal-parent', status: 'pending', parentStatus: 'completed', parentState: 'COMPLETED', createdAt: '2026-01-01T00:00:03.000Z' },
  { name: 'pending-unresolved-dependency', status: 'pending', dependencies: ['missing-prerequisite'], createdAt: '2026-01-01T00:00:04.000Z' },
  { name: 'pending-active-lease', status: 'pending', activeLease: true, createdAt: '2026-01-01T00:00:05.000Z' },
  { name: 'pending-expired-active-lease', status: 'pending', activeLease: true, expiredActiveLease: true, createdAt: '2026-01-01T00:00:06.000Z' },
  { name: 'running', status: 'running', createdAt: '2026-01-01T00:00:07.000Z' },
  { name: 'failed', status: 'failed', createdAt: '2026-01-01T00:00:08.000Z' },
  { name: 'completed', status: 'completed', createdAt: '2026-01-01T00:00:09.000Z' },
  { name: 'cancelled', status: 'cancelled', createdAt: '2026-01-01T00:00:10.000Z' },
  { name: 'other-job-pending', status: 'pending', createdAt: '2026-01-01T00:00:11.000Z' },
  { name: 'fifo-old-task-recent-workflow', status: 'pending', createdAt: '2026-01-01T00:00:12.000Z', parentUpdatedAt: '2026-01-01T00:00:20.000Z' },
  { name: 'fifo-new-task-old-workflow', status: 'pending', createdAt: '2026-01-01T00:00:13.000Z', parentUpdatedAt: '2026-01-01T00:00:01.000Z' }
];

function createScenario(scenario) {
  const job = store.createJob({
    conversationKey: `node-runnable-task-${scenario.name}-${process.pid}`,
    title: `Node runnable-task projection ${scenario.name}`
  });
  const task = store.dispatch(job.job_id, {
    role: 'worker',
    description: `runnable-task oracle scenario ${scenario.name}`
  });
  taskNames.set(task.task_id, scenario.name);
  jobNames.set(job.job_id, `job-${scenario.name}`);

  store.db.prepare(`UPDATE tasks SET status=?,created_at=?,updated_at=?,dependency_json=? WHERE task_id=?`)
    .run(scenario.activeLease ? 'running' : scenario.status,
      scenario.createdAt, scenario.createdAt, JSON.stringify(scenario.dependencies || []), task.task_id);

  if (scenario.activeLease) {
    store.acquireTaskLease(task.task_id, {
      leaseId: `runnable-task-lease-${scenario.name}-${process.pid}`,
      workerId: 'runnable-task-oracle-worker',
      ttlMs: 60_000,
      attempt: 1
    });
    if (scenario.expiredActiveLease) {
      store.db.prepare('UPDATE task_leases SET expires_at=? WHERE task_id=? AND state=\'ACTIVE\'')
        .run('2026-01-01T00:00:00.000Z', task.task_id);
    }
    // Isolate the candidate-list predicate from lease acquisition's task-state
    // projection. The active lease remains durable and visible to the query.
    store.db.prepare("UPDATE tasks SET status='pending',created_at=? WHERE task_id=?")
      .run(scenario.createdAt, task.task_id);
  }

  if (scenario.parentStatus || scenario.parentState) {
    store.db.prepare('UPDATE jobs SET status=?,state=? WHERE job_id=?')
      .run(scenario.parentStatus || 'active', scenario.parentState || 'EXECUTING', job.job_id);
  }
  if (scenario.parentUpdatedAt) {
    store.db.prepare('UPDATE jobs SET updated_at=? WHERE job_id=?')
      .run(scenario.parentUpdatedAt, job.job_id);
  } else {
    // Make the diagnostic workflow timestamp deterministic too; it is not
    // consumed by listRunnableTasks, but it is needed for the fairness contrast.
    store.db.prepare('UPDATE jobs SET updated_at=? WHERE job_id=?')
      .run(scenario.createdAt, job.job_id);
  }
  return { jobId: job.job_id, taskId: task.task_id };
}

try {
  const ids = new Map();
  for (const scenario of scenarios) ids.set(scenario.name, createScenario(scenario));

  const rows = store.db.prepare(`SELECT t.rowid,t.task_id,t.job_id,t.status,t.created_at,
      j.status AS parent_status,j.state AS parent_state,j.updated_at AS parent_updated_at,t.dependency_json,
      EXISTS(SELECT 1 FROM task_leases l WHERE l.task_id=t.task_id AND l.state='ACTIVE') AS has_active_lease,
      EXISTS(SELECT 1 FROM task_leases l WHERE l.task_id=t.task_id AND l.state='ACTIVE' AND l.expires_at<=?) AS has_expired_active_lease
    FROM tasks t JOIN jobs j ON j.job_id=t.job_id ORDER BY t.rowid ASC`).all('2026-01-01T00:00:00.000Z')
    .map(row => ({
      row_order: Number(row.rowid),
      task_id: taskNames.get(row.task_id),
      job_id: jobNames.get(row.job_id),
      status: row.status,
      created_at: row.created_at,
      parent_status: row.parent_status,
      parent_state: row.parent_state,
      parent_updated_at: row.parent_updated_at,
      has_active_lease: Boolean(row.has_active_lease),
      has_expired_active_lease: Boolean(row.has_expired_active_lease),
      has_unmet_dependencies: JSON.parse(row.dependency_json || '[]').length > 0
    }));

  const querySpecs = [
    { name: 'all-candidates', query: { limit: 100 } },
    { name: 'oldest-three', query: { limit: 3 } },
    { name: 'zero-limit', query: { limit: 0 } },
    { name: 'terminal-parent-only', query: { jobId: 'job-pending-terminal-parent', limit: 100 } },
    { name: 'other-job-only', query: { jobId: 'job-other-job-pending', limit: 100 } },
    { name: 'unknown-job', query: { jobId: 'job-does-not-exist', limit: 100 } },
    { name: 'one-row', query: { limit: 1 } }
  ];

  const cases = querySpecs.map(({ name, query }) => {
    const actual = store.listRunnableTasks({
      ...(query.jobId ? { jobId: ids.get(query.jobId.slice(4))?.jobId || query.jobId } : {}),
      limit: query.limit
    }).map(task => taskNames.get(task.task_id));
    return { name, query, expected_task_ids: actual };
  });

  const fixture = {
    schema_version: 1,
    generated_by_node: true,
    source: 'src/runtime/job-store.js::WorkflowStore.listRunnableTasks',
    note: 'Models only the Node read-only runnable-task candidate query. Parent state, dependency readiness and lease expiry are recorded as context but are not predicates in that SQL query; acquireTaskLease applies a separate transactional parent/attempt/owner-epoch fence.',
    rows,
    cases
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o644 });
  console.log(JSON.stringify({
    output: outputPath,
    rows: rows.length,
    scenarios: Object.fromEntries(rows.map(row => [row.task_id, {
      status: row.status,
      parent_state: row.parent_state,
      active_lease: row.has_active_lease,
      expired_active_lease: row.has_expired_active_lease,
      unmet_dependencies: row.has_unmet_dependencies
    }])),
    cases: cases.map(item => ({ name: item.name, expected_task_ids: item.expected_task_ids }))
  }, null, 2));
} finally {
  store.db.close();
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
