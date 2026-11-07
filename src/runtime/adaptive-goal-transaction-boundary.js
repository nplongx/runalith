/**
 * Named SQLite transaction boundaries for AGG operations that still compose
 * WorkflowStore-owned lifecycle rows/events with AGG source/evidence checks.
 *
 * This is intentionally not a general transaction manager: each public method
 * names one existing consistency unit and only the composition use case knows
 * when it has completed the corresponding read/validate/write protocol.
 */
export class AdaptiveGoalTransactionBoundary {
  #db;

  constructor(workflowStore) {
    const db = workflowStore?.db;
    if (!db || typeof db.exec !== 'function') {
      throw new TypeError('AdaptiveGoalTransactionBoundary requires WorkflowStore SQLite transaction support');
    }
    this.#db = db;
  }

  #begin(mode) { this.#db.exec(mode); }
  #commit() { this.#db.exec('COMMIT'); }
  #rollback() { try { this.#db.exec('ROLLBACK'); } catch {} }

  beginPlanGraphProposalCreate() { this.#begin('BEGIN IMMEDIATE'); }
  commitPlanGraphProposalCreate() { this.#commit(); }
  rollbackPlanGraphProposalCreate() { this.#rollback(); }

  beginExecutionGraphProposalCreate() { this.#begin('BEGIN IMMEDIATE'); }
  commitExecutionGraphProposalCreate() { this.#commit(); }
  rollbackExecutionGraphProposalCreate() { this.#rollback(); }

  beginExecutionGraphProposalRead() { this.#begin('BEGIN'); }
  commitExecutionGraphProposalRead() { this.#commit(); }
  rollbackExecutionGraphProposalRead() { this.#rollback(); }

  beginExecutionPlanCandidateCreate() { this.#begin('BEGIN IMMEDIATE'); }
  commitExecutionPlanCandidateCreate() { this.#commit(); }
  rollbackExecutionPlanCandidateCreate() { this.#rollback(); }

  beginExecutionPlanCandidateRead() { this.#begin('BEGIN'); }
  commitExecutionPlanCandidateRead() { this.#commit(); }
  rollbackExecutionPlanCandidateRead() { this.#rollback(); }

  beginExecutionReadinessPreview() { this.#begin('BEGIN'); }
  commitExecutionReadinessPreview() { this.#commit(); }
  rollbackExecutionReadinessPreview() { this.#rollback(); }

  beginSandboxActionClaim() { this.#begin('BEGIN IMMEDIATE'); }
  commitSandboxActionClaim() { this.#commit(); }
  rollbackSandboxActionClaim() { this.#rollback(); }
}

export function createAdaptiveGoalTransactionBoundary(workflowStore) {
  return new AdaptiveGoalTransactionBoundary(workflowStore);
}
