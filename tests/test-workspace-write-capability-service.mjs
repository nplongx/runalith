import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  createWorkspaceWriteCapabilityService,
  WorkspaceWriteCapabilityError
} from '../src/runtime/workspace-write-capability-service.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const PLAN_HASH = 'a'.repeat(64);

function fixture({ wrapperKind = null, failAfterMutationPath = null, failBeforeMutationPath = null, approvalCurrent = () => true } = {}) {
  const files = new Map([['write-scope/file.txt', Buffer.from('before bytes\n')]]);
  const receipts = new Map();
  const intents = new Map();
  const events = [];
  let transaction = null;
  let transactionOpen = false;
  let beginCount = 0;
  let commitCount = 0;
  let rollbackCount = 0;
  let approvalCheckCount = 0;
  let failBefore = failBeforeMutationPath;
  let onBeforeMutation = null;
  const plan = {
    workflow_id: 'standard-engineering', workflow_version: 3, plan_hash: PLAN_HASH,
    required_operations: ['workspace.write'], workspace_write_scopes: [{ role: 'writer', path: 'write-scope/**' }],
    children: [{ id: 'writer-step', role: 'writer', execution: { workspace_write_contract: { role: 'writer' } } }]
  };
  const workflowPort = {
    getJob: () => ({ job_id: 'job-1', status: 'active', state: 'EXECUTING' }),
    getTask: () => ({ task_id: 'task-1', job_id: 'job-1', status: 'running', role: 'writer' }),
    getExecutionPlan: () => plan,
    isApprovalCurrent: () => approvalCurrent(++approvalCheckCount),
    getProposal: () => ({ workspace: '/workspace' }),
    reviewWrapperKind: () => wrapperKind,
    verifyApprovalBinding: (_jobId, _plan, options) => {
      assert.equal(options.allowExecutingWrapper, true);
      assert.equal(options.allowSandboxActionContinuation, true);
      return { verified: true };
    },
    compileExecutionPlan: () => plan,
    getTaskPlanId: () => 'writer-step',
    recordEvent: (jobId, type, payload, dedupeId) => {
      events.push({ jobId, type, payload, dedupeId });
      return `event-${events.length}`;
    }
  };
  const workspacePort = {
    realpath: () => '/workspace',
    workspaceWriteScopeForRole: (_plan, role) => role === 'writer' ? { root: 'write-scope' } : null,
    pathIsWithinWorkspaceWriteScope: (relative, scope) => Boolean(scope && relative.startsWith(`${scope.root}/`)),
    readFileWithin: (_root, relative) => {
      if (!files.has(relative)) {
        const error = new Error('missing file');
        error.code = 'ENOENT';
        throw error;
      }
      return Buffer.from(files.get(relative));
    },
    replaceFileWithin: (_root, relative, content, options) => {
      onBeforeMutation?.();
      if (relative === failBefore) throw new Error('injected pre-mutation failure');
      const before = files.get(relative) ?? null;
      const beforeHash = before === null ? null : hash(before);
      const after = Buffer.from(content, 'utf8');
      const afterHash = hash(after);
      if (beforeHash === afterHash) {
        return { changed: false, outcome: 'already_present', before_sha256: beforeHash, after_sha256: afterHash, size_bytes: after.length };
      }
      if (options.expectedSha256 === 'ABSENT' ? before !== null : beforeHash !== options.expectedSha256) {
        const error = new Error('base hash mismatch');
        error.code = 'WORKSPACE_WRITE_BASE_HASH_MISMATCH';
        throw error;
      }
      files.set(relative, after);
      if (relative === failAfterMutationPath) {
        const error = new Error('injected post-mutation fsync/readback failure');
        error.workspaceMutationAttempted = true;
        throw error;
      }
      return {
        changed: true, outcome: before === null ? 'created' : 'replaced',
        before_sha256: beforeHash || 'ABSENT', after_sha256: afterHash, size_bytes: after.length
      };
    }
  };
  const receiptStore = {
    find({ jobId, taskId, patchId, path }) {
      return receipts.get(`${jobId}\0${taskId}\0${patchId}\0${path}`) || null;
    },
    insert(row) {
      receipts.set(`${row.job_id}\0${row.task_id}\0${row.patch_id}\0${row.path}`, { ...row });
      return row;
    },
    insertIntent(row) { intents.set(row.receipt_id, { ...row }); return row; },
    listPendingIntentsForJob(jobId) { return [...intents.values()].filter(row => row.job_id === jobId); },
    getByReceiptId(receiptId) { return [...receipts.values()].find(row => row.receipt_id === receiptId) || null; },
    deleteIntent(receiptId) { intents.delete(receiptId); },
    releaseIntentOwner(receiptId) {
      const intent = intents.get(receiptId);
      if (intent) {
        intent.owner_pid = null;
        intent.owner_start_ticks = null;
        intent.owner_boot_id = null;
      }
    },
    beginWriteTransaction() {
      assert.equal(transactionOpen, false, 'nested writer transaction is forbidden');
      transaction = { receipts: new Map(receipts), intents: new Map(intents), eventCount: events.length };
      transactionOpen = true;
      beginCount += 1;
    },
    commitWriteTransaction() {
      assert.equal(transactionOpen, true);
      transaction = null;
      transactionOpen = false;
      commitCount += 1;
    },
    rollbackWriteTransaction() {
      if (!transactionOpen) return;
      receipts.clear();
      for (const [key, value] of transaction.receipts) receipts.set(key, value);
      intents.clear();
      for (const [key, value] of transaction.intents) intents.set(key, value);
      events.length = transaction.eventCount;
      transaction = null;
      transactionOpen = false;
      rollbackCount += 1;
    }
  };
  const service = createWorkspaceWriteCapabilityService({ workflowPort, workspacePort, receiptStore });
  return {
    service, files, receipts, intents, events,
    setFailBeforeMutationPath(value) { failBefore = value; },
    setOnBeforeMutation(callback) { onBeforeMutation = callback; },
    get metrics() { return { beginCount, commitCount, rollbackCount, approvalCheckCount, transactionOpen }; }
  };
}

function request({ patchId = 'patch-1', path = 'write-scope/file.txt', before = 'before bytes\n', content = 'after bytes\n' } = {}) {
  return {
    jobId: 'job-1', taskId: 'task-1', patchId,
    writes: [{ path, base_sha256: hash(before), content }]
  };
}

function captureCapabilityError(fn, code) {
  let caught;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof WorkspaceWriteCapabilityError, `expected WorkspaceWriteCapabilityError, got ${caught?.constructor?.name}`);
  if (code) assert.equal(caught.code, code);
  return caught;
}

test('commits file receipt and event; exact retry reuses receipt; patch ID reuse is denied', () => {
  const f = fixture();
  const input = request();
  const applied = f.service.applyWrite(input);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.atomic_across_files, false);
  assert.equal(applied.receipts.length, 1);
  assert.equal(f.files.get('write-scope/file.txt').toString(), 'after bytes\n');
  assert.equal(f.receipts.size, 1);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].type, 'workflow.workspace_file_written');
  assert.equal(f.metrics.beginCount, 2);
  assert.equal(f.metrics.commitCount, 2);
  assert.equal(f.intents.size, 0);

  const replay = f.service.applyWrite(input);
  assert.equal(replay.receipts[0].receipt_id, applied.receipts[0].receipt_id);
  assert.equal(replay.receipts[0].replayed, true);
  assert.equal(f.events.length, 1, 'receipt replay must not append a duplicate event');

  const reused = captureCapabilityError(() => f.service.applyWrite(request({ content: 'different content\n' })), 'WORKSPACE_WRITE_PATCH_ID_REUSED');
  assert.equal(reused.details.workspace_mutation_status, 'not_modified');
  assert.equal(f.files.get('write-scope/file.txt').toString(), 'after bytes\n');
});

test('execution-graph approval binding is rechecked inside the writer transaction', () => {
  const f = fixture({ wrapperKind: 'execution_graph' });
  const applied = f.service.applyWrite(request());
  assert.equal(applied.status, 'applied');
  assert.equal(f.metrics.approvalCheckCount, 3, 'approval must be checked before intent commit and again before mutation');
});

test('workflow approval change at the writer-lock fence prevents filesystem mutation', () => {
  const f = fixture({ approvalCurrent: count => count === 1 });
  const error = captureCapabilityError(() => f.service.applyWrite(request()), 'WORKSPACE_WRITE_PARTIAL_OR_FAILED');
  assert.equal(error.category, 'validation_failure');
  assert.equal(error.details.workspace_mutation_status, 'not_modified');
  assert.equal(f.files.get('write-scope/file.txt').toString(), 'before bytes\n');
  assert.equal(f.receipts.size, 0);
  assert.equal(f.events.length, 0);
  assert.equal(f.metrics.rollbackCount, 1);
  assert.equal(f.intents.size, 0, 'authorization failure before intent commit must not leave a pending write');
});

test('post-mutation filesystem failure reports unreceipted outcome and never false not_modified', () => {
  const f = fixture({ failAfterMutationPath: 'write-scope/file.txt' });
  const error = captureCapabilityError(() => f.service.applyWrite(request()), 'WORKSPACE_WRITE_PARTIAL_OR_FAILED');
  assert.equal(error.category, 'unresolved_execution_outcome');
  assert.equal(error.details.workspace_mutation_status, 'unreceipted');
  assert.equal(error.details.side_effects[0].outcome, 'intended_bytes_present_without_receipt');
  assert.equal(f.files.get('write-scope/file.txt').toString(), 'after bytes\n');
  assert.equal(f.receipts.size, 0);
  assert.equal(f.events.length, 0);
  assert.equal(f.metrics.rollbackCount, 1);
  assert.equal(f.intents.size, 1, 'durable intent must survive post-mutation transaction rollback');

  const replay = f.service.applyWrite(request());
  assert.equal(replay.receipts[0].outcome, 'reconciled_after_restart');
  assert.equal(replay.receipts[0].replayed, true);
  assert.equal(f.receipts.size, 1);
  assert.equal(f.intents.size, 0);
  assert.equal(f.events.length, 1, 'recovery must append exactly one durable receipt event');
});

test('restart recovery discards intent when exact before-hash proves mutation never happened', () => {
  const f = fixture({ failBeforeMutationPath: 'write-scope/file.txt' });
  const input = request();
  const error = captureCapabilityError(() => f.service.applyWrite(input), 'WORKSPACE_WRITE_PARTIAL_OR_FAILED');
  assert.equal(error.details.workspace_mutation_status, 'not_modified');
  assert.equal(f.files.get('write-scope/file.txt').toString(), 'before bytes\n');
  assert.equal(f.intents.size, 1);

  f.setFailBeforeMutationPath(null);
  const applied = f.service.applyWrite(input);
  assert.equal(applied.status, 'applied');
  assert.equal(f.files.get('write-scope/file.txt').toString(), 'after bytes\n');
  assert.equal(f.intents.size, 0);
  assert.equal(f.receipts.size, 1);
  assert.equal(f.events.length, 1);
});

test('recovery records an already-applied mutation even after approval is revoked', () => {
  let approved = true;
  const f = fixture({ failAfterMutationPath: 'write-scope/file.txt', approvalCurrent: () => approved });
  const input = request();
  captureCapabilityError(() => f.service.applyWrite(input), 'WORKSPACE_WRITE_PARTIAL_OR_FAILED');
  assert.equal(f.intents.size, 1);
  approved = false;

  captureCapabilityError(() => f.service.applyWrite(input), 'WORKFLOW_APPROVAL_NOT_CURRENT');
  assert.equal(f.receipts.size, 1, 'recovery must persist receipt for mutation already present');
  assert.equal(f.receipts.values().next().value.outcome, 'reconciled_after_restart');
  assert.equal(f.intents.size, 0);
  assert.equal(f.events.length, 1);
});

test('recovery quarantines third-state bytes and preserves unresolved intent', () => {
  const f = fixture({ failAfterMutationPath: 'write-scope/file.txt' });
  const input = request();
  captureCapabilityError(() => f.service.applyWrite(input), 'WORKSPACE_WRITE_PARTIAL_OR_FAILED');
  f.files.set('write-scope/file.txt', Buffer.from('unexpected concurrent bytes'));

  captureCapabilityError(() => f.service.applyWrite(input), 'WORKSPACE_WRITE_RECOVERY_CONFLICT');
  assert.equal(f.intents.size, 1);
  assert.equal(f.receipts.size, 0);
  assert.equal(f.files.get('write-scope/file.txt').toString(), 'unexpected concurrent bytes');
});

test('live writer ownership prevents concurrent recovery from deleting an in-flight intent', () => {
  const f = fixture();
  let nestedError = null;
  f.setOnBeforeMutation(() => {
    f.setOnBeforeMutation(null);
    nestedError = captureCapabilityError(() => f.service.applyWrite(request()), 'WORKSPACE_WRITE_RECOVERY_BUSY');
  });
  const result = f.service.applyWrite(request());
  assert.equal(result.status, 'applied');
  assert.equal(nestedError.details.retryable, true);
  assert.equal(f.intents.size, 0);
  assert.equal(f.receipts.size, 1);
});

test('multi-file patch preserves committed first receipt and reports later failure as partial', () => {
  const f = fixture({ failBeforeMutationPath: 'write-scope/second.txt' });
  const input = {
    jobId: 'job-1', taskId: 'task-1', patchId: 'two-file-patch',
    writes: [
      { path: 'write-scope/file.txt', base_sha256: hash('before bytes\n'), content: 'first updated\n' },
      { path: 'write-scope/second.txt', base_sha256: 'ABSENT', content: 'second created\n' }
    ]
  };
  const error = captureCapabilityError(() => f.service.applyWrite(input), 'WORKSPACE_WRITE_PARTIAL_OR_FAILED');
  assert.equal(error.category, 'validation_failure');
  assert.equal(error.details.workspace_mutation_status, 'partial');
  assert.equal(error.details.side_effects.length, 1);
  assert.equal(f.files.get('write-scope/file.txt').toString(), 'first updated\n');
  assert.equal(f.files.has('write-scope/second.txt'), false);
  assert.equal(f.receipts.size, 1);
  assert.equal(f.events.length, 1);
  assert.equal(f.metrics.commitCount, 3, 'first file commits intent and receipt; second commits intent only');
  assert.equal(f.metrics.rollbackCount, 1);
  assert.equal(f.intents.size, 1, 'second file intent remains until exact before-hash recovery discards it');
});

