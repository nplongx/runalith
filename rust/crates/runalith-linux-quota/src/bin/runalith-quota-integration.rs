//! Destructive-by-design integration harness for real ext4/XFS project quotas.
//!
//! This binary requires root and a dedicated project-quota-enabled test mount.
//! It never chooses a project ID twice: the private SQLite registry is
//! append-only and IDs are allocated monotonically from a test-only range.

use std::{
    env,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    process::ExitCode,
    thread,
    time::{Duration, Instant},
};

use runalith_linux_quota::{ProjectQuotaController, ProjectQuotaLimits, ProjectQuotaStatus};
use rusqlite::{Connection, params};

const TEST_PROJECT_ID_BASE: u32 = 1_500_000_000;
const TEST_PROJECT_ID_MAX: u32 = 1_700_000_000;
const BYTE_LIMIT: u64 = 128 * 1024;
const BYTE_INODE_LIMIT: u64 = 64;
const INODE_BYTE_LIMIT: u64 = 16 * 1024 * 1024;
const INODE_LIMIT: u64 = 16;
const ERRNO_ENOSPC: i32 = 28;
const ERRNO_EDQUOT: i32 = 122;
const DESTRUCTIVE_ACK_ENV: &str = "RUNALITH_QUOTA_TEST_DESTRUCTIVE_ACK";
const DESTRUCTIVE_ACK_VALUE: &str =
    "I_UNDERSTAND_THIS_MOUNT_WILL_BE_MODIFIED_AND_QUOTA_LIMITS_WILL_BE_EXHAUSTED";
const TEST_MOUNT_MARKER: &str = ".runalith-disposable-quota-test-mount";
const TEST_MOUNT_MARKER_CONTENT: &str = "RUNALITH_DISPOSABLE_PROJECT_QUOTA_TEST_MOUNT_V1\n";
const WORKSPACE_PARENT_NAME: &str = ".runalith-quota-integration";

#[derive(Debug, Clone)]
struct ProjectRecord {
    project_id: u32,
    kind: String,
    workspace: PathBuf,
    device: Option<u64>,
    inode: Option<u64>,
    limits: ProjectQuotaLimits,
    state: String,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("runalith-quota-integration: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mode = env::args().nth(1).unwrap_or_else(|| "--exhaustion".into());
    if !matches!(
        mode.as_str(),
        "--preflight" | "--exhaustion" | "--prepare-recovery" | "--recover-only"
    ) {
        return Err(
            "usage: runalith-quota-integration [--preflight|--exhaustion|--prepare-recovery|--recover-only]"
                .into(),
        );
    }

    let root = PathBuf::from(required("RUNALITH_QUOTA_TEST_ROOT")?);
    let root_metadata = fs::symlink_metadata(&root)?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("RUNALITH_QUOTA_TEST_ROOT must be an existing real directory".into());
    }
    let root = fs::canonicalize(root)?;
    let controller = ProjectQuotaController::open(&root).map_err(|error| {
        format!(
            "kernel quota preflight failed; require ext4/XFS with active prjquota/pquota: {error}"
        )
    })?;
    println!(
        "PREFLIGHT PASS filesystem={} root={}",
        controller.filesystem(),
        root.display()
    );
    if mode == "--preflight" {
        println!("PREFLIGHT ONLY: no project IDs, directories, or quota limits were changed");
        return Ok(());
    }
    validate_destructive_test_mount(
        &root,
        controller.mount_point(),
        env::var(DESTRUCTIVE_ACK_ENV).ok().as_deref(),
        0,
    )
    .map_err(|error| format!("destructive quota test refused: {error}"))?;
    if unsafe { libc::geteuid() } != 0 {
        return Err("must run as root to test kernel project quota enforcement".into());
    }

    let registry_path = PathBuf::from(required("RUNALITH_QUOTA_TEST_REGISTRY")?);
    if registry_path.starts_with(&root) {
        return Err("quota integration registry must be outside the quota test mount".into());
    }
    let registry_parent = registry_path
        .parent()
        .ok_or("quota integration registry path has no parent")?;
    let registry_parent_metadata = fs::symlink_metadata(registry_parent)?;
    let test_root_metadata = fs::metadata(&root)?;
    if registry_parent_metadata.dev() == test_root_metadata.dev() {
        return Err(
            "quota integration registry parent must be on a different filesystem than the test mount".into(),
        );
    }
    let registry = open_registry(&registry_path)?;
    let workspace_parent = root.join(WORKSPACE_PARENT_NAME);
    ensure_private_test_parent(&workspace_parent)?;

    recover_incomplete(&registry, &controller, &workspace_parent)?;
    match mode.as_str() {
        "--recover-only" => {
            println!("RECOVERY PASS all previously reserved test projects reconciled or released");
            return Ok(());
        }
        "--prepare-recovery" => {
            let record = reserve_project(
                &registry,
                &workspace_parent,
                "restart_recovery",
                ProjectQuotaLimits {
                    bytes: 1024 * 1024,
                    inodes: 32,
                },
            )?;
            activate_project(&registry, &controller, &record)?;
            println!(
                "RECOVERY FIXTURE ACTIVE kind={} project_id={} path={}; run --recover-only in a new process after host restart",
                record.kind,
                record.project_id,
                record.workspace.display()
            );
            return Ok(());
        }
        _ => {}
    }

    let byte_record = reserve_project(
        &registry,
        &workspace_parent,
        "byte_exhaustion",
        ProjectQuotaLimits {
            bytes: BYTE_LIMIT,
            inodes: BYTE_INODE_LIMIT,
        },
    )?;
    activate_project(&registry, &controller, &byte_record)?;
    let byte_status = exercise_byte_exhaustion(&controller, &byte_record)?;
    println!(
        "BYTE QUOTA PASS project_id={} used={} hard_limit={}",
        byte_record.project_id, byte_status.bytes_used, byte_status.bytes_hard_limit
    );
    cleanup_project(&registry, &controller, &byte_record)?;

    let inode_record = reserve_project(
        &registry,
        &workspace_parent,
        "inode_exhaustion",
        ProjectQuotaLimits {
            bytes: INODE_BYTE_LIMIT,
            inodes: INODE_LIMIT,
        },
    )?;
    activate_project(&registry, &controller, &inode_record)?;
    let inode_status = exercise_inode_exhaustion(&controller, &inode_record)?;
    println!(
        "INODE QUOTA PASS project_id={} used={} hard_limit={}",
        inode_record.project_id, inode_status.inodes_used, inode_status.inodes_hard_limit
    );
    cleanup_project(&registry, &controller, &inode_record)?;
    println!(
        "KERNEL QUOTA INTEGRATION PASS filesystem={} byte_exhaustion=PASS inode_exhaustion=PASS cleanup=PASS id_reuse=DISABLED",
        controller.filesystem()
    );
    Ok(())
}

/// Require multiple independent safeguards before any mode that can create,
/// exhaust, remove or reconcile project-quota test workspaces.
///
/// The caller supplies the expected owner UID so this policy can be tested
/// without requiring the unit-test process itself to run as root. Production
/// always supplies UID 0.
fn validate_destructive_test_mount(
    root: &Path,
    mount_point: &Path,
    acknowledgement: Option<&str>,
    expected_owner_uid: u32,
) -> Result<(), String> {
    if root == Path::new("/") {
        return Err(
            "the filesystem root (/) is never an allowed destructive quota test target".into(),
        );
    }
    if root != mount_point {
        return Err(format!(
            "quota test root {} must be the exact mount point {}, not a subdirectory",
            root.display(),
            mount_point.display()
        ));
    }
    if acknowledgement != Some(DESTRUCTIVE_ACK_VALUE) {
        return Err(format!(
            "set {DESTRUCTIVE_ACK_ENV} to the exact documented acknowledgement only for a disposable test mount"
        ));
    }

    let root_metadata = fs::symlink_metadata(root).map_err(|error| error.to_string())?;
    if root_metadata.file_type().is_symlink()
        || !root_metadata.is_dir()
        || root_metadata.uid() != expected_owner_uid
        || root_metadata.mode() & 0o7777 != 0o700
    {
        return Err("test mount root must be a real directory owned by the expected owner with exact mode 0700".into());
    }

    let marker_path = root.join(TEST_MOUNT_MARKER);
    let marker_metadata = fs::symlink_metadata(&marker_path).map_err(|_| {
        format!(
            "missing required root-owned marker file {}",
            marker_path.display()
        )
    })?;
    if marker_metadata.file_type().is_symlink()
        || !marker_metadata.is_file()
        || marker_metadata.uid() != expected_owner_uid
        || marker_metadata.mode() & 0o7777 != 0o600
        || marker_metadata.len() != TEST_MOUNT_MARKER_CONTENT.len() as u64
    {
        return Err("test mount marker must be a bounded regular file owned by the expected owner with exact mode 0600".into());
    }
    let marker_content = fs::read_to_string(&marker_path).map_err(|error| error.to_string())?;
    if marker_content != TEST_MOUNT_MARKER_CONTENT {
        return Err(
            "test mount marker content does not match the disposable quota-test version".into(),
        );
    }

    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        if name != TEST_MOUNT_MARKER && name != WORKSPACE_PARENT_NAME {
            return Err(format!(
                "test mount contains unexpected entry {}; only the marker and {} are permitted",
                entry.path().display(),
                WORKSPACE_PARENT_NAME
            ));
        }
    }
    Ok(())
}

fn required(name: &'static str) -> Result<String, Box<dyn std::error::Error>> {
    env::var(name).map_err(|_| format!("missing required environment variable {name}").into())
}

fn open_registry(path: &Path) -> Result<Connection, Box<dyn std::error::Error>> {
    let parent = path.parent().ok_or("registry path has no parent")?;
    if !path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err("registry path must be normalized and absolute".into());
    }
    let parent_metadata = fs::symlink_metadata(parent)?;
    if parent_metadata.file_type().is_symlink()
        || !parent_metadata.is_dir()
        || parent_metadata.uid() != 0
        || parent_metadata.mode() & 0o7777 != 0o700
    {
        return Err("registry parent must be a root-owned directory with exact mode 0700".into());
    }
    if fs::canonicalize(parent)? != parent {
        return Err("registry parent path must not contain symlink components".into());
    }
    match fs::symlink_metadata(path) {
        Ok(metadata)
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || metadata.uid() != 0
                || metadata.mode() & 0o7777 != 0o600
                || metadata.nlink() != 1 =>
        {
            return Err(
                "existing quota integration registry must be a root-owned mode-0600 regular file with one link".into(),
            );
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let connection = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
            | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
            | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != 0
        || metadata.mode() & 0o7777 != 0o600
        || metadata.nlink() != 1
    {
        return Err(
            "quota integration registry must be a root-owned mode-0600 regular file with one link"
                .into(),
        );
    }
    connection.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=FULL;
         CREATE TABLE IF NOT EXISTS quota_integration_projects(
           project_id INTEGER PRIMARY KEY CHECK(project_id BETWEEN 1500000000 AND 1700000000),
           kind TEXT NOT NULL,
           workspace TEXT NOT NULL UNIQUE,
           device INTEGER,
           inode INTEGER,
           bytes_limit INTEGER NOT NULL CHECK(bytes_limit>0),
           inode_limit INTEGER NOT NULL CHECK(inode_limit>0),
           state TEXT NOT NULL CHECK(state IN ('ALLOCATING','ACTIVE','RELEASED','QUARANTINED')),
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE TRIGGER IF NOT EXISTS quota_integration_no_delete
           BEFORE DELETE ON quota_integration_projects
           BEGIN SELECT RAISE(ABORT,'quota integration project IDs are never reusable'); END;
         CREATE TRIGGER IF NOT EXISTS quota_integration_identity_immutable
           BEFORE UPDATE OF project_id,kind,workspace,bytes_limit,inode_limit,created_at
           ON quota_integration_projects
           BEGIN SELECT RAISE(ABORT,'quota integration reservation identity is immutable'); END;
         CREATE TRIGGER IF NOT EXISTS quota_integration_state_monotonic
           BEFORE UPDATE OF state ON quota_integration_projects
           WHEN NOT ((OLD.state='ALLOCATING' AND NEW.state IN ('ACTIVE','QUARANTINED')) OR
                     (OLD.state='ACTIVE' AND NEW.state IN ('RELEASED','QUARANTINED')) OR
                     (OLD.state=NEW.state))
           BEGIN SELECT RAISE(ABORT,'quota integration project state cannot move backwards'); END;",
    )?;
    Ok(connection)
}

fn ensure_private_test_parent(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    if !path.exists() {
        fs::create_dir(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != 0
        || metadata.mode() & 0o7777 != 0o700
    {
        return Err(
            "quota integration workspace parent must be root-owned, mode 0700, and not a symlink"
                .into(),
        );
    }
    Ok(())
}

fn reserve_project(
    registry: &Connection,
    workspace_parent: &Path,
    kind: &str,
    limits: ProjectQuotaLimits,
) -> Result<ProjectRecord, Box<dyn std::error::Error>> {
    let transaction = registry.unchecked_transaction()?;
    let last: Option<i64> = transaction.query_row(
        "SELECT MAX(project_id) FROM quota_integration_projects",
        [],
        |row| row.get(0),
    )?;
    let project_id = last.unwrap_or(TEST_PROJECT_ID_BASE as i64 - 1) + 1;
    if !(TEST_PROJECT_ID_BASE as i64..=TEST_PROJECT_ID_MAX as i64).contains(&project_id) {
        return Err(
            "test project ID range is exhausted; never delete registry rows to recycle IDs".into(),
        );
    }
    let project_id = project_id as u32;
    let workspace = workspace_parent.join(format!("execution-{project_id}"));
    let timestamp = chrono::Utc::now().to_rfc3339();
    transaction.execute(
        "INSERT INTO quota_integration_projects(project_id,kind,workspace,device,inode,bytes_limit,inode_limit,state,created_at,updated_at)
         VALUES(?1,?2,?3,NULL,NULL,?4,?5,'ALLOCATING',?6,?6)",
        params![project_id,kind,workspace.to_string_lossy(),limits.bytes as i64,limits.inodes as i64,timestamp],
    )?;
    transaction.commit()?;
    fs::create_dir(&workspace)?;
    fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700))?;
    let metadata = fs::symlink_metadata(&workspace)?;
    registry.execute(
        "UPDATE quota_integration_projects SET device=?2,inode=?3,updated_at=?4 WHERE project_id=?1 AND state='ALLOCATING'",
        params![project_id,metadata.dev() as i64,metadata.ino() as i64,chrono::Utc::now().to_rfc3339()],
    )?;
    Ok(ProjectRecord {
        project_id,
        kind: kind.into(),
        workspace,
        device: Some(metadata.dev()),
        inode: Some(metadata.ino()),
        limits,
        state: "ALLOCATING".into(),
    })
}

fn activate_project(
    registry: &Connection,
    controller: &ProjectQuotaController,
    record: &ProjectRecord,
) -> Result<(), Box<dyn std::error::Error>> {
    let identity = exact_identity(record)?;
    controller.assign_project_id_exact(&record.workspace, record.project_id, identity)?;
    controller.set_hard_limits_exact(
        &record.workspace,
        record.project_id,
        record.limits,
        identity,
    )?;
    let status = controller.verify_hard_limits_exact(
        &record.workspace,
        record.project_id,
        record.limits,
        identity,
    )?;
    if status.bytes_hard_limit < record.limits.bytes
        || status.inodes_hard_limit != record.limits.inodes
    {
        return Err("kernel hard-limit readback did not match the reservation".into());
    }
    registry.execute(
        "UPDATE quota_integration_projects SET state='ACTIVE',updated_at=?2 WHERE project_id=?1 AND state='ALLOCATING'",
        params![record.project_id,chrono::Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

fn exercise_byte_exhaustion(
    controller: &ProjectQuotaController,
    record: &ProjectRecord,
) -> Result<ProjectQuotaStatus, Box<dyn std::error::Error>> {
    let payload = record.workspace.join("payload.bin");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(payload)?;
    let block = vec![0x5a; 4096];
    let mut exhausted = false;
    let mut bytes_written = 0_u64;
    while bytes_written < record.limits.bytes.saturating_mul(4) {
        match file.write_all(&block) {
            Ok(()) => bytes_written += block.len() as u64,
            Err(error) if is_quota_exhaustion(&error) => {
                exhausted = true;
                break;
            }
            Err(error) => return Err(error.into()),
        }
    }
    let sync = file.sync_all();
    if let Err(error) = sync {
        if is_quota_exhaustion(&error) {
            exhausted = true;
        } else {
            return Err(error.into());
        }
    }
    drop(file);
    if !exhausted {
        return Err(format!(
            "byte hard limit was not enforced before writing {bytes_written} bytes"
        )
        .into());
    }
    sync_filesystem(&record.workspace)?;
    let status = controller.status(record.project_id)?;
    if status.bytes_used == 0
        || status.bytes_used > record.limits.bytes
        || status.bytes_hard_limit < record.limits.bytes
    {
        return Err(format!("kernel byte quota readback is inconsistent: {status:?}").into());
    }
    Ok(status)
}

fn exercise_inode_exhaustion(
    controller: &ProjectQuotaController,
    record: &ProjectRecord,
) -> Result<ProjectQuotaStatus, Box<dyn std::error::Error>> {
    let mut exhausted = false;
    for index in 0..(record.limits.inodes * 4) {
        let path = record.workspace.join(format!("inode-{index:04}"));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
        {
            Ok(file) => drop(file),
            Err(error) if is_quota_exhaustion(&error) => {
                exhausted = true;
                break;
            }
            Err(error) => return Err(error.into()),
        }
    }
    if !exhausted {
        return Err(
            "inode hard limit was not enforced before creating the safety-bound file count".into(),
        );
    }
    sync_filesystem(&record.workspace)?;
    let status = controller.status(record.project_id)?;
    if status.inodes_used < record.limits.inodes
        || status.inodes_used == 0
        || status.bytes_used > record.limits.bytes
    {
        return Err(format!("kernel inode quota readback is inconsistent: {status:?}").into());
    }
    Ok(status)
}

fn is_quota_exhaustion(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(ERRNO_ENOSPC) | Some(ERRNO_EDQUOT)
    )
}

fn sync_filesystem(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let directory = File::open(path)?;
    // SAFETY: directory is a live file descriptor and syncfs has no pointer arguments.
    if unsafe { libc::syncfs(directory.as_raw_fd()) } != 0 {
        return Err(io::Error::last_os_error().into());
    }
    Ok(())
}

fn cleanup_project(
    registry: &Connection,
    controller: &ProjectQuotaController,
    record: &ProjectRecord,
) -> Result<(), Box<dyn std::error::Error>> {
    let metadata = fs::symlink_metadata(&record.workspace)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || Some(metadata.dev()) != record.device
        || Some(metadata.ino()) != record.inode
    {
        mark_quarantined(registry, record.project_id)?;
        return Err("workspace identity changed; refusing cleanup or project-ID release".into());
    }
    fs::remove_dir_all(&record.workspace)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut status = controller.status(record.project_id)?;
    while (status.bytes_used != 0 || status.inodes_used != 0) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
        status = controller.status(record.project_id)?;
    }
    if status.bytes_used != 0 || status.inodes_used != 0 {
        mark_quarantined(registry, record.project_id)?;
        return Err(format!(
            "project still charged after workspace removal: {status:?}; ID remains quarantined"
        )
        .into());
    }
    controller.clear_empty_project(record.project_id)?;
    registry.execute(
        "UPDATE quota_integration_projects SET state='RELEASED',updated_at=?2 WHERE project_id=?1 AND state='ACTIVE'",
        params![record.project_id,chrono::Utc::now().to_rfc3339()],
    )?;
    println!(
        "CLEANUP PASS kind={} project_id={} bytes_used=0 inodes_used=0; project ID remains permanently reserved",
        record.kind, record.project_id
    );
    Ok(())
}

fn recover_incomplete(
    registry: &Connection,
    controller: &ProjectQuotaController,
    workspace_parent: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let records = {
        let mut statement = registry.prepare(
            "SELECT project_id,kind,workspace,device,inode,bytes_limit,inode_limit,state
             FROM quota_integration_projects WHERE state IN ('ALLOCATING','ACTIVE','QUARANTINED') ORDER BY project_id",
        )?;
        statement
            .query_map([], |row| {
                Ok(ProjectRecord {
                    project_id: row.get::<_, i64>(0)? as u32,
                    kind: row.get(1)?,
                    workspace: PathBuf::from(row.get::<_, String>(2)?),
                    device: row.get::<_, Option<i64>>(3)?.map(|value| value as u64),
                    inode: row.get::<_, Option<i64>>(4)?.map(|value| value as u64),
                    limits: ProjectQuotaLimits {
                        bytes: row.get::<_, i64>(5)? as u64,
                        inodes: row.get::<_, i64>(6)? as u64,
                    },
                    state: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    for mut record in records {
        if record.state == "QUARANTINED" {
            return Err(format!("project {} is quarantined and requires explicit operator reconciliation; refusing automatic reuse", record.project_id).into());
        }
        let previous_state = record.state.clone();
        if record.workspace.parent() != Some(workspace_parent)
            || record.workspace.file_name().and_then(|name| name.to_str())
                != Some(format!("execution-{}", record.project_id).as_str())
        {
            mark_quarantined(registry, record.project_id)?;
            return Err(format!(
                "registry path mismatch for project {}; quarantined",
                record.project_id
            )
            .into());
        }
        match fs::symlink_metadata(&record.workspace) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                if let (Some(device), Some(inode)) = (record.device, record.inode) {
                    if (metadata.dev(), metadata.ino()) != (device, inode) {
                        mark_quarantined(registry, record.project_id)?;
                        return Err(format!(
                            "project {} workspace inode changed; quarantined",
                            record.project_id
                        )
                        .into());
                    }
                } else {
                    record.device = Some(metadata.dev());
                    record.inode = Some(metadata.ino());
                    registry.execute("UPDATE quota_integration_projects SET device=?2,inode=?3,updated_at=?4 WHERE project_id=?1 AND state='ALLOCATING'", params![record.project_id,metadata.dev() as i64,metadata.ino() as i64,chrono::Utc::now().to_rfc3339()])?;
                }
                let identity = exact_identity(&record)?;
                controller.assign_project_id_exact(
                    &record.workspace,
                    record.project_id,
                    identity,
                )?;
                controller.set_hard_limits_exact(
                    &record.workspace,
                    record.project_id,
                    record.limits,
                    identity,
                )?;
                record.state = "ACTIVE".into();
                registry.execute("UPDATE quota_integration_projects SET state='ACTIVE',updated_at=?2 WHERE project_id=?1 AND state='ALLOCATING'", params![record.project_id,chrono::Utc::now().to_rfc3339()])?;
                cleanup_project(registry, controller, &record)?;
                println!(
                    "RECOVERY PASS project_id={} state_reconciled_from={}",
                    record.project_id, previous_state
                );
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let status = controller.status(record.project_id)?;
                if status.bytes_used == 0 && status.inodes_used == 0 {
                    controller.clear_empty_project(record.project_id)?;
                    registry.execute("UPDATE quota_integration_projects SET state='RELEASED',updated_at=?2 WHERE project_id=?1 AND state IN ('ALLOCATING','ACTIVE')", params![record.project_id,chrono::Utc::now().to_rfc3339()])?;
                    println!(
                        "RECOVERY PASS project_id={} workspace_absent usage_zero=true",
                        record.project_id
                    );
                } else {
                    mark_quarantined(registry, record.project_id)?;
                    return Err(format!("project {} has charged objects but its workspace path is missing: {status:?}", record.project_id).into());
                }
            }
            Ok(_) => {
                mark_quarantined(registry, record.project_id)?;
                return Err(format!(
                    "project {} workspace is not a real directory; quarantined",
                    record.project_id
                )
                .into());
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn exact_identity(record: &ProjectRecord) -> Result<(u64, u64), Box<dyn std::error::Error>> {
    Ok((
        record
            .device
            .ok_or("project registry has no recorded device")?,
        record
            .inode
            .ok_or("project registry has no recorded inode")?,
    ))
}

fn mark_quarantined(
    registry: &Connection,
    project_id: u32,
) -> Result<(), Box<dyn std::error::Error>> {
    registry.execute(
        "UPDATE quota_integration_projects SET state='QUARANTINED',updated_at=?2 WHERE project_id=?1 AND state IN ('ALLOCATING','ACTIVE')",
        params![project_id,chrono::Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disposable_mount() -> (tempfile::TempDir, u32) {
        let directory = tempfile::tempdir().unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let owner_uid = fs::metadata(directory.path()).unwrap().uid();
        let marker = directory.path().join(TEST_MOUNT_MARKER);
        fs::write(&marker, TEST_MOUNT_MARKER_CONTENT).unwrap();
        fs::set_permissions(&marker, fs::Permissions::from_mode(0o600)).unwrap();
        (directory, owner_uid)
    }

    #[test]
    fn destructive_harness_requires_exact_marked_private_mount_and_acknowledgement() {
        let (directory, owner_uid) = disposable_mount();
        assert!(
            validate_destructive_test_mount(
                directory.path(),
                directory.path(),
                Some(DESTRUCTIVE_ACK_VALUE),
                owner_uid,
            )
            .is_ok()
        );
    }

    #[test]
    fn destructive_harness_never_accepts_filesystem_root() {
        assert!(
            validate_destructive_test_mount(
                Path::new("/"),
                Path::new("/"),
                Some(DESTRUCTIVE_ACK_VALUE),
                0,
            )
            .unwrap_err()
            .contains("filesystem root")
        );
    }

    #[test]
    fn destructive_harness_rejects_nested_production_directory_and_missing_ack() {
        let (directory, owner_uid) = disposable_mount();
        let nested = directory.path().join("nested");
        fs::create_dir(&nested).unwrap();
        fs::set_permissions(&nested, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(
            validate_destructive_test_mount(
                &nested,
                directory.path(),
                Some(DESTRUCTIVE_ACK_VALUE),
                owner_uid,
            )
            .unwrap_err()
            .contains("exact mount point")
        );
        assert!(
            validate_destructive_test_mount(directory.path(), directory.path(), None, owner_uid,)
                .unwrap_err()
                .contains(DESTRUCTIVE_ACK_ENV)
        );
    }

    #[test]
    fn destructive_harness_rejects_bad_marker_and_unexpected_mount_contents() {
        let (directory, owner_uid) = disposable_mount();
        let marker = directory.path().join(TEST_MOUNT_MARKER);
        fs::write(&marker, "X".repeat(TEST_MOUNT_MARKER_CONTENT.len())).unwrap();
        assert!(
            validate_destructive_test_mount(
                directory.path(),
                directory.path(),
                Some(DESTRUCTIVE_ACK_VALUE),
                owner_uid,
            )
            .unwrap_err()
            .contains("marker content")
        );
        fs::write(&marker, TEST_MOUNT_MARKER_CONTENT).unwrap();
        fs::write(directory.path().join("keep-this-file"), b"unrelated data").unwrap();
        assert!(
            validate_destructive_test_mount(
                directory.path(),
                directory.path(),
                Some(DESTRUCTIVE_ACK_VALUE),
                owner_uid,
            )
            .unwrap_err()
            .contains("unexpected entry")
        );
    }

    #[test]
    fn destructive_harness_rejects_weak_marker_permissions_and_wrong_owner() {
        let (directory, owner_uid) = disposable_mount();
        let marker = directory.path().join(TEST_MOUNT_MARKER);
        fs::set_permissions(&marker, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            validate_destructive_test_mount(
                directory.path(),
                directory.path(),
                Some(DESTRUCTIVE_ACK_VALUE),
                owner_uid,
            )
            .unwrap_err()
            .contains("marker")
        );
        fs::set_permissions(&marker, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(
            validate_destructive_test_mount(
                directory.path(),
                directory.path(),
                Some(DESTRUCTIVE_ACK_VALUE),
                owner_uid.saturating_add(1),
            )
            .is_err()
        );
    }

    #[test]
    fn destructive_harness_requires_exact_root_and_marker_modes() {
        let (directory, owner_uid) = disposable_mount();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o1700)).unwrap();
        assert!(
            validate_destructive_test_mount(
                directory.path(),
                directory.path(),
                Some(DESTRUCTIVE_ACK_VALUE),
                owner_uid,
            )
            .unwrap_err()
            .contains("exact mode 0700")
        );

        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let marker = directory.path().join(TEST_MOUNT_MARKER);
        fs::set_permissions(&marker, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(
            validate_destructive_test_mount(
                directory.path(),
                directory.path(),
                Some(DESTRUCTIVE_ACK_VALUE),
                owner_uid,
            )
            .unwrap_err()
            .contains("exact mode 0600")
        );
    }
}
