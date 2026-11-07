#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { adaptiveGoalTrustConfigurationStatus, assertAdaptiveGoalTrustDomainsDisjoint,
  loadAdaptiveGoalTrustConfiguration } from '../src/runtime/adaptive-goal-trust-configuration.js';
import { ADAPTIVE_GOAL_TRUST_DOMAIN_SPECS, assertAdaptiveGoalTrustDomainConfigurationsDisjoint } from '../src/runtime/adaptive-goal-trust-domains.js';

function parseArgs(argv) {
  const parsed = { domain: null, config: null, peerConfig: null, requirePeerConfig: false,
    trustConfigs: [], effectiveHostPid: null, effectiveHostEntrypoint: null };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--require-peer-config') { parsed.requirePeerConfig = true; continue; }
    if (!['--domain', '--config', '--peer-config', '--effective-host-pid', '--effective-host-entrypoint', '--trust-config'].includes(key)) {
      throw new Error(`unsupported argument: ${key}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    if (key === '--domain') parsed.domain = value;
    else if (key === '--config') parsed.config = value;
    else if (key === '--peer-config') parsed.peerConfig = value;
    else if (key === '--effective-host-pid') parsed.effectiveHostPid = value;
    else if (key === '--effective-host-entrypoint') parsed.effectiveHostEntrypoint = value;
    else if (key === '--trust-config') {
      const separator = value.indexOf('=');
      if (separator < 1 || separator === value.length - 1) throw new Error('--trust-config must be DOMAIN=/absolute/or/relative/path and may be repeated');
      parsed.trustConfigs.push({ domain: value.slice(0, separator), config: value.slice(separator + 1) });
    }
  }
  const fiveDomainMode = parsed.trustConfigs.length > 0;
  if (fiveDomainMode) {
    const expected = new Set(ADAPTIVE_GOAL_TRUST_DOMAIN_SPECS.map(spec => spec.domain));
    const observed = parsed.trustConfigs.map(item => item.domain);
    if (observed.length !== expected.size || new Set(observed).size !== expected.size || observed.some(domain => !expected.has(domain))) {
      throw new Error('--trust-config must provide each of the five trust domains exactly once');
    }
    if (parsed.config || parsed.peerConfig || parsed.domain) {
      throw new Error('five-domain --trust-config mode cannot be combined with legacy --domain/--config/--peer-config options');
    }
  } else {
    if (!['goal_idea_verifier', 'action_intent_reviewer'].includes(parsed.domain)) {
      throw new Error('--domain must be goal_idea_verifier or action_intent_reviewer for legacy pair validation');
    }
    if (!parsed.config) throw new Error('--config must name an administrator-provisioned JSON trust configuration file');
  }
  const effectiveRequested = parsed.effectiveHostPid !== null || parsed.effectiveHostEntrypoint !== null;
  if (effectiveRequested) {
    if (!/^\d+$/.test(parsed.effectiveHostPid || '') || Number(parsed.effectiveHostPid) < 1 || !Number.isSafeInteger(Number(parsed.effectiveHostPid))) {
      throw new Error('--effective-host-pid must be a positive safe integer when effective host inspection is requested');
    }
    if (!parsed.effectiveHostEntrypoint || !path.isAbsolute(parsed.effectiveHostEntrypoint)) {
      throw new Error('--effective-host-entrypoint must be the absolute entrypoint reported for the active host process');
    }
    if (fiveDomainMode !== true) {
      throw new Error('effective host inspection requires all five repeated --trust-config DOMAIN=PATH arguments');
    }
  }
  return parsed;
}

const TRUST_DOMAINS = Object.freeze(Object.fromEntries(ADAPTIVE_GOAL_TRUST_DOMAIN_SPECS.map(spec => [spec.domain, spec])));

function readProcIdentity(pid, procRoot, readProcFile) {
  const statPath = path.join(path.resolve(procRoot), String(pid), 'stat');
  const statText = String(readProcFile(statPath, 'utf8'));
  const openParen = statText.indexOf('(');
  const closeParen = statText.lastIndexOf(')');
  const observedPid = openParen > 0 ? Number(statText.slice(0, openParen).trim()) : NaN;
  const fieldsAfterCommand = closeParen > openParen ? statText.slice(closeParen + 2).trim().split(/\s+/) : [];
  const parentPid = Number(fieldsAfterCommand[1]); // /proc/<pid>/stat field 4 (ppid)
  const startTimeTicks = fieldsAfterCommand[19] || null; // field 22 is stable for one process lifetime
  if (observedPid !== pid || !Number.isSafeInteger(parentPid) || parentPid < 1 ||
      !/^\d+$/.test(startTimeTicks || '')) {
    throw Object.assign(new Error(`process ${pid} has an unreadable or malformed /proc stat identity`),
      { code: 'AGG_TRUST_CONFIG_HOST_PROCESS_IDENTITY_UNVERIFIED' });
  }
  return { pid, parentPid, startTimeTicks };
}

function readProcCommandLine(pid, procRoot, readProcFile) {
  return readProcFile(path.join(path.resolve(procRoot), String(pid), 'cmdline'))
    .toString('utf8').split('\0').filter(Boolean);
}

function readProcExecutableIdentity(pid, procRoot) {
  const executablePath = path.join(path.resolve(procRoot), String(pid), 'exe');
  try {
    const link = fs.readlinkSync(executablePath);
    const stat = fs.statSync(executablePath, { bigint: true });
    if (!stat.isFile()) throw new Error('process executable is not a regular file');
    return { link, device: stat.dev.toString(), inode: stat.ino.toString() };
  } catch (error) {
    throw Object.assign(new Error(`process ${pid} executable identity is unavailable: ${String(error?.message || error)}`),
      { code: 'AGG_TRUST_CONFIG_HOST_PROCESS_IDENTITY_UNVERIFIED' });
  }
}

function readEffectiveHost(pid, procRoot, readProcFile = fs.readFileSync) {
  const processDirectory = path.join(path.resolve(procRoot), String(pid));
  // A numeric PID can be recycled while the separate proc files are read. Pin
  // both the target and its claimed host parent to Linux start-time ticks, then
  // re-read both identities, executable objects, command lines and target
  // environment after inspection.
  const processIdentityBefore = readProcIdentity(pid, procRoot, readProcFile);
  const processExecutableBefore = readProcExecutableIdentity(pid, procRoot);
  const cmdline = readProcCommandLine(pid, procRoot, readProcFile);
  const statusText = readProcFile(path.join(processDirectory, 'status'), 'utf8');
  const ppid = Number(statusText.match(/^PPid:\s*(\d+)$/m)?.[1]);
  if (!Number.isSafeInteger(ppid) || ppid < 1) throw Object.assign(new Error('active host process parent PID is unavailable'), { code: 'AGG_TRUST_CONFIG_HOST_OWNER_UNVERIFIED' });
  if (ppid !== processIdentityBefore.parentPid) {
    throw Object.assign(new Error('active host process parent changed during effective trust inspection'),
      { code: 'AGG_TRUST_CONFIG_HOST_PROCESS_IDENTITY_CHANGED' });
  }
  const parentIdentityBefore = readProcIdentity(ppid, procRoot, readProcFile);
  const parentExecutableBefore = readProcExecutableIdentity(ppid, procRoot);
  const parentExecutableName = path.basename(parentExecutableBefore.link);
  if (parentExecutableName !== 'chat-on-steroids') {
    throw Object.assign(new Error('effective trust configuration inspection parent executable is not the Chat On Steroids host binary'),
      { code: 'AGG_TRUST_CONFIG_HOST_OWNER_UNVERIFIED' });
  }
  const parentArgs = readProcCommandLine(ppid, procRoot, readProcFile);
  const parentExecutable = parentArgs[0] || '';
  const parentLooksLikeHost = /chat-on-steroids/i.test(path.basename(parentExecutable)) || /chat on steroids/i.test(parentExecutable);
  if (!parentLooksLikeHost) throw Object.assign(new Error('effective trust configuration inspection target is not owned by an identifiable Chat On Steroids host process'),
    { code: 'AGG_TRUST_CONFIG_HOST_OWNER_UNVERIFIED' });
  const rawEnvironment = readProcFile(path.join(processDirectory, 'environ'));
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
  const parentIdentityAfter = readProcIdentity(ppid, procRoot, readProcFile);
  const processIdentityAfter = readProcIdentity(pid, procRoot, readProcFile);
  const processStatusAfter = readProcFile(path.join(processDirectory, 'status'), 'utf8');
  const parentPidAfter = Number(processStatusAfter.match(/^PPid:\s*(\d+)$/m)?.[1]);
  const processCommandLineAfter = readProcCommandLine(pid, procRoot, readProcFile);
  const parentCommandLineAfter = readProcCommandLine(ppid, procRoot, readProcFile);
  const rawEnvironmentAfter = readProcFile(path.join(processDirectory, 'environ'));
  const processExecutableAfter = readProcExecutableIdentity(pid, procRoot);
  const parentExecutableAfter = readProcExecutableIdentity(ppid, procRoot);
  if (processIdentityBefore.startTimeTicks !== processIdentityAfter.startTimeTicks ||
      processIdentityBefore.parentPid !== processIdentityAfter.parentPid ||
      parentIdentityBefore.startTimeTicks !== parentIdentityAfter.startTimeTicks ||
      parentPidAfter !== ppid || JSON.stringify(cmdline) !== JSON.stringify(processCommandLineAfter) ||
      JSON.stringify(parentArgs) !== JSON.stringify(parentCommandLineAfter) ||
      JSON.stringify(processExecutableBefore) !== JSON.stringify(processExecutableAfter) ||
      JSON.stringify(parentExecutableBefore) !== JSON.stringify(parentExecutableAfter) ||
      !Buffer.isBuffer(rawEnvironmentAfter) || !rawEnvironment.equals(rawEnvironmentAfter)) {
    throw Object.assign(new Error('active host or parent process identity, executable, command line, or effective environment changed while being inspected'),
      { code: 'AGG_TRUST_CONFIG_HOST_PROCESS_IDENTITY_CHANGED' });
  }
  return {
    environment, entrypoint: absoluteEntrypoint, ppid, parentExecutable, parentLooksLikeHost,
    // The basename/cmdline checks above are only a plausibility filter. They
    // do not authenticate executable provenance: an unrelated binary can be
    // copied or renamed to this basename. No host-admin trust manifest or
    // signed launcher attestation is currently provisioned for this validator.
    parentExecutableIdentity: {
      basename: parentExecutableName,
      device: parentExecutableBefore.device,
      inode: parentExecutableBefore.inode,
      authenticated: false,
      status: 'UNVERIFIED_NO_EXTERNAL_HOST_IDENTITY_ANCHOR'
    }
  };
}

export function main(argv = process.argv.slice(2), { procRoot = '/proc', readProcFile = fs.readFileSync } = {}) {
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
  if (args.trustConfigs.length) {
    const supplied = new Map(args.trustConfigs.map(item => [item.domain, item.config]));
    const expectedConfigurations = [];
    const domainFiles = {};
    for (const spec of ADAPTIVE_GOAL_TRUST_DOMAIN_SPECS) {
      const { configPath: suppliedPath, contents } = readConfigFile(supplied.get(spec.domain));
      const configuration = loadAdaptiveGoalTrustConfiguration({
        configJsonEnv: spec.configJsonEnv, providerEnv: spec.providerEnv, publicKeyEnv: spec.publicKeyEnv,
        domain: spec.domain, scope: spec.scope, environment: { [spec.configJsonEnv]: contents }
      });
      if (configuration.configurationSource !== 'admin_json_environment' || configuration.configVersion < 1 || configuration.available !== true) {
        throw Object.assign(new Error(`trust domain ${spec.domain} must have a usable versioned administrator JSON configuration`),
          { code: 'AGG_TRUST_DOMAIN_CONFIGURATION_INVALID' });
      }
      expectedConfigurations.push(configuration);
      domainFiles[spec.domain] = {
        configPath: suppliedPath,
        fileSha256: createHash('sha256').update(contents).digest('hex'),
        ...adaptiveGoalTrustConfigurationStatus(configuration)
      };
    }
    const separation = assertAdaptiveGoalTrustDomainConfigurationsDisjoint(expectedConfigurations);
    let effectiveHostVerification = null;
    if (args.effectiveHostPid !== null) {
      try {
        const observed = readEffectiveHost(Number(args.effectiveHostPid), procRoot, readProcFile);
        if (observed.entrypoint !== path.resolve(args.effectiveHostEntrypoint)) {
          effectiveHostVerification = { result: 'BLOCKED', code: 'AGG_TRUST_CONFIG_HOST_ENTRYPOINT_MISMATCH',
            message: 'the supplied process does not run the exact expected versioned Runalith entrypoint',
            pid: Number(args.effectiveHostPid), observedEntryPoint: observed.entrypoint,
            expectedEntryPoint: path.resolve(args.effectiveHostEntrypoint) };
        } else {
          const effectiveConfigurations = [];
          const domainResults = {};
          for (let index = 0; index < ADAPTIVE_GOAL_TRUST_DOMAIN_SPECS.length; index++) {
            const spec = ADAPTIVE_GOAL_TRUST_DOMAIN_SPECS[index];
            const expected = expectedConfigurations[index];
            const envValue = observed.environment[spec.configJsonEnv];
            const configJsonVariablePresent = Object.hasOwn(observed.environment, spec.configJsonEnv);
            const configJsonNonEmpty = typeof envValue === 'string' && envValue.trim() !== '';
            let actual = null;
            let blocker = null;
            try {
              actual = loadAdaptiveGoalTrustConfiguration({ ...spec, environment: observed.environment });
              if (actual.available === true) effectiveConfigurations.push(actual);
              if (actual.available !== true) blocker = 'AGG_TRUST_CONFIG_NOT_EFFECTIVE_ON_HOST';
              else if (actual.configurationSource !== 'admin_json_environment') blocker = 'AGG_TRUST_CONFIG_SOURCE_NOT_HOST_JSON';
              else if (actual.configVersion !== expected.configVersion) blocker = 'AGG_TRUST_CONFIG_VERSION_MISMATCH_ON_HOST';
              else if (actual.providerId !== expected.providerId) blocker = 'AGG_TRUST_CONFIG_PROVIDER_MISMATCH_ON_HOST';
              else if (actual.configurationFingerprint !== expected.configurationFingerprint) blocker = 'AGG_TRUST_CONFIG_FINGERPRINT_MISMATCH_ON_HOST';
            } catch (error) { blocker = error?.code || 'AGG_TRUST_CONFIG_NOT_EFFECTIVE_ON_HOST'; }
            domainResults[spec.domain] = {
              configJsonVariablePresent, configJsonNonEmpty,
              providerIdVariablePresent: Object.hasOwn(observed.environment, spec.providerEnv),
              legacyPublicRootVariablePresent: Object.hasOwn(observed.environment, spec.publicKeyEnv),
              configured: configJsonNonEmpty, matchesSuppliedFile: blocker === null,
              expectedConfigVersion: expected.configVersion, effectiveConfigVersion: actual?.configVersion ?? null,
              expectedProviderId: expected.providerId, effectiveProviderId: actual?.providerId ?? null,
              expectedConfigurationFingerprint: expected.configurationFingerprint,
              effectiveConfigurationFingerprint: actual?.configurationFingerprint ?? null,
              blocker
            };
          }
          let effectiveSeparation = { verified: false, status: 'EFFECTIVE_FIVE_DOMAIN_SEPARATION_BLOCKED' };
          if (effectiveConfigurations.length === ADAPTIVE_GOAL_TRUST_DOMAIN_SPECS.length) {
            try {
              effectiveSeparation = { verified: true, status: 'EFFECTIVE_FIVE_DOMAIN_SEPARATION_VERIFIED',
                ...assertAdaptiveGoalTrustDomainConfigurationsDisjoint(effectiveConfigurations) };
            } catch (error) {
              effectiveSeparation = { verified: false, status: 'EFFECTIVE_FIVE_DOMAIN_SEPARATION_BLOCKED',
                code: error?.code || 'AGG_TRUST_DOMAIN_SEPARATION_FAILED' };
            }
          }
          const domainsVerified = Object.values(domainResults).every(item => item.matchesSuppliedFile) && effectiveSeparation.verified;
          const hostIdentityVerified = observed.parentExecutableIdentity.authenticated === true;
          const verified = domainsVerified && hostIdentityVerified;
          effectiveHostVerification = { result: verified ? 'PASS' : 'BLOCKED',
            ...(verified ? {} : { code: !domainsVerified
              ? effectiveSeparation.code || Object.values(domainResults).find(item => !item.matchesSuppliedFile)?.blocker || 'AGG_TRUST_CONFIG_NOT_EFFECTIVE_ON_HOST'
              : 'AGG_TRUST_CONFIG_HOST_IDENTITY_AUTHORITY_REQUIRED' }),
            pid: Number(args.effectiveHostPid), entryPoint: observed.entrypoint, parentLooksLikeHost: observed.parentLooksLikeHost,
            parentExecutableIdentity: observed.parentExecutableIdentity,
            checkedAt: new Date().toISOString(), domains: domainResults, effectiveSeparation,
            note: 'Process environment and five-domain separation may match, but parent executable basename/cmdline are not an authenticated host identity. A host-admin signed executable identity manifest or signed launcher attestation binding PID, start time, executable digest and active entrypoint is required. This inspection also does not verify active trust-ledger high-water rows or the external monotonic checkpoint.' };
        }
      } catch (error) {
        effectiveHostVerification = { result: 'BLOCKED', code: error?.code || 'AGG_TRUST_CONFIG_EFFECTIVE_HOST_INSPECTION_FAILED',
          message: String(error?.message || error), pid: Number(args.effectiveHostPid) };
      }
    }
    const result = { result: effectiveHostVerification?.result === 'BLOCKED' ? 'BLOCKED' : 'PASS',
      validationScope: 'ALL_FIVE_AGG_TRUST_DOMAINS', domains: domainFiles, separation,
      effectiveHostVerification, productionTrustEstablished: false, externalCheckpointVerified: false };
    console.log(JSON.stringify(result, null, 2));
    if (result.result !== 'PASS') process.exitCode = 3;
    return;
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
        const domainsVerified = Object.values(domainResults).every(item => item.matchesSuppliedFile) && effectivePairVerification.verified;
        const hostIdentityVerified = observed.parentExecutableIdentity.authenticated === true;
        const verified = domainsVerified && hostIdentityVerified;
        effectiveHostVerification = { result: verified ? 'PASS' : 'BLOCKED',
          ...(verified ? {} : { code: !domainsVerified
            ? effectivePairVerification.code || Object.values(domainResults).find(item => !item.matchesSuppliedFile)?.blocker || 'AGG_TRUST_CONFIG_NOT_EFFECTIVE_ON_HOST'
            : 'AGG_TRUST_CONFIG_HOST_IDENTITY_AUTHORITY_REQUIRED' }),
          pid: Number(args.effectiveHostPid), entryPoint: observed.entrypoint, parentLooksLikeHost: observed.parentLooksLikeHost,
          parentExecutableIdentity: observed.parentExecutableIdentity,
          checkedAt: new Date().toISOString(), domains: domainResults, effectivePairVerification,
          note: 'Process environment and pair separation may match, but parent executable basename/cmdline are not an authenticated host identity. A host-admin signed executable identity manifest or signed launcher attestation binding PID, start time, executable digest and active entrypoint is required. This inspection also does not verify the active trust-ledger high-water rows or external monotonic checkpoint.' };
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
