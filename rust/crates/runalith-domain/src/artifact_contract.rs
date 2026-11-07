//! Node-compatible typed workflow artifact content validation.
//!
//! Validation is descriptive only. A valid artifact value is not proof of
//! producer identity, task-attempt lineage, persistence, or workflow success.

use serde_json::Value;

const REVIEW_FIELDS: &[&str] = &[
    "requirementsSatisfied",
    "architectureConformant",
    "securityAccepted",
    "qaAccepted",
    "platformAccepted",
    "documentationAccepted",
    "implementationIssues",
    "evidenceIssues",
    "securityIssues",
    "blockingIssues",
    "decision",
];

/// Required content fields for a known Node workflow artifact type.
#[must_use]
pub fn required_fields(artifact_type: &str) -> Option<&'static [&'static str]> {
    match artifact_type {
        "requirements" => Some(&["scope", "acceptance_criteria", "non_goals"]),
        "research" => Some(&["findings", "sources", "limitations"]),
        "architecture" => Some(&[
            "components",
            "interfaces",
            "failure_modes",
            "implementation_boundary",
        ]),
        "implementation" => Some(&["summary", "files_changed", "verification", "execution"]),
        "security-review" => Some(&["threats", "findings", "decision"]),
        "qa-report" => Some(&["checks", "results", "decision"]),
        "platform-review" => Some(&["runtime", "deployment", "recovery"]),
        "documentation" => Some(&["summary", "user_facing_changes", "verification"]),
        "review" => Some(REVIEW_FIELDS),
        "cto-decision" => Some(&[
            "decision",
            "summary",
            "accepted_requirements",
            "unresolved_risks",
            "follow_up_actions",
            "evidence_refs",
        ]),
        _ => None,
    }
}

/// Return the built-in role's Node-compatible output artifact type.
#[must_use]
pub fn artifact_type_for_role(role: &str) -> Option<String> {
    crate::workflow::builtin_role(&role.to_ascii_lowercase())
        .and_then(|contract| serde_json::to_value(contract.output).ok())
        .and_then(|value| value.as_str().map(str::to_owned))
}

/// Validate content against the pinned Node artifact contract.
///
/// This intentionally validates content only; full artifact-record validation
/// additionally requires immutable identity, evidence, status, hash and lineage.
pub fn validate_content(artifact_type: &str, content: &Value) -> Result<(), String> {
    let fields = required_fields(artifact_type)
        .ok_or_else(|| format!("unknown artifact type: {artifact_type}"))?;

    if artifact_type == "review" {
        let object = content
            .as_object()
            .ok_or_else(|| "review artifact content must be an object".to_owned())?;
        if fields.iter().any(|field| !object.contains_key(*field)) {
            return Err(format!(
                "review artifact content missing {}",
                fields
                    .iter()
                    .find(|field| !object.contains_key(**field))
                    .copied()
                    .unwrap_or("required field")
            ));
        }
        let valid_booleans = [
            "requirementsSatisfied",
            "architectureConformant",
            "securityAccepted",
            "qaAccepted",
            "platformAccepted",
            "documentationAccepted",
        ]
        .iter()
        .all(|field| object.get(*field).is_some_and(Value::is_boolean));
        let valid_decision = string_in(
            object.get("decision"),
            &["accept", "reject", "needs_changes"],
        );
        let valid_lists = [
            "implementationIssues",
            "evidenceIssues",
            "securityIssues",
            "blockingIssues",
        ]
        .iter()
        .all(|field| object.get(*field).is_some_and(string_array));
        if !valid_booleans || !valid_decision || !valid_lists {
            return Err("review artifact content has invalid fields".into());
        }
        return Ok(());
    }

    let object = content
        .as_object()
        .ok_or_else(|| format!("{artifact_type} artifact content must be an object"))?;
    if let Some(field) = fields.iter().find(|field| !object.contains_key(**field)) {
        return Err(format!("{artifact_type} artifact content missing {field}"));
    }

    let valid = match artifact_type {
        "requirements" => {
            object["acceptance_criteria"].is_array() && object["non_goals"].is_array()
        }
        "research" => {
            object["findings"].is_array()
                && object["sources"].is_array()
                && object["limitations"].is_array()
        }
        "architecture" => {
            object["components"].is_array()
                && object["interfaces"].is_array()
                && object["failure_modes"].is_array()
                && non_empty_string(&object["implementation_boundary"])
        }
        "implementation" => {
            let execution = &object["execution"];
            let deterministic = execution["exit_code"].as_f64() == Some(0.0)
                && non_empty_string(&execution["session_id"]);
            let local_tool = execution["mode"].as_str() == Some("chat-on-steroids-local-tools")
                && execution["exit_code"].is_null()
                && execution["session_id"].is_null()
                && non_empty_string_array(&execution["evidence_refs"])
                && non_empty_array(&object["verification"]);
            non_empty_string(&object["summary"])
                && object["files_changed"].is_array()
                && object["verification"].is_array()
                && execution.is_object()
                && (deterministic || local_tool)
        }
        "security-review" => {
            object["threats"].is_array()
                && object["findings"].is_array()
                && string_in(
                    object.get("decision"),
                    &["accept", "reject", "needs_changes"],
                )
        }
        "qa-report" => {
            object["checks"].is_array()
                && object["results"].is_array()
                && string_in(
                    object.get("decision"),
                    &["accept", "reject", "needs_changes"],
                )
        }
        // Node checks `typeof value === 'object'`, which includes arrays.
        "platform-review" => ["runtime", "deployment", "recovery"].iter().all(|field| {
            object
                .get(*field)
                .is_some_and(|value| value.is_object() || value.is_array())
        }),
        "documentation" => {
            non_empty_string(&object["summary"])
                && object["user_facing_changes"].is_array()
                && object["verification"].is_array()
        }
        "cto-decision" => {
            non_empty_string(&object["summary"])
                && string_in(object.get("decision"), &["approve", "reject", "rework"])
                && string_array(&object["accepted_requirements"])
                && string_array(&object["unresolved_risks"])
                && string_array(&object["follow_up_actions"])
                && string_array(&object["evidence_refs"])
        }
        _ => true,
    };

    if valid {
        Ok(())
    } else {
        Err(format!(
            "{artifact_type} artifact content has invalid fields"
        ))
    }
}

fn non_empty_string(value: &Value) -> bool {
    value.as_str().is_some_and(|value| !value.trim().is_empty())
}

fn string_array(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().all(Value::is_string))
}

fn non_empty_string_array(value: &Value) -> bool {
    value.as_array().is_some_and(|items| {
        !items.is_empty()
            && items
                .iter()
                .all(|item| item.as_str().is_some_and(|value| !value.trim().is_empty()))
    })
}

fn non_empty_array(value: &Value) -> bool {
    value.as_array().is_some_and(|items| !items.is_empty())
}

fn string_in(value: Option<&Value>, accepted: &[&str]) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|value| accepted.contains(&value))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn required_fields_and_role_outputs_match_builtin_artifact_contracts() {
        assert_eq!(
            required_fields("requirements").unwrap(),
            ["scope", "acceptance_criteria", "non_goals"]
        );
        assert_eq!(
            artifact_type_for_role("product-owner").as_deref(),
            Some("requirements")
        );
        assert_eq!(
            artifact_type_for_role("productowner").as_deref(),
            Some("requirements")
        );
        assert_eq!(
            artifact_type_for_role("reviewer").as_deref(),
            Some("review")
        );
        assert_eq!(
            artifact_type_for_role("cto").as_deref(),
            Some("cto-decision")
        );
        assert_eq!(artifact_type_for_role("unknown"), None);
    }

    #[test]
    fn validates_node_artifact_shapes_and_rejects_semantic_mutations() {
        let requirements = json!({"scope":"release","acceptance_criteria":[],"non_goals":[]});
        assert!(validate_content("requirements", &requirements).is_ok());
        let mut invalid = requirements.clone();
        invalid["acceptance_criteria"] = json!("not-an-array");
        assert!(validate_content("requirements", &invalid).is_err());

        let review = json!({
            "requirementsSatisfied":true,"architectureConformant":true,"securityAccepted":true,
            "qaAccepted":true,"platformAccepted":true,"documentationAccepted":true,
            "implementationIssues":[],"evidenceIssues":[],"securityIssues":[],"blockingIssues":[],
            "decision":"accept"
        });
        assert!(validate_content("review", &review).is_ok());
        let mut invalid_review = review.clone();
        invalid_review["decision"] = json!("approved");
        assert!(validate_content("review", &invalid_review).is_err());

        let implementation = json!({
            "summary":"done","files_changed":[],"verification":[],
            "execution":{"exit_code":0,"session_id":"session-1"}
        });
        assert!(validate_content("implementation", &implementation).is_ok());
        let mut invalid_execution = implementation;
        invalid_execution["execution"]["exit_code"] = json!(1);
        assert!(validate_content("implementation", &invalid_execution).is_err());
    }

    #[test]
    fn every_node_artifact_family_has_a_valid_content_fixture() {
        let review = json!({
            "requirementsSatisfied":true,"architectureConformant":true,"securityAccepted":true,
            "qaAccepted":true,"platformAccepted":true,"documentationAccepted":true,
            "implementationIssues":[],"evidenceIssues":[],"securityIssues":[],"blockingIssues":[],
            "decision":"accept"
        });
        let fixtures = [
            (
                "requirements",
                json!({"scope":"release","acceptance_criteria":[],"non_goals":[]}),
            ),
            (
                "research",
                json!({"findings":[],"sources":[],"limitations":[]}),
            ),
            (
                "architecture",
                json!({"components":[],"interfaces":[],"failure_modes":[],"implementation_boundary":"bounded"}),
            ),
            (
                "implementation",
                json!({"summary":"done","files_changed":[],"verification":[],"execution":{"exit_code":0.0,"session_id":"session-1"}}),
            ),
            (
                "security-review",
                json!({"threats":[],"findings":[],"decision":"accept"}),
            ),
            (
                "qa-report",
                json!({"checks":[],"results":[],"decision":"accept"}),
            ),
            (
                "platform-review",
                json!({"runtime":{},"deployment":{},"recovery":{}}),
            ),
            (
                "documentation",
                json!({"summary":"updated","user_facing_changes":[],"verification":[]}),
            ),
            ("review", review),
            (
                "cto-decision",
                json!({"decision":"approve","summary":"ready","accepted_requirements":[],"unresolved_risks":[],"follow_up_actions":[],"evidence_refs":[]}),
            ),
        ];
        for (artifact_type, content) in fixtures {
            assert!(
                validate_content(artifact_type, &content).is_ok(),
                "valid Node fixture rejected for {artifact_type}: {content}"
            );
        }
    }

    #[test]
    fn rejects_unknown_types_and_missing_or_non_string_decision_lists() {
        assert!(validate_content("unknown", &json!({})).is_err());
        let cto = json!({
            "decision":"approve","summary":"ready","accepted_requirements":["one"],
            "unresolved_risks":[],"follow_up_actions":[],"evidence_refs":[]
        });
        assert!(validate_content("cto-decision", &cto).is_ok());
        let mut invalid = cto;
        invalid["evidence_refs"] = json!([1]);
        assert!(validate_content("cto-decision", &invalid).is_err());
    }
}
