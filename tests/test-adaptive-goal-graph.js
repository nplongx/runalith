import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  assessAdaptiveGoalCandidateEvidenceResolution,
  classifyAdaptiveGoalEvidenceReference,
  validateAdaptiveGoalGraph,
  searchAdaptiveGoalGraph,
  resolveAdaptiveGoalRecovery
} from '../src/runtime/adaptive-goal-graph.js';
import { projectAdaptiveGoalCandidateToPlanGraph } from '../src/runtime/adaptive-goal-plan-adapter.js';

function baseGraph({ nodes, edges, startNodeId = 'start', goalNodeId = 'goal' }) {
  return { schemaVersion: 1, startNodeId, goalNodeId, nodes, edges };
}

function node(id, extra = {}) {
  return { id, type: id === 'goal' ? 'goal' : 'task', ...extra };
}

function edge(from, to, type = 'next_step') {
  return { from, to, type };
}

test('validates and canonicalizes nodes and edges into stable graph identity', () => {
  const input = baseGraph({
    nodes: [node('goal'), node('start'), node('step')],
    edges: [edge('start', 'step'), edge('step', 'goal')]
  });
  const first = validateAdaptiveGoalGraph(input);
  const second = validateAdaptiveGoalGraph({
    ...input,
    nodes: [...input.nodes].reverse(),
    edges: [...input.edges].reverse()
  });
  assert.equal(first.graphHash, second.graphHash);
  assert.deepEqual(first.nodes.map(item => item.id), ['goal', 'start', 'step']);
  assert.deepEqual(first.edges.map(item => [item.from, item.to]), [['start', 'step'], ['step', 'goal']]);
});

test('rejects semantically mistyped goal endpoints and identical start/goal identities', () => {
  const wrongGoalType = baseGraph({
    nodes: [node('start', { type: 'idea' }), node('goal', { type: 'task' })],
    edges: [edge('start', 'goal')]
  });
  assert.throws(() => validateAdaptiveGoalGraph(wrongGoalType), /goalNodeId must identify a node with type goal/);
  const identicalEndpoints = baseGraph({
    startNodeId: 'goal', goalNodeId: 'goal',
    nodes: [node('goal', { type: 'goal' })], edges: []
  });
  assert.throws(() => validateAdaptiveGoalGraph(identicalEndpoints), /must identify distinct nodes/);
});

test('classifies the runtime artifact:// URI as durable-but-unverified evidence', () => {
  assert.equal(classifyAdaptiveGoalEvidenceReference('artifact://requirements-result-123'), 'durable_artifact_unverified');
  assert.equal(classifyAdaptiveGoalEvidenceReference('artifact://implementation-result_65c29c48-bc62-4866-990b-994898880d84'), 'durable_artifact_unverified');
  assert.equal(classifyAdaptiveGoalEvidenceReference('artifact:requirements-result-123'), 'durable_artifact_unverified');
  assert.equal(classifyAdaptiveGoalEvidenceReference('artifact://'), 'unresolved_reference');
});

test('assesses candidate evidence resolution without promoting source bytes or durable lineage to claim truth', () => {
  const sourceBytes = 'const evidenceSource = true;\n';
  const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
  const sourceRef = `file:tests/evidence-source.js#sha256=${sourceHash}`;
  const durableRef = 'artifact://requirements-result-123';
  const unresolvedRef = 'artifact://missing-result-456';
  const graph = baseGraph({
    nodes: [node('start', { type: 'goal' }), node('inspect-evidence', {
      evidenceRefs: [sourceRef, durableRef, unresolvedRef]
    }), node('goal', { type: 'goal' })],
    edges: [edge('start', 'inspect-evidence'), edge('inspect-evidence', 'goal')]
  });
  const search = searchAdaptiveGoalGraph(graph);
  const sourceEvidenceRecords = [{
    reference: sourceRef, classification: 'source_bytes_verified_claim_unverified', integrityVerified: true,
    claimVerified: false, independenceVerified: false, path: 'tests/evidence-source.js',
    expectedSha256: sourceHash, observedSha256: sourceHash, sizeBytes: Buffer.byteLength(sourceBytes), modifiedAt: '2026-10-22T00:00:00.000Z'
  }];
  const artifactEvidenceRecords = [
    {
      reference: durableRef, kind: 'durable_artifact', classification: 'durable_artifact_lineage_verified_claim_unverified',
      artifactId: 'requirements-result-123', sourceJobId: 'job_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      artifactType: 'requirements', schemaVersion: 1, artifactStatus: 'active', contentHash: 'a'.repeat(64),
      artifactCreatedEventId: 'event-artifact-created', lineageValid: true, producerContractValid: true,
      producerRole: 'qa', producerTaskId: 'task-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', producerTaskStatus: 'completed',
      producerTaskCompleted: true, producerResultId: 'result-123', producerResultOutcome: 'success',
      producerResultLineageValid: true, producerCompletionEventId: 'event-task-completed',
      producerCompletionEventType: 'task.local_completed', lineageVerified: true,
      claimVerified: false, independentAttestationVerified: false
    },
    { reference: unresolvedRef, kind: 'declared_reference', classification: 'unresolved_reference',
      integrityVerified: false, lineageVerified: false, claimVerified: false, independentAttestationVerified: false }
  ];

  const assessment = assessAdaptiveGoalCandidateEvidenceResolution({
    graph, searchResult: search, candidatePlanId: search.candidates[0].planId, sourceEvidenceRecords, artifactEvidenceRecords
  });
  assert.equal(assessment.status, 'evidence_resolution_incomplete');
  assert.equal(assessment.targetBinding.graphHash, search.graphHash);
  assert.equal(assessment.targetBinding.candidatePlanId, search.candidates[0].planId);
  assert.equal(assessment.targetBinding.runtimeBundleSha256, null, 'MCP server has no trusted self-bundle digest to bind here');
  assert.equal(assessment.declaredReferenceCount, 3);
  assert.equal(assessment.sourceIntegrityVerifiedCount, 1);
  assert.equal(assessment.durableArtifactLineageVerifiedCount, 1);
  assert.equal(assessment.invalidProvenanceCount, 0);
  assert.equal(assessment.unresolvedReferenceCount, 1);
  assert.equal(assessment.referenceResolutionCoverage, 0.666667);
  assert.equal(assessment.durableArtifactLineageCoverage, 0.333333);
  assert.equal(assessment.claimVerifiedReferenceCount, 0);
  assert.equal(assessment.independentAttestationVerifiedReferenceCount, 0);
  assert.equal(assessment.claimCoverage, 0);
  assert.equal(assessment.independentAttestationCoverage, 0);
  assert.equal(assessment.candidateVerified, false);
  assert.equal(assessment.candidateVerificationPreserved, true);
  assert.equal(search.candidates[0].verification.verified, false);
  assert.equal(search.candidates[0].evidence.verifiedReferenceCount, 0);
  assert.equal(search.candidates[0].evidence.coverage, 0, 'core evidence/claim coverage remains unverified and is not overwritten with resolver metrics');
  assert.match(assessment.assessmentHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(assessment, assessAdaptiveGoalCandidateEvidenceResolution({
    graph, searchResult: search, candidatePlanId: search.candidates[0].planId, sourceEvidenceRecords, artifactEvidenceRecords
  }), 'equal graph/candidate/resolver bytes produce a deterministic assessment hash and record');
});

test('evidence assessment marks stale source hashes and invalid durable lineage as failures', () => {
  const sourceRef = `file:tests/old-source.js#sha256=${'a'.repeat(64)}`;
  const durableRef = 'artifact://stale-result-789';
  const graph = baseGraph({
    nodes: [node('start', { type: 'goal' }), node('inspect', { evidenceRefs: [sourceRef, durableRef] }), node('goal', { type: 'goal' })],
    edges: [edge('start', 'inspect'), edge('inspect', 'goal')]
  });
  const search = searchAdaptiveGoalGraph(graph);
  const assessment = assessAdaptiveGoalCandidateEvidenceResolution({
    graph, searchResult: search, candidatePlanId: search.candidates[0].planId,
    sourceEvidenceRecords: [{ reference: sourceRef, classification: 'source_hash_mismatch', integrityVerified: false,
      claimVerified: false, independenceVerified: false, path: 'tests/old-source.js', expectedSha256: 'a'.repeat(64),
      observedSha256: 'b'.repeat(64), sizeBytes: 10 }],
    artifactEvidenceRecords: [{ reference: durableRef, kind: 'durable_artifact', classification: 'durable_artifact_lineage_invalid',
      artifactId: 'stale-result-789', sourceJobId: 'job_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', artifactType: 'requirements', schemaVersion: 1,
      artifactStatus: 'superseded', contentHash: 'c'.repeat(64), artifactCreatedEventId: 'event-old-created', lineageValid: true,
      producerContractValid: true, producerRole: 'qa', producerTaskId: 'task-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      producerTaskStatus: 'completed', producerTaskCompleted: true, producerResultId: 'result-stale', producerResultOutcome: 'failed',
      producerResultLineageValid: false, producerCompletionEventId: null, producerCompletionEventType: null,
      lineageVerified: false, claimVerified: false, independentAttestationVerified: false }]
  });
  assert.equal(assessment.sourceIntegrityVerifiedCount, 0);
  assert.equal(assessment.durableArtifactLineageVerifiedCount, 0);
  assert.equal(assessment.invalidProvenanceCount, 2);
  assert.equal(assessment.unresolvedReferenceCount, 0);
  assert.equal(assessment.resolutions.find(item => item.reference === sourceRef)?.status, 'source_hash_mismatch_or_stale');
  assert.equal(assessment.resolutions.find(item => item.reference === durableRef)?.status, 'durable_artifact_lineage_invalid');
  assert.equal(assessment.claimCoverage, 0);
  assert.equal(assessment.independentAttestationCoverage, 0);
});

test('keeps lexical artifact URI classification separate from an unresolved runtime resolver result', () => {
  const reference = 'artifact://missing_result-0123';
  const graph = baseGraph({
    nodes: [node('start', { type: 'goal' }), node('inspect', { evidenceRefs: [reference] }), node('goal', { type: 'goal' })],
    edges: [edge('start', 'inspect'), edge('inspect', 'goal')]
  });
  const search = searchAdaptiveGoalGraph(graph);
  const assessment = assessAdaptiveGoalCandidateEvidenceResolution({
    graph, searchResult: search, candidatePlanId: search.candidates[0].planId,
    artifactEvidenceRecords: [{ reference, kind: 'declared_reference', classification: 'not_content_addressed',
      integrityVerified: false, lineageVerified: false, claimVerified: false, independentAttestationVerified: false }]
  });
  assert.equal(assessment.resolutions[0].kind, 'declared_reference');
  assert.equal(assessment.resolutions[0].status, 'unresolved_reference');
  assert.equal(assessment.resolutions[0].classification, 'durable_artifact_unverified');
  assert.equal(assessment.resolutions[0].resolverClassification, 'not_content_addressed');
  assert.equal(assessment.resolutions[0].lineageVerified, false);
  assert.equal(assessment.claimCoverage, 0);
  assert.equal(assessment.independentAttestationCoverage, 0);
});

test('evidence assessment fails closed on forged resolver trust claims, duplicate records, and mismatched graph binding', () => {
  const sourceRef = `file:tests/source.js#sha256=${'a'.repeat(64)}`;
  const graph = baseGraph({
    nodes: [node('start', { type: 'goal' }), node('inspect', { evidenceRefs: [sourceRef] }), node('goal', { type: 'goal' })],
    edges: [edge('start', 'inspect'), edge('inspect', 'goal')]
  });
  const search = searchAdaptiveGoalGraph(graph);
  const sourceRecord = { reference: sourceRef, classification: 'source_bytes_verified_claim_unverified', integrityVerified: true,
    claimVerified: false, independenceVerified: false, path: 'tests/source.js', expectedSha256: 'a'.repeat(64),
    observedSha256: 'a'.repeat(64), sizeBytes: 1 };
  assert.throws(() => assessAdaptiveGoalCandidateEvidenceResolution({
    graph: { ...graph, nodes: [...graph.nodes, node('extra')] }, searchResult: search,
    candidatePlanId: search.candidates[0].planId, sourceEvidenceRecords: [sourceRecord]
  }), /exact canonical graph/);
  assert.throws(() => assessAdaptiveGoalCandidateEvidenceResolution({
    graph, searchResult: search, candidatePlanId: search.candidates[0].planId,
    sourceEvidenceRecords: [{ ...sourceRecord, claimVerified: true }]
  }), /source evidence .* violates/);
  assert.throws(() => assessAdaptiveGoalCandidateEvidenceResolution({
    graph, searchResult: search, candidatePlanId: search.candidates[0].planId,
    sourceEvidenceRecords: [sourceRecord, sourceRecord]
  }), /duplicate reference/);
  assert.throws(() => assessAdaptiveGoalCandidateEvidenceResolution({
    graph, searchResult: search, candidatePlanId: search.candidates[0].planId,
    sourceEvidenceRecords: [sourceRecord, { ...sourceRecord, reference: `file:tests/unrelated.js#sha256=${'b'.repeat(64)}`,
      path: 'tests/unrelated.js', expectedSha256: 'b'.repeat(64), observedSha256: 'b'.repeat(64) }]
  }), /outside the candidate's exact reference set/);
  const forgedSearch = { ...search, candidates: search.candidates.map(candidate => ({
    ...candidate, evidence: { ...candidate.evidence, verifiedReferenceCount: 1 }
  })) };
  assert.throws(() => assessAdaptiveGoalCandidateEvidenceResolution({
    graph, searchResult: forgedSearch, candidatePlanId: search.candidates[0].planId, sourceEvidenceRecords: [sourceRecord]
  }), /does not reproduce/);
  const forgedRefsSearch = { ...search, candidates: search.candidates.map(candidate => ({
    ...candidate, supportingEvidenceRefs: []
  })) };
  assert.throws(() => assessAdaptiveGoalCandidateEvidenceResolution({
    graph, searchResult: forgedRefsSearch, candidatePlanId: search.candidates[0].planId, sourceEvidenceRecords: [sourceRecord]
  }), /does not reproduce/);
});

test('rejects duplicate IDs, dangling references, malformed metrics and unsupported fields', () => {
  assert.throws(() => validateAdaptiveGoalGraph(baseGraph({
    nodes: [node('start'), node('start'), node('goal')],
    edges: []
  })), /node IDs must be unique/);
  assert.throws(() => validateAdaptiveGoalGraph(baseGraph({
    nodes: [node('start'), node('goal')],
    edges: [edge('start', 'missing')]
  })), /edge\.to references an unknown node/);
  assert.throws(() => validateAdaptiveGoalGraph(baseGraph({
    nodes: [node('start'), node('goal', { estimatedRisk: 1.2 })],
    edges: []
  })), /estimatedRisk must be a finite number/);
  assert.throws(() => validateAdaptiveGoalGraph({
    ...baseGraph({ nodes: [node('start'), node('goal')], edges: [] }),
    arbitraryCommand: 'not-allowed'
  }), /unsupported fields/);
});

test('rejects cycles in transition edges and prerequisite relationships', () => {
  assert.throws(() => validateAdaptiveGoalGraph(baseGraph({
    nodes: [node('start'), node('middle'), node('goal')],
    edges: [edge('start', 'middle'), edge('middle', 'start'), edge('middle', 'goal')]
  })), /transition cycle detected/);
  assert.throws(() => validateAdaptiveGoalGraph(baseGraph({
    nodes: [node('start'), node('middle'), node('goal')],
    edges: [edge('start', 'middle', 'requires_all'), edge('middle', 'start', 'requires_all')]
  })), /prerequisite cycle detected/);
});

test('supports alternate paths and returns a risk/confidence-aware candidate order', () => {
  const graph = baseGraph({
    nodes: [
      node('start'),
      node('fast', { estimatedCost: 1, estimatedRisk: 0.55, estimatedSuccessConfidence: 0.55 }),
      node('robust', { estimatedCost: 4, estimatedRisk: 0.03, estimatedSuccessConfidence: 0.96, reusePotential: 0.4 }),
      node('goal')
    ],
    edges: [
      edge('start', 'fast'),
      edge('fast', 'goal'),
      edge('start', 'robust'),
      edge('robust', 'goal')
    ]
  });
  const result = searchAdaptiveGoalGraph(graph, { beamWidth: 8, maxDepth: 4, maxExpansions: 20 });
  assert.equal(result.status, 'proposals_found');
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates[0].pathNodeIds, ['start', 'robust', 'goal']);
  assert.deepEqual(result.candidates[1].pathNodeIds, ['start', 'fast', 'goal']);
  assert.notEqual(result.candidates[0].metrics.estimatedCost, result.candidates[1].metrics.estimatedCost);
});

test('keeps support, tested-hypothesis, and evidence semantics intact after indexing', () => {
  const graph = baseGraph({
    nodes: [
      node('start', { type: 'goal' }),
      node('hypothesis', { type: 'hypothesis', evidenceRefs: ['note:hypothesis'] }),
      node('experiment', { type: 'experiment', evidenceRefs: ['note:experiment'] }),
      node('evidence-node', { type: 'evidence', evidenceRefs: ['artifact:result-1'] }),
      node('goal', { type: 'goal' }),
      node('conflicting-idea', { type: 'idea' })
    ],
    edges: [
      edge('start', 'hypothesis'),
      edge('hypothesis', 'experiment'),
      edge('experiment', 'evidence-node'),
      edge('evidence-node', 'goal'),
      edge('hypothesis', 'experiment', 'tested_by'),
      edge('hypothesis', 'goal', 'supports'),
      edge('hypothesis', 'conflicting-idea', 'contradicts')
    ]
  });
  const result = searchAdaptiveGoalGraph(graph, { beamWidth: 4, maxDepth: 8, maxExpansions: 40 });
  const candidate = result.candidates.find(item => item.pathNodeIds.at(-1) === 'goal');
  assert.ok(candidate);
  assert.equal(candidate.semantics.supportEdgeCount, 1);
  assert.equal(candidate.semantics.testedHypothesisCount, 1);
  assert.equal(candidate.semantics.hypothesisCount, 1);
  assert.equal(candidate.semantics.untestedHypothesisCount, 0);
  assert.equal(candidate.semantics.evidenceNodeCount, 1);
  assert.equal(candidate.semantics.declaredEvidenceRefCount, 3);
  assert.equal(candidate.semantics.contradictionCount, 0);
  assert.equal(candidate.verification.verified, false);
});

test('requires all prerequisite nodes before expanding a dependent node', () => {
  const graph = baseGraph({
    nodes: [
      node('start'),
      node('setup-a', { estimatedCost: 1 }),
      node('setup-b', { estimatedCost: 1 }),
      node('merge', { estimatedCost: 2 }),
      node('goal')
    ],
    edges: [
      edge('start', 'setup-a'),
      edge('start', 'setup-b'),
      edge('setup-a', 'setup-b'),
      edge('setup-a', 'merge'),
      edge('setup-b', 'merge'),
      edge('merge', 'goal'),
      edge('setup-a', 'merge', 'requires_all'),
      edge('setup-b', 'merge', 'requires_all')
    ]
  });
  const result = searchAdaptiveGoalGraph(graph, { beamWidth: 10, maxDepth: 5, maxExpansions: 40 });
  const mergeCandidates = result.bestPartialCandidates.filter(candidate => candidate.pathNodeIds.at(-1) === 'merge');
  assert.ok(result.candidates.some(candidate => candidate.pathNodeIds.includes('setup-a') && candidate.pathNodeIds.includes('setup-b') && candidate.pathNodeIds.includes('merge')));
  assert.equal(mergeCandidates.some(candidate => !candidate.pathNodeIds.includes('setup-a') || !candidate.pathNodeIds.includes('setup-b')), false);
});

test('terminates with explicit budget and depth states', () => {
  const branching = baseGraph({
    nodes: [node('start'), node('branch-a'), node('branch-b'), node('goal')],
    edges: [edge('start', 'branch-a'), edge('start', 'branch-b'), edge('branch-b', 'goal')]
  });
  const exhausted = searchAdaptiveGoalGraph(branching, { beamWidth: 4, maxDepth: 4, maxExpansions: 1 });
  assert.equal(exhausted.status, 'budget_exhausted');
  assert.equal(exhausted.search.terminationReason, 'max_expansions');
  assert.equal(exhausted.search.expansions, 1);

  const deep = baseGraph({
    nodes: [node('start'), node('middle'), node('goal')],
    edges: [edge('start', 'middle'), edge('middle', 'goal')]
  });
  const depthLimited = searchAdaptiveGoalGraph(deep, { maxDepth: 1, beamWidth: 4, maxExpansions: 10 });
  assert.equal(depthLimited.status, 'max_depth_reached');
  assert.equal(depthLimited.search.terminationReason, 'max_depth');
});

test('uses stable plan IDs and ordering for equal inputs', () => {
  const graph = baseGraph({
    nodes: [node('start'), node('left'), node('right'), node('goal')],
    edges: [edge('start', 'left'), edge('left', 'goal'), edge('start', 'right'), edge('right', 'goal')]
  });
  const a = searchAdaptiveGoalGraph(graph, { beamWidth: 8, maxDepth: 4, maxExpansions: 20 });
  const b = searchAdaptiveGoalGraph(graph, { beamWidth: 8, maxDepth: 4, maxExpansions: 20 });
  assert.deepEqual(a, b);
  assert.equal(new Set(a.candidates.map(candidate => candidate.planId)).size, a.candidates.length);
});

test('keeps suggestions separate from actual verification evidence', () => {
  const graph = baseGraph({
    nodes: [
      node('start'),
      node('experiment', { evidenceRefs: ['fixture:evidence-123'], estimatedSuccessConfidence: 0.9 }),
      node('goal')
    ],
    edges: [edge('start', 'experiment'), edge('experiment', 'goal')]
  });
  const result = searchAdaptiveGoalGraph(graph);
  const candidate = result.candidates[0];
  assert.deepEqual(candidate.supportingEvidenceRefs, ['fixture:evidence-123']);
  assert.deepEqual(candidate.verification, { status: 'unverified', verified: false, evidenceRefs: [] });
  assert.equal(result.mode, 'shadow');
  assert.equal(candidate.status, 'proposed');
});

test('merges equivalent convergent states while preserving alternate edge lineage', () => {
  const graph = baseGraph({
    nodes: [node('start'), node('middle'), node('goal')],
    edges: [
      edge('start', 'middle', 'next_step'),
      edge('start', 'middle', 'enables'),
      edge('middle', 'goal')
    ]
  });
  const result = searchAdaptiveGoalGraph(graph, { beamWidth: 4, maxDepth: 4, maxExpansions: 20 });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].lineageCount, 2);
  assert.equal(result.candidates[0].alternativeLineages.length, 1);
  assert.equal(result.candidates[0].alternativeLineages[0].pathNodeIds.join(','), 'start,middle,goal');
  assert.equal(result.candidates[0].verification.verified, false);
});

test('caps completed candidates at beam width and marks pruned search non-exhaustive', () => {
  const graph = baseGraph({
    nodes: [
      node('start'),
      node('cheap', { estimatedCost: 1, estimatedSuccessConfidence: 0.7 }),
      node('balanced', { estimatedCost: 2, estimatedSuccessConfidence: 0.8 }),
      node('robust', { estimatedCost: 3, estimatedSuccessConfidence: 0.95 }),
      node('goal')
    ],
    edges: [
      edge('start', 'goal'),
      edge('start', 'cheap'), edge('cheap', 'goal'),
      edge('start', 'balanced'), edge('balanced', 'goal'),
      edge('start', 'robust'), edge('robust', 'goal')
    ]
  });
  const result = searchAdaptiveGoalGraph(graph, { beamWidth: 2, maxDepth: 4, maxExpansions: 30 });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.search.prunedStates, 2, 'one frontier state and one complete candidate are pruned');
  assert.equal(result.search.exhaustive, false);
  assert.equal(result.search.terminationReason, 'frontier_exhausted_with_pruning');
});

test('reports budget exhaustion even when a goal proposal was found before the budget ran out', () => {
  const graph = baseGraph({
    nodes: [node('start'), node('goal'), node('later')],
    edges: [edge('start', 'goal'), edge('start', 'later'), edge('later', 'goal')]
  });
  const result = searchAdaptiveGoalGraph(graph, { beamWidth: 4, maxDepth: 5, maxExpansions: 2 });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.status, 'budget_exhausted');
  assert.equal(result.search.terminationReason, 'max_expansions');
  assert.equal(result.search.exhaustive, false);
});

test('does not mark depth exhaustion when every outgoing edge is ineligible', () => {
  const graph = baseGraph({
    nodes: [node('start'), node('blocked'), node('prereq'), node('goal')],
    edges: [
      edge('start', 'blocked'),
      edge('blocked', 'goal'),
      edge('prereq', 'goal', 'requires_all')
    ]
  });
  const result = searchAdaptiveGoalGraph(graph, { beamWidth: 4, maxDepth: 1, maxExpansions: 20 });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.search.terminationReason, 'frontier_exhausted');
  assert.equal(result.search.exhaustive, true);
});

test('propagates omitted lineage counts to descendant candidates and reports pruning', () => {
  const pairTypes = ['next_step', 'enables'];
  const nodes = [node('start'), node('middle-a'), node('middle-b'), node('middle-c'), node('middle-d'), node('middle-e'), node('goal')];
  const edges = [
    ...pairTypes.map(type => edge('start', 'middle-a', type)),
    ...pairTypes.map(type => edge('middle-a', 'middle-b', type)),
    ...pairTypes.map(type => edge('middle-b', 'middle-c', type)),
    ...pairTypes.map(type => edge('middle-c', 'middle-d', type)),
    ...pairTypes.map(type => edge('middle-d', 'middle-e', type)),
    edge('middle-e', 'goal')
  ];
  const result = searchAdaptiveGoalGraph(baseGraph({ nodes, edges }), {
    beamWidth: 4, maxDepth: 6, maxExpansions: 50
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].lineageCount, 32);
  assert.equal(result.candidates[0].omittedLineageCount, 16);
  assert.equal(result.candidates[0].alternativeLineages.length, 15);
  assert.equal(result.search.terminationReason, 'frontier_exhausted_with_pruning');
  assert.equal(result.search.exhaustive, false);
});

test('unknown metrics remain null and caller estimates are explicitly unverified', () => {
  const result = searchAdaptiveGoalGraph(baseGraph({
    nodes: [node('start'), node('work', { estimatedCost: 3, metricProvenance: {
      estimatedCost: { method: 'manual rough estimate', sourceRefs: ['fixture:effort-note'], confidence: 0.4 }
    } }), node('goal')],
    edges: [edge('start', 'work'), edge('work', 'goal')]
  }));
  const candidate = result.candidates[0];
  assert.equal(candidate.metrics.estimatedCost, 3);
  assert.equal(candidate.metrics.estimatedRisk, null);
  assert.equal(candidate.metrics.estimatedSuccessConfidence, null);
  assert.equal(candidate.metrics.metricProvenance.estimatedCost.classification, 'caller_estimate_unverified');
  assert.equal(candidate.metrics.metricProvenance.estimatedCost.provenanceVerified, false);
  assert.equal(candidate.metrics.metricProvenance.estimatedRisk.classification, 'unknown');
});

test('beam audit is deterministic and explains selection/pruning separately from convergent lineage', () => {
  const graph = baseGraph({
    nodes: [node('start'), node('cheap', { estimatedCost: 1, estimatedRisk: 0.8, estimatedSuccessConfidence: 0.5 }),
      node('robust', { estimatedCost: 4, estimatedRisk: 0.05, estimatedSuccessConfidence: 0.9 }), node('goal')],
    edges: [edge('start', 'cheap'), edge('cheap', 'goal'), edge('start', 'robust'), edge('robust', 'goal')]
  });
  const a = searchAdaptiveGoalGraph(graph, { beamWidth: 1, maxDepth: 4, maxExpansions: 20 });
  const b = searchAdaptiveGoalGraph(graph, { beamWidth: 1, maxDepth: 4, maxExpansions: 20 });
  assert.deepEqual(a, b);
  assert.equal(a.candidates[0].pathNodeIds.join(','), 'start,robust,goal');
  assert.ok(a.search.prunedStates > 0);
  assert.equal(a.search.exhaustive, false);
  assert.ok(a.auditTrace.events.some(event => event.type === 'frontier_pruned' && event.reason === 'beam_width_exceeded'));
  assert.ok(a.auditTrace.prunedBranches.some(branch => branch.reason === 'beam_width_exceeded'));
  assert.equal(a.auditTrace.heuristicVersion, 'lexicographic-unknown-aware@2');
  assert.equal(a.auditTrace.deterministic, true);
});

test('outcome-aware recovery only offers a matching conditional edge and remains non-authorizing', () => {
  const graph = baseGraph({
    nodes: [node('start'), node('evidence', { type: 'evidence', evidenceRefs: ['file:tests/example.js#sha256=' + 'a'.repeat(64)] }),
      node('repair'), node('goal')],
    edges: [edge('start', 'goal'), {
      from: 'start', to: 'repair', type: 'recovers_to',
      condition: { onOutcome: 'verification_failed', requiresEvidenceNodeIds: ['evidence'], requiresAllNodeIds: [] }
    }]
  });
  const missing = resolveAdaptiveGoalRecovery(graph, {
    sourceNodeId: 'start', outcome: 'verification_failed', availableNodeIds: [], availableEvidenceNodeIds: []
  });
  assert.equal(missing.status, 'recovery_blocked');
  assert.ok(missing.rejectedOptions[0].blockers.some(item => item.code === 'RECOVERY_EVIDENCE_PREREQUISITES_MISSING'));
  const wrongOutcome = resolveAdaptiveGoalRecovery(graph, {
    sourceNodeId: 'start', outcome: 'failed', availableNodeIds: [], availableEvidenceNodeIds: ['evidence']
  });
  assert.equal(wrongOutcome.status, 'recovery_blocked');
  assert.ok(wrongOutcome.rejectedOptions[0].blockers.some(item => item.code === 'RECOVERY_OUTCOME_MISMATCH'));
  const eligible = resolveAdaptiveGoalRecovery(graph, {
    sourceNodeId: 'start', outcome: 'verification_failed', availableNodeIds: [], availableEvidenceNodeIds: ['evidence']
  });
  assert.equal(eligible.status, 'recovery_options_found');
  assert.equal(eligible.options[0].edge.to, 'repair');
  assert.equal(eligible.evidenceVerification, 'not_independently_verified');
  assert.equal(eligible.executionAuthorized, false);
  assert.equal(eligible.dispatchAllowed, false);
});

test('contradictory and mutually exclusive alternative nodes cannot coexist in one candidate', () => {
  const graph = baseGraph({
    nodes: [node('start'), node('hypothesis-a', { type: 'hypothesis' }), node('hypothesis-b', { type: 'hypothesis' }), node('goal')],
    edges: [edge('start', 'hypothesis-a'), edge('hypothesis-a', 'hypothesis-b'), edge('hypothesis-b', 'goal'),
      { from: 'hypothesis-a', to: 'hypothesis-b', type: 'contradicts' }]
  });
  const result = searchAdaptiveGoalGraph(graph);
  assert.equal(result.candidates.length, 0);
  assert.ok(result.auditTrace.events.some(event => event.reason === 'contradictory_nodes_in_same_candidate'));
});

test('does not expand a node when one of its AND prerequisites is missing', () => {
  const graph = baseGraph({
    nodes: [node('start'), node('available'), node('missing'), node('dependent'), node('goal')],
    edges: [
      edge('start', 'available'),
      edge('available', 'dependent'),
      edge('dependent', 'goal'),
      edge('available', 'dependent', 'requires_all'),
      edge('missing', 'dependent', 'requires_all')
    ]
  });
  const result = searchAdaptiveGoalGraph(graph, { beamWidth: 8, maxDepth: 6, maxExpansions: 20 });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.bestPartialCandidates.some(candidate => candidate.pathNodeIds.includes('dependent')), false);
});


test('projects a complete AGG candidate into a deterministic review-only Plan Graph draft', () => {
  const graph = baseGraph({
    nodes: [
      node('start', { type: 'goal', label: 'Current state' }),
      node('prepare-a', { label: 'Prepare prerequisite A' }),
      node('prepare-b', { label: 'Prepare prerequisite B' }),
      node('idea', { type: 'idea', label: 'Approach context', evidenceRefs: ['note:context-1'] }),
      node('experiment', { type: 'experiment', label: 'Run a bounded experiment', estimatedCost: 2, estimatedRisk: 0.1 }),
      node('goal', { type: 'goal', label: 'Target state' })
    ],
    edges: [
      edge('start', 'prepare-a'), edge('prepare-a', 'prepare-b'), edge('prepare-b', 'idea'),
      edge('idea', 'experiment'), edge('experiment', 'goal'),
      edge('prepare-a', 'experiment', 'requires_all'), edge('prepare-b', 'experiment', 'requires_all')
    ]
  });
  const before = structuredClone(graph);
  const options = { beamWidth: 8, maxDepth: 8, maxExpansions: 100 };
  const search = searchAdaptiveGoalGraph(graph, options);
  const candidate = search.candidates[0];
  const draftA = projectAdaptiveGoalCandidateToPlanGraph(graph, candidate, options);
  const draftB = projectAdaptiveGoalCandidateToPlanGraph(graph, candidate, options);

  assert.deepEqual(graph, before, 'projection must not mutate the caller graph');
  assert.deepEqual(draftA, draftB, 'equal graph/candidate/options must produce byte-stable draft data');
  assert.match(draftA.draftHash, /^[a-f0-9]{64}$/);
  assert.equal(draftA.kind, 'adaptive_goal_plan_graph_draft');
  assert.equal(draftA.status, 'review_required');
  assert.deepEqual(draftA.goal, { nodeId: 'goal', label: 'Target state' });
  assert.deepEqual(draftA.sourcePathNodeIds, ['start', 'prepare-a', 'prepare-b', 'idea', 'experiment', 'goal']);
  assert.deepEqual(draftA.contextNodes, [{
    id: 'idea', type: 'idea', label: 'Approach context', supportingEvidenceRefs: ['note:context-1'],
    evidenceAssessment: { status: 'declared_unverified', references: [{ reference: 'note:context-1', classification: 'unresolved_reference', verified: false }], verifiedReferenceCount: 0 }
  }]);
  assert.equal(draftA.steps.length, 3);
  assert.equal(draftA.steps[0].sourceNodeId, 'prepare-a');
  assert.equal(draftA.steps[1].sourceNodeId, 'prepare-b');
  assert.equal(draftA.steps[2].sourceNodeId, 'experiment');
  assert.deepEqual(draftA.steps[0].dependencies, []);
  assert.deepEqual(draftA.steps[1].dependencies, [draftA.steps[0].id]);
  assert.deepEqual(draftA.steps[2].dependencies, [draftA.steps[0].id, draftA.steps[1].id],
    'the explicit AND prerequisites must be mapped to action dependencies in path order');
  assert.ok(draftA.steps.every(step => step.execution.enabled === false && step.execution.authorization === 'none'));
  assert.equal(draftA.source.verification.verified, false);
  assert.equal(draftA.steps[0].estimates.cost, null);
  assert.equal(draftA.steps[0].estimates.successConfidence, null);
  assert.equal(draftA.steps[0].estimates.metricProvenance.estimatedCost.classification, 'unknown');
  assert.equal(draftA.steps[2].evidenceAssessment.status, 'missing');
  assert.equal(draftA.gates.humanReviewRequired, true);
  assert.equal(draftA.gates.workflowApprovalRequired, true);
  assert.equal(draftA.gates.immutableExecutionPlanCreated, false);
  assert.equal(draftA.gates.dispatchAllowed, false);
  assert.equal(draftA.gates.executionAuthorized, false);
});

test('refuses forged, stale, partial, and non-actionable AGG candidates', () => {
  const graph = baseGraph({
    nodes: [node('start', { type: 'goal' }), node('work'), node('goal', { type: 'goal' })],
    edges: [edge('start', 'work'), edge('work', 'goal')]
  });
  const search = searchAdaptiveGoalGraph(graph, { beamWidth: 4 });
  const candidate = search.candidates[0];
  assert.throws(() => projectAdaptiveGoalCandidateToPlanGraph(graph, { ...candidate, status: 'partial_proposal' }), /does not exactly match/);
  assert.throws(() => projectAdaptiveGoalCandidateToPlanGraph(graph, { ...candidate, pathNodeIds: ['start', 'goal'] }), /does not exactly match/);
  assert.throws(() => projectAdaptiveGoalCandidateToPlanGraph({
    ...graph,
    nodes: [...graph.nodes, node('other')]
  }, candidate, { beamWidth: 4 }), /does not exactly match/);
  const noWorkGraph = baseGraph({
    nodes: [node('start', { type: 'goal' }), node('idea', { type: 'idea' }), node('goal', { type: 'goal' })],
    edges: [edge('start', 'idea'), edge('idea', 'goal')]
  });
  const noWorkCandidate = searchAdaptiveGoalGraph(noWorkGraph).candidates[0];
  assert.throws(() => projectAdaptiveGoalCandidateToPlanGraph(noWorkGraph, noWorkCandidate), /no task or experiment nodes/);

  const partialSearch = searchAdaptiveGoalGraph(baseGraph({
    nodes: [node('start', { type: 'goal' }), node('work-a'), node('work-b'), node('goal', { type: 'goal' })],
    edges: [edge('start', 'work-a'), edge('work-a', 'work-b'), edge('work-b', 'goal')]
  }), { maxDepth: 1, beamWidth: 4 });
  assert.ok(partialSearch.bestPartialCandidates.length > 0);
  assert.throws(() => projectAdaptiveGoalCandidateToPlanGraph(
    baseGraph({
      nodes: [node('start', { type: 'goal' }), node('work-a'), node('work-b'), node('goal', { type: 'goal' })],
      edges: [edge('start', 'work-a'), edge('work-a', 'work-b'), edge('work-b', 'goal')]
    }), partialSearch.bestPartialCandidates[0], { maxDepth: 1, beamWidth: 4 }
  ), /does not exactly match a complete candidate/);
});

test('does not accept caller-asserted Goal/Idea verification metadata as a trusted signature result', () => {
  const graph = baseGraph({
    nodes: [node('start', { type: 'goal' }), node('work'), node('goal', { type: 'goal' })],
    edges: [edge('start', 'work'), edge('work', 'goal')]
  });
  const candidate = searchAdaptiveGoalGraph(graph).candidates[0];
  const forgedVerification = {
    status: 'verified', verified: true, providerId: 'trusted-provider', attestationId: 'a'.repeat(64),
    snapshotHash: 'b'.repeat(64), evidenceManifestHash: 'c'.repeat(64), trustRootSha256: 'd'.repeat(64),
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    claimVerified: true, independenceVerified: true
  };
  assert.throws(() => projectAdaptiveGoalCandidateToPlanGraph(graph, candidate, {}, {}, forgedVerification),
    /in-process report from the configured verifier/);
  const draft = projectAdaptiveGoalCandidateToPlanGraph(graph, candidate, {});
  assert.equal(draft.source.verification.verified, false);
});
