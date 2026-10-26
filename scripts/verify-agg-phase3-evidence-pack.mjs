#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash, verify as verifySignature } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseStrictJson } from '../src/runtime/strict-json.js';
import { canonicalJson } from '../src/runtime/canonical-json.js';
import { readStableRegularFile, writeFileExclusiveAtomic } from '../src/runtime/exclusive-file.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashCanonical = value => hash(canonicalJson(value));
const args = process.argv.slice(2);
const values = new Map();
const flags = new Set();
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--help') {
    console.log('Usage: node scripts/verify-agg-phase3-evidence-pack.mjs --pack PACK_DIR --output NEW_REPORT.json [--require-sidecars] [--expected-manifest-sha256 SHA256 --anchor-signature-base64 BASE64]\n\nIndependently rechecks manifest/inventory/source snapshot, immutable artifact hashes, test/command log hashes, MCTS gates, and deterministic runner/paired-benchmark replay. A self-generated digest is integrity only. A trusted manifest anchor requires a separately provisioned AGG_PHASE3_TRUSTED_ANCHOR_PUBLIC_KEY_PEM and valid detached Ed25519 signature over agg-phase3-manifest-sha256:v1:<digest>. Without it, output remains BLOCKED.');
    process.exit(0);
  }
  if (arg === '--require-sidecars') { if (flags.has(arg)) throw new Error('Duplicate flag --require-sidecars'); flags.add(arg); continue; }
  if (!['--pack', '--output', '--expected-manifest-sha256', '--anchor-signature-base64'].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
  if (values.has(arg)) throw new Error(`Duplicate argument: ${arg}`);
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
  values.set(arg, args[++index]);
}
for (const key of ['--pack', '--output']) if (!values.has(key)) throw new Error(`Required argument missing: ${key}`);
const pack = path.resolve(values.get('--pack'));
const outputPath = path.resolve(values.get('--output'));
const expectedManifestSha256 = values.get('--expected-manifest-sha256');
const anchorSignatureBase64 = values.get('--anchor-signature-base64');
if (expectedManifestSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedManifestSha256)) throw new Error('--expected-manifest-sha256 must be 64 lowercase hexadecimal characters');
if (anchorSignatureBase64 !== undefined && (!/^[A-Za-z0-9+/]+={0,2}$/.test(anchorSignatureBase64) || Buffer.from(anchorSignatureBase64, 'base64').toString('base64') !== anchorSignatureBase64)) {
  throw new Error('--anchor-signature-base64 must be canonical base64');
}
const artifactsRoot = path.join(repoRoot, 'artifacts');
if (!pack.startsWith(`${artifactsRoot}${path.sep}`) || fs.realpathSync(pack) !== pack || fs.lstatSync(pack).isSymbolicLink() || !fs.lstatSync(pack).isDirectory()) {
  throw new Error('Pack must be a canonical non-symlink directory beneath repository artifacts/');
}
if (outputPath === pack || outputPath.startsWith(`${pack}${path.sep}`)) throw new Error('Verification report must be outside the immutable evidence pack');
const outputParent = path.dirname(outputPath);
const outputParentStat = fs.lstatSync(outputParent, { throwIfNoEntry: false });
if (!outputParentStat?.isDirectory() || outputParentStat.isSymbolicLink() || fs.realpathSync(outputParent) !== outputParent || fs.existsSync(outputPath)) {
  throw new Error('Verification report must be a new file in an existing canonical non-symlink directory');
}
const checkRows = [];
const blockers = [];
const check = (id, ok, details = null, blockerId = id) => {
  checkRows.push({ id, status: ok ? 'PASS' : 'FAIL', details });
  if (!ok) blockers.push({ id: blockerId, details });
  return ok;
};
const readBytes = (full, maxBytes = 64 * 1024 * 1024, label = path.relative(pack, full)) =>
  readStableRegularFile(full, { maxBytes, label });
const readJson = (relative, maxBytes = 64 * 1024 * 1024) =>
  parseStrictJson(readBytes(path.join(pack, relative), maxBytes), relative, { maxBytes });

let manifestBytes = Buffer.alloc(0), manifestSha256 = null, manifestEntries = [], inventoryPaths = [];
try {
  manifestBytes = readBytes(path.join(pack, 'SHA256SUMS.txt'), 16 * 1024 * 1024, 'Phase 3 SHA256SUMS.txt');
  manifestSha256 = hash(manifestBytes);
  const listed = new Map();
  const entries = [];
  for (const [index, line] of manifestBytes.toString('utf8').trimEnd().split('\n').entries()) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) throw new Error(`malformed manifest line ${index + 1}`);
    const relative = match[2];
    if (path.isAbsolute(relative) || relative.includes('\\') || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error(`unsafe manifest path at line ${index + 1}: ${relative}`);
    }
    if (listed.has(relative)) throw new Error(`duplicate manifest path: ${relative}`);
    const full = path.resolve(pack, relative);
    if (!full.startsWith(`${pack}${path.sep}`)) throw new Error(`manifest path escapes pack: ${relative}`);
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(full) !== full) throw new Error(`manifest entry is not a canonical regular file: ${relative}`);
    const bytes = readBytes(full, 64 * 1024 * 1024, relative);
    const observed = hash(bytes);
    const row = { path: relative, expectedSha256: match[1], observedSha256: observed, sizeBytes: bytes.length };
    if (observed !== match[1]) throw new Error(`checksum mismatch for ${relative}: expected ${match[1]}, observed ${observed}`);
    listed.set(relative, row); entries.push(row);
  }
  const actual = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink in pack: ${path.relative(pack, full)}`);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const relative = path.relative(pack, full).split(path.sep).join('/');
        if (relative !== 'SHA256SUMS.txt') actual.push(relative);
      } else throw new Error(`special file in pack: ${path.relative(pack, full)}`);
    }
  }
  walk(pack);
  const unlisted = actual.filter(relative => !listed.has(relative));
  const missing = [...listed.keys()].filter(relative => !actual.includes(relative));
  if (unlisted.length || missing.length) throw new Error(`manifest inventory mismatch; unlisted=${JSON.stringify(unlisted)}, missing=${JSON.stringify(missing)}`);
  manifestEntries = entries;
  inventoryPaths = actual;
  check('PACK_MANIFEST_AND_INVENTORY', true, { manifestSha256, manifestEntryCount: entries.length, inventoryCount: actual.length });
} catch (error) {
  check('PACK_MANIFEST_AND_INVENTORY', false, error.message, 'PACK_MANIFEST_INTEGRITY');
}

let packMetadata = null, snapshotIdentity = null, authorityPrerequisites = null;
try {
  packMetadata = readJson('pack-metadata.json');
  check('PACK_HEAD_PRESERVED', packMetadata.gitHead === 'ff15b21934e5fd4920eea4b0816f6dc35d7f328a', { observedHead: packMetadata.gitHead });
  check('PACK_STATE_NON_ACCEPTANCE', packMetadata.acceptance === 'PARTIAL_NOT_ACCEPTED' && packMetadata.readiness === 'BLOCKED' && packMetadata.executionGate === 'CLOSED', {
    acceptance: packMetadata.acceptance, readiness: packMetadata.readiness, executionGate: packMetadata.executionGate
  });
} catch (error) { check('PACK_METADATA_VALID', false, error.message); }

try {
  snapshotIdentity = readJson('source-snapshot-identity.json');
  const rows = [];
  for (const item of snapshotIdentity.files) {
    const sourceFile = path.resolve(pack, item.snapshotPath);
    if (!sourceFile.startsWith(`${pack}${path.sep}`)) throw new Error(`unsafe snapshot path for ${item.repositoryPath}`);
    const snapshotHash = hash(readBytes(sourceFile, 64 * 1024 * 1024, item.snapshotPath));
    const packedOk = snapshotHash === item.sha256;
    const currentFile = path.resolve(repoRoot, item.repositoryPath);
    if (!currentFile.startsWith(`${repoRoot}${path.sep}`)) throw new Error(`unsafe repository path for ${item.repositoryPath}`);
    const currentStat = fs.lstatSync(currentFile, { throwIfNoEntry: false });
    const currentHash = currentStat?.isFile() && !currentStat.isSymbolicLink() ? hash(readStableRegularFile(currentFile, { maxBytes: 64 * 1024 * 1024, label: item.repositoryPath })) : null;
    rows.push({ path: item.repositoryPath, snapshotHash, expectedHash: item.sha256, currentHash,
      status: packedOk && currentHash === item.sha256 ? 'MATCH' : !packedOk ? 'PACK_SNAPSHOT_HASH_MISMATCH' : 'SOURCE_DRIFT' });
  }
  const mismatches = rows.filter(item => item.status !== 'MATCH');
  check('SOURCE_SNAPSHOT_CLOSURE_AND_CURRENT_DRIFT', mismatches.length === 0, {
    fileCount: rows.length, mismatchCount: mismatches.length, mismatches: mismatches.slice(0, 40)
  }, 'SOURCE_SNAPSHOT_DRIFT');
} catch (error) { check('SOURCE_SNAPSHOT_CLOSURE_AND_CURRENT_DRIFT', false, error.message, 'SOURCE_SNAPSHOT_INVALID'); }

try {
  const candidate = readJson('candidate-identities.json');
  const expected = [
    { name: 'developmentCandidate', path: 'artifacts/agg-phase1-hardening-20261023T143802Z-deep-verification/runalith-1.0.9-rc.5-agg-phase1-hardened.mcpb', sha256: '7fb5f547eda71a717d10358510e1ea7baee46f5f9bcea3efc2891c6293bd3bc0' },
    { name: 'officialTarget', path: 'artifacts/runalith-1.0.9-rc.5-candidate-latest-build-20261022T175328+0700.mcpb', sha256: '9d836dca9daec26b53a104f99028fb30fd11848e8c0a8764c4eb7dedd45e1c37' }
  ];
  const comparisons = expected.map(item => {
    const full = path.resolve(repoRoot, item.path);
    const observed = hash(readStableRegularFile(full, { maxBytes: 512 * 1024 * 1024, label: item.name }));
    return { name: item.name, path: item.path, expectedSha256: item.sha256, capturedSha256: candidate[item.name]?.sha256, observedSha256: observed,
      status: observed === item.sha256 && candidate[item.name]?.sha256 === item.sha256 ? 'MATCH' : 'MISMATCH' };
  });
  check('FROZEN_ARCHIVE_BYTES_PRESERVED', comparisons.every(item => item.status === 'MATCH'), comparisons, 'FROZEN_ARCHIVE_DRIFT');
  const phase2Manifest = path.resolve(repoRoot, candidate.phase2Pack.path, 'SHA256SUMS.txt');
  const phase2Observed = hash(readStableRegularFile(phase2Manifest, { maxBytes: 16 * 1024 * 1024, label: 'prior Phase2 manifest' }));
  check('PHASE2_PRIOR_EVIDENCE_PRESERVED', phase2Observed === candidate.phase2Pack.manifestSha256 &&
    phase2Observed === 'e7edbd108bc1142cc9db0139a3d149dac8a33f7d9a1b9c1c08957e2e144a4502', {
      path: candidate.phase2Pack.path, expectedSha256: candidate.phase2Pack.manifestSha256, observedSha256: phase2Observed,
      priorVerificationStatus: candidate.phase2Pack.verificationStatus
    }, 'PHASE2_PRIOR_EVIDENCE_DRIFT');
  const priorSidecarBytes = readStableRegularFile(path.resolve(repoRoot, candidate.phase2Pack.verificationSidecarPath), {
    maxBytes: 16 * 1024 * 1024, label: 'prior Phase2 outer verifier sidecar'
  });
  const priorSidecar = parseStrictJson(priorSidecarBytes, 'prior Phase2 outer verifier sidecar');
  check('PHASE2_PRIOR_VERIFIER_SIDECAR_PRESERVED', hash(priorSidecarBytes) === candidate.phase2Pack.verificationSidecarSha256 &&
    priorSidecar.verificationStatus === 'BLOCKED' && priorSidecar.executionGate === 'CLOSED', {
      expectedSidecarSha256: candidate.phase2Pack.verificationSidecarSha256,
      observedSidecarSha256: hash(priorSidecarBytes), verificationStatus: priorSidecar.verificationStatus,
      executionGate: priorSidecar.executionGate
    }, 'PHASE2_PRIOR_VERIFIER_SIDECAR_DRIFT');
} catch (error) { check('FROZEN_ARCHIVE_BYTES_PRESERVED', false, error.message, 'ARCHIVE_IDENTITY_INVALID'); }

const verifyArtifactSelfHash = (relative, field) => {
  const result = readJson(relative);
  const observed = result[field];
  const body = Object.fromEntries(Object.entries(result).filter(([key]) => key !== field));
  const expected = hashCanonical(body);
  return { result, expected, observed, valid: expected === observed };
};

let shadowArtifact = null, benchmarkArtifact = null;
try {
  const checkResult = verifyArtifactSelfHash('runs/phase3-shadow-result.json', 'artifactSha256');
  shadowArtifact = checkResult.result;
  const r = shadowArtifact.result;
  const gatesClosed = shadowArtifact.execution?.enabled === false && shadowArtifact.execution?.authorized === false && shadowArtifact.execution?.dispatched === false &&
    shadowArtifact.gates?.executionAuthorized === false && shadowArtifact.gates?.dispatchAllowed === false && r.search?.executionAuthorized === false && r.search?.exhaustive === false &&
    [...r.candidates, ...r.bestPartialCandidates].every(candidate => candidate.verification?.verified === false && candidate.execution?.authorized === false && candidate.execution?.dispatched === false);
  check('PHASE3_SHADOW_ARTIFACT_SELF_HASH', checkResult.valid, { expected: checkResult.expected, observed: checkResult.observed }, 'SHADOW_RESULT_HASH_MISMATCH');
  check('PHASE3_SHADOW_GATE_CLOSURE', gatesClosed, { status: r.status, candidates: r.candidates.length, executionAuthorized: r.search?.executionAuthorized });
} catch (error) { check('PHASE3_SHADOW_ARTIFACT_VALID', false, error.message); }

try {
  const checkResult = verifyArtifactSelfHash('runs/phase3-paired-benchmark.json', 'artifactSha256');
  benchmarkArtifact = checkResult.result;
  const b = benchmarkArtifact;
  const pairsCorrect = Array.isArray(b.cases) && b.cases.length === b.corpusAssessment.caseCount &&
    b.cases.every(item => Array.isArray(item.trials) && item.trials.length === b.pairedConfig.seeds.length &&
      item.trials.every((trial, index) => trial.seed === b.pairedConfig.seeds[index] && Number.isFinite(trial.phase2Beam.expansions) && Number.isFinite(trial.phase3MCTS.workUnits)));
  const outcomeTotals = b.metrics.mixedOutcomePairedOutcomes.bothSuccess + b.metrics.mixedOutcomePairedOutcomes.mctsOnly +
    b.metrics.mixedOutcomePairedOutcomes.beamOnly + b.metrics.mixedOutcomePairedOutcomes.bothFail;
  const goalPath = b.metrics.goalPathOnly;
  const noSolution = b.metrics.noSolutionProofs;
  const stratifiedOutcomesValid = goalPath.caseCount === b.corpusAssessment.outcomeClassCounts.goalPath &&
    noSolution.caseCount === b.corpusAssessment.outcomeClassCounts.noSolution &&
    goalPath.pairedTrialCount === goalPath.caseCount * b.pairedConfig.seeds.length &&
    noSolution.pairedTrialCount === noSolution.caseCount * b.pairedConfig.seeds.length &&
    goalPath.pairedOutcomes.bothSuccess + goalPath.pairedOutcomes.mctsOnly + goalPath.pairedOutcomes.beamOnly + goalPath.pairedOutcomes.bothFail === goalPath.pairedTrialCount &&
    noSolution.phase3MCTSCanClaimNoSolutionProofByContract === false &&
    (noSolution.phase2BeamExhaustiveProofRate === null || (noSolution.phase2BeamExhaustiveProofRate >= 0 && noSolution.phase2BeamExhaustiveProofRate <= 1)) &&
    (noSolution.phase3MCTSExhaustiveProofRate === null || noSolution.phase3MCTSExhaustiveProofRate === 0);
  const gatesClosed = b.execution?.authorized === false && b.gates?.executionAuthorized === false && b.acceptance === 'offline_shadow_not_acceptance';
  check('PHASE3_BENCHMARK_ARTIFACT_SELF_HASH', checkResult.valid, { expected: checkResult.expected, observed: checkResult.observed }, 'BENCHMARK_HASH_MISMATCH');
  check('PHASE3_BENCHMARK_PAIRED_TRIAL_CONTRACT', pairsCorrect && outcomeTotals === b.metrics.pairedTrialCount, {
    tasks: b.corpusAssessment.caseCount, seeds: b.pairedConfig.seeds, pairedTrials: b.metrics.pairedTrialCount,
    outcomeTotals, expectedTrials: b.metrics.pairedTrialCount
  }, 'BENCHMARK_PAIRED_METRICS_INVALID');
  check('PHASE3_BENCHMARK_OUTCOME_STRATIFICATION', stratifiedOutcomesValid, {
    goalPathOnly: goalPath, noSolutionProofs: noSolution,
    mixedOutcomeDeltaInterpretation: b.metrics.pairedComparisonInterpretation
  }, 'BENCHMARK_OUTCOME_STRATIFICATION_INVALID');
  check('PHASE3_BENCHMARK_PROVENANCE_LIMITS', b.corpusProvenance.kind === 'synthetic' &&
    b.corpusProvenance.independentAttestationPresent === false && b.corpusProvenance.trustedOwnerSignaturePresent === false &&
    b.corpusAssessment.qualityFlags.length > 0, { kind: b.corpusProvenance.kind, qualityFlags: b.corpusAssessment.qualityFlags }, 'BENCHMARK_PROVENANCE_OVERCLAIM');
  check('PHASE3_BENCHMARK_GATE_CLOSURE', gatesClosed, { status: b.status, acceptance: b.acceptance, execution: b.execution, gates: b.gates });
} catch (error) { check('PHASE3_BENCHMARK_ARTIFACT_VALID', false, error.message); }

try {
  const small = readJson('runs/phase2-five-case-diagnostic.json');
  check('SMALL_CORPUS_LIMITATION_EXPLICIT', small.corpusAssessment?.caseCount === 5 &&
    small.corpusAssessment?.qualityFlags?.includes('CORPUS_TOO_SMALL_LT_20_TASKS') && small.acceptance === 'offline_shadow_not_acceptance', {
      caseCount: small.corpusAssessment?.caseCount, qualityFlags: small.corpusAssessment?.qualityFlags, acceptance: small.acceptance
    }, 'SMALL_CORPUS_OVERCLAIM');
} catch (error) { check('SMALL_CORPUS_LIMITATION_EXPLICIT', false, error.message); }

try {
  const ledger = readJson('validation/command-ledger.json');
  const badLogs = [];
  for (const command of ledger.commands) {
    for (const item of [['stdout', command.stdout], ['stderr', command.stderr]]) {
      if (!item[1]?.path || !/^[a-f0-9]{64}$/.test(item[1].sha256)) { badLogs.push({ label: command.label, stream: item[0], reason: 'bad_log_record' }); continue; }
      try {
        const full = path.resolve(pack, item[1].path);
        if (!full.startsWith(`${pack}${path.sep}`)) throw new Error('path escapes pack');
        const bytes = readBytes(full, 128 * 1024 * 1024, item[1].path);
        if (hash(bytes) !== item[1].sha256 || bytes.length !== item[1].sizeBytes) badLogs.push({ label: command.label, stream: item[0], reason: 'log_hash_or_size_mismatch' });
      } catch (error) { badLogs.push({ label: command.label, stream: item[0], reason: error.message }); }
    }
  }
  check('ACTUAL_COMMAND_LOGS_BINDING', badLogs.length === 0, { commandCount: ledger.commands.length, streamCount: ledger.commands.length * 2, issues: badLogs.slice(0, 30) }, 'COMMAND_LOG_INTEGRITY');
} catch (error) { check('ACTUAL_COMMAND_LOGS_BINDING', false, error.message, 'COMMAND_LEDGER_INVALID'); }

try {
  const results = readJson('validation/validation-results.json');
  const linked = results.commands.map(item => ({ label: item.label, exitCode: item.exitCode, classification: item.classification }));
  check('VALIDATION_RESULTS_BOUND', Array.isArray(results.commands) && results.commands.every(item => Number.isInteger(item.exitCode) || item.exitCode === null), {
    overallStatus: results.overallStatus, commandResults: linked
  }, 'VALIDATION_RESULTS_INVALID');
} catch (error) { check('VALIDATION_RESULTS_BOUND', false, error.message, 'VALIDATION_RESULTS_INVALID'); }

// Independent replay of the exact runner artefact from packed input bytes.
let runnerReplay = { status: 'NOT_RUN' };
try {
  const config = readJson('validation/phase3-run-config.json');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-phase3-evidence-runner-replay-'));
  try {
    const replayOut = path.join(tmp, 'replay.json');
    const argv = [path.join(repoRoot, 'scripts/run-agg-phase3-mcts-shadow.mjs'),
      '--graph', path.join(pack, 'inputs/graph.json'), '--dataset', path.join(pack, 'inputs/dataset.json'),
      '--model', path.join(pack, 'inputs/model.json'), '--output', replayOut,
      '--simulations', String(config.options.maxSimulations), '--max-depth', String(config.options.maxDepth),
      '--max-expansions', String(config.options.maxExpansions), '--max-work-units', String(config.options.maxWorkUnits),
      '--max-audit-events', String(config.options.maxAuditEvents), '--candidate-limit', String(config.options.candidateLimit),
      '--max-tree-nodes', String(config.options.maxTreeNodes), '--max-terminal-paths', String(config.options.maxTerminalPaths),
      '--exploration-constant', String(config.options.explorationConstant), '--seed', String(config.options.seed)];
    if (config.options.initiallyAvailableIds?.length) argv.push('--initially-available-ids', config.options.initiallyAvailableIds.join(','));
    const child = spawnSync(process.execPath, argv, { cwd: repoRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, AGG_PHASE3_MCTS_TOOL_ENABLED: '' } });
    if (child.status !== 0) throw new Error(`runner replay exited ${child.status}: ${child.stderr || child.stdout}`);
    const stored = readJson('runs/phase3-shadow-result.json');
    const replayed = parseStrictJson(fs.readFileSync(replayOut), 'replayed Phase3 runner result');
    const equal = canonicalJson(stored) === canonicalJson(replayed);
    runnerReplay = { status: equal ? 'PASS' : 'MISMATCH', storedArtifactSha256: stored.artifactSha256, replayedArtifactSha256: replayed.artifactSha256 };
    check('INDEPENDENT_RUNNER_REPLAY', equal, runnerReplay, 'RUNNER_REPLAY_MISMATCH');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
} catch (error) { runnerReplay = { status: 'FAIL', detail: error.message }; check('INDEPENDENT_RUNNER_REPLAY', false, runnerReplay, 'RUNNER_REPLAY_FAILED'); }

// Independent deterministic replay of paired search decisions; wall-time fields vary naturally.
let benchmarkReplay = { status: 'NOT_RUN' };
try {
  const config = readJson('validation/phase3-benchmark-config.json');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-phase3-evidence-benchmark-replay-'));
  try {
    const replayOut = path.join(tmp, 'replay-benchmark.json');
    const argv = [path.join(repoRoot, 'scripts/benchmark-agg-phase3-mcts-vs-beam.mjs'),
      '--corpus', path.join(pack, 'inputs/phase3-adversarial-corpus.json'), '--dataset', path.join(pack, 'inputs/dataset.json'),
      '--model', path.join(pack, 'inputs/model.json'), '--output', replayOut,
      '--beam-width', String(config.options.beamWidth), '--simulations', String(config.options.maxSimulations),
      '--seeds', config.options.seeds.join(','), '--max-depth', String(config.options.maxDepth),
      '--max-expansions', String(config.options.maxExpansions), '--max-work-units', String(config.options.maxWorkUnits),
      '--max-audit-events', String(config.options.maxAuditEvents), '--max-tree-nodes', String(config.options.maxTreeNodes),
      '--max-terminal-paths', String(config.options.maxTerminalPaths)];
    const child = spawnSync(process.execPath, argv, { cwd: repoRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, AGG_PHASE3_MCTS_TOOL_ENABLED: '' } });
    if (child.status !== 0) throw new Error(`benchmark replay exited ${child.status}: ${child.stderr || child.stdout}`);
    const stored = readJson('runs/phase3-paired-benchmark.json');
    const replayed = parseStrictJson(fs.readFileSync(replayOut), 'replayed Phase3 benchmark');
    const stripObservedTime = value => {
      if (Array.isArray(value)) return value.map(stripObservedTime);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'artifactSha256' && key !== 'durationMs' &&
        key !== 'runtimeMs' && !key.endsWith('RuntimeMs') && key !== 'meanRuntimeMs')
        .map(([key, item]) => [key, stripObservedTime(item)]));
    };
    const equal = canonicalJson(stripObservedTime(stored)) === canonicalJson(stripObservedTime(replayed));
    benchmarkReplay = { status: equal ? 'PASS' : 'MISMATCH', storedArtifactSha256: stored.artifactSha256,
      replayedArtifactSha256: replayed.artifactSha256, comparedFields: 'all except observed wall-time/duration/self-hash fields' };
    check('INDEPENDENT_PAIRED_BENCHMARK_REPLAY', equal, benchmarkReplay, 'BENCHMARK_REPLAY_MISMATCH');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
} catch (error) { benchmarkReplay = { status: 'FAIL', detail: error.message }; check('INDEPENDENT_PAIRED_BENCHMARK_REPLAY', false, benchmarkReplay, 'BENCHMARK_REPLAY_FAILED'); }

// Independent anchor trust check. A CLI-provided digest alone never establishes trust.
let anchor = { expectedManifestSha256Provided: expectedManifestSha256 !== undefined,
  detachedSignatureProvided: anchorSignatureBase64 !== undefined, trustedPublicKeyProvisioned: false,
  signatureVerified: false, trusted: false, publicKeySha256: null, error: null };
const trustedPublicKeyPem = process.env.AGG_PHASE3_TRUSTED_ANCHOR_PUBLIC_KEY_PEM;
if (trustedPublicKeyPem) {
  anchor.trustedPublicKeyProvisioned = true;
  try {
    const cryptoKey = await import('node:crypto');
    const publicKey = cryptoKey.createPublicKey(trustedPublicKeyPem);
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error(`expected Ed25519, observed ${publicKey.asymmetricKeyType}`);
    anchor.publicKeySha256 = hash(publicKey.export({ format: 'der', type: 'spki' }));
    if (anchorSignatureBase64 && expectedManifestSha256) {
      anchor.signatureVerified = verifySignature(null,
        Buffer.from(`agg-phase3-manifest-sha256:v1:${expectedManifestSha256}`, 'utf8'), publicKey, Buffer.from(anchorSignatureBase64, 'base64'));
    }
    anchor.trusted = expectedManifestSha256 === manifestSha256 && anchor.signatureVerified;
  } catch (error) { anchor.error = error.message; }
}
anchor.trusted = anchor.trusted === true && expectedManifestSha256 === manifestSha256;
if (!anchor.trusted) blockers.push({ id: 'EXPECTED_MANIFEST_ANCHOR', details: !anchor.trustedPublicKeyProvisioned
  ? 'AGG_PHASE3_TRUSTED_ANCHOR_PUBLIC_KEY_PEM is not provisioned out-of-band; a locally computed SHA256SUMS hash is not a trust anchor.'
  : expectedManifestSha256 !== manifestSha256 ? 'Supplied expected manifest digest does not match the pack.'
    : !anchorSignatureBase64 ? 'No owner/authority-supplied detached Ed25519 signature was provided.'
      : anchor.error || 'Detached Ed25519 signature did not verify against the out-of-band public root.' });

try {
  authorityPrerequisites = readJson('authority-prerequisites.json');
  const prerequisites = authorityPrerequisites.requirements;
  const unmet = prerequisites.filter(item => item.status !== 'SATISFIED');
  check('SEVEN_AUTHORITY_PREREQUISITES_RECORDED', prerequisites.length === 7 && unmet.length === 7,
    { total: prerequisites.length, satisfied: 7 - unmet.length, unmet }, 'AUTHORITY_PREREQUISITE_INVENTORY_INVALID');
  for (const item of unmet) blockers.push({ id: item.id, details: item.blocker });
} catch (error) { check('SEVEN_AUTHORITY_PREREQUISITES_RECORDED', false, error.message, 'AUTHORITY_PREREQUISITE_INVENTORY_MISSING'); }

let sidecarAssessment = { required: flags.has('--require-sidecars'), status: 'NOT_REQUIRED', paths: [] };
if (flags.has('--require-sidecars')) {
  try {
    const finalVerificationPath = `${pack}-pack-verification-final.json`;
    const driftPath = `${pack}-final-source-drift-check.json`;
    for (const item of [finalVerificationPath, driftPath]) {
      const stat = fs.lstatSync(item);
      if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(item) !== item) throw new Error(`required sidecar is not a canonical regular file: ${item}`);
    }
    const finalVerification = parseStrictJson(readStableRegularFile(finalVerificationPath, { maxBytes: 16 * 1024 * 1024, label: 'final verifier sidecar' }), 'final verifier sidecar');
    const drift = parseStrictJson(readStableRegularFile(driftPath, { maxBytes: 16 * 1024 * 1024, label: 'final source drift receipt' }), 'final source drift receipt');
    const sameManifest = finalVerification.manifestSha256 === manifestSha256 && drift.manifestSha256 === manifestSha256;
    const safeStatus = finalVerification.integrityStatus === 'PASS' && finalVerification.verificationStatus === 'BLOCKED' && finalVerification.executionGate === 'CLOSED' &&
      drift.status === 'PASS_SOURCE_SNAPSHOT_MATCH' && drift.executionGate === 'CLOSED';
    sidecarAssessment = {
      required: true, status: sameManifest && safeStatus ? 'PASS_SIDEcars_REPLAYED' : 'SIDEcars_INVALID',
      paths: [
        { path: path.relative(path.dirname(pack), finalVerificationPath), sha256: hash(readStableRegularFile(finalVerificationPath, { maxBytes: 16 * 1024 * 1024, label: 'final verifier sidecar' })) },
        { path: path.relative(path.dirname(pack), driftPath), sha256: hash(readStableRegularFile(driftPath, { maxBytes: 16 * 1024 * 1024, label: 'final source drift receipt' })) }
      ], sameManifest, safeStatus
    };
    check('DERIVED_SIDECARS_VALID', sameManifest && safeStatus, sidecarAssessment, 'DERIVED_SIDECAR_INVALID');
  } catch (error) {
    sidecarAssessment = { required: true, status: 'SIDEcars_MISSING_OR_INVALID', detail: error.message };
    check('DERIVED_SIDECARS_VALID', false, sidecarAssessment, 'DERIVED_SIDECAR_INVALID');
  }
}

const integrityChecks = checkRows.filter(row => !['EXPECTED_MANIFEST_ANCHOR'].includes(row.id));
const integrityStatus = integrityChecks.every(row => row.status === 'PASS') ? 'PASS' : 'FAIL';
const verificationStatus = blockers.length === 0 ? 'VERIFIED' : 'BLOCKED';
const report = {
  schemaVersion: 1, kind: 'agg_phase3_evidence_pack_verification',
  pack: path.relative(repoRoot, pack), manifestSha256,
  manifestEntryCount: manifestEntries.length, inventoryCount: inventoryPaths.length,
  integrityStatus, verificationStatus, status: verificationStatus,
  checksPassed: checkRows.filter(row => row.status === 'PASS').length,
  checksFailed: checkRows.filter(row => row.status === 'FAIL').length,
  checks: checkRows, blockers, anchor, independentReplays: { runner: runnerReplay, pairedBenchmark: benchmarkReplay },
  sidecarAssessment,
  provenance: {
    gitHead: packMetadata?.gitHead ?? null,
    phase3RunnerArtifactSha256: shadowArtifact?.artifactSha256 ?? null,
    phase3BenchmarkArtifactSha256: benchmarkArtifact?.artifactSha256 ?? null,
    syntheticCorpus: benchmarkArtifact?.corpusProvenance?.kind === 'synthetic',
    ownerCorpusSignaturePresent: false, independentEvaluatorAttestationPresent: false,
    trustedModelAttestationPresent: benchmarkArtifact?.modelIdentityAssessment?.modelTrustRootProvisioned ?? false
  },
  acceptanceStatus: 'PARTIAL_NOT_ACCEPTED', readiness: 'BLOCKED', executionGate: 'CLOSED',
  gateConsumptionEvidencePresent: false, ownerApprovalPresent: false,
  note: 'Pack inventory/source/artifact checks and deterministic replay are integrity evidence only. Without an out-of-band trusted Ed25519 root, owner-signed corpus, operational paired runs, independent signed evaluator, exact-byte authorization, production isolation attestation, durable gate-consumption evidence and owner approval, this report must remain BLOCKED.'
};
writeFileExclusiveAtomic(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ outputPath, pack: report.pack, manifestSha256, integrityStatus, verificationStatus,
  checksPassed: report.checksPassed, checksFailed: report.checksFailed, blockerCount: blockers.length,
  acceptanceStatus: report.acceptanceStatus, readiness: report.readiness, executionGate: report.executionGate }, null, 2));
if (integrityStatus !== 'PASS' || verificationStatus !== 'VERIFIED') process.exitCode = 2;
