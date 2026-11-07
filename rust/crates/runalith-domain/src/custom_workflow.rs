//! Rust contract for the Node custom-role/custom-workflow catalog.
//!
//! This is deliberately separate from the immutable built-in agent catalog:
//! custom workflows may reference only explicitly versioned custom roles.
//! Skill identifiers are accepted only from a caller-supplied trusted catalog.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::workflow::{
    ArtifactType, CompiledWorkflowPlan, CustomWorkflowDefinition, WorkflowCapability,
    WorkflowCompileError, WorkflowPermission, WorkflowRoleContract, compile_workflow,
};

/// Node-compatible custom-role tool allowlist.
pub const CUSTOM_ROLE_TOOLS: &[&str] = &[
    "workflow_catalog",
    "workflow_list",
    "workflow_get",
    "workflow_events",
    "workflow_artifacts",
    "workflow_validate_artifact",
];

/// Versioned custom role record used by custom workflow compilation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CustomRoleDefinition {
    /// Canonical custom role slug; built-in and `system-*` IDs are reserved.
    pub role_id: String,
    /// Explicit immutable role version.
    pub version: u32,
    /// Role display name.
    pub name: String,
    /// Role description.
    pub description: String,
    /// Role system prompt.
    pub system_prompt: String,
    /// Typed artifact inputs accepted by the role.
    pub input_contract: Vec<ArtifactType>,
    /// Typed artifact output produced by the role.
    pub output_artifact_type: ArtifactType,
    /// Capabilities declared by the role.
    pub allowed_capabilities: Vec<WorkflowCapability>,
    /// Descriptive permissions; custom roles cannot request execution or writes.
    pub permissions: Vec<WorkflowPermission>,
    /// Tool identifiers restricted to [`CUSTOM_ROLE_TOOLS`].
    pub allowed_tools: Vec<String>,
    /// Skill identifiers resolved against an independently supplied catalog.
    pub skills: Vec<String>,
}

/// Validate a custom role and its skill/tool references.
pub fn validate_custom_role(
    role: &CustomRoleDefinition,
    available_skill_ids: &BTreeSet<String>,
) -> Result<(), CustomWorkflowError> {
    validate_slug(&role.role_id, "role_id", 80)?;
    if [
        "cto",
        "engineer",
        "architect",
        "qa",
        "reviewer",
        "security",
        "platform",
        "writer",
        "researcher",
        "product-owner",
    ]
    .contains(&role.role_id.as_str())
        || role.role_id.starts_with("system-")
    {
        return Err(CustomWorkflowError::ReservedRole(role.role_id.clone()));
    }
    if role.version == 0 {
        return Err(CustomWorkflowError::InvalidRoleVersion(
            role.role_id.clone(),
        ));
    }
    validate_text(&role.name, "name", 120)?;
    validate_text(&role.description, "description", 2_000)?;
    validate_text(&role.system_prompt, "system_prompt", 12_000)?;
    validate_unique(&role.input_contract, "input_contract", &role.role_id)?;
    if role.input_contract.is_empty() || role.input_contract.len() > 32 {
        return Err(CustomWorkflowError::FieldCount("input_contract"));
    }
    if role.output_artifact_type == ArtifactType::JobRequest {
        return Err(CustomWorkflowError::InvalidOutput(role.role_id.clone()));
    }
    validate_unique(
        &role.allowed_capabilities,
        "allowed_capabilities",
        &role.role_id,
    )?;
    if role.allowed_capabilities.len() > 32 {
        return Err(CustomWorkflowError::FieldCount("allowed_capabilities"));
    }
    validate_unique(&role.permissions, "permissions", &role.role_id)?;
    if role.permissions.is_empty()
        || role.permissions.len() > 32
        || !role
            .permissions
            .contains(&WorkflowPermission::ArtifactCreate)
        || role.permissions.iter().any(|permission| {
            !matches!(
                permission,
                WorkflowPermission::WorkspaceRead | WorkflowPermission::ArtifactCreate
            )
        })
    {
        return Err(CustomWorkflowError::PermissionEscalation(
            role.role_id.clone(),
        ));
    }
    validate_unique(&role.allowed_tools, "allowed_tools", &role.role_id)?;
    if role.allowed_tools.len() > 32
        || role
            .allowed_tools
            .iter()
            .any(|tool| !CUSTOM_ROLE_TOOLS.contains(&tool.as_str()))
    {
        return Err(CustomWorkflowError::ToolNotAllowed(role.role_id.clone()));
    }
    validate_unique(&role.skills, "skills", &role.role_id)?;
    if role.skills.len() > 32
        || role
            .skills
            .iter()
            .any(|skill| !available_skill_ids.contains(skill))
    {
        return Err(CustomWorkflowError::SkillUnavailable(role.role_id.clone()));
    }
    for skill in &role.skills {
        validate_text(skill, "skill", 200)?;
    }
    Ok(())
}

/// Compile a custom workflow against exact, versioned custom-role snapshots.
///
/// This API rejects built-in agent roles. `available_skill_ids` must come from
/// a separately validated, trusted skill catalog; no skill name is resolved
/// from caller-supplied filesystem paths.
pub fn compile_custom_workflow(
    definition: &CustomWorkflowDefinition,
    custom_roles: &[CustomRoleDefinition],
    available_skill_ids: &BTreeSet<String>,
) -> Result<CompiledWorkflowPlan, CustomWorkflowError> {
    if ["engineering", "standard-engineering", "production"]
        .contains(&definition.workflow_id.as_str())
    {
        return Err(CustomWorkflowError::ReservedWorkflow(
            definition.workflow_id.clone(),
        ));
    }
    let mut role_contracts = Vec::with_capacity(custom_roles.len());
    let mut role_ids = BTreeSet::new();
    for role in custom_roles {
        validate_custom_role(role, available_skill_ids)?;
        if !role_ids.insert((role.role_id.as_str(), role.version)) {
            return Err(CustomWorkflowError::DuplicateRoleVersion(
                role.role_id.clone(),
                role.version,
            ));
        }
        role_contracts.push(WorkflowRoleContract {
            role_id: role.role_id.clone(),
            name: role.name.clone(),
            version: role.version,
            capability: role
                .allowed_capabilities
                .first()
                .copied()
                .unwrap_or(WorkflowCapability::ResearchCollect),
            inputs: role.input_contract.clone(),
            output: role.output_artifact_type,
            permissions: role.permissions.clone(),
        });
    }
    for task in &definition.tasks {
        if !role_ids.contains(&(task.role_id.as_str(), task.role_version)) {
            return Err(CustomWorkflowError::UnknownCustomRoleVersion(
                task.role_id.clone(),
                task.role_version,
            ));
        }
    }
    Ok(compile_workflow(definition, &role_contracts)?)
}

/// Custom-role/custom-workflow validation errors.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum CustomWorkflowError {
    /// Workflow compiler rejected the typed DAG or immutable plan.
    #[error(transparent)]
    Compile(#[from] WorkflowCompileError),
    /// Text field is missing or too long.
    #[error("custom role {0} field is invalid")]
    InvalidText(String),
    /// Role identifier is reserved.
    #[error("custom role identifier is reserved: {0}")]
    ReservedRole(String),
    /// Workflow identifier conflicts with a built-in workflow.
    #[error("custom workflow identifier is reserved: {0}")]
    ReservedWorkflow(String),
    /// Role version must be positive.
    #[error("custom role version must be positive: {0}")]
    InvalidRoleVersion(String),
    /// Role list has invalid length.
    #[error("custom role list length is invalid: {0}")]
    FieldCount(&'static str),
    /// Role cannot produce job.request.
    #[error("custom role cannot produce job.request: {0}")]
    InvalidOutput(String),
    /// Role permissions exceed the custom-role allowlist.
    #[error("custom role permissions exceed allowlist: {0}")]
    PermissionEscalation(String),
    /// Role tool is not in the custom-role allowlist.
    #[error("custom role tool is not allowed: {0}")]
    ToolNotAllowed(String),
    /// A skill is absent from the trusted skill catalog.
    #[error("custom role references an unavailable skill: {0}")]
    SkillUnavailable(String),
    /// A list contains duplicate entries.
    #[error("custom role {1} contains duplicate {0}")]
    Duplicate(&'static str, String),
    /// Custom role version is duplicated.
    #[error("duplicate custom role version: {0}@{1}")]
    DuplicateRoleVersion(String, u32),
    /// Task references a role not in the custom-role catalog.
    #[error("unknown custom role version: {0}@{1}")]
    UnknownCustomRoleVersion(String, u32),
}

fn validate_text(value: &str, field: &str, max: usize) -> Result<(), CustomWorkflowError> {
    if value.trim().is_empty() || value.trim() != value || value.encode_utf16().count() > max {
        return Err(CustomWorkflowError::InvalidText(field.into()));
    }
    Ok(())
}

fn validate_slug(value: &str, field: &str, max: usize) -> Result<(), CustomWorkflowError> {
    validate_text(value, field, max)?;
    let bytes = value.as_bytes();
    if bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        && !value.ends_with('-')
        && !value.contains("--")
    {
        Ok(())
    } else {
        Err(CustomWorkflowError::InvalidText(field.into()))
    }
}

fn validate_unique<T: Ord>(
    values: &[T],
    field: &'static str,
    owner: &str,
) -> Result<(), CustomWorkflowError> {
    let mut unique = BTreeSet::new();
    if values.iter().any(|value| !unique.insert(value)) {
        return Err(CustomWorkflowError::Duplicate(field, owner.into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    struct NodeCustomWorkflowOracle {
        schema_version: u32,
        generated_by_node: bool,
        source: String,
        roles: Vec<CustomRoleDefinition>,
        valid_cases: Vec<ValidCompilerCase>,
        rejected_cases: Vec<RejectedCompilerCase>,
    }

    #[derive(Debug, Deserialize)]
    struct ValidCompilerCase {
        name: String,
        definition: CustomWorkflowDefinition,
        canonical_content: String,
        plan_hash: String,
        task_order: Vec<String>,
    }

    #[derive(Debug, Deserialize)]
    struct RejectedCompilerCase {
        name: String,
        definition: CustomWorkflowDefinition,
        expected_error_class: String,
    }

    fn node_custom_workflow_oracle() -> NodeCustomWorkflowOracle {
        serde_json::from_str(include_str!(
            "../fixtures/node-custom-workflow-compiler-v1.json"
        ))
        .expect("Node custom workflow compiler oracle must parse")
    }

    fn custom_workflow_error_class(error: &CustomWorkflowError) -> &'static str {
        match error {
            CustomWorkflowError::Compile(WorkflowCompileError::UnknownDependency(..)) => {
                "UNKNOWN_DEPENDENCY"
            }
            CustomWorkflowError::Compile(WorkflowCompileError::DuplicateTask(..)) => {
                "DUPLICATE_TASK"
            }
            CustomWorkflowError::Compile(WorkflowCompileError::DependencyCycle) => {
                "DEPENDENCY_CYCLE"
            }
            CustomWorkflowError::Compile(WorkflowCompileError::UnsupportedRoleInput(..)) => {
                "UNSUPPORTED_ROLE_INPUT"
            }
            CustomWorkflowError::Compile(WorkflowCompileError::RoleOutputMismatch(..)) => {
                "ROLE_OUTPUT_MISMATCH"
            }
            CustomWorkflowError::UnknownCustomRoleVersion(..) => "UNKNOWN_CUSTOM_ROLE_VERSION",
            other => panic!("Node compiler oracle produced unmapped Rust error: {other:?}"),
        }
    }
    use crate::workflow::{CustomWorkflowDefinition, WorkflowTaskDefinition};

    fn roles() -> Vec<CustomRoleDefinition> {
        vec![
            CustomRoleDefinition {
                role_id: "custom-owner".into(),
                version: 1,
                name: "Custom Owner".into(),
                description: "Custom role fixture".into(),
                system_prompt: "Use only declared artifact inputs and emit typed output".into(),
                input_contract: vec![ArtifactType::JobRequest],
                output_artifact_type: ArtifactType::Requirements,
                allowed_capabilities: vec![WorkflowCapability::ProductRequirements],
                permissions: vec![
                    WorkflowPermission::WorkspaceRead,
                    WorkflowPermission::ArtifactCreate,
                ],
                allowed_tools: vec!["workflow_get".into()],
                skills: vec![],
            },
            CustomRoleDefinition {
                role_id: "custom-researcher".into(),
                version: 1,
                name: "Custom Researcher".into(),
                description: "Custom role fixture".into(),
                system_prompt: "Use only declared artifact inputs and emit typed output".into(),
                input_contract: vec![ArtifactType::Requirements],
                output_artifact_type: ArtifactType::Research,
                allowed_capabilities: vec![WorkflowCapability::ResearchCollect],
                permissions: vec![
                    WorkflowPermission::WorkspaceRead,
                    WorkflowPermission::ArtifactCreate,
                ],
                allowed_tools: vec!["workflow_catalog".into()],
                skills: vec![],
            },
        ]
    }

    fn definition() -> CustomWorkflowDefinition {
        CustomWorkflowDefinition {
            workflow_id: "custom-research-flow".into(),
            version: 1,
            name: "Custom research flow".into(),
            description: "Custom-role compiler golden".into(),
            input_contract: vec![ArtifactType::JobRequest],
            tasks: vec![
                WorkflowTaskDefinition {
                    id: "collect".into(),
                    role_id: "custom-researcher".into(),
                    role_version: 1,
                    depends_on: vec!["requirements".into()],
                    input_contract: Some(vec![ArtifactType::Requirements]),
                    output_artifact_type: Some(ArtifactType::Research),
                },
                WorkflowTaskDefinition {
                    id: "requirements".into(),
                    role_id: "custom-owner".into(),
                    role_version: 1,
                    depends_on: vec![],
                    input_contract: Some(vec![ArtifactType::JobRequest]),
                    output_artifact_type: Some(ArtifactType::Requirements),
                },
            ],
        }
    }

    #[test]
    fn compiles_only_explicit_custom_role_versions_and_pins_node_preview_contract() {
        let skills = BTreeSet::new();
        let plan = compile_custom_workflow(&definition(), &roles(), &skills).unwrap();
        assert_eq!(plan.execution_order(), ["requirements", "collect"]);
        assert_eq!(plan.tasks()[0].role_id, "custom-researcher");
        assert_eq!(plan.tasks()[0].role_version, 1);
        plan.verify_digest().unwrap();
        let golden: serde_json::Value = serde_json::from_str(include_str!(
            "../fixtures/custom-workflow-preview-node-golden.json"
        ))
        .unwrap();
        assert_eq!(
            plan.canonical_content().unwrap(),
            golden["canonical_content"]
        );
        assert_eq!(plan.plan_hash(), golden["plan_hash"]);
    }

    #[test]
    fn node_public_custom_workflow_compiler_valid_and_rejected_cases_match() {
        let fixture = node_custom_workflow_oracle();
        assert_eq!(fixture.schema_version, 1);
        assert!(fixture.generated_by_node);
        assert!(fixture.source.contains("createCustomWorkflow"));
        assert!(fixture.source.contains("previewCustomWorkflow"));
        assert_eq!(fixture.roles.len(), 6);
        assert_eq!(fixture.valid_cases.len(), 3);
        assert_eq!(fixture.rejected_cases.len(), 6);

        let skills = BTreeSet::new();
        for case in fixture.valid_cases {
            let plan = compile_custom_workflow(&case.definition, &fixture.roles, &skills)
                .unwrap_or_else(|error| panic!("{} rejected by Rust compiler: {error}", case.name));
            assert_eq!(
                plan.canonical_content().unwrap(),
                case.canonical_content,
                "{} canonical plan bytes",
                case.name
            );
            assert_eq!(plan.plan_hash(), case.plan_hash, "{} plan hash", case.name);
            assert_eq!(
                plan.tasks()
                    .iter()
                    .map(|task| task.task_id.clone())
                    .collect::<Vec<_>>(),
                case.task_order,
                "{} immutable task definition order",
                case.name
            );
            plan.verify_digest()
                .unwrap_or_else(|error| panic!("{} digest verification: {error}", case.name));
        }

        for case in fixture.rejected_cases {
            let error = compile_custom_workflow(&case.definition, &fixture.roles, &skills)
                .expect_err("Node-rejected custom workflow must reject in Rust");
            assert_eq!(
                custom_workflow_error_class(&error),
                case.expected_error_class,
                "{} error class ({error})",
                case.name
            );
        }
    }

    #[test]
    fn rejects_builtin_roles_unregistered_versions_and_unknown_skills() {
        let skills = BTreeSet::new();
        let mut builtin = definition();
        builtin.tasks[0].role_id = "engineer".into();
        assert_eq!(
            compile_custom_workflow(&builtin, &roles(), &skills).unwrap_err(),
            CustomWorkflowError::UnknownCustomRoleVersion("engineer".into(), 1)
        );
        let mut unknown_skill = roles();
        unknown_skill[0].skills = vec!["untrusted-skill".into()];
        assert!(matches!(
            validate_custom_role(&unknown_skill[0], &skills),
            Err(CustomWorkflowError::SkillUnavailable(_))
        ));
    }

    #[test]
    fn rejects_permission_tool_and_reserved_role_escalation() {
        let skills = BTreeSet::new();
        let mut elevated = roles();
        elevated[0]
            .permissions
            .push(WorkflowPermission::WorkspaceWrite);
        assert!(matches!(
            validate_custom_role(&elevated[0], &skills),
            Err(CustomWorkflowError::PermissionEscalation(_))
        ));
        elevated = roles();
        elevated[0].allowed_tools = vec!["shell_exec".into()];
        assert!(matches!(
            validate_custom_role(&elevated[0], &skills),
            Err(CustomWorkflowError::ToolNotAllowed(_))
        ));
        elevated = roles();
        elevated[0].role_id = "engineer".into();
        assert!(matches!(
            validate_custom_role(&elevated[0], &skills),
            Err(CustomWorkflowError::ReservedRole(_))
        ));

        let mut reserved_workflow = definition();
        reserved_workflow.workflow_id = "production".into();
        assert!(matches!(
            compile_custom_workflow(&reserved_workflow, &roles(), &skills),
            Err(CustomWorkflowError::ReservedWorkflow(_))
        ));
    }
}
