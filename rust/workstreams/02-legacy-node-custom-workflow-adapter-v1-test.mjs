#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileWorkflowPlan } from '../../src/runtime/workflow/compiler.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fixturePath = path.join(here, '02-legacy-node-custom-workflow-adapter-v1.fixtures.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sourceHash = (relativePath) => sha256(fs.readFileSync(path.join(root, relativePath)));

assert.equal(sourceHash('src/runtime/workflow/compiler.js'), fixture.compiler_sha256,
  'custom workflow compiler source drift');
assert.equal(sourceHash('src/runtime/workflow-state-port.js'), fixture.state_port_sha256,
  'immutable execution binding source drift');
assert.equal(sourceHash('src/runtime/workflow/policy-contract.js'), fixture.policy_contract_sha256,
  'policy consumer source drift');
console.log('PASS exact compiler, immutable-binding and policy-consumer source pins');

const role = (name) => ({
  allowed_capabilities: ['workflow.execute'],
  name,
  description: `${name} fixture role`,
  system_prompt: 'fixture only',
  skills: [],
  permissions: [],
  allowed_tools: []
});
const makeTask = (row) => ({
  id: row.id,
  role_id: row.role_id,
  role_version: row.role_version,
  role: role(row.role_name),
  depends_on: [...row.depends_on],
  input_contract: {},
  output_artifact_type: 'fixture-artifact'
});
const tasks = fixture.tasks.map(makeTask);
const customWorkflow = {
  workflow: { workflow_id: 'ws2-legacy-adapter-fixture', version: 1, tasks },
  tasks,
  plan_id: 'ws2-legacy-plan-fixture',
  plan_hash: 'a'.repeat(64),
  approved_at: '2026-11-03T00:00:00Z'
};
const compile = (taskRows) => {
  const mappedTasks = taskRows.map(makeTask);
  return compileWorkflowPlan(
    { job_id: 'ws2-legacy-adapter-fixture-job', title: 'Legacy adapter fixture' },
    {
      workspace: '/tmp',
      customWorkflow: {
        ...customWorkflow,
        workflow: { ...customWorkflow.workflow, tasks: mappedTasks },
        tasks: mappedTasks
      }
    }
  );
};

const plan = compile(fixture.tasks);
const actual = plan.children.map((child) => ({
  id: child.id,
  role: child.role,
  custom_role_id: child.execution.custom_role_id,
  custom_role_version: child.execution.custom_role_version,
  dependencies: child.dependencies
}));
assert.deepEqual(actual, fixture.expected_children);
console.log('PASS legacy compiler preserves exact child IDs, explicit custom role ID/version and dependency IDs');
console.log('CONFIRMED positional role alias: custom-task-1/custom-task-2 generated from task array index');

const reorderedRows = [fixture.tasks[1], fixture.tasks[0]].map((row) => ({ ...row, depends_on: [] }));
const reordered = compile(reorderedRows);
assert.deepEqual(reordered.children.map((child) => child.id), ['node-child-review', 'node-child-requirements']);
assert.deepEqual(reordered.children.map((child) => child.role), ['custom-task-1', 'custom-task-2']);
assert.deepEqual(reordered.children.map((child) => [child.execution.custom_role_id, child.execution.custom_role_version]), [
  ['custom-reviewer', 2], ['custom-owner', 4]
]);
console.log('PASS reorder preserves stable ID/role metadata pairs but renumbers synthetic role aliases');

const missingId = fixture.tasks.map((row) => ({ ...row }));
delete missingId[0].id;
assert.throws(() => compile(missingId), /invalid or duplicate execution plan task/);
console.log('PASS negative missing-child-id-is-rejected-by-plan-validation');

const duplicateId = fixture.tasks.map((row) => ({ ...row }));
duplicateId[1].id = duplicateId[0].id;
assert.throws(() => compile(duplicateId), /invalid or duplicate execution plan task/);
console.log('PASS negative duplicate-child-id-is-rejected-by-plan-validation');

console.log('LIMIT: proves legacy Node compiler behavior only; not frozen public W1 CompiledPlanV1 ID bridge, live attachment revision/CAS/idempotent replay or authenticated executor identity');
