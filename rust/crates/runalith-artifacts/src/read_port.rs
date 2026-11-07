//! Versioned read-only artifact observation port.
//!
//! This module defines W5-owned retrieval and byte-integrity semantics. It does
//! not authenticate a peer, authorize a workflow, establish manifest
//! completeness/freshness, or expose a network route. The Execution host must
//! authenticate and authorize a caller before invoking this port. A host may
//! produce `NOT_AUTHORIZED` without calling the local filesystem adapter.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    ArtifactError, ArtifactStore,
    contracts::{
        ArtifactRefV1, validate_contract_version, validate_identifier, validate_utc_timestamp,
    },
};

/// Stable version of the W5 semantic artifact read port.
pub const ARTIFACT_READ_PORT_VERSION_V1: &str = "1.0";
/// Maximum serialized request/observation metadata size; payload bytes are separate.
pub const MAX_ARTIFACT_READ_METADATA_BYTES: usize = 16 * 1024;

/// Point-in-time result of looking up one exact immutable artifact reference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ArtifactReadDispositionV1 {
    /// Exact referenced bytes were read and their digest/length verified.
    Available,
    /// The object did not exist at this observation time; this is not proof it
    /// was never created or that a producer result is false.
    NotFound,
    /// The backing storage was unavailable for this observation.
    Unavailable,
    /// The reference, object path or stored bytes failed integrity/policy checks.
    IntegrityFailure,
    /// The host rejected the authenticated caller before any object read.
    NotAuthorized,
}

/// Read-only request containing the caller-supplied exact immutable reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactReadRequestV1 {
    /// Read-port contract version, currently `1.0`.
    pub contract_version: String,
    /// Bounded request identity assigned by the authenticated host/consumer.
    pub request_id: String,
    /// Stable workflow/request correlation identity.
    pub correlation_id: String,
    /// Expected immutable object identity and producer/task metadata.
    pub artifact: ArtifactRefV1,
}

impl ArtifactReadRequestV1 {
    /// Validate the exact lookup subject without authenticating its caller.
    pub fn validate(&self) -> Result<(), String> {
        validate_contract_version(&self.contract_version)?;
        if self.contract_version != ARTIFACT_READ_PORT_VERSION_V1 {
            return Err("unsupported artifact read-port version".into());
        }
        validate_identifier("artifact_read.request_id", &self.request_id)?;
        validate_identifier("artifact_read.correlation_id", &self.correlation_id)?;
        self.artifact.validate()?;
        Ok(())
    }

    /// Serialize a validated request as compact, fixed-field-order UTF-8 JSON.
    pub fn canonical_json_bytes(&self) -> Result<Vec<u8>, String> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|error| error.to_string())?;
        if bytes.len() > MAX_ARTIFACT_READ_METADATA_BYTES {
            return Err("artifact read request metadata exceeds 16 KiB".into());
        }
        Ok(bytes)
    }

    /// Parse bounded strict JSON. Unknown and duplicate fields are rejected.
    pub fn from_json_bytes(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > MAX_ARTIFACT_READ_METADATA_BYTES {
            return Err("artifact read request metadata exceeds 16 KiB".into());
        }
        let request: Self = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
        request.validate()?;
        Ok(request)
    }
}

/// Auditable, point-in-time metadata for one artifact read attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactReadObservationV1 {
    /// Read-port contract version, currently `1.0`.
    pub contract_version: String,
    /// Request identity copied from the exact request.
    pub request_id: String,
    /// Observation identity copied from the host-assigned lookup attempt.
    pub observation_id: String,
    /// Authenticated Execution service identity supplied by the host transport.
    /// It must not be parsed from caller-controlled request JSON.
    pub source_service_id: String,
    /// Correlation identity copied from the exact request.
    pub correlation_id: String,
    /// Exact requested object identity.
    pub artifact_id: String,
    /// Expected exact-byte SHA-256 from the reference.
    pub expected_sha256: String,
    /// Expected exact byte length from the reference.
    pub expected_byte_len: u64,
    /// Declared content media type from the reference.
    pub media_type: String,
    /// Host-observed canonical UTC time for this lookup attempt.
    pub observed_at: String,
    /// Point-in-time result; not a completeness or freshness assertion.
    pub disposition: ArtifactReadDispositionV1,
    /// Present only when AVAILABLE and equal to the verified exact-byte digest.
    pub observed_sha256: Option<String>,
    /// Present only when AVAILABLE and equal to the verified exact byte length.
    pub observed_byte_len: Option<u64>,
}

impl ArtifactReadObservationV1 {
    /// Validate that the observation describes one consistent point-in-time result.
    pub fn validate_for(
        &self,
        request: &ArtifactReadRequestV1,
        authenticated_source_service_id: &str,
        observation_id: &str,
        observed_at: &str,
    ) -> Result<(), String> {
        request.validate()?;
        if self.contract_version != ARTIFACT_READ_PORT_VERSION_V1
            || self.request_id != request.request_id
            || self.observation_id != observation_id
            || self.source_service_id != authenticated_source_service_id
            || self.correlation_id != request.correlation_id
            || self.artifact_id != request.artifact.artifact_id
            || self.expected_sha256 != request.artifact.sha256
            || self.expected_byte_len != request.artifact.byte_len
            || self.media_type != request.artifact.media_type
            || self.observed_at != observed_at
        {
            return Err("artifact read observation does not match its request".into());
        }
        validate_identifier("artifact_read.request_id", &self.request_id)?;
        validate_identifier("artifact_read.observation_id", &self.observation_id)?;
        validate_identifier("artifact_read.source_service_id", &self.source_service_id)?;
        validate_identifier("artifact_read.correlation_id", &self.correlation_id)?;
        validate_utc_timestamp("artifact_read.observed_at", &self.observed_at)?;
        match self.disposition {
            ArtifactReadDispositionV1::Available => {
                if self.observed_sha256.as_deref() != Some(request.artifact.sha256.as_str())
                    || self.observed_byte_len != Some(request.artifact.byte_len)
                {
                    return Err("AVAILABLE observation does not bind the expected bytes".into());
                }
            }
            ArtifactReadDispositionV1::NotFound
            | ArtifactReadDispositionV1::Unavailable
            | ArtifactReadDispositionV1::IntegrityFailure
            | ArtifactReadDispositionV1::NotAuthorized => {
                if self.observed_sha256.is_some() || self.observed_byte_len.is_some() {
                    return Err("non-AVAILABLE observation cannot claim observed bytes".into());
                }
            }
        }
        Ok(())
    }

    /// Serialize a validated observation as compact, fixed-field-order UTF-8 JSON.
    pub fn canonical_json_bytes(
        &self,
        request: &ArtifactReadRequestV1,
        authenticated_source_service_id: &str,
        observation_id: &str,
        observed_at: &str,
    ) -> Result<Vec<u8>, String> {
        self.validate_for(
            request,
            authenticated_source_service_id,
            observation_id,
            observed_at,
        )?;
        let bytes = serde_json::to_vec(self).map_err(|error| error.to_string())?;
        if bytes.len() > MAX_ARTIFACT_READ_METADATA_BYTES {
            return Err("artifact read observation metadata exceeds 16 KiB".into());
        }
        Ok(bytes)
    }

    /// Parse a bounded strict observation against its exact request and host
    /// transport identity. Unknown and duplicate fields are rejected.
    pub fn from_json_bytes(
        bytes: &[u8],
        request: &ArtifactReadRequestV1,
        authenticated_source_service_id: &str,
        observation_id: &str,
        observed_at: &str,
    ) -> Result<Self, String> {
        if bytes.len() > MAX_ARTIFACT_READ_METADATA_BYTES {
            return Err("artifact read observation metadata exceeds 16 KiB".into());
        }
        let observation: Self = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
        observation.validate_for(
            request,
            authenticated_source_service_id,
            observation_id,
            observed_at,
        )?;
        Ok(observation)
    }
}

/// Exact bytes plus their separate auditable read observation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactReadResultV1 {
    /// Point-in-time read observation safe to serialize over a future host route.
    pub observation: ArtifactReadObservationV1,
    /// Exact bytes only for an AVAILABLE outcome; wire encoding is transport-owned.
    pub bytes: Option<Vec<u8>>,
}

impl ArtifactReadResultV1 {
    /// Construct an authorization denial without touching artifact storage.
    ///
    /// The caller must have already authenticated the peer and made the host
    /// authorization decision. This function does not make that decision.
    pub fn not_authorized(
        request: &ArtifactReadRequestV1,
        authenticated_source_service_id: &str,
        observation_id: &str,
        observed_at: &str,
    ) -> Result<Self, ArtifactReadPortError> {
        request
            .validate()
            .map_err(ArtifactReadPortError::InvalidRequest)?;
        validate_identifier(
            "artifact_read.source_service_id",
            authenticated_source_service_id,
        )
        .map_err(ArtifactReadPortError::InvalidRequest)?;
        validate_identifier("artifact_read.observation_id", observation_id)
            .map_err(ArtifactReadPortError::InvalidRequest)?;
        validate_utc_timestamp("artifact_read.observed_at", observed_at)
            .map_err(ArtifactReadPortError::InvalidRequest)?;
        Ok(Self {
            observation: observation_for(
                request,
                authenticated_source_service_id,
                observation_id,
                observed_at,
                ArtifactReadDispositionV1::NotAuthorized,
                None,
            ),
            bytes: None,
        })
    }

    /// Validate raw bytes and the observation as a single consistent result.
    pub fn validate_for(
        &self,
        request: &ArtifactReadRequestV1,
        authenticated_source_service_id: &str,
        observation_id: &str,
        observed_at: &str,
    ) -> Result<(), String> {
        self.observation.validate_for(
            request,
            authenticated_source_service_id,
            observation_id,
            observed_at,
        )?;
        match self.observation.disposition {
            ArtifactReadDispositionV1::Available => {
                let bytes = self
                    .bytes
                    .as_deref()
                    .ok_or_else(|| "AVAILABLE result is missing exact bytes".to_string())?;
                if bytes.len() as u64 != request.artifact.byte_len
                    || sha256(bytes) != request.artifact.sha256
                {
                    return Err(
                        "AVAILABLE result bytes do not match the immutable reference".into(),
                    );
                }
            }
            _ if self.bytes.is_some() => {
                return Err("non-AVAILABLE result cannot contain artifact bytes".into());
            }
            _ => {}
        }
        Ok(())
    }
}

/// Request validation error for the local semantic read port.
#[derive(Debug, Error)]
pub enum ArtifactReadPortError {
    /// The caller supplied a malformed or unsupported typed request.
    #[error("invalid artifact read request: {0}")]
    InvalidRequest(String),
}

/// W5-owned read-only artifact retrieval semantics.
pub trait ArtifactReadPort: Send + Sync {
    /// Observe and, only when AVAILABLE, return the exact referenced bytes.
    /// `authenticated_source_service_id` must come from an already-verified
    /// Execution host transport context, not from request JSON. This local
    /// port records the identity but does not authenticate it.
    fn read_artifact(
        &self,
        request: &ArtifactReadRequestV1,
        authenticated_source_service_id: &str,
        observation_id: &str,
        observed_at: &str,
    ) -> Result<ArtifactReadResultV1, ArtifactReadPortError>;
}

impl ArtifactReadPort for ArtifactStore {
    fn read_artifact(
        &self,
        request: &ArtifactReadRequestV1,
        authenticated_source_service_id: &str,
        observation_id: &str,
        observed_at: &str,
    ) -> Result<ArtifactReadResultV1, ArtifactReadPortError> {
        request
            .validate()
            .map_err(ArtifactReadPortError::InvalidRequest)?;
        validate_identifier(
            "artifact_read.source_service_id",
            authenticated_source_service_id,
        )
        .map_err(ArtifactReadPortError::InvalidRequest)?;
        validate_identifier("artifact_read.observation_id", observation_id)
            .map_err(ArtifactReadPortError::InvalidRequest)?;
        validate_utc_timestamp("artifact_read.observed_at", observed_at)
            .map_err(ArtifactReadPortError::InvalidRequest)?;
        let (disposition, bytes) = match self.read_ref(&request.artifact) {
            Ok(bytes) => (ArtifactReadDispositionV1::Available, Some(bytes)),
            Err(ArtifactError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                (ArtifactReadDispositionV1::NotFound, None)
            }
            Err(ArtifactError::Io(_)) => (ArtifactReadDispositionV1::Unavailable, None),
            Err(ArtifactError::Integrity(_) | ArtifactError::Policy(_)) => {
                (ArtifactReadDispositionV1::IntegrityFailure, None)
            }
        };
        let observed = bytes
            .as_deref()
            .map(|value| (sha256(value), value.len() as u64));
        let result = ArtifactReadResultV1 {
            observation: observation_for(
                request,
                authenticated_source_service_id,
                observation_id,
                observed_at,
                disposition,
                observed,
            ),
            bytes,
        };
        result
            .validate_for(
                request,
                authenticated_source_service_id,
                observation_id,
                observed_at,
            )
            .map_err(ArtifactReadPortError::InvalidRequest)?;
        Ok(result)
    }
}

fn observation_for(
    request: &ArtifactReadRequestV1,
    authenticated_source_service_id: &str,
    observation_id: &str,
    observed_at: &str,
    disposition: ArtifactReadDispositionV1,
    observed: Option<(String, u64)>,
) -> ArtifactReadObservationV1 {
    ArtifactReadObservationV1 {
        contract_version: ARTIFACT_READ_PORT_VERSION_V1.into(),
        request_id: request.request_id.clone(),
        observation_id: observation_id.into(),
        source_service_id: authenticated_source_service_id.into(),
        correlation_id: request.correlation_id.clone(),
        artifact_id: request.artifact.artifact_id.clone(),
        expected_sha256: request.artifact.sha256.clone(),
        expected_byte_len: request.artifact.byte_len,
        media_type: request.artifact.media_type.clone(),
        observed_at: observed_at.into(),
        disposition,
        observed_sha256: observed.as_ref().map(|(digest, _)| digest.clone()),
        observed_byte_len: observed.map(|(_, byte_len)| byte_len),
    }
}

fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;
    use crate::contracts::{ArtifactSourceV1, CONTRACT_VERSION_V1};

    const OBSERVED_AT: &str = "2026-11-03T10:01:00Z";
    const SOURCE_SERVICE_ID: &str = "execution.worker-reader";

    fn request_for(store: &ArtifactStore, bytes: &[u8]) -> ArtifactReadRequestV1 {
        let stored = store.put("application/json", bytes).unwrap();
        request_for_ref(crate::contracts::ArtifactRefV1 {
            contract_version: CONTRACT_VERSION_V1.into(),
            artifact_id: stored.artifact_id,
            sha256: stored.sha256,
            byte_len: stored.byte_len,
            media_type: stored.media_type,
            content_schema_id: Some("runalith.execution-result".into()),
            content_schema_version: Some("1.0".into()),
            source: ArtifactSourceV1 {
                producer_id: "execution.worker".into(),
                workflow_id: "workflow-42".into(),
                task_id: "task-7".into(),
                attempt: 3,
                correlation_id: "corr-42".into(),
                created_at: "2026-11-03T10:00:00Z".into(),
            },
        })
    }

    fn request_for_ref(artifact: ArtifactRefV1) -> ArtifactReadRequestV1 {
        ArtifactReadRequestV1 {
            contract_version: ARTIFACT_READ_PORT_VERSION_V1.into(),
            request_id: "read-request-1".into(),
            correlation_id: "corr-42".into(),
            artifact,
        }
    }

    #[test]
    fn available_read_returns_exact_bytes_and_a_digest_bound_observation() {
        let directory = tempdir().unwrap();
        let store = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let bytes = br#"{"result":"ok"}"#;
        let request = request_for(&store, bytes);
        let result = store
            .read_artifact(
                &request,
                SOURCE_SERVICE_ID,
                "read-observation-1",
                OBSERVED_AT,
            )
            .unwrap();
        assert_eq!(
            result.observation.disposition,
            ArtifactReadDispositionV1::Available
        );
        assert_eq!(result.bytes.as_deref(), Some(bytes.as_slice()));
        result
            .validate_for(
                &request,
                SOURCE_SERVICE_ID,
                "read-observation-1",
                OBSERVED_AT,
            )
            .unwrap();
    }

    #[test]
    fn not_found_is_a_point_in_time_observation_and_never_returns_bytes() {
        let directory = tempdir().unwrap();
        let store = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let request = request_for(&store, b"will be removed");
        let path = store
            .root_path()
            .join(&request.artifact.sha256[..2])
            .join(&request.artifact.sha256);
        fs::remove_file(path).unwrap();
        let result = store
            .read_artifact(
                &request,
                SOURCE_SERVICE_ID,
                "read-observation-2",
                "2026-11-03T10:02:00Z",
            )
            .unwrap();
        assert_eq!(
            result.observation.disposition,
            ArtifactReadDispositionV1::NotFound
        );
        assert!(result.bytes.is_none());
        result
            .validate_for(
                &request,
                SOURCE_SERVICE_ID,
                "read-observation-2",
                "2026-11-03T10:02:00Z",
            )
            .unwrap();
    }

    #[test]
    fn corrupt_content_is_reported_as_integrity_failure_without_bytes() {
        let directory = tempdir().unwrap();
        let store = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let request = request_for(&store, b"immutable");
        let path = store
            .root_path()
            .join(&request.artifact.sha256[..2])
            .join(&request.artifact.sha256);
        fs::write(path, b"tampered").unwrap();
        let result = store
            .read_artifact(
                &request,
                SOURCE_SERVICE_ID,
                "read-observation-3",
                "2026-11-03T10:03:00Z",
            )
            .unwrap();
        assert_eq!(
            result.observation.disposition,
            ArtifactReadDispositionV1::IntegrityFailure
        );
        assert!(result.bytes.is_none());
        result
            .validate_for(
                &request,
                SOURCE_SERVICE_ID,
                "read-observation-3",
                "2026-11-03T10:03:00Z",
            )
            .unwrap();
    }

    #[test]
    fn not_authorized_observation_can_be_returned_without_touching_storage() {
        let directory = tempdir().unwrap();
        let store = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let request = request_for(&store, b"host-private");
        let denied = ArtifactReadResultV1::not_authorized(
            &request,
            SOURCE_SERVICE_ID,
            "read-observation-4",
            "2026-11-03T10:04:00Z",
        )
        .unwrap();
        assert_eq!(
            denied.observation.disposition,
            ArtifactReadDispositionV1::NotAuthorized
        );
        assert!(denied.bytes.is_none());
        denied
            .validate_for(
                &request,
                SOURCE_SERVICE_ID,
                "read-observation-4",
                "2026-11-03T10:04:00Z",
            )
            .unwrap();
    }

    #[test]
    fn read_request_rejects_tampered_reference_and_host_time_is_canonical() {
        let directory = tempdir().unwrap();
        let store = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let mut request = request_for(&store, b"validate");
        request.artifact.byte_len += 1;
        assert!(request.validate().is_ok());
        assert!(
            store
                .read_artifact(
                    &request,
                    SOURCE_SERVICE_ID,
                    "read-observation-5",
                    "2026-11-03T10:01:00+00:00"
                )
                .is_err()
        );
        let result = store
            .read_artifact(
                &request,
                SOURCE_SERVICE_ID,
                "read-observation-5",
                OBSERVED_AT,
            )
            .unwrap();
        assert_eq!(
            result.observation.disposition,
            ArtifactReadDispositionV1::IntegrityFailure
        );
        assert!(result.bytes.is_none());
    }
}
