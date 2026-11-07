import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  AGG_CHECKPOINT_V2_MAX_JSON_BYTES,
  AGG_CHECKPOINT_V2_MAX_JSON_NODES,
  AGG_CHECKPOINT_V2_PROTOCOL_ID,
  AGG_CHECKPOINT_V2_PROTOCOL_VERSION,
  canonicalizeAggCheckpointV2Jcs,
  canonicalizeAggCheckpointV2JcsBytes,
  createAggCheckpointV2DigestEnvelope,
  computeAggCheckpointV2DomainDigest,
  parseAggCheckpointV2Json
} from '../src/runtime/agg-checkpoint-jcs-v2.js';

const utf8 = value => Buffer.from(value, 'utf8');
const vectors = JSON.parse(fs.readFileSync(new URL('./fixtures/agg-checkpoint-v2-jcs-vectors.json', import.meta.url), 'utf8'));

function generateBoundaryValue(vector) {
  switch (vector.generator) {
    case 'materialized_ascii_string': return 'a'.repeat(vector.content_bytes);
    case 'nested_arrays': {
      let value = 0;
      for (let depth = 0; depth < vector.depth; depth++) value = [value];
      return value;
    }
    case 'array_of_nulls': return new Array(vector.items).fill(null);
    default: throw new Error(`unknown boundary vector generator: ${vector.generator}`);
  }
}

function generateBoundaryRaw(vector) {
  switch (vector.generator) {
    case 'json_ascii_string': return utf8(JSON.stringify('a'.repeat(vector.content_bytes)));
    case 'nested_arrays': return utf8('['.repeat(vector.depth) + '0' + ']'.repeat(vector.depth));
    default: throw new Error(`unknown raw boundary vector generator: ${vector.generator}`);
  }
}

test('parses original UTF-8 bytes and rejects duplicate decoded member names', () => {
  assert.deepEqual(parseAggCheckpointV2Json(utf8('{"a":1,"b":2}')), { a: 1, b: 2 });
  assert.throws(() => parseAggCheckpointV2Json(utf8('{"a":1,"\\u0061":2}')), /duplicate decoded object key/);
  assert.throws(() => parseAggCheckpointV2Json('{"a":1}'), /original UTF-8 byte sequence/);
});

test('rejects invalid UTF-8, BOM, trailing content, unsafe integers and invalid Unicode', () => {
  assert.throws(() => parseAggCheckpointV2Json(Buffer.from([0xc3, 0x28])), /not valid UTF-8/);
  assert.throws(() => parseAggCheckpointV2Json(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('{}')])), /invalid/);
  assert.throws(() => parseAggCheckpointV2Json(utf8('{} true')), /trailing content/);
  assert.throws(() => parseAggCheckpointV2Json(utf8('{"n":9007199254740992}')), /safe integer/);
  assert.throws(() => parseAggCheckpointV2Json(utf8('{"s":"\\ud800"}')), /invalid JSON string escape/);
  assert.throws(() => parseAggCheckpointV2Json(utf8('{"n":-0}')), /negative zero/);
  assert.throws(() => parseAggCheckpointV2Json(utf8('{"n":-0.0}')), /negative zero/);
  assert.throws(() => parseAggCheckpointV2Json(utf8('{"n":-0e0}')), /negative zero/);
  assert.throws(() => parseAggCheckpointV2Json(utf8('['.repeat(257) + '0' + ']'.repeat(257))), /maximum nesting depth/);
});

test('enforces protocol byte limit before parsing', () => {
  assert.throws(() => parseAggCheckpointV2Json(utf8('{"x":"12345"}'), { maxBytes: 8 }), /exceeds the 8-byte limit/);
  assert.throws(() => parseAggCheckpointV2Json(utf8('{}'), { maxBytes: AGG_CHECKPOINT_V2_MAX_JSON_BYTES + 1 }), /maxBytes/);
});

test('accepts the exact normative 1 MiB boundary and rejects one byte over', () => {
  const exact = utf8('"' + 'a'.repeat(AGG_CHECKPOINT_V2_MAX_JSON_BYTES - 2) + '"');
  assert.equal(exact.byteLength, AGG_CHECKPOINT_V2_MAX_JSON_BYTES);
  const parsed = parseAggCheckpointV2Json(exact);
  assert.equal(parsed.length, AGG_CHECKPOINT_V2_MAX_JSON_BYTES - 2);
  assert.equal(Buffer.byteLength(canonicalizeAggCheckpointV2Jcs(parsed), 'utf8'), AGG_CHECKPOINT_V2_MAX_JSON_BYTES);
  assert.throws(() => parseAggCheckpointV2Json(Buffer.concat([exact, Buffer.from(' ')])), /exceeds the 1048576-byte limit/);
  assert.throws(() => canonicalizeAggCheckpointV2Jcs(parsed + 'a'), /canonical output exceeds 1048576 bytes/);
});

test('enforces the normative maximum depth with root at depth zero', () => {
  const atLimit = '['.repeat(256) + '0' + ']'.repeat(256);
  const beyondLimit = '['.repeat(257) + '0' + ']'.repeat(257);
  assert.doesNotThrow(() => parseAggCheckpointV2Json(utf8(atLimit)));
  assert.throws(() => parseAggCheckpointV2Json(utf8(beyondLimit)), /maximum nesting depth/);
  let value = 0;
  for (let index = 0; index < 256; index++) value = [value];
  assert.doesNotThrow(() => canonicalizeAggCheckpointV2Jcs(value));
  assert.throws(() => canonicalizeAggCheckpointV2Jcs([value]), /maximum nesting depth/);
});

test('enforces the normative JSON value-node budget for materialized values', () => {
  const tooManyNodes = new Array(AGG_CHECKPOINT_V2_MAX_JSON_NODES).fill(null);
  assert.throws(() => canonicalizeAggCheckpointV2Jcs(tooManyNodes), /maximum JSON node count exceeded/);
});

test('canonicalizes object keys in UTF-16 code-unit order and preserves Unicode without normalization', () => {
  const parsed = parseAggCheckpointV2Json(utf8('{"דּ":6,"😀":5,"€":4,"ö":3,"1":2,"\\r":1,"é":"NFC","é":"NFD"}'));
  assert.equal(canonicalizeAggCheckpointV2Jcs(parsed), '{"\\r":1,"1":2,"é":"NFD","é":"NFC","ö":3,"€":4,"😀":5,"דּ":6}');
  const protoKey = parseAggCheckpointV2Json(utf8('{"__proto__":{"safe":true}}'));
  assert.equal(canonicalizeAggCheckpointV2Jcs(protoKey), '{"__proto__":{"safe":true}}');
});

test('uses ECMAScript number serialization for the constrained I-JSON number profile', () => {
  const parsed = parseAggCheckpointV2Json(utf8('{"values":[333333333.33333329,4.50,2e-3,1e-7,9007199254740991]}'));
  assert.equal(canonicalizeAggCheckpointV2Jcs(parsed), '{"values":[333333333.3333333,4.5,0.002,1e-7,9007199254740991]}');
  assert.equal(canonicalizeAggCheckpointV2JcsBytes(parsed).toString('utf8'), canonicalizeAggCheckpointV2Jcs(parsed));
});

test('preserves null versus omitted members, empty values and RFC 8785 string escaping', () => {
  const raw = String.raw`{"control":"\\u000f\\n","quote":"\\\"\\\\","slash":"/","empty_string":"","empty_array":[],"empty_object":{},"null_value":null}`;
  const parsed = parseAggCheckpointV2Json(utf8(raw));
  assert.equal(canonicalizeAggCheckpointV2Jcs(parsed), String.raw`{"control":"\\u000f\\n","empty_array":[],"empty_object":{},"empty_string":"","null_value":null,"quote":"\\\"\\\\","slash":"/"}`);
  assert.notEqual(canonicalizeAggCheckpointV2Jcs({}), canonicalizeAggCheckpointV2Jcs({ value: null }));
  assert.equal(canonicalizeAggCheckpointV2Jcs({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
    '{"max":9007199254740991,"min":-9007199254740991}');
});

test('rejects non-JSON values, cycles, accessors, sparse arrays and unsafe numbers', () => {
  const cycle = {}; cycle.self = cycle;
  const accessor = {}; Object.defineProperty(accessor, 'secret', { enumerable: true, get() { return 'x'; } });
  const hidden = {}; Object.defineProperty(hidden, 'secret', { enumerable: false, value: 'x' });
  const sparse = []; sparse.length = 1;
  for (const value of [NaN, Infinity, -0, Number.MAX_SAFE_INTEGER + 1, cycle, accessor, hidden, sparse, new Date()]) {
    assert.throws(() => canonicalizeAggCheckpointV2Jcs(value));
  }
  assert.throws(() => canonicalizeAggCheckpointV2Jcs({ value: '\ud800' }), /unpaired high surrogate/);
});

test('domain-separated digests are stable and differ by domain and component version', () => {
  const input = { domain: 'anti_replay_state', version: 1, payload: { nonces: ['n1', 'n2'], high_water: 4 } };
  const digest = computeAggCheckpointV2DomainDigest(input);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, computeAggCheckpointV2DomainDigest(input));
  assert.notEqual(digest, computeAggCheckpointV2DomainDigest({ ...input, domain: 'execution_authorization_state' }));
  assert.notEqual(digest, computeAggCheckpointV2DomainDigest({ ...input, version: 2 }));
  assert.equal(digest, computeAggCheckpointV2DomainDigest({ ...input, payload: { high_water: 4, nonces: ['n1', 'n2'] } }),
    'object member insertion order must not affect the canonical digest');
  assert.equal(AGG_CHECKPOINT_V2_PROTOCOL_ID, 'runalith.agg.external-checkpoint');
  assert.equal(AGG_CHECKPOINT_V2_PROTOCOL_VERSION, 2);
});

test('matches checked-in cross-language canonicalization and digest vectors', () => {
  assert.equal(vectors.protocol_id, AGG_CHECKPOINT_V2_PROTOCOL_ID);
  assert.equal(vectors.protocol_version, AGG_CHECKPOINT_V2_PROTOCOL_VERSION);
  assert.deepEqual(vectors.profile, {
    max_raw_json_bytes: AGG_CHECKPOINT_V2_MAX_JSON_BYTES,
    max_canonical_output_bytes: AGG_CHECKPOINT_V2_MAX_JSON_BYTES,
    max_nesting_depth: 256,
    max_json_value_nodes: AGG_CHECKPOINT_V2_MAX_JSON_NODES,
    integer_valued_numbers: 'safe-integers-only',
    negative_zero: 'reject',
    unicode: 'valid-utf8-and-well-formed-scalars',
    duplicate_decoded_object_keys: 'reject'
  });
  for (const vector of vectors.canonicalization_vectors) {
    const parsed = parseAggCheckpointV2Json(utf8(vector.input_utf8), { label: vector.name });
    assert.equal(canonicalizeAggCheckpointV2Jcs(parsed), vector.canonical_utf8, vector.name);
  }
  for (const vector of vectors.digest_vectors) {
    const payload = parseAggCheckpointV2Json(utf8(vector.payload_utf8), { label: vector.name });
    const envelope = createAggCheckpointV2DigestEnvelope({ domain: vector.domain, version: vector.component_version, payload });
    assert.equal(canonicalizeAggCheckpointV2Jcs(envelope), vector.canonical_envelope_utf8, vector.name);
    assert.equal(computeAggCheckpointV2DomainDigest({ domain: vector.domain, version: vector.component_version, payload }), vector.sha256, vector.name);
  }
});

test('matches shared strict-parse acceptance and rejection vectors', () => {
  for (const vector of vectors.strict_parse_vectors) {
    const raw = vector.input_hex ? Buffer.from(vector.input_hex, 'hex') : utf8(vector.input_utf8);
    if (vector.expected === 'accept') {
      const parsed = parseAggCheckpointV2Json(raw, { label: vector.name });
      assert.equal(canonicalizeAggCheckpointV2Jcs(parsed), vector.canonical_utf8, vector.name);
    } else {
      assert.throws(() => parseAggCheckpointV2Json(raw, { label: vector.name }),
        new RegExp(vector.error, 'i'), vector.name);
    }
  }
});

test('matches shared generated raw, depth, canonical-output and node-budget boundaries', () => {
  for (const vector of vectors.generated_boundary_vectors) {
    if (vector.operation === 'parse') {
      const raw = generateBoundaryRaw(vector);
      if (vector.expected === 'reject') {
        assert.throws(() => parseAggCheckpointV2Json(raw, { label: vector.name }),
          new RegExp(vector.error, 'i'), vector.name);
      } else {
        const parsed = parseAggCheckpointV2Json(raw, { label: vector.name });
        const canonical = canonicalizeAggCheckpointV2Jcs(parsed);
        assert.equal(Buffer.byteLength(canonical, 'utf8'), vector.canonical_bytes, vector.name);
      }
      continue;
    }

    const value = generateBoundaryValue(vector);
    if (vector.expected === 'accept') {
      const canonical = canonicalizeAggCheckpointV2Jcs(value);
      assert.equal(Buffer.byteLength(canonical, 'utf8'), vector.canonical_bytes, vector.name);
    } else {
      assert.throws(() => canonicalizeAggCheckpointV2Jcs(value), new RegExp(vector.error, 'i'), vector.name);
    }
  }
});
