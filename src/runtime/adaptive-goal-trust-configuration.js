import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import { parseStrictJson } from './strict-json.js';

export const ADAPTIVE_GOAL_KNOWLEDGE_TRUST_CONFIG_ENV = 'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON';
export const ADAPTIVE_GOAL_REVIEWER_TRUST_CONFIG_ENV = 'AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON';
export const ADAPTIVE_GOAL_TRUST_CONFIG_SCHEMA_VERSION = 1;

const TRUST_CONFIG_LEDGER_SCHEMA = `
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
  BEFORE UPDATE ON adaptive_goal_trust_configuration_history BEGIN SELECT RAISE(ABORT, 'trust configuration history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS adaptive_goal_trust_configuration_no_delete
  BEFORE DELETE ON adaptive_goal_trust_configuration_history BEGIN SELECT RAISE(ABORT, 'trust configuration history is append-only'); END;
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
  BEFORE UPDATE ON adaptive_goal_trust_configuration_events BEGIN SELECT RAISE(ABORT, 'trust configuration events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS adaptive_goal_trust_configuration_events_no_delete
  BEFORE DELETE ON adaptive_goal_trust_configuration_events BEGIN SELECT RAISE(ABORT, 'trust configuration events are append-only'); END;
`;

const SHA256 = /^[a-f0-9]{64}$/;
const KEY_ID = /^[a-z][a-z0-9._-]{0,79}$/;

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
export function adaptiveGoalPublicKeyFingerprint(publicKeyOrPem) {
  let key = publicKeyOrPem;
  if (typeof publicKeyOrPem === 'string') {
    try { key = createPublicKey(publicKeyOrPem); }
    catch { fail('AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID', 'cannot fingerprint an invalid public key'); }
  }
  if (!key || key.asymmetricKeyType !== 'ed25519') fail('AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID', 'canonical public-key fingerprint requires an Ed25519 key');
  return sha256(key.export({ type: 'spki', format: 'der' }));
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function exactKeys(value, expected, label) {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    fail('AGG_TRUST_CONFIG_SCHEMA_INVALID', `${label} must contain exactly: ${expected.join(', ')}`);
  }
}
function canonicalTimestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') fail('AGG_TRUST_CONFIG_SCHEMA_INVALID', `${label} must be a canonical UTC ISO-8601 timestamp${nullable ? ' or null' : ''}`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail('AGG_TRUST_CONFIG_SCHEMA_INVALID', `${label} must be a canonical UTC ISO-8601 timestamp`);
  }
  return parsed.getTime();
}

/**
 * Load an administrator-provisioned, public-only trust configuration.
 * JSON configuration allows overlap during key rotation and explicit revocation;
 * the legacy single-key environment contract remains supported for migration.
 * The plugin deliberately has no MCP mutation endpoint for trust configuration.
 */
export function loadAdaptiveGoalTrustConfiguration({
  configJsonEnv,
  providerEnv,
  publicKeyEnv,
  domain,
  scope,
  now = Date.now(),
  environment = process.env
}) {
  if (typeof configJsonEnv !== 'string' || !configJsonEnv.trim() ||
      typeof providerEnv !== 'string' || !providerEnv.trim() ||
      typeof publicKeyEnv !== 'string' || !publicKeyEnv.trim() ||
      typeof domain !== 'string' || !domain.trim() || typeof scope !== 'string' || !scope.trim()) {
    throw new TypeError('trust configuration loader requires the JSON/provider/public-key environment names, trust domain, and exact scope');
  }

  const rawConfig = environment[configJsonEnv];
  if (rawConfig !== undefined) {
    if (typeof rawConfig !== 'string' || !rawConfig.trim()) fail('AGG_TRUST_CONFIG_SCHEMA_INVALID', `${configJsonEnv} is set but empty; refusing to fall back to a legacy trust root`);
    const parsed = parseStrictJson(rawConfig, 'AGG public trust configuration', { maxBytes: 128 * 1024 });
    const topKeys = ['schema_version', 'domain', 'provider_id', 'config_version', 'updated_at', 'updated_by', 'change_reference', 'keys'];
    exactKeys(parsed, topKeys, 'trust configuration');
    if (parsed.schema_version !== ADAPTIVE_GOAL_TRUST_CONFIG_SCHEMA_VERSION || parsed.domain !== domain ||
        typeof parsed.provider_id !== 'string' || !parsed.provider_id.trim() || parsed.provider_id.length > 200 ||
        !Number.isSafeInteger(parsed.config_version) || parsed.config_version < 1 ||
        typeof parsed.updated_by !== 'string' || !parsed.updated_by.trim() || parsed.updated_by.length > 200 ||
        typeof parsed.change_reference !== 'string' || !parsed.change_reference.trim() || parsed.change_reference.length > 300 ||
        !Array.isArray(parsed.keys) || parsed.keys.length < 1 || parsed.keys.length > 32) {
      fail('AGG_TRUST_CONFIG_SCHEMA_INVALID', 'trust configuration has an invalid version, domain, provider, administration metadata, or key list');
    }
    const configUpdatedAt = canonicalTimestamp(parsed.updated_at, 'updated_at');
    if (configUpdatedAt > now + 60_000) fail('AGG_TRUST_CONFIG_FUTURE_DATED', 'updated_at is more than one minute in the future');

    const keyIds = new Set();
    const fingerprints = new Set();
    const roots = parsed.keys.map((entry, index) => {
      exactKeys(entry, ['key_id', 'public_key_pem', 'scopes', 'not_before', 'not_after', 'revoked_at'], `keys[${index}]`);
      if (typeof entry.key_id !== 'string' || !KEY_ID.test(entry.key_id) || keyIds.has(entry.key_id)) {
        fail('AGG_TRUST_CONFIG_KEY_ID_INVALID', `keys[${index}].key_id must be unique and match ${KEY_ID}`);
      }
      keyIds.add(entry.key_id);
      if (typeof entry.public_key_pem !== 'string' || !entry.public_key_pem.includes('BEGIN PUBLIC KEY')) {
        fail('AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID', `keys[${index}] must contain an Ed25519 PUBLIC KEY PEM`);
      }
      let publicKey;
      try { publicKey = createPublicKey(entry.public_key_pem); }
      catch { fail('AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID', `keys[${index}] contains an invalid public key`); }
      if (publicKey.asymmetricKeyType !== 'ed25519') fail('AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID', `keys[${index}] must use Ed25519`);
      // Pin mathematical key identity, not its textual PEM envelope. Two valid
      // PEM encodings of the same Ed25519 key must be one trust root across
      // both domains or the domain-separation guard could be bypassed.
      const trustRootSha256 = adaptiveGoalPublicKeyFingerprint(publicKey);
      if (fingerprints.has(trustRootSha256)) fail('AGG_TRUST_CONFIG_DUPLICATE_ROOT', `keys[${index}] repeats a configured public-root fingerprint`);
      fingerprints.add(trustRootSha256);
      if (!Array.isArray(entry.scopes) || entry.scopes.length !== 1 || entry.scopes[0] !== scope) {
        fail('AGG_TRUST_CONFIG_SCOPE_INVALID', `keys[${index}] must authorize only the exact ${scope} scope for domain ${domain}`);
      }
      const notBefore = canonicalTimestamp(entry.not_before, `keys[${index}].not_before`);
      const notAfter = canonicalTimestamp(entry.not_after, `keys[${index}].not_after`, { nullable: true });
      const revokedAt = canonicalTimestamp(entry.revoked_at, `keys[${index}].revoked_at`, { nullable: true });
      if (notAfter !== null && notAfter <= notBefore) fail('AGG_TRUST_CONFIG_KEY_WINDOW_INVALID', `keys[${index}].not_after must be later than not_before`);
      return {
        keyId: entry.key_id,
        publicKey,
        publicKeyPem: entry.public_key_pem,
        trustRootSha256,
        legacyPemSha256: sha256(entry.public_key_pem),
        scope,
        notBefore,
        notAfter,
        revokedAt,
        notBeforeIso: entry.not_before,
        notAfterIso: entry.not_after,
        revokedAtIso: entry.revoked_at,
        usableNow: revokedAt === null && notBefore <= now && (notAfter === null || now < notAfter)
      };
    });
    const unsignedConfig = { ...parsed };
    const configurationFingerprint = sha256(canonicalJson(unsignedConfig));
    return {
      providerId: parsed.provider_id,
      domain,
      scope,
      configVersion: parsed.config_version,
      configUpdatedAt: parsed.updated_at,
      configUpdatedBy: parsed.updated_by,
      configChangeReference: parsed.change_reference,
      configurationFingerprint,
      configurationSource: 'admin_json_environment',
      roots,
      available: roots.some(root => root.usableNow),
      blockers: roots.some(root => root.usableNow) ? [] : [{ code: 'AGG_TRUST_CONFIG_NO_USABLE_ROOT', message: 'all configured public roots are revoked, not-yet-valid, or outside their validity window' }]
    };
  }

  // Legacy path is intentionally single-key only. It is treated as a
  // deployment-administered root but cannot express overlap/rotation history.
  const providerId = environment[providerEnv];
  const publicKeyPem = environment[publicKeyEnv];
  if (typeof providerId !== 'string' || !providerId.trim() || providerId.length > 200 ||
      typeof publicKeyPem !== 'string' || !publicKeyPem.includes('BEGIN PUBLIC KEY')) {
    fail('AGG_TRUST_CONFIG_NOT_CONFIGURED', `configure ${configJsonEnv}, or the legacy pair ${providerEnv} and ${publicKeyEnv}`);
  }
  let publicKey;
  try { publicKey = createPublicKey(publicKeyPem); }
  catch { fail('AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID', `configured ${publicKeyEnv} is not a valid public key`); }
  if (publicKey.asymmetricKeyType !== 'ed25519') fail('AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID', `${publicKeyEnv} must contain an Ed25519 public key`);
  const trustRootSha256 = adaptiveGoalPublicKeyFingerprint(publicKey);
  const legacyPemSha256 = sha256(publicKeyPem);
  return {
    providerId: providerId.trim(), domain, scope, configVersion: 0,
    configUpdatedAt: null, configUpdatedBy: 'host-process-environment',
    configChangeReference: 'legacy-single-key-environment',
    configurationFingerprint: sha256(canonicalJson({ domain, providerId: providerId.trim(), scope, trustRootSha256, legacyPemSha256 })),
    configurationSource: 'legacy_single_key_environment',
    roots: [{ keyId: `legacy-${trustRootSha256.slice(0, 12)}`, publicKey, publicKeyPem, trustRootSha256, legacyPemSha256, scope,
      notBefore: 0, notAfter: null, revokedAt: null, notBeforeIso: new Date(0).toISOString(), notAfterIso: null,
      revokedAtIso: null, usableNow: true }],
    available: true, blockers: []
  };
}

export function findAdaptiveGoalTrustedRoot(configuration, fingerprint, { issuedAt, now = Date.now() } = {}) {
  if (!configuration || configuration.available !== true) fail('AGG_TRUST_CONFIG_UNAVAILABLE', 'trusted public-root configuration is not available');
  if (typeof fingerprint !== 'string' || !SHA256.test(fingerprint)) fail('AGG_TRUST_ROOT_FINGERPRINT_INVALID', 'signed trust_root_sha256 is malformed');
  const root = configuration.roots.find(item => item.trustRootSha256 === fingerprint ||
    (configuration.configurationSource === 'legacy_single_key_environment' && item.legacyPemSha256 === fingerprint));
  if (!root) fail('AGG_TRUST_ROOT_UNTRUSTED', 'signature uses a public root that is not present in the current administrator trust configuration');
  if (root.revokedAt !== null) fail('AGG_TRUST_ROOT_REVOKED', `trusted key ${root.keyId} is revoked`);
  if (root.notBefore > now || (root.notAfter !== null && now >= root.notAfter)) {
    fail('AGG_TRUST_ROOT_OUTSIDE_VALIDITY', `trusted key ${root.keyId} is outside its current validity window`);
  }
  if (issuedAt !== undefined) {
    if (!Number.isFinite(issuedAt) || issuedAt < root.notBefore || (root.notAfter !== null && issuedAt >= root.notAfter)) {
      fail('AGG_TRUST_ROOT_ISSUED_OUTSIDE_VALIDITY', `attestation was issued outside key ${root.keyId}'s validity window`);
    }
  }
  if (root.scope !== configuration.scope) fail('AGG_TRUST_CONFIG_SCOPE_INVALID', `trusted key ${root.keyId} is not scoped to ${configuration.scope}`);
  return root;
}

export function isAdaptiveGoalTrustConfigurationProvided({ configJsonEnv, providerEnv, publicKeyEnv }) {
  return process.env[configJsonEnv] !== undefined ||
    (typeof process.env[providerEnv] === 'string' && process.env[providerEnv].trim() !== '' &&
     typeof process.env[publicKeyEnv] === 'string' && process.env[publicKeyEnv].trim() !== '');
}

export function assertAdaptiveGoalTrustDomainsDisjoint(sourceVerifier, actionReviewer) {
  if (!sourceVerifier || !actionReviewer) return true;
  if (sourceVerifier.providerId === actionReviewer.providerId) {
    fail('AGG_TRUST_DOMAINS_PROVIDER_COLLISION', 'Goal/Idea source verifier and action-intent reviewer must use distinct independently administered provider IDs');
  }
  const reviewerRootHashes = new Set(actionReviewer.roots.map(root => root.trustRootSha256));
  const shared = sourceVerifier.roots.filter(root => reviewerRootHashes.has(root.trustRootSha256)).map(root => root.trustRootSha256);
  if (shared.length) fail('AGG_TRUST_DOMAINS_ROOT_COLLISION', `Goal/Idea source verifier and action-intent reviewer share public trust roots: ${shared.join(', ')}`);
  return true;
}

/**
 * Enforce an append-only per-domain config high-water mark. The caller must
 * pass a dedicated trust-ledger DatabaseSync connection, not a connection
 * participating in a workflow approval transaction. This makes a revoked-key
 * rejection durable even when the workflow transaction rolls back.
 */
export function assertAndRecordAdaptiveGoalTrustConfiguration(db, configuration, { now = Date.now() } = {}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function' || db.isTransaction === true) {
    fail('AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE', 'trust configuration anti-rollback requires a dedicated non-transactional SQLite ledger connection');
  }
  if (!configuration || typeof configuration.domain !== 'string' || !Number.isSafeInteger(configuration.configVersion) ||
      typeof configuration.configurationFingerprint !== 'string' || !SHA256.test(configuration.configurationFingerprint) ||
      typeof configuration.providerId !== 'string' || !configuration.providerId) {
    fail('AGG_TRUST_CONFIG_LEDGER_INVALID_INPUT', 'refusing to register malformed trust configuration metadata');
  }
  initializeAdaptiveGoalTrustConfigurationLedger(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    const latest = db.prepare(`SELECT config_version,configuration_fingerprint,provider_id,config_updated_at
      FROM adaptive_goal_trust_configuration_history WHERE domain=? ORDER BY config_version DESC LIMIT 1`).get(configuration.domain);
    if (latest && configuration.configVersion < latest.config_version) {
      fail('AGG_TRUST_CONFIG_ROLLBACK', `trust domain ${configuration.domain} attempted rollback from config version ${latest.config_version} to ${configuration.configVersion}`);
    }
    if (latest && configuration.configVersion === latest.config_version) {
      if (configuration.configurationFingerprint !== latest.configuration_fingerprint || configuration.providerId !== latest.provider_id) {
        fail('AGG_TRUST_CONFIG_VERSION_REUSED', `trust root configuration for domain ${configuration.domain} reused config version ${configuration.configVersion} with different canonical metadata or public roots`);
      }
      db.exec('COMMIT');
      return { recorded: false, idempotent: true, domain: configuration.domain, configVersion: latest.config_version,
        configurationFingerprint: latest.configuration_fingerprint };
    }
    if (latest?.config_updated_at && configuration.configUpdatedAt &&
        Date.parse(configuration.configUpdatedAt) < Date.parse(latest.config_updated_at)) {
      fail('AGG_TRUST_CONFIG_TIME_ROLLBACK', `trust domain ${configuration.domain} config_updated_at moved backwards while config_version increased`);
    }
      const rootManifest = JSON.stringify(configuration.roots.map(root => ({ keyId: root.keyId, trustRootSha256: root.trustRootSha256,
        scope: root.scope, notBefore: root.notBeforeIso, notAfter: root.notAfterIso, revokedAt: root.revokedAtIso })));
      db.prepare(`INSERT INTO adaptive_goal_trust_configuration_history
      (domain,config_version,configuration_fingerprint,provider_id,config_updated_at,config_updated_by,config_change_reference,configuration_source,root_manifest_json,observed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(configuration.domain, configuration.configVersion, configuration.configurationFingerprint,
        configuration.providerId, configuration.configUpdatedAt, configuration.configUpdatedBy, configuration.configChangeReference,
        configuration.configurationSource, rootManifest, new Date(now).toISOString());
    db.exec('COMMIT');
    return { recorded: true, idempotent: false, domain: configuration.domain, configVersion: configuration.configVersion,
      configurationFingerprint: configuration.configurationFingerprint };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    if (typeof error?.code === 'string' && error.code.startsWith('AGG_TRUST_CONFIG_') &&
        !['AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE', 'AGG_TRUST_CONFIG_LEDGER_INVALID_INPUT'].includes(error.code)) {
      try {
        db.prepare(`INSERT INTO adaptive_goal_trust_configuration_events
          (event_id,domain,event_type,attempted_config_version,configuration_fingerprint,provider_id,config_change_reference,reason_code,reason_message,observed_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), configuration.domain, 'configuration_rejected', configuration.configVersion,
            configuration.configurationFingerprint, configuration.providerId, configuration.configChangeReference, error.code,
            String(error.message || error).slice(0, 1000), new Date(now).toISOString());
      } catch { /* Never mask the original fail-closed trust rejection. */ }
    }
    throw error;
  }
}

export function initializeAdaptiveGoalTrustConfigurationLedger(db) {
  if (!db || typeof db.exec !== 'function' || db.isTransaction === true) {
    fail('AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE', 'trust configuration ledger initialization requires a dedicated SQLite connection');
  }
  db.exec(TRUST_CONFIG_LEDGER_SCHEMA);
  const columns = new Set(db.prepare('PRAGMA table_info(adaptive_goal_trust_configuration_history)').all().map(row => row.name));
  if (!columns.has('root_manifest_json')) db.exec("ALTER TABLE adaptive_goal_trust_configuration_history ADD COLUMN root_manifest_json TEXT NOT NULL DEFAULT '[]'");
  return true;
}

export function inspectAdaptiveGoalTrustConfigurationHistory(db, domain, configuration) {
  if (!db || typeof db.prepare !== 'function') return { status: 'unavailable', blocker: 'AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE' };
  try {
    const latest = db.prepare(`SELECT config_version,configuration_fingerprint,provider_id,config_updated_at,config_updated_by,config_change_reference,configuration_source,observed_at
      FROM adaptive_goal_trust_configuration_history WHERE domain=? ORDER BY config_version DESC LIMIT 1`).get(domain);
    if (!latest) return { status: 'not_yet_observed', latest: null, current: { configVersion: configuration?.configVersion ?? null,
      configurationFingerprint: configuration?.configurationFingerprint ?? null } };
    if (!configuration) return { status: 'current_configuration_invalid', latest };
    if (configuration.configVersion < latest.config_version) return { status: 'rollback_detected', code: 'AGG_TRUST_CONFIG_ROLLBACK', latest,
      current: { configVersion: configuration.configVersion, configurationFingerprint: configuration.configurationFingerprint } };
    if (configuration.configVersion === latest.config_version &&
        (configuration.configurationFingerprint !== latest.configuration_fingerprint || configuration.providerId !== latest.provider_id)) {
      return { status: 'version_reused', code: 'AGG_TRUST_CONFIG_VERSION_REUSED', latest,
        current: { configVersion: configuration.configVersion, configurationFingerprint: configuration.configurationFingerprint } };
    }
    if (configuration.configVersion > latest.config_version && latest.config_updated_at && configuration.configUpdatedAt &&
        Date.parse(configuration.configUpdatedAt) < Date.parse(latest.config_updated_at)) {
      return { status: 'time_rollback_detected', code: 'AGG_TRUST_CONFIG_TIME_ROLLBACK', latest,
        current: { configVersion: configuration.configVersion, configurationFingerprint: configuration.configurationFingerprint } };
    }
    return { status: 'current_or_forward', latest, current: { configVersion: configuration.configVersion,
      configurationFingerprint: configuration.configurationFingerprint } };
  } catch (error) {
    return { status: 'unavailable', code: 'AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE', message: String(error?.message || error) };
  }
}

export function adaptiveGoalTrustConfigurationStatus(configuration) {
  if (!configuration) return { available: false, blockers: [{ code: 'AGG_TRUST_CONFIG_NOT_CONFIGURED', message: 'no trust configuration was loaded' }] };
  return {
    available: configuration.available,
    domain: configuration.domain,
    providerId: configuration.providerId,
    scope: configuration.scope,
    configVersion: configuration.configVersion,
    configurationFingerprint: configuration.configurationFingerprint,
    configurationSource: configuration.configurationSource,
    configUpdatedAt: configuration.configUpdatedAt,
    configUpdatedBy: configuration.configUpdatedBy,
    configChangeReference: configuration.configChangeReference,
    roots: configuration.roots.map(root => ({ keyId: root.keyId, trustRootSha256: root.trustRootSha256,
      scope: root.scope, notBefore: root.notBeforeIso, notAfter: root.notAfterIso, revokedAt: root.revokedAtIso,
      usableNow: root.usableNow })),
    blockers: configuration.blockers
  };
}
