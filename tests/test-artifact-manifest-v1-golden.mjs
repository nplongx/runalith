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
  'artifact-manifest-v1-golden.json',
);
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));

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

function canonicalArtifactRef(artifact) {
  return `{"contract_version":${quote(artifact.contract_version)}`
    + `,"artifact_id":${quote(artifact.artifact_id)}`
    + `,"sha256":${quote(artifact.sha256)}`
    + `,"byte_len":${artifact.byte_len}`
    + `,"media_type":${quote(artifact.media_type)}`
    + `,"content_schema_id":${artifact.content_schema_id === null ? 'null' : quote(artifact.content_schema_id)}`
    + `,"content_schema_version":${artifact.content_schema_version === null ? 'null' : quote(artifact.content_schema_version)}`
    + `,"source":${canonicalSource(artifact.source)}}`;
}

function canonicalLineage(lineage) {
  const parents = lineage.parent_artifacts.map(canonicalArtifactRef).join(',');
  return `{"contract_version":${quote(lineage.contract_version)}`
    + `,"producer_id":${quote(lineage.producer_id)}`
    + `,"workflow_id":${quote(lineage.workflow_id)}`
    + `,"task_id":${quote(lineage.task_id)}`
    + `,"attempt":${lineage.attempt}`
    + `,"correlation_id":${quote(lineage.correlation_id)}`
    + `,"created_at":${quote(lineage.created_at)}`
    + `,"parent_artifacts":[${parents}]}`;
}

function canonicalManifest(manifest) {
  const artifacts = manifest.artifacts.map(canonicalArtifactRef).join(',');
  return `{"contract_version":${quote(manifest.contract_version)}`
    + `,"created_at":${quote(manifest.created_at)}`
    + `,"artifacts":[${artifacts}]`
    + `,"lineage":${canonicalLineage(manifest.lineage)}}`;
}

const artifactBytes = Buffer.from(fixture.artifact_bytes_utf8, 'utf8');
assert.equal(sha256(artifactBytes), fixture.artifact_sha256, 'artifact byte digest');
assert.equal(
  artifactBytes.length,
  fixture.manifest.artifacts[0].byte_len,
  'artifact byte length',
);

const canonical = canonicalManifest(fixture.manifest);
assert.equal(canonical, fixture.canonical_utf8, 'Node canonical serializer matches fixture bytes');
assert.equal(
  sha256(Buffer.from(canonical, 'utf8')),
  fixture.canonical_sha256,
  'manifest digest covers exact canonical UTF-8 bytes',
);
assert.deepEqual(JSON.parse(canonical), fixture.manifest, 'canonical bytes preserve the DTO value');

console.log('ARTIFACT MANIFEST V1 GOLDEN PASS');
