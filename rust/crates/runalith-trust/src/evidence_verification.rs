//! Governance-owned validation of independently signed Goal/Idea evidence receipts.
//!
//! The verifier consumes only a typed, exact-snapshot receipt. It does not
//! resolve source URIs or infer producer lineage. Callers must supply the
//! already-computed manifest binding from an authenticated source-resolution
//! path and a durable nonce ledger owned by Governance.

use chrono::{DateTime, SecondsFormat, Utc};
use runalith_protocol::evidence_verification_v1::{
    EVIDENCE_VERIFICATION_KIND, EVIDENCE_VERIFICATION_SCOPE, EvidenceClaimStatus,
    EvidenceVerificationContractError, EvidenceVerificationReceiptV1,
    EvidenceVerificationSubjectV1,
};
use sha2::{Digest, Sha256};

use crate::signed_envelope::verify_observed_signed_envelope;
use crate::trust_config::TrustConfiguration;
use crate::trust_ledger::TrustConfigurationObserver;
use crate::{TrustCryptoError, TrustError};

/// Classification of a Governance evidence-verification failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceVerificationFailureClass {
    /// Required trust, crypto runtime or durable replay authority is unavailable.
    Unavailable,
    /// The receipt is malformed, stale, misbound, incorrectly signed or replayed.
    Invalid,
    /// The configured trust identity or authority is not permitted for this operation.
    Unauthorized,
}

/// Stable failure returned by the evidence-verification interface.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceVerificationFailure {
    /// Stable failure classification.
    pub class: EvidenceVerificationFailureClass,
    /// Stable machine-readable failure code.
    pub code: &'static str,
}

/// Durable nonce-consumption port for Governance evidence verification.
///
/// Implementations must atomically insert a globally unique nonce and bind it
/// to both the complete signed-receipt digest and exact subject digest. The
/// insertion must survive process restart and must not be backed by an
/// in-memory-only set. This crate intentionally supplies no production adapter:
/// the Governance host must compose the port with its approved owned store.
pub trait EvidenceVerificationNonceLedger: Send + Sync {
    /// Atomically bind one nonce to this receipt and immutable subject.
    ///
    /// A newly inserted binding returns `Consumed`. An existing byte-identical
    /// receipt/subject binding returns `ExactReplay` so callers can safely
    /// implement the Node reference's exact-retry idempotency. Reuse of the
    /// nonce for any different receipt or subject must return `BindingConflict`.
    fn consume_once(
        &self,
        nonce: &str,
        receipt_sha256: &str,
        subject_sha256: &str,
    ) -> Result<EvidenceVerificationNonceLedgerDisposition, EvidenceVerificationNonceLedgerError>;
}

/// Result of atomically binding a nonce to a receipt and immutable subject.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceVerificationNonceLedgerDisposition {
    /// This call inserted the first durable binding for the nonce.
    Consumed,
    /// The exact same receipt and subject were already durably consumed.
    ExactReplay,
}

/// Failure from the durable evidence-verification nonce ledger.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceVerificationNonceLedgerError {
    /// The durable ledger could not be reached or committed.
    Unavailable,
    /// The nonce already exists but is bound to different receipt or subject bytes.
    BindingConflict,
}

/// Authenticated and replay-checked evidence receipt suitable for binding to GraphEvidence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedEvidenceVerificationReceipt {
    /// Independent verifier decision.
    claim_status: EvidenceClaimStatus,
    /// Stable verifier identity derived from configured provider and trusted key ID.
    verifier_id: String,
    /// SHA-256 of canonical complete signed receipt bytes.
    verification_receipt_sha256: String,
    /// Stable Node-compatible durable attestation identity.
    attestation_id: String,
    /// Configured public trust-root fingerprint.
    trust_root_sha256: String,
    /// Configured trusted public-key identity.
    trust_key_id: String,
    /// One-use receipt nonce.
    nonce: String,
    /// Signed issuance timestamp in Unix milliseconds.
    issued_at_ms: i64,
    /// Signed expiry timestamp in Unix milliseconds.
    expires_at_ms: i64,
    /// Exact immutable graph snapshot digest.
    snapshot_sha256: String,
    /// Exact normalized evidence-manifest digest.
    evidence_manifest_sha256: String,
}

impl VerifiedEvidenceVerificationReceipt {
    /// Signed independent claim decision.
    #[must_use]
    pub const fn claim_status(&self) -> EvidenceClaimStatus {
        self.claim_status
    }

    /// Verifier identity derived from the configured provider and verified key ID.
    #[must_use]
    pub fn verifier_id(&self) -> &str {
        &self.verifier_id
    }

    /// SHA-256 of the complete canonical signed receipt.
    #[must_use]
    pub fn verification_receipt_sha256(&self) -> &str {
        &self.verification_receipt_sha256
    }

    /// Node-compatible stable durable attestation identity.
    #[must_use]
    pub fn attestation_id(&self) -> &str {
        &self.attestation_id
    }

    /// Fingerprint of the exact observed trust root used for signature verification.
    #[must_use]
    pub fn trust_root_sha256(&self) -> &str {
        &self.trust_root_sha256
    }

    /// Key ID selected from the authenticated trust configuration.
    #[must_use]
    pub fn trust_key_id(&self) -> &str {
        &self.trust_key_id
    }

    /// One-use signed nonce.
    #[must_use]
    pub fn nonce(&self) -> &str {
        &self.nonce
    }

    /// Signed issuance time in Unix milliseconds.
    #[must_use]
    pub const fn issued_at_ms(&self) -> i64 {
        self.issued_at_ms
    }

    /// Signed expiry time in Unix milliseconds.
    #[must_use]
    pub const fn expires_at_ms(&self) -> i64 {
        self.expires_at_ms
    }

    /// Immutable graph snapshot digest covered by the receipt.
    #[must_use]
    pub fn snapshot_sha256(&self) -> &str {
        &self.snapshot_sha256
    }

    /// Exact normalized evidence-manifest digest covered by the receipt.
    #[must_use]
    pub fn evidence_manifest_sha256(&self) -> &str {
        &self.evidence_manifest_sha256
    }
}

/// Verify a signed receipt against the current snapshot, observed trust roots and durable replay ledger.
///
/// The function returns a verified receipt only after all of the following:
/// typed closed-schema validation, exact snapshot/manifest binding, freshness,
/// explicit trust high-water observation, Ed25519 signature verification, and
/// atomic durable nonce consumption. A missing nonce ledger always fails closed.
pub fn verify_knowledge_graph_evidence_receipt(
    configuration: &TrustConfiguration,
    observer: &dyn TrustConfigurationObserver,
    receipt: &EvidenceVerificationReceiptV1,
    subject: &EvidenceVerificationSubjectV1,
    now_ms: i64,
    nonce_ledger: Option<&dyn EvidenceVerificationNonceLedger>,
) -> Result<VerifiedEvidenceVerificationReceipt, EvidenceVerificationFailure> {
    if now_ms < 0 || now_ms as u64 > 9_007_199_254_740_991 {
        return Err(failure(
            EvidenceVerificationFailureClass::Invalid,
            "KNOWLEDGE_ATTESTATION_CLOCK_INVALID",
        ));
    }
    let now = DateTime::<Utc>::from_timestamp_millis(now_ms)
        .ok_or_else(|| {
            failure(
                EvidenceVerificationFailureClass::Invalid,
                "KNOWLEDGE_ATTESTATION_CLOCK_INVALID",
            )
        })?
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    receipt
        .validate_for(subject, &now)
        .map_err(map_contract_error)?;

    let Some(nonce_ledger) = nonce_ledger else {
        return Err(failure(
            EvidenceVerificationFailureClass::Unavailable,
            "KNOWLEDGE_EVIDENCE_NONCE_LEDGER_UNAVAILABLE",
        ));
    };

    let envelope = serde_json::to_value(receipt).map_err(|_| {
        failure(
            EvidenceVerificationFailureClass::Invalid,
            "KNOWLEDGE_ATTESTATION_JSON_INVALID",
        )
    })?;
    let verified = verify_observed_signed_envelope(
        configuration,
        observer,
        &envelope,
        EVIDENCE_VERIFICATION_SCOPE,
        EVIDENCE_VERIFICATION_KIND,
        now_ms,
    )
    .map_err(map_trust_error)?;
    let receipt_sha256 = receipt.canonical_sha256().map_err(map_contract_error)?;
    if verified.signed_envelope_hash != receipt_sha256
        || verified.nonce != receipt.nonce
        || verified.trust_root_sha256 != receipt.trust_root_sha256
    {
        return Err(failure(
            EvidenceVerificationFailureClass::Invalid,
            "KNOWLEDGE_ATTESTATION_RECEIPT_DIGEST_MISMATCH",
        ));
    }
    let verifier_id = receipt
        .verifier_identity(&verified.key_id)
        .map_err(map_contract_error)?;
    let subject_value = serde_json::to_value(subject).map_err(|_| {
        failure(
            EvidenceVerificationFailureClass::Invalid,
            "KNOWLEDGE_ATTESTATION_BINDING_INVALID",
        )
    })?;
    let canonical_subject = runalith_protocol::agg_checkpoint_v2::canonicalize(&subject_value)
        .map_err(|_| {
            failure(
                EvidenceVerificationFailureClass::Invalid,
                "KNOWLEDGE_ATTESTATION_BINDING_INVALID",
            )
        })?;
    let subject_sha256 = hex::encode(Sha256::digest(canonical_subject.as_bytes()));

    match nonce_ledger.consume_once(&receipt.nonce, &receipt_sha256, &subject_sha256) {
        Ok(
            EvidenceVerificationNonceLedgerDisposition::Consumed
            | EvidenceVerificationNonceLedgerDisposition::ExactReplay,
        ) => {}
        Err(EvidenceVerificationNonceLedgerError::BindingConflict) => {
            return Err(failure(
                EvidenceVerificationFailureClass::Invalid,
                "KNOWLEDGE_ATTESTATION_NONCE_REPLAY",
            ));
        }
        Err(EvidenceVerificationNonceLedgerError::Unavailable) => {
            return Err(failure(
                EvidenceVerificationFailureClass::Unavailable,
                "KNOWLEDGE_EVIDENCE_NONCE_LEDGER_UNAVAILABLE",
            ));
        }
    }

    Ok(VerifiedEvidenceVerificationReceipt {
        claim_status: receipt.claim_status,
        verifier_id,
        verification_receipt_sha256: receipt_sha256,
        attestation_id: receipt.attestation_id().map_err(map_contract_error)?,
        trust_root_sha256: verified.trust_root_sha256,
        trust_key_id: verified.key_id,
        nonce: verified.nonce,
        issued_at_ms: verified.issued_at_ms,
        expires_at_ms: verified.expires_at_ms,
        snapshot_sha256: subject.snapshot_hash.clone(),
        evidence_manifest_sha256: subject.evidence_manifest_hash.clone(),
    })
}

fn failure(
    class: EvidenceVerificationFailureClass,
    code: &'static str,
) -> EvidenceVerificationFailure {
    EvidenceVerificationFailure { class, code }
}

fn map_contract_error(error: EvidenceVerificationContractError) -> EvidenceVerificationFailure {
    use EvidenceVerificationContractError as ContractError;
    let code = match error {
        ContractError::BindingMismatch => "KNOWLEDGE_ATTESTATION_SNAPSHOT_MISMATCH",
        ContractError::IndependenceNotVerified => "KNOWLEDGE_INDEPENDENCE_NOT_VERIFIED",
        ContractError::InvalidFreshness => "KNOWLEDGE_ATTESTATION_FRESHNESS_INVALID",
        ContractError::ExpiredOrFutureDated => "KNOWLEDGE_ATTESTATION_EXPIRED",
        ContractError::InvalidField("nonce") => "KNOWLEDGE_ATTESTATION_NONCE_INVALID",
        ContractError::InvalidField("signature") => "KNOWLEDGE_ATTESTATION_SIGNATURE_INVALID",
        ContractError::InvalidField(_) => "KNOWLEDGE_ATTESTATION_BINDING_INVALID",
    };
    failure(EvidenceVerificationFailureClass::Invalid, code)
}

fn map_trust_error(error: TrustError) -> EvidenceVerificationFailure {
    // A temporary-file or OpenSSL execution failure is an unavailable verifier
    // runtime, not evidence that the submitted signature or public key is bad.
    // Keep malformed/invalid key material on the existing Invalid path.
    let operational_crypto_failure = matches!(
        &error,
        TrustError::Crypto(
            TrustCryptoError::TemporaryFile(_) | TrustCryptoError::OpenSslOperation(_)
        )
    );
    let code = error.code();
    if operational_crypto_failure || code.contains("UNAVAILABLE") || code.contains("OPENSSL") {
        failure(
            EvidenceVerificationFailureClass::Unavailable,
            "KNOWLEDGE_EVIDENCE_VERIFIER_UNAVAILABLE",
        )
    } else if code.contains("TRUST_ROOT")
        || code == "AGG_TRUST_CONFIG_NOT_OBSERVED"
        || code.contains("TRUST_CONFIG_ROLLBACK")
        || code.contains("TRUST_CONFIG_VERSION")
    {
        failure(
            EvidenceVerificationFailureClass::Unauthorized,
            "KNOWLEDGE_EVIDENCE_VERIFIER_UNAUTHORIZED",
        )
    } else {
        failure(
            EvidenceVerificationFailureClass::Invalid,
            "KNOWLEDGE_ATTESTATION_SIGNATURE_INVALID",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use runalith_protocol::evidence_verification_v1::{
        EVIDENCE_VERIFICATION_KIND, EVIDENCE_VERIFICATION_SCOPE, EvidenceClaimStatus,
        EvidenceIndependenceStatus, EvidenceVerificationReceiptV1, EvidenceVerificationSubjectV1,
    };
    use serde_json::Value;
    use std::{collections::HashMap, fs, path::PathBuf, process::Command, sync::Mutex};
    use tempfile::TempDir;

    const TEST_NOW_MS: i64 = 1_793_610_600_000;

    struct TestSigningKey {
        _directory: TempDir,
        private_path: PathBuf,
        public_pem: String,
        fingerprint: String,
    }

    #[derive(Default)]
    struct TestNonceLedger(Mutex<HashMap<String, (String, String)>>);

    impl EvidenceVerificationNonceLedger for TestNonceLedger {
        fn consume_once(
            &self,
            nonce: &str,
            receipt_sha256: &str,
            subject_sha256: &str,
        ) -> Result<EvidenceVerificationNonceLedgerDisposition, EvidenceVerificationNonceLedgerError>
        {
            let mut consumed = self
                .0
                .lock()
                .map_err(|_| EvidenceVerificationNonceLedgerError::Unavailable)?;
            let binding = (receipt_sha256.to_owned(), subject_sha256.to_owned());
            if let Some(existing) = consumed.get(nonce) {
                return if existing == &binding {
                    Ok(EvidenceVerificationNonceLedgerDisposition::ExactReplay)
                } else {
                    Err(EvidenceVerificationNonceLedgerError::BindingConflict)
                };
            }
            consumed.insert(nonce.to_owned(), binding);
            Ok(EvidenceVerificationNonceLedgerDisposition::Consumed)
        }
    }

    fn subject() -> EvidenceVerificationSubjectV1 {
        EvidenceVerificationSubjectV1 {
            goal_id: "goal-1".into(),
            snapshot_hash: "a".repeat(64),
            node_ids: vec!["node-a".into()],
            edge_ids: vec!["edge-a".into()],
            membership_ids: vec!["membership-a".into()],
            evidence_manifest_hash: "b".repeat(64),
        }
    }

    fn receipt() -> EvidenceVerificationReceiptV1 {
        EvidenceVerificationReceiptV1 {
            schema_version: 1,
            kind: EVIDENCE_VERIFICATION_KIND.into(),
            provider_id: "independent-verifier".into(),
            trust_root_sha256: "c".repeat(64),
            nonce: "d4e5f6a7-1234-4abc-8def-1234567890ab".into(),
            issued_at: "2026-11-02T09:00:00.000Z".into(),
            expires_at: "2026-11-02T09:20:00.000Z".into(),
            scope: EVIDENCE_VERIFICATION_SCOPE.into(),
            goal_id: "goal-1".into(),
            snapshot_hash: "a".repeat(64),
            node_ids: vec!["node-a".into()],
            edge_ids: vec!["edge-a".into()],
            membership_ids: vec!["membership-a".into()],
            evidence_manifest_hash: "b".repeat(64),
            claim_status: EvidenceClaimStatus::Verified,
            independence_status: EvidenceIndependenceStatus::Verified,
            signature_algorithm: "Ed25519".into(),
            signature: "A".repeat(88),
        }
    }

    fn test_configuration() -> TrustConfiguration {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/trust-signed-envelope-v1-node.json"
        ))
        .unwrap();
        TrustConfiguration::load_json(
            fixture["trust_config_json"].as_str().unwrap().as_bytes(),
            "execution_approval_policy",
            "agg.approval.policy",
            1_793_491_200_000,
        )
        .unwrap()
    }

    fn test_signing_key() -> TestSigningKey {
        let directory = tempfile::tempdir().unwrap();
        let private_path = directory.path().join("evidence-verifier-private.pem");
        let public_path = directory.path().join("evidence-verifier-public.pem");
        let public_der_path = directory.path().join("evidence-verifier-public.der");

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
        let der = Command::new("/usr/bin/openssl")
            .args(["pkey", "-pubin", "-in"])
            .arg(&public_path)
            .args(["-outform", "DER", "-out"])
            .arg(&public_der_path)
            .output()
            .unwrap();
        assert!(
            der.status.success(),
            "{}",
            String::from_utf8_lossy(&der.stderr)
        );

        TestSigningKey {
            public_pem: fs::read_to_string(&public_path).unwrap(),
            fingerprint: hex::encode(Sha256::digest(fs::read(public_der_path).unwrap())),
            _directory: directory,
            private_path,
        }
    }

    fn configuration_for(key: &TestSigningKey) -> TrustConfiguration {
        let configuration = serde_json::json!({
            "schema_version":1,
            "domain":"goal_idea_verifier",
            "provider_id":"independent-verifier",
            "config_version":1,
            "updated_at":"2026-11-02T09:00:00.000Z",
            "updated_by":"test-only-security-admin",
            "change_reference":"TEST-EVIDENCE-VERIFIER-001",
            "keys":[{
                "key_id":"test-evidence-verifier-key",
                "public_key_pem":key.public_pem,
                "scopes":[EVIDENCE_VERIFICATION_SCOPE],
                "not_before":"2026-11-02T08:00:00.000Z",
                "not_after":null,
                "revoked_at":null
            }]
        });
        TrustConfiguration::load_json(
            &serde_json::to_vec(&configuration).unwrap(),
            "goal_idea_verifier",
            EVIDENCE_VERIFICATION_SCOPE,
            TEST_NOW_MS,
        )
        .unwrap()
    }

    fn sign_receipt(
        key: &TestSigningKey,
        claim_status: EvidenceClaimStatus,
        nonce: &str,
        label: &str,
    ) -> EvidenceVerificationReceiptV1 {
        let mut receipt = receipt();
        receipt.claim_status = claim_status;
        receipt.nonce = nonce.to_owned();
        receipt.trust_root_sha256 = key.fingerprint.clone();

        let mut unsigned = serde_json::to_value(&receipt).unwrap();
        unsigned.as_object_mut().unwrap().remove("signature");
        let canonical = runalith_protocol::agg_checkpoint_v2::canonicalize(&unsigned).unwrap();
        let directory = key._directory.path();
        let message_path = directory.join(format!("{label}.message"));
        let signature_path = directory.join(format!("{label}.signature"));
        fs::write(&message_path, canonical).unwrap();
        let signed = Command::new("/usr/bin/openssl")
            .args(["pkeyutl", "-sign", "-inkey"])
            .arg(&key.private_path)
            .args(["-rawin", "-in"])
            .arg(&message_path)
            .args(["-out"])
            .arg(&signature_path)
            .output()
            .unwrap();
        assert!(
            signed.status.success(),
            "{}",
            String::from_utf8_lossy(&signed.stderr)
        );
        receipt.signature = standard_base64(&fs::read(signature_path).unwrap());
        receipt
    }

    fn standard_base64(bytes: &[u8]) -> String {
        const TABLE: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
        for chunk in bytes.chunks(3) {
            let first = chunk[0];
            let second = *chunk.get(1).unwrap_or(&0);
            let third = *chunk.get(2).unwrap_or(&0);
            encoded.push(TABLE[(first >> 2) as usize] as char);
            encoded.push(TABLE[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
            encoded.push(if chunk.len() > 1 {
                TABLE[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char
            } else {
                '='
            });
            encoded.push(if chunk.len() > 2 {
                TABLE[(third & 0x3f) as usize] as char
            } else {
                '='
            });
        }
        encoded
    }

    #[test]
    fn node_generated_signed_knowledge_attestation_fixture_verifies_exact_bytes_and_bindings() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/knowledge-attestation-v1-node.json"
        ))
        .unwrap();
        let now = DateTime::parse_from_rfc3339(fixture["now"].as_str().unwrap())
            .unwrap()
            .timestamp_millis();
        let configuration = TrustConfiguration::load_json(
            fixture["trust_config_json"].as_str().unwrap().as_bytes(),
            "goal_idea_verifier",
            EVIDENCE_VERIFICATION_SCOPE,
            now,
        )
        .unwrap();
        let observer = crate::trust_ledger::TrustLedger::in_memory().unwrap();
        observer.record(&configuration, now).unwrap();
        let receipt: EvidenceVerificationReceiptV1 =
            serde_json::from_str(fixture["receipt_json"].as_str().unwrap()).unwrap();
        let subject: EvidenceVerificationSubjectV1 =
            serde_json::from_str(fixture["subject_json"].as_str().unwrap()).unwrap();

        let mut unsigned = serde_json::to_value(&receipt).unwrap();
        unsigned.as_object_mut().unwrap().remove("signature");
        assert_eq!(
            runalith_protocol::agg_checkpoint_v2::canonicalize(&unsigned).unwrap(),
            fixture["signature_input_json"].as_str().unwrap()
        );
        assert_eq!(
            receipt.canonical_sha256().unwrap(),
            fixture["receipt_sha256"].as_str().unwrap()
        );
        assert_eq!(
            receipt.attestation_id().unwrap(),
            fixture["attestation_id"].as_str().unwrap()
        );
        let subject_value = serde_json::to_value(&subject).unwrap();
        let canonical_subject =
            runalith_protocol::agg_checkpoint_v2::canonicalize(&subject_value).unwrap();
        assert_eq!(
            hex::encode(Sha256::digest(canonical_subject.as_bytes())),
            fixture["subject_sha256"].as_str().unwrap()
        );

        let nonce_ledger = TestNonceLedger::default();
        let verified = verify_knowledge_graph_evidence_receipt(
            &configuration,
            &observer,
            &receipt,
            &subject,
            now,
            Some(&nonce_ledger),
        )
        .unwrap();
        assert_eq!(verified.claim_status(), EvidenceClaimStatus::Verified);
        assert_eq!(
            verified.verifier_id(),
            fixture["verifier_id"].as_str().unwrap()
        );
        assert_eq!(
            verified.trust_root_sha256(),
            fixture["trust_root_sha256"].as_str().unwrap()
        );
        assert_eq!(
            verified.verification_receipt_sha256(),
            fixture["receipt_sha256"].as_str().unwrap()
        );
        assert_eq!(
            verified.attestation_id(),
            fixture["attestation_id"].as_str().unwrap()
        );
        assert_eq!(verified.snapshot_sha256(), subject.snapshot_hash);
        assert_eq!(
            verified.evidence_manifest_sha256(),
            subject.evidence_manifest_hash
        );

        let exact_replay = verify_knowledge_graph_evidence_receipt(
            &configuration,
            &observer,
            &receipt,
            &subject,
            now,
            Some(&nonce_ledger),
        )
        .unwrap();
        assert_eq!(exact_replay, verified);
    }

    #[test]
    fn evidence_verification_missing_durable_nonce_ledger_is_unavailable() {
        let configuration = test_configuration();
        let observer = crate::trust_ledger::TrustLedger::in_memory().unwrap();

        let failure = verify_knowledge_graph_evidence_receipt(
            &configuration,
            &observer,
            &receipt(),
            &subject(),
            DateTime::parse_from_rfc3339("2026-11-02T09:10:00.000Z")
                .unwrap()
                .timestamp_millis(),
            None,
        )
        .unwrap_err();

        assert_eq!(failure.class, EvidenceVerificationFailureClass::Unavailable);
        assert_eq!(failure.code, "KNOWLEDGE_EVIDENCE_NONCE_LEDGER_UNAVAILABLE");
    }

    #[test]
    fn maps_crypto_runtime_failures_to_unavailable_but_keeps_bad_keys_invalid() {
        for error in [
            TrustError::Crypto(TrustCryptoError::OpenSslUnavailable),
            TrustError::Crypto(TrustCryptoError::UntrustedOpenSslBinary),
            TrustError::Crypto(TrustCryptoError::TemporaryFile(
                "temporary file creation failed".into(),
            )),
            TrustError::Crypto(TrustCryptoError::OpenSslOperation(
                "OpenSSL verification process failed to execute".into(),
            )),
        ] {
            let failure = map_trust_error(error);
            assert_eq!(failure.class, EvidenceVerificationFailureClass::Unavailable);
            assert_eq!(failure.code, "KNOWLEDGE_EVIDENCE_VERIFIER_UNAVAILABLE");
        }

        for error in [
            TrustCryptoError::InvalidPublicKey,
            TrustCryptoError::InvalidBase64,
            TrustCryptoError::InputLimit("signature input exceeds the test limit"),
        ] {
            let invalid = map_trust_error(TrustError::Crypto(error));
            assert_eq!(invalid.class, EvidenceVerificationFailureClass::Invalid);
            assert_eq!(invalid.code, "KNOWLEDGE_ATTESTATION_SIGNATURE_INVALID");
        }

        let unobserved = map_trust_error(TrustError::rejected(
            "AGG_TRUST_CONFIG_NOT_OBSERVED",
            "test-only unobserved trust configuration",
        ));
        assert_eq!(
            unobserved.class,
            EvidenceVerificationFailureClass::Unauthorized
        );
        assert_eq!(unobserved.code, "KNOWLEDGE_EVIDENCE_VERIFIER_UNAUTHORIZED");
    }

    #[test]
    fn evidence_verification_subject_mismatch_is_invalid_before_nonce_consumption() {
        let configuration = test_configuration();
        let observer = crate::trust_ledger::TrustLedger::in_memory().unwrap();
        let mut subject = subject();
        subject.snapshot_hash = "e".repeat(64);

        let failure = verify_knowledge_graph_evidence_receipt(
            &configuration,
            &observer,
            &receipt(),
            &subject,
            DateTime::parse_from_rfc3339("2026-11-02T09:10:00.000Z")
                .unwrap()
                .timestamp_millis(),
            None,
        )
        .unwrap_err();

        assert_eq!(failure.class, EvidenceVerificationFailureClass::Invalid);
        assert_eq!(failure.code, "KNOWLEDGE_ATTESTATION_SNAPSHOT_MISMATCH");
    }

    #[test]
    fn evidence_verification_accepts_signed_verified_and_rejected_decisions_once() {
        let key = test_signing_key();
        let configuration = configuration_for(&key);
        let observer = crate::trust_ledger::TrustLedger::in_memory().unwrap();
        observer.record(&configuration, TEST_NOW_MS).unwrap();
        let subject = subject();
        let nonce_ledger = TestNonceLedger::default();

        for (status, nonce, label) in [
            (
                EvidenceClaimStatus::Verified,
                "d4e5f6a7-1234-4abc-8def-1234567890ab",
                "verified",
            ),
            (
                EvidenceClaimStatus::Rejected,
                "d4e5f6a7-1234-4abc-8def-1234567890ac",
                "rejected",
            ),
        ] {
            let receipt = sign_receipt(&key, status, nonce, label);
            let verified = verify_knowledge_graph_evidence_receipt(
                &configuration,
                &observer,
                &receipt,
                &subject,
                TEST_NOW_MS,
                Some(&nonce_ledger),
            )
            .unwrap();

            assert_eq!(verified.claim_status(), status);
            assert_eq!(
                verified.verifier_id(),
                "independent-verifier/test-evidence-verifier-key"
            );
            assert_eq!(verified.trust_root_sha256(), key.fingerprint);
            assert_eq!(verified.trust_key_id(), "test-evidence-verifier-key");
            assert_eq!(verified.nonce(), nonce);
            assert_eq!(verified.snapshot_sha256(), subject.snapshot_hash);
            assert_eq!(
                verified.evidence_manifest_sha256(),
                subject.evidence_manifest_hash
            );
            assert_eq!(
                verified.verification_receipt_sha256(),
                receipt.canonical_sha256().unwrap()
            );

            let replay = verify_knowledge_graph_evidence_receipt(
                &configuration,
                &observer,
                &receipt,
                &subject,
                TEST_NOW_MS,
                Some(&nonce_ledger),
            )
            .unwrap();
            assert_eq!(
                replay, verified,
                "exact signed receipt retry must be idempotent"
            );

            let conflicting_status = if status == EvidenceClaimStatus::Verified {
                EvidenceClaimStatus::Rejected
            } else {
                EvidenceClaimStatus::Verified
            };
            let conflicting_receipt =
                sign_receipt(&key, conflicting_status, nonce, "conflicting-replay");
            let conflict = verify_knowledge_graph_evidence_receipt(
                &configuration,
                &observer,
                &conflicting_receipt,
                &subject,
                TEST_NOW_MS,
                Some(&nonce_ledger),
            )
            .unwrap_err();
            assert_eq!(conflict.class, EvidenceVerificationFailureClass::Invalid);
            assert_eq!(conflict.code, "KNOWLEDGE_ATTESTATION_NONCE_REPLAY");
        }
    }

    #[test]
    fn nonce_ledger_serializes_concurrent_exact_replays_and_rejects_rebinding() {
        // This is a concurrency conformance test for the in-memory test double,
        // not proof of a production ledger. Production implementations must
        // provide the same atomic behavior across processes and restarts.
        const CONCURRENCY: usize = 16;
        let ledger = std::sync::Arc::new(TestNonceLedger::default());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(CONCURRENCY));
        let nonce = "d4e5f6a7-1234-4abc-8def-1234567890fe".to_owned();
        let receipt_sha256 = "a".repeat(64);
        let subject_sha256 = "b".repeat(64);

        let workers = (0..CONCURRENCY)
            .map(|_| {
                let ledger = std::sync::Arc::clone(&ledger);
                let barrier = std::sync::Arc::clone(&barrier);
                let nonce = nonce.clone();
                let receipt_sha256 = receipt_sha256.clone();
                let subject_sha256 = subject_sha256.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    ledger
                        .consume_once(&nonce, &receipt_sha256, &subject_sha256)
                        .unwrap()
                })
            })
            .collect::<Vec<_>>();

        let outcomes = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| **outcome == EvidenceVerificationNonceLedgerDisposition::Consumed)
                .count(),
            1,
            "exactly one concurrent caller must establish the nonce binding"
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(
                    |outcome| **outcome == EvidenceVerificationNonceLedgerDisposition::ExactReplay
                )
                .count(),
            CONCURRENCY - 1,
            "all byte-identical concurrent callers must observe an exact replay"
        );
        assert_eq!(
            ledger.consume_once(&nonce, &"c".repeat(64), &subject_sha256),
            Err(EvidenceVerificationNonceLedgerError::BindingConflict),
            "a consumed nonce must not be rebound to a different receipt"
        );
        assert_eq!(
            ledger.consume_once(&nonce, &receipt_sha256, &"d".repeat(64)),
            Err(EvidenceVerificationNonceLedgerError::BindingConflict),
            "a consumed nonce must not be rebound to a different subject"
        );
    }
}
