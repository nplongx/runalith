//! Cross-language golden-vector tests for the W5 read-port DTOs.

use serde::Deserialize;
use sha2::{Digest, Sha256};

use runalith_artifacts::read_port::{
    ArtifactReadObservationV1, ArtifactReadRequestV1, MAX_ARTIFACT_READ_METADATA_BYTES,
};

#[derive(Debug, Deserialize)]
struct ReadPortFixture {
    payload_bytes_utf8: String,
    payload_sha256: String,
    request: serde_json::Value,
    request_canonical_utf8: String,
    request_sha256: String,
    available_observation: serde_json::Value,
    available_observation_canonical_utf8: String,
    available_observation_sha256: String,
    not_found_observation: serde_json::Value,
    not_found_observation_canonical_utf8: String,
    not_found_observation_sha256: String,
}

fn fixture() -> ReadPortFixture {
    serde_json::from_str(include_str!("fixtures/artifact-read-port-v1-golden.json"))
        .expect("valid W5 read-port golden fixture")
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[test]
fn read_port_request_and_observation_bytes_match_cross_language_golden_vectors() {
    let fixture = fixture();
    assert_eq!(
        sha256(fixture.payload_bytes_utf8.as_bytes()),
        fixture.payload_sha256
    );

    let request: ArtifactReadRequestV1 =
        serde_json::from_value(fixture.request).expect("golden request deserializes");
    let request_bytes = request.canonical_json_bytes().unwrap();
    assert_eq!(request_bytes, fixture.request_canonical_utf8.as_bytes());
    assert_eq!(sha256(&request_bytes), fixture.request_sha256);

    let source_service_id = "execution.worker-reader";
    let available: ArtifactReadObservationV1 =
        serde_json::from_value(fixture.available_observation)
            .expect("AVAILABLE observation deserializes");
    let available_bytes = available
        .canonical_json_bytes(
            &request,
            source_service_id,
            "read-observation-1",
            "2026-11-03T10:01:00Z",
        )
        .unwrap();
    assert_eq!(
        available_bytes,
        fixture.available_observation_canonical_utf8.as_bytes()
    );
    assert_eq!(
        sha256(&available_bytes),
        fixture.available_observation_sha256
    );

    let not_found: ArtifactReadObservationV1 =
        serde_json::from_value(fixture.not_found_observation)
            .expect("NOT_FOUND observation deserializes");
    let not_found_bytes = not_found
        .canonical_json_bytes(
            &request,
            source_service_id,
            "read-observation-2",
            "2026-11-03T10:02:00Z",
        )
        .unwrap();
    assert_eq!(
        not_found_bytes,
        fixture.not_found_observation_canonical_utf8.as_bytes()
    );
    assert_eq!(
        sha256(&not_found_bytes),
        fixture.not_found_observation_sha256
    );
}

#[test]
fn read_port_parser_rejects_unknown_duplicate_oversized_and_wrong_source_fields() {
    let fixture = fixture();
    let request =
        ArtifactReadRequestV1::from_json_bytes(fixture.request_canonical_utf8.as_bytes()).unwrap();
    let source_service_id = "execution.worker-reader";

    let unknown_field = fixture
        .request_canonical_utf8
        .strip_suffix('}')
        .unwrap()
        .to_owned()
        + ",\"unexpected\":true}";
    assert!(ArtifactReadRequestV1::from_json_bytes(unknown_field.as_bytes()).is_err());

    let duplicate_field = fixture
        .request_canonical_utf8
        .strip_suffix('}')
        .unwrap()
        .to_owned()
        + ",\"request_id\":\"forged\"}";
    assert!(ArtifactReadRequestV1::from_json_bytes(duplicate_field.as_bytes()).is_err());

    let oversized = vec![b' '; MAX_ARTIFACT_READ_METADATA_BYTES + 1];
    assert!(ArtifactReadRequestV1::from_json_bytes(&oversized).is_err());

    let wrong_source = fixture
        .available_observation_canonical_utf8
        .replace(source_service_id, "execution.other-reader");
    assert!(
        ArtifactReadObservationV1::from_json_bytes(
            wrong_source.as_bytes(),
            &request,
            source_service_id,
            "read-observation-1",
            "2026-11-03T10:01:00Z",
        )
        .is_err()
    );

    let valid_observation = ArtifactReadObservationV1::from_json_bytes(
        fixture.available_observation_canonical_utf8.as_bytes(),
        &request,
        source_service_id,
        "read-observation-1",
        "2026-11-03T10:01:00Z",
    )
    .unwrap();
    assert_eq!(valid_observation.source_service_id, source_service_id);
}

#[test]
fn reordered_request_fields_parse_but_canonical_output_uses_fixed_order() {
    let fixture = fixture();
    let canonical = fixture.request_canonical_utf8;
    let reordered = canonical.replacen(
        "{\"contract_version\":\"1.0\",\"request_id\":",
        "{\"request_id\":",
        1,
    );
    let reordered = reordered.replacen(
        "\"read-request-1\",\"correlation_id\":",
        "\"read-request-1\",\"contract_version\":\"1.0\",\"correlation_id\":",
        1,
    );
    let request = ArtifactReadRequestV1::from_json_bytes(reordered.as_bytes()).unwrap();
    assert_eq!(
        request.canonical_json_bytes().unwrap(),
        canonical.as_bytes()
    );
}
