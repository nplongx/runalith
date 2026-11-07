import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

function processIdentity(pid = process.pid) {
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const close = stat.lastIndexOf(')');
  if (close < 0) throw new Error('cannot parse process identity for workspace write journal');
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const startTicks = fields[19]; // proc stat field 22; fields[0] is field 3 (state).
  if (!/^\d+$/.test(startTicks || '')) throw new Error('process start time missing from workspace write journal identity');
  return { pid, start_ticks: startTicks, boot_id: bootId };
}

function intentOwnerIsAlive(intent) {
  if (!Number.isSafeInteger(intent.owner_pid) || !intent.owner_start_ticks || !intent.owner_boot_id) return false;
  const currentBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  if (intent.owner_boot_id !== currentBootId) return false;
  try {
    return processIdentity(intent.owner_pid).start_ticks === intent.owner_start_ticks;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return false;
    throw error;
  }
}

/**
 * Stable application boundary for plan-authorized workspace mutations.
 *
 * The service coordinates Workflow authorization, secure filesystem access,
 * durable write intents/receipts and Workflow event append. It deliberately
 * knows neither MCP transport details nor SQLite handles. A committed intent
 * precedes filesystem mutation; the receipt/event transaction then commits
 * with intent deletion. Filesystem bytes still cannot participate in SQLite
 * atomic commit, so startup recovery reconciles exact before/after hashes.
 */
export class WorkspaceWriteCapabilityError extends Error {
  constructor(code, category, message, details = {}) {
    super(message);
    this.name = 'WorkspaceWriteCapabilityError';
    this.code = code;
    this.category = category;
    this.details = details;
  }
}

function requiredFunction(owner, name, label) {
  if (typeof owner?.[name] !== 'function') {
    throw new TypeError(`${label}.${name} must be a function`);
  }
  return owner[name].bind(owner);
}

export class WorkspaceWriteCapabilityService {
  #workflow;
  #workspace;
  #receipts;

  constructor({ workflowPort, workspacePort, receiptStore } = {}) {
    this.#workflow = {
      getJob: requiredFunction(workflowPort, 'getJob', 'workflowPort'),
      getTask: requiredFunction(workflowPort, 'getTask', 'workflowPort'),
      getExecutionPlan: requiredFunction(workflowPort, 'getExecutionPlan', 'workflowPort'),
      isApprovalCurrent: requiredFunction(workflowPort, 'isApprovalCurrent', 'workflowPort'),
      getProposal: requiredFunction(workflowPort, 'getProposal', 'workflowPort'),
      reviewWrapperKind: requiredFunction(workflowPort, 'reviewWrapperKind', 'workflowPort'),
      verifyApprovalBinding: requiredFunction(workflowPort, 'verifyApprovalBinding', 'workflowPort'),
      compileExecutionPlan: requiredFunction(workflowPort, 'compileExecutionPlan', 'workflowPort'),
      getTaskPlanId: requiredFunction(workflowPort, 'getTaskPlanId', 'workflowPort'),
      recordEvent: requiredFunction(workflowPort, 'recordEvent', 'workflowPort')
    };
    this.#workspace = {
      realpath: requiredFunction(workspacePort, 'realpath', 'workspacePort'),
      workspaceWriteScopeForRole: requiredFunction(workspacePort, 'workspaceWriteScopeForRole', 'workspacePort'),
      pathIsWithinWorkspaceWriteScope: requiredFunction(workspacePort, 'pathIsWithinWorkspaceWriteScope', 'workspacePort'),
      readFileWithin: requiredFunction(workspacePort, 'readFileWithin', 'workspacePort'),
      replaceFileWithin: requiredFunction(workspacePort, 'replaceFileWithin', 'workspacePort')
    };
    for (const method of ['find', 'insert', 'insertIntent', 'listPendingIntentsForJob', 'getByReceiptId', 'deleteIntent', 'releaseIntentOwner', 'beginWriteTransaction', 'commitWriteTransaction', 'rollbackWriteTransaction']) {
      requiredFunction(receiptStore, method, 'receiptStore');
    }
    this.#receipts = receiptStore;
  }

  #recoverPendingWrites({ jobId, workflow, workspace, receipts }) {
    for (const intent of receipts.listPendingIntentsForJob(jobId)) {
      if (intentOwnerIsAlive(intent)) {
        throw new WorkspaceWriteCapabilityError('WORKSPACE_WRITE_RECOVERY_BUSY', 'unresolved_execution_outcome',
          `Workspace mutation ${intent.path} is still owned by a live writer process.`, {
            job_id: jobId, task_id: intent.task_id, capability: 'workspace.write', retryable: true,
            workspace_mutation_status: 'unresolved', side_effects: [{ receipt_id: intent.receipt_id, path: intent.path, owner_pid: intent.owner_pid }]
          });
      }
      const workspaceRoot = workspace.realpath(intent.workspace_root);
      if (workspaceRoot !== intent.workspace_root) {
        throw new WorkspaceWriteCapabilityError('WORKSPACE_WRITE_RECOVERY_ROOT_MISMATCH', 'unresolved_execution_outcome',
          'A pending workspace write belongs to a different canonical workspace root; recovery is blocked.', {
            job_id: jobId, task_id: intent.task_id, capability: 'workspace.write', retryable: false,
            workspace_mutation_status: 'unresolved', side_effects: [{ receipt_id: intent.receipt_id, path: intent.path }]
          });
      }
      let currentBytes = null;
      try { currentBytes = workspace.readFileWithin(workspaceRoot, intent.path); }
      catch (error) {
        if (error?.code !== 'ENOENT') {
          throw new WorkspaceWriteCapabilityError('WORKSPACE_WRITE_RECOVERY_READ_FAILED', 'unresolved_execution_outcome',
            `Cannot safely inspect pending workspace mutation ${intent.path}: ${String(error?.message || error)}`, {
              job_id: jobId, task_id: intent.task_id, capability: 'workspace.write', retryable: false,
              workspace_mutation_status: 'unresolved', side_effects: [{ receipt_id: intent.receipt_id, path: intent.path }]
            });
        }
      }
      const currentHash = currentBytes === null ? null : createHash('sha256').update(currentBytes).digest('hex');
      if (currentHash === intent.after_sha256) {
        if (currentBytes.length !== intent.size_bytes) {
          throw new WorkspaceWriteCapabilityError('WORKSPACE_WRITE_RECOVERY_CONFLICT', 'unresolved_execution_outcome',
            `Pending workspace mutation ${intent.path} has the expected digest but unexpected size.`, {
              job_id: jobId, task_id: intent.task_id, capability: 'workspace.write', retryable: false,
              workspace_mutation_status: 'unresolved', side_effects: [{ receipt_id: intent.receipt_id, path: intent.path, after_sha256: currentHash }]
            });
        }
        receipts.beginWriteTransaction();
        try {
          const existing = receipts.getByReceiptId(intent.receipt_id);
          if (existing) {
            if (existing.after_sha256 !== intent.after_sha256 || existing.path !== intent.path || existing.request_hash !== intent.request_hash) {
              throw new Error('existing receipt conflicts with pending write intent');
            }
          } else {
            receipts.insert({
              receipt_id: intent.receipt_id, job_id: intent.job_id, task_id: intent.task_id,
              plan_hash: intent.plan_hash, patch_id: intent.patch_id, request_hash: intent.request_hash,
              path: intent.path, outcome: 'reconciled_after_restart', before_sha256: intent.before_sha256,
              after_sha256: intent.after_sha256, size_bytes: intent.size_bytes, created_at: intent.created_at
            });
            workflow.recordEvent(jobId, 'workflow.workspace_file_write_recovered', {
              receipt_id: intent.receipt_id, task_id: intent.task_id, plan_hash: intent.plan_hash,
              patch_id: intent.patch_id, request_hash: intent.request_hash, path: intent.path,
              outcome: 'reconciled_after_restart', before_sha256: intent.before_sha256,
              after_sha256: intent.after_sha256, size_bytes: intent.size_bytes
            }, `${intent.receipt_id}:recovered-after-restart`);
          }
          receipts.deleteIntent(intent.receipt_id);
          receipts.commitWriteTransaction();
        } catch (error) {
          receipts.rollbackWriteTransaction();
          throw error;
        }
      } else if ((intent.before_sha256 === 'ABSENT' && currentBytes === null) || currentHash === intent.before_sha256) {
        receipts.beginWriteTransaction();
        try {
          receipts.deleteIntent(intent.receipt_id);
          receipts.commitWriteTransaction();
        } catch (error) {
          receipts.rollbackWriteTransaction();
          throw error;
        }
      } else {
        throw new WorkspaceWriteCapabilityError('WORKSPACE_WRITE_RECOVERY_CONFLICT', 'unresolved_execution_outcome',
          `Pending workspace mutation ${intent.path} matches neither its durable before nor after digest.`, {
            job_id: jobId, task_id: intent.task_id, capability: 'workspace.write', retryable: false,
            workspace_mutation_status: 'unresolved', side_effects: [{ receipt_id: intent.receipt_id, path: intent.path, observed_sha256: currentHash }]
          });
      }
    }
  }

  applyWrite({ jobId, taskId, patchId, writes } = {}) {
    for (const [value, label] of [[jobId, 'jobId'], [taskId, 'taskId'], [patchId, 'patchId']]) {
      if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
    }

    const { workflow, workspace, receipts } = {
      workflow: this.#workflow, workspace: this.#workspace, receipts: this.#receipts
    };
    // Reconcile durable prior mutations before checking current approval or
    // task state. Recovery records already-performed effects; it never grants
    // permission to perform a new write.
    this.#recoverPendingWrites({ jobId, workflow, workspace, receipts });
    const job = workflow.getJob(jobId);
    const task = workflow.getTask(taskId);
    const plan = workflow.getExecutionPlan(jobId);
    const deny = (code, category, message, extra = {}) => {
      throw new WorkspaceWriteCapabilityError(code, category, message, {
        job_id: jobId, workflow_id: plan?.workflow_id || null, workflow_version: plan?.workflow_version || null,
        job_state: job?.state || null, task_id: taskId, capability: 'workspace.write', retryable: false,
        side_effects: [], workspace_mutation_status: 'not_modified', ...extra
      });
    };

    if (!job || !task || task.job_id !== jobId) deny('WORKSPACE_WRITE_TASK_MISMATCH', 'invalid_state', 'Task does not belong to the requested workflow.');
    if (job.status !== 'active' || String(job.state).toUpperCase() !== 'EXECUTING') deny('WORKFLOW_NOT_EXECUTING', 'invalid_state', 'Workspace writes require an active EXECUTING workflow.');
    if (!plan || plan.workflow_id !== 'standard-engineering' || plan.workflow_version < 3 || !plan.required_operations?.includes('workspace.write')) {
      deny('WORKSPACE_WRITE_UNSUPPORTED_PLAN', 'unsupported_operation', 'Workspace writes require an approved standard-engineering v3+ plan that pins workspace.write.');
    }
    if (!workflow.isApprovalCurrent(jobId)) deny('WORKFLOW_APPROVAL_NOT_CURRENT', 'policy_denial', 'The current approval does not authorize this plan.');
    const proposal = workflow.getProposal(jobId);
    const reviewWrapperKind = workflow.reviewWrapperKind(proposal);
    if (reviewWrapperKind === 'execution_graph') {
      try { workflow.verifyApprovalBinding(jobId, plan, { allowExecutingWrapper: true, allowSandboxActionContinuation: true }); }
      catch (error) {
        deny(error?.code || 'AGG_APPROVAL_EVIDENCE_INVALID', 'policy_denial', `Approval policy/quorum/evidence was revoked or no longer verifies immediately before workspace write: ${String(error?.message || error)}`);
      }
    }

    const workspaceRoot = workspace.realpath(proposal.workspace);
    let revalidatedPlan;
    try { revalidatedPlan = workflow.compileExecutionPlan(jobId, { workspace: workspaceRoot }); }
    catch (error) { deny('IMMUTABLE_PLAN_MISMATCH', 'policy_denial', `Current proposal cannot be revalidated against the immutable plan: ${String(error?.message || error)}`); }
    if (revalidatedPlan?.plan_hash !== plan.plan_hash) deny('IMMUTABLE_PLAN_MISMATCH', 'policy_denial',
      `Current proposal no longer compiles to the approved immutable plan (candidate=${revalidatedPlan?.plan_hash || 'none'}, approved=${plan.plan_hash}).`,
      { details: { candidate_plan_hash: revalidatedPlan?.plan_hash || null, approved_plan_hash: plan.plan_hash } });

    const planTaskId = workflow.getTaskPlanId(task);
    const planned = plan.children.find(item => item.id === planTaskId);
    const writeContract = planned?.execution?.workspace_write_contract;
    const scope = workspace.workspaceWriteScopeForRole({
      required_operations: plan.required_operations,
      scopes: plan.workspace_write_scopes
    }, task.role);
    if (!planned || planned.role !== task.role || !writeContract || !scope ||
        writeContract.role !== task.role || !['engineer', 'writer'].includes(task.role) ||
        !['running'].includes(String(task.status).toLowerCase())) {
      deny('WORKSPACE_WRITE_TASK_NOT_AUTHORIZED', 'permission_denied', 'Task is not a running built-in engineer/writer task with an exact plan-pinned write scope.');
    }
    if (!Array.isArray(writes) || writes.length < 1 || writes.length > 16) deny('WORKSPACE_WRITE_REQUEST_INVALID', 'validation_failure', 'writes must contain 1..16 file changes.');

    const requestHash = createHash('sha256').update(JSON.stringify({ jobId, taskId, patchId, writes })).digest('hex');
    const validated = [];
    const seenPaths = new Set();
    for (const [index, write] of writes.entries()) {
      if (!write || typeof write !== 'object' || Array.isArray(write) || Object.keys(write).some(key => !['path', 'base_sha256', 'content'].includes(key)) ||
          typeof write.path !== 'string' || typeof write.content !== 'string' || Buffer.byteLength(write.content, 'utf8') > 2_000_000 ||
          !/^(ABSENT|[a-f0-9]{64})$/.test(write.base_sha256 || '')) {
        deny('WORKSPACE_WRITE_REQUEST_INVALID', 'validation_failure', `writes[${index}] has invalid path, content, or base_sha256.`);
      }
      if (!workspace.pathIsWithinWorkspaceWriteScope(write.path, scope)) deny('WORKSPACE_WRITE_SCOPE_DENIED', 'permission_denied', `Path is outside the approved ${task.role} workspace scope: ${write.path}`);
      if (seenPaths.has(write.path)) deny('WORKSPACE_WRITE_REQUEST_INVALID', 'validation_failure', `Duplicate path in one patch: ${write.path}`);
      seenPaths.add(write.path);
      const prior = receipts.find({ jobId, taskId, patchId, path: write.path });
      if (prior && prior.request_hash !== requestHash) deny('WORKSPACE_WRITE_PATCH_ID_REUSED', 'policy_denial', 'patch_id was already used with a different request payload.');
      let currentBytes = null;
      try { currentBytes = workspace.readFileWithin(workspaceRoot, write.path); }
      catch (error) { if (error?.code !== 'ENOENT') deny('WORKSPACE_WRITE_TARGET_INVALID', 'validation_failure', `Cannot safely inspect ${write.path}: ${String(error?.message || error)}`); }
      const currentHash = currentBytes === null ? null : createHash('sha256').update(currentBytes).digest('hex');
      const intendedHash = createHash('sha256').update(write.content, 'utf8').digest('hex');
      if (currentHash !== intendedHash && (write.base_sha256 === 'ABSENT' ? currentHash !== null : currentHash !== write.base_sha256)) {
        deny('WORKSPACE_WRITE_BASE_HASH_MISMATCH', 'validation_failure', `Base SHA-256 precondition does not match current bytes for ${write.path}; no files were changed.`,
          { evidence_missing: [write.path], details: { expected_sha256: write.base_sha256, observed_sha256: currentHash } });
      }
      validated.push({ ...write, prior });
    }

    const writeReceipts = [];
    const failures = [];
    for (const write of validated) {
      if (write.prior) {
        writeReceipts.push({ receipt_id: write.prior.receipt_id, path: write.path, outcome: write.prior.outcome,
          after_sha256: write.prior.after_sha256, size_bytes: write.prior.size_bytes, replayed: true });
        continue;
      }
      let observedMutation = null;
      let ownsIntent = false;
      let intentReceiptId = null;
      try {
        intentReceiptId = `wwr_${createHash('sha256').update([jobId, taskId, patchId, write.path].join(String.fromCharCode(0))).digest('hex').slice(0, 32)}`;
        const intentAfterHash = createHash('sha256').update(write.content, 'utf8').digest('hex');
        const intentSizeBytes = Buffer.byteLength(write.content, 'utf8');
        const intentCreatedAt = new Date().toISOString();
        const intentOwner = processIdentity();

        // The intent commits separately before any filesystem mutation.
        receipts.beginWriteTransaction();
        try {
          const currentJob = workflow.getJob(jobId);
          const currentTask = workflow.getTask(taskId);
          if (!currentJob || currentJob.status !== 'active' || currentJob.state !== 'EXECUTING' || !currentTask || currentTask.status !== 'running' ||
              !workflow.isApprovalCurrent(jobId) || workflow.getExecutionPlan(jobId)?.plan_hash !== plan.plan_hash) {
            throw new Error('workflow/task/approval changed before durable workspace write intent');
          }
          if (reviewWrapperKind === 'execution_graph') {
            workflow.verifyApprovalBinding(jobId, plan, { allowExecutingWrapper: true, allowSandboxActionContinuation: true });
          }
          const racedReceipt = receipts.find({ jobId, taskId, patchId, path: write.path });
          if (racedReceipt) {
            if (racedReceipt.request_hash !== requestHash) throw new Error('patch_id was concurrently reused with a different request payload');
            receipts.commitWriteTransaction();
            writeReceipts.push({ receipt_id: racedReceipt.receipt_id, path: racedReceipt.path, outcome: racedReceipt.outcome,
              after_sha256: racedReceipt.after_sha256, size_bytes: racedReceipt.size_bytes, replayed: true });
            continue;
          }
          let beforeBytes = null;
          try { beforeBytes = workspace.readFileWithin(workspaceRoot, write.path); }
          catch (error) { if (error?.code !== 'ENOENT') throw error; }
          const intentBeforeHash = beforeBytes === null ? 'ABSENT' : createHash('sha256').update(beforeBytes).digest('hex');
          if (intentBeforeHash !== intentAfterHash && intentBeforeHash !== write.base_sha256) {
            throw new Error(`workspace bytes changed before durable write intent: ${write.path}`);
          }
          receipts.insertIntent({
            receipt_id: intentReceiptId, job_id: jobId, task_id: taskId, plan_hash: plan.plan_hash,
            patch_id: patchId, request_hash: requestHash, workspace_root: workspaceRoot, path: write.path,
            outcome: intentBeforeHash === intentAfterHash ? 'already_present' : intentBeforeHash === 'ABSENT' ? 'created' : 'replaced',
            before_sha256: intentBeforeHash, after_sha256: intentAfterHash,
            size_bytes: intentSizeBytes, created_at: intentCreatedAt,
            owner_pid: intentOwner.pid, owner_start_ticks: intentOwner.start_ticks, owner_boot_id: intentOwner.boot_id
          });
          receipts.commitWriteTransaction();
          ownsIntent = true;
        } catch (error) {
          receipts.rollbackWriteTransaction();
          throw error;
        }

        // The following receipt/event transaction is atomic with intent
        // deletion. A crash before commit leaves the prior intent durable.
        receipts.beginWriteTransaction();
        try {
          const currentJob = workflow.getJob(jobId);
          const currentTask = workflow.getTask(taskId);
          if (!currentJob || currentJob.status !== 'active' || currentJob.state !== 'EXECUTING' || !currentTask || currentTask.status !== 'running' ||
              !workflow.isApprovalCurrent(jobId) || workflow.getExecutionPlan(jobId)?.plan_hash !== plan.plan_hash) {
            throw new Error('workflow/task/approval changed during workspace write; inspect file bytes before recovery');
          }
          if (reviewWrapperKind === 'execution_graph') {
            // Recheck signed policy, trust-root revocation, maker/checker quorum,
            // source/evidence freshness and immutable plan under the same writer
            // lock immediately before filesystem mutation.
            workflow.verifyApprovalBinding(jobId, plan, { allowExecutingWrapper: true, allowSandboxActionContinuation: true });
          }
          const racedReceipt = receipts.find({ jobId, taskId, patchId, path: write.path });
          if (racedReceipt) {
            if (racedReceipt.request_hash !== requestHash) throw new Error('patch_id was concurrently reused with a different request payload');
            receipts.deleteIntent(intentReceiptId);
            receipts.commitWriteTransaction();
            writeReceipts.push({ receipt_id: racedReceipt.receipt_id, path: racedReceipt.path, outcome: racedReceipt.outcome,
              after_sha256: racedReceipt.after_sha256, size_bytes: racedReceipt.size_bytes, replayed: true });
            continue;
          }
          const result = workspace.replaceFileWithin(workspaceRoot, write.path, write.content, { expectedSha256: write.base_sha256, maxBytes: 2_000_000 });
          if (result.changed) observedMutation = { path: write.path, outcome: result.outcome, before_sha256: result.before_sha256 || 'ABSENT', after_sha256: result.after_sha256, size_bytes: result.size_bytes };
          const receiptId = `wwr_${createHash('sha256').update(`${jobId}\0${taskId}\0${patchId}\0${write.path}`).digest('hex').slice(0, 32)}`;
          const outcome = result.outcome;
          receipts.insert({
            receipt_id: receiptId, job_id: jobId, task_id: taskId, plan_hash: plan.plan_hash,
            patch_id: patchId, request_hash: requestHash, path: write.path, outcome,
            before_sha256: result.before_sha256 || 'ABSENT', after_sha256: result.after_sha256,
            size_bytes: result.size_bytes, created_at: new Date().toISOString()
          });
          workflow.recordEvent(jobId, 'workflow.workspace_file_written', {
            receipt_id: receiptId, task_id: taskId, plan_hash: plan.plan_hash, patch_id: patchId, request_hash: requestHash,
            path: write.path, outcome, before_sha256: result.before_sha256 || 'ABSENT', after_sha256: result.after_sha256, size_bytes: result.size_bytes
          }, `${receiptId}:${requestHash}`);
          receipts.deleteIntent(intentReceiptId);
          receipts.commitWriteTransaction();
          writeReceipts.push({ receipt_id: receiptId, path: write.path, outcome, before_sha256: result.before_sha256 || 'ABSENT', after_sha256: result.after_sha256, size_bytes: result.size_bytes });
        } catch (error) {
          receipts.rollbackWriteTransaction();
          if (error?.workspaceMutationAttempted === true) {
            // replaceFileWithin can fail after rename/link (directory fsync or
            // readback). Never infer "not modified" from a thrown helper.
            // Read target after rollback; only prove no mutation when current
            // bytes still equal the original base condition.
            let currentBytes = null;
            let readbackFailed = false;
            try { currentBytes = workspace.readFileWithin(workspaceRoot, write.path); }
            catch (readError) { if (readError?.code !== 'ENOENT') readbackFailed = true; }
            const currentHash = currentBytes === null ? null : createHash('sha256').update(currentBytes).digest('hex');
            const originalHash = write.base_sha256 === 'ABSENT' ? null : write.base_sha256;
            if (readbackFailed || currentHash !== originalHash) {
              observedMutation = {
                path: write.path,
                outcome: currentHash === createHash('sha256').update(write.content, 'utf8').digest('hex')
                  ? 'intended_bytes_present_without_receipt' : 'unknown_after_filesystem_mutation_attempt',
                before_sha256: write.base_sha256,
                after_sha256: currentHash,
                size_bytes: currentBytes?.length ?? null,
                mutation_attempted: true
              };
            }
          }
          throw error;
        }
      } catch (error) {
        if (ownsIntent && intentReceiptId) {
          try { receipts.releaseIntentOwner(intentReceiptId); } catch { /* retain the live-owner fence if release fails */ }
        }
        failures.push({ path: write.path, code: observedMutation ? 'WORKSPACE_WRITE_RECEIPT_UNRESOLVED' : (error?.code || 'WORKSPACE_WRITE_FAILED'), message: String(error?.message || error), observed_mutation: observedMutation });
        break;
      }
    }

    if (failures.length) {
      throw new WorkspaceWriteCapabilityError('WORKSPACE_WRITE_PARTIAL_OR_FAILED',
        failures.some(item => item.observed_mutation) ? 'unresolved_execution_outcome' : 'validation_failure',
        writeReceipts.length ? 'Workspace patch partially applied; inspect per-file receipts before retrying.' : 'Workspace patch failed before any receipt was recorded.', {
          job_id: jobId, workflow_id: plan.workflow_id, workflow_version: plan.workflow_version, job_state: workflow.getJob(jobId)?.state,
          task_id: taskId, capability: 'workspace.write', retryable: false, side_effects: [
            ...writeReceipts.map(item => ({ receipt_id: item.receipt_id, path: item.path, outcome: item.outcome })),
            ...failures.filter(item => item.observed_mutation).map(item => ({ ...item.observed_mutation, receipt_id: null }))
          ],
          workspace_mutation_status: writeReceipts.length && failures.some(item => item.observed_mutation) ? 'partial_unreceipted' : writeReceipts.length ? 'partial' : failures.some(item => item.observed_mutation) ? 'unreceipted' : 'not_modified',
          evidence_missing: failures.map(item => item.path),
          next_actions: [{ tool: 'workflow_write_files', reason: 'Inspect current file bytes and durable receipts. If bytes already match the intended content, replay only the exact same patch_id and identical request to reconcile the missing receipt; never infer success from the write alone.' }],
          details: { receipts: writeReceipts, failures, patch_id: patchId, request_hash: requestHash }
        });
    }

    return { status: 'applied', job_id: jobId, task_id: taskId, patch_id: patchId, request_hash: requestHash, plan_hash: plan.plan_hash, receipts: writeReceipts, atomic_across_files: false };
  }
}

export function createWorkspaceWriteCapabilityService(dependencies) {
  return new WorkspaceWriteCapabilityService(dependencies);
}
