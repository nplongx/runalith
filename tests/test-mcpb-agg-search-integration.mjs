#!/usr/bin/env node
// Exercises the actual AGG MCP tool from the current owner-directed latest AGG-enabled engineering candidate.
// Read-only graph search only; package runtime uses a private disposable DB and workspace.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BUNDLE = 'artifacts/runalith-1.0.9-rc.5-candidate-latest-build-20261022T175328+0700.mcpb';
const EXPECTED_SHA256 = '9d836dca9daec26b53a104f99028fb30fd11848e8c0a8764c4eb7dedd45e1c37';
const bundlePath = path.resolve(ROOT, process.argv[2] ?? DEFAULT_BUNDLE);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed (${result.status ?? result.signal}): ${(result.stderr || result.stdout || '').slice(0, 2000)}`);
  return result.stdout;
}

function unpackResult(result) {
  assert.notEqual(result?.isError, true, `MCP tool returned error: ${JSON.stringify(result).slice(0, 2000)}`);
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const text = result?.content?.find(part => part.type === 'text')?.text;
  assert.equal(typeof text, 'string', 'MCP tool response has no structured/text result');
  try { return JSON.parse(text); } catch { assert.fail(`MCP tool returned non-JSON text: ${text.slice(0, 1000)}`); }
}

async function main() {
  const lstat = fs.lstatSync(bundlePath);
  assert.ok(lstat.isFile() && !lstat.isSymbolicLink(), 'MCPB must be a regular non-symlink file');
  const bytes = fs.readFileSync(bundlePath);
  const actualHash = hash(bytes);
  assert.equal(actualHash, EXPECTED_SHA256, 'MCPB does not match the pinned latest AGG-enabled candidate');
  assert.equal(lstat.size, 562167, 'MCPB size differs from the owner-directed current engineering candidate');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-mcpb-integration-'));
  fs.chmodSync(tempRoot, 0o700);
  const extracted = path.join(tempRoot, 'bundle');
  const home = path.join(tempRoot, 'home');
  const dataDir = path.join(tempRoot, 'data');
  const workspace = path.join(tempRoot, 'workspace');
  const executionTmp = path.join(tempRoot, 'execution-tmp');
  for (const dir of [extracted, home, dataDir, workspace, executionTmp]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  let child;
  let buffer = '';
  let stderr = '';
  let exited = false;
  const pending = new Map();
  let nextId = 1;

  function rejectPending(error) {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  function rpc(method, params = {}) {
    if (!child || exited) return Promise.reject(new Error(`MCP process is not running for ${method}`));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP RPC timed out: ${method}; stderr=${stderr.slice(-2000)}`));
      }, 7000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
        if (!error) return;
        const waiter = pending.get(id);
        if (!waiter) return;
        pending.delete(id);
        clearTimeout(waiter.timer);
        reject(error);
      });
    });
  }

  try {
    runSync('unzip', ['-t', bundlePath]);
    runSync('unzip', ['-q', bundlePath, '-d', extracted]);
    const manifest = JSON.parse(fs.readFileSync(path.join(extracted, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, '1.0.9-rc.5');
    assert.ok(manifest.tools.some(tool => tool.name === 'adaptive_goal_graph_search'), 'bundle manifest omits AGG search');

    child = spawn(process.execPath, [path.join(extracted, 'server/index.js')], {
      cwd: extracted,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home,
        TMPDIR: tempRoot, TEMP: tempRoot, TMP: tempRoot, LANG: 'C.UTF-8', NODE_ENV: 'production',
        RUNALITH_DATA_DIR: dataDir,
        RUNALITH_WORKFLOW_DB: path.join(dataDir, 'workflow.db'),
        RUNALITH_WORKSPACE: workspace,
        RUNALITH_EXECUTION_TMP_DIR: executionTmp
      }
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) {
        rejectPending(new Error('MCP stdout buffer exceeded 4 MiB'));
        child.kill('SIGKILL');
        return;
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch {
          rejectPending(new Error(`MCP stdout contained non-JSON data: ${line.slice(0, 400)}`));
          child.kill('SIGKILL');
          return;
        }
        const waiter = pending.get(message.id);
        if (waiter) {
          pending.delete(message.id);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2 * 1024 * 1024); });
    child.on('error', rejectPending);
    child.on('exit', (code, signal) => {
      exited = true;
      rejectPending(new Error(`MCP process exited (code=${code}, signal=${signal}); stderr=${stderr.slice(-2000)}`));
    });

    const initialized = await rpc('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agg-mcpb-integration-test', version: '1' }
    });
    assert.equal(initialized.error, undefined, JSON.stringify(initialized.error));
    assert.equal(initialized.result?.serverInfo?.version, manifest.version);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

    const listed = await rpc('tools/list', {});
    assert.equal(listed.error, undefined, JSON.stringify(listed.error));
    const tools = listed.result?.tools ?? [];
    assert.equal(tools.length, manifest.tools.length, 'runtime tool count differs from packaged manifest');
    assert.ok(tools.some(tool => tool.name === 'adaptive_goal_graph_search' && tool.inputSchema?.properties?.graph), 'runtime AGG tool/schema is absent');

    const healthCall = await rpc('tools/call', { name: 'orchestrator_health', arguments: {} });
    assert.equal(healthCall.error, undefined, JSON.stringify(healthCall.error));
    const health = unpackResult(healthCall.result);
    assert.equal(health.status, 'ok');
    assert.equal(health.mode, 'local-only-mcp');
    assert.equal(path.resolve(health.database), path.join(dataDir, 'workflow.db'), 'runtime DB escaped disposable temp directory');

    const graph = {
      schemaVersion: 1, startNodeId: 'start', goalNodeId: 'goal',
      nodes: [
        { id: 'start', type: 'task', label: 'Start' },
        { id: 'step-one', type: 'task', label: 'Perform one step', estimatedCost: 1, estimatedRisk: 0.1, estimatedSuccessConfidence: 0.95 },
        { id: 'goal', type: 'goal', label: 'Goal' }
      ],
      edges: [
        { from: 'start', to: 'step-one', type: 'next_step' },
        { from: 'step-one', to: 'goal', type: 'next_step' }
      ]
    };
    const call = await rpc('tools/call', {
      name: 'adaptive_goal_graph_search',
      arguments: { graph, options: { beamWidth: 4, maxDepth: 5, maxExpansions: 20 } }
    });
    assert.equal(call.error, undefined, JSON.stringify(call.error));
    const result = unpackResult(call.result);
    assert.equal(result.status, 'proposals_found', JSON.stringify(result).slice(0, 2000));
    assert.equal(result.mode, 'shadow');
    assert.match(result.graphHash, /^[a-f0-9]{64}$/);
    assert.ok(Array.isArray(result.candidates) && result.candidates.length > 0, 'AGG returned no candidates');
    assert.ok(Array.isArray(result.planGraphDrafts) && result.planGraphDrafts.length > 0, 'AGG returned no review-only Plan Graph draft');

    console.log('MCPB_AGG_SEARCH_INTEGRATION=PASS');
    console.log(`candidate_sha256=${actualHash}`);
    console.log(`candidate_bytes=${lstat.size}`);
    console.log(`version=${manifest.version}`);
    console.log(`manifest_tools=${manifest.tools.length}`);
    console.log(`runtime_tools=${tools.length}`);
    console.log(`agg_tool=adaptive_goal_graph_search`);
    console.log(`search_status=${result.status}`);
    console.log(`graph_sha256=${result.graphHash}`);
    console.log(`candidate_count=${result.candidates.length}`);
    console.log(`plan_graph_draft_count=${result.planGraphDrafts.length}`);
    console.log('workflow_created=false');
    console.log('approved=false');
    console.log('dispatch_allowed=false');
    console.log('production_authority_granted=false');
    console.log('runtime_database=disposable_temp_only');
  } finally {
    if (child) {
      if (!exited) {
        child.stdin.end();
        await new Promise(resolve => {
          const timer = setTimeout(() => { if (!exited) child.kill('SIGTERM'); resolve(); }, 750);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      }
      if (!exited) child.kill('SIGKILL');
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`MCPB_AGG_SEARCH_INTEGRATION=FAIL\n${error?.stack || error}`);
  process.exitCode = 1;
});
