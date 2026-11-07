//! Candidate-bound maker attestations and checker votes.
//!
//! Contract: approval-decision schema v1, matching the field names and signed
//! envelope kinds in the Node approval subsystem. The caller supplies the
//! candidate binding produced by its trusted candidate builder and a
//! `VerifiedApprovalPolicy` returned by `verify_approval_policy`.
//!
//! Replay nonces and policy high-water are stored in versioned internal tables
//! in the caller's SQLite transaction. The savepoint keeps this verifier's
//! writes atomic while preserving the caller's outer transaction. These tables
//! are a Rust-local persistence contract; no Node database parity is claimed.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::TrustError;
use crate::approval_policy::{VerifiedApprovalPolicy, verify_approval_policy_in_transaction};
use crate::reviewer_attestation::{ReviewerAttestationError, ReviewerAttestationV1};
use crate::signed_envelope::verify_signed_envelope;
use crate::trust_config::TrustConfigurationSet;
use crate::trust_ledger::TrustConfigurationObserver;

const MAKER_SCOPE: &str = "agg.action_intent.propose";
const MAKER_KIND: &str = "adaptive_goal_action_intent_maker_attestation";
const DECISION_SCOPE: &str = "agg.execution.approve";
const DECISION_KIND: &str = "adaptive_goal_execution_approval_decision";
const SAVEPOINT: &str = "runalith_approval_decision_v1";

/// One authenticated checker vote included in the accepted quorum.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedCheckerVote {
    /// Authenticated checker identity from the signed reviewer registry.
    pub reviewer_subject: String,
    /// Checker role assigned by the signed policy.
    pub reviewer_role: String,
    /// Independent reviewer trust domain assigned by the signed policy.
    pub trust_domain: String,
    /// Signed vote disposition (`approve` or `reject`).
    pub decision: String,
    /// One-use UUID from the signed vote.
    pub nonce: String,
    /// Public root fingerprint that verified this vote.
    pub trust_root_sha256: String,
    /// SHA-256 of canonical signed envelope JSON.
    pub signed_envelope_hash: String,
    /// Signed envelope expiry, Unix milliseconds.
    pub expires_at_ms: i64,
}

/// Result of verifying a maker attestation and checker quorum.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedApprovalDecision {
    /// Identifier of the signed reusable approval policy.
    pub policy_id: String,
    /// Monotonic policy version.
    pub policy_version: u64,
    /// Canonical signed policy envelope hash.
    pub policy_hash: String,
    /// Authenticated action-intent maker identity.
    pub maker_subject: String,
    /// One-use UUID from the maker attestation.
    pub maker_nonce: String,
    /// SHA-256 of canonical signed maker envelope JSON.
    pub maker_envelope_hash: String,
    /// SHA-256 of the canonical candidate binding.
    pub binding_hash: String,
    /// All verified checker decisions, including any non-vetoing reject.
    pub checker_votes: Vec<VerifiedCheckerVote>,
    /// Sorted identities whose approve votes count toward quorum.
    pub approved_reviewer_subjects: Vec<String>,
    /// Sorted distinct trust domains represented by approve votes.
    pub approved_trust_domains: Vec<String>,
    /// Earliest expiry among policy, maker and quorum approve votes.
    pub valid_until_ms: i64,
}

/// Raw signed approval evidence and the trusted candidate binding it must match.
#[derive(Debug, Clone, Copy)]
pub struct ApprovalDecisionEvidence<'a> {
    /// Signed reusable policy envelope.
    pub policy_envelope: &'a Value,
    /// Complete binding freshly derived from the current candidate.
    pub expected_binding: &'a Value,
    /// Provider-signed action-intent maker attestation.
    pub maker_attestation: &'a Value,
    /// Provider-signed checker votes.
    pub decisions: &'a [Value],
}

/// Typed local checker-vote evidence for the existing approval verifier.
///
/// The policy, expected candidate binding and maker envelope retain the same
/// semantics as [`ApprovalDecisionEvidence`]; only the checker vote inputs are
/// represented by the closed local [`ReviewerAttestationV1`] view.
#[derive(Debug, Clone, Copy)]
pub struct TypedApprovalDecisionEvidence<'a> {
    /// Signed reusable policy envelope.
    pub policy_envelope: &'a Value,
    /// Complete binding freshly derived from the current candidate.
    pub expected_binding: &'a Value,
    /// Provider-signed action-intent maker attestation.
    pub maker_attestation: &'a Value,
    /// Structurally parsed, not-yet-authenticated checker vote views.
    pub reviewer_attestations: &'a [ReviewerAttestationV1],
}

/// Error from the typed checker-vote adapter.
///
/// Structural input rejection remains distinct from trust/signature/policy
/// rejection; neither is collapsed into a newly invented diagnostic code.
#[derive(Debug, Error)]
pub enum ReviewerAttestationVerificationError {
    /// The local typed V1 view rejected the input shape.
    #[error(transparent)]
    ReviewerAttestation(#[from] ReviewerAttestationError),
    /// The existing approval verifier rejected trust, signature, policy,
    /// candidate binding, quorum, transaction or nonce semantics.
    #[error(transparent)]
    Trust(#[from] TrustError),
}

/// Whether this verifier is consuming a new approval or revalidating the
/// exact previously consumed evidence during task claim/provider dispatch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecisionMode {
    /// Verify and atomically consume every one-use nonce.
    Consume,
    /// Verify signatures and require exact prior nonce/high-water records;
    /// do not write or consume the nonce a second time.
    Revalidate,
}

struct VerifiedInputs<'a> {
    policy: &'a VerifiedApprovalPolicy,
    expected_binding: &'a Value,
    maker: &'a Value,
    decisions: &'a [Value],
}

/// Verify maker/checker evidence and atomically reserve its one-use nonces.
///
/// Verify the signed policy first, then its candidate-bound maker and checker
/// evidence. The expected binding must be freshly derived by the caller and is
/// compared canonically with the maker and every vote. The reusable policy
/// envelope is excluded from nonce replay tracking.
pub fn verify_approval_evidence(
    configurations: &TrustConfigurationSet,
    trust_ledger: &dyn TrustConfigurationObserver,
    evidence: ApprovalDecisionEvidence<'_>,
    transaction: &Transaction<'_>,
    now_ms: i64,
) -> Result<VerifiedApprovalDecision, TrustError> {
    verify_approval_evidence_with_mode(
        configurations,
        trust_ledger,
        evidence,
        transaction,
        now_ms,
        ApprovalDecisionMode::Consume,
    )
}

/// Verify a Node-compatible schema-v1 approval evidence envelope.
///
/// Exact outer keys are `schema_version`, `policy`, `maker_attestation`, and
/// `decisions`. The expected candidate binding is supplied separately by a
/// trusted current-snapshot resolver, never copied from the signed payload.
pub fn verify_approval_evidence_envelope(
    configurations: &TrustConfigurationSet,
    trust_ledger: &dyn TrustConfigurationObserver,
    envelope: &Value,
    expected_binding: &Value,
    transaction: &Transaction<'_>,
    now_ms: i64,
    mode: ApprovalDecisionMode,
) -> Result<VerifiedApprovalDecision, TrustError> {
    let Some(object) = envelope.as_object() else {
        return Err(rejected(
            "AGG_APPROVAL_EVIDENCE_SHAPE_INVALID",
            "approval evidence must be an object",
        ));
    };
    let expected_keys = ["schema_version", "policy", "maker_attestation", "decisions"];
    if object.len() != expected_keys.len()
        || object
            .keys()
            .any(|key| !expected_keys.contains(&key.as_str()))
    {
        return Err(rejected(
            "AGG_APPROVAL_EVIDENCE_SHAPE_INVALID",
            "approval evidence must contain exactly schema_version, policy, maker_attestation and decisions",
        ));
    }
    if required_positive_integer(object.get("schema_version"), "approval_evidence")? != 1 {
        return Err(rejected(
            "AGG_APPROVAL_EVIDENCE_SCHEMA_UNSUPPORTED",
            "approval evidence schema_version must be 1",
        ));
    }
    let decisions = object
        .get("decisions")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            rejected(
                "AGG_APPROVAL_EVIDENCE_SHAPE_INVALID",
                "approval evidence decisions must be an array",
            )
        })?;
    verify_approval_evidence_with_mode(
        configurations,
        trust_ledger,
        ApprovalDecisionEvidence {
            policy_envelope: object.get("policy").expect("exact key checked"),
            expected_binding,
            maker_attestation: object.get("maker_attestation").expect("exact key checked"),
            decisions,
        },
        transaction,
        now_ms,
        mode,
    )
}

/// Verify maker/checker evidence in consume or revalidation mode.
pub fn verify_approval_evidence_with_mode(
    configurations: &TrustConfigurationSet,
    trust_ledger: &dyn TrustConfigurationObserver,
    evidence: ApprovalDecisionEvidence<'_>,
    transaction: &Transaction<'_>,
    now_ms: i64,
    mode: ApprovalDecisionMode,
) -> Result<VerifiedApprovalDecision, TrustError> {
    let policy = verify_approval_policy_in_transaction(
        configurations,
        trust_ledger,
        transaction,
        evidence.policy_envelope,
        now_ms,
    )?;
    verify_approval_decision(
        configurations,
        trust_ledger,
        VerifiedInputs {
            policy: &policy,
            expected_binding: evidence.expected_binding,
            maker: evidence.maker_attestation,
            decisions: evidence.decisions,
        },
        transaction,
        now_ms,
        mode,
    )
}

/// Verify typed local V1 checker-vote views through the existing approval
/// verifier without changing its signed-envelope or transaction semantics.
///
/// Each typed view is converted to the verifier's existing JSON input and then
/// delegated to [`verify_approval_evidence_with_mode`]. Signature verification,
/// current trust configuration, maker/checker separation, reviewer registry,
/// quorum/veto, candidate binding, high-water and nonce replay remain owned by
/// that verifier. The returned error preserves structural input failures
/// separately from its existing [`TrustError`] values.
pub fn verify_approval_evidence_with_reviewer_attestations(
    configurations: &TrustConfigurationSet,
    trust_ledger: &dyn TrustConfigurationObserver,
    evidence: TypedApprovalDecisionEvidence<'_>,
    transaction: &Transaction<'_>,
    now_ms: i64,
    mode: ApprovalDecisionMode,
) -> Result<VerifiedApprovalDecision, ReviewerAttestationVerificationError> {
    let decision_values = evidence
        .reviewer_attestations
        .iter()
        .map(ReviewerAttestationV1::to_value)
        .collect::<Result<Vec<_>, _>>()?;

    verify_approval_evidence_with_mode(
        configurations,
        trust_ledger,
        ApprovalDecisionEvidence {
            policy_envelope: evidence.policy_envelope,
            expected_binding: evidence.expected_binding,
            maker_attestation: evidence.maker_attestation,
            decisions: &decision_values,
        },
        transaction,
        now_ms,
        mode,
    )
    .map_err(ReviewerAttestationVerificationError::from)
}

fn verify_approval_decision(
    configurations: &TrustConfigurationSet,
    trust_ledger: &dyn TrustConfigurationObserver,
    inputs: VerifiedInputs<'_>,
    transaction: &Transaction<'_>,
    now_ms: i64,
    mode: ApprovalDecisionMode,
) -> Result<VerifiedApprovalDecision, TrustError> {
    transaction.execute_batch(&format!("SAVEPOINT {SAVEPOINT}"))?;
    let result = verify_inner(
        configurations,
        trust_ledger,
        inputs,
        transaction,
        now_ms,
        mode,
    );
    match result {
        Ok(verified) => {
            transaction.execute_batch(&format!("RELEASE SAVEPOINT {SAVEPOINT}"))?;
            Ok(verified)
        }
        Err(error) => {
            let _ = transaction.execute_batch(&format!(
                "ROLLBACK TO SAVEPOINT {SAVEPOINT}; RELEASE SAVEPOINT {SAVEPOINT}"
            ));
            Err(error)
        }
    }
}

fn verify_inner(
    configurations: &TrustConfigurationSet,
    trust_ledger: &dyn TrustConfigurationObserver,
    inputs: VerifiedInputs<'_>,
    transaction: &Transaction<'_>,
    now_ms: i64,
    mode: ApprovalDecisionMode,
) -> Result<VerifiedApprovalDecision, TrustError> {
    let VerifiedInputs {
        policy,
        expected_binding,
        maker,
        decisions,
    } = inputs;
    if now_ms < 0 || now_ms as u64 > 9_007_199_254_740_991 {
        return Err(rejected(
            "AGG_APPROVAL_CLOCK_INVALID",
            "approval verification time must be a non-negative safe integer",
        ));
    }
    if !expected_binding.is_object() {
        return Err(rejected(
            "AGG_APPROVAL_BINDING_UNAVAILABLE",
            "expected candidate binding must be a JSON object",
        ));
    }
    configurations.assert_disjoint()?;
    configurations.assert_observed_in_transaction(trust_ledger, transaction)?;
    if policy.policy_id.trim().is_empty()
        || policy.policy_version == 0
        || !is_sha256(&policy.policy_hash)
        || !policy.maker_checker_separation
        || !policy.reject_veto
        || policy.required_approval_count == 0
        || policy.required_distinct_trust_domains == 0
        || policy.required_distinct_trust_domains > policy.required_approval_count
        || policy.max_vote_age_seconds == 0
        || policy.max_vote_age_seconds > 86_400
        || policy.required_roles.is_empty()
        || policy.reviewer_registry.is_empty()
        || policy.envelope.expires_at_ms <= now_ms
    {
        return Err(rejected(
            "AGG_APPROVAL_POLICY_RULES_INVALID",
            "verified approval policy fields are incomplete or outside supported bounds",
        ));
    }
    if decisions.is_empty() || decisions.len() > 64 {
        return Err(rejected(
            "AGG_APPROVAL_EVIDENCE_SHAPE_INVALID",
            "approval evidence must contain 1-64 signed checker decisions",
        ));
    }
    let maker_config = required_config(configurations, "action_intent_maker")?;
    let decision_config = required_config(configurations, "execution_approval")?;
    let policy_config = required_config(configurations, "execution_approval_policy")?;
    // Recheck policy-authority separation even if a caller assembled a public
    // VerifiedApprovalPolicy struct manually instead of using the verifier.
    if policy.envelope.trust_root_sha256
        != policy_config
            .find_root(&policy.envelope.trust_root_sha256, None, now_ms)?
            .trust_root_sha256
    {
        return Err(rejected(
            "AGG_APPROVAL_POLICY_ROOT_UNTRUSTED",
            "verified policy root is not in the configured policy authority domain",
        ));
    }

    exact_keys(
        maker,
        &[
            "schema_version",
            "kind",
            "provider_id",
            "trust_root_sha256",
            "nonce",
            "issued_at",
            "expires_at",
            "scope",
            "maker_subject",
            "policy_id",
            "policy_version",
            "policy_hash",
            "binding",
            "signature_algorithm",
            "signature",
        ],
        "maker_attestation",
    )?;
    let maker_envelope =
        verify_signed_envelope(maker_config, maker, MAKER_SCOPE, MAKER_KIND, now_ms)?;
    let maker_object = maker.as_object().expect("exact object checked");
    let maker_subject = bounded_string(maker_object.get("maker_subject"), "maker_subject", 200)?;
    assert_policy_binding(maker_object, policy, expected_binding, "maker_attestation")?;
    if maker_envelope.issued_at_ms < policy.envelope.issued_at_ms
        || maker_envelope.expires_at_ms > policy.envelope.expires_at_ms
    {
        return Err(rejected(
            "AGG_APPROVAL_MAKER_BINDING_MISMATCH",
            "maker attestation validity window must be contained within signed policy validity",
        ));
    }

    let registry: BTreeMap<&str, (&str, &str, &str)> = policy
        .reviewer_registry
        .iter()
        .map(|reviewer| {
            (
                reviewer.subject.as_str(),
                (
                    reviewer.role.as_str(),
                    reviewer.trust_domain.as_str(),
                    reviewer.trust_root_sha256.as_str(),
                ),
            )
        })
        .collect();
    if registry.len() != policy.reviewer_registry.len() {
        return Err(rejected(
            "AGG_APPROVAL_POLICY_REVIEWER_DUPLICATE",
            "verified policy reviewer registry contains duplicate subjects",
        ));
    }

    let mut subjects = BTreeSet::new();
    let mut approve_domains = BTreeSet::new();
    let mut approve_roles = BTreeSet::new();
    let mut nonce_set = BTreeSet::new();
    let mut verified_votes = Vec::with_capacity(decisions.len());
    let mut has_reject = false;
    for (index, vote) in decisions.iter().enumerate() {
        let field = format!("decisions[{index}]");
        exact_keys(
            vote,
            &[
                "schema_version",
                "kind",
                "provider_id",
                "trust_root_sha256",
                "nonce",
                "issued_at",
                "expires_at",
                "scope",
                "policy_id",
                "policy_version",
                "policy_hash",
                "reviewer_subject",
                "reviewer_role",
                "trust_domain",
                "decision",
                "binding",
                "signature_algorithm",
                "signature",
            ],
            &field,
        )?;
        let envelope =
            verify_signed_envelope(decision_config, vote, DECISION_SCOPE, DECISION_KIND, now_ms)?;
        let object = vote.as_object().expect("exact object checked");
        let subject = bounded_string(object.get("reviewer_subject"), "reviewer_subject", 200)?;
        let role = bounded_string(object.get("reviewer_role"), "reviewer_role", 120)?;
        let domain = bounded_string(object.get("trust_domain"), "trust_domain", 120)?;
        let decision = bounded_string(object.get("decision"), "decision", 16)?;
        let root = required_string(object, "trust_root_sha256", &field)?;
        let Some((registered_role, registered_domain, registered_root)) =
            registry.get(subject.as_str())
        else {
            return Err(rejected(
                "AGG_APPROVAL_DECISION_BINDING_MISMATCH",
                format!("{field} reviewer is absent from the signed policy registry"),
            ));
        };
        if role != *registered_role
            || domain != *registered_domain
            || root != *registered_root
            || root == policy.envelope.trust_root_sha256
            || !same_json(object.get("binding"), expected_binding)?
            || required_string(object, "policy_id", &field)? != policy.policy_id
            || required_positive_integer(object.get("policy_version"), &field)?
                != policy.policy_version
            || required_string(object, "policy_hash", &field)? != policy.policy_hash
            || envelope.issued_at_ms < policy.envelope.issued_at_ms
            || envelope.issued_at_ms
                < now_ms.saturating_sub((policy.max_vote_age_seconds as i64) * 1000)
            || envelope.expires_at_ms > policy.envelope.expires_at_ms
        {
            return Err(rejected(
                "AGG_APPROVAL_DECISION_BINDING_MISMATCH",
                format!(
                    "{field} does not match signed reviewer registry, policy, candidate binding or validity window"
                ),
            ));
        }
        if !subjects.insert(subject.clone()) {
            return Err(rejected(
                "AGG_APPROVAL_REVIEWER_DUPLICATE",
                "one authenticated reviewer may cast at most one vote",
            ));
        }
        if !nonce_set.insert(envelope.nonce.clone()) {
            return Err(rejected(
                "AGG_APPROVAL_NONCE_DUPLICATE",
                "maker attestation and checker decisions must use distinct nonces",
            ));
        }
        match decision.as_str() {
            "approve" => {
                approve_domains.insert(domain.clone());
                approve_roles.insert(role.clone());
            }
            "reject" => has_reject = true,
            _ => {
                return Err(rejected(
                    "AGG_APPROVAL_DECISION_INVALID",
                    format!("{field}.decision must be approve or reject"),
                ));
            }
        }
        verified_votes.push(VerifiedCheckerVote {
            reviewer_subject: subject,
            reviewer_role: role,
            trust_domain: domain,
            decision,
            nonce: envelope.nonce,
            trust_root_sha256: root,
            signed_envelope_hash: envelope.signed_envelope_hash,
            expires_at_ms: envelope.expires_at_ms,
        });
    }
    if subjects.contains(&maker_subject) {
        return Err(rejected(
            "AGG_APPROVAL_MAKER_CHECKER_VIOLATION",
            "authenticated maker may not cast a checker vote for the same candidate",
        ));
    }
    if has_reject && policy.reject_veto {
        return Err(rejected(
            "AGG_APPROVAL_VETO_REJECTED",
            "signed policy requires any reject vote to veto approval",
        ));
    }
    let approved_count = verified_votes
        .iter()
        .filter(|vote| vote.decision == "approve")
        .count();
    if approved_count < policy.required_approval_count as usize
        || approve_domains.len() < policy.required_distinct_trust_domains as usize
        || policy
            .required_roles
            .iter()
            .any(|role| !approve_roles.contains(role))
    {
        return Err(rejected(
            "AGG_APPROVAL_QUORUM_NOT_MET",
            "signed approval evidence does not meet reviewer count, distinct trust-domain quorum and required roles",
        ));
    }

    if !nonce_set.insert(maker_envelope.nonce.clone()) {
        return Err(rejected(
            "AGG_APPROVAL_NONCE_DUPLICATE",
            "maker attestation and checker decisions must use distinct nonces",
        ));
    }
    let binding_canonical = canonical(expected_binding)?;
    let binding_hash = hex::encode(Sha256::digest(binding_canonical.as_bytes()));
    let maker_nonce = maker_envelope.nonce.clone();
    let maker_hash = maker_envelope.signed_envelope_hash.clone();
    let mut nonce_records = vec![(maker_nonce.clone(), maker_hash.clone())];
    nonce_records.extend(
        verified_votes
            .iter()
            .map(|vote| (vote.nonce.clone(), vote.signed_envelope_hash.clone())),
    );
    ensure_storage(transaction)?;
    let append_policy_version = check_policy_high_water(transaction, policy)?;
    if mode == ApprovalDecisionMode::Revalidate && append_policy_version {
        return Err(rejected(
            "AGG_APPROVAL_POLICY_NOT_OBSERVED",
            "persisted approval policy version has no durable high-water record",
        ));
    }
    for (nonce, signed_envelope_hash) in &nonce_records {
        let existing: Option<(String, i64, String, String, String)> = transaction
            .query_row(
                "SELECT policy_id,policy_version,policy_hash,binding_hash,signed_envelope_hash FROM runalith_approval_decision_nonces_v1 WHERE nonce=?1",
                params![nonce],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
            )
            .optional()?;
        match (mode, existing) {
            (ApprovalDecisionMode::Consume, Some(_)) => {
                return Err(rejected(
                    "AGG_APPROVAL_NONCE_REPLAY",
                    format!("approval evidence nonce {nonce} was already accepted"),
                ));
            }
            (ApprovalDecisionMode::Revalidate, None) => {
                return Err(rejected(
                    "AGG_APPROVAL_REPLAY_LEDGER_UNVERIFIABLE",
                    format!("persisted approval nonce {nonce} is absent from the replay ledger"),
                ));
            }
            (
                ApprovalDecisionMode::Revalidate,
                Some((policy_id, version, policy_hash, stored_binding, stored_envelope)),
            ) if policy_id != policy.policy_id
                || version != policy.policy_version as i64
                || policy_hash != policy.policy_hash
                || stored_binding != binding_hash
                || stored_envelope != *signed_envelope_hash =>
            {
                return Err(rejected(
                    "AGG_APPROVAL_REPLAY_LEDGER_UNVERIFIABLE",
                    format!(
                        "persisted approval nonce {nonce} does not match exact signed evidence"
                    ),
                ));
            }
            _ => {}
        }
    }

    let valid_until_ms = verified_votes
        .iter()
        .filter(|vote| vote.decision == "approve")
        .fold(
            maker_envelope
                .expires_at_ms
                .min(policy.envelope.expires_at_ms),
            |valid_until, vote| valid_until.min(vote.expires_at_ms),
        );
    let mut approved_reviewer_subjects: Vec<String> = verified_votes
        .iter()
        .filter(|vote| vote.decision == "approve")
        .map(|vote| vote.reviewer_subject.clone())
        .collect();
    approved_reviewer_subjects.sort();
    let approved_trust_domains: Vec<String> = approve_domains.into_iter().collect();

    if mode == ApprovalDecisionMode::Consume {
        if append_policy_version {
            transaction.execute(
                "INSERT INTO runalith_approval_policy_history_v1(policy_id,policy_version,policy_hash)
                 VALUES(?1,?2,?3)",
                params![
                    policy.policy_id,
                    policy.policy_version as i64,
                    policy.policy_hash
                ],
            )?;
        }
        for (nonce, signed_envelope_hash) in &nonce_records {
            transaction.execute(
                "INSERT INTO runalith_approval_decision_nonces_v1(nonce,policy_id,policy_version,policy_hash,binding_hash,signed_envelope_hash)
                 VALUES(?1,?2,?3,?4,?5,?6)",
                params![nonce, policy.policy_id, policy.policy_version as i64, policy.policy_hash, binding_hash, signed_envelope_hash],
            )?;
        }
    }
    Ok(VerifiedApprovalDecision {
        policy_id: policy.policy_id.clone(),
        policy_version: policy.policy_version,
        policy_hash: policy.policy_hash.clone(),
        maker_subject,
        maker_nonce,
        maker_envelope_hash: maker_hash,
        binding_hash,
        checker_votes: verified_votes,
        approved_reviewer_subjects,
        approved_trust_domains,
        valid_until_ms,
    })
}

fn ensure_storage(transaction: &Transaction<'_>) -> Result<(), TrustError> {
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS runalith_approval_policy_history_v1 (
             policy_id TEXT NOT NULL,
             policy_version INTEGER NOT NULL CHECK(policy_version > 0),
             policy_hash TEXT NOT NULL CHECK(length(policy_hash)=64),
             PRIMARY KEY(policy_id,policy_version)
         );
         CREATE TABLE IF NOT EXISTS runalith_approval_decision_nonces_v1 (
             nonce TEXT PRIMARY KEY NOT NULL,
             policy_id TEXT NOT NULL,
             policy_version INTEGER NOT NULL CHECK(policy_version > 0),
             policy_hash TEXT NOT NULL CHECK(length(policy_hash)=64),
             binding_hash TEXT NOT NULL CHECK(length(binding_hash)=64),
             signed_envelope_hash TEXT NOT NULL CHECK(length(signed_envelope_hash)=64)
         );
         CREATE TRIGGER IF NOT EXISTS runalith_approval_policy_history_v1_no_duplicate
         BEFORE INSERT ON runalith_approval_policy_history_v1
         WHEN EXISTS(SELECT 1 FROM runalith_approval_policy_history_v1
                     WHERE policy_id=NEW.policy_id AND policy_version=NEW.policy_version)
         BEGIN SELECT RAISE(ABORT,'approval policy history is append-only'); END;
         CREATE TRIGGER IF NOT EXISTS runalith_approval_policy_history_v1_no_update
         BEFORE UPDATE ON runalith_approval_policy_history_v1
         BEGIN SELECT RAISE(ABORT,'approval policy history is append-only'); END;
         CREATE TRIGGER IF NOT EXISTS runalith_approval_policy_history_v1_no_delete
         BEFORE DELETE ON runalith_approval_policy_history_v1
         BEGIN SELECT RAISE(ABORT,'approval policy history is append-only'); END;
         CREATE TRIGGER IF NOT EXISTS runalith_approval_decision_nonces_v1_no_duplicate
         BEFORE INSERT ON runalith_approval_decision_nonces_v1
         WHEN EXISTS(SELECT 1 FROM runalith_approval_decision_nonces_v1 WHERE nonce=NEW.nonce)
         BEGIN SELECT RAISE(ABORT,'approval nonce ledger is append-only'); END;
         CREATE TRIGGER IF NOT EXISTS runalith_approval_decision_nonces_v1_no_update
         BEFORE UPDATE ON runalith_approval_decision_nonces_v1
         BEGIN SELECT RAISE(ABORT,'approval nonce ledger is append-only'); END;
         CREATE TRIGGER IF NOT EXISTS runalith_approval_decision_nonces_v1_no_delete
         BEFORE DELETE ON runalith_approval_decision_nonces_v1
         BEGIN SELECT RAISE(ABORT,'approval nonce ledger is append-only'); END;",
    )?;
    validate_table(
        transaction,
        "runalith_approval_policy_history_v1",
        &[
            ("policy_id", "TEXT", 1, 1),
            ("policy_version", "INTEGER", 1, 2),
            ("policy_hash", "TEXT", 1, 0),
        ],
    )?;
    validate_table(
        transaction,
        "runalith_approval_decision_nonces_v1",
        &[
            ("nonce", "TEXT", 1, 1),
            ("policy_id", "TEXT", 1, 0),
            ("policy_version", "INTEGER", 1, 0),
            ("policy_hash", "TEXT", 1, 0),
            ("binding_hash", "TEXT", 1, 0),
            ("signed_envelope_hash", "TEXT", 1, 0),
        ],
    )?;
    for trigger in [
        "runalith_approval_policy_history_v1_no_duplicate",
        "runalith_approval_policy_history_v1_no_update",
        "runalith_approval_policy_history_v1_no_delete",
        "runalith_approval_decision_nonces_v1_no_duplicate",
        "runalith_approval_decision_nonces_v1_no_update",
        "runalith_approval_decision_nonces_v1_no_delete",
    ] {
        let sql: Option<String> = transaction
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?1",
                params![trigger],
                |row| row.get(0),
            )
            .optional()?;
        let Some(sql) = sql else {
            return Err(rejected(
                "AGG_APPROVAL_REPLAY_LEDGER_UNVERIFIABLE",
                "approval append-only trigger is missing",
            ));
        };
        if sql.trim().is_empty() {
            return Err(rejected(
                "AGG_APPROVAL_REPLAY_LEDGER_UNVERIFIABLE",
                "approval append-only trigger has an empty definition",
            ));
        }
    }
    probe_append_only_triggers(transaction)?;
    Ok(())
}

/// Exercise each append-only trigger against sentinel rows in a nested
/// savepoint. This validates SQLite's actual trigger behavior, including
/// INSERT OR REPLACE semantics, instead of trusting trigger SQL text.
fn probe_append_only_triggers(transaction: &Transaction<'_>) -> Result<(), TrustError> {
    const PROBE: &str = "runalith_approval_trigger_probe_v1";
    let sentinel = Uuid::new_v4().to_string();
    let policy_hash = "a".repeat(64);
    let nonce_policy_hash = "b".repeat(64);
    let nonce_binding_hash = "c".repeat(64);
    transaction.execute_batch(&format!("SAVEPOINT {PROBE}"))?;
    let result = (|| {
        transaction.execute(
            "INSERT INTO runalith_approval_policy_history_v1(policy_id,policy_version,policy_hash) VALUES(?1,1,?2)",
            params![sentinel, policy_hash],
        )?;
        transaction.execute(
            "INSERT INTO runalith_approval_decision_nonces_v1(nonce,policy_id,policy_version,policy_hash,binding_hash,signed_envelope_hash) VALUES(?1,?2,1,?3,?4,?5)",
            params![sentinel, sentinel, nonce_policy_hash, nonce_binding_hash, "d".repeat(64)],
        )?;

        for (label, sql, values) in [
            (
                "policy duplicate INSERT",
                "INSERT INTO runalith_approval_policy_history_v1(policy_id,policy_version,policy_hash) VALUES(?1,1,?2)",
                vec!["d".repeat(64)],
            ),
            (
                "policy duplicate REPLACE",
                "INSERT OR REPLACE INTO runalith_approval_policy_history_v1(policy_id,policy_version,policy_hash) VALUES(?1,1,?2)",
                vec!["e".repeat(64)],
            ),
            (
                "policy UPDATE",
                "UPDATE runalith_approval_policy_history_v1 SET policy_hash=?1 WHERE policy_id=?2",
                vec!["f".repeat(64)],
            ),
            (
                "policy DELETE",
                "DELETE FROM runalith_approval_policy_history_v1 WHERE policy_id=?1",
                vec![],
            ),
            (
                "nonce duplicate INSERT",
                "INSERT INTO runalith_approval_decision_nonces_v1(nonce,policy_id,policy_version,policy_hash,binding_hash,signed_envelope_hash) VALUES(?1,'other',1,?2,?3,?4)",
                vec!["d".repeat(64), "e".repeat(64), "f".repeat(64)],
            ),
            (
                "nonce duplicate REPLACE",
                "INSERT OR REPLACE INTO runalith_approval_decision_nonces_v1(nonce,policy_id,policy_version,policy_hash,binding_hash,signed_envelope_hash) VALUES(?1,'other',1,?2,?3,?4)",
                vec!["f".repeat(64), "a".repeat(64), "b".repeat(64)],
            ),
            (
                "nonce UPDATE",
                "UPDATE runalith_approval_decision_nonces_v1 SET binding_hash=?1 WHERE nonce=?2",
                vec!["d".repeat(64)],
            ),
            (
                "nonce DELETE",
                "DELETE FROM runalith_approval_decision_nonces_v1 WHERE nonce=?1",
                vec![],
            ),
        ] {
            let mut bound_values = values;
            if label.ends_with("UPDATE") {
                bound_values.push(sentinel.clone());
            } else {
                bound_values.insert(0, sentinel.clone());
            }
            let outcome = transaction.execute(sql, rusqlite::params_from_iter(bound_values.iter()));
            if outcome.is_ok() {
                return Err(rejected(
                    "AGG_APPROVAL_REPLAY_LEDGER_UNVERIFIABLE",
                    format!("approval append-only trigger failed behavioral probe: {label}"),
                ));
            }
        }
        Ok(())
    })();
    let cleanup = transaction.execute_batch(&format!(
        "ROLLBACK TO SAVEPOINT {PROBE}; RELEASE SAVEPOINT {PROBE}"
    ));
    match (result, cleanup) {
        (Err(error), _) => Err(error),
        (Ok(()), Err(error)) => Err(error.into()),
        (Ok(()), Ok(())) => Ok(()),
    }
}

fn validate_table(
    transaction: &Transaction<'_>,
    table: &str,
    expected: &[(&str, &str, i64, i64)],
) -> Result<(), TrustError> {
    let mut statement = transaction.prepare(&format!("PRAGMA table_info({table})"))?;
    let actual = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if actual.len() != expected.len()
        || actual.iter().zip(expected).any(|(actual, expected)| {
            actual.0 != expected.0
                || !actual.1.eq_ignore_ascii_case(expected.1)
                || actual.2 != expected.2
                || actual.3 != expected.3
        })
    {
        return Err(rejected(
            "AGG_APPROVAL_REPLAY_LEDGER_UNVERIFIABLE",
            format!("approval ledger table {table} has an unsupported schema"),
        ));
    }
    Ok(())
}

fn check_policy_high_water(
    transaction: &Transaction<'_>,
    policy: &VerifiedApprovalPolicy,
) -> Result<bool, TrustError> {
    let latest: Option<(i64, String)> = transaction
        .query_row(
            "SELECT policy_version,policy_hash FROM runalith_approval_policy_history_v1 WHERE policy_id=?1 ORDER BY policy_version DESC LIMIT 1",
            params![policy.policy_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((version, hash)) = latest {
        if policy.policy_version < version as u64 {
            return Err(rejected(
                "AGG_APPROVAL_POLICY_ROLLBACK",
                format!(
                    "policy version {} is older than observed high-water version {version}",
                    policy.policy_version
                ),
            ));
        }
        if policy.policy_version == version as u64 && policy.policy_hash != hash {
            return Err(rejected(
                "AGG_APPROVAL_POLICY_VERSION_REUSED",
                "approval policy reused an observed version with a different signed hash",
            ));
        }
        if policy.policy_version == version as u64 {
            return Ok(false);
        }
        if policy.policy_version != (version as u64).saturating_add(1) {
            return Err(rejected(
                "AGG_APPROVAL_POLICY_VERSION_GAP",
                format!(
                    "new approval policy version {} must immediately follow observed version {version}",
                    policy.policy_version
                ),
            ));
        }
    }
    Ok(true)
}

fn assert_policy_binding(
    object: &Map<String, Value>,
    policy: &VerifiedApprovalPolicy,
    binding: &Value,
    field: &str,
) -> Result<(), TrustError> {
    if required_string(object, "policy_id", field)? != policy.policy_id
        || required_positive_integer(object.get("policy_version"), field)? != policy.policy_version
        || required_string(object, "policy_hash", field)? != policy.policy_hash
        || !same_json(object.get("binding"), binding)?
    {
        return Err(rejected(
            "AGG_APPROVAL_MAKER_BINDING_MISMATCH",
            format!("{field} does not bind the exact signed policy and current candidate"),
        ));
    }
    Ok(())
}

fn required_config<'a>(
    configurations: &'a TrustConfigurationSet,
    domain: &str,
) -> Result<&'a crate::trust_config::TrustConfiguration, TrustError> {
    configurations.get(domain).ok_or_else(|| {
        rejected(
            "AGG_TRUST_CONFIG_NOT_CONFIGURED",
            format!("required trust domain {domain} is missing"),
        )
    })
}

fn exact_keys(value: &Value, expected: &[&str], field: &str) -> Result<(), TrustError> {
    let object = value.as_object().ok_or_else(|| {
        rejected(
            "AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID",
            format!("{field} must be an object"),
        )
    })?;
    if object.len() != expected.len() || object.keys().any(|key| !expected.contains(&key.as_str()))
    {
        return Err(rejected(
            "AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID",
            format!("{field} contains missing or unsupported fields"),
        ));
    }
    Ok(())
}

fn bounded_string(value: Option<&Value>, field: &str, max: usize) -> Result<String, TrustError> {
    let value = value.and_then(Value::as_str).ok_or_else(|| {
        rejected(
            "AGG_APPROVAL_EVIDENCE_SHAPE_INVALID",
            format!("{field} must be a string"),
        )
    })?;
    if value.trim().is_empty() || value.trim() != value || value.encode_utf16().count() > max {
        return Err(rejected(
            "AGG_APPROVAL_EVIDENCE_SHAPE_INVALID",
            format!("{field} must be a bounded, trimmed non-empty string"),
        ));
    }
    Ok(value.to_owned())
}

fn required_string(
    object: &Map<String, Value>,
    field: &str,
    context: &str,
) -> Result<String, TrustError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            rejected(
                "AGG_APPROVAL_EVIDENCE_SHAPE_INVALID",
                format!("{context}.{field} must be a string"),
            )
        })
}

fn required_positive_integer(value: Option<&Value>, context: &str) -> Result<u64, TrustError> {
    let value = value
        .and_then(Value::as_u64)
        .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
        .ok_or_else(|| {
            rejected(
                "AGG_APPROVAL_EVIDENCE_SHAPE_INVALID",
                format!("{context}.policy_version must be a positive safe integer"),
            )
        })?;
    Ok(value)
}

fn same_json(left: Option<&Value>, right: &Value) -> Result<bool, TrustError> {
    let Some(left) = left else { return Ok(false) };
    Ok(canonical(left)? == canonical(right)?)
}

fn canonical(value: &Value) -> Result<String, TrustError> {
    runalith_protocol::agg_checkpoint_v2::canonicalize(value).map_err(|error| {
        rejected(
            "AGG_APPROVAL_EVIDENCE_SHAPE_INVALID",
            format!("approval evidence JSON cannot be canonicalized: {error}"),
        )
    })
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn rejected(code: &'static str, message: impl Into<String>) -> TrustError {
    TrustError::rejected(code, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval_policy::{VerifiedApprovalPolicy, verify_approval_policy};
    use crate::trust_ledger::TrustLedger;
    use rusqlite::Connection;
    use serde_json::json;
    use std::collections::{BTreeMap, HashMap};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use tempfile::TempDir;

    const NOW: i64 = 1_793_491_200_000;

    struct TestKey {
        private_path: PathBuf,
        public_pem: String,
        fingerprint: String,
    }
    struct TestContext {
        _directory: TempDir,
        keys: HashMap<String, TestKey>,
        configurations: TrustConfigurationSet,
        ledger: TrustLedger,
        policy: VerifiedApprovalPolicy,
        policy_envelope: Value,
        binding: Value,
    }

    fn generate_key(directory: &Path, name: &str) -> TestKey {
        let private_path = directory.join(format!("{name}.pem"));
        let public_path = directory.join(format!("{name}.pub.pem"));
        let generated = Command::new("/usr/bin/openssl")
            .args(["genpkey", "-algorithm", "ED25519", "-out"])
            .arg(&private_path)
            .output()
            .unwrap();
        assert!(
            generated.status.success(),
            "{}",
            String::from_utf8_lossy(&generated.stderr)
        );
        let exported = Command::new("/usr/bin/openssl")
            .args(["pkey", "-in"])
            .arg(&private_path)
            .args(["-pubout", "-out"])
            .arg(&public_path)
            .output()
            .unwrap();
        assert!(
            exported.status.success(),
            "{}",
            String::from_utf8_lossy(&exported.stderr)
        );
        let public_pem = fs::read_to_string(public_path).unwrap();
        let parsed = crate::Ed25519PublicKey::from_pem(&public_pem).unwrap();
        TestKey {
            private_path,
            public_pem,
            fingerprint: parsed.fingerprint().to_owned(),
        }
    }

    fn make_context_with(policy_version: u64, max_vote_age_seconds: u64) -> TestContext {
        let directory = tempfile::tempdir().unwrap();
        let mut keys = HashMap::new();
        for name in [
            "policy",
            "maker",
            "reviewer_a",
            "reviewer_b",
            "goal",
            "identity",
        ] {
            keys.insert(name.to_owned(), generate_key(directory.path(), name));
        }
        let specs = [
            (
                "goal_idea_verifier",
                "agg.goal_idea_graph.verify",
                vec!["goal"],
            ),
            (
                "action_intent_reviewer",
                "agg.action_intent.review",
                vec!["identity"],
            ),
            (
                "execution_approval_policy",
                "agg.approval.policy",
                vec!["policy"],
            ),
            (
                "action_intent_maker",
                "agg.action_intent.propose",
                vec!["maker"],
            ),
            (
                "execution_approval",
                "agg.execution.approve",
                vec!["reviewer_a", "reviewer_b"],
            ),
        ];
        let mut raw = BTreeMap::new();
        for (domain, scope, root_names) in specs {
            let roots: Vec<Value> = root_names.iter().enumerate().map(|(index, name)| {
                let key = &keys[*name];
                json!({"key_id":format!("{domain}-{index}"),"public_key_pem":key.public_pem,"scopes":[scope],"not_before":"2026-01-01T00:00:00.000Z","not_after":null,"revoked_at":null})
            }).collect();
            let config = json!({"schema_version":1,"domain":domain,"provider_id":format!("provider-{domain}"),"config_version":1,"updated_at":"2026-10-31T00:00:00.000Z","updated_by":"test-security-admin","change_reference":format!("TEST-{domain}-1"),"keys":roots});
            raw.insert(domain.to_owned(), serde_json::to_vec(&config).unwrap());
        }
        let configurations = TrustConfigurationSet::load_json(&raw, NOW).unwrap();
        let ledger = TrustLedger::in_memory().unwrap();
        configurations.record_observations(&ledger, NOW).unwrap();
        let policy_envelope = json!({
            "schema_version":1,"kind":"adaptive_goal_execution_approval_policy",
            "provider_id":"provider-execution_approval_policy",
            "trust_root_sha256":keys["policy"].fingerprint,
            "nonce":"30000000-0000-4000-8000-000000000001",
            "issued_at":timestamp(NOW-1_000),"expires_at":timestamp(NOW+600_000),
            "scope":"agg.approval.policy","policy_id":"policy-test",
            "policy_version":policy_version,"required_approval_count":2,
            "required_distinct_trust_domains":2,"required_roles":["reviewer","security"],
            "maker_checker_separation":true,"reject_veto":true,
            "max_vote_age_seconds":max_vote_age_seconds,
            "reviewer_registry":[
                {"subject":"alice","role":"reviewer","trust_domain":"team-a","trust_root_sha256":keys["reviewer_a"].fingerprint},
                {"subject":"bob","role":"security","trust_domain":"team-b","trust_root_sha256":keys["reviewer_b"].fingerprint}
            ],"signature_algorithm":"Ed25519"
        });
        let policy_envelope = sign(
            policy_envelope,
            &keys["policy"],
            directory.path(),
            "signed-policy",
        );
        let policy =
            verify_approval_policy(&configurations, &ledger, &policy_envelope, NOW).unwrap();
        TestContext {
            _directory: directory,
            keys,
            configurations,
            ledger,
            policy,
            policy_envelope,
            binding: json!({"schema_version":1,"wrapper_job_id":"job-test","candidate_hash":"b".repeat(64),"immutable_plan_hash":"c".repeat(64)}),
        }
    }

    fn make_context() -> TestContext {
        make_context_with(1, 3600)
    }

    fn timestamp(ms: i64) -> String {
        chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    fn base_envelope(
        context: &TestContext,
        key_name: &str,
        scope: &str,
        kind: &str,
        nonce: &str,
    ) -> Value {
        let provider = match key_name {
            "maker" => "provider-action_intent_maker",
            "policy" => "provider-execution_approval_policy",
            _ => "provider-execution_approval",
        };
        json!({"schema_version":1,"kind":kind,"provider_id":provider,"trust_root_sha256":context.keys[key_name].fingerprint,"nonce":nonce,"issued_at":timestamp(NOW-500),"expires_at":timestamp(NOW+300_000),"scope":scope,"signature_algorithm":"Ed25519"})
    }

    fn base64(bytes: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let a = chunk[0];
            let b = *chunk.get(1).unwrap_or(&0);
            let c = *chunk.get(2).unwrap_or(&0);
            out.push(ALPHABET[(a >> 2) as usize] as char);
            out.push(ALPHABET[(((a & 3) << 4) | (b >> 4)) as usize] as char);
            out.push(if chunk.len() > 1 {
                ALPHABET[(((b & 15) << 2) | (c >> 6)) as usize] as char
            } else {
                '='
            });
            out.push(if chunk.len() > 2 {
                ALPHABET[(c & 63) as usize] as char
            } else {
                '='
            });
        }
        out
    }

    fn sign(mut envelope: Value, key: &TestKey, directory: &Path, label: &str) -> Value {
        let canonical = runalith_protocol::agg_checkpoint_v2::canonicalize(&envelope).unwrap();
        let message = directory.join(format!("{label}.message"));
        let signature = directory.join(format!("{label}.signature"));
        fs::write(&message, canonical).unwrap();
        let result = Command::new("/usr/bin/openssl")
            .args(["pkeyutl", "-sign", "-inkey"])
            .arg(&key.private_path)
            .args(["-rawin", "-in"])
            .arg(&message)
            .args(["-out"])
            .arg(&signature)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        envelope["signature"] = json!(base64(&fs::read(signature).unwrap()));
        envelope
    }

    fn maker_for_subject(
        context: &TestContext,
        binding: &Value,
        subject: &str,
        nonce: &str,
    ) -> Value {
        let mut envelope = base_envelope(context, "maker", MAKER_SCOPE, MAKER_KIND, nonce);
        envelope["maker_subject"] = json!(subject);
        envelope["policy_id"] = json!(context.policy.policy_id);
        envelope["policy_version"] = json!(context.policy.policy_version);
        envelope["policy_hash"] = json!(context.policy.policy_hash);
        envelope["binding"] = binding.clone();
        sign(
            envelope,
            &context.keys["maker"],
            context._directory.path(),
            &format!("maker-{subject}"),
        )
    }

    fn maker(context: &TestContext, binding: &Value) -> Value {
        let nonce = format!(
            "10000000-0000-4000-8000-{:012x}",
            context.policy.policy_version
        );
        maker_for_subject(context, binding, "requester", &nonce)
    }

    fn vote(
        context: &TestContext,
        subject: &str,
        role: &str,
        domain: &str,
        key_name: &str,
        nonce: u8,
        binding: &Value,
    ) -> Value {
        let mut envelope = base_envelope(
            context,
            key_name,
            DECISION_SCOPE,
            DECISION_KIND,
            &format!(
                "20000000-0000-4000-8000-{:012x}",
                (context.policy.policy_version << 8) | u64::from(nonce)
            ),
        );
        envelope["policy_id"] = json!(context.policy.policy_id);
        envelope["policy_version"] = json!(context.policy.policy_version);
        envelope["policy_hash"] = json!(context.policy.policy_hash);
        envelope["reviewer_subject"] = json!(subject);
        envelope["reviewer_role"] = json!(role);
        envelope["trust_domain"] = json!(domain);
        envelope["decision"] = json!("approve");
        envelope["binding"] = binding.clone();
        sign(
            envelope,
            &context.keys[key_name],
            context._directory.path(),
            &format!("vote-{nonce}"),
        )
    }

    fn evidence(context: &TestContext, count: usize) -> (Value, Vec<Value>) {
        let votes = vec![
            vote(
                context,
                "alice",
                "reviewer",
                "team-a",
                "reviewer_a",
                1,
                &context.binding,
            ),
            vote(
                context,
                "bob",
                "security",
                "team-b",
                "reviewer_b",
                2,
                &context.binding,
            ),
        ];
        (
            maker(context, &context.binding),
            votes.into_iter().take(count).collect(),
        )
    }

    fn verify(
        context: &TestContext,
        connection: &mut Connection,
        maker: &Value,
        votes: &[Value],
        binding: &Value,
    ) -> Result<VerifiedApprovalDecision, TrustError> {
        verify_mode(
            context,
            connection,
            maker,
            votes,
            binding,
            ApprovalDecisionMode::Consume,
        )
    }

    fn verify_mode(
        context: &TestContext,
        connection: &mut Connection,
        maker: &Value,
        votes: &[Value],
        binding: &Value,
        mode: ApprovalDecisionMode,
    ) -> Result<VerifiedApprovalDecision, TrustError> {
        let transaction = connection.transaction().unwrap();
        let result = verify_approval_evidence_with_mode(
            &context.configurations,
            &context.ledger,
            ApprovalDecisionEvidence {
                policy_envelope: &context.policy_envelope,
                expected_binding: binding,
                maker_attestation: maker,
                decisions: votes,
            },
            &transaction,
            NOW,
            mode,
        );
        if result.is_ok() {
            transaction.commit().unwrap();
        } else {
            transaction.rollback().unwrap();
        }
        result
    }

    fn verify_envelope_mode(
        context: &TestContext,
        connection: &mut Connection,
        envelope: &Value,
        binding: &Value,
        mode: ApprovalDecisionMode,
    ) -> Result<VerifiedApprovalDecision, TrustError> {
        let transaction = connection.transaction().unwrap();
        let result = verify_approval_evidence_envelope(
            &context.configurations,
            &context.ledger,
            envelope,
            binding,
            &transaction,
            NOW,
            mode,
        );
        if result.is_ok() {
            transaction.commit().unwrap();
        } else {
            transaction.rollback().unwrap();
        }
        result
    }

    #[test]
    fn verifies_signed_quorum_and_rejects_replayed_maker_and_checker_nonces() {
        let context = make_context();
        let (maker, votes) = evidence(&context, 2);
        let mut connection = Connection::open_in_memory().unwrap();
        let verified = verify(&context, &mut connection, &maker, &votes, &context.binding).unwrap();
        assert_eq!(verified.approved_reviewer_subjects, vec!["alice", "bob"]);
        assert_eq!(verified.approved_trust_domains, vec!["team-a", "team-b"]);
        assert_eq!(
            verify(&context, &mut connection, &maker, &votes, &context.binding)
                .unwrap_err()
                .code(),
            "AGG_APPROVAL_NONCE_REPLAY"
        );
    }

    #[test]
    fn typed_reviewer_attestations_delegate_to_existing_signature_quorum_and_nonce_verifier() {
        let context = make_context();
        let (maker, votes) = evidence(&context, 2);
        let typed_votes = votes
            .iter()
            .map(|vote| {
                let bytes = serde_json::to_vec(vote).unwrap();
                crate::reviewer_attestation::ReviewerAttestationV1::parse_json(&bytes).unwrap()
            })
            .collect::<Vec<_>>();

        let mut raw_connection = Connection::open_in_memory().unwrap();
        let expected = verify(
            &context,
            &mut raw_connection,
            &maker,
            &votes,
            &context.binding,
        )
        .unwrap();

        let mut typed_connection = Connection::open_in_memory().unwrap();
        let transaction = typed_connection.transaction().unwrap();
        let actual = verify_approval_evidence_with_reviewer_attestations(
            &context.configurations,
            &context.ledger,
            TypedApprovalDecisionEvidence {
                policy_envelope: &context.policy_envelope,
                expected_binding: &context.binding,
                maker_attestation: &maker,
                reviewer_attestations: &typed_votes,
            },
            &transaction,
            NOW,
            ApprovalDecisionMode::Consume,
        )
        .unwrap();
        transaction.commit().unwrap();
        assert_eq!(actual, expected);

        let replay_transaction = typed_connection.transaction().unwrap();
        let replay = verify_approval_evidence_with_reviewer_attestations(
            &context.configurations,
            &context.ledger,
            TypedApprovalDecisionEvidence {
                policy_envelope: &context.policy_envelope,
                expected_binding: &context.binding,
                maker_attestation: &maker,
                reviewer_attestations: &typed_votes,
            },
            &replay_transaction,
            NOW,
            ApprovalDecisionMode::Consume,
        );
        assert!(matches!(
            replay,
            Err(ReviewerAttestationVerificationError::Trust(ref error))
                if error.code() == "AGG_APPROVAL_NONCE_REPLAY"
        ));
        replay_transaction.rollback().unwrap();
    }

    #[test]
    fn revalidation_requires_exact_prior_nonce_rows_and_does_not_consume_twice() {
        let context = make_context();
        let (maker, votes) = evidence(&context, 2);
        let mut connection = Connection::open_in_memory().unwrap();
        let first = verify(&context, &mut connection, &maker, &votes, &context.binding).unwrap();
        let replay = verify_mode(
            &context,
            &mut connection,
            &maker,
            &votes,
            &context.binding,
            ApprovalDecisionMode::Revalidate,
        )
        .unwrap();
        assert_eq!(first, replay);

        let changed_binding = json!({"schema_version":1,"wrapper_job_id":"job-other","candidate_hash":"b".repeat(64),"immutable_plan_hash":"c".repeat(64)});
        assert_eq!(
            verify_mode(
                &context,
                &mut connection,
                &maker,
                &votes,
                &changed_binding,
                ApprovalDecisionMode::Revalidate,
            )
            .unwrap_err()
            .code(),
            "AGG_APPROVAL_MAKER_BINDING_MISMATCH"
        );
    }

    #[test]
    fn revalidation_rejects_missing_or_changed_signed_envelope_nonce_record() {
        let context = make_context();
        let (maker, votes) = evidence(&context, 2);
        let mut connection = Connection::open_in_memory().unwrap();
        assert_eq!(
            verify_mode(
                &context,
                &mut connection,
                &maker,
                &votes,
                &context.binding,
                ApprovalDecisionMode::Revalidate,
            )
            .unwrap_err()
            .code(),
            "AGG_APPROVAL_POLICY_NOT_OBSERVED"
        );
        verify(&context, &mut connection, &maker, &votes, &context.binding).unwrap();
        connection
            .execute(
                "UPDATE runalith_approval_decision_nonces_v1 SET signed_envelope_hash=?1 WHERE nonce=?2",
                params!["0".repeat(64), "10000000-0000-4000-8000-000000000001"],
            )
            .unwrap_err();
        let mut changed_maker = maker.clone();
        changed_maker["maker_subject"] = json!("different-maker");
        // A modified signed envelope fails signature verification before the
        // nonce-ledger comparison; the original evidence still revalidates.
        assert!(
            verify_mode(
                &context,
                &mut connection,
                &changed_maker,
                &votes,
                &context.binding,
                ApprovalDecisionMode::Revalidate,
            )
            .is_err()
        );
        assert!(
            verify_mode(
                &context,
                &mut connection,
                &maker,
                &votes,
                &context.binding,
                ApprovalDecisionMode::Revalidate,
            )
            .is_ok()
        );
    }

    #[test]
    fn node_approval_evidence_envelope_is_exact_and_revalidates_without_nonce_reuse() {
        let context = make_context();
        let (maker, votes) = evidence(&context, 2);
        let envelope = json!({
            "schema_version":1,
            "policy":context.policy_envelope,
            "maker_attestation":maker,
            "decisions":votes
        });
        let mut connection = Connection::open_in_memory().unwrap();
        let first = verify_envelope_mode(
            &context,
            &mut connection,
            &envelope,
            &context.binding,
            ApprovalDecisionMode::Consume,
        )
        .unwrap();
        let second = verify_envelope_mode(
            &context,
            &mut connection,
            &envelope,
            &context.binding,
            ApprovalDecisionMode::Revalidate,
        )
        .unwrap();
        assert_eq!(first, second);
        let nonce_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM runalith_approval_decision_nonces_v1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(nonce_count, 3);

        let mut unknown_key = envelope.clone();
        unknown_key["caller_binding"] = context.binding.clone();
        assert_eq!(
            verify_envelope_mode(
                &context,
                &mut connection,
                &unknown_key,
                &context.binding,
                ApprovalDecisionMode::Revalidate,
            )
            .unwrap_err()
            .code(),
            "AGG_APPROVAL_EVIDENCE_SHAPE_INVALID"
        );
        let mut unsupported = envelope;
        unsupported["schema_version"] = json!(2);
        assert_eq!(
            verify_envelope_mode(
                &context,
                &mut connection,
                &unsupported,
                &context.binding,
                ApprovalDecisionMode::Revalidate,
            )
            .unwrap_err()
            .code(),
            "AGG_APPROVAL_EVIDENCE_SCHEMA_UNSUPPORTED"
        );
    }

    #[test]
    fn revalidation_rejects_tampered_signed_envelope_hash_in_persisted_nonce_ledger() {
        let context = make_context();
        let (maker, votes) = evidence(&context, 2);
        let mut connection = Connection::open_in_memory().unwrap();
        verify(&context, &mut connection, &maker, &votes, &context.binding).unwrap();
        connection
            .execute(
                "DROP TRIGGER runalith_approval_decision_nonces_v1_no_update",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE runalith_approval_decision_nonces_v1 SET signed_envelope_hash=?1 WHERE nonce=?2",
                params!["0".repeat(64), "10000000-0000-4000-8000-000000000001"],
            )
            .unwrap();
        assert_eq!(
            verify_mode(
                &context,
                &mut connection,
                &maker,
                &votes,
                &context.binding,
                ApprovalDecisionMode::Revalidate,
            )
            .unwrap_err()
            .code(),
            "AGG_APPROVAL_REPLAY_LEDGER_UNVERIFIABLE"
        );
    }

    #[test]
    fn failed_verification_rolls_back_its_savepoint_and_preserves_caller_transaction() {
        let context = make_context();
        let (valid_maker, votes) = evidence(&context, 2);
        let duplicate_maker = maker_for_subject(
            &context,
            &context.binding,
            "requester",
            "90000000-0000-4000-8000-000000000001",
        );
        let mut connection = Connection::open_in_memory().unwrap();
        let transaction = connection.transaction().unwrap();
        ensure_storage(&transaction).unwrap();
        transaction.execute(
            "INSERT INTO runalith_approval_decision_nonces_v1(nonce,policy_id,policy_version,policy_hash,binding_hash,signed_envelope_hash) VALUES(?1,'policy-test',1,?2,?3,?4)",
            params!["90000000-0000-4000-8000-000000000001", "a".repeat(64), "b".repeat(64), "c".repeat(64)],
        ).unwrap();
        let rejected = verify_approval_evidence(
            &context.configurations,
            &context.ledger,
            ApprovalDecisionEvidence {
                policy_envelope: &context.policy_envelope,
                expected_binding: &context.binding,
                maker_attestation: &duplicate_maker,
                decisions: &votes,
            },
            &transaction,
            NOW,
        );
        assert_eq!(rejected.unwrap_err().code(), "AGG_APPROVAL_NONCE_REPLAY");

        let accepted = verify_approval_evidence(
            &context.configurations,
            &context.ledger,
            ApprovalDecisionEvidence {
                policy_envelope: &context.policy_envelope,
                expected_binding: &context.binding,
                maker_attestation: &valid_maker,
                decisions: &votes,
            },
            &transaction,
            NOW,
        );
        assert!(accepted.is_ok());
        let nonce_count: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM runalith_approval_decision_nonces_v1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(nonce_count, 4);
        transaction.commit().unwrap();
    }

    #[test]
    fn rejects_bad_signature_scope_and_candidate_binding() {
        let context = make_context();
        let (valid_maker, votes) = evidence(&context, 2);
        let mut connection = Connection::open_in_memory().unwrap();
        let mut bad_signature = valid_maker.clone();
        bad_signature["signature"] = json!("A".repeat(88));
        assert_eq!(
            verify(
                &context,
                &mut connection,
                &bad_signature,
                &votes,
                &context.binding
            )
            .unwrap_err()
            .code(),
            "AGG_APPROVAL_SIGNATURE_INVALID"
        );
        let mut bad_scope = valid_maker.clone();
        bad_scope["scope"] = json!(DECISION_SCOPE);
        assert_eq!(
            verify(
                &context,
                &mut connection,
                &bad_scope,
                &votes,
                &context.binding
            )
            .unwrap_err()
            .code(),
            "AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID"
        );
        let changed_binding = json!({"candidate_hash":"d".repeat(64)});
        assert_eq!(
            verify(
                &context,
                &mut connection,
                &valid_maker,
                &votes,
                &changed_binding
            )
            .unwrap_err()
            .code(),
            "AGG_APPROVAL_MAKER_BINDING_MISMATCH"
        );
    }

    #[test]
    fn rejects_insufficient_quorum_and_policy_version_rollback() {
        let context = make_context();
        let (maker, one_vote) = evidence(&context, 1);
        let mut connection = Connection::open_in_memory().unwrap();
        assert_eq!(
            verify(
                &context,
                &mut connection,
                &maker,
                &one_vote,
                &context.binding
            )
            .unwrap_err()
            .code(),
            "AGG_APPROVAL_QUORUM_NOT_MET"
        );
        let (maker_one, votes_one) = evidence(&context, 2);
        verify(
            &context,
            &mut connection,
            &maker_one,
            &votes_one,
            &context.binding,
        )
        .unwrap();

        let version_three = make_context_with(3, 3600);
        let (maker_three, votes_three) = evidence(&version_three, 2);
        assert_eq!(
            verify(
                &version_three,
                &mut connection,
                &maker_three,
                &votes_three,
                &version_three.binding,
            )
            .unwrap_err()
            .code(),
            "AGG_APPROVAL_POLICY_VERSION_GAP"
        );

        let version_two = make_context_with(2, 3600);
        let (maker_two, votes_two) = evidence(&version_two, 2);
        verify(
            &version_two,
            &mut connection,
            &maker_two,
            &votes_two,
            &version_two.binding,
        )
        .unwrap();
        let (rollback_maker, rollback_votes) = evidence(&context, 2);
        assert_eq!(
            verify(
                &context,
                &mut connection,
                &rollback_maker,
                &rollback_votes,
                &context.binding
            )
            .unwrap_err()
            .code(),
            "AGG_APPROVAL_POLICY_ROLLBACK"
        );
    }

    #[test]
    fn policy_history_and_nonce_ledger_reject_update_delete_and_replace() {
        let context = make_context();
        let (maker, votes) = evidence(&context, 2);
        let mut connection = Connection::open_in_memory().unwrap();
        verify(&context, &mut connection, &maker, &votes, &context.binding).unwrap();

        assert!(connection.execute(
            "UPDATE runalith_approval_policy_history_v1 SET policy_hash=?1 WHERE policy_id='policy-test'",
            params!["d".repeat(64)],
        ).is_err());
        assert!(
            connection
                .execute(
                    "DELETE FROM runalith_approval_policy_history_v1 WHERE policy_id='policy-test'",
                    [],
                )
                .is_err()
        );
        assert!(connection.execute(
            "INSERT OR REPLACE INTO runalith_approval_policy_history_v1(policy_id,policy_version,policy_hash) VALUES('policy-test',1,?1)",
            params!["e".repeat(64)],
        ).is_err());

        let nonce: String = connection
            .query_row(
                "SELECT nonce FROM runalith_approval_decision_nonces_v1 LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(connection
            .execute(
                "UPDATE runalith_approval_decision_nonces_v1 SET binding_hash=?1 WHERE nonce=?2",
                params!["f".repeat(64), nonce],
            )
            .is_err());
        assert!(
            connection
                .execute(
                    "DELETE FROM runalith_approval_decision_nonces_v1 WHERE nonce=?1",
                    params![nonce],
                )
                .is_err()
        );
        assert!(connection.execute(
            "INSERT OR REPLACE INTO runalith_approval_decision_nonces_v1(nonce,policy_id,policy_version,policy_hash,binding_hash) VALUES(?1,'policy-test',1,?2,?3)",
            params![nonce, "a".repeat(64), "b".repeat(64)],
        ).is_err());
    }

    #[test]
    fn existing_unsupported_approval_table_schema_fails_closed() {
        let context = make_context();
        let (maker, votes) = evidence(&context, 2);
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE runalith_approval_policy_history_v1(policy_id TEXT PRIMARY KEY)",
            )
            .unwrap();
        assert_eq!(
            verify(&context, &mut connection, &maker, &votes, &context.binding)
                .unwrap_err()
                .code(),
            "AGG_APPROVAL_REPLAY_LEDGER_UNVERIFIABLE"
        );
    }

    #[test]
    fn weakly_tampered_append_only_triggers_fail_behavioral_probes() {
        let context = make_context();
        let (maker, votes) = evidence(&context, 2);

        for (drop_trigger, replacement) in [
            (
                "runalith_approval_policy_history_v1_no_update",
                "CREATE TRIGGER runalith_approval_policy_history_v1_no_update BEFORE UPDATE ON runalith_approval_policy_history_v1 WHEN 0 BEGIN SELECT RAISE(ABORT,'blocked'); END;",
            ),
            (
                "runalith_approval_decision_nonces_v1_no_duplicate",
                "CREATE TRIGGER runalith_approval_decision_nonces_v1_no_duplicate BEFORE INSERT ON runalith_approval_decision_nonces_v1 WHEN EXISTS(SELECT 1 FROM runalith_approval_decision_nonces_v1 WHERE nonce=NEW.nonce) AND 0 BEGIN SELECT RAISE(ABORT,'blocked'); END;",
            ),
            (
                "runalith_approval_policy_history_v1_no_update",
                "CREATE TRIGGER runalith_approval_policy_history_v1_no_update BEFORE UPDATE ON runalith_approval_policy_history_v1 WHEN OLD.policy_id='__trigger_probe__' BEGIN SELECT RAISE(ABORT,'blocked'); END;",
            ),
        ] {
            let mut connection = Connection::open_in_memory().unwrap();
            {
                let transaction = connection.transaction().unwrap();
                ensure_storage(&transaction).unwrap();
                transaction
                    .execute_batch(&format!("DROP TRIGGER {drop_trigger}; {replacement}"))
                    .unwrap();
                transaction.commit().unwrap();
            }
            assert_eq!(
                verify(&context, &mut connection, &maker, &votes, &context.binding)
                    .unwrap_err()
                    .code(),
                "AGG_APPROVAL_REPLAY_LEDGER_UNVERIFIABLE",
                "tampered trigger {drop_trigger} must fail closed",
            );
        }
    }

    #[test]
    fn rejects_reject_veto_maker_checker_overlap_and_stale_vote() {
        let context = make_context();
        let (valid_maker, valid_votes) = evidence(&context, 2);
        let mut connection = Connection::open_in_memory().unwrap();

        let mut reject_vote = valid_votes[0].clone();
        reject_vote.as_object_mut().unwrap().remove("signature");
        reject_vote["decision"] = json!("reject");
        let reject_vote = sign(
            reject_vote,
            &context.keys["reviewer_a"],
            context._directory.path(),
            "reject-vote",
        );
        assert_eq!(
            verify(
                &context,
                &mut connection,
                &valid_maker,
                &[reject_vote, valid_votes[1].clone()],
                &context.binding
            )
            .unwrap_err()
            .code(),
            "AGG_APPROVAL_VETO_REJECTED"
        );

        let maker_overlap = maker_for_subject(
            &context,
            &context.binding,
            "alice",
            "10000000-0000-4000-8000-000000000002",
        );
        assert_eq!(
            verify(
                &context,
                &mut connection,
                &maker_overlap,
                &valid_votes,
                &context.binding
            )
            .unwrap_err()
            .code(),
            "AGG_APPROVAL_MAKER_CHECKER_VIOLATION"
        );

        let mut stale_vote = valid_votes[0].clone();
        stale_vote.as_object_mut().unwrap().remove("signature");
        stale_vote["issued_at"] = json!(timestamp(NOW - 4_000_000));
        let stale_vote = sign(
            stale_vote,
            &context.keys["reviewer_a"],
            context._directory.path(),
            "stale-vote",
        );
        assert_eq!(
            verify(
                &context,
                &mut connection,
                &valid_maker,
                &[stale_vote, valid_votes[1].clone()],
                &context.binding
            )
            .unwrap_err()
            .code(),
            "AGG_APPROVAL_DECISION_BINDING_MISMATCH"
        );
    }

    #[test]
    fn rejects_reuse_of_policy_version_with_a_different_hash() {
        let context = make_context();
        let (maker_one, votes_one) = evidence(&context, 2);
        let mut connection = Connection::open_in_memory().unwrap();
        verify(
            &context,
            &mut connection,
            &maker_one,
            &votes_one,
            &context.binding,
        )
        .unwrap();

        let reused = make_context_with(1, 3500);
        let (maker_reused, votes_reused) = evidence(&reused, 2);
        assert_eq!(
            verify(
                &reused,
                &mut connection,
                &maker_reused,
                &votes_reused,
                &reused.binding
            )
            .unwrap_err()
            .code(),
            "AGG_APPROVAL_POLICY_VERSION_REUSED"
        );
    }

    #[test]
    fn canonical_binding_comparison_rejects_changed_candidate_fields() {
        let expected =
            serde_json::json!({"candidate_hash":"a".repeat(64),"plan_hash":"b".repeat(64)});
        let changed =
            serde_json::json!({"candidate_hash":"c".repeat(64),"plan_hash":"b".repeat(64)});
        assert!(!same_json(Some(&changed), &expected).unwrap());
        assert!(same_json(Some(&expected), &expected).unwrap());
    }
}
