//! Pure, versioned workflow-local policy and success-contract composition.
//!
//! This module ports the Node `policy-contract.js` definition/snapshot and
//! composition boundary. It does not persist policy versions, attach policies
//! to live workflow instances, or evaluate runtime evidence; those concerns
//! remain outside the domain compiler.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::node_plan_canonical_json::{NodePlanCanonicalJsonError, canonicalize_node_plan_json};
use crate::workflow::CompiledWorkflowPlan;

const POLICY_ID_MAX: usize = 38;
const POLICY_RULE_ID_MAX: usize = 39;
const MAX_POLICY_RULES: usize = 32;
const MAX_POLICY_PACKS: usize = 32;

/// Version-1 policy pack definition. Rule payloads retain the exact Node JSON
/// vocabulary so adding a rule does not silently change the Rust enum ABI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowPolicyDefinitionV1 {
    /// Policy schema version (must be 1).
    pub schema_version: u32,
    /// Stable lowercase policy slug.
    pub policy_id: String,
    /// Human-readable policy name.
    pub name: String,
    /// Optional description, normalized to an empty string when absent.
    #[serde(default)]
    pub description: String,
    /// Plan/lifecycle constraints.
    #[serde(default)]
    pub constraints: Vec<Value>,
    /// Success predicates evaluated against durable workflow evidence.
    #[serde(default)]
    pub success_criteria: Vec<Value>,
}

/// Immutable Node-compatible policy snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowPolicySnapshotV1 {
    /// Snapshot schema version (1).
    pub schema_version: u32,
    /// Stable policy slug.
    pub policy_id: String,
    /// Exact immutable version.
    pub version: u32,
    /// Human-readable name.
    pub name: String,
    /// Normalized description.
    pub description: String,
    /// Normalized constraints.
    pub constraints: Vec<Value>,
    /// Normalized success criteria.
    pub success_criteria: Vec<Value>,
    /// Node-compatible content hash over `{policy_id, version, definition}`.
    pub content_hash: String,
}

/// Normalized version-1 success contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowSuccessContractV1 {
    /// Success-contract schema version (1).
    pub schema_version: u32,
    /// Human-readable goal.
    pub goal: String,
    /// Contract constraints.
    pub constraints: Vec<Value>,
    /// Contract success criteria.
    pub success_criteria: Vec<Value>,
}

/// Exact policy version/content identity included in a compiled plan.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowPolicyPinV1 {
    /// Stable policy ID.
    pub policy_id: String,
    /// Exact immutable policy version.
    pub version: u32,
    /// Exact Node-compatible policy snapshot content hash.
    pub content_sha256: String,
}

/// Composed base + policy contract carried by an immutable compiled plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowPolicyCompositionV1 {
    /// Normalized user/workflow contract before policy composition.
    pub base_success_contract: WorkflowSuccessContractV1,
    /// Deterministically composed contract after policy namespacing.
    pub success_contract: WorkflowSuccessContractV1,
    /// Exact policy snapshots, sorted by policy ID.
    pub policy_packs: Vec<WorkflowPolicySnapshotV1>,
    /// Exact compact policy pins, sorted by policy ID.
    pub policy_pins: Vec<WorkflowPolicyPinV1>,
}

/// Task projection needed to validate policy references against a plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyTaskContextV1 {
    /// Stable task ID.
    pub task_id: String,
    /// Exact role ID.
    pub role_id: String,
    /// Whether task has a deterministic local execution contract.
    pub deterministic: bool,
    /// Exact executor identity, when separately established by the caller.
    pub executor: Option<String>,
}

/// Workflow identity and immutable task projection used for policy compatibility.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyPlanContextV1 {
    /// Exact workflow ID against which `workflow_id_equals` is evaluated.
    pub workflow_id: String,
    /// Immutable task identity/role/execution projection.
    pub tasks: Vec<PolicyTaskContextV1>,
}

impl From<&CompiledWorkflowPlan> for PolicyPlanContextV1 {
    fn from(plan: &CompiledWorkflowPlan) -> Self {
        Self {
            workflow_id: plan.workflow_id().to_owned(),
            tasks: plan
                .tasks()
                .iter()
                .map(|task| PolicyTaskContextV1 {
                    task_id: task.task_id.clone(),
                    role_id: task.role_id.clone(),
                    deterministic: task.deterministic,
                    // `CompiledWorkflowTask` does not attest an executor identity.
                    // Never infer ExecutionManager from deterministic=true alone.
                    executor: None,
                })
                .collect(),
        }
    }
}

/// Validate and normalize a policy definition, preserving Node policy semantics.
pub fn normalize_workflow_policy_definition_v1(
    input: &WorkflowPolicyDefinitionV1,
) -> Result<WorkflowPolicyDefinitionV1, WorkflowPolicyV1Error> {
    if input.schema_version != 1 {
        return invalid("policy schema_version must be 1");
    }
    let policy_id = required_text(&input.policy_id, "policy_id", POLICY_ID_MAX)?;
    validate_slug(&policy_id, "policy_id", POLICY_ID_MAX)?;
    let name = required_text(&input.name, "name", 120)?;
    let description = input.description.trim().to_owned();
    if description.len() > 2000 {
        return invalid("policy description is invalid");
    }
    let constraints = normalize_rule_list(&input.constraints, "constraints", POLICY_RULE_ID_MAX)?;
    let success_criteria = normalize_rule_list(
        &input.success_criteria,
        "success_criteria",
        POLICY_RULE_ID_MAX,
    )?;
    let total = constraints.len() + success_criteria.len();
    if total == 0 || total > MAX_POLICY_RULES {
        return invalid("policy must declare 1 to 32 enforceable rules");
    }
    let mut ids = BTreeSet::new();
    for rule in constraints.iter().chain(success_criteria.iter()) {
        let id = rule["id"].as_str().unwrap_or_default();
        if !ids.insert(id.to_owned()) {
            return invalid(format!(
                "policy contains duplicate id across constraints and success_criteria: {id}"
            ));
        }
    }
    validate_semantic_conflicts(constraints.iter().chain(success_criteria.iter()))?;
    Ok(WorkflowPolicyDefinitionV1 {
        schema_version: 1,
        policy_id,
        name,
        description,
        constraints,
        success_criteria,
    })
}

/// Create an immutable versioned Node-compatible policy snapshot.
pub fn create_workflow_policy_snapshot_v1(
    definition: &WorkflowPolicyDefinitionV1,
    version: u32,
) -> Result<WorkflowPolicySnapshotV1, WorkflowPolicyV1Error> {
    if version == 0 {
        return invalid("policy version must be a positive integer");
    }
    let definition = normalize_workflow_policy_definition_v1(definition)?;
    let mut snapshot = WorkflowPolicySnapshotV1 {
        schema_version: 1,
        policy_id: definition.policy_id.clone(),
        version,
        name: definition.name.clone(),
        description: definition.description.clone(),
        constraints: definition.constraints.clone(),
        success_criteria: definition.success_criteria.clone(),
        content_hash: String::new(),
    };
    snapshot.content_hash = policy_snapshot_digest(&snapshot)?;
    Ok(snapshot)
}

/// Verify exact snapshot normalization and Node-compatible content digest.
pub fn validate_workflow_policy_snapshot_v1(
    snapshot: &WorkflowPolicySnapshotV1,
) -> Result<(), WorkflowPolicyV1Error> {
    let definition = WorkflowPolicyDefinitionV1 {
        schema_version: snapshot.schema_version,
        policy_id: snapshot.policy_id.clone(),
        name: snapshot.name.clone(),
        description: snapshot.description.clone(),
        constraints: snapshot.constraints.clone(),
        success_criteria: snapshot.success_criteria.clone(),
    };
    let expected = create_workflow_policy_snapshot_v1(&definition, snapshot.version)?;
    if &expected != snapshot {
        return invalid(format!(
            "workflow policy snapshot integrity failure: {}@{}",
            snapshot.policy_id, snapshot.version
        ));
    }
    Ok(())
}

/// Normalize a success contract using Node's public success-contract rules.
pub fn normalize_workflow_success_contract_v1(
    input: Option<&Value>,
    fallback_goal: &str,
) -> Result<WorkflowSuccessContractV1, WorkflowPolicyV1Error> {
    let empty = Value::Object(Map::new());
    let value = input.unwrap_or(&empty);
    let object = value.as_object().ok_or_else(|| {
        WorkflowPolicyV1Error::Invalid("success contract must be an object".into())
    })?;
    if object.keys().any(|key| {
        ![
            "schema_version",
            "goal",
            "constraints",
            "success_criteria",
            "criteria",
        ]
        .contains(&key.as_str())
    }) {
        return invalid("success contract contains unsupported fields");
    }
    if object
        .get("schema_version")
        .is_some_and(|schema| schema.as_u64() != Some(1))
    {
        return invalid("success_contract schema_version must be 1");
    }
    let goal = object
        .get("goal")
        .and_then(Value::as_str)
        .unwrap_or(fallback_goal);
    let goal = required_text(goal, "goal", 4000)?;
    let constraints = normalize_rule_list_from_value(object.get("constraints"), "constraints", 80)?;
    let criteria_value = object
        .get("success_criteria")
        .filter(|value| !value.is_null())
        .or_else(|| object.get("criteria"));
    let success_criteria = normalize_rule_list_from_value(criteria_value, "success_criteria", 80)?;
    let mut ids = BTreeSet::new();
    for rule in constraints.iter().chain(success_criteria.iter()) {
        let id = rule["id"].as_str().unwrap_or_default();
        if !ids.insert(id.to_owned()) {
            return invalid(format!("duplicate success contract rule id: {id}"));
        }
    }
    Ok(WorkflowSuccessContractV1 {
        schema_version: 1,
        goal,
        constraints,
        success_criteria,
    })
}

/// Compose immutable policy snapshots into a normalized success contract.
///
/// Policy snapshots are validated, sorted, duplicate-checked, checked against
/// the exact workflow/task context, and namespaced as `p-{policy_id}-{rule_id}`.
pub fn compose_workflow_policy_v1(
    base_contract: Option<&Value>,
    policy_snapshots: &[WorkflowPolicySnapshotV1],
    context: &PolicyPlanContextV1,
) -> Result<WorkflowPolicyCompositionV1, WorkflowPolicyV1Error> {
    if policy_snapshots.len() > MAX_POLICY_PACKS {
        return invalid("a workflow may attach at most 32 policy packs");
    }
    let base =
        normalize_workflow_success_contract_v1(base_contract, "Fulfill the workflow request")?;
    let mut snapshots = policy_snapshots.to_vec();
    for snapshot in &snapshots {
        validate_workflow_policy_snapshot_v1(snapshot)?;
    }
    snapshots.sort_by(|left, right| left.policy_id.cmp(&right.policy_id));
    let mut seen_policy_ids = BTreeSet::new();
    for snapshot in &snapshots {
        if !seen_policy_ids.insert(snapshot.policy_id.clone()) {
            return invalid(format!(
                "duplicate policy attachment: {}",
                snapshot.policy_id
            ));
        }
    }

    let policy_rules = snapshots.iter().flat_map(|snapshot| {
        snapshot
            .constraints
            .iter()
            .chain(snapshot.success_criteria.iter())
    });
    validate_semantic_conflicts(policy_rules)?;
    for snapshot in &snapshots {
        for rule in snapshot
            .constraints
            .iter()
            .chain(snapshot.success_criteria.iter())
        {
            validate_predicate_compatible(rule, context)?;
        }
    }

    let mut constraints = base.constraints.clone();
    let mut success_criteria = base.success_criteria.clone();
    let mut ids = constraints
        .iter()
        .chain(success_criteria.iter())
        .filter_map(|rule| rule.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect::<BTreeSet<_>>();
    for snapshot in &snapshots {
        for (source, target) in [
            (&snapshot.constraints, &mut constraints),
            (&snapshot.success_criteria, &mut success_criteria),
        ] {
            for rule in source {
                let rule_id = rule.get("id").and_then(Value::as_str).ok_or_else(|| {
                    WorkflowPolicyV1Error::Invalid("policy rule id missing".into())
                })?;
                let namespaced_id = format!("p-{}-{rule_id}", snapshot.policy_id);
                if namespaced_id.len() > 80 || !ids.insert(namespaced_id.clone()) {
                    return invalid(format!("policy predicate ID collision: {namespaced_id}"));
                }
                let mut namespaced = rule.clone();
                namespaced
                    .as_object_mut()
                    .ok_or_else(|| {
                        WorkflowPolicyV1Error::Invalid("policy predicate is not an object".into())
                    })?
                    .insert("id".into(), Value::String(namespaced_id));
                target.push(namespaced);
            }
        }
    }
    let merged_value = json!({
        "schema_version": 1,
        "goal": base.goal,
        "constraints": constraints,
        "success_criteria": success_criteria,
    });
    let success_contract = normalize_workflow_success_contract_v1(
        Some(&merged_value),
        "Fulfill the workflow request",
    )?;
    validate_semantic_conflicts(
        success_contract
            .constraints
            .iter()
            .chain(success_contract.success_criteria.iter()),
    )?;

    let policy_pins = snapshots
        .iter()
        .map(|snapshot| WorkflowPolicyPinV1 {
            policy_id: snapshot.policy_id.clone(),
            version: snapshot.version,
            content_sha256: snapshot.content_hash.clone(),
        })
        .collect();
    Ok(WorkflowPolicyCompositionV1 {
        base_success_contract: base,
        success_contract,
        policy_packs: snapshots,
        policy_pins,
    })
}

impl WorkflowPolicyCompositionV1 {
    /// Recompose and compare policy pins, normalized contract and exact snapshots.
    pub fn verify_for_plan(
        &self,
        plan: &CompiledWorkflowPlan,
    ) -> Result<(), WorkflowPolicyV1Error> {
        let base = serde_json::to_value(&self.base_success_contract)
            .map_err(|error| WorkflowPolicyV1Error::CanonicalSerialization(error.to_string()))?;
        let expected = compose_workflow_policy_v1(
            Some(&base),
            &self.policy_packs,
            &PolicyPlanContextV1::from(plan),
        )?;
        if &expected != self {
            return invalid("workflow policy composition does not match its exact pins/context");
        }
        Ok(())
    }
}

fn normalize_rule_list(
    values: &[Value],
    field: &str,
    max_id: usize,
) -> Result<Vec<Value>, WorkflowPolicyV1Error> {
    if values.len() > MAX_POLICY_RULES {
        return invalid(format!("{field} must contain at most 32 entries"));
    }
    let mut ids = BTreeSet::new();
    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let normalized = normalize_predicate(value, &format!("{field}[{index}]"), max_id)?;
            let id = normalized["id"].as_str().unwrap_or_default();
            if !ids.insert(id.to_owned()) {
                return invalid(format!("{field} contains duplicate id: {id}"));
            }
            Ok(normalized)
        })
        .collect()
}

fn normalize_rule_list_from_value(
    value: Option<&Value>,
    field: &str,
    max_id: usize,
) -> Result<Vec<Value>, WorkflowPolicyV1Error> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(Vec::new());
    };
    let values = value
        .as_array()
        .ok_or_else(|| WorkflowPolicyV1Error::Invalid(format!("{field} must be an array")))?;
    normalize_rule_list(values, field, max_id)
}

fn normalize_predicate(
    input: &Value,
    field: &str,
    max_id: usize,
) -> Result<Value, WorkflowPolicyV1Error> {
    let object = input
        .as_object()
        .ok_or_else(|| WorkflowPolicyV1Error::Invalid(format!("{field} must be an object")))?;
    let id = required_text(
        object.get("id").and_then(Value::as_str).unwrap_or_default(),
        &format!("{field}.id"),
        max_id,
    )?;
    validate_slug(&id, &format!("{field}.id"), max_id)?;
    let kind = required_text(
        object
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        &format!("{field}.type"),
        80,
    )?;
    let allowed_types = [
        "all_tasks_completed",
        "local_execution_only",
        "workflow_id_equals",
        "task_status_equals",
        "execution_exit_code_equals",
        "task_role_present",
        "task_role_absent",
        "artifact_exists",
        "artifact_field_equals",
        "artifact_field_includes",
        "artifact_field_non_empty",
    ];
    if !allowed_types.contains(&kind.as_str()) {
        return invalid(format!("{field}.type is unsupported: {kind}"));
    }

    let mut normalized = Map::new();
    normalized.insert("id".into(), Value::String(id));
    normalized.insert("type".into(), Value::String(kind.clone()));
    let mut permitted = BTreeSet::from(["id", "type", "description"]);
    if let Some(description) = object.get("description").filter(|value| !value.is_null()) {
        let description = required_text(
            description.as_str().unwrap_or_default(),
            &format!("{field}.description"),
            2000,
        )?;
        normalized.insert("description".into(), Value::String(description));
    }
    let take_text = |key: &str,
                     max: usize,
                     permitted: &mut BTreeSet<&'static str>,
                     normalized: &mut Map<String, Value>|
     -> Result<String, WorkflowPolicyV1Error> {
        let static_key: &'static str = match key {
            "task_id" => "task_id",
            "role" => "role",
            "producer_role" => "producer_role",
            "artifact_type" => "artifact_type",
            "field" => "field",
            "expected" => "expected",
            _ => return invalid("unsupported internal policy field"),
        };
        permitted.insert(static_key);
        let value = required_text(
            object.get(key).and_then(Value::as_str).unwrap_or_default(),
            &format!("{field}.{key}"),
            max,
        )?;
        normalized.insert(key.into(), Value::String(value.clone()));
        Ok(value)
    };
    let take_scalar = |permitted: &mut BTreeSet<&'static str>,
                       normalized: &mut Map<String, Value>|
     -> Result<Value, WorkflowPolicyV1Error> {
        permitted.insert("expected");
        let value = object
            .get("expected")
            .filter(|value| !value.is_null())
            .ok_or_else(|| {
                WorkflowPolicyV1Error::Invalid(format!("{field}.expected is required"))
            })?;
        let normalized_value = match value {
            Value::String(text) => {
                let text = required_text(text, &format!("{field}.expected"), 2000)?;
                Value::String(text)
            }
            Value::Number(number) if number.as_f64().is_some_and(f64::is_finite) => value.clone(),
            Value::Bool(_) => value.clone(),
            _ => {
                return invalid(format!(
                    "{field}.expected must be a string, finite number, or boolean"
                ));
            }
        };
        normalized.insert("expected".into(), normalized_value.clone());
        Ok(normalized_value)
    };
    match kind.as_str() {
        "all_tasks_completed" | "local_execution_only" => {}
        "workflow_id_equals" => {
            let expected = take_scalar(&mut permitted, &mut normalized)?;
            let expected = expected.as_str().ok_or_else(|| {
                WorkflowPolicyV1Error::Invalid(format!("{field}.expected must be a workflow slug"))
            })?;
            validate_slug(expected, &format!("{field}.expected"), 80)?;
        }
        "task_status_equals" => {
            let task_id = take_text("task_id", 80, &mut permitted, &mut normalized)?;
            validate_slug(&task_id, &format!("{field}.task_id"), 80)?;
            if take_scalar(&mut permitted, &mut normalized)?.as_str() != Some("completed") {
                return invalid(format!(
                    "{field}.expected must be completed; non-success task states cannot satisfy a success contract"
                ));
            }
        }
        "execution_exit_code_equals" => {
            let task_id = take_text("task_id", 80, &mut permitted, &mut normalized)?;
            validate_slug(&task_id, &format!("{field}.task_id"), 80)?;
            if take_scalar(&mut permitted, &mut normalized)?.as_i64() != Some(0) {
                return invalid(format!(
                    "{field}.expected must be numeric 0 for successful local execution"
                ));
            }
        }
        "task_role_present" | "task_role_absent" => {
            let role = take_text("role", 80, &mut permitted, &mut normalized)?;
            validate_slug(&role, &format!("{field}.role"), 80)?;
        }
        "artifact_exists"
        | "artifact_field_equals"
        | "artifact_field_includes"
        | "artifact_field_non_empty" => {
            let artifact_type = take_text("artifact_type", 80, &mut permitted, &mut normalized)?;
            if ![
                "requirements",
                "research",
                "architecture",
                "implementation",
                "security-review",
                "qa-report",
                "platform-review",
                "documentation",
                "review",
                "cto-decision",
            ]
            .contains(&artifact_type.as_str())
            {
                return invalid(format!("{field}.artifact_type is unsupported"));
            }
            if object
                .get("producer_role")
                .is_some_and(|value| !value.is_null())
            {
                let role = take_text("producer_role", 80, &mut permitted, &mut normalized)?;
                validate_slug(&role, &format!("{field}.producer_role"), 80)?;
            }
            if kind != "artifact_exists" {
                let field_name = take_text("field", 80, &mut permitted, &mut normalized)?;
                let mut chars = field_name.chars();
                if !chars
                    .next()
                    .is_some_and(|character| character.is_ascii_alphabetic())
                    || !chars.all(|character| character.is_ascii_alphanumeric() || character == '_')
                {
                    return invalid(format!("{field}.field must be a top-level JSON field name"));
                }
                if kind != "artifact_field_non_empty" {
                    take_scalar(&mut permitted, &mut normalized)?;
                }
            }
        }
        _ => unreachable!("predicate type was checked above"),
    }
    if let Some(unknown) = object.keys().find(|key| !permitted.contains(key.as_str())) {
        return invalid(format!("{field} contains unsupported fields: {unknown}"));
    }
    Ok(Value::Object(normalized))
}

fn validate_semantic_conflicts<'a>(
    rules: impl Iterator<Item = &'a Value>,
) -> Result<(), WorkflowPolicyV1Error> {
    let rules = rules.collect::<Vec<_>>();
    let mut role_presence = BTreeMap::<String, bool>::new();
    let mut workflow_ids = BTreeSet::<String>::new();
    let mut artifact_fields = Vec::new();
    for rule in &rules {
        let kind = rule.get("type").and_then(Value::as_str).unwrap_or_default();
        if matches!(kind, "task_role_present" | "task_role_absent") {
            if let Some(role) = rule.get("role").and_then(Value::as_str) {
                let desired = kind == "task_role_present";
                if role_presence
                    .insert(role.into(), desired)
                    .is_some_and(|old| old != desired)
                {
                    return invalid(format!("conflicting policy predicates for role {role}"));
                }
            }
        }
        if kind == "workflow_id_equals" {
            if let Some(expected) = rule.get("expected").and_then(Value::as_str) {
                workflow_ids.insert(expected.into());
            }
        }
        if kind.starts_with("artifact_field_") {
            artifact_fields.push(*rule);
        }
    }
    if workflow_ids.len() > 1 {
        return invalid("conflicting policy predicates require different workflow IDs");
    }
    for (index, left) in artifact_fields.iter().enumerate() {
        for right in artifact_fields.iter().skip(index + 1) {
            if left.get("artifact_type") != right.get("artifact_type")
                || left.get("field") != right.get("field")
            {
                continue;
            }
            let left_role = left.get("producer_role").and_then(Value::as_str);
            let right_role = right.get("producer_role").and_then(Value::as_str);
            if left_role.is_some() && right_role.is_some() && left_role != right_role {
                continue;
            }
            let left_type = left.get("type").and_then(Value::as_str).unwrap_or_default();
            let right_type = right
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let left_expected = left.get("expected");
            let right_expected = right.get("expected");
            let conflict =
                if left_type == "artifact_field_equals" && right_type == "artifact_field_equals" {
                    !node_scalar_strict_equal(left_expected, right_expected)
                } else if matches!(
                    (left_type, right_type),
                    ("artifact_field_equals", "artifact_field_includes")
                        | ("artifact_field_includes", "artifact_field_equals")
                ) {
                    true
                } else {
                    let equals = if left_type == "artifact_field_equals" {
                        left_expected
                    } else if right_type == "artifact_field_equals" {
                        right_expected
                    } else {
                        None
                    };
                    let has_non_empty = left_type == "artifact_field_non_empty"
                        || right_type == "artifact_field_non_empty";
                    equals.is_some_and(|value| has_non_empty && !value.is_string())
                };
            if conflict {
                let artifact_type = left
                    .get("artifact_type")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let field = left
                    .get("field")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                return invalid(format!(
                    "conflicting policy predicates for artifact field {artifact_type}.{field}"
                ));
            }
        }
    }
    Ok(())
}

fn node_scalar_strict_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (Some(Value::String(left)), Some(Value::String(right))) => left == right,
        (Some(Value::Bool(left)), Some(Value::Bool(right))) => left == right,
        (Some(Value::Number(left)), Some(Value::Number(right))) => left.as_f64() == right.as_f64(),
        _ => false,
    }
}

fn validate_predicate_compatible(
    rule: &Value,
    context: &PolicyPlanContextV1,
) -> Result<(), WorkflowPolicyV1Error> {
    let id = rule.get("id").and_then(Value::as_str).unwrap_or("unknown");
    let kind = rule.get("type").and_then(Value::as_str).unwrap_or_default();
    if kind == "workflow_id_equals"
        && rule.get("expected").and_then(Value::as_str) != Some(context.workflow_id.as_str())
    {
        return invalid(format!(
            "policy rule {id} expects a different workflow ID than the target plan"
        ));
    }
    let roles = context
        .tasks
        .iter()
        .map(|task| task.role_id.as_str())
        .collect::<BTreeSet<_>>();
    let task_ids = context
        .tasks
        .iter()
        .map(|task| task.task_id.as_str())
        .collect::<BTreeSet<_>>();
    if kind == "task_role_present" {
        let role = rule["role"].as_str().unwrap_or_default();
        if !roles.contains(role) {
            return invalid(format!("policy rule {id} requires planned role {role}"));
        }
    }
    if kind == "task_role_absent" {
        let role = rule["role"].as_str().unwrap_or_default();
        if roles.contains(role) {
            return invalid(format!("policy rule {id} forbids planned role {role}"));
        }
    }
    if matches!(kind, "task_status_equals" | "execution_exit_code_equals") {
        let task_id = rule["task_id"].as_str().unwrap_or_default();
        if !task_ids.contains(task_id) {
            return invalid(format!(
                "policy rule {id} references unknown planned task {task_id}"
            ));
        }
        if kind == "execution_exit_code_equals" {
            let task = context.tasks.iter().find(|task| task.task_id == task_id);
            if !task.is_some_and(|task| {
                task.deterministic && task.executor.as_deref() == Some("ExecutionManager")
            }) {
                return invalid(format!(
                    "policy rule {id} requires a deterministic approved local execution contract"
                ));
            }
        }
    }
    if kind.starts_with("artifact_") {
        if let Some(role) = rule.get("producer_role").and_then(Value::as_str) {
            if !roles.contains(role) {
                return invalid(format!(
                    "policy rule {id} requires artifact producer role {role}"
                ));
            }
        }
    }
    Ok(())
}

fn policy_snapshot_digest(
    snapshot: &WorkflowPolicySnapshotV1,
) -> Result<String, WorkflowPolicyV1Error> {
    let definition = json!({
        "schema_version": snapshot.schema_version,
        "policy_id": snapshot.policy_id,
        "name": snapshot.name,
        "description": snapshot.description,
        "constraints": snapshot.constraints,
        "success_criteria": snapshot.success_criteria,
    });
    let material = json!({
        "policy_id": snapshot.policy_id,
        "version": snapshot.version,
        "definition": definition,
    });
    let canonical = canonicalize_node_plan_json(&material)?;
    Ok(sha256(canonical.as_bytes()))
}

fn validate_slug(value: &str, field: &str, max_length: usize) -> Result<(), WorkflowPolicyV1Error> {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return invalid(format!("{field} must be a lowercase slug"));
    };
    if value.len() > max_length
        || !first.is_ascii_lowercase()
        || !bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        || value.ends_with('-')
        || value.contains("--")
    {
        return invalid(format!("{field} must be a lowercase slug"));
    }
    Ok(())
}

fn required_text(
    value: &str,
    field: &str,
    max_length: usize,
) -> Result<String, WorkflowPolicyV1Error> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return invalid(format!("{field} must be a non-empty string"));
    }
    if normalized.len() > max_length {
        return invalid(format!("{field} exceeds {max_length} characters"));
    }
    Ok(normalized.to_owned())
}

fn sha256(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}

fn invalid<T>(message: impl Into<String>) -> Result<T, WorkflowPolicyV1Error> {
    Err(WorkflowPolicyV1Error::Invalid(message.into()))
}

/// Errors returned by version-1 policy normalization/composition.
#[derive(Debug, PartialEq, Eq, Error)]
pub enum WorkflowPolicyV1Error {
    /// A schema, rule, snapshot, context, or composition invariant failed.
    #[error("workflow policy contract invalid: {0}")]
    Invalid(String),
    /// A canonical JSON Number could not be represented as a finite JavaScript Number.
    #[error(transparent)]
    Canonicalization(#[from] NodePlanCanonicalJsonError),
    /// Serialization of a typed contract failed.
    #[error("workflow policy contract serialization failed: {0}")]
    CanonicalSerialization(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy_definition() -> WorkflowPolicyDefinitionV1 {
        WorkflowPolicyDefinitionV1 {
            schema_version: 1,
            policy_id: "require-owner".into(),
            name: "Require custom owner".into(),
            description: "The immutable plan must include the custom owner role".into(),
            constraints: vec![json!({
                "id": "owner-present",
                "type": "task_role_present",
                "role": "custom-owner"
            })],
            success_criteria: vec![json!({
                "id": "all-complete",
                "type": "all_tasks_completed"
            })],
        }
    }

    fn context() -> PolicyPlanContextV1 {
        PolicyPlanContextV1 {
            workflow_id: "policy-flow".into(),
            tasks: vec![PolicyTaskContextV1 {
                task_id: "requirements".into(),
                role_id: "custom-owner".into(),
                deterministic: false,
                executor: None,
            }],
        }
    }

    #[test]
    fn policy_snapshot_hash_matches_node_public_api_golden_fixture() {
        #[derive(Deserialize)]
        struct Fixture {
            snapshot: WorkflowPolicySnapshotV1,
        }
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../tests/fixtures/node-workflow-policy-v1.json"
        ))
        .unwrap();
        let snapshot = create_workflow_policy_snapshot_v1(&policy_definition(), 1).unwrap();
        assert_eq!(snapshot, fixture.snapshot);
        validate_workflow_policy_snapshot_v1(&snapshot).unwrap();
    }

    #[test]
    fn numeric_policy_snapshots_match_node_public_api_golden_vectors() {
        #[derive(Deserialize)]
        struct Fixture {
            schema_version: u32,
            generated_by_node: bool,
            source: String,
            vectors: Vec<Vector>,
        }
        #[derive(Deserialize)]
        struct Vector {
            definition: WorkflowPolicyDefinitionV1,
            snapshot: WorkflowPolicySnapshotV1,
        }

        let fixture: Fixture = serde_json::from_str(include_str!(
            "../tests/fixtures/node-policy-number-snapshot-v1.json"
        ))
        .unwrap();
        assert_eq!(fixture.schema_version, 1);
        assert!(fixture.generated_by_node);
        assert!(fixture.source.contains("createPolicySnapshot"));
        assert_eq!(fixture.vectors.len(), 4);

        for vector in fixture.vectors {
            let actual =
                create_workflow_policy_snapshot_v1(&vector.definition, vector.snapshot.version)
                    .unwrap_or_else(|error| panic!("{}: {error}", vector.snapshot.policy_id));
            assert_eq!(actual, vector.snapshot, "{}", vector.snapshot.policy_id);
            validate_workflow_policy_snapshot_v1(&actual).unwrap();
        }
    }

    #[test]
    fn success_contract_normalizes_node_rule_fields_and_alias() {
        let input = json!({
            "goal": "  Complete workflow  ",
            "criteria": [{ "id": "done", "type": "all_tasks_completed", "description": null }]
        });
        let normalized = normalize_workflow_success_contract_v1(Some(&input), "fallback").unwrap();
        assert_eq!(normalized.goal, "Complete workflow");
        assert_eq!(
            normalized.success_criteria,
            [json!({"id":"done","type":"all_tasks_completed"})]
        );
    }

    #[test]
    fn composition_matches_node_fixture_and_namespaces_policy_rules() {
        #[derive(Deserialize)]
        struct Fixture {
            composed: WorkflowPolicyCompositionV1,
        }
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../tests/fixtures/node-workflow-policy-composition-v1.json"
        ))
        .unwrap();
        let snapshot = create_workflow_policy_snapshot_v1(&policy_definition(), 1).unwrap();
        let base = json!({"goal":"Complete workflow"});
        let composed = compose_workflow_policy_v1(Some(&base), &[snapshot], &context()).unwrap();
        assert_eq!(composed, fixture.composed);
        assert_eq!(composed.policy_pins.len(), 1);
        assert_eq!(composed.policy_pins[0].policy_id, "require-owner");
    }

    #[test]
    fn policy_composition_is_order_independent_and_rejects_duplicate_packs() {
        let one = create_workflow_policy_snapshot_v1(&policy_definition(), 1).unwrap();
        let mut second_definition = policy_definition();
        second_definition.policy_id = "require-workflow".into();
        second_definition.name = "Require policy workflow".into();
        second_definition.constraints = vec![json!({
            "id":"workflow-match",
            "type":"workflow_id_equals",
            "expected":"policy-flow"
        })];
        second_definition.success_criteria.clear();
        let two = create_workflow_policy_snapshot_v1(&second_definition, 2).unwrap();
        let base = json!({"goal":"Complete workflow"});
        let forward =
            compose_workflow_policy_v1(Some(&base), &[one.clone(), two.clone()], &context())
                .unwrap();
        let reverse =
            compose_workflow_policy_v1(Some(&base), &[two, one.clone()], &context()).unwrap();
        assert_eq!(forward, reverse);
        assert_eq!(forward.policy_packs[0].policy_id, "require-owner");
        assert!(compose_workflow_policy_v1(Some(&base), &[one.clone(), one], &context()).is_err());
    }

    #[test]
    fn policy_validation_rejects_unknown_fields_conflicts_and_wrong_plan_references() {
        let mut definition = policy_definition();
        definition.constraints[0]["unexpected"] = json!(true);
        assert!(normalize_workflow_policy_definition_v1(&definition).is_err());

        let mut conflicting = policy_definition();
        conflicting.success_criteria.push(json!({
            "id":"owner-absent",
            "type":"task_role_absent",
            "role":"custom-owner"
        }));
        assert!(normalize_workflow_policy_definition_v1(&conflicting).is_err());

        let mut missing_task = policy_definition();
        missing_task.constraints = vec![json!({
            "id":"missing-task",
            "type":"task_status_equals",
            "task_id":"does-not-exist",
            "expected":"completed"
        })];
        missing_task.success_criteria.clear();
        let snapshot = create_workflow_policy_snapshot_v1(&missing_task, 1).unwrap();
        assert!(compose_workflow_policy_v1(None, &[snapshot], &context()).is_err());
    }

    #[test]
    fn artifact_equals_conflicts_follow_javascript_strict_scalar_equality() {
        let equal_numbers = [
            json!({
                "id":"number-one",
                "type":"artifact_field_equals",
                "artifact_type":"requirements",
                "field":"count",
                "expected":1
            }),
            json!({
                "id":"number-one-point-zero",
                "type":"artifact_field_equals",
                "artifact_type":"requirements",
                "field":"count",
                "expected":1.0
            }),
        ];
        assert!(validate_semantic_conflicts(equal_numbers.iter()).is_ok());

        let conflicting_types = [
            json!({
                "id":"string-one",
                "type":"artifact_field_equals",
                "artifact_type":"requirements",
                "field":"count",
                "expected":"1"
            }),
            json!({
                "id":"number-one",
                "type":"artifact_field_equals",
                "artifact_type":"requirements",
                "field":"count",
                "expected":1
            }),
        ];
        assert!(validate_semantic_conflicts(conflicting_types.iter()).is_err());
    }

    #[test]
    fn execution_exit_code_predicate_requires_attested_executor_identity() {
        let mut definition = policy_definition();
        definition.constraints = vec![json!({
            "id":"zero-exit",
            "type":"execution_exit_code_equals",
            "task_id":"requirements",
            "expected":0
        })];
        definition.success_criteria.clear();
        let snapshot = create_workflow_policy_snapshot_v1(&definition, 1).unwrap();
        assert!(
            compose_workflow_policy_v1(None, std::slice::from_ref(&snapshot), &context()).is_err()
        );
        let mut trusted_context = context();
        trusted_context.tasks[0].deterministic = true;
        trusted_context.tasks[0].executor = Some("ExecutionManager".into());
        assert!(compose_workflow_policy_v1(None, &[snapshot], &trusted_context).is_ok());
    }
}
