#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { adaptiveGoalTrustConfigurationStatus, assertAdaptiveGoalTrustDomainsDisjoint,
  loadAdaptiveGoalTrustConfiguration } from '../src/runtime/adaptive-goal-trust-configuration.js';

function parseArgs(argv) {
  const parsed = { domain: null, config: null, peerConfig: null, requirePeerConfig: false,
    effectiveHostPid: null, effectiveHostEntrypoint: null };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--require-peer-config') { parsed.requirePeerConfig = true; continue; }
    if (!['--domain', '--config', '--peer-config', '--effective-host-pid', '--effective-host-entrypoint'].includes(key)) {
      throw new Error(`unsupported argument: ${key}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    if (key === '--domain') parsed.domain = value;
    else if (key === '--config') parsed.config = value;
    else if (key === '--peer-config') parsed.peerConfig = value;
    else if (key === '--effective-host-pid') parsed.effectiveHostPid = value;
    else if (key === '--effective-host-entrypoint') parsed.effectiveHostEntrypoint = value;
  }
  if (!['goal_idea_verifier', 'action_intent_reviewer'].includes(parsed.domain)) {
    throw new Error('--domain must be goal_idea_verifier or action_intent_reviewer');
  }
  if (!parsed.config) throw new Error('--config must name an administrator-provisioned JSON trust configuration file');
  const effectiveRequested = parsed.effectiveHostPid !== null || parsed.effectiveHostEntrypoint !== null;
  if (effectiveRequested) {
    if (!/^\d+$/.test(parsed.effectiveHostPid || '') || Number(parsed.effectiveHostPid) < 1 || !Number.isSafeInteger(Number(parsed.effectiveHostPid))) {
      throw new Error('--effective-host-pid must be a positive safe integer when effective host inspection is requested');
    }
    if (!parsed.effectiveHostEntrypoint || !path.isAbsolute(parsed.effectiveHostEntrypoint)) {
      throw new Error('--effective-host-entrypoint must be the absolute entrypoint reported for the active host process');
    }
    if (!parsed.peerConfig || !parsed.requirePeerConfig) {
      throw new Error('effective host inspection requires --peer-config and --require-peer-config to verify both trust domains');
    }
  }
  return parsed;
}

const TRUST_DOMAINS = Object.freeze({
  goal_idea_verifier: { configJsonEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON',
    providerEnv: 'AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID', publicKeyEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM',
    domain: 'goal_idea_verifier', scope: 'agg.goal_idea_graph.verify' },
  action_intent_reviewer: { configJsonEnv: 'AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON',
    providerEnv: 'AGG_REVIEW_IDENTITY_PROVIDER_ID', publicKeyEnv: 'AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM',
    domain: 'action_intent_reviewer', scope: 'agg.action_intent.review' }
});

function readEffectiveHost(pid, procRoot) {
  const processDirectory = path.join(path.resolve(procRoot), String(pid));
  const cmdline = fs.readFileSync(path.join(processDirectory, 'cmdline')).toString('utf8').split('\0').filter(Boolean);
  const statusText = fs.readFileSync(path.join(processDirectory, 'status'), 'utf8');
  const ppid = Number(statusText.match(/^PPid:\s*(\d+)$/m)?.[1]);
  if (!Number.isSafeInteger(ppid) || ppid < 1) throw Object.assign(new Error('active host process parent PID is unavailable'), { code: 'AGG_TRUST_CONFIG_HOST_OWNER_UNVERIFIED' });
  const parentArgs = fs.readFileSync(path.join(path.resolve(procRoot), String(ppid), 'cmdline')).toString('utf8').split('\0').filter(Boolean);
  const parentExecutable = parentArgs[0] || '';
  const parentLooksLikeHost = /chat-on-steroids/i.test(path.basename(parentExecutable)) || /chat on steroids/i.test(parentExecutable);
  if (!parentLooksLikeHost) throw Object.assign(new Error('effective trust configuration inspection target is not owned by an identifiable Chat On Steroids host process'),
    { code: 'AGG_TRUST_CONFIG_HOST_OWNER_UNVERIFIED' });
  const rawEnvironment = fs.readFileSync(path.join(processDirectory, 'environ'));
  const wanted = new Set(Object.values(TRUST_DOMAINS).flatMap(item => [item.configJsonEnv, item.providerEnv, item.publicKeyEnv]));
  const environment = {};
  for (const item of rawEnvironment.toString('utf8').split('\0')) {
    const equals = item.indexOf('=');
    if (equals < 1) continue;
    const key = item.slice(0, equals);
    if (!wanted.has(key)) continue;
    if (Object.hasOwn(environment, key)) throw Object.assign(new Error(`effective host process has duplicate ${key} entries; refusing an ambiguous environment`),
      { code: 'AGG_TRUST_CONFIG_NOT_EFFECTIVE_ON_HOST' });
    environment[key] = item.slice(equals + 1);
  }
  const entrypoint = cmdline.find(value => /[/\\]plugins[/\\][^/\\]+[/\\]g-[^/\\]+[/\\]server[/\\]index(?:-v[0-9A-Za-z.-]+)?\.js$/.test(value)) || null;
  if (!entrypoint) throw Object.assign(new Error('active process command line does not expose a recognized versioned Runalith entrypoint'),
    { code: 'AGG_TRUST_CONFIG_HOST_ENTRYPOINT_MISMATCH' });
  const absoluteEntrypoint = path.resolve(entrypoint);
  try {
    const entryStat = fs.lstatSync(absoluteEntrypoint);
    if (!entryStat.isFile() || entryStat.isSymbolicLink() || fs.realpathSync(absoluteEntrypoint) !== absoluteEntrypoint) {
      throw new Error('entrypoint must be a canonical regular non-symlink file');
    }
  } catch (error) {
    throw Object.assign(new Error(`active host entrypoint is unavailable or changed: ${String(error?.message || error)}`),
      { code: 'AGG_TRUST_CONFIG_HOST_ENTRYPOINT_MISMATCH' });
  }
  return { environment, entrypoint: absoluteEntrypoint, ppid, parentExecutable, parentLooksLikeHost };
}

export function main(argv = process.argv.slice(2), { procRoot = '/proc' } = {}) {
  const args = parseArgs(argv);
  function readConfigFile(inputPath) {
    const configPath = path.resolve(inputPath);
    let stat;
    try { stat = fs.lstatSync(configPath, { bigint: true }); }
    catch (error) {
      if (error?.code === 'ENOENT') throw Object.assign(new Error(`administrator trust configuration file is missing: ${configPath}`),
        { code: 'AGG_TRUST_CONFIG_FILE_MISSING' });
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(configPath) !== configPath) {
      throw new Error('configuration path and every parent component must resolve to a canonical regular non-symlink file');
    }
    // Pin the opened inode, refuse a final-component symlink, and compare the
    // descriptor and pathname before/after reading. realpath+lstat followed by
    // readFile(path) alone leaves a swap window for operator-supplied configs.
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    const descriptor = fs.openSync(configPath, flags);
    try {
      const before = fs.fstatSync(descriptor, { bigint: true });
      if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || before.size < 2n || before.size > 128n * 1024n) {
        throw new Error('configuration file must be a regular file between 2 bytes and 128 KiB');
      }
      const bytes = fs.readFileSync(descriptor);
      const after = fs.fstatSync(descriptor, { bigint: true });
      const pathAfter = fs.lstatSync(configPath, { bigint: true });
      const stable = before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
        before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs &&
        bytes.length === Number(after.size) && pathAfter.isFile() && !pathAfter.isSymbolicLink() &&
        pathAfter.dev === after.dev && pathAfter.ino === after.ino && pathAfter.size === after.size &&
        pathAfter.mtimeNs === after.mtimeNs && pathAfter.ctimeNs === after.ctimeNs && fs.realpathSync(configPath) === configPath;
      if (!stable) throw new Error('configuration path or bytes changed during secure read; retry validation from a stable canonical file');
      return { configPath, contents: bytes.toString('utf8') };
    } finally {
      fs.closeSync(descriptor);
    }
  }
  if (args.requirePeerConfig && !args.peerConfig) {
    console.log(JSON.stringify({ result: 'BLOCKED', code: 'AGG_TRUST_CONFIG_PAIR_REQUIRED',
      message: '--require-peer-config requires --peer-config; validating one trust file cannot establish production trust-domain separation' }, null, 2));
    process.exitCode = 3;
    return;
  }
  const { configPath, contents } = readConfigFile(args.config);
  const isKnowledge = args.domain === 'goal_idea_verifier';
  const env = isKnowledge ? {
    configJsonEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON',
    providerEnv: 'AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID',
    publicKeyEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM',
    domain: 'goal_idea_verifier', scope: 'agg.goal_idea_graph.verify'
  } : {
    configJsonEnv: 'AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON',
    providerEnv: 'AGG_REVIEW_IDENTITY_PROVIDER_ID',
    publicKeyEnv: 'AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM',
    domain: 'action_intent_reviewer', scope: 'agg.action_intent.review'
  };
  process.env[env.configJsonEnv] = contents;
  // The JSON config is authoritative whenever present; remove legacy entries
  // so this validation checks exactly the file an operator intends to deploy.
  delete process.env[env.providerEnv];
  delete process.env[env.publicKeyEnv];
  const configuration = loadAdaptiveGoalTrustConfiguration(env);
  const status = adaptiveGoalTrustConfigurationStatus(configuration);
  const other = isKnowledge ? {
    configJsonEnv: 'AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON', providerEnv: 'AGG_REVIEW_IDENTITY_PROVIDER_ID',
    publicKeyEnv: 'AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM', domain: 'action_intent_reviewer', scope: 'agg.action_intent.review'
  } : {
    configJsonEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON', providerEnv: 'AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID',
    publicKeyEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM', domain: 'goal_idea_verifier', scope: 'agg.goal_idea_graph.verify'
  };
  let pairVerification = { verified: false, status: 'SINGLE_CONFIGURATION_ONLY',
    message: 'this PASS validates one file only; it does not prove the deployment pair uses distinct providers and disjoint canonical SPKI roots' };
  let peerConfiguration = null;
  let peerConfigPath = null;
  let peerContents = null;
  if (args.peerConfig) {
    ({ configPath: peerConfigPath, contents: peerContents } = readConfigFile(args.peerConfig));
    const peerIsKnowledge = !isKnowledge;
    const peerEnv = peerIsKnowledge ? {
      configJsonEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON', providerEnv: 'AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID',
      publicKeyEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM', domain: 'goal_idea_verifier', scope: 'agg.goal_idea_graph.verify'
    } : {
      configJsonEnv: 'AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON', providerEnv: 'AGG_REVIEW_IDENTITY_PROVIDER_ID',
      publicKeyEnv: 'AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM', domain: 'action_intent_reviewer', scope: 'agg.action_intent.review'
    };
    peerConfiguration = loadAdaptiveGoalTrustConfiguration({ ...peerEnv, environment: { [peerEnv.configJsonEnv]: peerContents } });
    if (!peerConfiguration.available) throw Object.assign(new Error('peer trust configuration has no currently usable, non-revoked root inside its validity window'),
      { code: 'AGG_TRUST_CONFIG_PEER_UNAVAILABLE' });
    const sharedRoots = configuration.roots.filter(key => peerConfiguration.roots.some(otherKey => otherKey.trustRootSha256 === key.trustRootSha256));
    if (configuration.providerId === peerConfiguration.providerId) throw Object.assign(
      new Error('trust-domain separation failed: provider IDs must differ'), { code: 'AGG_TRUST_DOMAINS_PROVIDER_COLLISION' });
    if (sharedRoots.length) throw Object.assign(
      new Error('trust-domain separation failed: canonical public-key roots must be disjoint'), { code: 'AGG_TRUST_DOMAINS_ROOT_COLLISION' });
    pairVerification = { verified: true, status: 'PAIR_SEPARATION_VERIFIED', peerConfigPath,
      peerFileSha256: createHash('sha256').update(peerContents).digest('hex'),
      providerIdsDistinct: true, publicRootsDisjoint: true };
  }
  let effectiveHostVerification = null;
  if (args.effectiveHostPid !== null) {
    try {
      // Production CLI always inspects the kernel procfs mount. Tests may
      // inject a fixture root by calling this module's exported function;
      // callers cannot nominate an ordinary directory as live host evidence.
      const observed = readEffectiveHost(Number(args.effectiveHostPid), procRoot);
      if (observed.entrypoint !== path.resolve(args.effectiveHostEntrypoint)) {
        effectiveHostVerification = { result: 'BLOCKED', code: 'AGG_TRUST_CONFIG_HOST_ENTRYPOINT_MISMATCH',
          message: 'the supplied process does not run the exact expected versioned Runalith entrypoint',
          pid: Number(args.effectiveHostPid), observedEntryPoint: observed.entrypoint, expectedEntryPoint: path.resolve(args.effectiveHostEntrypoint) };
      } else {
        const domainResults = {};
        const actualConfigurations = {};
        const domainsToCheck = isKnowledge
          ? [['goal_idea_verifier', configuration, TRUST_DOMAINS.goal_idea_verifier],
            ['action_intent_reviewer', peerConfiguration, TRUST_DOMAINS.action_intent_reviewer]]
          : [['action_intent_reviewer', configuration, TRUST_DOMAINS.action_intent_reviewer],
            ['goal_idea_verifier', peerConfiguration, TRUST_DOMAINS.goal_idea_verifier]];
        for (const [name, expected, other] of domainsToCheck) {
          const envValue = observed.environment[other.configJsonEnv];
          const configJsonVariablePresent = Object.hasOwn(observed.environment, other.configJsonEnv);
          const configJsonNonEmpty = typeof envValue === 'string' && envValue.trim() !== '';
          const providerValue = observed.environment[other.providerEnv];
          const legacyRootValue = observed.environment[other.publicKeyEnv];
          let actual = null;
          let blocker = null;
          try {
            actual = loadAdaptiveGoalTrustConfiguration({ ...other, environment: observed.environment });
            if (actual.available === true) actualConfigurations[name] = actual;
            if (actual.available !== true) blocker = 'AGG_TRUST_CONFIG_NOT_EFFECTIVE_ON_HOST';
            else if (actual.configurationSource !== 'admin_json_environment') blocker = 'AGG_TRUST_CONFIG_SOURCE_NOT_HOST_JSON';
            else if (actual.configVersion !== expected.configVersion) blocker = 'AGG_TRUST_CONFIG_VERSION_MISMATCH_ON_HOST';
            else if (actual.providerId !== expected.providerId) blocker = 'AGG_TRUST_CONFIG_PROVIDER_MISMATCH_ON_HOST';
            else if (actual.configurationFingerprint !== expected.configurationFingerprint) blocker = 'AGG_TRUST_CONFIG_FINGERPRINT_MISMATCH_ON_HOST';
          } catch (error) {
            blocker = error?.code || 'AGG_TRUST_CONFIG_NOT_EFFECTIVE_ON_HOST';
          }
          domainResults[name] = {
            // Presence and usability are distinct facts for optional MCPB
            // fields: an existing empty interpolation is present, but is not
            // a configured trust root. Never expose raw JSON or PEM values.
            configJsonVariablePresent,
            configJsonNonEmpty,
            providerIdVariablePresent: Object.hasOwn(observed.environment, other.providerEnv),
            providerIdNonEmpty: typeof providerValue === 'string' && providerValue.trim() !== '',
            legacyPublicRootVariablePresent: Object.hasOwn(observed.environment, other.publicKeyEnv),
            legacyPublicRootNonEmpty: typeof legacyRootValue === 'string' && legacyRootValue.trim() !== '',
            configured: configJsonNonEmpty, matchesSuppliedFile: blocker === null,
            expectedConfigVersion: expected.configVersion, effectiveConfigVersion: actual?.configVersion ?? null,
            expectedProviderId: expected.providerId, effectiveProviderId: actual?.providerId ?? null,
            expectedConfigurationFingerprint: expected.configurationFingerprint, effectiveConfigurationFingerprint: actual?.configurationFingerprint ?? null,
            blocker };
        }
        let effectivePairVerification = { verified: false, status: 'EFFECTIVE_PAIR_UNAVAILABLE',
          code: 'AGG_TRUST_CONFIG_EFFECTIVE_PAIR_UNAVAILABLE' };
        if (actualConfigurations.goal_idea_verifier && actualConfigurations.action_intent_reviewer) {
          try {
            assertAdaptiveGoalTrustDomainsDisjoint(actualConfigurations.goal_idea_verifier, actualConfigurations.action_intent_reviewer);
            effectivePairVerification = { verified: true, status: 'EFFECTIVE_PAIR_SEPARATION_VERIFIED',
              providerIdsDistinct: true, publicRootsDisjoint: true };
          } catch (error) {
            effectivePairVerification = { verified: false, status: 'EFFECTIVE_PAIR_SEPARATION_BLOCKED',
              code: error?.code || 'AGG_TRUST_CONFIG_EFFECTIVE_PAIR_UNAVAILABLE' };
          }
        }
        const verified = Object.values(domainResults).every(item => item.matchesSuppliedFile) && effectivePairVerification.verified;
        effectiveHostVerification = { result: verified ? 'PASS' : 'BLOCKED',
          ...(verified ? {} : { code: effectivePairVerification.code || Object.values(domainResults).find(item => !item.matchesSuppliedFile)?.blocker || 'AGG_TRUST_CONFIG_NOT_EFFECTIVE_ON_HOST' }),
          pid: Number(args.effectiveHostPid), entryPoint: observed.entrypoint, parentLooksLikeHost: observed.parentLooksLikeHost,
          checkedAt: new Date().toISOString(), domains: domainResults, effectivePairVerification,
          note: 'This read-only process-environment comparison does not verify the active trust-ledger high-water rows or external monotonic checkpoint; rollout preflight must independently verify both.' };
      }
    } catch (error) {
      effectiveHostVerification = { result: 'BLOCKED', code: error?.code || 'AGG_TRUST_CONFIG_EFFECTIVE_HOST_INSPECTION_FAILED',
        message: String(error?.message || error), pid: Number(args.effectiveHostPid) };
    }
  }
  if (!status.available) {
    console.log(JSON.stringify({ result: 'BLOCKED', pairVerification, effectiveHostVerification, ...status }, null, 2));
    process.exitCode = 3;
    return;
  }
  const result = { result: effectiveHostVerification?.result === 'BLOCKED' ? 'BLOCKED' : 'PASS', configPath,
    fileSha256: createHash('sha256').update(contents).digest('hex'), pairVerification, effectiveHostVerification, ...status };
  console.log(JSON.stringify(result, null, 2));
  if (result.result !== 'PASS') process.exitCode = 3;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    const code = error?.code || 'TRUST_CONFIG_VALIDATION_FAILED';
    const authorityBlockers = new Set(['AGG_TRUST_DOMAINS_PROVIDER_COLLISION', 'AGG_TRUST_DOMAINS_ROOT_COLLISION', 'AGG_TRUST_CONFIG_PEER_UNAVAILABLE']);
    const blocked = authorityBlockers.has(code);
    const report = { result: blocked ? 'BLOCKED' : 'FAIL', code, message: String(error?.message || error),
      productionTrustEstablished: false, externalCheckpointVerified: false };
    (blocked ? console.log : console.error)(JSON.stringify(report, null, 2));
    process.exitCode = blocked ? 3 : 2;
  }
}
