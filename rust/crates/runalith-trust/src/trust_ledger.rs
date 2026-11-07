//! Legacy standalone append-only trust-configuration high-water ledger.
//!
//! `TrustLedger` remains available for compatibility and isolated tests. It is
//! not a D-01 production persistence adapter. Production approval must use a
//! `TrustConfigurationObserver` whose transaction-aware method reads the
//! workflow Store connection; `runalith-store::Store` implements that path.
//! Only an explicit administrator observation advances trust configuration.

use std::path::Path;
use std::sync::Mutex;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::Serialize;
use uuid::Uuid;

use crate::TrustError;
use crate::trust_config::TrustConfiguration;

const TRUST_LEDGER_SCHEMA_VERSION: i64 = 1;

const TRUST_LEDGER_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS adaptive_goal_trust_configuration_history (
  domain TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  configuration_fingerprint TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  config_updated_at TEXT,
  config_updated_by TEXT NOT NULL,
  config_change_reference TEXT NOT NULL,
  configuration_source TEXT NOT NULL,
  root_manifest_json TEXT NOT NULL DEFAULT '[]',
  observed_at TEXT NOT NULL,
  PRIMARY KEY(domain, config_version)
);
CREATE INDEX IF NOT EXISTS adaptive_goal_trust_configuration_latest
  ON adaptive_goal_trust_configuration_history(domain, config_version DESC);
CREATE TRIGGER IF NOT EXISTS adaptive_goal_trust_configuration_no_update
  BEFORE UPDATE ON adaptive_goal_trust_configuration_history BEGIN
    SELECT RAISE(ABORT, 'trust configuration history is append-only');
  END;
CREATE TRIGGER IF NOT EXISTS adaptive_goal_trust_configuration_no_delete
  BEFORE DELETE ON adaptive_goal_trust_configuration_history BEGIN
    SELECT RAISE(ABORT, 'trust configuration history is append-only');
  END;
CREATE TABLE IF NOT EXISTS adaptive_goal_trust_configuration_events (
  event_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  event_type TEXT NOT NULL,
  attempted_config_version INTEGER,
  configuration_fingerprint TEXT,
  provider_id TEXT,
  config_change_reference TEXT,
  reason_code TEXT NOT NULL,
  reason_message TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS adaptive_goal_trust_configuration_events_no_update
  BEFORE UPDATE ON adaptive_goal_trust_configuration_events BEGIN
    SELECT RAISE(ABORT, 'trust configuration events are append-only');
  END;
CREATE TRIGGER IF NOT EXISTS adaptive_goal_trust_configuration_events_no_delete
  BEFORE DELETE ON adaptive_goal_trust_configuration_events BEGIN
    SELECT RAISE(ABORT, 'trust configuration events are append-only');
  END;
"#;

/// Latest immutable trust configuration observation for one domain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustHistoryEntry {
    /// Domain identifier.
    pub domain: String,
    /// Observed monotonic configuration version.
    pub config_version: u64,
    /// Canonical configuration fingerprint.
    pub configuration_fingerprint: String,
    /// Independently administered provider ID.
    pub provider_id: String,
    /// Administrator update timestamp.
    pub config_updated_at: Option<String>,
    /// Administrator identity.
    pub config_updated_by: String,
    /// Change-control reference.
    pub config_change_reference: String,
    /// Configuration source.
    pub configuration_source: String,
    /// Observation timestamp.
    pub observed_at: String,
}

/// Result of read-only high-water inspection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustHistoryStatus {
    /// No configuration has been explicitly observed.
    NotYetObserved,
    /// Current configuration is equal to or one step ahead of the ledger.
    CurrentOrForward,
    /// Current configuration version is lower than observed high-water.
    RollbackDetected,
    /// Current configuration skipped an unobserved version.
    VersionGapDetected,
    /// Same version was reused with different canonical identity.
    VersionReused,
    /// Administrator update timestamp moved backwards.
    TimeRollbackDetected,
    /// Ledger could not be inspected.
    Unavailable,
    /// Supplied current configuration is malformed or absent.
    CurrentConfigurationInvalid,
}

/// Read-only result of inspecting a domain's latest trust observation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustHistoryInspection {
    /// High-water status.
    pub status: TrustHistoryStatus,
    /// Latest append-only observation, if present.
    pub latest: Option<TrustHistoryEntry>,
    /// Stable rejection code when inspection is unavailable or unsafe.
    pub code: Option<&'static str>,
}

/// Result of an explicit administrator trust-config observation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustObservationResult {
    /// Whether a new history row was inserted.
    pub recorded: bool,
    /// Whether the exact current version/fingerprint was already observed.
    pub idempotent: bool,
    /// Domain identifier.
    pub domain: String,
    /// Observed config version.
    pub config_version: u64,
    /// Observed configuration fingerprint.
    pub configuration_fingerprint: String,
}

/// Dedicated SQLite connection for administrator trust-config observations.
///
/// It must never be the workflow connection or an active workflow transaction.
pub struct TrustLedger {
    connection: Mutex<Connection>,
}

/// Read-only trust high-water lookup. Implementations used during approval
/// must read through the caller's workflow transaction to satisfy D-01.
pub trait TrustConfigurationObserver: Send + Sync {
    /// Assert that exact current trust configuration was explicitly observed.
    fn assert_observed(&self, configuration: &TrustConfiguration) -> Result<(), TrustError>;

    /// Transaction-aware variant. The default is retained for legacy ledger
    /// adapters; D-01 Store adapters must override it and read `transaction`.
    fn assert_observed_in_transaction(
        &self,
        _transaction: &Transaction<'_>,
        configuration: &TrustConfiguration,
    ) -> Result<(), TrustError> {
        self.assert_observed(configuration)
    }
}

impl TrustConfigurationObserver for TrustLedger {
    fn assert_observed(&self, configuration: &TrustConfiguration) -> Result<(), TrustError> {
        TrustLedger::assert_observed(self, configuration).map(|_| ())
    }
}

impl TrustLedger {
    /// Open a dedicated trust ledger. Existing databases are accepted only when
    /// already at this exact schema version; no startup migration is attempted.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, TrustError> {
        let connection = Connection::open(path)?;
        initialize_new_schema(connection)
    }

    /// Create an isolated in-memory ledger for tests.
    pub fn in_memory() -> Result<Self, TrustError> {
        initialize_new_schema(Connection::open_in_memory()?)
    }

    /// Explicit administrator observation. This is the only API that advances
    /// trust configuration high-water; approval and dispatch must call
    /// assert_observed instead.
    pub fn record(
        &self,
        configuration: &TrustConfiguration,
        now_ms: i64,
    ) -> Result<TrustObservationResult, TrustError> {
        configuration.validate_integrity()?;
        validate_record_input(configuration, now_ms)?;
        let mut connection = self.lock()?;
        let result = record_inner(&mut connection, configuration, now_ms);
        if let Err(error) = &result {
            if should_audit_rejection(error) {
                append_rejection_event(&connection, configuration, error, now_ms);
            }
        }
        result
    }

    /// Inspect the high-water state without writing.
    pub fn inspect(
        &self,
        domain: &str,
        configuration: Option<&TrustConfiguration>,
    ) -> TrustHistoryInspection {
        let connection = match self.connection.lock() {
            Ok(connection) => connection,
            Err(_) => {
                return TrustHistoryInspection {
                    status: TrustHistoryStatus::Unavailable,
                    latest: None,
                    code: Some("AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE"),
                };
            }
        };
        let latest = match load_latest(&connection, domain) {
            Ok(latest) => latest,
            Err(_) => {
                return TrustHistoryInspection {
                    status: TrustHistoryStatus::Unavailable,
                    latest: None,
                    code: Some("AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE"),
                };
            }
        };
        let Some(configuration) = configuration else {
            return TrustHistoryInspection {
                status: TrustHistoryStatus::CurrentConfigurationInvalid,
                latest,
                code: None,
            };
        };
        if configuration.validate_integrity().is_err() {
            return TrustHistoryInspection {
                status: TrustHistoryStatus::CurrentConfigurationInvalid,
                latest,
                code: Some("AGG_TRUST_CONFIG_SCHEMA_INVALID"),
            };
        }
        let Some(latest_entry) = latest.as_ref() else {
            return TrustHistoryInspection {
                status: TrustHistoryStatus::NotYetObserved,
                latest,
                code: None,
            };
        };
        let (status, code) = if configuration.config_version < latest_entry.config_version {
            (
                TrustHistoryStatus::RollbackDetected,
                Some("AGG_TRUST_CONFIG_ROLLBACK"),
            )
        } else if configuration.config_version > latest_entry.config_version.saturating_add(1) {
            (
                TrustHistoryStatus::VersionGapDetected,
                Some("AGG_TRUST_CONFIG_VERSION_GAP"),
            )
        } else if configuration.config_version == latest_entry.config_version
            && (configuration.configuration_fingerprint != latest_entry.configuration_fingerprint
                || configuration.provider_id != latest_entry.provider_id)
        {
            (
                TrustHistoryStatus::VersionReused,
                Some("AGG_TRUST_CONFIG_VERSION_REUSED"),
            )
        } else if configuration.config_version > latest_entry.config_version
            && latest_entry
                .config_updated_at
                .as_ref()
                .is_some_and(|latest_updated| {
                    configuration.config_updated_at.as_str() < latest_updated.as_str()
                })
        {
            (
                TrustHistoryStatus::TimeRollbackDetected,
                Some("AGG_TRUST_CONFIG_TIME_ROLLBACK"),
            )
        } else {
            (TrustHistoryStatus::CurrentOrForward, None)
        };
        TrustHistoryInspection {
            status,
            latest,
            code,
        }
    }

    /// Require the exact current version, fingerprint and provider to have
    /// already been explicitly observed. Read-only; never advances high-water.
    pub fn assert_observed(
        &self,
        configuration: &TrustConfiguration,
    ) -> Result<TrustHistoryInspection, TrustError> {
        let inspection = self.inspect(&configuration.domain, Some(configuration));
        if let Some(code) = inspection.code {
            return Err(rejected(
                code,
                format!(
                    "trust configuration {} failed anti-rollback inspection",
                    configuration.domain
                ),
            ));
        }
        match inspection.status {
            TrustHistoryStatus::RollbackDetected
            | TrustHistoryStatus::VersionGapDetected
            | TrustHistoryStatus::VersionReused
            | TrustHistoryStatus::TimeRollbackDetected => {
                let code = match inspection.status {
                    TrustHistoryStatus::RollbackDetected => "AGG_TRUST_CONFIG_ROLLBACK",
                    TrustHistoryStatus::VersionGapDetected => "AGG_TRUST_CONFIG_VERSION_GAP",
                    TrustHistoryStatus::VersionReused => "AGG_TRUST_CONFIG_VERSION_REUSED",
                    TrustHistoryStatus::TimeRollbackDetected => "AGG_TRUST_CONFIG_TIME_ROLLBACK",
                    _ => unreachable!(),
                };
                Err(rejected(
                    code,
                    format!(
                        "trust configuration {} failed anti-rollback inspection",
                        configuration.domain
                    ),
                ))
            }
            TrustHistoryStatus::Unavailable => Err(rejected(
                "AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE",
                "trust configuration ledger is unavailable",
            )),
            TrustHistoryStatus::NotYetObserved
            | TrustHistoryStatus::CurrentConfigurationInvalid => Err(rejected(
                "AGG_TRUST_CONFIG_NOT_OBSERVED",
                format!(
                    "administrator must explicitly observe trust configuration {} before approval",
                    configuration.domain
                ),
            )),
            TrustHistoryStatus::CurrentOrForward => {
                let latest = inspection
                    .latest
                    .as_ref()
                    .expect("current-or-forward has latest");
                if latest.config_version != configuration.config_version
                    || latest.configuration_fingerprint != configuration.configuration_fingerprint
                    || latest.provider_id != configuration.provider_id
                {
                    return Err(rejected(
                        "AGG_TRUST_CONFIG_NOT_OBSERVED",
                        format!(
                            "administrator must explicitly observe exact trust configuration {} before approval",
                            configuration.domain
                        ),
                    ));
                }
                Ok(inspection)
            }
        }
    }

    /// Count history rows, intended for tests and status diagnostics.
    pub fn history_count(&self, domain: &str) -> Result<u64, TrustError> {
        let connection = self.lock()?;
        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM adaptive_goal_trust_configuration_history WHERE domain=?1",
            params![domain],
            |row| row.get(0),
        )?;
        Ok(count as u64)
    }

    /// Count rejection audit events, intended for tests and status diagnostics.
    pub fn event_count(&self, domain: &str) -> Result<u64, TrustError> {
        let connection = self.lock()?;
        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM adaptive_goal_trust_configuration_events WHERE domain=?1",
            params![domain],
            |row| row.get(0),
        )?;
        Ok(count as u64)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, TrustError> {
        self.connection.lock().map_err(|_| {
            rejected(
                "AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE",
                "trust configuration ledger lock is poisoned",
            )
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RootManifest<'a> {
    key_id: &'a str,
    trust_root_sha256: &'a str,
    scope: &'a str,
    not_before: &'a str,
    not_after: Option<&'a str>,
    revoked_at: Option<&'a str>,
}

fn initialize_new_schema(connection: Connection) -> Result<TrustLedger, TrustError> {
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version == 0 {
        let existing_tables: i64 = connection.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get(0),
        )?;
        if existing_tables != 0 {
            return Err(rejected(
                "AGG_TRUST_CONFIG_LEDGER_SCHEMA_UNSUPPORTED",
                "existing trust database has no recognized Rust schema version; no migration attempted",
            ));
        }
        connection.execute_batch(TRUST_LEDGER_SCHEMA)?;
        connection.execute_batch(&format!(
            "PRAGMA user_version={TRUST_LEDGER_SCHEMA_VERSION};"
        ))?;
    } else if version == TRUST_LEDGER_SCHEMA_VERSION {
        let required_tables: i64 = connection.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN
             ('adaptive_goal_trust_configuration_history','adaptive_goal_trust_configuration_events')",
            [],
            |row| row.get(0),
        )?;
        let required_triggers: i64 = connection.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN
             ('adaptive_goal_trust_configuration_no_update',
              'adaptive_goal_trust_configuration_no_delete',
              'adaptive_goal_trust_configuration_events_no_update',
              'adaptive_goal_trust_configuration_events_no_delete')",
            [],
            |row| row.get(0),
        )?;
        if required_tables != 2 || required_triggers != 4 {
            return Err(rejected(
                "AGG_TRUST_CONFIG_LEDGER_SCHEMA_UNSUPPORTED",
                "trust ledger schema version is set but required tables or append-only triggers are missing",
            ));
        }
    } else {
        return Err(rejected(
            "AGG_TRUST_CONFIG_LEDGER_SCHEMA_UNSUPPORTED",
            format!(
                "trust ledger schema version {version} is unsupported; expected {TRUST_LEDGER_SCHEMA_VERSION}"
            ),
        ));
    }
    Ok(TrustLedger {
        connection: Mutex::new(connection),
    })
}

fn validate_record_input(
    configuration: &TrustConfiguration,
    now_ms: i64,
) -> Result<(), TrustError> {
    if configuration.domain.trim().is_empty()
        || configuration.config_version == 0
        || configuration.config_version > 9_007_199_254_740_991
        || !is_sha256(&configuration.configuration_fingerprint)
        || configuration.provider_id.trim().is_empty()
    {
        return Err(rejected(
            "AGG_TRUST_CONFIG_LEDGER_INVALID_INPUT",
            "refusing malformed trust configuration metadata",
        ));
    }
    if now_ms < 0 || now_ms as u64 > 9_007_199_254_740_991 {
        return Err(rejected(
            "AGG_TRUST_CONFIG_LEDGER_INVALID_INPUT",
            "observation time must be a non-negative safe integer",
        ));
    }
    Ok(())
}

fn record_inner(
    connection: &mut Connection,
    configuration: &TrustConfiguration,
    now_ms: i64,
) -> Result<TrustObservationResult, TrustError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let latest = load_latest_tx(&transaction, &configuration.domain)?;
    if let Some(latest) = latest {
        if configuration.config_version < latest.config_version {
            return Err(rejected(
                "AGG_TRUST_CONFIG_ROLLBACK",
                format!(
                    "trust domain {} attempted rollback from config version {} to {}",
                    configuration.domain, latest.config_version, configuration.config_version
                ),
            ));
        }
        if configuration.config_version > latest.config_version.saturating_add(1) {
            return Err(rejected(
                "AGG_TRUST_CONFIG_VERSION_GAP",
                format!(
                    "trust domain {} must advance from config version {} to {}; received {}",
                    configuration.domain,
                    latest.config_version,
                    latest.config_version.saturating_add(1),
                    configuration.config_version
                ),
            ));
        }
        if configuration.config_version == latest.config_version {
            if configuration.configuration_fingerprint != latest.configuration_fingerprint
                || configuration.provider_id != latest.provider_id
            {
                return Err(rejected(
                    "AGG_TRUST_CONFIG_VERSION_REUSED",
                    format!(
                        "trust domain {} reused config version {} with different canonical metadata or roots",
                        configuration.domain, configuration.config_version
                    ),
                ));
            }
            transaction.commit()?;
            return Ok(TrustObservationResult {
                recorded: false,
                idempotent: true,
                domain: configuration.domain.clone(),
                config_version: configuration.config_version,
                configuration_fingerprint: configuration.configuration_fingerprint.clone(),
            });
        }
        if latest
            .config_updated_at
            .as_ref()
            .is_some_and(|latest_updated| {
                configuration.config_updated_at.as_str() < latest_updated.as_str()
            })
        {
            return Err(rejected(
                "AGG_TRUST_CONFIG_TIME_ROLLBACK",
                format!(
                    "trust domain {} config_updated_at moved backwards while config_version increased",
                    configuration.domain
                ),
            ));
        }
    }

    let root_manifest = root_manifest_json(configuration)?;
    let observed_at = iso_timestamp(now_ms)?;
    transaction.execute(
        "INSERT INTO adaptive_goal_trust_configuration_history
         (domain,config_version,configuration_fingerprint,provider_id,config_updated_at,
          config_updated_by,config_change_reference,configuration_source,root_manifest_json,observed_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![
            configuration.domain,
            configuration.config_version as i64,
            configuration.configuration_fingerprint,
            configuration.provider_id,
            configuration.config_updated_at,
            configuration.config_updated_by,
            configuration.config_change_reference,
            configuration.configuration_source,
            root_manifest,
            observed_at
        ],
    )?;
    transaction.commit()?;
    Ok(TrustObservationResult {
        recorded: true,
        idempotent: false,
        domain: configuration.domain.clone(),
        config_version: configuration.config_version,
        configuration_fingerprint: configuration.configuration_fingerprint.clone(),
    })
}

fn load_latest(
    connection: &Connection,
    domain: &str,
) -> Result<Option<TrustHistoryEntry>, TrustError> {
    connection
        .query_row(
            "SELECT domain,config_version,configuration_fingerprint,provider_id,config_updated_at,
                    config_updated_by,config_change_reference,configuration_source,observed_at
             FROM adaptive_goal_trust_configuration_history
             WHERE domain=?1 ORDER BY config_version DESC LIMIT 1",
            params![domain],
            row_to_entry,
        )
        .optional()
        .map_err(TrustError::from)
}

fn load_latest_tx(
    transaction: &Transaction<'_>,
    domain: &str,
) -> Result<Option<TrustHistoryEntry>, TrustError> {
    transaction
        .query_row(
            "SELECT domain,config_version,configuration_fingerprint,provider_id,config_updated_at,
                    config_updated_by,config_change_reference,configuration_source,observed_at
             FROM adaptive_goal_trust_configuration_history
             WHERE domain=?1 ORDER BY config_version DESC LIMIT 1",
            params![domain],
            row_to_entry,
        )
        .optional()
        .map_err(TrustError::from)
}

fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<TrustHistoryEntry> {
    let config_version: i64 = row.get(1)?;
    Ok(TrustHistoryEntry {
        domain: row.get(0)?,
        config_version: config_version.max(0) as u64,
        configuration_fingerprint: row.get(2)?,
        provider_id: row.get(3)?,
        config_updated_at: row.get(4)?,
        config_updated_by: row.get(5)?,
        config_change_reference: row.get(6)?,
        configuration_source: row.get(7)?,
        observed_at: row.get(8)?,
    })
}

fn root_manifest_json(configuration: &TrustConfiguration) -> Result<String, TrustError> {
    let roots: Vec<RootManifest<'_>> = configuration
        .roots
        .iter()
        .map(|root| RootManifest {
            key_id: &root.key_id,
            trust_root_sha256: &root.trust_root_sha256,
            scope: &root.scope,
            not_before: &root.not_before,
            not_after: root.not_after.as_deref(),
            revoked_at: root.revoked_at.as_deref(),
        })
        .collect();
    serde_json::to_string(&roots).map_err(|error| {
        rejected(
            "AGG_TRUST_CONFIG_LEDGER_INVALID_INPUT",
            format!("cannot serialize trust root manifest: {error}"),
        )
    })
}

fn append_rejection_event(
    connection: &Connection,
    configuration: &TrustConfiguration,
    error: &TrustError,
    now_ms: i64,
) {
    let code = error.code();
    if !code.starts_with("AGG_TRUST_CONFIG_")
        || matches!(
            code,
            "AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE" | "AGG_TRUST_CONFIG_LEDGER_INVALID_INPUT"
        )
    {
        return;
    }
    let Ok(observed_at) = iso_timestamp(now_ms) else {
        return;
    };
    let message: String = error.to_string().chars().take(1000).collect();
    let _ = connection.execute(
        "INSERT INTO adaptive_goal_trust_configuration_events
         (event_id,domain,event_type,attempted_config_version,configuration_fingerprint,
          provider_id,config_change_reference,reason_code,reason_message,observed_at)
         VALUES(?1,?2,'configuration_rejected',?3,?4,?5,?6,?7,?8,?9)",
        params![
            Uuid::new_v4().to_string(),
            configuration.domain,
            configuration.config_version as i64,
            configuration.configuration_fingerprint,
            configuration.provider_id,
            configuration.config_change_reference,
            code,
            message,
            observed_at
        ],
    );
}

fn should_audit_rejection(error: &TrustError) -> bool {
    error.code().starts_with("AGG_TRUST_CONFIG_")
}

fn iso_timestamp(now_ms: i64) -> Result<String, TrustError> {
    let timestamp = DateTime::<Utc>::from_timestamp_millis(now_ms).ok_or_else(|| {
        rejected(
            "AGG_TRUST_CONFIG_LEDGER_INVALID_INPUT",
            "observation timestamp is outside supported UTC range",
        )
    })?;
    Ok(timestamp.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn rejected(code: &'static str, message: impl Into<String>) -> TrustError {
    TrustError::rejected(code, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Ed25519PublicKey;
    use crate::trust_config::{
        TrustConfiguration, TrustedRoot, canonical_configuration_fingerprint,
    };
    use sha2::{Digest, Sha256};
    use std::fs;

    const NOW: i64 = 1_793_510_400_000;

    fn config(version: u64, fingerprint: &str, updated_at: &str) -> TrustConfiguration {
        let pem = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAPUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=\n-----END PUBLIC KEY-----\n";
        let public_key = Ed25519PublicKey::from_pem(pem).unwrap();
        let mut configuration = TrustConfiguration {
            domain: "execution_approval".into(),
            provider_id: "approval-provider".into(),
            scope: "agg.execution.approve".into(),
            config_version: version,
            config_updated_at: updated_at.into(),
            config_updated_by: "security-admin".into(),
            config_change_reference: format!("CHG-APPROVAL-{version}-{}", &fingerprint[..8]),
            configuration_fingerprint: String::new(),
            configuration_source: "admin_json_environment",
            roots: vec![TrustedRoot {
                key_id: "approval-root".into(),
                public_key: public_key.clone(),
                public_key_pem: pem.into(),
                trust_root_sha256: public_key.fingerprint().into(),
                legacy_pem_sha256: hex::encode(Sha256::digest(pem.as_bytes())),
                scope: "agg.execution.approve".into(),
                not_before_ms: 1_767_225_600_000,
                not_after_ms: None,
                revoked_at_ms: None,
                not_before: "2026-01-01T00:00:00.000Z".into(),
                not_after: None,
                revoked_at: None,
                usable_now: true,
            }],
            available: true,
        };
        configuration.configuration_fingerprint =
            canonical_configuration_fingerprint(&configuration).unwrap();
        configuration
    }

    #[test]
    fn records_exact_version_idempotently_and_requires_explicit_observation() {
        let ledger = TrustLedger::in_memory().unwrap();
        let first = config(1, &"a".repeat(64), "2026-10-01T00:00:00.000Z");
        assert_eq!(
            ledger.assert_observed(&first).unwrap_err().code(),
            "AGG_TRUST_CONFIG_NOT_OBSERVED"
        );
        let recorded = ledger.record(&first, NOW).unwrap();
        assert!(recorded.recorded);
        assert!(!recorded.idempotent);
        let repeated = ledger.record(&first, NOW + 1).unwrap();
        assert!(!repeated.recorded);
        assert!(repeated.idempotent);
        let inspection = ledger.assert_observed(&first).unwrap();
        assert_eq!(inspection.status, TrustHistoryStatus::CurrentOrForward);
        assert_eq!(ledger.history_count(&first.domain).unwrap(), 1);
        assert_eq!(ledger.event_count(&first.domain).unwrap(), 0);
    }

    #[test]
    fn manually_constructed_configuration_cannot_advance_high_water_with_a_stale_fingerprint() {
        let ledger = TrustLedger::in_memory().unwrap();
        let mut forged = config(1, &"a".repeat(64), "2026-10-01T00:00:00.000Z");
        forged.provider_id = "attacker-selected-provider".into();

        assert_eq!(
            ledger.record(&forged, NOW).unwrap_err().code(),
            "AGG_TRUST_CONFIG_FINGERPRINT_MISMATCH"
        );
        assert_eq!(ledger.history_count(&forged.domain).unwrap(), 0);
        assert_eq!(ledger.event_count(&forged.domain).unwrap(), 0);
        assert_eq!(
            ledger.inspect(&forged.domain, Some(&forged)).status,
            TrustHistoryStatus::CurrentConfigurationInvalid
        );
    }

    #[test]
    fn requires_contiguous_versions_and_monotonic_admin_timestamps() {
        let ledger = TrustLedger::in_memory().unwrap();
        let first = config(1, &"a".repeat(64), "2026-10-01T00:00:00.000Z");
        ledger.record(&first, NOW).unwrap();

        let second = config(2, &"b".repeat(64), "2026-10-02T00:00:00.000Z");
        assert_eq!(
            ledger.assert_observed(&second).unwrap_err().code(),
            "AGG_TRUST_CONFIG_NOT_OBSERVED"
        );
        assert_eq!(
            ledger.inspect(&second.domain, Some(&second)).status,
            TrustHistoryStatus::CurrentOrForward
        );
        ledger.record(&second, NOW + 1).unwrap();
        ledger.assert_observed(&second).unwrap();

        let rollback = config(1, &"a".repeat(64), "2026-10-01T00:00:00.000Z");
        assert_eq!(
            ledger.record(&rollback, NOW + 2).unwrap_err().code(),
            "AGG_TRUST_CONFIG_ROLLBACK"
        );
        let gap = config(4, &"d".repeat(64), "2026-10-04T00:00:00.000Z");
        assert_eq!(
            ledger.record(&gap, NOW + 3).unwrap_err().code(),
            "AGG_TRUST_CONFIG_VERSION_GAP"
        );
        let reused = config(2, &"c".repeat(64), "2026-10-02T00:00:00.000Z");
        assert_eq!(
            ledger.record(&reused, NOW + 4).unwrap_err().code(),
            "AGG_TRUST_CONFIG_VERSION_REUSED"
        );
        let time_rollback = config(3, &"c".repeat(64), "2026-09-30T00:00:00.000Z");
        assert_eq!(
            ledger.record(&time_rollback, NOW + 5).unwrap_err().code(),
            "AGG_TRUST_CONFIG_TIME_ROLLBACK"
        );
        assert_eq!(ledger.history_count(&first.domain).unwrap(), 2);
        assert_eq!(ledger.event_count(&first.domain).unwrap(), 4);
    }

    #[test]
    fn history_and_rejection_events_are_append_only() {
        let ledger = TrustLedger::in_memory().unwrap();
        let first = config(1, &"a".repeat(64), "2026-10-01T00:00:00.000Z");
        ledger.record(&first, NOW).unwrap();
        let connection = ledger.connection.lock().unwrap();
        let update = connection.execute(
            "UPDATE adaptive_goal_trust_configuration_history SET provider_id='other' WHERE domain=?1",
            params![first.domain],
        );
        assert!(update.is_err());
        let delete = connection.execute(
            "DELETE FROM adaptive_goal_trust_configuration_history WHERE domain=?1",
            params![first.domain],
        );
        assert!(delete.is_err());
        drop(connection);

        let rollback = config(1, &"b".repeat(64), "2026-10-02T00:00:00.000Z");
        let _ = ledger.record(&rollback, NOW + 1);
        let connection = ledger.connection.lock().unwrap();
        let event_id: String = connection
            .query_row(
                "SELECT event_id FROM adaptive_goal_trust_configuration_events LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(connection
            .execute(
                "UPDATE adaptive_goal_trust_configuration_events SET reason_code='changed' WHERE event_id=?1",
                params![event_id]
            )
            .is_err());
        assert!(
            connection
                .execute(
                    "DELETE FROM adaptive_goal_trust_configuration_events WHERE event_id=?1",
                    params![event_id]
                )
                .is_err()
        );
    }

    #[test]
    fn persistence_reopen_preserves_high_water_and_existing_unversioned_db_is_not_migrated() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("trust-ledger.sqlite");
        let first = config(1, &"a".repeat(64), "2026-10-01T00:00:00.000Z");
        {
            let ledger = TrustLedger::open(&path).unwrap();
            ledger.record(&first, NOW).unwrap();
        }
        let reopened = TrustLedger::open(&path).unwrap();
        reopened.assert_observed(&first).unwrap();
        let second = config(2, &"b".repeat(64), "2026-10-02T00:00:00.000Z");
        assert_eq!(
            reopened.inspect(&second.domain, Some(&second)).status,
            TrustHistoryStatus::CurrentOrForward
        );

        let unversioned = directory.path().join("unversioned.sqlite");
        let connection = Connection::open(&unversioned).unwrap();
        connection
            .execute_batch("CREATE TABLE existing_node_trust_history(domain TEXT)")
            .unwrap();
        drop(connection);
        let error = match TrustLedger::open(&unversioned) {
            Ok(_) => panic!("unversioned existing trust DB must not be migrated"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "AGG_TRUST_CONFIG_LEDGER_SCHEMA_UNSUPPORTED");
        let _ = fs::remove_file(unversioned);
    }
}
