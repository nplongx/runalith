//! Versioned provider-effect contracts.
//!
//! These DTOs are the W4 boundary between the Worker supervisor and provider
//! adapters. They deliberately carry the Control-issued claim/owner epoch and
//! an explicit, non-secret provider-account identity. They do not grant an
//! adapter authority to settle a Control task or release a lease.

use crate::ProviderAdapterError;
use runalith_domain::content_hash;
use runalith_execution_persistence::{ProviderDispatchState, ProviderIntentRecord};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Current major provider-effect contract version.
pub const PROVIDER_EFFECT_CONTRACT_V1: u16 = 1;

/// Maximum immutable provider request payload.
pub const MAX_PROVIDER_REQUEST_BYTES: usize = 1_048_576;

/// Maximum normalized provider observation retained by the provider journal.
pub const MAX_PROVIDER_OBSERVATION_BYTES: usize = 65_536;

/// Maximum terminal provider response retained in memory before W5 stores it.
pub const MAX_PROVIDER_TERMINAL_BYTES: usize = 16 * 1024 * 1024;

/// State accepted for a Control reservation authorizing one provider effect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProviderControlFenceStateV1 {
    /// Control durably reserved the exact side effect and has not settled it.
    #[serde(rename = "RESERVED")]
    Reserved,
}

/// Workstream 3 Control-fence binding carried into the provider boundary.
///
/// `idempotency_key` is the **Control fence** key (`worker-fence:...`), not the
/// provider dispatch key. `request_sha256` is the digest of the complete legacy
/// `ProviderDispatchRequest`; `acl_sha256` binds the authenticated authorization
/// inputs. The receipt itself remains with Worker/Control; this value pins its
/// canonical digest so later observations/proofs cannot silently change it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderControlFenceV1 {
    /// Durable reservation identity returned by Control.
    pub fence_id: String,
    /// Immutable Control claim identity.
    pub claim_id: String,
    /// Active lease identity.
    pub lease_id: String,
    /// Authenticated worker identity.
    pub worker_id: String,
    /// Monotonic ownership epoch.
    pub owner_epoch: u64,
    /// Immutable approved plan digest.
    pub plan_sha256: String,
    /// Stable side-effect identity; this equals the provider intent ID.
    pub side_effect_id: String,
    /// Provider-dispatch side-effect kind.
    pub kind: String,
    /// Digest of the complete immutable provider dispatch request.
    pub request_sha256: String,
    /// Control reservation idempotency key (distinct from provider key).
    pub idempotency_key: String,
    /// Digest binding the authorization decision inputs.
    pub acl_sha256: String,
    /// State echoed by the durable Control reservation.
    pub state: ProviderControlFenceStateV1,
    /// SHA-256 of the exact canonical Control reservation receipt value.
    pub receipt_sha256: String,
}

impl ProviderControlFenceV1 {
    /// Build the portable W4 binding from a validated Control reservation and
    /// the exact journaled W3 reservation request. The caller must first verify
    /// every echoed response field against that request and authenticate the
    /// Control receipt; this function pins the receipt digest and data shape.
    #[allow(clippy::too_many_arguments)]
    pub fn from_reservation(
        fence_id: impl Into<String>,
        claim_id: impl Into<String>,
        lease_id: impl Into<String>,
        worker_id: impl Into<String>,
        owner_epoch: u64,
        plan_sha256: impl Into<String>,
        side_effect_id: impl Into<String>,
        request_sha256: impl Into<String>,
        idempotency_key: impl Into<String>,
        acl_sha256: impl Into<String>,
        receipt: &Value,
    ) -> Result<Self, ProviderContractError> {
        if !receipt.is_object() {
            return Err(ProviderContractError::ControlFenceReceiptMismatch);
        }
        let binding = Self {
            fence_id: fence_id.into(),
            claim_id: claim_id.into(),
            lease_id: lease_id.into(),
            worker_id: worker_id.into(),
            owner_epoch,
            plan_sha256: plan_sha256.into(),
            side_effect_id: side_effect_id.into(),
            kind: "provider_dispatch".into(),
            request_sha256: request_sha256.into(),
            idempotency_key: idempotency_key.into(),
            acl_sha256: acl_sha256.into(),
            state: ProviderControlFenceStateV1::Reserved,
            receipt_sha256: content_hash(receipt)
                .map_err(|_| ProviderContractError::ControlFenceReceiptMismatch)?,
        };
        binding.validate()?;
        Ok(binding)
    }

    /// Validate the Control reservation fields and its idempotency formula.
    pub fn validate(&self) -> Result<(), ProviderContractError> {
        for (field, value, max) in [
            ("control_fence.fence_id", self.fence_id.as_str(), 256),
            ("control_fence.claim_id", self.claim_id.as_str(), 256),
            ("control_fence.lease_id", self.lease_id.as_str(), 128),
            ("control_fence.worker_id", self.worker_id.as_str(), 128),
            (
                "control_fence.side_effect_id",
                self.side_effect_id.as_str(),
                256,
            ),
            (
                "control_fence.idempotency_key",
                self.idempotency_key.as_str(),
                512,
            ),
        ] {
            validate_identifier(field, value, max)?;
        }
        if self.kind != "provider_dispatch"
            || self.state != ProviderControlFenceStateV1::Reserved
            || self.owner_epoch == 0
            || self.owner_epoch > i64::MAX as u64
            || !valid_lower_sha256(&self.plan_sha256)
            || !valid_lower_sha256(&self.request_sha256)
            || !valid_lower_sha256(&self.acl_sha256)
            || !valid_lower_sha256(&self.receipt_sha256)
        {
            return Err(ProviderContractError::InvalidControlFence);
        }
        let identity = serde_json::json!({
            "claim_id": self.claim_id,
            "lease_id": self.lease_id,
            "owner_epoch": self.owner_epoch,
            "kind": self.kind,
            "side_effect_id": self.side_effect_id
        });
        let expected = format!(
            "worker-fence:{}",
            content_hash(&identity).map_err(|_| ProviderContractError::InvalidControlFence)?
        );
        if self.idempotency_key != expected {
            return Err(ProviderContractError::InvalidControlFence);
        }
        Ok(())
    }

    /// Verify all durable Control-fence fields against the exact intent.
    pub fn validate_against_intent(
        &self,
        intent: &ProviderIntentRecord,
    ) -> Result<(), ProviderContractError> {
        self.validate()?;
        if self.side_effect_id != intent.intent_id
            || self.lease_id != intent.request.lease_id
            || self.worker_id != intent.request.worker_id
            || self.plan_sha256 != intent.request.plan_sha256
        {
            return Err(ProviderContractError::ControlFenceBindingMismatch);
        }
        let payload = intent
            .request
            .payload
            .clone()
            .ok_or(ProviderContractError::MissingPayload)?;
        let request = crate::ProviderDispatchRequest {
            provider_id: intent.request.provider_id.clone(),
            idempotency_key: intent.request.idempotency_key.clone(),
            workflow_id: intent.request.workflow_id.clone(),
            task_id: intent.request.task_id.clone(),
            attempt: intent.request.attempt,
            lease_id: intent.request.lease_id.clone(),
            worker_id: intent.request.worker_id.clone(),
            plan_sha256: intent.request.plan_sha256.clone(),
            request_sha256: intent.request.request_sha256.clone(),
            payload,
        };
        let expected_request_sha256 =
            content_hash(&request).map_err(|_| ProviderContractError::InvalidPayload)?;
        if self.request_sha256 != expected_request_sha256 {
            return Err(ProviderContractError::ControlFenceBindingMismatch);
        }
        Ok(())
    }
}

/// Exact subject shared by dispatch requests, observations, run references and
/// terminal proofs. `provider_account_id` is an opaque host-configured account
/// reference, never a token, credential, or caller display name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderEffectSubjectV1 {
    /// Exact provider adapter identifier.
    pub provider_id: String,
    /// Stable non-secret provider account/installation reference.
    pub provider_account_id: String,
    /// Workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Control-issued worker claim identity.
    pub claim_id: String,
    /// Monotonic task ownership epoch issued by Control.
    pub owner_epoch: u64,
    /// Fenced task attempt.
    pub attempt: u64,
    /// Exact lease identity.
    pub lease_id: String,
    /// Exact worker identity.
    pub worker_id: String,
    /// Immutable approved plan digest.
    pub plan_sha256: String,
    /// Stable external-effect idempotency key.
    pub idempotency_key: String,
    /// Digest of the exact provider request payload bytes.
    pub payload_sha256: String,
    /// Exact Control reservation binding supplied by the W3 journal/Control response.
    pub control_fence: ProviderControlFenceV1,
}

impl ProviderEffectSubjectV1 {
    /// Validate every cross-workstream binding and all bounded identifiers.
    pub fn validate(&self) -> Result<(), ProviderContractError> {
        for (field, value, max) in [
            ("provider_id", self.provider_id.as_str(), 128),
            (
                "provider_account_id",
                self.provider_account_id.as_str(),
                256,
            ),
            ("workflow_id", self.workflow_id.as_str(), 128),
            ("task_id", self.task_id.as_str(), 128),
            ("claim_id", self.claim_id.as_str(), 256),
            ("lease_id", self.lease_id.as_str(), 128),
            ("worker_id", self.worker_id.as_str(), 128),
            ("idempotency_key", self.idempotency_key.as_str(), 256),
        ] {
            validate_identifier(field, value, max)?;
        }
        if self.attempt == 0
            || self.attempt > i64::MAX as u64
            || self.owner_epoch == 0
            || self.owner_epoch > i64::MAX as u64
            || !valid_lower_sha256(&self.plan_sha256)
            || !valid_lower_sha256(&self.payload_sha256)
        {
            return Err(ProviderContractError::InvalidSubject);
        }
        self.control_fence.validate()?;
        if self.claim_id != self.control_fence.claim_id
            || self.lease_id != self.control_fence.lease_id
            || self.worker_id != self.control_fence.worker_id
            || self.owner_epoch != self.control_fence.owner_epoch
            || self.plan_sha256 != self.control_fence.plan_sha256
        {
            return Err(ProviderContractError::ControlFenceBindingMismatch);
        }
        if !self
            .provider_id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"-_".contains(&byte))
        {
            return Err(ProviderContractError::InvalidIdentifier("provider_id"));
        }
        Ok(())
    }
}

/// Immutable request sent to one provider adapter. Payload bytes are the exact
/// canonical JSON bytes whose SHA-256 is pinned by `subject.payload_sha256`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderDispatchRequestV1 {
    /// Contract version.
    pub schema_version: u16,
    /// Stable message identity; reused unchanged for delivery retries.
    pub message_id: String,
    /// Authenticated Worker service identity, supplied by the host boundary.
    pub producer_id: String,
    /// Stable workflow/request correlation identity.
    pub correlation_id: String,
    /// Canonical UTC request creation time.
    pub created_at: String,
    /// Exact workflow/claim/lease/provider binding.
    pub subject: ProviderEffectSubjectV1,
    /// Exact bytes to be handed to the provider adapter.
    pub payload_bytes: Vec<u8>,
}

impl ProviderDispatchRequestV1 {
    /// Build a v1 request from a durable legacy intent and the separately
    /// verified Control claim/fence metadata. Account identity is explicit and
    /// must come from host credential configuration, not from the payload.
    pub fn from_intent(
        intent: &ProviderIntentRecord,
        control_fence: ProviderControlFenceV1,
        provider_account_id: impl Into<String>,
        producer_id: impl Into<String>,
        created_at: impl Into<String>,
    ) -> Result<Self, ProviderContractError> {
        if intent.state != ProviderDispatchState::Reserved
            || intent.provider_run_id.is_some()
            || intent.outcome.is_some()
        {
            return Err(ProviderContractError::IntentNotDispatchable);
        }
        control_fence.validate_against_intent(intent)?;
        let payload = intent
            .request
            .payload
            .as_ref()
            .ok_or(ProviderContractError::MissingPayload)?;
        let payload_bytes =
            serde_json::to_vec(payload).map_err(|_| ProviderContractError::InvalidPayload)?;
        let request = Self {
            schema_version: PROVIDER_EFFECT_CONTRACT_V1,
            message_id: intent.intent_id.clone(),
            producer_id: producer_id.into(),
            correlation_id: intent.request.workflow_id.clone(),
            created_at: created_at.into(),
            subject: ProviderEffectSubjectV1 {
                provider_id: intent.request.provider_id.clone(),
                provider_account_id: provider_account_id.into(),
                workflow_id: intent.request.workflow_id.clone(),
                task_id: intent.request.task_id.clone(),
                claim_id: control_fence.claim_id.clone(),
                owner_epoch: control_fence.owner_epoch,
                attempt: intent.request.attempt,
                lease_id: intent.request.lease_id.clone(),
                worker_id: intent.request.worker_id.clone(),
                plan_sha256: intent.request.plan_sha256.clone(),
                idempotency_key: intent.request.idempotency_key.clone(),
                payload_sha256: intent.request.request_sha256.clone(),
                control_fence,
            },
            payload_bytes,
        };
        request.validate()?;
        Ok(request)
    }

    /// Validate immutable subject, exact bytes and digest before any provider I/O.
    pub fn validate(&self) -> Result<(), ProviderContractError> {
        if self.schema_version != PROVIDER_EFFECT_CONTRACT_V1 {
            return Err(ProviderContractError::UnsupportedVersion(
                self.schema_version,
            ));
        }
        validate_identifier("message_id", &self.message_id, 256)?;
        validate_identifier("producer_id", &self.producer_id, 128)?;
        validate_identifier("correlation_id", &self.correlation_id, 256)?;
        validate_utc_timestamp(&self.created_at)?;
        self.subject.validate()?;
        if self.correlation_id != self.subject.workflow_id {
            return Err(ProviderContractError::InvalidSubject);
        }
        let payload = parse_canonical_json_object(&self.payload_bytes, MAX_PROVIDER_REQUEST_BYTES)?;
        if content_hash(&payload).map_err(|_| ProviderContractError::InvalidPayload)?
            != self.subject.payload_sha256
        {
            return Err(ProviderContractError::PayloadDigestMismatch);
        }
        let legacy_request = crate::ProviderDispatchRequest {
            provider_id: self.subject.provider_id.clone(),
            idempotency_key: self.subject.idempotency_key.clone(),
            workflow_id: self.subject.workflow_id.clone(),
            task_id: self.subject.task_id.clone(),
            attempt: self.subject.attempt,
            lease_id: self.subject.lease_id.clone(),
            worker_id: self.subject.worker_id.clone(),
            plan_sha256: self.subject.plan_sha256.clone(),
            request_sha256: self.subject.payload_sha256.clone(),
            payload,
        };
        if content_hash(&legacy_request).map_err(|_| ProviderContractError::InvalidPayload)?
            != self.subject.control_fence.request_sha256
            || self.subject.control_fence.side_effect_id != self.message_id
        {
            return Err(ProviderContractError::ControlFenceBindingMismatch);
        }
        Ok(())
    }

    /// Decode the already-validated payload without changing its bytes.
    pub fn payload_value(&self) -> Result<Value, ProviderContractError> {
        self.validate()?;
        serde_json::from_slice(&self.payload_bytes)
            .map_err(|_| ProviderContractError::InvalidPayload)
    }

    /// Recompute SHA-256 over the complete serialized v1 request envelope.
    pub fn envelope_sha256(&self) -> Result<String, ProviderContractError> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|_| ProviderContractError::InvalidPayload)?;
        Ok(sha256_bytes(&bytes))
    }
}

/// Stable reference to one run in one explicit provider account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderRunRefV1 {
    /// Provider adapter identifier.
    pub provider_id: String,
    /// Exact non-secret provider account identity.
    pub provider_account_id: String,
    /// Provider-native immutable run ID.
    pub provider_run_id: String,
    /// Optional provider-native HTTPS run URL.
    pub provider_run_url: Option<String>,
}

impl ProviderRunRefV1 {
    /// Validate provider and account binding against a dispatch subject.
    pub fn validate_against(
        &self,
        subject: &ProviderEffectSubjectV1,
    ) -> Result<(), ProviderContractError> {
        validate_identifier("provider_run_id", &self.provider_run_id, 512)?;
        if self.provider_id != subject.provider_id
            || self.provider_account_id != subject.provider_account_id
            || self
                .provider_run_url
                .as_deref()
                .is_some_and(|url| !valid_https_url(url))
        {
            return Err(ProviderContractError::ProviderRunBindingMismatch);
        }
        Ok(())
    }
}

/// Evidence that an external effect was not sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE", deny_unknown_fields)]
pub enum ProviderNotSentEvidenceV1 {
    /// Adapter failed before crossing its network-send boundary.
    PreSend {
        /// Named boundary that proves the external send was not attempted.
        boundary: String,
    },
    /// Provider lookup exhausted the exact account/resource scope and found no run.
    AuthoritativeAbsence {
        /// Exact immutable provider query scope that was exhausted.
        query_scope: String,
        /// Number of complete provider pages examined (must be non-zero).
        pages_scanned: u32,
    },
}

/// Provider-side effect outcome. `UNKNOWN` is quarantined and never authorizes
/// another dispatch; `NOT_SENT` requires an explicit proof category.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "SCREAMING_SNAKE_CASE",
    deny_unknown_fields
)]
pub enum ProviderDispatchOutcomeV1 {
    /// No external request crossed the provider send boundary.
    NotSent {
        /// Bounded explanation of why no effect was sent.
        reason: String,
        /// Evidence category supporting the NOT_SENT classification.
        evidence: ProviderNotSentEvidenceV1,
    },
    /// Provider accepted the request and exposed one exact run identity.
    Accepted {
        /// Exact provider account/run reference.
        run: ProviderRunRefV1,
    },
    /// Provider authoritatively rejected the request without creating work.
    Rejected {
        /// Stable provider-native rejection code.
        reason_code: String,
        /// Bounded provider rejection diagnostic.
        diagnostic: String,
    },
    /// The effect may have happened; reconcile only, never blindly replay.
    Unknown {
        /// Bounded explanation of unresolved remote state.
        diagnostic: String,
    },
}

/// Append-only provider dispatch or lookup observation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderDispatchObservationV1 {
    /// Contract version.
    pub schema_version: u16,
    /// Stable observation identity; reused for an identical journal retry.
    pub observation_id: String,
    /// Original immutable intent/message identity from the dispatch request.
    pub intent_id: String,
    /// Exact subject of the dispatch intent being observed.
    pub subject: ProviderEffectSubjectV1,
    /// Provider outcome established by this observation.
    pub outcome: ProviderDispatchOutcomeV1,
    /// Canonical UTC observation time.
    pub observed_at: String,
    /// Exact bounded normalized provider evidence bytes.
    pub evidence_bytes: Vec<u8>,
    /// SHA-256 of `evidence_bytes` (not a digest of a re-serialized object).
    pub evidence_sha256: String,
}

impl ProviderDispatchObservationV1 {
    /// Create an observation, pinning exact normalized evidence bytes.
    pub fn new(
        observation_id: impl Into<String>,
        intent_id: impl Into<String>,
        subject: ProviderEffectSubjectV1,
        outcome: ProviderDispatchOutcomeV1,
        observed_at: impl Into<String>,
        evidence_bytes: Vec<u8>,
    ) -> Result<Self, ProviderContractError> {
        let observation = Self {
            schema_version: PROVIDER_EFFECT_CONTRACT_V1,
            observation_id: observation_id.into(),
            intent_id: intent_id.into(),
            subject,
            outcome,
            observed_at: observed_at.into(),
            evidence_sha256: sha256_bytes(&evidence_bytes),
            evidence_bytes,
        };
        observation.validate()?;
        Ok(observation)
    }

    /// Verify subject identity, status semantics and evidence digest.
    pub fn validate_against(
        &self,
        request: &ProviderDispatchRequestV1,
    ) -> Result<(), ProviderContractError> {
        self.validate()?;
        if self.subject != request.subject {
            return Err(ProviderContractError::ObservationSubjectMismatch);
        }
        Ok(())
    }

    /// Validate the observation without relying on a Control database.
    pub fn validate(&self) -> Result<(), ProviderContractError> {
        if self.schema_version != PROVIDER_EFFECT_CONTRACT_V1 {
            return Err(ProviderContractError::UnsupportedVersion(
                self.schema_version,
            ));
        }
        validate_identifier("observation_id", &self.observation_id, 256)?;
        validate_identifier("intent_id", &self.intent_id, 256)?;
        validate_utc_timestamp(&self.observed_at)?;
        self.subject.validate()?;
        if self.evidence_bytes.len() > MAX_PROVIDER_OBSERVATION_BYTES
            || sha256_bytes(&self.evidence_bytes) != self.evidence_sha256
        {
            return Err(ProviderContractError::EvidenceDigestMismatch);
        }
        validate_normalized_evidence(&self.evidence_bytes)?;
        let persistence_bytes =
            serde_json::to_vec(self).map_err(|_| ProviderContractError::EvidenceDigestMismatch)?;
        if persistence_bytes.len() > MAX_PROVIDER_OBSERVATION_BYTES {
            return Err(ProviderContractError::EvidenceDigestMismatch);
        }
        match &self.outcome {
            ProviderDispatchOutcomeV1::NotSent { reason, evidence } => {
                validate_identifier("not_sent.reason", reason, 1024)?;
                match evidence {
                    ProviderNotSentEvidenceV1::PreSend { boundary } => {
                        validate_identifier("not_sent.boundary", boundary, 256)?;
                    }
                    ProviderNotSentEvidenceV1::AuthoritativeAbsence {
                        query_scope,
                        pages_scanned,
                    } => {
                        validate_identifier("not_sent.query_scope", query_scope, 2048)?;
                        if *pages_scanned == 0 {
                            return Err(ProviderContractError::IncompleteAbsenceProof);
                        }
                    }
                }
            }
            ProviderDispatchOutcomeV1::Accepted { run } => {
                run.validate_against(&self.subject)?;
            }
            ProviderDispatchOutcomeV1::Rejected {
                reason_code,
                diagnostic,
            } => {
                validate_identifier("rejected.reason_code", reason_code, 128)?;
                validate_identifier("rejected.diagnostic", diagnostic, 4096)?;
            }
            ProviderDispatchOutcomeV1::Unknown { diagnostic } => {
                validate_identifier("unknown.diagnostic", diagnostic, 4096)?;
            }
        }
        Ok(())
    }

    /// Return the complete versioned observation as a JSON object for the
    /// existing append-only `ProviderReconciliationObservation.response` field.
    /// This keeps v1 identity (including account and owner epoch) without a DB
    /// migration; the caller must still append it through the W4 persistence port.
    pub fn to_persistence_response(&self) -> Result<Value, ProviderContractError> {
        self.validate()?;
        serde_json::to_value(self).map_err(|_| ProviderContractError::EvidenceDigestMismatch)
    }

    /// Provider run ID to copy into the legacy observation index, when accepted.
    pub fn provider_run_id(&self) -> Option<&str> {
        match &self.outcome {
            ProviderDispatchOutcomeV1::Accepted { run } => Some(&run.provider_run_id),
            _ => None,
        }
    }
}

/// Immutable proof that one exact provider run reached a terminal state.
/// This is evidence, not a Control task result and not yet a Governance-verified
/// receipt. The response bytes are handed to W5 for content-addressed storage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderTerminalProofV1 {
    /// Contract version.
    pub schema_version: u16,
    /// Stable terminal-proof identity.
    pub proof_id: String,
    /// Exact original dispatch subject.
    pub subject: ProviderEffectSubjectV1,
    /// Exact provider account and run identity.
    pub run: ProviderRunRefV1,
    /// Provider-native terminal state (currently `completed`).
    pub provider_status: String,
    /// Provider-native conclusion (for example `success`, `failure`, `cancelled`).
    pub provider_conclusion: String,
    /// Provider-reported completion time, when present.
    pub completed_at: Option<String>,
    /// Time this immutable response was observed by the adapter.
    pub observed_at: String,
    /// MIME type of the exact provider response bytes.
    pub media_type: String,
    /// Exact provider response body bytes; W5 owns durable artifact storage.
    pub response_bytes: Vec<u8>,
    /// SHA-256 of the exact response bytes.
    pub response_sha256: String,
}

impl ProviderTerminalProofV1 {
    /// Validate that terminal evidence belongs to the exact dispatch and run.
    pub fn validate_against(
        &self,
        request: &ProviderDispatchRequestV1,
        run: &ProviderRunRefV1,
    ) -> Result<(), ProviderContractError> {
        self.validate()?;
        if self.subject != request.subject || &self.run != run {
            return Err(ProviderContractError::TerminalProofSubjectMismatch);
        }
        Ok(())
    }

    /// Validate self-contained proof structure and exact response digest.
    pub fn validate(&self) -> Result<(), ProviderContractError> {
        if self.schema_version != PROVIDER_EFFECT_CONTRACT_V1 {
            return Err(ProviderContractError::UnsupportedVersion(
                self.schema_version,
            ));
        }
        validate_identifier("proof_id", &self.proof_id, 256)?;
        self.subject.validate()?;
        self.run.validate_against(&self.subject)?;
        if self.provider_status != "completed" {
            return Err(ProviderContractError::ProviderRunNotTerminal);
        }
        validate_identifier("provider_conclusion", &self.provider_conclusion, 128)?;
        validate_utc_timestamp(&self.observed_at)?;
        if let Some(completed_at) = &self.completed_at {
            validate_utc_timestamp(completed_at)?;
        }
        validate_identifier("media_type", &self.media_type, 128)?;
        if self.response_bytes.is_empty()
            || self.response_bytes.len() > MAX_PROVIDER_TERMINAL_BYTES
            || sha256_bytes(&self.response_bytes) != self.response_sha256
        {
            return Err(ProviderContractError::EvidenceDigestMismatch);
        }
        Ok(())
    }

    /// Digest the proof's immutable metadata and response-byte digest.
    pub fn proof_sha256(&self) -> Result<String, ProviderContractError> {
        self.validate()?;
        let material = serde_json::json!({
            "schema_version": self.schema_version,
            "proof_id": self.proof_id,
            "subject": self.subject,
            "run": self.run,
            "provider_status": self.provider_status,
            "provider_conclusion": self.provider_conclusion,
            "completed_at": self.completed_at,
            "observed_at": self.observed_at,
            "media_type": self.media_type,
            "response_sha256": self.response_sha256
        });
        content_hash(&material).map_err(|_| ProviderContractError::InvalidPayload)
    }
}

/// Receipt returned by an independently provisioned Governance verifier after
/// it authenticates a terminal proof. `receipt_bytes` remains opaque here;
/// consumers must verify its signature and trust chain using Governance policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderTerminalProofVerificationV1 {
    /// Contract version.
    pub schema_version: u16,
    /// Authenticated verifier service identity.
    pub verifier_id: String,
    /// Verifier trust-key identifier.
    pub key_id: String,
    /// Exact digest of the verified terminal proof.
    pub proof_sha256: String,
    /// Stable immutable receipt identity.
    pub receipt_id: String,
    /// Opaque signed Governance receipt bytes.
    pub receipt_bytes: Vec<u8>,
    /// SHA-256 of the exact receipt bytes.
    pub receipt_sha256: String,
    /// Canonical UTC verification time.
    pub verified_at: String,
}

impl ProviderTerminalProofVerificationV1 {
    /// Verify proof binding and receipt-byte integrity. Signature/trust-root
    /// validation is intentionally delegated to the Governance authority.
    pub fn validate_against(
        &self,
        proof: &ProviderTerminalProofV1,
    ) -> Result<(), ProviderContractError> {
        if self.schema_version != PROVIDER_EFFECT_CONTRACT_V1 {
            return Err(ProviderContractError::UnsupportedVersion(
                self.schema_version,
            ));
        }
        validate_identifier("verifier_id", &self.verifier_id, 128)?;
        validate_identifier("key_id", &self.key_id, 256)?;
        validate_identifier("receipt_id", &self.receipt_id, 256)?;
        validate_utc_timestamp(&self.verified_at)?;
        if self.proof_sha256 != proof.proof_sha256()?
            || self.receipt_bytes.is_empty()
            || self.receipt_bytes.len() > MAX_PROVIDER_OBSERVATION_BYTES
            || sha256_bytes(&self.receipt_bytes) != self.receipt_sha256
        {
            return Err(ProviderContractError::VerificationReceiptMismatch);
        }
        Ok(())
    }
}

/// Independent verifier port. No permissive/default verifier is supplied by
/// this crate; production wiring must inject the Governance-owned authority.
pub trait ProviderTerminalProofVerifier: Send + Sync {
    /// Authenticate the exact terminal proof and return an opaque signed receipt.
    fn verify(
        &self,
        proof: &ProviderTerminalProofV1,
    ) -> Result<ProviderTerminalProofVerificationV1, ProviderProofVerificationError>;
}

/// Verify one provider terminal proof through the injected Governance port.
pub fn verify_terminal_proof(
    proof: &ProviderTerminalProofV1,
    request: &ProviderDispatchRequestV1,
    run: &ProviderRunRefV1,
    verifier: &dyn ProviderTerminalProofVerifier,
) -> Result<ProviderTerminalProofVerificationV1, ProviderProofVerificationError> {
    proof
        .validate_against(request, run)
        .map_err(ProviderProofVerificationError::InvalidProof)?;
    let receipt = verifier.verify(proof)?;
    receipt
        .validate_against(proof)
        .map_err(ProviderProofVerificationError::InvalidReceipt)?;
    Ok(receipt)
}

/// Versioned adapter port. Implementations must never retry an ambiguous POST.
pub trait ProviderAdapterV1: Send + Sync {
    /// Stable adapter identity.
    fn provider_id_v1(&self) -> &'static str;

    /// Submit one immutable dispatch request and return its exact subject observation.
    fn dispatch_v1(
        &self,
        request: &ProviderDispatchRequestV1,
        observation_id: &str,
        observed_at: &str,
    ) -> Result<ProviderDispatchObservationV1, ProviderAdapterError>;

    /// Perform lookup only; this method must never create provider work.
    fn lookup_v1(
        &self,
        request: &ProviderDispatchRequestV1,
        observation_id: &str,
        observed_at: &str,
    ) -> Result<ProviderDispatchObservationV1, ProviderAdapterError>;

    /// Collect terminal evidence for one exact run. No Control settlement occurs here.
    fn collect_terminal_proof_v1(
        &self,
        request: &ProviderDispatchRequestV1,
        run: &ProviderRunRefV1,
        proof_id: &str,
        observed_at: &str,
    ) -> Result<Option<ProviderTerminalProofV1>, ProviderAdapterError>;
}

/// Structural provider-contract failure. Every failure before dispatch is NOT_SENT.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ProviderContractError {
    /// Unsupported major contract version.
    #[error("unsupported provider contract schema version {0}")]
    UnsupportedVersion(u16),
    /// Bounded identifier is missing or malformed.
    #[error("provider contract identifier is invalid: {0}")]
    InvalidIdentifier(&'static str),
    /// Subject fields, attempt or owner epoch are invalid.
    #[error("provider effect subject is invalid")]
    InvalidSubject,
    /// Control reservation fields are malformed or not a provider-dispatch fence.
    #[error("Control provider reservation binding is invalid")]
    InvalidControlFence,
    /// Control reservation does not describe this exact provider intent.
    #[error("Control provider reservation does not match the immutable provider intent")]
    ControlFenceBindingMismatch,
    /// Control receipt is not an object or its digest could not be computed.
    #[error("Control provider reservation receipt is invalid")]
    ControlFenceReceiptMismatch,
    /// Timestamp is not a bounded canonical UTC timestamp.
    #[error("provider contract timestamp is not canonical UTC")]
    InvalidTimestamp,
    /// Durable intent is not eligible for a new dispatch request.
    #[error("provider intent is not in RESERVED state")]
    IntentNotDispatchable,
    /// Historical or malformed intent omitted the immutable payload.
    #[error("provider intent has no immutable payload")]
    MissingPayload,
    /// Payload is not a bounded canonical JSON object.
    #[error("provider payload is not a bounded canonical JSON object")]
    InvalidPayload,
    /// Payload bytes differ from the pinned digest.
    #[error("provider payload SHA-256 does not match the immutable intent")]
    PayloadDigestMismatch,
    /// Observation evidence is oversized or does not match its digest.
    #[error("provider evidence bytes do not match their SHA-256")]
    EvidenceDigestMismatch,
    /// Provider returned a zero-page or otherwise incomplete absence claim.
    #[error("authoritative provider absence requires at least one fully scanned page")]
    IncompleteAbsenceProof,
    /// Provider run reference belongs to another provider account or adapter.
    #[error("provider run reference does not match the dispatch account")]
    ProviderRunBindingMismatch,
    /// Observation was emitted for another dispatch subject.
    #[error("provider observation subject does not match the dispatch request")]
    ObservationSubjectMismatch,
    /// Terminal proof does not bind the exact original request and run.
    #[error("provider terminal proof does not match the exact dispatch/run")]
    TerminalProofSubjectMismatch,
    /// Provider has not authoritatively classified the run as completed.
    #[error("provider run is not terminal")]
    ProviderRunNotTerminal,
    /// Governance receipt does not bind the proof or its bytes.
    #[error("provider terminal proof verification receipt is invalid")]
    VerificationReceiptMismatch,
}

/// Failure from the injected terminal-proof verifier.
#[derive(Debug, Error)]
pub enum ProviderProofVerificationError {
    /// Proof failed structural or exact-subject validation.
    #[error("provider terminal proof is invalid: {0}")]
    InvalidProof(ProviderContractError),
    /// Governance service rejected or could not verify the proof.
    #[error("Governance terminal-proof verification failed: {0}")]
    Rejected(String),
    /// Governance returned an invalid receipt envelope.
    #[error("Governance terminal-proof receipt is invalid: {0}")]
    InvalidReceipt(ProviderContractError),
}

fn parse_canonical_json_object(
    bytes: &[u8],
    max_bytes: usize,
) -> Result<Value, ProviderContractError> {
    if bytes.is_empty() || bytes.len() > max_bytes {
        return Err(ProviderContractError::InvalidPayload);
    }
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| ProviderContractError::InvalidPayload)?;
    if !value.is_object()
        || serde_json::to_vec(&value).map_err(|_| ProviderContractError::InvalidPayload)? != bytes
    {
        return Err(ProviderContractError::InvalidPayload);
    }
    Ok(value)
}

fn validate_normalized_evidence(bytes: &[u8]) -> Result<(), ProviderContractError> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| ProviderContractError::EvidenceDigestMismatch)?;
    if !value.is_object()
        || serde_json::to_vec(&value).map_err(|_| ProviderContractError::EvidenceDigestMismatch)?
            != bytes
    {
        return Err(ProviderContractError::EvidenceDigestMismatch);
    }
    Ok(())
}

fn validate_identifier(
    field: &'static str,
    value: &str,
    max: usize,
) -> Result<(), ProviderContractError> {
    if value.trim().is_empty()
        || value.trim() != value
        || value.len() > max
        || value.chars().any(char::is_control)
    {
        return Err(ProviderContractError::InvalidIdentifier(field));
    }
    Ok(())
}

fn valid_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_utc_timestamp(value: &str) -> Result<(), ProviderContractError> {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.len() > 40
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
        || !value.ends_with('Z')
        || !bytes[..19]
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7 | 10 | 13 | 16) || byte.is_ascii_digit())
        || (bytes.len() > 20
            && !(bytes[19] == b'.' && bytes[20..bytes.len() - 1].iter().all(u8::is_ascii_digit)))
    {
        return Err(ProviderContractError::InvalidTimestamp);
    }
    Ok(())
}

fn valid_https_url(value: &str) -> bool {
    value.starts_with("https://") && value.len() <= 2048 && !value.chars().any(char::is_control)
}

fn sha256_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use runalith_execution_persistence::ProviderIntentRequest;

    fn intent_for_contract() -> ProviderIntentRecord {
        let payload = serde_json::json!({"workflow":"release.yml","ref":"main"});
        ProviderIntentRecord {
            intent_id: "intent-1".into(),
            request: ProviderIntentRequest {
                workflow_id: "workflow-1".into(),
                task_id: "task-1".into(),
                attempt: 2,
                provider_id: "github-actions".into(),
                idempotency_key: "provider-idem-1".into(),
                lease_id: "lease-2".into(),
                worker_id: "worker-1".into(),
                plan_sha256: "a".repeat(64),
                request_sha256: content_hash(&payload).unwrap(),
                payload: Some(payload),
            },
            state: ProviderDispatchState::Reserved,
            provider_run_id: None,
            outcome: None,
            created_at: "2026-11-03T10:00:00Z".into(),
            updated_at: "2026-11-03T10:00:00Z".into(),
        }
    }

    fn fence_for_intent(
        intent: &ProviderIntentRecord,
        claim_id: &str,
        owner_epoch: u64,
    ) -> ProviderControlFenceV1 {
        let payload = intent.request.payload.clone().unwrap();
        let dispatch = crate::ProviderDispatchRequest {
            provider_id: intent.request.provider_id.clone(),
            idempotency_key: intent.request.idempotency_key.clone(),
            workflow_id: intent.request.workflow_id.clone(),
            task_id: intent.request.task_id.clone(),
            attempt: intent.request.attempt,
            lease_id: intent.request.lease_id.clone(),
            worker_id: intent.request.worker_id.clone(),
            plan_sha256: intent.request.plan_sha256.clone(),
            request_sha256: intent.request.request_sha256.clone(),
            payload,
        };
        let idempotency_identity = serde_json::json!({
            "claim_id": claim_id,
            "lease_id": intent.request.lease_id,
            "owner_epoch": owner_epoch,
            "kind": "provider_dispatch",
            "side_effect_id": intent.intent_id
        });
        ProviderControlFenceV1::from_reservation(
            format!("fence-{}", intent.intent_id),
            claim_id,
            intent.request.lease_id.clone(),
            intent.request.worker_id.clone(),
            owner_epoch,
            intent.request.plan_sha256.clone(),
            intent.intent_id.clone(),
            content_hash(&dispatch).unwrap(),
            format!(
                "worker-fence:{}",
                content_hash(&idempotency_identity).unwrap()
            ),
            "c".repeat(64),
            &serde_json::json!({"reservation_id":intent.intent_id}),
        )
        .unwrap()
    }

    fn request() -> ProviderDispatchRequestV1 {
        let intent = intent_for_contract();
        let request = ProviderDispatchRequestV1::from_intent(
            &intent,
            fence_for_intent(&intent, "claim-1", 7),
            "gha-installation:12345",
            "worker-service",
            "2026-11-03T10:00:00Z",
        )
        .unwrap();
        request.validate().unwrap();
        request
    }

    #[test]
    fn from_intent_requires_a_reserved_durable_payload_and_explicit_fence_fields() {
        let intent = intent_for_contract();
        let fence = fence_for_intent(&intent, "claim-from-control", 9);
        let request = ProviderDispatchRequestV1::from_intent(
            &intent,
            fence.clone(),
            "gha-installation:12345",
            "worker-service",
            "2026-11-03T10:00:01Z",
        )
        .unwrap();
        assert_eq!(request.message_id, "intent-1");
        assert_eq!(request.subject.claim_id, "claim-from-control");
        assert_eq!(request.subject.owner_epoch, 9);
        assert_eq!(
            request.subject.provider_account_id,
            "gha-installation:12345"
        );

        let mut finalized = intent;
        finalized.state = ProviderDispatchState::Accepted;
        assert!(matches!(
            ProviderDispatchRequestV1::from_intent(
                &finalized,
                fence,
                "gha-installation:12345",
                "worker-service",
                "2026-11-03T10:00:01Z"
            ),
            Err(ProviderContractError::IntentNotDispatchable)
        ));
    }

    #[test]
    fn v1_dispatch_request_pins_exact_payload_and_control_claim_epoch() {
        let request = request();
        assert_eq!(request.subject.owner_epoch, 7);
        assert_eq!(request.payload_value().unwrap()["ref"], "main");
        assert_eq!(request.envelope_sha256().unwrap().len(), 64);

        let mut changed_epoch = request.clone();
        changed_epoch.subject.owner_epoch += 1;
        assert!(matches!(
            changed_epoch.validate(),
            Err(ProviderContractError::ControlFenceBindingMismatch)
        ));

        let mut changed_account = request.clone();
        changed_account.subject.provider_account_id = "gha-installation:other".into();
        assert!(changed_account.validate().is_ok());
        assert_ne!(
            changed_account.envelope_sha256().unwrap(),
            request.envelope_sha256().unwrap()
        );

        let mut altered_bytes = request.clone();
        altered_bytes.payload_bytes = br#"{"ref":"attacker","workflow":"release.yml"}"#.to_vec();
        assert!(matches!(
            altered_bytes.validate(),
            Err(ProviderContractError::PayloadDigestMismatch)
        ));
    }

    #[test]
    fn control_fence_pins_w3_reservation_key_and_complete_dispatch_digest() {
        let request = request();
        let mut changed_request_digest = request.clone();
        changed_request_digest.subject.control_fence.request_sha256 = "d".repeat(64);
        assert!(matches!(
            changed_request_digest.validate(),
            Err(ProviderContractError::ControlFenceBindingMismatch)
        ));

        let mut changed_fence_idempotency = request.clone();
        changed_fence_idempotency
            .subject
            .control_fence
            .idempotency_key = "worker-fence:forged".into();
        assert!(matches!(
            changed_fence_idempotency.validate(),
            Err(ProviderContractError::InvalidControlFence)
        ));

        let mut changed_receipt_digest = request.clone();
        changed_receipt_digest.subject.control_fence.receipt_sha256 = "e".repeat(64);
        assert!(changed_receipt_digest.validate().is_ok());
        assert_ne!(
            changed_receipt_digest.envelope_sha256().unwrap(),
            request.envelope_sha256().unwrap()
        );
    }

    #[test]
    fn observation_is_exact_subject_bound_and_requires_complete_absence_proof() {
        let request = request();
        let evidence = br#"{"http_status":204,"lookup":"complete"}"#.to_vec();
        let observation = ProviderDispatchObservationV1::new(
            "observation-1",
            request.message_id.clone(),
            request.subject.clone(),
            ProviderDispatchOutcomeV1::NotSent {
                reason: "preflight proved no send was attempted".into(),
                evidence: ProviderNotSentEvidenceV1::AuthoritativeAbsence {
                    query_scope: "owner/repo/workflow.yml@main".into(),
                    pages_scanned: 2,
                },
            },
            "2026-11-03T10:01:00Z",
            evidence,
        )
        .unwrap();
        observation.validate_against(&request).unwrap();
        let stored = observation.to_persistence_response().unwrap();
        assert_eq!(stored["intent_id"], request.message_id);
        assert_eq!(stored["subject"]["owner_epoch"], 7);
        assert_eq!(
            stored["subject"]["provider_account_id"],
            "gha-installation:12345"
        );
        assert!(observation.provider_run_id().is_none());

        let mut wrong_epoch = request.clone();
        wrong_epoch.subject.owner_epoch += 1;
        assert!(matches!(
            observation.validate_against(&wrong_epoch),
            Err(ProviderContractError::ObservationSubjectMismatch)
        ));

        let incomplete = ProviderDispatchObservationV1::new(
            "observation-2",
            request.message_id.clone(),
            request.subject.clone(),
            ProviderDispatchOutcomeV1::NotSent {
                reason: "no runs".into(),
                evidence: ProviderNotSentEvidenceV1::AuthoritativeAbsence {
                    query_scope: "owner/repo".into(),
                    pages_scanned: 0,
                },
            },
            "2026-11-03T10:01:01Z",
            br#"{"result":"not_found"}"#.to_vec(),
        );
        assert!(matches!(
            incomplete,
            Err(ProviderContractError::IncompleteAbsenceProof)
        ));
    }

    #[test]
    fn accepted_run_and_terminal_proof_bind_exact_provider_account_and_digest() {
        let request = request();
        let run = ProviderRunRefV1 {
            provider_id: request.subject.provider_id.clone(),
            provider_account_id: request.subject.provider_account_id.clone(),
            provider_run_id: "998877".into(),
            provider_run_url: Some("https://github.com/acme/repo/actions/runs/998877".into()),
        };
        let observation = ProviderDispatchObservationV1::new(
            "observation-accepted",
            request.message_id.clone(),
            request.subject.clone(),
            ProviderDispatchOutcomeV1::Accepted { run: run.clone() },
            "2026-11-03T10:02:00Z",
            br#"{"http_status":204,"provider_run_id":"998877"}"#.to_vec(),
        )
        .unwrap();
        observation.validate_against(&request).unwrap();
        assert_eq!(observation.provider_run_id(), Some("998877"));

        let response_bytes =
            br#"{"id":998877,"status":"completed","conclusion":"success"}"#.to_vec();
        let proof = ProviderTerminalProofV1 {
            schema_version: 1,
            proof_id: "proof-1".into(),
            subject: request.subject.clone(),
            run: run.clone(),
            provider_status: "completed".into(),
            provider_conclusion: "success".into(),
            completed_at: Some("2026-11-03T10:01:55Z".into()),
            observed_at: "2026-11-03T10:02:00Z".into(),
            media_type: "application/json".into(),
            response_sha256: sha256_bytes(&response_bytes),
            response_bytes,
        };
        proof.validate_against(&request, &run).unwrap();
        assert_eq!(proof.proof_sha256().unwrap().len(), 64);

        let mut wrong_run = run;
        wrong_run.provider_account_id = "gha-installation:other".into();
        assert!(matches!(
            proof.validate_against(&request, &wrong_run),
            Err(ProviderContractError::TerminalProofSubjectMismatch)
        ));
    }

    #[test]
    fn governance_receipt_must_bind_proof_and_exact_receipt_bytes() {
        let request = request();
        let run = ProviderRunRefV1 {
            provider_id: request.subject.provider_id.clone(),
            provider_account_id: request.subject.provider_account_id.clone(),
            provider_run_id: "42".into(),
            provider_run_url: None,
        };
        let response_bytes = br#"{"status":"completed","conclusion":"success"}"#.to_vec();
        let proof = ProviderTerminalProofV1 {
            schema_version: 1,
            proof_id: "proof-2".into(),
            subject: request.subject,
            run: run.clone(),
            provider_status: "completed".into(),
            provider_conclusion: "success".into(),
            completed_at: None,
            observed_at: "2026-11-03T10:03:00Z".into(),
            media_type: "application/json".into(),
            response_sha256: sha256_bytes(&response_bytes),
            response_bytes,
        };
        let receipt_bytes = b"opaque-signed-governance-receipt".to_vec();
        let receipt = ProviderTerminalProofVerificationV1 {
            schema_version: 1,
            verifier_id: "governance-verifier".into(),
            key_id: "key-2026-01".into(),
            proof_sha256: proof.proof_sha256().unwrap(),
            receipt_id: "receipt-1".into(),
            receipt_sha256: sha256_bytes(&receipt_bytes),
            receipt_bytes,
            verified_at: "2026-11-03T10:03:01Z".into(),
        };
        receipt.validate_against(&proof).unwrap();

        let mut altered = receipt;
        altered.proof_sha256 = "0".repeat(64);
        assert!(matches!(
            altered.validate_against(&proof),
            Err(ProviderContractError::VerificationReceiptMismatch)
        ));
    }
}
