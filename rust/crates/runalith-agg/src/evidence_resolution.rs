//! Governance-owned seam for authenticated, read-only Execution evidence resolution.
//!
//! The adapter must authenticate the remote Execution service before it returns
//! a response, bind that peer to the configured service identity, and fetch bytes
//! only through the source owner's read-only contract. This module then verifies
//! the versioned response, exact subject/audience binding, returned byte count,
//! content digest and producer lineage. It never upgrades `GraphEvidence` to
//! `Verified` and does not access Execution's database or artifact filesystem.

use runalith_domain::GraphSnapshot;
use runalith_protocol::evidence_resolution_v1::{
    EvidenceResolutionContractError, EvidenceResolutionRequestV1, EvidenceResolutionResponseV1,
};
use runalith_protocol::evidence_verification_v1::EvidenceVerificationSubjectV1;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Maximum exact source content accepted by Governance.
pub const MAX_RESOLVED_EVIDENCE_BYTES: usize = 64 * 1024 * 1024;
/// Maximum combined source bytes hashed for one snapshot attestation request.
/// This is independent of the per-source cap and bounds aggregate CPU/I/O work.
pub const MAX_SNAPSHOT_RESOLVED_EVIDENCE_BYTES: usize = 256 * 1024 * 1024;

/// Failure classification for the authenticated evidence-resolution seam.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceResolutionFailureClass {
    /// Source service, transport or durable source is unavailable.
    Unavailable,
    /// Response, bytes, digest or producer lineage is invalid.
    Invalid,
    /// The authenticated responder is not the configured source owner.
    Unauthorized,
}

/// Stable failure returned by the Governance evidence-resolution interface.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceResolutionFailure {
    /// Classification used by upper-layer status and retry policy.
    pub class: EvidenceResolutionFailureClass,
    /// Stable machine-readable code; do not retry an invalid or unauthorized response.
    pub code: &'static str,
}

/// Result returned by an authenticated Execution evidence adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedEvidenceSource {
    /// Versioned response metadata from the authenticated source owner.
    pub response: EvidenceResolutionResponseV1,
    /// Exact bytes returned by the source owner, not a caller-provided path.
    pub source_bytes: Vec<u8>,
}

/// Authenticated read-only source-resolution seam owned by Governance.
///
/// Implementations must authenticate the remote peer before trusting any
/// response field, verify that peer against the configured Execution service
/// identity, and call the source-owning service rather than opening Execution
/// databases/files directly. They must not mutate source state, create evidence,
/// or make claim-verification decisions. Transport failure is `Unavailable`;
/// authentication failure is `Unauthorized`; malformed or misbound responses
/// are `Invalid`. No production adapter is provided until Execution publishes
/// and provisions the corresponding authenticated read-only contract.
pub trait AuthenticatedEvidenceSourceResolver: Send + Sync {
    /// Resolve one exact source reference through the authenticated owner service.
    fn resolve_read_only(
        &self,
        request: &EvidenceResolutionRequestV1,
        expected_peer_identity: &str,
    ) -> Result<ResolvedEvidenceSource, EvidenceResolutionAdapterError>;
}

/// Non-authorizing integrity result after authenticated source resolution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceSourceResolutionIntegrity {
    /// Exact validated metadata returned by the source owner.
    response: EvidenceResolutionResponseV1,
    /// SHA-256 computed by Governance from the returned exact bytes.
    observed_sha256: String,
    /// Size measured by Governance, independent of the response metadata.
    observed_size_bytes: usize,
    /// Canonical digest of the exact request the authenticated resolver validated.
    request_sha256: String,
    /// Original byte limit that was enforced before hashing the source bytes.
    request_max_bytes: u64,
}

impl EvidenceSourceResolutionIntegrity {
    /// Exact response metadata validated against the authenticated request and peer.
    #[must_use]
    pub fn response(&self) -> &EvidenceResolutionResponseV1 {
        &self.response
    }

    /// SHA-256 recomputed over the exact bytes returned by the resolver adapter.
    #[must_use]
    pub fn observed_sha256(&self) -> &str {
        &self.observed_sha256
    }

    /// Size recomputed from the exact bytes returned by the resolver adapter.
    #[must_use]
    pub const fn observed_size_bytes(&self) -> usize {
        self.observed_size_bytes
    }

    /// Canonical digest of the exact request associated with this validated result.
    #[must_use]
    pub fn request_sha256(&self) -> &str {
        &self.request_sha256
    }

    /// Original max-byte constraint enforced by the resolver.
    #[must_use]
    pub const fn request_max_bytes(&self) -> u64 {
        self.request_max_bytes
    }
}

/// Node-compatible normalized evidence-manifest digest and eligibility gate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceResolutionManifestIntegrity {
    /// SHA-256 of the canonical normalized artifact/file evidence records.
    evidence_manifest_sha256: String,
    /// Number of unique source references included in the manifest.
    source_count: usize,
    /// Empty manifests are hashable for diagnostics but never attestation-eligible.
    eligible_for_attestation: bool,
    /// Stable eligibility blockers; currently includes the empty-manifest gate.
    blockers: Vec<&'static str>,
    /// Source integrity results in canonical reference order.
    sources: Vec<EvidenceSourceResolutionIntegrity>,
}

impl EvidenceResolutionManifestIntegrity {
    /// Canonical Node-compatible source-lineage manifest digest.
    #[must_use]
    pub fn evidence_manifest_sha256(&self) -> &str {
        &self.evidence_manifest_sha256
    }

    /// Number of unique source references covered by this report.
    #[must_use]
    pub const fn source_count(&self) -> usize {
        self.source_count
    }

    /// Whether the source inventory is non-empty and contains no blockers.
    #[must_use]
    pub const fn eligible_for_attestation(&self) -> bool {
        self.eligible_for_attestation
    }

    /// Stable manifest eligibility blockers.
    #[must_use]
    pub fn blockers(&self) -> &[&'static str] {
        &self.blockers
    }

    /// Source integrity records in canonical reference order.
    #[must_use]
    pub fn sources(&self) -> &[EvidenceSourceResolutionIntegrity] {
        &self.sources
    }
}

/// Fully resolved snapshot provenance prepared for an independent attestation.
///
/// This value proves only that the configured Execution peer returned the exact
/// requested bytes and producer metadata and that the normalized manifest is
/// bound to the supplied immutable snapshot. It is not a signed attestation and
/// does not upgrade any graph evidence claim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedSnapshotEvidenceForAttestation {
    requests: Vec<EvidenceResolutionRequestV1>,
    manifest: EvidenceResolutionManifestIntegrity,
    subject: EvidenceVerificationSubjectV1,
}

impl ResolvedSnapshotEvidenceForAttestation {
    /// Exact bounded requests sent to the authenticated Execution resolver.
    #[must_use]
    pub fn requests(&self) -> &[EvidenceResolutionRequestV1] {
        &self.requests
    }

    /// Canonical source manifest whose bytes and producer lineage were checked.
    #[must_use]
    pub fn manifest(&self) -> &EvidenceResolutionManifestIntegrity {
        &self.manifest
    }

    /// Exact snapshot/manifest/membership subject an independent verifier must sign.
    #[must_use]
    pub fn subject(&self) -> &EvidenceVerificationSubjectV1 {
        &self.subject
    }
}

/// Build one deterministic read-only source request for every unique reference pinned by a snapshot.
///
/// Shared source URIs across multiple graph evidence nodes are resolved once,
/// matching the Node evidence-manifest semantics. The immutable snapshot hash
/// still binds every graph node/evidence record. A URI reused with different
/// expected content digests is rejected before any transport call.
pub fn build_snapshot_evidence_resolution_requests(
    snapshot: &GraphSnapshot,
    request_id_prefix: &str,
    governance_service_id: &str,
    execution_service_id: &str,
    max_bytes: u64,
) -> Result<Vec<EvidenceResolutionRequestV1>, EvidenceResolutionFailure> {
    snapshot.validate().map_err(|_| {
        failure(
            EvidenceResolutionFailureClass::Invalid,
            "KNOWLEDGE_SNAPSHOT_INVALID",
        )
    })?;
    validate_service_identity(
        governance_service_id,
        "KNOWLEDGE_GOVERNANCE_SERVICE_ID_INVALID",
    )?;
    validate_service_identity(
        execution_service_id,
        "KNOWLEDGE_EXECUTION_SERVICE_ID_INVALID",
    )?;
    if request_id_prefix.trim().is_empty()
        || request_id_prefix != request_id_prefix.trim()
        || request_id_prefix.len() > 96
        || request_id_prefix.chars().any(char::is_control)
        || max_bytes == 0
        || max_bytes > runalith_protocol::evidence_resolution_v1::MAX_EVIDENCE_RESOLUTION_BYTES
    {
        return Err(failure(
            EvidenceResolutionFailureClass::Invalid,
            "KNOWLEDGE_SOURCE_REQUEST_INVALID",
        ));
    }

    let mut by_uri: std::collections::BTreeMap<String, (String, String, String)> =
        std::collections::BTreeMap::new();
    for evidence in &snapshot.evidence {
        let candidate = (
            evidence.source_sha256.clone(),
            evidence.evidence_id.clone(),
            evidence.node_id.clone(),
        );
        match by_uri.get_mut(&evidence.source_uri) {
            Some((expected_digest, evidence_id, node_id)) => {
                if expected_digest != &evidence.source_sha256 {
                    return Err(failure(
                        EvidenceResolutionFailureClass::Invalid,
                        "KNOWLEDGE_SNAPSHOT_SOURCE_DIGEST_CONFLICT",
                    ));
                }
                if js_string_order(&candidate.1, evidence_id).is_lt()
                    || (candidate.1 == *evidence_id
                        && js_string_order(&candidate.2, node_id).is_lt())
                {
                    *evidence_id = candidate.1;
                    *node_id = candidate.2;
                }
            }
            None => {
                by_uri.insert(evidence.source_uri.clone(), candidate);
            }
        }
    }
    if by_uri.len() > 2_048 {
        return Err(failure(
            EvidenceResolutionFailureClass::Invalid,
            "KNOWLEDGE_EVIDENCE_REFERENCE_LIMIT",
        ));
    }

    let mut references: Vec<_> = by_uri.into_iter().collect();
    references.sort_by(|left, right| js_string_order(&left.0, &right.0));
    let mut requests = Vec::with_capacity(references.len());
    for (index, (source_uri, (expected_sha256, evidence_id, node_id))) in
        references.into_iter().enumerate()
    {
        let request = EvidenceResolutionRequestV1 {
            schema_version:
                runalith_protocol::evidence_resolution_v1::EVIDENCE_RESOLUTION_SCHEMA_VERSION,
            request_id: format!("{request_id_prefix}-{:04}", index + 1),
            requester: governance_service_id.to_owned(),
            audience: execution_service_id.to_owned(),
            evidence_id,
            node_id,
            source_uri,
            expected_sha256,
            max_bytes,
        };
        request.validate().map_err(map_contract_error)?;
        requests.push(request);
    }
    Ok(requests)
}

/// Authenticated resolver composition for one configured Execution peer.
pub struct GovernanceEvidenceResolver<'a> {
    resolver: &'a dyn AuthenticatedEvidenceSourceResolver,
    expected_governance_service_id: String,
    expected_execution_service_id: String,
}

impl<'a> GovernanceEvidenceResolver<'a> {
    /// Bind the resolver to host-provisioned Governance and Execution service identities.
    pub fn new(
        resolver: &'a dyn AuthenticatedEvidenceSourceResolver,
        expected_governance_service_id: impl Into<String>,
        expected_execution_service_id: impl Into<String>,
    ) -> Result<Self, EvidenceResolutionFailure> {
        let expected_governance_service_id = expected_governance_service_id.into();
        let expected_execution_service_id = expected_execution_service_id.into();
        if expected_governance_service_id.trim().is_empty()
            || expected_governance_service_id != expected_governance_service_id.trim()
            || expected_governance_service_id.len() > 256
            || expected_governance_service_id.chars().any(char::is_control)
            || expected_execution_service_id.trim().is_empty()
            || expected_execution_service_id != expected_execution_service_id.trim()
            || expected_execution_service_id.len() > 256
            || expected_execution_service_id.chars().any(char::is_control)
        {
            return Err(failure(
                EvidenceResolutionFailureClass::Invalid,
                "KNOWLEDGE_SOURCE_SERVICE_ID_INVALID",
            ));
        }
        Ok(Self {
            resolver,
            expected_governance_service_id,
            expected_execution_service_id,
        })
    }

    /// Governance service identity pinned by the host-owned composition root.
    #[must_use]
    pub fn expected_governance_service_id(&self) -> &str {
        &self.expected_governance_service_id
    }

    /// Authenticated Execution service identity pinned by the host.
    #[must_use]
    pub fn expected_execution_service_id(&self) -> &str {
        &self.expected_execution_service_id
    }

    /// Resolve a source and validate its metadata and exact bytes without granting claim authority.
    pub fn resolve(
        &self,
        request: &EvidenceResolutionRequestV1,
    ) -> Result<EvidenceSourceResolutionIntegrity, EvidenceResolutionFailure> {
        validate_request_audience(request, &self.expected_execution_service_id)?;
        if request.requester != self.expected_governance_service_id {
            return Err(failure(
                EvidenceResolutionFailureClass::Unauthorized,
                "KNOWLEDGE_SOURCE_REQUESTER_UNAUTHORIZED",
            ));
        }
        let resolved = self
            .resolver
            .resolve_read_only(request, &self.expected_execution_service_id)
            .map_err(map_adapter_error)?;
        validate_authenticated_resolution(request, &self.expected_execution_service_id, &resolved)
    }
}

/// Require the request's audience to match the host-provisioned Execution identity before transport.
pub fn validate_request_audience(
    request: &EvidenceResolutionRequestV1,
    expected_execution_service_id: &str,
) -> Result<(), EvidenceResolutionFailure> {
    request.validate().map_err(map_contract_error)?;
    if request.audience != expected_execution_service_id {
        return Err(failure(
            EvidenceResolutionFailureClass::Unauthorized,
            "KNOWLEDGE_SOURCE_AUDIENCE_UNAUTHORIZED",
        ));
    }
    Ok(())
}

/// Validate a source response after its transport adapter has authenticated the peer.
///
/// This lower-level helper is useful for testing the immutable response/bytes
/// contract without introducing a fake remote service. Callers must not use it
/// to replace peer authentication in a production resolver adapter.
fn validate_authenticated_resolution(
    request: &EvidenceResolutionRequestV1,
    authenticated_responder: &str,
    resolved: &ResolvedEvidenceSource,
) -> Result<EvidenceSourceResolutionIntegrity, EvidenceResolutionFailure> {
    request.validate().map_err(map_contract_error)?;
    resolved
        .response
        .validate_for(request, authenticated_responder)
        .map_err(map_contract_error)?;

    if resolved.source_bytes.len() > MAX_RESOLVED_EVIDENCE_BYTES
        || resolved.source_bytes.len() as u64 > request.max_bytes
    {
        return Err(failure(
            EvidenceResolutionFailureClass::Invalid,
            "KNOWLEDGE_SOURCE_SIZE_LIMIT",
        ));
    }
    if resolved.response.size_bytes != resolved.source_bytes.len() as u64 {
        return Err(failure(
            EvidenceResolutionFailureClass::Invalid,
            "KNOWLEDGE_SOURCE_SIZE_MISMATCH",
        ));
    }

    let observed_sha256 = hex::encode(Sha256::digest(&resolved.source_bytes));
    if observed_sha256 != request.expected_sha256
        || observed_sha256 != resolved.response.source_sha256
    {
        return Err(failure(
            EvidenceResolutionFailureClass::Invalid,
            "KNOWLEDGE_SOURCE_BYTES_INVALID",
        ));
    }

    Ok(EvidenceSourceResolutionIntegrity {
        response: resolved.response.clone(),
        observed_sha256,
        observed_size_bytes: resolved.source_bytes.len(),
        request_sha256: canonical_request_sha256(request)?,
        request_max_bytes: request.max_bytes,
    })
}

fn canonical_request_sha256(
    request: &EvidenceResolutionRequestV1,
) -> Result<String, EvidenceResolutionFailure> {
    let value = serde_json::to_value(request).map_err(|_| {
        failure(
            EvidenceResolutionFailureClass::Invalid,
            "KNOWLEDGE_SOURCE_REQUEST_INVALID",
        )
    })?;
    let canonical = runalith_protocol::agg_checkpoint_v2::canonicalize(&value).map_err(|_| {
        failure(
            EvidenceResolutionFailureClass::Invalid,
            "KNOWLEDGE_SOURCE_REQUEST_INVALID",
        )
    })?;
    Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
}

/// Build the Node-compatible normalized evidence-manifest hash from resolved records.
///
/// This is deliberately separate from `EvidenceManifestIntegrity::byte_integrity_manifest_sha256`:
/// the Node attestation hashes normalized source/producer records, not the Rust
/// byte-integrity report. Artifact records are accepted only after the typed
/// producer status/contract/result/attempt lineage was validated; file records
/// remain `source_bytes_verified_claim_unverified`. An empty set has a stable
/// diagnostic hash but is never eligible for an independent attestation.
pub fn canonical_evidence_resolution_manifest_sha256(
    sources: &[(
        EvidenceResolutionRequestV1,
        EvidenceSourceResolutionIntegrity,
    )],
    expected_execution_service_id: &str,
) -> Result<EvidenceResolutionManifestIntegrity, EvidenceResolutionFailure> {
    if sources.len() > 2_048 {
        return Err(failure(
            EvidenceResolutionFailureClass::Invalid,
            "KNOWLEDGE_EVIDENCE_REFERENCE_LIMIT",
        ));
    }

    let mut seen_references = std::collections::BTreeSet::new();
    let mut records: Vec<(String, Value, EvidenceSourceResolutionIntegrity)> =
        Vec::with_capacity(sources.len());
    for (request, integrity) in sources {
        if !seen_references.insert(request.source_uri.as_str()) {
            return Err(failure(
                EvidenceResolutionFailureClass::Invalid,
                "KNOWLEDGE_EVIDENCE_REFERENCE_DUPLICATE",
            ));
        }
        validate_request_audience(request, expected_execution_service_id)?;
        if integrity.request_sha256 != canonical_request_sha256(request)?
            || integrity.observed_size_bytes as u64 > request.max_bytes
            || integrity.request_max_bytes != request.max_bytes
        {
            return Err(failure(
                EvidenceResolutionFailureClass::Invalid,
                "KNOWLEDGE_SOURCE_REQUEST_BINDING_INVALID",
            ));
        }
        let response = &integrity.response;
        if response.responder != expected_execution_service_id
            || response.request_id != request.request_id
            || response.audience != request.requester
            || response.evidence_id != request.evidence_id
            || response.node_id != request.node_id
            || response.source_uri != request.source_uri
            || response.source_sha256 != request.expected_sha256
            || response.source_sha256 != integrity.observed_sha256
            || response.size_bytes != integrity.observed_size_bytes as u64
            || response.size_bytes > integrity.request_max_bytes
        {
            return Err(failure(
                EvidenceResolutionFailureClass::Invalid,
                "KNOWLEDGE_SOURCE_RESPONSE_INVALID",
            ));
        }

        let normalized = if let Some(lineage) = &response.producer_lineage {
            json!({
                "reference": &request.source_uri,
                "classification": "durable_artifact_lineage_verified_claim_unverified",
                "valid": true,
                "sourceJobId": &lineage.source_job_id,
                "artifactId": &lineage.artifact_id,
                "type": &lineage.artifact_type,
                "schemaVersion": lineage.schema_version,
                "contentHash": &lineage.content_sha256,
                "artifactCreatedEventId": &lineage.artifact_created_event_id,
                "producerRole": &lineage.producer_role,
                "producerTaskId": &lineage.producer_task_id,
                "producerTaskStatus": &lineage.producer_task_status,
                "producerResultId": &lineage.producer_result_id,
                "producerResultOutcome": &lineage.producer_result_outcome,
                "producerCompletionEventId": &lineage.producer_completion_event_id,
                "producerCompletionEventType": &lineage.producer_completion_event_type,
                "blockers": []
            })
        } else {
            json!({
                "reference": &request.source_uri,
                "classification": "source_bytes_verified_claim_unverified",
                "valid": true,
                "expectedSha256": &request.expected_sha256,
                "observedSha256": &integrity.observed_sha256,
                "sizeBytes": integrity.observed_size_bytes,
                "blockers": []
            })
        };
        records.push((request.source_uri.clone(), normalized, integrity.clone()));
    }

    // JavaScript Array#sort compares UTF-16 code units. Match it explicitly
    // instead of relying on Rust's UTF-8 byte ordering for non-ASCII references.
    records.sort_by(|left, right| {
        left.0
            .encode_utf16()
            .collect::<Vec<_>>()
            .cmp(&right.0.encode_utf16().collect::<Vec<_>>())
    });
    let normalized_records = Value::Array(records.iter().map(|record| record.1.clone()).collect());
    let canonical = runalith_protocol::agg_checkpoint_v2::canonicalize(&normalized_records)
        .map_err(|_| {
            failure(
                EvidenceResolutionFailureClass::Invalid,
                "KNOWLEDGE_EVIDENCE_MANIFEST_CANONICALIZATION_FAILED",
            )
        })?;
    let evidence_manifest_sha256 = hex::encode(Sha256::digest(canonical.as_bytes()));
    let source_count = records.len();
    let sources = records.into_iter().map(|record| record.2).collect();
    let eligible_for_attestation = source_count > 0;
    let blockers = if eligible_for_attestation {
        Vec::new()
    } else {
        vec!["KNOWLEDGE_EVIDENCE_MANIFEST_EMPTY"]
    };

    Ok(EvidenceResolutionManifestIntegrity {
        evidence_manifest_sha256,
        source_count,
        eligible_for_attestation,
        blockers,
        sources,
    })
}

/// Bind a normalized, fully resolved source manifest to one exact immutable graph snapshot.
///
/// Membership identities are supplied by the authenticated membership owner;
/// this function does not infer membership provenance from node/edge IDs. The
/// caller must pass the authoritative `goal_id` from the Goal/Idea graph host.
/// The returned subject is the exact payload the independent verifier must sign.
pub fn evidence_verification_subject_from_snapshot(
    snapshot: &GraphSnapshot,
    goal_id: &str,
    mut membership_ids: Vec<String>,
    manifest: &EvidenceResolutionManifestIntegrity,
) -> Result<EvidenceVerificationSubjectV1, EvidenceResolutionFailure> {
    snapshot.validate().map_err(|_| {
        failure(
            EvidenceResolutionFailureClass::Invalid,
            "KNOWLEDGE_SNAPSHOT_INVALID",
        )
    })?;
    if !manifest.eligible_for_attestation
        || manifest.source_count == 0
        || !manifest.blockers.is_empty()
        || manifest.sources.len() != manifest.source_count
    {
        return Err(failure(
            EvidenceResolutionFailureClass::Invalid,
            "KNOWLEDGE_EVIDENCE_MANIFEST_NOT_ELIGIBLE",
        ));
    }

    let mut expected_sources = std::collections::BTreeMap::new();
    for evidence in &snapshot.evidence {
        match expected_sources.insert(&evidence.source_uri, &evidence.source_sha256) {
            Some(previous_digest) if previous_digest != &evidence.source_sha256 => {
                return Err(failure(
                    EvidenceResolutionFailureClass::Invalid,
                    "KNOWLEDGE_SNAPSHOT_SOURCE_DIGEST_CONFLICT",
                ));
            }
            _ => {}
        }
    }
    if expected_sources.len() != manifest.source_count {
        return Err(failure(
            EvidenceResolutionFailureClass::Invalid,
            "KNOWLEDGE_EVIDENCE_MANIFEST_SNAPSHOT_COVERAGE_MISMATCH",
        ));
    }

    let mut resolved_sources = std::collections::BTreeMap::new();
    for source in &manifest.sources {
        let Some(expected_sha256) = expected_sources.get(&source.response.source_uri) else {
            return Err(failure(
                EvidenceResolutionFailureClass::Invalid,
                "KNOWLEDGE_EVIDENCE_MANIFEST_EXTRA_SOURCE",
            ));
        };
        if *expected_sha256 != &source.observed_sha256
            || source.response.source_sha256 != source.observed_sha256
            || resolved_sources
                .insert(&source.response.source_uri, &source.observed_sha256)
                .is_some()
        {
            return Err(failure(
                EvidenceResolutionFailureClass::Invalid,
                "KNOWLEDGE_EVIDENCE_MANIFEST_SOURCE_BINDING_INVALID",
            ));
        }
    }
    if resolved_sources.len() != expected_sources.len() {
        return Err(failure(
            EvidenceResolutionFailureClass::Invalid,
            "KNOWLEDGE_EVIDENCE_MANIFEST_MISSING_SOURCE",
        ));
    }

    let mut node_ids: Vec<String> = snapshot
        .nodes
        .iter()
        .map(|node| node.node_id.clone())
        .collect();
    let mut edge_ids: Vec<String> = snapshot
        .edges
        .iter()
        .map(|edge| edge.edge_id.clone())
        .collect();
    node_ids.sort_by(|left, right| js_string_order(left, right));
    edge_ids.sort_by(|left, right| js_string_order(left, right));
    membership_ids.sort_by(|left, right| js_string_order(left, right));

    let subject = EvidenceVerificationSubjectV1 {
        goal_id: goal_id.to_owned(),
        snapshot_hash: snapshot.snapshot_sha256.clone(),
        node_ids,
        edge_ids,
        membership_ids,
        evidence_manifest_hash: manifest.evidence_manifest_sha256.clone(),
    };
    subject.validate().map_err(|_| {
        failure(
            EvidenceResolutionFailureClass::Invalid,
            "KNOWLEDGE_ATTESTATION_SUBJECT_INVALID",
        )
    })?;
    Ok(subject)
}

/// Resolve every unique source pinned by a snapshot and build its attestation subject.
///
/// This is the Governance-owned orchestration path: it derives requests only
/// from the immutable snapshot, resolves each unique URI through the injected
/// authenticated Execution adapter, verifies exact bytes and producer lineage,
/// computes the canonical Node-compatible evidence manifest, and binds that
/// manifest plus caller-supplied authoritative membership IDs to the snapshot.
/// Any missing, unavailable, unauthorized, stale, substituted, or ambiguous
/// source fails the entire operation. No partial manifest is returned.
pub fn resolve_snapshot_evidence_for_attestation(
    snapshot: &GraphSnapshot,
    request_id_prefix: &str,
    governance_service_id: &str,
    max_bytes_per_source: u64,
    goal_id: &str,
    membership_ids: Vec<String>,
    resolver: &GovernanceEvidenceResolver<'_>,
) -> Result<ResolvedSnapshotEvidenceForAttestation, EvidenceResolutionFailure> {
    if governance_service_id != resolver.expected_governance_service_id() {
        return Err(failure(
            EvidenceResolutionFailureClass::Unauthorized,
            "KNOWLEDGE_SOURCE_REQUESTER_UNAUTHORIZED",
        ));
    }
    let execution_service_id = resolver.expected_execution_service_id();
    let requests = build_snapshot_evidence_resolution_requests(
        snapshot,
        request_id_prefix,
        governance_service_id,
        execution_service_id,
        max_bytes_per_source,
    )?;

    let mut resolved_sources = Vec::with_capacity(requests.len());
    let mut total_source_bytes = 0usize;
    for request in &requests {
        let integrity = resolver.resolve(request)?;
        total_source_bytes = checked_add_snapshot_evidence_bytes(
            total_source_bytes,
            integrity.observed_size_bytes(),
        )?;
        resolved_sources.push((request.clone(), integrity));
    }

    let manifest =
        canonical_evidence_resolution_manifest_sha256(&resolved_sources, execution_service_id)?;
    let subject =
        evidence_verification_subject_from_snapshot(snapshot, goal_id, membership_ids, &manifest)?;

    Ok(ResolvedSnapshotEvidenceForAttestation {
        requests,
        manifest,
        subject,
    })
}

fn checked_add_snapshot_evidence_bytes(
    current: usize,
    additional: usize,
) -> Result<usize, EvidenceResolutionFailure> {
    current
        .checked_add(additional)
        .filter(|total| *total <= MAX_SNAPSHOT_RESOLVED_EVIDENCE_BYTES)
        .ok_or_else(|| {
            failure(
                EvidenceResolutionFailureClass::Invalid,
                "KNOWLEDGE_SOURCE_TOTAL_SIZE_LIMIT",
            )
        })
}

fn js_string_order(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn validate_service_identity(
    identity: &str,
    code: &'static str,
) -> Result<(), EvidenceResolutionFailure> {
    if identity.trim().is_empty()
        || identity != identity.trim()
        || identity.len() > 256
        || identity.chars().any(char::is_control)
    {
        return Err(failure(EvidenceResolutionFailureClass::Invalid, code));
    }
    Ok(())
}

fn failure(class: EvidenceResolutionFailureClass, code: &'static str) -> EvidenceResolutionFailure {
    EvidenceResolutionFailure { class, code }
}

fn map_adapter_error(error: EvidenceResolutionAdapterError) -> EvidenceResolutionFailure {
    match error {
        EvidenceResolutionAdapterError::Unavailable => failure(
            EvidenceResolutionFailureClass::Unavailable,
            "KNOWLEDGE_SOURCE_UNAVAILABLE",
        ),
        EvidenceResolutionAdapterError::Unauthorized => failure(
            EvidenceResolutionFailureClass::Unauthorized,
            "KNOWLEDGE_SOURCE_RESPONDER_UNAUTHORIZED",
        ),
        EvidenceResolutionAdapterError::Invalid => failure(
            EvidenceResolutionFailureClass::Invalid,
            "KNOWLEDGE_SOURCE_RESPONSE_INVALID",
        ),
    }
}

fn map_contract_error(error: EvidenceResolutionContractError) -> EvidenceResolutionFailure {
    use EvidenceResolutionContractError as ContractError;
    match error {
        ContractError::ResponderUnauthorized => failure(
            EvidenceResolutionFailureClass::Unauthorized,
            "KNOWLEDGE_SOURCE_RESPONDER_UNAUTHORIZED",
        ),
        ContractError::SourceUnavailable => failure(
            EvidenceResolutionFailureClass::Unavailable,
            "KNOWLEDGE_SOURCE_UNAVAILABLE",
        ),
        ContractError::InvalidField(_)
        | ContractError::BindingMismatch
        | ContractError::SourceSizeLimit
        | ContractError::SourceDigestMismatch
        | ContractError::ProducerLineageInvalid => failure(
            EvidenceResolutionFailureClass::Invalid,
            "KNOWLEDGE_SOURCE_RESPONSE_INVALID",
        ),
    }
}

/// Adapter-side failure classes; the host must preserve these classifications.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum EvidenceResolutionAdapterError {
    /// Remote service or network is unavailable.
    #[error("evidence source service is unavailable")]
    Unavailable,
    /// Authenticated peer does not match the configured service identity.
    #[error("evidence source service authentication failed")]
    Unauthorized,
    /// Remote response violates the versioned contract.
    #[error("evidence source response is invalid")]
    Invalid,
}

#[cfg(test)]
mod tests {
    use super::*;
    use runalith_domain::{
        EvidenceVerification, GraphEdge, GraphEdgeKind, GraphEvidence, GraphNodeKind,
        GraphNodeRevision, GraphSnapshotDraft, content_hash,
    };
    use runalith_protocol::evidence_resolution_v1::{
        EvidenceProducerLineageV1, EvidenceSourceAvailability,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FixtureAuthenticatedResolver {
        authenticated_peer: String,
        calls: AtomicUsize,
    }

    impl AuthenticatedEvidenceSourceResolver for FixtureAuthenticatedResolver {
        fn resolve_read_only(
            &self,
            request: &EvidenceResolutionRequestV1,
            expected_peer_identity: &str,
        ) -> Result<ResolvedEvidenceSource, EvidenceResolutionAdapterError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.authenticated_peer != expected_peer_identity {
                return Err(EvidenceResolutionAdapterError::Unauthorized);
            }
            Ok(resolved(request))
        }
    }

    fn request() -> EvidenceResolutionRequestV1 {
        EvidenceResolutionRequestV1 {
            schema_version: 1,
            request_id: "request-1".into(),
            requester: "governance-a".into(),
            audience: "execution-evidence".into(),
            evidence_id: "evidence-1".into(),
            node_id: "node-1".into(),
            source_uri: "artifact://sha256/artifact-1".into(),
            expected_sha256: hex::encode(Sha256::digest(b"source bytes")),
            max_bytes: 1024,
        }
    }

    fn lineage(request: &EvidenceResolutionRequestV1) -> EvidenceProducerLineageV1 {
        EvidenceProducerLineageV1 {
            source_uri: request.source_uri.clone(),
            source_job_id: "job-1".into(),
            artifact_id: "artifact-1".into(),
            artifact_status: "active".into(),
            artifact_type: "application/json".into(),
            artifact_created_event_id: "event-artifact-1".into(),
            lineage_valid: true,
            producer_contract_valid: true,
            producer_result_lineage_valid: true,
            producer_role: "engineer".into(),
            producer_task_id: "task-1".into(),
            producer_attempt_id: "attempt-1".into(),
            producer_task_completed: true,
            producer_task_status: "completed".into(),
            producer_result_id: "result-1".into(),
            producer_result_outcome: "success".into(),
            producer_completion_event_id: "event-complete-1".into(),
            producer_completion_event_type: "task.completed".into(),
            producer_contract_sha256: "b".repeat(64),
            producer_result_lineage_sha256: "c".repeat(64),
            content_sha256: request.expected_sha256.clone(),
            schema_version: 1,
        }
    }

    fn resolved(request: &EvidenceResolutionRequestV1) -> ResolvedEvidenceSource {
        resolved_with_bytes(request, b"source bytes")
    }

    fn resolved_with_bytes(
        request: &EvidenceResolutionRequestV1,
        source_bytes: &[u8],
    ) -> ResolvedEvidenceSource {
        ResolvedEvidenceSource {
            response: EvidenceResolutionResponseV1 {
                schema_version: 1,
                request_id: request.request_id.clone(),
                responder: request.audience.clone(),
                audience: request.requester.clone(),
                evidence_id: request.evidence_id.clone(),
                node_id: request.node_id.clone(),
                source_uri: request.source_uri.clone(),
                media_type: "application/octet-stream".into(),
                source_sha256: request.expected_sha256.clone(),
                size_bytes: source_bytes.len() as u64,
                availability: EvidenceSourceAvailability::Available,
                producer_lineage: request
                    .source_uri
                    .starts_with("artifact://")
                    .then(|| lineage(request)),
            },
            source_bytes: source_bytes.to_vec(),
        }
    }

    fn snapshot_with_sources() -> GraphSnapshot {
        let goal_content = json!({"agg": {"kind": "goal"}});
        let artifact_content = json!({"agg": {"kind": "evidence"}});
        let goal_hash = content_hash(&goal_content).unwrap();
        let artifact_hash = content_hash(&artifact_content).unwrap();
        GraphSnapshot::seal(GraphSnapshotDraft {
            graph_id: "graph-1".into(),
            revision: 1,
            nodes: vec![
                GraphNodeRevision {
                    node_id: "node-z".into(),
                    kind: GraphNodeKind::Goal,
                    revision: 1,
                    title: "Goal".into(),
                    content: goal_content,
                    content_sha256: goal_hash,
                    previous_revision_sha256: None,
                },
                GraphNodeRevision {
                    node_id: "node-a".into(),
                    kind: GraphNodeKind::Artifact,
                    revision: 1,
                    title: "Evidence".into(),
                    content: artifact_content,
                    content_sha256: artifact_hash,
                    previous_revision_sha256: None,
                },
            ],
            edges: vec![GraphEdge {
                edge_id: "edge-z".into(),
                from_node_id: "node-a".into(),
                to_node_id: "node-z".into(),
                kind: GraphEdgeKind::Supports,
            }],
            evidence: vec![GraphEvidence {
                evidence_id: "evidence-1".into(),
                node_id: "node-a".into(),
                source_uri: "artifact://sha256/artifact-1".into(),
                source_sha256: hex::encode(Sha256::digest(b"source bytes")),
                claim: "The artifact supports the claim".into(),
                verification: EvidenceVerification::Unverified,
                verifier_id: None,
                verification_receipt_sha256: None,
            }],
            previous_snapshot_revision: None,
            previous_snapshot_sha256: None,
            created_at: "2026-11-02T10:00:00.000Z".into(),
        })
        .unwrap()
    }

    fn snapshot_manifest(snapshot: &GraphSnapshot) -> EvidenceResolutionManifestIntegrity {
        let requests = build_snapshot_evidence_resolution_requests(
            snapshot,
            "snapshot-resolution",
            "governance-a",
            "execution-evidence",
            1024,
        )
        .unwrap();
        let resolved_sources: Vec<_> = requests
            .into_iter()
            .map(|request| {
                let resolved = resolved(&request);
                let integrity =
                    validate_authenticated_resolution(&request, "execution-evidence", &resolved)
                        .unwrap();
                (request, integrity)
            })
            .collect();
        canonical_evidence_resolution_manifest_sha256(&resolved_sources, "execution-evidence")
            .unwrap()
    }

    #[test]
    fn snapshot_orchestration_resolves_exact_sources_and_returns_attestation_subject() {
        let snapshot = snapshot_with_sources();
        let adapter = FixtureAuthenticatedResolver {
            authenticated_peer: "execution-evidence".into(),
            calls: AtomicUsize::new(0),
        };
        let resolver =
            GovernanceEvidenceResolver::new(&adapter, "governance-a", "execution-evidence")
                .unwrap();

        let prepared = resolve_snapshot_evidence_for_attestation(
            &snapshot,
            "snapshot-resolution",
            "governance-a",
            1024,
            "goal-1",
            vec!["membership-2".into(), "membership-1".into()],
            &resolver,
        )
        .unwrap();

        assert_eq!(adapter.calls.load(Ordering::SeqCst), 1);
        assert_eq!(prepared.requests().len(), 1);
        assert_eq!(prepared.manifest().source_count(), 1);
        assert!(prepared.manifest().eligible_for_attestation());
        assert_eq!(prepared.subject().goal_id, "goal-1");
        assert_eq!(prepared.subject().snapshot_hash, snapshot.snapshot_sha256);
        assert_eq!(
            prepared.subject().evidence_manifest_hash,
            prepared.manifest().evidence_manifest_sha256()
        );
        assert_eq!(
            prepared.subject().membership_ids,
            vec!["membership-1".to_owned(), "membership-2".to_owned()]
        );
        assert_eq!(
            prepared.manifest().sources()[0].observed_sha256(),
            snapshot.evidence[0].source_sha256
        );
        // Source resolution is deliberately non-authorizing. The sealed graph
        // still records its evidence claim as UNVERIFIED.
        assert_eq!(
            snapshot.evidence[0].verification,
            EvidenceVerification::Unverified
        );
    }

    #[test]
    fn snapshot_orchestration_fails_closed_when_authenticated_execution_peer_mismatches() {
        let snapshot = snapshot_with_sources();
        let adapter = FixtureAuthenticatedResolver {
            authenticated_peer: "unexpected-execution".into(),
            calls: AtomicUsize::new(0),
        };
        let resolver =
            GovernanceEvidenceResolver::new(&adapter, "governance-a", "execution-evidence")
                .unwrap();

        let failure = resolve_snapshot_evidence_for_attestation(
            &snapshot,
            "snapshot-resolution",
            "governance-a",
            1024,
            "goal-1",
            Vec::new(),
            &resolver,
        )
        .unwrap_err();

        assert_eq!(failure.class, EvidenceResolutionFailureClass::Unauthorized);
        assert_eq!(failure.code, "KNOWLEDGE_SOURCE_RESPONDER_UNAUTHORIZED");
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn snapshot_orchestration_rejects_caller_forged_governance_requester_before_transport() {
        let snapshot = snapshot_with_sources();
        let adapter = FixtureAuthenticatedResolver {
            authenticated_peer: "execution-evidence".into(),
            calls: AtomicUsize::new(0),
        };
        let resolver =
            GovernanceEvidenceResolver::new(&adapter, "governance-a", "execution-evidence")
                .unwrap();

        let failure = resolve_snapshot_evidence_for_attestation(
            &snapshot,
            "snapshot-resolution",
            "attacker-selected-requester",
            1024,
            "goal-1",
            Vec::new(),
            &resolver,
        )
        .unwrap_err();

        assert_eq!(failure.class, EvidenceResolutionFailureClass::Unauthorized);
        assert_eq!(failure.code, "KNOWLEDGE_SOURCE_REQUESTER_UNAUTHORIZED");
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn snapshot_evidence_aggregate_byte_budget_is_bounded_and_overflow_safe() {
        assert_eq!(
            checked_add_snapshot_evidence_bytes(MAX_SNAPSHOT_RESOLVED_EVIDENCE_BYTES - 1, 1)
                .unwrap(),
            MAX_SNAPSHOT_RESOLVED_EVIDENCE_BYTES
        );
        assert_eq!(
            checked_add_snapshot_evidence_bytes(MAX_SNAPSHOT_RESOLVED_EVIDENCE_BYTES, 1)
                .unwrap_err()
                .code,
            "KNOWLEDGE_SOURCE_TOTAL_SIZE_LIMIT"
        );
        assert_eq!(
            checked_add_snapshot_evidence_bytes(usize::MAX, 1)
                .unwrap_err()
                .code,
            "KNOWLEDGE_SOURCE_TOTAL_SIZE_LIMIT"
        );
    }

    #[test]
    fn authenticated_resolution_checks_exact_returned_bytes_and_metadata() {
        let request = request();
        let resolved = resolved(&request);

        let result =
            validate_authenticated_resolution(&request, "execution-evidence", &resolved).unwrap();

        assert_eq!(result.observed_sha256, request.expected_sha256);
        assert_eq!(result.observed_size_bytes, b"source bytes".len());
    }

    #[test]
    fn authenticated_resolution_rejects_misreported_size_and_substituted_bytes() {
        let request = request();
        let mut misreported_size = resolved(&request);
        misreported_size.response.size_bytes += 1;
        assert_eq!(
            validate_authenticated_resolution(&request, "execution-evidence", &misreported_size)
                .unwrap_err()
                .code,
            "KNOWLEDGE_SOURCE_SIZE_MISMATCH"
        );

        let mut resolved = resolved(&request);
        resolved.source_bytes = b"substituted source".to_vec();
        resolved.response.size_bytes = resolved.source_bytes.len() as u64;
        assert_eq!(
            validate_authenticated_resolution(&request, "execution-evidence", &resolved)
                .unwrap_err()
                .code,
            "KNOWLEDGE_SOURCE_BYTES_INVALID"
        );
    }

    #[test]
    fn authenticated_resolution_classifies_wrong_peer_and_missing_source_separately() {
        let request = request();
        let resolved = resolved(&request);
        let unauthorized =
            validate_authenticated_resolution(&request, "other-execution", &resolved).unwrap_err();
        assert_eq!(
            unauthorized.class,
            EvidenceResolutionFailureClass::Unauthorized
        );

        let mut unavailable = resolved;
        unavailable.response.availability = EvidenceSourceAvailability::Unavailable;
        let missing =
            validate_authenticated_resolution(&request, "execution-evidence", &unavailable)
                .unwrap_err();
        assert_eq!(missing.class, EvidenceResolutionFailureClass::Unavailable);
    }

    #[test]
    fn governance_never_exceeds_requested_source_bound() {
        let mut request = request();
        request.max_bytes = 4;
        let resolved = resolved(&request);
        assert_eq!(
            validate_authenticated_resolution(&request, "execution-evidence", &resolved)
                .unwrap_err()
                .code,
            "KNOWLEDGE_SOURCE_RESPONSE_INVALID"
        );
    }

    #[test]
    fn validated_integrity_cannot_be_rebound_to_a_weaker_source_request() {
        let original = request();
        let response = resolved(&original);
        let integrity =
            validate_authenticated_resolution(&original, "execution-evidence", &response).unwrap();
        let mut weaker_request = original.clone();
        weaker_request.max_bytes = 4;

        let failure = canonical_evidence_resolution_manifest_sha256(
            &[(weaker_request, integrity)],
            "execution-evidence",
        )
        .unwrap_err();

        assert_eq!(failure.class, EvidenceResolutionFailureClass::Invalid);
        assert_eq!(failure.code, "KNOWLEDGE_SOURCE_REQUEST_BINDING_INVALID");
    }

    #[test]
    fn governance_rejects_request_audience_not_bound_to_configured_execution_identity() {
        let mut request = request();
        request.audience = "untrusted-execution-service".into();

        let failure = validate_request_audience(&request, "execution-evidence").unwrap_err();

        assert_eq!(failure.class, EvidenceResolutionFailureClass::Unauthorized);
        assert_eq!(failure.code, "KNOWLEDGE_SOURCE_AUDIENCE_UNAUTHORIZED");
    }

    #[test]
    fn normalized_evidence_manifest_hash_matches_node_artifact_and_file_golden() {
        let mut artifact_request = request();
        artifact_request.expected_sha256 =
            "7b1e8dfc0fa5a82ec9f94094ebaed7926b15051a1d6bc29c6da5f5d8d38fbbc7".into();
        let artifact_response = resolved_with_bytes(&artifact_request, b"artifact source");
        let artifact_source = validate_authenticated_resolution(
            &artifact_request,
            "execution-evidence",
            &artifact_response,
        )
        .unwrap();

        let mut file_request = request();
        file_request.source_uri = format!(
            "file:source/source-1.txt#sha256={}",
            "fd40bd283d9eab87d7050940a42d7d85e7d0856e91beaf1a55ebdcb6127468ab"
        );
        file_request.expected_sha256 =
            "fd40bd283d9eab87d7050940a42d7d85e7d0856e91beaf1a55ebdcb6127468ab".into();
        let file_response = resolved_with_bytes(&file_request, b"file source");
        let file_source =
            validate_authenticated_resolution(&file_request, "execution-evidence", &file_response)
                .unwrap();

        let manifest = canonical_evidence_resolution_manifest_sha256(
            &[
                (file_request.clone(), file_source.clone()),
                (artifact_request.clone(), artifact_source.clone()),
            ],
            "execution-evidence",
        )
        .unwrap();
        let reversed = canonical_evidence_resolution_manifest_sha256(
            &[
                (artifact_request, artifact_source),
                (file_request, file_source),
            ],
            "execution-evidence",
        )
        .unwrap();

        assert_eq!(
            manifest.evidence_manifest_sha256,
            "79cef46ad5bdd5198a9ee4339474b919874beaed64e4e3a24be96386262d802e"
        );
        assert_eq!(manifest.source_count, 2);
        assert!(manifest.eligible_for_attestation);
        assert!(manifest.blockers.is_empty());
        assert_eq!(
            manifest.evidence_manifest_sha256,
            reversed.evidence_manifest_sha256
        );
    }

    #[test]
    fn empty_evidence_manifest_has_node_hash_but_is_not_attestation_eligible() {
        let manifest =
            canonical_evidence_resolution_manifest_sha256(&[], "execution-evidence").unwrap();

        assert_eq!(
            manifest.evidence_manifest_sha256,
            "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
        );
        assert_eq!(manifest.source_count, 0);
        assert!(!manifest.eligible_for_attestation);
        assert_eq!(manifest.blockers, vec!["KNOWLEDGE_EVIDENCE_MANIFEST_EMPTY"]);
    }

    #[test]
    fn duplicate_source_reference_cannot_enter_the_evidence_manifest() {
        let request = request();
        let response = resolved(&request);
        let integrity =
            validate_authenticated_resolution(&request, "execution-evidence", &response).unwrap();

        let failure = canonical_evidence_resolution_manifest_sha256(
            &[(request.clone(), integrity.clone()), (request, integrity)],
            "execution-evidence",
        )
        .unwrap_err();

        assert_eq!(failure.class, EvidenceResolutionFailureClass::Invalid);
        assert_eq!(failure.code, "KNOWLEDGE_EVIDENCE_REFERENCE_DUPLICATE");
    }

    #[test]
    fn snapshot_subject_binds_sealed_graph_manifest_and_canonical_membership_inventory() {
        let snapshot = snapshot_with_sources();
        let manifest = snapshot_manifest(&snapshot);

        let subject = evidence_verification_subject_from_snapshot(
            &snapshot,
            "goal-1",
            vec!["membership-z".into(), "membership-a".into()],
            &manifest,
        )
        .unwrap();

        assert_eq!(subject.goal_id, "goal-1");
        assert_eq!(subject.snapshot_hash, snapshot.snapshot_sha256);
        assert_eq!(subject.node_ids, vec!["node-a", "node-z"]);
        assert_eq!(subject.edge_ids, vec!["edge-z"]);
        assert_eq!(subject.membership_ids, vec!["membership-a", "membership-z"]);
        assert_eq!(
            subject.evidence_manifest_hash,
            manifest.evidence_manifest_sha256
        );
    }

    #[test]
    fn snapshot_subject_rejects_missing_extra_or_digest_mismatched_manifest_sources() {
        let snapshot = snapshot_with_sources();
        let mut manifest = snapshot_manifest(&snapshot);
        manifest.source_count = 0;
        manifest.eligible_for_attestation = false;
        assert_eq!(
            evidence_verification_subject_from_snapshot(
                &snapshot,
                "goal-1",
                vec!["membership-a".into()],
                &manifest,
            )
            .unwrap_err()
            .code,
            "KNOWLEDGE_EVIDENCE_MANIFEST_NOT_ELIGIBLE"
        );

        let mut manifest = snapshot_manifest(&snapshot);
        manifest.sources[0].response.source_uri = "artifact://sha256/extra".into();
        assert_eq!(
            evidence_verification_subject_from_snapshot(
                &snapshot,
                "goal-1",
                vec!["membership-a".into()],
                &manifest,
            )
            .unwrap_err()
            .code,
            "KNOWLEDGE_EVIDENCE_MANIFEST_EXTRA_SOURCE"
        );

        let mut manifest = snapshot_manifest(&snapshot);
        manifest.sources[0].observed_sha256 = "e".repeat(64);
        assert_eq!(
            evidence_verification_subject_from_snapshot(
                &snapshot,
                "goal-1",
                vec!["membership-a".into()],
                &manifest,
            )
            .unwrap_err()
            .code,
            "KNOWLEDGE_EVIDENCE_MANIFEST_SOURCE_BINDING_INVALID"
        );
    }

    #[test]
    fn snapshot_resolution_requests_deduplicate_shared_uris_and_fence_digest_conflicts() {
        let base = snapshot_with_sources();
        let mut shared = base.evidence[0].clone();
        shared.evidence_id = "evidence-2".into();
        shared.node_id = "node-z".into();
        let snapshot = GraphSnapshot::seal(GraphSnapshotDraft {
            graph_id: base.graph_id.clone(),
            revision: base.revision + 1,
            nodes: base.nodes.clone(),
            edges: base.edges.clone(),
            evidence: vec![base.evidence[0].clone(), shared.clone()],
            previous_snapshot_revision: Some(base.revision),
            previous_snapshot_sha256: Some(base.snapshot_sha256.clone()),
            created_at: "2026-11-02T10:01:00.000Z".into(),
        })
        .unwrap();

        let requests = build_snapshot_evidence_resolution_requests(
            &snapshot,
            "snapshot-resolution",
            "governance-a",
            "execution-evidence",
            1024,
        )
        .unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].source_uri, shared.source_uri);
        assert_eq!(requests[0].expected_sha256, shared.source_sha256);

        shared.source_sha256 = "f".repeat(64);
        let conflicting = GraphSnapshot::seal(GraphSnapshotDraft {
            graph_id: base.graph_id,
            revision: base.revision + 1,
            nodes: base.nodes,
            edges: base.edges,
            evidence: vec![snapshot.evidence[0].clone(), shared],
            previous_snapshot_revision: Some(base.revision),
            previous_snapshot_sha256: Some(base.snapshot_sha256),
            created_at: "2026-11-02T10:02:00.000Z".into(),
        })
        .unwrap();
        assert_eq!(
            build_snapshot_evidence_resolution_requests(
                &conflicting,
                "snapshot-resolution",
                "governance-a",
                "execution-evidence",
                1024,
            )
            .unwrap_err()
            .code,
            "KNOWLEDGE_SNAPSHOT_SOURCE_DIGEST_CONFLICT"
        );
    }
}
