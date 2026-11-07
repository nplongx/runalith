import { createHash } from 'node:crypto';
import { canonicalJson, validateExecutionPlan } from './workflow-plan-public-api.js';
import { validateArtifact } from './workflow-contracts-public-api.js';
import { parseStrictJson } from './strict-json.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const eventId = (jobId, type, entity) => sha256(`${jobId}|${type}|${entity}`);

function requiredFunction(owner, name, label) {
  if (typeof owner?.[name] !== 'function') throw new TypeError(`${label}.${name} must be a function`);
  return owner[name].bind(owner);
}

function assertActionIntentEvidenceCurrent(workflowPort, bindings) {
  for (const binding of bindings) for (const input of binding.actionIntent.task_input_bindings || []) {
    const source = input.source;
    if (source?.kind !== 'evidence') continue;
    const artifact = workflowPort.getArtifact(source.artifact_id);
    if (!artifact || artifact.job_id !== source.source_job_id || artifact.status !== 'active' ||
        artifact.type !== input.input_type || source.input_type !== input.input_type ||
        artifact.schema_version !== source.schema_version || artifact.content_hash !== source.content_hash ||
        artifact.producer_role !== source.producer_role || artifact.task_id !== source.producer_task_id) {
      throw new Error(`AGG action-intent source evidence is stale or mismatched: ${source.reference || source.artifact_id}`);
    }
    validateArtifact(artifact);
    const storage = workflowPort.getArtifactStorageRecord(artifact.artifact_id);
    if (storage?.uri !== `artifact://${artifact.artifact_id}` ||
        storage?.metadata_json !== JSON.stringify({ schema_version: artifact.schema_version })) {
      throw new Error(`AGG action-intent source artifact metadata is not canonical: ${artifact.artifact_id}`);
    }
    const creationRows = workflowPort.listArtifactCreatedEvents(artifact.job_id, artifact.artifact_id);
    const creationPayload = { artifactId: artifact.artifact_id, taskId: artifact.task_id, type: artifact.type,
      status: artifact.status, supersedes: artifact.supersedes, contentHash: artifact.content_hash };
    if (creationRows.length !== 1 || creationRows[0].event_id !== source.artifact_created_event_id ||
        creationRows[0].event_id !== eventId(artifact.job_id, 'artifact.created', artifact.artifact_id) ||
        creationRows[0].job_id !== artifact.job_id || creationRows[0].type !== 'artifact.created' ||
        creationRows[0].payload_json !== JSON.stringify(creationPayload)) {
      throw new Error(`AGG action-intent source artifact creation lineage changed: ${artifact.artifact_id}`);
    }
    const task = workflowPort.getTask(source.producer_task_id);
    const result = workflowPort.getResult(source.producer_result_id);
    if (!task || task.job_id !== artifact.job_id || task.status !== 'completed' || task.role !== source.producer_role ||
        !result || result.task_id !== task.task_id || result.outcome !== 'success' || source.producer_result_outcome !== 'success' ||
        !Array.isArray(artifact.evidence) || !artifact.evidence.includes(result.result_id)) {
      throw new Error(`AGG action-intent source producer result is no longer successful/current: ${artifact.artifact_id}`);
    }
    const completion = workflowPort.getEvent(source.producer_completion_event_id);
    if (!completion || completion.job_id !== artifact.job_id || completion.type !== source.producer_completion_event_type ||
        !['task.completed', 'task.local_completed'].includes(completion.type) ||
        completion.event_id !== eventId(artifact.job_id, completion.type,
          completion.type === 'task.local_completed' ? result.result_id : `${task.task_id}|success|${result.result_id}`)) {
      throw new Error(`AGG action-intent source producer completion event is invalid: ${artifact.artifact_id}`);
    }
    const completionPayload = parseStrictJson(completion.payload_json, 'AGG action-intent producer completion event');
    if (completionPayload.taskId !== task.task_id || completionPayload.resultId !== result.result_id ||
        completion.payload_json !== JSON.stringify(completionPayload) ||
        (completion.type === 'task.local_completed'
          ? (Object.keys(completionPayload).sort().join(',') !== 'attemptId,executor,resultId,taskId' || completionPayload.executor !== 'chat-on-steroids-plugin')
          : (Object.keys(completionPayload).sort().join(',') !== 'attemptId,failureClass,outcome,resultId,runId,sessionKey,taskId' ||
            completionPayload.outcome !== 'success' || completionPayload.failureClass !== null))) {
      throw new Error(`AGG action-intent source producer completion payload is invalid: ${artifact.artifact_id}`);
    }
    if (Buffer.byteLength(canonicalJson(artifact.content), 'utf8') > 64 * 1024) {
      throw new Error(`AGG action-intent source artifact exceeds the 64 KiB host-task context limit: ${artifact.artifact_id}`);
    }
  }
}

/**
 * AGG-owned interpretation of the persisted review-only candidate event.
 * Workflow supplies only bounded state/evidence query APIs and never parses
 * AGG event payloads or owns candidate/reviewer validation semantics.
 */
export function createAdaptiveGoalActionIntentBindingResolver({
  workflowPort,
  verifyCandidateHash,
  assertReviewerAttestation
} = {}) {
  const port = {
    listEventsForJob: requiredFunction(workflowPort, 'listEventsForJob', 'workflowPort'),
    getArtifact: requiredFunction(workflowPort, 'getArtifact', 'workflowPort'),
    getArtifactStorageRecord: requiredFunction(workflowPort, 'getArtifactStorageRecord', 'workflowPort'),
    listArtifactCreatedEvents: requiredFunction(workflowPort, 'listArtifactCreatedEvents', 'workflowPort'),
    getTask: requiredFunction(workflowPort, 'getTask', 'workflowPort'),
    getResult: requiredFunction(workflowPort, 'getResult', 'workflowPort'),
    getEvent: requiredFunction(workflowPort, 'getEvent', 'workflowPort')
  };
  const verify = requiredFunction({ verifyCandidateHash }, 'verifyCandidateHash', 'AGG verifier');
  const verifyReviewer = requiredFunction({ assertReviewerAttestation }, 'assertReviewerAttestation', 'AGG reviewer verifier');

  return function resolveAdaptiveGoalActionIntentBindings(jobId, requestedBindings = undefined) {
    const rows = port.listEventsForJob(jobId, { type: 'adaptive_goal.execution_plan_candidate_created' });
    if (rows.length === 0) {
      if (Array.isArray(requestedBindings) && requestedBindings.length) {
        throw new Error('action-intent bindings were supplied without a persisted reviewed AGG candidate');
      }
      return [];
    }
    if (rows.length !== 1) throw new Error('multiple reviewed AGG execution-plan candidates exist; refusing to select action-intent bindings');
    const row = rows[0];
    const payload = parseStrictJson(row.payload_json, 'persisted AGG execution-plan candidate');
    const candidate = payload?.candidate;
    if (row.job_id !== jobId || row.type !== 'adaptive_goal.execution_plan_candidate_created' ||
        row.payload_json !== JSON.stringify(payload) || payload?.schema_version !== 2 ||
        Object.keys(payload).sort().join(',') !== 'candidate,candidate_hash,fingerprint,reviewed_action_intents,schema_version' ||
        typeof payload.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(payload.fingerprint) ||
        payload.candidate_hash !== candidate?.candidateHash || candidate?.fingerprint !== payload.fingerprint ||
        !verify(candidate) || candidate.executionPlan?.job_id !== jobId ||
        candidate.compiler?.compilerPlanHash !== candidate.executionPlan?.plan_hash ||
        row.event_id !== eventId(jobId, row.type, payload.fingerprint)) {
      throw new Error('persisted AGG action-intent candidate failed canonical event, plan-hash, or candidate-hash validation');
    }
    validateExecutionPlan(candidate.executionPlan);
    const bindings = candidate.executionPlan.children.filter(task => Object.hasOwn(task.execution || {}, 'action_intent'))
      .map(task => ({ taskId: task.id, role: task.role,
        roleContractId: task.execution.action_intent.role_contract_id,
        roleContractVersion: task.execution.action_intent.role_contract_version,
        actionIntent: task.execution.action_intent
      })).sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
    if (sha256(canonicalJson(bindings)) !== candidate.hashes?.compilerActionIntentBindingHash) {
      throw new Error('persisted AGG action-intent candidate compiler-binding hash mismatch');
    }
    if (requestedBindings !== undefined && canonicalJson(requestedBindings) !== canonicalJson(bindings)) {
      throw new Error('requested action-intent bindings do not exactly match the persisted reviewed candidate');
    }
    assertActionIntentEvidenceCurrent(port, bindings);
    if (bindings.length) verifyReviewer(jobId, candidate, { now: Date.now() });
    return bindings;
  };
}
