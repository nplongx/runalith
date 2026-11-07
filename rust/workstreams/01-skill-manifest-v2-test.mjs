#!/usr/bin/env node
/**
 * WS1 candidate fixture generator/checker for a portable skill-manifest digest.
 * This is contract evidence only; it does not change the production Node skill
 * importer or the current four-field SkillPinRefV1.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(HERE, '01-skill-manifest-v2.fixtures.json');
const PROFILE_ID = 'urn:runalith:skill-manifest:v2-jcs-utf8-nfc-bytewise';
const IMPORT_POLICY_ID = 'urn:runalith:skill-import:v2-text-tree-v1';
const MAX_FILES = 40;
const MAX_FILE_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 160 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

class ManifestError extends Error {}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assertWellFormedUtf16(value, errorCode) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new ManifestError(errorCode);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new ManifestError(errorCode);
    }
  }
}

function validatePath(value) {
  if (typeof value !== 'string' || value.length === 0) throw new ManifestError('path_empty');
  assertWellFormedUtf16(value, 'path_invalid_unicode');
  if (Buffer.from(value, 'utf8').toString('utf8') !== value) throw new ManifestError('path_invalid_unicode');
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw new ManifestError('path_absolute');
  if (value.includes('\\')) throw new ManifestError('path_backslash');
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new ManifestError('path_control_character');
  if (value.normalize('NFC') !== value) throw new ManifestError('path_not_nfc');
  const segments = value.split('/');
  if (segments.some(segment => segment.length === 0)) throw new ManifestError('path_empty_segment');
  if (segments.some(segment => segment === '.')) throw new ManifestError('path_dot_segment');
  if (segments.some(segment => segment === '..')) throw new ManifestError('path_parent_segment');
  return value;
}

function compileManifest(files, { caseSensitiveFilesystem = true } = {}) {
  if (!Array.isArray(files)) throw new ManifestError('files_not_array');
  if (files.length === 0 || files.length > MAX_FILES) throw new ManifestError('file_count_out_of_range');
  const seen = new Set();
  const filesystemKeys = new Set();
  let totalBytes = 0;
  const records = files.map(file => {
    if (!file || typeof file !== 'object' || typeof file.content_utf8 !== 'string') {
      throw new ManifestError('file_content_not_utf8_text');
    }
    const relativePath = validatePath(file.path);
    if (seen.has(relativePath)) throw new ManifestError('duplicate_path');
    seen.add(relativePath);
    if (!caseSensitiveFilesystem) {
      // On case-insensitive filesystems, keep logical identity case-sensitive
      // but conservatively restrict paths to ASCII and reject ASCII aliases.
      // Non-ASCII filesystems need a filesystem-specific alias verifier.
      if (!/^[\x00-\x7f]+$/.test(relativePath)) {
        throw new ManifestError('case_insensitive_filesystem_requires_ascii_path');
      }
      const filesystemKey = relativePath.toLowerCase();
      if (filesystemKeys.has(filesystemKey)) {
        throw new ManifestError('case_insensitive_path_collision');
      }
      filesystemKeys.add(filesystemKey);
    }
    assertWellFormedUtf16(file.content_utf8, 'file_content_invalid_unicode');
    const bytes = Buffer.from(file.content_utf8, 'utf8');
    if (bytes.includes(0)) throw new ManifestError('file_binary_nul');
    if (bytes.byteLength > MAX_FILE_BYTES) throw new ManifestError('file_size_exceeded');
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) throw new ManifestError('total_size_exceeded');
    return { path: relativePath, sha256: sha256(bytes), size_bytes: bytes.byteLength };
  });

  // This restricted record is byte-equivalent to JCS: its only object keys
  // are the fixed ASCII names path, sha256, size_bytes, already in UTF-16
  // lexical order; values are well-formed strings, lowercase hex and
  // non-negative safe integers. JSON.stringify's ECMAScript string/number
  // serialization therefore matches JCS for this schema. Array order is
  // explicitly unsigned UTF-8 path order. Rust parity still needs its own
  // independent JCS implementation and shared golden vectors.
  for (const record of records) {
    assert.deepEqual(Object.keys(record), ['path', 'sha256', 'size_bytes']);
    assert.match(record.sha256, SHA256);
    assert(Number.isSafeInteger(record.size_bytes) && record.size_bytes >= 0);
  }
  records.sort((left, right) => Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')));
  const canonicalJson = JSON.stringify(records);
  const canonicalBytes = Buffer.from(canonicalJson, 'utf8');
  return {
    records,
    canonical_json: canonicalJson,
    canonical_bytes: canonicalBytes.byteLength,
    bundle_sha256: sha256(canonicalBytes)
  };
}

const inputVectors = [
  {
    id: 'ascii-and-nfc-unicode',
    files: [
      { path: 'z-last.txt', content_utf8: 'last\n' },
      { path: '指南/步骤.txt', content_utf8: '步骤一\n' },
      { path: 'SKILL.md', content_utf8: '---\nname: sample-skill\ndescription: manifest fixture\n---\nUse fixture only.\n' },
      { path: 'references/éclair.md', content_utf8: 'café\n' },
      { path: 'A.md', content_utf8: 'uppercase path\n' },
      { path: 'a.md', content_utf8: 'lowercase path\n' }
    ]
  },
  {
    id: 'empty-content-and-multibyte-bytes',
    files: [
      { path: 'empty.txt', content_utf8: '' },
      { path: 'unicode/你好.txt', content_utf8: '你好 🌱\n' }
    ]
  }
];

const negativeCases = [
  { id: 'absolute-posix-path', path: '/tmp/skill.md', expected: 'path_absolute' },
  { id: 'absolute-drive-path', path: 'C:/skill.md', expected: 'path_absolute' },
  { id: 'empty-segment', path: 'a//b.md', expected: 'path_empty_segment' },
  { id: 'dot-segment', path: 'a/./b.md', expected: 'path_dot_segment' },
  { id: 'parent-segment', path: 'a/../b.md', expected: 'path_parent_segment' },
  { id: 'backslash', path: 'a\\b.md', expected: 'path_backslash' },
  { id: 'nul', path: 'a\u0000b.md', expected: 'path_control_character' },
  { id: 'non-nfc-decomposed-path', path: 'references/e\u0301.md', expected: 'path_not_nfc' },
  { id: 'control-character', path: 'a\u007fb.md', expected: 'path_control_character' },
  { id: 'duplicate-path', path: 'same.md', expected: 'duplicate_path' }
];

const negativeContentCases = [
  { id: 'unpaired-high-surrogate', content_utf8: String.fromCharCode(0xd800), expected: 'file_content_invalid_unicode' },
  { id: 'unpaired-low-surrogate', content_utf8: String.fromCharCode(0xdc00), expected: 'file_content_invalid_unicode' }
];

const negativeFilesystemCases = [
  {
    id: 'ascii-case-collision-on-insensitive-filesystem',
    files: [
      { path: 'A.md', content_utf8: 'upper' },
      { path: 'a.md', content_utf8: 'lower' }
    ],
    expected: 'case_insensitive_path_collision'
  },
  {
    id: 'unicode-path-on-insensitive-filesystem',
    files: [{ path: 'é.md', content_utf8: 'unicode' }],
    expected: 'case_insensitive_filesystem_requires_ascii_path'
  }
];

function buildFixture() {
  const vectors = inputVectors.map(vector => ({ ...vector, ...compileManifest(vector.files) }));
  return {
    fixture_set: 'WS1 portable skill manifest V2 candidate',
    status: 'DRAFT_NOT_RATIFIED',
    generated_by: 'rust/workstreams/01-skill-manifest-v2-test.mjs --write-fixture',
    profile: {
      profile_id: PROFILE_ID,
      file_record_fields_and_order: ['path', 'sha256', 'size_bytes'],
      file_digest: 'SHA-256 of exact UTF-8 file bytes',
      path_normalization: 'paths must already be Unicode NFC; reject rather than rewrite',
      path_order: 'unsigned lexicographic UTF-8 byte order; case-sensitive',
      manifest_serialization: 'RFC 8785 JCS canonical UTF-8 JSON array of exact file records; JSON.stringify is byte-equivalent for the restricted record types/ordered ASCII keys described in the W1 spec',
      bundle_digest: 'SHA-256 of exact canonical manifest UTF-8 bytes',
      limits: { max_files: MAX_FILES, max_file_bytes: MAX_FILE_BYTES, max_total_bytes: MAX_TOTAL_BYTES },
      scope_note: 'This profile hashes a supplied eligible-file set; importer file-selection/exclusion rules require a separately pinned version.'
    },
    importer_selection_policy: {
      policy_id: IMPORT_POLICY_ID,
      eligible_extensions: [
        '.md', '.mdx', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv', '.xml', '.html', '.css', '.svg',
        '.js', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.sh', '.sql', '.graphql'
      ],
      enumeration: 'recursive under one skill root, maximum depth 8; enumerate regular files only; do not follow symlinks; reject symlink entries in eligible paths',
      exclusions: 'skip any hidden path component (leading dot) and directories .git,node_modules,.venv,venv,__pycache__,dist,build,.next',
      root_entry: 'require exact root SKILL.md; metadata name must match the declared skill directory/name',
      content: 'reject malformed UTF-8, lone UTF-16 surrogates and NUL-containing eligible text files; never decode with replacement',
      bounds: { max_files_per_skill: MAX_FILES, max_file_bytes: MAX_FILE_BYTES, max_total_bytes_per_role: MAX_TOTAL_BYTES, max_skills_per_role: 8 },
      ordering: 'enumeration order is irrelevant; final manifest order is the bundle profile UTF-8 bytewise order',
      filesystem_case: 'logical path identity is case-sensitive; on case-insensitive filesystems require an alias check. This candidate conservatively supports only ASCII paths there and rejects ASCII case-fold collisions; non-ASCII requires a host/filesystem-specific alias verifier.',
      source_version: 'GitHub binds immutable resolved commit + skill subtree tree OIDs; local binds complete content snapshot. Mutable path/branch/tag is provenance/reference only, not immutable version.',
      status: 'DRAFT; separately versioned and included in any future skill plan pin'
    },
    skill_version_examples: {
      github: 'git:sha1:0123456789abcdef0123456789abcdef01234567:tree:89abcdef0123456789abcdef0123456789abcdef',
      local: 'local-content-snapshot:v1:sha256:<bundle_sha256>',
      rule: 'GitHub version binds resolved immutable commit and skill subtree tree OIDs. Local version binds a content-addressed complete snapshot; path is provenance only. Mutable branch/tag/path is not a version.'
    },
    vectors,
    negative_cases: negativeCases,
    negative_content_cases: negativeContentCases.map(({ id, expected }) => ({ id, expected })),
    negative_filesystem_cases: negativeFilesystemCases.map(({ id, expected }) => ({ id, expected }))
  };
}

function expectError(files, expected) {
  assert.throws(() => compileManifest(files), error => error instanceof ManifestError && error.message === expected);
}

function run() {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  assert.equal(fixture.status, 'DRAFT_NOT_RATIFIED');
  assert.equal(fixture.profile.profile_id, PROFILE_ID);
  assert.equal(fixture.vectors.length, inputVectors.length);

  for (let index = 0; index < inputVectors.length; index += 1) {
    const input = inputVectors[index];
    const expected = fixture.vectors[index];
    const actual = compileManifest(input.files);
    assert.equal(expected.id, input.id);
    assert.deepEqual(actual.records, expected.records, `${input.id}: manifest records`);
    assert.equal(actual.canonical_json, expected.canonical_json, `${input.id}: JCS bytes`);
    assert.equal(actual.canonical_bytes, expected.canonical_bytes, `${input.id}: byte length`);
    assert.equal(actual.bundle_sha256, expected.bundle_sha256, `${input.id}: digest`);
    const replay = compileManifest([...input.files].reverse());
    assert.equal(replay.bundle_sha256, actual.bundle_sha256, `${input.id}: source order independence`);
  }

  const goodFile = { path: 'valid.md', content_utf8: 'ok' };
  for (const item of negativeCases.filter(item => item.id !== 'duplicate-path')) {
    expectError([{ ...goodFile, path: item.path }], item.expected);
  }
  expectError([goodFile, { ...goodFile }], 'duplicate_path');
  for (const item of negativeContentCases) {
    expectError([{ path: 'valid.md', content_utf8: item.content_utf8 }], item.expected);
  }
  for (const item of negativeFilesystemCases) {
    assert.throws(
      () => compileManifest(item.files, { caseSensitiveFilesystem: false }),
      error => error instanceof ManifestError && error.message === item.expected,
      item.id
    );
  }
  expectError([{ path: 'valid.md', content_utf8: '\u0000' }], 'file_binary_nul');
  expectError([{ path: 'large.md', content_utf8: 'x'.repeat(MAX_FILE_BYTES + 1) }], 'file_size_exceeded');
  expectError(Array.from({ length: MAX_FILES + 1 }, (_, index) => ({ path: `f${index}.txt`, content_utf8: '' })), 'file_count_out_of_range');
  expectError(Array.from({ length: 6 }, (_, index) => ({ path: `f${index}.txt`, content_utf8: 'x'.repeat(30 * 1024) })), 'total_size_exceeded');

  console.log(`PASS ${fixture.vectors.length} positive manifest vectors (ASCII, NFC Unicode, case-sensitive names, byte length, replay order)`);
  console.log(`PASS ${negativeCases.length + negativeContentCases.length + negativeFilesystemCases.length + 4} negative manifest cases (paths, malformed UTF-16, filesystem aliasing, binary NUL, limits)`);
  console.log(`PROFILE ${PROFILE_ID}`);
  console.log('LIMIT: fixture/profile proposal only; no production importer, trust receipt, resolver or CompiledPlanV2 is implemented');
}

if (process.argv.includes('--write-fixture')) {
  fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(buildFixture(), null, 2)}\n`);
  console.log(`WROTE ${FIXTURE_PATH}`);
} else {
  run();
}
