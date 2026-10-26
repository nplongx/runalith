import { createHash, verify as verifySignature } from 'node:crypto';
import { canonicalJson } from './workflow/plan.js';
import { adaptiveGoalTrustConfigurationStatus, assertAdaptiveGoalTrustDomainsDisjoint, findAdaptiveGoalTrustedRoot,
  assertAndRecordAdaptiveGoalTrustConfiguration, inspectAdaptiveGoalTrustConfigurationHistory,
  initializeAdaptiveGoalTrustConfigurationLedger, isAdaptiveGoalTrustConfigurationProvided,
  loadAdaptiveGoalTrustConfiguration } from './adaptive-goal-trust-configuration.js';

export const ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT = 'adaptive_goal.action_intent_review_authorized';
export const ADAPTIVE_GOAL_REVIEWER_ATTESTATION_SCHEMA_VERSION = 1;
export const ADAPTIVE_GOAL_REVIEWER_AUTHORIZATION_SCOPE = 'agg.action_intent.review';
export const ADAPTIVE_GOAL_REVIEWER_IDENTITY_BLOCKER = Object.freeze({
  code: 'AGG_ACTION_INTENT_REVIEWER_IDENTITY_UNVERIFIED',
  message: 'No valid trust-root-verified reviewer attestation is available for this exact AGG candidate. Caller-supplied reviewerId, timestamps, acknowledgements and hashes are not identity proof; execution remains fail-closed.'
});
export const ADAPTIVE_GOAL_REVIEWER_TRUST_CONFIG_ENV = 'AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON';

const SHA256 = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXPECTED_KEYS = 'candidate,decision,expires_at,issued_at,kind,nonce,provider_id,reviewer_subject,schema_version,scope,signature,signature_algorithm,trust_root_sha256';
const EXPECTED_CANDIDATE_KEYS = 'candidate_fingerprint,candidate_hash,candidate_id,immutable_plan_hash,reviewed_action_intent_hash,reviewed_task_input_contract_hash,role_contract_hash,semantic_policy_version,semantic_verification_hash,wrapper_job_id';
let trustConfigurationLedgerDb = null;

export function configureAdaptiveGoalTrustConfigurationLedger(db) {
  initializeAdaptiveGoalTrustConfigurationLedger(db);
  trustConfigurationLedgerDb = db;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(message, code = ADAPTIVE_GOAL_REVIEWER_IDENTITY_BLOCKER.code) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function signaturePayload(attestation) {
  const { signature: _signature, ...unsigned } = attestation;
  return canonicalJson(unsigned);
}

export function expectedAdaptiveGoalReviewerAttestationCandidate(jobId, candidate) {
  const reviewedInputs = candidate?.reviewedTaskInputs;
  const hashes = candidate?.hashes;
  const planHash = candidate?.executionPlan?.plan_hash;
  if (!isRecord(candidate) || !isRecord(reviewedInputs) || !isRecord(hashes) ||
      !SHA256.test(candidate.candidateHash || '') || !SHA256.test(candidate.fingerprint || '') ||
      !SHA256.test(planHash || '') || !SHA256.test(hashes.reviewedActionIntentHash || '') ||
      !SHA256.test(hashes.reviewedTaskInputContractHash || '') || !SHA256.test(hashes.roleContractHash || '') ||
      !SHA256.test(hashes.semanticVerificationHash || '') || hashes.semanticPolicyVersion !== 1) {
    fail('candidate lacks a valid versioned semantic/plan fingerprint required for reviewer attestation');
  }
  return {
    wrapper_job_id: jobId,
    candidate_id: candidate.candidateId,
    candidate_fingerprint: candidate.fingerprint,
    candidate_hash: candidate.candidateHash,
    immutable_plan_hash: planHash,
    reviewed_action_intent_hash: hashes.reviewedActionIntentHash,
    reviewed_task_input_contract_hash: hashes.reviewedTaskInputContractHash,
    semantic_policy_version: hashes.semanticPolicyVersion,
    semantic_verification_hash: hashes.semanticVerificationHash,
    role_contract_hash: hashes.roleContractHash
  };
}

/**
 * Verify the provider-signed reviewer decision against a configured public
 * trust root and the exact current candidate. This function only reads a
 * durable, private adapter event; no MCP tool accepts a caller-supplied proof
 * or writes this event. The provider MUST authenticate the human and authorize
 * AGG_ACTION_INTENT_REVIEWER_AUTHORIZATION_SCOPE before issuing the signature.
 */
export function assertAdaptiveGoalReviewerAttestation(store, jobId, candidate, { now = Date.now(), trustConfigurationDb = trustConfigurationLedgerDb } = {}) {
  if (!trustConfigurationDb || trustConfigurationDb === store?.db || typeof trustConfigurationDb.exec !== 'function' ||
      typeof trustConfigurationDb.prepare !== 'function' || trustConfigurationDb.isTransaction === true) {
    fail('reviewer trust anti-rollback requires a configured, dedicated trust-ledger connection distinct from the workflow database',
      'AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE');
  }
  let trustConfiguration;
  try {
    trustConfiguration = loadAdaptiveGoalTrustConfiguration({
      configJsonEnv: ADAPTIVE_GOAL_REVIEWER_TRUST_CONFIG_ENV,
      providerEnv: 'AGG_REVIEW_IDENTITY_PROVIDER_ID',
      publicKeyEnv: 'AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM',
      domain: 'action_intent_reviewer', scope: ADAPTIVE_GOAL_REVIEWER_AUTHORIZATION_SCOPE, now
    });
    if (isAdaptiveGoalTrustConfigurationProvided({
      configJsonEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON', providerEnv: 'AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID',
      publicKeyEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM'
    })) {
      const sourceConfiguration = loadAdaptiveGoalTrustConfiguration({
        configJsonEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON',
        providerEnv: 'AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID',
        publicKeyEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM',
        domain: 'goal_idea_verifier', scope: 'agg.goal_idea_graph.verify', now
      });
      assertAdaptiveGoalTrustDomainsDisjoint(sourceConfiguration, trustConfiguration);
    }
  } catch (error) {
    fail(`trusted AGG reviewer identity provider or trust root is not configured or valid: ${String(error?.message || error)}`);
  }
  try { assertAndRecordAdaptiveGoalTrustConfiguration(trustConfigurationDb, trustConfiguration, { now }); }
  catch (error) { fail(`reviewer trust configuration anti-rollback check failed: ${String(error?.message || error)}`); }
  const configuredProvider = trustConfiguration.providerId;
  const expectedCandidate = expectedAdaptiveGoalReviewerAttestationCandidate(jobId, candidate);
  const rows = store.db.prepare(`SELECT event_id,job_id,type,payload_json FROM events
    WHERE job_id=? AND type=? ORDER BY created_at ASC,rowid ASC`)
    .all(jobId, ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT);
  if (rows.length !== 1) fail(rows.length ? 'multiple reviewer attestation events exist for the same candidate; replay/ambiguity is denied' : 'no provider-verified reviewer attestation exists for the exact candidate');
  const row = rows[0];
  let attestation;
  try { attestation = JSON.parse(row.payload_json); }
  catch { fail('persisted reviewer attestation is not valid JSON'); }
  if (!isRecord(attestation) || Object.keys(attestation).sort().join(',') !== EXPECTED_KEYS) {
    fail('reviewer attestation has an unsupported schema or unknown fields');
  }
  if (row.job_id !== jobId || row.type !== ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT ||
      row.payload_json !== JSON.stringify(attestation) || row.event_id !== sha256(`${jobId}|${ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT}|${expectedCandidate.candidate_fingerprint}`)) {
    fail('reviewer attestation event ID/job binding or canonical stored bytes are invalid');
  }
  if (attestation.schema_version !== ADAPTIVE_GOAL_REVIEWER_ATTESTATION_SCHEMA_VERSION ||
      attestation.kind !== 'adaptive_goal_verified_reviewer_attestation' ||
      attestation.provider_id !== configuredProvider || !SHA256.test(attestation.trust_root_sha256 || '') ||
      attestation.scope !== ADAPTIVE_GOAL_REVIEWER_AUTHORIZATION_SCOPE ||
      attestation.decision !== 'reviewed_for_candidate_only' ||
      attestation.signature_algorithm !== 'Ed25519' || !BASE64.test(attestation.signature || '') ||
      !UUID.test(attestation.nonce || '') || typeof attestation.reviewer_subject !== 'string' || !attestation.reviewer_subject.trim()) {
    fail('reviewer attestation has an invalid provider, trust root, decision, authorization scope, signature format or nonce');
  }
  if (!isRecord(attestation.candidate) || Object.keys(attestation.candidate).sort().join(',') !== EXPECTED_CANDIDATE_KEYS ||
      canonicalJson(attestation.candidate) !== canonicalJson(expectedCandidate)) {
    fail('reviewer attestation does not bind the exact candidate, intent, role contract, semantic policy or immutable plan');
  }
  if (attestation.reviewer_subject !== candidate.reviewedTaskInputs?.review?.reviewerId) {
    fail('provider-authenticated reviewer subject does not match the reviewer named in the reviewed envelope');
  }
  if (!canonicalTimestamp(attestation.issued_at) || !canonicalTimestamp(attestation.expires_at)) {
    fail('reviewer attestation issued/expiry timestamps are not canonical UTC ISO-8601');
  }
  const issuedAt = Date.parse(attestation.issued_at);
  const expiresAt = Date.parse(attestation.expires_at);
  if (issuedAt > now + 60_000 || expiresAt <= now || expiresAt <= issuedAt || expiresAt - issuedAt > 10 * 60_000) {
    fail('reviewer attestation is stale, expired, future-dated or exceeds the 10-minute freshness window');
  }
  let trustedRoot;
  try { trustedRoot = findAdaptiveGoalTrustedRoot(trustConfiguration, attestation.trust_root_sha256, { issuedAt, now }); }
  catch (error) { fail(`reviewer public trust root validation failed: ${String(error?.message || error)}`); }
  const nonceUses = store.db.prepare(`SELECT COUNT(*) AS count FROM events
    WHERE type=? AND json_extract(payload_json,'$.nonce')=?`)
    .get(ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT, attestation.nonce).count;
  if (nonceUses !== 1) fail('reviewer attestation nonce has been replayed or appears in multiple durable records');
  let signature;
  try { signature = Buffer.from(attestation.signature, 'base64'); }
  catch { fail('reviewer attestation signature is malformed'); }
  if (signature.toString('base64') !== attestation.signature ||
      !verifySignature(null, Buffer.from(signaturePayload(attestation), 'utf8'), trustedRoot.publicKey, signature)) {
    fail('reviewer attestation signature does not verify under the configured trust root');
  }
  return Object.freeze({
    verified: true,
    providerId: configuredProvider,
    trustRootSha256: trustedRoot.trustRootSha256,
    trustKeyId: trustedRoot.keyId,
    configurationFingerprint: trustConfiguration.configurationFingerprint,
    trustConfigVersion: trustConfiguration.configVersion,
    configurationSource: trustConfiguration.configurationSource,
    configurationChangeReference: trustConfiguration.configChangeReference,
    reviewerSubject: attestation.reviewer_subject,
    authorizationScope: attestation.scope,
    decision: attestation.decision,
    nonce: attestation.nonce,
    issuedAt: attestation.issued_at,
    expiresAt: attestation.expires_at,
    attestationEventId: row.event_id,
    candidateFingerprint: expectedCandidate.candidate_fingerprint,
    candidateHash: expectedCandidate.candidate_hash,
    immutablePlanHash: expectedCandidate.immutable_plan_hash
  });
}

export function getAdaptiveGoalReviewerConfigurationStatus({ now = Date.now(), trustConfigurationDb = trustConfigurationLedgerDb } = {}) {
  try {
    const configuration = loadAdaptiveGoalTrustConfiguration({
      configJsonEnv: ADAPTIVE_GOAL_REVIEWER_TRUST_CONFIG_ENV,
      providerEnv: 'AGG_REVIEW_IDENTITY_PROVIDER_ID',
      publicKeyEnv: 'AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM',
      domain: 'action_intent_reviewer', scope: ADAPTIVE_GOAL_REVIEWER_AUTHORIZATION_SCOPE, now
    });
    if (isAdaptiveGoalTrustConfigurationProvided({
      configJsonEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON', providerEnv: 'AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID',
      publicKeyEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM'
    })) {
      const sourceConfiguration = loadAdaptiveGoalTrustConfiguration({
        configJsonEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON', providerEnv: 'AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID',
        publicKeyEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM',
        domain: 'goal_idea_verifier', scope: 'agg.goal_idea_graph.verify', now
      });
      assertAdaptiveGoalTrustDomainsDisjoint(sourceConfiguration, configuration);
    }
    const status = adaptiveGoalTrustConfigurationStatus(configuration);
    if (!trustConfigurationDb || typeof trustConfigurationDb.exec !== 'function' ||
        typeof trustConfigurationDb.prepare !== 'function' || trustConfigurationDb.isTransaction === true) {
      return { ...status, available: false, antiRollback: { status: 'unavailable', code: 'AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE' },
        blockers: [...status.blockers, { code: 'AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE',
          message: 'reviewer configuration status requires a configured, dedicated non-transactional trust-ledger connection' }] };
    }
    const antiRollback = inspectAdaptiveGoalTrustConfigurationHistory(trustConfigurationDb, configuration.domain, configuration);
    if (['rollback_detected', 'version_reused', 'time_rollback_detected', 'unavailable'].includes(antiRollback.status)) {
      return { ...status, available: false, antiRollback, blockers: [...status.blockers,
        { code: antiRollback.code || 'AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE', message: `reviewer trust configuration anti-rollback check is ${antiRollback.status}` }] };
    }
    let recorded;
    try { recorded = assertAndRecordAdaptiveGoalTrustConfiguration(trustConfigurationDb, configuration, { now }); }
    catch (error) {
      return { ...status, available: false, antiRollback: { status: 'blocked', code: error?.code || 'AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE' },
        blockers: [...status.blockers, { code: error?.code || 'AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE', message: String(error?.message || error) }] };
    }
    return { ...status, antiRollback: inspectAdaptiveGoalTrustConfigurationHistory(trustConfigurationDb, configuration.domain, configuration),
      audit: { versionRecorded: true, recorded: recorded.recorded, idempotent: recorded.idempotent } };
  } catch (error) {
    return { available: false, providerId: null, configurationFingerprint: null, roots: [],
      blockers: [{ code: error?.code || ADAPTIVE_GOAL_REVIEWER_IDENTITY_BLOCKER.code, message: String(error?.message || error) }] };
  }
}
