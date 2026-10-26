import { createHash } from 'node:crypto';

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const LIMITS = Object.freeze({ tasks: 100, results: 200, artifacts: 200 });
const MAX_CAPTURE_BYTES = 60 * 1024;
const TASK_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'cancelled']);
const RESULT_OUTCOMES = new Set(['success', 'failure', 'partial']);
const REVIEW_STATUS = 'review_required';

function fail(message, code = 'ERR_AGG_KNOWLEDGE_CAPTURE_INVALID') {
  const error = new Error(`AdaptiveGoalKnowledgeCapture: ${message}`);
  error.code = code;
  throw error;
}

function requiredText(value, field, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    fail(`${field} must be a non-empty string up to ${max} characters`);
  }
  return value.trim();
}

function boundedRows(value, field, max) {
  if (!Array.isArray(value)) fail(`workflow trace ${field} must be an array`);
  if (value.length > max) fail(`workflow trace ${field} exceeds the ${max}-record capture limit`);
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateRows(rows, field, predicate, description) {
  if (rows.some((row, index) => !isRecord(row) || !predicate(row))) {
    fail(`workflow trace contains a malformed ${field} record (${description})`);
  }
}

function countBy(rows, field) {
  const counts = {};
  for (const row of rows) counts[row[field]] = (counts[row[field]] || 0) + 1;
  return counts;
}

function formatCounts(counts) {
  return Object.keys(counts).sort().map(key => `${key}=${counts[key]}`).join(', ') || 'none';
}

function uniqueStrings(values, field) {
  if (values.some(value => typeof value !== 'string' || !value.trim())) fail(`${field} contains an invalid string`);
  return [...new Set(values.map(value => value.trim()))].sort();
}

function ensureUnique(values, field) {
  if (new Set(values).size !== values.length) fail(`workflow trace contains duplicate ${field} identities`);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function canonicalHash(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex');
}

/**
 * Capture a terminal local workflow as an unverified Idea Graph experiment.
 * The durable record metadata is derived from the workflow store; an optional
 * lesson is caller-authored and deliberately remains unverified.
 */
export function captureAdaptiveGoalWorkflowOutcome(input) {
  if (!isRecord(input)) fail('input must be an object');
  const allowedInputKeys = ['goalId', 'jobId', 'lesson', 'expectedRevision', 'workflowStore', 'knowledgeStore'];
  const unknownInputKeys = Object.keys(input).filter(key => !allowedInputKeys.includes(key));
  if (unknownInputKeys.length) fail(`input contains unsupported fields: ${unknownInputKeys.sort().join(', ')}`);
  const { goalId, jobId, lesson, workflowStore, knowledgeStore } = input;
  const expectedRevision = input.expectedRevision === undefined ? 0 : input.expectedRevision;
  const normalizedGoalId = requiredText(goalId, 'goalId');
  const normalizedJobId = requiredText(jobId, 'jobId', 200);
  if (lesson !== undefined && (typeof lesson !== 'string' || !lesson.trim() || lesson.trim().length > 2000)) {
    fail('lesson must be a non-empty string up to 2000 characters when supplied');
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    fail('expectedRevision must be a non-negative safe integer');
  }
  if (!workflowStore || typeof workflowStore.getJobTrace !== 'function') fail('workflowStore must expose getJobTrace(jobId)');
  if (!knowledgeStore || typeof knowledgeStore.saveNode !== 'function') fail('knowledgeStore must expose saveNode(input)');

  const trace = workflowStore.getJobTrace(normalizedJobId);
  if (!trace || !trace.job || trace.job.job_id !== normalizedJobId) {
    fail(`workflow job not found: ${normalizedJobId}`, 'ERR_AGG_KNOWLEDGE_CAPTURE_JOB_NOT_FOUND');
  }
  if (!TERMINAL_JOB_STATUSES.has(trace.job.status)) {
    fail('only terminal workflows (completed, failed, cancelled) can be captured', 'ERR_AGG_KNOWLEDGE_CAPTURE_JOB_NOT_TERMINAL');
  }
  const assertTerminalSnapshotStable = () => {
    if (!workflowStore.getJob) return;
    const currentJob = workflowStore.getJob(normalizedJobId);
    if (!currentJob || currentJob.job_id !== normalizedJobId) {
      fail(`workflow job disappeared during capture: ${normalizedJobId}`, 'ERR_AGG_KNOWLEDGE_CAPTURE_JOB_NOT_FOUND');
    }
    if (currentJob.status !== trace.job.status || currentJob.state !== trace.job.state ||
        (currentJob.completed_at ?? null) !== (trace.job.completed_at ?? null) ||
        (currentJob.updated_at ?? null) !== (trace.job.updated_at ?? null)) {
      fail('workflow terminal identity changed while capture was reading the durable trace; retry the capture',
        'ERR_AGG_KNOWLEDGE_CAPTURE_SNAPSHOT_CHANGED');
    }
  };
  assertTerminalSnapshotStable();

  const tasks = boundedRows(trace.tasks, 'tasks', LIMITS.tasks);
  const results = boundedRows(trace.results, 'results', LIMITS.results);
  const artifacts = boundedRows(trace.artifacts, 'artifacts', LIMITS.artifacts);
  validateRows(tasks, 'task', task => typeof task.task_id === 'string' && task.task_id.trim().length > 0 && task.task_id.length <= 200 &&
    TASK_STATUSES.has(task.status) && typeof task.role === 'string' && task.role.trim().length > 0 && task.role.length <= 100,
  'task identity, role, or status is invalid');
  ensureUnique(tasks.map(task => task.task_id), 'task');
  if (tasks.some(task => task.job_id !== undefined && task.job_id !== normalizedJobId)) {
    fail('workflow trace contains a task owned by a different job');
  }
  const taskIds = new Set(tasks.map(task => task.task_id));
  validateRows(results, 'result', result => typeof result.result_id === 'string' && result.result_id.trim().length > 0 &&
    result.result_id.length <= 200 && taskIds.has(result.task_id) && RESULT_OUTCOMES.has(result.outcome) &&
    (result.job_id === undefined || result.job_id === normalizedJobId) &&
    (result.created_at === undefined || result.created_at === null || (typeof result.created_at === 'string' && result.created_at.length <= 64)),
  'result identity, outcome, timestamp, or job/task ownership is invalid');
  ensureUnique(results.map(result => result.result_id), 'result');
  validateRows(artifacts, 'artifact', artifact => typeof artifact.artifact_id === 'string' && artifact.artifact_id.trim().length > 0 &&
    artifact.artifact_id.length <= 200 && (artifact.task_id === null || artifact.task_id === undefined || taskIds.has(artifact.task_id)) &&
    (artifact.job_id === undefined || artifact.job_id === normalizedJobId) &&
    (artifact.type === undefined || (typeof artifact.type === 'string' && artifact.type.length <= 100)) &&
    (artifact.status === undefined || (typeof artifact.status === 'string' && artifact.status.length <= 100)) &&
    (artifact.content_hash === undefined || artifact.content_hash === null || /^[a-f0-9]{64}$/.test(artifact.content_hash)) &&
    (artifact.created_at === undefined || artifact.created_at === null || (typeof artifact.created_at === 'string' && artifact.created_at.length <= 64)),
  'artifact identity, status, or job/task ownership is invalid');
  ensureUnique(artifacts.map(artifact => artifact.artifact_id), 'artifact');

  // Keep only stable identifiers, status metadata, and roles. Task descriptions
  // can contain prompts or secrets, so do not copy them into shared knowledge.
  const capturedTasks = tasks.map(task => ({
    taskId: task.task_id,
    role: task.role.trim(),
    status: task.status
  }));
  const capturedResults = results.map(result => ({
    resultId: result.result_id,
    reference: `workflow://results/${encodeURIComponent(result.result_id)}`,
    taskId: result.task_id,
    outcome: result.outcome,
    createdAt: result.created_at || null
  }));
  const capturedArtifacts = artifacts.map(artifact => ({
    artifactId: artifact.artifact_id,
    reference: `workflow://artifacts/${encodeURIComponent(artifact.artifact_id)}`,
    taskId: artifact.task_id || null,
    type: String(artifact.type || artifact.kind || 'unknown').slice(0, 100),
    status: typeof artifact.status === 'string' ? artifact.status : 'unknown',
    contentHash: typeof artifact.content_hash === 'string' ? artifact.content_hash : null,
    createdAt: artifact.created_at || null
  }));

  // Keep evidenceRefs within the Knowledge Store's 64-reference contract. The
  // entire bounded set of result/artifact references remains in content.
  const workflowRef = `workflow://jobs/${encodeURIComponent(normalizedJobId)}`;
  const evidenceRefs = [workflowRef];
  const taskStatusCounts = countBy(capturedTasks, 'status');
  const resultOutcomeCounts = countBy(capturedResults, 'outcome');
  const artifactStatusCounts = countBy(capturedArtifacts, 'status');
  const taskRoles = uniqueStrings(capturedTasks.map(task => task.role), 'task roles');
  const summary = `Captured ${trace.job.status} workflow ${normalizedJobId}; tasks: ${formatCounts(taskStatusCounts)}; results: ${formatCounts(resultOutcomeCounts)}; artifacts: ${formatCounts(artifactStatusCounts)}. Review the lesson and source records before reuse.`;
  const content = {
    schemaVersion: 1,
    recordType: 'workflow_outcome_capture',
    goalId: normalizedGoalId,
    jobId: normalizedJobId,
    workflowRef,
    terminalStatus: trace.job.status,
    reviewStatus: REVIEW_STATUS,
    finalState: typeof trace.job.state === 'string' ? trace.job.state : null,
    createdAt: trace.job.created_at || null,
    completedAt: trace.job.completed_at || null,
    taskStatusCounts,
    resultOutcomeCounts,
    artifactStatusCounts,
    taskRoles,
    tasks: capturedTasks,
    results: capturedResults,
    artifacts: capturedArtifacts,
    ...(lesson === undefined ? {} : { lesson: lesson.trim(), lessonAuthorship: 'caller_supplied_unverified' })
  };
  const captureBytes = Buffer.byteLength(JSON.stringify({ content, evidenceRefs }), 'utf8');
  if (captureBytes > MAX_CAPTURE_BYTES) {
    fail(`capture metadata exceeds ${MAX_CAPTURE_BYTES} UTF-8 bytes; reduce workflow size or capture a smaller workflow`, 'ERR_AGG_KNOWLEDGE_CAPTURE_TOO_LARGE');
  }
  const stableKey = `workflow-outcome:${createHash('sha256').update(`${normalizedGoalId}\0${normalizedJobId}`).digest('hex')}`;
  const provenance = {
    source: 'local-workflow-store',
    actor: 'adaptive-goal-knowledge-capture',
    reference: workflowRef,
    note: 'Derived from terminal durable workflow records; not an independent adjudication or proof of correctness.'
  };
  const expectedContentHash = canonicalHash({ content, evidenceRefs });
  const expectedProvenanceHash = canonicalHash(provenance);

  let node;
  let reconciledConcurrentCommit = false;
  try {
    assertTerminalSnapshotStable();
    node = knowledgeStore.saveNode({
      goalId: normalizedGoalId,
      stableKey,
      type: 'experiment',
      content,
      provenance,
      expectedRevision,
      evidenceRefs
    });
  } catch (error) {
    // A different MCP process may have committed the exact same initial
    // request after our pre-transaction read. Re-read within the same goal
    // and reconcile only if the stored content + provenance hashes match.
    if (error?.code === 'ERR_KNOWLEDGE_REVISION_CONFLICT' && expectedRevision === 0 &&
        typeof knowledgeStore.search === 'function') {
      const existing = knowledgeStore.search({
        goalId: normalizedGoalId, type: 'experiment', query: normalizedJobId,
        includeUnverified: true, limit: 500
      }).nodes.find(candidate => candidate.stableKey === stableKey &&
        candidate.contentHash === expectedContentHash && candidate.provenanceHash === expectedProvenanceHash);
      if (existing) {
        node = existing;
        reconciledConcurrentCommit = true;
      } else {
        throw error;
      }
    } else {
    // Preserve the store's CAS identity for callers; add an actionable capture
    // code only when SQLite exposes a transient lock/busy failure.
      const message = String(error?.message || '');
      const databaseFailure = /^ERR_SQLITE/i.test(String(error?.code || '')) || Number.isInteger(error?.errcode) ||
        Number.isInteger(error?.sqliteErrorCode) || /sqlite|database is (?:locked|busy)/i.test(message);
      if (databaseFailure) error.captureDatabaseFailure = true;
      if (error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED' || error?.errcode === 5 || error?.errcode === 6 ||
          /database is (?:locked|busy)/i.test(message)) {
        error.captureRetryable = true;
      }
      throw error;
    }
  }

  return {
    ...node,
    capture: {
      source: 'local-workflow-store',
      scope: 'goal_local',
      taskCount: capturedTasks.length,
      resultCount: capturedResults.length,
      artifactCount: capturedArtifacts.length,
      taskStatusCounts,
      resultOutcomeCounts,
      artifactStatusCounts,
      stableKey,
      lessonSupplied: lesson !== undefined,
      reconciledConcurrentCommit,
      independentAdjudication: false
    },
    verified: false,
    usableForPlanning: false,
    reviewStatus: REVIEW_STATUS,
    executionAuthorized: false,
    dispatchAllowed: false,
    summary,
    note: 'Captured terminal workflow metadata and optional caller-authored lesson. The record remains unverified and review-only; result/artifact references are identifiers, not independently verified evidence.'
  };
}
