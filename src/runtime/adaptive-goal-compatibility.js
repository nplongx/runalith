import { createHash } from 'node:crypto';

export const ADAPTIVE_GOAL_COMPATIBILITY_SCHEMA_VERSION = 1;

export const ADAPTIVE_GOAL_COMPATIBLE_WORKFLOW_IDS = Object.freeze([
  'standard-engineering',
  'hybrid-engineering',
  'engineering',
  'production'
]);

const WORKFLOW_ID_SET = new Set(ADAPTIVE_GOAL_COMPATIBLE_WORKFLOW_IDS);
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const STEP_ID = /^agg-step-[a-f0-9]{24}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CANDIDATE_ID = /^agg-[a-f0-9]{24}$/;
const NODE_TYPES = new Set(['goal', 'idea', 'hypothesis', 'candidate', 'experiment', 'capability', 'evidence', 'condition', 'task']);
const CONTEXT_NODE_TYPES = new Set(['goal', 'idea', 'hypothesis', 'candidate', 'capability', 'evidence', 'condition']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function exactKeys(value, allowed, field) {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  const actual = sortedKeys(value);
  const expected = [...allowed].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new TypeError(`${field} must contain exactly these fields: ${expected.join(', ')}`);
  }
}

function requiredKeys(value, required, field, optional = []) {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  const unsupported = actual.filter(key => !allowed.has(key));
  const missing = required.filter(key => !Object.hasOwn(value, key));
  if (unsupported.length || missing.length) {
    throw new TypeError(`${field} has unsupported fields [${unsupported.sort().join(', ')}] or missing fields [${missing.sort().join(', ')}]`);
  }
}

function assertString(value, field, { min = 1, max = 512, pattern = null } = {}) {
  if (typeof value !== 'string' || value.trim() !== value || value.length < min || value.length > max || (pattern && !pattern.test(value))) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function assertFiniteNumber(value, field, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`${field} must be a finite number in ${min}..${max}`);
  }
}

function assertNullableFiniteNumber(value, field, min, max) {
  if (value === null) return;
  assertFiniteNumber(value, field, min, max);
}

function validateEvidenceAssessment(assessment, field) {
  if (!isRecord(assessment)) throw new TypeError(`${field} must be an object`);
  exactKeys(assessment, ['status', 'references', 'verifiedReferenceCount'], field);
  if (!['missing', 'placeholder_only', 'declared_unverified'].includes(assessment.status) ||
      !Array.isArray(assessment.references) || assessment.references.length > 64 || assessment.verifiedReferenceCount !== 0) {
    throw new TypeError(`${field} must keep all declared references unverified`);
  }
  const references = new Set();
  for (const [index, reference] of assessment.references.entries()) {
    exactKeys(reference, ['reference', 'classification', 'verified'], `${field}.references[${index}]`);
    assertString(reference.reference, `${field}.references[${index}].reference`, { max: 512 });
    if (!['placeholder_not_evidence', 'content_addressed_source_unverified', 'durable_artifact_unverified', 'unresolved_reference'].includes(reference.classification) || reference.verified !== false) {
      throw new TypeError(`${field}.references[${index}] attempts to elevate unverified evidence`);
    }
    if (references.has(reference.reference)) throw new TypeError(`${field}.references contains duplicate reference`);
    references.add(reference.reference);
  }
  const expectedStatus = references.size === 0 ? 'missing' :
    assessment.references.every(reference => reference.classification === 'placeholder_not_evidence') ? 'placeholder_only' : 'declared_unverified';
  if (assessment.status !== expectedStatus) throw new TypeError(`${field}.status does not match its declared references`);
}

function stringList(value, field, { maxItems = 500, pattern = null } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) throw new TypeError(`${field} must be an array of at most ${maxItems} entries`);
  const seen = new Set();
  value.forEach((item, index) => {
    assertString(item, `${field}[${index}]`, { max: 512, pattern });
    if (seen.has(item)) throw new TypeError(`${field} contains duplicate entry ${item}`);
    seen.add(item);
  });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${sortedKeys(value).map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validateDraft(draft) {
  exactKeys(draft, [
    'schemaVersion', 'kind', 'status', 'source', 'goal', 'sourcePathNodeIds',
    'contextNodes', 'steps', 'gates', 'draftHash'
  ], 'draft');
  if (draft.schemaVersion !== 1 || draft.kind !== 'adaptive_goal_plan_graph_draft' || draft.status !== 'review_required') {
    throw new TypeError('draft schemaVersion, kind, or review_required status is invalid');
  }
  if (!isRecord(draft.source)) throw new TypeError('draft.source must be an object');
  exactKeys(draft.source, ['mode', 'graphHash', 'candidatePlanId', 'candidateStatus', 'verification', 'searchStatus', 'searchExhaustive'], 'draft.source');
  if (draft.source.mode !== 'shadow' || !SHA256.test(draft.source.graphHash || '') ||
      !CANDIDATE_ID.test(draft.source.candidatePlanId || '') || draft.source.candidateStatus !== 'proposed' ||
      !['proposals_found', 'budget_exhausted', 'max_depth_reached'].includes(draft.source.searchStatus) ||
      typeof draft.source.searchExhaustive !== 'boolean') {
    throw new TypeError('draft.source does not identify a complete AGG shadow candidate');
  }
  if (!isRecord(draft.source.verification)) throw new TypeError('draft.source.verification must be an object');
  const sourceVerificationKeys = Object.keys(draft.source.verification).sort().join(',');
  if (sourceVerificationKeys === 'status,verified') {
    if (draft.source.verification.status !== 'unverified' || draft.source.verification.verified !== false) {
      throw new TypeError('the default Plan Graph source verification must remain explicitly unverified');
    }
  } else {
    const expectedVerifiedKeys = [
      'status', 'verified', 'providerId', 'attestationId', 'trustRootSha256', 'snapshotHash', 'evidenceManifestHash',
      'issuedAt', 'expiresAt', 'claimVerified', 'independenceVerified', 'verifiedNodeCount', 'verifiedEdgeCount', 'verifiedMembershipCount'
    ].sort().join(',');
    if (sourceVerificationKeys !== expectedVerifiedKeys || draft.source.verification.status !== 'verified' ||
        draft.source.verification.verified !== true || typeof draft.source.verification.providerId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(draft.source.verification.attestationId || '') ||
        !/^[a-f0-9]{64}$/.test(draft.source.verification.trustRootSha256 || '') ||
        !/^[a-f0-9]{64}$/.test(draft.source.verification.snapshotHash || '') ||
        !/^[a-f0-9]{64}$/.test(draft.source.verification.evidenceManifestHash || '') ||
        draft.source.verification.claimVerified !== true || draft.source.verification.independenceVerified !== true ||
        typeof draft.source.verification.issuedAt !== 'string' || typeof draft.source.verification.expiresAt !== 'string' ||
        !Number.isSafeInteger(draft.source.verification.verifiedNodeCount) || draft.source.verification.verifiedNodeCount < 1 ||
        !Number.isSafeInteger(draft.source.verification.verifiedEdgeCount) || draft.source.verification.verifiedEdgeCount < 0 ||
        !Number.isSafeInteger(draft.source.verification.verifiedMembershipCount) || draft.source.verification.verifiedMembershipCount < 1) {
      throw new TypeError('draft.source.verification must be either explicitly unverified or contain the exact trusted-verifier attestation metadata schema');
    }
  }

  if (!isRecord(draft.goal)) throw new TypeError('draft.goal must be an object');
  requiredKeys(draft.goal, ['nodeId'], 'draft.goal', ['label']);
  assertString(draft.goal.nodeId, 'draft.goal.nodeId', { pattern: SLUG, max: 80 });
  if (Object.hasOwn(draft.goal, 'label')) assertString(draft.goal.label, 'draft.goal.label', { min: 0, max: 500 });

  stringList(draft.sourcePathNodeIds, 'draft.sourcePathNodeIds', { maxItems: 500, pattern: SLUG });
  if (draft.sourcePathNodeIds.length < 2 || draft.sourcePathNodeIds.at(-1) !== draft.goal.nodeId) {
    throw new TypeError('draft source path must contain at least two nodes and end at the declared goal');
  }
  if (!Array.isArray(draft.contextNodes) || draft.contextNodes.length > 500) throw new TypeError('draft.contextNodes must be an array of at most 500 entries');
  const contextIds = new Set();
  for (const [index, context] of draft.contextNodes.entries()) {
    requiredKeys(context, ['id', 'type', 'supportingEvidenceRefs'], 'draft.contextNodes[' + index + ']', ['label', 'evidenceAssessment']);
    assertString(context.id, `draft.contextNodes[${index}].id`, { pattern: SLUG, max: 80 });
    if (!CONTEXT_NODE_TYPES.has(context.type)) throw new TypeError(`draft.contextNodes[${index}].type is not a non-action context type`);
    if (Object.hasOwn(context, 'label')) assertString(context.label, `draft.contextNodes[${index}].label`, { min: 0, max: 500 });
    stringList(context.supportingEvidenceRefs, `draft.contextNodes[${index}].supportingEvidenceRefs`, { maxItems: 64 });
    if (context.evidenceAssessment !== undefined) validateEvidenceAssessment(context.evidenceAssessment, `draft.contextNodes[${index}].evidenceAssessment`);
    if (contextIds.has(context.id)) throw new TypeError(`draft.contextNodes contains duplicate node ${context.id}`);
    contextIds.add(context.id);
    if (!draft.sourcePathNodeIds.includes(context.id)) throw new TypeError(`context node ${context.id} is not in the source path`);
  }

  if (!Array.isArray(draft.steps) || draft.steps.length < 1 || draft.steps.length > 500) {
    throw new TypeError('draft.steps must contain 1..500 proposed action steps');
  }
  const stepIds = new Set();
  const stepSourceIds = new Set();
  const indexByStepId = new Map();
  let lastSourcePosition = 0;
  const pathIndex = new Map(draft.sourcePathNodeIds.map((id, index) => [id, index]));
  for (const [index, step] of draft.steps.entries()) {
    requiredKeys(step, ['id', 'sourceNodeId', 'kind', 'title', 'dependencies', 'estimates', 'supportingEvidenceRefs', 'execution', 'status'], `draft.steps[${index}]`, ['evidenceAssessment']);
    assertString(step.id, `draft.steps[${index}].id`, { pattern: STEP_ID, max: 80 });
    assertString(step.sourceNodeId, `draft.steps[${index}].sourceNodeId`, { pattern: SLUG, max: 80 });
    if (!['task', 'experiment'].includes(step.kind)) throw new TypeError(`draft.steps[${index}].kind is not actionable`);
    assertString(step.title, `draft.steps[${index}].title`, { max: 500 });
    if (step.status !== 'proposed') throw new TypeError(`draft.steps[${index}] is not in proposed status`);
    if (stepIds.has(step.id) || stepSourceIds.has(step.sourceNodeId)) throw new TypeError(`draft step IDs/source node IDs must be unique (step ${step.id})`);
    stepIds.add(step.id);
    stepSourceIds.add(step.sourceNodeId);
    indexByStepId.set(step.id, index);
    const sourcePosition = pathIndex.get(step.sourceNodeId);
    if (sourcePosition === undefined || sourcePosition <= 0 || sourcePosition >= draft.sourcePathNodeIds.length - 1 || sourcePosition <= lastSourcePosition) {
      throw new TypeError(`draft step ${step.id} is not ordered within the source path`);
    }
    lastSourcePosition = sourcePosition;

    stringList(step.dependencies, `draft.steps[${index}].dependencies`, { maxItems: 500, pattern: STEP_ID });
    if (!isRecord(step.estimates)) throw new TypeError(`draft.steps[${index}].estimates must be an object`);
    requiredKeys(step.estimates, ['cost', 'risk', 'successConfidence'], `draft.steps[${index}].estimates`, ['reusePotential', 'informationValue', 'metricProvenance']);
    assertNullableFiniteNumber(step.estimates.cost, `draft.steps[${index}].estimates.cost`, 0, 1e9);
    assertNullableFiniteNumber(step.estimates.risk, `draft.steps[${index}].estimates.risk`, 0, 1);
    assertNullableFiniteNumber(step.estimates.successConfidence, `draft.steps[${index}].estimates.successConfidence`, 0, 1);
    if (step.estimates.reusePotential !== undefined) assertNullableFiniteNumber(step.estimates.reusePotential, `draft.steps[${index}].estimates.reusePotential`, 0, 1);
    if (step.estimates.informationValue !== undefined) assertNullableFiniteNumber(step.estimates.informationValue, `draft.steps[${index}].estimates.informationValue`, 0, 1);
    if (step.estimates.metricProvenance !== undefined) {
      exactKeys(step.estimates.metricProvenance, ['estimatedCost', 'estimatedRisk', 'estimatedSuccessConfidence', 'reusePotential', 'informationValue'], `draft.steps[${index}].estimates.metricProvenance`);
      for (const [metric, metadata] of Object.entries(step.estimates.metricProvenance)) {
        exactKeys(metadata, ['classification', 'method', 'sourceRefs', 'confidence', 'provenanceVerified'], `draft.steps[${index}].estimates.metricProvenance.${metric}`);
        if (!['unknown', 'caller_estimate_unverified'].includes(metadata.classification) || metadata.provenanceVerified !== false ||
            (metadata.method !== null && typeof metadata.method !== 'string') ||
            (metadata.confidence !== null && (typeof metadata.confidence !== 'number' || !Number.isFinite(metadata.confidence) || metadata.confidence < 0 || metadata.confidence > 1))) {
          throw new TypeError(`draft.steps[${index}].estimates.metricProvenance.${metric} is not an honest unverified metric record`);
        }
        stringList(metadata.sourceRefs, `draft.steps[${index}].estimates.metricProvenance.${metric}.sourceRefs`, { maxItems: 16 });
      }
    }
    stringList(step.supportingEvidenceRefs, `draft.steps[${index}].supportingEvidenceRefs`, { maxItems: 64 });
    if (step.evidenceAssessment !== undefined) validateEvidenceAssessment(step.evidenceAssessment, `draft.steps[${index}].evidenceAssessment`);

    if (!isRecord(step.execution)) throw new TypeError(`draft.steps[${index}].execution must be an object`);
    exactKeys(step.execution, ['enabled', 'authorization', 'executable', 'args'], `draft.steps[${index}].execution`);
    if (step.execution.enabled !== false || step.execution.authorization !== 'none' ||
        step.execution.executable !== null || step.execution.args !== null) {
      throw new TypeError(`draft.steps[${index}] contains execution metadata or authorization`);
    }
  }
  for (const [index, step] of draft.steps.entries()) {
    for (const dependencyId of step.dependencies) {
      if (!stepIds.has(dependencyId)) throw new TypeError(`step ${step.id} references missing dependency ${dependencyId}`);
      if (indexByStepId.get(dependencyId) >= index) throw new TypeError(`step ${step.id} dependency ${dependencyId} must precede it`);
    }
  }
  if (contextIds.size && [...contextIds].some(id => stepSourceIds.has(id))) {
    throw new TypeError('a source node cannot be both a context node and an action step');
  }

  if (!isRecord(draft.gates)) throw new TypeError('draft.gates must be an object');
  exactKeys(draft.gates, [
    'humanReviewRequired', 'workflowApprovalRequired', 'immutableExecutionPlanCreated', 'dispatchAllowed', 'executionAuthorized'
  ], 'draft.gates');
  if (draft.gates.humanReviewRequired !== true || draft.gates.workflowApprovalRequired !== true ||
      draft.gates.immutableExecutionPlanCreated !== false || draft.gates.dispatchAllowed !== false ||
      draft.gates.executionAuthorized !== false) {
    throw new TypeError('draft review/approval/execution gates are absent or weakened');
  }

  assertString(draft.draftHash, 'draft.draftHash', { pattern: SHA256, max: 64 });
  const { draftHash, ...unsignedDraft } = draft;
  if (sha256(stableJson(unsignedDraft)) !== draftHash) throw new TypeError('draftHash does not match the exact draft contents');
  return { stepIds: [...stepIds], indexByStepId, steps: draft.steps };
}

function validateWorkflowPlan(plan, workflowId) {
  if (!isRecord(plan) || plan.workflow_id !== workflowId || !Number.isSafeInteger(plan.workflow_version) || plan.workflow_version < 1 ||
      typeof plan.job_id !== 'string' || !plan.job_id || !Array.isArray(plan.children) || typeof plan.plan_hash !== 'string' || !SHA256.test(plan.plan_hash)) {
    throw new TypeError('compiled workflow template has an invalid identity or shape');
  }
  const { plan_hash, ...unsignedPlan } = plan;
  if (sha256(stableJson(unsignedPlan)) !== plan_hash) throw new TypeError('compiled workflow template plan_hash does not match its contents');
  const children = new Map();
  for (const [index, child] of plan.children.entries()) {
    if (!isRecord(child) || typeof child.id !== 'string' || !SLUG.test(child.id) || typeof child.role !== 'string' ||
        !child.role || !Array.isArray(child.dependencies) || children.has(child.id)) {
      throw new TypeError(`compiled workflow child ${index} is invalid or duplicated`);
    }
    children.set(child.id, child);
  }
  for (const child of children.values()) {
    const dependencySet = new Set();
    for (const dependency of child.dependencies) {
      if (typeof dependency !== 'string' || !children.has(dependency) || dependency === child.id || dependencySet.has(dependency)) {
        throw new TypeError(`compiled workflow dependency is invalid: ${child.id} -> ${dependency}`);
      }
      dependencySet.add(dependency);
    }
  }
  const memo = new Map();
  function ancestors(taskId, visiting = new Set()) {
    if (memo.has(taskId)) return memo.get(taskId);
    if (visiting.has(taskId)) throw new TypeError(`compiled workflow dependency cycle at ${taskId}`);
    const child = children.get(taskId);
    if (!child) return new Set();
    const nextVisiting = new Set(visiting);
    nextVisiting.add(taskId);
    const result = new Set();
    for (const dependency of child.dependencies) {
      result.add(dependency);
      for (const ancestor of ancestors(dependency, nextVisiting)) result.add(ancestor);
    }
    memo.set(taskId, result);
    return result;
  }
  for (const taskId of children.keys()) ancestors(taskId);
  return { children, ancestors };
}

function blocker(code, message, extra = {}) {
  return { code, message, ...extra };
}

/**
 * Assess whether a review-only AGG draft can be represented by an explicit
 * mapping into a supported compiled workflow template. This is a pure report:
 * it never creates a proposal, persists a plan, approves, or dispatches.
 */
export function assessAdaptiveGoalPlanCompatibility(draft, workflowId, workflowPlan, taskBindings = [], options = {}) {
  const blockers = [];
  const requireCompleteTaskMapping = options?.requireCompleteTaskMapping === true;
  let validatedDraft = null;
  try {
    validatedDraft = validateDraft(draft);
  } catch (error) {
    blockers.push(blocker('DRAFT_INVALID', String(error?.message || error)));
  }

  if (typeof workflowId !== 'string' || !WORKFLOW_ID_SET.has(workflowId)) {
    blockers.push(blocker('UNSUPPORTED_WORKFLOW', `workflow_id must be one of: ${ADAPTIVE_GOAL_COMPATIBLE_WORKFLOW_IDS.join(', ')}`, { workflowId: workflowId ?? null }));
  }

  let validatedPlan = null;
  if (workflowId && WORKFLOW_ID_SET.has(workflowId)) {
    try {
      validatedPlan = validateWorkflowPlan(workflowPlan, workflowId);
    } catch (error) {
      blockers.push(blocker('WORKFLOW_PLAN_INVALID', String(error?.message || error), { workflowId }));
    }
  }

  const normalizedBindings = [];
  const bindingByStep = new Map();
  const boundTaskToStep = new Map();
  if (!Array.isArray(taskBindings) || taskBindings.length > 500) {
    blockers.push(blocker('TASK_BINDINGS_INVALID', 'task_bindings must be an array containing at most 500 entries'));
  } else {
    for (const [index, binding] of taskBindings.entries()) {
      if (!isRecord(binding) || sortedKeys(binding).join(',') !== 'step_id,task_id' ||
          typeof binding.step_id !== 'string' || !STEP_ID.test(binding.step_id) ||
          typeof binding.task_id !== 'string' || !SLUG.test(binding.task_id)) {
        blockers.push(blocker('TASK_BINDING_INVALID', `task_bindings[${index}] must contain exactly a valid step_id and task_id`));
        continue;
      }
      if (bindingByStep.has(binding.step_id)) {
        blockers.push(blocker('STEP_BOUND_MORE_THAN_ONCE', `step ${binding.step_id} has more than one task binding`, { stepId: binding.step_id }));
        continue;
      }
      if (boundTaskToStep.has(binding.task_id)) {
        blockers.push(blocker('WORKFLOW_TASK_REUSED', `workflow task ${binding.task_id} is assigned to more than one draft step`, {
          stepId: binding.step_id, taskId: binding.task_id, otherStepId: boundTaskToStep.get(binding.task_id)
        }));
        continue;
      }
      bindingByStep.set(binding.step_id, binding.task_id);
      boundTaskToStep.set(binding.task_id, binding.step_id);
      normalizedBindings.push({ step_id: binding.step_id, task_id: binding.task_id });
    }
  }

  if (validatedDraft && validatedPlan) {
    const stepsById = new Map(validatedDraft.steps.map(step => [step.id, step]));
    for (const step of validatedDraft.steps) {
      if (!bindingByStep.has(step.id)) {
        blockers.push(blocker('STEP_BINDING_MISSING', `draft step ${step.id} has no explicit workflow task mapping`, { stepId: step.id }));
      }
    }
    for (const stepId of bindingByStep.keys()) {
      if (!stepsById.has(stepId)) blockers.push(blocker('UNKNOWN_DRAFT_STEP', `binding references a draft step that does not exist: ${stepId}`, { stepId }));
    }
    for (const [stepId, taskId] of bindingByStep.entries()) {
      if (!validatedPlan.children.has(taskId)) {
        blockers.push(blocker('WORKFLOW_TASK_NOT_FOUND', `task ${taskId} is not a child in the compiled ${workflowId} template`, { stepId, taskId }));
      }
    }
    for (const step of validatedDraft.steps) {
      const childTaskId = bindingByStep.get(step.id);
      if (!childTaskId || !validatedPlan.children.has(childTaskId)) continue;
      const ancestors = validatedPlan.ancestors(childTaskId);
      for (const dependencyStepId of step.dependencies) {
        const dependencyTaskId = bindingByStep.get(dependencyStepId);
        if (!dependencyTaskId || !validatedPlan.children.has(dependencyTaskId)) continue;
        if (!ancestors.has(dependencyTaskId)) {
          blockers.push(blocker(
            'DEPENDENCY_NOT_PRESERVED',
            `workflow task ${childTaskId} does not depend (directly or transitively) on the mapped prerequisite task ${dependencyTaskId}`,
            { stepId: step.id, taskId: childTaskId, dependencyStepId, dependencyTaskId }
          ));
        }
      }
    }
    if (requireCompleteTaskMapping) {
      const mappedTaskIds = new Set([...bindingByStep.values()]);
      for (const child of validatedPlan.children.values()) {
        if (!mappedTaskIds.has(child.id)) {
          blockers.push(blocker(
            'WORKFLOW_CHILD_TASK_UNMAPPED',
            `mandatory workflow child ${child.id} (${child.role}) has no Plan Graph action-step mapping`,
            { taskId: child.id, role: child.role }
          ));
        }
      }
    }
  }

  const uniqueBlockers = [];
  const seenBlockers = new Set();
  for (const item of blockers) {
    const key = stableJson(item);
    if (seenBlockers.has(key)) continue;
    seenBlockers.add(key);
    uniqueBlockers.push(item);
  }
  const eligible = uniqueBlockers.length === 0;
  const normalizedPlanBindings = validatedDraft && validatedPlan
    ? validatedDraft.steps.map(step => {
      const taskId = bindingByStep.get(step.id);
      const task = taskId ? validatedPlan.children.get(taskId) : null;
      return task ? { stepId: step.id, sourceNodeId: step.sourceNodeId, taskId: task.id, role: task.role } : null;
    }).filter(Boolean)
    : [];
  const mappedTaskCount = new Set(normalizedPlanBindings.map(binding => binding.taskId)).size;
  const totalTemplateTasks = validatedPlan?.children.size ?? null;
  const warnings = [
    'This report is a compatibility assessment only; it is not an immutable execution plan and grants no execution authority.',
    'Human review and the existing workflow preflight/approval gates remain mandatory.'
  ];
  if (eligible && totalTemplateTasks > mappedTaskCount) {
    warnings.push(`The selected workflow retains ${totalTemplateTasks - mappedTaskCount} additional mandatory child task(s) not mapped from this draft.`);
  }
  if (draft?.source?.searchExhaustive === false) {
    warnings.push('The AGG search was not exhaustive; unexamined alternatives may exist.');
  }

  return {
    schemaVersion: ADAPTIVE_GOAL_COMPATIBILITY_SCHEMA_VERSION,
    kind: 'adaptive_goal_plan_compatibility_assessment',
    status: eligible ? 'eligible_for_human_review' : 'incompatible',
    eligible,
    draftHash: typeof draft?.draftHash === 'string' && SHA256.test(draft.draftHash) ? draft.draftHash : null,
    workflow: {
      id: workflowId ?? null,
      version: validatedPlan ? workflowPlan.workflow_version : null,
      planHash: validatedPlan ? workflowPlan.plan_hash : null,
      taskCount: validatedPlan ? validatedPlan.children.size : null
    },
    bindings: normalizedPlanBindings,
    blockers: uniqueBlockers,
    warnings,
    gates: {
      workflowProposalCreated: false,
      immutableExecutionPlanCreated: false,
      humanReviewRequired: true,
      workflowApprovalRequired: true,
      dispatchAllowed: false,
      executionAuthorized: false
    }
  };
}
