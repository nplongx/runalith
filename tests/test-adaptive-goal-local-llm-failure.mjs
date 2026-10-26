import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { auditLocalLLMPhase1Ledger } from '../benchmarks/adaptive-goal-graph/verify-local-llm-phase1-ledger.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(root, 'benchmarks/adaptive-goal-graph/run-local-llm-phase1-benchmark.mjs');
const input = path.join(root, 'artifacts/phase1-benchmark-raw-20261022T040839Z-schema5.json');
fs.mkdirSync(path.join(root, '.test-tmp'), { recursive: true });
const tempDir = fs.mkdtempSync(path.join(root, '.test-tmp', 'agg-local-llm-failure-'));

function spawnRunner(args) {
  return spawnSync(process.execPath, [runner, ...args], {
    cwd: root, encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024
  });
}
function spawnRunnerAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
  });
}

test('model endpoint rejects non-loopback hosts and endpoint path injection', () => {
  const publicOutput = path.join(tempDir, 'public-endpoint.json');
  const publicHost = spawnRunner(['--output', publicOutput, '--input', input, '--endpoint', 'http://example.com:11434']);
  assert.equal(publicHost.status, 1);
  assert.match(publicHost.stderr, /literal localhost|127\.0\.0\.1|::1/);
  assert.equal(fs.existsSync(publicOutput), false);

  const pathOutput = path.join(tempDir, 'path-endpoint.json');
  const pathInjection = spawnRunner(['--output', pathOutput, '--input', input, '--endpoint', 'http://127.0.0.1:11434/proxy']);
  assert.equal(pathInjection.status, 1);
  assert.match(pathInjection.stderr, /without path\/query\/credentials/);
  assert.equal(fs.existsSync(pathOutput), false);
});

test('model-call failure persists one honest failure record, zero retries and no fabricated final ledger', async () => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    requests.push(request.url);
    if (request.url === '/api/version') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: 'mock-local-test-1' }));
    } else if (request.url === '/api/tags') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [{
        name: 'qwen3:4b-instruct', model: 'qwen3:4b-instruct', digest: 'sha256:mock-only', size: 123,
        details: { family: 'test-double', parameter_size: '0B', quantization_level: 'none' }
      }] }));
    } else if (request.url === '/api/generate') {
      // Emulate a local provider failure; it must be captured and must not be retried.
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'simulated test-only provider outage' }));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const output = path.join(tempDir, 'failed-model-run.json');
  const report = path.join(tempDir, 'failed-model-run.md');
  try {
    const result = await spawnRunnerAsync([
      '--output', output, '--report', report, '--input', input, '--limit', '1', '--model', 'qwen3:4b-instruct',
      '--timeout-ms', '3000', '--endpoint', endpoint
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /recorded in partial JSONL/);
    assert.deepEqual(requests, ['/api/version', '/api/tags', '/api/generate']);
    assert.equal(fs.existsSync(output), false, 'a failed/incomplete run must not produce a final raw result');
    assert.equal(fs.existsSync(report), false, 'a failed/incomplete run must not produce a completed report');
    const partial = `${output}.partial.jsonl`;
    assert.equal(fs.existsSync(partial), true, 'failure ledger must survive the runner exception');
    const partialManifestPath = `${output}.partial.manifest.json`;
    assert.equal(fs.existsSync(partialManifestPath), true, 'an incomplete run must create a non-acceptance manifest');
    const partialManifest = JSON.parse(fs.readFileSync(partialManifestPath, 'utf8'));
    assert.equal(partialManifest.status, 'INCOMPLETE');
    assert.equal(partialManifest.exitCode, 1);
    assert.equal(partialManifest.decision, 'INCOMPLETE_NOT_ACCEPTANCE');
    assert.equal(partialManifest.failureRecords, 1);
    assert.equal(partialManifest.hashes.datasetSha256.length, 64);
    assert.equal(partialManifest.outputs.partialJsonl.sha256.length, 64);
    const events = fs.readFileSync(partial, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.filter(event => event.type === 'run_record').length, 0);
    const failures = events.filter(event => event.type === 'run_failure');
    assert.equal(failures.length, 1);
    const record = failures[0].record;
    assert.equal(record.method, 'llm-chain');
    assert.equal(record.provider, 'ollama-local');
    assert.equal(record.modelDigest, 'sha256:mock-only');
    assert.equal(record.attemptCount, 1);
    assert.equal(record.retryCount, 0);
    assert.equal(record.retryBudget, 0);
    assert.equal(record.trialExitCode, 1);
    assert.equal(record.timedOut, false);
    assert.equal(record.taskOutcomeCorrect, null);
    assert.equal(record.promptEvalCount, null);
    assert.equal(record.outputEvalCount, null);
    assert.equal(record.tokenCost, null);
    assert.equal(record.monetaryCost, null);
    assert.equal(record.trialError.message, 'Local Ollama /api/generate returned HTTP 503');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('mock successful local calls create complete provenance, paired rows and exclusive output manifest', async () => {
  const inputLedger = JSON.parse(fs.readFileSync(input, 'utf8'));
  const firstTask = inputLedger.taskCatalog[0];
  assert.ok(firstTask.expectedPath, 'test fixture must have an oracle-validated path');
  const calls = [];
  const server = http.createServer(async (request, response) => {
    calls.push(request.url);
    if (request.url === '/api/version') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: 'mock-local-test-2' }));
    } else if (request.url === '/api/tags') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [{
        name: 'qwen3:4b-instruct', model: 'qwen3:4b-instruct', digest: 'sha256:mock-success-only', size: 123,
        details: { family: 'test-double', parameter_size: '0B', quantization_level: 'none' }
      }] }));
    } else if (request.url === '/api/generate') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      assert.equal(payload.stream, false);
      assert.equal(payload.model, 'qwen3:4b-instruct');
      // The mock emits only the fixture's expected route; it is test wiring, not model evidence.
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        response: JSON.stringify({ status: 'solution', path: firstTask.expectedPath }),
        prompt_eval_count: 123, eval_count: 5,
        total_duration: 12_000_000, load_duration: 1_000_000,
        prompt_eval_duration: 8_000_000, eval_duration: 3_000_000
      }));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const output = path.join(tempDir, 'successful-mock-run.json');
  const report = path.join(tempDir, 'successful-mock-run.md');
  try {
    const result = await spawnRunnerAsync([
      '--output', output, '--report', report, '--input', input, '--limit', '1', '--model', 'qwen3:4b-instruct',
      '--timeout-ms', '3000', '--endpoint', endpoint
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(calls, ['/api/version', '/api/tags', '/api/generate', '/api/generate']);
    const rawBytes = fs.readFileSync(output);
    const raw = JSON.parse(rawBytes.toString('utf8'));
    const manifestPath = `${output}.manifest.json`;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const audited = auditLocalLLMPhase1Ledger(raw, {
      rawBytes, rawPath: output, manifest, manifestPath, sourceRoot: root
    });
    assert.equal(audited.status, 'PASS_INTEGRITY_ONLY_NOT_ACCEPTANCE', JSON.stringify(audited.errors, null, 2));
    assert.equal(raw.decision, 'SUPPLEMENTAL_EVIDENCE_NOT_ACCEPTANCE');
    assert.equal(raw.modelCalls, 2);
    assert.equal(raw.localHttpRequests, 4);
    assert.equal(raw.externalNetworkCalls, 0);
    assert.equal(raw.toolCalls, 0);
    assert.equal(raw.measuredInputTokens, 246);
    assert.equal(raw.measuredOutputTokens, 10);
    assert.equal(raw.monetaryCost, null);
    assert.equal(raw.records.length, 3);
    assert.equal(new Set(raw.records.map(record => record.trialId)).size, 3);
    assert.ok(raw.records.every(record => record.configurationSha256 === raw.configurationSha256));
    assert.ok(raw.records.every(record => record.datasetSha256 === raw.datasetSha256));
    assert.ok(raw.records.every(record => record.sourceSetSha256 === raw.sourceSetSha256));
    assert.ok(raw.records.every(record => record.graderSha256 === raw.graderSha256));
    assert.ok(raw.records.every(record => record.taskOutcomeCorrect === true));
    assert.equal(raw.inference.pairedSuccessComparisons.length, 2);
    assert.ok(raw.inference.pairedSuccessComparisons.every(row => row.pairedTaskInstances === 1 && row.independentTaskFamilyClusters === 1));
    assert.equal(manifest.status, 'COMPLETE');
    assert.equal(manifest.exitCode, 0);
    assert.equal(manifest.decision, 'SUPPLEMENTAL_EVIDENCE_NOT_ACCEPTANCE');
    assert.equal(manifest.outputs.raw.sha256, createHash('sha256').update(rawBytes).digest('hex'));
    assert.equal(manifest.outputs.report.sha256, createHash('sha256').update(fs.readFileSync(report)).digest('hex'));
    const corrupted = structuredClone(raw);
    corrupted.records[0].configurationSha256 = '0'.repeat(64);
    const corruptedAudit = auditLocalLLMPhase1Ledger(corrupted, {
      rawBytes: Buffer.from(JSON.stringify(corrupted)), rawPath: output, manifest, manifestPath, sourceRoot: root
    });
    assert.equal(corruptedAudit.status, 'FAIL');
    assert.ok(corruptedAudit.errors.some(message => message.includes('record provenance hash mismatch')));
    assert.equal(fs.existsSync(`${output}.partial.jsonl`), false);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('model request timeout is retained as a timeout failure with no retry and no completed ledger', async () => {
  let generateRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/api/version') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: 'mock-local-timeout' }));
    } else if (request.url === '/api/tags') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [{
        name: 'qwen3:4b-instruct', model: 'qwen3:4b-instruct', digest: 'sha256:mock-timeout', size: 321,
        details: { family: 'test-double', parameter_size: '0B', quantization_level: 'none' }
      }] }));
    } else if (request.url === '/api/generate') {
      generateRequests += 1;
      // Leave the local connection pending; AbortSignal.timeout must terminate it.
      request.on('close', () => {});
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const output = path.join(tempDir, 'timed-out-model-run.json');
  const endpoint = `http://127.0.0.1:${address.port}`;
  try {
    const result = await spawnRunnerAsync([
      '--output', output, '--input', input, '--limit', '1', '--model', 'qwen3:4b-instruct',
      '--timeout-ms', '1000', '--endpoint', endpoint
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /recorded in partial JSONL/);
    assert.equal(generateRequests, 1, 'timeout must not lead to an implicit retry');
    assert.equal(fs.existsSync(output), false);
    const partial = `${output}.partial.jsonl`;
    const events = fs.readFileSync(partial, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const failures = events.filter(event => event.type === 'run_failure');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].record.timedOut, true);
    assert.equal(failures[0].record.attemptCount, 1);
    assert.equal(failures[0].record.retryCount, 0);
    assert.equal(failures[0].record.trialExitCode, 1);
    assert.equal(failures[0].record.promptEvalCount, null);
    assert.equal(failures[0].record.outputEvalCount, null);
    const incompleteManifest = JSON.parse(fs.readFileSync(`${output}.partial.manifest.json`, 'utf8'));
    assert.equal(incompleteManifest.status, 'INCOMPLETE');
    assert.equal(incompleteManifest.exitCode, 1);
  } finally {
    server.closeAllConnections?.();
    server.close();
    await once(server, 'close');
  }
});

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
