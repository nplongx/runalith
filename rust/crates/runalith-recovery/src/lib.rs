//! Conservative, side-effect-free recovery decisions.
//!
//! This crate decides whether a stale executing workflow is eligible for a
//! separate atomic terminalization command. It never changes workflow state,
//! retries work, or infers task death from missing lease/execution metadata.

use std::collections::BTreeSet;

pub mod manager;

/// Durable workflow lifecycle state observed by recovery.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkflowLifecycle {
    /// Workflow is executing and may be considered for stale recovery.
    Executing,
    /// Workflow is in any other state.
    Other,
}

/// Whether the external runtime inventory was obtained authoritatively.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeInventory {
    /// A complete inventory of currently live session keys.
    Authoritative(Vec<String>),
    /// Inventory could not be obtained or validated.
    Unavailable,
}

/// Result of querying durable execution ownership.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurableOwnership {
    /// At least one active lease exists.
    ActiveLease,
    /// At least one provider outcome remains unresolved.
    UnresolvedProviderOutcome,
    /// Ownership queries completed and found no active lease or unresolved
    /// provider outcome. This is not, by itself, proof that a task is dead.
    NoKnownOwner,
    /// Ownership could not be established; recovery must defer.
    Unknown,
}

/// Evidence required to evaluate stale-workflow recovery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaleWorkflowEvidence {
    /// Current durable workflow state.
    pub lifecycle: WorkflowLifecycle,
    /// Last durable workflow update, Unix milliseconds.
    pub updated_at_ms: i64,
    /// Current time from the caller's clock, Unix milliseconds.
    pub now_ms: i64,
    /// Minimum age before stale recovery may be considered.
    pub stale_after_ms: i64,
    /// Runtime inventory result.
    pub runtime_inventory: RuntimeInventory,
    /// Session keys attached to tasks in this workflow.
    pub task_session_keys: Vec<String>,
    /// Durable lease/provider ownership observation.
    pub durable_ownership: DurableOwnership,
}

/// Why automatic stale-workflow terminalization is not currently eligible.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryBlocker {
    /// Workflow is not executing.
    NotExecuting,
    /// Timestamp or stale threshold is invalid.
    InvalidClockOrThreshold,
    /// Workflow has not exceeded its stale threshold.
    NotStale,
    /// Runtime inventory is not authoritative.
    RuntimeInventoryUnavailable,
    /// At least one task has a live runtime session.
    LiveRuntimeSession,
    /// An active durable lease still owns execution.
    ActiveLease,
    /// Provider outcome remains unresolved.
    UnresolvedProviderOutcome,
    /// Durable ownership could not be established.
    OwnershipUnknown,
}

/// Conservative result. EligibleForAtomicTerminalization is permission to
/// attempt a separate transaction that must repeat all checks atomically.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryDecision {
    /// A separate atomic terminalization command may revalidate and proceed.
    EligibleForAtomicTerminalization,
    /// Recovery must leave durable state unchanged.
    Deferred(RecoveryBlocker),
}

/// Evaluate the Node runtime's stale-job safety gate without performing I/O.
///
/// The caller must re-read workflow state, task session links, active leases,
/// and unresolved provider outcomes inside the terminalization transaction.
/// This decision is not a lease-expiry rule and must not be used to reopen or
/// replay individual tasks.
#[must_use]
pub fn evaluate_stale_workflow(evidence: &StaleWorkflowEvidence) -> RecoveryDecision {
    if evidence.lifecycle != WorkflowLifecycle::Executing {
        return RecoveryDecision::Deferred(RecoveryBlocker::NotExecuting);
    }
    if evidence.updated_at_ms < 0 || evidence.now_ms < 0 || evidence.stale_after_ms < 1 {
        return RecoveryDecision::Deferred(RecoveryBlocker::InvalidClockOrThreshold);
    }
    if evidence.now_ms.saturating_sub(evidence.updated_at_ms) <= evidence.stale_after_ms {
        return RecoveryDecision::Deferred(RecoveryBlocker::NotStale);
    }

    let RuntimeInventory::Authoritative(live_keys) = &evidence.runtime_inventory else {
        return RecoveryDecision::Deferred(RecoveryBlocker::RuntimeInventoryUnavailable);
    };
    let live: BTreeSet<&str> = live_keys.iter().map(String::as_str).collect();
    if evidence
        .task_session_keys
        .iter()
        .any(|key| live.contains(key.as_str()))
    {
        return RecoveryDecision::Deferred(RecoveryBlocker::LiveRuntimeSession);
    }

    match evidence.durable_ownership {
        DurableOwnership::ActiveLease => RecoveryDecision::Deferred(RecoveryBlocker::ActiveLease),
        DurableOwnership::UnresolvedProviderOutcome => {
            RecoveryDecision::Deferred(RecoveryBlocker::UnresolvedProviderOutcome)
        }
        DurableOwnership::Unknown => RecoveryDecision::Deferred(RecoveryBlocker::OwnershipUnknown),
        DurableOwnership::NoKnownOwner => RecoveryDecision::EligibleForAtomicTerminalization,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evidence() -> StaleWorkflowEvidence {
        StaleWorkflowEvidence {
            lifecycle: WorkflowLifecycle::Executing,
            updated_at_ms: 1_000,
            now_ms: 3_000,
            stale_after_ms: 1_000,
            runtime_inventory: RuntimeInventory::Authoritative(vec![]),
            task_session_keys: vec!["session-a".into()],
            durable_ownership: DurableOwnership::NoKnownOwner,
        }
    }

    #[test]
    fn permits_only_fully_reconciled_stale_workflow_for_atomic_recheck() {
        assert_eq!(
            evaluate_stale_workflow(&evidence()),
            RecoveryDecision::EligibleForAtomicTerminalization
        );
    }

    #[test]
    fn missing_runtime_inventory_never_proves_session_death() {
        let mut input = evidence();
        input.runtime_inventory = RuntimeInventory::Unavailable;
        assert_eq!(
            evaluate_stale_workflow(&input),
            RecoveryDecision::Deferred(RecoveryBlocker::RuntimeInventoryUnavailable)
        );
    }

    #[test]
    fn live_runtime_session_blocks_terminalization() {
        let mut input = evidence();
        input.runtime_inventory = RuntimeInventory::Authoritative(vec!["session-a".into()]);
        assert_eq!(
            evaluate_stale_workflow(&input),
            RecoveryDecision::Deferred(RecoveryBlocker::LiveRuntimeSession)
        );
    }

    #[test]
    fn active_lease_blocks_even_when_runtime_session_is_absent() {
        let mut input = evidence();
        input.durable_ownership = DurableOwnership::ActiveLease;
        assert_eq!(
            evaluate_stale_workflow(&input),
            RecoveryDecision::Deferred(RecoveryBlocker::ActiveLease)
        );
    }

    #[test]
    fn unresolved_provider_outcome_blocks_terminalization() {
        let mut input = evidence();
        input.durable_ownership = DurableOwnership::UnresolvedProviderOutcome;
        assert_eq!(
            evaluate_stale_workflow(&input),
            RecoveryDecision::Deferred(RecoveryBlocker::UnresolvedProviderOutcome)
        );
    }

    #[test]
    fn failed_ownership_query_is_not_treated_as_no_owner() {
        let mut input = evidence();
        input.durable_ownership = DurableOwnership::Unknown;
        assert_eq!(
            evaluate_stale_workflow(&input),
            RecoveryDecision::Deferred(RecoveryBlocker::OwnershipUnknown)
        );
    }

    #[test]
    fn absence_of_lease_alone_is_not_a_recovery_decision() {
        let mut input = evidence();
        input.runtime_inventory = RuntimeInventory::Unavailable;
        input.durable_ownership = DurableOwnership::NoKnownOwner;
        assert_eq!(
            evaluate_stale_workflow(&input),
            RecoveryDecision::Deferred(RecoveryBlocker::RuntimeInventoryUnavailable)
        );
    }

    #[test]
    fn fresh_or_exact_threshold_workflow_is_not_stale() {
        let mut input = evidence();
        input.now_ms = 2_000;
        assert_eq!(
            evaluate_stale_workflow(&input),
            RecoveryDecision::Deferred(RecoveryBlocker::NotStale)
        );
    }

    #[test]
    fn invalid_clock_and_non_executing_state_fail_closed() {
        let mut input = evidence();
        input.now_ms = -1;
        assert_eq!(
            evaluate_stale_workflow(&input),
            RecoveryDecision::Deferred(RecoveryBlocker::InvalidClockOrThreshold)
        );
        input = evidence();
        input.lifecycle = WorkflowLifecycle::Other;
        assert_eq!(
            evaluate_stale_workflow(&input),
            RecoveryDecision::Deferred(RecoveryBlocker::NotExecuting)
        );
    }
}
