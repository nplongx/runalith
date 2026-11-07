import { getAgentContract, normalizeAgentActionIntent } from '../agent-contracts-public-api.js';

export * from '../agent-contracts-public-api.js';

let compiledActionIntentSemanticVerifier = null;

/** Configure the AGG-owned semantic policy at the composition boundary. */
export function configureCompiledActionIntentSemanticVerifier(verifier) {
  if (typeof verifier !== 'function') throw new TypeError('compiled action-intent semantic verifier must be a function');
  if (compiledActionIntentSemanticVerifier && compiledActionIntentSemanticVerifier !== verifier) {
    throw new Error('compiled action-intent semantic verifier is already configured and cannot be replaced');
  }
  compiledActionIntentSemanticVerifier = verifier;
}

export function validateCompiledActionIntent(role, intent, expectedTaskId) {
  const contract = getAgentContract(role);
  const expectedKeys = 'dependency_step_ids,description,operation,role,role_contract_id,role_contract_version,schema_version,semantic_verification,source,source_step_id,success_criteria,target,task_id,task_input_bindings';
  if (!intent || typeof intent !== 'object' || Array.isArray(intent) || Object.keys(intent).sort().join(',') !== expectedKeys) {
    throw new Error(`compiled action intent must use the exact version-1 task-input contract for ${role}`);
  }
  if (intent.schema_version !== 1 || intent.task_id !== expectedTaskId || intent.role !== role ||
      intent.role_contract_id !== contract.id || intent.role_contract_version !== contract.version) {
    throw new Error(`compiled action intent task/role contract binding mismatch for ${expectedTaskId}`);
  }
  if (typeof intent.source_step_id !== 'string' || !/^agg-step-[a-f0-9]{24}$/.test(intent.source_step_id)) {
    throw new Error(`compiled action intent source step identity is invalid for ${expectedTaskId}`);
  }
  normalizeAgentActionIntent(role, {
    operation: intent.operation,
    target: intent.target,
    description: intent.description,
    successCriteria: intent.success_criteria
  });
  const sha = /^[a-f0-9]{64}$/;
  const sourceKeys = 'execution_graph_fingerprint,execution_graph_proposal_hash,plan_graph_draft_hash,reviewed_task_input_contract_hash,source_candidate_id,source_graph_hash,source_plan_proposal_job_id';
  if (!intent.source || typeof intent.source !== 'object' || Array.isArray(intent.source) ||
      Object.keys(intent.source).sort().join(',') !== sourceKeys ||
      !sha.test(intent.source.execution_graph_fingerprint || '') || !sha.test(intent.source.execution_graph_proposal_hash || '') ||
      !sha.test(intent.source.plan_graph_draft_hash || '') || !sha.test(intent.source.reviewed_task_input_contract_hash || '') ||
      !sha.test(intent.source.source_graph_hash || '') ||
      typeof intent.source.source_plan_proposal_job_id !== 'string' || !intent.source.source_plan_proposal_job_id ||
      typeof intent.source.source_candidate_id !== 'string' || !intent.source.source_candidate_id) {
    throw new Error(`compiled action intent source lineage is invalid for ${expectedTaskId}`);
  }
  if (!Array.isArray(intent.dependency_step_ids) || intent.dependency_step_ids.some(stepId =>
      typeof stepId !== 'string' || !/^agg-step-[a-f0-9]{24}$/.test(stepId)) ||
      new Set(intent.dependency_step_ids).size !== intent.dependency_step_ids.length ||
      JSON.stringify(intent.dependency_step_ids) !== JSON.stringify([...intent.dependency_step_ids].sort())) {
    throw new Error(`compiled action intent dependency step IDs are invalid for ${expectedTaskId}`);
  }
  const expectedInputs = contract.inputs.filter(type => type !== 'job.request').sort();
  if (!Array.isArray(intent.task_input_bindings) || intent.task_input_bindings.length !== expectedInputs.length ||
      intent.task_input_bindings.length > 64) {
    throw new Error(`compiled action intent must bind every declared artifact input for ${expectedTaskId}`);
  }
  for (let index = 0; index < intent.task_input_bindings.length; index++) {
    const binding = intent.task_input_bindings[index];
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
        Object.keys(binding).sort().join(',') !== 'input_type,source' || binding.input_type !== expectedInputs[index] ||
        !binding.source || typeof binding.source !== 'object' || Array.isArray(binding.source)) {
      throw new Error(`compiled action intent input binding is malformed or unsorted for ${expectedTaskId}`);
    }
    const sourceValue = binding.source;
    if (sourceValue.kind === 'evidence') {
      const fields = 'artifact_created_event_id,artifact_id,content_hash,input_type,kind,producer_completion_event_id,producer_completion_event_type,producer_result_id,producer_result_outcome,producer_role,producer_task_id,reference,schema_version,source_job_id';
      if (Object.keys(sourceValue).sort().join(',') !== fields || sourceValue.input_type !== binding.input_type ||
          typeof sourceValue.source_job_id !== 'string' || !sourceValue.source_job_id ||
          typeof sourceValue.artifact_id !== 'string' || !sourceValue.artifact_id ||
          typeof sourceValue.reference !== 'string' || !sourceValue.reference ||
          !sha.test(sourceValue.content_hash || '') || !Number.isSafeInteger(sourceValue.schema_version) || sourceValue.schema_version < 1 ||
          typeof sourceValue.artifact_created_event_id !== 'string' || !sourceValue.artifact_created_event_id ||
          typeof sourceValue.producer_role !== 'string' || !sourceValue.producer_role ||
          typeof sourceValue.producer_task_id !== 'string' || !sourceValue.producer_task_id ||
          typeof sourceValue.producer_result_id !== 'string' || !sourceValue.producer_result_id ||
          sourceValue.producer_result_outcome !== 'success' ||
          typeof sourceValue.producer_completion_event_id !== 'string' || !sourceValue.producer_completion_event_id ||
          !['task.completed', 'task.local_completed'].includes(sourceValue.producer_completion_event_type)) {
        throw new Error(`compiled action intent evidence input is invalid for ${expectedTaskId}/${binding.input_type}`);
      }
    } else if (sourceValue.kind === 'ancestor_output') {
      const fields = 'artifact_type,capability,input_type,kind,role,role_contract_id,role_contract_version,schema_version,source_step_id,task_id';
      if (Object.keys(sourceValue).sort().join(',') !== fields || sourceValue.input_type !== binding.input_type ||
          sourceValue.artifact_type !== binding.input_type || typeof sourceValue.source_step_id !== 'string' ||
          !/^agg-step-[a-f0-9]{24}$/.test(sourceValue.source_step_id) || typeof sourceValue.task_id !== 'string' || !sourceValue.task_id ||
          typeof sourceValue.role !== 'string' || typeof sourceValue.capability !== 'string' ||
          typeof sourceValue.role_contract_id !== 'string' || !Number.isSafeInteger(sourceValue.role_contract_version) || sourceValue.role_contract_version < 1 ||
          !Number.isSafeInteger(sourceValue.schema_version) || sourceValue.schema_version < 1) {
        throw new Error(`compiled action intent ancestor-output input is invalid for ${expectedTaskId}/${binding.input_type}`);
      }
    } else throw new Error(`compiled action intent input source kind is unsupported for ${expectedTaskId}/${binding.input_type}`);
  }
  if (typeof compiledActionIntentSemanticVerifier !== 'function') {
    throw new Error('AGG_ACTION_INTENT_SEMANTIC_VERIFIER_UNAVAILABLE: host runtime did not configure the AGG semantic verifier');
  }
  compiledActionIntentSemanticVerifier(role, intent, expectedTaskId);
  return true;
}
