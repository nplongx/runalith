import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(
  here,
  '..',
  'rust',
  'crates',
  'runalith-artifacts',
  'tests',
  'fixtures',
  'artifact-read-port-v1-golden.json',
);
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const MAX_METADATA_BYTES = 16 * 1024;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function quote(value) {
  return JSON.stringify(value);
}

function canonicalSource(source) {
  return `{"producer_id":${quote(source.producer_id)}`
    + `,"workflow_id":${quote(source.workflow_id)}`
    + `,"task_id":${quote(source.task_id)}`
    + `,"attempt":${source.attempt}`
    + `,"correlation_id":${quote(source.correlation_id)}`
    + `,"created_at":${quote(source.created_at)}}`;
}

function canonicalArtifact(artifact) {
  return `{"contract_version":${quote(artifact.contract_version)}`
    + `,"artifact_id":${quote(artifact.artifact_id)}`
    + `,"sha256":${quote(artifact.sha256)}`
    + `,"byte_len":${artifact.byte_len}`
    + `,"media_type":${quote(artifact.media_type)}`
    + `,"content_schema_id":${artifact.content_schema_id === null ? 'null' : quote(artifact.content_schema_id)}`
    + `,"content_schema_version":${artifact.content_schema_version === null ? 'null' : quote(artifact.content_schema_version)}`
    + `,"source":${canonicalSource(artifact.source)}}`;
}

function canonicalRequest(request) {
  return `{"contract_version":${quote(request.contract_version)}`
    + `,"request_id":${quote(request.request_id)}`
    + `,"correlation_id":${quote(request.correlation_id)}`
    + `,"artifact":${canonicalArtifact(request.artifact)}`
    + `}`;
}

function canonicalObservation(observation) {
  return `{"contract_version":${quote(observation.contract_version)}`
    + `,"request_id":${quote(observation.request_id)}`
    + `,"observation_id":${quote(observation.observation_id)}`
    + `,"source_service_id":${quote(observation.source_service_id)}`
    + `,"correlation_id":${quote(observation.correlation_id)}`
    + `,"artifact_id":${quote(observation.artifact_id)}`
    + `,"expected_sha256":${quote(observation.expected_sha256)}`
    + `,"expected_byte_len":${observation.expected_byte_len}`
    + `,"media_type":${quote(observation.media_type)}`
    + `,"observed_at":${quote(observation.observed_at)}`
    + `,"disposition":${quote(observation.disposition)}`
    + `,"observed_sha256":${observation.observed_sha256 === null ? 'null' : quote(observation.observed_sha256)}`
    + `,"observed_byte_len":${observation.observed_byte_len === null ? 'null' : observation.observed_byte_len}}`;
}

const payload = Buffer.from(fixture.payload_bytes_utf8, 'utf8');
assert.equal(payload.length, fixture.request.artifact.byte_len);
assert.equal(sha256(payload), fixture.payload_sha256);

const requestBytes = Buffer.from(canonicalRequest(fixture.request), 'utf8');
assert.equal(requestBytes.length <= MAX_METADATA_BYTES, true);
assert.equal(requestBytes.toString('utf8'), fixture.request_canonical_utf8);
assert.equal(sha256(requestBytes), fixture.request_sha256);

for (const [key, canonicalKey, digestKey] of [
  ['available_observation', 'available_observation_canonical_utf8', 'available_observation_sha256'],
  ['not_found_observation', 'not_found_observation_canonical_utf8', 'not_found_observation_sha256'],
]) {
  const observation = fixture[key];
  const bytes = Buffer.from(canonicalObservation(observation), 'utf8');
  assert.equal(bytes.length <= MAX_METADATA_BYTES, true);
  assert.equal(bytes.toString('utf8'), fixture[canonicalKey]);
  assert.equal(sha256(bytes), fixture[digestKey]);
  assert.equal(observation.source_service_id, 'execution.worker-reader');
  if (observation.disposition === 'AVAILABLE') {
    assert.equal(observation.observed_sha256, observation.expected_sha256);
    assert.equal(observation.observed_byte_len, observation.expected_byte_len);
  } else {
    assert.equal(observation.observed_sha256, null);
    assert.equal(observation.observed_byte_len, null);
  }
}

assert.deepEqual(Object.keys(fixture.request), [
  'contract_version', 'request_id', 'correlation_id', 'artifact',
]);
assert.equal(Object.hasOwn(fixture.request, 'source_service_id'), false,
  'authenticated caller identity is supplied out-of-band by the Execution host');
assert.equal(Object.hasOwn(fixture.request, 'observation_id'), false,
  'observation identity is allocated by the Execution host per read attempt');
assert.equal(fixture.not_found_observation.observation_id !== fixture.available_observation.observation_id, true,
  'each lookup attempt has a distinct observation identity for the same request');

console.log('ARTIFACT READ PORT V1 GOLDEN PASS');
