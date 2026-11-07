import crypto from 'node:crypto';
import { evaluateLangGraph, LangGraphActions } from './langgraph-orchestrator.js';
import { WorkflowPhase } from './workflow/phases.js';
import { createWorkflowStatePort } from './workflow-state-port.js';
import { createWorkflowControlPort } from './workflow-control-port.js';

export class LangGraphControlLoop {
  constructor({ store = null, statePort = null, workflowControlPort = null, scheduler, provider, graph = evaluateLangGraph } = {}) {
    if (!(store || (statePort && workflowControlPort)) || !scheduler || !provider) {
      throw new Error('LangGraphControlLoop requires WorkflowStatePort, WorkflowControlPort, scheduler and provider');
    }
    this.state = createWorkflowStatePort(statePort || store);
    this.workflow = workflowControlPort || createWorkflowControlPort(store);
    this.scheduler = scheduler;
    this.provider = provider;
    this.graph = graph;
  }

  _activeProviderRuns(jobId) {
    return this.state.listActiveProviderRunsForJob(jobId);
  }

  _recordQuarantinedObservation(run, result) {
    const resultBytes = JSON.stringify(result);
    const resultSha256 = crypto.createHash('sha256').update(resultBytes).digest('hex');
    const payload = {
      taskId: run.task_id, leaseId: run.lease_id, attempt: Number(run.lease_attempt),
      providerRunId: String(run.provider_run_id), resultStatus: result.status,
      resultSha256, evidenceHash: result.evidence_verification?.evidence_hash || null,
      workerReportedOutputCommit: result.output_commit || null,
      outputCommitProvenance: result.evidence_verification?.output_commit_provenance || 'unknown',
      applied: false, reconciliationRequired: true
    };
    const dedupeKey = `${run.lease_id}|${run.provider_run_id}|${resultSha256}`;
    const eventId = this.state.recordEvent(run.job_id, 'task.execution.quarantine_observed', payload, dedupeKey);
    const row = this.state.getEvent(eventId);
    if (!row || row.job_id !== run.job_id || row.type !== 'task.execution.quarantine_observed' ||
        row.payload_json !== JSON.stringify(payload)) {
      throw new Error('quarantined provider result observation failed exact durable event readback');
    }
    return { resultSha256, evidenceHash: payload.evidenceHash };
  }

  _recordQuarantinedCollectionFailure(run, error) {
    const detail = String(error?.message || error);
    const errorSha256 = crypto.createHash('sha256').update(detail).digest('hex');
    const payload = {
      taskId: run.task_id, leaseId: run.lease_id, attempt: Number(run.lease_attempt),
      providerRunId: String(run.provider_run_id), collectionErrorSha256: errorSha256,
      errorCode: String(error?.code || error?.name || 'COLLECTION_ERROR').slice(0, 100),
      applied: false, reconciliationRequired: true
    };
    const dedupeKey = `${run.lease_id}|${run.provider_run_id}|collection-error|${errorSha256}`;
    const eventId = this.state.recordEvent(run.job_id, 'task.execution.quarantine_collection_failed', payload, dedupeKey);
    const row = this.state.getEvent(eventId);
    if (!row || row.job_id !== run.job_id || row.type !== 'task.execution.quarantine_collection_failed' ||
        row.payload_json !== JSON.stringify(payload)) {
      throw new Error('quarantined provider collection failure failed exact durable event readback');
    }
    return errorSha256;
  }

  _recordQuarantinedStatusFailure(run, error) {
    const detail = String(error?.message || error);
    const statusErrorSha256 = crypto.createHash('sha256').update(detail).digest('hex');
    const payload = {
      taskId: run.task_id, leaseId: run.lease_id, attempt: Number(run.lease_attempt),
      providerRunId: String(run.provider_run_id), statusErrorSha256,
      errorCode: String(error?.code || error?.name || 'STATUS_ERROR').slice(0, 100),
      applied: false, reconciliationRequired: true
    };
    const dedupeKey = `${run.lease_id}|${run.provider_run_id}|status-error|${statusErrorSha256}`;
    const eventId = this.state.recordEvent(run.job_id, 'task.execution.quarantine_status_failed', payload, dedupeKey);
    const row = this.state.getEvent(eventId);
    if (!row || row.job_id !== run.job_id || row.type !== 'task.execution.quarantine_status_failed' ||
        row.payload_json !== JSON.stringify(payload)) {
      throw new Error('quarantined provider status failure failed exact durable event readback');
    }
    return statusErrorSha256;
  }

  async reconcile(jobId) {
    const active = this._activeProviderRuns(jobId);
    const reconciled = [];
    for (const run of active) {
      const quarantined = run.lease_state !== 'ACTIVE';
      if (!quarantined) {
        const heartbeat = this.state.heartbeatTaskLease(run.lease_id, {
          workerId: run.worker_id, ttlMs: this.scheduler.leaseTtlMs || 60_000
        });
        if (!heartbeat.ok) {
          reconciled.push({ taskId: run.task_id, leaseId: run.lease_id,
            status: 'REMOTE_EFFECT_UNCERTAIN_REQUIRES_RECONCILIATION', reason: heartbeat.reason });
          continue;
        }
      }
      let status;
      try {
        status = await this.provider.getStatus(run.provider_run_id);
      } catch (error) {
        if (!quarantined) this.state.expireTaskLease(run.lease_id, { reason: `provider_status_uncertain: ${error.message}` });
        const latestLease = this.state.getTaskLease(run.lease_id);
        if (quarantined || latestLease?.state === 'FAILED') {
          const statusErrorSha256 = this._recordQuarantinedStatusFailure(run, error);
          reconciled.push({ taskId: run.task_id, leaseId: run.lease_id,
            status: 'QUARANTINED_STATUS_REQUIRES_RECONCILIATION', statusErrorSha256 });
        } else {
          reconciled.push({ taskId: run.task_id, leaseId: run.lease_id,
            status: 'STATUS_PENDING_RECONCILIATION', error: String(error?.message || error) });
        }
        continue;
      }
      if (status.state !== 'COMPLETED' && String(status.status || '').toUpperCase() !== 'COMPLETED') {
        if (quarantined) reconciled.push({ taskId: run.task_id, leaseId: run.lease_id,
          status: 'QUARANTINED_REMOTE_EFFECT_STILL_UNRESOLVED', providerStatus: status.state || status.status || 'UNKNOWN' });
        continue;
      }
      let result;
      try {
        result = await this.provider.collectResult(run.provider_run_id);
      } catch (error) {
        if (!quarantined) this.state.expireTaskLease(run.lease_id, { reason: `provider_result_collection_uncertain: ${error.message}` });
        if (quarantined || this.state.getTaskLease(run.lease_id)?.state === 'FAILED') {
          const errorSha256 = this._recordQuarantinedCollectionFailure(run, error);
          reconciled.push({ taskId: run.task_id, leaseId: run.lease_id,
            status: 'QUARANTINED_COLLECTION_REQUIRES_RECONCILIATION', errorSha256 });
        } else {
          reconciled.push({ taskId: run.task_id, leaseId: run.lease_id,
            status: 'COLLECTION_PENDING_RECONCILIATION', error: String(error?.message || error) });
        }
        continue;
      }
      if (quarantined || this.state.getTaskLease(run.lease_id)?.state === 'FAILED') {
        const observation = this._recordQuarantinedObservation(run, result);
        reconciled.push({ taskId: run.task_id, leaseId: run.lease_id,
          status: 'QUARANTINED_RESULT_OBSERVED_NOT_APPLIED', ...observation });
        continue;
      }
      const applied = this.state.applyVerifiedExecutionResult(result);
      if (applied.status === 'REJECTED' && applied.reason === 'output_commit_attestation_required') {
        // The remote run is complete, but its output revision is still only a
        // worker claim. Stop renewing the lease and quarantine the observation;
        // leaving it ACTIVE would repeatedly collect the same result forever.
        this.state.expireTaskLease(run.lease_id, { reason: 'output_commit_attestation_required' });
        const latestLease = this.state.getTaskLease(run.lease_id);
        if (latestLease?.state === 'FAILED' &&
            String(latestLease.last_error || '').startsWith('REMOTE_EFFECT_UNCERTAIN_REQUIRES_RECONCILIATION:')) {
          const observation = this._recordQuarantinedObservation(run, result);
          reconciled.push({ taskId: run.task_id, leaseId: run.lease_id,
            status: 'QUARANTINED_RESULT_OBSERVED_NOT_APPLIED', reason: applied.reason, ...observation });
        } else {
          reconciled.push({ taskId: run.task_id, leaseId: run.lease_id,
            status: 'OUTPUT_COMMIT_ATTESTATION_REQUIRED', reason: applied.reason, quarantineApplied: false });
        }
        continue;
      }
      reconciled.push({ taskId: run.task_id, leaseId: run.lease_id, status: applied.status, result });
    }
    return reconciled;
  }

  async tick({ jobId, inputCommit, event = 'control.tick', hooks = {} } = {}) {
    const job = this.workflow.getJob(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    this.state.reapExpiredTaskLeases({ jobId });
    const dispatchReconciliation = typeof this.scheduler.reconcileProviderDispatches === 'function'
      ? await this.scheduler.reconcileProviderDispatches()
      : [];
    const reconciled = await this.reconcile(jobId);
    const refreshedJob = this.workflow.getJob(jobId);
    const tasks = this.state.listTasksForJob(jobId);
    const results = this.state.listResultsForJob(jobId);
    const plan = this.workflow.getExecutionPlan(jobId);
    const decision = await this.graph({
      job: refreshedJob, tasks, results, plan,
      runtime: this.workflow.getWorkflowRuntimeState(jobId),
      event, persist: true, workflowControlPort: this.workflow,
      executeTask: async task => this.scheduler.dispatchTask(task, { inputCommit }),
      ...hooks
    });
    if (decision.action === LangGraphActions.RUN_CHILDREN) {
      const dispatched = await this.scheduler.dispatchPending({ inputCommit });
      return { job: this.workflow.getJob(jobId), decision, reconciled, dispatched, dispatchReconciliation };
    }
    return { job: this.workflow.getJob(jobId), decision, reconciled, dispatched: [], dispatchReconciliation };
  }
}

export { WorkflowPhase };
