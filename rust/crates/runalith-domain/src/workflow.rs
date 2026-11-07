//! Typed workflow catalog and compiler.
//!
//! This module models the contract enforced by the Node custom-workflow
//! catalog: role versions are pinned, task inputs must be supported by their
//! role, predecessor outputs must be declared as inputs, and dependencies must
//! form a DAG. Compilation produces a content-addressed snapshot. A valid
//! snapshot is not an approval or execution authorization.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Artifact types accepted by the workflow catalog.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ArtifactType {
    /// Original requester input.
    #[serde(rename = "job.request")]
    JobRequest,
    /// Product requirements artifact.
    Requirements,
    /// Research findings artifact.
    Research,
    /// Architecture design artifact.
    Architecture,
    /// Implementation evidence artifact.
    Implementation,
    /// Security review artifact.
    SecurityReview,
    /// Quality assurance report artifact.
    QaReport,
    /// Platform review artifact.
    PlatformReview,
    /// Documentation artifact.
    Documentation,
    /// Change review artifact.
    Review,
    /// Final synthesis decision artifact.
    CtoDecision,
}

/// Capability declared by a workflow role contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum WorkflowCapability {
    /// Define product scope and acceptance criteria.
    #[serde(rename = "product.requirements")]
    ProductRequirements,
    /// Collect evidence and research.
    #[serde(rename = "research.collect")]
    ResearchCollect,
    /// Design architecture and interfaces.
    #[serde(rename = "architecture.design")]
    ArchitectureDesign,
    /// Modify implementation.
    #[serde(rename = "code.modify")]
    CodeModify,
    /// Audit security properties.
    #[serde(rename = "security.audit")]
    SecurityAudit,
    /// Verify implementation and acceptance criteria.
    #[serde(rename = "code.verify")]
    CodeVerify,
    /// Review infrastructure and runtime operations.
    #[serde(rename = "infrastructure.verify")]
    InfrastructureVerify,
    /// Write documentation.
    #[serde(rename = "documentation.write")]
    DocumentationWrite,
    /// Review a change.
    #[serde(rename = "change.review")]
    ChangeReview,
    /// Synthesize evidence and record a decision.
    #[serde(rename = "synthesis.approve")]
    SynthesisApprove,
}

/// Permission label declared by a role contract. This is descriptive domain
/// data; it does not grant the permission to a caller or executor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum WorkflowPermission {
    /// Read workspace content.
    #[serde(rename = "workspace.read")]
    WorkspaceRead,
    /// Write workspace content subject to a separately pinned scope.
    #[serde(rename = "workspace.write")]
    WorkspaceWrite,
    /// Request execution subject to runtime policy.
    #[serde(rename = "execution.request")]
    ExecutionRequest,
    /// Create an artifact.
    #[serde(rename = "artifact.create")]
    ArtifactCreate,
}

/// Immutable versioned role contract used by the compiler.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowRoleContract {
    /// Stable role identifier.
    pub role_id: String,
    /// Human-readable role name pinned into plan snapshots.
    pub name: String,
    /// Contract version. A positive explicit version is required.
    pub version: u32,
    /// Stable capability identifier.
    pub capability: WorkflowCapability,
    /// Artifact inputs accepted by the role.
    pub inputs: Vec<ArtifactType>,
    /// Artifact output produced by the role.
    pub output: ArtifactType,
    /// Descriptive permissions attached to the role contract.
    pub permissions: Vec<WorkflowPermission>,
}

impl WorkflowRoleContract {
    /// Validate contract identity, version, and bounded unique lists.
    pub fn validate(&self) -> Result<(), WorkflowCompileError> {
        validate_slug(&self.role_id, "role_id", 80)?;
        validate_text(&self.name, "role name", 120)?;
        if self.version == 0 {
            return Err(WorkflowCompileError::InvalidRoleVersion(
                self.role_id.clone(),
            ));
        }
        validate_unique(&self.inputs, "role inputs", &self.role_id)?;
        validate_unique(&self.permissions, "role permissions", &self.role_id)?;
        if self.inputs.is_empty() || self.inputs.len() > 32 || self.permissions.len() > 16 {
            return Err(WorkflowCompileError::RoleFieldCount(self.role_id.clone()));
        }
        Ok(())
    }
}

/// Look up a built-in role contract by canonical role identifier.
///
/// The returned catalog reflects `src/runtime/agent-contracts-public-api.js`.
/// Custom role versions are supplied explicitly to [`compile_workflow`].
pub fn builtin_role(role_id: &str) -> Option<WorkflowRoleContract> {
    let (capability, inputs, output, permissions) = match role_id {
        "product-owner" | "productowner" => (
            WorkflowCapability::ProductRequirements,
            vec![ArtifactType::JobRequest],
            ArtifactType::Requirements,
            vec![
                WorkflowPermission::WorkspaceRead,
                WorkflowPermission::ArtifactCreate,
            ],
        ),
        "researcher" => (
            WorkflowCapability::ResearchCollect,
            vec![ArtifactType::Requirements],
            ArtifactType::Research,
            vec![
                WorkflowPermission::WorkspaceRead,
                WorkflowPermission::ArtifactCreate,
            ],
        ),
        "architect" => (
            WorkflowCapability::ArchitectureDesign,
            vec![ArtifactType::Requirements, ArtifactType::Research],
            ArtifactType::Architecture,
            vec![
                WorkflowPermission::WorkspaceRead,
                WorkflowPermission::ArtifactCreate,
            ],
        ),
        "engineer" => (
            WorkflowCapability::CodeModify,
            vec![ArtifactType::Requirements, ArtifactType::Architecture],
            ArtifactType::Implementation,
            vec![
                WorkflowPermission::WorkspaceRead,
                WorkflowPermission::WorkspaceWrite,
                WorkflowPermission::ExecutionRequest,
                WorkflowPermission::ArtifactCreate,
            ],
        ),
        "security" => (
            WorkflowCapability::SecurityAudit,
            vec![
                ArtifactType::Requirements,
                ArtifactType::Architecture,
                ArtifactType::Implementation,
            ],
            ArtifactType::SecurityReview,
            vec![
                WorkflowPermission::WorkspaceRead,
                WorkflowPermission::ArtifactCreate,
            ],
        ),
        "qa" => (
            WorkflowCapability::CodeVerify,
            vec![
                ArtifactType::Requirements,
                ArtifactType::Architecture,
                ArtifactType::Implementation,
            ],
            ArtifactType::QaReport,
            vec![
                WorkflowPermission::WorkspaceRead,
                WorkflowPermission::ExecutionRequest,
                WorkflowPermission::ArtifactCreate,
            ],
        ),
        "platform" => (
            WorkflowCapability::InfrastructureVerify,
            vec![ArtifactType::Architecture, ArtifactType::Implementation],
            ArtifactType::PlatformReview,
            vec![
                WorkflowPermission::WorkspaceRead,
                WorkflowPermission::ArtifactCreate,
            ],
        ),
        "writer" => (
            WorkflowCapability::DocumentationWrite,
            vec![ArtifactType::Requirements, ArtifactType::Implementation],
            ArtifactType::Documentation,
            vec![
                WorkflowPermission::WorkspaceRead,
                WorkflowPermission::WorkspaceWrite,
                WorkflowPermission::ArtifactCreate,
            ],
        ),
        "reviewer" => (
            WorkflowCapability::ChangeReview,
            vec![
                ArtifactType::Requirements,
                ArtifactType::Architecture,
                ArtifactType::Implementation,
                ArtifactType::SecurityReview,
                ArtifactType::QaReport,
                ArtifactType::PlatformReview,
                ArtifactType::Documentation,
            ],
            ArtifactType::Review,
            vec![
                WorkflowPermission::WorkspaceRead,
                WorkflowPermission::ArtifactCreate,
            ],
        ),
        "cto" => (
            WorkflowCapability::SynthesisApprove,
            vec![
                ArtifactType::Requirements,
                ArtifactType::Architecture,
                ArtifactType::Implementation,
                ArtifactType::SecurityReview,
                ArtifactType::QaReport,
                ArtifactType::PlatformReview,
                ArtifactType::Documentation,
                ArtifactType::Review,
            ],
            ArtifactType::CtoDecision,
            vec![
                WorkflowPermission::WorkspaceRead,
                WorkflowPermission::ArtifactCreate,
            ],
        ),
        _ => return None,
    };
    Some(WorkflowRoleContract {
        role_id: if role_id == "productowner" {
            "product-owner".into()
        } else {
            role_id.into()
        },
        name: match role_id {
            "product-owner" | "productowner" => "Product Owner",
            "researcher" => "Researcher",
            "architect" => "Architect",
            "engineer" => "Engineer",
            "security" => "Security",
            "qa" => "QA",
            "platform" => "Platform",
            "writer" => "Writer",
            "reviewer" => "Reviewer",
            "cto" => "CTO",
            _ => unreachable!(),
        }
        .into(),
        version: 1,
        capability,
        inputs,
        output,
        permissions,
    })
}

/// Return every built-in role contract in stable catalog order.
#[must_use]
pub fn builtin_roles() -> Vec<WorkflowRoleContract> {
    [
        "product-owner",
        "researcher",
        "architect",
        "engineer",
        "security",
        "qa",
        "platform",
        "writer",
        "reviewer",
        "cto",
    ]
    .into_iter()
    .filter_map(builtin_role)
    .collect()
}

/// One task in a custom workflow definition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowTaskDefinition {
    /// Stable task slug.
    pub id: String,
    /// Explicit immutable role identifier.
    pub role_id: String,
    /// Explicit immutable role version; latest is never inferred.
    pub role_version: u32,
    /// Predecessor task identifiers.
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// Declared artifact inputs; omitted means use pinned role contract inputs.
    #[serde(default)]
    pub input_contract: Option<Vec<ArtifactType>>,
    /// Declared artifact output; absent means use the pinned role output.
    pub output_artifact_type: Option<ArtifactType>,
}

/// Versioned user-authored custom workflow definition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CustomWorkflowDefinition {
    /// Stable workflow slug.
    pub workflow_id: String,
    /// Positive immutable workflow version.
    pub version: u32,
    /// Display name.
    pub name: String,
    /// Description shown to users.
    pub description: String,
    /// Artifact types accepted by the workflow.
    pub input_contract: Vec<ArtifactType>,
    /// Ordered task definitions.
    pub tasks: Vec<WorkflowTaskDefinition>,
}

/// Task snapshot included in the immutable compiled plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompiledWorkflowTask {
    /// Stable task identifier.
    pub task_id: String,
    /// Pinned role identifier.
    pub role_id: String,
    /// Pinned role version.
    pub role_version: u32,
    /// Pinned role display name (role identifier in the built-in catalog).
    pub role_name: String,
    /// Accepted artifact inputs.
    pub input_contract: Vec<ArtifactType>,
    /// Produced artifact type.
    pub output_artifact_type: ArtifactType,
    /// Predecessor task identifiers.
    pub depends_on: Vec<String>,
    /// Execution mode marker copied from the Node workflow plan contract.
    pub execution_mode: String,
    /// Whether execution is deterministic. Host-conversation roles are not.
    pub deterministic: bool,
}

/// Immutable content-addressed workflow plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompiledWorkflowPlan {
    /// Plan schema version.
    schema_version: u32,
    /// Workflow identity.
    workflow_id: String,
    /// Pinned workflow version.
    workflow_version: u32,
    /// Workflow display name.
    name: String,
    /// Workflow input contract.
    input_contract: Vec<ArtifactType>,
    /// Task snapshots in definition order, matching Node preview output.
    tasks: Vec<CompiledWorkflowTask>,
    /// Stable topological execution order.
    execution_order: Vec<String>,
    /// SHA-256 of canonical immutable plan content.
    plan_hash: String,
}

impl CompiledWorkflowPlan {
    /// Plan schema version.
    #[must_use]
    pub const fn schema_version(&self) -> u32 {
        self.schema_version
    }

    /// Workflow identity.
    #[must_use]
    pub fn workflow_id(&self) -> &str {
        &self.workflow_id
    }

    /// Pinned workflow version.
    #[must_use]
    pub const fn workflow_version(&self) -> u32 {
        self.workflow_version
    }

    /// Workflow display name.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Workflow input contract.
    #[must_use]
    pub fn input_contract(&self) -> &[ArtifactType] {
        &self.input_contract
    }

    /// Immutable task snapshots.
    #[must_use]
    pub fn tasks(&self) -> &[CompiledWorkflowTask] {
        &self.tasks
    }

    /// Stable topological execution order.
    #[must_use]
    pub fn execution_order(&self) -> &[String] {
        &self.execution_order
    }

    /// SHA-256 of canonical immutable plan content.
    #[must_use]
    pub fn plan_hash(&self) -> &str {
        &self.plan_hash
    }

    /// Recompute and compare the digest over immutable plan content.
    pub fn verify_digest(&self) -> Result<(), WorkflowCompileError> {
        let outputs: BTreeMap<&str, ArtifactType> = self
            .tasks
            .iter()
            .map(|task| (task.task_id.as_str(), task.output_artifact_type))
            .collect();
        let order = compile_dag(&self.tasks)?;
        if order != self.execution_order {
            return Err(WorkflowCompileError::PlanDigestMismatch);
        }
        for task in &self.tasks {
            for dependency in &task.depends_on {
                let output = outputs.get(dependency.as_str()).copied().ok_or_else(|| {
                    WorkflowCompileError::UnknownDependency(
                        task.task_id.clone(),
                        dependency.clone(),
                    )
                })?;
                if !task.input_contract.contains(&output) {
                    return Err(WorkflowCompileError::MissingPredecessorInput(
                        task.task_id.clone(),
                        dependency.clone(),
                        output,
                    ));
                }
            }
        }
        let canonical = canonical_plan_content(self)?;
        let digest = sha256(canonical.as_bytes());
        if digest != self.plan_hash {
            return Err(WorkflowCompileError::PlanDigestMismatch);
        }
        Ok(())
    }

    /// Return canonical JSON for the immutable digest-bearing plan content.
    pub fn canonical_content(&self) -> Result<String, WorkflowCompileError> {
        canonical_plan_content(self)
    }
}

/// Compile a workflow against explicit role contracts.
///
/// Built-in roles are resolved from [`builtin_role`]. Every non-built-in role
/// must be supplied in `custom_roles` with an explicit version. No role prompt,
/// permission, or tool selection is inferred from caller data.
pub fn compile_workflow(
    definition: &CustomWorkflowDefinition,
    custom_roles: &[WorkflowRoleContract],
) -> Result<CompiledWorkflowPlan, WorkflowCompileError> {
    validate_slug(&definition.workflow_id, "workflow_id", 80)?;
    if definition.version == 0 {
        return Err(WorkflowCompileError::InvalidWorkflowVersion);
    }
    validate_text(&definition.name, "name", 120)?;
    validate_text(&definition.description, "description", 2_000)?;
    validate_unique(
        &definition.input_contract,
        "workflow input_contract",
        &definition.workflow_id,
    )?;
    if definition.input_contract.is_empty() || definition.input_contract.len() > 32 {
        return Err(WorkflowCompileError::WorkflowInputCount);
    }
    if definition.tasks.is_empty() || definition.tasks.len() > 32 {
        return Err(WorkflowCompileError::TaskCount(definition.tasks.len()));
    }

    let mut role_map = BTreeMap::new();
    for role in custom_roles {
        role.validate()?;
        if builtin_role(&role.role_id).is_some() {
            return Err(WorkflowCompileError::CustomRoleShadowsBuiltin(
                role.role_id.clone(),
            ));
        }
        if role.role_id.starts_with("system-") {
            return Err(WorkflowCompileError::ReservedCustomRole(
                role.role_id.clone(),
            ));
        }
        if role.permissions.iter().any(|permission| {
            !matches!(
                permission,
                WorkflowPermission::WorkspaceRead | WorkflowPermission::ArtifactCreate
            )
        }) || !role
            .permissions
            .contains(&WorkflowPermission::ArtifactCreate)
        {
            return Err(WorkflowCompileError::CustomRolePermissionNotAllowed(
                role.role_id.clone(),
            ));
        }
        if role.output == ArtifactType::JobRequest {
            return Err(WorkflowCompileError::InvalidRoleOutput(
                role.role_id.clone(),
            ));
        }
        if role_map
            .insert((role.role_id.as_str(), role.version), role)
            .is_some()
        {
            return Err(WorkflowCompileError::DuplicateRoleVersion(
                role.role_id.clone(),
                role.version,
            ));
        }
    }

    let mut task_ids = BTreeSet::new();
    let mut compiled_tasks = Vec::with_capacity(definition.tasks.len());
    let mut task_outputs = BTreeMap::new();
    for task in &definition.tasks {
        validate_slug(&task.id, "task id", 80)?;
        validate_slug(&task.role_id, "role_id", 80)?;
        if !task_ids.insert(task.id.as_str()) {
            return Err(WorkflowCompileError::DuplicateTask(task.id.clone()));
        }
        let builtin = builtin_role(&task.role_id);
        let role = builtin
            .as_ref()
            .or_else(|| {
                role_map
                    .get(&(task.role_id.as_str(), task.role_version))
                    .copied()
            })
            .ok_or_else(|| {
                WorkflowCompileError::UnknownRoleVersion(task.role_id.clone(), task.role_version)
            })?;
        if role.version != task.role_version {
            return Err(WorkflowCompileError::UnknownRoleVersion(
                task.role_id.clone(),
                task.role_version,
            ));
        }
        role.validate()?;
        let inputs = task
            .input_contract
            .clone()
            .unwrap_or_else(|| role.inputs.clone());
        validate_unique(&inputs, "task input_contract", &task.id)?;
        if inputs.is_empty() || inputs.len() > 32 {
            return Err(WorkflowCompileError::TaskInputCount(task.id.clone()));
        }
        if let Some(input) = inputs.iter().find(|input| !role.inputs.contains(input)) {
            return Err(WorkflowCompileError::UnsupportedRoleInput(
                task.id.clone(),
                role.role_id.clone(),
                *input,
            ));
        }
        let output = task.output_artifact_type.unwrap_or(role.output);
        if output != role.output {
            return Err(WorkflowCompileError::RoleOutputMismatch(
                task.id.clone(),
                role.role_id.clone(),
                output,
                role.output,
            ));
        }
        validate_unique(&task.depends_on, "task depends_on", &task.id)?;
        if task.depends_on.len() > 32 {
            return Err(WorkflowCompileError::DependencyCount(task.id.clone()));
        }
        task_outputs.insert(task.id.as_str(), output);
        compiled_tasks.push(CompiledWorkflowTask {
            task_id: task.id.clone(),
            role_id: role.role_id.clone(),
            role_version: role.version,
            role_name: role.name.clone(),
            input_contract: inputs,
            output_artifact_type: output,
            depends_on: task.depends_on.clone(),
            execution_mode: "host-conversation".into(),
            deterministic: false,
        });
    }

    let execution_order = compile_dag(&compiled_tasks)?;
    for task in &compiled_tasks {
        for dependency in &task.depends_on {
            let output = task_outputs
                .get(dependency.as_str())
                .copied()
                .ok_or_else(|| {
                    WorkflowCompileError::UnknownDependency(
                        task.task_id.clone(),
                        dependency.clone(),
                    )
                })?;
            if !task.input_contract.contains(&output) {
                return Err(WorkflowCompileError::MissingPredecessorInput(
                    task.task_id.clone(),
                    dependency.clone(),
                    output,
                ));
            }
        }
    }

    let mut plan = CompiledWorkflowPlan {
        schema_version: 1,
        workflow_id: definition.workflow_id.clone(),
        workflow_version: definition.version,
        name: definition.name.clone(),
        input_contract: definition.input_contract.clone(),
        tasks: compiled_tasks,
        execution_order,
        plan_hash: String::new(),
    };
    plan.plan_hash = sha256(canonical_plan_content(&plan)?.as_bytes());
    Ok(plan)
}

fn compile_dag(tasks: &[CompiledWorkflowTask]) -> Result<Vec<String>, WorkflowCompileError> {
    let mut indexes = BTreeMap::new();
    for (index, task) in tasks.iter().enumerate() {
        if indexes.insert(task.task_id.as_str(), index).is_some() {
            return Err(WorkflowCompileError::DuplicateTask(task.task_id.clone()));
        }
    }
    let mut indegree = vec![0_usize; tasks.len()];
    let mut outgoing = vec![Vec::new(); tasks.len()];
    for (index, task) in tasks.iter().enumerate() {
        for dependency in &task.depends_on {
            if task
                .depends_on
                .iter()
                .filter(|item| *item == dependency)
                .count()
                > 1
            {
                return Err(WorkflowCompileError::DuplicateListValue(
                    "task depends_on",
                    task.task_id.clone(),
                ));
            }
            if dependency == &task.task_id {
                return Err(WorkflowCompileError::SelfDependency(task.task_id.clone()));
            }
            let Some(&dependency_index) = indexes.get(dependency.as_str()) else {
                return Err(WorkflowCompileError::UnknownDependency(
                    task.task_id.clone(),
                    dependency.clone(),
                ));
            };
            indegree[index] += 1;
            outgoing[dependency_index].push(index);
        }
    }
    let mut ready = VecDeque::new();
    for (index, degree) in indegree.iter().enumerate() {
        if *degree == 0 {
            ready.push_back(index);
        }
    }
    let mut order = Vec::with_capacity(tasks.len());
    while let Some(index) = ready.pop_front() {
        order.push(tasks[index].task_id.clone());
        for &dependent in &outgoing[index] {
            indegree[dependent] -= 1;
            if indegree[dependent] == 0 {
                ready.push_back(dependent);
            }
        }
    }
    if order.len() != tasks.len() {
        return Err(WorkflowCompileError::DependencyCycle);
    }
    Ok(order)
}

fn canonical_plan_content(plan: &CompiledWorkflowPlan) -> Result<String, WorkflowCompileError> {
    #[derive(Serialize)]
    struct DigestContent<'a> {
        schema_version: u32,
        workflow_id: &'a str,
        workflow_version: u32,
        name: &'a str,
        input_contract: &'a [ArtifactType],
        tasks: &'a [CompiledWorkflowTask],
    }
    serde_json::to_string(&DigestContent {
        schema_version: plan.schema_version,
        workflow_id: &plan.workflow_id,
        workflow_version: plan.workflow_version,
        name: &plan.name,
        input_contract: &plan.input_contract,
        tasks: &plan.tasks,
    })
    .map_err(|_| WorkflowCompileError::CanonicalJson)
}

fn sha256(value: &[u8]) -> String {
    let digest = Sha256::digest(value);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn validate_text(value: &str, field: &'static str, max: usize) -> Result<(), WorkflowCompileError> {
    if value.trim().is_empty() {
        return Err(WorkflowCompileError::EmptyField(field));
    }
    if value.len() > max {
        return Err(WorkflowCompileError::FieldTooLong(field, max));
    }
    Ok(())
}

fn validate_slug(value: &str, field: &'static str, max: usize) -> Result<(), WorkflowCompileError> {
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
        Err(WorkflowCompileError::InvalidSlug(field, value.into()))
    }
}

fn validate_unique<T: Ord>(
    items: &[T],
    field: &'static str,
    owner: &str,
) -> Result<(), WorkflowCompileError> {
    let mut unique = BTreeSet::new();
    for item in items {
        if !unique.insert(item) {
            return Err(WorkflowCompileError::DuplicateListValue(
                field,
                owner.into(),
            ));
        }
    }
    Ok(())
}

/// Workflow compilation and validation failures.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum WorkflowCompileError {
    /// Required text field was empty.
    #[error("{0} must be a non-empty string")]
    EmptyField(&'static str),
    /// Text field exceeded its byte bound.
    #[error("{0} exceeds {1} bytes")]
    FieldTooLong(&'static str, usize),
    /// Identifier did not match the lowercase slug grammar.
    #[error("{0} is not a valid lowercase slug: {1}")]
    InvalidSlug(&'static str, String),
    /// Workflow version must be positive.
    #[error("workflow version must be positive")]
    InvalidWorkflowVersion,
    /// Role version must be positive.
    #[error("role version must be positive: {0}")]
    InvalidRoleVersion(String),
    /// Role contract contains too many or too few fields.
    #[error("role contract field count is invalid: {0}")]
    RoleFieldCount(String),
    /// Workflow input contract has invalid size.
    #[error("workflow input_contract must contain 1-32 entries")]
    WorkflowInputCount,
    /// Workflow contains an invalid number of tasks.
    #[error("tasks must contain 1-32 entries, got {0}")]
    TaskCount(usize),
    /// Task input contract has invalid size.
    #[error("task input_contract must contain 1-32 entries: {0}")]
    TaskInputCount(String),
    /// Task dependency list exceeds bound.
    #[error("task depends_on exceeds 32 entries: {0}")]
    DependencyCount(String),
    /// Duplicate values in a contract list.
    #[error("{0} contains duplicate values: {1}")]
    DuplicateListValue(&'static str, String),
    /// Duplicate task identifier.
    #[error("duplicate task id: {0}")]
    DuplicateTask(String),
    /// Duplicate custom role version.
    #[error("duplicate custom role version: {0}@{1}")]
    DuplicateRoleVersion(String, u32),
    /// A custom role attempted to shadow a built-in role.
    #[error("custom role cannot shadow built-in role: {0}")]
    CustomRoleShadowsBuiltin(String),
    /// Custom roles are limited to read and artifact creation permissions.
    #[error("custom role permissions exceed the workflow catalog allowlist: {0}")]
    CustomRolePermissionNotAllowed(String),
    /// Custom role identifier uses a reserved system namespace.
    #[error("custom role identifier is reserved: {0}")]
    ReservedCustomRole(String),
    /// A role cannot produce the original job request input artifact.
    #[error("role cannot produce job.request: {0}")]
    InvalidRoleOutput(String),
    /// Role identifier/version pair was not supplied by the catalog.
    #[error("unknown role version: {0}@{1}")]
    UnknownRoleVersion(String, u32),
    /// Task requested input unsupported by pinned role.
    #[error("task {0} input {2:?} is not supported by role {1}")]
    UnsupportedRoleInput(String, String, ArtifactType),
    /// Task output differs from pinned role output.
    #[error("task {0} output {2:?} does not match role {1} output {3:?}")]
    RoleOutputMismatch(String, String, ArtifactType, ArtifactType),
    /// Task depends on itself.
    #[error("task depends on itself: {0}")]
    SelfDependency(String),
    /// Task references an unknown predecessor.
    #[error("task {0} depends on unknown task: {1}")]
    UnknownDependency(String, String),
    /// Predecessor output is absent from dependent task input contract.
    #[error("task {0} input_contract must include {2:?} from predecessor {1}")]
    MissingPredecessorInput(String, String, ArtifactType),
    /// Dependency graph contains a cycle.
    #[error("dependency cycle detected")]
    DependencyCycle,
    /// Canonical JSON serialization failed.
    #[error("canonical JSON serialization failed")]
    CanonicalJson,
    /// Immutable plan content no longer matches its digest.
    #[error("workflow plan digest verification failed")]
    PlanDigestMismatch,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, role_id: &str, depends_on: &[&str]) -> WorkflowTaskDefinition {
        let role = builtin_role(role_id).expect("built-in role");
        WorkflowTaskDefinition {
            id: id.into(),
            role_id: role_id.into(),
            role_version: role.version,
            depends_on: depends_on.iter().map(|value| (*value).into()).collect(),
            input_contract: Some(role.inputs),
            output_artifact_type: Some(role.output),
        }
    }

    fn definition(tasks: Vec<WorkflowTaskDefinition>) -> CustomWorkflowDefinition {
        CustomWorkflowDefinition {
            workflow_id: "sample-flow".into(),
            version: 3,
            name: "Sample flow".into(),
            description: "A deterministic compiler fixture".into(),
            input_contract: vec![ArtifactType::JobRequest],
            tasks,
        }
    }

    #[test]
    fn builtin_catalog_matches_node_role_contracts() {
        let owner = builtin_role("productowner").expect("legacy alias");
        assert_eq!(owner.role_id, "product-owner");
        assert_eq!(owner.output, ArtifactType::Requirements);
        assert_eq!(
            builtin_role("researcher").unwrap().inputs,
            vec![ArtifactType::Requirements]
        );
        assert_eq!(
            builtin_role("architect").unwrap().inputs,
            vec![ArtifactType::Requirements, ArtifactType::Research]
        );
        assert_eq!(
            builtin_role("engineer").unwrap().output,
            ArtifactType::Implementation
        );
        assert_eq!(
            builtin_role("cto").unwrap().output,
            ArtifactType::CtoDecision
        );
        assert!(builtin_role("unknown").is_none());
        assert_eq!(builtin_roles().len(), 10);
    }

    #[test]
    fn compiles_out_of_order_dag_and_pins_canonical_digest() {
        let plan = compile_workflow(
            &definition(vec![
                task("implement", "engineer", &["design"]),
                task("design", "architect", &["research"]),
                task("research", "researcher", &["requirements"]),
                task("requirements", "product-owner", &[]),
            ]),
            &[],
        )
        .expect("valid workflow");
        assert_eq!(
            plan.execution_order(),
            ["requirements", "research", "design", "implement"]
        );
        assert_eq!(plan.plan_hash().len(), 64);
        plan.verify_digest().expect("digest matches");
        assert!(
            plan.canonical_content()
                .unwrap()
                .contains("\"workflow_id\":\"sample-flow\"")
        );
    }

    #[test]
    fn plan_digest_matches_node_preview_golden_vector() {
        let plan = compile_workflow(
            &definition(vec![task("requirements", "product-owner", &[])]),
            &[],
        )
        .unwrap();
        assert_eq!(
            plan.canonical_content().unwrap(),
            "{\"schema_version\":1,\"workflow_id\":\"sample-flow\",\"workflow_version\":3,\"name\":\"Sample flow\",\"input_contract\":[\"job.request\"],\"tasks\":[{\"task_id\":\"requirements\",\"role_id\":\"product-owner\",\"role_version\":1,\"role_name\":\"Product Owner\",\"input_contract\":[\"job.request\"],\"output_artifact_type\":\"requirements\",\"depends_on\":[],\"execution_mode\":\"host-conversation\",\"deterministic\":false}]}"
        );
        assert_eq!(
            plan.plan_hash,
            "f016c8000371df04212a251a651a0f149df10b85b2d94e4d0296e82bbb62a39a"
        );
    }

    #[test]
    fn rejects_unknown_dependencies_and_missing_predecessor_inputs() {
        let error = compile_workflow(
            &definition(vec![task("design", "architect", &["missing"])]),
            &[],
        )
        .unwrap_err();
        assert_eq!(
            error,
            WorkflowCompileError::UnknownDependency("design".into(), "missing".into())
        );

        let mut engineer = task("implement", "engineer", &["design"]);
        engineer.input_contract = Some(vec![ArtifactType::Requirements]);
        let error = compile_workflow(
            &definition(vec![task("design", "architect", &[]), engineer]),
            &[],
        )
        .unwrap_err();
        assert_eq!(
            error,
            WorkflowCompileError::MissingPredecessorInput(
                "implement".into(),
                "design".into(),
                ArtifactType::Architecture
            )
        );
    }

    #[test]
    fn rejects_cycles_duplicate_edges_and_role_contract_mismatches() {
        let error = compile_workflow(
            &definition(vec![
                task("a", "architect", &["b"]),
                task("b", "architect", &["a"]),
            ]),
            &[],
        )
        .unwrap_err();
        assert_eq!(error, WorkflowCompileError::DependencyCycle);

        let mut duplicate = task("a", "architect", &[]);
        duplicate.depends_on = vec!["x".into(), "x".into()];
        let error = compile_workflow(&definition(vec![duplicate]), &[]).unwrap_err();
        assert_eq!(
            error,
            WorkflowCompileError::DuplicateListValue("task depends_on", "a".into())
        );

        let mut mismatch = task("a", "engineer", &[]);
        mismatch.output_artifact_type = Some(ArtifactType::Documentation);
        let error = compile_workflow(&definition(vec![mismatch]), &[]).unwrap_err();
        assert!(matches!(
            error,
            WorkflowCompileError::RoleOutputMismatch(..)
        ));
    }

    #[test]
    fn custom_role_requires_exact_version_and_cannot_shadow_builtin() {
        let role = WorkflowRoleContract {
            role_id: "custom-researcher".into(),
            name: "Custom Researcher".into(),
            version: 2,
            capability: WorkflowCapability::ResearchCollect,
            inputs: vec![ArtifactType::Requirements],
            output: ArtifactType::Research,
            permissions: vec![
                WorkflowPermission::WorkspaceRead,
                WorkflowPermission::ArtifactCreate,
            ],
        };
        let mut custom_task = task("collect", "researcher", &["requirements"]);
        custom_task.role_id = "custom-researcher".into();
        custom_task.role_version = 2;
        let plan = compile_workflow(
            &definition(vec![
                task("requirements", "product-owner", &[]),
                custom_task,
            ]),
            std::slice::from_ref(&role),
        )
        .unwrap();
        assert_eq!(plan.tasks()[1].role_version, 2);

        let mut elevated = role.clone();
        elevated
            .permissions
            .push(WorkflowPermission::WorkspaceWrite);
        let mut elevated_task = task("collect", "researcher", &[]);
        elevated_task.role_id = "custom-researcher".into();
        elevated_task.role_version = 2;
        assert_eq!(
            compile_workflow(&definition(vec![elevated_task]), &[elevated]).unwrap_err(),
            WorkflowCompileError::CustomRolePermissionNotAllowed("custom-researcher".into())
        );

        let mut wrong_pin = task("collect", "researcher", &[]);
        wrong_pin.role_id = "custom-researcher".into();
        wrong_pin.role_version = 1;
        assert_eq!(
            compile_workflow(&definition(vec![wrong_pin]), std::slice::from_ref(&role))
                .unwrap_err(),
            WorkflowCompileError::UnknownRoleVersion("custom-researcher".into(), 1)
        );

        let mut shadow = role;
        shadow.role_id = "engineer".into();
        assert_eq!(
            compile_workflow(&definition(vec![task("build", "engineer", &[])]), &[shadow])
                .unwrap_err(),
            WorkflowCompileError::CustomRoleShadowsBuiltin("engineer".into())
        );
    }

    #[test]
    fn digest_detects_mutated_plan_snapshot() {
        let plan = compile_workflow(
            &definition(vec![task("requirements", "product-owner", &[])]),
            &[],
        )
        .unwrap();
        let mut encoded = serde_json::to_value(&plan).unwrap();
        encoded["name"] = serde_json::Value::String("tampered".into());
        let tampered: CompiledWorkflowPlan = serde_json::from_value(encoded).unwrap();
        assert_eq!(
            tampered.verify_digest().unwrap_err(),
            WorkflowCompileError::PlanDigestMismatch
        );
    }
}
