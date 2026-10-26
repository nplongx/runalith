import { createPublicKey, verify as verifySignature } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export const EXTERNAL_CHECKPOINT_CONTRACT = 'host-monotonic-trust-ledger-checkpoint/v1';

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function add(errors, code) { if (!errors.includes(code)) errors.push(code); }

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
  now = Date.now(),
  maxAgeMs = 5 * 60_000
} = {}) {
  const errors = [];
  const requiredStrings = [
    'authority_id', 'request_nonce', 'checkpoint_digest', 'previous_checkpoint_digest',
    'ledger_state_sha256', 'trust_domain_state_sha256', 'candidate_sha256', 'rollback_sha256',
    'observed_at', 'signature_base64'
  ];
  if (!isRecord(response) || response.schema_version !== 1 || response.contract !== EXTERNAL_CHECKPOINT_CONTRACT) {
    add(errors, 'EXTERNAL_CHECKPOINT_SCHEMA_INVALID');
  }
  for (const key of requiredStrings) if (typeof response?.[key] !== 'string' || !response[key].trim()) add(errors, 'EXTERNAL_CHECKPOINT_REQUIRED_FIELD_MISSING');
  if (!Number.isSafeInteger(response?.checkpoint_sequence) || response.checkpoint_sequence < 1) add(errors, 'EXTERNAL_CHECKPOINT_SEQUENCE_INVALID');
  for (const key of ['checkpoint_digest', 'previous_checkpoint_digest', 'ledger_state_sha256', 'trust_domain_state_sha256', 'candidate_sha256', 'rollback_sha256']) {
    if (!SHA256.test(response?.[key] || '')) add(errors, 'EXTERNAL_CHECKPOINT_HASH_INVALID');
  }
  if (response?.authority_id !== expectedAuthorityId || typeof expectedAuthorityId !== 'string' || !expectedAuthorityId.trim()) add(errors, 'EXTERNAL_CHECKPOINT_AUTHORITY_MISMATCH');
  if (response?.request_nonce !== requestNonce || typeof requestNonce !== 'string' || !/^[a-f0-9]{32,128}$/.test(requestNonce)) add(errors, 'EXTERNAL_CHECKPOINT_CHALLENGE_MISMATCH');
  if (response?.candidate_sha256 !== candidateSha256 || !SHA256.test(candidateSha256 || '') ||
      response?.rollback_sha256 !== rollbackSha256 || !SHA256.test(rollbackSha256 || '')) add(errors, 'EXTERNAL_CHECKPOINT_RELEASE_BINDING_MISMATCH');

  const observedAt = typeof response?.observed_at === 'string' ? Date.parse(response.observed_at) : NaN;
  if (!Number.isFinite(observedAt) || new Date(observedAt).toISOString() !== response?.observed_at ||
      observedAt > now + 5_000 || now - observedAt > maxAgeMs) add(errors, 'EXTERNAL_CHECKPOINT_STALE_OR_NONCANONICAL');

  if (!isRecord(continuity) || continuity.source !== 'host_monotonic_store' ||
      typeof continuity.authorityId !== 'string' || continuity.authorityId !== expectedAuthorityId ||
      !Number.isSafeInteger(continuity.highWaterSequence) || continuity.highWaterSequence < 0 ||
      (continuity.highWaterSequence > 0 && !SHA256.test(continuity.lastCheckpointDigest || ''))) {
    add(errors, 'EXTERNAL_CHECKPOINT_CONTINUITY_SOURCE_UNVERIFIED');
  } else {
    if (response?.checkpoint_sequence <= continuity.highWaterSequence) add(errors, 'EXTERNAL_CHECKPOINT_ANTI_ROLLBACK_FAILED');
    if (continuity.highWaterSequence > 0 && response?.previous_checkpoint_digest !== continuity.lastCheckpointDigest) {
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
        signatureVerified = verifySignature(null, Buffer.from(canonicalJson(signedPayload)), key, Buffer.from(signatureBase64, 'base64'));
        if (!signatureVerified) add(errors, 'EXTERNAL_CHECKPOINT_SIGNATURE_INVALID');
      }
    } catch {
      add(errors, 'EXTERNAL_CHECKPOINT_VERIFIER_CONFIGURATION_INVALID');
    }
  }
  return {
    verified: errors.length === 0 && signatureVerified,
    signatureVerified,
    continuityContractValid: !errors.some(code => code.startsWith('EXTERNAL_CHECKPOINT_CONTINUITY') ||
      code === 'EXTERNAL_CHECKPOINT_ANTI_ROLLBACK_FAILED' || code === 'EXTERNAL_CHECKPOINT_CHAIN_DISCONTINUITY'),
    authorityId: typeof response?.authority_id === 'string' ? response.authority_id : null,
    checkpointSequence: Number.isSafeInteger(response?.checkpoint_sequence) ? response.checkpoint_sequence : null,
    checkpointDigest: SHA256.test(response?.checkpoint_digest || '') ? response.checkpoint_digest : null,
    blockers: errors,
    productionAuthorityEstablished: false,
    note: 'Cryptographic response verification is not proof that the continuity adapter or public-key provisioning is host-owned; rollout must remain blocked until that boundary is independently verified.'
  };
}

export function canonicalExternalCheckpointPayload(payload) {
  if (!isRecord(payload)) throw new TypeError('checkpoint payload must be an object');
  return canonicalJson(payload);
}
