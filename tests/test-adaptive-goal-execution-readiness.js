import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { searchAdaptiveGoalGraph } from '../src/runtime/adaptive-goal-graph.js';
import { projectAdaptiveGoalCandidateToPlanGraph } from '../src/runtime/adaptive-goal-plan-adapter.js';
import { assessAdaptiveGoalExecutionReadiness } from '../src/runtime/adaptive-goal-execution-readiness.js';
import { compileWorkflowPlan } from '../src/runtime/workflow/compiler.js';
import { resolveAdaptiveGoalSourceEvidence } from '../src/runtime/adaptive-goal-source-evidence.js';

const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-readiness-source-evidence-'));
const sourceRelativePath = 'src/runtime/contract-fixture.js';
const sourceAbsolutePath = path.join(sourceRoot, sourceRelativePath);
fs.mkdirSync(path.dirname(sourceAbsolutePath), { recursive: true });
fs.writeFileSync(sourceAbsolutePath, 'export const fixtureContract = "read-only evidence";\n');
const sourceFileRef = `file:${sourceRelativePath}#sha256=${createHash('sha256').update(fs.readFileSync(sourceAbsolutePath)).digest('hex')}`;
const sourceRecords = reference => resolveAdaptiveGoalSourceEvidence([reference], { root: fs.realpathSync(sourceRoot) });
after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function graphWithAction(evidenceRefs = []) {
  return {
    schemaVersion: 1,
    startNodeId: 'start',
    goalNodeId: 'goal',
    nodes: [
      { id: 'start', type: 'goal', label: 'Starting state' },
      { id: 'implement', type: 'task', label: 'Implement an approved code change', evidenceRefs },
      { id: 'goal', type: 'goal', label: 'Verified target' }
    ],
    edges: [
      { from: 'start', to: 'implement', type: 'next_step' },
      { from: 'implement', to: 'goal', type: 'next_step' }
    ]
  };
}

function draftFor(evidenceRefs = []) {
  const graph = graphWithAction(evidenceRefs);
  const search = searchAdaptiveGoalGraph(graph, { beamWidth: 4, maxDepth: 8, maxExpansions: 32 });
  return projectAdaptiveGoalCandidateToPlanGraph(graph, search.candidates[0], { beamWidth: 4, maxDepth: 8, maxExpansions: 32 });
}

function planFor() {
  return compileWorkflowPlan({ job_id: 'agg-execution-readiness-test', title: 'Software Development: readiness contract fixture' }, { workspace: process.cwd() });
}

function bindingFor(draft, capability = 'code.modify', taskId = 'standard-engineer') {
  return [{ step_id: draft.steps[0].id, task_id: taskId, capability }];
}

function validEvidence(ref, type = 'requirements', artifactId = `artifact-${type}`) {
  return {
    ref,
    sourceJobId: 'job_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    artifactId,
    type,
    schemaVersion: 1,
    status: 'active',
    contentHash: createHash('sha256').update(`valid artifact content ${artifactId}`).digest('hex'),
    lineageValid: true,
    artifactCreatedEventId: `event-${artifactId}`,
    producerContractValid: true,
    producerRole: type === 'requirements' ? 'product-owner' : 'architect',
    producerTaskId: `task-${artifactId}`,
    producerTaskStatus: 'completed',
    producerTaskCompleted: true,
    producerResultId: `result-${artifactId}`,
    producerResultOutcome: 'success',
    producerCompletionEventId: `completion-${artifactId}`,
    producerCompletionEventType: 'task.local_completed',
    producerResultLineageValid: true
  };
}

test('requires durable active source evidence and exact role/capability/output artifact contracts', () => {
  const draft = draftFor(['artifact://artifact-requirements', 'artifact://artifact-architecture']);
  const original = structuredClone(draft);
  const result = assessAdaptiveGoalExecutionReadiness(
    draft, 'standard-engineering', planFor(), bindingFor(draft), [validEvidence('artifact://artifact-requirements', 'requirements'), validEvidence('artifact://artifact-architecture', 'architecture')]
  );
  assert.equal(result.status, 'eligible_for_execution_graph_review');
  assert.equal(result.readyForExecutionGraphReview, true);
  assert.equal(result.contractReady, true);
  assert.equal(result.evidenceReady, true);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].roleContract.id, 'agent.engineer');
  assert.equal(result.actions[0].declaredCapability, 'code.modify');
  assert.deepEqual(result.actions[0].roleContract.requiredInputs, ['requirements', 'architecture']);
  assert.equal(result.actions[0].outputEvidenceContract.type, 'implementation');
  assert.deepEqual(result.actions[0].outputEvidenceContract.requiredContentFields, ['summary', 'files_changed', 'verification', 'execution']);
  assert.deepEqual(result.actions[0].supportingEvidence.verifiedArtifacts.map(item => item.type).sort(), ['architecture', 'requirements']);
  assert.deepEqual(result.actions[0].inputArtifactProvenance.map(item => item.artifactType).sort(), ['architecture', 'requirements']);
  assert.equal(result.actions[0].execution.enabled, false);
  assert.equal(result.gates.executionGraphCreated, false);
  assert.equal(result.gates.executableContractsCreated, false);
  assert.equal(result.gates.immutableExecutionPlanCreated, false);
  assert.equal(result.gates.dispatchAllowed, false);
  assert.equal(result.gates.executionAuthorized, false);
  assert.deepEqual(draft, original, 'readiness assessment must not mutate source draft');
});

test('distinguishes valid contract mapping from absent or unresolved evidence references', () => {
  const noEvidence = draftFor();
  const noEvidenceReport = assessAdaptiveGoalExecutionReadiness(noEvidence, 'standard-engineering', planFor(), bindingFor(noEvidence, 'product.requirements', 'standard-product-owner'));
  assert.equal(noEvidenceReport.contractReady, true);
  assert.equal(noEvidenceReport.evidenceReady, false);
  assert.equal(noEvidenceReport.readyForExecutionGraphReview, false);
  assert.equal(noEvidenceReport.status, 'contract_ready_evidence_pending');
  assert.ok(noEvidenceReport.evidenceBlockers.some(item => item.code === 'STEP_EVIDENCE_MISSING'));

  const unresolved = draftFor(['https://example.invalid/source-evidence']);
  const unresolvedReport = assessAdaptiveGoalExecutionReadiness(unresolved, 'standard-engineering', planFor(), bindingFor(unresolved, 'product.requirements', 'standard-product-owner'), []);
  assert.equal(unresolvedReport.contractReady, true);
  assert.equal(unresolvedReport.evidenceReady, false);
  assert.ok(unresolvedReport.evidenceBlockers.some(item => item.code === 'SOURCE_EVIDENCE_UNVERIFIED'));
});

test('keeps content-addressed source-file integrity separate from durable artifact and claim verification', () => {
  const draft = draftFor([
    'artifact://artifact-requirements', 'artifact://artifact-architecture', sourceFileRef
  ]);
  const readiness = assessAdaptiveGoalExecutionReadiness(
    draft, 'standard-engineering', planFor(), bindingFor(draft), [
      validEvidence('artifact://artifact-requirements', 'requirements'),
      validEvidence('artifact://artifact-architecture', 'architecture')
    ], sourceRecords(sourceFileRef)
  );
  assert.equal(readiness.readyForExecutionGraphReview, true, JSON.stringify(readiness.evidenceBlockers));
  assert.equal(readiness.actions[0].supportingEvidence.verified, true, 'durable artifact gate is satisfied only by typed durable artifacts');
  assert.equal(readiness.actions[0].supportingEvidence.verifiedArtifacts.length, 2);
  assert.equal(readiness.actions[0].supportingEvidence.sourceFilesIntegrityVerified, true);
  assert.equal(readiness.actions[0].supportingEvidence.sourceFiles[0].integrityVerified, true);
  assert.equal(readiness.actions[0].supportingEvidence.sourceFiles[0].claimVerified, false);
  assert.equal(readiness.actions[0].supportingEvidence.sourceFiles[0].independenceVerified, false);
});

test('rejects stale source-file hashes even when typed durable artifacts otherwise resolve', () => {
  const staleRef = `file:${sourceRelativePath}#sha256=${'0'.repeat(64)}`;
  const draft = draftFor(['artifact://artifact-requirements', 'artifact://artifact-architecture', staleRef]);
  const readiness = assessAdaptiveGoalExecutionReadiness(
    draft, 'standard-engineering', planFor(), bindingFor(draft), [
      validEvidence('artifact://artifact-requirements', 'requirements'),
      validEvidence('artifact://artifact-architecture', 'architecture')
    ], sourceRecords(staleRef)
  );
  assert.equal(readiness.evidenceReady, false);
  assert.equal(readiness.readyForExecutionGraphReview, false);
  assert.ok(readiness.evidenceBlockers.some(item => item.code === 'SOURCE_FILE_EVIDENCE_INTEGRITY_FAILED'));
  assert.equal(readiness.actions[0].supportingEvidence.verified, true, 'durable artifacts remain separately identified, but failed source integrity blocks overall readiness');
});

test('does not let hash-verified source files replace missing durable artifacts', () => {
  const draft = draftFor([sourceFileRef]);
  const readiness = assessAdaptiveGoalExecutionReadiness(
    draft, 'standard-engineering', planFor(), bindingFor(draft), [], sourceRecords(sourceFileRef)
  );
  assert.equal(readiness.contractReady, false, 'the engineer input contract still requires requirements and architecture artifacts');
  assert.equal(readiness.evidenceReady, false);
  assert.ok(readiness.evidenceBlockers.some(item => item.code === 'STEP_DURABLE_EVIDENCE_MISSING'));
  assert.equal(readiness.actions[0].supportingEvidence.verified, false);
  assert.equal(readiness.actions[0].supportingEvidence.sourceFilesIntegrityVerified, true);
  assert.equal(readiness.actions[0].supportingEvidence.verifiedArtifacts.length, 0);
});

test('distinguishes existing artifact hash/schema/record failures from contract blockers and missing artifacts', () => {
  const draft = draftFor([
    'artifact://artifact-requirements', 'artifact://artifact-architecture', 'artifact://artifact-invalid'
  ]);
  const validRequirements = validEvidence('artifact://artifact-requirements', 'requirements');
  const validArchitecture = validEvidence('artifact://artifact-architecture', 'architecture');
  const expectedFailures = [
    ['SOURCE_ARTIFACT_CONTENT_HASH_INVALID', 'persisted bytes differ from claimed content hash'],
    ['SOURCE_ARTIFACT_SCHEMA_INVALID', 'typed artifact content violates its registered schema'],
    ['SOURCE_ARTIFACT_RECORD_INVALID', 'stored artifact record failed runtime validation']
  ];

  for (const [code, reason] of expectedFailures) {
    const invalidArchitecture = {
      ref: 'artifact://artifact-invalid',
      artifactId: 'artifact-invalid',
      sourceJobId: 'job_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      resolutionFailureCode: code,
      resolutionFailureReason: reason
    };
    const report = assessAdaptiveGoalExecutionReadiness(
      draft, 'standard-engineering', planFor(), bindingFor(draft), [validRequirements, validArchitecture, invalidArchitecture]
    );
    assert.equal(report.contractReady, true, `${code} must not be mislabeled as a role/dependency contract failure`);
    assert.equal(report.evidenceReady, false);
    assert.equal(report.readyForExecutionGraphReview, false);
    assert.equal(report.status, 'contract_ready_evidence_pending');
    assert.ok(report.evidenceBlockers.some(item => item.code === code &&
      item.reference === 'artifact://artifact-invalid' && item.artifactId === 'artifact-invalid'));
    assert.equal(report.actions[0].execution.enabled, false);
    assert.equal(report.gates.executionGraphCreated, false);
    assert.equal(report.gates.dispatchAllowed, false);
    assert.equal(report.gates.executionAuthorized, false);
  }
});

test('rejects task capability mismatch even when structural workflow mapping is valid', () => {
  const draft = draftFor(['artifact://artifact-requirements', 'artifact://artifact-architecture']);
  const result = assessAdaptiveGoalExecutionReadiness(
    draft, 'standard-engineering', planFor(), bindingFor(draft, 'research.collect'), [validEvidence('artifact://artifact-requirements', 'requirements'), validEvidence('artifact://artifact-architecture', 'architecture')]
  );
  assert.equal(result.contractReady, false);
  assert.ok(result.blockers.some(item => item.code === 'CAPABILITY_CONTRACT_MISMATCH'));
  assert.equal(result.readyForExecutionGraphReview, false);
});

test('rejects evidence that is stale or lacks producer-contract lineage', () => {
  const draft = draftFor(['artifact://artifact-requirements', 'artifact://artifact-architecture']);
  const stale = { ...validEvidence('artifact://artifact-requirements', 'requirements'), status: 'superseded' };
  const activeArchitecture = validEvidence('artifact://artifact-architecture', 'architecture');
  const staleReport = assessAdaptiveGoalExecutionReadiness(draft, 'standard-engineering', planFor(), bindingFor(draft), [stale, activeArchitecture]);
  assert.equal(staleReport.evidenceReady, false);
  assert.ok(staleReport.evidenceBlockers.some(item => item.code === 'SOURCE_EVIDENCE_NOT_ACTIVE'));

  const invalidProducer = { ...validEvidence('artifact://artifact-requirements', 'requirements'), producerContractValid: false };
  const producerReport = assessAdaptiveGoalExecutionReadiness(draft, 'standard-engineering', planFor(), bindingFor(draft), [invalidProducer, activeArchitecture]);
  assert.equal(producerReport.evidenceReady, false);
  assert.ok(producerReport.evidenceBlockers.some(item => item.code === 'SOURCE_EVIDENCE_NOT_ACTIVE'));

  const unfinishedProducer = { ...validEvidence('artifact://artifact-requirements', 'requirements'), producerTaskCompleted: false };
  const unfinishedReport = assessAdaptiveGoalExecutionReadiness(draft, 'standard-engineering', planFor(), bindingFor(draft), [unfinishedProducer, activeArchitecture]);
  assert.equal(unfinishedReport.evidenceReady, false);
  assert.ok(unfinishedReport.evidenceBlockers.some(item => item.code === 'SOURCE_EVIDENCE_NOT_ACTIVE'));
});

test('reports missing required artifact inputs when bound task ancestry does not supply them', () => {
  const draft = draftFor();
  const plan = planFor();
  const altered = { ...plan, children: plan.children.map(child => child.id === 'standard-engineer' ? { ...child, dependencies: [] } : child) };
  const { plan_hash: _oldHash, ...unsigned } = altered;
  altered.plan_hash = createHash('sha256').update(stableJson(unsigned)).digest('hex');
  const result = assessAdaptiveGoalExecutionReadiness(draft, 'standard-engineering', altered, bindingFor(draft));
  assert.equal(result.contractReady, false);
  assert.ok(result.blockers.some(item => item.code === 'INPUT_ARTIFACTS_UNAVAILABLE' && item.missingArtifactTypes.includes('requirements')));
  assert.ok(result.blockers.some(item => item.code === 'INPUT_ARTIFACTS_UNAVAILABLE' && item.missingArtifactTypes.includes('architecture')));
});

test('rejects binding-shape injection and never returns executable task metadata', () => {
  const draft = draftFor(['artifact://artifact-requirements', 'artifact://artifact-architecture']);
  const injected = assessAdaptiveGoalExecutionReadiness(draft, 'standard-engineering', planFor(), [
    { ...bindingFor(draft)[0], executable: 'node', args: ['evil.js'] }
  ], [validEvidence('artifact://artifact-requirements', 'requirements'), validEvidence('artifact://artifact-architecture', 'architecture')]);
  assert.equal(injected.contractReady, false);
  assert.ok(injected.blockers.some(item => item.code === 'ACTION_BINDING_INVALID'));
  assert.equal(injected.gates.dispatchAllowed, false);
  assert.equal(injected.gates.executionAuthorized, false);
});
