import { createHash } from 'node:crypto';
import { canonicalJson, validateExecutionPlan } from './workflow/plan.js';
import { artifactSchemaForType } from './workflow/artifacts.js';
import { getAgentArtifactType, getAgentContract } from './workflow/agent-contracts.js';
import {
  ADAPTIVE_GOAL_EXECUTION_GRAPH_PROPOSAL_SCHEMA_VERSION,
  verifyAdaptiveGoalExecutionGraphProposalHash
} from './adaptive-goal-execution-graph-proposal.js';
import {
  buildAdaptiveGoalReviewedTaskInputContract,
  buildAdaptiveGoalCompilerActionIntentBindings,
  verifyAdaptiveGoalReviewedTaskInputContractHash
} from './adaptive-goal-reviewed-task-inputs.js';

export const ADAPTIVE_GOAL_EXECUTION_PLAN_CANDIDATE_SCHEMA_VERSION = 2;

const SHA256 = /^[a-f0-9]{64}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function fail(code, message, details = {}) {
  const error = new TypeError(`${code}: ${message}`);
  error.code = code;
  error.details = details;
  throw error;
}

function sorted(values) {
  return [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

function assertHash(value, field) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail('EXECUTION_PLAN_CANDIDATE_INPUT_INVALID', `${field} must be a SHA-256 digest`);
  return value;
}

function assertString(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value) fail('EXECUTION_PLAN_CANDIDATE_INPUT_INVALID', `${field} must be a non-empty canonical string`);
  return value;
}

function validatePlanHash(plan) {
  if (!isRecord(plan) || !SHA256.test(plan.plan_hash || '')) fail('EXECUTION_PLAN_CANDIDATE_PLAN_INVALID', 'compiled plan must include a valid plan_hash');
  const unsignedPlan = Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'plan_hash'));
  const expectedHash = hash(canonicalJson(unsignedPlan));
  if (expectedHash !== plan.plan_hash) fail('EXECUTION_PLAN_CANDIDATE_PLAN_HASH_MISMATCH', 'compiled plan hash does not match the existing compiler canonicalization');
  try { validateExecutionPlan(plan); }
  catch (error) { fail('EXECUTION_PLAN_CANDIDATE_COMPILER_VALIDATION_FAILED', `compiled plan did not pass validateExecutionPlan: ${String(error?.message || error)}`); }
  return true;
}

function taskAncestorIds(taskId, planTasksById) {
  const found = new Set();
  const pending = [...(planTasksById.get(taskId)?.dependencies || [])];
  while (pending.length) {
    const parentId = pending.pop();
    if (found.has(parentId)) continue;
    found.add(parentId);
    const parent = planTasksById.get(parentId);
    if (!parent) fail('EXECUTION_PLAN_CANDIDATE_DEPENDENCY_INVALID', `planned task ${taskId} depends on an unknown task ${parentId}`);
    pending.push(...parent.dependencies);
  }
  return found;
}

function validateGraphProposal(proposal) {
  const sourceVerification = proposal?.source?.verification;
  const sourceVerificationIsUnverified = sourceVerification?.verified === false && sourceVerification?.status === 'unverified';
  const sourceVerificationIsTrusted = sourceVerification?.verified === true && sourceVerification?.status === 'verified' &&
    sourceVerification?.claimVerified === true && sourceVerification?.independenceVerified === true &&
    typeof sourceVerification?.providerId === 'string' && sourceVerification.providerId.trim() !== '' &&
    /^[a-f0-9]{64}$/.test(sourceVerification?.attestationId || '') &&
    /^[a-f0-9]{64}$/.test(sourceVerification?.trustRootSha256 || '') &&
    /^[a-f0-9]{64}$/.test(sourceVerification?.snapshotHash || '') &&
    /^[a-f0-9]{64}$/.test(sourceVerification?.evidenceManifestHash || '') &&
    typeof sourceVerification?.expiresAt === 'string' && Date.parse(sourceVerification.expiresAt) > Date.now();
  if (!isRecord(proposal) || proposal.kind !== 'adaptive_goal_execution_graph_proposal' ||
      proposal.schemaVersion !== ADAPTIVE_GOAL_EXECUTION_GRAPH_PROPOSAL_SCHEMA_VERSION || proposal.status !== 'review_required' ||
      !verifyAdaptiveGoalExecutionGraphProposalHash(proposal) ||
      !isRecord(proposal.source) || (!sourceVerificationIsUnverified && !sourceVerificationIsTrusted) ||
      !isRecord(proposal.workflowTemplate) || !Array.isArray(proposal.nodes) || !proposal.nodes.length ||
      !Array.isArray(proposal.edges) || !Array.isArray(proposal.bindings) ||
      !isRecord(proposal.gates) || proposal.gates.executionGraphMaterialized !== false ||
      proposal.gates.executableContractsCreated !== false || proposal.gates.immutableExecutionPlanCreated !== false ||
      proposal.gates.dispatchAllowed !== false || proposal.gates.executionAuthorized !== false) {
    fail('EXECUTION_PLAN_CANDIDATE_GRAPH_PROPOSAL_INVALID', 'input must be an intact, review-only Execution Graph proposal with all execution gates disabled');
  }
  assertHash(proposal.fingerprint, 'Execution Graph proposal fingerprint');
  assertHash(proposal.proposalHash, 'Execution Graph proposalHash');
  assertHash(proposal.source.draftHash, 'Plan Graph draft hash');
  assertHash(proposal.workflowTemplate.planHash, 'workflow template plan hash');
  assertHash(proposal.source.graphHash, 'source graph hash');
  assertString(proposal.source.planProposalJobId, 'source Plan Graph proposal job ID');
  assertString(proposal.workflowTemplate.id, 'workflow template ID');
  if (!Number.isSafeInteger(proposal.workflowTemplate.version) || proposal.workflowTemplate.version < 1) {
    fail('EXECUTION_PLAN_CANDIDATE_GRAPH_PROPOSAL_INVALID', 'workflow template version is invalid');
  }
}

/**
 * Adapt a freshly rebuilt Execution Graph review proposal onto the real
 * workflow compiler's existing immutable-plan contract. This returns a
 * candidate envelope; it neither persists a plan nor changes executable task
 * contracts. The embedded plan is exactly the trusted compiler output, while
 * AGG nodes are retained as a sidecar projection to existing child contracts.
 */
export function buildAdaptiveGoalExecutionPlanCandidate({
  jobId,
  proposalEventHash,
  executionGraphProposal,
  compiledPlan,
  preflight,
  reviewedActionIntents
}) {
  assertString(jobId, 'jobId');
  assertHash(proposalEventHash, 'proposalEventHash');
  validateGraphProposal(executionGraphProposal);
  validatePlanHash(compiledPlan);
  const reviewedTaskInputs = buildAdaptiveGoalReviewedTaskInputContract({ executionGraphProposal, reviewedActionIntents });
  if (!verifyAdaptiveGoalReviewedTaskInputContractHash(reviewedTaskInputs)) {
    fail('EXECUTION_PLAN_CANDIDATE_REVIEWED_TASK_INPUTS_HASH_MISMATCH', 'reviewed task input contract did not pass its own canonical hash verification');
  }
  const expectedActionIntentBindings = buildAdaptiveGoalCompilerActionIntentBindings(reviewedTaskInputs);
  const expectedIntentByTask = new Map(expectedActionIntentBindings.map(binding => [binding.taskId, binding.actionIntent]));

  if (compiledPlan.job_id !== jobId || compiledPlan.workflow_id !== executionGraphProposal.workflowTemplate.id ||
      compiledPlan.workflow_version !== executionGraphProposal.workflowTemplate.version) {
    fail('EXECUTION_PLAN_CANDIDATE_TEMPLATE_MISMATCH', 'compiler output does not match the proposal job ID and pinned built-in template identity');
  }
  if (!isRecord(preflight) || preflight.ready !== true || preflight.candidate_plan_hash !== compiledPlan.plan_hash ||
      preflight.workflow_id !== compiledPlan.workflow_id || preflight.workflow_version !== compiledPlan.workflow_version) {
    fail('EXECUTION_PLAN_CANDIDATE_PREFLIGHT_MISMATCH', 'normal workflow_preflight did not independently accept the exact same compiler plan hash and template identity');
  }
  if (preflight.required_operations?.length || preflight.workspace_write_scopes?.length) {
    fail('EXECUTION_PLAN_CANDIDATE_PERMISSION_SCOPE_UNSUPPORTED', 'Execution Graph review candidate must not introduce workspace-write permissions or operations');
  }

  const planTasks = [...compiledPlan.children, compiledPlan.synthesis];
  const planTasksById = new Map(planTasks.map(task => [task.id, task]));
  if (planTasksById.size !== planTasks.length) fail('EXECUTION_PLAN_CANDIDATE_PLAN_DUPLICATE_TASK', 'compiled plan contains duplicate task IDs');

  const bindingsByStep = new Map();
  const tasksToSteps = new Map();
  for (const binding of executionGraphProposal.bindings) {
    if (!isRecord(binding) || Object.keys(binding).sort().join(',') !== 'capability,role,roleContractId,roleContractVersion,stepId,taskId' ||
        typeof binding.stepId !== 'string' || typeof binding.taskId !== 'string' ||
        typeof binding.role !== 'string' || typeof binding.capability !== 'string' ||
        typeof binding.roleContractId !== 'string' || !Number.isSafeInteger(binding.roleContractVersion)) {
      fail('EXECUTION_PLAN_CANDIDATE_BINDING_INVALID', 'Execution Graph proposal contains an invalid explicit step/task/role/capability binding');
    }
    if (bindingsByStep.has(binding.stepId)) fail('EXECUTION_PLAN_CANDIDATE_DUPLICATE_STEP_BINDING', `Plan Graph step ${binding.stepId} is bound more than once`);
    if (tasksToSteps.has(binding.taskId)) fail('EXECUTION_PLAN_CANDIDATE_DUPLICATE_TASK_BINDING', `compiled workflow task ${binding.taskId} is bound to multiple AGG steps`);
    bindingsByStep.set(binding.stepId, binding);
    tasksToSteps.set(binding.taskId, binding.stepId);
  }
  if (bindingsByStep.size !== executionGraphProposal.nodes.length) {
    fail('EXECUTION_PLAN_CANDIDATE_BINDING_COVERAGE_MISMATCH', 'every Execution Graph node must have exactly one explicit mapping to a compiler task');
  }

  const nodesById = new Map();
  for (const node of executionGraphProposal.nodes) {
    if (!isRecord(node) || typeof node.id !== 'string' || !node.id || nodesById.has(node.id) ||
        typeof node.sourceStepId !== 'string' || !Array.isArray(node.dependencies) ||
        !isRecord(node.roleContract) || !isRecord(node.outputEvidenceContract) ||
        !isRecord(node.inputContract) || !isRecord(node.execution) || node.execution.enabled !== false ||
        node.execution.executable !== null || node.execution.args !== null || node.execution.authorization !== 'none') {
      fail('EXECUTION_PLAN_CANDIDATE_GRAPH_NODE_INVALID', 'Execution Graph proposal has a missing, duplicate, or execution-enabled node');
    }
    nodesById.set(node.id, node);
  }
  const expectedGraphEdges = [];
  for (const node of executionGraphProposal.nodes) {
    const seenDependencies = new Set();
    for (const dependencyId of node.dependencies) {
      if (typeof dependencyId !== 'string' || !nodesById.has(dependencyId) || dependencyId === node.id || seenDependencies.has(dependencyId)) {
        fail('EXECUTION_PLAN_CANDIDATE_GRAPH_DEPENDENCY_INVALID', `node ${node.id} has a missing, duplicate, self, or unknown dependency`);
      }
      seenDependencies.add(dependencyId);
      expectedGraphEdges.push({ from: dependencyId, to: node.id, type: 'depends_on' });
    }
  }
  const actualGraphEdges = executionGraphProposal.edges.map(edge => {
    if (!isRecord(edge) || typeof edge.from !== 'string' || typeof edge.to !== 'string' || edge.type !== 'depends_on') {
      fail('EXECUTION_PLAN_CANDIDATE_GRAPH_EDGE_INVALID', 'Execution Graph proposal contains a malformed dependency edge');
    }
    return { from: edge.from, to: edge.to, type: edge.type };
  });
  const edgeOrder = (a, b) => a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0;
  expectedGraphEdges.sort(edgeOrder);
  actualGraphEdges.sort(edgeOrder);
  if (canonicalJson(expectedGraphEdges) !== canonicalJson(actualGraphEdges)) {
    fail('EXECUTION_PLAN_CANDIDATE_GRAPH_EDGE_PROJECTION_MISMATCH', 'Execution Graph dependency node lists and edge list do not encode the exact same directed DAG');
  }

  const plannedProjection = [];
  const roleContractSnapshots = [];
  const artifactSchemaSnapshots = [];
  for (const node of executionGraphProposal.nodes) {
    if (!isRecord(node) || typeof node.id !== 'string' ||
        typeof node.sourceStepId !== 'string' || !isRecord(node.roleContract) || !isRecord(node.outputEvidenceContract) ||
        !isRecord(node.inputContract) || !isRecord(node.execution) || node.execution.enabled !== false ||
        node.execution.executable !== null || node.execution.args !== null || node.execution.authorization !== 'none') {
      fail('EXECUTION_PLAN_CANDIDATE_GRAPH_NODE_INVALID', 'Execution Graph proposal has a missing, duplicate, or execution-enabled node');
    }
    const binding = bindingsByStep.get(node.sourceStepId);
    if (!binding) fail('EXECUTION_PLAN_CANDIDATE_BINDING_MISSING', `Execution Graph step ${node.sourceStepId} has no explicit compiler task binding`);
    const task = planTasksById.get(binding.taskId);
    if (!task || task === compiledPlan.synthesis || !compiledPlan.children.some(child => child.id === task.id)) {
      fail('EXECUTION_PLAN_CANDIDATE_TASK_UNKNOWN', `binding task ${binding.taskId} is not a compiler child task`);
    }
    let contract;
    let expectedArtifactType;
    let expectedArtifactSchema;
    try {
      contract = getAgentContract(task.role);
      expectedArtifactType = task.execution?.output_artifact_type || getAgentArtifactType(task.role);
      expectedArtifactSchema = artifactSchemaForType(expectedArtifactType);
    } catch (error) {
      fail('EXECUTION_PLAN_CANDIDATE_ROLE_CONTRACT_UNSUPPORTED', `task ${task.id} has no supported immutable role/artifact contract: ${String(error?.message || error)}`);
    }
    if (task.role !== binding.role || task.capability !== binding.capability ||
        contract.id !== binding.roleContractId || contract.version !== binding.roleContractVersion ||
        node.roleContract.id !== contract.id || node.roleContract.version !== contract.version ||
        node.roleContract.role !== contract.role || node.roleContract.capability !== contract.capability ||
        canonicalJson(node.roleContract.requiredInputs) !== canonicalJson(contract.inputs) ||
        canonicalJson(node.roleContract.expectedOutputs) !== canonicalJson(contract.outputs) ||
        canonicalJson(node.roleContract.requiredCompletionCriteria) !== canonicalJson(contract.completionCriteria) ||
        !contract.outputs.includes(expectedArtifactType) || node.outputEvidenceContract.type !== expectedArtifactType ||
        node.outputEvidenceContract.schemaVersion !== expectedArtifactSchema.schema_version ||
        canonicalJson(node.outputEvidenceContract.requiredContentFields) !== canonicalJson(expectedArtifactSchema.required_content_fields)) {
      fail('EXECUTION_PLAN_CANDIDATE_ROLE_OR_ARTIFACT_CONTRACT_MISMATCH', `step ${node.sourceStepId} does not match compiler task ${task.id}'s immutable role, capability, output artifact and schema contracts`);
    }
    const requiredArtifactInputs = contract.inputs.filter(type => type !== 'job.request');
    if (canonicalJson(sorted(node.inputContract.requiredArtifactTypes || [])) !== canonicalJson(sorted(requiredArtifactInputs)) ||
        requiredArtifactInputs.some(type => !Array.isArray(node.inputContract.availableArtifactTypes) || !node.inputContract.availableArtifactTypes.includes(type))) {
      fail('EXECUTION_PLAN_CANDIDATE_INPUT_SCHEMA_MISMATCH', `step ${node.sourceStepId} does not expose every artifact input required by compiler task ${task.id}`);
    }
    const nodeEdges = executionGraphProposal.edges.filter(edge => edge.to === node.id);
    if (!Array.isArray(task.dependencies)) fail('EXECUTION_PLAN_CANDIDATE_DEPENDENCY_INVALID', `compiler task ${task.id} has no dependency array`);
    const ancestors = taskAncestorIds(task.id, planTasksById);
    const mappedAncestorOutputStepIds = new Set((node.inputContract.mappedAncestorOutputs || []).map(output => output.stepId));
    for (const parentStepId of mappedAncestorOutputStepIds) {
      if (!bindingsByStep.has(parentStepId) || !ancestors.has(bindingsByStep.get(parentStepId).taskId)) {
        fail('EXECUTION_PLAN_CANDIDATE_INPUT_ANCESTRY_MISMATCH', `step ${node.sourceStepId} claims input provenance from non-ancestor step ${parentStepId}`);
      }
    }
    plannedProjection.push({
      nodeId: node.id,
      sourceStepId: node.sourceStepId,
      compilerTaskId: task.id,
      role: task.role,
      capability: task.capability,
      roleContract: { id: contract.id, version: contract.version },
      outputEvidenceContract: {
        type: expectedArtifactType,
        schemaVersion: expectedArtifactSchema.schema_version,
        requiredContentFields: [...expectedArtifactSchema.required_content_fields]
      },
      inputArtifactTypes: sorted(requiredArtifactInputs),
      dependencyTaskIds: [...task.dependencies],
      mappedPlanGraphDependencies: nodeEdges.map(edge => ({
        fromNodeId: edge.from,
        toNodeId: edge.to,
        fromTaskId: bindingsByStep.get(nodesById.get(edge.from)?.sourceStepId)?.taskId || null,
        toTaskId: task.id,
        type: edge.type
      })).sort((a, b) => a.fromNodeId < b.fromNodeId ? -1 : a.fromNodeId > b.fromNodeId ? 1 : 0)
    });
    roleContractSnapshots.push({ stepId: node.sourceStepId, taskId: task.id, contract: {
      id: contract.id, version: contract.version, role: contract.role, capability: contract.capability,
      inputs: [...contract.inputs], outputs: [...contract.outputs], completionCriteria: [...contract.completionCriteria],
      actionIntentContract: {
        schemaVersion: contract.actionIntentContract.schemaVersion,
        operations: [...contract.actionIntentContract.operations],
        targetKinds: [...contract.actionIntentContract.targetKinds],
        maxDescriptionLength: contract.actionIntentContract.maxDescriptionLength,
        minSuccessCriteria: contract.actionIntentContract.minSuccessCriteria,
        maxSuccessCriteria: contract.actionIntentContract.maxSuccessCriteria,
        maxSuccessCriterionLength: contract.actionIntentContract.maxSuccessCriterionLength
      }
    } });
    artifactSchemaSnapshots.push({ stepId: node.sourceStepId, taskId: task.id, artifactType: expectedArtifactType,
      schemaVersion: expectedArtifactSchema.schema_version, requiredContentFields: [...expectedArtifactSchema.required_content_fields] });
  }

  if ([...bindingsByStep.keys()].some(stepId => !executionGraphProposal.nodes.some(node => node.sourceStepId === stepId))) {
    fail('EXECUTION_PLAN_CANDIDATE_BINDING_ORPHAN', 'Execution Graph proposal has a binding without a corresponding node');
  }

  const projectedEdges = [];
  for (const edge of executionGraphProposal.edges) {
    if (!isRecord(edge) || edge.type !== 'depends_on' || !nodesById.has(edge.from) || !nodesById.has(edge.to) || edge.from === edge.to) {
      fail('EXECUTION_PLAN_CANDIDATE_GRAPH_EDGE_INVALID', 'Execution Graph proposal contains an invalid or unresolved dependency edge');
    }
    const fromNode = nodesById.get(edge.from);
    const toNode = nodesById.get(edge.to);
    const fromBinding = bindingsByStep.get(fromNode.sourceStepId);
    const toBinding = bindingsByStep.get(toNode.sourceStepId);
    const ancestors = taskAncestorIds(toBinding.taskId, planTasksById);
    if (!ancestors.has(fromBinding.taskId)) {
      fail('EXECUTION_PLAN_CANDIDATE_DEPENDENCY_NOT_PRESERVED', `compiled plan task ${toBinding.taskId} does not depend on ancestor task ${fromBinding.taskId} required by Execution Graph edge ${edge.from} -> ${edge.to}`);
    }
    projectedEdges.push({ fromNodeId: edge.from, toNodeId: edge.to, fromTaskId: fromBinding.taskId, toTaskId: toBinding.taskId, type: 'depends_on' });
  }

  plannedProjection.sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0);
  projectedEdges.sort((a, b) => a.fromNodeId < b.fromNodeId ? -1 : a.fromNodeId > b.fromNodeId ? 1 : a.toNodeId < b.toNodeId ? -1 : a.toNodeId > b.toNodeId ? 1 : 0);
  roleContractSnapshots.sort((a, b) => a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0);
  artifactSchemaSnapshots.sort((a, b) => a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0);
  const sourceEvidenceSnapshot = executionGraphProposal.evidenceSnapshot;
  if (!Array.isArray(sourceEvidenceSnapshot) || sourceEvidenceSnapshot.length === 0 || sourceEvidenceSnapshot.some(item => !isRecord(item) ||
      typeof item.reference !== 'string' || !item.reference || typeof item.sourceJobId !== 'string' || !/^job_[a-f0-9-]{36}$/.test(item.sourceJobId) || !SHA256.test(item.contentHash || '') ||
      typeof item.artifactId !== 'string' || !item.artifactId || typeof item.artifactCreatedEventId !== 'string' || !item.artifactCreatedEventId ||
      typeof item.producerResultId !== 'string' || !item.producerResultId || item.producerResultOutcome !== 'success' ||
      typeof item.producerCompletionEventId !== 'string' || !item.producerCompletionEventId)) {
    fail('EXECUTION_PLAN_CANDIDATE_EVIDENCE_SNAPSHOT_INVALID', 'Execution Graph proposal lacks exact verified durable evidence and result/completion-event lineage');
  }
  const verifiedEvidenceByReference = new Map();
  for (const evidence of sourceEvidenceSnapshot) {
    if (verifiedEvidenceByReference.has(evidence.reference)) {
      fail('EXECUTION_PLAN_CANDIDATE_EVIDENCE_DUPLICATE', `durable evidence reference ${evidence.reference} appears more than once in the candidate snapshot`);
    }
    verifiedEvidenceByReference.set(evidence.reference, evidence);
  }
  const sourceFileIntegritySnapshot = executionGraphProposal.sourceEvidenceSnapshot;
  if (!Array.isArray(sourceFileIntegritySnapshot) || sourceFileIntegritySnapshot.some(item => !isRecord(item) ||
      typeof item.reference !== 'string' || !item.reference.startsWith('file:') ||
      item.classification !== 'source_bytes_verified_claim_unverified' || item.integrityVerified !== true ||
      item.claimVerified !== false || item.independenceVerified !== false || typeof item.path !== 'string' ||
      !SHA256.test(item.expectedSha256 || '') || item.observedSha256 !== item.expectedSha256 ||
      !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0)) {
    fail('EXECUTION_PLAN_CANDIDATE_SOURCE_EVIDENCE_INVALID', 'source-file integrity snapshot is invalid or incorrectly claims semantic/independent verification');
  }
  const sourceFileReferences = sourceFileIntegritySnapshot.map(item => item.reference);
  if (new Set(sourceFileReferences).size !== sourceFileReferences.length ||
      sourceFileReferences.some((reference, index) => index > 0 && sourceFileReferences[index - 1] >= reference)) {
    fail('EXECUTION_PLAN_CANDIDATE_SOURCE_EVIDENCE_ORDER_INVALID', 'source-file integrity snapshot must have unique references in canonical order');
  }
  for (const node of executionGraphProposal.nodes) {
    if (!node.supportingEvidence || node.supportingEvidence.verified !== true || !Array.isArray(node.supportingEvidence.artifacts)) {
      fail('EXECUTION_PLAN_CANDIDATE_EVIDENCE_UNVERIFIED', `Execution Graph node ${node.id} does not carry verified durable evidence records`);
    }
    for (const evidence of node.supportingEvidence.artifacts) {
      const durable = verifiedEvidenceByReference.get(evidence.reference);
      if (!durable || durable.sourceJobId !== evidence.sourceJobId || durable.artifactId !== evidence.artifactId || durable.contentHash !== evidence.contentHash ||
          durable.artifactCreatedEventId !== evidence.artifactCreatedEventId || durable.producerResultId !== evidence.producerResultId ||
          durable.producerCompletionEventId !== evidence.producerCompletionEventId) {
        fail('EXECUTION_PLAN_CANDIDATE_EVIDENCE_REFERENCE_MISMATCH', `node ${node.id} evidence reference ${evidence.reference} does not match the deduplicated durable evidence snapshot`);
      }
    }
    const nodeSources = node.supportingEvidence.sourceFiles || [];
    if (!Array.isArray(nodeSources) || nodeSources.some(item => !isRecord(item))) {
      fail('EXECUTION_PLAN_CANDIDATE_SOURCE_EVIDENCE_INVALID', `node ${node.id} has an invalid source-file evidence array`);
    }
    for (const source of nodeSources) {
      const pinnedSource = sourceFileIntegritySnapshot.find(item => item.reference === source.reference);
      if (!pinnedSource || canonicalJson(pinnedSource) !== canonicalJson(source) ||
          source.integrityVerified !== true || source.claimVerified !== false || source.independenceVerified !== false) {
        fail('EXECUTION_PLAN_CANDIDATE_SOURCE_EVIDENCE_REFERENCE_MISMATCH', `node ${node.id} source file ${source.reference} differs from the pinned current source integrity snapshot`);
      }
    }
  }
  for (const child of compiledPlan.children) {
    const expectedIntent = expectedIntentByTask.get(child.id);
    if (expectedIntent && canonicalJson(child.execution?.action_intent) !== canonicalJson(expectedIntent)) {
      fail('EXECUTION_PLAN_CANDIDATE_ACTION_INTENT_PLAN_MISMATCH', `compiled plan does not contain the exact typed action-intent input for task ${child.id}`);
    }
    if (!expectedIntent && Object.hasOwn(child.execution || {}, 'action_intent')) {
      fail('EXECUTION_PLAN_CANDIDATE_UNMAPPED_ACTION_INTENT', `compiled plan contains an action-intent binding for unmapped task ${child.id}`);
    }
  }
  for (const taskId of expectedIntentByTask.keys()) {
    if (!compiledPlan.children.some(child => child.id === taskId)) {
      fail('EXECUTION_PLAN_CANDIDATE_ACTION_INTENT_TASK_MISSING', `compiled plan is missing action-intent task ${taskId}`);
    }
  }
  const evidenceHash = hash(sourceEvidenceSnapshot);
  const sourceEvidenceHash = hash(sourceFileIntegritySnapshot);
  const normalizedBindings = executionGraphProposal.bindings.map(binding => ({
    stepId: binding.stepId, taskId: binding.taskId, role: binding.role, capability: binding.capability,
    roleContractId: binding.roleContractId, roleContractVersion: binding.roleContractVersion
  })).sort((a, b) => a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0);
  const bindingHash = hash(normalizedBindings);
  const dependencyHash = hash({ edges: projectedEdges, projection: plannedProjection.map(node => ({ nodeId: node.nodeId, taskId: node.compilerTaskId, dependencies: node.dependencyTaskIds })) });
  const roleContractHash = hash(roleContractSnapshots);
  const artifactSchemaHash = hash(artifactSchemaSnapshots);
  const reviewedTaskInputBindingsHash = hash(reviewedTaskInputs.actions.map(action => ({
    stepId: action.stepId, taskId: action.taskId, roleContract: action.roleContract, taskInputBindings: action.taskInputBindings
  })));
  const reviewedTaskDependencyHash = hash(reviewedTaskInputs.actions.map(action => ({ stepId: action.stepId, taskId: action.taskId, dependencies: action.dependencies })));
  const reviewedTaskEvidenceProvenanceHash = hash(reviewedTaskInputs.actions.map(action => ({ stepId: action.stepId, taskId: action.taskId, evidenceProvenance: action.evidenceProvenance })));
  const semanticVerificationHash = hash(reviewedTaskInputs.actions.map(action => ({
    stepId: action.stepId, taskId: action.taskId, semanticVerification: action.semanticVerification
  })));
  const compilerActionIntentBindingHash = hash(expectedActionIntentBindings);
  const hashes = {
    executionGraphFingerprint: executionGraphProposal.fingerprint,
    executionGraphProposalHash: executionGraphProposal.proposalHash,
    proposalEventHash,
    compilerPlanHash: compiledPlan.plan_hash,
    evidenceHash,
    sourceEvidenceHash,
    bindingHash,
    dependencyHash,
    roleContractHash,
    artifactSchemaHash,
    reviewedActionIntentHash: reviewedTaskInputs.reviewedActionIntentHash,
    reviewedTaskInputContractHash: reviewedTaskInputs.contractHash,
    reviewedTaskInputBindingsHash,
    reviewedTaskDependencyHash,
    reviewedTaskEvidenceProvenanceHash,
    compilerActionIntentBindingHash,
    semanticPolicyVersion: 1,
    semanticVerificationHash
  };
  const fingerprint = hash({
    schemaVersion: ADAPTIVE_GOAL_EXECUTION_PLAN_CANDIDATE_SCHEMA_VERSION,
    jobId,
    workflowId: compiledPlan.workflow_id,
    workflowVersion: compiledPlan.workflow_version,
    hashes
  });
  const candidateId = `agg-epc-${fingerprint.slice(0, 24)}`;
  const unsignedCandidate = {
    schemaVersion: ADAPTIVE_GOAL_EXECUTION_PLAN_CANDIDATE_SCHEMA_VERSION,
    kind: 'adaptive_goal_execution_plan_candidate',
    status: 'review_required',
    candidateId,
    fingerprint,
    source: {
      executionGraphProposalJobId: jobId,
      executionGraphFingerprint: executionGraphProposal.fingerprint,
      executionGraphProposalHash: executionGraphProposal.proposalHash,
      proposalEventHash,
      sourcePlanProposalJobId: executionGraphProposal.source.planProposalJobId,
      sourceGraphHash: executionGraphProposal.source.graphHash,
      planGraphDraftHash: executionGraphProposal.source.draftHash,
      sourceCandidateId: executionGraphProposal.source.candidatePlanId,
      verification: { status: 'unverified', verified: false }
    },
    compiler: {
      workflowId: compiledPlan.workflow_id,
      workflowVersion: compiledPlan.workflow_version,
      planSchemaVersion: compiledPlan.schema_version,
      compilerPlanHash: compiledPlan.plan_hash,
      preflightCandidatePlanHash: preflight.candidate_plan_hash,
      validator: 'validateExecutionPlan',
      typedActionIntentBindings: expectedActionIntentBindings.length
    },
    executionPlan: compiledPlan,
    actionProjection: plannedProjection,
    reviewedTaskInputs,
    dependencyEdges: projectedEdges,
    evidenceSnapshot: sourceEvidenceSnapshot.map(item => ({ ...item })),
    sourceEvidenceSnapshot: sourceFileIntegritySnapshot.map(item => ({ ...item })),
    hashes,
    gates: {
      humanReviewRequired: true,
      workflowApprovalRequired: true,
      actionIntentSemanticEquivalenceVerified: true,
      actionIntentSemanticPolicyVersion: 1,
      reviewerIdentityVerified: false,
      executionEligible: false,
      executionGraphMaterialized: false,
      aggActionsExecutable: false,
      immutableExecutionPlanCreated: false,
      dispatchAllowed: false,
      executionAuthorized: false
    },
    interpretation: 'This candidate contains the exact built-in compiler output with a versioned typed execution.action_intent extension on explicitly mapped role tasks, including hashed artifact/ancestor input bindings. The role operation vocabulary constrains intent types but does not prove semantic equivalence of free-form descriptions, and the caller-supplied reviewer identity is not authenticated. The action intent is only surfaced to a host task after the exact compiled plan is separately human-approved and workflow_prepare_tasks revalidates/materializes its inputs. No command/arguments are derived; this candidate itself does not pin an immutable plan, approve, create tasks, dispatch, or authorize execution.'
  };
  const candidateHash = hash(unsignedCandidate);
  return { ...unsignedCandidate, candidateHash };
}

export function verifyAdaptiveGoalExecutionPlanCandidateHash(candidate) {
  if (!isRecord(candidate) || !SHA256.test(candidate.candidateHash || '')) return false;
  const { candidateHash, ...unsigned } = candidate;
  return hash(unsigned) === candidateHash;
}
