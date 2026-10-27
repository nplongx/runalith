#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isSafePortableArchivePath, validateZipEntryTypes } from '../benchmarks/plugin-workflow-benchmark/phase2-zip-entry-type-safety.mjs';
import { serializePluginPackageMetadata } from './plugin-package-metadata.mjs';
import { parseStrictJson } from '../src/runtime/strict-json.js';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_INPUT_PATHS = Object.freeze([
  'package.json',
  'scripts/package-runalith-mcpb.sh',
  'scripts/collect-plugin-runtime.mjs',
  'scripts/plugin-package-metadata.mjs',
  'scripts/verify-mcpb-source-alignment.mjs',
  'scripts/validate-agg-trust-config.mjs',
  'scripts/reconcile-active-workflows.mjs',
  'benchmarks/plugin-workflow-benchmark/phase2-zip-entry-type-safety.mjs',
  'tests/test-extracted-package-tool-schemas.mjs',
  'benchmarks/plugin-workflow-benchmark/phase1-protocol-runner.mjs',
  'benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v1.json',
  'benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v2.json',
  'docs/plugin-workflow-benchmark-plan.md',
  'docs/plugin-workflow-benchmark-phase1-freeze.md',
  'scripts/replay-agg-phase1-finalization.mjs',
  'scripts/verify-agg-phase1-evidence-pack.mjs',
  'scripts/verify-agg-phase1-phase2-package-boundary.mjs',
  'scripts/test-mcpb-candidate.mjs',
  'src/runtime/strict-json.js',
  'src/runtime/adaptive-goal-trust-configuration.js',
  'tests/test-adaptive-goal-trust-configuration.mjs',
  'tests/test-adaptive-goal-trust-entrypoint.mjs',
  'tests/test-reconcile-active-workflows.mjs',
  'benchmarks/plugin-workflow-benchmark/phase2-inventory-diagnostics.mjs',
  'benchmarks/plugin-workflow-benchmark/create-phase2-candidate-inventory.mjs',
  'benchmarks/plugin-workflow-benchmark/test-create-phase2-candidate-inventory.mjs',
  'scripts/diagnose-phase2-archive-lineage.mjs',
  'tests/test-phase2-inventory-diagnostic-contract.mjs',
  'tests/test-adaptive-goal-execution-graph-proposal.js',
  'tests/test-agg-phase1-evidence-pack-verifier.mjs',
  'tests/test-agg-phase1-phase2-package-boundary.mjs',
  'tests/test-mcpb-source-alignment.mjs',
  'tests/test-plugin-workflow-benchmark-phase1-protocol.mjs',
  // Release-trust policy and independent-verifier implementation are build
  // inputs even though they are not shipped inside the MCPB. Omitting these
  // let a source snapshot identify runtime bytes while silently excluding the
  // policy and verifier code that decided whether those bytes were releasable.
  'scripts/lib/runalith-release-trust-contract.mjs',
  'scripts/verify-release-evidence.mjs',
  'scripts/lib/hosted-builder-attestation.mjs',
  'scripts/lib/hosted-verification-predicate.mjs',
  'scripts/verify-hosted-builder-provenance.mjs',
  'scripts/create-hosted-candidate-verification-predicate.mjs',
  'scripts/runalith-hosted-build-policy.json',
  'scripts/runalith-rollout.mjs',
  'tests/test-runalith-release-trust-contract.mjs',
  'tests/test-hosted-builder-attestation.mjs',
  'tests/test-hosted-verification-predicate.mjs',
  'tests/test-runalith-hosted-workflows.mjs',
  'tests/test-runalith-rollout.mjs',
  // A source snapshot must bind the implementation that verifies and projects
  // Goal/Idea → Plan → Execution Graphs, not just the server dispatcher or
  // tests. These modules carry authenticated snapshot identity, typed evidence
  // lineage, reviewer identity, immutable-plan binding, and dispatch guards.
  'src/runtime/adaptive-goal-graph.js',
  'src/runtime/adaptive-goal-knowledge-store.js',
  'src/runtime/adaptive-goal-knowledge-verifier.js',
  'src/runtime/adaptive-goal-plan-adapter.js',
  'src/runtime/adaptive-goal-compatibility.js',
  'src/runtime/adaptive-goal-execution-readiness.js',
  'src/runtime/adaptive-goal-execution-graph-proposal.js',
  'src/runtime/adaptive-goal-execution-plan-candidate.js',
  'src/runtime/adaptive-goal-reviewed-task-inputs.js',
  'src/runtime/adaptive-goal-action-intent-policy.js',
  'src/runtime/adaptive-goal-reviewer-identity.js',
  'src/runtime/adaptive-goal-source-evidence.js',
  'src/runtime/adaptive-goal-evidence-lineage.js',
  'src/runtime/adaptive-goal-sandbox-executor.js',
  'tests/test-adaptive-goal-execution-graph-proposal.js',
  'tests/test-adaptive-goal-execution-plan-candidate.js',
  'tests/test-adaptive-goal-current-scope-producer-e2e.mjs',
  'tests/test-adaptive-goal-knowledge-verifier.mjs',
  'tests/test-adaptive-goal-reviewer-identity.js',
  'tests/test-adaptive-goal-evidence-lineage.js',
  // Checkpoint correctness is a release decision input. Pin both the signed
  // response contract and the transactional compare-and-swap implementation,
  // plus its independent-connection/reopen adversarial regression suite.
  'scripts/lib/external-trust-checkpoint-contract.mjs',
  'scripts/lib/sqlite-external-checkpoint-transition.mjs',
  'tests/test-external-trust-checkpoint-contract.mjs',
  // Phase 2 custody signatures and the verifier that consumes them are part
  // of release eligibility. A source snapshot that omits these inputs could
  // otherwise bind a candidate while leaving its frozen-inventory authority
  // contract outside the authenticated build input set.
  'scripts/lib/phase2-custody-evidence.mjs',
  'scripts/verify-phase2-custody-evidence.mjs',
  'tests/test-phase2-custody-evidence.mjs',
  '.github/workflows/runalith-provenance-builder.yml',
  '.github/workflows/runalith-provenance-verifier.yml',
  '.github/workflows/runalith-verification-attestation-signer.yml',
  'docs/runalith-provenance-release-trust-design.md',
  'docs/runalith-hosted-builder-pipeline.md',
  'docs/runalith-release-evidence-verifier.md',
  'docs/agg-production-trust-provisioning-runbook.md',
]);

function fail(message) {
  const error = new Error(message);
  error.code = 'MCPB_SOURCE_ALIGNMENT_FAILED';
  throw error;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function parseArgs(argv) {
  const result = { sourceRoot: DEFAULT_ROOT, bundle: null, output: null };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!['--source-root', '--bundle', '--output'].includes(arg)) fail(`unknown argument: ${arg}`);
    if (seen.has(arg)) fail(`${arg} may be supplied only once`);
    seen.add(arg);
    const value = argv[++i];
    if (!value || value.startsWith('--')) fail(`${arg} requires a path`);
    const key = arg === '--source-root' ? 'sourceRoot' : arg.slice(2);
    result[key] = value;
  }
  if (!result.bundle) fail('--bundle is required');
  return result;
}

function assertRegularPath(root, relative, label) {
  if (typeof relative !== 'string' || !relative || relative.startsWith('/') ||
      relative.split('/').some(part => !part || part === '.' || part === '..') || relative.includes('\\')) {
    fail(`${label} has an unsafe relative path: ${String(relative)}`);
  }
  let current = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink()) fail(`${label} is missing or contains a symlink: ${relative}`);
    if (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) {
      fail(`${label} is not a regular file path: ${relative}`);
    }
    if (fs.realpathSync(current) !== current) fail(`${label} is not canonical: ${relative}`);
  }
  return current;
}

function readStableRegularFile(filePath, label, maxBytes = 128 * 1024 * 1024) {
  const resolved = path.resolve(filePath);
  let pathBefore;
  try { pathBefore = fs.lstatSync(resolved, { bigint: true }); }
  catch { fail(`${label} is missing or unreadable`); }
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
    fail(`${label} must be a canonical regular non-symlink file`);
  }
  let fd;
  try {
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino || before.size > BigInt(maxBytes)) {
      fail(`${label} identity or size changed before read`);
    }
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) fail(`${label} exceeds ${maxBytes} bytes`);
      chunks.push(buffer.subarray(0, count));
    }
    const bytes = Buffer.concat(chunks, total);
    const after = fs.fstatSync(fd, { bigint: true });
    const pathAfter = fs.lstatSync(resolved, { bigint: true });
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || bytes.byteLength !== Number(after.size) ||
        !pathAfter.isFile() || pathAfter.isSymbolicLink() || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino ||
        pathAfter.size !== before.size || pathAfter.mtimeNs !== before.mtimeNs || pathAfter.ctimeNs !== before.ctimeNs ||
        fs.realpathSync(resolved) !== resolved) fail(`${label} changed during descriptor read`);
    return bytes;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readSourceFile(root, relative, label, maxBytes = 32 * 1024 * 1024) {
  return readStableRegularFile(assertRegularPath(root, relative, label), label, maxBytes);
}

function readGitSourceState(root) {
  const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (head.status !== 0) return null;
  const patch = spawnSync('git', ['-C', root, 'diff', '--binary', 'HEAD'], { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 });
  if (patch.status !== 0) fail(`cannot capture Git working-tree state for source alignment: ${String(patch.stderr || '')}`);
  const status = spawnSync('git', ['-C', root, 'status', '--porcelain=v2', '--untracked-files=all'], {
    encoding: 'buffer', maxBuffer: 128 * 1024 * 1024
  });
  if (status.status !== 0) fail(`cannot capture Git status for source alignment: ${String(status.stderr || '')}`);
  // A bundle can byte-align to a dirty worktree. Preserve that fact explicitly:
  // HEAD alone is not the source snapshot, and a tracked diff alone omits new
  // files that may be packaged. Hash status bytes without exposing local paths.
  return {
    head: head.stdout.trim(),
    trackedDiffSha256: sha256(patch.stdout),
    workingTreeStatusSha256: sha256(status.stdout),
    trackedWorkingTreeClean: patch.stdout.byteLength === 0,
    workingTreeClean: status.stdout.byteLength === 0
  };
}

function sourceMapping(archivePath) {
  if (archivePath === 'manifest.json') return { sourcePath: 'plugin/manifest.json', kind: 'exact_source_bytes' };
  if (archivePath === 'package.json') return { sourcePath: 'package.json', kind: 'projected_package_metadata' };
  return { sourcePath: archivePath, kind: 'exact_source_bytes' };
}

function verifyAlignmentAgainstSnapshot({ root, bundle, bundleBytes, reportedBundlePath }) {
  // Inspect central-directory file types before asking `unzip -p` to read any
  // entry. Every ZIP command uses a private copy of the exact bytes being
  // hashed, not a caller-controlled path reopened after initial inspection.
  validateZipEntryTypes(bundleBytes);
  const initialGitState = readGitSourceState(root);
  const capturedSourceFiles = new Map();
  const captureSource = (relative, bytes) => {
    const prior = capturedSourceFiles.get(relative);
    if (prior && !prior.equals(bytes)) fail(`source path changed during this verification before a coherent snapshot could be established: ${relative}`);
    capturedSourceFiles.set(relative, Buffer.from(bytes));
  };
  const entriesOutput = execFileSync('unzip', ['-Z1', bundle], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const entries = entriesOutput.split(/\r?\n/).filter(Boolean);
  if (!entries.length || new Set(entries).size !== entries.length) fail('MCPB archive has no files or contains duplicate entries');
  for (const entry of entries) {
    if (!isSafePortableArchivePath(entry)) fail(`MCPB archive contains an unsafe portable entry path: ${JSON.stringify(entry)}`);
  }

  const packageBytes = readSourceFile(root, 'package.json', 'source package metadata', 4 * 1024 * 1024);
  let sourcePackage;
  try { sourcePackage = parseStrictJson(packageBytes, 'source package metadata'); }
  catch (cause) { fail(`source package metadata must be duplicate-free strict JSON: ${String(cause?.message || cause)}`); }
  captureSource('package.json', packageBytes);
  const manifestBytes = readSourceFile(root, 'plugin/manifest.json', 'source plugin manifest', 4 * 1024 * 1024);
  let manifest;
  try { manifest = parseStrictJson(manifestBytes, 'source plugin manifest'); }
  catch (cause) { fail(`source plugin manifest must be duplicate-free strict JSON: ${String(cause?.message || cause)}`); }
  captureSource('plugin/manifest.json', manifestBytes);
  const expectedPackage = serializePluginPackageMetadata(sourcePackage);
  const sourceEntries = [];

  for (const archivePath of entries) {
    const mapping = sourceMapping(archivePath);
    const label = `source for archive entry ${archivePath}`;
    assertRegularPath(root, mapping.sourcePath, label);
    const sourceBytes = mapping.kind === 'projected_package_metadata'
      ? expectedPackage
      : readSourceFile(root, mapping.sourcePath, label);
    if (mapping.kind === 'exact_source_bytes') captureSource(mapping.sourcePath, sourceBytes);
    const archiveBytes = execFileSync('unzip', ['-p', bundle, archivePath], { maxBuffer: 32 * 1024 * 1024 });
    const sourceSha256 = sha256(sourceBytes);
    const archiveSha256 = sha256(archiveBytes);
    if (!sourceBytes.equals(archiveBytes)) {
      fail(`source/archive byte mismatch for ${archivePath}: source=${sourceSha256} archive=${archiveSha256}`);
    }
    sourceEntries.push({ archivePath, sourcePath: mapping.sourcePath, kind: mapping.kind,
      sizeBytes: sourceBytes.byteLength, sha256: sourceSha256 });
  }

  const manifestEntry = sourceEntries.find(entry => entry.archivePath === 'manifest.json');
  const runtimeEntryPoint = sourcePackage.runtimeEntryPoint;
  if (typeof runtimeEntryPoint !== 'string' || !runtimeEntryPoint ||
      runtimeEntryPoint.split(/[\\/]/).some(part => !part || part === '.' || part === '..') ||
      !manifestEntry || manifest.server?.entry_point !== runtimeEntryPoint ||
      sourcePackage.version !== manifest.version || !Array.isArray(manifest.tools)) {
    fail('source manifest, package version and selected runtime entry point are inconsistent');
  }
  const toolNames = manifest.tools.map(tool => tool?.name);
  if (toolNames.some(name => typeof name !== 'string' || !name) || new Set(toolNames).size !== toolNames.length) {
    fail('source manifest tool names are malformed or duplicated');
  }
  const serverEntry = sourceEntries.find(entry => entry.archivePath === runtimeEntryPoint);
  if (!serverEntry) fail(`MCPB does not contain selected runtime entry point ${runtimeEntryPoint}`);
  if (!sourceEntries.some(entry => entry.archivePath === 'server/index.js')) {
    fail('MCPB does not preserve the historical server/index.js provenance input');
  }

  const head = initialGitState?.head || null;
  const buildInputs = [...new Set([...BUILD_INPUT_PATHS, runtimeEntryPoint])].map(sourcePath => {
    const bytes = readSourceFile(root, sourcePath, 'build provenance input');
    captureSource(sourcePath, bytes);
    return { sourcePath, sizeBytes: bytes.byteLength, sha256: sha256(bytes) };
  });
  for (const [relative, capturedBytes] of capturedSourceFiles) {
    const currentBytes = readSourceFile(root, relative, 'source stability recheck');
    if (!currentBytes.equals(capturedBytes)) fail(`source file changed during source-to-binary verification: ${relative}`);
  }
  const finalGitState = readGitSourceState(root);
  if (JSON.stringify(finalGitState) !== JSON.stringify(initialGitState)) {
    fail('Git HEAD or tracked working-tree bytes changed during source-to-binary verification');
  }
  const sourceSnapshotSha256 = sha256(Buffer.from(JSON.stringify({
    schemaVersion: 1,
    head,
    entries: sourceEntries.map(({ archivePath, sourcePath, kind, sizeBytes, sha256: digest }) =>
      ({ archivePath, sourcePath, kind, sizeBytes, sha256: digest })),
    buildInputs,
  })));
  // Keep the content snapshot reconstructible from the packaged bytes and Git
  // HEAD. Bind the captured cleanliness/diff state in a separate provenance
  // digest so clean-clone evidence-pack reconstruction remains compatible.
  const sourceProvenanceSha256 = sha256(Buffer.from(JSON.stringify({
    schemaVersion: 1, sourceSnapshotSha256, sourceGitState: initialGitState
  })));
  const sourceProvenanceStatus = !initialGitState
    ? 'GIT_PROVENANCE_UNAVAILABLE'
    : initialGitState.workingTreeClean
      ? 'CLEAN_GIT_TREE_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT'
      : 'DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT';

  return {
    schemaVersion: 1,
    status: 'PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT',
    byteIdentityStatus: 'PASS_EXACT_ARCHIVE_ENTRY_BYTES',
    sourceProvenanceStatus,
    releaseEligibility: 'BLOCKED_AUTHENTICATED_BUILD_RECEIPT_AND_INDEPENDENT_AUTHORITY_REQUIRED',
    checkedAt: new Date().toISOString(),
    sourceRoot: root,
    sourceGitHead: head,
    sourceGitState: initialGitState,
    bundlePath: reportedBundlePath,
    bundleBytes: bundleBytes.byteLength,
    bundleSha256: sha256(bundleBytes),
    sourceSnapshotSha256,
    sourceProvenanceSha256,
    archiveEntryCount: entries.length,
    exactSourceByteMatchCount: sourceEntries.filter(entry => entry.kind === 'exact_source_bytes').length,
    projectedMetadataMatchCount: sourceEntries.filter(entry => entry.kind === 'projected_package_metadata').length,
    manifestToolCount: toolNames.length,
    sourceServerSha256: serverEntry.sha256,
    sourceManifestSha256: manifestEntry.sha256,
    buildInputs,
    sourceEntries,
  };
}

export function verifyMcpbSourceAlignment({ sourceRoot, bundlePath }) {
  const root = path.resolve(sourceRoot);
  if (fs.realpathSync(root) !== root) fail('source root must be a canonical, non-symlink path');
  const reportedBundlePath = path.resolve(bundlePath);
  const bundleBytes = readStableRegularFile(reportedBundlePath, 'MCPB bundle', 64 * 1024 * 1024);
  if (!bundleBytes.byteLength) fail('MCPB bundle is empty');

  // Avoid a hash-then-reopen race: central-directory validation, entry listing
  // and entry extraction all use this private snapshot of the captured bytes.
  const snapshotDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-alignment-snapshot-'));
  try {
    fs.chmodSync(snapshotDirectory, 0o700);
    const snapshotPath = path.join(snapshotDirectory, 'candidate.mcpb');
    const fd = fs.openSync(snapshotPath, 'wx', 0o400);
    try { fs.writeFileSync(fd, bundleBytes); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    const result = verifyAlignmentAgainstSnapshot({ root, bundle: snapshotPath, bundleBytes, reportedBundlePath });
    // The archive was read into a private byte snapshot before ZIP inspection.
    // Recheck the named artifact after all extraction/source checks so a report
    // cannot silently describe bytes that no longer occupy its reported path.
    const finalBundleBytes = readStableRegularFile(reportedBundlePath, 'MCPB bundle final identity recheck', 64 * 1024 * 1024);
    if (!finalBundleBytes.equals(bundleBytes)) {
      fail('MCPB bundle path no longer contains the exact bytes captured at verification start');
    }
    return { ...result, bundlePathByteIdentityRecheckedAtCompletion: true };
  } finally {
    fs.rmSync(snapshotDirectory, { recursive: true, force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = verifyMcpbSourceAlignment({ sourceRoot: args.sourceRoot, bundlePath: path.resolve(args.bundle) });
  if (args.output) {
    const outputPath = path.resolve(args.output);
    const fd = fs.openSync(outputPath, 'wx', 0o644);
    try { fs.writeFileSync(fd, `${JSON.stringify(result, null, 2)}\n`); }
    finally { fs.closeSync(fd); }
  }
  process.stdout.write(`MCPB_SOURCE_ALIGNMENT=PASS byte_identity=${result.byteIdentityStatus} source_provenance=${result.sourceProvenanceStatus} release_eligibility=${result.releaseEligibility} bundle_sha256=${result.bundleSha256} source_snapshot_sha256=${result.sourceSnapshotSha256} entries=${result.archiveEntryCount} tools=${result.manifestToolCount}\n`);
  if (args.output) process.stdout.write(`provenance_report=${path.resolve(args.output)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${error.code || 'MCPB_SOURCE_ALIGNMENT_FAILED'}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
