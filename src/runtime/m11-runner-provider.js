import crypto from 'node:crypto';
import { createExecutionResult, validateExecutionRequest } from './execution-contract.js';
import { createWorkflowStatePort } from './workflow-state-port.js';

const ROLE_OUTPUTS = Object.freeze({
  'product-owner': { scope: 'M11 runner-owned product scope', acceptance_criteria: ['runner dispatch is durable', 'no local specialist session is created'], non_goals: ['local OpenClaw child spawning'] },
  researcher: { findings: ['workflow task is executed by the runner owner'], sources: ['durable workflow plan'], limitations: ['M11 provider is deterministic test mode'] },
  architect: { components: ['local coordinator', 'runner worker'], interfaces: ['durable execution request'], failure_modes: ['lease expiry', 'provider failure'], implementation_boundary: 'runner owns task execution; local owns orchestration' },
  engineer: { summary: 'Runner-owned engineering execution completed.', files_changed: [], verification: ['runner contract verified'], execution: { session_id: 'runner-session', exit_code: 0, command: 'm11-mock-agent', verified_at: new Date().toISOString() } },
  security: { threats: [], findings: [], decision: 'accept' },
  qa: { checks: ['runner dispatch'], results: ['passed'], decision: 'accept' },
  platform: { runtime: { status: 'reviewed' }, deployment: { status: 'reviewed' }, recovery: { status: 'reviewed' } },
  writer: { summary: 'Runner-owned workflow documentation is complete.', user_facing_changes: [], verification: ['runner contract verified'] },
  reviewer: { review: { requirementsSatisfied: true, architectureConformant: true, securityAccepted: true, qaAccepted: true, platformAccepted: true, documentationAccepted: true, implementationIssues: [], evidenceIssues: [], securityIssues: [], blockingIssues: [], decision: 'accept' } },
  cto: { decision: 'approve', summary: 'M11 runner-owned native workflow accepted.', accepted_requirements: ['runner owns specialist execution'], unresolved_risks: [], follow_up_actions: [], evidence_refs: [] }
});

export class M11RunnerProvider {
  constructor({ now = () => Date.now(), runnerId = 'm11-mock-runner', store = null, statePort = null } = {}) {
    this.now = now;
    this.runnerId = runnerId;
    this.runs = new Map();
    this.state = (statePort || store) ? createWorkflowStatePort(statePort || store) : null;
    this.state?.ensureProviderExecutionSchema();
  }
  async dispatch(request) {
    const { dispatch_key: _dispatchKey, ...executionRequest } = request;
    validateExecutionRequest(executionRequest);
    const providerRunId = `m11-${crypto.randomUUID()}`;
    const output = ROLE_OUTPUTS[request.role] || { summary: `runner completed role ${request.role}` };
    const started = new Date(this.now()).toISOString();
    const finished = new Date(this.now() + 1).toISOString();
    const result = createExecutionResult({
      job_id: executionRequest.job_id, task_id: executionRequest.task_id, lease_id: executionRequest.lease_id, attempt: executionRequest.attempt,
      status: 'SUCCEEDED', input_commit: executionRequest.input_commit, output_commit: request.input_commit, exit_code: 0,
      provider_run_id: providerRunId, evidence_artifact: `m11-runner-${providerRunId}`, evidence_refs: ['runner-output.json'],
      started_at: started, finished_at: finished, error: null,
      agent_output: JSON.stringify(output),
      runner_id: this.runnerId
    });
    this.runs.set(providerRunId, { request, result, state: 'COMPLETED' });
    this.state?.persistProviderRun({
      provider_run_id: providerRunId, job_id: executionRequest.job_id, task_id: executionRequest.task_id,
      lease_id: executionRequest.lease_id, attempt: executionRequest.attempt, owner_epoch: null,
      input_commit: executionRequest.input_commit, workflow: 'm11-mock-runner', ref: 'local',
      state: 'COMPLETED', conclusion: 'success', html_url: null,
      artifact_id: result.evidence_artifact, output_commit: request.input_commit,
      run_attempt: null, created_at: started
    }, { provider: 'm11-mock-runner', updatedAt: finished });
    return { provider_run_id: providerRunId, job_id: request.job_id, task_id: request.task_id, lease_id: request.lease_id, attempt: request.attempt, input_commit: request.input_commit, workflow: 'm11-mock-runner', ref: 'local', state: 'COMPLETED', conclusion: 'success', created_at: started };
  }
  async getStatus(providerRunId) {
    const run = this.runs.get(String(providerRunId));
    if (!run) throw new Error(`M11 runner run not found: ${providerRunId}`);
    return { provider_run_id: String(providerRunId), state: 'COMPLETED', status: 'COMPLETED', conclusion: 'success', created_at: run.result.started_at, updated_at: run.result.finished_at };
  }
  async collectResult(providerRunId) {
    const run = this.runs.get(String(providerRunId));
    if (!run) throw new Error(`M11 runner run not found: ${providerRunId}`);
    return run.result;
  }
  async reconcileDispatchIntent() { return null; }
}
