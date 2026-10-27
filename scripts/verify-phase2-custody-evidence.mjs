#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPhase2CustodyEvidence } from './lib/phase2-custody-evidence.mjs';

function parseArgs(argv) {
  const keys = new Map([
    ['--repository-root', 'repositoryRoot'], ['--candidate', 'candidatePath'], ['--manifest', 'manifestPath'],
    ['--receipt', 'receiptPath'], ['--authority-public-key', 'authorityPublicKeyPath'], ['--builder-public-key', 'builderPublicKeyPath'],
    ['--expected-authority-key-sha256', 'expectedAuthorityKeySha256'], ['--expected-builder-key-sha256', 'expectedBuilderKeySha256'],
    ['--expected-authority-id', 'expectedAuthorityId'], ['--expected-builder-identity', 'expectedBuilderIdentity'],
    ['--expected-repository', 'expectedRepository']
  ]);
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const name = keys.get(argv[i]);
    if (!name) throw new Error(`unsupported argument: ${argv[i]}`);
    if (Object.hasOwn(result, name)) throw new Error(`${argv[i]} may be supplied only once`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${argv[i - 1]} requires a value`);
    result[name] = value;
  }
  for (const key of keys.values()) if (typeof result[key] !== 'string' || !result[key].trim()) throw new Error(`missing required argument: ${key}`);
  return result;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const authorityPublicKeyPem = fs.readFileSync(args.authorityPublicKeyPath, 'utf8');
    const builderPublicKeyPem = fs.readFileSync(args.builderPublicKeyPath, 'utf8');
    const result = verifyPhase2CustodyEvidence({ ...args, authorityPublicKeyPem, builderPublicKeyPem });
    console.log(JSON.stringify(result, null, 2));
    // This tool verifies supplied evidence; it cannot authenticate who provisioned
    // the expected key pins or authorize production lifecycle actions.
    process.exitCode = 3;
  } catch (error) {
    console.log(JSON.stringify({ status: 'BLOCKED', code: error?.code || 'PHASE2_CUSTODY_VERIFICATION_FAILED',
      message: String(error?.message || error), productionAuthorityEstablished: false }, null, 2));
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
