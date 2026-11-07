//! Workstream 3 semantic observation payloads.
//!
//! These are producer-owned domain payloads, not shared wire envelopes. The
//! protocol/gateway workstream owns transport metadata, producer identity,
//! envelope signing and serialization compatibility.

use std::collections::BTreeMap;

use runalith_domain::content_hash;
use runalith_sandbox::SandboxProcessObservation;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::{TaskClaimEnvelope, VerifiedTaskClaim, WorkerExecutionEvidence, WorkerOutcome};

/// Semantic payload version for Workstream 3 worker observations.
pub const WORKER_OBSERVATION_SCHEMA_VERSION: u32 = 1;

/// A structurally valid claim whose authenticator and current Control scope
/// have already been checked by `TaskClaimVerifier` and accepted by the local
/// worker inbox. This is an observation, not a new claim or authority token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerClaimAcceptedV1 {
    /// Workstream 3 payload version.
    pub schema_version: u32,
    /// Stable event identity derived from the immutable claim subject.
    pub event_id: String,
    /// Control-issued claim identity.
    pub claim_id: String,
    /// Authenticated Control issuer identity from the verified claim.
    pub issuer: String,
    /// Intended worker audience.
    pub audience: String,
    /// Workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Fenced attempt number.
    pub attempt: u64,
    /// Exact Control lease identity.
    pub lease_id: String,
    /// Monotonic Control owner epoch.
    pub owner_epoch: u64,
    /// Worker identity bound by the claim verifier.
    pub worker_id: String,
    /// Immutable plan digest.
    pub plan_sha256: String,
    /// Exact command digest.
    pub command_sha256: String,
}

impl WorkerClaimAcceptedV1 {
    /// Build from an unforgeable in-process verified claim, never from a raw
    /// JSON envelope. The returned event does not include opaque auth material.
    pub fn from_verified(claim: &VerifiedTaskClaim) -> Result<Self, String> {
        let envelope = claim.as_envelope();
        let subject = claim_subject(envelope);
        let event_id = stable_id("worker-claim-accepted", &subject)?;
        Ok(Self {
            schema_version: WORKER_OBSERVATION_SCHEMA_VERSION,
            event_id,
            claim_id: envelope.claim_id.clone(),
            issuer: envelope.issuer.clone(),
            audience: envelope.audience.clone(),
            workflow_id: envelope.workflow_id.clone(),
            task_id: envelope.task_id.clone(),
            attempt: envelope.attempt,
            lease_id: envelope.lease_id.clone(),
            owner_epoch: envelope.owner_epoch,
            worker_id: envelope.worker_id.clone(),
            plan_sha256: envelope.plan_sha256.clone(),
            command_sha256: envelope.command_sha256.clone(),
        })
    }
}

/// Process completion facts captured by the worker after execution evidence is
/// persisted. These facts do not advance task lifecycle or establish provider
/// terminality.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessObservationV1 {
    /// Workstream 3 payload version.
    pub schema_version: u32,
    /// Stable observation identity bound to the immutable evidence manifest.
    pub observation_id: String,
    /// Claim identity.
    pub claim_id: String,
    /// Workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Fenced attempt number.
    pub attempt: u64,
    /// Exact Control lease identity.
    pub lease_id: String,
    /// Monotonic Control owner epoch.
    pub owner_epoch: u64,
    /// Worker identity.
    pub worker_id: String,
    /// Immutable plan digest.
    pub plan_sha256: String,
    /// Exact command digest.
    pub command_sha256: String,
    /// Local worker classification. This is not a Control lifecycle decision.
    pub outcome: WorkerOutcome,
    /// Host process exit code, if available.
    pub exit_code: Option<i32>,
    /// Whether the worker sandbox policy forced a timeout stop.
    pub timed_out: bool,
    /// Whether lease cancellation was observed after process start.
    pub cancelled_after_start: bool,
    /// Process identity/timing and cgroup observation, only for backends that
    /// actually produced host-verifiable process-tree evidence.
    pub process: Option<SandboxProcessObservation>,
    /// Captured stdout digest, if the stream was persisted.
    pub stdout_sha256: Option<String>,
    /// Captured stderr digest, if the stream was persisted.
    pub stderr_sha256: Option<String>,
    /// Whether either captured output stream was truncated.
    pub output_truncated: bool,
    /// Sandbox backend identity, if execution reached a backend.
    pub sandbox_backend: Option<String>,
    /// Digest of the content-addressed worker evidence manifest.
    pub manifest_sha256: String,
}

impl ProcessObservationV1 {
    /// Convert immutable worker evidence into a producer-owned observation.
    /// Its identity is derived from the stored manifest digest, so retries of
    /// the same evidence retain the same event ID.
    pub fn from_evidence(evidence: &WorkerExecutionEvidence) -> Result<Self, String> {
        if !valid_digest(&evidence.manifest_sha256) {
            return Err("worker evidence manifest digest is invalid".into());
        }
        let subject = json!({
            "manifest_sha256": evidence.manifest_sha256,
            "claim_id": evidence.claim_id,
            "attempt": evidence.attempt,
            "owner_epoch": evidence.owner_epoch
        });
        let observation_id = stable_id("process-observation", &subject)?;
        validate_process_observation(evidence.process_observation.as_ref())?;
        Ok(Self {
            schema_version: WORKER_OBSERVATION_SCHEMA_VERSION,
            observation_id,
            claim_id: evidence.claim_id.clone(),
            workflow_id: evidence.workflow_id.clone(),
            task_id: evidence.task_id.clone(),
            attempt: evidence.attempt,
            lease_id: evidence.lease_id.clone(),
            owner_epoch: evidence.owner_epoch,
            worker_id: evidence.worker_id.clone(),
            plan_sha256: evidence.plan_sha256.clone(),
            command_sha256: evidence.command_sha256.clone(),
            outcome: evidence.outcome,
            exit_code: evidence.exit_code,
            timed_out: evidence.timed_out,
            cancelled_after_start: evidence.cancelled_after_start,
            process: evidence.process_observation.clone(),
            stdout_sha256: evidence
                .stdout
                .as_ref()
                .map(|artifact| artifact.sha256.clone()),
            stderr_sha256: evidence
                .stderr
                .as_ref()
                .map(|artifact| artifact.sha256.clone()),
            output_truncated: evidence.output_truncated,
            sandbox_backend: evidence.sandbox_backend.clone(),
            manifest_sha256: evidence.manifest_sha256.clone(),
        })
    }

    /// Reconstruct an observation from the exact immutable W3 manifest bytes.
    /// `WorkerExecutionEvidence` is nested in the existing W2 result envelope,
    /// so its new runtime-only process fields are intentionally skipped by
    /// serde. This method verifies the content digest and exact claim subject
    /// before restoring those fields from manifest schema v2.
    pub fn from_evidence_manifest(
        evidence: &WorkerExecutionEvidence,
        manifest_bytes: &[u8],
    ) -> Result<Self, String> {
        let actual_digest = format!("{:x}", Sha256::digest(manifest_bytes));
        if actual_digest != evidence.manifest_sha256 {
            return Err("worker evidence manifest bytes do not match the referenced digest".into());
        }
        let manifest: WorkerExecutionManifestV2 = serde_json::from_slice(manifest_bytes)
            .map_err(|error| format!("worker evidence manifest v2 is invalid: {error}"))?;
        if manifest.schema_version != 2
            || manifest.claim_id != evidence.claim_id
            || manifest.workflow_id != evidence.workflow_id
            || manifest.task_id != evidence.task_id
            || manifest.attempt != evidence.attempt
            || manifest.owner_epoch != evidence.owner_epoch
            || manifest.lease_id != evidence.lease_id
            || manifest.worker_id != evidence.worker_id
            || manifest.plan_sha256 != evidence.plan_sha256
            || manifest.command_sha256 != evidence.command_sha256
            || manifest.outcome != evidence.outcome
            || manifest.exit_code != evidence.exit_code
            || manifest.timed_out != evidence.timed_out
        {
            return Err(
                "worker evidence manifest subject does not match its result reference".into(),
            );
        }
        let mut restored = evidence.clone();
        restored.cancelled_after_start = manifest.cancelled_after_start;
        restored.process_observation = manifest.process_observation;
        Self::from_evidence(&restored)
    }
}

#[derive(Debug, Deserialize)]
struct WorkerExecutionManifestV2 {
    schema_version: u32,
    claim_id: String,
    workflow_id: String,
    task_id: String,
    attempt: u64,
    owner_epoch: u64,
    lease_id: String,
    worker_id: String,
    plan_sha256: String,
    command_sha256: String,
    outcome: WorkerOutcome,
    exit_code: Option<i32>,
    timed_out: bool,
    cancelled_after_start: bool,
    process_observation: Option<SandboxProcessObservation>,
}

/// Scope of a process-stop receipt. There is intentionally no provider or
/// workflow-settlement variant in this contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessStopScopeV1 {
    /// Only the local worker-owned execution cgroup/process tree was observed empty.
    LocalWorkerProcessTree,
}

/// Kernel evidence that the exact local execution cgroup became empty.
///
/// It is unsigned semantic evidence. W8 must authenticate the producer, and W2
/// must not use this alone to settle a lease or cancellation; W4 still owns
/// provider-side terminality.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessStopReceiptV1 {
    /// Workstream 3 payload version.
    pub schema_version: u32,
    /// Stable receipt identity derived from the exact local process proof.
    pub receipt_id: String,
    /// Related process observation identity.
    pub observation_id: String,
    /// Exact Control claim identity.
    pub claim_id: String,
    /// Workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Fenced attempt number.
    pub attempt: u64,
    /// Exact Control lease identity.
    pub lease_id: String,
    /// Monotonic Control owner epoch.
    pub owner_epoch: u64,
    /// Worker identity.
    pub worker_id: String,
    /// Direct host launcher PID.
    pub process_id: u32,
    /// Unique per-execution cgroup identifier; no host filesystem path is exposed.
    pub cgroup_id: String,
    /// Unix milliseconds before writing `1` to `cgroup.kill`.
    pub kill_requested_at_unix_ms: u64,
    /// Unix milliseconds when the kernel reported `populated 0`.
    pub populated_zero_observed_at_unix_ms: u64,
    /// Explicitly local-only proof scope.
    pub scope: ProcessStopScopeV1,
    /// Kernel mechanism that produced this observation.
    pub proof_kind: String,
}

impl ProcessStopReceiptV1 {
    /// Build a receipt only when the sandbox supplied cgroup-v2 populated-zero
    /// evidence. Exit code, timeout flags and fake backend results are not enough.
    pub fn from_observation(observation: &ProcessObservationV1) -> Result<Option<Self>, String> {
        let Some(process) = observation.process.as_ref() else {
            return Ok(None);
        };
        validate_process_times(process)?;
        let subject = json!({
            "observation_id": observation.observation_id,
            "cgroup_id": process.cgroup.cgroup_id,
            "process_id": process.process_id,
            "kill_requested_at_unix_ms": process.cgroup.kill_requested_at_unix_ms,
            "populated_zero_observed_at_unix_ms": process.cgroup.populated_zero_observed_at_unix_ms,
            "scope": ProcessStopScopeV1::LocalWorkerProcessTree
        });
        let receipt_id = stable_id("process-stop-receipt", &subject)?;
        Ok(Some(Self {
            schema_version: WORKER_OBSERVATION_SCHEMA_VERSION,
            receipt_id,
            observation_id: observation.observation_id.clone(),
            claim_id: observation.claim_id.clone(),
            workflow_id: observation.workflow_id.clone(),
            task_id: observation.task_id.clone(),
            attempt: observation.attempt,
            lease_id: observation.lease_id.clone(),
            owner_epoch: observation.owner_epoch,
            worker_id: observation.worker_id.clone(),
            process_id: process.process_id,
            cgroup_id: process.cgroup.cgroup_id.clone(),
            kill_requested_at_unix_ms: process.cgroup.kill_requested_at_unix_ms,
            populated_zero_observed_at_unix_ms: process.cgroup.populated_zero_observed_at_unix_ms,
            scope: ProcessStopScopeV1::LocalWorkerProcessTree,
            proof_kind: "linux_cgroup_v2_populated_zero".into(),
        }))
    }
}

/// Deliberately narrow health payload: this check reports only worker-local
/// durable-store availability, not Control, provider or quota-host readiness.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerHealthV1 {
    /// Workstream 3 payload version.
    pub schema_version: u32,
    /// Worker identity.
    pub worker_id: String,
    /// Health scope, fixed to the local worker store.
    pub scope: WorkerHealthScopeV1,
    /// Local store health result.
    pub local_store: LocalStoreHealthV1,
    /// Read-only row counts returned by the local store.
    pub durable_row_counts: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
/// Limits the worker health response to the explicitly checked local subsystem.
pub enum WorkerHealthScopeV1 {
    /// No remote dependency or host project-quota guarantee is implied.
    LocalStoreOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
/// Availability state of the local durable worker store.
pub enum LocalStoreHealthV1 {
    /// Read-only local store open and row-count query both succeeded.
    Available,
}

impl WorkerHealthV1 {
    /// Build a local-only health response after the caller has successfully
    /// opened the store read-only and obtained its counts.
    pub fn local_store_available(
        worker_id: impl Into<String>,
        durable_row_counts: BTreeMap<String, u64>,
    ) -> Self {
        Self {
            schema_version: WORKER_OBSERVATION_SCHEMA_VERSION,
            worker_id: worker_id.into(),
            scope: WorkerHealthScopeV1::LocalStoreOnly,
            local_store: LocalStoreHealthV1::Available,
            durable_row_counts,
        }
    }
}

fn claim_subject(envelope: &TaskClaimEnvelope) -> serde_json::Value {
    json!({
        "schema_version": WORKER_OBSERVATION_SCHEMA_VERSION,
        "claim_id": envelope.claim_id,
        "issuer": envelope.issuer,
        "audience": envelope.audience,
        "workflow_id": envelope.workflow_id,
        "task_id": envelope.task_id,
        "attempt": envelope.attempt,
        "lease_id": envelope.lease_id,
        "owner_epoch": envelope.owner_epoch,
        "worker_id": envelope.worker_id,
        "plan_sha256": envelope.plan_sha256,
        "command_sha256": envelope.command_sha256
    })
}

fn stable_id<T: Serialize>(kind: &str, subject: &T) -> Result<String, String> {
    let digest = content_hash(subject).map_err(|error| error.to_string())?;
    Ok(format!("w3:{kind}:v1:{digest}"))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_process_observation(process: Option<&SandboxProcessObservation>) -> Result<(), String> {
    if let Some(process) = process {
        validate_process_times(process)?;
    }
    Ok(())
}

fn validate_process_times(process: &SandboxProcessObservation) -> Result<(), String> {
    if process.process_id == 0
        || process.started_at_unix_ms > process.finished_at_unix_ms
        || process.cgroup.cgroup_id.trim().is_empty()
        || process.cgroup.cgroup_id.len() > 128
        || !process.cgroup.cgroup_id.starts_with("runalith-")
        || process.cgroup.kill_requested_at_unix_ms
            > process.cgroup.populated_zero_observed_at_unix_ms
        || process.cgroup.populated_zero_observed_at_unix_ms > process.finished_at_unix_ms
    {
        return Err("sandbox process/cgroup quiescence observation is inconsistent".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use runalith_artifacts::StoredArtifact;
    use runalith_domain::content_hash;
    use runalith_sandbox::{CgroupCleanupEvidence, CommandRequest};

    struct AcceptClaim;

    impl crate::TaskClaimVerifier for AcceptClaim {
        fn verify(&self, _claim: &TaskClaimEnvelope) -> Result<(), String> {
            Ok(())
        }
    }

    fn verified_claim() -> VerifiedTaskClaim {
        let now = Utc::now();
        let command = CommandRequest {
            executable: "/usr/bin/true".into(),
            arguments: vec![],
            working_directory: ".".into(),
            environment: BTreeMap::new(),
            stdin: vec![],
        };
        let envelope = TaskClaimEnvelope {
            schema_version: crate::TASK_CLAIM_SCHEMA_VERSION,
            claim_id: "claim-observation-1".into(),
            issuer: "control".into(),
            audience: "worker-1".into(),
            issued_at: now.to_rfc3339(),
            expires_at: (now + Duration::minutes(1)).to_rfc3339(),
            workflow_id: "workflow-1".into(),
            task_id: "task-1".into(),
            attempt: 2,
            owner_epoch: 7,
            lease_id: "lease-1".into(),
            worker_id: "worker-1".into(),
            plan_sha256: "a".repeat(64),
            command_sha256: content_hash(&command).unwrap(),
            idempotency_key: "claim-observation-idem".into(),
            authenticator: json!({"acl_sha256":"b".repeat(64)}),
            command,
            provider_dispatch: None,
            session_messages: vec![],
        };
        VerifiedTaskClaim::verify(envelope, "worker-1", now, &AcceptClaim).unwrap()
    }

    fn artifact(sha256: &str, media_type: &str) -> StoredArtifact {
        StoredArtifact {
            artifact_id: format!("sha256:{sha256}"),
            sha256: sha256.to_owned(),
            byte_len: 0,
            media_type: media_type.to_owned(),
        }
    }

    fn execution_evidence(process: Option<SandboxProcessObservation>) -> WorkerExecutionEvidence {
        WorkerExecutionEvidence {
            claim_id: "claim-observation-1".into(),
            workflow_id: "workflow-1".into(),
            task_id: "task-1".into(),
            attempt: 2,
            owner_epoch: 7,
            lease_id: "lease-1".into(),
            worker_id: "worker-1".into(),
            plan_sha256: "a".repeat(64),
            command_sha256: "b".repeat(64),
            outcome: WorkerOutcome::Unknown,
            exit_code: None,
            timed_out: false,
            cancelled_after_start: true,
            process_observation: process,
            stdout: Some(artifact(&"c".repeat(64), "application/octet-stream")),
            stderr: Some(artifact(&"d".repeat(64), "application/octet-stream")),
            output_truncated: false,
            sandbox_backend: Some("bubblewrap-linux-network-isolated".into()),
            manifest_sha256: "e".repeat(64),
            manifest: artifact(&"e".repeat(64), "application/json"),
        }
    }

    fn stopped_process() -> SandboxProcessObservation {
        SandboxProcessObservation {
            process_id: 4321,
            started_at_unix_ms: 100,
            finished_at_unix_ms: 140,
            cgroup: CgroupCleanupEvidence {
                cgroup_id: "runalith-0123456789abcdef".into(),
                kill_requested_at_unix_ms: 120,
                populated_zero_observed_at_unix_ms: 130,
            },
        }
    }

    #[test]
    fn claim_accepted_payload_requires_verified_claim_and_omits_authenticator() {
        let claim = verified_claim();
        let event = WorkerClaimAcceptedV1::from_verified(&claim).unwrap();
        let repeated = WorkerClaimAcceptedV1::from_verified(&claim).unwrap();

        assert_eq!(event.schema_version, WORKER_OBSERVATION_SCHEMA_VERSION);
        assert_eq!(event.event_id, repeated.event_id);
        assert_eq!(event.owner_epoch, 7);
        let json = serde_json::to_value(event).unwrap();
        assert!(json.get("authenticator").is_none());
        assert!(json.get("command").is_none());
    }

    #[test]
    fn process_stop_receipt_requires_exact_cgroup_empty_observation() {
        let evidence = execution_evidence(Some(stopped_process()));
        let observation = ProcessObservationV1::from_evidence(&evidence).unwrap();
        let receipt = ProcessStopReceiptV1::from_observation(&observation)
            .unwrap()
            .unwrap();

        assert_eq!(receipt.scope, ProcessStopScopeV1::LocalWorkerProcessTree);
        assert_eq!(receipt.proof_kind, "linux_cgroup_v2_populated_zero");
        assert_eq!(receipt.process_id, 4321);
        assert_eq!(receipt.populated_zero_observed_at_unix_ms, 130);
        assert_eq!(observation.outcome, WorkerOutcome::Unknown);
        assert!(observation.cancelled_after_start);
        let payload = serde_json::to_value(receipt).unwrap();
        assert!(payload.get("provider_terminal").is_none());
        assert!(payload.get("lease_settled").is_none());
    }

    #[test]
    fn runtime_process_fields_do_not_change_existing_task_result_json() {
        let evidence = execution_evidence(Some(stopped_process()));
        let payload = serde_json::to_value(&evidence).unwrap();
        assert!(payload.get("cancelled_after_start").is_none());
        assert!(payload.get("process_observation").is_none());

        let decoded: WorkerExecutionEvidence = serde_json::from_value(payload).unwrap();
        assert!(!decoded.cancelled_after_start);
        assert!(decoded.process_observation.is_none());
        assert_eq!(decoded.manifest_sha256, evidence.manifest_sha256);
    }

    #[test]
    fn process_observation_can_be_reconstructed_from_exact_v2_manifest_after_restart() {
        let process = stopped_process();
        let mut evidence = execution_evidence(Some(process.clone()));
        let manifest = json!({
            "schema_version": 2,
            "claim_id": evidence.claim_id,
            "workflow_id": evidence.workflow_id,
            "task_id": evidence.task_id,
            "attempt": evidence.attempt,
            "owner_epoch": evidence.owner_epoch,
            "lease_id": evidence.lease_id,
            "worker_id": evidence.worker_id,
            "plan_sha256": evidence.plan_sha256,
            "command_sha256": evidence.command_sha256,
            "outcome": evidence.outcome,
            "exit_code": evidence.exit_code,
            "timed_out": evidence.timed_out,
            "cancelled_after_start": true,
            "process_observation": process,
            "stdout": evidence.stdout,
            "stderr": evidence.stderr,
            "stdout_sha256": evidence.stdout.as_ref().map(|artifact| artifact.sha256.as_str()),
            "stderr_sha256": evidence.stderr.as_ref().map(|artifact| artifact.sha256.as_str()),
            "output_truncated": evidence.output_truncated,
            "sandbox_backend": evidence.sandbox_backend,
            "diagnostic": null
        });
        let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        let digest = format!("{:x}", Sha256::digest(&manifest_bytes));
        evidence.manifest_sha256 = digest.clone();
        evidence.manifest = artifact(&digest, "application/json");

        // Simulate the W2 result-envelope round trip: runtime-only fields are
        // not on the wire, but the content-addressed manifest ref remains.
        let persisted_reference: WorkerExecutionEvidence =
            serde_json::from_slice(&serde_json::to_vec(&evidence).unwrap()).unwrap();
        assert!(persisted_reference.process_observation.is_none());
        let observation =
            ProcessObservationV1::from_evidence_manifest(&persisted_reference, &manifest_bytes)
                .unwrap();
        assert!(observation.cancelled_after_start);
        assert_eq!(observation.process.unwrap(), stopped_process());
        assert_eq!(observation.manifest_sha256, digest);
    }

    #[test]
    fn rejects_manifest_with_tampered_bytes_or_wrong_claim_subject() {
        let mut evidence = execution_evidence(Some(stopped_process()));
        let manifest = json!({
            "schema_version": 2,
            "claim_id": "another-claim",
            "workflow_id": evidence.workflow_id,
            "task_id": evidence.task_id,
            "attempt": evidence.attempt,
            "owner_epoch": evidence.owner_epoch,
            "lease_id": evidence.lease_id,
            "worker_id": evidence.worker_id,
            "plan_sha256": evidence.plan_sha256,
            "command_sha256": evidence.command_sha256,
            "outcome": evidence.outcome,
            "exit_code": evidence.exit_code,
            "timed_out": evidence.timed_out,
            "cancelled_after_start": true,
            "process_observation": stopped_process()
        });
        let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        let digest = format!("{:x}", Sha256::digest(&manifest_bytes));
        evidence.manifest_sha256 = digest.clone();
        evidence.manifest = artifact(&digest, "application/json");
        let error =
            ProcessObservationV1::from_evidence_manifest(&evidence, &manifest_bytes).unwrap_err();
        assert!(error.contains("subject"));

        let error = ProcessObservationV1::from_evidence_manifest(&evidence, b"{}").unwrap_err();
        assert!(error.contains("digest"));
    }

    #[test]
    fn fake_backend_or_missing_process_observation_cannot_mint_stop_receipt() {
        let observation = ProcessObservationV1::from_evidence(&execution_evidence(None)).unwrap();
        assert!(
            ProcessStopReceiptV1::from_observation(&observation)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn rejects_cgroup_evidence_with_non_monotonic_kernel_times() {
        let mut process = stopped_process();
        process.cgroup.populated_zero_observed_at_unix_ms = 110;
        let error =
            ProcessObservationV1::from_evidence(&execution_evidence(Some(process))).unwrap_err();
        assert!(error.contains("inconsistent"));
    }

    #[test]
    fn worker_health_is_explicitly_local_store_only() {
        let health = WorkerHealthV1::local_store_available(
            "worker-1",
            BTreeMap::from([("worker_inbox".into(), 3), ("worker_outbox".into(), 1)]),
        );
        assert_eq!(health.scope, WorkerHealthScopeV1::LocalStoreOnly);
        assert_eq!(health.local_store, LocalStoreHealthV1::Available);
        assert_eq!(health.durable_row_counts.get("worker_inbox"), Some(&3));
    }
}
