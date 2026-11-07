//! Environment-backed standalone worker configuration.

use std::{
    collections::BTreeSet,
    env,
    path::{Component, PathBuf},
    time::Duration,
};

use thiserror::Error;

/// Validated standalone worker settings.
#[derive(Clone)]
pub struct WorkerConfig {
    /// Stable worker identity registered with Control.
    pub worker_id: String,
    /// Private durable worker state directory.
    pub data_dir: PathBuf,
    /// HTTPS Control API origin.
    pub control_url: String,
    /// Control bearer credential; never included in diagnostics.
    pub control_token: String,
    /// curl executable path.
    pub curl_binary: PathBuf,
    /// Bubblewrap executable path.
    pub bubblewrap_binary: PathBuf,
    /// Only writable workspace root.
    pub workspace_root: PathBuf,
    /// Per-execution project-quota byte hard limit.
    pub workspace_quota_bytes: u64,
    /// Per-execution project-quota inode hard limit.
    pub workspace_quota_inodes: u64,
    /// Unix socket for the narrowly privileged project-quota helper.
    pub quota_helper_socket: PathBuf,
    /// Read-only executable roots exposed to sandbox.
    pub executable_roots: Vec<PathBuf>,
    /// Explicit task environment allowlist.
    pub allowed_environment_keys: BTreeSet<String>,
    /// Sandbox process timeout.
    pub timeout_seconds: u64,
    /// Captured output limit per stream.
    pub output_limit_bytes: usize,
    /// Control lease renewal duration.
    pub lease_seconds: u64,
    /// Worker poll and shutdown-check interval.
    pub poll_interval: Duration,
    /// File whose creation requests graceful shutdown.
    pub shutdown_file: PathBuf,
    /// Worker process identity file.
    pub pid_file: PathBuf,
}

/// Configuration error without secret values.
#[derive(Debug, Error)]
pub enum WorkerConfigError {
    /// Required environment variable is missing.
    #[error("required worker configuration is missing: {0}")]
    Missing(&'static str),
    /// Numeric or path configuration is invalid.
    #[error("worker configuration is invalid: {0}")]
    Invalid(&'static str),
}

impl WorkerConfig {
    /// Load and validate configuration from `RUNALITH_WORKER_*` environment variables.
    pub fn from_env() -> Result<Self, WorkerConfigError> {
        let data_dir = PathBuf::from(required("RUNALITH_WORKER_DATA_DIR")?);
        let worker_id = required("RUNALITH_WORKER_ID")?;
        let control_url = required("RUNALITH_CONTROL_URL")?;
        let control_token = required("RUNALITH_CONTROL_TOKEN")?;
        let workspace_root = PathBuf::from(required("RUNALITH_WORKER_WORKSPACE_ROOT")?);
        let workspace_quota_bytes =
            number("RUNALITH_WORKER_WORKSPACE_QUOTA_BYTES", 2_147_483_648_u64)?;
        let workspace_quota_inodes = number("RUNALITH_WORKER_WORKSPACE_QUOTA_INODES", 100_000_u64)?;
        let quota_helper_socket = PathBuf::from(
            env::var("RUNALITH_WORKER_QUOTA_HELPER_SOCKET")
                .unwrap_or_else(|_| "/run/runalith-quota/quota.sock".into()),
        );
        let executable_roots = env::var("RUNALITH_WORKER_EXECUTABLE_ROOTS")
            .unwrap_or_else(|_| "/usr/bin,/bin,/usr/sbin,/sbin".into())
            .split(',')
            .filter(|value| !value.trim().is_empty())
            .map(|value| PathBuf::from(value.trim()))
            .collect::<Vec<_>>();
        let allowed_environment_keys = env::var("RUNALITH_WORKER_ALLOWED_ENV_KEYS")
            .unwrap_or_default()
            .split(',')
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.trim().to_owned())
            .collect();
        let config = Self {
            worker_id,
            data_dir: data_dir.clone(),
            control_url,
            control_token,
            curl_binary: PathBuf::from(
                env::var("RUNALITH_WORKER_CURL_BINARY").unwrap_or_else(|_| "/usr/bin/curl".into()),
            ),
            bubblewrap_binary: PathBuf::from(
                env::var("RUNALITH_WORKER_BWRAP_BINARY")
                    .unwrap_or_else(|_| "/usr/bin/bwrap".into()),
            ),
            workspace_root,
            workspace_quota_bytes,
            workspace_quota_inodes,
            quota_helper_socket,
            executable_roots,
            allowed_environment_keys,
            timeout_seconds: number("RUNALITH_WORKER_TIMEOUT_SECONDS", 600)?,
            output_limit_bytes: number("RUNALITH_WORKER_OUTPUT_LIMIT_BYTES", 1_048_576)?,
            lease_seconds: number("RUNALITH_WORKER_LEASE_SECONDS", 120)?,
            poll_interval: Duration::from_millis(number("RUNALITH_WORKER_POLL_INTERVAL_MS", 1000)?),
            shutdown_file: PathBuf::from(
                env::var("RUNALITH_WORKER_SHUTDOWN_FILE")
                    .unwrap_or_else(|_| data_dir.join("worker.stop").display().to_string()),
            ),
            pid_file: PathBuf::from(
                env::var("RUNALITH_WORKER_PID_FILE")
                    .unwrap_or_else(|_| data_dir.join("worker.pid").display().to_string()),
            ),
        };
        config.validate()?;
        Ok(config)
    }

    /// Validate cross-field bounds and URL/identity constraints.
    pub fn validate(&self) -> Result<(), WorkerConfigError> {
        if self.worker_id.trim().is_empty()
            || self.worker_id.len() > 256
            || self.control_token.trim().is_empty()
            || self.control_token.len() > 8192
            || self.control_token.chars().any(char::is_control)
        {
            return Err(WorkerConfigError::Invalid(
                "worker identity or Control credential",
            ));
        }
        if !self.control_url.starts_with("https://")
            || self.control_url.contains('@')
            || self.control_url.contains('?')
            || self.control_url.contains('#')
            || self.control_url.len() > 2048
            || self
                .control_url
                .strip_prefix("https://")
                .is_none_or(|value| value.is_empty() || value.contains('/'))
            || self.control_url.chars().any(char::is_control)
        {
            return Err(WorkerConfigError::Invalid(
                "Control URL must be HTTPS without userinfo",
            ));
        }
        if !(1..=600).contains(&self.timeout_seconds)
            || !(1..=1_048_576).contains(&self.output_limit_bytes)
            || !(15..=600).contains(&self.lease_seconds)
            || self.poll_interval < Duration::from_millis(100)
            || self.poll_interval > Duration::from_secs(60)
        {
            return Err(WorkerConfigError::Invalid(
                "timeout, output, lease or polling bounds",
            ));
        }
        if self.workspace_quota_bytes < 4096
            || self.workspace_quota_bytes > i64::MAX as u64
            || self.workspace_quota_inodes == 0
            || self.workspace_quota_inodes > i32::MAX as u64
        {
            return Err(WorkerConfigError::Invalid(
                "per-execution workspace byte/inode quota bounds",
            ));
        }
        if self.executable_roots.is_empty()
            || self.allowed_environment_keys.iter().any(|key| {
                !valid_environment_key(key)
                    || matches!(
                        key.as_str(),
                        "PATH" | "HOME" | "TMPDIR" | "LD_PRELOAD" | "LD_LIBRARY_PATH"
                    )
            })
            || !safe_absolute_path(&self.workspace_root)
            || !safe_absolute_path(&self.quota_helper_socket)
            || !safe_absolute_path(&self.data_dir)
            || self.data_dir == std::path::Path::new("/")
            || !safe_absolute_path(&self.curl_binary)
            || !safe_absolute_path(&self.bubblewrap_binary)
            || self
                .executable_roots
                .iter()
                .any(|root| !safe_absolute_path(root))
            || !safe_absolute_path(&self.shutdown_file)
            || !safe_absolute_path(&self.pid_file)
            || !self.shutdown_file.starts_with(&self.data_dir)
            || !self.pid_file.starts_with(&self.data_dir)
            || self.shutdown_file.parent() != Some(self.data_dir.as_path())
            || self.pid_file.parent() != Some(self.data_dir.as_path())
            || self.shutdown_file == self.pid_file
            || [
                "worker.db",
                "worker.db-wal",
                "worker.db-shm",
                "artifacts",
                "worker.pid",
            ]
            .contains(
                &self
                    .shutdown_file
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default(),
            )
            || [
                "worker.db",
                "worker.db-wal",
                "worker.db-shm",
                "artifacts",
                "worker.stop",
            ]
            .contains(
                &self
                    .pid_file
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default(),
            )
        {
            return Err(WorkerConfigError::Invalid(
                "workspace, data directory or executable roots",
            ));
        }
        Ok(())
    }

    /// Safe operator projection; credentials are always redacted.
    pub fn redacted_json(&self) -> serde_json::Value {
        serde_json::json!({"worker_id":self.worker_id,"data_dir":self.data_dir,"control_url":self.control_url,"control_token":"[REDACTED]","curl_binary":self.curl_binary,"bubblewrap_binary":self.bubblewrap_binary,"workspace_root":self.workspace_root,"workspace_quota_bytes":self.workspace_quota_bytes,"workspace_quota_inodes":self.workspace_quota_inodes,"quota_helper_socket":self.quota_helper_socket,"executable_roots":self.executable_roots,"allowed_environment_keys":self.allowed_environment_keys,"timeout_seconds":self.timeout_seconds,"output_limit_bytes":self.output_limit_bytes,"lease_seconds":self.lease_seconds,"poll_interval_ms":self.poll_interval.as_millis(),"shutdown_file":self.shutdown_file,"pid_file":self.pid_file})
    }
}

fn safe_absolute_path(path: &std::path::Path) -> bool {
    path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::RootDir | Component::Normal(_)))
}

fn valid_environment_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_uppercase() || byte == b'_' || (index > 0 && byte.is_ascii_digit())
        })
}

fn required(name: &'static str) -> Result<String, WorkerConfigError> {
    env::var(name).map_err(|_| WorkerConfigError::Missing(name))
}
fn number<T: std::str::FromStr>(name: &'static str, default: T) -> Result<T, WorkerConfigError> {
    match env::var(name) {
        Ok(value) => value.parse().map_err(|_| WorkerConfigError::Invalid(name)),
        Err(_) => Ok(default),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> WorkerConfig {
        let data_dir = PathBuf::from("/var/lib/runalith-worker");
        WorkerConfig {
            worker_id: "worker-1".into(),
            data_dir: data_dir.clone(),
            control_url: "https://control.example".into(),
            control_token: "secret".into(),
            curl_binary: PathBuf::from("/usr/bin/curl"),
            bubblewrap_binary: PathBuf::from("/usr/bin/bwrap"),
            workspace_root: PathBuf::from("/srv/runalith/workspace"),
            workspace_quota_bytes: 2_147_483_648,
            workspace_quota_inodes: 100_000,
            quota_helper_socket: PathBuf::from("/run/runalith-quota/quota.sock"),
            executable_roots: vec![PathBuf::from("/usr/bin"), PathBuf::from("/bin")],
            allowed_environment_keys: BTreeSet::new(),
            timeout_seconds: 600,
            output_limit_bytes: 1_048_576,
            lease_seconds: 120,
            poll_interval: Duration::from_secs(1),
            shutdown_file: data_dir.join("worker.stop"),
            pid_file: data_dir.join("worker.pid"),
        }
    }

    #[test]
    fn validates_private_state_paths_and_bounded_worker_settings() {
        assert!(config().validate().is_ok());
        let mut invalid = config();
        invalid.data_dir = PathBuf::from("/");
        assert!(invalid.validate().is_err());
        let mut invalid = config();
        invalid.pid_file = PathBuf::from("/tmp/worker.pid");
        assert!(invalid.validate().is_err());
        let mut invalid = config();
        invalid.pid_file = PathBuf::from("/var/lib/runalith-worker/../worker.pid");
        assert!(invalid.validate().is_err());
        let mut invalid = config();
        invalid.shutdown_file = PathBuf::from("/var/lib/runalith-worker/worker.db");
        assert!(invalid.validate().is_err());
        let mut invalid = config();
        invalid.control_url = "https://control.example/api".into();
        assert!(invalid.validate().is_err());
        let mut invalid = config();
        invalid.workspace_root = PathBuf::from("/srv/../etc");
        assert!(invalid.validate().is_err());
        let mut invalid = config();
        invalid.allowed_environment_keys.insert("PATH".into());
        assert!(invalid.validate().is_err());
        let mut invalid = config();
        invalid.allowed_environment_keys.insert("BAD-NAME".into());
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn redacted_configuration_never_exposes_control_credential() {
        let redacted = config().redacted_json();
        assert_eq!(redacted["control_token"], "[REDACTED]");
        assert!(!redacted.to_string().contains("secret"));
    }
}
