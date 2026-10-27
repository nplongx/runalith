import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const RUNALITH_HOSTED_BUILD_REPOSITORY = 'nplongx/runalith';
export const RUNALITH_HOSTED_BUILD_WORKFLOW = '.github/workflows/runalith-provenance-builder.yml';
export const RUNALITH_HOSTED_BUILD_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const RUNALITH_SLSA_PREDICATE = 'https://slsa.dev/provenance/v1';
export const RUNALITH_GITHUB_ACTIONS_BUILD_TYPE = 'https://actions.github.io/buildtypes/workflow/v1';
// SLSA builder.id identifies the build platform, not the signer workflow.
// The signer workflow's identity is independently enforced by gh attestation
// verify --signer-workflow/--signer-digest and the OIDC certificate constraints.
export const RUNALITH_EXPECTED_BUILDER_ID = 'https://github.com/actions/runner';
const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_REVISION = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const STATEMENT_V1 = 'https://in-toto.io/Statement/v1';

function error(code, message) { const result = new Error(message); result.code = code; return result; }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export function validateHostedBuilderVerificationOutput(output, { candidateSha256, sourceCommit,
  repository = RUNALITH_HOSTED_BUILD_REPOSITORY, workflow = RUNALITH_HOSTED_BUILD_WORKFLOW,
  now = Date.now(), maxAgeMs = 24 * 60 * 60_000 } = {}) {
  if (!SHA256.test(candidateSha256 || '') || !SOURCE_REVISION.test(sourceCommit || '') ||
      repository !== RUNALITH_HOSTED_BUILD_REPOSITORY || workflow !== RUNALITH_HOSTED_BUILD_WORKFLOW ||
      !Number.isSafeInteger(now) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 24 * 60 * 60_000) {
    throw error('HOSTED_BUILDER_POLICY_INPUT_INVALID', 'candidate digest, source commit, canonical repository and pinned workflow are required');
  }
  let entries;
  try { entries = typeof output === 'string' ? JSON.parse(output) : output; }
  catch { throw error('HOSTED_BUILDER_REPORT_MALFORMED', 'gh attestation verify output is not valid JSON'); }
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 30) {
    throw error('HOSTED_BUILDER_REPORT_EMPTY_OR_OVERSIZED', 'gh attestation verify must return 1–30 independently verified attestations');
  }
  const matches = [];
  for (const entry of entries) {
    const verified = entry?.verificationResult;
    const statement = verified?.statement;
    if (!isRecord(verified) || !isRecord(statement) || !isRecord(verified.signature?.certificate) ||
        statement._type !== STATEMENT_V1 || statement.predicateType !== RUNALITH_SLSA_PREDICATE ||
        !Array.isArray(statement.subject) || statement.subject.length !== 1 ||
        !isRecord(statement.subject[0]) || !isRecord(statement.subject[0].digest) ||
        statement.subject[0].digest.sha256 !== candidateSha256 ||
        typeof statement.subject[0].name !== 'string' || !statement.subject[0].name.endsWith('.mcpb') ||
        !isRecord(statement.predicate) || !isRecord(statement.predicate.buildDefinition) ||
        statement.predicate.buildDefinition.buildType !== RUNALITH_GITHUB_ACTIONS_BUILD_TYPE ||
        !isRecord(statement.predicate.runDetails) || !isRecord(statement.predicate.runDetails.builder) ||
        statement.predicate.runDetails.builder.id !== RUNALITH_EXPECTED_BUILDER_ID ||
        !Array.isArray(verified.verifiedTimestamps) || verified.verifiedTimestamps.length < 1) continue;

    // `gh attestation verify` is invoked with repository, signer-workflow,
    // OIDC-issuer, source-digest and SLSA predicate constraints. The local
    // statement parser below additionally binds the exact subject bytes and
    // expected source revision. Never treat a caller-provided verification
    // result as independently verified without having invoked that CLI.
    const predicate = statement.predicate;
    const workflowInput = predicate.buildDefinition.externalParameters?.workflow;
    const dependencies = Array.isArray(predicate.buildDefinition.resolvedDependencies)
      ? predicate.buildDefinition.resolvedDependencies : [];
    const freshVerifiedTimestamps = verified.verifiedTimestamps.filter(timestamp => {
      const value = typeof timestamp?.timestamp === 'string' ? Date.parse(timestamp.timestamp) : NaN;
      return Number.isFinite(value) && value <= now + 5_000 && now - value <= maxAgeMs;
    });
    if (freshVerifiedTimestamps.length < 1) continue;
    const hasSourceCommit = dependencies.some(item => typeof item?.uri === 'string' &&
      item.uri.startsWith(`git+https://github.com/${repository}@`) && item?.digest?.gitCommit === sourceCommit);
    const hasRepositoryBinding = workflowInput?.repository === `https://github.com/${repository}` &&
      workflowInput?.path === workflow && workflowInput?.ref === 'refs/heads/main';
    if (!hasSourceCommit || !hasRepositoryBinding) continue;
    matches.push({ subjectName: statement.subject[0].name, subjectSha256: candidateSha256,
      predicateType: statement.predicateType, builderId: predicate.runDetails.builder.id,
      invocationId: predicate.runDetails.metadata?.invocationId || null,
      statementSha256: sha256(Buffer.from(JSON.stringify(statement), 'utf8')),
      verifiedTimestampCount: verified.verifiedTimestamps.length,
      verifiedAt: freshVerifiedTimestamps.map(timestamp => timestamp.timestamp).sort()[0] });
  }
  if (matches.length !== 1) {
    throw error('HOSTED_BUILDER_STATEMENT_BINDING_MISMATCH', `expected exactly one verified SLSA statement binding candidate/source/repository; found ${matches.length}`);
  }
  return {
    contract: 'runalith-hosted-builder-verification/v1',
    status: 'HOSTED_BUILDER_PROVENANCE_VERIFIED',
    cryptographicVerificationPerformedBy: 'gh attestation verify',
    candidateSha256,
    sourceCommit,
    repository,
    signerWorkflow: workflow,
    oidcIssuer: RUNALITH_HOSTED_BUILD_OIDC_ISSUER,
    predicateType: RUNALITH_SLSA_PREDICATE,
    buildType: RUNALITH_GITHUB_ACTIONS_BUILD_TYPE,
    expectedBuilderId: RUNALITH_EXPECTED_BUILDER_ID,
    statement: matches[0],
    hostPolicyProvisioningAuthenticated: false,
    releaseApprovalVerified: false,
    monotonicCheckpointVerified: false,
    productionReleaseEligible: false,
    blockers: ['HOST_RELEASE_POLICY_PROVISIONING_NOT_AUTHENTICATED', 'INDEPENDENT_RELEASE_APPROVAL_NOT_VERIFIED', 'HOST_MONOTONIC_CHECKPOINT_NOT_VERIFIED']
  };
}

export function verifyHostedBuilderAttestation({ candidatePath, builderAttestationBundlePath, sourceCommit, reportOutputPath = null,
  ghExecutable = 'gh', spawn = spawnSync } = {}) {
  if (typeof candidatePath !== 'string' || !candidatePath.trim() ||
      typeof builderAttestationBundlePath !== 'string' || !builderAttestationBundlePath.trim() ||
      !SOURCE_REVISION.test(sourceCommit || '')) {
    throw error('HOSTED_BUILDER_ARGUMENTS_INVALID', 'candidate path, downloaded attestation bundle, and full immutable source commit are required');
  }
  const absolute = path.resolve(candidatePath);
  const bundleAbsolute = path.resolve(builderAttestationBundlePath);
  if (absolute === bundleAbsolute) throw error('HOSTED_BUILDER_ARGUMENTS_INVALID', 'candidate and attestation bundle must be different files');
  const before = fs.lstatSync(absolute, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || fs.realpathSync(absolute) !== absolute || before.size < 1n || before.size > 512n * 1024n * 1024n) {
    throw error('HOSTED_BUILDER_CANDIDATE_PATH_UNSAFE', 'candidate must be a canonical regular non-symlink MCPB up to 512 MiB');
  }
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let candidateBytes;
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw error('HOSTED_BUILDER_CANDIDATE_CHANGED', 'candidate identity changed before reading');
    candidateBytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(absolute, { bigint: true });
    if (candidateBytes.length !== Number(opened.size) || after.dev !== opened.dev || after.ino !== opened.ino ||
        after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs ||
        current.dev !== opened.dev || current.ino !== opened.ino || current.size !== opened.size ||
        current.mtimeNs !== opened.mtimeNs || current.ctimeNs !== opened.ctimeNs || fs.realpathSync(absolute) !== absolute) {
      throw error('HOSTED_BUILDER_CANDIDATE_CHANGED', 'candidate bytes or path identity changed during verification setup');
    }
  } finally { fs.closeSync(fd); }
  const candidateSha256 = sha256(candidateBytes);
  const bundleBytes = readStableEvidenceFile(bundleAbsolute, 'downloaded SLSA attestation bundle', 16 * 1024 * 1024);
  const builderAttestationBundleSha256 = sha256(bundleBytes);
  const args = ['attestation', 'verify', absolute,
    '--repo', RUNALITH_HOSTED_BUILD_REPOSITORY,
    '--signer-workflow', `${RUNALITH_HOSTED_BUILD_REPOSITORY}/${RUNALITH_HOSTED_BUILD_WORKFLOW}`,
    '--signer-digest', sourceCommit,
    '--cert-oidc-issuer', RUNALITH_HOSTED_BUILD_OIDC_ISSUER,
    '--source-digest', sourceCommit,
    '--source-ref', 'refs/heads/main',
    '--predicate-type', RUNALITH_SLSA_PREDICATE,
    '--deny-self-hosted-runners',
    '--format', 'json'];
  const apiResult = spawn(ghExecutable, args, { encoding: 'utf8', timeout: 90_000, maxBuffer: 32 * 1024 * 1024 });
  if (apiResult.error || apiResult.status !== 0) {
    throw error('HOSTED_BUILDER_ATTESTATION_NOT_VERIFIED', `GitHub API attestation verification failed${apiResult.status === null ? '' : ` (exit ${apiResult.status})`}: ${String(apiResult.error?.message || apiResult.stderr || apiResult.stdout || 'no verifier output').slice(0, 2000)}`);
  }
  const bundleResult = spawn(ghExecutable, [...args, '--bundle', bundleAbsolute], {
    encoding: 'utf8', timeout: 90_000, maxBuffer: 32 * 1024 * 1024
  });
  if (bundleResult.error || bundleResult.status !== 0) {
    throw error('HOSTED_BUILDER_BUNDLE_NOT_VERIFIED', `offline downloaded-bundle verification failed${bundleResult.status === null ? '' : ` (exit ${bundleResult.status})`}: ${String(bundleResult.error?.message || bundleResult.stderr || bundleResult.stdout || 'no verifier output').slice(0, 2000)}`);
  }
  const finalFd = fdSafeReopen(absolute);
  let finalBytes;
  try {
    const afterOpen = fs.fstatSync(finalFd, { bigint: true });
    if (afterOpen.dev !== before.dev || afterOpen.ino !== before.ino || afterOpen.size !== before.size ||
        afterOpen.mtimeNs !== before.mtimeNs || afterOpen.ctimeNs !== before.ctimeNs) {
      throw error('HOSTED_BUILDER_CANDIDATE_CHANGED', 'candidate file identity changed during attestation verification');
    }
    finalBytes = fs.readFileSync(finalFd);
    const afterRead = fs.fstatSync(finalFd, { bigint: true });
    const finalStat = fs.lstatSync(absolute, { bigint: true });
    if (afterRead.dev !== before.dev || afterRead.ino !== before.ino || afterRead.size !== before.size ||
        afterRead.mtimeNs !== before.mtimeNs || afterRead.ctimeNs !== before.ctimeNs ||
        finalStat.dev !== before.dev || finalStat.ino !== before.ino || finalStat.size !== before.size ||
        finalStat.mtimeNs !== before.mtimeNs || finalStat.ctimeNs !== before.ctimeNs || fs.realpathSync(absolute) !== absolute) {
      throw error('HOSTED_BUILDER_CANDIDATE_CHANGED', 'candidate file identity changed after attestation verification');
    }
  }
  finally { fs.closeSync(finalFd); }
  if (!finalBytes.equals(candidateBytes)) throw error('HOSTED_BUILDER_CANDIDATE_CHANGED', 'candidate bytes changed after cryptographic verification');
  const finalBundleBytes = readStableEvidenceFile(bundleAbsolute, 'downloaded SLSA attestation bundle', 16 * 1024 * 1024);
  if (!finalBundleBytes.equals(bundleBytes)) throw error('HOSTED_BUILDER_BUNDLE_CHANGED', 'attestation bundle bytes changed during cryptographic verification');
  let verified, verifiedOffline;
  try {
    verified = validateHostedBuilderVerificationOutput(apiResult.stdout, { candidateSha256, sourceCommit });
    verifiedOffline = validateHostedBuilderVerificationOutput(bundleResult.stdout, { candidateSha256, sourceCommit });
  }
  catch (cause) { throw cause; }
  if (verified.statement.statementSha256 !== verifiedOffline.statement.statementSha256 ||
      verified.statement.subjectSha256 !== verifiedOffline.statement.subjectSha256 ||
      verified.statement.builderId !== verifiedOffline.statement.builderId ||
      verified.statement.verifiedAt !== verifiedOffline.statement.verifiedAt) {
    throw error('HOSTED_BUILDER_API_BUNDLE_STATEMENT_MISMATCH', 'GitHub API and downloaded Sigstore bundle verification returned different provenance statements');
  }
  const verifierOutputSha256 = sha256(Buffer.from(apiResult.stdout, 'utf8'));
  const bundleVerifierOutputSha256 = sha256(Buffer.from(bundleResult.stdout, 'utf8'));
  const reportBytes = Buffer.from(`${JSON.stringify({ ...verified,
    builderAttestationBundleSha256, verifierOutputSha256, bundleVerifierOutputSha256 }, null, 2)}\n`);
  if (reportOutputPath) {
    const destination = path.resolve(reportOutputPath);
    const parent = path.dirname(destination);
    if (fs.realpathSync(parent) !== parent || fs.existsSync(destination)) {
      throw error('HOSTED_BUILDER_REPORT_PATH_UNSAFE', 'report output parent must be canonical and destination must not already exist');
    }
    const reportFd = fs.openSync(destination, 'wx', 0o600);
    try { fs.writeFileSync(reportFd, reportBytes); fs.fsyncSync(reportFd); }
    finally { fs.closeSync(reportFd); }
  }
  return { ...verified, candidatePath: absolute, candidateSizeBytes: candidateBytes.length,
    builderAttestationBundlePath: bundleAbsolute, builderAttestationBundleSha256,
    verifierOutputSha256, bundleVerifierOutputSha256,
    reportSha256: sha256(reportBytes), reportPath: reportOutputPath ? path.resolve(reportOutputPath) : null };
}

function readStableEvidenceFile(filePath, label, maxBytes) {
  const beforePath = fs.lstatSync(filePath, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || fs.realpathSync(filePath) !== filePath ||
      beforePath.size < 1n || beforePath.size > BigInt(maxBytes)) {
    throw error('HOSTED_BUILDER_EVIDENCE_PATH_UNSAFE', `${label} must be a canonical regular non-symlink file between 1 and ${maxBytes} bytes`);
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (before.dev !== beforePath.dev || before.ino !== beforePath.ino || before.size !== beforePath.size) {
      throw error('HOSTED_BUILDER_EVIDENCE_CHANGED', `${label} identity changed before read`);
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    const afterPath = fs.lstatSync(filePath, { bigint: true });
    if (bytes.length !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        afterPath.dev !== after.dev || afterPath.ino !== after.ino || afterPath.size !== after.size ||
        afterPath.mtimeNs !== after.mtimeNs || afterPath.ctimeNs !== after.ctimeNs || fs.realpathSync(filePath) !== filePath) {
      throw error('HOSTED_BUILDER_EVIDENCE_CHANGED', `${label} changed during descriptor read`);
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}

function fdSafeReopen(filePath) {
  const before = fs.lstatSync(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || fs.realpathSync(filePath) !== filePath) {
    throw error('HOSTED_BUILDER_CANDIDATE_CHANGED', 'candidate is no longer a canonical regular file');
  }
  return fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
}
