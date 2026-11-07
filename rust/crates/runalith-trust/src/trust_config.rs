//! Administrator-managed, versioned Ed25519 trust configuration.
//!
//! Approval trust uses exactly five independent domains. This module accepts
//! JSON configuration only; the legacy single-key environment path remains
//! intentionally unsupported for approval authority.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, SecondsFormat};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::trust_ledger::{TrustConfigurationObserver, TrustLedger, TrustObservationResult};
use crate::{Ed25519PublicKey, TrustError};

/// Trust domain identifier and its one permitted signing scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrustDomainSpec {
    /// Stable domain identifier.
    pub domain: &'static str,
    /// Exact scope permitted for every key in the domain.
    pub scope: &'static str,
}

/// All independently administered trust domains required by approval.
pub const TRUST_DOMAIN_SPECS: [TrustDomainSpec; 5] = [
    TrustDomainSpec {
        domain: "goal_idea_verifier",
        scope: "agg.goal_idea_graph.verify",
    },
    TrustDomainSpec {
        domain: "action_intent_reviewer",
        scope: "agg.action_intent.review",
    },
    TrustDomainSpec {
        domain: "execution_approval_policy",
        scope: "agg.approval.policy",
    },
    TrustDomainSpec {
        domain: "action_intent_maker",
        scope: "agg.action_intent.propose",
    },
    TrustDomainSpec {
        domain: "execution_approval",
        scope: "agg.execution.approve",
    },
];

/// Trust configuration schema version.
pub const TRUST_CONFIG_SCHEMA_VERSION: u64 = 1;
/// Maximum raw administrator trust configuration size.
pub const MAX_TRUST_CONFIG_BYTES: usize = 128 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// One administrator-configured Ed25519 root.
#[derive(Debug, Clone)]
pub struct TrustedRoot {
    /// Unique key ID within this trust domain.
    pub key_id: String,
    /// Parsed Ed25519 key.
    pub public_key: Ed25519PublicKey,
    /// Original public-only PEM.
    pub public_key_pem: String,
    /// SHA-256 over canonical SubjectPublicKeyInfo DER.
    pub trust_root_sha256: String,
    /// SHA-256 over original PEM bytes, retained for migration diagnostics.
    pub legacy_pem_sha256: String,
    /// The one exact authorized scope.
    pub scope: String,
    /// Inclusive key validity start, Unix milliseconds.
    pub not_before_ms: i64,
    /// Exclusive key validity end, Unix milliseconds; null means unbounded.
    pub not_after_ms: Option<i64>,
    /// Revocation timestamp, if revoked. Any non-null value disables the key.
    pub revoked_at_ms: Option<i64>,
    /// Canonical timestamp text retained for ledger manifests.
    pub not_before: String,
    /// Canonical timestamp text retained for ledger manifests.
    pub not_after: Option<String>,
    /// Canonical timestamp text retained for ledger manifests.
    pub revoked_at: Option<String>,
    /// Whether this root is usable at configuration load time.
    pub usable_now: bool,
}

/// Validated, administrator-managed trust configuration for one domain.
#[derive(Debug, Clone)]
pub struct TrustConfiguration {
    /// Exact trust domain.
    pub domain: String,
    /// Independently administered provider ID.
    pub provider_id: String,
    /// Exact signing scope.
    pub scope: String,
    /// Positive monotonic configuration version.
    pub config_version: u64,
    /// Canonical administration update timestamp.
    pub config_updated_at: String,
    /// Administrator identity that changed the config.
    pub config_updated_by: String,
    /// Change-control reference.
    pub config_change_reference: String,
    /// SHA-256 of canonical JSON for the complete config.
    pub configuration_fingerprint: String,
    /// Config source. Approval trust accepts administrator JSON only.
    pub configuration_source: &'static str,
    /// Configured roots, including revoked and not-yet-valid roots.
    pub roots: Vec<TrustedRoot>,
    /// True when at least one root is currently usable.
    pub available: bool,
}

impl TrustConfiguration {
    /// Parse and validate one raw administrator JSON trust configuration.
    pub fn load_json(
        bytes: &[u8],
        expected_domain: &str,
        expected_scope: &str,
        now_ms: i64,
    ) -> Result<Self, TrustError> {
        if bytes.len() > MAX_TRUST_CONFIG_BYTES {
            return Err(rejected(
                "AGG_TRUST_CONFIG_SCHEMA_INVALID",
                "trust configuration exceeds the 128 KiB limit",
            ));
        }
        if now_ms < 0 || now_ms as u64 > MAX_SAFE_INTEGER {
            return Err(rejected(
                "AGG_TRUST_CONFIG_CLOCK_INVALID",
                "trust configuration time must be a non-negative safe integer",
            ));
        }
        let parsed = runalith_protocol::agg_checkpoint_v2::parse_json(bytes).map_err(|error| {
            rejected(
                "AGG_TRUST_CONFIG_SCHEMA_INVALID",
                format!("strict trust configuration JSON rejected: {error}"),
            )
        })?;
        let root = object(&parsed, "trust configuration")?;
        exact_keys(
            root,
            &[
                "schema_version",
                "domain",
                "provider_id",
                "config_version",
                "updated_at",
                "updated_by",
                "change_reference",
                "keys",
            ],
            "trust configuration",
        )?;
        if number(root.get("schema_version"), "schema_version")? != 1.0 {
            return Err(rejected(
                "AGG_TRUST_CONFIG_VERSION_INVALID",
                "schema_version must equal 1",
            ));
        }
        let config_version = safe_positive_integer(root.get("config_version"), "config_version")?;
        let domain = string(root.get("domain"), "domain")?;
        let provider_id = bounded_nonempty_string(root.get("provider_id"), "provider_id", 200)?;
        let config_updated_by = bounded_nonempty_string(root.get("updated_by"), "updated_by", 200)?;
        let config_change_reference =
            bounded_nonempty_string(root.get("change_reference"), "change_reference", 300)?;
        if domain != expected_domain {
            return Err(rejected(
                "AGG_TRUST_CONFIG_SCHEMA_INVALID",
                format!("trust domain {domain} does not match expected domain {expected_domain}"),
            ));
        }
        let config_updated_at = string(root.get("updated_at"), "updated_at")?;
        let config_updated_at_ms = canonical_timestamp(&config_updated_at, "updated_at")?;
        if config_updated_at_ms > now_ms.saturating_add(60_000) {
            return Err(rejected(
                "AGG_TRUST_CONFIG_FUTURE_DATED",
                "updated_at is more than one minute in the future",
            ));
        }
        let key_values = array(root.get("keys"), "keys")?;
        if key_values.is_empty() || key_values.len() > 32 {
            return Err(rejected(
                "AGG_TRUST_CONFIG_SCHEMA_INVALID",
                "keys must contain 1-32 entries",
            ));
        }
        let mut key_ids = BTreeSet::new();
        let mut fingerprints = BTreeSet::new();
        let mut roots = Vec::with_capacity(key_values.len());
        for (index, value) in key_values.iter().enumerate() {
            let field = format!("keys[{index}]");
            let entry = object(value, &field)?;
            exact_keys(
                entry,
                &[
                    "key_id",
                    "public_key_pem",
                    "scopes",
                    "not_before",
                    "not_after",
                    "revoked_at",
                ],
                &field,
            )?;
            let key_id = string(entry.get("key_id"), &format!("{field}.key_id"))?;
            if !valid_key_id(&key_id) || !key_ids.insert(key_id.clone()) {
                return Err(rejected(
                    "AGG_TRUST_CONFIG_KEY_ID_INVALID",
                    format!(
                        "{field}.key_id must be unique, lowercase, and use single non-terminal separators"
                    ),
                ));
            }
            let public_key_pem = string(
                entry.get("public_key_pem"),
                &format!("{field}.public_key_pem"),
            )?;
            if !public_key_pem.contains("BEGIN PUBLIC KEY") {
                return Err(rejected(
                    "AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID",
                    format!("{field} must contain an Ed25519 PUBLIC KEY PEM"),
                ));
            }
            let public_key = Ed25519PublicKey::from_pem(&public_key_pem)?;
            let trust_root_sha256 = public_key.fingerprint().to_owned();
            if !fingerprints.insert(trust_root_sha256.clone()) {
                return Err(rejected(
                    "AGG_TRUST_CONFIG_DUPLICATE_ROOT",
                    format!("{field} repeats a configured public-root fingerprint"),
                ));
            }
            let scopes = array(entry.get("scopes"), &format!("{field}.scopes"))?;
            if scopes.len() != 1 || scopes[0].as_str() != Some(expected_scope) {
                return Err(rejected(
                    "AGG_TRUST_CONFIG_SCOPE_INVALID",
                    format!(
                        "{field} must authorize only exact scope {expected_scope} for domain {expected_domain}"
                    ),
                ));
            }
            let not_before = string(entry.get("not_before"), &format!("{field}.not_before"))?;
            let not_before_ms = canonical_timestamp(&not_before, &format!("{field}.not_before"))?;
            let not_after =
                nullable_timestamp_text(entry.get("not_after"), &format!("{field}.not_after"))?;
            let not_after_ms = not_after
                .as_deref()
                .map(|value| canonical_timestamp(value, &format!("{field}.not_after")))
                .transpose()?;
            let revoked_at =
                nullable_timestamp_text(entry.get("revoked_at"), &format!("{field}.revoked_at"))?;
            let revoked_at_ms = revoked_at
                .as_deref()
                .map(|value| canonical_timestamp(value, &format!("{field}.revoked_at")))
                .transpose()?;
            if not_after_ms.is_some_and(|not_after| not_after <= not_before_ms) {
                return Err(rejected(
                    "AGG_TRUST_CONFIG_KEY_WINDOW_INVALID",
                    format!("{field}.not_after must be later than not_before"),
                ));
            }
            let usable_now = revoked_at_ms.is_none()
                && not_before_ms <= now_ms
                && not_after_ms.is_none_or(|not_after| now_ms < not_after);
            roots.push(TrustedRoot {
                key_id,
                legacy_pem_sha256: hex::encode(Sha256::digest(public_key_pem.as_bytes())),
                public_key,
                public_key_pem,
                trust_root_sha256,
                scope: expected_scope.to_owned(),
                not_before_ms,
                not_after_ms,
                revoked_at_ms,
                not_before,
                not_after,
                revoked_at,
                usable_now,
            });
        }
        let canonical =
            runalith_protocol::agg_checkpoint_v2::canonicalize(&parsed).map_err(|error| {
                rejected(
                    "AGG_TRUST_CONFIG_SCHEMA_INVALID",
                    format!("trust configuration cannot be canonicalized: {error}"),
                )
            })?;
        let configuration_fingerprint = hex::encode(Sha256::digest(canonical.as_bytes()));
        let available = roots.iter().any(|root| root.usable_now);
        Ok(Self {
            domain,
            provider_id,
            scope: expected_scope.to_owned(),
            config_version,
            config_updated_at,
            config_updated_by,
            config_change_reference,
            configuration_fingerprint,
            configuration_source: "admin_json_environment",
            roots,
            available,
        })
    }

    /// Revalidate a public configuration value after construction. This is
    /// required at persistence/verification boundaries because public fields
    /// can be populated without passing through `load_json`.
    pub fn validate_integrity(&self) -> Result<(), TrustError> {
        let expected_scope = TRUST_DOMAIN_SPECS
            .iter()
            .find(|spec| spec.domain == self.domain)
            .map(|spec| spec.scope);
        if expected_scope != Some(self.scope.as_str())
            || self.provider_id.trim().is_empty()
            || self.provider_id != self.provider_id.trim()
            || self.provider_id.encode_utf16().count() > 200
            || self.provider_id.chars().any(char::is_control)
            || self.config_version == 0
            || self.config_version > MAX_SAFE_INTEGER
            || self.configuration_source != "admin_json_environment"
            || self.config_updated_by.trim().is_empty()
            || self.config_updated_by != self.config_updated_by.trim()
            || self.config_updated_by.encode_utf16().count() > 200
            || self.config_updated_by.chars().any(char::is_control)
            || self.config_change_reference.trim().is_empty()
            || self.config_change_reference != self.config_change_reference.trim()
            || self.config_change_reference.encode_utf16().count() > 300
            || self.config_change_reference.chars().any(char::is_control)
            || self.roots.is_empty()
            || self.roots.len() > 32
            || !is_sha256(&self.configuration_fingerprint)
        {
            return Err(rejected(
                "AGG_TRUST_CONFIG_SCHEMA_INVALID",
                "trust configuration object contains invalid or noncanonical fields",
            ));
        }
        let updated_at = canonical_timestamp(&self.config_updated_at, "updated_at")?;
        if !(0..=MAX_SAFE_INTEGER as i64).contains(&updated_at) {
            return Err(rejected(
                "AGG_TRUST_CONFIG_SCHEMA_INVALID",
                "updated_at exceeds the supported safe-integer timestamp range",
            ));
        }

        let mut key_ids = BTreeSet::new();
        let mut fingerprints = BTreeSet::new();
        for (index, root) in self.roots.iter().enumerate() {
            let field = format!("keys[{index}]");
            if !valid_key_id(&root.key_id)
                || !key_ids.insert(root.key_id.as_str())
                || !is_sha256(&root.trust_root_sha256)
                || !fingerprints.insert(root.trust_root_sha256.as_str())
                || root.public_key_pem.len() > 4_096
                || root.scope != self.scope
                || (root.usable_now && root.revoked_at_ms.is_some())
            {
                return Err(rejected(
                    "AGG_TRUST_CONFIG_SCHEMA_INVALID",
                    format!("{field} contains a noncanonical key identity or scope"),
                ));
            }
            let parsed_key = Ed25519PublicKey::from_pem(&root.public_key_pem)?;
            if parsed_key.fingerprint() != root.trust_root_sha256
                || root.public_key.fingerprint() != root.trust_root_sha256
                || hex::encode(Sha256::digest(root.public_key_pem.as_bytes()))
                    != root.legacy_pem_sha256
            {
                return Err(rejected(
                    "AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID",
                    format!("{field} PEM, parsed key and SPKI fingerprint do not agree"),
                ));
            }
            let not_before = canonical_timestamp(&root.not_before, &format!("{field}.not_before"))?;
            let not_after = root
                .not_after
                .as_deref()
                .map(|value| canonical_timestamp(value, &format!("{field}.not_after")))
                .transpose()?;
            let revoked_at = root
                .revoked_at
                .as_deref()
                .map(|value| canonical_timestamp(value, &format!("{field}.revoked_at")))
                .transpose()?;
            if not_before != root.not_before_ms
                || not_after != root.not_after_ms
                || revoked_at != root.revoked_at_ms
                || not_before < 0
                || not_before > MAX_SAFE_INTEGER as i64
                || not_after.is_some_and(|expiry| expiry <= not_before)
                || not_after.is_some_and(|expiry| expiry > MAX_SAFE_INTEGER as i64)
                || revoked_at.is_some_and(|revoked| revoked < not_before)
                || revoked_at.is_some_and(|revoked| revoked > MAX_SAFE_INTEGER as i64)
            {
                return Err(rejected(
                    "AGG_TRUST_CONFIG_SCHEMA_INVALID",
                    format!("{field} validity/revocation timestamps are inconsistent"),
                ));
            }
        }
        if self.available != self.roots.iter().any(|root| root.usable_now) {
            return Err(rejected(
                "AGG_TRUST_CONFIG_SCHEMA_INVALID",
                "trust configuration availability does not match its root snapshot",
            ));
        }
        if canonical_configuration_fingerprint(self)? != self.configuration_fingerprint {
            return Err(rejected(
                "AGG_TRUST_CONFIG_FINGERPRINT_MISMATCH",
                "configuration fingerprint does not commit to the exact canonical administrator configuration",
            ));
        }
        Ok(())
    }

    /// Find and validate a current signing root by canonical SPKI fingerprint.
    pub fn find_root(
        &self,
        fingerprint: &str,
        issued_at_ms: Option<i64>,
        now_ms: i64,
    ) -> Result<&TrustedRoot, TrustError> {
        self.validate_integrity()?;
        if !is_sha256(fingerprint) {
            return Err(rejected(
                "AGG_TRUST_ROOT_FINGERPRINT_INVALID",
                "signed trust_root_sha256 is malformed",
            ));
        }
        let root = self
            .roots
            .iter()
            .find(|root| root.trust_root_sha256 == fingerprint)
            .ok_or_else(|| {
                rejected(
                    "AGG_TRUST_ROOT_UNTRUSTED",
                    "signature uses a public root absent from current administrator trust configuration",
                )
            })?;
        if root.revoked_at_ms.is_some() {
            return Err(rejected(
                "AGG_TRUST_ROOT_REVOKED",
                format!("trusted key {} is revoked", root.key_id),
            ));
        }
        if root.not_before_ms > now_ms || root.not_after_ms.is_some_and(|end| now_ms >= end) {
            return Err(rejected(
                "AGG_TRUST_ROOT_OUTSIDE_VALIDITY",
                format!("trusted key {} is outside its validity window", root.key_id),
            ));
        }
        if let Some(issued_at_ms) = issued_at_ms {
            if issued_at_ms < root.not_before_ms
                || root.not_after_ms.is_some_and(|end| issued_at_ms >= end)
            {
                return Err(rejected(
                    "AGG_TRUST_ROOT_ISSUED_OUTSIDE_VALIDITY",
                    format!(
                        "attestation was issued outside key {} validity window",
                        root.key_id
                    ),
                ));
            }
        }
        if root.scope != self.scope {
            return Err(rejected(
                "AGG_TRUST_CONFIG_SCOPE_INVALID",
                format!(
                    "trusted key {} is not scoped to {}",
                    root.key_id, self.scope
                ),
            ));
        }
        Ok(root)
    }
}

/// Compute the canonical schema-v1 administrator fingerprint from the typed
/// value. Callers may use this while constructing a new configuration; trust
/// boundaries must follow it with `TrustConfiguration::validate_integrity`.
pub(crate) fn canonical_configuration_fingerprint(
    configuration: &TrustConfiguration,
) -> Result<String, TrustError> {
    let value = serde_json::json!({
        "schema_version": TRUST_CONFIG_SCHEMA_VERSION,
        "domain": configuration.domain,
        "provider_id": configuration.provider_id,
        "config_version": configuration.config_version,
        "updated_at": configuration.config_updated_at,
        "updated_by": configuration.config_updated_by,
        "change_reference": configuration.config_change_reference,
        "keys": configuration.roots.iter().map(|root| serde_json::json!({
            "key_id": root.key_id,
            "public_key_pem": root.public_key_pem,
            "scopes": [root.scope],
            "not_before": root.not_before,
            "not_after": root.not_after,
            "revoked_at": root.revoked_at,
        })).collect::<Vec<_>>(),
    });
    let canonical =
        runalith_protocol::agg_checkpoint_v2::canonicalize(&value).map_err(|error| {
            rejected(
                "AGG_TRUST_CONFIG_SCHEMA_INVALID",
                format!("trust configuration cannot be canonicalized: {error}"),
            )
        })?;
    Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
}

/// The complete five-domain administrator trust configuration set.
#[derive(Debug, Clone)]
pub struct TrustConfigurationSet {
    /// Domain configurations keyed by their exact domain identifiers.
    pub domains: BTreeMap<String, TrustConfiguration>,
}

impl TrustConfigurationSet {
    /// Load all five domains from raw JSON keyed by domain ID. Legacy single-key
    /// environment configuration is deliberately not accepted for approval.
    pub fn load_json(
        configurations: &BTreeMap<String, Vec<u8>>,
        now_ms: i64,
    ) -> Result<Self, TrustError> {
        let mut domains = BTreeMap::new();
        for spec in TRUST_DOMAIN_SPECS {
            let bytes = configurations.get(spec.domain).ok_or_else(|| {
                rejected(
                    "AGG_TRUST_CONFIG_NOT_CONFIGURED",
                    format!(
                        "trust domain {} has no administrator JSON configuration",
                        spec.domain
                    ),
                )
            })?;
            let configuration =
                TrustConfiguration::load_json(bytes, spec.domain, spec.scope, now_ms)?;
            if configuration.configuration_source != "admin_json_environment"
                || configuration.config_version == 0
            {
                return Err(rejected(
                    "PRODUCTION_AGG_TRUST_JSON_CONFIGURATION_REQUIRED",
                    format!(
                        "trust domain {} requires versioned administrator-managed JSON configuration",
                        spec.domain
                    ),
                ));
            }
            if !configuration.available {
                return Err(rejected(
                    "PRODUCTION_AGG_TRUST_ROOT_NOT_CURRENT",
                    format!(
                        "trust domain {} has no currently usable non-revoked root",
                        spec.domain
                    ),
                ));
            }
            domains.insert(spec.domain.to_owned(), configuration);
        }
        if configurations.len() != TRUST_DOMAIN_SPECS.len() {
            return Err(rejected(
                "AGG_TRUST_DOMAIN_SET_INCOMPLETE",
                "trust configuration set contains unsupported or duplicate domains",
            ));
        }
        let set = Self { domains };
        set.assert_disjoint()?;
        Ok(set)
    }

    /// Return one exact domain configuration.
    pub fn get(&self, domain: &str) -> Option<&TrustConfiguration> {
        self.domains.get(domain)
    }

    /// Read-only assertion that every configured domain was explicitly
    /// observed at its exact version/fingerprint/provider.
    pub fn assert_observed(
        &self,
        ledger: &dyn TrustConfigurationObserver,
    ) -> Result<(), TrustError> {
        self.assert_disjoint()?;
        for configuration in self.domains.values() {
            ledger.assert_observed(configuration)?;
        }
        Ok(())
    }

    /// Assert all five exact trust configurations against the caller's
    /// workflow transaction. This is the D-01 approval/dispatch path.
    pub fn assert_observed_in_transaction(
        &self,
        observer: &dyn TrustConfigurationObserver,
        transaction: &rusqlite::Transaction<'_>,
    ) -> Result<(), TrustError> {
        self.assert_disjoint()?;
        for configuration in self.domains.values() {
            observer.assert_observed_in_transaction(transaction, configuration)?;
        }
        Ok(())
    }

    /// Explicit administrator-only operation to append observations for all
    /// five domains. Never call automatically during approval or dispatch.
    pub fn record_observations(
        &self,
        ledger: &TrustLedger,
        now_ms: i64,
    ) -> Result<Vec<TrustObservationResult>, TrustError> {
        self.assert_disjoint()?;
        self.domains
            .values()
            .map(|configuration| ledger.record(configuration, now_ms))
            .collect()
    }

    /// Enforce provider-ID and canonical SPKI disjointness across all five domains.
    pub fn assert_disjoint(&self) -> Result<(), TrustError> {
        if self.domains.len() != TRUST_DOMAIN_SPECS.len()
            || TRUST_DOMAIN_SPECS
                .iter()
                .any(|spec| !self.domains.contains_key(spec.domain))
        {
            return Err(rejected(
                "AGG_TRUST_DOMAIN_SET_INCOMPLETE",
                "all five independent trust domains are required exactly once",
            ));
        }
        let mut providers = BTreeMap::new();
        let mut roots = BTreeMap::new();
        for configuration in self.domains.values() {
            configuration.validate_integrity()?;
            if configuration.provider_id.trim().is_empty() || configuration.roots.is_empty() {
                return Err(rejected(
                    "AGG_TRUST_DOMAIN_UNVERIFIABLE",
                    format!(
                        "trust domain {} has no verifiable provider or roots",
                        configuration.domain
                    ),
                ));
            }
            if let Some(prior) = providers.insert(
                configuration.provider_id.as_str(),
                configuration.domain.as_str(),
            ) {
                return Err(rejected(
                    "AGG_TRUST_DOMAINS_PROVIDER_COLLISION",
                    format!(
                        "provider ID is shared by {prior} and {}",
                        configuration.domain
                    ),
                ));
            }
            for root in &configuration.roots {
                if !is_sha256(&root.trust_root_sha256) {
                    return Err(rejected(
                        "AGG_TRUST_DOMAIN_UNVERIFIABLE",
                        format!(
                            "trust domain {} has an invalid canonical SPKI fingerprint",
                            configuration.domain
                        ),
                    ));
                }
                if let Some(prior) = roots.insert(
                    root.trust_root_sha256.as_str(),
                    configuration.domain.as_str(),
                ) {
                    return Err(rejected(
                        "AGG_TRUST_DOMAINS_ROOT_COLLISION",
                        format!(
                            "canonical SPKI root is shared by {prior} and {}",
                            configuration.domain
                        ),
                    ));
                }
            }
        }
        Ok(())
    }
}

pub(crate) fn canonical_timestamp(value: &str, field: &str) -> Result<i64, TrustError> {
    let parsed = DateTime::parse_from_rfc3339(value).map_err(|_| {
        rejected(
            "AGG_TRUST_CONFIG_SCHEMA_INVALID",
            format!("{field} must be a canonical UTC ISO-8601 timestamp"),
        )
    })?;
    let canonical = parsed.to_rfc3339_opts(SecondsFormat::Millis, true);
    if canonical != value || parsed.offset().local_minus_utc() != 0 {
        return Err(rejected(
            "AGG_TRUST_CONFIG_SCHEMA_INVALID",
            format!("{field} must be a canonical UTC ISO-8601 timestamp"),
        ));
    }
    Ok(parsed.timestamp_millis())
}

fn nullable_timestamp_text(
    value: Option<&Value>,
    field: &str,
) -> Result<Option<String>, TrustError> {
    match value {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(rejected(
            "AGG_TRUST_CONFIG_SCHEMA_INVALID",
            format!("{field} must be a canonical UTC ISO-8601 timestamp or null"),
        )),
    }
}

fn safe_positive_integer(value: Option<&Value>, field: &str) -> Result<u64, TrustError> {
    let number = value.and_then(Value::as_f64).ok_or_else(|| {
        rejected(
            "AGG_TRUST_CONFIG_VERSION_INVALID",
            format!("{field} must be a positive safe integer"),
        )
    })?;
    if !number.is_finite()
        || number.fract() != 0.0
        || number < 1.0
        || number > MAX_SAFE_INTEGER as f64
    {
        return Err(rejected(
            "AGG_TRUST_CONFIG_VERSION_INVALID",
            format!("{field} must be a positive safe integer"),
        ));
    }
    Ok(number as u64)
}

fn bounded_nonempty_string(
    value: Option<&Value>,
    field: &str,
    maximum: usize,
) -> Result<String, TrustError> {
    let value = string(value, field)?;
    if value.trim().is_empty() || value.encode_utf16().count() > maximum {
        return Err(rejected(
            "AGG_TRUST_CONFIG_SCHEMA_INVALID",
            format!("{field} must be a bounded non-empty string"),
        ));
    }
    Ok(value)
}

pub(crate) fn valid_key_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 80 || !bytes[0].is_ascii_lowercase() {
        return false;
    }
    let mut previous_was_separator = false;
    for byte in bytes.iter().copied().skip(1) {
        if byte.is_ascii_lowercase() || byte.is_ascii_digit() {
            previous_was_separator = false;
        } else if b"._-".contains(&byte) && !previous_was_separator {
            previous_was_separator = true;
        } else {
            return false;
        }
    }
    !previous_was_separator
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn string(value: Option<&Value>, field: &str) -> Result<String, TrustError> {
    value
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            rejected(
                "AGG_TRUST_CONFIG_SCHEMA_INVALID",
                format!("{field} must be a string"),
            )
        })
}

fn number(value: Option<&Value>, field: &str) -> Result<f64, TrustError> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| {
            rejected(
                "AGG_TRUST_CONFIG_SCHEMA_INVALID",
                format!("{field} must be a finite number"),
            )
        })
}

fn array<'a>(value: Option<&'a Value>, field: &str) -> Result<&'a Vec<Value>, TrustError> {
    value.and_then(Value::as_array).ok_or_else(|| {
        rejected(
            "AGG_TRUST_CONFIG_SCHEMA_INVALID",
            format!("{field} must be an array"),
        )
    })
}

fn object<'a>(
    value: &'a Value,
    field: &str,
) -> Result<&'a serde_json::Map<String, Value>, TrustError> {
    value.as_object().ok_or_else(|| {
        rejected(
            "AGG_TRUST_CONFIG_SCHEMA_INVALID",
            format!("{field} must be an object"),
        )
    })
}

fn exact_keys(
    value: &serde_json::Map<String, Value>,
    expected: &[&str],
    field: &str,
) -> Result<(), TrustError> {
    if value.len() != expected.len() || value.keys().any(|key| !expected.contains(&key.as_str())) {
        return Err(rejected(
            "AGG_TRUST_CONFIG_SCHEMA_INVALID",
            format!("{field} must contain exactly: {}", expected.join(", ")),
        ));
    }
    Ok(())
}

fn rejected(code: &'static str, message: impl Into<String>) -> TrustError {
    TrustError::rejected(code, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_PUBLIC_KEY: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAPUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=\n-----END PUBLIC KEY-----\n";
    const DISTINCT_PUBLIC_KEYS: [&str; 5] = [
        "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAJEAmSb/3WYVcER7u1Dp23vOMOUvn5JyNyCuQvYa+F7M=\n-----END PUBLIC KEY-----\n",
        "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAViou7qmUXvj5ilrq90/SrWg477p4NMn11zmayWUe6+c=\n-----END PUBLIC KEY-----\n",
        "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAf9gn+RE8/tb3fex59NLrpy/iie7dSEYOvVSZdoTZWa4=\n-----END PUBLIC KEY-----\n",
        "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAaHeh1kYwrlv6RRWA47vau4okwdomJATMWEtc0ryHpXM=\n-----END PUBLIC KEY-----\n",
        "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA3AHlQSuVP7TOagX62PIfT389Qm+DxlhHXlhm/VBtz+A=\n-----END PUBLIC KEY-----\n",
    ];
    const NOW: i64 = 1_793_510_400_000;

    fn config_json(
        domain: &str,
        provider: &str,
        scope: &str,
        pem: &str,
        version: u64,
        updated_at: &str,
    ) -> Vec<u8> {
        serde_json::json!({
            "schema_version": 1,
            "domain": domain,
            "provider_id": provider,
            "config_version": version,
            "updated_at": updated_at,
            "updated_by": "security-admin",
            "change_reference": format!("CHG-{domain}-{version}"),
            "keys": [{
                "key_id": "primary-root",
                "public_key_pem": pem,
                "scopes": [scope],
                "not_before": "2026-01-01T00:00:00.000Z",
                "not_after": null,
                "revoked_at": null
            }]
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn parses_admin_json_and_fingerprints_canonical_spki_and_configuration() {
        let bytes = config_json(
            "goal_idea_verifier",
            "source-provider",
            "agg.goal_idea_graph.verify",
            TEST_PUBLIC_KEY,
            1,
            "2026-11-01T00:00:00.000Z",
        );
        let config = TrustConfiguration::load_json(
            &bytes,
            "goal_idea_verifier",
            "agg.goal_idea_graph.verify",
            NOW,
        )
        .unwrap();
        assert_eq!(config.config_version, 1);
        assert_eq!(config.provider_id, "source-provider");
        assert_eq!(config.roots.len(), 1);
        assert_eq!(
            config.roots[0].trust_root_sha256,
            "deb2ded39dc26fce0e6085b6fc34bf6b5941913bbfe2ea614113cff9e004c170"
        );
        assert!(config.available);
        assert_eq!(config.configuration_source, "admin_json_environment");
    }

    #[test]
    fn checked_in_node_generated_trust_config_fixture_matches_fingerprints() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/trust-config-v1-node.json"
        ))
        .unwrap();
        let configuration = TrustConfiguration::load_json(
            fixture["input_json"].as_str().unwrap().as_bytes(),
            "goal_idea_verifier",
            "agg.goal_idea_graph.verify",
            NOW,
        )
        .unwrap();
        assert_eq!(
            configuration.configuration_fingerprint,
            fixture["configuration_fingerprint"].as_str().unwrap()
        );
        assert_eq!(
            configuration.roots[0].trust_root_sha256,
            fixture["trust_root_sha256"].as_str().unwrap()
        );
        assert!(configuration.validate_integrity().is_ok());
    }

    #[test]
    fn manually_mutated_public_configuration_objects_fail_integrity_validation() {
        let bytes = config_json(
            "goal_idea_verifier",
            "source-provider",
            "agg.goal_idea_graph.verify",
            TEST_PUBLIC_KEY,
            1,
            "2026-11-01T00:00:00.000Z",
        );
        let base = TrustConfiguration::load_json(
            &bytes,
            "goal_idea_verifier",
            "agg.goal_idea_graph.verify",
            NOW,
        )
        .unwrap();
        assert!(base.validate_integrity().is_ok());

        let mut changed_provider = base.clone();
        changed_provider.provider_id = "substituted-provider".into();
        assert!(changed_provider.validate_integrity().is_err());

        let mut changed_pem = base.clone();
        changed_pem.roots[0].public_key_pem = DISTINCT_PUBLIC_KEYS[0].into();
        assert!(changed_pem.validate_integrity().is_err());

        let mut changed_key_id = base.clone();
        changed_key_id.roots[0].key_id = "root..substituted".into();
        assert!(changed_key_id.validate_integrity().is_err());

        let mut changed_timestamp = base.clone();
        changed_timestamp.roots[0].not_before = "2026-02-01T00:00:00.000Z".into();
        assert!(changed_timestamp.validate_integrity().is_err());

        let mut changed_availability = base;
        changed_availability.available = false;
        assert!(changed_availability.validate_integrity().is_err());
    }

    #[test]
    fn rejects_legacy_shape_wrong_domain_scope_unknown_keys_and_duplicate_root() {
        let valid = config_json(
            "goal_idea_verifier",
            "source-provider",
            "agg.goal_idea_graph.verify",
            TEST_PUBLIC_KEY,
            1,
            "2026-11-01T00:00:00.000Z",
        );
        assert!(
            TrustConfiguration::load_json(
                &valid,
                "action_intent_reviewer",
                "agg.action_intent.review",
                NOW
            )
            .is_err()
        );
        let wrong_scope = config_json(
            "goal_idea_verifier",
            "source-provider",
            "agg.action_intent.review",
            TEST_PUBLIC_KEY,
            1,
            "2026-11-01T00:00:00.000Z",
        );
        assert!(
            TrustConfiguration::load_json(
                &wrong_scope,
                "goal_idea_verifier",
                "agg.goal_idea_graph.verify",
                NOW
            )
            .is_err()
        );
        let mut duplicate = serde_json::from_slice::<Value>(&valid).unwrap();
        let first_key = duplicate["keys"][0].clone();
        duplicate["keys"].as_array_mut().unwrap().push(first_key);
        assert!(
            TrustConfiguration::load_json(
                duplicate.to_string().as_bytes(),
                "goal_idea_verifier",
                "agg.goal_idea_graph.verify",
                NOW
            )
            .is_err()
        );
        for invalid_key_id in ["root..a", "root--a", "root_", "root-"] {
            let mut invalid_key = serde_json::from_slice::<Value>(&valid).unwrap();
            invalid_key["keys"][0]["key_id"] = Value::String(invalid_key_id.into());
            assert!(
                TrustConfiguration::load_json(
                    invalid_key.to_string().as_bytes(),
                    "goal_idea_verifier",
                    "agg.goal_idea_graph.verify",
                    NOW
                )
                .is_err(),
                "trust configuration parser must reject noncanonical key ID {invalid_key_id:?}"
            );
        }
        assert!(
            TrustConfiguration::load_json(
                br#"{"schema_version":1,"provider_id":"legacy","public_key_pem":"unused"}"#,
                "goal_idea_verifier",
                "agg.goal_idea_graph.verify",
                NOW
            )
            .is_err()
        );
    }

    #[test]
    fn validity_windows_revocation_and_issued_at_are_enforced() {
        let future = String::from_utf8(config_json(
            "goal_idea_verifier",
            "source-provider",
            "agg.goal_idea_graph.verify",
            TEST_PUBLIC_KEY,
            1,
            "2026-11-01T00:00:00.000Z",
        ))
        .unwrap()
        .replace("2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z");
        let config = TrustConfiguration::load_json(
            future.as_bytes(),
            "goal_idea_verifier",
            "agg.goal_idea_graph.verify",
            NOW,
        )
        .unwrap();
        assert!(!config.available);
        assert_eq!(
            config
                .find_root(&config.roots[0].trust_root_sha256, None, NOW)
                .unwrap_err()
                .code(),
            "AGG_TRUST_ROOT_OUTSIDE_VALIDITY"
        );
        let revoked = String::from_utf8(config_json(
            "goal_idea_verifier",
            "source-provider",
            "agg.goal_idea_graph.verify",
            TEST_PUBLIC_KEY,
            1,
            "2026-11-01T00:00:00.000Z",
        ))
        .unwrap()
        .replace(
            "\"revoked_at\":null",
            "\"revoked_at\":\"2026-10-01T00:00:00.000Z\"",
        );
        let config = TrustConfiguration::load_json(
            revoked.as_bytes(),
            "goal_idea_verifier",
            "agg.goal_idea_graph.verify",
            NOW,
        )
        .unwrap();
        assert!(!config.available);
        assert_eq!(
            config
                .find_root(&config.roots[0].trust_root_sha256, None, NOW)
                .unwrap_err()
                .code(),
            "AGG_TRUST_ROOT_REVOKED"
        );
    }

    #[test]
    fn configuration_set_requires_all_five_disjoint_domains() {
        let mut configurations = BTreeMap::new();
        for (index, spec) in TRUST_DOMAIN_SPECS.iter().enumerate() {
            configurations.insert(
                spec.domain.to_owned(),
                config_json(
                    spec.domain,
                    &format!("provider-{}", spec.domain),
                    spec.scope,
                    DISTINCT_PUBLIC_KEYS[index],
                    1,
                    "2026-11-01T00:00:00.000Z",
                ),
            );
        }
        let loaded = TrustConfigurationSet::load_json(&configurations, NOW).unwrap();
        assert_eq!(loaded.domains.len(), TRUST_DOMAIN_SPECS.len());
        let ledger = TrustLedger::in_memory().unwrap();
        assert_eq!(
            loaded.assert_observed(&ledger).unwrap_err().code(),
            "AGG_TRUST_CONFIG_NOT_OBSERVED"
        );
        let observations = loaded.record_observations(&ledger, NOW).unwrap();
        assert_eq!(observations.len(), TRUST_DOMAIN_SPECS.len());
        loaded.assert_observed(&ledger).unwrap();

        let mut root_collision = BTreeMap::new();
        for spec in TRUST_DOMAIN_SPECS {
            root_collision.insert(
                spec.domain.to_owned(),
                config_json(
                    spec.domain,
                    &format!("provider-{}", spec.domain),
                    spec.scope,
                    TEST_PUBLIC_KEY,
                    1,
                    "2026-11-01T00:00:00.000Z",
                ),
            );
        }
        assert_eq!(
            TrustConfigurationSet::load_json(&root_collision, NOW)
                .unwrap_err()
                .code(),
            "AGG_TRUST_DOMAINS_ROOT_COLLISION"
        );

        let mut provider_collision = BTreeMap::new();
        for (index, spec) in TRUST_DOMAIN_SPECS.iter().enumerate() {
            provider_collision.insert(
                spec.domain.to_owned(),
                config_json(
                    spec.domain,
                    "shared-provider",
                    spec.scope,
                    DISTINCT_PUBLIC_KEYS[index],
                    1,
                    "2026-11-01T00:00:00.000Z",
                ),
            );
        }
        assert_eq!(
            TrustConfigurationSet::load_json(&provider_collision, NOW)
                .unwrap_err()
                .code(),
            "AGG_TRUST_DOMAINS_PROVIDER_COLLISION"
        );

        configurations.remove("execution_approval");
        assert_eq!(
            TrustConfigurationSet::load_json(&configurations, NOW)
                .unwrap_err()
                .code(),
            "AGG_TRUST_CONFIG_NOT_CONFIGURED"
        );
    }
}
