//! Worker-owned durable inbox, outbox and provider reconciliation ledger.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use chrono::Utc;
use runalith_domain::content_hash;
use runalith_execution_persistence::{
    ProviderDispatchState, ProviderIntentOutcome, ProviderIntentRecord,
    ProviderReconciliationObservation,
};
use runalith_providers::{ProviderDispatchRequest, ProviderDispatchResponse};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

use crate::{TaskClaimEnvelope, WorkerExecutionEvidence, WorkerOutcome};

const SCHEMA_VERSION: i64 = 7;
type ExecutionWorkspaceDbRow = (
    String,
    String,
    i64,
    i64,
    String,
    String,
    i64,
    String,
    Option<i64>,
    Option<i64>,
    i64,
    i64,
    String,
);
type ProviderFenceClaimDbRow = (
    String,
    String,
    String,
    i64,
    i64,
    String,
    String,
    String,
    String,
);

/// Durable claim inbox state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum InboxState {
    /// Claim is durable and waiting for execution.
    Received,
    /// Execution began; recovery must classify interruption as UNKNOWN.
    Running,
    /// Process completed with exit code zero.
    Succeeded,
    /// Process completed unsuccessfully or timed out.
    Failed,
    /// Process/provider outcome cannot be established.
    Unknown,
    /// Sandbox proves process never started.
    NotStarted,
}

/// Stable result event persisted atomically with terminal inbox state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerResultEvent {
    /// Stable event ID used as Control inbox idempotency key.
    pub event_id: String,
    /// Versioned protocol contract.
    pub schema_version: u32,
    /// Worker producer identity.
    pub producer: String,
    /// Exact workflow/task/attempt/lease fencing binding.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Attempt identity.
    pub attempt: u64,
    /// Current owner epoch.
    pub owner_epoch: u64,
    /// Lease identity.
    pub lease_id: String,
    /// Immutable plan digest.
    pub plan_sha256: String,
    /// Claim identity.
    pub claim_id: String,
    /// Worker identity that executed the claim.
    pub worker_id: String,
    /// Exact command digest from the immutable claim.
    pub command_sha256: String,
    /// Stable execution idempotency identity.
    pub idempotency_key: String,
    /// Exact classified execution outcome.
    pub outcome: WorkerOutcome,
    /// Content-addressed evidence manifest reference.
    pub evidence: Option<WorkerExecutionEvidence>,
    /// Diagnostic for recovered or interrupted execution.
    pub diagnostic: Option<String>,
    /// Event creation timestamp.
    pub created_at: String,
}

/// Claimed durable outbox item.
#[derive(Debug, Clone, PartialEq)]
pub struct OutboxLease {
    /// Event identity.
    pub event_id: String,
    /// Lease token owned by this dispatcher.
    pub lease_token: String,
    /// Decoded immutable event.
    pub event: WorkerResultEvent,
    /// Current delivery attempt.
    pub attempts: u64,
}

/// Provider intent paired with the Control lease epoch that authorized it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FencedProviderIntent {
    /// Immutable provider request and durable dispatch identity.
    pub intent: ProviderIntentRecord,
    /// Control owner epoch observed when intent was reserved.
    pub owner_epoch: u64,
    /// Exact Control reservation retained until terminal reconciliation.
    #[serde(default)]
    pub execution_fence: Option<crate::ExecutionFence>,
    /// Exact reservation request, durably recorded before calling Control.
    /// It permits a byte-equivalent idempotent retry when the reservation
    /// committed remotely but the HTTP response was lost.
    #[serde(default)]
    pub execution_fence_request: Option<crate::ExecutionFenceRequest>,
}

/// Durable project-quota workspace assignment for one exact execution claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionWorkspaceRecord {
    /// Exact durable worker claim identity.
    pub claim_id: String,
    /// Workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Attempt number.
    pub attempt: u64,
    /// Control owner epoch.
    pub owner_epoch: u64,
    /// Lease identity.
    pub lease_id: String,
    /// Worker identity.
    pub worker_id: String,
    /// Monotonic project ID; never reused, including after release.
    pub project_id: u32,
    /// Private host path to the exact workspace directory.
    pub workspace_path: PathBuf,
    /// Device identity recorded after assignment.
    pub device: Option<u64>,
    /// Inode identity recorded after assignment.
    pub inode: Option<u64>,
    /// Kernel-enforced byte hard limit.
    pub byte_limit: u64,
    /// Kernel-enforced inode hard limit.
    pub inode_limit: u64,
    /// Durable lifecycle state.
    pub state: ExecutionWorkspaceState,
}

/// Durable project-quota workspace lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExecutionWorkspaceState {
    /// Intent persisted; workspace creation or quota assignment may be incomplete.
    Allocating,
    /// Directory identity and kernel hard limits were verified.
    Active,
    /// Directory was removed and quota readback confirmed zero charge.
    Released,
    /// Cleanup or recovery is ambiguous; project ID remains permanently reserved.
    Quarantined,
}

/// Fenced session message queued for Control-mediated delivery.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionDeliveryEnvelope {
    /// Stable message identity.
    pub message_id: String,
    /// Stable cross-service idempotency key.
    pub idempotency_key: String,
    /// Workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Fenced attempt number.
    pub attempt: u64,
    /// Control owner epoch.
    pub owner_epoch: u64,
    /// Exact lease identity.
    pub lease_id: String,
    /// Worker identity.
    pub worker_id: String,
    /// Runtime session identity.
    pub session_id: String,
    /// Recipient role.
    pub recipient_role: String,
    /// Protocol message type.
    pub message_type: String,
    /// Structured message payload.
    pub payload: Value,
    /// Message expiry checked again by Control at delivery time.
    pub expires_at: String,
}

/// Local compare-and-set lease for one session delivery.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionDeliveryLease {
    /// Exact immutable message.
    pub message: SessionDeliveryEnvelope,
    /// Local lease token.
    pub lease_token: String,
}

/// Provider terminal result event fenced to the lease epoch that created its intent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderResultEvent {
    /// Stable Control inbox idempotency key.
    pub event_id: String,
    /// Immutable provider intent identity.
    pub intent_id: String,
    /// Provider adapter identity.
    pub provider_id: String,
    /// Workflow identity.
    pub workflow_id: String,
    /// Task identity.
    pub task_id: String,
    /// Attempt number.
    pub attempt: u64,
    /// Control owner epoch.
    pub owner_epoch: u64,
    /// Lease identity.
    pub lease_id: String,
    /// Worker identity.
    pub worker_id: String,
    /// Immutable plan digest.
    pub plan_sha256: String,
    /// Exact provider run identity.
    pub provider_run_id: String,
    /// Terminal task outcome.
    pub outcome: WorkerOutcome,
    /// Collected provider result and content-addressed artifact reference.
    pub result: Value,
    /// Event creation time.
    pub created_at: String,
}

/// Local lease for one provider result event.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderResultLease {
    /// Exact provider result event.
    pub event: ProviderResultEvent,
    /// Local outbox lease token.
    pub lease_token: String,
    /// Current delivery attempt.
    pub attempts: u64,
}

/// Worker-owned persistence error.
#[derive(Debug, Error)]
pub enum WorkerStoreError {
    /// SQLite operation failed.
    #[error("worker SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// JSON encoding failed.
    #[error("worker persistence JSON error: {0}")]
    Json(#[from] serde_json::Error),
    /// Filesystem operation failed.
    #[error("worker persistence filesystem error: {0}")]
    Io(#[from] std::io::Error),
    /// Claim ID or idempotency identity already belongs to another claim.
    #[error("worker claim conflicts with an existing durable inbox identity")]
    ClaimConflict,
    /// A compare-and-set ownership/state check failed.
    #[error("worker durable state transition rejected: {0}")]
    Transition(&'static str),
    /// The worker database schema is newer or unsupported.
    #[error("unsupported worker database schema version {0}")]
    Schema(i64),
    /// Worker database path is unsafe.
    #[error("worker database path is unsafe: {0}")]
    UnsafePath(String),
    /// Internal connection mutex was poisoned.
    #[error("worker database mutex poisoned")]
    Poisoned,
}

/// Independent Execution-owned SQLite store. Never opens Control's database.
pub struct WorkerStore {
    path: PathBuf,
    connection: Mutex<Connection>,
}

impl WorkerStore {
    /// Open or create a private worker database and apply only worker-local migrations.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, WorkerStoreError> {
        let path = path.as_ref();
        let parent = path.parent().ok_or_else(|| {
            WorkerStoreError::UnsafePath("database must have a parent directory".into())
        })?;
        if !path.is_absolute() {
            return Err(WorkerStoreError::UnsafePath(
                "database path must be absolute".into(),
            ));
        }
        if parent == Path::new("/") {
            return Err(WorkerStoreError::UnsafePath(
                "worker database cannot be placed directly in the filesystem root".into(),
            ));
        }
        let parent_existed = fs::symlink_metadata(parent).is_ok();
        reject_path_components(parent)?;
        fs::create_dir_all(parent)?;
        reject_path_components(parent)?;
        #[cfg(unix)]
        if !parent_existed {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
        } else {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            let parent_metadata = fs::metadata(parent)?;
            let parent_mode = parent_metadata.permissions().mode();
            if parent_mode & 0o022 != 0 {
                if parent_metadata.uid() != current_process_uid()? {
                    return Err(WorkerStoreError::UnsafePath(format!(
                        "worker database parent directory is writable by another owner (mode {:o}): {}",
                        parent_mode & 0o7777,
                        parent.display(),
                    )));
                }
                fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
            }
        }
        reject_path_components(path)?;
        if let Ok(metadata) = fs::symlink_metadata(path) {
            if !metadata.is_file() {
                return Err(WorkerStoreError::UnsafePath(path.display().to_string()));
            }
        }
        let mut connection = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
                | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
                | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;")?;
        initialize_schema(&mut connection)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }
        Ok(Self {
            path: fs::canonicalize(path)?,
            connection: Mutex::new(connection),
        })
    }

    /// Persist a per-execution project-quota intent and allocate a never-reused project ID.
    /// The claim must already be RUNNING in this worker's durable inbox.
    pub fn reserve_execution_workspace(
        &self,
        claim: &TaskClaimEnvelope,
        workspace_root: &Path,
        workspace_parent: &Path,
        byte_limit: u64,
        inode_limit: u64,
    ) -> Result<ExecutionWorkspaceRecord, WorkerStoreError> {
        if byte_limit == 0
            || inode_limit == 0
            || byte_limit > i64::MAX as u64
            || inode_limit > i64::MAX as u64
            || claim.owner_epoch == 0
            || claim.owner_epoch > i64::MAX as u64
            || claim.attempt == 0
            || claim.attempt > i64::MAX as u64
            || !workspace_root.is_absolute()
            || !workspace_parent.is_absolute()
            || !workspace_parent.starts_with(workspace_root)
            || workspace_parent == workspace_root
        {
            return Err(WorkerStoreError::Transition(
                "execution workspace identity, path or quota limit is invalid",
            ));
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let active: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM worker_inbox WHERE claim_id=?1 AND workflow_id=?2 AND task_id=?3 AND attempt=?4 AND owner_epoch=?5 AND lease_id=?6 AND worker_id=?7 AND state='RUNNING')",
            params![claim.claim_id,claim.workflow_id,claim.task_id,claim.attempt as i64,claim.owner_epoch as i64,claim.lease_id,claim.worker_id],
            |row| row.get(0),
        )?;
        if !active {
            return Err(WorkerStoreError::Transition(
                "execution workspace does not match an active durable claim",
            ));
        }
        let existing: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM worker_execution_workspaces WHERE claim_id=?1)",
            [claim.claim_id.as_str()],
            |row| row.get(0),
        )?;
        if existing {
            return Err(WorkerStoreError::ClaimConflict);
        }
        let previous: i64 = tx.query_row(
            "SELECT COALESCE(MAX(project_id),9999) FROM worker_execution_workspaces",
            [],
            |row| row.get(0),
        )?;
        let project_id = u32::try_from(previous)
            .ok()
            .and_then(|value| value.checked_add(1))
            .filter(|value| *value >= 10_000 && *value <= i32::MAX as u32)
            .ok_or(WorkerStoreError::Transition(
                "project ID allocator exhausted its non-reusable range",
            ))?;
        let workspace_path = workspace_parent.join(format!("execution-{project_id}"));
        tx.execute(
            "INSERT INTO worker_execution_workspaces(claim_id,workflow_id,task_id,attempt,owner_epoch,lease_id,worker_id,project_id,workspace_path,device,inode,byte_limit,inode_limit,state,diagnostic,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL,NULL,?10,?11,'ALLOCATING',NULL,?12,?12)",
            params![claim.claim_id,claim.workflow_id,claim.task_id,claim.attempt as i64,claim.owner_epoch as i64,claim.lease_id,claim.worker_id,project_id,workspace_path.to_string_lossy(),byte_limit as i64,inode_limit as i64,Utc::now().to_rfc3339()],
        )?;
        tx.commit()?;
        Ok(ExecutionWorkspaceRecord {
            claim_id: claim.claim_id.clone(),
            workflow_id: claim.workflow_id.clone(),
            task_id: claim.task_id.clone(),
            attempt: claim.attempt,
            owner_epoch: claim.owner_epoch,
            lease_id: claim.lease_id.clone(),
            worker_id: claim.worker_id.clone(),
            project_id,
            workspace_path: workspace_path.to_owned(),
            device: None,
            inode: None,
            byte_limit,
            inode_limit,
            state: ExecutionWorkspaceState::Allocating,
        })
    }

    /// Mark a workspace ACTIVE only after the filesystem project ID and both hard limits were read back.
    pub fn activate_execution_workspace(
        &self,
        record: &ExecutionWorkspaceRecord,
        device: u64,
        inode: u64,
    ) -> Result<(), WorkerStoreError> {
        if device > i64::MAX as u64 || inode > i64::MAX as u64 {
            return Err(WorkerStoreError::Transition(
                "workspace device or inode exceeds SQLite integer range",
            ));
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let claim_running: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM worker_inbox WHERE claim_id=?1 AND workflow_id=?2 AND task_id=?3 AND attempt=?4 AND owner_epoch=?5 AND lease_id=?6 AND worker_id=?7 AND state='RUNNING')",
            params![record.claim_id,record.workflow_id,record.task_id,record.attempt as i64,record.owner_epoch as i64,record.lease_id,record.worker_id],
            |row| row.get(0),
        )?;
        if !claim_running {
            return Err(WorkerStoreError::Transition(
                "execution workspace claim is no longer RUNNING",
            ));
        }
        let changed = tx.execute(
            "UPDATE worker_execution_workspaces SET device=?3,inode=?4,state='ACTIVE',updated_at=?5 WHERE claim_id=?1 AND project_id=?2 AND workspace_path=?6 AND state='ALLOCATING' AND device IS NULL AND inode IS NULL",
            params![record.claim_id,record.project_id,device as i64,inode as i64,Utc::now().to_rfc3339(),record.workspace_path.to_string_lossy()],
        )?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition(
                "execution workspace activation lost compare-and-set",
            ));
        }
        tx.commit()?;
        Ok(())
    }

    /// Mark a workspace QUARANTINED. Its project ID is permanently retained.
    pub fn quarantine_execution_workspace(
        &self,
        claim_id: &str,
        project_id: u32,
        diagnostic: &str,
    ) -> Result<(), WorkerStoreError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let changed = connection.execute(
            "UPDATE worker_execution_workspaces SET state='QUARANTINED',diagnostic=?3,updated_at=?4 WHERE claim_id=?1 AND project_id=?2 AND state IN ('ALLOCATING','ACTIVE','QUARANTINED')",
            params![claim_id,project_id,bounded_diagnostic(diagnostic),Utc::now().to_rfc3339()],
        )?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition(
                "execution workspace quarantine lost compare-and-set",
            ));
        }
        Ok(())
    }

    /// Mark an exact workspace RELEASED after its directory is gone and kernel usage is zero.
    pub fn release_execution_workspace(
        &self,
        record: &ExecutionWorkspaceRecord,
    ) -> Result<(), WorkerStoreError> {
        let (Some(device), Some(inode)) = (record.device, record.inode) else {
            return Err(WorkerStoreError::Transition(
                "execution workspace release omitted its device/inode identity",
            ));
        };
        if device > i64::MAX as u64 || inode > i64::MAX as u64 {
            return Err(WorkerStoreError::Transition(
                "execution workspace device/inode exceeds SQLite range",
            ));
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let changed = connection.execute(
            "UPDATE worker_execution_workspaces SET state='RELEASED',updated_at=?6 WHERE claim_id=?1 AND project_id=?2 AND workspace_path=?3 AND device=?4 AND inode=?5 AND state='ACTIVE'",
            params![record.claim_id,record.project_id,record.workspace_path.to_string_lossy(),device as i64,inode as i64,Utc::now().to_rfc3339()],
        )?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition(
                "execution workspace release lost compare-and-set",
            ));
        }
        Ok(())
    }

    /// Quarantine ALLOCATING/ACTIVE rows after process restart; never infer an empty workspace.
    pub fn quarantine_unrecovered_execution_workspaces(&self) -> Result<usize, WorkerStoreError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let changed = connection.execute(
            "UPDATE worker_execution_workspaces SET state='QUARANTINED',diagnostic='worker restarted before workspace release was durably confirmed',updated_at=?1 WHERE state IN ('ALLOCATING','ACTIVE')",
            [Utc::now().to_rfc3339()],
        )?;
        Ok(changed)
    }

    /// Read one exact workspace ledger record for recovery/operator inspection.
    pub fn execution_workspace(
        &self,
        claim_id: &str,
    ) -> Result<Option<ExecutionWorkspaceRecord>, WorkerStoreError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let row: Option<ExecutionWorkspaceDbRow> = connection.query_row(
            "SELECT workflow_id,task_id,attempt,owner_epoch,lease_id,worker_id,project_id,workspace_path,device,inode,byte_limit,inode_limit,state FROM worker_execution_workspaces WHERE claim_id=?1",
            [claim_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?,row.get(11)?,row.get(12)?)),
        ).optional()?;
        row.map(|row| {
            Ok(ExecutionWorkspaceRecord {
                claim_id: claim_id.to_owned(),
                workflow_id: row.0,
                task_id: row.1,
                attempt: u64::try_from(row.2)
                    .map_err(|_| WorkerStoreError::Transition("workspace attempt is negative"))?,
                owner_epoch: u64::try_from(row.3).map_err(|_| {
                    WorkerStoreError::Transition("workspace owner epoch is negative")
                })?,
                lease_id: row.4,
                worker_id: row.5,
                project_id: u32::try_from(row.6)
                    .map_err(|_| WorkerStoreError::Transition("workspace project ID is invalid"))?,
                workspace_path: PathBuf::from(row.7),
                device: row
                    .8
                    .map(|value| {
                        u64::try_from(value).map_err(|_| {
                            WorkerStoreError::Transition("workspace device is invalid")
                        })
                    })
                    .transpose()?,
                inode: row
                    .9
                    .map(|value| {
                        u64::try_from(value)
                            .map_err(|_| WorkerStoreError::Transition("workspace inode is invalid"))
                    })
                    .transpose()?,
                byte_limit: u64::try_from(row.10)
                    .map_err(|_| WorkerStoreError::Transition("workspace byte limit is invalid"))?,
                inode_limit: u64::try_from(row.11).map_err(|_| {
                    WorkerStoreError::Transition("workspace inode limit is invalid")
                })?,
                state: match row.12.as_str() {
                    "ALLOCATING" => ExecutionWorkspaceState::Allocating,
                    "ACTIVE" => ExecutionWorkspaceState::Active,
                    "RELEASED" => ExecutionWorkspaceState::Released,
                    "QUARANTINED" => ExecutionWorkspaceState::Quarantined,
                    _ => {
                        return Err(WorkerStoreError::Transition(
                            "workspace lifecycle state is invalid",
                        ));
                    }
                },
            })
        })
        .transpose()
    }

    /// Open an initialized current-version worker database without creating or migrating it.
    pub fn open_read_only(path: impl AsRef<Path>) -> Result<Self, WorkerStoreError> {
        let path = path.as_ref();
        if !path.is_absolute() || path.parent() == Some(Path::new("/")) {
            return Err(WorkerStoreError::UnsafePath(path.display().to_string()));
        }
        reject_path_components(path)?;
        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(WorkerStoreError::UnsafePath(path.display().to_string()));
        }
        let connection = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;")?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version != SCHEMA_VERSION {
            return Err(WorkerStoreError::Transition(
                "read-only worker database schema is not current",
            ));
        }
        Ok(Self {
            path: fs::canonicalize(path)?,
            connection: Mutex::new(connection),
        })
    }

    /// Canonical worker database path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Acquire the singleton process lease for this worker database.
    pub fn acquire_process_lock(&self) -> Result<String, WorkerStoreError> {
        let pid = std::process::id();
        let start_ticks = process_start_ticks(pid)?.ok_or(WorkerStoreError::Transition(
            "cannot establish current worker process identity",
        ))?;
        let token = Uuid::new_v4().to_string();
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(u32, u64)> = tx
            .query_row(
                "SELECT pid,process_start_ticks FROM worker_runtime_lock WHERE singleton=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((existing_pid, existing_start)) = existing {
            if process_start_ticks(existing_pid)? == Some(existing_start) {
                return Err(WorkerStoreError::Transition(
                    "another worker process already owns this database",
                ));
            }
        }
        tx.execute(
            "INSERT INTO worker_runtime_lock(singleton,pid,process_start_ticks,lock_token,acquired_at) VALUES(1,?1,?2,?3,?4) ON CONFLICT(singleton) DO UPDATE SET pid=excluded.pid,process_start_ticks=excluded.process_start_ticks,lock_token=excluded.lock_token,acquired_at=excluded.acquired_at",
            params![pid, start_ticks, token, Utc::now().to_rfc3339()],
        )?;
        tx.commit()?;
        Ok(token)
    }

    /// Release only the exact process lease acquired by this instance.
    pub fn release_process_lock(&self, token: &str) -> Result<(), WorkerStoreError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let changed = connection.execute(
            "DELETE FROM worker_runtime_lock WHERE singleton=1 AND lock_token=?1",
            [token],
        )?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition(
                "worker process lock token is stale",
            ));
        }
        Ok(())
    }

    /// Insert one authenticated claim. Exact duplicate delivery is idempotent.
    pub fn accept_claim(&self, claim: &TaskClaimEnvelope) -> Result<bool, WorkerStoreError> {
        let json = serde_json::to_vec(claim)?;
        let digest = sha256(&json);
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(String, String)> = tx.query_row(
            "SELECT claim_sha256, claim_json FROM worker_inbox WHERE claim_id=?1 OR idempotency_key=?2 OR (workflow_id=?3 AND task_id=?4 AND attempt=?5)",
            params![claim.claim_id, claim.idempotency_key, claim.workflow_id, claim.task_id, claim.attempt as i64],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        if let Some((existing_digest, existing_json)) = existing {
            if existing_digest != digest || existing_json.as_bytes() != json.as_slice() {
                return Err(WorkerStoreError::ClaimConflict);
            }
            tx.commit()?;
            return Ok(false);
        }
        tx.execute("INSERT INTO worker_inbox(claim_id,idempotency_key,workflow_id,task_id,attempt,owner_epoch,lease_id,worker_id,plan_sha256,command_sha256,claim_json,claim_sha256,state,accepted_at,lease_expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'RECEIVED',?13,?14)", params![claim.claim_id, claim.idempotency_key, claim.workflow_id, claim.task_id, claim.attempt as i64, claim.owner_epoch as i64, claim.lease_id, claim.worker_id, claim.plan_sha256, claim.command_sha256, String::from_utf8(json).map_err(|_| WorkerStoreError::Transition("claim JSON was not UTF-8"))?, digest, Utc::now().to_rfc3339(), claim.expires_at])?;
        tx.commit()?;
        Ok(true)
    }

    /// Return the oldest durable claim accepted but not yet begun by this worker.
    pub fn next_received_claim(
        &self,
        worker_id: &str,
    ) -> Result<Option<TaskClaimEnvelope>, WorkerStoreError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let json: Option<String> = connection.query_row(
            "SELECT claim_json FROM worker_inbox WHERE worker_id=?1 AND owner_epoch>0 AND state='RECEIVED' ORDER BY accepted_at,claim_id LIMIT 1",
            [worker_id],
            |row| row.get(0),
        ).optional()?;
        json.map(|json| serde_json::from_str(&json).map_err(WorkerStoreError::from))
            .transpose()
    }

    /// Atomically claim a RECEIVED item for execution. Competing processes have one winner.
    pub fn begin_claim(
        &self,
        claim_id: &str,
        worker_id: &str,
        owner_epoch: u64,
    ) -> Result<TaskClaimEnvelope, WorkerStoreError> {
        self.begin_claim_with_session_messages(claim_id, worker_id, owner_epoch, &[])
    }

    /// Atomically begin a claim and enqueue every claim-authorized session message.
    pub fn begin_claim_with_session_messages(
        &self,
        claim_id: &str,
        worker_id: &str,
        owner_epoch: u64,
        messages: &[SessionDeliveryEnvelope],
    ) -> Result<TaskClaimEnvelope, WorkerStoreError> {
        self.try_begin_claim_with_session_messages(claim_id, worker_id, owner_epoch, messages)?
            .ok_or(WorkerStoreError::Transition(
                "claim is no longer RECEIVED at current owner epoch",
            ))
    }

    /// Begin a RECEIVED claim once; `None` means another process or prior run advanced it.
    pub fn try_begin_claim_with_session_messages(
        &self,
        claim_id: &str,
        worker_id: &str,
        owner_epoch: u64,
        messages: &[SessionDeliveryEnvelope],
    ) -> Result<Option<TaskClaimEnvelope>, WorkerStoreError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(String, String, i64)> = tx.query_row("SELECT claim_json,state,owner_epoch FROM worker_inbox WHERE claim_id=?1 AND worker_id=?2", params![claim_id, worker_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;
        let (json, state, epoch) = row.ok_or(WorkerStoreError::Transition(
            "claim missing or worker identity mismatch",
        ))?;
        if state != "RECEIVED" || epoch != owner_epoch as i64 {
            tx.commit()?;
            return Ok(None);
        }
        let claim: TaskClaimEnvelope = serde_json::from_str(&json)?;
        if chrono::DateTime::parse_from_rfc3339(&claim.expires_at)
            .map(|expiry| expiry <= Utc::now())
            .unwrap_or(true)
        {
            return Err(WorkerStoreError::Transition(
                "claim expired before durable execution start",
            ));
        }
        if claim.session_messages != messages {
            return Err(WorkerStoreError::Transition(
                "session delivery batch does not match authenticated claim payload",
            ));
        }
        let changed = tx.execute("UPDATE worker_inbox SET state='RUNNING',started_at=?2 WHERE claim_id=?1 AND state='RECEIVED' AND owner_epoch=?3", params![claim_id,Utc::now().to_rfc3339(),owner_epoch as i64])?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition(
                "claim start lost compare-and-set",
            ));
        }
        for message in messages {
            enqueue_session_delivery_tx(&tx, message)?;
        }
        tx.commit()?;
        Ok(Some(claim))
    }

    /// Persist outcome and result event in one transaction. Duplicate identical finalization is safe.
    pub fn complete_claim(&self, event: &WorkerResultEvent) -> Result<(), WorkerStoreError> {
        self.complete_claim_from_state(event, "RUNNING")
    }

    /// Finalize a durable claim that expired before it entered RUNNING.
    pub fn complete_received_claim(
        &self,
        event: &WorkerResultEvent,
    ) -> Result<(), WorkerStoreError> {
        if event.outcome != WorkerOutcome::NotStarted || event.evidence.is_some() {
            return Err(WorkerStoreError::Transition(
                "RECEIVED claims can only complete as NOT_STARTED",
            ));
        }
        self.complete_claim_from_state(event, "RECEIVED")
    }

    fn complete_claim_from_state(
        &self,
        event: &WorkerResultEvent,
        expected_state: &'static str,
    ) -> Result<(), WorkerStoreError> {
        let event_json = serde_json::to_string(event)?;
        let event_digest = sha256(event_json.as_bytes());
        let state = match event.outcome {
            WorkerOutcome::Succeeded => "SUCCEEDED",
            WorkerOutcome::Failed => "FAILED",
            WorkerOutcome::Unknown => "UNKNOWN",
            WorkerOutcome::NotStarted => "NOT_STARTED",
        };
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(String, String)> = tx
            .query_row(
                "SELECT event_sha256,event_json FROM worker_outbox WHERE event_id=?1",
                [&event.event_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((digest, json)) = existing {
            if digest != event_digest || json != event_json {
                return Err(WorkerStoreError::ClaimConflict);
            }
            tx.commit()?;
            return Ok(());
        }
        let changed = tx.execute("UPDATE worker_inbox SET state=?2,finished_at=?3,evidence_json=?4 WHERE claim_id=?1 AND state=?5 AND workflow_id=?6 AND task_id=?7 AND attempt=?8 AND owner_epoch=?9 AND lease_id=?10 AND worker_id=?11 AND plan_sha256=?12 AND command_sha256=?13 AND idempotency_key=?14", params![event.claim_id,state,event.created_at,event.evidence.as_ref().map(serde_json::to_string).transpose()?,expected_state,event.workflow_id,event.task_id,event.attempt as i64,event.owner_epoch as i64,event.lease_id,event.worker_id,event.plan_sha256,event.command_sha256,event.idempotency_key])?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition(
                "completion rejected by inbox state or fencing identity",
            ));
        }
        tx.execute("INSERT INTO worker_outbox(event_id,claim_id,event_json,event_sha256,state,attempts,available_at,created_at) VALUES(?1,?2,?3,?4,'PENDING',0,?5,?5)", params![event.event_id,event.claim_id,event_json,event_digest,event.created_at])?;
        tx.commit()?;
        Ok(())
    }

    /// Convert interrupted RUNNING claims to UNKNOWN after process restart. Never re-executes them.
    pub fn recover_interrupted(&self, worker_id: &str) -> Result<usize, WorkerStoreError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut statement = tx.prepare("SELECT claim_id,workflow_id,task_id,attempt,owner_epoch,lease_id,plan_sha256,command_sha256,idempotency_key FROM worker_inbox WHERE worker_id=?1 AND state='RUNNING'")?;
        let rows = statement
            .query_map([worker_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        for (
            claim_id,
            workflow_id,
            task_id,
            attempt,
            owner_epoch,
            lease_id,
            plan_sha256,
            command_sha256,
            idempotency_key,
        ) in &rows
        {
            let event = WorkerResultEvent { event_id: format!("recovery:{claim_id}"), schema_version: 1, producer: worker_id.into(), workflow_id: workflow_id.clone(), task_id: task_id.clone(), attempt: *attempt as u64, owner_epoch: *owner_epoch as u64, lease_id: lease_id.clone(), plan_sha256: plan_sha256.clone(), claim_id: claim_id.clone(), worker_id: worker_id.into(), command_sha256: command_sha256.clone(), idempotency_key: idempotency_key.clone(), outcome: WorkerOutcome::Unknown, evidence: None, diagnostic: Some("worker restarted while execution was RUNNING; external process outcome is unknown".into()), created_at: Utc::now().to_rfc3339() };
            let json = serde_json::to_string(&event)?;
            tx.execute("UPDATE worker_inbox SET state='UNKNOWN',finished_at=?2,last_error=?3 WHERE claim_id=?1 AND state='RUNNING'", params![claim_id,event.created_at,event.diagnostic])?;
            tx.execute("INSERT INTO worker_outbox(event_id,claim_id,event_json,event_sha256,state,attempts,available_at,created_at) VALUES(?1,?2,?3,?4,'PENDING',0,?5,?5)", params![event.event_id,claim_id,json,sha256(json.as_bytes()),event.created_at])?;
        }
        tx.commit()?;
        Ok(rows.len())
    }

    /// Claim one pending outbox event using an atomic lease. Delivery is at-least-once with stable event ID.
    pub fn lease_outbox(
        &self,
        dispatcher_id: &str,
        lease_seconds: u64,
    ) -> Result<Option<OutboxLease>, WorkerStoreError> {
        if dispatcher_id.trim().is_empty() || !(1..=300).contains(&lease_seconds) {
            return Err(WorkerStoreError::Transition(
                "outbox dispatcher or lease duration invalid",
            ));
        }
        let now = Utc::now();
        let until = now + chrono::Duration::seconds(lease_seconds as i64);
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(String,String,i64)> = tx.query_row("SELECT event_id,event_json,attempts FROM worker_outbox WHERE (state='PENDING' AND available_at<=?1) OR (state='IN_FLIGHT' AND lease_until<=?1) ORDER BY created_at,event_id LIMIT 1", [now.to_rfc3339()], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;
        let Some((event_id, json, attempts)) = row else {
            tx.commit()?;
            return Ok(None);
        };
        let token = Uuid::new_v4().to_string();
        let changed = tx.execute("UPDATE worker_outbox SET state='IN_FLIGHT',lease_owner=?2,lease_token=?3,lease_until=?4,attempts=attempts+1 WHERE event_id=?1 AND ((state='PENDING' AND available_at<=?5) OR (state='IN_FLIGHT' AND lease_until<=?5))", params![event_id,dispatcher_id,token,until.to_rfc3339(),now.to_rfc3339()])?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition(
                "outbox lease lost compare-and-set",
            ));
        }
        tx.commit()?;
        Ok(Some(OutboxLease {
            event_id,
            lease_token: token,
            event: serde_json::from_str(&json)?,
            attempts: attempts as u64 + 1,
        }))
    }

    /// Acknowledge event only for exact active dispatcher lease.
    pub fn ack_outbox(&self, lease: &OutboxLease) -> Result<(), WorkerStoreError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let changed = connection.execute("UPDATE worker_outbox SET state='ACKED',delivered_at=?3,lease_owner=NULL,lease_token=NULL,lease_until=NULL WHERE event_id=?1 AND state='IN_FLIGHT' AND lease_token=?2 AND lease_until>?3", params![lease.event_id,lease.lease_token,Utc::now().to_rfc3339()])?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition(
                "outbox acknowledgement is stale",
            ));
        }
        Ok(())
    }

    /// Release known pre-send failure for retry with same stable event ID.
    pub fn retry_outbox(
        &self,
        lease: &OutboxLease,
        delay_seconds: u64,
    ) -> Result<(), WorkerStoreError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let available = Utc::now() + chrono::Duration::seconds(delay_seconds.min(3600) as i64);
        let now = Utc::now().to_rfc3339();
        let changed = connection.execute("UPDATE worker_outbox SET state='PENDING',available_at=?3,lease_owner=NULL,lease_token=NULL,lease_until=NULL WHERE event_id=?1 AND state='IN_FLIGHT' AND lease_token=?2 AND lease_until>?4", params![lease.event_id,lease.lease_token,available.to_rfc3339(),now])?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition("outbox retry lease is stale"));
        }
        Ok(())
    }

    /// Quarantine a definitively rejected result without acknowledging delivery.
    pub fn reject_outbox(
        &self,
        lease: &OutboxLease,
        diagnostic: &str,
    ) -> Result<(), WorkerStoreError> {
        let diagnostic = bounded_diagnostic(diagnostic);
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let now = Utc::now().to_rfc3339();
        let changed = connection.execute("UPDATE worker_outbox SET state='REJECTED',rejection_reason=?3,lease_owner=NULL,lease_token=NULL,lease_until=NULL WHERE event_id=?1 AND state='IN_FLIGHT' AND lease_token=?2 AND lease_until>?4", params![lease.event_id,lease.lease_token,diagnostic,now])?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition(
                "outbox rejection lease is stale",
            ));
        }
        Ok(())
    }

    /// Persist immutable provider intent before any dispatch side effect.
    pub fn reserve_provider_intent(
        &self,
        intent: &ProviderIntentRecord,
        owner_epoch: u64,
    ) -> Result<bool, WorkerStoreError> {
        if owner_epoch == 0
            || owner_epoch > i64::MAX as u64
            || intent.state != ProviderDispatchState::Reserved
            || intent.provider_run_id.is_some()
            || intent.outcome.is_some()
            || intent.request.payload.as_ref().is_none_or(|payload| {
                !payload.is_object()
                    || content_hash(payload).ok().as_deref()
                        != Some(intent.request.request_sha256.as_str())
            })
            || intent.request.request_sha256.len() != 64
            || !intent
                .request
                .request_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(WorkerStoreError::Transition("provider owner epoch invalid"));
        }
        let json = serde_json::to_string(intent)?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(String,i64)> = tx.query_row(
            "SELECT intent_json,owner_epoch FROM worker_provider_intents WHERE intent_id=?1 OR (provider_id=?2 AND idempotency_key=?3)",
            params![intent.intent_id, intent.request.provider_id, intent.request.idempotency_key],
            |row| Ok((row.get(0)?,row.get(1)?)),
        ).optional()?;
        if let Some((existing, existing_epoch)) = existing {
            if existing != json || existing_epoch != owner_epoch as i64 {
                return Err(WorkerStoreError::ClaimConflict);
            }
            tx.commit()?;
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO worker_provider_intents(intent_id,provider_id,idempotency_key,intent_json,owner_epoch,request_sha256,state,provider_run_id,result_json,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,NULL,?9)",
            params![intent.intent_id,intent.request.provider_id,intent.request.idempotency_key,json,owner_epoch as i64,intent.request.request_sha256,format!("{:?}",intent.state).to_ascii_uppercase(),intent.provider_run_id,intent.updated_at],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Persist the exact Control reservation request before sending it.
    /// Exact retries are safe because the Control v1 contract returns the
    /// original durable reservation for the same idempotency key and body.
    pub fn persist_provider_execution_fence_request(
        &self,
        intent_id: &str,
        request: &crate::ExecutionFenceRequest,
    ) -> Result<(), WorkerStoreError> {
        if request.kind != crate::ExecutionFenceKind::ProviderDispatch
            || request.side_effect_id != intent_id
            || request.claim_id.trim().is_empty()
            || request.lease_id.trim().is_empty()
            || request.worker_id.trim().is_empty()
            || request.owner_epoch == 0
            || request.owner_epoch > i64::MAX as u64
            || request.idempotency_key.trim().is_empty()
            || !valid_lower_sha256(&request.plan_sha256)
            || !valid_lower_sha256(&request.request_sha256)
            || !valid_lower_sha256(&request.acl_sha256)
        {
            return Err(WorkerStoreError::Transition(
                "provider execution fence request identity is invalid",
            ));
        }

        let request_json = serde_json::to_string(request)?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(String, i64, Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT intent_json,owner_epoch,execution_fence_request_json,execution_fence_json FROM worker_provider_intents WHERE intent_id=?1",
                [intent_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let (intent_json, owner_epoch, existing_request, existing_fence) =
            row.ok_or(WorkerStoreError::Transition("provider intent missing"))?;
        let intent: ProviderIntentRecord = serde_json::from_str(&intent_json)?;
        let payload = intent
            .request
            .payload
            .clone()
            .ok_or(WorkerStoreError::Transition(
                "provider intent omitted its immutable payload",
            ))?;
        let dispatch = ProviderDispatchRequest {
            provider_id: intent.request.provider_id.clone(),
            idempotency_key: intent.request.idempotency_key.clone(),
            workflow_id: intent.request.workflow_id.clone(),
            task_id: intent.request.task_id.clone(),
            attempt: intent.request.attempt,
            lease_id: intent.request.lease_id.clone(),
            worker_id: intent.request.worker_id.clone(),
            plan_sha256: intent.request.plan_sha256.clone(),
            request_sha256: intent.request.request_sha256.clone(),
            payload,
        };
        let dispatch_digest = content_hash(&dispatch).ok();
        let claim_row: Option<ProviderFenceClaimDbRow> = tx.query_row(
                "SELECT claim_json,workflow_id,task_id,attempt,owner_epoch,lease_id,worker_id,plan_sha256,state FROM worker_inbox WHERE claim_id=?1",
                [&request.claim_id],
                |row| {
                    Ok((
                        row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?,
                        row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?,
                    ))
                },
            ).optional()?;
        let (
            claim_json,
            workflow_id,
            task_id,
            attempt,
            claim_epoch,
            lease_id,
            worker_id,
            plan_sha256,
            claim_state,
        ) = claim_row.ok_or(WorkerStoreError::Transition(
            "provider fence claim is missing",
        ))?;
        let claim: crate::TaskClaimEnvelope = serde_json::from_str(&claim_json)?;
        let acl_sha256 = claim
            .authenticator
            .get("acl_sha256")
            .and_then(Value::as_str);
        let idempotency_identity = serde_json::json!({
            "claim_id": request.claim_id,
            "lease_id": request.lease_id,
            "owner_epoch": request.owner_epoch,
            "kind": request.kind,
            "side_effect_id": request.side_effect_id
        });
        let expected_idempotency_key = format!(
            "worker-fence:{}",
            content_hash(&idempotency_identity).map_err(|_| WorkerStoreError::Transition(
                "provider fence idempotency digest failed"
            ))?
        );
        let claim_state_allows_request = claim_state == "RUNNING"
            || (claim_state == "UNKNOWN"
                // A crash can happen after this exact journal commits but
                // before the Control call starts or before its outcome is
                // recorded locally. In that case the immutable intent can
                // still be RESERVED when restart recovery quarantines inbox.
                && existing_request.as_deref() == Some(request_json.as_str())
                && matches!(
                    intent.state,
                    ProviderDispatchState::Reserved | ProviderDispatchState::Unknown
                ));
        if owner_epoch <= 0
            || owner_epoch as u64 != request.owner_epoch
            || claim_epoch as u64 != request.owner_epoch
            || workflow_id != intent.request.workflow_id
            || task_id != intent.request.task_id
            || attempt as u64 != intent.request.attempt
            || lease_id != request.lease_id
            || worker_id != request.worker_id
            || plan_sha256 != request.plan_sha256
            || claim.claim_id != request.claim_id
            || claim.lease_id != request.lease_id
            || claim.worker_id != request.worker_id
            || claim.owner_epoch != request.owner_epoch
            || claim.plan_sha256 != request.plan_sha256
            || claim.workflow_id != intent.request.workflow_id
            || claim.task_id != intent.request.task_id
            || claim.attempt != intent.request.attempt
            || intent.request.worker_id != request.worker_id
            || intent.request.lease_id != request.lease_id
            || intent.request.plan_sha256 != request.plan_sha256
            || !claim_state_allows_request
            || acl_sha256 != Some(request.acl_sha256.as_str())
            || dispatch_digest.as_deref() != Some(request.request_sha256.as_str())
            || request.idempotency_key != expected_idempotency_key
        {
            return Err(WorkerStoreError::Transition(
                "provider execution fence request does not match durable claim and intent",
            ));
        }
        if let Some(existing) = existing_fence {
            let fence: crate::ExecutionFence = serde_json::from_str(&existing)?;
            if fence.claim_id != request.claim_id
                || fence.lease_id != request.lease_id
                || fence.worker_id != request.worker_id
                || fence.owner_epoch != request.owner_epoch
                || fence.plan_sha256 != request.plan_sha256
                || fence.side_effect_id != request.side_effect_id
                || fence.kind != request.kind
                || fence.request_sha256 != request.request_sha256
                || fence.idempotency_key != request.idempotency_key
            {
                return Err(WorkerStoreError::ClaimConflict);
            }
        }
        if let Some(existing) = existing_request {
            if existing != request_json {
                return Err(WorkerStoreError::ClaimConflict);
            }
            tx.commit()?;
            return Ok(());
        }
        let changed = tx.execute(
            "UPDATE worker_provider_intents SET execution_fence_request_json=?2 WHERE intent_id=?1 AND execution_fence_request_json IS NULL",
            params![intent_id, request_json],
        )?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition(
                "provider execution fence request persistence lost compare-and-set",
            ));
        }
        tx.commit()?;
        Ok(())
    }

    /// Persist the exact Control fence before contacting the provider adapter.
    pub fn persist_provider_execution_fence(
        &self,
        intent_id: &str,
        fence: &crate::ExecutionFence,
    ) -> Result<(), WorkerStoreError> {
        if fence.kind != crate::ExecutionFenceKind::ProviderDispatch
            || fence.side_effect_id != intent_id
            || fence.fence_id.trim().is_empty()
            || fence.owner_epoch == 0
            || fence.owner_epoch > i64::MAX as u64
            || !valid_lower_sha256(&fence.plan_sha256)
            || !valid_lower_sha256(&fence.request_sha256)
            || fence.idempotency_key.trim().is_empty()
            || fence.state != crate::ExecutionFenceState::Reserved
            || !fence.receipt.is_object()
        {
            return Err(WorkerStoreError::Transition(
                "provider execution fence binding is invalid",
            ));
        }
        let fence_json = serde_json::to_string(fence)?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(String, i64, Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT intent_json,owner_epoch,execution_fence_json,execution_fence_request_json FROM worker_provider_intents WHERE intent_id=?1",
                [intent_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let (intent_json, owner_epoch, existing_fence, request_json) =
            row.ok_or(WorkerStoreError::Transition("provider intent missing"))?;
        let intent: ProviderIntentRecord = serde_json::from_str(&intent_json)?;
        let payload = intent
            .request
            .payload
            .clone()
            .ok_or(WorkerStoreError::Transition(
                "provider intent omitted its immutable payload",
            ))?;
        let dispatch = ProviderDispatchRequest {
            provider_id: intent.request.provider_id.clone(),
            idempotency_key: intent.request.idempotency_key.clone(),
            workflow_id: intent.request.workflow_id.clone(),
            task_id: intent.request.task_id.clone(),
            attempt: intent.request.attempt,
            lease_id: intent.request.lease_id.clone(),
            worker_id: intent.request.worker_id.clone(),
            plan_sha256: intent.request.plan_sha256.clone(),
            request_sha256: intent.request.request_sha256.clone(),
            payload,
        };
        let dispatch_digest = content_hash(&dispatch).ok();
        let inbox_state: Option<String> = tx.query_row(
            "SELECT state FROM worker_inbox WHERE claim_id=?1 AND worker_id=?2 AND workflow_id=?3 AND task_id=?4 AND attempt=?5 AND owner_epoch=?6 AND lease_id=?7",
            params![
                fence.claim_id,
                fence.worker_id,
                intent.request.workflow_id,
                intent.request.task_id,
                intent.request.attempt as i64,
                fence.owner_epoch as i64,
                fence.lease_id
            ],
            |row| row.get(0),
        ).optional()?;
        let claim_state_allows_fence_recovery = inbox_state.as_deref() == Some("RUNNING")
            || (inbox_state.as_deref() == Some("UNKNOWN")
                // Permit a fence recovered from the pre-call journal even
                // when the crash preceded the local UNKNOWN intent write.
                && request_json.is_some()
                && matches!(
                    intent.state,
                    ProviderDispatchState::Reserved | ProviderDispatchState::Unknown
                ));
        if owner_epoch <= 0
            || owner_epoch as u64 != fence.owner_epoch
            || intent.request.worker_id != fence.worker_id
            || intent.request.lease_id != fence.lease_id
            || intent.request.workflow_id.is_empty()
            || intent.request.attempt == 0
            || intent.request.attempt > i64::MAX as u64
            || intent.request.plan_sha256 != fence.plan_sha256
            || fence.claim_id.trim().is_empty()
            || !claim_state_allows_fence_recovery
            || dispatch_digest.as_deref() != Some(fence.request_sha256.as_str())
        {
            return Err(WorkerStoreError::Transition(
                "provider execution fence does not match durable intent",
            ));
        }
        if let Some(request_json) = request_json {
            let request: crate::ExecutionFenceRequest = serde_json::from_str(&request_json)?;
            if fence.claim_id != request.claim_id
                || fence.lease_id != request.lease_id
                || fence.worker_id != request.worker_id
                || fence.owner_epoch != request.owner_epoch
                || fence.plan_sha256 != request.plan_sha256
                || fence.side_effect_id != request.side_effect_id
                || fence.kind != request.kind
                || fence.request_sha256 != request.request_sha256
                || fence.idempotency_key != request.idempotency_key
            {
                return Err(WorkerStoreError::ClaimConflict);
            }
        }
        if let Some(existing) = existing_fence {
            if existing != fence_json {
                return Err(WorkerStoreError::ClaimConflict);
            }
            tx.commit()?;
            return Ok(());
        }
        let changed = tx.execute(
            "UPDATE worker_provider_intents SET execution_fence_json=?2 WHERE intent_id=?1 AND execution_fence_json IS NULL AND state IN ('RESERVED','UNKNOWN')",
            params![intent_id, fence_json],
        )?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition(
                "provider execution fence persistence lost compare-and-set",
            ));
        }
        tx.commit()?;
        Ok(())
    }

    /// Persist the one dispatch response against an exact RESERVED intent.
    pub fn record_provider_dispatch_outcome(
        &self,
        intent_id: &str,
        response: &ProviderDispatchResponse,
        updated_at: &str,
    ) -> Result<(), WorkerStoreError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(String, String)> = tx
            .query_row(
                "SELECT intent_json,state FROM worker_provider_intents WHERE intent_id=?1",
                [intent_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (json, state) = row.ok_or(WorkerStoreError::Transition("provider intent missing"))?;
        if state != "RESERVED" {
            return Err(WorkerStoreError::Transition(
                "provider dispatch response is not for a RESERVED intent",
            ));
        }
        let mut intent: ProviderIntentRecord = serde_json::from_str(&json)?;
        let (state, provider_run_id, outcome) = match response {
            ProviderDispatchResponse::Accepted { provider_run_id }
                if !provider_run_id.trim().is_empty() && provider_run_id.len() <= 256 =>
            {
                (
                    "ACCEPTED",
                    Some(provider_run_id.clone()),
                    ProviderIntentOutcome::Accepted {
                        provider_run_id: provider_run_id.clone(),
                    },
                )
            }
            ProviderDispatchResponse::Accepted { .. } => {
                return Err(WorkerStoreError::Transition(
                    "provider returned an invalid run identity",
                ));
            }
            ProviderDispatchResponse::Rejected {
                reason_code,
                diagnostic,
            } if !reason_code.trim().is_empty()
                && reason_code.len() <= 128
                && diagnostic.len() <= 4096 =>
            {
                (
                    "REJECTED",
                    None,
                    ProviderIntentOutcome::Rejected {
                        reason_code: reason_code.clone(),
                        diagnostic: diagnostic.clone(),
                    },
                )
            }
            ProviderDispatchResponse::Rejected { .. } => {
                return Err(WorkerStoreError::Transition(
                    "provider rejection omitted reason code",
                ));
            }
            ProviderDispatchResponse::Unknown { diagnostic } if diagnostic.len() <= 4096 => (
                "UNKNOWN",
                None,
                ProviderIntentOutcome::Unknown {
                    diagnostic: diagnostic.clone(),
                },
            ),
            ProviderDispatchResponse::Unknown { .. } => {
                return Err(WorkerStoreError::Transition(
                    "provider diagnostic exceeds limit",
                ));
            }
        };
        intent.state = match state {
            "ACCEPTED" => ProviderDispatchState::Accepted,
            "REJECTED" => ProviderDispatchState::Rejected,
            _ => ProviderDispatchState::Unknown,
        };
        intent.provider_run_id = provider_run_id.clone();
        intent.outcome = Some(outcome);
        intent.updated_at = updated_at.into();
        let intent_json = serde_json::to_string(&intent)?;
        let changed = tx.execute(
            "UPDATE worker_provider_intents SET state=?2,provider_run_id=?3,intent_json=?4,updated_at=?5 WHERE intent_id=?1 AND state='RESERVED'",
            params![intent_id,state,provider_run_id,intent_json,updated_at],
        )?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition(
                "provider dispatch outcome lost compare-and-set",
            ));
        }
        tx.commit()?;
        Ok(())
    }

    /// Read bounded provider intents for lookup only. This method never authorizes dispatch.
    pub fn list_provider_intents_for_reconciliation(
        &self,
        limit: u64,
    ) -> Result<Vec<FencedProviderIntent>, WorkerStoreError> {
        if !(1..=500).contains(&limit) {
            return Err(WorkerStoreError::Transition(
                "provider reconciliation limit is invalid",
            ));
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let mut statement = connection.prepare("SELECT intent_json,owner_epoch,execution_fence_json,execution_fence_request_json FROM worker_provider_intents WHERE (state IN ('RESERVED','ACCEPTED','UNKNOWN') OR (state='REJECTED' AND execution_fence_json IS NOT NULL AND result_json IS NULL)) AND owner_epoch>0 ORDER BY updated_at,intent_id LIMIT ?1")?;
        let rows = statement.query_map([limit], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;
        rows.map(|row| {
            let (json, epoch, fence_json, request_json) = row?;
            Ok(FencedProviderIntent {
                intent: serde_json::from_str(&json)?,
                owner_epoch: epoch as u64,
                execution_fence: fence_json
                    .as_deref()
                    .map(serde_json::from_str)
                    .transpose()?,
                execution_fence_request: request_json
                    .as_deref()
                    .map(serde_json::from_str)
                    .transpose()?,
            })
        })
        .collect()
    }

    /// Append a digest-checked provider lookup observation.
    pub fn append_provider_observation(
        &self,
        observation: &ProviderReconciliationObservation,
    ) -> Result<(), WorkerStoreError> {
        let json = serde_json::to_string(&observation.response)?;
        if sha256(json.as_bytes()) != observation.response_sha256 {
            return Err(WorkerStoreError::Transition(
                "provider observation digest mismatch",
            ));
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(String,String,String,String)> = tx.query_row(
            "SELECT intent_id,response_json,response_sha256,observed_at FROM worker_provider_observations WHERE observation_id=?1",
            [&observation.observation_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        ).optional()?;
        if let Some(existing) = existing {
            if existing
                != (
                    observation.intent_id.clone(),
                    json,
                    observation.response_sha256.clone(),
                    observation.observed_at.clone(),
                )
            {
                return Err(WorkerStoreError::ClaimConflict);
            }
            tx.commit()?;
            return Ok(());
        }
        tx.execute("INSERT INTO worker_provider_observations(observation_id,intent_id,response_json,response_sha256,observed_at) VALUES(?1,?2,?3,?4,?5)", params![observation.observation_id,observation.intent_id,json,observation.response_sha256,observation.observed_at])?;
        tx.commit()?;
        Ok(())
    }

    /// Bind an authoritative provider run to its immutable intent. Conflicting run IDs fail closed.
    pub fn bind_provider_run(
        &self,
        intent_id: &str,
        provider_run_id: &str,
        updated_at: &str,
    ) -> Result<(), WorkerStoreError> {
        if provider_run_id.trim().is_empty() || provider_run_id.len() > 256 {
            return Err(WorkerStoreError::Transition(
                "provider run identity invalid",
            ));
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: (String, Option<String>) = tx.query_row("SELECT intent_json,provider_run_id FROM worker_provider_intents WHERE intent_id=?1", [intent_id], |row| Ok((row.get(0)?,row.get(1)?))).optional()?.ok_or(WorkerStoreError::Transition("provider intent missing"))?;
        if current
            .1
            .as_deref()
            .is_some_and(|existing| existing != provider_run_id)
        {
            return Err(WorkerStoreError::Transition(
                "provider run identity conflicts with prior observation",
            ));
        }
        let mut intent: ProviderIntentRecord = serde_json::from_str(&current.0)?;
        intent.state = ProviderDispatchState::Accepted;
        intent.provider_run_id = Some(provider_run_id.into());
        intent.outcome = Some(ProviderIntentOutcome::Accepted {
            provider_run_id: provider_run_id.into(),
        });
        intent.updated_at = updated_at.into();
        let json = serde_json::to_string(&intent)?;
        let changed = tx.execute("UPDATE worker_provider_intents SET state='ACCEPTED',provider_run_id=?2,intent_json=?3,updated_at=?4 WHERE intent_id=?1 AND state IN ('RESERVED','ACCEPTED','UNKNOWN') AND (provider_run_id IS NULL OR provider_run_id=?2)", params![intent_id,provider_run_id,json,updated_at])?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition(
                "provider run binding conflicts with intent or is missing",
            ));
        }
        tx.commit()?;
        Ok(())
    }

    /// Persist authoritative provider rejection from exact lookup evidence.
    pub fn record_provider_rejection(
        &self,
        intent_id: &str,
        response: &Value,
        updated_at: &str,
    ) -> Result<(), WorkerStoreError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<(String, String, Option<String>)> = tx
            .query_row(
                "SELECT intent_json,state,result_json FROM worker_provider_intents WHERE intent_id=?1",
                [intent_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let (current, current_state, prior_terminal_receipt) =
            current.ok_or(WorkerStoreError::Transition("provider intent missing"))?;
        let mut intent: ProviderIntentRecord = serde_json::from_str(&current)?;
        if intent.provider_run_id.is_some() {
            return Err(WorkerStoreError::Transition(
                "provider rejection conflicts with an already observed run",
            ));
        }
        // Dispatch may already have recorded a rejection, but its execution
        // fence remains UNKNOWN until authoritative lookup resolves it. Keep
        // the original adapter evidence unchanged once the fence is released.
        if current_state == "REJECTED" {
            let terminal_receipt = serde_json::to_string(response)?;
            if let Some(existing) = prior_terminal_receipt {
                if existing != terminal_receipt {
                    return Err(WorkerStoreError::Transition(
                        "provider rejection reconciliation conflicts with prior receipt",
                    ));
                }
                tx.commit()?;
                return Ok(());
            }
            let changed = tx.execute(
                "UPDATE worker_provider_intents SET result_json=?2,updated_at=?3 WHERE intent_id=?1 AND state='REJECTED' AND result_json IS NULL",
                params![intent_id,terminal_receipt,updated_at],
            )?;
            if changed != 1 {
                return Err(WorkerStoreError::Transition(
                    "provider rejection completion receipt lost compare-and-set",
                ));
            }
            tx.commit()?;
            return Ok(());
        }
        intent.state = ProviderDispatchState::Rejected;
        intent.outcome = Some(ProviderIntentOutcome::Rejected {
            reason_code: "AUTHORITATIVE_LOOKUP_REJECTION".into(),
            diagnostic: response.to_string(),
        });
        intent.updated_at = updated_at.into();
        let json = serde_json::to_string(&intent)?;
        let terminal_receipt = serde_json::to_string(response)?;
        let changed = tx.execute("UPDATE worker_provider_intents SET state='REJECTED',intent_json=?2,result_json=?3,updated_at=?4 WHERE intent_id=?1 AND state IN ('RESERVED','UNKNOWN') AND provider_run_id IS NULL AND result_json IS NULL", params![intent_id,json,terminal_receipt,updated_at])?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition(
                "provider rejection conflicts with prior state",
            ));
        }
        tx.commit()?;
        Ok(())
    }

    /// Persist terminal provider result only against the exact previously bound run.
    pub fn finalize_provider_result(
        &self,
        intent_id: &str,
        provider_run_id: &str,
        state: &str,
        result: &Value,
        updated_at: &str,
    ) -> Result<(), WorkerStoreError> {
        if !matches!(state, "SUCCEEDED" | "FAILED") {
            return Err(WorkerStoreError::Transition(
                "provider result state must be terminal",
            ));
        }
        let json = serde_json::to_string(result)?;
        let outcome = if state == "SUCCEEDED" {
            WorkerOutcome::Succeeded
        } else {
            WorkerOutcome::Failed
        };
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(String,i64,Option<String>)> = tx.query_row("SELECT intent_json,owner_epoch,result_json FROM worker_provider_intents WHERE intent_id=?1 AND provider_run_id=?2",params![intent_id,provider_run_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;
        let (intent_json, owner_epoch, existing_result) = row.ok_or(
            WorkerStoreError::Transition("provider terminal result is stale or missing"),
        )?;
        if let Some(existing) = existing_result {
            if existing != json {
                return Err(WorkerStoreError::Transition(
                    "provider terminal result conflicts with finalized evidence",
                ));
            }
            tx.commit()?;
            return Ok(());
        }
        let intent: ProviderIntentRecord = serde_json::from_str(&intent_json)?;
        if owner_epoch <= 0
            || intent.request.workflow_id.is_empty()
            || intent.request.plan_sha256.len() != 64
        {
            return Err(WorkerStoreError::Transition(
                "provider result intent fence is invalid",
            ));
        }
        let event = ProviderResultEvent {
            event_id: format!("provider-result:{intent_id}:{provider_run_id}"),
            intent_id: intent_id.into(),
            provider_id: intent.request.provider_id.clone(),
            workflow_id: intent.request.workflow_id.clone(),
            task_id: intent.request.task_id.clone(),
            attempt: intent.request.attempt,
            owner_epoch: owner_epoch as u64,
            lease_id: intent.request.lease_id.clone(),
            worker_id: intent.request.worker_id.clone(),
            plan_sha256: intent.request.plan_sha256.clone(),
            provider_run_id: provider_run_id.into(),
            outcome,
            result: result.clone(),
            created_at: updated_at.into(),
        };
        let event_json = serde_json::to_string(&event)?;
        let changed = tx.execute("UPDATE worker_provider_intents SET state=?3,result_json=?4,updated_at=?5 WHERE intent_id=?1 AND provider_run_id=?2 AND state='ACCEPTED' AND result_json IS NULL", params![intent_id,provider_run_id,state,json,updated_at])?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition(
                "provider terminal result is stale, conflicting or already finalized",
            ));
        }
        tx.execute("INSERT INTO worker_provider_result_outbox(event_id,intent_id,event_json,event_sha256,state,attempts,available_at,created_at) VALUES(?1,?2,?3,?4,'PENDING',0,?5,?5)",params![event.event_id,intent_id,event_json,sha256(event_json.as_bytes()),updated_at])?;
        tx.commit()?;
        Ok(())
    }

    /// Lease one provider result event for fenced Control publication.
    pub fn lease_provider_result(
        &self,
        dispatcher_id: &str,
        lease_seconds: u64,
    ) -> Result<Option<ProviderResultLease>, WorkerStoreError> {
        if dispatcher_id.trim().is_empty() || !(1..=300).contains(&lease_seconds) {
            return Err(WorkerStoreError::Transition(
                "provider result dispatcher lease invalid",
            ));
        }
        let now = Utc::now();
        let until = now + chrono::Duration::seconds(lease_seconds as i64);
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row:Option<(String,String,i64)>=tx.query_row("SELECT event_id,event_json,attempts FROM worker_provider_result_outbox WHERE (state='PENDING' AND available_at<=?1) OR (state='IN_FLIGHT' AND lease_until<=?1) ORDER BY created_at,event_id LIMIT 1",[now.to_rfc3339()],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;
        let Some((event_id, json, attempts)) = row else {
            tx.commit()?;
            return Ok(None);
        };
        let token = Uuid::new_v4().to_string();
        let changed=tx.execute("UPDATE worker_provider_result_outbox SET state='IN_FLIGHT',lease_owner=?2,lease_token=?3,lease_until=?4,attempts=attempts+1 WHERE event_id=?1 AND ((state='PENDING' AND available_at<=?5) OR (state='IN_FLIGHT' AND lease_until<=?5))",params![event_id,dispatcher_id,token,until.to_rfc3339(),now.to_rfc3339()])?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition(
                "provider result outbox lease lost compare-and-set",
            ));
        }
        tx.commit()?;
        Ok(Some(ProviderResultLease {
            event: serde_json::from_str(&json)?,
            lease_token: token,
            attempts: attempts as u64 + 1,
        }))
    }

    /// Acknowledge provider result only for exact active local lease.
    pub fn ack_provider_result(&self, lease: &ProviderResultLease) -> Result<(), WorkerStoreError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let now = Utc::now().to_rfc3339();
        let changed=connection.execute("UPDATE worker_provider_result_outbox SET state='ACKED',delivered_at=?3,lease_owner=NULL,lease_token=NULL,lease_until=NULL WHERE event_id=?1 AND state='IN_FLIGHT' AND lease_token=?2 AND lease_until>?3",params![lease.event.event_id,lease.lease_token,now])?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition(
                "provider result acknowledgement is stale",
            ));
        }
        Ok(())
    }

    /// Retry same provider result event ID after an idempotent Control API failure.
    pub fn retry_provider_result(
        &self,
        lease: &ProviderResultLease,
        delay_seconds: u64,
    ) -> Result<(), WorkerStoreError> {
        let available = Utc::now() + chrono::Duration::seconds(delay_seconds.min(3600) as i64);
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let now = Utc::now().to_rfc3339();
        let changed=connection.execute("UPDATE worker_provider_result_outbox SET state='PENDING',available_at=?3,lease_owner=NULL,lease_token=NULL,lease_until=NULL WHERE event_id=?1 AND state='IN_FLIGHT' AND lease_token=?2 AND lease_until>?4",params![lease.event.event_id,lease.lease_token,available.to_rfc3339(),now])?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition(
                "provider result retry lease is stale",
            ));
        }
        Ok(())
    }

    /// Quarantine a definitively rejected provider result without acknowledging delivery.
    pub fn reject_provider_result(
        &self,
        lease: &ProviderResultLease,
        diagnostic: &str,
    ) -> Result<(), WorkerStoreError> {
        let diagnostic = bounded_diagnostic(diagnostic);
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let now = Utc::now().to_rfc3339();
        let changed = connection.execute("UPDATE worker_provider_result_outbox SET state='REJECTED',rejection_reason=?3,lease_owner=NULL,lease_token=NULL,lease_until=NULL WHERE event_id=?1 AND state='IN_FLIGHT' AND lease_token=?2 AND lease_until>?4", params![lease.event.event_id,lease.lease_token,diagnostic,now])?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition(
                "provider result rejection lease is stale",
            ));
        }
        Ok(())
    }

    /// Read terminal provider state and collected result metadata.
    pub fn provider_result(
        &self,
        intent_id: &str,
    ) -> Result<Option<(String, Option<Value>)>, WorkerStoreError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        connection
            .query_row(
                "SELECT state,result_json FROM worker_provider_intents WHERE intent_id=?1",
                [intent_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?
            .map(|(state, result)| {
                Ok((
                    state,
                    result.map(|json| serde_json::from_str(&json)).transpose()?,
                ))
            })
            .transpose()
    }

    /// Enqueue one immutable owner-epoch-bound session message.
    pub fn enqueue_session_delivery(
        &self,
        message: &SessionDeliveryEnvelope,
    ) -> Result<bool, WorkerStoreError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let inserted = enqueue_session_delivery_tx(&tx, message)?;
        tx.commit()?;
        Ok(inserted)
    }

    /// Lease one session message. Expired pre-send leases can be reclaimed; started leases become UNCERTAIN.
    pub fn lease_session_delivery(
        &self,
        dispatcher_id: &str,
        lease_seconds: u64,
    ) -> Result<Option<SessionDeliveryLease>, WorkerStoreError> {
        if dispatcher_id.trim().is_empty() || !(1..=300).contains(&lease_seconds) {
            return Err(WorkerStoreError::Transition(
                "session dispatcher lease invalid",
            ));
        }
        let now = Utc::now();
        let until = now + chrono::Duration::seconds(lease_seconds as i64);
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("UPDATE worker_session_outbox SET state='UNCERTAIN',lease_owner=NULL,lease_token=NULL,lease_until=NULL WHERE state='IN_FLIGHT' AND lease_until<=?1 AND transport_started_at IS NOT NULL",[now.to_rfc3339()])?;
        tx.execute("UPDATE worker_session_outbox SET state='PENDING',lease_owner=NULL,lease_token=NULL,lease_until=NULL WHERE state='IN_FLIGHT' AND lease_until<=?1 AND transport_started_at IS NULL",[now.to_rfc3339()])?;
        let row:Option<(String,String)>=tx.query_row("SELECT message_id,message_json FROM worker_session_outbox WHERE state='PENDING' AND owner_epoch>0 AND available_at<=?1 ORDER BY available_at,message_id LIMIT 1",[now.to_rfc3339()],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
        let Some((message_id, json)) = row else {
            tx.commit()?;
            return Ok(None);
        };
        let token = Uuid::new_v4().to_string();
        let changed=tx.execute("UPDATE worker_session_outbox SET state='IN_FLIGHT',lease_owner=?2,lease_token=?3,lease_until=?4,attempts=attempts+1 WHERE message_id=?1 AND state='PENDING'",params![message_id,dispatcher_id,token,until.to_rfc3339()])?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition(
                "session message lease lost compare-and-set",
            ));
        }
        tx.commit()?;
        Ok(Some(SessionDeliveryLease {
            message: serde_json::from_str(&json)?,
            lease_token: token,
        }))
    }

    /// Persist pre-transport marker. A crash after this point is conservatively UNCERTAIN.
    pub fn mark_session_delivery_started(
        &self,
        lease: &SessionDeliveryLease,
    ) -> Result<(), WorkerStoreError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let changed=connection.execute("UPDATE worker_session_outbox SET transport_started_at=?3 WHERE message_id=?1 AND state='IN_FLIGHT' AND lease_token=?2 AND lease_until>?3 AND transport_started_at IS NULL",params![lease.message.message_id,lease.lease_token,Utc::now().to_rfc3339()])?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition(
                "session delivery start lease is stale",
            ));
        }
        Ok(())
    }

    /// Acknowledge a Control-confirmed delivery receipt under exact local lease.
    pub fn ack_session_delivery(
        &self,
        lease: &SessionDeliveryLease,
        receipt: &Value,
    ) -> Result<(), WorkerStoreError> {
        let json = serde_json::to_string(receipt)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let changed=connection.execute("UPDATE worker_session_outbox SET state='ACKED',receipt_json=?3,lease_owner=NULL,lease_token=NULL,lease_until=NULL WHERE message_id=?1 AND state='IN_FLIGHT' AND lease_token=?2 AND lease_until>?4 AND transport_started_at IS NOT NULL",params![lease.message.message_id,lease.lease_token,json,Utc::now().to_rfc3339()])?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition(
                "session delivery acknowledgement is stale",
            ));
        }
        Ok(())
    }

    /// Mark ambiguous external delivery UNCERTAIN; it is never automatically retried.
    pub fn mark_session_delivery_uncertain(
        &self,
        lease: &SessionDeliveryLease,
    ) -> Result<(), WorkerStoreError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let now = Utc::now().to_rfc3339();
        let changed=connection.execute("UPDATE worker_session_outbox SET state='UNCERTAIN',lease_owner=NULL,lease_token=NULL,lease_until=NULL WHERE message_id=?1 AND state='IN_FLIGHT' AND lease_token=?2 AND lease_until>?3",params![lease.message.message_id,lease.lease_token,now])?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition(
                "session uncertainty update is stale",
            ));
        }
        Ok(())
    }

    /// Record authoritative Control rejection due to stale ownership or revoked ACL.
    pub fn reject_session_delivery(
        &self,
        lease: &SessionDeliveryLease,
    ) -> Result<(), WorkerStoreError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let now = Utc::now().to_rfc3339();
        let changed=connection.execute("UPDATE worker_session_outbox SET state='REJECTED',lease_owner=NULL,lease_token=NULL,lease_until=NULL WHERE message_id=?1 AND state='IN_FLIGHT' AND lease_token=?2 AND lease_until>?3",params![lease.message.message_id,lease.lease_token,now])?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition(
                "session rejection lease is stale",
            ));
        }
        Ok(())
    }

    /// Read session delivery state for health and recovery projections.
    pub fn session_delivery_state(
        &self,
        message_id: &str,
    ) -> Result<Option<String>, WorkerStoreError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        connection
            .query_row(
                "SELECT state FROM worker_session_outbox WHERE message_id=?1",
                [message_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    /// Release a transport-proven pre-send failure for retry.
    pub fn retry_session_delivery(
        &self,
        lease: &SessionDeliveryLease,
        delay_seconds: u64,
    ) -> Result<(), WorkerStoreError> {
        let available = Utc::now() + chrono::Duration::seconds(delay_seconds.min(3600) as i64);
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let now = Utc::now().to_rfc3339();
        let changed=connection.execute("UPDATE worker_session_outbox SET state='PENDING',transport_started_at=NULL,available_at=?3,lease_owner=NULL,lease_token=NULL,lease_until=NULL WHERE message_id=?1 AND state='IN_FLIGHT' AND lease_token=?2 AND lease_until>?4",params![lease.message.message_id,lease.lease_token,available.to_rfc3339(),now])?;
        if changed != 1 {
            return Err(WorkerStoreError::Transition("session retry lease is stale"));
        }
        Ok(())
    }

    /// Read durable state for diagnostics and health endpoints.
    pub fn counts(&self) -> Result<Value, WorkerStoreError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| WorkerStoreError::Poisoned)?;
        let mut output = serde_json::Map::new();
        for (table, key) in [
            ("worker_inbox", "inbox"),
            ("worker_outbox", "outbox"),
            ("worker_provider_intents", "provider_intents"),
            ("worker_session_outbox", "session_outbox"),
            ("worker_provider_result_outbox", "provider_result_outbox"),
        ] {
            let count: i64 =
                connection.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })?;
            output.insert(key.into(), Value::from(count));
        }
        for (table, key) in [
            ("worker_outbox", "outbox_rejected"),
            (
                "worker_provider_result_outbox",
                "provider_result_outbox_rejected",
            ),
        ] {
            let count: i64 = connection.query_row(
                &format!("SELECT count(*) FROM {table} WHERE state='REJECTED'"),
                [],
                |row| row.get(0),
            )?;
            output.insert(key.into(), Value::from(count));
        }
        Ok(Value::Object(output))
    }
}

fn reject_path_components(path: &Path) -> Result<(), WorkerStoreError> {
    for component in path.ancestors() {
        match fs::symlink_metadata(component) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(WorkerStoreError::UnsafePath(
                    component.display().to_string(),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool, WorkerStoreError> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |row| row.get(0),
    )?)
}

fn enqueue_session_delivery_tx(
    tx: &Transaction<'_>,
    message: &SessionDeliveryEnvelope,
) -> Result<bool, WorkerStoreError> {
    let identity = [
        (&message.message_id, 256),
        (&message.idempotency_key, 256),
        (&message.workflow_id, 256),
        (&message.task_id, 256),
        (&message.lease_id, 256),
        (&message.worker_id, 256),
        (&message.session_id, 256),
        (&message.recipient_role, 128),
        (&message.message_type, 128),
    ];
    let expires_at = chrono::DateTime::parse_from_rfc3339(&message.expires_at)
        .map(|expiry| expiry.with_timezone(&Utc));
    if identity
        .iter()
        .any(|(value, limit)| value.trim().is_empty() || value.len() > *limit)
        || message.owner_epoch == 0
        || message.owner_epoch > i64::MAX as u64
        || message.attempt == 0
        || message.attempt > i64::MAX as u64
        || !message.payload.is_object()
        || serde_json::to_vec(&message.payload).map_or(true, |bytes| bytes.len() > 65_536)
        || expires_at.map_or(true, |expiry| {
            expiry <= Utc::now() || expiry > Utc::now() + chrono::Duration::hours(24)
        })
    {
        return Err(WorkerStoreError::Transition(
            "session message identity, fence, expiry or payload invalid",
        ));
    }
    let json = serde_json::to_string(message)?;
    let existing: Option<String> = tx.query_row(
        "SELECT message_json FROM worker_session_outbox WHERE message_id=?1 OR (session_id=?2 AND idempotency_key=?3)",
        params![message.message_id,message.session_id,message.idempotency_key],
        |row| row.get(0),
    ).optional()?;
    if let Some(existing) = existing {
        if existing != json {
            return Err(WorkerStoreError::ClaimConflict);
        }
        return Ok(false);
    }
    tx.execute(
        "INSERT INTO worker_session_outbox(message_id,idempotency_key,session_id,workflow_id,task_id,attempt,owner_epoch,lease_id,worker_id,message_json,state,attempts,available_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'PENDING',0,?11)",
        params![message.message_id,message.idempotency_key,message.session_id,message.workflow_id,message.task_id,message.attempt as i64,message.owner_epoch as i64,message.lease_id,message.worker_id,json,Utc::now().to_rfc3339()],
    )?;
    Ok(true)
}

fn column_exists(
    connection: &Connection,
    table: &str,
    column: &str,
) -> Result<bool, WorkerStoreError> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    for existing in statement.query_map([], |row| row.get::<_, String>(1))? {
        if existing? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn process_start_ticks(pid: u32) -> Result<Option<u64>, WorkerStoreError> {
    #[cfg(target_os = "linux")]
    {
        let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(stat) => stat,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let (_, fields) = stat.rsplit_once(')').ok_or(WorkerStoreError::Transition(
            "process stat identity is malformed",
        ))?;
        return fields
            .split_whitespace()
            .nth(19)
            .ok_or(WorkerStoreError::Transition(
                "process stat omitted start time",
            ))?
            .parse::<u64>()
            .map(Some)
            .map_err(|_| WorkerStoreError::Transition("process start time is malformed"));
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        Ok(None)
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn current_process_uid() -> Result<u32, WorkerStoreError> {
    let status = fs::read_to_string("/proc/self/status")?;
    let uid = status
        .lines()
        .find_map(|line| line.strip_prefix("Uid:"))
        .and_then(|line| line.split_whitespace().next());
    uid.ok_or(WorkerStoreError::Transition("process uid is unavailable"))?
        .parse()
        .map_err(|_| WorkerStoreError::Transition("process uid is malformed"))
}

#[cfg(not(target_os = "linux"))]
fn current_process_uid() -> Result<u32, WorkerStoreError> {
    Err(WorkerStoreError::Transition(
        "worker private directory checks require Linux",
    ))
}

fn initialize_schema(connection: &mut Connection) -> Result<(), WorkerStoreError> {
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let version: i64 = tx.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > SCHEMA_VERSION {
        return Err(WorkerStoreError::Schema(version));
    }
    match version {
        0 => tx.execute_batch(SCHEMA)?,
        1 => {
            migrate_v1_to_v2(&tx)?;
            migrate_v2_to_v3(&tx)?;
            migrate_v3_to_v4(&tx)?;
            migrate_v4_to_v5(&tx)?;
            migrate_v5_to_v6(&tx)?;
            migrate_v6_to_v7(&tx)?;
        }
        2 => {
            migrate_v2_to_v3(&tx)?;
            migrate_v3_to_v4(&tx)?;
            migrate_v4_to_v5(&tx)?;
            migrate_v5_to_v6(&tx)?;
            migrate_v6_to_v7(&tx)?;
        }
        3 => {
            migrate_v3_to_v4(&tx)?;
            migrate_v4_to_v5(&tx)?;
            migrate_v5_to_v6(&tx)?;
            migrate_v6_to_v7(&tx)?;
        }
        4 => {
            migrate_v4_to_v5(&tx)?;
            migrate_v5_to_v6(&tx)?;
            migrate_v6_to_v7(&tx)?;
        }
        5 => {
            migrate_v5_to_v6(&tx)?;
            migrate_v6_to_v7(&tx)?;
        }
        6 => migrate_v6_to_v7(&tx)?,
        SCHEMA_VERSION => {}
        _ => return Err(WorkerStoreError::Schema(version)),
    }
    tx.commit()?;
    Ok(())
}

fn migrate_v1_to_v2(tx: &Transaction<'_>) -> Result<(), WorkerStoreError> {
    let has_owner_epoch:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('worker_provider_intents') WHERE name='owner_epoch')",[],|row|row.get(0))?;
    if !has_owner_epoch {
        tx.execute_batch("ALTER TABLE worker_provider_intents ADD COLUMN owner_epoch INTEGER NOT NULL DEFAULT 0 CHECK(owner_epoch>=0);")?;
    }
    if table_exists(tx, "worker_session_outbox")? {
        let owner_epoch = if column_exists(tx, "worker_session_outbox", "owner_epoch")? {
            "owner_epoch"
        } else {
            "0"
        };
        let lease_owner = if column_exists(tx, "worker_session_outbox", "lease_owner")? {
            "lease_owner"
        } else {
            "NULL"
        };
        let lease_token = if column_exists(tx, "worker_session_outbox", "lease_token")? {
            "lease_token"
        } else {
            "NULL"
        };
        let lease_until = if column_exists(tx, "worker_session_outbox", "lease_until")? {
            "lease_until"
        } else {
            "NULL"
        };
        let transport_started_at =
            if column_exists(tx, "worker_session_outbox", "transport_started_at")? {
                "transport_started_at"
            } else {
                "NULL"
            };
        let receipt_json = if column_exists(tx, "worker_session_outbox", "receipt_json")? {
            "receipt_json"
        } else {
            "NULL"
        };
        let ambiguous_inflight = format!(
            "state='IN_FLIGHT' AND ({lease_owner} IS NULL OR {lease_token} IS NULL OR {lease_until} IS NULL OR {transport_started_at} IS NULL)"
        );
        let state_expr = format!("CASE WHEN {ambiguous_inflight} THEN 'UNCERTAIN' ELSE state END");
        let lease_owner_expr =
            format!("CASE WHEN {ambiguous_inflight} THEN NULL ELSE {lease_owner} END");
        let lease_token_expr =
            format!("CASE WHEN {ambiguous_inflight} THEN NULL ELSE {lease_token} END");
        let lease_until_expr =
            format!("CASE WHEN {ambiguous_inflight} THEN NULL ELSE {lease_until} END");
        tx.execute_batch("ALTER TABLE worker_session_outbox RENAME TO worker_session_outbox_v1;
            CREATE TABLE worker_session_outbox(
             message_id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL,session_id TEXT NOT NULL,
             workflow_id TEXT NOT NULL,task_id TEXT NOT NULL,attempt INTEGER NOT NULL CHECK(attempt>0),
             owner_epoch INTEGER NOT NULL CHECK(owner_epoch>=0),lease_id TEXT NOT NULL,worker_id TEXT NOT NULL,
             message_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('PENDING','IN_FLIGHT','ACKED','UNCERTAIN','REJECTED')),
             attempts INTEGER NOT NULL CHECK(attempts>=0),available_at TEXT NOT NULL,
             lease_owner TEXT,lease_token TEXT,lease_until TEXT,transport_started_at TEXT,receipt_json TEXT,
             UNIQUE(session_id,idempotency_key),
             CHECK((state='IN_FLIGHT' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR state!='IN_FLIGHT'));")?;
        let copy = format!(
            "INSERT INTO worker_session_outbox(message_id,idempotency_key,session_id,workflow_id,task_id,attempt,owner_epoch,lease_id,worker_id,message_json,state,attempts,available_at,lease_owner,lease_token,lease_until,transport_started_at,receipt_json) SELECT message_id,idempotency_key,session_id,workflow_id,task_id,attempt,{owner_epoch},lease_id,worker_id,message_json,{state_expr},attempts,available_at,{lease_owner_expr},{lease_token_expr},{lease_until_expr},{transport_started_at},{receipt_json} FROM worker_session_outbox_v1"
        );
        tx.execute_batch(&copy)?;
        tx.execute_batch("DROP TABLE worker_session_outbox_v1;
            CREATE INDEX IF NOT EXISTS worker_session_pending ON worker_session_outbox(state,available_at,message_id);")?;
    } else {
        tx.execute_batch("CREATE TABLE worker_session_outbox(
             message_id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL,session_id TEXT NOT NULL,
             workflow_id TEXT NOT NULL,task_id TEXT NOT NULL,attempt INTEGER NOT NULL CHECK(attempt>0),
             owner_epoch INTEGER NOT NULL CHECK(owner_epoch>=0),lease_id TEXT NOT NULL,worker_id TEXT NOT NULL,
             message_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('PENDING','IN_FLIGHT','ACKED','UNCERTAIN','REJECTED')),
             attempts INTEGER NOT NULL CHECK(attempts>=0),available_at TEXT NOT NULL,
             lease_owner TEXT,lease_token TEXT,lease_until TEXT,transport_started_at TEXT,receipt_json TEXT,
             UNIQUE(session_id,idempotency_key),
             CHECK((state='IN_FLIGHT' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR state!='IN_FLIGHT'));
            CREATE INDEX IF NOT EXISTS worker_session_pending ON worker_session_outbox(state,available_at,message_id);")?;
    }
    tx.execute_batch("CREATE TABLE IF NOT EXISTS worker_provider_observations(
         observation_id TEXT PRIMARY KEY,intent_id TEXT NOT NULL REFERENCES worker_provider_intents(intent_id),
         response_json TEXT NOT NULL,response_sha256 TEXT NOT NULL CHECK(length(response_sha256)=64),observed_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS worker_provider_result_outbox(
         event_id TEXT PRIMARY KEY,intent_id TEXT NOT NULL REFERENCES worker_provider_intents(intent_id),
         event_json TEXT NOT NULL,event_sha256 TEXT NOT NULL CHECK(length(event_sha256)=64),
         state TEXT NOT NULL CHECK(state IN ('PENDING','IN_FLIGHT','ACKED')),attempts INTEGER NOT NULL CHECK(attempts>=0),
         available_at TEXT NOT NULL,lease_owner TEXT,lease_token TEXT,lease_until TEXT,created_at TEXT NOT NULL,delivered_at TEXT,
         CHECK((state='IN_FLIGHT' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR state!='IN_FLIGHT'));
        CREATE INDEX IF NOT EXISTS worker_provider_result_pending ON worker_provider_result_outbox(state,available_at,created_at);
        CREATE TRIGGER IF NOT EXISTS worker_provider_observation_no_update BEFORE UPDATE ON worker_provider_observations BEGIN SELECT RAISE(ABORT,'provider observations are append-only'); END;
        CREATE TRIGGER IF NOT EXISTS worker_provider_observation_no_delete BEFORE DELETE ON worker_provider_observations BEGIN SELECT RAISE(ABORT,'provider observations are append-only'); END;
        PRAGMA user_version=2;")?;
    Ok(())
}

fn migrate_v2_to_v3(tx: &Transaction<'_>) -> Result<(), WorkerStoreError> {
    tx.execute_batch("CREATE TABLE IF NOT EXISTS worker_runtime_lock(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL CHECK(pid>0),
        process_start_ticks INTEGER NOT NULL CHECK(process_start_ticks>=0), lock_token TEXT NOT NULL,
        acquired_at TEXT NOT NULL
    ); PRAGMA user_version=3;")?;
    Ok(())
}

fn migrate_v3_to_v4(tx: &Transaction<'_>) -> Result<(), WorkerStoreError> {
    tx.execute_batch("ALTER TABLE worker_outbox RENAME TO worker_outbox_v3;
        CREATE TABLE worker_outbox(
         event_id TEXT PRIMARY KEY, claim_id TEXT NOT NULL UNIQUE REFERENCES worker_inbox(claim_id),
         event_json TEXT NOT NULL, event_sha256 TEXT NOT NULL CHECK(length(event_sha256)=64),
         state TEXT NOT NULL CHECK(state IN ('PENDING','IN_FLIGHT','ACKED','REJECTED')),
         attempts INTEGER NOT NULL CHECK(attempts>=0), available_at TEXT NOT NULL,
         lease_owner TEXT, lease_token TEXT, lease_until TEXT, created_at TEXT NOT NULL, delivered_at TEXT,
         rejection_reason TEXT,
         CHECK((state='IN_FLIGHT' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR state!='IN_FLIGHT'));
        INSERT INTO worker_outbox(event_id,claim_id,event_json,event_sha256,state,attempts,available_at,lease_owner,lease_token,lease_until,created_at,delivered_at)
         SELECT event_id,claim_id,event_json,event_sha256,state,attempts,available_at,lease_owner,lease_token,lease_until,created_at,delivered_at FROM worker_outbox_v3;
        DROP TABLE worker_outbox_v3;
        CREATE INDEX worker_outbox_pending ON worker_outbox(state,available_at,created_at);

        ALTER TABLE worker_provider_result_outbox RENAME TO worker_provider_result_outbox_v3;
        CREATE TABLE worker_provider_result_outbox(
         event_id TEXT PRIMARY KEY,intent_id TEXT NOT NULL REFERENCES worker_provider_intents(intent_id),
         event_json TEXT NOT NULL,event_sha256 TEXT NOT NULL CHECK(length(event_sha256)=64),
         state TEXT NOT NULL CHECK(state IN ('PENDING','IN_FLIGHT','ACKED','REJECTED')),attempts INTEGER NOT NULL CHECK(attempts>=0),
         available_at TEXT NOT NULL,lease_owner TEXT,lease_token TEXT,lease_until TEXT,created_at TEXT NOT NULL,delivered_at TEXT,
         rejection_reason TEXT,
         CHECK((state='IN_FLIGHT' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR state!='IN_FLIGHT'));
        INSERT INTO worker_provider_result_outbox(event_id,intent_id,event_json,event_sha256,state,attempts,available_at,lease_owner,lease_token,lease_until,created_at,delivered_at)
         SELECT event_id,intent_id,event_json,event_sha256,state,attempts,available_at,lease_owner,lease_token,lease_until,created_at,delivered_at FROM worker_provider_result_outbox_v3;
        DROP TABLE worker_provider_result_outbox_v3;
        CREATE INDEX worker_provider_result_pending ON worker_provider_result_outbox(state,available_at,created_at);
        PRAGMA user_version=4;")?;
    Ok(())
}

fn migrate_v4_to_v5(tx: &Transaction<'_>) -> Result<(), WorkerStoreError> {
    if !column_exists(tx, "worker_provider_intents", "execution_fence_json")? {
        tx.execute_batch(
            "ALTER TABLE worker_provider_intents ADD COLUMN execution_fence_json TEXT;",
        )?;
    }
    tx.execute_batch("PRAGMA user_version=5;")?;
    Ok(())
}

fn migrate_v5_to_v6(tx: &Transaction<'_>) -> Result<(), WorkerStoreError> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS worker_execution_workspaces(
            claim_id TEXT PRIMARY KEY REFERENCES worker_inbox(claim_id),
            workflow_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            attempt INTEGER NOT NULL CHECK(attempt>0),
            owner_epoch INTEGER NOT NULL CHECK(owner_epoch>0),
            lease_id TEXT NOT NULL,
            worker_id TEXT NOT NULL,
            project_id INTEGER NOT NULL UNIQUE CHECK(project_id>=10000),
            workspace_path TEXT NOT NULL UNIQUE,
            device INTEGER,
            inode INTEGER,
            byte_limit INTEGER NOT NULL CHECK(byte_limit>0),
            inode_limit INTEGER NOT NULL CHECK(inode_limit>0),
            state TEXT NOT NULL CHECK(state IN ('ALLOCATING','ACTIVE','RELEASED','QUARANTINED')),
            diagnostic TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(workflow_id,task_id,attempt),
            CHECK((state='ALLOCATING' AND device IS NULL AND inode IS NULL)
               OR (state IN ('ACTIVE','RELEASED','QUARANTINED') AND device IS NOT NULL AND inode IS NOT NULL)
               OR state='QUARANTINED')
        );
        CREATE INDEX IF NOT EXISTS worker_execution_workspaces_state ON worker_execution_workspaces(state,project_id);
        CREATE TRIGGER IF NOT EXISTS worker_execution_workspace_identity_immutable
        BEFORE UPDATE OF claim_id,workflow_id,task_id,attempt,owner_epoch,lease_id,worker_id,project_id,workspace_path,byte_limit,inode_limit,created_at
        ON worker_execution_workspaces
        BEGIN SELECT RAISE(ABORT,'execution workspace identity is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS worker_execution_workspace_no_delete
        BEFORE DELETE ON worker_execution_workspaces
        BEGIN SELECT RAISE(ABORT,'execution workspace ledger is append-only'); END;
        PRAGMA user_version=6;",
    )?;
    Ok(())
}

fn migrate_v6_to_v7(tx: &Transaction<'_>) -> Result<(), WorkerStoreError> {
    if !column_exists(
        tx,
        "worker_provider_intents",
        "execution_fence_request_json",
    )? {
        tx.execute_batch(
            "ALTER TABLE worker_provider_intents ADD COLUMN execution_fence_request_json TEXT;",
        )?;
    }
    tx.execute_batch("PRAGMA user_version=7;")?;
    Ok(())
}

fn bounded_diagnostic(diagnostic: &str) -> String {
    diagnostic.chars().take(1024).collect()
}

fn valid_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

const SCHEMA: &str = r#"
CREATE TABLE worker_inbox(
 claim_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
 workflow_id TEXT NOT NULL, task_id TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt>0),
 owner_epoch INTEGER NOT NULL CHECK(owner_epoch>0), lease_id TEXT NOT NULL, worker_id TEXT NOT NULL,
 plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256)=64), command_sha256 TEXT NOT NULL CHECK(length(command_sha256)=64),
 claim_json TEXT NOT NULL, claim_sha256 TEXT NOT NULL CHECK(length(claim_sha256)=64),
 state TEXT NOT NULL CHECK(state IN ('RECEIVED','RUNNING','SUCCEEDED','FAILED','UNKNOWN','NOT_STARTED')),
 accepted_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, lease_expires_at TEXT NOT NULL,
 evidence_json TEXT, last_error TEXT, UNIQUE(workflow_id,task_id,attempt)
);
CREATE INDEX worker_inbox_recovery ON worker_inbox(worker_id,state,accepted_at);
CREATE TABLE worker_outbox(
 event_id TEXT PRIMARY KEY, claim_id TEXT NOT NULL UNIQUE REFERENCES worker_inbox(claim_id),
 event_json TEXT NOT NULL, event_sha256 TEXT NOT NULL CHECK(length(event_sha256)=64),
 state TEXT NOT NULL CHECK(state IN ('PENDING','IN_FLIGHT','ACKED','REJECTED')),
 attempts INTEGER NOT NULL CHECK(attempts>=0), available_at TEXT NOT NULL,
 lease_owner TEXT, lease_token TEXT, lease_until TEXT, created_at TEXT NOT NULL, delivered_at TEXT,rejection_reason TEXT,
 CHECK((state='IN_FLIGHT' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR state!='IN_FLIGHT')
);
CREATE INDEX worker_outbox_pending ON worker_outbox(state,available_at,created_at);
CREATE TABLE worker_provider_intents(
 intent_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 intent_json TEXT NOT NULL, owner_epoch INTEGER NOT NULL CHECK(owner_epoch>0), request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
 state TEXT NOT NULL CHECK(state IN ('RESERVED','ACCEPTED','REJECTED','UNKNOWN','SUCCEEDED','FAILED')),
 provider_run_id TEXT, result_json TEXT, updated_at TEXT NOT NULL, execution_fence_json TEXT,
 execution_fence_request_json TEXT,
 UNIQUE(provider_id,idempotency_key)
);
CREATE TABLE worker_provider_observations(
 observation_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES worker_provider_intents(intent_id),
 response_json TEXT NOT NULL, response_sha256 TEXT NOT NULL CHECK(length(response_sha256)=64), observed_at TEXT NOT NULL
);
CREATE TABLE worker_provider_result_outbox(
 event_id TEXT PRIMARY KEY,intent_id TEXT NOT NULL REFERENCES worker_provider_intents(intent_id),
 event_json TEXT NOT NULL,event_sha256 TEXT NOT NULL CHECK(length(event_sha256)=64),
 state TEXT NOT NULL CHECK(state IN ('PENDING','IN_FLIGHT','ACKED','REJECTED')),attempts INTEGER NOT NULL CHECK(attempts>=0),
 available_at TEXT NOT NULL,lease_owner TEXT,lease_token TEXT,lease_until TEXT,created_at TEXT NOT NULL,delivered_at TEXT,rejection_reason TEXT,
 CHECK((state='IN_FLIGHT' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR state!='IN_FLIGHT')
);
CREATE INDEX worker_provider_result_pending ON worker_provider_result_outbox(state,available_at,created_at);
CREATE TRIGGER worker_provider_observation_no_update BEFORE UPDATE ON worker_provider_observations BEGIN SELECT RAISE(ABORT,'provider observations are append-only'); END;
CREATE TRIGGER worker_provider_observation_no_delete BEFORE DELETE ON worker_provider_observations BEGIN SELECT RAISE(ABORT,'provider observations are append-only'); END;
CREATE TABLE worker_session_outbox(
 message_id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL,session_id TEXT NOT NULL,
 workflow_id TEXT NOT NULL,task_id TEXT NOT NULL,attempt INTEGER NOT NULL CHECK(attempt>0),
 owner_epoch INTEGER NOT NULL CHECK(owner_epoch>0),lease_id TEXT NOT NULL,worker_id TEXT NOT NULL,
 message_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('PENDING','IN_FLIGHT','ACKED','UNCERTAIN','REJECTED')),
 attempts INTEGER NOT NULL CHECK(attempts>=0),available_at TEXT NOT NULL,
 lease_owner TEXT,lease_token TEXT,lease_until TEXT,transport_started_at TEXT,receipt_json TEXT,
 UNIQUE(session_id,idempotency_key),
 CHECK((state='IN_FLIGHT' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR state!='IN_FLIGHT')
);
CREATE INDEX worker_session_pending ON worker_session_outbox(state,available_at,message_id);
CREATE TABLE worker_runtime_lock(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL CHECK(pid>0),
 process_start_ticks INTEGER NOT NULL CHECK(process_start_ticks>=0), lock_token TEXT NOT NULL,
 acquired_at TEXT NOT NULL
);
CREATE TABLE worker_execution_workspaces(
 claim_id TEXT PRIMARY KEY REFERENCES worker_inbox(claim_id),
 workflow_id TEXT NOT NULL,task_id TEXT NOT NULL,attempt INTEGER NOT NULL CHECK(attempt>0),
 owner_epoch INTEGER NOT NULL CHECK(owner_epoch>0),lease_id TEXT NOT NULL,worker_id TEXT NOT NULL,
 project_id INTEGER NOT NULL UNIQUE CHECK(project_id>=10000),workspace_path TEXT NOT NULL UNIQUE,
 device INTEGER,inode INTEGER,byte_limit INTEGER NOT NULL CHECK(byte_limit>0),
 inode_limit INTEGER NOT NULL CHECK(inode_limit>0),
 state TEXT NOT NULL CHECK(state IN ('ALLOCATING','ACTIVE','RELEASED','QUARANTINED')),
 diagnostic TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 UNIQUE(workflow_id,task_id,attempt),
 CHECK((state='ALLOCATING' AND device IS NULL AND inode IS NULL)
    OR (state IN ('ACTIVE','RELEASED','QUARANTINED') AND device IS NOT NULL AND inode IS NOT NULL)
    OR state='QUARANTINED')
);
CREATE INDEX worker_execution_workspaces_state ON worker_execution_workspaces(state,project_id);
CREATE TRIGGER worker_execution_workspace_identity_immutable
BEFORE UPDATE OF claim_id,workflow_id,task_id,attempt,owner_epoch,lease_id,worker_id,project_id,workspace_path,byte_limit,inode_limit,created_at
ON worker_execution_workspaces
BEGIN SELECT RAISE(ABORT,'execution workspace identity is immutable'); END;
CREATE TRIGGER worker_execution_workspace_no_delete
BEFORE DELETE ON worker_execution_workspaces
BEGIN SELECT RAISE(ABORT,'execution workspace ledger is append-only'); END;
PRAGMA user_version=7;
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ExecutionFence, ExecutionFenceKind, ExecutionFenceRequest, ExecutionFenceState,
        tests::envelope,
    };
    use runalith_execution_persistence::ProviderIntentRequest;

    #[test]
    fn inbox_is_durable_idempotent_and_conflicts_are_rejected_across_connections() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("worker.db");
        let first = WorkerStore::open(&path).unwrap();
        let second = WorkerStore::open(&path).unwrap();
        let claim = envelope(Utc::now());
        assert!(first.accept_claim(&claim).unwrap());
        assert!(!second.accept_claim(&claim).unwrap());
        let mut changed = claim.clone();
        changed.command.arguments.push("tamper".into());
        assert!(matches!(
            second.accept_claim(&changed),
            Err(WorkerStoreError::ClaimConflict)
        ));
        drop(first);
        drop(second);
        let reopened = WorkerStore::open(&path).unwrap();
        assert_eq!(reopened.counts().unwrap()["inbox"], 1);
    }

    #[test]
    fn provider_execution_fence_is_bound_to_running_claim_and_exact_dispatch_digest() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let claim = envelope(Utc::now());
        store.accept_claim(&claim).unwrap();
        store
            .begin_claim(&claim.claim_id, &claim.worker_id, claim.owner_epoch)
            .unwrap();
        let payload = serde_json::json!({"workflow":"build.yml","ref":"main"});
        let payload_sha256 = content_hash(&payload).unwrap();
        let intent = ProviderIntentRecord {
            intent_id: "provider-intent-1".into(),
            request: ProviderIntentRequest {
                workflow_id: claim.workflow_id.clone(),
                task_id: claim.task_id.clone(),
                attempt: claim.attempt,
                provider_id: "fixture-provider".into(),
                idempotency_key: "provider-key-1".into(),
                lease_id: claim.lease_id.clone(),
                worker_id: claim.worker_id.clone(),
                plan_sha256: claim.plan_sha256.clone(),
                request_sha256: payload_sha256.clone(),
                payload: Some(payload.clone()),
            },
            state: ProviderDispatchState::Reserved,
            provider_run_id: None,
            outcome: None,
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        };
        assert!(
            store
                .reserve_provider_intent(&intent, claim.owner_epoch)
                .unwrap()
        );
        let dispatch = ProviderDispatchRequest {
            provider_id: intent.request.provider_id.clone(),
            idempotency_key: intent.request.idempotency_key.clone(),
            workflow_id: intent.request.workflow_id.clone(),
            task_id: intent.request.task_id.clone(),
            attempt: intent.request.attempt,
            lease_id: intent.request.lease_id.clone(),
            worker_id: intent.request.worker_id.clone(),
            plan_sha256: intent.request.plan_sha256.clone(),
            request_sha256: intent.request.request_sha256.clone(),
            payload,
        };
        let idempotency_identity = serde_json::json!({
            "claim_id": claim.claim_id,
            "lease_id": claim.lease_id,
            "owner_epoch": claim.owner_epoch,
            "kind": ExecutionFenceKind::ProviderDispatch,
            "side_effect_id": intent.intent_id
        });
        let fence_request = ExecutionFenceRequest {
            claim_id: claim.claim_id.clone(),
            lease_id: claim.lease_id.clone(),
            worker_id: claim.worker_id.clone(),
            owner_epoch: claim.owner_epoch,
            plan_sha256: claim.plan_sha256.clone(),
            side_effect_id: intent.intent_id.clone(),
            kind: ExecutionFenceKind::ProviderDispatch,
            request_sha256: content_hash(&dispatch).unwrap(),
            idempotency_key: format!(
                "worker-fence:{}",
                content_hash(&idempotency_identity).unwrap()
            ),
            acl_sha256: claim.authenticator["acl_sha256"].as_str().unwrap().into(),
        };
        store
            .persist_provider_execution_fence_request(&intent.intent_id, &fence_request)
            .unwrap();
        let fence = ExecutionFence {
            fence_id: "provider-fence-1".into(),
            claim_id: claim.claim_id.clone(),
            lease_id: claim.lease_id.clone(),
            worker_id: claim.worker_id.clone(),
            owner_epoch: claim.owner_epoch,
            plan_sha256: claim.plan_sha256.clone(),
            side_effect_id: intent.intent_id.clone(),
            kind: ExecutionFenceKind::ProviderDispatch,
            request_sha256: content_hash(&dispatch).unwrap(),
            idempotency_key: fence_request.idempotency_key.clone(),
            state: ExecutionFenceState::Reserved,
            receipt: serde_json::json!({"reservation_id":"provider-fence-1"}),
        };
        store
            .persist_provider_execution_fence(&intent.intent_id, &fence)
            .unwrap();
        let reconciliations = store.list_provider_intents_for_reconciliation(10).unwrap();
        assert_eq!(reconciliations.len(), 1);
        assert_eq!(reconciliations[0].execution_fence.as_ref(), Some(&fence));
        assert_eq!(
            reconciliations[0].execution_fence_request.as_ref(),
            Some(&fence_request)
        );

        let mut changed_request = fence_request.clone();
        changed_request.acl_sha256 = "d".repeat(64);
        assert!(
            store
                .persist_provider_execution_fence_request(&intent.intent_id, &changed_request)
                .is_err()
        );

        let mut changed = fence.clone();
        changed.request_sha256 = "d".repeat(64);
        assert!(
            store
                .persist_provider_execution_fence(&intent.intent_id, &changed)
                .is_err()
        );
    }

    #[test]
    fn worker_v4_migration_adds_nullable_execution_fence_without_losing_intents() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("worker-v4.db");
        let current = WorkerStore::open(&path).unwrap();
        drop(current);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "ALTER TABLE worker_provider_intents DROP COLUMN execution_fence_json;
                 PRAGMA user_version=4;",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO worker_provider_intents(
                    intent_id,provider_id,idempotency_key,intent_json,owner_epoch,
                    request_sha256,state,provider_run_id,result_json,updated_at
                 ) VALUES('legacy-intent','fixture-provider','legacy-key','{}',7,?1,'UNKNOWN',NULL,NULL,'2026-11-02T00:00:00Z');
                ",
                ["a".repeat(64)],
            )
            .unwrap();
        drop(connection);

        let migrated = WorkerStore::open(&path).unwrap();
        let connection = migrated.connection.lock().unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let (intent_id, fence): (String, Option<String>) = connection
            .query_row(
                "SELECT intent_id,execution_fence_json FROM worker_provider_intents WHERE intent_id='legacy-intent'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(version, 7);
        assert_eq!(intent_id, "legacy-intent");
        assert!(fence.is_none());
    }

    #[test]
    fn per_execution_project_ids_are_monotonic_and_workspace_ledger_is_fenced() {
        use std::os::unix::fs::MetadataExt;

        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let workspace_root = directory.path().join("workspace-root");
        let workspace_parent = workspace_root.join(".runalith-executions");
        fs::create_dir_all(&workspace_parent).unwrap();
        let first_claim = envelope(Utc::now());
        store.accept_claim(&first_claim).unwrap();
        store
            .begin_claim(
                &first_claim.claim_id,
                &first_claim.worker_id,
                first_claim.owner_epoch,
            )
            .unwrap();

        let first = store
            .reserve_execution_workspace(
                &first_claim,
                &workspace_root,
                &workspace_parent,
                1024 * 1024,
                4096,
            )
            .unwrap();
        assert_eq!(first.project_id, 10_000);
        assert_eq!(first.state, ExecutionWorkspaceState::Allocating);
        fs::create_dir(&first.workspace_path).unwrap();
        let metadata = fs::metadata(&first.workspace_path).unwrap();
        store
            .activate_execution_workspace(&first, metadata.dev(), metadata.ino())
            .unwrap();
        let mut first_active = first.clone();
        first_active.device = Some(metadata.dev());
        first_active.inode = Some(metadata.ino());
        first_active.state = ExecutionWorkspaceState::Active;
        assert_eq!(
            store.execution_workspace(&first.claim_id).unwrap(),
            Some(first_active.clone())
        );
        store.release_execution_workspace(&first_active).unwrap();
        assert_eq!(
            store
                .execution_workspace(&first.claim_id)
                .unwrap()
                .unwrap()
                .state,
            ExecutionWorkspaceState::Released
        );

        let mut second_claim = first_claim.clone();
        second_claim.claim_id = "claim-2".into();
        second_claim.workflow_id = "workflow-2".into();
        second_claim.task_id = "task-2".into();
        second_claim.idempotency_key = "idem-2".into();
        store.accept_claim(&second_claim).unwrap();
        store
            .begin_claim(
                &second_claim.claim_id,
                &second_claim.worker_id,
                second_claim.owner_epoch,
            )
            .unwrap();
        let second = store
            .reserve_execution_workspace(
                &second_claim,
                &workspace_root,
                &workspace_parent,
                1024 * 1024,
                4096,
            )
            .unwrap();
        assert_eq!(second.project_id, 10_001);
        assert_eq!(second.state, ExecutionWorkspaceState::Allocating);
        assert_eq!(
            store.quarantine_unrecovered_execution_workspaces().unwrap(),
            1
        );
        assert_eq!(
            store
                .execution_workspace(&second.claim_id)
                .unwrap()
                .unwrap()
                .state,
            ExecutionWorkspaceState::Quarantined
        );
        assert!(store.release_execution_workspace(&second).is_err());
    }

    #[test]
    fn worker_v5_migration_adds_append_only_execution_workspace_ledger() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("worker-v5.db");
        drop(WorkerStore::open(&path).unwrap());
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("PRAGMA user_version=5;").unwrap();
        drop(connection);
        let migrated = WorkerStore::open(&path).unwrap();
        let connection = migrated.connection.lock().unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let exists: i64 = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='worker_execution_workspaces')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, 7);
        assert_eq!(exists, 1);
    }

    #[test]
    fn worker_v6_migration_adds_provider_fence_request_journal() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("worker-v6.db");
        drop(WorkerStore::open(&path).unwrap());
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "INSERT INTO worker_provider_intents(
                    intent_id,provider_id,idempotency_key,intent_json,owner_epoch,
                    request_sha256,state,provider_run_id,result_json,updated_at,execution_fence_json
                 ) VALUES(
                    'pre-v7-intent','fixture-provider','pre-v7-key','{}',9,
                    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    'UNKNOWN',NULL,NULL,'2026-11-03T00:00:00Z',
                    '{\"fence_id\":\"pre-v7-fence\",\"claim_id\":\"claim-v6\",\"lease_id\":\"lease-v6\",\"worker_id\":\"worker-v6\",\"owner_epoch\":9,\"plan_sha256\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"side_effect_id\":\"pre-v7-intent\",\"kind\":\"provider_dispatch\",\"request_sha256\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"idempotency_key\":\"fence-v6-key\",\"state\":\"RESERVED\",\"receipt\":{\"durable\":true}}'
                 );
                 ALTER TABLE worker_provider_intents DROP COLUMN execution_fence_request_json;
                 PRAGMA user_version=6;",
            )
            .unwrap();
        drop(connection);

        let migrated = WorkerStore::open(&path).unwrap();
        let connection = migrated.connection.lock().unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 7);
        let (intent_id, owner_epoch, state, fence_json, request_json): (
            String,
            i64,
            String,
            Option<String>,
            Option<String>,
        ) = connection
            .query_row(
                "SELECT intent_id,owner_epoch,state,execution_fence_json,execution_fence_request_json FROM worker_provider_intents WHERE intent_id='pre-v7-intent'",
                [],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
            )
            .unwrap();
        assert_eq!(intent_id, "pre-v7-intent");
        assert_eq!(owner_epoch, 9);
        assert_eq!(state, "UNKNOWN");
        assert_eq!(
            serde_json::from_str::<crate::ExecutionFence>(fence_json.as_deref().unwrap())
                .unwrap()
                .fence_id,
            "pre-v7-fence"
        );
        assert!(request_json.is_none());
        assert!(
            column_exists(
                &connection,
                "worker_provider_intents",
                "execution_fence_request_json"
            )
            .unwrap()
        );
        assert!(
            column_exists(
                &connection,
                "worker_provider_intents",
                "execution_fence_json"
            )
            .unwrap()
        );
    }

    #[test]
    fn definitive_rejections_are_durable_quarantined_and_never_leased_again() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let claim = envelope(Utc::now());
        store.accept_claim(&claim).unwrap();
        store
            .begin_claim(&claim.claim_id, &claim.worker_id, claim.owner_epoch)
            .unwrap();
        let event = WorkerResultEvent {
            event_id: "event-rejected".into(),
            schema_version: 1,
            producer: claim.worker_id.clone(),
            workflow_id: claim.workflow_id.clone(),
            task_id: claim.task_id.clone(),
            attempt: claim.attempt,
            owner_epoch: claim.owner_epoch,
            lease_id: claim.lease_id.clone(),
            plan_sha256: claim.plan_sha256.clone(),
            claim_id: claim.claim_id.clone(),
            worker_id: claim.worker_id.clone(),
            command_sha256: claim.command_sha256.clone(),
            idempotency_key: claim.idempotency_key.clone(),
            outcome: WorkerOutcome::Unknown,
            evidence: None,
            diagnostic: Some("fixture".into()),
            created_at: Utc::now().to_rfc3339(),
        };
        store.complete_claim(&event).unwrap();
        let lease = store.lease_outbox("dispatcher", 30).unwrap().unwrap();
        store
            .reject_outbox(&lease, "HTTP 422: invalid event")
            .unwrap();
        assert!(store.lease_outbox("dispatcher", 30).unwrap().is_none());
        let connection = store.connection.lock().unwrap();
        let (state, reason): (String, Option<String>) = connection
            .query_row(
                "SELECT state,rejection_reason FROM worker_outbox WHERE event_id='event-rejected'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(state, "REJECTED");
        assert_eq!(reason.as_deref(), Some("HTTP 422: invalid event"));
        drop(connection);
        assert_eq!(store.counts().unwrap()["outbox_rejected"], 1);
        assert_eq!(store.counts().unwrap()["outbox"], 1);

        let provider_event = ProviderResultEvent {
            event_id: "provider-event-rejected".into(),
            intent_id: "intent-rejected".into(),
            provider_id: "fixture-provider".into(),
            workflow_id: "workflow-1".into(),
            task_id: "task-1".into(),
            attempt: 1,
            owner_epoch: 7,
            lease_id: "lease-1".into(),
            worker_id: "worker-1".into(),
            plan_sha256: "a".repeat(64),
            provider_run_id: "run-1".into(),
            outcome: WorkerOutcome::Succeeded,
            result: serde_json::json!({"ok":true}),
            created_at: Utc::now().to_rfc3339(),
        };
        let json = serde_json::to_string(&provider_event).unwrap();
        {
            let connection = store.connection.lock().unwrap();
            connection.execute("INSERT INTO worker_provider_intents(intent_id,provider_id,idempotency_key,intent_json,owner_epoch,request_sha256,state,provider_run_id,result_json,updated_at) VALUES('intent-rejected','fixture-provider','key-1','{}',7,?1,'SUCCEEDED','run-1','{}',?2)", params!["b".repeat(64), Utc::now().to_rfc3339()]).unwrap();
            connection.execute("INSERT INTO worker_provider_result_outbox(event_id,intent_id,event_json,event_sha256,state,attempts,available_at,created_at) VALUES(?1,?2,?3,?4,'PENDING',0,?5,?5)", params![provider_event.event_id,provider_event.intent_id,json,sha256(json.as_bytes()),Utc::now().to_rfc3339()]).unwrap();
        }
        let provider_lease = store
            .lease_provider_result("dispatcher", 30)
            .unwrap()
            .unwrap();
        store
            .reject_provider_result(&provider_lease, "HTTP 400: invalid provider result")
            .unwrap();
        assert!(
            store
                .lease_provider_result("dispatcher", 30)
                .unwrap()
                .is_none()
        );
        let connection = store.connection.lock().unwrap();
        let (state, reason): (String, Option<String>) = connection
            .query_row(
                "SELECT state,rejection_reason FROM worker_provider_result_outbox WHERE event_id='provider-event-rejected'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(state, "REJECTED");
        assert_eq!(reason.as_deref(), Some("HTTP 400: invalid provider result"));
    }

    #[test]
    fn competing_connections_only_begin_claim_once_and_restart_quarantines_running() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("worker.db");
        let first = WorkerStore::open(&path).unwrap();
        let second = WorkerStore::open(&path).unwrap();
        let claim = envelope(Utc::now());
        first.accept_claim(&claim).unwrap();
        assert!(
            first
                .begin_claim(&claim.claim_id, "worker-1", claim.owner_epoch)
                .is_ok()
        );
        assert!(
            second
                .begin_claim(&claim.claim_id, "worker-1", claim.owner_epoch)
                .is_err()
        );
        assert_eq!(second.recover_interrupted("worker-1").unwrap(), 1);
        assert!(
            second
                .begin_claim(&claim.claim_id, "worker-1", claim.owner_epoch)
                .is_err()
        );
        assert_eq!(second.counts().unwrap()["outbox"], 1);
    }

    #[test]
    fn claim_start_and_session_outbox_batch_roll_back_together() {
        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let now = Utc::now();
        let mut claim = envelope(now);
        let message = SessionDeliveryEnvelope {
            message_id: "message-1".into(),
            idempotency_key: "session-key-1".into(),
            workflow_id: claim.workflow_id.clone(),
            task_id: claim.task_id.clone(),
            attempt: claim.attempt,
            owner_epoch: claim.owner_epoch,
            lease_id: claim.lease_id.clone(),
            worker_id: claim.worker_id.clone(),
            session_id: "session-1".into(),
            recipient_role: "qa".into(),
            message_type: "task.completed".into(),
            payload: serde_json::json!({"text":"done"}),
            expires_at: (now + chrono::Duration::minutes(10)).to_rfc3339(),
        };
        let mut invalid = message.clone();
        invalid.message_id = "message-invalid".into();
        invalid.idempotency_key = "session-key-invalid".into();
        invalid.owner_epoch = 0;
        claim.session_messages = vec![message, invalid];
        store.accept_claim(&claim).unwrap();
        assert!(
            store
                .begin_claim_with_session_messages(
                    &claim.claim_id,
                    "worker-1",
                    claim.owner_epoch,
                    &claim.session_messages
                )
                .is_err()
        );
        let connection = store.connection.lock().unwrap();
        let state: String = connection
            .query_row(
                "SELECT state FROM worker_inbox WHERE claim_id=?1",
                [&claim.claim_id],
                |row| row.get(0),
            )
            .unwrap();
        let session_rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM worker_session_outbox", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(state, "RECEIVED");
        assert_eq!(session_rows, 0);
    }

    #[test]
    fn worker_v1_migration_preserves_legacy_rows_without_granting_delivery_authority() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("worker-v1.db");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("CREATE TABLE worker_inbox(claim_id TEXT PRIMARY KEY);
            CREATE TABLE worker_outbox(
             event_id TEXT PRIMARY KEY,claim_id TEXT NOT NULL UNIQUE REFERENCES worker_inbox(claim_id),
             event_json TEXT NOT NULL,event_sha256 TEXT NOT NULL,state TEXT NOT NULL,
             attempts INTEGER NOT NULL,available_at TEXT NOT NULL,lease_owner TEXT,lease_token TEXT,
             lease_until TEXT,created_at TEXT NOT NULL,delivered_at TEXT);
            CREATE TABLE worker_provider_intents(
            intent_id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,
            intent_json TEXT NOT NULL,request_sha256 TEXT NOT NULL,state TEXT NOT NULL,
            provider_run_id TEXT,result_json TEXT,updated_at TEXT NOT NULL,
            UNIQUE(provider_id,idempotency_key));
            CREATE TABLE worker_session_outbox(
             message_id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL,session_id TEXT NOT NULL,
             workflow_id TEXT NOT NULL,task_id TEXT NOT NULL,attempt INTEGER NOT NULL,
             lease_id TEXT NOT NULL,worker_id TEXT NOT NULL,message_json TEXT NOT NULL,
             state TEXT NOT NULL,attempts INTEGER NOT NULL,available_at TEXT NOT NULL,
             lease_owner TEXT,lease_token TEXT,lease_until TEXT,transport_started_at TEXT,receipt_json TEXT,
             UNIQUE(session_id,idempotency_key));
            INSERT INTO worker_session_outbox VALUES('legacy-message','legacy-key','session','workflow','task',1,'lease','worker','{}','PENDING',0,'2026-01-01T00:00:00Z',NULL,NULL,NULL,NULL,NULL);
            INSERT INTO worker_session_outbox VALUES('legacy-inflight','legacy-key-2','session','workflow','task',1,'lease','worker','{}','IN_FLIGHT',1,'2026-01-01T00:00:00Z','worker','old-token','2026-12-01T00:00:00Z',NULL,NULL);
            PRAGMA user_version=1;").unwrap();
        drop(connection);

        let store = WorkerStore::open(&path).unwrap();
        let connection = store.connection.lock().unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let epoch: i64 = connection
            .query_row(
                "SELECT owner_epoch FROM worker_session_outbox WHERE message_id='legacy-message'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let inflight_state: String = connection
            .query_row(
                "SELECT state FROM worker_session_outbox WHERE message_id='legacy-inflight'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, 7);
        assert_eq!(epoch, 0);
        assert_eq!(inflight_state, "UNCERTAIN");
        drop(connection);
        assert!(
            store
                .lease_session_delivery("worker", 30)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn worker_v2_migration_adds_singleton_process_lock_transactionally() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("worker-v2.db");
        drop(WorkerStore::open(&path).unwrap());
        let connection = Connection::open(&path).unwrap();
        connection.pragma_update(None, "user_version", 2).unwrap();
        drop(connection);
        let store = WorkerStore::open(&path).unwrap();
        let connection = store.connection.lock().unwrap();
        let exists: i64 = connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='worker_runtime_lock')", [], |row| row.get(0)).unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(exists, 1);
        assert_eq!(version, 7);
    }

    #[test]
    fn worker_v3_migration_adds_rejection_quarantine_columns_and_state() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("worker-v3.db");
        drop(WorkerStore::open(&path).unwrap());
        let connection = Connection::open(&path).unwrap();
        connection.pragma_update(None, "user_version", 3).unwrap();
        drop(connection);
        let store = WorkerStore::open(&path).unwrap();
        let connection = store.connection.lock().unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 7);
        for table in ["worker_outbox", "worker_provider_result_outbox"] {
            assert!(column_exists(&connection, table, "rejection_reason").unwrap());
            let sql: String = connection
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(sql.contains("'REJECTED'"));
        }
    }

    #[test]
    fn worker_process_lock_is_exclusive_and_released_by_exact_token() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("worker.db");
        let first = WorkerStore::open(&path).unwrap();
        let second = WorkerStore::open(&path).unwrap();
        let token = first.acquire_process_lock().unwrap();
        assert!(second.acquire_process_lock().is_err());
        assert!(second.release_process_lock("stale-token").is_err());
        first.release_process_lock(&token).unwrap();
        let next = second.acquire_process_lock().unwrap();
        second.release_process_lock(&next).unwrap();
    }

    #[test]
    fn read_only_open_never_creates_migrates_or_mutates_worker_database() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing.db");
        assert!(WorkerStore::open_read_only(&missing).is_err());
        assert!(!missing.exists());

        let current = directory.path().join("current.db");
        WorkerStore::open(&current).unwrap();
        let read_only = WorkerStore::open_read_only(&current).unwrap();
        assert!(read_only.connection.lock().unwrap().execute(
            "INSERT INTO worker_runtime_lock(singleton,pid,process_start_ticks,lock_token,acquired_at) VALUES(1,1,1,'x','now')",
            [],
        ).is_err());

        let legacy = directory.path().join("legacy-v1.db");
        let connection = Connection::open(&legacy).unwrap();
        connection.pragma_update(None, "user_version", 1).unwrap();
        drop(connection);
        assert!(WorkerStore::open_read_only(&legacy).is_err());
        let connection = Connection::open(&legacy).unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 1);
    }

    #[test]
    fn concurrent_first_openers_recheck_schema_version_under_immediate_lock() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("concurrent-first-open.db");
        let mut first = Connection::open(&path).unwrap();
        let mut second = Connection::open(&path).unwrap();
        for connection in [&first, &second] {
            connection.busy_timeout(Duration::from_secs(5)).unwrap();
            connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;").unwrap();
            let version: i64 = connection
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .unwrap();
            assert_eq!(version, 0);
        }
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let first_barrier = barrier.clone();
        let first_thread = std::thread::spawn(move || {
            first_barrier.wait();
            initialize_schema(&mut first).unwrap();
        });
        let second_thread = std::thread::spawn(move || {
            barrier.wait();
            initialize_schema(&mut second).unwrap();
        });
        first_thread.join().unwrap();
        second_thread.join().unwrap();
        let store = WorkerStore::open(&path).unwrap();
        assert_eq!(store.counts().unwrap()["inbox"], 0);
    }

    #[test]
    fn child_process_lock_probe() {
        let Ok(path) = std::env::var("RUNALITH_WORKER_LOCK_PROBE_DB") else {
            return;
        };
        let store = WorkerStore::open(path).unwrap();
        match std::env::var("RUNALITH_WORKER_LOCK_PROBE_MODE").as_deref() {
            Ok("blocked") => assert!(store.acquire_process_lock().is_err()),
            Ok("acquire") => {
                let token = store.acquire_process_lock().unwrap();
                store.release_process_lock(&token).unwrap();
            }
            Ok("crash") => {
                let _token = store.acquire_process_lock().unwrap();
                std::process::exit(0);
            }
            _ => panic!("unknown process-lock probe mode"),
        }
    }

    #[test]
    fn process_lock_excludes_other_processes_and_recovers_after_owner_exit() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("worker.db");
        let store = WorkerStore::open(&path).unwrap();
        let token = store.acquire_process_lock().unwrap();
        let run_probe = |mode: &str| {
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "store::tests::child_process_lock_probe",
                    "--nocapture",
                ])
                .env("RUNALITH_WORKER_LOCK_PROBE_DB", &path)
                .env("RUNALITH_WORKER_LOCK_PROBE_MODE", mode)
                .status()
                .unwrap()
        };
        assert!(run_probe("blocked").success());
        store.release_process_lock(&token).unwrap();
        assert!(run_probe("crash").success());
        let recovered = store.acquire_process_lock().unwrap();
        store.release_process_lock(&recovered).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_dangling_database_symlink_and_secures_owned_parent() {
        use std::os::unix::{
            fs::MetadataExt,
            fs::{PermissionsExt, symlink},
        };
        let directory = tempfile::tempdir().unwrap();
        let dangling = directory.path().join("dangling.db");
        symlink(directory.path().join("missing-target.db"), &dangling).unwrap();
        assert!(matches!(
            WorkerStore::open(&dangling),
            Err(WorkerStoreError::UnsafePath(_))
        ));

        let shared = directory.path().join("shared");
        fs::create_dir(&shared).unwrap();
        fs::set_permissions(&shared, fs::Permissions::from_mode(0o777)).unwrap();
        WorkerStore::open(shared.join("worker.db")).unwrap();
        assert_eq!(fs::metadata(&shared).unwrap().mode() & 0o777, 0o700);
    }

    #[test]
    fn child_process_inbox_probe() {
        let Ok(path) = std::env::var("RUNALITH_WORKER_INBOX_PROBE_DB") else {
            return;
        };
        let claim_path = std::env::var("RUNALITH_WORKER_INBOX_PROBE_CLAIM").unwrap();
        let mut claim: TaskClaimEnvelope =
            serde_json::from_slice(&fs::read(claim_path).unwrap()).unwrap();
        let store = WorkerStore::open(path).unwrap();
        match std::env::var("RUNALITH_WORKER_INBOX_PROBE_MODE").as_deref() {
            Ok("duplicate") => assert!(!store.accept_claim(&claim).unwrap()),
            Ok("begin") => assert!(
                store
                    .begin_claim(&claim.claim_id, "worker-1", claim.owner_epoch)
                    .is_ok()
            ),
            Ok("conflict") => {
                claim.authenticator["cross_process_tamper"] = Value::Bool(true);
                assert!(matches!(
                    store.accept_claim(&claim),
                    Err(WorkerStoreError::ClaimConflict)
                ));
            }
            _ => panic!("unknown inbox probe mode"),
        }
    }

    #[test]
    fn claim_deduplication_and_conflict_detection_cross_process_boundaries() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("worker.db");
        let claim_path = directory.path().join("claim.json");
        let claim = envelope(Utc::now());
        fs::write(&claim_path, serde_json::to_vec(&claim).unwrap()).unwrap();
        let store = WorkerStore::open(&path).unwrap();
        assert!(store.accept_claim(&claim).unwrap());
        let run_probe = |mode: &str| {
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "store::tests::child_process_inbox_probe",
                    "--nocapture",
                ])
                .env("RUNALITH_WORKER_INBOX_PROBE_DB", &path)
                .env("RUNALITH_WORKER_INBOX_PROBE_CLAIM", &claim_path)
                .env("RUNALITH_WORKER_INBOX_PROBE_MODE", mode)
                .status()
                .unwrap()
        };
        assert!(run_probe("duplicate").success());
        assert!(run_probe("conflict").success());
        assert!(run_probe("begin").success());
        assert!(
            store
                .begin_claim(&claim.claim_id, "worker-1", claim.owner_epoch)
                .is_err()
        );
    }
}
