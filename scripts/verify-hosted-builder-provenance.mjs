#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyHostedBuilderAttestation } from './lib/hosted-builder-attestation.mjs';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!['--candidate', '--builder-attestation-bundle', '--source-commit', '--out'].includes(key)) throw new Error(`unsupported argument: ${key}`);
    if (Object.hasOwn(args, key)) throw new Error(`${key} may be supplied only once`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    args[key] = value;
  }
  if (!args['--candidate'] || !args['--builder-attestation-bundle'] || !args['--source-commit']) {
    throw new Error('--candidate, --builder-attestation-bundle and --source-commit are required');
  }
  return { candidatePath: args['--candidate'], builderAttestationBundlePath: args['--builder-attestation-bundle'],
    sourceCommit: args['--source-commit'], reportOutputPath: args['--out'] || null };
}

function main() {
  try {
    const result = verifyHostedBuilderAttestation(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    // Exit 0 means the builder provenance was independently verified. The
    // machine-readable report still marks productionReleaseEligible=false;
    // this command is not a release-approval or production-readiness gate.
    process.exitCode = 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'BLOCKED', code: error?.code || 'HOSTED_BUILDER_PROVENANCE_INVALID',
      message: String(error?.message || error), productionReleaseEligible: false }, null, 2)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
