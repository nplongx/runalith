//! Byte-level integrity checks for caller-resolved evidence sources.
//!
//! This module hashes the exact bytes supplied by a trusted source adapter. It
//! does not resolve URIs, establish source durability, evaluate a claim, or
//! change `GraphEvidence::verification`; a digest match is not claim verification.

use std::collections::{BTreeMap, BTreeSet};

use runalith_domain::{EvidenceVerification, GraphEvidence, GraphSnapshot};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{AggError, AggGraph};

/// Maximum exact source size accepted by one byte-integrity comparison.
pub const MAX_EVIDENCE_SOURCE_BYTES: usize = 64 * 1024 * 1024;

/// Result of comparing actual source bytes with the digest recorded on evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceBytesStatus {
    /// Exact supplied bytes hash to the evidence's declared source digest.
    Match,
    /// Supplied bytes differ from the evidence's declared source digest.
    Mismatch,
}

/// Auditable byte-integrity result; intentionally carries no claim-verification authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceBytesIntegrity {
    /// Evidence record whose source digest was checked.
    pub evidence_id: String,
    /// Graph node whose evidence binding was checked.
    pub node_id: String,
    /// Source reference bound to the evidence record, not proof of retrievability.
    pub source_uri: String,
    /// Digest declared by the evidence record.
    pub expected_sha256: String,
    /// SHA-256 computed from the exact bytes supplied to this function.
    pub observed_sha256: String,
    /// Whether the computed digest matches the declared digest.
    pub status: EvidenceBytesStatus,
}

/// Source bytes resolved by a caller for one persisted graph-evidence record.
///
/// The adapter that creates this value owns URI resolution and source access
/// policy. This type deliberately accepts bytes, not paths or network clients.
#[derive(Debug, Clone, Copy)]
pub struct EvidenceSourceBytes<'a> {
    /// Validated evidence record that binds a source URI to a graph node.
    pub evidence: &'a GraphEvidence,
    /// Exact bytes obtained by the caller's source adapter.
    pub source_bytes: &'a [u8],
}

/// Bytes resolved by a caller for one source URI in an immutable snapshot.
#[derive(Debug, Clone, Copy)]
pub struct ResolvedEvidenceBytes<'a> {
    /// Exact source URI used by the snapshot evidence record.
    pub source_uri: &'a str,
    /// Exact bytes returned by the caller's trusted source adapter.
    pub source_bytes: &'a [u8],
}

/// Aggregate outcome for an exact graph evidence-reference inventory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceManifestStatus {
    /// The graph declares no evidence references; this is not an attestation.
    Empty,
    /// Every declared reference resolved once and every supplied byte digest matched.
    Match,
    /// The reference inventory is complete, but at least one byte digest differed.
    Mismatch,
}

/// Deterministic integrity report bound to the graph's declared identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceManifestIntegrity {
    /// Declared graph identity copied from the validated graph input.
    pub graph_hash: String,
    /// Aggregate byte-integrity result; never an approval or claim verdict.
    pub status: EvidenceManifestStatus,
    /// Per-node/reference results in lexicographic node-ID and source-URI order.
    pub entries: Vec<EvidenceBytesIntegrity>,
}

impl EvidenceManifestIntegrity {
    /// SHA-256 of the canonical graph identity, report status and sorted entries.
    ///
    /// This digest binds the graph identity and byte-integrity report
    /// (aggregate status plus evidence/node/source identities and
    /// expected/observed digests). It is not the Node evidence lineage manifest
    /// hash, a signed verifier receipt, or claim authority.
    pub fn byte_integrity_manifest_sha256(&self) -> Result<String, AggError> {
        let value = serde_json::json!({
            "graph_hash": &self.graph_hash,
            "status": &self.status,
            "entries": &self.entries,
        });
        let value = serde_json::to_value(value).map_err(|error| {
            AggError::Invalid(format!("cannot serialize byte-integrity manifest: {error}"))
        })?;
        let canonical =
            runalith_protocol::agg_checkpoint_v2::canonicalize(&value).map_err(|error| {
                AggError::Invalid(format!(
                    "cannot canonicalize byte-integrity manifest: {error}"
                ))
            })?;
        Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
    }
}

/// Hash exact source bytes and compare them with the evidence's declared digest.
///
/// The caller is responsible for obtaining bytes from an appropriately
/// authenticated/durable source adapter. A `Match` only establishes byte
/// integrity for those supplied bytes; it never upgrades claim verification.
pub fn compare_source_bytes(
    evidence: &GraphEvidence,
    source_bytes: &[u8],
) -> Result<EvidenceBytesIntegrity, AggError> {
    if source_bytes.len() > MAX_EVIDENCE_SOURCE_BYTES {
        return Err(AggError::Invalid(format!(
            "evidence source exceeds the {MAX_EVIDENCE_SOURCE_BYTES}-byte limit"
        )));
    }
    evidence
        .validate()
        .map_err(|error| AggError::Invalid(format!("invalid graph evidence: {error}")))?;
    if matches!(
        evidence.verification,
        EvidenceVerification::Verified | EvidenceVerification::Rejected
    ) {
        let verifier_id = evidence.verifier_id.as_deref().unwrap_or_default();
        if verifier_id.trim().is_empty()
            || verifier_id.len() > 256
            || verifier_id.trim() != verifier_id
            || verifier_id.chars().any(char::is_control)
        {
            return Err(AggError::Invalid(
                "invalid graph evidence verifier identity".into(),
            ));
        }
    }

    let observed_sha256 = hex::encode(Sha256::digest(source_bytes));
    let status = if observed_sha256 == evidence.source_sha256 {
        EvidenceBytesStatus::Match
    } else {
        EvidenceBytesStatus::Mismatch
    };

    Ok(EvidenceBytesIntegrity {
        evidence_id: evidence.evidence_id.clone(),
        node_id: evidence.node_id.clone(),
        source_uri: evidence.source_uri.clone(),
        expected_sha256: evidence.source_sha256.clone(),
        observed_sha256,
        status,
    })
}

/// Compare an exact evidence manifest against caller-resolved source bytes.
///
/// Every `(node_id, source_uri)` binding must have exactly one evidence record
/// and exact bytes. A source URI may be referenced by multiple nodes, but each
/// node binding needs its own evidence record. Duplicate references on a node,
/// duplicate evidence IDs/bindings, extra records, unresolved references and
/// records bound to a node that does not reference them are rejected. A digest
/// mismatch is retained as a non-authorizing result rather than treated as a
/// claim rejection. URI resolution, artifact producer lineage, source authority,
/// content durability and claim truth remain outside this function.
pub fn compare_graph_evidence_manifest(
    graph: &AggGraph,
    sources: &[EvidenceSourceBytes<'_>],
) -> Result<EvidenceManifestIntegrity, AggError> {
    graph.validate()?;

    let mut expected_bindings = BTreeSet::new();
    for node in &graph.nodes {
        let mut node_refs = BTreeSet::new();
        for reference in &node.evidence_refs {
            if !node_refs.insert(reference.as_str()) {
                return Err(AggError::Invalid(format!(
                    "duplicate evidence reference on graph node {}: {reference}",
                    node.id
                )));
            }
            expected_bindings.insert((node.id.as_str(), reference.as_str()));
        }
    }

    let mut evidence_ids = BTreeSet::new();
    let mut by_binding = BTreeMap::new();
    for source in sources {
        source
            .evidence
            .validate()
            .map_err(|error| AggError::Invalid(format!("invalid graph evidence: {error}")))?;
        if !evidence_ids.insert(source.evidence.evidence_id.as_str()) {
            return Err(AggError::Invalid(format!(
                "duplicate graph evidence ID: {}",
                source.evidence.evidence_id
            )));
        }
        let source_uri = source.evidence.source_uri.as_str();
        let binding = (source.evidence.node_id.as_str(), source_uri);
        if !expected_bindings.contains(&binding) {
            return Err(AggError::Invalid(format!(
                "evidence record binding is not referenced by graph: {} -> {source_uri}",
                source.evidence.node_id
            )));
        }
        if by_binding.insert(binding, source).is_some() {
            return Err(AggError::Invalid(format!(
                "duplicate graph evidence binding: {} -> {source_uri}",
                source.evidence.node_id
            )));
        }
    }

    let mut entries = Vec::with_capacity(expected_bindings.len());
    for (node_id, source_uri) in expected_bindings {
        let source = by_binding.get(&(node_id, source_uri)).ok_or_else(|| {
            AggError::Invalid(format!(
                "unresolved graph evidence binding: {node_id} -> {source_uri}"
            ))
        })?;
        entries.push(compare_source_bytes(source.evidence, source.source_bytes)?);
    }

    let status = if entries.is_empty() {
        EvidenceManifestStatus::Empty
    } else if entries
        .iter()
        .any(|entry| entry.status == EvidenceBytesStatus::Mismatch)
    {
        EvidenceManifestStatus::Mismatch
    } else {
        EvidenceManifestStatus::Match
    };

    Ok(EvidenceManifestIntegrity {
        graph_hash: graph.graph_hash.clone(),
        status,
        entries,
    })
}

/// Compare bytes for all evidence pinned by one immutable graph snapshot.
///
/// This validates the snapshot digest, requires the supplied AGG graph to be
/// the exact planner projection of that snapshot for the start/goal IDs carried
/// by the supplied graph, and then checks one resolved byte sequence per pinned
/// evidence URI. The snapshot schema does not itself pin those start/goal IDs.
/// This function still does not resolve URIs, authenticate a source adapter,
/// establish artifact producer lineage, or verify the truth or independence of
/// a claim.
pub fn compare_snapshot_evidence_manifest(
    graph: &AggGraph,
    snapshot: &GraphSnapshot,
    resolved_sources: &[ResolvedEvidenceBytes<'_>],
) -> Result<EvidenceManifestIntegrity, AggError> {
    snapshot
        .validate()
        .map_err(|error| AggError::Invalid(format!("invalid graph snapshot: {error}")))?;
    if graph.graph_hash != snapshot.snapshot_sha256 {
        return Err(AggError::Invalid(
            "AGG graph hash does not bind the supplied immutable snapshot".into(),
        ));
    }

    let projected = crate::project_snapshot(
        &snapshot.snapshot_sha256,
        &graph.start_node_id,
        &graph.goal_node_id,
        &snapshot.nodes,
        &snapshot.edges,
    )?;
    if projected.start_node_id != graph.start_node_id
        || projected.goal_node_id != graph.goal_node_id
        || projected.nodes != graph.nodes
        || projected.edges != graph.edges
    {
        return Err(AggError::Invalid(
            "AGG graph is not the exact projection of the supplied immutable snapshot".into(),
        ));
    }

    let mut bytes_by_uri = BTreeMap::new();
    for resolved in resolved_sources {
        if bytes_by_uri
            .insert(resolved.source_uri, resolved.source_bytes)
            .is_some()
        {
            return Err(AggError::Invalid(format!(
                "duplicate resolved evidence source URI: {}",
                resolved.source_uri
            )));
        }
    }

    let evidence_uris: BTreeSet<&str> = snapshot
        .evidence
        .iter()
        .map(|evidence| evidence.source_uri.as_str())
        .collect();
    if let Some(extra) = bytes_by_uri
        .keys()
        .find(|source_uri| !evidence_uris.contains(**source_uri))
    {
        return Err(AggError::Invalid(format!(
            "resolved source URI is not pinned by snapshot evidence: {extra}"
        )));
    }

    let mut evidence_sources = Vec::with_capacity(snapshot.evidence.len());
    for evidence in &snapshot.evidence {
        let source_bytes = bytes_by_uri
            .get(evidence.source_uri.as_str())
            .ok_or_else(|| {
                AggError::Invalid(format!(
                    "snapshot evidence source bytes are unresolved: {}",
                    evidence.source_uri
                ))
            })?;
        evidence_sources.push(EvidenceSourceBytes {
            evidence,
            source_bytes,
        });
    }

    compare_graph_evidence_manifest(graph, &evidence_sources)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AggEdge, AggEdgeKind, AggGraph, AggNode, AggNodeKind};
    use runalith_domain::{
        EvidenceVerification, GraphEdge, GraphEdgeKind, GraphNodeKind, GraphNodeRevision,
        GraphSnapshot, GraphSnapshotDraft, content_hash,
    };

    fn evidence(bytes: &[u8]) -> GraphEvidence {
        GraphEvidence {
            evidence_id: "evidence-1".into(),
            node_id: "claim-1".into(),
            source_uri: "artifact://sha256/source".into(),
            source_sha256: hex::encode(Sha256::digest(bytes)),
            claim: "The source supports the claim".into(),
            verification: EvidenceVerification::Unverified,
            verifier_id: None,
            verification_receipt_sha256: None,
        }
    }

    fn graph_with_refs(references: &[&str]) -> AggGraph {
        AggGraph {
            graph_hash: "b".repeat(64),
            start_node_id: "start".into(),
            goal_node_id: "goal".into(),
            nodes: vec![
                AggNode {
                    id: "start".into(),
                    kind: AggNodeKind::Capability,
                    label: None,
                    estimated_cost: None,
                    estimated_risk: None,
                    estimated_success_confidence: None,
                    reuse_potential: None,
                    information_value: None,
                    evidence_refs: vec![],
                },
                AggNode {
                    id: "claim".into(),
                    kind: AggNodeKind::Evidence,
                    label: None,
                    estimated_cost: None,
                    estimated_risk: None,
                    estimated_success_confidence: None,
                    reuse_potential: None,
                    information_value: None,
                    evidence_refs: references.iter().map(|value| (*value).into()).collect(),
                },
                AggNode {
                    id: "goal".into(),
                    kind: AggNodeKind::Goal,
                    label: None,
                    estimated_cost: None,
                    estimated_risk: None,
                    estimated_success_confidence: None,
                    reuse_potential: None,
                    information_value: None,
                    evidence_refs: vec![],
                },
            ],
            edges: vec![
                AggEdge {
                    from: "start".into(),
                    to: "claim".into(),
                    kind: AggEdgeKind::NextStep,
                },
                AggEdge {
                    from: "claim".into(),
                    to: "goal".into(),
                    kind: AggEdgeKind::NextStep,
                },
            ],
        }
    }

    fn evidence_for(reference: &str, bytes: &[u8]) -> GraphEvidence {
        let mut evidence = evidence(bytes);
        evidence.source_uri = reference.into();
        evidence.node_id = "claim".into();
        evidence
    }

    fn snapshot_node(
        node_id: &str,
        kind: GraphNodeKind,
        agg_kind: &str,
        evidence_refs: &[&str],
    ) -> GraphNodeRevision {
        let content = serde_json::json!({
            "agg": {
                "kind": agg_kind,
                "evidence_refs": evidence_refs,
            }
        });
        GraphNodeRevision {
            node_id: node_id.into(),
            kind,
            revision: 1,
            title: format!("{node_id} title"),
            content_sha256: content_hash(&content).unwrap(),
            content,
            previous_revision_sha256: None,
        }
    }

    fn snapshot_with_evidence(reference: &str, source_bytes: &[u8]) -> GraphSnapshot {
        GraphSnapshot::seal(GraphSnapshotDraft {
            graph_id: "graph-integrity".into(),
            revision: 1,
            nodes: vec![
                snapshot_node("start", GraphNodeKind::Idea, "capability", &[]),
                snapshot_node("claim", GraphNodeKind::Artifact, "evidence", &[reference]),
                snapshot_node("goal", GraphNodeKind::Goal, "goal", &[]),
            ],
            edges: vec![
                GraphEdge {
                    edge_id: "edge-start-claim".into(),
                    from_node_id: "start".into(),
                    to_node_id: "claim".into(),
                    kind: GraphEdgeKind::NextStep,
                },
                GraphEdge {
                    edge_id: "edge-claim-goal".into(),
                    from_node_id: "claim".into(),
                    to_node_id: "goal".into(),
                    kind: GraphEdgeKind::NextStep,
                },
            ],
            evidence: vec![evidence_for(reference, source_bytes)],
            previous_snapshot_revision: None,
            previous_snapshot_sha256: None,
            created_at: "2026-11-02T09:00:00Z".into(),
        })
        .unwrap()
    }

    fn snapshot_with_shared_evidence(reference: &str, source_bytes: &[u8]) -> GraphSnapshot {
        let base = snapshot_with_evidence(reference, source_bytes);
        let mut start = base.nodes[0].clone();
        start.content["agg"]["evidence_refs"] = serde_json::json!([reference]);
        start.content_sha256 = content_hash(&start.content).unwrap();

        let mut second_evidence = base.evidence[0].clone();
        second_evidence.evidence_id = "evidence-2".into();
        second_evidence.node_id = "start".into();

        GraphSnapshot::seal(GraphSnapshotDraft {
            graph_id: base.graph_id,
            revision: base.revision,
            nodes: vec![start, base.nodes[1].clone(), base.nodes[2].clone()],
            edges: base.edges,
            evidence: vec![base.evidence[0].clone(), second_evidence],
            previous_snapshot_revision: base.previous_snapshot_revision,
            previous_snapshot_sha256: base.previous_snapshot_sha256,
            created_at: base.created_at,
        })
        .unwrap()
    }

    fn projected_snapshot(snapshot: &GraphSnapshot) -> AggGraph {
        crate::project_snapshot(
            &snapshot.snapshot_sha256,
            "start",
            "goal",
            &snapshot.nodes,
            &snapshot.edges,
        )
        .unwrap()
    }

    #[test]
    fn exact_source_bytes_match_the_declared_digest_without_verifying_the_claim() {
        let source = b"immutable source bytes";
        let evidence = evidence(source);

        let report = compare_source_bytes(&evidence, source).unwrap();

        assert_eq!(report.evidence_id, "evidence-1");
        assert_eq!(report.node_id, evidence.node_id);
        assert_eq!(report.source_uri, evidence.source_uri);
        assert_eq!(report.status, EvidenceBytesStatus::Match);
        assert_eq!(report.expected_sha256, evidence.source_sha256);
        assert_eq!(report.observed_sha256, evidence.source_sha256);
        assert_eq!(evidence.verification, EvidenceVerification::Unverified);
    }

    #[test]
    fn changed_source_bytes_are_reported_as_mismatch_not_claim_rejection() {
        let evidence = evidence(b"original bytes");

        let report = compare_source_bytes(&evidence, b"substituted bytes").unwrap();

        assert_eq!(report.status, EvidenceBytesStatus::Mismatch);
        assert_ne!(report.expected_sha256, report.observed_sha256);
        assert_eq!(evidence.verification, EvidenceVerification::Unverified);
    }

    #[test]
    fn invalid_evidence_digest_is_rejected_before_comparison() {
        let mut evidence = evidence(b"original bytes");
        evidence.source_sha256 = "not-a-sha256".into();

        assert!(matches!(
            compare_source_bytes(&evidence, b"original bytes"),
            Err(AggError::Invalid(_))
        ));
    }

    #[test]
    fn verified_evidence_requires_a_bounded_non_whitespace_verifier_identity() {
        for verifier_id in ["   ", " verifier ", "reviewer\nforged", &"v".repeat(257)] {
            let mut evidence = evidence(b"original bytes");
            evidence.verification = EvidenceVerification::Verified;
            evidence.verifier_id = Some(verifier_id.to_owned());
            evidence.verification_receipt_sha256 = Some("a".repeat(64));

            assert!(
                matches!(
                    compare_source_bytes(&evidence, b"original bytes"),
                    Err(AggError::Invalid(message)) if message.contains("verifier identity")
                ),
                "accepted invalid verifier identity: {verifier_id:?}"
            );
        }
    }

    #[test]
    fn oversized_source_bytes_are_rejected_before_hashing() {
        let evidence = evidence(b"small source");
        let oversized = vec![0_u8; MAX_EVIDENCE_SOURCE_BYTES + 1];

        assert!(matches!(
            compare_source_bytes(&evidence, &oversized),
            Err(AggError::Invalid(message)) if message.contains("exceeds")
        ));
    }

    #[test]
    fn byte_integrity_result_round_trips_without_claim_authority_fields() {
        let evidence = evidence(b"round-trip bytes");
        let report = compare_source_bytes(&evidence, b"round-trip bytes").unwrap();

        let encoded = serde_json::to_vec(&report).unwrap();
        let decoded: EvidenceBytesIntegrity = serde_json::from_slice(&encoded).unwrap();

        assert_eq!(decoded, report);
        assert!(serde_json::from_slice::<EvidenceBytesIntegrity>(
            br#"{"evidence_id":"evidence-1","source_uri":"artifact://sha256/source","expected_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","observed_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"match","verified":true}"#
        )
        .is_err());
    }

    #[test]
    fn graph_manifest_requires_exact_reference_coverage_and_sorts_results() {
        let first_bytes = b"first source";
        let second_bytes = b"second source";
        let first_ref = "artifact://sha256/first";
        let second_ref = "file:sha256/second";
        let graph = graph_with_refs(&[first_ref, second_ref]);
        let first = evidence_for(first_ref, first_bytes);
        let mut second = evidence_for(second_ref, second_bytes);
        second.evidence_id = "evidence-2".into();
        let supplied = [
            EvidenceSourceBytes {
                evidence: &second,
                source_bytes: second_bytes,
            },
            EvidenceSourceBytes {
                evidence: &first,
                source_bytes: first_bytes,
            },
        ];

        let report = compare_graph_evidence_manifest(&graph, &supplied).unwrap();

        assert_eq!(report.graph_hash, graph.graph_hash);
        assert_eq!(report.status, EvidenceManifestStatus::Match);
        assert_eq!(report.entries.len(), 2);
        assert_eq!(report.entries[0].source_uri, first_ref);
        assert_eq!(report.entries[1].source_uri, second_ref);
    }

    #[test]
    fn graph_manifest_tracks_node_bindings_even_when_nodes_share_a_source_uri() {
        let source_ref = "artifact://sha256/shared-source";
        let source_bytes = b"shared source bytes";
        let mut graph = graph_with_refs(&[source_ref]);
        let mut second_node = graph.nodes[1].clone();
        second_node.id = "claim-two".into();
        graph.nodes.insert(2, second_node);
        graph.edges.push(AggEdge {
            from: "start".into(),
            to: "claim-two".into(),
            kind: AggEdgeKind::Enables,
        });
        graph.edges.push(AggEdge {
            from: "claim-two".into(),
            to: "goal".into(),
            kind: AggEdgeKind::Enables,
        });
        let first = evidence_for(source_ref, source_bytes);
        let mut second = evidence_for(source_ref, source_bytes);
        second.evidence_id = "evidence-2".into();
        second.node_id = "claim-two".into();

        let report = compare_graph_evidence_manifest(
            &graph,
            &[
                EvidenceSourceBytes {
                    evidence: &first,
                    source_bytes,
                },
                EvidenceSourceBytes {
                    evidence: &second,
                    source_bytes,
                },
            ],
        )
        .unwrap();

        assert_eq!(report.status, EvidenceManifestStatus::Match);
        assert_eq!(report.entries.len(), 2);
        assert_eq!(report.entries[0].evidence_id, "evidence-1");
        assert_eq!(report.entries[1].evidence_id, "evidence-2");
    }

    #[test]
    fn graph_manifest_reports_mismatch_without_upgrading_claim_verification() {
        let source_ref = "artifact://sha256/source";
        let graph = graph_with_refs(&[source_ref]);
        let evidence = evidence_for(source_ref, b"expected source");
        let supplied = [EvidenceSourceBytes {
            evidence: &evidence,
            source_bytes: b"changed source",
        }];

        let report = compare_graph_evidence_manifest(&graph, &supplied).unwrap();

        assert_eq!(report.status, EvidenceManifestStatus::Mismatch);
        assert_eq!(report.entries[0].status, EvidenceBytesStatus::Mismatch);
        assert_eq!(evidence.verification, EvidenceVerification::Unverified);
    }

    #[test]
    fn graph_manifest_rejects_missing_extra_duplicate_and_misbound_records() {
        let source_ref = "artifact://sha256/source";
        let graph = graph_with_refs(&[source_ref]);
        let evidence = evidence_for(source_ref, b"source");

        assert!(compare_graph_evidence_manifest(&graph, &[]).is_err());
        let extra = evidence_for("artifact://sha256/extra", b"source");
        assert!(
            compare_graph_evidence_manifest(
                &graph,
                &[EvidenceSourceBytes {
                    evidence: &extra,
                    source_bytes: b"source"
                }]
            )
            .is_err()
        );
        assert!(
            compare_graph_evidence_manifest(
                &graph,
                &[
                    EvidenceSourceBytes {
                        evidence: &evidence,
                        source_bytes: b"source"
                    },
                    EvidenceSourceBytes {
                        evidence: &evidence,
                        source_bytes: b"source"
                    }
                ]
            )
            .is_err()
        );

        let mut same_ref_different_id = evidence.clone();
        same_ref_different_id.evidence_id = "evidence-2".into();
        assert!(
            compare_graph_evidence_manifest(
                &graph,
                &[
                    EvidenceSourceBytes {
                        evidence: &evidence,
                        source_bytes: b"source"
                    },
                    EvidenceSourceBytes {
                        evidence: &same_ref_different_id,
                        source_bytes: b"source"
                    }
                ]
            )
            .is_err()
        );

        let mut misbound = evidence.clone();
        misbound.node_id = "start".into();
        assert!(
            compare_graph_evidence_manifest(
                &graph,
                &[EvidenceSourceBytes {
                    evidence: &misbound,
                    source_bytes: b"source"
                }]
            )
            .is_err()
        );

        let graph_with_duplicate_node_ref = graph_with_refs(&[source_ref, source_ref]);
        assert!(
            compare_graph_evidence_manifest(
                &graph_with_duplicate_node_ref,
                &[EvidenceSourceBytes {
                    evidence: &evidence,
                    source_bytes: b"source"
                }]
            )
            .is_err()
        );
    }

    #[test]
    fn empty_graph_evidence_manifest_is_explicit_not_a_verified_manifest() {
        let graph = graph_with_refs(&[]);

        let report = compare_graph_evidence_manifest(&graph, &[]).unwrap();

        assert_eq!(report.status, EvidenceManifestStatus::Empty);
        assert!(report.entries.is_empty());
    }

    #[test]
    fn immutable_snapshot_bytes_require_exact_snapshot_projection_and_reference_set() {
        let source_ref = "artifact://sha256/snapshot-source";
        let source_bytes = b"pinned snapshot evidence bytes";
        let snapshot = snapshot_with_evidence(source_ref, source_bytes);
        let graph = projected_snapshot(&snapshot);

        let report = compare_snapshot_evidence_manifest(
            &graph,
            &snapshot,
            &[ResolvedEvidenceBytes {
                source_uri: source_ref,
                source_bytes,
            }],
        )
        .unwrap();

        assert_eq!(report.graph_hash, snapshot.snapshot_sha256);
        assert_eq!(report.status, EvidenceManifestStatus::Match);
        assert_eq!(report.entries.len(), 1);
        assert_eq!(report.entries[0].status, EvidenceBytesStatus::Match);

        let mismatched_bytes = [ResolvedEvidenceBytes {
            source_uri: source_ref,
            source_bytes: b"different bytes",
        }];
        let mismatch =
            compare_snapshot_evidence_manifest(&graph, &snapshot, &mismatched_bytes).unwrap();
        assert_eq!(mismatch.status, EvidenceManifestStatus::Mismatch);
        assert_eq!(mismatch.entries[0].status, EvidenceBytesStatus::Mismatch);
    }

    #[test]
    fn immutable_snapshot_resolves_shared_source_once_and_checks_each_node_binding() {
        let source_ref = "artifact://sha256/shared-snapshot-source";
        let source_bytes = b"shared snapshot evidence";
        let snapshot = snapshot_with_shared_evidence(source_ref, source_bytes);
        let graph = projected_snapshot(&snapshot);

        let report = compare_snapshot_evidence_manifest(
            &graph,
            &snapshot,
            &[ResolvedEvidenceBytes {
                source_uri: source_ref,
                source_bytes,
            }],
        )
        .unwrap();

        assert_eq!(report.status, EvidenceManifestStatus::Match);
        assert_eq!(report.entries.len(), 2);
        assert_eq!(report.entries[0].node_id, "claim");
        assert_eq!(report.entries[1].node_id, "start");
        assert_eq!(report.entries[0].source_uri, source_ref);
        assert_eq!(report.entries[1].source_uri, source_ref);
    }

    #[test]
    fn immutable_snapshot_integrity_rejects_projection_snapshot_and_resolution_mismatch() {
        let source_ref = "artifact://sha256/snapshot-source";
        let source_bytes = b"pinned snapshot evidence bytes";
        let snapshot = snapshot_with_evidence(source_ref, source_bytes);
        let graph = projected_snapshot(&snapshot);
        let resolved = [ResolvedEvidenceBytes {
            source_uri: source_ref,
            source_bytes,
        }];

        let mut changed_projection = graph.clone();
        changed_projection.nodes[1].label = Some("forged projection".into());
        assert!(
            compare_snapshot_evidence_manifest(&changed_projection, &snapshot, &resolved).is_err()
        );

        let mut changed_graph_identity = graph.clone();
        changed_graph_identity.graph_hash = "e".repeat(64);
        assert!(
            compare_snapshot_evidence_manifest(&changed_graph_identity, &snapshot, &resolved)
                .is_err()
        );

        let mut changed_snapshot = snapshot.clone();
        changed_snapshot.evidence[0].claim.push_str(" changed");
        assert!(compare_snapshot_evidence_manifest(&graph, &changed_snapshot, &resolved).is_err());

        assert!(compare_snapshot_evidence_manifest(&graph, &snapshot, &[]).is_err());
        let extra = ResolvedEvidenceBytes {
            source_uri: "artifact://sha256/unpinned-source",
            source_bytes,
        };
        assert!(
            compare_snapshot_evidence_manifest(&graph, &snapshot, &[resolved[0], extra]).is_err()
        );
        assert!(
            compare_snapshot_evidence_manifest(&graph, &snapshot, &[resolved[0], resolved[0]])
                .is_err()
        );
    }

    #[test]
    fn byte_integrity_manifest_digest_is_order_independent_and_binds_observed_bytes() {
        let first_ref = "artifact://sha256/first";
        let second_ref = "file:sha256/second";
        let graph = graph_with_refs(&[first_ref, second_ref]);
        let first = evidence_for(first_ref, b"first source");
        let second = evidence_for(second_ref, b"second source");
        let mut second = second;
        second.evidence_id = "evidence-2".into();
        let reverse = compare_graph_evidence_manifest(
            &graph,
            &[
                EvidenceSourceBytes {
                    evidence: &second,
                    source_bytes: b"second source",
                },
                EvidenceSourceBytes {
                    evidence: &first,
                    source_bytes: b"first source",
                },
            ],
        )
        .unwrap();
        let forward = compare_graph_evidence_manifest(
            &graph,
            &[
                EvidenceSourceBytes {
                    evidence: &first,
                    source_bytes: b"first source",
                },
                EvidenceSourceBytes {
                    evidence: &second,
                    source_bytes: b"second source",
                },
            ],
        )
        .unwrap();

        let digest = reverse.byte_integrity_manifest_sha256().unwrap();
        assert_eq!(digest, forward.byte_integrity_manifest_sha256().unwrap());
        assert_eq!(digest.len(), 64);

        let mut different_snapshot = forward.clone();
        different_snapshot.graph_hash = "e".repeat(64);
        assert_ne!(
            digest,
            different_snapshot.byte_integrity_manifest_sha256().unwrap()
        );

        let mut different_status = forward.clone();
        different_status.status = EvidenceManifestStatus::Mismatch;
        assert_ne!(
            digest,
            different_status.byte_integrity_manifest_sha256().unwrap()
        );

        let mut altered = reverse;
        altered.entries[0].observed_sha256 = "f".repeat(64);
        assert_ne!(digest, altered.byte_integrity_manifest_sha256().unwrap());
    }
}
