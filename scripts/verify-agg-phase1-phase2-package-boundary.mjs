#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseStrictJson } from '../src/runtime/strict-json.js';
import { isSafePortableArchivePath } from '../benchmarks/plugin-workflow-benchmark/phase2-zip-entry-type-safety.mjs';
import { FROZEN_PHASE2_ARCHIVE_ENTRY_COUNT } from '../benchmarks/plugin-workflow-benchmark/phase2-inventory-diagnostics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PHASE2_REFERENCE_RELATIVE_PATH = 'artifacts/runalith-1.0.9-rc.5-agg-test-20261021T092406Z.mcpb';
export const PHASE2_REFERENCE_SHA256 = '2e9937d309e0c3085f9bf789b38ceff21b91c6fc093ba4ee344cf214c173a956';
export const PHASE2_REFERENCE_TOOL_COUNT = 59;
export const EXPECTED_PHASE1_EXTRA_PATHS = Object.freeze([
  'src/runtime/adaptive-goal-evidence-lineage.js',
  'src/runtime/adaptive-goal-knowledge-store.js',
  'src/runtime/adaptive-goal-sandbox-executor.js',
  'src/runtime/adaptive-goal-source-evidence.js',
  'tests/test-adaptive-goal-evidence-lineage.js'
]);
export const EXPECTED_PHASE1_EXTRA_TOOLS = Object.freeze([
  'adaptive_goal_recovery_resolve',
  'adaptive_goal_knowledge_node_save',
  'adaptive_goal_knowledge_edge_add',
  'adaptive_goal_knowledge_search',
  'adaptive_goal_knowledge_node_get',
  'adaptive_goal_knowledge_node_history',
  'adaptive_goal_knowledge_recovery_resolve',
  'adaptive_goal_sandbox_action_execute'
]);

function fail(message) {
  const error = new Error(message);
  error.code = 'AGG_PHASE1_PHASE2_BOUNDARY_INVALID';
  throw error;
}
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function readCanonicalRegularFile(filePath, label, maxBytes = 64 * 1024 * 1024) {
  const resolved = path.resolve(filePath);
  let before;
  try { before = fs.lstatSync(resolved); } catch { fail(label + ' is missing'); }
  if (before.isSymbolicLink() || !before.isFile() || fs.realpathSync(resolved) !== resolved || before.size > maxBytes) {
    fail(label + ' must be a canonical regular non-symlink file within the size limit');
  }
  const bytes = fs.readFileSync(resolved);
  const after = fs.statSync(resolved);
  if (bytes.byteLength !== after.size || after.ino !== before.ino || after.dev !== before.dev) fail(label + ' changed while being read');
  return bytes;
}

function inspectBundle(bundlePath, label) {
  const resolvedPath = path.resolve(bundlePath);
  const bytes = readCanonicalRegularFile(resolvedPath, label);
  let names;
  try {
    names = execFileSync('unzip', ['-Z1', resolvedPath], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 })
      .split(/\r?\n/).filter(Boolean);
  } catch (cause) { fail(label + ' ZIP listing failed: ' + String(cause?.message || cause)); }
  if (!names.length || new Set(names).size !== names.length || names.some(name => !isSafePortableArchivePath(name))) {
    fail(label + ' contains an empty, duplicated or unsafe archive path');
  }
  if (!names.includes('manifest.json') || !names.includes('server/index.js')) fail(label + ' is missing manifest.json or server/index.js');
  let manifestBytes;
  let manifest;
  try {
    manifestBytes = execFileSync('unzip', ['-p', resolvedPath, 'manifest.json'], { encoding: 'buffer', timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    manifest = parseStrictJson(manifestBytes, label + ' manifest.json');
  } catch (cause) { fail(label + ' manifest is not readable strict JSON: ' + String(cause?.message || cause)); }
  if (!manifest || typeof manifest.version !== 'string' || !Array.isArray(manifest.tools) ||
      manifest.tools.some(tool => !tool || typeof tool.name !== 'string' || !tool.name.trim()) ||
      new Set(manifest.tools.map(tool => tool.name)).size !== manifest.tools.length) {
    fail(label + ' manifest tool contract is malformed or contains duplicate names');
  }
  return {
    label,
    path: resolvedPath,
    relativePath: path.relative(ROOT, resolvedPath).split(path.sep).join('/'),
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
    archiveEntryCount: names.length,
    archiveEntries: names.sort(),
    version: manifest.version,
    manifestSha256: sha256(manifestBytes),
    manifestToolCount: manifest.tools.length,
    toolNames: manifest.tools.map(tool => tool.name).sort()
  };
}

export function comparePhase1Phase2PackageBoundary(phase1, phase2) {
  const phase1Entries = new Set(phase1.archiveEntries);
  const phase2Entries = new Set(phase2.archiveEntries);
  const phase1ExtraPaths = [...phase1Entries].filter(name => !phase2Entries.has(name)).sort();
  const phase2ExtraPaths = [...phase2Entries].filter(name => !phase1Entries.has(name)).sort();
  const phase1Tools = new Set(phase1.toolNames);
  const phase2Tools = new Set(phase2.toolNames);
  const phase1ExtraTools = [...phase1Tools].filter(name => !phase2Tools.has(name)).sort();
  const phase2ExtraTools = [...phase2Tools].filter(name => !phase1Tools.has(name)).sort();
  const shapeMatchesObservedBoundary =
    JSON.stringify(phase1ExtraPaths) === JSON.stringify([...EXPECTED_PHASE1_EXTRA_PATHS].sort()) &&
    JSON.stringify(phase2ExtraPaths) === JSON.stringify([]) &&
    JSON.stringify(phase1ExtraTools) === JSON.stringify([...EXPECTED_PHASE1_EXTRA_TOOLS].sort()) &&
    JSON.stringify(phase2ExtraTools) === JSON.stringify([]);
  return {
    schemaVersion: 1,
    status: phase1.archiveEntryCount === FROZEN_PHASE2_ARCHIVE_ENTRY_COUNT
      ? 'PHASE1_ARCHIVE_COUNT_MATCHES_FROZEN_PHASE2_COUNT_BUT_PACKAGE_IDENTITY_MUST_STILL_BE_VERIFIED'
      : 'BLOCKED_PHASE2_FROZEN_COUNT_NOT_APPLICABLE_TO_CURRENT_PHASE1_PACKAGE',
    phase2ContractChanged: false,
    phase1ArchiveTrimmed: false,
    phase1CandidateSubstitutedAsPhase2Approval: false,
    officialAcceptanceClaimed: false,
    frozenPhase2RequiredEntryCount: FROZEN_PHASE2_ARCHIVE_ENTRY_COUNT,
    phase1: {
      path: phase1.relativePath, sha256: phase1.sha256, sizeBytes: phase1.sizeBytes,
      version: phase1.version, archiveEntryCount: phase1.archiveEntryCount,
      manifestSha256: phase1.manifestSha256, manifestToolCount: phase1.manifestToolCount
    },
    historicalPhase2Reference: {
      path: phase2.relativePath, sha256: phase2.sha256, sizeBytes: phase2.sizeBytes,
      version: phase2.version, archiveEntryCount: phase2.archiveEntryCount,
      manifestSha256: phase2.manifestSha256, manifestToolCount: phase2.manifestToolCount,
      status: 'HISTORICAL_COUNT_REFERENCE_NOT_CURRENT_SOURCE_VERIFIED_NOT_APPROVED'
    },
    sameSemanticVersionString: phase1.version === phase2.version,
    packageContractsDiffer: phase1.archiveEntryCount !== phase2.archiveEntryCount ||
      phase1.manifestToolCount !== phase2.manifestToolCount || phase1ExtraPaths.length > 0 || phase2ExtraPaths.length > 0 ||
      phase1ExtraTools.length > 0 || phase2ExtraTools.length > 0,
    pathDelta: { phase1Only: phase1ExtraPaths, phase2Only: phase2ExtraPaths },
    toolDelta: { phase1Only: phase1ExtraTools, phase2Only: phase2ExtraTools },
    observedBoundaryMatchesFrozenHistoricalShape: shapeMatchesObservedBoundary,
    requiredRemediation: 'Keep the Phase 2 71-path gate unchanged. Do not feed this 76-path/67-tool Phase 1 package into that exact-inventory acceptance gate. Before a shared release/version claim, obtain owner-approved versioned package/contract separation and fresh target-bound approvals; matching version strings and historical counts are not approval.'
  };
}

export function verifyPhase1Phase2PackageBoundary({ phase1BundlePath, phase2ReferencePath = path.join(ROOT, PHASE2_REFERENCE_RELATIVE_PATH) }) {
  const phase1 = inspectBundle(phase1BundlePath, 'current Phase 1 candidate');
  const phase2 = inspectBundle(phase2ReferencePath, 'historical Phase 2-shaped reference');
  if (phase2.sha256 !== PHASE2_REFERENCE_SHA256) {
    fail('historical Phase 2 reference hash mismatch: expected ' + PHASE2_REFERENCE_SHA256 + ', got ' + phase2.sha256);
  }
  if (phase2.archiveEntryCount !== FROZEN_PHASE2_ARCHIVE_ENTRY_COUNT ||
      phase2.manifestToolCount !== PHASE2_REFERENCE_TOOL_COUNT ||
      phase1.archiveEntryCount !== 76 || phase1.manifestToolCount !== 67 ||
      phase1.version !== '1.0.9-rc.5' || phase2.version !== '1.0.9-rc.5') {
    fail('observed RC.5 package counts/version changed; stop and re-investigate instead of weakening the frozen contract');
  }
  if (phase1.sha256 === phase2.sha256) fail('Phase 1 candidate unexpectedly has the same archive identity as the historical Phase 2 reference');
  const report = comparePhase1Phase2PackageBoundary(phase1, phase2);
  if (!report.observedBoundaryMatchesFrozenHistoricalShape) fail('archive-path or tool-schema delta differs from the investigated Phase 1/Phase 2 boundary');
  return report;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--help' || key === '-h') return { help: true };
    if (!['--phase1-bundle', '--phase2-reference', '--output'].includes(key) ||
        !argv[i + 1] || argv[i + 1].startsWith('--') || options[key]) fail('invalid or duplicate argument: ' + key);
    options[key] = argv[++i];
  }
  if (!options['--phase1-bundle']) fail('Usage: node scripts/verify-agg-phase1-phase2-package-boundary.mjs --phase1-bundle FILE [--phase2-reference FILE] [--output FILE]');
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) process.stdout.write('Usage: node scripts/verify-agg-phase1-phase2-package-boundary.mjs --phase1-bundle FILE [--phase2-reference FILE] [--output FILE]\n');
    else {
      const report = verifyPhase1Phase2PackageBoundary({
        phase1BundlePath: args['--phase1-bundle'], phase2ReferencePath: args['--phase2-reference']
      });
      const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
      if (args['--output']) {
        const output = path.resolve(args['--output']);
        if (fs.existsSync(output)) fail('refusing to overwrite existing boundary report: ' + output);
        fs.writeFileSync(output, bytes, { flag: 'wx', mode: 0o600 });
      }
      process.stdout.write(bytes);
    }
  } catch (cause) {
    process.stderr.write((cause.code || 'AGG_PHASE1_PHASE2_BOUNDARY_INVALID') + ': ' + (cause instanceof Error ? cause.message : String(cause)) + '\n');
    process.exitCode = 2;
  }
}
