//! Versioned, immutable workflow-plan contract for Workstream 1.
//!
//! The legacy Node-compatible compiler remains available through
//! [`crate::custom_workflow`]. This module adds a V1 envelope that binds the
//! exact trusted-skill bundle digests supplied by a read-only resolver. It does
//! not load skills, decide trust, sign approvals, persist catalog records, or
//! authorize execution.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::custom_workflow::{CustomRoleDefinition, CustomWorkflowError, validate_custom_role};
use crate::node_plan_canonical_json::{NodePlanCanonicalJsonError, canonicalize_node_plan_json};
use crate::workflow::{
    CompiledWorkflowPlan, CustomWorkflowDefinition, WorkflowCapability, WorkflowCompileError,
    WorkflowRoleContract, builtin_role, compile_workflow,
};
use crate::workflow_policy_v1::{WorkflowPolicyCompositionV1, WorkflowPolicyV1Error};

/// Version-1 workflow definition accepted by the typed compiler.
pub type WorkflowDefinitionV1 = CustomWorkflowDefinition;

/// Version-1 custom-role definition accepted by the typed compiler. Built-in
/// role versions are resolved from the immutable [`crate::workflow::builtin_roles`]
/// catalog and do not require caller-supplied role records.
pub type RoleDefinitionV1 = CustomRoleDefinition;

/// Read-only, already-resolved skill content metadata provided by the trusted
/// skill authority boundary. `bundle_sha256` follows Node's `agent-skills.js`
/// `bundleSkill` digest over its sorted `{path, sha256, size_bytes}` manifest.
///
/// This value is not itself a trust receipt. Production implementations must
/// return it only after the Workstream 6 resolver has accepted the exact skill.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResolvedSkillContentV1 {
    /// Canonical skill identifier.
    pub skill_id: String,
    /// Exact Node-compatible skill bundle digest.
    pub bundle_sha256: String,
}

/// Read-only port for Workstream 6 trusted-skill resolution.
///
/// Implementations must not fetch source paths, mutate trust state, or mint
/// trust. Returning `None` means the skill is unavailable or not trusted; the
/// compiler fails closed. The test implementation is deliberately in-memory.
pub trait ReadOnlyTrustedSkillResolver {
    /// Resolve one canonical skill ID to its already-validated content digest.
    fn resolve_trusted_skill(&self, skill_id: &str) -> Option<ResolvedSkillContentV1>;
}

/// A role-version-bound skill content pin embedded in `CompiledPlanV1`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SkillPinRefV1 {
    /// Role whose immutable version references this skill.
    pub role_id: String,
    /// Exact immutable role version.
    pub role_version: u32,
    /// Canonical skill identifier.
    pub skill_id: String,
    /// Exact Node-compatible skill bundle digest.
    pub bundle_sha256: String,
}

/// Exact workflow definition version and content fingerprint embedded in a
/// compiled plan. This also binds metadata omitted from the legacy inner plan,
/// such as the workflow description.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowDefinitionPinV1 {
    /// Canonical workflow identifier.
    pub workflow_id: String,
    /// Exact immutable workflow version.
    pub workflow_version: u32,
    /// SHA-256 of the complete Node-canonicalized workflow definition.
    pub definition_sha256: String,
}

/// Exact built-in/custom role version and full definition fingerprint.
///
/// This pin covers role metadata not copied into the legacy task snapshot,
/// including the custom role prompt, capability set, permissions and tools.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleDefinitionPinV1 {
    /// Canonical role identifier referenced by the task DAG.
    pub role_id: String,
    /// Exact immutable role version.
    pub role_version: u32,
    /// SHA-256 of the complete Node-canonicalized built-in/custom role record.
    pub definition_sha256: String,
}

/// Algorithm and value for the outer immutable plan envelope digest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanDigestV1 {
    /// Digest algorithm. V1 currently permits only `sha256`.
    pub algorithm: String,
    /// Lowercase hexadecimal digest over canonical `CompiledPlanV1` content.
    pub value: String,
}

/// Immutable workflow plan plus definition, skill and optional policy pins.
///
/// The inner [`CompiledWorkflowPlan`] digest preserves Node custom-workflow
/// compiler compatibility. The outer `PlanDigestV1` binds that canonical plan
/// object together with complete workflow/role fingerprints, role-version-bound
/// skill pins, and optional workflow-local policy composition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompiledPlanV1 {
    schema_version: u32,
    workflow_plan: CompiledWorkflowPlan,
    workflow_definition_pin: WorkflowDefinitionPinV1,
    role_definition_pins: Vec<RoleDefinitionPinV1>,
    skill_pins: Vec<SkillPinRefV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    policy_composition: Option<WorkflowPolicyCompositionV1>,
    plan_digest: PlanDigestV1,
}

impl CompiledPlanV1 {
    /// Contract schema version.
    #[must_use]
    pub const fn schema_version(&self) -> u32 {
        self.schema_version
    }

    /// Inner typed workflow plan, including pinned workflow and role versions.
    #[must_use]
    pub const fn workflow_plan(&self) -> &CompiledWorkflowPlan {
        &self.workflow_plan
    }

    /// Exact workflow definition identity and content fingerprint.
    #[must_use]
    pub const fn workflow_definition_pin(&self) -> &WorkflowDefinitionPinV1 {
        &self.workflow_definition_pin
    }

    /// Complete role definition fingerprints, sorted by role ID and version.
    #[must_use]
    pub fn role_definition_pins(&self) -> &[RoleDefinitionPinV1] {
        &self.role_definition_pins
    }

    /// Skill pins sorted by role ID, role version, and skill ID.
    #[must_use]
    pub fn skill_pins(&self) -> &[SkillPinRefV1] {
        &self.skill_pins
    }

    /// Optional immutable workflow-local policy/success-contract composition.
    #[must_use]
    pub const fn policy_composition(&self) -> Option<&WorkflowPolicyCompositionV1> {
        self.policy_composition.as_ref()
    }

    /// Return a new immutable plan with a validated policy composition attached.
    ///
    /// This does not persist or attach a policy to a live workflow instance.
    /// It validates the exact composition against this plan and recomputes the
    /// outer content digest, leaving the inner Node-compatible plan unchanged.
    pub fn with_policy_composition(
        mut self,
        composition: WorkflowPolicyCompositionV1,
    ) -> Result<Self, CompiledPlanV1Error> {
        composition.verify_for_plan(&self.workflow_plan)?;
        self.policy_composition = Some(composition);
        self.plan_digest.value = sha256(self.canonical_content()?.as_bytes());
        self.verify_digest()?;
        Ok(self)
    }

    /// Outer content digest for the complete V1 envelope.
    #[must_use]
    pub const fn plan_digest(&self) -> &PlanDigestV1 {
        &self.plan_digest
    }

    /// Canonical JSON bytes hashed by `PlanDigestV1`.
    pub fn canonical_content(&self) -> Result<String, CompiledPlanV1Error> {
        let workflow_plan: Value = serde_json::from_str(
            &self
                .workflow_plan
                .canonical_content()
                .map_err(|error| CompiledPlanV1Error::CanonicalSerialization(error.to_string()))?,
        )
        .map_err(|error| CompiledPlanV1Error::CanonicalSerialization(error.to_string()))?;
        let mut content = json!({
            "schema_version": self.schema_version,
            "workflow_plan": workflow_plan,
            "workflow_definition_pin": self.workflow_definition_pin,
            "role_definition_pins": self.role_definition_pins,
            "skill_pins": self.skill_pins,
        });
        if let Some(policy_composition) = &self.policy_composition {
            content["policy_composition"] = serde_json::to_value(policy_composition)
                .map_err(|error| CompiledPlanV1Error::CanonicalSerialization(error.to_string()))?;
        }
        canonicalize_node_plan_json(&content).map_err(CompiledPlanV1Error::Canonicalization)
    }

    /// Validate inner DAG/digest, role-bound skill pins, and outer digest.
    pub fn verify_digest(&self) -> Result<(), CompiledPlanV1Error> {
        if self.schema_version != 1 {
            return Err(CompiledPlanV1Error::UnsupportedSchemaVersion(
                self.schema_version,
            ));
        }
        if self.plan_digest.algorithm != "sha256" {
            return Err(CompiledPlanV1Error::UnsupportedDigestAlgorithm(
                self.plan_digest.algorithm.clone(),
            ));
        }
        self.workflow_plan
            .verify_digest()
            .map_err(|_| CompiledPlanV1Error::InnerPlanDigestMismatch)?;
        validate_workflow_definition_pin(&self.workflow_plan, &self.workflow_definition_pin)?;
        validate_role_definition_pins(&self.workflow_plan, &self.role_definition_pins)?;
        validate_skill_pins(&self.workflow_plan, &self.skill_pins)?;
        if let Some(policy_composition) = &self.policy_composition {
            policy_composition.verify_for_plan(&self.workflow_plan)?;
        }
        let expected = sha256(self.canonical_content()?.as_bytes());
        if expected != self.plan_digest.value {
            return Err(CompiledPlanV1Error::PlanDigestMismatch);
        }
        Ok(())
    }
}

/// Compile built-in and custom exact role versions, and content-pin every
/// referenced skill from a custom role.
///
/// Built-in roles resolve from the static domain catalog. The resolver is
/// invoked once per unique skill ID in the referenced custom role versions.
/// Only referenced custom roles enter compilation. No latest-version lookup,
/// filesystem/network access, trust mutation, or approval decision occurs here.
pub fn compile_workflow_v1<R: ReadOnlyTrustedSkillResolver + ?Sized>(
    definition: &WorkflowDefinitionV1,
    roles: &[RoleDefinitionV1],
    resolver: &R,
) -> Result<CompiledPlanV1, CompiledPlanV1Error> {
    let referenced_roles: BTreeSet<(&str, u32)> = definition
        .tasks
        .iter()
        .filter(|task| builtin_role(&task.role_id).is_none())
        .map(|task| (task.role_id.as_str(), task.role_version))
        .collect();
    let selected_roles: Vec<RoleDefinitionV1> = roles
        .iter()
        .filter(|role| referenced_roles.contains(&(role.role_id.as_str(), role.version)))
        .cloned()
        .collect();

    let skill_ids: BTreeSet<String> = selected_roles
        .iter()
        .flat_map(|role| role.skills.iter().cloned())
        .collect();
    let mut resolved_skills = BTreeMap::new();
    for skill_id in skill_ids {
        validate_skill_id(&skill_id)?;
        let resolution = resolver
            .resolve_trusted_skill(&skill_id)
            .ok_or_else(|| CompiledPlanV1Error::TrustedSkillUnavailable(skill_id.clone()))?;
        if resolution.skill_id != skill_id {
            return Err(CompiledPlanV1Error::SkillResolutionIdentityMismatch {
                requested: skill_id,
                resolved: resolution.skill_id,
            });
        }
        validate_sha256(&resolution.bundle_sha256, &resolution.skill_id)?;
        resolved_skills.insert(resolution.skill_id.clone(), resolution);
    }

    let available_skill_ids = resolved_skills.keys().cloned().collect::<BTreeSet<_>>();
    let mut role_contracts = Vec::with_capacity(selected_roles.len());
    for role in &selected_roles {
        validate_custom_role(role, &available_skill_ids)?;
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
    if !selected_roles.is_empty()
        && ["engineering", "standard-engineering", "production"]
            .contains(&definition.workflow_id.as_str())
    {
        return Err(CustomWorkflowError::ReservedWorkflow(definition.workflow_id.clone()).into());
    }
    let workflow_plan = compile_workflow(definition, &role_contracts)?;

    let workflow_definition_pin = WorkflowDefinitionPinV1 {
        workflow_id: definition.workflow_id.clone(),
        workflow_version: definition.version,
        definition_sha256: canonical_json_sha256(definition)?,
    };

    let selected_roles_by_identity: BTreeMap<(&str, u32), &RoleDefinitionV1> = selected_roles
        .iter()
        .map(|role| ((role.role_id.as_str(), role.version), role))
        .collect();
    let mut role_definition_pins = Vec::new();
    for task in workflow_plan.tasks() {
        if role_definition_pins
            .iter()
            .any(|pin: &RoleDefinitionPinV1| {
                pin.role_id == task.role_id && pin.role_version == task.role_version
            })
        {
            continue;
        }
        let definition_sha256 = if let Some(role) = builtin_role(&task.role_id) {
            if role.version != task.role_version {
                return Err(WorkflowCompileError::UnknownRoleVersion(
                    task.role_id.clone(),
                    task.role_version,
                )
                .into());
            }
            canonical_json_sha256(&role)?
        } else {
            let role = selected_roles_by_identity
                .get(&(task.role_id.as_str(), task.role_version))
                .ok_or_else(|| {
                    WorkflowCompileError::UnknownRoleVersion(
                        task.role_id.clone(),
                        task.role_version,
                    )
                })?;
            canonical_json_sha256(*role)?
        };
        role_definition_pins.push(RoleDefinitionPinV1 {
            role_id: task.role_id.clone(),
            role_version: task.role_version,
            definition_sha256,
        });
    }
    role_definition_pins.sort();

    let mut skill_pins = Vec::new();
    for role in &selected_roles {
        for skill_id in &role.skills {
            let resolved = resolved_skills
                .get(skill_id)
                .expect("every referenced skill was resolved before compilation");
            skill_pins.push(SkillPinRefV1 {
                role_id: role.role_id.clone(),
                role_version: role.version,
                skill_id: skill_id.clone(),
                bundle_sha256: resolved.bundle_sha256.clone(),
            });
        }
    }
    skill_pins.sort();
    validate_skill_pins(&workflow_plan, &skill_pins)?;

    let mut compiled = CompiledPlanV1 {
        schema_version: 1,
        workflow_plan,
        workflow_definition_pin,
        role_definition_pins,
        skill_pins,
        policy_composition: None,
        plan_digest: PlanDigestV1 {
            algorithm: "sha256".into(),
            value: String::new(),
        },
    };
    compiled.plan_digest.value = sha256(compiled.canonical_content()?.as_bytes());
    compiled.verify_digest()?;
    Ok(compiled)
}

/// Stable errors for the Workstream 1 V1 compiler boundary.
#[derive(Debug, PartialEq, Error)]
pub enum CompiledPlanV1Error {
    /// Legacy typed workflow/custom-role compiler rejected its input.
    #[error(transparent)]
    CustomWorkflow(#[from] CustomWorkflowError),
    /// Typed DAG or role contract validation failed.
    #[error(transparent)]
    WorkflowCompile(#[from] WorkflowCompileError),
    /// Unsupported outer schema version.
    #[error("unsupported CompiledPlanV1 schema version: {0}")]
    UnsupportedSchemaVersion(u32),
    /// No trusted resolver result was available for an exact skill ID.
    #[error("trusted skill resolution unavailable: {0}")]
    TrustedSkillUnavailable(String),
    /// Resolver returned a result for a different skill identifier.
    #[error("trusted skill resolver identity mismatch: requested {requested}, resolved {resolved}")]
    SkillResolutionIdentityMismatch {
        /// Exact identifier requested from the resolver.
        requested: String,
        /// Identifier returned by the resolver.
        resolved: String,
    },
    /// Skill ID does not match the canonical Node skill-name grammar.
    #[error("invalid skill identifier: {0}")]
    InvalidSkillId(String),
    /// Skill bundle digest is not lowercase SHA-256 hex.
    #[error("invalid skill bundle SHA-256 digest: {0}")]
    InvalidSkillDigest(String),
    /// A pin refers to a role version not present in the compiled task DAG.
    #[error("skill pin references a role version absent from the workflow plan: {0}@{1}")]
    SkillPinRoleNotInPlan(String, u32),
    /// Workflow definition pin does not identify the exact compiled workflow.
    #[error("workflow definition pin does not match the compiled workflow identity")]
    WorkflowDefinitionIdentityMismatch,
    /// A role-definition pin references a role version absent from the task DAG.
    #[error("role definition pin references a role version absent from the workflow plan: {0}@{1}")]
    RoleDefinitionNotInPlan(String, u32),
    /// A task role version has more than one definition fingerprint.
    #[error("duplicate role definition pin: {0}@{1}")]
    DuplicateRoleDefinitionPin(String, u32),
    /// Not every referenced role version has exactly one definition fingerprint.
    #[error("role definition pins do not cover every role version in the workflow plan")]
    RoleDefinitionPinCoverageMismatch,
    /// Role definition pins are not sorted by role ID and version.
    #[error("role definition pins are not in canonical order")]
    NonCanonicalRoleDefinitionPinOrder,
    /// A role version repeats a skill pin.
    #[error("duplicate skill pin: {0}@{1}/{2}")]
    DuplicateSkillPin(String, u32, String),
    /// Pin order is not canonical.
    #[error("skill pins are not in canonical order")]
    NonCanonicalSkillPinOrder,
    /// Unsupported digest algorithm.
    #[error("unsupported plan digest algorithm: {0}")]
    UnsupportedDigestAlgorithm(String),
    /// Canonical or typed plan serialization failed.
    #[error("workflow plan canonical serialization failed: {0}")]
    CanonicalSerialization(String),
    /// Canonicalization rejected a value outside the proven Node JSON subset.
    #[error(transparent)]
    Canonicalization(#[from] NodePlanCanonicalJsonError),
    /// Workflow-local policy/success-contract composition failed validation.
    #[error(transparent)]
    PolicyComposition(#[from] WorkflowPolicyV1Error),
    /// The embedded Node-compatible immutable workflow plan is invalid.
    #[error("embedded workflow plan digest verification failed")]
    InnerPlanDigestMismatch,
    /// Outer immutable content no longer matches its digest.
    #[error("CompiledPlanV1 digest verification failed")]
    PlanDigestMismatch,
}

impl CompiledPlanV1Error {
    /// Stable Workstream 1 machine-readable error code.
    ///
    /// Display strings are diagnostic text and may change. Gateway adapters
    /// must map this code, not parse [`std::fmt::Display`] output.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::CustomWorkflow(error) => custom_workflow_error_code(error),
            Self::WorkflowCompile(error) => workflow_compile_error_code(error),
            Self::UnsupportedSchemaVersion(_) => "W1_SCHEMA_VERSION_UNSUPPORTED",
            Self::TrustedSkillUnavailable(_) => "W1_TRUSTED_SKILL_UNAVAILABLE",
            Self::SkillResolutionIdentityMismatch { .. } => "W1_SKILL_RESOLUTION_IDENTITY_MISMATCH",
            Self::InvalidSkillId(_) => "W1_SKILL_ID_INVALID",
            Self::InvalidSkillDigest(_) => "W1_SKILL_DIGEST_INVALID",
            Self::SkillPinRoleNotInPlan(_, _) => "W1_SKILL_PIN_ROLE_NOT_IN_PLAN",
            Self::WorkflowDefinitionIdentityMismatch => "W1_WORKFLOW_DEFINITION_IDENTITY_MISMATCH",
            Self::RoleDefinitionNotInPlan(_, _) => "W1_ROLE_PIN_ROLE_NOT_IN_PLAN",
            Self::DuplicateRoleDefinitionPin(_, _) => "W1_ROLE_PIN_DUPLICATE",
            Self::RoleDefinitionPinCoverageMismatch => "W1_ROLE_PIN_COVERAGE_MISMATCH",
            Self::NonCanonicalRoleDefinitionPinOrder => "W1_ROLE_PIN_ORDER_INVALID",
            Self::DuplicateSkillPin(_, _, _) => "W1_SKILL_PIN_DUPLICATE",
            Self::NonCanonicalSkillPinOrder => "W1_SKILL_PIN_ORDER_INVALID",
            Self::UnsupportedDigestAlgorithm(_) => "W1_DIGEST_ALGORITHM_UNSUPPORTED",
            Self::CanonicalSerialization(_) => "W1_CANONICAL_SERIALIZATION_FAILED",
            Self::Canonicalization(error) => node_canonical_json_error_code(error),
            Self::PolicyComposition(error) => workflow_policy_error_code(error),
            Self::InnerPlanDigestMismatch => "W1_INNER_PLAN_DIGEST_MISMATCH",
            Self::PlanDigestMismatch => "W1_PLAN_DIGEST_MISMATCH",
        }
    }
}

fn custom_workflow_error_code(error: &CustomWorkflowError) -> &'static str {
    match error {
        CustomWorkflowError::Compile(error) => workflow_compile_error_code(error),
        CustomWorkflowError::InvalidText(_) => "W1_CUSTOM_TEXT_INVALID",
        CustomWorkflowError::ReservedRole(_) => "W1_ROLE_RESERVED",
        CustomWorkflowError::ReservedWorkflow(_) => "W1_WORKFLOW_RESERVED",
        CustomWorkflowError::InvalidRoleVersion(_) => "W1_ROLE_VERSION_INVALID",
        CustomWorkflowError::FieldCount(_) => "W1_CUSTOM_ROLE_FIELD_COUNT_INVALID",
        CustomWorkflowError::InvalidOutput(_) => "W1_CUSTOM_ROLE_OUTPUT_INVALID",
        CustomWorkflowError::PermissionEscalation(_) => "W1_ROLE_PERMISSION_ESCALATION",
        CustomWorkflowError::ToolNotAllowed(_) => "W1_ROLE_TOOL_NOT_ALLOWED",
        CustomWorkflowError::SkillUnavailable(_) => "W1_SKILL_UNAVAILABLE",
        CustomWorkflowError::Duplicate(_, _) => "W1_CUSTOM_ROLE_DUPLICATE_VALUE",
        CustomWorkflowError::DuplicateRoleVersion(_, _) => "W1_ROLE_VERSION_DUPLICATE",
        CustomWorkflowError::UnknownCustomRoleVersion(_, _) => "W1_ROLE_VERSION_UNKNOWN",
    }
}

fn workflow_compile_error_code(error: &WorkflowCompileError) -> &'static str {
    match error {
        WorkflowCompileError::EmptyField(_) => "W1_FIELD_REQUIRED",
        WorkflowCompileError::FieldTooLong(_, _) => "W1_FIELD_TOO_LONG",
        WorkflowCompileError::InvalidSlug(_, _) => "W1_IDENTIFIER_INVALID",
        WorkflowCompileError::InvalidWorkflowVersion => "W1_WORKFLOW_VERSION_INVALID",
        WorkflowCompileError::InvalidRoleVersion(_) => "W1_ROLE_VERSION_INVALID",
        WorkflowCompileError::RoleFieldCount(_) => "W1_ROLE_FIELD_COUNT_INVALID",
        WorkflowCompileError::WorkflowInputCount => "W1_WORKFLOW_INPUT_COUNT_INVALID",
        WorkflowCompileError::TaskCount(_) => "W1_TASK_COUNT_INVALID",
        WorkflowCompileError::TaskInputCount(_) => "W1_TASK_INPUT_COUNT_INVALID",
        WorkflowCompileError::DependencyCount(_) => "W1_TASK_DEPENDENCY_COUNT_INVALID",
        WorkflowCompileError::DuplicateListValue(_, _) => "W1_DUPLICATE_LIST_VALUE",
        WorkflowCompileError::DuplicateTask(_) => "W1_TASK_ID_DUPLICATE",
        WorkflowCompileError::DuplicateRoleVersion(_, _) => "W1_ROLE_VERSION_DUPLICATE",
        WorkflowCompileError::CustomRoleShadowsBuiltin(_) => "W1_ROLE_BUILTIN_SHADOW",
        WorkflowCompileError::CustomRolePermissionNotAllowed(_) => "W1_ROLE_PERMISSION_ESCALATION",
        WorkflowCompileError::ReservedCustomRole(_) => "W1_ROLE_RESERVED",
        WorkflowCompileError::InvalidRoleOutput(_) => "W1_ROLE_OUTPUT_INVALID",
        WorkflowCompileError::UnknownRoleVersion(_, _) => "W1_ROLE_VERSION_UNKNOWN",
        WorkflowCompileError::UnsupportedRoleInput(_, _, _) => "W1_TASK_ROLE_INPUT_UNSUPPORTED",
        WorkflowCompileError::RoleOutputMismatch(_, _, _, _) => "W1_TASK_ROLE_OUTPUT_MISMATCH",
        WorkflowCompileError::SelfDependency(_) => "W1_TASK_SELF_DEPENDENCY",
        WorkflowCompileError::UnknownDependency(_, _) => "W1_TASK_DEPENDENCY_UNKNOWN",
        WorkflowCompileError::MissingPredecessorInput(_, _, _) => {
            "W1_TASK_PREDECESSOR_INPUT_MISSING"
        }
        WorkflowCompileError::DependencyCycle => "W1_TASK_DEPENDENCY_CYCLE",
        WorkflowCompileError::CanonicalJson => "W1_PLAN_CANONICAL_JSON_FAILED",
        WorkflowCompileError::PlanDigestMismatch => "W1_INNER_PLAN_DIGEST_MISMATCH",
    }
}

fn workflow_policy_error_code(error: &WorkflowPolicyV1Error) -> &'static str {
    match error {
        WorkflowPolicyV1Error::Invalid(_) => "W1_POLICY_INVALID",
        WorkflowPolicyV1Error::Canonicalization(error) => node_canonical_json_error_code(error),
        WorkflowPolicyV1Error::CanonicalSerialization(_) => {
            "W1_POLICY_CANONICAL_SERIALIZATION_FAILED"
        }
    }
}

fn node_canonical_json_error_code(error: &NodePlanCanonicalJsonError) -> &'static str {
    match error {
        NodePlanCanonicalJsonError::UnsupportedNumber => "W1_CANONICAL_NUMBER_UNSUPPORTED",
        NodePlanCanonicalJsonError::StringSerialization => {
            "W1_CANONICAL_STRING_SERIALIZATION_FAILED"
        }
    }
}

fn validate_skill_pins(
    workflow_plan: &CompiledWorkflowPlan,
    skill_pins: &[SkillPinRefV1],
) -> Result<(), CompiledPlanV1Error> {
    let role_versions: BTreeSet<(&str, u32)> = workflow_plan
        .tasks()
        .iter()
        .map(|task| (task.role_id.as_str(), task.role_version))
        .collect();
    let mut identities = BTreeSet::new();
    for pin in skill_pins {
        if !role_versions.contains(&(pin.role_id.as_str(), pin.role_version)) {
            return Err(CompiledPlanV1Error::SkillPinRoleNotInPlan(
                pin.role_id.clone(),
                pin.role_version,
            ));
        }
        validate_skill_id(&pin.skill_id)?;
        validate_sha256(&pin.bundle_sha256, &pin.skill_id)?;
        if !identities.insert((
            pin.role_id.as_str(),
            pin.role_version,
            pin.skill_id.as_str(),
        )) {
            return Err(CompiledPlanV1Error::DuplicateSkillPin(
                pin.role_id.clone(),
                pin.role_version,
                pin.skill_id.clone(),
            ));
        }
    }
    if skill_pins.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(CompiledPlanV1Error::NonCanonicalSkillPinOrder);
    }
    Ok(())
}

fn validate_workflow_definition_pin(
    workflow_plan: &CompiledWorkflowPlan,
    pin: &WorkflowDefinitionPinV1,
) -> Result<(), CompiledPlanV1Error> {
    if pin.workflow_id != workflow_plan.workflow_id()
        || pin.workflow_version != workflow_plan.workflow_version()
    {
        return Err(CompiledPlanV1Error::WorkflowDefinitionIdentityMismatch);
    }
    validate_sha256(&pin.definition_sha256, &pin.workflow_id)
}

fn validate_role_definition_pins(
    workflow_plan: &CompiledWorkflowPlan,
    pins: &[RoleDefinitionPinV1],
) -> Result<(), CompiledPlanV1Error> {
    let expected: BTreeSet<(&str, u32)> = workflow_plan
        .tasks()
        .iter()
        .map(|task| (task.role_id.as_str(), task.role_version))
        .collect();
    let mut actual = BTreeSet::new();
    for pin in pins {
        if !expected.contains(&(pin.role_id.as_str(), pin.role_version)) {
            return Err(CompiledPlanV1Error::RoleDefinitionNotInPlan(
                pin.role_id.clone(),
                pin.role_version,
            ));
        }
        validate_sha256(&pin.definition_sha256, &pin.role_id)?;
        if !actual.insert((pin.role_id.as_str(), pin.role_version)) {
            return Err(CompiledPlanV1Error::DuplicateRoleDefinitionPin(
                pin.role_id.clone(),
                pin.role_version,
            ));
        }
    }
    if actual != expected {
        return Err(CompiledPlanV1Error::RoleDefinitionPinCoverageMismatch);
    }
    if pins.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(CompiledPlanV1Error::NonCanonicalRoleDefinitionPinOrder);
    }
    Ok(())
}

fn validate_skill_id(value: &str) -> Result<(), CompiledPlanV1Error> {
    let bytes = value.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 64
        || !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit()
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        || value.ends_with('-')
        || value.contains("--")
    {
        return Err(CompiledPlanV1Error::InvalidSkillId(value.into()));
    }
    Ok(())
}

fn validate_sha256(value: &str, subject: &str) -> Result<(), CompiledPlanV1Error> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(CompiledPlanV1Error::InvalidSkillDigest(subject.into()));
    }
    Ok(())
}

fn sha256(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}

fn canonical_json_sha256<T: Serialize>(value: &T) -> Result<String, CompiledPlanV1Error> {
    let value = serde_json::to_value(value)
        .map_err(|error| CompiledPlanV1Error::CanonicalSerialization(error.to_string()))?;
    let canonical = canonicalize_node_plan_json(&value)?;
    Ok(sha256(canonical.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::custom_workflow::CustomRoleDefinition;
    use crate::workflow::{ArtifactType, WorkflowCapability, WorkflowPermission};
    use crate::workflow_policy_v1::{
        PolicyPlanContextV1, WorkflowPolicyDefinitionV1, compose_workflow_policy_v1,
        create_workflow_policy_snapshot_v1,
    };
    use serde::Deserialize;
    use serde_json::{Value, json};

    #[derive(Default)]
    struct FakeReadOnlyResolver {
        bundles: BTreeMap<String, String>,
    }

    #[derive(Deserialize)]
    struct NodeCompiledPlanOracle {
        schema_version: u32,
        generated_by_node: bool,
        source: String,
        vectors: Vec<NodeCompiledPlanVector>,
    }

    #[derive(Deserialize)]
    struct NodeCompiledPlanVector {
        name: String,
        workflow_definition_sha256: String,
        role_definition_sha256: String,
        canonical_json: String,
        sha256: String,
    }

    impl ReadOnlyTrustedSkillResolver for FakeReadOnlyResolver {
        fn resolve_trusted_skill(&self, skill_id: &str) -> Option<ResolvedSkillContentV1> {
            self.bundles
                .get(skill_id)
                .map(|bundle_sha256| ResolvedSkillContentV1 {
                    skill_id: skill_id.into(),
                    bundle_sha256: bundle_sha256.clone(),
                })
        }
    }

    fn roles_with_skill() -> Vec<RoleDefinitionV1> {
        vec![CustomRoleDefinition {
            role_id: "custom-owner".into(),
            version: 1,
            name: "Custom Owner".into(),
            description: "Version-pinned custom role".into(),
            system_prompt: "Use declared typed inputs only".into(),
            input_contract: vec![ArtifactType::JobRequest],
            output_artifact_type: ArtifactType::Requirements,
            allowed_capabilities: vec![WorkflowCapability::ProductRequirements],
            permissions: vec![
                WorkflowPermission::WorkspaceRead,
                WorkflowPermission::ArtifactCreate,
            ],
            allowed_tools: vec!["workflow_get".into()],
            skills: vec!["research-helper".into()],
        }]
    }

    fn one_task_definition() -> WorkflowDefinitionV1 {
        WorkflowDefinitionV1 {
            workflow_id: "skill-pinned-flow".into(),
            version: 3,
            name: "Skill Pinned Flow".into(),
            description: "A workflow that binds one trusted skill bundle".into(),
            input_contract: vec![ArtifactType::JobRequest],
            tasks: vec![crate::workflow::WorkflowTaskDefinition {
                id: "requirements".into(),
                role_id: "custom-owner".into(),
                role_version: 1,
                depends_on: vec![],
                input_contract: Some(vec![ArtifactType::JobRequest]),
                output_artifact_type: Some(ArtifactType::Requirements),
            }],
        }
    }

    fn resolver(bundle_sha256: &str) -> FakeReadOnlyResolver {
        FakeReadOnlyResolver {
            bundles: BTreeMap::from([("research-helper".into(), bundle_sha256.into())]),
        }
    }

    fn builtin_only_definition() -> WorkflowDefinitionV1 {
        WorkflowDefinitionV1 {
            workflow_id: "builtin-role-flow".into(),
            version: 1,
            name: "Built-in Role Flow".into(),
            description: "A workflow compiled from the immutable built-in role catalog".into(),
            input_contract: vec![ArtifactType::JobRequest],
            tasks: vec![crate::workflow::WorkflowTaskDefinition {
                id: "implementation".into(),
                role_id: "engineer".into(),
                role_version: 1,
                depends_on: vec![],
                input_contract: Some(vec![ArtifactType::Requirements, ArtifactType::Architecture]),
                output_artifact_type: Some(ArtifactType::Implementation),
            }],
        }
    }

    #[test]
    fn compiled_plan_v1_binds_role_version_skill_bundle_and_replays_identically() {
        let definition = one_task_definition();
        let roles = roles_with_skill();
        let resolver = resolver(&"a".repeat(64));

        let first = compile_workflow_v1(&definition, &roles, &resolver).unwrap();
        let replay = compile_workflow_v1(&definition, &roles, &resolver).unwrap();

        assert_eq!(first.schema_version(), 1);
        assert_eq!(first, replay);
        assert_eq!(first.skill_pins().len(), 1);
        assert_eq!(first.skill_pins()[0].role_id, "custom-owner");
        assert_eq!(first.skill_pins()[0].role_version, 1);
        assert_eq!(first.skill_pins()[0].skill_id, "research-helper");
        assert_eq!(first.skill_pins()[0].bundle_sha256, "a".repeat(64));
        assert_eq!(first.workflow_plan().workflow_version(), definition.version);
        assert_eq!(
            first.canonical_content().unwrap(),
            replay.canonical_content().unwrap()
        );
        first.verify_digest().unwrap();
    }

    #[test]
    fn compiled_plan_v1_canonical_bytes_and_digest_match_node_public_api_oracle() {
        let fixture: NodeCompiledPlanOracle =
            serde_json::from_str(include_str!("../tests/fixtures/node-compiled-plan-v1.json"))
                .expect("Node-generated CompiledPlanV1 oracle must parse");
        assert_eq!(fixture.schema_version, 1);
        assert!(fixture.generated_by_node);
        assert!(fixture.source.contains("workflow/plan.js::canonicalJson"));

        let compiled = compile_workflow_v1(
            &one_task_definition(),
            &roles_with_skill(),
            &resolver(&"a".repeat(64)),
        )
        .unwrap();
        let vector = fixture
            .vectors
            .into_iter()
            .find(|vector| vector.name == "workflow-role-and-skill-definition-pinned-plan")
            .expect("Node oracle vector must exist");

        assert_eq!(compiled.canonical_content().unwrap(), vector.canonical_json);
        assert_eq!(compiled.plan_digest().value, vector.sha256);
        assert_eq!(
            compiled.workflow_definition_pin().definition_sha256,
            vector.workflow_definition_sha256
        );
        assert_eq!(
            compiled.role_definition_pins()[0].definition_sha256,
            vector.role_definition_sha256
        );
        compiled.verify_digest().unwrap();
    }

    #[test]
    fn compiled_plan_with_policy_composition_matches_node_public_api_oracle() {
        #[derive(Deserialize)]
        struct NodePolicyPlanOracle {
            generated_by_node: bool,
            source: String,
            canonical_json: String,
            sha256: String,
        }
        let fixture: NodePolicyPlanOracle = serde_json::from_str(include_str!(
            "../tests/fixtures/node-compiled-plan-policy-v1.json"
        ))
        .unwrap();
        assert!(fixture.generated_by_node);
        assert!(fixture.source.contains("composePolicySuccessContract"));

        let compiled = compile_workflow_v1(
            &one_task_definition(),
            &roles_with_skill(),
            &resolver(&"a".repeat(64)),
        )
        .unwrap();
        let policy = WorkflowPolicyDefinitionV1 {
            schema_version: 1,
            policy_id: "require-owner".into(),
            name: "Require custom owner".into(),
            description: "The immutable plan must include the custom owner role".into(),
            constraints: vec![json!({
                "id":"owner-present",
                "type":"task_role_present",
                "role":"custom-owner"
            })],
            success_criteria: vec![json!({
                "id":"all-complete",
                "type":"all_tasks_completed"
            })],
        };
        let snapshot = create_workflow_policy_snapshot_v1(&policy, 1).unwrap();
        let base = json!({"goal":"Complete workflow"});
        let composition = compose_workflow_policy_v1(
            Some(&base),
            &[snapshot],
            &PolicyPlanContextV1::from(compiled.workflow_plan()),
        )
        .unwrap();
        let compiled = compiled.with_policy_composition(composition).unwrap();

        assert_eq!(
            compiled.canonical_content().unwrap(),
            fixture.canonical_json
        );
        assert_eq!(compiled.plan_digest().value, fixture.sha256);
        compiled.verify_digest().unwrap();
    }

    #[test]
    fn compiled_plan_policy_composition_is_inside_outer_digest_and_revalidated() {
        let mut compiled = compile_workflow_v1(
            &one_task_definition(),
            &roles_with_skill(),
            &resolver(&"a".repeat(64)),
        )
        .unwrap();
        let policy = WorkflowPolicyDefinitionV1 {
            schema_version: 1,
            policy_id: "require-owner".into(),
            name: "Require custom owner".into(),
            description: "The immutable plan must include the custom owner role".into(),
            constraints: vec![json!({
                "id":"owner-present",
                "type":"task_role_present",
                "role":"custom-owner"
            })],
            success_criteria: vec![],
        };
        let snapshot = create_workflow_policy_snapshot_v1(&policy, 1).unwrap();
        let composition = compose_workflow_policy_v1(
            None,
            &[snapshot],
            &PolicyPlanContextV1::from(compiled.workflow_plan()),
        )
        .unwrap();
        compiled = compiled.with_policy_composition(composition).unwrap();
        compiled.policy_composition.as_mut().unwrap().policy_pins[0].version = 2;

        assert!(matches!(
            compiled.verify_digest(),
            Err(CompiledPlanV1Error::PolicyComposition(_))
        ));
    }

    #[test]
    fn compiled_plan_v1_resolves_builtin_roles_without_skill_authority_lookup() {
        let compiled = compile_workflow_v1(
            &builtin_only_definition(),
            &[],
            &FakeReadOnlyResolver::default(),
        )
        .unwrap();

        assert!(compiled.skill_pins().is_empty());
        assert_eq!(compiled.workflow_plan().tasks()[0].role_id, "engineer");
        assert_eq!(compiled.workflow_plan().tasks()[0].role_version, 1);
        compiled.verify_digest().unwrap();
    }

    #[test]
    fn compiled_plan_v1_supports_builtin_and_custom_roles_in_one_dag() {
        let mut definition = one_task_definition();
        definition
            .tasks
            .push(crate::workflow::WorkflowTaskDefinition {
                id: "research".into(),
                role_id: "researcher".into(),
                role_version: 1,
                depends_on: vec!["requirements".into()],
                input_contract: Some(vec![ArtifactType::Requirements]),
                output_artifact_type: Some(ArtifactType::Research),
            });

        let compiled =
            compile_workflow_v1(&definition, &roles_with_skill(), &resolver(&"a".repeat(64)))
                .unwrap();

        assert_eq!(compiled.workflow_plan().tasks().len(), 2);
        assert_eq!(
            compiled.workflow_plan().execution_order(),
            ["requirements", "research"]
        );
        assert_eq!(compiled.skill_pins().len(), 1);
        assert_eq!(compiled.skill_pins()[0].role_id, "custom-owner");
        compiled.verify_digest().unwrap();
    }

    #[test]
    fn changed_skill_bundle_changes_outer_plan_digest() {
        let definition = one_task_definition();
        let roles = roles_with_skill();
        let first = compile_workflow_v1(&definition, &roles, &resolver(&"a".repeat(64))).unwrap();
        let second = compile_workflow_v1(&definition, &roles, &resolver(&"b".repeat(64))).unwrap();

        assert_ne!(first.plan_digest().value, second.plan_digest().value);
        assert_ne!(first.skill_pins(), second.skill_pins());
    }

    #[test]
    fn changed_role_definition_under_same_version_changes_outer_digest() {
        let definition = one_task_definition();
        let original_roles = roles_with_skill();
        let mut changed_roles = original_roles.clone();
        changed_roles[0].system_prompt = "A different prompt under the same version".into();

        let original =
            compile_workflow_v1(&definition, &original_roles, &resolver(&"a".repeat(64))).unwrap();
        let changed =
            compile_workflow_v1(&definition, &changed_roles, &resolver(&"a".repeat(64))).unwrap();

        assert_eq!(
            original.workflow_plan().plan_hash(),
            changed.workflow_plan().plan_hash(),
            "legacy task projection is unchanged by prompt-only mutation"
        );
        assert_ne!(
            original.role_definition_pins(),
            changed.role_definition_pins()
        );
        assert_ne!(original.plan_digest().value, changed.plan_digest().value);
    }

    #[test]
    fn changed_workflow_metadata_under_same_version_changes_outer_digest() {
        let original_definition = one_task_definition();
        let mut changed_definition = original_definition.clone();
        changed_definition.description = "Changed metadata without a version bump".into();
        let roles = roles_with_skill();

        let original =
            compile_workflow_v1(&original_definition, &roles, &resolver(&"a".repeat(64))).unwrap();
        let changed =
            compile_workflow_v1(&changed_definition, &roles, &resolver(&"a".repeat(64))).unwrap();

        assert_eq!(
            original.workflow_plan().plan_hash(),
            changed.workflow_plan().plan_hash(),
            "legacy task projection omits the workflow description"
        );
        assert_ne!(
            original.workflow_definition_pin(),
            changed.workflow_definition_pin()
        );
        assert_ne!(original.plan_digest().value, changed.plan_digest().value);
    }

    #[test]
    fn digest_verification_requires_exact_role_definition_pin_coverage() {
        let mut compiled = compile_workflow_v1(
            &one_task_definition(),
            &roles_with_skill(),
            &resolver(&"a".repeat(64)),
        )
        .unwrap();
        compiled.role_definition_pins.clear();

        assert_eq!(
            compiled.verify_digest(),
            Err(CompiledPlanV1Error::RoleDefinitionPinCoverageMismatch)
        );
    }

    #[test]
    fn missing_or_malformed_trusted_skill_resolution_fails_closed() {
        let definition = one_task_definition();
        let roles = roles_with_skill();

        assert_eq!(
            compile_workflow_v1(&definition, &roles, &FakeReadOnlyResolver::default()).unwrap_err(),
            CompiledPlanV1Error::TrustedSkillUnavailable("research-helper".into())
        );
        assert_eq!(
            compile_workflow_v1(&definition, &roles, &resolver("not-a-digest")).unwrap_err(),
            CompiledPlanV1Error::InvalidSkillDigest("research-helper".into())
        );
    }

    #[test]
    fn digest_verification_detects_skill_pin_tampering() {
        let mut compiled = compile_workflow_v1(
            &one_task_definition(),
            &roles_with_skill(),
            &resolver(&"a".repeat(64)),
        )
        .unwrap();
        compiled.skill_pins[0].bundle_sha256 = "b".repeat(64);

        assert_eq!(
            compiled.verify_digest(),
            Err(CompiledPlanV1Error::PlanDigestMismatch)
        );
    }

    #[test]
    fn resolver_identity_must_match_requested_skill() {
        struct WrongIdentity;
        impl ReadOnlyTrustedSkillResolver for WrongIdentity {
            fn resolve_trusted_skill(&self, _skill_id: &str) -> Option<ResolvedSkillContentV1> {
                Some(ResolvedSkillContentV1 {
                    skill_id: "different-skill".into(),
                    bundle_sha256: "a".repeat(64),
                })
            }
        }

        assert!(matches!(
            compile_workflow_v1(&one_task_definition(), &roles_with_skill(), &WrongIdentity),
            Err(CompiledPlanV1Error::SkillResolutionIdentityMismatch { .. })
        ));
    }

    #[test]
    fn generated_canonical_plan_values_are_idempotent_across_unicode_and_nested_shapes() {
        let keys = ["a", "é", "e\u{301}", "😀", "\u{e000}", "__proto__"];
        for index in 0..128_u64 {
            let mut value = json!({
                "index": index,
                "safe_integer": 9_007_199_254_740_991_i64,
                "negative_zero": -0.0,
                "text": format!("case-{index}-é-e\u{301}-😀"),
                "nested": [
                    {"z": index, "a": [true, false, null]},
                    {"value": format!("payload-{index}")}
                ]
            });
            value.as_object_mut().unwrap().insert(
                keys[index as usize % keys.len()].to_owned(),
                json!({
                    "sequence": index,
                    "prototype_key_is_data": {"__proto__": "not a prototype mutation"}
                }),
            );

            let canonical = canonicalize_node_plan_json(&value).unwrap();
            let reparsed: Value = serde_json::from_str(&canonical).unwrap();
            assert_eq!(
                canonicalize_node_plan_json(&reparsed).unwrap(),
                canonical,
                "canonicalization must be idempotent for generated case {index}"
            );
            assert_eq!(
                sha256(canonical.as_bytes()),
                sha256(canonicalize_node_plan_json(&reparsed).unwrap().as_bytes()),
                "canonical digest must replay for generated case {index}"
            );
        }
    }

    #[test]
    fn digest_verification_rejects_skill_pins_for_unreferenced_role_versions() {
        let mut compiled = compile_workflow_v1(
            &one_task_definition(),
            &roles_with_skill(),
            &resolver(&"a".repeat(64)),
        )
        .unwrap();
        compiled.skill_pins.push(SkillPinRefV1 {
            role_id: "custom-unused".into(),
            role_version: 1,
            skill_id: "research-helper".into(),
            bundle_sha256: "a".repeat(64),
        });
        compiled.skill_pins.sort();
        assert!(matches!(
            compiled.verify_digest(),
            Err(CompiledPlanV1Error::SkillPinRoleNotInPlan(_, _))
        ));
    }

    #[test]
    fn compiled_plan_errors_expose_stable_w1_codes_not_display_text() {
        assert_eq!(
            CompiledPlanV1Error::TrustedSkillUnavailable("skill".into()).code(),
            "W1_TRUSTED_SKILL_UNAVAILABLE"
        );
        assert_eq!(
            CompiledPlanV1Error::CustomWorkflow(CustomWorkflowError::ReservedRole(
                "engineer".into()
            ))
            .code(),
            "W1_ROLE_RESERVED"
        );
        assert_eq!(
            CompiledPlanV1Error::WorkflowCompile(WorkflowCompileError::DependencyCycle).code(),
            "W1_TASK_DEPENDENCY_CYCLE"
        );
        assert_eq!(
            CompiledPlanV1Error::PolicyComposition(WorkflowPolicyV1Error::Invalid(
                "invalid policy".into()
            ))
            .code(),
            "W1_POLICY_INVALID"
        );
        assert_eq!(
            CompiledPlanV1Error::Canonicalization(NodePlanCanonicalJsonError::UnsupportedNumber)
                .code(),
            "W1_CANONICAL_NUMBER_UNSUPPORTED"
        );
        assert_eq!(
            CompiledPlanV1Error::PlanDigestMismatch.to_string(),
            "CompiledPlanV1 digest verification failed"
        );
        assert_eq!(
            CompiledPlanV1Error::PlanDigestMismatch.code(),
            "W1_PLAN_DIGEST_MISMATCH"
        );
    }
}
