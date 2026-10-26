#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseStrictJson } from '../src/runtime/strict-json.js';
import { readStableRegularFile, writeFileExclusiveAtomic } from '../src/runtime/exclusive-file.js';
import { independentlyDeriveSearch } from './lib/agg-phase2-independent-search-audit.mjs';
import { expectedPhase2ExternalChecksumPaths, isBoundEvidenceVerifierReceipt, isBoundSourceDriftReceipt } from './lib/agg-phase2-evidence-receipts.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Every evidence/source file is read through one descriptor and checked before
// and after the read. Path-based readFileSync after a separate lstat permits a
// same-user rename/symlink race between the check and the bytes being hashed.
function readStableFile(filePath, encoding) {
  const bytes = readStableRegularFile(filePath, { maxBytes: 256 * 1024 * 1024, label: `Verifier input ${filePath}` });
  return encoding === undefined ? bytes : bytes.toString(encoding);
}
// Deliberately separate reference serialization/scoring for content audit:
// do not import the workflow's canonicalizer or metric implementation here.
function auditCanonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError('independent audit encountered an unsupported number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(auditCanonical).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('independent audit only accepts JSON objects');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${auditCanonical(value[key])}`).join(',')}}`;
}
const auditHashValue = value => hash(Buffer.from(auditCanonical(value)));
const AUDIT_FEATURES = ['successConfidence', 'riskSafety', 'costEfficiency', 'reusePotential', 'informationValue', 'testedHypothesisRatio', 'supportEdgeRatio'];
function auditExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      auditCanonical(Object.keys(value).sort()) !== auditCanonical([...keys].sort())) throw new TypeError(`${label} has missing or unsupported fields`);
}
function auditNormalizeSplit(examples) {
  if (!Array.isArray(examples) || examples.length > 100000) throw new TypeError('independent audit split must be an array within the example bound');
  return examples.map((example, index) => {
    auditExactKeys(example, ['id', 'features', 'label'], `example[${index}]`);
    auditExactKeys(example.features, AUDIT_FEATURES, `example[${index}].features`);
    if (typeof example.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(example.id) ||
        (example.label !== 0 && example.label !== 1) || AUDIT_FEATURES.some(name => typeof example.features[name] !== 'number' ||
          !Number.isFinite(example.features[name]) || Object.is(example.features[name], -0) || example.features[name] < 0 || example.features[name] > 1)) {
      throw new TypeError(`example[${index}] has invalid identity, label, or feature values`);
    }
    return { id: example.id, features: Object.fromEntries(AUDIT_FEATURES.map(name => [name, example.features[name]])), label: example.label };
  })
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
function auditMetrics(model, examples) {
  let correct = 0, tp = 0, tn = 0, fp = 0, fn = 0, logLoss = 0, brier = 0;
  const bins = Array.from({ length: 10 }, (_, bin) => ({ bin, count: 0, meanPredictedProbability: 0, observedPositiveRate: 0 }));
  for (const example of examples) {
    let logit = model.intercept;
    for (const name of AUDIT_FEATURES) logit += model.weights[name] * ((example.features[name] - model.means[name]) / model.scales[name]);
    const raw = logit >= 0 ? 1 / (1 + Math.exp(-Math.min(logit, 709))) : Math.exp(Math.max(logit, -745)) / (1 + Math.exp(Math.max(logit, -745)));
    const probability = Math.max(1e-15, Math.min(1 - 1e-15, raw));
    const predicted = probability >= 0.5 ? 1 : 0;
    if (predicted === example.label) correct++;
    if (predicted && example.label) tp++; else if (!predicted && !example.label) tn++; else if (predicted) fp++; else fn++;
    logLoss -= example.label * Math.log(probability) + (1 - example.label) * Math.log(1 - probability);
    brier += (probability - example.label) ** 2;
    const bin = bins[Math.min(9, Math.floor(probability * 10))];
    bin.count++; bin.meanPredictedProbability += probability; bin.observedPositiveRate += example.label;
  }
  const count = examples.length, positive = tp + fn, negative = tn + fp;
  for (const bin of bins) if (bin.count) { bin.meanPredictedProbability /= bin.count; bin.observedPositiveRate /= bin.count; }
  const accuracy = correct / count, precision = tp + fp ? tp / (tp + fp) : 0, recall = positive ? tp / positive : 0;
  const negativeRecall = negative ? tn / negative : 0, z = 1.959963984540054, denominator = 1 + z * z / count;
  const center = (accuracy + z * z / (2 * count)) / denominator;
  const margin = z * Math.sqrt(accuracy * (1 - accuracy) / count + z * z / (4 * count ** 2)) / denominator;
  return { accuracy, balancedAccuracy: (recall + negativeRecall) / 2, logLoss: logLoss / count, precision, recall,
    f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0, brierScore: brier / count,
    confusionMatrix: { truePositive: tp, trueNegative: tn, falsePositive: fp, falseNegative: fn },
    classBalance: { negative, positive },
    accuracyConfidenceInterval95: { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin), method: 'wilson_score' },
    calibration: bins };
}
function auditTrainModel({ trainingExamples, validationExamples, learningRate, epochs, l2, seed, datasetId }) {
  const training = auditNormalizeSplit(trainingExamples), validation = auditNormalizeSplit(validationExamples);
  if (!Number.isFinite(learningRate) || learningRate <= 0 || learningRate > 1 || !Number.isSafeInteger(epochs) || epochs < 1 || epochs > 100000 ||
      !Number.isFinite(l2) || l2 < 0 || l2 > 10 || !Number.isSafeInteger(seed) || seed < 0 || training.length * epochs > 5_000_000 ||
      training.length < 4 || validation.length < 2 || !training.some(item => item.label === 0) || !training.some(item => item.label === 1) ||
      !validation.some(item => item.label === 0) || !validation.some(item => item.label === 1)) throw new TypeError('independent training input violates config, class, size, or work bounds');
  const ids = new Set(), fingerprints = new Set();
  for (const example of [...training, ...validation]) {
    const fingerprint = auditHashValue(example.features);
    if (ids.has(example.id) || fingerprints.has(fingerprint)) throw new TypeError('independent training rejected split leakage');
    ids.add(example.id); fingerprints.add(fingerprint);
  }
  const means = {}, scales = {}, weights = {};
  let randomState = BigInt(seed); const mask64 = (1n << 64n) - 1n;
  const random = () => {
    randomState = (randomState + 0x9e3779b97f4a7c15n) & mask64;
    let value = randomState;
    value = ((value ^ (value >> 30n)) * 0xbf58476d1ce4e5b9n) & mask64;
    value = ((value ^ (value >> 27n)) * 0x94d049bb133111ebn) & mask64;
    value ^= value >> 31n;
    return Number(value >> 11n) / 9007199254740992;
  };
  for (const name of AUDIT_FEATURES) {
    means[name] = training.reduce((sum, item) => sum + item.features[name], 0) / training.length;
    const variance = training.reduce((sum, item) => sum + (item.features[name] - means[name]) ** 2, 0) / training.length;
    scales[name] = Math.max(Math.sqrt(variance), 1e-6);
    weights[name] = variance < 1e-12 ? 0 : (random() - 0.5) * 2e-8;
  }
  let intercept = 0;
  const sigmoid = value => value >= 0 ? 1 / (1 + Math.exp(-Math.min(value, 709))) : Math.exp(Math.max(value, -745)) / (1 + Math.exp(Math.max(value, -745)));
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradients = Object.fromEntries(AUDIT_FEATURES.map(name => [name, 0])); let interceptGradient = 0;
    for (const example of training) {
      let logit = intercept;
      for (const name of AUDIT_FEATURES) logit += weights[name] * ((example.features[name] - means[name]) / scales[name]);
      const error = sigmoid(logit) - example.label; interceptGradient += error;
      for (const name of AUDIT_FEATURES) gradients[name] += error * ((example.features[name] - means[name]) / scales[name]);
    }
    const rate = learningRate / Math.sqrt(1 + epoch / 100);
    intercept -= rate * interceptGradient / training.length;
    if (!Number.isFinite(intercept) || Math.abs(intercept) > 1e6) throw new TypeError('independent training intercept diverged');
    for (const name of AUDIT_FEATURES) {
      weights[name] -= rate * (gradients[name] / training.length + l2 * weights[name]);
      if (!Number.isFinite(weights[name]) || Math.abs(weights[name]) > 1e6) throw new TypeError(`independent training weight ${name} diverged`);
    }
  }
  const body = { schemaVersion: 2, featureSchemaVersion: 1, modelType: 'standardized-logistic-regression', featureNames: [...AUDIT_FEATURES], datasetId,
    trainingConfig: { learningRate, epochs, l2, seed }, trainingDataSha256: auditHashValue(training), validationDataSha256: auditHashValue(validation),
    means, scales, weights, intercept, trainingExampleCount: training.length,
    trainingClassCounts: { negative: training.filter(item => item.label === 0).length, positive: training.filter(item => item.label === 1).length },
    trainingMetrics: auditMetrics({ intercept, weights, means, scales }, training) };
  return { ...body, modelSha256: auditHashValue(body) };
}
const REQUIRED_SOURCE_FILES = [
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
  'tests/test-phase1-latest-target-compatibility.mjs', 'tests/test-workflow-policies-mcp.js', 'docs/MCP_REFERENCE.md', 'docs/adaptive-goal-graph.md', 'docs/agg-phase1-benchmark-methodology.md',
  'docs/plugin-workflow-benchmark-plan.md', 'docs/plugin-workflow-benchmark-phase1-freeze.md'
];
const args = process.argv.slice(2), values = new Map();
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (key === '--help') { console.log('Usage: node scripts/verify-agg-phase2-evidence-pack.mjs --pack PACK_DIRECTORY --output NEW_REPORT.json [--expected-manifest-sha256 EXPECTED_SHA256 --anchor-signature-base64 SIGNATURE]\n\nThe expected digest must come from a separately trusted channel and its Ed25519 signature must verify using AGG_PHASE2_TRUSTED_ANCHOR_PUBLIC_KEY_PEM provisioned out-of-band. A digest computed from this pack, even when passed on the command line, is not a trust anchor by itself. Without a trusted key and valid detached signature, the report remains BLOCKED.'); process.exit(0); }
  if (!['--pack', '--output', '--expected-manifest-sha256', '--anchor-signature-base64'].includes(key)) throw new Error(`Unknown argument: ${key}`);
  if (values.has(key)) throw new Error(`Duplicate argument: ${key}`);
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
  const value = args[++i];
  values.set(key, ['--expected-manifest-sha256', '--anchor-signature-base64'].includes(key) ? value : path.resolve(value));
}
if (!values.has('--pack') || !values.has('--output')) throw new Error('--pack and --output are required');
const pack = values.get('--pack'), output = values.get('--output');
const expectedManifestHash = values.get('--expected-manifest-sha256');
const anchorSignatureBase64 = values.get('--anchor-signature-base64');
if (expectedManifestHash !== undefined && !/^[a-f0-9]{64}$/.test(expectedManifestHash)) throw new Error('--expected-manifest-sha256 must be 64 lowercase hexadecimal characters');
if (anchorSignatureBase64 !== undefined && (!/^[A-Za-z0-9+/]+={0,2}$/.test(anchorSignatureBase64) || Buffer.from(anchorSignatureBase64, 'base64').toString('base64') !== anchorSignatureBase64)) {
  throw new Error('--anchor-signature-base64 must be canonical base64');
}
const trustedAnchorPem = process.env.AGG_PHASE2_TRUSTED_ANCHOR_PUBLIC_KEY_PEM;
if (!fs.lstatSync(pack).isDirectory() || fs.lstatSync(pack).isSymbolicLink() || fs.realpathSync(pack) !== pack) throw new Error('Pack must be an existing canonical non-symlink directory');
if (output === pack || output.startsWith(`${pack}${path.sep}`) || fs.existsSync(output)) throw new Error('Verifier output must be a new file outside the evidence pack');
const blockers = [], checks = [];
const check = (id, ok, detail) => { checks.push({ id, status: ok ? 'PASS' : 'FAIL', detail }); if (!ok) blockers.push({ id, detail }); };
function walk(directory, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name), stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`symlink rejected: ${path.relative(pack, full)}`);
    if (stat.isDirectory()) walk(full, found);
    else if (stat.isFile()) found.push(path.relative(repoRoot, full));
    else throw new Error(`special file rejected: ${path.relative(pack, full)}`);
  }
  return found;
}
let inventory = [], manifestHash = null;
let anchorSignatureValid = false, anchorKeySha256 = null, anchorSignatureError = null, anchorTrusted = false;
try {
  const manifestPath = path.join(pack, 'SHA256SUMS.txt');
  const manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('SHA256SUMS.txt must be a regular file');
  const manifestBytes = readStableFile(manifestPath);
  manifestHash = hash(manifestBytes);
  const manifestText = manifestBytes.toString('utf8');
  if (trustedAnchorPem && anchorSignatureBase64 && expectedManifestHash !== undefined) {
    try {
      const publicKey = createPublicKey(trustedAnchorPem);
      if (publicKey.asymmetricKeyType !== 'ed25519') throw new TypeError('trusted anchor key must be Ed25519');
      anchorKeySha256 = hash(publicKey.export({ type: 'spki', format: 'der' }));
      const signature = Buffer.from(anchorSignatureBase64, 'base64');
      if (signature.length !== 64) throw new TypeError('Ed25519 signature must be 64 bytes');
      anchorSignatureValid = verifySignature(null, Buffer.from(`agg-phase2-manifest-sha256:v1:${expectedManifestHash}`, 'utf8'), publicKey, signature);
    } catch (error) { anchorSignatureError = error.message; }
  }
  anchorTrusted = expectedManifestHash !== undefined && manifestHash === expectedManifestHash && anchorSignatureValid;
  check('EXPECTED_MANIFEST_ANCHOR', anchorTrusted,
    expectedManifestHash === undefined
      ? 'no separately obtained expected digest was supplied; verification is blocked'
      : !trustedAnchorPem
        ? 'expected digest is not authenticated: AGG_PHASE2_TRUSTED_ANCHOR_PUBLIC_KEY_PEM is not provisioned from an out-of-band trusted root'
        : !anchorSignatureBase64
          ? 'expected digest has no detached Ed25519 anchor signature'
          : anchorSignatureError
            ? `trusted anchor signature could not be verified: ${anchorSignatureError}`
            : !anchorSignatureValid
              ? 'detached Ed25519 signature does not authenticate the expected manifest digest'
              : manifestHash !== expectedManifestHash
                ? 'actual manifest digest does not match the signed expected digest'
                : 'actual manifest digest matches the expected digest and detached Ed25519 signature verified under the externally provisioned trusted key');
  if (!manifestText.endsWith('\n') || manifestText.includes('\r')) throw new Error('manifest must be canonical LF text with a final newline');
  const seen = new Set();
  const manifestLines = manifestText.slice(0, -1).split('\n');
  if (!manifestLines.length || manifestLines.some(line => line.length === 0)) throw new Error('manifest must not contain blank lines or multiple trailing newlines');
  for (const [index, line] of manifestLines.entries()) {
    const match = /^([a-f0-9]{64})  ([^\0]+)$/.exec(line);
    if (!match) throw new Error(`manifest line ${index + 1} is malformed`);
    const relative = match[2];
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw new Error(`unsafe manifest path: ${relative}`);
    if (seen.has(relative)) throw new Error(`duplicate manifest path: ${relative}`);
    seen.add(relative);
    const full = path.resolve(repoRoot, relative);
    if (!(full === pack || full.startsWith(`${pack}${path.sep}`))) throw new Error(`manifest path escapes pack: ${relative}`);
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`manifest entry is not a regular file: ${relative}`);
    const actual = hash(readStableFile(full));
    if (actual !== match[1]) throw new Error(`checksum mismatch: ${relative}`);
    inventory.push({ path: relative, sha256: actual, sizeBytes: stat.size });
  }
  const actualFiles = walk(pack).filter(relative => relative !== path.relative(repoRoot, manifestPath)).sort();
  const expectedFiles = [...seen].sort();
  check('CHECKSUMS_AND_INVENTORY', JSON.stringify(actualFiles) === JSON.stringify(expectedFiles), `manifest entries=${expectedFiles.length}; actual files excluding manifest=${actualFiles.length}; extra/missing files are rejected`);
  const ledgerPath = path.join(pack, 'command-ledger.json');
  const ledger = parseStrictJson(readStableFile(ledgerPath), 'Phase 2 command ledger');
  const exactObjectKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
  const expectedLedgerCommands = new Map([['train', [0]], ['holdout-evaluation', [0]], ['paired-benchmark', [0]], ['shadow-search', [0]],
    ['independent-verifier', [0]], ['phase1-current-readiness', [0]], ['development-candidate-source-alignment', [0, 1]], ['configured-target-source-alignment', [1]]]);
  const expectedLogPaths = new Map([
    ['train', ['logs/01-train.stdout.log', 'logs/01-train.stderr.log']],
    ['holdout-evaluation', ['logs/02-holdout-evaluation.stdout.log', 'logs/02-holdout-evaluation.stderr.log']],
    ['paired-benchmark', ['logs/03-paired-benchmark.stdout.log', 'logs/03-paired-benchmark.stderr.log']],
    ['shadow-search', ['logs/04-shadow-search.stdout.log', 'logs/04-shadow-search.stderr.log']],
    ['independent-verifier', ['logs/05-independent-verifier.stdout.log', 'logs/05-independent-verifier.stderr.log']],
    ['phase1-current-readiness', ['logs/06-phase1-current-readiness.stdout.log', 'logs/06-phase1-current-readiness.stderr.log']],
    ['development-candidate-source-alignment', ['logs/07-development-candidate-source-alignment.stdout.log', 'logs/07-development-candidate-source-alignment.stderr.log']],
    ['configured-target-source-alignment', ['logs/08-configured-target-source-alignment.stdout.log', 'logs/08-configured-target-source-alignment.stderr.log']]
  ]);
  const ledgerLabels = new Set((ledger?.commands ?? []).map(command => command.label));
  const ledgerSchemaValid = exactObjectKeys(ledger, ['schemaVersion', 'status', 'error', 'repoRoot', 'gitHead', 'invocation', 'nodeVersion',
    'platform', 'architecture', 'packageVersion', 'config', 'inputs', 'commands', 'replayCommand']) &&
    Array.isArray(ledger.commands) && ledger.commands.every(command => exactObjectKeys(command, ['label', 'argv', 'cwd', 'nodeVersion', 'startedAt',
      'endedAt', 'exitCode', 'expectedExitCode', 'expectedFailure', 'signal', 'error', 'stdout', 'stderr']) &&
      exactObjectKeys(command.stdout, ['path', 'sizeBytes', 'sha256']) && exactObjectKeys(command.stderr, ['path', 'sizeBytes', 'sha256']));
  const modelForLedger = parseStrictJson(readStableFile(path.join(pack, 'model.json')), 'Phase 2 ledger model artifact');
  const searchForLedger = parseStrictJson(readStableFile(path.join(pack, 'shadow-search.json')), 'Phase 2 ledger search artifact');
  const input = relative => path.join(pack, relative);
  const script = relative => path.join(repoRoot, relative);
  const node = process.execPath;
  const trainConfig = modelForLedger?.model?.trainingConfig;
  const searchConfig = searchForLedger?.result?.search?.options;
  const expectedArgv = new Map([
    ['train', [node, script('scripts/train-agg-phase2-discriminator.mjs'), '--input', input('inputs/dataset.json'), '--output', input('model.json'),
      '--learning-rate', String(trainConfig?.learningRate), '--epochs', String(trainConfig?.epochs), '--l2', String(trainConfig?.l2), '--seed', String(trainConfig?.seed)]],
    ['holdout-evaluation', [node, script('scripts/evaluate-agg-phase2-discriminator.mjs'), '--dataset', input('inputs/dataset.json'), '--model', input('model.json'), '--output', input('holdout-evaluation.json')]],
    ['paired-benchmark', [node, script('scripts/benchmark-agg-phase2-paired.mjs'), '--corpus', input('inputs/benchmark-corpus.json'), '--model', input('model.json'), '--output', input('paired-benchmark.json'),
      '--beam-width', String(searchConfig?.beamWidth), '--max-depth', String(searchConfig?.maxDepth), '--max-expansions', String(searchConfig?.maxExpansions), '--max-audit-events', String(searchConfig?.maxAuditEvents)]],
    ['shadow-search', [node, script('scripts/run-agg-phase2-shadow-search.mjs'), '--graph', input('inputs/graph.json'), '--model', input('model.json'), '--output', input('shadow-search.json'),
      '--beam-width', String(searchConfig?.beamWidth), '--max-depth', String(searchConfig?.maxDepth), '--max-expansions', String(searchConfig?.maxExpansions), '--max-audit-events', String(searchConfig?.maxAuditEvents)]],
    ['independent-verifier', [node, script('scripts/verify-agg-phase2-workflow.mjs'), '--dataset', input('inputs/dataset.json'), '--model', input('model.json'), '--evaluation', input('holdout-evaluation.json'),
      '--graph', input('inputs/graph.json'), '--shadow-result', input('shadow-search.json'), '--corpus', input('inputs/benchmark-corpus.json'), '--benchmark', input('paired-benchmark.json'), '--output', input('verification.json')]],
    ['phase1-current-readiness', [node, script('benchmarks/plugin-workflow-benchmark/phase1-protocol-runner.mjs'), 'readiness', '--output', input('validation-logs/current-readiness.json')]],
    ['development-candidate-source-alignment', [node, script('scripts/verify-mcpb-source-alignment.mjs'), '--bundle', path.join(repoRoot, 'artifacts/agg-phase1-hardening-20261023T143802Z-deep-verification/runalith-1.0.9-rc.5-agg-phase1-hardened.mcpb'), '--source-root', repoRoot, '--output', input('validation-logs/development-candidate-alignment.json')]],
    ['configured-target-source-alignment', [node, script('scripts/verify-mcpb-source-alignment.mjs'), '--bundle', path.join(repoRoot, 'artifacts/runalith-1.0.9-rc.5-candidate-latest-build-20261022T175328+0700.mcpb'), '--source-root', repoRoot, '--output', input('validation-logs/configured-target-alignment.json')]]
  ]);
  const ledgerChronologyValid = Array.isArray(ledger?.commands) &&
    JSON.stringify(ledger.commands.map(command => command.label)) === JSON.stringify([...expectedLedgerCommands.keys()]) &&
    ledger.commands.every((command, index) => {
      const started = Date.parse(command.startedAt), ended = Date.parse(command.endedAt);
      const previousEnd = index === 0 ? -Infinity : Date.parse(ledger.commands[index - 1].endedAt);
      return Number.isFinite(started) && Number.isFinite(ended) && ended >= started && started >= previousEnd;
    });
  const developmentCommand = ledger?.commands?.find(command => command.label === 'development-candidate-source-alignment');
  const developmentAlignmentBlocked = developmentCommand?.exitCode === 1 && developmentCommand?.expectedExitCode === 1 && developmentCommand?.expectedFailure === true;
  const ledgerStatusValid = ledger?.status === 'COMPLETED' && ledger.error === null && !developmentAlignmentBlocked ||
    ledger?.status === 'BLOCKED' && typeof ledger.error === 'string' && developmentAlignmentBlocked;
  const ledgerValid = ledgerSchemaValid && ledger && ledger.schemaVersion === 1 && ledgerStatusValid &&
    ledger.repoRoot === repoRoot && ledger.gitHead === execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim() &&
    Array.isArray(ledger.commands) && ledger.commands.length === expectedLedgerCommands.size && ledgerLabels.size === expectedLedgerCommands.size &&
    [...expectedLedgerCommands.keys()].every(label => ledgerLabels.has(label)) && ledgerChronologyValid &&
      ledger.commands.every(command => typeof command.label === 'string' && Array.isArray(command.argv) &&
      command.argv.every(argument => typeof argument === 'string') && JSON.stringify(command.argv) === JSON.stringify(expectedArgv.get(command.label)) &&
      typeof command.startedAt === 'string' && Number.isFinite(Date.parse(command.startedAt)) && typeof command.endedAt === 'string' &&
      Number.isFinite(Date.parse(command.endedAt)) && command.nodeVersion === ledger.nodeVersion && command.signal === null && command.error === null &&
      Number.isInteger(command.exitCode) && command.exitCode === command.expectedExitCode && expectedLedgerCommands.get(command.label).includes(command.expectedExitCode) &&
      command.cwd === repoRoot && (['configured-target-source-alignment', ...(command.label === 'development-candidate-source-alignment' && command.exitCode === 1 ? ['development-candidate-source-alignment'] : [])].includes(command.label)
        ? command.expectedFailure === true : command.expectedFailure === false) &&
      expectedLogPaths.has(command.label) && command.stdout.path === expectedLogPaths.get(command.label)[0] && command.stderr.path === expectedLogPaths.get(command.label)[1] &&
      typeof command.stdout?.path === 'string' && typeof command.stdout?.sha256 === 'string' && Number.isSafeInteger(command.stdout?.sizeBytes) &&
      typeof command.stderr?.path === 'string' && typeof command.stderr?.sha256 === 'string' && Number.isSafeInteger(command.stderr?.sizeBytes));
  check('COMMAND_LEDGER', Boolean(ledgerValid), 'fixed workflow command set, source-bound Git HEAD, expected exit codes and target mismatch classification must match; raw logs are separately hash-checked');
  if (ledgerValid) for (const command of ledger.commands) for (const stream of ['stdout', 'stderr']) {
    const relative = command[stream].path;
    const full = path.resolve(pack, relative);
    if (path.isAbsolute(relative) || !full.startsWith(`${pack}${path.sep}`) || !fs.lstatSync(full).isFile()) {
      blockers.push({ id: 'RAW_LOG_PATH_INVALID', detail: `${command.label} ${stream} log path is invalid` });
      continue;
    }
    const bytes = readStableFile(full);
    if (bytes.length !== command[stream].sizeBytes || hash(bytes) !== command[stream].sha256) blockers.push({ id: 'RAW_LOG_HASH_MISMATCH', detail: `${command.label} ${stream} raw log identity mismatch` });
  }
  const inputIdentities = parseStrictJson(readStableFile(path.join(pack, 'input-identities.json')), 'Phase 2 input identities');
  let inputFilesMatch = Object.keys(inputIdentities).length === 3;
  for (const [key, record] of Object.entries(inputIdentities)) {
    const full = path.resolve(pack, record.path);
    if (path.isAbsolute(record.path) || !full.startsWith(`${pack}${path.sep}`) || !fs.lstatSync(full).isFile()) { inputFilesMatch = false; continue; }
    const bytes = readStableFile(full);
    if (bytes.length !== record.sizeBytes || hash(bytes) !== record.sha256) inputFilesMatch = false;
  }
  check('INPUT_FIXTURE_IDENTITY', inputFilesMatch, 'all three frozen dataset/corpus/graph input copies match their recorded byte identities');
  let independentContentValid = false;
  let independentContentDetail = 'independent content audit did not complete';
  try {
    const datasetBytes = readStableFile(path.join(pack, 'inputs/dataset.json'));
    const dataset = parseStrictJson(datasetBytes, 'Independent content audit dataset');
    const modelBytes = readStableFile(path.join(pack, 'model.json'));
    const artifact = parseStrictJson(modelBytes, 'Independent content audit model artifact');
    const evaluationBytes = readStableFile(path.join(pack, 'holdout-evaluation.json'));
    const evaluation = parseStrictJson(evaluationBytes, 'Independent content audit holdout evaluation');
    auditExactKeys(dataset, ['schemaVersion', 'featureSchemaVersion', 'datasetId', 'labelProvenance', 'trainingExamples', 'validationExamples', 'holdoutExamples'], 'dataset');
    auditExactKeys(dataset.labelProvenance, ['kind', 'source', 'adjudicatorId', 'adjudicationProtocol', 'independent'], 'dataset.labelProvenance');
    if (dataset.schemaVersion !== 1 || dataset.featureSchemaVersion !== 1 || typeof dataset.datasetId !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(dataset.datasetId) || !['synthetic', 'independently_adjudicated'].includes(dataset.labelProvenance.kind) ||
        typeof dataset.labelProvenance.source !== 'string' || !dataset.labelProvenance.source.trim() ||
        typeof dataset.labelProvenance.adjudicatorId !== 'string' || !dataset.labelProvenance.adjudicatorId.trim() ||
        typeof dataset.labelProvenance.adjudicationProtocol !== 'string' || !dataset.labelProvenance.adjudicationProtocol.trim() ||
        typeof dataset.labelProvenance.independent !== 'boolean' ||
        (dataset.labelProvenance.kind === 'synthetic' && dataset.labelProvenance.independent !== false) ||
        (dataset.labelProvenance.kind === 'independently_adjudicated' && dataset.labelProvenance.independent !== true)) throw new Error('dataset schema or label provenance is malformed');
    auditExactKeys(artifact, ['schemaVersion', 'kind', 'artifactSha256', 'datasetId', 'datasetFileSha256', 'datasetSha256', 'featureSchemaVersion',
      'labelProvenance', 'provenanceAssessment', 'splitIdentities', 'sourceIdentity', 'model', 'training', 'validation', 'status', 'acceptance', 'execution'], 'model artifact');
    auditExactKeys(artifact.model, ['schemaVersion', 'featureSchemaVersion', 'modelType', 'featureNames', 'datasetId', 'trainingConfig', 'trainingDataSha256',
      'validationDataSha256', 'means', 'scales', 'weights', 'intercept', 'trainingExampleCount', 'trainingClassCounts', 'trainingMetrics', 'modelSha256'], 'model');
    auditExactKeys(artifact.model.trainingConfig, ['learningRate', 'epochs', 'l2', 'seed'], 'model.trainingConfig');
    auditExactKeys(artifact.model.trainingClassCounts, ['negative', 'positive'], 'model.trainingClassCounts');
    auditExactKeys(artifact.training, ['exampleCount', 'dataSha256', 'metrics'], 'model training summary');
    auditExactKeys(artifact.validation, ['schemaVersion', 'modelSha256', 'evaluationDataSha256', 'evaluationExampleCount', 'metrics', 'accuracyTargetAssessment', 'classification'], 'model validation summary');
    auditExactKeys(artifact.provenanceAssessment, ['kind', 'declaredIndependent', 'groundTruthGeneratedBySearch', 'independentAttestationPresent'], 'model provenance assessment');
    auditExactKeys(artifact.splitIdentities, ['training', 'validation', 'holdout'], 'model split identities');
    for (const splitName of ['training', 'validation', 'holdout']) {
      auditExactKeys(artifact.splitIdentities[splitName], ['count', 'sha256', 'classBalance'], `model split ${splitName}`);
      auditExactKeys(artifact.splitIdentities[splitName].classBalance, ['negative', 'positive'], `model split ${splitName} class balance`);
    }
    auditExactKeys(artifact.sourceIdentity, ['trainerCliSha256', 'discriminatorSha256', 'datasetValidatorSha256', 'strictJsonParserSha256', 'canonicalJsonSha256'], 'model source identity');
    auditExactKeys(evaluation, ['schemaVersion', 'kind', 'datasetId', 'datasetFileSha256', 'datasetSha256', 'splitIdentities', 'modelArtifactSha256', 'modelSha256',
      'sourceIdentity', 'featureSchemaVersion', 'holdoutEvaluation', 'classImbalanceSensitivity', 'holdoutUse', 'evidenceLevel', 'acceptance', 'execution'], 'holdout evaluation');
    auditExactKeys(evaluation.holdoutEvaluation, ['schemaVersion', 'modelSha256', 'evaluationDataSha256', 'evaluationExampleCount', 'metrics', 'accuracyTargetAssessment', 'classification'], 'holdout evaluation result');
    auditExactKeys(evaluation.execution, ['enabled', 'authorized', 'dispatched'], 'holdout evaluation execution');
    auditExactKeys(evaluation.classImbalanceSensitivity, evaluation.classImbalanceSensitivity?.status === 'DIAGNOSTIC_RETRAIN_NO_MODEL_SELECTION'
      ? ['status', 'trainingClassBalance', 'majorityToMinorityRatio', 'balancedSubsetClassBalance', 'balancedSubsetModelSha256', 'originalModelHoldoutMetrics', 'balancedSubsetHoldoutMetrics', 'holdoutUsedForSelection', 'note']
      : ['status', 'trainingClassBalance', 'majorityToMinorityRatio', 'balancedSubsetModelSha256', 'holdoutUsedForSelection'], 'class imbalance sensitivity');
    const training = auditNormalizeSplit(dataset.trainingExamples), validation = auditNormalizeSplit(dataset.validationExamples), holdout = auditNormalizeSplit(dataset.holdoutExamples);
    const snapshotSourceHash = relative => hash(readStableFile(path.join(pack, 'source-snapshot', relative)));
    const expectedModelSources = {
      trainerCliSha256: snapshotSourceHash('scripts/train-agg-phase2-discriminator.mjs'),
      discriminatorSha256: snapshotSourceHash('src/runtime/adaptive-goal-discriminator.js'),
      datasetValidatorSha256: snapshotSourceHash('src/runtime/adaptive-goal-phase2-dataset.js'),
      strictJsonParserSha256: snapshotSourceHash('src/runtime/strict-json.js'),
      canonicalJsonSha256: snapshotSourceHash('src/runtime/canonical-json.js')
    };
    const expectedEvaluationSources = {
      evaluatorCliSha256: snapshotSourceHash('scripts/evaluate-agg-phase2-discriminator.mjs'),
      discriminatorSha256: snapshotSourceHash('src/runtime/adaptive-goal-discriminator.js'),
      datasetValidatorSha256: snapshotSourceHash('src/runtime/adaptive-goal-phase2-dataset.js'),
      strictJsonParserSha256: snapshotSourceHash('src/runtime/strict-json.js'),
      canonicalJsonSha256: snapshotSourceHash('src/runtime/canonical-json.js')
    };
    const featureVectors = new Set(), ids = new Set();
    for (const [splitName, examples] of [['training', training], ['validation', validation], ['holdout', holdout]]) {
      if (examples.length < (splitName === 'training' ? 4 : 2) || !examples.some(item => item.label === 0) || !examples.some(item => item.label === 1)) throw new Error(`${splitName} split lacks minimum size or both classes`);
      for (const example of examples) {
        if (typeof example.id !== 'string' || (example.label !== 0 && example.label !== 1) || AUDIT_FEATURES.some(name => typeof example.features[name] !== 'number' || !Number.isFinite(example.features[name]) || example.features[name] < 0 || example.features[name] > 1 || Object.is(example.features[name], -0))) throw new Error(`${splitName} contains a malformed example`);
        if (ids.has(example.id)) throw new Error(`split leakage by ID: ${example.id}`);
        ids.add(example.id);
        const fingerprint = auditHashValue(example.features);
        if (featureVectors.has(fingerprint)) throw new Error(`split leakage by feature vector: ${example.id}`);
        featureVectors.add(fingerprint);
      }
    }
    const canonicalDataset = { schemaVersion: dataset.schemaVersion, featureSchemaVersion: dataset.featureSchemaVersion,
      datasetId: dataset.datasetId, labelProvenance: dataset.labelProvenance, trainingExamples: training,
      validationExamples: validation, holdoutExamples: holdout };
    const split = examples => ({ count: examples.length, sha256: auditHashValue(examples), classBalance: {
      negative: examples.filter(item => item.label === 0).length, positive: examples.filter(item => item.label === 1).length } });
    const splitIdentities = { training: split(training), validation: split(validation), holdout: split(holdout) };
    const { artifactSha256, ...artifactBody } = artifact;
    const { modelSha256, ...modelBody } = artifact.model;
    const expectedModelHash = auditHashValue(modelBody);
    const expectedArtifactHash = auditHashValue(artifactBody);
    const expectedMetrics = { training: auditMetrics(artifact.model, training), validation: auditMetrics(artifact.model, validation), holdout: auditMetrics(artifact.model, holdout) };
    const independentlyTrainedModel = auditTrainModel({ trainingExamples: training, validationExamples: validation, ...artifact.model.trainingConfig, datasetId: dataset.datasetId });
    const trainingReplayValid = auditCanonical(independentlyTrainedModel) === auditCanonical(artifact.model) &&
      artifact.model.trainingExampleCount === training.length &&
      auditCanonical(artifact.model.trainingClassCounts) === auditCanonical(splitIdentities.training.classBalance);
    const negativeTraining = training.filter(item => item.label === 0), positiveTraining = training.filter(item => item.label === 1);
    const minorityCount = Math.min(negativeTraining.length, positiveTraining.length);
    let expectedImbalance;
    if (negativeTraining.length === positiveTraining.length) expectedImbalance = { status: 'NOT_NEEDED_TRAIN_SPLIT_BALANCED', trainingClassBalance: artifact.model.trainingClassCounts,
      majorityToMinorityRatio: 1, balancedSubsetModelSha256: null, holdoutUsedForSelection: false };
    else if (minorityCount < 2) expectedImbalance = { status: 'INSUFFICIENT_MINORITY_CLASS_FOR_BALANCED_SUBSET', trainingClassBalance: artifact.model.trainingClassCounts,
      majorityToMinorityRatio: Math.max(negativeTraining.length, positiveTraining.length) / minorityCount, balancedSubsetModelSha256: null, holdoutUsedForSelection: false };
    else {
      const balancedTraining = [...negativeTraining.slice(0, minorityCount), ...positiveTraining.slice(0, minorityCount)].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const balancedModel = auditTrainModel({ trainingExamples: balancedTraining, validationExamples: validation, ...artifact.model.trainingConfig, datasetId: 'balanced-sensitivity-diagnostic' });
      expectedImbalance = { status: 'DIAGNOSTIC_RETRAIN_NO_MODEL_SELECTION', trainingClassBalance: artifact.model.trainingClassCounts,
        majorityToMinorityRatio: Math.max(negativeTraining.length, positiveTraining.length) / minorityCount,
        balancedSubsetClassBalance: { negative: minorityCount, positive: minorityCount }, balancedSubsetModelSha256: balancedModel.modelSha256,
        originalModelHoldoutMetrics: expectedMetrics.holdout, balancedSubsetHoldoutMetrics: auditMetrics(balancedModel, holdout),
        holdoutUsedForSelection: false, note: 'diagnostic comparison only; main model remains unchanged' };
    }
    const expectedAssessment = holdout.length < 30 ? 'INSUFFICIENT_SAMPLE_SIZE'
      : expectedMetrics.holdout.accuracyConfidenceInterval95.lower > 0.8 ? 'SUPPORTED_BY_95_PERCENT_CONFIDENCE_INTERVAL'
        : expectedMetrics.holdout.accuracy > 0.8 ? 'POINT_ESTIMATE_ABOVE_80_PERCENT_ONLY' : 'NOT_MET';
    independentContentValid = hash(datasetBytes) === artifact.datasetFileSha256 && auditHashValue(canonicalDataset) === artifact.datasetSha256 &&
      auditCanonical(splitIdentities) === auditCanonical(artifact.splitIdentities) && expectedModelHash === modelSha256 &&
      expectedArtifactHash === artifactSha256 && artifact.datasetId === dataset.datasetId && artifact.model.datasetId === dataset.datasetId &&
      auditCanonical(artifact.sourceIdentity) === auditCanonical(expectedModelSources) &&
      trainingReplayValid &&
      artifact.model.trainingDataSha256 === splitIdentities.training.sha256 && artifact.model.validationDataSha256 === splitIdentities.validation.sha256 &&
      auditCanonical(expectedMetrics.training) === auditCanonical(artifact.model.trainingMetrics) &&
      auditCanonical(expectedMetrics.training) === auditCanonical(artifact.training.metrics) &&
      auditCanonical(expectedMetrics.validation) === auditCanonical(artifact.validation.metrics) &&
      auditCanonical(expectedMetrics.holdout) === auditCanonical(evaluation.holdoutEvaluation.metrics) &&
      auditCanonical(evaluation.classImbalanceSensitivity) === auditCanonical(expectedImbalance) &&
      evaluation.datasetFileSha256 === hash(datasetBytes) && evaluation.datasetSha256 === artifact.datasetSha256 &&
      evaluation.modelArtifactSha256 === hash(modelBytes) && evaluation.modelSha256 === modelSha256 &&
      auditCanonical(evaluation.sourceIdentity) === auditCanonical(expectedEvaluationSources) &&
      evaluation.holdoutEvaluation.evaluationDataSha256 === auditHashValue(holdout) &&
      evaluation.holdoutEvaluation.evaluationExampleCount === holdout.length &&
      evaluation.holdoutEvaluation.accuracyTargetAssessment === expectedAssessment &&
      evaluation.holdoutUse === 'evaluation_only_no_model_selection' && evaluation.execution?.authorized === false;
    independentContentDetail = independentContentValid
      ? 'independent canonical hash, raw dataset/model bytes, all three split hashes/leakage, model/envelope hashes, training/validation/holdout metrics and evaluation lineage were rederived without importing workflow metric/hash code'
      : 'independent content rederivation disagrees with dataset/model/evaluation bytes, split boundaries, hashes or metrics';
  } catch (error) { independentContentDetail = `independent content audit rejected malformed or missing content: ${error.message}`; }
  check('INDEPENDENT_CONTENT_REDERIVATION', independentContentValid, independentContentDetail);
  let independentGraphAuditValid = false;
  let independentGraphAuditDetail = 'independent graph/search audit did not complete';
  let independentSearchReplayValid = false;
  let independentSearchReplayDetail = 'reference search decision rederivation did not complete';
  try {
    const graphBytes = readStableFile(path.join(pack, 'inputs/graph.json'));
    const graph = parseStrictJson(graphBytes, 'Independent graph/search audit graph');
    const shadowBytes = readStableFile(path.join(pack, 'shadow-search.json'));
    const shadow = parseStrictJson(shadowBytes, 'Independent graph/search audit shadow result');
    const corpusBytes = readStableFile(path.join(pack, 'inputs/benchmark-corpus.json'));
    const corpus = parseStrictJson(corpusBytes, 'Independent graph/search audit corpus');
    const benchmark = parseStrictJson(readStableFile(path.join(pack, 'paired-benchmark.json')), 'Independent graph/search audit benchmark');
    const artifact = parseStrictJson(readStableFile(path.join(pack, 'model.json')), 'Independent graph/search audit model');
    const snapshotSourceHash = relative => hash(readStableFile(path.join(pack, 'source-snapshot', relative)));
    const expectedShadowSources = {
      runnerCliSha256: snapshotSourceHash('scripts/run-agg-phase2-shadow-search.mjs'),
      phase2SearchSha256: snapshotSourceHash('src/runtime/adaptive-goal-phase2-search.js'),
      phase2PlanShadowAdapterSha256: snapshotSourceHash('src/runtime/adaptive-goal-phase2-plan-shadow.js'),
      phase1SearchSha256: snapshotSourceHash('src/runtime/adaptive-goal-graph.js'),
      discriminatorSha256: snapshotSourceHash('src/runtime/adaptive-goal-discriminator.js'),
      strictJsonParserSha256: snapshotSourceHash('src/runtime/strict-json.js'),
      canonicalJsonSha256: snapshotSourceHash('src/runtime/canonical-json.js')
    };
    const expectedBenchmarkSources = {
      benchmarkCliSha256: snapshotSourceHash('scripts/benchmark-agg-phase2-paired.mjs'),
      phase1SearchSha256: snapshotSourceHash('src/runtime/adaptive-goal-graph.js'),
      phase2SearchSha256: snapshotSourceHash('src/runtime/adaptive-goal-phase2-search.js'),
      discriminatorSha256: snapshotSourceHash('src/runtime/adaptive-goal-discriminator.js'),
      datasetValidatorSha256: snapshotSourceHash('src/runtime/adaptive-goal-phase2-dataset.js'),
      canonicalJsonSha256: snapshotSourceHash('src/runtime/canonical-json.js')
    };
    const nodeIds = new Set(graph.nodes.map(node => node.id));
    const edges = new Set(graph.edges.map(edge => `${edge.from}\0${edge.to}\0${edge.type}`));
    const nominalEdges = new Set(graph.edges.filter(edge => ['next_step', 'enables'].includes(edge.type)).map(edge => `${edge.from}\0${edge.to}\0${edge.type}`));
    const options = shadow.result.search.options;
    const referenceSearch = independentlyDeriveSearch(graph, artifact, options);
    independentSearchReplayValid = auditCanonical(referenceSearch) === auditCanonical(shadow.result);
    independentSearchReplayDetail = independentSearchReplayValid
      ? 'separate reference algorithm independently reconstructed normalized graph identity, model scoring, beam/frontier decisions, final ranking, counters and the complete ordered audit-event sequence without importing production search/scorer/canonicalizer'
      : 'independent reference search differs from the recorded result, ranking, counters, or ordered audit-event sequence';
    const pathIsValid = (nodePath, edgePath, requireGoal) => Array.isArray(nodePath) && Array.isArray(edgePath) &&
      nodePath.length >= 2 && edgePath.length === nodePath.length - 1 && nodePath[0] === graph.startNodeId &&
      (!requireGoal || nodePath.at(-1) === graph.goalNodeId) && new Set(nodePath).size === nodePath.length &&
      nodePath.every(id => nodeIds.has(id)) && edgePath.every((type, index) => nominalEdges.has(`${nodePath[index]}\0${nodePath[index + 1]}\0${type}`));
    const candidates = shadow.result.candidates;
    const candidatesValid = Array.isArray(candidates) && candidates.every(candidate => {
      const complete = candidate.candidateKind === 'complete_path_candidate';
      const identity = { graphHash: shadow.graphHash, pathNodeIds: candidate.pathNodeIds, pathEdgeTypes: candidate.pathEdgeTypes, options, modelSha256: artifact.model.modelSha256 };
      return pathIsValid(candidate.pathNodeIds, candidate.pathEdgeTypes, complete) &&
        candidate.planId === `agg-p2-${auditHashValue(identity).slice(0, 24)}` &&
        candidate.provenance?.graphHash === shadow.graphHash && candidate.provenance?.modelSha256 === artifact.model.modelSha256 &&
        candidate.provenance?.rankingMode === 'discriminator_shadow' && candidate.verification?.verified === false &&
        candidate.execution?.enabled === false && candidate.execution?.authorized === false && candidate.execution?.dispatched === false;
    });
    const trace = shadow.result.auditTrace;
    const auditValid = trace?.schemaVersion === 1 && trace.deterministic === true && trace.searchRunId === shadow.result.search.searchRunId &&
      trace.searchRunId === shadow.result.search.searchRunId && trace.modelSha256 === artifact.model.modelSha256 &&
      Number.isSafeInteger(trace.eventCount) && trace.eventCount >= 0 && Number.isSafeInteger(trace.omittedEventCount) && trace.omittedEventCount >= 0 &&
      Array.isArray(trace.events) && trace.events.length <= options.maxAuditEvents && trace.eventCount === trace.events.length + trace.omittedEventCount &&
      trace.truncated === (trace.omittedEventCount > 0) && trace.events.every(event => {
        if (event.type === 'edge_rejected') return edges.has(`${event.from}\0${event.to}\0${graph.edges.find(edge => edge.from === event.from && edge.to === event.to && ['next_step', 'enables'].includes(edge.type))?.type}`) && typeof event.reason === 'string';
        if (event.type === 'state_scored' || event.type === 'frontier_selected' || event.type === 'frontier_pruned') {
          const edgeTypes = event.pathNodeIds?.slice(0, -1).map((from, index) => graph.edges.find(edge => edge.from === from && edge.to === event.pathNodeIds[index + 1] && ['next_step', 'enables'].includes(edge.type))?.type);
          return pathIsValid(event.pathNodeIds, edgeTypes, false) && typeof event.discriminatorProbability === 'number' &&
            Number.isFinite(event.discriminatorProbability) && event.discriminatorProbability >= 0 && event.discriminatorProbability <= 1 &&
            (event.type !== 'state_scored' || event.modelSha256 === artifact.model.modelSha256);
        }
        return false;
      });
    const shadowLineageValid = shadow.schemaVersion === 2 && shadow.kind === 'agg_phase2_shadow_search_result' &&
      auditCanonical(shadow.sourceIdentity) === auditCanonical(expectedShadowSources) &&
      shadow.graphFileSha256 === hash(graphBytes) && shadow.graphHash === shadow.result.graphHash &&
      shadow.modelArtifactSha256 === hash(readStableFile(path.join(pack, 'model.json'))) &&
      shadow.datasetId === artifact.datasetId && shadow.datasetFileSha256 === artifact.datasetFileSha256 &&
      shadow.datasetSha256 === artifact.datasetSha256 && shadow.featureSchemaVersion === artifact.featureSchemaVersion &&
      shadow.planGraphShadow?.mode === 'shadow' && shadow.planGraphShadow.gates?.persisted === false &&
      shadow.planGraphShadow.gates?.immutableExecutionPlanCreated === false && shadow.planGraphShadow.gates?.dispatchAllowed === false &&
      shadow.planGraphShadow.gates?.executionAuthorized === false && Array.isArray(shadow.planGraphShadow.drafts) &&
      shadow.planGraphShadow.drafts.every(draft => {
        const { draftHash, ...draftBody } = draft;
        return draft.kind === 'adaptive_goal_phase2_plan_graph_shadow_draft' && draft.status === 'review_required' &&
          draftHash === auditHashValue(draftBody) && candidates.some(candidate => candidate.planId === draft.source?.candidatePlanId) &&
          draft.source?.mode === 'shadow' && draft.source?.modelSha256 === artifact.model.modelSha256 && draft.source?.verification?.verified === false &&
          draft.gates?.persisted === false && draft.gates?.immutableExecutionPlanCreated === false && draft.gates?.dispatchAllowed === false &&
          draft.gates?.executionAuthorized === false && Array.isArray(draft.steps) &&
          draft.steps.every(step => step.execution?.enabled === false &&
            (!Object.hasOwn(step.execution, 'authorized') || step.execution.authorized === false) &&
            (!Object.hasOwn(step.execution, 'dispatched') || step.execution.dispatched === false) &&
            step.execution?.authorization === 'none' && step.execution?.executable === null && step.execution?.args === null);
      });
    const benchmarkCases = benchmark.cases;
    const caseIds = new Set();
    const pairsValid = Array.isArray(corpus.cases) && Array.isArray(benchmarkCases) && benchmarkCases.length === corpus.cases.length &&
      benchmarkCases.every((record, index) => {
        const scenario = corpus.cases[index];
        if (!scenario || typeof scenario.caseId !== 'string' || caseIds.has(scenario.caseId)) return false;
        caseIds.add(scenario.caseId);
        return record.caseId === scenario.caseId && typeof record.graphHash === 'string' && /^[a-f0-9]{64}$/.test(record.graphHash) &&
          typeof record.baseline?.success === 'boolean' && typeof record.phase2?.success === 'boolean' &&
          record.pairedDelta === Number(record.phase2.success) - Number(record.baseline.success) &&
          ['baseline', 'phase2'].every(key => Number.isSafeInteger(record[key].expansions) && record[key].expansions >= 0 &&
            Number.isSafeInteger(record[key].nodesExpanded) && record[key].nodesExpanded >= 0 && Number.isSafeInteger(record[key].candidates) && record[key].candidates >= 0);
      });
    const pairedMetrics = benchmark.metrics;
    const baselineSuccessCount = benchmarkCases.filter(record => record.baseline.success).length;
    const phase2SuccessCount = benchmarkCases.filter(record => record.phase2.success).length;
    const outcomes = { bothSuccess: benchmarkCases.filter(record => record.baseline.success && record.phase2.success).length,
      phase2Only: benchmarkCases.filter(record => !record.baseline.success && record.phase2.success).length,
      baselineOnly: benchmarkCases.filter(record => record.baseline.success && !record.phase2.success).length,
      bothFail: benchmarkCases.filter(record => !record.baseline.success && !record.phase2.success).length };
    const benchmarkLineageValid = benchmark.kind === 'agg_phase2_paired_benchmark' && benchmark.corpusFileSha256 === hash(corpusBytes) &&
      auditCanonical(benchmark.sourceIdentity) === auditCanonical(expectedBenchmarkSources) &&
      benchmark.modelArtifactSha256 === hash(readStableFile(path.join(pack, 'model.json'))) && benchmark.modelSha256 === artifact.model.modelSha256 &&
      benchmark.datasetId === artifact.datasetId && benchmark.datasetFileSha256 === artifact.datasetFileSha256 &&
      benchmark.datasetSha256 === artifact.datasetSha256 && benchmark.sameFrozenGraphPerPair === true && benchmark.sameExpansionBudgetPerPair === true &&
      benchmark.pairedConfig?.beamWidth === options.beamWidth && benchmark.pairedConfig?.maxDepth === options.maxDepth &&
      benchmark.pairedConfig?.maxExpansions === options.maxExpansions && benchmark.pairedConfig?.maxAuditEvents === options.maxAuditEvents &&
      benchmark.phase2?.modelSha256 === artifact.model.modelSha256 &&
      benchmark.phase1Baseline?.graphHashes?.length === benchmarkCases.length &&
      auditCanonical(benchmark.phase1Baseline.graphHashes) === auditCanonical(benchmarkCases.map(record => record.graphHash)) &&
      pairsValid && pairedMetrics.caseCount === benchmarkCases.length && pairedMetrics.baselineSuccessCount === baselineSuccessCount &&
      pairedMetrics.phase2SuccessCount === phase2SuccessCount && pairedMetrics.pairedSuccessRateDelta === (phase2SuccessCount - baselineSuccessCount) / benchmarkCases.length &&
      auditCanonical(pairedMetrics.pairedOutcomes) === auditCanonical(outcomes) && benchmark.execution?.authorized === false && benchmark.acceptance === 'acceptance_required';
    independentGraphAuditValid = independentSearchReplayValid && shadowLineageValid && candidatesValid && auditValid && benchmarkLineageValid;
    independentGraphAuditDetail = independentGraphAuditValid
      ? 'reference search replay plus raw graph/model/corpus bytes, candidate path and plan IDs, audit-event accounting, Plan Graph draft hashes and non-execution gates, scenario pairing and benchmark lineage/aggregate outcomes were independently checked'
      : `graph/search candidate structure, reference search replay, audit accounting, Plan Graph shadow gates, benchmark scenario pairing or output lineage is inconsistent (referenceSearch=${independentSearchReplayValid}, shadowLineage=${shadowLineageValid}, candidates=${candidatesValid}, audit=${auditValid}, benchmarkLineage=${benchmarkLineageValid})`;
  } catch (error) { independentGraphAuditDetail = `independent graph/search audit rejected malformed or missing content: ${error.message}`; }
  check('INDEPENDENT_SEARCH_DECISIONS_AND_AUDIT_REDERIVED', independentSearchReplayValid, independentSearchReplayDetail);
  check('INDEPENDENT_GRAPH_SEARCH_AUDIT_PLAN_LINEAGE', independentGraphAuditValid, independentGraphAuditDetail);
  const sourceSnapshot = parseStrictJson(readStableFile(path.join(pack, 'source-snapshot-identity.json')), 'Phase 2 source snapshot identity');
  const patchBytes = readStableFile(path.join(pack, 'tracked-working-tree.patch'));
  const statusBytes = readStableFile(path.join(pack, 'git-status-porcelain.txt'));
  check('SOURCE_SNAPSHOT_BINDING', hash(patchBytes) === sourceSnapshot.trackedPatchSha256 && hash(statusBytes) === sourceSnapshot.workingTreePorcelainSha256,
    'tracked patch and porcelain snapshot hashes match source snapshot metadata');
  const sourceFiles = Object.keys(sourceSnapshot.sourceIdentity ?? {});
  let overlayMatches = JSON.stringify([...sourceFiles].sort()) === JSON.stringify([...REQUIRED_SOURCE_FILES].sort()) &&
    sourceSnapshot.sourceFilesCopied === REQUIRED_SOURCE_FILES.length;
  let currentSourceMatches = overlayMatches;
  for (const relative of sourceFiles) {
    const copy = path.join(pack, 'source-snapshot', relative);
    if (!fs.existsSync(copy) || !fs.lstatSync(copy).isFile() || fs.realpathSync(copy) !== copy || hash(readStableFile(copy)) !== sourceSnapshot.sourceIdentity[relative]) overlayMatches = false;
    const current = path.join(repoRoot, relative);
    if (!fs.existsSync(current) || !fs.lstatSync(current).isFile() || fs.realpathSync(current) !== current || hash(readStableFile(current)) !== sourceSnapshot.sourceIdentity[relative]) currentSourceMatches = false;
  }
  check('SOURCE_SNAPSHOT_BINDING', overlayMatches, 'captured tracked/untracked source snapshot bytes match the recorded source identity');
  check('CURRENT_SOURCE_TREE_MATCHES_SNAPSHOT', currentSourceMatches, 'current source tree bytes match the snapshot captured in the pack');
  const currentTrackedPatch = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: repoRoot, encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 });
  const currentStatusRaw = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const currentStatusLines = currentStatusRaw.split('\n').filter(Boolean).sort();
  const packRelative = path.relative(repoRoot, pack);
  const verifierOutputRelative = path.relative(repoRoot, output);
  const isUntrackedPathWithin = (line, relative) => {
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !line.startsWith('?? ')) return false;
    const candidate = line.slice(3);
    return candidate === relative || candidate.startsWith(`${relative}${path.sep}`);
  };
  // Post-snapshot reports are receipts, not source inputs. Exclude a verifier
  // receipt only when its strict JSON identity binds it to this exact pack and
  // manifest. Final drift/checksum sidecars have exact derived paths and are
  // excluded only when their payloads reconcile to the same manifest and exact
  // report bytes. Never exclude arbitrary files by basename or shared prefix.
  const readCanonicalReceipt = (relative, maxBytes = 2 * 1024 * 1024) => {
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
    const full = path.resolve(repoRoot, relative);
    try {
      const stat = fs.lstatSync(full);
      if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(full) !== full || stat.size > maxBytes) return null;
      return readStableFile(full);
    } catch { return null; }
  };
  const isBoundVerifierReport = relative => {
    const bytes = readCanonicalReceipt(relative);
    if (!bytes) return false;
    try {
      const receipt = parseStrictJson(bytes, 'Prior Phase 2 verifier sidecar');
      return isBoundEvidenceVerifierReceipt(receipt, { relative, packRelative, manifestSha256: manifestHash });
    } catch { return false; }
  };
  const driftReceiptRelative = `${packRelative}-final-source-drift-check.json`;
  const isBoundDriftReceipt = relative => {
    if (relative !== driftReceiptRelative) return false;
    const bytes = readCanonicalReceipt(relative);
    if (!bytes) return false;
    try {
      const receipt = parseStrictJson(bytes, 'Prior Phase 2 source-drift sidecar');
      return isBoundSourceDriftReceipt(receipt, { packRelative, manifestSha256: manifestHash });
    } catch { return false; }
  };
  const externalSumsRelative = `${packRelative}-FINAL-SHA256SUMS.txt`;
  const isBoundExternalSums = relative => {
    if (relative !== externalSumsRelative) return false;
    const bytes = readCanonicalReceipt(relative, 64 * 1024);
    if (!bytes) return false;
    const text = bytes.toString('utf8');
    if (!text.endsWith('\n') || text.includes('\r')) return false;
    const expected = expectedPhase2ExternalChecksumPaths(packRelative);
    const seen = new Set();
    for (const line of text.slice(0, -1).split('\n')) {
      const match = /^([a-f0-9]{64})  ([^\0]+)$/.exec(line);
      if (!match || !expected.has(match[2]) || seen.has(match[2])) return false;
      const target = match[2], targetBytes = readCanonicalReceipt(target, 256 * 1024 * 1024);
      if (!targetBytes || hash(targetBytes) !== match[1]) return false;
      seen.add(target);
    }
    return seen.size === expected.size;
  };
  const filteredStatusLines = currentStatusLines.filter(line => {
    if (isUntrackedPathWithin(line, packRelative) || isUntrackedPathWithin(line, verifierOutputRelative)) return false;
    if (line.startsWith('?? ')) {
      const relative = line.slice(3);
      if (isBoundVerifierReport(relative) || isBoundDriftReceipt(relative) || isBoundExternalSums(relative)) return false;
    }
    return true;
  });
  const filteredStatus = filteredStatusLines.length ? `${filteredStatusLines.join('\n')}\n` : '';
  check('WORKTREE_STABLE_SINCE_SNAPSHOT', hash(currentTrackedPatch) === sourceSnapshot.trackedPatchSha256 &&
    hash(Buffer.from(filteredStatus)) === sourceSnapshot.workingTreePorcelainSha256,
    'tracked diff and pre-pack working-tree drift match after excluding only this new evidence pack');
  const overlayIndex = parseStrictJson(readStableFile(path.join(pack, 'untracked-source-overlay-index.json')), 'Untracked source overlay index');
  const overlayRoot = path.join(pack, 'untracked-source-overlay');
  const overlayActual = walk(overlayRoot).map(relative => path.relative(overlayRoot, path.resolve(repoRoot, relative))).sort();
  const overlayExpected = overlayIndex.map(item => item.path).sort();
  const untrackedRaw = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repoRoot, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const currentUntrackedSources = untrackedRaw.toString('utf8').split('\0').filter(name => name && !name.startsWith('artifacts/') &&
    !name.startsWith('benchmarks/plugin-workflow-benchmark/runs/') && !name.startsWith('benchmarks/plugin-workflow-benchmark/phase2-pilot-') &&
    /\.(?:js|mjs|json|md|sh|yml|yaml|toml)$/.test(name) && !path.resolve(repoRoot, name).startsWith(`${pack}${path.sep}`)).filter(name => {
      const full = path.join(repoRoot, name);
      try { const stat = fs.lstatSync(full); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; }
    }).sort();
  let overlayHashMatch = overlayIndex.length > 0 && JSON.stringify(overlayActual) === JSON.stringify(overlayExpected) &&
    JSON.stringify(currentUntrackedSources) === JSON.stringify(overlayExpected);
  for (const item of overlayIndex) {
    const full = path.join(overlayRoot, item.path);
    if (!fs.existsSync(full) || !fs.lstatSync(full).isFile()) { overlayHashMatch = false; continue; }
    const bytes = readStableFile(full);
    if (bytes.length !== item.sizeBytes || hash(bytes) !== item.sha256) overlayHashMatch = false;
  }
  check('UNTRACKED_OVERLAY_BINDING', overlayHashMatch, `untracked source overlay inventory and hashes match; files=${overlayIndex.length}`);
  const workflowVerification = parseStrictJson(readStableFile(path.join(pack, 'verification.json')), 'Phase 2 workflow verification report');
  const expectedWorkflowInputs = {
    '--dataset': 'inputs/dataset.json', '--model': 'model.json', '--evaluation': 'holdout-evaluation.json', '--graph': 'inputs/graph.json',
    '--shadow-result': 'shadow-search.json', '--corpus': 'inputs/benchmark-corpus.json', '--benchmark': 'paired-benchmark.json'
  };
  let workflowInputsBound = workflowVerification.inputArtifacts && Object.keys(workflowVerification.inputArtifacts).length === Object.keys(expectedWorkflowInputs).length;
  for (const [key, relative] of Object.entries(expectedWorkflowInputs)) {
    const identity = workflowVerification.inputArtifacts?.[key];
    const full = path.join(pack, relative);
    if (!identity || identity.path !== path.relative(repoRoot, full) || !fs.lstatSync(full).isFile()) { workflowInputsBound = false; continue; }
    const bytes = readStableFile(full);
    if (identity.sha256 !== hash(bytes) || identity.sizeBytes !== bytes.length) workflowInputsBound = false;
  }
  const replayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-phase2-pack-replay-'));
  let replayReport = null, replayExitCode = null, replayError = null;
  try {
    const replayOutput = path.join(replayDir, 'verification.json');
    const argv = [path.join(repoRoot, 'scripts/verify-agg-phase2-workflow.mjs')];
    for (const [key, relative] of Object.entries(expectedWorkflowInputs)) argv.push(key, path.join(pack, relative));
    argv.push('--output', replayOutput);
    const replay = spawnSync(process.execPath, argv, { cwd: repoRoot, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    replayExitCode = replay.status;
    if (replay.error) replayError = replay.error.message;
    else if (fs.existsSync(replayOutput)) replayReport = parseStrictJson(readStableFile(replayOutput), 'Independently replayed Phase 2 workflow verification');
  } finally { fs.rmSync(replayDir, { recursive: true, force: true }); }
  const replayChecks = Array.isArray(replayReport?.checks) && replayReport.checks.length > 0 && replayReport.checks.every(item => item.status === 'PASS');
  check('WORKFLOW_VERIFICATION_PRESENT', workflowInputsBound && workflowVerification.kind === 'agg_phase2_independent_verification_report' &&
    workflowVerification.verificationStatus === 'VERIFIED' && workflowVerification.acceptanceStatus === 'ACCEPTANCE_REQUIRED' &&
    workflowVerification.readiness === 'BLOCKED' && workflowVerification.executionGate === 'CLOSED',
    'included workflow report binds every required input path, byte hash and size; acceptance remains blocked');
  check('WORKFLOW_VERIFICATION_REPLAYED', replayExitCode === 0 && !replayError && replayReport?.verificationStatus === 'VERIFIED' &&
    replayReport?.evidenceStatus === 'INTEGRITY_ONLY' && replayReport?.readiness === 'BLOCKED' && replayReport?.executionGate === 'CLOSED' && replayChecks &&
    JSON.stringify(replayReport.checks.map(item => [item.id, item.status])) === JSON.stringify(workflowVerification.checks?.map(item => [item.id, item.status])),
    `workflow verifier was independently rerun against pack bytes; exit=${replayExitCode}; error=${replayError ?? 'none'}`);
  const historical = parseStrictJson(readStableFile(path.join(pack, 'historical-pack-reconciliation.json')), 'Historical Phase 2 pack reconciliation');
  check('HISTORICAL_PACK_RECONCILED', historical.manifestHashMatchesClaim === true && historical.listedEntriesAllValid === true &&
    historical.unexpectedUnlistedFiles.length === 0 && JSON.stringify([...historical.unlistedFiles].sort()) === JSON.stringify([...historical.expectedExcludedReceiptFiles].sort()) &&
    historical.sourceChangedCount === historical.sourceComparisons.filter(item => item.status === 'SOURCE_CHANGED_SINCE_HISTORICAL_PACK').length &&
    historical.sourceMatchCount + historical.sourceChangedCount === historical.sourceComparisons.length,
    'historical manifest claim and listed checksums are verified; subsequent source drift is recorded rather than overwritten');
  const historicalInventoryArtifact = parseStrictJson(readStableFile(path.join(pack, 'historical-pack-inventory.json')), 'Historical evidence pack inventory');
  const historicalDirectories = fs.readdirSync(path.join(repoRoot, 'artifacts'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('agg-phase') && path.join(repoRoot, 'artifacts', entry.name) !== pack)
    .map(entry => ({ name: entry.name, directory: path.join(repoRoot, 'artifacts', entry.name) }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const recomputedHistoricalInventory = historicalDirectories.map(({ name, directory }) => {
    const manifestName = ['SHA256SUMS.txt', 'manifest.sha256'].find(candidate => fs.existsSync(path.join(directory, candidate))) ?? null;
    let manifestSha256 = null, manifestEntryCount = 0, validEntryCount = 0, invalidEntries = [];
    if (manifestName) {
      const bytes = readStableFile(path.join(directory, manifestName));
      manifestSha256 = hash(bytes);
      const lines = bytes.toString('utf8').trimEnd().split('\n');
      manifestEntryCount = lines.length;
      for (const [index, line] of lines.entries()) {
        const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
        if (!match) { invalidEntries.push({ line: index + 1, reason: 'malformed_manifest_line' }); continue; }
        const relative = match[2], full = relative.startsWith('artifacts/') ? path.resolve(repoRoot, relative) : path.resolve(directory, relative);
        if (!(full === directory || full.startsWith(`${directory}${path.sep}`))) { invalidEntries.push({ line: index + 1, path: relative, reason: 'path_escapes_pack' }); continue; }
        try {
          const stat = fs.lstatSync(full);
          if (!stat.isFile() || stat.isSymbolicLink() || hash(readStableFile(full)) !== match[1]) invalidEntries.push({ line: index + 1, path: relative, reason: 'missing_nonregular_or_checksum_mismatch' });
          else validEntryCount++;
        } catch { invalidEntries.push({ line: index + 1, path: relative, reason: 'missing_or_unreadable' }); }
      }
    }
    const actualFiles = [];
    const walkPack = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkPack(full);
      else if (entry.isFile()) actualFiles.push(path.relative(directory, full));
      else actualFiles.push(`${path.relative(directory, full)} [special-or-symlink]`);
    } };
    walkPack(directory);
    const listed = new Set();
    if (manifestName) for (const line of readStableFile(path.join(directory, manifestName), 'utf8').trimEnd().split('\n')) {
      const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
      if (match) listed.add(match[2].startsWith('artifacts/') ? path.relative(directory, path.resolve(repoRoot, match[2])) : path.normalize(match[2]));
    }
    const unlistedFiles = actualFiles.filter(relative => relative !== manifestName && !listed.has(relative)).sort();
    return { name, directory: path.relative(repoRoot, directory), manifestName, manifestSha256, manifestEntryCount, validEntryCount,
      invalidEntryCount: invalidEntries.length, invalidEntries: invalidEntries.slice(0, 25), actualFileCount: actualFiles.length,
      unlistedFileCount: unlistedFiles.length, unlistedFiles: unlistedFiles.slice(0, 25),
      status: !manifestName ? 'NO_TOP_LEVEL_CHECKSUM_MANIFEST' : invalidEntries.length ? 'CHECKSUM_RECONCILIATION_FAILED' : 'ALL_LISTED_CHECKSUMS_PASS' };
  });
  const expectedInventorySummary = { directoryCount: recomputedHistoricalInventory.length,
    manifestPassCount: recomputedHistoricalInventory.filter(item => item.status === 'ALL_LISTED_CHECKSUMS_PASS').length,
    noManifestCount: recomputedHistoricalInventory.filter(item => item.status === 'NO_TOP_LEVEL_CHECKSUM_MANIFEST').length,
    failedManifestCount: recomputedHistoricalInventory.filter(item => item.status === 'CHECKSUM_RECONCILIATION_FAILED').length };
  check('HISTORICAL_PACK_INVENTORY_RECONCILED', historicalInventoryArtifact.schemaVersion === 1 &&
    historicalInventoryArtifact.directoryCount === expectedInventorySummary.directoryCount &&
    historicalInventoryArtifact.manifestPassCount === expectedInventorySummary.manifestPassCount &&
    historicalInventoryArtifact.noManifestCount === expectedInventorySummary.noManifestCount &&
    historicalInventoryArtifact.failedManifestCount === expectedInventorySummary.failedManifestCount &&
    JSON.stringify(historicalInventoryArtifact.entries) === JSON.stringify(recomputedHistoricalInventory),
    `recomputed all historical agg-phase directories read-only; directories=${expectedInventorySummary.directoryCount}, checksum manifests passing=${expectedInventorySummary.manifestPassCount}, no top-level checksum manifest=${expectedInventorySummary.noManifestCount}, failures=${expectedInventorySummary.failedManifestCount}`);
  const historicalManifestReplayArtifact = parseStrictJson(readStableFile(path.join(pack, 'historical-manifest-replay.json')), 'Historical nested manifest replay');
  const allHistoricalManifestPaths = [];
  function walkAllHistoricalManifests(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (full === pack || full.startsWith(`${pack}${path.sep}`)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Symlink in historical artifacts while verifying manifests: ${full}`);
      if (entry.isDirectory()) walkAllHistoricalManifests(full);
      else if (entry.isFile() && ['SHA256SUMS.txt', 'manifest.sha256'].includes(entry.name)) allHistoricalManifestPaths.push(full);
    }
  }
  walkAllHistoricalManifests(path.join(repoRoot, 'artifacts'));
  const recomputedHistoricalManifestReplay = allHistoricalManifestPaths.sort().map(manifestFull => {
    const manifestBytes = readStableFile(manifestFull), manifestRoot = path.dirname(manifestFull);
    const lines = manifestBytes.toString('utf8').trimEnd().split('\n'), invalidEntries = [], listed = new Set();
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
        if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(full) !== full || hash(readStableFile(full)) !== match[1]) {
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
  const historicalManifestSummaryValid = historicalManifestReplayArtifact.schemaVersion === 1 &&
    historicalManifestReplayArtifact.manifestCount === recomputedHistoricalManifestReplay.length &&
    historicalManifestReplayArtifact.manifestPassCount === recomputedHistoricalManifestReplay.filter(item => item.status !== 'CHECKSUM_RECONCILIATION_FAILED').length &&
    historicalManifestReplayArtifact.manifestFailureCount === recomputedHistoricalManifestReplay.filter(item => item.status === 'CHECKSUM_RECONCILIATION_FAILED').length &&
    auditCanonical(historicalManifestReplayArtifact.entries) === auditCanonical(recomputedHistoricalManifestReplay);
  check('ALL_HISTORICAL_MANIFESTS_REPLAYED', historicalManifestSummaryValid,
    `recomputed nested and top-level manifests without editing history; manifests=${recomputedHistoricalManifestReplay.length}, failed=${recomputedHistoricalManifestReplay.filter(item => item.status === 'CHECKSUM_RECONCILIATION_FAILED').length}`);
  const candidates = parseStrictJson(readStableFile(path.join(pack, 'candidate-identities.json')), 'Candidate identity report');
  const candidateIdentityValid = candidates.candidates.length === 2 && candidates.candidates.every(item => {
    const full = path.resolve(repoRoot, item.path);
    return full.startsWith(`${repoRoot}${path.sep}`) && fs.lstatSync(full).isFile() && !fs.lstatSync(full).isSymbolicLink() && fs.realpathSync(full) === full &&
      hash(readStableFile(full)) === item.observedSha256 && item.hashMatchesExpected === true &&
      item.archiveEntryCount === 76 && item.toolCount === 67 && item.releaseApproved === false && item.approvalBindingChanged === false;
  });
  check('CANDIDATE_IDENTITY_PRESERVED', candidateIdentityValid, 'development candidate and configured target candidate hashes/inventory are unchanged and not release-approved');
  const validation = parseStrictJson(readStableFile(path.join(pack, 'validation-results.json')), 'Phase 2 final validation results');
  let validationLogsMatch = Array.isArray(validation.files) && validation.files.length > 0;
  for (const item of validation.files ?? []) {
    const full = path.resolve(pack, item.path);
    if (path.isAbsolute(item.path) || !full.startsWith(`${pack}${path.sep}`) || !fs.lstatSync(full).isFile()) { validationLogsMatch = false; continue; }
    const bytes = readStableFile(full);
    if (bytes.length !== item.sizeBytes || hash(bytes) !== item.sha256) validationLogsMatch = false;
  }
  const executedChecks = (validation.commands ?? []).filter(command => command.status !== 'NOT_RUN_IN_WORKFLOW_SUBPROCESS');
  const expectedChecks = executedChecks.filter(command => !command.expectedFailure);
  const expectedFailureChecks = executedChecks.filter(command => command.expectedFailure);
  check('FINAL_VALIDATION_LOGS_BOUND', ['PASS_INTERNAL_VALIDATION_WITH_EXPECTED_OFFICIAL_TARGET_BLOCKER', 'BLOCKED_SOURCE_PACKAGE_MISMATCH'].includes(validation.overallStatus) &&
    validationLogsMatch && validation.files.length > 0 && expectedChecks.every(command => command.exitCode === 0 && (command.expectedExitCode === undefined || command.exitCode === command.expectedExitCode)) &&
    expectedFailureChecks.every(command => command.exitCode !== 0 && (command.expectedExitCode === undefined || command.exitCode === command.expectedExitCode) && typeof command.expectedFailureReason === 'string'),
    'raw validation logs and exit codes are hash-bound; expected blocker failures are explicitly classified rather than hidden');
  const currentReadiness = parseStrictJson(readStableFile(path.join(pack, 'validation-logs/current-readiness.json')), 'Current Phase 1 readiness');
  check('PHASE1_ACCEPTANCE_STATE_PRESERVED', currentReadiness.decision === 'BLOCKED_NO_TRUSTED_CORPUS_OR_REAL_AB_RUNS' &&
    currentReadiness.sourceProtocol?.targetBinding?.executionGateOpen === false && currentReadiness.sourceProtocol?.targetBinding?.releaseApproved === false &&
    currentReadiness.sourceProtocol?.targetBinding?.candidateBundleSha256 === '9d836dca9daec26b53a104f99028fb30fd11848e8c0a8764c4eb7dedd45e1c37',
    'live readiness recheck remains blocked against the configured official target; no acceptance or execution gate is promoted');
  const developmentAlignment = parseStrictJson(readStableFile(path.join(pack, 'validation-logs/development-candidate-alignment.json')), 'Development candidate alignment');
  const targetAlignmentLog = readStableFile(path.join(pack, 'validation-logs/configured-target-alignment.log'), 'utf8');
  const developmentAlignmentLog = readStableFile(path.join(pack, 'validation-logs/development-candidate-alignment.log'), 'utf8');
  const developmentAlignmentRecorded = developmentAlignment.status === 'PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT'
    ? developmentAlignment.bundleSha256 === '7fb5f547eda71a717d10358510e1ea7baee46f5f9bcea3efc2891c6293bd3bc0'
    : developmentAlignment.status === 'BLOCKED_SOURCE_ALIGNMENT' && developmentAlignment.bundleSha256 === '7fb5f547eda71a717d10358510e1ea7baee46f5f9bcea3efc2891c6293bd3bc0' &&
      developmentAlignment.exitCode === 1 && developmentAlignmentLog.includes('source/archive byte mismatch');
  check('CANDIDATE_ALIGNMENT_DIFFERENCE_RECORDED', developmentAlignmentRecorded && targetAlignmentLog.includes('source/archive byte mismatch') &&
    validation.commands.some(command => command.label === 'configured-target-source-alignment' && command.exitCode === 1 && command.expectedFailure === true),
    'source/package compatibility is explicitly recorded as PASS or BLOCKED against the unchanged development candidate; official-target mismatch remains a blocker and no archive is rebuilt');
} catch (error) {
  blockers.push({ id: 'PACK_VERIFICATION_ERROR', detail: error.message });
}
const report = {
  schemaVersion: 1, kind: 'agg_phase2_evidence_pack_verification', verificationStatus: blockers.length ? 'BLOCKED' : 'VERIFIED',
  evidenceStatus: blockers.length ? 'BLOCKED' : 'INTEGRITY_ONLY', acceptanceStatus: 'ACCEPTANCE_REQUIRED', readiness: 'BLOCKED', executionGate: 'CLOSED',
  pack: path.relative(repoRoot, pack), manifestSha256: manifestHash, anchor: {
    expectedManifestSha256: expectedManifestHash ?? null,
    actualManifestSha256: manifestHash,
    trustedPublicKeySha256: anchorKeySha256,
    detachedSignatureSupplied: anchorSignatureBase64 !== undefined,
    signatureVerified: anchorSignatureValid,
    trustRootProvisioned: Boolean(trustedAnchorPem)
  }, inventoryCount: inventory.length, inventory,
  checks, blockers, limitations: [
    'INTEGRITY_ONLY is not comprehensive behavioral verification or operational acceptance; the independent reference replay covers the declared bounded algorithm and fixtures only.',
    'The manifest and source snapshot prove internal byte identity, not ground-truth label validity or operational effectiveness.',
    ...(!anchorTrusted
      ? ['No authenticated trust anchor was established. A command-line digest, a digest recomputed from this pack, or a signature without an externally provisioned Ed25519 trust root is insufficient. The owner/authority must provision AGG_PHASE2_TRUSTED_ANCHOR_PUBLIC_KEY_PEM out-of-band and supply the detached signature over agg-phase2-manifest-sha256:v1:<digest>.']
      : ['The detached Ed25519 signature authenticates the manifest digest under the externally provisioned public key; this proves manifest identity only, not operational acceptance.']),
    'Exact command arguments are reconciled against the declared workflow and outputs are independently recomputed, but raw logs and the command ledger are not signed execution attestations.',
    'Stable descriptor reads reduce per-file TOCTOU risk; Node path-based directory traversal and Git worktree snapshots are not an atomic filesystem-wide snapshot and do not eliminate a hostile concurrent same-user rename/revert race.',
    'The independent workflow verifier result is separately included and bound by this pack manifest; reference audit code shares the JavaScript runtime and the declared AGG semantics.'
  ]
};
const parentStat = fs.lstatSync(path.dirname(output));
if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || fs.realpathSync(path.dirname(output)) !== path.dirname(output)) throw new Error('Verifier output parent must be an existing canonical non-symlink directory');
writeFileExclusiveAtomic(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ output, verificationStatus: report.verificationStatus, evidenceStatus: report.evidenceStatus,
  manifestSha256: report.manifestSha256, inventoryCount: report.inventoryCount, passed: checks.filter(item => item.status === 'PASS').length, blockers }, null, 2));
if (blockers.length) process.exitCode = 2;
