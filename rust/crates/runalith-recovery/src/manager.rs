//! Rust-native recovery evidence aggregation.
//!
//! This module deliberately separates observations from authority to mutate
//! lifecycle state. A positive ownership result is useful for operator
//! reconciliation only; it never authorizes retry, replay or terminalization.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

/// Provenance of a runtime inventory snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeSnapshot {
    /// Stable runtime instance that produced the inventory.
    pub runtime_id: String,
    /// Monotonic generation within that runtime instance.
    pub generation: u64,
    /// Snapshot capture time in Unix milliseconds.
    pub captured_at_ms: i64,
    /// Whether provider/runtime guarantees the inventory is complete.
    pub complete: bool,
    /// Session identifiers present at capture time.
    pub live_session_ids: BTreeSet<String>,
}

/// Evidence state for one durable ownership source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Observation<T> {
    /// Source returned an authoritative observation.
    Authoritative(T),
    /// Source could not be queried or its response failed validation.
    Unknown,
}

/// Current durable lease observation for a task attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseObservation {
    /// Exact attempt still has an active lease.
    Active,
    /// Lease query completed and found no active lease.
    Absent,
}

/// Runtime session observation for a task attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionObservation {
    /// The exact session is present in the authoritative snapshot.
    Live,
    /// The exact session is absent from a complete snapshot.
    Absent,
}

/// Provider result state for an attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderObservation {
    /// No provider dispatch intent exists for this attempt.
    NotDispatched,
    /// Provider contract authoritatively confirms terminal result.
    AuthoritativeTerminal,
    /// Provider may have accepted or executed the request.
    Unresolved,
}

/// Immutable lineage identity for one task attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttemptLineage {
    /// Stable workflow identity.
    pub workflow_id: String,
    /// Stable task identity.
    pub task_id: String,
    /// Monotonic attempt number, starting at one.
    pub attempt: u64,
    /// Independent monotonic lease fencing epoch for this attempt.
    pub owner_epoch: u64,
    /// Immutable plan digest pinned by approval.
    pub plan_sha256: String,
    /// Exact lease identity, if one was issued.
    pub lease_id: Option<String>,
    /// Exact runtime session identity, if one was attached.
    pub session_id: Option<String>,
    /// Exact provider intent identity, if one was reserved.
    pub provider_intent_id: Option<String>,
}

/// Complete evidence presented to the recovery manager for one attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttemptRecoveryEvidence {
    /// Immutable attempt identity and lineage.
    pub lineage: AttemptLineage,
    /// Authoritative lease query result.
    pub lease: Observation<LeaseObservation>,
    /// Authoritative runtime session query result.
    pub session: Observation<SessionObservation>,
    /// Authoritative provider reconciliation result.
    pub provider: Observation<ProviderObservation>,
}

/// Recovery classification. None of these values authorizes a lifecycle write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttemptOwnership {
    /// At least one source confirms active ownership.
    Owned,
    /// A provider outcome remains ambiguous or unresolved.
    Unresolved,
    /// All required sources are authoritative and show no current owner.
    NoKnownOwner,
    /// Evidence is incomplete, contradictory or invalid.
    Unknown,
}

/// Recovery manager evaluates evidence without performing I/O or mutation.
#[derive(Debug, Default)]
pub struct RecoveryManager;

impl RecoveryManager {
    /// Classify ownership for one exact task attempt.
    ///
    /// Missing lease/session/provider metadata is never interpreted as proof
    /// that a worker or provider execution is dead. Callers must provide an
    /// explicit authoritative `Absent`/`NotDispatched` observation.
    #[must_use]
    pub fn classify_attempt(evidence: &AttemptRecoveryEvidence) -> AttemptOwnership {
        let lineage = &evidence.lineage;
        if lineage.workflow_id.trim().is_empty()
            || lineage.task_id.trim().is_empty()
            || lineage.attempt == 0
            || lineage.owner_epoch == 0
            || !is_sha256(&lineage.plan_sha256)
            || lineage
                .lease_id
                .as_deref()
                .is_some_and(|value| value.trim().is_empty())
            || (lineage.lease_id.is_none()
                && matches!(evidence.lease, Observation::Authoritative(_)))
            || lineage
                .session_id
                .as_deref()
                .is_some_and(|value| value.trim().is_empty())
            || (lineage.session_id.is_none()
                && matches!(
                    evidence.session,
                    Observation::Authoritative(SessionObservation::Live)
                ))
            || lineage
                .provider_intent_id
                .as_deref()
                .is_some_and(|value| value.trim().is_empty())
            || (lineage.provider_intent_id.is_none()
                && matches!(
                    evidence.provider,
                    Observation::Authoritative(
                        ProviderObservation::Unresolved
                            | ProviderObservation::AuthoritativeTerminal
                    )
                ))
        {
            return AttemptOwnership::Unknown;
        }

        if matches!(
            evidence.provider,
            Observation::Authoritative(ProviderObservation::Unresolved)
        ) {
            return AttemptOwnership::Unresolved;
        }
        if matches!(
            evidence.lease,
            Observation::Authoritative(LeaseObservation::Active)
        ) || matches!(
            evidence.session,
            Observation::Authoritative(SessionObservation::Live)
        ) {
            return AttemptOwnership::Owned;
        }
        if matches!(evidence.lease, Observation::Unknown)
            || matches!(evidence.session, Observation::Unknown)
            || matches!(evidence.provider, Observation::Unknown)
        {
            return AttemptOwnership::Unknown;
        }

        AttemptOwnership::NoKnownOwner
    }

    /// Validate a runtime snapshot against the exact linked session identity.
    #[must_use]
    pub fn observe_session(
        snapshot: &RuntimeSnapshot,
        expected_runtime_id: &str,
        session_id: &str,
        now_ms: i64,
        maximum_age_ms: i64,
    ) -> Observation<SessionObservation> {
        if snapshot.runtime_id != expected_runtime_id
            || snapshot.runtime_id.trim().is_empty()
            || snapshot.generation == 0
            || snapshot.captured_at_ms < 0
            || now_ms < snapshot.captured_at_ms
            || maximum_age_ms < 1
            || now_ms.saturating_sub(snapshot.captured_at_ms) > maximum_age_ms
            || !snapshot.complete
            || session_id.trim().is_empty()
        {
            return Observation::Unknown;
        }
        Observation::Authoritative(if snapshot.live_session_ids.contains(session_id) {
            SessionObservation::Live
        } else {
            SessionObservation::Absent
        })
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evidence() -> AttemptRecoveryEvidence {
        AttemptRecoveryEvidence {
            lineage: AttemptLineage {
                workflow_id: "job_1".into(),
                task_id: "task_1".into(),
                attempt: 2,
                owner_epoch: 3,
                plan_sha256: "a".repeat(64),
                lease_id: Some("lease_2".into()),
                session_id: Some("session_2".into()),
                provider_intent_id: Some("intent_2".into()),
            },
            lease: Observation::Authoritative(LeaseObservation::Absent),
            session: Observation::Authoritative(SessionObservation::Absent),
            provider: Observation::Authoritative(ProviderObservation::NotDispatched),
        }
    }

    #[test]
    fn requires_explicit_authoritative_absence_from_every_owner() {
        let input = evidence();
        assert_eq!(
            RecoveryManager::classify_attempt(&input),
            AttemptOwnership::NoKnownOwner
        );
        let mut missing_epoch = input.clone();
        missing_epoch.lineage.owner_epoch = 0;
        assert_eq!(
            RecoveryManager::classify_attempt(&missing_epoch),
            AttemptOwnership::Unknown
        );
        let mut missing = input.clone();
        missing.lease = Observation::Unknown;
        assert_eq!(
            RecoveryManager::classify_attempt(&missing),
            AttemptOwnership::Unknown
        );
    }

    #[test]
    fn missing_lease_identifier_does_not_prove_worker_death() {
        let mut input = evidence();
        input.lineage.lease_id = None;
        input.lease = Observation::Unknown;
        assert_eq!(
            RecoveryManager::classify_attempt(&input),
            AttemptOwnership::Unknown
        );

        // An "absent" answer cannot be bound to an exact lease when the
        // immutable attempt lineage has no lease identifier to query.
        input.lease = Observation::Authoritative(LeaseObservation::Absent);
        assert_eq!(
            RecoveryManager::classify_attempt(&input),
            AttemptOwnership::Unknown
        );

        input.lineage.lease_id = Some("  ".into());
        assert_eq!(
            RecoveryManager::classify_attempt(&input),
            AttemptOwnership::Unknown
        );
    }

    #[test]
    fn active_lease_or_session_means_owned() {
        let mut input = evidence();
        input.lease = Observation::Authoritative(LeaseObservation::Active);
        assert_eq!(
            RecoveryManager::classify_attempt(&input),
            AttemptOwnership::Owned
        );
        input.lease = Observation::Authoritative(LeaseObservation::Absent);
        input.session = Observation::Authoritative(SessionObservation::Live);
        assert_eq!(
            RecoveryManager::classify_attempt(&input),
            AttemptOwnership::Owned
        );
    }

    #[test]
    fn ambiguous_provider_outcome_remains_unresolved() {
        let mut input = evidence();
        input.provider = Observation::Authoritative(ProviderObservation::Unresolved);
        assert_eq!(
            RecoveryManager::classify_attempt(&input),
            AttemptOwnership::Unresolved
        );
    }

    #[test]
    fn unresolved_provider_outcome_is_not_masked_by_a_live_runtime_session() {
        let mut input = evidence();
        input.session = Observation::Authoritative(SessionObservation::Live);
        input.provider = Observation::Authoritative(ProviderObservation::Unresolved);
        assert_eq!(
            RecoveryManager::classify_attempt(&input),
            AttemptOwnership::Unresolved
        );
    }

    #[test]
    fn runtime_snapshot_must_be_complete_fresh_and_from_expected_runtime() {
        let snapshot = RuntimeSnapshot {
            runtime_id: "runtime-a".into(),
            generation: 4,
            captured_at_ms: 1_000,
            complete: true,
            live_session_ids: BTreeSet::from(["session-a".into()]),
        };
        assert_eq!(
            RecoveryManager::observe_session(&snapshot, "runtime-a", "session-a", 1_500, 1_000),
            Observation::Authoritative(SessionObservation::Live)
        );
        assert_eq!(
            RecoveryManager::observe_session(&snapshot, "runtime-b", "session-a", 1_500, 1_000),
            Observation::Unknown
        );
        assert_eq!(
            RecoveryManager::observe_session(&snapshot, "runtime-a", "session-a", 3_000, 1_000),
            Observation::Unknown
        );
        let mut partial = snapshot;
        partial.complete = false;
        assert_eq!(
            RecoveryManager::observe_session(&partial, "runtime-a", "session-a", 1_500, 1_000),
            Observation::Unknown
        );
    }
}
