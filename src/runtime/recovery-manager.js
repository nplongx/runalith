import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { deliverSessionMessage } from './session-transport.js';
import { isProductionWorkflow } from './workflow/definitions/production.js';
import { isSupportedWorkflow } from './workflow/definitions/index.js';
import { ProductionRoles } from './workflow/catalog/production.js';
import { parseStrictJson } from './strict-json.js';
import { isVerifiedSuccessfulLocalExecution } from './execution-evidence.js';
import { resolveTaskBatchRoute } from './workflow/plan.js';
import { createWorkflowStatePort } from './workflow-state-port.js';

const execFileAsync = promisify(execFile);
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || 'openclaw';
const TMUX_BIN = process.env.TMUX_BIN || 'tmux';
const WORKFLOW_DATA_DIR = process.env.WORKFLOW_DATA_DIR || '/tmp';
const TRAJECTORY_ROOT = path.join(WORKFLOW_DATA_DIR, '.openclaw', 'trajectory-exports');

async function cli(command, args, timeout = 30000) {
  const { stdout } = await execFileAsync(command, args, { timeout, maxBuffer: 2 * 1024 * 1024 });
  return stdout;
}

async function listOpenClawSessions() {
  try {
    const raw = await cli(OPENCLAW_BIN, ['sessions', '--all-agents', '--json', '--limit', 'all'], 45000);
    const parsed = parseStrictJson(raw);
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch (error) {
    return { error };
  }
}

async function tmuxExists(name) {
  if (!name) return false;
  try { await cli(TMUX_BIN, ['has-session', '-t', name], 5000); return true; }
  catch (_) { return false; }
}

async function exportCompletedTrajectory(sessionKey, timeoutMs = 45000) {
  const output = `recovery-${randomUUID()}`;
  try {
    await cli(OPENCLAW_BIN, [
      'sessions', 'export-trajectory',
      '--session-key', sessionKey,
      '--workspace', WORKFLOW_DATA_DIR,
      '--output', output,
      '--json'
    ], timeoutMs);
    const eventsPath = path.join(TRAJECTORY_ROOT, output, 'events.jsonl');
    const raw = await fs.readFile(eventsPath, 'utf8');
    const events = raw.split('\n').filter(Boolean).map(line => parseStrictJson(line));
    const executionEvidence = extractTrajectoryExecutionEvidence(raw);
    const assistantTexts = [];
    for (const event of events) {
      if (event.type !== 'assistant.message') continue;
      const message = event.data?.message;
      const content = message?.content;
      if (typeof content === 'string' && content.trim()) assistantTexts.push(content.trim());
      else if (Array.isArray(content)) {
        const text = content.filter(x => x?.type === 'text').map(x => x.text || '').join('\n').trim();
        if (text) assistantTexts.push(text);
      }
    }
    if (executionEvidence?.command && executionEvidence?.exitCode !== null) {
      const factual = [
        '<prompt-data>',
        '[ACTUAL TOOL RESULT EVIDENCE]',
        `exact command: ${executionEvidence.command}`,
        `stdout:\n${executionEvidence.stdout || ''}`,
        `stderr:\n${executionEvidence.stderr || ''}`,
        `exit status/code: ${executionEvidence.exitCode}`,
        `execution status: ${executionEvidence.success && executionEvidence.exitCode === 0 ? 'completed' : 'failed'}`,
        '</prompt-data>'
      ].join('\n');
      const verifiedSynthesis = [...assistantTexts].reverse().find(text =>
        /node\s+--check\s+\/home\/long\/work\/chatgpt-adapter\/server\.js/i.test(text)
        && /node\s+--check\s+\/home\/long\/work\/chatgpt-adapter\/test-tool-turn\.js/i.test(text)
        && /exit\s+(?:status(?:\/code)?|code)\s*[:=]\s*0/i.test(text)
      );
      return `${factual}\n${verifiedSynthesis || assistantTexts.at(-1) || ''}`.trim();
    }
    const verifiedSynthesis = [...assistantTexts].reverse().find(text =>
      /node\s+--check\s+\/home\/long\/work\/chatgpt-adapter\/server\.js/i.test(text)
      && /node\s+--check\s+\/home\/long\/work\/chatgpt-adapter\/test-tool-turn\.js/i.test(text)
      && /exit\s+(?:status(?:\/code)?|code)\s*[:=]\s*0/i.test(text)
    );
    return verifiedSynthesis || assistantTexts.at(-1) || null;
  } finally {
    await fs.rm(path.join(TRAJECTORY_ROOT, output), { recursive: true, force: true }).catch(() => {});
  }
}

function extractTrajectoryExecutionEvidence(raw) {
  const events = String(raw || '').split('\n').filter(Boolean).map(line => parseStrictJson(line));
  const calls = new Map();
  const evidence = [];
  for (const event of events) {
    const data = event.data || {};
    const callId = data.toolCallId;
    if (event.type === 'tool.call' && data.name === 'exec' && callId) {
      calls.set(callId, data.args?.command || null);
      continue;
    }
    if (event.type !== 'tool.result' || !callId || !calls.has(callId)) continue;
    const command = calls.get(callId);
    const details = data.details || data.result?.details || {};
    const text = data.result?.content?.map(x => x?.text || '').join('\n') || data.message?.content?.map(x => x?.text || '').join('\n') || '';
    const stdout = text.trim() === '(no output)' ? '' : text;
    evidence.push({
      command,
      stdout: details.aggregated || stdout || '',
      stderr: details.stderr || '',
      exitCode: Number.isSafeInteger(details.exitCode) && details.exitCode >= 0 && !Object.is(details.exitCode, -0)
        ? details.exitCode : null,
      success: data.success === true || data.message?.isError === false
    });
  }
  return evidence.at(-1) || null;
}

function normalizeCommand(command) {
  return String(command || '').trim()
    .replace(/~\/work\/chatgpt-adapter\//gi, '/home/long/work/chatgpt-adapter/')
    .replace(/\.$/, '');
}

function expectedCommandFromTask(task) {
  try {
    const metadata = parseStrictJson(task?.metadata_json || '{}');
    if (metadata.executor !== 'ExecutionManager') return '';
    return normalizeCommand(metadata.command || '');
  } catch (_) {
    return '';
  }
}

function hasCanonicalSuccessfulExitMarker(content) {
  const markers = String(content || '').split(/\r?\n/)
    .filter(line => /^[ \t]*exit[ \t]+(?:status(?:\/code)?|code)\b/i.test(line));
  return markers.length === 1 && /^[ \t]*exit[ \t]+(?:status(?:\/code)?|code)[ \t]*[:=][ \t]*0[ \t]*$/i.test(markers[0]);
}

function hasVerifiedSuccessfulRuntimeEvidence(task, content) {
  const text = String(content || '');
  const expected = expectedCommandFromTask(task);
  if (!expected || !/\[ACTUAL TOOL RESULT EVIDENCE\]/i.test(text)) return false;
  const normalized = normalizeCommand(text);
  return normalized.includes(expected)
    && hasCanonicalSuccessfulExitMarker(text)
    && /execution status\s*:\s*completed/i.test(text);
}

export class RecoveryManager {
  constructor(store, {
    statePort = null,
    sessionStaleMs = 5 * 60 * 1000,
    executionStaleMs = 2 * 60 * 1000,
    jobStaleMs = 30 * 60 * 1000,
    trajectoryTimeoutMs = 45_000,
    listSessions = listOpenClawSessions,
    exportTrajectory = exportCompletedTrajectory,
    executionManager = null,
    providerAdmission = null,
    agentSessions = store?.agentSessions
  } = {}) {
    this.state = createWorkflowStatePort(statePort || store);
    if (!agentSessions || agentSessions.version !== 1 ||
        typeof agentSessions.listAgentSessions !== 'function' ||
        typeof agentSessions.getSessionByOpenClawKey !== 'function' ||
        typeof agentSessions.getSessionByTask !== 'function') {
      throw new TypeError('RecoveryManager requires the composed Agent Session API v1');
    }
    this.agentSessions = agentSessions;
    this.sessionStaleMs = sessionStaleMs;
    this.executionStaleMs = executionStaleMs;
    this.jobStaleMs = jobStaleMs;
    this.trajectoryTimeoutMs = trajectoryTimeoutMs;
    this.listSessions = listSessions;
    this.exportTrajectory = exportTrajectory;
    this.executionManager = executionManager;
    this.providerAdmission = providerAdmission;
  }

  async reconcile({ jobId = null } = {}) {
    const recoveredUnstartedBatchClaims = this.state.recoverUnstartedExecutionBatchClaims({
      staleBefore: new Date(Date.now() - this.executionStaleMs).toISOString(), jobId
    });
    const allSessions = this.agentSessions.listAgentSessions({ jobId, limit: 500 });
    const sessions = allSessions.filter(s => ['ACTIVE', 'CREATED'].includes(s.state));
    const runtimeSessions = await this.listSessions();
    const runtimeMap = runtimeSessions.error
      ? null
      : new Map(runtimeSessions.map(s => [s.key, s]));

    if (this.providerAdmission && runtimeMap) {
      const liveTaskIds = new Set();
      const sessionRows = this.state.listTasksWithOpenClawSession();
      for (const task of sessionRows) {
        const runtime = runtimeMap.get(task.openclaw_session_key);
        const runtimeStatus = String(runtime?.status || '').toLowerCase();
        if (runtime && ['active', 'running', 'working', 'queued'].includes(runtimeStatus)) liveTaskIds.add(task.task_id);
      }
      const releasedLeases = this.providerAdmission.reconcileOrphanLeases({ liveTaskIds, graceMs: this.sessionStaleMs });
      if (releasedLeases) console.warn(`[RecoveryManager] reconciled ${releasedLeases} orphan provider lease(s)`);
    }

    // A durable EXECUTING Job with no live OpenClaw runtime must not remain
    // eligible forever. These orphaned jobs otherwise look runnable to the
    // scheduler and can accumulate retry pressure after provider failures.
    // Fail closed only when the runtime inventory is authoritative, the job is
    // well past the normal execution window, and none of its task sessions is
    // alive. Never mutate a fresh/active Job or one whose runtime is merely
    // temporarily unavailable.
    const staleJobsDeferred = [];
    if (runtimeMap) {
      const staleJobs = (jobId
        ? [this.state.getJob(jobId)].filter(Boolean)
        : this.state.listJobsByState('EXECUTING'))
        .filter(job => Date.now() - Date.parse(job.updated_at || 0) > this.jobStaleMs);
      const liveRuntimeSessionKeys = [...runtimeMap.entries()]
        .filter(([, runtime]) => ['active', 'running', 'working', 'queued'].includes(String(runtime?.status || '').toLowerCase()))
        .map(([key]) => key);
      for (const job of staleJobs) {
        try {
          const outcome = this.state.reconcileStaleJob({
            jobId: job.job_id, staleMs: this.jobStaleMs, nowMs: Date.now(), liveRuntimeSessionKeys
          });
          if (outcome.status === 'DEFERRED') staleJobsDeferred.push({ jobId: job.job_id, reason: outcome.reason });
        } catch (error) {
          console.warn(`[RecoveryManager] stale Job reconciliation failed job=${job.job_id}: ${error.message}`);
        }
      }

      const terminalRunningTasks = this.state.listTasksForTerminalJobs();
      for (const task of terminalRunningTasks) {
        const runtime = task.openclaw_session_key ? runtimeMap.get(task.openclaw_session_key) : null;
        const runtimeStatus = String(runtime?.status || '').toLowerCase();
        if (runtime && ['active', 'running', 'working', 'queued'].includes(runtimeStatus)) continue;
        // The store method repeats this check atomically before mutating rows.
        // Skip the reconciliation call too when durable provider ownership is
        // unresolved; OpenClaw inventory cannot establish remote cancellation.
        if (this.state.hasUnresolvedDurableExecution(task.job_id)) continue;
        try {
          this.state.reconcileRunningTaskForTerminalJob(task.task_id, 'parent job is already terminal and no live runtime session remains');
        } catch (error) {
          console.warn(`[RecoveryManager] terminal task reconciliation failed task=${task.task_id}: ${error.message}`);
        }
      }
    }
    // Completion reconciliation is task-driven, not session-state-driven.
    // A session may already be STALE when OpenClaw reports it as done; that
    // must never hide a terminal runtime result from the durable task.
    const reconcilableTasks = (jobId
      ? this.state.getRecoveryJobSnapshot(jobId)?.tasks || []
      : this.state.listTasksWithOpenClawSession({ status: 'running' }))
      .filter(t => ['running', 'failed'].includes(String(t.status).toLowerCase())
        && t.openclaw_session_key
        && (isSupportedWorkflow(this.state.getJob(t.job_id)) || isProductionWorkflow(this.state.getJob(t.job_id))));
    for (const task of reconcilableTasks) {
      const runtime = runtimeMap?.get(task.openclaw_session_key);
      const runtimeStatus = String(runtime?.status || '').toLowerCase();
      if (!runtime || !['done', 'timeout', 'failed', 'error'].includes(runtimeStatus)) continue;
      try {
        if (runtimeStatus === 'timeout') {
          const completedTask = task.status === 'running'
            ? this.state.completeTaskByRuntime(task.job_id, {
              runId: task.openclaw_run_id || runtime.runId || null,
              sessionKey: task.openclaw_session_key,
              content: '[RECOVERY FAILURE]\nOpenClaw runtime session timed out before delivering a terminal result.',
              outcome: 'failure'
            })
            : task;
          const session = allSessions.find(s => s.task_id === task.task_id) || this.agentSessions.getSessionByOpenClawKey(task.openclaw_session_key);
          if (session) this.agentSessions.updateAgentSession(session.session_id, { state: 'FAILED' });
          this.state.recordEvent(task.job_id, 'session.runtime_reconciled', {
            taskId: task.task_id,
            sessionId: session?.session_id || null,
            sessionKey: task.openclaw_session_key,
            runId: task.openclaw_run_id || runtime.runId || null,
            outcome: 'failure',
            reason: 'openclaw_runtime_timeout'
          }, `${task.job_id}|${task.task_id}|runtime-timeout`);
          continue;
        }
        const completion = await this.exportTrajectory(task.openclaw_session_key, this.trajectoryTimeoutMs);
        if (!completion) continue;
        const outcome = runtimeStatus === 'done' ? 'success' : 'failure';
        let completedTask = task;
        if (task.status === 'running') {
          completedTask = this.state.completeTaskByRuntime(task.job_id, {
            runId: task.openclaw_run_id || runtime.runId || null,
            sessionKey: task.openclaw_session_key,
            content: completion,
            outcome
          });
        }
        if (completedTask?.status === 'completed' || completedTask?.status === 'failed') {
          // A transcript that says a deterministic production command succeeded
          // cannot promote a previously failed task. Only ExecutionManager's
          // durable session/attempt/exit ledger may recover that task; the
          // supervisor path below handles it when available.
          const reconciledOutcome = completedTask.status === 'completed' ? outcome : 'failure';
          const session = allSessions.find(s => s.task_id === task.task_id) || this.agentSessions.getSessionByOpenClawKey(task.openclaw_session_key);
          if (session) this.agentSessions.updateAgentSession(session.session_id, { state: completedTask.status === 'completed' ? 'TERMINATED' : 'FAILED' });
          this.state.recordEvent(task.job_id, 'session.runtime_reconciled', {
            taskId: task.task_id,
            sessionId: session?.session_id || null,
            sessionKey: task.openclaw_session_key,
            runId: task.openclaw_run_id || runtime.runId || null,
            outcome: reconciledOutcome,
            ...(completedTask.status === 'failed' && outcome === 'success'
              ? { reason: 'runtime transcript cannot replace durable deterministic execution evidence' } : {})
          }, `${task.task_id}|runtime-reconciled|${reconciledOutcome}`);
        }
      } catch (error) {
        console.warn(`[RecoveryManager] task trajectory reconciliation failed task=${task.task_id}: ${error.message}`);
      }
    }
    // Native OpenClaw exec can terminalize a deterministic child before the
    // adapter's tool turn persists ExecutionManager evidence. The child is
    // already terminal, so normal running-task recovery cannot see it. Recovery
    // must respect the immutable plan's batch route: never replay a deterministic
    // task directly when its plan requires a durable batch claim.
    if (this.executionManager) {
      const trace = jobId ? this.state.getRecoveryJobSnapshot(jobId) : null;
      const terminalDeterministicTasks = (trace?.tasks || this.state.listDeterministicTasksInExecutingJobs({ status: 'failed' }))
        .filter(task => ProductionRoles.includes(String(task.role || '').toLowerCase())
          && String(task.status).toLowerCase() === 'failed'
          && isProductionWorkflow(this.state.getJob(task.job_id))
          && !task.execution_session_id
          && !task.execution_status);
      // A task already marked completed but lacking deterministic execution
      // identity is inconsistent evidence, not permission to execute it again.
      // Replaying a successfully completed task could duplicate its side effect;
      // leave it terminal and make the missing provenance explicit for workflow
      // verification/review instead of reopening it through prepareExecution().
      const completedWithoutExecutionIdentity = (trace?.tasks || this.state.listDeterministicTasksInExecutingJobs({ status: 'completed' }))
        .filter(task => String(task.status || '').toLowerCase() === 'completed' &&
          ProductionRoles.includes(String(task.role || '').toLowerCase()) &&
          isProductionWorkflow(this.state.getJob(task.job_id)) &&
          !task.execution_session_id && !task.execution_status);
      for (const task of completedWithoutExecutionIdentity) {
        this.state.recordEvent(task.job_id, 'execution.evidence_recovery_blocked', {
          taskId: task.task_id,
          role: task.role,
          reason: 'completed deterministic task lacks durable execution identity; automatic reopen/replay refused'
        }, `${task.task_id}|completed-task-missing-execution-identity`);
      }
      for (const task of terminalDeterministicTasks) {
        try {
          // Text markers cannot substitute for the task's durable session,
          // numeric attempt, result outcome, and canonical terminal event. This
          // loop is specifically for terminal rows missing ExecutionManager
          // fields, so a regex over old result content must never turn that
          // absence into a successful recovery skip.
          let plan;
          let metadata;
          let plannedTask;
          let batchRoute;
          try {
            plan = this.state.getExecutionPlan(task.job_id);
            metadata = parseStrictJson(task.metadata_json || '{}');
            plannedTask = plan?.children?.find(item => item.id === metadata.workflow_plan_task_id);
            if (!plan || !plannedTask || String(plannedTask.role).toLowerCase() !== String(task.role).toLowerCase()) {
              throw new Error('exact task binding to the immutable execution plan is missing or mismatched');
            }
            batchRoute = resolveTaskBatchRoute(plan, plannedTask);
          } catch (error) {
            this.state.recordEvent(task.job_id, 'execution.evidence_recovery_blocked', {
              taskId: task.task_id,
              role: task.role,
              reason: `immutable execution route could not be verified; automatic direct replay refused: ${error.message}`
            }, `${task.task_id}|execution-recovery-route-unavailable`);
            continue;
          }
          if (batchRoute.required) {
            const durableBatchItem = this.state.getExecutionBatchItemForTask(task.task_id);
            this.state.recordEvent(task.job_id, 'execution.evidence_recovery_blocked', {
              taskId: task.task_id,
              role: task.role,
              reason: durableBatchItem
                ? 'batch-required deterministic task must be reconciled through its existing durable batch; direct task replay refused'
                : 'batch-required deterministic task has no durable batch claim; automatic direct replay refused',
              policyRoute: batchRoute.route,
              policyVersion: batchRoute.policy_version,
              legacyPolicy: batchRoute.legacy === true,
              ...(durableBatchItem ? { batchId: durableBatchItem.batch_id, batchStatus: durableBatchItem.status, batchItemStatus: durableBatchItem.item_status } : {})
            }, `${task.task_id}|batch-required-recovery-blocked`);
            continue;
          }
          const command = expectedCommandFromTask(task) || String(metadata.command || '').trim();
          if (!command) continue;
          // Supported deterministic workflows are bound to an immutable
          // structured command and approved workspace. Re-enter through the
          // authorization-aware API instead of raw shell execution, which would
          // either fail the structured plan contract or risk drifting from its
          // pinned executable/argv/cwd.
          const result = await this.executionManager.executeAuthorizedTask(task.task_id);
          const executionSucceeded = isVerifiedSuccessfulLocalExecution(result, task.task_id);
          const evidence = [
            '<prompt-data>',
            '[ACTUAL TOOL RESULT EVIDENCE]',
            '[ACTUAL EXECUTION EVIDENCE]',
            `task_id: ${task.task_id}`,
            `execution_session_id: ${result.execution_session_id || this.state.getTask(task.task_id)?.execution_session_id || 'N/A'}`,
            `attempt: ${result.execution_attempt || this.state.getTask(task.task_id)?.execution_attempt || 'N/A'}`,
            `exact command: ${result.command || command}`,
            `exit status/code: ${result.exitCode == null ? 'N/A' : result.exitCode}`,
            `execution status: ${result.timedOut ? 'timeout' : executionSucceeded ? 'completed' : 'failed'}`,
            `stdout:\n${result.stdout || ''}`,
            `stderr:\n${result.stderr || ''}`,
            '</prompt-data>'
          ].join('\n');
          this.state.repairResultEvidence(task.task_id, evidence, { outcome: executionSucceeded ? 'success' : 'failure' });
          if (executionSucceeded && this.state.getTask(task.task_id)?.status === 'failed') {
            this.state.reconcileFailedTaskByRuntime(task.task_id, {
              content: evidence,
              runId: task.openclaw_run_id || null,
              sessionKey: task.openclaw_session_key || null
            });
          }
          const verifiedTask = this.state.getTask(task.task_id);
          if (executionSucceeded && verifiedTask?.status === 'completed') {
            const registeredSession = allSessions.find(session => session.task_id === task.task_id) ||
              this.agentSessions.getSessionByTask(task.task_id);
            if (registeredSession && registeredSession.state !== 'TERMINATED') {
              this.agentSessions.updateAgentSession(registeredSession.session_id, { state: 'TERMINATED' });
              this.state.recordEvent(task.job_id, 'session.runtime_reconciled', {
                taskId: task.task_id,
                sessionId: registeredSession.session_id,
                sessionKey: task.openclaw_session_key || null,
                runId: task.openclaw_run_id || null,
                outcome: 'success',
                authority: 'durable_execution_manager_result',
                executionSessionId: verifiedTask.execution_session_id,
                attempt: verifiedTask.execution_attempt
              }, `${task.task_id}|execution-manager-runtime-reconciled|${verifiedTask.execution_session_id}|${verifiedTask.execution_attempt}`);
            }
          }
          this.state.recordEvent(task.job_id, 'execution.evidence_recovered', {
            taskId: task.task_id, role: task.role, command, exitCode: result.exitCode,
            executionSessionId: this.state.getTask(task.task_id)?.execution_session_id || null
          }, `${task.task_id}|execution-evidence-recovered`);
        } catch (error) {
          console.warn(`[RecoveryManager] deterministic evidence recovery failed task=${task.task_id}: ${error.message}`);
        }
      }
    }
    // A provider/runtime failure on a required specialist is retryable only on
    // the SAME durable task/session. Admission happens before dispatch so a
    // failed child cannot create a burst or consume a healthy account outside
    // the durable provider gate. Cap recovery to one retry per task here.
    // Business workflow advancement belongs to LangGraph. RecoveryManager
    // performs only runtime/orphan reconciliation here.
    if (jobId) {
      const trace = this.state.getRecoveryJobSnapshot(jobId);
      const job = trace?.job;
      const cto = trace?.tasks?.find(t => t.task_id === job?.active_task_id && String(t.role).toLowerCase() === 'cto');
      if (job?.state === 'EXECUTING' && isProductionWorkflow(job) && cto?.openclaw_session_key) {
        const runtime = runtimeMap?.get(cto.openclaw_session_key);
        const runtimeStatus = String(runtime?.status || '').toLowerCase();
        // The completion event can win the race and mark the durable CTO task
        // completed before recovery gets a chance to inspect the runtime. The
        // Job may still be EXECUTING, so terminal reconciliation must be driven
        // by Job state + OpenClaw runtime state, not by CTO task status.
        if (runtime && ['done', 'timeout', 'failed', 'error'].includes(runtimeStatus)
          && ['completed', 'failed', 'running'].includes(String(cto.status || '').toLowerCase())) {
          try {
            const completion = await this.exportTrajectory(cto.openclaw_session_key, this.trajectoryTimeoutMs);
            if (/rate[_ -]?limit|too many requests|chưa nhận được phản hồi từ nguồn AI/i.test(String(completion || ''))) {
              const retryAt = this.providerAdmission?.earliestCooldownRetryAt?.() ?? Date.now() + 60_000;
              const healthyProvider = this.providerAdmission?.all?.().some(row =>
                row.provider_id !== 'chatgpt:global'
                && ['READY', 'PROBE'].includes(row.state)
                && Number(row.in_flight || 0) === 0
              );
              if (!healthyProvider) {
                this.state.setProviderWaiting(jobId, Math.max(0, retryAt - Date.now()), 'CTO runtime hit provider rate limit; preserve same durable session');
                this.state.recordEvent(jobId, 'provider.waiting', {
                  role: 'cto', taskId: cto.task_id, sessionKey: cto.openclaw_session_key,
                  retryAt: new Date(retryAt).toISOString(), reason: 'cto_runtime_rate_limit'
                }, jobId + '|cto-rate-limit|' + new Date(retryAt).toISOString());
                return { staleSessions: [], staleExecutions: [], providerWaiting: true };
              }
              this.state.clearProviderWaiting(jobId);
            }
            const children = (trace.tasks || []).filter(t => t.parent_task_id === cto.task_id);
            const required = ProductionRoles.map(role => children.find(t => String(t.role).toLowerCase() === role));
            const childEvidenceValid = required.every(child => {
              if (!child || child.status !== 'completed') return false;
              const result = this.state.getLatestTaskResult(child.task_id);
              return result?.outcome === 'success'
                && /\[ACTUAL TOOL RESULT EVIDENCE\]/i.test(String(result.content || ''))
                && /node\s+--check\s+\/home\/long\/work\/chatgpt-adapter\/(?:server\.js|test-tool-turn\.js)/i.test(String(result.content || ''))
                && hasCanonicalSuccessfulExitMarker(result.content);
            });
            const synthesisValid = childEvidenceValid && Boolean(String(completion || '').trim());
            if (childEvidenceValid && synthesisValid) {
              this.state.completeTaskByRuntime(jobId, {
                runId: cto.openclaw_run_id || runtime.runId || null,
                sessionKey: cto.openclaw_session_key,
                content: completion,
                outcome: 'success'
              });
              const reportId = this.state.createReport(jobId, 'executive_summary', completion);
              const deliveryChannel = 'slack';
              const deliveryTarget = process.env.SLACK_WAR_ROOM || 'C0C3RJKNKPG';
              this.state.claimDelivery(jobId, reportId, deliveryChannel, deliveryTarget);
              this.state.terminalizeJob(jobId, {
                outcome: 'success',
                reportId,
                deliveryChannel,
                deliveryTarget,
                content: completion
              });
              const session = this.agentSessions.getSessionByOpenClawKey(cto.openclaw_session_key);
              if (session) this.agentSessions.updateAgentSession(session.session_id, { state: 'TERMINATED' });
              this.state.recordEvent(jobId, 'job.runtime_reconciled', {
                taskId: cto.task_id, sessionKey: cto.openclaw_session_key, runId: cto.openclaw_run_id || runtime.runId || null, outcome: 'success'
              }, `${jobId}|job-runtime-reconciled|success`);
            }
            else if (runtimeStatus === 'done' && required.some(child => !child)) {
              // Missing specialist is a resumable graph state. Do not convert a
              // terminal model turn into business-job failure: LangGraph will
              // resume the SAME CTO session and request only the missing child.
              this.state.recordEvent(jobId, 'job.runtime_reconciled', {
                taskId: cto.task_id, sessionKey: cto.openclaw_session_key, runId: cto.openclaw_run_id || runtime.runId || null,
                outcome: 'waiting', reason: 'missing required specialist child'
              }, jobId + '|job-runtime-reconciled|missing-child|waiting');
            }
            else if (runtimeStatus === 'done'
              && required.every(child => child && ['completed', 'failed', 'cancelled'].includes(String(child.status).toLowerCase()))) {
              // Terminal model turn is not terminal business state. Keep the
              // Job open until deterministic evidence/synthesis gates pass.
              this.state.recordEvent(jobId, 'job.runtime_reconciled', {
                taskId: cto.task_id, sessionKey: cto.openclaw_session_key, runId: cto.openclaw_run_id || runtime.runId || null,
                outcome: 'waiting', reason: 'required child evidence or CTO synthesis not yet valid'
              }, `${jobId}|job-runtime-reconciled|evidence-waiting`);
            }
          } catch (error) {
            console.warn(`[RecoveryManager] CTO trajectory reconciliation failed job=${jobId}: ${error.message}`);
          }
        }
      }
    }
    const stale = [];
    for (const session of sessions) {
      const runtime = runtimeMap?.get(session.openclaw_session_key);
      const runtimeStatus = String(runtime?.status || '').toLowerCase();
      if (runtime && ['done', 'failed', 'error'].includes(runtimeStatus)) {
        try {
          const completion = await this.exportTrajectory(session.openclaw_session_key, this.trajectoryTimeoutMs);
          if (completion) {
            const task = this.state.getTask(session.task_id);
            if (task && ['pending', 'running'].includes(String(task.status).toLowerCase())) {
              const outcome = runtimeStatus === 'done' ? 'success' : 'failure';
              const completedTask = this.state.completeTaskByRuntime(task.job_id, {
                runId: task.openclaw_run_id || runtime.runId || null,
                sessionKey: session.openclaw_session_key,
                content: completion,
                outcome
              });
              if (completedTask?.status === 'completed' || completedTask?.status === 'failed') {
                this.agentSessions.updateAgentSession(session.session_id, {
                  state: completedTask.status === 'completed' ? 'TERMINATED' : 'FAILED'
                });
                this.state.recordEvent(task.job_id, 'session.runtime_reconciled', {
                  taskId: task.task_id,
                  sessionId: session.session_id,
                  sessionKey: session.openclaw_session_key,
                  runId: task.openclaw_run_id || runtime.runId || null,
                  outcome
                }, `${session.session_id}|runtime-reconciled|${outcome}`);
              }
            }
          }
        } catch (error) {
          console.warn(`[RecoveryManager] trajectory reconciliation failed session=${session.openclaw_session_key}: ${error.message}`);
        }
      }
      const runtimeFresh = runtime && !['done', 'failed', 'error', 'archived'].includes(String(runtime.status || '').toLowerCase());
      const dbFresh = Date.now() - new Date(session.last_activity_at).getTime() <= this.sessionStaleMs;
      if (!runtimeFresh && !dbFresh) {
        stale.push(this.agentSessions.markAgentSessionStale(session.session_id, {
          reason: runtime ? `OpenClaw status=${runtime.status || 'unknown'}` : runtimeSessions.error ? 'OpenClaw session inventory unavailable and heartbeat stale' : 'OpenClaw session key absent from runtime inventory'
        }));
      }
    }

    const tasks = (jobId ? this.state.getRecoveryJobSnapshot(jobId)?.tasks : this.state.listRunningExecutionTasks()) || [];
    const execution = [];
    for (const task of tasks.filter(t => t.execution_status === 'running')) {
      const metadata = parseStrictJson(task.metadata_json || '{}');
      const alive = await tmuxExists(metadata.tmuxName);
      const age = Date.now() - new Date(task.execution_started_at || task.updated_at).getTime();
      if (!alive && age > this.executionStaleMs) {
        if (typeof task.execution_attempt !== 'number' || !Number.isSafeInteger(task.execution_attempt) || task.execution_attempt < 1 ||
            typeof task.execution_session_id !== 'string' || !task.execution_session_id ||
            typeof metadata.command !== 'string' || !metadata.command.trim()) {
          throw new Error(`cannot terminalize stale execution with malformed durable task/session/attempt/command identity: ${task.task_id}`);
        }
        const reason = 'execution supervisor/session missing; recovery terminalized the orphaned attempt as failed';
        // WorkflowStatePort keeps task/attempt/batch/event writes in one
        // named recovery savepoint, so a partial crash cannot strand the batch.
        const recovered = this.state.recoverStaleExecution({ task, reason });
        execution.push(recovered.terminal);
      }
    }
    return { staleSessions: stale.filter(Boolean), staleExecutions: execution, recoveredUnstartedBatchClaims, staleJobsDeferred,
      openclawInventoryAvailable: !runtimeSessions.error };
  }

}

export { listOpenClawSessions, tmuxExists };
export { extractTrajectoryExecutionEvidence, expectedCommandFromTask, hasVerifiedSuccessfulRuntimeEvidence };
