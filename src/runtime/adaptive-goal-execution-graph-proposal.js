import { createHash } from 'node:crypto';
import { ADAPTIVE_GOAL_PLAN_DRAFT_SCHEMA_VERSION, isAuthenticatedAdaptiveGoalPlanDraft } from './adaptive-goal-plan-adapter.js';

export const ADAPTIVE_GOAL_EXECUTION_GRAPH_PROPOSAL_SCHEMA_VERSION = 2;

const SHA256 = /^[a-f0-9]{64}$/;
const STEP_ID = /^agg-step-[a-f0-9]{24}$/;
const TASK_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertStrictJsonValue(value, { seen = new Set(), depth = 0, rejectRepeatedIdentity = true } = {}) {
  if (depth > 64) fail('EXECUTION_GRAPH_INPUT_INVALID', 'JSON input exceeds maximum nesting depth');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('EXECUTION_GRAPH_INPUT_INVALID', 'JSON input contains a non-finite number');
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) {
    fail('EXECUTION_GRAPH_INPUT_INVALID', 'input must be acyclic JSON data without undefined, functions, symbols, or other non-JSON values');
  }
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || Reflect.ownKeys(value).some(key => typeof key === 'symbol' ||
        (key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)))) {
      fail('EXECUTION_GRAPH_INPUT_INVALID', 'arrays must be dense JSON arrays without extra or symbol properties');
    }
    seen.add(value);
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) fail('EXECUTION_GRAPH_INPUT_INVALID', 'sparse arrays are not valid canonical JSON');
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('EXECUTION_GRAPH_INPUT_INVALID', 'JSON arrays must contain enumerable data properties only');
      assertStrictJsonValue(descriptor.value, { seen, depth: depth + 1, rejectRepeatedIdentity });
    }
    if (!rejectRepeatedIdentity) seen.delete(value);
    return;
  }
  if (prototype !== Object.prototype && prototype !== null) fail('EXECUTION_GRAPH_INPUT_INVALID', 'objects must be plain JSON records');
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || key === '__proto__')) {
    fail('EXECUTION_GRAPH_INPUT_INVALID', 'objects contain a forbidden symbol or prototype key');
  }
  seen.add(value);
  // Iterate every own key, not Object.keys(): Object.keys silently omits
  // non-enumerable string properties, which are not representable in JSON.
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('EXECUTION_GRAPH_INPUT_INVALID', 'JSON objects must contain enumerable data properties only');
    assertStrictJsonValue(descriptor.value, { seen, depth: depth + 1, rejectRepeatedIdentity });
  }
  if (!rejectRepeatedIdentity) seen.delete(value);
}

function stableJsonUnchecked(value) {
  if (Array.isArray(value)) return `[${value.map(stableJsonUnchecked).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJsonUnchecked(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(Object.is(value, -0) ? 0 : value);
}

function stableJson(value) {
  assertStrictJsonValue(value);
  return stableJsonUnchecked(value);
}

function hash(value) {
  // Public entry points validate the full caller-owned tree before reaching
  // hashing. Use the unchecked canonical serializer here because freshly
  // constructed internal envelopes may share immutable contract objects; that
  // implementation detail must not relax validation of caller-supplied data.
  return createHash('sha256').update(typeof value === 'string' ? value : stableJsonUnchecked(value)).digest('hex');
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
  const positions = new Map();
  for (const [index, step] of draft.steps.entries()) {
    if (!isRecord(step) || typeof step.id !== 'string' || !STEP_ID.test(step.id) || positions.has(step.id) ||
        !Array.isArray(step.dependencies) || step.dependencies.some(id => typeof id !== 'string' || !STEP_ID.test(id))) {
      fail('EXECUTION_GRAPH_SOURCE_DRAFT_STEPS_INVALID', `Plan Graph step ${index} has an invalid/duplicate identity or dependency list`);
    }
    positions.set(step.id, index);
  }
  for (const [index, step] of draft.steps.entries()) {
    if (new Set(step.dependencies).size !== step.dependencies.length) {
      fail('EXECUTION_GRAPH_DEPENDENCY_INVALID', `step ${step.id} contains duplicate dependencies`);
    }
    for (const dependencyId of step.dependencies) {
      const dependencyPosition = positions.get(dependencyId);
      // Plan Graph drafts are emitted in topological path order. Requiring each
      // dependency to precede its consumer rejects self-edges, forward edges,
      // and cycles before they can be copied into a reviewable Execution Graph.
      if (dependencyPosition === undefined || dependencyPosition >= index) {
        fail('EXECUTION_GRAPH_DEPENDENCY_INVALID', `step ${step.id} depends on unknown, self, forward, or cyclic step ${dependencyId}`);
      }
    }
  }
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
  // Internal callers may share immutable sub-objects between separately
  // assembled inputs. Cycles and hostile object shapes remain rejected here;
  // the emitted proposal is detached into a JSON tree, and its public verifier
  // rejects repeated identities in any caller-supplied serialized envelope.
  const buildInputOptions = { rejectRepeatedIdentity: false };
  assertStrictJsonValue(sourcePlanProposal, buildInputOptions);
  assertStrictJsonValue(readiness, buildInputOptions);
  assertStrictJsonValue(taskBindings, buildInputOptions);
  if (sourceEvidenceSnapshot !== null) assertStrictJsonValue(sourceEvidenceSnapshot, buildInputOptions);
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
  const draft = sourcePlanProposal.draft;
  const draftVerification = draft?.source?.verification;
  if ((sourcePlanProposal.sourceVerification !== undefined &&
       stableJson(sourcePlanProposal.sourceVerification) !== stableJson(draftVerification)) ||
      (draftVerification?.status === 'verified' && sourcePlanProposal.sourceVerification === undefined)) {
    fail('EXECUTION_GRAPH_SOURCE_VERIFICATION_MISMATCH',
      'source verification metadata must exactly match the in-process authenticated Plan Graph draft; caller-supplied trust labels are not authority');
  }
  // Derive the downstream report from the authenticated draft itself instead
  // of independently copying an adjacent caller field. The comparison above
  // rejects inconsistent envelopes; verifyReviewOnlyDraft then rechecks the
  // identity-bound content hash, attestation expiry and authenticated object.
  const sourceVerification = draftVerification?.status === 'verified'
    ? draftVerification
    : { status: 'unverified', verified: false };
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
      // Carry the exact source Plan Graph draft so a serialized Execution Graph
      // verifier binds each sourceNodeId to the original sourceStepId, rather
      // than trusting a self-consistent but fully re-hashable ID rewrite.
      // Durable consumers must still rebuild the draft from current trusted
      // source evidence before using this proposal.
      planGraphDraftSnapshot: JSON.parse(stableJson(draft)),
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
  const detachedProposal = JSON.parse(stableJsonUnchecked(unsignedProposal));
  const proposalHash = hash(detachedProposal);
  return { ...detachedProposal, proposalHash };
}

export function verifyAdaptiveGoalExecutionGraphProposalHash(proposal) {
  try {
  try { assertStrictJsonValue(proposal); } catch { return false; }
  if (!isRecord(proposal) || typeof proposal.proposalHash !== 'string' || !SHA256.test(proposal.proposalHash) ||
      proposal.schemaVersion !== ADAPTIVE_GOAL_EXECUTION_GRAPH_PROPOSAL_SCHEMA_VERSION ||
      proposal.kind !== 'adaptive_goal_execution_graph_proposal' || proposal.status !== 'review_required' ||
      !isRecord(proposal.source) || !isRecord(proposal.workflowTemplate) || !isRecord(proposal.hashes) ||
      !isRecord(proposal.gates) || !Array.isArray(proposal.nodes) || !Array.isArray(proposal.edges) ||
      !Array.isArray(proposal.bindings) || !Array.isArray(proposal.evidenceSnapshot) ||
      !Array.isArray(proposal.sourceEvidenceSnapshot) || !isRecord(proposal.readiness)) return false;
  const { proposalHash, ...unsigned } = proposal;
  if (hash(unsigned) !== proposalHash) return false;

  // This is a structural integrity check, not an authenticated signature or
  // execution authorization. Recompute all component hashes that can be
  // derived from the serialized proposal so a caller cannot rewrite a node,
  // binding, evidence snapshot, or source identity and merely re-hash the
  // outer envelope. The readiness report itself is summarized by its digest;
  // it must still be rebuilt from current durable artifacts before execution.
  const h = proposal.hashes;
  if (!SHA256.test(h.sourcePlanProposalFingerprint || '') || !SHA256.test(h.sourceGraphHash || '') ||
      !SHA256.test(h.planGraphDraftHash || '') || !SHA256.test(h.bindingHash || '') ||
      !SHA256.test(h.evidenceHash || '') || !SHA256.test(h.sourceEvidenceHash || '') ||
      !SHA256.test(h.sourceVerificationHash || '') || !SHA256.test(h.roleContractHash || '') ||
      !SHA256.test(h.artifactSchemaHash || '') || !SHA256.test(h.readinessHash || '') ||
      !SHA256.test(h.workflowTemplatePlanHash || '') ||
      h.sourcePlanProposalFingerprint !== proposal.source.planProposalFingerprint ||
      h.sourceGraphHash !== proposal.source.graphHash || h.planGraphDraftHash !== proposal.source.draftHash ||
      h.bindingHash !== hash(proposal.bindings) || h.evidenceHash !== hash(proposal.evidenceSnapshot) ||
      h.sourceEvidenceHash !== hash(proposal.sourceEvidenceSnapshot) ||
      h.sourceVerificationHash !== hash(proposal.source.verification) ||
      h.workflowTemplatePlanHash !== proposal.workflowTemplate.planHash) return false;

  // The serialized source draft fixes the identity mapping from each Plan
  // Graph step to its original Goal/Idea node. Without this body, an attacker
  // can rewrite sourceNodeId, derive a matching sourceStepId, update the node
  // and binding IDs, and recompute every exposed proposal hash. This is a
  // structural check only; durable callers still independently rebuild and
  // authenticate the current source Plan Graph before approval/dispatch.
  const sourceDraft = proposal.source.planGraphDraftSnapshot;
  if (!isRecord(sourceDraft) || sourceDraft.schemaVersion !== ADAPTIVE_GOAL_PLAN_DRAFT_SCHEMA_VERSION ||
      sourceDraft.kind !== 'adaptive_goal_plan_graph_draft' || sourceDraft.status !== 'review_required' ||
      sourceDraft.draftHash !== proposal.source.draftHash || !SHA256.test(sourceDraft.draftHash || '') ||
      !isRecord(sourceDraft.source) || sourceDraft.source.graphHash !== proposal.source.graphHash ||
      sourceDraft.source.candidatePlanId !== proposal.source.candidatePlanId ||
      sourceDraft.source.candidateStatus !== 'proposed' || !Array.isArray(sourceDraft.steps) ||
      sourceDraft.steps.length !== proposal.nodes.length ||
      stableJson(sourceDraft.source.verification) !== stableJson(proposal.source.verification)) return false;
  const { draftHash: sourceDraftHash, ...unsignedSourceDraft } = sourceDraft;
  if (hash(unsignedSourceDraft) !== sourceDraftHash) return false;
  const sourceDraftSteps = new Map();
  for (const step of sourceDraft.steps) {
    if (!isRecord(step) || typeof step.id !== 'string' || !STEP_ID.test(step.id) || sourceDraftSteps.has(step.id) ||
        typeof step.sourceNodeId !== 'string' || !step.sourceNodeId || step.sourceNodeId.trim() !== step.sourceNodeId ||
        step.id !== `agg-step-${hash(`${proposal.source.graphHash}\n${proposal.source.candidatePlanId}\n${step.sourceNodeId}`).slice(0, 24)}` ||
        typeof step.kind !== 'string' || !step.kind || typeof step.title !== 'string' || !step.title ||
        !Array.isArray(step.dependencies) || step.dependencies.some(id => typeof id !== 'string' || !STEP_ID.test(id))) return false;
    sourceDraftSteps.set(step.id, step);
  }
  for (const [index, step] of sourceDraft.steps.entries()) {
    if (new Set(step.dependencies).size !== step.dependencies.length ||
        step.dependencies.some(id => !sourceDraftSteps.has(id) || sourceDraft.steps.findIndex(candidate => candidate.id === id) >= index)) return false;
  }

  // The binding table is the identity bridge between Plan Graph steps and
  // Execution Graph role contracts. Recomputed unkeyed hashes alone cannot
  // establish that bridge: require a one-to-one mapping and compare every
  // semantic binding field against the corresponding node contract.
  if (proposal.bindings.length !== proposal.nodes.length) return false;
  const bindingByStep = new Map();
  const boundTaskIds = new Set();
  for (const binding of proposal.bindings) {
    if (!isRecord(binding) || typeof binding.stepId !== 'string' || !STEP_ID.test(binding.stepId) ||
        typeof binding.taskId !== 'string' || !TASK_ID.test(binding.taskId) ||
        typeof binding.role !== 'string' || !binding.role ||
        typeof binding.capability !== 'string' || !binding.capability ||
        typeof binding.roleContractId !== 'string' || !binding.roleContractId ||
        !Number.isSafeInteger(binding.roleContractVersion) || binding.roleContractVersion < 1 ||
        bindingByStep.has(binding.stepId) || boundTaskIds.has(binding.taskId)) return false;
    bindingByStep.set(binding.stepId, binding);
    boundTaskIds.add(binding.taskId);
  }
  if (proposal.nodes.some(node => !isRecord(node) || typeof node.sourceStepId !== 'string' ||
      !STEP_ID.test(node.sourceStepId) || typeof node.id !== 'string' ||
      node.id !== `agg-eg-step-${hash(`${proposal.source.draftHash}\u0000${node.sourceStepId}`).slice(0, 24)}`)) return false;
  for (const node of proposal.nodes) {
    // Plan Graph step IDs are derived from the exact source graph hash,
    // selected candidate identity, and Goal/Idea node ID. Recompute that
    // mapping here so changing sourceNodeId in a serialized Execution Graph
    // cannot pass merely by re-hashing the outer proposal envelope.
    if (typeof node.sourceNodeId !== 'string' || !node.sourceNodeId || node.sourceNodeId.trim() !== node.sourceNodeId ||
        node.sourceStepId !== `agg-step-${hash(`${proposal.source.graphHash}\n${proposal.source.candidatePlanId}\n${node.sourceNodeId}`).slice(0, 24)}`) return false;
    const sourceStep = sourceDraftSteps.get(node.sourceStepId);
    if (!sourceStep || node.sourceNodeId !== sourceStep.sourceNodeId || node.kind !== sourceStep.kind || node.title !== sourceStep.title) return false;
    const binding = bindingByStep.get(node.sourceStepId);
    if (!binding || binding.role !== node.roleContract?.role || binding.capability !== node.roleContract?.capability ||
        binding.roleContractId !== node.roleContract?.id || binding.roleContractVersion !== node.roleContract?.version) return false;
  }

  const contractSnapshots = proposal.nodes.map(node => ({
    stepId: node.sourceStepId,
    taskId: proposal.bindings.find(binding => binding.stepId === node.sourceStepId)?.taskId,
    roleContract: node.roleContract
  })).sort((a, b) => a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0);
  const artifactSchemas = proposal.nodes.map(node => ({ stepId: node.sourceStepId, outputEvidenceContract: node.outputEvidenceContract }))
    .sort((a, b) => a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0);
  if (contractSnapshots.some(item => typeof item.stepId !== 'string' || typeof item.taskId !== 'string') ||
      h.roleContractHash !== hash(contractSnapshots) || h.artifactSchemaHash !== hash(artifactSchemas)) return false;

  const expectedFingerprint = hash({
    schemaVersion: proposal.schemaVersion,
    sourcePlanProposalJobId: proposal.source.planProposalJobId,
    candidatePlanId: proposal.source.candidatePlanId,
    workflowId: proposal.workflowTemplate.id,
    workflowVersion: proposal.workflowTemplate.version,
    hashes: h
  });
  if (proposal.fingerprint !== expectedFingerprint || proposal.proposalId !== `agg-eg-${expectedFingerprint.slice(0, 24)}`) return false;

  const expectedGates = {
    humanReviewRequired: true, workflowApprovalRequired: true, executionGraphMaterialized: false,
    executableContractsCreated: false, immutableExecutionPlanCreated: false,
    dispatchAllowed: false, executionAuthorized: false
  };
  if (stableJson(proposal.gates) !== stableJson(expectedGates) ||
      proposal.readiness.contractReady !== true || proposal.readiness.evidenceReady !== true ||
      proposal.readiness.readyForExecutionGraphReview !== true || proposal.readiness.readinessHash !== h.readinessHash) return false;

  const nodeIds = new Set();
  const nodeBySourceStep = new Map();
  const sourceEvidenceByReference = new Map();
  for (const evidence of proposal.sourceEvidenceSnapshot) {
    let normalized;
    try { normalized = normalizeVerifiedSourceEvidence(evidence); } catch { return false; }
    if (sourceEvidenceByReference.has(normalized.reference) || stableJson(normalized) !== stableJson(evidence)) return false;
    sourceEvidenceByReference.set(normalized.reference, normalized);
  }
  for (const node of proposal.nodes) {
    if (!isRecord(node) || typeof node.id !== 'string' || nodeIds.has(node.id) ||
        typeof node.sourceStepId !== 'string' || nodeBySourceStep.has(node.sourceStepId) ||
        !isRecord(node.execution) || stableJson(node.execution) !== stableJson({ enabled: false, executable: null, args: null, authorization: 'none' }) ||
        !isRecord(node.supportingEvidence) || node.supportingEvidence.verified !== true ||
        !Array.isArray(node.supportingEvidence.artifacts) || !Array.isArray(node.supportingEvidence.sourceFiles) ||
        node.supportingEvidence.sourceFilesIntegrityVerified !== true) return false;
    const nodeSourceReferences = new Set();
    for (const sourceEvidence of node.supportingEvidence.sourceFiles) {
      let normalized;
      try { normalized = normalizeVerifiedSourceEvidence(sourceEvidence); } catch { return false; }
      if (nodeSourceReferences.has(normalized.reference) ||
          stableJson(normalized) !== stableJson(sourceEvidence) ||
          stableJson(sourceEvidenceByReference.get(normalized.reference) || null) !== stableJson(normalized)) return false;
      nodeSourceReferences.add(normalized.reference);
    }
    nodeIds.add(node.id);
    nodeBySourceStep.set(node.sourceStepId, node);
  }
  if ([...bindingByStep.keys()].some(stepId => !nodeBySourceStep.has(stepId))) return false;
  if (sourceDraftSteps.size !== nodeBySourceStep.size || [...sourceDraftSteps.keys()].some(stepId => !nodeBySourceStep.has(stepId))) return false;
  const expectedEdges = [];
  const nodeIdsByDependency = new Map();
  for (const node of proposal.nodes) {
    if (!Array.isArray(node.dependencies) || new Set(node.dependencies).size !== node.dependencies.length ||
        node.dependencies.some(id => typeof id !== 'string' || !nodeIds.has(id) || id === node.id)) return false;
    nodeIdsByDependency.set(node.id, node.dependencies);
    for (const dependencyId of node.dependencies) expectedEdges.push({ from: dependencyId, to: node.id, type: 'depends_on' });
  }
  for (const node of proposal.nodes) {
    const sourceStep = sourceDraftSteps.get(node.sourceStepId);
    const expectedDependencies = sourceStep.dependencies.map(stepId =>
      proposal.nodes.find(candidate => candidate.sourceStepId === stepId)?.id);
    if (expectedDependencies.some(id => typeof id !== 'string') || stableJson(expectedDependencies) !== stableJson(node.dependencies)) return false;
  }
  // The edge list and dependency lists can agree perfectly while both encode
  // a cycle. Verify the serialized Execution Graph is a DAG independently of
  // the builder: callers can re-hash an untrusted proposal, so construction-
  // time checks alone are not an integrity boundary.
  const visitState = new Map();
  const visit = nodeId => {
    const state = visitState.get(nodeId) || 0;
    if (state === 1) return false;
    if (state === 2) return true;
    visitState.set(nodeId, 1);
    for (const dependencyId of nodeIdsByDependency.get(nodeId) || []) {
      if (!visit(dependencyId)) return false;
    }
    visitState.set(nodeId, 2);
    return true;
  };
  for (const nodeId of nodeIdsByDependency.keys()) if (!visit(nodeId)) return false;
  const sortEdges = values => [...values].sort((a, b) => `${a.from}:${a.to}:${a.type}`.localeCompare(`${b.from}:${b.to}:${b.type}`));
  if (stableJson(sortEdges(proposal.edges)) !== stableJson(sortEdges(expectedEdges))) return false;

  const artifactByReference = new Map();
  for (const node of proposal.nodes) for (const evidence of node.supportingEvidence.artifacts) {
    if (!isRecord(evidence) || typeof evidence.reference !== 'string') return false;
    const previous = artifactByReference.get(evidence.reference);
    if (previous && stableJson(previous) !== stableJson(evidence)) return false;
    artifactByReference.set(evidence.reference, evidence);
  }
  const expectedEvidence = [...artifactByReference.values()].sort((a, b) => a.reference.localeCompare(b.reference));
  if (stableJson(expectedEvidence) !== stableJson([...proposal.evidenceSnapshot].sort((a, b) => a.reference.localeCompare(b.reference)))) return false;

  return true;
  } catch {
    // This function validates untrusted serialized data. Malformed nested
    // shapes must fail closed as `false`, never escape as an exception from a
    // readback verifier.
    return false;
  }
}
