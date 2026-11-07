//! Shared Ed25519 signed-envelope verification for trust-backed attestations.
//!
//! Domain-specific callers must validate their exact envelope key set and
//! domain fields before/after calling this common cryptographic boundary.

use rusqlite::Transaction;
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::trust_config::{TrustConfiguration, canonical_timestamp};
use crate::trust_ledger::TrustConfigurationObserver;
use crate::{TrustCryptoError, TrustError};

/// Map errors raised while verifying signature bytes without turning a crypto
/// runtime outage into a malformed-envelope or invalid-signature finding.
///
/// The caller supplies the stable domain-specific code for malformed input.
/// Operational failures share the existing trust-verifier-unavailable code;
/// no new public cause code or wire field is introduced here.
pub(crate) fn map_signature_verification_error(
    error: TrustCryptoError,
    invalid_code: &'static str,
    invalid_message: &'static str,
) -> TrustError {
    match error {
        TrustCryptoError::OpenSslUnavailable
        | TrustCryptoError::UntrustedOpenSslBinary
        | TrustCryptoError::TemporaryFile(_)
        | TrustCryptoError::OpenSslOperation(_) => TrustError::rejected(
            "AGG_TRUST_CONFIG_OPENSSL_UNAVAILABLE",
            "cryptographic signature-verification runtime is unavailable",
        ),
        other => TrustError::rejected(invalid_code, format!("{invalid_message}: {other}")),
    }
}

/// Verified common fields from a signed trust envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedEnvelope {
    /// Configured key ID used to verify the signature.
    pub key_id: String,
    /// Canonical SPKI SHA-256 fingerprint.
    pub trust_root_sha256: String,
    /// One-use decision nonce. Policy envelopes may be reusable by domain policy.
    pub nonce: String,
    /// Signed issuance timestamp, Unix milliseconds.
    pub issued_at_ms: i64,
    /// Signed expiry timestamp, Unix milliseconds.
    pub expires_at_ms: i64,
    /// SHA-256 over canonical JSON including the signature.
    pub signed_envelope_hash: String,
}

/// Verify a signed envelope only after exact administrator configuration has
/// been explicitly observed by the supplied trust high-water observer.
pub fn verify_observed_signed_envelope(
    configuration: &TrustConfiguration,
    ledger: &dyn TrustConfigurationObserver,
    envelope: &Value,
    expected_scope: &str,
    expected_kind: &str,
    now_ms: i64,
) -> Result<VerifiedEnvelope, TrustError> {
    configuration.validate_integrity()?;
    ledger.assert_observed(configuration)?;
    verify_signed_envelope(
        configuration,
        envelope,
        expected_scope,
        expected_kind,
        now_ms,
    )
}

/// Transaction-bound variant for D-01 approval verification. Trust high-water
/// is read from the exact workflow transaction that will consume decision
/// nonces and persist approval.
pub fn verify_observed_signed_envelope_in_transaction(
    configuration: &TrustConfiguration,
    observer: &dyn TrustConfigurationObserver,
    transaction: &Transaction<'_>,
    envelope: &Value,
    expected_scope: &str,
    expected_kind: &str,
    now_ms: i64,
) -> Result<VerifiedEnvelope, TrustError> {
    configuration.validate_integrity()?;
    observer.assert_observed_in_transaction(transaction, configuration)?;
    verify_signed_envelope(
        configuration,
        envelope,
        expected_scope,
        expected_kind,
        now_ms,
    )
}

/// Verify common schema-v1 Ed25519 envelope fields and signature.
///
/// The caller remains responsible for exact domain-specific keys, policy,
/// reviewer role/quorum, candidate binding and nonce replay checks.
pub fn verify_signed_envelope(
    configuration: &TrustConfiguration,
    envelope: &Value,
    expected_scope: &str,
    expected_kind: &str,
    now_ms: i64,
) -> Result<VerifiedEnvelope, TrustError> {
    configuration.validate_integrity()?;
    let object = envelope.as_object().ok_or_else(|| {
        TrustError::rejected(
            "AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID",
            "signed envelope must be an object",
        )
    })?;
    if expected_scope != configuration.scope {
        return Err(TrustError::rejected(
            "AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID",
            "expected signature scope does not match configured trust domain",
        ));
    }
    if object.get("schema_version").and_then(Value::as_f64) != Some(1.0)
        || object.get("kind").and_then(Value::as_str) != Some(expected_kind)
        || object.get("signature_algorithm").and_then(Value::as_str) != Some("Ed25519")
    {
        return Err(TrustError::rejected(
            "AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID",
            "signed envelope has invalid schema version, kind or signature algorithm",
        ));
    }
    let provider_id = required_string(object, "provider_id")?;
    if provider_id != configuration.provider_id {
        return Err(TrustError::rejected(
            "AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID",
            "signed envelope provider does not match configured trust provider",
        ));
    }
    let scope = required_string(object, "scope")?;
    if scope != expected_scope {
        return Err(TrustError::rejected(
            "AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID",
            "signed envelope scope does not match expected scope",
        ));
    }
    let nonce = required_string(object, "nonce")?;
    if !is_uuid(&nonce) {
        return Err(TrustError::rejected(
            "AGG_APPROVAL_EVIDENCE_NONCE_INVALID",
            "signed envelope nonce must be a UUID",
        ));
    }
    if now_ms < 0 || now_ms as u64 > 9_007_199_254_740_991 {
        return Err(TrustError::rejected(
            "AGG_APPROVAL_CLOCK_INVALID",
            "approval verification time must be a non-negative safe integer",
        ));
    }
    let issued_at = required_string(object, "issued_at")?;
    let expires_at = required_string(object, "expires_at")?;
    let issued_at_ms = canonical_timestamp(&issued_at, "issued_at")?;
    let expires_at_ms = canonical_timestamp(&expires_at, "expires_at")?;
    if expires_at_ms <= issued_at_ms || expires_at_ms <= now_ms {
        return Err(TrustError::rejected(
            "AGG_APPROVAL_SIGNATURE_ENVELOPE_EXPIRED",
            "signed envelope has expired or has a non-positive validity interval",
        ));
    }
    if issued_at_ms > now_ms.saturating_add(60_000) {
        return Err(TrustError::rejected(
            "AGG_APPROVAL_SIGNATURE_ENVELOPE_FUTURE_DATED",
            "signed envelope issued_at is more than one minute in the future",
        ));
    }
    let trust_root_sha256 = required_string(object, "trust_root_sha256")?;
    let trusted_root = configuration.find_root(&trust_root_sha256, Some(issued_at_ms), now_ms)?;
    let signature = required_string(object, "signature")?;
    if signature.len() != 88
        || !signature
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    {
        return Err(TrustError::rejected(
            "AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID",
            "signed envelope signature must be canonical standard Base64 for a 64-byte Ed25519 signature",
        ));
    }
    let mut unsigned = envelope.clone();
    unsigned
        .as_object_mut()
        .expect("envelope object was checked")
        .remove("signature");
    let canonical_unsigned = runalith_protocol::agg_checkpoint_v2::canonicalize(&unsigned)
        .map_err(|error| {
            TrustError::rejected(
                "AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID",
                format!("signed envelope payload cannot be canonicalized: {error}"),
            )
        })?;
    let valid = trusted_root
        .public_key
        .verify_base64(canonical_unsigned.as_bytes(), &signature)
        .map_err(|error| {
            map_signature_verification_error(
                error,
                "AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID",
                "signed envelope signature encoding is invalid",
            )
        })?;
    if !valid {
        return Err(TrustError::rejected(
            "AGG_APPROVAL_SIGNATURE_INVALID",
            "signed envelope signature does not verify under the configured public root",
        ));
    }
    let canonical_full =
        runalith_protocol::agg_checkpoint_v2::canonicalize(envelope).map_err(|error| {
            TrustError::rejected(
                "AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID",
                format!("complete signed envelope cannot be canonicalized: {error}"),
            )
        })?;
    Ok(VerifiedEnvelope {
        key_id: trusted_root.key_id.clone(),
        trust_root_sha256,
        nonce,
        issued_at_ms,
        expires_at_ms,
        signed_envelope_hash: hex::encode(Sha256::digest(canonical_full.as_bytes())),
    })
}

fn required_string(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<String, TrustError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            TrustError::rejected(
                "AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID",
                format!("signed envelope {field} must be a string"),
            )
        })
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
        && matches!(bytes[14], b'1'..=b'8')
        && matches!(bytes[19].to_ascii_lowercase(), b'8'..=b'b')
        && Uuid::parse_str(value).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trust_config::TrustConfiguration;
    use crate::trust_ledger::TrustLedger;

    const NOW: i64 = 1_793_491_200_000;

    #[test]
    fn signature_verification_runtime_errors_are_unavailable_not_invalid_envelopes() {
        for error in [
            TrustCryptoError::OpenSslUnavailable,
            TrustCryptoError::UntrustedOpenSslBinary,
            TrustCryptoError::TemporaryFile("private temporary file unavailable".into()),
            TrustCryptoError::OpenSslOperation("OpenSSL process could not execute".into()),
        ] {
            let mapped = map_signature_verification_error(
                error,
                "AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID",
                "invalid envelope signature",
            );
            assert_eq!(mapped.code(), "AGG_TRUST_CONFIG_OPENSSL_UNAVAILABLE");
        }

        for error in [
            TrustCryptoError::InvalidBase64,
            TrustCryptoError::InvalidPublicKey,
            TrustCryptoError::InputLimit("signature input exceeds the configured bound"),
        ] {
            let mapped = map_signature_verification_error(
                error,
                "AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID",
                "invalid envelope signature",
            );
            assert_eq!(mapped.code(), "AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID");
        }
    }

    #[test]
    fn node_generated_ed25519_envelope_fixture_verifies_exact_canonical_payload() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/trust-signed-envelope-v1-node.json"
        ))
        .unwrap();
        let configuration = TrustConfiguration::load_json(
            fixture["trust_config_json"].as_str().unwrap().as_bytes(),
            "execution_approval_policy",
            "agg.approval.policy",
            NOW,
        )
        .unwrap();
        let envelope: Value =
            serde_json::from_str(fixture["envelope_json"].as_str().unwrap()).unwrap();
        let ledger = TrustLedger::in_memory().unwrap();
        assert_eq!(
            verify_observed_signed_envelope(
                &configuration,
                &ledger,
                &envelope,
                "agg.approval.policy",
                "adaptive_goal_execution_approval_policy",
                NOW,
            )
            .unwrap_err()
            .code(),
            "AGG_TRUST_CONFIG_NOT_OBSERVED"
        );
        ledger.record(&configuration, NOW).unwrap();
        let verified = verify_observed_signed_envelope(
            &configuration,
            &ledger,
            &envelope,
            "agg.approval.policy",
            "adaptive_goal_execution_approval_policy",
            NOW,
        )
        .unwrap();
        assert_eq!(
            verified.signed_envelope_hash,
            fixture["signed_envelope_hash"].as_str().unwrap()
        );
        assert_eq!(
            verified.trust_root_sha256,
            configuration.roots[0].trust_root_sha256
        );
        assert_eq!(verified.nonce, "d4e5f6a7-1234-4abc-8def-1234567890ab");
    }

    #[test]
    fn rejects_wrong_provider_scope_kind_expiry_nonce_and_signature() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/trust-signed-envelope-v1-node.json"
        ))
        .unwrap();
        let configuration = TrustConfiguration::load_json(
            fixture["trust_config_json"].as_str().unwrap().as_bytes(),
            "execution_approval_policy",
            "agg.approval.policy",
            NOW,
        )
        .unwrap();
        let original: Value =
            serde_json::from_str(fixture["envelope_json"].as_str().unwrap()).unwrap();
        let verify = |envelope: &Value| {
            verify_signed_envelope(
                &configuration,
                envelope,
                "agg.approval.policy",
                "adaptive_goal_execution_approval_policy",
                NOW,
            )
        };
        let mut changed = original.clone();
        changed["provider_id"] = Value::String("other-provider".into());
        assert_eq!(
            verify(&changed).unwrap_err().code(),
            "AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID"
        );
        let mut changed = original.clone();
        changed["kind"] = Value::String("wrong-kind".into());
        assert_eq!(
            verify(&changed).unwrap_err().code(),
            "AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID"
        );
        let mut changed = original.clone();
        changed["nonce"] = Value::String("not-a-uuid".into());
        assert_eq!(
            verify(&changed).unwrap_err().code(),
            "AGG_APPROVAL_EVIDENCE_NONCE_INVALID"
        );
        let mut changed = original.clone();
        changed["signature"] = Value::String("A".repeat(88));
        assert_eq!(
            verify(&changed).unwrap_err().code(),
            "AGG_APPROVAL_SIGNATURE_INVALID"
        );
        assert_eq!(
            verify_signed_envelope(
                &configuration,
                &original,
                "agg.approval.policy",
                "adaptive_goal_execution_approval_policy",
                NOW + 31 * 60 * 1000,
            )
            .unwrap_err()
            .code(),
            "AGG_APPROVAL_SIGNATURE_ENVELOPE_EXPIRED"
        );
    }
}
