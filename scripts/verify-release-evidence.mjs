#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRunalithReleaseEvidenceJson, verifyRunalithReleaseEvidence } from './lib/runalith-release-trust-contract.mjs';

const MAX_CANDIDATE_BYTES = 512 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

function parseArgs(argv) {
  const result = {};
  const names = new Map([
    ['--candidate', 'candidate'], ['--policy', 'policy'], ['--provenance', 'provenance'],
    ['--verification', 'verification'], ['--approval', 'approval'], ['--rollback', 'rollback'], ['--expected-nonce', 'expectedNonce'],
    ['--baseline-version', 'baselineVersion'], ['--baseline-sha256', 'baselineSha256'],
    ['--rollback-version', 'rollbackVersion']
  ]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const name = names.get(arg);
    if (!name) throw new Error(`unsupported argument: ${arg}`);
    if (Object.hasOwn(result, name)) throw new Error(`${arg} may be supplied only once`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    result[name] = value;
  }
  for (const name of ['candidate', 'policy', 'provenance', 'verification', 'approval', 'rollback', 'expectedNonce',
    'baselineVersion', 'baselineSha256', 'rollbackVersion']) {
    if (typeof result[name] !== 'string' || !result[name].trim()) throw new Error(`missing required option for ${name}`);
  }
  if (!/^[a-f0-9]{32,128}$/.test(result.expectedNonce)) throw new Error('--expected-nonce must be a host-issued lowercase hexadecimal one-time nonce (32–128 chars)');
  for (const name of ['baselineSha256']) {
    if (!/^[a-f0-9]{64}$/.test(result[name])) throw new Error(`--${name.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)} must be a lowercase SHA-256 digest`);
  }
  return result;
}

function readStableRegularFile(filePath, label, maxBytes) {
  const resolved = path.resolve(filePath);
  let pathBefore;
  try { pathBefore = fs.lstatSync(resolved, { bigint: true }); }
  catch { throw new Error(`${label} is missing or unreadable`); }
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || fs.realpathSync(resolved) !== resolved ||
      pathBefore.size < 1n || pathBefore.size > BigInt(maxBytes)) {
    throw new Error(`${label} must be a canonical regular non-symlink file between 1 byte and ${maxBytes} bytes`);
  }
  let descriptor;
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino || before.size !== pathBefore.size) {
      throw new Error(`${label} path identity changed before read`);
    }
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > maxBytes) throw new Error(`${label} exceeds its ${maxBytes}-byte limit`);
      chunks.push(chunk.subarray(0, count));
    }
    const bytes = Buffer.concat(chunks, total);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(resolved, { bigint: true });
    const stable = before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
      before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs && bytes.length === Number(after.size) &&
      pathAfter.isFile() && !pathAfter.isSymbolicLink() && pathAfter.dev === after.dev && pathAfter.ino === after.ino &&
      pathAfter.size === after.size && pathAfter.mtimeNs === after.mtimeNs && pathAfter.ctimeNs === after.ctimeNs &&
      fs.realpathSync(resolved) === resolved;
    if (!stable) throw new Error(`${label} changed during the stable descriptor read`);
    return bytes;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (error) {
    console.error(JSON.stringify({ status: 'BLOCKED', code: 'RELEASE_EVIDENCE_ARGUMENTS_INVALID', message: String(error.message || error) }, null, 2));
    process.exitCode = 2;
    return;
  }
  try {
    const candidateBytes = readStableRegularFile(args.candidate, 'candidate artifact', MAX_CANDIDATE_BYTES);
    const policyBytes = readStableRegularFile(args.policy, 'release policy', MAX_EVIDENCE_BYTES);
    const provenanceEnvelopeBytes = readStableRegularFile(args.provenance, 'SLSA provenance envelope', MAX_EVIDENCE_BYTES);
    const verificationEnvelopeBytes = readStableRegularFile(args.verification, 'candidate verification envelope', MAX_EVIDENCE_BYTES);
    const approvalEnvelopeBytes = readStableRegularFile(args.approval, 'release approval envelope', MAX_EVIDENCE_BYTES);
    const rollbackBytes = readStableRegularFile(args.rollback, 'rollback artifact', MAX_CANDIDATE_BYTES);
    const policy = parseRunalithReleaseEvidenceJson(policyBytes, 'Runalith release policy');
    const provenanceEnvelope = parseRunalithReleaseEvidenceJson(provenanceEnvelopeBytes, 'SLSA DSSE envelope');
    const verificationEnvelope = parseRunalithReleaseEvidenceJson(verificationEnvelopeBytes, 'candidate verification DSSE envelope');
    const approvalEnvelope = parseRunalithReleaseEvidenceJson(approvalEnvelopeBytes, 'release approval DSSE envelope');
    const result = verifyRunalithReleaseEvidence({ candidateBytes, policy, policyBytes,
      provenanceEnvelope, provenanceEnvelopeBytes, verificationEnvelope, verificationEnvelopeBytes,
      approvalEnvelope, approvalEnvelopeBytes, rollbackBytes, expectedNonce: args.expectedNonce,
      baselineVersion: args.baselineVersion, baselineSha256: args.baselineSha256,
      rollbackVersion: args.rollbackVersion });
    console.log(JSON.stringify(result, null, 2));
    // The local evidence verifier is not the production authority. Even a fully
    // valid evidence chain must exit BLOCKED until host-owned trust and the
    // external monotonic checkpoint have been independently authenticated.
    process.exitCode = result.cryptographicEvidenceVerified ? 3 : 2;
  } catch (error) {
    console.log(JSON.stringify({ status: 'BLOCKED', code: error?.code || 'RELEASE_EVIDENCE_VERIFICATION_FAILED',
      message: String(error?.message || error), productionReleaseEligible: false,
      productionAuthorityEstablished: false }, null, 2));
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
