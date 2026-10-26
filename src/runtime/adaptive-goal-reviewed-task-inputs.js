import { createHash } from 'node:crypto';
import { canonicalJson } from './workflow/plan.js';
import { artifactSchemaForType } from './workflow/artifacts.js';
import { getAgentArtifactType, getAgentContract, normalizeAgentActionIntent } from './workflow/agent-contracts.js';
import { verifyAdaptiveGoalExecutionGraphProposalHash } from './adaptive-goal-execution-graph-proposal.js';
import { buildAdaptiveGoalActionIntentSemanticVerification } from './adaptive-goal-action-intent-policy.js';

export const ADAPTIVE_GOAL_REVIEWED_TASK_INPUTS_SCHEMA_VERSION = 1;

const SHA256 = /^[a-f0-9]{64}$/;
const STEP_ID = /^agg-step-[a-f0-9]{24}$/;
const TASK_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const TARGET_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OPERATIONS = new Set(['analyze', 'design', 'document', 'implement', 'investigate', 'prepare', 'review', 'verify', 'other']);
const TARGET_KINDS = new Set(['artifact', 'codebase', 'component', 'requirement', 'work_item', 'other']);
const REVIEW_ACKNOWLEDGMENT = 'I_REVIEWED_ACTION_INTENTS_AND_INPUT_BINDINGS_FOR_CANDIDATE_REVIEW_ONLY';
const REVIEW_DECISION = 'reviewed_for_candidate_only';
const ARTIFACT_INPUT_TYPES = Object.freeze([
  'requirements', 'research', 'architecture', 'implementation', 'security-review',
  'qa-report', 'platform-review', 'documentation', 'review'
]);
const ROLES = Object.freeze(['product-owner', 'researcher', 'architect', 'engineer', 'security', 'qa', 'platform', 'writer', 'reviewer', 'cto']);
const ROLE_CONTRACT_IDS = Object.freeze(ROLES.map(role => `agent.${role}`));
const CAPABILITIES = Object.freeze([
  'product.requirements', 'research.collect', 'architecture.design', 'code.modify', 'security.audit',
  'code.verify', 'infrastructure.verify', 'documentation.write', 'change.review', 'synthesis.approve'
]);

export const ADAPTIVE_GOAL_REVIEWED_ACTION_INTENTS_JSON_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    kind: { type: 'string', const: 'adaptive_goal_reviewed_action_intents' },
    source: {
      type: 'object', additionalProperties: false,
      properties: {
        executionGraphFingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        executionGraphProposalHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        sourcePlanProposalJobId: { type: 'string', minLength: 1, maxLength: 200 },
        sourceGraphHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        planGraphDraftHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        sourceCandidateId: { type: 'string', minLength: 1, maxLength: 200 }
      },
      required: ['executionGraphFingerprint', 'executionGraphProposalHash', 'sourcePlanProposalJobId', 'sourceGraphHash', 'planGraphDraftHash', 'sourceCandidateId']
    },
    review: {
      type: 'object', additionalProperties: false,
      properties: {
        decision: { type: 'string', const: REVIEW_DECISION },
        reviewerId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._@:-]*$' },
        reviewedAt: { type: 'string', format: 'date-time', maxLength: 32 },
        acknowledgment: { type: 'string', const: REVIEW_ACKNOWLEDGMENT }
      },
      required: ['decision', 'reviewerId', 'reviewedAt', 'acknowledgment']
    },
    actions: {
      type: 'array', minItems: 1, maxItems: 256,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          stepId: { type: 'string', pattern: '^agg-step-[a-f0-9]{24}$' },
          taskId: { type: 'string', pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$' },
          role: { type: 'string', enum: ROLES },
          capability: { type: 'string', enum: CAPABILITIES },
          roleContractId: { type: 'string', enum: ROLE_CONTRACT_IDS },
          roleContractVersion: { type: 'integer', minimum: 1 },
          actionIntent: {
            type: 'object', additionalProperties: false,
            properties: {
              operation: { type: 'string', enum: [...OPERATIONS] },
              target: {
                type: 'object', additionalProperties: false,
                properties: {
                  kind: { type: 'string', enum: [...TARGET_KINDS] },
                  reference: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' }
                },
                required: ['kind', 'reference']
              },
              description: { type: 'string', minLength: 1, maxLength: 1200 },
              successCriteria: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 300 } }
            },
            required: ['operation', 'target', 'description', 'successCriteria']
          },
          taskInputs: {
            type: 'array', maxItems: 64,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                inputType: { type: 'string', enum: ARTIFACT_INPUT_TYPES },
                source: { oneOf: [
                  { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'evidence' }, reference: { type: 'string', minLength: 1, maxLength: 1024 } }, required: ['kind', 'reference'] },
                  { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'ancestor_output' }, stepId: { type: 'string', pattern: '^agg-step-[a-f0-9]{24}$' } }, required: ['kind', 'stepId'] }
                ] }
              },
              required: ['inputType', 'source']
            }
          },
          dependencyStepIds: { type: 'array', maxItems: 256, uniqueItems: true, items: { type: 'string', pattern: '^agg-step-[a-f0-9]{24}$' } },
          evidenceRefs: { type: 'array', maxItems: 512, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 1024 } }
        },
        required: ['stepId', 'taskId', 'role', 'capability', 'roleContractId', 'roleContractVersion', 'actionIntent', 'taskInputs', 'dependencyStepIds', 'evidenceRefs']
      }
    }
  },
  required: ['schemaVersion', 'kind', 'source', 'review', 'actions']
});
const IDENTITY_BLOCKER = Object.freeze({
  code: 'AGG_ACTION_INTENT_REVIEWER_IDENTITY_UNVERIFIED',
  message: 'reviewerId and reviewedAt are caller assertions, not authenticated identity evidence. The current stdio MCP request path supplies no authenticated principal, configured trust root, or reviewer-authorization provider; execution remains blocked.'
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function fail(code, message, details = {}) {
  const error = new TypeError(`${code}: ${message}`);
  error.code = code;
  error.details = details;
  throw error;
}

function exactKeys(value, expected, label, code = 'AGG_REVIEWED_TASK_INPUTS_SCHEMA_INVALID') {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    fail(code, `${label} must contain exactly these fields: ${[...expected].sort().join(', ')}`);
  }
}

function assertString(value, label, { max = 256, pattern = null } = {}) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.trim() !== value ||
      /[\u0000-\u001f\u007f]/.test(value) || (pattern && !pattern.test(value))) {
    fail('AGG_REVIEWED_TASK_INPUTS_SCHEMA_INVALID', `${label} must be a bounded, canonical string`);
  }
  return value;
}

function sortedUniqueStrings(values, label, pattern = null) {
  if (!Array.isArray(values)) fail('AGG_REVIEWED_TASK_INPUTS_SCHEMA_INVALID', `${label} must be an array`);
  const normalized = values.map((value, index) => assertString(value, `${label}[${index}]`, { max: 512, pattern }));
  const sorted = [...normalized].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (new Set(sorted).size !== sorted.length || canonicalJson(values) !== canonicalJson(sorted)) {
    fail('AGG_REVIEWED_TASK_INPUTS_SCHEMA_INVALID', `${label} must be sorted and unique`);
  }
  return sorted;
}

function isoTimestamp(value, label) {
  const input = assertString(value, label, { max: 32 });
  const parsed = new Date(input);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== input) {
    fail('AGG_REVIEWED_TASK_INPUTS_REVIEW_INVALID', `${label} must be a canonical UTC ISO-8601 timestamp`);
  }
  return input;
}

function canonicalReviewPayload(input, executionGraphProposal) {
  exactKeys(input, ['schemaVersion', 'kind', 'source', 'review', 'actions'], 'reviewed_action_intents');
  if (input.schemaVersion !== ADAPTIVE_GOAL_REVIEWED_TASK_INPUTS_SCHEMA_VERSION || input.kind !== 'adaptive_goal_reviewed_action_intents') {
    fail('AGG_REVIEWED_TASK_INPUTS_SCHEMA_UNSUPPORTED', 'reviewed action-intent schema version/kind is unsupported');
  }
  const expectedSource = {
    executionGraphFingerprint: executionGraphProposal.fingerprint,
    executionGraphProposalHash: executionGraphProposal.proposalHash,
    sourcePlanProposalJobId: executionGraphProposal.source.planProposalJobId,
    sourceGraphHash: executionGraphProposal.source.graphHash,
    planGraphDraftHash: executionGraphProposal.source.draftHash,
    sourceCandidateId: executionGraphProposal.source.candidatePlanId
  };
  exactKeys(input.source, Object.keys(expectedSource), 'reviewed_action_intents.source', 'AGG_REVIEWED_TASK_INPUTS_SOURCE_MISMATCH');
  for (const [key, expected] of Object.entries(expectedSource)) {
    if (typeof expected !== 'string' || input.source[key] !== expected) {
      fail('AGG_REVIEWED_TASK_INPUTS_SOURCE_MISMATCH', `reviewed action-intent source ${key} does not match the current Execution Graph proposal`);
    }
  }
  exactKeys(input.review, ['decision', 'reviewerId', 'reviewedAt', 'acknowledgment'], 'reviewed_action_intents.review', 'AGG_REVIEWED_TASK_INPUTS_REVIEW_INVALID');
  const reviewerId = assertString(input.review.reviewerId, 'review.reviewerId', { max: 128, pattern: /^[A-Za-z0-9][A-Za-z0-9._@:-]*$/ });
  const reviewedAt = isoTimestamp(input.review.reviewedAt, 'review.reviewedAt');
  if (input.review.decision !== REVIEW_DECISION || input.review.acknowledgment !== REVIEW_ACKNOWLEDGMENT) {
    fail('AGG_REVIEWED_TASK_INPUTS_REVIEW_INVALID', 'review must explicitly attest review for candidate purposes only, without execution authorization');
  }
  if (!Array.isArray(input.actions) || input.actions.length !== executionGraphProposal.nodes.length || input.actions.length > 256) {
    fail('AGG_REVIEWED_TASK_INPUTS_ACTION_COVERAGE_MISMATCH', 'reviewed action-intent list must have exactly one bounded record for every current Execution Graph node');
  }
  return {
    source: expectedSource,
    review: { decision: REVIEW_DECISION, reviewerId, reviewedAt, acknowledgment: REVIEW_ACKNOWLEDGMENT },
    actions: input.actions
  };
}

function normalizeIntent(intent, stepId, role) {
  try { return normalizeAgentActionIntent(role, intent); }
  catch (error) {
    fail('AGG_REVIEWED_TASK_INPUTS_ACTION_INTENT_INVALID', `action ${stepId} is not supported by the immutable ${role} action-intent contract: ${String(error?.message || error)}`);
  }
}

function buildNodeIndexes(proposal) {
  const nodesById = new Map();
  const nodesByStepId = new Map();
  const bindingsByStepId = new Map();
  const bindingsByTaskId = new Map();
  const evidenceByReference = new Map();
  for (const node of proposal.nodes) {
    if (!isRecord(node) || typeof node.id !== 'string' || typeof node.sourceStepId !== 'string' ||
        nodesById.has(node.id) || nodesByStepId.has(node.sourceStepId)) {
      fail('AGG_REVIEWED_TASK_INPUTS_GRAPH_INVALID', 'Execution Graph nodes must have unique node and source step IDs');
    }
    nodesById.set(node.id, node);
    nodesByStepId.set(node.sourceStepId, node);
  }
  for (const binding of proposal.bindings) {
    if (!isRecord(binding) || typeof binding.stepId !== 'string' || typeof binding.taskId !== 'string' ||
        bindingsByStepId.has(binding.stepId) || bindingsByTaskId.has(binding.taskId)) {
      fail('AGG_REVIEWED_TASK_INPUTS_BINDING_INVALID', 'Execution Graph bindings must be one-to-one and well-formed');
    }
    bindingsByStepId.set(binding.stepId, binding);
    bindingsByTaskId.set(binding.taskId, binding);
  }
  for (const evidence of proposal.evidenceSnapshot) {
    if (!isRecord(evidence) || typeof evidence.reference !== 'string' || evidenceByReference.has(evidence.reference)) {
      fail('AGG_REVIEWED_TASK_INPUTS_EVIDENCE_INVALID', 'Execution Graph evidence snapshot must have unique durable references');
    }
    evidenceByReference.set(evidence.reference, evidence);
  }
  return { nodesById, nodesByStepId, bindingsByStepId, bindingsByTaskId, evidenceByReference };
}

function ancestorNodeIds(node, nodesById) {
  const result = new Set();
  const pending = [...node.dependencies];
  while (pending.length) {
    const id = pending.pop();
    if (result.has(id)) continue;
    const ancestor = nodesById.get(id);
    if (!ancestor || id === node.id) fail('AGG_REVIEWED_TASK_INPUTS_DEPENDENCY_INVALID', `action ${node.sourceStepId} has an invalid dependency reference`);
    result.add(id);
    pending.push(...ancestor.dependencies);
  }
  return result;
}

function normalizeTaskInputBindings(action, node, binding, roleContract, indexes) {
  exactKeys(action, ['stepId', 'taskId', 'role', 'capability', 'roleContractId', 'roleContractVersion', 'actionIntent', 'taskInputs', 'dependencyStepIds', 'evidenceRefs'], `action ${node.sourceStepId}`);
  if (action.stepId !== node.sourceStepId || action.taskId !== binding.taskId || action.role !== binding.role ||
      action.capability !== binding.capability || action.roleContractId !== binding.roleContractId ||
      action.roleContractVersion !== binding.roleContractVersion) {
    fail('AGG_REVIEWED_TASK_INPUTS_ROLE_CONTRACT_MISMATCH', `reviewed mapping for step ${node.sourceStepId} does not match its current compiler task and immutable role contract`);
  }
  if (roleContract.id !== binding.roleContractId || roleContract.version !== binding.roleContractVersion ||
      roleContract.role !== binding.role || roleContract.capability !== binding.capability ||
      node.roleContract.id !== roleContract.id || node.roleContract.version !== roleContract.version ||
      node.roleContract.role !== roleContract.role || node.roleContract.capability !== roleContract.capability ||
      canonicalJson(node.roleContract.requiredInputs) !== canonicalJson(roleContract.inputs) ||
      canonicalJson(node.roleContract.expectedOutputs) !== canonicalJson(roleContract.outputs) ||
      canonicalJson(node.roleContract.requiredCompletionCriteria) !== canonicalJson(roleContract.completionCriteria)) {
    fail('AGG_REVIEWED_TASK_INPUTS_ROLE_CONTRACT_MISMATCH', `step ${node.sourceStepId} role contract snapshot no longer matches the immutable built-in role contract`);
  }
  const expectedArtifactInputs = roleContract.inputs.filter(type => type !== 'job.request').sort();
  if (!Array.isArray(action.taskInputs) || action.taskInputs.length !== expectedArtifactInputs.length || action.taskInputs.length > 64) {
    fail('AGG_REVIEWED_TASK_INPUTS_INPUT_COVERAGE_MISMATCH', `step ${node.sourceStepId} must bind every and only typed artifact input accepted by role ${roleContract.role}`);
  }
  const expectedDependencies = node.dependencies.map(id => indexes.nodesById.get(id)?.sourceStepId).sort();
  if (expectedDependencies.some(id => !id) || !Array.isArray(action.dependencyStepIds) ||
      canonicalJson(sortedUniqueStrings(action.dependencyStepIds, `action ${node.sourceStepId}.dependencyStepIds`, STEP_ID)) !== canonicalJson(expectedDependencies)) {
    fail('AGG_REVIEWED_TASK_INPUTS_DEPENDENCY_MISMATCH', `reviewed dependencies for step ${node.sourceStepId} do not match the current Execution Graph DAG`);
  }
  const expectedEvidenceRefs = node.supportingEvidence.artifacts.map(item => item.reference).sort();
  if (!Array.isArray(action.evidenceRefs) ||
      canonicalJson(sortedUniqueStrings(action.evidenceRefs, `action ${node.sourceStepId}.evidenceRefs`)) !== canonicalJson(expectedEvidenceRefs)) {
    fail('AGG_REVIEWED_TASK_INPUTS_EVIDENCE_PROVENANCE_MISMATCH', `reviewed evidence references for step ${node.sourceStepId} do not exactly match its current verified source evidence`);
  }
  for (const ref of expectedEvidenceRefs) {
    const nodeEvidence = node.supportingEvidence.artifacts.find(item => item.reference === ref);
    const durableEvidence = indexes.evidenceByReference.get(ref);
    if (!nodeEvidence || !durableEvidence || nodeEvidence.artifactId !== durableEvidence.artifactId ||
        nodeEvidence.contentHash !== durableEvidence.contentHash || nodeEvidence.schemaVersion !== durableEvidence.schemaVersion ||
        nodeEvidence.artifactCreatedEventId !== durableEvidence.artifactCreatedEventId ||
        nodeEvidence.producerResultId !== durableEvidence.producerResultId ||
        nodeEvidence.producerCompletionEventId !== durableEvidence.producerCompletionEventId ||
        durableEvidence.producerResultOutcome !== 'success') {
      fail('AGG_REVIEWED_TASK_INPUTS_EVIDENCE_PROVENANCE_MISMATCH', `evidence ${ref} for step ${node.sourceStepId} does not match the durable current result/completion lineage`);
    }
  }

  const ancestorIds = ancestorNodeIds(node, indexes.nodesById);
  const normalizedInputs = [];
  const inputTypes = [];
  for (const [index, input] of action.taskInputs.entries()) {
    exactKeys(input, ['inputType', 'source'], `action ${node.sourceStepId}.taskInputs[${index}]`, 'AGG_REVIEWED_TASK_INPUTS_INPUT_BINDING_INVALID');
    const inputType = assertString(input.inputType, `action ${node.sourceStepId}.taskInputs[${index}].inputType`, { max: 96, pattern: /^[a-z][a-z0-9-]*$/ });
    if (inputType !== expectedArtifactInputs[index] || inputTypes.includes(inputType)) {
      fail('AGG_REVIEWED_TASK_INPUTS_INPUT_COVERAGE_MISMATCH', `task input types for step ${node.sourceStepId} must be sorted, unique and exactly match its role contract`);
    }
    inputTypes.push(inputType);
    if (!isRecord(input.source)) fail('AGG_REVIEWED_TASK_INPUTS_INPUT_BINDING_INVALID', `task input ${inputType} has no typed provenance source`);
    let source;
    let provenance;
    if (input.source.kind === 'evidence') {
      exactKeys(input.source, ['kind', 'reference'], `action ${node.sourceStepId}.taskInputs[${index}].source`, 'AGG_REVIEWED_TASK_INPUTS_INPUT_BINDING_INVALID');
      const reference = assertString(input.source.reference, `task input ${inputType} evidence reference`, { max: 1024 });
      const evidence = node.supportingEvidence.artifacts.find(item => item.reference === reference);
      const durable = indexes.evidenceByReference.get(reference);
      if (!evidence || !durable || evidence.type !== inputType || durable.type !== inputType ||
          evidence.sourceJobId !== durable.sourceJobId ||
          evidence.artifactId !== durable.artifactId || evidence.contentHash !== durable.contentHash || evidence.schemaVersion !== durable.schemaVersion ||
          evidence.artifactCreatedEventId !== durable.artifactCreatedEventId || evidence.producerResultId !== durable.producerResultId ||
          evidence.producerCompletionEventId !== durable.producerCompletionEventId) {
        fail('AGG_REVIEWED_TASK_INPUTS_INPUT_EVIDENCE_MISMATCH', `task input ${inputType} must bind an exact active source evidence artifact of that same type`);
      }
      const schema = artifactSchemaForType(inputType);
      if (durable.schemaVersion !== schema.schema_version || durable.producerResultOutcome !== 'success') {
        fail('AGG_REVIEWED_TASK_INPUTS_ARTIFACT_SCHEMA_MISMATCH', `task input ${inputType} evidence schema or successful producer lineage is invalid`);
      }
      source = { kind: 'evidence', reference };
      provenance = {
        sourceJobId: durable.sourceJobId,
        reference, artifactId: durable.artifactId, artifactType: durable.type, schemaVersion: durable.schemaVersion,
        contentHash: durable.contentHash, artifactCreatedEventId: durable.artifactCreatedEventId,
        producerRole: durable.producerRole, producerTaskId: durable.producerTaskId,
        producerResultId: durable.producerResultId, producerResultOutcome: durable.producerResultOutcome,
        producerCompletionEventId: durable.producerCompletionEventId, producerCompletionEventType: durable.producerCompletionEventType,
        artifactSchema: { type: schema.type, schemaVersion: schema.schema_version, requiredContentFields: [...schema.required_content_fields] }
      };
    } else if (input.source.kind === 'ancestor_output') {
      exactKeys(input.source, ['kind', 'stepId'], `action ${node.sourceStepId}.taskInputs[${index}].source`, 'AGG_REVIEWED_TASK_INPUTS_INPUT_BINDING_INVALID');
      const stepId = assertString(input.source.stepId, `task input ${inputType} ancestor stepId`, { max: 64, pattern: STEP_ID });
      const ancestorNode = indexes.nodesByStepId.get(stepId);
      const ancestorBinding = indexes.bindingsByStepId.get(stepId);
      if (!ancestorNode || !ancestorBinding || !ancestorIds.has(ancestorNode.id)) {
        fail('AGG_REVIEWED_TASK_INPUTS_INPUT_ANCESTRY_MISMATCH', `task input ${inputType} must originate from a strict ancestor of step ${node.sourceStepId}`);
      }
      const declaredMapping = node.inputContract.mappedAncestorOutputs.find(item => item.stepId === stepId && item.taskId === ancestorBinding.taskId && item.artifactType === inputType);
      const ancestorContract = getAgentContract(ancestorBinding.role);
      const ancestorOutput = ancestorNode.outputEvidenceContract.type;
      if (!declaredMapping || ancestorOutput !== inputType || !ancestorContract.outputs.includes(inputType)) {
        fail('AGG_REVIEWED_TASK_INPUTS_INPUT_ANCESTRY_MISMATCH', `ancestor ${stepId} does not provide a contract-approved ${inputType} output to step ${node.sourceStepId}`);
      }
      const schema = artifactSchemaForType(inputType);
      if (ancestorNode.outputEvidenceContract.schemaVersion !== schema.schema_version ||
          canonicalJson(ancestorNode.outputEvidenceContract.requiredContentFields) !== canonicalJson(schema.required_content_fields)) {
        fail('AGG_REVIEWED_TASK_INPUTS_ARTIFACT_SCHEMA_MISMATCH', `ancestor output ${inputType} schema does not match the current artifact contract`);
      }
      source = { kind: 'ancestor_output', stepId };
      provenance = {
        stepId, taskId: ancestorBinding.taskId, role: ancestorBinding.role, capability: ancestorBinding.capability,
        roleContractId: ancestorContract.id, roleContractVersion: ancestorContract.version,
        artifactType: inputType, schemaVersion: schema.schema_version,
        artifactSchema: { type: schema.type, schemaVersion: schema.schema_version, requiredContentFields: [...schema.required_content_fields] }
      };
    } else {
      fail('AGG_REVIEWED_TASK_INPUTS_INPUT_BINDING_INVALID', `task input ${inputType} uses an unsupported provenance kind`);
    }
    normalizedInputs.push({ inputType, source, provenance });
  }
  const actionIntent = normalizeIntent(action.actionIntent, node.sourceStepId, roleContract.role);
  const semanticVerification = buildAdaptiveGoalActionIntentSemanticVerification({
    role: roleContract.role,
    capability: binding.capability,
    roleContract,
    outputArtifactType: node.outputEvidenceContract.type,
    node,
    intent: actionIntent,
    normalizedInputs,
    dependencies: expectedDependencies
  });
  return {
    stepId: node.sourceStepId,
    taskId: binding.taskId,
    role: binding.role,
    capability: binding.capability,
    roleContract: {
      id: roleContract.id, version: roleContract.version, role: roleContract.role, capability: roleContract.capability,
      requiredInputs: [...roleContract.inputs], expectedOutputs: [...roleContract.outputs],
      requiredCompletionCriteria: [...roleContract.completionCriteria],
      actionIntentContract: {
        schemaVersion: roleContract.actionIntentContract.schemaVersion,
        operations: [...roleContract.actionIntentContract.operations],
        targetKinds: [...roleContract.actionIntentContract.targetKinds],
        maxDescriptionLength: roleContract.actionIntentContract.maxDescriptionLength,
        minSuccessCriteria: roleContract.actionIntentContract.minSuccessCriteria,
        maxSuccessCriteria: roleContract.actionIntentContract.maxSuccessCriteria,
        maxSuccessCriterionLength: roleContract.actionIntentContract.maxSuccessCriterionLength
      }
    },
    actionIntent,
    semanticVerification,
    taskInputBindings: normalizedInputs,
    dependencies: expectedDependencies,
    outputArtifactContract: {
      type: node.outputEvidenceContract.type,
      schemaVersion: node.outputEvidenceContract.schemaVersion,
      requiredContentFields: [...node.outputEvidenceContract.requiredContentFields]
    },
    evidenceProvenance: expectedEvidenceRefs.map(reference => {
      const evidence = indexes.evidenceByReference.get(reference);
      return {
        reference, artifactId: evidence.artifactId, artifactType: evidence.type,
        schemaVersion: evidence.schemaVersion, contentHash: evidence.contentHash,
        artifactCreatedEventId: evidence.artifactCreatedEventId,
        producerRole: evidence.producerRole, producerTaskId: evidence.producerTaskId,
        producerResultId: evidence.producerResultId, producerResultOutcome: evidence.producerResultOutcome,
        producerCompletionEventId: evidence.producerCompletionEventId,
        producerCompletionEventType: evidence.producerCompletionEventType
      };
    }),
    intentInputCompatibility: {
      compatible: true,
      blockerCodes: [IDENTITY_BLOCKER.code],
      roleOperationDeclaration: roleContract.actionIntentContract.schemaVersion,
      semanticPolicyId: semanticVerification.policy_id,
      semanticPolicyVersion: semanticVerification.policy_version,
      semanticFingerprint: semanticVerification.semantic_hash,
      missingSemanticEquivalenceProof: false,
      semanticEquivalenceVerified: true,
      compiledTaskInputDeclaration: 'execution.action_intent@1',
      actionIntentPassedToTask: false
    }
  };
}

/**
 * Validate the caller's review envelope against a fresh, verified Execution
 * Graph proposal. Caller review fields remain claims only; a separate trusted
 * identity-provider attestation is required before approval/dispatch. Typed
 * intents are semantically verified against policy v1, and artifact/ancestor
 * references are pinned as typed inputs, but a valid result still does not
 * grant plan approval, execution authorization or dispatch permission.
 */
export function buildAdaptiveGoalReviewedTaskInputContract({ executionGraphProposal, reviewedActionIntents }) {
  const sourceVerification = executionGraphProposal?.source?.verification;
  const sourceVerificationIsUnverified = sourceVerification?.status === 'unverified' && sourceVerification?.verified === false;
  const sourceVerificationIsTrusted = sourceVerification?.status === 'verified' && sourceVerification?.verified === true &&
    sourceVerification?.claimVerified === true && sourceVerification?.independenceVerified === true &&
    typeof sourceVerification?.providerId === 'string' && sourceVerification.providerId.trim() !== '' &&
    SHA256.test(sourceVerification?.attestationId || '') && SHA256.test(sourceVerification?.trustRootSha256 || '') &&
    SHA256.test(sourceVerification?.snapshotHash || '') && SHA256.test(sourceVerification?.evidenceManifestHash || '') &&
    typeof sourceVerification?.expiresAt === 'string' && Date.parse(sourceVerification.expiresAt) > Date.now();
  if (!isRecord(executionGraphProposal) || executionGraphProposal.kind !== 'adaptive_goal_execution_graph_proposal' ||
      executionGraphProposal.status !== 'review_required' || (!sourceVerificationIsUnverified && !sourceVerificationIsTrusted) ||
      executionGraphProposal.gates?.executableContractsCreated !== false || executionGraphProposal.gates?.immutableExecutionPlanCreated !== false ||
      executionGraphProposal.gates?.dispatchAllowed !== false || executionGraphProposal.gates?.executionAuthorized !== false ||
      !SHA256.test(executionGraphProposal.fingerprint || '') || !SHA256.test(executionGraphProposal.proposalHash || '') ||
      !verifyAdaptiveGoalExecutionGraphProposalHash(executionGraphProposal) ||
      !Array.isArray(executionGraphProposal.nodes) || !Array.isArray(executionGraphProposal.bindings) ||
      !Array.isArray(executionGraphProposal.evidenceSnapshot)) {
    fail('AGG_REVIEWED_TASK_INPUTS_EXECUTION_GRAPH_INVALID', 'a current, hashed, review-only Execution Graph proposal is required');
  }
  const input = canonicalReviewPayload(reviewedActionIntents, executionGraphProposal);
  const indexes = buildNodeIndexes(executionGraphProposal);
  const actionsByStepId = new Map();
  for (const action of input.actions) {
    if (!isRecord(action) || typeof action.stepId !== 'string' || actionsByStepId.has(action.stepId)) {
      fail('AGG_REVIEWED_TASK_INPUTS_ACTION_COVERAGE_MISMATCH', 'every action requires a unique source step ID');
    }
    actionsByStepId.set(action.stepId, action);
  }
  if (indexes.nodesByStepId.size !== actionsByStepId.size || [...indexes.nodesByStepId.keys()].some(id => !actionsByStepId.has(id))) {
    fail('AGG_REVIEWED_TASK_INPUTS_ACTION_COVERAGE_MISMATCH', 'reviewed action-intent source step IDs must exactly cover the current Execution Graph proposal');
  }

  const actions = executionGraphProposal.nodes.map(node => {
    const action = actionsByStepId.get(node.sourceStepId);
    const binding = indexes.bindingsByStepId.get(node.sourceStepId);
    if (!binding) fail('AGG_REVIEWED_TASK_INPUTS_BINDING_MISSING', `step ${node.sourceStepId} has no explicit Execution Graph binding`);
    let roleContract;
    let outputType;
    let outputSchema;
    try {
      roleContract = getAgentContract(binding.role);
      outputType = node.outputEvidenceContract?.type || getAgentArtifactType(binding.role);
      outputSchema = artifactSchemaForType(outputType);
    } catch (error) {
      fail('AGG_REVIEWED_TASK_INPUTS_ROLE_CONTRACT_UNAVAILABLE', `step ${node.sourceStepId} has no supported immutable role/output artifact contract: ${String(error?.message || error)}`);
    }
    if (roleContract.id !== binding.roleContractId || roleContract.version !== binding.roleContractVersion ||
        roleContract.role !== binding.role || roleContract.capability !== binding.capability ||
        node.roleContract?.id !== roleContract.id || node.roleContract?.version !== roleContract.version ||
        node.roleContract?.role !== roleContract.role || node.roleContract?.capability !== roleContract.capability) {
      fail('AGG_REVIEWED_TASK_INPUTS_ROLE_CONTRACT_MISMATCH', `step ${node.sourceStepId} binding does not match its immutable role contract`);
    }
    if (!roleContract.outputs.includes(outputType) || node.outputEvidenceContract.schemaVersion !== outputSchema.schema_version ||
        canonicalJson(node.outputEvidenceContract.requiredContentFields) !== canonicalJson(outputSchema.required_content_fields)) {
      fail('AGG_REVIEWED_TASK_INPUTS_ARTIFACT_SCHEMA_MISMATCH', `step ${node.sourceStepId} output artifact schema does not match its immutable role contract`);
    }
    return normalizeTaskInputBindings(action, node, binding, roleContract, indexes);
  }).sort((a, b) => a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0);

  const blockers = actions.map(action => ({ ...IDENTITY_BLOCKER, stepId: action.stepId, taskId: action.taskId, role: action.role }));
  const unsigned = {
    schemaVersion: ADAPTIVE_GOAL_REVIEWED_TASK_INPUTS_SCHEMA_VERSION,
    kind: 'adaptive_goal_reviewed_task_inputs',
    status: 'review_only_blocked',
    source: input.source,
    review: {
      ...input.review,
      assertionType: 'caller_claim_only',
      identityVerified: false,
      identityProvider: null,
      authenticatedSubject: null,
      authorizationScope: null,
      attestationId: null,
      executionAuthorizationGranted: false
    },
    actions,
    blockers,
    gates: {
      actionIntentReviewAttested: true,
      reviewerIdentityVerified: false,
      typedTaskInputBindingsValidated: true,
      actionIntentOperationConstrainedByRoleContract: true,
      actionIntentSemanticEquivalenceVerified: true,
      actionIntentSemanticPolicyVersion: 1,
      actionIntentRepresentableInCompiledTaskInputs: true,
      actionIntentPassedToTask: false,
      executableContractsCreated: false,
      immutableExecutionPlanCreated: false,
      workflowApprovalCreated: false,
      dispatchAllowed: false,
      executionAuthorized: false
    }
  };
  const contractHash = hash(unsigned);
  return { ...unsigned, contractHash, reviewedActionIntentHash: hash(reviewedActionIntents) };
}

export function verifyAdaptiveGoalReviewedTaskInputContractHash(contract) {
  if (!isRecord(contract) || !SHA256.test(contract.contractHash || '') || !SHA256.test(contract.reviewedActionIntentHash || '')) return false;
  const { contractHash, reviewedActionIntentHash: _reviewedActionIntentHash, ...unsigned } = contract;
  return hash(unsigned) === contractHash;
}

/** Convert a validated review envelope into the compiler's typed, immutable
 * per-task action-intent extension. This is data-only: the workflow compiler
 * still must validate the role contract and the normal workflow approval gate
 * must pin the exact resulting plan before a host task receives the intent. */
export function buildAdaptiveGoalCompilerActionIntentBindings(contract) {
  if (!verifyAdaptiveGoalReviewedTaskInputContractHash(contract) || contract.kind !== 'adaptive_goal_reviewed_task_inputs' ||
      !Array.isArray(contract.actions) || !contract.source) {
    fail('AGG_REVIEWED_TASK_INPUTS_CONTRACT_INVALID', 'a canonical reviewed task-input contract is required before compiler bindings can be created');
  }
  const bindings = contract.actions.map(action => ({
    taskId: action.taskId,
    role: action.role,
    roleContractId: action.roleContract.id,
    roleContractVersion: action.roleContract.version,
    actionIntent: {
      schema_version: 1,
      task_id: action.taskId,
      source_step_id: action.stepId,
      role: action.role,
      role_contract_id: action.roleContract.id,
      role_contract_version: action.roleContract.version,
      operation: action.actionIntent.operation,
      target: { ...action.actionIntent.target },
      description: action.actionIntent.description,
      success_criteria: [...action.actionIntent.successCriteria],
      semantic_verification: action.semanticVerification,
      source: {
        execution_graph_fingerprint: contract.source.executionGraphFingerprint,
        execution_graph_proposal_hash: contract.source.executionGraphProposalHash,
        source_plan_proposal_job_id: contract.source.sourcePlanProposalJobId,
        source_graph_hash: contract.source.sourceGraphHash,
        plan_graph_draft_hash: contract.source.planGraphDraftHash,
        source_candidate_id: contract.source.sourceCandidateId,
        reviewed_task_input_contract_hash: contract.contractHash
      },
      dependency_step_ids: [...action.dependencies],
      task_input_bindings: action.taskInputBindings.map(input => {
        if (input.source.kind === 'evidence') {
          const p = input.provenance;
          return {
            input_type: input.inputType,
            source: {
              kind: 'evidence', input_type: input.inputType,
              source_job_id: p.sourceJobId,
              reference: input.source.reference,
              artifact_id: p.artifactId,
              schema_version: p.schemaVersion,
              content_hash: p.contentHash,
              artifact_created_event_id: p.artifactCreatedEventId,
              producer_role: p.producerRole,
              producer_task_id: p.producerTaskId,
              producer_result_id: p.producerResultId,
              producer_result_outcome: p.producerResultOutcome,
              producer_completion_event_id: p.producerCompletionEventId,
              producer_completion_event_type: p.producerCompletionEventType
            }
          };
        }
        const p = input.provenance;
        return {
          input_type: input.inputType,
          source: {
            kind: 'ancestor_output', input_type: input.inputType,
            source_step_id: input.source.stepId,
            task_id: p.taskId, role: p.role, capability: p.capability,
            role_contract_id: p.roleContractId, role_contract_version: p.roleContractVersion,
            artifact_type: p.artifactType, schema_version: p.schemaVersion
          }
        };
      })
    }
  })).sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
  return bindings;
}

export const ADAPTIVE_GOAL_REVIEWED_ACTION_INTENT_REVIEW = Object.freeze({
  decision: REVIEW_DECISION,
  acknowledgment: REVIEW_ACKNOWLEDGMENT,
  operations: Object.freeze([...OPERATIONS]),
  targetKinds: Object.freeze([...TARGET_KINDS]),
  status: 'review_only_blocked',
  blockers: Object.freeze([IDENTITY_BLOCKER]),
  semanticPolicyVersion: 1,
  identityProviderConfigured: false
});
