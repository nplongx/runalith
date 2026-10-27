import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { parseStrictJson } from '../../src/runtime/strict-json.js';

export const RUNALITH_RELEASE_POLICY_CONTRACT = 'runalith-release-policy/v1';
export const RUNALITH_CANDIDATE_VERIFICATION_PREDICATE = 'https://runalith.dev/attestations/candidate-verification/v1';
export const RUNALITH_RELEASE_APPROVAL_PREDICATE = 'https://runalith.dev/attestations/release-approval/v1';
export const IN_TOTO_STATEMENT_V1 = 'https://in-toto.io/Statement/v1';
export const IN_TOTO_DSSE_PAYLOAD_TYPE = 'application/vnd.in-toto+json';
export const SLSA_PROVENANCE_V1 = 'https://slsa.dev/provenance/v1';

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^[a-f0-9]{40,64}$/;
const EMPTY_SHA256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
const POLICY_KEYS = Object.freeze([
  'schema_version', 'contract', 'policy_version', 'source_repository', 'subject_name',
  'expected_build_type', 'target_environment', 'required_tests', 'max_approval_ttl_seconds', 'trusted_signers'
].sort());
const SIGNER_KEYS = Object.freeze([
  'key_id', 'role', 'identity', 'public_key_pem', 'not_before', 'not_after', 'revoked_at'
].sort());
const TRUST_ROLES = new Set(['builder', 'verifier', 'release_authority']);
const VALIDATED_POLICY_OBJECTS = new WeakSet();

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys, label) {
  if (!isRecord(value) || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw contractError('RELEASE_EVIDENCE_SCHEMA_INVALID', `${label} must contain exactly: ${[...keys].sort().join(', ')}`);
  }
}
function contractError(code, message) { const error = new Error(message); error.code = code; return error; }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function canonicalJson(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw contractError('RELEASE_EVIDENCE_SCHEMA_INVALID', 'canonical JSON does not permit non-finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw contractError('RELEASE_EVIDENCE_SCHEMA_INVALID', 'canonical JSON permits only JSON scalar, array, and object values');
  if (seen.has(value)) throw contractError('RELEASE_EVIDENCE_SCHEMA_INVALID', 'canonical JSON rejects cycles and repeated object identities');
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
      throw contractError('RELEASE_EVIDENCE_SCHEMA_INVALID', 'canonical JSON arrays must use the standard prototype and have no symbol keys');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || keys.some(key => key !== 'length' &&
        (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
      throw contractError('RELEASE_EVIDENCE_SCHEMA_INVALID', 'canonical JSON arrays must be dense and have no extra properties');
    }
    const items = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        throw contractError('RELEASE_EVIDENCE_SCHEMA_INVALID', 'canonical JSON arrays reject holes, accessors, and non-enumerable elements');
      }
      items.push(canonicalJson(descriptor.value, seen));
    }
    return `[${items.join(',')}]`;
  }
  if (!isRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0) {
    throw contractError('RELEASE_EVIDENCE_SCHEMA_INVALID', 'canonical JSON objects must be plain objects without symbol keys');
  }
  const keys = Reflect.ownKeys(value);
  const fields = [];
  for (const key of keys) {
    if (typeof key !== 'string' || key === '__proto__') {
      throw contractError('RELEASE_EVIDENCE_SCHEMA_INVALID', 'canonical JSON rejects symbol and forbidden prototype keys');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw contractError('RELEASE_EVIDENCE_SCHEMA_INVALID', 'canonical JSON objects reject accessors and non-enumerable properties');
    }
    fields.push([key, descriptor.value]);
  }
  fields.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${fields.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child, seen)}`).join(',')}}`;
}
function canonicalTimestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) {
    throw contractError('RELEASE_EVIDENCE_TIMESTAMP_INVALID', `${label} must be a canonical UTC timestamp ending in .sssZ`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw contractError('RELEASE_EVIDENCE_TIMESTAMP_INVALID', `${label} is not a canonical UTC timestamp`);
  }
  return parsed;
}
function publicKeyFingerprint(pem) {
  let key;
  try { key = createPublicKey(pem); }
  catch { throw contractError('RELEASE_POLICY_PUBLIC_KEY_INVALID', 'trusted signer public key is invalid'); }
  if (key.asymmetricKeyType !== 'ed25519') throw contractError('RELEASE_POLICY_PUBLIC_KEY_INVALID', 'release-trust keys must be Ed25519');
  return sha256(key.export({ type: 'spki', format: 'der' }));
}
function decodeCanonicalBase64(value, label) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw contractError('RELEASE_EVIDENCE_ENCODING_INVALID', `${label} must be canonical base64`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw contractError('RELEASE_EVIDENCE_ENCODING_INVALID', `${label} must be canonical base64`);
  return decoded;
}

/** Validate a repository-supplied policy contract. This does not authenticate who provisioned it. */
export function validateRunalithReleasePolicy(policy, { now = Date.now() } = {}) {
  // Treat public API input as hostile even when it did not originate in the
  // CLI's strict JSON parser. Canonicalize via descriptors (never property
  // reads) and validate only the inert JSON copy.
  policy = parseStrictJson(Buffer.from(canonicalJson(policy), 'utf8'), 'in-memory release policy', { maxBytes: 8 * 1024 * 1024 });
  exactKeys(policy, POLICY_KEYS, 'release policy');
  if (policy.schema_version !== 1 || policy.contract !== RUNALITH_RELEASE_POLICY_CONTRACT ||
      !Number.isSafeInteger(policy.policy_version) || policy.policy_version < 1 ||
      typeof policy.source_repository !== 'string' || !/^https:\/\//.test(policy.source_repository) ||
      typeof policy.subject_name !== 'string' || !policy.subject_name.trim() || policy.subject_name.length > 256 ||
      typeof policy.expected_build_type !== 'string' || !policy.expected_build_type.trim() ||
      typeof policy.target_environment !== 'string' || !policy.target_environment.trim() ||
      !Number.isSafeInteger(policy.max_approval_ttl_seconds) || policy.max_approval_ttl_seconds < 1 ||
      policy.max_approval_ttl_seconds > 86_400 || !Array.isArray(policy.required_tests) ||
      policy.required_tests.length < 1 || policy.required_tests.length > 256 || !Array.isArray(policy.trusted_signers) ||
      policy.trusted_signers.length < 3 || policy.trusted_signers.length > 128 || !Number.isSafeInteger(now)) {
    throw contractError('RELEASE_POLICY_SCHEMA_INVALID', 'release policy version, repository, build policy, required tests, signer set, or clock is invalid');
  }
  if (new Set(policy.required_tests).size !== policy.required_tests.length ||
      policy.required_tests.some(name => typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,199}$/.test(name))) {
    throw contractError('RELEASE_POLICY_TEST_SET_INVALID', 'required_tests must be unique stable test identifiers');
  }

  const keyIds = new Set();
  const roleFingerprints = new Map([...TRUST_ROLES].map(role => [role, new Set()]));
  const roleIdentities = new Map([...TRUST_ROLES].map(role => [role, new Set()]));
  const signers = policy.trusted_signers.map((entry, index) => {
    exactKeys(entry, SIGNER_KEYS, `trusted_signers[${index}]`);
    if (typeof entry.key_id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(entry.key_id) || keyIds.has(entry.key_id) ||
        !TRUST_ROLES.has(entry.role) || typeof entry.identity !== 'string' || !entry.identity.trim() || entry.identity.length > 512 ||
        typeof entry.public_key_pem !== 'string' || !entry.public_key_pem.includes('BEGIN PUBLIC KEY')) {
      throw contractError('RELEASE_POLICY_SIGNER_INVALID', `trusted_signers[${index}] has an invalid or duplicate key ID, role, identity, or public key`);
    }
    keyIds.add(entry.key_id);
    const notBefore = canonicalTimestamp(entry.not_before, `trusted_signers[${index}].not_before`);
    const notAfter = canonicalTimestamp(entry.not_after, `trusted_signers[${index}].not_after`, { nullable: true });
    const revokedAt = canonicalTimestamp(entry.revoked_at, `trusted_signers[${index}].revoked_at`, { nullable: true });
    if (notAfter !== null && notAfter <= notBefore) throw contractError('RELEASE_POLICY_SIGNER_WINDOW_INVALID', `${entry.key_id} has an invalid validity window`);
    const fingerprint = publicKeyFingerprint(entry.public_key_pem);
    roleFingerprints.get(entry.role).add(fingerprint);
    roleIdentities.get(entry.role).add(entry.identity);
    return { ...entry, notBefore, notAfter, revokedAt, fingerprint,
      active: revokedAt === null && notBefore <= now && (notAfter === null || now < notAfter) };
  });
  for (const role of TRUST_ROLES) {
    if (!signers.some(signer => signer.role === role && signer.active)) {
      throw contractError('RELEASE_POLICY_ROLE_UNAVAILABLE', `no currently usable trusted signer for role ${role}`);
    }
  }
  for (const left of TRUST_ROLES) for (const right of TRUST_ROLES) {
    if (left >= right) continue;
    const overlapFingerprints = [...roleFingerprints.get(left)].some(value => roleFingerprints.get(right).has(value));
    const overlapIdentities = [...roleIdentities.get(left)].some(value => roleIdentities.get(right).has(value));
    if (overlapFingerprints || overlapIdentities) {
      throw contractError('RELEASE_POLICY_AUTHORITY_SEPARATION_FAILED', `trusted signers for ${left} and ${right} must have disjoint keys and identities`);
    }
  }
  const validated = { policy, signers, policyValidated: true, authorityProvisioningAuthenticated: false };
  VALIDATED_POLICY_OBJECTS.add(validated);
  return validated;
}

/** DSSE v1 pre-authentication encoding (PAE) for an in-toto Statement payload. */
export function dssePreAuthenticationEncoding(payloadType, payloadBytes) {
  if (typeof payloadType !== 'string' || !payloadType || !Buffer.isBuffer(payloadBytes)) {
    throw new TypeError('DSSE PAE requires a payload type and payload bytes');
  }
  return Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType, 'utf8')} ${payloadType} ${payloadBytes.length} `, 'utf8'), payloadBytes]);
}

/** Verify the DSSE signature and parse an in-toto Statement using a validated policy. */
export function verifyRunalithDsseEnvelope(envelope, validatedPolicy, role, { now = Date.now() } = {}) {
  if (!validatedPolicy || !VALIDATED_POLICY_OBJECTS.has(validatedPolicy) || !TRUST_ROLES.has(role) || !Number.isSafeInteger(now)) {
    throw contractError('RELEASE_EVIDENCE_VERIFIER_CONFIGURATION_INVALID', 'validated release policy, signer role, and clock are required');
  }
  // This is a public API as well as a CLI helper. Callers can pass objects
  // directly, so never let exactKeys/Object.keys or later property reads
  // observe accessor-backed, decorated, cyclic, or non-JSON envelope values.
  // Descriptor-based canonicalization rejects them without invoking getters;
  // the strict parser gives the verifier an inert copy for all checks below.
  envelope = parseStrictJson(Buffer.from(canonicalJson(envelope), 'utf8'), 'in-memory DSSE envelope', { maxBytes: 8 * 1024 * 1024 });
  exactKeys(envelope, ['payloadType', 'payload', 'signatures'], 'DSSE envelope');
  if (envelope.payloadType !== IN_TOTO_DSSE_PAYLOAD_TYPE || !Array.isArray(envelope.signatures) ||
      envelope.signatures.length < 1 || envelope.signatures.length > 16) {
    throw contractError('RELEASE_EVIDENCE_SCHEMA_INVALID', 'DSSE envelope must use the in-toto Statement payload type and 1–16 signatures');
  }
  const payloadBytes = decodeCanonicalBase64(envelope.payload, 'DSSE payload');
  if (!payloadBytes.length || payloadBytes.length > 8 * 1024 * 1024) throw contractError('RELEASE_EVIDENCE_SIZE_INVALID', 'DSSE payload must be between 1 byte and 8 MiB');
  const payload = parseStrictJson(payloadBytes, 'signed in-toto Statement', { maxBytes: 8 * 1024 * 1024 });
  const pae = dssePreAuthenticationEncoding(envelope.payloadType, payloadBytes);
  const seen = new Set();
  const verifiedSigners = [];
  for (let index = 0; index < envelope.signatures.length; index++) {
    const signatureEntry = envelope.signatures[index];
    exactKeys(signatureEntry, ['keyid', 'sig'], `DSSE signatures[${index}]`);
    if (typeof signatureEntry.keyid !== 'string' || seen.has(signatureEntry.keyid)) {
      throw contractError('RELEASE_EVIDENCE_SCHEMA_INVALID', 'DSSE signer key IDs must be unique strings');
    }
    seen.add(signatureEntry.keyid);
    const signer = validatedPolicy.signers.find(item => item.key_id === signatureEntry.keyid);
    if (!signer) throw contractError('RELEASE_EVIDENCE_SIGNER_UNTRUSTED', `DSSE envelope contains unconfigured signer ${signatureEntry.keyid}`);
    if (signer.revokedAt !== null || signer.notBefore > now || (signer.notAfter !== null && now >= signer.notAfter)) {
      throw contractError('RELEASE_EVIDENCE_SIGNER_UNAVAILABLE', `DSSE signer ${signer.key_id} is revoked or outside its validity window`);
    }
    const signature = decodeCanonicalBase64(signatureEntry.sig, `DSSE signature ${signatureEntry.keyid}`);
    if (signature.length !== 64) throw contractError('RELEASE_EVIDENCE_SIGNATURE_INVALID', `DSSE signature ${signatureEntry.keyid} has the wrong length`);
    let valid = false;
    try { valid = verifySignature(null, pae, createPublicKey(signer.public_key_pem), signature); }
    catch { valid = false; }
    if (!valid) throw contractError('RELEASE_EVIDENCE_SIGNATURE_INVALID', `DSSE signature ${signatureEntry.keyid} is invalid`);
    verifiedSigners.push(signer);
  }
  const accepted = verifiedSigners.filter(signer => signer.role === role);
  if (accepted.length !== 1) {
    throw contractError('RELEASE_EVIDENCE_SIGNER_ROLE_MISMATCH', `DSSE envelope requires exactly one valid signer with role ${role}`);
  }
  return { payload, signer: accepted[0], payloadBytes, payloadSha256: sha256(payloadBytes) };
}

function validateStatement(statement, { predicateType, candidateSha256, subjectName, label }) {
  exactKeys(statement, ['_type', 'subject', 'predicateType', 'predicate'], `${label} Statement`);
  if (statement._type !== IN_TOTO_STATEMENT_V1 || statement.predicateType !== predicateType ||
      !Array.isArray(statement.subject) || statement.subject.length !== 1) {
    throw contractError('RELEASE_EVIDENCE_STATEMENT_INVALID', `${label} must be a v1 in-toto Statement with exactly one candidate subject`);
  }
  exactKeys(statement.subject[0], ['name', 'digest'], `${label} subject`);
  exactKeys(statement.subject[0].digest, ['sha256'], `${label} subject digest`);
  if (statement.subject[0].name !== subjectName || statement.subject[0].digest.sha256 !== candidateSha256 || !SHA256.test(candidateSha256)) {
    throw contractError('RELEASE_EVIDENCE_SUBJECT_MISMATCH', `${label} subject does not bind the exact candidate name and SHA-256`);
  }
  if (!isRecord(statement.predicate)) throw contractError('RELEASE_EVIDENCE_PREDICATE_INVALID', `${label} predicate must be an object`);
  return statement.predicate;
}

/**
 * Keep the accepted SLSA material subset deliberately narrow. A provenance
 * statement must name exactly one repository+commit source material; every
 * other material must be content-addressed by SHA-256. Merely finding one
 * matching source entry in an otherwise ambiguous/duplicated list is not
 * sufficient evidence of the build inputs.
 */
function validateResolvedDependencies(value, { repository, commit }) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1024) {
    throw contractError('RELEASE_EVIDENCE_MATERIALS_INVALID', 'SLSA resolvedDependencies must contain 1–1024 validated materials');
  }
  const seenUris = new Set();
  let sourceMatches = 0;
  for (let index = 0; index < value.length; index++) {
    const material = value[index];
    if (!isRecord(material) || Object.keys(material).some(key =>
      !['uri', 'digest', 'name', 'downloadLocation', 'mediaType', 'content', 'annotations'].includes(key)) ||
      typeof material.uri !== 'string' || !material.uri.trim() || material.uri.length > 4096 ||
      seenUris.has(material.uri) || !isRecord(material.digest) || Array.isArray(material.digest)) {
      throw contractError('RELEASE_EVIDENCE_MATERIALS_INVALID', `SLSA resolvedDependencies[${index}] has an invalid, duplicate or unsupported material descriptor`);
    }
    seenUris.add(material.uri);
    for (const key of ['name', 'downloadLocation', 'mediaType']) {
      if (material[key] !== undefined && (typeof material[key] !== 'string' || !material[key].trim() || material[key].length > 4096)) {
        throw contractError('RELEASE_EVIDENCE_MATERIALS_INVALID', `SLSA resolvedDependencies[${index}].${key} is invalid`);
      }
    }
    if (material.annotations !== undefined && !isRecord(material.annotations)) {
      throw contractError('RELEASE_EVIDENCE_MATERIALS_INVALID', `SLSA resolvedDependencies[${index}].annotations must be an object`);
    }
    if (material.content !== undefined && typeof material.content !== 'string') {
      throw contractError('RELEASE_EVIDENCE_MATERIALS_INVALID', `SLSA resolvedDependencies[${index}].content must be a string`);
    }
    const digestKeys = Object.keys(material.digest).sort();
    if (material.uri === repository) {
      sourceMatches++;
      if (digestKeys.length !== 1 || digestKeys[0] !== 'gitCommit' || material.digest.gitCommit !== commit ||
          !GIT_OBJECT_ID.test(material.digest.gitCommit || '')) {
        throw contractError('RELEASE_EVIDENCE_SOURCE_MATERIAL_MISMATCH', 'repository source material must bind exactly the expected Git commit');
      }
    } else if (digestKeys.length !== 1 || digestKeys[0] !== 'sha256' || !SHA256.test(material.digest.sha256 || '')) {
      throw contractError('RELEASE_EVIDENCE_MATERIAL_DIGEST_INVALID', `non-source material ${material.uri} must have exactly one valid SHA-256 digest`);
    }
  }
  if (sourceMatches !== 1) {
    throw contractError('RELEASE_EVIDENCE_SOURCE_MATERIAL_MISMATCH', 'SLSA resolvedDependencies must contain exactly one repository source material for the expected commit');
  }
}

function validateProvenance(statement, signer, policy, candidateSha256, now) {
  const predicate = validateStatement(statement, { predicateType: SLSA_PROVENANCE_V1, candidateSha256,
    subjectName: policy.subject_name, label: 'SLSA provenance' });
  exactKeys(predicate, ['buildDefinition', 'runDetails'], 'SLSA provenance predicate');
  exactKeys(predicate.buildDefinition, ['buildType', 'externalParameters', 'resolvedDependencies'], 'SLSA buildDefinition');
  if (predicate.buildDefinition.buildType !== policy.expected_build_type) {
    throw contractError('RELEASE_EVIDENCE_BUILD_TYPE_MISMATCH', 'SLSA build type does not match host policy');
  }
  exactKeys(predicate.buildDefinition.externalParameters, ['source'], 'SLSA externalParameters');
  const source = predicate.buildDefinition.externalParameters.source;
  exactKeys(source, ['repository', 'commit', 'tree_sha256', 'snapshot_sha256', 'working_tree_clean', 'tracked_diff_sha256', 'working_tree_status_sha256'], 'source snapshot parameters');
  if (source.repository !== policy.source_repository || !GIT_OBJECT_ID.test(source.commit || '') ||
      !SHA256.test(source.tree_sha256 || '') || !SHA256.test(source.snapshot_sha256 || '') ||
      source.working_tree_clean !== true || source.tracked_diff_sha256 !== EMPTY_SHA256 ||
      source.working_tree_status_sha256 !== EMPTY_SHA256) {
    throw contractError('RELEASE_EVIDENCE_SOURCE_SNAPSHOT_INVALID', 'provenance repository, commit/tree/snapshot digest, or clean-worktree binding does not satisfy policy');
  }
  validateResolvedDependencies(predicate.buildDefinition.resolvedDependencies, {
    repository: policy.source_repository, commit: source.commit
  });
  exactKeys(predicate.runDetails, ['builder', 'metadata'], 'SLSA runDetails');
  exactKeys(predicate.runDetails.builder, ['id'], 'SLSA builder');
  exactKeys(predicate.runDetails.metadata, ['invocationId', 'startedOn', 'finishedOn'], 'SLSA run metadata');
  if (predicate.runDetails.builder.id !== signer.identity || typeof predicate.runDetails.metadata.invocationId !== 'string' ||
      !predicate.runDetails.metadata.invocationId.trim()) {
    throw contractError('RELEASE_EVIDENCE_BUILDER_IDENTITY_MISMATCH', 'SLSA builder identity must equal the independently verified DSSE signer identity');
  }
  const startedOn = canonicalTimestamp(predicate.runDetails.metadata.startedOn, 'SLSA startedOn');
  const finishedOn = canonicalTimestamp(predicate.runDetails.metadata.finishedOn, 'SLSA finishedOn');
  if (finishedOn < startedOn || startedOn > now + 5_000 || finishedOn > now + 5_000) {
    throw contractError('RELEASE_EVIDENCE_BUILD_TIME_INVALID', 'SLSA build timestamps are reversed or more than five seconds in the future');
  }
  return { sourceSnapshotSha256: source.snapshot_sha256, sourceCommit: source.commit, sourceTreeSha256: source.tree_sha256 };
}

function validateCandidateVerification(statement, policy, candidateSha256, sourceSnapshotSha256, policySha256) {
  const predicate = validateStatement(statement, { predicateType: RUNALITH_CANDIDATE_VERIFICATION_PREDICATE,
    candidateSha256, subjectName: policy.subject_name, label: 'candidate verification' });
  const expectedKeys = ['result', 'candidate_sha256', 'source_snapshot_sha256', 'policy_sha256', 'entry_inventory_sha256', 'source_alignment', 'tests'];
  exactKeys(predicate, expectedKeys, 'candidate verification predicate');
  if (predicate.result !== 'PASS' || predicate.candidate_sha256 !== candidateSha256 ||
      predicate.source_snapshot_sha256 !== sourceSnapshotSha256 || predicate.policy_sha256 !== policySha256 ||
      !SHA256.test(predicate.entry_inventory_sha256 || '')) {
    throw contractError('RELEASE_EVIDENCE_VERIFICATION_REPORT_INVALID', 'candidate verification report is not PASS or is bound to different candidate/source/policy bytes');
  }
  exactKeys(predicate.source_alignment, ['status', 'candidate_sha256', 'source_snapshot_sha256', 'working_tree_clean'], 'source alignment report');
  if (predicate.source_alignment.status !== 'PASS' || predicate.source_alignment.candidate_sha256 !== candidateSha256 ||
      predicate.source_alignment.source_snapshot_sha256 !== sourceSnapshotSha256 || predicate.source_alignment.working_tree_clean !== true) {
    throw contractError('RELEASE_EVIDENCE_SOURCE_ALIGNMENT_INVALID', 'source-alignment report must PASS for the exact candidate and clean source snapshot');
  }
  if (!Array.isArray(predicate.tests)) throw contractError('RELEASE_EVIDENCE_TEST_REPORT_INVALID', 'tests must be an array');
  const testsByName = new Map();
  for (const item of predicate.tests) {
    exactKeys(item, ['name', 'status', 'exit_code', 'candidate_sha256'], 'test evidence record');
    if (typeof item.name !== 'string' || testsByName.has(item.name)) throw contractError('RELEASE_EVIDENCE_TEST_REPORT_INVALID', 'test names must be unique');
    testsByName.set(item.name, item);
  }
  for (const requiredName of policy.required_tests) {
    const result = testsByName.get(requiredName);
    if (!result || result.status !== 'PASS' || result.exit_code !== 0 || result.candidate_sha256 !== candidateSha256) {
      throw contractError('RELEASE_EVIDENCE_REQUIRED_TEST_MISSING', `required test ${requiredName} must PASS with exit_code 0 for the exact candidate digest`);
    }
  }
  return { entryInventorySha256: predicate.entry_inventory_sha256, requiredTestCount: policy.required_tests.length };
}

function bundleDigest({ candidateSha256, provenanceEnvelopeSha256, verificationEnvelopeSha256, policySha256 }) {
  return sha256(Buffer.from(canonicalJson({ candidate_sha256: candidateSha256,
    provenance_envelope_sha256: provenanceEnvelopeSha256,
    verification_envelope_sha256: verificationEnvelopeSha256,
    policy_sha256: policySha256 }), 'utf8'));
}

function validateApproval(statement, signer, policy, { candidateSha256, policySha256, provenanceEnvelopeSha256,
  verificationEnvelopeSha256, expectedNonce, baselineVersion, baselineSha256, rollbackVersion, rollbackSha256, now }) {
  const predicate = validateStatement(statement, { predicateType: RUNALITH_RELEASE_APPROVAL_PREDICATE,
    candidateSha256, subjectName: policy.subject_name, label: 'release approval' });
  exactKeys(predicate, ['decision', 'candidate_sha256', 'provenance_envelope_sha256', 'verification_envelope_sha256',
    'evidence_bundle_sha256', 'policy_sha256', 'policy_version', 'target_environment', 'baseline', 'rollback',
    'issued_at', 'expires_at', 'nonce', 'approver_identity'], 'release approval predicate');
  if (predicate.decision !== 'APPROVE' || predicate.candidate_sha256 !== candidateSha256 ||
      predicate.provenance_envelope_sha256 !== provenanceEnvelopeSha256 ||
      predicate.verification_envelope_sha256 !== verificationEnvelopeSha256 || predicate.policy_sha256 !== policySha256 ||
      predicate.evidence_bundle_sha256 !== bundleDigest({ candidateSha256, provenanceEnvelopeSha256, verificationEnvelopeSha256, policySha256 }) ||
      predicate.policy_version !== policy.policy_version || predicate.target_environment !== policy.target_environment ||
      predicate.approver_identity !== signer.identity) {
    throw contractError('RELEASE_EVIDENCE_APPROVAL_BINDING_MISMATCH', 'release approval does not pin the exact candidate, evidence bundle, policy version, environment, and signer identity');
  }
  exactKeys(predicate.baseline, ['version', 'sha256'], 'release approval baseline');
  exactKeys(predicate.rollback, ['version', 'sha256'], 'release approval rollback');
  if (predicate.baseline.version !== baselineVersion || predicate.baseline.sha256 !== baselineSha256 ||
      predicate.rollback.version !== rollbackVersion || predicate.rollback.sha256 !== rollbackSha256 ||
      !SHA256.test(baselineSha256 || '') || !SHA256.test(rollbackSha256 || '') ||
      typeof baselineVersion !== 'string' || !baselineVersion.trim() || typeof rollbackVersion !== 'string' || !rollbackVersion.trim()) {
    throw contractError('RELEASE_EVIDENCE_BASELINE_ROLLBACK_MISMATCH', 'approval baseline and rollback bindings must match the operator-observed exact versions and SHA-256 digests');
  }
  if (candidateSha256 === baselineSha256) throw contractError('RELEASE_EVIDENCE_CANDIDATE_ALREADY_INSTALLED', 'candidate bytes are identical to the installed baseline');
  if (rollbackSha256 !== baselineSha256 || rollbackVersion !== baselineVersion) {
    throw contractError('RELEASE_EVIDENCE_ROLLBACK_BASELINE_MISMATCH', 'rollback bundle must byte-match the exact installed baseline version and digest');
  }
  const issuedAt = canonicalTimestamp(predicate.issued_at, 'approval issued_at');
  const expiresAt = canonicalTimestamp(predicate.expires_at, 'approval expires_at');
  if (issuedAt > now + 5_000 || expiresAt <= now || expiresAt <= issuedAt ||
      expiresAt - issuedAt > policy.max_approval_ttl_seconds * 1000) {
    throw contractError('RELEASE_EVIDENCE_APPROVAL_EXPIRED_OR_INVALID', 'release approval is expired, future-dated, or exceeds the policy validity window');
  }
  if (typeof expectedNonce !== 'string' || !/^[a-f0-9]{32,128}$/.test(expectedNonce) || predicate.nonce !== expectedNonce) {
    throw contractError('RELEASE_EVIDENCE_APPROVAL_NONCE_MISMATCH', 'release approval must bind the expected one-time nonce from the host caller');
  }
  return { expiresAt: predicate.expires_at, approverIdentity: signer.identity };
}

/**
 * Verify release evidence cryptographically. This verifier intentionally can
 * never assert production authority: local policy files and caller-provided
 * baseline observations do not authenticate host provisioning or the external
 * monotonic checkpoint service.
 */
export function verifyRunalithReleaseEvidence({ candidateBytes, policy, policyBytes, provenanceEnvelope, provenanceEnvelopeBytes,
  verificationEnvelope, verificationEnvelopeBytes, approvalEnvelope, approvalEnvelopeBytes, rollbackBytes, expectedNonce,
  baselineVersion, baselineSha256, rollbackVersion, rollbackSha256, now = Date.now() } = {}) {
  const evidenceBlockers = [];
  const gates = {};
  const failGate = (gate, error, fallbackCode) => {
    const code = error?.code || fallbackCode;
    gates[gate] = { status: 'BLOCKED', code, message: String(error?.message || error || code) };
    if (!evidenceBlockers.includes(code)) evidenceBlockers.push(code);
  };
  let validatedPolicy;
  try {
    if (!Buffer.isBuffer(policyBytes)) {
      throw contractError('RELEASE_EVIDENCE_POLICY_BYTES_INVALID', 'exact raw release policy bytes are required');
    }
    const policyFromBytes = parseStrictJson(policyBytes, 'raw release policy bytes', { maxBytes: 8 * 1024 * 1024 });
    if (canonicalJson(policyFromBytes) !== canonicalJson(policy)) {
      throw contractError('RELEASE_EVIDENCE_POLICY_BYTES_MISMATCH', 'release policy object does not match the exact raw policy bytes being digest-bound');
    }
    // The parsed bytes are the source of truth for every downstream policy
    // decision. Never verify signatures under one object while binding the
    // approval/provenance to the digest of a different policy file.
    policy = policyFromBytes;
    validatedPolicy = validateRunalithReleasePolicy(policy, { now });
    gates.policy = { status: 'PASS', policyVersion: policy.policy_version, policySha256: sha256(policyBytes) };
  } catch (error) {
    failGate('policy', error, 'RELEASE_POLICY_INVALID');
  }
  if (!validatedPolicy) return blockedReleaseResult(evidenceBlockers, gates);
  if (!Number.isSafeInteger(now) || !Buffer.isBuffer(candidateBytes) || candidateBytes.length === 0 ||
      candidateBytes.length > 512 * 1024 * 1024 || !Buffer.isBuffer(rollbackBytes) || rollbackBytes.length === 0 ||
      rollbackBytes.length > 512 * 1024 * 1024 || !Buffer.isBuffer(policyBytes) ||
      !Buffer.isBuffer(provenanceEnvelopeBytes) || !Buffer.isBuffer(verificationEnvelopeBytes) || !Buffer.isBuffer(approvalEnvelopeBytes)) {
    failGate('inputs', contractError('RELEASE_EVIDENCE_INPUT_INVALID', 'exact artifact and raw policy/evidence bytes plus a valid clock are required'), 'RELEASE_EVIDENCE_INPUT_INVALID');
    return blockedReleaseResult(evidenceBlockers, gates);
  }

  const candidateSha256 = sha256(candidateBytes);
  const actualRollbackSha256 = sha256(rollbackBytes);
  if (rollbackSha256 !== undefined && rollbackSha256 !== actualRollbackSha256) {
    failGate('rollbackArtifact', contractError('RELEASE_EVIDENCE_ROLLBACK_ARTIFACT_DIGEST_MISMATCH', 'supplied rollback SHA-256 does not match the exact rollback bytes'), 'RELEASE_EVIDENCE_ROLLBACK_ARTIFACT_DIGEST_MISMATCH');
  }
  const policySha256 = sha256(policyBytes);
  const provenanceEnvelopeSha256 = sha256(provenanceEnvelopeBytes);
  const verificationEnvelopeSha256 = sha256(verificationEnvelopeBytes);
  const approvalEnvelopeSha256 = sha256(approvalEnvelopeBytes);
  let provenance, verification, approval, source;
  try {
    provenance = verifyRunalithDsseEnvelope(provenanceEnvelope, validatedPolicy, 'builder', { now });
    source = validateProvenance(provenance.payload, provenance.signer, policy, candidateSha256, now);
    gates.provenance = { status: 'PASS', signerIdentity: provenance.signer.identity, sourceCommit: source.sourceCommit,
      sourceSnapshotSha256: source.sourceSnapshotSha256, envelopeSha256: provenanceEnvelopeSha256 };
  } catch (error) { failGate('provenance', error, 'RELEASE_EVIDENCE_PROVENANCE_INVALID'); }

  try {
    verification = verifyRunalithDsseEnvelope(verificationEnvelope, validatedPolicy, 'verifier', { now });
    if (!source) throw contractError('RELEASE_EVIDENCE_PROVENANCE_REQUIRED', 'candidate report cannot be evaluated without verified provenance');
    const report = validateCandidateVerification(verification.payload, policy, candidateSha256, source.sourceSnapshotSha256, policySha256);
    gates.candidateVerification = { status: 'PASS', signerIdentity: verification.signer.identity,
      entryInventorySha256: report.entryInventorySha256, requiredTestCount: report.requiredTestCount,
      envelopeSha256: verificationEnvelopeSha256 };
  } catch (error) { failGate('candidateVerification', error, 'RELEASE_EVIDENCE_CANDIDATE_VERIFICATION_INVALID'); }

  try {
    approval = verifyRunalithDsseEnvelope(approvalEnvelope, validatedPolicy, 'release_authority', { now });
    validateApproval(approval.payload, approval.signer, policy, { candidateSha256, policySha256,
      provenanceEnvelopeSha256, verificationEnvelopeSha256, expectedNonce, baselineVersion, baselineSha256,
      rollbackVersion, rollbackSha256: actualRollbackSha256, now });
    gates.releaseApproval = { status: 'PASS', signerIdentity: approval.signer.identity, envelopeSha256: approvalEnvelopeSha256 };
  } catch (error) { failGate('releaseApproval', error, 'RELEASE_EVIDENCE_RELEASE_APPROVAL_INVALID'); }

  const bundleSha256 = bundleDigest({ candidateSha256, provenanceEnvelopeSha256, verificationEnvelopeSha256, policySha256 });
  const cryptographicEvidenceVerified = evidenceBlockers.length === 0;
  const productionBlockers = ['HOST_TRUST_POLICY_PROVISIONING_NOT_AUTHENTICATED', 'HOST_MONOTONIC_CHECKPOINT_NOT_VERIFIED'];
  return {
    contract: 'runalith-release-evidence-verification/v1',
    status: cryptographicEvidenceVerified ? 'EVIDENCE_VERIFIED_BUT_PRODUCTION_BLOCKED' : 'BLOCKED',
    cryptographicEvidenceVerified,
    productionReleaseEligible: false,
    productionAuthorityEstablished: false,
    hostTrustContextAuthenticated: false,
    monotonicCheckpointAuthenticated: false,
    candidate: { sha256: candidateSha256, size: candidateBytes.length },
    policy: { version: policy.policy_version, sha256: policySha256, authorityProvisioningAuthenticated: false },
    evidenceBundleSha256: bundleSha256,
    envelopeDigests: { provenance: provenanceEnvelopeSha256, candidateVerification: verificationEnvelopeSha256, releaseApproval: approvalEnvelopeSha256 },
    baseline: { version: baselineVersion ?? null, sha256: baselineSha256 ?? null },
    rollback: { version: rollbackVersion ?? null, sha256: actualRollbackSha256 },
    gates,
    evidenceBlockers,
    productionBlockers,
    notes: [
      'This result verifies content/signatures against the supplied policy; it does not authenticate who provisioned that policy or its public keys.',
      'Production remains BLOCKED until a host-owned verifier authenticates effective trust configuration and an independent monotonic checkpoint.'
    ]
  };
}

function blockedReleaseResult(evidenceBlockers, gates) {
  return { contract: 'runalith-release-evidence-verification/v1', status: 'BLOCKED', cryptographicEvidenceVerified: false,
    productionReleaseEligible: false, productionAuthorityEstablished: false, hostTrustContextAuthenticated: false,
    monotonicCheckpointAuthenticated: false, gates, evidenceBlockers,
    productionBlockers: ['HOST_TRUST_POLICY_PROVISIONING_NOT_AUTHENTICATED', 'HOST_MONOTONIC_CHECKPOINT_NOT_VERIFIED'],
    notes: ['No result from this local verifier can establish production release authority.'] };
}

export function parseRunalithReleaseEvidenceJson(bytes, label) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError(`${label} must be a Buffer`);
  return parseStrictJson(bytes, label, { maxBytes: 8 * 1024 * 1024 });
}

export function runalithReleaseEnvelopeDigest(envelopeBytes) {
  if (!Buffer.isBuffer(envelopeBytes)) throw new TypeError('evidence envelope bytes must be a Buffer');
  return sha256(envelopeBytes);
}
