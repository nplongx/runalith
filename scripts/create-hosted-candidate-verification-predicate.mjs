#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseStrictJson } from '../src/runtime/strict-json.js';
import { createRunalithHostedCandidateVerificationPredicate, runalithHostedPolicyDigest,
  runalithHostedPredicateDigest } from './lib/hosted-verification-predicate.mjs';

const MAX_CANDIDATE_BYTES = 512 * 1024 * 1024;
const MAX_JSON_BYTES = 32 * 1024 * 1024;

function readStableRegularFile(inputPath, label, maxBytes) {
  const resolved = path.resolve(inputPath);
  const pathBefore = fs.lstatSync(resolved, { bigint: true });
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || fs.realpathSync(resolved) !== resolved ||
      pathBefore.size < 1n || pathBefore.size > BigInt(maxBytes)) {
    throw new Error(`${label} must be a canonical regular non-symlink file between 1 and ${maxBytes} bytes`);
  }
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (before.dev !== pathBefore.dev || before.ino !== pathBefore.ino || before.size !== pathBefore.size) throw new Error(`${label} changed before read`);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(resolved, { bigint: true });
    if (bytes.length !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        pathAfter.dev !== after.dev || pathAfter.ino !== after.ino || pathAfter.size !== after.size ||
        pathAfter.mtimeNs !== after.mtimeNs || pathAfter.ctimeNs !== after.ctimeNs || fs.realpathSync(resolved) !== resolved) {
      throw new Error(`${label} changed during descriptor read`);
    }
    return bytes;
  } finally { fs.closeSync(descriptor); }
}

function parseArgs(argv) {
  const fields = new Map([
    ['--candidate', 'candidate'], ['--policy', 'policy'], ['--builder-verification', 'builderVerification'],
    ['--builder-attestation-bundle', 'builderAttestationBundle'],
    ['--builder-source-alignment', 'builderSourceAlignment'], ['--independent-rebuild', 'independentRebuild'],
    ['--independent-source-alignment', 'independentSourceAlignment'], ['--out', 'out']
  ]);
  const parsed = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    const name = fields.get(key);
    if (!name) throw new Error(`unsupported argument: ${key}`);
    if (Object.hasOwn(parsed, name)) throw new Error(`${key} may be supplied only once`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    parsed[name] = value;
  }
  for (const name of fields.values()) if (!parsed[name]) throw new Error(`missing required option: ${name}`);
  return parsed;
}

function readJson(pathname, label) {
  const bytes = readStableRegularFile(pathname, label, MAX_JSON_BYTES);
  return { value: parseStrictJson(bytes, label, { maxBytes: MAX_JSON_BYTES }), sha256: createHash('sha256').update(bytes).digest('hex') };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const candidateBytes = readStableRegularFile(args.candidate, 'candidate MCPB', MAX_CANDIDATE_BYTES);
    const policyBytes = readStableRegularFile(args.policy, 'hosted build policy', 128 * 1024);
    const builderVerification = readJson(args.builderVerification, 'verified builder provenance report');
    const builderSourceAlignment = readJson(args.builderSourceAlignment, 'builder source alignment report');
    const independentRebuild = readJson(args.independentRebuild, 'independent rebuild report');
    const independentSourceAlignment = readJson(args.independentSourceAlignment, 'independent source alignment report');
    const builderAttestationBundleBytes = readStableRegularFile(args.builderAttestationBundle, 'builder SLSA attestation bundle', MAX_JSON_BYTES);
    const predicate = createRunalithHostedCandidateVerificationPredicate({
      candidateBytes, policyBytes, policy: parseStrictJson(policyBytes, 'hosted build policy', { maxBytes: 128 * 1024 }),
      builderVerification: builderVerification.value,
      builderSourceAlignment: builderSourceAlignment.value,
      independentRebuild: independentRebuild.value,
      independentSourceAlignment: independentSourceAlignment.value,
      evidenceDigests: {
        builder_attestation_bundle_sha256: createHash('sha256').update(builderAttestationBundleBytes).digest('hex'),
        builder_verification_report_sha256: builderVerification.sha256,
        builder_source_alignment_sha256: builderSourceAlignment.sha256,
        independent_rebuild_report_sha256: independentRebuild.sha256,
        independent_source_alignment_sha256: independentSourceAlignment.sha256
      }
    });
    const outputPath = path.resolve(args.out);
    if (fs.realpathSync(path.dirname(outputPath)) !== path.dirname(outputPath) || fs.existsSync(outputPath)) {
      throw Object.assign(new Error('output parent must be canonical and output destination must not already exist'), { code: 'HOSTED_VERIFICATION_OUTPUT_PATH_UNSAFE' });
    }
    const outputBytes = Buffer.from(`${JSON.stringify(predicate, null, 2)}\n`, 'utf8');
    const outputFd = fs.openSync(outputPath, 'wx', 0o600);
    try { fs.writeFileSync(outputFd, outputBytes); fs.fsyncSync(outputFd); }
    finally { fs.closeSync(outputFd); }
    process.stdout.write(`${JSON.stringify({ status: 'HOSTED_CANDIDATE_VERIFICATION_PREDICATE_READY',
      predicateType: 'https://runalith.dev/attestations/hosted-candidate-verification/v1',
      candidateSha256: predicate.candidate_sha256, sourceSnapshotSha256: predicate.source_snapshot_sha256,
      policySha256: runalithHostedPolicyDigest(policyBytes), predicateSha256: runalithHostedPredicateDigest(predicate),
      requiredTestCount: predicate.tests.length, productionReleaseEligible: false, outputPath }, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'BLOCKED', code: error?.code || 'HOSTED_VERIFICATION_PREDICATE_INVALID',
      message: String(error?.message || error), productionReleaseEligible: false }, null, 2)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
