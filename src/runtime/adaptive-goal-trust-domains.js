import { loadAdaptiveGoalTrustConfiguration } from './adaptive-goal-trust-configuration.js';

/** The complete host-managed trust boundary used by RC.71 and later. */
export const ADAPTIVE_GOAL_TRUST_DOMAIN_SPECS = Object.freeze([
  Object.freeze({
    domain: 'goal_idea_verifier',
    configJsonEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON',
    providerEnv: 'AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID',
    publicKeyEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM',
    scope: 'agg.goal_idea_graph.verify'
  }),
  Object.freeze({
    domain: 'action_intent_reviewer',
    configJsonEnv: 'AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON',
    providerEnv: 'AGG_REVIEW_IDENTITY_PROVIDER_ID',
    publicKeyEnv: 'AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM',
    scope: 'agg.action_intent.review'
  }),
  Object.freeze({
    domain: 'execution_approval_policy',
    configJsonEnv: 'AGG_APPROVAL_POLICY_TRUST_CONFIG_JSON',
    providerEnv: 'AGG_APPROVAL_POLICY_PROVIDER_ID',
    publicKeyEnv: 'AGG_APPROVAL_POLICY_TRUST_ROOT_PUBLIC_KEY_PEM',
    scope: 'agg.approval.policy'
  }),
  Object.freeze({
    domain: 'action_intent_maker',
    configJsonEnv: 'AGG_ACTION_INTENT_MAKER_TRUST_CONFIG_JSON',
    providerEnv: 'AGG_ACTION_INTENT_MAKER_PROVIDER_ID',
    publicKeyEnv: 'AGG_ACTION_INTENT_MAKER_TRUST_ROOT_PUBLIC_KEY_PEM',
    scope: 'agg.action_intent.propose'
  }),
  Object.freeze({
    domain: 'execution_approval',
    configJsonEnv: 'AGG_EXECUTION_APPROVAL_TRUST_CONFIG_JSON',
    providerEnv: 'AGG_EXECUTION_APPROVAL_PROVIDER_ID',
    publicKeyEnv: 'AGG_EXECUTION_APPROVAL_TRUST_ROOT_PUBLIC_KEY_PEM',
    scope: 'agg.execution.approve'
  })
]);

const SHA256 = /^[a-f0-9]{64}$/;

function fail(code, message, details = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.details = details;
  throw error;
}

/** Load all five effective configurations and require administrator JSON. */
export function loadAdaptiveGoalTrustDomainConfigurations({ environment = process.env, now = Date.now() } = {}) {
  const configurations = ADAPTIVE_GOAL_TRUST_DOMAIN_SPECS.map(spec => {
    let configuration;
    try {
      configuration = loadAdaptiveGoalTrustConfiguration({
        configJsonEnv: spec.configJsonEnv,
        providerEnv: spec.providerEnv,
        publicKeyEnv: spec.publicKeyEnv,
        domain: spec.domain,
        scope: spec.scope,
        now,
        environment
      });
    } catch (error) {
      fail(error?.code || 'AGG_TRUST_DOMAIN_CONFIGURATION_INVALID',
        `trust domain ${spec.domain} is not configured: ${String(error?.message || error)}`, { domain: spec.domain });
    }
    if (configuration.configurationSource !== 'admin_json_environment' ||
        !Number.isSafeInteger(configuration.configVersion) || configuration.configVersion < 1) {
      fail('PRODUCTION_AGG_TRUST_JSON_CONFIGURATION_REQUIRED',
        `trust domain ${spec.domain} requires versioned administrator-managed JSON configuration`, { domain: spec.domain });
    }
    if (configuration.available !== true) {
      fail('PRODUCTION_AGG_TRUST_ROOT_NOT_CURRENT',
        `trust domain ${spec.domain} has no currently usable, non-revoked root inside its validity window`, { domain: spec.domain });
    }
    return configuration;
  });
  assertAdaptiveGoalTrustDomainConfigurationsDisjoint(configurations);
  return configurations;
}

/** Enforce provider and canonical SPKI uniqueness across all five domains. */
export function assertAdaptiveGoalTrustDomainConfigurationsDisjoint(configurations) {
  if (!Array.isArray(configurations) || configurations.length !== ADAPTIVE_GOAL_TRUST_DOMAIN_SPECS.length) {
    fail('AGG_TRUST_DOMAIN_SET_INCOMPLETE', 'all five independent trust domains are required', {
      expected: ADAPTIVE_GOAL_TRUST_DOMAIN_SPECS.length,
      observed: Array.isArray(configurations) ? configurations.length : null
    });
  }
  const byDomain = new Map(configurations.map(configuration => [configuration?.domain, configuration]));
  const expectedDomains = ADAPTIVE_GOAL_TRUST_DOMAIN_SPECS.map(spec => spec.domain);
  if (byDomain.size !== expectedDomains.length || expectedDomains.some(domain => !byDomain.has(domain))) {
    fail('AGG_TRUST_DOMAIN_SET_INCOMPLETE', 'trust configuration set does not contain each required domain exactly once');
  }
  const providerOwners = new Map();
  const rootOwners = new Map();
  for (const configuration of configurations) {
    if (typeof configuration.providerId !== 'string' || !configuration.providerId.trim() ||
        !Array.isArray(configuration.roots) || configuration.roots.length === 0) {
      fail('AGG_TRUST_DOMAIN_UNVERIFIABLE', `trust domain ${configuration.domain} has no verifiable provider or public roots`, {
        domain: configuration.domain
      });
    }
    const priorProvider = providerOwners.get(configuration.providerId);
    if (priorProvider) {
      fail('AGG_TRUST_DOMAINS_PROVIDER_COLLISION',
        `provider ID is shared by ${priorProvider} and ${configuration.domain}`, {
          firstDomain: priorProvider, secondDomain: configuration.domain
        });
    }
    providerOwners.set(configuration.providerId, configuration.domain);
    for (const root of configuration.roots) {
      if (!SHA256.test(root.trustRootSha256 || '')) {
        fail('AGG_TRUST_DOMAIN_UNVERIFIABLE', `trust domain ${configuration.domain} contains an invalid canonical SPKI fingerprint`, {
          domain: configuration.domain
        });
      }
      const priorRootOwner = rootOwners.get(root.trustRootSha256);
      if (priorRootOwner) {
        fail('AGG_TRUST_DOMAINS_ROOT_COLLISION',
          `canonical SPKI root is shared by ${priorRootOwner} and ${configuration.domain}`, {
            firstDomain: priorRootOwner, secondDomain: configuration.domain
          });
      }
      rootOwners.set(root.trustRootSha256, configuration.domain);
    }
  }
  return { providerIdsDistinct: true, publicRootsDisjoint: true, domainCount: configurations.length };
}
