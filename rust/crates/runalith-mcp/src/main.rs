//! Runalith MCP stdio server process.

use std::{
    collections::BTreeSet,
    env, fs,
    io::{self, BufReader},
    path::{Path, PathBuf},
    sync::Arc,
};

use runalith_artifacts::ArtifactStore;
use runalith_mcp::service_gateway::AuthenticatedMcpTransportContext;
use runalith_mcp::{McpServer, serve_stdio};
use runalith_protocol::mcp_service_v1::McpPrincipalV1;
use runalith_runtime::Store;
use runalith_sandbox::{BubblewrapSandbox, CgroupV2Config, SandboxPolicy};

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("runalith-mcp: {error}");
            std::process::exit(1);
        }
    }
}

fn run() -> Result<i32, Box<dyn std::error::Error>> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    match arguments.as_slice() {
        [command] if command == "--version" || command == "version" => {
            println!(
                "{}",
                serde_json::json!({
                    "name":"runalith-mcp",
                    "version":env!("CARGO_PKG_VERSION"),
                    "store_schema_version":Store::CURRENT_SCHEMA_VERSION,
                    "mcp_tools":runalith_mcp::registered_tool_count(),
                    "runtime":"rust"
                })
            );
            return Ok(0);
        }
        [command] if command == "--help" || command == "help" => {
            println!("runalith-mcp [version | config inspect | health]");
            println!("No arguments starts the MCP stdio host.");
            return Ok(0);
        }
        [command, subcommand] if command == "config" && subcommand == "inspect" => {
            let data_dir = configured_data_dir()?;
            let snapshot = config_inspection(&data_dir, |key| env::var(key).ok());
            println!("{}", serde_json::to_string_pretty(&snapshot)?);
            return Ok(0);
        }
        [command] if command == "health" => {
            let data_dir = configured_data_dir()?;
            let database_path = data_dir.join("workflow-rust.db");
            let sandbox_enabled = match validate_sandbox_configuration(|key| env::var_os(key)) {
                Ok(enabled) => enabled,
                Err(error) => {
                    println!(
                        "{}",
                        serde_json::json!({
                            "status":"CONFIGURATION_INVALID",
                            "read_only":true,
                            "database_path":database_path,
                            "database_opened":false,
                            "database_mutated":false,
                            "error":error,
                            "production_authority":"NOT_ESTABLISHED"
                        })
                    );
                    return Ok(2);
                }
            };
            if !database_path.exists() {
                println!(
                    "{}",
                    serde_json::json!({
                        "status":"NOT_INITIALIZED",
                        "read_only":true,
                        "database_path":database_path,
                        "database_created":false,
                        "migrations_run":false,
                        "sandbox_configuration":if sandbox_enabled {"VALID_ENABLED"} else {"DISABLED"},
                        "sandbox_runtime":"NOT_CHECKED"
                    })
                );
                return Ok(2);
            }
            match Store::inspect_health_read_only(&database_path) {
                Ok(snapshot) => {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "status":"DATABASE_HEALTHY",
                            "store":snapshot,
                            "event_chain":"NOT_CHECKED",
                            "runtime_sessions":"NOT_CHECKED",
                            "provider_lifecycle":"NOT_CONNECTED",
                            "sandbox_configuration":if sandbox_enabled {"VALID_ENABLED"} else {"DISABLED"},
                            "sandbox_runtime":"NOT_CHECKED",
                            "host_activation":"NOT_CHECKED",
                            "production_authority":"NOT_ESTABLISHED"
                        }))?
                    );
                    return Ok(0);
                }
                Err(error) => {
                    println!(
                        "{}",
                        serde_json::json!({
                            "status":"BLOCKED",
                            "read_only":true,
                            "database_path":database_path,
                            "error":error.to_string(),
                            "database_created":false,
                            "migrations_run":false
                        })
                    );
                    return Ok(2);
                }
            }
        }
        [] => {}
        _ => return Err("invalid arguments; use `runalith-mcp --help`".into()),
    }

    // Authenticate the accepted local stdio peer before creating directories,
    // opening a database, or initializing any service state.
    let (transport, principal) = local_stdio_gateway_identity()?;
    // Parse and range-check every operator-supplied sandbox setting before
    // creating/opening the durable Store. Invalid startup configuration must
    // not leave a newly initialized database behind after startup fails.
    let sandbox_enabled = validate_sandbox_configuration(|key| env::var_os(key))?;
    let data_dir = configured_data_dir()?;
    prepare_private_directory(&data_dir)?;
    let sandbox = if sandbox_enabled {
        let bwrap = env::var_os("RUNALITH_BWRAP_BINARY")
            .map(PathBuf::from)
            .ok_or("RUNALITH_BWRAP_BINARY is required when sandbox execution is enabled")?;
        let workspace = env::var_os("RUNALITH_SANDBOX_WORKSPACE_ROOT")
            .map(PathBuf::from)
            .ok_or(
                "RUNALITH_SANDBOX_WORKSPACE_ROOT is required when sandbox execution is enabled",
            )?;
        let executable_roots = env::var("RUNALITH_SANDBOX_EXECUTABLE_ROOTS")
            .map_err(|_| "RUNALITH_SANDBOX_EXECUTABLE_ROOTS is required when sandbox execution is enabled")?
            .split(';')
            .map(PathBuf::from)
            .collect::<Vec<_>>();
        let allowed_environment_keys = env::var("RUNALITH_SANDBOX_ALLOWED_ENV")
            .unwrap_or_default()
            .split(';')
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect::<BTreeSet<_>>();
        let timeout_seconds = env::var("RUNALITH_SANDBOX_TIMEOUT_SECONDS")
            .map_or(Ok(120), |value| value.parse::<u64>())?;
        let output_limit_bytes = env::var("RUNALITH_SANDBOX_OUTPUT_LIMIT_BYTES")
            .map_or(Ok(262_144), |value| value.parse::<usize>())?;
        let cgroup = CgroupV2Config::from_env("RUNALITH_SANDBOX_CGROUP_ROOT")?;
        let sandbox = BubblewrapSandbox::new(SandboxPolicy {
            bubblewrap_binary: bwrap,
            workspace_root: workspace,
            executable_roots,
            allowed_environment_keys,
            timeout_seconds,
            output_limit_bytes,
            cgroup,
        })?;
        let artifact_root = env::var_os("RUNALITH_ARTIFACT_STORE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| data_dir.join("artifacts"));
        let artifacts = ArtifactStore::open_or_create(artifact_root)?;
        Some((Arc::new(sandbox), Arc::new(artifacts)))
    } else {
        None
    };

    // Complete sandbox/cgroup and artifact-store composition before opening or
    // creating the workflow Store.
    let database_path = data_dir.join("workflow-rust.db");
    let store = if database_path.exists() {
        Store::open_existing(&database_path)?
    } else {
        match Store::create_new(&database_path) {
            Ok(store) => store,
            Err(runalith_runtime::StoreError::AlreadyExists) => {
                Store::open_existing(&database_path)?
            }
            Err(error) => return Err(error.into()),
        }
    };

    let mut server = McpServer::new(Arc::new(store))
        .with_database_path(database_path.clone())
        .with_local_read_only_gateway(transport, principal);
    if let Some((sandbox, artifacts)) = sandbox {
        server = server.with_sandbox_execution(sandbox, artifacts);
    }
    let stdin = io::stdin();
    let stdout = io::stdout();
    serve_stdio(BufReader::new(stdin.lock()), stdout.lock(), &server)?;
    Ok(0)
}

fn config_inspection(data_dir: &Path, get: impl Fn(&str) -> Option<String>) -> serde_json::Value {
    let sandbox_setting = get("RUNALITH_ENABLE_SANDBOX_EXECUTION");
    let sandbox_state = match sandbox_setting.as_deref() {
        None | Some("0") => "disabled",
        Some("1") => "enabled",
        Some(_) => "invalid",
    };
    let sandbox_validation = validate_sandbox_configuration(|key| get(key).map(Into::into));
    serde_json::json!({
        "read_only":true,
        "data_dir":data_dir,
        "data_dir_exists":data_dir.exists(),
        "sandbox":{
            "setting":sandbox_state,
            "configuration_valid":sandbox_validation.is_ok(),
            "configuration_error":sandbox_validation.err(),
            "executor_registered":false,
            "binary_configured":get("RUNALITH_BWRAP_BINARY").is_some_and(|value| !value.is_empty()),
            "workspace_configured":get("RUNALITH_SANDBOX_WORKSPACE_ROOT").is_some_and(|value| !value.is_empty()),
            "executable_roots_configured":get("RUNALITH_SANDBOX_EXECUTABLE_ROOTS").is_some_and(|value| !value.is_empty()),
            "artifact_store_configured":get("RUNALITH_ARTIFACT_STORE_DIR").is_some_and(|value| !value.is_empty())
        },
        "approval_verifier":"deny_all",
        "provider_adapters_registered":0,
        "trust_configuration_source":"not_connected",
        "trust_configuration_loaded":false,
        "production_trust_ready":false,
        "external_checkpoint_continuity":"not_connected",
        "host_activation":"not_checked",
        "secret_values_exposed":false
        ,"mcp_gateway":{
            "mode":"local_read_only_stdio",
            "identity_source":"authenticated_parent_process_uid",
            "mutating_routes_enabled":false,
            "durable_mcp_idempotency":"not_provisioned"
        }
    })
}

/// Validate every sandbox setting that can be checked without filesystem or
/// cgroup side effects. This runs before Store initialization; Bubblewrap's
/// deeper path pinning and delegated-cgroup probe still run during composition.
fn validate_sandbox_configuration(
    get: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Result<bool, String> {
    let setting = get("RUNALITH_ENABLE_SANDBOX_EXECUTION");
    let enabled = match setting.as_deref() {
        None => false,
        Some(value) if value.to_str() == Some("0") => false,
        Some(value) if value.to_str() == Some("1") => true,
        Some(_) => {
            return Err("RUNALITH_ENABLE_SANDBOX_EXECUTION must be 0 or 1".into());
        }
    };
    if !enabled {
        return Ok(false);
    }

    fn required_absolute_path(
        get: &impl Fn(&str) -> Option<std::ffi::OsString>,
        key: &str,
    ) -> Result<(), String> {
        let value = get(key)
            .ok_or_else(|| format!("{key} is required when sandbox execution is enabled"))?;
        if value.is_empty() || !PathBuf::from(value).is_absolute() {
            return Err(format!("{key} must be a non-empty absolute path"));
        }
        Ok(())
    }

    for key in ["RUNALITH_BWRAP_BINARY", "RUNALITH_SANDBOX_WORKSPACE_ROOT"] {
        required_absolute_path(&get, key)?;
    }

    let executable_roots = get("RUNALITH_SANDBOX_EXECUTABLE_ROOTS")
        .ok_or("RUNALITH_SANDBOX_EXECUTABLE_ROOTS is required when sandbox execution is enabled")?;
    let executable_roots = executable_roots
        .to_str()
        .ok_or("RUNALITH_SANDBOX_EXECUTABLE_ROOTS must be valid Unicode")?;
    let roots = executable_roots.split(';').collect::<Vec<_>>();
    if roots.is_empty()
        || roots
            .iter()
            .any(|root| root.is_empty() || !Path::new(root).is_absolute())
    {
        return Err("RUNALITH_SANDBOX_EXECUTABLE_ROOTS must contain non-empty absolute paths separated by semicolons".into());
    }

    fn bounded_number<T>(
        get: &impl Fn(&str) -> Option<std::ffi::OsString>,
        key: &str,
        default: T,
    ) -> Result<T, String>
    where
        T: std::str::FromStr,
    {
        match get(key) {
            None => Ok(default),
            Some(value) => value
                .to_str()
                .ok_or_else(|| format!("{key} must be valid Unicode"))?
                .parse::<T>()
                .map_err(|_| format!("{key} must be a valid bounded integer")),
        }
    }

    let timeout = bounded_number(&get, "RUNALITH_SANDBOX_TIMEOUT_SECONDS", 120_u64)?;
    let output_limit = bounded_number(&get, "RUNALITH_SANDBOX_OUTPUT_LIMIT_BYTES", 262_144_usize)?;
    if !(1..=600).contains(&timeout) || !(1..=1_048_576).contains(&output_limit) {
        return Err("sandbox timeout/output limits are outside supported safe bounds".into());
    }

    let memory = bounded_number(&get, "RUNALITH_SANDBOX_MEMORY_MAX_BYTES", 1_073_741_824_u64)?;
    let cpu_quota = bounded_number(&get, "RUNALITH_SANDBOX_CPU_QUOTA_MICROS", 100_000_u64)?;
    let cpu_period = bounded_number(&get, "RUNALITH_SANDBOX_CPU_PERIOD_MICROS", 100_000_u64)?;
    let pids = bounded_number(&get, "RUNALITH_SANDBOX_PIDS_MAX", 64_u64)?;
    let scratch = bounded_number(&get, "RUNALITH_SANDBOX_SCRATCH_MAX_BYTES", 134_217_728_u64)?;
    if memory < 16 * 1024 * 1024
        || cpu_quota == 0
        || !(1_000..=1_000_000).contains(&cpu_period)
        || cpu_quota > cpu_period.saturating_mul(64)
        || !(1..=4096).contains(&pids)
        || !(1024 * 1024..=16 * 1024 * 1024 * 1024).contains(&scratch)
    {
        return Err("sandbox cgroup resource limits are outside supported safe bounds".into());
    }

    if get("RUNALITH_SANDBOX_CGROUP_ROOT").is_some() {
        required_absolute_path(&get, "RUNALITH_SANDBOX_CGROUP_ROOT")?;
    }
    if let Some(allowed) = get("RUNALITH_SANDBOX_ALLOWED_ENV") {
        let allowed = allowed
            .to_str()
            .ok_or("RUNALITH_SANDBOX_ALLOWED_ENV must be valid Unicode")?;
        if !allowed.is_empty() {
            for key in allowed.split(';') {
                let valid = !key.is_empty()
                    && key.len() <= 128
                    && key.bytes().enumerate().all(|(index, byte)| {
                        byte.is_ascii_uppercase()
                            || byte == b'_'
                            || (index > 0 && byte.is_ascii_digit())
                    });
                if !valid
                    || matches!(
                        key,
                        "PATH" | "HOME" | "TMPDIR" | "LD_PRELOAD" | "LD_LIBRARY_PATH"
                    )
                {
                    return Err(
                        "RUNALITH_SANDBOX_ALLOWED_ENV contains an invalid or reserved key".into(),
                    );
                }
            }
        }
    }

    if get("RUNALITH_ARTIFACT_STORE_DIR").is_some() {
        required_absolute_path(&get, "RUNALITH_ARTIFACT_STORE_DIR")?;
    }
    Ok(true)
}

/// Build the stdio principal from the OS-authenticated parent process. This is
/// a single-local-user identity, not an end-user identity for a remote/shared
/// host. Refuse to start when procfs cannot prove the parent UID.
fn local_stdio_gateway_identity()
-> Result<(AuthenticatedMcpTransportContext, McpPrincipalV1), Box<dyn std::error::Error>> {
    let own_uid = rustix::process::geteuid().as_raw();
    let own_status = fs::read_to_string("/proc/self/status")?;
    let parent_pid = proc_status_value(&own_status, "PPid:")?
        .parse::<u32>()
        .map_err(|_| "invalid parent PID in /proc/self/status")?;
    if parent_pid == 0 {
        return Err("stdio parent process identity is unavailable".into());
    }
    let parent_status = fs::read_to_string(format!("/proc/{parent_pid}/status"))?;
    let parent_uid_fields = proc_status_value(&parent_status, "Uid:")?
        .split_whitespace()
        .map(str::parse::<u32>)
        .collect::<Result<Vec<_>, _>>()?;
    let parent_effective_uid = *parent_uid_fields
        .get(1)
        .ok_or("parent process UID record is incomplete")?;
    if parent_effective_uid != own_uid {
        return Err("stdio parent must run under the same effective UID".into());
    }

    let process_id = std::process::id();
    let connection_id = format!("stdio:{process_id}:{parent_pid}");
    let peer_identity = format!("pid:{parent_pid}:uid:{parent_effective_uid}");
    let transport = AuthenticatedMcpTransportContext::from_authenticated_peer(
        connection_id.clone(),
        peer_identity.clone(),
    )?;
    let principal = McpPrincipalV1 {
        subject: peer_identity,
        issuer: "linux-stdio-parent-process".into(),
        audience: "runalith-local".into(),
        authentication_context: connection_id,
    };
    Ok((transport, principal))
}

fn proc_status_value<'a>(
    status: &'a str,
    key: &str,
) -> Result<&'a str, Box<dyn std::error::Error>> {
    status
        .lines()
        .find_map(|line| line.strip_prefix(key))
        .map(str::trim)
        .ok_or_else(|| format!("{key} is missing from /proc status").into())
}

fn configured_data_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let path = if let Some(value) = env::var_os("RUNALITH_RUST_DATA_DIR") {
        if value.is_empty() {
            return Err("RUNALITH_RUST_DATA_DIR must not be empty".into());
        }
        PathBuf::from(value)
    } else {
        let home =
            env::var_os("HOME").ok_or("HOME is not set; configure RUNALITH_RUST_DATA_DIR")?;
        PathBuf::from(home).join(".runalith").join("rust-runtime")
    };
    validate_private_directory_path(&path)?;
    Ok(path)
}

fn prepare_private_directory(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    validate_private_directory_path(path)?;
    reject_symlinked_directory_components(path)?;
    fs::create_dir_all(path)?;
    reject_symlinked_directory_components(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Runalith data directory must be a regular directory, not a symlink".into());
    }
    let canonical = fs::canonicalize(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&canonical, fs::Permissions::from_mode(0o700))?;
        let mode = fs::metadata(&canonical)?.permissions().mode();
        if mode & 0o077 != 0 {
            return Err("Runalith data directory is not private (expected mode 0700)".into());
        }
    }
    Ok(())
}

fn validate_private_directory_path(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    if !path.is_absolute()
        || path == Path::new("/")
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(
            "Runalith data directory must be an absolute non-root path without parent traversal"
                .into(),
        );
    }
    Ok(())
}

fn reject_symlinked_directory_components(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let mut current = PathBuf::from("/");
    for component in path.components().skip(1) {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(format!(
                    "Runalith data directory contains a symlink or non-directory component: {}",
                    current.display()
                )
                .into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn config_inspection_reports_presence_without_exposing_secret_values() {
        let values = BTreeMap::from([
            (
                "RUNALITH_ENABLE_SANDBOX_EXECUTION".to_owned(),
                "1".to_owned(),
            ),
            (
                "RUNALITH_BWRAP_BINARY".to_owned(),
                "/usr/bin/bwrap".to_owned(),
            ),
            (
                "RUNALITH_SANDBOX_WORKSPACE_ROOT".to_owned(),
                "sensitive-config-json".to_owned(),
            ),
        ]);
        let snapshot = config_inspection(Path::new("/nonexistent/data"), |key| {
            values.get(key).cloned()
        });
        assert_eq!(snapshot["sandbox"]["setting"], "enabled");
        assert_eq!(snapshot["trust_configuration_source"], "not_connected");
        assert_eq!(snapshot["trust_configuration_loaded"], false);
        assert_eq!(snapshot["approval_verifier"], "deny_all");
        assert_eq!(snapshot["production_trust_ready"], false);
        assert_eq!(snapshot["secret_values_exposed"], false);
        assert_eq!(snapshot["mcp_gateway"]["mode"], "local_read_only_stdio");
        assert_eq!(snapshot["mcp_gateway"]["mutating_routes_enabled"], false);
        assert_eq!(snapshot["sandbox"]["configuration_valid"], false);
        assert!(
            !serde_json::to_string(&snapshot)
                .unwrap()
                .contains("sensitive-config-json")
        );
    }

    #[test]
    fn sandbox_configuration_is_validated_before_host_state_initialization() {
        let disabled = BTreeMap::<String, String>::new();
        assert!(
            !validate_sandbox_configuration(|key| {
                disabled.get(key).map(std::ffi::OsString::from)
            })
            .unwrap()
        );

        let invalid_toggle = BTreeMap::from([(
            "RUNALITH_ENABLE_SANDBOX_EXECUTION".to_owned(),
            "true".to_owned(),
        )]);
        assert!(
            validate_sandbox_configuration(|key| {
                invalid_toggle.get(key).map(std::ffi::OsString::from)
            })
            .is_err()
        );

        let mut values: BTreeMap<String, String> = BTreeMap::from([
            ("RUNALITH_ENABLE_SANDBOX_EXECUTION".into(), "1".into()),
            ("RUNALITH_BWRAP_BINARY".into(), "/usr/bin/bwrap".into()),
            (
                "RUNALITH_SANDBOX_WORKSPACE_ROOT".into(),
                "/srv/workspace".into(),
            ),
            (
                "RUNALITH_SANDBOX_EXECUTABLE_ROOTS".into(),
                "/usr/bin;/bin".into(),
            ),
        ]);
        assert!(
            validate_sandbox_configuration(|key| { values.get(key).map(std::ffi::OsString::from) })
                .unwrap()
        );

        values.insert("RUNALITH_SANDBOX_TIMEOUT_SECONDS".into(), "0".into());
        assert!(
            validate_sandbox_configuration(|key| { values.get(key).map(std::ffi::OsString::from) })
                .is_err()
        );
        values.remove("RUNALITH_SANDBOX_TIMEOUT_SECONDS");

        values.insert(
            "RUNALITH_SANDBOX_EXECUTABLE_ROOTS".into(),
            "/usr/bin;;/bin".into(),
        );
        assert!(
            validate_sandbox_configuration(|key| { values.get(key).map(std::ffi::OsString::from) })
                .is_err()
        );
        values.insert(
            "RUNALITH_SANDBOX_EXECUTABLE_ROOTS".into(),
            "/usr/bin;/bin".into(),
        );

        values.insert(
            "RUNALITH_SANDBOX_ALLOWED_ENV".into(),
            "PATH;SAFE_KEY".into(),
        );
        assert!(
            validate_sandbox_configuration(|key| { values.get(key).map(std::ffi::OsString::from) })
                .is_err()
        );
        values.insert("RUNALITH_SANDBOX_ALLOWED_ENV".into(), "SAFE_KEY".into());
        values.insert("RUNALITH_SANDBOX_MEMORY_MAX_BYTES".into(), "0".into());
        assert!(
            validate_sandbox_configuration(|key| { values.get(key).map(std::ffi::OsString::from) })
                .is_err()
        );
    }

    #[test]
    fn data_directory_requires_absolute_non_root_path_without_parent_traversal() {
        for path in [
            Path::new("relative/data"),
            Path::new("/"),
            Path::new("/safe/../escape"),
        ] {
            assert!(validate_private_directory_path(path).is_err());
        }
        assert!(validate_private_directory_path(Path::new("/var/lib/runalith/mcp")).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn private_data_directory_rejects_symlinked_parent_before_creation() {
        let base = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let linked_parent = base.path().join("linked-parent");
        std::os::unix::fs::symlink(outside.path(), &linked_parent).unwrap();
        let requested = linked_parent.join("rust-runtime");

        assert!(prepare_private_directory(&requested).is_err());
        assert!(!outside.path().join("rust-runtime").exists());
    }

    #[test]
    fn proc_status_identity_parser_requires_explicit_parent_and_uid_fields() {
        let status = "Name:\trunalith\nPPid:\t1234\nUid:\t1000\t1000\t1000\t1000\n";
        assert_eq!(proc_status_value(status, "PPid:").unwrap(), "1234");
        assert_eq!(
            proc_status_value(status, "Uid:").unwrap(),
            "1000\t1000\t1000\t1000"
        );
        assert!(proc_status_value(status, "Gid:").is_err());
    }

    #[test]
    fn local_stdio_gateway_identity_is_derived_from_kernel_parent_process_state() {
        let (transport, principal) = local_stdio_gateway_identity().unwrap();
        assert_eq!(principal.subject, transport.peer_identity());
        assert_eq!(principal.issuer, "linux-stdio-parent-process");
        assert_eq!(principal.audience, "runalith-local");
        assert_eq!(principal.authentication_context, transport.connection_id());
        assert!(transport.connection_id().starts_with("stdio:"));
        assert!(transport.peer_identity().starts_with("pid:"));
    }
}
