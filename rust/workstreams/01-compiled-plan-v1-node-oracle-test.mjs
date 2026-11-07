#!/usr/bin/env node
/**
 * Independent Node public-API producer oracle for W1 CompiledPlanV1.
 *
 * Rebuilds definition pins, skill pins, full immutable plan bytes/hash and
 * policy-composed envelope from the same public Node canonicalizer and policy
 * composition APIs consumed by the Rust compiler tests. This is a test only;
 * it does not change production compilation, import skills, resolve trust,
 * persist policies, or issue authorization.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../../src/runtime/workflow/plan.js';
import {
  composePolicySuccessContract,
  createPolicySnapshot,
  normalizePolicyDefinition,
} from '../../src/runtime/workflow/policy-contract.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FIXTURE_DIR = path.join(ROOT, 'rust/crates/runalith-domain/tests/fixtures');
const PLAN_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'node-compiled-plan-v1.json'), 'utf8'),
);
const POLICY_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'node-compiled-plan-policy-v1.json'), 'utf8'),
);
const POLICY_NUMBER_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'node-policy-number-snapshot-v1.json'), 'utf8'),
);

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function digestJson(value) {
  return sha256(Buffer.from(canonicalJson(value), 'utf8'));
}

function makeWorkflowDefinition() {
  return {
    workflow_id: 'skill-pinned-flow',
    version: 3,
    name: 'Skill Pinned Flow',
    description: 'A workflow that binds one trusted skill bundle',
    input_contract: ['job.request'],
    tasks: [{
      id: 'requirements',
      role_id: 'custom-owner',
      role_version: 1,
      depends_on: [],
      input_contract: ['job.request'],
      output_artifact_type: 'requirements',
    }],
  };
}

function makeRoleDefinition() {
  return {
    role_id: 'custom-owner',
    version: 1,
    name: 'Custom Owner',
    description: 'Version-pinned custom role',
    system_prompt: 'Use declared typed inputs only',
    input_contract: ['job.request'],
    output_artifact_type: 'requirements',
    allowed_capabilities: ['product.requirements'],
    permissions: ['workspace.read', 'artifact.create'],
    allowed_tools: ['workflow_get'],
    skills: ['research-helper'],
  };
}

function baseEnvelope() {
  assert.equal(PLAN_FIXTURE.schema_version, 1);
  assert.equal(PLAN_FIXTURE.generated_by_node, true);
  assert.match(PLAN_FIXTURE.source, /workflow\/plan\.js::canonicalJson/u);
  const vector = PLAN_FIXTURE.vectors.find(
    (item) => item.name === 'workflow-role-and-skill-definition-pinned-plan',
  );
  assert.ok(vector, 'Node-generated base plan vector must exist');

  const workflow = makeWorkflowDefinition();
  const role = makeRoleDefinition();
  assert.equal(digestJson(workflow), vector.workflow_definition_sha256,
    'workflow definition digest must match Node oracle');
  assert.equal(digestJson(role), vector.role_definition_sha256,
    'role definition digest must match Node oracle');

  const envelope = JSON.parse(vector.canonical_json);
  assert.equal(envelope.schema_version, 1);
  assert.deepEqual(envelope.workflow_definition_pin, {
    workflow_id: workflow.workflow_id,
    workflow_version: workflow.version,
    definition_sha256: vector.workflow_definition_sha256,
  });
  assert.deepEqual(envelope.role_definition_pins, [{
    role_id: role.role_id,
    role_version: role.version,
    definition_sha256: vector.role_definition_sha256,
  }]);
  assert.deepEqual(envelope.skill_pins, [{
    role_id: role.role_id,
    role_version: role.version,
    skill_id: 'research-helper',
    bundle_sha256: 'a'.repeat(64),
  }]);
  assert.equal(envelope.workflow_plan.workflow_id, workflow.workflow_id);
  assert.equal(envelope.workflow_plan.workflow_version, workflow.version);
  assert.equal(envelope.workflow_plan.tasks[0].task_id, 'requirements');
  assert.equal(envelope.workflow_plan.tasks[0].role_id, role.role_id);
  assert.equal(envelope.workflow_plan.tasks[0].role_version, role.version);

  const bytes = Buffer.from(canonicalJson(envelope), 'utf8');
  assert.equal(bytes.toString('utf8'), vector.canonical_json,
    'canonical CompiledPlanV1 bytes must equal the stored Node vector exactly');
  assert.equal(sha256(bytes), vector.sha256,
    'outer CompiledPlanV1 digest must equal the stored Node vector');

  const changedSkill = structuredClone(envelope);
  changedSkill.skill_pins[0].bundle_sha256 = 'b'.repeat(64);
  assert.notEqual(digestJson(changedSkill), vector.sha256,
    'changing the trusted skill bundle pin must change the outer digest');

  const changedRole = structuredClone(envelope);
  changedRole.role_definition_pins[0].definition_sha256 = 'c'.repeat(64);
  assert.notEqual(digestJson(changedRole), vector.sha256,
    'changing the role definition pin must change the outer digest');

  const changedWorkflow = structuredClone(envelope);
  changedWorkflow.workflow_definition_pin.definition_sha256 = 'd'.repeat(64);
  assert.notEqual(digestJson(changedWorkflow), vector.sha256,
    'changing the workflow definition pin must change the outer digest');

  return { envelope, vector };
}

function policyComposedEnvelope(base) {
  assert.equal(POLICY_FIXTURE.generated_by_node, true);
  assert.match(POLICY_FIXTURE.source, /composePolicySuccessContract/u);

  const definition = normalizePolicyDefinition({
    schema_version: 1,
    policy_id: 'require-owner',
    name: 'Require custom owner',
    description: 'The immutable plan must include the custom owner role',
    constraints: [{
      id: 'owner-present',
      type: 'task_role_present',
      role: 'custom-owner',
    }],
    success_criteria: [{
      id: 'all-complete',
      type: 'all_tasks_completed',
    }],
  });
  const snapshot = createPolicySnapshot('require-owner', 1, definition);
  const composition = composePolicySuccessContract(
    { goal: 'Complete workflow' },
    [snapshot],
    {
      workflowId: 'skill-pinned-flow',
      children: [{ id: 'requirements', role: 'custom-owner' }],
    },
  );

  const envelope = {
    ...structuredClone(base.envelope),
    policy_composition: {
      base_success_contract: composition.base_success_contract,
      success_contract: composition.success_contract,
      policy_packs: composition.policy_packs,
      policy_pins: composition.policy_packs.map((item) => ({
        policy_id: item.policy_id,
        version: item.version,
        content_sha256: item.content_hash,
      })),
    },
  };

  const bytes = Buffer.from(canonicalJson(envelope), 'utf8');
  assert.equal(bytes.toString('utf8'), POLICY_FIXTURE.canonical_json,
    'policy-composed CompiledPlanV1 bytes must equal the Node golden vector');
  assert.equal(sha256(bytes), POLICY_FIXTURE.sha256,
    'policy-composed outer digest must equal the Node golden vector');
  assert.equal(
    composition.policy_packs[0].content_hash,
    JSON.parse(POLICY_FIXTURE.canonical_json).policy_composition.policy_packs[0].content_hash,
    'immutable policy snapshot hash must match the Node plan vector',
  );

  const changedPolicy = structuredClone(envelope);
  changedPolicy.policy_composition.policy_packs[0].description += ' changed';
  assert.notEqual(sha256(Buffer.from(canonicalJson(changedPolicy), 'utf8')), POLICY_FIXTURE.sha256,
    'changing a policy snapshot included in the plan must change the outer digest');
}

function policyNumberSnapshots() {
  assert.equal(POLICY_NUMBER_FIXTURE.schema_version, 1);
  assert.equal(POLICY_NUMBER_FIXTURE.generated_by_node, true);
  assert.match(POLICY_NUMBER_FIXTURE.source, /createPolicySnapshot/u);
  assert.equal(POLICY_NUMBER_FIXTURE.vectors.length, 4);
  for (const vector of POLICY_NUMBER_FIXTURE.vectors) {
    const normalized = normalizePolicyDefinition(vector.definition);
    const snapshot = createPolicySnapshot(vector.snapshot.policy_id, vector.snapshot.version, normalized);
    assert.deepEqual(snapshot, vector.snapshot, `Node numeric policy snapshot ${vector.snapshot.policy_id}`);
  }
}

const { envelope, vector } = baseEnvelope();
policyComposedEnvelope({ envelope });
policyNumberSnapshots();

console.log('PASS W1 Node public API workflow definition pin SHA-256');
console.log('PASS W1 Node public API role definition pin SHA-256');
console.log('PASS W1 CompiledPlanV1 canonical UTF-8 bytes and outer SHA-256');
console.log('PASS W1 role, workflow and skill pin mutation sensitivity');
console.log('PASS W1 policy snapshot normalization, composition and outer plan bytes/hash');
console.log('PASS W1 Node policy snapshot fractional/exponent/large-number hashes');
console.log(`ORACLE CompiledPlanV1 ${vector.sha256}`);
console.log(`ORACLE Policy-CompiledPlanV1 ${POLICY_FIXTURE.sha256}`);
