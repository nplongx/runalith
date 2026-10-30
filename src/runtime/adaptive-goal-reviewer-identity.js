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
 * trust root and the exact current candidate. The provider MUST authenticate
 * the human and authorize ADAPTIVE_GOAL_REVIEWER_AUTHORIZATION_SCOPE before
 * issuing the signature; runtime ingestion only transports and verifies that
 * externally issued assertion and does not authenticate a human by itself.
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

/**
 * Persist a provider-signed reviewer assertion through a single runtime-owned
 * ingestion boundary. The caller supplies a loader, not a candidate snapshot:
 * it is re-run while the workflow database writer lock is held both before and
 * after persistence, so the attestation cannot be attached to a stale review
 * candidate. This function never creates a signature or grants workflow
 * approval/dispatch authority; the trusted provider remains responsible for
 * authenticating the human and authorizing ADAPTIVE_GOAL_REVIEWER_AUTHORIZATION_SCOPE.
 */
export function ingestAdaptiveGoalReviewerAttestation(store, jobId, attestationInput, {
  now = Date.now(), trustConfigurationDb = trustConfigurationLedgerDb, loadCurrentCandidate
} = {}) {
  if (!store?.db || typeof store.db.exec !== 'function' || typeof store.db.prepare !== 'function' ||
      store.db.isTransaction === true) {
    fail('AGG_REVIEWER_ATTESTATION_INGEST_DATABASE_UNAVAILABLE',
      'reviewer attestation ingestion requires an available workflow database with no caller-owned transaction');
  }
  if (typeof jobId !== 'string' || !jobId.trim() || typeof loadCurrentCandidate !== 'function') {
    fail('AGG_REVIEWER_ATTESTATION_INGEST_REQUEST_INVALID',
      'reviewer attestation ingestion requires a job ID and a runtime-owned current-candidate loader');
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    fail('AGG_REVIEWER_ATTESTATION_INGEST_CLOCK_INVALID', 'reviewer attestation verification time must be a non-negative safe integer');
  }

  const db = store.db;
  let transactionOpen = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;

    const current = loadCurrentCandidate();
    const candidate = current?.candidate;
    const source = current?.sourceGraphVerification;
    if (!current?.found || current.status !== 'fresh' || !isRecord(candidate) ||
        !SHA256.test(candidate.candidateHash || '') || !SHA256.test(candidate.fingerprint || '') ||
        !SHA256.test(candidate.executionPlan?.plan_hash || '') ||
        !isRecord(source) || !SHA256.test(source.attestationId || '') ||
        !SHA256.test(source.snapshotHash || '') || !SHA256.test(source.evidenceManifestHash || '') ||
        !SHA256.test(source.trustRootSha256 || '') || typeof source.providerId !== 'string' || !source.providerId.trim() ||
        !canonicalTimestamp(source.expiresAt) || Date.parse(source.expiresAt) <= now) {
      fail('AGG_REVIEWER_ATTESTATION_INGEST_CANDIDATE_STALE',
        'ingestion requires a freshly rebuilt candidate bound to a current independently attested Goal/Idea snapshot and evidence manifest');
    }

    const existing = db.prepare(`SELECT event_id,job_id,type,payload_json FROM events
      WHERE job_id=? AND type=? ORDER BY created_at ASC,rowid ASC`).all(jobId, ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT);
    if (existing.length > 1) {
      fail('AGG_REVIEWER_ATTESTATION_INGEST_AMBIGUOUS',
        'multiple reviewer attestation records already exist; ingestion will not repair or select among them');
    }
    if (existing.length === 1) {
      let prior;
      try { prior = JSON.parse(existing[0].payload_json); }
      catch { fail('AGG_REVIEWER_ATTESTATION_INGEST_EXISTING_MALFORMED', 'existing reviewer attestation is malformed'); }
      if (!isRecord(attestationInput) || canonicalJson(prior) !== canonicalJson(attestationInput)) {
        fail('AGG_REVIEWER_ATTESTATION_INGEST_CONFLICT',
          'a different reviewer attestation is already bound to this candidate; replacement and implicit reapproval are denied');
      }
      const verified = assertAdaptiveGoalReviewerAttestation(store, jobId, candidate, { now, trustConfigurationDb });
      const readback = loadCurrentCandidate();
      if (readback?.status !== 'fresh' || readback.reviewerIdentityVerified !== true ||
          readback.candidateHash !== candidate.candidateHash ||
          readback.reviewerAttestation?.attestationEventId !== verified.attestationEventId) {
        fail('AGG_REVIEWER_ATTESTATION_INGEST_READBACK_MISMATCH',
          'existing reviewer attestation did not reproduce the same current candidate on readback');
      }
      db.exec('COMMIT');
      transactionOpen = false;
      return {
        stored: false, idempotent: true, verified: true, jobId,
        candidateHash: candidate.candidateHash, immutablePlanHash: candidate.executionPlan.plan_hash,
        attestationEventId: verified.attestationEventId,
        approvalGranted: false, dispatchStarted: false, executionAuthorized: false
      };
    }

    // A new reviewer identity assertion must arrive before the wrapper has
    // crossed its ordinary approval/plan/task lifecycle. Existing approvals
    // cannot be retroactively made valid by attaching a later signature.
    if (current.wrapperState !== 'IDLE' || current.wrapperApproved === true ||
        current.immutablePlanPinned === true || current.taskRowsCreated === true ||
        current.dispatchStarted === true || current.approvalCount !== 0) {
      fail('AGG_REVIEWER_ATTESTATION_INGEST_LIFECYCLE_ADVANCED',
        'a new reviewer assertion may only be attached to an unapproved, unpinned, undispatched review candidate');
    }
    if (!isRecord(attestationInput)) {
      fail('AGG_REVIEWER_ATTESTATION_INGEST_SHAPE_INVALID', 'attestation must be a provider-signed JSON object');
    }
    let serialized;
    let normalized;
    try {
      serialized = JSON.stringify(attestationInput);
      normalized = JSON.parse(serialized);
    } catch (error) {
      fail('AGG_REVIEWER_ATTESTATION_INGEST_SHAPE_INVALID', `attestation is not inert JSON data: ${String(error?.message || error)}`);
    }
    if (!isRecord(normalized) || typeof normalized.nonce !== 'string' || !UUID.test(normalized.nonce)) {
      fail('AGG_REVIEWER_ATTESTATION_INGEST_SHAPE_INVALID', 'attestation must include a canonical UUID nonce');
    }
    const nonceUses = db.prepare(`SELECT COUNT(*) AS count FROM events
      WHERE type=? AND json_extract(payload_json,'$.nonce')=?`)
      .get(ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT, normalized.nonce).count;
    if (nonceUses !== 0) {
      fail('AGG_REVIEWER_ATTESTATION_INGEST_REPLAY', 'reviewer attestation nonce already exists in durable reviewer records');
    }

    const eventId = sha256(`${jobId}|${ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT}|${candidate.fingerprint}`);
    db.prepare(`INSERT INTO events(event_id,job_id,type,payload_json,created_at) VALUES(?,?,?,?,?)`)
      .run(eventId, jobId, ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT, serialized, new Date(now).toISOString());

    // Reuse the same verifier used by the approval and dispatcher boundaries.
    // Any schema, signature, scope, freshness, trust-root, candidate or nonce
    // failure throws and rolls this uncommitted event back.
    const verified = assertAdaptiveGoalReviewerAttestation(store, jobId, candidate, { now, trustConfigurationDb });
    const readback = loadCurrentCandidate();
    if (readback?.status !== 'fresh' || readback.reviewerIdentityVerified !== true ||
        readback.candidateHash !== candidate.candidateHash ||
        readback.reviewerAttestation?.attestationEventId !== verified.attestationEventId ||
        readback.executionReviewReady !== true ||
        readback.sourceGraphVerification?.snapshotHash !== source.snapshotHash) {
      fail('AGG_REVIEWER_ATTESTATION_INGEST_READBACK_MISMATCH',
        'persisted reviewer evidence did not reproduce the exact current candidate, source snapshot, and review-readiness contract');
    }
    const persisted = db.prepare(`SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?`)
      .get(eventId);
    if (!persisted || persisted.job_id !== jobId || persisted.type !== ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT ||
        persisted.payload_json !== JSON.stringify(normalized)) {
      fail('AGG_REVIEWER_ATTESTATION_INGEST_PERSISTENCE_MISMATCH', 'durable reviewer attestation failed exact canonical persistence readback');
    }
    db.exec('COMMIT');
    transactionOpen = false;
    return {
      stored: true, idempotent: false, verified: true, jobId,
      candidateHash: candidate.candidateHash, immutablePlanHash: candidate.executionPlan.plan_hash,
      attestationEventId: verified.attestationEventId,
      approvalGranted: false, dispatchStarted: false, executionAuthorized: false
    };
  } catch (error) {
    if (transactionOpen) {
      try { db.exec('ROLLBACK'); } catch {}
    }
    throw error;
  }
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
