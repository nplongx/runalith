#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadInstructionBundle } from './agent-instructions-preflight.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 18746;
const MAX_BODY_BYTES = 512 * 1024;
const CODEGRAPH_SYNC_TIMEOUT_MS = 30_000;
const CODEGRAPH_SYNC_MAX_BUFFER = 128 * 1024;
const SUPPORTED_KINDS = new Set([
  'continue',
  'fresh-turn',
  'scheduled',
  'goal-step',
  'loop-step',
  'worker-start',
  'worker-message'
]);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function shortReason(value) {
  return String(value || 'instruction preflight failed')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function validateRequest(value) {
  if (!isPlainObject(value)) return 'request body must be a JSON object';
  if (value.version !== 1) return 'unsupported Check automatic sends protocol version';
  if (typeof value.kind !== 'string' || !SUPPORTED_KINDS.has(value.kind)) return 'unsupported automatic-send kind; review CoS protocol before allowing';
  if (typeof value.id !== 'string' || value.id.length < 1 || value.id.length > 256) return 'invalid automatic-send identity';
  if (!Number.isSafeInteger(value.attempt) || value.attempt < 1) return 'invalid automatic-send attempt';
  if (typeof value.text !== 'string' || Buffer.byteLength(value.text, 'utf8') > 256 * 1024) return 'automatic-send text is missing or exceeds 256 KiB';
  if (!isPlainObject(value.chat)) return 'chat identity is missing or invalid';
  for (const key of ['session', 'project', 'worker']) {
    if (!Object.hasOwn(value.chat, key)) return `chat.${key} is missing`;
    const item = value.chat[key];
    if (item !== null && (typeof item !== 'string' || item.length > 256)) {
      return `invalid chat.${key} identity`;
    }
  }
  return null;
}

function validateCodeGraphInstructions(content) {
  const requiredStatements = [
    /before every (?:repository )?source query or source retrieval[\s\S]*?codegraph sync/i,
    /after changing source files[\s\S]*?codegraph sync[\s\S]*?before the next source query/i,
    /if codegraph is unavailable or sync fails[\s\S]*?(?:stop|block)[\s\S]*?report the blocker/i
  ];
  if (typeof content !== 'string' || !requiredStatements.every(pattern => pattern.test(content))) {
    throw new Error('CodeGraph instruction gate is missing or incomplete; require sync before every source query, resync after source edits, and fail closed when sync is unavailable');
  }
}

function syncCodeGraph(root, options = {}) {
  const runSync = typeof options.codegraphSync === 'function'
    ? options.codegraphSync
    : rootPath => spawnSync('codegraph', ['sync'], {
      cwd: rootPath,
      encoding: 'utf8',
      timeout: CODEGRAPH_SYNC_TIMEOUT_MS,
      maxBuffer: CODEGRAPH_SYNC_MAX_BUFFER,
      windowsHide: true
    });

  let result;
  try {
    result = runSync(root);
  } catch (error) {
    throw new Error(`CodeGraph sync blocked: ${error.message || String(error)}`);
  }

  const output = [result?.stdout, result?.stderr].filter(Boolean).join(' ').trim();
  if (!result || result.status !== 0 || result.error || result.signal) {
    const detail = result?.error?.message || output ||
      `exit=${result?.status ?? 'unknown'}${result?.signal ? ` signal=${result.signal}` : ''}`;
    throw new Error(`CodeGraph sync blocked: ${shortReason(detail)}`);
  }
  return {
    status: 'synced',
    detail: shortReason(output || 'CodeGraph sync completed successfully')
  };
}

function normalizeTarget(entry, fallbackRoot) {
  if (!isPlainObject(entry)) throw new Error('repository target must be an object');
  if (typeof entry.root !== 'string' || entry.root.trim().length === 0) {
    throw new Error('repository target root is missing');
  }
  const root = path.resolve(entry.root);
  const target = typeof entry.target === 'string' && entry.target.trim() ? entry.target : '.';
  const targetPath = path.resolve(root, target);
  if (targetPath !== root && !targetPath.startsWith(`${root}${path.sep}`)) {
    throw new Error('target directory escapes mapped repository root');
  }
  if (fallbackRoot && !path.isAbsolute(entry.root)) {
    throw new Error('mapped repository roots must be absolute paths');
  }
  return { root, target: targetPath };
}

function readPolicy(policyPath, fallbackTarget) {
  if (!policyPath) return { default: fallbackTarget, sessions: {}, projects: {}, workers: {} };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read send-check policy: ${error.message}`);
  }
  if (!isPlainObject(parsed) || parsed.version !== 1) throw new Error('send-check policy must be an object with version=1');
  for (const key of ['sessions', 'projects', 'workers']) {
    if (parsed[key] !== undefined && !isPlainObject(parsed[key])) throw new Error(`policy.${key} must be an object`);
  }
  const normalizeMap = (map = {}) => Object.fromEntries(Object.entries(map).map(([id, item]) => {
    if (!id || id.length > 256) throw new Error('policy identity key is invalid');
    return [id, normalizeTarget(item, true)];
  }));
  return {
    default: parsed.default === undefined ? fallbackTarget : parsed.default === null ? null : normalizeTarget(parsed.default, true),
    sessions: normalizeMap(parsed.sessions),
    projects: normalizeMap(parsed.projects),
    workers: normalizeMap(parsed.workers)
  };
}

function selectTarget(request, policy) {
  const chat = request.chat;
  if (chat.session && policy.sessions[chat.session]) return { ...policy.sessions[chat.session], matchedBy: 'session' };
  if (chat.project && policy.projects[chat.project]) return { ...policy.projects[chat.project], matchedBy: 'project' };
  if (chat.worker && policy.workers[chat.worker]) return { ...policy.workers[chat.worker], matchedBy: 'worker' };
  if (policy.default) return { ...policy.default, matchedBy: 'default' };
  throw new Error('chat has no repository mapping and policy has no default target');
}

export function evaluateAutomaticSend(request, options = {}) {
  const invalid = validateRequest(request);
  if (invalid) return { allow: false, reason: shortReason(invalid), preflight: null };

  try {
    const fallbackTarget = options.root
      ? normalizeTarget({ root: options.root, target: options.target ?? '.' }, false)
      : null;
    const policy = readPolicy(options.policyPath, fallbackTarget);
    const selected = selectTarget(request, policy);
    const bundle = loadInstructionBundle({
      cwd: selected.root,
      target: selected.target,
      maxBytes: options.maxBytes ?? 32 * 1024
    });
    if (bundle.gitRoot !== selected.root) {
      throw new Error(`mapped root is not the Git root (${bundle.gitRoot})`);
    }
    if (bundle.instructions.length === 0 || !bundle.content.trim()) {
      throw new Error('effective agent instruction bundle is empty');
    }
    validateCodeGraphInstructions(bundle.content);
    const codegraph = syncCodeGraph(bundle.gitRoot, options);
    return {
      allow: true,
      reason: '',
      preflight: {
        root: bundle.gitRoot,
        target: bundle.targetDirectory,
        instructionCount: bundle.instructions.length,
        combinedSha256: bundle.combinedSha256,
        codegraph,
        matchedBy: selected.matchedBy
      }
    };
  } catch (error) {
    return {
      allow: false,
      reason: shortReason(`Runalith send preflight blocked: ${error.message}`),
      preflight: null
    };
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new Error('request body exceeds 512 KiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(bytes);
}

export function createAutomaticSendCheckServer(options = {}) {
  const host = options.host ?? DEFAULT_HOST;
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    throw new Error('automatic-send check server must bind to loopback only');
  }
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be between 0 and 65535');

  const server = http.createServer(async (request, response) => {
    let pathname;
    try {
      const urlHost = host === '::1' ? '[::1]' : host;
      pathname = new URL(request.url || '/', `http://${urlHost}`).pathname;
    } catch {
      sendJson(response, 200, { allow: false, reason: 'invalid request URL' });
      return;
    }
    if (request.method === 'GET' && pathname === '/health') {
      sendJson(response, 200, { ok: true, service: 'runalith-cos-automatic-send-check', protocolVersion: 1 });
      return;
    }
    if (request.method !== 'POST' || pathname !== '/check') {
      sendJson(response, 404, { allow: false, reason: 'unknown send-check endpoint' });
      return;
    }
    let result;
    try {
      if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        result = { allow: false, reason: 'content-type must be application/json', preflight: null };
      } else {
        const body = await readJsonBody(request);
        result = evaluateAutomaticSend(body, options);
      }
    } catch (error) {
      result = { allow: false, reason: shortReason(`send-check request rejected: ${error.message}`), preflight: null };
    }

    const kind = result.allow === true ? 'preflight-pass' : 'held';
    options.log?.({ kind, allow: result.allow, reason: result.reason, preflight: result.preflight });
    // CoS only accepts HTTP 200 + JSON. Every denial is an answered hold.
    sendJson(response, 200, result.allow ? { allow: true } : { allow: false, reason: result.reason });
  });
  return server;
}

function parseArgs(argv) {
  const options = {
    root: process.env.RUNALITH_SEND_CHECK_ROOT || REPOSITORY_ROOT,
    target: process.env.RUNALITH_SEND_CHECK_TARGET || '.',
    host: process.env.RUNALITH_SEND_CHECK_HOST || DEFAULT_HOST,
    port: Number(process.env.RUNALITH_SEND_CHECK_PORT || DEFAULT_PORT),
    policyPath: process.env.RUNALITH_SEND_CHECK_POLICY || undefined
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--root' || argument.startsWith('--root=')) options.root = argument === '--root' ? argv[++index] : argument.slice(7);
    else if (argument === '--target' || argument.startsWith('--target=')) options.target = argument === '--target' ? argv[++index] : argument.slice(9);
    else if (argument === '--host' || argument.startsWith('--host=')) options.host = argument === '--host' ? argv[++index] : argument.slice(7);
    else if (argument === '--port' || argument.startsWith('--port=')) options.port = Number(argument === '--port' ? argv[++index] : argument.slice(7));
    else if (argument === '--policy' || argument.startsWith('--policy=')) options.policyPath = argument === '--policy' ? argv[++index] : argument.slice(9);
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (!options.root) throw new Error('--root must be a repository path');
  if (!options.target) throw new Error('--target must be a directory inside the repository');
  return options;
}

function usage() {
  return [
    'Usage: node scripts/cos-automatic-send-check.mjs [options]',
    '',
    'Options:',
    '  --root <path>       Default Git repository root (default: this Runalith checkout)',
    '  --target <path>     Default instruction target, relative to root (default: .)',
    '  --policy <file>     Optional JSON policy mapping chat.session/project/worker IDs to roots',
    '  --host <loopback>   Bind address (127.0.0.1 only by default)',
    '  --port <number>     HTTP port (18746 by default; 0 for ephemeral test port)',
    '  --help              Show this help'
  ].join('\n');
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const server = createAutomaticSendCheckServer({
      ...options,
      log: entry => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
    });
    server.listen(options.port, options.host, () => {
      const address = server.address();
      process.stdout.write(`Runalith automatic-send check listening at http://${options.host}:${address.port}/check\n`);
    });
    const shutdown = () => server.close(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    process.stderr.write(`cos-automatic-send-check: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
