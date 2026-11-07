//! Acceptance tests that launch the standalone Control executable.

use std::{
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn http_request(
    address: SocketAddr,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: &Value,
) -> (u16, Value) {
    let encoded = serde_json::to_vec(body).unwrap();
    let mut stream = TcpStream::connect(address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        encoded.len()
    );
    if let Some(token) = token {
        request.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).unwrap();
    stream.write_all(&encoded).unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).unwrap();
    let split = response
        .windows(4)
        .position(|value| value == b"\r\n\r\n")
        .unwrap()
        + 4;
    let header = std::str::from_utf8(&response[..split]).unwrap();
    let status = header
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse::<u16>()
        .unwrap();
    let value = if response.len() == split {
        Value::Null
    } else {
        serde_json::from_slice(&response[split..]).unwrap()
    };
    (status, value)
}

fn auth_file(path: &Path, token: &str) {
    let digest = Sha256::digest(token.as_bytes());
    let document = json!({
        "version":1,
        "principals":[{
            "token_sha256":format!("{digest:x}"),
            "subject":"operator-standalone",
            "issuer":"integration-test",
            "capabilities":[
                "control.health.read",
                "workflow.read",
                "workflow.create",
                "worker.claim.receive",
                "catalog.role.write",
                "catalog.workflow.write",
                "catalog.workflow.compile"
            ]
        }]
    });
    fs::write(path, serde_json::to_vec(&document).unwrap()).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

fn available_loopback_address() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap()
}

fn env_config(
    command: &mut Command,
    database: &Path,
    auth: &Path,
    pid: &Path,
    stop: &Path,
    listen: SocketAddr,
) {
    command
        .env("RUNALITH_CONTROL_DATABASE_PATH", database)
        .env("RUNALITH_CONTROL_AUTH_FILE", auth)
        .env("RUNALITH_CONTROL_PID_FILE", pid)
        .env("RUNALITH_CONTROL_SHUTDOWN_FILE", stop)
        .env("RUNALITH_CONTROL_LISTEN_ADDR", listen.to_string());
}

#[test]
fn standalone_control_starts_serves_authenticated_routes_and_stops_cleanly() {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let database = directory.path().join("control.db");
    let auth = directory.path().join("auth.json");
    let pid = directory.path().join("control.pid");
    let stop = directory.path().join("control.stop");
    let token = "integration-test-long-random-token";
    auth_file(&auth, token);
    let listen = available_loopback_address();
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_runalith-control"));

    let mut initialize = Command::new(&binary);
    initialize
        .arg("init-db")
        .env("RUNALITH_CONTROL_DATABASE_PATH", &database);
    let initialized = initialize.output().unwrap();
    assert!(
        initialized.status.success(),
        "{}",
        String::from_utf8_lossy(&initialized.stderr)
    );

    let mut start = Command::new(&binary);
    start
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    env_config(&mut start, &database, &auth, &pid, &stop, listen);
    let mut child = ChildGuard(start.spawn().unwrap());

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut ready = false;
    while Instant::now() < deadline {
        if child.0.try_wait().unwrap().is_some() {
            break;
        }
        if TcpStream::connect(listen).is_ok() {
            ready = true;
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    assert!(
        ready,
        "standalone Control did not open its loopback listener"
    );

    let first_pid_marker = fs::read_to_string(&pid).unwrap();
    let mut concurrent_start = Command::new(&binary);
    concurrent_start
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    env_config(&mut concurrent_start, &database, &auth, &pid, &stop, listen);
    let concurrent_start = concurrent_start.output().unwrap();
    assert!(
        !concurrent_start.status.success(),
        "a second Control process must not acquire the live database lock"
    );
    let concurrent_error = String::from_utf8_lossy(&concurrent_start.stderr);
    assert!(
        concurrent_error.contains("another Control or maintenance process holds"),
        "unexpected concurrent-start diagnostic: {concurrent_error}"
    );
    assert_eq!(fs::read_to_string(&pid).unwrap(), first_pid_marker);
    let (status, body) = http_request(listen, "GET", "/readyz", None, &Value::Null);
    assert_eq!(status, 200, "the first server must remain ready: {body}");

    let (status, body) = http_request(listen, "GET", "/livez", None, &Value::Null);
    assert_eq!(status, 200);
    assert_eq!(body["status"], "live");
    let (status, body) = http_request(listen, "GET", "/readyz", None, &Value::Null);
    assert_eq!(status, 200);
    assert_eq!(body["status"], "ready");

    let (status, _) = http_request(listen, "GET", "/health", None, &Value::Null);
    assert_eq!(status, 401);
    let (status, _) = http_request(listen, "GET", "/health", Some(token), &Value::Null);
    assert_eq!(status, 200);
    let (status, _) = http_request(
        listen,
        "POST",
        "/v1/worker/claims/receive",
        Some(token),
        &json!({"worker_id":"operator-standalone"}),
    );
    assert_eq!(
        status, 503,
        "worker authority must remain unavailable, not fabricate a claim"
    );

    let custom_role = json!({
        "role_id":"control-integration-role",
        "version":1,
        "name":"Documentation role",
        "description":"Produces documentation artifact",
        "system_prompt":"Write accurate project documentation.",
        "input_contract":["job.request"],
        "output_artifact_type":"documentation",
        "allowed_capabilities":["documentation.write"],
        "permissions":["workspace.read","artifact.create"],
        "allowed_tools":[],
        "skills":[]
    });
    let (status, created_role) = http_request(
        listen,
        "POST",
        "/v1/catalog/roles",
        Some(token),
        &custom_role,
    );
    assert_eq!(status, 201, "{created_role}");
    assert_eq!(
        created_role["definition"]["role_id"],
        "control-integration-role"
    );

    let custom_workflow = json!({
        "workflow_id":"control-integration-workflow",
        "version":1,
        "name":"Standalone catalog workflow",
        "description":"End-to-end catalog plan acceptance",
        "input_contract":["job.request"],
        "tasks":[{
            "id":"write-docs",
            "role_id":"control-integration-role",
            "role_version":1,
            "depends_on":[],
            "input_contract":["job.request"],
            "output_artifact_type":"documentation"
        }]
    });
    let (status, created_workflow) = http_request(
        listen,
        "POST",
        "/v1/catalog/workflows",
        Some(token),
        &custom_workflow,
    );
    assert_eq!(status, 201, "{created_workflow}");

    let (status, compiled_plan) = http_request(
        listen,
        "POST",
        "/v1/catalog/workflows/control-integration-workflow/compile",
        Some(token),
        &json!({"version":1}),
    );
    assert_eq!(status, 201, "{compiled_plan}");
    let plan_id = compiled_plan["plan_id"].as_str().expect("compiled plan ID");
    let instantiate = json!({
        "plan_id":plan_id,
        "idempotency_key":"standalone-control-integration-instance-1",
        "title":"Standalone bound workflow",
        "goal":"Verify exact catalog-plan binding through real HTTP"
    });
    let (status, instantiated) = http_request(
        listen,
        "POST",
        "/v1/workflows/from-catalog-plan",
        Some(token),
        &instantiate,
    );
    assert_eq!(status, 201, "{instantiated}");
    let workflow_id = instantiated["proposal"]["workflow_id"]
        .as_str()
        .expect("derived workflow ID")
        .to_owned();
    assert!(workflow_id.starts_with("job_"));
    assert_eq!(
        instantiated["tasks"][0]["definition"]["task_id"],
        "write-docs"
    );
    let (status, replayed) = http_request(
        listen,
        "POST",
        "/v1/workflows/from-catalog-plan",
        Some(token),
        &instantiate,
    );
    assert_eq!(status, 201, "{replayed}");
    assert_eq!(replayed["proposal"]["workflow_id"], workflow_id);
    let mut rebound = instantiate;
    rebound["goal"] = json!("A changed goal must not reuse the idempotency key");
    let (status, _) = http_request(
        listen,
        "POST",
        "/v1/workflows/from-catalog-plan",
        Some(token),
        &rebound,
    );
    assert_eq!(status, 409);

    let proposal = json!({
        "workflow_id":"job_standalone_process_test",
        "title":"Standalone Control integration",
        "goal":"Verify authenticated durable proposal creation",
        "tasks":[{
            "task_id":"task_one",
            "role":"engineer",
            "description":"Create a persisted proposal",
            "depends_on":[],
            "required_evidence":["report"],
            "inputs":{}
        }],
        "metadata":{}
    });
    let (status, created) = http_request(listen, "POST", "/v1/workflows", Some(token), &proposal);
    assert_eq!(status, 201, "{created}");
    assert_eq!(
        created["proposal"]["workflow_id"],
        "job_standalone_process_test"
    );

    let mut stop_command = Command::new(&binary);
    stop_command.arg("stop");
    env_config(&mut stop_command, &database, &auth, &pid, &stop, listen);
    let stopped = stop_command.output().unwrap();
    assert!(
        stopped.status.success(),
        "{}",
        String::from_utf8_lossy(&stopped.stderr)
    );
    let exit = child.0.wait().unwrap();
    assert!(exit.success());
    assert!(!pid.exists());

    let mut health = Command::new(&binary);
    health
        .arg("health")
        .env("RUNALITH_CONTROL_DATABASE_PATH", &database);
    let health = health.output().unwrap();
    assert!(
        health.status.success(),
        "{}",
        String::from_utf8_lossy(&health.stderr)
    );
    let health_body: Value = serde_json::from_slice(&health.stdout).unwrap();
    assert_eq!(health_body["status"], "DATABASE_HEALTHY");

    let mut restart = Command::new(&binary);
    restart
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    env_config(&mut restart, &database, &auth, &pid, &stop, listen);
    let mut restarted = ChildGuard(restart.spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut restart_ready = false;
    while Instant::now() < deadline {
        if restarted.0.try_wait().unwrap().is_some() {
            break;
        }
        if TcpStream::connect(listen).is_ok() {
            let (status, body) = http_request(listen, "GET", "/readyz", None, &Value::Null);
            if status == 200 && body["status"] == "ready" {
                restart_ready = true;
                break;
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
    assert!(
        restart_ready,
        "standalone Control did not reopen the same Store after clean stop"
    );
    let workflow_path = format!("/v1/workflows/{workflow_id}");
    let (status, persisted) =
        http_request(listen, "GET", &workflow_path, Some(token), &Value::Null);
    assert_eq!(status, 200, "{persisted}");
    assert_eq!(persisted["proposal"]["workflow_id"], workflow_id);
    assert_eq!(persisted["tasks"][0]["definition"]["task_id"], "write-docs");
    let events_path = format!("{workflow_path}/events");
    let (status, events) = http_request(listen, "GET", &events_path, Some(token), &Value::Null);
    assert_eq!(status, 200, "{events}");
    assert!(
        events["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| { event["event_type"] == "workflow.catalog_plan_bound" })
    );

    let mut stop_restarted = Command::new(&binary);
    stop_restarted.arg("stop");
    env_config(&mut stop_restarted, &database, &auth, &pid, &stop, listen);
    let stopped = stop_restarted.output().unwrap();
    assert!(
        stopped.status.success(),
        "{}",
        String::from_utf8_lossy(&stopped.stderr)
    );
    assert!(restarted.0.wait().unwrap().success());
    assert!(!pid.exists());
}

#[test]
fn standalone_maintenance_commands_refuse_while_server_holds_advisory_lock() {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let database = directory.path().join("maintenance-live.db");
    let auth = directory.path().join("auth.json");
    let pid = directory.path().join("control.pid");
    let stop = directory.path().join("control.stop");
    let source_backup = directory.path().join("restore-source.db");
    let migration_backup = directory.path().join("migration-backup.db");
    let restore_target = directory.path().join("restored-while-live.db");
    let token = "maintenance-lock-integration-long-random-token";
    auth_file(&auth, token);
    let listen = available_loopback_address();
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_runalith-control"));

    let mut initialize = Command::new(&binary);
    initialize
        .arg("init-db")
        .env("RUNALITH_CONTROL_DATABASE_PATH", &database);
    let initialized = initialize.output().unwrap();
    assert!(
        initialized.status.success(),
        "{}",
        String::from_utf8_lossy(&initialized.stderr)
    );

    let snapshot = Connection::open(&database).unwrap();
    snapshot
        .execute("VACUUM INTO ?1", [source_backup.to_str().unwrap()])
        .unwrap();
    drop(snapshot);
    fs::set_permissions(&source_backup, fs::Permissions::from_mode(0o600)).unwrap();

    let mut start = Command::new(&binary);
    start
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    env_config(&mut start, &database, &auth, &pid, &stop, listen);
    let mut server = ChildGuard(start.spawn().unwrap());

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut ready = false;
    while Instant::now() < deadline {
        if server.0.try_wait().unwrap().is_some() {
            break;
        }
        if TcpStream::connect(listen).is_ok() {
            let (status, body) = http_request(listen, "GET", "/readyz", None, &Value::Null);
            if status == 200 && body["status"] == "ready" {
                ready = true;
                break;
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
    assert!(
        ready,
        "Control server must own its advisory lock before maintenance probes"
    );
    let original_pid = fs::read_to_string(&pid).unwrap();
    let original_database = fs::read(&database).unwrap();

    let mut migrate = Command::new(&binary);
    migrate.arg("migrate-db").arg(&migration_backup);
    env_config(&mut migrate, &database, &auth, &pid, &stop, listen);
    let migration = migrate.output().unwrap();
    assert!(
        !migration.status.success(),
        "migration must not overlap a live Control process"
    );
    let migration_error = String::from_utf8_lossy(&migration.stderr);
    assert!(
        migration_error.contains("another Control or maintenance process holds"),
        "{migration_error}"
    );
    assert!(
        !migration_backup.exists(),
        "migration must fail before creating any backup while lock is held"
    );

    let mut restore = Command::new(&binary);
    restore
        .arg("restore-db")
        .arg(&source_backup)
        .env("RUNALITH_CONTROL_DATABASE_PATH", &restore_target)
        .env("RUNALITH_CONTROL_PID_FILE", &pid)
        .env("RUNALITH_CONTROL_SHUTDOWN_FILE", &stop);
    let restored = restore.output().unwrap();
    assert!(
        !restored.status.success(),
        "restore must not overlap a live Control process"
    );
    let restore_error = String::from_utf8_lossy(&restored.stderr);
    assert!(
        restore_error.contains("another Control or maintenance process holds"),
        "{restore_error}"
    );
    assert!(
        !restore_target.exists(),
        "restore must fail before publishing a destination while lock is held"
    );

    assert_eq!(fs::read(&database).unwrap(), original_database);
    assert_eq!(fs::read_to_string(&pid).unwrap(), original_pid);
    let (status, body) = http_request(listen, "GET", "/readyz", None, &Value::Null);
    assert_eq!(
        status, 200,
        "maintenance refusal must leave the server healthy: {body}"
    );

    let mut stop_command = Command::new(&binary);
    stop_command.arg("stop");
    env_config(&mut stop_command, &database, &auth, &pid, &stop, listen);
    let stopped = stop_command.output().unwrap();
    assert!(
        stopped.status.success(),
        "{}",
        String::from_utf8_lossy(&stopped.stderr)
    );
    assert!(server.0.wait().unwrap().success());
    assert!(!pid.exists());
    assert!(source_backup.exists(), "test snapshot remains unchanged");
}

#[test]
fn standalone_control_restarts_after_sigkill_and_recovers_stale_pid_marker() {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let database = directory.path().join("crash-restart.db");
    let auth = directory.path().join("auth.json");
    let pid = directory.path().join("control.pid");
    let stop = directory.path().join("control.stop");
    let lock = directory.path().join("control.lock");
    let token = "crash-restart-integration-long-random-token";
    auth_file(&auth, token);
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_runalith-control"));

    let mut initialize = Command::new(&binary);
    initialize
        .arg("init-db")
        .env("RUNALITH_CONTROL_DATABASE_PATH", &database);
    let initialized = initialize.output().unwrap();
    assert!(
        initialized.status.success(),
        "{}",
        String::from_utf8_lossy(&initialized.stderr)
    );

    let first_listen = available_loopback_address();
    let mut first_start = Command::new(&binary);
    first_start
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    env_config(
        &mut first_start,
        &database,
        &auth,
        &pid,
        &stop,
        first_listen,
    );
    let mut first_process = ChildGuard(first_start.spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut first_ready = false;
    while Instant::now() < deadline {
        if first_process.0.try_wait().unwrap().is_some() {
            break;
        }
        if TcpStream::connect(first_listen).is_ok() {
            let (status, body) = http_request(first_listen, "GET", "/readyz", None, &Value::Null);
            if status == 200 && body["status"] == "ready" {
                first_ready = true;
                break;
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
    assert!(first_ready, "first Control process did not become ready");
    let first_pid = fs::read_to_string(&pid).unwrap();
    assert!(lock.exists());

    first_process.0.kill().unwrap();
    let killed = first_process.0.wait().unwrap();
    assert!(
        !killed.success(),
        "SIGKILL must terminate the first Control process"
    );
    assert!(
        pid.exists(),
        "SIGKILL leaves the stale PID marker for restart recovery"
    );

    let second_listen = available_loopback_address();
    let mut second_start = Command::new(&binary);
    second_start
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    env_config(
        &mut second_start,
        &database,
        &auth,
        &pid,
        &stop,
        second_listen,
    );
    let mut second_process = ChildGuard(second_start.spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut second_ready = false;
    while Instant::now() < deadline {
        if second_process.0.try_wait().unwrap().is_some() {
            break;
        }
        if TcpStream::connect(second_listen).is_ok() {
            let (status, body) = http_request(second_listen, "GET", "/readyz", None, &Value::Null);
            if status == 200 && body["status"] == "ready" {
                second_ready = true;
                break;
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
    assert!(
        second_ready,
        "Control process must recover the dead PID marker after obtaining the exclusive lock"
    );
    let second_pid = fs::read_to_string(&pid).unwrap();
    assert_ne!(second_pid, first_pid);
    assert!(
        lock.exists(),
        "lock inode remains stable across process restart"
    );
    let (status, health) = http_request(second_listen, "GET", "/health", Some(token), &Value::Null);
    assert_eq!(status, 200, "{health}");

    let mut stop_command = Command::new(&binary);
    stop_command.arg("stop");
    env_config(
        &mut stop_command,
        &database,
        &auth,
        &pid,
        &stop,
        second_listen,
    );
    let stopped = stop_command.output().unwrap();
    assert!(
        stopped.status.success(),
        "{}",
        String::from_utf8_lossy(&stopped.stderr)
    );
    assert!(second_process.0.wait().unwrap().success());
    assert!(!pid.exists());
    assert!(lock.exists());
}

#[test]
fn standalone_bind_failure_releases_pid_marker_and_advisory_lock() {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let database = directory.path().join("bind-failure.db");
    let auth = directory.path().join("auth.json");
    let pid = directory.path().join("control.pid");
    let stop = directory.path().join("control.stop");
    let token = "bind-failure-cleanup-integration-token";
    auth_file(&auth, token);
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_runalith-control"));

    let mut initialize = Command::new(&binary);
    initialize
        .arg("init-db")
        .env("RUNALITH_CONTROL_DATABASE_PATH", &database);
    let initialized = initialize.output().unwrap();
    assert!(
        initialized.status.success(),
        "{}",
        String::from_utf8_lossy(&initialized.stderr)
    );

    let blocking_listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let listen = blocking_listener.local_addr().unwrap();
    let mut failed_start = Command::new(&binary);
    failed_start
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    env_config(&mut failed_start, &database, &auth, &pid, &stop, listen);
    let failed_start = failed_start.output().unwrap();
    assert!(!failed_start.status.success());
    let failure = String::from_utf8_lossy(&failed_start.stderr);
    assert!(
        failure.contains("Address already in use"),
        "unexpected listener-bind diagnostic: {failure}"
    );
    assert!(!pid.exists(), "failed startup must remove its PID marker");

    drop(blocking_listener);
    let mut retry = Command::new(&binary);
    retry
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    env_config(&mut retry, &database, &auth, &pid, &stop, listen);
    let mut server = ChildGuard(retry.spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut ready = false;
    while Instant::now() < deadline {
        if server.0.try_wait().unwrap().is_some() {
            break;
        }
        if TcpStream::connect(listen).is_ok() {
            let (status, body) = http_request(listen, "GET", "/readyz", None, &Value::Null);
            if status == 200 && body["status"] == "ready" {
                ready = true;
                break;
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
    assert!(
        ready,
        "Control could not restart after its listener-bind failure"
    );

    let mut stop_server = Command::new(&binary);
    stop_server.arg("stop");
    env_config(&mut stop_server, &database, &auth, &pid, &stop, listen);
    let stopped = stop_server.output().unwrap();
    assert!(
        stopped.status.success(),
        "{}",
        String::from_utf8_lossy(&stopped.stderr)
    );
    assert!(server.0.wait().unwrap().success());
    assert!(!pid.exists());
}

#[test]
fn standalone_invalid_auth_failure_releases_pid_marker_and_advisory_lock() {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let database = directory.path().join("auth-failure.db");
    let auth = directory.path().join("auth.json");
    let pid = directory.path().join("control.pid");
    let stop = directory.path().join("control.stop");
    let token = "auth-failure-cleanup-integration-token";
    auth_file(&auth, token);
    fs::set_permissions(&auth, fs::Permissions::from_mode(0o644)).unwrap();
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_runalith-control"));

    let mut initialize = Command::new(&binary);
    initialize
        .arg("init-db")
        .env("RUNALITH_CONTROL_DATABASE_PATH", &database);
    let initialized = initialize.output().unwrap();
    assert!(
        initialized.status.success(),
        "{}",
        String::from_utf8_lossy(&initialized.stderr)
    );

    let listen = std::net::TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap();
    let mut invalid_start = Command::new(&binary);
    invalid_start
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    env_config(&mut invalid_start, &database, &auth, &pid, &stop, listen);
    let invalid_start = invalid_start.output().unwrap();
    assert!(!invalid_start.status.success());
    let failure = String::from_utf8_lossy(&invalid_start.stderr);
    assert!(
        failure.contains("owner-only") || failure.contains("private"),
        "unexpected authentication-file diagnostic: {failure}"
    );
    assert!(
        !pid.exists(),
        "failed authentication must remove its PID marker"
    );

    fs::set_permissions(&auth, fs::Permissions::from_mode(0o600)).unwrap();
    let mut retry = Command::new(&binary);
    retry
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    env_config(&mut retry, &database, &auth, &pid, &stop, listen);
    let mut server = ChildGuard(retry.spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut ready = false;
    while Instant::now() < deadline {
        if server.0.try_wait().unwrap().is_some() {
            break;
        }
        if TcpStream::connect(listen).is_ok() {
            let (status, body) = http_request(listen, "GET", "/readyz", None, &Value::Null);
            if status == 200 && body["status"] == "ready" {
                ready = true;
                break;
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
    assert!(
        ready,
        "Control could not restart after rejecting an insecure auth file"
    );

    let mut stop_server = Command::new(&binary);
    stop_server.arg("stop");
    env_config(&mut stop_server, &database, &auth, &pid, &stop, listen);
    let stopped = stop_server.output().unwrap();
    assert!(
        stopped.status.success(),
        "{}",
        String::from_utf8_lossy(&stopped.stderr)
    );
    assert!(server.0.wait().unwrap().success());
    assert!(!pid.exists());
}

#[test]
fn standalone_missing_database_startup_does_not_create_database_or_retain_process_lock() {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let database = directory.path().join("not-initialized.db");
    let auth = directory.path().join("auth.json");
    let pid = directory.path().join("control.pid");
    let stop = directory.path().join("control.stop");
    let token = "missing-db-cleanup-integration-token";
    auth_file(&auth, token);
    let listen = std::net::TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap();
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_runalith-control"));

    let mut missing_database_start = Command::new(&binary);
    missing_database_start
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    env_config(
        &mut missing_database_start,
        &database,
        &auth,
        &pid,
        &stop,
        listen,
    );
    let missing_database_start = missing_database_start.output().unwrap();
    assert!(!missing_database_start.status.success());
    assert!(
        !database.exists(),
        "serve must not create or migrate the Store"
    );
    assert!(
        !pid.exists(),
        "failed open_existing must release its PID marker"
    );

    let mut initialize = Command::new(&binary);
    initialize
        .arg("init-db")
        .env("RUNALITH_CONTROL_DATABASE_PATH", &database);
    let initialized = initialize.output().unwrap();
    assert!(
        initialized.status.success(),
        "{}",
        String::from_utf8_lossy(&initialized.stderr)
    );

    let mut retry = Command::new(&binary);
    retry
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    env_config(&mut retry, &database, &auth, &pid, &stop, listen);
    let mut server = ChildGuard(retry.spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut ready = false;
    while Instant::now() < deadline {
        if server.0.try_wait().unwrap().is_some() {
            break;
        }
        if TcpStream::connect(listen).is_ok() {
            let (status, body) = http_request(listen, "GET", "/readyz", None, &Value::Null);
            if status == 200 && body["status"] == "ready" {
                ready = true;
                break;
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
    assert!(ready, "Control did not start after explicit init-db");

    let mut stop_server = Command::new(&binary);
    stop_server.arg("stop");
    env_config(&mut stop_server, &database, &auth, &pid, &stop, listen);
    let stopped = stop_server.output().unwrap();
    assert!(
        stopped.status.success(),
        "{}",
        String::from_utf8_lossy(&stopped.stderr)
    );
    assert!(server.0.wait().unwrap().success());
    assert!(!pid.exists());
}

#[test]
fn standalone_concurrent_init_db_has_one_winner_and_keeps_database_healthy() {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let database = directory.path().join("concurrent-init.db");
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_runalith-control"));
    let mut starters = Vec::new();

    for _ in 0..8 {
        let mut initialize = Command::new(&binary);
        initialize
            .arg("init-db")
            .env("RUNALITH_CONTROL_DATABASE_PATH", &database)
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        starters.push(initialize.spawn().unwrap());
    }

    let mut successful_initializers = 0;
    let mut rejected_initializers = 0;
    for starter in starters {
        let output = starter.wait_with_output().unwrap();
        if output.status.success() {
            successful_initializers += 1;
        } else {
            rejected_initializers += 1;
            let diagnostic = String::from_utf8_lossy(&output.stderr);
            assert!(
                diagnostic.contains("already exists")
                    || diagnostic.contains("refusing to replace an existing database file"),
                "concurrent initializer failed for an unexpected reason: {diagnostic}"
            );
        }
    }

    assert_eq!(successful_initializers, 1);
    assert_eq!(rejected_initializers, 7);
    let metadata = fs::symlink_metadata(&database).unwrap();
    assert!(metadata.is_file());
    assert!(!metadata.file_type().is_symlink());
    assert_eq!(metadata.permissions().mode() & 0o777, 0o600);

    let mut health = Command::new(&binary);
    health
        .arg("health")
        .env("RUNALITH_CONTROL_DATABASE_PATH", &database);
    let health = health.output().unwrap();
    assert!(
        health.status.success(),
        "{}",
        String::from_utf8_lossy(&health.stderr)
    );
    let snapshot: Value = serde_json::from_slice(&health.stdout).unwrap();
    assert_eq!(snapshot["status"], "DATABASE_HEALTHY");
    assert_eq!(snapshot["store"]["quick_check"], "ok");
}

#[test]
fn standalone_migration_preserves_verified_pre_migration_backup() {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let database = directory.path().join("legacy-control.db");
    let backup = directory.path().join("legacy-control-before-migration.db");
    let pid = directory.path().join("control.pid");
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_runalith-control"));

    let mut initialize = Command::new(&binary);
    initialize
        .arg("init-db")
        .env("RUNALITH_CONTROL_DATABASE_PATH", &database);
    assert!(initialize.output().unwrap().status.success());

    let legacy = Connection::open(&database).unwrap();
    legacy
        .execute_batch(
            "DROP TRIGGER workflow_cancellation_request_append_only;
             ALTER TABLE workflows DROP COLUMN cancellation_requested_at;
             DROP TRIGGER workflow_state_transition_guard;
             CREATE TRIGGER workflow_state_transition_guard
             BEFORE UPDATE OF state ON workflows
             WHEN NOT (
               (OLD.state='PROPOSED' AND NEW.state IN ('APPROVED','CANCELLED')) OR
               (OLD.state='APPROVED' AND NEW.state IN ('EXECUTING','CANCELLED')) OR
               (OLD.state='EXECUTING' AND NEW.state IN ('COMPLETED','FAILED','CANCELLED'))
             )
             BEGIN SELECT RAISE(ABORT,'invalid workflow state transition'); END;
             DROP TRIGGER worker_execution_fences_no_delete;
             DROP TRIGGER worker_execution_fences_update_guard;
             DROP TRIGGER worker_execution_fences_insert_guard;
             DROP INDEX worker_execution_fences_attempt;
             DROP TABLE worker_execution_fences;
             DROP TRIGGER task_lease_renewals_no_delete;
             DROP TRIGGER task_lease_renewals_no_update;
             DROP TRIGGER task_lease_renewals_insert_guard;
             DROP INDEX task_lease_renewals_attempt;
             DROP TABLE task_lease_renewals;
             DROP TRIGGER task_lease_fence_guard;
             CREATE TRIGGER task_lease_fence_guard
             BEFORE UPDATE OF attempts,lease_id,lease_owner,lease_expires_at ON tasks
             WHEN NOT (
               (OLD.state='PENDING' AND NEW.state='RUNNING' AND NEW.attempts=OLD.attempts+1
                 AND NEW.lease_id IS NOT NULL AND NEW.lease_owner IS NOT NULL AND NEW.lease_expires_at IS NOT NULL) OR
               (OLD.state='RUNNING' AND NEW.state IN ('SUCCEEDED','FAILED','UNKNOWN')
                 AND NEW.attempts=OLD.attempts AND NEW.lease_id IS NULL
                 AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL)
             )
             BEGIN SELECT RAISE(ABORT,'task lease identity is fenced'); END;
             PRAGMA user_version=18;
             ALTER TABLE governance_decisions DROP COLUMN receipt_json;
             PRAGMA user_version=17;",
        )
        .unwrap();
    drop(legacy);

    let mut migration = Command::new(&binary);
    migration
        .arg("migrate-db")
        .arg(&backup)
        .env("RUNALITH_CONTROL_DATABASE_PATH", &database)
        .env("RUNALITH_CONTROL_PID_FILE", &pid);
    let migrated = migration.output().unwrap();
    assert!(
        migrated.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&migrated.stdout),
        String::from_utf8_lossy(&migrated.stderr)
    );

    let backup_db = Connection::open(&backup).unwrap();
    let backup_version: i64 = backup_db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(backup_version, 17);
    let backup_check: String = backup_db
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .unwrap();
    assert_eq!(backup_check, "ok");

    let migrated_db = Connection::open(&database).unwrap();
    let migrated_version: i64 = migrated_db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(migrated_version, 20);
}

#[test]
fn standalone_failed_migration_retains_backup_and_leaves_legacy_database_unchanged() {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let database = directory.path().join("legacy-cancel.db");
    let auth = directory.path().join("auth.json");
    let pid = directory.path().join("control.pid");
    let shutdown = directory.path().join("control.stop");
    let backup = directory.path().join("legacy-cancel-before-migration.db");
    let token = "legacy-cancel-migration-rollback-token";
    auth_file(&auth, token);
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_runalith-control"));

    let mut initialize = Command::new(&binary);
    initialize
        .arg("init-db")
        .env("RUNALITH_CONTROL_DATABASE_PATH", &database);
    let initialized = initialize.output().unwrap();
    assert!(initialized.status.success());

    let listen = available_loopback_address();
    let mut start = Command::new(&binary);
    start
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    env_config(&mut start, &database, &auth, &pid, &shutdown, listen);
    let mut child = ChildGuard(start.spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut ready = false;
    while Instant::now() < deadline {
        if child.0.try_wait().unwrap().is_some() {
            break;
        }
        if TcpStream::connect(listen).is_ok() {
            let (status, body) = http_request(listen, "GET", "/readyz", None, &Value::Null);
            if status == 200 && body["status"] == "ready" {
                ready = true;
                break;
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
    assert!(ready, "standalone Control did not become ready");

    let proposal = json!({
        "workflow_id":"job_legacy_cancel_without_event",
        "title":"Legacy cancellation migration rollback",
        "goal":"Preserve v19 data when cancellation provenance is missing",
        "tasks":[{
            "task_id":"task_one",
            "role":"researcher",
            "description":"Create a pre-migration proposal",
            "depends_on":[],
            "required_evidence":[],
            "inputs":{}
        }],
        "metadata":{}
    });
    let (created_status, created) =
        http_request(listen, "POST", "/v1/workflows", Some(token), &proposal);
    assert_eq!(created_status, 201, "{created}");

    let mut stop_command = Command::new(&binary);
    stop_command.arg("stop");
    env_config(&mut stop_command, &database, &auth, &pid, &shutdown, listen);
    let stopped = stop_command.output().unwrap();
    assert!(stopped.status.success());
    assert!(child.0.wait().unwrap().success());
    assert!(!pid.exists());

    // Simulate a schema-v19 deployment with a terminal cancellation projection
    // but no authoritative request event. The v20 migration must fail closed.
    let legacy = Connection::open(&database).unwrap();
    legacy
        .execute(
            "UPDATE workflows SET state='CANCELLED' WHERE workflow_id=?1",
            ["job_legacy_cancel_without_event"],
        )
        .unwrap();
    legacy
        .execute_batch(
            "DROP TRIGGER workflow_cancellation_request_append_only;
             ALTER TABLE workflows DROP COLUMN cancellation_requested_at;
             PRAGMA user_version=19;",
        )
        .unwrap();
    drop(legacy);

    let mut migration = Command::new(&binary);
    migration
        .arg("migrate-db")
        .arg(&backup)
        .env("RUNALITH_CONTROL_DATABASE_PATH", &database)
        .env("RUNALITH_CONTROL_PID_FILE", &pid);
    let failed = migration.output().unwrap();
    assert!(!failed.status.success(), "migration unexpectedly succeeded");
    let diagnostic = format!(
        "{}{}",
        String::from_utf8_lossy(&failed.stdout),
        String::from_utf8_lossy(&failed.stderr)
    );
    assert!(
        diagnostic.contains("no cancellation request event"),
        "{diagnostic}"
    );

    assert!(
        backup.exists(),
        "verified pre-migration backup was not retained"
    );
    assert!(!pid.exists(), "failed migration left a process marker");
    for path in [&database, &backup] {
        let connection = Connection::open(path).unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 19, "{}", path.display());
        let quick_check: String = connection
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(quick_check, "ok", "{}", path.display());
        let workflow_state: String = connection
            .query_row(
                "SELECT state FROM workflows WHERE workflow_id='job_legacy_cancel_without_event'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(workflow_state, "CANCELLED", "{}", path.display());
        let marker_column: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('workflows') WHERE name='cancellation_requested_at')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!marker_column, "{}", path.display());
        let cancellation_event: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM events WHERE workflow_id='job_legacy_cancel_without_event' AND event_type='workflow.cancel_requested')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!cancellation_event, "{}", path.display());
        let transition_guard: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='workflow_state_transition_guard')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(transition_guard, "{}", path.display());
    }
}

#[test]
fn standalone_restore_recovers_persisted_workflow_without_overwriting_database() {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let source_database = directory.path().join("source-control.db");
    let restored_database = directory.path().join("restored-control.db");
    let backup = directory.path().join("control-backup.db");
    let auth = directory.path().join("auth.json");
    let source_pid = directory.path().join("source-control.pid");
    let source_stop = directory.path().join("source-control.stop");
    let restored_pid = directory.path().join("restored-control.pid");
    let restored_stop = directory.path().join("restored-control.stop");
    let token = "restore-integration-test-long-random-token";
    let workflow_id = "job_standalone_restore_test";
    auth_file(&auth, token);
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_runalith-control"));

    let mut initialize = Command::new(&binary);
    initialize
        .arg("init-db")
        .env("RUNALITH_CONTROL_DATABASE_PATH", &source_database);
    let initialized = initialize.output().unwrap();
    assert!(
        initialized.status.success(),
        "{}",
        String::from_utf8_lossy(&initialized.stderr)
    );

    let source_listen = available_loopback_address();
    let mut source_start = Command::new(&binary);
    source_start
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    env_config(
        &mut source_start,
        &source_database,
        &auth,
        &source_pid,
        &source_stop,
        source_listen,
    );
    let mut source_process = ChildGuard(source_start.spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut source_ready = false;
    while Instant::now() < deadline {
        if source_process.0.try_wait().unwrap().is_some() {
            break;
        }
        if TcpStream::connect(source_listen).is_ok() {
            let (status, body) = http_request(source_listen, "GET", "/readyz", None, &Value::Null);
            if status == 200 && body["status"] == "ready" {
                source_ready = true;
                break;
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
    assert!(source_ready, "source Control process did not become ready");

    let proposal = json!({
        "workflow_id":workflow_id,
        "title":"Restored workflow",
        "goal":"Prove cold restore preserves persisted Control state",
        "tasks":[{
            "task_id":"restore_task",
            "role":"reviewer",
            "description":"Persist before snapshot",
            "depends_on":[],
            "required_evidence":[],
            "inputs":{}
        }],
        "metadata":{}
    });
    let (status, created) = http_request(
        source_listen,
        "POST",
        "/v1/workflows",
        Some(token),
        &proposal,
    );
    assert_eq!(status, 201, "{created}");

    let mut source_stop_command = Command::new(&binary);
    source_stop_command.arg("stop");
    env_config(
        &mut source_stop_command,
        &source_database,
        &auth,
        &source_pid,
        &source_stop,
        source_listen,
    );
    let stopped = source_stop_command.output().unwrap();
    assert!(
        stopped.status.success(),
        "{}",
        String::from_utf8_lossy(&stopped.stderr)
    );
    assert!(source_process.0.wait().unwrap().success());
    assert!(!source_pid.exists());

    let snapshot = Connection::open(&source_database).unwrap();
    snapshot
        .execute("VACUUM INTO ?1", [backup.to_str().unwrap()])
        .unwrap();
    drop(snapshot);
    fs::set_permissions(&backup, fs::Permissions::from_mode(0o600)).unwrap();

    let invalid_backup = directory.path().join("invalid-control-backup.db");
    let invalid_backup_bytes = b"not a SQLite database";
    fs::write(&invalid_backup, invalid_backup_bytes).unwrap();
    fs::set_permissions(&invalid_backup, fs::Permissions::from_mode(0o600)).unwrap();
    let failed_restore_database = directory.path().join("failed-restore-control.db");
    let mut failed_restore = Command::new(&binary);
    failed_restore
        .arg("restore-db")
        .arg(&invalid_backup)
        .env("RUNALITH_CONTROL_DATABASE_PATH", &failed_restore_database)
        .env(
            "RUNALITH_CONTROL_PID_FILE",
            directory.path().join("failed-restore-control.pid"),
        );
    let failed_restore_result = failed_restore.output().unwrap();
    assert!(
        !failed_restore_result.status.success(),
        "invalid restore snapshot must fail closed"
    );
    assert!(!failed_restore_database.exists());
    assert_eq!(fs::read(&invalid_backup).unwrap(), invalid_backup_bytes);

    let mut restore = Command::new(&binary);
    restore
        .arg("restore-db")
        .arg(&backup)
        .env("RUNALITH_CONTROL_DATABASE_PATH", &restored_database)
        .env("RUNALITH_CONTROL_PID_FILE", &restored_pid);
    let restored = restore.output().unwrap();
    assert!(
        restored.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&restored.stdout),
        String::from_utf8_lossy(&restored.stderr)
    );
    let restore_body: Value = serde_json::from_slice(&restored.stdout).unwrap();
    assert_eq!(restore_body["status"], "RESTORED");
    assert_eq!(restore_body["backup_preserved"], true);
    assert!(restored_database.exists());
    assert!(backup.exists());

    let before_conflict = fs::read(&restored_database).unwrap();
    let mut conflicting_restore = Command::new(&binary);
    conflicting_restore
        .arg("restore-db")
        .arg(&backup)
        .env("RUNALITH_CONTROL_DATABASE_PATH", &restored_database)
        .env("RUNALITH_CONTROL_PID_FILE", &restored_pid);
    let conflict = conflicting_restore.output().unwrap();
    assert!(
        !conflict.status.success(),
        "restore must never overwrite an existing database"
    );
    assert_eq!(fs::read(&restored_database).unwrap(), before_conflict);

    let mut health = Command::new(&binary);
    health
        .arg("health")
        .env("RUNALITH_CONTROL_DATABASE_PATH", &restored_database);
    let healthy = health.output().unwrap();
    assert!(
        healthy.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&healthy.stdout),
        String::from_utf8_lossy(&healthy.stderr)
    );
    let health_body: Value = serde_json::from_slice(&healthy.stdout).unwrap();
    assert_eq!(
        restore_body["schema_version"],
        health_body["store"]["schema_version"]
    );

    let restored_listen = available_loopback_address();
    let mut restored_start = Command::new(&binary);
    restored_start
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    env_config(
        &mut restored_start,
        &restored_database,
        &auth,
        &restored_pid,
        &restored_stop,
        restored_listen,
    );
    let mut restored_process = ChildGuard(restored_start.spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut restored_ready = false;
    while Instant::now() < deadline {
        if restored_process.0.try_wait().unwrap().is_some() {
            break;
        }
        if TcpStream::connect(restored_listen).is_ok() {
            let (status, body) =
                http_request(restored_listen, "GET", "/readyz", None, &Value::Null);
            if status == 200 && body["status"] == "ready" {
                restored_ready = true;
                break;
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
    assert!(
        restored_ready,
        "restored Control process did not become ready"
    );
    let workflow_path = format!("/v1/workflows/{workflow_id}");
    let (status, persisted) = http_request(
        restored_listen,
        "GET",
        &workflow_path,
        Some(token),
        &Value::Null,
    );
    assert_eq!(status, 200, "{persisted}");
    assert_eq!(persisted["proposal"]["workflow_id"], workflow_id);
    assert_eq!(
        persisted["tasks"][0]["definition"]["task_id"],
        "restore_task"
    );

    let mut stop_restored = Command::new(&binary);
    stop_restored.arg("stop");
    env_config(
        &mut stop_restored,
        &restored_database,
        &auth,
        &restored_pid,
        &restored_stop,
        restored_listen,
    );
    let stopped = stop_restored.output().unwrap();
    assert!(
        stopped.status.success(),
        "{}",
        String::from_utf8_lossy(&stopped.stderr)
    );
    assert!(restored_process.0.wait().unwrap().success());
    assert!(!restored_pid.exists());
}

#[test]
fn standalone_host_denies_cancellation_without_execution_settlement_authority() {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let database = directory.path().join("cancel-control.db");
    let auth = directory.path().join("cancel-auth.json");
    let pid = directory.path().join("cancel-control.pid");
    let stop = directory.path().join("cancel-control.stop");
    let token = "cancellation-deny-all-integration-token";
    auth_file(&auth, token);
    let mut document: Value = serde_json::from_slice(&fs::read(&auth).unwrap()).unwrap();
    let capabilities = document["principals"][0]["capabilities"]
        .as_array_mut()
        .unwrap();
    capabilities.push(json!("workflow.cancel"));
    fs::write(&auth, serde_json::to_vec(&document).unwrap()).unwrap();
    fs::set_permissions(&auth, fs::Permissions::from_mode(0o600)).unwrap();

    let binary = PathBuf::from(env!("CARGO_BIN_EXE_runalith-control"));
    let mut initialize = Command::new(&binary);
    initialize
        .arg("init-db")
        .env("RUNALITH_CONTROL_DATABASE_PATH", &database);
    let initialized = initialize.output().unwrap();
    assert!(initialized.status.success());

    let listen = available_loopback_address();
    let mut start = Command::new(&binary);
    start
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    env_config(&mut start, &database, &auth, &pid, &stop, listen);
    let mut child = ChildGuard(start.spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut ready = false;
    while Instant::now() < deadline {
        if child.0.try_wait().unwrap().is_some() {
            break;
        }
        if TcpStream::connect(listen).is_ok() {
            let (status, body) = http_request(listen, "GET", "/readyz", None, &Value::Null);
            if status == 200 && body["status"] == "ready" {
                ready = true;
                break;
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
    assert!(ready, "standalone Control process did not become ready");

    let proposal = json!({
        "workflow_id":"job_cancel_authority_unavailable",
        "title":"Cancellation authority test",
        "goal":"Prove a transport capability is not process-stop authority",
        "tasks":[{
            "task_id":"task_one",
            "role":"researcher",
            "description":"Keep cancellation request unprocessed",
            "depends_on":[],
            "required_evidence":[],
            "inputs":{}
        }],
        "metadata":{}
    });
    let (created_status, created) =
        http_request(listen, "POST", "/v1/workflows", Some(token), &proposal);
    assert_eq!(created_status, 201, "{created}");

    let (cancel_status, cancel_body) = http_request(
        listen,
        "POST",
        "/v1/workflows/job_cancel_authority_unavailable/cancel",
        Some(token),
        &json!({"reason":"operator requested cancellation"}),
    );
    assert_eq!(cancel_status, 503, "{cancel_body}");
    assert!(
        cancel_body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("authority")
    );

    let (read_status, persisted) = http_request(
        listen,
        "GET",
        "/v1/workflows/job_cancel_authority_unavailable",
        Some(token),
        &Value::Null,
    );
    assert_eq!(read_status, 200, "{persisted}");
    assert_eq!(persisted["state"], "PROPOSED");
    assert!(persisted.get("cancellation_request").is_none());

    let events_path = "/v1/workflows/job_cancel_authority_unavailable/events";
    let (events_status, events) =
        http_request(listen, "GET", events_path, Some(token), &Value::Null);
    assert_eq!(events_status, 200, "{events}");
    assert!(
        !events["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["event_type"] == "workflow.cancel_requested")
    );

    let mut stop_command = Command::new(&binary);
    stop_command.arg("stop");
    env_config(&mut stop_command, &database, &auth, &pid, &stop, listen);
    let stopped = stop_command.output().unwrap();
    assert!(
        stopped.status.success(),
        "{}",
        String::from_utf8_lossy(&stopped.stderr)
    );
    assert!(child.0.wait().unwrap().success());
    assert!(!pid.exists());
}
