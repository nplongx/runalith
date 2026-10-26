#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';

const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ARGUMENT_BYTES = 1024 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_CALLS_PER_SESSION = 200;
const DANGEROUS_TOOL_PATTERN = /(?:dispatch|execute|execution_start|approve|approval|credential|secret|shell|command_run|publish|release|install|restart|delete|remove|write_live|mutate_live)/i;

function usage() {
  console.log(`Run MCP tools directly from a local .mcpb file. Does not install or modify the plugin.\n\nUsage:\n  node scripts/mcpb-tools.mjs <bundle.mcpb> list [--json] [--timeout-ms N] [--allow-tool NAME]\n  node scripts/mcpb-tools.mjs <bundle.mcpb> call <tool-name> [json-arguments | @file.json] [--timeout-ms N] [--allow-tool NAME] [--allow-side-effects]\n  node scripts/mcpb-tools.mjs <bundle.mcpb> shell [--timeout-ms N] [--allow-tool NAME] [--allow-side-effects]\n\nExamples:\n  node scripts/mcpb-tools.mjs candidate.mcpb list\n  node scripts/mcpb-tools.mjs candidate.mcpb list --json\n  node scripts/mcpb-tools.mjs candidate.mcpb call orchestrator_health\n  node scripts/mcpb-tools.mjs candidate.mcpb call workflow_catalog '{"query":"engineering"}'\n  node scripts/mcpb-tools.mjs candidate.mcpb call adaptive_goal_graph_search @graph-request.json\n  node scripts/mcpb-tools.mjs candidate.mcpb shell\n\nIn shell mode use :list, :describe <tool>, :quit, or call <tool> [JSON arguments]. Calls share one isolated runtime/database until shell exits.\n\nEach invocation launches the packaged server in a private temporary directory with isolated database, workspace, HOME and temp paths. Default policy blocks tools with side-effect-like names; use repeated --allow-tool NAME to permit a specific tool, and --allow-side-effects to disable that name heuristic. These controls are not a sandbox and cannot constrain arbitrary code inside a bundle.`);
}

function parseArgs(argv) {
  const positional = [];
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let json = false;
  let allowSideEffects = false;
  const allowTools = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--timeout-ms') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 500 || value > 120_000) {
        throw new Error('--timeout-ms must be an integer from 500 to 120000');
      }
      timeoutMs = value;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--allow-side-effects') {
      allowSideEffects = true;
    } else if (arg === '--allow-tool') {
      const name = argv[++i];
      if (!name || name.startsWith('-')) throw new Error('--allow-tool requires a tool name');
      allowTools.add(name);
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length < 2) throw new Error('bundle path and command (list|call) are required');
  const [bundle, command, toolName, rawArguments, ...extra] = positional;
  if (!['list', 'call', 'shell'].includes(command)) throw new Error(`unsupported command: ${command}`);
  if (extra.length) throw new Error('too many positional arguments');
  if (command === 'list' && (toolName !== undefined || rawArguments !== undefined)) {
    throw new Error('list accepts no positional arguments; use --json for structured output');
  }
  if (command === 'shell' && (toolName !== undefined || rawArguments !== undefined)) {
    throw new Error('shell accepts no positional arguments');
  }
  if (command === 'call' && !toolName) throw new Error('call requires a tool name');
  if (json && command !== 'list') throw new Error('--json is only valid with list');
  return { bundle, command, toolName, rawArguments, timeoutMs, json, allowSideEffects, allowTools };
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? result.signal}: ${(result.stderr || result.stdout || '').slice(0, 2000)}`);
  }
  return result.stdout;
}

function captureRegularFile(filePath) {
  const absolutePath = path.resolve(filePath);
  const beforePath = fs.lstatSync(absolutePath, { bigint: true });
  assert.ok(beforePath.isFile() && !beforePath.isSymbolicLink(), 'bundle must be a regular file, not a symlink');
  assert.equal(fs.realpathSync(absolutePath), absolutePath, 'bundle path must be canonical');
  assert.ok(beforePath.size > 0n && beforePath.size <= BigInt(MAX_BUNDLE_BYTES),
    `bundle size must be 1..${MAX_BUNDLE_BYTES} bytes`);
  const fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    assert.ok(before.isFile() && before.dev === beforePath.dev && before.ino === beforePath.ino && before.size === beforePath.size,
      'bundle identity changed before reading');
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_BUNDLE_BYTES + 1 - total));
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      assert.ok(total <= MAX_BUNDLE_BYTES, 'bundle exceeds size limit');
      chunks.push(buffer.subarray(0, count));
    }
    const bytes = Buffer.concat(chunks, total);
    const after = fs.fstatSync(fd, { bigint: true });
    const afterPath = fs.lstatSync(absolutePath, { bigint: true });
    assert.ok(after.dev === before.dev && after.ino === before.ino && after.size === before.size &&
      after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs && bytes.length === Number(after.size) &&
      afterPath.isFile() && !afterPath.isSymbolicLink() && afterPath.dev === before.dev && afterPath.ino === before.ino &&
      afterPath.size === before.size && afterPath.mtimeNs === before.mtimeNs && afterPath.ctimeNs === before.ctimeNs,
    'bundle changed while being read');
    return { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), absolutePath };
  } finally {
    fs.closeSync(fd);
  }
}

function portablePathKey(value) {
  // ZIP names must not become aliases when extracted on common case-insensitive
  // filesystems. Upper/lower conversion expands several multi-character Unicode
  // folds (including ß → ss); normalize compatibility forms and unify final
  // Greek sigma as a conservative portable collision key.
  return value.normalize('NFKC').toUpperCase().toLowerCase().replace(/ς/g, 'σ').normalize('NFKC');
}

function inspectRawZipEntryNames(bundlePath) {
  const fd = fs.openSync(bundlePath, 'r');
  try {
  const fileSize = fs.fstatSync(fd).size;
  const minEocdSize = 22;
  const maxCommentLength = 0xffff;
  const tailLength = Math.min(fileSize, minEocdSize + maxCommentLength);
  const tail = Buffer.alloc(tailLength);
  fs.readSync(fd, tail, 0, tailLength, fileSize - tailLength);
  const searchStart = Math.max(0, tail.length - minEocdSize - maxCommentLength);
  let eocd = -1;
  for (let offset = tail.length - minEocdSize; offset >= searchStart; offset--) {
    if (tail.readUInt32LE(offset) === 0x06054b50 &&
        offset + minEocdSize + tail.readUInt16LE(offset + 20) === tail.length) {
      eocd = offset;
      break;
    }
  }
  assert.ok(eocd >= 0, 'ZIP end-of-central-directory record is missing or malformed');
  const eocdAbsolute = fileSize - tailLength + eocd;
  assert.equal(tail.readUInt16LE(eocd + 4), 0, 'multi-disk ZIP archives are not supported');
  assert.equal(tail.readUInt16LE(eocd + 6), 0, 'multi-disk ZIP archives are not supported');
  const entriesOnDisk = tail.readUInt16LE(eocd + 8);
  const entryCount = tail.readUInt16LE(eocd + 10);
  const directorySize = tail.readUInt32LE(eocd + 12);
  const directoryOffset = tail.readUInt32LE(eocd + 16);
  assert.ok(entryCount > 0 && entryCount <= MAX_ARCHIVE_ENTRIES, `invalid ZIP entry count: ${entryCount}`);
  assert.equal(entriesOnDisk, entryCount, 'multi-disk ZIP archives are not supported');
  assert.ok(entryCount !== 0xffff && directorySize !== 0xffffffff && directoryOffset !== 0xffffffff,
    'ZIP64 archives are not supported');
  assert.ok(directoryOffset + directorySize <= eocdAbsolute, 'ZIP central directory range is invalid');

  let cursor = directoryOffset;
  const readAt = (length, position) => {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, position);
    assert.equal(bytesRead, length, 'ZIP central directory is truncated');
    return buffer;
  };
  for (let index = 0; index < entryCount; index++) {
    assert.ok(cursor + 46 <= directoryOffset + directorySize && readAt(4, cursor).readUInt32LE(0) === 0x02014b50,
      `ZIP central directory entry ${index} is malformed`);
    const header = readAt(46, cursor);
    const flags = header.readUInt16LE(8);
    const nameLength = header.readUInt16LE(28);
    const extraLength = header.readUInt16LE(30);
    const commentLength = header.readUInt16LE(32);
    const nameStart = cursor + 46;
    const next = nameStart + nameLength + extraLength + commentLength;
    assert.ok(nameLength > 0 && next <= directoryOffset + directorySize, `ZIP central directory entry ${index} has invalid lengths`);
    assert.ok(nameLength <= 4096, `ZIP path exceeds 4096 bytes: entry ${index}`);
    const nameBytes = readAt(nameLength, nameStart);
    assert.ok(!nameBytes.some(byte => byte <= 0x1f || byte === 0x7f), 'ZIP path contains a control character');
    if (flags & 0x0800) {
      let decoded;
      try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes); }
      catch { assert.fail(`ZIP path is not valid UTF-8: entry ${index}`); }
      assert.ok(!/[\u0000-\u001f\u007f-\u009f]/u.test(decoded), 'ZIP path contains a Unicode control character');
    }
    cursor = next;
  }
  assert.equal(cursor, directoryOffset + directorySize, 'ZIP central directory size does not match its entries');
  } finally {
    fs.closeSync(fd);
  }
}

function inspectArchive(bundlePath) {
  // Check raw filename bytes before `unzip -Z1`: Info-ZIP escapes control
  // characters for display (for example, U+0001 becomes `^A`), which would
  // otherwise hide the original unsafe archive name from string validation.
  inspectRawZipEntryNames(bundlePath);
  const names = runSync('unzip', ['-Z1', bundlePath]).split(/\r?\n/).filter(Boolean);
  assert.ok(names.length > 0 && names.length <= MAX_ARCHIVE_ENTRIES, `invalid ZIP entry count: ${names.length}`);
  assert.equal(new Set(names).size, names.length, 'bundle contains duplicate ZIP entries');
  const portableNames = new Set();
  const portableEntries = new Map();
  for (const entry of names) {
    assert.ok(Buffer.byteLength(entry, 'utf8') <= 4096, `ZIP path exceeds 4096 bytes: ${entry.slice(0, 120)}`);
    assert.ok(!/[\u0000-\u001f\u007f]/.test(entry), 'ZIP path contains a control character');
    assert.ok(!entry.startsWith('/') && !entry.startsWith('\\') && !/^[A-Za-z]:/.test(entry), `absolute ZIP path rejected: ${entry}`);
    assert.ok(!entry.includes('\\'), `unsafe ZIP path rejected: ${entry}`);
    const portablePath = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    const components = portablePath.split('/');
    assert.ok(components.every(component => component && component !== '.' && component !== '..'), `unsafe ZIP path rejected: ${entry}`);
    assert.ok(components.every(component => !/[. ]$/.test(component)), `non-portable ZIP path component rejected: ${entry}`);
    const portableKey = portablePath.split('/').map(portablePathKey).join('/');
    const existing = portableEntries.get(portableKey);
    if (existing && existing.directory !== entry.endsWith('/')) {
      assert.fail(`ZIP file/directory path conflict: ${entry} conflicts with ${existing.entry}`);
    }
    assert.ok(!portableNames.has(portableKey), `ZIP paths collide after portable normalization: ${entry}`);
    portableNames.add(portableKey);
    portableEntries.set(portableKey, { entry, directory: entry.endsWith('/') });
  }
  // A regular file cannot also be an ancestor directory. Reject this before
  // extraction instead of relying on unzip's platform-specific conflict rules.
  for (const [key, record] of portableEntries) {
    const components = key.split('/');
    for (let index = 1; index < components.length; index++) {
      const ancestor = portableEntries.get(components.slice(0, index).join('/'));
      assert.ok(!ancestor || ancestor.directory, `ZIP file/directory path conflict: ${record.entry} descends from non-directory ${ancestor?.entry}`);
    }
    if (!record.directory) {
      const prefix = `${key}/`;
      assert.ok(![...portableEntries.keys()].some(candidate => candidate.startsWith(prefix)),
        `ZIP file/directory path conflict: non-directory ${record.entry} is an ancestor of another entry`);
    }
  }
  const listing = runSync('zipinfo', ['-l', bundlePath]);
  for (const line of listing.split(/\r?\n/)) {
    const mode = line.match(/^([bcdlps-][rwxstST-]{9})\s/);
    if (mode) assert.ok(mode[1][0] === '-' || mode[1][0] === 'd', `non-regular ZIP entry rejected: ${line.slice(0, 160)}`);
  }
  const listingLines = runSync('unzip', ['-l', bundlePath]).trim().split(/\r?\n/);
  const summary = listingLines.at(-1).match(/^\s*(\d+)\s+(\d+)\s+files?\s*$/);
  assert.ok(summary, 'could not verify uncompressed ZIP size');
  assert.equal(Number(summary[2]), names.length, 'ZIP listing count mismatch');
  assert.ok(Number(summary[1]) <= MAX_UNPACKED_BYTES, `uncompressed archive exceeds ${MAX_UNPACKED_BYTES} bytes`);
  return names;
}

function parseToolArguments(raw) {
  if (raw === undefined) return {};
  const input = raw.startsWith('@') ? fs.readFileSync(path.resolve(raw.slice(1)), 'utf8') : raw;
  if (Buffer.byteLength(input, 'utf8') > MAX_ARGUMENT_BYTES) throw new Error(`tool arguments exceed ${MAX_ARGUMENT_BYTES} bytes`);
  const value = JSON.parse(input);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('tool arguments must be a JSON object');
  return value;
}


function validateSchemaValue(value, schema, pathLabel = '$', depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`tool schema invalid at ${pathLabel}: expected schema object`);
  if (depth > 64) throw new Error(`tool schema/value nesting exceeds 64 at ${pathLabel}`);
  if (schema.type) {
    const valid = schema.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : schema.type === 'array' ? Array.isArray(value)
      : schema.type === 'integer' ? Number.isInteger(value)
      : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : schema.type === 'null' ? value === null
      : schema.type === 'string' ? typeof value === 'string'
      : schema.type === 'boolean' ? typeof value === 'boolean'
      : false;
    if (!valid) throw new Error(`arguments schema mismatch at ${pathLabel}: expected ${schema.type}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) throw new Error(`arguments schema mismatch at ${pathLabel}: value not in enum`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`arguments schema mismatch at ${pathLabel}: shorter than minLength`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new Error(`arguments schema mismatch at ${pathLabel}: longer than maxLength`);
    if (schema.pattern !== undefined && !(new RegExp(schema.pattern).test(value))) throw new Error(`arguments schema mismatch at ${pathLabel}: pattern mismatch`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`arguments schema mismatch at ${pathLabel}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`arguments schema mismatch at ${pathLabel}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`arguments schema mismatch at ${pathLabel}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`arguments schema mismatch at ${pathLabel}: too many items`);
    if (schema.items) value.forEach((item, index) => validateSchemaValue(item, schema.items, `${pathLabel}[${index}]`, depth + 1));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties || {};
    for (const required of schema.required || []) if (!Object.hasOwn(value, required)) throw new Error(`arguments schema mismatch at ${pathLabel}: missing required property ${required}`);
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) validateSchemaValue(child, properties[key], `${pathLabel}.${key}`, depth + 1);
      else if (schema.additionalProperties === false) throw new Error(`arguments schema mismatch at ${pathLabel}: unknown property ${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateSchemaValue(child, schema.additionalProperties, `${pathLabel}.${key}`, depth + 1);
    }
  }
  for (const childSchema of schema.allOf || []) validateSchemaValue(value, childSchema, pathLabel, depth + 1);
  if (schema.anyOf && !schema.anyOf.some(child => { try { validateSchemaValue(value, child, pathLabel, depth + 1); return true; } catch { return false; } })) throw new Error(`arguments schema mismatch at ${pathLabel}: no anyOf schema matched`);
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(child => { try { validateSchemaValue(value, child, pathLabel, depth + 1); return true; } catch { return false; } }).length;
    if (matches !== 1) throw new Error(`arguments schema mismatch at ${pathLabel}: expected exactly one oneOf schema, matched ${matches}`);
  }
}

function validateToolArguments(tool, args) {
  if (!tool.inputSchema) throw new Error(`tool ${tool.name} has no inputSchema; refusing call without explicit schema`);
  validateSchemaValue(args, tool.inputSchema);
}

function enforceToolPolicy(tool, args, config) {
  if (config.allowTools.has(tool.name)) return;
  if (!config.allowSideEffects && DANGEROUS_TOOL_PATTERN.test(`${tool.name} ${tool.description || ''}`)) {
    throw new Error(`tool blocked by default side-effect policy: ${tool.name}; inspect its schema, then pass --allow-tool ${tool.name} if intentional`);
  }
  if (config.allowTools.size > 0 && !config.allowTools.has(tool.name)) {
    throw new Error(`tool not in explicit allowlist: ${tool.name}; add --allow-tool ${tool.name}`);
  }
  if (args && Object.keys(args).some(key => /(?:dispatch|execute|approval|approve|credential|secret|live_write)/i.test(key)) && !config.allowSideEffects) {
    throw new Error(`arguments contain side-effect-sensitive fields; pass --allow-side-effects only after inspection`);
  }
}

async function runShell(tools, rpc, config) {
  const byName = new Map(tools.map(item => [item.name, item]));
  let callCount = 0;
  console.log(`MCPB shell connected: ${tools.length} tools. State is isolated to this shell session.`);
  console.log('Commands: :list [--json], :describe <tool>, :quit; call <tool> [JSON arguments | @file.json]');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  let inputClosed = false;
  rl.on('close', () => { inputClosed = true; });
  const promptIfOpen = () => { if (!inputClosed) rl.prompt(); };
  rl.setPrompt('mcpb> ');
  promptIfOpen();
  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) { promptIfOpen(); continue; }
      if (line === ':quit' || line === ':q' || line === 'exit' || line === 'quit') break;
      try {
        if (line === ':help') {
          console.log('Use :list [--json], :describe <tool>, call <tool> [JSON arguments | @file.json], or :quit.');
        } else if (line === ':list') {
          showToolList(tools, false);
        } else if (line === ':list --json') {
          showToolList(tools, true);
        } else if (line.startsWith(':describe ')) {
          const name = line.slice(':describe '.length).trim();
          const item = byName.get(name);
          if (!item) throw new Error(`unknown tool: ${name}`);
          console.log(JSON.stringify(item, null, 2));
        } else if (line.startsWith('call ')) {
          const remainder = line.slice(5).trim();
          const split = remainder.indexOf(' ');
          const name = split < 0 ? remainder : remainder.slice(0, split);
          const rawArgs = split < 0 ? undefined : remainder.slice(split + 1).trim();
          if (!byName.has(name)) throw new Error(`tool not exposed by this bundle runtime: ${name}`);
          if (++callCount > MAX_TOOL_CALLS_PER_SESSION) throw new Error(`session call limit exceeded (${MAX_TOOL_CALLS_PER_SESSION})`);
          const toolArgs = parseToolArguments(rawArgs);
          enforceToolPolicy(byName.get(name), toolArgs, config);
          validateToolArguments(byName.get(name), toolArgs);
          const result = await rpc('tools/call', { name, arguments: toolArgs });
          if (result.error) console.log(JSON.stringify({ rpcError: result.error }, null, 2));
          else console.log(JSON.stringify(result.result, null, 2));
          if (result.result?.isError === true) console.error('Tool returned isError=true; shell remains open.');
        } else {
          throw new Error('unknown command; use :help');
        }
      } catch (error) {
        console.error(`ERROR: ${error?.message || error}`);
      }
      promptIfOpen();
    }
  } finally {
    rl.close();
  }
}

function showToolList(tools, asJson) {
  if (asJson) {
    console.log(JSON.stringify(tools, null, 2));
    return;
  }
  for (const item of tools) {
    const required = item.inputSchema?.required ?? [];
    const properties = Object.keys(item.inputSchema?.properties ?? {});
    console.log(`${item.name}\n  required: ${required.length ? required.join(', ') : '(none)'}\n  arguments: ${properties.length ? properties.join(', ') : '(none)'}\n  ${String(item.description ?? '').split(/\r?\n/)[0]}`);
  }
  console.log(`\n${tools.length} tools`);
}

async function run(args) {
  const bundlePath = path.resolve(process.cwd(), args.bundle);
  assert.ok(bundlePath.toLowerCase().endsWith('.mcpb'), 'bundle filename must end in .mcpb');
  const captured = captureRegularFile(bundlePath);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-direct-tools-'));
  fs.chmodSync(tempRoot, 0o700);
  const extracted = path.join(tempRoot, 'bundle');
  const home = path.join(tempRoot, 'home');
  const dataDir = path.join(tempRoot, 'data');
  const workspace = path.join(tempRoot, 'workspace');
  const executionTmp = path.join(tempRoot, 'execution-tmp');
  for (const dir of [extracted, home, dataDir, workspace, executionTmp]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const snapshot = path.join(tempRoot, 'input.mcpb');
  let child = null;
  let childExited = false;
  let stderr = '';
  let receiveBuffer = '';
  let nextId = 1;
  const pending = new Map();
  let exitResolve;
  const exitPromise = new Promise(resolve => { exitResolve = resolve; });

  function rejectPending(error) {
    for (const [id, item] of pending) {
      pending.delete(id);
      clearTimeout(item.timer);
      item.reject(error);
    }
  }
  function handleStdout(chunk) {
    receiveBuffer += chunk;
    if (receiveBuffer.length > 8 * 1024 * 1024) {
      const error = new Error('server stdout exceeded 8 MiB without a complete JSON-RPC line');
      rejectPending(error);
      signalChild('SIGKILL');
      return;
    }
    let end;
    while ((end = receiveBuffer.indexOf('\n')) >= 0) {
      const line = receiveBuffer.slice(0, end).trim();
      if (Buffer.byteLength(line, 'utf8') > MAX_TOOL_OUTPUT_BYTES) { rejectPending(new Error(`server response exceeds ${MAX_TOOL_OUTPUT_BYTES} bytes`)); signalChild('SIGKILL'); return; }
      receiveBuffer = receiveBuffer.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch {
        const error = new Error(`server wrote non-JSON to stdout: ${line.slice(0, 300)}; stderr=${stderr.slice(-1200)}`);
        rejectPending(error);
        signalChild('SIGKILL');
        return;
      }
      if (!Object.hasOwn(message, 'id')) continue;
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  }
  function rpc(method, params = {}) {
    if (!child || childExited) return Promise.reject(new Error(`MCP server is not running (${method})`));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const error = new Error(`MCP request timed out after ${args.timeoutMs} ms: ${method}; stderr=${stderr.slice(-1800)}`);
        reject(error);
        signalChild('SIGKILL');
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
  function signalChild(signal) {
    if (!child || !child.pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, signal);
      else if (!childExited) child.kill(signal);
    } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  }
  function processGroupAlive() {
    if (!child?.pid) return false;
    if (process.platform === 'win32') return !childExited;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return error?.code !== 'ESRCH';
    }
  }
  async function waitForShutdown(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (childExited && (process.platform === 'win32' || !processGroupAlive())) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return childExited && (process.platform === 'win32' || !processGroupAlive());
      await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
    }
  }
  async function stopChild() {
    if (!child) return;
    if (!childExited) {
      child.stdin.end();
      await waitForShutdown(400);
    }
    if (!childExited || processGroupAlive()) {
      signalChild('SIGTERM');
      await waitForShutdown(400);
    }
    if (!childExited || processGroupAlive()) {
      signalChild('SIGKILL');
      await waitForShutdown(1500);
    }
    if (!childExited || processGroupAlive()) {
      throw new Error('MCP server process group did not exit after shutdown signals');
    }
  }

  try {
    const fd = fs.openSync(snapshot, 'wx', 0o400);
    try { fs.writeFileSync(fd, captured.bytes); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(snapshot)).digest('hex'), captured.sha256,
      'private bundle snapshot hash mismatch');
    const entries = inspectArchive(snapshot);
    for (const required of ['manifest.json', 'package.json', 'server/index.js']) {
      assert.ok(entries.includes(required), `bundle missing ${required}`);
    }
    runSync('unzip', ['-q', snapshot, '-d', extracted]);
    const manifest = JSON.parse(fs.readFileSync(path.join(extracted, 'manifest.json'), 'utf8'));
    const packageMetadata = JSON.parse(fs.readFileSync(path.join(extracted, 'package.json'), 'utf8'));
    assert.equal(manifest.server?.type, 'node', 'only Node-based MCPB bundles are supported');
    const manifestEntryPoint = manifest.server?.entry_point;
    assert.ok(typeof manifestEntryPoint === 'string' && manifestEntryPoint.length > 0 &&
      !path.isAbsolute(manifestEntryPoint) && !manifestEntryPoint.includes('\\') &&
      manifestEntryPoint.split('/').every(part => part && part !== '.' && part !== '..') &&
      /^[A-Za-z0-9._/-]+$/.test(manifestEntryPoint), 'expected server entry point');
    assert.equal(manifest.server?.mcp_config?.command, 'node', 'manifest must use node as launch command');
    assert.deepEqual(manifest.server?.mcp_config?.args, [`${'${__dirname}/'}${manifestEntryPoint}`], 'unsupported manifest launch arguments');
    assert.equal(packageMetadata.main, manifestEntryPoint, 'package main differs from manifest entry point');
    assert.equal(packageMetadata.type, 'module', 'package must use ES modules');
    assert.equal(packageMetadata.version, manifest.version, 'package/manifest version mismatch');
    assert.ok(Array.isArray(manifest.tools) && manifest.tools.length > 0, 'manifest has no tools');
    const entryPoint = path.resolve(extracted, manifestEntryPoint);
    assert.ok(entryPoint.startsWith(`${extracted}${path.sep}`) && fs.statSync(entryPoint).isFile(), 'entry point escapes bundle or is missing');

    const optionalFlags = [
      ['adaptive_goal_phase2_shadow_search', 'AGG_PHASE2_SHADOW_TOOL_ENABLED'],
      ['adaptive_goal_phase3_mcts_shadow_search', 'AGG_PHASE3_MCTS_TOOL_ENABLED'],
      ['adaptive_goal_knowledge_capture_workflow_outcome', 'AGG_PHASE4_KNOWLEDGE_CAPTURE_TOOL_ENABLED']
    ];
    const names = new Set(manifest.tools.map(item => item.name));
    const exposeOptionalTools = optionalFlags.every(([toolName]) => names.has(toolName));
    const optionalEnv = exposeOptionalTools ? Object.fromEntries(optionalFlags.map(([, key]) => [key, '1'])) : {};

    child = spawn(process.execPath, [entryPoint], {
      cwd: extracted,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: home, TMPDIR: executionTmp, TEMP: executionTmp, TMP: executionTmp,
        LANG: 'C.UTF-8', NODE_ENV: 'production',
        RUNALITH_DATA_DIR: dataDir,
        RUNALITH_WORKFLOW_DB: path.join(dataDir, 'workflow.db'),
        RUNALITH_WORKSPACE: workspace,
        RUNALITH_EXECUTION_TMP_DIR: executionTmp,
        ...optionalEnv
      }
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', handleStdout);
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.length > 2 * 1024 * 1024) stderr = stderr.slice(-2 * 1024 * 1024);
    });
    child.on('error', rejectPending);
    child.on('exit', (code, signal) => {
      childExited = true;
      exitResolve({ code, signal });
      rejectPending(new Error(`MCP server exited before response (code=${code}, signal=${signal}); stderr=${stderr.slice(-2000)}`));
    });

    const initialized = await rpc('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcpb-direct-tools', version: '1' }
    });
    if (initialized.error) throw new Error(`initialize error: ${JSON.stringify(initialized.error)}`);
    assert.equal(initialized.result?.serverInfo?.version, manifest.version, 'server version differs from bundle manifest');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    const listed = await rpc('tools/list', {});
    if (listed.error) throw new Error(`tools/list error: ${JSON.stringify(listed.error)}`);
    const tools = listed.result?.tools;
    assert.ok(Array.isArray(tools), 'server tools/list did not return tools');
    if (args.command === 'list') {
      showToolList(tools, args.json);
      return;
    }
    if (args.command === 'shell') {
      await runShell(tools, rpc, args);
      return;
    }

    const target = tools.find(item => item.name === args.toolName);
    if (!target) {
      throw new Error(`tool not exposed by this bundle runtime: ${args.toolName}. Run 'list' to inspect available tools.`);
    }
    const toolArgs = parseToolArguments(args.rawArguments);
    enforceToolPolicy(target, toolArgs, args);
    validateToolArguments(target, toolArgs);
    const response = await rpc('tools/call', { name: args.toolName, arguments: toolArgs });
    if (response.error) throw new Error(`tools/call RPC error: ${JSON.stringify(response.error)}`);
    console.log(JSON.stringify(response.result, null, 2));
    if (response.result?.isError === true) process.exitCode = 2;
  } finally {
    try {
      await stopChild();
    } catch (error) {
      console.error(`MCPB_DIRECT_TOOL_CLEANUP_WARNING: ${error?.message || error}`);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) usage();
  else await run(parsed);
} catch (error) {
  if (parsed?.help) process.exitCode = 0;
  else {
    console.error(`MCPB_DIRECT_TOOL_ERROR: ${error?.stack || error}`);
    usage();
    process.exitCode = 1;
  }
}
