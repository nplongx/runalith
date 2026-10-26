#!/usr/bin/env node
// Static compatibility check only: preserve the frozen ten prompts while checking
// the owner-directed refreshed candidate and its still-blocked v2 successor. Never opens a gate.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundleRelative = 'artifacts/runalith-1.0.9-rc.5-candidate-agg-phase1-lineage-hardening-20261022T072520Z.mcpb';
const bundle = path.join(ROOT, bundleRelative);
const expectedBundleSha256 = 'd3be0959617efd28c95c08357cfe909ed7150a71e16d5db4e2aead1e739739b5';
const expectedBundleSize = 562164;
const expectedPlanSha256 = '78fed565dc6f58f89774d40d974c724c838314f3d4f3d06aca9ad89171fc5144';
const expectedFreezeSha256 = '4a2ceb6157afd9c299ccfee50695d0d0ddd1630375d49a211d68b53718fcca62';
const expectedPromptSetSha256 = 'ce2d0d6627d31e13e3e6f23b7df8febea5f850191b3ac8254ea0ced1cd848e57';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function readHash(p) { return hash(fs.readFileSync(path.join(ROOT, p))); }

function unzipManifest() {
  const result = spawnSync('unzip', ['-p', bundle, 'manifest.json'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, `cannot read latest candidate manifest: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v1.json'), 'utf8'));
const policySpec = JSON.parse(fs.readFileSync(path.join(ROOT, 'benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v2.json'), 'utf8'));
const targetProposalPath = 'benchmarks/plugin-workflow-benchmark/phase1-latest-build-target-successor-proposal-20261022-v2.json';
const targetProposalBytes = fs.readFileSync(path.join(ROOT, targetProposalPath));
const targetProposal = JSON.parse(targetProposalBytes.toString('utf8'));
const ownerDirection = JSON.parse(fs.readFileSync(path.join(ROOT, 'artifacts/agg-phase1-latest-build-target-direction-20261022-v2.json'), 'utf8'));
const oldProposal = JSON.parse(fs.readFileSync(path.join(ROOT, 'benchmarks/plugin-workflow-benchmark/phase1-latest-build-target-successor-proposal-20261022.json'), 'utf8'));
const oldOwnerApproval = JSON.parse(fs.readFileSync(path.join(ROOT, 'artifacts/agg-phase1-target-successor-formal-owner-approval-20261022.json'), 'utf8'));
const actualBundleHash = readHash(bundleRelative);
assert.equal(actualBundleHash, expectedBundleSha256, 'candidate bytes differ from selected latest build');
assert.equal(fs.statSync(bundle).size, expectedBundleSize, 'candidate byte size differs from current selected candidate');
assert.equal(readHash('docs/plugin-workflow-benchmark-plan.md'), expectedPlanSha256, 'original plan changed unexpectedly');
assert.equal(readHash('docs/plugin-workflow-benchmark-phase1-freeze.md'), expectedFreezeSha256, 'original freeze changed unexpectedly');
assert.equal(spec.cases.length, 10, 'frozen operational spec must keep exactly ten cases');
assert.equal(policySpec.cases.length, 10, 'policy spec must keep exactly ten cases');
assert.deepEqual(policySpec.cases.map(item => ({ case_id: item.case_id, prompt: item.prompt })),
  spec.cases.map(item => ({ case_id: item.case_id, prompt: item.prompt })),
  'policy spec must preserve all original prompt bytes and case order');
const promptSetHash = hash(Buffer.from(spec.cases.map(item => item.prompt).join('\n')));
assert.equal(promptSetHash, expectedPromptSetSha256, 'original ten prompt bytes/order changed unexpectedly');

const manifest = unzipManifest();
assert.equal(manifest.version, '1.0.9-rc.5');
const manifestNames = new Set((manifest.tools ?? []).map(tool => tool.name));
assert.equal(manifestNames.size, 67, 'selected latest candidate manifest tool count changed');
const allowlistFindings = spec.cases.map(item => ({
  case_id: item.case_id,
  missing_plugin_tools: (item.plugin_tools ?? []).filter(name => !manifestNames.has(name)),
  allowed_plugin_tools: (item.plugin_tools ?? []).length
}));
assert.ok(allowlistFindings.every(item => item.missing_plugin_tools.length === 0), JSON.stringify(allowlistFindings));
const policyAllowlistFindings = policySpec.cases.map(item => ({
  case_id: item.case_id,
  missing_plugin_tools: (item.plugin_tools ?? []).filter(name => !manifestNames.has(name)),
  allowed_plugin_tools: (item.plugin_tools ?? []).length
}));
assert.ok(policyAllowlistFindings.every(item => item.missing_plugin_tools.length === 0), JSON.stringify(policyAllowlistFindings));

const case6 = policySpec.cases.find(item => item.case_id === 'CASE-06');
assert.ok(case6, 'original CASE-06 is missing');
for (const forbidden of ['workflow_approve', 'workflow_dispatch', 'workflow_prepare_tasks', 'workflow_next_task',
  'workflow_complete_task', 'workflow_complete_synthesis', 'workflow_e2e_run', 'task_execute_local',
  'custom_role_create', 'custom_workflow_create', 'custom_workflow_preview', 'custom_workflow_approve',
  'custom_workflow_run_create', 'write_file', 'delete_file']) {
  assert.ok(case6.hard_denied_tools.includes(forbidden), `CASE-06 lost hard deny ${forbidden}`);
  assert.ok(!case6.plugin_tools.includes(forbidden), `CASE-06 exposes forbidden plugin tool ${forbidden}`);
}
assert.equal(spec.execution_gate?.status, 'blocked', 'the historical frozen spec gate must remain closed');
assert.equal(policySpec.execution_gate?.status, 'blocked', 'the historical policy-spec gate must remain closed');

assert.equal(targetProposal.status, 'DRAFT_REVIEW_REQUIRED_NOT_AUTHORIZED');
assert.equal(targetProposal.proposed_target.sha256, expectedBundleSha256);
assert.equal(targetProposal.proposed_target.version, manifest.version);
assert.equal(targetProposal.proposed_target.bundle_path, bundleRelative);
assert.equal(targetProposal.proposed_target.size_bytes, expectedBundleSize);
assert.equal(targetProposal.proposed_target.manifest_sha256, hash(spawnSync('unzip', ['-p', bundle, 'manifest.json'], { encoding: 'buffer', timeout: 5000 }).stdout));
assert.equal(targetProposal.target_build_evidence.source_to_packaged_server_bytes_match, true);
assert.equal(targetProposal.corpus_preservation.scenario_count, 10);
assert.equal(targetProposal.corpus_preservation.ordered_prompt_set_sha256, expectedPromptSetSha256);
assert.deepEqual(targetProposal.scenarios.map(item => ({ case_id: item.case_id, prompt: item.prompt })),
  spec.cases.map(item => ({ case_id: item.case_id, prompt: item.prompt })), 'successor proposal changed prompt bytes/order');
assert.deepEqual(targetProposal.corpus_preservation.category_weights,
  { planning: 20, failure_handling_and_recovery: 25, safety_and_execution_authorization: 25, result_verification: 15, reporting_and_traceability: 15 });
assert.equal(targetProposal.authorization.execution_gate_open, false);
assert.equal(targetProposal.authorization.execution_authorized, false);
assert.equal(targetProposal.authorization.operational_scenarios_started, false);
assert.equal(targetProposal.authorization.approval_record, null);
assert.equal(targetProposal.authorization.run_attestation, null);
assert.equal(ownerDirection.selected_target.sha256, expectedBundleSha256);
assert.equal(ownerDirection.selected_target.proposal_sha256, hash(targetProposalBytes));
assert.equal(ownerDirection.selected_target.proposal_path, targetProposalPath);
assert.equal(ownerDirection.important_boundaries.this_direction_is_not_a_cryptographic_signature, true);
assert.equal(ownerDirection.important_boundaries.this_direction_does_not_open_operational_execution_gate, true);
assert.equal(oldProposal.proposed_target.sha256, '212785eb3eb0d254caec777ce9ad00491a7533d6661c3fbf85f29b65e7506432',
  'historical successor proposal must remain byte-preserved and pinned to the earlier candidate');
assert.equal(oldOwnerApproval.target.sha256, oldProposal.proposed_target.sha256,
  'formal historical owner approval must remain bound to its original target; do not pretend it signed the new archive');
assert.notEqual(oldOwnerApproval.target.sha256, expectedBundleSha256,
  'exact-byte formal approval for the refreshed archive remains a distinct pending gate');

const oldTargetText = `${spec.paired_conditions?.condition_parity_rule ?? ''}\n${spec.paired_conditions?.plugin_condition_additional_tools ?? ''}`;
assert.match(oldTargetText, /1\.0\.8/, 'expected to detect the original frozen bundle target');

console.log('PHASE1_LATEST_TARGET_COMPATIBILITY=PASS_STATIC_ONLY');
console.log(`candidate_sha256=${actualBundleHash}`);
console.log(`candidate_version=${manifest.version}`);
console.log(`candidate_tools=${manifestNames.size}`);
console.log(`original_scenarios=${spec.cases.length}`);
console.log(`original_prompt_set_sha256=${promptSetHash}`);
console.log(`v1_case_tool_allowlists_compatible=${allowlistFindings.every(item => item.missing_plugin_tools.length === 0)}`);
console.log(`v2_policy_tool_allowlists_compatible=${policyAllowlistFindings.every(item => item.missing_plugin_tools.length === 0)}`);
console.log('case06_dangerous_actions_remain_hard_denied=true');
console.log('historical_execution_gate=blocked');
console.log('target_spec_binding=V2_SUCCESSOR_MATCHES_CURRENT_OWNER_DIRECTED_BUILD');
console.log('successor_target_proposal=DRAFT_REVIEW_REQUIRED_NOT_AUTHORIZED');
console.log('owner_direction_hash_bound=true');
console.log('formal_exact_byte_approval_for_current_build=false');
console.log('scenario_execution_performed=false');
