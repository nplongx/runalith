//! Narrow Linux project-quota operations used by the execution workspace manager.
//!
//! The crate is deliberately separate from the general worker so the few
//! kernel ABI calls remain in one audited boundary. No userspace accounting or
//! best-effort fallback is provided: an unsupported filesystem is an error.

#![deny(unsafe_op_in_unsafe_fn)]

use std::{
    ffi::CString,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::fd::{AsRawFd, FromRawFd},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    os::unix::net::{UnixListener, UnixStream},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use thiserror::Error;

const PROJECT_QUOTA_TYPE: u32 = 2;
const Q_GETQUOTA: u32 = 0x800007;
const Q_SETQUOTA: u32 = 0x800008;
const QIF_LIMITS: u32 = (1 << 0) | (1 << 2);
const FS_XFLAG_PROJINHERIT: u32 = 0x0000_0200;
const FS_IOC_FSGETXATTR: libc::c_ulong = 0x801c_581f;
const FS_IOC_FSSETXATTR: libc::c_ulong = 0x401c_5820;
const PROJECT_ID_MIN: u32 = 10_000;
type RegistryLimitsRow = (String, i64, i64, Option<i64>, Option<i64>, String);

/// Requested hard limits for one project ID.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectQuotaLimits {
    /// Maximum charged file data in bytes.
    pub bytes: u64,
    /// Maximum charged inodes.
    pub inodes: u64,
}

/// Kernel-observed project quota values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectQuotaStatus {
    /// Project identifier returned by the quota record.
    pub project_id: u32,
    /// Hard byte limit, converted from 1 KiB quota blocks.
    pub bytes_hard_limit: u64,
    /// Hard inode limit.
    pub inodes_hard_limit: u64,
    /// Current charged bytes.
    pub bytes_used: u64,
    /// Current charged inodes.
    pub inodes_used: u64,
}

/// Filesystem/project-quota capability and enforcement error.
#[derive(Debug, Error)]
pub enum ProjectQuotaError {
    /// The configured path or requested quota values are invalid.
    #[error("project quota configuration is invalid: {0}")]
    Invalid(&'static str),
    /// Filesystem does not provide active project quota enforcement.
    #[error("filesystem project quota is unavailable: {0}")]
    Unsupported(String),
    /// Kernel operation failed.
    #[error("Linux project quota operation failed: {0}")]
    Io(#[from] io::Error),
    /// Worker/helper IPC protocol failed.
    #[error("Linux project quota helper protocol failed: {0}")]
    Protocol(String),
    /// Helper-owned durable project registry failed.
    #[error("Linux project quota registry failed: {0}")]
    Registry(#[from] rusqlite::Error),
}

#[derive(Debug, Clone)]
struct Mount {
    mount_point: PathBuf,
    source: String,
    filesystem: String,
    options: Vec<String>,
}

/// Linux project-quota controller bound to one exact mounted filesystem.
#[derive(Debug, Clone)]
pub struct ProjectQuotaController {
    root: PathBuf,
    mount_point: PathBuf,
    source: CString,
    filesystem: String,
}

impl ProjectQuotaController {
    /// Open and verify a project-quota-enabled ext4 or XFS mount.
    pub fn open(root: impl AsRef<Path>) -> Result<Self, ProjectQuotaError> {
        let root = root.as_ref();
        let metadata = fs::symlink_metadata(root)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(ProjectQuotaError::Invalid(
                "workspace quota root must be a real directory",
            ));
        }
        let root = fs::canonicalize(root)?;
        let mount = find_mount(&root)?;
        if !matches!(mount.filesystem.as_str(), "ext4" | "xfs") {
            return Err(ProjectQuotaError::Unsupported(format!(
                "{} does not implement supported project quotas",
                mount.filesystem
            )));
        }
        if !mount
            .options
            .iter()
            .any(|option| matches!(option.as_str(), "prjquota" | "pquota"))
        {
            return Err(ProjectQuotaError::Unsupported(format!(
                "mount {} is not configured with prjquota/pquota",
                mount.mount_point.display()
            )));
        }
        if !mount.source.starts_with("/dev/") {
            return Err(ProjectQuotaError::Unsupported(
                "project quota mount source is not a block device".into(),
            ));
        }
        let mount_point = mount.mount_point.clone();
        let filesystem = mount.filesystem.clone();
        let source = CString::new(mount.source)
            .map_err(|_| ProjectQuotaError::Invalid("mount source contains NUL"))?;
        let controller = Self {
            root,
            mount_point,
            source,
            filesystem,
        };
        // A harmless read at an unused ID verifies that the project-quota
        // subsystem is actually active, not merely present in mount text.
        let _ = controller.get_quota(PROJECT_ID_MIN)?;
        Ok(controller)
    }

    /// Filesystem root to which this controller is bound.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Exact mount point containing this controller's quota root.
    ///
    /// Destructive integration tooling must require `root() == mount_point()`
    /// so a nested production directory cannot be mistaken for a dedicated
    /// quota test filesystem.
    pub fn mount_point(&self) -> &Path {
        &self.mount_point
    }

    /// Filesystem type (`ext4` or `xfs`).
    pub fn filesystem(&self) -> &str {
        &self.filesystem
    }

    /// Assign a project ID to an empty workspace directory and enable
    /// project-ID inheritance for all descendants created beneath it.
    pub fn assign_project_id(
        &self,
        directory: impl AsRef<Path>,
        project_id: u32,
    ) -> Result<(), ProjectQuotaError> {
        self.assign_project_id_inner(directory.as_ref(), project_id, None)
    }

    /// Assign project quota only if the opened directory descriptor has the
    /// exact device/inode identity recorded by the privileged registry.
    pub fn assign_project_id_exact(
        &self,
        directory: impl AsRef<Path>,
        project_id: u32,
        expected_identity: (u64, u64),
    ) -> Result<(), ProjectQuotaError> {
        self.assign_project_id_inner(directory.as_ref(), project_id, Some(expected_identity))
    }

    fn assign_project_id_inner(
        &self,
        directory: &Path,
        project_id: u32,
        expected_identity: Option<(u64, u64)>,
    ) -> Result<(), ProjectQuotaError> {
        if project_id < PROJECT_ID_MIN {
            return Err(ProjectQuotaError::Invalid(
                "project ID is below the reserved worker range",
            ));
        }
        self.validate_workspace_path(directory)?;
        let file = open_directory(directory)?;
        verify_file_identity(&file, expected_identity)?;
        let mut attributes = get_fsxattr(&file)?;
        if attributes.project_id == project_id && attributes.xflags & FS_XFLAG_PROJINHERIT != 0 {
            return Ok(());
        }
        if attributes.project_id != 0 || attributes.xflags & FS_XFLAG_PROJINHERIT != 0 {
            return Err(ProjectQuotaError::Unsupported(
                "workspace already belongs to another project quota".into(),
            ));
        }
        if fs::read_dir(format!("/proc/self/fd/{}", file.as_raw_fd()))?
            .next()
            .is_some()
        {
            return Err(ProjectQuotaError::Invalid(
                "project ID can only be assigned to a newly-created empty workspace",
            ));
        }
        attributes.project_id = project_id;
        attributes.xflags |= FS_XFLAG_PROJINHERIT;
        set_fsxattr(&file, &attributes)?;
        let observed = get_fsxattr(&file)?;
        if observed.project_id != project_id || observed.xflags & FS_XFLAG_PROJINHERIT == 0 {
            return Err(ProjectQuotaError::Unsupported(
                "filesystem did not retain project ID and inheritance flag".into(),
            ));
        }
        Ok(())
    }

    /// Set byte and inode hard limits for an exact project ID.
    pub fn set_hard_limits(
        &self,
        directory: impl AsRef<Path>,
        project_id: u32,
        limits: ProjectQuotaLimits,
    ) -> Result<(), ProjectQuotaError> {
        self.set_hard_limits_inner(directory.as_ref(), project_id, limits, None)
    }

    /// Set hard limits only when the directory descriptor matches the exact
    /// immutable project registry identity.
    pub fn set_hard_limits_exact(
        &self,
        directory: impl AsRef<Path>,
        project_id: u32,
        limits: ProjectQuotaLimits,
        expected_identity: (u64, u64),
    ) -> Result<(), ProjectQuotaError> {
        self.set_hard_limits_inner(
            directory.as_ref(),
            project_id,
            limits,
            Some(expected_identity),
        )
    }

    fn set_hard_limits_inner(
        &self,
        directory: &Path,
        project_id: u32,
        limits: ProjectQuotaLimits,
        expected_identity: Option<(u64, u64)>,
    ) -> Result<(), ProjectQuotaError> {
        self.verify_directory_inner(directory, project_id, expected_identity)?;
        if project_id < PROJECT_ID_MIN || limits.bytes == 0 || limits.inodes == 0 {
            return Err(ProjectQuotaError::Invalid("project ID or hard limits"));
        }
        let mut quota = IfDqblk {
            byte_hard_limit: limits.bytes.div_ceil(1024),
            inode_hard_limit: limits.inodes,
            valid: QIF_LIMITS,
            ..IfDqblk::default()
        };
        self.quotactl(Q_SETQUOTA, project_id, &mut quota)?;
        self.verify_hard_limits_inner(directory, project_id, limits, expected_identity)?;
        Ok(())
    }

    /// Read kernel-enforced limits and current charged usage.
    pub fn status(&self, project_id: u32) -> Result<ProjectQuotaStatus, ProjectQuotaError> {
        let quota = self.get_quota(project_id)?;
        Ok(ProjectQuotaStatus {
            project_id,
            bytes_hard_limit: quota.byte_hard_limit.saturating_mul(1024),
            inodes_hard_limit: quota.inode_hard_limit,
            bytes_used: quota.current_bytes,
            inodes_used: quota.current_inodes,
        })
    }

    /// Verify exact limits and return the current usage snapshot.
    pub fn verify_hard_limits(
        &self,
        directory: impl AsRef<Path>,
        project_id: u32,
        limits: ProjectQuotaLimits,
    ) -> Result<ProjectQuotaStatus, ProjectQuotaError> {
        self.verify_hard_limits_inner(directory.as_ref(), project_id, limits, None)
    }

    /// Read back exact hard limits and bind them to a previously recorded inode.
    pub fn verify_hard_limits_exact(
        &self,
        directory: impl AsRef<Path>,
        project_id: u32,
        limits: ProjectQuotaLimits,
        expected_identity: (u64, u64),
    ) -> Result<ProjectQuotaStatus, ProjectQuotaError> {
        self.verify_hard_limits_inner(
            directory.as_ref(),
            project_id,
            limits,
            Some(expected_identity),
        )
    }

    fn verify_hard_limits_inner(
        &self,
        directory: &Path,
        project_id: u32,
        limits: ProjectQuotaLimits,
        expected_identity: Option<(u64, u64)>,
    ) -> Result<ProjectQuotaStatus, ProjectQuotaError> {
        self.verify_directory_inner(directory, project_id, expected_identity)?;
        let status = self.status(project_id)?;
        let expected_blocks = limits.bytes.div_ceil(1024);
        if status.project_id != project_id
            || status.bytes_hard_limit.div_ceil(1024) != expected_blocks
            || status.inodes_hard_limit != limits.inodes
        {
            return Err(ProjectQuotaError::Unsupported(format!(
                "kernel quota readback differs from requested limits for project {project_id}"
            )));
        }
        Ok(status)
    }

    /// Remove hard limits only after all charged bytes and inodes have reached zero.
    pub fn clear_empty_project(
        &self,
        project_id: u32,
    ) -> Result<ProjectQuotaStatus, ProjectQuotaError> {
        let before = self.status(project_id)?;
        if before.bytes_used != 0 || before.inodes_used != 0 {
            return Err(ProjectQuotaError::Unsupported(format!(
                "project {project_id} still owns {} bytes and {} inodes",
                before.bytes_used, before.inodes_used
            )));
        }
        let mut quota = IfDqblk {
            valid: QIF_LIMITS,
            ..IfDqblk::default()
        };
        self.quotactl(Q_SETQUOTA, project_id, &mut quota)?;
        self.status(project_id)
    }

    /// Verify the project ID and inheritance flag on one workspace root.
    pub fn verify_directory(
        &self,
        directory: impl AsRef<Path>,
        project_id: u32,
    ) -> Result<(), ProjectQuotaError> {
        self.verify_directory_inner(directory.as_ref(), project_id, None)
    }

    /// Verify project ID and inheritance against a pinned filesystem identity.
    pub fn verify_directory_exact(
        &self,
        directory: impl AsRef<Path>,
        project_id: u32,
        expected_identity: (u64, u64),
    ) -> Result<(), ProjectQuotaError> {
        self.verify_directory_inner(directory.as_ref(), project_id, Some(expected_identity))
    }

    fn verify_directory_inner(
        &self,
        directory: &Path,
        project_id: u32,
        expected_identity: Option<(u64, u64)>,
    ) -> Result<(), ProjectQuotaError> {
        self.validate_workspace_path(directory)?;
        let file = open_directory(directory)?;
        verify_file_identity(&file, expected_identity)?;
        let observed = get_fsxattr(&file)?;
        if observed.project_id != project_id || observed.xflags & FS_XFLAG_PROJINHERIT == 0 {
            return Err(ProjectQuotaError::Unsupported(format!(
                "workspace {} is not assigned to project {project_id} with inheritance",
                directory.display()
            )));
        }
        Ok(())
    }

    fn validate_workspace_path(&self, path: &Path) -> Result<(), ProjectQuotaError> {
        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(ProjectQuotaError::Invalid(
                "workspace path must be a real directory",
            ));
        }
        let canonical = fs::canonicalize(path)?;
        if !canonical.starts_with(&self.root) || canonical == self.root {
            return Err(ProjectQuotaError::Invalid(
                "workspace must be a strict descendant of the quota root",
            ));
        }
        Ok(())
    }

    fn get_quota(&self, project_id: u32) -> Result<IfDqblk, ProjectQuotaError> {
        let mut quota = IfDqblk::default();
        self.quotactl(Q_GETQUOTA, project_id, &mut quota)?;
        Ok(quota)
    }

    fn quotactl(
        &self,
        command: u32,
        project_id: u32,
        quota: &mut IfDqblk,
    ) -> Result<(), ProjectQuotaError> {
        let command = ((command << 8) | PROJECT_QUOTA_TYPE) as libc::c_int;
        // SAFETY: `source` is a NUL-terminated mount-device path and `quota`
        // points to the exact repr(C) Linux if_dqblk ABI structure for the
        // duration of the synchronous quotactl call.
        let result = unsafe {
            libc::quotactl(
                command,
                self.source.as_ptr(),
                project_id as libc::c_int,
                (quota as *mut IfDqblk).cast::<libc::c_char>(),
            )
        };
        if result != 0 {
            return Err(ProjectQuotaError::Io(io::Error::last_os_error()));
        }
        Ok(())
    }
}

const MAX_HELPER_FRAME_BYTES: usize = 16 * 1024;

/// Narrow request protocol exposed by the privileged quota helper.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum QuotaHelperRequest {
    /// Verify that the helper can query project quota on its configured mount.
    Probe,
    /// Assign project ID and inheritance to one child directory.
    AssignProjectId { directory: String, project_id: u32 },
    /// Set project byte and inode hard limits.
    SetHardLimits {
        directory: String,
        project_id: u32,
        limits: ProjectQuotaLimits,
    },
    /// Verify one exact workspace directory's project ID and inheritance flag.
    VerifyDirectory { directory: String, project_id: u32 },
    /// Read back exact hard limits.
    VerifyHardLimits {
        directory: String,
        project_id: u32,
        limits: ProjectQuotaLimits,
    },
    /// Read current charged usage.
    Status { project_id: u32 },
    /// Remove hard limits after usage is verified zero.
    ClearEmpty { project_id: u32 },
}

/// Typed worker-facing client for the separate privileged quota helper.
#[derive(Debug, Clone)]
pub struct UnixProjectQuotaBackend {
    socket_path: PathBuf,
}

impl UnixProjectQuotaBackend {
    /// Connect to the systemd-activated helper and verify its quota backend is live.
    pub fn connect(socket_path: impl AsRef<Path>) -> Result<Self, ProjectQuotaError> {
        let backend = Self {
            socket_path: socket_path.as_ref().to_owned(),
        };
        match backend.call(QuotaHelperRequest::Probe)? {
            QuotaHelperResponse::Ok => Ok(backend),
            QuotaHelperResponse::Error(message) => Err(ProjectQuotaError::Protocol(message)),
            QuotaHelperResponse::Status(_) => Err(ProjectQuotaError::Protocol(
                "quota helper probe returned an unexpected status".into(),
            )),
        }
    }

    /// Assign a project ID and inheritance flag to one exact workspace directory.
    pub fn assign_project_id(
        &self,
        directory: impl AsRef<Path>,
        project_id: u32,
    ) -> Result<(), ProjectQuotaError> {
        self.expect_ok(QuotaHelperRequest::AssignProjectId {
            directory: directory.as_ref().to_string_lossy().into_owned(),
            project_id,
        })
    }

    /// Set project hard limits through the privileged helper.
    pub fn set_hard_limits(
        &self,
        directory: impl AsRef<Path>,
        project_id: u32,
        limits: ProjectQuotaLimits,
    ) -> Result<(), ProjectQuotaError> {
        self.expect_ok(QuotaHelperRequest::SetHardLimits {
            directory: directory.as_ref().to_string_lossy().into_owned(),
            project_id,
            limits,
        })
    }

    /// Verify project ID/inheritance on one exact workspace directory.
    pub fn verify_directory(
        &self,
        directory: impl AsRef<Path>,
        project_id: u32,
    ) -> Result<(), ProjectQuotaError> {
        self.expect_ok(QuotaHelperRequest::VerifyDirectory {
            directory: directory.as_ref().to_string_lossy().into_owned(),
            project_id,
        })
    }

    /// Verify exact hard limits by kernel readback.
    pub fn verify_hard_limits(
        &self,
        directory: impl AsRef<Path>,
        project_id: u32,
        limits: ProjectQuotaLimits,
    ) -> Result<ProjectQuotaStatus, ProjectQuotaError> {
        self.expect_status(QuotaHelperRequest::VerifyHardLimits {
            directory: directory.as_ref().to_string_lossy().into_owned(),
            project_id,
            limits,
        })
    }

    /// Read current charged bytes and inodes.
    pub fn status(&self, project_id: u32) -> Result<ProjectQuotaStatus, ProjectQuotaError> {
        self.expect_status(QuotaHelperRequest::Status { project_id })
    }

    /// Clear quota limits only after zero usage is verified by the helper.
    pub fn clear_empty_project(&self, project_id: u32) -> Result<(), ProjectQuotaError> {
        self.expect_ok(QuotaHelperRequest::ClearEmpty { project_id })
    }

    fn expect_ok(&self, request: QuotaHelperRequest) -> Result<(), ProjectQuotaError> {
        match self.call(request)? {
            QuotaHelperResponse::Ok => Ok(()),
            QuotaHelperResponse::Error(message) => Err(ProjectQuotaError::Protocol(message)),
            QuotaHelperResponse::Status(_) => Err(ProjectQuotaError::Protocol(
                "quota helper returned an unexpected status payload".into(),
            )),
        }
    }

    fn expect_status(
        &self,
        request: QuotaHelperRequest,
    ) -> Result<ProjectQuotaStatus, ProjectQuotaError> {
        match self.call(request)? {
            QuotaHelperResponse::Status(status) => Ok(status),
            QuotaHelperResponse::Error(message) => Err(ProjectQuotaError::Protocol(message)),
            QuotaHelperResponse::Ok => Err(ProjectQuotaError::Protocol(
                "quota helper omitted its status payload".into(),
            )),
        }
    }

    fn call(&self, request: QuotaHelperRequest) -> Result<QuotaHelperResponse, ProjectQuotaError> {
        let mut stream = UnixStream::connect(&self.socket_path)?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        let payload = serde_json::to_vec(&request)
            .map_err(|error| ProjectQuotaError::Protocol(error.to_string()))?;
        if payload.is_empty() || payload.len() > MAX_HELPER_FRAME_BYTES {
            return Err(ProjectQuotaError::Protocol(
                "quota helper request exceeded frame limit".into(),
            ));
        }
        stream.write_all(&(payload.len() as u32).to_be_bytes())?;
        stream.write_all(&payload)?;
        stream.flush()?;
        let mut length = [0_u8; 4];
        stream.read_exact(&mut length)?;
        let length = u32::from_be_bytes(length) as usize;
        if length == 0 || length > MAX_HELPER_FRAME_BYTES {
            return Err(ProjectQuotaError::Protocol(
                "quota helper response exceeded frame limit".into(),
            ));
        }
        let mut response = vec![0_u8; length];
        stream.read_exact(&mut response)?;
        serde_json::from_slice(&response).map_err(|error| {
            ProjectQuotaError::Protocol(format!("invalid helper response: {error}"))
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(
    tag = "status",
    content = "payload",
    rename_all = "snake_case",
    deny_unknown_fields
)]
enum QuotaHelperResponse {
    Ok,
    Status(ProjectQuotaStatus),
    Error(String),
}

/// Root-owned, append-only registry binding every kernel project ID to the
/// exact worker workspace inode. This prevents a worker from setting or
/// clearing limits for an unrelated project ID and survives helper restarts.
struct ProjectQuotaRegistry {
    connection: Mutex<Connection>,
}

impl ProjectQuotaRegistry {
    fn open(path: impl AsRef<Path>) -> Result<Self, ProjectQuotaError> {
        let path = path.as_ref();
        let parent = path.parent().ok_or(ProjectQuotaError::Invalid(
            "quota registry path has no parent directory",
        ))?;
        let metadata = fs::symlink_metadata(parent)?;
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || metadata.uid() != 0
            || metadata.mode() & 0o077 != 0
        {
            return Err(ProjectQuotaError::Invalid(
                "quota registry directory must be root-owned mode 0700",
            ));
        }
        let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
            | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
            | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW;
        let connection = Connection::open_with_flags(path, flags)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        Self::from_connection(connection)
    }

    fn from_connection(connection: Connection) -> Result<Self, ProjectQuotaError> {
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=FULL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS project_quota_registry(
               project_id INTEGER PRIMARY KEY CHECK(project_id>=10000),
               directory TEXT NOT NULL UNIQUE,
               device INTEGER NOT NULL CHECK(device>=0),
               inode INTEGER NOT NULL CHECK(inode>=0),
               byte_limit INTEGER CHECK(byte_limit>0),
               inode_limit INTEGER CHECK(inode_limit>0),
               state TEXT NOT NULL CHECK(state IN ('ASSIGNING','ACTIVE','RELEASED')),
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               CHECK((byte_limit IS NULL AND inode_limit IS NULL)
                  OR (byte_limit IS NOT NULL AND inode_limit IS NOT NULL))
             );
             CREATE TRIGGER IF NOT EXISTS project_quota_registry_identity_immutable
             BEFORE UPDATE OF project_id,directory,device,inode,created_at
             ON project_quota_registry
             BEGIN SELECT RAISE(ABORT,'project quota registry identity is immutable'); END;
             CREATE TRIGGER IF NOT EXISTS project_quota_registry_no_delete
             BEFORE DELETE ON project_quota_registry
             BEGIN SELECT RAISE(ABORT,'project quota registry is append-only'); END;
             CREATE TRIGGER IF NOT EXISTS project_quota_registry_limits_immutable
             BEFORE UPDATE OF byte_limit,inode_limit ON project_quota_registry
             WHEN OLD.byte_limit IS NOT NULL OR OLD.inode_limit IS NOT NULL
             BEGIN SELECT RAISE(ABORT,'project quota limits are immutable'); END;
             CREATE TRIGGER IF NOT EXISTS project_quota_registry_state_monotonic
             BEFORE UPDATE OF state ON project_quota_registry
             WHEN NOT ((OLD.state='ASSIGNING' AND NEW.state='ACTIVE')
                    OR (OLD.state='ACTIVE' AND NEW.state='RELEASED')
                    OR OLD.state=NEW.state)
             BEGIN SELECT RAISE(ABORT,'project quota state transition is not monotonic'); END;",
        )?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    fn reserve_assignment(
        &self,
        project_id: u32,
        directory: &Path,
        device: u64,
        inode: u64,
    ) -> Result<(), ProjectQuotaError> {
        if device > i64::MAX as u64 || inode > i64::MAX as u64 {
            return Err(ProjectQuotaError::Invalid(
                "workspace device or inode exceeds SQLite range",
            ));
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| ProjectQuotaError::Protocol("quota registry lock poisoned".into()))?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(String, i64, i64, String)> = tx
            .query_row(
                "SELECT directory,device,inode,state FROM project_quota_registry WHERE project_id=?1",
                [project_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        match existing {
            Some((existing_path, existing_device, existing_inode, state))
                if existing_path == directory.to_string_lossy()
                    && existing_device == device as i64
                    && existing_inode == inode as i64
                    && state != "RELEASED" => {}
            Some(_) => {
                return Err(ProjectQuotaError::Protocol(
                    "project ID is already permanently bound to another workspace".into(),
                ));
            }
            None => {
                let now = chrono::Utc::now().to_rfc3339();
                tx.execute(
                    "INSERT INTO project_quota_registry(project_id,directory,device,inode,state,created_at,updated_at) VALUES(?1,?2,?3,?4,'ASSIGNING',?5,?5)",
                    params![project_id,directory.to_string_lossy(),device as i64,inode as i64,now],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    fn activate(
        &self,
        project_id: u32,
        directory: &Path,
        device: u64,
        inode: u64,
    ) -> Result<(), ProjectQuotaError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| ProjectQuotaError::Protocol("quota registry lock poisoned".into()))?;
        let changed = connection.execute(
            "UPDATE project_quota_registry SET state='ACTIVE',updated_at=?5 WHERE project_id=?1 AND directory=?2 AND device=?3 AND inode=?4 AND state IN ('ASSIGNING','ACTIVE')",
            params![project_id,directory.to_string_lossy(),device as i64,inode as i64,chrono::Utc::now().to_rfc3339()],
        )?;
        if changed != 1 {
            return Err(ProjectQuotaError::Protocol(
                "quota registry assignment activation lost compare-and-set".into(),
            ));
        }
        Ok(())
    }

    fn require_active(
        &self,
        project_id: u32,
        directory: Option<&Path>,
        identity: Option<(u64, u64)>,
    ) -> Result<PathBuf, ProjectQuotaError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| ProjectQuotaError::Protocol("quota registry lock poisoned".into()))?;
        let row: Option<(String, i64, i64, String)> = connection
            .query_row(
                "SELECT directory,device,inode,state FROM project_quota_registry WHERE project_id=?1",
                [project_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((raw_path, device, inode, state)) = row else {
            return Err(ProjectQuotaError::Protocol(
                "project ID is not registered by this helper".into(),
            ));
        };
        if state != "ACTIVE"
            || directory.is_some_and(|path| path != Path::new(&raw_path))
            || identity.is_some_and(|(dev, ino)| dev != device as u64 || ino != inode as u64)
        {
            return Err(ProjectQuotaError::Protocol(
                "project ID is not bound to the requested active workspace".into(),
            ));
        }
        Ok(PathBuf::from(raw_path))
    }

    fn reserve_limits(
        &self,
        project_id: u32,
        directory: &Path,
        device: u64,
        inode: u64,
        limits: ProjectQuotaLimits,
    ) -> Result<(), ProjectQuotaError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| ProjectQuotaError::Protocol("quota registry lock poisoned".into()))?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<RegistryLimitsRow> = tx
            .query_row(
                "SELECT directory,device,inode,byte_limit,inode_limit,state FROM project_quota_registry WHERE project_id=?1",
                [project_id],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
            )
            .optional()?;
        let Some((path, stored_device, stored_inode, stored_bytes, stored_inodes, state)) =
            existing
        else {
            return Err(ProjectQuotaError::Protocol(
                "project ID is not registered".into(),
            ));
        };
        if path != directory.to_string_lossy()
            || stored_device != device as i64
            || stored_inode != inode as i64
            || state != "ACTIVE"
        {
            return Err(ProjectQuotaError::Protocol(
                "project quota limit request does not match the active workspace".into(),
            ));
        }
        match (stored_bytes, stored_inodes) {
            (None, None) => {
                tx.execute(
                    "UPDATE project_quota_registry SET byte_limit=?2,inode_limit=?3,updated_at=?4 WHERE project_id=?1 AND byte_limit IS NULL AND inode_limit IS NULL",
                    params![project_id,limits.bytes as i64,limits.inodes as i64,chrono::Utc::now().to_rfc3339()],
                )?;
            }
            (Some(bytes), Some(inodes))
                if bytes == limits.bytes as i64 && inodes == limits.inodes as i64 => {}
            _ => {
                return Err(ProjectQuotaError::Protocol(
                    "project quota limits are immutable after first reservation".into(),
                ));
            }
        }
        tx.commit()?;
        Ok(())
    }

    fn verify_limits(
        &self,
        project_id: u32,
        limits: ProjectQuotaLimits,
    ) -> Result<(), ProjectQuotaError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| ProjectQuotaError::Protocol("quota registry lock poisoned".into()))?;
        let expected: Option<(Option<i64>, Option<i64>, String)> = connection
            .query_row(
                "SELECT byte_limit,inode_limit,state FROM project_quota_registry WHERE project_id=?1",
                [project_id],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
            )
            .optional()?;
        if expected
            != Some((
                Some(limits.bytes as i64),
                Some(limits.inodes as i64),
                "ACTIVE".into(),
            ))
        {
            return Err(ProjectQuotaError::Protocol(
                "requested limits differ from the immutable project quota reservation".into(),
            ));
        }
        Ok(())
    }

    fn release(
        &self,
        project_id: u32,
        controller: &ProjectQuotaController,
    ) -> Result<(), ProjectQuotaError> {
        let directory = self.require_active(project_id, None, None)?;
        self.verify_limits_for_release(project_id)?;
        match fs::symlink_metadata(&directory) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Ok(_) => {
                return Err(ProjectQuotaError::Protocol(
                    "workspace directory must be removed before project quota release".into(),
                ));
            }
            Err(error) => return Err(error.into()),
        }
        let status = controller.status(project_id)?;
        if status.bytes_used != 0 || status.inodes_used != 0 {
            return Err(ProjectQuotaError::Protocol(format!(
                "project {project_id} remains charged: {} bytes and {} inodes",
                status.bytes_used, status.inodes_used
            )));
        }
        controller.clear_empty_project(project_id)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| ProjectQuotaError::Protocol("quota registry lock poisoned".into()))?;
        let changed = connection.execute(
            "UPDATE project_quota_registry SET state='RELEASED',updated_at=?2 WHERE project_id=?1 AND state='ACTIVE'",
            params![project_id,chrono::Utc::now().to_rfc3339()],
        )?;
        if changed != 1 {
            return Err(ProjectQuotaError::Protocol(
                "project quota release lost compare-and-set".into(),
            ));
        }
        Ok(())
    }

    fn verify_limits_for_release(&self, project_id: u32) -> Result<(), ProjectQuotaError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| ProjectQuotaError::Protocol("quota registry lock poisoned".into()))?;
        let limits: Option<(Option<i64>, Option<i64>)> = connection
            .query_row(
                "SELECT byte_limit,inode_limit FROM project_quota_registry WHERE project_id=?1 AND state='ACTIVE'",
                [project_id],
                |row| Ok((row.get(0)?,row.get(1)?)),
            )
            .optional()?;
        if !matches!(limits, Some((Some(_), Some(_)))) {
            return Err(ProjectQuotaError::Protocol(
                "cannot release a project without an immutable quota reservation".into(),
            ));
        }
        Ok(())
    }
}

/// Serve one request at a time from a systemd socket-activated privileged helper.
/// The socket's owner/group/mode are configured by the accompanying `.socket`
/// unit. Every connection is additionally checked using SO_PEERCRED.
pub fn serve_systemd_quota_helper(
    root: impl AsRef<Path>,
    registry_path: impl AsRef<Path>,
    allowed_worker_uid: u32,
    maximum_limits: ProjectQuotaLimits,
) -> Result<(), ProjectQuotaError> {
    let listen_pid = std::env::var("LISTEN_PID")
        .ok()
        .and_then(|value| value.parse::<u32>().ok());
    let listen_fds = std::env::var("LISTEN_FDS")
        .ok()
        .and_then(|value| value.parse::<u32>().ok());
    if listen_pid != Some(std::process::id()) || listen_fds != Some(1) {
        return Err(ProjectQuotaError::Protocol(
            "quota helper requires exactly one systemd-activated socket".into(),
        ));
    }
    let controller = ProjectQuotaController::open(root)?;
    let canonical_root = controller.root().to_owned();
    let registry = ProjectQuotaRegistry::open(registry_path)?;
    // SAFETY: systemd passes the listening Unix socket as descriptor 3 when
    // LISTEN_PID and LISTEN_FDS match this process. Ownership transfers to the
    // returned listener, which closes the descriptor on drop.
    let listener = unsafe { UnixListener::from_raw_fd(3) };
    for incoming in listener.incoming() {
        let mut stream = incoming?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        let peer_uid = peer_uid(&stream)?;
        let response = if peer_uid != allowed_worker_uid {
            QuotaHelperResponse::Error("worker peer UID is not authorized".into())
        } else {
            match read_request(&mut stream) {
                Ok(request) => handle_quota_request(
                    &controller,
                    &registry,
                    &canonical_root,
                    allowed_worker_uid,
                    maximum_limits,
                    request,
                ),
                Err(error) => QuotaHelperResponse::Error(error.to_string()),
            }
        };
        write_response(&mut stream, &response)?;
    }
    Ok(())
}

fn handle_quota_request(
    controller: &ProjectQuotaController,
    registry: &ProjectQuotaRegistry,
    root: &Path,
    allowed_worker_uid: u32,
    maximum_limits: ProjectQuotaLimits,
    request: QuotaHelperRequest,
) -> QuotaHelperResponse {
    let result = (|| -> Result<QuotaHelperResponse, ProjectQuotaError> {
        match request {
            QuotaHelperRequest::Probe => Ok(QuotaHelperResponse::Ok),
            QuotaHelperRequest::AssignProjectId {
                directory,
                project_id,
            } => {
                validate_project_id(project_id)?;
                let directory = validate_helper_workspace_path(
                    root,
                    &directory,
                    project_id,
                    allowed_worker_uid,
                )?;
                let quota_before_assignment = controller.status(project_id)?;
                if quota_before_assignment.bytes_hard_limit != 0
                    || quota_before_assignment.inodes_hard_limit != 0
                    || quota_before_assignment.bytes_used != 0
                    || quota_before_assignment.inodes_used != 0
                {
                    return Err(ProjectQuotaError::Protocol(
                        "project ID already has quota limits or charged filesystem objects".into(),
                    ));
                }
                let metadata = fs::metadata(&directory)?;
                registry.reserve_assignment(
                    project_id,
                    &directory,
                    metadata.dev(),
                    metadata.ino(),
                )?;
                controller.assign_project_id_exact(
                    &directory,
                    project_id,
                    (metadata.dev(), metadata.ino()),
                )?;
                registry.activate(project_id, &directory, metadata.dev(), metadata.ino())?;
                Ok(QuotaHelperResponse::Ok)
            }
            QuotaHelperRequest::SetHardLimits {
                directory,
                project_id,
                limits,
            } => {
                validate_project_id(project_id)?;
                validate_helper_limits(limits, maximum_limits)?;
                let directory = validate_helper_workspace_path(
                    root,
                    &directory,
                    project_id,
                    allowed_worker_uid,
                )?;
                let metadata = fs::metadata(&directory)?;
                registry.require_active(
                    project_id,
                    Some(&directory),
                    Some((metadata.dev(), metadata.ino())),
                )?;
                registry.reserve_limits(
                    project_id,
                    &directory,
                    metadata.dev(),
                    metadata.ino(),
                    limits,
                )?;
                controller.set_hard_limits_exact(
                    directory,
                    project_id,
                    limits,
                    (metadata.dev(), metadata.ino()),
                )?;
                Ok(QuotaHelperResponse::Ok)
            }
            QuotaHelperRequest::VerifyDirectory {
                directory,
                project_id,
            } => {
                validate_project_id(project_id)?;
                let directory = validate_helper_workspace_path(
                    root,
                    &directory,
                    project_id,
                    allowed_worker_uid,
                )?;
                let metadata = fs::metadata(&directory)?;
                registry.require_active(
                    project_id,
                    Some(&directory),
                    Some((metadata.dev(), metadata.ino())),
                )?;
                controller.verify_directory_exact(
                    directory,
                    project_id,
                    (metadata.dev(), metadata.ino()),
                )?;
                Ok(QuotaHelperResponse::Ok)
            }
            QuotaHelperRequest::VerifyHardLimits {
                directory,
                project_id,
                limits,
            } => {
                validate_project_id(project_id)?;
                validate_helper_limits(limits, maximum_limits)?;
                let directory = validate_helper_workspace_path(
                    root,
                    &directory,
                    project_id,
                    allowed_worker_uid,
                )?;
                let metadata = fs::metadata(&directory)?;
                registry.require_active(
                    project_id,
                    Some(&directory),
                    Some((metadata.dev(), metadata.ino())),
                )?;
                registry.verify_limits(project_id, limits)?;
                Ok(QuotaHelperResponse::Status(
                    controller.verify_hard_limits_exact(
                        directory,
                        project_id,
                        limits,
                        (metadata.dev(), metadata.ino()),
                    )?,
                ))
            }
            QuotaHelperRequest::Status { project_id } => {
                validate_project_id(project_id)?;
                registry.require_active(project_id, None, None)?;
                registry.verify_limits_for_release(project_id)?;
                Ok(QuotaHelperResponse::Status(controller.status(project_id)?))
            }
            QuotaHelperRequest::ClearEmpty { project_id } => {
                validate_project_id(project_id)?;
                registry.release(project_id, controller)?;
                Ok(QuotaHelperResponse::Ok)
            }
        }
    })();
    result.unwrap_or_else(|error| QuotaHelperResponse::Error(error.to_string()))
}

fn validate_project_id(project_id: u32) -> Result<(), ProjectQuotaError> {
    if !(PROJECT_ID_MIN..=i32::MAX as u32).contains(&project_id) {
        return Err(ProjectQuotaError::Invalid(
            "project ID is outside worker range",
        ));
    }
    Ok(())
}

fn validate_helper_limits(
    limits: ProjectQuotaLimits,
    maximum: ProjectQuotaLimits,
) -> Result<(), ProjectQuotaError> {
    if limits.bytes == 0
        || limits.inodes == 0
        || limits.bytes > i64::MAX as u64
        || limits.inodes > i64::MAX as u64
        || limits.bytes > maximum.bytes
        || limits.inodes > maximum.inodes
    {
        return Err(ProjectQuotaError::Invalid(
            "requested project quota exceeds helper policy",
        ));
    }
    Ok(())
}

fn validate_helper_workspace_path(
    root: &Path,
    raw: &str,
    project_id: u32,
    allowed_worker_uid: u32,
) -> Result<PathBuf, ProjectQuotaError> {
    let path = Path::new(raw);
    if !path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err(ProjectQuotaError::Invalid(
            "workspace path must be normalized and absolute",
        ));
    }
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != allowed_worker_uid
        || metadata.mode() & 0o022 != 0
    {
        return Err(ProjectQuotaError::Invalid(
            "workspace path is not a private worker-owned directory",
        ));
    }
    let expected_parent = root.join(".runalith-executions");
    let parent_metadata = fs::symlink_metadata(&expected_parent)?;
    if parent_metadata.file_type().is_symlink()
        || !parent_metadata.is_dir()
        || parent_metadata.uid() != allowed_worker_uid
        || parent_metadata.mode() & 0o077 != 0
    {
        return Err(ProjectQuotaError::Invalid(
            "execution workspace parent is not a private worker-owned directory",
        ));
    }
    let canonical = fs::canonicalize(path)?;
    if !canonical.starts_with(root) || canonical == root {
        return Err(ProjectQuotaError::Invalid(
            "workspace path escaped configured quota root",
        ));
    }
    let canonical_parent = fs::canonicalize(&expected_parent)?;
    if canonical.parent() != Some(canonical_parent.as_path())
        || canonical.file_name().and_then(|name| name.to_str())
            != Some(format!("execution-{project_id}").as_str())
    {
        return Err(ProjectQuotaError::Invalid(
            "workspace path does not match its unique project ID slot",
        ));
    }
    Ok(canonical)
}

fn read_request(stream: &mut UnixStream) -> Result<QuotaHelperRequest, ProjectQuotaError> {
    let mut length = [0_u8; 4];
    stream.read_exact(&mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_HELPER_FRAME_BYTES {
        return Err(ProjectQuotaError::Protocol(
            "invalid request frame length".into(),
        ));
    }
    let mut payload = vec![0_u8; length];
    stream.read_exact(&mut payload)?;
    serde_json::from_slice(&payload)
        .map_err(|error| ProjectQuotaError::Protocol(format!("invalid request JSON: {error}")))
}

fn write_response(
    stream: &mut UnixStream,
    response: &QuotaHelperResponse,
) -> Result<(), ProjectQuotaError> {
    let payload = serde_json::to_vec(response)
        .map_err(|error| ProjectQuotaError::Protocol(error.to_string()))?;
    if payload.is_empty() || payload.len() > MAX_HELPER_FRAME_BYTES {
        return Err(ProjectQuotaError::Protocol(
            "response frame exceeds limit".into(),
        ));
    }
    stream.write_all(&(payload.len() as u32).to_be_bytes())?;
    stream.write_all(&payload)?;
    stream.flush()?;
    Ok(())
}

fn peer_uid(stream: &UnixStream) -> Result<u32, ProjectQuotaError> {
    // SAFETY: `ucred` is a kernel-defined POD output structure and `length`
    // describes exactly that structure for getsockopt(SO_PEERCRED).
    let mut credentials = unsafe { std::mem::zeroed::<libc::ucred>() };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: the socket fd is valid for the duration of this call and both
    // output pointers reference initialized, writable storage of the right size.
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut length,
        )
    };
    if result != 0 || length as usize != std::mem::size_of::<libc::ucred>() {
        return Err(ProjectQuotaError::Io(io::Error::last_os_error()));
    }
    Ok(credentials.uid)
}

#[repr(C)]
#[derive(Debug, Default)]
struct IfDqblk {
    byte_hard_limit: u64,
    byte_soft_limit: u64,
    current_bytes: u64,
    inode_hard_limit: u64,
    inode_soft_limit: u64,
    current_inodes: u64,
    byte_grace: u64,
    inode_grace: u64,
    valid: u32,
}

#[repr(C)]
#[derive(Debug, Default)]
struct Fsxattr {
    xflags: u32,
    extent_size: u32,
    next_extents: u32,
    project_id: u32,
    cow_extent_size: u32,
    padding: [u8; 8],
}

fn open_directory(path: &Path) -> Result<File, ProjectQuotaError> {
    Ok(OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?)
}

fn verify_file_identity(
    file: &File,
    expected: Option<(u64, u64)>,
) -> Result<(), ProjectQuotaError> {
    if let Some((expected_device, expected_inode)) = expected {
        let metadata = file.metadata()?;
        if metadata.dev() != expected_device || metadata.ino() != expected_inode {
            return Err(ProjectQuotaError::Unsupported(
                "workspace device/inode changed after quota registry validation".into(),
            ));
        }
    }
    Ok(())
}

fn get_fsxattr(file: &File) -> Result<Fsxattr, ProjectQuotaError> {
    let mut attributes = Fsxattr::default();
    // SAFETY: `file` is an open directory descriptor and `attributes` is the
    // kernel-defined repr(C) fsxattr output structure.
    let result = unsafe {
        libc::ioctl(
            file.as_raw_fd(),
            FS_IOC_FSGETXATTR,
            &mut attributes as *mut Fsxattr,
        )
    };
    if result != 0 {
        return Err(ProjectQuotaError::Io(io::Error::last_os_error()));
    }
    Ok(attributes)
}

fn set_fsxattr(file: &File, attributes: &Fsxattr) -> Result<(), ProjectQuotaError> {
    // SAFETY: `file` is an open directory descriptor and `attributes` is the
    // kernel-defined repr(C) fsxattr input structure.
    let result = unsafe {
        libc::ioctl(
            file.as_raw_fd(),
            FS_IOC_FSSETXATTR,
            attributes as *const Fsxattr,
        )
    };
    if result != 0 {
        return Err(ProjectQuotaError::Io(io::Error::last_os_error()));
    }
    Ok(())
}

fn find_mount(path: &Path) -> Result<Mount, ProjectQuotaError> {
    let content = fs::read_to_string("/proc/self/mountinfo")?;
    content
        .lines()
        .filter_map(parse_mountinfo_line)
        .filter(|mount| path.starts_with(&mount.mount_point))
        .max_by_key(|mount| mount.mount_point.components().count())
        .ok_or_else(|| ProjectQuotaError::Unsupported("workspace mount was not found".into()))
}

fn parse_mountinfo_line(line: &str) -> Option<Mount> {
    let (left, right) = line.split_once(" - ")?;
    let left = left.split_whitespace().collect::<Vec<_>>();
    let right = right.split_whitespace().collect::<Vec<_>>();
    if left.len() < 6 || right.len() < 3 {
        return None;
    }
    let mount_point = PathBuf::from(unescape_mount_field(left[4]));
    let mut options = left[5]
        .split(',')
        .chain(right[2].split(','))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    options.sort();
    options.dedup();
    Some(Mount {
        mount_point,
        filesystem: right[0].to_owned(),
        source: unescape_mount_field(right[1]),
        options,
    })
}

fn unescape_mount_field(value: &str) -> String {
    value
        .replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn mountinfo_parser_requires_a_project_quota_mount_option() {
        let mount = parse_mountinfo_line(
            "42 1 253:0 / /srv/runalith rw,relatime,prjquota shared:1 - ext4 /dev/mapper/data rw,errors=remount-ro,prjquota",
        )
        .unwrap();
        assert_eq!(mount.mount_point, PathBuf::from("/srv/runalith"));
        assert_eq!(mount.filesystem, "ext4");
        assert_eq!(mount.source, "/dev/mapper/data");
        assert!(mount.options.contains(&"prjquota".into()));
    }

    #[test]
    fn mountinfo_parser_unescapes_mount_paths_and_device_names() {
        let mount = parse_mountinfo_line(
            "42 1 253:0 / /srv/runalith\\040worker rw,relatime,pquota - xfs /dev/mapper/runalith\\040data rw,pquota",
        )
        .unwrap();
        assert_eq!(mount.mount_point, PathBuf::from("/srv/runalith worker"));
        assert_eq!(mount.source, "/dev/mapper/runalith data");
    }

    #[test]
    fn invalid_mountinfo_is_rejected() {
        assert!(parse_mountinfo_line("not a mount line").is_none());
    }

    #[test]
    fn quota_limits_round_up_to_kernel_quota_block_size() {
        assert_eq!(
            ProjectQuotaLimits {
                bytes: 1,
                inodes: 1
            }
            .bytes
            .div_ceil(1024),
            1
        );
        assert_eq!(
            ProjectQuotaLimits {
                bytes: 1024,
                inodes: 1
            }
            .bytes
            .div_ceil(1024),
            1
        );
        assert_eq!(
            ProjectQuotaLimits {
                bytes: 1025,
                inodes: 1
            }
            .bytes
            .div_ceil(1024),
            2
        );
    }

    #[test]
    fn helper_workspace_path_is_bound_to_worker_owned_private_descendant() {
        let root = tempfile::tempdir().unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let parent = root.path().join(".runalith-executions");
        fs::create_dir(&parent).unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
        let workspace = parent.join("execution-10000");
        fs::create_dir(&workspace).unwrap();
        fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
        let uid = fs::metadata(&workspace).unwrap().uid();
        assert_eq!(
            validate_helper_workspace_path(root.path(), workspace.to_str().unwrap(), 10_000, uid)
                .unwrap(),
            workspace
        );
        assert!(
            validate_helper_workspace_path(
                root.path(),
                workspace.to_str().unwrap(),
                10_000,
                uid.wrapping_add(1)
            )
            .is_err()
        );
        assert!(
            validate_helper_workspace_path(root.path(), workspace.to_str().unwrap(), 10_001, uid)
                .is_err()
        );
        assert!(validate_helper_workspace_path(root.path(), "../outside", 10_000, uid).is_err());
        assert!(
            validate_helper_workspace_path(root.path(), root.path().to_str().unwrap(), 10_000, uid)
                .is_err()
        );
    }

    #[test]
    fn helper_rejects_quota_requests_above_root_owned_policy() {
        let maximum = ProjectQuotaLimits {
            bytes: 1024 * 1024,
            inodes: 100,
        };
        assert!(
            validate_helper_limits(
                ProjectQuotaLimits {
                    bytes: maximum.bytes + 1,
                    inodes: 10
                },
                maximum
            )
            .is_err()
        );
        assert!(
            validate_helper_limits(
                ProjectQuotaLimits {
                    bytes: 1024,
                    inodes: maximum.inodes + 1
                },
                maximum
            )
            .is_err()
        );
    }

    #[test]
    fn unix_quota_client_uses_length_bounded_peer_helper_protocol_and_binds_path() {
        let directory = tempfile::tempdir().unwrap();
        let socket_path = directory.path().join("quota.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        let expected_path = directory.path().join("execution-10000");
        let server_path = expected_path.clone();
        let server = std::thread::spawn(move || {
            let (mut probe, _) = listener.accept().unwrap();
            assert!(matches!(
                read_request(&mut probe).unwrap(),
                QuotaHelperRequest::Probe
            ));
            write_response(&mut probe, &QuotaHelperResponse::Ok).unwrap();

            let (mut request, _) = listener.accept().unwrap();
            match read_request(&mut request).unwrap() {
                QuotaHelperRequest::SetHardLimits {
                    directory,
                    project_id,
                    limits,
                } => {
                    assert_eq!(directory, server_path.to_string_lossy());
                    assert_eq!(project_id, PROJECT_ID_MIN);
                    assert_eq!(limits.bytes, 512 * 1024);
                    assert_eq!(limits.inodes, 64);
                }
                request => panic!("unexpected helper request: {request:?}"),
            }
            write_response(&mut request, &QuotaHelperResponse::Ok).unwrap();
        });

        let client = UnixProjectQuotaBackend::connect(&socket_path).unwrap();
        client
            .set_hard_limits(
                &expected_path,
                PROJECT_ID_MIN,
                ProjectQuotaLimits {
                    bytes: 512 * 1024,
                    inodes: 64,
                },
            )
            .unwrap();
        server.join().unwrap();
    }

    #[test]
    fn helper_workspace_path_is_bound_to_unique_project_slot_and_private_parent() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("quota-root");
        let parent = root.join(".runalith-executions");
        let workspace = parent.join("execution-10000");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&parent).unwrap();
        fs::create_dir(&workspace).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o750)).unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
        let uid = fs::metadata(&workspace).unwrap().uid();

        assert_eq!(
            validate_helper_workspace_path(&root, workspace.to_str().unwrap(), 10_000, uid)
                .unwrap(),
            workspace
        );
        assert!(
            validate_helper_workspace_path(&root, workspace.to_str().unwrap(), 10_001, uid)
                .is_err()
        );
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o770)).unwrap();
        assert!(
            validate_helper_workspace_path(&root, workspace.to_str().unwrap(), 10_000, uid)
                .is_err()
        );
    }

    #[test]
    fn quota_registry_binds_project_id_to_immutable_inode_and_limits() {
        use std::os::unix::fs::MetadataExt;

        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("execution-10000");
        fs::create_dir(&workspace).unwrap();
        let metadata = fs::metadata(&workspace).unwrap();
        let registry = ProjectQuotaRegistry::from_connection(
            Connection::open(directory.path().join("registry.db")).unwrap(),
        )
        .unwrap();
        registry
            .reserve_assignment(10_000, &workspace, metadata.dev(), metadata.ino())
            .unwrap();
        assert!(
            registry
                .require_active(
                    10_000,
                    Some(&workspace),
                    Some((metadata.dev(), metadata.ino()))
                )
                .is_err()
        );
        registry
            .activate(10_000, &workspace, metadata.dev(), metadata.ino())
            .unwrap();
        registry
            .require_active(
                10_000,
                Some(&workspace),
                Some((metadata.dev(), metadata.ino())),
            )
            .unwrap();
        let limits = ProjectQuotaLimits {
            bytes: 1024 * 1024,
            inodes: 4096,
        };
        registry
            .reserve_limits(10_000, &workspace, metadata.dev(), metadata.ino(), limits)
            .unwrap();
        registry.verify_limits(10_000, limits).unwrap();
        assert!(
            registry
                .reserve_limits(
                    10_000,
                    &workspace,
                    metadata.dev(),
                    metadata.ino(),
                    ProjectQuotaLimits {
                        bytes: 2 * 1024 * 1024,
                        inodes: 4096,
                    }
                )
                .is_err()
        );

        let changed_identity = metadata.ino().saturating_add(1);
        assert!(
            registry
                .require_active(
                    10_000,
                    Some(&workspace),
                    Some((metadata.dev(), changed_identity))
                )
                .is_err()
        );

        let other = directory.path().join("execution-10001");
        fs::create_dir(&other).unwrap();
        let other_metadata = fs::metadata(&other).unwrap();
        assert!(
            registry
                .reserve_assignment(10_000, &other, other_metadata.dev(), other_metadata.ino())
                .is_err()
        );
    }

    #[test]
    fn quota_registry_serializes_assignment_across_connections_and_recovers_after_restart() {
        use std::{
            sync::{Arc, Barrier},
            thread,
        };

        use std::os::unix::fs::MetadataExt;

        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("execution-10000");
        fs::create_dir(&workspace).unwrap();
        let metadata = fs::metadata(&workspace).unwrap();
        let device = metadata.dev();
        let inode = metadata.ino();
        let registry_path = directory.path().join("registry.db");
        let first = Arc::new(
            ProjectQuotaRegistry::from_connection(Connection::open(&registry_path).unwrap())
                .unwrap(),
        );
        let second = Arc::new(
            ProjectQuotaRegistry::from_connection(Connection::open(&registry_path).unwrap())
                .unwrap(),
        );

        // Two independent SQLite connections may retry the exact same
        // ASSIGNING record after an ambiguous helper response. They must bind
        // one immutable project ID to one device/inode, never create a second
        // reservation or let the conflicting path win.
        let barrier = Arc::new(Barrier::new(3));
        let left = {
            let registry = first.clone();
            let barrier = barrier.clone();
            let workspace = workspace.clone();
            thread::spawn(move || {
                barrier.wait();
                registry.reserve_assignment(10_000, &workspace, device, inode)
            })
        };
        let right = {
            let registry = second.clone();
            let barrier = barrier.clone();
            let workspace = workspace.clone();
            thread::spawn(move || {
                barrier.wait();
                registry.reserve_assignment(10_000, &workspace, device, inode)
            })
        };
        barrier.wait();
        left.join().unwrap().unwrap();
        right.join().unwrap().unwrap();

        let conflicting_workspace = directory.path().join("execution-conflicting");
        fs::create_dir(&conflicting_workspace).unwrap();
        let conflicting_metadata = fs::metadata(&conflicting_workspace).unwrap();
        assert!(
            second
                .reserve_assignment(
                    10_000,
                    &conflicting_workspace,
                    conflicting_metadata.dev(),
                    conflicting_metadata.ino(),
                )
                .is_err()
        );

        // Two different worker-owned directories racing for a fresh project
        // ID must not both succeed or overwrite the winner's binding.
        let competing_left = directory.path().join("execution-10001-left");
        let competing_right = directory.path().join("execution-10001-right");
        fs::create_dir(&competing_left).unwrap();
        fs::create_dir(&competing_right).unwrap();
        let left_metadata = fs::metadata(&competing_left).unwrap();
        let right_metadata = fs::metadata(&competing_right).unwrap();
        let (left_device, left_inode) = (left_metadata.dev(), left_metadata.ino());
        let (right_device, right_inode) = (right_metadata.dev(), right_metadata.ino());
        let barrier = Arc::new(Barrier::new(3));
        let left = {
            let registry = first.clone();
            let barrier = barrier.clone();
            let path = competing_left.clone();
            let binding_path = path.to_string_lossy().into_owned();
            thread::spawn(move || {
                barrier.wait();
                let result = registry.reserve_assignment(10_001, &path, left_device, left_inode);
                (binding_path, left_device, left_inode, result)
            })
        };
        let right = {
            let registry = second.clone();
            let barrier = barrier.clone();
            let path = competing_right.clone();
            let binding_path = path.to_string_lossy().into_owned();
            thread::spawn(move || {
                barrier.wait();
                let result = registry.reserve_assignment(10_001, &path, right_device, right_inode);
                (binding_path, right_device, right_inode, result)
            })
        };
        barrier.wait();
        let results = [left.join().unwrap(), right.join().unwrap()];
        assert_eq!(results.iter().filter(|result| result.3.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.3.is_err()).count(), 1);
        let stored_binding: (String, i64, i64) = first
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT directory,device,inode FROM project_quota_registry WHERE project_id=10001",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        let winner = results.iter().find(|result| result.3.is_ok()).unwrap();
        assert_eq!(
            stored_binding,
            (winner.0.clone(), winner.1 as i64, winner.2 as i64),
            "persisted project identity must be the exact winner's path/dev/inode"
        );

        // Simulate a helper crash after persisting ASSIGNING but before the
        // filesystem assignment/activation transaction is acknowledged.
        // Startup must retain that project ID and allow only the exact same
        // inode binding to resume.
        drop(first);
        drop(second);
        let recovering_assignment =
            ProjectQuotaRegistry::from_connection(Connection::open(&registry_path).unwrap())
                .unwrap();
        assert!(
            recovering_assignment
                .require_active(10_000, Some(&workspace), Some((device, inode)))
                .is_err()
        );
        recovering_assignment
            .reserve_assignment(10_000, &workspace, device, inode)
            .unwrap();
        recovering_assignment
            .activate(10_000, &workspace, device, inode)
            .unwrap();
        let limits = ProjectQuotaLimits {
            bytes: 2 * 1024 * 1024,
            inodes: 2048,
        };
        recovering_assignment
            .reserve_limits(10_000, &workspace, device, inode, limits)
            .unwrap();
        drop(recovering_assignment);

        let reopened =
            ProjectQuotaRegistry::from_connection(Connection::open(&registry_path).unwrap())
                .unwrap();
        reopened
            .require_active(10_000, Some(&workspace), Some((device, inode)))
            .unwrap();
        reopened.verify_limits(10_000, limits).unwrap();

        // The registry's RELEASED transition is terminal. A freed kernel
        // quota ID is deliberately not handed to another workspace because
        // delayed kernel charge/readback or stale file handles must never
        // become attributable to a later execution.
        {
            let connection = reopened.connection.lock().unwrap();
            let changed = connection
                .execute(
                    "UPDATE project_quota_registry SET state='RELEASED',updated_at='test' WHERE project_id=10000 AND state='ACTIVE'",
                    [],
                )
                .unwrap();
            assert_eq!(changed, 1);
        }
        assert!(
            reopened
                .reserve_assignment(10_000, &workspace, device, inode)
                .is_err()
        );
        assert!(
            reopened
                .reserve_assignment(
                    10_000,
                    &conflicting_workspace,
                    conflicting_metadata.dev(),
                    conflicting_metadata.ino(),
                )
                .is_err()
        );
    }
}
