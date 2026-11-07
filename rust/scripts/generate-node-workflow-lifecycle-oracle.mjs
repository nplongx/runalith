#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rustRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(rustRoot, '..');
const defaultOutput = path.join(rustRoot, 'crates/runalith-domain/tests/fixtures/node-workflow-lifecycle-v1.json');
const outputPath = path.resolve(process.argv[2] || defaultOutput);
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runalith-node-lifecycle-oracle-'));

try {
  fs.chmodSync(temporaryRoot, 0o700);
  process.env.WORKFLOW_DATA_DIR = temporaryRoot;
  process.env.WORKFLOW_DB = path.join(temporaryRoot, 'workflow.db');

  const modulePath = path.join(repositoryRoot, 'job-store.js');
  const { WorkflowStore } = await import(pathToFileURL(modulePath).href);
  const store = new WorkflowStore();
  try {
    const jobStates = [
      'IDLE', 'PROPOSED', 'DISCUSSING', 'APPROVED', 'EXECUTING',
      'COMPLETED', 'FAILED', 'CANCELLED', 'CUSTOM'
    ];
    const jobStatuses = ['active', 'completed', 'failed', 'cancelled'];
    const jobTransitionCases = [];
    let jobIndex = 0;

    for (const currentState of jobStates) {
      for (const currentStatus of jobStatuses) {
        for (const nextState of jobStates) {
          for (const nextStatus of jobStatuses) {
            const job = store.createJob({
              conversationKey: `node-job-transition-${jobIndex}`,
              title: 'Node lifecycle oracle'
            });
            store.db.prepare('UPDATE jobs SET state=?,status=? WHERE job_id=?')
              .run(currentState, currentStatus, job.job_id);

            let outcome;
            let errorCode = null;
            try {
              const result = store.transition(job.job_id, nextState, nextStatus);
              outcome = result === null ? 'MISSING' : 'APPLIED';
              const currentTerminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(currentState.toUpperCase()) ||
                ['completed', 'failed', 'cancelled'].includes(currentStatus.toLowerCase());
              if (currentTerminal && result) outcome = 'IDEMPOTENT_TERMINAL';
            } catch (error) {
              outcome = 'REJECTED';
              const message = String(error?.message || error);
              if (message.startsWith('cannot transition terminal Job ')) errorCode = 'TERMINAL_REOPEN';
              else if (message.startsWith('illegal active Job state transition ')) errorCode = 'ILLEGAL_ACTIVE';
              else throw new Error(`unclassified Node Job transition ${currentState}/${currentStatus} -> ${nextState}/${nextStatus}: ${message}`, { cause: error });
            }

            const currentTerminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(currentState.toUpperCase()) ||
              ['completed', 'failed', 'cancelled'].includes(currentStatus.toLowerCase());
            jobTransitionCases.push({
              current_state: currentState,
              current_status: currentStatus,
              next_state: nextState,
              next_status: nextStatus,
              outcome,
              error_code: errorCode,
              requires_provider_quiescence: !currentTerminal && (
                ['COMPLETED', 'FAILED', 'CANCELLED'].includes(nextState.toUpperCase()) ||
                ['completed', 'failed', 'cancelled'].includes(nextStatus.toLowerCase())
              )
            });
            jobIndex++;
          }
        }
      }
    }

    const workflowPhases = [
      'PROPOSED', 'APPROVED', 'SPAWN_CTO', 'ASSIGN_CHILDREN', 'RUN_CHILDREN', 'WAIT',
      'VALIDATE_EVIDENCE', 'SYNTHESIZE', 'TERMINALIZE', 'PROJECT', 'COMPLETED', 'FAILED'
    ];
    const workflowPhaseCases = [];

    for (const currentPhase of workflowPhases) {
      for (const nextPhase of workflowPhases) {
        const job = store.createJob({
          conversationKey: `node-workflow-phase-${workflowPhaseCases.length}`,
          title: 'Node workflow phase oracle'
        });
        store.setWorkflowRuntimeState(job.job_id, currentPhase, { attempt: 7 });
        const before = store.db.prepare(
          'SELECT COUNT(*) AS count FROM workflow_events WHERE job_id=?'
        ).get(job.job_id).count;

        let outcome;
        let errorCode = null;
        try {
          store.transitionWorkflowPhase(job.job_id, nextPhase, { attempt: 7 });
          outcome = currentPhase === nextPhase ? 'IDEMPOTENT' : 'APPLIED';
        } catch (error) {
          outcome = 'REJECTED';
          const message = String(error?.message || error);
          if (message.startsWith('invalid workflow transition: ')) errorCode = 'INVALID_PHASE_TRANSITION';
          else throw new Error(`unclassified Node phase transition ${currentPhase} -> ${nextPhase}: ${message}`, { cause: error });
        }

        const persisted = store.getWorkflowRuntimeState(job.job_id);
        const after = store.db.prepare(
          'SELECT COUNT(*) AS count FROM workflow_events WHERE job_id=?'
        ).get(job.job_id).count;
        workflowPhaseCases.push({
          current_phase: currentPhase,
          next_phase: nextPhase,
          outcome,
          error_code: errorCode,
          persisted_phase: persisted.phase,
          workflow_event_delta: after - before
        });
      }
    }

    const fixture = {
      schema_version: 1,
      source: 'src/runtime/job-store.js::WorkflowStore.transition + transitionWorkflowPhase',
      generated_by_node: true,
      job_states: jobStates,
      job_statuses: jobStatuses,
      job_transition_cases: jobTransitionCases,
      workflow_phases: workflowPhases,
      workflow_phase_cases: workflowPhaseCases
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o644 });
    const summarize = cases => Object.fromEntries(
      Object.entries(Object.groupBy(cases, item => item.outcome)).map(([key, values]) => [key, values.length])
    );
    console.log(JSON.stringify({
      output: outputPath,
      job_transition_cases: jobTransitionCases.length,
      workflow_phase_cases: workflowPhaseCases.length,
      job_outcomes: summarize(jobTransitionCases),
      phase_outcomes: summarize(workflowPhaseCases)
    }, null, 2));
  } finally {
    store.db.close();
  }
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
