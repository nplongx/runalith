import { createHash, verify as verifySignature } from 'node:crypto';
import { adaptiveGoalTrustConfigurationStatus, assertAdaptiveGoalTrustDomainsDisjoint, findAdaptiveGoalTrustedRoot,
  assertAndRecordAdaptiveGoalTrustConfiguration, inspectAdaptiveGoalTrustConfigurationHistory,
  initializeAdaptiveGoalTrustConfigurationLedger, isAdaptiveGoalTrustConfigurationProvided,
  loadAdaptiveGoalTrustConfiguration } from './adaptive-goal-trust-configuration.js';

export const ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_EVENT = 'adaptive_goal.knowledge_graph_attested';
export const ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_SCHEMA_VERSION = 1;
export const ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_SCOPE = 'agg.goal_idea_graph.verify';
export const ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_PROVIDER_ENV = 'AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID';
export const ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_TRUST_ROOT_ENV = 'AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM';
export const ADAPTIVE_GOAL_KNOWLEDGE_TRUST_CONFIG_ENV = 'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON';

const SHA256 = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ATTESTATION_KEYS = [
  'schema_version', 'kind', 'provider_id', 'trust_root_sha256', 'nonce', 'issued_at', 'expires_at', 'scope',
  'goal_id', 'snapshot_hash', 'node_ids', 'edge_ids', 'membership_ids', 'evidence_manifest_hash',
  'claim_status', 'independence_status', 'signature_algorithm', 'signature'
].sort().join(',');
const MAX_ATTESTATION_TTL_MS = 30 * 60 * 1000;
// In-process provenance marker: reports that cross JSON/storage boundaries
// lose this identity and must be re-read/reverified by the host.
const authenticatedVerificationReports = new WeakSet();

function freezeJsonTree(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeJsonTree(child, seen);
  return Object.freeze(value);
}

export function isAuthenticatedAdaptiveGoalKnowledgeVerificationReport(value, { now = Date.now() } = {}) {
  if (!isRecord(value) || !authenticatedVerificationReports.has(value) || value.verified !== true || value.status !== 'verified' ||
      value.claimVerified !== true || value.independenceVerified !== true ||
      typeof value.providerId !== 'string' || !value.providerId.trim() ||
      !SHA256.test(value.attestationId || '') || !SHA256.test(value.trustRootSha256 || '') ||
      !SHA256.test(value.snapshotHash || '') || !SHA256.test(value.evidenceManifestHash || '') ||
      !isRecord(value.snapshot) || value.snapshot.goal_id !== value.goalId || value.snapshot.snapshot_hash !== value.snapshotHash ||
      !Number.isSafeInteger(now)) return false;
  const issued = typeof value.issuedAt === 'string' ? Date.parse(value.issuedAt) : NaN;
  const expires = typeof value.expiresAt === 'string' ? Date.parse(value.expiresAt) : NaN;
  return Number.isFinite(issued) && Number.isFinite(expires) &&
    new Date(issued).toISOString() === value.issuedAt && new Date(expires).toISOString() === value.expiresAt &&
    issued <= now + 60_000 && expires > now && expires > issued && expires - issued <= MAX_ATTESTATION_TTL_MS;
}

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function stableValue(value, { depth = 0, seen = new Set() } = {}) {
  if (depth > 40) throw new TypeError('knowledge verification payload exceeds maximum nesting depth');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('knowledge verification payload contains a non-finite number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') throw new TypeError('knowledge verification payload must contain JSON values only');
  if (seen.has(value)) throw new TypeError('knowledge verification payload contains a cycle or repeated object identity');
  seen.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError('knowledge verification arrays must use the standard array prototype');
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) {
      throw new TypeError('knowledge verification arrays cannot contain symbols or extra properties');
    }
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0 || keys.length !== length.value + 1) {
      throw new TypeError('knowledge verification arrays must be dense canonical arrays');
    }
    const output = new Array(length.value);
    for (let index = 0; index < length.value; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError('knowledge verification arrays must not be sparse');
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        throw new TypeError('knowledge verification arrays must contain enumerable data properties only');
      }
      output[index] = stableValue(descriptor.value, { depth: depth + 1, seen });
    }
    return output;
  }

  const prototype = Object.getPrototypeOf(value);
  if (!isRecord(value) || (prototype !== Object.prototype && prototype !== null)) {
    throw new TypeError('knowledge verification objects must be plain JSON records');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || key === '__proto__')) {
    throw new TypeError('knowledge verification payload contains a forbidden key');
  }
  const output = {};
  for (const key of keys.sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new TypeError('knowledge verification objects must contain enumerable data properties only');
    }
    Object.defineProperty(output, key, {
      value: stableValue(descriptor.value, { depth: depth + 1, seen }),
      enumerable: true, writable: true, configurable: true
    });
  }
  return output;
}

export function canonicalAdaptiveGoalKnowledgeJson(value) { return JSON.stringify(stableValue(value)); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function fail(code, message) { const error = new Error(`${code}: ${message}`); error.code = code; throw error; }
function canonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
function sortedUnique(value, field) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim()) || new Set(value).size !== value.length) {
    fail('KNOWLEDGE_ATTESTATION_SHAPE_INVALID', `${field} must be a unique array of non-empty strings`);
  }
  const sorted = [...value].sort();
  if (canonicalAdaptiveGoalKnowledgeJson(sorted) !== canonicalAdaptiveGoalKnowledgeJson(value)) {
    fail('KNOWLEDGE_ATTESTATION_SHAPE_INVALID', `${field} must use canonical sorted order`);
  }
  return sorted;
}

function configuredVerifier() {
  try {
    const configuration = loadAdaptiveGoalTrustConfiguration({
      configJsonEnv: ADAPTIVE_GOAL_KNOWLEDGE_TRUST_CONFIG_ENV,
      providerEnv: ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_PROVIDER_ENV,
      publicKeyEnv: ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_TRUST_ROOT_ENV,
      domain: 'goal_idea_verifier', scope: ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_SCOPE
    });
    if (isAdaptiveGoalTrustConfigurationProvided({
      configJsonEnv: 'AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON', providerEnv: 'AGG_REVIEW_IDENTITY_PROVIDER_ID',
      publicKeyEnv: 'AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM'
    })) {
      const reviewerConfiguration = loadAdaptiveGoalTrustConfiguration({
        configJsonEnv: 'AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON', providerEnv: 'AGG_REVIEW_IDENTITY_PROVIDER_ID',
        publicKeyEnv: 'AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM',
        domain: 'action_intent_reviewer', scope: 'agg.action_intent.review'
      });
      assertAdaptiveGoalTrustDomainsDisjoint(configuration, reviewerConfiguration);
    }
    return configuration;
  } catch (error) {
    const code = error?.code;
    if (code === 'AGG_TRUST_CONFIG_NOT_CONFIGURED') fail('KNOWLEDGE_VERIFIER_NOT_CONFIGURED', String(error.message).replace(/^AGG_TRUST_CONFIG_NOT_CONFIGURED:\s*/, ''));
    if (code === 'AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID') fail('KNOWLEDGE_TRUST_ROOT_INVALID', String(error.message).replace(/^AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID:\s*/, ''));
    if (code?.startsWith('AGG_TRUST_')) fail('KNOWLEDGE_TRUST_CONFIGURATION_INVALID', String(error.message));
    throw error;
  }
}

function assertAttestationSignatureShape(attestation, configured) {
  if (!isRecord(attestation) || Object.keys(attestation).sort().join(',') !== ATTESTATION_KEYS) {
    fail('KNOWLEDGE_ATTESTATION_SHAPE_INVALID', 'signed Goal/Idea verification attestation has an unsupported schema or unknown fields');
  }
  const exactStrings = [
    ['kind', 'adaptive_goal_verified_knowledge_graph_attestation'],
    ['scope', ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_SCOPE],
    ['claim_status', 'verified'],
    ['independence_status', 'verified'],
    ['signature_algorithm', 'Ed25519']
  ];
  for (const [key, expected] of exactStrings) if (attestation[key] !== expected) {
    fail('KNOWLEDGE_ATTESTATION_SCOPE_INVALID', `${key} must exactly equal ${expected}`);
  }
  if (attestation.schema_version !== ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_SCHEMA_VERSION ||
      attestation.provider_id !== configured.providerId || !SHA256.test(attestation.trust_root_sha256 || '') ||
      typeof attestation.goal_id !== 'string' || !attestation.goal_id.trim() || attestation.goal_id.length > 200 ||
      !SHA256.test(attestation.snapshot_hash || '') || !SHA256.test(attestation.evidence_manifest_hash || '') ||
      !UUID.test(attestation.nonce || '') || !BASE64.test(attestation.signature || '') ||
      !canonicalTimestamp(attestation.issued_at) || !canonicalTimestamp(attestation.expires_at)) {
    fail('KNOWLEDGE_ATTESTATION_BINDING_INVALID', 'attestation provider, trust root, IDs, hashes, nonce or timestamps are malformed or do not match the configured verifier');
  }
  sortedUnique(attestation.node_ids, 'node_ids');
  sortedUnique(attestation.edge_ids, 'edge_ids');
  sortedUnique(attestation.membership_ids, 'membership_ids');
  const issued = Date.parse(attestation.issued_at);
  const expires = Date.parse(attestation.expires_at);
  if (expires <= issued || expires - issued > MAX_ATTESTATION_TTL_MS) {
    fail('KNOWLEDGE_ATTESTATION_FRESHNESS_INVALID', 'attestation lifetime must be positive and no longer than 30 minutes');
  }
  const unsigned = { ...attestation };
  delete unsigned.signature;
  let trustedRoot;
  try { trustedRoot = findAdaptiveGoalTrustedRoot(configured, attestation.trust_root_sha256, { issuedAt: issued }); }
  catch (error) { fail(error?.code || 'KNOWLEDGE_TRUST_ROOT_UNTRUSTED', String(error?.message || error)); }
  let signatureBytes;
  try { signatureBytes = Buffer.from(attestation.signature, 'base64'); }
  catch { fail('KNOWLEDGE_ATTESTATION_SIGNATURE_INVALID', 'attestation signature is malformed'); }
  if (signatureBytes.toString('base64') !== attestation.signature ||
      !verifySignature(null, Buffer.from(canonicalAdaptiveGoalKnowledgeJson(unsigned), 'utf8'), trustedRoot.publicKey, signatureBytes)) {
    fail('KNOWLEDGE_ATTESTATION_SIGNATURE_INVALID', 'Goal/Idea verification signature does not verify against the configured trust root');
  }
  return trustedRoot;
}

function attestationId(attestation) {
  return sha256(`${attestation.goal_id}|${attestation.snapshot_hash}|${attestation.provider_id}|${attestation.nonce}|${attestation.evidence_manifest_hash}`);
}

function normalizeEvidenceManifest(snapshot, resolveEvidenceRecords, resolveSourceRecords) {
  const refs = snapshot.evidence_refs;
  if (!Array.isArray(refs) || refs.some(ref => typeof ref !== 'string' || !ref.trim()) || new Set(refs).size !== refs.length) {
    fail('KNOWLEDGE_EVIDENCE_REFERENCE_INVALID', 'persisted graph has malformed, duplicate or absent evidence references');
  }
  // An empty graph evidence manifest is useful to diagnose, but it is never
  // sufficient material for an independent claim/independence attestation.
  // Preserve the snapshot and a deterministic empty-manifest hash for read-only
  // reconciliation while carrying an explicit non-authorizing eligibility gate.
  const eligibilityBlockers = refs.length === 0 ? [{
    code: 'KNOWLEDGE_EVIDENCE_MANIFEST_EMPTY',
    message: 'Goal/Idea Graph has no durable evidence references; obtain current producer-bound artifact:// evidence before requesting an attestation'
  }] : [];
  const artifactRefs = refs.filter(ref => ref.startsWith('artifact://'));
  const sourceRefs = refs.filter(ref => ref.startsWith('file:'));
  const unsupported = refs.filter(ref => !ref.startsWith('artifact://') && !ref.startsWith('file:'));
  if (unsupported.length) fail('KNOWLEDGE_EVIDENCE_REFERENCE_UNSUPPORTED', `all Goal/Idea evidence must be a durable artifact:// reference or content-addressed file: reference; unsupported refs: ${unsupported.join(', ')}`);

  const evidenceNodes = snapshot.nodes.filter(node => node.type === 'evidence');
  const actionNodes = snapshot.nodes.filter(node => node.type === 'experiment');
  for (const node of actionNodes) {
    if (!node.evidence_refs?.some(ref => ref.startsWith('artifact://'))) {
      fail('KNOWLEDGE_ACTION_EVIDENCE_MISSING', `action/experiment node ${node.id} has no durable artifact:// evidence reference`);
    }
  }
  for (const node of evidenceNodes) {
    if (!node.evidence_refs?.some(ref => ref.startsWith('artifact://') || ref.startsWith('file:'))) {
      fail('KNOWLEDGE_EVIDENCE_NODE_EMPTY', `evidence node ${node.id} has no resolvable source evidence`);
    }
  }

  const artifactRecords = artifactRefs.length ? resolveEvidenceRecords({ steps: [{ supportingEvidenceRefs: artifactRefs }] }) : [];
  const sourceRecords = sourceRefs.length ? resolveSourceRecords(sourceRefs) : [];
  const byArtifactRef = new Map();
  for (const record of artifactRecords) {
    if (!record || typeof record.ref !== 'string' || byArtifactRef.has(record.ref)) {
      fail('KNOWLEDGE_ARTIFACT_EVIDENCE_AMBIGUOUS', 'durable artifact evidence resolver returned missing or duplicate identities');
    }
    const valid = record.status === 'active' && record.lineageValid === true && record.producerContractValid === true &&
      record.producerTaskCompleted === true && record.producerTaskStatus === 'completed' &&
      record.producerResultOutcome === 'success' && record.producerResultLineageValid === true &&
      typeof record.producerTaskId === 'string' && typeof record.producerResultId === 'string' &&
      typeof record.producerCompletionEventId === 'string' && typeof record.artifactCreatedEventId === 'string' &&
      SHA256.test(record.contentHash || '') && Number.isSafeInteger(record.schemaVersion) && record.schemaVersion >= 1;
    byArtifactRef.set(record.ref, {
      reference: record.ref, classification: valid ? 'durable_artifact_lineage_verified_claim_unverified' : 'durable_artifact_lineage_invalid',
      valid, sourceJobId: record.sourceJobId, artifactId: record.artifactId, type: record.type, schemaVersion: record.schemaVersion,
      contentHash: record.contentHash, artifactCreatedEventId: record.artifactCreatedEventId,
      producerRole: record.producerRole, producerTaskId: record.producerTaskId, producerTaskStatus: record.producerTaskStatus,
      producerResultId: record.producerResultId, producerResultOutcome: record.producerResultOutcome,
      producerCompletionEventId: record.producerCompletionEventId, producerCompletionEventType: record.producerCompletionEventType,
      blockers: valid ? [] : [{ code: 'KNOWLEDGE_ARTIFACT_LINEAGE_INVALID', message: record.producerResultLineageFailureReason || 'artifact content/schema/producer/result/attempt/completion lineage is not current and valid' }]
    });
  }
  const bySourceRef = new Map();
  for (const record of sourceRecords) {
    if (!record || typeof record.reference !== 'string' || bySourceRef.has(record.reference)) {
      fail('KNOWLEDGE_SOURCE_EVIDENCE_AMBIGUOUS', 'source evidence resolver returned missing or duplicate identities');
    }
    const valid = record.classification === 'source_bytes_verified_claim_unverified' && record.integrityVerified === true &&
      record.claimVerified === false && record.independenceVerified === false && SHA256.test(record.expectedSha256 || '') &&
      record.expectedSha256 === record.observedSha256;
    bySourceRef.set(record.reference, {
      reference: record.reference, classification: valid ? 'source_bytes_verified_claim_unverified' : record.classification,
      valid, expectedSha256: record.expectedSha256 || null, observedSha256: record.observedSha256 || null,
      sizeBytes: record.sizeBytes ?? null,
      blockers: valid ? [] : [{ code: 'KNOWLEDGE_SOURCE_BYTES_INVALID', message: 'source file is missing, out of scope, changed, or does not match its pinned digest' }]
    });
  }
  const manifest = refs.map(ref => ref.startsWith('artifact://') ? byArtifactRef.get(ref) : bySourceRef.get(ref));
  const missing = manifest.filter(item => !item);
  const invalid = manifest.filter(item => item && item.valid !== true);
  if (missing.length) fail('KNOWLEDGE_EVIDENCE_REFERENCE_UNRESOLVED', `persisted evidence references did not resolve exactly once: ${refs.filter(ref => !(ref.startsWith('artifact://') ? byArtifactRef : bySourceRef).has(ref)).join(', ')}`);
  if (invalid.length) fail('KNOWLEDGE_EVIDENCE_LINEAGE_INVALID', invalid.map(item => `${item.reference}: ${item.blockers.map(b => b.code).join(',')}`).join('; '));
  const normalized = manifest.sort((a, b) => a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0);
  const canonical = canonicalAdaptiveGoalKnowledgeJson(normalized);
  return {
    records: normalized, hash: sha256(canonical), artifacts: artifactRecords, sources: sourceRecords,
    canonical_json: canonical, eligibleForAttestation: eligibilityBlockers.length === 0,
    blockers: eligibilityBlockers
  };
}

function failedEvidenceManifestAssessment(error) {
  const code = typeof error?.code === 'string' && error.code.trim()
    ? error.code : 'KNOWLEDGE_EVIDENCE_MANIFEST_INVALID';
  return {
    records: [],
    hash: sha256(canonicalAdaptiveGoalKnowledgeJson([])),
    artifacts: [],
    sources: [],
    canonical_json: '[]',
    eligibleForAttestation: false,
    blockers: [{ code, message: String(error?.message || error || 'evidence manifest could not be resolved') }]
  };
}

/**
 * Provides a fail-closed Ed25519 attestation verifier over the durable, current
 * Goal/Idea snapshot. The private signing key is never accepted by this module
 * or exposed through MCP; an independently trusted verifier signs externally.
 */
export function createAdaptiveGoalKnowledgeVerifier({ store, resolveEvidenceRecords, resolveSourceRecords, now = () => Date.now(), trustConfigurationDb }) {
  if (!store || typeof store.snapshotForGoal !== 'function' || !store.db || typeof resolveEvidenceRecords !== 'function' || typeof resolveSourceRecords !== 'function') {
    throw new TypeError('createAdaptiveGoalKnowledgeVerifier requires the durable store and independent artifact/source resolvers');
  }
  if (!trustConfigurationDb || trustConfigurationDb === store.db || typeof trustConfigurationDb.exec !== 'function' ||
      typeof trustConfigurationDb.prepare !== 'function') {
    fail('AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE', 'createAdaptiveGoalKnowledgeVerifier requires an explicit trust-ledger connection distinct from the Goal/Idea workflow database');
  }
  initializeAdaptiveGoalTrustConfigurationLedger(trustConfigurationDb);

  function currentSnapshot(goalId) {
    const snapshot = store.snapshotForGoal(goalId);
    if (!snapshot.integrity_valid) {
      fail('KNOWLEDGE_SNAPSHOT_INTEGRITY_INVALID', `persisted Goal/Idea snapshot has integrity blockers: ${snapshot.integrity_issues.map(item => item.code).join(', ')}`);
    }
    if (!snapshot.nodes.length) fail('KNOWLEDGE_GRAPH_EMPTY', `Goal/Idea Graph ${goalId} has no persisted nodes to verify`);
    if (!snapshot.memberships.length || snapshot.memberships.some(item => item.goal_id === goalId && !item.provenance)) {
      fail('KNOWLEDGE_MEMBERSHIP_PROVENANCE_MISSING', 'each graph membership must have explicit immutable provenance');
    }
    return snapshot;
  }

  function expectedSignedBody(attestation, snapshot, evidenceManifest) {
    const expected = {
      schema_version: ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_SCHEMA_VERSION,
      kind: 'adaptive_goal_verified_knowledge_graph_attestation',
      provider_id: attestation.provider_id,
      trust_root_sha256: attestation.trust_root_sha256,
      nonce: attestation.nonce,
      issued_at: attestation.issued_at,
      expires_at: attestation.expires_at,
      scope: ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_SCOPE,
      goal_id: snapshot.goal_id,
      snapshot_hash: snapshot.snapshot_hash,
      node_ids: snapshot.node_ids,
      edge_ids: snapshot.edge_ids,
      membership_ids: snapshot.membership_ids,
      evidence_manifest_hash: evidenceManifest.hash,
      claim_status: 'verified',
      independence_status: 'verified',
      signature_algorithm: 'Ed25519'
    };
    const actual = { ...attestation };
    delete actual.signature;
    if (canonicalAdaptiveGoalKnowledgeJson(actual) !== canonicalAdaptiveGoalKnowledgeJson(expected)) {
      fail('KNOWLEDGE_ATTESTATION_SNAPSHOT_MISMATCH', 'signature payload does not bind the exact current node revisions, edges, membership provenance, snapshot hash and resolved evidence manifest');
    }
    return expected;
  }

  function validateForCurrentSnapshot(attestation, snapshot, configured, evidenceManifest, { checkFreshness = true } = {}) {
    const trustedRoot = assertAttestationSignatureShape(attestation, configured);
    if (attestation.goal_id !== snapshot.goal_id || attestation.snapshot_hash !== snapshot.snapshot_hash) {
      fail('KNOWLEDGE_ATTESTATION_STALE', 'signed attestation refers to a different Goal/Idea graph snapshot');
    }
    expectedSignedBody(attestation, snapshot, evidenceManifest);
    if (checkFreshness) {
      const currentTime = now();
      const issued = Date.parse(attestation.issued_at);
      const expires = Date.parse(attestation.expires_at);
      if (issued > currentTime + 60_000 || expires <= currentTime) {
        fail('KNOWLEDGE_ATTESTATION_EXPIRED', 'Goal/Idea graph attestation is expired or future-dated; obtain a fresh attestation for the exact current snapshot');
      }
    }
    return trustedRoot;
  }

  function readPersistedAttestation(snapshot, configured) {
    const rows = store.db.prepare(`SELECT attestation_id,goal_id,snapshot_hash,provider_id,nonce,payload_json,created_at,
      configuration_fingerprint,trust_key_id,trust_config_version,configuration_source,config_change_reference
      FROM adaptive_goal_knowledge_verifications WHERE goal_id=? AND snapshot_hash=? ORDER BY created_at DESC,rowid DESC`)
      .all(snapshot.goal_id, snapshot.snapshot_hash);
    if (!rows.length) {
      const previous = store.db.prepare(`SELECT attestation_id,snapshot_hash,provider_id,created_at FROM adaptive_goal_knowledge_verifications
        WHERE goal_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(snapshot.goal_id);
      if (previous) return { verified: false, status: 'stale', previousAttestationId: previous.attestation_id,
        previousSnapshotHash: previous.snapshot_hash, blockers: [{ code: 'KNOWLEDGE_ATTESTATION_STALE',
          message: 'the latest durable verifier attestation is bound to a different Goal/Idea snapshot; obtain a new signature over the current graph and evidence manifest' }] };
      return { verified: false, status: 'unattested', blockers: [{ code: 'KNOWLEDGE_SNAPSHOT_NOT_ATTESTED', message: 'no trusted verifier signature exists for the exact current Goal/Idea snapshot' }] };
    }
    // An expired/stale attestation is retained for audit. A newly signed,
    // current attestation for the same immutable graph snapshot may supersede
    // it; only the newest durable record can authorize the current read.
    const row = rows[0];
    let attestation;
    try { attestation = JSON.parse(row.payload_json); }
    catch { return { verified: false, status: 'invalid', blockers: [{ code: 'KNOWLEDGE_ATTESTATION_JSON_INVALID', message: 'stored attestation payload is malformed' }] }; }
    try {
      if (row.attestation_id !== attestationId(attestation) || row.goal_id !== snapshot.goal_id || row.snapshot_hash !== snapshot.snapshot_hash ||
          row.provider_id !== configured.providerId || row.nonce !== attestation.nonce || row.payload_json !== canonicalAdaptiveGoalKnowledgeJson(attestation)) {
        fail('KNOWLEDGE_ATTESTATION_DURABLE_IDENTITY_MISMATCH', 'stored verifier record does not round-trip to its canonical signed payload');
      }
      const evidenceManifest = normalizeEvidenceManifest(snapshot, resolveEvidenceRecords, resolveSourceRecords);
      if (!evidenceManifest.eligibleForAttestation) {
        fail(evidenceManifest.blockers[0]?.code || 'KNOWLEDGE_EVIDENCE_MANIFEST_INVALID',
          evidenceManifest.blockers.map(item => item.message).join('; '));
      }
      const trustedRoot = validateForCurrentSnapshot(attestation, snapshot, configured, evidenceManifest);
      const nonceCount = store.db.prepare('SELECT COUNT(*) AS n FROM adaptive_goal_knowledge_verifications WHERE nonce=?').get(attestation.nonce).n;
      if (nonceCount !== 1) fail('KNOWLEDGE_ATTESTATION_NONCE_REPLAY', 'knowledge verifier nonce appears in multiple durable attestation rows');
      return {
        verified: true, status: 'verified', providerId: configured.providerId, trustRootSha256: trustedRoot.trustRootSha256,
        trustKeyId: row.trust_key_id || trustedRoot.keyId,
        attestationConfigurationFingerprint: row.configuration_fingerprint || null,
        currentConfigurationFingerprint: configured.configurationFingerprint,
        trustConfigVersion: row.trust_config_version ?? null,
        configurationSource: row.configuration_source || null,
        configurationChangeReference: row.config_change_reference || null,
        goalId: snapshot.goal_id, snapshotHash: snapshot.snapshot_hash, attestationId: row.attestation_id,
        nonce: row.nonce, issuedAt: attestation.issued_at, expiresAt: attestation.expires_at,
        evidenceManifestHash: evidenceManifest.hash, evidenceRecordCount: evidenceManifest.records.length,
        verifiedNodeCount: snapshot.nodes.length, verifiedEdgeCount: snapshot.edges.length,
        verifiedMembershipCount: snapshot.memberships.length, claimVerified: true, independenceVerified: true,
        note: 'Claim truth and evidence independence are asserted by the configured trusted verifier signature; artifact/source resolvers independently confirm current byte and lineage integrity.'
      };
    } catch (error) {
      return { verified: false, status: 'stale_or_invalid', providerId: configured.providerId,
        goalId: snapshot.goal_id, snapshotHash: snapshot.snapshot_hash,
        blockers: [{ code: error?.code || 'KNOWLEDGE_ATTESTATION_INVALID', message: String(error?.message || error) }] };
    }
  }

  function getCurrentVerification(goalId) {
    let snapshot;
    try { snapshot = currentSnapshot(goalId); }
    catch (error) { return { verified: false, status: 'blocked', goalId, blockers: [{ code: error?.code || 'KNOWLEDGE_SNAPSHOT_INVALID', message: String(error?.message || error) }] }; }
    let evidenceManifest;
    try { evidenceManifest = normalizeEvidenceManifest(snapshot, resolveEvidenceRecords, resolveSourceRecords); }
    catch (error) { evidenceManifest = failedEvidenceManifestAssessment(error); }
    if (!evidenceManifest.eligibleForAttestation) {
      return {
        verified: false, status: 'evidence_ineligible', goalId, snapshotHash: snapshot.snapshot_hash,
        evidenceManifestHash: evidenceManifest.hash, evidenceRecordCount: evidenceManifest.records.length,
        blockers: evidenceManifest.blockers
      };
    }
    let configured;
    try { configured = configuredVerifier(); }
    catch (error) { return { verified: false, status: 'verifier_unavailable', goalId, snapshotHash: snapshot.snapshot_hash,
      blockers: [{ code: error?.code || 'KNOWLEDGE_VERIFIER_NOT_CONFIGURED', message: String(error?.message || error) }] }; }
    // Verification/read paths must never initialize or advance the trust
    // configuration ledger. Only the explicit trust-status operation and the
    // signed-attestation ingestion path are allowed to record an observation.
    // In particular, `adaptive_goal_knowledge_snapshot_get` and graph search
    // are advertised as reads, so they must not create hidden trust-ledger rows.
    const antiRollback = inspectAdaptiveGoalTrustConfigurationHistory(trustConfigurationDb, configured.domain, configured);
    if (['rollback_detected', 'version_gap_detected', 'version_reused', 'time_rollback_detected', 'unavailable', 'current_configuration_invalid'].includes(antiRollback.status)) {
      const code = antiRollback.code || antiRollback.blocker || 'AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE';
      return { verified: false, status: 'trust_configuration_blocked', goalId, snapshotHash: snapshot.snapshot_hash,
        providerId: configured.providerId, trustRootSha256: configured.roots?.[0]?.trustRootSha256 || null,
        blockers: [{ code, message: `read-only trust-ledger inspection is ${antiRollback.status}; no trust observation was written` }] };
    }
    const trustObservation = antiRollback.status === 'current_or_forward' && antiRollback.latest &&
      antiRollback.latest.config_version === configured.configVersion &&
      antiRollback.latest.configuration_fingerprint === configured.configurationFingerprint &&
      antiRollback.latest.provider_id === configured.providerId;
    const report = { ...readPersistedAttestation(snapshot, configured), snapshotHash: snapshot.snapshot_hash, snapshot, verifierAvailable: true };
    if (!trustObservation && report.status !== 'stale_or_invalid') {
      return { ...report, verified: false, status: 'trust_configuration_not_observed', trustConfigurationObserved: false,
        blockers: [...(report.blockers || []), { code: 'KNOWLEDGE_TRUST_CONFIG_NOT_OBSERVED',
          message: 'the current trust configuration has not been explicitly observed at this exact version/fingerprint in the trust ledger; use the explicit trust-configuration status operation before relying on persisted attestation verification' }] };
    }
    if (!trustObservation && report.status === 'stale_or_invalid') {
      // Keep more specific findings (especially root revocation/signature
      // failure) visible while still making the trust observation boundary
      // explicit. This path remains non-authorizing and does not write ledger.
      report.trustConfigurationObserved = false;
      report.blockers = [...(report.blockers || []), { code: 'KNOWLEDGE_TRUST_CONFIG_NOT_OBSERVED',
        message: 'current trust configuration is not registered at this exact version/fingerprint; no trust observation was written' }];
    }
    if (report.verified === true && report.status === 'verified') {
      authenticatedVerificationReports.add(report);
      // The WeakSet authenticates object identity, not mutable fields. Freeze
      // the full report/snapshot tree so a caller cannot mutate signed metadata
      // or snapshot content after verification while retaining that identity.
      freezeJsonTree(report);
    }
    return report;
  }

  function getVerifierConfigurationStatus({ recordObservation = true } = {}) {
    try {
      const configured = configuredVerifier();
      const status = adaptiveGoalTrustConfigurationStatus(configured);
      const antiRollback = inspectAdaptiveGoalTrustConfigurationHistory(trustConfigurationDb, configured.domain, configured);
      if (['rollback_detected', 'version_gap_detected', 'version_reused', 'time_rollback_detected', 'unavailable'].includes(antiRollback.status)) {
        return { ...status, available: false, antiRollback, blockers: [...status.blockers,
          { code: antiRollback.code || 'AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE', message: `trust configuration anti-rollback check is ${antiRollback.status}` }] };
      }
      if (!recordObservation) {
        const latest = antiRollback.latest;
        const observed = antiRollback.status === 'current_or_forward' && latest &&
          latest.config_version === configured.configVersion &&
          latest.configuration_fingerprint === configured.configurationFingerprint &&
          latest.provider_id === configured.providerId;
        return { ...status, antiRollback, currentTrustConfigurationObserved: Boolean(observed),
          observationRequired: !observed,
          audit: { versionRecorded: Boolean(observed), recorded: false, idempotent: Boolean(observed), observationRequired: !observed,
            mode: 'read_only_no_ledger_write' } };
      }
      let recorded;
      try { recorded = assertAndRecordAdaptiveGoalTrustConfiguration(trustConfigurationDb, configured, { now: now() }); }
      catch (error) {
        return { ...status, available: false, antiRollback: { status: 'blocked', code: error?.code || 'AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE' },
          blockers: [...status.blockers, { code: error?.code || 'AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE', message: String(error?.message || error) }] };
      }
      const observed = inspectAdaptiveGoalTrustConfigurationHistory(trustConfigurationDb, configured.domain, configured);
      return { ...status, antiRollback: observed, currentTrustConfigurationObserved: observed.status === 'current_or_forward' &&
        observed.latest?.config_version === configured.configVersion && observed.latest?.configuration_fingerprint === configured.configurationFingerprint &&
        observed.latest?.provider_id === configured.providerId,
        observationRequired: false, audit: { versionRecorded: true, recorded: recorded.recorded, idempotent: recorded.idempotent,
          observationRequired: false, mode: 'explicit_trust_status_observation' } };
    } catch (error) {
      return { available: false, providerId: null, trustRootSha256: null, configurationFingerprint: null, roots: [],
        blockers: [{ code: error?.code || 'KNOWLEDGE_VERIFIER_NOT_CONFIGURED', message: String(error?.message || error) }] };
    }
  }

  function getAttestationRequest(goalId) {
    const snapshot = currentSnapshot(goalId);
    let evidenceManifest;
    try { evidenceManifest = normalizeEvidenceManifest(snapshot, resolveEvidenceRecords, resolveSourceRecords); }
    catch (error) { evidenceManifest = failedEvidenceManifestAssessment(error); }
    // Request construction is diagnostic/read-only. The external attestation
    // ingest path performs the explicit trust observation when it validates a
    // signature; this method must not write to the anti-rollback ledger.
    const verifierConfiguration = getVerifierConfigurationStatus({ recordObservation: false });
    const { canonical_json: _canonical, ...publicSnapshot } = snapshot;
    return {
      verified: false,
      requiresExternalSignature: true,
      providerIdExpected: verifierConfiguration.providerId || process.env[ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_PROVIDER_ENV] || null,
      verifierConfiguration,
      scope: ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_SCOPE,
      snapshot: publicSnapshot,
      evidenceManifest: evidenceManifest.records,
      evidenceManifestHash: evidenceManifest.hash,
      eligibleForAttestation: evidenceManifest.eligibleForAttestation,
      attestationBlockers: evidenceManifest.blockers,
      requiredSignedFields: evidenceManifest.eligibleForAttestation
        ? ['claim_status=verified', 'independence_status=verified'] : [],
      warning: 'Hashes and lineage prove content integrity and origin only. A trusted verifier must independently adjudicate claim truth and evidence independence before signing this exact request.'
    };
  }

  function attest(attestationInput) {
    if (!isRecord(attestationInput)) fail('KNOWLEDGE_ATTESTATION_SHAPE_INVALID', 'attestation must be an object signed by the configured external verifier');
    let canonicalInput;
    try { canonicalInput = canonicalAdaptiveGoalKnowledgeJson(attestationInput); }
    catch (error) {
      fail('KNOWLEDGE_ATTESTATION_SHAPE_INVALID', `attestation must be an unambiguous JSON data object: ${String(error?.message || error)}`);
    }
    // Verify and persist the exact inert JSON snapshot we canonicalized, not
    // the caller-owned object whose descriptors/properties could change later.
    try { attestationInput = JSON.parse(canonicalInput); }
    catch { fail('KNOWLEDGE_ATTESTATION_SHAPE_INVALID', 'canonical attestation could not be reconstructed as JSON'); }
    const configured = configuredVerifier();
    assertAndRecordAdaptiveGoalTrustConfiguration(trustConfigurationDb, configured, { now: now() });
    const goalId = attestationInput.goal_id;
    if (typeof goalId !== 'string' || !goalId.trim()) fail('KNOWLEDGE_ATTESTATION_BINDING_INVALID', 'attestation must identify a goal_id');
    const db = store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const snapshot = currentSnapshot(goalId);
      const evidenceManifest = normalizeEvidenceManifest(snapshot, resolveEvidenceRecords, resolveSourceRecords);
      if (!evidenceManifest.eligibleForAttestation) {
        fail(evidenceManifest.blockers[0]?.code || 'KNOWLEDGE_EVIDENCE_MANIFEST_INVALID',
          evidenceManifest.blockers.map(item => item.message).join('; '));
      }
      const trustedRoot = validateForCurrentSnapshot(attestationInput, snapshot, configured, evidenceManifest);
      const canonicalAttestation = canonicalAdaptiveGoalKnowledgeJson(attestationInput);
      const existingIdentical = db.prepare('SELECT attestation_id,payload_json FROM adaptive_goal_knowledge_verifications WHERE goal_id=? AND snapshot_hash=? AND attestation_id=?')
        .get(goalId, snapshot.snapshot_hash, attestationId(attestationInput));
      if (existingIdentical) {
        if (existingIdentical.payload_json !== canonicalAttestation) fail('KNOWLEDGE_ATTESTATION_DURABLE_IDENTITY_MISMATCH', 'attestation ID is already bound to different canonical payload bytes');
        db.exec('COMMIT');
        return { ...readPersistedAttestation(snapshot, configured), created: false, idempotent: true };
      }
      const current = readPersistedAttestation(snapshot, configured);
      if (current.verified) fail('KNOWLEDGE_SNAPSHOT_ALREADY_ATTESTED', 'this exact snapshot already has a current trusted verifier attestation; refreshing it before expiry is not permitted');
      const nonceCount = db.prepare('SELECT COUNT(*) AS n FROM adaptive_goal_knowledge_verifications WHERE nonce=?').get(attestationInput.nonce).n;
      if (nonceCount !== 0) fail('KNOWLEDGE_ATTESTATION_NONCE_REPLAY', 'attestation nonce has already been used in a durable record');
      const id = attestationId(attestationInput);
      db.prepare(`INSERT INTO adaptive_goal_knowledge_verifications
        (attestation_id,goal_id,snapshot_hash,provider_id,nonce,payload_json,created_at,configuration_fingerprint,trust_key_id,trust_config_version,configuration_source,config_change_reference)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, goalId, snapshot.snapshot_hash, configured.providerId, attestationInput.nonce,
          canonicalAttestation, new Date(now()).toISOString(), configured.configurationFingerprint, trustedRoot.keyId,
          configured.configVersion, configured.configurationSource, configured.configChangeReference);
      const readback = db.prepare(`SELECT attestation_id,goal_id,snapshot_hash,provider_id,nonce,payload_json,configuration_fingerprint,trust_key_id,trust_config_version,configuration_source,config_change_reference
        FROM adaptive_goal_knowledge_verifications WHERE attestation_id=?`).get(id);
      if (!readback || readback.payload_json !== canonicalAdaptiveGoalKnowledgeJson(attestationInput) ||
          readback.attestation_id !== id || readback.goal_id !== goalId || readback.snapshot_hash !== snapshot.snapshot_hash ||
          readback.provider_id !== configured.providerId || readback.nonce !== attestationInput.nonce ||
          readback.configuration_fingerprint !== configured.configurationFingerprint || readback.trust_key_id !== trustedRoot.keyId ||
          readback.trust_config_version !== configured.configVersion || readback.configuration_source !== configured.configurationSource ||
          readback.config_change_reference !== configured.configChangeReference) {
        fail('KNOWLEDGE_ATTESTATION_PERSISTENCE_MISMATCH', 'durable verifier record failed exact canonical readback');
      }
      db.exec('COMMIT');
      const verified = readPersistedAttestation(snapshot, configured);
      if (!verified.verified) fail('KNOWLEDGE_ATTESTATION_READBACK_INVALID', verified.blockers?.map(item => item.code).join(', ') || 'stored verifier record did not validate');
      return { ...verified, created: true, idempotent: false };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  function buildVerifiedGraph(goalId, startNodeId, goalNodeId, expectedSnapshotHash) {
    const report = getCurrentVerification(goalId);
    if (!report.verified) fail('KNOWLEDGE_GRAPH_NOT_VERIFIED', report.blockers?.map(item => item.code).join(', ') || 'current Goal/Idea Graph has no trusted verification');
    const snapshot = report.snapshot;
    if (expectedSnapshotHash !== snapshot.snapshot_hash) fail('KNOWLEDGE_GRAPH_SNAPSHOT_STALE', 'expected_snapshot_hash differs from the independently recomputed current persisted graph hash');
    const nodes = new Map(snapshot.nodes.map(node => [node.id, node]));
    if (!nodes.has(startNodeId) || !nodes.has(goalNodeId) || startNodeId === goalNodeId) {
      fail('KNOWLEDGE_GRAPH_ENDPOINT_INVALID', 'start and goal node IDs must be distinct current members of the verified Goal/Idea Graph');
    }
    if (nodes.get(goalNodeId).type !== 'goal') fail('KNOWLEDGE_GRAPH_GOAL_TYPE_INVALID', 'goal_node_id must identify a persisted node of type goal');
    if (nodes.get(startNodeId).type === 'experiment') fail('KNOWLEDGE_GRAPH_START_TYPE_INVALID', 'start_node_id cannot be an action/experiment node');
    const edges = snapshot.edges.filter(edge => edge.type !== 'recovers_to').map(edge => ({ from: edge.from_id, to: edge.to_id, type: edge.type }));
    const graph = {
      schemaVersion: 1,
      startNodeId,
      goalNodeId,
      nodes: snapshot.nodes.map(node => {
        const content = node.content && typeof node.content === 'object' && !Array.isArray(node.content) ? node.content : {};
        return {
          id: node.id,
          type: node.type,
          label: [content.label, content.title, content.name, content.summary].find(value => typeof value === 'string' && value.trim()) || node.stable_key,
          evidenceRefs: node.evidence_refs,
          estimatedCost: null, estimatedRisk: null, estimatedSuccessConfidence: null, reusePotential: null, informationValue: null,
          metricProvenance: Object.fromEntries(['estimatedCost','estimatedRisk','estimatedSuccessConfidence','reusePotential','informationValue'].map(metric => [metric, {
            method: 'verified persisted Goal/Idea graph has no calibrated planning metric', sourceRefs: [], confidence: null
          }]))
        };
      }),
      edges
    };
    return {
      graph, snapshotHash: snapshot.snapshot_hash, attestationId: report.attestationId, providerId: report.providerId,
      verificationReport: report,
      trustRootSha256: report.trustRootSha256, issuedAt: report.issuedAt, expiresAt: report.expiresAt,
      evidenceManifestHash: report.evidenceManifestHash, nodeIds: snapshot.node_ids, edgeIds: snapshot.edge_ids,
      membershipIds: snapshot.membership_ids, verifiedNodeCount: snapshot.nodes.length, verifiedEdgeCount: snapshot.edges.length,
      verifiedMembershipCount: snapshot.memberships.length, claimVerified: true, independenceVerified: true
    };
  }

  return Object.freeze({ getVerifierConfigurationStatus, getCurrentVerification, getAttestationRequest, attest, buildVerifiedGraph });
}
