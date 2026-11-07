//! WS7-confirmed five-field Goal/Idea V2-01 attestation subject profile.
//!
//! This local trust-crate primitive computes the exact restricted-JCS subject
//! digest. It is separate from `EvidenceVerificationSubjectV1` (the existing
//! six-field contract) and does not resolve graph facts, source lineage, trust
//! identity, key lifecycle, nonce persistence, freshness or authorization.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

use runalith_protocol::agg_checkpoint_v2::{AggCheckpointError, canonicalize, parse_json};

/// Exact profile label supplied by WS7's V2-01 golden fixture.
pub const GOAL_EVIDENCE_SUBJECT_PROFILE_V1: &str =
    "restricted-JCS-UTF8-closed-five-field-subject-v1";

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Closed local view of the five-field Goal/Idea V2-01 attestation subject.
///
/// The object hashed by [`GoalEvidenceAttestationSubjectV2::sha256`] contains
/// exactly these five fields; profile/version metadata is kept outside the
/// digest object so it cannot silently alter the WS7-confirmed golden bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GoalEvidenceAttestationSubjectV2 {
    /// Goal identity from the resolved WS7 graph snapshot.
    pub goal_id: String,
    /// Idea identity from the resolved WS7 graph snapshot.
    pub idea_id: String,
    /// Positive, JavaScript-safe current graph revision.
    pub graph_revision: u64,
    /// Lowercase SHA-256 digest of the exact graph snapshot.
    pub graph_snapshot_sha256: String,
    /// Lowercase SHA-256 digest of the exact evidence manifest.
    pub evidence_manifest_sha256: String,
}

/// Strict parsing, closed-shape or canonical subject validation error.
#[derive(Debug, Error)]
pub enum GoalEvidenceSubjectV2Error {
    /// Input violated the strict JSON/JCS profile, including duplicate keys.
    #[error(transparent)]
    JsonProfile(#[from] AggCheckpointError),
    /// The input did not match the exact five-field subject object.
    #[error("Goal/Idea V2-01 subject shape is invalid")]
    Shape,
    /// A named subject field violated its local structural constraint.
    #[error("Goal/Idea V2-01 subject field is invalid: {0}")]
    InvalidField(&'static str),
}

impl GoalEvidenceAttestationSubjectV2 {
    /// Strictly parse the original bytes and validate the closed five-field DTO.
    pub fn parse_json(bytes: &[u8]) -> Result<Self, GoalEvidenceSubjectV2Error> {
        let value = parse_json(bytes)?;
        let subject: Self =
            serde_json::from_value(value).map_err(|_| GoalEvidenceSubjectV2Error::Shape)?;
        subject.validate()?;
        Ok(subject)
    }

    /// Validate field types and bounded identity/digest formats only.
    ///
    /// This is not graph resolution or evidence completeness verification.
    pub fn validate(&self) -> Result<(), GoalEvidenceSubjectV2Error> {
        for (value, field) in [
            (self.goal_id.as_str(), "goal_id"),
            (self.idea_id.as_str(), "idea_id"),
        ] {
            if value.is_empty() || value != value.trim() || value.chars().any(char::is_control) {
                return Err(GoalEvidenceSubjectV2Error::InvalidField(field));
            }
        }
        if self.graph_revision == 0 || self.graph_revision > MAX_SAFE_INTEGER {
            return Err(GoalEvidenceSubjectV2Error::InvalidField("graph_revision"));
        }
        for (value, field) in [
            (self.graph_snapshot_sha256.as_str(), "graph_snapshot_sha256"),
            (
                self.evidence_manifest_sha256.as_str(),
                "evidence_manifest_sha256",
            ),
        ] {
            if value.len() != 64
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(GoalEvidenceSubjectV2Error::InvalidField(field));
            }
        }
        Ok(())
    }

    /// Convert the exact five fields to a JSON object for canonicalization.
    pub fn to_value(&self) -> Result<Value, GoalEvidenceSubjectV2Error> {
        self.validate()?;
        serde_json::to_value(self).map_err(|_| GoalEvidenceSubjectV2Error::Shape)
    }

    /// Return RFC 8785 canonical UTF-8 JSON for the exact five-field object.
    pub fn canonical_utf8(&self) -> Result<String, GoalEvidenceSubjectV2Error> {
        Ok(canonicalize(&self.to_value()?)?)
    }

    /// SHA-256 of UTF-8 restricted-JCS bytes for the closed five-field object.
    pub fn sha256(&self) -> Result<String, GoalEvidenceSubjectV2Error> {
        let canonical = self.canonical_utf8()?;
        Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const WS7_GOLDEN: &str =
        include_str!("../tests/fixtures/goal-evidence-v2-01-subject-ws7-golden.json");

    #[test]
    fn matches_ws7_five_field_subject_canonical_bytes_and_sha256() {
        let fixture: Value = serde_json::from_str(WS7_GOLDEN).unwrap();
        assert_eq!(
            fixture["profile"].as_str(),
            Some(GOAL_EVIDENCE_SUBJECT_PROFILE_V1)
        );
        assert_eq!(
            fixture["source_fixture_sha256"].as_str(),
            Some("cfa3d3fa502e2b0af745e08837e8b461fbb3be44986265fe03e529760529186e")
        );
        let subject_bytes = serde_json::to_vec(&fixture["subject"]).unwrap();
        let subject = GoalEvidenceAttestationSubjectV2::parse_json(&subject_bytes).unwrap();
        assert_eq!(
            subject.canonical_utf8().unwrap(),
            fixture["canonical_utf8"].as_str().unwrap()
        );
        assert_eq!(
            subject.sha256().unwrap(),
            "81ef500643ded8865c2a6ba1d20b0a2d58dcedb15daead85f6b6ec554b6dd5b4"
        );
        assert_eq!(
            subject.sha256().unwrap(),
            fixture["subject_sha256"].as_str().unwrap()
        );
        assert_eq!(subject.to_value().unwrap().as_object().unwrap().len(), 5);
    }

    #[test]
    fn rejects_unknown_or_duplicate_keys_and_unsafe_revision_tokens() {
        let mut unknown: Value = serde_json::from_str(WS7_GOLDEN).unwrap();
        unknown["subject"]["node_ids"] = json!(["not-part-of-five-field-subject"]);
        let bytes = serde_json::to_vec(&unknown["subject"]).unwrap();
        assert!(matches!(
            GoalEvidenceAttestationSubjectV2::parse_json(&bytes),
            Err(GoalEvidenceSubjectV2Error::Shape)
        ));
        assert!(matches!(
            GoalEvidenceAttestationSubjectV2::parse_json(
                br#"{"goal_id":"g","goal_id":"g","idea_id":"i","graph_revision":1,"graph_snapshot_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","evidence_manifest_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}"#
            ),
            Err(GoalEvidenceSubjectV2Error::JsonProfile(_))
        ));
        assert!(matches!(
            GoalEvidenceAttestationSubjectV2::parse_json(
                br#"{"goal_id":"g","idea_id":"i","graph_revision":9007199254740992,"graph_snapshot_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","evidence_manifest_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}"#
            ),
            Err(GoalEvidenceSubjectV2Error::JsonProfile(_))
        ));
    }

    #[test]
    fn rejects_invalid_identity_revision_and_digest_fields() {
        let valid = GoalEvidenceAttestationSubjectV2 {
            goal_id: "goal".into(),
            idea_id: "idea".into(),
            graph_revision: 1,
            graph_snapshot_sha256: "a".repeat(64),
            evidence_manifest_sha256: "b".repeat(64),
        };
        let mut invalid = valid.clone();
        invalid.goal_id = " goal".into();
        assert!(matches!(
            invalid.validate(),
            Err(GoalEvidenceSubjectV2Error::InvalidField("goal_id"))
        ));
        let mut invalid = valid.clone();
        invalid.graph_revision = 0;
        assert!(matches!(
            invalid.validate(),
            Err(GoalEvidenceSubjectV2Error::InvalidField("graph_revision"))
        ));
        let mut invalid = valid.clone();
        invalid.graph_revision = MAX_SAFE_INTEGER + 1;
        assert!(matches!(
            invalid.validate(),
            Err(GoalEvidenceSubjectV2Error::InvalidField("graph_revision"))
        ));
        let mut invalid = valid;
        invalid.evidence_manifest_sha256 = "B".repeat(64);
        assert!(matches!(
            invalid.validate(),
            Err(GoalEvidenceSubjectV2Error::InvalidField(
                "evidence_manifest_sha256"
            ))
        ));
    }
}
