import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  adaptiveGoalPublicKeyFingerprint,
  assertAndRecordAdaptiveGoalTrustConfiguration,
  adaptiveGoalTrustConfigurationStatus,
  assertAdaptiveGoalTrustDomainsDisjoint,
  findAdaptiveGoalTrustedRoot,
  isAdaptiveGoalTrustConfigurationProvided,
  inspectAdaptiveGoalTrustConfigurationHistory,
  loadAdaptiveGoalTrustConfiguration
} from '../src/runtime/adaptive-goal-trust-configuration.js';

const KNOWLEDGE = {
  configJsonEnv: 'TEST_AGG_KNOWLEDGE_TRUST_CONFIG_JSON', providerEnv: 'TEST_AGG_KNOWLEDGE_PROVIDER',
  publicKeyEnv: 'TEST_AGG_KNOWLEDGE_PUBLIC_KEY', domain: 'goal_idea_verifier', scope: 'agg.goal_idea_graph.verify'
};
const REVIEWER = {
  configJsonEnv: 'TEST_AGG_REVIEWER_TRUST_CONFIG_JSON', providerEnv: 'TEST_AGG_REVIEWER_PROVIDER',
  publicKeyEnv: 'TEST_AGG_REVIEWER_PUBLIC_KEY', domain: 'action_intent_reviewer', scope: 'agg.action_intent.review'
};
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR_CLI = path.join(REPO_ROOT, 'scripts/validate-agg-trust-config.mjs');

function root() {
  const pair = generateKeyPairSync('ed25519');
  return { pair, pem: pair.publicKey.export({ type: 'spki', format: 'pem' }) };
}
function entry(keyId, publicKeyPem, { scope = KNOWLEDGE.scope, revokedAt = null, notBefore, notAfter = null } = {}) {
  const now = Date.now();
  return {
    key_id: keyId, public_key_pem: publicKeyPem, scopes: [scope],
    not_before: notBefore || new Date(now - 60_000).toISOString(),
    not_after: notAfter,
    revoked_at: revokedAt
  };
}
function config(domain, providerId, keys, overrides = {}) {
  return {
    schema_version: 1, domain, provider_id: providerId, config_version: 1,
    updated_at: new Date(Date.now() - 1_000).toISOString(), updated_by: 'security-admin-fixture',
    change_reference: 'SEC-TEST-42', keys, ...overrides
  };
}
function withConfig(t, env, value) {
  const prior = process.env[env.configJsonEnv];
  const priorProvider = process.env[env.providerEnv];
  const priorKey = process.env[env.publicKeyEnv];
  if (value === undefined) delete process.env[env.configJsonEnv];
  else process.env[env.configJsonEnv] = typeof value === 'string' ? value : JSON.stringify(value);
  delete process.env[env.providerEnv];
  delete process.env[env.publicKeyEnv];
  t.after(() => {
    if (prior === undefined) delete process.env[env.configJsonEnv]; else process.env[env.configJsonEnv] = prior;
    if (priorProvider === undefined) delete process.env[env.providerEnv]; else process.env[env.providerEnv] = priorProvider;
    if (priorKey === undefined) delete process.env[env.publicKeyEnv]; else process.env[env.publicKeyEnv] = priorKey;
  });
}
function load(env = KNOWLEDGE, now = Date.now()) {
  return loadAdaptiveGoalTrustConfiguration({ ...env, now });
}

test('accepts a schema-valid scoped trust set and exposes fingerprints, key IDs and admin change metadata without PEM material', t => {
  const key = root();
  withConfig(t, KNOWLEDGE, config(KNOWLEDGE.domain, 'independent-source-verifier', [entry('source-2026-a', key.pem)]));
  const loaded = load();
  const status = adaptiveGoalTrustConfigurationStatus(loaded);
  assert.equal(status.available, true);
  assert.equal(status.providerId, 'independent-source-verifier');
  assert.equal(status.configVersion, 1);
  assert.equal(status.configUpdatedBy, 'security-admin-fixture');
  assert.equal(status.configChangeReference, 'SEC-TEST-42');
  assert.equal(status.roots[0].keyId, 'source-2026-a');
  assert.equal(status.roots[0].scope, KNOWLEDGE.scope);
  assert.equal(JSON.stringify(status).includes(key.pem), false);
  assert.equal(findAdaptiveGoalTrustedRoot(loaded, status.roots[0].trustRootSha256).keyId, 'source-2026-a');
});

test('supports controlled overlap rotation, then immediately rejects a revoked or out-of-window old key', t => {
  const first = root();
  const second = root();
  const now = Date.now();
  const overlapping = config(KNOWLEDGE.domain, 'independent-source-verifier', [entry('source-old', first.pem), entry('source-new', second.pem)]);
  withConfig(t, KNOWLEDGE, overlapping);
  const loaded = load(KNOWLEDGE, now);
  assert.equal(loaded.roots.length, 2);
  assert.equal(findAdaptiveGoalTrustedRoot(loaded, loaded.roots[0].trustRootSha256, { issuedAt: now, now }).keyId, 'source-old');
  assert.equal(findAdaptiveGoalTrustedRoot(loaded, loaded.roots[1].trustRootSha256, { issuedAt: now, now }).keyId, 'source-new');

  const revoked = config(KNOWLEDGE.domain, 'independent-source-verifier', [
    entry('source-old', first.pem, { revokedAt: new Date(now - 1_000).toISOString() }), entry('source-new', second.pem)
  ], { config_version: 2 });
  process.env[KNOWLEDGE.configJsonEnv] = JSON.stringify(revoked);
  const reloaded = load(KNOWLEDGE, now);
  assert.throws(() => findAdaptiveGoalTrustedRoot(reloaded, reloaded.roots.find(item => item.keyId === 'source-old').trustRootSha256, { issuedAt: now, now }),
    error => error.code === 'AGG_TRUST_ROOT_REVOKED');
  const expiredConfig = config(KNOWLEDGE.domain, 'independent-source-verifier', [
    entry('source-expired', first.pem, { notBefore: new Date(now - 3_600_000).toISOString(), notAfter: new Date(now - 1_000).toISOString() })
  ]);
  process.env[KNOWLEDGE.configJsonEnv] = JSON.stringify(expiredConfig);
  assert.throws(() => findAdaptiveGoalTrustedRoot(load(KNOWLEDGE, now), KNOWLEDGE.scope, { issuedAt: now, now }),
    error => error.code === 'AGG_TRUST_CONFIG_UNAVAILABLE');
});

test('fails closed on absent, empty, malformed or duplicate-key JSON config and never falls back if the JSON variable is set', t => {
  withConfig(t, KNOWLEDGE, undefined);
  assert.throws(() => load(), error => error.code === 'AGG_TRUST_CONFIG_NOT_CONFIGURED');
  process.env[KNOWLEDGE.configJsonEnv] = '';
  process.env[KNOWLEDGE.providerEnv] = 'legacy-provider';
  process.env[KNOWLEDGE.publicKeyEnv] = root().pem;
  assert.throws(() => load(), error => error.code === 'AGG_TRUST_CONFIG_NOT_CONFIGURED',
    'a blank optional host-config field must report missing administration input and must not fall back to the legacy public root');
  process.env[KNOWLEDGE.configJsonEnv] = '${user_config.goal_idea_verifier_trust_config_json}';
  assert.throws(() => load(), error => error.code === 'AGG_TRUST_CONFIG_NOT_CONFIGURED',
    'a host that fails to interpolate the MCPB user_config token must be diagnosed as missing configuration, not as a valid config or an allowed legacy fallback');
  process.env[KNOWLEDGE.configJsonEnv] = '{"schema_version":1,"schema_version":1}';
  assert.throws(() => load(), /duplicate decoded object key/);
});

test('optional host JSON fields are absent for blank or unresolved placeholders without enabling legacy fallback', t => {
  const oldJson = process.env.AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON;
  const oldProvider = process.env.AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID;
  const oldPem = process.env.AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM;
  t.after(() => {
    if (oldJson === undefined) delete process.env.AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON;
    else process.env.AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON = oldJson;
    if (oldProvider === undefined) delete process.env.AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID;
    else process.env.AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID = oldProvider;
    if (oldPem === undefined) delete process.env.AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM;
    else process.env.AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM = oldPem;
  });
  const options = { configJsonEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON',
    providerEnv: 'AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID', publicKeyEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM' };
  process.env[options.configJsonEnv] = '';
  process.env[options.providerEnv] = 'legacy-provider-must-not-fallback';
  process.env[options.publicKeyEnv] = root().pem;
  assert.equal(isAdaptiveGoalTrustConfigurationProvided(options), false,
    'blank optional user_config is not a supplied peer domain');
  assert.throws(() => load({ ...KNOWLEDGE, configJsonEnv: options.configJsonEnv,
    providerEnv: options.providerEnv, publicKeyEnv: options.publicKeyEnv }),
  error => error.code === 'AGG_TRUST_CONFIG_NOT_CONFIGURED', 'the domain loader must still suppress legacy fallback');
  process.env[options.configJsonEnv] = '${user_config.goal_idea_verifier_trust_config_json}';
  assert.equal(isAdaptiveGoalTrustConfigurationProvided(options), true,
    'a non-empty unresolved placeholder must trigger fail-closed peer validation instead of being silently ignored');
  process.env[options.configJsonEnv] = '{';
  assert.equal(isAdaptiveGoalTrustConfigurationProvided(options), true,
    'non-empty malformed JSON is supplied input and must cause a fail-closed peer validation');
});

test('rejects unknown fields, invalid Ed25519 roots, repeated IDs/fingerprints, wrong scope and windows', t => {
  const a = root(); const b = root();
  const valid = config(KNOWLEDGE.domain, 'source-provider', [entry('source-a', a.pem)]);
  withConfig(t, KNOWLEDGE, valid);
  process.env[KNOWLEDGE.configJsonEnv] = JSON.stringify({ ...valid, surprise: true });
  assert.throws(() => load(), error => error.code === 'AGG_TRUST_CONFIG_SCHEMA_INVALID');
  process.env[KNOWLEDGE.configJsonEnv] = JSON.stringify(config(KNOWLEDGE.domain, 'source-provider', [entry('bad-pem', 'not a public key')]));
  assert.throws(() => load(), error => error.code === 'AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID');
  process.env[KNOWLEDGE.configJsonEnv] = JSON.stringify(config(KNOWLEDGE.domain, 'source-provider', [entry('same-id', a.pem), entry('same-id', b.pem)]));
  assert.throws(() => load(), error => error.code === 'AGG_TRUST_CONFIG_KEY_ID_INVALID');
  process.env[KNOWLEDGE.configJsonEnv] = JSON.stringify(config(KNOWLEDGE.domain, 'source-provider', [entry('same-root-a', a.pem), entry('same-root-b', a.pem)]));
  assert.throws(() => load(), error => error.code === 'AGG_TRUST_CONFIG_DUPLICATE_ROOT');
  process.env[KNOWLEDGE.configJsonEnv] = JSON.stringify(config(KNOWLEDGE.domain, 'source-provider', [entry('wrong-scope', b.pem, { scope: REVIEWER.scope })]));
  assert.throws(() => load(), error => error.code === 'AGG_TRUST_CONFIG_SCOPE_INVALID');
  const invalidWindow = entry('bad-window', b.pem, { notBefore: new Date(Date.now() + 10_000).toISOString(), notAfter: new Date(Date.now() - 10_000).toISOString() });
  process.env[KNOWLEDGE.configJsonEnv] = JSON.stringify(config(KNOWLEDGE.domain, 'source-provider', [invalidWindow]));
  assert.throws(() => load(), error => error.code === 'AGG_TRUST_CONFIG_KEY_WINDOW_INVALID');
});

test('pins domains to distinct provider IDs and disjoint public roots', t => {
  const source = root(); const reviewer = root();
  withConfig(t, KNOWLEDGE, config(KNOWLEDGE.domain, 'source-provider', [entry('source-key', source.pem)]));
  withConfig(t, REVIEWER, config(REVIEWER.domain, 'review-provider', [entry('review-key', reviewer.pem, { scope: REVIEWER.scope })]));
  const sourceConfig = load(KNOWLEDGE);
  const reviewerConfig = load(REVIEWER);
  assert.equal(assertAdaptiveGoalTrustDomainsDisjoint(sourceConfig, reviewerConfig), true);
  const collidingProvider = { ...reviewerConfig, providerId: sourceConfig.providerId };
  assert.throws(() => assertAdaptiveGoalTrustDomainsDisjoint(sourceConfig, collidingProvider), error => error.code === 'AGG_TRUST_DOMAINS_PROVIDER_COLLISION');
  const collidingRoot = { ...reviewerConfig, roots: [{ ...reviewerConfig.roots[0], trustRootSha256: sourceConfig.roots[0].trustRootSha256 }] };
  assert.throws(() => assertAdaptiveGoalTrustDomainsDisjoint(sourceConfig, collidingRoot), error => error.code === 'AGG_TRUST_DOMAINS_ROOT_COLLISION');
});

test('canonical SPKI fingerprints prevent one Ed25519 key encoded as different PEM bytes from crossing trust domains', t => {
  const pair = root();
  const alternatePem = `\n${pair.pem.trim()}\n\n`;
  assert.notEqual(alternatePem, pair.pem, 'fixture must vary PEM envelope bytes');
  const sourceFingerprint = adaptiveGoalPublicKeyFingerprint(pair.pem);
  assert.equal(adaptiveGoalPublicKeyFingerprint(alternatePem), sourceFingerprint,
    'SHA-256 fingerprint must derive from canonical DER/SPKI bytes, not PEM presentation');

  withConfig(t, KNOWLEDGE, config(KNOWLEDGE.domain, 'independent-source-provider', [entry('source-key', pair.pem)]));
  withConfig(t, REVIEWER, config(REVIEWER.domain, 'independent-reviewer-provider', [entry('review-key', alternatePem, { scope: REVIEWER.scope })]));
  const sourceConfiguration = load(KNOWLEDGE);
  const reviewerConfiguration = load(REVIEWER);
  assert.equal(sourceConfiguration.roots[0].trustRootSha256, reviewerConfiguration.roots[0].trustRootSha256);
  assert.throws(() => assertAdaptiveGoalTrustDomainsDisjoint(sourceConfiguration, reviewerConfiguration),
    error => error.code === 'AGG_TRUST_DOMAINS_ROOT_COLLISION');

  const duplicatePemConfig = config(KNOWLEDGE.domain, 'source-provider', [
    entry('source-key-a', pair.pem), entry('source-key-b', alternatePem)
  ]);
  process.env[KNOWLEDGE.configJsonEnv] = JSON.stringify(duplicatePemConfig);
  assert.throws(() => load(KNOWLEDGE), error => error.code === 'AGG_TRUST_CONFIG_DUPLICATE_ROOT');
});

test('rejects future-dated configurations and signatures issued outside an otherwise trusted key window', t => {
  const key = root();
  const future = config(KNOWLEDGE.domain, 'source-provider', [entry('future-key', key.pem)], { updated_at: new Date(Date.now() + 120_000).toISOString() });
  withConfig(t, KNOWLEDGE, future);
  assert.throws(() => load(), error => error.code === 'AGG_TRUST_CONFIG_FUTURE_DATED');
  const now = Date.now();
  const windowed = config(KNOWLEDGE.domain, 'source-provider', [entry('window-key', key.pem,
    { notBefore: new Date(now - 60_000).toISOString(), notAfter: new Date(now + 60_000).toISOString() })]);
  process.env[KNOWLEDGE.configJsonEnv] = JSON.stringify(windowed);
  const loaded = load(KNOWLEDGE, now);
  assert.throws(() => findAdaptiveGoalTrustedRoot(loaded, loaded.roots[0].trustRootSha256, { issuedAt: now - 120_000, now }),
    error => error.code === 'AGG_TRUST_ROOT_ISSUED_OUTSIDE_VALIDITY');
});

test('durable per-domain ledger rejects rollback, skipped versions, same-version root replacement and timestamp rollback', t => {
  const primary = root(); const rotated = root();
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const v1 = config(KNOWLEDGE.domain, 'source-admin', [entry('source-primary', primary.pem)], { updated_at: new Date(Date.now() - 20_000).toISOString() });
  withConfig(t, KNOWLEDGE, v1);
  const loadedV1 = load();
  assert.equal(assertAndRecordAdaptiveGoalTrustConfiguration(db, loadedV1).recorded, true);
  assert.equal(inspectAdaptiveGoalTrustConfigurationHistory(db, KNOWLEDGE.domain, loadedV1).status, 'current_or_forward');
  const firstHistory = db.prepare('SELECT root_manifest_json FROM adaptive_goal_trust_configuration_history WHERE domain=? AND config_version=1').get(KNOWLEDGE.domain);
  assert.equal(JSON.parse(firstHistory.root_manifest_json)[0].keyId, 'source-primary');
  assert.equal(JSON.stringify(firstHistory).includes(primary.pem), false, 'accepted audit history stores only public-root fingerprints, not PEM bytes');

  const v2 = config(KNOWLEDGE.domain, 'source-admin', [entry('source-rotated', rotated.pem)], {
    config_version: 2, updated_at: new Date(Date.now() - 10_000).toISOString()
  });
  process.env[KNOWLEDGE.configJsonEnv] = JSON.stringify(v2);
  const loadedV2 = load();
  assert.equal(assertAndRecordAdaptiveGoalTrustConfiguration(db, loadedV2).recorded, true);
  assert.equal(assertAndRecordAdaptiveGoalTrustConfiguration(db, loadedV2).idempotent, true);
  assert.throws(() => assertAndRecordAdaptiveGoalTrustConfiguration(db, loadedV1), error => error.code === 'AGG_TRUST_CONFIG_ROLLBACK');
  assert.equal(inspectAdaptiveGoalTrustConfigurationHistory(db, KNOWLEDGE.domain, loadedV1).status, 'rollback_detected');
  const rejection = db.prepare(`SELECT reason_code,attempted_config_version FROM adaptive_goal_trust_configuration_events
    WHERE domain=? ORDER BY observed_at DESC LIMIT 1`).get(KNOWLEDGE.domain);
  assert.equal(rejection.reason_code, 'AGG_TRUST_CONFIG_ROLLBACK');
  assert.equal(rejection.attempted_config_version, 1);

  const skippedVersion = config(KNOWLEDGE.domain, 'source-admin', [entry('source-skipped', primary.pem)], {
    config_version: 4, updated_at: new Date(Date.now() - 1_000).toISOString()
  });
  process.env[KNOWLEDGE.configJsonEnv] = JSON.stringify(skippedVersion);
  const loadedSkipped = load();
  assert.equal(inspectAdaptiveGoalTrustConfigurationHistory(db, KNOWLEDGE.domain, loadedSkipped).status, 'version_gap_detected');
  assert.throws(() => assertAndRecordAdaptiveGoalTrustConfiguration(db, loadedSkipped), error => error.code === 'AGG_TRUST_CONFIG_VERSION_GAP');
  const gapAudit = db.prepare(`SELECT reason_code,attempted_config_version FROM adaptive_goal_trust_configuration_events
    WHERE domain=? ORDER BY rowid DESC LIMIT 1`).get(KNOWLEDGE.domain);
  assert.equal(gapAudit.reason_code, 'AGG_TRUST_CONFIG_VERSION_GAP');
  assert.equal(gapAudit.attempted_config_version, 4);

  const sameVersionChanged = config(KNOWLEDGE.domain, 'source-admin', [entry('source-alternate', primary.pem)], {
    config_version: 2, updated_at: new Date(Date.now() - 5_000).toISOString()
  });
  process.env[KNOWLEDGE.configJsonEnv] = JSON.stringify(sameVersionChanged);
  assert.throws(() => assertAndRecordAdaptiveGoalTrustConfiguration(db, load()), error => error.code === 'AGG_TRUST_CONFIG_VERSION_REUSED');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM adaptive_goal_trust_configuration_events WHERE reason_code='AGG_TRUST_CONFIG_VERSION_REUSED'`).get().count, 1);

  const timeRollback = config(KNOWLEDGE.domain, 'source-admin', [entry('source-next', primary.pem)], {
    config_version: 3, updated_at: new Date(Date.now() - 30_000).toISOString()
  });
  process.env[KNOWLEDGE.configJsonEnv] = JSON.stringify(timeRollback);
  assert.throws(() => assertAndRecordAdaptiveGoalTrustConfiguration(db, load()), error => error.code === 'AGG_TRUST_CONFIG_TIME_ROLLBACK');
});

test('trust configuration high-water and rejection audit survive reopening the durable ledger', t => {
  const first = root(); const second = root();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-trust-ledger-reopen-'));
  fs.chmodSync(directory, 0o700);
  const databasePath = path.join(directory, 'trust-ledger.db');
  const v1 = config(KNOWLEDGE.domain, 'persistent-source-provider', [entry('source-v1', first.pem)], {
    config_version: 1, updated_at: new Date(Date.now() - 20_000).toISOString()
  });
  const v2 = config(KNOWLEDGE.domain, 'persistent-source-provider', [entry('source-v2', second.pem)], {
    config_version: 2, updated_at: new Date(Date.now() - 10_000).toISOString()
  });
  withConfig(t, KNOWLEDGE, v2);
  try {
    let db = new DatabaseSync(databasePath);
    assertAndRecordAdaptiveGoalTrustConfiguration(db, load());
    db.close(); // model a complete runtime shutdown/reopen boundary

    process.env[KNOWLEDGE.configJsonEnv] = JSON.stringify(v1);
    db = new DatabaseSync(databasePath);
    assert.equal(inspectAdaptiveGoalTrustConfigurationHistory(db, KNOWLEDGE.domain, load()).status, 'rollback_detected');
    assert.throws(() => assertAndRecordAdaptiveGoalTrustConfiguration(db, load()), error => error.code === 'AGG_TRUST_CONFIG_ROLLBACK');
    const audit = db.prepare(`SELECT reason_code,attempted_config_version FROM adaptive_goal_trust_configuration_events
      WHERE domain=? ORDER BY rowid DESC LIMIT 1`).get(KNOWLEDGE.domain);
    assert.equal(audit.reason_code, 'AGG_TRUST_CONFIG_ROLLBACK');
    assert.equal(audit.attempted_config_version, 1);
    db.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('trust config ledger refuses to run on a workflow connection already in a transaction', t => {
  const key = root(); const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  withConfig(t, KNOWLEDGE, config(KNOWLEDGE.domain, 'source-admin', [entry('source-key', key.pem)]));
  db.exec('BEGIN IMMEDIATE');
  assert.throws(() => assertAndRecordAdaptiveGoalTrustConfiguration(db, load()), error => error.code === 'AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE');
  db.exec('ROLLBACK');
});

test('operator validation CLI checks a supplied file without changing trust/runtime state', { skip: !fs.existsSync(VALIDATOR_CLI) }, t => {
  const source = root();
  const document = config(KNOWLEDGE.domain, 'cli-source-provider', [entry('cli-source-key', source.pem)]);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-trust-config-cli-'));
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, 'source-verifier-trust.json');
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  const env = { ...process.env };
  for (const name of [
    'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON', 'AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID',
    'AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM', 'AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON',
    'AGG_REVIEW_IDENTITY_PROVIDER_ID', 'AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM'
  ]) delete env[name];
  try {
    const good = spawnSync(process.execPath, [VALIDATOR_CLI, '--domain', 'goal_idea_verifier', '--config', file], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000, env
    });
    assert.equal(good.status, 0, good.stderr || good.stdout);
    const report = JSON.parse(good.stdout);
    assert.equal(report.result, 'PASS');
    assert.equal(report.domain, KNOWLEDGE.domain);
    assert.equal(report.configurationSource, 'admin_json_environment');
    assert.equal(report.fileSha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(report.pairVerification.status, 'SINGLE_CONFIGURATION_ONLY',
      'a one-file PASS must not be confused with deployment-pair verification');
    assert.equal(JSON.stringify(report).includes(source.pem), false, 'CLI output must not echo even the public PEM document');
    assert.deepEqual(fs.readFileSync(file), bytes, 'validation must not edit or normalize the administrator file');

    const requiredPair = spawnSync(process.execPath, [VALIDATOR_CLI, '--domain', 'goal_idea_verifier', '--config', file, '--require-peer-config'], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000, env
    });
    assert.equal(requiredPair.status, 3, requiredPair.stderr || requiredPair.stdout);
    assert.equal(JSON.parse(requiredPair.stdout).code, 'AGG_TRUST_CONFIG_PAIR_REQUIRED',
      'production operator validation must fail closed if the peer trust domain is omitted');

    const reviewer = root();
    const reviewerDocument = config(REVIEWER.domain, 'cli-reviewer-provider', [entry('cli-reviewer-key', reviewer.pem, { scope: REVIEWER.scope })]);
    const reviewerFile = path.join(directory, 'reviewer-trust.json');
    fs.writeFileSync(reviewerFile, `${JSON.stringify(reviewerDocument, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const pair = spawnSync(process.execPath, [VALIDATOR_CLI, '--domain', 'goal_idea_verifier', '--config', file, '--peer-config', reviewerFile], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000, env
    });
    assert.equal(pair.status, 0, pair.stderr || pair.stdout);
    const pairReport = JSON.parse(pair.stdout);
    assert.equal(pairReport.pairVerification.verified, true);
    assert.equal(pairReport.pairVerification.status, 'PAIR_SEPARATION_VERIFIED');
    assert.equal(pairReport.pairVerification.providerIdsDistinct, true);
    assert.equal(pairReport.pairVerification.publicRootsDisjoint, true);
    assert.equal(JSON.stringify(pairReport).includes(reviewer.pem), false);

    const collisionFile = path.join(directory, 'reviewer-collision.json');
    fs.writeFileSync(collisionFile, `${JSON.stringify({ ...reviewerDocument, keys: [entry('collision-key', source.pem, { scope: REVIEWER.scope })] }, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 });
    const collision = spawnSync(process.execPath, [VALIDATOR_CLI, '--domain', 'goal_idea_verifier', '--config', file, '--peer-config', collisionFile], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000, env
    });
    assert.equal(collision.status, 2, collision.stderr || collision.stdout);
    assert.match(collision.stderr, /trust-domain separation failed/);

    const aliasDirectory = path.join(directory, 'alias-parent');
    fs.symlinkSync(directory, aliasDirectory, 'dir');
    const symlinkedParent = spawnSync(process.execPath, [VALIDATOR_CLI, '--domain', 'goal_idea_verifier', '--config', path.join(aliasDirectory, 'source-verifier-trust.json')], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000, env
    });
    assert.equal(symlinkedParent.status, 2, symlinkedParent.stderr || symlinkedParent.stdout);
    assert.match(symlinkedParent.stderr, /canonical regular non-symlink/);

    const symlinkedFile = path.join(directory, 'source-trust-symlink.json');
    fs.symlinkSync(file, symlinkedFile, 'file');
    const finalComponentSymlink = spawnSync(process.execPath, [VALIDATOR_CLI, '--domain', 'goal_idea_verifier', '--config', symlinkedFile], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000, env
    });
    assert.equal(finalComponentSymlink.status, 2, finalComponentSymlink.stderr || finalComponentSymlink.stdout);
    assert.match(finalComponentSymlink.stderr, /canonical regular non-symlink/);

    const invalidFile = path.join(directory, 'invalid-trust.json');
    fs.writeFileSync(invalidFile, JSON.stringify({ ...document, domain: REVIEWER.domain }), { flag: 'wx', mode: 0o600 });
    const bad = spawnSync(process.execPath, [VALIDATOR_CLI, '--domain', 'goal_idea_verifier', '--config', invalidFile], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000, env
    });
    assert.equal(bad.status, 2, bad.stderr || bad.stdout);
    assert.match(bad.stderr, /AGG_TRUST_CONFIG_SCHEMA_INVALID/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
