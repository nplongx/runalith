//! Fail-closed Ed25519 public-key verification using the host OpenSSL CLI.
//!
//! No shell is involved. Public keys, messages and signatures are written to
//! private temporary files and passed as fixed command arguments. This is a
//! narrow trust boundary; administrator trust configuration, key rotation,
//! signed approval policy, maker/checker quorum, replay protection and
//! anti-rollback are implemented in separate modules with fail-closed APIs.

use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::process::{Command, Output, Stdio};

use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use thiserror::Error;

pub mod approval_decision;
pub mod approval_policy;
pub mod domain_prefixed_signature;
pub mod evidence_verification;
pub mod goal_evidence_subject_v2;
pub mod governance_receipt;
pub mod governance_service;
pub mod reviewer_attestation;
pub mod signed_envelope;
pub mod trust_config;
pub mod trust_ledger;
pub mod trust_lifecycle;
pub mod trust_snapshot;

/// Maximum accepted PEM input size.
pub const MAX_PUBLIC_KEY_PEM_BYTES: usize = 16 * 1024;
/// Maximum message size accepted by the verifier.
pub const MAX_SIGNED_MESSAGE_BYTES: usize = 1024 * 1024;
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];
const OPENSSL_BINARY: &str = "/usr/bin/openssl";

/// OpenSSL, key parsing, signature encoding or resource failure.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum TrustCryptoError {
    /// OpenSSL executable is unavailable.
    #[error("OpenSSL executable is unavailable")]
    OpenSslUnavailable,
    /// OpenSSL executable is not root-owned or is writable by group/other.
    #[error("OpenSSL executable is not a trusted root-owned system binary")]
    UntrustedOpenSslBinary,
    /// PEM could not be parsed as an Ed25519 SubjectPublicKeyInfo key.
    #[error("public key is not a valid Ed25519 PUBLIC KEY PEM")]
    InvalidPublicKey,
    /// Input exceeds a fixed resource bound.
    #[error("{0}")]
    InputLimit(&'static str),
    /// Signature encoding is not canonical standard Base64.
    #[error("signature is not canonical standard Base64")]
    InvalidBase64,
    /// Private temporary file creation or writing failed.
    #[error("private temporary-file operation failed: {0}")]
    TemporaryFile(String),
    /// OpenSSL could not perform the requested operation.
    #[error("OpenSSL operation failed: {0}")]
    OpenSslOperation(String),
}

/// Typed trust configuration, root, or ledger failure.
#[derive(Debug, Error)]
pub enum TrustError {
    /// Fail-closed protocol rejection with stable Node-compatible code.
    #[error("{code}: {message}")]
    Rejected {
        /// Stable protocol error code.
        code: &'static str,
        /// Bounded diagnostic.
        message: String,
    },
    /// Public-key parsing or signature primitive failed.
    #[error(transparent)]
    Crypto(#[from] TrustCryptoError),
    /// Trust-ledger SQLite operation failed.
    #[error("AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE: {0}")]
    Database(#[from] rusqlite::Error),
}

impl TrustError {
    /// Construct a stable fail-closed protocol rejection.
    pub fn rejected(code: &'static str, message: impl Into<String>) -> Self {
        Self::Rejected {
            code,
            message: message.into(),
        }
    }

    /// Stable error code for host status and audit records.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Rejected { code, .. } => code,
            Self::Crypto(TrustCryptoError::OpenSslUnavailable)
            | Self::Crypto(TrustCryptoError::UntrustedOpenSslBinary)
            | Self::Crypto(TrustCryptoError::TemporaryFile(_))
            | Self::Crypto(TrustCryptoError::OpenSslOperation(_)) => {
                "AGG_TRUST_CONFIG_OPENSSL_UNAVAILABLE"
            }
            Self::Crypto(_) => "AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID",
            Self::Database(_) => "AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE",
        }
    }
}

/// Parsed Ed25519 public key with its canonical SPKI fingerprint.
///
/// The PEM is public material. The object is immutable and performs no
/// trust-root provisioning or ledger writes.
#[derive(Debug, Clone)]
pub struct Ed25519PublicKey {
    pem: String,
    fingerprint: String,
}

impl Ed25519PublicKey {
    /// Parse a PEM public key and pin SHA-256 over canonical DER SPKI bytes.
    pub fn from_pem(pem: &str) -> Result<Self, TrustCryptoError> {
        if pem.is_empty() || pem.len() > MAX_PUBLIC_KEY_PEM_BYTES {
            return Err(TrustCryptoError::InputLimit(
                "public key PEM must be non-empty and within 16 KiB",
            ));
        }
        if !pem.contains("-----BEGIN PUBLIC KEY-----") {
            return Err(TrustCryptoError::InvalidPublicKey);
        }
        let key_file = write_private_temp(pem.as_bytes())?;
        let output = openssl_output([
            "pkey",
            "-pubin",
            "-in",
            key_file
                .path()
                .to_str()
                .ok_or(TrustCryptoError::InvalidPublicKey)?,
            "-pubout",
            "-outform",
            "DER",
        ])?;
        if !output.status.success() {
            return Err(map_public_key_parse_failure(&output.stderr));
        }
        let der = output.stdout;
        if der.len() != ED25519_SPKI_PREFIX.len() + 32 || !der.starts_with(&ED25519_SPKI_PREFIX) {
            return Err(TrustCryptoError::InvalidPublicKey);
        }
        let fingerprint = hex::encode(Sha256::digest(&der));
        Ok(Self {
            pem: pem.to_owned(),
            fingerprint,
        })
    }

    /// SHA-256 of canonical Ed25519 SubjectPublicKeyInfo DER.
    #[must_use]
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    /// Verify a raw Ed25519 signature. Invalid signatures return false.
    pub fn verify(&self, message: &[u8], signature: &[u8]) -> Result<bool, TrustCryptoError> {
        if message.len() > MAX_SIGNED_MESSAGE_BYTES {
            return Err(TrustCryptoError::InputLimit(
                "signed message exceeds the 1 MiB limit",
            ));
        }
        // OpenSSL pkeyutl does not support a zero-byte one-shot input buffer;
        // AGG signed envelopes are always non-empty canonical JSON documents.
        if message.is_empty() || signature.len() != 64 {
            return Ok(false);
        }
        let key_file = write_private_temp(self.pem.as_bytes())?;
        let message_file = write_private_temp(message)?;
        let signature_file = write_private_temp(signature)?;
        let output = openssl_output([
            "pkeyutl",
            "-verify",
            "-pubin",
            "-inkey",
            key_file
                .path()
                .to_str()
                .ok_or(TrustCryptoError::InvalidPublicKey)?,
            "-rawin",
            "-in",
            message_file
                .path()
                .to_str()
                .ok_or(TrustCryptoError::InvalidPublicKey)?,
            "-sigfile",
            signature_file
                .path()
                .to_str()
                .ok_or(TrustCryptoError::InvalidPublicKey)?,
        ])?;
        classify_signature_verification_output(output.status.code(), &output.stdout)
    }

    /// Strictly decode canonical standard Base64 and verify the signature.
    pub fn verify_base64(
        &self,
        message: &[u8],
        signature_base64: &str,
    ) -> Result<bool, TrustCryptoError> {
        if signature_base64.len() != 88 {
            return Err(TrustCryptoError::InvalidBase64);
        }
        let signature = decode_base64(signature_base64)?;
        self.verify(message, &signature)
    }
}

fn write_private_temp(bytes: &[u8]) -> Result<NamedTempFile, TrustCryptoError> {
    let mut file =
        NamedTempFile::new().map_err(|error| TrustCryptoError::TemporaryFile(error.to_string()))?;
    file.write_all(bytes)
        .and_then(|()| file.flush())
        .map_err(|error| TrustCryptoError::TemporaryFile(error.to_string()))?;
    Ok(file)
}

fn map_public_key_parse_failure(stderr: &[u8]) -> TrustCryptoError {
    // OpenSSL 3 reports malformed public-key material with this stable CLI
    // prefix. Other non-zero parser outcomes are operationally ambiguous (for
    // example, an input file that could not be opened) and must not condemn the
    // submitted key. Never retain the diagnostic because it can contain paths.
    const INVALID_PUBLIC_KEY_PREFIX: &[u8] = b"Could not find private key of Public Key from ";
    if stderr
        .windows(INVALID_PUBLIC_KEY_PREFIX.len())
        .any(|window| window == INVALID_PUBLIC_KEY_PREFIX)
    {
        TrustCryptoError::InvalidPublicKey
    } else {
        TrustCryptoError::OpenSslOperation(
            "OpenSSL public-key parser returned an operational failure".into(),
        )
    }
}

fn classify_signature_verification_output(
    exit_code: Option<i32>,
    stdout: &[u8],
) -> Result<bool, TrustCryptoError> {
    match exit_code {
        Some(0) => Ok(true),
        Some(1)
            if stdout == b"Signature Verification Failure\n"
                || stdout == b"Signature Verification Failure" =>
        {
            Ok(false)
        }
        _ => Err(TrustCryptoError::OpenSslOperation(
            "OpenSSL signature-verification command returned an operational failure".into(),
        )),
    }
}

fn openssl_output<const N: usize>(args: [&str; N]) -> Result<Output, TrustCryptoError> {
    let metadata =
        std::fs::metadata(OPENSSL_BINARY).map_err(|_| TrustCryptoError::OpenSslUnavailable)?;
    if !metadata.is_file() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
        return Err(TrustCryptoError::UntrustedOpenSslBinary);
    }
    let mut command = Command::new(OPENSSL_BINARY);
    command
        .args(args)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
        .output()
        .map_err(|error| TrustCryptoError::OpenSslOperation(error.to_string()))
}

fn decode_base64(input: &str) -> Result<Vec<u8>, TrustCryptoError> {
    if input.is_empty() || input.len() % 4 != 0 {
        return Err(TrustCryptoError::InvalidBase64);
    }
    let mut output = Vec::with_capacity(input.len() / 4 * 3);
    let chunks = input.as_bytes().chunks_exact(4);
    let chunk_count = input.len() / 4;
    for (index, chunk) in chunks.enumerate() {
        let final_chunk = index + 1 == chunk_count;
        let a = base64_value(chunk[0]).ok_or(TrustCryptoError::InvalidBase64)?;
        let b = base64_value(chunk[1]).ok_or(TrustCryptoError::InvalidBase64)?;
        let c = if chunk[2] == b'=' {
            None
        } else {
            Some(base64_value(chunk[2]).ok_or(TrustCryptoError::InvalidBase64)?)
        };
        let d = if chunk[3] == b'=' {
            None
        } else {
            Some(base64_value(chunk[3]).ok_or(TrustCryptoError::InvalidBase64)?)
        };
        output.push((a << 2) | (b >> 4));
        match (c, d) {
            (None, None) if final_chunk && b & 0x0f == 0 => {}
            (Some(c), None) if final_chunk && c & 0x03 == 0 => {
                output.push((b << 4) | (c >> 2));
            }
            (Some(c), Some(d)) => {
                output.push((b << 4) | (c >> 2));
                output.push((c << 6) | d);
            }
            _ => return Err(TrustCryptoError::InvalidBase64),
        }
    }
    Ok(output)
}

fn base64_value(value: u8) -> Option<u8> {
    match value {
        b'A'..=b'Z' => Some(value - b'A'),
        b'a'..=b'z' => Some(value - b'a' + 26),
        b'0'..=b'9' => Some(value - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RFC8032_PUBLIC_KEY: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAPUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=\n-----END PUBLIC KEY-----\n";
    fn signature() -> Vec<u8> {
        hex::decode(
            "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
        )
        .unwrap()
    }

    #[test]
    fn trust_error_codes_keep_crypto_runtime_faults_out_of_invalid_public_key() {
        for error in [
            TrustCryptoError::OpenSslUnavailable,
            TrustCryptoError::UntrustedOpenSslBinary,
            TrustCryptoError::TemporaryFile("private temp storage unavailable".into()),
            TrustCryptoError::OpenSslOperation("OpenSSL process could not execute".into()),
        ] {
            assert_eq!(
                TrustError::from(error).code(),
                "AGG_TRUST_CONFIG_OPENSSL_UNAVAILABLE"
            );
        }

        for error in [
            TrustCryptoError::InvalidPublicKey,
            TrustCryptoError::InvalidBase64,
            TrustCryptoError::InputLimit("input exceeds the configured bound"),
        ] {
            assert_eq!(
                TrustError::from(error).code(),
                "AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID"
            );
        }
    }

    #[test]
    fn rfc8032_ed25519_vector_verifies_and_fingerprint_matches_spki() {
        let key = Ed25519PublicKey::from_pem(RFC8032_PUBLIC_KEY).unwrap();
        assert_eq!(
            key.fingerprint(),
            "deb2ded39dc26fce0e6085b6fc34bf6b5941913bbfe2ea614113cff9e004c170"
        );
        assert!(key.verify(b"r", &signature()).unwrap());
        assert!(!key.verify(b"x", &signature()).unwrap());
        let mut altered = signature();
        altered[0] ^= 1;
        assert!(!key.verify(b"r", &altered).unwrap());
    }

    #[test]
    fn standard_base64_signature_verifies_and_noncanonical_encodings_fail() {
        let key = Ed25519PublicKey::from_pem(RFC8032_PUBLIC_KEY).unwrap();
        assert!(key
            .verify_base64(
                b"r",
                "kqAJqfDUyrhyDoILX2QlQKKye1QWUD+Ps3YiI+vbadoIWsHkPhWZbkWPNhPQ8R2MOHsurrQwKu6wDSkWErsMAA=="
            )
            .unwrap());
        assert_eq!(
            decode_base64("a===").unwrap_err(),
            TrustCryptoError::InvalidBase64
        );
        assert_eq!(
            decode_base64("ab=c").unwrap_err(),
            TrustCryptoError::InvalidBase64
        );
        assert_eq!(
            decode_base64("Zh==").unwrap_err(),
            TrustCryptoError::InvalidBase64
        );
        let key = Ed25519PublicKey::from_pem(RFC8032_PUBLIC_KEY).unwrap();
        assert_eq!(
            key.verify_base64(b"r", &"A".repeat(1_000_000)).unwrap_err(),
            TrustCryptoError::InvalidBase64
        );
    }

    #[test]
    fn malformed_and_non_ed25519_public_keys_fail_closed() {
        assert_eq!(
            Ed25519PublicKey::from_pem("not a key").unwrap_err(),
            TrustCryptoError::InvalidPublicKey
        );
        assert_eq!(
            Ed25519PublicKey::from_pem("").unwrap_err(),
            TrustCryptoError::InputLimit("public key PEM must be non-empty and within 16 KiB")
        );
        assert_eq!(
            Ed25519PublicKey::from_pem(
                "-----BEGIN PUBLIC KEY-----\nnot-base64\n-----END PUBLIC KEY-----\n"
            )
            .unwrap_err(),
            TrustCryptoError::InvalidPublicKey
        );
    }

    #[test]
    fn openssl_key_parse_and_signature_exit_codes_fail_closed_when_operationally_ambiguous() {
        assert_eq!(
            map_public_key_parse_failure(
                b"Could not find private key of Public Key from /tmp/private/key.pem\n"
            ),
            TrustCryptoError::InvalidPublicKey
        );
        let operational_parse_error = map_public_key_parse_failure(
            b"Could not open file or uri /private/secret/key.pem: Permission denied\n",
        );
        assert_eq!(
            operational_parse_error,
            TrustCryptoError::OpenSslOperation(
                "OpenSSL public-key parser returned an operational failure".into()
            )
        );
        assert!(
            !operational_parse_error
                .to_string()
                .contains("/private/secret")
        );

        assert_eq!(
            classify_signature_verification_output(Some(1), b"Signature Verification Failure\n"),
            Ok(false)
        );
        for (exit_code, stdout) in [
            (Some(1), b"".as_slice()),
            (Some(1), b"provider failed".as_slice()),
            (Some(2), b"Signature Verification Failure\n".as_slice()),
            (None, b"Signature Verification Failure\n".as_slice()),
        ] {
            assert!(matches!(
                classify_signature_verification_output(exit_code, stdout),
                Err(TrustCryptoError::OpenSslOperation(_))
            ));
        }
    }

    #[test]
    fn invalid_signature_length_and_empty_message_never_verify() {
        let key = Ed25519PublicKey::from_pem(RFC8032_PUBLIC_KEY).unwrap();
        assert!(!key.verify(b"r", &[0; 63]).unwrap());
        assert!(!key.verify(b"", &signature()).unwrap());
    }
}
