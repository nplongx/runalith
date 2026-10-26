import { artifactSchemaForType } from './workflow/artifacts.js';
import { getAgentArtifactType, getAgentContract } from './workflow/agent-contracts.js';
import { assessAdaptiveGoalPlanCompatibility } from './adaptive-goal-compatibility.js';

export const ADAPTIVE_GOAL_EXECUTION_READINESS_SCHEMA_VERSION = 1;

const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const STEP_ID = /^agg-step-[a-f0-9]{24}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CAPABILITIES = new Set([
  'product.requirements', 'research.collect', 'architecture.design', 'code.modify',
  'security.audit', 'code.verify', 'infrastructure.verify', 'documentation.write',
  'change.review', 'synthesis.approve'
]);
const NON_ARTIFACT_INPUTS = new Set(['job.request']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sortedUnique(values) {
  return [...new Set(values)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

function blocker(code, message, extra = {}) {
  return { code, message, ...extra };
}

function normalizeEvidenceRecords(value, expectedRefs, resolutionBlockers) {
  const byRef = new Map();
  if (!Array.isArray(value) || value.length > 32000) {
    resolutionBlockers.push(blocker('EVIDENCE_RESOLUTION_INVALID', 'internal evidence resolution must be a bounded array'));
    return byRef;
  }
  const baseKeys = 'artifactCreatedEventId,artifactId,contentHash,lineageValid,producerCompletionEventId,producerCompletionEventType,producerContractValid,producerResultId,producerResultLineageValid,producerResultOutcome,producerRole,producerTaskCompleted,producerTaskId,producerTaskStatus,ref,schemaVersion,sourceJobId,status,type';
  const lineageDetailKey = 'producerResultLineageFailureReason';
  const invalidArtifactKeys = 'artifactId,ref,resolutionFailureCode,resolutionFailureReason,sourceJobId';
  const invalidArtifactCodes = new Set([
    'SOURCE_ARTIFACT_CONTENT_HASH_INVALID',
    'SOURCE_ARTIFACT_SCHEMA_INVALID',
    'SOURCE_ARTIFACT_RECORD_INVALID'
  ]);
  for (const [index, record] of value.entries()) {
    const keys = isRecord(record) ? Object.keys(record).sort().join(',') : '';
    const expectedWithDetail = [...baseKeys.split(','), lineageDetailKey].sort().join(',');
    if (keys === invalidArtifactKeys) {
      if (typeof record.ref !== 'string' || !expectedRefs.has(record.ref) ||
          typeof record.artifactId !== 'string' || !record.artifactId ||
          typeof record.sourceJobId !== 'string' || !/^job_[a-f0-9-]{36}$/.test(record.sourceJobId) ||
          !invalidArtifactCodes.has(record.resolutionFailureCode) ||
          typeof record.resolutionFailureReason !== 'string' || !record.resolutionFailureReason.trim()) {
        resolutionBlockers.push(blocker('EVIDENCE_RESOLUTION_INVALID', `evidence resolution ${index} has an invalid artifact-validation failure record`));
        continue;
      }
      resolutionBlockers.push(blocker(
        record.resolutionFailureCode,
        `referenced durable artifact ${record.artifactId} failed runtime validation: ${record.resolutionFailureReason}`,
        { reference: record.ref, artifactId: record.artifactId, sourceJobId: record.sourceJobId }
      ));
      continue;
    }
    if (!isRecord(record) || (keys !== baseKeys && keys !== expectedWithDetail)) {
      resolutionBlockers.push(blocker('EVIDENCE_RESOLUTION_INVALID', `evidence resolution ${index} has an invalid shape`));
      continue;
    }
    if (typeof record.ref !== 'string' || !expectedRefs.has(record.ref) || byRef.has(record.ref) ||
        typeof record.sourceJobId !== 'string' || !/^job_[a-f0-9-]{36}$/.test(record.sourceJobId) ||
        typeof record.artifactId !== 'string' || !record.artifactId ||
        typeof record.type !== 'string' || !record.type ||
        !Number.isInteger(record.schemaVersion) || record.schemaVersion < 1 ||
        !SHA256.test(record.contentHash || '') || typeof record.status !== 'string' ||
        typeof record.lineageValid !== 'boolean' || typeof record.producerContractValid !== 'boolean' || typeof record.producerTaskCompleted !== 'boolean' ||
        (record.artifactCreatedEventId !== null && (typeof record.artifactCreatedEventId !== 'string' || !record.artifactCreatedEventId)) ||
        (record.producerRole !== null && typeof record.producerRole !== 'string') ||
        (record.producerTaskId !== null && typeof record.producerTaskId !== 'string') ||
        (record.producerTaskStatus !== null && typeof record.producerTaskStatus !== 'string') ||
        typeof record.producerResultLineageValid !== 'boolean' ||
        (record.producerResultId !== null && typeof record.producerResultId !== 'string') ||
        (record.producerResultOutcome !== null && typeof record.producerResultOutcome !== 'string') ||
        (record.producerCompletionEventId !== null && typeof record.producerCompletionEventId !== 'string') ||
        (record.producerCompletionEventType !== null && typeof record.producerCompletionEventType !== 'string') ||
        (Object.hasOwn(record, lineageDetailKey) && record[lineageDetailKey] !== null && typeof record[lineageDetailKey] !== 'string')) {
      resolutionBlockers.push(blocker('EVIDENCE_RESOLUTION_INVALID', `evidence resolution ${index} does not bind a unique requested reference to a validated artifact identity`));
      continue;
    }
    byRef.set(record.ref, record);
  }
  return byRef;
}

function normalizeSourceEvidenceRecords(value, expectedRefs, resolutionBlockers) {
  const byRef = new Map();
  if (!Array.isArray(value) || value.length > 32000) {
    resolutionBlockers.push(blocker('SOURCE_EVIDENCE_RESOLUTION_INVALID', 'source evidence resolution must be a bounded array'));
    return byRef;
  }
  const exactKeys = [
    'claimVerified', 'classification', 'independenceVerified', 'integrityVerified', 'reference'
  ];
  for (const [index, record] of value.entries()) {
    if (!isRecord(record) || !exactKeys.every(key => Object.hasOwn(record, key)) ||
        Object.keys(record).some(key => ![
          'claimVerified', 'classification', 'independenceVerified', 'integrityVerified', 'reference',
          'path', 'expectedSha256', 'observedSha256', 'sizeBytes', 'modifiedAt', 'maxBytes'
        ].includes(key))) {
      resolutionBlockers.push(blocker('SOURCE_EVIDENCE_RESOLUTION_INVALID', `source evidence resolution ${index} has an invalid shape`));
      continue;
    }
    if (typeof record.reference !== 'string' || !expectedRefs.has(record.reference) || byRef.has(record.reference) ||
        typeof record.classification !== 'string' || typeof record.integrityVerified !== 'boolean' ||
        record.claimVerified !== false || record.independenceVerified !== false ||
        (record.path !== undefined && typeof record.path !== 'string') ||
        (record.expectedSha256 !== undefined && !SHA256.test(record.expectedSha256)) ||
        (record.observedSha256 !== undefined && !SHA256.test(record.observedSha256)) ||
        (record.sizeBytes !== undefined && (!Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 0)) ||
        (record.modifiedAt !== undefined && typeof record.modifiedAt !== 'string') ||
        (record.maxBytes !== undefined && (!Number.isSafeInteger(record.maxBytes) || record.maxBytes < 0))) {
      resolutionBlockers.push(blocker('SOURCE_EVIDENCE_RESOLUTION_INVALID', `source evidence resolution ${index} is not bound to a unique requested source reference`));
      continue;
    }
    if (record.integrityVerified && (record.classification !== 'source_bytes_verified_claim_unverified' ||
        typeof record.path !== 'string' || !SHA256.test(record.expectedSha256 || '') ||
        record.observedSha256 !== record.expectedSha256 || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 0)) {
      resolutionBlockers.push(blocker('SOURCE_EVIDENCE_RESOLUTION_INVALID', `source evidence resolution ${index} claims integrity without a matching content digest`));
      continue;
    }
    byRef.set(record.reference, { ...record });
  }
  return byRef;
}

/**
 * Assess whether explicitly mapped AGG steps match known built-in role/task
 * contracts and have resolvable durable source evidence. This function is a
 * report-only layer: it never creates an Execution Graph, immutable plan,
 * executable contract, approval, dispatch, or execution authorization.
 *
 * evidenceRecords must be produced by the runtime's durable artifact resolver,
 * not copied from user arguments. Each record is bound to an exact requested
 * source reference and a validated artifact row/creation event.
 */
export function assessAdaptiveGoalExecutionReadiness(draft, workflowId, workflowPlan, taskBindings, evidenceRecords = [], sourceEvidenceRecords = [], options = {}) {
  const errors = [];
  const rawBindings = Array.isArray(taskBindings) ? taskBindings : [];
  const shapeValidBindings = [];
  const capabilityByStep = new Map();
  for (const [index, binding] of rawBindings.entries()) {
    if (!isRecord(binding) || Object.keys(binding).sort().join(',') !== 'capability,step_id,task_id' ||
        typeof binding.step_id !== 'string' || !STEP_ID.test(binding.step_id) ||
        typeof binding.task_id !== 'string' || !SLUG.test(binding.task_id) ||
        typeof binding.capability !== 'string' || !CAPABILITIES.has(binding.capability)) {
      errors.push(blocker('ACTION_BINDING_INVALID', `task_bindings[${index}] must contain a valid step_id, task_id, and explicit known capability`));
      continue;
    }
    if (capabilityByStep.has(binding.step_id)) {
      errors.push(blocker('ACTION_STEP_BOUND_MORE_THAN_ONCE', `step ${binding.step_id} has multiple capability declarations`, { stepId: binding.step_id }));
      continue;
    }
    capabilityByStep.set(binding.step_id, binding.capability);
    shapeValidBindings.push({ step_id: binding.step_id, task_id: binding.task_id });
  }

  const compatibility = assessAdaptiveGoalPlanCompatibility(draft, workflowId, workflowPlan, shapeValidBindings, options);
  const draftValid = compatibility.blockers.every(item => item.code !== 'DRAFT_INVALID');
  const stepList = draftValid && Array.isArray(draft.steps) ? draft.steps : [];
  const stepById = new Map(stepList.map(step => [step.id, step]));
  const planChildren = new Map((workflowPlan?.children || []).filter(isRecord).map(child => [child.id, child]));
  const bindingByStep = new Map(shapeValidBindings.map(binding => [binding.step_id, binding.task_id]));
  const allRequestedRefs = new Set(stepList.flatMap(step => Array.isArray(step.supportingEvidenceRefs) ? step.supportingEvidenceRefs : []));
  const durableRefs = new Set([...allRequestedRefs].filter(ref => !ref.startsWith('file:')));
  const sourceRefs = new Set([...allRequestedRefs].filter(ref => ref.startsWith('file:')));
  const evidenceResolutionBlockers = [];
  const evidenceByRef = normalizeEvidenceRecords(evidenceRecords, durableRefs, evidenceResolutionBlockers);
  const sourceEvidenceByRef = normalizeSourceEvidenceRecords(sourceEvidenceRecords, sourceRefs, evidenceResolutionBlockers);
  const contractBlockers = [...compatibility.blockers, ...errors];
  const evidenceBlockers = [...evidenceResolutionBlockers];
  const assessedActions = [];
  const outputTypeByTask = new Map();

  // Resolve template output contracts from immutable role/task declarations.
  for (const [taskId, child] of planChildren.entries()) {
    try {
      const contract = getAgentContract(child.role);
      const outputType = child.execution?.output_artifact_type || getAgentArtifactType(child.role);
      outputTypeByTask.set(taskId, contract.outputs.includes(outputType) ? outputType : null);
    } catch {
      outputTypeByTask.set(taskId, null);
    }
  }

  const draftAncestors = stepId => {
    const seen = new Set();
    const pending = [...(stepById.get(stepId)?.dependencies || [])];
    while (pending.length) {
      const next = pending.pop();
      if (seen.has(next)) continue;
      seen.add(next);
      const parent = stepById.get(next);
      if (parent) pending.push(...parent.dependencies);
    }
    return [...seen].sort((left, right) => {
      const leftPosition = stepList.findIndex(item => item.id === left);
      const rightPosition = stepList.findIndex(item => item.id === right);
      return leftPosition - rightPosition || (left < right ? -1 : left > right ? 1 : 0);
    });
  };

  for (const step of stepList) {
    const stepBlockers = [];
    const taskId = bindingByStep.get(step.id);
    const child = taskId ? planChildren.get(taskId) : null;
    let roleContract = null;
    let outputType = null;
    let outputSchema = null;
    let ancestors = new Set();
    const availableInputTypes = new Set(['job.request']);

    if (!taskId || !child) {
      // Compatibility checker already supplies the corresponding blocker.
      continue;
    }
    try {
      roleContract = getAgentContract(child.role);
    } catch (error) {
      stepBlockers.push(blocker('ROLE_CONTRACT_UNAVAILABLE', `workflow task ${taskId} uses a role without a registered immutable agent contract`, { stepId: step.id, taskId, role: child.role }));
    }
    const requestedCapability = capabilityByStep.get(step.id);
    if (!roleContract || requestedCapability !== roleContract.capability || child.capability !== roleContract.capability) {
      stepBlockers.push(blocker('CAPABILITY_CONTRACT_MISMATCH', `step ${step.id} capability must match both the bound workflow task and its immutable role contract`, {
        stepId: step.id, taskId, declaredCapability: requestedCapability ?? null,
        taskCapability: child.capability ?? null, roleCapability: roleContract?.capability ?? null
      }));
    }

    if (roleContract) {
      try {
        outputType = child.execution?.output_artifact_type || getAgentArtifactType(child.role);
        if (!roleContract.outputs.includes(outputType)) {
          stepBlockers.push(blocker('OUTPUT_ARTIFACT_CONTRACT_MISMATCH', `task ${taskId} output ${outputType} is not declared by its role contract`, {
            stepId: step.id, taskId, role: child.role, outputType, roleOutputs: [...roleContract.outputs]
          }));
          outputType = null;
        } else {
          outputSchema = artifactSchemaForType(outputType);
          if (!outputSchema.required_content_fields.length) {
            stepBlockers.push(blocker('OUTPUT_EVIDENCE_SCHEMA_WEAK', `artifact schema ${outputType} does not define required content fields`, { stepId: step.id, taskId, outputType }));
          }
        }
      } catch (error) {
        stepBlockers.push(blocker('OUTPUT_ARTIFACT_SCHEMA_UNAVAILABLE', `task ${taskId} has no valid durable output artifact schema: ${String(error?.message || error)}`, { stepId: step.id, taskId }));
      }
    }

    const ancestorStepIds = draftAncestors(step.id);
    const mappedAncestorOutputs = [];
    for (const ancestorStepId of ancestorStepIds) {
      const ancestorTaskId = bindingByStep.get(ancestorStepId);
      const ancestorOutputType = ancestorTaskId ? outputTypeByTask.get(ancestorTaskId) : null;
      if (ancestorOutputType) {
        availableInputTypes.add(ancestorOutputType);
        mappedAncestorOutputs.push({ stepId: ancestorStepId, taskId: ancestorTaskId, artifactType: ancestorOutputType });
      }
    }

    const resolvedEvidence = [];
    const resolvedSourceEvidence = [];
    const stepSourceRefs = step.supportingEvidenceRefs.filter(ref => ref.startsWith('file:'));
    const stepDurableRefs = step.supportingEvidenceRefs.filter(ref => !ref.startsWith('file:'));
    for (const ref of stepSourceRefs) {
      const source = sourceEvidenceByRef.get(ref);
      if (!source) {
        evidenceBlockers.push(blocker('SOURCE_FILE_EVIDENCE_UNRESOLVED', `content-addressed source reference ${ref} did not resolve through the source integrity resolver`, { stepId: step.id, reference: ref }));
        continue;
      }
      if (source.classification !== 'source_bytes_verified_claim_unverified' || source.integrityVerified !== true ||
          source.claimVerified !== false || source.independenceVerified !== false) {
        evidenceBlockers.push(blocker('SOURCE_FILE_EVIDENCE_INTEGRITY_FAILED', `source reference ${ref} is not a verified in-scope file hash; source integrity does not verify the referenced claim`, {
          stepId: step.id, reference: ref, classification: source.classification, integrityVerified: source.integrityVerified,
          claimVerified: source.claimVerified, independenceVerified: source.independenceVerified
        }));
        continue;
      }
      resolvedSourceEvidence.push({ ...source });
    }
    for (const ref of stepDurableRefs) {
      const evidence = evidenceByRef.get(ref);
      if (!evidence) {
        evidenceBlockers.push(blocker('SOURCE_EVIDENCE_UNVERIFIED', `source evidence reference ${ref} does not resolve to a validated durable artifact`, { stepId: step.id, reference: ref }));
        continue;
      }
      if (evidence.producerResultLineageValid !== true) {
        const detail = typeof evidence.producerResultLineageFailureReason === 'string' && evidence.producerResultLineageFailureReason.trim()
          ? `: ${evidence.producerResultLineageFailureReason}` : '';
        evidenceBlockers.push(blocker('SOURCE_EVIDENCE_RESULT_LINEAGE_INVALID', `source evidence ${ref} is not bound to exactly one successful durable result and matching completion event${detail}`, {
          stepId: step.id, reference: ref, artifactId: evidence.artifactId,
          producerResultId: evidence.producerResultId, producerResultOutcome: evidence.producerResultOutcome,
          producerCompletionEventId: evidence.producerCompletionEventId, producerCompletionEventType: evidence.producerCompletionEventType,
          lineageFailureReason: evidence.producerResultLineageFailureReason || null
        }));
        continue;
      }
      if (evidence.status !== 'active' || evidence.lineageValid !== true || evidence.producerContractValid !== true || evidence.producerTaskCompleted !== true) {
        evidenceBlockers.push(blocker('SOURCE_EVIDENCE_NOT_ACTIVE', `source evidence ${ref} is not active or its creation-event lineage is invalid`, {
          stepId: step.id, reference: ref, artifactId: evidence.artifactId, status: evidence.status, lineageValid: evidence.lineageValid, producerContractValid: evidence.producerContractValid, producerTaskCompleted: evidence.producerTaskCompleted
        }));
        continue;
      }
      let expectedArtifactSchema = null;
      try { expectedArtifactSchema = artifactSchemaForType(evidence.type); } catch {}
      if (!expectedArtifactSchema || evidence.schemaVersion !== expectedArtifactSchema.schema_version) {
        evidenceBlockers.push(blocker('SOURCE_EVIDENCE_SCHEMA_MISMATCH', `source evidence ${ref} does not match the current typed artifact schema`, {
          stepId: step.id, reference: ref, artifactId: evidence.artifactId, type: evidence.type,
          suppliedSchemaVersion: evidence.schemaVersion, expectedSchemaVersion: expectedArtifactSchema?.schema_version ?? null
        }));
        continue;
      }
      resolvedEvidence.push({
        reference: ref,
        sourceJobId: evidence.sourceJobId,
        artifactId: evidence.artifactId,
        type: evidence.type,
        schemaVersion: evidence.schemaVersion,
        contentHash: evidence.contentHash,
        artifactCreatedEventId: evidence.artifactCreatedEventId,
        producerRole: evidence.producerRole,
        producerTaskId: evidence.producerTaskId,
        producerTaskStatus: evidence.producerTaskStatus,
        producerResultId: evidence.producerResultId,
        producerResultOutcome: evidence.producerResultOutcome,
        producerCompletionEventId: evidence.producerCompletionEventId,
        producerCompletionEventType: evidence.producerCompletionEventType
      });
      availableInputTypes.add(evidence.type);
    }
    if (!step.supportingEvidenceRefs.length) {
      evidenceBlockers.push(blocker('STEP_EVIDENCE_MISSING', `step ${step.id} declares no supporting evidence references`, { stepId: step.id }));
    } else if (!stepDurableRefs.length) {
      evidenceBlockers.push(blocker('STEP_DURABLE_EVIDENCE_MISSING', `step ${step.id} has source-file integrity references but no typed durable artifact evidence with producer/result/completion lineage`, {
        stepId: step.id, sourceFileReferenceCount: stepSourceRefs.length
      }));
    }

    const requiredInputs = roleContract ? roleContract.inputs.filter(input => !NON_ARTIFACT_INPUTS.has(input)) : [];
    const missingInputs = requiredInputs.filter(input => !availableInputTypes.has(input));
    if (missingInputs.length) {
      stepBlockers.push(blocker('INPUT_ARTIFACTS_UNAVAILABLE', `task ${taskId} requires artifact inputs not supplied by mapped ancestors or validated supporting artifacts: ${missingInputs.join(', ')}`, {
        stepId: step.id, taskId, missingArtifactTypes: missingInputs
      }));
    }
    const schemaSummary = outputSchema ? {
      type: outputSchema.type,
      schemaVersion: outputSchema.schema_version,
      requiredContentFields: [...outputSchema.required_content_fields]
    } : null;
    contractBlockers.push(...stepBlockers);
    assessedActions.push({
      stepId: step.id,
      sourceNodeId: step.sourceNodeId,
      kind: step.kind,
      taskId,
      role: child.role,
      declaredCapability: requestedCapability ?? null,
      roleContract: roleContract ? {
        id: roleContract.id, version: roleContract.version, capability: roleContract.capability,
        requiredInputs: [...roleContract.inputs], expectedOutputs: [...roleContract.outputs],
        requiredCompletionCriteria: [...roleContract.completionCriteria]
      } : null,
      outputEvidenceContract: schemaSummary,
      availableArtifactInputs: sortedUnique([...availableInputTypes]),
      mappedAncestorOutputs,
      inputArtifactProvenance: requiredInputs.map(type => ({
        artifactType: type,
        mappedAncestorSteps: mappedAncestorOutputs.filter(output => output.artifactType === type).map(output => output.stepId),
        sourceArtifactRefs: resolvedEvidence.filter(evidence => evidence.type === type).map(evidence => evidence.reference).sort()
      })),
      missingArtifactInputs: missingInputs,
      supportingEvidence: {
        declaredReferenceCount: step.supportingEvidenceRefs.length,
        declaredDurableArtifactReferenceCount: stepDurableRefs.length,
        declaredSourceFileReferenceCount: stepSourceRefs.length,
        resolvedActiveArtifactCount: resolvedEvidence.length,
        verifiedArtifacts: resolvedEvidence,
        sourceFiles: resolvedSourceEvidence,
        sourceFilesIntegrityVerified: stepSourceRefs.length > 0 && resolvedSourceEvidence.length === stepSourceRefs.length,
        verified: stepDurableRefs.length > 0 && resolvedEvidence.length === stepDurableRefs.length
      },
      execution: { enabled: false, executable: null, args: null, authorization: 'none' },
      blockers: stepBlockers.map(item => item.code)
    });
    if (outputType) outputTypeByTask.set(taskId, outputType);
  }

  const stableJson = value => {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  };
  const dedupe = items => {
    const seen = new Set();
    return items.filter(item => {
      const key = stableJson(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const uniqueContractBlockers = dedupe(contractBlockers);
  const uniqueEvidenceBlockers = dedupe(evidenceBlockers);
  const contractReady = uniqueContractBlockers.length === 0 && assessedActions.length === stepList.length;
  const evidenceReady = stepList.length > 0 && assessedActions.length === stepList.length && uniqueEvidenceBlockers.length === 0 && assessedActions.every(action => action.supportingEvidence.verified);
  const ready = contractReady && evidenceReady;
  return {
    schemaVersion: ADAPTIVE_GOAL_EXECUTION_READINESS_SCHEMA_VERSION,
    kind: 'adaptive_goal_execution_contract_readiness',
    status: ready ? 'eligible_for_execution_graph_review' : contractReady ? 'contract_ready_evidence_pending' : 'blocked',
    readyForExecutionGraphReview: ready,
    contractReady,
    evidenceReady,
    draftHash: compatibility.draftHash,
    workflow: compatibility.workflow,
    actions: assessedActions,
    blockers: uniqueContractBlockers,
    evidenceBlockers: uniqueEvidenceBlockers,
    sourceEvidence: [...sourceEvidenceByRef.values()].sort((a, b) => a.reference.localeCompare(b.reference)),
    gates: {
      humanReviewRequired: true,
      workflowApprovalRequired: true,
      executionGraphCreated: false,
      executableContractsCreated: false,
      immutableExecutionPlanCreated: false,
      dispatchAllowed: false,
      executionAuthorized: false
    },
    statement: 'Readiness is a review report only. It does not create an Execution Graph, executable task contract, immutable plan, permission, approval, dispatch, or execution authority.'
  };
}
