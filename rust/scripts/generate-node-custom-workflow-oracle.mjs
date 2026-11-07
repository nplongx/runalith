#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { initializeCustomRoleStore, createCustomRole } from '../../src/runtime/workflow/custom-roles.js';
import { initializeCustomWorkflowStore, createCustomWorkflow, previewCustomWorkflow } from '../../src/runtime/workflow/custom-workflows.js';

const rustRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutput = path.join(rustRoot, 'crates/runalith-domain/fixtures/node-custom-workflow-compiler-v1.json');
const outputPath = path.resolve(process.argv[2] || defaultOutput);
const db = new DatabaseSync(':memory:');

const roleDefinitions = [
  { role_id: 'custom-owner', version: 1, name: 'Custom Owner', description: 'Own requirements', system_prompt: 'Write exact requirements', input_contract: ['job.request', 'research'], output_artifact_type: 'requirements', allowed_capabilities: ['product.requirements'], permissions: ['workspace.read', 'artifact.create'], allowed_tools: ['workflow_catalog'], skills: [] },
  { role_id: 'custom-researcher', version: 1, name: 'Custom Researcher', description: 'Collect research', system_prompt: 'Use requirements as source', input_contract: ['requirements'], output_artifact_type: 'research', allowed_capabilities: ['research.collect'], permissions: ['workspace.read', 'artifact.create'], allowed_tools: ['workflow_catalog'], skills: [] },
  { role_id: 'custom-market-researcher', version: 1, name: 'Market Researcher', description: 'Collect market research', system_prompt: 'Use requirements as source', input_contract: ['requirements'], output_artifact_type: 'research', allowed_capabilities: ['research.collect'], permissions: ['workspace.read', 'artifact.create'], allowed_tools: ['workflow_catalog'], skills: [] },
  { role_id: 'custom-architect', version: 1, name: 'Custom Architect', description: 'Design architecture', system_prompt: 'Use requirements and research', input_contract: ['requirements', 'research'], output_artifact_type: 'architecture', allowed_capabilities: ['architecture.design'], permissions: ['workspace.read', 'artifact.create'], allowed_tools: ['workflow_catalog'], skills: [] },
  { role_id: 'custom-implementer', version: 1, name: 'Custom Implementer', description: 'Implement design', system_prompt: 'Use requirements and architecture', input_contract: ['requirements', 'architecture'], output_artifact_type: 'implementation', allowed_capabilities: ['code.modify'], permissions: ['workspace.read', 'artifact.create'], allowed_tools: ['workflow_catalog'], skills: [] },
  { role_id: 'custom-writer', version: 1, name: 'Custom Writer', description: 'Write docs', system_prompt: 'Use requirements and implementation', input_contract: ['requirements', 'implementation'], output_artifact_type: 'documentation', allowed_capabilities: ['documentation.write'], permissions: ['workspace.read', 'artifact.create'], allowed_tools: ['workflow_catalog'], skills: [] }
];

const versionedRole = role_id => ({ role_id, role_version: 1 });
const task = (id, role_id, depends_on = [], extra = {}) => ({ id, ...versionedRole(role_id), depends_on, ...extra });
const validDefinitions = [
  {
    name: 'out-of-order-linear-plan',
    definition: {
      workflow_id: 'node-linear-delivery', version: 1, name: 'Linear Delivery', description: 'Out of order typed chain', input_contract: ['job.request'],
      tasks: [
        task('document', 'custom-writer', ['implement']),
        task('implement', 'custom-implementer', ['architecture']),
        task('architecture', 'custom-architect', ['research']),
        task('research', 'custom-researcher', ['requirements']),
        task('requirements', 'custom-owner')
      ]
    }
  },
  {
    name: 'branch-and-merge-plan',
    definition: {
      workflow_id: 'node-branch-merge', version: 1, name: 'Branch and Merge', description: 'Two parallel research branches merge into architecture', input_contract: ['job.request'],
      tasks: [
        task('architecture', 'custom-architect', ['market', 'research']),
        task('market', 'custom-market-researcher', ['requirements']),
        task('research', 'custom-researcher', ['requirements']),
        task('requirements', 'custom-owner')
      ]
    }
  },
  {
    name: 'multiple-roots-stable-order-plan',
    definition: {
      workflow_id: 'node-multiple-roots', version: 1, name: 'Multiple Roots', description: 'Multiple ready roots retain plan order where unconstrained', input_contract: ['job.request'],
      tasks: [
        task('research', 'custom-researcher'),
        task('requirements', 'custom-owner'),
        task('market', 'custom-market-researcher'),
        task('architecture', 'custom-architect', ['research', 'market', 'requirements'])
      ]
    }
  }
];

const rejectedDefinitions = [
  {
    name: 'unknown-dependency', expected_error_class: 'UNKNOWN_DEPENDENCY',
    definition: { workflow_id: 'node-reject-unknown-dependency', version: 1, name: 'Unknown Dependency', description: 'Unknown predecessor', input_contract: ['job.request'], tasks: [task('collect', 'custom-researcher', ['missing'])] }
  },
  {
    name: 'duplicate-task-id', expected_error_class: 'DUPLICATE_TASK',
    definition: { workflow_id: 'node-reject-duplicate-task', version: 1, name: 'Duplicate Task', description: 'Duplicate task identity', input_contract: ['job.request'], tasks: [task('same', 'custom-owner'), task('same', 'custom-researcher')] }
  },
  {
    name: 'dependency-cycle', expected_error_class: 'DEPENDENCY_CYCLE',
    definition: { workflow_id: 'node-reject-cycle', version: 1, name: 'Dependency Cycle', description: 'Cycle with artifact-compatible edges', input_contract: ['job.request'], tasks: [task('requirements', 'custom-owner', ['research']), task('research', 'custom-researcher', ['requirements'])] }
  },
  {
    name: 'unsupported-role-input', expected_error_class: 'UNSUPPORTED_ROLE_INPUT',
    definition: { workflow_id: 'node-reject-input', version: 1, name: 'Unsupported Input', description: 'Input exceeds role contract', input_contract: ['job.request'], tasks: [task('collect', 'custom-researcher', [], { input_contract: ['architecture'] })] }
  },
  {
    name: 'role-output-mismatch', expected_error_class: 'ROLE_OUTPUT_MISMATCH',
    definition: { workflow_id: 'node-reject-output', version: 1, name: 'Output Mismatch', description: 'Task output differs from role', input_contract: ['job.request'], tasks: [task('requirements', 'custom-owner', [], { output_artifact_type: 'research' })] }
  },
  {
    name: 'unknown-custom-role-version', expected_error_class: 'UNKNOWN_CUSTOM_ROLE_VERSION',
    definition: { workflow_id: 'node-reject-role-version', version: 1, name: 'Unknown Role Version', description: 'Unregistered immutable role version', input_contract: ['job.request'], tasks: [{ id: 'collect', role_id: 'custom-researcher', role_version: 2, depends_on: [] }] }
  }
];

function expectedErrorClass(error) {
  const message = String(error?.message || error);
  if (/depends on unknown task/.test(message)) return 'UNKNOWN_DEPENDENCY';
  if (/duplicate task id/.test(message)) return 'DUPLICATE_TASK';
  if (/dependency cycle detected/.test(message)) return 'DEPENDENCY_CYCLE';
  if (/input contract is not supported by role/.test(message)) return 'UNSUPPORTED_ROLE_INPUT';
  if (/output type .* does not match pinned role/.test(message)) return 'ROLE_OUTPUT_MISMATCH';
  if (/custom role version not found/.test(message)) return 'UNKNOWN_CUSTOM_ROLE_VERSION';
  throw new Error(`unmapped Node custom-workflow error: ${message}`);
}

try {
  initializeCustomRoleStore(db);
  initializeCustomWorkflowStore(db);
  for (const role of roleDefinitions) await createCustomRole(db, role, { createdBy: 'node-custom-workflow-oracle' });

  const validCases = validDefinitions.map(({ name, definition }) => {
    createCustomWorkflow(db, definition, { createdBy: 'node-custom-workflow-oracle' });
    const plan = previewCustomWorkflow(db, definition.workflow_id, definition.version);
    const canonical = JSON.stringify({
      schema_version: plan.schema_version,
      workflow_id: plan.workflow_id,
      workflow_version: plan.workflow_version,
      name: plan.name,
      input_contract: plan.input_contract,
      tasks: plan.tasks
    });
    const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
    if (digest !== plan.plan_hash) throw new Error(`Node preview produced inconsistent plan hash for ${name}`);
    return {
      name,
      definition,
      canonical_content: canonical,
      plan_hash: plan.plan_hash,
      task_order: plan.tasks.map(item => item.task_id)
    };
  });

  const rejectionCases = rejectedDefinitions.map(({ name, expected_error_class, definition }) => {
    let actual;
    try {
      createCustomWorkflow(db, definition, { createdBy: 'node-custom-workflow-oracle' });
      actual = 'ACCEPTED';
    } catch (error) {
      actual = expectedErrorClass(error);
    }
    if (actual !== expected_error_class) throw new Error(`${name}: expected ${expected_error_class}, got ${actual}`);
    return { name, definition, expected_error_class: actual };
  });

  const fixture = {
    schema_version: 1,
    generated_by_node: true,
    source: 'src/runtime/workflow/custom-workflows.js::createCustomWorkflow + previewCustomWorkflow',
    roles: roleDefinitions,
    valid_cases: validCases,
    rejected_cases: rejectionCases
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o644 });
  console.log(JSON.stringify({ output: outputPath, roles: roleDefinitions.length, valid_cases: validCases.length, rejected_cases: rejectionCases.length, plan_hashes: validCases.map(item => ({ name: item.name, plan_hash: item.plan_hash })), rejected: rejectionCases.map(item => ({ name: item.name, expected_error_class: item.expected_error_class })) }, null, 2));
} finally {
  db.close();
}
