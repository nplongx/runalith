#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseStrictJson } from '../src/runtime/strict-json.js';
import { readStableRegularFile, writeFileExclusiveAtomic } from '../src/runtime/exclusive-file.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2);
const values = new Map();
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--help') {
    console.log('Usage: node scripts/check-agg-phase3-source-drift.mjs --pack PACK_DIR --output DERIVED_NEW_RECEIPT.json\n\nChecks the immutable pack manifest and source snapshot against the current repository. The receipt is self-generated integrity evidence, not a trusted signature or release approval.');
    process.exit(0);
  }
  if (!['--pack', '--output'].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
  if (values.has(arg)) throw new Error(`Duplicate argument: ${arg}`);
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
  values.set(arg, args[++index]);
}
for (const key of ['--pack', '--output']) if (!values.has(key)) throw new Error(`Required argument missing: ${key}`);
const pack = path.resolve(values.get('--pack'));
const output = path.resolve(values.get('--output'));
if (!pack.startsWith(`${path.join(repoRoot, 'artifacts')}${path.sep}`) || fs.realpathSync(pack) !== pack || fs.lstatSync(pack).isSymbolicLink()) {
  throw new Error('Pack must be a canonical directory beneath repository artifacts/');
}
if (output !== `${pack}-final-source-drift-check.json`) throw new Error('Output must use the exact derived <pack>-final-source-drift-check.json path');
const outputParent = path.dirname(output);
const outputParentStat = fs.lstatSync(outputParent);
if (!outputParentStat.isDirectory() || outputParentStat.isSymbolicLink() || fs.realpathSync(outputParent) !== outputParent || fs.existsSync(output)) {
  throw new Error('Receipt output must be a new file in an existing canonical non-symlink directory');
}
const manifestPath = path.join(pack, 'SHA256SUMS.txt');
const manifestBytes = readStableRegularFile(manifestPath, { maxBytes: 16 * 1024 * 1024, label: 'Phase 3 evidence pack manifest' });
const manifestSha256 = hash(manifestBytes);
const manifestEntries = [];
const listedPaths = new Set();
const violations = [];
for (const [index, line] of manifestBytes.toString('utf8').trimEnd().split('\n').entries()) {
  const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
  if (!match) { violations.push({ path: null, reason: `malformed_manifest_line_${index + 1}` }); continue; }
  const relative = match[2];
  if (path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').includes('..') || relative.startsWith('/')) {
    violations.push({ path: relative, reason: 'unsafe_manifest_path' }); continue;
  }
  if (listedPaths.has(relative)) { violations.push({ path: relative, reason: 'duplicate_manifest_path' }); continue; }
  listedPaths.add(relative);
  const full = path.resolve(pack, relative);
  if (!full.startsWith(`${pack}${path.sep}`)) { violations.push({ path: relative, reason: 'manifest_path_escapes_pack' }); continue; }
  try {
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(full) !== full) { violations.push({ path: relative, reason: 'nonregular_or_symlink' }); continue; }
    const bytes = readStableRegularFile(full, { maxBytes: 64 * 1024 * 1024, label: `Pack entry ${relative}` });
    const observed = hash(bytes);
    if (observed !== match[1]) violations.push({ path: relative, reason: 'checksum_mismatch', expected: match[1], observed });
    manifestEntries.push({ path: relative, expectedSha256: match[1], observedSha256: observed, sizeBytes: bytes.length });
  } catch (error) { violations.push({ path: relative, reason: 'missing_or_unreadable', detail: error.message }); }
}
const actualPaths = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) { violations.push({ path: path.relative(pack, full), reason: 'symlink_in_pack' }); continue; }
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) {
      const relative = path.relative(pack, full).split(path.sep).join('/');
      if (relative !== 'SHA256SUMS.txt') actualPaths.push(relative);
    } else violations.push({ path: path.relative(pack, full), reason: 'special_file_in_pack' });
  }
}
walk(pack);
for (const relative of actualPaths) if (!listedPaths.has(relative)) violations.push({ path: relative, reason: 'unlisted_payload_after_manifest' });
for (const relative of listedPaths) if (!actualPaths.includes(relative)) violations.push({ path: relative, reason: 'manifest_entry_not_in_inventory' });

let snapshotIdentity = null;
const sourceDrift = [];
try {
  const identityPath = path.join(pack, 'source-snapshot-identity.json');
  snapshotIdentity = parseStrictJson(readStableRegularFile(identityPath, { maxBytes: 16 * 1024 * 1024, label: 'Source snapshot identity' }), 'Phase 3 source snapshot identity');
  if (snapshotIdentity.schemaVersion !== 1 || !Array.isArray(snapshotIdentity.files)) throw new Error('Source snapshot identity schema is invalid');
  for (const item of snapshotIdentity.files) {
    if (!item || typeof item.repositoryPath !== 'string' || typeof item.snapshotPath !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) {
      sourceDrift.push({ path: item?.repositoryPath ?? null, status: 'INVALID_SNAPSHOT_ENTRY' }); continue;
    }
    const snapshotPath = path.resolve(pack, item.snapshotPath);
    if (!snapshotPath.startsWith(`${pack}${path.sep}`)) { sourceDrift.push({ path: item.repositoryPath, status: 'UNSAFE_SNAPSHOT_PATH' }); continue; }
    try {
      const snapshotStat = fs.lstatSync(snapshotPath);
      const snapshotSha256 = snapshotStat.isFile() && !snapshotStat.isSymbolicLink() ? hash(readStableRegularFile(snapshotPath, { maxBytes: 64 * 1024 * 1024, label: item.snapshotPath })) : null;
      if (snapshotSha256 !== item.sha256) { sourceDrift.push({ path: item.repositoryPath, status: 'PACK_SOURCE_SNAPSHOT_HASH_MISMATCH', expected: item.sha256, observed: snapshotSha256 }); continue; }
      const currentPath = path.resolve(repoRoot, item.repositoryPath);
      if (!currentPath.startsWith(`${repoRoot}${path.sep}`)) { sourceDrift.push({ path: item.repositoryPath, status: 'UNSAFE_REPOSITORY_PATH' }); continue; }
      const currentStat = fs.lstatSync(currentPath);
      const currentSha256 = currentStat.isFile() && !currentStat.isSymbolicLink() ? hash(readStableRegularFile(currentPath, { maxBytes: 64 * 1024 * 1024, label: item.repositoryPath })) : null;
      sourceDrift.push({ path: item.repositoryPath, status: currentSha256 === item.sha256 ? 'MATCH' : currentSha256 === null ? 'SOURCE_MISSING_OR_NONREGULAR' : 'SOURCE_CHANGED', expected: item.sha256, observed: currentSha256 });
    } catch (error) { sourceDrift.push({ path: item.repositoryPath, status: 'SOURCE_READ_FAILED', detail: error.message }); }
  }
} catch (error) {
  violations.push({ path: 'source-snapshot-identity.json', reason: 'snapshot_identity_invalid', detail: error.message });
}
const mismatches = sourceDrift.filter(item => item.status !== 'MATCH');
const status = violations.length === 0 && mismatches.length === 0 ? 'PASS_SOURCE_SNAPSHOT_MATCH' : 'SOURCE_DRIFT_OR_INTEGRITY_FAILURE';
const report = {
  schemaVersion: 1, kind: 'agg_phase3_final_source_drift_check',
  pack: path.relative(repoRoot, pack), manifestSha256, manifestEntryCount: manifestEntries.length,
  inventoryCount: actualPaths.length, inventoryAndManifestIntegrity: violations.length === 0 ? 'PASS' : 'FAIL',
  sourceSnapshotCount: sourceDrift.length, sourceDriftCount: mismatches.length,
  sourceSnapshotStatus: status, status,
  violations, sourceDrift,
  evidenceClass: 'SELF_GENERATED_INTEGRITY_RECEIPT_NOT_A_TRUST_ANCHOR',
  acceptance: 'PARTIAL_NOT_ACCEPTED', readiness: 'BLOCKED', executionGate: 'CLOSED'
};
writeFileExclusiveAtomic(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ output, pack: report.pack, manifestSha256, status,
  manifestEntryCount: report.manifestEntryCount, sourceDriftCount: report.sourceDriftCount,
  executionGate: report.executionGate }, null, 2));
if (status !== 'PASS_SOURCE_SNAPSHOT_MATCH') process.exitCode = 2;
