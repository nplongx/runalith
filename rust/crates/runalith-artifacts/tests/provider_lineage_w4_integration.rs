//! W5 packaging integration against the immutable W4 sidecar golden examples.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use tempfile::tempdir;

use runalith_artifacts::{
    ArtifactStore,
    contracts::{
        ArtifactLineageV1, ArtifactManifestV1, ArtifactRefV1, ArtifactSourceV1, CONTRACT_VERSION_V1,
    },
};

#[derive(Debug, Deserialize)]
struct W4FixtureSet {
    w4_schema_sha256: String,
    w4_example_sha256: String,
    w4_validator_sha256: String,
    content_schema_id: String,
    content_schema_version: String,
    /// Test-only value standing in for a separately authenticated host context.
    execution_host_service_id: String,
    examples: Vec<W4Example>,
}

#[derive(Debug, Deserialize)]
struct W4Example {
    source: W4Source,
    /// Test-only host timestamp for W5 object/reference creation.
    w5_artifact_created_at: String,
    response_bytes_utf8: String,
    response_artifact: W4ArtifactRef,
    sidecar_bytes_utf8: String,
    sidecar_sha256: String,
    sidecar_expected_sha256: String,
    verification_receipt_bytes_utf8: Option<String>,
    verification_receipt_artifact: Option<W4ArtifactRef>,
}

#[derive(Debug, Deserialize)]
struct W4Source {
    producer_id: String,
    workflow_id: String,
    task_id: String,
    attempt: u64,
    correlation_id: String,
    created_at: String,
}

#[derive(Debug, Deserialize)]
struct W4ArtifactRef {
    artifact_id: String,
    sha256: String,
    byte_len: u64,
    media_type: String,
}

fn fixture() -> W4FixtureSet {
    serde_json::from_str(include_str!(
        "fixtures/provider-terminal-lineage-v1-w4-golden.json"
    ))
    .expect("W4 provider terminal lineage examples are valid JSON")
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn source_ref(
    source: &W4Source,
    authenticated_execution_service_id: &str,
    w5_artifact_created_at: &str,
) -> ArtifactSourceV1 {
    ArtifactSourceV1 {
        // Never map W4's metadata producer_id or worker_id into the
        // authenticated W5 producer principal. The host supplies this value
        // from its own authentication context; this test fixture is synthetic.
        producer_id: authenticated_execution_service_id.into(),
        workflow_id: source.workflow_id.clone(),
        task_id: source.task_id.clone(),
        attempt: source.attempt,
        correlation_id: source.correlation_id.clone(),
        created_at: w5_artifact_created_at.into(),
    }
}

fn w5_reference(
    stored: runalith_artifacts::StoredArtifact,
    source: ArtifactSourceV1,
    content_schema_id: Option<String>,
    content_schema_version: Option<String>,
) -> ArtifactRefV1 {
    ArtifactRefV1 {
        contract_version: CONTRACT_VERSION_V1.into(),
        artifact_id: stored.artifact_id,
        sha256: stored.sha256,
        byte_len: stored.byte_len,
        media_type: stored.media_type,
        content_schema_id,
        content_schema_version,
        source,
    }
}

#[test]
fn exact_w4_response_sidecar_and_optional_opaque_receipt_package_into_one_w5_manifest() {
    let fixture = fixture();
    assert_eq!(
        fixture.w4_schema_sha256,
        "a6f4a80d7b55de904e646052b24961c95c42f80017c684dd9bee6ba7de9275b5"
    );
    assert_eq!(
        fixture.w4_example_sha256,
        "ed185999c8e38cdb34bcad05fcdfff628de898762ba76ea7bd0e37ef94fc2646"
    );
    assert_eq!(
        fixture.w4_validator_sha256,
        "dbbedf36fb4b76eafc00bf5c98ca7ac30642f4f5bf4615538225d811e670cc22"
    );
    assert_eq!(
        fixture.content_schema_id,
        "runalith.provider-terminal-lineage"
    );
    assert_eq!(fixture.content_schema_version, "1.0");
    assert_ne!(
        fixture.execution_host_service_id, "worker-service",
        "test host identity must remain distinct from W4 metadata producer_id"
    );
    assert_eq!(fixture.examples.len(), 2);

    let directory = tempdir().unwrap();
    let store = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();

    for example in fixture.examples {
        assert!(example.w5_artifact_created_at >= example.source.created_at);
        let source = source_ref(
            &example.source,
            &fixture.execution_host_service_id,
            &example.w5_artifact_created_at,
        );
        let response_bytes = example.response_bytes_utf8.as_bytes();
        assert_eq!(digest(response_bytes), example.response_artifact.sha256);
        assert_eq!(
            response_bytes.len() as u64,
            example.response_artifact.byte_len
        );
        assert_eq!(
            example.response_artifact.artifact_id,
            format!("sha256:{}", example.response_artifact.sha256)
        );
        let stored_response = store
            .put(&example.response_artifact.media_type, response_bytes)
            .unwrap();
        let response_ref = w5_reference(stored_response, source.clone(), None, None);

        let sidecar_bytes = example.sidecar_bytes_utf8.as_bytes();
        assert_eq!(digest(sidecar_bytes), example.sidecar_sha256);
        assert_eq!(example.sidecar_sha256, example.sidecar_expected_sha256);
        let sidecar_value: serde_json::Value = serde_json::from_slice(sidecar_bytes).unwrap();
        assert_eq!(sidecar_value["producer_id"], example.source.producer_id);
        assert_ne!(
            sidecar_value["producer_id"], source.producer_id,
            "W4 sidecar producer metadata must not authenticate W5 ArtifactSource"
        );
        assert_eq!(
            sidecar_value["response_artifact"]["artifact_id"],
            response_ref.artifact_id
        );
        assert_eq!(
            sidecar_value["response_artifact"]["sha256"],
            response_ref.sha256
        );
        assert_eq!(
            sidecar_value["response_artifact"]["byte_len"],
            response_ref.byte_len
        );
        assert_eq!(
            sidecar_value["response_artifact"]["media_type"],
            response_ref.media_type
        );
        let stored_sidecar = store.put("application/json", sidecar_bytes).unwrap();
        let sidecar_ref = w5_reference(
            stored_sidecar,
            source.clone(),
            Some(fixture.content_schema_id.clone()),
            Some(fixture.content_schema_version.clone()),
        );

        let mut artifact_refs = vec![response_ref.clone(), sidecar_ref.clone()];
        if let (Some(receipt_bytes), Some(receipt_metadata)) = (
            example.verification_receipt_bytes_utf8.as_deref(),
            example.verification_receipt_artifact.as_ref(),
        ) {
            let receipt_bytes = receipt_bytes.as_bytes();
            assert_eq!(digest(receipt_bytes), receipt_metadata.sha256);
            assert_eq!(receipt_bytes.len() as u64, receipt_metadata.byte_len);
            assert_eq!(
                receipt_metadata.artifact_id,
                format!("sha256:{}", receipt_metadata.sha256)
            );
            let sidecar_receipt = &sidecar_value["verification_receipt_artifact"];
            assert_eq!(sidecar_receipt["artifact_id"], receipt_metadata.artifact_id);
            assert_eq!(sidecar_receipt["sha256"], receipt_metadata.sha256);
            assert_eq!(sidecar_receipt["byte_len"], receipt_metadata.byte_len);
            assert_eq!(sidecar_receipt["media_type"], receipt_metadata.media_type);
            let stored_receipt = store
                .put(&receipt_metadata.media_type, receipt_bytes)
                .unwrap();
            artifact_refs.push(w5_reference(stored_receipt, source.clone(), None, None));
        } else {
            assert!(example.verification_receipt_bytes_utf8.is_none());
            assert!(example.verification_receipt_artifact.is_none());
            assert!(sidecar_value["verification_receipt_artifact"].is_null());
        }

        let manifest = ArtifactManifestV1 {
            contract_version: CONTRACT_VERSION_V1.into(),
            created_at: example.w5_artifact_created_at.clone(),
            artifacts: artifact_refs.clone(),
            lineage: ArtifactLineageV1 {
                contract_version: CONTRACT_VERSION_V1.into(),
                producer_id: source.producer_id,
                workflow_id: source.workflow_id,
                task_id: source.task_id,
                attempt: source.attempt,
                correlation_id: source.correlation_id,
                created_at: example.w5_artifact_created_at,
                parent_artifacts: Vec::new(),
            },
        };
        let stored_manifest = store.put_manifest(&manifest).unwrap();
        let raw_manifest = store.read_manifest_bytes(&stored_manifest).unwrap();
        let decoded_manifest: ArtifactManifestV1 = serde_json::from_slice(&raw_manifest).unwrap();
        assert_eq!(decoded_manifest, manifest);

        assert_eq!(store.read_ref(&response_ref).unwrap(), response_bytes);
        assert_eq!(store.read_ref(&sidecar_ref).unwrap(), sidecar_bytes);
        if let Some(receipt) = artifact_refs.get(2) {
            let bytes = example
                .verification_receipt_bytes_utf8
                .as_deref()
                .unwrap()
                .as_bytes();
            assert_eq!(store.read_ref(receipt).unwrap(), bytes);
        }
    }
}
