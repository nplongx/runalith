#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseStrictJson } from '../src/runtime/strict-json.js';
import { readStableRegularFile, writeFileExclusiveAtomic } from '../src/runtime/exclusive-file.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2), values = new Map();
const allowed = ['--dataset', '--corpus', '--graph', '--output-dir', '--beam-width', '--max-depth', '--max-expansions', '--max-audit-events', '--learning-rate', '--epochs', '--l2', '--seed', '--defer-manifest'];
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (key === '--help') { console.log('Usage: node scripts/run-agg-phase2-workflow.mjs --dataset DATASET.json --corpus CORPUS.json --graph GRAPH.json --output-dir NEW_DIRECTORY [--beam-width N] [--max-depth N] [--max-expansions N] [--max-audit-events N] [--learning-rate N] [--epochs N] [--l2 N] [--seed N] [--defer-manifest]\n\nRuns train → independent holdout evaluation → paired Phase 1/Phase 2 benchmark → shadow search → independent replay verifier. All outputs are new files in a new directory. --defer-manifest is for controlled evidence finalization: it leaves the pack unpublished until the caller adds final receipts and publishes the manifest exclusively. Synthetic data is technical testing only.'); process.exit(0); }
  if (key === '--defer-manifest') {
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}`);
    values.set(key, true);
    continue;
  }
  if (!allowed.includes(key)) throw new Error(`Unknown argument: ${key}`);
  if (values.has(key)) throw new Error(`Duplicate argument: ${key}`);
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
  values.set(key, args[++i]);
}
for (const key of ['--dataset', '--corpus', '--graph', '--output-dir']) if (!values.has(key)) throw new Error(`Required argument missing: ${key}`);
const integerOption = (key, fallback, min, max) => {
  const value = values.has(key) ? Number(values.get(key)) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer in [${min}, ${max}]`);
  return value;
};
const numericOption = (key, fallback, min, max, inclusiveMin = true) => {
  const value = values.has(key) ? Number(values.get(key)) : fallback;
  if (!Number.isFinite(value) || (inclusiveMin ? value < min : value <= min) || value > max) throw new Error(`${key} is outside its allowed numeric range`);
  return value;
};
const config = {
  beamWidth: integerOption('--beam-width', 4, 1, 100), maxDepth: integerOption('--max-depth', 12, 1, 100),
  maxExpansions: integerOption('--max-expansions', 128, 1, 10000), maxAuditEvents: integerOption('--max-audit-events', 2000, 1, 5000),
  learningRate: numericOption('--learning-rate', 0.15, 0, 1, false), epochs: integerOption('--epochs', 1500, 1, 100000),
  l2: numericOption('--l2', 0.01, 0, 10), seed: integerOption('--seed', 0, 0, Number.MAX_SAFE_INTEGER)
};
const deferManifest = values.get('--defer-manifest') === true;
const inputPaths = Object.fromEntries(['--dataset', '--corpus', '--graph'].map(key => [key, path.resolve(values.get(key))]));
const inputSourceBytes = new Map(Object.entries(inputPaths).map(([key, filePath]) =>
  [key, readStableRegularFile(filePath, { maxBytes: 16 * 1024 * 1024, label: key })]));
const outputDir = path.resolve(values.get('--output-dir'));
if (fs.existsSync(outputDir)) throw new Error(`Output directory already exists; refusing overwrite: ${outputDir}`);
const parent = path.dirname(outputDir);
const parentStat = fs.lstatSync(parent);
if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || fs.realpathSync(parent) !== parent) throw new Error('Output parent must be an existing canonical non-symlink directory');
const gitHeadBeforePack = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout?.trim() ?? null;
const trackedPatch = spawnSync('git', ['diff', '--binary', 'HEAD'], { cwd: repoRoot, encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 }).stdout ?? Buffer.alloc(0);
const statusRaw = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout ?? '';
// Git may enumerate untracked siblings in a different order when a verifier
// report is published. Hash a canonical sorted line set, not incidental order.
const statusLines = statusRaw.split('\n').filter(Boolean).sort();
const status = statusLines.length ? `${statusLines.join('\n')}\n` : '';
fs.mkdirSync(outputDir, { mode: 0o700 });
fs.mkdirSync(path.join(outputDir, 'logs'), { mode: 0o700 });
fs.mkdirSync(path.join(outputDir, 'inputs'), { mode: 0o700 });
fs.mkdirSync(path.join(outputDir, 'validation-logs'), { mode: 0o700 });
const inputIdentity = {};
const packedInputs = {};
for (const [key, sourcePath] of Object.entries(inputPaths)) {
  const name = key === '--dataset' ? 'dataset.json' : key === '--corpus' ? 'benchmark-corpus.json' : 'graph.json';
  const filePath = path.join(outputDir, 'inputs', name);
  const originalBytes = inputSourceBytes.get(key);
  fs.writeFileSync(filePath, originalBytes, { flag: 'wx', mode: 0o600 });
  const bytes = fs.readFileSync(filePath);
  if (hash(bytes) !== hash(originalBytes)) throw new Error(`Input changed while snapshotting: ${sourcePath}`);
  packedInputs[key] = filePath;
  inputIdentity[key] = { sourcePath: path.relative(repoRoot, sourcePath), path: path.relative(outputDir, filePath), sha256: hash(bytes), sizeBytes: bytes.length };
}
const ledger = [];
function run(label, script, scriptArgs, expectedExitCode = 0) {
  const argv = [process.execPath, path.join(repoRoot, script), ...scriptArgs];
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, [path.join(repoRoot, script), ...scriptArgs], {
    cwd: repoRoot, encoding: 'buffer', timeout: 120000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, TZ: 'UTC' }
  });
  const stdout = result.stdout ?? Buffer.alloc(0), stderr = result.stderr ?? Buffer.alloc(0);
  const stem = `${String(ledger.length + 1).padStart(2, '0')}-${label}`;
  const stdoutPath = path.join(outputDir, 'logs', `${stem}.stdout.log`);
  const stderrPath = path.join(outputDir, 'logs', `${stem}.stderr.log`);
  fs.writeFileSync(stdoutPath, stdout, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(stderrPath, stderr, { flag: 'wx', mode: 0o600 });
  const record = {
    label, argv, cwd: repoRoot, nodeVersion: process.version, startedAt, endedAt: new Date().toISOString(),
    exitCode: result.status, expectedExitCode, expectedFailure: expectedExitCode !== 0 && result.status === expectedExitCode,
    signal: result.signal ?? null, error: result.error ? String(result.error.message) : null,
    stdout: { path: path.relative(outputDir, stdoutPath), sizeBytes: stdout.length, sha256: hash(stdout) },
    stderr: { path: path.relative(outputDir, stderrPath), sizeBytes: stderr.length, sha256: hash(stderr) }
  };
  ledger.push(record);
  fs.writeFileSync(path.join(outputDir, 'command-ledger.json'), `${JSON.stringify({ schemaVersion: 1, status: 'in_progress', commands: ledger }, null, 2)}\n`, { flag: fs.existsSync(path.join(outputDir, 'command-ledger.json')) ? 'w' : 'wx', mode: 0o600 });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== expectedExitCode) throw new Error(`${label} exited ${result.status ?? 'without an exit code'}; expected ${expectedExitCode}; see ${path.relative(repoRoot, stderrPath)} and ${path.relative(repoRoot, stdoutPath)}`);
}

const files = {
  model: path.join(outputDir, 'model.json'), evaluation: path.join(outputDir, 'holdout-evaluation.json'),
  benchmark: path.join(outputDir, 'paired-benchmark.json'), shadow: path.join(outputDir, 'shadow-search.json'), verification: path.join(outputDir, 'verification.json')
};
let workflowError = null;
try {
  run('train', 'scripts/train-agg-phase2-discriminator.mjs', ['--input', packedInputs['--dataset'], '--output', files.model, '--learning-rate', String(config.learningRate), '--epochs', String(config.epochs), '--l2', String(config.l2), '--seed', String(config.seed)]);
  run('holdout-evaluation', 'scripts/evaluate-agg-phase2-discriminator.mjs', ['--dataset', packedInputs['--dataset'], '--model', files.model, '--output', files.evaluation]);
  run('paired-benchmark', 'scripts/benchmark-agg-phase2-paired.mjs', ['--corpus', packedInputs['--corpus'], '--model', files.model, '--output', files.benchmark, '--beam-width', String(config.beamWidth), '--max-depth', String(config.maxDepth), '--max-expansions', String(config.maxExpansions), '--max-audit-events', String(config.maxAuditEvents)]);
  run('shadow-search', 'scripts/run-agg-phase2-shadow-search.mjs', ['--graph', packedInputs['--graph'], '--model', files.model, '--output', files.shadow, '--beam-width', String(config.beamWidth), '--max-depth', String(config.maxDepth), '--max-expansions', String(config.maxExpansions), '--max-audit-events', String(config.maxAuditEvents)]);
  run('independent-verifier', 'scripts/verify-agg-phase2-workflow.mjs', [
    '--dataset', packedInputs['--dataset'], '--model', files.model, '--evaluation', files.evaluation,
    '--graph', packedInputs['--graph'], '--shadow-result', files.shadow, '--corpus', packedInputs['--corpus'], '--benchmark', files.benchmark,
    '--output', files.verification
  ]);
  run('phase1-current-readiness', 'benchmarks/plugin-workflow-benchmark/phase1-protocol-runner.mjs', ['readiness', '--output', path.join(outputDir, 'validation-logs/current-readiness.json')]);
  run('development-candidate-source-alignment', 'scripts/verify-mcpb-source-alignment.mjs', [
    '--bundle', path.join(repoRoot, 'artifacts/agg-phase1-hardening-20261023T143802Z-deep-verification/runalith-1.0.9-rc.5-agg-phase1-hardened.mcpb'),
    '--source-root', repoRoot, '--output', path.join(outputDir, 'validation-logs/development-candidate-alignment.json')
  ]);
  run('configured-target-source-alignment', 'scripts/verify-mcpb-source-alignment.mjs', [
    '--bundle', path.join(repoRoot, 'artifacts/runalith-1.0.9-rc.5-candidate-latest-build-20261022T175328+0700.mcpb'),
    '--source-root', repoRoot, '--output', path.join(outputDir, 'validation-logs/configured-target-alignment.json')
  ], 1);
} catch (error) { workflowError = error; }

for (const label of ['phase1-current-readiness', 'development-candidate-source-alignment', 'configured-target-source-alignment']) {
  const command = ledger.find(item => item.label === label);
  if (!command) continue;
  const stdout = fs.readFileSync(path.join(outputDir, command.stdout.path));
  const stderr = fs.readFileSync(path.join(outputDir, command.stderr.path));
  const combined = Buffer.concat([stdout, stderr]);
  const logName = label === 'phase1-current-readiness' ? 'current-readiness.log'
    : label === 'development-candidate-source-alignment' ? 'development-candidate-alignment.log' : 'configured-target-alignment.log';
  fs.writeFileSync(path.join(outputDir, 'validation-logs', logName), combined, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(outputDir, 'validation-logs', `${label}.exit-code`), `${command.exitCode}\n`, { flag: 'wx', mode: 0o600 });
}
const validationFiles = [];
function walkValidation(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink in validation logs: ${full}`);
    if (entry.isDirectory()) walkValidation(full);
    else if (entry.isFile()) { const bytes = fs.readFileSync(full); validationFiles.push({ path: path.relative(outputDir, full), sizeBytes: bytes.length, sha256: hash(bytes) }); }
    else throw new Error(`Special file in validation logs: ${full}`);
  }
}
walkValidation(path.join(outputDir, 'validation-logs'));
const validationCommands = ['protocol-phase1', 'phase2-focused', 'full-npm-test', 'docs-check', 'git-diff-check', 'package-source-alignment', 'node-syntax-check']
  .map(label => ({ label, exitCode: null, expectedFailure: false, expectedFailureReason: null, status: 'NOT_RUN_IN_WORKFLOW_SUBPROCESS', externalValidationRequired: true }));
for (const label of ['phase1-current-readiness', 'development-candidate-source-alignment', 'configured-target-source-alignment']) {
  const command = ledger.find(item => item.label === label);
  if (command) validationCommands.push({ label, argv: command.argv, exitCode: command.exitCode, expectedExitCode: command.expectedExitCode, expectedFailure: command.expectedFailure,
    expectedFailureReason: command.expectedFailure ? 'Configured official target is historically source/archive-misaligned; preserve target and approval binding.' : null,
    stdout: command.stdout, stderr: command.stderr });
}
fs.writeFileSync(path.join(outputDir, 'validation-results.json'), `${JSON.stringify({ schemaVersion: 1,
  overallStatus: workflowError ? 'BLOCKED' : 'PASS_INTERNAL_VALIDATION_WITH_EXPECTED_OFFICIAL_TARGET_BLOCKER',
  note: 'Full npm/docs/protocol validation logs are attached during final evidence-pack finalization; this workflow-level record covers readiness and candidate-alignment commands run here.',
  commands: validationCommands, files: validationFiles,
  acceptance: 'PARTIAL_NOT_ACCEPTED', readiness: 'BLOCKED', executionGate: 'CLOSED' }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });

const finalLedger = { schemaVersion: 1, status: workflowError ? 'BLOCKED' : 'COMPLETED', error: workflowError?.message ?? null,
  repoRoot, gitHead: gitHeadBeforePack,
  invocation: [process.execPath, path.join(repoRoot, 'scripts/run-agg-phase2-workflow.mjs'), ...args],
  nodeVersion: process.version, platform: process.platform, architecture: process.arch,
  packageVersion: parseStrictJson(fs.readFileSync(path.join(repoRoot, 'package.json')), 'package.json').version,
  config, inputs: inputIdentity, commands: ledger,
  replayCommand: `node scripts/run-agg-phase2-workflow.mjs --dataset ${JSON.stringify(path.relative(repoRoot, path.join(outputDir, 'inputs/dataset.json')))} --corpus ${JSON.stringify(path.relative(repoRoot, path.join(outputDir, 'inputs/benchmark-corpus.json')))} --graph ${JSON.stringify(path.relative(repoRoot, path.join(outputDir, 'inputs/graph.json')))} --output-dir ${JSON.stringify(`${path.relative(repoRoot, outputDir)}-replay`)} --beam-width ${config.beamWidth} --max-depth ${config.maxDepth} --max-expansions ${config.maxExpansions} --max-audit-events ${config.maxAuditEvents} --learning-rate ${config.learningRate} --epochs ${config.epochs} --l2 ${config.l2} --seed ${config.seed}` };
fs.writeFileSync(path.join(outputDir, 'command-ledger.json'), `${JSON.stringify(finalLedger, null, 2)}\n`, { flag: 'w', mode: 0o600 });
fs.writeFileSync(path.join(outputDir, 'input-identities.json'), `${JSON.stringify(inputIdentity, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
fs.writeFileSync(path.join(outputDir, 'README.md'), `# AGG Phase 2 offline workflow\n\nStatus: **${workflowError ? 'BLOCKED' : 'COMPLETED'}**\n\nThis run is offline/shadow only. It does not authorize execution, alter Phase 1 acceptance, or establish production effectiveness. Synthetic benchmark corpus is technical regression evidence only.\n\n## Replay\n\n\`\`\`sh\n${finalLedger.replayCommand}\n\`\`\`\n\n## State\n\n- Acceptance: \`PARTIAL_NOT_ACCEPTED\`\n- Readiness: \`BLOCKED\`\n- Execution gate: \`CLOSED\`\n- Workflow error: ${workflowError ? workflowError.message.replace(/\n/g, ' ') : 'none'}\n`, { flag: 'wx', mode: 0o600 });
fs.writeFileSync(path.join(outputDir, 'tracked-working-tree.patch'), trackedPatch, { flag: 'wx', mode: 0o600 });
fs.writeFileSync(path.join(outputDir, 'git-status-porcelain.txt'), status, { flag: 'wx', mode: 0o600 });
const sourceNames = [
  'package.json', 'plugin/manifest.json', 'server/index.js', 'scripts/collect-plugin-runtime.mjs', 'scripts/package-runalith-mcpb.sh',
  'scripts/plugin-package-metadata.mjs', 'src/runtime/strict-json.js', 'src/runtime/canonical-json.js', 'src/runtime/exclusive-file.js',
  'src/runtime/adaptive-goal-graph.js', 'src/runtime/adaptive-goal-discriminator.js', 'src/runtime/adaptive-goal-phase2-dataset.js',
  'src/runtime/adaptive-goal-phase2-search.js', 'src/runtime/adaptive-goal-phase2-plan-shadow.js', 'scripts/train-agg-phase2-discriminator.mjs', 'scripts/evaluate-agg-phase2-discriminator.mjs',
  'scripts/benchmark-agg-phase2-paired.mjs', 'scripts/run-agg-phase2-shadow-search.mjs', 'scripts/verify-agg-phase2-workflow.mjs',
  'scripts/run-agg-phase2-workflow.mjs', 'scripts/verify-agg-phase2-evidence-pack.mjs', 'scripts/generate-mcp-reference.mjs', 'scripts/check-docs.mjs', 'scripts/lib/agg-phase2-independent-search-audit.mjs', 'scripts/lib/agg-phase2-evidence-receipts.mjs', 'scripts/verify-agg-phase1-evidence-pack.mjs',
  'scripts/replay-agg-phase1-finalization.mjs', 'scripts/verify-mcpb-source-alignment.mjs', 'benchmarks/plugin-workflow-benchmark/phase1-protocol-runner.mjs',
  'benchmarks/plugin-workflow-benchmark/phase1-latest-build-target-successor-proposal-20261022-v3.json',
  'benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v1.json', 'benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v2.json',
  'tests/test-plugin-workflow-benchmark-phase1-protocol.mjs', 'tests/test-adaptive-goal-discriminator.mjs',
  'tests/test-agg-phase1-evidence-pack-verifier.mjs', 'tests/test-agg-phase1-phase2-package-boundary.mjs', 'tests/test-adaptive-goal-phase2-mcp-tool.mjs',
  'tests/test-phase1-acceptance-protocol-freeze.mjs', 'tests/test-phase1-execution-provenance-contract.mjs',
  'tests/test-phase1-latest-target-compatibility.mjs', 'tests/test-workflow-policies-mcp.js', 'docs/MCP_REFERENCE.md',
  'docs/adaptive-goal-graph.md', 'docs/agg-phase1-benchmark-methodology.md',
  'docs/plugin-workflow-benchmark-plan.md', 'docs/plugin-workflow-benchmark-phase1-freeze.md'
];
for (const name of sourceNames) if (!fs.lstatSync(path.join(repoRoot, name)).isFile()) throw new Error(`Missing source snapshot file: ${name}`);
const untrackedRaw = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repoRoot, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }).stdout ?? Buffer.alloc(0);
const untrackedNames = untrackedRaw.toString('utf8').split('\0').filter(name => name && !name.startsWith('artifacts/') &&
  !name.startsWith('benchmarks/plugin-workflow-benchmark/runs/') && !name.startsWith('benchmarks/plugin-workflow-benchmark/phase2-pilot-') &&
  /\.(?:js|mjs|json|md|sh|yml|yaml|toml)$/.test(name) && !path.resolve(repoRoot, name).startsWith(`${outputDir}${path.sep}`));
const snapshotRoot = path.join(outputDir, 'source-snapshot');
fs.mkdirSync(snapshotRoot, { mode: 0o700 });
for (const name of sourceNames) {
  const destination = path.join(snapshotRoot, name);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(repoRoot, name), destination, fs.constants.COPYFILE_EXCL);
}
const overlay = path.join(outputDir, 'untracked-source-overlay');
fs.mkdirSync(overlay, { mode: 0o700 });
const untrackedOverlayIndex = [];
for (const name of untrackedNames) {
  const stat = fs.lstatSync(path.join(repoRoot, name));
  if (!stat.isFile() || stat.isSymbolicLink()) continue;
  const destination = path.join(overlay, name);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(repoRoot, name), destination, fs.constants.COPYFILE_EXCL);
  const bytes = fs.readFileSync(destination);
  untrackedOverlayIndex.push({ path: name, sizeBytes: bytes.length, sha256: hash(bytes) });
}
fs.writeFileSync(path.join(outputDir, 'untracked-source-overlay-index.json'), `${JSON.stringify(untrackedOverlayIndex.sort((a, b) => a.path.localeCompare(b.path)), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const snapshot = {
  schemaVersion: 1, capturedAt: new Date().toISOString(), gitHead: gitHeadBeforePack,
  workingTreePorcelainSha256: hash(Buffer.from(status)), trackedPatchSha256: hash(trackedPatch), trackedPatchSizeBytes: trackedPatch.length,
  sourceFilesCopied: sourceNames.length, untrackedOverlayFilesCopied: untrackedOverlayIndex.length,
  sourceSnapshotRoot: 'source-snapshot', untrackedOverlayRoot: 'untracked-source-overlay',
  sourceIdentity: Object.fromEntries(sourceNames.map(name => [name, hash(fs.readFileSync(path.join(repoRoot, name)))]))
};
fs.writeFileSync(path.join(outputDir, 'source-snapshot-identity.json'), `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const historicalPackPath = path.join(repoRoot, 'artifacts/agg-phase2-discriminator-20261024T091706+0700-final');
const historicalManifestBytes = fs.readFileSync(path.join(historicalPackPath, 'SHA256SUMS.txt'));
const historicalManifestSha256 = hash(historicalManifestBytes);
const historicalManifestEntries = historicalManifestBytes.toString('utf8').trimEnd().split('\n').map((line, index) => {
  const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
  if (!match) throw new Error(`Historical Phase 2 manifest line ${index + 1} is malformed`);
  const full = path.resolve(repoRoot, match[2]);
  if (!full.startsWith(`${historicalPackPath}${path.sep}`)) throw new Error(`Historical Phase 2 manifest path escapes pack: ${match[2]}`);
  const stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink() || hash(fs.readFileSync(full)) !== match[1]) throw new Error(`Historical Phase 2 manifest entry failed verification: ${match[2]}`);
  return { path: match[2], sha256: match[1] };
});
const historicalSourceLines = fs.readFileSync(path.join(historicalPackPath, 'source-sha256.txt'), 'utf8').trimEnd().split('\n');
const historicalSourceComparisons = historicalSourceLines.map(line => {
  const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
  if (!match) throw new Error('Historical Phase 2 source hash ledger is malformed');
  const full = path.join(repoRoot, match[2]);
  const exists = fs.existsSync(full) && fs.lstatSync(full).isFile() && !fs.lstatSync(full).isSymbolicLink();
  const currentSha256 = exists ? hash(fs.readFileSync(full)) : null;
  return { path: match[2], historicalSha256: match[1], currentSha256, status: currentSha256 === match[1] ? 'MATCH' : exists ? 'SOURCE_CHANGED_SINCE_HISTORICAL_PACK' : 'SOURCE_MISSING' };
});
const historicalInventory = [];
function walkHistorical(directory) { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); if (entry.isDirectory()) walkHistorical(full); else if (entry.isFile()) historicalInventory.push(path.relative(repoRoot, full)); else throw new Error(`Special historical pack entry: ${full}`); } }
walkHistorical(historicalPackPath);
const listedHistoricalPaths = new Set(historicalManifestEntries.map(item => item.path));
const historicalUnlistedFiles = historicalInventory.filter(relative => relative !== path.relative(repoRoot, path.join(historicalPackPath, 'SHA256SUMS.txt')) && !listedHistoricalPaths.has(relative));
const expectedHistoricalExclusions = ['artifacts/agg-phase2-discriminator-20261024T091706+0700-final/checksum-verification.exit-code', 'artifacts/agg-phase2-discriminator-20261024T091706+0700-final/checksum-verification.log'];
const historicalReconciliation = {
  schemaVersion: 1, path: path.relative(repoRoot, historicalPackPath), expectedManifestSha256: 'd9dccedae64bb730c6d95c50668d99645d5140c795c8b5dc2b5622966735a6b1',
  observedManifestSha256: historicalManifestSha256, manifestHashMatchesClaim: historicalManifestSha256 === 'd9dccedae64bb730c6d95c50668d99645d5140c795c8b5dc2b5622966735a6b1',
  listedEntryCount: historicalManifestEntries.length, listedEntriesAllValid: true, actualFileCount: historicalInventory.length,
  expectedExcludedReceiptFiles: expectedHistoricalExclusions,
  unlistedFiles: historicalUnlistedFiles,
  unexpectedUnlistedFiles: historicalUnlistedFiles.filter(relative => !expectedHistoricalExclusions.includes(relative)),
  sourceComparisons: historicalSourceComparisons,
  sourceMatchCount: historicalSourceComparisons.filter(item => item.status === 'MATCH').length,
  sourceChangedCount: historicalSourceComparisons.filter(item => item.status === 'SOURCE_CHANGED_SINCE_HISTORICAL_PACK').length,
  note: 'Historical pack is preserved. Its listed checksums are valid from repository-root paths; source drift here is expected from subsequent Phase 2 hardening and does not rewrite the historical pack.'
};
fs.writeFileSync(path.join(outputDir, 'historical-pack-reconciliation.json'), `${JSON.stringify(historicalReconciliation, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const historicalPackDirectories = fs.readdirSync(path.join(repoRoot, 'artifacts'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name.startsWith('agg-phase') && path.join(repoRoot, 'artifacts', entry.name) !== outputDir)
  .map(entry => ({ name: entry.name, directory: path.join(repoRoot, 'artifacts', entry.name) }))
  .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const historicalPackInventory = historicalPackDirectories.map(({ name, directory }) => {
  const manifestName = ['SHA256SUMS.txt', 'manifest.sha256'].find(candidate => fs.existsSync(path.join(directory, candidate))) ?? null;
  let manifestSha256 = null, manifestEntryCount = 0, validEntryCount = 0, invalidEntries = [];
  if (manifestName) {
    const bytes = fs.readFileSync(path.join(directory, manifestName));
    manifestSha256 = hash(bytes);
    const lines = bytes.toString('utf8').trimEnd().split('\n');
    manifestEntryCount = lines.length;
    for (const [index, line] of lines.entries()) {
      const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
      if (!match) { invalidEntries.push({ line: index + 1, reason: 'malformed_manifest_line' }); continue; }
      const relative = match[2];
      const full = relative.startsWith('artifacts/') ? path.resolve(repoRoot, relative) : path.resolve(directory, relative);
      if (!(full === directory || full.startsWith(`${directory}${path.sep}`))) { invalidEntries.push({ line: index + 1, path: relative, reason: 'path_escapes_pack' }); continue; }
      try {
        const stat = fs.lstatSync(full);
        if (!stat.isFile() || stat.isSymbolicLink() || hash(fs.readFileSync(full)) !== match[1]) {
          invalidEntries.push({ line: index + 1, path: relative, reason: 'missing_nonregular_or_checksum_mismatch' });
        } else validEntryCount++;
      } catch { invalidEntries.push({ line: index + 1, path: relative, reason: 'missing_or_unreadable' }); }
    }
  }
  const actualFiles = [];
  function walkPack(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkPack(full);
      else if (entry.isFile()) actualFiles.push(path.relative(directory, full));
      else actualFiles.push(`${path.relative(directory, full)} [special-or-symlink]`);
    }
  }
  walkPack(directory);
  const listed = new Set();
  if (manifestName) for (const line of fs.readFileSync(path.join(directory, manifestName), 'utf8').trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (match) listed.add(match[2].startsWith('artifacts/') ? path.relative(directory, path.resolve(repoRoot, match[2])) : path.normalize(match[2]));
  }
  const manifestRelative = manifestName;
  const unlistedFiles = actualFiles.filter(relative => relative !== manifestRelative && !listed.has(relative)).sort();
  return { name, directory: path.relative(repoRoot, directory), manifestName, manifestSha256, manifestEntryCount, validEntryCount,
    invalidEntryCount: invalidEntries.length, invalidEntries: invalidEntries.slice(0, 25), actualFileCount: actualFiles.length,
    unlistedFileCount: unlistedFiles.length, unlistedFiles: unlistedFiles.slice(0, 25),
    status: !manifestName ? 'NO_TOP_LEVEL_CHECKSUM_MANIFEST' : invalidEntries.length ? 'CHECKSUM_RECONCILIATION_FAILED' : 'ALL_LISTED_CHECKSUMS_PASS' };
});
fs.writeFileSync(path.join(outputDir, 'historical-pack-inventory.json'), `${JSON.stringify({ schemaVersion: 1, capturedAt: new Date().toISOString(),
  directoryCount: historicalPackInventory.length, manifestPassCount: historicalPackInventory.filter(item => item.status === 'ALL_LISTED_CHECKSUMS_PASS').length,
  noManifestCount: historicalPackInventory.filter(item => item.status === 'NO_TOP_LEVEL_CHECKSUM_MANIFEST').length,
  failedManifestCount: historicalPackInventory.filter(item => item.status === 'CHECKSUM_RECONCILIATION_FAILED').length,
  entries: historicalPackInventory,
  note: 'Historical evidence directories are read-only. A directory without a top-level checksum manifest is inventoried as such, not treated as a verified evidence pack.' }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
// Reconcile every historical checksum manifest, including nested staging and
// source-snapshot manifests that the top-level directory inventory cannot see.
const historicalManifestPaths = [];
function walkManifestFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (full === outputDir || full.startsWith(`${outputDir}${path.sep}`)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Symlink in historical artifact tree: ${full}`);
    if (entry.isDirectory()) walkManifestFiles(full);
    else if (entry.isFile() && ['SHA256SUMS.txt', 'manifest.sha256'].includes(entry.name)) historicalManifestPaths.push(full);
  }
}
walkManifestFiles(path.join(repoRoot, 'artifacts'));
const historicalManifestReplay = historicalManifestPaths.sort().map(manifestFull => {
  const manifestBytes = fs.readFileSync(manifestFull);
  const manifestRoot = path.dirname(manifestFull);
  const lines = manifestBytes.toString('utf8').trimEnd().split('\n');
  const invalidEntries = [], listed = new Set();
  let validEntryCount = 0;
  for (const [index, line] of lines.entries()) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) { invalidEntries.push({ line: index + 1, reason: 'malformed_manifest_line' }); continue; }
    const relative = match[2];
    const full = path.isAbsolute(relative) ? path.resolve(relative) : relative.startsWith('artifacts/') ? path.resolve(repoRoot, relative) : path.resolve(manifestRoot, relative);
    if (!(full === manifestRoot || full.startsWith(`${manifestRoot}${path.sep}`))) { invalidEntries.push({ line: index + 1, path: relative, reason: 'path_escapes_manifest_root' }); continue; }
    listed.add(path.relative(manifestRoot, full));
    try {
      const stat = fs.lstatSync(full);
      if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(full) !== full || hash(fs.readFileSync(full)) !== match[1]) {
        invalidEntries.push({ line: index + 1, path: relative, reason: 'missing_nonregular_or_checksum_mismatch' });
      } else validEntryCount++;
    } catch { invalidEntries.push({ line: index + 1, path: relative, reason: 'missing_or_unreadable' }); }
  }
  const actual = [];
  function walkActual(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { actual.push(`${path.relative(manifestRoot, full)} [symlink]`); continue; }
      if (entry.isDirectory()) walkActual(full);
      else if (entry.isFile() && full !== manifestFull) actual.push(path.relative(manifestRoot, full));
      else if (!entry.isFile()) actual.push(`${path.relative(manifestRoot, full)} [special]`);
    }
  }
  walkActual(manifestRoot);
  const unlistedFiles = actual.filter(relative => !listed.has(relative)).sort();
  return { path: path.relative(repoRoot, manifestFull), sha256: hash(manifestBytes), entryCount: lines.length, validEntryCount,
    invalidEntryCount: invalidEntries.length, invalidEntries: invalidEntries.slice(0, 20), actualFileCount: actual.length,
    unlistedFileCount: unlistedFiles.length, unlistedFiles: unlistedFiles.slice(0, 20),
    status: invalidEntries.length ? 'CHECKSUM_RECONCILIATION_FAILED' : unlistedFiles.length ? 'CHECKSUMS_PASS_WITH_UNLISTED_FILES' : 'ALL_LISTED_CHECKSUMS_PASS' };
});
fs.writeFileSync(path.join(outputDir, 'historical-manifest-replay.json'), `${JSON.stringify({ schemaVersion: 1,
  manifestCount: historicalManifestReplay.length,
  manifestPassCount: historicalManifestReplay.filter(item => item.status !== 'CHECKSUM_RECONCILIATION_FAILED').length,
  manifestFailureCount: historicalManifestReplay.filter(item => item.status === 'CHECKSUM_RECONCILIATION_FAILED').length,
  entries: historicalManifestReplay,
  note: 'All historical SHA256SUMS.txt and manifest.sha256 files under artifacts were replayed read-only; valid manifests do not imply signed provenance or acceptance.' }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const candidateRecords = [
  { role: 'development_candidate', path: 'artifacts/agg-phase1-hardening-20261023T143802Z-deep-verification/runalith-1.0.9-rc.5-agg-phase1-hardened.mcpb', expectedSha256: '7fb5f547eda71a717d10358510e1ea7baee46f5f9bcea3efc2891c6293bd3bc0' },
  { role: 'configured_official_target_candidate_not_release_approved', path: 'artifacts/runalith-1.0.9-rc.5-candidate-latest-build-20261022T175328+0700.mcpb', expectedSha256: '9d836dca9daec26b53a104f99028fb30fd11848e8c0a8764c4eb7dedd45e1c37' }
].map(record => {
  const bytes = fs.readFileSync(path.join(repoRoot, record.path));
  const listing = spawnSync('unzip', ['-Z', '-1', path.join(repoRoot, record.path)], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const manifestRead = spawnSync('unzip', ['-p', path.join(repoRoot, record.path), 'manifest.json'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
  if (listing.status !== 0 || manifestRead.status !== 0) throw new Error(`Unable to inspect candidate archive: ${record.path}`);
  const manifestValue = parseStrictJson(manifestRead.stdout, `${record.role} manifest`);
  return { ...record, observedSha256: hash(bytes), hashMatchesExpected: hash(bytes) === record.expectedSha256, sizeBytes: bytes.length,
    archiveEntryCount: listing.stdout.trimEnd().split('\n').length, manifestSha256: hash(manifestRead.stdout), version: manifestValue.version,
    toolCount: Array.isArray(manifestValue.tools) ? manifestValue.tools.length : null, entryPoint: manifestValue.server?.entry_point,
    releaseApproved: false, approvalBindingChanged: false };
});
fs.writeFileSync(path.join(outputDir, 'candidate-identities.json'), `${JSON.stringify({ schemaVersion: 1, candidates: candidateRecords,
  note: 'Candidate archives were inspected read-only and were not rebuilt, replaced or rebound to approvals.' }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const manifestPath = path.join(outputDir, 'SHA256SUMS.txt');
const allFiles = [];
function walk(directory) { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); if (entry.isSymbolicLink()) throw new Error(`Symlink in evidence pack: ${full}`); if (entry.isDirectory()) walk(full); else if (entry.isFile() && full !== manifestPath) allFiles.push(full); else throw new Error(`Special file in evidence pack: ${full}`); } }
walk(outputDir);
const manifest = allFiles.sort().map(file => `${hash(fs.readFileSync(file))}  ${path.relative(repoRoot, file)}`).join('\n') + '\n';
if (!deferManifest) writeFileExclusiveAtomic(manifestPath, manifest, { mode: 0o600 });
const summary = { outputDir: path.relative(repoRoot, outputDir), status: workflowError ? 'BLOCKED' : deferManifest ? 'WORKFLOW_COMPLETED_MANIFEST_DEFERRED' : 'COMPLETED', error: workflowError?.message ?? null,
  commandCount: ledger.length, manifestSha256: deferManifest ? null : hash(Buffer.from(manifest)), manifestPublication: deferManifest ? 'DEFERRED' : 'EXCLUSIVE_ATOMIC', trackedPatchSha256: snapshot.trackedPatchSha256,
  workflowVerification: fs.existsSync(files.verification) ? JSON.parse(fs.readFileSync(files.verification, 'utf8')).verificationStatus : 'BLOCKED',
  acceptance: 'PARTIAL_NOT_ACCEPTED', readiness: 'BLOCKED', executionGate: 'CLOSED' };
console.log(JSON.stringify(summary, null, 2));
if (workflowError) process.exitCode = 2;
