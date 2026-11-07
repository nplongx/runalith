//! Versioned public contracts for Execution-owned artifacts and sessions.
//!
//! These contracts describe immutable observations and delivery facts. They
//! do not authenticate a producer, authorize a workflow transition, verify
//! evidence trust, or prove provider-side terminality. Host adapters must
//! supply authenticated service identities and persist receipts durably.

use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::valid_media_type;

/// Current major/minor version for the Workstream 5 public contracts.
pub const CONTRACT_VERSION_V1: &str = "1.0";
/// Media type used for the canonical immutable manifest object.
pub const ARTIFACT_MANIFEST_MEDIA_TYPE: &str = "application/vnd.runalith.artifact-manifest+json";

const MAX_ID_BYTES: usize = 128;
const MAX_SCHEMA_ID_BYTES: usize = 192;
const MAX_MANIFEST_ARTIFACTS: usize = 256;

/// Authenticated producer and exact task-attempt context supplied by a host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactSourceV1 {
    /// Authenticated Execution producer service identity.
    pub producer_id: String,
    /// Workflow subject supplied by the authoritative claim/context.
    pub workflow_id: String,
    /// Task subject supplied by the authoritative claim/context.
    pub task_id: String,
    /// Positive task attempt; this is an identity, not a retry instruction.
    pub attempt: u64,
    /// Stable workflow/request correlation identity.
    pub correlation_id: String,
    /// Canonical UTC creation time.
    pub created_at: String,
}

impl ArtifactSourceV1 {
    /// Validate bounded identities and canonical UTC creation time.
    pub fn validate(&self) -> Result<(), String> {
        validate_identifier("producer_id", &self.producer_id)?;
        validate_identifier("workflow_id", &self.workflow_id)?;
        validate_identifier("task_id", &self.task_id)?;
        validate_identifier("correlation_id", &self.correlation_id)?;
        if self.attempt == 0 {
            return Err("artifact source attempt must be positive".into());
        }
        validate_utc_timestamp("source.created_at", &self.created_at)
    }
}

/// Public immutable reference to exact content-addressed bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactRefV1 {
    /// Contract version, currently `1.0`.
    pub contract_version: String,
    /// Content-addressed identity (`sha256:<lowercase digest>`).
    pub artifact_id: String,
    /// SHA-256 of the exact content bytes.
    pub sha256: String,
    /// Exact content byte length.
    pub byte_len: u64,
    /// RFC media type of the content bytes.
    pub media_type: String,
    /// Optional producer-declared content schema identifier.
    pub content_schema_id: Option<String>,
    /// Optional content schema version; present exactly when schema ID is present.
    pub content_schema_version: Option<String>,
    /// Exact producer and task-attempt lineage.
    pub source: ArtifactSourceV1,
}

impl ArtifactRefV1 {
    /// Validate the reference shape and its immutable identity binding.
    pub fn validate(&self) -> Result<(), String> {
        validate_contract_version(&self.contract_version)?;
        validate_digest(&self.sha256)?;
        if self.artifact_id != format!("sha256:{}", self.sha256) {
            return Err("artifact_id does not bind the SHA-256 digest".into());
        }
        if self.byte_len > 32 * 1024 * 1024 {
            return Err("artifact byte_len exceeds the 32 MiB limit".into());
        }
        if !valid_media_type(&self.media_type) {
            return Err("artifact media_type is invalid".into());
        }
        match (&self.content_schema_id, &self.content_schema_version) {
            (Some(id), Some(version)) => {
                validate_bounded_token("content_schema_id", id, MAX_SCHEMA_ID_BYTES)?;
                validate_bounded_token("content_schema_version", version, 64)?;
            }
            (None, None) => {}
            _ => return Err("content schema ID and version must be supplied together".into()),
        }
        self.source.validate()
    }
}

/// Immutable producer lineage for one result package.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactLineageV1 {
    /// Contract version, currently `1.0`.
    pub contract_version: String,
    /// Authenticated producer service identity supplied by the host.
    pub producer_id: String,
    /// Workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Positive task attempt identity.
    pub attempt: u64,
    /// Stable correlation identity.
    pub correlation_id: String,
    /// Canonical UTC package creation time.
    pub created_at: String,
    /// Explicit parent artifact references; absence is an empty list, not inferred lineage.
    pub parent_artifacts: Vec<ArtifactRefV1>,
}

impl ArtifactLineageV1 {
    /// Validate lineage identities and all explicitly supplied parent references.
    pub fn validate(&self) -> Result<(), String> {
        validate_contract_version(&self.contract_version)?;
        validate_identifier("producer_id", &self.producer_id)?;
        validate_identifier("workflow_id", &self.workflow_id)?;
        validate_identifier("task_id", &self.task_id)?;
        validate_identifier("correlation_id", &self.correlation_id)?;
        if self.attempt == 0 {
            return Err("lineage attempt must be positive".into());
        }
        validate_utc_timestamp("lineage.created_at", &self.created_at)?;
        if self.parent_artifacts.len() > MAX_MANIFEST_ARTIFACTS {
            return Err("lineage parent_artifacts exceeds the 256-reference limit".into());
        }
        let mut seen = std::collections::BTreeSet::new();
        for parent in &self.parent_artifacts {
            parent.validate()?;
            if !seen.insert(parent.artifact_id.as_str()) {
                return Err("lineage contains duplicate parent artifact IDs".into());
            }
        }
        Ok(())
    }
}

/// Canonical immutable manifest for a set of result/evidence byte objects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactManifestV1 {
    /// Contract version, currently `1.0`.
    pub contract_version: String,
    /// Canonical UTC manifest creation time.
    pub created_at: String,
    /// Explicit output artifact references in deterministic caller order.
    pub artifacts: Vec<ArtifactRefV1>,
    /// Producer and parent lineage; this is provenance metadata, not a trust decision.
    pub lineage: ArtifactLineageV1,
}

impl ArtifactManifestV1 {
    /// Validate metadata consistency, bounded references, and unambiguous lineage.
    pub fn validate(&self) -> Result<(), String> {
        validate_contract_version(&self.contract_version)?;
        validate_utc_timestamp("manifest.created_at", &self.created_at)?;
        self.lineage.validate()?;
        if self.artifacts.is_empty() || self.artifacts.len() > MAX_MANIFEST_ARTIFACTS {
            return Err("manifest must contain between 1 and 256 output artifacts".into());
        }
        if self.created_at < self.lineage.created_at {
            return Err("manifest predates its declared lineage".into());
        }
        let mut seen = std::collections::BTreeSet::new();
        for artifact in &self.artifacts {
            artifact.validate()?;
            if artifact.source.producer_id != self.lineage.producer_id
                || artifact.source.workflow_id != self.lineage.workflow_id
                || artifact.source.task_id != self.lineage.task_id
                || artifact.source.attempt != self.lineage.attempt
                || artifact.source.correlation_id != self.lineage.correlation_id
            {
                return Err(
                    "artifact reference does not match manifest producer/task/attempt lineage"
                        .into(),
                );
            }
            if artifact.source.created_at > self.created_at {
                return Err("manifest predates one of its output artifacts".into());
            }
            if !seen.insert(artifact.artifact_id.as_str()) {
                return Err("manifest contains duplicate output artifact IDs".into());
            }
        }
        for parent in &self.lineage.parent_artifacts {
            if seen.contains(parent.artifact_id.as_str()) {
                return Err("manifest output cannot also be its own parent".into());
            }
        }
        Ok(())
    }

    /// Encode a deterministic compact JSON representation for immutable storage.
    ///
    /// Object fields are emitted in a fixed order and strings are escaped using
    /// JSON rules. Consumers should decode with a strict `deny_unknown_fields`
    /// schema and call `validate` after reading the content-addressed bytes.
    pub fn canonical_json_bytes(&self) -> Result<Vec<u8>, String> {
        self.validate()?;
        let mut out = String::new();
        out.push_str("{\"contract_version\":");
        push_json_string(&mut out, &self.contract_version);
        out.push_str(",\"created_at\":");
        push_json_string(&mut out, &self.created_at);
        out.push_str(",\"artifacts\":[");
        for (index, artifact) in self.artifacts.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            write_artifact_ref(&mut out, artifact);
        }
        out.push_str("],\"lineage\":");
        write_lineage(&mut out, &self.lineage);
        out.push('}');
        Ok(out.into_bytes())
    }
}

/// Session identity bound to one workflow task attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionRefV1 {
    /// Contract version, currently `1.0`.
    pub contract_version: String,
    /// Opaque immutable session identity.
    pub session_id: String,
    /// Workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Positive task attempt identity.
    pub attempt: u64,
    /// Authenticated owner service identity.
    pub owner_service_id: String,
    /// Canonical UTC creation time.
    pub created_at: String,
    /// Canonical UTC expiry time.
    pub expires_at: String,
}

impl SessionRefV1 {
    /// Validate identity and fixed-width UTC time ordering.
    pub fn validate(&self) -> Result<(), String> {
        validate_contract_version(&self.contract_version)?;
        validate_identifier("session_id", &self.session_id)?;
        validate_identifier("workflow_id", &self.workflow_id)?;
        validate_identifier("task_id", &self.task_id)?;
        validate_identifier("owner_service_id", &self.owner_service_id)?;
        if self.attempt == 0 {
            return Err("session attempt must be positive".into());
        }
        validate_utc_timestamp("session.created_at", &self.created_at)?;
        validate_utc_timestamp("session.expires_at", &self.expires_at)?;
        if self.expires_at <= self.created_at {
            return Err("session expiry must be after creation".into());
        }
        Ok(())
    }
}

/// Session permission granted to one authenticated principal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SessionPermissionV1 {
    /// Read session metadata and history.
    Read,
    /// Enqueue a delivery request.
    Send,
    /// Record a delivery receipt.
    Acknowledge,
    /// Change session grants through the owning host API.
    ManageAcl,
}

/// Explicit, expiring ACL grant; caller identity must be host-authenticated.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionGrantV1 {
    /// Authenticated principal subject ID.
    pub subject_id: String,
    /// Explicit permission set.
    pub permissions: Vec<SessionPermissionV1>,
    /// Canonical UTC grant expiry, never later than the session expiry.
    pub expires_at: String,
}

/// Complete ACL observation for one session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionAclV1 {
    /// Session this ACL is bound to.
    pub session: SessionRefV1,
    /// Explicit grants; no wildcard or implicit owner grant is inferred.
    pub grants: Vec<SessionGrantV1>,
}

impl SessionAclV1 {
    /// Validate unique subjects, bounded permissions and grant/session time binding.
    pub fn validate(&self) -> Result<(), String> {
        self.session.validate()?;
        if self.grants.len() > 256 {
            return Err("session ACL exceeds 256 grants".into());
        }
        let mut subjects = std::collections::BTreeSet::new();
        for grant in &self.grants {
            validate_identifier("grant.subject_id", &grant.subject_id)?;
            validate_utc_timestamp("grant.expires_at", &grant.expires_at)?;
            if grant.expires_at <= self.session.created_at
                || grant.expires_at > self.session.expires_at
            {
                return Err("session grant expiry is outside the session lifetime".into());
            }
            if grant.permissions.is_empty() {
                return Err("session grant has no permissions".into());
            }
            let mut permissions = std::collections::BTreeSet::new();
            for permission in &grant.permissions {
                if !permissions.insert(*permission as u8) {
                    return Err("session grant contains duplicate permissions".into());
                }
            }
            if !subjects.insert(grant.subject_id.as_str()) {
                return Err("session ACL contains duplicate subject grants".into());
            }
        }
        Ok(())
    }

    /// Check a permission for a host-authenticated subject at a supplied UTC time.
    pub fn allows(
        &self,
        subject_id: &str,
        permission: SessionPermissionV1,
        now: &str,
    ) -> Result<bool, String> {
        self.validate()?;
        validate_identifier("subject_id", subject_id)?;
        validate_utc_timestamp("now", now)?;
        if now < self.session.created_at.as_str() || now >= self.session.expires_at.as_str() {
            return Ok(false);
        }
        Ok(self.grants.iter().any(|grant| {
            grant.subject_id == subject_id
                && now < grant.expires_at.as_str()
                && grant.permissions.contains(&permission)
        }))
    }
}

/// Immutable request to enqueue one session message delivery.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionDeliveryRequestV1 {
    /// Contract version, currently `1.0`.
    pub contract_version: String,
    /// Stable message identity, unchanged across a delivery retry.
    pub message_id: String,
    /// Stable idempotency identity; changed body under this key is a conflict.
    pub idempotency_key: String,
    /// Exact session and task-attempt binding.
    pub session: SessionRefV1,
    /// Authenticated producer service identity.
    pub sender_service_id: String,
    /// Exact intended recipient subject.
    pub recipient_subject_id: String,
    /// Immutable content reference for the message body.
    pub payload: ArtifactRefV1,
    /// Canonical UTC request creation time.
    pub created_at: String,
    /// Canonical UTC request expiry, no later than session expiry.
    pub expires_at: String,
}

impl SessionDeliveryRequestV1 {
    /// Validate request binding to the session and exact immutable payload.
    pub fn validate(&self) -> Result<(), String> {
        validate_contract_version(&self.contract_version)?;
        validate_identifier("message_id", &self.message_id)?;
        validate_identifier("idempotency_key", &self.idempotency_key)?;
        validate_identifier("sender_service_id", &self.sender_service_id)?;
        validate_identifier("recipient_subject_id", &self.recipient_subject_id)?;
        self.session.validate()?;
        self.payload.validate()?;
        validate_utc_timestamp("delivery.created_at", &self.created_at)?;
        validate_utc_timestamp("delivery.expires_at", &self.expires_at)?;
        if self.created_at < self.session.created_at
            || self.created_at >= self.session.expires_at
            || self.expires_at <= self.created_at
            || self.expires_at > self.session.expires_at
        {
            return Err("delivery request timestamps are outside the session lifetime".into());
        }
        if self.payload.source.producer_id != self.sender_service_id
            || self.payload.source.workflow_id != self.session.workflow_id
            || self.payload.source.task_id != self.session.task_id
            || self.payload.source.attempt != self.session.attempt
        {
            return Err(
                "delivery payload producer/workflow/task/attempt does not match the request".into(),
            );
        }
        if self.payload.source.created_at > self.created_at {
            return Err("delivery request predates its payload".into());
        }
        Ok(())
    }

    /// Deterministic request bytes used to bind receipts to the exact body.
    pub fn canonical_json_bytes(&self) -> Result<Vec<u8>, String> {
        self.validate()?;
        let mut out = String::new();
        out.push_str("{\"contract_version\":");
        push_json_string(&mut out, &self.contract_version);
        out.push_str(",\"message_id\":");
        push_json_string(&mut out, &self.message_id);
        out.push_str(",\"idempotency_key\":");
        push_json_string(&mut out, &self.idempotency_key);
        out.push_str(",\"session\":");
        write_session_ref(&mut out, &self.session);
        out.push_str(",\"sender_service_id\":");
        push_json_string(&mut out, &self.sender_service_id);
        out.push_str(",\"recipient_subject_id\":");
        push_json_string(&mut out, &self.recipient_subject_id);
        out.push_str(",\"payload\":");
        write_artifact_ref(&mut out, &self.payload);
        out.push_str(",\"created_at\":");
        push_json_string(&mut out, &self.created_at);
        out.push_str(",\"expires_at\":");
        push_json_string(&mut out, &self.expires_at);
        out.push('}');
        Ok(out.into_bytes())
    }

    /// SHA-256 binding for the canonical immutable request bytes.
    pub fn digest(&self) -> Result<String, String> {
        Ok(hex::encode(Sha256::digest(self.canonical_json_bytes()?)))
    }
}

/// Terminal or ambiguous local session-delivery outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "SCREAMING_SNAKE_CASE",
    deny_unknown_fields
)]
pub enum SessionDeliveryOutcomeV1 {
    /// Remote delivery was acknowledged with a durable receipt identity.
    Acknowledged {
        /// Opaque remote-side receipt identity returned by the transport.
        remote_receipt_id: String,
    },
    /// The transport proves that no remote send occurred; a caller may later
    /// request a new attempt explicitly. This contract never starts that attempt.
    Rejected {
        /// Stable reason code for the local rejection.
        reason_code: String,
        /// Reference to proof material; the host must independently authenticate it.
        pre_send_proof_ref: String,
    },
    /// The send may have occurred; automatic retry/replay is forbidden.
    Uncertain {
        /// Stable reason code explaining why remote outcome is ambiguous.
        reason_code: String,
    },
}

/// Immutable receipt for one exact delivery attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionDeliveryReceiptV1 {
    /// Contract version, currently `1.0`.
    pub contract_version: String,
    /// Stable request message identity.
    pub message_id: String,
    /// Stable request idempotency identity.
    pub idempotency_key: String,
    /// SHA-256 of the exact canonical request bytes.
    pub request_sha256: String,
    /// Positive delivery attempt identity.
    pub delivery_attempt: u64,
    /// Authenticated transport/worker service identity.
    pub delivery_service_id: String,
    /// Explicit outcome; UNKNOWN is represented as UNCERTAIN, never as rejection.
    pub outcome: SessionDeliveryOutcomeV1,
    /// Canonical UTC receipt creation time.
    pub recorded_at: String,
}

impl SessionDeliveryReceiptV1 {
    /// Validate receipt identity and exact request binding.
    pub fn validate_for(&self, request: &SessionDeliveryRequestV1) -> Result<(), String> {
        validate_contract_version(&self.contract_version)?;
        request.validate()?;
        validate_identifier("message_id", &self.message_id)?;
        validate_identifier("idempotency_key", &self.idempotency_key)?;
        validate_identifier("delivery_service_id", &self.delivery_service_id)?;
        validate_digest(&self.request_sha256)?;
        validate_utc_timestamp("receipt.recorded_at", &self.recorded_at)?;
        if self.message_id != request.message_id || self.idempotency_key != request.idempotency_key
        {
            return Err("delivery receipt does not bind the request identity".into());
        }
        if self.request_sha256 != request.digest()? {
            return Err("delivery receipt request_sha256 does not match the exact request".into());
        }
        if self.delivery_attempt == 0 {
            return Err("delivery attempt must be positive".into());
        }
        if self.recorded_at < request.created_at {
            return Err("delivery receipt predates the request".into());
        }
        match &self.outcome {
            SessionDeliveryOutcomeV1::Acknowledged { remote_receipt_id } => {
                validate_identifier("remote_receipt_id", remote_receipt_id)?;
            }
            SessionDeliveryOutcomeV1::Rejected {
                reason_code,
                pre_send_proof_ref,
            } => {
                validate_bounded_token("reason_code", reason_code, 96)?;
                validate_identifier("pre_send_proof_ref", pre_send_proof_ref)?;
            }
            SessionDeliveryOutcomeV1::Uncertain { reason_code } => {
                validate_bounded_token("reason_code", reason_code, 96)?;
            }
        }
        Ok(())
    }
}

/// Classification returned when an adapter applies a receipt to its durable inbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryReplayDecisionV1 {
    /// No earlier receipt exists for this request.
    NewReceipt,
    /// Exact duplicate receipt; applying it again is a no-op.
    IdempotentReplay,
    /// A subsequent attempt is permitted only after a proven pre-send rejection.
    ExplicitRetryAfterProvenNotSent,
}

/// Compare an incoming receipt with the durable prior receipt for one request.
///
/// `previous_pre_send_proof_verified` must be set only after the caller has
/// authenticated and checked the referenced proof against the exact request,
/// attempt, lease and transport identity. A non-empty reference alone is not
/// proof. This is a pure classifier: it never sends, retries, acknowledges or
/// mutates persistence. UNCERTAIN and ACKNOWLEDGED are terminal for auto replay.
pub fn classify_delivery_replay(
    request: &SessionDeliveryRequestV1,
    previous: Option<&SessionDeliveryReceiptV1>,
    incoming: &SessionDeliveryReceiptV1,
    previous_pre_send_proof_verified: bool,
) -> Result<DeliveryReplayDecisionV1, String> {
    incoming.validate_for(request)?;
    let Some(previous) = previous else {
        return if incoming.delivery_attempt == 1 {
            Ok(DeliveryReplayDecisionV1::NewReceipt)
        } else {
            Err("initial delivery attempt must start at 1".into())
        };
    };
    previous.validate_for(request)?;
    if incoming.delivery_attempt == previous.delivery_attempt {
        return if incoming == previous {
            Ok(DeliveryReplayDecisionV1::IdempotentReplay)
        } else {
            Err("same delivery attempt has a conflicting durable receipt".into())
        };
    }
    if incoming.delivery_attempt != previous.delivery_attempt.saturating_add(1) {
        return Err("delivery attempt is stale or skips an attempt identity".into());
    }
    match &previous.outcome {
        SessionDeliveryOutcomeV1::Rejected {
            pre_send_proof_ref, ..
        } if !pre_send_proof_ref.is_empty() && previous_pre_send_proof_verified => {
            Ok(DeliveryReplayDecisionV1::ExplicitRetryAfterProvenNotSent)
        }
        SessionDeliveryOutcomeV1::Acknowledged { .. } => {
            Err("acknowledged delivery cannot be retried".into())
        }
        SessionDeliveryOutcomeV1::Uncertain { .. } => {
            Err("uncertain delivery cannot be automatically retried or replayed".into())
        }
        SessionDeliveryOutcomeV1::Rejected { .. } => {
            Err("rejected delivery lacks independently verified pre-send proof".into())
        }
    }
}

/// Session expiry observation; UNKNOWN is not treated as active or expired.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionExpiryObservationV1 {
    /// Contract version, currently `1.0`.
    pub contract_version: String,
    /// Observed session identity.
    pub session_id: String,
    /// Observer service identity supplied by the authenticated host.
    pub observer_service_id: String,
    /// Source session expiry time.
    pub expires_at: String,
    /// Canonical UTC time when the observation was made.
    pub observed_at: String,
    /// Explicit observation state.
    pub state: SessionExpiryStateV1,
}

/// Explicit expiry-observation states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SessionExpiryStateV1 {
    /// Observer established that the session had not yet reached expiry.
    Active,
    /// Observer established that the session expiry time had elapsed.
    Expired,
    /// Expiry could not be established; consumers must fail closed.
    Unknown,
}

impl SessionExpiryObservationV1 {
    /// Validate the observation's explicit time/state relationship.
    pub fn validate(&self) -> Result<(), String> {
        validate_contract_version(&self.contract_version)?;
        validate_identifier("session_id", &self.session_id)?;
        validate_identifier("observer_service_id", &self.observer_service_id)?;
        validate_utc_timestamp("expiry.expires_at", &self.expires_at)?;
        validate_utc_timestamp("expiry.observed_at", &self.observed_at)?;
        match self.state {
            SessionExpiryStateV1::Active if self.observed_at >= self.expires_at => {
                Err("ACTIVE expiry observation is at or after expires_at".into())
            }
            SessionExpiryStateV1::Expired if self.observed_at < self.expires_at => {
                Err("EXPIRED expiry observation predates expires_at".into())
            }
            _ => Ok(()),
        }
    }
}

pub(crate) fn validate_contract_version(value: &str) -> Result<(), String> {
    if value == CONTRACT_VERSION_V1 {
        Ok(())
    } else {
        Err("unsupported Workstream 5 contract version".into())
    }
}

pub(crate) fn validate_identifier(field: &str, value: &str) -> Result<(), String> {
    validate_bounded_token(field, value, MAX_ID_BYTES)
}

fn validate_bounded_token(field: &str, value: &str, max_bytes: usize) -> Result<(), String> {
    if value.is_empty()
        || value.len() > max_bytes
        || value.trim() != value
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:@/-".contains(&byte))
    {
        return Err(format!(
            "{field} is empty, non-canonical, or outside its bounded token grammar"
        ));
    }
    Ok(())
}

fn validate_digest(value: &str) -> Result<(), String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("SHA-256 digest must be 64 lowercase hexadecimal characters".into());
    }
    Ok(())
}

/// Strict UTC-second form: `YYYY-MM-DDTHH:MM:SSZ`.
/// Fractional seconds and offsets are deliberately excluded to keep bytewise ordering canonical.
pub(crate) fn validate_utc_timestamp(field: &str, value: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    let separators = [
        (4, b'-'),
        (7, b'-'),
        (10, b'T'),
        (13, b':'),
        (16, b':'),
        (19, b'Z'),
    ];
    if bytes.len() != 20
        || separators
            .iter()
            .any(|(index, expected)| bytes.get(*index) != Some(expected))
    {
        return Err(format!(
            "{field} must use canonical UTC-second format YYYY-MM-DDTHH:MM:SSZ"
        ));
    }
    for (index, byte) in bytes.iter().enumerate() {
        if ![4, 7, 10, 13, 16, 19].contains(&index) && !byte.is_ascii_digit() {
            return Err(format!("{field} contains a non-digit timestamp component"));
        }
    }
    let number =
        |start: usize, end: usize| -> u32 { value[start..end].parse::<u32>().unwrap_or_default() };
    let year = number(0, 4);
    let month = number(5, 7);
    let day = number(8, 10);
    let hour = number(11, 13);
    let minute = number(14, 16);
    let second = number(17, 19);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    if year == 0 || day == 0 || day > days || hour > 23 || minute > 59 || second > 59 {
        return Err(format!("{field} is not a valid UTC calendar timestamp"));
    }
    Ok(())
}

fn push_json_string(out: &mut String, value: &str) {
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c <= '\u{001f}' => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn write_source(out: &mut String, source: &ArtifactSourceV1) {
    out.push_str("{\"producer_id\":");
    push_json_string(out, &source.producer_id);
    out.push_str(",\"workflow_id\":");
    push_json_string(out, &source.workflow_id);
    out.push_str(",\"task_id\":");
    push_json_string(out, &source.task_id);
    let _ = write!(out, ",\"attempt\":{}", source.attempt);
    out.push_str(",\"correlation_id\":");
    push_json_string(out, &source.correlation_id);
    out.push_str(",\"created_at\":");
    push_json_string(out, &source.created_at);
    out.push('}');
}

fn write_artifact_ref(out: &mut String, artifact: &ArtifactRefV1) {
    out.push_str("{\"contract_version\":");
    push_json_string(out, &artifact.contract_version);
    out.push_str(",\"artifact_id\":");
    push_json_string(out, &artifact.artifact_id);
    out.push_str(",\"sha256\":");
    push_json_string(out, &artifact.sha256);
    let _ = write!(out, ",\"byte_len\":{}", artifact.byte_len);
    out.push_str(",\"media_type\":");
    push_json_string(out, &artifact.media_type);
    out.push_str(",\"content_schema_id\":");
    write_optional_json_string(out, artifact.content_schema_id.as_deref());
    out.push_str(",\"content_schema_version\":");
    write_optional_json_string(out, artifact.content_schema_version.as_deref());
    out.push_str(",\"source\":");
    write_source(out, &artifact.source);
    out.push('}');
}

fn write_lineage(out: &mut String, lineage: &ArtifactLineageV1) {
    out.push_str("{\"contract_version\":");
    push_json_string(out, &lineage.contract_version);
    out.push_str(",\"producer_id\":");
    push_json_string(out, &lineage.producer_id);
    out.push_str(",\"workflow_id\":");
    push_json_string(out, &lineage.workflow_id);
    out.push_str(",\"task_id\":");
    push_json_string(out, &lineage.task_id);
    let _ = write!(out, ",\"attempt\":{}", lineage.attempt);
    out.push_str(",\"correlation_id\":");
    push_json_string(out, &lineage.correlation_id);
    out.push_str(",\"created_at\":");
    push_json_string(out, &lineage.created_at);
    out.push_str(",\"parent_artifacts\":[");
    for (index, parent) in lineage.parent_artifacts.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_artifact_ref(out, parent);
    }
    out.push_str("]}");
}

fn write_optional_json_string(out: &mut String, value: Option<&str>) {
    match value {
        Some(value) => push_json_string(out, value),
        None => out.push_str("null"),
    }
}

fn write_session_ref(out: &mut String, session: &SessionRefV1) {
    out.push_str("{\"contract_version\":");
    push_json_string(out, &session.contract_version);
    out.push_str(",\"session_id\":");
    push_json_string(out, &session.session_id);
    out.push_str(",\"workflow_id\":");
    push_json_string(out, &session.workflow_id);
    out.push_str(",\"task_id\":");
    push_json_string(out, &session.task_id);
    let _ = write!(out, ",\"attempt\":{}", session.attempt);
    out.push_str(",\"owner_service_id\":");
    push_json_string(out, &session.owner_service_id);
    out.push_str(",\"created_at\":");
    push_json_string(out, &session.created_at);
    out.push_str(",\"expires_at\":");
    push_json_string(out, &session.expires_at);
    out.push('}');
}

#[cfg(test)]
mod tests {
    use super::*;

    const CREATED: &str = "2026-11-03T03:00:00Z";
    const EXPIRES: &str = "2026-11-03T04:00:00Z";

    fn source() -> ArtifactSourceV1 {
        ArtifactSourceV1 {
            producer_id: "worker.exec-1".into(),
            workflow_id: "wf-1".into(),
            task_id: "task-1".into(),
            attempt: 2,
            correlation_id: "corr-1".into(),
            created_at: CREATED.into(),
        }
    }

    fn artifact() -> ArtifactRefV1 {
        let sha256 = "a".repeat(64);
        ArtifactRefV1 {
            contract_version: CONTRACT_VERSION_V1.into(),
            artifact_id: format!("sha256:{sha256}"),
            sha256,
            byte_len: 17,
            media_type: "application/json".into(),
            content_schema_id: Some("runalith.execution-result".into()),
            content_schema_version: Some("1.0".into()),
            source: source(),
        }
    }

    fn session() -> SessionRefV1 {
        SessionRefV1 {
            contract_version: CONTRACT_VERSION_V1.into(),
            session_id: "session-1".into(),
            workflow_id: "wf-1".into(),
            task_id: "task-1".into(),
            attempt: 2,
            owner_service_id: "worker.exec-1".into(),
            created_at: CREATED.into(),
            expires_at: EXPIRES.into(),
        }
    }

    fn request() -> SessionDeliveryRequestV1 {
        SessionDeliveryRequestV1 {
            contract_version: CONTRACT_VERSION_V1.into(),
            message_id: "msg-1".into(),
            idempotency_key: "delivery-1".into(),
            session: session(),
            sender_service_id: "worker.exec-1".into(),
            recipient_subject_id: "agent.qa".into(),
            payload: artifact(),
            created_at: "2026-11-03T03:01:00Z".into(),
            expires_at: EXPIRES.into(),
        }
    }

    fn receipt(
        request: &SessionDeliveryRequestV1,
        attempt: u64,
        outcome: SessionDeliveryOutcomeV1,
    ) -> SessionDeliveryReceiptV1 {
        SessionDeliveryReceiptV1 {
            contract_version: CONTRACT_VERSION_V1.into(),
            message_id: request.message_id.clone(),
            idempotency_key: request.idempotency_key.clone(),
            request_sha256: request.digest().unwrap(),
            delivery_attempt: attempt,
            delivery_service_id: "worker.exec-1".into(),
            outcome,
            recorded_at: "2026-11-03T03:02:00Z".into(),
        }
    }

    #[test]
    fn artifact_manifest_encodes_deterministically_and_binds_attempt_lineage() {
        let reference = artifact();
        let manifest = ArtifactManifestV1 {
            contract_version: CONTRACT_VERSION_V1.into(),
            created_at: "2026-11-03T03:03:00Z".into(),
            artifacts: vec![reference],
            lineage: ArtifactLineageV1 {
                contract_version: CONTRACT_VERSION_V1.into(),
                producer_id: "worker.exec-1".into(),
                workflow_id: "wf-1".into(),
                task_id: "task-1".into(),
                attempt: 2,
                correlation_id: "corr-1".into(),
                created_at: CREATED.into(),
                parent_artifacts: vec![],
            },
        };
        let first = manifest.canonical_json_bytes().unwrap();
        assert_eq!(first, manifest.canonical_json_bytes().unwrap());
        assert!(
            std::str::from_utf8(&first)
                .unwrap()
                .contains("\"attempt\":2")
        );
    }

    #[test]
    fn artifact_manifest_rejects_cross_attempt_or_duplicate_lineage() {
        let mut reference = artifact();
        reference.source.attempt = 3;
        let manifest = ArtifactManifestV1 {
            contract_version: CONTRACT_VERSION_V1.into(),
            created_at: "2026-11-03T03:03:00Z".into(),
            artifacts: vec![reference],
            lineage: ArtifactLineageV1 {
                contract_version: CONTRACT_VERSION_V1.into(),
                producer_id: "worker.exec-1".into(),
                workflow_id: "wf-1".into(),
                task_id: "task-1".into(),
                attempt: 2,
                correlation_id: "corr-1".into(),
                created_at: CREATED.into(),
                parent_artifacts: vec![],
            },
        };
        assert!(manifest.validate().unwrap_err().contains("does not match"));
    }

    #[test]
    fn artifact_reference_rejects_forged_content_identity_and_partial_schema() {
        let mut reference = artifact();
        reference.artifact_id = format!("sha256:{}", "b".repeat(64));
        assert!(reference.validate().unwrap_err().contains("does not bind"));
        let mut reference = artifact();
        reference.content_schema_version = None;
        assert!(
            reference
                .validate()
                .unwrap_err()
                .contains("supplied together")
        );
    }

    #[test]
    fn session_acl_requires_explicit_unexpired_grant() {
        let acl = SessionAclV1 {
            session: session(),
            grants: vec![SessionGrantV1 {
                subject_id: "agent.qa".into(),
                permissions: vec![SessionPermissionV1::Read, SessionPermissionV1::Send],
                expires_at: "2026-11-03T03:30:00Z".into(),
            }],
        };
        assert!(
            acl.allows(
                "agent.qa",
                SessionPermissionV1::Send,
                "2026-11-03T03:10:00Z"
            )
            .unwrap()
        );
        assert!(
            !acl.allows(
                "agent.qa",
                SessionPermissionV1::Acknowledge,
                "2026-11-03T03:10:00Z"
            )
            .unwrap()
        );
        assert!(
            !acl.allows(
                "agent.qa",
                SessionPermissionV1::Read,
                "2026-11-03T03:30:00Z"
            )
            .unwrap()
        );
        assert!(
            !acl.allows(
                "agent.other",
                SessionPermissionV1::Read,
                "2026-11-03T03:10:00Z"
            )
            .unwrap()
        );
    }

    #[test]
    fn session_acl_rejects_duplicate_subject_grants_and_implicit_empty_acl() {
        let grant = SessionGrantV1 {
            subject_id: "agent.qa".into(),
            permissions: vec![SessionPermissionV1::Read],
            expires_at: EXPIRES.into(),
        };
        let duplicate = SessionAclV1 {
            session: session(),
            grants: vec![grant.clone(), grant],
        };
        assert!(
            duplicate
                .validate()
                .unwrap_err()
                .contains("duplicate subject")
        );
        let empty = SessionAclV1 {
            session: session(),
            grants: vec![],
        };
        assert!(
            !empty
                .allows(
                    "agent.qa",
                    SessionPermissionV1::Read,
                    "2026-11-03T03:10:00Z"
                )
                .unwrap()
        );
    }

    #[test]
    fn delivery_request_is_digest_bound_to_session_and_payload_attempt() {
        let original = request();
        assert!(original.validate().is_ok());
        assert_eq!(original.digest().unwrap(), original.digest().unwrap());
        let mut tampered = original.clone();
        tampered.recipient_subject_id = "agent.other".into();
        assert_ne!(tampered.digest().unwrap(), original.digest().unwrap());
    }

    #[test]
    fn delivery_request_rejects_expired_session_and_wrong_payload_attempt() {
        let mut expired = request();
        expired.expires_at = "2026-11-03T04:01:00Z".into();
        assert!(expired.validate().unwrap_err().contains("session lifetime"));
        let mut mismatched = request();
        mismatched.payload.source.attempt = 1;
        assert!(
            mismatched
                .validate()
                .unwrap_err()
                .contains("does not match")
        );
    }

    #[test]
    fn exact_ack_receipt_is_idempotent_but_changed_receipt_conflicts() {
        let request = request();
        let prior = receipt(
            &request,
            1,
            SessionDeliveryOutcomeV1::Acknowledged {
                remote_receipt_id: "remote-ack-1".into(),
            },
        );
        assert_eq!(
            classify_delivery_replay(&request, None, &prior, false).unwrap(),
            DeliveryReplayDecisionV1::NewReceipt
        );
        assert_eq!(
            classify_delivery_replay(&request, Some(&prior), &prior, false).unwrap(),
            DeliveryReplayDecisionV1::IdempotentReplay
        );
        let changed = receipt(
            &request,
            1,
            SessionDeliveryOutcomeV1::Acknowledged {
                remote_receipt_id: "remote-ack-2".into(),
            },
        );
        assert!(
            classify_delivery_replay(&request, Some(&prior), &changed, false)
                .unwrap_err()
                .contains("conflicting")
        );
    }

    #[test]
    fn uncertain_delivery_is_never_automatically_replayed() {
        let request = request();
        let prior = receipt(
            &request,
            1,
            SessionDeliveryOutcomeV1::Uncertain {
                reason_code: "timeout_after_send".into(),
            },
        );
        let next = receipt(
            &request,
            2,
            SessionDeliveryOutcomeV1::Acknowledged {
                remote_receipt_id: "later-ack".into(),
            },
        );
        assert!(
            classify_delivery_replay(&request, Some(&prior), &next, false)
                .unwrap_err()
                .contains("uncertain delivery")
        );
    }

    #[test]
    fn only_proven_pre_send_rejection_allows_explicit_successor_attempt() {
        let request = request();
        let prior = receipt(
            &request,
            1,
            SessionDeliveryOutcomeV1::Rejected {
                reason_code: "not_sent".into(),
                pre_send_proof_ref: "proof-123".into(),
            },
        );
        let next = receipt(
            &request,
            2,
            SessionDeliveryOutcomeV1::Acknowledged {
                remote_receipt_id: "remote-ack-2".into(),
            },
        );
        assert_eq!(
            classify_delivery_replay(&request, Some(&prior), &next, true).unwrap(),
            DeliveryReplayDecisionV1::ExplicitRetryAfterProvenNotSent
        );
        let next = receipt(
            &request,
            3,
            SessionDeliveryOutcomeV1::Acknowledged {
                remote_receipt_id: "remote-ack-3".into(),
            },
        );
        assert!(
            classify_delivery_replay(&request, Some(&prior), &next, true)
                .unwrap_err()
                .contains("skips")
        );
    }

    #[test]
    fn proof_reference_alone_does_not_authorize_delivery_retry() {
        let request = request();
        let prior = receipt(
            &request,
            1,
            SessionDeliveryOutcomeV1::Rejected {
                reason_code: "not_sent".into(),
                pre_send_proof_ref: "proof-123".into(),
            },
        );
        let next = receipt(
            &request,
            2,
            SessionDeliveryOutcomeV1::Acknowledged {
                remote_receipt_id: "remote-ack-2".into(),
            },
        );
        assert!(
            classify_delivery_replay(&request, Some(&prior), &next, false)
                .unwrap_err()
                .contains("independently verified")
        );
    }

    #[test]
    fn initial_delivery_receipt_cannot_skip_attempt_identity() {
        let request = request();
        let skipped = receipt(
            &request,
            2,
            SessionDeliveryOutcomeV1::Acknowledged {
                remote_receipt_id: "remote-ack-2".into(),
            },
        );
        assert!(
            classify_delivery_replay(&request, None, &skipped, false)
                .unwrap_err()
                .contains("must start at 1")
        );
    }

    #[test]
    fn receipt_cannot_bind_a_changed_request_body() {
        let request = request();
        let receipt = receipt(
            &request,
            1,
            SessionDeliveryOutcomeV1::Uncertain {
                reason_code: "unknown".into(),
            },
        );
        let mut changed = request;
        changed.recipient_subject_id = "agent.changed".into();
        assert!(
            receipt
                .validate_for(&changed)
                .unwrap_err()
                .contains("request_sha256")
        );
    }

    #[test]
    fn session_expiry_observation_keeps_unknown_distinct() {
        let unknown = SessionExpiryObservationV1 {
            contract_version: CONTRACT_VERSION_V1.into(),
            session_id: "session-1".into(),
            observer_service_id: "worker.exec-1".into(),
            expires_at: EXPIRES.into(),
            observed_at: "2026-11-03T04:00:00Z".into(),
            state: SessionExpiryStateV1::Unknown,
        };
        assert!(unknown.validate().is_ok());
        let active_after_expiry = SessionExpiryObservationV1 {
            state: SessionExpiryStateV1::Active,
            ..unknown
        };
        assert!(
            active_after_expiry
                .validate()
                .unwrap_err()
                .contains("ACTIVE")
        );
    }

    #[test]
    fn timestamp_and_token_grammars_reject_noncanonical_inputs() {
        assert!(validate_utc_timestamp("ts", "2026-02-30T03:00:00Z").is_err());
        assert!(validate_utc_timestamp("ts", "2026-11-03T03:00:00+07:00").is_err());
        assert!(validate_identifier("id", "task 1").is_err());
        assert!(validate_identifier("id", " task-1").is_err());
    }
}
