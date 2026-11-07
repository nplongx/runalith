//! Plan-scoped, expiring, one-use workspace writes with immutable receipts.
//!
//! The caller must verify workflow state, approval, immutable plan binding and
//! task role before issuing a capability. This module enforces the resulting
//! filesystem scope and capability lifetime; it is not an approval authority.

#[cfg(not(target_os = "linux"))]
use std::ffi::OsString;

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use runalith_artifacts::{ArtifactError, ArtifactStore, StoredArtifact};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

const MAX_WRITE_BYTES: usize = 2_000_000;
const MAX_ID_BYTES: usize = 256;

// Serialize journal reconciliation and mutations within this process. The
// advisory file lock extends the same critical section across worker
// processes sharing an artifact root.
static JOURNAL_MUTEX: Mutex<()> = Mutex::new(());

struct WorkspaceWriteJournalLock {
    // Drop the file lock before releasing the in-process mutex.
    _file: File,
    _guard: MutexGuard<'static, ()>,
}

/// Immutable evidence for one workspace file mutation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceWriteReceipt {
    /// Deterministic receipt identity for job/task/patch/path.
    pub receipt_id: String,
    /// Authorized workflow job identity.
    pub job_id: String,
    /// Authorized task identity.
    pub task_id: String,
    /// SHA-256 of the immutable approved plan.
    pub plan_hash: String,
    /// Caller-supplied patch identity.
    pub patch_id: String,
    /// SHA-256 of the exact serialized write request.
    pub request_hash: String,
    /// Workspace-relative target path.
    pub path: String,
    /// Mutation result.
    pub outcome: WorkspaceWriteOutcome,
    /// SHA-256 before mutation, or `ABSENT` when creating a file.
    pub before_sha256: String,
    /// SHA-256 of exact resulting file bytes.
    pub after_sha256: String,
    /// Exact resulting byte count.
    pub size_bytes: u64,
    /// Creation time as Unix milliseconds.
    pub created_at_unix_ms: u64,
}

/// Stable outcome vocabulary for workspace write receipts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceWriteOutcome {
    /// A previously absent file was created.
    Created,
    /// An existing file was replaced.
    Replaced,
    /// File already contained the requested bytes.
    AlreadyPresent,
}

/// Receipt plus its immutable content-addressed artifact reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredWorkspaceWriteReceipt {
    /// Exact receipt contract stored as an immutable artifact.
    pub receipt: WorkspaceWriteReceipt,
    /// Content-addressed receipt artifact; `sha256` hashes serialized receipt bytes.
    pub artifact: StoredArtifact,
}

/// Outcome of startup or pre-write reconciliation of durable mutation intents.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WorkspaceWriteRecoveryReport {
    /// Mutations whose exact post-write hash was present and receipt persisted.
    pub receipts_recovered: usize,
    /// Intents whose exact pre-write hash remained, proving mutation never committed.
    pub unapplied_intents_discarded: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceWriteIntent {
    version: u32,
    workspace_device: u64,
    workspace_inode: u64,
    path: String,
    before_sha256: String,
    after_sha256: String,
    receipt_bytes: Vec<u8>,
}

/// Workspace write capability or receipt failure.
#[derive(Debug, Error)]
pub enum WorkspaceWriteError {
    /// Invalid capability claims, scope, path, expiry or base hash.
    #[error("workspace write policy rejected operation: {0}")]
    Policy(String),
    /// Filesystem operation failed before a mutation was established.
    #[error("workspace write filesystem error: {0}")]
    Io(#[from] std::io::Error),
    /// Immutable receipt could not be stored after file mutation.
    #[error("workspace file changed but receipt storage failed: {source}")]
    MutationUnreceipted {
        /// Workspace-relative path that was changed.
        path: String,
        /// Digest observed after mutation.
        after_sha256: String,
        /// Artifact storage failure.
        #[source]
        source: ArtifactError,
    },
    /// Rename completed but directory durability could not be confirmed.
    #[error("workspace file mutation durability is unresolved for {path}: {message}")]
    MutationUncertain {
        /// Workspace-relative path that may have changed.
        path: String,
        /// Digest of intended resulting bytes.
        after_sha256: String,
        /// Durability failure detail.
        message: String,
    },
    /// Immutable receipt serialization failed.
    #[error("workspace receipt serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
    /// Host clock is before Unix epoch or outside supported range.
    #[error("system clock is outside supported Unix timestamp range")]
    Clock,
    /// Durable write-intent journal could not be created or reconciled.
    #[error("workspace write journal failure: {0}")]
    Journal(String),
    /// Current workspace bytes match neither the recorded before nor after digest.
    #[error("workspace write recovery conflict for {path}: {message}")]
    RecoveryConflict {
        /// Workspace-relative path requiring operator reconciliation.
        path: String,
        /// Non-secret conflict detail.
        message: String,
    },
}

/// Reconcile every durable write intent before enabling workspace mutations.
///
/// Recovery never replays a mutation. It only persists a receipt when the
/// exact after-hash is already present, discards an intent when the exact
/// before-hash remains, and fails closed when neither state matches.
pub fn recover_workspace_write_journal(
    workspace_root: impl AsRef<Path>,
    receipt_store: &ArtifactStore,
) -> Result<WorkspaceWriteRecoveryReport, WorkspaceWriteError> {
    let _lock = acquire_workspace_write_journal_lock(receipt_store)?;
    recover_workspace_write_journal_locked(workspace_root.as_ref(), receipt_store)
}

fn recover_workspace_write_journal_locked(
    workspace_root: &Path,
    receipt_store: &ArtifactStore,
) -> Result<WorkspaceWriteRecoveryReport, WorkspaceWriteError> {
    let metadata = fs::symlink_metadata(workspace_root)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(WorkspaceWriteError::Policy(
            "workspace recovery root must be a regular non-symlink directory".into(),
        ));
    }
    let workspace_root = fs::canonicalize(workspace_root)?;
    let identity = directory_identity(&workspace_root)?;
    let journal_dir = receipt_store.root_path().join("workspace-write-journal");
    let journal_metadata = match fs::symlink_metadata(&journal_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(WorkspaceWriteRecoveryReport::default());
        }
        Err(error) => return Err(WorkspaceWriteError::Io(error)),
    };
    if journal_metadata.file_type().is_symlink() || !journal_metadata.is_dir() {
        return Err(WorkspaceWriteError::Journal(
            "journal root is not a regular directory".into(),
        ));
    }

    let mut entries = fs::read_dir(&journal_dir)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    let mut report = WorkspaceWriteRecoveryReport::default();
    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            if entry.file_name().to_string_lossy().starts_with(".intent-")
                && path.extension().and_then(|value| value.to_str()) == Some("tmp")
            {
                let metadata = fs::symlink_metadata(&path)?;
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(WorkspaceWriteError::Journal(
                        "temporary journal entry is not a regular file".into(),
                    ));
                }
                fs::remove_file(&path)?;
            }
            continue;
        }
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(WorkspaceWriteError::Journal(
                "journal entry is not a regular non-symlink file".into(),
            ));
        }
        let bytes = fs::read(&path)?;
        let intent: WorkspaceWriteIntent = serde_json::from_slice(&bytes)
            .map_err(|error| WorkspaceWriteError::Journal(error.to_string()))?;
        let relative = validate_relative(Path::new(&intent.path), "journal path")?;
        if intent.version != 1
            || (intent.workspace_device, intent.workspace_inode) != identity
            || !valid_hash(&intent.after_sha256)
            || (intent.before_sha256 != "ABSENT" && !valid_hash(&intent.before_sha256))
        {
            return Err(WorkspaceWriteError::RecoveryConflict {
                path: intent.path,
                message: "journal identity, version or digest binding is invalid".into(),
            });
        }
        let receipt: WorkspaceWriteReceipt = serde_json::from_slice(&intent.receipt_bytes)
            .map_err(|error| WorkspaceWriteError::Journal(error.to_string()))?;
        if relative.to_string_lossy() != intent.path {
            return Err(WorkspaceWriteError::RecoveryConflict {
                path: intent.path,
                message: "journal path is not in canonical workspace-relative form".into(),
            });
        }
        let expected_file = format!("{}.json", receipt.receipt_id);
        let receipt_key = format!(
            "{}\0{}\0{}\0{}",
            receipt.job_id, receipt.task_id, receipt.patch_id, receipt.path
        );
        let expected_receipt_id = format!("wwr_{}", &digest(receipt_key.as_bytes())[..32]);
        if path.file_name().and_then(|value| value.to_str()) != Some(expected_file.as_str())
            || receipt.receipt_id != expected_receipt_id
            || receipt.path != intent.path
            || receipt.before_sha256 != intent.before_sha256
            || receipt.after_sha256 != intent.after_sha256
            || !valid_hash(&receipt.plan_hash)
            || !valid_hash(&receipt.request_hash)
            || receipt.size_bytes > MAX_WRITE_BYTES as u64
            || (receipt.before_sha256 == "ABSENT"
                && receipt.outcome != WorkspaceWriteOutcome::Created)
            || (receipt.before_sha256 != "ABSENT"
                && receipt.outcome != WorkspaceWriteOutcome::Replaced)
        {
            return Err(WorkspaceWriteError::RecoveryConflict {
                path: intent.path,
                message: "journal receipt does not bind exact path and before/after hashes".into(),
            });
        }

        let current = read_workspace_relative(&workspace_root, &relative)?;
        let current_hash = current.as_deref().map(digest);
        if current_hash.as_deref() == Some(intent.after_sha256.as_str()) {
            if current.as_ref().map(Vec::len) != Some(receipt.size_bytes as usize) {
                return Err(WorkspaceWriteError::RecoveryConflict {
                    path: intent.path,
                    message: "after-hash file length differs from receipt".into(),
                });
            }
            receipt_store
                .put(
                    "application/vnd.runalith.workspace-write-receipt+json",
                    &intent.receipt_bytes,
                )
                .map_err(|error| WorkspaceWriteError::Journal(error.to_string()))?;
            fs::remove_file(&path)?;
            report.receipts_recovered += 1;
        } else if (intent.before_sha256 == "ABSENT" && current.is_none())
            || current_hash.as_deref() == Some(intent.before_sha256.as_str())
        {
            fs::remove_file(&path)?;
            report.unapplied_intents_discarded += 1;
        } else {
            return Err(WorkspaceWriteError::RecoveryConflict {
                path: intent.path,
                message: "current bytes match neither durable before nor after digest".into(),
            });
        }
    }
    File::open(&journal_dir)?.sync_all()?;
    Ok(report)
}

fn acquire_workspace_write_journal_lock(
    receipt_store: &ArtifactStore,
) -> Result<WorkspaceWriteJournalLock, WorkspaceWriteError> {
    let guard = JOURNAL_MUTEX
        .lock()
        .map_err(|_| WorkspaceWriteError::Journal("journal mutex is poisoned".into()))?;
    let directory = journal_directory(receipt_store)?;
    let path = directory.join(".lock");
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = options.open(&path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(WorkspaceWriteError::Journal(
            "journal lock must be a regular file".into(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 || metadata.mode() & 0o077 != 0 {
            return Err(WorkspaceWriteError::Journal(
                "journal lock permissions or link count are unsafe".into(),
            ));
        }
    }
    rustix::fs::flock(&file, rustix::fs::FlockOperation::LockExclusive)
        .map_err(|error| WorkspaceWriteError::Journal(format!("cannot lock journal: {error}")))?;
    Ok(WorkspaceWriteJournalLock {
        _file: file,
        _guard: guard,
    })
}

/// Opaque, cloneable capability for one write within one workspace scope.
///
/// Clones share the same one-use fence. Construct only after the caller has
/// revalidated the approved plan, task, role and current approval.
#[derive(Clone)]
pub struct WorkspaceWriteCapability {
    root: PathBuf,
    #[cfg(unix)]
    root_identity: (u64, u64),
    scope: PathBuf,
    job_id: String,
    task_id: String,
    plan_hash: String,
    patch_id: String,
    expires_at_unix_ms: u64,
    consumed: Arc<AtomicBool>,
}

struct CheckedTarget {
    #[cfg(not(target_os = "linux"))]
    path: PathBuf,
    parent: Option<File>,
    #[cfg(target_os = "linux")]
    root: Option<File>,
    #[cfg(not(target_os = "linux"))]
    file_name: OsString,
}

impl WorkspaceWriteCapability {
    /// Issue a capability from already-verified workflow claims.
    ///
    /// `scope` is a non-empty workspace-relative directory. Expiry must be in
    /// the future at use time. The caller owns approval and plan verification.
    pub fn issue(
        workspace_root: impl AsRef<Path>,
        scope: impl AsRef<Path>,
        job_id: impl Into<String>,
        task_id: impl Into<String>,
        plan_hash: impl Into<String>,
        patch_id: impl Into<String>,
        expires_at_unix_ms: u64,
    ) -> Result<Self, WorkspaceWriteError> {
        let root = workspace_root.as_ref();
        let metadata = fs::symlink_metadata(root)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(WorkspaceWriteError::Policy(
                "workspace root must be a regular non-symlink directory".into(),
            ));
        }
        let root = fs::canonicalize(root)?;
        if root == Path::new("/") {
            return Err(WorkspaceWriteError::Policy(
                "workspace root cannot be filesystem root".into(),
            ));
        }
        #[cfg(unix)]
        let root_identity = {
            use std::os::unix::fs::MetadataExt;
            let metadata = fs::metadata(&root)?;
            (metadata.dev(), metadata.ino())
        };
        let scope = validate_relative(scope.as_ref(), "scope")?;
        let job_id = required_id(job_id.into(), "job_id")?;
        let task_id = required_id(task_id.into(), "task_id")?;
        let plan_hash = required_hash(plan_hash.into(), "plan_hash")?;
        let patch_id = required_id(patch_id.into(), "patch_id")?;
        Ok(Self {
            root,
            #[cfg(unix)]
            root_identity,
            scope,
            job_id,
            task_id,
            plan_hash,
            patch_id,
            expires_at_unix_ms,
            consumed: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Apply one file write and persist its immutable receipt artifact.
    ///
    /// A capability is consumed by the first valid-time attempt, including a
    /// denied path or stale base hash. Reissue only after the caller rechecks
    /// workflow authorization. `base_sha256` is a lowercase digest or `ABSENT`.
    pub fn apply_write(
        &self,
        path: impl AsRef<Path>,
        base_sha256: &str,
        content: &[u8],
        receipt_store: &ArtifactStore,
    ) -> Result<StoredWorkspaceWriteReceipt, WorkspaceWriteError> {
        let now = unix_time_ms()?;
        self.apply_write_at(path.as_ref(), base_sha256, content, receipt_store, now)
    }

    fn apply_write_at(
        &self,
        path: &Path,
        base_sha256: &str,
        content: &[u8],
        receipt_store: &ArtifactStore,
        now: u64,
    ) -> Result<StoredWorkspaceWriteReceipt, WorkspaceWriteError> {
        if now >= self.expires_at_unix_ms {
            return Err(WorkspaceWriteError::Policy(
                "workspace write capability expired".into(),
            ));
        }
        if self
            .consumed
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(WorkspaceWriteError::Policy(
                "workspace write capability already consumed".into(),
            ));
        }
        let _journal_lock = acquire_workspace_write_journal_lock(receipt_store)?;
        recover_workspace_write_journal_locked(&self.root, receipt_store)?;
        let path = validate_relative(path, "path")?;
        if !path.starts_with(&self.scope) {
            return Err(WorkspaceWriteError::Policy(
                "target path is outside capability scope".into(),
            ));
        }
        if content.len() > MAX_WRITE_BYTES {
            return Err(WorkspaceWriteError::Policy(
                "workspace write exceeds 2,000,000 byte limit".into(),
            ));
        }
        if base_sha256 != "ABSENT" && !valid_hash(base_sha256) {
            return Err(WorkspaceWriteError::Policy(
                "base_sha256 must be a lowercase SHA-256 digest or ABSENT".into(),
            ));
        }

        let target = self.checked_target(&path)?;
        #[cfg(target_os = "linux")]
        let before = read_workspace_relative_from_fd(
            target.root.as_ref().ok_or_else(|| {
                WorkspaceWriteError::Policy("workspace root descriptor is unavailable".into())
            })?,
            &path,
        )?;
        #[cfg(not(target_os = "linux"))]
        let before = read_regular_target(&target.path)?;
        let before_hash = before.as_deref().map(digest);
        if base_sha256 == "ABSENT" && before.is_some()
            || base_sha256 != "ABSENT" && before_hash.as_deref() != Some(base_sha256)
        {
            return Err(WorkspaceWriteError::Policy(
                "base SHA-256 precondition does not match current file".into(),
            ));
        }

        let after_hash = digest(content);
        let outcome = if before_hash.as_deref() == Some(after_hash.as_str()) {
            WorkspaceWriteOutcome::AlreadyPresent
        } else {
            WorkspaceWriteOutcome::from(before.is_some())
        };
        let request = serde_json::json!({
            "job_id": self.job_id,
            "task_id": self.task_id,
            "patch_id": self.patch_id,
            "path": path.to_string_lossy(),
            "base_sha256": base_sha256,
            "content_sha256": after_hash,
        });
        let request_hash = digest(&serde_json::to_vec(&request)?);
        let path_string = path.to_string_lossy().into_owned();
        let receipt_key = format!(
            "{}\0{}\0{}\0{}",
            self.job_id, self.task_id, self.patch_id, path_string
        );
        let receipt_id = format!("wwr_{}", &digest(receipt_key.as_bytes())[..32]);
        let receipt = WorkspaceWriteReceipt {
            receipt_id,
            job_id: self.job_id.clone(),
            task_id: self.task_id.clone(),
            plan_hash: self.plan_hash.clone(),
            patch_id: self.patch_id.clone(),
            request_hash,
            path: path_string.clone(),
            outcome,
            before_sha256: before_hash.unwrap_or_else(|| "ABSENT".into()),
            after_sha256: after_hash.clone(),
            size_bytes: content.len() as u64,
            created_at_unix_ms: now,
        };
        let bytes = serde_json::to_vec(&receipt)?;
        if outcome != WorkspaceWriteOutcome::AlreadyPresent {
            let (workspace_device, workspace_inode) = directory_identity(&self.root)?;
            persist_write_intent(
                receipt_store,
                &WorkspaceWriteIntent {
                    version: 1,
                    workspace_device,
                    workspace_inode,
                    path: path_string.clone(),
                    before_sha256: receipt.before_sha256.clone(),
                    after_sha256: receipt.after_sha256.clone(),
                    receipt_bytes: bytes.clone(),
                },
                &receipt.receipt_id,
            )?;
            self.atomic_replace(&target, content, &path, base_sha256, &after_hash)?;
        }
        let artifact = receipt_store
            .put(
                "application/vnd.runalith.workspace-write-receipt+json",
                &bytes,
            )
            .map_err(|source| WorkspaceWriteError::MutationUnreceipted {
                path: path_string,
                after_sha256: receipt.after_sha256.clone(),
                source,
            })?;
        if outcome != WorkspaceWriteOutcome::AlreadyPresent {
            remove_write_intent(receipt_store, &receipt.receipt_id)?;
        }
        Ok(StoredWorkspaceWriteReceipt { receipt, artifact })
    }

    fn checked_target(&self, relative: &Path) -> Result<CheckedTarget, WorkspaceWriteError> {
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::MetadataExt;
            let root_metadata = fs::symlink_metadata(&self.root)?;
            if root_metadata.file_type().is_symlink()
                || !root_metadata.is_dir()
                || fs::canonicalize(&self.root)? != self.root
            {
                return Err(WorkspaceWriteError::Policy(
                    "workspace root changed after capability issuance".into(),
                ));
            }
            if (root_metadata.dev(), root_metadata.ino()) != self.root_identity {
                return Err(WorkspaceWriteError::Policy(
                    "workspace root identity changed after capability issuance".into(),
                ));
            }
            let root = open_directory_fd(&self.root)?;
            let mut parent = root.try_clone()?;
            let opened_root = root.metadata()?;
            if (opened_root.dev(), opened_root.ino()) != self.root_identity {
                return Err(WorkspaceWriteError::Policy(
                    "workspace root identity changed while opening".into(),
                ));
            }
            let components: Vec<_> = relative.components().collect();
            for component in components.iter().take(components.len().saturating_sub(1)) {
                let Component::Normal(part) = component else {
                    return Err(WorkspaceWriteError::Policy(
                        "invalid target path component".into(),
                    ));
                };
                let child_path = fd_path(&parent).join(part);
                let metadata = fs::symlink_metadata(&child_path)?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(WorkspaceWriteError::Policy(
                        "workspace parent must be a regular non-symlink directory".into(),
                    ));
                }
                let child = open_directory_fd(&child_path)?;
                let opened = child.metadata()?;
                if (metadata.dev(), metadata.ino()) != (opened.dev(), opened.ino()) {
                    return Err(WorkspaceWriteError::Policy(
                        "workspace parent changed while opening".into(),
                    ));
                }
                parent = child;
            }
            let file_name = components
                .last()
                .ok_or_else(|| WorkspaceWriteError::Policy("target path is empty".into()))?
                .as_os_str()
                .to_os_string();
            let target = fd_path(&parent).join(&file_name);
            if let Ok(metadata) = fs::symlink_metadata(&target) {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(WorkspaceWriteError::Policy(
                        "workspace target must be a regular non-symlink file".into(),
                    ));
                }
            }
            Ok(CheckedTarget {
                parent: Some(parent),
                root: Some(root),
            })
        }
        #[cfg(not(target_os = "linux"))]
        {
            let root_metadata = fs::symlink_metadata(&self.root)?;
            if root_metadata.file_type().is_symlink()
                || !root_metadata.is_dir()
                || fs::canonicalize(&self.root)? != self.root
            {
                return Err(WorkspaceWriteError::Policy(
                    "workspace root changed after capability issuance".into(),
                ));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if (root_metadata.dev(), root_metadata.ino()) != self.root_identity {
                    return Err(WorkspaceWriteError::Policy(
                        "workspace root identity changed after capability issuance".into(),
                    ));
                }
            }
            let mut cursor = self.root.clone();
            let components: Vec<_> = relative.components().collect();
            for component in components.iter().take(components.len().saturating_sub(1)) {
                let Component::Normal(part) = component else {
                    return Err(WorkspaceWriteError::Policy(
                        "invalid target path component".into(),
                    ));
                };
                cursor.push(part);
                let metadata = fs::symlink_metadata(&cursor)?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(WorkspaceWriteError::Policy(
                        "workspace parent must be a regular non-symlink directory".into(),
                    ));
                }
                let canonical = fs::canonicalize(&cursor)?;
                if !canonical.starts_with(&self.root) {
                    return Err(WorkspaceWriteError::Policy(
                        "workspace parent escapes capability root".into(),
                    ));
                }
            }
            cursor.push(
                components
                    .last()
                    .ok_or_else(|| WorkspaceWriteError::Policy("target path is empty".into()))?
                    .as_os_str(),
            );
            if let Ok(metadata) = fs::symlink_metadata(&cursor) {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(WorkspaceWriteError::Policy(
                        "workspace target must be a regular non-symlink file".into(),
                    ));
                }
            }
            let file_name = cursor
                .file_name()
                .ok_or_else(|| WorkspaceWriteError::Policy("target path is empty".into()))?
                .to_os_string();
            Ok(CheckedTarget {
                path: cursor,
                parent: None,
                #[cfg(target_os = "linux")]
                root: None,
                file_name,
            })
        }
    }

    fn atomic_replace(
        &self,
        target: &CheckedTarget,
        content: &[u8],
        relative: &Path,
        expected_before_sha256: &str,
        after_sha256: &str,
    ) -> Result<(), WorkspaceWriteError> {
        #[cfg(target_os = "linux")]
        {
            self.atomic_replace_linux(
                target,
                content,
                relative,
                expected_before_sha256,
                after_sha256,
            )
        }
        #[cfg(not(target_os = "linux"))]
        {
            let parent_path = target
                .parent
                .as_ref()
                .map(fd_path)
                .or_else(|| target.path.parent().map(Path::to_path_buf))
                .ok_or_else(|| {
                    WorkspaceWriteError::Policy("workspace target has no parent directory".into())
                })?;
            let stable_target = parent_path.join(&target.file_name);
            let temp = parent_path.join(format!(".runalith-write-{}", Uuid::new_v4().simple()));
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temp)?;
            if let Err(error) = file.write_all(content).and_then(|()| file.sync_all()) {
                drop(file);
                let _ = fs::remove_file(&temp);
                return Err(WorkspaceWriteError::Io(error));
            }
            drop(file);
            let current = read_regular_target(&stable_target)?;
            let current_hash = current.as_deref().map(digest);
            if expected_before_sha256 == "ABSENT" && current.is_some()
                || expected_before_sha256 != "ABSENT"
                    && current_hash.as_deref() != Some(expected_before_sha256)
            {
                let _ = fs::remove_file(&temp);
                return Err(WorkspaceWriteError::Policy(
                    "base SHA-256 precondition changed before atomic replacement".into(),
                ));
            }
            if let Some(pinned_parent) = target.parent.as_ref() {
                // A pinned directory descriptor preserves inode identity, but the
                // directory can be renamed and its former pathname replaced. Make
                // that deterministic substitution fail closed before rename.
                // This remains a pathname check, not a kernel-enforced guarantee:
                // a hostile concurrent rename can still race this check.
                let requested_parent = relative
                    .parent()
                    .filter(|parent| !parent.as_os_str().is_empty())
                    .map(|parent| self.root.join(parent))
                    .ok_or_else(|| {
                        WorkspaceWriteError::Policy(
                            "workspace target has no relative parent".into(),
                        )
                    })?;
                let requested_metadata = fs::symlink_metadata(&requested_parent)?;
                let pinned_metadata = pinned_parent.metadata()?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    if requested_metadata.file_type().is_symlink()
                        || !requested_metadata.is_dir()
                        || (requested_metadata.dev(), requested_metadata.ino())
                            != (pinned_metadata.dev(), pinned_metadata.ino())
                    {
                        let _ = fs::remove_file(&temp);
                        return Err(WorkspaceWriteError::Policy(
                            "workspace parent was replaced after target validation".into(),
                        ));
                    }
                }
                let canonical_parent = fs::canonicalize(&parent_path)?;
                if !canonical_parent.starts_with(&self.root) {
                    let _ = fs::remove_file(&temp);
                    return Err(WorkspaceWriteError::Policy(
                        "workspace parent moved outside capability root".into(),
                    ));
                }
            }
            // Test-only deterministic interleaving point. It runs after the final
            // pathname/inode check and before rename, allowing adversarial tests
            // to prove whether the pinned parent can move in this interval.
            #[cfg(test)]
            run_before_workspace_rename_test_hook();

            if let Err(error) = fs::rename(&temp, &stable_target) {
                let _ = fs::remove_file(&temp);
                return Err(WorkspaceWriteError::Io(error));
            }
            let sync_result = if let Some(parent) = &target.parent {
                parent.sync_all()
            } else {
                File::open(&parent_path).and_then(|directory| directory.sync_all())
            };
            sync_result.map_err(|error| WorkspaceWriteError::MutationUncertain {
                path: relative.to_string_lossy().into_owned(),
                after_sha256: after_sha256.into(),
                message: error.to_string(),
            })?;
            Ok(())
        }
    }

    #[cfg(target_os = "linux")]
    fn atomic_replace_linux(
        &self,
        target: &CheckedTarget,
        content: &[u8],
        relative: &Path,
        expected_before_sha256: &str,
        after_sha256: &str,
    ) -> Result<(), WorkspaceWriteError> {
        use rustix::fs::{Mode, OFlags, ResolveFlags};
        use std::{io, os::fd::AsFd};

        let root = target.root.as_ref().ok_or_else(|| {
            WorkspaceWriteError::Policy("workspace root descriptor is unavailable".into())
        })?;
        let temp_name = format!(".runalith-write-{}", Uuid::new_v4().simple());
        let resolve =
            ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS;
        let temp_fd = rustix::fs::openat2(
            root,
            &temp_name,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::from_raw_mode(0o600),
            resolve,
        )
        .map_err(io::Error::from)?;
        let mut file = File::from(temp_fd);
        if let Err(error) = file.write_all(content).and_then(|()| file.sync_all()) {
            drop(file);
            let _ = rustix::fs::unlinkat(root, &temp_name, rustix::fs::AtFlags::empty());
            return Err(WorkspaceWriteError::Io(error));
        }
        drop(file);

        let current = match read_workspace_relative_from_fd(root, relative) {
            Ok(current) => current,
            Err(error) => {
                let _ = rustix::fs::unlinkat(root, &temp_name, rustix::fs::AtFlags::empty());
                return Err(error);
            }
        };
        let current_hash = current.as_deref().map(digest);
        if expected_before_sha256 == "ABSENT" && current.is_some()
            || expected_before_sha256 != "ABSENT"
                && current_hash.as_deref() != Some(expected_before_sha256)
        {
            let _ = rustix::fs::unlinkat(root, &temp_name, rustix::fs::AtFlags::empty());
            return Err(WorkspaceWriteError::Policy(
                "base SHA-256 precondition changed before atomic replacement".into(),
            ));
        }

        // Test-only interleaving point is deliberately before the final
        // root-relative parent resolution. A parent moved outside the root
        // during this window must become unreachable from the pinned root FD.
        #[cfg(test)]
        run_before_workspace_rename_test_hook();

        if let Some(pinned_parent) = target.parent.as_ref() {
            let parent_relative = relative
                .parent()
                .filter(|path| !path.as_os_str().is_empty());
            if let Some(parent_relative) = parent_relative {
                let current_parent = rustix::fs::openat2(
                    root,
                    parent_relative,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                    Mode::empty(),
                    resolve,
                )
                .map_err(|error| {
                    let _ = rustix::fs::unlinkat(root, &temp_name, rustix::fs::AtFlags::empty());
                    WorkspaceWriteError::Policy(format!(
                        "workspace parent moved or was replaced before atomic replacement: {error}"
                    ))
                })?;
                let current_parent = File::from(current_parent);
                let pinned_metadata = pinned_parent.metadata()?;
                let current_metadata = current_parent.metadata()?;
                use std::os::unix::fs::MetadataExt;
                if (pinned_metadata.dev(), pinned_metadata.ino())
                    != (current_metadata.dev(), current_metadata.ino())
                {
                    let _ = rustix::fs::unlinkat(root, &temp_name, rustix::fs::AtFlags::empty());
                    return Err(WorkspaceWriteError::Policy(
                        "workspace parent moved or was replaced before atomic replacement".into(),
                    ));
                }
            }
        }

        // Exercise the narrower post-resolution window independently. The
        // publication below uses the already pinned parent descriptor rather
        // than resolving `relative` a second time, so a replacement symlink
        // cannot redirect the destination pathname.
        #[cfg(test)]
        run_after_workspace_parent_resolution_test_hook();

        // The source temporary is anchored at the capability root. Publish
        // through the exact parent directory FD validated above and a single
        // basename. Do not pass the multi-component target path to renameat:
        // renameat has no openat2 RESOLVE_BENEATH flags and would resolve any
        // replacement symlink in an intermediate component.
        let pinned_parent = target.parent.as_ref().ok_or_else(|| {
            WorkspaceWriteError::Policy("workspace parent descriptor is unavailable".into())
        })?;
        let target_name = relative.file_name().ok_or_else(|| {
            WorkspaceWriteError::Policy("workspace target has no file name".into())
        })?;
        if let Err(error) =
            rustix::fs::renameat(root.as_fd(), &temp_name, pinned_parent.as_fd(), target_name)
        {
            let _ = rustix::fs::unlinkat(root, &temp_name, rustix::fs::AtFlags::empty());
            return Err(WorkspaceWriteError::Io(io::Error::from(error)));
        }

        // Sync the directory inode actually used for publication, even if an
        // external actor concurrently changed its pathname.
        pinned_parent
            .sync_all()
            .map_err(|error| WorkspaceWriteError::MutationUncertain {
                path: relative.to_string_lossy().into_owned(),
                after_sha256: after_sha256.into(),
                message: error.to_string(),
            })?;

        // If the parent moved after it was pinned, publication is anchored to
        // that original directory inode and did not follow the replacement
        // pathname. The durable intent remains for operator/recovery handling;
        // do not issue a receipt for a pathname whose binding changed.
        if let Some(parent_relative) = relative
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
        {
            let current_parent = rustix::fs::openat2(
                root,
                parent_relative,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::empty(),
                resolve,
            );
            let current_parent = match current_parent {
                Ok(parent) => File::from(parent),
                Err(error) => {
                    return Err(WorkspaceWriteError::MutationUncertain {
                        path: relative.to_string_lossy().into_owned(),
                        after_sha256: after_sha256.into(),
                        message: format!(
                            "workspace parent changed after descriptor-anchored publication: {error}"
                        ),
                    });
                }
            };
            use std::os::unix::fs::MetadataExt;
            let pinned_metadata = pinned_parent.metadata()?;
            let current_metadata = current_parent.metadata()?;
            if (pinned_metadata.dev(), pinned_metadata.ino())
                != (current_metadata.dev(), current_metadata.ino())
            {
                return Err(WorkspaceWriteError::MutationUncertain {
                    path: relative.to_string_lossy().into_owned(),
                    after_sha256: after_sha256.into(),
                    message:
                        "workspace parent identity changed after descriptor-anchored publication"
                            .into(),
                });
            }
        } else {
            root.sync_all()
                .map_err(|error| WorkspaceWriteError::MutationUncertain {
                    path: relative.to_string_lossy().into_owned(),
                    after_sha256: after_sha256.into(),
                    message: error.to_string(),
                })?;
        }
        Ok(())
    }
}

impl WorkspaceWriteOutcome {
    fn from(existed: bool) -> Self {
        if existed {
            Self::Replaced
        } else {
            Self::Created
        }
    }
}

fn journal_directory(receipt_store: &ArtifactStore) -> Result<PathBuf, WorkspaceWriteError> {
    let root = receipt_store.root_path();
    let directory = root.join("workspace-write-journal");
    match fs::create_dir(&directory) {
        Ok(()) => File::open(root)?.sync_all()?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(WorkspaceWriteError::Io(error)),
    }
    let metadata = fs::symlink_metadata(&directory)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(WorkspaceWriteError::Journal(
            "journal directory must be a regular non-symlink directory".into(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    }
    Ok(directory)
}

fn persist_write_intent(
    receipt_store: &ArtifactStore,
    intent: &WorkspaceWriteIntent,
    receipt_id: &str,
) -> Result<(), WorkspaceWriteError> {
    if !receipt_id.starts_with("wwr_")
        || receipt_id.len() != 36
        || !receipt_id[4..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(WorkspaceWriteError::Journal(
            "receipt identity is invalid for journal filename".into(),
        ));
    }
    let directory = journal_directory(receipt_store)?;
    let destination = directory.join(format!("{receipt_id}.json"));
    let bytes = serde_json::to_vec(intent)?;
    if let Ok(metadata) = fs::symlink_metadata(&destination) {
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || fs::read(&destination)? != bytes
        {
            return Err(WorkspaceWriteError::Journal(
                "existing journal entry conflicts with exact write intent".into(),
            ));
        }
        return Ok(());
    }
    let temporary = directory.join(format!(".intent-{}.tmp", Uuid::new_v4().simple()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    if let Err(error) = file.write_all(&bytes).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&temporary);
        return Err(WorkspaceWriteError::Io(error));
    }
    drop(file);
    match fs::hard_link(&temporary, &destination) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if fs::read(&destination)? != bytes {
                let _ = fs::remove_file(&temporary);
                return Err(WorkspaceWriteError::Journal(
                    "concurrent journal entry conflicts with exact write intent".into(),
                ));
            }
        }
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            return Err(WorkspaceWriteError::Io(error));
        }
    }
    fs::remove_file(&temporary)?;
    File::open(&directory)?.sync_all()?;
    Ok(())
}

fn remove_write_intent(
    receipt_store: &ArtifactStore,
    receipt_id: &str,
) -> Result<(), WorkspaceWriteError> {
    let directory = journal_directory(receipt_store)?;
    let path = directory.join(format!("{receipt_id}.json"));
    match fs::remove_file(path) {
        Ok(()) => File::open(&directory)?.sync_all()?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(WorkspaceWriteError::Io(error)),
    }
    Ok(())
}

fn directory_identity(path: &Path) -> Result<(u64, u64), WorkspaceWriteError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::metadata(path)?;
        Ok((metadata.dev(), metadata.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok((0, 0))
    }
}

fn read_workspace_relative(
    workspace_root: &Path,
    relative: &Path,
) -> Result<Option<Vec<u8>>, WorkspaceWriteError> {
    #[cfg(target_os = "linux")]
    {
        let root = open_directory_fd(workspace_root)?;
        read_workspace_relative_from_fd(&root, relative)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let target = workspace_root.join(relative);
        read_regular_target(&target)
    }
}

#[cfg(target_os = "linux")]
fn read_workspace_relative_from_fd(
    root: &File,
    relative: &Path,
) -> Result<Option<Vec<u8>>, WorkspaceWriteError> {
    use rustix::fs::{Mode, OFlags, ResolveFlags};
    use std::io;

    let file_fd = match rustix::fs::openat2(
        root,
        relative,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
        ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
    ) {
        Ok(file) => file,
        Err(error) if error == rustix::io::Errno::NOENT => return Ok(None),
        Err(error)
            if error == rustix::io::Errno::LOOP
                || error == rustix::io::Errno::NOTDIR
                || error == rustix::io::Errno::XDEV =>
        {
            return Err(WorkspaceWriteError::Policy(format!(
                "workspace target path became unsafe or escaped its root: {error}"
            )));
        }
        Err(error) => return Err(WorkspaceWriteError::Io(io::Error::from(error))),
    };
    let mut file = File::from(file_fd);
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_WRITE_BYTES as u64 {
        return Err(WorkspaceWriteError::Policy(
            "workspace target must be a bounded regular non-symlink file".into(),
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if (metadata.dev(), metadata.ino(), metadata.len())
            != (after.dev(), after.ino(), after.len())
        {
            return Err(WorkspaceWriteError::Policy(
                "workspace target changed while reading".into(),
            ));
        }
    }
    if bytes.len() > MAX_WRITE_BYTES {
        return Err(WorkspaceWriteError::Policy(
            "workspace target changed while reading".into(),
        ));
    }
    Ok(Some(bytes))
}

fn validate_relative(path: &Path, label: &str) -> Result<PathBuf, WorkspaceWriteError> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.to_str().is_none()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(WorkspaceWriteError::Policy(format!(
            "{label} must be a non-empty relative path without dot, parent or root components"
        )));
    }
    Ok(path.to_path_buf())
}

fn required_id(value: String, label: &str) -> Result<String, WorkspaceWriteError> {
    if value.trim().is_empty() || value.len() > MAX_ID_BYTES || value.contains('\0') {
        return Err(WorkspaceWriteError::Policy(format!("{label} is invalid")));
    }
    Ok(value)
}

fn required_hash(value: String, label: &str) -> Result<String, WorkspaceWriteError> {
    if !valid_hash(&value) {
        return Err(WorkspaceWriteError::Policy(format!(
            "{label} must be a lowercase SHA-256 digest"
        )));
    }
    Ok(value)
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(not(target_os = "linux"))]
fn read_regular_target(path: &Path) -> Result<Option<Vec<u8>>, WorkspaceWriteError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(WorkspaceWriteError::Policy(
                    "workspace target must be a regular non-symlink file".into(),
                ));
            }
            if metadata.len() > MAX_WRITE_BYTES as u64 {
                return Err(WorkspaceWriteError::Policy(
                    "existing workspace file exceeds write size limit".into(),
                ));
            }
            #[cfg(target_os = "linux")]
            {
                use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
                let mut options = OpenOptions::new();
                options
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
                let mut file = options.open(path)?;
                let opened = file.metadata()?;
                if (metadata.dev(), metadata.ino()) != (opened.dev(), opened.ino()) {
                    return Err(WorkspaceWriteError::Policy(
                        "workspace target changed while opening".into(),
                    ));
                }
                let mut bytes = Vec::with_capacity(metadata.len() as usize);
                file.read_to_end(&mut bytes)?;
                let after = file.metadata()?;
                if (opened.dev(), opened.ino(), opened.len())
                    != (after.dev(), after.ino(), after.len())
                    || bytes.len() > MAX_WRITE_BYTES
                {
                    return Err(WorkspaceWriteError::Policy(
                        "workspace target changed while reading".into(),
                    ));
                }
                Ok(Some(bytes))
            }
            #[cfg(not(target_os = "linux"))]
            {
                Ok(Some(fs::read(path)?))
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(WorkspaceWriteError::Io(error)),
    }
}

#[cfg(target_os = "linux")]
fn open_directory_fd(path: &Path) -> Result<File, WorkspaceWriteError> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let directory = options.open(path)?;
    if !directory.metadata()?.is_dir() {
        return Err(WorkspaceWriteError::Policy(
            "workspace parent is not a directory".into(),
        ));
    }
    Ok(directory)
}

#[cfg(target_os = "linux")]
fn fd_path(file: &File) -> PathBuf {
    use std::os::fd::AsRawFd;
    PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()))
}

fn unix_time_ms() -> Result<u64, WorkspaceWriteError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| WorkspaceWriteError::Clock)?
        .as_millis();
    u64::try_from(millis).map_err(|_| WorkspaceWriteError::Clock)
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
thread_local! {
    static BEFORE_WORKSPACE_RENAME_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn run_before_workspace_rename_test_hook() {
    BEFORE_WORKSPACE_RENAME_TEST_HOOK.with(|hook| {
        if let Some(hook) = hook.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(test)]
thread_local! {
    static AFTER_WORKSPACE_PARENT_RESOLUTION_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn run_after_workspace_parent_resolution_test_hook() {
    AFTER_WORKSPACE_PARENT_RESOLUTION_TEST_HOOK.with(|hook| {
        if let Some(hook) = hook.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn capability(root: &Path, scope: &str, expires: u64) -> WorkspaceWriteCapability {
        WorkspaceWriteCapability::issue(
            root,
            scope,
            "job-1",
            "task-1",
            "a".repeat(64),
            "patch-1",
            expires,
        )
        .unwrap()
    }

    fn stores(root: &Path) -> ArtifactStore {
        ArtifactStore::open_or_create(root.join("receipts")).unwrap()
    }

    fn recovery_receipt(path: &str, before: &str, after: &str) -> WorkspaceWriteReceipt {
        let receipt_key = format!("job-1\0task-1\0patch-1\0{path}");
        WorkspaceWriteReceipt {
            receipt_id: format!("wwr_{}", &digest(receipt_key.as_bytes())[..32]),
            job_id: "job-1".into(),
            task_id: "task-1".into(),
            plan_hash: "b".repeat(64),
            patch_id: "patch-1".into(),
            request_hash: "c".repeat(64),
            path: path.into(),
            outcome: WorkspaceWriteOutcome::Replaced,
            before_sha256: before.into(),
            after_sha256: after.into(),
            size_bytes: 3,
            created_at_unix_ms: 1,
        }
    }

    fn persist_recovery_fixture(
        workspace: &Path,
        store: &ArtifactStore,
        receipt: &WorkspaceWriteReceipt,
    ) {
        let bytes = serde_json::to_vec(receipt).unwrap();
        let (workspace_device, workspace_inode) = directory_identity(workspace).unwrap();
        persist_write_intent(
            store,
            &WorkspaceWriteIntent {
                version: 1,
                workspace_device,
                workspace_inode,
                path: receipt.path.clone(),
                before_sha256: receipt.before_sha256.clone(),
                after_sha256: receipt.after_sha256.clone(),
                receipt_bytes: bytes,
            },
            &receipt.receipt_id,
        )
        .unwrap();
    }

    #[test]
    fn recovery_discards_intent_when_crash_preceded_workspace_mutation() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(workspace.join("src/main.rs"), b"old").unwrap();
        let store = stores(directory.path());
        let receipt = recovery_receipt("src/main.rs", &digest(b"old"), &digest(b"new"));
        persist_recovery_fixture(&workspace, &store, &receipt);

        let report = recover_workspace_write_journal(&workspace, &store).unwrap();
        assert_eq!(report.unapplied_intents_discarded, 1);
        assert_eq!(report.receipts_recovered, 0);
        assert_eq!(fs::read(workspace.join("src/main.rs")).unwrap(), b"old");
        assert!(
            !journal_directory(&store)
                .unwrap()
                .join(format!("{}.json", receipt.receipt_id))
                .exists()
        );
    }

    #[test]
    fn recovery_persists_receipt_after_crash_between_mutation_and_receipt_commit() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(workspace.join("src/main.rs"), b"old").unwrap();
        let store = stores(directory.path());
        let receipt = recovery_receipt("src/main.rs", &digest(b"old"), &digest(b"new"));
        persist_recovery_fixture(&workspace, &store, &receipt);

        // Simulate process death after durable rename/fsync but before ArtifactStore::put.
        fs::write(workspace.join("src/main.rs"), b"new").unwrap();
        File::open(workspace.join("src"))
            .unwrap()
            .sync_all()
            .unwrap();
        let report = recover_workspace_write_journal(&workspace, &store).unwrap();
        assert_eq!(report.receipts_recovered, 1);
        assert_eq!(report.unapplied_intents_discarded, 0);
        let receipt_bytes = serde_json::to_vec(&receipt).unwrap();
        let artifact = store
            .put(
                "application/vnd.runalith.workspace-write-receipt+json",
                &receipt_bytes,
            )
            .unwrap();
        assert_eq!(store.read(&artifact).unwrap(), receipt_bytes);
        assert!(
            !journal_directory(&store)
                .unwrap()
                .join(format!("{}.json", receipt.receipt_id))
                .exists()
        );
    }

    #[test]
    fn recovery_is_idempotent_after_receipt_commit_before_journal_cleanup() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(workspace.join("src/main.rs"), b"new").unwrap();
        let store = stores(directory.path());
        let receipt = recovery_receipt("src/main.rs", &digest(b"old"), &digest(b"new"));
        persist_recovery_fixture(&workspace, &store, &receipt);
        let receipt_bytes = serde_json::to_vec(&receipt).unwrap();
        let first = store
            .put(
                "application/vnd.runalith.workspace-write-receipt+json",
                &receipt_bytes,
            )
            .unwrap();

        let report = recover_workspace_write_journal(&workspace, &store).unwrap();
        assert_eq!(report.receipts_recovered, 1);
        let second = store
            .put(
                "application/vnd.runalith.workspace-write-receipt+json",
                &receipt_bytes,
            )
            .unwrap();
        assert_eq!(first, second);
        assert!(
            !journal_directory(&store)
                .unwrap()
                .join(format!("{}.json", receipt.receipt_id))
                .exists()
        );
    }

    #[test]
    fn concurrent_recovery_cannot_discard_an_inflight_write_intent() {
        use std::{sync::mpsc, thread, time::Duration};

        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(workspace.join("src/main.rs"), b"old").unwrap();
        let store = stores(directory.path());
        let receipt = recovery_receipt("src/main.rs", &digest(b"old"), &digest(b"new"));
        persist_recovery_fixture(&workspace, &store, &receipt);

        // Simulate writer A holding the same lock from durable intent through
        // mutation. Recovery in writer B must wait rather than discard the
        // intent while the target still has its before-hash.
        let writer_lock = acquire_workspace_write_journal_lock(&store).unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let workspace_for_recovery = workspace.clone();
        let receipt_root = directory.path().join("receipts");
        let recovery_thread = thread::spawn(move || {
            let recovery_store = ArtifactStore::open_or_create(receipt_root).unwrap();
            started_tx.send(()).unwrap();
            let report = recover_workspace_write_journal(&workspace_for_recovery, &recovery_store);
            done_tx.send(report).unwrap();
        });
        started_rx.recv().unwrap();
        assert!(done_rx.recv_timeout(Duration::from_millis(50)).is_err());

        fs::write(workspace.join("src/main.rs"), b"new").unwrap();
        File::open(workspace.join("src"))
            .unwrap()
            .sync_all()
            .unwrap();
        drop(writer_lock);

        let report = done_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        recovery_thread.join().unwrap();
        assert_eq!(report.receipts_recovered, 1);
        assert_eq!(report.unapplied_intents_discarded, 0);
        assert_eq!(fs::read(workspace.join("src/main.rs")).unwrap(), b"new");
        let receipt_bytes = serde_json::to_vec(&receipt).unwrap();
        let artifact = store
            .put(
                "application/vnd.runalith.workspace-write-receipt+json",
                &receipt_bytes,
            )
            .unwrap();
        assert_eq!(store.read(&artifact).unwrap(), receipt_bytes);
    }

    #[test]
    fn journal_lock_child_process_probe() {
        let (Ok(receipt_root), Ok(marker)) = (
            std::env::var("RUNALITH_WORKSPACE_JOURNAL_PROBE_ROOT"),
            std::env::var("RUNALITH_WORKSPACE_JOURNAL_PROBE_MARKER"),
        ) else {
            return;
        };
        let store = ArtifactStore::open_or_create(receipt_root).unwrap();
        fs::write(format!("{marker}.attempted"), b"attempted").unwrap();
        let _lock = acquire_workspace_write_journal_lock(&store).unwrap();
        fs::write(marker, b"acquired").unwrap();
    }

    #[test]
    fn journal_lock_serializes_recovery_across_processes() {
        use std::{
            process::Command,
            thread,
            time::{Duration, Instant},
        };

        let directory = tempfile::tempdir().unwrap();
        let store = stores(directory.path());
        let receipt_root = directory.path().join("receipts");
        let marker = directory.path().join("journal-lock-acquired");
        let lock = acquire_workspace_write_journal_lock(&store).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "workspace_write::tests::journal_lock_child_process_probe",
                "--nocapture",
            ])
            .env("RUNALITH_WORKSPACE_JOURNAL_PROBE_ROOT", &receipt_root)
            .env("RUNALITH_WORKSPACE_JOURNAL_PROBE_MARKER", &marker)
            .spawn()
            .unwrap();

        let attempted = PathBuf::from(format!("{}.attempted", marker.display()));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !attempted.exists() {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("journal lock probe exited before attempting lock: {status}");
            }
            assert!(
                Instant::now() < deadline,
                "journal lock child did not start"
            );
            thread::sleep(Duration::from_millis(10));
        }
        assert!(!marker.exists(), "child acquired lock while parent held it");
        drop(lock);

        let status = child.wait().unwrap();
        assert!(status.success(), "journal lock child failed: {status}");
        assert_eq!(fs::read(marker).unwrap(), b"acquired");
    }

    #[test]
    fn recovery_quarantines_unexpected_workspace_state_without_deleting_intent() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(workspace.join("src/main.rs"), b"third-state").unwrap();
        let store = stores(directory.path());
        let receipt = recovery_receipt("src/main.rs", &digest(b"old"), &digest(b"new"));
        persist_recovery_fixture(&workspace, &store, &receipt);

        assert!(matches!(
            recover_workspace_write_journal(&workspace, &store),
            Err(WorkspaceWriteError::RecoveryConflict { .. })
        ));
        assert!(
            journal_directory(&store)
                .unwrap()
                .join(format!("{}.json", receipt.receipt_id))
                .exists()
        );
    }

    #[test]
    fn writes_only_within_scope_and_persists_content_addressed_receipt() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        fs::create_dir_all(workspace.join("src")).unwrap();
        let store = stores(directory.path());
        let capability = capability(&workspace, "src", u64::MAX);
        let stored = capability
            .apply_write("src/main.rs", "ABSENT", b"fn main() {}\n", &store)
            .unwrap();

        assert_eq!(
            fs::read(workspace.join("src/main.rs")).unwrap(),
            b"fn main() {}\n"
        );
        assert_eq!(stored.receipt.outcome, WorkspaceWriteOutcome::Created);
        assert_eq!(stored.receipt.before_sha256, "ABSENT");
        assert_eq!(stored.receipt.after_sha256, digest(b"fn main() {}\n"));
        assert_eq!(
            stored.artifact.sha256,
            digest(&store.read(&stored.artifact).unwrap())
        );
        assert_eq!(
            stored.artifact.byte_len,
            store.read(&stored.artifact).unwrap().len() as u64
        );
    }

    #[test]
    fn rejects_parent_absolute_and_out_of_scope_paths() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        fs::create_dir_all(workspace.join("src")).unwrap();
        let store = stores(directory.path());
        for path in [
            "../outside",
            "/etc/passwd",
            "other/file",
            "src/../../outside",
        ] {
            let capability = capability(&workspace, "src", u64::MAX);
            assert!(
                matches!(
                    capability.apply_write(path, "ABSENT", b"x", &store),
                    Err(WorkspaceWriteError::Policy(_))
                ),
                "must reject {path}"
            );
        }
        assert!(!directory.path().join("outside").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_parent_and_symlink_target() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        let outside = directory.path().join("outside");
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("target.txt"), b"safe").unwrap();
        symlink(&outside, workspace.join("src/link-dir")).unwrap();
        symlink(outside.join("target.txt"), workspace.join("src/link-file")).unwrap();
        let store = stores(directory.path());

        let parent_capability = capability(&workspace, "src", u64::MAX);
        assert!(matches!(
            parent_capability.apply_write("src/link-dir/escape.txt", "ABSENT", b"bad", &store),
            Err(WorkspaceWriteError::Policy(_))
        ));
        let target_capability = capability(&workspace, "src", u64::MAX);
        assert!(matches!(
            target_capability.apply_write("src/link-file", "ABSENT", b"bad", &store),
            Err(WorkspaceWriteError::Policy(_))
        ));
        assert_eq!(fs::read(outside.join("target.txt")).unwrap(), b"safe");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn stable_parent_handle_rejects_parent_moved_outside_capability_root() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        let source_parent = workspace.join("src");
        let outside = directory.path().join("outside");
        fs::create_dir_all(&source_parent).unwrap();
        let capability = capability(&workspace, "src", u64::MAX);
        let target = capability.checked_target(Path::new("src/main.rs")).unwrap();
        fs::rename(&source_parent, &outside).unwrap();
        symlink(&outside, &source_parent).unwrap();
        let error = capability
            .atomic_replace(
                &target,
                b"outside",
                Path::new("src/main.rs"),
                "ABSENT",
                &digest(b"outside"),
            )
            .unwrap_err();
        assert!(
            matches!(
                error,
                WorkspaceWriteError::Policy(ref message)
                if message.contains("moved outside")
                    || message.contains("replaced")
                    || message.contains("unsafe or escaped its root")
            ),
            "unexpected parent-move error: {error:?}"
        );
        assert!(!outside.join("main.rs").exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rejects_parent_directory_replacement_after_target_validation() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        let source_parent = workspace.join("src");
        let replacement = directory.path().join("replacement");
        fs::create_dir_all(&source_parent).unwrap();
        fs::create_dir_all(&replacement).unwrap();
        let capability = capability(&workspace, "src", u64::MAX);
        let target = capability.checked_target(Path::new("src/main.rs")).unwrap();

        fs::rename(&source_parent, workspace.join("src-original")).unwrap();
        symlink(&replacement, &source_parent).unwrap();

        let error = capability
            .atomic_replace(
                &target,
                b"must-not-write",
                Path::new("src/main.rs"),
                "ABSENT",
                &digest(b"must-not-write"),
            )
            .unwrap_err();
        assert!(
            matches!(error, WorkspaceWriteError::Policy(ref message) if
                message.contains("replaced") || message.contains("unsafe or escaped its root")),
            "unexpected parent-replacement error: {error:?}"
        );
        assert!(!replacement.join("main.rs").exists());
        assert!(!workspace.join("src-original/main.rs").exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn workspace_write_child_parent_replacement_probe() {
        let (Ok(workspace), Ok(ready), Ok(proceed), Ok(result)) = (
            std::env::var("RUNALITH_WORKSPACE_RACE_ROOT"),
            std::env::var("RUNALITH_WORKSPACE_RACE_READY"),
            std::env::var("RUNALITH_WORKSPACE_RACE_PROCEED"),
            std::env::var("RUNALITH_WORKSPACE_RACE_RESULT"),
        ) else {
            return;
        };
        let workspace = PathBuf::from(workspace);
        let capability = capability(&workspace, "src", u64::MAX);
        let target = capability
            .checked_target(Path::new("src/child-output.txt"))
            .unwrap();
        BEFORE_WORKSPACE_RENAME_TEST_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                fs::write(&ready, b"ready").unwrap();
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                while !Path::new(&proceed).exists() {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "parent process did not release the workspace race probe"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            }));
        });
        let error = capability
            .atomic_replace(
                &target,
                b"must-not-escape-process-boundary",
                Path::new("src/child-output.txt"),
                "ABSENT",
                &digest(b"must-not-escape-process-boundary"),
            )
            .unwrap_err();
        assert!(matches!(error, WorkspaceWriteError::Policy(_)));
        fs::write(result, b"rejected").unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn separate_process_parent_replacement_cannot_redirect_workspace_write() {
        use std::{
            process::Command,
            thread,
            time::{Duration, Instant},
        };

        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        let source_parent = workspace.join("src");
        let outside = directory.path().join("outside");
        fs::create_dir_all(&source_parent).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("sentinel.txt"), b"outside-unchanged").unwrap();
        let ready = directory.path().join("race-ready");
        let proceed = directory.path().join("race-proceed");
        let result = directory.path().join("race-result");

        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "workspace_write::tests::workspace_write_child_parent_replacement_probe",
                "--nocapture",
            ])
            .env("RUNALITH_WORKSPACE_RACE_ROOT", &workspace)
            .env("RUNALITH_WORKSPACE_RACE_READY", &ready)
            .env("RUNALITH_WORKSPACE_RACE_PROCEED", &proceed)
            .env("RUNALITH_WORKSPACE_RACE_RESULT", &result)
            .spawn()
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready.exists() {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("workspace race child exited before reaching publication hook: {status}");
            }
            assert!(
                Instant::now() < deadline,
                "workspace race child did not reach hook"
            );
            thread::sleep(Duration::from_millis(5));
        }

        fs::rename(&source_parent, directory.path().join("src-moved")).unwrap();
        std::os::unix::fs::symlink(&outside, &source_parent).unwrap();
        fs::write(&proceed, b"go").unwrap();
        let status = child.wait().unwrap();
        assert!(status.success(), "workspace race child failed: {status}");
        assert_eq!(fs::read(result).unwrap(), b"rejected");
        assert_eq!(
            fs::read(outside.join("sentinel.txt")).unwrap(),
            b"outside-unchanged"
        );
        assert!(!outside.join("child-output.txt").exists());
        assert!(!directory.path().join("src-moved/child-output.txt").exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parent_relocation_before_root_relative_rename_is_rejected() {
        // The staged file lives at the capability root. If the target parent
        // moves before publication, it is no longer resolvable beneath the
        // pinned root descriptor and the write must fail closed.
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        let source_parent = workspace.join("src");
        let outside = directory.path().join("outside");
        fs::create_dir_all(&source_parent).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let capability = capability(&workspace, "src", u64::MAX);
        let target = capability.checked_target(Path::new("src/main.rs")).unwrap();

        BEFORE_WORKSPACE_RENAME_TEST_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new({
                let source_parent = source_parent.clone();
                let outside = outside.clone();
                move || fs::rename(source_parent, outside).unwrap()
            }));
        });

        let error = capability
            .atomic_replace(
                &target,
                b"escaped",
                Path::new("src/main.rs"),
                "ABSENT",
                &digest(b"escaped"),
            )
            .unwrap_err();

        assert!(!workspace.join("src/main.rs").exists());
        assert!(!outside.join("main.rs").exists());
        assert!(matches!(
            error,
            WorkspaceWriteError::Io(_) | WorkspaceWriteError::Policy(_)
        ));
        assert!(fs::read_dir(&workspace).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".runalith-write-")
        }));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn symlink_substitution_before_root_relative_rename_is_rejected() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        let source_parent = workspace.join("src");
        let outside = directory.path().join("outside");
        fs::create_dir_all(&source_parent).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let capability = capability(&workspace, "src", u64::MAX);
        let target = capability.checked_target(Path::new("src/main.rs")).unwrap();

        BEFORE_WORKSPACE_RENAME_TEST_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new({
                let source_parent = source_parent.clone();
                let moved = directory.path().join("src-moved");
                let outside = outside.clone();
                move || {
                    fs::rename(&source_parent, moved).unwrap();
                    symlink(outside, source_parent).unwrap();
                }
            }));
        });

        assert!(
            capability
                .atomic_replace(
                    &target,
                    b"must-not-escape",
                    Path::new("src/main.rs"),
                    "ABSENT",
                    &digest(b"must-not-escape"),
                )
                .is_err()
        );
        assert!(!outside.join("main.rs").exists());
        assert!(!workspace.join("src/main.rs").exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn post_resolution_symlink_substitution_cannot_redirect_descriptor_anchored_publish() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        let source_parent = workspace.join("src");
        let moved_parent = workspace.join("src-pinned-original");
        let outside = directory.path().join("outside");
        fs::create_dir_all(&source_parent).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let store = stores(directory.path());
        let capability = capability(&workspace, "src", u64::MAX);

        // This hook runs after the final openat2 + inode identity check. It
        // models the task replacing the pathname with a symlink during the
        // historical check→renameat window. The pinned parent descriptor must
        // remain the rename destination; the host path in the symlink must not
        // receive the staged file.
        AFTER_WORKSPACE_PARENT_RESOLUTION_TEST_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new({
                let source_parent = source_parent.clone();
                let moved_parent = moved_parent.clone();
                let outside = outside.clone();
                move || {
                    fs::rename(&source_parent, &moved_parent).unwrap();
                    symlink(outside, source_parent).unwrap();
                }
            }));
        });

        let error = capability
            .apply_write("src/main.rs", "ABSENT", b"pinned-parent-content", &store)
            .unwrap_err();
        assert!(
            matches!(error, WorkspaceWriteError::MutationUncertain { .. }),
            "expected mutation to remain uncertain after parent identity changed: {error:?}"
        );
        assert!(!outside.join("main.rs").exists());
        assert_eq!(
            fs::read(moved_parent.join("main.rs")).unwrap(),
            b"pinned-parent-content"
        );
        let journal = store.root_path().join("workspace-write-journal");
        let pending_intents = fs::read_dir(journal)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
            .count();
        assert_eq!(pending_intents, 1);
    }

    #[test]
    fn concurrent_writers_with_same_base_hash_have_exactly_one_winner() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(workspace.join("src/shared.txt"), b"base").unwrap();
        let receipt_root = directory.path().join("receipts");
        let barrier = Arc::new(Barrier::new(8));
        let mut writers = Vec::new();

        for index in 0..8 {
            let workspace = workspace.clone();
            let receipt_root = receipt_root.clone();
            let barrier = barrier.clone();
            writers.push(thread::spawn(move || {
                let store = ArtifactStore::open_or_create(receipt_root).unwrap();
                let capability = capability(&workspace, "src", u64::MAX);
                let content = format!("writer-{index}");
                barrier.wait();
                capability.apply_write(
                    "src/shared.txt",
                    &digest(b"base"),
                    content.as_bytes(),
                    &store,
                )
            }));
        }

        let results = writers
            .into_iter()
            .map(|writer| writer.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(WorkspaceWriteError::Policy(message)) if message.contains("base SHA-256")))
                .count(),
            7
        );
        let final_bytes = fs::read(workspace.join("src/shared.txt")).unwrap();
        assert!(final_bytes.starts_with(b"writer-"));
    }

    #[test]
    fn expired_and_replayed_capabilities_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        fs::create_dir_all(workspace.join("src")).unwrap();
        let store = stores(directory.path());
        let expired = capability(&workspace, "src", 10);
        assert!(matches!(
            expired.apply_write_at(Path::new("src/a"), "ABSENT", b"x", &store, 10),
            Err(WorkspaceWriteError::Policy(message)) if message.contains("expired")
        ));

        let capability = capability(&workspace, "src", u64::MAX);
        capability
            .apply_write_at(Path::new("src/a"), "ABSENT", b"x", &store, 11)
            .unwrap();
        assert!(matches!(
            capability.apply_write_at(Path::new("src/b"), "ABSENT", b"y", &store, 12),
            Err(WorkspaceWriteError::Policy(message)) if message.contains("consumed")
        ));
        assert!(!workspace.join("src/b").exists());
    }

    #[test]
    fn cloned_capabilities_share_one_use_fence() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        fs::create_dir_all(workspace.join("src")).unwrap();
        let store = stores(directory.path());
        let capability = capability(&workspace, "src", u64::MAX);
        let clone = capability.clone();
        capability
            .apply_write_at(Path::new("src/a"), "ABSENT", b"x", &store, 1)
            .unwrap();
        assert!(matches!(
            clone.apply_write_at(Path::new("src/b"), "ABSENT", b"y", &store, 2),
            Err(WorkspaceWriteError::Policy(_))
        ));
    }

    #[test]
    fn receipt_artifact_detects_post_storage_mutation() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        fs::create_dir_all(workspace.join("src")).unwrap();
        let store = stores(directory.path());
        let stored = capability(&workspace, "src", u64::MAX)
            .apply_write("src/a", "ABSENT", b"payload", &store)
            .unwrap();
        let artifact_path = directory
            .path()
            .join("receipts")
            .join(&stored.artifact.sha256[..2])
            .join(&stored.artifact.sha256);
        fs::write(&artifact_path, b"tampered receipt").unwrap();
        assert!(matches!(
            store.read(&stored.artifact),
            Err(ArtifactError::Integrity(_))
        ));
    }

    #[test]
    fn stale_base_hash_does_not_mutate_workspace() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(workspace.join("src/a"), b"current").unwrap();
        let store = stores(directory.path());
        let capability = capability(&workspace, "src", u64::MAX);
        assert!(matches!(
            capability.apply_write("src/a", &digest(b"stale"), b"replacement", &store),
            Err(WorkspaceWriteError::Policy(_))
        ));
        assert_eq!(fs::read(workspace.join("src/a")).unwrap(), b"current");
    }

    #[test]
    fn replaces_matching_base_and_records_exact_before_after_hashes() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(workspace.join("src/a"), b"before").unwrap();
        let store = stores(directory.path());
        let stored = capability(&workspace, "src", u64::MAX)
            .apply_write("src/a", &digest(b"before"), b"after", &store)
            .unwrap();

        assert_eq!(stored.receipt.outcome, WorkspaceWriteOutcome::Replaced);
        assert_eq!(stored.receipt.before_sha256, digest(b"before"));
        assert_eq!(stored.receipt.after_sha256, digest(b"after"));
        assert_eq!(fs::read(workspace.join("src/a")).unwrap(), b"after");
    }

    #[test]
    fn records_already_present_without_rewriting_file() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(workspace.join("src/a"), b"same").unwrap();
        let modified = fs::metadata(workspace.join("src/a"))
            .unwrap()
            .modified()
            .unwrap();
        let store = stores(directory.path());
        let stored = capability(&workspace, "src", u64::MAX)
            .apply_write("src/a", &digest(b"same"), b"same", &store)
            .unwrap();

        assert_eq!(
            stored.receipt.outcome,
            WorkspaceWriteOutcome::AlreadyPresent
        );
        assert_eq!(
            fs::metadata(workspace.join("src/a"))
                .unwrap()
                .modified()
                .unwrap(),
            modified
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_workspace_root() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let link = directory.path().join("workspace-link");
        symlink(&workspace, &link).unwrap();
        assert!(matches!(
            WorkspaceWriteCapability::issue(
                &link,
                "src",
                "job-1",
                "task-1",
                "a".repeat(64),
                "patch-1",
                u64::MAX,
            ),
            Err(WorkspaceWriteError::Policy(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_workspace_root_replacement_after_capability_issue() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        fs::create_dir_all(workspace.join("src")).unwrap();
        let capability = capability(&workspace, "src", u64::MAX);
        fs::rename(&workspace, directory.path().join("workspace-original")).unwrap();
        fs::create_dir_all(workspace.join("src")).unwrap();
        let store = stores(directory.path());

        assert!(matches!(
            capability.apply_write("src/a", "ABSENT", b"x", &store),
            Err(WorkspaceWriteError::Policy(message)) if message.contains("identity changed")
        ));
        assert!(!workspace.join("src/a").exists());
    }
}
