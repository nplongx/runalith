//! Cross-language golden-vector tests for the immutable W5 artifact manifest.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use tempfile::tempdir;

use runalith_artifacts::{ArtifactStore, contracts::ArtifactManifestV1};

#[derive(Debug, Deserialize)]
struct GoldenFixture {
    artifact_bytes_utf8: String,
    artifact_sha256: String,
    manifest: serde_json::Value,
    canonical_utf8: String,
    canonical_sha256: String,
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn fixture() -> GoldenFixture {
    serde_json::from_str(include_str!("fixtures/artifact-manifest-v1-golden.json"))
        .expect("valid shared artifact-manifest golden fixture")
}

#[test]
fn rust_manifest_canonical_bytes_match_the_shared_cross_language_golden_vector() {
    let fixture = fixture();
    let artifact_bytes = fixture.artifact_bytes_utf8.as_bytes();
    assert_eq!(sha256(artifact_bytes), fixture.artifact_sha256);

    let manifest: ArtifactManifestV1 = serde_json::from_value(fixture.manifest)
        .expect("fixture manifest deserializes into the strict W5 DTO");
    let canonical = manifest
        .canonical_json_bytes()
        .expect("fixture manifest passes W5 validation");

    assert_eq!(canonical, fixture.canonical_utf8.as_bytes());
    assert_eq!(sha256(&canonical), fixture.canonical_sha256);
}

#[test]
fn golden_manifest_and_artifact_round_trip_through_the_immutable_store() {
    let fixture = fixture();
    let manifest: ArtifactManifestV1 = serde_json::from_value(fixture.manifest)
        .expect("fixture manifest deserializes into the strict W5 DTO");
    let directory = tempdir().expect("temporary private store directory");
    let store = ArtifactStore::open_or_create(directory.path().join("artifacts"))
        .expect("private artifact store opens");

    let artifact = store
        .put("application/json", fixture.artifact_bytes_utf8.as_bytes())
        .expect("exact artifact bytes are stored");
    assert_eq!(artifact.sha256, fixture.artifact_sha256);
    assert_eq!(
        store.read_ref(&manifest.artifacts[0]).unwrap(),
        fixture.artifact_bytes_utf8.as_bytes()
    );

    let stored_manifest = store
        .put_manifest(&manifest)
        .expect("canonical manifest is published after verifying the referenced bytes");
    assert_eq!(stored_manifest.sha256, fixture.canonical_sha256);
    assert_eq!(
        store.read_manifest_bytes(&stored_manifest).unwrap(),
        fixture.canonical_utf8.as_bytes()
    );
}
