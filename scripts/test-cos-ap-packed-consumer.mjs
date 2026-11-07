#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(root, 'protocol/cos-ap-v1');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-ap-packed-consumer-'));
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, npm_config_update_notifier: 'false' } });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.signal}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
};

try {
  const packOutput = run('npm', ['pack', '--json', '--pack-destination', temporaryRoot], packageRoot);
  const pack = JSON.parse(packOutput)[0];
  assert.equal(pack.name, '@runalith/cos-ap');
  assert.equal(pack.version, '0.1.0');
  assert.ok(Array.isArray(pack.files) && pack.files.some(file => file.path === 'index.js'));
  for (const schema of ['envelope', 'execution-batch', 'execution-result', 'child-result', 'provider-status', 'synthesis']) {
    assert.ok(pack.files.some(file => file.path === `${schema}.schema.json`), `packed artifact missing ${schema} schema`);
  }
  const tarball = path.join(temporaryRoot, pack.filename);
  const tarballSha256 = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  const consumer = path.join(temporaryRoot, 'consumer');
  fs.mkdirSync(consumer, { mode: 0o700 });
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', consumer, tarball], temporaryRoot);
  const consumerTest = path.join(consumer, 'consumer-contract.mjs');
  fs.writeFileSync(consumerTest, `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as cos from '@runalith/cos-ap';
assert.equal(cos.COS_AP_PROTOCOL, 'cos-ap');
assert.equal(cos.COS_AP_VERSION, 1);
assert.equal(typeof cos.validateEnvelope, 'function');
assert.equal(typeof cos.validateDurableExecutionRequest, 'function');
for (const name of cos.COS_AP_SCHEMA_NAMES) {
  const schemaPath = cos.schemaPath(name);
  assert.ok(fs.statSync(schemaPath).isFile(), 'schema missing from installed tarball: ' + name);
  assert.ok(cos.readSchema(name).$schema.includes('json-schema.org/draft/'));
}
assert.throws(() => cos.schemaPath('../package.json'), /unsupported COS-AP schema name/);
`);
  run(process.execPath, [consumerTest], consumer);
  process.stdout.write(`${JSON.stringify({ result: 'PASS', package: pack.name, version: pack.version,
    tarball: path.basename(tarball), tarballSha256, packedFiles: pack.files.length,
    installedConsumer: true, rootExport: true, schemaFiles: cosSchemaNames(pack.files) }, null, 2)}\n`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

function cosSchemaNames(files) {
  return files.filter(file => /\.schema\.json$/.test(file.path)).map(file => file.path).sort();
}
