import { createHash } from 'node:crypto';
import { parseStrictJson } from './strict-json.js';

// Normative v2 wire profile approved by the Project Owner on 2026-10-30.
// Keep these bounds synchronized with strict-json.js and the independent
// cross-language vector corpus; changing them requires a protocol version or
// an explicitly approved compatibility revision.
export const AGG_CHECKPOINT_V2_PROTOCOL_ID = 'runalith.agg.external-checkpoint';
export const AGG_CHECKPOINT_V2_PROTOCOL_VERSION = 2;
export const AGG_CHECKPOINT_V2_MAX_JSON_BYTES = 1024 * 1024;
export const AGG_CHECKPOINT_V2_MAX_JSON_DEPTH = 256;
export const AGG_CHECKPOINT_V2_MAX_JSON_NODES = 1_000_000;

const DOMAIN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function fail(message) {
  throw new TypeError(`AGG checkpoint v2 JCS: ${message}`);
}

function assertWellFormedUnicode(value, label) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail(`${label} contains an unpaired high surrogate`);
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail(`${label} contains an unpaired low surrogate`);
    }
  }
}

function assertJcsValue(value, { seen = new Set(), depth = 0, nodeCount = { value: 0 } } = {}) {
  if (depth > AGG_CHECKPOINT_V2_MAX_JSON_DEPTH) fail('maximum nesting depth exceeded');
  if (++nodeCount.value > AGG_CHECKPOINT_V2_MAX_JSON_NODES) fail('maximum JSON node count exceeded');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    assertWellFormedUnicode(value, 'string');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('numbers must be finite IEEE-754 values');
    if (Object.is(value, -0)) fail('negative zero is not supported by this constrained profile');
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) fail('integer is outside the supported safe-integer range');
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) fail('value must be acyclic JSON data');

  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || Reflect.ownKeys(value).some(key => typeof key === 'symbol' ||
        (key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)))) {
      fail('arrays must be dense plain arrays without extra properties');
    }
    seen.add(value);
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) fail('sparse arrays are not supported');
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('array accessors and hidden properties are not supported');
      assertJcsValue(descriptor.value, { seen, depth: depth + 1, nodeCount });
    }
    seen.delete(value);
    return;
  }

  if (prototype !== Object.prototype && prototype !== null) fail('objects must be plain JSON records');
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) fail('symbol object keys are not supported');
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    assertWellFormedUnicode(key, 'object key');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('object accessors and hidden properties are not supported');
    assertJcsValue(descriptor.value, { seen, depth: depth + 1, nodeCount });
  }
  seen.delete(value);
}

function serializeJcs(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeJcs).join(',')}]`;
  // ECMAScript's default string ordering compares UTF-16 code units, as RFC 8785 requires.
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${serializeJcs(value[key])}`).join(',')}}`;
}

/**
 * Parse protocol JSON from the original UTF-8 byte sequence. Strings are
 * intentionally not accepted: callers must not decode/normalize raw bytes
 * before duplicate-key, BOM, UTF-8 and trailing-content checks have run.
 */
export function parseAggCheckpointV2Json(input, { label = 'AGG checkpoint v2 JSON', maxBytes = AGG_CHECKPOINT_V2_MAX_JSON_BYTES } = {}) {
  if (!(input instanceof Uint8Array)) fail('input must be the original UTF-8 byte sequence');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > AGG_CHECKPOINT_V2_MAX_JSON_BYTES) {
    fail(`maxBytes must be between 1 and ${AGG_CHECKPOINT_V2_MAX_JSON_BYTES}`);
  }
  return parseStrictJson(input, label, { maxBytes });
}

/** RFC 8785 JCS serialization over the constrained I-JSON profile above. */
export function canonicalizeAggCheckpointV2Jcs(value) {
  assertJcsValue(value);
  const canonical = serializeJcs(value);
  if (Buffer.byteLength(canonical, 'utf8') > AGG_CHECKPOINT_V2_MAX_JSON_BYTES) {
    fail(`canonical output exceeds ${AGG_CHECKPOINT_V2_MAX_JSON_BYTES} bytes`);
  }
  return canonical;
}

export function canonicalizeAggCheckpointV2JcsBytes(value) {
  return Buffer.from(canonicalizeAggCheckpointV2Jcs(value), 'utf8');
}

/**
 * Hash a canonical, versioned envelope. The domain and version are inside the
 * envelope, so identical payloads in different security domains cannot alias.
 * If payload originates from external JSON, the caller MUST first pass its
 * original bytes through parseAggCheckpointV2Json(); an object alone cannot
 * reveal duplicate raw member names that were lost before this call.
 */
export function createAggCheckpointV2DigestEnvelope({ domain, version, payload } = {}) {
  if (typeof domain !== 'string' || !DOMAIN.test(domain) || domain.length > 96) fail('domain must be a bounded lowercase protocol identifier');
  if (!Number.isSafeInteger(version) || version < 1) fail('component version must be a positive safe integer');
  return {
    protocol_id: AGG_CHECKPOINT_V2_PROTOCOL_ID,
    protocol_version: AGG_CHECKPOINT_V2_PROTOCOL_VERSION,
    component_domain: domain,
    component_version: version,
    payload
  };
}

export function computeAggCheckpointV2DomainDigest({ domain, version, payload } = {}) {
  const envelope = createAggCheckpointV2DigestEnvelope({ domain, version, payload });
  const bytes = canonicalizeAggCheckpointV2JcsBytes(envelope);
  return createHash('sha256').update(bytes).digest('hex');
}
