//! Fail-closed local process execution through Bubblewrap.
//!
//! There is deliberately no direct-process fallback. Network namespaces are
//! disabled, workspace is the only writable bind mount, executable roots are
//! read-only, environment is cleared, and process lifetime is bounded. This is
//! a Linux backend; unsupported hosts must provide another audited backend.

pub mod cgroup;
pub mod workspace_write;

pub use cgroup::{CgroupCleanupEvidence, CgroupV2Config, ResourceLimits};

use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    sync::mpsc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAX_ARGUMENTS: usize = 256;
const MAX_ARGUMENT_BYTES: usize = 65_536;
const MAX_STDIN_BYTES: usize = 1_048_576;
const MAX_ENVIRONMENT: usize = 64;
const MAX_ENV_VALUE_BYTES: usize = 16_384;
const CGROUP_LAUNCHER_SCRIPT: &str = "set -eu; printf '%s\\n' \"$$\" > \"$1\"; shift; exec 3<\"$1\"; actual=$(/usr/bin/stat -Lc '%d:%i' /proc/self/fd/3); [ \"$actual\" = \"$2\" ] || exit 126; shift 2; exec \"$@\"";
const MAX_TIMEOUT_SECONDS: u64 = 600;
const MAX_OUTPUT_BYTES: usize = 1_048_576;

/// Operator-provisioned Bubblewrap and filesystem policy.
#[derive(Debug, Clone)]
pub struct SandboxPolicy {
    /// Absolute path to the Bubblewrap executable.
    pub bubblewrap_binary: PathBuf,
    /// Existing workspace root; only this tree is writable in sandbox.
    pub workspace_root: PathBuf,
    /// Read-only roots from which executables may be selected.
    pub executable_roots: Vec<PathBuf>,
    /// Environment keys a task may set.
    pub allowed_environment_keys: BTreeSet<String>,
    /// Maximum wall-clock time, 1..=600 seconds.
    pub timeout_seconds: u64,
    /// Maximum captured bytes per output stream.
    pub output_limit_bytes: usize,
    /// Mandatory delegated cgroup v2 limits. There is no unsandboxed fallback.
    pub cgroup: CgroupV2Config,
}

/// Exact command request. No shell parsing is performed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandRequest {
    /// Absolute executable path.
    pub executable: PathBuf,
    /// Argument vector, passed without shell interpolation.
    pub arguments: Vec<String>,
    /// Working directory relative to workspace root.
    pub working_directory: PathBuf,
    /// Explicit environment additions.
    #[serde(default)]
    pub environment: std::collections::BTreeMap<String, String>,
    /// Optional stdin bytes.
    #[serde(default)]
    pub stdin: Vec<u8>,
}

/// Bounded process result. Digests cover captured bytes; truncated output is not complete evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandResult {
    /// Process exit code, absent when terminated by signal or timeout.
    pub exit_code: Option<i32>,
    /// Whether timeout forced process termination.
    pub timed_out: bool,
    /// Captured stdout as lossy UTF-8.
    pub stdout: String,
    /// Captured stderr as lossy UTF-8.
    pub stderr: String,
    /// Exact captured stdout bytes, suitable for immutable evidence storage.
    pub stdout_bytes: Vec<u8>,
    /// Exact captured stderr bytes, suitable for immutable evidence storage.
    pub stderr_bytes: Vec<u8>,
    /// SHA-256 of captured stdout bytes.
    pub stdout_sha256: String,
    /// SHA-256 of captured stderr bytes.
    pub stderr_sha256: String,
    /// Whether stdout exceeded capture limit.
    pub stdout_truncated: bool,
    /// Whether stderr exceeded capture limit.
    pub stderr_truncated: bool,
    /// Stable backend label.
    pub sandbox_backend: String,
}

/// Process identity and local cgroup quiescence observed by a sandbox backend.
///
/// The cgroup observation proves only that this worker-local process tree was
/// empty. It does not prove that a provider stopped, that remote side effects
/// are terminal, or that Control may settle a lease.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxProcessObservation {
    /// Direct launcher PID assigned by the host kernel.
    pub process_id: u32,
    /// Unix milliseconds after the launcher was spawned.
    pub started_at_unix_ms: u64,
    /// Unix milliseconds after the cgroup was observed empty and reaped.
    pub finished_at_unix_ms: u64,
    /// Kernel cgroup kill/empty observation for this exact process tree.
    pub cgroup: CgroupCleanupEvidence,
}

/// Command output plus optional backend-authenticated local process observations.
///
/// Non-host-backed/fake executors may return no process observation. Consumers
/// must not synthesize a stop receipt from command exit status alone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedCommandResult {
    /// Bounded command result and captured output.
    pub result: CommandResult,
    /// Present only when the backend observed its process tree become quiescent.
    pub process: Option<SandboxProcessObservation>,
    /// Lease cancellation was observed after process creation and the process
    /// tree was successfully stopped. Worker outcome must remain UNKNOWN.
    pub cancelled_after_start: bool,
}

/// Sandbox configuration, request, or execution failure.
#[derive(Debug, Error)]
pub enum SandboxError {
    /// Host is not Linux or Bubblewrap is unavailable.
    #[error("required Bubblewrap sandbox backend is unavailable: {0}")]
    BackendUnavailable(String),
    /// Request violates command or filesystem policy.
    #[error("sandbox policy rejected request: {0}")]
    Policy(String),
    /// Process creation or I/O failed.
    #[error("sandbox process error: {0}")]
    Io(#[from] std::io::Error),
    /// OS refused process creation; command was not started.
    #[error("sandbox command was not started: {0}")]
    Spawn(#[source] std::io::Error),
    /// Cancellation was observed before process creation.
    #[error("sandbox command was cancelled before start")]
    CancelledBeforeStart,
    /// Process started but exact completion/result could not be established.
    #[error("sandbox process outcome is ambiguous: {0}")]
    ProcessUnknown(String),
}

/// Linux Bubblewrap process executor. Never falls back to unsandboxed execution.
pub struct BubblewrapSandbox {
    policy: SandboxPolicy,
    bubblewrap_binary: PathBuf,
    workspace_root: PathBuf,
    workspace_identity: (u64, u64),
    executable_roots: Vec<PathBuf>,
}

/// Injectable sandbox execution capability. Runtime can test failure semantics without bypassing policy.
pub trait SandboxExecutor: Send + Sync {
    /// Execute one exact request or report whether outcome is ambiguous.
    fn execute(&self, request: CommandRequest) -> Result<CommandResult, SandboxError>;

    /// Digest of the effective process, filesystem and resource policy.
    /// Backends that cannot provide a stable policy digest must return `None`;
    /// workers then refuse to reserve or start externally fenced execution.
    fn execution_profile_sha256(&self) -> Option<String> {
        None
    }

    /// Whether this backend refuses to execute unless supplied a unique
    /// per-execution workspace whose filesystem limits were externally verified.
    fn requires_isolated_workspace(&self) -> bool {
        false
    }

    /// Digest the effective sandbox policy for an exact execution workspace.
    fn execution_profile_sha256_for_workspace(&self, _workspace_root: &Path) -> Option<String> {
        self.execution_profile_sha256()
    }

    /// Execute inside the exact allocated execution workspace. Backends that
    /// require isolation override this method; the default is for test/fake
    /// backends that do not require a host-backed execution workspace.
    fn execute_cancellable_in_workspace(
        &self,
        request: CommandRequest,
        _workspace_root: &Path,
        _expected_workspace_identity: Option<(u64, u64)>,
        cancelled: &AtomicBool,
    ) -> Result<CommandResult, SandboxError> {
        self.execute_cancellable(request, cancelled)
    }

    /// Execute while observing an external cancellation fence. Backends that
    /// cannot terminate a running process retain the conservative default.
    fn execute_cancellable(
        &self,
        request: CommandRequest,
        cancelled: &AtomicBool,
    ) -> Result<CommandResult, SandboxError> {
        if cancelled.load(Ordering::Acquire) {
            return Err(SandboxError::CancelledBeforeStart);
        }
        self.execute(request)
    }

    /// Execute and return any backend-verifiable local process observation.
    /// The compatibility default returns no stop evidence; it never infers
    /// process-tree quiescence from an exit status.
    fn execute_cancellable_observed(
        &self,
        request: CommandRequest,
        cancelled: &AtomicBool,
    ) -> Result<ObservedCommandResult, SandboxError> {
        let result = self.execute_cancellable(request, cancelled)?;
        Ok(ObservedCommandResult {
            result,
            process: None,
            cancelled_after_start: cancelled.load(Ordering::Acquire),
        })
    }

    /// Workspace-bound counterpart to `execute_cancellable_observed`.
    fn execute_cancellable_observed_in_workspace(
        &self,
        request: CommandRequest,
        workspace_root: &Path,
        expected_workspace_identity: Option<(u64, u64)>,
        cancelled: &AtomicBool,
    ) -> Result<ObservedCommandResult, SandboxError> {
        let result = self.execute_cancellable_in_workspace(
            request,
            workspace_root,
            expected_workspace_identity,
            cancelled,
        )?;
        Ok(ObservedCommandResult {
            result,
            process: None,
            cancelled_after_start: cancelled.load(Ordering::Acquire),
        })
    }
}

impl BubblewrapSandbox {
    /// Validate and pin all host paths before accepting commands.
    pub fn new(policy: SandboxPolicy) -> Result<Self, SandboxError> {
        if !cfg!(target_os = "linux") {
            return Err(SandboxError::BackendUnavailable(
                "Bubblewrap backend requires Linux".into(),
            ));
        }
        if !(1..=MAX_TIMEOUT_SECONDS).contains(&policy.timeout_seconds)
            || policy.output_limit_bytes == 0
            || policy.output_limit_bytes > MAX_OUTPUT_BYTES
        {
            return Err(SandboxError::Policy("timeout/output bounds invalid".into()));
        }
        let bubblewrap_binary = canonical_regular_executable(&policy.bubblewrap_binary)?;
        if bubblewrap_binary
            .file_name()
            .is_none_or(|name| name != "bwrap")
        {
            return Err(SandboxError::BackendUnavailable(
                "configured sandbox executable is not named bwrap".into(),
            ));
        }
        let workspace_metadata = fs::symlink_metadata(&policy.workspace_root)?;
        if workspace_metadata.file_type().is_symlink() || !workspace_metadata.is_dir() {
            return Err(SandboxError::Policy(
                "workspace root must be a regular non-symlink directory".into(),
            ));
        }
        let workspace_root = fs::canonicalize(&policy.workspace_root)?;
        if workspace_root == Path::new("/") || bubblewrap_binary.starts_with(&workspace_root) {
            return Err(SandboxError::Policy(
                "workspace root is too broad or contains the host sandbox binary".into(),
            ));
        }
        let workspace_fd = open_pinned_directory(&workspace_root)?;
        #[cfg(target_os = "linux")]
        let workspace_identity = {
            use std::os::unix::fs::MetadataExt;
            let metadata = workspace_fd.metadata()?;
            (metadata.dev(), metadata.ino())
        };
        #[cfg(not(target_os = "linux"))]
        let workspace_identity = (0, 0);
        let mut executable_roots = Vec::new();
        for root in &policy.executable_roots {
            let metadata = fs::symlink_metadata(root)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(SandboxError::Policy(format!(
                    "executable root is not a regular directory: {}",
                    root.display()
                )));
            }
            let canonical = fs::canonicalize(root)?;
            if canonical.starts_with(&workspace_root) || workspace_root.starts_with(&canonical) {
                return Err(SandboxError::Policy(
                    "executable roots must be disjoint from writable workspace".into(),
                ));
            }
            if !executable_roots.contains(&canonical) {
                executable_roots.push(canonical);
            }
        }
        if executable_roots.is_empty() {
            return Err(SandboxError::Policy(
                "at least one read-only executable root is required".into(),
            ));
        }
        // Probe delegation during construction. A worker must not start in a
        // configuration that can only discover missing resource isolation at
        // the first untrusted command.
        policy
            .cgroup
            .prepare()
            .map_err(|error| SandboxError::BackendUnavailable(error.to_string()))?
            .cleanup()
            .map_err(|error| SandboxError::BackendUnavailable(error.to_string()))?;
        for key in &policy.allowed_environment_keys {
            if !valid_env_key(key)
                || matches!(
                    key.as_str(),
                    "PATH" | "HOME" | "TMPDIR" | "LD_PRELOAD" | "LD_LIBRARY_PATH"
                )
            {
                return Err(SandboxError::Policy(format!(
                    "reserved or invalid environment key: {key}"
                )));
            }
        }
        Ok(Self {
            policy,
            bubblewrap_binary,
            workspace_root,
            workspace_identity,
            executable_roots,
        })
    }

    /// Execute one command inside a network-isolated Bubblewrap namespace.
    pub fn execute(&self, request: CommandRequest) -> Result<CommandResult, SandboxError> {
        self.execute_with_cancellation(request, None)
    }

    /// Execute one command and terminate it if its lease cancellation fence is raised.
    pub fn execute_with_cancellation(
        &self,
        request: CommandRequest,
        cancelled: Option<&AtomicBool>,
    ) -> Result<CommandResult, SandboxError> {
        self.execute_with_cancellation_observed(request, cancelled)
            .map(|observed| observed.result)
    }

    /// Execute while retaining the exact process identity and cgroup quiescence evidence.
    pub fn execute_with_cancellation_observed(
        &self,
        request: CommandRequest,
        cancelled: Option<&AtomicBool>,
    ) -> Result<ObservedCommandResult, SandboxError> {
        validate_request(&request, &self.policy.allowed_environment_keys)?;
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return Err(SandboxError::CancelledBeforeStart);
        }
        let executable = canonical_regular_executable(&request.executable)?;
        if !self
            .executable_roots
            .iter()
            .any(|root| executable.starts_with(root))
        {
            return Err(SandboxError::Policy(
                "executable is outside read-only allowlisted roots".into(),
            ));
        }
        let working_directory = self.workspace_root.join(&request.working_directory);
        let working_directory = fs::canonicalize(&working_directory)?;
        if !working_directory.starts_with(&self.workspace_root) {
            return Err(SandboxError::Policy(
                "working directory escapes workspace root".into(),
            ));
        }
        let mut cgroup = self
            .policy
            .cgroup
            .prepare()
            .map_err(|error| SandboxError::BackendUnavailable(error.to_string()))?;
        self.execute_in_sandbox(
            &request,
            &executable,
            &working_directory,
            cancelled,
            &mut cgroup,
        )
    }

    fn execute_in_sandbox(
        &self,
        request: &CommandRequest,
        executable: &Path,
        working_directory: &Path,
        cancelled: Option<&AtomicBool>,
        cgroup: &mut cgroup::ExecutionCgroup,
    ) -> Result<ObservedCommandResult, SandboxError> {
        let relative_workdir = working_directory
            .strip_prefix(&self.workspace_root)
            .map_err(|_| SandboxError::Policy("working directory escapes workspace".into()))?;
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(CGROUP_LAUNCHER_SCRIPT)
            .arg("runalith-cgroup-launcher")
            .arg(cgroup.procs_path())
            .arg(&self.workspace_root)
            .arg(format!(
                "{}:{}",
                self.workspace_identity.0, self.workspace_identity.1
            ))
            .arg(&self.bubblewrap_binary);
        command.args([
            "--die-with-parent",
            "--unshare-all",
            "--unshare-net",
            "--unshare-pid",
            "--as-pid-1",
        ]);
        command.args(["--dir", "/usr", "--ro-bind", "/usr", "/usr"]);
        for system_root in ["/bin", "/sbin", "/lib", "/lib64"] {
            if Path::new(system_root).exists() {
                let source = fs::canonicalize(system_root)?;
                if source != Path::new(system_root) {
                    command.args(["--symlink"]).arg(source).arg(system_root);
                } else {
                    command.args(["--dir", system_root]);
                    command.args(["--ro-bind"]).arg(source).arg(system_root);
                }
            }
        }
        let scratch_bytes = self.policy.cgroup.limits.scratch_max_bytes.to_string();
        command.args([
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--size",
            &scratch_bytes,
            "--tmpfs",
            "/tmp",
        ]);
        command.args(["--dir", "/workspace", "--dir", "/runalith-scratch"]);
        command.args(["--bind-fd", "3", "/workspace"]);
        command.args(["--size", &scratch_bytes, "--tmpfs", "/runalith-scratch"]);
        for root in &self.executable_roots {
            if root.starts_with("/usr")
                || ["/bin", "/sbin", "/lib", "/lib64"]
                    .iter()
                    .filter_map(|path| fs::canonicalize(path).ok())
                    .any(|system_root| root.starts_with(system_root))
            {
                continue;
            }
            let mut parent = PathBuf::from("/");
            if let Some(parent_path) = root.parent() {
                for component in parent_path
                    .components()
                    .filter_map(|component| match component {
                        std::path::Component::Normal(part) => Some(part),
                        _ => None,
                    })
                {
                    parent.push(component);
                    command.args(["--dir"]).arg(&parent);
                }
            }
            command.args(["--dir"]).arg(root);
            command.args(["--ro-bind"]).arg(root).arg(root);
        }
        command
            .args(["--chdir"])
            .arg(Path::new("/workspace").join(relative_workdir));
        command.args([
            "--clearenv",
            "--setenv",
            "PATH",
            "/usr/bin:/bin:/usr/sbin:/sbin",
            "--setenv",
            "HOME",
            "/runalith-scratch",
            "--setenv",
            "TMPDIR",
            "/runalith-scratch",
        ]);
        for (key, value) in &request.environment {
            command.args(["--setenv", key, value]);
        }
        command.arg("--").arg(executable).args(&request.arguments);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(SandboxError::Spawn)?;
        let process_id = child.id();
        let started_at_unix_ms = unix_time_millis();
        let stdout = child.stdout.take().ok_or_else(|| {
            SandboxError::ProcessUnknown("stdout pipe missing after process start".into())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            SandboxError::ProcessUnknown("stderr pipe missing after process start".into())
        })?;
        let (stdout_tx, stdout_rx) = mpsc::channel();
        let (stderr_tx, stderr_rx) = mpsc::channel();
        let limit = self.policy.output_limit_bytes;
        let stdout_thread = thread::spawn(move || read_bounded(stdout, limit, stdout_tx));
        let stderr_thread = thread::spawn(move || read_bounded(stderr, limit, stderr_tx));
        let stdin_thread = if let Some(mut stdin) = child.stdin.take() {
            let input = request.stdin.clone();
            Some(thread::spawn(move || stdin.write_all(&input)))
        } else {
            None
        };
        let deadline = Instant::now() + Duration::from_secs(self.policy.timeout_seconds);
        let mut timed_out = false;
        let mut cancelled_after_start = false;
        let mut process_tree_evidence = None;
        let status: ExitStatus = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {}
                Err(error) => {
                    let termination = terminate_cgroup_before_wait(&mut child, cgroup);
                    let pipe_error = reap_terminated_pipes(
                        stdout_rx,
                        stderr_rx,
                        stdout_thread,
                        stderr_thread,
                        stdin_thread,
                        Duration::from_secs(5),
                    )
                    .err();
                    let mut diagnostic = format!("wait status unavailable: {error}");
                    if let Err(error) = termination {
                        diagnostic
                            .push_str(&format!("; process-tree teardown unresolved: {error}"));
                    }
                    if let Some(error) = pipe_error {
                        diagnostic.push_str(&format!("; pipe teardown unresolved: {error}"));
                    }
                    return Err(SandboxError::ProcessUnknown(diagnostic));
                }
            }
            if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
                cancelled_after_start = true;
                match terminate_cgroup_before_wait(&mut child, cgroup) {
                    Ok((status, evidence)) => {
                        process_tree_evidence = Some(evidence);
                        break status;
                    }
                    Err(error) => {
                        let pipe_error = reap_terminated_pipes(
                            stdout_rx,
                            stderr_rx,
                            stdout_thread,
                            stderr_thread,
                            stdin_thread,
                            Duration::from_secs(5),
                        )
                        .err();
                        let mut diagnostic =
                            "lease ownership lost while process was running".to_owned();
                        diagnostic
                            .push_str(&format!("; process-tree teardown unresolved: {error}"));
                        if let Some(error) = pipe_error {
                            diagnostic.push_str(&format!("; pipe teardown unresolved: {error}"));
                        }
                        return Err(SandboxError::ProcessUnknown(diagnostic));
                    }
                }
            }
            if Instant::now() >= deadline {
                timed_out = true;
                match terminate_cgroup_before_wait(&mut child, cgroup) {
                    Ok((status, evidence)) => {
                        process_tree_evidence = Some(evidence);
                        break status;
                    }
                    Err(error) => {
                        let pipe_error = reap_terminated_pipes(
                            stdout_rx,
                            stderr_rx,
                            stdout_thread,
                            stderr_thread,
                            stdin_thread,
                            Duration::from_secs(5),
                        )
                        .err();
                        let mut diagnostic = format!(
                            "timeout occurred but process-tree teardown is unresolved: {error}"
                        );
                        if let Some(error) = pipe_error {
                            diagnostic.push_str(&format!("; pipe teardown unresolved: {error}"));
                        }
                        return Err(SandboxError::ProcessUnknown(diagnostic));
                    }
                }
            }
            thread::sleep(Duration::from_millis(10));
        };
        let cgroup_evidence = match process_tree_evidence {
            Some(evidence) => evidence,
            None => cgroup.cleanup_with_evidence().map_err(|error| {
                SandboxError::ProcessUnknown(format!("execution cgroup cleanup failed: {error}"))
            })?,
        };
        let finished_at_unix_ms = unix_time_millis();
        let (stdout_bytes, stdout_truncated) = stdout_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|error| {
                SandboxError::ProcessUnknown(format!(
                    "stdout drain did not finish after process exit: {error}"
                ))
            })?
            .map_err(|error| {
                SandboxError::ProcessUnknown(format!("stdout read failed: {error}"))
            })?;
        let (stderr_bytes, stderr_truncated) = stderr_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|error| {
                SandboxError::ProcessUnknown(format!(
                    "stderr drain did not finish after process exit: {error}"
                ))
            })?
            .map_err(|error| {
                SandboxError::ProcessUnknown(format!("stderr read failed: {error}"))
            })?;
        stdout_thread.join().map_err(|_| {
            SandboxError::ProcessUnknown("stdout reader panicked after process completion".into())
        })?;
        stderr_thread.join().map_err(|_| {
            SandboxError::ProcessUnknown("stderr reader panicked after process completion".into())
        })?;
        if let Some(writer) = stdin_thread {
            let writer_deadline = Instant::now() + Duration::from_secs(5);
            while !writer.is_finished() && Instant::now() < writer_deadline {
                thread::sleep(Duration::from_millis(10));
            }
            if !writer.is_finished() {
                return Err(SandboxError::ProcessUnknown(
                    "sandbox stdin writer did not terminate".into(),
                ));
            }
            let write_result = writer.join().map_err(|_| {
                SandboxError::ProcessUnknown("stdin writer panicked after process start".into())
            })?;
            if let Err(error) = write_result {
                if !(timed_out && error.kind() == std::io::ErrorKind::BrokenPipe) {
                    return Err(SandboxError::ProcessUnknown(format!(
                        "stdin write failed: {error}"
                    )));
                }
            }
        }
        Ok(ObservedCommandResult {
            result: CommandResult {
                exit_code: status.code(),
                timed_out,
                stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
                stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
                stdout_sha256: digest(&stdout_bytes),
                stderr_sha256: digest(&stderr_bytes),
                stdout_bytes,
                stderr_bytes,
                stdout_truncated,
                stderr_truncated,
                sandbox_backend: "bubblewrap-linux-network-isolated".into(),
            },
            process: Some(SandboxProcessObservation {
                process_id,
                started_at_unix_ms,
                finished_at_unix_ms,
                cgroup: cgroup_evidence,
            }),
            cancelled_after_start,
        })
    }
}

/// Terminate the complete execution cgroup and verify it is empty before waiting
/// for the direct child. Waiting first can block forever when a process-group kill
/// misses a descendant; cgroup cleanup is the authoritative process-tree boundary.
fn terminate_cgroup_before_wait(
    child: &mut std::process::Child,
    cgroup: &mut cgroup::ExecutionCgroup,
) -> Result<(ExitStatus, CgroupCleanupEvidence), String> {
    let evidence = cgroup
        .cleanup_with_evidence()
        .map_err(|error| format!("cgroup kill/empty verification failed: {error}"))?;
    let status = child
        .wait()
        .map_err(|error| format!("wait after verified cgroup teardown failed: {error}"))?;
    Ok((status, evidence))
}

fn unix_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

impl SandboxExecutor for BubblewrapSandbox {
    fn execute(&self, request: CommandRequest) -> Result<CommandResult, SandboxError> {
        BubblewrapSandbox::execute(self, request)
    }

    fn execution_profile_sha256(&self) -> Option<String> {
        let limits = &self.policy.cgroup.limits;
        let profile = serde_json::json!({
            "schema_version": 1,
            "bubblewrap_binary": self.bubblewrap_binary,
            "workspace_device": self.workspace_identity.0,
            "workspace_inode": self.workspace_identity.1,
            "executable_roots": self.executable_roots,
            "allowed_environment_keys": self.policy.allowed_environment_keys,
            "timeout_seconds": self.policy.timeout_seconds,
            "output_limit_bytes": self.policy.output_limit_bytes,
            "cgroup_root": self.policy.cgroup.root,
            "resource_limits": {
                "memory_max_bytes": limits.memory_max_bytes,
                "cpu_quota_micros": limits.cpu_quota_micros,
                "cpu_period_micros": limits.cpu_period_micros,
                "pids_max": limits.pids_max,
                "scratch_max_bytes": limits.scratch_max_bytes
            }
        });
        let bytes = serde_json::to_vec(&profile).ok()?;
        Some(hex::encode(Sha256::digest(bytes)))
    }

    fn requires_isolated_workspace(&self) -> bool {
        true
    }

    fn execution_profile_sha256_for_workspace(&self, workspace_root: &Path) -> Option<String> {
        let mut policy = self.policy.clone();
        policy.workspace_root = workspace_root.to_owned();
        Self::new(policy).ok()?.execution_profile_sha256()
    }

    fn execute_cancellable(
        &self,
        request: CommandRequest,
        cancelled: &AtomicBool,
    ) -> Result<CommandResult, SandboxError> {
        self.execute_with_cancellation(request, Some(cancelled))
    }

    fn execute_cancellable_observed(
        &self,
        request: CommandRequest,
        cancelled: &AtomicBool,
    ) -> Result<ObservedCommandResult, SandboxError> {
        self.execute_with_cancellation_observed(request, Some(cancelled))
    }

    fn execute_cancellable_in_workspace(
        &self,
        request: CommandRequest,
        workspace_root: &Path,
        expected_workspace_identity: Option<(u64, u64)>,
        cancelled: &AtomicBool,
    ) -> Result<CommandResult, SandboxError> {
        let mut policy = self.policy.clone();
        policy.workspace_root = workspace_root.to_owned();
        let sandbox = Self::new(policy)?;
        if expected_workspace_identity != Some(sandbox.workspace_identity) {
            return Err(SandboxError::Policy(
                "execution workspace device/inode changed after quota verification".into(),
            ));
        }
        sandbox.execute_with_cancellation(request, Some(cancelled))
    }

    fn execute_cancellable_observed_in_workspace(
        &self,
        request: CommandRequest,
        workspace_root: &Path,
        expected_workspace_identity: Option<(u64, u64)>,
        cancelled: &AtomicBool,
    ) -> Result<ObservedCommandResult, SandboxError> {
        let mut policy = self.policy.clone();
        policy.workspace_root = workspace_root.to_owned();
        let sandbox = Self::new(policy)?;
        if expected_workspace_identity != Some(sandbox.workspace_identity) {
            return Err(SandboxError::Policy(
                "execution workspace device/inode changed after quota verification".into(),
            ));
        }
        sandbox.execute_with_cancellation_observed(request, Some(cancelled))
    }
}

fn validate_request(
    request: &CommandRequest,
    allowed_environment: &BTreeSet<String>,
) -> Result<(), SandboxError> {
    if request.arguments.len() > MAX_ARGUMENTS
        || request
            .arguments
            .iter()
            .any(|arg| arg.len() > MAX_ARGUMENT_BYTES)
        || request.arguments.iter().map(String::len).sum::<usize>() > MAX_ARGUMENT_BYTES
        || request.stdin.len() > MAX_STDIN_BYTES
        || request.environment.len() > MAX_ENVIRONMENT
    {
        return Err(SandboxError::Policy(
            "argument, stdin, or environment bound exceeded".into(),
        ));
    }
    if request.working_directory.is_absolute()
        || request.working_directory.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(SandboxError::Policy(
            "working directory must be a relative path without parent traversal".into(),
        ));
    }
    if !request.executable.is_absolute() || request.arguments.iter().any(|arg| arg.contains('\0')) {
        return Err(SandboxError::Policy(
            "executable must be absolute and arguments cannot contain NUL".into(),
        ));
    }
    for (key, value) in &request.environment {
        if !valid_env_key(key)
            || !allowed_environment.contains(key)
            || value.len() > MAX_ENV_VALUE_BYTES
            || value.contains('\0')
        {
            return Err(SandboxError::Policy(format!(
                "environment key/value not allowed: {key}"
            )));
        }
    }
    Ok(())
}

fn canonical_regular_executable(path: &Path) -> Result<PathBuf, SandboxError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(SandboxError::Policy(format!(
            "executable must be a regular non-symlink file: {}",
            path.display()
        )));
    }
    let canonical = fs::canonicalize(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(SandboxError::Policy(
                "executable lacks execute permission".into(),
            ));
        }
    }
    Ok(canonical)
}

fn valid_env_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key.bytes().enumerate().all(|(i, byte)| {
            byte.is_ascii_uppercase() || byte == b'_' || (i > 0 && byte.is_ascii_digit())
        })
}

fn read_bounded<R: Read>(
    mut reader: R,
    limit: usize,
    sender: mpsc::Sender<Result<(Vec<u8>, bool), String>>,
) {
    let mut captured = Vec::with_capacity(limit.min(8192));
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Err(error) => {
                let _ = sender.send(Err(error.to_string()));
                return;
            }
            Ok(read) => {
                let remaining = limit.saturating_sub(captured.len());
                let take = read.min(remaining);
                captured.extend_from_slice(&buffer[..take]);
                truncated |= take < read;
            }
        }
    }
    let _ = sender.send(Ok((captured, truncated)));
}

fn reap_terminated_pipes(
    stdout_rx: mpsc::Receiver<Result<(Vec<u8>, bool), String>>,
    stderr_rx: mpsc::Receiver<Result<(Vec<u8>, bool), String>>,
    stdout_thread: thread::JoinHandle<()>,
    stderr_thread: thread::JoinHandle<()>,
    stdin_thread: Option<thread::JoinHandle<std::io::Result<()>>>,
    timeout: Duration,
) -> Result<(), SandboxError> {
    stdout_rx
        .recv_timeout(timeout)
        .map_err(|error| {
            SandboxError::ProcessUnknown(format!(
                "stdout reader did not stop after sandbox teardown: {error}"
            ))
        })?
        .map_err(|error| {
            SandboxError::ProcessUnknown(format!(
                "stdout reader failed after sandbox teardown: {error}"
            ))
        })?;
    stderr_rx
        .recv_timeout(timeout)
        .map_err(|error| {
            SandboxError::ProcessUnknown(format!(
                "stderr reader did not stop after sandbox teardown: {error}"
            ))
        })?
        .map_err(|error| {
            SandboxError::ProcessUnknown(format!(
                "stderr reader failed after sandbox teardown: {error}"
            ))
        })?;
    stdout_thread.join().map_err(|_| {
        SandboxError::ProcessUnknown("stdout reader panicked during sandbox teardown".into())
    })?;
    stderr_thread.join().map_err(|_| {
        SandboxError::ProcessUnknown("stderr reader panicked during sandbox teardown".into())
    })?;
    if let Some(writer) = stdin_thread {
        let deadline = Instant::now() + timeout;
        while !writer.is_finished() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        if !writer.is_finished() {
            return Err(SandboxError::ProcessUnknown(
                "stdin writer did not stop after sandbox teardown".into(),
            ));
        }
        let _ = writer.join().map_err(|_| {
            SandboxError::ProcessUnknown("stdin writer panicked during sandbox teardown".into())
        })?;
    }
    Ok(())
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn open_pinned_directory(path: &Path) -> Result<File, SandboxError> {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        let mut options = fs::OpenOptions::new();
        options
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
        let file = options.open(path)?;
        let expected = fs::metadata(path)?;
        let actual = file.metadata()?;
        if !actual.is_dir() || (expected.dev(), expected.ino()) != (actual.dev(), actual.ino()) {
            return Err(SandboxError::Policy(
                "workspace root changed while pinning its directory descriptor".into(),
            ));
        }
        Ok(file)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = path;
        Err(SandboxError::BackendUnavailable(
            "descriptor-based Bubblewrap workspace binding requires Linux".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn cgroup_cleanup_failure_does_not_block_waiting_for_live_child() {
        let directory = tempfile::tempdir().unwrap();
        let cgroup_path = directory.path().join("runalith-execution");
        fs::create_dir(&cgroup_path).unwrap();
        fs::write(cgroup_path.join("cgroup.kill"), "").unwrap();
        // Missing cgroup.events makes the authoritative emptiness check fail.
        let mut cgroup = cgroup::ExecutionCgroup::for_test(cgroup_path);
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();

        let error = terminate_cgroup_before_wait(&mut child, &mut cgroup).unwrap_err();
        assert!(error.contains("cgroup kill/empty verification failed"));
        assert!(child.try_wait().unwrap().is_none());

        child.kill().unwrap();
        child.wait().unwrap();
    }

    fn delegated_test_cgroup() -> Option<CgroupV2Config> {
        let config = match CgroupV2Config::current_process(ResourceLimits::default()) {
            Ok(config) => config,
            Err(error) => {
                eprintln!("skipped cgroup integration test: {error}");
                return None;
            }
        };
        let mut probe = match config.prepare() {
            Ok(probe) => probe,
            Err(error) => {
                eprintln!("skipped cgroup integration test: {error}");
                return None;
            }
        };
        if let Err(error) = probe.cleanup() {
            eprintln!("skipped cgroup integration test: cleanup probe failed: {error}");
            return None;
        }
        Some(config)
    }

    #[test]
    fn execution_profile_digest_is_stable_and_binds_resource_policy() {
        let directory = tempfile::tempdir().unwrap();
        let policy = SandboxPolicy {
            bubblewrap_binary: "/usr/bin/bwrap".into(),
            workspace_root: directory.path().into(),
            executable_roots: vec!["/usr/bin".into()],
            allowed_environment_keys: BTreeSet::from(["LANG".into()]),
            timeout_seconds: 30,
            output_limit_bytes: 4096,
            cgroup: CgroupV2Config::new(directory.path().join("cgroup"), ResourceLimits::default())
                .unwrap(),
        };
        let make_sandbox = |policy: SandboxPolicy| BubblewrapSandbox {
            bubblewrap_binary: policy.bubblewrap_binary.clone(),
            workspace_root: policy.workspace_root.clone(),
            workspace_identity: (10, 20),
            executable_roots: policy.executable_roots.clone(),
            policy,
        };
        let first = make_sandbox(policy.clone());
        let second = make_sandbox(policy.clone());
        let first_digest = first.execution_profile_sha256().unwrap();
        assert_eq!(first_digest, second.execution_profile_sha256().unwrap());
        assert_eq!(first_digest.len(), 64);

        let mut changed_policy = policy;
        changed_policy.timeout_seconds += 1;
        let changed = make_sandbox(changed_policy);
        assert_ne!(first_digest, changed.execution_profile_sha256().unwrap());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn cgroup_launcher_opens_and_passes_exact_workspace_directory_fd() {
        use std::os::unix::fs::MetadataExt;

        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let metadata = fs::metadata(&workspace).unwrap();
        let cgroup_procs = directory.path().join("cgroup.procs");
        fs::write(&cgroup_procs, "").unwrap();
        let status = Command::new("/bin/sh")
            .arg("-c")
            .arg(CGROUP_LAUNCHER_SCRIPT)
            .arg("test-launcher")
            .arg(&cgroup_procs)
            .arg(&workspace)
            .arg(format!("{}:{}", metadata.dev(), metadata.ino()))
            .arg("/bin/sh")
            .arg("-c")
            .arg("test -d /proc/self/fd/3")
            .status()
            .unwrap();
        assert!(status.success());
        assert!(!fs::read_to_string(cgroup_procs).unwrap().trim().is_empty());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn cgroup_launcher_rejects_workspace_replacement_before_exec() {
        use std::os::unix::fs::MetadataExt;

        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        let moved = directory.path().join("workspace-original");
        fs::create_dir(&workspace).unwrap();
        let metadata = fs::metadata(&workspace).unwrap();
        fs::rename(&workspace, &moved).unwrap();
        fs::create_dir(&workspace).unwrap();
        let cgroup_procs = directory.path().join("cgroup.procs");
        fs::write(&cgroup_procs, "").unwrap();
        let marker = directory.path().join("task-executed");
        let status = Command::new("/bin/sh")
            .arg("-c")
            .arg(CGROUP_LAUNCHER_SCRIPT)
            .arg("test-launcher")
            .arg(&cgroup_procs)
            .arg(&workspace)
            .arg(format!("{}:{}", metadata.dev(), metadata.ino()))
            .arg("/usr/bin/touch")
            .arg(&marker)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(126));
        assert!(!marker.exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn bubblewrap_execution_rejects_workspace_replaced_after_fence_profile_was_bound() {
        use std::os::unix::fs::MetadataExt;

        let Some(cgroup) = delegated_test_cgroup() else {
            return;
        };
        if !Path::new("/usr/bin/bwrap").exists() {
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let initial_root = directory.path().join("initial");
        let execution_root = directory.path().join("execution");
        let moved_root = directory.path().join("execution-original");
        fs::create_dir(&initial_root).unwrap();
        fs::create_dir(&execution_root).unwrap();
        let sandbox = BubblewrapSandbox::new(SandboxPolicy {
            bubblewrap_binary: "/usr/bin/bwrap".into(),
            workspace_root: initial_root,
            executable_roots: vec!["/usr".into()],
            allowed_environment_keys: BTreeSet::new(),
            timeout_seconds: 5,
            output_limit_bytes: 4096,
            cgroup,
        })
        .unwrap();
        let original = fs::metadata(&execution_root).unwrap();
        let original_identity = (original.dev(), original.ino());
        let original_profile = sandbox
            .execution_profile_sha256_for_workspace(&execution_root)
            .unwrap();

        fs::rename(&execution_root, &moved_root).unwrap();
        fs::create_dir(&execution_root).unwrap();
        let replaced_profile = sandbox
            .execution_profile_sha256_for_workspace(&execution_root)
            .unwrap();
        assert_ne!(original_profile, replaced_profile);

        let error = sandbox
            .execute_cancellable_in_workspace(
                request(),
                &execution_root,
                Some(original_identity),
                &AtomicBool::new(false),
            )
            .unwrap_err();
        assert!(matches!(error, SandboxError::Policy(_)));
    }

    #[test]
    fn sandbox_construction_fails_closed_without_cgroup_delegation() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        let cgroup_root = directory.path().join("cgroup");
        fs::create_dir(&workspace).unwrap();
        fs::create_dir(&cgroup_root).unwrap();
        fs::write(cgroup_root.join("cgroup.controllers"), "cpu memory pids\n").unwrap();
        fs::write(cgroup_root.join("cgroup.subtree_control"), "\n").unwrap();
        let result = BubblewrapSandbox::new(SandboxPolicy {
            bubblewrap_binary: "/usr/bin/bwrap".into(),
            workspace_root: workspace,
            executable_roots: vec!["/usr".into()],
            allowed_environment_keys: BTreeSet::new(),
            timeout_seconds: 5,
            output_limit_bytes: 4096,
            cgroup: CgroupV2Config::new(cgroup_root, ResourceLimits::default()).unwrap(),
        });
        assert!(matches!(result, Err(SandboxError::BackendUnavailable(_))));
    }

    fn request() -> CommandRequest {
        CommandRequest {
            executable: "/usr/bin/true".into(),
            arguments: vec!["--safe".into()],
            working_directory: "workspace".into(),
            environment: Default::default(),
            stdin: vec![],
        }
    }

    #[test]
    fn rejects_parent_traversal_shell_overflow_and_unapproved_environment() {
        let allow = BTreeSet::from(["LANG".to_string()]);
        let mut command = request();
        command.working_directory = "../outside".into();
        assert!(matches!(
            validate_request(&command, &allow),
            Err(SandboxError::Policy(_))
        ));
        let mut command = request();
        command.arguments = vec!["x".repeat(MAX_ARGUMENT_BYTES + 1)];
        assert!(matches!(
            validate_request(&command, &allow),
            Err(SandboxError::Policy(_))
        ));
        let mut command = request();
        command.environment.insert("PATH".into(), "/tmp".into());
        assert!(matches!(
            validate_request(&command, &allow),
            Err(SandboxError::Policy(_))
        ));
    }

    #[test]
    fn accepts_only_allowlisted_environment_and_relative_workspace_paths() {
        let allow = BTreeSet::from(["LANG".to_string()]);
        let mut command = request();
        command.environment.insert("LANG".into(), "C.UTF-8".into());
        assert!(validate_request(&command, &allow).is_ok());
        command.environment.insert("TOKEN".into(), "secret".into());
        assert!(validate_request(&command, &allow).is_err());
    }

    #[test]
    fn executable_symlinks_are_not_accepted() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target");
        fs::write(&target, b"not really executable").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let link = directory.path().join("link");
            symlink(&target, &link).unwrap();
            assert!(matches!(
                canonical_regular_executable(&link),
                Err(SandboxError::Policy(_))
            ));
        }
    }

    #[test]
    fn bounded_output_is_drained_but_only_capped_bytes_are_returned() {
        let (sender, receiver) = mpsc::channel();
        read_bounded(&b"abcdefgh"[..], 4, sender);
        let (captured, truncated) = receiver.recv().unwrap().unwrap();
        assert_eq!(captured, b"abcd");
        assert!(truncated);
        assert_eq!(digest(&captured).len(), 64);
    }

    #[test]
    fn rejects_relative_executable_and_nul_argument() {
        let allow = BTreeSet::new();
        let mut command = request();
        command.executable = "bin/tool".into();
        assert!(validate_request(&command, &allow).is_err());
        let mut command = request();
        command.arguments = vec!["bad\0arg".into()];
        assert!(validate_request(&command, &allow).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn bubblewrap_backend_executes_without_host_filesystem_or_network_fallback() {
        let bwrap = Path::new("/usr/bin/bwrap");
        let Some(cgroup) = delegated_test_cgroup() else {
            return;
        };
        if !bwrap.exists() {
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let sandbox = BubblewrapSandbox::new(SandboxPolicy {
            bubblewrap_binary: bwrap.into(),
            workspace_root: directory.path().into(),
            executable_roots: vec!["/usr".into()],
            allowed_environment_keys: BTreeSet::new(),
            timeout_seconds: 5,
            output_limit_bytes: 4096,
            cgroup,
        })
        .unwrap();
        let observed = sandbox
            .execute_with_cancellation_observed(
                CommandRequest {
                    executable: "/usr/bin/bwrap".into(),
                    arguments: vec!["--version".into()],
                    working_directory: ".".into(),
                    environment: Default::default(),
                    stdin: vec![],
                },
                None,
            )
            .unwrap();
        let result = observed.result;
        assert_eq!(result.exit_code, Some(0));
        assert!(result.stdout.starts_with("bubblewrap "));
        assert!(!result.timed_out);
        assert_eq!(result.sandbox_backend, "bubblewrap-linux-network-isolated");
        assert!(!observed.cancelled_after_start);
        let process = observed.process.expect("cgroup stop observation missing");
        assert!(process.process_id > 0);
        assert!(process.started_at_unix_ms <= process.finished_at_unix_ms);
        assert!(process.cgroup.cgroup_id.starts_with("runalith-"));
        assert!(
            process.cgroup.kill_requested_at_unix_ms
                <= process.cgroup.populated_zero_observed_at_unix_ms
        );
        assert!(process.cgroup.populated_zero_observed_at_unix_ms <= process.finished_at_unix_ms);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn scratch_disk_limit_is_enforced_by_size_bounded_tmpfs() {
        let bwrap = Path::new("/usr/bin/bwrap");
        let Some(dd) = fs::canonicalize("/usr/bin/dd").ok() else {
            return;
        };
        let mut limits = ResourceLimits::default();
        if !bwrap.exists() || delegated_test_cgroup().is_none() {
            return;
        }
        limits.scratch_max_bytes = 1_048_576;
        let cgroup = CgroupV2Config::current_process(limits).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let sandbox = BubblewrapSandbox::new(SandboxPolicy {
            bubblewrap_binary: bwrap.into(),
            workspace_root: directory.path().into(),
            executable_roots: vec!["/usr".into()],
            allowed_environment_keys: BTreeSet::new(),
            timeout_seconds: 10,
            output_limit_bytes: 4096,
            cgroup,
        })
        .unwrap();
        let result = sandbox
            .execute(CommandRequest {
                executable: dd,
                arguments: vec![
                    "if=/dev/zero".into(),
                    "of=/runalith-scratch/full".into(),
                    "bs=1048576".into(),
                    "count=8".into(),
                    "status=none".into(),
                ],
                working_directory: ".".into(),
                environment: Default::default(),
                stdin: vec![],
            })
            .unwrap();
        assert_ne!(result.exit_code, Some(0));
        assert!(result.stderr.contains("No space left on device"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn memory_limit_terminates_execution_inside_its_cgroup() {
        let bwrap = Path::new("/usr/bin/bwrap");
        let Some(python) = fs::canonicalize("/usr/bin/python3").ok() else {
            return;
        };
        if !bwrap.exists() || delegated_test_cgroup().is_none() {
            return;
        }
        let limits = ResourceLimits {
            memory_max_bytes: 64 * 1024 * 1024,
            ..ResourceLimits::default()
        };
        let cgroup = CgroupV2Config::current_process(limits).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let sandbox = BubblewrapSandbox::new(SandboxPolicy {
            bubblewrap_binary: bwrap.into(),
            workspace_root: directory.path().into(),
            executable_roots: vec!["/usr".into()],
            allowed_environment_keys: BTreeSet::new(),
            timeout_seconds: 10,
            output_limit_bytes: 4096,
            cgroup,
        })
        .unwrap();
        let result = sandbox
            .execute(CommandRequest {
                executable: python,
                arguments: vec!["-c".into(), "bytearray(268435456)".into()],
                working_directory: ".".into(),
                environment: Default::default(),
                stdin: vec![],
            })
            .unwrap();
        assert_ne!(result.exit_code, Some(0));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn pid_limit_rejects_excess_descendant_creation() {
        let bwrap = Path::new("/usr/bin/bwrap");
        let shell = Path::new("/usr/bin/dash");
        if !bwrap.exists() || !shell.exists() || delegated_test_cgroup().is_none() {
            return;
        }
        let limits = ResourceLimits {
            pids_max: 4,
            ..ResourceLimits::default()
        };
        let cgroup = CgroupV2Config::current_process(limits).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let sandbox = BubblewrapSandbox::new(SandboxPolicy {
            bubblewrap_binary: bwrap.into(),
            workspace_root: directory.path().into(),
            executable_roots: vec!["/usr".into()],
            allowed_environment_keys: BTreeSet::new(),
            timeout_seconds: 5,
            output_limit_bytes: 4096,
            cgroup,
        })
        .unwrap();
        let result = sandbox
            .execute(CommandRequest {
                executable: shell.into(),
                arguments: vec![
                    "-c".into(),
                    "i=0; while [ $i -lt 32 ]; do /usr/bin/sleep 2 & i=$((i+1)); done; wait".into(),
                ],
                working_directory: ".".into(),
                environment: Default::default(),
                stdin: vec![],
            })
            .unwrap();
        assert!(result.exit_code != Some(0) || result.stderr.contains("fork"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn timeout_kills_double_forked_setsid_descendants_inside_execution_cgroup() {
        let bwrap = Path::new("/usr/bin/bwrap");
        let shell = Path::new("/usr/bin/dash");
        let setsid = Path::new("/usr/bin/setsid");
        let Some(cgroup) = delegated_test_cgroup() else {
            return;
        };
        if !bwrap.exists() || !shell.exists() || !setsid.exists() {
            eprintln!("skipped: Bubblewrap, dash or setsid unavailable");
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let sandbox = BubblewrapSandbox::new(SandboxPolicy {
            bubblewrap_binary: bwrap.into(),
            workspace_root: directory.path().into(),
            executable_roots: vec!["/usr".into()],
            allowed_environment_keys: BTreeSet::new(),
            timeout_seconds: 1,
            output_limit_bytes: 4096,
            cgroup,
        })
        .unwrap();
        let observed = sandbox
            .execute_with_cancellation_observed(
                CommandRequest {
                executable: shell.into(),
                arguments: vec![
                    "-c".into(),
                    "/usr/bin/setsid /usr/bin/dash -c '(/usr/bin/sleep 2; echo escaped > /workspace/escaped) & wait' & sleep 10".into(),
                ],
                working_directory: ".".into(),
                environment: Default::default(),
                stdin: vec![],
                },
                None,
            )
            .unwrap();
        assert!(observed.result.timed_out);
        assert!(observed.process.is_some());
        thread::sleep(Duration::from_secs(3));
        assert!(!directory.path().join("escaped").exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn timeout_kills_pid_namespace_descendants_and_reaps_blocked_stdin() {
        let bwrap = Path::new("/usr/bin/bwrap");
        let Some(cgroup) = delegated_test_cgroup() else {
            return;
        };
        if !bwrap.exists() {
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let sandbox = BubblewrapSandbox::new(SandboxPolicy {
            bubblewrap_binary: bwrap.into(),
            workspace_root: directory.path().into(),
            executable_roots: vec!["/usr".into()],
            allowed_environment_keys: BTreeSet::new(),
            timeout_seconds: 1,
            output_limit_bytes: 4096,
            cgroup,
        })
        .unwrap();
        let result = sandbox
            .execute(CommandRequest {
                executable: "/usr/bin/dash".into(),
                arguments: vec![
                    "-c".into(),
                    "(sleep 2; echo escaped > /workspace/descendant-survived) & sleep 10".into(),
                ],
                working_directory: ".".into(),
                environment: Default::default(),
                stdin: vec![0; MAX_STDIN_BYTES],
            })
            .unwrap();
        assert!(result.timed_out);
        thread::sleep(Duration::from_secs(3));
        assert!(!directory.path().join("descendant-survived").exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn lease_cancellation_kills_pid_namespace_descendants_and_reaps_readers() {
        let bwrap = Path::new("/usr/bin/bwrap");
        let Some(cgroup) = delegated_test_cgroup() else {
            return;
        };
        if !bwrap.exists() {
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let sandbox = BubblewrapSandbox::new(SandboxPolicy {
            bubblewrap_binary: bwrap.into(),
            workspace_root: directory.path().into(),
            executable_roots: vec!["/usr".into()],
            allowed_environment_keys: BTreeSet::new(),
            timeout_seconds: 10,
            output_limit_bytes: 4096,
            cgroup,
        })
        .unwrap();
        let cancelled = std::sync::Arc::new(AtomicBool::new(false));
        let cancellation = cancelled.clone();
        let cancel_thread = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            cancellation.store(true, Ordering::Release);
        });
        let observed = sandbox.execute_with_cancellation_observed(
            CommandRequest {
                executable: "/usr/bin/dash".into(),
                arguments: vec![
                    "-c".into(),
                    "(sleep 2; echo escaped > /workspace/descendant-survived) & sleep 10".into(),
                ],
                working_directory: ".".into(),
                environment: Default::default(),
                stdin: vec![0; MAX_STDIN_BYTES],
            },
            Some(&cancelled),
        );
        cancel_thread.join().unwrap();
        let observed = observed.unwrap();
        assert!(observed.cancelled_after_start);
        let process = observed
            .process
            .expect("cancelled process lacks stop evidence");
        assert!(process.process_id > 0);
        assert!(
            process.cgroup.kill_requested_at_unix_ms
                <= process.cgroup.populated_zero_observed_at_unix_ms
        );
        thread::sleep(Duration::from_secs(3));
        assert!(!directory.path().join("descendant-survived").exists());
    }
}
