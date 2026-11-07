import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { main as runTrustConfigValidator } from '../scripts/validate-agg-trust-config.mjs';
import { ADAPTIVE_GOAL_TRUST_DOMAIN_SPECS } from '../src/runtime/adaptive-goal-trust-domains.js';
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

test('the five-domain registry and MCPB manifest mappings stay in exact agreement', () => {
  const sourceManifest = path.join(REPO_ROOT, 'plugin/manifest.json');
  const extractedManifest = path.join(REPO_ROOT, 'manifest.json');
  const manifestPath = fs.existsSync(sourceManifest) ? sourceManifest : extractedManifest;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const configuredEnvironment = manifest.server?.mcp_config?.env || {};
  const userConfigNames = {
    goal_idea_verifier: 'goal_idea_verifier_trust_config_json',
    action_intent_reviewer: 'action_intent_reviewer_trust_config_json',
    execution_approval_policy: 'approval_policy_trust_config_json',
    action_intent_maker: 'action_intent_maker_trust_config_json',
    execution_approval: 'execution_approval_trust_config_json'
  };
  assert.equal(ADAPTIVE_GOAL_TRUST_DOMAIN_SPECS.length, 5);
  for (const spec of ADAPTIVE_GOAL_TRUST_DOMAIN_SPECS) {
    assert.equal(configuredEnvironment[spec.configJsonEnv], String.fromCharCode(36) + `{user_config.${userConfigNames[spec.domain]}}`,
      `manifest mapping missing/drifted for ${spec.domain}`);
  }
  const expectedVariables = ADAPTIVE_GOAL_TRUST_DOMAIN_SPECS.map(spec => spec.configJsonEnv).sort();
  const actualVariables = Object.keys(configuredEnvironment).filter(name => name.endsWith('_TRUST_CONFIG_JSON')).sort();
  assert.deepEqual(actualVariables, expectedVariables,
    'the manifest must not add or omit a host trust domain without updating the shared registry');
});

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

test('distinguishes trust schema/config-version mismatch from ordinary field-schema violations', t => {
  const key = root();
  const valid = config(KNOWLEDGE.domain, 'version-contract-provider', [entry('version-contract-key', key.pem)]);
  withConfig(t, KNOWLEDGE, valid);
  process.env[KNOWLEDGE.configJsonEnv] = JSON.stringify({ ...valid, schema_version: 2 });
  assert.throws(() => load(), error => error.code === 'AGG_TRUST_CONFIG_VERSION_INVALID');
  process.env[KNOWLEDGE.configJsonEnv] = JSON.stringify({ ...valid, config_version: 0 });
  assert.throws(() => load(), error => error.code === 'AGG_TRUST_CONFIG_VERSION_INVALID');
  process.env[KNOWLEDGE.configJsonEnv] = JSON.stringify({ ...valid, unexpected: true });
  assert.throws(() => load(), error => error.code === 'AGG_TRUST_CONFIG_SCHEMA_INVALID');
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

test('operator validator requires and validates all five disjoint trust domains', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-trust-five-domain-cli-'));
  fs.chmodSync(directory, 0o700);
  const files = new Map();
  const documents = new Map();
  for (const spec of ADAPTIVE_GOAL_TRUST_DOMAIN_SPECS) {
    const key = root();
    const document = config(spec.domain, `five-domain-${spec.domain}-provider`,
      [entry(`five-domain-${spec.domain}-key`, key.pem, { scope: spec.scope })]);
    const file = path.join(directory, `${spec.domain}.json`);
    fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    files.set(spec.domain, file);
    documents.set(spec.domain, document);
  }
  const cliArgs = () => ADAPTIVE_GOAL_TRUST_DOMAIN_SPECS.flatMap(spec =>
    ['--trust-config', `${spec.domain}=${files.get(spec.domain)}`]);
  try {
    const pass = spawnSync(process.execPath, [VALIDATOR_CLI, ...cliArgs()], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000, env: { ...process.env }
    });
    assert.equal(pass.status, 0, pass.stderr || pass.stdout);
    const report = JSON.parse(pass.stdout);
    assert.equal(report.result, 'PASS');
    assert.equal(report.validationScope, 'ALL_FIVE_AGG_TRUST_DOMAINS');
    assert.equal(Object.keys(report.domains).length, 5);
    assert.equal(report.separation.providerIdsDistinct, true);
    assert.equal(report.separation.publicRootsDisjoint, true);
    assert.equal(report.productionTrustEstablished, false,
      'offline validation must not claim administrator provisioning or runtime trust');

    const source = documents.get('goal_idea_verifier');
    const maker = documents.get('action_intent_maker');
    const makerPath = files.get('action_intent_maker');
    const collision = { ...maker, keys: [{ ...maker.keys[0],
      public_key_pem: source.keys[0].public_key_pem, scopes: ['agg.action_intent.propose'] }] };
    fs.writeFileSync(makerPath, `${JSON.stringify(collision, null, 2)}\n`, { flag: 'w', mode: 0o600 });
    const rootCollision = spawnSync(process.execPath, [VALIDATOR_CLI, ...cliArgs()], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000, env: { ...process.env }
    });
    assert.equal(rootCollision.status, 3, rootCollision.stderr || rootCollision.stdout);
    assert.equal(JSON.parse(rootCollision.stdout).code, 'AGG_TRUST_DOMAINS_ROOT_COLLISION');

    const incomplete = cliArgs().slice(0, -2);
    const missing = spawnSync(process.execPath, [VALIDATOR_CLI, ...incomplete], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000, env: { ...process.env }
    });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /each of the five trust domains exactly once/);
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

    const missingFile = spawnSync(process.execPath, [VALIDATOR_CLI, '--domain', 'goal_idea_verifier', '--config', path.join(directory, 'missing.json')], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000, env
    });
    assert.equal(missingFile.status, 2);
    assert.equal(JSON.parse(missingFile.stderr).code, 'AGG_TRUST_CONFIG_FILE_MISSING');

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
    assert.equal(collision.status, 3, collision.stderr || collision.stdout);
    assert.equal(JSON.parse(collision.stdout).result, 'BLOCKED');
    assert.equal(JSON.parse(collision.stdout).code, 'AGG_TRUST_DOMAINS_ROOT_COLLISION');
    assert.equal(JSON.parse(collision.stdout).productionTrustEstablished, false);

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

test('operator validator compares all five domains but blocks unauthenticated host executable identity', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-trust-effective-host-five-'));
  fs.chmodSync(directory, 0o700);
  const documents = new Map();
  const files = new Map();
  const publicRoots = new Map();
  for (const spec of ADAPTIVE_GOAL_TRUST_DOMAIN_SPECS) {
    const key = root();
    const document = config(spec.domain, `effective-host-${spec.domain}-provider`,
      [entry(`effective-host-${spec.domain}-key`, key.pem, { scope: spec.scope })]);
    const file = path.join(directory, `${spec.domain}.json`);
    fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    documents.set(spec.domain, document);
    files.set(spec.domain, file);
    publicRoots.set(spec.domain, key.pem);
  }
  const source = documents.get('goal_idea_verifier');
  const sourcePem = publicRoots.get('goal_idea_verifier');
  const procRoot = path.join(directory, 'proc');
  const pid = '4242'; const ppid = '100';
  const entrypoint = path.join(directory, 'app', 'plugins', 'plugin-effective', 'g-rc71', 'server', 'index-v1.0.9-rc.71.js');
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true, mode: 0o700 });
  fs.writeFileSync(entrypoint, 'export {};\n', { flag: 'wx', mode: 0o600 });
  fs.mkdirSync(path.join(procRoot, pid), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(procRoot, ppid), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(procRoot, pid, 'cmdline'), `node\0${entrypoint}\0`, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(procRoot, pid, 'status'), `Name:\tnode\nPPid:\t${ppid}\n`, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(procRoot, ppid, 'cmdline'), '/opt/Chat On Steroids/chat-on-steroids\0', { flag: 'wx', mode: 0o600 });
  const procStat = (processId, command, parentPid, startTimeTicks) => {
    const fields = Array(20).fill('0');
    fields[0] = 'S';
    fields[1] = String(parentPid);
    fields[19] = String(startTimeTicks);
    return `${processId} (${command}) ${fields.join(' ')}\n`;
  };
  fs.writeFileSync(path.join(procRoot, pid, 'stat'), procStat(pid, 'node', ppid, 111), { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(procRoot, ppid, 'stat'), procStat(ppid, 'chat-on-steroids', '1', 222), { flag: 'wx', mode: 0o600 });
  fs.symlinkSync(process.execPath, path.join(procRoot, pid, 'exe'));
  const hostExecutable = path.join(directory, 'app', 'chat-on-steroids');
  fs.writeFileSync(hostExecutable, '#!/bin/sh\nexit 0\n', { flag: 'wx', mode: 0o700 });
  fs.symlinkSync(hostExecutable, path.join(procRoot, ppid, 'exe'));
  const trustEnv = Object.fromEntries(ADAPTIVE_GOAL_TRUST_DOMAIN_SPECS.map(spec =>
    [spec.configJsonEnv, fs.readFileSync(files.get(spec.domain), 'utf8')]));
  const writeEnvironment = values => fs.writeFileSync(path.join(procRoot, pid, 'environ'),
    Buffer.from(`${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\0')}\0`), { flag: 'w', mode: 0o600 });
  const validatorArgs = expectedEntryPoint => [
    ...ADAPTIVE_GOAL_TRUST_DOMAIN_SPECS.flatMap(spec => ['--trust-config', `${spec.domain}=${files.get(spec.domain)}`]),
    '--effective-host-pid', pid, '--effective-host-entrypoint', expectedEntryPoint
  ];
  const runEffective = (expectedEntryPoint, { readProcFile = fs.readFileSync } = {}) => {
    const savedEnv = { ...process.env };
    const savedExitCode = process.exitCode;
    const originalLog = console.log;
    const originalError = console.error;
    let stdout = ''; let stderr = '';
    console.log = (...values) => { stdout += `${values.join(' ')}\n`; };
    console.error = (...values) => { stderr += `${values.join(' ')}\n`; };
    process.exitCode = 0;
    try {
      runTrustConfigValidator(validatorArgs(expectedEntryPoint), { procRoot, readProcFile });
      return { status: process.exitCode || 0, stdout, stderr };
    } finally {
      for (const key of Object.keys(process.env)) if (!Object.hasOwn(savedEnv, key)) delete process.env[key];
      for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
      console.log = originalLog; console.error = originalError;
      process.exitCode = savedExitCode ?? 0;
    }
  };
  try {
    writeEnvironment(trustEnv);
    const pass = runEffective(entrypoint);
    assert.equal(pass.status, 3, pass.stderr || pass.stdout,
      'a matching environment under a caller-created executable named chat-on-steroids must not authenticate the host process');
    const passReport = JSON.parse(pass.stdout);
    assert.equal(passReport.result, 'BLOCKED');
    assert.equal(passReport.effectiveHostVerification.result, 'BLOCKED');
    assert.equal(passReport.effectiveHostVerification.code, 'AGG_TRUST_CONFIG_HOST_IDENTITY_AUTHORITY_REQUIRED');
    assert.equal(passReport.effectiveHostVerification.parentLooksLikeHost, true);
    assert.equal(passReport.effectiveHostVerification.parentExecutableIdentity.authenticated, false);
    assert.equal(passReport.effectiveHostVerification.parentExecutableIdentity.status,
      'UNVERIFIED_NO_EXTERNAL_HOST_IDENTITY_ANCHOR');
    assert.equal(passReport.effectiveHostVerification.effectiveSeparation.verified, true,
      'the five-domain configuration comparison remains useful but is not host identity attestation');
    assert.equal(Object.keys(passReport.effectiveHostVerification.domains).length, 5);
    for (const spec of ADAPTIVE_GOAL_TRUST_DOMAIN_SPECS) {
      assert.equal(passReport.effectiveHostVerification.domains[spec.domain].matchesSuppliedFile, true);
      assert.equal(passReport.effectiveHostVerification.domains[spec.domain].configJsonVariablePresent, true);
      assert.equal(passReport.effectiveHostVerification.domains[spec.domain].configJsonNonEmpty, true);
      assert.equal(passReport.effectiveHostVerification.domains[spec.domain].providerIdVariablePresent, false);
      assert.equal(passReport.effectiveHostVerification.domains[spec.domain].legacyPublicRootVariablePresent, false);
    }
    assert.equal(JSON.stringify(passReport).includes(sourcePem), false);
    assert.match(passReport.effectiveHostVerification.note, /basename\/cmdline are not an authenticated host identity/);
    assert.match(passReport.effectiveHostVerification.note, /does not verify active trust-ledger high-water rows or the external monotonic checkpoint/);

    // argv[0] is caller-controlled metadata. A spoofed host command line must
    // not pass when /proc/<ppid>/exe identifies an unrelated executable.
    fs.unlinkSync(path.join(procRoot, ppid, 'exe'));
    fs.symlinkSync(process.execPath, path.join(procRoot, ppid, 'exe'));
    const spoofedParentExecutable = runEffective(entrypoint);
    assert.equal(spoofedParentExecutable.status, 3, spoofedParentExecutable.stderr || spoofedParentExecutable.stdout);
    assert.equal(JSON.parse(spoofedParentExecutable.stdout).effectiveHostVerification.code,
      'AGG_TRUST_CONFIG_HOST_OWNER_UNVERIFIED');
    fs.unlinkSync(path.join(procRoot, ppid, 'exe'));
    fs.symlinkSync(hostExecutable, path.join(procRoot, ppid, 'exe'));

    const fakeProcRootCli = spawnSync(process.execPath, [VALIDATOR_CLI, ...validatorArgs(entrypoint), '--proc-root', procRoot], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000, env: { ...process.env }
    });
    assert.equal(fakeProcRootCli.status, 2, fakeProcRootCli.stderr || fakeProcRootCli.stdout);
    assert.match(fakeProcRootCli.stderr, /unsupported argument: --proc-root/,
      'the production CLI must never accept a caller-selected fake proc tree as host evidence');

    const rotatedButUnprovisioned = config(source.domain, source.provider_id,
      [entry('effective-host-goal-idea-verifier-key', sourcePem, { scope: 'agg.goal_idea_graph.verify' })],
      { config_version: 2, updated_at: new Date(Date.now() - 1_000).toISOString() });
    writeEnvironment({ ...trustEnv, AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON: JSON.stringify(rotatedButUnprovisioned) });
    const mismatch = runEffective(entrypoint);
    assert.equal(mismatch.status, 3, mismatch.stderr || mismatch.stdout);
    const mismatchReport = JSON.parse(mismatch.stdout);
    assert.equal(mismatchReport.result, 'BLOCKED');
    assert.equal(mismatchReport.effectiveHostVerification.code, 'AGG_TRUST_CONFIG_VERSION_MISMATCH_ON_HOST');
    assert.equal(mismatchReport.effectiveHostVerification.domains.goal_idea_verifier.blocker, 'AGG_TRUST_CONFIG_VERSION_MISMATCH_ON_HOST');

    const wrongProvider = config(source.domain, 'unapproved-effective-host-provider',
      [entry('effective-host-goal-idea-verifier-key', sourcePem, { scope: 'agg.goal_idea_graph.verify' })]);
    writeEnvironment({ ...trustEnv, AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON: JSON.stringify(wrongProvider) });
    const providerMismatch = runEffective(entrypoint);
    assert.equal(providerMismatch.status, 3, providerMismatch.stderr || providerMismatch.stdout);
    assert.equal(JSON.parse(providerMismatch.stdout).effectiveHostVerification.code, 'AGG_TRUST_CONFIG_PROVIDER_MISMATCH_ON_HOST');

    const replacementRoot = root();
    const wrongRoot = config(source.domain, source.provider_id,
      [entry('replacement-root', replacementRoot.pem, { scope: 'agg.goal_idea_graph.verify' })]);
    writeEnvironment({ ...trustEnv, AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON: JSON.stringify(wrongRoot) });
    const rootMismatch = runEffective(entrypoint);
    assert.equal(rootMismatch.status, 3, rootMismatch.stderr || rootMismatch.stdout);
    assert.equal(JSON.parse(rootMismatch.stdout).effectiveHostVerification.code, 'AGG_TRUST_CONFIG_FINGERPRINT_MISMATCH_ON_HOST');

    const maker = documents.get('action_intent_maker');
    const hostRootCollision = config(maker.domain, maker.provider_id,
      [entry('host-collision-root', sourcePem, { scope: 'agg.action_intent.propose' })]);
    writeEnvironment({ ...trustEnv, AGG_ACTION_INTENT_MAKER_TRUST_CONFIG_JSON: JSON.stringify(hostRootCollision) });
    const effectiveCollision = runEffective(entrypoint);
    assert.equal(effectiveCollision.status, 3, effectiveCollision.stderr || effectiveCollision.stdout);
    const effectiveCollisionReport = JSON.parse(effectiveCollision.stdout).effectiveHostVerification;
    assert.equal(effectiveCollisionReport.code, 'AGG_TRUST_DOMAINS_ROOT_COLLISION');
    assert.equal(effectiveCollisionReport.effectiveSeparation.status, 'EFFECTIVE_FIVE_DOMAIN_SEPARATION_BLOCKED');

    writeEnvironment({ ...trustEnv, AGG_EXECUTION_APPROVAL_TRUST_CONFIG_JSON: '' });
    const presentButBlank = runEffective(entrypoint);
    assert.equal(presentButBlank.status, 3, presentButBlank.stderr || presentButBlank.stdout);
    const blankDomain = JSON.parse(presentButBlank.stdout).effectiveHostVerification.domains.execution_approval;
    assert.equal(blankDomain.configJsonVariablePresent, true);
    assert.equal(blankDomain.configJsonNonEmpty, false);
    assert.equal(blankDomain.configured, false);
    assert.equal(blankDomain.blocker, 'AGG_TRUST_CONFIG_NOT_CONFIGURED');

    const missingDomainEnvironment = { ...trustEnv };
    delete missingDomainEnvironment.AGG_APPROVAL_POLICY_TRUST_CONFIG_JSON;
    writeEnvironment(missingDomainEnvironment);
    const missing = runEffective(entrypoint);
    assert.equal(missing.status, 3, missing.stderr || missing.stdout);
    const absentDomain = JSON.parse(missing.stdout).effectiveHostVerification.domains.execution_approval_policy;
    assert.equal(absentDomain.configJsonVariablePresent, false);
    assert.equal(absentDomain.configJsonNonEmpty, false);
    assert.equal(absentDomain.blocker, 'AGG_TRUST_CONFIG_NOT_CONFIGURED');

    writeEnvironment(trustEnv);
    let processStatReads = 0;
    const pidReuseDuringInspection = runEffective(entrypoint, {
      readProcFile(filePath, ...args) {
        if (filePath === path.join(procRoot, pid, 'stat')) {
          processStatReads++;
          if (processStatReads === 2) return Buffer.from(procStat(pid, 'node', ppid, 999), 'utf8');
        }
        return fs.readFileSync(filePath, ...args);
      }
    });
    assert.equal(pidReuseDuringInspection.status, 3, pidReuseDuringInspection.stderr || pidReuseDuringInspection.stdout);
    assert.equal(JSON.parse(pidReuseDuringInspection.stdout).effectiveHostVerification.code,
      'AGG_TRUST_CONFIG_HOST_PROCESS_IDENTITY_CHANGED');

    let parentStatReads = 0;
    const parentPidReuseDuringInspection = runEffective(entrypoint, {
      readProcFile(filePath, ...args) {
        if (filePath === path.join(procRoot, ppid, 'stat')) {
          parentStatReads++;
          if (parentStatReads === 2) return Buffer.from(procStat(ppid, 'chat-on-steroids', '1', 999), 'utf8');
        }
        return fs.readFileSync(filePath, ...args);
      }
    });
    assert.equal(parentPidReuseDuringInspection.status, 3, parentPidReuseDuringInspection.stderr || parentPidReuseDuringInspection.stdout);
    assert.equal(JSON.parse(parentPidReuseDuringInspection.stdout).effectiveHostVerification.code,
      'AGG_TRUST_CONFIG_HOST_PROCESS_IDENTITY_CHANGED');

    let processCommandReads = 0;
    const processExecDuringInspection = runEffective(entrypoint, {
      readProcFile(filePath, ...args) {
        if (filePath === path.join(procRoot, pid, 'cmdline')) {
          processCommandReads++;
          if (processCommandReads === 2) return Buffer.from('node\0/tmp/replaced-entrypoint.js\0', 'utf8');
        }
        return fs.readFileSync(filePath, ...args);
      }
    });
    assert.equal(processExecDuringInspection.status, 3, processExecDuringInspection.stderr || processExecDuringInspection.stdout);
    assert.equal(JSON.parse(processExecDuringInspection.stdout).effectiveHostVerification.code,
      'AGG_TRUST_CONFIG_HOST_PROCESS_IDENTITY_CHANGED');

    let parentCommandReads = 0;
    const parentExecDuringInspection = runEffective(entrypoint, {
      readProcFile(filePath, ...args) {
        if (filePath === path.join(procRoot, ppid, 'cmdline')) {
          parentCommandReads++;
          if (parentCommandReads === 2) return Buffer.from('/usr/bin/unrelated-host\0', 'utf8');
        }
        return fs.readFileSync(filePath, ...args);
      }
    });
    assert.equal(parentExecDuringInspection.status, 3, parentExecDuringInspection.stderr || parentExecDuringInspection.stdout);
    assert.equal(JSON.parse(parentExecDuringInspection.stdout).effectiveHostVerification.code,
      'AGG_TRUST_CONFIG_HOST_PROCESS_IDENTITY_CHANGED');

    let sameArgvEnvironmentReads = 0;
    const sameArgvEnvironmentExec = runEffective(entrypoint, {
      readProcFile(filePath, ...args) {
        if (filePath === path.join(procRoot, pid, 'environ')) {
          sameArgvEnvironmentReads++;
          if (sameArgvEnvironmentReads === 2) {
            return Buffer.concat([fs.readFileSync(filePath), Buffer.from('EXEC_REPLACEMENT=1\0', 'utf8')]);
          }
        }
        return fs.readFileSync(filePath, ...args);
      }
    });
    assert.equal(sameArgvEnvironmentExec.status, 3, sameArgvEnvironmentExec.stderr || sameArgvEnvironmentExec.stdout);
    assert.equal(JSON.parse(sameArgvEnvironmentExec.stdout).effectiveHostVerification.code,
      'AGG_TRUST_CONFIG_HOST_PROCESS_IDENTITY_CHANGED',
      'same-argv exec with a changed environment must not pass using the earlier environment snapshot');

    let sameArgvExecutableReads = 0;
    const sameArgvExecutableExec = runEffective(entrypoint, {
      readProcFile(filePath, ...args) {
        if (filePath === path.join(procRoot, pid, 'environ')) {
          sameArgvExecutableReads++;
          if (sameArgvExecutableReads === 1) fs.unlinkSync(path.join(procRoot, pid, 'exe'));
          if (sameArgvExecutableReads === 1) fs.symlinkSync('/usr/bin/true', path.join(procRoot, pid, 'exe'));
        }
        return fs.readFileSync(filePath, ...args);
      }
    });
    assert.equal(sameArgvExecutableExec.status, 3, sameArgvExecutableExec.stderr || sameArgvExecutableExec.stdout);
    assert.equal(JSON.parse(sameArgvExecutableExec.stdout).effectiveHostVerification.code,
      'AGG_TRUST_CONFIG_HOST_PROCESS_IDENTITY_CHANGED',
      'same-argv exec to a different executable must not pass');
    fs.unlinkSync(path.join(procRoot, pid, 'exe'));
    fs.symlinkSync(process.execPath, path.join(procRoot, pid, 'exe'));

    const wrongEntrypoint = runEffective(`${entrypoint}.not-current`);
    assert.equal(wrongEntrypoint.status, 3, wrongEntrypoint.stderr || wrongEntrypoint.stdout);
    assert.equal(JSON.parse(wrongEntrypoint.stdout).effectiveHostVerification.code, 'AGG_TRUST_CONFIG_HOST_ENTRYPOINT_MISMATCH');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
