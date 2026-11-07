//! Fail-closed per-execution cgroup v2 resource containment.
//!
//! The configured root must be a systemd-delegated cgroup with `cpu`,
//! `memory`, and `pids` enabled for child cgroups. The sandbox never falls
//! back to process-local rlimits when delegation is unavailable.

use std::{
    fs, io,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
/// Per-execution resource ceilings applied by cgroup v2 and bounded tmpfs mounts.
pub struct ResourceLimits {
    /// Maximum resident memory in bytes.
    pub memory_max_bytes: u64,
    /// CPU quota in microseconds per configured period.
    pub cpu_quota_micros: u64,
    /// CPU quota period in microseconds.
    pub cpu_period_micros: u64,
    /// Maximum number of processes/threads in the execution cgroup.
    pub pids_max: u64,
    /// Maximum writable tmpfs capacity exposed at `/tmp` and
    /// `/runalith-scratch`. Workspace storage additionally requires an
    /// operator-enforced filesystem/project quota.
    pub scratch_max_bytes: u64,
}

impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            memory_max_bytes: 1_073_741_824,
            cpu_quota_micros: 100_000,
            cpu_period_micros: 100_000,
            pids_max: 64,
            scratch_max_bytes: 134_217_728,
        }
    }
}

impl ResourceLimits {
    /// Load bounded values from `RUNALITH_SANDBOX_*` environment variables.
    pub fn from_env() -> Result<Self, CgroupError> {
        fn number(name: &'static str, default: u64) -> Result<u64, CgroupError> {
            match std::env::var(name) {
                Ok(value) => value.parse().map_err(|_| {
                    CgroupError::Configuration(format!("{name} must be an unsigned integer"))
                }),
                Err(std::env::VarError::NotPresent) => Ok(default),
                Err(std::env::VarError::NotUnicode(_)) => Err(CgroupError::Configuration(format!(
                    "{name} is not valid Unicode"
                ))),
            }
        }
        let limits = Self {
            memory_max_bytes: number("RUNALITH_SANDBOX_MEMORY_MAX_BYTES", 1_073_741_824)?,
            cpu_quota_micros: number("RUNALITH_SANDBOX_CPU_QUOTA_MICROS", 100_000)?,
            cpu_period_micros: number("RUNALITH_SANDBOX_CPU_PERIOD_MICROS", 100_000)?,
            pids_max: number("RUNALITH_SANDBOX_PIDS_MAX", 64)?,
            scratch_max_bytes: number("RUNALITH_SANDBOX_SCRATCH_MAX_BYTES", 134_217_728)?,
        };
        limits.validate()?;
        Ok(limits)
    }

    /// Reject zero, unbounded or operationally unsafe resource values.
    pub fn validate(&self) -> Result<(), CgroupError> {
        if !(16 * 1024 * 1024..=u64::MAX).contains(&self.memory_max_bytes)
            || self.cpu_quota_micros == 0
            || !(1_000..=1_000_000).contains(&self.cpu_period_micros)
            || self.cpu_quota_micros > self.cpu_period_micros.saturating_mul(64)
            || !(1..=4096).contains(&self.pids_max)
            || !(1024 * 1024..=16 * 1024 * 1024 * 1024).contains(&self.scratch_max_bytes)
        {
            return Err(CgroupError::Configuration(
                "resource limits are outside supported safe bounds".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
/// Operator-provisioned cgroup v2 delegation and per-execution limits.
pub struct CgroupV2Config {
    /// Writable delegated cgroup directory for the worker service.
    pub root: PathBuf,
    /// Limits applied to each execution child cgroup.
    pub limits: ResourceLimits,
}

impl CgroupV2Config {
    /// Construct a validated configuration rooted at an absolute path.
    pub fn new(root: impl Into<PathBuf>, limits: ResourceLimits) -> Result<Self, CgroupError> {
        limits.validate()?;
        let root = root.into();
        if !root.is_absolute() {
            return Err(CgroupError::Configuration(
                "cgroup v2 root must be an absolute path".into(),
            ));
        }
        Ok(Self { root, limits })
    }

    /// Resolve the current process cgroup. The service manager must delegate
    /// this cgroup (`Delegate=cpu memory pids`) before sandbox execution.
    pub fn current_process(limits: ResourceLimits) -> Result<Self, CgroupError> {
        let membership = fs::read_to_string("/proc/self/cgroup")?;
        let relative = membership
            .lines()
            .find_map(|line| line.strip_prefix("0::"))
            .ok_or_else(|| {
                CgroupError::Unavailable("unified cgroup v2 membership missing".into())
            })?;
        let mut root = Path::new("/sys/fs/cgroup").join(relative.trim_start_matches('/'));
        // Once the worker has moved itself into its dedicated manager child,
        // subsequent lookups must continue to use the delegated parent.
        if root
            .file_name()
            .is_some_and(|name| name == "runalith-manager")
        {
            root.pop();
        }
        Self::new(root, limits)
    }

    /// Load limits and optional delegated root. Missing root uses current process cgroup.
    pub fn from_env(root_variable: &'static str) -> Result<Self, CgroupError> {
        let limits = ResourceLimits::from_env()?;
        match std::env::var_os(root_variable) {
            Some(root) => Self::new(PathBuf::from(root), limits),
            None => Self::current_process(limits),
        }
    }

    /// Create a unique execution cgroup and apply every mandatory limit.
    pub fn prepare(&self) -> Result<ExecutionCgroup, CgroupError> {
        self.limits.validate()?;
        let metadata = fs::symlink_metadata(&self.root)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(CgroupError::Unavailable(
                "cgroup root must be a real delegated directory".into(),
            ));
        }
        let controllers = fs::read_to_string(self.root.join("cgroup.controllers"))?;
        for controller in ["cpu", "memory", "pids"] {
            if !controllers
                .split_ascii_whitespace()
                .any(|value| value == controller)
            {
                return Err(CgroupError::Unavailable(format!(
                    "cgroup controller {controller} is not available in the delegated service cgroup"
                )));
            }
        }

        let root_processes = fs::read_to_string(self.root.join("cgroup.procs"))?;
        if !root_processes.trim().is_empty() {
            return Err(CgroupError::Unavailable(
                "delegated cgroup parent contains processes; configure systemd DelegateSubgroup=runalith-manager to satisfy cgroup v2 no-internal-process rule".into(),
            ));
        }
        let mut subtree = fs::read_to_string(self.root.join("cgroup.subtree_control"))?;
        let missing: Vec<_> = ["cpu", "memory", "pids"]
            .into_iter()
            .filter(|controller| {
                !subtree
                    .split_ascii_whitespace()
                    .any(|value| value == *controller)
            })
            .collect();
        if !missing.is_empty() {
            let enable = missing
                .iter()
                .map(|controller| format!("+{controller}"))
                .collect::<Vec<_>>()
                .join(" ");
            fs::write(self.root.join("cgroup.subtree_control"), enable).map_err(|error| {
                CgroupError::Unavailable(format!(
                    "cannot enable delegated cgroup controllers for executions: {error}"
                ))
            })?;
            subtree = fs::read_to_string(self.root.join("cgroup.subtree_control"))?;
        }
        for controller in ["cpu", "memory", "pids"] {
            if !subtree
                .split_ascii_whitespace()
                .any(|value| value == controller)
            {
                return Err(CgroupError::Unavailable(format!(
                    "cgroup controller {controller} did not become enabled for execution children"
                )));
            }
        }

        let path = self
            .root
            .join(format!("runalith-{}", Uuid::new_v4().simple()));
        fs::create_dir(&path).map_err(|error| {
            CgroupError::Unavailable(format!("cannot create delegated execution cgroup: {error}"))
        })?;
        let mut execution = ExecutionCgroup {
            path,
            cleaned: false,
            cleanup_evidence: None,
        };
        let setup = (|| -> Result<(), CgroupError> {
            configure_limits(&execution.path, &self.limits)?;
            for required in ["cgroup.procs", "cgroup.kill", "cgroup.events"] {
                if !execution.path.join(required).exists() {
                    return Err(CgroupError::Unavailable(format!(
                        "kernel cgroup v2 interface {required} is unavailable"
                    )));
                }
            }
            Ok(())
        })();
        if let Err(error) = setup {
            let _ = execution.cleanup();
            return Err(error);
        }
        Ok(execution)
    }
}

#[derive(Debug, Error)]
/// Cgroup v2 configuration or enforcement failure.
pub enum CgroupError {
    /// Invalid operator-provided limits or paths.
    #[error("invalid cgroup configuration: {0}")]
    Configuration(String),
    /// Required kernel or delegation guarantee is unavailable.
    #[error("required cgroup v2 resource isolation unavailable: {0}")]
    Unavailable(String),
    /// Filesystem/cgroup control operation failed.
    #[error("cgroup v2 operation failed: {0}")]
    Io(#[from] io::Error),
}

/// Per-execution cgroup. Dropping it attempts kill-and-remove cleanup.
pub struct ExecutionCgroup {
    path: PathBuf,
    cleaned: bool,
    cleanup_evidence: Option<CgroupCleanupEvidence>,
}

/// Local kernel observation proving that one execution cgroup became empty.
///
/// This is process-tree evidence only. It is not a provider terminality proof,
/// a lease-settlement receipt, or evidence that remote side effects stopped.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CgroupCleanupEvidence {
    /// Opaque ID taken from the unique per-execution cgroup directory name.
    pub cgroup_id: String,
    /// Unix milliseconds immediately before writing `1` to `cgroup.kill`.
    pub kill_requested_at_unix_ms: u64,
    /// Unix milliseconds when the kernel reported `populated 0`.
    pub populated_zero_observed_at_unix_ms: u64,
}

impl ExecutionCgroup {
    #[cfg(test)]
    pub(crate) fn for_test(path: PathBuf) -> Self {
        Self {
            path,
            cleaned: false,
            cleanup_evidence: None,
        }
    }

    /// Path to kernel `cgroup.procs`, used by the trusted launcher before exec.
    pub fn procs_path(&self) -> PathBuf {
        self.path.join("cgroup.procs")
    }

    /// Kill every process in the cgroup, wait until the kernel reports it
    /// empty, then remove the per-execution cgroup.
    pub fn cleanup(&mut self) -> Result<(), CgroupError> {
        self.cleanup_with_evidence().map(|_| ())
    }

    /// Kill every process in the cgroup and return the exact local quiescence
    /// observation after the kernel reports `populated 0`.
    pub fn cleanup_with_evidence(&mut self) -> Result<CgroupCleanupEvidence, CgroupError> {
        if self.cleaned {
            return self.cleanup_evidence.clone().ok_or_else(|| {
                CgroupError::Unavailable(
                    "cleaned execution cgroup omitted its quiescence evidence".into(),
                )
            });
        }
        let cgroup_id = self
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| name.starts_with("runalith-"))
            .ok_or_else(|| {
                CgroupError::Unavailable("execution cgroup has no valid opaque ID".into())
            })?
            .to_owned();
        let kill_requested_at_unix_ms = unix_time_millis();
        match fs::write(self.path.join("cgroup.kill"), b"1") {
            Ok(()) => {}
            // Kernel may return ESRCH when the execution cgroup is already empty.
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => {}
            Err(error) => return Err(CgroupError::Io(error)),
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let events = fs::read_to_string(self.path.join("cgroup.events"))?;
            if events.lines().any(|line| line.trim() == "populated 0") {
                break;
            }
            if Instant::now() >= deadline {
                return Err(CgroupError::Unavailable(
                    "execution cgroup remained populated after kill".into(),
                ));
            }
            thread::sleep(Duration::from_millis(10));
        }
        let populated_zero_observed_at_unix_ms = unix_time_millis();
        fs::remove_dir(&self.path)?;
        self.cleaned = true;
        let evidence = CgroupCleanupEvidence {
            cgroup_id,
            kill_requested_at_unix_ms,
            populated_zero_observed_at_unix_ms,
        };
        self.cleanup_evidence = Some(evidence.clone());
        Ok(evidence)
    }
}

fn unix_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

impl Drop for ExecutionCgroup {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

fn configure_limits(root: &Path, limits: &ResourceLimits) -> Result<(), CgroupError> {
    fs::write(root.join("memory.max"), limits.memory_max_bytes.to_string())?;
    fs::write(root.join("memory.swap.max"), "0")?;
    fs::write(root.join("pids.max"), limits.pids_max.to_string())?;
    fs::write(
        root.join("cpu.max"),
        format!("{} {}", limits.cpu_quota_micros, limits.cpu_period_micros),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_root(path: &Path) {
        fs::create_dir_all(path).unwrap();
        fs::write(path.join("cgroup.controllers"), "cpu memory pids io\n").unwrap();
        fs::write(path.join("cgroup.subtree_control"), "cpu memory pids io\n").unwrap();
    }

    #[test]
    fn rejects_unsafe_resource_limits() {
        let mut limits = ResourceLimits {
            pids_max: 0,
            ..ResourceLimits::default()
        };
        assert!(limits.validate().is_err());
        limits = ResourceLimits {
            cpu_period_micros: 0,
            ..ResourceLimits::default()
        };
        assert!(limits.validate().is_err());
        limits = ResourceLimits {
            scratch_max_bytes: 1,
            ..ResourceLimits::default()
        };
        assert!(limits.validate().is_err());
    }

    #[test]
    fn requires_delegated_controllers_and_fails_closed_when_unavailable() {
        let directory = tempfile::tempdir().unwrap();
        fake_root(directory.path());
        fs::write(directory.path().join("cgroup.controllers"), "memory pids\n").unwrap();
        let config = CgroupV2Config::new(directory.path(), ResourceLimits::default()).unwrap();
        assert!(matches!(config.prepare(), Err(CgroupError::Unavailable(_))));
    }

    #[test]
    fn writes_all_required_limits_before_exposing_execution_cgroup() {
        let directory = tempfile::tempdir().unwrap();
        for name in ["memory.max", "memory.swap.max", "pids.max", "cpu.max"] {
            fs::write(directory.path().join(name), "").unwrap();
        }
        let limits = ResourceLimits::default();
        configure_limits(directory.path(), &limits).unwrap();
        assert_eq!(
            fs::read_to_string(directory.path().join("memory.max")).unwrap(),
            "1073741824"
        );
        assert_eq!(
            fs::read_to_string(directory.path().join("memory.swap.max")).unwrap(),
            "0"
        );
        assert_eq!(
            fs::read_to_string(directory.path().join("pids.max")).unwrap(),
            "64"
        );
        assert_eq!(
            fs::read_to_string(directory.path().join("cpu.max")).unwrap(),
            "100000 100000"
        );
    }

    #[test]
    fn cleanup_issues_cgroup_kill_before_removing_the_execution_cgroup() {
        let directory = tempfile::tempdir().unwrap();
        let execution_path = directory.path().join("runalith-test");
        fs::create_dir(&execution_path).unwrap();
        fs::write(execution_path.join("cgroup.kill"), "").unwrap();
        fs::write(
            execution_path.join("cgroup.events"),
            "populated 0\nfrozen 0\n",
        )
        .unwrap();
        let mut execution = ExecutionCgroup {
            path: execution_path.clone(),
            cleaned: false,
            cleanup_evidence: None,
        };

        assert!(
            matches!(execution.cleanup(), Err(CgroupError::Io(error)) if error.kind() == io::ErrorKind::DirectoryNotEmpty)
        );
        assert_eq!(
            fs::read_to_string(execution_path.join("cgroup.kill")).unwrap(),
            "1"
        );
        assert_eq!(
            fs::read_to_string(execution_path.join("cgroup.events")).unwrap(),
            "populated 0\nfrozen 0\n"
        );
        fs::remove_dir_all(execution_path).unwrap();
    }

    #[test]
    fn delegated_execution_cgroup_receives_exact_cpu_memory_swap_and_pid_limits() {
        let limits = ResourceLimits {
            cpu_quota_micros: 25_000,
            cpu_period_micros: 100_000,
            memory_max_bytes: 96 * 1024 * 1024,
            pids_max: 12,
            ..ResourceLimits::default()
        };
        let config = CgroupV2Config::current_process(limits).unwrap();
        let processes = match fs::read_to_string(config.root.join("cgroup.procs")) {
            Ok(processes) => processes,
            Err(error) => {
                eprintln!("skipped delegated cgroup integration test: {error}");
                return;
            }
        };
        if !processes.trim().is_empty() {
            eprintln!(
                "skipped delegated cgroup integration test: parent is not empty; run under systemd DelegateSubgroup=runalith-manager"
            );
            return;
        }
        let mut execution = config.prepare().unwrap();

        assert_eq!(
            fs::read_to_string(execution.path.join("cpu.max"))
                .unwrap()
                .trim(),
            "25000 100000"
        );
        assert_eq!(
            fs::read_to_string(execution.path.join("memory.max"))
                .unwrap()
                .trim(),
            "100663296"
        );
        assert_eq!(
            fs::read_to_string(execution.path.join("memory.swap.max"))
                .unwrap()
                .trim(),
            "0"
        );
        assert_eq!(
            fs::read_to_string(execution.path.join("pids.max"))
                .unwrap()
                .trim(),
            "12"
        );

        execution.cleanup().unwrap();
    }

    #[test]
    fn cpu_quota_throttles_a_busy_execution_process() {
        use std::process::Command;

        let python = Path::new("/usr/bin/python3");
        if !python.is_file() {
            eprintln!("skipped CPU quota enforcement test: /usr/bin/python3 is unavailable");
            return;
        }
        let limits = ResourceLimits {
            cpu_quota_micros: 10_000,
            cpu_period_micros: 100_000,
            ..ResourceLimits::default()
        };
        let config = match CgroupV2Config::current_process(limits) {
            Ok(config) => config,
            Err(error) => {
                eprintln!("skipped CPU quota enforcement test: {error}");
                return;
            }
        };
        let mut execution = match config.prepare() {
            Ok(execution) => execution,
            Err(error) => {
                eprintln!("skipped CPU quota enforcement test: {error}");
                return;
            }
        };
        let throttled_before = fs::read_to_string(execution.path.join("cpu.stat"))
            .unwrap()
            .lines()
            .find_map(|line| {
                let mut fields = line.split_ascii_whitespace();
                (fields.next() == Some("nr_throttled"))
                    .then(|| fields.next()?.parse::<u64>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        let mut child = Command::new(python)
            .args([
                "-c",
                "import time; end=time.monotonic()+1.0; value=0\nwhile time.monotonic()<end: value+=1",
            ])
            .spawn()
            .unwrap();
        if let Err(error) = fs::write(execution.procs_path(), child.id().to_string()) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = execution.cleanup();
            panic!("failed to move CPU test process into execution cgroup: {error}");
        }
        assert!(child.wait().unwrap().success());
        let throttled_after = fs::read_to_string(execution.path.join("cpu.stat"))
            .unwrap()
            .lines()
            .find_map(|line| {
                let mut fields = line.split_ascii_whitespace();
                (fields.next() == Some("nr_throttled"))
                    .then(|| fields.next()?.parse::<u64>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        assert!(
            throttled_after > throttled_before,
            "CPU quota did not throttle the busy process: {throttled_before} -> {throttled_after}"
        );
        execution.cleanup().unwrap();
    }

    #[test]
    fn current_process_resolves_a_unified_cgroup_path() {
        let config = CgroupV2Config::current_process(ResourceLimits::default()).unwrap();
        assert!(config.root.starts_with("/sys/fs/cgroup"));
    }
}
