import { createHash } from 'node:crypto';
import { isAuthenticatedAdaptiveGoalPlanDraft } from './adaptive-goal-plan-adapter.js';

export const ADAPTIVE_GOAL_EXECUTION_GRAPH_PROPOSAL_SCHEMA_VERSION = 1;

const SHA256 = /^[a-f0-9]{64}$/;
const STEP_ID = /^agg-step-[a-f0-9]{24}$/;
const TASK_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

function fail(code, message) {
  const error = new TypeError(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function requiredString(value, field, pattern = null) {
  if (typeof value !== 'string' || !value || value.trim() !== value || (pattern && !pattern.test(value))) {
    fail('EXECUTION_GRAPH_INPUT_INVALID', `${field} is invalid`);
  }
  return value;
}

function verifyReviewOnlyDraft(draft) {
  const verification = draft?.source?.verification;
  // A serialized draft and its unkeyed draftHash are caller-controlled. They
  // cannot authenticate an upstream Goal/Idea signature, even when their
  // metadata says `verified: true`. Durable trust verification must be repeated
  // by the host against the current snapshot before a trusted downstream use.
  const verifiedSource = isAuthenticatedAdaptiveGoalPlanDraft(draft) && isRecord(verification) && verification.status === 'verified' && verification.verified === true &&
    typeof verification.providerId === 'string' && verification.providerId.trim() !== '' &&
    typeof verification.attestationId === 'string' && SHA256.test(verification.attestationId) &&
    typeof verification.snapshotHash === 'string' && SHA256.test(verification.snapshotHash) &&
    typeof verification.evidenceManifestHash === 'string' && SHA256.test(verification.evidenceManifestHash) &&
    typeof verification.trustRootSha256 === 'string' && SHA256.test(verification.trustRootSha256) &&
    verification.claimVerified === true && verification.independenceVerified === true &&
    typeof verification.expiresAt === 'string' && Date.parse(verification.expiresAt) > Date.now();
  if (!isRecord(draft) || draft.schemaVersion !== 1 || draft.kind !== 'adaptive_goal_plan_graph_draft' ||
      draft.status !== 'review_required' || !SHA256.test(draft.draftHash || '') ||
      !isRecord(draft.source) || draft.source.candidateStatus !== 'proposed' ||
      (!(verification?.status === 'unverified' && verification?.verified === false) && !verifiedSource) ||
      !isRecord(draft.gates) || draft.gates.humanReviewRequired !== true || draft.gates.workflowApprovalRequired !== true ||
      draft.gates.immutableExecutionPlanCreated !== false || draft.gates.dispatchAllowed !== false || draft.gates.executionAuthorized !== false ||
      !Array.isArray(draft.steps) || !draft.steps.length) {
    fail('EXECUTION_GRAPH_SOURCE_DRAFT_INVALID', 'source draft is not a complete unverified review-only Plan Graph draft');
  }
  const { draftHash, ...unsigned } = draft;
  if (hash(unsigned) !== draftHash) fail('EXECUTION_GRAPH_SOURCE_DRAFT_HASH_MISMATCH', 'source Plan Graph draft hash does not match its contents');
  return new Map(draft.steps.map(step => [step.id, step]));
}

/**
 * Build a deterministic, review-only Execution Graph proposal from a freshly
 * revalidated Plan Graph proposal and a readiness report based on actual
 * durable artifacts. It never creates task execution contracts or commands.
 */
function normalizeVerifiedSourceEvidence(record) {
  if (!isRecord(record) || typeof record.reference !== 'string' || !record.reference.startsWith('file:') ||
      record.classification !== 'source_bytes_verified_claim_unverified' || record.integrityVerified !== true ||
      record.claimVerified !== false || record.independenceVerified !== false || typeof record.path !== 'string' ||
      !SHA256.test(record.expectedSha256 || '') || record.observedSha256 !== record.expectedSha256 ||
      !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 0) {
    fail('EXECUTION_GRAPH_SOURCE_EVIDENCE_INVALID', 'source file references must have a current matching content hash; byte integrity never verifies claim truth or independence');
  }
  return {
    reference: record.reference,
    classification: record.classification,
    integrityVerified: true,
    claimVerified: false,
    independenceVerified: false,
    path: record.path,
    expectedSha256: record.expectedSha256,
    observedSha256: record.observedSha256,
    sizeBytes: record.sizeBytes
  };
}

export function buildAdaptiveGoalExecutionGraphProposal({ sourcePlanProposal, readiness, taskBindings, sourceEvidenceSnapshot = null }) {
  if (!isRecord(sourcePlanProposal)) fail('EXECUTION_GRAPH_SOURCE_PROPOSAL_INVALID', 'sourcePlanProposal must be an object');
  const sourcePlanProposalJobId = requiredString(sourcePlanProposal.jobId, 'sourcePlanProposal.jobId', /^job_[a-f0-9-]{36}$/);
  const sourcePlanProposalFingerprint = requiredString(sourcePlanProposal.fingerprint, 'sourcePlanProposal.fingerprint', SHA256);
  const candidatePlanId = requiredString(sourcePlanProposal.candidatePlanId, 'sourcePlanProposal.candidatePlanId', /^agg-[a-f0-9]{24}$/);
  const graphHash = requiredString(sourcePlanProposal.graphHash, 'sourcePlanProposal.graphHash', SHA256);
  const draftHash = requiredString(sourcePlanProposal.draftHash, 'sourcePlanProposal.draftHash', SHA256);
  const workflowId = requiredString(sourcePlanProposal.workflowId, 'sourcePlanProposal.workflowId', TASK_ID);
  if (!Number.isSafeInteger(sourcePlanProposal.workflowVersion) || sourcePlanProposal.workflowVersion < 1) {
    fail('EXECUTION_GRAPH_SOURCE_TEMPLATE_INVALID', 'source Plan Graph proposal workflowVersion is invalid');
  }
  const workflowTemplatePlanHash = requiredString(sourcePlanProposal.templatePlanHash, 'sourcePlanProposal.templatePlanHash', SHA256);
  const rawSourceEvidence = sourceEvidenceSnapshot ?? sourcePlanProposal.sourceEvidence ?? [];
  if (!Array.isArray(rawSourceEvidence) || rawSourceEvidence.length > 2048) {
    fail('EXECUTION_GRAPH_SOURCE_EVIDENCE_INVALID', 'source file integrity snapshot must be a bounded array');
  }
  const normalizedSourceEvidence = rawSourceEvidence.map(normalizeVerifiedSourceEvidence)
    .sort((a, b) => a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0);
  if (new Set(normalizedSourceEvidence.map(item => item.reference)).size !== normalizedSourceEvidence.length) {
    fail('EXECUTION_GRAPH_SOURCE_EVIDENCE_DUPLICATE', 'source file integrity snapshot contains duplicate references');
  }
  const sourceEvidenceByReference = new Map(normalizedSourceEvidence.map(item => [item.reference, item]));
  const sourceVerification = sourcePlanProposal.sourceVerification?.status === 'verified'
    ? sourcePlanProposal.sourceVerification
    : { status: 'unverified', verified: false };
  const draft = sourcePlanProposal.draft;
  const stepsById = verifyReviewOnlyDraft(draft);
  if (draft.draftHash !== draftHash || draft.source.graphHash !== graphHash || draft.source.candidatePlanId !== candidatePlanId) {
    fail('EXECUTION_GRAPH_SOURCE_IDENTITY_MISMATCH', 'source candidate/draft identity does not agree with the pinned Plan Graph proposal');
  }
  if (!isRecord(readiness) || readiness.kind !== 'adaptive_goal_execution_contract_readiness' ||
      readiness.readyForExecutionGraphReview !== true || readiness.contractReady !== true || readiness.evidenceReady !== true ||
      readiness.draftHash !== draftHash || !Array.isArray(readiness.actions) || !Array.isArray(readiness.blockers) || readiness.blockers.length ||
      !Array.isArray(readiness.evidenceBlockers) || readiness.evidenceBlockers.length || readiness.actions.length !== stepsById.size) {
    fail('EXECUTION_GRAPH_READINESS_NOT_MET', 'contract readiness, durable evidence readiness, or source draft identity is incomplete');
  }
  if (!Array.isArray(taskBindings) || taskBindings.length !== stepsById.size) {
    fail('EXECUTION_GRAPH_BINDINGS_INCOMPLETE', 'taskBindings must map every Plan Graph step exactly once');
  }

  const sourceBindings = new Map();
  if (!Array.isArray(sourcePlanProposal.bindings)) fail('EXECUTION_GRAPH_SOURCE_BINDINGS_INVALID', 'source proposal bindings must be an array');
  for (const binding of sourcePlanProposal.bindings) {
    if (!isRecord(binding) || typeof binding.step_id !== 'string' || !STEP_ID.test(binding.step_id) ||
        typeof binding.task_id !== 'string' || !TASK_ID.test(binding.task_id) || typeof binding.role !== 'string') {
      fail('EXECUTION_GRAPH_SOURCE_BINDINGS_INVALID', 'source Plan Graph proposal contains an invalid step-to-task mapping');
    }
    if (sourceBindings.has(binding.step_id)) fail('EXECUTION_GRAPH_SOURCE_BINDINGS_DUPLICATE', `source step ${binding.step_id} has duplicate task mappings`);
    sourceBindings.set(binding.step_id, binding);
  }
  if (sourceBindings.size !== stepsById.size || [...stepsById.keys()].some(stepId => !sourceBindings.has(stepId))) {
    fail('EXECUTION_GRAPH_SOURCE_BINDINGS_INCOMPLETE', 'source workflow proposal does not bind every Plan Graph action step');
  }

  const suppliedByStep = new Map();
  for (const [index, binding] of taskBindings.entries()) {
    if (!isRecord(binding) || Object.keys(binding).sort().join(',') !== 'capability,step_id,task_id' ||
        typeof binding.step_id !== 'string' || !STEP_ID.test(binding.step_id) ||
        typeof binding.task_id !== 'string' || !TASK_ID.test(binding.task_id) ||
        typeof binding.capability !== 'string' || !binding.capability) {
      fail('EXECUTION_GRAPH_BINDING_INVALID', `taskBindings[${index}] must contain exactly step_id, task_id, and capability`);
    }
    if (!stepsById.has(binding.step_id)) fail('EXECUTION_GRAPH_BINDING_UNKNOWN_STEP', `task binding references unknown Plan Graph step ${binding.step_id}`);
    if (suppliedByStep.has(binding.step_id)) fail('EXECUTION_GRAPH_BINDING_DUPLICATE_STEP', `Plan Graph step ${binding.step_id} is mapped more than once`);
    suppliedByStep.set(binding.step_id, binding);
  }
  if (suppliedByStep.size !== stepsById.size || [...stepsById.keys()].some(stepId => !suppliedByStep.has(stepId))) {
    fail('EXECUTION_GRAPH_BINDINGS_INCOMPLETE', 'taskBindings must map every Plan Graph step exactly once');
  }

  const actionsByStep = new Map();
  for (const action of readiness.actions) {
    if (!isRecord(action) || typeof action.stepId !== 'string' || actionsByStep.has(action.stepId)) {
      fail('EXECUTION_GRAPH_READINESS_ACTIONS_INVALID', 'readiness actions have a missing or duplicate stepId');
    }
    actionsByStep.set(action.stepId, action);
  }
  if ([...stepsById.keys()].some(stepId => !actionsByStep.has(stepId))) {
    fail('EXECUTION_GRAPH_READINESS_ACTIONS_INCOMPLETE', 'readiness report is missing one or more source steps');
  }

  const nodeIdByStepId = new Map();
  for (const step of draft.steps) {
    nodeIdByStepId.set(step.id, `agg-eg-step-${hash(`${draftHash}\u0000${step.id}`).slice(0, 24)}`);
  }
  const nodes = [];
  const graphEdges = [];
  const normalizedBindings = [];
  const contractSnapshots = [];
  const artifactSchemas = [];
  const evidenceByReference = new Map();

  for (const step of draft.steps) {
    const binding = suppliedByStep.get(step.id);
    const sourceBinding = sourceBindings.get(step.id);
    const action = actionsByStep.get(step.id);
    if (!action || action.taskId !== binding.task_id || action.declaredCapability !== binding.capability ||
        sourceBinding.task_id !== binding.task_id || sourceBinding.role !== action.role ||
        action.roleContract?.capability !== binding.capability ||
        action.blockers?.length || action.missingArtifactInputs?.length || action.supportingEvidence?.verified !== true ||
        !action.outputEvidenceContract || !Array.isArray(action.outputEvidenceContract.requiredContentFields) ||
        !action.outputEvidenceContract.requiredContentFields.length) {
      fail('EXECUTION_GRAPH_ACTION_CONTRACT_INVALID', `step ${step.id} does not have a complete matching role, capability, input/output schema, and verified-evidence contract`);
    }
    for (const dependencyId of step.dependencies) {
      if (!stepsById.has(dependencyId) || !nodeIdByStepId.has(dependencyId)) {
        fail('EXECUTION_GRAPH_DEPENDENCY_INVALID', `step ${step.id} references an unknown or non-preceding dependency ${dependencyId}`);
      }
      graphEdges.push({ from: nodeIdByStepId.get(dependencyId), to: nodeIdByStepId.get(step.id), type: 'depends_on' });
    }

    const verifiedEvidence = action.supportingEvidence.verifiedArtifacts.map(evidence => {
      if (!isRecord(evidence) || typeof evidence.reference !== 'string' || !evidence.reference ||
          typeof evidence.sourceJobId !== 'string' || !/^job_[a-f0-9-]{36}$/.test(evidence.sourceJobId) ||
          typeof evidence.artifactId !== 'string' || !evidence.artifactId || typeof evidence.type !== 'string' ||
          !Number.isSafeInteger(evidence.schemaVersion) || evidence.schemaVersion < 1 || !SHA256.test(evidence.contentHash || '') ||
          typeof evidence.artifactCreatedEventId !== 'string' || !evidence.artifactCreatedEventId ||
          typeof evidence.producerRole !== 'string' || !evidence.producerRole ||
          typeof evidence.producerTaskId !== 'string' || !evidence.producerTaskId || evidence.producerTaskStatus !== 'completed' ||
          typeof evidence.producerResultId !== 'string' || !evidence.producerResultId || evidence.producerResultOutcome !== 'success' ||
          typeof evidence.producerCompletionEventId !== 'string' || !evidence.producerCompletionEventId ||
          !['task.completed', 'task.local_completed'].includes(evidence.producerCompletionEventType)) {
        fail('EXECUTION_GRAPH_EVIDENCE_INVALID', `step ${step.id} has an incomplete durable evidence identity`);
      }
      const normalized = {
        reference: evidence.reference,
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
      };
      const previous = evidenceByReference.get(normalized.reference);
      if (previous && stableJson(previous) !== stableJson(normalized)) {
        fail('EXECUTION_GRAPH_EVIDENCE_CONFLICT', `evidence reference ${normalized.reference} resolves to inconsistent artifact identities`);
      }
      evidenceByReference.set(normalized.reference, normalized);
      return normalized;
    }).sort((a, b) => a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0);
    const verifiedSourceFiles = (action.supportingEvidence.sourceFiles || []).map(normalizeVerifiedSourceEvidence)
      .sort((a, b) => a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0);
    if (new Set(verifiedSourceFiles.map(item => item.reference)).size !== verifiedSourceFiles.length ||
        verifiedSourceFiles.some(item => stableJson(sourceEvidenceByReference.get(item.reference) || null) !== stableJson(item))) {
      fail('EXECUTION_GRAPH_SOURCE_EVIDENCE_REFERENCE_MISMATCH', `step ${step.id} source-file references do not match the complete hashed source snapshot`);
    }

    const nodeId = nodeIdByStepId.get(step.id);
    const dependencies = step.dependencies.map(id => nodeIdByStepId.get(id));
    const roleContract = {
      id: action.roleContract.id,
      version: action.roleContract.version,
      role: action.role,
      capability: action.roleContract.capability,
      requiredInputs: [...action.roleContract.requiredInputs],
      expectedOutputs: [...action.roleContract.expectedOutputs],
      requiredCompletionCriteria: [...action.roleContract.requiredCompletionCriteria]
    };
    const outputEvidenceContract = {
      type: action.outputEvidenceContract.type,
      schemaVersion: action.outputEvidenceContract.schemaVersion,
      requiredContentFields: [...action.outputEvidenceContract.requiredContentFields]
    };
    contractSnapshots.push({ stepId: step.id, taskId: binding.task_id, roleContract });
    artifactSchemas.push({ stepId: step.id, outputEvidenceContract });
    normalizedBindings.push({ stepId: step.id, taskId: binding.task_id, role: action.role, capability: binding.capability, roleContractId: roleContract.id, roleContractVersion: roleContract.version });
    nodes.push({
      id: nodeId,
      sourceStepId: step.id,
      sourceNodeId: step.sourceNodeId,
      kind: step.kind,
      title: step.title,
      status: 'proposed',
      dependencies,
      inputContract: {
        requiredArtifactTypes: [...action.roleContract.requiredInputs].filter(type => type !== 'job.request'),
        availableArtifactTypes: [...action.availableArtifactInputs],
        mappedAncestorOutputs: action.mappedAncestorOutputs.map(output => ({ ...output })),
        evidenceProvenance: action.inputArtifactProvenance.map(input => ({
          artifactType: input.artifactType,
          mappedAncestorSteps: [...input.mappedAncestorSteps],
          sourceArtifactRefs: [...input.sourceArtifactRefs]
        }))
      },
      roleContract,
      outputEvidenceContract,
      supportingEvidence: {
        verified: true,
        artifacts: verifiedEvidence,
        sourceFiles: verifiedSourceFiles,
        sourceFilesIntegrityVerified: verifiedSourceFiles.length === (action.supportingEvidence.declaredSourceFileReferenceCount || 0)
      },
      execution: { enabled: false, executable: null, args: null, authorization: 'none' }
    });
  }

  nodes.sort((a, b) => draft.steps.findIndex(step => step.id === a.sourceStepId) - draft.steps.findIndex(step => step.id === b.sourceStepId));
  graphEdges.sort((a, b) => a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0);
  normalizedBindings.sort((a, b) => a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0);
  const evidenceSnapshot = [...evidenceByReference.values()].sort((a, b) => a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0);
  const bindingHash = hash(normalizedBindings);
  const evidenceHash = hash(evidenceSnapshot);
  const sourceEvidenceHash = hash(normalizedSourceEvidence);
  const roleContractHash = hash(contractSnapshots.sort((a, b) => a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0));
  const artifactSchemaHash = hash(artifactSchemas.sort((a, b) => a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0));
  const readinessHash = hash({
    contractReady: readiness.contractReady,
    evidenceReady: readiness.evidenceReady,
    readyForExecutionGraphReview: readiness.readyForExecutionGraphReview,
    draftHash: readiness.draftHash,
    actions: readiness.actions,
    blockers: readiness.blockers,
    evidenceBlockers: readiness.evidenceBlockers
  });
  const hashes = {
    sourcePlanProposalFingerprint,
    sourceGraphHash: graphHash,
    planGraphDraftHash: draftHash,
    bindingHash,
    evidenceHash,
    sourceEvidenceHash,
    sourceVerificationHash: hash(sourceVerification),
    roleContractHash,
    artifactSchemaHash,
    readinessHash,
    workflowTemplatePlanHash
  };
  const fingerprint = hash({
    schemaVersion: ADAPTIVE_GOAL_EXECUTION_GRAPH_PROPOSAL_SCHEMA_VERSION,
    sourcePlanProposalJobId,
    candidatePlanId,
    workflowId,
    workflowVersion: sourcePlanProposal.workflowVersion,
    hashes
  });
  const proposalId = `agg-eg-${fingerprint.slice(0, 24)}`;
  const unsignedProposal = {
    schemaVersion: ADAPTIVE_GOAL_EXECUTION_GRAPH_PROPOSAL_SCHEMA_VERSION,
    kind: 'adaptive_goal_execution_graph_proposal',
    status: 'review_required',
    proposalId,
    fingerprint,
    source: {
      planProposalJobId: sourcePlanProposalJobId,
      planProposalFingerprint: sourcePlanProposalFingerprint,
      candidatePlanId,
      graphHash,
      draftHash,
      verification: sourcePlanProposal.sourceVerification?.status === 'verified'
        ? sourcePlanProposal.sourceVerification
        : { status: 'unverified', verified: false }
    },
    workflowTemplate: {
      id: workflowId,
      version: sourcePlanProposal.workflowVersion,
      planHash: workflowTemplatePlanHash
    },
    bindings: normalizedBindings,
    nodes,
    edges: graphEdges,
    evidenceSnapshot,
    sourceEvidenceSnapshot: normalizedSourceEvidence,
    readiness: {
      contractReady: true,
      evidenceReady: true,
      readyForExecutionGraphReview: true,
      readinessHash
    },
    hashes,
    gates: {
      humanReviewRequired: true,
      workflowApprovalRequired: true,
      executionGraphMaterialized: false,
      executableContractsCreated: false,
      immutableExecutionPlanCreated: false,
      dispatchAllowed: false,
      executionAuthorized: false
    },
    statement: 'This is a review-only graph proposal derived from current role contracts and durable evidence. The source Goal/Idea Graph has a separate trusted-attestation status; the selected AGG search candidate still requires explicit human and semantic action review. Nodes contain intent and typed contracts only; no executable, arguments, task rows, immutable plan, permission, approval, dispatch, or execution authority is created.'
  };
  const proposalHash = hash(unsignedProposal);
  return { ...unsignedProposal, proposalHash };
}

export function verifyAdaptiveGoalExecutionGraphProposalHash(proposal) {
  if (!isRecord(proposal) || typeof proposal.proposalHash !== 'string' || !SHA256.test(proposal.proposalHash)) return false;
  const { proposalHash, ...unsigned } = proposal;
  return hash(unsigned) === proposalHash;
}
