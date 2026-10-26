#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditPhase1Ledger } from './phase1-ledger-integrity.mjs';
import { parseStrictJson } from '../../src/runtime/strict-json.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const args = { rawPath: null, manifestPath: null, allowHistoricalSource: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--raw' && argv[index + 1]) args.rawPath = path.resolve(argv[++index]);
    else if (arg === '--manifest' && argv[index + 1]) args.manifestPath = path.resolve(argv[++index]);
    else if (arg === '--allow-historical-source') args.allowHistoricalSource = true;
    else if (arg === '--help' || arg === '-h') return { help: true };
    else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  if (!args.rawPath) throw new Error('required argument: --raw PATH');
  if (args.manifestPath && !args.manifestPath.startsWith(`${repo}${path.sep}`)) {
    throw new Error('manifest must be within this repository workspace');
  }
  if (!args.rawPath.startsWith(`${repo}${path.sep}`)) throw new Error('raw ledger must be within this repository workspace');
  return args;
}

function usage() {
  console.log('Usage: node benchmarks/adaptive-goal-graph/verify-phase1-ledger.mjs --raw artifacts/run.json [--manifest artifacts/run.json.manifest.json] [--allow-historical-source]');
  console.log('Independently audits completeness, unique trial identities, graph hashes, oracle outcomes, metric consistency, paired tables, provenance and optional sidecar file hashes. It never writes or repairs the ledger.');
  console.log('Schema-v4 artifacts require --allow-historical-source and remain historical evidence; a successful integrity audit is never an acceptance decision.');
}

function readStableRegularFile(filePath, label, maxBytes = 256 * 1024 * 1024) {
  const resolved = path.resolve(filePath);
  let pathBefore;
  try { pathBefore = fs.lstatSync(resolved, { bigint: true }); }
  catch { throw new Error(`${label} is missing or unreadable: ${resolved}`); }
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || fs.realpathSync(resolved) !== resolved || pathBefore.size > BigInt(maxBytes)) {
    throw new Error(`${label} must be a canonical regular non-symlink file within ${maxBytes} bytes: ${resolved}`);
  }
  let fd;
  try {
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino || before.size > BigInt(maxBytes)) {
      throw new Error(`${label} identity or size changed before reading: ${resolved}`);
    }
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > maxBytes) throw new Error(`${label} exceeded ${maxBytes} bytes while reading: ${resolved}`);
      chunks.push(chunk.subarray(0, count));
    }
    const bytes = Buffer.concat(chunks, total);
    const after = fs.fstatSync(fd, { bigint: true });
    const pathAfter = fs.lstatSync(resolved, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || bytes.byteLength !== Number(after.size) ||
        pathAfter.isSymbolicLink() || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino ||
        pathAfter.size !== before.size || pathAfter.mtimeNs !== before.mtimeNs || pathAfter.ctimeNs !== before.ctimeNs ||
        fs.realpathSync(resolved) !== resolved) throw new Error(`${label} changed during descriptor read: ${resolved}`);
    return bytes;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); process.exit(0); }
  const rawBytes = readStableRegularFile(args.rawPath, 'raw AGG Phase 1 ledger', 128 * 1024 * 1024);
  const raw = parseStrictJson(rawBytes, 'raw AGG Phase 1 ledger', { maxBytes: 128 * 1024 * 1024 });
  let manifest = null;
  let manifestBytes = null;
  if (args.manifestPath) {
    manifestBytes = readStableRegularFile(args.manifestPath, 'AGG Phase 1 benchmark sidecar manifest', 8 * 1024 * 1024);
    manifest = parseStrictJson(manifestBytes, 'AGG Phase 1 benchmark sidecar manifest');
  }
  const result = auditPhase1Ledger(raw, {
    rawBytes,
    rawPath: args.rawPath,
    manifest,
    manifestPath: args.manifestPath,
    sourceRoot: repo,
    allowHistoricalSource: args.allowHistoricalSource,
    requireManifest: Boolean(args.manifestPath)
  });
  const rawRecheck = readStableRegularFile(args.rawPath, 'raw AGG Phase 1 ledger final stability recheck', 128 * 1024 * 1024);
  if (!rawRecheck.equals(rawBytes)) throw new Error('raw AGG ledger changed during independent verification; discard result');
  if (args.manifestPath) {
    const manifestRecheck = readStableRegularFile(args.manifestPath, 'AGG Phase 1 benchmark sidecar manifest final stability recheck', 8 * 1024 * 1024);
    if (!manifestRecheck.equals(manifestBytes)) throw new Error('AGG benchmark sidecar manifest changed during independent verification; discard result');
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === 'FAIL') process.exitCode = 1;
} catch (error) {
  process.stderr.write(`PHASE1_LEDGER_AUDIT=FAIL\n${error?.stack || error}\n`);
  process.exitCode = 1;
}
