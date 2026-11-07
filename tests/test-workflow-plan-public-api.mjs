import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORKFLOW_PLAN_API_VERSION,
  WORKFLOW_PLAN_API_METHODS,
  workflowPlanApi,
  canonicalJson,
  validateExecutionPlan,
  assertTaskDependenciesMatchPlan,
  resolveTaskBatchRoute
} from '../src/runtime/workflow-plan-public-api.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

assert.equal(WORKFLOW_PLAN_API_VERSION, 1);
assert.deepEqual(WORKFLOW_PLAN_API_METHODS, [
  'canonicalJson', 'validateExecutionPlan', 'assertTaskDependenciesMatchPlan', 'resolveTaskBatchRoute'
]);
assert.equal(Object.isFrozen(WORKFLOW_PLAN_API_METHODS), true);
assert.equal(Object.isFrozen(workflowPlanApi), true);
assert.deepEqual(Object.keys(workflowPlanApi).sort(), [
  'assertTaskDependenciesMatchPlan', 'canonicalJson', 'resolveTaskBatchRoute', 'validateExecutionPlan', 'version'
]);
assert.equal(workflowPlanApi.version, WORKFLOW_PLAN_API_VERSION);
assert.equal(workflowPlanApi.canonicalJson, canonicalJson);
assert.equal(workflowPlanApi.validateExecutionPlan, validateExecutionPlan);
assert.equal(workflowPlanApi.assertTaskDependenciesMatchPlan, assertTaskDependenciesMatchPlan);
assert.equal(workflowPlanApi.resolveTaskBatchRoute, resolveTaskBatchRoute);
assert.equal(Object.hasOwn(workflowPlanApi, 'db'), false);
assert.equal(Object.hasOwn(workflowPlanApi, 'transaction'), false);
assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
assert.throws(() => validateExecutionPlan(null), TypeError,
  'public plan API must retain the authoritative Workflow validator');

const aggConsumers = [
  'src/runtime/adaptive-goal-execution-plan-candidate.js',
  'src/runtime/adaptive-goal-execution-readiness.js',
  'src/runtime/adaptive-goal-reviewed-task-inputs.js',
  'src/runtime/adaptive-goal-action-intent-binding-resolver.js',
  'src/runtime/adaptive-goal-approval-subsystem.js',
  'src/runtime/adaptive-goal-reviewer-identity.js',
  'src/runtime/adaptive-goal-sandbox-executor.js'
];
for (const relative of aggConsumers) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  assert.doesNotMatch(source, /from\s+['"]\.\/workflow\/(?:plan|agent-contracts)\.js['"]/,
    `${relative} must not import private Workflow plan/role modules`);
}

console.log('Workflow Plan API v1, immutable method surface and AGG dependency direction PASS');
