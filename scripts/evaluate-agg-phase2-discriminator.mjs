#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseStrictJson } from '../src/runtime/strict-json.js';
import { canonicalJson } from '../src/runtime/canonical-json.js';
import { readStableRegularFile, writeFileExclusiveAtomic } from '../src/runtime/exclusive-file.js';
import { evaluateAdaptiveGoalDiscriminator, trainAdaptiveGoalDiscriminator, validateAdaptiveGoalDiscriminatorModel } from '../src/runtime/adaptive-goal-discriminator.js';
import { validateAdaptiveGoalPhase2Dataset, validateAdaptiveGoalPhase2ModelArtifact } from '../src/runtime/adaptive-goal-phase2-dataset.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceHash = relative => hash(fs.readFileSync(path.join(repoRoot, relative)));
const args = process.argv.slice(2);
const values = new Map();
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (key === '--help') { console.log('Usage: node scripts/evaluate-agg-phase2-discriminator.mjs --dataset DATASET.json --model MODEL.json --output NEW_EVALUATION.json'); process.exit(0); }
  if (!['--dataset', '--model', '--output'].includes(key)) throw new Error(`Unknown argument: ${key}`);
  if (values.has(key)) throw new Error(`Duplicate argument: ${key}`);
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
  values.set(key, path.resolve(args[++i]));
}
for (const key of ['--dataset', '--model', '--output']) if (!values.has(key)) throw new Error(`Required argument missing: ${key}`);
const outputPath = values.get('--output');
const outputParent = path.dirname(outputPath);
const outputParentStat = fs.lstatSync(outputParent);
if (!outputParentStat.isDirectory() || outputParentStat.isSymbolicLink() || fs.realpathSync(outputParent) !== outputParent || fs.existsSync(outputPath)) throw new Error('Output must be a new file in an existing canonical non-symlink directory');

function readRegular(filePath, label) {
  const bytes = readStableRegularFile(filePath, { maxBytes: 8 * 1024 * 1024, label });
  return { bytes, value: parseStrictJson(bytes, label, { maxBytes: 8 * 1024 * 1024 }) };
}
const datasetFile = readRegular(values.get('--dataset'), 'Phase 2 dataset');
const dataset = validateAdaptiveGoalPhase2Dataset(datasetFile.value);
const modelFile = readRegular(values.get('--model'), 'Phase 2 model artifact');
const artifact = validateAdaptiveGoalPhase2ModelArtifact(modelFile.value);
const expectedModelSources = {
  trainerCliSha256: sourceHash('scripts/train-agg-phase2-discriminator.mjs'),
  discriminatorSha256: sourceHash('src/runtime/adaptive-goal-discriminator.js'),
  datasetValidatorSha256: sourceHash('src/runtime/adaptive-goal-phase2-dataset.js'),
  strictJsonParserSha256: sourceHash('src/runtime/strict-json.js'),
  canonicalJsonSha256: sourceHash('src/runtime/canonical-json.js')
};
if (canonicalJson(artifact.sourceIdentity) !== canonicalJson(expectedModelSources)) throw new Error('Stale model source identity; retrain from the current source tree');
const model = validateAdaptiveGoalDiscriminatorModel(artifact.model);
const expectedValidation = evaluateAdaptiveGoalDiscriminator(model, dataset.validationExamples);
if (JSON.stringify(artifact.validation) !== JSON.stringify(expectedValidation)) throw new Error('Model validation summary does not match the current validation split');
if (artifact.datasetId !== dataset.datasetId || artifact.datasetFileSha256 !== hash(datasetFile.bytes) || artifact.datasetSha256 !== dataset.datasetSha256 ||
    model.datasetId !== dataset.datasetId || model.trainingDataSha256 !== dataset.splits.training.sha256 ||
    model.validationDataSha256 !== dataset.splits.validation.sha256 || artifact.splitIdentities?.holdout?.sha256 !== dataset.splits.holdout.sha256) {
  throw new Error('Model/dataset/split identity mismatch; refusing holdout evaluation');
}
const evaluation = evaluateAdaptiveGoalDiscriminator(model, dataset.holdoutExamples);
const negativeTraining = dataset.trainingExamples.filter(item => item.label === 0);
const positiveTraining = dataset.trainingExamples.filter(item => item.label === 1);
const minorityCount = Math.min(negativeTraining.length, positiveTraining.length);
let classImbalanceSensitivity;
if (negativeTraining.length === positiveTraining.length) {
  classImbalanceSensitivity = { status: 'NOT_NEEDED_TRAIN_SPLIT_BALANCED', trainingClassBalance: model.trainingClassCounts,
    majorityToMinorityRatio: 1, balancedSubsetModelSha256: null, holdoutUsedForSelection: false };
} else if (minorityCount < 2) {
  classImbalanceSensitivity = { status: 'INSUFFICIENT_MINORITY_CLASS_FOR_BALANCED_SUBSET', trainingClassBalance: model.trainingClassCounts,
    majorityToMinorityRatio: Math.max(negativeTraining.length, positiveTraining.length) / minorityCount, balancedSubsetModelSha256: null, holdoutUsedForSelection: false };
} else {
  const balancedTraining = [...negativeTraining.slice(0, minorityCount), ...positiveTraining.slice(0, minorityCount)].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const sensitivityModel = trainAdaptiveGoalDiscriminator({ trainingExamples: balancedTraining, validationExamples: dataset.validationExamples,
    ...model.trainingConfig, datasetId: 'balanced-sensitivity-diagnostic' }).model;
  classImbalanceSensitivity = { status: 'DIAGNOSTIC_RETRAIN_NO_MODEL_SELECTION', trainingClassBalance: model.trainingClassCounts,
    majorityToMinorityRatio: Math.max(negativeTraining.length, positiveTraining.length) / minorityCount,
    balancedSubsetClassBalance: { negative: minorityCount, positive: minorityCount }, balancedSubsetModelSha256: sensitivityModel.modelSha256,
    originalModelHoldoutMetrics: evaluation.metrics,
    balancedSubsetHoldoutMetrics: evaluateAdaptiveGoalDiscriminator(sensitivityModel, dataset.holdoutExamples).metrics,
    holdoutUsedForSelection: false, note: 'diagnostic comparison only; main model remains unchanged' };
}
const result = {
  schemaVersion: 1, kind: 'agg_phase2_independent_holdout_evaluation',
  datasetId: dataset.datasetId, datasetFileSha256: hash(datasetFile.bytes), datasetSha256: dataset.datasetSha256,
  splitIdentities: dataset.splits, modelArtifactSha256: hash(modelFile.bytes), modelSha256: model.modelSha256,
  sourceIdentity: { evaluatorCliSha256: sourceHash('scripts/evaluate-agg-phase2-discriminator.mjs'), discriminatorSha256: sourceHash('src/runtime/adaptive-goal-discriminator.js'), datasetValidatorSha256: sourceHash('src/runtime/adaptive-goal-phase2-dataset.js'), strictJsonParserSha256: sourceHash('src/runtime/strict-json.js'), canonicalJsonSha256: sourceHash('src/runtime/canonical-json.js') },
  featureSchemaVersion: dataset.featureSchemaVersion, holdoutEvaluation: evaluation,
  classImbalanceSensitivity,
  holdoutUse: 'evaluation_only_no_model_selection', evidenceLevel: 'offline_unattested',
  acceptance: 'acceptance_required', execution: { enabled: false, authorized: false, dispatched: false }
};
writeFileExclusiveAtomic(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ output: outputPath, modelSha256: model.modelSha256, holdoutCount: evaluation.evaluationExampleCount,
  metrics: evaluation.metrics, evidenceLevel: result.evidenceLevel, acceptance: result.acceptance }, null, 2));
