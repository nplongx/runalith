#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileWorkflowPlan } from '../../src/runtime/workflow/compiler.js';
import { listAgentContracts } from '../../src/runtime/agent-contracts-public-api.js';

const rustRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutput = path.join(rustRoot, 'crates/runalith-domain/fixtures/node-builtin-workflow-compiler-v1.json');
const outputPath = path.resolve(process.argv[2] || defaultOutput);

const roles = listAgentContracts().map(contract => ({
  role_id: contract.role,
  version: contract.version,
  capability: contract.capability,
  inputs: contract.inputs,
  outputs: contract.outputs,
  permissions: contract.permissions
}));

const inputs = [
  {
    name: 'engineering-m4-v2',
    job: { job_id: 'node-builtin-engineering-v2', title: 'Engineering M4 workflow parity fixture' },
    workflow_version: null
  },
  {
    name: 'standard-engineering-v3',
    job: { job_id: 'node-builtin-standard-v3', title: 'Software delivery parity fixture' },
    workflow_version: null
  },
  {
    name: 'standard-engineering-v2-legacy',
    job: { job_id: 'node-builtin-standard-v2', title: 'Software development legacy parity fixture' },
    workflow_version: 2
  }
];

const cases = inputs.map(({ name, job, workflow_version }) => {
  const plan = compileWorkflowPlan(job, {
    workspace: '/tmp/runalith-node-builtin-compiler-oracle',
    batchExecutionPolicy: null,
    workflowVersion: workflow_version
  });
  const tasks = plan.children.map(child => {
    const contract = roles.find(role => role.role_id === child.role);
    if (!contract) throw new Error(`${name}: Node task role has no public agent contract: ${child.role}`);
    if (child.execution?.execution_mode !== 'host-conversation' || child.execution?.deterministic !== false ||
        child.execution?.executor !== 'ChatOnSteroidsHost') {
      throw new Error(`${name}: fixture task is outside the host-only workflow DAG contract: ${child.id}`);
    }
    return {
      task_id: child.id,
      role_id: child.role,
      role_version: contract.version,
      capability: child.capability,
      input_contract: contract.inputs,
      output_artifact_type: contract.outputs[0],
      depends_on: child.dependencies,
      execution_mode: child.execution.execution_mode,
      deterministic: child.execution.deterministic
    };
  });
  return {
    name,
    workflow_id: plan.workflow_id,
    workflow_version: plan.workflow_version,
    input_contract: ['job.request'],
    tasks
  };
});

const fixture = {
  schema_version: 1,
  generated_by_node: true,
  source: 'src/runtime/workflow/compiler.js::compileWorkflowPlan + agent-contracts-public-api.js::listAgentContracts',
  scope: 'Host-conversation built-in task DAG projection only; excludes policy/success contract, phases, batch policy, validation profiles, workspace-write scopes, action intents, synthesis and deterministic task plans.',
  role_contracts: roles,
  cases
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify({
  output: outputPath,
  role_contracts: roles.length,
  cases: cases.map(({ name, workflow_id, workflow_version, tasks }) => ({ name, workflow_id, workflow_version, task_count: tasks.length }))
}, null, 2));
