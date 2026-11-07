//! Independent Rust parity check for the WS1 candidate skill-manifest V2 profile.
//!
//! This is fixture/test evidence only. It does not implement or change the
//! production skill importer, trusted-skill resolver, or SkillPinRefV1.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const FIXTURE: &str = include_str!("../../../workstreams/01-skill-manifest-v2.fixtures.json");
const PROFILE_ID: &str = "urn:runalith:skill-manifest:v2-jcs-utf8-nfc-bytewise";
const MAX_FILES: usize = 40;
const MAX_FILE_BYTES: usize = 32 * 1024;
const MAX_TOTAL_BYTES: usize = 160 * 1024;

#[derive(Debug, Deserialize)]
struct ManifestFixture {
    status: String,
    profile: ManifestProfile,
    vectors: Vec<GoldenVector>,
}

#[derive(Debug, Deserialize)]
struct ManifestProfile {
    profile_id: String,
    limits: ManifestLimits,
}

#[derive(Debug, Deserialize)]
struct ManifestLimits {
    max_files: usize,
    max_file_bytes: usize,
    max_total_bytes: usize,
}

#[derive(Debug, Deserialize)]
struct GoldenVector {
    id: String,
    files: Vec<InputFile>,
    records: Vec<ManifestRecord>,
    canonical_json: String,
    canonical_bytes: usize,
    bundle_sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
struct InputFile {
    path: String,
    content_utf8: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
struct ManifestRecord {
    path: String,
    sha256: String,
    size_bytes: usize,
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn compile_manifest(files: &[InputFile]) -> Result<(Vec<ManifestRecord>, Vec<u8>), String> {
    if files.is_empty() || files.len() > MAX_FILES {
        return Err("file_count_out_of_range".to_owned());
    }

    let mut total_bytes = 0usize;
    let mut records = Vec::with_capacity(files.len());
    for file in files {
        let bytes = file.content_utf8.as_bytes();
        if bytes.contains(&0) {
            return Err("file_binary_nul".to_owned());
        }
        if bytes.len() > MAX_FILE_BYTES {
            return Err("file_size_exceeded".to_owned());
        }
        total_bytes = total_bytes
            .checked_add(bytes.len())
            .ok_or_else(|| "total_size_exceeded".to_owned())?;
        if total_bytes > MAX_TOTAL_BYTES {
            return Err("total_size_exceeded".to_owned());
        }
        records.push(ManifestRecord {
            path: file.path.clone(),
            sha256: sha256_hex(bytes),
            size_bytes: bytes.len(),
        });
    }

    // Rust String ordering is Unicode scalar/UTF-8 lexicographic ordering;
    // compare bytes explicitly to make the profile rule visible and stable.
    records.sort_by(|left, right| left.path.as_bytes().cmp(right.path.as_bytes()));
    let canonical_bytes =
        serde_json::to_vec(&records).map_err(|_| "manifest_serialization_failed".to_owned())?;
    Ok((records, canonical_bytes))
}

#[test]
fn rust_manifest_bytes_and_digests_match_node_golden_vectors() {
    let fixture: ManifestFixture =
        serde_json::from_str(FIXTURE).expect("WS1 manifest fixture must parse");
    assert_eq!(fixture.status, "DRAFT_NOT_RATIFIED");
    assert_eq!(fixture.profile.profile_id, PROFILE_ID);
    assert_eq!(fixture.profile.limits.max_files, MAX_FILES);
    assert_eq!(fixture.profile.limits.max_file_bytes, MAX_FILE_BYTES);
    assert_eq!(fixture.profile.limits.max_total_bytes, MAX_TOTAL_BYTES);
    assert_eq!(fixture.vectors.len(), 2);

    for vector in fixture.vectors {
        let (records, canonical_bytes) = compile_manifest(&vector.files)
            .unwrap_or_else(|error| panic!("{}: {error}", vector.id));
        assert_eq!(records, vector.records, "{}: records", vector.id);
        assert_eq!(
            canonical_bytes,
            vector.canonical_json.as_bytes(),
            "{}: exact canonical UTF-8 bytes",
            vector.id
        );
        assert_eq!(
            canonical_bytes.len(),
            vector.canonical_bytes,
            "{}: byte count",
            vector.id
        );
        assert_eq!(
            sha256_hex(&canonical_bytes),
            vector.bundle_sha256,
            "{}: bundle digest",
            vector.id
        );

        let mut reversed = vector.files.clone();
        reversed.reverse();
        let (_, replay_bytes) = compile_manifest(&reversed)
            .unwrap_or_else(|error| panic!("{} reversed replay: {error}", vector.id));
        assert_eq!(
            replay_bytes, canonical_bytes,
            "{}: input enumeration order",
            vector.id
        );
    }
}

#[test]
fn rust_manifest_reference_rejects_binary_nul_and_profile_size_limits() {
    let nul_file = [InputFile {
        path: "bad.txt".to_owned(),
        content_utf8: "a\0b".to_owned(),
    }];
    assert_eq!(
        compile_manifest(&nul_file),
        Err("file_binary_nul".to_owned())
    );

    let oversized_file = [InputFile {
        path: "large.txt".to_owned(),
        content_utf8: "x".repeat(MAX_FILE_BYTES + 1),
    }];
    assert_eq!(
        compile_manifest(&oversized_file),
        Err("file_size_exceeded".to_owned())
    );

    let too_many_files: Vec<_> = (0..=MAX_FILES)
        .map(|index| InputFile {
            path: format!("f{index}.txt"),
            content_utf8: String::new(),
        })
        .collect();
    assert_eq!(
        compile_manifest(&too_many_files),
        Err("file_count_out_of_range".to_owned())
    );

    let too_many_bytes: Vec<_> = (0..6)
        .map(|index| InputFile {
            path: format!("f{index}.txt"),
            content_utf8: "x".repeat(30 * 1024),
        })
        .collect();
    assert_eq!(
        compile_manifest(&too_many_bytes),
        Err("total_size_exceeded".to_owned())
    );
}
