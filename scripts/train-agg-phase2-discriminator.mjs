#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseStrictJson } from '../src/runtime/strict-json.js';
import { canonicalJson } from '../src/runtime/canonical-json.js';
import { readStableRegularFile, writeFileExclusiveAtomic } from '../src/runtime/exclusive-file.js';
import { trainAdaptiveGoalDiscriminator } from '../src/runtime/adaptive-goal-discriminator.js';
import { validateAdaptiveGoalPhase2Dataset } from '../src/runtime/adaptive-goal-phase2-dataset.js';

const MAX_DATASET_BYTES = 8 * 1024 * 1024;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceHash = relative => createHash('sha256').update(fs.readFileSync(path.join(repoRoot, relative))).digest('hex');
const args = process.argv.slice(2);
let inputPath;
let outputPath;
let learningRate = 0.15;
let epochs = 1500;
let l2 = 0.01;
let seed = 0;
const seenArgs = new Set();

function usage() {
  console.log('Usage: node scripts/train-agg-phase2-discriminator.mjs --input DATASET.json --output NEW_MODEL.json [--learning-rate N] [--epochs N] [--l2 N] [--seed N]\n\nDataset schema requires schemaVersion, featureSchemaVersion, datasetId, independent labelProvenance metadata, and disjoint trainingExamples/validationExamples/holdoutExamples splits. All splits require both labels. The holdout split is bound but never read by the fitting or validation metric code. Outputs are exclusive. Metrics are offline diagnostics, not acceptance evidence.');
}

for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--help') { usage(); process.exit(0); }
  if (!['--input', '--output', '--learning-rate', '--epochs', '--l2', '--seed'].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
  if (seenArgs.has(arg)) throw new Error(`Duplicate argument: ${arg}`);
  seenArgs.add(arg);
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
  const value = args[++index];
  if (arg === '--input') inputPath = path.resolve(value);
  else if (arg === '--output') outputPath = path.resolve(value);
  else if (arg === '--learning-rate') learningRate = Number(value);
  else if (arg === '--epochs') epochs = Number(value);
  else if (arg === '--l2') l2 = Number(value);
  else if (arg === '--seed') seed = Number(value);
}

if (!inputPath || !outputPath) {
  usage();
  process.exitCode = 2;
} else {
  const outputParent = path.dirname(outputPath);
  const outputParentStat = fs.lstatSync(outputParent);
  if (!outputParentStat.isDirectory() || outputParentStat.isSymbolicLink() || fs.realpathSync(outputParent) !== outputParent || fs.existsSync(outputPath)) throw new Error('Output must be a new file in an existing canonical non-symlink directory');
  const inputBytes = readStableRegularFile(inputPath, { maxBytes: MAX_DATASET_BYTES, label: 'Input dataset' });
  const dataset = parseStrictJson(inputBytes, 'Phase 2 discriminator dataset', { maxBytes: MAX_DATASET_BYTES });
  const validated = validateAdaptiveGoalPhase2Dataset(dataset);
  const trained = trainAdaptiveGoalDiscriminator({
    trainingExamples: validated.trainingExamples,
    validationExamples: validated.validationExamples,
    learningRate, epochs, l2, seed, datasetId: validated.datasetId
  });
  const artifact = {
    schemaVersion: 2,
    kind: 'agg_phase2_discriminator_model',
    datasetId: validated.datasetId,
    datasetFileSha256: createHash('sha256').update(inputBytes).digest('hex'),
    datasetSha256: validated.datasetSha256,
    featureSchemaVersion: validated.featureSchemaVersion,
    labelProvenance: validated.labelProvenance,
    provenanceAssessment: validated.provenanceAssessment,
    splitIdentities: validated.splits,
    sourceIdentity: {
      trainerCliSha256: sourceHash('scripts/train-agg-phase2-discriminator.mjs'),
      discriminatorSha256: sourceHash('src/runtime/adaptive-goal-discriminator.js'),
      datasetValidatorSha256: sourceHash('src/runtime/adaptive-goal-phase2-dataset.js'),
      strictJsonParserSha256: sourceHash('src/runtime/strict-json.js'),
      canonicalJsonSha256: sourceHash('src/runtime/canonical-json.js')
    },
    model: trained.model,
    training: trained.training,
    validation: trained.validation,
    status: 'offline_shadow_model_not_acceptance',
    acceptance: 'acceptance_required',
    execution: { enabled: false, authorized: false, dispatched: false }
  };
  artifact.artifactSha256 = createHash('sha256').update(canonicalJson(artifact)).digest('hex');
  const outputBytes = `${JSON.stringify(artifact, null, 2)}\n`;
  writeFileExclusiveAtomic(outputPath, outputBytes, { mode: 0o600 });
  console.log(JSON.stringify({ outputPath, datasetId: artifact.datasetId, datasetFileSha256: artifact.datasetFileSha256,
    datasetSha256: artifact.datasetSha256, splitIdentities: artifact.splitIdentities,
    modelSha256: artifact.model.modelSha256, training: artifact.training, validation: artifact.validation,
    status: artifact.status }, null, 2));
}
