//! Read-only operational CLI integration tests using disposable local databases.

use std::process::Command;

use runalith_mcp::registered_tool_count;
use runalith_runtime::Store;

#[test]
fn version_reports_current_store_schema_and_registered_tool_count() {
    let output = Command::new(env!("CARGO_BIN_EXE_runalith-mcp"))
        .arg("version")
        .output()
        .unwrap();
    assert!(output.status.success());
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["runtime"], "rust");
    assert_eq!(
        response["store_schema_version"],
        Store::CURRENT_SCHEMA_VERSION
    );
    assert_eq!(response["mcp_tools"], registered_tool_count());
}

#[test]
fn health_cli_reads_existing_database_without_migration_or_write() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("workflow-rust.db");
    drop(Store::create_new(&database).unwrap());
    let before = std::fs::metadata(&database).unwrap().modified().unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_runalith-mcp"))
        .arg("health")
        .env("RUNALITH_RUST_DATA_DIR", directory.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["status"], "DATABASE_HEALTHY");
    assert_eq!(response["store"]["read_only"], true);
    assert_eq!(
        response["store"]["schema_version"],
        Store::CURRENT_SCHEMA_VERSION
    );
    assert_eq!(response["store"]["custom_role_trusted_skill_pins"], 0);
    assert_eq!(response["store"]["governance_decisions"], 0);
    assert_eq!(response["store"]["governance_decision_events"], 0);
    assert_eq!(response["store"]["agent_sessions"], 0);
    assert_eq!(response["store"]["session_access_grants"], 0);
    assert_eq!(response["store"]["session_messages"], 0);
    assert_eq!(response["store"]["custom_role_versions"], 0);
    assert_eq!(response["store"]["custom_workflow_versions"], 0);
    assert_eq!(response["store"]["custom_workflow_plans"], 0);
    assert_eq!(response["store"]["control_catalog_events"], 0);
    assert_eq!(response["event_chain"], "NOT_CHECKED");
    assert_eq!(response["runtime_sessions"], "NOT_CHECKED");
    assert_eq!(response["provider_lifecycle"], "NOT_CONNECTED");
    assert_eq!(response["production_authority"], "NOT_ESTABLISHED");
    assert_eq!(
        std::fs::metadata(&database).unwrap().modified().unwrap(),
        before
    );
}

#[test]
fn health_cli_does_not_create_missing_database() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("workflow-rust.db");
    let output = Command::new(env!("CARGO_BIN_EXE_runalith-mcp"))
        .arg("health")
        .env("RUNALITH_RUST_DATA_DIR", directory.path())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["status"], "NOT_INITIALIZED");
    assert_eq!(response["database_created"], false);
    assert_eq!(response["migrations_run"], false);
    assert!(!database.exists());
}

#[test]
fn health_cli_reports_invalid_sandbox_configuration_without_opening_database() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("workflow-rust.db");
    let output = Command::new(env!("CARGO_BIN_EXE_runalith-mcp"))
        .arg("health")
        .env("RUNALITH_RUST_DATA_DIR", directory.path())
        .env("RUNALITH_ENABLE_SANDBOX_EXECUTION", "true")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["status"], "CONFIGURATION_INVALID");
    assert_eq!(response["database_opened"], false);
    assert_eq!(response["database_mutated"], false);
    assert!(!database.exists());
}

#[test]
fn invalid_sandbox_configuration_blocks_startup_before_data_directory_creation() {
    let directory = tempfile::tempdir().unwrap();
    let data_dir = directory.path().join("not-created");
    let output = Command::new(env!("CARGO_BIN_EXE_runalith-mcp"))
        .env("RUNALITH_RUST_DATA_DIR", &data_dir)
        .env("RUNALITH_ENABLE_SANDBOX_EXECUTION", "true")
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("RUNALITH_ENABLE_SANDBOX_EXECUTION must be 0 or 1")
    );
    assert!(!data_dir.exists());
}
