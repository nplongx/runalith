#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { isSafePortableArchivePath, validateZipEntryTypes } from '../benchmarks/plugin-workflow-benchmark/phase2-zip-entry-type-safety.mjs';
import { assertAdaptiveGoalTrustDomainsDisjoint, adaptiveGoalTrustConfigurationStatus,
  loadAdaptiveGoalTrustConfiguration } from '../src/runtime/adaptive-goal-trust-configuration.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_ROOT_DEFAULT = path.join(os.homedir(), '.config', 'chat-on-steroids');
const WORKFLOW_DB_DEFAULT = path.join(os.homedir(), '.chat-on-steroids', 'agent-orchestrator', 'workflow.db');
const PINNED_HISTORICAL_SERVER_SHA256 = 'aa2b8f45f5a98817aac019f1659ff91f0bfc22da68cdbef1d9ad1ae6ceee8cb8';
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2000;
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const MAX_PATH_BYTES = 1024;
const SHA256_HEX = /^[a-f0-9]{64}$/;

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status ?? result.signal}: ${(result.stderr || result.stdout || '').slice(0, 2000)}`);
  return result.stdout;
}
function safeJson(text, label) {
  try { return JSON.parse(text); }
  catch (cause) { throw new Error(`${label} is not valid JSON: ${String(cause?.message || cause)}`); }
}
function readRegularFile(filePath, maxBytes = MAX_BUNDLE_BYTES) {
  const absolute = path.resolve(filePath);
  const before = fs.lstatSync(absolute, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || fs.realpathSync(absolute) !== absolute || before.size < 1n || before.size > BigInt(maxBytes)) {
    throw new Error(`refusing non-regular, non-canonical, empty or oversized file: ${absolute}`);
  }
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) throw new Error('file identity changed before read');
    const chunks = [];
    let count = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - count));
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!n) break;
      count += n;
      if (count > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes`);
      chunks.push(chunk.subarray(0, n));
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(absolute, { bigint: true });
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs ||
        after.ctimeNs !== stat.ctimeNs || current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size ||
        current.mtimeNs !== stat.mtimeNs || current.ctimeNs !== stat.ctimeNs || fs.realpathSync(absolute) !== absolute) {
      throw new Error('file changed while being read');
    }
    return Buffer.concat(chunks, count);
  } finally { fs.closeSync(fd); }
}

export function inspectBundle(bundlePath, { requireCurrentSource = false } = {}) {
  const absolute = path.resolve(bundlePath);
  if (!absolute.toLowerCase().endsWith('.mcpb')) throw new Error('candidate path must end in .mcpb');
  const bytes = readRegularFile(absolute);
  validateZipEntryTypes(bytes);
  const listed = run('unzip', ['-Z1', absolute]).split(/\r?\n/).filter(Boolean);
  if (!listed.length || listed.length > MAX_ARCHIVE_ENTRIES || new Set(listed).size !== listed.length) throw new Error('archive is empty, oversized, or contains duplicate names');
  const normalized = new Map();
  const files = new Set();
  let expandedBytes = 0;
  for (const name of listed) {
    const isDirectory = name.endsWith('/');
    const portableName = isDirectory ? name.slice(0, -1) : name;
    if (!isSafePortableArchivePath(portableName) || Buffer.byteLength(name, 'utf8') > MAX_PATH_BYTES) throw new Error(`unsafe or overlong archive name: ${JSON.stringify(name)}`);
    const canonical = portableName.normalize('NFKC').toLocaleLowerCase('en-US');
    const previous = normalized.get(canonical);
    if (previous && previous !== name) throw new Error(`Unicode/case-normalization ZIP path collision: ${JSON.stringify(previous)} vs ${JSON.stringify(name)}`);
    normalized.set(canonical, name);
    if (!isDirectory) files.add(name);
  }
  for (const name of files) {
    const parts = name.split('/');
    for (let index = 1; index < parts.length; index++) {
      const prefix = parts.slice(0, index).join('/');
      if (files.has(prefix)) throw new Error(`archive file/directory prefix conflict: ${JSON.stringify(prefix)} and ${JSON.stringify(name)}`);
    }
  }
  const details = run('unzip', ['-l', absolute]);
  const totalLine = details.trim().split(/\r?\n/).at(-1) || '';
  const summary = totalLine.match(/^\s*(\d+)\s+(\d+)\s+files?\s*$/);
  if (!summary || Number(summary[1]) > MAX_UNPACKED_BYTES || Number(summary[2]) > MAX_ARCHIVE_ENTRIES) {
    throw new Error('archive expanded size could not be verified or exceeds the size ceiling');
  }
  expandedBytes = Number(summary[1]);
  const modes = run('zipinfo', ['-l', absolute]);
  for (const line of modes.split(/\r?\n/)) {
    const mode = line.match(/^([bcdlps-][rwxstST-]{9})\s/);
    if (mode && !['-', 'd'].includes(mode[1][0])) throw new Error(`archive contains a non-regular ZIP entry: ${line.slice(0, 150)}`);
  }
  const manifestBytes = run('unzip', ['-p', absolute, 'manifest.json'], { encoding: 'buffer' });
  const packageBytes = run('unzip', ['-p', absolute, 'package.json'], { encoding: 'buffer' });
  const manifest = safeJson(Buffer.from(manifestBytes).toString('utf8'), 'bundle manifest');
  const packageJson = safeJson(Buffer.from(packageBytes).toString('utf8'), 'bundle package metadata');
  const entry = manifest.server?.entry_point;
  if (manifest.name !== 'runalith-agent-orchestrator' || manifest.server?.type !== 'node' ||
      typeof manifest.version !== 'string' || packageJson.version !== manifest.version || packageJson.main !== entry ||
      packageJson.type !== 'module' || typeof entry !== 'string' || !files.has(entry) || !/^[A-Za-z0-9._/-]+$/.test(entry) ||
      entry.startsWith('/') || entry.split('/').some(part => !part || part === '.' || part === '..') ||
      manifest.server?.mcp_config?.command !== 'node' ||
      JSON.stringify(manifest.server?.mcp_config?.args) !== JSON.stringify([`${'${__dirname}/'}${entry}`]) ||
      !Array.isArray(manifest.tools) || !manifest.tools.length ||
      manifest.tools.some(tool => !tool || typeof tool.name !== 'string' || !tool.name.trim() ||
        typeof tool.description !== 'string' || !tool.description.trim()) ||
      new Set(manifest.tools.map(t => t.name)).size !== manifest.tools.length ||
      !files.has('server/index.js')) {
    throw new Error('candidate manifest/package metadata, entry point, args or tool declarations do not satisfy the Runalith package contract');
  }
  const archivedRuntime = Buffer.from(run('unzip', ['-p', absolute, entry], { encoding: 'buffer' }));
  const archivedHistorical = Buffer.from(run('unzip', ['-p', absolute, 'server/index.js'], { encoding: 'buffer' }));
  if (!archivedRuntime.length || sha256(archivedHistorical) !== PINNED_HISTORICAL_SERVER_SHA256) {
    throw new Error('candidate is missing its selected runtime or has drifted from the historical server/index.js pin');
  }
  if (requireCurrentSource) {
    const sourcePackage = safeJson(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'), 'repository package.json');
    const sourceManifestBytes = fs.readFileSync(path.join(ROOT, 'plugin/manifest.json'));
    const sourceManifest = safeJson(sourceManifestBytes.toString('utf8'), 'repository plugin manifest');
    if (entry !== sourcePackage.runtimeEntryPoint || manifest.version !== sourcePackage.version ||
        manifest.version !== sourceManifest.version || !sourceManifestBytes.equals(Buffer.from(run('unzip', ['-p', absolute, 'manifest.json'], { encoding: 'buffer' }))) ||
        !archivedRuntime.equals(readRegularFile(path.join(ROOT, entry))) ||
        !archivedHistorical.equals(readRegularFile(path.join(ROOT, 'server/index.js')))) {
      throw new Error('candidate package does not match the versioned source runtime, manifest, and pinned historical runtime in this workspace');
    }
  }
  return { path: absolute, sha256: sha256(bytes), sizeBytes: bytes.byteLength, expandedBytes,
    version: manifest.version, entryPoint: entry, toolCount: manifest.tools.length, archiveEntryCount: listed.length,
    manifest, packageJson, entries: listed };
}

export function smokeCandidate(bundlePath, timeoutMs = 180_000) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/test-mcpb-candidate.mjs'), bundlePath], {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`isolated extracted-runtime acceptance failed (exit=${result.status ?? result.signal}): ${(result.stderr || result.stdout || '').slice(-4000)}`);
  return { passed: true, output: (result.stdout || '').trim().slice(-2500) };
}

export function listRuntimeProcesses(pluginId, procRoot = '/proc') {
  let entries;
  try { entries = fs.readdirSync(procRoot); }
  catch { return []; }
  const escapedId = pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // RC.6+ packages use a versioned entry point (for example
  // server/index-v1.0.9-rc.8.js). Match both that canonical form and the
  // historical server/index.js form; requiring only index.js made the live
  // RC.8 process invisible to read-only rollout verification even though the
  // host registry and process command line agreed on the generation.
  const pattern = new RegExp(`[/\\\\]plugins[/\\\\]${escapedId}[/\\\\]g-[^/\\\\]+[/\\\\]server[/\\\\]index(?:-v[0-9A-Za-z.-]+)?\\.js$`);
  const found = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      const args = fs.readFileSync(path.join(procRoot, name, 'cmdline')).toString('utf8').split('\0').filter(Boolean);
      const entry = args.find(value => pattern.test(value));
      if (!entry) continue;
      let ppid = null;
      let parentArgs = [];
      try {
        const status = fs.readFileSync(path.join(procRoot, name, 'status'), 'utf8');
        ppid = Number(status.match(/^PPid:\s*(\d+)$/m)?.[1]);
        if (!Number.isInteger(ppid) || ppid < 1) ppid = null;
        if (ppid !== null) parentArgs = fs.readFileSync(path.join(procRoot, String(ppid), 'cmdline'))
          .toString('utf8').split('\0').filter(Boolean);
      } catch {}
      const parentExe = parentArgs[0] || null;
      const parentBase = parentExe ? path.basename(parentExe).toLowerCase() : '';
      const parentLooksLikeHost = /chat-on-steroids/.test(parentBase) ||
        /chat on steroids/i.test(parentExe || '');
      const generationRoot = path.resolve(path.dirname(entry), '..');
      found.push({ pid, ppid, parentExe, parentArgs, parentLooksLikeHost,
        entryPoint: path.resolve(entry), generationRoot, args });
    } catch {}
  }
  return found.sort((a, b) => a.pid - b.pid);
}

export function workflowDbSummary(dbPath) {
  const absolute = path.resolve(dbPath);
  const result = { path: absolute, readable: false, integrityCheck: null, foreignKeyViolations: null,
    jobs: null, events: null, tasks: null, artifacts: null, results: null,
    stateCounts: [], taskStatusCounts: [], executingJobs: null, runningTasks: null,
    activeLeases: null, blockers: [] };
  const db = new DatabaseSync(absolute, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    for (const table of ['jobs', 'events', 'tasks', 'artifacts', 'results', 'task_leases']) {
      if (!tables.has(table)) throw new Error(`workflow DB is missing expected table ${table}`);
    }
    result.integrityCheck = db.prepare('PRAGMA quick_check').all().map(row => row.quick_check);
    result.foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
    if (result.integrityCheck.length !== 1 || result.integrityCheck[0] !== 'ok') result.blockers.push('WORKFLOW_DB_INTEGRITY_FAILED');
    if (result.foreignKeyViolations !== 0) result.blockers.push('WORKFLOW_DB_FOREIGN_KEY_VIOLATIONS');
    for (const table of ['jobs', 'events', 'tasks', 'artifacts', 'results']) result[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    result.stateCounts = db.prepare('SELECT state,status,COUNT(*) AS n FROM jobs GROUP BY state,status ORDER BY state,status').all();
    result.taskStatusCounts = db.prepare('SELECT status,COUNT(*) AS n FROM tasks GROUP BY status ORDER BY status').all();
    result.executingJobs = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE UPPER(state)='EXECUTING' AND lower(status)='active'").get().n;
    result.runningTasks = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE lower(status)='running'").get().n;
    const leaseStates = db.prepare('SELECT state,expires_at FROM task_leases').all();
    const nowMs = Date.now();
    result.activeLeases = leaseStates.filter(row => {
      if (['released', 'expired', 'cancelled'].includes(String(row.state).toLowerCase())) return false;
      if (typeof row.expires_at !== 'string' || !row.expires_at.trim()) return true;
      const expiryMs = Date.parse(row.expires_at);
      // Malformed/ambiguous lease expiry is a live blocker, never evidence that
      // a lease is safe to ignore during an upgrade.
      return !Number.isFinite(expiryMs) || expiryMs > nowMs;
    }).length;
    result.readable = true;
    return result;
  } catch (error) {
    result.blockers.push('WORKFLOW_DB_READ_FAILED');
    result.error = String(error?.message || error);
    return result;
  } finally { db.close(); }
}

const AGG_TRUST_ENVIRONMENT_KEYS = new Set([
  'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON', 'AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID',
  'AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM', 'AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON',
  'AGG_REVIEW_IDENTITY_PROVIDER_ID', 'AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM'
]);

function readRuntimeTrustEnvironment(pid, procRoot) {
  const raw = fs.readFileSync(path.join(procRoot, String(pid), 'environ'));
  const environment = {};
  for (const item of raw.toString('utf8').split('\0')) {
    const separator = item.indexOf('=');
    if (separator < 1) continue;
    const key = item.slice(0, separator);
    if (AGG_TRUST_ENVIRONMENT_KEYS.has(key)) environment[key] = item.slice(separator + 1);
  }
  return environment;
}

function externalAntiRollbackAnchorNotConfigured() {
  return { verified: false, status: 'NOT_CONFIGURED',
    contract: 'host-monotonic-trust-ledger-checkpoint/v1',
    requiredFields: ['authorityId', 'source', 'checkpointSequence', 'checkpointDigest', 'previousCheckpointDigest',
      'ledgerStateSha256', 'trustDomainStateSha256', 'candidateSha256', 'rollbackSha256', 'signatureVerified',
      'independentOfLocalLedger', 'observedAt'],
    blockers: [{ code: 'PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED',
      message: 'no independently protected host monotonic checkpoint verifier is configured; local SQLite history cannot detect whole-ledger restore' }] };
}

export function inspectRuntimeTrustConfiguration(pid, { procRoot = '/proc', now = Date.now() } = {}) {
  try {
    const environment = readRuntimeTrustEnvironment(pid, procRoot);
    const sourceVerifier = loadAdaptiveGoalTrustConfiguration({
      configJsonEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON',
      providerEnv: 'AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID',
      publicKeyEnv: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM',
      domain: 'goal_idea_verifier', scope: 'agg.goal_idea_graph.verify', now, environment
    });
    const reviewer = loadAdaptiveGoalTrustConfiguration({
      configJsonEnv: 'AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON', providerEnv: 'AGG_REVIEW_IDENTITY_PROVIDER_ID',
      publicKeyEnv: 'AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM',
      domain: 'action_intent_reviewer', scope: 'agg.action_intent.review', now, environment
    });
    if (sourceVerifier.configurationSource !== 'admin_json_environment' || sourceVerifier.configVersion < 1 ||
        reviewer.configurationSource !== 'admin_json_environment' || reviewer.configVersion < 1) {
      throw Object.assign(new Error('production rollout requires schema-valid, versioned JSON trust configuration for both independent domains; legacy single-key configuration is migration-only'),
        { code: 'PRODUCTION_AGG_TRUST_JSON_CONFIGURATION_REQUIRED' });
    }
    assertAdaptiveGoalTrustDomainsDisjoint(sourceVerifier, reviewer);
    if (!sourceVerifier.available || !reviewer.available) {
      throw Object.assign(new Error('one or both trust domains have no currently usable, non-revoked root inside its validity window'),
        { code: 'PRODUCTION_AGG_TRUST_ROOT_NOT_CURRENT' });
    }
    return {
      available: true,
      status: 'CONFIGURED_IN_ACTIVE_RUNTIME_ENVIRONMENT',
      source: 'active_runtime_process_environment',
      domains: {
        goal_idea_verifier: adaptiveGoalTrustConfigurationStatus(sourceVerifier),
        action_intent_reviewer: adaptiveGoalTrustConfigurationStatus(reviewer)
      },
      separation: { providerIdsDistinct: sourceVerifier.providerId !== reviewer.providerId,
        publicRootsDisjoint: !sourceVerifier.roots.some(root => reviewer.roots.some(other => other.trustRootSha256 === root.trustRootSha256)) },
      externalAntiRollbackAnchor: externalAntiRollbackAnchorNotConfigured(),
      blockers: []
    };
  } catch (error) {
    return { available: false, status: 'BLOCKED', source: 'active_runtime_process_environment',
      externalAntiRollbackAnchor: externalAntiRollbackAnchorNotConfigured(),
      blockers: [{ code: error?.code || 'PRODUCTION_AGG_TRUST_CONFIGURATION_UNVERIFIED',
        message: String(error?.message || error) }] };
  }
}

export function inspectHost({ appRoot = APP_ROOT_DEFAULT, workflowDb = null, procRoot = '/proc' } = {}) {
  const registryPath = path.join(path.resolve(appRoot), 'state', 'plugins.json');
  const host = { appRoot: path.resolve(appRoot), registryPath, registryReadable: false, plugin: null,
    processes: [], installedGeneration: null, database: null,
    trustConfiguration: { available: false, status: 'UNVERIFIED', blockers: [{ code: 'PRODUCTION_AGG_TRUST_CONFIGURATION_UNVERIFIED', message: 'active runtime environment was not inspected' }] }, blockers: [] };
  try {
    const registry = safeJson(readRegularFile(registryPath, 16 * 1024 * 1024).toString('utf8'), 'host plugin registry');
    if (!Array.isArray(registry)) throw new Error('host plugin registry root must be an array');
    host.registryReadable = true;
    const matches = registry.filter(item => item?.name === 'Runalith' && item?.source?.kind === 'mcpb');
    if (matches.length !== 1) throw new Error(`expected exactly one enabled/registered Runalith MCPB entry; found ${matches.length}`);
    host.plugin = matches[0];
    if (host.plugin.enabled !== true || host.plugin.status !== 'ready') host.blockers.push('HOST_PLUGIN_NOT_READY');
    host.processes = listRuntimeProcesses(host.plugin.id, procRoot);
    if (host.processes.length !== 1) host.blockers.push(host.processes.length === 0 ? 'HOST_RUNTIME_PROCESS_NOT_FOUND' : 'HOST_RUNTIME_PROCESS_AMBIGUOUS');
    if (host.processes.length === 1) {
      const process = host.processes[0];
      host.trustConfiguration = inspectRuntimeTrustConfiguration(process.pid, { procRoot });
      if (!process.parentLooksLikeHost) host.blockers.push('HOST_PROCESS_OWNER_NOT_VERIFIED');
      const manifestPath = path.join(process.generationRoot, 'manifest.json');
      const packagePath = path.join(process.generationRoot, 'package.json');
      const manifest = safeJson(readRegularFile(manifestPath, 4 * 1024 * 1024).toString('utf8'), 'installed generation manifest');
      const packageJson = safeJson(readRegularFile(packagePath, 4 * 1024 * 1024).toString('utf8'), 'installed generation package metadata');
      const relativeEntry = path.relative(process.generationRoot, process.entryPoint).split(path.sep).join('/');
      if (manifest.version !== host.plugin.version || packageJson.version !== manifest.version || packageJson.main !== manifest.server?.entry_point ||
          relativeEntry !== manifest.server?.entry_point || !fs.statSync(process.entryPoint).isFile()) host.blockers.push('HOST_PROCESS_PACKAGE_IDENTITY_MISMATCH');
      host.installedGeneration = { path: process.generationRoot, pid: process.pid, entryPoint: process.entryPoint,
        parentPid: process.ppid, parentExe: process.parentExe, parentLooksLikeHost: process.parentLooksLikeHost,
        entryPointSha256: sha256(readRegularFile(process.entryPoint)), manifestVersion: manifest.version,
        packageVersion: packageJson.version, packageMain: packageJson.main, registryVersion: host.plugin.version,
        sourceArchiveName: host.plugin.source?.path || null,
        sourceArchiveReferenceIsAbsolute: typeof host.plugin.source?.path === 'string' && path.isAbsolute(host.plugin.source.path),
        sourceArchiveAtDeclaredPathPresent: typeof host.plugin.source?.path === 'string' && path.isAbsolute(host.plugin.source.path)
          ? fs.existsSync(host.plugin.source.path) : null };
      if (workflowDb) host.database = workflowDbSummary(workflowDb);
      else {
        const fdDir = path.join(procRoot, String(process.pid), 'fd');
        let dbPath = WORKFLOW_DB_DEFAULT;
        try {
          const openDatabases = fs.readdirSync(fdDir).map(fd => {
            try { return fs.readlinkSync(path.join(fdDir, fd)); } catch { return null; }
          }).filter(value => value && /(?:^|\/)workflow\.db$/.test(value));
          if (openDatabases.length === 1) dbPath = openDatabases[0];
        } catch {}
        host.database = workflowDbSummary(dbPath);
      }
    }
  } catch (error) {
    host.blockers.push('HOST_INSPECTION_FAILED');
    host.error = String(error?.message || error);
  }
  if (!host.database && workflowDb) host.database = workflowDbSummary(workflowDb);
  if (host.database?.blockers?.length) host.blockers.push(...host.database.blockers);
  return host;
}

/**
 * Validate the host checkpoint report's shape and release binding only.
 * Caller-controlled booleans such as `signatureVerified: true` are assertions,
 * not cryptographic evidence. Until a host-owned verifier returns a separately
 * authenticated result from its out-of-band authority and monotonic store, this
 * function MUST NOT return `verified: true` and therefore cannot open rollout.
 */
export function validateExternalAntiRollbackAnchorReport(anchor, { candidateSha256, rollbackSha256, now = Date.now() } = {}) {
  const blockers = [];
  if (!anchor || anchor.verified !== true || anchor.status !== 'VERIFIED') blockers.push('EXTERNAL_TRUST_ANCHOR_NOT_VERIFIED');
  if (anchor?.source !== 'host_monotonic_checkpoint_service' || typeof anchor?.authorityId !== 'string' || !anchor.authorityId.trim()) {
    blockers.push('EXTERNAL_TRUST_ANCHOR_AUTHORITY_UNVERIFIED');
  }
  if (!Number.isSafeInteger(anchor?.checkpointSequence) || anchor.checkpointSequence < 1 ||
      !SHA256_HEX.test(anchor?.checkpointDigest || '') || !SHA256_HEX.test(anchor?.previousCheckpointDigest || '')) {
    blockers.push('EXTERNAL_TRUST_ANCHOR_MONOTONIC_CHAIN_INVALID');
  }
  if (!SHA256_HEX.test(anchor?.ledgerStateSha256 || '') || !SHA256_HEX.test(anchor?.trustDomainStateSha256 || '')) {
    blockers.push('EXTERNAL_TRUST_ANCHOR_STATE_BINDING_INVALID');
  }
  if (anchor?.signatureVerified !== true || anchor?.independentOfLocalLedger !== true) {
    blockers.push('EXTERNAL_TRUST_ANCHOR_INDEPENDENCE_OR_SIGNATURE_UNVERIFIED');
  }
  if (!SHA256_HEX.test(candidateSha256 || '') || anchor?.candidateSha256 !== candidateSha256 ||
      !SHA256_HEX.test(rollbackSha256 || '') || anchor?.rollbackSha256 !== rollbackSha256) {
    blockers.push('EXTERNAL_TRUST_ANCHOR_RELEASE_HASH_MISMATCH');
  }
  const observedAt = typeof anchor?.observedAt === 'string' ? Date.parse(anchor.observedAt) : NaN;
  if (!Number.isFinite(observedAt) || new Date(observedAt).toISOString() !== anchor?.observedAt ||
      observedAt > now + 5_000 || now - observedAt > 5 * 60_000) {
    blockers.push('EXTERNAL_TRUST_ANCHOR_STALE_OR_NONCANONICAL');
  }
  const shapeValid = blockers.length === 0;
  // Deliberately unconditional: this module has no independent checkpoint
  // signature verifier or protected monotonic-state connector. A structurally
  // valid JSON report must never be mistaken for proof just because it contains
  // self-asserted `verified` / `signatureVerified` flags.
  blockers.push('EXTERNAL_TRUST_ANCHOR_CRYPTOGRAPHIC_VERIFIER_NOT_CONFIGURED');
  return { verified: false, shapeValid, blockers: [...new Set(blockers)] };
}

export function evaluateRolloutGate({ candidate, rollback, host }) {
  const blockers = [];
  if (!candidate?.verified) blockers.push('CANDIDATE_NOT_VERIFIED');
  if (!rollback?.verified) blockers.push('ROLLBACK_BUNDLE_NOT_VERIFIED');
  if (!host?.registryReadable || !host?.plugin || !host?.installedGeneration) blockers.push('HOST_RUNTIME_IDENTITY_UNVERIFIED');
  blockers.push(...(host?.blockers || []));
  if (!host?.database?.readable) blockers.push('WORKFLOW_DB_NOT_READABLE');
  if (host?.trustConfiguration?.available !== true) blockers.push('PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED');
  const anchorReport = validateExternalAntiRollbackAnchorReport(host?.trustConfiguration?.externalAntiRollbackAnchor, {
    candidateSha256: candidate?.sha256, rollbackSha256: rollback?.sha256
  });
  if (!anchorReport.verified) {
    blockers.push('PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED');
  }
  if (host?.database?.executingJobs > 0) blockers.push('ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN');
  if (host?.database?.runningTasks > 0) blockers.push('RUNNING_TASKS_MUST_DRAIN');
  if (host?.database?.activeLeases > 0) blockers.push('ACTIVE_TASK_LEASES_MUST_DRAIN');
  if (candidate?.version === host?.installedGeneration?.manifestVersion) blockers.push('CANDIDATE_VERSION_ALREADY_INSTALLED');
  if (rollback?.version && rollback.version !== host?.installedGeneration?.manifestVersion) blockers.push('ROLLBACK_VERSION_DOES_NOT_MATCH_INSTALLED_BASELINE');
  return { status: blockers.length ? 'BLOCKED' : 'READY_FOR_HOST_MANAGED_ACTIVATION', canActivateNow: blockers.length === 0,
    activationMechanism: 'Chat On Steroids host plugin manager / UI only; this CLI does not edit host registry or manage the plugin process',
    blockers: [...new Set(blockers)] };
}

export function compareBundleToDirectory(bundle, directory) {
  const root = path.resolve(directory);
  const actualFiles = new Map();
  function visit(folder, relative = '') {
    for (const name of fs.readdirSync(path.join(folder, relative)).sort()) {
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new Error('unsafe path component in installed generation');
      const rel = relative ? `${relative}/${name}` : name;
      const filePath = path.join(folder, relative, name);
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) throw new Error(`installed generation contains a symlink: ${rel}`);
      if (stat.isDirectory()) visit(folder, rel);
      else if (stat.isFile()) actualFiles.set(rel, sha256(readRegularFile(filePath, MAX_UNPACKED_BYTES)));
      else throw new Error(`installed generation contains a non-regular object: ${rel}`);
    }
  }
  visit(root);
  const expectedFiles = bundle.entries.filter(entry => !entry.endsWith('/'));
  const mismatches = [];
  for (const entry of expectedFiles) {
    const expected = actualFiles.get(entry);
    if (!expected) { mismatches.push({ path: entry, reason: 'missing_installed_file' }); continue; }
    const observed = sha256(Buffer.from(run('unzip', ['-p', bundle.path, entry], { encoding: 'buffer' })));
    if (expected !== observed) mismatches.push({ path: entry, reason: 'content_hash_mismatch', installedSha256: expected, bundleSha256: observed });
  }
  for (const entry of actualFiles.keys()) if (!expectedFiles.includes(entry)) mismatches.push({ path: entry, reason: 'extra_installed_file' });
  return { matches: mismatches.length === 0 && actualFiles.size === expectedFiles.length,
    archiveFileCount: expectedFiles.length, installedFileCount: actualFiles.size, mismatches };
}

function writeAtomicJson(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tempPath, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tempPath, filePath);
  const dirFd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}

function assertPrivateSimulationRoot(root) {
  const absolute = path.resolve(root);
  const tmpRoot = path.resolve(os.tmpdir());
  if (absolute === tmpRoot || !absolute.startsWith(`${tmpRoot}${path.sep}`) ||
      !/^runalith-rollout-test-[A-Za-z0-9._-]+$/.test(path.basename(absolute))) {
    throw new Error(`simulation root must be an explicitly named private test directory under ${tmpRoot}`);
  }
  if (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink()) throw new Error('simulation root cannot be a symlink');
  return absolute;
}

function extractCandidate(bundle, destination) {
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  run('unzip', ['-q', bundle.path, '-d', destination], { timeout: 30_000 });
  const manifest = safeJson(fs.readFileSync(path.join(destination, 'manifest.json'), 'utf8'), 'staged manifest');
  const packageJson = safeJson(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'), 'staged package metadata');
  const selectedEntry = path.resolve(destination, manifest.server.entry_point);
  if (!selectedEntry.startsWith(`${destination}${path.sep}`) || !fs.statSync(selectedEntry).isFile() ||
      packageJson.main !== manifest.server.entry_point || packageJson.version !== manifest.version || manifest.version !== bundle.version) {
    throw new Error('staged generation does not preserve selected manifest/package identity');
  }
  for (const entry of bundle.entries.filter(name => !name.endsWith('/'))) {
    const filePath = path.resolve(destination, entry);
    if (!filePath.startsWith(`${destination}${path.sep}`) || !fs.statSync(filePath).isFile()) throw new Error(`staged bundle path missing or escaped: ${entry}`);
    if (sha256(readRegularFile(filePath)) !== sha256(Buffer.from(run('unzip', ['-p', bundle.path, entry], { encoding: 'buffer' })))) {
      throw new Error(`staged archive file differs from the exact candidate bytes: ${entry}`);
    }
  }
  return { manifest, packageJson, selectedEntry };
}

export function simulateRolloutInRoot({ bundlePath, root, failpoint = null, smoke = () => ({ passed: true }) }) {
  const privateRoot = assertPrivateSimulationRoot(root);
  const bundle = inspectBundle(bundlePath);
  if (!fs.existsSync(privateRoot)) fs.mkdirSync(privateRoot, { recursive: false, mode: 0o700 });
  const activePath = path.join(privateRoot, 'active-generation.json');
  const generationsPath = path.join(privateRoot, 'generations');
  fs.mkdirSync(generationsPath, { recursive: true, mode: 0o700 });
  let prior;
  if (fs.existsSync(activePath)) prior = safeJson(fs.readFileSync(activePath, 'utf8'), 'simulation active-generation marker');
  else {
    const priorRoot = path.join(generationsPath, 'g-1.0.9-rc.5-baseline');
    fs.mkdirSync(priorRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(priorRoot, 'baseline.json'), JSON.stringify({ version: '1.0.9-rc.5', synthetic: true }) + '\n', { flag: 'wx', mode: 0o600 });
    prior = { version: '1.0.9-rc.5', packageSha256: 'test-only-baseline', generation: priorRoot, state: 'active', synthetic: true };
    writeAtomicJson(activePath, prior);
  }
  if (prior.packageSha256 === bundle.sha256 && prior.version === bundle.version) {
    const activeGeneration = path.resolve(prior.generation || '');
    if (!activeGeneration.startsWith(`${generationsPath}${path.sep}`) || !fs.existsSync(activeGeneration) ||
        !compareBundleToDirectory(bundle, activeGeneration).matches) {
      throw new Error('active-generation marker matches this candidate but the on-disk generation does not; refusing idempotent success');
    }
    return { status: 'ALREADY_ACTIVE', idempotent: true, rollbackPerformed: false, prior, current: prior, bundleSha256: bundle.sha256, phases: ['preflight', 'already-active', 'active-generation-hash-verified'] };
  }
  const generationName = `g-${bundle.version}-${bundle.sha256.slice(0, 16)}`;
  const generationRoot = path.join(generationsPath, generationName);
  const phases = ['preflight'];
  let switched = false;
  const rollback = () => {
    writeAtomicJson(activePath, prior);
    const observed = safeJson(fs.readFileSync(activePath, 'utf8'), 'rolled-back active-generation marker');
    if (JSON.stringify(observed) !== JSON.stringify(prior)) throw new Error('rollback active-generation marker failed exact readback');
    return observed;
  };
  try {
    if (!fs.existsSync(generationRoot)) extractCandidate(bundle, generationRoot);
    else {
      const reused = inspectBundle(bundlePath);
      if (reused.sha256 !== bundle.sha256) throw new Error('generation name collision with a different candidate hash');
      const parity = compareBundleToDirectory(bundle, generationRoot);
      if (!parity.matches) throw new Error('existing staged generation differs from the exact candidate archive');
    }
    phases.push('staged-and-hash-verified');
    if (failpoint === 'after-stage') throw new Error('SIMULATED_FAILURE_AFTER_STAGE');
    const next = { version: bundle.version, packageSha256: bundle.sha256, generation: generationRoot, state: 'active', synthetic: true };
    writeAtomicJson(activePath, next);
    switched = true;
    phases.push('switched-atomically');
    if (failpoint === 'after-switch' || failpoint === 'health-check') throw new Error('SIMULATED_POST_SWITCH_HEALTH_FAILURE');
    const smokeResult = smoke(bundlePath);
    if (!smokeResult?.passed) throw new Error('candidate health smoke did not report passed');
    const observed = safeJson(fs.readFileSync(activePath, 'utf8'), 'post-switch active-generation marker');
    if (observed.packageSha256 !== bundle.sha256 || observed.version !== bundle.version || observed.generation !== generationRoot) {
      throw new Error('post-switch readback does not match the exact staged candidate');
    }
    phases.push('health-check-passed', 'post-switch-readback-passed');
    return { status: 'ROLLOUT_SIMULATED', idempotent: false, rollbackPerformed: false, prior, current: observed,
      bundleSha256: bundle.sha256, phases, smoke: { passed: true } };
  } catch (error) {
    const failure = String(error?.message || error);
    const recovered = switched ? rollback() : safeJson(fs.readFileSync(activePath, 'utf8'), 'pre-switch active-generation marker');
    phases.push(switched ? 'rollback-performed' : 'switch-not-performed');
    if (JSON.stringify(recovered) !== JSON.stringify(prior)) throw new Error(`rollout failed (${failure}) and rollback state could not be verified`);
    return { status: 'ROLLOUT_FAILED_ROLLED_BACK', idempotent: false, rollbackPerformed: switched,
      failure, prior, current: recovered, bundleSha256: bundle.sha256, phases };
  }
}

function validateBackupOutputPath(outPath) {
  const absolute = path.resolve(outPath);
  const tmpRoot = path.resolve(os.tmpdir());
  if (path.dirname(absolute) !== tmpRoot || !absolute.toLowerCase().endsWith('.mcpb')) {
    throw new Error(`rollback snapshots can only be written as .mcpb files directly under ${tmpRoot}`);
  }
  if (fs.existsSync(absolute) || fs.existsSync(`${absolute}.manifest.json`) || fs.lstatSync(tmpRoot).isSymbolicLink()) {
    throw new Error('refusing to overwrite an existing rollback bundle/manifest or use a symlink output parent');
  }
  return absolute;
}

export function createInstalledRollbackSnapshot({ outPath, appRoot = APP_ROOT_DEFAULT, procRoot = '/proc', workflowDb = null, smoke = smokeCandidate }) {
  const destination = validateBackupOutputPath(outPath);
  const host = inspectHost({ appRoot, procRoot, workflowDb });
  if (host.processes.length !== 1 || !host.installedGeneration || !host.plugin) throw new Error('cannot create rollback snapshot until the installed generation is identified unambiguously');
  const sourceRoot = host.installedGeneration.path;
  const beforeHashes = [];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runalith-installed-generation-snapshot-'));
  fs.chmodSync(tempRoot, 0o700);
  const copiedRoot = path.join(tempRoot, 'payload');
  fs.mkdirSync(copiedRoot, { mode: 0o700 });
  let bundleCreated = false;
  try {
    function copyTree(sourceDir, relativeDir = '') {
      const names = fs.readdirSync(path.join(sourceDir, relativeDir)).sort();
      for (const name of names) {
        if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new Error('unsafe installed path component');
        const relative = relativeDir ? `${relativeDir}/${name}` : name;
        const source = path.join(sourceDir, relative);
        const destinationPath = path.join(copiedRoot, relative);
        const stat = fs.lstatSync(source);
        if (stat.isSymbolicLink()) throw new Error(`installed generation contains a symlink; refusing rollback archive: ${relative}`);
        if (stat.isDirectory()) { fs.mkdirSync(destinationPath, { recursive: false, mode: 0o700 }); copyTree(sourceDir, relative); continue; }
        if (!stat.isFile() || stat.size > MAX_UNPACKED_BYTES) throw new Error(`installed generation contains unsupported/oversized file: ${relative}`);
        const bytes = readRegularFile(source, MAX_UNPACKED_BYTES);
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
        const fd = fs.openSync(destinationPath, 'wx', stat.mode & 0o111 ? 0o755 : 0o644);
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        const digest = sha256(bytes);
        beforeHashes.push({ path: relative, sizeBytes: bytes.length, sha256: digest });
        if (sha256(readRegularFile(source, MAX_UNPACKED_BYTES)) !== digest) throw new Error(`installed generation changed during snapshot: ${relative}`);
      }
    }
    copyTree(sourceRoot);
    if (!beforeHashes.some(item => item.path === 'server/index.js') ||
        beforeHashes.find(item => item.path === 'server/index.js')?.sha256 !== PINNED_HISTORICAL_SERVER_SHA256) {
      throw new Error('installed generation does not preserve the exact historical server/index.js hash');
    }
    const archiveRoots = fs.readdirSync(copiedRoot).sort();
    if (!archiveRoots.length) throw new Error('installed generation snapshot has no package files');
    run('zip', ['-X', '-q', '-r', destination, ...archiveRoots], { cwd: copiedRoot, timeout: 30_000 });
    bundleCreated = true;
    const actual = inspectBundle(destination);
    if (actual.version !== host.installedGeneration.manifestVersion || actual.sha256 !== sha256(readRegularFile(destination))) {
      throw new Error('rollback archive package identity or self-hash verification failed');
    }
    const copiedMap = new Map(beforeHashes.map(item => [item.path, item.sha256]));
    for (const entry of actual.entries.filter(name => !name.endsWith('/'))) {
      const expected = copiedMap.get(entry);
      const observed = sha256(Buffer.from(run('unzip', ['-p', destination, entry], { encoding: 'buffer' })));
      if (!expected || expected !== observed) throw new Error(`rollback archive bytes differ from installed generation: ${entry}`);
    }
    const smokeResult = smoke(destination);
    if (!smokeResult?.passed) throw new Error('rollback archive extracted-runtime smoke did not pass');
    const sidecar = { schemaVersion: 1, kind: 'runalith-installed-generation-rollback-snapshot', generatedAt: new Date().toISOString(),
      pluginId: host.plugin.id, pluginName: host.plugin.name, version: actual.version, sourceArchiveName: host.plugin.source?.path || null,
      sourceArchiveBytesNotAvailable: host.installedGeneration.sourceArchiveAtDeclaredPathPresent !== true,
      sourceGenerationPath: sourceRoot, entryPoint: host.installedGeneration.entryPoint,
      archiveSha256: actual.sha256, fileCount: beforeHashes.length, historicalServerSha256: PINNED_HISTORICAL_SERVER_SHA256,
      files: beforeHashes.sort((a, b) => a.path.localeCompare(b.path)), smoke: { passed: true },
      limitations: ['This is a content-derived rollback snapshot of the installed generation, not the original MCPB container bytes or a publisher attestation.'] };
    const fd = fs.openSync(`${destination}.manifest.json`, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(sidecar, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return { status: 'ROLLBACK_SNAPSHOT_READY', bundlePath: destination, manifestPath: `${destination}.manifest.json`,
      version: actual.version, archiveSha256: actual.sha256, sizeBytes: actual.sizeBytes, fileCount: beforeHashes.length,
      smoke: smokeResult, limitations: sidecar.limitations };
  } catch (error) {
    if (bundleCreated) {
      // Do not remove a failed candidate silently; preserve it for inspection.
    }
    throw error;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = {};
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index];
    if (token === '--help' || token === '-h') { args.help = true; continue; }
    if (!token.startsWith('--')) throw new Error(`unexpected positional argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (Object.hasOwn(args, key)) throw new Error(`duplicate option: ${token}`);
    if (['json', 'skip-smoke'].includes(key)) args[key] = true;
    else {
      const value = rest[++index];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${token}`);
      args[key] = value;
    }
  }
  return { command, ...args };
}

function usage() {
  console.log('Runalith release rollout readiness (host mutation intentionally unsupported)\n\n' +
    '  node scripts/runalith-rollout.mjs backup-installed --out /tmp/runalith-rollback.mcpb\n' +
    '  node scripts/runalith-rollout.mjs preflight --candidate <rc8.mcpb> --rollback-bundle <rollback.mcpb>\n' +
    '  node scripts/runalith-rollout.mjs verify-installed --candidate <rc8.mcpb>\n' +
    '  node scripts/runalith-rollout.mjs simulate --candidate <rc8.mcpb> [--failpoint after-stage|after-switch|health-check]\n\n' +
    'preflight and verify-installed are read-only. backup-installed writes only a new non-overwriting .mcpb and manifest under /tmp. simulate uses a private /tmp generation directory. No command edits Chat On Steroids configuration, workflow DB, process state, or plugin installation.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command || args.command === '--help' || args.command === '-h') return usage();
  if (args.command === 'backup-installed') {
    if (!args.out) throw new Error('backup-installed requires --out');
    const result = createInstalledRollbackSnapshot({ outPath: args.out, appRoot: args.appRoot || APP_ROOT_DEFAULT,
      procRoot: args.procRoot || '/proc', workflowDb: args.workflowDb || null });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.command === 'preflight') {
    if (!args.candidate) throw new Error('preflight requires --candidate');
    const candidateBundle = inspectBundle(args.candidate, { requireCurrentSource: true });
    if (args.expectedSha256 && args.expectedSha256 !== candidateBundle.sha256) throw new Error(`candidate SHA-256 mismatch: expected ${args.expectedSha256}, observed ${candidateBundle.sha256}`);
    const candidateSmoke = smokeCandidate(candidateBundle.path);
    let rollback = null;
    if (args.rollbackBundle) {
      const rollbackBundle = inspectBundle(args.rollbackBundle);
      const rollbackSmoke = smokeCandidate(rollbackBundle.path);
      rollback = { verified: false, path: rollbackBundle.path, version: rollbackBundle.version, sha256: rollbackBundle.sha256,
        sizeBytes: rollbackBundle.sizeBytes, toolCount: rollbackBundle.toolCount, smoke: rollbackSmoke, installedFileParity: null };
    }
    const host = inspectHost({ appRoot: args.appRoot || APP_ROOT_DEFAULT, workflowDb: args.workflowDb || null });
    if (rollback && host.installedGeneration) {
      rollback.installedFileParity = compareBundleToDirectory(inspectBundle(rollback.path), host.installedGeneration.path);
      rollback.verified = rollback.smoke.passed && rollback.installedFileParity.matches;
    }
    const decision = evaluateRolloutGate({ candidate: { verified: true, version: candidateBundle.version, sha256: candidateBundle.sha256 }, rollback, host });
    const report = { schemaVersion: 1, command: 'preflight', generatedAt: new Date().toISOString(), readOnly: true,
      liveMutationPerformed: false, candidate: { verified: true, ...candidateBundle, smoke: candidateSmoke },
      rollback: rollback || { verified: false, status: 'not-provided' }, host, decision,
      exactActionStillRequired: decision.canActivateNow
        ? 'Use the host plugin UI to import/update this exact MCPB, then re-run verify-installed and query orchestrator_health through the live host-connected MCP client.'
        : 'No activation/restart is authorized by this report. Drain current work through its normal owner, provide a tested rollback bundle, rerun preflight, then use the host UI; do not kill the runtime process.' };
    console.log(JSON.stringify(report, null, 2));
    if (!decision.canActivateNow) process.exitCode = 3;
    return;
  }
  if (args.command === 'verify-installed') {
    if (!args.candidate) throw new Error('verify-installed requires --candidate');
    const candidate = inspectBundle(args.candidate, { requireCurrentSource: false });
    const host = inspectHost({ appRoot: args.appRoot || APP_ROOT_DEFAULT, workflowDb: args.workflowDb || null });
    const comparisons = [];
    const blockers = [];
    let comparedFiles = 0;
    if (host.processes.length !== 1 || !host.installedGeneration) blockers.push('HOST_RUNTIME_IDENTITY_UNVERIFIED');
    else {
      const parity = compareBundleToDirectory(candidate, host.installedGeneration.path);
      comparedFiles = parity.archiveFileCount;
      comparisons.push(...parity.mismatches);
      if (!parity.matches) blockers.push('INSTALLED_FILE_PARITY_MISMATCH');
      if (host.installedGeneration.manifestVersion !== candidate.version || host.plugin.version !== candidate.version) blockers.push('INSTALLED_VERSION_MISMATCH');
      if (host.installedGeneration.entryPoint !== path.join(host.installedGeneration.path, candidate.entryPoint)) blockers.push('INSTALLED_ENTRYPOINT_MISMATCH');
    }
    blockers.push(...host.blockers);
    const report = { schemaVersion: 1, command: 'verify-installed', generatedAt: new Date().toISOString(), readOnly: true,
      liveMutationPerformed: false, candidate: { version: candidate.version, sha256: candidate.sha256, entryPoint: candidate.entryPoint, toolCount: candidate.toolCount },
      host: { plugin: host.plugin ? { id: host.plugin.id, version: host.plugin.version, enabled: host.plugin.enabled, status: host.plugin.status } : null,
        processCount: host.processes.length, installedGeneration: host.installedGeneration },
      comparedFiles, mismatches: comparisons, blockers, status: blockers.length ? 'MISMATCH' : 'FILES_MATCH_EXACTLY',
      note: 'File parity does not independently reveal the host-stored MCPB container hash. Query orchestrator_health through the live host-connected MCP client to verify the serving runtime.' };
    console.log(JSON.stringify(report, null, 2));
    if (blockers.length) process.exitCode = 4;
    return;
  }
  if (args.command === 'simulate') {
    if (!args.candidate) throw new Error('simulate requires --candidate');
    if (args.failpoint && !['after-stage', 'after-switch', 'health-check'].includes(args.failpoint)) throw new Error('unknown --failpoint');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runalith-rollout-test-'));
    fs.chmodSync(root, 0o700);
    try {
      const result = simulateRolloutInRoot({ bundlePath: args.candidate, root, failpoint: args.failpoint || null,
        smoke: pathArg => { const tested = smokeCandidate(pathArg); return { passed: tested.passed }; } });
      console.log(JSON.stringify({ ...result, simulationRoot: root, privateTestDirectory: true,
        hostPluginConfigChanged: false, liveWorkflowDatabaseChanged: false, liveProcessChanged: false }, null, 2));
      if (result.status === 'ROLLOUT_FAILED_ROLLED_BACK') process.exitCode = 5;
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
    return;
  }
  throw new Error(`unsupported command ${args.command}; live activation is intentionally not exposed`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`rollout readiness failed: ${String(error?.stack || error)}`); process.exitCode = 1; });
}
