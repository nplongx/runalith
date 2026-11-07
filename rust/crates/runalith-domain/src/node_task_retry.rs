//! Read-only compatibility model for Node's `WorkflowStore.beginAgentRetry`.
//!
//! Node's retry operation spans Job/task state, session takeover authority,
//! session state, outstanding task leases, and the durable attempt ledger in
//! one SQLite savepoint. This module models only its ordered preflight and
//! next-attempt calculation. It does not authorize an actor, mutate a session,
//! settle a lease, terminalize an attempt, or append events. A split Control /
//! Execution deployment needs an approved cross-part retry contract before
//! this decision can be composed across databases.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

/// One unresolved Node runtime attempt, in Node's durable query order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeRetryAttempt {
    /// Exact durable attempt identity.
    pub attempt_id: String,
    /// Runtime run identity, when the attempt is attached to one.
    pub openclaw_run_id: Option<String>,
}

/// Snapshot fields consumed by Node's ordered retry preflight.
///
/// Boolean facts such as `has_takeover_permission` must come from an
/// authenticated authority read. This adapter deliberately does not treat
/// caller-supplied values as authorization evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeAgentRetryContext {
    /// Exact task ID supplied to Node.
    pub task_id: String,
    /// Exact actor role supplied to Node.
    pub actor_role: String,
    /// Exact audit reason supplied to Node.
    pub reason: String,
    /// Whether the task row exists.
    pub task_exists: bool,
    /// Task's parent Job identity, if found.
    pub job_id: Option<String>,
    /// Whether the parent Job row exists.
    pub job_exists: bool,
    /// Exact persisted Job status (`active` is required).
    pub job_status: Option<String>,
    /// Exact persisted Job state (`EXECUTING` is required).
    pub job_state: Option<String>,
    /// Exact persisted task status.
    pub task_status: Option<String>,
    /// Whether `getSessionByTask` returned a session row.
    pub session_exists: bool,
    /// Durable session identity, when one is present.
    pub session_id: Option<String>,
    /// Session's task binding matches the requested task.
    pub session_task_matches: bool,
    /// Session's Job binding matches the task's Job.
    pub session_job_matches: bool,
    /// Whether the actor currently has `TAKEOVER` permission for this session.
    pub has_takeover_permission: bool,
    /// Exact persisted session state.
    pub session_state: Option<String>,
    /// ID of a prior active lease, if one exists.
    pub active_lease_id: Option<String>,
    /// Exact JSON-compatible value of `tasks.execution_attempt`; Node defaults
    /// null/undefined to zero before `Number.isSafeInteger` validation.
    pub task_execution_attempt: Value,
    /// Exact JSON-compatible value of `agent_sessions.attempt`.
    pub session_attempt: Value,
    /// Task's currently bound OpenClaw run ID.
    pub task_openclaw_run_id: Option<String>,
    /// Active attempts, newest first as returned by Node's query.
    pub active_attempts: Vec<NodeRetryAttempt>,
}

/// A retry plan after all Node preflight checks pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeAgentRetryPlan {
    /// Node's next attempt number, `max(taskAttempt, sessionAttempt) + 1`.
    pub next_attempt: u64,
    /// Existing unresolved attempt that Node will first mark failed, if any.
    pub superseded_attempt_id: Option<String>,
}

/// Ordered Node retry preflight failures.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum NodeAgentRetryError {
    /// Task identifier is empty or whitespace.
    #[error("retry taskId must be a non-empty string")]
    InvalidTaskId,
    /// Actor role is empty or whitespace.
    #[error("retry actorRole must be a non-empty string")]
    InvalidActorRole,
    /// Audit reason is empty or whitespace.
    #[error("retry reason must be a non-empty string")]
    InvalidReason,
    /// Task row does not exist.
    #[error("task not found: {task_id}")]
    TaskNotFound {
        /// Requested task identity.
        task_id: String,
    },
    /// Task must belong to an active Job in EXECUTING state.
    #[error("task retry requires an existing task in an EXECUTING job: {job_id}")]
    JobNotExecuting {
        /// Parent Job identity or fallback task identity.
        job_id: String,
    },
    /// Node only retries failed, pending, or running tasks.
    #[error("task retry is not allowed from task status {status}")]
    TaskStatusNotRetryable {
        /// Exact current task status.
        status: String,
    },
    /// No session is registered for the task.
    #[error("agent session not found for task: {task_id}")]
    SessionNotFound {
        /// Task whose session lookup failed.
        task_id: String,
    },
    /// Durable session/task/Job identity no longer agrees.
    #[error("agent session/task binding changed during retry: {task_id}")]
    SessionBindingChanged {
        /// Task whose durable binding changed.
        task_id: String,
    },
    /// The caller does not have session TAKEOVER authority.
    #[error("Session access denied: role={actor_role} permission=TAKEOVER session={session_id}")]
    TakeoverPermissionDenied {
        /// Exact actor role checked by Node.
        actor_role: String,
        /// Exact session identity checked by Node.
        session_id: String,
    },
    /// Same-task retry requires a stale, failed, or paused session.
    #[error("same-task retry requires STALE, FAILED, or PAUSED session; got {state}")]
    SessionStateNotRetryable {
        /// Exact current session state.
        state: String,
    },
    /// A prior task lease is still ACTIVE and must first be settled/quarantined.
    #[error(
        "same-task retry requires the prior task lease to be settled or quarantined: {lease_id}"
    )]
    ActiveLease {
        /// Active lease blocking the retry.
        lease_id: String,
    },
    /// Task/session attempt numbers are not safe positive identities.
    #[error("malformed durable retry attempt identity; refusing retry")]
    MalformedAttemptIdentity,
    /// More than one started runtime attempt remains unresolved.
    #[error("task has multiple unresolved runtime attempts; refusing same-task retry: {task_id}")]
    MultipleUnresolvedAttempts {
        /// Task with ambiguous active attempt lineage.
        task_id: String,
    },
    /// The unresolved runtime attempt belongs to a different run than the task.
    #[error("stale runtime attempt identity does not match the task binding: {task_id}")]
    AttemptBindingMismatch {
        /// Task whose active attempt run differs from task binding.
        task_id: String,
    },
    /// Next retry attempt would exceed JavaScript's safe-integer boundary.
    #[error("durable retry attempt identity is exhausted")]
    AttemptIdentityExhausted,
}

fn node_safe_integer(value: &Value) -> Option<i64> {
    let number = value.as_number()?.as_f64()?;
    const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
    if number.is_finite() && number.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER).contains(&number) {
        Some(number as i64)
    } else {
        None
    }
}

/// Evaluate Node's `beginAgentRetry` preflight without mutating persistence.
///
/// Validation order intentionally matches Node: argument validation, task/job
/// gate, task state, session existence/binding, permission, session state,
/// active lease, attempt-number validation, ambiguous attempts, run binding,
/// then attempt exhaustion.
pub fn evaluate_node_agent_retry(
    context: &NodeAgentRetryContext,
) -> Result<NodeAgentRetryPlan, NodeAgentRetryError> {
    if context.task_id.trim().is_empty() {
        return Err(NodeAgentRetryError::InvalidTaskId);
    }
    if context.actor_role.trim().is_empty() {
        return Err(NodeAgentRetryError::InvalidActorRole);
    }
    if context.reason.trim().is_empty() {
        return Err(NodeAgentRetryError::InvalidReason);
    }
    if !context.task_exists {
        return Err(NodeAgentRetryError::TaskNotFound {
            task_id: context.task_id.clone(),
        });
    }
    let job_id = context
        .job_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or(&context.task_id);
    if !context.job_exists
        || context.job_status.as_deref() != Some("active")
        || context.job_state.as_deref() != Some("EXECUTING")
    {
        return Err(NodeAgentRetryError::JobNotExecuting {
            job_id: job_id.to_owned(),
        });
    }
    let task_status = context.task_status.as_deref().unwrap_or("");
    if !matches!(task_status, "failed" | "pending" | "running") {
        return Err(NodeAgentRetryError::TaskStatusNotRetryable {
            status: task_status.to_owned(),
        });
    }
    if !context.session_exists {
        return Err(NodeAgentRetryError::SessionNotFound {
            task_id: context.task_id.clone(),
        });
    }
    if !context.session_task_matches || !context.session_job_matches {
        return Err(NodeAgentRetryError::SessionBindingChanged {
            task_id: context.task_id.clone(),
        });
    }
    if !context.has_takeover_permission {
        return Err(NodeAgentRetryError::TakeoverPermissionDenied {
            actor_role: context.actor_role.clone(),
            session_id: context.session_id.clone().unwrap_or_default(),
        });
    }
    let session_state = context.session_state.as_deref().unwrap_or("");
    if !matches!(session_state, "STALE" | "FAILED" | "PAUSED") {
        return Err(NodeAgentRetryError::SessionStateNotRetryable {
            state: session_state.to_owned(),
        });
    }
    if let Some(lease_id) = &context.active_lease_id {
        return Err(NodeAgentRetryError::ActiveLease {
            lease_id: lease_id.clone(),
        });
    }

    let task_attempt = if context.task_execution_attempt.is_null() {
        0
    } else {
        node_safe_integer(&context.task_execution_attempt)
            .ok_or(NodeAgentRetryError::MalformedAttemptIdentity)?
    };
    let session_attempt = node_safe_integer(&context.session_attempt)
        .filter(|attempt| *attempt >= 1)
        .ok_or(NodeAgentRetryError::MalformedAttemptIdentity)?;
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    if task_attempt > MAX_SAFE_INTEGER || session_attempt > MAX_SAFE_INTEGER {
        return Err(NodeAgentRetryError::MalformedAttemptIdentity);
    }
    if context.active_attempts.len() > 1 {
        return Err(NodeAgentRetryError::MultipleUnresolvedAttempts {
            task_id: context.task_id.clone(),
        });
    }
    let prior_attempt = context.active_attempts.first();
    if let Some(prior) = prior_attempt {
        if prior.openclaw_run_id.as_deref() != context.task_openclaw_run_id.as_deref() {
            return Err(NodeAgentRetryError::AttemptBindingMismatch {
                task_id: context.task_id.clone(),
            });
        }
    }
    let base_attempt = task_attempt.max(session_attempt);
    if base_attempt >= MAX_SAFE_INTEGER {
        return Err(NodeAgentRetryError::AttemptIdentityExhausted);
    }

    Ok(NodeAgentRetryPlan {
        next_attempt: (base_attempt + 1) as u64,
        superseded_attempt_id: prior_attempt.map(|attempt| attempt.attempt_id.clone()),
    })
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;

    #[derive(Debug, Deserialize)]
    struct NodeRetryOracle {
        schema_version: u32,
        generated_by_node: bool,
        source: String,
        cases: Vec<RetryCase>,
    }

    #[derive(Debug, Deserialize)]
    struct RetryCase {
        name: String,
        context: NodeAgentRetryContext,
        outcome: String,
        error_code: Option<String>,
        error: Option<String>,
        next_attempt: Option<u64>,
        superseded_attempt_id: Option<String>,
        postcondition: Option<RetryPostcondition>,
    }

    #[derive(Debug, PartialEq, Eq, Deserialize)]
    struct RetryPostcondition {
        task_status: String,
        session_state: String,
        session_attempt: u64,
        active_attempt_count: u64,
        superseded_attempt_status: Option<String>,
    }

    fn oracle() -> NodeRetryOracle {
        serde_json::from_str(include_str!("../tests/fixtures/node-agent-retry-v1.json"))
            .expect("Node agent retry oracle must parse")
    }

    fn error_code(error: &NodeAgentRetryError) -> &'static str {
        match error {
            NodeAgentRetryError::InvalidTaskId => "INVALID_TASK_ID",
            NodeAgentRetryError::InvalidActorRole => "INVALID_ACTOR_ROLE",
            NodeAgentRetryError::InvalidReason => "INVALID_REASON",
            NodeAgentRetryError::TaskNotFound { .. } => "TASK_NOT_FOUND",
            NodeAgentRetryError::JobNotExecuting { .. } => "JOB_NOT_EXECUTING",
            NodeAgentRetryError::TaskStatusNotRetryable { .. } => "TASK_STATUS_NOT_RETRYABLE",
            NodeAgentRetryError::SessionNotFound { .. } => "SESSION_NOT_FOUND",
            NodeAgentRetryError::SessionBindingChanged { .. } => "SESSION_BINDING_CHANGED",
            NodeAgentRetryError::TakeoverPermissionDenied { .. } => "TAKEOVER_PERMISSION_DENIED",
            NodeAgentRetryError::SessionStateNotRetryable { .. } => "SESSION_STATE_NOT_RETRYABLE",
            NodeAgentRetryError::ActiveLease { .. } => "ACTIVE_LEASE",
            NodeAgentRetryError::MalformedAttemptIdentity => "MALFORMED_ATTEMPT_IDENTITY",
            NodeAgentRetryError::MultipleUnresolvedAttempts { .. } => {
                "MULTIPLE_UNRESOLVED_ATTEMPTS"
            }
            NodeAgentRetryError::AttemptBindingMismatch { .. } => "ATTEMPT_BINDING_MISMATCH",
            NodeAgentRetryError::AttemptIdentityExhausted => "ATTEMPT_IDENTITY_EXHAUSTED",
        }
    }

    #[test]
    fn node_begin_agent_retry_preflight_matches_public_store_oracle() {
        let fixture = oracle();
        assert_eq!(fixture.schema_version, 1);
        assert!(fixture.generated_by_node);
        assert!(fixture.source.contains("WorkflowStore.beginAgentRetry"));
        assert!(fixture.cases.len() >= 12);

        for case in fixture.cases {
            match evaluate_node_agent_retry(&case.context) {
                Ok(plan) => {
                    assert_eq!(case.outcome, "READY", "{}", case.name);
                    assert_eq!(case.error_code, None, "{}", case.name);
                    assert_eq!(Some(plan.next_attempt), case.next_attempt, "{}", case.name);
                    assert_eq!(
                        plan.superseded_attempt_id, case.superseded_attempt_id,
                        "{}",
                        case.name
                    );
                    let postcondition = case.postcondition.expect(
                        "successful Node retry must include durable postcondition readback",
                    );
                    assert_eq!(postcondition.task_status, "running", "{}", case.name);
                    assert_eq!(postcondition.session_state, "ACTIVE", "{}", case.name);
                    assert_eq!(
                        postcondition.session_attempt, plan.next_attempt,
                        "{}",
                        case.name
                    );
                    assert_eq!(postcondition.active_attempt_count, 1, "{}", case.name);
                    assert_eq!(
                        postcondition.superseded_attempt_status.as_deref(),
                        plan.superseded_attempt_id.as_ref().map(|_| "failed"),
                        "{}",
                        case.name
                    );
                }
                Err(error) => {
                    assert_eq!(case.outcome, "REJECTED", "{}", case.name);
                    assert_eq!(
                        Some(error_code(&error)),
                        case.error_code.as_deref(),
                        "{}",
                        case.name
                    );
                    assert_eq!(Some(error.to_string()), case.error, "{}", case.name);
                    assert_eq!(case.next_attempt, None, "{}", case.name);
                    assert_eq!(case.superseded_attempt_id, None, "{}", case.name);
                    assert_eq!(case.postcondition, None, "{}", case.name);
                }
            }
        }
    }
}
