#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { adaptiveGoalTrustConfigurationStatus, loadAdaptiveGoalTrustConfiguration } from '../src/runtime/adaptive-goal-trust-configuration.js';

function parseArgs(argv) {
  const parsed = { domain: null, config: null, peerConfig: null, requirePeerConfig: false };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--require-peer-config') { parsed.requirePeerConfig = true; continue; }
    if (!['--domain', '--config', '--peer-config'].includes(key)) throw new Error(`unsupported argument: ${key}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    if (key === '--domain') parsed.domain = value;
    else if (key === '--config') parsed.config = value;
    else parsed.peerConfig = value;
  }
  if (!['goal_idea_verifier', 'action_intent_reviewer'].includes(parsed.domain)) {
    throw new Error('--domain must be goal_idea_verifier or action_intent_reviewer');
  }
  if (!parsed.config) throw new Error('--config must name an administrator-provisioned JSON trust configuration file');
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  function readConfigFile(inputPath) {
    const configPath = path.resolve(inputPath);
    const stat = fs.lstatSync(configPath);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(configPath) !== configPath) {
      throw new Error('configuration path and every parent component must resolve to a canonical regular non-symlink file');
    }
    if (stat.size < 2 || stat.size > 128 * 1024) throw new Error('configuration file must be between 2 bytes and 128 KiB');
    return { configPath, contents: fs.readFileSync(configPath, 'utf8') };
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
  if (args.peerConfig) {
    const { configPath: peerConfigPath, contents: peerContents } = readConfigFile(args.peerConfig);
    const peerIsKnowledge = !isKnowledge;
    const peerEnv = peerIsKnowledge ? {
      configJsonEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON', providerEnv: 'AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID',
      publicKeyEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM', domain: 'goal_idea_verifier', scope: 'agg.goal_idea_graph.verify'
    } : {
      configJsonEnv: 'AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON', providerEnv: 'AGG_REVIEW_IDENTITY_PROVIDER_ID',
      publicKeyEnv: 'AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM', domain: 'action_intent_reviewer', scope: 'agg.action_intent.review'
    };
    const peerConfiguration = loadAdaptiveGoalTrustConfiguration({ ...peerEnv, environment: { [peerEnv.configJsonEnv]: peerContents } });
    if (!peerConfiguration.available) throw new Error('peer trust configuration has no currently usable, non-revoked root inside its validity window');
    const sharedRoots = configuration.roots.filter(key => peerConfiguration.roots.some(otherKey => otherKey.trustRootSha256 === key.trustRootSha256));
    if (configuration.providerId === peerConfiguration.providerId || sharedRoots.length) {
      throw new Error('trust-domain separation failed: provider IDs must differ and public roots must be disjoint');
    }
    pairVerification = { verified: true, status: 'PAIR_SEPARATION_VERIFIED', peerConfigPath,
      peerFileSha256: createHash('sha256').update(peerContents).digest('hex'),
      providerIdsDistinct: true, publicRootsDisjoint: true };
  }
  if (!status.available) {
    console.log(JSON.stringify({ result: 'BLOCKED', pairVerification, ...status }, null, 2));
    process.exitCode = 3;
    return;
  }
  console.log(JSON.stringify({ result: 'PASS', configPath, fileSha256: createHash('sha256').update(contents).digest('hex'), pairVerification, ...status }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(JSON.stringify({ result: 'FAIL', code: error?.code || 'TRUST_CONFIG_VALIDATION_FAILED', message: String(error?.message || error) }, null, 2));
    process.exitCode = 2;
  }
}
