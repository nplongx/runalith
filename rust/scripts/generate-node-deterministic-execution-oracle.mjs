#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateExecutionPlan } from '../../src/runtime/workflow/plan.js';
import { standardEngineeringValidationTaskSpecs } from '../../src/runtime/workflow/catalog/standard-engineering.js';
import { hybridEngineeringDeterministicTaskSpecs } from '../../src/runtime/workflow/catalog/hybrid-engineering.js';
import { ProductionTaskId, productionTaskSpec } from '../../src/runtime/workflow/catalog/production.js';

const rustRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(rustRoot, '..');
const defaultOutput = path.join(rustRoot, 'crates/runalith-domain/tests/fixtures/node-deterministic-execution-v1.json');
const outputPath = path.resolve(process.argv[2] || defaultOutput);
const workspace = repositoryRoot;

function executionPlan(task, index) {
  const taskId = task.id || `node-task-${index}`;
  const child = {
    id: taskId,
    role: task.role || 'validation',
    capability: task.capability ?? null,
    dependencies: [],
    execution: task.execution
  };
  return {
    schema_version: 1,
    workflow_id: 'node-deterministic-execution-oracle',
    workflow_version: 1,
    job_id: `job_node_execution_oracle_${index}`,
    phases: ['PROPOSED'],
    children: [child],
    required_children: [taskId],
    synthesis: { id: 'oracle-synthesis', role: 'cto', dependencies: [] }
  };
}

function nodeTruthy(value) {
  return !(value === null || value === undefined || value === false || value === 0 || value === '' ||
    (typeof value === 'number' && Number.isNaN(value)));
}

function nodeValidation(task, index) {
  try {
    validateExecutionPlan(executionPlan(task, index));
    return { outcome: nodeTruthy(task.execution?.deterministic) ? 'ACCEPTED' : 'NOT_DETERMINISTIC', error: null };
  } catch (error) {
    return { outcome: 'REJECTED', error: String(error?.message || error) };
  }
}

const catalogTasks = [
  ...standardEngineeringValidationTaskSpecs(workspace).map(task => ({ ...task, catalog: 'standard-engineering' })),
  ...hybridEngineeringDeterministicTaskSpecs(workspace).map(task => ({ ...task, catalog: 'hybrid-engineering' })),
  {
    ...productionTaskSpec(ProductionTaskId.ARCHITECT_CHECK, { workspace }),
    catalog: 'production'
  }
];

const validTasks = catalogTasks.map((task, index) => {
  const validation = nodeValidation(task, index);
  return {
    catalog: task.catalog,
    task_id: task.id,
    role: task.role,
    execution: task.execution,
    ...validation
  };
});

const base = {
  executor: 'ExecutionManager',
  executable: 'node',
  args: ['--check', path.join(workspace, 'server/index.js')],
  command: `node --check ${path.join(workspace, 'server/index.js')}`,
  cwd: workspace,
  timeout_ms: 120_000,
  deterministic: true,
  output_artifact_type: 'documentation'
};

const validationInputs = [
  ['wrong-executor', { ...base, executor: 'ChatOnSteroidsHost' }],
  ['missing-executable', { ...base, executable: '' }],
  ['arguments-not-array', { ...base, args: { 0: '--check' } }],
  ['missing-cwd', { ...base, cwd: '' }],
  ['fractional-timeout', { ...base, timeout_ms: 1.5 }],
  ['zero-timeout', { ...base, timeout_ms: 0 }],
  ['truthy-string-marker', { ...base, deterministic: 'enabled' }],
  ['non-deterministic-host-task', { executor: 'ChatOnSteroidsHost', deterministic: false, execution_mode: 'host-conversation' }],
  ['non-string-argv-elements', { ...base, args: ['--check', 7, null] }]
];

const validationCases = validationInputs.map(([name, execution], index) => ({
  name,
  execution,
  strict_deterministic: execution.deterministic === true,
  ...nodeValidation({
    id: name,
    role: 'validation',
    capability: null,
    execution
  }, index + validTasks.length)
}));

const fixture = {
  schema_version: 1,
  generated_by_node: true,
  source: 'src/runtime/workflow/plan.js::validateExecutionPlan + built-in deterministic task catalogs',
  valid_tasks: validTasks,
  validation_cases: validationCases
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify({
  output: outputPath,
  catalog_tasks: validTasks.length,
  validation_cases: validationCases.length,
  outcomes: Object.fromEntries(Object.entries(Object.groupBy([...validTasks, ...validationCases], item => item.outcome))
    .map(([key, values]) => [key, values.length]))
}, null, 2));
