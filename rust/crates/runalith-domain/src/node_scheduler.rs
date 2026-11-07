//! Read-only compatibility model for Node's `WorkflowStore.listRunnableTasks`.
//!
//! This models only the legacy candidate-list SQL predicate and its
//! `created_at ASC` ordering. It deliberately does not model Node's subsequent
//! `acquireTaskLease` transaction, which rechecks parent-job liveness, monotonic
//! attempt identity, owner-epoch history and lease uniqueness. Nor does it
//! claim equivalence with Rust's stricter `list_ready_tasks` or atomic
//! `coordinator_claim_next` policy. The diagnostic parent/dependency/expiry
//! fields are retained to prove which facts the Node candidate query ignores.

use serde::{Deserialize, Serialize};

/// One observed task row and the independent durable facts relevant to
/// distinguishing candidate enumeration from later admission.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeRunnableTaskRow {
    /// Original SQLite rowid, preserving source order for equal timestamps.
    pub row_order: u64,
    /// Exact task identity (normalized to stable fixture identity by generator).
    pub task_id: String,
    /// Exact parent Job identity (normalized by generator).
    pub job_id: String,
    /// Exact task status read from SQLite.
    pub status: String,
    /// Exact persisted timestamp consumed by Node's `ORDER BY`.
    pub created_at: String,
    /// Parent Job status, diagnostic only; not used by Node `listRunnableTasks`.
    pub parent_status: String,
    /// Parent Job state, diagnostic only; not used by Node `listRunnableTasks`.
    pub parent_state: String,
    /// Parent Job update time, diagnostic only; used by the Rust workflow
    /// fairness selector, not by Node's legacy task FIFO query.
    pub parent_updated_at: String,
    /// Whether an ACTIVE task lease exists. Node checks state, not expiry.
    pub has_active_lease: bool,
    /// Whether that ACTIVE lease is already expired by the fixture clock.
    pub has_expired_active_lease: bool,
    /// Whether durable task dependency metadata contains an unmet dependency.
    /// Diagnostic only; this candidate query does not inspect dependencies.
    pub has_unmet_dependencies: bool,
}

/// Query options accepted by Node `WorkflowStore.listRunnableTasks`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct NodeRunnableTaskQuery {
    /// Optional exact Job filter.
    pub job_id: Option<String>,
    /// SQLite LIMIT parameter. Zero returns an empty candidate list.
    pub limit: u64,
}

/// Evaluate the Node candidate projection without mutating state.
///
/// Predicate parity: `tasks.status = 'pending'`, no task lease with
/// `state = 'ACTIVE'`, and optional exact Job filter. Result order is ascending
/// `created_at`. The source SQL defines no secondary ordering for equal
/// timestamps; this stable sort preserves the source row order for ties but
/// consumers must not treat that tie behavior as a cross-version guarantee.
#[must_use]
pub fn evaluate_node_runnable_tasks(
    rows: &[NodeRunnableTaskRow],
    query: &NodeRunnableTaskQuery,
) -> Vec<String> {
    let mut candidates: Vec<&NodeRunnableTaskRow> = rows
        .iter()
        .filter(|row| row.status == "pending" && !row.has_active_lease)
        .filter(|row| {
            query
                .job_id
                .as_ref()
                .is_none_or(|job_id| row.job_id == *job_id)
        })
        .collect();
    candidates.sort_by(|left, right| left.created_at.cmp(&right.created_at));
    candidates
        .into_iter()
        .take(usize::try_from(query.limit).unwrap_or(usize::MAX))
        .map(|row| row.task_id.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;

    #[derive(Debug, Deserialize)]
    struct NodeRunnableTaskOracle {
        schema_version: u32,
        generated_by_node: bool,
        source: String,
        rows: Vec<NodeRunnableTaskRow>,
        cases: Vec<RunnableTaskCase>,
    }

    #[derive(Debug, Deserialize)]
    struct RunnableTaskCase {
        name: String,
        query: NodeRunnableTaskQuery,
        expected_task_ids: Vec<String>,
    }

    fn oracle() -> NodeRunnableTaskOracle {
        serde_json::from_str(include_str!("../tests/fixtures/node-runnable-task-v1.json"))
            .expect("Node runnable-task oracle must parse")
    }

    #[test]
    fn node_public_runnable_task_query_matches_all_fixture_cases() {
        let fixture = oracle();
        assert_eq!(fixture.schema_version, 1);
        assert!(fixture.generated_by_node);
        assert!(fixture.source.contains("WorkflowStore.listRunnableTasks"));
        assert_eq!(fixture.rows.len(), 13);
        assert_eq!(fixture.cases.len(), 7);

        for case in &fixture.cases {
            assert_eq!(
                evaluate_node_runnable_tasks(&fixture.rows, &case.query),
                case.expected_task_ids,
                "{}",
                case.name
            );
        }

        // These are important differences from the Rust coordinator's
        // dependency/parent-state eligibility. Node's legacy candidate query
        // includes both; its later lease transaction applies a separate parent
        // liveness gate, and dependency readiness is not checked by this method.
        let candidates = evaluate_node_runnable_tasks(
            &fixture.rows,
            &NodeRunnableTaskQuery {
                job_id: None,
                limit: 100,
            },
        );
        assert!(candidates.iter().any(|id| id == "pending-terminal-parent"));
        assert!(
            candidates
                .iter()
                .any(|id| id == "pending-unresolved-dependency")
        );

        // An expired lease still excludes a candidate while its durable state
        // remains ACTIVE. Expiry/reaping is a separate state transition.
        let expired_lease = fixture
            .rows
            .iter()
            .find(|row| row.task_id == "pending-expired-active-lease")
            .expect("expired active-lease row must exist");
        assert!(expired_lease.has_active_lease);
        assert!(expired_lease.has_expired_active_lease);
        assert!(
            !candidates
                .iter()
                .any(|id| id == "pending-expired-active-lease")
        );

        // Node orders by task.created_at. Rust's coordinator deliberately
        // orders eligible work by parent workflow.updated_at and then immutable
        // task ordinal/ID. These two rows invert the clocks, proving the legacy
        // ordering is not a Rust fairness oracle.
        let older_task = fixture
            .rows
            .iter()
            .find(|row| row.task_id == "fifo-old-task-recent-workflow")
            .expect("older-task fairness row must exist");
        let newer_task = fixture
            .rows
            .iter()
            .find(|row| row.task_id == "fifo-new-task-old-workflow")
            .expect("newer-task fairness row must exist");
        assert!(older_task.created_at < newer_task.created_at);
        assert!(newer_task.parent_updated_at < older_task.parent_updated_at);
        let older_task_position = candidates
            .iter()
            .position(|id| id == &older_task.task_id)
            .expect("older task must be in Node candidate list");
        let newer_task_position = candidates
            .iter()
            .position(|id| id == &newer_task.task_id)
            .expect("newer task must be in Node candidate list");
        assert!(older_task_position < newer_task_position);
    }
}
