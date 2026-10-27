import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseStrictJson } from '../../src/runtime/strict-json.js';
import { serializePluginPackageMetadata } from '../plugin-package-metadata.mjs';
import { isSafePortableArchivePath } from '../../benchmarks/plugin-workflow-benchmark/phase2-zip-entry-type-safety.mjs';

export const PHASE2_MANIFEST_CONTRACT = 'runalith-phase2-authoritative-manifest/v1';
export const PHASE2_BUILDER_RECEIPT_CONTRACT = 'runalith-phase2-builder-receipt/v1';
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

function fail(code, message) { const error = new Error(`${code}: ${message}`); error.code = code; throw error; }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('PHASE2_CUSTODY_SCHEMA_INVALID', 'canonical signed objects cannot contain non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!isRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail('PHASE2_CUSTODY_SCHEMA_INVALID', 'signed objects must contain plain JSON values');
  }
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function exactKeys(value, keys, label) {
  if (!isRecord(value) || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    fail('PHASE2_CUSTODY_SCHEMA_INVALID', `${label} must contain exactly ${[...keys].sort().join(', ')}`);
  }
}
function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    fail('PHASE2_CUSTODY_TIMESTAMP_INVALID', `${label} must be canonical UTC ISO-8601`);
  }
  return Date.parse(value);
}
function fingerprint(pem) {
  let key;
  try { key = createPublicKey(pem); } catch { fail('PHASE2_CUSTODY_KEY_INVALID', 'public key is not parseable'); }
  if (key.asymmetricKeyType !== 'ed25519') fail('PHASE2_CUSTODY_KEY_INVALID', 'custody evidence requires Ed25519 public keys');
  return sha256(key.export({ type: 'spki', format: 'der' }));
}
function verifySignedRecord(record, keyPem, label) {
  if (!isRecord(record) || typeof record.signature_base64 !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.signature_base64)) {
    fail('PHASE2_CUSTODY_SIGNATURE_INVALID', `${label} signature encoding is invalid`);
  }
  const signature = Buffer.from(record.signature_base64, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== record.signature_base64) {
    fail('PHASE2_CUSTODY_SIGNATURE_INVALID', `${label} signature must be canonical Ed25519 base64`);
  }
  const { signature_base64: ignored, ...payload } = record;
  let valid = false;
  try { valid = verifySignature(null, Buffer.from(canonical(payload)), createPublicKey(keyPem), signature); } catch {}
  if (!valid) fail('PHASE2_CUSTODY_SIGNATURE_INVALID', `${label} signature does not verify against the supplied key`);
  return payload;
}
function readRegular(file, label, maxBytes) {
  const absolute = path.resolve(file);
  const before = fs.lstatSync(absolute, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || fs.realpathSync(absolute) !== absolute || before.size < 1n || before.size > BigInt(maxBytes)) {
    fail('PHASE2_CUSTODY_INPUT_UNSAFE', `${label} must be a canonical regular non-symlink file within size bounds`);
  }
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail('PHASE2_CUSTODY_INPUT_RACE', `${label} changed before descriptor read`);
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > maxBytes) fail('PHASE2_CUSTODY_INPUT_UNSAFE', `${label} exceeds size bounds`);
      chunks.push(chunk.subarray(0, count));
    }
    const bytes = Buffer.concat(chunks, total);
    const after = fs.fstatSync(fd, { bigint: true });
    const pathAfter = fs.lstatSync(absolute, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs ||
        after.ctimeNs !== opened.ctimeNs || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino ||
        pathAfter.size !== opened.size || pathAfter.mtimeNs !== opened.mtimeNs || pathAfter.ctimeNs !== opened.ctimeNs ||
        fs.realpathSync(absolute) !== absolute || bytes.length !== Number(after.size)) fail('PHASE2_CUSTODY_INPUT_RACE', `${label} changed during read`);
    return bytes;
  } finally { fs.closeSync(fd); }
}
function git(root, args) {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }); }
  catch { fail('PHASE2_CUSTODY_SOURCE_UNAVAILABLE', `cannot resolve source snapshot using git ${args.join(' ')}`); }
}
function parseEvidence(bytes, label) {
  try { return parseStrictJson(bytes, label, { maxBytes: 8 * 1024 * 1024 }); }
  catch (error) { fail('PHASE2_CUSTODY_SCHEMA_INVALID', `${label} must be duplicate-free strict JSON: ${String(error?.message || error)}`); }
}

/**
 * Verify custody evidence provided by owners. Cryptographic verification is
 * intentionally separate from trust-root provisioning authentication: this
 * function never grants production authority based on caller-supplied keys.
 */
export function verifyPhase2CustodyEvidence({ repositoryRoot, candidatePath, manifestPath, receiptPath,
  authorityPublicKeyPem, builderPublicKeyPem, expectedAuthorityKeySha256, expectedBuilderKeySha256,
  expectedAuthorityId, expectedBuilderIdentity, expectedRepository, now = Date.now() } = {}) {
  if (typeof repositoryRoot !== 'string' || !path.isAbsolute(repositoryRoot) || typeof expectedRepository !== 'string' ||
      !/^https:\/\//.test(expectedRepository) || !Number.isSafeInteger(now)) fail('PHASE2_CUSTODY_INPUT_INVALID', 'repository root, canonical repository URI and verifier clock are required');
  const authorityFingerprint = fingerprint(authorityPublicKeyPem);
  const builderFingerprint = fingerprint(builderPublicKeyPem);
  if (!SHA256.test(expectedAuthorityKeySha256 || '') || authorityFingerprint !== expectedAuthorityKeySha256 ||
      !SHA256.test(expectedBuilderKeySha256 || '') || builderFingerprint !== expectedBuilderKeySha256) {
    fail('PHASE2_CUSTODY_KEY_PIN_MISMATCH', 'supplied public keys do not match the separately supplied expected fingerprints');
  }
  if (authorityFingerprint === builderFingerprint) fail('PHASE2_CUSTODY_TRUST_ROOT_COLLISION', 'manifest authority and builder must use disjoint public-key roots');

  const manifestBytes = readRegular(manifestPath, 'authoritative path manifest', 1024 * 1024);
  const receiptBytes = readRegular(receiptPath, 'authenticated builder receipt', 1024 * 1024);
  const candidateBytes = readRegular(candidatePath, 'candidate archive', 512 * 1024 * 1024);
  const manifest = parseEvidence(manifestBytes, 'authoritative path manifest');
  const receipt = parseEvidence(receiptBytes, 'builder receipt');
  exactKeys(manifest, ['schema_version', 'contract', 'authority_id', 'repository', 'source_commit', 'source_tree_oid', 'issued_at', 'paths', 'signature_base64'], 'manifest');
  exactKeys(receipt, ['schema_version', 'contract', 'builder_identity', 'repository', 'source_commit', 'source_tree_oid', 'source_snapshot_sha256',
    'candidate_sha256', 'candidate_size_bytes', 'manifest_sha256', 'built_at', 'invocation_id', 'signature_base64'], 'receipt');
  const signedManifest = verifySignedRecord(manifest, authorityPublicKeyPem, 'manifest');
  const signedReceipt = verifySignedRecord(receipt, builderPublicKeyPem, 'builder receipt');
  if (signedManifest.schema_version !== 1 || signedManifest.contract !== PHASE2_MANIFEST_CONTRACT ||
      signedManifest.authority_id !== expectedAuthorityId || signedManifest.repository !== expectedRepository ||
      !GIT_OID.test(signedManifest.source_commit || '') || !GIT_OID.test(signedManifest.source_tree_oid || '') ||
      !Array.isArray(signedManifest.paths) || signedManifest.paths.length !== 71 ||
      signedManifest.paths.some(item => typeof item !== 'string' || !isSafePortableArchivePath(item) || item.endsWith('/')) ||
      new Set(signedManifest.paths).size !== 71 || signedManifest.paths.some((item, index) => index > 0 && signedManifest.paths[index - 1] >= item)) {
    fail('PHASE2_CUSTODY_MANIFEST_INVALID', 'signed manifest must bind the expected authority/repository/source and exactly 71 sorted unique safe file paths');
  }
  const issuedAt = timestamp(signedManifest.issued_at, 'manifest.issued_at');
  if (issuedAt > now + 5_000) fail('PHASE2_CUSTODY_MANIFEST_FUTURE_DATED', 'manifest issue time is in the future');
  if (signedReceipt.schema_version !== 1 || signedReceipt.contract !== PHASE2_BUILDER_RECEIPT_CONTRACT ||
      signedReceipt.builder_identity !== expectedBuilderIdentity || signedReceipt.repository !== expectedRepository ||
      signedReceipt.source_commit !== signedManifest.source_commit || signedReceipt.source_tree_oid !== signedManifest.source_tree_oid ||
      signedReceipt.manifest_sha256 !== sha256(manifestBytes) || signedReceipt.candidate_sha256 !== sha256(candidateBytes) ||
      signedReceipt.candidate_size_bytes !== candidateBytes.length || !SHA256.test(signedReceipt.source_snapshot_sha256 || '') ||
      typeof signedReceipt.invocation_id !== 'string' || !signedReceipt.invocation_id.trim() || signedReceipt.invocation_id.length > 300) {
    fail('PHASE2_CUSTODY_RECEIPT_BINDING_MISMATCH', 'builder receipt does not bind exact manifest, candidate bytes, source snapshot and expected builder/repository');
  }
  const builtAt = timestamp(signedReceipt.built_at, 'receipt.built_at');
  if (builtAt > now + 5_000 || builtAt < issuedAt) fail('PHASE2_CUSTODY_RECEIPT_TIME_INVALID', 'builder receipt time is future-dated or predates the manifest');

  const root = fs.realpathSync(repositoryRoot);
  const resolvedCommit = git(root, ['rev-parse', '--verify', `${signedManifest.source_commit}^{commit}`]).toString('utf8').trim();
  const actualTree = git(root, ['rev-parse', `${resolvedCommit}^{tree}`]).toString('utf8').trim();
  if (resolvedCommit !== signedManifest.source_commit || actualTree !== signedManifest.source_tree_oid) {
    fail('PHASE2_CUSTODY_SOURCE_SNAPSHOT_MISMATCH', 'signed source commit/tree does not resolve exactly in the inspected repository');
  }
  const actualSnapshotSha256 = sha256(git(root, ['archive', '--format=tar', resolvedCommit]));
  if (actualSnapshotSha256 !== signedReceipt.source_snapshot_sha256) {
    fail('PHASE2_CUSTODY_SOURCE_SNAPSHOT_MISMATCH', 'builder receipt source snapshot digest does not match a fresh deterministic git archive of the pinned commit');
  }
  // All ZIP inspection operates on the exact candidate bytes already hashed,
  // never on the caller-controlled path reopened after the initial read.
  const privateDir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'phase2-custody-'));
  const privateCandidate = path.join(privateDir, 'candidate.mcpb');
  try {
    fs.writeFileSync(privateCandidate, candidateBytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    fs.rmSync(privateDir, { recursive: true, force: true });
    fail('PHASE2_CUSTODY_INPUT_UNSAFE', `could not create a private immutable verification copy: ${String(error?.message || error)}`);
  }
  let listing;
  try { listing = execFileSync('unzip', ['-Z1', privateCandidate], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split(/\r?\n/).filter(Boolean); }
  catch { fs.rmSync(privateDir, { recursive: true, force: true }); fail('PHASE2_CUSTODY_ARCHIVE_INVALID', 'candidate bytes are not a readable ZIP archive'); }
  let typeListing;
  try { typeListing = execFileSync('zipinfo', ['-l', privateCandidate], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }); }
  catch { fs.rmSync(privateDir, { recursive: true, force: true }); fail('PHASE2_CUSTODY_ARCHIVE_INVALID', 'cannot inspect candidate ZIP entry types'); }
  const entryTypes = typeListing.split(/\r?\n/).filter(line => /^[\-dlpcbs][rwxStTs-]{9}\s/.test(line)).map(line => line[0]);
  if (entryTypes.length !== listing.length || entryTypes.some(type => type !== '-')) {
    fs.rmSync(privateDir, { recursive: true, force: true });
    fail('PHASE2_CUSTODY_ARCHIVE_ENTRY_TYPE_INVALID', 'candidate archive must contain only regular files, without symlinks, directories or special entries');
  }
  if (listing.length !== 71 || new Set(listing).size !== listing.length || listing.some(item => !isSafePortableArchivePath(item) || item.endsWith('/')) ||
      canonical([...listing].sort()) !== canonical(signedManifest.paths)) {
    fs.rmSync(privateDir, { recursive: true, force: true });
    fail('PHASE2_CUSTODY_ARCHIVE_INVENTORY_MISMATCH', 'candidate archive file paths must exactly equal the signed authoritative 71-path manifest');
  }
  // The receipt's snapshot digest is a builder claim; the verifier also checks
  // every archived entry against the pinned Git tree. package.json is a known
  // generated projection, so compare it to the canonical projection of the
  // source package metadata rather than pretending it is a source blob.
  for (const archivePath of listing) {
    const sourcePath = archivePath === 'manifest.json' ? 'plugin/manifest.json' : archivePath;
    const archiveEntry = execFileSync('unzip', ['-p', privateCandidate, archivePath], { maxBuffer: 64 * 1024 * 1024 });
    let expected;
    if (archivePath === 'package.json') {
      const sourcePackage = parseEvidence(git(root, ['show', `${resolvedCommit}:package.json`]), 'source package metadata');
      expected = Buffer.from(serializePluginPackageMetadata(sourcePackage));
    } else {
      expected = git(root, ['show', `${resolvedCommit}:${sourcePath}`]);
    }
    if (!archiveEntry.equals(expected)) {
      fs.rmSync(privateDir, { recursive: true, force: true });
      fail('PHASE2_CUSTODY_SOURCE_ENTRY_MISMATCH', `archive entry ${archivePath} does not byte-match the pinned source snapshot`);
    }
  }
  fs.rmSync(privateDir, { recursive: true, force: true });
  return {
    contract: 'runalith-phase2-custody-verification/v1', status: 'CRYPTOGRAPHIC_AND_SOURCE_BINDINGS_VERIFIED',
    candidateSha256: sha256(candidateBytes), candidateSizeBytes: candidateBytes.length,
    manifestSha256: sha256(manifestBytes), manifestPathCount: signedManifest.paths.length,
    authorityId: signedManifest.authority_id, authorityKeySha256: authorityFingerprint,
    builderIdentity: signedReceipt.builder_identity, builderKeySha256: builderFingerprint,
    sourceCommit: resolvedCommit, sourceTreeOid: actualTree, sourceSnapshotSha256: signedReceipt.source_snapshot_sha256,
    invocationId: signedReceipt.invocation_id, builtAt: signedReceipt.built_at,
    signatureVerification: { manifest: true, builderReceipt: true },
    trustRootProvisioningAuthenticated: false, builderIdentityIndependentlyAuthenticated: false,
    externalMonotonicCheckpointVerified: false, productionAuthorityEstablished: false,
    blockers: ['TRUST_ROOT_PROVISIONING_NOT_AUTHENTICATED', 'BUILDER_IDENTITY_PROVISIONING_NOT_AUTHENTICATED', 'EXTERNAL_MONOTONIC_CHECKPOINT_NOT_VERIFIED'],
    note: 'This verifies the submitted signatures and exact source/archive bindings. It does not authenticate who supplied the public-key pins or prove an independently controlled builder; retain the owner-issued pins and receipts through the host custody process.'
  };
}
