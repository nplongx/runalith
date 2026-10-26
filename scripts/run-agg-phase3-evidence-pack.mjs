#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseStrictJson } from '../src/runtime/strict-json.js';
import { canonicalJson } from '../src/runtime/canonical-json.js';
import { readStableRegularFile, writeFileExclusiveAtomic } from '../src/runtime/exclusive-file.js';
import { validateAdaptiveGoalPhase2Dataset, validateAdaptiveGoalPhase2ModelArtifact } from '../src/runtime/adaptive-goal-phase2-dataset.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactsRoot = path.join(repoRoot, 'artifacts');
const phase2PackRelative = 'artifacts/agg-phase2-workflow-20261024T102000Z-source-callpath-trust-anchor-hardening-successor';
const phase2Pack = path.join(repoRoot, phase2PackRelative);
const developmentBundleRelative = 'artifacts/agg-phase1-hardening-20261023T143802Z-deep-verification/runalith-1.0.9-rc.5-agg-phase1-hardened.mcpb';
const officialBundleRelative = 'artifacts/runalith-1.0.9-rc.5-candidate-latest-build-20261022T175328+0700.mcpb';
const expectedHead = 'ff15b21934e5fd4920eea4b0816f6dc35d7f328a';
const expectedDevelopmentBundleSha256 = '7fb5f547eda71a717d10358510e1ea7baee46f5f9bcea3efc2891c6293bd3bc0';
const expectedOfficialBundleSha256 = '9d836dca9daec26b53a104f99028fb30fd11848e8c0a8764c4eb7dedd45e1c37';
const expectedPhase2ManifestSha256 = 'e7edbd108bc1142cc9db0139a3d149dac8a33f7d9a1b9c1c08957e2e144a4502';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashCanonical = value => hash(canonicalJson(value));
const args = process.argv.slice(2);
let outputDir;
let runSecuritySuite = true;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--help') {
    console.log('Usage: node scripts/run-agg-phase3-evidence-pack.mjs --output-dir NEW_PACK_DIR [--skip-security-suite]\n\nRuns and records Phase 3/Phase 2 integration tests, docs, security checks, the full npm test chain, actual frozen-source alignment checks and repeated-seed synthetic benchmarks. It publishes SHA256SUMS.txt last, then writes derived verifier/source-drift sidecars outside the pack. It never signs, builds/installs a package, modifies frozen bytes, opens a gate, or treats synthetic data as acceptance evidence.');
    process.exit(0);
  }
  if (arg === '--skip-security-suite') { runSecuritySuite = false; continue; }
  if (arg !== '--output-dir') throw new Error(`Unknown argument: ${arg}`);
  if (outputDir) throw new Error('Duplicate --output-dir');
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Missing value for --output-dir');
  outputDir = path.resolve(args[++index]);
}
if (!outputDir) throw new Error('--output-dir is required');
if (!outputDir.startsWith(`${artifactsRoot}${path.sep}`) || path.dirname(outputDir) !== artifactsRoot || outputDir === artifactsRoot) {
  throw new Error('Output pack must be a new direct child directory of repository artifacts/');
}
if (fs.existsSync(outputDir) || fs.lstatSync(outputDir, { throwIfNoEntry: false })?.isSymbolicLink()) {
  throw new Error(`Refusing to overwrite an existing evidence pack: ${outputDir}`);
}
if (fs.realpathSync(artifactsRoot) !== artifactsRoot) throw new Error('artifacts/ must be a canonical non-symlink directory');

const git = (gitArgs, encoding = 'utf8') => {
  const result = spawnSync('git', gitArgs, { cwd: repoRoot, encoding, maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${gitArgs.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
};
const gitHead = git(['rev-parse', 'HEAD']).trim();
if (gitHead !== expectedHead) throw new Error(`HEAD changed: expected ${expectedHead}, observed ${gitHead}; evidence pack refuses to proceed`);
const gitStatusBeforePack = git(['status', '--porcelain=v1', '--untracked-files=all', '-z'], 'buffer');
const trackedPatch = git(['diff', '--binary', 'HEAD'], 'buffer');
const untrackedSourceNamesBeforePack = git(['ls-files', '--others', '--exclude-standard', '-z'], 'buffer').toString('utf8').split('\0').filter(Boolean);
const nodeVersion = process.version;
const startedAt = new Date().toISOString();

function isTextSourcePath(relative) {
  if (relative.startsWith('artifacts/') || relative.startsWith('node_modules/') || relative.startsWith('dist/') || relative.startsWith('.git/')) return false;
  if (relative.startsWith('benchmarks/plugin-workflow-benchmark/runs/') || relative.startsWith('benchmarks/plugin-workflow-benchmark/phase2-pilot-')) return false;
  if (/\.(?:js|mjs|json|md|sh|yml|yaml|toml)$/.test(relative)) return true;
  return false;
}
const explicitSources = [
  'package.json', 'plugin/manifest.json', 'server/index.js', 'scripts/collect-plugin-runtime.mjs',
  'scripts/generate-mcp-reference.mjs', 'scripts/check-docs.mjs', 'scripts/package-runalith-mcpb.sh',
  'scripts/train-agg-phase2-discriminator.mjs', 'scripts/run-agg-phase2-shadow-search.mjs',
  'scripts/benchmark-agg-phase2-paired.mjs', 'scripts/verify-agg-phase2-evidence-pack.mjs',
  'scripts/run-agg-phase3-mcts-shadow.mjs', 'scripts/benchmark-agg-phase3-mcts-vs-beam.mjs',
  'scripts/create-agg-phase3-adversarial-corpus.mjs', 'scripts/run-agg-phase3-evidence-pack.mjs',
  'scripts/verify-agg-phase3-evidence-pack.mjs', 'scripts/check-agg-phase3-source-drift.mjs',
  'src/runtime/adaptive-goal-graph.js', 'src/runtime/adaptive-goal-discriminator.js',
  'src/runtime/adaptive-goal-phase2-dataset.js', 'src/runtime/adaptive-goal-phase2-search.js',
  'src/runtime/adaptive-goal-phase2-plan-shadow.js', 'src/runtime/adaptive-goal-phase3-mcts.js',
  'src/runtime/strict-json.js', 'src/runtime/canonical-json.js', 'src/runtime/exclusive-file.js',
  'tests/test-adaptive-goal-phase3-mcts.mjs', 'tests/test-adaptive-goal-discriminator.mjs',
  'tests/test-adaptive-goal-phase2-mcp-tool.mjs', 'tests/test-adaptive-goal-graph.js',
  'tests/test-adaptive-goal-benchmark.mjs', 'tests/test-runalith-plugin.js',
  'tests/test-mcpb-source-alignment.mjs', 'tests/test-agg-phase1-evidence-pack-verifier.mjs',
  'tests/test-agg-phase1-phase2-package-boundary.mjs', 'tests/test-phase1-acceptance-protocol-freeze.mjs',
  'tests/test-phase1-execution-provenance-contract.mjs', 'tests/test-phase2-inventory-diagnostic-contract.mjs',
  'benchmarks/adaptive-goal-graph/fixtures/phase3-mcts-adversarial-corpus.json',
  'docs/README.md', 'docs/MCP_REFERENCE.md', 'docs/adaptive-goal-graph.md'
];
const uniqueExplicitSources = [...new Set(explicitSources)];
for (const relative of uniqueExplicitSources) {
  const full = path.resolve(repoRoot, relative);
  const stat = fs.lstatSync(full, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || fs.realpathSync(full) !== full) throw new Error(`Required source snapshot file is missing/noncanonical: ${relative}`);
}

// Validate the handoff pack before copying; never alter it.
const phase2ManifestBytes = readStableRegularFile(path.join(phase2Pack, 'SHA256SUMS.txt'), { maxBytes: 16 * 1024 * 1024, label: 'prior Phase 2 manifest' });
const phase2ManifestSha256 = hash(phase2ManifestBytes);
if (phase2ManifestSha256 !== expectedPhase2ManifestSha256) throw new Error(`Prior Phase 2 manifest hash drift: ${phase2ManifestSha256}`);
const phase2ManifestEntries = [];
for (const [index, line] of phase2ManifestBytes.toString('utf8').trimEnd().split('\n').entries()) {
  const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
  if (!match) throw new Error(`Prior Phase 2 manifest line ${index + 1} is malformed`);
  const full = path.resolve(repoRoot, match[2]);
  if (!full.startsWith(`${phase2Pack}${path.sep}`)) throw new Error(`Prior Phase 2 manifest path escapes pack: ${match[2]}`);
  const bytes = readStableRegularFile(full, { maxBytes: 64 * 1024 * 1024, label: match[2] });
  if (hash(bytes) !== match[1]) throw new Error(`Prior Phase 2 manifest entry mismatch: ${match[2]}`);
  phase2ManifestEntries.push({ path: match[2], sha256: match[1], sizeBytes: bytes.length });
}
const phase2VerifierPath = `${phase2Pack}-pack-verification-final.json`;
const phase2Verifier = parseStrictJson(readStableRegularFile(phase2VerifierPath, { maxBytes: 16 * 1024 * 1024, label: 'Phase 2 outer verifier sidecar' }), 'Phase 2 outer verifier sidecar');
if (phase2Verifier.verificationStatus !== 'BLOCKED' || phase2Verifier.executionGate !== 'CLOSED' ||
    !phase2Verifier.checks?.some(item => item.id === 'EXPECTED_MANIFEST_ANCHOR' && item.status === 'FAIL')) {
  throw new Error('Prior Phase 2 pack status differs from the expected retained BLOCKED/trust-anchor state');
}

const developmentBundle = readStableRegularFile(path.join(repoRoot, developmentBundleRelative), { maxBytes: 512 * 1024 * 1024, label: 'development candidate archive' });
const officialBundle = readStableRegularFile(path.join(repoRoot, officialBundleRelative), { maxBytes: 512 * 1024 * 1024, label: 'official target archive' });
if (hash(developmentBundle) !== expectedDevelopmentBundleSha256 || hash(officialBundle) !== expectedOfficialBundleSha256) {
  throw new Error('Frozen candidate or official target archive bytes changed; refusing evidence pack creation');
}

fs.mkdirSync(outputDir, { mode: 0o700 });
for (const directory of ['inputs', 'runs', 'validation/logs', 'git', 'source-snapshot', 'untracked-source-overlay']) {
  fs.mkdirSync(path.join(outputDir, directory), { recursive: true, mode: 0o700 });
}
const writeExclusive = (relative, bytes) => {
  const full = path.join(outputDir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
  writeFileExclusiveAtomic(full, bytes, { mode: 0o600 });
};
const writeJson = (relative, value) => writeExclusive(relative, `${JSON.stringify(value, null, 2)}\n`);
const copyExclusive = (sourcePath, relative, maxBytes = 64 * 1024 * 1024) => {
  const fullSource = path.resolve(sourcePath);
  const stat = fs.lstatSync(fullSource);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(fullSource) !== fullSource) throw new Error(`Refusing noncanonical evidence input: ${sourcePath}`);
  const bytes = readStableRegularFile(fullSource, { maxBytes, label: sourcePath });
  writeExclusive(relative, bytes);
  return { path: relative, sourcePath: path.relative(repoRoot, fullSource), sizeBytes: bytes.length, sha256: hash(bytes) };
};

writeExclusive('git/HEAD.txt', `${gitHead}\n`);
writeExclusive('git/status-porcelain-v1-z.bin', gitStatusBeforePack);
writeExclusive('git/tracked-working-tree.patch', trackedPatch);
writeJson('git/repository-snapshot.json', {
  schemaVersion: 1, gitHead, capturedAt: startedAt,
  workingTreeStatusBytes: gitStatusBeforePack.length, workingTreeStatusSha256: hash(gitStatusBeforePack),
  trackedPatchBytes: trackedPatch.length, trackedPatchSha256: hash(trackedPatch),
  resetCleanCommitPerformed: false
});

const copiedInputs = [];
copiedInputs.push(copyExclusive(path.join(phase2Pack, 'inputs/dataset.json'), 'inputs/dataset.json'));
copiedInputs.push(copyExclusive(path.join(phase2Pack, 'model.json'), 'inputs/model.json'));
copiedInputs.push(copyExclusive(path.join(phase2Pack, 'inputs/graph.json'), 'inputs/graph.json'));
copiedInputs.push(copyExclusive(path.join(phase2Pack, 'inputs/benchmark-corpus.json'), 'inputs/phase2-five-case-corpus.json'));
copiedInputs.push(copyExclusive(path.join(repoRoot, 'benchmarks/adaptive-goal-graph/fixtures/phase3-mcts-adversarial-corpus.json'), 'inputs/phase3-adversarial-corpus.json'));
copiedInputs.push(copyExclusive(path.join(phase2Pack, 'SHA256SUMS.txt'), 'inputs/prior-phase2-SHA256SUMS.txt'));
const datasetBytes = readStableRegularFile(path.join(outputDir, 'inputs/dataset.json'), { maxBytes: 16 * 1024 * 1024, label: 'Phase 3 input dataset' });
const dataset = validateAdaptiveGoalPhase2Dataset(parseStrictJson(datasetBytes, 'Phase 3 input dataset'));
const modelBytes = readStableRegularFile(path.join(outputDir, 'inputs/model.json'), { maxBytes: 16 * 1024 * 1024, label: 'Phase 3 input model' });
const modelArtifact = validateAdaptiveGoalPhase2ModelArtifact(parseStrictJson(modelBytes, 'Phase 3 input model'));
if (modelArtifact.datasetFileSha256 !== hash(datasetBytes) || modelArtifact.datasetSha256 !== dataset.datasetSha256 || modelArtifact.datasetId !== dataset.datasetId) {
  throw new Error('Prior Phase 2 model artifact is not bound to the copied exact dataset bytes; will not use it');
}

const authorityPrerequisites = {
  schemaVersion: 1,
  requirements: [
    { id: 'OWNER_SIGNED_CORPUS_AND_TRUSTED_ROOT', status: 'MISSING', blocker: 'No owner-signed corpus nor independently provisioned trusted root is present; synthetic corpus metadata is not a signature.' },
    { id: 'TEN_SCENARIO_PAIRED_OPERATIONAL_RUNS', status: 'MISSING', blocker: 'Only offline synthetic graph search was run; no approved paired operational runs for all 10 scenarios.' },
    { id: 'INDEPENDENT_SIGNED_EVALUATOR_ADJUDICATION', status: 'MISSING', blocker: 'No independent signed evaluator report bound to raw operational ledgers/artifacts.' },
    { id: 'NEW_EXACT_BYTES_BOUND_AUTHORIZATION', status: 'MISSING', blocker: 'No new authorization bound to this successor manifest and exact target archive bytes.' },
    { id: 'PRODUCTION_GRADE_SIGNED_ISOLATION_ATTESTATION', status: 'MISSING', blocker: 'No production-grade signed CPU/memory/network/filesystem isolation attestation.' },
    { id: 'DURABLE_GATE_CONSUMPTION_EVIDENCE', status: 'MISSING', blocker: 'No durable evidence that a separately authorized release gate was consumed once for exact bytes.' },
    { id: 'OWNER_APPROVAL_EXACT_BYTES', status: 'MISSING', blocker: 'No owner approval bound to the exact successor manifest and target SHA-256.' }
  ],
  allSatisfied: false,
  currentTrustAnchorEnvironmentProvisioned: Boolean(process.env.AGG_PHASE3_TRUSTED_ANCHOR_PUBLIC_KEY_PEM),
  actionTaken: 'NONE_NO_SIGNATURE_OR_ATTESTATION_CREATED'
};
writeJson('authority-prerequisites.json', authorityPrerequisites);

const phase3RunOptions = {
  maxSimulations: 64, maxDepth: 10, maxExpansions: 128, maxWorkUnits: 50000,
  maxAuditEvents: 512, candidateLimit: 6, maxTreeNodes: 256,
  maxTerminalPaths: 256, explorationConstant: Math.SQRT2, seed: 20261024,
  initiallyAvailableIds: []
};
const benchmarkOptions = {
  beamWidth: 4, maxSimulations: 64, seeds: [101, 202, 303, 404, 505],
  maxDepth: 10, maxExpansions: 128, maxWorkUnits: 50000,
  maxAuditEvents: 256, maxTreeNodes: 256, maxTerminalPaths: 256
};
const smallCorpusOptions = {
  beamWidth: 4, maxSimulations: 16, seeds: [101, 202],
  maxDepth: 8, maxExpansions: 64, maxWorkUnits: 25000,
  maxAuditEvents: 128, maxTreeNodes: 128, maxTerminalPaths: 128
};
writeJson('validation/phase3-run-config.json', { schemaVersion: 1, options: phase3RunOptions });
writeJson('validation/phase3-benchmark-config.json', { schemaVersion: 1, options: benchmarkOptions });
writeJson('validation/phase2-small-corpus-config.json', { schemaVersion: 1, options: smallCorpusOptions });

const commands = [];
function runCommand(label, executable, argv, { timeout = 180_000, expectedFailurePattern = null, outputPath: artifactOutputPath = null } = {}) {
  const started = Date.now();
  const env = { ...process.env };
  // All validation subprocesses use the default (Phase 3 disabled) runtime.
  delete env.AGG_PHASE3_MCTS_TOOL_ENABLED;
  delete env.AGG_PHASE2_SHADOW_TOOL_ENABLED;
  const child = spawnSync(executable, argv, { cwd: repoRoot, env, encoding: 'utf8', timeout, maxBuffer: 128 * 1024 * 1024 });
  const durationMs = Date.now() - started;
  const stdout = child.stdout ?? '';
  const stderr = child.stderr ?? '';
  const streamPrefix = `validation/logs/${label}`;
  writeExclusive(`${streamPrefix}.stdout.log`, stdout);
  writeExclusive(`${streamPrefix}.stderr.log`, stderr);
  const combined = `${stdout}\n${stderr}`;
  const expectedFailureObserved = expectedFailurePattern ? (child.status !== 0 && new RegExp(expectedFailurePattern, 'i').test(combined)) : false;
  const classification = child.status === 0 ? 'PASS'
    : expectedFailureObserved ? 'KNOWN_BLOCKER_REPRODUCED'
      : child.error?.code === 'ETIMEDOUT' || child.signal === 'SIGTERM' || child.signal === 'SIGKILL' ? 'TIMEOUT_OR_SIGNAL'
        : 'FAIL';
  const record = {
    label, argv: [executable, ...argv], cwd: repoRoot,
    exitCode: child.status ?? null, signal: child.signal ?? null,
    startTime: new Date(started).toISOString(), durationMs,
    classification, expectedFailurePattern,
    error: child.error ? { code: child.error.code ?? null, message: child.error.message } : null,
    stdout: { path: `${streamPrefix}.stdout.log`, sizeBytes: Buffer.byteLength(stdout), sha256: hash(Buffer.from(stdout)) },
    stderr: { path: `${streamPrefix}.stderr.log`, sizeBytes: Buffer.byteLength(stderr), sha256: hash(Buffer.from(stderr)) },
    ...(artifactOutputPath ? { generatedArtifactPath: path.relative(outputDir, artifactOutputPath), generatedArtifactExists: fs.existsSync(artifactOutputPath) } : {})
  };
  commands.push(record);
  return record;
}

// Stable runner result from exact copied Phase 2 dataset/model bytes.
const phase3ShadowPath = path.join(outputDir, 'runs/phase3-shadow-result.json');
runCommand('phase3-shadow-runner', process.execPath, [
  'scripts/run-agg-phase3-mcts-shadow.mjs', '--graph', path.join(outputDir, 'inputs/graph.json'),
  '--dataset', path.join(outputDir, 'inputs/dataset.json'), '--model', path.join(outputDir, 'inputs/model.json'),
  '--output', phase3ShadowPath, '--simulations', String(phase3RunOptions.maxSimulations),
  '--max-depth', String(phase3RunOptions.maxDepth), '--max-expansions', String(phase3RunOptions.maxExpansions),
  '--max-work-units', String(phase3RunOptions.maxWorkUnits), '--max-audit-events', String(phase3RunOptions.maxAuditEvents),
  '--candidate-limit', String(phase3RunOptions.candidateLimit), '--max-tree-nodes', String(phase3RunOptions.maxTreeNodes),
  '--max-terminal-paths', String(phase3RunOptions.maxTerminalPaths), '--exploration-constant', String(phase3RunOptions.explorationConstant),
  '--seed', String(phase3RunOptions.seed)
], { timeout: 60_000, outputPath: phase3ShadowPath });

const benchmarkPath = path.join(outputDir, 'runs/phase3-paired-benchmark.json');
runCommand('phase3-paired-benchmark-24-cases-5-seeds', process.execPath, [
  'scripts/benchmark-agg-phase3-mcts-vs-beam.mjs', '--corpus', path.join(outputDir, 'inputs/phase3-adversarial-corpus.json'),
  '--dataset', path.join(outputDir, 'inputs/dataset.json'), '--model', path.join(outputDir, 'inputs/model.json'),
  '--output', benchmarkPath, '--beam-width', String(benchmarkOptions.beamWidth),
  '--simulations', String(benchmarkOptions.maxSimulations), '--seeds', benchmarkOptions.seeds.join(','),
  '--max-depth', String(benchmarkOptions.maxDepth), '--max-expansions', String(benchmarkOptions.maxExpansions),
  '--max-work-units', String(benchmarkOptions.maxWorkUnits), '--max-audit-events', String(benchmarkOptions.maxAuditEvents),
  '--max-tree-nodes', String(benchmarkOptions.maxTreeNodes), '--max-terminal-paths', String(benchmarkOptions.maxTerminalPaths)
], { timeout: 120_000, outputPath: benchmarkPath });

const smallBenchmarkPath = path.join(outputDir, 'runs/phase2-five-case-diagnostic.json');
runCommand('phase2-five-case-small-corpus-diagnostic', process.execPath, [
  'scripts/benchmark-agg-phase3-mcts-vs-beam.mjs', '--corpus', path.join(outputDir, 'inputs/phase2-five-case-corpus.json'),
  '--dataset', path.join(outputDir, 'inputs/dataset.json'), '--model', path.join(outputDir, 'inputs/model.json'),
  '--output', smallBenchmarkPath, '--beam-width', String(smallCorpusOptions.beamWidth),
  '--simulations', String(smallCorpusOptions.maxSimulations), '--seeds', smallCorpusOptions.seeds.join(','),
  '--max-depth', String(smallCorpusOptions.maxDepth), '--max-expansions', String(smallCorpusOptions.maxExpansions),
  '--max-work-units', String(smallCorpusOptions.maxWorkUnits), '--max-audit-events', String(smallCorpusOptions.maxAuditEvents),
  '--max-tree-nodes', String(smallCorpusOptions.maxTreeNodes), '--max-terminal-paths', String(smallCorpusOptions.maxTerminalPaths)
], { timeout: 60_000, outputPath: smallBenchmarkPath });

// Source syntax and deterministic/adversarial focused coverage.
for (const relative of [
  'server/index.js', 'src/runtime/adaptive-goal-phase3-mcts.js', 'scripts/run-agg-phase3-mcts-shadow.mjs',
  'scripts/benchmark-agg-phase3-mcts-vs-beam.mjs', 'scripts/create-agg-phase3-adversarial-corpus.mjs',
  'scripts/run-agg-phase3-evidence-pack.mjs', 'scripts/verify-agg-phase3-evidence-pack.mjs',
  'scripts/check-agg-phase3-source-drift.mjs', 'tests/test-adaptive-goal-phase3-mcts.mjs'
]) runCommand(`syntax-${relative.replace(/[^a-zA-Z0-9]+/g, '-')}`, process.execPath, ['--check', relative], { timeout: 30_000 });

runCommand('phase3-phase2-graph-mcp-regressions', process.execPath, ['--test',
  'tests/test-adaptive-goal-phase3-mcts.mjs', 'tests/test-adaptive-goal-discriminator.mjs',
  'tests/test-adaptive-goal-phase2-mcp-tool.mjs', 'tests/test-adaptive-goal-graph.js'], { timeout: 240_000 });
runCommand('phase1-freeze-and-phase2-boundary-regressions', process.execPath, ['--test',
  'tests/test-agg-phase1-evidence-pack-verifier.mjs', 'tests/test-agg-phase1-phase2-package-boundary.mjs',
  'tests/test-phase1-acceptance-protocol-freeze.mjs', 'tests/test-phase1-execution-provenance-contract.mjs'], { timeout: 300_000 });
runCommand('docs-reference-and-links', 'npm', ['run', 'docs:check'], { timeout: 60_000 });
runCommand('mcpb-source-alignment-verifier-regression-unit', process.execPath, ['tests/test-mcpb-source-alignment.mjs'], { timeout: 120_000 });
runCommand('phase1-adaptive-goal-provenance-frozen-fixture-test', process.execPath, ['--test', 'tests/test-adaptive-goal-benchmark.mjs'], {
  timeout: 90_000, expectedFailurePattern: 'PROVENANCE_SOURCE_HASH_MISMATCH.*server/index\\.js'
});
runCommand('production-qa-self-hash-regression', process.execPath, ['tests/test-runalith-plugin.js'], {
  timeout: 240_000, expectedFailurePattern: 'production behavioral QA harness SHA-256 mismatch'
});
runCommand('phase2-security-regression-suite', 'npm', ['run', 'test:phase2-security-regressions'], {
  timeout: 600_000, expectedFailurePattern: 'no candidate has exact current-source lineage|source/archive bytes differ for manifest\\.json'
});
runCommand('dashboard-regression', process.execPath, ['tests/test-dashboard.js'], { timeout: 120_000 });
runCommand('full-npm-test', 'npm', ['test'], {
  timeout: 600_000, expectedFailurePattern: 'PROVENANCE_SOURCE_HASH_MISMATCH.*server/index\\.js'
});
runCommand('git-diff-check', 'git', ['diff', '--check'], { timeout: 30_000 });

// Real frozen archive-vs-current-source checks are expected to fail; they prove
// package integration is not complete and are not repaired by rebuilding files.
const devAlignmentPath = path.join(outputDir, 'validation/development-candidate-source-alignment.json');
runCommand('actual-development-candidate-source-alignment', process.execPath, [
  'scripts/verify-mcpb-source-alignment.mjs', '--bundle', path.join(repoRoot, developmentBundleRelative),
  '--source-root', repoRoot, '--output', devAlignmentPath
], { timeout: 60_000, expectedFailurePattern: 'MCPB_SOURCE_ALIGNMENT_FAILED', outputPath: devAlignmentPath });
const officialAlignmentPath = path.join(outputDir, 'validation/official-target-source-alignment.json');
runCommand('actual-official-target-source-alignment', process.execPath, [
  'scripts/verify-mcpb-source-alignment.mjs', '--bundle', path.join(repoRoot, officialBundleRelative),
  '--source-root', repoRoot, '--output', officialAlignmentPath
], { timeout: 60_000, expectedFailurePattern: 'MCPB_SOURCE_ALIGNMENT_FAILED', outputPath: officialAlignmentPath });

// Capture actual frozen-byte/source hashes and Phase2 authority status.
const candidateIdentities = {
  schemaVersion: 1, capturedAt: new Date().toISOString(), gitHead,
  developmentCandidate: { path: developmentBundleRelative, sha256: hash(developmentBundle), expectedSha256: expectedDevelopmentBundleSha256 },
  officialTarget: { path: officialBundleRelative, sha256: hash(officialBundle), expectedSha256: expectedOfficialBundleSha256 },
  phase2Pack: { path: phase2PackRelative, manifestSha256: phase2ManifestSha256,
    verificationSidecarPath: path.relative(repoRoot, phase2VerifierPath), verificationSidecarSha256: hash(readStableRegularFile(phase2VerifierPath, { maxBytes: 16 * 1024 * 1024, label: 'Phase2 verifier sidecar' })),
    verificationStatus: phase2Verifier.verificationStatus, acceptanceStatus: phase2Verifier.acceptanceStatus,
    executionGate: phase2Verifier.executionGate, blockers: phase2Verifier.checks.filter(item => item.status === 'FAIL').map(item => ({ id: item.id, details: item.details })) }
};
writeJson('candidate-identities.json', candidateIdentities);
writeJson('phase2-handoff-status.json', {
  priorPackManifestSha256: phase2ManifestSha256, listedEntryCount: phase2ManifestEntries.length,
  listedChecksumsValidated: true, priorVerifierStatus: phase2Verifier.verificationStatus,
  priorVerifierBlockers: candidateIdentities.phase2Pack.blockers,
  phase1Readiness: 'BLOCKED', acceptance: 'PARTIAL_NOT_ACCEPTED', executionGate: 'CLOSED'
});

const commandsWithStatus = commands.map(command => ({ ...command,
  result: command.classification === 'PASS' ? 'PASS' : command.classification === 'KNOWN_BLOCKER_REPRODUCED' ? 'KNOWN_BLOCKER_REPRODUCED' : 'FAIL_OR_UNEXPECTED' }));
const unexpectedFailures = commandsWithStatus.filter(item => !['PASS', 'KNOWN_BLOCKER_REPRODUCED'].includes(item.classification));
const knownBlockers = commandsWithStatus.filter(item => item.classification === 'KNOWN_BLOCKER_REPRODUCED').map(item => ({ label: item.label, exitCode: item.exitCode, expectedFailurePattern: item.expectedFailurePattern }));
const validationStatus = unexpectedFailures.length ? 'BLOCKED_UNEXPECTED_VALIDATION_FAILURES'
  : knownBlockers.length ? 'PASS_WITH_KNOWN_HISTORICAL_OR_PACKAGE_BLOCKERS'
    : 'PASS_INTERNAL_VALIDATION';
writeJson('validation/command-ledger.json', {
  schemaVersion: 1, status: validationStatus, gitHead,
  invocation: [process.execPath, path.relative(repoRoot, fileURLToPath(import.meta.url)), ...args],
  nodeVersion, platform: process.platform, architecture: process.arch,
  phase3ToolOptInWasNotEnabledInValidationParent: process.env.AGG_PHASE3_MCTS_TOOL_ENABLED !== '1',
  commands: commandsWithStatus, knownBlockers, unexpectedFailures,
  fullNpmTestStatus: commandsWithStatus.find(item => item.label === 'full-npm-test')?.classification ?? 'NOT_RUN'
});
writeJson('validation/validation-results.json', {
  schemaVersion: 1, overallStatus: validationStatus,
  commands: commandsWithStatus.map(item => ({ label: item.label, exitCode: item.exitCode, classification: item.classification,
    expectedFailurePattern: item.expectedFailurePattern, stderr: item.stderr, stdout: item.stdout })),
  knownBlockers, unexpectedFailures,
  acceptance: 'PARTIAL_NOT_ACCEPTED', readiness: 'BLOCKED', executionGate: 'CLOSED'
});
writeJson('pack-metadata.json', {
  schemaVersion: 1, kind: 'agg_phase3_mcts_evidence_successor',
  packId: path.basename(outputDir), createdAt: startedAt, finalizedBeforeManifestAt: new Date().toISOString(),
  repositoryRoot: repoRoot, gitHead, nodeVersion, platform: process.platform, architecture: process.arch,
  validationStatus, knownBlockerCount: knownBlockers.length, unexpectedFailureCount: unexpectedFailures.length,
  sourceIntegration: 'OPT_IN_SOURCE_RUNTIME_ONLY',
  packagedIntegration: 'NOT_PRESENT_IN_FROZEN_ARCHIVES_AND_NO_PACKAGE_BUILD_PERFORMED',
  operationalVerification: 'NOT_RUN_NO_OPERATIONAL_AB_OR_PRODUCTION_DISPATCH',
  formalAcceptance: 'BLOCKED_MISSING_OWNER_AUTHORITY_EVIDENCE',
  acceptance: 'PARTIAL_NOT_ACCEPTED', readiness: 'BLOCKED', executionGate: 'CLOSED',
  publishedManifestIsFinalPackMutation: true
});

// Capture source closure and complete untracked textual overlay before publishing manifest.
const sourceFiles = [];
const copySnapshot = (repositoryPath, snapshotPath, classification) => {
  const fullSource = path.resolve(repoRoot, repositoryPath);
  const stat = fs.lstatSync(fullSource);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(fullSource) !== fullSource) throw new Error(`Noncanonical source snapshot file: ${repositoryPath}`);
  const bytes = readStableRegularFile(fullSource, { maxBytes: 64 * 1024 * 1024, label: repositoryPath });
  const target = path.join(outputDir, snapshotPath);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeFileExclusiveAtomic(target, bytes, { mode: 0o600 });
  sourceFiles.push({ repositoryPath, snapshotPath, sizeBytes: bytes.length, sha256: hash(bytes), classification });
};
for (const relative of uniqueExplicitSources) copySnapshot(relative, `source-snapshot/${relative}`, 'explicit_runtime_or_validation_closure');
const explicitSet = new Set(uniqueExplicitSources);
const skippedOverlay = [];
for (const relative of untrackedSourceNamesBeforePack) {
  if (!isTextSourcePath(relative) || explicitSet.has(relative)) continue;
  const fullSource = path.resolve(repoRoot, relative);
  if (!fullSource.startsWith(`${repoRoot}${path.sep}`)) { skippedOverlay.push({ path: relative, reason: 'unsafe_path' }); continue; }
  const stat = fs.lstatSync(fullSource, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || fs.realpathSync(fullSource) !== fullSource) { skippedOverlay.push({ path: relative, reason: 'nonregular_or_symlink' }); continue; }
  if (stat.size > 32 * 1024 * 1024) { skippedOverlay.push({ path: relative, reason: 'overlay_file_over_32MiB' }); continue; }
  copySnapshot(relative, `untracked-source-overlay/${relative}`, 'untracked_text_source');
}
writeJson('untracked-source-overlay-index.json', {
  schemaVersion: 1, trackedByGit: false, sourceFileCount: sourceFiles.filter(item => item.classification === 'untracked_text_source').length,
  entries: sourceFiles.filter(item => item.classification === 'untracked_text_source').map(({ repositoryPath, snapshotPath, sizeBytes, sha256 }) => ({ repositoryPath, snapshotPath, sizeBytes, sha256 })),
  skipped: skippedOverlay
});
writeJson('source-snapshot-identity.json', {
  schemaVersion: 1, capturedAt: new Date().toISOString(), gitHead,
  trackedPatchSha256: hash(trackedPatch), workingTreeStatusSha256: hash(gitStatusBeforePack),
  explicitSourceCount: sourceFiles.filter(item => item.classification === 'explicit_runtime_or_validation_closure').length,
  untrackedOverlaySourceCount: sourceFiles.filter(item => item.classification === 'untracked_text_source').length,
  files: sourceFiles.sort((a, b) => a.repositoryPath.localeCompare(b.repositoryPath))
});
writeExclusive('README.md', `# AGG Phase 3 MCTS Evidence Successor\n\n- Pack created: ${new Date().toISOString()}\n- Repository HEAD: \`${gitHead}\` (preserved; no commit/reset/clean performed)\n- Phase 2 handoff manifest SHA-256: \`${phase2ManifestSha256}\`\n- Status: **${validationStatus}**\n- Acceptance: **PARTIAL_NOT_ACCEPTED**\n- Readiness: **BLOCKED**\n- Execution gate: **CLOSED**\n\nThis pack records actual source-level MCTS/UCT integration, paired offline benchmark inputs/results, test/command stdout/stderr hashes, source snapshot and exact frozen archive identities. The 24-case corpus is synthetic and deliberately imbalanced (20 goal-path cases, 4 no-solution cases), so the benchmark marks corpus class imbalance and missing independent owner adjudication. The 5-case corpus is retained only as a small-sample diagnostic. The benchmark reports goal-path discovery separately from exhaustive no-solution proof: the mixed-outcome delta is not a like-for-like algorithm efficacy comparison, and MCTS gets no credit for proving no solution.\n\nThe existing frozen development candidate and official target archives were read and their recorded SHA-256 values verified; neither was rebuilt, overwritten, installed or deployed. Actual byte-alignment checks are expected to report source/archive mismatch because the archived packages predate Phase 2/3 source changes.\n\nNo trusted anchor signature, owner-signed corpus, evaluator attestation, authorization, isolation attestation, gate-consumption receipt or owner approval was fabricated. The outer verifier is expected to remain BLOCKED without the out-of-band trusted Ed25519 root and the seven authority prerequisites. \n`);

// Validate outputs and report truthful run summaries before manifest publication.
const phase3ShadowResult = parseStrictJson(readStableRegularFile(phase3ShadowPath, { maxBytes: 32 * 1024 * 1024, label: 'Phase3 shadow result' }), 'Phase3 shadow result');
const phase3BenchmarkResult = parseStrictJson(readStableRegularFile(benchmarkPath, { maxBytes: 64 * 1024 * 1024, label: 'Phase3 paired benchmark result' }), 'Phase3 paired benchmark result');
const smallBenchmarkResult = parseStrictJson(readStableRegularFile(smallBenchmarkPath, { maxBytes: 64 * 1024 * 1024, label: 'Phase2 small-corpus diagnostic' }), 'Phase2 small-corpus diagnostic');
writeJson('runs/run-summary.json', {
  schemaVersion: 1,
  phase3Shadow: { graphHash: phase3ShadowResult.graphHash, modelSha256: phase3ShadowResult.modelSha256,
    status: phase3ShadowResult.result.status, simulations: phase3ShadowResult.result.search.simulations,
    expansions: phase3ShadowResult.result.search.expansions, workUnits: phase3ShadowResult.result.search.workUnits,
    candidates: phase3ShadowResult.result.candidates.length, executionAuthorized: phase3ShadowResult.execution.authorized },
  adversarialBenchmark: { corpusId: phase3BenchmarkResult.corpusId, tasks: phase3BenchmarkResult.corpusAssessment.caseCount,
    seeds: phase3BenchmarkResult.pairedConfig.seeds, pairedTrials: phase3BenchmarkResult.metrics.pairedTrialCount,
    allOutcomeBeamSuccessRate: phase3BenchmarkResult.metrics.phase2BeamSuccessRate,
    allOutcomeMctsSuccessRate: phase3BenchmarkResult.metrics.phase3MCTSSuccessRate,
    mixedOutcomePairedDeltaNotLikeForLike: phase3BenchmarkResult.metrics.mixedOutcomeMeanPairedSuccessDelta,
    goalPathOnly: phase3BenchmarkResult.metrics.goalPathOnly,
    noSolutionProofs: phase3BenchmarkResult.metrics.noSolutionProofs,
    qualityFlags: phase3BenchmarkResult.corpusAssessment.qualityFlags },
  smallCorpusDiagnostic: { corpusId: smallBenchmarkResult.corpusId, tasks: smallBenchmarkResult.corpusAssessment.caseCount,
    sampleAssessment: smallBenchmarkResult.corpusAssessment.taskSampleAssessment,
    qualityFlags: smallBenchmarkResult.corpusAssessment.qualityFlags,
    acceptance: smallBenchmarkResult.acceptance },
  authorityPrerequisitesSatisfied: 0, authorityPrerequisitesRequired: 7,
  acceptance: 'PARTIAL_NOT_ACCEPTED', readiness: 'BLOCKED', executionGate: 'CLOSED'
});

// Publish the immutable manifest last; nothing is written inside outputDir after this line.
const manifestRows = [];
function gather(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink before manifest publication: ${full}`);
    if (entry.isDirectory()) gather(full);
    else if (entry.isFile()) {
      const relative = path.relative(outputDir, full).split(path.sep).join('/');
      if (relative === 'SHA256SUMS.txt') throw new Error('Manifest unexpectedly exists before final publication');
      const bytes = readStableRegularFile(full, { maxBytes: 128 * 1024 * 1024, label: relative });
      manifestRows.push({ path: relative, sha256: hash(bytes), sizeBytes: bytes.length });
    } else throw new Error(`Refusing special file before manifest publication: ${full}`);
  }
}
gather(outputDir);
manifestRows.sort((a, b) => a.path.localeCompare(b.path));
const manifestText = `${manifestRows.map(item => `${item.sha256}  ${item.path}`).join('\n')}\n`;
writeFileExclusiveAtomic(path.join(outputDir, 'SHA256SUMS.txt'), manifestText, { mode: 0o600 });
const manifestSha256 = hash(Buffer.from(manifestText));

// Derived verification/source-drift receipts are sidecars outside the pack.
// They never become unmanifested payload inside the immutable pack.
const finalVerifierPath = `${outputDir}-pack-verification-final.json`;
const driftPath = `${outputDir}-final-source-drift-check.json`;
const postSidecarVerifierPath = `${outputDir}-pack-verification-post-sidecar-replay.json`;
function runExternal(executable, argv, timeout = 120_000) {
  const env = { ...process.env };
  delete env.AGG_PHASE3_MCTS_TOOL_ENABLED;
  const child = spawnSync(executable, argv, { cwd: repoRoot, env, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  process.stdout.write(child.stdout ?? '');
  process.stderr.write(child.stderr ?? '');
  return { exitCode: child.status ?? null, signal: child.signal ?? null, error: child.error?.message ?? null };
}
const firstVerifier = runExternal(process.execPath, ['scripts/verify-agg-phase3-evidence-pack.mjs', '--pack', outputDir, '--output', finalVerifierPath], 180_000);
const sourceDrift = runExternal(process.execPath, ['scripts/check-agg-phase3-source-drift.mjs', '--pack', outputDir, '--output', driftPath], 120_000);
const finalVerifierReplay = runExternal(process.execPath, ['scripts/verify-agg-phase3-evidence-pack.mjs', '--pack', outputDir,
  '--output', postSidecarVerifierPath, '--require-sidecars'], 180_000);
const sidecars = {};
for (const [name, resultPath, commandResult] of [
  ['finalVerifier', finalVerifierPath, firstVerifier], ['sourceDrift', driftPath, sourceDrift], ['postSidecarVerifier', postSidecarVerifierPath, finalVerifierReplay]
]) {
  if (!fs.existsSync(resultPath)) throw new Error(`${name} sidecar was not written: ${resultPath}`);
  const parsed = parseStrictJson(readStableRegularFile(resultPath, { maxBytes: 32 * 1024 * 1024, label: name }), name);
  sidecars[name] = { path: path.relative(path.dirname(outputDir), resultPath), sha256: hash(readStableRegularFile(resultPath, { maxBytes: 32 * 1024 * 1024, label: name })),
    status: parsed.status ?? parsed.verificationStatus, verificationStatus: parsed.verificationStatus ?? null,
    manifestSha256: parsed.manifestSha256, executionGate: parsed.executionGate, exitCode: commandResult.exitCode };
}
if (sidecars.finalVerifier.manifestSha256 !== manifestSha256 || sidecars.finalVerifier.verificationStatus !== 'BLOCKED' ||
    sidecars.sourceDrift.status !== 'PASS_SOURCE_SNAPSHOT_MATCH' || sidecars.postSidecarVerifier.manifestSha256 !== manifestSha256 ||
    sidecars.postSidecarVerifier.verificationStatus !== 'BLOCKED' || sidecars.finalVerifier.executionGate !== 'CLOSED' ||
    sidecars.postSidecarVerifier.executionGate !== 'CLOSED') {
  throw new Error(`Derived verifier/source-drift sidecar results differ from expected integrity-pass/trust-blocked state: ${JSON.stringify(sidecars)}`);
}

console.log(JSON.stringify({
  pack: path.relative(repoRoot, outputDir), manifestSha256, manifestEntryCount: manifestRows.length,
  gitHead: gitHead, validationStatus, focusedTestExit: commands.find(item => item.label === 'phase3-phase2-graph-mcp-regressions')?.exitCode,
  fullNpmTestClassification: commands.find(item => item.label === 'full-npm-test')?.classification,
  benchmark: {
    tasks: phase3BenchmarkResult.corpusAssessment.caseCount,
    seeds: phase3BenchmarkResult.pairedConfig.seeds,
    pairedTrials: phase3BenchmarkResult.metrics.pairedTrialCount,
    allOutcomeBeamSuccessRate: phase3BenchmarkResult.metrics.phase2BeamSuccessRate,
    allOutcomeMctsSuccessRate: phase3BenchmarkResult.metrics.phase3MCTSSuccessRate,
    mixedOutcomePairedDeltaNotLikeForLike: phase3BenchmarkResult.metrics.mixedOutcomeMeanPairedSuccessDelta,
    goalPathOnly: phase3BenchmarkResult.metrics.goalPathOnly,
    noSolutionProofs: phase3BenchmarkResult.metrics.noSolutionProofs,
    qualityFlags: phase3BenchmarkResult.corpusAssessment.qualityFlags
  },
  sidecars,
  acceptance: 'PARTIAL_NOT_ACCEPTED', readiness: 'BLOCKED', executionGate: 'CLOSED'
}, null, 2));
