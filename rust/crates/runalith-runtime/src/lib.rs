//! Approval-gated durable workflow runtime.
//!
//! The runtime owns its SQLite schema and lifecycle transitions. It invokes only
//! injected provider/sandbox capabilities after exact plan, approval and lease
//! checks. External approval verification is injected and defaults to no authority.

pub use runalith_store::{
    AgentSessionCreateRequest, AgentSessionInspection, AgentSessionRecord, ApprovalRequest,
    ApprovalVerificationMode, ApprovalVerifier, ClaimRequest, CoordinatorRequest,
    CoordinatorWorkerVerifier, CustomRoleVersion, CustomWorkflowPlanRecord, CustomWorkflowVersion,
    DenyAllApprovalVerifier, EventChainVerification, ProviderDispatchState, ProviderIntentOutcome,
    ProviderIntentRecord, ProviderIntentRequest, ProviderIntentReservation,
    ProviderReconciliationObservation, ReadyTask, RecoveryDecisionRecord,
    RecoveryDecisionRecordRequest, RecoveryDecisionVerifier, RuntimeSessionBinding,
    RuntimeSessionBindingRequest, SessionAccessRequest, SessionAttachment, SessionDeliveryReceipt,
    SessionMessageRecord, SessionMessageRequest, SessionPermission, Store, StoreError,
    TaskAttemptReadView, TaskAttemptSnapshot, TaskLease, TaskLeaseRenewal, TaskLeaseRenewalRequest,
    TaskResultEnvelope, TaskResultProducerVerifier, TaskResultRequest, TaskView, Transaction,
    TrustedSkillResolver, VerifiedApproval, VerifiedTaskResultProducer, VerifiedTrustedSkill,
    WorkerExecutionFenceCompletion, WorkerExecutionFenceCompletionResult,
    WorkerExecutionFenceCompletionVerifier, WorkerExecutionFenceKind, WorkerExecutionFenceRecord,
    WorkerExecutionFenceRequest, WorkflowCancellationRequest, WorkflowCancellationVerifier,
    WorkflowEvent, WorkflowPolicyAttachment, WorkflowPolicyDefinition, WorkflowPolicyVersion,
    WorkflowReadSnapshot, WorkflowView,
};

use std::sync::Arc;

use runalith_artifacts::ArtifactStore;
use runalith_domain::{EvidenceRef, TaskOutcome, TaskState, WorkflowProposal, content_hash};
use runalith_providers::{
    ProviderAdapter, ProviderAdapterError, ProviderDispatchRequest, ProviderDispatchResponse,
};
use runalith_recovery::manager::{
    AttemptLineage, AttemptOwnership, AttemptRecoveryEvidence, LeaseObservation, Observation,
    ProviderObservation, RecoveryManager, RuntimeSnapshot,
};
use runalith_sandbox::{CommandRequest, SandboxError, SandboxExecutor};
use runalith_trust::approval_decision::{ApprovalDecisionMode, verify_approval_evidence_envelope};
use runalith_trust::governance_service::{
    GovernanceApprovalRequestV1, GovernanceDecision, GovernanceDecisionVerificationMode,
    GovernanceDecisionVerifier, GovernanceServiceError, VerifiedGovernanceOutcome,
};
use runalith_trust::trust_config::TrustConfigurationSet;
use runalith_trust::trust_ledger::{TrustConfigurationObserver, TrustLedger};
use runalith_trust::trust_lifecycle::{
    ReviewerIdentityRepository, ReviewerStatus, validate_reviewer_identity,
};
use serde_json::Value;
use thiserror::Error;

/// Resolves the current candidate binding from trusted, persisted graph state.
///
/// Implementations must derive the binding from current authenticated
/// Goal/Idea/Plan/Execution snapshots using the supplied transaction. They
/// must never copy the binding from `request.evidence` or trust caller-supplied
/// graph hashes. No default implementation is provided.
pub trait CandidateBindingResolver: Send + Sync {
    /// Derive the exact candidate binding for this proposal and immutable plan.
    fn resolve_current_binding(
        &self,
        transaction: &Transaction<'_>,
        proposal: &WorkflowProposal,
        plan: &runalith_domain::WorkflowPlan,
        request: &ApprovalRequest,
    ) -> Result<Value, StoreError>;
}

/// Resolves the exact current AGG candidate subject for a Governance request.
///
/// The returned JSON must equal the complete `ApprovalSubjectV1`; it must be
/// derived from authenticated current graph/plan state in the supplied
/// transaction, never copied from the request or evidence.
pub trait GovernanceCandidateBindingResolver: Send + Sync {
    /// Resolve the exact six-field Governance subject from current durable state.
    fn resolve_current_subject(
        &self,
        transaction: &Transaction<'_>,
        request: &GovernanceApprovalRequestV1,
    ) -> Result<Value, StoreError>;
}

/// Host authority that verifies a runtime's attestation before session binding.
/// Implementations must authenticate runtime identity and bind every request
/// field to the current leased attempt; no permissive default is provided.
pub trait RuntimeSessionBindingVerifier: Send + Sync {
    /// Verify host/runtime attestation against current durable lease state.
    fn verify_binding(
        &self,
        current: &TaskAttemptSnapshot,
        request: &RuntimeSessionBindingRequest,
    ) -> Result<(), RuntimeError>;
}

/// Host-owned authenticated principal resolver for catalog mutations.
///
/// The implementation must derive identity from the authenticated host
/// connection, never from MCP arguments or a caller-supplied actor field.
/// No default implementation is provided.
pub trait CatalogAuthorVerifier: Send + Sync {
    /// Return the canonical authenticated principal for the current request.
    fn authenticated_principal(&self) -> Result<String, RuntimeError>;
}

/// Store-compatible maker/checker verifier with an injected trusted candidate resolver.
///
/// This verifier is not used by the default host. Production D-01 composition
/// must use `with_governance` with the same Store used by `WorkflowService`, plus
/// an authoritative graph binding resolver. The legacy `new` constructor is
/// retained for isolated compatibility and uses the standalone TrustLedger.
pub struct TrustApprovalVerifier {
    configurations: Arc<TrustConfigurationSet>,
    trust_observer: Arc<dyn TrustConfigurationObserver>,
    binding_resolver: Arc<dyn CandidateBindingResolver>,
    reviewer_repository: Option<Arc<dyn ReviewerIdentityRepository>>,
    require_reviewer_registry: bool,
}

impl TrustApprovalVerifier {
    /// Compose verifier from externally provisioned trust and graph authority.
    #[must_use]
    pub fn new(
        configurations: Arc<TrustConfigurationSet>,
        trust_ledger: Arc<TrustLedger>,
        binding_resolver: Arc<dyn CandidateBindingResolver>,
    ) -> Self {
        Self {
            configurations,
            trust_observer: trust_ledger,
            binding_resolver,
            reviewer_repository: None,
            require_reviewer_registry: false,
        }
    }

    /// Compose verifier with a transaction-aware trust observer. D-01 approval
    /// fails closed until `with_reviewer_repository` is also supplied.
    #[must_use]
    pub fn with_observer(
        configurations: Arc<TrustConfigurationSet>,
        trust_observer: Arc<dyn TrustConfigurationObserver>,
        binding_resolver: Arc<dyn CandidateBindingResolver>,
    ) -> Self {
        Self {
            configurations,
            trust_observer,
            binding_resolver,
            reviewer_repository: None,
            require_reviewer_registry: true,
        }
    }

    /// Bind D-01 approval to the append-only Governance reviewer registry.
    /// Store adapters must implement `current_reviewer_in_transaction`; the
    /// verifier never falls back to the separate Governance writer connection.
    #[must_use]
    pub fn with_reviewer_repository(
        mut self,
        reviewer_repository: Arc<dyn ReviewerIdentityRepository>,
    ) -> Self {
        self.reviewer_repository = Some(reviewer_repository);
        self
    }

    /// Preferred D-01 composition: workflow transaction-aware trust observer,
    /// transaction-readable reviewer lifecycle repository, and authoritative
    /// current-candidate binding resolver are all mandatory inputs.
    #[must_use]
    pub fn with_governance(
        configurations: Arc<TrustConfigurationSet>,
        trust_observer: Arc<dyn TrustConfigurationObserver>,
        reviewer_repository: Arc<dyn ReviewerIdentityRepository>,
        binding_resolver: Arc<dyn CandidateBindingResolver>,
    ) -> Self {
        Self::with_observer(configurations, trust_observer, binding_resolver)
            .with_reviewer_repository(reviewer_repository)
    }
}

impl ApprovalVerifier for TrustApprovalVerifier {
    fn verify(
        &self,
        transaction: &Transaction<'_>,
        proposal: &WorkflowProposal,
        plan: &runalith_domain::WorkflowPlan,
        request: &ApprovalRequest,
        mode: ApprovalVerificationMode,
    ) -> Result<VerifiedApproval, StoreError> {
        let expected_binding =
            self.binding_resolver
                .resolve_current_binding(transaction, proposal, plan, request)?;
        let decision_mode = match mode {
            ApprovalVerificationMode::Initial => ApprovalDecisionMode::Consume,
            ApprovalVerificationMode::Revalidate => ApprovalDecisionMode::Revalidate,
        };
        let now_ms = chrono::Utc::now().timestamp_millis();
        let verified = verify_approval_evidence_envelope(
            &self.configurations,
            self.trust_observer.as_ref(),
            &request.evidence,
            &expected_binding,
            transaction,
            now_ms,
            decision_mode,
        )
        .map_err(|error| StoreError::ApprovalEvidenceRejected {
            code: error.code().to_owned(),
            message: error.to_string(),
        })?;
        if self.require_reviewer_registry {
            let repository = self.reviewer_repository.as_ref().ok_or_else(|| {
                StoreError::ApprovalEvidenceRejected {
                    code: "AGG_REVIEWER_REGISTRY_UNAVAILABLE".into(),
                    message:
                        "D-01 approval requires a transaction-readable Governance reviewer registry"
                            .into(),
                }
            })?;
            let maker_root = request.evidence["maker_attestation"]["trust_root_sha256"]
                .as_str()
                .ok_or(StoreError::InvalidVerifierOutput)?;
            verify_registered_reviewer(
                repository.as_ref(),
                transaction,
                &verified.maker_subject,
                "maker",
                "action_intent_maker",
                maker_root,
                now_ms,
            )?;
            for vote in &verified.checker_votes {
                verify_registered_reviewer(
                    repository.as_ref(),
                    transaction,
                    &vote.reviewer_subject,
                    &vote.reviewer_role,
                    &vote.trust_domain,
                    &vote.trust_root_sha256,
                    now_ms,
                )?;
            }
        }
        let actor = verified
            .approved_reviewer_subjects
            .first()
            .cloned()
            .ok_or(StoreError::InvalidVerifierOutput)?;
        // Preserve the original signed evidence byte-for-byte as JSON value;
        // Store revalidates these same signatures and nonce records at claim.
        Ok(VerifiedApproval {
            actor,
            evidence: request.evidence.clone(),
        })
    }
}

fn verify_registered_reviewer(
    repository: &dyn ReviewerIdentityRepository,
    transaction: &Transaction<'_>,
    subject: &str,
    expected_role: &str,
    expected_domain: &str,
    expected_root_sha256: &str,
    now_ms: i64,
) -> Result<(), StoreError> {
    let identity = repository
        .current_reviewer_in_transaction(transaction, subject)
        .map_err(|error| StoreError::ApprovalEvidenceRejected {
            code: "AGG_REVIEWER_REGISTRY_UNAVAILABLE".into(),
            message: error.to_string(),
        })?
        .ok_or_else(|| StoreError::ApprovalEvidenceRejected {
            code: "AGG_REVIEWER_IDENTITY_NOT_REGISTERED".into(),
            message: format!("reviewer identity is not registered: {subject}"),
        })?;
    validate_reviewer_identity(&identity, now_ms, false).map_err(|error| {
        StoreError::ApprovalEvidenceRejected {
            code: "AGG_REVIEWER_IDENTITY_INVALID".into(),
            message: error.to_string(),
        }
    })?;
    if identity.subject != subject
        || identity.status != ReviewerStatus::Active
        || identity.role != expected_role
        || !identity.domains.contains(expected_domain)
        || identity.public_key_sha256 != expected_root_sha256
        || identity.expires_at_ms <= now_ms
    {
        return Err(StoreError::ApprovalEvidenceRejected {
            code: "AGG_REVIEWER_IDENTITY_REJECTED".into(),
            message: format!(
                "reviewer {subject} is not active for role {expected_role}, domain {expected_domain}, and signed trust root"
            ),
        });
    }
    Ok(())
}

/// Transaction-scoped trust verifier for the independent Governance service.
///
/// This is a real cryptographic/policy/reviewer verifier, but production use
/// still requires host-provisioned trust roots and a current-candidate resolver.
pub struct TrustGovernanceDecisionVerifier {
    configurations: Arc<TrustConfigurationSet>,
    trust_observer: Arc<dyn TrustConfigurationObserver>,
    reviewer_repository: Arc<dyn ReviewerIdentityRepository>,
    binding_resolver: Arc<dyn GovernanceCandidateBindingResolver>,
}

impl TrustGovernanceDecisionVerifier {
    /// Compose against host-owned, transaction-aware trust and candidate sources.
    #[must_use]
    pub fn new(
        configurations: Arc<TrustConfigurationSet>,
        trust_observer: Arc<dyn TrustConfigurationObserver>,
        reviewer_repository: Arc<dyn ReviewerIdentityRepository>,
        binding_resolver: Arc<dyn GovernanceCandidateBindingResolver>,
    ) -> Self {
        Self {
            configurations,
            trust_observer,
            reviewer_repository,
            binding_resolver,
        }
    }

    /// Compose both trust and reviewer reads from the exact same D-01 Store.
    #[must_use]
    pub fn with_store(
        configurations: Arc<TrustConfigurationSet>,
        store: Arc<Store>,
        binding_resolver: Arc<dyn GovernanceCandidateBindingResolver>,
    ) -> Self {
        let trust_observer: Arc<dyn TrustConfigurationObserver> = store.clone();
        let reviewer_repository: Arc<dyn ReviewerIdentityRepository> = store;
        Self::new(
            configurations,
            trust_observer,
            reviewer_repository,
            binding_resolver,
        )
    }
}

impl GovernanceDecisionVerifier for TrustGovernanceDecisionVerifier {
    fn verify_in_transaction(
        &self,
        transaction: &Transaction<'_>,
        request: &GovernanceApprovalRequestV1,
        evidence: &Value,
        now: &str,
        mode: GovernanceDecisionVerificationMode,
    ) -> Result<VerifiedGovernanceOutcome, GovernanceServiceError> {
        let now = chrono::DateTime::parse_from_rfc3339(now)
            .map_err(|_| GovernanceServiceError::InvalidClock)?;
        let now_ms = now.timestamp_millis();
        let expected_binding = self
            .binding_resolver
            .resolve_current_subject(transaction, request)
            .map_err(|error| GovernanceServiceError::Backend(error.to_string()))?;
        let request_binding = serde_json::to_value(&request.subject)
            .map_err(|error| GovernanceServiceError::Backend(error.to_string()))?;
        if !expected_binding.is_object() || expected_binding != request_binding {
            return Err(GovernanceServiceError::Backend(
                "current candidate does not match Governance request subject".into(),
            ));
        }
        let decision_mode = match mode {
            GovernanceDecisionVerificationMode::Consume => ApprovalDecisionMode::Consume,
            GovernanceDecisionVerificationMode::Revalidate => ApprovalDecisionMode::Revalidate,
        };
        let verified = verify_approval_evidence_envelope(
            &self.configurations,
            self.trust_observer.as_ref(),
            evidence,
            &expected_binding,
            transaction,
            now_ms,
            decision_mode,
        )
        .map_err(|error| GovernanceServiceError::Backend(error.to_string()))?;
        let maker_root = evidence["maker_attestation"]["trust_root_sha256"]
            .as_str()
            .ok_or_else(|| {
                GovernanceServiceError::Backend(
                    "verified maker attestation has no trust-root fingerprint".into(),
                )
            })?;
        verify_registered_reviewer(
            self.reviewer_repository.as_ref(),
            transaction,
            &verified.maker_subject,
            "maker",
            "action_intent_maker",
            maker_root,
            now_ms,
        )
        .map_err(|error| GovernanceServiceError::Backend(error.to_string()))?;
        for vote in &verified.checker_votes {
            verify_registered_reviewer(
                self.reviewer_repository.as_ref(),
                transaction,
                &vote.reviewer_subject,
                &vote.reviewer_role,
                &vote.trust_domain,
                &vote.trust_root_sha256,
                now_ms,
            )
            .map_err(|error| GovernanceServiceError::Backend(error.to_string()))?;
        }
        let mut reviewer_subjects = vec![verified.maker_subject];
        reviewer_subjects.extend(verified.approved_reviewer_subjects);
        reviewer_subjects.sort();
        reviewer_subjects.dedup();
        let valid_until =
            chrono::DateTime::<chrono::Utc>::from_timestamp_millis(verified.valid_until_ms)
                .ok_or_else(|| {
                    GovernanceServiceError::Backend("verified decision expiry is invalid".into())
                })?
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        Ok(VerifiedGovernanceOutcome {
            decision: GovernanceDecision::Approved,
            policy_id: verified.policy_id,
            policy_version: verified.policy_version,
            policy_sha256: verified.policy_hash,
            reviewer_subjects,
            valid_until,
        })
    }
}

/// Exact invocation parameters for one plan-pinned sandbox task.
#[derive(Debug, Clone)]
pub struct SandboxTaskExecutionRequest {
    /// Workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Worker identity for the fenced lease.
    pub worker_id: String,
    /// Lease duration in seconds.
    pub lease_ttl_seconds: u64,
    /// Command must equal immutable task input `sandbox_command`.
    pub command: CommandRequest,
}

// ClaimRequest and TaskResultRequest are owned by runalith-store and re-exported above.

/// Public application service; storage methods that bypass verification stay private.
pub struct WorkflowService {
    store: Arc<Store>,
    approval_verifier: Arc<dyn ApprovalVerifier>,
}

/// Host-supplied runtime evidence required for one recovery classification.
#[derive(Debug, Clone, Copy)]
pub struct RecoveryRuntimeEvidence<'a> {
    /// Complete runtime inventory snapshot supplied by the host adapter.
    pub snapshot: &'a RuntimeSnapshot,
    /// Expected runtime instance identity.
    pub expected_runtime_id: &'a str,
    /// Caller-observed current time in Unix milliseconds.
    pub now_ms: i64,
    /// Maximum permitted snapshot age in milliseconds.
    pub maximum_snapshot_age_ms: i64,
}

impl WorkflowService {
    /// Compose service with an explicit store and authority verifier.
    #[must_use]
    pub fn new(store: Arc<Store>, approval_verifier: Arc<dyn ApprovalVerifier>) -> Self {
        Self {
            store,
            approval_verifier,
        }
    }

    /// Persist a review-only proposal and its candidate immutable plan.
    pub fn create_proposal(
        &self,
        proposal: WorkflowProposal,
    ) -> Result<WorkflowView, RuntimeError> {
        Ok(self.store.create_proposal(proposal)?)
    }

    /// Create a workflow instance from an exact persisted custom catalog plan.
    /// Trusted skill identities and content digests are revalidated in the same
    /// Store transaction that persists the proposal and catalog binding event.
    pub fn create_proposal_from_custom_workflow_plan(
        &self,
        plan_id: &str,
        idempotency_key: &str,
        title: &str,
        goal: &str,
        created_by: &str,
        resolver: &dyn TrustedSkillResolver,
    ) -> Result<WorkflowView, RuntimeError> {
        Ok(self.store.create_proposal_from_custom_workflow_plan(
            plan_id,
            idempotency_key,
            title,
            goal,
            created_by,
            resolver,
        )?)
    }

    /// Create first immutable custom role catalog version.
    pub fn create_custom_role(
        &self,
        definition: runalith_domain::custom_workflow::CustomRoleDefinition,
        created_by: &str,
    ) -> Result<CustomRoleVersion, RuntimeError> {
        Ok(self.store.create_custom_role(definition, created_by)?)
    }

    /// Create a custom role only after host-owned verification of exact skill versions.
    pub fn create_custom_role_with_trusted_skills(
        &self,
        definition: runalith_domain::custom_workflow::CustomRoleDefinition,
        created_by: &str,
        resolver: &dyn TrustedSkillResolver,
    ) -> Result<CustomRoleVersion, RuntimeError> {
        Ok(self
            .store
            .create_custom_role_with_trusted_skills(definition, created_by, resolver)?)
    }

    /// Clone an immutable role definition and preserve its exact trusted skill pins.
    /// Replacement skill references require a host resolver; unchanged references
    /// reuse the source version's immutable verified pin snapshot.
    pub fn clone_custom_role(
        &self,
        source_role_id: &str,
        expected_source_version: u32,
        definition: runalith_domain::custom_workflow::CustomRoleDefinition,
        created_by: &str,
        resolver: Option<&dyn TrustedSkillResolver>,
    ) -> Result<CustomRoleVersion, RuntimeError> {
        Ok(self.store.clone_custom_role(
            source_role_id,
            expected_source_version,
            definition,
            created_by,
            resolver,
        )?)
    }

    /// Append an immutable custom role catalog version.
    pub fn update_custom_role(
        &self,
        role_id: &str,
        definition: runalith_domain::custom_workflow::CustomRoleDefinition,
        created_by: &str,
    ) -> Result<CustomRoleVersion, RuntimeError> {
        Ok(self
            .store
            .update_custom_role(role_id, definition, created_by)?)
    }

    /// Append a custom role version only after host-owned skill verification.
    pub fn update_custom_role_with_trusted_skills(
        &self,
        role_id: &str,
        definition: runalith_domain::custom_workflow::CustomRoleDefinition,
        created_by: &str,
        resolver: &dyn TrustedSkillResolver,
    ) -> Result<CustomRoleVersion, RuntimeError> {
        Ok(self
            .store
            .update_custom_role_with_trusted_skills(role_id, definition, created_by, resolver)?)
    }

    /// Read an exact or latest custom role version.
    pub fn get_custom_role(
        &self,
        role_id: &str,
        version: Option<u32>,
    ) -> Result<CustomRoleVersion, RuntimeError> {
        Ok(self.store.get_custom_role(role_id, version)?)
    }

    /// List bounded custom role catalog versions.
    pub fn list_custom_roles(
        &self,
        include_versions: bool,
        limit: u64,
    ) -> Result<Vec<CustomRoleVersion>, RuntimeError> {
        Ok(self.store.list_custom_roles(include_versions, limit)?)
    }

    /// Create first immutable custom workflow catalog version.
    pub fn create_custom_workflow(
        &self,
        definition: runalith_domain::workflow::CustomWorkflowDefinition,
        created_by: &str,
    ) -> Result<CustomWorkflowVersion, RuntimeError> {
        Ok(self.store.create_custom_workflow(definition, created_by)?)
    }

    /// Create a workflow after host revalidation of exact skill pins on referenced role versions.
    pub fn create_custom_workflow_with_trusted_skills(
        &self,
        definition: runalith_domain::workflow::CustomWorkflowDefinition,
        created_by: &str,
        resolver: &dyn TrustedSkillResolver,
    ) -> Result<CustomWorkflowVersion, RuntimeError> {
        Ok(self
            .store
            .create_custom_workflow_with_trusted_skills(definition, created_by, resolver)?)
    }

    /// Append an immutable custom workflow catalog version.
    pub fn update_custom_workflow(
        &self,
        workflow_id: &str,
        definition: runalith_domain::workflow::CustomWorkflowDefinition,
        created_by: &str,
    ) -> Result<CustomWorkflowVersion, RuntimeError> {
        Ok(self
            .store
            .update_custom_workflow(workflow_id, definition, created_by)?)
    }

    /// Append a workflow version after host revalidation of exact skill pins on referenced roles.
    pub fn update_custom_workflow_with_trusted_skills(
        &self,
        workflow_id: &str,
        definition: runalith_domain::workflow::CustomWorkflowDefinition,
        created_by: &str,
        resolver: &dyn TrustedSkillResolver,
    ) -> Result<CustomWorkflowVersion, RuntimeError> {
        Ok(self.store.update_custom_workflow_with_trusted_skills(
            workflow_id,
            definition,
            created_by,
            resolver,
        )?)
    }

    /// Read an exact or latest custom workflow version.
    pub fn get_custom_workflow(
        &self,
        workflow_id: &str,
        version: Option<u32>,
    ) -> Result<CustomWorkflowVersion, RuntimeError> {
        Ok(self.store.get_custom_workflow(workflow_id, version)?)
    }

    /// List bounded custom workflow catalog versions.
    pub fn list_custom_workflows(
        &self,
        include_versions: bool,
        limit: u64,
    ) -> Result<Vec<CustomWorkflowVersion>, RuntimeError> {
        Ok(self.store.list_custom_workflows(include_versions, limit)?)
    }

    /// Persist the first immutable workflow policy version under an authenticated catalog actor.
    pub fn create_workflow_policy(
        &self,
        definition: WorkflowPolicyDefinition,
        created_by: &str,
    ) -> Result<WorkflowPolicyVersion, RuntimeError> {
        Ok(self.store.create_workflow_policy(definition, created_by)?)
    }

    /// Append an immutable workflow policy version; previous versions remain pinned.
    pub fn update_workflow_policy(
        &self,
        policy_id: &str,
        definition: WorkflowPolicyDefinition,
        updated_by: &str,
    ) -> Result<WorkflowPolicyVersion, RuntimeError> {
        Ok(self
            .store
            .update_workflow_policy(policy_id, definition, updated_by)?)
    }

    /// Read an exact immutable policy version with content-integrity verification.
    pub fn get_workflow_policy(
        &self,
        policy_id: &str,
        version: Option<u32>,
    ) -> Result<WorkflowPolicyVersion, RuntimeError> {
        Ok(self.store.get_workflow_policy(policy_id, version)?)
    }

    /// List a bounded immutable policy catalog.
    pub fn list_workflow_policies(
        &self,
        include_versions: bool,
        limit: u64,
        query: Option<&str>,
    ) -> Result<Vec<WorkflowPolicyVersion>, RuntimeError> {
        Ok(self
            .store
            .list_workflow_policies(include_versions, limit, query)?)
    }

    /// Attach an exact policy version and persist its deterministic composed success contract.
    pub fn attach_workflow_policy(
        &self,
        workflow_id: &str,
        policy_id: &str,
        version: Option<u32>,
        base_contract: Value,
        attached_by: &str,
    ) -> Result<WorkflowPolicyAttachment, RuntimeError> {
        Ok(self.store.attach_workflow_policy(
            workflow_id,
            policy_id,
            version,
            base_contract,
            attached_by,
        )?)
    }

    /// Read the latest integrity-checked composed success-contract snapshot.
    pub fn get_workflow_success_contract(
        &self,
        workflow_id: &str,
    ) -> Result<Option<runalith_store::WorkflowSuccessContractSnapshot>, RuntimeError> {
        Ok(self.store.get_workflow_success_contract(workflow_id)?)
    }

    /// Compile and persist an immutable plan from exact catalog role snapshots.
    pub fn compile_custom_workflow(
        &self,
        workflow_id: &str,
        version: Option<u32>,
        created_by: &str,
    ) -> Result<CustomWorkflowPlanRecord, RuntimeError> {
        Ok(self
            .store
            .compile_custom_workflow(workflow_id, version, created_by)?)
    }

    /// Compile a workflow after host revalidation of every exact trusted skill pin.
    pub fn compile_custom_workflow_with_trusted_skills(
        &self,
        workflow_id: &str,
        version: Option<u32>,
        created_by: &str,
        resolver: &dyn TrustedSkillResolver,
    ) -> Result<CustomWorkflowPlanRecord, RuntimeError> {
        Ok(self.store.compile_custom_workflow_with_trusted_skills(
            workflow_id,
            version,
            created_by,
            resolver,
        )?)
    }

    /// Read and re-verify a persisted immutable custom workflow plan.
    pub fn get_custom_workflow_plan(
        &self,
        plan_id: &str,
    ) -> Result<CustomWorkflowPlanRecord, RuntimeError> {
        Ok(self.store.get_custom_workflow_plan(plan_id)?)
    }

    /// Read one workflow and its current task/event projection.
    pub fn get_workflow(&self, workflow_id: &str) -> Result<WorkflowView, RuntimeError> {
        Ok(self.store.get_workflow(workflow_id)?)
    }

    /// Capture one coherent, read-only workflow/task/attempt/event projection.
    pub fn inspect_workflow_read_snapshot(
        &self,
        workflow_id: &str,
        event_limit: usize,
    ) -> Result<WorkflowReadSnapshot, RuntimeError> {
        Ok(self
            .store
            .inspect_workflow_read_snapshot(workflow_id, event_limit)?)
    }

    /// Check the live workflow store without creating or migrating it.
    pub fn check_readiness(&self) -> Result<(), RuntimeError> {
        self.store.check_readiness()?;
        Ok(())
    }

    /// List active workflows for read-only host discovery.
    pub fn list_active_workflows(&self, limit: usize) -> Result<Vec<WorkflowView>, RuntimeError> {
        Ok(self.store.list_active_workflows(limit)?)
    }

    /// Return a bounded, read-only coordinator projection of dependency-ready tasks.
    pub fn list_ready_tasks(&self, limit: u64) -> Result<Vec<ReadyTask>, RuntimeError> {
        Ok(self.store.list_ready_tasks(limit)?)
    }

    /// Read a bounded chronological event slice for one workflow.
    pub fn list_workflow_events(
        &self,
        workflow_id: &str,
        limit: usize,
    ) -> Result<Vec<WorkflowEvent>, RuntimeError> {
        Ok(self.store.list_workflow_events(workflow_id, limit)?)
    }

    /// Inspect durable ownership metadata for one current task attempt.
    /// Host runtime-session inventory remains a separate authoritative source.
    pub fn inspect_task_attempt(
        &self,
        workflow_id: &str,
        task_id: &str,
    ) -> Result<TaskAttemptSnapshot, RuntimeError> {
        Ok(self.store.inspect_task_attempt(workflow_id, task_id)?)
    }

    /// Bind an authenticated runtime session to the exact active lease.
    /// The verifier is mandatory and Store rechecks the lease under IMMEDIATE
    /// transaction before appending the immutable binding event.
    pub fn bind_runtime_session(
        &self,
        workflow_id: &str,
        task_id: &str,
        request: RuntimeSessionBindingRequest,
        verifier: &dyn RuntimeSessionBindingVerifier,
    ) -> Result<RuntimeSessionBinding, RuntimeError> {
        let current = self.store.inspect_task_attempt(workflow_id, task_id)?;
        verifier.verify_binding(&current, &request)?;
        Ok(self
            .store
            .record_runtime_session_binding(workflow_id, task_id, request)?)
    }

    /// Persist a Rust-native agent session in the same workflow event journal.
    pub fn create_agent_session(
        &self,
        workflow_id: &str,
        task_id: &str,
        request: AgentSessionCreateRequest,
    ) -> Result<AgentSessionRecord, RuntimeError> {
        Ok(self
            .store
            .create_agent_session(workflow_id, task_id, request)?)
    }

    /// Read a bounded, ACL-filtered list of durable session projections.
    pub fn list_agent_sessions(
        &self,
        workflow_id: Option<&str>,
        task_id: Option<&str>,
        state: Option<&str>,
        limit: u64,
    ) -> Result<Vec<AgentSessionRecord>, RuntimeError> {
        Ok(self
            .store
            .list_agent_sessions(workflow_id, task_id, state, limit)?)
    }

    /// Read one session and bounded message/ACL history under OBSERVE permission.
    pub fn inspect_agent_session(
        &self,
        session_id: &str,
        actor_role: &str,
        include_revoked_access: bool,
        message_limit: u64,
    ) -> Result<AgentSessionInspection, RuntimeError> {
        Ok(self.store.inspect_agent_session(
            session_id,
            actor_role,
            include_revoked_access,
            message_limit,
        )?)
    }

    /// Update session lifecycle using an expected logical attempt fence.
    pub fn update_agent_session(
        &self,
        session_id: &str,
        expected_attempt: u64,
        state: &str,
        current_turn_id: Option<&str>,
        heartbeat: bool,
    ) -> Result<AgentSessionRecord, RuntimeError> {
        Ok(self.store.update_agent_session(
            session_id,
            expected_attempt,
            state,
            current_turn_id,
            heartbeat,
        )?)
    }

    /// Grant an explicit role-scoped session permission.
    pub fn grant_session_access(
        &self,
        session_id: &str,
        request: SessionAccessRequest,
    ) -> Result<String, RuntimeError> {
        Ok(self.store.grant_session_access(session_id, request)?)
    }

    /// Revoke an explicit role-scoped session permission.
    pub fn revoke_session_access(
        &self,
        access_id: &str,
        actor: &str,
    ) -> Result<bool, RuntimeError> {
        Ok(self.store.revoke_session_access(access_id, actor)?)
    }

    /// Attach to a session under OBSERVE, INTERACT or TAKEOVER permission.
    pub fn attach_agent_session(
        &self,
        session_id: &str,
        actor_role: &str,
        mode: &str,
    ) -> Result<SessionAttachment, RuntimeError> {
        Ok(self
            .store
            .attach_agent_session(session_id, actor_role, mode)?)
    }

    /// Take over only a PAUSED/STALE/FAILED session with an explicit non-owner grant.
    pub fn takeover_agent_session(
        &self,
        session_id: &str,
        actor_role: &str,
        reason: &str,
    ) -> Result<AgentSessionRecord, RuntimeError> {
        Ok(self
            .store
            .takeover_agent_session(session_id, actor_role, reason)?)
    }

    /// Enqueue a detached, deduplicated COS-AP session message.
    pub fn enqueue_session_message(
        &self,
        session_id: &str,
        request: SessionMessageRequest,
    ) -> Result<SessionMessageRecord, RuntimeError> {
        Ok(self.store.enqueue_session_message(session_id, request)?)
    }

    /// Claim a queued message. Expired claims are fenced to UNCERTAIN, never replayed.
    pub fn claim_session_message(
        &self,
        message_id: &str,
        recipient_role: &str,
        lease_seconds: u64,
    ) -> Result<Option<SessionMessageRecord>, RuntimeError> {
        Ok(self
            .store
            .claim_session_message(message_id, recipient_role, lease_seconds)?)
    }

    /// Persist transport-start intent before invoking any external delivery hook.
    pub fn record_session_message_delivery_start(
        &self,
        message_id: &str,
        attempt: u64,
        lease_until: &str,
    ) -> Result<(), RuntimeError> {
        Ok(self
            .store
            .record_session_message_delivery_start(message_id, attempt, lease_until)?)
    }

    /// Persist a successful receipt bound to the exact session message claim.
    pub fn record_session_message_receipt(
        &self,
        message_id: &str,
        attempt: u64,
        lease_until: &str,
        receipt: SessionDeliveryReceipt,
    ) -> Result<(), RuntimeError> {
        Ok(self
            .store
            .record_session_message_receipt(message_id, attempt, lease_until, receipt)?)
    }

    /// Acknowledge an exact, unexpired message claim.
    pub fn acknowledge_session_message(
        &self,
        message_id: &str,
        recipient_role: &str,
        attempt: u64,
        lease_until: &str,
    ) -> Result<SessionMessageRecord, RuntimeError> {
        Ok(self.store.acknowledge_session_message(
            message_id,
            recipient_role,
            attempt,
            lease_until,
        )?)
    }

    /// Persist ambiguous external delivery as unresolved; no retry is triggered.
    pub fn mark_session_message_uncertain(
        &self,
        message_id: &str,
        attempt: u64,
        reason: &str,
    ) -> Result<SessionMessageRecord, RuntimeError> {
        Ok(self
            .store
            .mark_session_message_uncertain(message_id, attempt, reason)?)
    }

    /// Classify ownership using durable attempt state and an injected authoritative runtime snapshot.
    /// Missing durable session linkage remains UNKNOWN; absence is never inferred from missing metadata.
    pub fn classify_task_attempt_ownership(
        &self,
        workflow_id: &str,
        task_id: &str,
        runtime: RecoveryRuntimeEvidence<'_>,
    ) -> Result<AttemptOwnership, RuntimeError> {
        let snapshot = self.store.inspect_task_attempt(workflow_id, task_id)?;
        if snapshot.attempt == 0 || !snapshot.history_complete {
            return Ok(AttemptOwnership::Unknown);
        }
        let Some(plan_sha256) = snapshot.plan_sha256.as_deref() else {
            return Ok(AttemptOwnership::Unknown);
        };
        let plan_sha256 = plan_sha256.to_owned();
        let historical_attempt = snapshot.attempt_ledger.iter().find(|entry| {
            entry.attempt == snapshot.attempt && entry.owner_epoch == snapshot.owner_epoch
        });
        let lease_id = match (snapshot.lease_id.as_ref(), historical_attempt) {
            (Some(current), Some(historical)) if current == &historical.lease_id => {
                Some(current.clone())
            }
            (None, Some(historical)) => Some(historical.lease_id.clone()),
            _ => return Ok(AttemptOwnership::Unknown),
        };
        let session = match snapshot.session_binding.as_ref() {
            Some(binding)
                if binding.runtime_id == runtime.expected_runtime_id
                    && binding.attempt == snapshot.attempt
                    && binding.owner_epoch == snapshot.owner_epoch =>
            {
                RecoveryManager::observe_session(
                    runtime.snapshot,
                    &binding.runtime_id,
                    &binding.session_id,
                    runtime.now_ms,
                    runtime.maximum_snapshot_age_ms,
                )
            }
            _ => Observation::Unknown,
        };
        let lease = if snapshot.lease_id.is_some() {
            Observation::Authoritative(LeaseObservation::Active)
        } else if snapshot.result.is_some()
            && matches!(
                snapshot.state,
                TaskState::Succeeded
                    | TaskState::Failed
                    | TaskState::Cancelled
                    | TaskState::Unknown
            )
        {
            // A persisted terminal result closes the durable lease lifecycle.
            // Absence of a lease on its own is never evidence of worker death.
            Observation::Authoritative(LeaseObservation::Absent)
        } else {
            Observation::Unknown
        };
        let provider = match (
            snapshot.state,
            snapshot.provider_intent.as_ref().map(|intent| intent.state),
        ) {
            (TaskState::Unknown, _) | (_, Some(ProviderDispatchState::Unknown)) => {
                Observation::Authoritative(ProviderObservation::Unresolved)
            }
            (_, None) => Observation::Authoritative(ProviderObservation::NotDispatched),
            (_, Some(ProviderDispatchState::Rejected)) => {
                Observation::Authoritative(ProviderObservation::AuthoritativeTerminal)
            }
            (_, Some(ProviderDispatchState::Reserved | ProviderDispatchState::Accepted)) => {
                Observation::Authoritative(ProviderObservation::Unresolved)
            }
        };
        Ok(RecoveryManager::classify_attempt(
            &AttemptRecoveryEvidence {
                lineage: AttemptLineage {
                    workflow_id: snapshot.workflow_id,
                    task_id: snapshot.task_id,
                    attempt: snapshot.attempt,
                    owner_epoch: snapshot.owner_epoch,
                    plan_sha256,
                    lease_id,
                    session_id: snapshot
                        .session_binding
                        .as_ref()
                        .map(|binding| binding.session_id.clone()),
                    provider_intent_id: snapshot.provider_intent.map(|intent| intent.intent_id),
                },
                lease,
                session,
                provider,
            },
        ))
    }

    /// Classify against an authenticated runtime inventory and atomically
    /// compare-and-record the exact durable lineage. The operation appends an
    /// audit observation only; it never mutates task/session/provider lifecycle.
    pub fn classify_and_record_recovery_decision(
        &self,
        workflow_id: &str,
        task_id: &str,
        runtime: RecoveryRuntimeEvidence<'_>,
        verifier: &dyn RecoveryDecisionVerifier,
    ) -> Result<(AttemptOwnership, RecoveryDecisionRecord), RuntimeError> {
        if runtime.snapshot.runtime_id != runtime.expected_runtime_id
            || !runtime.snapshot.complete
            || runtime.snapshot.generation == 0
            || runtime.now_ms < runtime.snapshot.captured_at_ms
            || runtime
                .now_ms
                .saturating_sub(runtime.snapshot.captured_at_ms)
                > runtime.maximum_snapshot_age_ms
        {
            return Err(RuntimeError::Invariant(
                "recovery decision requires a fresh, complete, identity-matched runtime inventory"
                    .into(),
            ));
        }
        let durable = self.store.inspect_task_attempt(workflow_id, task_id)?;
        if durable.attempt == 0 || !durable.history_complete {
            return Err(RuntimeError::Invariant(
                "recovery decision requires complete durable attempt history".into(),
            ));
        }
        let plan_sha256 = durable.plan_sha256.clone().ok_or_else(|| {
            RuntimeError::Invariant("recovery decision requires an immutable approved plan".into())
        })?;
        let event_head_sha256 = durable.event_head_sha256.clone();
        let decision = self.classify_task_attempt_ownership(workflow_id, task_id, runtime)?;
        let decision_code = match decision {
            AttemptOwnership::Owned => "OWNED",
            AttemptOwnership::NoKnownOwner => "NO_KNOWN_OWNER",
            AttemptOwnership::Unknown => "UNKNOWN",
            AttemptOwnership::Unresolved => "UNRESOLVED",
        };
        let evidence_sha256 = content_hash(runtime.snapshot)
            .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
        let request = RecoveryDecisionRecordRequest {
            expected_task_state: format!("{:?}", durable.state).to_ascii_uppercase(),
            attempt: durable.attempt,
            owner_epoch: durable.owner_epoch,
            plan_sha256,
            event_head_sha256,
            provider_intent_id: durable
                .provider_intent
                .as_ref()
                .map(|intent| intent.intent_id.clone()),
            provider_state: durable
                .provider_intent
                .as_ref()
                .map(|intent| format!("{:?}", intent.state).to_ascii_uppercase()),
            session_id: durable
                .session_binding
                .as_ref()
                .map(|binding| binding.session_id.clone()),
            lease_id: durable.lease_id.clone(),
            runtime_id: runtime.expected_runtime_id.to_owned(),
            runtime_generation: runtime.snapshot.generation,
            runtime_captured_at_ms: runtime.snapshot.captured_at_ms,
            observed_at_ms: runtime.now_ms,
            decision: decision_code.into(),
            evidence_sha256,
        };
        let record =
            self.store
                .record_recovery_decision(workflow_id, task_id, request, verifier)?;
        Ok((decision, record))
    }

    /// Verify and persist approval over the exact current proposal and plan hashes.
    pub fn approve(
        &self,
        workflow_id: &str,
        request: ApprovalRequest,
    ) -> Result<WorkflowView, RuntimeError> {
        Ok(self
            .store
            .approve(workflow_id, request, self.approval_verifier.as_ref())?)
    }

    /// Admit a workflow after transactionally revalidating approval and policy pins.
    /// Claim revalidates again; this checkpoint does not authorize worker dispatch.
    pub fn admit_workflow(&self, workflow_id: &str) -> Result<WorkflowView, RuntimeError> {
        Ok(self
            .store
            .admit_workflow(workflow_id, self.approval_verifier.as_ref())?)
    }

    /// Claim a task only after exact current approval and dependency success.
    pub fn claim_task(
        &self,
        workflow_id: &str,
        task_id: &str,
        request: ClaimRequest,
    ) -> Result<TaskLease, RuntimeError> {
        if request.worker_id.trim().is_empty() {
            return Err(RuntimeError::InvalidWorker);
        }
        if !(1..=600).contains(&request.lease_ttl_seconds) {
            return Err(RuntimeError::InvalidLeaseTtl);
        }
        Ok(self.store.claim_task(
            workflow_id,
            task_id,
            request,
            self.approval_verifier.as_ref(),
        )?)
    }

    /// Execute one approval-revalidated coordinator tick; never dispatches work.
    pub fn coordinator_claim_next(
        &self,
        request: CoordinatorRequest,
        worker_verifier: &dyn CoordinatorWorkerVerifier,
    ) -> Result<Option<TaskLease>, RuntimeError> {
        if request.worker_id.trim().is_empty() {
            return Err(RuntimeError::InvalidWorker);
        }
        if !(1..=600).contains(&request.lease_ttl_seconds) {
            return Err(RuntimeError::InvalidLeaseTtl);
        }
        Ok(self.store.coordinator_claim_next(
            request,
            self.approval_verifier.as_ref(),
            worker_verifier,
        )?)
    }

    /// Request cancellation through an explicitly supplied authenticated host verifier.
    pub fn cancel_workflow(
        &self,
        workflow_id: &str,
        request: WorkflowCancellationRequest,
        verifier: &dyn WorkflowCancellationVerifier,
    ) -> Result<WorkflowView, RuntimeError> {
        Ok(self.store.cancel_workflow(workflow_id, request, verifier)?)
    }

    /// Persist a fenced result. Success requires content-addressed evidence.
    pub fn record_task_result(
        &self,
        workflow_id: &str,
        task_id: &str,
        request: TaskResultRequest,
    ) -> Result<WorkflowView, RuntimeError> {
        Ok(self
            .store
            .record_task_result(workflow_id, task_id, request)?)
    }

    /// Persist a task result after host-authenticated producer verification.
    pub fn record_task_result_authenticated(
        &self,
        workflow_id: &str,
        task_id: &str,
        request: TaskResultRequest,
        verifier: &dyn TaskResultProducerVerifier,
    ) -> Result<WorkflowView, RuntimeError> {
        Ok(self
            .store
            .record_task_result_authenticated(workflow_id, task_id, request, verifier)?)
    }

    /// Atomically ingest a host-authenticated immutable result envelope and its fenced result.
    pub fn record_task_result_envelope(
        &self,
        workflow_id: &str,
        task_id: &str,
        envelope: TaskResultEnvelope,
        verifier: &dyn TaskResultProducerVerifier,
    ) -> Result<WorkflowView, RuntimeError> {
        Ok(self
            .store
            .record_task_result_envelope(workflow_id, task_id, envelope, verifier)?)
    }

    /// Reconstruct and retain a deterministic synthesis from persisted workflow evidence.
    pub fn synthesize_workflow(&self, workflow_id: &str) -> Result<Value, RuntimeError> {
        Ok(self.store.synthesize_workflow(workflow_id)?)
    }

    /// Reserve and dispatch one provider request exactly once for an approved, fenced attempt.
    /// Existing intents (including RESERVED/UNKNOWN) are returned without another provider call.
    pub fn dispatch_provider_task(
        &self,
        workflow_id: &str,
        task_id: &str,
        lease_id: &str,
        worker_id: &str,
        provider: &dyn ProviderAdapter,
        mut payload: Value,
    ) -> Result<ProviderIntentRecord, RuntimeError> {
        let current = self.store.get_workflow(workflow_id)?;
        if current.state != runalith_domain::WorkflowState::Executing {
            return Err(RuntimeError::ApprovalRequired);
        }
        let task = current
            .tasks
            .iter()
            .find(|task| task.definition.task_id == task_id)
            .ok_or_else(|| RuntimeError::Invariant(format!("unknown task {task_id}")))?;
        if task.attempts == 0 {
            return Err(StoreError::LeaseFenced.into());
        }
        let plan_sha256 = current
            .plan_hash
            .clone()
            .ok_or(RuntimeError::ApprovalRequired)?;
        // GitHub's workflow run-name marker must equal the durable intent key.
        // Derive that key from the provider request with the marker removed,
        // then pin the completed payload digest after inserting the marker.
        // This avoids an impossible self-referential digest while preserving
        // exact immutable bytes in the durable intent.
        let idempotency_payload_sha256 = if provider.provider_id() == "github-actions" {
            let inputs = payload
                .get_mut("inputs")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| {
                    RuntimeError::Invariant(
                        "GitHub Actions payload requires an inputs object".into(),
                    )
                })?;
            inputs.remove("runalith_intent_id");
            content_hash(&payload).map_err(|error| RuntimeError::Invariant(error.to_string()))?
        } else {
            content_hash(&payload).map_err(|error| RuntimeError::Invariant(error.to_string()))?
        };
        let idempotency_material = serde_json::json!({
            "provider_id":provider.provider_id(),"workflow_id":workflow_id,"task_id":task_id,
            "attempt":task.attempts,"lease_id":lease_id,"worker_id":worker_id,
            "plan_sha256":plan_sha256,"request_sha256":idempotency_payload_sha256
        });
        let idempotency_key = format!(
            "runalith-{}",
            content_hash(&idempotency_material)
                .map_err(|error| RuntimeError::Invariant(error.to_string()))?
        );
        if provider.provider_id() == "github-actions" {
            let inputs = payload
                .get_mut("inputs")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| {
                    RuntimeError::Invariant(
                        "GitHub Actions payload requires an inputs object".into(),
                    )
                })?;
            if inputs
                .get("runalith_intent_id")
                .and_then(Value::as_str)
                .is_some_and(|value| value != idempotency_key)
            {
                return Err(RuntimeError::Invariant("caller-supplied GitHub intent marker conflicts with the derived durable idempotency key".into()));
            }
            inputs.insert(
                "runalith_intent_id".into(),
                Value::String(idempotency_key.clone()),
            );
        }
        let payload_bytes = serde_json::to_vec(&payload)
            .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
        if payload_bytes.len() > 1_048_576 {
            return Err(RuntimeError::Invariant(
                "provider payload exceeds 1 MiB".into(),
            ));
        }
        let request_sha256 =
            content_hash(&payload).map_err(|error| RuntimeError::Invariant(error.to_string()))?;
        let intent_request = ProviderIntentRequest {
            workflow_id: workflow_id.into(),
            task_id: task_id.into(),
            attempt: task.attempts,
            provider_id: provider.provider_id().into(),
            idempotency_key: idempotency_key.clone(),
            lease_id: lease_id.into(),
            worker_id: worker_id.into(),
            plan_sha256: plan_sha256.clone(),
            request_sha256: request_sha256.clone(),
            payload: Some(payload.clone()),
        };
        let reservation = self
            .store
            .reserve_provider_dispatch(intent_request, self.approval_verifier.as_ref())?;
        if !reservation.created {
            self.apply_provider_terminal_outcome(&reservation.record)?;
            return Ok(reservation.record);
        }
        let request = ProviderDispatchRequest {
            provider_id: provider.provider_id().into(),
            idempotency_key,
            workflow_id: workflow_id.into(),
            task_id: task_id.into(),
            attempt: task.attempts,
            lease_id: lease_id.into(),
            worker_id: worker_id.into(),
            plan_sha256,
            request_sha256,
            payload,
        };
        let outcome = match request
            .validate_against_intent(&reservation.record)
            .and_then(|()| provider.dispatch(&request))
        {
            Ok(ProviderDispatchResponse::Accepted { provider_run_id }) => {
                ProviderIntentOutcome::Accepted { provider_run_id }
            }
            Ok(ProviderDispatchResponse::Rejected {
                reason_code,
                diagnostic,
            }) => ProviderIntentOutcome::Rejected {
                reason_code,
                diagnostic,
            },
            Ok(ProviderDispatchResponse::Unknown { diagnostic }) => {
                ProviderIntentOutcome::Unknown { diagnostic }
            }
            Err(ProviderAdapterError::NotSent(diagnostic)) => ProviderIntentOutcome::Rejected {
                reason_code: "NOT_SENT".into(),
                diagnostic,
            },
            Err(ProviderAdapterError::Ambiguous(diagnostic)) => {
                ProviderIntentOutcome::Unknown { diagnostic }
            }
        };
        let record = self
            .store
            .record_provider_dispatch_outcome(&reservation.record.intent_id, outcome)?;
        self.apply_provider_terminal_outcome(&record)?;
        Ok(record)
    }

    /// Reconcile an existing provider intent without dispatching or replaying work.
    /// Lookup results are retained as immutable evidence. UNKNOWN remains terminal.
    pub fn reconcile_provider_dispatch_intent(
        &self,
        intent_id: &str,
        provider: &dyn ProviderAdapter,
    ) -> Result<(ProviderIntentRecord, ProviderReconciliationObservation), RuntimeError> {
        let mut intent = self.store.get_provider_dispatch_intent(intent_id)?;
        if intent.request.provider_id != provider.provider_id() {
            return Err(RuntimeError::Invariant(
                "provider adapter does not match persisted intent provider_id".into(),
            ));
        }
        let lookup = if intent.request.payload.is_none() {
            runalith_providers::ProviderLookupResponse::Unknown {
                diagnostic: "legacy provider intent has no persisted exact payload or destination binding; lookup cannot establish a trustworthy remote identity".into(),
            }
        } else {
            match provider.lookup(&intent) {
                Ok(runalith_providers::ProviderLookupResponse::NotFound {
                    authoritative: false,
                    ..
                }) => runalith_providers::ProviderLookupResponse::Unknown {
                    diagnostic: "provider lookup returned non-authoritative absence".into(),
                },
                Ok(response) => response,
                Err(ProviderAdapterError::Ambiguous(diagnostic)) => {
                    runalith_providers::ProviderLookupResponse::Unknown { diagnostic }
                }
                Err(ProviderAdapterError::NotSent(diagnostic)) => {
                    runalith_providers::ProviderLookupResponse::Unknown {
                        diagnostic: format!("lookup not performed: {diagnostic}"),
                    }
                }
            }
        };
        let observed_run_id = match &lookup {
            runalith_providers::ProviderLookupResponse::Found {
                outcome: ProviderDispatchResponse::Accepted { provider_run_id },
                ..
            } => Some(provider_run_id.clone()),
            _ => None,
        };
        let observation = self.store.record_provider_reconciliation_observation(
            intent_id,
            serde_json::to_value(&lookup)
                .map_err(|error| RuntimeError::Invariant(error.to_string()))?,
            observed_run_id,
        )?;

        // Only RESERVED can be finalized by a lookup result. UNKNOWN is deliberately immutable.
        if intent.state == ProviderDispatchState::Reserved {
            if let runalith_providers::ProviderLookupResponse::Found { outcome, .. } = lookup {
                let outcome = match outcome {
                    ProviderDispatchResponse::Accepted { provider_run_id } => {
                        ProviderIntentOutcome::Accepted { provider_run_id }
                    }
                    ProviderDispatchResponse::Rejected {
                        reason_code,
                        diagnostic,
                    } => ProviderIntentOutcome::Rejected {
                        reason_code,
                        diagnostic,
                    },
                    ProviderDispatchResponse::Unknown { diagnostic } => {
                        ProviderIntentOutcome::Unknown { diagnostic }
                    }
                };
                intent = self
                    .store
                    .record_provider_dispatch_outcome(intent_id, outcome)?;
                self.apply_provider_terminal_outcome(&intent)?;
            }
        }
        intent = self.store.get_provider_dispatch_intent(intent_id)?;
        Ok((intent, observation))
    }

    /// Claim and execute one plan-pinned command in Bubblewrap, then persist its output artifact.
    /// The immutable task inputs must contain the exact `sandbox_command` JSON and require only
    /// `sandbox_execution` evidence. There is no direct-process fallback.
    pub fn execute_sandboxed_task(
        &self,
        invocation: SandboxTaskExecutionRequest,
        sandbox: &dyn SandboxExecutor,
        artifacts: &ArtifactStore,
    ) -> Result<WorkflowView, RuntimeError> {
        let SandboxTaskExecutionRequest {
            workflow_id,
            task_id,
            worker_id,
            lease_ttl_seconds,
            command,
        } = invocation;
        let current = self.store.get_workflow(&workflow_id)?;
        let task = current
            .tasks
            .iter()
            .find(|task| task.definition.task_id == task_id)
            .ok_or_else(|| RuntimeError::Invariant(format!("unknown task {task_id}")))?;
        let pinned_request = task
            .definition
            .inputs
            .get("sandbox_command")
            .ok_or_else(|| {
                RuntimeError::Invariant("task plan does not pin sandbox_command".into())
            })?;
        let request_value = serde_json::to_value(&command)
            .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
        if pinned_request != &request_value {
            return Err(RuntimeError::Invariant(
                "sandbox command differs from immutable approved task inputs".into(),
            ));
        }
        if task.definition.required_evidence.as_slice() != ["sandbox_execution"] {
            return Err(RuntimeError::Invariant(
                "sandbox task must require exactly sandbox_execution evidence".into(),
            ));
        }
        let lease = self.claim_task(
            &workflow_id,
            &task_id,
            ClaimRequest {
                worker_id,
                lease_ttl_seconds,
            },
        )?;
        let (outcome, evidence, error) = match sandbox.execute(command) {
            Ok(result) => {
                let artifact_bytes = serde_json::to_vec(&result)
                    .map_err(|error| RuntimeError::Invariant(error.to_string()))?;
                let artifact = match artifacts.put("application/json", &artifact_bytes) {
                    Ok(artifact) => artifact,
                    Err(error) => {
                        return Ok(self.store.record_task_result(&workflow_id, &task_id, TaskResultRequest {
                            lease_id: lease.lease_id, worker_id: lease.worker_id, attempt: lease.attempt,
                            outcome: TaskOutcome::Unknown, evidence: vec![],
                            error: Some(format!("sandbox process completed but output artifact persistence failed: {error}")),
                        })?);
                    }
                };
                let evidence = vec![EvidenceRef {
                    artifact_id: artifact.artifact_id,
                    sha256: artifact.sha256,
                    producer_task_id: task_id.clone(),
                    producer_attempt: lease.attempt,
                    kind: "sandbox_execution".into(),
                }];
                if result.timed_out {
                    (
                        TaskOutcome::Failed,
                        evidence,
                        Some("sandbox command exceeded its wall-clock timeout".into()),
                    )
                } else if result.stdout_truncated || result.stderr_truncated {
                    (
                        TaskOutcome::Failed,
                        evidence,
                        Some("sandbox output exceeded the evidence capture limit".into()),
                    )
                } else if result.exit_code == Some(0) {
                    (TaskOutcome::Succeeded, evidence, None)
                } else {
                    (
                        TaskOutcome::Failed,
                        evidence,
                        Some(format!(
                            "sandbox command exited with code {:?}; see content-addressed sandbox evidence",
                            result.exit_code
                        )),
                    )
                }
            }
            Err(SandboxError::ProcessUnknown(diagnostic)) => {
                (TaskOutcome::Unknown, vec![], Some(diagnostic))
            }
            Err(error) => (TaskOutcome::Failed, vec![], Some(error.to_string())),
        };
        Ok(self.store.record_task_result(
            &workflow_id,
            &task_id,
            TaskResultRequest {
                lease_id: lease.lease_id,
                worker_id: lease.worker_id,
                attempt: lease.attempt,
                outcome,
                evidence,
                error,
            },
        )?)
    }

    fn apply_provider_terminal_outcome(
        &self,
        record: &ProviderIntentRecord,
    ) -> Result<(), RuntimeError> {
        let (outcome, diagnostic) = match record.outcome.as_ref() {
            Some(ProviderIntentOutcome::Unknown { diagnostic }) => {
                (TaskOutcome::Unknown, diagnostic.clone())
            }
            Some(ProviderIntentOutcome::Rejected {
                reason_code,
                diagnostic,
            }) => (TaskOutcome::Failed, format!("{reason_code}: {diagnostic}")),
            _ => return Ok(()),
        };
        let current = self.store.get_workflow(&record.request.workflow_id)?;
        let Some(task) = current
            .tasks
            .iter()
            .find(|task| task.definition.task_id == record.request.task_id)
        else {
            return Err(RuntimeError::Invariant(
                "provider intent task disappeared".into(),
            ));
        };
        if task.state != runalith_domain::TaskState::Running {
            if task.attempts == record.request.attempt && task.state == outcome.task_state() {
                return Ok(());
            }
            return Err(StoreError::LeaseFenced.into());
        }
        self.store.record_task_result(
            &record.request.workflow_id,
            &record.request.task_id,
            TaskResultRequest {
                lease_id: record.request.lease_id.clone(),
                worker_id: record.request.worker_id.clone(),
                attempt: record.request.attempt,
                outcome,
                evidence: Vec::new(),
                error: Some(diagnostic),
            },
        )?;
        Ok(())
    }

    /// Convert expired active leases to `UNKNOWN`; never replay them automatically.
    pub fn quarantine_expired_leases(&self) -> Result<usize, RuntimeError> {
        Ok(self.store.quarantine_expired_leases()?)
    }

    /// Verify event-journal continuity and content hashes without mutation.
    pub fn verify_event_chain(
        &self,
        workflow_id: &str,
    ) -> Result<EventChainVerification, RuntimeError> {
        Ok(self.store.verify_event_chain(workflow_id)?)
    }

    /// Read every durable provider dispatch intent for one workflow.
    pub fn list_provider_dispatch_intents(
        &self,
        workflow_id: &str,
    ) -> Result<Vec<ProviderIntentRecord>, RuntimeError> {
        Ok(self.store.list_provider_dispatch_intents(workflow_id)?)
    }

    /// Read one immutable provider dispatch intent for host reconciliation routing.
    pub fn get_provider_dispatch_intent(
        &self,
        intent_id: &str,
    ) -> Result<ProviderIntentRecord, RuntimeError> {
        Ok(self.store.get_provider_dispatch_intent(intent_id)?)
    }

    /// Read append-only provider lookup observations for one intent.
    pub fn list_provider_reconciliation_observations(
        &self,
        intent_id: &str,
    ) -> Result<Vec<ProviderReconciliationObservation>, RuntimeError> {
        Ok(self
            .store
            .list_provider_reconciliation_observations(intent_id)?)
    }
}

/// Runtime-level errors, including explicit authority and fencing failures.
#[derive(Debug, Error)]
pub enum RuntimeError {
    /// Workflow storage rejected the operation.
    #[error(transparent)]
    Store(StoreError),
    /// No authority verifier has been provisioned.
    #[error("approval authority is not configured; refusing approval")]
    ApprovalAuthorityUnavailable,
    /// Workflow has not been approved by a provisioned verifier.
    #[error("workflow has no verified approval record")]
    ApprovalRequired,
    /// Supplied hashes do not match the exact current candidate.
    #[error("approval does not bind the current proposal and immutable plan")]
    ApprovalBindingMismatch,
    /// Verifier returned malformed or incomplete identity/evidence.
    #[error("approval verifier returned malformed identity or evidence")]
    InvalidVerifierOutput,
    /// Worker identity is empty.
    #[error("worker identity must be a non-empty string")]
    InvalidWorker,
    /// Lease TTL is outside the supported bound.
    #[error("lease TTL must be within 1..=600 seconds")]
    InvalidLeaseTtl,
    /// A runtime invariant was violated.
    #[error("runtime invariant failed: {0}")]
    Invariant(String),
}

impl From<StoreError> for RuntimeError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::ApprovalAuthorityUnavailable => Self::ApprovalAuthorityUnavailable,
            StoreError::ApprovalRequired => Self::ApprovalRequired,
            StoreError::ApprovalBindingMismatch => Self::ApprovalBindingMismatch,
            StoreError::InvalidVerifierOutput => Self::InvalidVerifierOutput,
            error => Self::Store(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    use runalith_artifacts::ArtifactStore;
    use runalith_domain::{
        EvidenceRef, TaskOutcome, TaskSpec, TaskState, WorkflowPlan, WorkflowState,
    };
    use runalith_providers::{
        GitHubActionsAdapter, GitHubActionsDispatch, GitHubActionsLookup, GitHubActionsTarget,
        GitHubActionsTransport, ProviderAdapterError, ProviderDispatchRequest,
        ProviderDispatchResponse, ProviderLookupResponse,
    };
    use runalith_sandbox::{CommandRequest, CommandResult, SandboxError, SandboxExecutor};
    use runalith_trust::trust_config::TRUST_DOMAIN_SPECS;
    use runalith_trust::trust_ledger::TrustConfigurationObserver;
    use runalith_trust::trust_lifecycle::{
        ReviewerIdentity, ReviewerIdentityRepository, ReviewerStatus, TrustConfigurationRepository,
        TrustLifecycleError,
    };
    use serde_json::json;
    use uuid::Uuid;

    const REVIEWER_TEST_PUBLIC_KEY: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAPUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=\n-----END PUBLIC KEY-----\n";

    struct StaticReviewerRepository(ReviewerIdentity);

    impl ReviewerIdentityRepository for StaticReviewerRepository {
        fn current_reviewer(
            &self,
            subject: &str,
        ) -> Result<Option<ReviewerIdentity>, TrustLifecycleError> {
            Ok((self.0.subject == subject).then(|| self.0.clone()))
        }

        fn current_reviewer_in_transaction(
            &self,
            _transaction: &Transaction<'_>,
            subject: &str,
        ) -> Result<Option<ReviewerIdentity>, TrustLifecycleError> {
            self.current_reviewer(subject)
        }

        fn register_reviewer(&self, _: &ReviewerIdentity) -> Result<(), TrustLifecycleError> {
            Ok(())
        }

        fn transition_reviewer(
            &self,
            _: u64,
            _: &ReviewerIdentity,
        ) -> Result<(), TrustLifecycleError> {
            Ok(())
        }
    }

    #[test]
    fn d01_reviewer_verification_requires_active_role_domain_and_matching_trust_root() {
        let key = runalith_trust::Ed25519PublicKey::from_pem(REVIEWER_TEST_PUBLIC_KEY).unwrap();
        let now_ms = chrono::Utc::now().timestamp_millis();
        let identity = ReviewerIdentity {
            subject: "maker@example.invalid".into(),
            key_id: "maker-test-key".into(),
            public_key_pem: REVIEWER_TEST_PUBLIC_KEY.into(),
            public_key_sha256: key.fingerprint().into(),
            role: "maker".into(),
            domains: std::collections::BTreeSet::from(["action_intent_maker".into()]),
            version: 1,
            status: ReviewerStatus::Active,
            registered_at_ms: now_ms - 1_000,
            expires_at_ms: now_ms + 60_000,
            revoked_at_ms: None,
            changed_by: "governance-admin".into(),
            change_reference: "CHANGE-MAKER-IDENTITY".into(),
        };
        let repository = StaticReviewerRepository(identity.clone());
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        let transaction = connection.transaction().unwrap();
        verify_registered_reviewer(
            &repository,
            &transaction,
            &identity.subject,
            "maker",
            "action_intent_maker",
            &identity.public_key_sha256,
            now_ms,
        )
        .unwrap();
        assert!(
            verify_registered_reviewer(
                &repository,
                &transaction,
                &identity.subject,
                "checker",
                "action_intent_maker",
                &identity.public_key_sha256,
                now_ms,
            )
            .is_err()
        );
        assert!(
            verify_registered_reviewer(
                &repository,
                &transaction,
                &identity.subject,
                "maker",
                "execution_approval",
                &identity.public_key_sha256,
                now_ms,
            )
            .is_err()
        );
        assert!(
            verify_registered_reviewer(
                &repository,
                &transaction,
                &identity.subject,
                "maker",
                "action_intent_maker",
                &"0".repeat(64),
                now_ms,
            )
            .is_err()
        );
        let mut suspended = identity;
        suspended.status = ReviewerStatus::Suspended;
        let suspended_repository = StaticReviewerRepository(suspended);
        assert!(
            verify_registered_reviewer(
                &suspended_repository,
                &transaction,
                "maker@example.invalid",
                "maker",
                "action_intent_maker",
                key.fingerprint(),
                now_ms,
            )
            .is_err()
        );
    }

    struct TestVerifier;

    struct TestSessionBindingVerifier;

    struct TestRecoveryDecisionVerifier;

    impl RecoveryDecisionVerifier for TestRecoveryDecisionVerifier {
        fn verify(
            &self,
            _transaction: &Transaction<'_>,
            request: &RecoveryDecisionRecordRequest,
        ) -> Result<(), StoreError> {
            if request.runtime_id != "runtime-test"
                || request.runtime_generation == 0
                || request.evidence_sha256.len() != 64
                || request.decision != "OWNED"
            {
                return Err(StoreError::Invariant(
                    "test recovery verifier rejected inventory binding".into(),
                ));
            }
            Ok(())
        }
    }

    impl RuntimeSessionBindingVerifier for TestSessionBindingVerifier {
        fn verify_binding(
            &self,
            current: &TaskAttemptSnapshot,
            request: &RuntimeSessionBindingRequest,
        ) -> Result<(), RuntimeError> {
            if current.state != TaskState::Running
                || current.attempt != request.attempt
                || current.owner_epoch != request.owner_epoch
                || current.lease_id.as_deref() != Some(request.lease_id.as_str())
                || current.lease_owner.as_deref() != Some(request.worker_id.as_str())
                || request.runtime_id.trim().is_empty()
                || request.session_id.trim().is_empty()
            {
                return Err(RuntimeError::Invariant(
                    "test runtime attestation did not bind exact active lease".into(),
                ));
            }
            Ok(())
        }
    }

    struct FixedBindingResolver {
        binding: Value,
        calls: std::sync::atomic::AtomicUsize,
    }

    impl CandidateBindingResolver for FixedBindingResolver {
        fn resolve_current_binding(
            &self,
            _transaction: &Transaction<'_>,
            proposal: &WorkflowProposal,
            _plan: &runalith_domain::WorkflowPlan,
            _request: &ApprovalRequest,
        ) -> Result<Value, StoreError> {
            assert!(!proposal.workflow_id.is_empty());
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(self.binding.clone())
        }
    }

    impl ApprovalVerifier for TestVerifier {
        fn verify(
            &self,
            _transaction: &Transaction<'_>,
            _proposal: &WorkflowProposal,
            _plan: &WorkflowPlan,
            request: &ApprovalRequest,
            _mode: ApprovalVerificationMode,
        ) -> Result<VerifiedApproval, StoreError> {
            if request.actor.trim().is_empty() || request.evidence["accepted"] != true {
                return Err(StoreError::ApprovalAuthorityUnavailable);
            }
            Ok(VerifiedApproval {
                actor: request.actor.clone(),
                evidence: request.evidence.clone(),
            })
        }
    }

    struct TestTaskResultProducerVerifier;

    impl TaskResultProducerVerifier for TestTaskResultProducerVerifier {
        fn authenticate_producer(
            &self,
            _transaction: &Transaction<'_>,
            _workflow_id: &str,
            _task_id: &str,
            request: &TaskResultRequest,
        ) -> Result<String, StoreError> {
            if request.worker_id == "worker-a" {
                Ok("worker-a".into())
            } else {
                Err(StoreError::InvalidVerifierOutput)
            }
        }
    }

    struct SwitchableVerifier(std::sync::Arc<std::sync::atomic::AtomicBool>);

    impl ApprovalVerifier for SwitchableVerifier {
        fn verify(
            &self,
            transaction: &Transaction<'_>,
            proposal: &WorkflowProposal,
            plan: &WorkflowPlan,
            request: &ApprovalRequest,
            mode: ApprovalVerificationMode,
        ) -> Result<VerifiedApproval, StoreError> {
            if !self.0.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(StoreError::ApprovalAuthorityUnavailable);
            }
            TestVerifier.verify(transaction, proposal, plan, request, mode)
        }
    }

    struct AmbiguousProvider(std::sync::atomic::AtomicUsize);

    impl ProviderAdapter for AmbiguousProvider {
        fn provider_id(&self) -> &'static str {
            "ambiguous-test-provider"
        }

        fn dispatch(
            &self,
            _request: &ProviderDispatchRequest,
        ) -> Result<ProviderDispatchResponse, ProviderAdapterError> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err(ProviderAdapterError::Ambiguous(
                "connection lost after request write".into(),
            ))
        }

        fn lookup(
            &self,
            _intent: &ProviderIntentRecord,
        ) -> Result<ProviderLookupResponse, ProviderAdapterError> {
            Ok(ProviderLookupResponse::Unknown {
                diagnostic: "provider lookup unavailable".into(),
            })
        }
    }

    struct CountingLookupProvider(std::sync::atomic::AtomicUsize);

    struct E2EGitHubTransport {
        lookups: std::sync::Mutex<std::collections::VecDeque<GitHubActionsLookup>>,
        dispatches: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    impl GitHubActionsTransport for E2EGitHubTransport {
        fn lookup_run(
            &self,
            _target: &GitHubActionsTarget,
            _intent_id: &str,
        ) -> Result<GitHubActionsLookup, ProviderAdapterError> {
            self.lookups.lock().unwrap().pop_front().ok_or_else(|| {
                ProviderAdapterError::Ambiguous("E2E GitHub lookup fixture exhausted".into())
            })
        }

        fn dispatch_workflow(
            &self,
            _target: &GitHubActionsTarget,
        ) -> Result<GitHubActionsDispatch, ProviderAdapterError> {
            self.dispatches
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(GitHubActionsDispatch::Accepted)
        }
    }

    impl ProviderAdapter for CountingLookupProvider {
        fn provider_id(&self) -> &'static str {
            "ambiguous-test-provider"
        }

        fn dispatch(
            &self,
            _request: &ProviderDispatchRequest,
        ) -> Result<ProviderDispatchResponse, ProviderAdapterError> {
            panic!("reconciliation must never dispatch")
        }

        fn lookup(
            &self,
            _intent: &ProviderIntentRecord,
        ) -> Result<ProviderLookupResponse, ProviderAdapterError> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(ProviderLookupResponse::Found {
                outcome: ProviderDispatchResponse::Accepted {
                    provider_run_id: "should-not-bind".into(),
                },
                provider_status: Some("queued".into()),
                conclusion: None,
                run_url: None,
            })
        }
    }

    struct FakeSandbox {
        ambiguous: bool,
    }

    impl SandboxExecutor for FakeSandbox {
        fn execute(&self, _request: CommandRequest) -> Result<CommandResult, SandboxError> {
            if self.ambiguous {
                return Err(SandboxError::ProcessUnknown(
                    "test process result lost after spawn".into(),
                ));
            }
            Ok(CommandResult {
                exit_code: Some(0),
                timed_out: false,
                stdout: "sandbox output".into(),
                stderr: String::new(),
                stdout_bytes: b"sandbox output".to_vec(),
                stderr_bytes: vec![],
                stdout_sha256: "a".repeat(64),
                stderr_sha256: "b".repeat(64),
                stdout_truncated: false,
                stderr_truncated: false,
                sandbox_backend: "test-bubblewrap".into(),
            })
        }
    }

    fn service() -> WorkflowService {
        WorkflowService::new(
            Arc::new(Store::in_memory().unwrap()),
            Arc::new(TestVerifier),
        )
    }

    fn spec(task_id: &str, depends_on: &[&str]) -> TaskSpec {
        TaskSpec {
            task_id: task_id.into(),
            role: "engineer".into(),
            description: format!("Execute {task_id}"),
            depends_on: depends_on.iter().map(|value| (*value).into()).collect(),
            required_evidence: vec!["report".into()],
            inputs: BTreeMap::new(),
        }
    }

    fn proposal(tasks: Vec<TaskSpec>) -> WorkflowProposal {
        WorkflowProposal {
            workflow_id: format!("job_{}", Uuid::new_v4().simple()),
            title: "Rust vertical slice".into(),
            goal: "Prove approval-gated durable execution".into(),
            tasks,
            metadata: BTreeMap::new(),
        }
    }

    fn approve(service: &WorkflowService, workflow: &WorkflowView) -> WorkflowView {
        let plan_hash = content_hash(&workflow.plan).unwrap();
        let proposal_hash = content_hash(&workflow.proposal).unwrap();
        service
            .approve(
                &workflow.proposal.workflow_id,
                ApprovalRequest {
                    actor: "test-reviewer".into(),
                    expected_proposal_hash: proposal_hash,
                    expected_plan_hash: plan_hash,
                    evidence: json!({"accepted": true, "test_only": true}),
                },
            )
            .unwrap()
    }

    fn success(task_id: &str, lease: &TaskLease) -> TaskResultRequest {
        TaskResultRequest {
            lease_id: lease.lease_id.clone(),
            worker_id: lease.worker_id.clone(),
            attempt: lease.attempt,
            outcome: TaskOutcome::Succeeded,
            evidence: vec![EvidenceRef {
                artifact_id: format!("artifact-{task_id}-{}", lease.attempt),
                sha256: "a".repeat(64),
                producer_task_id: task_id.into(),
                producer_attempt: lease.attempt,
                kind: "report".into(),
            }],
            error: None,
        }
    }

    #[test]
    fn default_authority_fails_closed() {
        let service = WorkflowService::new(
            Arc::new(Store::in_memory().unwrap()),
            Arc::new(DenyAllApprovalVerifier),
        );
        let workflow = service
            .create_proposal(proposal(vec![spec("one", &[])]))
            .unwrap();
        let request = ApprovalRequest {
            actor: "reviewer".into(),
            expected_proposal_hash: content_hash(&workflow.proposal).unwrap(),
            expected_plan_hash: content_hash(&workflow.plan).unwrap(),
            evidence: json!({"accepted": true}),
        };
        assert!(matches!(
            service.approve(&workflow.proposal.workflow_id, request),
            Err(RuntimeError::ApprovalAuthorityUnavailable)
        ));
        assert_eq!(
            service
                .get_workflow(&workflow.proposal.workflow_id)
                .unwrap()
                .state,
            WorkflowState::Proposed
        );
    }

    #[test]
    fn runtime_recovery_classification_requires_fresh_complete_runtime_evidence() {
        let service = service();
        let workflow = approve(
            &service,
            &service
                .create_proposal(proposal(vec![spec("one", &[])]))
                .unwrap(),
        );
        let lease = service
            .claim_task(
                &workflow.proposal.workflow_id,
                "one",
                ClaimRequest {
                    worker_id: "worker-one".into(),
                    lease_ttl_seconds: 60,
                },
            )
            .unwrap();
        assert!(lease.owner_epoch > 0);
        let claimed_snapshot = service
            .store
            .inspect_task_attempt(&workflow.proposal.workflow_id, "one")
            .unwrap();
        assert_eq!(claimed_snapshot.owner_epoch, lease.owner_epoch);
        assert_eq!(claimed_snapshot.attempt_ledger.len(), 1);
        assert_eq!(claimed_snapshot.attempt_ledger[0].lease_id, lease.lease_id);
        assert_eq!(
            claimed_snapshot.attempt_ledger[0].owner_epoch,
            lease.owner_epoch
        );
        assert!(claimed_snapshot.attempt_ledger[0].result_sha256.is_none());
        service
            .create_agent_session(
                &workflow.proposal.workflow_id,
                "one",
                AgentSessionCreateRequest {
                    runtime_session_key: "session-one".into(),
                    role: "engineer".into(),
                    parent_session_key: None,
                    attempt: lease.attempt,
                },
            )
            .unwrap();
        let snapshot = RuntimeSnapshot {
            runtime_id: "runtime-test".into(),
            generation: 1,
            captured_at_ms: 1_000,
            complete: true,
            live_session_ids: std::collections::BTreeSet::new(),
        };
        let binding_request = RuntimeSessionBindingRequest {
            attempt: lease.attempt,
            owner_epoch: lease.owner_epoch,
            lease_id: lease.lease_id.clone(),
            worker_id: lease.worker_id.clone(),
            runtime_id: "runtime-test".into(),
            session_id: "session-one".into(),
        };
        let binding = service
            .bind_runtime_session(
                &workflow.proposal.workflow_id,
                "one",
                binding_request.clone(),
                &TestSessionBindingVerifier,
            )
            .unwrap();
        assert_eq!(binding.session_id, "session-one");
        let bound_snapshot = service
            .store
            .inspect_task_attempt(&workflow.proposal.workflow_id, "one")
            .unwrap();
        assert_eq!(
            bound_snapshot.attempt_ledger[0]
                .session_binding
                .as_ref()
                .map(|binding| binding.session_id.as_str()),
            Some("session-one")
        );
        assert_eq!(bound_snapshot.session_history.len(), 1);
        assert_eq!(
            bound_snapshot.session_history[0]
                .session
                .runtime_session_key,
            "session-one"
        );
        assert_eq!(
            service
                .bind_runtime_session(
                    &workflow.proposal.workflow_id,
                    "one",
                    binding_request.clone(),
                    &TestSessionBindingVerifier,
                )
                .unwrap(),
            binding
        );
        let mut conflicting_binding = binding_request;
        conflicting_binding.session_id = "different-session".into();
        assert!(matches!(
            service.bind_runtime_session(
                &workflow.proposal.workflow_id,
                "one",
                conflicting_binding,
                &TestSessionBindingVerifier,
            ),
            Err(RuntimeError::Store(StoreError::LeaseFenced))
        ));
        assert_eq!(
            service
                .inspect_task_attempt(&workflow.proposal.workflow_id, "one")
                .unwrap()
                .session_binding,
            Some(binding)
        );
        assert_eq!(
            service
                .classify_task_attempt_ownership(
                    &workflow.proposal.workflow_id,
                    "one",
                    RecoveryRuntimeEvidence {
                        snapshot: &snapshot,
                        expected_runtime_id: "runtime-test",
                        now_ms: 1_500,
                        maximum_snapshot_age_ms: 1_000,
                    },
                )
                .unwrap(),
            AttemptOwnership::Owned
        );
        service
            .record_task_result(
                &workflow.proposal.workflow_id,
                "one",
                success("one", &lease),
            )
            .unwrap();
        let completed_snapshot = service
            .store
            .inspect_task_attempt(&workflow.proposal.workflow_id, "one")
            .unwrap();
        assert_eq!(completed_snapshot.attempt_ledger.len(), 1);
        assert!(completed_snapshot.attempt_ledger[0].result_sha256.is_some());
        assert_eq!(
            completed_snapshot.attempt_ledger[0].outcome.as_deref(),
            Some("SUCCEEDED")
        );
        assert!(matches!(
            service.store.record_runtime_session_binding(
                &workflow.proposal.workflow_id,
                "one",
                RuntimeSessionBindingRequest {
                    attempt: lease.attempt,
                    owner_epoch: lease.owner_epoch,
                    lease_id: lease.lease_id.clone(),
                    worker_id: lease.worker_id.clone(),
                    runtime_id: "runtime-test".into(),
                    session_id: "late-session".into(),
                },
            ),
            Err(StoreError::LeaseFenced)
        ));
        assert!(
            service
                .verify_event_chain(&workflow.proposal.workflow_id)
                .unwrap()
                .valid
        );
        assert_eq!(
            service
                .classify_task_attempt_ownership(
                    &workflow.proposal.workflow_id,
                    "one",
                    RecoveryRuntimeEvidence {
                        snapshot: &snapshot,
                        expected_runtime_id: "runtime-test",
                        now_ms: 1_500,
                        maximum_snapshot_age_ms: 1_000,
                    },
                )
                .unwrap(),
            AttemptOwnership::NoKnownOwner
        );
        assert_eq!(
            service
                .classify_task_attempt_ownership(
                    &workflow.proposal.workflow_id,
                    "one",
                    RecoveryRuntimeEvidence {
                        snapshot: &snapshot,
                        expected_runtime_id: "runtime-test",
                        now_ms: 5_000,
                        maximum_snapshot_age_ms: 1_000,
                    },
                )
                .unwrap(),
            AttemptOwnership::Unknown
        );
        let _ = lease;
    }

    #[test]
    fn unbound_runtime_session_never_proves_no_known_owner() {
        let service = service();
        let workflow = approve(
            &service,
            &service
                .create_proposal(proposal(vec![spec("one", &[])]))
                .unwrap(),
        );
        let lease = service
            .claim_task(
                &workflow.proposal.workflow_id,
                "one",
                ClaimRequest {
                    worker_id: "worker-one".into(),
                    lease_ttl_seconds: 60,
                },
            )
            .unwrap();
        service
            .record_task_result(
                &workflow.proposal.workflow_id,
                "one",
                success("one", &lease),
            )
            .unwrap();
        let inventory = RuntimeSnapshot {
            runtime_id: "runtime-test".into(),
            generation: 1,
            captured_at_ms: 1_000,
            complete: true,
            live_session_ids: std::collections::BTreeSet::new(),
        };
        assert_eq!(
            service
                .classify_task_attempt_ownership(
                    &workflow.proposal.workflow_id,
                    "one",
                    RecoveryRuntimeEvidence {
                        snapshot: &inventory,
                        expected_runtime_id: "runtime-test",
                        now_ms: 1_500,
                        maximum_snapshot_age_ms: 1_000,
                    },
                )
                .unwrap(),
            AttemptOwnership::Unknown
        );
    }

    #[test]
    fn recovery_decision_is_host_verified_and_atomically_bound_to_current_store_snapshot() {
        let service = service();
        let workflow = approve(
            &service,
            &service
                .create_proposal(proposal(vec![spec("one", &[])]))
                .unwrap(),
        );
        let lease = service
            .claim_task(
                &workflow.proposal.workflow_id,
                "one",
                ClaimRequest {
                    worker_id: "worker-one".into(),
                    lease_ttl_seconds: 60,
                },
            )
            .unwrap();
        service
            .create_agent_session(
                &workflow.proposal.workflow_id,
                "one",
                AgentSessionCreateRequest {
                    runtime_session_key: "session-one".into(),
                    role: "engineer".into(),
                    parent_session_key: None,
                    attempt: lease.attempt,
                },
            )
            .unwrap();
        service
            .bind_runtime_session(
                &workflow.proposal.workflow_id,
                "one",
                RuntimeSessionBindingRequest {
                    attempt: lease.attempt,
                    owner_epoch: lease.owner_epoch,
                    lease_id: lease.lease_id.clone(),
                    worker_id: lease.worker_id.clone(),
                    runtime_id: "runtime-test".into(),
                    session_id: "session-one".into(),
                },
                &TestSessionBindingVerifier,
            )
            .unwrap();
        let mut live = std::collections::BTreeSet::new();
        live.insert("session-one".into());
        let inventory = RuntimeSnapshot {
            runtime_id: "runtime-test".into(),
            generation: 9,
            captured_at_ms: 1_000,
            complete: true,
            live_session_ids: live,
        };
        let (decision, record) = service
            .classify_and_record_recovery_decision(
                &workflow.proposal.workflow_id,
                "one",
                RecoveryRuntimeEvidence {
                    snapshot: &inventory,
                    expected_runtime_id: "runtime-test",
                    now_ms: 1_500,
                    maximum_snapshot_age_ms: 1_000,
                },
                &TestRecoveryDecisionVerifier,
            )
            .unwrap();
        assert_eq!(decision, AttemptOwnership::Owned);
        assert_eq!(record.request.decision, "OWNED");
        assert_eq!(record.request.attempt, lease.attempt);
        assert_eq!(record.request.owner_epoch, lease.owner_epoch);
        assert!(
            service
                .classify_and_record_recovery_decision(
                    &workflow.proposal.workflow_id,
                    "one",
                    RecoveryRuntimeEvidence {
                        snapshot: &inventory,
                        expected_runtime_id: "runtime-test",
                        now_ms: 5_000,
                        maximum_snapshot_age_ms: 1_000,
                    },
                    &TestRecoveryDecisionVerifier,
                )
                .is_err()
        );
        let repeated = service
            .store
            .record_recovery_decision(
                &workflow.proposal.workflow_id,
                "one",
                record.request.clone(),
                &TestRecoveryDecisionVerifier,
            )
            .unwrap();
        assert_eq!(repeated.event_id, record.event_id);
        let session_id = service
            .inspect_task_attempt(&workflow.proposal.workflow_id, "one")
            .unwrap()
            .session_history[0]
            .session
            .session_id
            .clone();
        service
            .update_agent_session(&session_id, 1, "ACTIVE", None, true)
            .unwrap();
        assert!(matches!(
            service.store.record_recovery_decision(
                &workflow.proposal.workflow_id,
                "one",
                record.request.clone(),
                &TestRecoveryDecisionVerifier,
            ),
            Err(StoreError::LeaseFenced)
        ));
        assert_eq!(
            service
                .get_workflow(&workflow.proposal.workflow_id)
                .unwrap()
                .tasks[0]
                .state,
            TaskState::Running
        );
        let events = service
            .list_workflow_events(&workflow.proposal.workflow_id, 100)
            .unwrap();
        assert!(
            events
                .iter()
                .any(|event| event.event_type == "recovery.decision_observed")
        );
        assert_eq!(events.last().unwrap().event_type, "session.state_changed");
        assert!(
            service
                .verify_event_chain(&workflow.proposal.workflow_id)
                .unwrap()
                .valid
        );
    }

    #[test]
    fn trust_verifier_uses_injected_candidate_binding_and_preserves_raw_evidence_for_revalidation()
    {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/approval-policy-v1-node.json"
        ))
        .unwrap();
        let mut raw_configs = BTreeMap::new();
        for (domain, config) in fixture["trust_configurations"].as_object().unwrap() {
            raw_configs.insert(domain.clone(), config.as_str().unwrap().as_bytes().to_vec());
        }
        let observed_at = 1_793_491_200_000;
        let configurations = TrustConfigurationSet::load_json(&raw_configs, observed_at).unwrap();
        let ledger = TrustLedger::in_memory().unwrap();
        configurations
            .record_observations(&ledger, observed_at)
            .unwrap();
        let resolver = Arc::new(FixedBindingResolver {
            binding: json!({"current_execution_graph_sha256":"a".repeat(64)}),
            calls: std::sync::atomic::AtomicUsize::new(0),
        });
        let verifier = TrustApprovalVerifier::new(
            Arc::new(configurations),
            Arc::new(ledger),
            resolver.clone(),
        );
        let service =
            WorkflowService::new(Arc::new(Store::in_memory().unwrap()), Arc::new(verifier));
        let workflow = service
            .create_proposal(proposal(vec![spec("one", &[])]))
            .unwrap();
        let error = service
            .approve(
                &workflow.proposal.workflow_id,
                ApprovalRequest {
                    actor: "untrusted-transport-actor".into(),
                    expected_proposal_hash: content_hash(&workflow.proposal).unwrap(),
                    expected_plan_hash: content_hash(&workflow.plan).unwrap(),
                    evidence: json!({}),
                },
            )
            .unwrap_err();
        assert!(matches!(
            error,
            RuntimeError::Store(StoreError::ApprovalEvidenceRejected { ref code, .. })
                if code == "AGG_APPROVAL_EVIDENCE_SHAPE_INVALID"
        ));
        assert_eq!(resolver.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(
            service
                .get_workflow(&workflow.proposal.workflow_id)
                .unwrap()
                .state,
            runalith_domain::WorkflowState::Proposed
        );
    }

    #[test]
    fn d01_approval_reads_all_trust_high_water_inside_workflow_transaction() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/approval-policy-v1-node.json"
        ))
        .unwrap();
        let mut raw_configs = BTreeMap::new();
        for (domain, config) in fixture["trust_configurations"].as_object().unwrap() {
            raw_configs.insert(domain.clone(), config.as_str().unwrap().as_bytes().to_vec());
        }
        let observed_at = 1_793_491_200_000;
        let configurations =
            Arc::new(TrustConfigurationSet::load_json(&raw_configs, observed_at).unwrap());
        let store = Arc::new(Store::in_memory().unwrap());
        for spec in TRUST_DOMAIN_SPECS {
            let configuration = configurations.get(spec.domain).unwrap();
            store
                .append_if_version(spec.domain, None, configuration, observed_at)
                .unwrap();
        }
        let resolver = Arc::new(FixedBindingResolver {
            binding: json!({"current_execution_graph_sha256":"a".repeat(64)}),
            calls: std::sync::atomic::AtomicUsize::new(0),
        });
        let observer: Arc<dyn TrustConfigurationObserver> = store.clone();
        let verifier = TrustApprovalVerifier::with_observer(
            configurations.clone(),
            observer,
            resolver.clone(),
        );
        let service = WorkflowService::new(store.clone(), Arc::new(verifier));
        let workflow = service
            .create_proposal(proposal(vec![spec("one", &[])]))
            .unwrap();
        let error = service
            .approve(
                &workflow.proposal.workflow_id,
                ApprovalRequest {
                    actor: "untrusted-transport-actor".into(),
                    expected_proposal_hash: content_hash(&workflow.proposal).unwrap(),
                    expected_plan_hash: content_hash(&workflow.plan).unwrap(),
                    evidence: json!({
                        "schema_version":1,
                        "policy":{},
                        "maker_attestation":{},
                        "decisions":[]
                    }),
                },
            )
            .unwrap_err();
        assert!(matches!(
            error,
            RuntimeError::Store(StoreError::ApprovalEvidenceRejected { ref code, .. })
                if code == "AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID"
        ));
        assert_eq!(resolver.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(
            service
                .get_workflow(&workflow.proposal.workflow_id)
                .unwrap()
                .state,
            WorkflowState::Proposed
        );
    }

    #[test]
    fn d01_approval_fails_closed_when_one_trust_domain_is_not_observed() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/approval-policy-v1-node.json"
        ))
        .unwrap();
        let mut raw_configs = BTreeMap::new();
        for (domain, config) in fixture["trust_configurations"].as_object().unwrap() {
            raw_configs.insert(domain.clone(), config.as_str().unwrap().as_bytes().to_vec());
        }
        let observed_at = 1_793_491_200_000;
        let configurations =
            Arc::new(TrustConfigurationSet::load_json(&raw_configs, observed_at).unwrap());
        let store = Arc::new(Store::in_memory().unwrap());
        for spec in TRUST_DOMAIN_SPECS {
            if spec.domain != "goal_idea_verifier" {
                store
                    .append_if_version(
                        spec.domain,
                        None,
                        configurations.get(spec.domain).unwrap(),
                        observed_at,
                    )
                    .unwrap();
            }
        }
        let resolver = Arc::new(FixedBindingResolver {
            binding: json!({"current_execution_graph_sha256":"a".repeat(64)}),
            calls: std::sync::atomic::AtomicUsize::new(0),
        });
        let observer: Arc<dyn TrustConfigurationObserver> = store.clone();
        let verifier =
            TrustApprovalVerifier::with_observer(configurations, observer, resolver.clone());
        let service = WorkflowService::new(store, Arc::new(verifier));
        let workflow = service
            .create_proposal(proposal(vec![spec("one", &[])]))
            .unwrap();
        let error = service
            .approve(
                &workflow.proposal.workflow_id,
                ApprovalRequest {
                    actor: "untrusted-transport-actor".into(),
                    expected_proposal_hash: content_hash(&workflow.proposal).unwrap(),
                    expected_plan_hash: content_hash(&workflow.plan).unwrap(),
                    evidence: json!({
                        "schema_version":1,
                        "policy":{},
                        "maker_attestation":{},
                        "decisions":[]
                    }),
                },
            )
            .unwrap_err();
        assert!(matches!(
            error,
            RuntimeError::Store(StoreError::ApprovalEvidenceRejected { ref code, .. })
                if code == "AGG_TRUST_CONFIG_NOT_OBSERVED"
        ));
        assert_eq!(
            service
                .get_workflow(&workflow.proposal.workflow_id)
                .unwrap()
                .state,
            WorkflowState::Proposed
        );
    }

    #[test]
    fn revoked_authority_blocks_new_task_claims_even_after_approval() {
        let authority_active = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let service = WorkflowService::new(
            Arc::new(Store::in_memory().unwrap()),
            Arc::new(SwitchableVerifier(Arc::clone(&authority_active))),
        );
        let workflow = service
            .create_proposal(proposal(vec![spec("one", &[])]))
            .unwrap();
        approve(&service, &workflow);
        authority_active.store(false, std::sync::atomic::Ordering::SeqCst);
        assert!(matches!(
            service.claim_task(
                &workflow.proposal.workflow_id,
                "one",
                ClaimRequest {
                    worker_id: "worker-a".into(),
                    lease_ttl_seconds: 30
                }
            ),
            Err(RuntimeError::ApprovalAuthorityUnavailable)
        ));
        assert_eq!(
            service
                .get_workflow(&workflow.proposal.workflow_id)
                .unwrap()
                .tasks[0]
                .state,
            TaskState::Pending
        );
    }

    #[test]
    fn revoked_authority_blocks_provider_reservation_before_adapter_invocation() {
        let authority_active = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let service = WorkflowService::new(
            Arc::new(Store::in_memory().unwrap()),
            Arc::new(SwitchableVerifier(Arc::clone(&authority_active))),
        );
        let workflow = service
            .create_proposal(proposal(vec![TaskSpec {
                task_id: "remote".into(),
                role: "provider".into(),
                description: "perform remote action".into(),
                depends_on: vec![],
                required_evidence: vec![],
                inputs: BTreeMap::new(),
            }]))
            .unwrap();
        approve(&service, &workflow);
        let lease = service
            .claim_task(
                &workflow.proposal.workflow_id,
                "remote",
                ClaimRequest {
                    worker_id: "provider-worker".into(),
                    lease_ttl_seconds: 60,
                },
            )
            .unwrap();
        authority_active.store(false, std::sync::atomic::Ordering::SeqCst);
        let provider = AmbiguousProvider(std::sync::atomic::AtomicUsize::new(0));
        assert!(matches!(
            service.dispatch_provider_task(
                &workflow.proposal.workflow_id,
                "remote",
                &lease.lease_id,
                &lease.worker_id,
                &provider,
                json!({"operation":"publish_report","input_sha256":"a".repeat(64)}),
            ),
            Err(RuntimeError::ApprovalAuthorityUnavailable)
        ));
        assert_eq!(provider.0.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(
            service
                .get_workflow(&workflow.proposal.workflow_id)
                .unwrap()
                .tasks[0]
                .state,
            TaskState::Running
        );
    }

    #[test]
    fn workflow_requires_exact_approval_then_fenced_evidence_to_complete() {
        let service = service();
        let workflow = service
            .create_proposal(proposal(vec![spec("one", &[])]))
            .unwrap();
        assert!(
            service
                .claim_task(
                    &workflow.proposal.workflow_id,
                    "one",
                    ClaimRequest {
                        worker_id: "worker-a".into(),
                        lease_ttl_seconds: 60,
                    }
                )
                .is_err()
        );

        let approved = approve(&service, &workflow);
        assert_eq!(approved.state, WorkflowState::Approved);
        let lease = service
            .claim_task(
                &workflow.proposal.workflow_id,
                "one",
                ClaimRequest {
                    worker_id: "worker-a".into(),
                    lease_ttl_seconds: 60,
                },
            )
            .unwrap();
        assert_eq!(lease.attempt, 1);
        let completed = service
            .record_task_result(
                &workflow.proposal.workflow_id,
                "one",
                success("one", &lease),
            )
            .unwrap();
        assert_eq!(completed.state, WorkflowState::Completed);
        assert_eq!(completed.tasks[0].state, TaskState::Succeeded);
    }

    #[test]
    fn dependencies_and_lease_identity_are_enforced() {
        let service = service();
        let workflow = service
            .create_proposal(proposal(vec![
                spec("first", &[]),
                spec("second", &["first"]),
            ]))
            .unwrap();
        approve(&service, &workflow);
        assert!(
            service
                .claim_task(
                    &workflow.proposal.workflow_id,
                    "second",
                    ClaimRequest {
                        worker_id: "worker-b".into(),
                        lease_ttl_seconds: 60,
                    }
                )
                .is_err()
        );

        let first = service
            .claim_task(
                &workflow.proposal.workflow_id,
                "first",
                ClaimRequest {
                    worker_id: "worker-a".into(),
                    lease_ttl_seconds: 60,
                },
            )
            .unwrap();
        let mut forged = success("first", &first);
        forged.worker_id = "worker-b".into();
        assert!(
            service
                .record_task_result(&workflow.proposal.workflow_id, "first", forged)
                .is_err()
        );
        service
            .record_task_result(
                &workflow.proposal.workflow_id,
                "first",
                success("first", &first),
            )
            .unwrap();
        assert!(
            service
                .claim_task(
                    &workflow.proposal.workflow_id,
                    "second",
                    ClaimRequest {
                        worker_id: "worker-b".into(),
                        lease_ttl_seconds: 60,
                    }
                )
                .is_ok()
        );
    }

    #[test]
    fn identical_task_result_replay_is_idempotent_but_conflicting_replay_is_fenced() {
        let service = service();
        let workflow = service
            .create_proposal(proposal(vec![spec("one", &[])]))
            .unwrap();
        approve(&service, &workflow);
        let lease = service
            .claim_task(
                &workflow.proposal.workflow_id,
                "one",
                ClaimRequest {
                    worker_id: "worker-a".into(),
                    lease_ttl_seconds: 60,
                },
            )
            .unwrap();
        let request = success("one", &lease);
        let first = service
            .record_task_result(&workflow.proposal.workflow_id, "one", request.clone())
            .unwrap();
        let repeated = service
            .record_task_result(&workflow.proposal.workflow_id, "one", request.clone())
            .unwrap();
        assert_eq!(first, repeated);

        let mut conflicting = request;
        conflicting.error = Some("conflicting replay".into());
        assert!(matches!(
            service.record_task_result(&workflow.proposal.workflow_id, "one", conflicting),
            Err(RuntimeError::Store(StoreError::LeaseFenced))
        ));
        assert!(
            service
                .verify_event_chain(&workflow.proposal.workflow_id)
                .unwrap()
                .valid
        );
    }

    #[test]
    fn authenticated_result_ingestion_rejects_unverified_producer_before_mutation() {
        let service = service();
        let workflow = service
            .create_proposal(proposal(vec![spec("one", &[])]))
            .unwrap();
        approve(&service, &workflow);
        let lease = service
            .claim_task(
                &workflow.proposal.workflow_id,
                "one",
                ClaimRequest {
                    worker_id: "worker-a".into(),
                    lease_ttl_seconds: 60,
                },
            )
            .unwrap();
        let mut forged = success("one", &lease);
        forged.worker_id = "worker-forged".into();
        assert!(
            service
                .record_task_result_authenticated(
                    &workflow.proposal.workflow_id,
                    "one",
                    forged,
                    &TestTaskResultProducerVerifier,
                )
                .is_err()
        );
        assert_eq!(
            service
                .get_workflow(&workflow.proposal.workflow_id)
                .unwrap()
                .tasks[0]
                .state,
            TaskState::Running
        );
        let accepted = service
            .record_task_result_authenticated(
                &workflow.proposal.workflow_id,
                "one",
                success("one", &lease),
                &TestTaskResultProducerVerifier,
            )
            .unwrap();
        assert_eq!(accepted.state, WorkflowState::Completed);
    }

    #[test]
    fn unknown_outcome_is_quarantined_and_never_reclaimed() {
        let service = service();
        let workflow = service
            .create_proposal(proposal(vec![spec("remote", &[])]))
            .unwrap();
        approve(&service, &workflow);
        let lease = service
            .claim_task(
                &workflow.proposal.workflow_id,
                "remote",
                ClaimRequest {
                    worker_id: "worker-a".into(),
                    lease_ttl_seconds: 60,
                },
            )
            .unwrap();
        let state = service
            .record_task_result(
                &workflow.proposal.workflow_id,
                "remote",
                TaskResultRequest {
                    lease_id: lease.lease_id,
                    worker_id: lease.worker_id,
                    attempt: lease.attempt,
                    outcome: TaskOutcome::Unknown,
                    evidence: vec![],
                    error: Some("provider outcome not observable".into()),
                },
            )
            .unwrap();
        assert_eq!(state.tasks[0].state, TaskState::Unknown);
        assert!(
            service
                .claim_task(
                    &workflow.proposal.workflow_id,
                    "remote",
                    ClaimRequest {
                        worker_id: "worker-b".into(),
                        lease_ttl_seconds: 60,
                    }
                )
                .is_err()
        );
    }

    #[test]
    fn provider_dispatch_intent_is_persisted_before_call_and_ambiguous_call_never_replays() {
        let service = service();
        let workflow = service
            .create_proposal(proposal(vec![TaskSpec {
                task_id: "remote".into(),
                role: "provider".into(),
                description: "perform remote action".into(),
                depends_on: vec![],
                required_evidence: vec![],
                inputs: BTreeMap::new(),
            }]))
            .unwrap();
        approve(&service, &workflow);
        let lease = service
            .claim_task(
                &workflow.proposal.workflow_id,
                "remote",
                ClaimRequest {
                    worker_id: "provider-worker".into(),
                    lease_ttl_seconds: 60,
                },
            )
            .unwrap();
        let provider = AmbiguousProvider(std::sync::atomic::AtomicUsize::new(0));
        let first = service
            .dispatch_provider_task(
                &workflow.proposal.workflow_id,
                "remote",
                &lease.lease_id,
                &lease.worker_id,
                &provider,
                json!({"operation":"publish_report","input_sha256":"a".repeat(64)}),
            )
            .unwrap();
        assert_eq!(first.state, ProviderDispatchState::Unknown);
        assert_eq!(provider.0.load(std::sync::atomic::Ordering::SeqCst), 1);
        let current = service
            .get_workflow(&workflow.proposal.workflow_id)
            .unwrap();
        assert_eq!(current.tasks[0].state, TaskState::Unknown);
        assert_eq!(
            current.tasks[0].result.as_ref().unwrap().outcome,
            TaskOutcome::Unknown
        );
        let ownership = service
            .inspect_task_attempt(&workflow.proposal.workflow_id, "remote")
            .unwrap();
        assert_eq!(ownership.attempt, 1);
        assert!(ownership.lease_id.is_none());
        assert_eq!(
            ownership.provider_intent.as_ref().unwrap().state,
            ProviderDispatchState::Unknown
        );
        let runtime_snapshot = RuntimeSnapshot {
            runtime_id: "runtime-test".into(),
            generation: 1,
            captured_at_ms: 1_000,
            complete: true,
            live_session_ids: std::collections::BTreeSet::new(),
        };
        assert_eq!(
            service
                .classify_task_attempt_ownership(
                    &workflow.proposal.workflow_id,
                    "remote",
                    RecoveryRuntimeEvidence {
                        snapshot: &runtime_snapshot,
                        expected_runtime_id: "runtime-test",
                        now_ms: 1_500,
                        maximum_snapshot_age_ms: 1_000,
                    },
                )
                .unwrap(),
            AttemptOwnership::Unresolved
        );

        let (reconciled, observation) = service
            .reconcile_provider_dispatch_intent(&first.intent_id, &provider)
            .unwrap();
        assert_eq!(reconciled.state, ProviderDispatchState::Unknown);
        assert_eq!(observation.provider_id, provider.provider_id());
        assert_eq!(observation.response["status"], "UNKNOWN");
        assert_eq!(
            service
                .store
                .list_provider_reconciliation_observations(&first.intent_id)
                .unwrap()
                .len(),
            1
        );
        let historical = service
            .inspect_task_attempt(&workflow.proposal.workflow_id, "remote")
            .unwrap();
        assert_eq!(historical.provider_history.len(), 1);
        assert_eq!(historical.provider_history[0].attempt, lease.attempt);
        assert!(historical.provider_history[0].lineage_matches);
        assert_eq!(historical.provider_history[0].observations.len(), 1);

        let repeated = service
            .dispatch_provider_task(
                &workflow.proposal.workflow_id,
                "remote",
                &lease.lease_id,
                &lease.worker_id,
                &provider,
                json!({"operation":"publish_report","input_sha256":"a".repeat(64)}),
            )
            .unwrap();
        assert_eq!(repeated.intent_id, first.intent_id);
        assert_eq!(repeated.state, ProviderDispatchState::Unknown);
        assert_eq!(provider.0.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(
            service
                .verify_event_chain(&workflow.proposal.workflow_id)
                .unwrap()
                .valid
        );
    }

    #[test]
    fn github_dispatch_flows_through_workflow_session_persistence_and_recovery_without_replay() {
        let service = service();
        let workflow = service
            .create_proposal(proposal(vec![spec("remote", &[])]))
            .unwrap();
        let workflow = approve(&service, &workflow);
        let lease = service
            .claim_task(
                &workflow.proposal.workflow_id,
                "remote",
                ClaimRequest {
                    worker_id: "github-worker".into(),
                    lease_ttl_seconds: 60,
                },
            )
            .unwrap();
        let session = service
            .create_agent_session(
                &workflow.proposal.workflow_id,
                "remote",
                AgentSessionCreateRequest {
                    runtime_session_key: "runtime:github:e2e".into(),
                    role: "provider".into(),
                    parent_session_key: None,
                    attempt: lease.attempt,
                },
            )
            .unwrap();
        service
            .bind_runtime_session(
                &workflow.proposal.workflow_id,
                "remote",
                RuntimeSessionBindingRequest {
                    attempt: lease.attempt,
                    owner_epoch: lease.owner_epoch,
                    lease_id: lease.lease_id.clone(),
                    worker_id: lease.worker_id.clone(),
                    runtime_id: "runtime-test".into(),
                    session_id: session.runtime_session_key.clone(),
                },
                &TestSessionBindingVerifier,
            )
            .unwrap();

        let dispatch_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let transport = E2EGitHubTransport {
            lookups: std::sync::Mutex::new(
                [
                    GitHubActionsLookup::NotFound {
                        pages_scanned: 1,
                        complete: true,
                    },
                    GitHubActionsLookup::Found {
                        run_id: "987654321".into(),
                        status: "queued".into(),
                        conclusion: None,
                        run_url: Some(
                            "https://github.com/openai/runalith-worker/actions/runs/987654321"
                                .into(),
                        ),
                    },
                ]
                .into_iter()
                .collect(),
            ),
            dispatches: dispatch_count.clone(),
        };
        let provider = GitHubActionsAdapter::new(transport);
        let payload = json!({
            "owner":"openai","repo":"runalith-worker","workflow":".github/workflows/worker.yml","ref":"main",
            "inputs":{"task_id":"remote","input_commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        });
        let intent = service
            .dispatch_provider_task(
                &workflow.proposal.workflow_id,
                "remote",
                &lease.lease_id,
                &lease.worker_id,
                &provider,
                payload.clone(),
            )
            .unwrap();
        assert_eq!(intent.state, ProviderDispatchState::Accepted);
        assert_eq!(intent.provider_run_id.as_deref(), Some("987654321"));
        assert_eq!(
            intent.request.payload.as_ref().unwrap()["inputs"]["runalith_intent_id"],
            intent.request.idempotency_key
        );
        assert_eq!(dispatch_count.load(std::sync::atomic::Ordering::SeqCst), 1);

        let repeated = service
            .dispatch_provider_task(
                &workflow.proposal.workflow_id,
                "remote",
                &lease.lease_id,
                &lease.worker_id,
                &provider,
                payload,
            )
            .unwrap();
        assert_eq!(repeated.intent_id, intent.intent_id);
        assert_eq!(dispatch_count.load(std::sync::atomic::Ordering::SeqCst), 1);

        let snapshot = service
            .inspect_task_attempt(&workflow.proposal.workflow_id, "remote")
            .unwrap();
        assert_eq!(snapshot.attempt_ledger.len(), 1);
        assert_eq!(snapshot.attempt_ledger[0].owner_epoch, lease.owner_epoch);
        assert_eq!(
            snapshot.attempt_ledger[0]
                .session_binding
                .as_ref()
                .unwrap()
                .session_id,
            session.runtime_session_key
        );
        assert_eq!(snapshot.provider_history.len(), 1);
        assert!(snapshot.provider_history[0].lineage_matches);
        assert_eq!(
            snapshot.provider_history[0].intent.intent_id,
            intent.intent_id
        );

        let runtime_snapshot = RuntimeSnapshot {
            runtime_id: "runtime-test".into(),
            generation: 1,
            captured_at_ms: 10_000,
            complete: true,
            live_session_ids: [session.runtime_session_key].into_iter().collect(),
        };
        assert_eq!(
            service
                .classify_task_attempt_ownership(
                    &workflow.proposal.workflow_id,
                    "remote",
                    RecoveryRuntimeEvidence {
                        snapshot: &runtime_snapshot,
                        expected_runtime_id: "runtime-test",
                        now_ms: 10_500,
                        maximum_snapshot_age_ms: 1_000,
                    },
                )
                .unwrap(),
            AttemptOwnership::Unresolved
        );
        assert!(
            service
                .verify_event_chain(&workflow.proposal.workflow_id)
                .unwrap()
                .valid
        );
    }

    #[test]
    fn legacy_payloadless_intent_is_unknown_without_provider_lookup() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("legacy-provider.sqlite");
        let store = Arc::new(Store::create_new(&path).unwrap());
        let service = WorkflowService::new(store.clone(), Arc::new(TestVerifier));
        let workflow = service
            .create_proposal(proposal(vec![TaskSpec {
                task_id: "remote".into(),
                role: "provider".into(),
                description: "perform remote action".into(),
                depends_on: vec![],
                required_evidence: vec![],
                inputs: BTreeMap::new(),
            }]))
            .unwrap();
        approve(&service, &workflow);
        let lease = service
            .claim_task(
                &workflow.proposal.workflow_id,
                "remote",
                ClaimRequest {
                    worker_id: "provider-worker".into(),
                    lease_ttl_seconds: 60,
                },
            )
            .unwrap();
        let dispatch = AmbiguousProvider(std::sync::atomic::AtomicUsize::new(0));
        let intent = service
            .dispatch_provider_task(
                &workflow.proposal.workflow_id,
                "remote",
                &lease.lease_id,
                &lease.worker_id,
                &dispatch,
                json!({"operation":"publish_report"}),
            )
            .unwrap();
        assert_eq!(intent.state, ProviderDispatchState::Unknown);
        drop(service);
        drop(store);

        let connection = rusqlite::Connection::open(&path).unwrap();
        connection.execute_batch(
            "DROP TRIGGER workflow_cancellation_request_append_only;
             ALTER TABLE workflows DROP COLUMN cancellation_requested_at;
             DROP TRIGGER workflow_state_transition_guard;
             CREATE TRIGGER workflow_state_transition_guard
             BEFORE UPDATE OF state ON workflows
             WHEN NOT (
               (OLD.state='PROPOSED' AND NEW.state IN ('APPROVED','CANCELLED')) OR
               (OLD.state='APPROVED' AND NEW.state IN ('EXECUTING','CANCELLED')) OR
               (OLD.state='EXECUTING' AND NEW.state IN ('COMPLETED','FAILED','CANCELLED'))
             )
             BEGIN SELECT RAISE(ABORT,'invalid workflow state transition'); END;
             DROP TRIGGER worker_execution_fences_no_delete;
             DROP TRIGGER worker_execution_fences_update_guard;
             DROP TRIGGER worker_execution_fences_insert_guard;
             DROP TABLE worker_execution_fences;
             DROP TRIGGER task_lease_renewals_no_delete;
             DROP TRIGGER task_lease_renewals_no_update;
             DROP TRIGGER task_lease_renewals_insert_guard;
             DROP TABLE task_lease_renewals;
             DROP TRIGGER task_lease_fence_guard;
             DROP TRIGGER provider_intent_identity_immutable;
             DROP TRIGGER provider_intent_payload_required;
             ALTER TABLE provider_dispatch_intents DROP COLUMN payload_json;
             DROP TRIGGER task_attempt_append_only_update;
             DROP TRIGGER task_attempt_append_only_delete;
             DROP TRIGGER task_attempt_result_append_only_update;
             DROP TRIGGER task_attempt_result_append_only_delete;
             DROP TRIGGER task_owner_epoch_increment_guard;
             DROP TRIGGER task_attempt_insert_fence_guard;
             DROP TRIGGER task_attempt_result_insert_fence_guard;
             DROP TRIGGER workflow_result_inbox_no_update;
             DROP TRIGGER workflow_result_inbox_no_delete;
             DROP TABLE workflow_result_inbox;
             DROP TABLE task_attempt_results;
             DROP TABLE task_attempts;
             ALTER TABLE tasks DROP COLUMN owner_epoch;
             DROP TRIGGER session_messages_no_delete;
             DROP TRIGGER agent_sessions_no_delete;
             DROP TABLE session_messages;
             DROP TABLE session_access;
             DROP TABLE agent_sessions;
             DROP TRIGGER agg_checkpoint_store_quarantine_no_update;
             DROP TRIGGER agg_checkpoint_store_quarantine_no_delete;
             DROP TABLE agg_checkpoint_store_quarantine;
             DROP TRIGGER agg_checkpoint_transition_gate_fencing;
             DROP TABLE agg_checkpoint_transition_gate;
             DROP TRIGGER agg_checkpoint_operation_events_no_update;
             DROP TRIGGER agg_checkpoint_operation_events_no_delete;
             DROP TABLE agg_checkpoint_operation_events;
             DROP TRIGGER agg_checkpoint_operations_identity_immutable;
             DROP TRIGGER agg_checkpoint_operations_state_transition;
             DROP TRIGGER agg_checkpoint_operations_no_delete;
             DROP TABLE agg_checkpoint_operations;
             DROP TABLE store_connection_probes;
             DROP TRIGGER governance_decision_events_no_update;
             DROP TRIGGER governance_decision_events_no_delete;
             DROP TABLE governance_decision_events;
             DROP TRIGGER governance_decisions_no_update;
             DROP TRIGGER governance_decisions_no_delete;
             DROP TABLE governance_decisions;
             DROP TRIGGER custom_role_skill_pins_no_update;
             DROP TRIGGER custom_role_skill_pins_no_delete;
             DROP TABLE custom_role_trusted_skill_pins;
             DROP TABLE custom_workflow_plans;
             DROP TABLE custom_workflow_versions;
             DROP TABLE custom_role_versions;
             DROP TABLE control_catalog_events;
             DROP TABLE workflow_policy_events;
             DROP TABLE workflow_success_contracts;
             DROP TABLE workflow_policy_attachments;
             DROP TABLE workflow_policy_versions;
             DROP TABLE governance_reviewer_identity_versions;
             DROP TABLE governance_trust_configuration_versions;
             DROP TABLE agg_attestation_nonces;
             CREATE TRIGGER provider_intent_identity_immutable
             BEFORE UPDATE OF intent_id,workflow_id,task_id,attempt,provider_id,idempotency_key,lease_id,worker_id,plan_sha256,request_sha256,created_at
             ON provider_dispatch_intents
             BEGIN SELECT RAISE(ABORT,'provider dispatch intent identity is immutable'); END;
             CREATE TRIGGER task_lease_fence_guard
             BEFORE UPDATE OF attempts,lease_id,lease_owner,lease_expires_at ON tasks
             WHEN NOT (
               (OLD.state='PENDING' AND NEW.state='RUNNING' AND NEW.attempts=OLD.attempts+1
                 AND NEW.lease_id IS NOT NULL AND NEW.lease_owner IS NOT NULL AND NEW.lease_expires_at IS NOT NULL) OR
               (OLD.state='RUNNING' AND NEW.state IN ('SUCCEEDED','FAILED','UNKNOWN')
                 AND NEW.attempts=OLD.attempts AND NEW.lease_id IS NULL
                 AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL)
             )
             BEGIN SELECT RAISE(ABORT,'task lease identity is fenced'); END;
             PRAGMA user_version=5;",
        ).unwrap();
        drop(connection);

        let migrated = Arc::new(Store::migrate_existing_rust_database(&path).unwrap());
        let service = WorkflowService::new(migrated, Arc::new(TestVerifier));
        let provider = CountingLookupProvider(std::sync::atomic::AtomicUsize::new(0));
        let (record, observation) = service
            .reconcile_provider_dispatch_intent(&intent.intent_id, &provider)
            .unwrap();
        assert_eq!(record.state, ProviderDispatchState::Unknown);
        assert_eq!(observation.response["status"], "UNKNOWN");
        assert_eq!(provider.0.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    fn sandbox_request() -> CommandRequest {
        CommandRequest {
            executable: "/usr/bin/true".into(),
            arguments: vec![],
            working_directory: ".".into(),
            environment: BTreeMap::new(),
            stdin: vec![],
        }
    }

    fn sandbox_proposal(workflow_id: &str, request: &CommandRequest) -> WorkflowProposal {
        let mut inputs = BTreeMap::new();
        inputs.insert(
            "sandbox_command".into(),
            serde_json::to_value(request).unwrap(),
        );
        WorkflowProposal {
            workflow_id: workflow_id.into(),
            title: "Sandbox command test".into(),
            goal: "Run plan-pinned command".into(),
            tasks: vec![TaskSpec {
                task_id: "sandbox".into(),
                role: "sandbox".into(),
                description: "bounded command".into(),
                depends_on: vec![],
                required_evidence: vec!["sandbox_execution".into()],
                inputs,
            }],
            metadata: BTreeMap::new(),
        }
    }

    #[test]
    fn sandbox_execution_requires_exact_plan_input_and_stores_content_addressed_evidence() {
        let service = service();
        let request = sandbox_request();
        let workflow = service
            .create_proposal(sandbox_proposal("job_sandbox_success", &request))
            .unwrap();
        approve(&service, &workflow);
        let directory = tempfile::tempdir().unwrap();
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let completed = service
            .execute_sandboxed_task(
                SandboxTaskExecutionRequest {
                    workflow_id: workflow.proposal.workflow_id.clone(),
                    task_id: "sandbox".into(),
                    worker_id: "sandbox-worker".into(),
                    lease_ttl_seconds: 60,
                    command: request.clone(),
                },
                &FakeSandbox { ambiguous: false },
                &artifacts,
            )
            .unwrap();
        assert_eq!(completed.state, WorkflowState::Completed);
        assert_eq!(completed.tasks[0].state, TaskState::Succeeded);
        let evidence = &completed.tasks[0].result.as_ref().unwrap().evidence[0];
        assert_eq!(evidence.kind, "sandbox_execution");
        let (artifact, bytes) = artifacts
            .read_by_id(&evidence.artifact_id, "application/json")
            .unwrap();
        assert_eq!(artifact.sha256, evidence.sha256);
        let result: CommandResult = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(result.stdout, "sandbox output");

        let another = service
            .create_proposal(sandbox_proposal("job_sandbox_mismatch", &request))
            .unwrap();
        approve(&service, &another);
        let mut changed = request;
        changed.arguments.push("not-in-approved-plan".into());
        assert!(
            service
                .execute_sandboxed_task(
                    SandboxTaskExecutionRequest {
                        workflow_id: another.workflow_id.clone(),
                        task_id: "sandbox".into(),
                        worker_id: "sandbox-worker".into(),
                        lease_ttl_seconds: 60,
                        command: changed,
                    },
                    &FakeSandbox { ambiguous: false },
                    &artifacts,
                )
                .is_err()
        );
        assert_eq!(
            service.get_workflow(&another.workflow_id).unwrap().tasks[0].attempts,
            0
        );
    }

    #[test]
    fn sandbox_process_ambiguity_is_quarantined_not_replayed() {
        let service = service();
        let request = sandbox_request();
        let workflow = service
            .create_proposal(sandbox_proposal("job_sandbox_unknown", &request))
            .unwrap();
        approve(&service, &workflow);
        let directory = tempfile::tempdir().unwrap();
        let artifacts = ArtifactStore::open_or_create(directory.path().join("artifacts")).unwrap();
        let quarantined = service
            .execute_sandboxed_task(
                SandboxTaskExecutionRequest {
                    workflow_id: workflow.proposal.workflow_id.clone(),
                    task_id: "sandbox".into(),
                    worker_id: "sandbox-worker".into(),
                    lease_ttl_seconds: 60,
                    command: request,
                },
                &FakeSandbox { ambiguous: true },
                &artifacts,
            )
            .unwrap();
        assert_eq!(quarantined.tasks[0].state, TaskState::Unknown);
        assert_eq!(quarantined.tasks[0].attempts, 1);
        assert_eq!(
            quarantined.tasks[0].result.as_ref().unwrap().outcome,
            TaskOutcome::Unknown
        );
        assert!(
            quarantined.tasks[0]
                .result
                .as_ref()
                .unwrap()
                .evidence
                .is_empty()
        );
    }

    #[test]
    fn success_without_content_addressed_evidence_is_rejected() {
        let service = service();
        let workflow = service
            .create_proposal(proposal(vec![spec("one", &[])]))
            .unwrap();
        approve(&service, &workflow);
        let lease = service
            .claim_task(
                &workflow.proposal.workflow_id,
                "one",
                ClaimRequest {
                    worker_id: "worker-a".into(),
                    lease_ttl_seconds: 60,
                },
            )
            .unwrap();
        let mut request = success("one", &lease);
        request.evidence[0].kind = "unrelated".into();
        assert!(
            service
                .record_task_result(&workflow.proposal.workflow_id, "one", request)
                .is_err()
        );
        let mut request = success("one", &lease);
        request.evidence.clear();
        assert!(
            service
                .record_task_result(&workflow.proposal.workflow_id, "one", request)
                .is_err()
        );
    }

    #[test]
    fn expired_lease_becomes_unknown_and_is_not_replayed() {
        let service = service();
        let workflow = service
            .create_proposal(proposal(vec![spec("remote", &[])]))
            .unwrap();
        approve(&service, &workflow);
        service
            .claim_task(
                &workflow.proposal.workflow_id,
                "remote",
                ClaimRequest {
                    worker_id: "worker-a".into(),
                    lease_ttl_seconds: 1,
                },
            )
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1_100));
        assert_eq!(service.quarantine_expired_leases().unwrap(), 1);
        let observed = service
            .get_workflow(&workflow.proposal.workflow_id)
            .unwrap();
        assert_eq!(observed.tasks[0].state, TaskState::Unknown);
        assert!(
            service
                .claim_task(
                    &workflow.proposal.workflow_id,
                    "remote",
                    ClaimRequest {
                        worker_id: "worker-b".into(),
                        lease_ttl_seconds: 60,
                    },
                )
                .is_err()
        );
    }

    #[test]
    fn rust_database_is_durable_and_never_overwrites_existing_path() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("runalith-rust.db");
        let workflow_id;
        {
            let store = Store::create_new(&path).unwrap();
            let service = WorkflowService::new(Arc::new(store), Arc::new(DenyAllApprovalVerifier));
            let workflow = service
                .create_proposal(proposal(vec![spec("persisted", &[])]))
                .unwrap();
            workflow_id = workflow.proposal.workflow_id;
            assert_eq!(workflow.state, WorkflowState::Proposed);
        }

        let reopened = Store::open_existing(&path).unwrap();
        let persisted = reopened.get_workflow(&workflow_id).unwrap();
        assert_eq!(persisted.state, WorkflowState::Proposed);
        assert_eq!(persisted.tasks[0].definition.task_id, "persisted");
        assert!(matches!(
            Store::create_new(&path),
            Err(StoreError::AlreadyExists)
        ));
    }

    #[test]
    fn runtime_session_message_lifecycle_is_connected_to_workflow_journal() {
        let service = service();
        let workflow = service
            .create_proposal(proposal(vec![spec("session-task", &[])]))
            .unwrap();
        let session = service
            .create_agent_session(
                &workflow.proposal.workflow_id,
                "session-task",
                AgentSessionCreateRequest {
                    runtime_session_key: "runtime:session:e2e".into(),
                    role: "engineer".into(),
                    parent_session_key: None,
                    attempt: 1,
                },
            )
            .unwrap();
        service
            .grant_session_access(
                &session.session_id,
                SessionAccessRequest {
                    accessor_role: "qa".into(),
                    permission: SessionPermission::Message,
                    granted_by: "cto".into(),
                    expires_at: None,
                },
            )
            .unwrap();
        let message = service
            .enqueue_session_message(
                &session.session_id,
                SessionMessageRequest {
                    sender_role: "engineer".into(),
                    recipient_role: "qa".into(),
                    message_type: "session.message".into(),
                    payload: json!({"artifact_id":"artifact-1"}),
                    correlation_id: Some("workflow-session-e2e".into()),
                    dedupe_key: Some("artifact-1".into()),
                    available_at: None,
                },
            )
            .unwrap();
        let claim = service
            .claim_session_message(&message.message_id, "qa", 60)
            .unwrap()
            .unwrap();
        service
            .record_session_message_delivery_start(
                &message.message_id,
                claim.attempt,
                claim.lease_until.as_deref().unwrap(),
            )
            .unwrap();
        service
            .record_session_message_receipt(
                &message.message_id,
                claim.attempt,
                claim.lease_until.as_deref().unwrap(),
                SessionDeliveryReceipt {
                    run_id: "provider-run-e2e".into(),
                    session_key: session.runtime_session_key.clone(),
                    response: None,
                    recorded_at: chrono::Utc::now()
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                },
            )
            .unwrap();
        let acked = service
            .acknowledge_session_message(
                &message.message_id,
                "qa",
                claim.attempt,
                claim.lease_until.as_deref().unwrap(),
            )
            .unwrap();
        assert_eq!(acked.state, "ACKED");
        let snapshot = service
            .inspect_task_attempt(&workflow.proposal.workflow_id, "session-task")
            .unwrap();
        assert_eq!(snapshot.session_history.len(), 1);
        assert_eq!(snapshot.session_history[0].messages.len(), 1);
        assert_eq!(snapshot.session_history[0].messages[0].state, "ACKED");
        assert_eq!(snapshot.session_history[0].access[0].permission, "MESSAGE");
        let events = service
            .list_workflow_events(&workflow.proposal.workflow_id, 100)
            .unwrap();
        let event_types: Vec<_> = events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect();
        assert!(event_types.contains(&"session.created"));
        assert!(event_types.contains(&"session.access_granted"));
        assert!(event_types.contains(&"session.message_queued"));
        assert!(event_types.contains(&"session.message_delivery_started"));
        assert!(event_types.contains(&"session.message_receipt"));
        assert!(event_types.contains(&"session.message_acked"));
        assert!(
            service
                .verify_event_chain(&workflow.proposal.workflow_id)
                .unwrap()
                .valid
        );
    }
}
