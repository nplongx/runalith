import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'scripts/mcpb-tools.mjs');

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024, ...options });
}

function createBundle(tempRoot) {
  const source = path.join(tempRoot, 'source');
  fs.mkdirSync(path.join(source, 'server'), { recursive: true });
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({
    name: 'test-mcpb-direct-tools', version: '0.0.1',
    server: { type: 'node', entry_point: 'server/index.js', mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'] } },
    tools: [{ name: 'echo' }, { name: 'fail' }]
  }));
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'test-mcpb-direct-tools', version: '0.0.1', type: 'module', main: 'server/index.js' }));
  fs.writeFileSync(path.join(source, 'server/index.js'), `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const tools = [
  { name: 'echo', description: 'Return supplied arguments', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false } },
  { name: 'fail', description: 'Return a controlled tool error', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'put', description: 'Save a value in server memory', inputSchema: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key','value'], additionalProperties: false } },
  { name: 'get', description: 'Read a value from server memory', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } },
  { name: 'slow', description: 'Wait past the caller timeout', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'crash', description: 'Crash server process', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'badSchema', description: 'Invalid schema test', inputSchema: { type: 'object', properties: { x: { type: 'integer' } }, required: ['x'], additionalProperties: false } },
  { name: 'environment', description: 'Read selected runtime environment fields', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'spawnChildSlow', description: 'Spawn a descendant and wait past timeout for process-group cleanup test', inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false } },
  { name: 'dispatch_execution', description: 'Dispatch approved execution (policy must block by default)', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
];
const state = new Map();
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', async chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (!Object.hasOwn(request, 'id')) continue;
    let result;
    if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'test-mcpb-direct-tools', version: '0.0.1' } };
    else if (request.method === 'tools/list') result = { tools };
    else if (request.method === 'tools/call' && request.params.name === 'echo') result = { content: [{ type: 'text', text: JSON.stringify(request.params.arguments) }], structuredContent: request.params.arguments, isError: false };
    else if (request.method === 'tools/call' && request.params.name === 'fail') result = { content: [{ type: 'text', text: 'controlled failure' }], isError: true };
    else if (request.method === 'tools/call' && request.params.name === 'put') { state.set(request.params.arguments.key, request.params.arguments.value); result = { structuredContent: { saved: true } }; }
    else if (request.method === 'tools/call' && request.params.name === 'get') result = { structuredContent: { value: state.get(request.params.arguments.key) ?? null } };
    else if (request.method === 'tools/call' && request.params.name === 'slow') { await new Promise(resolve => setTimeout(resolve, 5000)); result = { structuredContent: { finished: true } }; }
    else if (request.method === 'tools/call' && request.params.name === 'crash') process.exit(42);
    else if (request.method === 'tools/call' && request.params.name === 'environment') result = { structuredContent: { testSecret: process.env.MCPB_TEST_SECRET ?? null, apiKey: process.env.OPENAI_API_KEY ?? null } };
    else if (request.method === 'tools/call' && request.params.name === 'spawnChildSlow') {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(request.params.arguments.marker, String(child.pid));
      await new Promise(resolve => setTimeout(resolve, 5000));
      result = { structuredContent: { childPid: child.pid } };
    }
    else if (request.method === 'tools/call' && request.params.name === 'dispatch_execution') result = { structuredContent: { dispatched: false } };
    else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unknown method' } }) + '\\n'); continue; }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
  }
});
`);
  const bundle = path.join(tempRoot, 'fixture.mcpb');
  const zip = run('zip', ['-qr', bundle, '.'], { cwd: source });
  assert.equal(zip.status, 0, `zip fixture failed: ${zip.stderr}`);
  return bundle;
}

function createArchivePathBundle(tempRoot, extraPaths) {
  const source = path.join(tempRoot, 'path-fixture');
  fs.mkdirSync(path.join(source, 'server'), { recursive: true });
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({
    name: 'test-mcpb-path-fixture', version: '0.0.1',
    server: { type: 'node', entry_point: 'server/index.js', mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'] } },
    tools: [{ name: 'echo' }]
  }));
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'test-mcpb-path-fixture', version: '0.0.1', type: 'module', main: 'server/index.js' }));
  fs.writeFileSync(path.join(source, 'server/index.js'), '');
  for (const entry of extraPaths) {
    const target = path.join(source, entry);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'fixture');
  }
  const bundle = path.join(tempRoot, 'path-fixture.mcpb');
  const zip = run('zip', ['-qr', bundle, '.'], { cwd: source });
  assert.equal(zip.status, 0, `path fixture ZIP failed: ${zip.stderr}`);
  return bundle;
}

function renameZipEntryBytes(bundle, oldName, newName) {
  const oldBytes = Buffer.from(oldName, 'utf8');
  const newBytes = Buffer.from(newName, 'utf8');
  assert.equal(newBytes.length, oldBytes.length, 'binary ZIP name replacement must preserve UTF-8 byte length');
  const archive = fs.readFileSync(bundle);
  let replacements = 0;
  for (let offset = 0; (offset = archive.indexOf(oldBytes, offset)) !== -1; offset += newBytes.length) {
    newBytes.copy(archive, offset);
    replacements++;
  }
  assert.ok(replacements >= 2, 'expected ZIP local and central directory filename entries');
  fs.writeFileSync(bundle, archive);
}

test('direct MCPB CLI lists packaged tools and calls a tool without installation', async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-direct-tools-test-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const bundle = createBundle(tempRoot);

  const listed = run(process.execPath, [cli, bundle, 'list']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /echo/);
  assert.match(listed.stdout, /fail/);
  assert.match(listed.stdout, /10 tools/);

  const rawArguments = JSON.stringify({ message: 'hello bundle' });
  const called = run(process.execPath, [cli, bundle, 'call', 'echo', rawArguments]);
  assert.equal(called.status, 0, called.stderr);
  const result = JSON.parse(called.stdout);
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent, { message: 'hello bundle' });

  const toolFailure = run(process.execPath, [cli, bundle, 'call', 'fail']);
  assert.equal(toolFailure.status, 2, toolFailure.stderr);
  assert.equal(JSON.parse(toolFailure.stdout).isError, true);

  const missingTool = run(process.execPath, [cli, bundle, 'call', 'not_a_tool']);
  assert.equal(missingTool.status, 1);
  assert.match(missingTool.stderr, /tool not exposed/);

  const malformedArguments = run(process.execPath, [cli, bundle, 'call', 'echo', '{broken']);
  assert.equal(malformedArguments.status, 1);
  assert.match(malformedArguments.stderr, /JSON/);

  const shell = run(process.execPath, [cli, bundle, 'shell'], { input: ':list\ncall echo {"message":"same session"}\n:quit\n' });
  assert.equal(shell.status, 0, shell.stderr);
  assert.match(shell.stdout, /MCPB shell connected/);
  assert.match(shell.stdout, /same session/);

  const invalidSchema = run(process.execPath, [cli, bundle, 'call', 'echo', '{"message":42}']);
  assert.equal(invalidSchema.status, 1);
  assert.match(invalidSchema.stderr, /schema mismatch/);
  const invalidInteger = run(process.execPath, [cli, bundle, 'call', 'badSchema', '{"x":"not-integer"}']);
  assert.equal(invalidInteger.status, 1);
  assert.match(invalidInteger.stderr, /expected integer/);
  const missingRequired = run(process.execPath, [cli, bundle, 'call', 'echo']);
  assert.equal(missingRequired.status, 1);
  assert.match(missingRequired.stderr, /missing required property message/);

  const sharedSession = run(process.execPath, [cli, bundle, 'shell'], { input: 'call put {"key":"idea","value":"goal-1"}\ncall get {"key":"idea"}\n:quit\n' });
  assert.equal(sharedSession.status, 0, sharedSession.stderr);
  assert.match(sharedSession.stdout, /goal-1/);

  const timeout = run(process.execPath, [cli, bundle, 'call', 'slow', '--timeout-ms', '500']);
  assert.equal(timeout.status, 1);
  assert.match(timeout.stderr, /timed out after 500 ms/);

  const secretProbe = run(process.execPath, [cli, bundle, 'call', 'environment'], {
    env: { ...process.env, MCPB_TEST_SECRET: 'must-not-reach-bundle', OPENAI_API_KEY: 'test-api-key-must-not-leak' }
  });
  assert.equal(secretProbe.status, 0, secretProbe.stderr);
  assert.deepEqual(JSON.parse(secretProbe.stdout).structuredContent, { testSecret: null, apiKey: null },
    'the bundle runtime must not inherit arbitrary parent secrets or provider API keys');

  const descendantMarker = path.join(tempRoot, 'descendant.pid');
  const descendantTimeout = run(process.execPath, [cli, bundle, 'call', 'spawnChildSlow', JSON.stringify({ marker: descendantMarker }), '--timeout-ms', '500']);
  assert.equal(descendantTimeout.status, 1);
  assert.match(descendantTimeout.stderr, /timed out after 500 ms/);
  assert.ok(fs.existsSync(descendantMarker), 'fixture server must record descendant PID before timeout');
  const descendantPid = Number(fs.readFileSync(descendantMarker, 'utf8'));
  assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
  const descendantStillAlive = spawnSync('kill', ['-0', String(descendantPid)], { encoding: 'utf8' });
  assert.notEqual(descendantStillAlive.status, 0, 'timeout must terminate the entire MCP server process group, including descendants');

  const crashed = run(process.execPath, [cli, bundle, 'call', 'crash']);
  assert.equal(crashed.status, 1);
  assert.match(crashed.stderr, /exited|not running/);

  const blockedSideEffect = run(process.execPath, [cli, bundle, 'call', 'dispatch_execution']);
  assert.equal(blockedSideEffect.status, 1);
  assert.match(blockedSideEffect.stderr, /side-effect policy/);
});

test('rejects unsafe ZIP paths, duplicate entries, symlink bundles, archive links, and invalid manifest entrypoints before launch', async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-direct-tools-archive-test-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const validBundle = createBundle(tempRoot);

  const symlinkBundle = path.join(tempRoot, 'bundle-link.mcpb');
  fs.symlinkSync(validBundle, symlinkBundle);
  const symlinkResult = run(process.execPath, [cli, symlinkBundle, 'list']);
  assert.equal(symlinkResult.status, 1);
  assert.match(symlinkResult.stderr, /regular file|symlink/i);

  const traversalBundle = path.join(tempRoot, 'traversal.mcpb');
  fs.copyFileSync(validBundle, traversalBundle);
  const traversalRename = spawnSync('zipnote', ['-w', traversalBundle], { input: '@ server/index.js\n@=../server-escape.js\n', encoding: 'utf8' });
  assert.equal(traversalRename.status, 0, traversalRename.stderr);
  const traversalResult = run(process.execPath, [cli, traversalBundle, 'list']);
  assert.equal(traversalResult.status, 1);
  assert.match(traversalResult.stderr, /unsafe ZIP path rejected/);

  const duplicateBundle = path.join(tempRoot, 'duplicate.mcpb');
  fs.copyFileSync(validBundle, duplicateBundle);
  const duplicateRename = spawnSync('zipnote', ['-w', duplicateBundle], { input: '@ package.json\n@=manifest.json\n', encoding: 'utf8' });
  assert.equal(duplicateRename.status, 0, duplicateRename.stderr);
  const duplicateResult = run(process.execPath, [cli, duplicateBundle, 'list']);
  assert.equal(duplicateResult.status, 1);
  assert.match(duplicateResult.stderr, /duplicate ZIP entries/);

  const prefixConflictBundle = path.join(tempRoot, 'prefix-conflict.mcpb');
  fs.copyFileSync(validBundle, prefixConflictBundle);
  const prefixConflictRename = spawnSync('zipnote', ['-w', prefixConflictBundle], {
    input: '@ package.json\n@=server\n', encoding: 'utf8'
  });
  assert.equal(prefixConflictRename.status, 0, prefixConflictRename.stderr);
  const prefixConflictResult = run(process.execPath, [cli, prefixConflictBundle, 'list']);
  assert.equal(prefixConflictResult.status, 1);
  assert.match(prefixConflictResult.stderr, /ZIP file\/directory path conflict/);

  const source = path.join(tempRoot, 'source');
  fs.symlinkSync('manifest.json', path.join(source, 'archive-link'));
  const linkedArchive = path.join(tempRoot, 'linked-entry.mcpb');
  const linkedZip = run('zip', ['-y', '-qr', linkedArchive, '.'], { cwd: source });
  assert.equal(linkedZip.status, 0, linkedZip.stderr);
  const linkedResult = run(process.execPath, [cli, linkedArchive, 'list']);
  assert.equal(linkedResult.status, 1);
  assert.match(linkedResult.stderr, /non-regular ZIP entry rejected/);

  fs.unlinkSync(path.join(source, 'archive-link'));
  const invalidManifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
  invalidManifest.server.entry_point = '../server/index.js';
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(invalidManifest));
  const badManifestBundle = path.join(tempRoot, 'bad-manifest.mcpb');
  const badManifestZip = run('zip', ['-qr', badManifestBundle, '.'], { cwd: source });
  assert.equal(badManifestZip.status, 0, badManifestZip.stderr);
  const badManifestResult = run(process.execPath, [cli, badManifestBundle, 'list']);
  assert.equal(badManifestResult.status, 1);
  assert.match(badManifestResult.stderr, /expected server entry point/);

  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(validBundle)).digest('hex').length, 64,
    'the test fixture bundle itself remains a deterministic byte-addressable input');
});

test('rejects portable Unicode path aliases, trailing-dot/space components, control characters, and overlong paths', async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-direct-tools-portable-path-test-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  for (const [label, paths, expected] of [
    ['case-fold', ['Straße.txt', 'STRASSE.txt'], /collide after portable normalization/],
    ['canonical-composition', ['café.txt', 'cafe\u0301.txt'], /collide after portable normalization/],
    ['trailing-dot', ['bad./entry.txt'], /non-portable ZIP path component/],
    ['trailing-space', ['bad /entry.txt'], /non-portable ZIP path component/],
    ['control-character', ['bad\u0001name.txt'], /control character/]
  ]) {
    const caseRoot = path.join(tempRoot, label);
    fs.mkdirSync(caseRoot, { recursive: true });
    const bundle = createArchivePathBundle(caseRoot, paths);
    if (label === 'control-character') {
      // `zip` sanitizes control characters in source filesystem names. Patch
      // an equal-length ZIP filename in both headers to exercise the actual
      // archive parser rather than accidentally testing the sanitized name.
      renameZipEntryBytes(bundle, 'server/index.js', 'server/inde\u0001.js');
    }
    const result = run(process.execPath, [cli, bundle, 'list']);
    assert.equal(result.status, 1, `${label} archive should be rejected`);
    assert.match(result.stderr, expected, `${label} archive should report the relevant path policy`);
  }

  const longRoot = path.join(tempRoot, 'overlong');
  fs.mkdirSync(longRoot, { recursive: true });
  const longBundle = createArchivePathBundle(longRoot, []);
  const replacement = `${'segment/'.repeat(600)}entry.js`;
  const rewrittenBundle = path.join(longRoot, 'rewritten.mcpb');
  const rewrite = spawnSync('python3', ['-c', [
    'import sys, zipfile',
    'source, target, replacement = sys.argv[1:]',
    'with zipfile.ZipFile(source) as original, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as rewritten:',
    '    for info in original.infolist():',
    '        data = original.read(info.filename)',
    '        rewritten.writestr(replacement if info.filename == "server/index.js" else info, data)'
  ].join('\n'), longBundle, rewrittenBundle, replacement], { encoding: 'utf8' });
  assert.equal(rewrite.status, 0, rewrite.stderr);
  fs.renameSync(rewrittenBundle, longBundle);
  const longResult = run(process.execPath, [cli, longBundle, 'list']);
  assert.equal(longResult.status, 1);
  assert.match(longResult.stderr, /ZIP path exceeds 4096 bytes/);
});
