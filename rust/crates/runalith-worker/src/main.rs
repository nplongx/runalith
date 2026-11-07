//! Standalone execution-worker process entrypoint.

use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::ExitCode,
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

use chrono::Utc;
use runalith_artifacts::ArtifactStore;
use runalith_providers::{
    CurlGitHubHttpExecutor, GitHubActionsAdapter, GitHubActionsHttpTransport, ProviderAdapter,
};
use runalith_sandbox::{BubblewrapSandbox, CgroupV2Config, SandboxPolicy};
use runalith_worker::{
    ExecutionWorkspaceLimits, ExecutionWorkspaceManager, HttpControlPlane, ProviderPoller,
    SessionDeliveryWorker, SupervisorConfig, WorkerConfig, WorkerExecutor, WorkerHealthV1,
    WorkerStore, WorkerSupervisor,
};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("runalith-worker: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let command = std::env::args().nth(1).unwrap_or_else(|| "run".into());
    if command == "--version" || command == "version" {
        println!("runalith-worker {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if command == "stop" {
        return request_stop();
    }
    let config = WorkerConfig::from_env()?;
    match command.as_str() {
        "config" | "config-inspect" => {
            println!("{}", serde_json::to_string_pretty(&config.redacted_json())?);
            return Ok(());
        }
        "check-config" => {
            println!("worker configuration valid");
            return Ok(());
        }
        "health" => {
            let store = WorkerStore::open_read_only(config.data_dir.join("worker.db"))?;
            let counts = store.counts()?;
            let counts_object = counts
                .as_object()
                .ok_or("local worker store returned non-object counts")?;
            let mut durable_row_counts = BTreeMap::new();
            for (table, count) in counts_object {
                durable_row_counts.insert(
                    table.clone(),
                    count
                        .as_u64()
                        .ok_or("local worker store returned a non-integer row count")?,
                );
            }
            let health =
                WorkerHealthV1::local_store_available(config.worker_id.clone(), durable_row_counts);
            println!("{}", serde_json::to_string_pretty(&health)?);
            return Ok(());
        }
        "metrics" => {
            let store = WorkerStore::open_read_only(config.data_dir.join("worker.db"))?;
            let counts = store.counts()?;
            println!("# HELP runalith_worker_rows Number of durable worker records by table");
            println!("# TYPE runalith_worker_rows gauge");
            if let Some(counts) = counts.as_object() {
                for (table, count) in counts {
                    if let Some(count) = count.as_u64() {
                        println!(
                            "runalith_worker_rows{{worker_id=\"{}\",table=\"{}\"}} {}",
                            prometheus_escape(&config.worker_id),
                            prometheus_escape(table),
                            count
                        );
                    }
                }
            }
            return Ok(());
        }
        "run" => {}
        _ => return Err(format!("unknown command: {command}").into()),
    }
    run_worker(config)
}

fn run_worker(config: WorkerConfig) -> Result<(), Box<dyn std::error::Error>> {
    let store = WorkerStore::open(config.data_dir.join("worker.db"))?;
    let runtime_lock = RuntimeLock::acquire(&store)?;
    reject_stop_path(&config.shutdown_file)?;
    if config.shutdown_file.exists() {
        fs::remove_file(&config.shutdown_file)?;
    }
    let pid_file = PidFile::acquire(&config.pid_file, &runtime_lock.token)?;
    let _process_guard = WorkerProcessGuard::new(runtime_lock, pid_file);
    let artifacts = ArtifactStore::open_or_create(config.data_dir.join("artifacts"))?;
    let workspace_manager = ExecutionWorkspaceManager::open_with_helper(
        &config.workspace_root,
        &store,
        ExecutionWorkspaceLimits {
            bytes: config.workspace_quota_bytes,
            inodes: config.workspace_quota_inodes,
        },
        &config.quota_helper_socket,
    )?;
    let quarantined_workspaces = workspace_manager.recover_after_restart()?;
    if quarantined_workspaces > 0 {
        eprintln!(
            "runalith-worker: quarantined {quarantined_workspaces} unfinished execution workspaces after restart"
        );
    }
    let sandbox_cgroup = CgroupV2Config::from_env("RUNALITH_WORKER_CGROUP_ROOT")?;
    let sandbox = BubblewrapSandbox::new(SandboxPolicy {
        bubblewrap_binary: config.bubblewrap_binary.clone(),
        workspace_root: config.workspace_root.clone(),
        executable_roots: config.executable_roots.clone(),
        allowed_environment_keys: config.allowed_environment_keys.clone(),
        timeout_seconds: config.timeout_seconds,
        output_limit_bytes: config.output_limit_bytes,
        cgroup: sandbox_cgroup,
    })?;
    let transport_timeout_seconds = (config.lease_seconds / 3).clamp(1, 10) as u32;
    let control = Arc::new(HttpControlPlane::new(
        config.control_url.clone(),
        config.control_token.clone(),
        config.curl_binary.clone(),
        transport_timeout_seconds,
    )?);
    let executor =
        WorkerExecutor::new(&sandbox, &artifacts).with_workspace_allocator(&workspace_manager);
    let mut adapters: BTreeMap<String, Arc<dyn ProviderAdapter>> = BTreeMap::new();
    let provider_token = std::env::var("GITHUB_ACTIONS_TOKEN")
        .or_else(|_| std::env::var("GITHUB_TOKEN"))
        .ok();
    if let Some(token) = provider_token.as_ref() {
        let curl =
            CurlGitHubHttpExecutor::new(config.curl_binary.clone(), transport_timeout_seconds)?;
        let transport = GitHubActionsHttpTransport::with_executor(token.clone(), curl)?;
        adapters.insert(
            "github-actions".into(),
            Arc::new(GitHubActionsAdapter::new(transport)),
        );
    }
    let supervisor = WorkerSupervisor::new(
        SupervisorConfig {
            worker_id: config.worker_id.clone(),
            lease_seconds: config.lease_seconds,
            poll_interval: config.poll_interval,
        },
        control.clone(),
        &store,
        &executor,
    )?
    .with_provider_adapters(adapters.clone());
    let session_delivery =
        SessionDeliveryWorker::new(&store, control.as_ref(), config.worker_id.clone())?;
    let provider_adapter_ids = adapters.keys().cloned().collect::<Vec<_>>();
    let provider_poller = ProviderPoller::new(&store, &artifacts, adapters, None)
        .with_control_plane(control.as_ref());
    let secrets = [
        Some(config.control_token.as_str()),
        provider_token.as_deref(),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    log_event(
        "info",
        "worker.started",
        &config.worker_id,
        serde_json::json!({"data_dir":config.data_dir,"provider_adapters":provider_adapter_ids}),
        &secrets,
    );
    while !config.shutdown_file.exists() {
        if let Err(error) = supervisor.run_once() {
            log_event(
                "error",
                "worker.execution_loop_error",
                &config.worker_id,
                serde_json::json!({"error":error.to_string()}),
                &secrets,
            );
        }
        if let Err(error) = session_delivery.deliver_once() {
            log_event(
                "error",
                "worker.session_delivery_error",
                &config.worker_id,
                serde_json::json!({"error":error.to_string()}),
                &secrets,
            );
        }
        match provider_poller.poll_once(25) {
            Ok(report) if report.observed > 0 => log_event(
                "info",
                "worker.provider_reconciliation",
                &config.worker_id,
                serde_json::json!({"observed":report.observed,"runs_bound":report.runs_bound,"results_collected":report.results_collected,"unresolved":report.unresolved}),
                &secrets,
            ),
            Ok(_) => {}
            Err(error) => log_event(
                "error",
                "worker.provider_reconciliation_error",
                &config.worker_id,
                serde_json::json!({"error":error.to_string()}),
                &secrets,
            ),
        }
        if let Err(error) = supervisor.flush_provider_result_once() {
            log_event(
                "error",
                "worker.provider_result_publish_error",
                &config.worker_id,
                serde_json::json!({"error":error.to_string()}),
                &secrets,
            );
        }
        if let Err(error) = supervisor.flush_outbox_once() {
            log_event(
                "error",
                "worker.result_publish_error",
                &config.worker_id,
                serde_json::json!({"error":error.to_string()}),
                &secrets,
            );
        }
        sleep_interruptible(config.poll_interval, &config.shutdown_file);
    }
    for _ in 0..3 {
        let session = match session_delivery.deliver_once() {
            Ok(outcome) => outcome,
            Err(error) => {
                log_event(
                    "error",
                    "worker.shutdown_session_drain_error",
                    &config.worker_id,
                    serde_json::json!({"error":error.to_string()}),
                    &secrets,
                );
                runalith_worker::SessionDeliveryOutcome::Idle
            }
        };
        let provider = match supervisor.flush_provider_result_once() {
            Ok(progress) => progress,
            Err(error) => {
                log_event(
                    "error",
                    "worker.shutdown_provider_drain_error",
                    &config.worker_id,
                    serde_json::json!({"error":error.to_string()}),
                    &secrets,
                );
                false
            }
        };
        let task = match supervisor.flush_outbox_once() {
            Ok(progress) => progress,
            Err(error) => {
                log_event(
                    "error",
                    "worker.shutdown_result_drain_error",
                    &config.worker_id,
                    serde_json::json!({"error":error.to_string()}),
                    &secrets,
                );
                false
            }
        };
        if session == runalith_worker::SessionDeliveryOutcome::Idle && !provider && !task {
            break;
        }
    }
    log_event(
        "info",
        "worker.stopping",
        &config.worker_id,
        serde_json::json!({"reason":"shutdown_file"}),
        &secrets,
    );
    Ok(())
}

fn log_event(
    level: &str,
    event: &str,
    worker_id: &str,
    details: serde_json::Value,
    secrets: &[&str],
) {
    let mut details = details;
    redact_json(&mut details, secrets);
    eprintln!(
        "{}",
        serde_json::json!({"timestamp":Utc::now().to_rfc3339(),"level":level,"component":"runalith-worker","event":event,"worker_id":worker_id,"details":details})
    );
}

fn redact_json(value: &mut serde_json::Value, secrets: &[&str]) {
    match value {
        serde_json::Value::String(text) => {
            for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
                *text = text.replace(secret, "[REDACTED]");
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                redact_json(value, secrets);
            }
        }
        serde_json::Value::Object(values) => {
            for value in values.values_mut() {
                redact_json(value, secrets);
            }
        }
        _ => {}
    }
}

fn sleep_interruptible(duration: Duration, shutdown_file: &Path) {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline && !shutdown_file.exists() {
        thread::sleep(
            Duration::from_millis(100).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

fn request_stop() -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = PathBuf::from(
        std::env::var("RUNALITH_WORKER_DATA_DIR")
            .map_err(|_| "RUNALITH_WORKER_DATA_DIR is required")?,
    );
    if !data_dir.is_absolute()
        || data_dir == Path::new("/")
        || data_dir
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("RUNALITH_WORKER_DATA_DIR must be a safe absolute directory".into());
    }
    reject_stop_path(&data_dir)?;
    if !fs::symlink_metadata(&data_dir)?.is_dir() {
        return Err("worker data directory does not exist".into());
    }
    let shutdown = PathBuf::from(
        std::env::var("RUNALITH_WORKER_SHUTDOWN_FILE")
            .unwrap_or_else(|_| data_dir.join("worker.stop").display().to_string()),
    );
    let pid_file = PathBuf::from(
        std::env::var("RUNALITH_WORKER_PID_FILE")
            .unwrap_or_else(|_| data_dir.join("worker.pid").display().to_string()),
    );
    let reserved = [
        "worker.db",
        "worker.db-wal",
        "worker.db-shm",
        "artifacts",
        "worker.pid",
    ];
    if !shutdown.starts_with(&data_dir)
        || !pid_file.starts_with(&data_dir)
        || shutdown.parent() != Some(data_dir.as_path())
        || pid_file.parent() != Some(data_dir.as_path())
        || shutdown == pid_file
        || reserved.contains(
            &shutdown
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default(),
        )
        || reserved.contains(
            &pid_file
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default(),
        )
        || pid_file.file_name().and_then(|value| value.to_str()) == Some("worker.stop")
    {
        return Err(
            "worker stop and PID paths must remain inside the worker data directory".into(),
        );
    }
    reject_stop_path(&shutdown)?;
    reject_stop_path(&pid_file)?;
    if !pid_file.exists() {
        return Err(
            "worker PID file is absent; worker is not running or has not finished starting".into(),
        );
    }
    let pid_contents = fs::read_to_string(&pid_file)?;
    let pid_fields = pid_contents.split_whitespace().collect::<Vec<_>>();
    let pid = pid_fields
        .first()
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or("worker PID file is malformed")?;
    let process_is_current = match pid_fields.as_slice() {
        [_, start_ticks, _] => {
            process_start_ticks(pid)?
                == Some(
                    start_ticks
                        .parse::<u64>()
                        .map_err(|_| "worker PID start time is malformed")?,
                )
        }
        [_] => Path::new(&format!("/proc/{pid}")).exists(),
        _ => false,
    };
    if !process_is_current {
        fs::remove_file(&pid_file)?;
        return Err("worker PID file is stale; no active worker owns this data directory".into());
    }
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut stop_file = options.open(&shutdown)?;
    stop_file.write_all(b"stop\n")?;
    stop_file.sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&shutdown, fs::Permissions::from_mode(0o600))?;
    }
    let timeout_seconds = std::env::var("RUNALITH_WORKER_STOP_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(750)
        .clamp(1, 900);
    let deadline = Instant::now() + Duration::from_secs(timeout_seconds);
    while Path::new(&pid_file).exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(200));
    }
    if Path::new(&pid_file).exists() {
        return Err(format!("worker did not stop within {timeout_seconds} seconds").into());
    }
    Ok(())
}

fn reject_stop_path(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    for component in path.ancestors() {
        match fs::symlink_metadata(component) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("worker stop path contains a symlink".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn process_start_ticks(pid: u32) -> Result<Option<u64>, Box<dyn std::error::Error>> {
    let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let (_, fields) = stat
        .rsplit_once(')')
        .ok_or("process stat identity is malformed")?;
    let ticks = fields
        .split_whitespace()
        .nth(19)
        .ok_or("process stat omitted start time")?;
    Ok(Some(ticks.parse()?))
}

fn prometheus_escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

struct PidFile {
    path: std::path::PathBuf,
    token: String,
}

struct RuntimeLock<'a> {
    store: &'a WorkerStore,
    token: String,
}

struct WorkerProcessGuard<'a> {
    runtime_lock: Option<RuntimeLock<'a>>,
    pid_file: Option<PidFile>,
}

impl<'a> WorkerProcessGuard<'a> {
    fn new(runtime_lock: RuntimeLock<'a>, pid_file: PidFile) -> Self {
        Self {
            runtime_lock: Some(runtime_lock),
            pid_file: Some(pid_file),
        }
    }
}

impl Drop for WorkerProcessGuard<'_> {
    fn drop(&mut self) {
        drop(self.runtime_lock.take());
        drop(self.pid_file.take());
    }
}

impl<'a> RuntimeLock<'a> {
    fn acquire(store: &'a WorkerStore) -> Result<Self, Box<dyn std::error::Error>> {
        Ok(Self {
            store,
            token: store.acquire_process_lock()?,
        })
    }
}

impl Drop for RuntimeLock<'_> {
    fn drop(&mut self) {
        let _ = self.store.release_process_lock(&self.token);
    }
}

impl PidFile {
    fn acquire(path: &Path, lock_token: &str) -> Result<Self, Box<dyn std::error::Error>> {
        reject_stop_path(path)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        reject_stop_path(path)?;
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err("worker PID path must be a regular non-symlink file".into());
            }
            Ok(_) => fs::remove_file(path)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path)?;
        let start_ticks = process_start_ticks(std::process::id())?
            .ok_or("worker process identity unavailable")?;
        writeln!(file, "{} {start_ticks} {lock_token}", std::process::id())?;
        file.sync_all()?;
        Ok(Self {
            path: path.into(),
            token: lock_token.into(),
        })
    }
}
impl PidFile {
    fn owns_file(&self) -> bool {
        fs::read_to_string(&self.path)
            .is_ok_and(|contents| contents.split_whitespace().nth(2) == Some(self.token.as_str()))
    }
}
impl Drop for PidFile {
    fn drop(&mut self) {
        if self.owns_file() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_log_redaction_covers_nested_values() {
        let mut details =
            serde_json::json!({"error":"request used bearer-secret","nested":["provider-secret"]});
        redact_json(&mut details, &["bearer-secret", "provider-secret"]);
        assert_eq!(details["error"], "request used [REDACTED]");
        assert_eq!(details["nested"][0], "[REDACTED]");
    }

    #[test]
    fn prometheus_labels_escape_quotes_slashes_and_newlines() {
        assert_eq!(prometheus_escape("worker\"\\\n"), "worker\\\"\\\\\\n");
    }
}
