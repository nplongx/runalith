import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ArtifactType,
  createArtifactRecord,
  validateArtifact,
  artifactSchemaForType,
  normalizeSuccessContract,
  validateSuccessContract,
  evaluateSuccessPredicate,
  validateSuccessAssessment,
  parseStrictJson
} from '../src/runtime/workflow-contracts-public-api.js';
import * as AgentContracts from '../src/runtime/agent-contracts-public-api.js';
import { validateCompiledActionIntent } from '../src/runtime/workflow/agent-contracts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'docs/subsystems/public-repository-snapshots.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

assert.equal(manifest.schemaVersion, 1);
assert.ok(Array.isArray(manifest.snapshots) && manifest.snapshots.length === 4);

for (const snapshot of manifest.snapshots) {
  assert.match(snapshot.repository, /^https:\/\/github\.com\//);
  assert.match(snapshot.commit, /^[a-f0-9]{40}$/);
  assert.ok(Array.isArray(snapshot.files) && snapshot.files.length > 0);
  const seen = new Set();
  for (const file of snapshot.files) {
    assert.equal(typeof file.path, 'string');
    assert.ok(!path.isAbsolute(file.path) && !file.path.split(/[\\/]/).includes('..'));
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.equal(seen.has(file.path), false, `${snapshot.name}: duplicate manifest path ${file.path}`);
    seen.add(file.path);
    const sourcePath = path.join(root, snapshot.localRoot, file.path);
    assert.ok(fs.existsSync(sourcePath), `${snapshot.name}: missing mirrored source ${sourcePath}`);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
    assert.equal(actual, file.sha256,
      `${snapshot.name}:${file.path} drifted from ${snapshot.repository}@${snapshot.commit}; update both public snapshot and manifest together`);
  }
}

// Exercise the host's explicit public facade rather than reaching into its
// implementation modules. These tests intentionally use synthetic read models;
// durable lineage/trust eligibility remains the caller's responsibility.
const artifact = createArtifactRecord({
  artifact_id: 'artifact-public-api-test', job_id: 'job-public-api-test',
  task_id: 'task-product-owner', type: ArtifactType.REQUIREMENTS,
  producer_role: 'product-owner',
  content: { scope: 'Public contract boundary', acceptance_criteria: ['Stable API'], non_goals: [] },
  evidence: ['fixture:public-api'], created_at: '2026-10-31T00:00:00.000Z'
});
assert.equal(validateArtifact(artifact), true);
assert.deepEqual(artifactSchemaForType(ArtifactType.REQUIREMENTS).required_content_fields,
  ['scope', 'acceptance_criteria', 'non_goals']);

const successContract = normalizeSuccessContract({
  goal: 'Validate public workflow contract API',
  success_criteria: [{ id: 'scope-bound', type: 'artifact_field_equals',
    artifact_type: 'requirements', producer_role: 'product-owner',
    field: 'scope', expected: 'Public contract boundary' }]
});
assert.equal(validateSuccessContract(successContract).schema_version, 1);
const context = { plan: { children: [] }, tasks: [], artifacts: [artifact] };
assert.equal(evaluateSuccessPredicate(successContract.success_criteria[0], context).passed, true);
assert.deepEqual(validateSuccessAssessment(successContract, {
  goal_status: 'achieved', summary: 'Synthetic public contract fixture passed.',
  constraints: [], criteria: [{ id: 'scope-bound', status: 'met', evidence_refs: [artifact.artifact_id] }]
}, context), { valid: true, errors: [] });
assert.deepEqual(parseStrictJson('{"contract":1}'), { contract: 1 });
assert.throws(() => parseStrictJson('{"x":1,"\\u0078":2}'), /duplicate/);

// Pure Agent Contracts facade stays independent from AGG compiled semantics.
assert.equal(AgentContracts.AGENT_ROLES.length, 10);
assert.equal(AgentContracts.getAgentContract('engineer').actionIntentContract.schemaVersion, 1);
assert.deepEqual(AgentContracts.getAgentInputArtifactTypes('engineer'), ['requirements', 'architecture']);
assert.equal(typeof AgentContracts.validateCompiledActionIntent, 'undefined');
assert.equal(typeof validateCompiledActionIntent, 'function');
assert.throws(() => validateCompiledActionIntent('engineer', {}, 'task-1'), /exact version-1 task-input contract/);

console.log(`public subsystem source alignment and host facade PASS (${manifest.snapshots.length} repositories, ${manifest.snapshots.reduce((sum, item) => sum + item.files.length, 0)} files)`);
