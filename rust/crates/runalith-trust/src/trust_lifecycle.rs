//! Explicit trust-root provisioning and monotonic key lifecycle contracts.
//!
//! The module validates administrator-supplied transitions but does not create
//! credentials, generate production keys, or persist trust roots by itself.
//! Production composition must inject an authenticated administrator verifier
//! and a Governance-owned append-only compare-and-swap backend.

use chrono::DateTime;
use serde_json::Value;
use std::collections::BTreeSet;
use thiserror::Error;

use crate::Ed25519PublicKey;
use crate::trust_config::{TrustConfiguration, valid_key_id};
use rusqlite::Transaction;
use sha2::{Digest, Sha256};

const MAX_JS_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_ADMINISTRATOR_INSTRUCTION_BYTES: usize = 16 * 1024;

/// Verifies the administrator's signed provisioning instruction.
pub trait TrustAdministratorVerifier: Send + Sync {
    /// Authenticate administrator identity, role, change ticket and exact
    /// configuration fingerprint. Test-only credentials must be rejected by
    /// production implementations.
    fn verify_administrator(
        &self,
        configuration: &TrustConfiguration,
        signed_instruction: &Value,
    ) -> Result<(), TrustLifecycleError>;
}

/// Governance-owned append-only trust configuration persistence boundary.
pub trait TrustConfigurationRepository: Send + Sync {
    /// Load current configuration from authoritative Governance persistence.
    fn current(&self, domain: &str) -> Result<Option<TrustConfiguration>, TrustLifecycleError>;
    /// Atomically append exact next version only when current version equals
    /// `expected_previous_version`. Same-version/different-fingerprint writes
    /// must be rejected. This is not a cross-database transaction.
    fn append_if_version(
        &self,
        domain: &str,
        expected_previous_version: Option<u64>,
        configuration: &TrustConfiguration,
        now_ms: i64,
    ) -> Result<(), TrustLifecycleError>;
}

/// Validates and persists an explicitly authorized trust-root transition.
pub struct TrustProvisioningService<V, R> {
    verifier: V,
    repository: R,
}

impl<V, R> TrustProvisioningService<V, R>
where
    V: TrustAdministratorVerifier,
    R: TrustConfigurationRepository,
{
    /// Compose with administrator identity verification and D-01 persistence adapter.
    pub fn new(verifier: V, repository: R) -> Self {
        Self {
            verifier,
            repository,
        }
    }

    /// Apply a new administrator-authorized configuration using optimistic CAS.
    pub fn provision(
        &self,
        next: &TrustConfiguration,
        signed_instruction: &Value,
        now_ms: i64,
    ) -> Result<(), TrustLifecycleError> {
        validate_trust_configuration_snapshot(next, now_ms)?;
        validate_administrator_instruction(signed_instruction)?;
        self.verifier
            .verify_administrator(next, signed_instruction)?;
        let previous = self.repository.current(&next.domain)?;
        validate_transition(previous.as_ref(), next, now_ms)?;
        self.repository.append_if_version(
            &next.domain,
            previous
                .as_ref()
                .map(|configuration| configuration.config_version),
            next,
            now_ms,
        )
    }
}

/// Validate key rotation/revocation as a monotonic, append-only transition.
pub fn validate_transition(
    previous: Option<&TrustConfiguration>,
    next: &TrustConfiguration,
    now_ms: i64,
) -> Result<(), TrustLifecycleError> {
    if let Some(previous) = previous {
        previous
            .validate_integrity()
            .map_err(|_| TrustLifecycleError::InvalidTransition)?;
        for old_root in &previous.roots {
            if !next.roots.iter().any(|root| root.key_id == old_root.key_id) {
                return Err(TrustLifecycleError::RootRemoved);
            }
        }
    }
    validate_trust_configuration_snapshot(next, now_ms)?;
    let Some(previous) = previous else {
        if next.config_version != 1 || next.roots.is_empty() {
            return Err(TrustLifecycleError::VersionNotContiguous);
        }
        return Ok(());
    };
    if next.domain != previous.domain
        || next.scope != previous.scope
        || next.provider_id != previous.provider_id
    {
        return Err(TrustLifecycleError::AuthorityIdentityChanged);
    }
    if next.config_version != previous.config_version.saturating_add(1) {
        return Err(TrustLifecycleError::VersionNotContiguous);
    }
    if next.configuration_fingerprint == previous.configuration_fingerprint {
        return Err(TrustLifecycleError::InvalidTransition);
    }
    let updated_at = parse_canonical_utc_time(&next.config_updated_at)?;
    let previous_updated = parse_canonical_utc_time(&previous.config_updated_at)?;
    if updated_at < previous_updated
        || next.config_change_reference == previous.config_change_reference
    {
        return Err(TrustLifecycleError::InvalidTransition);
    }
    for old_root in &previous.roots {
        let new_root = next
            .roots
            .iter()
            .find(|root| root.key_id == old_root.key_id)
            .ok_or(TrustLifecycleError::RootRemoved)?;
        if new_root.trust_root_sha256 != old_root.trust_root_sha256
            || new_root.scope != old_root.scope
            || new_root.not_before_ms != old_root.not_before_ms
            || (old_root.revoked_at_ms.is_some()
                && new_root.revoked_at_ms != old_root.revoked_at_ms)
            || old_root.not_after_ms.is_some_and(|expiry| {
                new_root
                    .not_after_ms
                    .is_none_or(|next_expiry| next_expiry > expiry)
            })
        {
            return Err(TrustLifecycleError::RootRewritten);
        }
    }
    for new_root in &next.roots {
        if !previous
            .roots
            .iter()
            .any(|old| old.key_id == new_root.key_id)
            && previous
                .roots
                .iter()
                .any(|old| old.trust_root_sha256 == new_root.trust_root_sha256)
        {
            return Err(TrustLifecycleError::RootIdentityReused);
        }
    }
    Ok(())
}

fn validate_trust_configuration_snapshot(
    next: &TrustConfiguration,
    now_ms: i64,
) -> Result<(), TrustLifecycleError> {
    next.validate_integrity()
        .map_err(|_| TrustLifecycleError::InvalidTransition)?;
    let expected_scope = crate::trust_config::TRUST_DOMAIN_SPECS
        .iter()
        .find(|spec| spec.domain == next.domain.as_str())
        .map(|spec| spec.scope);
    if !(0..=MAX_JS_SAFE_INTEGER).contains(&now_ms)
        || expected_scope != Some(next.scope.as_str())
        || !bounded_identity(&next.provider_id, 200)
        || !bounded_identity(&next.config_updated_by, 200)
        || !bounded_identity(&next.config_change_reference, 300)
        || next.configuration_source != "admin_json_environment"
        || !is_sha256(&next.configuration_fingerprint)
        || next.config_version == 0
        || next.config_version > MAX_JS_SAFE_INTEGER as u64
        || next.roots.len() > 32
    {
        return Err(TrustLifecycleError::InvalidTransition);
    }
    let updated_at = parse_canonical_utc_time(&next.config_updated_at)?;
    if updated_at > now_ms.saturating_add(60_000).min(MAX_JS_SAFE_INTEGER) {
        return Err(TrustLifecycleError::InvalidTransition);
    }
    let mut key_ids = BTreeSet::new();
    let mut root_fingerprints = BTreeSet::new();
    for root in &next.roots {
        if root.public_key_pem.len() > 4_096 {
            return Err(TrustLifecycleError::InvalidTransition);
        }
        let not_before = parse_canonical_utc_time(&root.not_before)?;
        let not_after = root
            .not_after
            .as_deref()
            .map(parse_canonical_utc_time)
            .transpose()?;
        let revoked_at = root
            .revoked_at
            .as_deref()
            .map(parse_canonical_utc_time)
            .transpose()?;
        let parsed_key = Ed25519PublicKey::from_pem(&root.public_key_pem)
            .map_err(|_| TrustLifecycleError::InvalidTransition)?;
        let root_usable_now = root.revoked_at_ms.is_none()
            && root.not_before_ms <= now_ms
            && root.not_after_ms.is_none_or(|expiry| now_ms < expiry);
        if !valid_key_id(&root.key_id)
            || !key_ids.insert(root.key_id.as_str())
            || !root_fingerprints.insert(root.trust_root_sha256.as_str())
            || !is_sha256(&root.trust_root_sha256)
            || root.public_key.fingerprint() != root.trust_root_sha256
            || parsed_key.fingerprint() != root.trust_root_sha256
            || hex::encode(Sha256::digest(root.public_key_pem.as_bytes())) != root.legacy_pem_sha256
            || root.scope != next.scope
            || root.not_before_ms != not_before
            || root.not_after_ms != not_after
            || root.revoked_at_ms != revoked_at
            || not_before < 0
            || not_after.is_some_and(|expiry| expiry <= not_before)
            || revoked_at.is_some_and(|revoked| revoked < not_before || revoked > now_ms)
            || root.usable_now != root_usable_now
        {
            return Err(TrustLifecycleError::InvalidTransition);
        }
    }
    if next.available
        != next.roots.iter().any(|root| {
            root.revoked_at_ms.is_none()
                && root.not_before_ms <= now_ms
                && root.not_after_ms.is_none_or(|expiry| now_ms < expiry)
        })
    {
        return Err(TrustLifecycleError::InvalidTransition);
    }
    Ok(())
}

fn validate_administrator_instruction(value: &Value) -> Result<(), TrustLifecycleError> {
    if !value.is_object() || value.as_object().is_some_and(|object| object.is_empty()) {
        return Err(TrustLifecycleError::AdministratorAuthentication);
    }
    let encoded =
        serde_json::to_vec(value).map_err(|_| TrustLifecycleError::AdministratorAuthentication)?;
    if encoded.len() > MAX_ADMINISTRATOR_INSTRUCTION_BYTES {
        return Err(TrustLifecycleError::AdministratorAuthentication);
    }
    Ok(())
}

/// Reviewer authorization state. Revocation is terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewerStatus {
    /// Eligible for the registered policy role.
    Active,
    /// Temporarily excluded; administrator may reactivate.
    Suspended,
    /// Permanently revoked; cannot be reactivated.
    Revoked,
}

/// Registered reviewer identity and immutable Ed25519 key binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewerIdentity {
    /// Authenticated subject identity.
    pub subject: String,
    /// Stable key identity.
    pub key_id: String,
    /// Public-only Ed25519 PEM.
    pub public_key_pem: String,
    /// Canonical SPKI SHA-256 fingerprint.
    pub public_key_sha256: String,
    /// Policy role.
    pub role: String,
    /// Explicit trust domains.
    pub domains: std::collections::BTreeSet<String>,
    /// Monotonic identity version.
    pub version: u64,
    /// Current status.
    pub status: ReviewerStatus,
    /// Registration time, Unix milliseconds.
    pub registered_at_ms: i64,
    /// Expiry time, Unix milliseconds.
    pub expires_at_ms: i64,
    /// Revocation time, Unix milliseconds.
    pub revoked_at_ms: Option<i64>,
    /// Authenticated administrator who changed this version.
    pub changed_by: String,
    /// Immutable change-control reference for this version.
    pub change_reference: String,
}

/// Authenticates signed reviewer-registration and lifecycle instructions.
pub trait ReviewerAdministratorVerifier: Send + Sync {
    /// Verify administrator role and signature over the exact full record.
    fn verify_reviewer_change(
        &self,
        identity: &ReviewerIdentity,
        signed_change: &Value,
    ) -> Result<(), TrustLifecycleError>;
}

/// Governance-owned append-only reviewer registry with compare-and-swap.
pub trait ReviewerIdentityRepository: Send + Sync {
    /// Load current identity from authoritative Governance persistence.
    fn current_reviewer(
        &self,
        subject: &str,
    ) -> Result<Option<ReviewerIdentity>, TrustLifecycleError>;
    /// Read identity through the caller's active workflow transaction. D-01
    /// approval must not acquire the Governance writer connection while holding
    /// the workflow writer lock. Adapters without this capability fail closed.
    fn current_reviewer_in_transaction(
        &self,
        _transaction: &Transaction<'_>,
        _subject: &str,
    ) -> Result<Option<ReviewerIdentity>, TrustLifecycleError> {
        Err(TrustLifecycleError::Persistence(
            "transaction-scoped reviewer identity read is not supported".into(),
        ))
    }
    /// Register only if subject has never existed, including revoked tombstones.
    fn register_reviewer(&self, identity: &ReviewerIdentity) -> Result<(), TrustLifecycleError>;
    /// Append exact next version only if current version equals expected.
    fn transition_reviewer(
        &self,
        expected_version: u64,
        identity: &ReviewerIdentity,
    ) -> Result<(), TrustLifecycleError>;
}

/// Administrator-controlled reviewer identity service.
pub struct ReviewerLifecycleService<V, R> {
    verifier: V,
    repository: R,
}

impl<V: ReviewerAdministratorVerifier, R: ReviewerIdentityRepository>
    ReviewerLifecycleService<V, R>
{
    /// Compose with administrator authenticator and Governance-owned registry.
    pub fn new(verifier: V, repository: R) -> Self {
        Self {
            verifier,
            repository,
        }
    }

    /// Register a reviewer. Self-registration and implicit key trust are denied.
    pub fn register(
        &self,
        identity: &ReviewerIdentity,
        signed_change: &Value,
        now_ms: i64,
    ) -> Result<(), TrustLifecycleError> {
        validate_reviewer_identity(identity, now_ms, true)?;
        validate_administrator_instruction(signed_change)?;
        self.verifier
            .verify_reviewer_change(identity, signed_change)?;
        self.repository.register_reviewer(identity)
    }

    /// Apply suspension, reactivation, expiry shortening, or terminal revocation.
    pub fn transition(
        &self,
        subject: &str,
        next: &ReviewerIdentity,
        signed_change: &Value,
        now_ms: i64,
    ) -> Result<(), TrustLifecycleError> {
        validate_reviewer_identity(next, now_ms, false)?;
        validate_administrator_instruction(signed_change)?;
        self.verifier.verify_reviewer_change(next, signed_change)?;
        let previous = self.repository.current_reviewer(subject)?.ok_or_else(|| {
            TrustLifecycleError::Persistence("reviewer identity not registered".into())
        })?;
        if previous.subject != subject || next.subject != subject {
            return Err(TrustLifecycleError::ReviewerIdentityChanged);
        }
        // Treat persisted state as untrusted until its own identity, key and
        // lifecycle fields have been revalidated. Expired-but-valid historical
        // records remain eligible for suspension/revocation transitions.
        validate_reviewer_identity(&previous, now_ms, false)?;
        validate_reviewer_transition(&previous, next)?;
        self.repository.transition_reviewer(previous.version, next)
    }
}

/// Validate reviewer fields and public-key fingerprint before registration.
pub fn validate_reviewer_identity(
    identity: &ReviewerIdentity,
    now_ms: i64,
    initial: bool,
) -> Result<(), TrustLifecycleError> {
    let allowed_domains = crate::trust_config::TRUST_DOMAIN_SPECS
        .iter()
        .map(|spec| spec.domain)
        .collect::<std::collections::BTreeSet<_>>();
    if !(0..=MAX_JS_SAFE_INTEGER).contains(&now_ms)
        || !bounded_identity(&identity.subject, 256)
        || identity.subject.len() > 256
        || !valid_reviewer_key_id(&identity.key_id)
        || identity.key_id.len() > 256
        || !matches!(identity.role.as_str(), "maker" | "checker" | "auditor")
        || identity.domains.is_empty()
        || identity
            .domains
            .iter()
            .any(|domain| !allowed_domains.contains(domain.as_str()))
        || identity.version == 0
        || identity.registered_at_ms < 0
        || identity.registered_at_ms > MAX_JS_SAFE_INTEGER
        || identity.registered_at_ms > now_ms
        || (initial && identity.expires_at_ms <= now_ms)
        || identity.expires_at_ms > MAX_JS_SAFE_INTEGER
        || identity.expires_at_ms <= identity.registered_at_ms
        || !bounded_identity(&identity.changed_by, 256)
        || identity.changed_by == identity.subject
        || !bounded_identity(&identity.change_reference, 512)
        || !is_sha256(&identity.public_key_sha256)
    {
        return Err(TrustLifecycleError::ReviewerInvalid);
    }
    let key = Ed25519PublicKey::from_pem(&identity.public_key_pem)
        .map_err(|_| TrustLifecycleError::ReviewerInvalid)?;
    if key.fingerprint() != identity.public_key_sha256 {
        return Err(TrustLifecycleError::ReviewerInvalid);
    }
    if initial
        && (identity.version != 1
            || identity.status != ReviewerStatus::Active
            || identity.revoked_at_ms.is_some())
    {
        return Err(TrustLifecycleError::ReviewerInvalid);
    }
    match (identity.status, identity.revoked_at_ms) {
        (ReviewerStatus::Revoked, Some(revoked_at))
            if revoked_at >= identity.registered_at_ms
                && revoked_at <= now_ms
                && revoked_at <= MAX_JS_SAFE_INTEGER => {}
        (ReviewerStatus::Revoked, _) | (_, Some(_)) => {
            return Err(TrustLifecycleError::ReviewerInvalid);
        }
        _ => {}
    }
    Ok(())
}

fn bounded_identity(value: &str, max_bytes: usize) -> bool {
    !value.trim().is_empty()
        && value == value.trim()
        && value.len() <= max_bytes
        && !value.chars().any(char::is_control)
}

fn valid_reviewer_key_id(value: &str) -> bool {
    bounded_identity(value, 256)
}

/// Enforce immutable reviewer identity, monotonic version and terminal revocation.
pub fn validate_reviewer_transition(
    previous: &ReviewerIdentity,
    next: &ReviewerIdentity,
) -> Result<(), TrustLifecycleError> {
    if next.version != previous.version.saturating_add(1)
        || next.subject != previous.subject
        || next.key_id != previous.key_id
        || next.public_key_pem != previous.public_key_pem
        || next.public_key_sha256 != previous.public_key_sha256
        || next.role != previous.role
        || next.domains != previous.domains
        || next.registered_at_ms != previous.registered_at_ms
        || next.expires_at_ms > previous.expires_at_ms
        || next.change_reference == previous.change_reference
        || previous.status == ReviewerStatus::Revoked
    {
        return Err(TrustLifecycleError::ReviewerIdentityChanged);
    }
    if next.status == ReviewerStatus::Revoked && next.revoked_at_ms.is_none() {
        return Err(TrustLifecycleError::ReviewerInvalid);
    }
    if next.status != ReviewerStatus::Revoked && next.revoked_at_ms.is_some() {
        return Err(TrustLifecycleError::ReviewerInvalid);
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn parse_canonical_utc_time(value: &str) -> Result<i64, TrustLifecycleError> {
    let parsed =
        DateTime::parse_from_rfc3339(value).map_err(|_| TrustLifecycleError::InvalidTransition)?;
    if parsed.offset().local_minus_utc() != 0
        || parsed.to_rfc3339_opts(chrono::SecondsFormat::Millis, true) != value
    {
        return Err(TrustLifecycleError::InvalidTransition);
    }
    let timestamp = parsed.timestamp_millis();
    if !(0..=MAX_JS_SAFE_INTEGER).contains(&timestamp) {
        return Err(TrustLifecycleError::InvalidTransition);
    }
    Ok(timestamp)
}

/// Trust provisioning failures. All are fail-closed.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum TrustLifecycleError {
    /// Configuration fields or timestamps are malformed.
    #[error("trust configuration transition is invalid")]
    InvalidTransition,
    /// Configuration version skipped or reused a version.
    #[error("trust configuration version is not contiguous")]
    VersionNotContiguous,
    /// Trust domain/provider/scope identity changed without migration protocol.
    #[error("trust authority identity changed")]
    AuthorityIdentityChanged,
    /// Existing root was removed rather than explicitly revoked and retained.
    #[error("trust root removal is not permitted; retain a revoked tombstone")]
    RootRemoved,
    /// Existing key identity, scope or validity was rewritten.
    #[error("existing trust root identity or validity was rewritten")]
    RootRewritten,
    /// A prior public key fingerprint was reused under a new key ID.
    #[error("trust root fingerprint was reused under a different key ID")]
    RootIdentityReused,
    /// Administrator signature or identity verification failed.
    #[error("trust administrator authentication failed")]
    AdministratorAuthentication,
    /// Trust database compare-and-swap or append-only write failed.
    #[error("trust configuration persistence failed: {0}")]
    Persistence(String),
    /// Reviewer registration fields, key or validity are invalid.
    #[error("reviewer identity is invalid")]
    ReviewerInvalid,
    /// Reviewer subject/key/role/scope changed or revoked identity reopened.
    #[error("reviewer identity transition rewrites immutable or revoked identity")]
    ReviewerIdentityChanged,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    struct AdminVerifier(bool);
    impl TrustAdministratorVerifier for AdminVerifier {
        fn verify_administrator(
            &self,
            _: &TrustConfiguration,
            _: &Value,
        ) -> Result<(), TrustLifecycleError> {
            if self.0 {
                Ok(())
            } else {
                Err(TrustLifecycleError::AdministratorAuthentication)
            }
        }
    }

    struct Repository(Arc<Mutex<Option<TrustConfiguration>>>);
    impl TrustConfigurationRepository for Repository {
        fn current(&self, _: &str) -> Result<Option<TrustConfiguration>, TrustLifecycleError> {
            Ok(self.0.lock().unwrap().clone())
        }

        fn append_if_version(
            &self,
            _: &str,
            expected: Option<u64>,
            next: &TrustConfiguration,
            _: i64,
        ) -> Result<(), TrustLifecycleError> {
            let mut current = self.0.lock().unwrap();
            if current.as_ref().map(|value| value.config_version) != expected {
                return Err(TrustLifecycleError::Persistence(
                    "compare-and-swap conflict".into(),
                ));
            }
            *current = Some(next.clone());
            Ok(())
        }
    }

    struct ReviewerAdminVerifier(bool);
    impl ReviewerAdministratorVerifier for ReviewerAdminVerifier {
        fn verify_reviewer_change(
            &self,
            _: &ReviewerIdentity,
            _: &Value,
        ) -> Result<(), TrustLifecycleError> {
            if self.0 {
                Ok(())
            } else {
                Err(TrustLifecycleError::AdministratorAuthentication)
            }
        }
    }

    struct ReviewerRepository(Arc<Mutex<Option<ReviewerIdentity>>>);
    impl ReviewerIdentityRepository for ReviewerRepository {
        fn current_reviewer(
            &self,
            _: &str,
        ) -> Result<Option<ReviewerIdentity>, TrustLifecycleError> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn register_reviewer(
            &self,
            identity: &ReviewerIdentity,
        ) -> Result<(), TrustLifecycleError> {
            let mut current = self.0.lock().unwrap();
            if current.is_some() {
                return Err(TrustLifecycleError::Persistence(
                    "reviewer already exists".into(),
                ));
            }
            *current = Some(identity.clone());
            Ok(())
        }
        fn transition_reviewer(
            &self,
            expected_version: u64,
            identity: &ReviewerIdentity,
        ) -> Result<(), TrustLifecycleError> {
            let mut current = self.0.lock().unwrap();
            if current.as_ref().map(|value| value.version) != Some(expected_version) {
                return Err(TrustLifecycleError::Persistence(
                    "reviewer CAS conflict".into(),
                ));
            }
            *current = Some(identity.clone());
            Ok(())
        }
    }

    #[test]
    fn provisioning_authenticates_before_append_and_uses_version_cas() {
        let writes = Arc::new(Mutex::new(None));
        let config = fixture(1, "provider", "2026-11-01T09:00:00Z");
        let denied =
            TrustProvisioningService::new(AdminVerifier(false), Repository(writes.clone()));
        assert_eq!(
            denied.provision(
                &config,
                &serde_json::json!({"signature":"test"}),
                1_800_000_000_000
            ),
            Err(TrustLifecycleError::AdministratorAuthentication)
        );
        assert!(writes.lock().unwrap().is_none());

        let allowed =
            TrustProvisioningService::new(AdminVerifier(true), Repository(writes.clone()));
        allowed
            .provision(
                &config,
                &serde_json::json!({"signature":"test"}),
                1_800_000_000_000,
            )
            .unwrap();
        assert_eq!(
            writes
                .lock()
                .unwrap()
                .as_ref()
                .map(|value| value.config_version),
            Some(1)
        );
        let next = fixture(2, "provider", "2026-11-01T09:01:00Z");
        allowed
            .provision(
                &next,
                &serde_json::json!({"signature":"test"}),
                1_800_000_000_000,
            )
            .unwrap();
        assert_eq!(
            writes
                .lock()
                .unwrap()
                .as_ref()
                .map(|value| value.config_version),
            Some(2)
        );

        let oversized_instruction =
            serde_json::json!({"signature":"x".repeat(MAX_ADMINISTRATOR_INSTRUCTION_BYTES)});
        assert_eq!(
            allowed.provision(
                &fixture(3, "provider", "2026-11-01T09:02:00Z"),
                &oversized_instruction,
                1_800_000_000_000,
            ),
            Err(TrustLifecycleError::AdministratorAuthentication)
        );
        assert_eq!(
            writes
                .lock()
                .unwrap()
                .as_ref()
                .map(|value| value.config_version),
            Some(2)
        );
    }

    #[test]
    fn rejects_noncontiguous_version_and_provider_identity_change() {
        let previous = fixture(1, "provider", "2026-11-01T09:00:00Z");
        let mut next = fixture(3, "provider", "2026-11-01T09:01:00Z");
        assert_eq!(
            validate_transition(Some(&previous), &next, 1_800_000_000_000),
            Err(TrustLifecycleError::VersionNotContiguous)
        );
        next.config_version = 2;
        next.provider_id = "different-provider".into();
        next.configuration_fingerprint =
            crate::trust_config::canonical_configuration_fingerprint(&next).unwrap();
        assert_eq!(
            validate_transition(Some(&previous), &next, 1_800_000_000_000),
            Err(TrustLifecycleError::AuthorityIdentityChanged)
        );
    }

    #[test]
    fn trust_transition_rejects_noncanonical_or_cross_domain_identity_fields() {
        let mut next = fixture(1, "provider", "2026-11-01T09:00:00Z");
        next.provider_id = " provider".into();
        assert_eq!(
            validate_transition(None, &next, 1_800_000_000_000),
            Err(TrustLifecycleError::InvalidTransition)
        );

        let mut next = fixture(1, "provider", "2026-11-01T09:00:00Z");
        next.config_updated_by = "admin\nforged".into();
        assert_eq!(
            validate_transition(None, &next, 1_800_000_000_000),
            Err(TrustLifecycleError::InvalidTransition)
        );

        let mut next = fixture(1, "provider", "2026-11-01T09:00:00Z");
        next.scope = "agg.execution.approve".into();
        next.roots[0].scope = next.scope.clone();
        assert_eq!(
            validate_transition(None, &next, 1_800_000_000_000),
            Err(TrustLifecycleError::InvalidTransition)
        );

        let mut next = fixture(1, "provider", "2026-11-01T09:00:00Z");
        next.roots[0].key_id = "Root-A".into();
        assert_eq!(
            validate_transition(None, &next, 1_800_000_000_000),
            Err(TrustLifecycleError::InvalidTransition)
        );

        for invalid_key_id in ["root..a", "root--a", "root_", "root-"] {
            let mut next = fixture(1, "provider", "2026-11-01T09:00:00Z");
            next.roots[0].key_id = invalid_key_id.into();
            assert_eq!(
                validate_transition(None, &next, 1_800_000_000_000),
                Err(TrustLifecycleError::InvalidTransition),
                "trust root key ID {invalid_key_id:?} must be rejected"
            );
        }

        let mut tampered = fixture(1, "provider", "2026-11-01T09:00:00Z");
        tampered.config_updated_by = "different-admin".into();
        assert_eq!(
            validate_transition(None, &tampered, 1_800_000_000_000),
            Err(TrustLifecycleError::InvalidTransition),
            "a well-formed digest must still bind every administrator configuration field"
        );

        let mut tampered_previous = fixture(1, "provider", "2026-11-01T09:00:00Z");
        tampered_previous.roots[0].public_key_pem =
            "-----BEGIN PUBLIC KEY-----\ninvalid\n-----END PUBLIC KEY-----".into();
        let next = fixture(2, "provider", "2026-11-01T09:01:00Z");
        assert_eq!(
            validate_transition(Some(&tampered_previous), &next, 1_800_000_000_000),
            Err(TrustLifecycleError::InvalidTransition),
            "rotation must not trust a tampered persisted predecessor snapshot"
        );

        let mut unsafe_version = fixture(1, "provider", "2026-11-01T09:00:00Z");
        unsafe_version.config_version = MAX_JS_SAFE_INTEGER as u64 + 1;
        assert_eq!(
            validate_transition(None, &unsafe_version, 1_800_000_000_000),
            Err(TrustLifecycleError::InvalidTransition)
        );
    }

    #[test]
    fn lifecycle_recomputes_the_same_canonical_fingerprint_as_the_node_config_loader() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/trust-config-v1-node.json"
        ))
        .unwrap();
        let configuration = crate::trust_config::TrustConfiguration::load_json(
            fixture["input_json"].as_str().unwrap().as_bytes(),
            "goal_idea_verifier",
            "agg.goal_idea_graph.verify",
            1_793_510_400_000,
        )
        .unwrap();
        assert_eq!(
            crate::trust_config::canonical_configuration_fingerprint(&configuration).unwrap(),
            configuration.configuration_fingerprint
        );
        assert!(validate_transition(None, &configuration, 1_793_510_400_000).is_ok());
    }

    #[test]
    fn rejects_noncanonical_configuration_update_timestamps() {
        let previous = fixture(1, "provider", "2026-11-01T09:00:00Z");
        let mut next = fixture(2, "provider", "2026-11-01T09:01:00Z");

        next.config_updated_at = "2026-11-01T09:01:00+00:00".into();
        assert_eq!(
            validate_transition(Some(&previous), &next, 1_800_000_000_000),
            Err(TrustLifecycleError::InvalidTransition)
        );

        next.config_updated_at = "2026-11-01T09:01:00Z".into();
        assert_eq!(
            validate_transition(Some(&previous), &next, 1_800_000_000_000),
            Err(TrustLifecycleError::InvalidTransition)
        );

        let mut malformed_previous = previous;
        malformed_previous.config_updated_at = "2026-11-01T09:00:00Z".into();
        next.config_updated_at = "2026-11-01T09:01:00.000Z".into();
        assert_eq!(
            validate_transition(Some(&malformed_previous), &next, 1_800_000_000_000),
            Err(TrustLifecycleError::InvalidTransition)
        );
    }

    #[test]
    fn rejects_reused_configuration_fingerprint_and_key_expiry_extension() {
        let mut previous = fixture(1, "provider", "2026-11-01T09:00:00Z");
        previous.roots[0].not_after_ms = Some(1_900_000_000_000);
        previous.roots[0].not_after = Some("2030-03-17T17:46:40.000Z".into());
        previous.configuration_fingerprint =
            crate::trust_config::canonical_configuration_fingerprint(&previous).unwrap();
        let mut next = fixture(2, "provider", "2026-11-01T09:01:00Z");
        next.roots[0].not_after_ms = Some(2_000_000_000_000);
        next.roots[0].not_after = Some("2033-05-18T03:33:20.000Z".into());
        next.configuration_fingerprint =
            crate::trust_config::canonical_configuration_fingerprint(&next).unwrap();
        assert_eq!(
            validate_transition(Some(&previous), &next, 1_800_000_000_000),
            Err(TrustLifecycleError::RootRewritten)
        );
        next.roots[0].not_after_ms = previous.roots[0].not_after_ms;
        next.roots[0].not_after = previous.roots[0].not_after.clone();
        next.configuration_fingerprint =
            crate::trust_config::canonical_configuration_fingerprint(&next).unwrap();
        next.configuration_fingerprint = previous.configuration_fingerprint.clone();
        assert_eq!(
            validate_transition(Some(&previous), &next, 1_800_000_000_000),
            Err(TrustLifecycleError::InvalidTransition)
        );
    }

    #[test]
    fn requires_revoked_root_tombstone_and_never_allows_unrevocation() {
        let previous = fixture(1, "provider", "2026-11-01T09:00:00Z");
        let mut removed = fixture(2, "provider", "2026-11-01T09:01:00Z");
        removed.roots.clear();
        removed.available = false;
        removed.configuration_fingerprint =
            crate::trust_config::canonical_configuration_fingerprint(&removed).unwrap();
        assert_eq!(
            validate_transition(Some(&previous), &removed, 1_800_000_000_000),
            Err(TrustLifecycleError::RootRemoved)
        );
        let mut revoked = fixture(2, "provider", "2026-11-01T09:01:00Z");
        revoked.roots[0].revoked_at_ms = Some(1_800_000_000_000);
        revoked.roots[0].revoked_at = Some("2027-01-15T08:00:00.000Z".into());
        revoked.roots[0].usable_now = false;
        revoked.available = false;
        revoked.configuration_fingerprint =
            crate::trust_config::canonical_configuration_fingerprint(&revoked).unwrap();
        assert!(validate_transition(Some(&previous), &revoked, 1_800_000_000_000).is_ok());
        assert_eq!(
            validate_transition(
                Some(&revoked),
                &fixture(3, "provider", "2026-11-01T09:02:00Z"),
                1_800_000_000_000
            ),
            Err(TrustLifecycleError::RootRewritten)
        );
    }

    #[test]
    fn reviewer_identity_requires_admin_and_revocation_is_terminal() {
        let mut identity = reviewer_fixture(1, ReviewerStatus::Active, None);
        identity.changed_by = identity.subject.clone();
        assert_eq!(
            validate_reviewer_identity(&identity, 1_800_000_000_000, true),
            Err(TrustLifecycleError::ReviewerInvalid)
        );
        let revoked = reviewer_fixture(2, ReviewerStatus::Revoked, Some(1_800_000_000_000));
        assert_eq!(
            validate_reviewer_transition(
                &revoked,
                &reviewer_fixture(3, ReviewerStatus::Active, None)
            ),
            Err(TrustLifecycleError::ReviewerIdentityChanged)
        );
        let mut rekeyed = reviewer_fixture(2, ReviewerStatus::Suspended, None);
        rekeyed.public_key_sha256 = "f".repeat(64);
        assert_eq!(
            validate_reviewer_transition(
                &reviewer_fixture(1, ReviewerStatus::Active, None),
                &rekeyed
            ),
            Err(TrustLifecycleError::ReviewerIdentityChanged)
        );
    }

    #[test]
    fn reviewer_identity_rejects_control_characters_and_unbounded_identity_fields() {
        let mut invalid = reviewer_fixture(1, ReviewerStatus::Active, None);
        invalid.subject = "reviewer\u{0085}forged".into();
        assert_eq!(
            validate_reviewer_identity(&invalid, 1_800_000_000_000, true),
            Err(TrustLifecycleError::ReviewerInvalid)
        );

        let mut invalid = reviewer_fixture(1, ReviewerStatus::Active, None);
        invalid.subject = " reviewer-1".into();
        assert_eq!(
            validate_reviewer_identity(&invalid, 1_800_000_000_000, true),
            Err(TrustLifecycleError::ReviewerInvalid)
        );

        let mut invalid = reviewer_fixture(1, ReviewerStatus::Active, None);
        invalid.key_id = "key\nforged".into();
        assert_eq!(
            validate_reviewer_identity(&invalid, 1_800_000_000_000, true),
            Err(TrustLifecycleError::ReviewerInvalid)
        );

        let mut invalid = reviewer_fixture(1, ReviewerStatus::Active, None);
        invalid.changed_by = "admin\0forged".into();
        assert_eq!(
            validate_reviewer_identity(&invalid, 1_800_000_000_000, true),
            Err(TrustLifecycleError::ReviewerInvalid)
        );

        let mut invalid = reviewer_fixture(1, ReviewerStatus::Active, None);
        invalid.change_reference = "r".repeat(513);
        assert_eq!(
            validate_reviewer_identity(&invalid, 1_800_000_000_000, true),
            Err(TrustLifecycleError::ReviewerInvalid)
        );
    }

    #[test]
    fn expired_reviewer_can_be_revoked_without_extending_its_key_validity() {
        let now_ms = 1_900_000_000_000;
        let mut expired = reviewer_fixture(1, ReviewerStatus::Active, None);
        expired.expires_at_ms = now_ms - 1;
        assert!(validate_reviewer_identity(&expired, now_ms, false).is_ok());

        let mut revoked = expired.clone();
        revoked.version = 2;
        revoked.status = ReviewerStatus::Revoked;
        revoked.revoked_at_ms = Some(now_ms);
        revoked.changed_by = "security-admin".into();
        revoked.change_reference = "reviewer-expiry-revocation".into();
        assert!(validate_reviewer_identity(&revoked, now_ms, false).is_ok());
        assert!(validate_reviewer_transition(&expired, &revoked).is_ok());

        let mut extended = revoked.clone();
        extended.version = 3;
        extended.expires_at_ms = now_ms + 60_000;
        assert_eq!(
            validate_reviewer_transition(&revoked, &extended),
            Err(TrustLifecycleError::ReviewerIdentityChanged)
        );
    }

    #[test]
    fn reviewer_service_reads_authoritative_identity_and_authenticates_before_write() {
        let repository = Arc::new(Mutex::new(None));
        let identity = reviewer_fixture(1, ReviewerStatus::Active, None);
        let denied = ReviewerLifecycleService::new(
            ReviewerAdminVerifier(false),
            ReviewerRepository(repository.clone()),
        );
        assert_eq!(
            denied.register(
                &identity,
                &serde_json::json!({"signature":"x"}),
                1_800_000_000_000
            ),
            Err(TrustLifecycleError::AdministratorAuthentication)
        );
        assert!(repository.lock().unwrap().is_none());

        let mut invalid_identity = identity.clone();
        invalid_identity.subject = " reviewer-1".into();
        assert_eq!(
            service_forbidden_register(&repository, &invalid_identity),
            Err(TrustLifecycleError::ReviewerInvalid)
        );

        let service = ReviewerLifecycleService::new(
            ReviewerAdminVerifier(true),
            ReviewerRepository(repository.clone()),
        );
        service
            .register(
                &identity,
                &serde_json::json!({"signature":"x"}),
                1_800_000_000_000,
            )
            .unwrap();
        let mut revoked = reviewer_fixture(2, ReviewerStatus::Revoked, Some(1_800_000_000_000));
        revoked.change_reference = "reviewer-change-2".into();
        service
            .transition(
                "reviewer-1",
                &revoked,
                &serde_json::json!({"signature":"x"}),
                1_800_000_000_000,
            )
            .unwrap();
        assert_eq!(
            repository
                .lock()
                .unwrap()
                .as_ref()
                .map(|value| value.status),
            Some(ReviewerStatus::Revoked)
        );
    }

    fn service_forbidden_register(
        repository: &Arc<Mutex<Option<ReviewerIdentity>>>,
        identity: &ReviewerIdentity,
    ) -> Result<(), TrustLifecycleError> {
        let service = ReviewerLifecycleService::new(
            ReviewerAdminVerifier(false),
            ReviewerRepository(repository.clone()),
        );
        service.register(
            identity,
            &serde_json::json!({"signature":"x"}),
            1_800_000_000_000,
        )
    }

    fn reviewer_fixture(
        version: u64,
        status: ReviewerStatus,
        revoked_at_ms: Option<i64>,
    ) -> ReviewerIdentity {
        let pem = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAPUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=\n-----END PUBLIC KEY-----\n";
        let key = Ed25519PublicKey::from_pem(pem).unwrap();
        ReviewerIdentity {
            subject: "reviewer-1".into(),
            key_id: "reviewer-key-1".into(),
            public_key_pem: pem.into(),
            public_key_sha256: key.fingerprint().into(),
            role: "checker".into(),
            domains: BTreeSet::from(["execution_approval".into()]),
            version,
            status,
            registered_at_ms: 1_767_225_600_000,
            expires_at_ms: 1_900_000_000_000,
            revoked_at_ms,
            changed_by: "security-admin".into(),
            change_reference: format!("reviewer-change-{version}"),
        }
    }

    fn fixture(version: u64, provider: &str, updated: &str) -> TrustConfiguration {
        use crate::Ed25519PublicKey;
        use crate::trust_config::TrustedRoot;
        let pem = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAPUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=\n-----END PUBLIC KEY-----\n";
        let public_key = Ed25519PublicKey::from_pem(pem).unwrap();
        let fingerprint = public_key.fingerprint().to_owned();
        let config_updated_at = if updated.ends_with('Z') && !updated.contains('.') {
            format!("{}.000Z", updated.trim_end_matches('Z'))
        } else {
            updated.to_owned()
        };
        let mut configuration = TrustConfiguration {
            domain: "action_intent_maker".into(),
            provider_id: provider.into(),
            scope: "agg.action_intent.propose".into(),
            config_version: version,
            config_updated_at,
            config_updated_by: "admin".into(),
            config_change_reference: format!("change-{version}"),
            configuration_fingerprint: String::new(),
            configuration_source: "admin_json_environment",
            available: true,
            roots: vec![TrustedRoot {
                key_id: "root-a".into(),
                public_key,
                public_key_pem: pem.into(),
                trust_root_sha256: fingerprint,
                legacy_pem_sha256: hex::encode(Sha256::digest(pem.as_bytes())),
                scope: "agg.action_intent.propose".into(),
                not_before_ms: 1_767_225_600_000,
                not_after_ms: None,
                revoked_at_ms: None,
                not_before: "2026-01-01T00:00:00.000Z".into(),
                not_after: None,
                revoked_at: None,
                usable_now: true,
            }],
        };
        configuration.configuration_fingerprint =
            crate::trust_config::canonical_configuration_fingerprint(&configuration).unwrap();
        configuration
    }
}
