import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hashArtifactContent } from './workflow/artifacts.js';
import { canonicalJson } from './workflow/plan.js';

export const ADAPTIVE_GOAL_SANDBOX_ACTION_ID = 'implement-fixture-validator-v1';
export const ADAPTIVE_GOAL_SANDBOX_ACTION_CLAIMED_EVENT = 'adaptive_goal.sandbox_action_claimed';
export const ADAPTIVE_GOAL_SANDBOX_ACTION_COMPLETED_EVENT = 'adaptive_goal.sandbox_action_completed';
export const ADAPTIVE_GOAL_SANDBOX_ACTION_FAILED_EVENT = 'adaptive_goal.sandbox_action_failed';

const SHA256 = /^[a-f0-9]{64}$/;
const REQUIRED_EVIDENCE = Object.freeze(['architecture', 'requirements']);
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_TOTAL_INPUT_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const ACTION_TIMEOUT_MS = 5000;

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function isCanonicalIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function hasExactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

const RECEIPT_FILE_PATHS = Object.freeze([
  'inputs/requirements.json', 'inputs/architecture.json', 'src/validator.mjs', 'test/validator.test.mjs'
]);
const RECEIPT_KEYS = Object.freeze([
  'schemaVersion', 'actionId', 'jobId', 'taskId', 'candidateHash', 'immutablePlanHash', 'intentHash',
  'startedAt', 'executor', 'sandboxDirectoryName', 'timeoutMs', 'resourceLimits', 'prerequisites', 'files', 'execution'
]);

export function assertAdaptiveGoalSandboxExecutorEnabled({ nodeEnv = process.env.NODE_ENV, mode = process.env.AGG_SANDBOX_EXECUTOR_MODE } = {}) {
  if (nodeEnv !== 'test' || mode !== 'fixture') {
    fail('AGG_SANDBOX_EXECUTOR_TEST_ONLY', 'the experimental AGG executor is restricted to NODE_ENV=test with AGG_SANDBOX_EXECUTOR_MODE=fixture; test identity or fixture evidence cannot authorize production actions');
  }
  return true;
}

function assertPrivateSandboxRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('AGG_SANDBOX_ROOT_INVALID', 'sandbox root must be an explicit absolute test-owned directory');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== path.resolve(root)) {
    fail('AGG_SANDBOX_ROOT_INVALID', 'sandbox root must be a canonical, non-symlink real directory');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    fail('AGG_SANDBOX_ROOT_NOT_PRIVATE', 'sandbox root must have no group/world permissions');
  }
  return fs.realpathSync(root);
}

function safeWrite(root, relativePath, bytes) {
  const destination = path.resolve(root, relativePath);
  if (!destination.startsWith(`${root}${path.sep}`)) fail('AGG_SANDBOX_PATH_ESCAPE', 'sandbox file path escaped the isolated root');
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(parent) !== parent || fs.lstatSync(parent).isSymbolicLink()) {
    fail('AGG_SANDBOX_PATH_SYMLINK', 'sandbox write parent resolved through a symlink');
  }
  const fd = fs.openSync(destination, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); }
  const stat = fs.lstatSync(destination);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(destination) !== destination) {
    fail('AGG_SANDBOX_OUTPUT_INVALID', 'sandbox output is not a canonical regular file');
  }
  return { path: relativePath, bytes: stat.size, sha256: sha256(fs.readFileSync(destination)) };
}

function assertSafeSandboxPath(root, absolutePath, expectedType) {
  const relative = path.relative(root, absolutePath);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    fail('AGG_SANDBOX_PATH_ESCAPE', 'sandbox path is not a strict descendant of the canonical root');
  }
  let current = root;
  const parts = relative.split(path.sep);
  for (let index = 0; index < parts.length; index++) {
    if (!parts[index] || parts[index] === '.' || parts[index] === '..') fail('AGG_SANDBOX_PATH_INVALID', 'sandbox path contains an unsafe segment');
    current = path.join(current, parts[index]);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || fs.realpathSync(current) !== current) {
      fail('AGG_SANDBOX_PATH_INVALID', 'sandbox path is missing, symlinked, or not canonical');
    }
    const isLast = index === parts.length - 1;
    if (isLast ? (expectedType === 'file' ? !stat.isFile() : !stat.isDirectory()) : !stat.isDirectory()) {
      fail('AGG_SANDBOX_PATH_INVALID', 'sandbox path component has the wrong filesystem type');
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      fail('AGG_SANDBOX_PATH_NOT_PRIVATE', 'sandbox path component grants group/world permissions');
    }
  }
  return fs.lstatSync(absolutePath);
}

// Read the bytes from one verified descriptor, not a second pathname lookup.
// A prior lstat/realpath check alone does not prevent a file from being
// replaced with a symlink or a different inode between validation and read.
function readStableSandboxFile(absolutePath, { maxBytes = MAX_OUTPUT_BYTES, expectedNlink = 1 } = {}) {
  const beforePath = fs.lstatSync(absolutePath, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== BigInt(expectedNlink) ||
      fs.realpathSync(absolutePath) !== absolutePath || beforePath.size > BigInt(maxBytes)) {
    fail('AGG_SANDBOX_PATH_INVALID', 'sandbox file must be a canonical bounded regular file with the expected link count');
  }
  const fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.dev !== beforePath.dev || before.ino !== beforePath.ino ||
        before.nlink !== BigInt(expectedNlink) || before.size !== beforePath.size) {
      fail('AGG_SANDBOX_PATH_CHANGED_DURING_READ', 'sandbox file identity changed before descriptor read');
    }
    const buffer = Buffer.allocUnsafe(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const bytes = buffer.subarray(0, offset);
    const after = fs.fstatSync(fd, { bigint: true });
    const afterPath = fs.lstatSync(absolutePath, { bigint: true });
    if (bytes.length > maxBytes || !after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino ||
        after.nlink !== BigInt(expectedNlink) || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs ||
        !afterPath.isFile() || afterPath.isSymbolicLink() || afterPath.dev !== before.dev || afterPath.ino !== before.ino ||
        afterPath.nlink !== BigInt(expectedNlink) || afterPath.size !== before.size || afterPath.mtimeNs !== before.mtimeNs ||
        afterPath.ctimeNs !== before.ctimeNs || fs.realpathSync(absolutePath) !== absolutePath) {
      fail('AGG_SANDBOX_PATH_CHANGED_DURING_READ', 'sandbox file identity or metadata changed during descriptor read');
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}

function validateIntentEnvelope(intent, planTask, candidate) {
  if (!isRecord(intent) || intent.operation !== 'implement' || intent.role !== 'engineer' ||
      intent.role_contract_id !== 'agent.engineer' || intent.role_contract_version !== 1 ||
      intent.task_id !== planTask.id || intent.target?.kind !== 'work_item' ||
      typeof intent.target?.reference !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(intent.target.reference) ||
      intent.semantic_verification?.policy_version !== 1 ||
      intent.source?.reviewed_task_input_contract_hash !== candidate.hashes?.reviewedTaskInputContractHash ||
      !Array.isArray(intent.success_criteria) || intent.success_criteria.length !== 3 ||
      !['approved_scope_implemented', 'implementation_evidence_recorded', 'tests_or_verification_run'].every(item => intent.success_criteria.includes(item))) {
    fail('AGG_SANDBOX_ACTION_NOT_ALLOWLISTED', 'only the exact typed engineer implementation fixture with its candidate-bound semantic/input hashes can use this experimental executor');
  }
}

function validateTaskInputSnapshots(snapshots, intent) {
  if (!Array.isArray(snapshots) || snapshots.length !== REQUIRED_EVIDENCE.length) {
    fail('AGG_SANDBOX_PREREQUISITES_MISSING', 'the sandbox fixture requires exactly the typed requirements and architecture inputs');
  }
  const byType = new Map(snapshots.map(item => [item.inputType, item]));
  if (byType.size !== 2 || REQUIRED_EVIDENCE.some(type => !byType.has(type))) {
    fail('AGG_SANDBOX_PREREQUISITES_MISSING', 'requirements and architecture must both be present exactly once');
  }
  const result = [];
  let totalBytes = 0;
  for (const type of REQUIRED_EVIDENCE) {
    const snapshot = byType.get(type);
    if (snapshot.kind !== 'evidence' || !isRecord(snapshot.content) || !isRecord(snapshot.artifactMetadata) ||
        snapshot.artifactMetadata.type !== type || typeof snapshot.artifactMetadata.job_id !== 'string' || !snapshot.artifactMetadata.job_id ||
        typeof snapshot.artifactMetadata.artifact_id !== 'string' ||
        !SHA256.test(snapshot.artifactMetadata.content_hash || '') || snapshot.artifactMetadata.schema_version !== 1 ||
        typeof snapshot.artifactMetadata.artifact_created_event_id !== 'string' ||
        !snapshot.artifactMetadata.artifact_created_event_id ||
        typeof snapshot.artifactMetadata.producer_role !== 'string' || !snapshot.artifactMetadata.producer_role ||
        typeof snapshot.artifactMetadata.producer_task_id !== 'string' || !snapshot.artifactMetadata.producer_task_id ||
        typeof snapshot.artifactMetadata.producer_result_id !== 'string' ||
        !snapshot.artifactMetadata.producer_result_id || typeof snapshot.artifactMetadata.producer_completion_event_id !== 'string' ||
        !snapshot.artifactMetadata.producer_completion_event_id) {
      fail('AGG_SANDBOX_PREREQUISITE_LINEAGE_INVALID', `required ${type} input lacks durable, typed source lineage`);
    }
    let contentHash;
    try { contentHash = hashArtifactContent(snapshot.content); }
    catch { fail('AGG_SANDBOX_PREREQUISITE_CONTENT_INVALID', `required ${type} input is not valid plain JSON artifact content`); }
    if (contentHash !== snapshot.artifactMetadata.content_hash) {
      fail('AGG_SANDBOX_PREREQUISITE_CONTENT_HASH_MISMATCH', `required ${type} content does not match its durable artifact content_hash`);
    }
    const serialized = JSON.stringify(snapshot.content);
    const size = Buffer.byteLength(serialized, 'utf8');
    if (size > MAX_INPUT_BYTES || totalBytes + size > MAX_TOTAL_INPUT_BYTES) {
      fail('AGG_SANDBOX_INPUT_LIMIT_EXCEEDED', 'typed prerequisites exceed the 64 KiB/item or 128 KiB total sandbox input limit');
    }
    totalBytes += size;
    result.push({
      type,
      content: snapshot.content,
      contentBytes: size,
      artifactId: snapshot.artifactMetadata.artifact_id,
      sourceJobId: snapshot.artifactMetadata.job_id,
      contentHash: snapshot.artifactMetadata.content_hash,
      artifactCreatedEventId: snapshot.artifactMetadata.artifact_created_event_id,
      producerRole: snapshot.artifactMetadata.producer_role,
      producerTaskId: snapshot.artifactMetadata.producer_task_id,
      producerResultId: snapshot.artifactMetadata.producer_result_id,
      producerCompletionEventId: snapshot.artifactMetadata.producer_completion_event_id
    });
  }
  const requirements = result.find(item => item.type === 'requirements')?.content;
  const architecture = result.find(item => item.type === 'architecture')?.content;
  if (requirements?.scope !== 'bounded test fixture' ||
      !Array.isArray(requirements.acceptance_criteria) || !requirements.acceptance_criteria.includes('artifact content validated') ||
      !Array.isArray(architecture?.interfaces) || !architecture.interfaces.includes('read-only MCP proposal API') ||
      !Array.isArray(architecture?.failure_modes) || !architecture.failure_modes.includes('stale artifact evidence') ||
      typeof architecture?.implementation_boundary !== 'string' || !architecture.implementation_boundary.includes('fixture only')) {
    fail('AGG_SANDBOX_ACTION_SCOPE_NOT_ALLOWLISTED', 'durable requirements/architecture artifacts do not authorize this exact no-network fixture-validation action');
  }
  const bindings = intent.task_input_bindings;
  if (!Array.isArray(bindings) || bindings.length !== 2 || REQUIRED_EVIDENCE.some(type => !bindings.some(item => item.input_type === type && item.source?.kind === 'evidence'))) {
    fail('AGG_SANDBOX_PREREQUISITE_BINDING_MISMATCH', 'the immutable action intent does not bind both verified prerequisite artifact types');
  }
  return result;
}

const VALIDATOR_SOURCE = `
function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function stringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.trim().length > 0);
}
export function validatePrerequisiteBundle(requirements, architecture) {
  if (!exactKeys(requirements, ['scope', 'acceptance_criteria', 'non_goals']) ||
      typeof requirements.scope !== 'string' || !requirements.scope.trim() ||
      !stringArray(requirements.acceptance_criteria) || !stringArray(requirements.non_goals)) {
    throw new TypeError('requirements prerequisite does not match the closed typed contract');
  }
  if (!exactKeys(architecture, ['components', 'interfaces', 'failure_modes', 'implementation_boundary']) ||
      !stringArray(architecture.components) || !stringArray(architecture.interfaces) ||
      !stringArray(architecture.failure_modes) || typeof architecture.implementation_boundary !== 'string' ||
      !architecture.implementation_boundary.trim()) {
    throw new TypeError('architecture prerequisite does not match the closed typed contract');
  }
  return Object.freeze({ requirementsAccepted: true, architectureAccepted: true, inputTypes: ['architecture', 'requirements'] });
}
`;

const VALIDATOR_TEST_SOURCE = `
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const fixtureModuleSpecifier = ['..', 'src', 'validator.mjs'].join('/');
const { validatePrerequisiteBundle } = await import(fixtureModuleSpecifier);
const requirements = JSON.parse(fs.readFileSync('inputs/requirements.json', 'utf8'));
const architecture = JSON.parse(fs.readFileSync('inputs/architecture.json', 'utf8'));
test('accepts the exact source requirements and architecture contracts', () => {
  assert.ok(process.permission, 'fixture process must enable the Node.js permission model');
  assert.equal(process.permission.has('fs.read', '/etc/passwd'), false, 'fixture process must not read arbitrary host files');
  assert.equal(process.permission.has('fs.write', '/tmp/agg-sandbox-outside-probe.txt'), false,
    'fixture process must not write outside its sandbox root');
  assert.equal(process.permission.has('child'), false, 'fixture process must not spawn arbitrary child processes');
  assert.equal(process.permission.has('addon'), false, 'fixture process must not load native addons');
  assert.equal(process.permission.has('worker'), false, 'the fixture must not be permitted to create worker threads');
  assert.deepEqual(validatePrerequisiteBundle(requirements, architecture), {
    requirementsAccepted: true, architectureAccepted: true, inputTypes: ['architecture', 'requirements']
  });
});
test('rejects a missing requirements acceptance criterion', () => {
  const invalid = { ...requirements, acceptance_criteria: [] };
  assert.throws(() => validatePrerequisiteBundle(invalid, architecture), /requirements prerequisite/);
});
test('rejects malformed architecture and does not interpret strings as instructions', () => {
  const invalid = { ...architecture, unexpected_command: 'touch outside-sandbox' };
  assert.throws(() => validatePrerequisiteBundle(requirements, invalid), /architecture prerequisite/);
  assert.equal(requirements.scope.includes('touch outside-sandbox'), false);
});
`;

export const ADAPTIVE_GOAL_SANDBOX_IMPLEMENTATION_FILES = Object.freeze({
  'src/validator.mjs': VALIDATOR_SOURCE.trimStart(),
  'test/validator.test.mjs': VALIDATOR_TEST_SOURCE.trimStart()
});

export function runAdaptiveGoalSandboxAction({ sandboxRoot, jobId, taskId, candidateHash, immutablePlanHash, intentHash, intent, planTask, candidate, taskInputSnapshots, now = Date.now(), testOnlyTimeoutMs = undefined, testOnlyOutputLimitBytes = undefined }) {
  assertAdaptiveGoalSandboxExecutorEnabled();
  if (![jobId, taskId].every(value => typeof value === 'string' && value.length > 0) ||
      !SHA256.test(candidateHash || '') || !SHA256.test(immutablePlanHash || '') || !SHA256.test(intentHash || '')) {
    fail('AGG_SANDBOX_CONTRACT_INVALID', 'job/task IDs and current candidate/plan/intent SHA-256 bindings are required');
  }
  if (candidate?.candidateHash !== candidateHash || candidate?.executionPlan?.plan_hash !== immutablePlanHash ||
      candidate?.compiler?.compilerPlanHash !== immutablePlanHash) {
    fail('AGG_SANDBOX_CANDIDATE_PLAN_HASH_MISMATCH', 'executor inputs do not match the candidate and compiler-bound immutable plan hashes');
  }
  if (sha256(canonicalJson(intent)) !== intentHash) {
    fail('AGG_SANDBOX_INTENT_HASH_MISMATCH', 'executor action intent bytes do not match the supplied canonical intent hash');
  }
  if ((testOnlyTimeoutMs !== undefined || testOnlyOutputLimitBytes !== undefined) &&
      (process.env.NODE_ENV !== 'test' || process.env.AGG_SANDBOX_EXECUTOR_MODE !== 'fixture')) {
    fail('AGG_SANDBOX_TEST_OVERRIDE_FORBIDDEN', 'test-only timeout/output overrides are forbidden outside isolated fixture mode');
  }
  const timeoutMs = testOnlyTimeoutMs ?? ACTION_TIMEOUT_MS;
  const outputLimitBytes = testOnlyOutputLimitBytes ?? MAX_OUTPUT_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > ACTION_TIMEOUT_MS ||
      !Number.isInteger(outputLimitBytes) || outputLimitBytes < 1024 || outputLimitBytes > MAX_OUTPUT_BYTES) {
    fail('AGG_SANDBOX_RESOURCE_LIMIT_INVALID', 'fixture timeout/output overrides exceed the declared test-only resource envelope');
  }
  validateIntentEnvelope(intent, planTask, candidate);
  const prerequisites = validateTaskInputSnapshots(taskInputSnapshots, intent);
  const root = assertPrivateSandboxRoot(sandboxRoot);
  const sandboxPath = fs.mkdtempSync(path.join(root, 'agg-action-'));
  fs.chmodSync(sandboxPath, 0o700);
  const sandbox = fs.realpathSync(sandboxPath);
  if (!sandbox.startsWith(`${root}${path.sep}`) || fs.lstatSync(sandbox).isSymbolicLink()) {
    fs.rmSync(sandboxPath, { recursive: true, force: true });
    fail('AGG_SANDBOX_PATH_ESCAPE', 'per-action sandbox did not resolve beneath the configured isolated root');
  }
  try {
    const fileRecords = [];
    for (const input of prerequisites) {
      fileRecords.push(safeWrite(sandbox, `inputs/${input.type}.json`, `${JSON.stringify(input.content)}\n`));
    }
    for (const [relativePath, source] of Object.entries(ADAPTIVE_GOAL_SANDBOX_IMPLEMENTATION_FILES)) {
      fileRecords.push(safeWrite(sandbox, relativePath, source));
    }
    const tmp = path.join(sandbox, 'tmp');
    fs.mkdirSync(tmp, { mode: 0o700 });
    const start = process.hrtime.bigint();
    const execution = spawnSync(process.execPath, [
      '--permission',
      `--allow-fs-read=${sandbox}`,
      `--allow-fs-write=${sandbox}`,
      path.join(sandbox, 'test/validator.test.mjs')
    ], {
      cwd: sandbox,
      env: {
        PATH: path.dirname(process.execPath),
        HOME: sandbox,
        TMPDIR: tmp,
        TEMP: tmp,
        TMP: tmp,
        NODE_ENV: 'test',
        NO_COLOR: '1',
        ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {})
      },
      shell: false,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: outputLimitBytes,
      encoding: 'utf8'
    });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const stdout = String(execution.stdout || '').slice(0, 24 * 1024);
    const stderr = String(execution.stderr || '').slice(0, 8 * 1024);
    if (execution.error || execution.status !== 0 || execution.signal) {
      fail('AGG_SANDBOX_ACTION_FAILED', `isolated fixture validation failed (exit=${execution.status ?? 'null'}, signal=${execution.signal || 'none'}, timeout=${execution.error?.code === 'ETIMEDOUT'}); ${stderr.slice(0, 1000)}`);
    }
    const passMatch = stdout.match(/(?:#|ℹ) pass (\d+)\b/u);
    const failMatch = stdout.match(/(?:#|ℹ) fail (\d+)\b/u);
    const testsPassed = passMatch ? Number(passMatch[1]) : 0;
    if (testsPassed !== 3 || !failMatch || Number(failMatch[1]) !== 0) {
      fail('AGG_SANDBOX_TEST_RESULT_INVALID', `the sandbox did not produce the exact three-test success contract: pass=${passMatch?.[1] || 'missing'}, fail=${failMatch?.[1] || 'missing'}, stdout=${stdout.slice(-2000)}`);
    }
    const prerequisiteRecords = prerequisites.map(item => ({
      type: item.type, sourceJobId: item.sourceJobId, artifactId: item.artifactId,
      contentHash: item.contentHash, artifactCreatedEventId: item.artifactCreatedEventId,
      producerRole: item.producerRole, producerTaskId: item.producerTaskId,
      producerResultId: item.producerResultId, producerCompletionEventId: item.producerCompletionEventId
    }));
    const receipt = {
      schemaVersion: 1,
      actionId: ADAPTIVE_GOAL_SANDBOX_ACTION_ID,
      jobId, taskId, candidateHash, immutablePlanHash, intentHash,
      startedAt: new Date(now).toISOString(),
      executor: 'isolated-node-test-fixture',
      sandboxDirectoryName: path.basename(sandbox),
      timeoutMs,
      resourceLimits: { maxInputBytesPerArtifact: MAX_INPUT_BYTES, maxInputBytesTotal: MAX_TOTAL_INPUT_BYTES, maxOutputBytes: outputLimitBytes },
      prerequisites: prerequisiteRecords,
      files: fileRecords,
      execution: { exitCode: execution.status, signal: execution.signal || null, elapsedMs: Number(elapsedMs.toFixed(4)), testsPassed, testsFailed: 0,
        nodePermissionModelEnabled: true, filesystemReadRoot: sandbox, filesystemWriteRoot: sandbox,
        childProcessAllowed: false, addonsAllowed: false, workersAllowedForTestHarness: false,
        networkPermissionEnforced: false, osCpuMemoryQuotaEnforced: false,
        stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr), stdoutPreview: stdout.slice(0, 4000), stderrPreview: stderr.slice(0, 1000) }
    };
    const receiptRecord = safeWrite(sandbox, 'receipt.json', `${canonicalJson(receipt)}\n`);
    const receiptBytes = fs.readFileSync(path.join(sandbox, 'receipt.json'));
    const result = {
      actionId: ADAPTIVE_GOAL_SANDBOX_ACTION_ID,
      sandboxDirectoryName: path.basename(sandbox),
      receiptPath: path.join(sandbox, 'receipt.json'),
      receiptSha256: sha256(receiptBytes),
      files: [...fileRecords, receiptRecord],
      prerequisites: prerequisiteRecords,
      elapsedMs: Number(elapsedMs.toFixed(4)),
      testsPassed,
      stdoutPreview: stdout.slice(0, 4000)
    };
    return {
      result,
      artifact: {
        summary: 'Executed the approved AGG implementation fixture in an isolated temporary sandbox; the generated validator consumed only typed requirements and architecture inputs.',
        files_changed: fileRecords.map(item => item.path).filter(item => item.startsWith('src/')),
        verification: ['isolated Node.js test runner exited with code 0', '3 fixture tests passed, including malformed prerequisite rejection', 'no shell, network client, repository path or arbitrary executable arguments were accepted'],
        execution: {
          mode: 'chat-on-steroids-local-tools', exit_code: null, session_id: null,
          evidence_refs: [
            `agg-sandbox:${candidateHash}`,
            `agg-sandbox-receipt:${result.receiptSha256}`,
            ...prerequisiteRecords.map(item => `artifact://${item.artifactId}`)
          ],
          executor: 'agg-fixture-sandbox-v1', status: 'success', action_id: result.actionId,
          sandbox_directory_name: result.sandboxDirectoryName, receipt_sha256: result.receiptSha256,
          node_permission_model_enabled: true, filesystem_access_confined_to_sandbox: true,
          child_process_allowed: false, addons_allowed: false, worker_threads_allowed: false, network_permission_enforced: false,
          os_cpu_memory_quota_enforced: false,
          candidate_hash: candidateHash, immutable_plan_hash: immutablePlanHash, action_intent_hash: intentHash,
          elapsed_ms: result.elapsedMs, tests_passed: testsPassed, tests_failed: 0,
          prerequisite_artifacts: prerequisiteRecords
        }
      }
    };
  } catch (error) {
    // This executor's allowlisted action has no intended external side effects.
    // If it fails before a valid receipt is returned, remove the entire private
    // per-action sandbox and fail closed; a durable claim prevents blind replay.
    let sandboxCleanupStatus = 'removed';
    try {
      fs.rmSync(sandboxPath, { recursive: true, force: true, maxRetries: 1 });
      if (fs.existsSync(sandboxPath)) sandboxCleanupStatus = 'cleanup_unconfirmed';
    } catch { sandboxCleanupStatus = 'cleanup_failed'; }
    error.sandboxCleanupStatus = sandboxCleanupStatus;
    error.sandboxDirectoryName = path.basename(sandboxPath);
    throw error;
  }
}

export function verifyAdaptiveGoalSandboxReceipt({ sandboxRoot, receiptPath, receiptSha256, jobId, candidateHash, immutablePlanHash, taskId, intentHash }) {
  const root = assertPrivateSandboxRoot(sandboxRoot);
  if (typeof jobId !== 'string' || !jobId.trim() || typeof receiptPath !== 'string' || !path.isAbsolute(receiptPath) ||
      !receiptPath.startsWith(`${root}${path.sep}`) || !SHA256.test(receiptSha256 || '')) {
    fail('AGG_SANDBOX_RECEIPT_INVALID', 'stored sandbox receipt job/path/hash is not bound beneath the isolated root');
  }
  const directory = path.dirname(receiptPath);
  if (path.basename(receiptPath) !== 'receipt.json' || path.dirname(directory) !== root ||
      !/^agg-action-[A-Za-z0-9_-]+$/.test(path.basename(directory))) {
    fail('AGG_SANDBOX_RECEIPT_INVALID', 'receipt must be receipt.json directly within one generated action directory beneath the canonical root');
  }
  assertSafeSandboxPath(root, directory, 'directory');
  const file = assertSafeSandboxPath(root, receiptPath, 'file');
  if (file.nlink !== 1) fail('AGG_SANDBOX_RECEIPT_INVALID', 'receipt must be a singly linked regular file');
  const bytes = readStableSandboxFile(receiptPath);
  if (bytes.length > MAX_OUTPUT_BYTES || sha256(bytes) !== receiptSha256) fail('AGG_SANDBOX_RECEIPT_HASH_MISMATCH', 'stored sandbox receipt bytes no longer match the completion ledger');
  let receipt;
  try { receipt = JSON.parse(bytes.toString('utf8')); } catch { fail('AGG_SANDBOX_RECEIPT_MALFORMED', 'stored sandbox receipt is invalid JSON'); }
  if (!Buffer.from(`${canonicalJson(receipt)}\n`).equals(bytes)) {
    fail('AGG_SANDBOX_RECEIPT_NON_CANONICAL', 'stored sandbox receipt must use the exact canonical JSON encoding and terminal newline');
  }
  if (!isRecord(receipt) || Object.keys(receipt).sort().join('\0') !== [...RECEIPT_KEYS].sort().join('\0') ||
      receipt.schemaVersion !== 1 || receipt.actionId !== ADAPTIVE_GOAL_SANDBOX_ACTION_ID ||
      receipt.jobId !== jobId || receipt.taskId !== taskId || receipt.candidateHash !== candidateHash ||
      receipt.immutablePlanHash !== immutablePlanHash || receipt.intentHash !== intentHash ||
      receipt.sandboxDirectoryName !== path.basename(directory) ||
      !isCanonicalIsoTimestamp(receipt.startedAt) || receipt.executor !== 'isolated-node-test-fixture' ||
      !Number.isInteger(receipt.timeoutMs) || receipt.timeoutMs < 1 || receipt.timeoutMs > ACTION_TIMEOUT_MS ||
      !hasExactKeys(receipt.resourceLimits, ['maxInputBytesPerArtifact', 'maxInputBytesTotal', 'maxOutputBytes']) || receipt.resourceLimits.maxInputBytesPerArtifact !== MAX_INPUT_BYTES ||
      receipt.resourceLimits.maxInputBytesTotal !== MAX_TOTAL_INPUT_BYTES ||
      !Number.isInteger(receipt.resourceLimits.maxOutputBytes) || receipt.resourceLimits.maxOutputBytes < 1024 || receipt.resourceLimits.maxOutputBytes > MAX_OUTPUT_BYTES ||
      !hasExactKeys(receipt.execution, ['exitCode', 'signal', 'elapsedMs', 'testsPassed', 'testsFailed', 'nodePermissionModelEnabled', 'filesystemReadRoot', 'filesystemWriteRoot', 'childProcessAllowed', 'addonsAllowed', 'workersAllowedForTestHarness', 'networkPermissionEnforced', 'osCpuMemoryQuotaEnforced', 'stdoutSha256', 'stderrSha256', 'stdoutPreview', 'stderrPreview']) ||
      receipt.execution?.exitCode !== 0 || receipt.execution?.signal !== null ||
      !Number.isFinite(receipt.execution?.elapsedMs) || receipt.execution.elapsedMs < 0 ||
      receipt.execution?.testsPassed !== 3 || receipt.execution?.testsFailed !== 0 ||
      receipt.execution?.nodePermissionModelEnabled !== true || receipt.execution?.filesystemReadRoot !== directory ||
      receipt.execution?.filesystemWriteRoot !== directory || receipt.execution?.childProcessAllowed !== false ||
      receipt.execution?.addonsAllowed !== false || receipt.execution?.workersAllowedForTestHarness !== false ||
      receipt.execution?.networkPermissionEnforced !== false || receipt.execution?.osCpuMemoryQuotaEnforced !== false ||
      !SHA256.test(receipt.execution?.stdoutSha256 || '') || !SHA256.test(receipt.execution?.stderrSha256 || '') ||
      !Array.isArray(receipt.prerequisites) || receipt.prerequisites.length !== REQUIRED_EVIDENCE.length ||
      !Array.isArray(receipt.files) || receipt.files.length !== RECEIPT_FILE_PATHS.length) {
    fail('AGG_SANDBOX_RECEIPT_BINDING_MISMATCH', 'stored sandbox receipt is not bound to the exact task/candidate/plan/intent success contract');
  }
  const expectedPaths = new Set(RECEIPT_FILE_PATHS);
  const seenPaths = new Set();
  const fileBytesByPath = new Map();
  let totalInputPayloadBytes = 0;
  for (const item of receipt.files) {
    if (!hasExactKeys(item, ['path', 'bytes', 'sha256']) || typeof item.path !== 'string' || !expectedPaths.has(item.path) || seenPaths.has(item.path) ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 1 || !SHA256.test(item.sha256 || '')) {
      fail('AGG_SANDBOX_RECEIPT_INVALID', 'receipt file entries must use the exact unique allowlisted paths, byte lengths and SHA-256 fields');
    }
    seenPaths.add(item.path);
    const full = path.resolve(directory, item.path);
    const stat = assertSafeSandboxPath(root, full, 'file');
    const maxBytes = item.path.startsWith('inputs/') ? MAX_INPUT_BYTES + 1 : MAX_OUTPUT_BYTES;
    if (stat.nlink !== 1 || stat.size !== item.bytes || stat.size > maxBytes) {
      fail('AGG_SANDBOX_OUTPUT_SIZE_MISMATCH', `sandbox output byte length changed after completion: ${item.path}`);
    }
    const content = readStableSandboxFile(full, { maxBytes });
    if (sha256(content) !== item.sha256) {
      fail('AGG_SANDBOX_OUTPUT_HASH_MISMATCH', `sandbox output changed after completion: ${item.path}`);
    }
    fileBytesByPath.set(item.path, content);
  }
  if (seenPaths.size !== expectedPaths.size || [...expectedPaths].some(item => !seenPaths.has(item))) {
    fail('AGG_SANDBOX_RECEIPT_INVALID', 'receipt omitted one or more mandatory fixture files');
  }
  for (const [relativePath, source] of Object.entries(ADAPTIVE_GOAL_SANDBOX_IMPLEMENTATION_FILES)) {
    if (!fileBytesByPath.get(relativePath)?.equals(Buffer.from(source))) {
      fail('AGG_SANDBOX_IMPLEMENTATION_BYTES_MISMATCH', `stored allowlisted implementation bytes are not the exact pinned fixture source: ${relativePath}`);
    }
  }
  const prerequisiteTypes = new Set();
  for (const prerequisite of receipt.prerequisites) {
    if (!hasExactKeys(prerequisite, ['type', 'sourceJobId', 'artifactId', 'contentHash', 'artifactCreatedEventId', 'producerRole', 'producerTaskId', 'producerResultId', 'producerCompletionEventId']) || !REQUIRED_EVIDENCE.includes(prerequisite.type) || prerequisiteTypes.has(prerequisite.type) ||
        !SHA256.test(prerequisite.contentHash || '') || typeof prerequisite.artifactId !== 'string' || !prerequisite.artifactId.trim() ||
        typeof prerequisite.sourceJobId !== 'string' || !prerequisite.sourceJobId.trim() ||
        typeof prerequisite.artifactCreatedEventId !== 'string' || !prerequisite.artifactCreatedEventId.trim() ||
        typeof prerequisite.producerRole !== 'string' || !prerequisite.producerRole.trim() ||
        typeof prerequisite.producerTaskId !== 'string' || !prerequisite.producerTaskId.trim() ||
        typeof prerequisite.producerResultId !== 'string' || !prerequisite.producerResultId.trim() ||
        typeof prerequisite.producerCompletionEventId !== 'string' || !prerequisite.producerCompletionEventId.trim()) {
      fail('AGG_SANDBOX_RECEIPT_INVALID', 'receipt prerequisites must contain unique, typed, provenance-bound artifact records');
    }
    prerequisiteTypes.add(prerequisite.type);
    const pathForType = `inputs/${prerequisite.type}.json`;
    let content;
    try { content = JSON.parse(fileBytesByPath.get(pathForType).toString('utf8')); }
    catch { fail('AGG_SANDBOX_PREREQUISITE_CONTENT_INVALID', `stored ${prerequisite.type} sandbox input is not valid JSON`); }
    const inputBytes = fileBytesByPath.get(pathForType);
    if (!Buffer.from(`${JSON.stringify(content)}\n`).equals(inputBytes)) {
      fail('AGG_SANDBOX_PREREQUISITE_CONTENT_INVALID', `stored ${prerequisite.type} sandbox input does not use the exact JSON byte representation written at commit: ${pathForType}`);
    }
    const payloadBytes = inputBytes.length - 1;
    if (payloadBytes > MAX_INPUT_BYTES) {
      fail('AGG_SANDBOX_INPUT_LIMIT_EXCEEDED', `stored ${prerequisite.type} sandbox input exceeds the per-artifact payload limit`);
    }
    totalInputPayloadBytes += payloadBytes;
    if (totalInputPayloadBytes > MAX_TOTAL_INPUT_BYTES) {
      fail('AGG_SANDBOX_INPUT_LIMIT_EXCEEDED', 'stored sandbox prerequisite payloads exceed the combined input limit');
    }
    if (hashArtifactContent(content) !== prerequisite.contentHash) {
      fail('AGG_SANDBOX_PREREQUISITE_CONTENT_HASH_MISMATCH', `stored ${prerequisite.type} sandbox input differs from the pinned artifact content hash`);
    }
  }
  if (prerequisiteTypes.size !== REQUIRED_EVIDENCE.length) {
    fail('AGG_SANDBOX_RECEIPT_INVALID', 'receipt does not bind both required artifact input types');
  }
  return { valid: true, receipt, receiptSha256: sha256(bytes), filesVerified: receipt.files.length, prerequisitesVerified: prerequisiteTypes.size };
}
