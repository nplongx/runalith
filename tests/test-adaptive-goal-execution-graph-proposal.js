import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { searchAdaptiveGoalGraph } from '../src/runtime/adaptive-goal-graph.js';
import { projectAdaptiveGoalCandidateToPlanGraph } from '../src/runtime/adaptive-goal-plan-adapter.js';
import { assessAdaptiveGoalExecutionReadiness } from '../src/runtime/adaptive-goal-execution-readiness.js';
import {
  buildAdaptiveGoalExecutionGraphProposal,
  verifyAdaptiveGoalExecutionGraphProposalHash
} from '../src/runtime/adaptive-goal-execution-graph-proposal.js';
import { compileWorkflowPlan } from '../src/runtime/workflow/compiler.js';
import { resolveAdaptiveGoalSourceEvidence } from '../src/runtime/adaptive-goal-source-evidence.js';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function rehashDraft(draft) {
  const { draftHash: _oldHash, ...unsigned } = draft;
  return { ...draft, draftHash: createHash('sha256').update(stableJson(unsigned)).digest('hex') };
}

function rehashExecutionProposal(proposal) {
  const { proposalHash: _oldHash, ...unsigned } = proposal;
  return { ...proposal, proposalHash: createHash('sha256').update(stableJson(unsigned)).digest('hex') };
}

function rehashExecutionProposalComponents(proposal) {
  const hash = value => createHash('sha256').update(stableJson(value)).digest('hex');
  proposal.hashes.bindingHash = hash(proposal.bindings);
  proposal.hashes.roleContractHash = hash(proposal.nodes.map(node => ({
    stepId: node.sourceStepId,
    taskId: proposal.bindings.find(binding => binding.stepId === node.sourceStepId)?.taskId,
    roleContract: node.roleContract
  })).sort((a, b) => a.stepId.localeCompare(b.stepId)));
  proposal.hashes.artifactSchemaHash = hash(proposal.nodes.map(node => ({
    stepId: node.sourceStepId, outputEvidenceContract: node.outputEvidenceContract
  })).sort((a, b) => a.stepId.localeCompare(b.stepId)));
  proposal.fingerprint = hash({ schemaVersion: proposal.schemaVersion,
    sourcePlanProposalJobId: proposal.source.planProposalJobId, candidatePlanId: proposal.source.candidatePlanId,
    workflowId: proposal.workflowTemplate.id, workflowVersion: proposal.workflowTemplate.version, hashes: proposal.hashes });
  proposal.proposalId = `agg-eg-${proposal.fingerprint.slice(0, 24)}`;
  return rehashExecutionProposal(proposal);
}

function graphFixture() {
  const sourcePath = 'src/runtime/adaptive-goal-graph.js';
  const sourceHash = createHash('sha256').update(fs.readFileSync(path.join(process.cwd(), sourcePath))).digest('hex');
  return {
    schemaVersion: 1,
    startNodeId: 'start',
    goalNodeId: 'goal',
    nodes: [
      { id: 'start', type: 'goal', label: 'Initial state' },
      { id: 'implement', type: 'task', label: 'Implement requested change', evidenceRefs: [
        'artifact://artifact-requirements', 'artifact://artifact-architecture', `file:${sourcePath}#sha256=${sourceHash}`
      ] },
      { id: 'goal', type: 'goal', label: 'Implementation reviewed' }
    ],
    edges: [
      { from: 'start', to: 'implement', type: 'next_step' },
      { from: 'implement', to: 'goal', type: 'next_step' }
    ]
  };
}

function context() {
  const graph = graphFixture();
  const options = { beamWidth: 4, maxDepth: 8, maxExpansions: 32 };
  const search = searchAdaptiveGoalGraph(graph, options);
  const draft = projectAdaptiveGoalCandidateToPlanGraph(graph, search.candidates[0], options);
  const workflowPlan = compileWorkflowPlan({
    job_id: 'agg-execution-graph-fixture',
    title: 'Software Development: Execution Graph test fixture'
  }, { workspace: process.cwd(), requiredOperations: [], workspaceWriteScopes: [] });
  const taskBindings = [{ step_id: draft.steps[0].id, task_id: 'standard-engineer', capability: 'code.modify' }];
  const sourceEvidence = resolveAdaptiveGoalSourceEvidence(
    [...new Set(graph.nodes.flatMap(node => node.evidenceRefs || []).filter(ref => ref.startsWith('file:')))],
    { root: fs.realpathSync(process.cwd()) }
  );
  const evidence = [
    ['artifact://artifact-requirements', 'requirements', 'artifact-requirements', 'product-owner'],
    ['artifact://artifact-architecture', 'architecture', 'artifact-architecture', 'architect']
  ].map(([ref, type, artifactId, producerRole]) => ({
    ref, sourceJobId: 'job_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', type, artifactId, schemaVersion: 1, status: 'active',
    contentHash: createHash('sha256').update(`durable:${artifactId}`).digest('hex'),
    lineageValid: true,
    artifactCreatedEventId: `artifact-created-${artifactId}`,
    producerContractValid: true,
    producerRole,
    producerTaskId: `task-${artifactId}`,
    producerTaskStatus: 'completed',
    producerTaskCompleted: true,
    producerResultId: `result-${artifactId}`,
    producerResultOutcome: 'success',
    producerCompletionEventId: `completion-${artifactId}`,
    producerCompletionEventType: 'task.local_completed',
    producerResultLineageValid: true
  }));
  const readiness = assessAdaptiveGoalExecutionReadiness(draft, 'standard-engineering', workflowPlan, taskBindings, evidence, sourceEvidence);
  assert.equal(readiness.readyForExecutionGraphReview, true, JSON.stringify(readiness, null, 2));
  const sourcePlanProposal = {
    jobId: 'job_11111111-1111-4111-8111-111111111111',
    fingerprint: createHash('sha256').update('source-plan-proposal').digest('hex'),
    candidatePlanId: draft.source.candidatePlanId,
    graphHash: draft.source.graphHash,
    draftHash: draft.draftHash,
    workflowId: 'standard-engineering',
    workflowVersion: workflowPlan.workflow_version,
    templatePlanHash: workflowPlan.plan_hash,
    draft,
    bindings: [{ step_id: draft.steps[0].id, task_id: 'standard-engineer', role: 'engineer' }],
    sourceEvidence
  };
  return { graph, search, draft, workflowPlan, taskBindings, evidence, sourceEvidence, readiness, sourcePlanProposal };
}

test('builds deterministic review-only Execution Graph proposal bound to Plan Graph, role contracts and successful evidence lineage', () => {
  const first = context();
  const proposal = buildAdaptiveGoalExecutionGraphProposal({
    sourcePlanProposal: first.sourcePlanProposal,
    readiness: first.readiness,
    taskBindings: first.taskBindings
  });
  const repeated = buildAdaptiveGoalExecutionGraphProposal({
    sourcePlanProposal: first.sourcePlanProposal,
    readiness: first.readiness,
    taskBindings: first.taskBindings
  });
  assert.deepEqual(proposal, repeated);
  assert.equal(proposal.kind, 'adaptive_goal_execution_graph_proposal');
  assert.equal(proposal.status, 'review_required');
  assert.match(proposal.proposalId, /^agg-eg-[a-f0-9]{24}$/);
  assert.match(proposal.fingerprint, /^[a-f0-9]{64}$/);
  assert.match(proposal.proposalHash, /^[a-f0-9]{64}$/);
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(proposal), true);
  assert.equal(proposal.source.candidatePlanId, first.draft.source.candidatePlanId);
  assert.equal(proposal.source.verification.verified, false);
  assert.equal(proposal.nodes.length, 1);
  assert.equal(proposal.nodes[0].roleContract.id, 'agent.engineer');
  assert.equal(proposal.nodes[0].roleContract.capability, 'code.modify');
  assert.equal(proposal.nodes[0].outputEvidenceContract.type, 'implementation');
  assert.deepEqual(proposal.nodes[0].dependencies, []);
  assert.deepEqual(proposal.nodes[0].supportingEvidence.artifacts.map(item => item.type).sort(), ['architecture', 'requirements']);
  assert.equal(proposal.nodes[0].supportingEvidence.sourceFilesIntegrityVerified, true);
  assert.equal(proposal.nodes[0].supportingEvidence.sourceFiles.length, 1);
  assert.equal(proposal.nodes[0].supportingEvidence.sourceFiles[0].claimVerified, false);
  assert.equal(proposal.sourceEvidenceSnapshot.length, 1);
  assert.equal(proposal.hashes.sourceEvidenceHash, createHash('sha256').update(stableJson(proposal.sourceEvidenceSnapshot)).digest('hex'));
  assert.equal(proposal.nodes[0].inputContract.evidenceProvenance.length, 2);
  assert.deepEqual(proposal.edges, []);
  assert.deepEqual(proposal.gates, {
    humanReviewRequired: true,
    workflowApprovalRequired: true,
    executionGraphMaterialized: false,
    executableContractsCreated: false,
    immutableExecutionPlanCreated: false,
    dispatchAllowed: false,
    executionAuthorized: false
  });
  for (const node of proposal.nodes) {
    assert.deepEqual(node.execution, { enabled: false, executable: null, args: null, authorization: 'none' });
    assert.equal(Object.hasOwn(node.execution, 'command'), false);
  }
});

test('rejects insufficient readiness, changed source hashes, and altered binding/capability', () => {
  const value = context();
  assert.throws(() => buildAdaptiveGoalExecutionGraphProposal({
    sourcePlanProposal: value.sourcePlanProposal,
    readiness: { ...value.readiness, evidenceReady: false },
    taskBindings: value.taskBindings
  }), /EXECUTION_GRAPH_READINESS_NOT_MET/);

  const staleSource = { ...value.sourcePlanProposal, draftHash: 'f'.repeat(64) };
  assert.throws(() => buildAdaptiveGoalExecutionGraphProposal({
    sourcePlanProposal: staleSource, readiness: value.readiness, taskBindings: value.taskBindings
  }), /EXECUTION_GRAPH_SOURCE_IDENTITY_MISMATCH/);

  const wrongCapability = [{ ...value.taskBindings[0], capability: 'research.collect' }];
  assert.throws(() => buildAdaptiveGoalExecutionGraphProposal({
    sourcePlanProposal: value.sourcePlanProposal, readiness: value.readiness, taskBindings: wrongCapability
  }), /EXECUTION_GRAPH_ACTION_CONTRACT_INVALID/);

  const injectedBinding = [{ ...value.taskBindings[0], executable: 'node', args: ['untrusted.js'] }];
  assert.throws(() => buildAdaptiveGoalExecutionGraphProposal({
    sourcePlanProposal: value.sourcePlanProposal, readiness: value.readiness, taskBindings: injectedBinding
  }), /EXECUTION_GRAPH_BINDING_INVALID/);
});

test('proposal-hash verifier detects gate weakening or evidence tampering', () => {
  const value = context();
  const proposal = buildAdaptiveGoalExecutionGraphProposal({
    sourcePlanProposal: value.sourcePlanProposal, readiness: value.readiness, taskBindings: value.taskBindings
  });
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash({ ...proposal, gates: { ...proposal.gates, dispatchAllowed: true } }), false);
  const tampered = structuredClone(proposal);
  tampered.nodes[0].supportingEvidence.artifacts[0].contentHash = '0'.repeat(64);
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(tampered), false);
});

test('proposal verifier rejects rehashed envelopes with inconsistent component hashes or review-only gates', () => {
  const value = context();
  const proposal = buildAdaptiveGoalExecutionGraphProposal({
    sourcePlanProposal: value.sourcePlanProposal, readiness: value.readiness, taskBindings: value.taskBindings
  });

  const changedEvidence = structuredClone(proposal);
  changedEvidence.nodes[0].supportingEvidence.artifacts[0].contentHash = '0'.repeat(64);
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(rehashExecutionProposal(changedEvidence)), false,
    'recomputing only the outer envelope must not conceal an evidence/component-hash mismatch');

  const enabledDispatch = structuredClone(proposal);
  enabledDispatch.gates.dispatchAllowed = true;
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(rehashExecutionProposal(enabledDispatch)), false,
    'a correctly rehashed proposal must still fail if a review-only gate is weakened');

  const enabledNode = structuredClone(proposal);
  enabledNode.nodes[0].execution = { enabled: true, executable: 'node', args: [], authorization: 'approved' };
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(rehashExecutionProposal(enabledNode)), false,
    'a correctly rehashed proposal must never authorize an executable node');

  const mismatchedBinding = structuredClone(proposal);
  mismatchedBinding.bindings[0].role = 'qa';
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(rehashExecutionProposalComponents(mismatchedBinding)), false,
    'a rehashed binding cannot change the Plan Graph step role without matching its pinned Execution Graph role contract');

  const duplicateBinding = structuredClone(proposal);
  duplicateBinding.bindings.push(structuredClone(duplicateBinding.bindings[0]));
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(rehashExecutionProposalComponents(duplicateBinding)), false,
    'the binding table must remain one-to-one with the Execution Graph nodes');

  const malformedNestedNode = structuredClone(proposal);
  malformedNestedNode.nodes[0] = null;
  assert.doesNotThrow(() => verifyAdaptiveGoalExecutionGraphProposalHash(rehashExecutionProposal(malformedNestedNode)),
    'malformed serialized node shapes must be handled by the verifier as invalid data');
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(rehashExecutionProposal(malformedNestedNode)), false);
});

test('serialized Execution Graph verifier binds every node source-file reference to the pinned source evidence snapshot', () => {
  const value = context();
  const base = buildAdaptiveGoalExecutionGraphProposal({
    sourcePlanProposal: value.sourcePlanProposal, readiness: value.readiness, taskBindings: value.taskBindings
  });
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(base), true);

  const forgedSourceFile = structuredClone(base);
  forgedSourceFile.nodes[0].supportingEvidence.sourceFiles[0].expectedSha256 = '0'.repeat(64);
  forgedSourceFile.nodes[0].supportingEvidence.sourceFiles[0].observedSha256 = '0'.repeat(64);
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(rehashExecutionProposal(forgedSourceFile)), false,
    'recomputing the outer unkeyed proposal hash cannot detach a node source file from the pinned source snapshot');

  const duplicateSourceFile = structuredClone(base);
  duplicateSourceFile.nodes[0].supportingEvidence.sourceFiles.push(structuredClone(duplicateSourceFile.nodes[0].supportingEvidence.sourceFiles[0]));
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(rehashExecutionProposal(duplicateSourceFile)), false,
    'duplicate source references must be rejected even when the outer envelope is recomputed');

  const unverifiedIntegrity = structuredClone(base);
  unverifiedIntegrity.nodes[0].supportingEvidence.sourceFilesIntegrityVerified = false;
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(rehashExecutionProposal(unverifiedIntegrity)), false,
    'a proposal cannot claim readiness while source-file integrity is marked false');
});

test('serialized Execution Graph verifier preserves Goal/Idea source-node identity across the Plan Graph step binding', () => {
  const value = context();
  const base = buildAdaptiveGoalExecutionGraphProposal({
    sourcePlanProposal: value.sourcePlanProposal, readiness: value.readiness, taskBindings: value.taskBindings
  });
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(base), true);

  const missingSourceDraft = structuredClone(base);
  delete missingSourceDraft.source.planGraphDraftSnapshot;
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(rehashExecutionProposal(missingSourceDraft)), false,
    'v1-style proposals without the original Plan Graph draft body are not accepted by the v2 verifier');

  const sourceDraftTampered = structuredClone(base);
  sourceDraftTampered.source.planGraphDraftSnapshot.steps[0].sourceNodeId = 'changed-only-inside-source-draft';
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(rehashExecutionProposal(sourceDraftTampered)), false,
    'a source-draft mapping change without a matching draftHash cannot be hidden by rehashing only the outer proposal');

  const changedSourceNode = structuredClone(base);
  changedSourceNode.nodes[0].sourceNodeId = 'different-goal-node';
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(rehashExecutionProposal(changedSourceNode)), false,
    'the original Plan Graph step ID must commit to its source Goal/Idea node, even when the outer envelope is re-hashed');

  const missingSourceNode = structuredClone(base);
  delete missingSourceNode.nodes[0].sourceNodeId;
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(rehashExecutionProposal(missingSourceNode)), false,
    'missing source-node identity must fail closed');

  const sourceNodeAndEnvelopeRehashed = structuredClone(base);
  sourceNodeAndEnvelopeRehashed.nodes[0].sourceNodeId = 'another-goal-node';
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(rehashExecutionProposalComponents(sourceNodeAndEnvelopeRehashed)), false,
    'recomputing all exposed component hashes must not detach source-node identity from its deterministic Plan Graph step ID');

  const sourceStepAndEnvelopeRehashed = structuredClone(base);
  const priorNodeId = sourceStepAndEnvelopeRehashed.nodes[0].id;
  const priorStepId = sourceStepAndEnvelopeRehashed.nodes[0].sourceStepId;
  const forgedSourceNodeId = 'forged-goal-node-outside-plan-draft';
  sourceStepAndEnvelopeRehashed.nodes[0].sourceNodeId = forgedSourceNodeId;
  sourceStepAndEnvelopeRehashed.nodes[0].sourceStepId = `agg-step-${createHash('sha256')
    .update(`${sourceStepAndEnvelopeRehashed.source.graphHash}\n${sourceStepAndEnvelopeRehashed.source.candidatePlanId}\n${forgedSourceNodeId}`).digest('hex').slice(0, 24)}`;
  sourceStepAndEnvelopeRehashed.nodes[0].id = `agg-eg-step-${createHash('sha256')
    .update(`${sourceStepAndEnvelopeRehashed.source.draftHash}\u0000${sourceStepAndEnvelopeRehashed.nodes[0].sourceStepId}`).digest('hex').slice(0, 24)}`;
  for (const binding of sourceStepAndEnvelopeRehashed.bindings) {
    if (binding.stepId === priorStepId) binding.stepId = sourceStepAndEnvelopeRehashed.nodes[0].sourceStepId;
  }
  sourceStepAndEnvelopeRehashed.edges = sourceStepAndEnvelopeRehashed.edges.map(edge => ({
    ...edge,
    from: edge.from === priorNodeId ? sourceStepAndEnvelopeRehashed.nodes[0].id : edge.from,
    to: edge.to === priorNodeId ? sourceStepAndEnvelopeRehashed.nodes[0].id : edge.to
  }));
  for (const node of sourceStepAndEnvelopeRehashed.nodes) {
    node.dependencies = node.dependencies.map(id => id === priorNodeId ? sourceStepAndEnvelopeRehashed.nodes[0].id : id);
  }
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(rehashExecutionProposalComponents(sourceStepAndEnvelopeRehashed)), false,
    'rewriting sourceNodeId, deterministic step/node IDs, binding IDs and every exposed hash must still fail unless the original Plan Graph draft mapping is preserved');
});

test('serialized Execution Graph verifier rejects rehashed duplicate dependencies and multi-node cycles', () => {
  const value = context();
  const base = buildAdaptiveGoalExecutionGraphProposal({
    sourcePlanProposal: value.sourcePlanProposal, readiness: value.readiness, taskBindings: value.taskBindings
  });
  const original = base.nodes[0];
  const secondStepId = `agg-step-${'b'.repeat(24)}`;
  const secondNode = structuredClone(original);
  secondNode.id = 'agg-exec-cycle-node-b';
  secondNode.sourceStepId = secondStepId;
  secondNode.dependencies = [];

  const cycle = structuredClone(base);
  cycle.nodes.push(structuredClone(secondNode));
  cycle.bindings.push({ ...cycle.bindings[0], stepId: secondStepId, taskId: 'standard-reviewer' });
  cycle.nodes[0].dependencies = [secondNode.id];
  cycle.nodes[1].dependencies = [cycle.nodes[0].id];
  cycle.edges = [
    { from: cycle.nodes[1].id, to: cycle.nodes[0].id, type: 'depends_on' },
    { from: cycle.nodes[0].id, to: cycle.nodes[1].id, type: 'depends_on' }
  ];
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(rehashExecutionProposalComponents(cycle)), false,
    'a matching edge list and recomputed outer/component hashes must not make a cyclic Execution Graph valid');

  const duplicate = structuredClone(base);
  duplicate.nodes.push(structuredClone(secondNode));
  duplicate.bindings.push({ ...duplicate.bindings[0], stepId: secondStepId, taskId: 'standard-reviewer' });
  duplicate.nodes[0].dependencies = [secondNode.id, secondNode.id];
  duplicate.edges = [
    { from: secondNode.id, to: duplicate.nodes[0].id, type: 'depends_on' },
    { from: secondNode.id, to: duplicate.nodes[0].id, type: 'depends_on' }
  ];
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(rehashExecutionProposalComponents(duplicate)), false,
    'duplicate dependencies must fail even when duplicate edges mirror them exactly');
});

test('proposal hash verifier rejects non-canonical JavaScript values even when the outer envelope is rehashed', () => {
  const value = context();
  const proposal = buildAdaptiveGoalExecutionGraphProposal({
    sourcePlanProposal: value.sourcePlanProposal, readiness: value.readiness, taskBindings: value.taskBindings
  });

  const undefinedValue = { ...structuredClone(proposal), untrustedExtension: undefined };
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(rehashExecutionProposal(undefinedValue)), false,
    'undefined is not JSON and must not have a distinct pre-serialization hash representation');

  const nonFiniteValue = { ...structuredClone(proposal), untrustedExtension: Number.NaN };
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(rehashExecutionProposal(nonFiniteValue)), false,
    'NaN must not be accepted as a canonical JSON number');

  const accessorValue = structuredClone(proposal);
  let getterInvoked = false;
  Object.defineProperty(accessorValue, 'untrustedExtension', { enumerable: true, get: () => { getterInvoked = true; return 'side effect'; } });
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(accessorValue), false,
    'accessors must not execute while validating a purported JSON proposal');
  assert.equal(getterInvoked, false, 'the verifier must inspect property descriptors without executing untrusted getters');

  const nonEnumerableValue = structuredClone(proposal);
  Object.defineProperty(nonEnumerableValue, 'untrustedExtension', { enumerable: false, value: 'hidden JSON field' });
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(nonEnumerableValue), false,
    'non-enumerable own properties must not be silently omitted from canonical proposal identity');

  const cyclicValue = structuredClone(proposal);
  cyclicValue.untrustedExtension = cyclicValue;
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(cyclicValue), false,
    'cyclic objects cannot represent serialized proposal data');

  const sharedChild = { untrusted: true };
  const aliasedValue = { ...structuredClone(proposal), untrustedExtension: [sharedChild, sharedChild] };
  assert.equal(verifyAdaptiveGoalExecutionGraphProposalHash(aliasedValue), false,
    'repeated object identity is not a JSON tree and must not be accepted as canonical input');
});

test('rejects serialized Plan Graph drafts whose unkeyed hash self-asserts upstream verification', () => {
  const value = context();
  const forgedDraft = structuredClone(value.sourcePlanProposal.draft);
  forgedDraft.source.verification = {
    status: 'verified', verified: true, providerId: 'trusted-provider', attestationId: 'a'.repeat(64),
    snapshotHash: 'b'.repeat(64), evidenceManifestHash: 'c'.repeat(64), trustRootSha256: 'd'.repeat(64),
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    claimVerified: true, independenceVerified: true
  };
  const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` :
    value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
  const { draftHash: _old, ...unsigned } = forgedDraft;
  forgedDraft.draftHash = createHash('sha256').update(stable(unsigned)).digest('hex');
  const forgedProposal = { ...value.sourcePlanProposal, draft: forgedDraft, draftHash: forgedDraft.draftHash };
  assert.throws(() => buildAdaptiveGoalExecutionGraphProposal({
    sourcePlanProposal: forgedProposal, readiness: { ...value.readiness, draftHash: forgedDraft.draftHash }, taskBindings: value.taskBindings
  }), /EXECUTION_GRAPH_SOURCE_DRAFT_INVALID|EXECUTION_GRAPH_SOURCE_VERIFICATION_MISMATCH/);
});

test('rejects caller-supplied source verification labels that disagree with the Plan Graph draft', () => {
  const value = context();
  const forgedSourceVerification = {
    status: 'verified', verified: true, providerId: 'claimed-provider', attestationId: 'a'.repeat(64),
    snapshotHash: 'b'.repeat(64), evidenceManifestHash: 'c'.repeat(64), trustRootSha256: 'd'.repeat(64),
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    claimVerified: true, independenceVerified: true
  };
  const mismatch = { ...value.sourcePlanProposal, sourceVerification: forgedSourceVerification };
  assert.throws(() => buildAdaptiveGoalExecutionGraphProposal({
    sourcePlanProposal: mismatch, readiness: value.readiness, taskBindings: value.taskBindings
  }), /EXECUTION_GRAPH_SOURCE_VERIFICATION_MISMATCH/);
});

test('rejects inconsistent readiness action mapping or conflicting evidence identity', () => {
  const value = context();
  const mismatch = structuredClone(value.readiness);
  mismatch.actions[0].roleContract.capability = 'research.collect';
  assert.throws(() => buildAdaptiveGoalExecutionGraphProposal({
    sourcePlanProposal: value.sourcePlanProposal, readiness: mismatch, taskBindings: value.taskBindings
  }), /EXECUTION_GRAPH_ACTION_CONTRACT_INVALID/);

  const conflictingEvidence = structuredClone(value.readiness);
  conflictingEvidence.actions[0].supportingEvidence.verifiedArtifacts[1].reference = conflictingEvidence.actions[0].supportingEvidence.verifiedArtifacts[0].reference;
  assert.throws(() => buildAdaptiveGoalExecutionGraphProposal({
    sourcePlanProposal: value.sourcePlanProposal, readiness: conflictingEvidence, taskBindings: value.taskBindings
  }), /EXECUTION_GRAPH_EVIDENCE_CONFLICT/);
});

test('rejects self/forward/cyclic Plan Graph dependencies even when an unverified draft is rehashed', () => {
  const value = context();
  const malformedDraft = structuredClone(value.sourcePlanProposal.draft);
  malformedDraft.steps[0].dependencies = [malformedDraft.steps[0].id];
  const rehashed = rehashDraft(malformedDraft);
  const malformedProposal = { ...value.sourcePlanProposal, draft: rehashed, draftHash: rehashed.draftHash };
  assert.throws(() => buildAdaptiveGoalExecutionGraphProposal({
    sourcePlanProposal: malformedProposal,
    readiness: { ...value.readiness, draftHash: rehashed.draftHash },
    taskBindings: value.taskBindings
  }), /EXECUTION_GRAPH_DEPENDENCY_INVALID/);
});
