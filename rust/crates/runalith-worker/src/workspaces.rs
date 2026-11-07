//! Per-execution host workspaces backed by kernel-enforced Linux project quotas.

use std::{
    fs::{self, DirBuilder},
    io,
    os::unix::fs::{DirBuilderExt, MetadataExt},
    path::{Path, PathBuf},
    sync::Arc,
};

use runalith_linux_quota::{
    ProjectQuotaController, ProjectQuotaLimits, ProjectQuotaStatus, UnixProjectQuotaBackend,
};

use crate::{
    ExecutionWorkspaceAllocator, ExecutionWorkspaceRecord, ExecutionWorkspaceState,
    TaskClaimEnvelope, WorkerOutcome, WorkerStore, WorkerStoreError,
};

/// Per-execution resource ceilings enforced by the mounted filesystem.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecutionWorkspaceLimits {
    /// Hard project quota in bytes.
    pub bytes: u64,
    /// Hard project quota in inodes.
    pub inodes: u64,
}

/// Host filesystem operations needed to manage one project quota.
/// The trait exists for deterministic ledger/recovery tests; production uses
/// the Linux kernel implementation below.
pub trait ProjectQuotaBackend: Send + Sync {
    /// Assign the project ID and turn on inherited project-ID propagation.
    fn assign(&self, path: &Path, project_id: u32) -> Result<(), String>;
    /// Set exact byte and inode hard limits.
    fn set_limits(
        &self,
        path: &Path,
        project_id: u32,
        limits: ExecutionWorkspaceLimits,
    ) -> Result<(), String>;
    /// Verify directory project ID and inherited flag.
    fn verify_directory(&self, path: &Path, project_id: u32) -> Result<(), String>;
    /// Verify hard limits by reading them back from the kernel.
    fn verify_limits(
        &self,
        path: &Path,
        project_id: u32,
        limits: ExecutionWorkspaceLimits,
    ) -> Result<ProjectQuotaStatus, String>;
    /// Read current charged usage.
    fn status(&self, project_id: u32) -> Result<ProjectQuotaStatus, String>;
    /// Clear project limits only if the kernel reports zero charged bytes/inodes.
    fn clear_empty(&self, project_id: u32) -> Result<(), String>;
}

impl ProjectQuotaBackend for ProjectQuotaController {
    fn assign(&self, path: &Path, project_id: u32) -> Result<(), String> {
        self.assign_project_id(path, project_id)
            .map_err(|error| error.to_string())
    }

    fn set_limits(
        &self,
        path: &Path,
        project_id: u32,
        limits: ExecutionWorkspaceLimits,
    ) -> Result<(), String> {
        self.set_hard_limits(
            path,
            project_id,
            ProjectQuotaLimits {
                bytes: limits.bytes,
                inodes: limits.inodes,
            },
        )
        .map_err(|error| error.to_string())
    }

    fn verify_directory(&self, path: &Path, project_id: u32) -> Result<(), String> {
        self.verify_directory(path, project_id)
            .map_err(|error| error.to_string())
    }

    fn verify_limits(
        &self,
        path: &Path,
        project_id: u32,
        limits: ExecutionWorkspaceLimits,
    ) -> Result<ProjectQuotaStatus, String> {
        self.verify_hard_limits(
            path,
            project_id,
            ProjectQuotaLimits {
                bytes: limits.bytes,
                inodes: limits.inodes,
            },
        )
        .map_err(|error| error.to_string())
    }

    fn status(&self, project_id: u32) -> Result<ProjectQuotaStatus, String> {
        self.status(project_id).map_err(|error| error.to_string())
    }

    fn clear_empty(&self, project_id: u32) -> Result<(), String> {
        self.clear_empty_project(project_id)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

impl ProjectQuotaBackend for UnixProjectQuotaBackend {
    fn assign(&self, path: &Path, project_id: u32) -> Result<(), String> {
        self.assign_project_id(path, project_id)
            .map_err(|error| error.to_string())
    }

    fn set_limits(
        &self,
        path: &Path,
        project_id: u32,
        limits: ExecutionWorkspaceLimits,
    ) -> Result<(), String> {
        self.set_hard_limits(
            path,
            project_id,
            ProjectQuotaLimits {
                bytes: limits.bytes,
                inodes: limits.inodes,
            },
        )
        .map_err(|error| error.to_string())
    }

    fn verify_directory(&self, path: &Path, project_id: u32) -> Result<(), String> {
        self.verify_directory(path, project_id)
            .map_err(|error| error.to_string())
    }

    fn verify_limits(
        &self,
        path: &Path,
        project_id: u32,
        limits: ExecutionWorkspaceLimits,
    ) -> Result<ProjectQuotaStatus, String> {
        self.verify_hard_limits(
            path,
            project_id,
            ProjectQuotaLimits {
                bytes: limits.bytes,
                inodes: limits.inodes,
            },
        )
        .map_err(|error| error.to_string())
    }

    fn status(&self, project_id: u32) -> Result<ProjectQuotaStatus, String> {
        self.status(project_id).map_err(|error| error.to_string())
    }

    fn clear_empty(&self, project_id: u32) -> Result<(), String> {
        self.clear_empty_project(project_id)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

/// Exact active execution workspace handle. Its identity is checked again before cleanup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionWorkspaceLease {
    /// Durable ledger record and assigned project ID.
    pub record: ExecutionWorkspaceRecord,
}

/// Allocates, verifies, and safely releases one quota-isolated host workspace per claim.
pub struct ExecutionWorkspaceManager<'a> {
    root: PathBuf,
    workspaces_root: PathBuf,
    store: &'a WorkerStore,
    backend: Arc<dyn ProjectQuotaBackend>,
    limits: ExecutionWorkspaceLimits,
}

impl<'a> ExecutionWorkspaceManager<'a> {
    /// Open a dedicated project-quota root and preflight the kernel controller.
    pub fn open(
        root: impl AsRef<Path>,
        store: &'a WorkerStore,
        limits: ExecutionWorkspaceLimits,
    ) -> Result<Self, WorkspaceManagerError> {
        let controller = ProjectQuotaController::open(root.as_ref())
            .map_err(|error| WorkspaceManagerError::Quota(error.to_string()))?;
        Self::with_backend(root, store, limits, Arc::new(controller))
    }

    /// Connect to the narrow root-owned project-quota helper. The worker itself
    /// receives no `CAP_SYS_ADMIN`; peer credentials on the Unix socket bind
    /// every quota request to the configured worker UID.
    pub fn open_with_helper(
        root: impl AsRef<Path>,
        store: &'a WorkerStore,
        limits: ExecutionWorkspaceLimits,
        socket_path: impl AsRef<Path>,
    ) -> Result<Self, WorkspaceManagerError> {
        let backend = UnixProjectQuotaBackend::connect(socket_path)
            .map_err(|error| WorkspaceManagerError::Quota(error.to_string()))?;
        Self::with_backend(root, store, limits, Arc::new(backend))
    }

    fn with_backend(
        root: impl AsRef<Path>,
        store: &'a WorkerStore,
        limits: ExecutionWorkspaceLimits,
        backend: Arc<dyn ProjectQuotaBackend>,
    ) -> Result<Self, WorkspaceManagerError> {
        if limits.bytes == 0
            || limits.inodes == 0
            || limits.bytes > i64::MAX as u64
            || limits.inodes > i64::MAX as u64
        {
            return Err(WorkspaceManagerError::Invalid("quota limits"));
        }
        let root = root.as_ref();
        let metadata = fs::symlink_metadata(root)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(WorkspaceManagerError::Invalid(
                "workspace quota root must be a real directory",
            ));
        }
        let root = fs::canonicalize(root)?;
        validate_private_owned_directory(&root)?;
        let workspaces_root = root.join(".runalith-executions");
        match fs::symlink_metadata(&workspaces_root) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(WorkspaceManagerError::Invalid(
                        "execution workspace parent is not a real directory",
                    ));
                }
                validate_private_owned_directory(&workspaces_root)?;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let mut builder = DirBuilder::new();
                builder.recursive(false).mode(0o700);
                builder.create(&workspaces_root)?;
                validate_private_owned_directory(&workspaces_root)?;
            }
            Err(error) => return Err(error.into()),
        }
        let parent_device = fs::metadata(&root)?.dev();
        if fs::metadata(&workspaces_root)?.dev() != parent_device {
            return Err(WorkspaceManagerError::Invalid(
                "execution workspace parent crosses a filesystem boundary",
            ));
        }
        Ok(Self {
            root,
            workspaces_root,
            store,
            backend,
            limits,
        })
    }

    /// Allocate a new monotonic project ID, create its private directory, set
    /// the kernel project ID/inheritance flag, apply hard limits, and read them
    /// back before returning the workspace to the execution path.
    pub fn allocate(
        &self,
        claim: &TaskClaimEnvelope,
    ) -> Result<ExecutionWorkspaceLease, WorkspaceManagerError> {
        let record = self.store.reserve_execution_workspace(
            claim,
            &self.root,
            &self.workspaces_root,
            self.limits.bytes,
            self.limits.inodes,
        )?;

        let mut builder = DirBuilder::new();
        builder.recursive(false).mode(0o700);
        if let Err(error) = builder.create(&record.workspace_path) {
            self.quarantine(
                &record,
                &format!("workspace directory creation failed: {error}"),
            )?;
            return Err(error.into());
        }
        let result = self.configure_and_verify(&record);
        match result {
            Ok((device, inode)) => {
                if let Err(error) = self
                    .store
                    .activate_execution_workspace(&record, device, inode)
                {
                    let _ = self.quarantine(&record, &error.to_string());
                    return Err(error.into());
                }
                let mut active = record;
                active.device = Some(device);
                active.inode = Some(inode);
                active.state = ExecutionWorkspaceState::Active;
                Ok(ExecutionWorkspaceLease { record: active })
            }
            Err(error) => {
                self.quarantine(&record, &error.to_string())?;
                Err(error)
            }
        }
    }

    /// Finish a known terminal execution. UNKNOWN retains the directory and
    /// quota permanently in quarantine until a separate recovery authority
    /// has exact process/cgroup evidence.
    pub fn finish(
        &self,
        lease: &ExecutionWorkspaceLease,
        outcome: WorkerOutcome,
    ) -> Result<(), WorkspaceManagerError> {
        let record = &lease.record;
        if outcome == WorkerOutcome::Unknown {
            return self.quarantine(
                record,
                "execution outcome is UNKNOWN; workspace retained for reconciliation",
            );
        }
        if record.state != ExecutionWorkspaceState::Active {
            return Err(WorkspaceManagerError::Invalid(
                "only an ACTIVE workspace can be released",
            ));
        }
        let result = self.release_active(record);
        if let Err(error) = result {
            let _ = self.quarantine(record, &error.to_string());
            return Err(error);
        }
        Ok(())
    }

    /// Quarantine unfinished workspaces at process startup. No path is deleted
    /// and no project ID is reused because a crash makes charge ownership uncertain.
    pub fn recover_after_restart(&self) -> Result<usize, WorkspaceManagerError> {
        Ok(self.store.quarantine_unrecovered_execution_workspaces()?)
    }

    fn configure_and_verify(
        &self,
        record: &ExecutionWorkspaceRecord,
    ) -> Result<(u64, u64), WorkspaceManagerError> {
        validate_private_owned_directory(&record.workspace_path)?;
        let parent_metadata = fs::metadata(&self.workspaces_root)?;
        let metadata = fs::metadata(&record.workspace_path)?;
        if metadata.dev() != parent_metadata.dev()
            || metadata.dev() != fs::metadata(&self.root)?.dev()
        {
            return Err(WorkspaceManagerError::Invalid(
                "execution workspace is not on the quota filesystem",
            ));
        }
        if fs::read_dir(&record.workspace_path)?.next().is_some() {
            return Err(WorkspaceManagerError::Invalid(
                "new execution workspace is unexpectedly non-empty",
            ));
        }
        self.backend
            .assign(&record.workspace_path, record.project_id)
            .map_err(WorkspaceManagerError::Quota)?;
        self.backend
            .set_limits(
                &record.workspace_path,
                record.project_id,
                ExecutionWorkspaceLimits {
                    bytes: record.byte_limit,
                    inodes: record.inode_limit,
                },
            )
            .map_err(WorkspaceManagerError::Quota)?;
        self.backend
            .verify_directory(&record.workspace_path, record.project_id)
            .map_err(WorkspaceManagerError::Quota)?;
        let status = self
            .backend
            .verify_limits(
                &record.workspace_path,
                record.project_id,
                ExecutionWorkspaceLimits {
                    bytes: record.byte_limit,
                    inodes: record.inode_limit,
                },
            )
            .map_err(WorkspaceManagerError::Quota)?;
        if status.bytes_used > status.bytes_hard_limit
            || status.inodes_used > status.inodes_hard_limit
        {
            return Err(WorkspaceManagerError::Invalid(
                "new execution workspace already exceeds its hard quota",
            ));
        }
        let final_metadata = fs::metadata(&record.workspace_path)?;
        if final_metadata.dev() != metadata.dev() || final_metadata.ino() != metadata.ino() {
            return Err(WorkspaceManagerError::Invalid(
                "execution workspace identity changed during quota setup",
            ));
        }
        Ok((final_metadata.dev(), final_metadata.ino()))
    }

    fn release_active(
        &self,
        record: &ExecutionWorkspaceRecord,
    ) -> Result<(), WorkspaceManagerError> {
        let (Some(device), Some(inode)) = (record.device, record.inode) else {
            return Err(WorkspaceManagerError::Invalid(
                "active workspace omitted its recorded device/inode",
            ));
        };
        let metadata = fs::symlink_metadata(&record.workspace_path)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(WorkspaceManagerError::Invalid(
                "execution workspace path was replaced",
            ));
        }
        if metadata.dev() != device || metadata.ino() != inode {
            return Err(WorkspaceManagerError::Invalid(
                "execution workspace device/inode changed before cleanup",
            ));
        }
        self.backend
            .verify_directory(&record.workspace_path, record.project_id)
            .map_err(WorkspaceManagerError::Quota)?;
        fs::remove_dir_all(&record.workspace_path)?;
        let status = self
            .backend
            .status(record.project_id)
            .map_err(WorkspaceManagerError::Quota)?;
        if status.bytes_used != 0 || status.inodes_used != 0 {
            return Err(WorkspaceManagerError::Quota(format!(
                "project {} remains charged after workspace removal: {} bytes, {} inodes",
                record.project_id, status.bytes_used, status.inodes_used
            )));
        }
        self.backend
            .clear_empty(record.project_id)
            .map_err(WorkspaceManagerError::Quota)?;
        self.store.release_execution_workspace(record)?;
        Ok(())
    }

    fn quarantine(
        &self,
        record: &ExecutionWorkspaceRecord,
        diagnostic: &str,
    ) -> Result<(), WorkspaceManagerError> {
        self.store.quarantine_execution_workspace(
            &record.claim_id,
            record.project_id,
            diagnostic,
        )?;
        Ok(())
    }
}

impl ExecutionWorkspaceAllocator for ExecutionWorkspaceManager<'_> {
    fn allocate(&self, claim: &TaskClaimEnvelope) -> Result<ExecutionWorkspaceLease, String> {
        ExecutionWorkspaceManager::allocate(self, claim).map_err(|error| error.to_string())
    }

    fn finish(
        &self,
        lease: &ExecutionWorkspaceLease,
        outcome: WorkerOutcome,
    ) -> Result<(), String> {
        ExecutionWorkspaceManager::finish(self, lease, outcome).map_err(|error| error.to_string())
    }
}

/// Workspace allocation, setup, cleanup, or kernel enforcement failure.
#[derive(Debug, thiserror::Error)]
pub enum WorkspaceManagerError {
    /// Unsafe path or impossible state transition.
    #[error("execution workspace policy rejected: {0}")]
    Invalid(&'static str),
    /// Kernel project quota support or readback failed.
    #[error("execution workspace project quota failed: {0}")]
    Quota(String),
    /// Worker-local durable ledger failed.
    #[error(transparent)]
    Store(#[from] WorkerStoreError),
    /// Filesystem operation failed.
    #[error(transparent)]
    Io(#[from] io::Error),
    /// SQLite operation failed.
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

fn validate_private_owned_directory(path: &Path) -> Result<(), WorkspaceManagerError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(WorkspaceManagerError::Invalid(
            "execution workspace directory is not a real directory",
        ));
    }
    if metadata.uid() != crate::store::current_process_uid()? || metadata.mode() & 0o022 != 0 {
        return Err(WorkspaceManagerError::Invalid(
            "execution workspace directory must be owned by the worker and not group/world writable",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeMap, sync::Mutex};

    use crate::tests::envelope;

    #[derive(Debug, Clone)]
    struct FakeProject {
        path: PathBuf,
        limits: Option<ExecutionWorkspaceLimits>,
    }

    #[derive(Default)]
    struct FakeQuotaBackend {
        projects: Mutex<BTreeMap<u32, FakeProject>>,
    }

    impl ProjectQuotaBackend for FakeQuotaBackend {
        fn assign(&self, path: &Path, project_id: u32) -> Result<(), String> {
            let mut projects = self.projects.lock().unwrap();
            if projects
                .insert(
                    project_id,
                    FakeProject {
                        path: path.to_owned(),
                        limits: None,
                    },
                )
                .is_some()
            {
                return Err("project ID reused".into());
            }
            Ok(())
        }

        fn set_limits(
            &self,
            path: &Path,
            project_id: u32,
            limits: ExecutionWorkspaceLimits,
        ) -> Result<(), String> {
            let mut projects = self.projects.lock().unwrap();
            let project = projects
                .get_mut(&project_id)
                .ok_or_else(|| "project not assigned".to_owned())?;
            if project.path != path {
                return Err("project directory mismatch".into());
            }
            project.limits = Some(limits);
            Ok(())
        }

        fn verify_directory(&self, path: &Path, project_id: u32) -> Result<(), String> {
            let projects = self.projects.lock().unwrap();
            let project = projects
                .get(&project_id)
                .ok_or_else(|| "project not assigned".to_owned())?;
            if project.path != path {
                return Err("project directory mismatch".into());
            }
            Ok(())
        }

        fn verify_limits(
            &self,
            path: &Path,
            project_id: u32,
            limits: ExecutionWorkspaceLimits,
        ) -> Result<ProjectQuotaStatus, String> {
            let projects = self.projects.lock().unwrap();
            let project = projects
                .get(&project_id)
                .ok_or_else(|| "project not assigned".to_owned())?;
            if project.path != path || project.limits != Some(limits) {
                return Err("project hard limit mismatch".into());
            }
            Ok(ProjectQuotaStatus {
                project_id,
                bytes_hard_limit: limits.bytes.div_ceil(1024) * 1024,
                inodes_hard_limit: limits.inodes,
                bytes_used: 0,
                inodes_used: u64::from(project.path.exists()),
            })
        }

        fn status(&self, project_id: u32) -> Result<ProjectQuotaStatus, String> {
            let projects = self.projects.lock().unwrap();
            let project = projects
                .get(&project_id)
                .ok_or_else(|| "project not assigned".to_owned())?;
            let limits = project
                .limits
                .ok_or_else(|| "project hard limits not configured".to_owned())?;
            Ok(ProjectQuotaStatus {
                project_id,
                bytes_hard_limit: limits.bytes.div_ceil(1024) * 1024,
                inodes_hard_limit: limits.inodes,
                bytes_used: 0,
                inodes_used: u64::from(project.path.exists()),
            })
        }

        fn clear_empty(&self, project_id: u32) -> Result<(), String> {
            let mut projects = self.projects.lock().unwrap();
            let project = projects
                .get(&project_id)
                .ok_or_else(|| "project not assigned".to_owned())?;
            if project.path.exists() {
                return Err("project still has an inode charge".into());
            }
            projects.remove(&project_id);
            Ok(())
        }
    }

    fn start_claim(store: &WorkerStore, mut claim: TaskClaimEnvelope) -> TaskClaimEnvelope {
        store.accept_claim(&claim).unwrap();
        store
            .begin_claim(&claim.claim_id, &claim.worker_id, claim.owner_epoch)
            .unwrap();
        claim.expires_at = (chrono::Utc::now() + chrono::Duration::minutes(1)).to_rfc3339();
        claim
    }

    #[test]
    fn workspace_is_project_isolated_and_released_only_after_zero_kernel_charge() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let claim = start_claim(&store, envelope(chrono::Utc::now()));
        let root = directory.path().join("quota-root");
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let backend = Arc::new(FakeQuotaBackend::default());
        let manager = ExecutionWorkspaceManager::with_backend(
            &root,
            &store,
            ExecutionWorkspaceLimits {
                bytes: 1_048_576,
                inodes: 4096,
            },
            backend,
        )
        .unwrap();

        let workspace = manager.allocate(&claim).unwrap();
        assert_eq!(workspace.record.project_id, 10_000);
        assert_eq!(workspace.record.state, ExecutionWorkspaceState::Active);
        assert!(workspace.record.workspace_path.is_dir());
        assert!(workspace.record.device.is_some());
        assert!(workspace.record.inode.is_some());

        manager
            .finish(&workspace, WorkerOutcome::Succeeded)
            .unwrap();
        assert!(!workspace.record.workspace_path.exists());
        assert_eq!(
            store
                .execution_workspace(&claim.claim_id)
                .unwrap()
                .unwrap()
                .state,
            ExecutionWorkspaceState::Released
        );
    }

    #[test]
    fn unknown_workspace_is_quarantined_and_its_project_id_is_never_reused() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let first_claim = start_claim(&store, envelope(chrono::Utc::now()));
        let root = directory.path().join("quota-root");
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let backend = Arc::new(FakeQuotaBackend::default());
        let manager = ExecutionWorkspaceManager::with_backend(
            &root,
            &store,
            ExecutionWorkspaceLimits {
                bytes: 1_048_576,
                inodes: 4096,
            },
            backend,
        )
        .unwrap();
        let first = manager.allocate(&first_claim).unwrap();
        manager.finish(&first, WorkerOutcome::Unknown).unwrap();
        assert!(first.record.workspace_path.is_dir());
        assert_eq!(
            store
                .execution_workspace(&first_claim.claim_id)
                .unwrap()
                .unwrap()
                .state,
            ExecutionWorkspaceState::Quarantined
        );

        let mut second_claim = first_claim.clone();
        second_claim.claim_id = "claim-second".into();
        second_claim.workflow_id = "workflow-second".into();
        second_claim.task_id = "task-second".into();
        second_claim.idempotency_key = "idem-second".into();
        let second_claim = start_claim(&store, second_claim);
        let second = manager.allocate(&second_claim).unwrap();
        assert_eq!(second.record.project_id, first.record.project_id + 1);
        assert_ne!(second.record.workspace_path, first.record.workspace_path);
    }

    #[test]
    fn unsupported_project_quota_never_falls_back_to_unlimited_workspace() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let store = WorkerStore::open(directory.path().join("worker.db")).unwrap();
        let root = directory.path().join("quota-root");
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(matches!(
            ProjectQuotaController::open(&root),
            Err(runalith_linux_quota::ProjectQuotaError::Unsupported(_))
        ));
        let _ = store;
    }
}
