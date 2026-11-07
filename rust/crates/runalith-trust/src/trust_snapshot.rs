//! Versioned references to exact administrator-managed trust configurations.
//!
//! A snapshot reference identifies the complete trust configuration and its
//! domain/provider/version. It is not proof that the configuration was
//! explicitly observed, is still current, or has a usable key at a given time;
//! callers must separately enforce the appropriate high-water and key-validity
//! checks through the Governance-owned observer/verifier boundary.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::TrustError;
use crate::trust_config::{TRUST_DOMAIN_SPECS, TrustConfiguration};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Stable reference to one exact V1 Governance trust-configuration snapshot.
///
/// `configuration_fingerprint` identifies the complete canonical administrator
/// configuration. `canonical_sha256` identifies this smaller reference object;
/// the two digests have different subjects and must not be interchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrustSnapshotRefV1 {
    /// Trust snapshot reference schema version.
    pub schema_version: u32,
    /// Exact independent trust domain.
    pub domain: String,
    /// Exact provider identity pinned by the configuration.
    pub provider_id: String,
    /// Exact signing scope assigned to the domain.
    pub scope: String,
    /// Monotonic administrator configuration version.
    pub config_version: u64,
    /// Fingerprint of the complete administrator trust configuration.
    pub configuration_fingerprint: String,
}

impl TrustSnapshotRefV1 {
    /// Construct a reference from an integrity-validated configuration.
    ///
    /// This operation is read-only. It does not write or advance the trust
    /// ledger and does not assert that an administrator explicitly observed
    /// this configuration.
    pub fn from_configuration(configuration: &TrustConfiguration) -> Result<Self, TrustError> {
        configuration.validate_integrity()?;
        let reference = Self {
            schema_version: 1,
            domain: configuration.domain.clone(),
            provider_id: configuration.provider_id.clone(),
            scope: configuration.scope.clone(),
            config_version: configuration.config_version,
            configuration_fingerprint: configuration.configuration_fingerprint.clone(),
        };
        reference.validate()?;
        Ok(reference)
    }

    /// Validate schema, identity, supported trust-domain/scope and digests.
    pub fn validate(&self) -> Result<(), TrustError> {
        if self.schema_version != 1 {
            return Err(rejected(
                "AGG_TRUST_SNAPSHOT_REF_VERSION_UNSUPPORTED",
                "trust snapshot reference schema_version must equal 1",
            ));
        }
        if !bounded_identity(&self.domain, 128)
            || !bounded_identity(&self.provider_id, 200)
            || !bounded_identity(&self.scope, 256)
        {
            return Err(rejected(
                "AGG_TRUST_SNAPSHOT_REF_INVALID",
                "trust snapshot domain, provider and scope must be trimmed bounded identities",
            ));
        }
        let Some(spec) = TRUST_DOMAIN_SPECS
            .iter()
            .find(|spec| spec.domain == self.domain)
        else {
            return Err(rejected(
                "AGG_TRUST_SNAPSHOT_REF_DOMAIN_INVALID",
                "trust snapshot reference names an unsupported trust domain",
            ));
        };
        if spec.scope != self.scope {
            return Err(rejected(
                "AGG_TRUST_SNAPSHOT_REF_DOMAIN_INVALID",
                "trust snapshot scope does not match its configured domain",
            ));
        }
        if self.config_version == 0 || self.config_version > MAX_SAFE_INTEGER {
            return Err(rejected(
                "AGG_TRUST_SNAPSHOT_REF_VERSION_INVALID",
                "trust snapshot config_version must be a positive safe integer",
            ));
        }
        if !is_sha256(&self.configuration_fingerprint) {
            return Err(rejected(
                "AGG_TRUST_SNAPSHOT_REF_INVALID",
                "configuration_fingerprint must be lowercase SHA-256 hex",
            ));
        }
        Ok(())
    }

    /// Require this reference to identify the exact supplied configuration.
    ///
    /// This checks configuration integrity and identity only. It does not
    /// replace `TrustConfigurationObserver::assert_observed` or its
    /// transaction-bound variant.
    pub fn validate_for_configuration(
        &self,
        configuration: &TrustConfiguration,
    ) -> Result<(), TrustError> {
        self.validate()?;
        let expected = Self::from_configuration(configuration)?;
        if self != &expected {
            return Err(rejected(
                "AGG_TRUST_SNAPSHOT_REF_BINDING_MISMATCH",
                "trust snapshot reference does not identify the supplied configuration",
            ));
        }
        Ok(())
    }

    /// Canonical JSON bytes covered by this reference's digest.
    pub fn canonical_json(&self) -> Result<String, TrustError> {
        self.validate()?;
        let value = serde_json::to_value(self).map_err(|error| {
            rejected(
                "AGG_TRUST_SNAPSHOT_REF_CANONICALIZATION_FAILED",
                format!("trust snapshot reference serialization failed: {error}"),
            )
        })?;
        runalith_protocol::agg_checkpoint_v2::canonicalize(&value).map_err(|error| {
            rejected(
                "AGG_TRUST_SNAPSHOT_REF_CANONICALIZATION_FAILED",
                format!("trust snapshot reference canonicalization failed: {error}"),
            )
        })
    }

    /// SHA-256 over canonical JSON for this exact snapshot reference.
    pub fn canonical_sha256(&self) -> Result<String, TrustError> {
        Ok(hex::encode(Sha256::digest(
            self.canonical_json()?.as_bytes(),
        )))
    }
}

fn bounded_identity(value: &str, max: usize) -> bool {
    !value.trim().is_empty()
        && value == value.trim()
        && value.len() <= max
        && !value.chars().any(char::is_control)
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

    const NOW: i64 = 1_793_491_200_000;

    fn configuration() -> TrustConfiguration {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/trust-config-v1-node.json"
        ))
        .unwrap();
        TrustConfiguration::load_json(
            fixture["input_json"].as_str().unwrap().as_bytes(),
            "goal_idea_verifier",
            "agg.goal_idea_graph.verify",
            NOW,
        )
        .unwrap()
    }

    #[test]
    fn node_configuration_produces_stable_exact_snapshot_reference() {
        let configuration = configuration();
        let reference = TrustSnapshotRefV1::from_configuration(&configuration).unwrap();
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/trust-snapshot-ref-v1-node.json"
        ))
        .unwrap();

        assert_eq!(reference.schema_version, 1);
        assert_eq!(reference.domain, "goal_idea_verifier");
        assert_eq!(reference.provider_id, "source-provider");
        assert_eq!(reference.scope, "agg.goal_idea_graph.verify");
        assert_eq!(reference.config_version, 1);
        assert_eq!(
            reference.configuration_fingerprint,
            configuration.configuration_fingerprint
        );
        assert!(reference.validate_for_configuration(&configuration).is_ok());

        let encoded = serde_json::to_string(&reference).unwrap();
        let decoded: TrustSnapshotRefV1 = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, reference);
        assert_eq!(
            decoded.canonical_json().unwrap(),
            reference.canonical_json().unwrap()
        );
        assert_eq!(
            decoded.canonical_sha256().unwrap(),
            reference.canonical_sha256().unwrap()
        );
        assert_eq!(
            reference.canonical_json().unwrap(),
            fixture["snapshot_json"].as_str().unwrap()
        );
        assert_eq!(
            reference.canonical_sha256().unwrap(),
            fixture["snapshot_sha256"].as_str().unwrap()
        );
    }

    #[test]
    fn snapshot_reference_digest_is_distinct_from_configuration_fingerprint() {
        let reference = TrustSnapshotRefV1::from_configuration(&configuration()).unwrap();
        assert_ne!(
            reference.canonical_sha256().unwrap(),
            reference.configuration_fingerprint
        );
    }

    #[test]
    fn rejects_unknown_domain_wrong_scope_invalid_version_and_malformed_fingerprint() {
        let original = TrustSnapshotRefV1::from_configuration(&configuration()).unwrap();

        let mut changed = original.clone();
        changed.domain = "unknown_domain".into();
        assert_eq!(
            changed.validate().unwrap_err().code(),
            "AGG_TRUST_SNAPSHOT_REF_DOMAIN_INVALID"
        );

        let mut changed = original.clone();
        changed.scope = "agg.execution.approve".into();
        assert_eq!(
            changed.validate().unwrap_err().code(),
            "AGG_TRUST_SNAPSHOT_REF_DOMAIN_INVALID"
        );

        let mut changed = original.clone();
        changed.config_version = 0;
        assert_eq!(
            changed.validate().unwrap_err().code(),
            "AGG_TRUST_SNAPSHOT_REF_VERSION_INVALID"
        );

        let mut changed = original.clone();
        changed.configuration_fingerprint = "A".repeat(64);
        assert_eq!(
            changed.validate().unwrap_err().code(),
            "AGG_TRUST_SNAPSHOT_REF_INVALID"
        );

        let mut changed = original;
        changed.schema_version = 2;
        assert_eq!(
            changed.validate().unwrap_err().code(),
            "AGG_TRUST_SNAPSHOT_REF_VERSION_UNSUPPORTED"
        );
    }

    #[test]
    fn rejects_extra_fields_and_configuration_substitution() {
        let reference = TrustSnapshotRefV1::from_configuration(&configuration()).unwrap();
        let mut value = serde_json::to_value(&reference).unwrap();
        value["unreviewed"] = serde_json::Value::Bool(true);
        assert!(serde_json::from_value::<TrustSnapshotRefV1>(value).is_err());

        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/trust-config-v1-node.json"
        ))
        .unwrap();
        let mut input: serde_json::Value =
            serde_json::from_str(fixture["input_json"].as_str().unwrap()).unwrap();
        input["provider_id"] = serde_json::Value::String("other-provider".into());
        let other = TrustConfiguration::load_json(
            serde_json::to_string(&input).unwrap().as_bytes(),
            "goal_idea_verifier",
            "agg.goal_idea_graph.verify",
            NOW,
        )
        .unwrap();
        assert_eq!(
            reference
                .validate_for_configuration(&other)
                .unwrap_err()
                .code(),
            "AGG_TRUST_SNAPSHOT_REF_BINDING_MISMATCH"
        );
    }
}
