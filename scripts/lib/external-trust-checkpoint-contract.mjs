import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export const EXTERNAL_CHECKPOINT_CONTRACT = 'host-monotonic-trust-ledger-checkpoint/v1';
const RESPONSE_KEYS = Object.freeze([
  'schema_version', 'contract', 'authority_id', 'request_nonce', 'checkpoint_sequence', 'checkpoint_digest',
  'previous_checkpoint_digest', 'ledger_state_sha256', 'trust_domain_state_sha256', 'candidate_sha256',
  'rollback_sha256', 'observed_at', 'signature_base64'
].sort());
const DIGEST_FIELDS = Object.freeze([
  'schema_version', 'contract', 'authority_id', 'checkpoint_sequence', 'previous_checkpoint_digest',
  'ledger_state_sha256', 'trust_domain_state_sha256', 'candidate_sha256', 'rollback_sha256'
]);
const BOOTSTRAP_REQUIRED_SEQUENCE = 1;
const MAX_CHECKPOINT_AGE_MS = 5 * 60_000;

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function assertInertJson(value, { seen = new Set(), depth = 0 } = {}) {
  if (depth > 64) throw new TypeError('external checkpoint JSON exceeds maximum nesting depth');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('external checkpoint JSON contains a non-finite number');
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) throw new TypeError('external checkpoint input must be acyclic JSON data');
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || Reflect.ownKeys(value).some(key => typeof key === 'symbol' ||
        (key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)))) {
      throw new TypeError('external checkpoint arrays must be dense plain arrays without extra properties');
    }
    seen.add(value);
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) throw new TypeError('external checkpoint arrays cannot be sparse');
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new TypeError('external checkpoint arrays cannot contain accessors or hidden properties');
      assertInertJson(descriptor.value, { seen, depth: depth + 1 });
    }
    return;
  }
  if (!isRecord(value) || (prototype !== Object.prototype && prototype !== null) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || key === '__proto__')) {
    throw new TypeError('external checkpoint objects must be plain JSON records without symbol/prototype keys');
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new TypeError('external checkpoint objects cannot contain accessors or hidden properties');
    assertInertJson(descriptor.value, { seen, depth: depth + 1 });
  }
}
function canonicalJson(value) {
  assertInertJson(value);
  return canonicalJsonUnchecked(value);
}
function canonicalJsonUnchecked(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonUnchecked).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJsonUnchecked(value[key])}`).join(',')}}`;
  return JSON.stringify(Object.is(value, -0) ? 0 : value);
}
function add(errors, code) { if (!errors.includes(code)) errors.push(code); }

/**
 * Compute the stable digest for checkpoint state. The challenge nonce and
 * observed_at timestamp are intentionally excluded because they bind an
 * individual response, not the durable checkpoint identity. The Ed25519
 * signature covers the complete response, including both of those fields.
 */
export function computeExternalTrustCheckpointDigest(checkpoint) {
  assertInertJson(checkpoint);
  if (!isRecord(checkpoint)) throw new TypeError('checkpoint must be an object');
  const payload = {};
  for (const field of DIGEST_FIELDS) {
    if (!Object.hasOwn(checkpoint, field)) throw new TypeError(`checkpoint is missing digest field: ${field}`);
    payload[field] = checkpoint[field];
  }
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/**
 * Verify a signed checkpoint response against a host-provisioned Ed25519 root.
 * `continuity` MUST come from an independently authenticated monotonic store;
 * this function validates its contract but cannot authenticate the adapter that
 * supplied it. The rollout gate intentionally does not treat this result as
 * production authority until a host-owned adapter is provisioned and attested.
 */
export function verifyExternalTrustCheckpointResponse(response, {
  authorityPublicKeyPem,
  expectedAuthorityId,
  requestNonce,
  candidateSha256,
  rollbackSha256,
  continuity,
  commitCheckpointTransition,
  // Kept for source compatibility only. Consuming a nonce separately from
  // advancing the checkpoint is not an atomic anti-rollback operation.
  consumeRequestNonce,
  now = Date.now(),
  maxAgeMs = 5 * 60_000
} = {}) {
  const errors = [];
  try {
    assertInertJson(response);
    assertInertJson(continuity);
  } catch {
    return {
      verified: false, signatureVerified: false, continuityContractValid: false,
      authorityId: null, checkpointSequence: null, checkpointDigest: null,
      blockers: ['EXTERNAL_CHECKPOINT_JSON_INVALID'], continuitySourceAuthenticated: false,
      authorityKeyProvisioningAuthenticated: false, nonceConsumed: false,
      cryptographicResponseVerified: false, productionAuthorityEstablished: false,
      note: 'Hostile or non-JSON checkpoint/continuity objects are rejected before any field is read.'
    };
  }
  const requiredStrings = [
    'authority_id', 'request_nonce', 'checkpoint_digest', 'previous_checkpoint_digest',
    'ledger_state_sha256', 'trust_domain_state_sha256', 'candidate_sha256', 'rollback_sha256',
    'observed_at', 'signature_base64'
  ];
  if (!isRecord(response) || response.schema_version !== 1 || response.contract !== EXTERNAL_CHECKPOINT_CONTRACT) {
    add(errors, 'EXTERNAL_CHECKPOINT_SCHEMA_INVALID');
  }
  if (isRecord(response) && Object.keys(response).sort().join(',') !== RESPONSE_KEYS.join(',')) {
    add(errors, 'EXTERNAL_CHECKPOINT_SCHEMA_INVALID');
  }
  for (const key of requiredStrings) if (typeof response?.[key] !== 'string' || !response[key].trim()) add(errors, 'EXTERNAL_CHECKPOINT_REQUIRED_FIELD_MISSING');
  if (!Number.isSafeInteger(response?.checkpoint_sequence) || response.checkpoint_sequence < 1) add(errors, 'EXTERNAL_CHECKPOINT_SEQUENCE_INVALID');
  for (const key of ['checkpoint_digest', 'previous_checkpoint_digest', 'ledger_state_sha256', 'trust_domain_state_sha256', 'candidate_sha256', 'rollback_sha256']) {
    if (!SHA256.test(response?.[key] || '')) add(errors, 'EXTERNAL_CHECKPOINT_HASH_INVALID');
  }
  if (isRecord(response) && DIGEST_FIELDS.every(field => Object.hasOwn(response, field)) && SHA256.test(response?.checkpoint_digest || '')) {
    try {
      if (computeExternalTrustCheckpointDigest(response) !== response.checkpoint_digest) add(errors, 'EXTERNAL_CHECKPOINT_DIGEST_MISMATCH');
    } catch {
      add(errors, 'EXTERNAL_CHECKPOINT_DIGEST_MISMATCH');
    }
  }
  if (response?.authority_id !== expectedAuthorityId || typeof expectedAuthorityId !== 'string' || !expectedAuthorityId.trim()) add(errors, 'EXTERNAL_CHECKPOINT_AUTHORITY_MISMATCH');
  if (response?.request_nonce !== requestNonce || typeof requestNonce !== 'string' || !/^[a-f0-9]{32,128}$/.test(requestNonce)) add(errors, 'EXTERNAL_CHECKPOINT_CHALLENGE_MISMATCH');
  if (response?.candidate_sha256 !== candidateSha256 || !SHA256.test(candidateSha256 || '') ||
      response?.rollback_sha256 !== rollbackSha256 || !SHA256.test(rollbackSha256 || '')) add(errors, 'EXTERNAL_CHECKPOINT_RELEASE_BINDING_MISMATCH');

  // Do not let a caller accidentally disable freshness by passing Infinity,
  // NaN, a negative value, or a wider-than-contract age window.
  const clockConfigurationValid = Number.isSafeInteger(now) && Number.isSafeInteger(maxAgeMs) &&
    maxAgeMs >= 1 && maxAgeMs <= MAX_CHECKPOINT_AGE_MS;
  if (!clockConfigurationValid) add(errors, 'EXTERNAL_CHECKPOINT_VERIFIER_CONFIGURATION_INVALID');
  const observedAt = typeof response?.observed_at === 'string' ? Date.parse(response.observed_at) : NaN;
  if (!Number.isFinite(observedAt) || new Date(observedAt).toISOString() !== response?.observed_at ||
      (clockConfigurationValid && (observedAt > now + 5_000 || now - observedAt > maxAgeMs))) {
    add(errors, 'EXTERNAL_CHECKPOINT_STALE_OR_NONCANONICAL');
  }

  if (!isRecord(continuity) || continuity.source !== 'host_monotonic_store' ||
      typeof continuity.authorityId !== 'string' || continuity.authorityId !== expectedAuthorityId ||
      !Number.isSafeInteger(continuity.highWaterSequence) || continuity.highWaterSequence < BOOTSTRAP_REQUIRED_SEQUENCE ||
      !SHA256.test(continuity.lastCheckpointDigest || '')) {
    add(errors, 'EXTERNAL_CHECKPOINT_CONTINUITY_SOURCE_UNVERIFIED');
  } else {
    if (response?.checkpoint_sequence <= continuity.highWaterSequence) add(errors, 'EXTERNAL_CHECKPOINT_ANTI_ROLLBACK_FAILED');
    else if (response?.checkpoint_sequence !== continuity.highWaterSequence + 1) add(errors, 'EXTERNAL_CHECKPOINT_SEQUENCE_GAP');
    if (response?.previous_checkpoint_digest !== continuity.lastCheckpointDigest) {
      add(errors, 'EXTERNAL_CHECKPOINT_CHAIN_DISCONTINUITY');
    }
  }

  let signatureVerified = false;
  if (typeof authorityPublicKeyPem !== 'string' || !authorityPublicKeyPem.includes('BEGIN PUBLIC KEY') ||
      typeof response?.signature_base64 !== 'string' || !BASE64.test(response.signature_base64)) {
    add(errors, 'EXTERNAL_CHECKPOINT_VERIFIER_CONFIGURATION_INVALID');
  } else {
    try {
      const key = createPublicKey(authorityPublicKeyPem);
      if (key.asymmetricKeyType !== 'ed25519') add(errors, 'EXTERNAL_CHECKPOINT_VERIFIER_KEY_TYPE_INVALID');
      else {
        const { signature_base64: signatureBase64, ...signedPayload } = response;
        const signature = Buffer.from(signatureBase64, 'base64');
        if (signature.length !== 64 || signature.toString('base64') !== signatureBase64) {
          add(errors, 'EXTERNAL_CHECKPOINT_SIGNATURE_ENCODING_INVALID');
        } else {
          signatureVerified = verifySignature(null, Buffer.from(canonicalJson(signedPayload)), key, signature);
        }
        if (!signatureVerified) add(errors, 'EXTERNAL_CHECKPOINT_SIGNATURE_INVALID');
      }
    } catch {
      add(errors, 'EXTERNAL_CHECKPOINT_VERIFIER_CONFIGURATION_INVALID');
    }
  }
  const cryptographicResponseVerified = errors.length === 0 && signatureVerified;
  let nonceConsumed = false;
  let checkpointStateAdvanced = false;
  if (cryptographicResponseVerified) {
    if (typeof commitCheckpointTransition !== 'function') {
      // A legacy nonce-only consumer must not be invoked here: it could burn
      // the challenge and still leave sequence/high-water state uncommitted.
      add(errors, typeof consumeRequestNonce === 'function'
        ? 'EXTERNAL_CHECKPOINT_ATOMIC_TRANSITION_NOT_CONFIGURED'
        : 'EXTERNAL_CHECKPOINT_NONCE_CONSUMER_NOT_CONFIGURED');
    } else {
      try {
        // This callback is the security-critical compare-and-swap boundary.
        // It must atomically verify the expected prior high-water/digest,
        // reserve the nonce, and advance to the new checkpoint. The local
        // verifier can check the callback result, but cannot authenticate its
        // implementation or backing store.
        const committed = commitCheckpointTransition({
          requestNonce,
          authorityId: response.authority_id,
          candidateSha256,
          rollbackSha256,
          expectedHighWaterSequence: continuity?.highWaterSequence,
          expectedPreviousCheckpointDigest: continuity?.lastCheckpointDigest,
          checkpointSequence: response.checkpoint_sequence,
          checkpointDigest: response.checkpoint_digest,
          previousCheckpointDigest: response.previous_checkpoint_digest
        });
        if (committed === true) {
          nonceConsumed = true;
          checkpointStateAdvanced = true;
        } else {
          add(errors, 'EXTERNAL_CHECKPOINT_ATOMIC_TRANSITION_REJECTED');
        }
      } catch {
        add(errors, 'EXTERNAL_CHECKPOINT_ATOMIC_TRANSITION_FAILED');
      }
    }
  }
  return {
    verified: cryptographicResponseVerified && nonceConsumed && checkpointStateAdvanced && errors.length === 0,
    cryptographicResponseVerified,
    signatureVerified,
    nonceConsumed,
    checkpointStateAdvanced,
    continuityContractValid: !errors.some(code => code.startsWith('EXTERNAL_CHECKPOINT_CONTINUITY') ||
      code === 'EXTERNAL_CHECKPOINT_ANTI_ROLLBACK_FAILED' || code === 'EXTERNAL_CHECKPOINT_SEQUENCE_GAP' ||
      code === 'EXTERNAL_CHECKPOINT_CHAIN_DISCONTINUITY' || code === 'EXTERNAL_CHECKPOINT_DIGEST_MISMATCH' ||
      code.startsWith('EXTERNAL_CHECKPOINT_ATOMIC_TRANSITION_')),
    authorityId: typeof response?.authority_id === 'string' ? response.authority_id : null,
    checkpointSequence: Number.isSafeInteger(response?.checkpoint_sequence) ? response.checkpoint_sequence : null,
    checkpointDigest: SHA256.test(response?.checkpoint_digest || '') ? response.checkpoint_digest : null,
    blockers: errors,
    continuitySourceAuthenticated: false,
    authorityKeyProvisioningAuthenticated: false,
    productionAuthorityEstablished: false,
    note: 'Cryptographic response verification is not proof that the continuity adapter or public-key provisioning is host-owned; the checkpoint must be exactly next in an already anchored sequence, and rollout remains blocked until that boundary is independently verified.'
  };
}

export function canonicalExternalCheckpointPayload(payload) {
  assertInertJson(payload);
  if (!isRecord(payload)) throw new TypeError('checkpoint payload must be an object');
  return canonicalJson(payload);
}
