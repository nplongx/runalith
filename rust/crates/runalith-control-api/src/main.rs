//! Standalone, fail-closed Workflow Control HTTP process.

use std::{
    env, fs,
    io::{Read, Write},
    net::{SocketAddr, TcpListener},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

use runalith_control_api::{
    ControlApi, ControlApiError, ControlPrincipal, ControlPrincipalVerifier,
    deny_all_approval_verifier, serve_until,
};
use runalith_runtime::{
    CoordinatorWorkerVerifier, Store, StoreError, TaskResultProducerVerifier, TaskResultRequest,
    Transaction, TrustedSkillResolver, VerifiedTrustedSkill, WorkflowCancellationVerifier,
    WorkflowView,
};
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

const MAX_AUTH_FILE_BYTES: usize = 64 * 1024;
const MAX_AUTH_ENTRIES: usize = 1024;
const MAX_CAPABILITIES: usize = 128;
const FILE_FLAGS: i32 = libc::O_NOFOLLOW | libc::O_CLOEXEC;

#[derive(Debug)]
struct HostError(String);

impl std::fmt::Display for HostError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for HostError {}

type HostResult<T> = Result<T, Box<dyn std::error::Error>>;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthFile {
    version: u32,
    principals: Vec<AuthFileEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthFileEntry {
    token_sha256: String,
    subject: String,
    issuer: String,
    capabilities: Vec<String>,
}

#[derive(Debug, Clone)]
struct PrincipalEntry {
    token_digest: [u8; 32],
    subject: String,
    issuer: String,
    capabilities: Vec<String>,
}

#[derive(Debug)]
struct PrincipalAuthenticator {
    entries: Vec<PrincipalEntry>,
}

impl PrincipalAuthenticator {
    fn load(path: &Path) -> HostResult<Self> {
        let bytes = read_private_file(path, MAX_AUTH_FILE_BYTES)?;
        let document: AuthFile = serde_json::from_slice(&bytes)?;
        if document.version != 1
            || document.principals.is_empty()
            || document.principals.len() > MAX_AUTH_ENTRIES
        {
            return Err(HostError(
                "authentication file version or principal count is invalid".into(),
            )
            .into());
        }

        let mut entries = Vec::with_capacity(document.principals.len());
        for entry in document.principals {
            let token_digest = parse_digest(&entry.token_sha256)?;
            validate_identity_field(&entry.subject, "subject")?;
            validate_identity_field(&entry.issuer, "issuer")?;
            if entry.capabilities.is_empty() || entry.capabilities.len() > MAX_CAPABILITIES {
                return Err(HostError("principal capability count is invalid".into()).into());
            }
            let mut capabilities = entry.capabilities;
            capabilities.sort();
            capabilities.dedup();
            if capabilities.iter().any(|value| !valid_capability(value)) {
                return Err(HostError("principal contains an invalid capability".into()).into());
            }
            if entries.iter().any(|existing: &PrincipalEntry| {
                constant_time_eq(&existing.token_digest, &token_digest)
            }) {
                return Err(HostError(
                    "authentication file contains duplicate token digests".into(),
                )
                .into());
            }
            entries.push(PrincipalEntry {
                token_digest,
                subject: entry.subject,
                issuer: entry.issuer,
                capabilities,
            });
        }
        Ok(Self { entries })
    }
}

impl ControlPrincipalVerifier for PrincipalAuthenticator {
    fn authenticate(&self, credential: &str) -> Result<ControlPrincipal, ControlApiError> {
        if credential.is_empty()
            || credential.len() > 8192
            || credential
                .bytes()
                .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
        {
            return Err(ControlApiError::Authentication);
        }
        let digest: [u8; 32] = Sha256::digest(credential.as_bytes()).into();
        let mut matched = None;
        for entry in &self.entries {
            if constant_time_eq(&entry.token_digest, &digest) {
                matched = Some(entry);
            }
        }
        let entry = matched.ok_or(ControlApiError::Authentication)?;
        Ok(ControlPrincipal {
            subject: entry.subject.clone(),
            issuer: entry.issuer.clone(),
            capabilities: entry.capabilities.clone(),
        })
    }
}

#[derive(Debug)]
struct ControlConfig {
    database_path: PathBuf,
    auth_file: PathBuf,
    listen_addr: SocketAddr,
    pid_file: PathBuf,
    shutdown_file: PathBuf,
}

impl ControlConfig {
    fn from_env() -> HostResult<Self> {
        let database_path = required_absolute_path("RUNALITH_CONTROL_DATABASE_PATH")?;
        let auth_file = required_absolute_path("RUNALITH_CONTROL_AUTH_FILE")?;
        let listen_text =
            env::var("RUNALITH_CONTROL_LISTEN_ADDR").unwrap_or_else(|_| "127.0.0.1:8090".into());
        let listen_addr: SocketAddr = listen_text
            .parse()
            .map_err(|_| HostError("RUNALITH_CONTROL_LISTEN_ADDR is invalid".into()))?;
        if !listen_addr.ip().is_loopback() {
            return Err(HostError(
                "Control plain HTTP listener must use a loopback address".into(),
            )
            .into());
        }
        let database_parent = database_path
            .parent()
            .ok_or_else(|| HostError("database path has no parent directory".into()))?;
        let pid_file = optional_absolute_path("RUNALITH_CONTROL_PID_FILE")?
            .unwrap_or_else(|| database_parent.join("runalith-control.pid"));
        let shutdown_file = optional_absolute_path("RUNALITH_CONTROL_SHUTDOWN_FILE")?
            .unwrap_or_else(|| database_parent.join("runalith-control.stop"));
        validate_private_parent(&database_path)?;
        validate_private_parent(&pid_file)?;
        validate_private_parent(&shutdown_file)?;
        Ok(Self {
            database_path,
            auth_file,
            listen_addr,
            pid_file,
            shutdown_file,
        })
    }
}

struct PidFile {
    path: PathBuf,
    process_id: u32,
    _lock_file: fs::File,
}

impl PidFile {
    fn acquire(path: &Path) -> HostResult<Self> {
        let lock_path = path.with_extension("lock");
        reject_existing_symlink(&lock_path)?;
        let mut lock_options = fs::OpenOptions::new();
        lock_options
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(FILE_FLAGS);
        let lock_file = lock_options.open(&lock_path)?;
        let lock_metadata = lock_file.metadata()?;
        if !lock_metadata.is_file()
            || lock_metadata.permissions().mode() & 0o077 != 0
            || lock_metadata.uid() != rustix::process::geteuid().as_raw()
            || lock_metadata.nlink() != 1
        {
            return Err(HostError(
                "Control lock file must be owner-only, regular and singly-linked".into(),
            )
            .into());
        }
        if let Err(error) = rustix::fs::flock(
            &lock_file,
            rustix::fs::FlockOperation::NonBlockingLockExclusive,
        ) {
            if error == rustix::io::Errno::WOULDBLOCK {
                return Err(HostError(format!(
                    "another Control or maintenance process holds {}",
                    lock_path.display()
                ))
                .into());
            }
            return Err(std::io::Error::from(error).into());
        }

        reject_existing_symlink(path)?;
        recover_stale_pid_marker(path)?;
        let process_id = std::process::id();
        let mut options = fs::OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(FILE_FLAGS);
        let mut file = options.open(path).map_err(|error| {
            HostError(if error.kind() == std::io::ErrorKind::AlreadyExists {
                format!("Control pid file already exists: {}", path.display())
            } else {
                format!("cannot create Control pid file: {error}")
            })
        })?;
        writeln!(file, "{process_id}")?;
        file.sync_all()?;
        Ok(Self {
            path: path.to_path_buf(),
            process_id,
            _lock_file: lock_file,
        })
    }
}

impl Drop for PidFile {
    fn drop(&mut self) {
        let Ok(before) = fs::symlink_metadata(&self.path) else {
            return;
        };
        if before.file_type().is_symlink() || !before.is_file() {
            return;
        }
        let mut options = fs::OpenOptions::new();
        options.read(true).custom_flags(FILE_FLAGS);
        let Ok(mut file) = options.open(&self.path) else {
            return;
        };
        let Ok(opened) = file.metadata() else {
            return;
        };
        if opened.dev() != before.dev() || opened.ino() != before.ino() {
            return;
        }
        let mut value = String::new();
        if Read::by_ref(&mut file)
            .take(64)
            .read_to_string(&mut value)
            .is_ok()
            && value.trim() == self.process_id.to_string()
            && fs::symlink_metadata(&self.path).is_ok_and(|current| {
                current.is_file()
                    && !current.file_type().is_symlink()
                    && current.dev() == opened.dev()
                    && current.ino() == opened.ino()
            })
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn recover_stale_pid_marker(path: &Path) -> HostResult<()> {
    let before = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if before.file_type().is_symlink()
        || !before.is_file()
        || before.permissions().mode() & 0o077 != 0
        || before.uid() != rustix::process::geteuid().as_raw()
        || before.nlink() != 1
    {
        return Err(HostError(
            "stale Control PID marker must be an owner-only regular singly-linked file".into(),
        )
        .into());
    }

    let mut options = fs::OpenOptions::new();
    options.read(true).custom_flags(FILE_FLAGS);
    let mut file = options.open(path)?;
    let opened = file.metadata()?;
    if opened.dev() != before.dev() || opened.ino() != before.ino() {
        return Err(HostError("Control PID marker changed while opening".into()).into());
    }
    let mut value = String::new();
    Read::by_ref(&mut file)
        .take(64)
        .read_to_string(&mut value)?;
    if file.metadata()?.len() > 64 {
        return Err(HostError("Control PID marker is oversized".into()).into());
    }
    let process_id = value.trim().parse::<u32>().map_err(|_| {
        HostError("existing Control PID marker is malformed; inspect it manually".into())
    })?;
    if process_id == 0 || process_id > i32::MAX as u32 {
        return Err(HostError(
            "existing Control PID marker is outside the supported process ID range".into(),
        )
        .into());
    }
    if process_is_alive(process_id)? {
        return Err(HostError(format!(
            "existing Control PID marker belongs to live process {process_id}; refusing to replace it"
        )).into());
    }

    let current = fs::symlink_metadata(path)?;
    if current.file_type().is_symlink()
        || current.dev() != opened.dev()
        || current.ino() != opened.ino()
    {
        return Err(
            HostError("Control PID marker changed before stale-marker removal".into()).into(),
        );
    }
    fs::remove_file(path)?;
    Ok(())
}

fn process_is_alive(process_id: u32) -> HostResult<bool> {
    let process_id = rustix::process::Pid::from_raw(process_id as i32)
        .ok_or_else(|| HostError("process ID zero is invalid".into()))?;
    match rustix::process::test_kill_process(process_id) {
        Ok(()) => Ok(true),
        Err(rustix::io::Errno::SRCH) => Ok(false),
        Err(rustix::io::Errno::PERM) => Ok(true),
        Err(error) => Err(std::io::Error::from(error).into()),
    }
}

struct DenyWorker;

impl CoordinatorWorkerVerifier for DenyWorker {
    fn authenticate_worker(
        &self,
        _transaction: &Transaction<'_>,
        _asserted_worker_id: &str,
    ) -> Result<String, StoreError> {
        Err(StoreError::ApprovalAuthorityUnavailable)
    }
}

struct DenyResultProducer;

impl TaskResultProducerVerifier for DenyResultProducer {
    fn authenticate_producer(
        &self,
        _transaction: &Transaction<'_>,
        _workflow_id: &str,
        _task_id: &str,
        _request: &TaskResultRequest,
    ) -> Result<String, StoreError> {
        Err(StoreError::ApprovalAuthorityUnavailable)
    }
}

struct DenyCancellation;

impl WorkflowCancellationVerifier for DenyCancellation {
    fn verify_cancel(
        &self,
        _transaction: &Transaction<'_>,
        _workflow: &WorkflowView,
        _asserted_actor: &str,
        _reason: &str,
    ) -> Result<String, StoreError> {
        Err(StoreError::ApprovalAuthorityUnavailable)
    }
}

struct DenyTrustedSkills;

impl TrustedSkillResolver for DenyTrustedSkills {
    fn resolve_and_verify(
        &self,
        _transaction: &Transaction<'_>,
        _reference: &str,
    ) -> Result<VerifiedTrustedSkill, StoreError> {
        Err(StoreError::Invariant(
            "standalone Control has no provisioned trusted-skill catalog".into(),
        ))
    }
}

fn run() -> HostResult<i32> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    match arguments.as_slice() {
        [command] if command == "--version" || command == "version" => {
            println!(
                "{}",
                json!({
                    "name":"runalith-control",
                    "version":env!("CARGO_PKG_VERSION"),
                    "store_schema_version":Store::CURRENT_SCHEMA_VERSION,
                    "authority_mode":"deny_all_unprovisioned",
                    "database_ownership":"D-01 shared Store compatibility mode"
                })
            );
            Ok(0)
        }
        [command] if command == "--help" || command == "help" => {
            println!(
                "runalith-control [init-db | health | migrate-db BACKUP_PATH | restore-db BACKUP_PATH | serve | stop | version]"
            );
            println!(
                "serve requires RUNALITH_CONTROL_DATABASE_PATH and RUNALITH_CONTROL_AUTH_FILE."
            );
            println!(
                "The HTTP listener binds only to loopback; terminate TLS at a trusted reverse proxy."
            );
            Ok(0)
        }
        [command] if command == "init-db" => {
            let path = required_absolute_path("RUNALITH_CONTROL_DATABASE_PATH")?;
            validate_private_parent(&path)?;
            let store = Store::create_new(&path)?;
            store.check_readiness()?;
            println!(
                "{}",
                json!({"status":"INITIALIZED","schema_version":Store::CURRENT_SCHEMA_VERSION})
            );
            Ok(0)
        }
        [command] if command == "health" => health_command(),
        [command, backup] if command == "migrate-db" => migrate_command(Path::new(backup)),
        [command, backup] if command == "restore-db" => restore_command(Path::new(backup)),
        [command] if command == "serve" => serve_command(),
        [command] if command == "stop" => stop_command(),
        _ => Err(HostError("invalid arguments; use `runalith-control --help`".into()).into()),
    }
}

fn health_command() -> HostResult<i32> {
    let path = required_absolute_path("RUNALITH_CONTROL_DATABASE_PATH")?;
    match Store::inspect_health_read_only(&path) {
        Ok(snapshot) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "status":"DATABASE_HEALTHY",
                    "store":snapshot,
                    "control_process":"NOT_CHECKED",
                    "production_authority":"NOT_ESTABLISHED"
                }))?
            );
            Ok(0)
        }
        Err(error) => {
            println!(
                "{}",
                json!({"status":"BLOCKED","read_only":true,"error":error.to_string()})
            );
            Ok(2)
        }
    }
}

fn migrate_command(backup_path: &Path) -> HostResult<i32> {
    let database_path = required_absolute_path("RUNALITH_CONTROL_DATABASE_PATH")?;
    validate_private_parent(&database_path)?;
    let _maintenance_lock = acquire_offline_maintenance_lock(&database_path)?;
    let backup_path = validate_new_absolute_path(backup_path)?;
    validate_private_parent(&backup_path)?;
    let source = Connection::open_with_flags(
        &database_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    source.busy_timeout(Duration::from_secs(10))?;
    let source_version: i64 = source.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let backup_text = backup_path
        .to_str()
        .ok_or_else(|| HostError("backup path is not valid UTF-8".into()))?;
    source.execute("VACUUM INTO ?1", [backup_text])?;
    drop(source);
    fs::set_permissions(&backup_path, fs::Permissions::from_mode(0o600))?;
    verify_backup(&backup_path, source_version)?;

    let migrated = Store::migrate_existing_rust_database(&database_path).map_err(|error| {
        HostError(format!(
            "migration failed; verified pre-migration backup remains at {}: {error}",
            backup_path.display()
        ))
    })?;
    migrated.check_readiness()?;
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "status":"MIGRATED",
            "schema_before":source_version,
            "schema_after":Store::CURRENT_SCHEMA_VERSION,
            "backup_path":backup_path,
            "backup_verified":true,
            "migration_applied_by":"Store::migrate_existing_rust_database"
        }))?
    );
    Ok(0)
}

fn verify_backup(path: &Path, expected_version: i64) -> HostResult<()> {
    let backup = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    let version: i64 = backup.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let quick_check: String = backup.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if version != expected_version || quick_check != "ok" {
        return Err(HostError(
            "backup verification failed; source database was not migrated".into(),
        )
        .into());
    }
    Ok(())
}

/// Restore a verified current-schema backup into a database path that does not
/// exist. Publishing uses an atomic same-filesystem hard link, so an existing
/// database can never be replaced by this command.
fn restore_command(backup_path: &Path) -> HostResult<i32> {
    let database_path = required_absolute_path("RUNALITH_CONTROL_DATABASE_PATH")?;
    validate_private_parent(&database_path)?;
    let database_path = validate_new_absolute_path(&database_path)?;
    let _maintenance_lock = acquire_offline_maintenance_lock(&database_path)?;
    reject_existing_database_sidecars(&database_path)?;

    let backup_path = validate_existing_database_file(backup_path)?;
    if backup_path == database_path {
        return Err(
            HostError("restore source and destination must be different files".into()).into(),
        );
    }
    verify_restore_backup(&backup_path)?;

    let parent = database_path
        .parent()
        .ok_or_else(|| HostError("database path has no parent directory".into()))?;
    let file_name = database_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| HostError("database filename is not valid UTF-8".into()))?;
    let temporary_path = parent.join(format!(".{file_name}.restore-{}.tmp", std::process::id()));

    let mut temporary_created = false;
    let restore = (|| -> HostResult<()> {
        let source_metadata = fs::symlink_metadata(&backup_path)?;
        let mut source_options = fs::OpenOptions::new();
        source_options.read(true).custom_flags(FILE_FLAGS);
        let mut source = source_options.open(&backup_path)?;
        let opened_metadata = source.metadata()?;
        if !opened_metadata.is_file()
            || opened_metadata.dev() != source_metadata.dev()
            || opened_metadata.ino() != source_metadata.ino()
        {
            return Err(HostError("restore source changed while opening".into()).into());
        }

        let mut destination_options = fs::OpenOptions::new();
        destination_options
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(FILE_FLAGS);
        let mut destination = destination_options.open(&temporary_path)?;
        temporary_created = true;
        let copied = std::io::copy(&mut source, &mut destination)?;
        if copied != opened_metadata.len() {
            return Err(HostError("restore source changed while copying".into()).into());
        }
        destination.sync_all()?;
        drop(destination);

        let after_metadata = fs::symlink_metadata(&backup_path)?;
        if after_metadata.file_type().is_symlink()
            || after_metadata.dev() != opened_metadata.dev()
            || after_metadata.ino() != opened_metadata.ino()
            || after_metadata.len() != opened_metadata.len()
            || after_metadata.mtime() != opened_metadata.mtime()
            || after_metadata.mtime_nsec() != opened_metadata.mtime_nsec()
        {
            return Err(HostError("restore source changed during copy".into()).into());
        }

        verify_restore_backup(&temporary_path)?;
        let restored = Store::open_existing(&temporary_path)?;
        restored.check_readiness()?;
        drop(restored);

        // hard_link is atomic and fails when database_path already exists.
        fs::hard_link(&temporary_path, &database_path)?;
        fs::remove_file(&temporary_path)?;
        temporary_created = false;
        fs::File::open(parent)?.sync_all()?;

        let restored = Store::open_existing(&database_path)?;
        restored.check_readiness()?;
        drop(restored);
        Ok(())
    })();
    if restore.is_err() && temporary_created {
        let _ = fs::remove_file(&temporary_path);
    }
    restore?;

    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "status":"RESTORED",
            "database_path":database_path,
            "backup_path":backup_path,
            "schema_version":Store::CURRENT_SCHEMA_VERSION,
            "backup_preserved":true,
            "existing_database_overwrite":false,
            "readiness":"PASS"
        }))?
    );
    Ok(0)
}

fn validate_existing_database_file(path: &Path) -> HostResult<PathBuf> {
    if !path.is_absolute() {
        return Err(HostError("restore backup path must be absolute".into()).into());
    }
    validate_private_parent(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(HostError("restore backup must be a regular non-symlink file".into()).into());
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(
            HostError("restore backup permissions must be owner-only (0600)".into()).into(),
        );
    }
    reject_existing_database_sidecars(path)?;
    Ok(path.to_path_buf())
}

fn verify_restore_backup(path: &Path) -> HostResult<()> {
    let backup = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    let version: i64 = backup.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version != Store::CURRENT_SCHEMA_VERSION {
        return Err(HostError(format!(
            "restore backup schema v{version} is unsupported; expected v{}",
            Store::CURRENT_SCHEMA_VERSION
        ))
        .into());
    }
    let quick_check: String = backup.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if quick_check != "ok" {
        return Err(HostError("restore backup failed SQLite quick_check".into()).into());
    }
    let mut foreign_keys = backup.prepare("PRAGMA foreign_key_check")?;
    if foreign_keys.query([])?.next()?.is_some() {
        return Err(HostError("restore backup failed SQLite foreign_key_check".into()).into());
    }
    let quarantined: bool = backup.query_row(
        "SELECT EXISTS(SELECT 1 FROM agg_checkpoint_store_quarantine WHERE singleton=1)",
        [],
        |row| row.get(0),
    )?;
    if quarantined {
        return Err(
            HostError("restore backup contains durable D-01 checkpoint quarantine".into()).into(),
        );
    }
    Ok(())
}

fn acquire_offline_maintenance_lock(database_path: &Path) -> HostResult<PidFile> {
    let parent = database_path
        .parent()
        .ok_or_else(|| HostError("database path has no parent directory".into()))?;
    let pid_file = optional_absolute_path("RUNALITH_CONTROL_PID_FILE")?
        .unwrap_or_else(|| parent.join("runalith-control.pid"));
    acquire_offline_maintenance_lock_at(&pid_file)
}

fn acquire_offline_maintenance_lock_at(pid_file: &Path) -> HostResult<PidFile> {
    validate_private_parent(pid_file)?;
    PidFile::acquire(pid_file)
}

fn reject_existing_database_sidecars(database_path: &Path) -> HostResult<()> {
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = database_path.as_os_str().to_os_string();
        sidecar.push(suffix);
        let sidecar = PathBuf::from(sidecar);
        match fs::symlink_metadata(&sidecar) {
            Ok(_) => {
                return Err(HostError(format!(
                    "refusing restore while SQLite sidecar exists: {}",
                    sidecar.display()
                ))
                .into());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn serve_command() -> HostResult<i32> {
    let config = ControlConfig::from_env()?;
    let _pid_file = PidFile::acquire(&config.pid_file)?;
    remove_stale_marker(&config.shutdown_file)?;
    let principals = Arc::new(PrincipalAuthenticator::load(&config.auth_file)?);
    let api = ControlApi::open_existing(
        &config.database_path,
        deny_all_approval_verifier(),
        principals,
        Arc::new(DenyWorker),
        Arc::new(DenyResultProducer),
        Arc::new(DenyCancellation),
    )?
    .with_trusted_skill_resolver(Arc::new(DenyTrustedSkills));
    api_service_ready(&api)?;

    let listener = TcpListener::bind(config.listen_addr)?;
    if !listener.local_addr()?.ip().is_loopback() {
        return Err(HostError("Control listener is not loopback-bound".into()).into());
    }
    let api = Arc::new(api);
    let shutdown = Arc::new(AtomicBool::new(false));
    let watcher_shutdown = shutdown.clone();
    let shutdown_file = config.shutdown_file.clone();
    let watcher = thread::spawn(move || {
        while !watcher_shutdown.load(Ordering::Acquire) {
            if fs::symlink_metadata(&shutdown_file).is_ok() {
                watcher_shutdown.store(true, Ordering::Release);
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
    });
    eprintln!("runalith-control: listening on {}", config.listen_addr);
    let result = serve_until(listener, api, shutdown.clone());
    shutdown.store(true, Ordering::Release);
    let _ = watcher.join();
    result?;
    Ok(0)
}

fn api_service_ready(api: &ControlApi) -> HostResult<()> {
    let headers = Vec::new();
    let request = runalith_control_api::HttpRequest {
        method: "GET",
        path: "/readyz",
        query: "",
        headers: &headers,
        body: &[],
    };
    let response = api.handle(request);
    if response.status != 200 {
        return Err(HostError("workflow Store failed startup readiness checks".into()).into());
    }
    Ok(())
}

fn stop_command() -> HostResult<i32> {
    let config = ControlConfig::from_env()?;
    reject_existing_symlink(&config.pid_file)?;
    if !config.pid_file.exists() {
        println!("{}", json!({"status":"NOT_RUNNING"}));
        return Ok(0);
    }
    reject_existing_symlink(&config.shutdown_file)?;
    let mut options = fs::OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(FILE_FLAGS);
    match options.open(&config.shutdown_file) {
        Ok(mut file) => {
            file.write_all(b"stop\n")?;
            file.sync_all()?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    for _ in 0..300 {
        if !config.pid_file.exists() {
            println!("{}", json!({"status":"STOPPED"}));
            return Ok(0);
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err(HostError("Control process did not stop within 30 seconds".into()).into())
}

fn required_absolute_path(name: &str) -> HostResult<PathBuf> {
    let value = env::var(name).map_err(|_| HostError(format!("{name} is required")))?;
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(HostError(format!("{name} must be an absolute path")).into());
    }
    Ok(path)
}

fn optional_absolute_path(name: &str) -> HostResult<Option<PathBuf>> {
    env::var_os(name)
        .map(|value| {
            let path = PathBuf::from(value);
            if !path.is_absolute() {
                return Err(HostError(format!("{name} must be an absolute path")).into());
            }
            Ok(path)
        })
        .transpose()
}

fn validate_new_absolute_path(path: &Path) -> HostResult<PathBuf> {
    if !path.is_absolute() {
        return Err(HostError("backup path must be absolute".into()).into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| HostError("backup path has no parent".into()))?;
    let canonical_parent = fs::canonicalize(parent)?;
    if canonical_parent != parent {
        return Err(HostError(
            "backup parent must be canonical and contain no symlink components".into(),
        )
        .into());
    }
    let name = path
        .file_name()
        .ok_or_else(|| HostError("backup path has no filename".into()))?;
    let destination = canonical_parent.join(name);
    if fs::symlink_metadata(&destination).is_ok() {
        return Err(HostError("backup destination already exists".into()).into());
    }
    Ok(destination)
}

fn validate_private_parent(path: &Path) -> HostResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| HostError("path has no parent directory".into()))?;
    let canonical_parent = fs::canonicalize(parent)?;
    if canonical_parent != parent {
        return Err(HostError(
            "path parent must be canonical and contain no symlink components".into(),
        )
        .into());
    }
    let metadata = fs::symlink_metadata(parent)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(HostError(
            "database, pid and shutdown files require an owner-only directory".into(),
        )
        .into());
    }
    Ok(())
}

fn read_private_file(path: &Path, limit: usize) -> HostResult<Vec<u8>> {
    if !path.is_absolute() {
        return Err(HostError("authentication file path must be absolute".into()).into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| HostError("authentication file has no parent".into()))?;
    if fs::canonicalize(parent)? != parent {
        return Err(HostError("authentication file parent must be canonical".into()).into());
    }
    let before = fs::symlink_metadata(path)?;
    if before.file_type().is_symlink()
        || !before.is_file()
        || before.len() == 0
        || before.len() > limit as u64
    {
        return Err(HostError(
            "authentication file must be a bounded regular non-symlink file".into(),
        )
        .into());
    }
    if before.permissions().mode() & 0o077 != 0 {
        return Err(
            HostError("authentication file permissions must be owner-only (0600)".into()).into(),
        );
    }
    let mut options = fs::OpenOptions::new();
    options.read(true).custom_flags(FILE_FLAGS);
    let file = options.open(path)?;
    let opened = file.metadata()?;
    if !opened.is_file() || opened.dev() != before.dev() || opened.ino() != before.ino() {
        return Err(HostError("authentication file changed while opening".into()).into());
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    let after = fs::symlink_metadata(path)?;
    if after.file_type().is_symlink()
        || after.dev() != opened.dev()
        || after.ino() != opened.ino()
        || after.len() != opened.len()
        || bytes.len() > limit
    {
        return Err(HostError("authentication file changed while reading".into()).into());
    }
    Ok(bytes)
}

fn reject_existing_symlink(path: &Path) -> HostResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(HostError("refusing symlink at Control runtime path".into()).into())
        }
        Ok(metadata) if !metadata.is_file() => {
            Err(HostError("Control runtime path is not a regular file".into()).into())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn remove_stale_marker(path: &Path) -> HostResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(HostError("shutdown marker is not a regular file".into()).into())
        }
        Ok(_) => {
            fs::remove_file(path)?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn parse_digest(value: &str) -> HostResult<[u8; 32]> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(
            HostError("token_sha256 must be 64 lowercase hexadecimal characters".into()).into(),
        );
    }
    let mut digest = [0_u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let high =
            hex_nibble(pair[0]).ok_or_else(|| HostError("token digest is invalid".into()))?;
        let low = hex_nibble(pair[1]).ok_or_else(|| HostError("token digest is invalid".into()))?;
        digest[index] = high * 16 + low;
    }
    Ok(digest)
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        _ => None,
    }
}

fn constant_time_eq(left: &[u8; 32], right: &[u8; 32]) -> bool {
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

fn validate_identity_field(value: &str, field: &str) -> HostResult<()> {
    if value.is_empty()
        || value.len() > 256
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(HostError(format!("principal {field} is invalid")).into());
    }
    Ok(())
}

fn valid_capability(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || byte == b'.'
                || byte == b'-'
                || byte == b'_'
        })
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("runalith-control: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn write_auth_file(path: &Path, token: &str) {
        let digest = Sha256::digest(token.as_bytes());
        let document = json!({
            "version":1,
            "principals":[{
                "token_sha256":format!("{digest:x}"),
                "subject":"operator-1",
                "issuer":"runalith-control-file-v1",
                "capabilities":["control.health.read","workflow.create","workflow.read"]
            }]
        });
        fs::write(path, serde_json::to_vec(&document).unwrap()).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    #[test]
    fn principal_file_authenticates_hash_only_tokens_and_returns_file_capabilities() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("auth.json");
        write_auth_file(&path, "a-long-random-token-for-tests");
        let auth = PrincipalAuthenticator::load(&path).unwrap();
        let principal = auth.authenticate("a-long-random-token-for-tests").unwrap();
        assert_eq!(principal.subject, "operator-1");
        assert!(principal.capabilities.contains(&"workflow.create".into()));
        assert!(auth.authenticate("wrong-token").is_err());
    }

    #[test]
    fn principal_file_rejects_weak_permissions_symlinks_and_duplicate_digests() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("auth.json");
        write_auth_file(&path, "secret-1");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(PrincipalAuthenticator::load(&path).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let link = directory.path().join("auth-link.json");
        symlink(&path, &link).unwrap();
        assert!(PrincipalAuthenticator::load(&link).is_err());
        let digest = format!("{:x}", Sha256::digest(b"secret-1"));
        let duplicate = json!({
            "version":1,
            "principals":[
                {"token_sha256":digest,"subject":"one","issuer":"issuer","capabilities":["workflow.read"]},
                {"token_sha256":digest,"subject":"two","issuer":"issuer","capabilities":["workflow.read"]}
            ]
        });
        fs::write(&path, serde_json::to_vec(&duplicate).unwrap()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(PrincipalAuthenticator::load(&path).is_err());
    }

    #[test]
    fn backup_command_primitive_creates_verified_snapshot_without_overwrite() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("workflow.db");
        let backup = directory.path().join("workflow-backup.db");
        drop(Store::create_new(&database).unwrap());
        let source = Connection::open_with_flags(
            &database,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .unwrap();
        let version: i64 = source
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        source
            .execute("VACUUM INTO ?1", [backup.to_str().unwrap()])
            .unwrap();
        drop(source);
        fs::set_permissions(&backup, fs::Permissions::from_mode(0o600)).unwrap();
        verify_backup(&backup, version).unwrap();
        assert!(validate_new_absolute_path(&backup).is_err());
    }

    #[test]
    fn restore_backup_requires_private_current_schema_healthy_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let source = directory.path().join("source.db");
        let backup = directory.path().join("restore.db");
        drop(Store::create_new(&source).unwrap());
        let source_connection = Connection::open(&source).unwrap();
        source_connection
            .execute("VACUUM INTO ?1", [backup.to_str().unwrap()])
            .unwrap();
        drop(source_connection);
        fs::set_permissions(&backup, fs::Permissions::from_mode(0o600)).unwrap();
        verify_restore_backup(&backup).unwrap();
        validate_existing_database_file(&backup).unwrap();

        let connection = Connection::open(&backup).unwrap();
        connection
            .execute_batch("PRAGMA user_version=17; PRAGMA journal_mode=DELETE;")
            .unwrap();
        drop(connection);
        assert!(verify_restore_backup(&backup).is_err());

        let connection = Connection::open(&backup).unwrap();
        connection
            .execute_batch("PRAGMA user_version=20; PRAGMA journal_mode=DELETE;")
            .unwrap();
        drop(connection);
        let sidecar = PathBuf::from(format!("{}-wal", backup.display()));
        fs::write(&sidecar, b"stale WAL").unwrap();
        assert!(validate_existing_database_file(&backup).is_err());
    }

    #[test]
    fn offline_maintenance_lock_excludes_control_startup_pid_owner() {
        let directory = tempfile::tempdir().unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let pid = directory.path().join("control.pid");
        let _server_pid = PidFile::acquire(&pid).unwrap();
        assert!(acquire_offline_maintenance_lock_at(&pid).is_err());
    }

    #[test]
    fn pid_lock_recovers_dead_marker_but_keeps_live_process_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let pid = directory.path().join("control.pid");
        let lock = directory.path().join("control.lock");

        fs::write(&pid, format!("{}\n", i32::MAX)).unwrap();
        fs::set_permissions(&pid, fs::Permissions::from_mode(0o600)).unwrap();
        {
            let owner = PidFile::acquire(&pid).unwrap();
            assert_eq!(
                fs::read_to_string(&pid).unwrap().trim(),
                std::process::id().to_string()
            );
            assert!(lock.exists());
            assert!(PidFile::acquire(&pid).is_err());
            drop(owner);
        }
        assert!(!pid.exists());
        assert!(
            lock.exists(),
            "the advisory lock inode must remain stable between owners"
        );

        fs::write(&pid, format!("{}\n", std::process::id())).unwrap();
        fs::set_permissions(&pid, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(PidFile::acquire(&pid).is_err());
        assert_eq!(
            fs::read_to_string(&pid).unwrap().trim(),
            std::process::id().to_string(),
            "a live PID marker must never be replaced"
        );
    }

    #[test]
    fn pid_lock_rejects_malformed_and_insecure_stale_markers() {
        let directory = tempfile::tempdir().unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let pid = directory.path().join("control.pid");
        fs::write(&pid, "not-a-pid\n").unwrap();
        fs::set_permissions(&pid, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(PidFile::acquire(&pid).is_err());
        assert_eq!(fs::read_to_string(&pid).unwrap(), "not-a-pid\n");

        fs::write(&pid, format!("{}\n", i32::MAX)).unwrap();
        fs::set_permissions(&pid, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(PidFile::acquire(&pid).is_err());
        assert_eq!(fs::read_to_string(&pid).unwrap(), format!("{}\n", i32::MAX));
    }

    #[test]
    fn control_database_parent_must_be_private_and_canonical() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("control.db");
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        validate_private_parent(&database).unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(validate_private_parent(&database).is_err());
    }
}
