import { createHash, randomUUID, verify as verifySignature } from 'node:crypto';
import {
  adaptiveGoalTrustConfigurationStatus,
  assertAdaptiveGoalTrustDomainsDisjoint,
  assertAndRecordAdaptiveGoalTrustConfiguration,
  findAdaptiveGoalTrustedRoot,
  inspectAdaptiveGoalTrustConfigurationHistory,
  loadAdaptiveGoalTrustConfiguration
} from './adaptive-goal-trust-configuration.js';
import { canonicalJson } from './workflow/plan.js';

export const ADAPTIVE_GOAL_APPROVAL_SUBSYSTEM_SCHEMA_VERSION = 1;
export const ADAPTIVE_GOAL_APPROVAL_POLICY_SCOPE = 'agg.approval.policy';
export const ADAPTIVE_GOAL_MAKER_AUTHORIZATION_SCOPE = 'agg.action_intent.propose';
export const ADAPTIVE_GOAL_EXECUTION_APPROVAL_SCOPE = 'agg.execution.approve';
export const ADAPTIVE_GOAL_APPROVAL_BINDING_VERSION = 1;

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_CONFIGS = Object.freeze([
  {
    id: 'policyAuthority', env: 'AGG_APPROVAL_POLICY_TRUST_CONFIG_JSON', providerEnv: 'AGG_APPROVAL_POLICY_PROVIDER_ID',
    publicKeyEnv: 'AGG_APPROVAL_POLICY_TRUST_ROOT_PUBLIC_KEY_PEM', domain: 'execution_approval_policy', scope: ADAPTIVE_GOAL_APPROVAL_POLICY_SCOPE
  },
  {
    id: 'makerAuthority', env: 'AGG_ACTION_INTENT_MAKER_TRUST_CONFIG_JSON', providerEnv: 'AGG_ACTION_INTENT_MAKER_PROVIDER_ID',
    publicKeyEnv: 'AGG_ACTION_INTENT_MAKER_TRUST_ROOT_PUBLIC_KEY_PEM', domain: 'action_intent_maker', scope: ADAPTIVE_GOAL_MAKER_AUTHORIZATION_SCOPE
  },
  {
    id: 'decisionAuthority', env: 'AGG_EXECUTION_APPROVAL_TRUST_CONFIG_JSON', providerEnv: 'AGG_EXECUTION_APPROVAL_PROVIDER_ID',
    publicKeyEnv: 'AGG_EXECUTION_APPROVAL_TRUST_ROOT_PUBLIC_KEY_PEM', domain: 'execution_approval', scope: ADAPTIVE_GOAL_EXECUTION_APPROVAL_SCOPE
  }
]);
const APPROVAL_POLICY_OBSERVED_EVENT = 'adaptive_goal.approval_policy_version_observed';

function fail(code, message, details = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.details = details;
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function exactKeys(value, expected, field) {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    fail('AGG_APPROVAL_EVIDENCE_SHAPE_INVALID', `${field} contains missing or unexpected fields`);
  }
}

function assertString(value, field, maxLength = 300) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > maxLength) {
    fail('AGG_APPROVAL_EVIDENCE_SHAPE_INVALID', `${field} must be a bounded canonical non-empty string`);
  }
  return value;
}

function assertTimestamp(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') fail('AGG_APPROVAL_EVIDENCE_SHAPE_INVALID', `${field} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail('AGG_APPROVAL_EVIDENCE_SHAPE_INVALID', `${field} must be a canonical ISO timestamp`);
  }
  return parsed.getTime();
}

function assertNonce(value, field) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('AGG_APPROVAL_EVIDENCE_NONCE_INVALID', `${field} must be a canonical UUID nonce`);
  return value;
}

function readTrustConfig(spec, now, environment = process.env) {
  const config = loadAdaptiveGoalTrustConfiguration({
    configJsonEnv: spec.env,
    providerEnv: spec.providerEnv,
    publicKeyEnv: spec.publicKeyEnv,
    domain: spec.domain,
    scope: spec.scope,
    now,
    environment
  });
  if (config.configurationSource !== 'admin_json_environment') {
    fail('AGG_APPROVAL_TRUST_CONFIG_NOT_HOST_MANAGED', `${spec.domain} must use the host-managed versioned JSON trust configuration; legacy single-key configuration is not accepted`);
  }
  if (config.available !== true) fail('AGG_APPROVAL_TRUST_CONFIG_UNAVAILABLE', `${spec.domain} has no currently valid configured public root`);
  return config;
}

function assertTrustConfigObserved(db, configuration, now, { record = false } = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function' || db.isTransaction === true) {
    fail('AGG_APPROVAL_TRUST_LEDGER_UNAVAILABLE', 'approval trust verification requires the host-managed non-transactional trust ledger');
  }
  const inspection = inspectAdaptiveGoalTrustConfigurationHistory(db, configuration.domain, configuration);
  if (['rollback_detected', 'version_reused', 'time_rollback_detected', 'version_gap_detected', 'unavailable'].includes(inspection.status)) {
    fail(inspection.code || 'AGG_APPROVAL_TRUST_CONFIG_ANTI_ROLLBACK_FAILED', `approval trust configuration ${configuration.domain} failed its anti-rollback check`, { inspection });
  }
  if (record) {
    // This write is reachable only from the explicit, state-changing trust
    // configuration status tool. Approval, preflight, and dispatch paths only
    // inspect the ledger and fail closed when an administrator has not observed
    // the exact configuration version/fingerprint first.
    try { assertAndRecordAdaptiveGoalTrustConfiguration(db, configuration, { now }); }
    catch (error) { fail(error?.code || 'AGG_APPROVAL_TRUST_LEDGER_WRITE_FAILED', String(error?.message || error)); }
  } else if (!inspection.latest || inspection.latest.config_version !== configuration.configVersion ||
      inspection.latest.configuration_fingerprint !== configuration.configurationFingerprint ||
      inspection.latest.provider_id !== configuration.providerId) {
    fail('AGG_APPROVAL_TRUST_CONFIG_NOT_OBSERVED', `host administrator must explicitly observe the exact ${configuration.domain} trust configuration before approval can be verified`, { inspection });
  }
  return inspectAdaptiveGoalTrustConfigurationHistory(db, configuration.domain, configuration);
}

function assertAllTrustDomainsDisjoint(source, reviewer, approvalConfigs) {
  const all = [source, reviewer, ...approvalConfigs];
  const providerOwners = new Map();
  const rootOwners = new Map();
  for (const config of all) {
    if (!config || typeof config.providerId !== 'string' || !config.providerId.trim() || !Array.isArray(config.roots)) {
      fail('AGG_APPROVAL_TRUST_DOMAIN_UNVERIFIABLE', 'all source, reviewer, policy, maker, and approval trust domains must have observable provider IDs and roots');
    }
    const priorProvider = providerOwners.get(config.providerId);
    if (priorProvider && priorProvider !== config.domain) {
      fail('AGG_APPROVAL_TRUST_DOMAINS_PROVIDER_COLLISION', `trust provider ${config.providerId} is shared by ${priorProvider} and ${config.domain}`);
    }
    providerOwners.set(config.providerId, config.domain);
    for (const root of config.roots) {
      const priorDomain = rootOwners.get(root.trustRootSha256);
      if (priorDomain && priorDomain !== config.domain) {
        fail('AGG_APPROVAL_TRUST_DOMAINS_ROOT_COLLISION', `a public trust root is shared by ${priorDomain} and ${config.domain}`);
      }
      rootOwners.set(root.trustRootSha256, config.domain);
    }
  }
  // Keep the established source/reviewer check as an independent invariant too.
  assertAdaptiveGoalTrustDomainsDisjoint(source, reviewer);
  for (const config of approvalConfigs) {
    assertAdaptiveGoalTrustDomainsDisjoint(source, config);
    assertAdaptiveGoalTrustDomainsDisjoint(reviewer, config);
  }
}

function loadVerificationContext({ trustConfigurationDb, now = Date.now(), record = false,
  sourceConfiguration = null, reviewerConfiguration = null, environment = process.env } = {}) {
  if (!Number.isSafeInteger(now) || now < 0) fail('AGG_APPROVAL_CLOCK_INVALID', 'approval verification time must be a non-negative safe integer');
  const approvalConfigs = KEY_CONFIGS.map(spec => readTrustConfig(spec, now, environment));
  for (const config of approvalConfigs) assertTrustConfigObserved(trustConfigurationDb, config, now, { record });
  if (!sourceConfiguration) sourceConfiguration = loadAdaptiveGoalTrustConfiguration({
    configJsonEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON', providerEnv: 'AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID',
    publicKeyEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM', domain: 'goal_idea_verifier',
    scope: 'agg.goal_idea_graph.verify', now, environment
  });
  if (!reviewerConfiguration) reviewerConfiguration = loadAdaptiveGoalTrustConfiguration({
    configJsonEnv: 'AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON', providerEnv: 'AGG_REVIEW_IDENTITY_PROVIDER_ID',
    publicKeyEnv: 'AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM', domain: 'action_intent_reviewer',
    scope: 'agg.action_intent.review', now, environment
  });
  assertAllTrustDomainsDisjoint(sourceConfiguration, reviewerConfiguration, approvalConfigs);
  return { policy: approvalConfigs[0], maker: approvalConfigs[1], decisions: approvalConfigs[2] };
}

function bindingFromCandidate({ jobId, proposalHash, candidate, sourceGraphVerification }) {
  if (!isRecord(candidate) || !isRecord(candidate.executionPlan) ||
      candidate.executionPlan.plan_hash !== candidate.compiler?.compilerPlanHash ||
      !isRecord(candidate.hashes) || !isRecord(sourceGraphVerification)) {
    fail('AGG_APPROVAL_BINDING_UNAVAILABLE', 'a fresh candidate, exact immutable compiler plan, current source snapshot, and evidence hashes are required');
  }
  const executionPlan = candidate.executionPlan;
  const requiredOperations = executionPlan.required_operations || [];
  const workspaceWriteScopes = executionPlan.workspace_write_scopes || [];
  const taskActionScopes = (executionPlan.children || []).map(task => ({
    task_id: task.id,
    role: task.role,
    dependencies: task.dependencies || [],
    action_intent: task.execution?.action_intent || null,
    executable: task.execution?.executable || null,
    args: task.execution?.args || null,
    executor: task.execution?.executor || null
  }));
  const permissionScopeHash = hash({
    workflow_id: executionPlan.workflow_id,
    workflow_version: executionPlan.workflow_version,
    required_operations: requiredOperations,
    workspace_write_scopes: workspaceWriteScopes,
    task_action_scopes: taskActionScopes
  });
  const binding = {
    schema_version: ADAPTIVE_GOAL_APPROVAL_BINDING_VERSION,
    wrapper_job_id: assertString(jobId, 'jobId', 200),
    proposal_hash: assertHash(proposalHash, 'proposalHash'),
    candidate_id: assertString(candidate.candidateId, 'candidate.candidateId', 200),
    candidate_fingerprint: assertHash(candidate.fingerprint, 'candidate.fingerprint'),
    candidate_hash: assertHash(candidate.candidateHash, 'candidate.candidateHash'),
    immutable_plan_hash: assertHash(executionPlan.plan_hash, 'executionPlan.plan_hash'),
    source_snapshot_hash: assertHash(sourceGraphVerification.snapshotHash, 'sourceGraphVerification.snapshotHash'),
    source_evidence_manifest_hash: assertHash(sourceGraphVerification.evidenceManifestHash, 'sourceGraphVerification.evidenceManifestHash'),
    reviewed_action_intent_hash: assertHash(candidate.hashes.reviewedActionIntentHash, 'reviewedActionIntentHash'),
    reviewed_task_input_contract_hash: assertHash(candidate.hashes.reviewedTaskInputContractHash, 'reviewedTaskInputContractHash'),
    evidence_hash: assertHash(candidate.hashes.evidenceHash, 'evidenceHash'),
    source_evidence_hash: assertHash(candidate.hashes.sourceEvidenceHash, 'sourceEvidenceHash'),
    permission_scope_hash: permissionScopeHash
  };
  return binding;
}

function assertHash(value, field) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail('AGG_APPROVAL_BINDING_INVALID', `${field} must be a SHA-256 digest`);
  return value;
}

function loadTrustedRoot(configuration, envelope, expectedScope, field, now = Date.now()) {
  if (envelope.scope !== expectedScope || envelope.provider_id !== configuration.providerId ||
      envelope.trust_root_sha256 === undefined) {
    fail('AGG_APPROVAL_SIGNATURE_SCOPE_MISMATCH', `${field} provider or scope does not match its independently configured trust domain`);
  }
  const issuedAt = assertTimestamp(envelope.issued_at, `${field}.issued_at`);
  const expiresAt = assertTimestamp(envelope.expires_at, `${field}.expires_at`);
  if (issuedAt > now + 60_000 || expiresAt <= now || expiresAt <= issuedAt) {
    fail('AGG_APPROVAL_EVIDENCE_EXPIRED', `${field} is future-dated, expired, or has an invalid time window`);
  }
  let root;
  try { root = findAdaptiveGoalTrustedRoot(configuration, envelope.trust_root_sha256, { issuedAt, now: Date.now() }); }
  catch (error) { fail(error?.code || 'AGG_APPROVAL_TRUST_ROOT_REJECTED', `${field}: ${String(error?.message || error)}`); }
  if (!root.usableNow || root.scope !== expectedScope) fail('AGG_APPROVAL_TRUST_ROOT_REJECTED', `${field} signing root is not currently valid for ${expectedScope}`);
  return { root, issuedAt, expiresAt };
}

function verifyEnvelopeSignature(envelope, configuration, expectedScope, expectedKind, field, now = Date.now()) {
  const { root, issuedAt, expiresAt } = loadTrustedRoot(configuration, envelope, expectedScope, field, now);
  if (envelope.schema_version !== ADAPTIVE_GOAL_APPROVAL_SUBSYSTEM_SCHEMA_VERSION || envelope.kind !== expectedKind ||
      envelope.signature_algorithm !== 'Ed25519' || typeof envelope.signature !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.signature)) {
    fail('AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID', `${field} has invalid version, kind, algorithm, or signature encoding`);
  }
  const unsigned = { ...envelope };
  delete unsigned.signature;
  let valid = false;
  try { valid = verifySignature(null, Buffer.from(canonicalJson(unsigned), 'utf8'), root.publicKey, Buffer.from(envelope.signature, 'base64')); }
  catch { valid = false; }
  if (!valid) fail('AGG_APPROVAL_SIGNATURE_INVALID', `${field} signature does not verify under the current trusted public root`);
  const nonce = assertNonce(envelope.nonce, `${field}.nonce`);
  return { root, issuedAt, expiresAt, nonce, unsigned, signedEnvelopeHash: hash(envelope) };
}

function assertPolicy(policy, context, expectedBinding, now) {
  exactKeys(policy, ['schema_version','kind','provider_id','trust_root_sha256','nonce','issued_at','expires_at','scope',
    'policy_id','policy_version','required_approval_count','required_distinct_trust_domains','required_roles',
    'maker_checker_separation','reject_veto','max_vote_age_seconds','reviewer_registry','signature_algorithm','signature'], 'policy');
  const verified = verifyEnvelopeSignature(policy, context.policy, ADAPTIVE_GOAL_APPROVAL_POLICY_SCOPE,
    'adaptive_goal_execution_approval_policy', 'policy', now);
  // The signed policy defines a reusable policy version (quorum, roles, trust
  // domains, age and veto semantics). It is intentionally not candidate-bound:
  // each maker attestation and checker decision is separately signed over the
  // exact current plan/action/scope/evidence binding below. This lets one
  // policy version govern multiple proposals without reusing its version for
  // different hashes merely because the target plan changed.
  assertString(policy.policy_id, 'policy.policy_id', 200);
  if (!Number.isSafeInteger(policy.policy_version) || policy.policy_version < 1) fail('AGG_APPROVAL_POLICY_VERSION_INVALID', 'policy_version must be a positive safe integer');
  if (!Number.isSafeInteger(policy.required_approval_count) || policy.required_approval_count < 1 || policy.required_approval_count > 32 ||
      !Number.isSafeInteger(policy.required_distinct_trust_domains) || policy.required_distinct_trust_domains < 1 ||
      policy.required_distinct_trust_domains > policy.required_approval_count ||
      typeof policy.maker_checker_separation !== 'boolean' || policy.maker_checker_separation !== true ||
      typeof policy.reject_veto !== 'boolean' || policy.reject_veto !== true ||
      !Number.isSafeInteger(policy.max_vote_age_seconds) || policy.max_vote_age_seconds < 1 || policy.max_vote_age_seconds > 86400 ||
      !Array.isArray(policy.required_roles) || !policy.required_roles.length || policy.required_roles.length > 16 ||
      policy.required_roles.some(role => typeof role !== 'string' || !role.trim() || role.trim() !== role) ||
      new Set(policy.required_roles).size !== policy.required_roles.length ||
      !Array.isArray(policy.reviewer_registry) || policy.reviewer_registry.length < policy.required_approval_count || policy.reviewer_registry.length > 64) {
    fail('AGG_APPROVAL_POLICY_RULES_INVALID', 'signed policy must explicitly define positive quorum, distinct trust domains, required roles, maker/checker separation, veto, vote age, and reviewer registry');
  }
  const subjects = new Set();
  const registryRoots = new Set();
  const domains = new Set();
  const registry = new Map();
  for (const [index, item] of policy.reviewer_registry.entries()) {
    exactKeys(item, ['subject','role','trust_domain','trust_root_sha256'], `policy.reviewer_registry[${index}]`);
    assertString(item.subject, `policy.reviewer_registry[${index}].subject`, 200);
    assertString(item.role, `policy.reviewer_registry[${index}].role`, 120);
    assertString(item.trust_domain, `policy.reviewer_registry[${index}].trust_domain`, 120);
    assertHash(item.trust_root_sha256, `policy.reviewer_registry[${index}].trust_root_sha256`);
    if (subjects.has(item.subject)) fail('AGG_APPROVAL_POLICY_REVIEWER_DUPLICATE', `reviewer subject ${item.subject} is repeated in the signed registry`);
    // A single public key may not be declared to represent multiple trust
    // domains within a signed policy. Domain independence is rooted in both
    // this authority-signed roster and the host-managed approval trust config.
    if (registryRoots.has(item.trust_root_sha256)) fail('AGG_APPROVAL_POLICY_ROOT_DUPLICATE', `reviewer root ${item.trust_root_sha256} is reused in the signed reviewer registry`);
    if (!context.decisions.roots.some(root => root.trustRootSha256 === item.trust_root_sha256 && root.usableNow && root.revokedAt === null)) {
      fail('AGG_APPROVAL_POLICY_REVIEWER_ROOT_UNTRUSTED', `reviewer registry root ${item.trust_root_sha256} is not a currently valid host-managed execution-approval trust root`);
    }
    subjects.add(item.subject); registryRoots.add(item.trust_root_sha256); domains.add(item.trust_domain);
    registry.set(item.subject, item);
  }
  if (domains.size < policy.required_distinct_trust_domains) {
    fail('AGG_APPROVAL_POLICY_QUORUM_UNREACHABLE', 'reviewer registry cannot satisfy its own required distinct trust-domain quorum');
  }
  if (policy.required_roles.some(role => !policy.reviewer_registry.some(item => item.role === role))) {
    fail('AGG_APPROVAL_POLICY_ROLE_QUORUM_UNREACHABLE', 'reviewer registry cannot satisfy one or more required roles');
  }
  if (verified.expiresAt <= now) fail('AGG_APPROVAL_POLICY_EXPIRED', 'signed approval policy expired');
  return { ...verified, registry, policyHash: verified.signedEnvelopeHash };
}

function assertFreshApprovalNonces(db, signedEvidence, { excludeApprovalEventId = null } = {}) {
  if (!db || typeof db.prepare !== 'function') fail('AGG_APPROVAL_REPLAY_LEDGER_UNAVAILABLE', 'approval replay protection requires the workflow event ledger');
  const seen = new Map();
  const rows = db.prepare("SELECT event_id,job_id,payload_json FROM events WHERE type='approval.approved' ORDER BY created_at ASC,rowid ASC").all();
  for (const row of rows) {
    if (excludeApprovalEventId && row.event_id === excludeApprovalEventId) continue;
    let payload;
    try { payload = JSON.parse(row.payload_json); }
    catch { fail('AGG_APPROVAL_REPLAY_LEDGER_UNVERIFIABLE', `approval event ${row.event_id} is malformed; nonce replay cannot be ruled out`); }
    if (JSON.stringify(payload) !== row.payload_json || !isRecord(payload)) fail('AGG_APPROVAL_REPLAY_LEDGER_UNVERIFIABLE', `approval event ${row.event_id} is non-canonical; nonce replay cannot be ruled out`);
    const evidence = payload.approvalBinding?.signedEvidence;
    if (!evidence) continue; // Historic non-AGG approvals do not carry this contract.
    if (!isRecord(evidence) || !isRecord(evidence.policy) || !isRecord(evidence.maker_attestation) || !Array.isArray(evidence.decisions)) {
      fail('AGG_APPROVAL_REPLAY_LEDGER_UNVERIFIABLE', `persisted approval event ${row.event_id} contains a malformed approval-evidence envelope`);
    }
    // A signed policy is a reusable ruleset; its version/hash has separate
    // high-water protection. Only maker attestations and checker votes are
    // one-use decisions and participate in approval nonce replay detection.
    const nonces = [evidence.maker_attestation.nonce, ...evidence.decisions.map(item => item?.nonce)];
    for (const nonce of nonces) {
      if (typeof nonce !== 'string' || !UUID.test(nonce)) fail('AGG_APPROVAL_REPLAY_LEDGER_UNVERIFIABLE', `persisted approval event ${row.event_id} has a malformed nonce`);
      if (seen.has(nonce)) fail('AGG_APPROVAL_REPLAY_LEDGER_AMBIGUOUS', `nonce ${nonce} already appears in multiple persisted approval records`, { firstEventId: seen.get(nonce), secondEventId: row.event_id });
      seen.set(nonce, row.event_id);
    }
  }
  const incoming = [signedEvidence.maker_attestation?.nonce, ...(signedEvidence.decisions || []).map(item => item?.nonce)];
  if (new Set(incoming).size !== incoming.length) fail('AGG_APPROVAL_NONCE_DUPLICATE', 'maker attestation and reviewer decisions must each have distinct nonces');
  for (const nonce of incoming) {
    assertNonce(nonce, 'approval evidence nonce');
    if (seen.has(nonce)) fail('AGG_APPROVAL_NONCE_REPLAY', `approval evidence nonce ${nonce} has already been durably used`, { priorEventId: seen.get(nonce) });
  }
}

function readApprovalPolicyHighWater(workflowDb, policyId) {
  if (!workflowDb || typeof workflowDb.prepare !== 'function') {
    fail('AGG_APPROVAL_POLICY_LEDGER_UNAVAILABLE', 'approval policy version continuity requires the durable workflow event ledger');
  }
  const rows = workflowDb.prepare(`SELECT event_id,job_id,type,payload_json FROM events
    WHERE type=? AND json_extract(payload_json,'$.policy_id')=? ORDER BY rowid ASC`)
    .all(APPROVAL_POLICY_OBSERVED_EVENT, policyId);
  let latest = null;
  for (const row of rows) {
    let payload;
    try { payload = JSON.parse(row.payload_json); }
    catch { fail('AGG_APPROVAL_POLICY_LEDGER_UNVERIFIABLE', `approval policy continuity event ${row.event_id} is malformed`); }
    if (!isRecord(payload) || JSON.stringify(payload) !== row.payload_json ||
        payload.schema_version !== ADAPTIVE_GOAL_APPROVAL_SUBSYSTEM_SCHEMA_VERSION ||
        payload.policy_id !== policyId || !Number.isSafeInteger(payload.policy_version) || payload.policy_version < 1 ||
        !SHA256.test(payload.policy_hash || '') ||
        !UUID.test(payload.nonce || '') || typeof payload.observed_at !== 'string' ||
        !Number.isFinite(Date.parse(payload.observed_at))) {
      fail('AGG_APPROVAL_POLICY_LEDGER_UNVERIFIABLE', `approval policy continuity event ${row.event_id} violates its schema`);
    }
    const expectedEventId = hash(`${APPROVAL_POLICY_OBSERVED_EVENT}|${payload.policy_id}|${payload.policy_version}|${payload.policy_hash}`);
    if (row.event_id !== expectedEventId) fail('AGG_APPROVAL_POLICY_LEDGER_UNVERIFIABLE', `approval policy continuity event ${row.event_id} has an invalid identity`);
    if (!latest || payload.policy_version > latest.policyVersion) latest = {
      policyVersion: payload.policy_version, policyHash: payload.policy_hash, eventId: row.event_id
    };
    else if (payload.policy_version === latest.policyVersion && payload.policy_hash !== latest.policyHash) {
      fail('AGG_APPROVAL_POLICY_VERSION_REUSED', `policy ${policyId} reused observed version ${payload.policy_version} for a different signed policy hash`);
    }
  }
  return latest;
}

export function assertAdaptiveGoalApprovalPolicyHighWater(workflowDb, { policyId, policyVersion, policyHash,
  requireObserved = false } = {}) {
  assertString(policyId, 'policyId', 200);
  if (!Number.isSafeInteger(policyVersion) || policyVersion < 1) fail('AGG_APPROVAL_POLICY_VERSION_INVALID', 'policy version must be a positive safe integer');
  assertHash(policyHash, 'policyHash');
  const latest = readApprovalPolicyHighWater(workflowDb, policyId);
  if (!latest) {
    if (requireObserved) fail('AGG_APPROVAL_POLICY_NOT_OBSERVED', 'no accepted policy high-water record exists for this approval policy');
    return { status: 'unobserved', latest: null };
  }
  if (policyVersion < latest.policyVersion) {
    fail('AGG_APPROVAL_POLICY_ROLLBACK', `policy version ${policyVersion} is older than observed high-water version ${latest.policyVersion}`, { latest });
  }
  if (policyVersion === latest.policyVersion && policyHash !== latest.policyHash) {
    fail('AGG_APPROVAL_POLICY_VERSION_REUSED', `policy ${policyId} reused version ${policyVersion} for a different hash`, { latest });
  }
  if (requireObserved && (policyVersion !== latest.policyVersion || policyHash !== latest.policyHash)) {
    fail('AGG_APPROVAL_POLICY_NOT_CURRENT', `approval policy ${policyId}@${policyVersion} is not the current observed high-water version`, { latest });
  }
  return { status: policyVersion === latest.policyVersion ? 'current' : 'newer_than_observed', latest };
}

/**
 * Advance the approval-policy high-water inside the same workflow transaction
 * that persists the human approval. This event ledger is not production trust
 * authority; it prevents replay/downgrade after a newer signed policy has been
 * observed in this durable workflow store. Host-managed trust configuration
 * still authenticates the policy signer and is independently checked at every
 * approval and dispatch boundary.
 */
export function recordAdaptiveGoalApprovalPolicyHighWater(workflowDb, { jobId, policyId, policyVersion, policyHash,
  nonce = randomUUID(), now = Date.now() } = {}) {
  if (!workflowDb || typeof workflowDb.exec !== 'function' || workflowDb.isTransaction !== true) {
    fail('AGG_APPROVAL_POLICY_RECORD_REQUIRES_TRANSACTION', 'policy high-water must be appended under the workflow approval writer transaction');
  }
  assertString(jobId, 'jobId', 200);
  assertString(policyId, 'policyId', 200);
  if (!Number.isSafeInteger(policyVersion) || policyVersion < 1) fail('AGG_APPROVAL_POLICY_VERSION_INVALID', 'policy version must be a positive safe integer');
  assertHash(policyHash, 'policyHash');
  assertNonce(nonce, 'policy-observation nonce');
  if (!Number.isSafeInteger(now) || now < 0) fail('AGG_APPROVAL_CLOCK_INVALID', 'policy observation time must be a non-negative safe integer');
  const highWater = assertAdaptiveGoalApprovalPolicyHighWater(workflowDb, { policyId, policyVersion, policyHash });
  if (highWater.status === 'current') return { recorded: false, ...highWater };
  if (highWater.status === 'newer_than_observed' && policyVersion !== highWater.latest.policyVersion + 1) {
    fail('AGG_APPROVAL_POLICY_VERSION_GAP', `new approval policy version ${policyVersion} must immediately follow observed version ${highWater.latest.policyVersion}`, { latest: highWater.latest });
  }
  const payload = {
    schema_version: ADAPTIVE_GOAL_APPROVAL_SUBSYSTEM_SCHEMA_VERSION,
    policy_id: policyId,
    policy_version: policyVersion,
    policy_hash: policyHash,
    nonce,
    observed_at: new Date(now).toISOString()
  };
  const eventId = hash(`${APPROVAL_POLICY_OBSERVED_EVENT}|${policyId}|${policyVersion}|${policyHash}`);
  const existing = workflowDb.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(eventId);
  if (existing) {
    if (existing.type !== APPROVAL_POLICY_OBSERVED_EVENT ||
        JSON.parse(existing.payload_json).policy_hash !== policyHash ||
        JSON.parse(existing.payload_json).policy_version !== policyVersion) {
      fail('AGG_APPROVAL_POLICY_LEDGER_IDENTITY_CONFLICT', 'existing policy high-water event does not match the exact signed policy identity');
    }
    return { recorded: false, status: 'current', latest: { policyVersion, policyHash, eventId } };
  }
  workflowDb.prepare('INSERT INTO events(event_id,job_id,type,payload_json,created_at) VALUES(?,?,?,?,?)')
    .run(eventId, jobId, APPROVAL_POLICY_OBSERVED_EVENT, JSON.stringify(payload), new Date(now).toISOString());
  const persisted = workflowDb.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(eventId);
  if (!persisted || persisted.job_id !== jobId || persisted.type !== APPROVAL_POLICY_OBSERVED_EVENT ||
      persisted.payload_json !== JSON.stringify(payload)) {
    fail('AGG_APPROVAL_POLICY_LEDGER_READBACK_MISMATCH', 'policy high-water event failed exact transactional readback');
  }
  return { recorded: true, status: 'current', latest: { policyVersion, policyHash, eventId } };
}

export function buildAdaptiveGoalApprovalBinding({ jobId, proposalHash, candidate, sourceGraphVerification }) {
  return bindingFromCandidate({ jobId, proposalHash, candidate, sourceGraphVerification });
}

/**
 * Verify a signed policy, maker attestation, and independent signed votes over
 * one exact current Execution Graph action candidate. This function is
 * read-only; the caller must persist the returned binding in the same SQLite
 * transaction as the workflow approval. `trustConfigurationDb` is inspected,
 * never written, by this verifier.
 */
export function verifyAdaptiveGoalExecutionApprovalEvidence({ evidence, jobId, proposalHash, candidate,
  sourceGraphVerification, trustConfigurationDb, workflowDb, now = Date.now(), excludeApprovalEventId = null,
  environment = process.env, sourceConfiguration = null, reviewerConfiguration = null,
  requireCurrentPolicyObserved = false } = {}) {
  if (!Number.isSafeInteger(now) || now < 0) fail('AGG_APPROVAL_CLOCK_INVALID', 'approval verification time must be a non-negative safe integer');
  exactKeys(evidence, ['schema_version','policy','maker_attestation','decisions'], 'approval evidence envelope');
  if (evidence.schema_version !== ADAPTIVE_GOAL_APPROVAL_SUBSYSTEM_SCHEMA_VERSION ||
      !Array.isArray(evidence.decisions) || evidence.decisions.length < 1 || evidence.decisions.length > 64) {
    fail('AGG_APPROVAL_EVIDENCE_SHAPE_INVALID', 'approval evidence must use schema v1 and contain 1–64 signed decisions');
  }
  const expectedBinding = bindingFromCandidate({ jobId, proposalHash, candidate, sourceGraphVerification });
  const configs = loadVerificationContext({ trustConfigurationDb, now, environment, sourceConfiguration, reviewerConfiguration });
  const policyResult = assertPolicy(evidence.policy, configs, expectedBinding, now);
  const policy = evidence.policy;
  const policyHighWater = assertAdaptiveGoalApprovalPolicyHighWater(workflowDb, {
    policyId: policy.policy_id, policyVersion: policy.policy_version, policyHash: policyResult.policyHash,
    requireObserved: requireCurrentPolicyObserved
  });
  const maker = evidence.maker_attestation;
  exactKeys(maker, ['schema_version','kind','provider_id','trust_root_sha256','nonce','issued_at','expires_at','scope',
    'maker_subject','policy_id','policy_version','policy_hash','binding','signature_algorithm','signature'], 'maker attestation');
  const makerResult = verifyEnvelopeSignature(maker, configs.maker, ADAPTIVE_GOAL_MAKER_AUTHORIZATION_SCOPE,
    'adaptive_goal_action_intent_maker_attestation', 'maker_attestation', now);
  assertString(maker.maker_subject, 'maker_attestation.maker_subject', 200);
  if (maker.policy_id !== policy.policy_id || maker.policy_version !== policy.policy_version ||
      maker.policy_hash !== policyResult.policyHash || canonicalJson(maker.binding) !== canonicalJson(expectedBinding) ||
      makerResult.issuedAt < policyResult.issuedAt || makerResult.issuedAt > now + 60_000 ||
      makerResult.expiresAt > policyResult.expiresAt) {
    fail('AGG_APPROVAL_MAKER_BINDING_MISMATCH', 'maker attestation does not bind the exact signed policy, current candidate/plan/action/scope/evidence, or policy time window');
  }
  const decisionResults = [];
  const usedSubjects = new Set();
  const usedDomains = new Set();
  const approvedRoles = new Set();
  let rejected = false;
  for (const [index, vote] of evidence.decisions.entries()) {
    const field = `decisions[${index}]`;
    exactKeys(vote, ['schema_version','kind','provider_id','trust_root_sha256','nonce','issued_at','expires_at','scope',
      'policy_id','policy_version','policy_hash','reviewer_subject','reviewer_role','trust_domain','decision','binding',
      'signature_algorithm','signature'], field);
    const verified = verifyEnvelopeSignature(vote, configs.decisions, ADAPTIVE_GOAL_EXECUTION_APPROVAL_SCOPE,
      'adaptive_goal_execution_approval_decision', field, now);
    assertString(vote.reviewer_subject, `${field}.reviewer_subject`, 200);
    assertString(vote.reviewer_role, `${field}.reviewer_role`, 120);
    assertString(vote.trust_domain, `${field}.trust_domain`, 120);
    const roster = policyResult.registry.get(vote.reviewer_subject);
    if (!roster || roster.role !== vote.reviewer_role || roster.trust_domain !== vote.trust_domain ||
        roster.trust_root_sha256 !== vote.trust_root_sha256 || policyResult.root.trustRootSha256 === vote.trust_root_sha256 ||
        canonicalJson(vote.binding) !== canonicalJson(expectedBinding) || vote.policy_id !== policy.policy_id ||
        vote.policy_version !== policy.policy_version || vote.policy_hash !== policyResult.policyHash ||
        verified.issuedAt < policyResult.issuedAt || verified.issuedAt > now + 60_000 ||
        verified.issuedAt < now - policy.max_vote_age_seconds * 1000 || verified.expiresAt > policyResult.expiresAt) {
      fail('AGG_APPROVAL_DECISION_BINDING_MISMATCH', `${field} does not match the signed reviewer registry, policy, current action/plan/evidence scope, or permitted validity window`);
    }
    if (usedSubjects.has(vote.reviewer_subject)) fail('AGG_APPROVAL_REVIEWER_DUPLICATE', 'one authenticated reviewer may cast at most one vote in a policy quorum');
    usedSubjects.add(vote.reviewer_subject);
    if (vote.decision !== 'approve' && vote.decision !== 'reject') fail('AGG_APPROVAL_DECISION_INVALID', `${field}.decision must be approve or reject`);
    if (vote.decision === 'reject') rejected = true;
    if (vote.decision === 'approve') {
      usedDomains.add(vote.trust_domain);
      approvedRoles.add(vote.reviewer_role);
    }
    decisionResults.push({
      reviewerSubject: vote.reviewer_subject,
      reviewerRole: vote.reviewer_role,
      trustDomain: vote.trust_domain,
      trustRootSha256: vote.trust_root_sha256,
      decision: vote.decision,
      nonce: vote.nonce,
      signedEnvelopeHash: verified.signedEnvelopeHash,
      expiresAt: vote.expires_at
    });
  }
  if (maker.maker_subject && usedSubjects.has(maker.maker_subject)) {
    fail('AGG_APPROVAL_MAKER_CHECKER_VIOLATION', 'the authenticated maker/requester may not vote as a checker for the same action');
  }
  if (policy.reject_veto === true && rejected) fail('AGG_APPROVAL_VETO_REJECTED', 'signed policy requires any reject vote to veto the approval');
  const approvals = decisionResults.filter(item => item.decision === 'approve');
  if (approvals.length < policy.required_approval_count || usedDomains.size < policy.required_distinct_trust_domains ||
      policy.required_roles.some(role => !approvedRoles.has(role))) {
    fail('AGG_APPROVAL_QUORUM_NOT_MET', 'signed approval evidence does not meet the policy-defined reviewer count, distinct trust-domain quorum, and required roles', {
      requiredApprovals: policy.required_approval_count, observedApprovals: approvals.length,
      requiredDistinctTrustDomains: policy.required_distinct_trust_domains, observedDistinctTrustDomains: usedDomains.size,
      requiredRoles: policy.required_roles, observedRoles: [...approvedRoles]
    });
  }
  if (rejected) fail('AGG_APPROVAL_QUORUM_NOT_MET', 'a rejection cannot count toward an approval quorum');
  assertFreshApprovalNonces(workflowDb, evidence, { excludeApprovalEventId });
  const verificationSummary = {
    schema_version: ADAPTIVE_GOAL_APPROVAL_BINDING_VERSION,
    policy_id: policy.policy_id,
    policy_version: policy.policy_version,
    policy_hash: policyResult.policyHash,
    binding: expectedBinding,
    binding_hash: hash(expectedBinding),
    maker_subject: maker.maker_subject,
    maker_attestation_hash: makerResult.signedEnvelopeHash,
    decision_hashes: decisionResults.map(item => item.signedEnvelopeHash).sort(),
    approved_reviewer_subjects: approvals.map(item => item.reviewerSubject).sort(),
    approved_trust_domains: [...usedDomains].sort(),
    required_approval_count: policy.required_approval_count,
    required_distinct_trust_domains: policy.required_distinct_trust_domains,
    required_roles: [...policy.required_roles].sort(),
    policy_high_water_status: policyHighWater.status,
    valid_until: new Date(Math.min(policyResult.expiresAt, makerResult.expiresAt, ...approvals.map(item => Date.parse(item.expiresAt)))).toISOString()
  };
  const bindingRecord = {
    schema_version: ADAPTIVE_GOAL_APPROVAL_BINDING_VERSION,
    binding: expectedBinding,
    binding_hash: hash(expectedBinding),
    policy_id: policy.policy_id,
    policy_version: policy.policy_version,
    policy_hash: policyResult.policyHash,
    maker_subject: maker.maker_subject,
    maker_attestation_hash: makerResult.signedEnvelopeHash,
    decision_hashes: verificationSummary.decision_hashes,
    approved_reviewer_subjects: verificationSummary.approved_reviewer_subjects,
    approved_trust_domains: verificationSummary.approved_trust_domains,
    required_approval_count: policy.required_approval_count,
    required_distinct_trust_domains: policy.required_distinct_trust_domains,
    required_roles: verificationSummary.required_roles,
    valid_until: verificationSummary.valid_until,
    signedEvidence: evidence
  };
  bindingRecord.binding_record_hash = hash(bindingRecord);
  return { verified: true, approvalBinding: bindingRecord, summary: verificationSummary };
}

/** Explicit administrator observation; unlike verification, this is allowed to
 * append the trust configuration high-water records. Never called by approval,
 * preflight, or dispatch automatically. */
export function getAdaptiveGoalApprovalSubsystemConfigurationStatus({ trustConfigurationDb, verifierConfiguration,
  reviewerConfiguration, now = Date.now(), environment = process.env } = {}) {
  const domains = {};
  const blockers = [];
  const configs = [];
  for (const spec of KEY_CONFIGS) {
    try {
      const configuration = readTrustConfig(spec, now, environment);
      const history = assertTrustConfigObserved(trustConfigurationDb, configuration, now, { record: true });
      const status = adaptiveGoalTrustConfigurationStatus(configuration);
      domains[spec.id] = { ...status, antiRollback: history };
      configs.push(configuration);
    } catch (error) {
      domains[spec.id] = { available: false, domain: spec.domain, scope: spec.scope,
        blockers: [{ code: error?.code || 'AGG_APPROVAL_TRUST_CONFIG_UNAVAILABLE', message: String(error?.message || error) }] };
      blockers.push({ domain: spec.domain, code: error?.code || 'AGG_APPROVAL_TRUST_CONFIG_UNAVAILABLE', message: String(error?.message || error) });
    }
  }
  if (configs.length === KEY_CONFIGS.length) {
    try {
      const source = verifierConfiguration || loadAdaptiveGoalTrustConfiguration({
        configJsonEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON', providerEnv: 'AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID',
        publicKeyEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM', domain: 'goal_idea_verifier',
        scope: 'agg.goal_idea_graph.verify', now, environment
      });
      const reviewer = reviewerConfiguration || loadAdaptiveGoalTrustConfiguration({
        configJsonEnv: 'AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON', providerEnv: 'AGG_REVIEW_IDENTITY_PROVIDER_ID',
        publicKeyEnv: 'AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM', domain: 'action_intent_reviewer',
        scope: 'agg.action_intent.review', now, environment
      });
      assertAllTrustDomainsDisjoint(source, reviewer, configs);
    } catch (error) { blockers.push({ code: error?.code || 'AGG_APPROVAL_TRUST_DOMAIN_UNVERIFIABLE', message: String(error?.message || error) }); }
  }
  return {
    status: blockers.length ? 'blocked' : 'configured',
    schema_version: ADAPTIVE_GOAL_APPROVAL_SUBSYSTEM_SCHEMA_VERSION,
    configurationBoundary: 'separate_host_managed_policy_maker_and_execution_approval_trust_domains',
    domains,
    separation: { providerIdsDistinct: blockers.every(item => item.code !== 'AGG_APPROVAL_TRUST_DOMAINS_PROVIDER_COLLISION'),
      publicRootsDisjoint: blockers.every(item => item.code !== 'AGG_APPROVAL_TRUST_DOMAINS_ROOT_COLLISION') },
    blockers
  };
}
