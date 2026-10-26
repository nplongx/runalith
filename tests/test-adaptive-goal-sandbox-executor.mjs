import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  assertAdaptiveGoalSandboxExecutorEnabled,
  runAdaptiveGoalSandboxAction,
  verifyAdaptiveGoalSandboxReceipt,
  ADAPTIVE_GOAL_SANDBOX_ACTION_ID
} from '../src/runtime/adaptive-goal-sandbox-executor.js';
import { canonicalJson } from '../src/runtime/workflow/plan.js';
import { hashArtifactContent } from '../src/runtime/workflow/artifacts.js';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const requirements = {
  scope: 'bounded test fixture',
  acceptance_criteria: ['artifact content validated'],
  non_goals: ['do not execute an AGG action']
};
const architecture = {
  components: ['Execution Graph proposal checker'],
  interfaces: ['read-only MCP proposal API'],
  failure_modes: ['stale artifact evidence'],
  implementation_boundary: 'fixture only; no execution graph runtime'
};
const candidate = {
  candidateHash: 'c'.repeat(64),
  executionPlan: { plan_hash: 'd'.repeat(64) },
  compiler: { compilerPlanHash: 'd'.repeat(64) },
  hashes: { reviewedTaskInputContractHash: 'a'.repeat(64) }
};
const planTask = { id: 'standard-engineer' };
const intent = {
  operation: 'implement', role: 'engineer', role_contract_id: 'agent.engineer', role_contract_version: 1,
  task_id: 'standard-engineer', target: { kind: 'work_item', reference: 'agg-step-0123456789abcdef01234567' },
  description: 'Perform implement on work_item:agg-step-0123456789abcdef01234567; produce implementation; success criteria: approved_scope_implemented, implementation_evidence_recorded, tests_or_verification_run.',
  semantic_verification: { policy_version: 1 },
  source: { reviewed_task_input_contract_hash: 'a'.repeat(64) },
  success_criteria: ['approved_scope_implemented', 'implementation_evidence_recorded', 'tests_or_verification_run'],
  task_input_bindings: [
    { input_type: 'requirements', source: { kind: 'evidence', reference: 'artifact://requirements-test' } },
    { input_type: 'architecture', source: { kind: 'evidence', reference: 'artifact://architecture-test' } }
  ]
};
function snapshot(type, content) {
  const artifactId = `${type}-test`;
  return {
    kind: 'evidence', inputType: type, content,
    artifactMetadata: {
      job_id: 'source-job-fixture', artifact_id: artifactId, type, schema_version: 1,
      content_hash: hashArtifactContent(content), artifact_created_event_id: `created-${artifactId}`,
      producer_role: type === 'requirements' ? 'product-owner' : 'architect',
      producer_task_id: `task-${artifactId}`, producer_result_id: `result-${artifactId}`,
      producer_completion_event_id: `completed-${artifactId}`
    }
  };
}
const inputs = [snapshot('requirements', requirements), snapshot('architecture', architecture)];

test('sandbox executor fails closed outside explicitly test-only fixture mode', () => {
  assert.throws(() => assertAdaptiveGoalSandboxExecutorEnabled({ nodeEnv: 'production', mode: 'fixture' }), /AGG_SANDBOX_EXECUTOR_TEST_ONLY/);
  assert.throws(() => assertAdaptiveGoalSandboxExecutorEnabled({ nodeEnv: 'test', mode: undefined }), /AGG_SANDBOX_EXECUTOR_TEST_ONLY/);
  assert.equal(assertAdaptiveGoalSandboxExecutorEnabled({ nodeEnv: 'test', mode: 'fixture' }), true);
});

test('only exact bounded requirements/architecture inputs can authorize the allowlisted fixture action', () => {
  const priorEnv = { nodeEnv: process.env.NODE_ENV, mode: process.env.AGG_SANDBOX_EXECUTOR_MODE };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-sandbox-unit-'));
  process.env.NODE_ENV = 'test';
  process.env.AGG_SANDBOX_EXECUTOR_MODE = 'fixture';
  try {
    const intentHash = digest(canonicalJson(intent));
    const execution = runAdaptiveGoalSandboxAction({
      sandboxRoot: path.join(temp, 'sandbox-root'), jobId: 'job-fixture', taskId: 'task-fixture',
      candidateHash: candidate.candidateHash, immutablePlanHash: candidate.executionPlan.plan_hash, intentHash,
      intent, planTask, candidate, taskInputSnapshots: inputs
    });
    assert.equal(execution.result.actionId, ADAPTIVE_GOAL_SANDBOX_ACTION_ID);
    assert.equal(execution.result.testsPassed, 3);
    assert.equal(execution.artifact.execution.status, 'success');
    assert.equal(execution.artifact.execution.production_authority_granted, undefined,
      'fixture output must not synthesize production execution authority');
    const receipt = verifyAdaptiveGoalSandboxReceipt({
      sandboxRoot: path.join(temp, 'sandbox-root'), receiptPath: execution.result.receiptPath,
      receiptSha256: execution.result.receiptSha256, jobId: 'job-fixture', candidateHash: candidate.candidateHash,
      immutablePlanHash: candidate.executionPlan.plan_hash, taskId: 'task-fixture', intentHash
    });
    assert.equal(receipt.valid, true);
    assert.equal(receipt.filesVerified, 4);
    assert.equal(receipt.prerequisitesVerified, 2);

    // A checksum over valid JSON is not enough: the durable receipt contract
    // requires the same canonical byte representation used at commit time.
    const canonicalReceiptBytes = fs.readFileSync(execution.result.receiptPath);
    const semanticallyEquivalentBytes = Buffer.from(`${JSON.stringify(JSON.parse(canonicalReceiptBytes.toString('utf8')), null, 2)}\n`);
    fs.writeFileSync(execution.result.receiptPath, semanticallyEquivalentBytes, { mode: 0o600 });
    assert.throws(() => verifyAdaptiveGoalSandboxReceipt({
      sandboxRoot: path.join(temp, 'sandbox-root'), receiptPath: execution.result.receiptPath,
      receiptSha256: digest(semanticallyEquivalentBytes), jobId: 'job-fixture', candidateHash: candidate.candidateHash,
      immutablePlanHash: candidate.executionPlan.plan_hash, taskId: 'task-fixture', intentHash
    }), /AGG_SANDBOX_RECEIPT_NON_CANONICAL/);
    fs.writeFileSync(execution.result.receiptPath, canonicalReceiptBytes, { mode: 0o600 });

    const extendedReceipt = JSON.parse(canonicalReceiptBytes.toString('utf8'));
    extendedReceipt.execution.fabricatedAuthority = true;
    const extendedReceiptBytes = Buffer.from(`${canonicalJson(extendedReceipt)}\n`);
    fs.writeFileSync(execution.result.receiptPath, extendedReceiptBytes, { mode: 0o600 });
    assert.throws(() => verifyAdaptiveGoalSandboxReceipt({
      sandboxRoot: path.join(temp, 'sandbox-root'), receiptPath: execution.result.receiptPath,
      receiptSha256: digest(extendedReceiptBytes), jobId: 'job-fixture', candidateHash: candidate.candidateHash,
      immutablePlanHash: candidate.executionPlan.plan_hash, taskId: 'task-fixture', intentHash
    }), /AGG_SANDBOX_RECEIPT_BINDING_MISMATCH/);
    fs.writeFileSync(execution.result.receiptPath, canonicalReceiptBytes, { mode: 0o600 });

    // Replace the receipt pathname with a symlink only after the verifier has
    // opened its descriptor. The descriptor still points to the original
    // bytes, but the pathname no longer identifies those bytes and must fail.
    const receiptPath = execution.result.receiptPath;
    const displacedReceiptPath = `${receiptPath}.race-displaced`;
    const outsideReceiptPath = path.join(temp, 'outside-receipt.json');
    fs.writeFileSync(outsideReceiptPath, canonicalReceiptBytes, { mode: 0o600 });
    const originalReadSync = fs.readSync;
    let replacedDuringRead = false;
    fs.readSync = function replaceReceiptAfterOpen(...args) {
      if (!replacedDuringRead) {
        replacedDuringRead = true;
        fs.renameSync(receiptPath, displacedReceiptPath);
        fs.symlinkSync(outsideReceiptPath, receiptPath);
      }
      return originalReadSync.apply(this, args);
    };
    try {
      assert.throws(() => verifyAdaptiveGoalSandboxReceipt({
        sandboxRoot: path.join(temp, 'sandbox-root'), receiptPath,
        receiptSha256: digest(canonicalReceiptBytes), jobId: 'job-fixture', candidateHash: candidate.candidateHash,
        immutablePlanHash: candidate.executionPlan.plan_hash, taskId: 'task-fixture', intentHash
      }), /AGG_SANDBOX_PATH_CHANGED_DURING_READ/);
    } finally {
      fs.readSync = originalReadSync;
      fs.rmSync(receiptPath, { force: true });
      if (fs.existsSync(displacedReceiptPath)) fs.renameSync(displacedReceiptPath, receiptPath);
      fs.rmSync(outsideReceiptPath, { force: true });
    }
    assert.equal(replacedDuringRead, true, 'test must replace the receipt path after descriptor open');
    assert.deepEqual(fs.readFileSync(receiptPath), canonicalReceiptBytes, 'receipt race test restores exact committed bytes');

    // The same descriptor-to-path identity check applies to every output
    // record. Replacing a verified output with a checksum-matching symlink
    // cannot be used to smuggle bytes from outside the sandbox root.
    const inputPath = path.join(path.dirname(receiptPath), 'inputs/requirements.json');
    const displacedInputPath = `${inputPath}.race-displaced`;
    const outsideInputPath = path.join(temp, 'outside-requirements.json');
    const committedInputBytes = fs.readFileSync(inputPath);
    const inputIdentity = fs.statSync(inputPath, { bigint: true });
    fs.writeFileSync(outsideInputPath, committedInputBytes, { mode: 0o600 });
    const originalInputReadSync = fs.readSync;
    let inputReplacedDuringRead = false;
    fs.readSync = function replaceOutputAfterReceiptRead(...args) {
      const descriptorIdentity = fs.fstatSync(args[0], { bigint: true });
      if (descriptorIdentity.dev === inputIdentity.dev && descriptorIdentity.ino === inputIdentity.ino && !inputReplacedDuringRead) {
        inputReplacedDuringRead = true;
        fs.renameSync(inputPath, displacedInputPath);
        fs.symlinkSync(outsideInputPath, inputPath);
      }
      return originalInputReadSync.apply(this, args);
    };
    try {
      assert.throws(() => verifyAdaptiveGoalSandboxReceipt({
        sandboxRoot: path.join(temp, 'sandbox-root'), receiptPath,
        receiptSha256: digest(canonicalReceiptBytes), jobId: 'job-fixture', candidateHash: candidate.candidateHash,
        immutablePlanHash: candidate.executionPlan.plan_hash, taskId: 'task-fixture', intentHash
      }), /AGG_SANDBOX_PATH_CHANGED_DURING_READ/);
    } finally {
      fs.readSync = originalInputReadSync;
      fs.rmSync(inputPath, { force: true });
      if (fs.existsSync(displacedInputPath)) fs.renameSync(displacedInputPath, inputPath);
      fs.rmSync(outsideInputPath, { force: true });
    }
    assert.equal(inputReplacedDuringRead, true, 'test must replace a receipt-listed output after descriptor open');
    assert.deepEqual(fs.readFileSync(inputPath), committedInputBytes, 'output race test restores exact committed bytes');

    assert.throws(() => verifyAdaptiveGoalSandboxReceipt({
      sandboxRoot: path.join(temp, 'sandbox-root'), receiptPath: execution.result.receiptPath,
      receiptSha256: execution.result.receiptSha256, jobId: 'job-other', candidateHash: candidate.candidateHash,
      immutablePlanHash: candidate.executionPlan.plan_hash, taskId: 'task-fixture', intentHash
    }), /AGG_SANDBOX_RECEIPT_BINDING_MISMATCH/,
    'a valid receipt for another job must not validate even when task/candidate/plan/intent hashes are the same');

    assert.throws(() => runAdaptiveGoalSandboxAction({
      sandboxRoot: path.join(temp, 'wrong-plan-root'), jobId: 'job-fixture', taskId: 'task-wrong-plan',
      candidateHash: candidate.candidateHash, immutablePlanHash: 'e'.repeat(64), intentHash,
      intent, planTask, candidate, taskInputSnapshots: inputs
    }), /AGG_SANDBOX_CANDIDATE_PLAN_HASH_MISMATCH/);
    assert.equal(fs.existsSync(path.join(temp, 'wrong-plan-root')), false,
      'candidate/immutable-plan hash mismatch must reject before creating a sandbox');

    const forgedContentSnapshot = snapshot('requirements', { ...requirements, scope: 'changed after durable artifact creation' });
    forgedContentSnapshot.artifactMetadata.content_hash = hashArtifactContent(requirements);
    assert.throws(() => runAdaptiveGoalSandboxAction({
      sandboxRoot: path.join(temp, 'forged-content-root'), jobId: 'job-fixture', taskId: 'task-forged-content',
      candidateHash: candidate.candidateHash, immutablePlanHash: candidate.executionPlan.plan_hash, intentHash,
      intent, planTask, candidate, taskInputSnapshots: [forgedContentSnapshot, inputs[1]]
    }), /AGG_SANDBOX_PREREQUISITE_CONTENT_HASH_MISMATCH/);
    assert.equal(fs.existsSync(path.join(temp, 'forged-content-root')), false,
      'substituted typed input content must fail its content hash before creating a sandbox');

    assert.throws(() => runAdaptiveGoalSandboxAction({
      sandboxRoot: path.join(temp, 'missing-prereq-root'), jobId: 'job-fixture', taskId: 'task-missing',
      candidateHash: candidate.candidateHash, immutablePlanHash: candidate.executionPlan.plan_hash, intentHash,
      intent, planTask, candidate, taskInputSnapshots: [inputs[0]]
    }), /AGG_SANDBOX_PREREQUISITES_MISSING/);
    assert.equal(fs.existsSync(path.join(temp, 'missing-prereq-root')), false,
      'missing prerequisites are rejected before creating any sandbox directory');

    const mismatchedArchitecture = snapshot('architecture', { ...architecture, implementation_boundary: 'production executor permitted' });
    assert.throws(() => runAdaptiveGoalSandboxAction({
      sandboxRoot: path.join(temp, 'wrong-scope-root'), jobId: 'job-fixture', taskId: 'task-wrong-scope',
      candidateHash: candidate.candidateHash, immutablePlanHash: candidate.executionPlan.plan_hash, intentHash,
      intent, planTask, candidate, taskInputSnapshots: [inputs[0], mismatchedArchitecture]
    }), /AGG_SANDBOX_ACTION_SCOPE_NOT_ALLOWLISTED/);
    assert.equal(fs.existsSync(path.join(temp, 'wrong-scope-root')), false,
      'out-of-scope artifacts are rejected before any action directory is created');

    const unsupported = { ...intent, operation: 'other' };
    assert.throws(() => runAdaptiveGoalSandboxAction({
      sandboxRoot: path.join(temp, 'unsupported-root'), jobId: 'job-fixture', taskId: 'task-unsupported',
      candidateHash: candidate.candidateHash, immutablePlanHash: candidate.executionPlan.plan_hash,
      intentHash: digest(canonicalJson(unsupported)),
      intent: unsupported, planTask, candidate, taskInputSnapshots: inputs
    }), /AGG_SANDBOX_ACTION_NOT_ALLOWLISTED/);
    assert.equal(fs.existsSync(path.join(temp, 'unsupported-root')), false);

    assert.throws(() => runAdaptiveGoalSandboxAction({
      sandboxRoot: path.join(temp, 'timeout-root'), jobId: 'job-fixture', taskId: 'task-timeout',
      candidateHash: candidate.candidateHash, immutablePlanHash: candidate.executionPlan.plan_hash, intentHash,
      intent, planTask, candidate, taskInputSnapshots: inputs, testOnlyTimeoutMs: 1
    }), /AGG_SANDBOX_ACTION_FAILED/);
    assert.equal(fs.readdirSync(path.join(temp, 'timeout-root')).length, 0,
      'timed-out fixture subprocess must be failed closed and its entire sandbox removed');

    const receiptBytes = fs.readFileSync(execution.result.receiptPath);
    const emptyLineage = JSON.parse(receiptBytes.toString('utf8'));
    emptyLineage.prerequisites[0].artifactId = '';
    const emptyLineageBytes = Buffer.from(`${canonicalJson(emptyLineage)}\n`);
    fs.writeFileSync(execution.result.receiptPath, emptyLineageBytes, { mode: 0o600 });
    assert.throws(() => verifyAdaptiveGoalSandboxReceipt({
      sandboxRoot: path.join(temp, 'sandbox-root'), receiptPath: execution.result.receiptPath,
      receiptSha256: digest(emptyLineageBytes), jobId: 'job-fixture', candidateHash: candidate.candidateHash,
      immutablePlanHash: candidate.executionPlan.plan_hash, taskId: 'task-fixture', intentHash
    }), /AGG_SANDBOX_RECEIPT_INVALID/,
    'non-empty receipt hash cannot make an empty artifact lineage identifier valid');
    fs.writeFileSync(execution.result.receiptPath, receiptBytes, { mode: 0o600 });

    const receiptContent = JSON.parse(receiptBytes.toString('utf8'));
    receiptContent.files.pop();
    const malformedReceipt = `${canonicalJson(receiptContent)}\n`;
    fs.writeFileSync(execution.result.receiptPath, malformedReceipt, { mode: 0o600 });
    assert.throws(() => verifyAdaptiveGoalSandboxReceipt({
      sandboxRoot: path.join(temp, 'sandbox-root'), receiptPath: execution.result.receiptPath,
      receiptSha256: digest(malformedReceipt), jobId: 'job-fixture', candidateHash: candidate.candidateHash,
      immutablePlanHash: candidate.executionPlan.plan_hash, taskId: 'task-fixture', intentHash
    }), /AGG_SANDBOX_RECEIPT_BINDING_MISMATCH/);
    fs.writeFileSync(execution.result.receiptPath, receiptBytes, { mode: 0o600 });
  } finally {
    if (priorEnv.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorEnv.nodeEnv;
    if (priorEnv.mode === undefined) delete process.env.AGG_SANDBOX_EXECUTOR_MODE; else process.env.AGG_SANDBOX_EXECUTOR_MODE = priorEnv.mode;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
