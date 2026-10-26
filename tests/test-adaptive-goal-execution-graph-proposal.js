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
  }), /EXECUTION_GRAPH_SOURCE_DRAFT_INVALID/);
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
