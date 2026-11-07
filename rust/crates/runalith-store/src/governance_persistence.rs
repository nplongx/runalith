//! D-01 Governance trust/reviewer repositories backed by the workflow Store's
//! physical SQLite database. Lifecycle writes use a dedicated connection to
//! that same file with `BEGIN IMMEDIATE`; callers must not acquire it while
//! holding the workflow writer lock. Approval reads use the active workflow
//! transaction and never acquire the Governance writer connection.

use std::collections::BTreeSet;

use chrono::Utc;
use runalith_trust::{
    Ed25519PublicKey, TrustError,
    trust_config::TrustConfiguration,
    trust_ledger::TrustConfigurationObserver,
    trust_lifecycle::{
        ReviewerIdentity, ReviewerIdentityRepository, ReviewerStatus, TrustConfigurationRepository,
        TrustLifecycleError, validate_reviewer_identity, validate_reviewer_transition,
        validate_transition,
    },
};
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::Store;

impl TrustConfigurationObserver for Store {
    fn assert_observed(&self, _: &TrustConfiguration) -> Result<(), TrustError> {
        Err(TrustError::rejected(
            "AGG_TRUST_CONFIG_TRANSACTION_REQUIRED",
            "D-01 trust high-water must be inspected through the active workflow transaction",
        ))
    }

    fn assert_observed_in_transaction(
        &self,
        transaction: &rusqlite::Transaction<'_>,
        configuration: &TrustConfiguration,
    ) -> Result<(), TrustError> {
        configuration.validate_integrity()?;
        let row: Option<(i64, String, String)> = transaction
            .query_row(
                "SELECT config_version,configuration_fingerprint,provider_id
                 FROM governance_trust_configuration_versions
                 WHERE domain=?1 ORDER BY config_version DESC LIMIT 1",
                params![configuration.domain],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((version, fingerprint, provider_id)) = row else {
            return Err(TrustError::rejected(
                "AGG_TRUST_CONFIG_NOT_OBSERVED",
                format!(
                    "administrator must observe trust configuration {} before approval",
                    configuration.domain
                ),
            ));
        };
        let current_version = i64::try_from(configuration.config_version).map_err(|_| {
            TrustError::rejected(
                "AGG_TRUST_CONFIG_LEDGER_INVALID_INPUT",
                "trust version exceeds SQLite integer range",
            )
        })?;
        if current_version < version {
            return Err(TrustError::rejected(
                "AGG_TRUST_CONFIG_ROLLBACK",
                format!(
                    "trust configuration {} is below its observed high-water",
                    configuration.domain
                ),
            ));
        }
        if current_version > version {
            return Err(TrustError::rejected(
                "AGG_TRUST_CONFIG_NOT_OBSERVED",
                format!(
                    "exact trust configuration {} has not been observed",
                    configuration.domain
                ),
            ));
        }
        if fingerprint != configuration.configuration_fingerprint
            || provider_id != configuration.provider_id
        {
            return Err(TrustError::rejected(
                "AGG_TRUST_CONFIG_VERSION_REUSED",
                format!(
                    "trust configuration {} reused an observed version with different identity",
                    configuration.domain
                ),
            ));
        }
        Ok(())
    }
}

impl TrustConfigurationRepository for Store {
    fn current(&self, domain: &str) -> Result<Option<TrustConfiguration>, TrustLifecycleError> {
        let connection = self.trust_connection.lock().map_err(|_| {
            TrustLifecycleError::Persistence("Governance database lock poisoned".into())
        })?;
        let stored: Option<(i64, String, String, String)> = connection
            .query_row(
                "SELECT config_version,configuration_json,configuration_fingerprint,provider_id
                 FROM governance_trust_configuration_versions
                 WHERE domain=?1 ORDER BY config_version DESC LIMIT 1",
                params![domain],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(persistence)?;
        let Some((version, raw, fingerprint, provider_id)) = stored else {
            return Ok(None);
        };
        let configuration = decode_trust_configuration(&raw, domain)?;
        if i64::try_from(configuration.config_version).ok() != Some(version)
            || configuration.configuration_fingerprint != fingerprint
            || configuration.provider_id != provider_id
        {
            return Err(TrustLifecycleError::Persistence(
                "stored trust configuration binding mismatch".into(),
            ));
        }
        Ok(Some(configuration))
    }

    fn append_if_version(
        &self,
        domain: &str,
        expected_previous_version: Option<u64>,
        configuration: &TrustConfiguration,
        now_ms: i64,
    ) -> Result<(), TrustLifecycleError> {
        if configuration.domain != domain || now_ms < 0 {
            return Err(TrustLifecycleError::InvalidTransition);
        }
        let raw = encode_trust_configuration(configuration)?;
        with_trust_write_transaction(self, |transaction| {
            let current_row: Option<(i64, String)> = transaction
                .query_row(
                    "SELECT config_version,configuration_json FROM governance_trust_configuration_versions
                     WHERE domain=?1 ORDER BY config_version DESC LIMIT 1",
                    params![domain],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(persistence)?;
            let current = current_row.as_ref().map(|(version, _)| *version as u64);
            if current != expected_previous_version
                || configuration.config_version != current.unwrap_or(0).saturating_add(1)
            {
                return Err(TrustLifecycleError::Persistence(
                    "trust configuration compare-and-swap conflict".into(),
                ));
            }
            let previous = current_row
                .as_ref()
                .map(|(version, raw)| {
                    let configuration = decode_trust_configuration(raw, domain)?;
                    if i64::try_from(configuration.config_version).ok() != Some(*version) {
                        return Err(TrustLifecycleError::Persistence(
                            "stored trust configuration version binding mismatch".into(),
                        ));
                    }
                    Ok(configuration)
                })
                .transpose()?;
            validate_transition(previous.as_ref(), configuration, now_ms)?;
            let stored_version = i64::try_from(configuration.config_version)
                .map_err(|_| TrustLifecycleError::InvalidTransition)?;
            transaction
                .execute(
                    "INSERT INTO governance_trust_configuration_versions
                     (domain,config_version,provider_id,configuration_fingerprint,configuration_json,observed_at)
                     VALUES(?1,?2,?3,?4,?5,?6)",
                    params![
                        domain,
                        stored_version,
                        configuration.provider_id,
                        configuration.configuration_fingerprint,
                        raw,
                        chrono::DateTime::from_timestamp_millis(now_ms)
                            .ok_or(TrustLifecycleError::InvalidTransition)?
                            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    ],
                )
                .map_err(persistence)?;
            Ok(())
        })
    }
}

impl ReviewerIdentityRepository for Store {
    fn current_reviewer(
        &self,
        subject: &str,
    ) -> Result<Option<ReviewerIdentity>, TrustLifecycleError> {
        let connection = self.trust_connection.lock().map_err(|_| {
            TrustLifecycleError::Persistence("Governance database lock poisoned".into())
        })?;
        let raw: Option<(String, String, String, i64)> = connection
            .query_row(
                "SELECT identity_json,status,public_key_sha256,version FROM governance_reviewer_identity_versions
                 WHERE subject=?1 ORDER BY version DESC LIMIT 1",
                params![subject],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(persistence)?;
        raw.map(|(value, status, fingerprint, version)| {
            decode_reviewer_identity(&value, &status, &fingerprint, version)
        })
        .transpose()
    }

    fn current_reviewer_in_transaction(
        &self,
        transaction: &Transaction<'_>,
        subject: &str,
    ) -> Result<Option<ReviewerIdentity>, TrustLifecycleError> {
        let raw: Option<(String, String, String, i64)> = transaction
            .query_row(
                "SELECT identity_json,status,public_key_sha256,version
                 FROM governance_reviewer_identity_versions
                 WHERE subject=?1 ORDER BY version DESC LIMIT 1",
                params![subject],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(persistence)?;
        raw.map(|(value, status, fingerprint, version)| {
            decode_reviewer_identity(&value, &status, &fingerprint, version)
        })
        .transpose()
    }

    fn register_reviewer(&self, identity: &ReviewerIdentity) -> Result<(), TrustLifecycleError> {
        validate_reviewer_identity(identity, Utc::now().timestamp_millis(), true)?;
        let persisted = PersistedReviewerIdentity::from_identity(identity);
        let raw = serde_json::to_string(&persisted).map_err(persistence)?;
        with_trust_write_transaction(self, |transaction| {
            let exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM governance_reviewer_identity_versions WHERE subject=?1)",
                    params![identity.subject],
                    |row| row.get(0),
                )
                .map_err(persistence)?;
            if exists {
                return Err(TrustLifecycleError::Persistence(
                    "reviewer subject already registered, including revoked identities".into(),
                ));
            }
            insert_reviewer_version(transaction, identity, &raw)
        })
    }

    fn transition_reviewer(
        &self,
        expected_version: u64,
        identity: &ReviewerIdentity,
    ) -> Result<(), TrustLifecycleError> {
        if identity.version != expected_version.saturating_add(1) {
            return Err(TrustLifecycleError::ReviewerIdentityChanged);
        }
        let persisted = PersistedReviewerIdentity::from_identity(identity);
        let raw = serde_json::to_string(&persisted).map_err(persistence)?;
        with_trust_write_transaction(self, |transaction| {
            let current_row: Option<(String, String, String, i64)> = transaction
                .query_row(
                    "SELECT identity_json,status,public_key_sha256,version
                     FROM governance_reviewer_identity_versions
                     WHERE subject=?1 ORDER BY version DESC LIMIT 1",
                    params![identity.subject],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()
                .map_err(persistence)?;
            let expected_version_i64 = i64::try_from(expected_version)
                .map_err(|_| TrustLifecycleError::ReviewerIdentityChanged)?;
            if current_row.as_ref().map(|(_, _, _, version)| *version) != Some(expected_version_i64)
            {
                return Err(TrustLifecycleError::Persistence(
                    "reviewer identity compare-and-swap conflict".into(),
                ));
            }
            let (previous_raw, status, fingerprint, version) =
                current_row.as_ref().expect("CAS row exists");
            let previous = decode_reviewer_identity(previous_raw, status, fingerprint, *version)?;
            validate_reviewer_transition(&previous, identity)?;
            validate_reviewer_identity(identity, Utc::now().timestamp_millis(), false)?;
            insert_reviewer_version(transaction, identity, &raw)
        })
    }
}

fn decode_reviewer_identity(
    raw: &str,
    stored_status: &str,
    stored_fingerprint: &str,
    stored_version: i64,
) -> Result<ReviewerIdentity, TrustLifecycleError> {
    let persisted: PersistedReviewerIdentity = serde_json::from_str(raw).map_err(persistence)?;
    let identity = persisted.into_identity()?;
    let expected_status = match identity.status {
        ReviewerStatus::Active => "ACTIVE",
        ReviewerStatus::Suspended => "SUSPENDED",
        ReviewerStatus::Revoked => "REVOKED",
    };
    if stored_status != expected_status
        || stored_fingerprint != identity.public_key_sha256
        || i64::try_from(identity.version).ok() != Some(stored_version)
    {
        return Err(TrustLifecycleError::Persistence(
            "stored reviewer row binding mismatch".into(),
        ));
    }
    Ok(identity)
}

/// Serialize all Governance/trust mutations through the dedicated D-01
/// connection. The helper commits before returning; callers must not hold a
/// workflow writer transaction while invoking it. Workflow approval performs
/// the complementary read-only high-water check inside its own transaction.
fn with_trust_write_transaction<T>(
    store: &Store,
    operation: impl FnOnce(&Transaction<'_>) -> Result<T, TrustLifecycleError>,
) -> Result<T, TrustLifecycleError> {
    let mut connection = store.trust_connection.lock().map_err(|_| {
        TrustLifecycleError::Persistence("Governance database lock poisoned".into())
    })?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(persistence)?;
    let quarantined: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agg_checkpoint_store_quarantine WHERE singleton=1)",
            [],
            |row| row.get(0),
        )
        .map_err(persistence)?;
    if quarantined {
        return Err(TrustLifecycleError::Persistence(
            "workflow database is checkpoint-quarantined".into(),
        ));
    }
    let value = operation(&transaction)?;
    transaction.commit().map_err(persistence)?;
    Ok(value)
}

fn insert_reviewer_version(
    transaction: &rusqlite::Transaction<'_>,
    identity: &ReviewerIdentity,
    raw: &str,
) -> Result<(), TrustLifecycleError> {
    let version = i64::try_from(identity.version)
        .map_err(|_| TrustLifecycleError::ReviewerIdentityChanged)?;
    let status = match identity.status {
        ReviewerStatus::Active => "ACTIVE",
        ReviewerStatus::Suspended => "SUSPENDED",
        ReviewerStatus::Revoked => "REVOKED",
    };
    transaction
        .execute(
            "INSERT INTO governance_reviewer_identity_versions
             (subject,version,status,public_key_sha256,identity_json,changed_at)
             VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                identity.subject,
                version,
                status,
                identity.public_key_sha256,
                raw,
                Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            ],
        )
        .map_err(persistence)?;
    Ok(())
}

fn encode_trust_configuration(
    configuration: &TrustConfiguration,
) -> Result<String, TrustLifecycleError> {
    let keys = configuration
        .roots
        .iter()
        .map(|root| {
            json!({
                "key_id": root.key_id,
                "public_key_pem": root.public_key_pem,
                "scopes": [root.scope],
                "not_before": root.not_before,
                "not_after": root.not_after,
                "revoked_at": root.revoked_at,
            })
        })
        .collect::<Vec<_>>();
    serde_json::to_string(&json!({
        "schema_version": 1,
        "domain": configuration.domain,
        "provider_id": configuration.provider_id,
        "config_version": configuration.config_version,
        "updated_at": configuration.config_updated_at,
        "updated_by": configuration.config_updated_by,
        "change_reference": configuration.config_change_reference,
        "keys": keys,
    }))
    .map_err(persistence)
}

fn decode_trust_configuration(
    raw: &str,
    domain: &str,
) -> Result<TrustConfiguration, TrustLifecycleError> {
    let value: Value = serde_json::from_str(raw).map_err(persistence)?;
    let scope = value
        .get("keys")
        .and_then(Value::as_array)
        .and_then(|keys| keys.first())
        .and_then(|key| key.get("scopes"))
        .and_then(Value::as_array)
        .and_then(|scopes| scopes.first())
        .and_then(Value::as_str)
        .ok_or_else(|| TrustLifecycleError::Persistence("stored trust scope missing".into()))?;
    TrustConfiguration::load_json(raw.as_bytes(), domain, scope, Utc::now().timestamp_millis())
        .map_err(persistence)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedReviewerIdentity {
    subject: String,
    key_id: String,
    public_key_pem: String,
    public_key_sha256: String,
    role: String,
    domains: BTreeSet<String>,
    version: u64,
    status: String,
    registered_at_ms: i64,
    expires_at_ms: i64,
    revoked_at_ms: Option<i64>,
    changed_by: String,
    change_reference: String,
}

impl PersistedReviewerIdentity {
    fn from_identity(identity: &ReviewerIdentity) -> Self {
        Self {
            subject: identity.subject.clone(),
            key_id: identity.key_id.clone(),
            public_key_pem: identity.public_key_pem.clone(),
            public_key_sha256: identity.public_key_sha256.clone(),
            role: identity.role.clone(),
            domains: identity.domains.clone(),
            version: identity.version,
            status: match identity.status {
                ReviewerStatus::Active => "ACTIVE",
                ReviewerStatus::Suspended => "SUSPENDED",
                ReviewerStatus::Revoked => "REVOKED",
            }
            .into(),
            registered_at_ms: identity.registered_at_ms,
            expires_at_ms: identity.expires_at_ms,
            revoked_at_ms: identity.revoked_at_ms,
            changed_by: identity.changed_by.clone(),
            change_reference: identity.change_reference.clone(),
        }
    }

    fn into_identity(self) -> Result<ReviewerIdentity, TrustLifecycleError> {
        let public_key = Ed25519PublicKey::from_pem(&self.public_key_pem).map_err(persistence)?;
        if public_key.fingerprint() != self.public_key_sha256 {
            return Err(TrustLifecycleError::Persistence(
                "stored reviewer public-key fingerprint mismatch".into(),
            ));
        }
        let status = match self.status.as_str() {
            "ACTIVE" => ReviewerStatus::Active,
            "SUSPENDED" => ReviewerStatus::Suspended,
            "REVOKED" => ReviewerStatus::Revoked,
            _ => {
                return Err(TrustLifecycleError::Persistence(
                    "stored reviewer status is invalid".into(),
                ));
            }
        };
        Ok(ReviewerIdentity {
            subject: self.subject,
            key_id: self.key_id,
            public_key_pem: self.public_key_pem,
            public_key_sha256: self.public_key_sha256,
            role: self.role,
            domains: self.domains,
            version: self.version,
            status,
            registered_at_ms: self.registered_at_ms,
            expires_at_ms: self.expires_at_ms,
            revoked_at_ms: self.revoked_at_ms,
            changed_by: self.changed_by,
            change_reference: self.change_reference,
        })
    }
}

fn persistence(error: impl std::fmt::Display) -> TrustLifecycleError {
    TrustLifecycleError::Persistence(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::Store;
    use runalith_trust::trust_ledger::TrustConfigurationObserver;
    use runalith_trust::trust_lifecycle::TrustConfigurationRepository;

    const TEST_PUBLIC_KEY: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAPUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=\n-----END PUBLIC KEY-----\n";

    fn trust_config(version: u64, updated: &str) -> TrustConfiguration {
        let raw = json!({
            "schema_version": 1,
            "domain": "execution_approval",
            "provider_id": "test-provider",
            "config_version": version,
            "updated_at": updated,
            "updated_by": "test-admin",
            "change_reference": format!("CHANGE-{version}"),
            "keys": [{
                "key_id": "test-root",
                "public_key_pem": TEST_PUBLIC_KEY,
                "scopes": ["agg.execution.approve"],
                "not_before": "2026-01-01T00:00:00.000Z",
                "not_after": null,
                "revoked_at": null
            }]
        });
        TrustConfiguration::load_json(
            raw.to_string().as_bytes(),
            "execution_approval",
            "agg.execution.approve",
            1_800_000_000_000,
        )
        .unwrap()
    }

    #[test]
    fn trust_configuration_repository_round_trips_and_cas_is_atomic() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("governance.sqlite");
        let store = Store::create_new(&path).unwrap();
        let first = trust_config(1, "2026-11-01T09:00:00.000Z");
        store
            .append_if_version("execution_approval", None, &first, 1_800_000_000_000)
            .unwrap();
        let loaded = store.current("execution_approval").unwrap().unwrap();
        assert_eq!(
            loaded.configuration_fingerprint,
            first.configuration_fingerprint
        );

        let next = trust_config(2, "2026-11-01T09:01:00.000Z");
        let left = Arc::new(Store::open_existing(&path).unwrap());
        let right = Arc::new(Store::open_existing(&path).unwrap());
        let left_store = Arc::clone(&left);
        let right_store = Arc::clone(&right);
        let a = std::thread::spawn(move || {
            left_store.append_if_version("execution_approval", Some(1), &next, 1_800_000_000_000)
        });
        let next_other = trust_config(2, "2026-11-01T09:02:00.000Z");
        let b = std::thread::spawn(move || {
            right_store.append_if_version(
                "execution_approval",
                Some(1),
                &next_other,
                1_800_000_000_000,
            )
        });
        assert_ne!(a.join().unwrap().is_ok(), b.join().unwrap().is_ok());
        let latest = store.current("execution_approval").unwrap().unwrap();
        assert_eq!(latest.config_version, 2);
        let connection = store.connection.lock().unwrap();
        assert!(connection.execute(
            "UPDATE governance_trust_configuration_versions SET provider_id='rewritten' WHERE domain='execution_approval'",
            [],
        ).is_err());
        assert!(connection.execute(
            "DELETE FROM governance_trust_configuration_versions WHERE domain='execution_approval'",
            [],
        ).is_err());
    }

    #[test]
    fn governance_connection_is_distinct_and_targets_same_wal_database() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("d01-two-connections.sqlite");
        let store = Store::create_new(&path).unwrap();
        {
            let workflow = store.connection.lock().unwrap();
            let trust = store.trust_connection.lock().unwrap();
            assert!(!std::ptr::eq(&*workflow, &*trust));
            let database_file = |connection: &rusqlite::Connection| {
                connection
                    .query_row(
                        "SELECT file FROM pragma_database_list WHERE name='main'",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .unwrap()
            };
            let workflow_file = database_file(&workflow);
            let trust_file = database_file(&trust);
            assert_eq!(workflow_file, trust_file);
            assert_eq!(std::fs::canonicalize(&workflow_file).unwrap(), path);
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                let workflow_metadata = std::fs::metadata(&workflow_file).unwrap();
                let trust_metadata = std::fs::metadata(&trust_file).unwrap();
                assert_eq!(workflow_metadata.dev(), trust_metadata.dev());
                assert_eq!(workflow_metadata.ino(), trust_metadata.ino());
            }
            for connection in [&*workflow, &*trust] {
                let journal_mode: String = connection
                    .pragma_query_value(None, "journal_mode", |row| row.get(0))
                    .unwrap();
                let synchronous: i64 = connection
                    .pragma_query_value(None, "synchronous", |row| row.get(0))
                    .unwrap();
                assert_eq!(journal_mode, "wal");
                assert_eq!(synchronous, 2);
            }
        }
        let first = trust_config(1, "2026-11-01T09:00:00.000Z");
        store
            .append_if_version("execution_approval", None, &first, 1_800_000_000_000)
            .unwrap();
        let workflow = store.connection.lock().unwrap();
        let count: i64 = workflow
            .query_row(
                "SELECT COUNT(*) FROM governance_trust_configuration_versions WHERE domain='execution_approval'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn reviewer_repository_retains_versions_and_rejects_terminal_revocation_reopen() {
        let store = Store::in_memory().unwrap();
        let key = Ed25519PublicKey::from_pem(TEST_PUBLIC_KEY).unwrap();
        let now_ms = Utc::now().timestamp_millis();
        let identity = ReviewerIdentity {
            subject: "reviewer@example.invalid".into(),
            key_id: "reviewer-key".into(),
            public_key_pem: TEST_PUBLIC_KEY.into(),
            public_key_sha256: key.fingerprint().into(),
            role: "checker".into(),
            domains: BTreeSet::from(["execution_approval".into()]),
            version: 1,
            status: ReviewerStatus::Active,
            registered_at_ms: now_ms - 1_000,
            expires_at_ms: now_ms + 86_400_000,
            revoked_at_ms: None,
            changed_by: "governance-admin".into(),
            change_reference: "CHANGE-REVIEWER-1".into(),
        };
        store.register_reviewer(&identity).unwrap();
        assert_eq!(
            store.current_reviewer(&identity.subject).unwrap(),
            Some(identity.clone())
        );

        let mut revoked = identity.clone();
        revoked.version = 2;
        revoked.status = ReviewerStatus::Revoked;
        revoked.revoked_at_ms = Some(Utc::now().timestamp_millis());
        revoked.change_reference = "CHANGE-REVIEWER-2".into();
        store.transition_reviewer(1, &revoked).unwrap();

        let mut reopened = revoked.clone();
        reopened.version = 3;
        reopened.status = ReviewerStatus::Active;
        reopened.revoked_at_ms = None;
        reopened.change_reference = "CHANGE-REVIEWER-3".into();
        assert!(store.transition_reviewer(2, &reopened).is_err());
        assert_eq!(
            store
                .current_reviewer(&identity.subject)
                .unwrap()
                .unwrap()
                .status,
            ReviewerStatus::Revoked
        );
    }

    #[test]
    fn reviewer_lifecycle_cas_is_serialized_across_independent_store_instances() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("reviewer-cas.sqlite");
        let store = Store::create_new(&path).unwrap();
        let key = Ed25519PublicKey::from_pem(TEST_PUBLIC_KEY).unwrap();
        let now_ms = Utc::now().timestamp_millis();
        let identity = ReviewerIdentity {
            subject: "reviewer-cas@example.invalid".into(),
            key_id: "reviewer-cas-key".into(),
            public_key_pem: TEST_PUBLIC_KEY.into(),
            public_key_sha256: key.fingerprint().into(),
            role: "checker".into(),
            domains: BTreeSet::from(["execution_approval".into()]),
            version: 1,
            status: ReviewerStatus::Active,
            registered_at_ms: now_ms - 1_000,
            expires_at_ms: now_ms + 86_400_000,
            revoked_at_ms: None,
            changed_by: "governance-admin".into(),
            change_reference: "CHANGE-REVIEWER-CAS-1".into(),
        };
        store.register_reviewer(&identity).unwrap();

        let left = Arc::new(Store::open_existing(&path).unwrap());
        let right = Arc::new(Store::open_existing(&path).unwrap());
        let mut suspended = identity.clone();
        suspended.version = 2;
        suspended.status = ReviewerStatus::Suspended;
        suspended.change_reference = "CHANGE-REVIEWER-CAS-SUSPEND".into();
        let mut revoked = identity.clone();
        revoked.version = 2;
        revoked.status = ReviewerStatus::Revoked;
        revoked.revoked_at_ms = Some(now_ms + 1);
        revoked.change_reference = "CHANGE-REVIEWER-CAS-REVOKE".into();

        let left_result = std::thread::spawn(move || left.transition_reviewer(1, &suspended));
        let right_result = std::thread::spawn(move || right.transition_reviewer(1, &revoked));
        assert_ne!(
            left_result.join().unwrap().is_ok(),
            right_result.join().unwrap().is_ok()
        );
        let latest = store.current_reviewer(&identity.subject).unwrap().unwrap();
        assert_eq!(latest.version, 2);
        let trust = store.trust_connection.lock().unwrap();
        let count: i64 = trust
            .query_row(
                "SELECT COUNT(*) FROM governance_reviewer_identity_versions WHERE subject=?1",
                params![identity.subject],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
        assert!(trust.execute(
            "UPDATE governance_reviewer_identity_versions SET status='ACTIVE' WHERE subject=?1 AND version=2",
            params![identity.subject],
        ).is_err());
        assert!(
            trust
                .execute(
                    "DELETE FROM governance_reviewer_identity_versions WHERE subject=?1",
                    params![identity.subject],
                )
                .is_err()
        );
    }

    #[test]
    fn reviewer_readback_rejects_tampered_fingerprint_even_if_trigger_is_bypassed() {
        let store = Store::in_memory().unwrap();
        let key = Ed25519PublicKey::from_pem(TEST_PUBLIC_KEY).unwrap();
        let now_ms = Utc::now().timestamp_millis();
        let identity = ReviewerIdentity {
            subject: "reviewer-tamper@example.invalid".into(),
            key_id: "reviewer-tamper-key".into(),
            public_key_pem: TEST_PUBLIC_KEY.into(),
            public_key_sha256: key.fingerprint().into(),
            role: "checker".into(),
            domains: BTreeSet::from(["execution_approval".into()]),
            version: 1,
            status: ReviewerStatus::Active,
            registered_at_ms: now_ms - 1_000,
            expires_at_ms: now_ms + 86_400_000,
            revoked_at_ms: None,
            changed_by: "governance-admin".into(),
            change_reference: "CHANGE-REVIEWER-TAMPER".into(),
        };
        store.register_reviewer(&identity).unwrap();
        let trust = store.trust_connection.lock().unwrap();
        trust
            .execute_batch("DROP TRIGGER governance_reviewer_identity_no_update;")
            .unwrap();
        trust
            .execute(
                "UPDATE governance_reviewer_identity_versions SET public_key_sha256=?1 WHERE subject=?2",
                params!["0".repeat(64), identity.subject],
            )
            .unwrap();
        drop(trust);
        assert!(store.current_reviewer(&identity.subject).is_err());
    }

    #[test]
    fn reviewer_transaction_read_and_transition_reject_tampered_status_binding() {
        let store = Store::in_memory().unwrap();
        let key = Ed25519PublicKey::from_pem(TEST_PUBLIC_KEY).unwrap();
        let now_ms = Utc::now().timestamp_millis();
        let identity = ReviewerIdentity {
            subject: "reviewer-status-tamper@example.invalid".into(),
            key_id: "reviewer-status-tamper-key".into(),
            public_key_pem: TEST_PUBLIC_KEY.into(),
            public_key_sha256: key.fingerprint().into(),
            role: "checker".into(),
            domains: BTreeSet::from(["execution_approval".into()]),
            version: 1,
            status: ReviewerStatus::Active,
            registered_at_ms: now_ms - 1_000,
            expires_at_ms: now_ms + 86_400_000,
            revoked_at_ms: None,
            changed_by: "governance-admin".into(),
            change_reference: "CHANGE-REVIEWER-STATUS-TAMPER".into(),
        };
        store.register_reviewer(&identity).unwrap();

        let trust = store.trust_connection.lock().unwrap();
        trust
            .execute_batch("DROP TRIGGER governance_reviewer_identity_no_update;")
            .unwrap();
        trust
            .execute(
                "UPDATE governance_reviewer_identity_versions SET status='SUSPENDED' WHERE subject=?1",
                params![identity.subject],
            )
            .unwrap();
        drop(trust);

        assert!(store.current_reviewer(&identity.subject).is_err());
        let mut workflow = store.connection.lock().unwrap();
        let transaction = workflow
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        assert!(
            store
                .current_reviewer_in_transaction(&transaction, &identity.subject)
                .is_err()
        );
        transaction.rollback().unwrap();

        let mut suspended = identity;
        suspended.version = 2;
        suspended.status = ReviewerStatus::Suspended;
        suspended.change_reference = "CHANGE-REVIEWER-STATUS-TAMPER-TRANSITION".into();
        assert!(store.transition_reviewer(1, &suspended).is_err());
    }

    #[test]
    fn reviewer_readback_rejects_tampered_pem_and_version_bindings() {
        for tamper in ["pem", "json_version", "row_version"] {
            let store = Store::in_memory().unwrap();
            let key = Ed25519PublicKey::from_pem(TEST_PUBLIC_KEY).unwrap();
            let now_ms = Utc::now().timestamp_millis();
            let identity = ReviewerIdentity {
                subject: format!("reviewer-{tamper}@example.invalid"),
                key_id: format!("reviewer-{tamper}-key"),
                public_key_pem: TEST_PUBLIC_KEY.into(),
                public_key_sha256: key.fingerprint().into(),
                role: "checker".into(),
                domains: BTreeSet::from(["execution_approval".into()]),
                version: 1,
                status: ReviewerStatus::Active,
                registered_at_ms: now_ms - 1_000,
                expires_at_ms: now_ms + 86_400_000,
                revoked_at_ms: None,
                changed_by: "governance-admin".into(),
                change_reference: format!("CHANGE-REVIEWER-{tamper}"),
            };
            store.register_reviewer(&identity).unwrap();

            let trust = store.trust_connection.lock().unwrap();
            trust
                .execute_batch("DROP TRIGGER governance_reviewer_identity_no_update;")
                .unwrap();
            match tamper {
                "pem" | "json_version" => {
                    let raw: String = trust
                        .query_row(
                            "SELECT identity_json FROM governance_reviewer_identity_versions WHERE subject=?1",
                            params![identity.subject],
                            |row| row.get(0),
                        )
                        .unwrap();
                    let mut persisted: Value = serde_json::from_str(&raw).unwrap();
                    if tamper == "pem" {
                        persisted["public_key_pem"] = json!("not a public key");
                    } else {
                        persisted["version"] = json!(2);
                    }
                    trust
                        .execute(
                            "UPDATE governance_reviewer_identity_versions SET identity_json=?1 WHERE subject=?2",
                            params![serde_json::to_string(&persisted).unwrap(), identity.subject],
                        )
                        .unwrap();
                }
                "row_version" => {
                    trust
                        .execute(
                            "UPDATE governance_reviewer_identity_versions SET version=2 WHERE subject=?1",
                            params![identity.subject],
                        )
                        .unwrap();
                }
                _ => unreachable!(),
            }
            drop(trust);

            assert!(
                store.current_reviewer(&identity.subject).is_err(),
                "tampered {tamper} binding must fail readback"
            );
        }
    }

    #[test]
    fn reviewer_identity_can_be_read_inside_workflow_transaction_without_governance_lock() {
        let store = Store::in_memory().unwrap();
        let key = Ed25519PublicKey::from_pem(TEST_PUBLIC_KEY).unwrap();
        let now_ms = Utc::now().timestamp_millis();
        let identity = ReviewerIdentity {
            subject: "reviewer-transaction@example.invalid".into(),
            key_id: "reviewer-transaction-key".into(),
            public_key_pem: TEST_PUBLIC_KEY.into(),
            public_key_sha256: key.fingerprint().into(),
            role: "checker".into(),
            domains: BTreeSet::from(["execution_approval".into()]),
            version: 1,
            status: ReviewerStatus::Active,
            registered_at_ms: now_ms - 1_000,
            expires_at_ms: now_ms + 86_400_000,
            revoked_at_ms: None,
            changed_by: "governance-admin".into(),
            change_reference: "CHANGE-REVIEWER-TRANSACTION".into(),
        };
        store.register_reviewer(&identity).unwrap();

        let mut workflow = store.connection.lock().unwrap();
        let transaction = workflow
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let observed = store
            .current_reviewer_in_transaction(&transaction, &identity.subject)
            .unwrap()
            .unwrap();
        assert_eq!(observed, identity);
        // A writer lock is held on the workflow connection. The reviewer read
        // above completed without attempting to acquire the Governance writer.
        transaction.rollback().unwrap();
    }

    #[test]
    fn approval_trust_high_water_reads_exact_workflow_transaction() {
        let store = Store::in_memory().unwrap();
        let first = trust_config(1, "2026-11-01T09:00:00.000Z");
        store
            .append_if_version("execution_approval", None, &first, 1_800_000_000_000)
            .unwrap();
        assert_eq!(
            store.assert_observed(&first).unwrap_err().code(),
            "AGG_TRUST_CONFIG_TRANSACTION_REQUIRED"
        );
        {
            let mut connection = store.connection.lock().unwrap();
            let transaction = connection.transaction().unwrap();
            store
                .assert_observed_in_transaction(&transaction, &first)
                .unwrap();
            transaction.rollback().unwrap();
        }

        let mut forged = first.clone();
        forged.roots[0].public_key_pem =
            "-----BEGIN PUBLIC KEY-----\nforged\n-----END PUBLIC KEY-----".into();
        let mut connection = store.connection.lock().unwrap();
        let transaction = connection.transaction().unwrap();
        assert_eq!(
            store
                .assert_observed_in_transaction(&transaction, &forged)
                .unwrap_err()
                .code(),
            "AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID"
        );
        transaction.rollback().unwrap();
        drop(connection);

        let second = trust_config(2, "2026-11-01T09:01:00.000Z");
        store
            .append_if_version("execution_approval", Some(1), &second, 1_800_000_000_000)
            .unwrap();
        let mut connection = store.connection.lock().unwrap();
        let transaction = connection.transaction().unwrap();
        assert_eq!(
            store
                .assert_observed_in_transaction(&transaction, &first)
                .unwrap_err()
                .code(),
            "AGG_TRUST_CONFIG_ROLLBACK"
        );
        store
            .assert_observed_in_transaction(&transaction, &second)
            .unwrap();
    }
}
