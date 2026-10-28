#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 4000;
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2000;

function usage() {
  console.log('Usage: npm run test:mcpb-candidate -- <candidate.mcpb> [--timeout-ms 4000]');
  console.log('Extracts a Runalith MCPB to a private temporary directory, launches the packaged entry point with isolated state, and checks initialize/tools/list/orchestrator_health. It never installs the bundle.');
}

function parseArgs(argv) {
  let bundle = null;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--timeout-ms') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 500 || value > 30_000) {
        throw new Error('--timeout-ms must be an integer from 500 to 30000');
      }
      timeoutMs = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else if (bundle === null) {
      bundle = arg;
    } else {
      throw new Error('only one MCPB path may be supplied');
    }
  }
  if (!bundle) throw new Error('a candidate .mcpb path is required');
  return { bundle, timeoutMs };
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 10_000,
    maxBuffer: 16 * 1024 * 1024,
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? result.signal}: ${(result.stderr || result.stdout || '').slice(0, 2000)}`);
  }
  return result.stdout;
}

function readStableCandidate(filePath) {
  let pathBefore;
  try { pathBefore = fs.lstatSync(filePath, { bigint: true }); }
  catch { assert.fail('candidate must be a readable regular file'); }
  assert.ok(pathBefore.isFile() && !pathBefore.isSymbolicLink(), 'candidate must be a regular file, not a symlink');
  assert.equal(fs.realpathSync(filePath), filePath, 'candidate path must be canonical');
  assert.ok(pathBefore.size > 0n && pathBefore.size <= BigInt(MAX_BUNDLE_BYTES),
    `candidate size must be between 1 byte and ${MAX_BUNDLE_BYTES} bytes`);
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd, { bigint: true });
    assert.ok(before.isFile() && before.dev === pathBefore.dev && before.ino === pathBefore.ino && before.size === pathBefore.size,
      'candidate identity changed before smoke-test capture');
    const chunks = [];
    let total = 0;
    while (total <= MAX_BUNDLE_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_BUNDLE_BYTES + 1 - total));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      assert.ok(total <= MAX_BUNDLE_BYTES, 'candidate exceeds the smoke-test size limit');
      chunks.push(chunk.subarray(0, count));
    }
    const bytes = Buffer.concat(chunks, total);
    const after = fs.fstatSync(fd, { bigint: true });
    const pathAfter = fs.lstatSync(filePath, { bigint: true });
    assert.ok(after.dev === before.dev && after.ino === before.ino && after.size === before.size &&
      after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs && bytes.byteLength === Number(after.size) &&
      pathAfter.isFile() && !pathAfter.isSymbolicLink() && pathAfter.dev === before.dev && pathAfter.ino === before.ino &&
      pathAfter.size === before.size && pathAfter.mtimeNs === before.mtimeNs && pathAfter.ctimeNs === before.ctimeNs &&
      fs.realpathSync(filePath) === filePath, 'candidate changed while its bytes were captured');
    return { bytes, sizeBytes: bytes.byteLength };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function inspectArchive(bundlePath) {
  const names = runSync('unzip', ['-Z1', bundlePath]).split(/\r?\n/).filter(Boolean);
  assert.ok(names.length > 0, 'MCPB archive is empty');
  assert.ok(names.length <= MAX_ARCHIVE_ENTRIES, `MCPB contains too many ZIP entries: ${names.length}`);
  assert.equal(new Set(names).size, names.length, 'MCPB contains duplicate ZIP entry names');
  for (const entry of names) {
    assert.ok(!entry.startsWith('/') && !entry.startsWith('\\') && !/^[A-Za-z]:/.test(entry),
      `MCPB contains an absolute path: ${entry}`);
    assert.ok(!entry.includes('\\'), `MCPB contains a backslash path: ${entry}`);
    const segments = entry.split('/');
    assert.ok(!segments.includes('..'), `MCPB path traversal entry rejected: ${entry}`);
    assert.ok(!entry.split('/').some(segment => segment === '.'), `MCPB non-canonical entry rejected: ${entry}`);
  }

  // MCPBs are expected to contain regular files/directories, not links that could
  // redirect extraction or runtime imports outside the temporary bundle root.
  const listing = runSync('zipinfo', ['-l', bundlePath]);
  for (const line of listing.split(/\r?\n/)) {
    const mode = line.match(/^([bcdlps-][rwxstST-]{9})\s/);
    if (mode) assert.ok(mode[1][0] === '-' || mode[1][0] === 'd',
      `MCPB non-regular ZIP entry rejected: ${line.slice(0, 160)}`);
  }
  const listingLines = runSync('unzip', ['-l', bundlePath]).trim().split(/\r?\n/);
  const summary = listingLines.at(-1).match(/^\s*(\d+)\s+(\d+)\s+files?\s*$/);
  assert.ok(summary, 'could not verify MCPB expanded size');
  assert.equal(Number(summary[2]), names.length, 'MCPB directory listing count is inconsistent');
  assert.ok(Number(summary[1]) <= MAX_UNPACKED_BYTES,
    `MCPB expanded size exceeds ${MAX_UNPACKED_BYTES} bytes`);
  return names;
}

function responseText(result) {
  const textPart = result?.content?.find(item => item.type === 'text')?.text;
  if (typeof textPart !== 'string') return null;
  try { return JSON.parse(textPart); } catch { return textPart; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const bundlePath = path.resolve(process.cwd(), args.bundle);
  assert.ok(bundlePath.toLowerCase().endsWith('.mcpb'), 'candidate filename must end with .mcpb');
  const capturedCandidate = readStableCandidate(bundlePath);
  const bundleLstat = { size: capturedCandidate.sizeBytes };

  const startedAt = process.hrtime.bigint();
  const candidateSha256 = crypto.createHash('sha256').update(capturedCandidate.bytes).digest('hex');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runalith-mcpb-fast-test-'));
  fs.chmodSync(tempRoot, 0o700);
  const extracted = path.join(tempRoot, 'bundle');
  const home = path.join(tempRoot, 'home');
  const dataDir = path.join(tempRoot, 'data');
  const workspace = path.join(tempRoot, 'workspace');
  const executionTmp = path.join(tempRoot, 'execution-tmp');
  const inspectionBundlePath = path.join(tempRoot, 'captured-candidate.mcpb');
  for (const dir of [extracted, home, dataDir, workspace, executionTmp]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const assertSnapshotStillMatches = () => {
    const current = readStableCandidate(inspectionBundlePath);
    assert.equal(crypto.createHash('sha256').update(current.bytes).digest('hex'), candidateSha256,
      'private candidate snapshot changed after capture');
  };

  let child = null;
  let stdout = '';
  let stderr = '';
  let buffer = '';
  let exited = false;
  let exitInfo = null;
  let exitResolve;
  const exitPromise = new Promise(resolve => { exitResolve = resolve; });
  const pending = new Map();
  let nextId = 1;

  function failPending(error) {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  function handleStdout(chunk) {
    stdout += chunk;
    buffer += chunk;
    if (stdout.length > 4 * 1024 * 1024) {
      const error = new Error('MCPB runtime wrote more than 4 MiB to stdout during smoke test');
      failPending(error);
      child?.kill('SIGKILL');
      return;
    }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch {
        const error = new Error(`MCPB wrote non-JSON data to stdout: ${line.slice(0, 300)}`);
        failPending(error);
        child?.kill('SIGKILL');
        return;
      }
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  }

  function rpc(method, params = {}) {
    if (!child || exited) return Promise.reject(new Error(`MCPB runtime is not running for ${method}`));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCPB RPC timed out after ${args.timeoutMs} ms: ${method}\nstderr=${stderr.slice(-1500)}`));
      }, args.timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
        if (!error) return;
        const waiter = pending.get(id);
        if (waiter) {
          pending.delete(id);
          clearTimeout(waiter.timer);
          reject(error);
        }
      });
    });
  }

  async function stopChild() {
    if (!child) return;
    if (!exited) {
      child.stdin.end();
      await Promise.race([exitPromise, new Promise(resolve => setTimeout(resolve, 500))]);
    }
    if (!exited) {
      child.kill('SIGTERM');
      await Promise.race([exitPromise, new Promise(resolve => setTimeout(resolve, 500))]);
    }
    if (!exited) child.kill('SIGKILL');
  }

  try {
    const candidateFd = fs.openSync(inspectionBundlePath, 'wx', 0o400);
    try { fs.writeFileSync(candidateFd, capturedCandidate.bytes); fs.fsyncSync(candidateFd); }
    finally { fs.closeSync(candidateFd); }
    assertSnapshotStillMatches();
    const entries = inspectArchive(inspectionBundlePath);
    assertSnapshotStillMatches();
    assert.ok(entries.includes('manifest.json'), 'MCPB is missing root manifest.json');
    assert.ok(entries.includes('package.json'), 'Runalith MCPB is missing root package.json');
    assert.ok(entries.includes('server/index.js'), 'Runalith MCPB is missing server/index.js');

    runSync('unzip', ['-q', inspectionBundlePath, '-d', extracted], { timeout: 15_000 });
    assertSnapshotStillMatches();
    const manifest = JSON.parse(fs.readFileSync(path.join(extracted, 'manifest.json'), 'utf8'));
    const packageMetadata = JSON.parse(fs.readFileSync(path.join(extracted, 'package.json'), 'utf8'));
    assert.equal(manifest.name, 'runalith-agent-orchestrator', 'MCPB manifest is not the Runalith local MCP plugin');
    assert.equal(manifest.server?.type, 'node', 'candidate must declare a Node MCP server');
    const manifestEntryPoint = manifest.server?.entry_point;
    assert.ok(typeof manifestEntryPoint === 'string' && manifestEntryPoint.length > 0 &&
      !path.isAbsolute(manifestEntryPoint) && !manifestEntryPoint.includes('\\') &&
      manifestEntryPoint.split('/').every(part => part && part !== '.' && part !== '..') &&
      /^[A-Za-z0-9._/-]+$/.test(manifestEntryPoint), 'candidate must declare a safe relative server entry point');
    assert.equal(manifest.server?.mcp_config?.command, 'node', 'candidate launch command must be node');
    assert.deepEqual(manifest.server?.mcp_config?.args, [`${'${__dirname}/'}${manifestEntryPoint}`], 'candidate MCP launch args changed unexpectedly');
    assert.equal(packageMetadata.main, manifestEntryPoint);
    assert.equal(packageMetadata.type, 'module');
    assert.equal(packageMetadata.version, manifest.version);
    assert.ok(Array.isArray(manifest.tools) && manifest.tools.length > 0, 'manifest tools must be a non-empty array');
    const rcVersion = /^1\.0\.9-rc\.(\d+)$/.exec(manifest.version)?.[1];
    const requiresRuntimeIdentity = (rcVersion !== undefined && Number(rcVersion) >= 17) ||
      Object.keys(manifest.user_config || {}).length > 0;
    if (requiresRuntimeIdentity) {
      const trustConfigUserFields = {
        goal_idea_verifier_trust_config_json: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON',
        action_intent_reviewer_trust_config_json: 'AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON'
      };
      assert.deepEqual(Object.keys(manifest.user_config || {}).sort(), Object.keys(trustConfigUserFields).sort(),
        'current candidate must expose only the two administrator-managed AGG trust configuration inputs');
      for (const [configKey, environmentName] of Object.entries(trustConfigUserFields)) {
        const config = manifest.user_config[configKey];
        assert.equal(config.type, 'string', configKey + ': config must be a JSON string');
        assert.equal(config.default, '', configKey + ': optional trust input must default to blank, never to a baked-in root');
        assert.equal(config.required, false, configKey + ': unconfigured installation must start fail-closed');
        assert.match(config.description || '', /public Ed25519 keys only/i,
          configKey + ': manifest must warn against supplying private keys');
        assert.equal(manifest.server?.mcp_config?.env?.[environmentName], '${user_config.' + configKey + '}',
          environmentName + ': host must inject the value from installed config UI');
      }
    }

    const safePath = p => {
      const resolved = path.resolve(extracted, p);
      assert.ok(resolved.startsWith(`${extracted}${path.sep}`), `entry path escapes archive: ${p}`);
      return resolved;
    };
    const entryPoint = safePath(manifestEntryPoint);
    assert.ok(fs.statSync(entryPoint).isFile(), 'manifest entry point is not a regular file');

    // The manifest advertises the complete optional AGG tool schemas, but the
    // ordinary runtime intentionally hides these tools unless each local opt-in
    // is set. Enable them for this declaration/schema parity probe only when the
    // candidate actually advertises all three; historical 67-tool bundles must
    // continue to be tested with their default 67-tool surface.
    const optionalToolFlags = [
      ['adaptive_goal_phase2_shadow_search', 'AGG_PHASE2_SHADOW_TOOL_ENABLED'],
      ['adaptive_goal_phase3_mcts_shadow_search', 'AGG_PHASE3_MCTS_TOOL_ENABLED'],
      ['adaptive_goal_knowledge_capture_workflow_outcome', 'AGG_PHASE4_KNOWLEDGE_CAPTURE_TOOL_ENABLED']
    ];
    const manifestToolNames = new Set(manifest.tools.map(tool => tool.name));
    const advertiseAllOptionalTools = optionalToolFlags.every(([name]) => manifestToolNames.has(name));
    const optInEnv = advertiseAllOptionalTools
      ? Object.fromEntries(optionalToolFlags.map(([, envName]) => [envName, '1']))
      : {};

    child = spawn(process.execPath, [entryPoint], {
      cwd: extracted,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: home,
        TMPDIR: tempRoot,
        TEMP: tempRoot,
        TMP: tempRoot,
        LANG: 'C.UTF-8',
        NODE_ENV: 'production',
        RUNALITH_DATA_DIR: dataDir,
        RUNALITH_WORKFLOW_DB: path.join(dataDir, 'workflow.db'),
        RUNALITH_WORKSPACE: workspace,
        RUNALITH_EXECUTION_TMP_DIR: executionTmp,
        ...optInEnv
      }
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', handleStdout);
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.length > 2 * 1024 * 1024) stderr = stderr.slice(-2 * 1024 * 1024);
    });
    child.on('error', error => {
      failPending(error);
    });
    child.on('exit', (code, signal) => {
      exited = true;
      exitInfo = { code, signal };
      exitResolve(exitInfo);
      failPending(new Error(`MCPB runtime exited before response (code=${code}, signal=${signal}); stderr=${stderr.slice(-2500)}`));
    });

    const initialized = await rpc('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'runalith-mcpb-fast-test', version: '1' }
    });
    assert.equal(initialized.error, undefined, `initialize returned error: ${JSON.stringify(initialized.error)}`);
    assert.equal(initialized.result?.serverInfo?.name, manifest.name, 'runtime server name differs from manifest');
    assert.equal(initialized.result?.serverInfo?.version, manifest.version, 'runtime version differs from manifest');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

    const listed = await rpc('tools/list', {});
    assert.equal(listed.error, undefined, `tools/list returned error: ${JSON.stringify(listed.error)}`);
    const tools = listed.result?.tools;
    assert.ok(Array.isArray(tools), 'runtime tools/list did not return an array');
    assert.equal(tools.length, manifest.tools.length, 'runtime tool count does not match manifest');
    assert.deepEqual(tools.map(t => t.name).sort(), manifest.tools.map(t => t.name).sort(), 'runtime tool names differ from manifest');
    for (const tool of tools) {
      assert.ok(tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema), `${tool.name}: missing schema`);
      assert.equal(tool.inputSchema.type, 'object', `${tool.name}: schema type must be object`);
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name}: schema must reject extra fields`);
      assert.ok(tool.inputSchema.properties && typeof tool.inputSchema.properties === 'object', `${tool.name}: schema properties missing`);
      assert.doesNotThrow(() => JSON.stringify(tool.inputSchema), `${tool.name}: schema is not JSON serializable`);
    }

    const healthCall = await rpc('tools/call', { name: 'orchestrator_health', arguments: {} });
    assert.equal(healthCall.error, undefined, `orchestrator_health returned RPC error: ${JSON.stringify(healthCall.error)}`);
    assert.notEqual(healthCall.result?.isError, true, `orchestrator_health failed: ${JSON.stringify(healthCall.result)}`);
    const health = healthCall.result?.structuredContent ?? responseText(healthCall.result);
    assert.equal(health?.status, 'ok', `packaged runtime health is not ok: ${JSON.stringify(health)}`);
    assert.equal(health?.mode, 'local-only-mcp', `unexpected runtime mode: ${JSON.stringify(health)}`);
    if (requiresRuntimeIdentity) {
      assert.equal(health?.runtime_identity?.entry_point, manifestEntryPoint,
        'health must identify the exact entry point selected by the manifest');
      assert.equal(health?.runtime_identity?.entry_point_sha256_at_startup,
        crypto.createHash('sha256').update(fs.readFileSync(entryPoint)).digest('hex'),
        'health entry-point SHA-256 must match exact bytes extracted from candidate archive');
      assert.equal(health?.runtime_identity?.manifest_sha256_at_startup,
        crypto.createHash('sha256').update(fs.readFileSync(path.join(extracted, 'manifest.json'))).digest('hex'),
        'health manifest SHA-256 must match the exact manifest bytes extracted from candidate archive');
      assert.equal(health?.runtime_identity?.semantics, 'startup_file_hashes_only_not_package_digest_or_signed_provenance');
    }
    assert.equal(path.resolve(health?.database || ''), path.join(dataDir, 'workflow.db'), 'runtime database did not stay inside the disposable test directory');
    assertSnapshotStillMatches();

    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.log('MCPB_FAST_TEST=PASS');
    console.log(`candidate=${bundlePath}`);
    console.log(`sha256=${candidateSha256}`);
    console.log(`bytes=${bundleLstat.size}`);
    console.log(`archive_entries=${entries.length}`);
    console.log(`manifest_tools=${manifest.tools.length}`);
    console.log(`runtime_tools=${tools.length}`);
    console.log(`runtime=${health.status}/${health.mode}`);
    console.log(`isolated_database=${health.database}`);
    console.log(`elapsed_ms=${elapsedMs.toFixed(1)}`);
  } finally {
    await stopChild();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`MCPB_FAST_TEST=FAIL\n${error?.stack || error}`);
  process.exitCode = 1;
});
