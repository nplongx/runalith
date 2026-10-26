import { validateCompiledAdaptiveGoalActionIntentSemanticVerification } from '../adaptive-goal-action-intent-policy.js';

const CONTRACTS = Object.freeze({
  'product-owner': {
    id: 'agent.product-owner', version: 1, role: 'product-owner', capability: 'product.requirements',
    executor: 'ChatOnSteroids', inputs: ['job.request'], outputs: ['requirements'], permissions: ['workspace.read', 'artifact.create'],
    allowedTools: [], completionCriteria: ['scope_defined', 'acceptance_criteria_defined', 'non_goals_defined']
  },
  researcher: {
    id: 'agent.researcher', version: 1, role: 'researcher', capability: 'research.collect',
    executor: 'ChatOnSteroids', inputs: ['requirements'], outputs: ['research'], permissions: ['workspace.read', 'artifact.create'],
    allowedTools: [], completionCriteria: ['findings_recorded', 'sources_or_code_references_recorded', 'limitations_recorded']
  },
  architect: {
    id: 'agent.architect', version: 1, role: 'architect', capability: 'architecture.design',
    executor: 'ChatOnSteroids', inputs: ['requirements', 'research'], outputs: ['architecture'], permissions: ['workspace.read', 'artifact.create'],
    allowedTools: [], completionCriteria: ['components_defined', 'interfaces_defined', 'failure_modes_defined', 'implementation_boundary_defined']
  },
  engineer: {
    id: 'agent.engineer', version: 1, role: 'engineer', capability: 'code.modify',
    executor: 'ChatOnSteroids', inputs: ['requirements', 'architecture'], outputs: ['implementation'],
    permissions: ['workspace.read', 'workspace.write', 'execution.request', 'artifact.create'], allowedTools: [],
    completionCriteria: ['approved_scope_implemented', 'tests_or_verification_run', 'implementation_evidence_recorded']
  },
  security: {
    id: 'agent.security', version: 1, role: 'security', capability: 'security.audit',
    executor: 'ChatOnSteroids', inputs: ['requirements', 'architecture', 'implementation'], outputs: ['security-review'], permissions: ['workspace.read', 'artifact.create'],
    allowedTools: [], completionCriteria: ['threats_reviewed', 'security_findings_recorded', 'decision_recorded']
  },
  qa: {
    id: 'agent.qa', version: 1, role: 'qa', capability: 'code.verify',
    executor: 'ChatOnSteroids', inputs: ['requirements', 'architecture', 'implementation'], outputs: ['qa-report'], permissions: ['workspace.read', 'execution.request', 'artifact.create'],
    allowedTools: [], completionCriteria: ['acceptance_checks_run', 'actual_results_recorded', 'failures_recorded_or_none']
  },
  platform: {
    id: 'agent.platform', version: 1, role: 'platform', capability: 'infrastructure.verify',
    executor: 'ChatOnSteroids', inputs: ['architecture', 'implementation'], outputs: ['platform-review'], permissions: ['workspace.read', 'artifact.create'],
    allowedTools: [], completionCriteria: ['runtime_reviewed', 'deployment_reviewed', 'rollback_or_recovery_reviewed']
  },
  writer: {
    id: 'agent.writer', version: 1, role: 'writer', capability: 'documentation.write',
    executor: 'ChatOnSteroids', inputs: ['requirements', 'implementation'], outputs: ['documentation'],
    // Capability declaration only: runtime writes still require a scope pinned
    // in the approved standard-engineering v3 immutable execution plan.
    permissions: ['workspace.read', 'workspace.write', 'artifact.create'],
    allowedTools: [], completionCriteria: ['docs_match_implementation', 'user_facing_changes_documented']
  },
  reviewer: {
    id: 'agent.reviewer', version: 1, role: 'reviewer', capability: 'change.review',
    executor: 'ChatOnSteroids', inputs: ['requirements', 'architecture', 'implementation', 'security-review', 'qa-report', 'platform-review', 'documentation'], outputs: ['review'], permissions: ['workspace.read', 'artifact.create'],
    allowedTools: [], completionCriteria: ['all_required_evidence_reconciled', 'blocking_findings_recorded', 'decision_recorded']
  },
  cto: {
    id: 'agent.cto', version: 1, role: 'cto', capability: 'synthesis.approve',
    executor: 'ChatOnSteroids', inputs: ['requirements', 'architecture', 'implementation', 'security-review', 'qa-report', 'platform-review', 'documentation', 'review'], outputs: ['cto-decision'], permissions: ['workspace.read', 'artifact.create'],
    allowedTools: [], completionCriteria: ['decision_recorded', 'risks_recorded', 'follow_up_actions_recorded']
  }
});

const ROLE_ARTIFACT_TYPES = Object.freeze({
  'product-owner': 'requirements', researcher: 'research', architect: 'architecture', engineer: 'implementation',
  security: 'security-review', qa: 'qa-report', platform: 'platform-review', writer: 'documentation', reviewer: 'review', cto: 'cto-decision'
});

// Versioned action-intent vocabulary for reviewable per-task requests. These
// are semantic operation categories, not permission grants or executable
// commands; the immutable workflow plan/approval gates remain authoritative.
const ACTION_INTENT_OPERATIONS_BY_ROLE = Object.freeze({
  'product-owner': Object.freeze(['analyze', 'document', 'prepare', 'review']),
  researcher: Object.freeze(['analyze', 'investigate', 'verify']),
  architect: Object.freeze(['analyze', 'design', 'prepare', 'review']),
  engineer: Object.freeze(['analyze', 'implement', 'prepare', 'verify']),
  security: Object.freeze(['analyze', 'investigate', 'review', 'verify']),
  qa: Object.freeze(['analyze', 'investigate', 'review', 'verify']),
  platform: Object.freeze(['analyze', 'investigate', 'prepare', 'verify']),
  writer: Object.freeze(['analyze', 'document', 'prepare']),
  reviewer: Object.freeze(['analyze', 'investigate', 'review', 'verify']),
  cto: Object.freeze(['analyze', 'prepare', 'review'])
});
const ACTION_INTENT_TARGET_KINDS = Object.freeze(['artifact', 'codebase', 'component', 'requirement', 'work_item', 'other']);
const ACTION_INTENT_TARGET_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function createActionIntentContract(role) {
  const operations = ACTION_INTENT_OPERATIONS_BY_ROLE[role];
  if (!operations) throw new Error(`missing action-intent operation profile for role: ${role}`);
  return Object.freeze({
    schemaVersion: 1,
    operations,
    targetKinds: ACTION_INTENT_TARGET_KINDS,
    maxDescriptionLength: 1200,
    minSuccessCriteria: 1,
    maxSuccessCriteria: 12,
    maxSuccessCriterionLength: 300
  });
}

function immutableContract(contract) {
  return Object.freeze({
    ...contract,
    inputs: Object.freeze([...contract.inputs]),
    outputs: Object.freeze([...contract.outputs]),
    permissions: Object.freeze([...contract.permissions]),
    allowedTools: Object.freeze([...contract.allowedTools]),
    completionCriteria: Object.freeze([...contract.completionCriteria]),
    actionIntentContract: createActionIntentContract(contract.role)
  });
}

const IMMUTABLE_CONTRACTS = Object.freeze(Object.fromEntries(
  Object.entries(CONTRACTS).map(([role, contract]) => [role, immutableContract(contract)])
));

export function getAgentContract(role) {
  const key = String(role || '').toLowerCase();
  const contract = IMMUTABLE_CONTRACTS[key];
  if (!contract) throw new Error(`unknown agent contract: ${role}`);
  return contract;
}

export function listAgentContracts() {
  return Object.freeze(Object.values(IMMUTABLE_CONTRACTS));
}

export function getAgentArtifactType(role) {
  const key = String(role || '').toLowerCase();
  const type = ROLE_ARTIFACT_TYPES[key === 'productowner' ? 'product-owner' : key];
  if (!type) throw new Error(`unknown agent role: ${role}`);
  return type;
}

export function normalizeAgentActionIntent(role, intent) {
  const contract = getAgentContract(role).actionIntentContract;
  if (!intent || typeof intent !== 'object' || Array.isArray(intent) ||
      Object.keys(intent).sort().join(',') !== 'description,operation,successCriteria,target') {
    throw new Error(`action intent for role ${contract.role || role} must contain exactly operation, target, description and successCriteria`);
  }
  if (typeof intent.operation !== 'string' || !contract.operations.includes(intent.operation)) {
    throw new Error(`action intent operation is not supported by role ${role}: ${String(intent.operation)}`);
  }
  if (!intent.target || typeof intent.target !== 'object' || Array.isArray(intent.target) ||
      Object.keys(intent.target).sort().join(',') !== 'kind,reference' ||
      typeof intent.target.kind !== 'string' || !contract.targetKinds.includes(intent.target.kind) ||
      typeof intent.target.reference !== 'string' || !ACTION_INTENT_TARGET_REFERENCE.test(intent.target.reference) ||
      intent.target.reference.trim() !== intent.target.reference) {
    throw new Error(`action intent target is invalid for role ${role}`);
  }
  if (typeof intent.description !== 'string' || !intent.description.length ||
      intent.description.length > contract.maxDescriptionLength || intent.description.trim() !== intent.description ||
      /[\u0000-\u001f\u007f]/.test(intent.description)) {
    throw new Error(`action intent description is invalid for role ${role}`);
  }
  if (!Array.isArray(intent.successCriteria) || intent.successCriteria.length < contract.minSuccessCriteria ||
      intent.successCriteria.length > contract.maxSuccessCriteria ||
      intent.successCriteria.some(item => typeof item !== 'string' || !item.length || item.trim() !== item ||
        item.length > contract.maxSuccessCriterionLength || /[\u0000-\u001f\u007f]/.test(item)) ||
      new Set(intent.successCriteria).size !== intent.successCriteria.length) {
    throw new Error(`action intent successCriteria are invalid for role ${role}`);
  }
  return {
    operation: intent.operation,
    target: { kind: intent.target.kind, reference: intent.target.reference },
    description: intent.description,
    successCriteria: [...intent.successCriteria]
  };
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
  validateCompiledAdaptiveGoalActionIntentSemanticVerification(role, intent, expectedTaskId);
  return true;
}

const INPUT_ARTIFACT_TYPES = Object.freeze({
  requirements: 'requirements',
  research: 'research',
  architecture: 'architecture',
  implementation: 'implementation',
  'security-review': 'security-review',
  'qa-report': 'qa-report',
  'platform-review': 'platform-review',
  documentation: 'documentation',
  review: 'review'
});

export function getAgentInputArtifactTypes(role) {
  const contract = getAgentContract(role);
  return Object.freeze(contract.inputs.map(input => INPUT_ARTIFACT_TYPES[input]).filter(Boolean));
}

export function validateAgentContract(contract) {
  if (!contract || typeof contract !== 'object') throw new Error('agent contract is required');
  for (const field of ['id', 'role', 'capability', 'executor']) {
    if (!String(contract[field] || '').trim()) throw new Error(`agent contract ${field} is required`);
  }
  if (!Number.isInteger(contract.version) || contract.version < 1) throw new Error(`invalid agent contract version: ${contract.version}`);
  for (const field of ['inputs', 'outputs', 'permissions', 'allowedTools', 'completionCriteria']) {
    if (!Array.isArray(contract[field])) throw new Error(`agent contract ${field} must be an array`);
    if (contract[field].some(item => typeof item !== 'string' || !item.trim())) throw new Error(`agent contract ${field} contains an invalid entry`);
  }
  if (!/^agent\.[a-z0-9-]+$/.test(contract.id)) throw new Error(`invalid agent contract id: ${contract.id}`);
  return true;
}

for (const contract of Object.values(IMMUTABLE_CONTRACTS)) validateAgentContract(contract);

export { IMMUTABLE_CONTRACTS as AGENT_CONTRACTS };
