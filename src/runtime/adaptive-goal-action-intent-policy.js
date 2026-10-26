import { createHash } from 'node:crypto';

/**
 * AGG action-intent semantic policy v1.
 *
 * This is deliberately narrower than the general role-operation vocabulary:
 * each built-in role has one canonical operation, output type and completion
 * contract. Free-form intent text is not used as an authority; the supplied
 * description must be the deterministic rendering of this typed contract.
 * Targets must resolve to the current step or a durable artifact already
 * present in the current node's verified evidence. Unbound codebase/component
 * names are rejected because the current AGG contract has no trusted resource
 * registry with which to resolve them.
 */
export const ADAPTIVE_GOAL_ACTION_INTENT_SEMANTIC_POLICY_VERSION = 1;

const ROLE_POLICIES = Object.freeze({
  'product-owner': Object.freeze({ operation: 'analyze', targetKinds: Object.freeze(['requirement', 'work_item']), outputArtifactType: 'requirements' }),
  researcher: Object.freeze({ operation: 'investigate', targetKinds: Object.freeze(['artifact', 'requirement', 'work_item']), outputArtifactType: 'research' }),
  architect: Object.freeze({ operation: 'design', targetKinds: Object.freeze(['artifact', 'requirement', 'work_item']), outputArtifactType: 'architecture' }),
  engineer: Object.freeze({ operation: 'implement', targetKinds: Object.freeze(['artifact', 'work_item']), outputArtifactType: 'implementation' }),
  security: Object.freeze({ operation: 'review', targetKinds: Object.freeze(['artifact', 'work_item']), outputArtifactType: 'security-review' }),
  qa: Object.freeze({ operation: 'verify', targetKinds: Object.freeze(['artifact', 'work_item']), outputArtifactType: 'qa-report' }),
  platform: Object.freeze({ operation: 'verify', targetKinds: Object.freeze(['artifact', 'work_item']), outputArtifactType: 'platform-review' }),
  writer: Object.freeze({ operation: 'document', targetKinds: Object.freeze(['artifact', 'work_item']), outputArtifactType: 'documentation' }),
  reviewer: Object.freeze({ operation: 'review', targetKinds: Object.freeze(['artifact', 'work_item']), outputArtifactType: 'review' }),
  cto: Object.freeze({ operation: 'review', targetKinds: Object.freeze(['artifact', 'work_item']), outputArtifactType: 'cto-decision' })
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    const output = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(output, key, { value: canonicalize(value[key]), enumerable: true, writable: true, configurable: true });
    }
    return output;
  }
  return value;
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function fail(code, message) {
  const error = new TypeError(`${code}: ${message}`);
  error.code = code;
  throw error;
}

export function getAdaptiveGoalActionIntentSemanticPolicy(role) {
  const policy = ROLE_POLICIES[String(role || '').toLowerCase()];
  if (!policy) fail('AGG_ACTION_INTENT_ROLE_SEMANTIC_POLICY_MISSING', `no AGG semantic policy exists for role ${String(role)}`);
  return Object.freeze({
    schemaVersion: 1,
    policyVersion: ADAPTIVE_GOAL_ACTION_INTENT_SEMANTIC_POLICY_VERSION,
    policyId: `agg.action-intent.semantic.${String(role).toLowerCase()}`,
    role: String(role).toLowerCase(),
    operation: policy.operation,
    targetKinds: policy.targetKinds,
    outputArtifactType: policy.outputArtifactType
  });
}

export function canonicalAdaptiveGoalActionIntentDescription({ operation, target, outputArtifactType, successCriteria }) {
  return `Perform ${operation} on ${target.kind}:${target.reference}; produce ${outputArtifactType}; success criteria: ${successCriteria.join(', ')}.`;
}

function resolveTargetBinding({ intent, node, normalizedInputs, policy }) {
  const target = intent.target;
  if (!policy.targetKinds.includes(target.kind)) {
    fail('AGG_ACTION_INTENT_TARGET_SEMANTICS_UNSUPPORTED', `target kind ${target.kind} is not semantically supported for role ${policy.role}`);
  }
  if (target.kind === 'work_item') {
    if (target.reference !== node.sourceStepId) {
      fail('AGG_ACTION_INTENT_TARGET_UNBOUND', `work_item target must name the exact current source step ${node.sourceStepId}`);
    }
    return { kind: 'execution_graph_step', step_id: node.sourceStepId };
  }
  const supportedEvidence = (node.supportingEvidence?.artifacts || []).filter(item => item.artifactId === target.reference);
  if (supportedEvidence.length !== 1) {
    fail('AGG_ACTION_INTENT_TARGET_UNBOUND', `artifact target ${target.reference} must resolve to exactly one verified artifact in this step's evidence snapshot`);
  }
  const evidence = supportedEvidence[0];
  if (target.kind === 'requirement' && evidence.type !== 'requirements') {
    fail('AGG_ACTION_INTENT_TARGET_TYPE_MISMATCH', `requirement target ${target.reference} does not resolve to a requirements artifact`);
  }
  const input = normalizedInputs.find(item => item.source.kind === 'evidence' && item.provenance.artifactId === evidence.artifactId);
  if (!input) {
    fail('AGG_ACTION_INTENT_TARGET_NOT_BOUND_AS_INPUT', `target artifact ${target.reference} is not an exact typed evidence input to this task`);
  }
  return { kind: 'evidence_artifact', artifact_id: evidence.artifactId, artifact_type: evidence.type, input_type: input.inputType };
}

export function buildAdaptiveGoalActionIntentSemanticVerification({ role, capability, roleContract, outputArtifactType, node, intent, normalizedInputs, dependencies }) {
  const policy = getAdaptiveGoalActionIntentSemanticPolicy(role);
  if (!isRecord(roleContract) || roleContract.role !== policy.role || roleContract.capability !== capability ||
      policy.outputArtifactType !== outputArtifactType || !roleContract.outputs?.includes(outputArtifactType)) {
    fail('AGG_ACTION_INTENT_ROLE_CAPABILITY_MISMATCH', `role ${role} capability/output does not match semantic policy ${policy.policyId}`);
  }
  if (intent.operation !== policy.operation) {
    fail('AGG_ACTION_INTENT_ROLE_SEMANTIC_MISMATCH', `role ${role} only supports the canonical semantic operation ${policy.operation} under policy v${policy.policyVersion}`);
  }
  const expectedCriteria = [...roleContract.completionCriteria].sort();
  const actualCriteria = [...intent.successCriteria];
  if (actualCriteria.some((item, index) => item !== expectedCriteria[index]) || actualCriteria.length !== expectedCriteria.length) {
    fail('AGG_ACTION_INTENT_SUCCESS_CRITERIA_MISMATCH', `successCriteria must exactly equal the canonical role-contract criteria: ${expectedCriteria.join(', ')}`);
  }
  const targetBinding = resolveTargetBinding({ intent, node, normalizedInputs, policy });
  const description = canonicalAdaptiveGoalActionIntentDescription({
    operation: policy.operation,
    target: intent.target,
    outputArtifactType: policy.outputArtifactType,
    successCriteria: expectedCriteria
  });
  if (intent.description !== description) {
    fail('AGG_ACTION_INTENT_DESCRIPTION_NOT_CANONICAL', 'free-form descriptions are not proof of semantics; description must exactly render the validated operation, target, output type, and role criteria');
  }
  const semantic = {
    schema_version: 1,
    policy_id: policy.policyId,
    policy_version: policy.policyVersion,
    role: policy.role,
    capability,
    role_contract_id: roleContract.id,
    role_contract_version: roleContract.version,
    operation: policy.operation,
    target: { kind: intent.target.kind, reference: intent.target.reference },
    target_binding: targetBinding,
    output_artifact_type: policy.outputArtifactType,
    success_criteria: expectedCriteria,
    input_types: normalizedInputs.map(input => input.inputType).sort(),
    dependency_step_ids: [...dependencies].sort()
  };
  return { ...semantic, semantic_hash: hash(semantic) };
}

export function validateCompiledAdaptiveGoalActionIntentSemanticVerification(role, intent, expectedTaskId) {
  const policy = getAdaptiveGoalActionIntentSemanticPolicy(role);
  const verification = intent?.semantic_verification;
  const expectedKeys = 'capability,dependency_step_ids,input_types,operation,output_artifact_type,policy_id,policy_version,role,role_contract_id,role_contract_version,schema_version,semantic_hash,success_criteria,target,target_binding';
  if (!isRecord(verification) || Object.keys(verification).sort().join(',') !== expectedKeys ||
      verification.schema_version !== 1 || verification.policy_version !== policy.policyVersion ||
      verification.policy_id !== policy.policyId || verification.role !== role ||
      verification.capability !== getCapabilityForRole(role) || verification.operation !== policy.operation ||
      verification.role_contract_id !== intent.role_contract_id || verification.role_contract_version !== intent.role_contract_version ||
      verification.output_artifact_type !== policy.outputArtifactType ||
      !Array.isArray(verification.success_criteria) ||
      JSON.stringify(verification.success_criteria) !== JSON.stringify([...verification.success_criteria].sort()) ||
      !Array.isArray(verification.input_types) ||
      JSON.stringify(verification.input_types) !== JSON.stringify([...verification.input_types].sort()) ||
      !Array.isArray(verification.dependency_step_ids) ||
      JSON.stringify(verification.dependency_step_ids) !== JSON.stringify(intent.dependency_step_ids) ||
      JSON.stringify(verification.target) !== JSON.stringify(intent.target)) {
    fail('AGG_ACTION_INTENT_SEMANTIC_PROOF_INVALID', `compiled semantic proof is malformed or stale for ${expectedTaskId}`);
  }
  const expectedCriteria = [...getCompletionCriteriaForRole(role)].sort();
  if (JSON.stringify(verification.success_criteria) !== JSON.stringify(expectedCriteria)) {
    fail('AGG_ACTION_INTENT_SEMANTIC_PROOF_INVALID', `compiled success criteria do not match the pinned ${role} contract`);
  }
  const targetBinding = verification.target_binding;
  if (intent.target.kind === 'work_item') {
    if (!isRecord(targetBinding) || Object.keys(targetBinding).sort().join(',') !== 'kind,step_id' ||
        targetBinding.kind !== 'execution_graph_step' || targetBinding.step_id !== intent.source_step_id ||
        intent.target.reference !== intent.source_step_id) {
      fail('AGG_ACTION_INTENT_SEMANTIC_PROOF_INVALID', `work_item target is not bound to the exact source step for ${expectedTaskId}`);
    }
  } else {
    if (!isRecord(targetBinding) || Object.keys(targetBinding).sort().join(',') !== 'artifact_id,artifact_type,input_type,kind' ||
        targetBinding.kind !== 'evidence_artifact' || targetBinding.artifact_id !== intent.target.reference ||
        targetBinding.input_type !== targetBinding.artifact_type ||
        !intent.task_input_bindings.some(input => input.input_type === targetBinding.input_type &&
          input.source.kind === 'evidence' && input.source.artifact_id === targetBinding.artifact_id)) {
      fail('AGG_ACTION_INTENT_SEMANTIC_PROOF_INVALID', `artifact target is not bound to an exact pinned evidence input for ${expectedTaskId}`);
    }
    if (intent.target.kind === 'requirement' && targetBinding.artifact_type !== 'requirements') {
      fail('AGG_ACTION_INTENT_SEMANTIC_PROOF_INVALID', `requirement target is not a requirements artifact for ${expectedTaskId}`);
    }
    if (!['artifact', 'requirement'].includes(intent.target.kind) || !policy.targetKinds.includes(intent.target.kind)) {
      fail('AGG_ACTION_INTENT_SEMANTIC_PROOF_INVALID', `target kind is not supported by semantic policy for ${expectedTaskId}`);
    }
  }
  const canonicalDescription = canonicalAdaptiveGoalActionIntentDescription({
    operation: intent.operation,
    target: intent.target,
    outputArtifactType: verification.output_artifact_type,
    successCriteria: verification.success_criteria
  });
  if (intent.description !== canonicalDescription) {
    fail('AGG_ACTION_INTENT_SEMANTIC_PROOF_INVALID', `compiled description is not the canonical display of typed semantics for ${expectedTaskId}`);
  }
  const unsigned = { ...verification };
  delete unsigned.semantic_hash;
  const expectedHash = hash(unsigned);
  if (!/^[a-f0-9]{64}$/.test(verification.semantic_hash || '') || verification.semantic_hash !== expectedHash) {
    fail('AGG_ACTION_INTENT_SEMANTIC_PROOF_INVALID', `compiled semantic fingerprint/hash mismatch for ${expectedTaskId}`);
  }
  return true;
}

function getCapabilityForRole(role) {
  return ({
    'product-owner': 'product.requirements', researcher: 'research.collect', architect: 'architecture.design',
    engineer: 'code.modify', security: 'security.audit', qa: 'code.verify', platform: 'infrastructure.verify',
    writer: 'documentation.write', reviewer: 'change.review', cto: 'synthesis.approve'
  })[role];
}

function getCompletionCriteriaForRole(role) {
  return ({
    'product-owner': ['scope_defined', 'acceptance_criteria_defined', 'non_goals_defined'],
    researcher: ['findings_recorded', 'sources_or_code_references_recorded', 'limitations_recorded'],
    architect: ['components_defined', 'interfaces_defined', 'failure_modes_defined', 'implementation_boundary_defined'],
    engineer: ['approved_scope_implemented', 'tests_or_verification_run', 'implementation_evidence_recorded'],
    security: ['threats_reviewed', 'security_findings_recorded', 'decision_recorded'],
    qa: ['acceptance_checks_run', 'actual_results_recorded', 'failures_recorded_or_none'],
    platform: ['runtime_reviewed', 'deployment_reviewed', 'rollback_or_recovery_reviewed'],
    writer: ['docs_match_implementation', 'user_facing_changes_documented'],
    reviewer: ['all_required_evidence_reconciled', 'blocking_findings_recorded', 'decision_recorded'],
    cto: ['decision_recorded', 'risks_recorded', 'follow_up_actions_recorded']
  })[role] || [];
}
