//! Read-only adapter for Node's legacy deterministic task plan metadata.
//!
//! This mirrors the deterministic-task gate in
//! `src/runtime/workflow/plan.js::validateExecutionPlan`. It does not execute
//! a command, authorize a worker, grant filesystem access, or replace the
//! Execution Manager's stricter process/argv/workspace/lease checks.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use thiserror::Error;

/// Immutable Node deterministic execution metadata as found in a compiled
/// plan. Arbitrary JSON values are preserved where Node's plan validator only
/// checks truthiness or array shape; a later Execution Manager boundary must
/// perform concrete OS argument and workspace validation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeDeterministicExecutionSpec {
    /// Plan task identity to which the metadata belongs.
    pub task_id: String,
    /// Exact Node `execution.executable` value.
    pub executable: Value,
    /// Exact Node `execution.args` array; elements are not string-coerced.
    pub args: Vec<Value>,
    /// Exact Node `execution.cwd` value.
    pub cwd: Value,
    /// Positive integer timeout accepted by Node's plan validator.
    pub timeout_ms: Number,
    /// Whether source marker is exactly boolean true. Node's first plan gate
    /// uses JavaScript truthiness, while later scheduling gates use `=== true`.
    pub strict_deterministic: bool,
    /// Exact original execution object, retaining optional batch/output/QA pins.
    pub raw_execution: Map<String, Value>,
}

impl NodeDeterministicExecutionSpec {
    /// Optional output artifact type, preserved without inventing a default.
    #[must_use]
    pub fn output_artifact_type(&self) -> Option<&str> {
        self.raw_execution
            .get("output_artifact_type")
            .and_then(Value::as_str)
    }

    /// Whether this task is marked as one of Node's batch-validation tasks.
    #[must_use]
    pub fn is_batch_validation_task(&self) -> bool {
        self.raw_execution
            .get("batch_validation_task")
            .and_then(Value::as_bool)
            == Some(true)
    }
}

/// Failure categories and task-bound messages from Node's deterministic plan gate.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum NodeDeterministicExecutionError {
    /// Node requires deterministic tasks to use `ExecutionManager`.
    #[error("deterministic task must use ExecutionManager: {task_id}")]
    WrongExecutor {
        /// Task whose execution metadata was rejected.
        task_id: String,
    },
    /// Node requires a truthy executable and an argument array.
    #[error("structured execution contract required: {task_id}")]
    StructuredContractRequired {
        /// Task whose execution metadata was rejected.
        task_id: String,
    },
    /// Node requires truthy `cwd` and a positive integer `timeout_ms`.
    #[error("invalid deterministic execution metadata: {task_id}")]
    InvalidMetadata {
        /// Task whose execution metadata was rejected.
        task_id: String,
    },
}

fn node_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn node_positive_integer(value: &Value) -> Option<Number> {
    let number = value.as_number()?;
    let numeric = number.as_f64()?;
    if numeric.is_finite() && numeric > 0.0 && numeric.fract() == 0.0 {
        Some(number.clone())
    } else {
        None
    }
}

/// Apply Node's `validateExecutionPlan` deterministic metadata checks.
///
/// Returns `Ok(None)` for metadata whose `deterministic` member is JavaScript-
/// falsy (including a missing marker). A truthy marker activates Node's
/// ExecutionManager/executable/argv/cwd/timeout validation. The distinction
/// between truthy and strict boolean markers is retained for differential use.
pub fn parse_node_deterministic_execution(
    task_id: &str,
    execution: &Value,
) -> Result<Option<NodeDeterministicExecutionSpec>, NodeDeterministicExecutionError> {
    let Some(object) = execution.as_object() else {
        return Ok(None);
    };
    let Some(marker) = object.get("deterministic") else {
        return Ok(None);
    };
    if !node_truthy(marker) {
        return Ok(None);
    }
    if object.get("executor").and_then(Value::as_str) != Some("ExecutionManager") {
        return Err(NodeDeterministicExecutionError::WrongExecutor {
            task_id: task_id.to_owned(),
        });
    }
    let Some(executable) = object.get("executable").filter(|value| node_truthy(value)) else {
        return Err(
            NodeDeterministicExecutionError::StructuredContractRequired {
                task_id: task_id.to_owned(),
            },
        );
    };
    let Some(args) = object.get("args").and_then(Value::as_array) else {
        return Err(
            NodeDeterministicExecutionError::StructuredContractRequired {
                task_id: task_id.to_owned(),
            },
        );
    };
    let Some(cwd) = object.get("cwd").filter(|value| node_truthy(value)) else {
        return Err(NodeDeterministicExecutionError::InvalidMetadata {
            task_id: task_id.to_owned(),
        });
    };
    let Some(timeout_ms) = object.get("timeout_ms").and_then(node_positive_integer) else {
        return Err(NodeDeterministicExecutionError::InvalidMetadata {
            task_id: task_id.to_owned(),
        });
    };

    Ok(Some(NodeDeterministicExecutionSpec {
        task_id: task_id.to_owned(),
        executable: executable.clone(),
        args: args.clone(),
        cwd: cwd.clone(),
        timeout_ms,
        strict_deterministic: marker.as_bool() == Some(true),
        raw_execution: object.clone(),
    }))
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::json;

    use super::*;

    #[derive(Debug, Deserialize)]
    struct NodeExecutionOracle {
        schema_version: u32,
        generated_by_node: bool,
        source: String,
        valid_tasks: Vec<ValidTask>,
        validation_cases: Vec<ValidationCase>,
    }

    #[derive(Debug, Deserialize)]
    struct ValidTask {
        catalog: String,
        task_id: String,
        execution: Value,
        outcome: String,
        error: Option<String>,
    }

    #[derive(Debug, Deserialize)]
    struct ValidationCase {
        name: String,
        execution: Value,
        strict_deterministic: bool,
        outcome: String,
        error: Option<String>,
    }

    fn oracle() -> NodeExecutionOracle {
        serde_json::from_str(include_str!(
            "../tests/fixtures/node-deterministic-execution-v1.json"
        ))
        .expect("Node-generated deterministic execution oracle must parse")
    }

    fn classify(
        result: Result<Option<NodeDeterministicExecutionSpec>, NodeDeterministicExecutionError>,
    ) -> (String, Option<String>) {
        match result {
            Ok(Some(_)) => ("ACCEPTED".into(), None),
            Ok(None) => ("NOT_DETERMINISTIC".into(), None),
            Err(error) => ("REJECTED".into(), Some(error.to_string())),
        }
    }

    #[test]
    fn node_catalog_deterministic_task_specs_are_preserved_without_loss() {
        let fixture = oracle();
        assert_eq!(fixture.schema_version, 1);
        assert!(fixture.generated_by_node);
        assert!(fixture.source.contains("validateExecutionPlan"));
        assert!(fixture.valid_tasks.len() >= 14);

        for task in fixture.valid_tasks {
            let parsed = parse_node_deterministic_execution(&task.task_id, &task.execution)
                .expect("Node catalog fixture should pass its plan contract");
            if task.outcome == "ACCEPTED" {
                let spec = parsed.expect("deterministic task must be represented");
                assert_eq!(
                    spec.task_id, task.task_id,
                    "{} / {}",
                    task.catalog, task.task_id
                );
                assert_eq!(
                    Value::Object(spec.raw_execution),
                    task.execution,
                    "{} / {}",
                    task.catalog,
                    task.task_id
                );
                assert!(
                    spec.strict_deterministic,
                    "{} / {}",
                    task.catalog, task.task_id
                );
                assert_eq!(spec.executable, task.execution["executable"]);
                assert_eq!(
                    spec.args,
                    task.execution["args"].as_array().unwrap().clone()
                );
                assert_eq!(spec.cwd, task.execution["cwd"]);
                assert!(spec.timeout_ms.as_f64().unwrap() > 0.0);
                assert_eq!(task.error, None);
            } else {
                assert_eq!(parsed, None);
            }
        }
    }

    #[test]
    fn node_plan_validator_error_categories_match_node_generated_cases() {
        let fixture = oracle();
        for case in fixture.validation_cases {
            let parsed = parse_node_deterministic_execution(&case.name, &case.execution);
            let actual = classify(parsed.clone());
            assert_eq!(actual.0, case.outcome, "{}", case.name);
            assert_eq!(actual.1, case.error, "{}", case.name);
            if let Ok(Some(spec)) = parsed {
                assert_eq!(
                    spec.strict_deterministic, case.strict_deterministic,
                    "{}",
                    case.name
                );
            }
        }
    }

    #[test]
    fn node_truthiness_and_strict_execution_routing_are_not_collapsed() {
        let truthy_string = json!({
            "executor":"ExecutionManager","deterministic":"enabled",
            "executable":"node","args":[],"cwd":"/workspace","timeout_ms":1
        });
        let parsed = parse_node_deterministic_execution("truthy-string", &truthy_string)
            .unwrap()
            .unwrap();
        assert!(!parsed.strict_deterministic);

        let non_deterministic_host = json!({
            "executor":"ChatOnSteroidsHost","deterministic":false,
            "execution_mode":"host-conversation"
        });
        assert_eq!(
            parse_node_deterministic_execution("host", &non_deterministic_host).unwrap(),
            None
        );
    }
}
