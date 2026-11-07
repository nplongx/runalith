//! Signed reusable execution-approval policy and reviewer registry.
//!
//! This validates policy semantics only. Candidate binding, maker attestation,
//! individual reviewer votes, nonce replay and workflow policy high-water are
//! separate stages.

use std::collections::BTreeSet;

use rusqlite::Transaction;
use serde_json::Value;

use crate::TrustError;
use crate::signed_envelope::{
    VerifiedEnvelope, verify_observed_signed_envelope,
    verify_observed_signed_envelope_in_transaction,
};
use crate::trust_config::TrustConfigurationSet;
use crate::trust_ledger::TrustConfigurationObserver;

/// Signed reviewer registry entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalReviewer {
    /// Authenticated reviewer subject.
    pub subject: String,
    /// Required role assigned by the policy authority.
    pub role: String,
    /// Independent trust-domain identity.
    pub trust_domain: String,
    /// Reviewer signing root fingerprint.
    pub trust_root_sha256: String,
}

/// Verified reusable approval policy.
#[derive(Debug, Clone)]
pub struct VerifiedApprovalPolicy {
    /// Policy identifier.
    pub policy_id: String,
    /// Monotonic policy version.
    pub policy_version: u64,
    /// Minimum approve vote count.
    pub required_approval_count: u64,
    /// Minimum number of distinct reviewer trust domains.
    pub required_distinct_trust_domains: u64,
    /// Every required role must be represented in the approve quorum.
    pub required_roles: Vec<String>,
    /// Maker may not cast a checker vote.
    pub maker_checker_separation: bool,
    /// Any reject vote vetoes approval.
    pub reject_veto: bool,
    /// Maximum age of a reviewer vote in seconds.
    pub max_vote_age_seconds: u64,
    /// Signed reviewer registry.
    pub reviewer_registry: Vec<ApprovalReviewer>,
    /// Signed policy envelope hash.
    pub policy_hash: String,
    /// Policy signature metadata.
    pub envelope: VerifiedEnvelope,
}

/// Verify the signed policy, exact reviewer registry and reachable quorum.
///
/// All five current trust configurations must have been explicitly observed.
pub fn verify_approval_policy(
    configurations: &TrustConfigurationSet,
    ledger: &dyn TrustConfigurationObserver,
    policy: &Value,
    now_ms: i64,
) -> Result<VerifiedApprovalPolicy, TrustError> {
    configurations.assert_observed(ledger)?;
    let policy_config = configurations
        .get("execution_approval_policy")
        .ok_or_else(|| {
            rejected(
                "AGG_TRUST_CONFIG_NOT_CONFIGURED",
                "execution approval policy trust domain is missing",
            )
        })?;
    let envelope = verify_observed_signed_envelope(
        policy_config,
        ledger,
        policy,
        "agg.approval.policy",
        "adaptive_goal_execution_approval_policy",
        now_ms,
    )?;
    verify_approval_policy_with_envelope(configurations, policy, now_ms, envelope)
}

/// D-01 variant: trust high-water, signed policy verification, replay nonce
/// consumption and workflow approval all use the caller's SQLite transaction.
pub fn verify_approval_policy_in_transaction(
    configurations: &TrustConfigurationSet,
    observer: &dyn TrustConfigurationObserver,
    transaction: &Transaction<'_>,
    policy: &Value,
    now_ms: i64,
) -> Result<VerifiedApprovalPolicy, TrustError> {
    configurations.assert_observed_in_transaction(observer, transaction)?;
    let policy_config = configurations
        .get("execution_approval_policy")
        .ok_or_else(|| {
            rejected(
                "AGG_TRUST_CONFIG_NOT_CONFIGURED",
                "execution approval policy trust domain is missing",
            )
        })?;
    let envelope = verify_observed_signed_envelope_in_transaction(
        policy_config,
        observer,
        transaction,
        policy,
        "agg.approval.policy",
        "adaptive_goal_execution_approval_policy",
        now_ms,
    )?;
    verify_approval_policy_with_envelope(configurations, policy, now_ms, envelope)
}

fn verify_approval_policy_with_envelope(
    configurations: &TrustConfigurationSet,
    policy: &Value,
    now_ms: i64,
    envelope: VerifiedEnvelope,
) -> Result<VerifiedApprovalPolicy, TrustError> {
    let decision_config = configurations.get("execution_approval").ok_or_else(|| {
        rejected(
            "AGG_TRUST_CONFIG_NOT_CONFIGURED",
            "execution approval decision trust domain is missing",
        )
    })?;
    let object = policy.as_object().ok_or_else(|| {
        rejected(
            "AGG_APPROVAL_POLICY_RULES_INVALID",
            "signed approval policy must be an object",
        )
    })?;
    exact_keys(
        object,
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
            "required_approval_count",
            "required_distinct_trust_domains",
            "required_roles",
            "maker_checker_separation",
            "reject_veto",
            "max_vote_age_seconds",
            "reviewer_registry",
            "signature_algorithm",
            "signature",
        ],
        "policy",
    )?;
    let policy_id = bounded_string(object.get("policy_id"), "policy.policy_id", 200)?;
    let policy_version = positive_integer(object.get("policy_version"), "policy.policy_version")?;
    let required_approval_count = positive_integer(
        object.get("required_approval_count"),
        "policy.required_approval_count",
    )?;
    let required_distinct_trust_domains = positive_integer(
        object.get("required_distinct_trust_domains"),
        "policy.required_distinct_trust_domains",
    )?;
    let max_vote_age_seconds = positive_integer(
        object.get("max_vote_age_seconds"),
        "policy.max_vote_age_seconds",
    )?;
    if required_approval_count > 32
        || required_distinct_trust_domains > required_approval_count
        || max_vote_age_seconds > 86_400
        || object.get("maker_checker_separation") != Some(&Value::Bool(true))
        || object.get("reject_veto") != Some(&Value::Bool(true))
    {
        return Err(rejected(
            "AGG_APPROVAL_POLICY_RULES_INVALID",
            "policy must define bounded quorum, distinct domains, maker/checker separation, reject veto and vote age",
        ));
    }
    let required_roles = string_array(object.get("required_roles"), "policy.required_roles")?;
    if required_roles.is_empty()
        || required_roles.len() > 16
        || required_roles.iter().any(|role| {
            role.trim().is_empty() || role.trim() != role || role.encode_utf16().count() > 120
        })
        || required_roles.iter().collect::<BTreeSet<_>>().len() != required_roles.len()
    {
        return Err(rejected(
            "AGG_APPROVAL_POLICY_RULES_INVALID",
            "required_roles must contain 1-16 unique trimmed role identifiers",
        ));
    }
    let registry_values = object
        .get("reviewer_registry")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            rejected(
                "AGG_APPROVAL_POLICY_RULES_INVALID",
                "reviewer_registry must be an array",
            )
        })?;
    if registry_values.len() < required_approval_count as usize || registry_values.len() > 64 {
        return Err(rejected(
            "AGG_APPROVAL_POLICY_RULES_INVALID",
            "reviewer_registry size must cover the required quorum and not exceed 64",
        ));
    }
    let mut subjects = BTreeSet::new();
    let mut roots = BTreeSet::new();
    let mut domains = BTreeSet::new();
    let mut registry = Vec::with_capacity(registry_values.len());
    for (index, value) in registry_values.iter().enumerate() {
        let field = format!("policy.reviewer_registry[{index}]");
        let item = value.as_object().ok_or_else(|| {
            rejected(
                "AGG_APPROVAL_POLICY_RULES_INVALID",
                format!("{field} must be an object"),
            )
        })?;
        exact_keys(
            item,
            &["subject", "role", "trust_domain", "trust_root_sha256"],
            &field,
        )?;
        let subject = bounded_string(item.get("subject"), &format!("{field}.subject"), 200)?;
        let role = bounded_string(item.get("role"), &format!("{field}.role"), 120)?;
        let trust_domain = bounded_string(
            item.get("trust_domain"),
            &format!("{field}.trust_domain"),
            120,
        )?;
        let trust_root_sha256 = bounded_string(
            item.get("trust_root_sha256"),
            &format!("{field}.trust_root_sha256"),
            64,
        )?;
        if !is_sha256(&trust_root_sha256) {
            return Err(rejected(
                "AGG_APPROVAL_POLICY_RULES_INVALID",
                format!("{field}.trust_root_sha256 must be lowercase SHA-256"),
            ));
        }
        if !subjects.insert(subject.clone()) {
            return Err(rejected(
                "AGG_APPROVAL_POLICY_REVIEWER_DUPLICATE",
                format!("reviewer subject {subject} is repeated in the signed registry"),
            ));
        }
        if !roots.insert(trust_root_sha256.clone()) {
            return Err(rejected(
                "AGG_APPROVAL_POLICY_ROOT_DUPLICATE",
                format!(
                    "reviewer root {trust_root_sha256} is reused in the signed reviewer registry"
                ),
            ));
        }
        decision_config.find_root(&trust_root_sha256, None, now_ms).map_err(|_| {
            rejected(
                "AGG_APPROVAL_POLICY_REVIEWER_ROOT_UNTRUSTED",
                format!(
                    "reviewer registry root {trust_root_sha256} is not a currently valid host-managed execution-approval trust root"
                ),
            )
        })?;
        domains.insert(trust_domain.clone());
        registry.push(ApprovalReviewer {
            subject,
            role,
            trust_domain,
            trust_root_sha256,
        });
    }
    if domains.len() < required_distinct_trust_domains as usize {
        return Err(rejected(
            "AGG_APPROVAL_POLICY_QUORUM_UNREACHABLE",
            "reviewer registry cannot satisfy its own required distinct trust-domain quorum",
        ));
    }
    if required_roles
        .iter()
        .any(|role| !registry.iter().any(|reviewer| reviewer.role == *role))
    {
        return Err(rejected(
            "AGG_APPROVAL_POLICY_ROLE_QUORUM_UNREACHABLE",
            "reviewer registry cannot satisfy one or more required roles",
        ));
    }
    if envelope.expires_at_ms <= now_ms {
        return Err(rejected(
            "AGG_APPROVAL_POLICY_EXPIRED",
            "signed approval policy expired",
        ));
    }
    Ok(VerifiedApprovalPolicy {
        policy_id,
        policy_version,
        required_approval_count,
        required_distinct_trust_domains,
        required_roles,
        maker_checker_separation: true,
        reject_veto: true,
        max_vote_age_seconds,
        reviewer_registry: registry,
        policy_hash: envelope.signed_envelope_hash.clone(),
        envelope,
    })
}

fn exact_keys(
    object: &serde_json::Map<String, Value>,
    expected: &[&str],
    field: &str,
) -> Result<(), TrustError> {
    if object.len() != expected.len() || object.keys().any(|key| !expected.contains(&key.as_str()))
    {
        return Err(rejected(
            "AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID",
            format!("{field} must contain exactly: {}", expected.join(", ")),
        ));
    }
    Ok(())
}

fn bounded_string(
    value: Option<&Value>,
    field: &str,
    maximum: usize,
) -> Result<String, TrustError> {
    let value = value.and_then(Value::as_str).ok_or_else(|| {
        rejected(
            "AGG_APPROVAL_POLICY_RULES_INVALID",
            format!("{field} must be a string"),
        )
    })?;
    if value.trim().is_empty() || value.encode_utf16().count() > maximum {
        return Err(rejected(
            "AGG_APPROVAL_POLICY_RULES_INVALID",
            format!("{field} must be a bounded non-empty string"),
        ));
    }
    Ok(value.to_owned())
}

fn positive_integer(value: Option<&Value>, field: &str) -> Result<u64, TrustError> {
    let value = value.and_then(Value::as_f64).ok_or_else(|| {
        rejected(
            "AGG_APPROVAL_POLICY_RULES_INVALID",
            format!("{field} must be a positive safe integer"),
        )
    })?;
    if !value.is_finite()
        || value.fract() != 0.0
        || !(1.0..=9_007_199_254_740_991.0).contains(&value)
    {
        return Err(rejected(
            "AGG_APPROVAL_POLICY_RULES_INVALID",
            format!("{field} must be a positive safe integer"),
        ));
    }
    Ok(value as u64)
}

fn string_array(value: Option<&Value>, field: &str) -> Result<Vec<String>, TrustError> {
    value
        .and_then(Value::as_array)
        .ok_or_else(|| {
            rejected(
                "AGG_APPROVAL_POLICY_RULES_INVALID",
                format!("{field} must be an array"),
            )
        })?
        .iter()
        .map(|item| {
            item.as_str().map(str::to_owned).ok_or_else(|| {
                rejected(
                    "AGG_APPROVAL_POLICY_RULES_INVALID",
                    format!("{field} entries must be strings"),
                )
            })
        })
        .collect()
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
    use std::collections::BTreeMap;

    use crate::trust_config::TrustConfigurationSet;
    use crate::trust_ledger::TrustLedger;

    #[test]
    fn node_generated_signed_policy_enforces_registry_quorum_and_trust_domain_roots() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/approval-policy-v1-node.json"
        ))
        .unwrap();
        let mut raw_configs = BTreeMap::new();
        for (domain, config) in fixture["trust_configurations"].as_object().unwrap() {
            raw_configs.insert(domain.clone(), config.as_str().unwrap().as_bytes().to_vec());
        }
        let configurations =
            TrustConfigurationSet::load_json(&raw_configs, 1_793_491_200_000).unwrap();
        let ledger = TrustLedger::in_memory().unwrap();
        configurations
            .record_observations(&ledger, 1_793_491_200_000)
            .unwrap();
        let policy: Value = serde_json::from_str(fixture["policy_json"].as_str().unwrap()).unwrap();
        let verified =
            verify_approval_policy(&configurations, &ledger, &policy, 1_793_491_200_000).unwrap();
        assert_eq!(verified.policy_id, "default-policy");
        assert_eq!(verified.policy_version, 1);
        assert_eq!(verified.required_approval_count, 2);
        assert_eq!(verified.required_distinct_trust_domains, 2);
        assert_eq!(verified.reviewer_registry.len(), 3);
        assert_eq!(
            verified.policy_hash,
            fixture["policy_hash"].as_str().unwrap()
        );
    }

    #[test]
    fn policy_verification_requires_all_five_configs_explicitly_observed() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/approval-policy-v1-node.json"
        ))
        .unwrap();
        let mut raw_configs = BTreeMap::new();
        for (domain, config) in fixture["trust_configurations"].as_object().unwrap() {
            raw_configs.insert(domain.clone(), config.as_str().unwrap().as_bytes().to_vec());
        }
        let configurations =
            TrustConfigurationSet::load_json(&raw_configs, 1_793_491_200_000).unwrap();
        let ledger = TrustLedger::in_memory().unwrap();
        let policy: Value = serde_json::from_str(fixture["policy_json"].as_str().unwrap()).unwrap();
        assert_eq!(
            verify_approval_policy(&configurations, &ledger, &policy, 1_793_491_200_000)
                .unwrap_err()
                .code(),
            "AGG_TRUST_CONFIG_NOT_OBSERVED"
        );
    }
}
