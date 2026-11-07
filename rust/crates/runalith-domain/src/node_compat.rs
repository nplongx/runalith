//! Compatibility model for the legacy Node workflow lifecycle.
//!
//! Node keeps `jobs.state/status` and `workflow_runtime_state.phase` as two
//! separate state machines. The Rust-native [`crate::WorkflowState`] is a
//! coarser domain lifecycle and must not be used to silently collapse these
//! legacy fields during import, comparison, or reconciliation.
//!
//! This module is a pure semantic adapter. It does not authorize terminal
//! transitions: callers must enforce the returned provider-quiescence gate in
//! the same transaction as persistence, just as the Node store does.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// One of the exact legacy `workflow_runtime_state.phase` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum NodeWorkflowPhase {
    /// Workflow proposal is being prepared.
    Proposed,
    /// Approval is complete; CTO execution has not started.
    Approved,
    /// CTO coordination task must be spawned.
    SpawnCto,
    /// Child tasks are being assigned.
    AssignChildren,
    /// Assigned child tasks are running.
    RunChildren,
    /// Workflow is waiting for child/provider progress.
    Wait,
    /// Persisted evidence is being checked.
    ValidateEvidence,
    /// Synthesis is being prepared.
    Synthesize,
    /// Workflow is being terminalized.
    Terminalize,
    /// Final projection is being published.
    Project,
    /// Workflow phase completed successfully.
    Completed,
    /// Workflow phase failed.
    Failed,
}

impl NodeWorkflowPhase {
    /// Exact legacy database spelling. Values are intentionally not mapped to
    /// `WorkflowState`; the two models represent different lifecycle layers.
    #[must_use]
    pub const fn as_db(self) -> &'static str {
        match self {
            Self::Proposed => "PROPOSED",
            Self::Approved => "APPROVED",
            Self::SpawnCto => "SPAWN_CTO",
            Self::AssignChildren => "ASSIGN_CHILDREN",
            Self::RunChildren => "RUN_CHILDREN",
            Self::Wait => "WAIT",
            Self::ValidateEvidence => "VALIDATE_EVIDENCE",
            Self::Synthesize => "SYNTHESIZE",
            Self::Terminalize => "TERMINALIZE",
            Self::Project => "PROJECT",
            Self::Completed => "COMPLETED",
            Self::Failed => "FAILED",
        }
    }

    /// Parse only exact Node phase tokens. Node rejects case variants.
    #[must_use]
    pub fn parse_exact(value: &str) -> Option<Self> {
        Some(match value {
            "PROPOSED" => Self::Proposed,
            "APPROVED" => Self::Approved,
            "SPAWN_CTO" => Self::SpawnCto,
            "ASSIGN_CHILDREN" => Self::AssignChildren,
            "RUN_CHILDREN" => Self::RunChildren,
            "WAIT" => Self::Wait,
            "VALIDATE_EVIDENCE" => Self::ValidateEvidence,
            "SYNTHESIZE" => Self::Synthesize,
            "TERMINALIZE" => Self::Terminalize,
            "PROJECT" => Self::Project,
            "COMPLETED" => Self::Completed,
            "FAILED" => Self::Failed,
            _ => return None,
        })
    }

    /// Whether Node's `transitionWorkflowPhase` permits this phase edge.
    #[must_use]
    pub const fn can_transition_to(self, next: Self) -> bool {
        use NodeWorkflowPhase as P;
        matches!(
            (self, next),
            (P::Proposed, P::Approved | P::Failed)
                | (P::Approved, P::SpawnCto | P::Failed)
                | (P::SpawnCto, P::AssignChildren | P::Failed)
                | (P::AssignChildren, P::RunChildren | P::Wait | P::Failed)
                | (P::RunChildren, P::Wait | P::Failed)
                | (
                    P::Wait,
                    P::Wait | P::AssignChildren | P::ValidateEvidence | P::Failed
                )
                | (P::ValidateEvidence, P::Synthesize | P::Failed)
                | (
                    P::Synthesize,
                    P::Terminalize | P::AssignChildren | P::Failed
                )
                | (P::Terminalize, P::Project | P::Failed)
                | (P::Project, P::Completed | P::Failed)
        )
    }
}

/// Result of evaluating one Node phase transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodePhaseTransition {
    /// Same-phase call: Node updates its runtime row but appends no workflow event.
    Idempotent,
    /// Allowed phase edge: Node updates its row and appends one workflow event.
    Advance,
}

/// Why a legacy workflow phase transition was rejected.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum NodePhaseTransitionError {
    /// Node validates the target phase against the closed phase catalog first.
    #[error("invalid workflow phase: {0}")]
    InvalidPhase(String),
    /// Current/target phase pair is absent from the legacy transition table.
    #[error("invalid workflow transition: {from} -> {to}")]
    InvalidTransition {
        /// Exact persisted source phase.
        from: String,
        /// Requested target phase.
        to: String,
    },
}

/// Evaluate a Node phase transition without performing persistence.
pub fn evaluate_node_phase_transition(
    from: &str,
    to: &str,
) -> Result<NodePhaseTransition, NodePhaseTransitionError> {
    let Some(next) = NodeWorkflowPhase::parse_exact(to) else {
        return Err(NodePhaseTransitionError::InvalidPhase(to.to_owned()));
    };
    let Some(current) = NodeWorkflowPhase::parse_exact(from) else {
        return Err(NodePhaseTransitionError::InvalidTransition {
            from: from.to_owned(),
            to: to.to_owned(),
        });
    };
    if current == next {
        return Ok(NodePhaseTransition::Idempotent);
    }
    if current.can_transition_to(next) {
        return Ok(NodePhaseTransition::Advance);
    }
    Err(NodePhaseTransitionError::InvalidTransition {
        from: from.to_owned(),
        to: to.to_owned(),
    })
}

/// Outcome of validating legacy `jobs.state/status` before a Node CAS update.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeJobTransitionDisposition {
    /// Nonterminal job may be updated after the caller completes required gates.
    Apply,
    /// Exact replay against a terminal job is accepted without a write.
    IdempotentTerminal,
}

/// Why legacy `WorkflowStore.transition` refused an update.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum NodeJobTransitionError {
    /// Terminal job cannot be reopened or rebound to another status.
    #[error(
        "cannot transition terminal Job from {current_state}/{current_status} to {next_state}/{next_status}"
    )]
    TerminalReopen {
        /// Current persisted job state.
        current_state: String,
        /// Current persisted job status.
        current_status: String,
        /// Requested job state.
        next_state: String,
        /// Requested job status.
        next_status: String,
    },
    /// `status == active` permits only the exact legacy active transition matrix.
    #[error(
        "illegal active Job state transition {current_state}/{current_status} -> {next_state}/{next_status}"
    )]
    IllegalActiveTransition {
        /// Current persisted job state.
        current_state: String,
        /// Current persisted job status.
        current_status: String,
        /// Requested job state.
        next_state: String,
        /// Requested job status.
        next_status: String,
    },
}

/// Pure result matching the legacy Node Job-state preflight.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeJobTransitionEvaluation {
    /// Whether the legacy row update is allowed/idempotent or rejected.
    pub disposition: Result<NodeJobTransitionDisposition, NodeJobTransitionError>,
    /// Node calls `assertNoUnresolvedProviderOutcome` before the active-state
    /// matrix whenever either requested state or status is terminal. This flag
    /// must be enforced transactionally by the caller; this function cannot
    /// establish external provider absence itself.
    pub requires_provider_quiescence: bool,
}

fn is_terminal_state(state: &str) -> bool {
    matches!(
        state.to_ascii_uppercase().as_str(),
        "COMPLETED" | "FAILED" | "CANCELLED"
    )
}

fn is_terminal_status(status: &str) -> bool {
    matches!(
        status.to_ascii_lowercase().as_str(),
        "completed" | "failed" | "cancelled"
    )
}

fn allowed_active_transition(current_state: &str, next_state: &str) -> bool {
    let current = current_state.to_ascii_uppercase();
    let next = next_state.to_ascii_uppercase();
    match current.as_str() {
        "IDLE" => matches!(
            next.as_str(),
            "IDLE" | "PROPOSED" | "DISCUSSING" | "EXECUTING"
        ),
        "PROPOSED" => matches!(next.as_str(), "PROPOSED" | "DISCUSSING" | "EXECUTING"),
        "DISCUSSING" => matches!(next.as_str(), "PROPOSED" | "DISCUSSING" | "EXECUTING"),
        "APPROVED" => matches!(next.as_str(), "APPROVED" | "EXECUTING"),
        "EXECUTING" => next == "EXECUTING",
        _ => false,
    }
}

/// Evaluate legacy Node `WorkflowStore.transition` semantics over `jobs.state`
/// and `jobs.status` (distinct from the Rust-native `WorkflowState`).
#[must_use]
pub fn evaluate_node_job_transition(
    current_state: &str,
    current_status: &str,
    next_state: &str,
    next_status: &str,
) -> NodeJobTransitionEvaluation {
    let terminal = is_terminal_state(current_state) || is_terminal_status(current_status);
    if terminal {
        let disposition = if current_state == next_state && current_status == next_status {
            Ok(NodeJobTransitionDisposition::IdempotentTerminal)
        } else {
            Err(NodeJobTransitionError::TerminalReopen {
                current_state: current_state.to_owned(),
                current_status: current_status.to_owned(),
                next_state: next_state.to_owned(),
                next_status: next_status.to_owned(),
            })
        };
        return NodeJobTransitionEvaluation {
            disposition,
            requires_provider_quiescence: false,
        };
    }

    let requires_provider_quiescence =
        is_terminal_state(next_state) || is_terminal_status(next_status);
    let disposition =
        if next_status == "active" && !allowed_active_transition(current_state, next_state) {
            Err(NodeJobTransitionError::IllegalActiveTransition {
                current_state: current_state.to_owned(),
                current_status: current_status.to_owned(),
                next_state: next_state.to_owned(),
                next_status: next_status.to_owned(),
            })
        } else {
            Ok(NodeJobTransitionDisposition::Apply)
        };

    NodeJobTransitionEvaluation {
        disposition,
        requires_provider_quiescence,
    }
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;

    #[derive(Debug, Deserialize)]
    struct LifecycleOracle {
        schema_version: u32,
        generated_by_node: bool,
        job_transition_cases: Vec<JobTransitionCase>,
        workflow_phase_cases: Vec<WorkflowPhaseCase>,
    }

    #[derive(Debug, Deserialize)]
    struct JobTransitionCase {
        current_state: String,
        current_status: String,
        next_state: String,
        next_status: String,
        outcome: String,
        error_code: Option<String>,
        requires_provider_quiescence: bool,
    }

    #[derive(Debug, Deserialize)]
    struct WorkflowPhaseCase {
        current_phase: String,
        next_phase: String,
        outcome: String,
        error_code: Option<String>,
        persisted_phase: String,
        workflow_event_delta: u32,
    }

    fn oracle() -> LifecycleOracle {
        let fixture = include_str!("../tests/fixtures/node-workflow-lifecycle-v1.json");
        serde_json::from_str(fixture).expect("Node-generated workflow lifecycle oracle must parse")
    }

    #[test]
    fn node_job_transition_semantics_match_all_node_generated_cases() {
        let fixture = oracle();
        assert_eq!(fixture.schema_version, 1);
        assert!(fixture.generated_by_node);
        assert_eq!(fixture.job_transition_cases.len(), 9 * 4 * 9 * 4);

        for case in fixture.job_transition_cases {
            let evaluated = evaluate_node_job_transition(
                &case.current_state,
                &case.current_status,
                &case.next_state,
                &case.next_status,
            );
            let (outcome, error_code) = match evaluated.disposition {
                Ok(NodeJobTransitionDisposition::Apply) => ("APPLIED", None),
                Ok(NodeJobTransitionDisposition::IdempotentTerminal) => {
                    ("IDEMPOTENT_TERMINAL", None)
                }
                Err(NodeJobTransitionError::TerminalReopen { .. }) => {
                    ("REJECTED", Some("TERMINAL_REOPEN"))
                }
                Err(NodeJobTransitionError::IllegalActiveTransition { .. }) => {
                    ("REJECTED", Some("ILLEGAL_ACTIVE"))
                }
            };
            assert_eq!(
                outcome, case.outcome,
                "{} / {} -> {} / {}",
                case.current_state, case.current_status, case.next_state, case.next_status
            );
            assert_eq!(
                error_code,
                case.error_code.as_deref(),
                "{} / {} -> {} / {}",
                case.current_state,
                case.current_status,
                case.next_state,
                case.next_status
            );
            assert_eq!(
                evaluated.requires_provider_quiescence, case.requires_provider_quiescence,
                "terminal guard ordering differs for {} / {} -> {} / {}",
                case.current_state, case.current_status, case.next_state, case.next_status
            );
        }
    }

    #[test]
    fn node_workflow_phase_transitions_match_all_node_generated_cases() {
        let fixture = oracle();
        assert_eq!(fixture.workflow_phase_cases.len(), 12 * 12);

        for case in fixture.workflow_phase_cases {
            let evaluated = evaluate_node_phase_transition(&case.current_phase, &case.next_phase);
            let (outcome, error_code, persisted_phase, event_delta) = match evaluated {
                Ok(NodePhaseTransition::Idempotent) => {
                    ("IDEMPOTENT", None, case.current_phase.as_str(), 0)
                }
                Ok(NodePhaseTransition::Advance) => ("APPLIED", None, case.next_phase.as_str(), 1),
                Err(NodePhaseTransitionError::InvalidTransition { .. }) => (
                    "REJECTED",
                    Some("INVALID_PHASE_TRANSITION"),
                    case.current_phase.as_str(),
                    0,
                ),
                Err(NodePhaseTransitionError::InvalidPhase(_)) => {
                    unreachable!("oracle uses known target phases")
                }
            };
            assert_eq!(
                outcome, case.outcome,
                "{} -> {}",
                case.current_phase, case.next_phase
            );
            assert_eq!(
                error_code,
                case.error_code.as_deref(),
                "{} -> {}",
                case.current_phase,
                case.next_phase
            );
            assert_eq!(
                persisted_phase, case.persisted_phase,
                "{} -> {}",
                case.current_phase, case.next_phase
            );
            assert_eq!(
                event_delta, case.workflow_event_delta,
                "{} -> {}",
                case.current_phase, case.next_phase
            );
        }
    }

    #[test]
    fn node_phase_parser_rejects_case_variants_and_unknown_tokens() {
        assert_eq!(
            NodeWorkflowPhase::parse_exact("SPAWN_CTO"),
            Some(NodeWorkflowPhase::SpawnCto)
        );
        assert_eq!(NodeWorkflowPhase::parse_exact("spawn_cto"), None);
        assert_eq!(NodeWorkflowPhase::parse_exact("UNKNOWN"), None);
        assert_eq!(
            evaluate_node_phase_transition("PROPOSED", "proposed"),
            Err(NodePhaseTransitionError::InvalidPhase("proposed".into()))
        );
    }

    #[test]
    fn node_job_terminal_replay_is_exact_and_case_sensitive() {
        let exact =
            evaluate_node_job_transition("COMPLETED", "completed", "COMPLETED", "completed");
        assert_eq!(
            exact.disposition,
            Ok(NodeJobTransitionDisposition::IdempotentTerminal)
        );
        let changed =
            evaluate_node_job_transition("COMPLETED", "completed", "completed", "completed");
        assert!(matches!(
            changed.disposition,
            Err(NodeJobTransitionError::TerminalReopen { .. })
        ));
    }
}
