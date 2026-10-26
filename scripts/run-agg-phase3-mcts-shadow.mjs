#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseStrictJson } from '../src/runtime/strict-json.js';
import { canonicalJson } from '../src/runtime/canonical-json.js';
import { readStableRegularFile, writeFileExclusiveAtomic } from '../src/runtime/exclusive-file.js';
import { trainAdaptiveGoalDiscriminator, validateAdaptiveGoalDiscriminatorModel } from '../src/runtime/adaptive-goal-discriminator.js';
import { validateAdaptiveGoalPhase2Dataset, validateAdaptiveGoalPhase2ModelArtifact } from '../src/runtime/adaptive-goal-phase2-dataset.js';
import { searchAdaptiveGoalGraphPhase3MCTS } from '../src/runtime/adaptive-goal-phase3-mcts.js';

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceHash = relative => hash(fs.readFileSync(path.join(repoRoot, relative)));
const args = process.argv.slice(2);
const values = new Map();
const allowed = [
  '--graph', '--dataset', '--model', '--output', '--simulations', '--max-depth', '--max-expansions', '--max-work-units', '--max-audit-events',
  '--candidate-limit', '--max-tree-nodes', '--max-terminal-paths', '--exploration-constant', '--seed', '--initially-available-ids'
];

function usage() {
  console.log('Usage: node scripts/run-agg-phase3-mcts-shadow.mjs --graph GRAPH.json --dataset DATASET.json --model MODEL.json --output NEW_RESULT.json [--simulations N] [--max-depth N] [--max-expansions N] [--max-work-units N] [--max-audit-events N] [--candidate-limit N] [--max-tree-nodes N] [--max-terminal-paths N] [--exploration-constant N] [--seed N] [--initially-available-ids id1,id2]\n\nValidates exact model/dataset bytes, source identity and deterministic training replay before bounded UCT/MCTS. Deterministic work/tree/terminal-record caps bound algorithmic cost; they are not OS CPU or memory quotas. All outputs remain shadow proposals; this command never executes a plan, changes readiness, or opens a gate. Output is created exclusively.');
}

for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--help') { usage(); process.exit(0); }
  if (!allowed.includes(arg)) throw new Error(`Unknown argument: ${arg}`);
  if (values.has(arg)) throw new Error(`Duplicate argument: ${arg}`);
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
  values.set(arg, args[++index]);
}
for (const key of ['--graph', '--dataset', '--model', '--output']) if (!values.has(key)) throw new Error(`Required argument missing: ${key}`);

const integerOption = (key, fallback, min, max) => {
  const value = values.has(key) ? Number(values.get(key)) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer in [${min}, ${max}]`);
  return value;
};
const floatOption = (key, fallback, min, max) => {
  const value = values.has(key) ? Number(values.get(key)) : fallback;
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} must be finite in [${min}, ${max}]`);
  return value;
};
const options = {
  maxSimulations: integerOption('--simulations', 128, 1, 10000),
  maxDepth: integerOption('--max-depth', 12, 1, 100),
  maxExpansions: integerOption('--max-expansions', 128, 1, 10000),
  maxWorkUnits: integerOption('--max-work-units', 100000, 2, 1000000),
  maxAuditEvents: integerOption('--max-audit-events', 2000, 1, 5000),
  candidateLimit: integerOption('--candidate-limit', 4, 1, 100),
  maxTreeNodes: integerOption('--max-tree-nodes', 2048, 1, 10001),
  maxTerminalPaths: integerOption('--max-terminal-paths', 2048, 1, 10000),
  explorationConstant: floatOption('--exploration-constant', Math.SQRT2, 0, 10),
  seed: integerOption('--seed', 0, 0, Number.MAX_SAFE_INTEGER),
  initiallyAvailableIds: values.has('--initially-available-ids')
    ? values.get('--initially-available-ids').split(',').map(value => value.trim()).filter(Boolean)
    : []
};
if (values.has('--initially-available-ids') && !options.initiallyAvailableIds.length) throw new Error('--initially-available-ids must contain at least one node ID');

const graphPath = path.resolve(values.get('--graph'));
const datasetPath = path.resolve(values.get('--dataset'));
const modelPath = path.resolve(values.get('--model'));
const outputPath = path.resolve(values.get('--output'));
const outputParent = path.dirname(outputPath);
const parentStat = fs.lstatSync(outputParent);
if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || fs.realpathSync(outputParent) !== outputParent || fs.existsSync(outputPath)) {
  throw new Error('Output must be a new file in an existing canonical non-symlink directory');
}
function readJson(filePath, label) {
  const bytes = readStableRegularFile(filePath, { maxBytes: MAX_INPUT_BYTES, label });
  return { bytes, value: parseStrictJson(bytes, label, { maxBytes: MAX_INPUT_BYTES }) };
}

const graphFile = readJson(graphPath, 'Phase 3 MCTS graph');
const datasetFile = readJson(datasetPath, 'Phase 3 discriminator dataset');
const dataset = validateAdaptiveGoalPhase2Dataset(datasetFile.value);
const modelFile = readJson(modelPath, 'Phase 3 MCTS discriminator model artifact');
const modelArtifact = validateAdaptiveGoalPhase2ModelArtifact(modelFile.value);
const expectedModelSources = {
  trainerCliSha256: sourceHash('scripts/train-agg-phase2-discriminator.mjs'),
  discriminatorSha256: sourceHash('src/runtime/adaptive-goal-discriminator.js'),
  datasetValidatorSha256: sourceHash('src/runtime/adaptive-goal-phase2-dataset.js'),
  strictJsonParserSha256: sourceHash('src/runtime/strict-json.js'),
  canonicalJsonSha256: sourceHash('src/runtime/canonical-json.js')
};
if (canonicalJson(modelFile.value.sourceIdentity) !== canonicalJson(expectedModelSources)) {
  throw new Error('Stale model source identity; retrain from the current Phase 2 source tree');
}
if (modelArtifact.datasetFileSha256 !== hash(datasetFile.bytes) || modelArtifact.datasetSha256 !== dataset.datasetSha256 ||
    modelArtifact.datasetId !== dataset.datasetId || canonicalJson(modelArtifact.splitIdentities) !== canonicalJson(dataset.splits) ||
    canonicalJson(modelArtifact.labelProvenance) !== canonicalJson(dataset.labelProvenance)) {
  throw new Error('Model artifact is not bound to the exact dataset bytes/splits/provenance supplied to this run');
}
const model = validateAdaptiveGoalDiscriminatorModel(modelArtifact.model);
const replayedModel = trainAdaptiveGoalDiscriminator({
  trainingExamples: dataset.trainingExamples, validationExamples: dataset.validationExamples,
  ...model.trainingConfig, datasetId: dataset.datasetId
}).model;
if (replayedModel.modelSha256 !== model.modelSha256 || canonicalJson(replayedModel) !== canonicalJson(model)) {
  throw new Error('Model identity does not replay from the bound training split and recorded configuration');
}
const result = searchAdaptiveGoalGraphPhase3MCTS(graphFile.value, model, options);
const artifact = {
  schemaVersion: 1,
  kind: 'agg_phase3_mcts_shadow_search_result',
  graphFileSha256: hash(graphFile.bytes),
  graphHash: result.graphHash,
  datasetFileSha256: hash(datasetFile.bytes),
  datasetId: dataset.datasetId,
  datasetSha256: dataset.datasetSha256,
  datasetSplitIdentities: dataset.splits,
  modelArtifactSha256: hash(modelFile.bytes),
  modelSha256: model.modelSha256,
  featureSchemaVersion: modelFile.value.featureSchemaVersion,
  splitIdentities: modelFile.value.splitIdentities,
  runtime: { nodeVersion: process.version, platform: process.platform, architecture: process.arch },
  sourceIdentity: {
    runnerCliSha256: sourceHash('scripts/run-agg-phase3-mcts-shadow.mjs'),
    phase3MctsSha256: sourceHash('src/runtime/adaptive-goal-phase3-mcts.js'),
    phase2DiscriminatorSha256: sourceHash('src/runtime/adaptive-goal-discriminator.js'),
    phase1GraphValidatorSha256: sourceHash('src/runtime/adaptive-goal-graph.js'),
    strictJsonParserSha256: sourceHash('src/runtime/strict-json.js'),
    canonicalJsonSha256: sourceHash('src/runtime/canonical-json.js')
  },
  modelIdentityAssessment: {
    exactDatasetBytesMatched: true, sourceIdentityMatchedCurrentSource: true,
    deterministicTrainingReplayMatched: true, trustedModelAttestationPresent: false,
    independentTrainingLabelAttestationPresent: false
  },
  result,
  status: 'offline_shadow_not_acceptance',
  acceptance: 'acceptance_required',
  execution: { enabled: false, authorized: false, dispatched: false },
  gates: { immutableExecutionPlanCreated: false, dispatchAllowed: false, executionAuthorized: false }
};
artifact.artifactSha256 = hash(canonicalJson(artifact));
writeFileExclusiveAtomic(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ outputPath, graphHash: result.graphHash, modelSha256: result.search.discriminatorModelSha256,
  status: result.status, simulationCount: result.search.simulations, expansions: result.search.expansions,
  candidateCount: result.candidates.length, acceptance: result.search.acceptance,
  executionAuthorized: result.search.executionAuthorized }, null, 2));
