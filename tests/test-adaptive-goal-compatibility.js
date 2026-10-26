import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { searchAdaptiveGoalGraph } from '../src/runtime/adaptive-goal-graph.js';
import { projectAdaptiveGoalCandidateToPlanGraph } from '../src/runtime/adaptive-goal-plan-adapter.js';
import {
  ADAPTIVE_GOAL_COMPATIBLE_WORKFLOW_IDS,
  assessAdaptiveGoalPlanCompatibility
} from '../src/runtime/adaptive-goal-compatibility.js';
import { compileWorkflowPlan } from '../src/runtime/workflow/compiler.js';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function rehashDraft(draft) {
  const { draftHash: _oldHash, ...unsigned } = draft;
  return { ...unsigned, draftHash: createHash('sha256').update(stableJson(unsigned)).digest('hex') };
}

function graphWithActions(actionIds = ['action']) {
  const nodes = [
    { id: 'start', type: 'goal', label: 'Current state' },
    ...actionIds.map((id, index) => ({ id, type: index % 2 ? 'experiment' : 'task', label: `Action ${index + 1}`, estimatedSuccessConfidence: 0.9 })),
    { id: 'goal', type: 'goal', label: 'Target state' }
  ];
  const pathIds = ['start', ...actionIds, 'goal'];
  const edges = pathIds.slice(0, -1).map((id, index) => ({ from: id, to: pathIds[index + 1], type: 'next_step' }));
  return { schemaVersion: 1, startNodeId: 'start', goalNodeId: 'goal', nodes, edges };
}

function draftFor(actionIds = ['action']) {
  const graph = graphWithActions(actionIds);
  const search = searchAdaptiveGoalGraph(graph, { beamWidth: 8, maxDepth: 12, maxExpansions: 128 });
  assert.ok(search.candidates.length);
  return projectAdaptiveGoalCandidateToPlanGraph(graph, search.candidates[0], { beamWidth: 8, maxDepth: 12, maxExpansions: 128 });
}

function fullStandardEngineeringDraft() {
  const ids = [
    'product-owner-step', 'researcher-step', 'architect-step', 'engineer-step',
    'security-step', 'qa-step', 'platform-step', 'writer-step', 'reviewer-step'
  ];
  const graph = graphWithActions(ids);
  graph.edges.push(
    { from: ids[0], to: ids[1], type: 'requires_all' },
    { from: ids[0], to: ids[2], type: 'requires_all' },
    { from: ids[1], to: ids[2], type: 'requires_all' },
    { from: ids[2], to: ids[3], type: 'requires_all' },
    { from: ids[3], to: ids[4], type: 'requires_all' },
    { from: ids[3], to: ids[5], type: 'requires_all' },
    { from: ids[3], to: ids[6], type: 'requires_all' },
    { from: ids[3], to: ids[7], type: 'requires_all' },
    { from: ids[4], to: ids[8], type: 'requires_all' },
    { from: ids[5], to: ids[8], type: 'requires_all' },
    { from: ids[6], to: ids[8], type: 'requires_all' },
    { from: ids[7], to: ids[8], type: 'requires_all' }
  );
  const options = { beamWidth: 16, maxDepth: 16, maxExpansions: 256 };
  const search = searchAdaptiveGoalGraph(graph, options);
  const candidate = search.candidates.find(item => item.pathNodeIds.filter(id => ids.includes(id)).length === 9);
  assert.ok(candidate, 'the finite prerequisite graph should yield a candidate containing all nine action nodes');
  const draft = projectAdaptiveGoalCandidateToPlanGraph(graph, candidate, options, { dependencyMode: 'source_edges_only' });
  return { draft, ids };
}

const templateTitles = Object.freeze({
  'standard-engineering': 'Software Development: compatibility fixture',
  'hybrid-engineering': 'Hybrid Batch Execution: compatibility fixture',
  engineering: 'Engineering M4: compatibility fixture',
  production: 'Production E2E: compatibility fixture'
});

function planFor(workflowId) {
  return compileWorkflowPlan({ job_id: 'agg-compatibility-test', title: templateTitles[workflowId] }, { workspace: process.cwd() });
}

function binding(draft, taskId = 'standard-engineer') {
  return draft.steps.map((step, index) => ({ step_id: step.id, task_id: index ? taskId : taskId }));
}

test('accepts a valid explicit mapping into the compiled standard-engineering template for review only', () => {
  const draft = draftFor();
  const plan = planFor('standard-engineering');
  const before = structuredClone(draft);
  const report = assessAdaptiveGoalPlanCompatibility(draft, 'standard-engineering', plan, [
    { step_id: draft.steps[0].id, task_id: 'standard-engineer' }
  ]);
  assert.equal(report.eligible, true);
  assert.equal(report.status, 'eligible_for_human_review');
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.bindings, [{ stepId: draft.steps[0].id, sourceNodeId: 'action', taskId: 'standard-engineer', role: 'engineer' }]);
  assert.equal(report.workflow.version, 3);
  assert.equal(report.workflow.planHash, plan.plan_hash);
  assert.ok(report.warnings.some(item => /additional mandatory child task/.test(item)));
  assert.deepEqual(report.gates, {
    workflowProposalCreated: false,
    immutableExecutionPlanCreated: false,
    humanReviewRequired: true,
    workflowApprovalRequired: true,
    dispatchAllowed: false,
    executionAuthorized: false
  });
  assert.deepEqual(draft, before, 'compatibility assessment must not mutate its input');
});

test('checks all supported built-in templates using their exact compiled plan identities', () => {
  const draft = draftFor();
  for (const workflowId of ADAPTIVE_GOAL_COMPATIBLE_WORKFLOW_IDS) {
    const plan = planFor(workflowId);
    const report = assessAdaptiveGoalPlanCompatibility(draft, workflowId, plan, [
      { step_id: draft.steps[0].id, task_id: plan.children[0].id }
    ]);
    assert.equal(report.eligible, true, `one-step drafts should be reviewable against ${workflowId}: ${JSON.stringify(report.blockers)}`);
    assert.equal(report.workflow.id, workflowId);
    assert.equal(report.workflow.version, plan.workflow_version);
    assert.equal(report.workflow.taskCount, plan.children.length);
  }
});

test('rejects mappings that invert a required Plan Graph dependency', () => {
  const draft = draftFor(['first-action', 'second-action']);
  const report = assessAdaptiveGoalPlanCompatibility(draft, 'standard-engineering', planFor('standard-engineering'), [
    { step_id: draft.steps[0].id, task_id: 'standard-qa' },
    { step_id: draft.steps[1].id, task_id: 'standard-engineer' }
  ]);
  assert.equal(report.eligible, false);
  assert.ok(report.blockers.some(item => item.code === 'DEPENDENCY_NOT_PRESERVED'));
  assert.equal(report.gates.dispatchAllowed, false);
});

test('reports missing, duplicate and unknown task bindings as explicit blockers', () => {
  const draft = draftFor(['first-action', 'second-action']);
  const plan = planFor('standard-engineering');
  const missing = assessAdaptiveGoalPlanCompatibility(draft, 'standard-engineering', plan, [
    { step_id: draft.steps[0].id, task_id: 'standard-engineer' }
  ]);
  assert.ok(missing.blockers.some(item => item.code === 'STEP_BINDING_MISSING' && item.stepId === draft.steps[1].id));

  const duplicate = assessAdaptiveGoalPlanCompatibility(draft, 'standard-engineering', plan, [
    { step_id: draft.steps[0].id, task_id: 'standard-engineer' },
    { step_id: draft.steps[1].id, task_id: 'standard-engineer' }
  ]);
  assert.ok(duplicate.blockers.some(item => item.code === 'WORKFLOW_TASK_REUSED'));

  const unknown = assessAdaptiveGoalPlanCompatibility(draft, 'not-a-workflow', null, [
    { step_id: draft.steps[0].id, task_id: 'standard-engineer' },
    { step_id: draft.steps[1].id, task_id: 'standard-qa' }
  ]);
  assert.equal(unknown.eligible, false);
  assert.ok(unknown.blockers.some(item => item.code === 'UNSUPPORTED_WORKFLOW'));
  assert.equal(unknown.workflow.version, null);
});

test('requires every mandatory child task to have a Plan Graph action mapping before standard-engineering review', () => {
  const draft = draftFor(['requirements-only']);
  const plan = planFor('standard-engineering');
  const partial = assessAdaptiveGoalPlanCompatibility(draft, 'standard-engineering', plan, [
    { step_id: draft.steps[0].id, task_id: 'standard-product-owner' }
  ], { requireCompleteTaskMapping: true });
  assert.equal(partial.eligible, false);
  assert.ok(partial.blockers.some(item => item.code === 'WORKFLOW_CHILD_TASK_UNMAPPED' && item.taskId === 'standard-reviewer'));
  assert.equal(partial.gates.workflowProposalCreated, false);
  assert.equal(partial.gates.dispatchAllowed, false);

  const { draft: completeDraft } = fullStandardEngineeringDraft();
  const taskIds = [
    'standard-product-owner', 'standard-researcher', 'standard-architect', 'standard-engineer',
    'standard-security', 'standard-qa', 'standard-platform', 'standard-writer', 'standard-reviewer'
  ];
  const completeBindings = completeDraft.steps.map((step, index) => ({ step_id: step.id, task_id: taskIds[index] }));
  const complete = assessAdaptiveGoalPlanCompatibility(completeDraft, 'standard-engineering', plan, completeBindings,
    { requireCompleteTaskMapping: true });
  assert.equal(complete.eligible, true, JSON.stringify(complete.blockers, null, 2));
  assert.equal(complete.bindings.length, 9);
  assert.equal(complete.workflow.taskCount, 9);
  assert.equal(complete.warnings.some(item => /additional mandatory child task/.test(item)), false);
  assert.deepEqual(completeDraft.steps.map(step => step.dependencies.length), [0, 1, 2, 1, 1, 1, 1, 1, 4],
    'the projected Plan Graph must preserve standard-engineering prerequisite branches without serializing sibling tasks');
});

test('rejects draft integrity changes, missing review gates, and execution-authority injection', () => {
  const draft = draftFor();
  const plan = planFor('standard-engineering');
  const map = [{ step_id: draft.steps[0].id, task_id: 'standard-engineer' }];

  const statusTampered = { ...draft, status: 'approved' };
  const statusReport = assessAdaptiveGoalPlanCompatibility(statusTampered, 'standard-engineering', plan, map);
  assert.ok(statusReport.blockers.some(item => item.code === 'DRAFT_INVALID'));

  const gateTampered = rehashDraft({ ...draft, gates: { ...draft.gates, dispatchAllowed: true } });
  const gateReport = assessAdaptiveGoalPlanCompatibility(gateTampered, 'standard-engineering', plan, map);
  assert.ok(gateReport.blockers.some(item => item.code === 'DRAFT_INVALID' && /gates/.test(item.message)));

  const executionTampered = rehashDraft({
    ...draft,
    steps: draft.steps.map(step => ({ ...step, execution: { ...step.execution, executable: 'node' } }))
  });
  const executionReport = assessAdaptiveGoalPlanCompatibility(executionTampered, 'standard-engineering', plan, map);
  assert.ok(executionReport.blockers.some(item => item.code === 'DRAFT_INVALID' && /execution metadata/.test(item.message)));

  const hashTampered = { ...draft, goal: { ...draft.goal, label: 'different goal' } };
  const hashReport = assessAdaptiveGoalPlanCompatibility(hashTampered, 'standard-engineering', plan, map);
  assert.ok(hashReport.blockers.some(item => item.code === 'DRAFT_INVALID' && /draftHash/.test(item.message)));
});

test('rejects a changed compiled workflow plan instead of trusting its task mapping', () => {
  const draft = draftFor();
  const plan = planFor('standard-engineering');
  const alteredPlan = { ...plan, children: plan.children.map((child, index) => index ? child : { ...child, role: 'untrusted-role' }) };
  const report = assessAdaptiveGoalPlanCompatibility(draft, 'standard-engineering', alteredPlan, [
    { step_id: draft.steps[0].id, task_id: 'standard-product-owner' }
  ]);
  assert.ok(report.blockers.some(item => item.code === 'WORKFLOW_PLAN_INVALID' && /plan_hash/.test(item.message)));
});
