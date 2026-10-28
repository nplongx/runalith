#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { isSafePortableArchivePath, validateZipEntryTypes } from '../benchmarks/plugin-workflow-benchmark/phase2-zip-entry-type-safety.mjs';
import { assertAdaptiveGoalTrustDomainsDisjoint, adaptiveGoalTrustConfigurationStatus,
  inspectAdaptiveGoalTrustConfigurationHistory, loadAdaptiveGoalTrustConfiguration } from '../src/runtime/adaptive-goal-trust-configuration.js';
import { parseStrictJson } from '../src/runtime/strict-json.js';
import { canonicalExternalCheckpointPayload, verifyExternalTrustCheckpointResponse } from './lib/external-trust-checkpoint-contract.mjs';
import { verifyPhase2CustodyEvidence } from './lib/phase2-custody-evidence.mjs';
import { parseRunalithReleaseEvidenceJson, verifyRunalithReleaseEvidence } from './lib/runalith-release-trust-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_ROOT_DEFAULT = path.join(os.homedir(), '.config', 'chat-on-steroids');
const WORKFLOW_DB_DEFAULT = path.join(os.homedir(), '.chat-on-steroids', 'agent-orchestrator', 'workflow.db');
const PINNED_HISTORICAL_SERVER_SHA256 = 'aa2b8f45f5a98817aac019f1659ff91f0bfc22da68cdbef1d9ad1ae6ceee8cb8';
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2000;
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const MAX_PATH_BYTES = 1024;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const VERIFIED_RELEASE_EVIDENCE_RESULTS = new WeakSet();
const VERIFIED_PHASE2_CUSTODY_RESULTS = new WeakSet();
const HOST_POLICY_DIRECTORY = '/etc/runalith';
const HOST_RELEASE_POLICY_PATH = path.join(HOST_POLICY_DIRECTORY, 'release-policy.json');
const HOST_PHASE2_CUSTODY_POLICY_PATH = path.join(HOST_POLICY_DIRECTORY, 'phase2-custody-trust.json');
const HOST_EXTERNAL_CHECKPOINT_POLICY_PATH = path.join(HOST_POLICY_DIRECTORY, 'external-checkpoint-trust.json');
const HOST_EXTERNAL_CHECKPOINT_ADAPTER_PATH = '/usr/local/libexec/runalith/external-checkpoint-adapter';
const PHASE2_CUSTODY_POLICY_CONTRACT = 'runalith-phase2-host-custody-policy/v1';
const PHASE2_CUSTODY_EXPECTED_REPOSITORY = 'https://github.com/nplongx/runalith';
const RELEASE_POLICY_EXPECTED_REPOSITORY = 'https://github.com/nplongx/runalith';
const RELEASE_POLICY_EXPECTED_SUBJECT = 'runalith.mcpb';
const RELEASE_POLICY_EXPECTED_BUILD_TYPE = 'https://runalith.dev/build/mcpb/v1';
const RELEASE_POLICY_EXPECTED_ENVIRONMENT = 'production';
const EXTERNAL_CHECKPOINT_POLICY_CONTRACT = 'runalith-external-checkpoint-host-policy/v1';
const EXTERNAL_CHECKPOINT_OBSERVATION_CONTRACT = 'runalith-external-checkpoint-adapter-observation/v1';
const EXTERNAL_CHECKPOINT_COMMIT_CONTRACT = 'runalith-external-checkpoint-adapter-commit/v1';
const EXTERNAL_STORE_ATTESTATION_CONTRACT = 'runalith-external-monotonic-store-attestation/v1';
const EXTERNAL_STORE_CONTINUITY_EVIDENCE_CONTRACT = 'runalith-external-store-continuity-evidence/v1';
const EXTERNAL_CHECKPOINT_COMMIT_RECEIPT_CONTRACT = 'runalith-external-checkpoint-commit-receipt/v1';
const PHASE2_CUSTODY_POLICY_KEYS = ['schema_version', 'contract', 'policy_version', 'updated_at', 'updated_by',
  'change_reference', 'authority_id', 'builder_identity', 'repository', 'source_commit', 'source_tree_oid',
  'authority_key_id', 'authority_public_key_pem', 'authority_key_sha256', 'authority_key_not_before',
  'authority_key_not_after', 'authority_key_revoked_at', 'builder_key_id', 'builder_public_key_pem',
  'builder_key_sha256', 'builder_key_not_before', 'builder_key_not_after', 'builder_key_revoked_at'];
const EXTERNAL_CHECKPOINT_POLICY_KEYS = ['schema_version', 'contract', 'policy_version', 'updated_at', 'updated_by',
  'change_reference', 'authority_id', 'authority_key_id', 'authority_public_key_pem', 'authority_key_sha256', 'authority_key_not_before',
  'authority_key_not_after', 'authority_key_revoked_at', 'store_attestation_key_id', 'store_attestation_public_key_pem',
  'store_attestation_key_sha256', 'store_attestation_key_not_before', 'store_attestation_key_not_after',
  'store_attestation_key_revoked_at', 'adapter_path', 'adapter_sha256', 'external_store_id',
  'external_service_uri', 'max_store_attestation_age_seconds'];
const EXTERNAL_STORE_ATTESTATION_KEYS = ['schema_version', 'contract', 'authority_id', 'store_id', 'service_uri',
  'backend', 'independent_of_plugin_host', 'monotonicity_protection', 'restore_rollback_protection', 'issued_at',
  'valid_until', 'evidence_sha256', 'signature_base64'];
const EXTERNAL_CHECKPOINT_COMMIT_RECEIPT_KEYS = ['schema_version', 'contract', 'authority_id', 'request_nonce',
  'candidate_sha256', 'rollback_sha256', 'checkpoint_sequence', 'checkpoint_digest', 'previous_checkpoint_digest',
  'commit_status', 'committed_at', 'signature_base64'];
const VERIFIED_EXTERNAL_CHECKPOINT_RESULTS = new WeakSet();

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function deepFreezeResult(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) deepFreezeResult(descriptor.value, seen);
  }
  return Object.freeze(value);
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status ?? result.signal}: ${(result.stderr || result.stdout || '').slice(0, 2000)}`);
  return result.stdout;
}
function safeJson(text, label) {
  try { return JSON.parse(text); }
  catch (cause) { throw new Error(`${label} is not valid JSON: ${String(cause?.message || cause)}`); }
}
function readRegularFile(filePath, maxBytes = MAX_BUNDLE_BYTES) {
  const absolute = path.resolve(filePath);
  const before = fs.lstatSync(absolute, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || fs.realpathSync(absolute) !== absolute || before.size < 1n || before.size > BigInt(maxBytes)) {
    throw new Error(`refusing non-regular, non-canonical, empty or oversized file: ${absolute}`);
  }
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) throw new Error('file identity changed before read');
    const chunks = [];
    let count = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - count));
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!n) break;
      count += n;
      if (count > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes`);
      chunks.push(chunk.subarray(0, n));
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(absolute, { bigint: true });
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs ||
        after.ctimeNs !== stat.ctimeNs || current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size ||
        current.mtimeNs !== stat.mtimeNs || current.ctimeNs !== stat.ctimeNs || fs.realpathSync(absolute) !== absolute) {
      throw new Error('file changed while being read');
    }
    return Buffer.concat(chunks, count);
  } finally { fs.closeSync(fd); }
}

function policyError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/**
 * Trust policy files are a host-administration boundary, not caller input.
 * The CLI may name an evidence file, but cannot select a different trust root:
 * policies must live at the fixed /etc/runalith path, be root-owned, and not be
 * writable by group/other. This is deliberately Linux-host-specific.
 */
function readHostProvisionedPolicy(expectedPath, requestedPath = expectedPath, label = 'host policy') {
  if (path.resolve(requestedPath) !== expectedPath || !path.isAbsolute(expectedPath)) {
    throw policyError('HOST_POLICY_PATH_NOT_AUTHORIZED', `${label} must be provisioned at ${expectedPath}`);
  }
  let directoryBefore;
  let fileBefore;
  try {
    directoryBefore = fs.lstatSync(HOST_POLICY_DIRECTORY, { bigint: true });
    fileBefore = fs.lstatSync(expectedPath, { bigint: true });
  } catch {
    throw policyError('HOST_POLICY_NOT_CONFIGURED', `${label} is not provisioned at ${expectedPath}`);
  }
  if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink() || directoryBefore.uid !== 0n ||
      (directoryBefore.mode & 0o022n) !== 0n || fs.realpathSync(HOST_POLICY_DIRECTORY) !== HOST_POLICY_DIRECTORY) {
    throw policyError('HOST_POLICY_DIRECTORY_UNTRUSTED', `${HOST_POLICY_DIRECTORY} must be a canonical root-owned directory not writable by group/other`);
  }
  if (!fileBefore.isFile() || fileBefore.isSymbolicLink() || fileBefore.uid !== 0n ||
      (fileBefore.mode & 0o022n) !== 0n || fileBefore.size < 2n || fileBefore.size > 128n * 1024n ||
      fs.realpathSync(expectedPath) !== expectedPath) {
    throw policyError('HOST_POLICY_FILE_UNTRUSTED', `${label} must be a canonical root-owned regular file, 2–131072 bytes, not writable by group/other`);
  }
  let bytes;
  try { bytes = readRegularFile(expectedPath, 128 * 1024); }
  catch (error) { throw policyError('HOST_POLICY_READ_UNSAFE', `${label} could not be read stably: ${String(error?.message || error)}`); }
  const directoryAfter = fs.lstatSync(HOST_POLICY_DIRECTORY, { bigint: true });
  const fileAfter = fs.lstatSync(expectedPath, { bigint: true });
  if (directoryAfter.dev !== directoryBefore.dev || directoryAfter.ino !== directoryBefore.ino ||
      directoryAfter.uid !== 0n || (directoryAfter.mode & 0o022n) !== 0n ||
      fileAfter.dev !== fileBefore.dev || fileAfter.ino !== fileBefore.ino || fileAfter.uid !== 0n ||
      fileAfter.size !== fileBefore.size || fileAfter.mtimeNs !== fileBefore.mtimeNs ||
      fileAfter.ctimeNs !== fileBefore.ctimeNs || (fileAfter.mode & 0o022n) !== 0n) {
    throw policyError('HOST_POLICY_CHANGED_DURING_READ', `${label} ownership, mode, inode, or contents changed during verification`);
  }
  return { bytes, path: expectedPath, sha256: sha256(bytes), ownerUid: Number(fileAfter.uid), mode: Number(fileAfter.mode & 0o777n) };
}

function exactObjectKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) {
    throw policyError('HOST_POLICY_SCHEMA_INVALID', `${label} must contain exactly: ${[...expected].sort().join(', ')}`);
  }
}

function publicKeySha256(pem, label) {
  let key;
  try { key = crypto.createPublicKey(pem); }
  catch { throw policyError('HOST_POLICY_PUBLIC_KEY_INVALID', `${label} is not a parseable public key`); }
  if (key.asymmetricKeyType !== 'ed25519') throw policyError('HOST_POLICY_PUBLIC_KEY_INVALID', `${label} must use Ed25519`);
  return sha256(key.export({ type: 'spki', format: 'der' }));
}

function canonicalPolicyTimestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) {
    throw policyError('HOST_POLICY_TIMESTAMP_INVALID', `${label} must be a canonical UTC timestamp${nullable ? ' or null' : ''}`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw policyError('HOST_POLICY_TIMESTAMP_INVALID', `${label} is not a canonical UTC timestamp`);
  }
  return parsed;
}

/** Pure schema/key-window validation. It does not authenticate where a policy came from. */
export function validatePhase2CustodyPolicy(policy, { now = Date.now(), expectedRepository = null } = {}) {
  if (!Number.isSafeInteger(now)) throw policyError('HOST_POLICY_CLOCK_INVALID', 'policy verification clock must be an integer timestamp');
  exactObjectKeys(policy, PHASE2_CUSTODY_POLICY_KEYS, 'Phase 2 custody trust policy');
  const gitOid = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
  const keyId = /^[a-z][a-z0-9._-]{0,79}$/;
  if (policy.schema_version !== 1 || policy.contract !== PHASE2_CUSTODY_POLICY_CONTRACT ||
      !Number.isSafeInteger(policy.policy_version) || policy.policy_version < 1 ||
      typeof policy.updated_by !== 'string' || !policy.updated_by.trim() || policy.updated_by.length > 200 ||
      typeof policy.change_reference !== 'string' || !policy.change_reference.trim() || policy.change_reference.length > 300 ||
      typeof policy.authority_id !== 'string' || !policy.authority_id.trim() || policy.authority_id.length > 200 ||
      typeof policy.builder_identity !== 'string' || !policy.builder_identity.trim() || policy.builder_identity.length > 300 ||
      typeof policy.repository !== 'string' || policy.repository !== PHASE2_CUSTODY_EXPECTED_REPOSITORY ||
      (expectedRepository && policy.repository !== expectedRepository) ||
      !gitOid.test(policy.source_commit || '') || !gitOid.test(policy.source_tree_oid || '') ||
      !keyId.test(policy.authority_key_id || '') || !keyId.test(policy.builder_key_id || '') ||
      policy.authority_key_id === policy.builder_key_id ||
      typeof policy.authority_public_key_pem !== 'string' || typeof policy.builder_public_key_pem !== 'string' ||
      !SHA256_HEX.test(policy.authority_key_sha256 || '') || !SHA256_HEX.test(policy.builder_key_sha256 || '')) {
    throw policyError('HOST_POLICY_SCHEMA_INVALID', 'Phase 2 policy version/administration metadata, repository, frozen source, key IDs or key pins are invalid');
  }
  const updatedAt = canonicalPolicyTimestamp(policy.updated_at, 'updated_at');
  if (updatedAt > now + 60_000) throw policyError('HOST_POLICY_FUTURE_DATED', 'policy updated_at is more than one minute in the future');
  const authorityNotBefore = canonicalPolicyTimestamp(policy.authority_key_not_before, 'authority_key_not_before');
  const authorityNotAfter = canonicalPolicyTimestamp(policy.authority_key_not_after, 'authority_key_not_after', { nullable: true });
  const authorityRevokedAt = canonicalPolicyTimestamp(policy.authority_key_revoked_at, 'authority_key_revoked_at', { nullable: true });
  const builderNotBefore = canonicalPolicyTimestamp(policy.builder_key_not_before, 'builder_key_not_before');
  const builderNotAfter = canonicalPolicyTimestamp(policy.builder_key_not_after, 'builder_key_not_after', { nullable: true });
  const builderRevokedAt = canonicalPolicyTimestamp(policy.builder_key_revoked_at, 'builder_key_revoked_at', { nullable: true });
  for (const [label, notBefore, notAfter, revokedAt] of [
    ['authority', authorityNotBefore, authorityNotAfter, authorityRevokedAt],
    ['builder', builderNotBefore, builderNotAfter, builderRevokedAt]
  ]) {
    if (notAfter !== null && notAfter <= notBefore) throw policyError('HOST_POLICY_KEY_WINDOW_INVALID', `${label} key not_after must be later than not_before`);
    if (revokedAt !== null || notBefore > now || (notAfter !== null && now >= notAfter)) {
      throw policyError('HOST_POLICY_KEY_UNAVAILABLE', `${label} key is revoked or outside its validity window`);
    }
  }
  const authorityFingerprint = publicKeySha256(policy.authority_public_key_pem, 'authority_public_key_pem');
  const builderFingerprint = publicKeySha256(policy.builder_public_key_pem, 'builder_public_key_pem');
  if (authorityFingerprint !== policy.authority_key_sha256 || builderFingerprint !== policy.builder_key_sha256 ||
      authorityFingerprint === builderFingerprint) {
    throw policyError('HOST_POLICY_KEY_PIN_INVALID', 'Phase 2 authority/builder key fingerprints must match and use distinct Ed25519 roots');
  }
  return { ...policy, authorityKeySha256: authorityFingerprint, builderKeySha256: builderFingerprint,
    updatedAt, authorityKeyNotBefore: authorityNotBefore, authorityKeyNotAfter: authorityNotAfter,
    authorityKeyRevokedAt: authorityRevokedAt, builderKeyNotBefore: builderNotBefore,
    builderKeyNotAfter: builderNotAfter, builderKeyRevokedAt: builderRevokedAt };
}

/**
 * Enforce the production package's canonical release scope before opening
 * candidate or DSSE evidence paths. The root-owned policy selects signer keys
 * and required checks, but cannot retarget this CLI to another repository,
 * subject, build type or lower-trust environment.
 */
export function validateHostPinnedReleasePolicyScope(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) ||
      policy.source_repository !== RELEASE_POLICY_EXPECTED_REPOSITORY ||
      policy.subject_name !== RELEASE_POLICY_EXPECTED_SUBJECT ||
      policy.expected_build_type !== RELEASE_POLICY_EXPECTED_BUILD_TYPE ||
      policy.target_environment !== RELEASE_POLICY_EXPECTED_ENVIRONMENT ||
      !Number.isSafeInteger(policy.policy_version) || policy.policy_version < 1) {
    throw policyError('RELEASE_POLICY_SCOPE_NOT_CANONICAL',
      `release policy must pin repository=${RELEASE_POLICY_EXPECTED_REPOSITORY}, subject=${RELEASE_POLICY_EXPECTED_SUBJECT}, buildType=${RELEASE_POLICY_EXPECTED_BUILD_TYPE}, environment=${RELEASE_POLICY_EXPECTED_ENVIRONMENT}, and a positive policy_version`);
  }
  return { canonicalScopeVerified: true, sourceRepository: RELEASE_POLICY_EXPECTED_REPOSITORY,
    subjectName: RELEASE_POLICY_EXPECTED_SUBJECT, expectedBuildType: RELEASE_POLICY_EXPECTED_BUILD_TYPE,
    targetEnvironment: RELEASE_POLICY_EXPECTED_ENVIRONMENT, policyVersion: policy.policy_version };
}

/** Pure external-checkpoint trust-policy validation. This never grants gate authority. */
export function validateExternalCheckpointHostPolicy(policy, { now = Date.now() } = {}) {
  if (!Number.isSafeInteger(now)) throw policyError('HOST_CHECKPOINT_POLICY_CLOCK_INVALID', 'checkpoint policy clock must be an integer timestamp');
  exactObjectKeys(policy, EXTERNAL_CHECKPOINT_POLICY_KEYS, 'external checkpoint host policy');
  const keyId = /^[a-z][a-z0-9._-]{0,79}$/;
  if (policy.schema_version !== 1 || policy.contract !== EXTERNAL_CHECKPOINT_POLICY_CONTRACT ||
      !Number.isSafeInteger(policy.policy_version) || policy.policy_version < 1 ||
      typeof policy.updated_by !== 'string' || !policy.updated_by.trim() || policy.updated_by.length > 200 ||
      typeof policy.change_reference !== 'string' || !policy.change_reference.trim() || policy.change_reference.length > 300 ||
      typeof policy.authority_id !== 'string' || !policy.authority_id.trim() || policy.authority_id.length > 200 ||
      !keyId.test(policy.authority_key_id || '') ||
      typeof policy.authority_public_key_pem !== 'string' || !SHA256_HEX.test(policy.authority_key_sha256 || '') ||
      !keyId.test(policy.store_attestation_key_id || '') || policy.store_attestation_key_id === policy.authority_key_id ||
      typeof policy.store_attestation_public_key_pem !== 'string' || !SHA256_HEX.test(policy.store_attestation_key_sha256 || '') ||
      policy.adapter_path !== HOST_EXTERNAL_CHECKPOINT_ADAPTER_PATH || !SHA256_HEX.test(policy.adapter_sha256 || '') ||
      typeof policy.external_store_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/.test(policy.external_store_id) ||
      typeof policy.external_service_uri !== 'string' || !Number.isSafeInteger(policy.max_store_attestation_age_seconds) ||
      policy.max_store_attestation_age_seconds < 60 || policy.max_store_attestation_age_seconds > 90 * 24 * 60 * 60) {
    throw policyError('HOST_CHECKPOINT_POLICY_SCHEMA_INVALID', 'external checkpoint policy version, authority, adapter, store identity or change metadata is invalid');
  }
  const updatedAt = canonicalPolicyTimestamp(policy.updated_at, 'updated_at');
  const keyNotBefore = canonicalPolicyTimestamp(policy.authority_key_not_before, 'authority_key_not_before');
  const keyNotAfter = canonicalPolicyTimestamp(policy.authority_key_not_after, 'authority_key_not_after', { nullable: true });
  const keyRevokedAt = canonicalPolicyTimestamp(policy.authority_key_revoked_at, 'authority_key_revoked_at', { nullable: true });
  const storeKeyNotBefore = canonicalPolicyTimestamp(policy.store_attestation_key_not_before, 'store_attestation_key_not_before');
  const storeKeyNotAfter = canonicalPolicyTimestamp(policy.store_attestation_key_not_after, 'store_attestation_key_not_after', { nullable: true });
  const storeKeyRevokedAt = canonicalPolicyTimestamp(policy.store_attestation_key_revoked_at, 'store_attestation_key_revoked_at', { nullable: true });
  if (updatedAt > now + 60_000) throw policyError('HOST_CHECKPOINT_POLICY_FUTURE_DATED', 'policy updated_at is more than one minute in the future');
  if (keyNotAfter !== null && keyNotAfter <= keyNotBefore) throw policyError('HOST_CHECKPOINT_POLICY_KEY_WINDOW_INVALID', 'authority key not_after must be later than not_before');
  if (keyRevokedAt !== null || keyNotBefore > now || (keyNotAfter !== null && now >= keyNotAfter)) {
    throw policyError('HOST_CHECKPOINT_POLICY_KEY_UNAVAILABLE', 'external checkpoint authority key is revoked or outside its validity window');
  }
  if (storeKeyNotAfter !== null && storeKeyNotAfter <= storeKeyNotBefore) {
    throw policyError('HOST_CHECKPOINT_POLICY_STORE_KEY_WINDOW_INVALID', 'store attestation key not_after must be later than not_before');
  }
  if (storeKeyRevokedAt !== null || storeKeyNotBefore > now || (storeKeyNotAfter !== null && now >= storeKeyNotAfter)) {
    throw policyError('HOST_CHECKPOINT_POLICY_STORE_KEY_UNAVAILABLE', 'external store attestation key is revoked or outside its validity window');
  }
  let publicKey;
  try { publicKey = crypto.createPublicKey(policy.authority_public_key_pem); }
  catch { throw policyError('HOST_CHECKPOINT_POLICY_KEY_INVALID', 'checkpoint authority public key is invalid'); }
  if (publicKey.asymmetricKeyType !== 'ed25519' ||
      sha256(publicKey.export({ type: 'spki', format: 'der' })) !== policy.authority_key_sha256) {
    throw policyError('HOST_CHECKPOINT_POLICY_KEY_PIN_INVALID', 'checkpoint authority SPKI fingerprint does not match the configured pin');
  }
  let storeAttestationPublicKey;
  try { storeAttestationPublicKey = crypto.createPublicKey(policy.store_attestation_public_key_pem); }
  catch { throw policyError('HOST_CHECKPOINT_POLICY_STORE_KEY_INVALID', 'store attestation public key is invalid'); }
  const storeAttestationKeySha256 = sha256(storeAttestationPublicKey.export({ type: 'spki', format: 'der' }));
  if (storeAttestationPublicKey.asymmetricKeyType !== 'ed25519' || storeAttestationKeySha256 !== policy.store_attestation_key_sha256 ||
      storeAttestationKeySha256 === policy.authority_key_sha256) {
    throw policyError('HOST_CHECKPOINT_POLICY_STORE_KEY_PIN_INVALID', 'external store attestation root must match its SPKI pin and be distinct from the checkpoint signing root');
  }
  let service;
  try { service = new URL(policy.external_service_uri); }
  catch { throw policyError('HOST_CHECKPOINT_POLICY_SERVICE_INVALID', 'external checkpoint service URI is invalid'); }
  const hostname = service.hostname.toLowerCase();
  const localHost = !hostname.includes('.') || hostname === 'localhost' || hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') || hostname === '::1' || hostname.startsWith('127.') || hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) || /^\d+(?:\.\d+){3}$/.test(hostname);
  if (service.protocol !== 'https:' || service.username || service.password || service.hash ||
      (service.port && service.port !== '443') || localHost) {
    throw policyError('HOST_CHECKPOINT_POLICY_SERVICE_INVALID', 'external checkpoint service must use HTTPS to a non-local DNS hostname on port 443');
  }
  return { ...policy, updatedAt, authorityKeyNotBefore: keyNotBefore,
    authorityKeyNotAfter: keyNotAfter, authorityKeyRevokedAt: keyRevokedAt, authorityPublicKey: publicKey,
    storeAttestationKeyNotBefore: storeKeyNotBefore, storeAttestationKeyNotAfter: storeKeyNotAfter,
    storeAttestationKeyRevokedAt: storeKeyRevokedAt, storeAttestationPublicKey };
}

function inspectHostOwnedCheckpointAdapter(adapterPath, expectedSha256) {
  if (adapterPath !== HOST_EXTERNAL_CHECKPOINT_ADAPTER_PATH) {
    throw policyError('HOST_CHECKPOINT_ADAPTER_PATH_UNAUTHORIZED', 'checkpoint adapter path is not the fixed host-managed path');
  }
  let cursor = path.parse(adapterPath).root;
  const parts = adapterPath.slice(cursor.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]);
    let stat;
    try { stat = fs.lstatSync(cursor, { bigint: true }); }
    catch { throw policyError('HOST_CHECKPOINT_ADAPTER_NOT_CONFIGURED', 'host-owned external checkpoint adapter is not installed at the required path'); }
    if (stat.isSymbolicLink() || fs.realpathSync(cursor) !== cursor || stat.uid !== 0n || (stat.mode & 0o022n) !== 0n) {
      throw policyError('HOST_CHECKPOINT_ADAPTER_UNTRUSTED', 'every adapter path component must be canonical, root-owned, and not writable by group/other');
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw policyError('HOST_CHECKPOINT_ADAPTER_UNTRUSTED', 'adapter parent component is not a regular directory');
    }
    if (index === parts.length - 1 && (!stat.isFile() || (stat.mode & 0o111n) === 0n)) {
      throw policyError('HOST_CHECKPOINT_ADAPTER_UNTRUSTED', 'adapter must be a root-owned executable regular file');
    }
  }
  const bytes = readRegularFile(adapterPath, 32 * 1024 * 1024);
  const observedSha256 = sha256(bytes);
  if (observedSha256 !== expectedSha256) throw policyError('HOST_CHECKPOINT_ADAPTER_HASH_MISMATCH', 'installed adapter bytes do not match the root-provisioned SHA-256 pin');
  return { path: adapterPath, sha256: observedSha256, ownerUid: 0 };
}

function runHostCheckpointAdapter(adapterPath, action, payload) {
  const result = spawnSync(adapterPath, [action], {
    cwd: '/', input: Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8'), encoding: 'buffer',
    timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }
  });
  if (result.error) throw policyError('HOST_CHECKPOINT_ADAPTER_EXECUTION_FAILED', String(result.error.message || result.error));
  if (result.status !== 0 || result.signal) {
    throw policyError('HOST_CHECKPOINT_ADAPTER_EXECUTION_FAILED', `host adapter ${action} failed (exit=${result.status}, signal=${result.signal || 'none'}): ${(result.stderr || Buffer.alloc(0)).toString('utf8').slice(0, 1000)}`);
  }
  if (!Buffer.isBuffer(result.stdout) || result.stdout.length < 2 || result.stdout.length > 4 * 1024 * 1024) {
    throw policyError('HOST_CHECKPOINT_ADAPTER_RESPONSE_INVALID', 'host adapter response must be strict JSON between 2 bytes and 4 MiB');
  }
  try { return parseStrictJson(result.stdout, `host checkpoint adapter ${action} response`, { maxBytes: 4 * 1024 * 1024 }); }
  catch (error) { throw policyError('HOST_CHECKPOINT_ADAPTER_RESPONSE_INVALID', String(error?.message || error)); }
}

function verifySignedExternalRecord(record, publicKey, signatureField, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record[signatureField] !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record[signatureField])) {
    throw policyError('EXTERNAL_CHECKPOINT_SIGNATURE_INVALID', `${label} signature encoding is invalid`);
  }
  const signatureBytes = Buffer.from(record[signatureField], 'base64');
  if (signatureBytes.length !== 64 || signatureBytes.toString('base64') !== record[signatureField]) {
    throw policyError('EXTERNAL_CHECKPOINT_SIGNATURE_INVALID', `${label} signature must be canonical 64-byte Ed25519 base64`);
  }
  const signedPayload = { ...record };
  delete signedPayload[signatureField];
  if (!crypto.verify(null, Buffer.from(canonicalExternalCheckpointPayload(signedPayload), 'utf8'), publicKey, signatureBytes)) {
    throw policyError('EXTERNAL_CHECKPOINT_SIGNATURE_INVALID', `${label} signature verification failed`);
  }
  return signedPayload;
}

export function computeExternalStoreContinuityEvidenceSha256({ authorityId, storeId, serviceUri, continuity } = {}) {
  if (typeof authorityId !== 'string' || !authorityId.trim() || typeof storeId !== 'string' || !storeId.trim() ||
      typeof serviceUri !== 'string' || !serviceUri.trim() || !continuity || typeof continuity !== 'object' ||
      Array.isArray(continuity) || continuity.source !== 'host_monotonic_store' || continuity.authorityId !== authorityId ||
      !Number.isSafeInteger(continuity.highWaterSequence) || continuity.highWaterSequence < 1 ||
      !SHA256_HEX.test(continuity.lastCheckpointDigest || '')) {
    throw policyError('EXTERNAL_CHECKPOINT_CONTINUITY_SOURCE_UNVERIFIED', 'cannot hash malformed external-store continuity evidence');
  }
  const payload = {
    schema_version: 1, contract: EXTERNAL_STORE_CONTINUITY_EVIDENCE_CONTRACT,
    authority_id: authorityId, store_id: storeId, service_uri: serviceUri,
    continuity_source: continuity.source, high_water_sequence: continuity.highWaterSequence,
    last_checkpoint_digest: continuity.lastCheckpointDigest
  };
  return sha256(Buffer.from(canonicalExternalCheckpointPayload(payload), 'utf8'));
}

export function verifyExternalStoreAttestation(attestation, policy, { now = Date.now(), continuity } = {}) {
  exactObjectKeys(attestation, EXTERNAL_STORE_ATTESTATION_KEYS, 'external monotonic store attestation');
  if (attestation.schema_version !== 1 || attestation.contract !== EXTERNAL_STORE_ATTESTATION_CONTRACT ||
      attestation.authority_id !== policy.authority_id || attestation.store_id !== policy.external_store_id ||
      attestation.service_uri !== policy.external_service_uri ||
      !['managed_remote_transactional_store', 'managed_cloud_monotonic_store', 'hardware_monotonic_service'].includes(attestation.backend) ||
      attestation.independent_of_plugin_host !== true || attestation.monotonicity_protection !== true ||
      attestation.restore_rollback_protection !== true || !SHA256_HEX.test(attestation.evidence_sha256 || '')) {
    throw policyError('EXTERNAL_CHECKPOINT_STORE_ATTESTATION_INVALID', 'signed store attestation does not declare the pinned external store and required anti-rollback properties');
  }
  const issuedAt = canonicalPolicyTimestamp(attestation.issued_at, 'store_attestation.issued_at');
  const validUntil = canonicalPolicyTimestamp(attestation.valid_until, 'store_attestation.valid_until');
  if (issuedAt > now + 5_000 || now - issuedAt > policy.max_store_attestation_age_seconds * 1000 || validUntil <= now ||
      validUntil <= issuedAt || validUntil - issuedAt > policy.max_store_attestation_age_seconds * 1000) {
    throw policyError('EXTERNAL_CHECKPOINT_STORE_ATTESTATION_STALE', 'store attestation is stale, future-dated, expired, or exceeds the provisioned validity window');
  }
  const expectedEvidenceSha256 = computeExternalStoreContinuityEvidenceSha256({ authorityId: policy.authority_id,
    storeId: policy.external_store_id, serviceUri: policy.external_service_uri, continuity });
  if (attestation.evidence_sha256 !== expectedEvidenceSha256) {
    throw policyError('EXTERNAL_CHECKPOINT_STORE_ATTESTATION_BINDING_MISMATCH',
      'signed store attestation evidence_sha256 must bind the exact authority/store/service/high-water/previous-digest continuity record being used');
  }
  verifySignedExternalRecord(attestation, policy.storeAttestationPublicKey, 'signature_base64', 'external monotonic store attestation');
  return { contract: attestation.contract, storeId: attestation.store_id, serviceUri: attestation.service_uri,
    backend: attestation.backend, evidenceSha256: attestation.evidence_sha256, issuedAt: attestation.issued_at,
    validUntil: attestation.valid_until, signedIndependenceClaimsVerified: true };
}

/**
 * Explicitly opt-in preflight integration. This consumes a single-use nonce and
 * advances the external store's high-water checkpoint; the default preflight
 * path never calls it. The host adapter must perform one external atomic CAS and
 * return a second authority-signed receipt after the transaction commits.
 */
export function verifyExternalAntiRollbackAnchorForPreflight({ candidateSha256, rollbackSha256, now = Date.now() } = {}) {
  let transitionAttempted = false;
  try {
    if (!SHA256_HEX.test(candidateSha256 || '') || !SHA256_HEX.test(rollbackSha256 || '') || !Number.isSafeInteger(now)) {
      throw policyError('EXTERNAL_CHECKPOINT_RELEASE_BINDING_INVALID', 'candidate/rollback SHA-256 and verifier clock are required');
    }
    const provisioned = readHostProvisionedPolicy(HOST_EXTERNAL_CHECKPOINT_POLICY_PATH,
      HOST_EXTERNAL_CHECKPOINT_POLICY_PATH, 'external checkpoint trust policy');
    let rawPolicy;
    try { rawPolicy = parseStrictJson(provisioned.bytes, 'external checkpoint host policy', { maxBytes: 128 * 1024 }); }
    catch (error) { throw policyError('HOST_CHECKPOINT_POLICY_SCHEMA_INVALID', String(error?.message || error)); }
    const policy = validateExternalCheckpointHostPolicy(rawPolicy, { now });
    const adapter = inspectHostOwnedCheckpointAdapter(policy.adapter_path, policy.adapter_sha256);
    const requestNonce = crypto.randomBytes(32).toString('hex');
    const requestedAt = new Date(now).toISOString();
    const observation = runHostCheckpointAdapter(adapter.path, 'observe', {
      schema_version: 1, contract: EXTERNAL_CHECKPOINT_OBSERVATION_CONTRACT, action: 'observe',
      authority_id: policy.authority_id, external_store_id: policy.external_store_id,
      external_service_uri: policy.external_service_uri, request_nonce: requestNonce,
      candidate_sha256: candidateSha256, rollback_sha256: rollbackSha256, requested_at: requestedAt
    });
    exactObjectKeys(observation, ['schema_version', 'contract', 'continuity', 'checkpoint_response', 'store_attestation'], 'external checkpoint adapter observation');
    if (observation.schema_version !== 1 || observation.contract !== EXTERNAL_CHECKPOINT_OBSERVATION_CONTRACT) {
      throw policyError('HOST_CHECKPOINT_ADAPTER_RESPONSE_INVALID', 'adapter observation contract/version is unsupported');
    }
    exactObjectKeys(observation.continuity, ['source', 'authorityId', 'highWaterSequence', 'lastCheckpointDigest'], 'external checkpoint continuity');
    if (observation.continuity.source !== 'host_monotonic_store' || observation.continuity.authorityId !== policy.authority_id ||
        !Number.isSafeInteger(observation.continuity.highWaterSequence) || observation.continuity.highWaterSequence < 1 ||
        !SHA256_HEX.test(observation.continuity.lastCheckpointDigest || '')) {
      throw policyError('EXTERNAL_CHECKPOINT_CONTINUITY_SOURCE_UNVERIFIED', 'adapter did not return the expected external monotonic-store continuity record');
    }
    const storeAttestation = verifyExternalStoreAttestation(observation.store_attestation, policy,
      { now, continuity: observation.continuity });

    let commitReceiptVerified = false;
    const verification = verifyExternalTrustCheckpointResponse(observation.checkpoint_response, {
      authorityPublicKeyPem: policy.authority_public_key_pem, expectedAuthorityId: policy.authority_id,
      requestNonce, candidateSha256, rollbackSha256, continuity: observation.continuity, now,
      commitCheckpointTransition(input) {
        transitionAttempted = true;
        const reply = runHostCheckpointAdapter(adapter.path, 'commit', {
          schema_version: 1, contract: EXTERNAL_CHECKPOINT_COMMIT_CONTRACT, action: 'commit',
          authority_id: input.authorityId, external_store_id: policy.external_store_id,
          external_service_uri: policy.external_service_uri, request_nonce: input.requestNonce,
          candidate_sha256: input.candidateSha256, rollback_sha256: input.rollbackSha256,
          expected_high_water_sequence: input.expectedHighWaterSequence,
          expected_previous_checkpoint_digest: input.expectedPreviousCheckpointDigest,
          checkpoint_sequence: input.checkpointSequence, checkpoint_digest: input.checkpointDigest,
          previous_checkpoint_digest: input.previousCheckpointDigest
        });
        exactObjectKeys(reply, ['schema_version', 'contract', 'commit_receipt'], 'external checkpoint commit response');
        if (reply.schema_version !== 1 || reply.contract !== EXTERNAL_CHECKPOINT_COMMIT_CONTRACT) {
          throw policyError('EXTERNAL_CHECKPOINT_COMMIT_RECEIPT_INVALID', 'adapter commit response contract/version is unsupported');
        }
        const receipt = reply.commit_receipt;
        exactObjectKeys(receipt, EXTERNAL_CHECKPOINT_COMMIT_RECEIPT_KEYS, 'external checkpoint commit receipt');
        if (receipt.schema_version !== 1 || receipt.contract !== EXTERNAL_CHECKPOINT_COMMIT_RECEIPT_CONTRACT ||
            receipt.authority_id !== input.authorityId || receipt.request_nonce !== input.requestNonce ||
            receipt.candidate_sha256 !== input.candidateSha256 || receipt.rollback_sha256 !== input.rollbackSha256 ||
            receipt.checkpoint_sequence !== input.checkpointSequence || receipt.checkpoint_digest !== input.checkpointDigest ||
            receipt.previous_checkpoint_digest !== input.previousCheckpointDigest || receipt.commit_status !== 'COMMITTED') {
          throw policyError('EXTERNAL_CHECKPOINT_COMMIT_RECEIPT_INVALID', 'signed commit receipt does not bind the exact CAS transition');
        }
        const committedAt = canonicalPolicyTimestamp(receipt.committed_at, 'commit_receipt.committed_at');
        if (committedAt > now + 5_000 || now - committedAt > 5 * 60_000) {
          throw policyError('EXTERNAL_CHECKPOINT_COMMIT_RECEIPT_STALE', 'external commit receipt is not fresh');
        }
        verifySignedExternalRecord(receipt, policy.authorityPublicKey, 'signature_base64', 'external checkpoint commit receipt');
        commitReceiptVerified = true;
        return true;
      }
    });
    if (!verification.verified || !verification.checkpointStateAdvanced || !verification.nonceConsumed || !commitReceiptVerified) {
      throw policyError('EXTERNAL_CHECKPOINT_VERIFICATION_BLOCKED', (verification.blockers || ['EXTERNAL_CHECKPOINT_NOT_COMMITTED']).join(','));
    }
    const response = observation.checkpoint_response;
    const trusted = deepFreezeResult({
      verified: true, status: 'VERIFIED', source: 'host_monotonic_checkpoint_service',
      authorityId: response.authority_id, candidateSha256, rollbackSha256,
      checkpointSequence: response.checkpoint_sequence, checkpointDigest: response.checkpoint_digest,
      previousCheckpointDigest: response.previous_checkpoint_digest, ledgerStateSha256: response.ledger_state_sha256,
      trustDomainStateSha256: response.trust_domain_state_sha256, signatureVerified: true,
      independentOfLocalLedger: true, continuitySourceAuthenticated: true, authorityKeyProvisioningAuthenticated: true,
      externalStoreAttestationVerified: true, commitReceiptVerified: true, checkpointStateAdvanced: true,
      nonceConsumed: true, observedAt: response.observed_at, policyVersion: policy.policy_version,
      policyPath: provisioned.path, policySha256: provisioned.sha256, adapterPath: adapter.path,
      adapterSha256: adapter.sha256, externalStoreId: storeAttestation.storeId,
      externalServiceUri: storeAttestation.serviceUri,
      storeAttestationSha256: sha256(Buffer.from(JSON.stringify(observation.store_attestation))),
      productionAuthorityEstablished: true
    });
    VERIFIED_EXTERNAL_CHECKPOINT_RESULTS.add(trusted);
    return { status: 'PASS', verified: trusted, transition: { attempted: true, outcome: 'COMMITTED',
      nonceConsumed: true, checkpointStateAdvanced: true } };
  } catch (error) {
    return { status: 'BLOCKED', verified: null, blockers: [error?.code || 'EXTERNAL_CHECKPOINT_VERIFICATION_FAILED'],
      message: String(error?.message || error).slice(0, 1000),
      transition: { attempted: transitionAttempted,
        outcome: transitionAttempted ? 'UNKNOWN_AFTER_COMMIT_ATTEMPT' : 'BLOCKED_BEFORE_COMMIT',
        nonceMayHaveBeenConsumed: transitionAttempted } };
  }
}

function loadPhase2CustodyPolicy() {
  const provisioned = readHostProvisionedPolicy(HOST_PHASE2_CUSTODY_POLICY_PATH,
    HOST_PHASE2_CUSTODY_POLICY_PATH, 'Phase 2 custody trust policy');
  let policy;
  try { policy = parseStrictJson(provisioned.bytes, 'host Phase 2 custody trust policy', { maxBytes: 128 * 1024 }); }
  catch (error) { throw policyError('HOST_POLICY_SCHEMA_INVALID', `Phase 2 custody trust policy is not strict JSON: ${String(error?.message || error)}`); }
  const validated = validatePhase2CustodyPolicy(policy);
  return { ...validated, provisionedPolicySha256: provisioned.sha256,
    provisionedPolicyPath: provisioned.path, provisionedPolicyOwnerUid: provisioned.ownerUid,
    provisionedPolicyMode: provisioned.mode };
}

export function verifyPhase2CustodyForPreflight({ args, candidateBundle }) {
  const manifestPath = args?.phase2Manifest;
  const receiptPath = args?.phase2Receipt;
  if (!manifestPath && !receiptPath) {
    return { contract: 'runalith-phase2-preflight-custody/v1', status: 'BLOCKED',
      verified: false, authorityKeyProvisioningAuthenticated: false,
      blockers: ['PHASE2_CUSTODY_EVIDENCE_NOT_PROVIDED'],
      missingArguments: ['phase2Manifest', 'phase2Receipt'],
      requiredHostPolicyPath: HOST_PHASE2_CUSTODY_POLICY_PATH };
  }
  if (typeof manifestPath !== 'string' || !manifestPath.trim() || typeof receiptPath !== 'string' || !receiptPath.trim()) {
    return { contract: 'runalith-phase2-preflight-custody/v1', status: 'BLOCKED',
      verified: false, authorityKeyProvisioningAuthenticated: false,
      blockers: ['PHASE2_CUSTODY_ARGUMENT_SET_INCOMPLETE'],
      missingArguments: [manifestPath ? null : 'phase2Manifest', receiptPath ? null : 'phase2Receipt'].filter(Boolean),
      requiredHostPolicyPath: HOST_PHASE2_CUSTODY_POLICY_PATH };
  }
  try {
    const policy = loadPhase2CustodyPolicy();
    const result = verifyPhase2CustodyEvidence({ repositoryRoot: ROOT, candidatePath: candidateBundle.path,
      manifestPath, receiptPath, authorityPublicKeyPem: policy.authority_public_key_pem,
      builderPublicKeyPem: policy.builder_public_key_pem, expectedAuthorityKeySha256: policy.authority_key_sha256,
      expectedBuilderKeySha256: policy.builder_key_sha256, expectedAuthorityId: policy.authority_id,
      expectedBuilderIdentity: policy.builder_identity, expectedRepository: policy.repository });
    if (result.candidateSha256 !== candidateBundle.sha256 || result.sourceCommit !== policy.source_commit ||
        result.sourceTreeOid !== policy.source_tree_oid || result.authorityKeySha256 !== policy.authority_key_sha256 ||
        result.builderKeySha256 !== policy.builder_key_sha256 || result.manifestPathCount !== 71) {
      throw policyError('PHASE2_CUSTODY_HOST_POLICY_BINDING_MISMATCH', 'signed custody material does not match the host-pinned candidate, source snapshot, and independent key policy');
    }
    const bound = deepFreezeResult({ ...result, contract: 'runalith-phase2-preflight-custody/v1',
      status: 'HOST_PINNED_PHASE2_PATH_CONTRACT_VERIFIED', verified: true,
      authorityKeyProvisioningAuthenticated: true,
      hostPolicy: { path: policy.provisionedPolicyPath, sha256: policy.provisionedPolicySha256,
        ownerUid: policy.provisionedPolicyOwnerUid, mode: policy.provisionedPolicyMode,
        sourceCommit: policy.source_commit, sourceTreeOid: policy.source_tree_oid } });
    VERIFIED_PHASE2_CUSTODY_RESULTS.add(bound);
    return bound;
  } catch (error) {
    return { contract: 'runalith-phase2-preflight-custody/v1', status: 'BLOCKED', verified: false,
      authorityKeyProvisioningAuthenticated: false,
      blockers: [error?.code || 'PHASE2_CUSTODY_VERIFICATION_FAILED'],
      message: String(error?.message || error).slice(0, 1000),
      requiredHostPolicyPath: HOST_PHASE2_CUSTODY_POLICY_PATH };
  }
}

export function inspectBundle(bundlePath, { requireCurrentSource = false } = {}) {
  const absolute = path.resolve(bundlePath);
  if (!absolute.toLowerCase().endsWith('.mcpb')) throw new Error('candidate path must end in .mcpb');
  const bytes = readRegularFile(absolute);
  validateZipEntryTypes(bytes);
  const listed = run('unzip', ['-Z1', absolute]).split(/\r?\n/).filter(Boolean);
  if (!listed.length || listed.length > MAX_ARCHIVE_ENTRIES || new Set(listed).size !== listed.length) throw new Error('archive is empty, oversized, or contains duplicate names');
  const normalized = new Map();
  const files = new Set();
  let expandedBytes = 0;
  for (const name of listed) {
    const isDirectory = name.endsWith('/');
    const portableName = isDirectory ? name.slice(0, -1) : name;
    if (!isSafePortableArchivePath(portableName) || Buffer.byteLength(name, 'utf8') > MAX_PATH_BYTES) throw new Error(`unsafe or overlong archive name: ${JSON.stringify(name)}`);
    const canonical = portableName.normalize('NFKC').toLocaleLowerCase('en-US');
    const previous = normalized.get(canonical);
    if (previous && previous !== name) throw new Error(`Unicode/case-normalization ZIP path collision: ${JSON.stringify(previous)} vs ${JSON.stringify(name)}`);
    normalized.set(canonical, name);
    if (!isDirectory) files.add(name);
  }
  for (const name of files) {
    const parts = name.split('/');
    for (let index = 1; index < parts.length; index++) {
      const prefix = parts.slice(0, index).join('/');
      if (files.has(prefix)) throw new Error(`archive file/directory prefix conflict: ${JSON.stringify(prefix)} and ${JSON.stringify(name)}`);
    }
  }
  const details = run('unzip', ['-l', absolute]);
  const totalLine = details.trim().split(/\r?\n/).at(-1) || '';
  const summary = totalLine.match(/^\s*(\d+)\s+(\d+)\s+files?\s*$/);
  if (!summary || Number(summary[1]) > MAX_UNPACKED_BYTES || Number(summary[2]) > MAX_ARCHIVE_ENTRIES) {
    throw new Error('archive expanded size could not be verified or exceeds the size ceiling');
  }
  expandedBytes = Number(summary[1]);
  const modes = run('zipinfo', ['-l', absolute]);
  for (const line of modes.split(/\r?\n/)) {
    const mode = line.match(/^([bcdlps-][rwxstST-]{9})\s/);
    if (mode && !['-', 'd'].includes(mode[1][0])) throw new Error(`archive contains a non-regular ZIP entry: ${line.slice(0, 150)}`);
  }
  const manifestBytes = run('unzip', ['-p', absolute, 'manifest.json'], { encoding: 'buffer' });
  const packageBytes = run('unzip', ['-p', absolute, 'package.json'], { encoding: 'buffer' });
  const manifest = safeJson(Buffer.from(manifestBytes).toString('utf8'), 'bundle manifest');
  const packageJson = safeJson(Buffer.from(packageBytes).toString('utf8'), 'bundle package metadata');
  const entry = manifest.server?.entry_point;
  if (manifest.name !== 'runalith-agent-orchestrator' || manifest.server?.type !== 'node' ||
      typeof manifest.version !== 'string' || packageJson.version !== manifest.version || packageJson.main !== entry ||
      packageJson.scripts?.start !== `node ${entry}` ||
      packageJson.type !== 'module' || typeof entry !== 'string' || !files.has(entry) || !/^[A-Za-z0-9._/-]+$/.test(entry) ||
      entry.startsWith('/') || entry.split('/').some(part => !part || part === '.' || part === '..') ||
      manifest.server?.mcp_config?.command !== 'node' ||
      JSON.stringify(manifest.server?.mcp_config?.args) !== JSON.stringify([`${'${__dirname}/'}${entry}`]) ||
      !Array.isArray(manifest.tools) || !manifest.tools.length ||
      manifest.tools.some(tool => !tool || typeof tool.name !== 'string' || !tool.name.trim() ||
        typeof tool.description !== 'string' || !tool.description.trim()) ||
      new Set(manifest.tools.map(t => t.name)).size !== manifest.tools.length ||
      !files.has('server/index.js')) {
    throw new Error('candidate manifest/package metadata, entry point, args or tool declarations do not satisfy the Runalith package contract');
  }
  const archivedRuntime = Buffer.from(run('unzip', ['-p', absolute, entry], { encoding: 'buffer' }));
  const archivedHistorical = Buffer.from(run('unzip', ['-p', absolute, 'server/index.js'], { encoding: 'buffer' }));
  if (!archivedRuntime.length || sha256(archivedHistorical) !== PINNED_HISTORICAL_SERVER_SHA256) {
    throw new Error('candidate is missing its selected runtime or has drifted from the historical server/index.js pin');
  }
  if (requireCurrentSource) {
    const sourcePackage = safeJson(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'), 'repository package.json');
    const sourceManifestBytes = fs.readFileSync(path.join(ROOT, 'plugin/manifest.json'));
    const sourceManifest = safeJson(sourceManifestBytes.toString('utf8'), 'repository plugin manifest');
    if (entry !== sourcePackage.runtimeEntryPoint || manifest.version !== sourcePackage.version ||
        manifest.version !== sourceManifest.version || !sourceManifestBytes.equals(Buffer.from(run('unzip', ['-p', absolute, 'manifest.json'], { encoding: 'buffer' }))) ||
        !archivedRuntime.equals(readRegularFile(path.join(ROOT, entry))) ||
        !archivedHistorical.equals(readRegularFile(path.join(ROOT, 'server/index.js')))) {
      throw new Error('candidate package does not match the versioned source runtime, manifest, and pinned historical runtime in this workspace');
    }
  }
  return { path: absolute, sha256: sha256(bytes), sizeBytes: bytes.byteLength, expandedBytes,
    version: manifest.version, entryPoint: entry, toolCount: manifest.tools.length, archiveEntryCount: listed.length,
    manifest, packageJson, entries: listed };
}

export function smokeCandidate(bundlePath, timeoutMs = 180_000) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/test-mcpb-candidate.mjs'), bundlePath], {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`isolated extracted-runtime acceptance failed (exit=${result.status ?? result.signal}): ${(result.stderr || result.stdout || '').slice(-4000)}`);
  return { passed: true, output: (result.stdout || '').trim().slice(-2500) };
}

export function listRuntimeProcesses(pluginId, procRoot = '/proc') {
  let entries;
  try { entries = fs.readdirSync(procRoot); }
  catch { return []; }
  const escapedId = pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // RC.6+ packages use a versioned entry point (for example
  // server/index-v1.0.9-rc.8.js). Match both that canonical form and the
  // historical server/index.js form; requiring only index.js made the live
  // RC.8 process invisible to read-only rollout verification even though the
  // host registry and process command line agreed on the generation.
  const pattern = new RegExp(`[/\\\\]plugins[/\\\\]${escapedId}[/\\\\]g-[^/\\\\]+[/\\\\]server[/\\\\]index(?:-v[0-9A-Za-z.-]+)?\\.js$`);
  const found = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      const args = fs.readFileSync(path.join(procRoot, name, 'cmdline')).toString('utf8').split('\0').filter(Boolean);
      const entry = args.find(value => pattern.test(value));
      if (!entry) continue;
      let ppid = null;
      let parentArgs = [];
      try {
        const status = fs.readFileSync(path.join(procRoot, name, 'status'), 'utf8');
        ppid = Number(status.match(/^PPid:\s*(\d+)$/m)?.[1]);
        if (!Number.isInteger(ppid) || ppid < 1) ppid = null;
        if (ppid !== null) parentArgs = fs.readFileSync(path.join(procRoot, String(ppid), 'cmdline'))
          .toString('utf8').split('\0').filter(Boolean);
      } catch {}
      const parentExe = parentArgs[0] || null;
      const parentBase = parentExe ? path.basename(parentExe).toLowerCase() : '';
      const parentLooksLikeHost = /chat-on-steroids/.test(parentBase) ||
        /chat on steroids/i.test(parentExe || '');
      const generationRoot = path.resolve(path.dirname(entry), '..');
      found.push({ pid, ppid, parentExe, parentArgs, parentLooksLikeHost,
        entryPoint: path.resolve(entry), generationRoot, args });
    } catch {}
  }
  return found.sort((a, b) => a.pid - b.pid);
}

export function workflowDbSummary(dbPath) {
  const absolute = path.resolve(dbPath);
  const result = { path: absolute, readable: false, integrityCheck: null, foreignKeyViolations: null,
    jobs: null, events: null, tasks: null, artifacts: null, results: null,
    stateCounts: [], taskStatusCounts: [], executingJobs: null, runningTasks: null,
    activeLeases: null, blockers: [] };
  const db = new DatabaseSync(absolute, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    for (const table of ['jobs', 'events', 'tasks', 'artifacts', 'results', 'task_leases']) {
      if (!tables.has(table)) throw new Error(`workflow DB is missing expected table ${table}`);
    }
    result.integrityCheck = db.prepare('PRAGMA quick_check').all().map(row => row.quick_check);
    result.foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
    if (result.integrityCheck.length !== 1 || result.integrityCheck[0] !== 'ok') result.blockers.push('WORKFLOW_DB_INTEGRITY_FAILED');
    if (result.foreignKeyViolations !== 0) result.blockers.push('WORKFLOW_DB_FOREIGN_KEY_VIOLATIONS');
    for (const table of ['jobs', 'events', 'tasks', 'artifacts', 'results']) result[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    result.stateCounts = db.prepare('SELECT state,status,COUNT(*) AS n FROM jobs GROUP BY state,status ORDER BY state,status').all();
    result.taskStatusCounts = db.prepare('SELECT status,COUNT(*) AS n FROM tasks GROUP BY status ORDER BY status').all();
    // Lifecycle drain is keyed to the durable execution state, not the status
    // column: inconsistent status metadata must never hide an EXECUTING job.
    result.executingJobs = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE UPPER(state)='EXECUTING'").get().n;
    result.runningTasks = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE lower(status)='running'").get().n;
    const leaseStates = db.prepare('SELECT state,expires_at FROM task_leases').all();
    const nowMs = Date.now();
    result.activeLeases = leaseStates.filter(row => {
      if (['released', 'expired', 'cancelled'].includes(String(row.state).toLowerCase())) return false;
      if (typeof row.expires_at !== 'string' || !row.expires_at.trim()) return true;
      const expiryMs = Date.parse(row.expires_at);
      // Malformed/ambiguous lease expiry is a live blocker, never evidence that
      // a lease is safe to ignore during an upgrade.
      return !Number.isFinite(expiryMs) || expiryMs > nowMs;
    }).length;
    result.readable = true;
    return result;
  } catch (error) {
    result.blockers.push('WORKFLOW_DB_READ_FAILED');
    result.error = String(error?.message || error);
    return result;
  } finally { db.close(); }
}

const AGG_TRUST_ENVIRONMENT_KEYS = new Set([
  'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON', 'AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID',
  'AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM', 'AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON',
  'AGG_REVIEW_IDENTITY_PROVIDER_ID', 'AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM'
]);

function readRuntimeTrustEnvironment(pid, procRoot) {
  const raw = fs.readFileSync(path.join(procRoot, String(pid), 'environ'));
  const environment = {};
  for (const item of raw.toString('utf8').split('\0')) {
    const separator = item.indexOf('=');
    if (separator < 1) continue;
    const key = item.slice(0, separator);
    if (AGG_TRUST_ENVIRONMENT_KEYS.has(key)) environment[key] = item.slice(separator + 1);
  }
  return environment;
}

function inspectRuntimeTrustLedger(pid, { procRoot = '/proc', configurations = [] } = {}) {
  const blocked = (code, message, details = {}) => ({ available: false, status: 'BLOCKED', source: 'active_runtime_open_file_descriptor',
    blockers: [{ code, message }], ...details });
  const fdDirectory = path.join(procRoot, String(pid), 'fd');
  let descriptors;
  try { descriptors = fs.readdirSync(fdDirectory); }
  catch {
    return blocked('AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE', 'cannot inspect the active runtime file descriptors for its separate trust ledger');
  }
  const candidates = [];
  const workflowCandidates = [];
  for (const descriptor of descriptors) {
    const descriptorPath = path.join(fdDirectory, descriptor);
    let target;
    try { target = fs.readlinkSync(descriptorPath); } catch { continue; }
    if (path.basename(target) !== 'agg-trust-configuration.db' || target.endsWith(' (deleted)')) continue;
    candidates.push({ descriptor, descriptorPath, target });
  }
  for (const descriptor of descriptors) {
    const descriptorPath = path.join(fdDirectory, descriptor);
    let target;
    try { target = fs.readlinkSync(descriptorPath); } catch { continue; }
    if (path.basename(target) === 'workflow.db' && !target.endsWith(' (deleted)')) {
      workflowCandidates.push({ descriptor, descriptorPath, target });
    }
  }
  if (candidates.length !== 1) {
    return blocked('AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE',
      `expected exactly one open agg-trust-configuration.db file descriptor in active runtime; found ${candidates.length}`,
      { matchingDescriptorCount: candidates.length });
  }

  const candidate = candidates[0];
  let ledgerPath;
  let descriptorStat;
  let pathStat;
  try {
    ledgerPath = fs.realpathSync(candidate.target);
    descriptorStat = fs.statSync(candidate.descriptorPath, { bigint: true });
    pathStat = fs.statSync(ledgerPath, { bigint: true });
  } catch {
    return blocked('AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE', 'active runtime trust-ledger descriptor does not resolve to a readable canonical file');
  }
  if (!path.isAbsolute(ledgerPath) || path.basename(ledgerPath) !== 'agg-trust-configuration.db' ||
      !descriptorStat.isFile() || !pathStat.isFile() || descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino ||
      fs.realpathSync(candidate.target) !== ledgerPath) {
    return blocked('AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE', 'trust-ledger path no longer matches the exact inode opened by the active runtime');
  }
  if (workflowCandidates.length !== 1) {
    return blocked('AGG_TRUST_CONFIG_LEDGER_WORKFLOW_SEPARATION_UNVERIFIED',
      `expected exactly one open workflow.db descriptor to prove trust-ledger separation; found ${workflowCandidates.length}`,
      { workflowDescriptorCount: workflowCandidates.length });
  }
  try {
    const workflowStat = fs.statSync(workflowCandidates[0].descriptorPath, { bigint: true });
    if (!workflowStat.isFile() || descriptorStat.dev === workflowStat.dev && descriptorStat.ino === workflowStat.ino) {
      return blocked('AGG_TRUST_CONFIG_LEDGER_WORKFLOW_SEPARATION_UNVERIFIED',
        'the active runtime trust-ledger descriptor is the same inode as its workflow database');
    }
  } catch {
    return blocked('AGG_TRUST_CONFIG_LEDGER_WORKFLOW_SEPARATION_UNVERIFIED', 'cannot verify distinct active workflow and trust-ledger database inodes');
  }

  let db;
  try {
    db = new DatabaseSync(ledgerPath, { readOnly: true });
    db.exec('PRAGMA query_only=ON');
    db.exec('BEGIN');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    if (!tables.has('adaptive_goal_trust_configuration_history')) {
      return blocked('AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE', 'active runtime trust ledger has no anti-rollback configuration history table');
    }
    const domains = {};
    const blockers = [];
    for (const configuration of configurations) {
      const history = inspectAdaptiveGoalTrustConfigurationHistory(db, configuration.domain, configuration);
      const latest = history.latest || null;
      const exactCurrent = history.status === 'current_or_forward' && latest !== null &&
        configuration.configVersion === latest.config_version &&
        configuration.configurationFingerprint === latest.configuration_fingerprint &&
        configuration.providerId === latest.provider_id;
      domains[configuration.domain] = {
        status: exactCurrent ? 'CURRENT_VERSION_FINGERPRINT_AND_PROVIDER_MATCH' : history.status,
        currentConfigVersion: configuration.configVersion,
        currentConfigurationFingerprint: configuration.configurationFingerprint,
        currentProviderId: configuration.providerId,
        latestRecordedConfigVersion: latest?.config_version ?? null,
        latestRecordedConfigurationFingerprint: latest?.configuration_fingerprint ?? null,
        latestRecordedProviderId: latest?.provider_id ?? null,
        observedAt: latest?.observed_at ?? null,
        verified: exactCurrent,
        ...(history.code ? { code: history.code } : {})
      };
      if (!exactCurrent) {
        const code = history.code || (history.status === 'not_yet_observed'
          ? 'AGG_TRUST_CONFIG_LEDGER_CONFIG_NOT_RECORDED' : 'AGG_TRUST_CONFIG_LEDGER_NOT_CURRENT');
        blockers.push({ code,
          message: `trust domain ${configuration.domain} is not proven to match its latest durable anti-rollback record (${history.status})` });
      }
    }
    return {
      available: blockers.length === 0,
      status: blockers.length ? 'BLOCKED' : 'CURRENT_FOR_ALL_DOMAINS',
      source: 'active_runtime_open_file_descriptor',
      ledgerPath,
      historySnapshot: 'read_only_sqlite_transaction',
      descriptor: candidate.descriptor,
      domains,
      blockers
    };
  } catch (error) {
    return blocked('AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE', `cannot inspect active runtime trust-ledger state read-only: ${String(error?.message || error)}`);
  } finally {
    try { db?.close(); } catch {}
  }
}

function externalAntiRollbackAnchorNotConfigured() {
  return { verified: false, status: 'NOT_CONFIGURED',
    contract: 'host-monotonic-trust-ledger-checkpoint/v1',
    requiredFields: ['authorityId', 'source', 'checkpointSequence', 'checkpointDigest', 'previousCheckpointDigest',
      'ledgerStateSha256', 'trustDomainStateSha256', 'candidateSha256', 'rollbackSha256', 'signatureVerified',
      'independentOfLocalLedger', 'observedAt'],
    blockers: [{ code: 'PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED',
      message: 'no independently protected host monotonic checkpoint verifier is configured; local SQLite history cannot detect whole-ledger restore' }] };
}

export function inspectRuntimeTrustConfiguration(pid, { procRoot = '/proc', now = Date.now() } = {}) {
  try {
    const environment = readRuntimeTrustEnvironment(pid, procRoot);
    const sourceVerifier = loadAdaptiveGoalTrustConfiguration({
      configJsonEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON',
      providerEnv: 'AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID',
      publicKeyEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM',
      domain: 'goal_idea_verifier', scope: 'agg.goal_idea_graph.verify', now, environment
    });
    const reviewer = loadAdaptiveGoalTrustConfiguration({
      configJsonEnv: 'AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON', providerEnv: 'AGG_REVIEW_IDENTITY_PROVIDER_ID',
      publicKeyEnv: 'AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM',
      domain: 'action_intent_reviewer', scope: 'agg.action_intent.review', now, environment
    });
    if (sourceVerifier.configurationSource !== 'admin_json_environment' || sourceVerifier.configVersion < 1 ||
        reviewer.configurationSource !== 'admin_json_environment' || reviewer.configVersion < 1) {
      throw Object.assign(new Error('production rollout requires schema-valid, versioned JSON trust configuration for both independent domains; legacy single-key configuration is migration-only'),
        { code: 'PRODUCTION_AGG_TRUST_JSON_CONFIGURATION_REQUIRED' });
    }
    assertAdaptiveGoalTrustDomainsDisjoint(sourceVerifier, reviewer);
    if (!sourceVerifier.available || !reviewer.available) {
      throw Object.assign(new Error('one or both trust domains have no currently usable, non-revoked root inside its validity window'),
        { code: 'PRODUCTION_AGG_TRUST_ROOT_NOT_CURRENT' });
    }
    const trustLedger = inspectRuntimeTrustLedger(pid, { procRoot, configurations: [sourceVerifier, reviewer] });
    if (!trustLedger.available) {
      return {
        available: false,
        status: 'BLOCKED',
        source: 'active_runtime_process_environment',
        domains: {
          goal_idea_verifier: adaptiveGoalTrustConfigurationStatus(sourceVerifier),
          action_intent_reviewer: adaptiveGoalTrustConfigurationStatus(reviewer)
        },
        separation: { providerIdsDistinct: sourceVerifier.providerId !== reviewer.providerId,
          publicRootsDisjoint: !sourceVerifier.roots.some(root => reviewer.roots.some(other => other.trustRootSha256 === root.trustRootSha256)) },
        trustLedger,
        externalAntiRollbackAnchor: externalAntiRollbackAnchorNotConfigured(),
        blockers: [{ code: 'PRODUCTION_AGG_TRUST_CONFIGURATION_LEDGER_NOT_CURRENT',
          message: 'effective host JSON config does not have exact current version/fingerprint/provider evidence in the active runtime trust ledger',
          details: trustLedger.blockers }]
      };
    }
    return {
      available: true,
      status: 'CONFIGURED_IN_ACTIVE_RUNTIME_ENVIRONMENT',
      source: 'active_runtime_process_environment',
      domains: {
        goal_idea_verifier: adaptiveGoalTrustConfigurationStatus(sourceVerifier),
        action_intent_reviewer: adaptiveGoalTrustConfigurationStatus(reviewer)
      },
      separation: { providerIdsDistinct: sourceVerifier.providerId !== reviewer.providerId,
        publicRootsDisjoint: !sourceVerifier.roots.some(root => reviewer.roots.some(other => other.trustRootSha256 === root.trustRootSha256)) },
      trustLedger,
      externalAntiRollbackAnchor: externalAntiRollbackAnchorNotConfigured(),
      blockers: []
    };
  } catch (error) {
    return { available: false, status: 'BLOCKED', source: 'active_runtime_process_environment',
      externalAntiRollbackAnchor: externalAntiRollbackAnchorNotConfigured(),
      blockers: [{ code: error?.code || 'PRODUCTION_AGG_TRUST_CONFIGURATION_UNVERIFIED',
        message: String(error?.message || error) }] };
  }
}

export function inspectHost({ appRoot = APP_ROOT_DEFAULT, workflowDb = null, procRoot = '/proc' } = {}) {
  const registryPath = path.join(path.resolve(appRoot), 'state', 'plugins.json');
  const host = { appRoot: path.resolve(appRoot), registryPath, registryReadable: false, plugin: null,
    processes: [], installedGeneration: null, database: null,
    trustConfiguration: { available: false, status: 'UNVERIFIED', blockers: [{ code: 'PRODUCTION_AGG_TRUST_CONFIGURATION_UNVERIFIED', message: 'active runtime environment was not inspected' }] }, blockers: [] };
  try {
    const registry = safeJson(readRegularFile(registryPath, 16 * 1024 * 1024).toString('utf8'), 'host plugin registry');
    if (!Array.isArray(registry)) throw new Error('host plugin registry root must be an array');
    host.registryReadable = true;
    const matches = registry.filter(item => item?.name === 'Runalith' && item?.source?.kind === 'mcpb');
    if (matches.length !== 1) throw new Error(`expected exactly one enabled/registered Runalith MCPB entry; found ${matches.length}`);
    host.plugin = matches[0];
    if (host.plugin.enabled !== true || host.plugin.status !== 'ready') host.blockers.push('HOST_PLUGIN_NOT_READY');
    host.processes = listRuntimeProcesses(host.plugin.id, procRoot);
    if (host.processes.length !== 1) host.blockers.push(host.processes.length === 0 ? 'HOST_RUNTIME_PROCESS_NOT_FOUND' : 'HOST_RUNTIME_PROCESS_AMBIGUOUS');
    if (host.processes.length === 1) {
      const process = host.processes[0];
      host.trustConfiguration = inspectRuntimeTrustConfiguration(process.pid, { procRoot });
      if (!process.parentLooksLikeHost) host.blockers.push('HOST_PROCESS_OWNER_NOT_VERIFIED');
      const manifestPath = path.join(process.generationRoot, 'manifest.json');
      const packagePath = path.join(process.generationRoot, 'package.json');
      const manifest = safeJson(readRegularFile(manifestPath, 4 * 1024 * 1024).toString('utf8'), 'installed generation manifest');
      const packageJson = safeJson(readRegularFile(packagePath, 4 * 1024 * 1024).toString('utf8'), 'installed generation package metadata');
      const relativeEntry = path.relative(process.generationRoot, process.entryPoint).split(path.sep).join('/');
      if (manifest.version !== host.plugin.version || packageJson.version !== manifest.version || packageJson.main !== manifest.server?.entry_point ||
          relativeEntry !== manifest.server?.entry_point || !fs.statSync(process.entryPoint).isFile()) host.blockers.push('HOST_PROCESS_PACKAGE_IDENTITY_MISMATCH');
      host.installedGeneration = { path: process.generationRoot, pid: process.pid, entryPoint: process.entryPoint,
        parentPid: process.ppid, parentExe: process.parentExe, parentLooksLikeHost: process.parentLooksLikeHost,
        entryPointSha256: sha256(readRegularFile(process.entryPoint)), manifestVersion: manifest.version,
        packageVersion: packageJson.version, packageMain: packageJson.main, registryVersion: host.plugin.version,
        sourceArchiveName: host.plugin.source?.path || null,
        sourceArchiveReferenceIsAbsolute: typeof host.plugin.source?.path === 'string' && path.isAbsolute(host.plugin.source.path),
        sourceArchiveAtDeclaredPathPresent: typeof host.plugin.source?.path === 'string' && path.isAbsolute(host.plugin.source.path)
          ? fs.existsSync(host.plugin.source.path) : null };
      if (workflowDb) host.database = workflowDbSummary(workflowDb);
      else {
        const fdDir = path.join(procRoot, String(process.pid), 'fd');
        let dbPath = WORKFLOW_DB_DEFAULT;
        try {
          const openDatabases = fs.readdirSync(fdDir).map(fd => {
            try { return fs.readlinkSync(path.join(fdDir, fd)); } catch { return null; }
          }).filter(value => value && /(?:^|\/)workflow\.db$/.test(value));
          if (openDatabases.length === 1) dbPath = openDatabases[0];
        } catch {}
        host.database = workflowDbSummary(dbPath);
      }
    }
  } catch (error) {
    host.blockers.push('HOST_INSPECTION_FAILED');
    host.error = String(error?.message || error);
  }
  if (!host.database && workflowDb) host.database = workflowDbSummary(workflowDb);
  if (host.database?.blockers?.length) host.blockers.push(...host.database.blockers);
  return host;
}

/**
 * Validate the host checkpoint report's shape and release binding. Caller-
 * controlled booleans such as `signatureVerified: true` are assertions, not
 * evidence. Only the frozen object emitted by verifyExternalAntiRollbackAnchorForPreflight
 * after the root-pinned adapter, separate store-attestation root, signed checkpoint,
 * external CAS and signed post-commit receipt all verify can open this sub-gate.
 */
export function validateExternalAntiRollbackAnchorReport(anchor, { candidateSha256, rollbackSha256, now = Date.now() } = {}) {
  if (anchor && VERIFIED_EXTERNAL_CHECKPOINT_RESULTS.has(anchor) && anchor.verified === true &&
      anchor.status === 'VERIFIED' && anchor.candidateSha256 === candidateSha256 &&
      anchor.rollbackSha256 === rollbackSha256 && anchor.productionAuthorityEstablished === true &&
      anchor.externalStoreAttestationVerified === true && anchor.commitReceiptVerified === true &&
      anchor.checkpointStateAdvanced === true && anchor.nonceConsumed === true &&
      SHA256_HEX.test(anchor.checkpointDigest || '') && SHA256_HEX.test(anchor.previousCheckpointDigest || '') &&
      SHA256_HEX.test(anchor.ledgerStateSha256 || '') && SHA256_HEX.test(anchor.trustDomainStateSha256 || '')) {
    const observed = Date.parse(anchor.observedAt || '');
    if (Number.isFinite(observed) && new Date(observed).toISOString() === anchor.observedAt &&
        observed <= now + 5_000 && now - observed <= 5 * 60_000) {
      return { verified: true, shapeValid: true, blockers: [], source: 'authenticated-host-checkpoint-adapter',
        policySha256: anchor.policySha256, adapterSha256: anchor.adapterSha256,
        externalStoreId: anchor.externalStoreId, checkpointSequence: anchor.checkpointSequence,
        checkpointDigest: anchor.checkpointDigest };
    }
  }
  const blockers = [];
  if (!anchor || anchor.verified !== true || anchor.status !== 'VERIFIED') blockers.push('EXTERNAL_TRUST_ANCHOR_NOT_VERIFIED');
  if (anchor?.source !== 'host_monotonic_checkpoint_service' || typeof anchor?.authorityId !== 'string' || !anchor.authorityId.trim()) {
    blockers.push('EXTERNAL_TRUST_ANCHOR_AUTHORITY_UNVERIFIED');
  }
  if (!Number.isSafeInteger(anchor?.checkpointSequence) || anchor.checkpointSequence < 1 ||
      !SHA256_HEX.test(anchor?.checkpointDigest || '') || !SHA256_HEX.test(anchor?.previousCheckpointDigest || '')) {
    blockers.push('EXTERNAL_TRUST_ANCHOR_MONOTONIC_CHAIN_INVALID');
  }
  if (!SHA256_HEX.test(anchor?.ledgerStateSha256 || '') || !SHA256_HEX.test(anchor?.trustDomainStateSha256 || '')) {
    blockers.push('EXTERNAL_TRUST_ANCHOR_STATE_BINDING_INVALID');
  }
  if (anchor?.signatureVerified !== true || anchor?.independentOfLocalLedger !== true) {
    blockers.push('EXTERNAL_TRUST_ANCHOR_INDEPENDENCE_OR_SIGNATURE_UNVERIFIED');
  }
  if (!SHA256_HEX.test(candidateSha256 || '') || anchor?.candidateSha256 !== candidateSha256 ||
      !SHA256_HEX.test(rollbackSha256 || '') || anchor?.rollbackSha256 !== rollbackSha256) {
    blockers.push('EXTERNAL_TRUST_ANCHOR_RELEASE_HASH_MISMATCH');
  }
  const observedAt = typeof anchor?.observedAt === 'string' ? Date.parse(anchor.observedAt) : NaN;
  if (!Number.isFinite(observedAt) || new Date(observedAt).toISOString() !== anchor?.observedAt ||
      observedAt > now + 5_000 || now - observedAt > 5 * 60_000) {
    blockers.push('EXTERNAL_TRUST_ANCHOR_STALE_OR_NONCANONICAL');
  }
  const shapeValid = blockers.length === 0;
  // Deliberately unconditional: this module has no independent checkpoint
  // signature verifier or protected monotonic-state connector. A structurally
  // valid JSON report must never be mistaken for proof just because it contains
  // self-asserted `verified` / `signatureVerified` flags.
  blockers.push('EXTERNAL_TRUST_ANCHOR_CRYPTOGRAPHIC_VERIFIER_NOT_CONFIGURED');
  return { verified: false, shapeValid, blockers: [...new Set(blockers)] };
}

export function evaluateRolloutGate({ candidate, rollback, host, releaseEvidence = null, phase2CustodyEvidence = null }) {
  const blockers = [];
  if (!candidate?.verified) blockers.push('CANDIDATE_NOT_VERIFIED');
  if (!rollback?.verified) blockers.push('ROLLBACK_BUNDLE_NOT_VERIFIED');
  if (!isVerifiedPhase2CustodyEvidenceForBinding(phase2CustodyEvidence, candidate)) {
    blockers.push('PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED');
  }
  if (!isVerifiedReleaseEvidenceForBindings(releaseEvidence, candidate, rollback, host)) {
    blockers.push('INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED');
  }
  if (!host?.registryReadable || !host?.plugin || !host?.installedGeneration) blockers.push('HOST_RUNTIME_IDENTITY_UNVERIFIED');
  blockers.push(...(host?.blockers || []));
  if (!host?.database?.readable) blockers.push('WORKFLOW_DB_NOT_READABLE');
  if (host?.trustConfiguration?.available !== true) blockers.push('PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED');
  const anchorReport = validateExternalAntiRollbackAnchorReport(host?.trustConfiguration?.externalAntiRollbackAnchor, {
    candidateSha256: candidate?.sha256, rollbackSha256: rollback?.sha256
  });
  if (!anchorReport.verified) {
    blockers.push('PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED');
  }
  if (host?.database?.executingJobs > 0) blockers.push('ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN');
  if (host?.database?.runningTasks > 0) blockers.push('RUNNING_TASKS_MUST_DRAIN');
  if (host?.database?.activeLeases > 0) blockers.push('ACTIVE_TASK_LEASES_MUST_DRAIN');
  if (candidate?.version === host?.installedGeneration?.manifestVersion) blockers.push('CANDIDATE_VERSION_ALREADY_INSTALLED');
  if (rollback?.version && rollback.version !== host?.installedGeneration?.manifestVersion) blockers.push('ROLLBACK_VERSION_DOES_NOT_MATCH_INSTALLED_BASELINE');
  return { status: blockers.length ? 'BLOCKED' : 'READY_FOR_HOST_MANAGED_ACTIVATION', canActivateNow: blockers.length === 0,
    activationMechanism: 'Chat On Steroids host plugin manager / UI only; this CLI does not edit host registry or manage the plugin process',
    blockers: [...new Set(blockers)] };
}

function isVerifiedPhase2CustodyEvidenceForBinding(evidence, candidate) {
  return Boolean(evidence && VERIFIED_PHASE2_CUSTODY_RESULTS.has(evidence) && evidence.verified === true &&
    evidence.status === 'HOST_PINNED_PHASE2_PATH_CONTRACT_VERIFIED' &&
    evidence.authorityKeyProvisioningAuthenticated === true && evidence.manifestPathCount === 71 &&
    evidence.candidateSha256 === candidate?.sha256 && evidence.sourceCommit === evidence.hostPolicy?.sourceCommit &&
    evidence.sourceTreeOid === evidence.hostPolicy?.sourceTreeOid && SHA256_HEX.test(evidence.hostPolicy?.sha256 || '') &&
    evidence.hostPolicy?.ownerUid === 0 && (evidence.hostPolicy?.mode & 0o022) === 0);
}

function isVerifiedReleaseEvidenceForBindings(evidence, candidate, rollback, host) {
  return Boolean(evidence && VERIFIED_RELEASE_EVIDENCE_RESULTS.has(evidence) &&
    evidence.cryptographicEvidenceVerified === true && evidence.productionAuthorityEstablished === false &&
    evidence.candidate?.sha256 === candidate?.sha256 &&
    evidence.rollback?.sha256 === rollback?.sha256 && evidence.rollback?.version === rollback?.version &&
    evidence.baseline?.version === host?.installedGeneration?.manifestVersion &&
    evidence.baseline?.sha256 === rollback?.sha256 && rollback?.version === host?.installedGeneration?.manifestVersion);
}

export function verifyReleaseEvidenceForPreflight({ args, candidateBundle, rollback, host }) {
  const required = ['releasePolicy', 'provenance', 'verification', 'approval', 'releaseNonce'];
  const supplied = required.filter(key => typeof args[key] === 'string' && args[key].trim());
  const missing = required.filter(key => !supplied.includes(key));
  if (missing.length) {
    return { contract: 'runalith-release-evidence-verification/v1', status: 'BLOCKED',
      cryptographicEvidenceVerified: false, productionReleaseEligible: false, productionAuthorityEstablished: false,
      evidenceBlockers: [supplied.length ? 'RELEASE_EVIDENCE_ARGUMENT_SET_INCOMPLETE' : 'RELEASE_EVIDENCE_NOT_PROVIDED'],
      missingArguments: missing,
      notes: ['A local hash, source-alignment report or test result is not signed builder provenance or release approval.',
        'Even cryptographically verified evidence does not authenticate host trust provisioning or the external monotonic checkpoint.'] };
  }
  if (!rollback?.verified || !host?.installedGeneration) {
    return { contract: 'runalith-release-evidence-verification/v1', status: 'BLOCKED',
      cryptographicEvidenceVerified: false, productionReleaseEligible: false, productionAuthorityEstablished: false,
      evidenceBlockers: ['RELEASE_EVIDENCE_REQUIRES_VERIFIED_ROLLBACK_AND_INSTALLED_BASELINE'],
      notes: ['Release approval must bind the exact installed baseline and a byte-verified rollback artifact.'] };
  }
  try {
    // Reject caller-selected policy paths and noncanonical release scope before
    // opening caller-selectable DSSE evidence files. The policy path and scope
    // are both part of the release trust contract.
    const provisionedReleasePolicy = readHostProvisionedPolicy(HOST_RELEASE_POLICY_PATH,
      args.releasePolicy, 'release policy');
    const policyBytes = provisionedReleasePolicy.bytes;
    const policy = parseRunalithReleaseEvidenceJson(policyBytes, 'Runalith release policy');
    const policyScope = validateHostPinnedReleasePolicyScope(policy);
    const candidateBytes = readRegularFile(candidateBundle.path, MAX_BUNDLE_BYTES);
    const rollbackBytes = readRegularFile(rollback.path, MAX_BUNDLE_BYTES);
    const provenanceEnvelopeBytes = readRegularFile(args.provenance, 8 * 1024 * 1024);
    const verificationEnvelopeBytes = readRegularFile(args.verification, 8 * 1024 * 1024);
    const approvalEnvelopeBytes = readRegularFile(args.approval, 8 * 1024 * 1024);
    const provenanceEnvelope = parseRunalithReleaseEvidenceJson(provenanceEnvelopeBytes, 'SLSA provenance envelope');
    const verificationEnvelope = parseRunalithReleaseEvidenceJson(verificationEnvelopeBytes, 'candidate verification envelope');
    const approvalEnvelope = parseRunalithReleaseEvidenceJson(approvalEnvelopeBytes, 'release approval envelope');
    const evidence = verifyRunalithReleaseEvidence({ candidateBytes, policy, policyBytes,
      provenanceEnvelope, provenanceEnvelopeBytes, verificationEnvelope, verificationEnvelopeBytes,
      approvalEnvelope, approvalEnvelopeBytes, rollbackBytes, expectedNonce: args.releaseNonce,
      baselineVersion: host.installedGeneration.manifestVersion, baselineSha256: rollback.sha256,
      rollbackVersion: rollback.version, rollbackSha256: rollback.sha256 });
    evidence.hostPolicyProvisioning = { rootOwnedHostFileVerified: true,
      canonicalScopeVerified: policyScope.canonicalScopeVerified,
      sourceRepository: policyScope.sourceRepository, subjectName: policyScope.subjectName,
      expectedBuildType: policyScope.expectedBuildType, targetEnvironment: policyScope.targetEnvironment,
      policyVersion: policyScope.policyVersion,
      path: provisionedReleasePolicy.path, sha256: provisionedReleasePolicy.sha256,
      ownerUid: provisionedReleasePolicy.ownerUid, mode: provisionedReleasePolicy.mode };
    if (evidence.cryptographicEvidenceVerified === true && evidence.candidate?.sha256 === candidateBundle.sha256 &&
        evidence.hostPolicyProvisioning.rootOwnedHostFileVerified === true &&
        evidence.hostPolicyProvisioning.canonicalScopeVerified === true &&
        evidence.rollback?.sha256 === rollback.sha256 && evidence.rollback?.version === rollback.version &&
        evidence.baseline?.version === host.installedGeneration.manifestVersion && evidence.baseline?.sha256 === rollback.sha256) {
      VERIFIED_RELEASE_EVIDENCE_RESULTS.add(evidence);
    }
    return evidence;
  } catch (error) {
    return { contract: 'runalith-release-evidence-verification/v1', status: 'BLOCKED',
      cryptographicEvidenceVerified: false, productionReleaseEligible: false, productionAuthorityEstablished: false,
      evidenceBlockers: [error?.code || 'RELEASE_EVIDENCE_VERIFICATION_FAILED'],
      notes: [String(error?.message || error).slice(0, 1000),
        'No local verifier output can establish host trust-policy provisioning or authenticate the external monotonic checkpoint.'] };
  }
}

export function compareBundleToDirectory(bundle, directory) {
  const root = path.resolve(directory);
  const actualFiles = new Map();
  function visit(folder, relative = '') {
    for (const name of fs.readdirSync(path.join(folder, relative)).sort()) {
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new Error('unsafe path component in installed generation');
      const rel = relative ? `${relative}/${name}` : name;
      const filePath = path.join(folder, relative, name);
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) throw new Error(`installed generation contains a symlink: ${rel}`);
      if (stat.isDirectory()) visit(folder, rel);
      else if (stat.isFile()) actualFiles.set(rel, sha256(readRegularFile(filePath, MAX_UNPACKED_BYTES)));
      else throw new Error(`installed generation contains a non-regular object: ${rel}`);
    }
  }
  visit(root);
  const expectedFiles = bundle.entries.filter(entry => !entry.endsWith('/'));
  const mismatches = [];
  for (const entry of expectedFiles) {
    const expected = actualFiles.get(entry);
    if (!expected) { mismatches.push({ path: entry, reason: 'missing_installed_file' }); continue; }
    const observed = sha256(Buffer.from(run('unzip', ['-p', bundle.path, entry], { encoding: 'buffer' })));
    if (expected !== observed) mismatches.push({ path: entry, reason: 'content_hash_mismatch', installedSha256: expected, bundleSha256: observed });
  }
  for (const entry of actualFiles.keys()) if (!expectedFiles.includes(entry)) mismatches.push({ path: entry, reason: 'extra_installed_file' });
  return { matches: mismatches.length === 0 && actualFiles.size === expectedFiles.length,
    archiveFileCount: expectedFiles.length, installedFileCount: actualFiles.size, mismatches };
}

function writeAtomicJson(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tempPath, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tempPath, filePath);
  const dirFd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}

/** Publish a diagnostic report to a new canonical path without overwriting it. */
export function writeExclusiveJsonReport(filePath, value) {
  const destination = path.resolve(filePath);
  const parent = path.dirname(destination);
  const parentStat = fs.lstatSync(parent, { bigint: true });
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || fs.realpathSync(parent) !== parent) {
    throw new Error('report parent must be an existing canonical directory without symlink aliases');
  }
  if (fs.existsSync(destination)) throw new Error(`refusing to overwrite existing report: ${destination}`);
  const temporary = path.join(parent, `.${path.basename(destination)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // Hard-link publication is atomic and fails if the destination already exists.
    fs.linkSync(temporary, destination);
    fs.unlinkSync(temporary);
    const dirFd = fs.openSync(parent, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  return { path: destination, sha256: sha256(bytes), sizeBytes: bytes.length };
}

function assertPrivateSimulationRoot(root) {
  const absolute = path.resolve(root);
  const tmpRoot = path.resolve(os.tmpdir());
  if (absolute === tmpRoot || !absolute.startsWith(`${tmpRoot}${path.sep}`) ||
      !/^runalith-rollout-test-[A-Za-z0-9._-]+$/.test(path.basename(absolute))) {
    throw new Error(`simulation root must be an explicitly named private test directory under ${tmpRoot}`);
  }
  if (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink()) throw new Error('simulation root cannot be a symlink');
  return absolute;
}

function extractCandidate(bundle, destination) {
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  run('unzip', ['-q', bundle.path, '-d', destination], { timeout: 30_000 });
  const manifest = safeJson(fs.readFileSync(path.join(destination, 'manifest.json'), 'utf8'), 'staged manifest');
  const packageJson = safeJson(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'), 'staged package metadata');
  const selectedEntry = path.resolve(destination, manifest.server.entry_point);
  if (!selectedEntry.startsWith(`${destination}${path.sep}`) || !fs.statSync(selectedEntry).isFile() ||
      packageJson.main !== manifest.server.entry_point || packageJson.version !== manifest.version || manifest.version !== bundle.version) {
    throw new Error('staged generation does not preserve selected manifest/package identity');
  }
  for (const entry of bundle.entries.filter(name => !name.endsWith('/'))) {
    const filePath = path.resolve(destination, entry);
    if (!filePath.startsWith(`${destination}${path.sep}`) || !fs.statSync(filePath).isFile()) throw new Error(`staged bundle path missing or escaped: ${entry}`);
    if (sha256(readRegularFile(filePath)) !== sha256(Buffer.from(run('unzip', ['-p', bundle.path, entry], { encoding: 'buffer' })))) {
      throw new Error(`staged archive file differs from the exact candidate bytes: ${entry}`);
    }
  }
  return { manifest, packageJson, selectedEntry };
}

export function simulateRolloutInRoot({ bundlePath, root, failpoint = null, smoke = () => ({ passed: true }) }) {
  const privateRoot = assertPrivateSimulationRoot(root);
  const bundle = inspectBundle(bundlePath);
  if (!fs.existsSync(privateRoot)) fs.mkdirSync(privateRoot, { recursive: false, mode: 0o700 });
  const activePath = path.join(privateRoot, 'active-generation.json');
  const generationsPath = path.join(privateRoot, 'generations');
  fs.mkdirSync(generationsPath, { recursive: true, mode: 0o700 });
  let prior;
  if (fs.existsSync(activePath)) prior = safeJson(fs.readFileSync(activePath, 'utf8'), 'simulation active-generation marker');
  else {
    const priorRoot = path.join(generationsPath, 'g-1.0.9-rc.5-baseline');
    fs.mkdirSync(priorRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(priorRoot, 'baseline.json'), JSON.stringify({ version: '1.0.9-rc.5', synthetic: true }) + '\n', { flag: 'wx', mode: 0o600 });
    prior = { version: '1.0.9-rc.5', packageSha256: 'test-only-baseline', generation: priorRoot, state: 'active', synthetic: true };
    writeAtomicJson(activePath, prior);
  }
  if (prior.packageSha256 === bundle.sha256 && prior.version === bundle.version) {
    const activeGeneration = path.resolve(prior.generation || '');
    if (!activeGeneration.startsWith(`${generationsPath}${path.sep}`) || !fs.existsSync(activeGeneration) ||
        !compareBundleToDirectory(bundle, activeGeneration).matches) {
      throw new Error('active-generation marker matches this candidate but the on-disk generation does not; refusing idempotent success');
    }
    return { status: 'ALREADY_ACTIVE', idempotent: true, rollbackPerformed: false, prior, current: prior, bundleSha256: bundle.sha256, phases: ['preflight', 'already-active', 'active-generation-hash-verified'] };
  }
  const generationName = `g-${bundle.version}-${bundle.sha256.slice(0, 16)}`;
  const generationRoot = path.join(generationsPath, generationName);
  const phases = ['preflight'];
  let switched = false;
  const rollback = () => {
    writeAtomicJson(activePath, prior);
    const observed = safeJson(fs.readFileSync(activePath, 'utf8'), 'rolled-back active-generation marker');
    if (JSON.stringify(observed) !== JSON.stringify(prior)) throw new Error('rollback active-generation marker failed exact readback');
    return observed;
  };
  try {
    if (!fs.existsSync(generationRoot)) extractCandidate(bundle, generationRoot);
    else {
      const reused = inspectBundle(bundlePath);
      if (reused.sha256 !== bundle.sha256) throw new Error('generation name collision with a different candidate hash');
      const parity = compareBundleToDirectory(bundle, generationRoot);
      if (!parity.matches) throw new Error('existing staged generation differs from the exact candidate archive');
    }
    phases.push('staged-and-hash-verified');
    if (failpoint === 'after-stage') throw new Error('SIMULATED_FAILURE_AFTER_STAGE');
    const next = { version: bundle.version, packageSha256: bundle.sha256, generation: generationRoot, state: 'active', synthetic: true };
    writeAtomicJson(activePath, next);
    switched = true;
    phases.push('switched-atomically');
    if (failpoint === 'after-switch' || failpoint === 'health-check') throw new Error('SIMULATED_POST_SWITCH_HEALTH_FAILURE');
    const smokeResult = smoke(bundlePath);
    if (!smokeResult?.passed) throw new Error('candidate health smoke did not report passed');
    const observed = safeJson(fs.readFileSync(activePath, 'utf8'), 'post-switch active-generation marker');
    if (observed.packageSha256 !== bundle.sha256 || observed.version !== bundle.version || observed.generation !== generationRoot) {
      throw new Error('post-switch readback does not match the exact staged candidate');
    }
    phases.push('health-check-passed', 'post-switch-readback-passed');
    return { status: 'ROLLOUT_SIMULATED', idempotent: false, rollbackPerformed: false, prior, current: observed,
      bundleSha256: bundle.sha256, phases, smoke: { passed: true } };
  } catch (error) {
    const failure = String(error?.message || error);
    const recovered = switched ? rollback() : safeJson(fs.readFileSync(activePath, 'utf8'), 'pre-switch active-generation marker');
    phases.push(switched ? 'rollback-performed' : 'switch-not-performed');
    if (JSON.stringify(recovered) !== JSON.stringify(prior)) throw new Error(`rollout failed (${failure}) and rollback state could not be verified`);
    return { status: 'ROLLOUT_FAILED_ROLLED_BACK', idempotent: false, rollbackPerformed: switched,
      failure, prior, current: recovered, bundleSha256: bundle.sha256, phases };
  }
}

function validateBackupOutputPath(outPath) {
  const absolute = path.resolve(outPath);
  const tmpRoot = path.resolve(os.tmpdir());
  if (path.dirname(absolute) !== tmpRoot || !absolute.toLowerCase().endsWith('.mcpb')) {
    throw new Error(`rollback snapshots can only be written as .mcpb files directly under ${tmpRoot}`);
  }
  if (fs.existsSync(absolute) || fs.existsSync(`${absolute}.manifest.json`) || fs.lstatSync(tmpRoot).isSymbolicLink()) {
    throw new Error('refusing to overwrite an existing rollback bundle/manifest or use a symlink output parent');
  }
  return absolute;
}

export function createInstalledRollbackSnapshot({ outPath, appRoot = APP_ROOT_DEFAULT, procRoot = '/proc', workflowDb = null, smoke = smokeCandidate }) {
  const destination = validateBackupOutputPath(outPath);
  const host = inspectHost({ appRoot, procRoot, workflowDb });
  if (host.processes.length !== 1 || !host.installedGeneration || !host.plugin) throw new Error('cannot create rollback snapshot until the installed generation is identified unambiguously');
  const sourceRoot = host.installedGeneration.path;
  const beforeHashes = [];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runalith-installed-generation-snapshot-'));
  fs.chmodSync(tempRoot, 0o700);
  const copiedRoot = path.join(tempRoot, 'payload');
  fs.mkdirSync(copiedRoot, { mode: 0o700 });
  let bundleCreated = false;
  try {
    function copyTree(sourceDir, relativeDir = '') {
      const names = fs.readdirSync(path.join(sourceDir, relativeDir)).sort();
      for (const name of names) {
        if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new Error('unsafe installed path component');
        const relative = relativeDir ? `${relativeDir}/${name}` : name;
        const source = path.join(sourceDir, relative);
        const destinationPath = path.join(copiedRoot, relative);
        const stat = fs.lstatSync(source);
        if (stat.isSymbolicLink()) throw new Error(`installed generation contains a symlink; refusing rollback archive: ${relative}`);
        if (stat.isDirectory()) { fs.mkdirSync(destinationPath, { recursive: false, mode: 0o700 }); copyTree(sourceDir, relative); continue; }
        if (!stat.isFile() || stat.size > MAX_UNPACKED_BYTES) throw new Error(`installed generation contains unsupported/oversized file: ${relative}`);
        const bytes = readRegularFile(source, MAX_UNPACKED_BYTES);
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
        const fd = fs.openSync(destinationPath, 'wx', stat.mode & 0o111 ? 0o755 : 0o644);
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        const digest = sha256(bytes);
        beforeHashes.push({ path: relative, sizeBytes: bytes.length, sha256: digest });
        if (sha256(readRegularFile(source, MAX_UNPACKED_BYTES)) !== digest) throw new Error(`installed generation changed during snapshot: ${relative}`);
      }
    }
    copyTree(sourceRoot);
    if (!beforeHashes.some(item => item.path === 'server/index.js') ||
        beforeHashes.find(item => item.path === 'server/index.js')?.sha256 !== PINNED_HISTORICAL_SERVER_SHA256) {
      throw new Error('installed generation does not preserve the exact historical server/index.js hash');
    }
    const archiveRoots = fs.readdirSync(copiedRoot).sort();
    if (!archiveRoots.length) throw new Error('installed generation snapshot has no package files');
    run('zip', ['-X', '-q', '-r', destination, ...archiveRoots], { cwd: copiedRoot, timeout: 30_000 });
    bundleCreated = true;
    const actual = inspectBundle(destination);
    if (actual.version !== host.installedGeneration.manifestVersion || actual.sha256 !== sha256(readRegularFile(destination))) {
      throw new Error('rollback archive package identity or self-hash verification failed');
    }
    const copiedMap = new Map(beforeHashes.map(item => [item.path, item.sha256]));
    for (const entry of actual.entries.filter(name => !name.endsWith('/'))) {
      const expected = copiedMap.get(entry);
      const observed = sha256(Buffer.from(run('unzip', ['-p', destination, entry], { encoding: 'buffer' })));
      if (!expected || expected !== observed) throw new Error(`rollback archive bytes differ from installed generation: ${entry}`);
    }
    const smokeResult = smoke(destination);
    if (!smokeResult?.passed) throw new Error('rollback archive extracted-runtime smoke did not pass');
    const sidecar = { schemaVersion: 1, kind: 'runalith-installed-generation-rollback-snapshot', generatedAt: new Date().toISOString(),
      pluginId: host.plugin.id, pluginName: host.plugin.name, version: actual.version, sourceArchiveName: host.plugin.source?.path || null,
      sourceArchiveBytesNotAvailable: host.installedGeneration.sourceArchiveAtDeclaredPathPresent !== true,
      sourceGenerationPath: sourceRoot, entryPoint: host.installedGeneration.entryPoint,
      archiveSha256: actual.sha256, fileCount: beforeHashes.length, historicalServerSha256: PINNED_HISTORICAL_SERVER_SHA256,
      files: beforeHashes.sort((a, b) => a.path.localeCompare(b.path)), smoke: { passed: true },
      limitations: ['This is a content-derived rollback snapshot of the installed generation, not the original MCPB container bytes or a publisher attestation.'] };
    const fd = fs.openSync(`${destination}.manifest.json`, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(sidecar, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return { status: 'ROLLBACK_SNAPSHOT_READY', bundlePath: destination, manifestPath: `${destination}.manifest.json`,
      version: actual.version, archiveSha256: actual.sha256, sizeBytes: actual.sizeBytes, fileCount: beforeHashes.length,
      smoke: smokeResult, limitations: sidecar.limitations };
  } catch (error) {
    if (bundleCreated) {
      // Do not remove a failed candidate silently; preserve it for inspection.
    }
    throw error;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') return { command, help: true };
  const allowedOptions = {
    'backup-installed': new Set(['out', 'appRoot', 'procRoot', 'workflowDb']),
    preflight: new Set(['candidate', 'expectedSha256', 'rollbackBundle', 'releasePolicy', 'provenance', 'verification',
      'approval', 'releaseNonce', 'phase2Manifest', 'phase2Receipt', 'advanceExternalCheckpoint',
      'appRoot', 'workflowDb', 'report']),
    'verify-installed': new Set(['candidate', 'appRoot', 'workflowDb']),
    simulate: new Set(['candidate', 'failpoint'])
  };
  if (!allowedOptions[command]) throw new Error(`unsupported command ${command}; live activation is intentionally not exposed`);
  const args = {};
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index];
    if (token === '--help' || token === '-h') { args.help = true; continue; }
    if (!token.startsWith('--')) throw new Error(`unexpected positional argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!allowedOptions[command].has(key)) throw new Error(`unsupported option ${token} for command ${command}`);
    if (Object.hasOwn(args, key)) throw new Error(`duplicate option: ${token}`);
    if (key === 'advanceExternalCheckpoint') { args[key] = true; continue; }
    const value = rest[++index];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${token}`);
    args[key] = value;
  }
  return { command, ...args };
}

function usage() {
  console.log('Runalith release rollout readiness (host mutation intentionally unsupported)\n\n' +
    '  node scripts/runalith-rollout.mjs backup-installed --out /tmp/runalith-rollback.mcpb\n' +
    '  node scripts/runalith-rollout.mjs preflight --candidate <candidate.mcpb> --rollback-bundle <rollback.mcpb> [--report <new-report.json>] [--phase2-manifest <owner-signed-71-path.json> --phase2-receipt <builder-signed-receipt.json>] [--release-policy /etc/runalith/release-policy.json --provenance <builder.dsse.json> --verification <verifier.dsse.json> --approval <release-approval.dsse.json> --release-nonce <host-issued-once-only-hex>] [--advance-external-checkpoint]\n' +
    '  node scripts/runalith-rollout.mjs verify-installed --candidate <rc8.mcpb>\n' +
    '  node scripts/runalith-rollout.mjs simulate --candidate <rc8.mcpb> [--failpoint after-stage|after-switch|health-check]\n\n' +
    'preflight and verify-installed are read-only by default. Optional --advance-external-checkpoint is deliberately state-changing: it consumes a single-use nonce and advances the host-owned external security store only after signed continuity/CAS receipts verify. It does not install or activate a plugin or write the workflow DB. Phase 2 custody, release and checkpoint policies must be provisioned by the host administrator as root-owned, non-group/world-writable files under /etc/runalith. Production preflight also requires signed builder provenance, independent candidate-verification evidence and release approval bound to exact candidate/baseline/rollback bytes. Local SQLite is not an external monotonic anchor. backup-installed writes only a new non-overwriting .mcpb and manifest under /tmp. simulate uses a private /tmp generation directory. No command edits Chat On Steroids configuration, workflow DB, process state, or plugin installation.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command || args.command === '--help' || args.command === '-h') return usage();
  if (args.command === 'backup-installed') {
    if (!args.out) throw new Error('backup-installed requires --out');
    const result = createInstalledRollbackSnapshot({ outPath: args.out, appRoot: args.appRoot || APP_ROOT_DEFAULT,
      procRoot: args.procRoot || '/proc', workflowDb: args.workflowDb || null });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.command === 'preflight') {
    if (!args.candidate) throw new Error('preflight requires --candidate');
    const candidateBundle = inspectBundle(args.candidate, { requireCurrentSource: true });
    if (args.expectedSha256 && args.expectedSha256 !== candidateBundle.sha256) throw new Error(`candidate SHA-256 mismatch: expected ${args.expectedSha256}, observed ${candidateBundle.sha256}`);
    const candidateSmoke = smokeCandidate(candidateBundle.path);
    let rollback = null;
    if (args.rollbackBundle) {
      const rollbackBundle = inspectBundle(args.rollbackBundle);
      const rollbackSmoke = smokeCandidate(rollbackBundle.path);
      rollback = { verified: false, path: rollbackBundle.path, version: rollbackBundle.version, sha256: rollbackBundle.sha256,
        sizeBytes: rollbackBundle.sizeBytes, toolCount: rollbackBundle.toolCount, smoke: rollbackSmoke, installedFileParity: null };
    }
    const host = inspectHost({ appRoot: args.appRoot || APP_ROOT_DEFAULT, workflowDb: args.workflowDb || null });
    if (rollback && host.installedGeneration) {
      rollback.installedFileParity = compareBundleToDirectory(inspectBundle(rollback.path), host.installedGeneration.path);
      rollback.verified = rollback.smoke.passed && rollback.installedFileParity.matches;
    }
    const phase2CustodyEvidence = verifyPhase2CustodyForPreflight({ args, candidateBundle });
    const releaseEvidence = verifyReleaseEvidenceForPreflight({ args, candidateBundle, rollback, host });
    let externalCheckpoint = { status: 'NOT_REQUESTED', transition: { attempted: false, outcome: 'NOT_REQUESTED' },
      sideEffectContract: 'No external checkpoint state is changed unless --advance-external-checkpoint is explicitly supplied.' };
    if (args.advanceExternalCheckpoint) {
      externalCheckpoint = verifyExternalAntiRollbackAnchorForPreflight({
        candidateSha256: candidateBundle.sha256, rollbackSha256: rollback?.sha256
      });
      // Only a verifier-created, in-process result can reach the gate. When the
      // adapter is missing/untrusted or its result is invalid, attach no trusted
      // object; preserve the explicit error in the report and fail closed.
      if (externalCheckpoint.verified && VERIFIED_EXTERNAL_CHECKPOINT_RESULTS.has(externalCheckpoint.verified)) {
        host.trustConfiguration = { ...(host.trustConfiguration || {}), externalAntiRollbackAnchor: externalCheckpoint.verified };
      } else {
        host.trustConfiguration = { ...(host.trustConfiguration || {}), externalAntiRollbackAnchor: null };
      }
    }
    const decision = evaluateRolloutGate({ candidate: { verified: true, version: candidateBundle.version, sha256: candidateBundle.sha256 },
      rollback, host, releaseEvidence, phase2CustodyEvidence });
    const externalTransitionCommitted = externalCheckpoint.transition?.outcome === 'COMMITTED';
    const externalTransitionAmbiguous = externalCheckpoint.transition?.outcome === 'UNKNOWN_AFTER_COMMIT_ATTEMPT';
    const externalSecurityStoreMutationPerformed = externalTransitionCommitted ? true : externalTransitionAmbiguous ? null : false;
    const liveMutationPerformed = externalTransitionCommitted || externalTransitionAmbiguous;
    const report = { schemaVersion: 1, command: 'preflight', generatedAt: new Date().toISOString(),
      readOnly: args.advanceExternalCheckpoint !== true, liveMutationPerformed,
      hostLifecycleMutationPerformed: false, workflowDatabaseMutationPerformed: false,
      externalSecurityStoreMutationPerformed, externalCheckpoint,
      candidate: { verified: true, ...candidateBundle, smoke: candidateSmoke },
      rollback: rollback || { verified: false, status: 'not-provided' }, phase2CustodyEvidence, releaseEvidence, host, decision,
      exactActionStillRequired: decision.canActivateNow
        ? 'Use the host plugin UI to import/update this exact MCPB, then re-run verify-installed and query orchestrator_health through the live host-connected MCP client.'
        : 'No activation/restart is authorized by this report. Drain current work through its normal owner, provide a tested rollback bundle, rerun preflight, then use the host UI; do not kill the runtime process.' };
    if (args.report) {
      const published = writeExclusiveJsonReport(args.report, report);
      console.log(JSON.stringify({ status: decision.status, reportPath: published.path,
        reportSha256: published.sha256, reportSizeBytes: published.sizeBytes,
        canActivateNow: decision.canActivateNow, readOnly: report.readOnly,
        liveMutationPerformed: report.liveMutationPerformed,
        externalSecurityStoreMutationPerformed: report.externalSecurityStoreMutationPerformed,
        externalCheckpointTransition: externalCheckpoint.transition,
        blockers: decision.blockers }, null, 2));
    } else console.log(JSON.stringify(report, null, 2));
    if (!decision.canActivateNow) process.exitCode = 3;
    return;
  }
  if (args.command === 'verify-installed') {
    if (!args.candidate) throw new Error('verify-installed requires --candidate');
    const candidate = inspectBundle(args.candidate, { requireCurrentSource: false });
    const host = inspectHost({ appRoot: args.appRoot || APP_ROOT_DEFAULT, workflowDb: args.workflowDb || null });
    const comparisons = [];
    const blockers = [];
    let comparedFiles = 0;
    if (host.processes.length !== 1 || !host.installedGeneration) blockers.push('HOST_RUNTIME_IDENTITY_UNVERIFIED');
    else {
      const parity = compareBundleToDirectory(candidate, host.installedGeneration.path);
      comparedFiles = parity.archiveFileCount;
      comparisons.push(...parity.mismatches);
      if (!parity.matches) blockers.push('INSTALLED_FILE_PARITY_MISMATCH');
      if (host.installedGeneration.manifestVersion !== candidate.version || host.plugin.version !== candidate.version) blockers.push('INSTALLED_VERSION_MISMATCH');
      if (host.installedGeneration.entryPoint !== path.join(host.installedGeneration.path, candidate.entryPoint)) blockers.push('INSTALLED_ENTRYPOINT_MISMATCH');
    }
    blockers.push(...host.blockers);
    const report = { schemaVersion: 1, command: 'verify-installed', generatedAt: new Date().toISOString(), readOnly: true,
      liveMutationPerformed: false, candidate: { version: candidate.version, sha256: candidate.sha256, entryPoint: candidate.entryPoint, toolCount: candidate.toolCount },
      host: { plugin: host.plugin ? { id: host.plugin.id, version: host.plugin.version, enabled: host.plugin.enabled, status: host.plugin.status } : null,
        processCount: host.processes.length, installedGeneration: host.installedGeneration },
      comparedFiles, mismatches: comparisons, blockers, status: blockers.length ? 'MISMATCH' : 'FILES_MATCH_EXACTLY',
      note: 'File parity does not independently reveal the host-stored MCPB container hash. Query orchestrator_health through the live host-connected MCP client to verify the serving runtime.' };
    console.log(JSON.stringify(report, null, 2));
    if (blockers.length) process.exitCode = 4;
    return;
  }
  if (args.command === 'simulate') {
    if (!args.candidate) throw new Error('simulate requires --candidate');
    if (args.failpoint && !['after-stage', 'after-switch', 'health-check'].includes(args.failpoint)) throw new Error('unknown --failpoint');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runalith-rollout-test-'));
    fs.chmodSync(root, 0o700);
    try {
      const result = simulateRolloutInRoot({ bundlePath: args.candidate, root, failpoint: args.failpoint || null,
        smoke: pathArg => { const tested = smokeCandidate(pathArg); return { passed: tested.passed }; } });
      console.log(JSON.stringify({ ...result, simulationRoot: root, privateTestDirectory: true,
        hostPluginConfigChanged: false, liveWorkflowDatabaseChanged: false, liveProcessChanged: false }, null, 2));
      if (result.status === 'ROLLOUT_FAILED_ROLLED_BACK') process.exitCode = 5;
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
    return;
  }
  throw new Error(`unsupported command ${args.command}; live activation is intentionally not exposed`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`rollout readiness failed: ${String(error?.stack || error)}`); process.exitCode = 1; });
}
