import { createHash } from 'node:crypto';

const COMPLETION_TYPES = new Set(['task.completed', 'task.local_completed']);

function invalid(reason) {
  return { valid: false, reason };
}

function timestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Validate the durable producer-result -> attempt -> completion-event chain
 * used by AGG evidence resolution. This is intentionally stricter than legacy
 * workflow display/terminalization: evidence cannot rely on a completion event
 * with no attempt identity, an unsuccessful attempt, or a timestamp inversion.
 */
export function validateAdaptiveGoalProducerLineage({ jobId, taskId, result, completion, attempt }) {
  if (typeof jobId !== 'string' || !jobId.trim() || typeof taskId !== 'string' || !taskId.trim()) {
    return invalid('producer job/task identity is missing');
  }
  if (!result || typeof result !== 'object' || result.task_id !== taskId || result.outcome !== 'success' ||
      typeof result.result_id !== 'string' || !result.result_id.trim()) {
    return invalid('producer result identity/task/outcome is invalid');
  }
  const resultCreatedAt = timestamp(result.created_at);
  if (resultCreatedAt === null) return invalid('producer result creation timestamp is invalid');
  if (!completion || typeof completion !== 'object' || !COMPLETION_TYPES.has(completion.type) ||
      completion.job_id !== jobId || typeof completion.event_id !== 'string' || !completion.event_id.trim()) {
    return invalid('producer completion event identity/type is invalid');
  }
  const payload = completion.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      payload.taskId !== taskId || payload.resultId !== result.result_id ||
      typeof completion.payload_json !== 'string' || completion.payload_json !== JSON.stringify(payload)) {
    return invalid('producer completion event payload does not bind canonical task/result bytes');
  }
  const eventTime = timestamp(completion.created_at);
  if (eventTime === null || eventTime < resultCreatedAt) {
    return invalid('completion event is missing or precedes the durable producer result');
  }
  const expectedKey = completion.type === 'task.local_completed'
    ? result.result_id
    : `${taskId}|success|${result.result_id}`;
  const expectedEventId = createHash('sha256').update(`${jobId}|${completion.type}|${expectedKey}`).digest('hex');
  if (completion.event_id !== expectedEventId) return invalid('completion event deterministic identity is invalid');

  let expectedAttemptKeys;
  if (completion.type === 'task.local_completed') {
    expectedAttemptKeys = 'attemptId,executor,resultId,taskId';
    if (Object.keys(payload).sort().join(',') !== expectedAttemptKeys ||
        payload.executor !== 'chat-on-steroids-plugin') {
      return invalid('local completion event schema or executor is invalid');
    }
  } else {
    expectedAttemptKeys = 'attemptId,failureClass,outcome,resultId,runId,sessionKey,taskId';
    if (Object.keys(payload).sort().join(',') !== expectedAttemptKeys || payload.outcome !== 'success' ||
        payload.failureClass !== null || typeof payload.runId !== 'string' || !payload.runId.trim() ||
        (payload.sessionKey !== null && typeof payload.sessionKey !== 'string')) {
      return invalid('runtime completion event schema, provider run identity, or outcome is invalid');
    }
  }
  if (typeof payload.attemptId !== 'string' || !payload.attemptId.trim()) {
    return invalid('successful producer completion must name an exact durable attempt');
  }
  if (!attempt || attempt.attempt_id !== payload.attemptId || attempt.task_id !== taskId || attempt.status !== 'completed' || attempt.error != null) {
    return invalid('completion event attempt does not bind the completed producer task');
  }
  const startedAt = timestamp(attempt.started_at);
  const finishedAt = timestamp(attempt.finished_at);
  if (startedAt === null || finishedAt === null || finishedAt < startedAt ||
      startedAt > resultCreatedAt || resultCreatedAt > finishedAt || finishedAt > eventTime) {
    return invalid('producer attempt timestamps are invalid or inconsistent with result/completion ordering');
  }
  if (completion.type === 'task.local_completed') {
    if (attempt.openclaw_run_id != null) return invalid('local completion attempt unexpectedly binds a remote run');
  } else if (typeof attempt.openclaw_run_id !== 'string' || !attempt.openclaw_run_id.trim() || attempt.openclaw_run_id !== payload.runId) {
    return invalid('runtime completion run ID does not match its durable attempt');
  }
  return { valid: true, attemptId: attempt.attempt_id, resultId: result.result_id, completionEventId: completion.event_id };
}
