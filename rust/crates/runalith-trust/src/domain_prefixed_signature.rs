//! Verification of the versioned domain-prefix + NUL + restricted-JCS
//! Ed25519 signed-byte profile.
//!
//! This module verifies only the cryptographic byte profile. The caller must
//! supply the expected domain and kind from host-pinned configuration and must
//! independently verify issuer, audience, provider/account, TrustSnapshotRef,
//! key lifecycle, high-water, expiry, revocation, replay, evidence lineage and
//! any commit-time freshness fence. A successful result is NOT an authorized,
//! trusted-source or VERIFIED-evidence decision.

use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

use runalith_protocol::agg_checkpoint_v2::{
    AggCheckpointError, MAX_JSON_BYTES, canonicalize, parse_json,
};

use crate::{Ed25519PublicKey, TrustCryptoError};

/// Exact signed-byte profile identifier accepted by this V1 helper.
pub const DOMAIN_PREFIXED_SIGNED_BYTES_PROFILE_V1: &str =
    "RFC8785-JCS-UTF8-ASCII-KEYS-SAFE-INTEGERS-DOMAIN-NUL-AND-MEMBER-EXCLUDE-SIGNATURE-V1";

/// Error from parsing or verifying a domain-prefixed signature profile.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum DomainPrefixedSignatureError {
    /// The host-pinned profile identifiers or unsigned envelope are invalid.
    #[error("domain-prefixed signature profile is invalid: {0}")]
    InvalidProfile(&'static str),
    /// Strict JSON parsing or restricted canonicalization failed.
    #[error(transparent)]
    CanonicalJson(#[from] AggCheckpointError),
    /// The Ed25519 primitive or signature encoding failed.
    #[error(transparent)]
    Crypto(#[from] TrustCryptoError),
    /// The signature is well-formed but does not verify over the exact preimage.
    #[error("Ed25519 signature does not verify for the expected domain-prefixed preimage")]
    SignatureInvalid,
}

/// Cryptographic byte-profile result only; it grants no trust or authorization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedDomainPrefixedSignatureBytes {
    /// Host-pinned signed domain-separation label.
    pub domain_separation: String,
    /// Exact kind committed in the signed JSON object.
    pub kind: String,
    /// SHA-256 of canonical unsigned-envelope JSON bytes.
    pub canonical_unsigned_sha256: String,
    /// SHA-256 of domain + NUL + canonical unsigned JSON.
    pub signed_preimage_sha256: String,
    /// Exact byte length of domain + NUL + canonical unsigned JSON.
    pub signed_preimage_byte_len: usize,
}

/// Verify the v1 domain-separated Ed25519 byte profile.
///
/// The normative preimage is UTF8(expected_domain_separation), one NUL byte,
/// then restricted JCS canonical bytes of the unsigned envelope.
///
/// The unsigned JSON is parsed from original bytes using the strict protocol
/// parser (including duplicate-key and number-token checks), then canonicalized.
/// The schema_version, signature_algorithm, signature_encoding,
/// signed_bytes_profile, domain_separation and kind members must match this V1
/// profile and the host-pinned expected value; the unsigned object must not
/// contain signature. The caller must still validate the complete closed DTO
/// schema and all domain-specific fields before treating the object as a
/// SourceVerificationAttestationV1 candidate.
///
/// This helper deliberately does not select or validate a trust domain, issuer,
/// audience, provider, root, key validity, revocation, high-water, nonce, source
/// lineage or persistence. The public key must already have been selected by a
/// separately trusted host context. Its result is evidence of signature
/// validity over these bytes only, not a signed decision or authorization.
pub fn verify_domain_prefixed_signature_bytes(
    public_key: &Ed25519PublicKey,
    expected_domain_separation: &str,
    expected_kind: &str,
    unsigned_envelope_json: &[u8],
    signature_base64: &str,
) -> Result<VerifiedDomainPrefixedSignatureBytes, DomainPrefixedSignatureError> {
    if expected_domain_separation.is_empty()
        || expected_domain_separation != expected_domain_separation.trim()
        || expected_domain_separation.len() > 256
        || !expected_domain_separation.is_ascii()
        || expected_domain_separation.chars().any(char::is_control)
        || expected_kind != expected_domain_separation
    {
        return Err(DomainPrefixedSignatureError::InvalidProfile(
            "expected domain and kind must be the same non-empty, trim-stable ASCII label",
        ));
    }
    if unsigned_envelope_json.is_empty() || unsigned_envelope_json.len() > MAX_JSON_BYTES {
        return Err(DomainPrefixedSignatureError::InvalidProfile(
            "unsigned envelope must be non-empty and within the strict JSON size limit",
        ));
    }

    let value = parse_json(unsigned_envelope_json)?;
    let object = value
        .as_object()
        .ok_or(DomainPrefixedSignatureError::InvalidProfile(
            "unsigned envelope must be a JSON object",
        ))?;
    if object.contains_key("signature") {
        return Err(DomainPrefixedSignatureError::InvalidProfile(
            "unsigned envelope must exclude the signature member",
        ));
    }
    if object.keys().any(|key| !key.is_ascii()) {
        return Err(DomainPrefixedSignatureError::InvalidProfile(
            "signed envelope member names must be ASCII",
        ));
    }
    if object.get("schema_version").and_then(Value::as_u64) != Some(1)
        || object.get("kind").and_then(Value::as_str) != Some(expected_kind)
        || object.get("domain_separation").and_then(Value::as_str)
            != Some(expected_domain_separation)
        || object.get("signature_algorithm").and_then(Value::as_str) != Some("Ed25519")
        || object.get("signature_encoding").and_then(Value::as_str) != Some("BASE64_STANDARD")
        || object.get("signed_bytes_profile").and_then(Value::as_str)
            != Some(DOMAIN_PREFIXED_SIGNED_BYTES_PROFILE_V1)
    {
        return Err(DomainPrefixedSignatureError::InvalidProfile(
            "schema, kind, domain, algorithm, encoding and signed-bytes profile must match V1",
        ));
    }

    let canonical_unsigned = canonicalize(&value)?;
    let mut signed_preimage =
        Vec::with_capacity(expected_domain_separation.len() + 1 + canonical_unsigned.len());
    signed_preimage.extend_from_slice(expected_domain_separation.as_bytes());
    signed_preimage.push(0);
    signed_preimage.extend_from_slice(canonical_unsigned.as_bytes());
    if signed_preimage.len() > MAX_JSON_BYTES {
        return Err(DomainPrefixedSignatureError::InvalidProfile(
            "domain-prefixed signed preimage exceeds the strict byte limit",
        ));
    }

    if !public_key.verify_base64(&signed_preimage, signature_base64)? {
        return Err(DomainPrefixedSignatureError::SignatureInvalid);
    }

    Ok(VerifiedDomainPrefixedSignatureBytes {
        domain_separation: expected_domain_separation.to_owned(),
        kind: expected_kind.to_owned(),
        canonical_unsigned_sha256: hex::encode(Sha256::digest(canonical_unsigned.as_bytes())),
        signed_preimage_sha256: hex::encode(Sha256::digest(&signed_preimage)),
        signed_preimage_byte_len: signed_preimage.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    const GOLDEN: &str =
        include_str!("../tests/fixtures/domain-prefixed-signature-v1-ws7-golden.json");

    fn fixture() -> Value {
        serde_json::from_str(GOLDEN).expect("WS7 v0.5 golden fixture parses")
    }

    fn verifier() -> (Value, Ed25519PublicKey) {
        let fixture = fixture();
        let pem = fixture["public_key_pem"]
            .as_str()
            .expect("golden public key PEM");
        let key = Ed25519PublicKey::from_pem(pem).expect("golden Ed25519 public key");
        (fixture, key)
    }

    #[test]
    fn verifies_ws7_v05_domain_prefix_nul_jcs_golden_signature_exactly() {
        let (fixture, key) = verifier();
        assert_eq!(
            fixture["source_fixture_sha256"],
            "9f23e8e411986750ca4b3849696f97892198511796f1c7898b1fb1c0139178a2"
        );
        assert_eq!(
            fixture["signed_bytes_profile"],
            DOMAIN_PREFIXED_SIGNED_BYTES_PROFILE_V1
        );
        let domain = fixture["domain_prefix_utf8"].as_str().unwrap();
        let kind = fixture["kind"].as_str().unwrap();
        let unsigned = fixture["canonical_unsigned_envelope_utf8"]
            .as_str()
            .unwrap()
            .as_bytes();
        let result = verify_domain_prefixed_signature_bytes(
            &key,
            domain,
            kind,
            unsigned,
            fixture["signature_base64"].as_str().unwrap(),
        )
        .expect("golden signature verifies");

        assert_eq!(result.domain_separation, domain);
        assert_eq!(result.kind, kind);
        assert_eq!(
            result.signed_preimage_sha256,
            fixture["signed_preimage_sha256"]
        );
        assert_eq!(
            result.signed_preimage_byte_len,
            fixture["signed_preimage_byte_len"].as_u64().unwrap() as usize
        );
        assert_eq!(
            result.signed_preimage_sha256,
            "e07e6011b42f214114df0a8be66a4390bd3dc8bbe638fbf621e38dbb2e823fa3"
        );
        assert_eq!(result.signed_preimage_byte_len, 3284);
    }

    #[test]
    fn rejects_host_domain_or_kind_that_does_not_match_the_signed_profile() {
        let (fixture, key) = verifier();
        let unsigned = fixture["canonical_unsigned_envelope_utf8"]
            .as_str()
            .unwrap()
            .as_bytes();
        let signature = fixture["signature_base64"].as_str().unwrap();
        let domain = fixture["domain_prefix_utf8"].as_str().unwrap();

        assert!(matches!(
            verify_domain_prefixed_signature_bytes(
                &key,
                "runalith.other.attestation.v1",
                "runalith.other.attestation.v1",
                unsigned,
                signature
            ),
            Err(DomainPrefixedSignatureError::InvalidProfile(_))
        ));
        assert!(matches!(
            verify_domain_prefixed_signature_bytes(
                &key,
                domain,
                "runalith.other.attestation.v1",
                unsigned,
                signature
            ),
            Err(DomainPrefixedSignatureError::InvalidProfile(_))
        ));

        for (field, wrong_value) in [
            ("schema_version", json!(2)),
            ("signature_algorithm", json!("RSA")),
            ("signature_encoding", json!("BASE64URL")),
            ("signed_bytes_profile", json!("UNPREFIXED-JCS-V1")),
        ] {
            let mut wrong_profile: Value = serde_json::from_slice(unsigned).unwrap();
            wrong_profile[field] = wrong_value;
            let wrong_profile = canonicalize(&wrong_profile).unwrap();
            assert!(
                matches!(
                    verify_domain_prefixed_signature_bytes(
                        &key,
                        domain,
                        domain,
                        wrong_profile.as_bytes(),
                        signature
                    ),
                    Err(DomainPrefixedSignatureError::InvalidProfile(_))
                ),
                "accepted mismatched profile field {field}"
            );
        }
    }

    #[test]
    fn rejects_duplicate_keys_signature_member_non_ascii_keys_and_tampering() {
        let (fixture, key) = verifier();
        let domain = fixture["domain_prefix_utf8"].as_str().unwrap();
        let kind = fixture["kind"].as_str().unwrap();
        let unsigned = fixture["canonical_unsigned_envelope_utf8"]
            .as_str()
            .unwrap();
        let signature = fixture["signature_base64"].as_str().unwrap();

        let duplicate = format!("{},\"kind\":\"{}\"}}", unsigned.trim_end_matches('}'), kind);
        assert!(matches!(
            verify_domain_prefixed_signature_bytes(
                &key,
                domain,
                kind,
                duplicate.as_bytes(),
                signature
            ),
            Err(DomainPrefixedSignatureError::CanonicalJson(_))
        ));

        let with_signature = format!(
            "{},\"signature\":\"{}\"}}",
            unsigned.trim_end_matches('}'),
            signature
        );
        assert!(matches!(
            verify_domain_prefixed_signature_bytes(
                &key,
                domain,
                kind,
                with_signature.as_bytes(),
                signature
            ),
            Err(DomainPrefixedSignatureError::InvalidProfile(_))
        ));

        let unicode_key = unsigned.replacen("\"kind\":", "\"kýnd\":", 1);
        assert!(matches!(
            verify_domain_prefixed_signature_bytes(
                &key,
                domain,
                kind,
                unicode_key.as_bytes(),
                signature
            ),
            Err(DomainPrefixedSignatureError::InvalidProfile(_))
        ));

        let mut tampered: Value = serde_json::from_str(unsigned).unwrap();
        tampered["scope"] = json!("unassigned.tampered.scope");
        let tampered_bytes = canonicalize(&tampered).unwrap();
        assert!(matches!(
            verify_domain_prefixed_signature_bytes(
                &key,
                domain,
                kind,
                tampered_bytes.as_bytes(),
                signature
            ),
            Err(DomainPrefixedSignatureError::SignatureInvalid)
        ));
    }

    #[test]
    fn rejects_noncanonical_signature_encoding_and_wrong_profile_labels() {
        let (fixture, key) = verifier();
        let domain = fixture["domain_prefix_utf8"].as_str().unwrap();
        let kind = fixture["kind"].as_str().unwrap();
        let unsigned = fixture["canonical_unsigned_envelope_utf8"]
            .as_str()
            .unwrap()
            .as_bytes();

        assert!(matches!(
            verify_domain_prefixed_signature_bytes(&key, "", kind, unsigned, "x"),
            Err(DomainPrefixedSignatureError::InvalidProfile(_))
        ));
        assert!(matches!(
            verify_domain_prefixed_signature_bytes(
                &key,
                domain,
                kind,
                unsigned,
                "not-canonical-base64"
            ),
            Err(DomainPrefixedSignatureError::Crypto(
                TrustCryptoError::InvalidBase64
            ))
        ));
    }

    #[test]
    fn rejects_untrusted_host_labels_and_oversized_envelopes_before_crypto() {
        let (fixture, key) = verifier();
        let valid_domain = fixture["domain_prefix_utf8"].as_str().unwrap();
        let valid_kind = fixture["kind"].as_str().unwrap();
        let unsigned = fixture["canonical_unsigned_envelope_utf8"]
            .as_str()
            .unwrap()
            .as_bytes();
        let signature = fixture["signature_base64"].as_str().unwrap();

        let invalid_labels = [
            " leading-space".to_owned(),
            "trailing-space ".to_owned(),
            "non-ascii-κ".to_owned(),
            "embedded\ncontrol".to_owned(),
            "x".repeat(257),
        ];
        for label in invalid_labels {
            assert!(
                matches!(
                    verify_domain_prefixed_signature_bytes(
                        &key, &label, &label, unsigned, signature
                    ),
                    Err(DomainPrefixedSignatureError::InvalidProfile(_))
                ),
                "accepted invalid host-pinned label {label:?}"
            );
        }

        assert!(matches!(
            verify_domain_prefixed_signature_bytes(
                &key,
                valid_domain,
                "different-kind",
                unsigned,
                signature
            ),
            Err(DomainPrefixedSignatureError::InvalidProfile(_))
        ));
        assert!(matches!(
            verify_domain_prefixed_signature_bytes(&key, valid_domain, valid_kind, b"", signature),
            Err(DomainPrefixedSignatureError::InvalidProfile(_))
        ));
        assert!(matches!(
            verify_domain_prefixed_signature_bytes(
                &key,
                valid_domain,
                valid_kind,
                b"[]",
                signature
            ),
            Err(DomainPrefixedSignatureError::InvalidProfile(_))
        ));

        let oversized_envelope = vec![b' '; MAX_JSON_BYTES + 1];
        assert!(matches!(
            verify_domain_prefixed_signature_bytes(
                &key,
                valid_domain,
                valid_kind,
                &oversized_envelope,
                signature
            ),
            Err(DomainPrefixedSignatureError::InvalidProfile(_))
        ));
    }
}
