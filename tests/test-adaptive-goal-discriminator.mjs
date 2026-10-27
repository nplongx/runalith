import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ADAPTIVE_GOAL_DISCRIMINATOR_FEATURES,
  evaluateAdaptiveGoalDiscriminator,
  extractAdaptiveGoalDiscriminatorFeatures,
  scoreAdaptiveGoalDiscriminator,
  trainAdaptiveGoalDiscriminator,
  validateAdaptiveGoalDiscriminatorModel
} from '../src/runtime/adaptive-goal-discriminator.js';
import { searchAdaptiveGoalGraph } from '../src/runtime/adaptive-goal-graph.js';
import { createAdaptiveGoalDiscriminatorExample, searchAdaptiveGoalGraphPhase2 } from '../src/runtime/adaptive-goal-phase2-search.js';
import { projectAdaptiveGoalPhase2CandidateToPlanGraphShadow } from '../src/runtime/adaptive-goal-phase2-plan-shadow.js';
import { validateAdaptiveGoalPhase2Dataset, validateAdaptiveGoalPhase2ModelArtifact } from '../src/runtime/adaptive-goal-phase2-dataset.js';
import { canonicalJson } from '../src/runtime/canonical-json.js';
import { readStableRegularFile, writeFileExclusiveAtomic } from '../src/runtime/exclusive-file.js';

const canonicalHash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');

function features(informationValue) {
  return Object.fromEntries(ADAPTIVE_GOAL_DISCRIMINATOR_FEATURES.map(name => [name,
    name === 'informationValue' ? informationValue : 0.5]));
}

function trainFixture() {
  const trainingExamples = [
    ...[0.8, 0.85, 0.9, 0.95, 0.88, 0.92].map((value, index) => ({ id: `train-positive-${index}`, features: features(value), label: 1 })),
    ...[0.05, 0.1, 0.15, 0.2, 0.12, 0.08].map((value, index) => ({ id: `train-negative-${index}`, features: features(value), label: 0 }))
  ];
  const validationExamples = [
    { id: 'validation-positive-1', features: features(0.87), label: 1 },
    { id: 'validation-positive-2', features: features(0.91), label: 1 },
    { id: 'validation-negative-1', features: features(0.09), label: 0 },
    { id: 'validation-negative-2', features: features(0.18), label: 0 }
  ];
  return { trainingExamples, validationExamples };
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('exclusive output publication exposes only complete bytes and never overwrites a collision', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-phase2-atomic-output-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const target = path.join(temp, 'result.json');
  const payload = `${JSON.stringify({ status: 'complete', records: Array.from({ length: 128 }, (_, index) => index) })}\n`;
  assert.deepEqual(writeFileExclusiveAtomic(target, payload), { path: target, sizeBytes: Buffer.byteLength(payload) });
  assert.equal(fs.readFileSync(target, 'utf8'), payload);
  assert.deepEqual(fs.readdirSync(temp), ['result.json'], 'successful publication leaves no sibling temp file');
  assert.throws(() => writeFileExclusiveAtomic(target, 'incomplete replacement'), error => error.code === 'EEXIST');
  assert.equal(fs.readFileSync(target, 'utf8'), payload, 'a destination collision leaves the original bytes unchanged');
  assert.deepEqual(fs.readdirSync(temp), ['result.json'], 'failed publication cleans up only its own temp file');

  const originalLink = fs.linkSync;
  const unsupportedPath = path.join(temp, 'unsupported-hardlink.json');
  try {
    fs.linkSync = () => { const error = new Error('hard links unsupported'); error.code = 'EOPNOTSUPP'; throw error; };
    assert.throws(() => writeFileExclusiveAtomic(unsupportedPath, 'payload'), error => error.code === 'EOPNOTSUPP');
    assert.equal(fs.existsSync(unsupportedPath), false, 'unsupported filesystem publication must not leave a destination artifact');
    assert.deepEqual(fs.readdirSync(temp), ['result.json'], 'unsupported publication cleans its temporary inode');
  } finally { fs.linkSync = originalLink; }

  const originalFsync = fs.fsyncSync;
  const fsyncFailurePath = path.join(temp, 'fsync-failure.json');
  try {
    fs.fsyncSync = () => { const error = new Error('simulated fsync failure'); error.code = 'EIO'; throw error; };
    assert.throws(() => writeFileExclusiveAtomic(fsyncFailurePath, 'payload'), error => error.code === 'EIO');
    assert.equal(fs.existsSync(fsyncFailurePath), false, 'a failed file fsync must prevent publication');
    assert.deepEqual(fs.readdirSync(temp), ['result.json'], 'fsync failure cleans its temporary file');
  } finally { fs.fsyncSync = originalFsync; }
});

test('exclusive output publication rejects symlinked/non-canonical parents and preserves symlink targets', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-phase2-atomic-path-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const real = path.join(temp, 'real');
  fs.mkdirSync(real);
  const target = path.join(real, 'target.txt');
  fs.writeFileSync(target, 'trusted bytes');
  fs.symlinkSync(real, path.join(temp, 'alias'), 'dir');
  assert.deepEqual(readStableRegularFile(target, { maxBytes: 32, label: 'test input' }), Buffer.from('trusted bytes'));
  assert.throws(() => readStableRegularFile(path.join(real, 'target.txt'), { maxBytes: 4, label: 'oversized input' }), /byte limit/);
  fs.symlinkSync(target, path.join(real, 'input-link.txt'));
  assert.throws(() => readStableRegularFile(path.join(real, 'input-link.txt'), { maxBytes: 32, label: 'symlink input' }), /canonical regular non-symlink/);
  assert.throws(() => writeFileExclusiveAtomic(path.join(temp, 'alias', 'escaped.json'), 'payload'), /canonical|symlinks/);
  assert.throws(() => writeFileExclusiveAtomic(`${real}/../real/escaped.json`, 'payload'), /canonical/);
  fs.symlinkSync(target, path.join(real, 'output-link.txt'));
  assert.throws(() => writeFileExclusiveAtomic(path.join(real, 'output-link.txt'), 'replacement'), error => error.code === 'EEXIST');
  assert.equal(fs.readFileSync(target, 'utf8'), 'trusted bytes', 'an existing symlink target is never followed or overwritten');
  assert.deepEqual(fs.readdirSync(real).sort(), ['input-link.txt', 'output-link.txt', 'target.txt'], 'path rejection and collision leave no temporary files');
});

const deferredManifestBaselineInputs = path.join(repoRoot, 'artifacts/agg-phase2-workflow-20261024T071500Z-stable-read-command-ledger-anchor-hardening-successor/inputs');
const deferredManifestBaselineMissing = ['dataset.json', 'benchmark-corpus.json', 'graph.json']
  .some(name => !fs.existsSync(path.join(deferredManifestBaselineInputs, name)));
test('workflow can defer manifest publication until final receipts are attached', {
  skip: deferredManifestBaselineMissing
    ? 'historical Phase 2 input pack is ignored local evidence and is not present in a clean checkout'
    : false
}, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-phase2-deferred-manifest-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const baselineInputs = deferredManifestBaselineInputs;
  const outputDir = path.join(temp, 'deferred-pack');
  const run = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/run-agg-phase2-workflow.mjs'),
    '--dataset', path.join(baselineInputs, 'dataset.json'), '--corpus', path.join(baselineInputs, 'benchmark-corpus.json'),
    '--graph', path.join(baselineInputs, 'graph.json'), '--output-dir', outputDir, '--beam-width', '1', '--epochs', '50', '--defer-manifest'],
  { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
  const summary = JSON.parse(run.stdout);
  assert.equal(run.status, 2, 'source edits must block workflow generation while the pinned development candidate is byte-stale');
  assert.equal(summary.status, 'BLOCKED');
  assert.match(summary.error, /development-candidate-source-alignment/);
  assert.equal(summary.manifestPublication, 'DEFERRED');
  assert.equal(summary.manifestSha256, null, 'deferred publication must not claim a manifest identity that has not been published');
  assert.equal(fs.existsSync(path.join(outputDir, 'SHA256SUMS.txt')), false, 'the final manifest path must remain absent until finalization');
});

test('trains a deterministic, hash-bound logistic discriminator and evaluates held-out examples', () => {
  const input = trainFixture();
  const first = trainAdaptiveGoalDiscriminator(input);
  const second = trainAdaptiveGoalDiscriminator(input);
  const alternateSeed = trainAdaptiveGoalDiscriminator({ ...input, seed: 1 });
  const highSeed = trainAdaptiveGoalDiscriminator({ ...input, seed: 4294967296 });
  assert.equal(first.model.modelSha256, second.model.modelSha256);
  assert.notEqual(first.model.modelSha256, alternateSeed.model.modelSha256, 'the declared seed must affect deterministic initialization and the model identity');
  assert.notEqual(first.model.weights.informationValue, highSeed.model.weights.informationValue, 'seed bits above uint32 must affect initialization too');
  assert.equal(first.model.weights.successConfidence, 0, 'constant training features must not retain a coefficient that explodes under minimum-scale extrapolation');
  assert.equal(first.model.trainingDataSha256, second.model.trainingDataSha256);
  assert.equal(first.validation.evaluationExampleCount, 4);
  assert.equal(first.validation.metrics.accuracy, 1);
  assert.equal(first.validation.metrics.balancedAccuracy, 1);
  assert.equal(first.validation.accuracyTargetAssessment, 'INSUFFICIENT_SAMPLE_SIZE');
  assert.equal(first.validation.classification, 'offline_shadow_metrics_not_acceptance');
  assert.equal(validateAdaptiveGoalDiscriminatorModel(first.model).modelSha256, first.model.modelSha256);
  assert.ok(scoreAdaptiveGoalDiscriminator(first.model, features(0.9)).probability > scoreAdaptiveGoalDiscriminator(first.model, features(0.1)).probability);
  assert.deepEqual(evaluateAdaptiveGoalDiscriminator(first.model, input.validationExamples), first.validation);
  const reordered = Object.fromEntries(Object.entries(first.model).reverse());
  reordered.trainingConfig = Object.fromEntries(Object.entries(first.model.trainingConfig).reverse());
  reordered.featureNames = [...first.model.featureNames];
  assert.equal(validateAdaptiveGoalDiscriminatorModel(reordered).modelSha256, first.model.modelSha256,
    'model integrity hashes must not depend on JSON object member order');
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
  assert.throws(() => canonicalJson(Array(1)), /sparse arrays/);
  const accessorObject = {};
  Object.defineProperty(accessorObject, 'x', { enumerable: true, get() { throw new Error('getter must not execute'); } });
  assert.throws(() => canonicalJson(accessorObject), /accessors/);
});

test('rejects train/validation leakage, malformed features, and model tampering', () => {
  const input = trainFixture();
  assert.throws(() => trainAdaptiveGoalDiscriminator({
    ...input,
    validationExamples: [input.validationExamples[0], { ...input.validationExamples[1], id: input.trainingExamples[0].id }]
  }), /split leakage/);
  assert.throws(() => trainAdaptiveGoalDiscriminator({
    ...input,
    validationExamples: [input.validationExamples[0], { ...input.trainingExamples[0], id: 'new-validation-id' }]
  }), /identical feature vector/);
  assert.throws(() => trainAdaptiveGoalDiscriminator({
    ...input,
    validationExamples: [input.validationExamples[0], { ...input.trainingExamples[0], id: 'new-validation-opposite-label', label: 1 - input.trainingExamples[0].label }, ...input.validationExamples.slice(2)]
  }), /identical feature vector/);
  assert.throws(() => trainAdaptiveGoalDiscriminator({
    ...input,
    trainingExamples: input.trainingExamples.map((example, index) => index === 0
      ? { ...example, features: { ...example.features, surprise: 0.2 } } : example)
  }), /unsupported fields/);
  const model = trainAdaptiveGoalDiscriminator(input).model;
  assert.throws(() => validateAdaptiveGoalDiscriminatorModel({ ...model, intercept: model.intercept + 1 }), /hash mismatch/);
  assert.throws(() => scoreAdaptiveGoalDiscriminator(model, { ...features(0.5), informationValue: 1.1 }), /\[0, 1\]/);
  assert.throws(() => scoreAdaptiveGoalDiscriminator(model, { ...features(0.5), informationValue: -0 }), /negative zero|finite number/);
});

test('training API enforces a combined example-epoch resource budget before fitting', () => {
  const trainingExamples = Array.from({ length: 101 }, (_, index) => ({
    id: `bounded-train-${index}`, features: features(index / 101), label: index % 2
  }));
  const validationExamples = [
    { id: 'bounded-validation-negative', features: features(0.01), label: 0 },
    { id: 'bounded-validation-positive', features: features(0.99), label: 1 }
  ];
  assert.throws(() => trainAdaptiveGoalDiscriminator({ trainingExamples, validationExamples, epochs: 100000 }), /example-epoch budget/);
});

test('strict three-way dataset validation binds split identities and rejects duplicate content, overlap and synthetic-to-independent relabelling', () => {
  const split = trainFixture();
  const dataset = { schemaVersion: 1, featureSchemaVersion: 1, datasetId: 'dataset-contract-v1',
    labelProvenance: { kind: 'synthetic', source: 'test fixture', adjudicatorId: 'test-only', adjudicationProtocol: 'synthetic-v1', independent: false },
    ...split, holdoutExamples: [{ id: 'holdout-positive', features: features(0.79), label: 1 }, { id: 'holdout-negative', features: features(0.21), label: 0 }] };
  const validated = validateAdaptiveGoalPhase2Dataset(dataset);
  assert.match(validated.datasetSha256, /^[a-f0-9]{64}$/);
  assert.equal(validated.splits.training.count, 12);
  assert.equal(validated.splits.validation.count, 4);
  assert.equal(validated.splits.holdout.count, 2);
  assert.equal(validated.provenanceAssessment.independentAttestationPresent, false);
  assert.throws(() => validateAdaptiveGoalPhase2Dataset({ ...dataset,
    holdoutExamples: [{ ...dataset.trainingExamples[0], id: 'holdout-duplicate-id' }, dataset.holdoutExamples[1]] }), /split leakage by content/);
  assert.throws(() => validateAdaptiveGoalPhase2Dataset({ ...dataset,
    holdoutExamples: [{ ...dataset.trainingExamples.find(example => example.label === 0), id: 'holdout-same-features-opposite-label', label: 1 }, dataset.holdoutExamples[1]] }), /split leakage by content/,
  'identical feature vectors must not evade leakage detection by flipping the label');
  assert.throws(() => validateAdaptiveGoalPhase2Dataset({ ...dataset,
    holdoutExamples: [{ ...dataset.trainingExamples[0], id: dataset.trainingExamples[0].id }, dataset.holdoutExamples[1]] }), /split leakage by ID/);
  assert.throws(() => validateAdaptiveGoalPhase2Dataset({ ...dataset,
    labelProvenance: { ...dataset.labelProvenance, kind: 'independently_adjudicated' } }), /labelProvenance/);
  assert.throws(() => validateAdaptiveGoalPhase2Dataset({ ...dataset,
    trainingExamples: [{ ...dataset.trainingExamples[0], features: { ...dataset.trainingExamples[0].features, extraFeature: 0.5 } }, ...dataset.trainingExamples.slice(1)] }), /unsupported fields/);
  assert.throws(() => validateAdaptiveGoalPhase2Dataset({ ...dataset,
    holdoutExamples: [{ ...dataset.holdoutExamples[0], features: { ...dataset.holdoutExamples[0].features, informationValue: Number.NaN } }, dataset.holdoutExamples[1]] }), /finite in \[0, 1\]/);
  assert.throws(() => validateAdaptiveGoalPhase2Dataset({ ...dataset,
    holdoutExamples: [{ ...dataset.holdoutExamples[0], features: { ...dataset.holdoutExamples[0].features, informationValue: -0 } }, dataset.holdoutExamples[1]] }), /negative zero/);
  const reorderedProvenance = Object.fromEntries(Object.entries(dataset.labelProvenance).reverse());
  assert.equal(validateAdaptiveGoalPhase2Dataset({ ...dataset, labelProvenance: reorderedProvenance }).datasetSha256, validated.datasetSha256,
    'dataset provenance hashing must not depend on JSON object member order');
});

test('optional discriminator score changes shadow beam ranking without changing default search mode', () => {
  const { model } = trainAdaptiveGoalDiscriminator(trainFixture());
  const graph = {
    schemaVersion: 1,
    startNodeId: 'start',
    goalNodeId: 'goal',
    nodes: [
      { id: 'start', type: 'goal' },
      { id: 'a-direct-success-estimate', type: 'task', estimatedSuccessConfidence: 0.95, estimatedRisk: 0.1, estimatedCost: 1, reusePotential: 0.1, informationValue: 0.1 },
      { id: 'b-high-information', type: 'task', estimatedSuccessConfidence: 0.2, estimatedRisk: 0.8, estimatedCost: 4, reusePotential: 0.1, informationValue: 0.9 },
      { id: 'goal', type: 'goal' }
    ],
    edges: [
      { from: 'start', to: 'a-direct-success-estimate', type: 'next_step' },
      { from: 'start', to: 'b-high-information', type: 'next_step' },
      { from: 'a-direct-success-estimate', to: 'goal', type: 'next_step' },
      { from: 'b-high-information', to: 'goal', type: 'next_step' }
    ]
  };
  const baseline = searchAdaptiveGoalGraph(graph, { beamWidth: 1 });
  const shadow = searchAdaptiveGoalGraphPhase2(graph, model, { beamWidth: 1 });
  assert.equal(baseline.search.heuristicVersion, 'lexicographic-unknown-aware@2');
  assert.equal(baseline.candidates[0].pathNodeIds.includes('a-direct-success-estimate'), true);
  assert.equal(shadow.search.rankingMode, 'discriminator_shadow');
  assert.deepEqual(searchAdaptiveGoalGraphPhase2(graph, model, { beamWidth: 1 }), shadow, 'same graph/model/config must replay byte-stable search objects');
  const planGraphDraft = projectAdaptiveGoalPhase2CandidateToPlanGraphShadow(graph, model, shadow.candidates[0], shadow.search.options);
  assert.equal(planGraphDraft.kind, 'adaptive_goal_phase2_plan_graph_shadow_draft');
  assert.equal(planGraphDraft.status, 'review_required');
  assert.equal(planGraphDraft.gates.persisted, false);
  assert.equal(planGraphDraft.gates.immutableExecutionPlanCreated, false);
  assert.equal(planGraphDraft.gates.dispatchAllowed, false);
  assert.equal(planGraphDraft.gates.executionAuthorized, false);
  assert.ok(planGraphDraft.steps.every(step => step.execution.enabled === false && step.execution.authorization === 'none'));
  const truncatedTrace = searchAdaptiveGoalGraphPhase2(graph, model, { beamWidth: 2, maxAuditEvents: 1 });
  assert.equal(truncatedTrace.auditTrace.events.length, 1);
  assert.equal(truncatedTrace.auditTrace.truncated, true);
  assert.ok(truncatedTrace.auditTrace.omittedEventCount > 0);
  assert.equal(searchAdaptiveGoalGraphPhase2(graph, model, { beamWidth: 1, maxExpansions: 1 }).search.budgetExhausted, true);
  assert.equal(shadow.search.discriminatorModelSha256, model.modelSha256);
  assert.equal(shadow.candidates[0].pathNodeIds.includes('b-high-information'), true);
  assert.equal(shadow.mode, 'shadow');
  assert.equal(shadow.candidates[0].verification.verified, false);
  assert.equal(shadow.auditTrace.rankingMode, 'discriminator_shadow');
  const emptyFeatures = extractAdaptiveGoalDiscriminatorFeatures({ metrics: {}, semantics: {}, pathNodeIds: ['start'] });
  assert.equal(emptyFeatures.informationValue, 0);
  assert.ok(Object.values(emptyFeatures).every(value => value === 0));
});

test('Phase 2 CLI trains and runs a hash-bound shadow search without overwriting artifacts', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-phase2-discriminator-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const inputPath = path.join(temp, 'dataset.json');
  const modelPath = path.join(temp, 'model.json');
  const graphPath = path.join(temp, 'graph.json');
  const resultPath = path.join(temp, 'result.json');
  const fixtureSplits = trainFixture();
  const dataset = { schemaVersion: 1, featureSchemaVersion: 1, datasetId: 'test-labelled-set-v1',
    labelProvenance: { kind: 'synthetic', source: 'unit-test fixture', adjudicatorId: 'test-only', adjudicationProtocol: 'synthetic-v1', independent: false },
    ...fixtureSplits,
    holdoutExamples: [
      { id: 'holdout-positive-1', features: features(0.89), label: 1 },
      { id: 'holdout-negative-1', features: features(0.11), label: 0 }
    ] };
  fs.writeFileSync(inputPath, JSON.stringify(dataset));
  const trainingRun = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/train-agg-phase2-discriminator.mjs'), '--input', inputPath, '--output', modelPath], {
    cwd: repoRoot, encoding: 'utf8', timeout: 15000
  });
  assert.equal(trainingRun.status, 0, trainingRun.stderr);
  const modelArtifact = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  assert.equal(modelArtifact.schemaVersion, 2);
  assert.equal(modelArtifact.status, 'offline_shadow_model_not_acceptance');
  assert.equal(validateAdaptiveGoalPhase2ModelArtifact(modelArtifact).datasetId, dataset.datasetId);
  assert.throws(() => validateAdaptiveGoalPhase2ModelArtifact({ ...modelArtifact, injected: true }), /unsupported fields/);
  const missingSourceIdentity = structuredClone(modelArtifact);
  delete missingSourceIdentity.sourceIdentity.canonicalJsonSha256;
  const { artifactSha256: _missingSourceOldHash, ...missingSourceBody } = missingSourceIdentity;
  missingSourceIdentity.artifactSha256 = canonicalHash(missingSourceBody);
  assert.throws(() => validateAdaptiveGoalPhase2ModelArtifact(missingSourceIdentity), /missing a required source digest/,
    'recomputing an envelope hash must not make an incomplete source identity acceptable');
  assert.throws(() => validateAdaptiveGoalPhase2ModelArtifact({ ...modelArtifact, validation: { ...modelArtifact.validation, accuracyTargetAssessment: 'PASS' } }), /envelope hash mismatch/);
  const forgedTrainingMetrics = structuredClone(modelArtifact);
  forgedTrainingMetrics.model.trainingMetrics.accuracy = 0.99;
  const { modelSha256: _oldModelHash, ...modelBody } = forgedTrainingMetrics.model;
  forgedTrainingMetrics.model.modelSha256 = canonicalHash(modelBody);
  const { artifactSha256: _oldArtifactHash, ...artifactBody } = forgedTrainingMetrics;
  forgedTrainingMetrics.artifactSha256 = canonicalHash(artifactBody);
  assert.throws(() => validateAdaptiveGoalPhase2ModelArtifact(forgedTrainingMetrics), /training classification metrics are internally inconsistent/);
  const forgedValidationMetrics = structuredClone(modelArtifact);
  forgedValidationMetrics.validation.metrics.accuracy = 0.99;
  const { artifactSha256: _oldValidationHash, ...validationBody } = forgedValidationMetrics;
  forgedValidationMetrics.artifactSha256 = canonicalHash(validationBody);
  assert.throws(() => validateAdaptiveGoalPhase2ModelArtifact(forgedValidationMetrics), /validation.metrics classification metrics are internally inconsistent/);
  assert.match(modelArtifact.model.modelSha256, /^[a-f0-9]{64}$/);
  const originalModelBytes = fs.readFileSync(modelPath);
  const secondTraining = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/train-agg-phase2-discriminator.mjs'), '--input', inputPath, '--output', modelPath], {
    cwd: repoRoot, encoding: 'utf8', timeout: 15000
  });
  assert.notEqual(secondTraining.status, 0, 'existing model output must not be overwritten');
  assert.deepEqual(fs.readFileSync(modelPath), originalModelBytes);
  const duplicateArgumentOutput = path.join(temp, 'duplicate-argument-model.json');
  const duplicateArgumentRun = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/train-agg-phase2-discriminator.mjs'), '--input', inputPath, '--input', inputPath, '--output', duplicateArgumentOutput], {
    cwd: repoRoot, encoding: 'utf8', timeout: 15000
  });
  assert.notEqual(duplicateArgumentRun.status, 0, 'duplicate CLI arguments must be rejected');
  assert.equal(fs.existsSync(duplicateArgumentOutput), false);
  const duplicateKeyInput = path.join(temp, 'duplicate-key-dataset.json');
  fs.writeFileSync(duplicateKeyInput, '{"schemaVersion":1,"schemaVersion":1}');
  const duplicateKeyRun = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/train-agg-phase2-discriminator.mjs'), '--input', duplicateKeyInput, '--output', path.join(temp, 'duplicate-key-model.json')], {
    cwd: repoRoot, encoding: 'utf8', timeout: 15000
  });
  assert.notEqual(duplicateKeyRun.status, 0, 'duplicate decoded JSON keys must be rejected');

  const evaluationPath = path.join(temp, 'evaluation.json');
  const evaluation = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/evaluate-agg-phase2-discriminator.mjs'), '--dataset', inputPath, '--model', modelPath, '--output', evaluationPath], {
    cwd: repoRoot, encoding: 'utf8', timeout: 15000
  });
  assert.equal(evaluation.status, 0, evaluation.stderr);
  const evaluationArtifact = JSON.parse(fs.readFileSync(evaluationPath, 'utf8'));
  assert.equal(evaluationArtifact.holdoutEvaluation.evaluationExampleCount, 2);
  assert.equal(evaluationArtifact.holdoutUse, 'evaluation_only_no_model_selection');
  assert.equal(evaluationArtifact.acceptance, 'acceptance_required');

  fs.writeFileSync(graphPath, JSON.stringify({
    schemaVersion: 1, startNodeId: 'start', goalNodeId: 'goal',
    nodes: [
      { id: 'start', type: 'goal' },
      { id: 'a-direct-success-estimate', type: 'task', estimatedSuccessConfidence: 0.95, estimatedRisk: 0.1, estimatedCost: 1, reusePotential: 0.1, informationValue: 0.1 },
      { id: 'b-high-information', type: 'task', estimatedSuccessConfidence: 0.2, estimatedRisk: 0.8, estimatedCost: 4, reusePotential: 0.1, informationValue: 0.9 },
      { id: 'goal', type: 'goal' }
    ],
    edges: [
      { from: 'start', to: 'a-direct-success-estimate', type: 'next_step' },
      { from: 'start', to: 'b-high-information', type: 'next_step' },
      { from: 'a-direct-success-estimate', to: 'goal', type: 'next_step' },
      { from: 'b-high-information', to: 'goal', type: 'next_step' }
    ]
  }));
  const search = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/run-agg-phase2-shadow-search.mjs'), '--graph', graphPath, '--model', modelPath, '--output', resultPath, '--beam-width', '1'], {
    cwd: repoRoot, encoding: 'utf8', timeout: 15000
  });
  assert.equal(search.status, 0, search.stderr);
  const resultArtifact = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  assert.equal(resultArtifact.result.search.acceptance, 'offline_shadow_not_acceptance');
  assert.equal(resultArtifact.result.search.executionAuthorized, false);
  assert.equal(resultArtifact.result.candidates[0].execution.enabled, false);
  assert.equal(resultArtifact.result.candidates[0].verification.verified, false);
  assert.equal(resultArtifact.planGraphShadow.mode, 'shadow');
  assert.equal(resultArtifact.planGraphShadow.drafts.length, 1);
  assert.equal(resultArtifact.planGraphShadow.drafts[0].gates.persisted, false);
  assert.equal(resultArtifact.planGraphShadow.gates.executionAuthorized, false);

  const corpusPath = path.join(temp, 'corpus.json');
  const benchmarkPath = path.join(temp, 'benchmark.json');
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  fs.writeFileSync(corpusPath, JSON.stringify({ schemaVersion: 1, corpusId: 'synthetic-paired-v1',
    provenance: { kind: 'synthetic', source: 'unit-test graph fixture' },
    cases: [{ caseId: 'branching-case-1', graph,
      oracle: { successfulPathNodeIds: [['start', 'b-high-information', 'goal']], outcomeRef: 'synthetic-oracle:case-1' } }] }));
  const benchmark = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/benchmark-agg-phase2-paired.mjs'), '--corpus', corpusPath, '--model', modelPath, '--output', benchmarkPath, '--beam-width', '1'], {
    cwd: repoRoot, encoding: 'utf8', timeout: 15000
  });
  assert.equal(benchmark.status, 0, benchmark.stderr);
  const benchmarkArtifact = JSON.parse(fs.readFileSync(benchmarkPath, 'utf8'));
  assert.equal(benchmarkArtifact.metrics.caseCount, 1);
  assert.equal(benchmarkArtifact.metrics.phase2SuccessRate, 1);
  assert.equal(benchmarkArtifact.evidenceLevel, 'synthetic_technical_only');
  assert.equal(benchmarkArtifact.execution.authorized, false);

  // JSON object member order is not part of canonical identity. Re-encoding the
  // exact same model envelope with sourceIdentity keys in a different order
  // must remain usable by every downstream Phase 2 CLI and replay verifier.
  const reorderedModelPath = path.join(temp, 'model-reordered-keys.json');
  const reorderedModel = structuredClone(modelArtifact);
  reorderedModel.sourceIdentity = Object.fromEntries(Object.entries(reorderedModel.sourceIdentity).reverse());
  const { artifactSha256: _oldReorderedHash, ...reorderedBody } = reorderedModel;
  reorderedModel.artifactSha256 = canonicalHash(reorderedBody);
  fs.writeFileSync(reorderedModelPath, `${JSON.stringify(reorderedModel, null, 2)}\n`);
  assert.equal(validateAdaptiveGoalPhase2ModelArtifact(JSON.parse(fs.readFileSync(reorderedModelPath, 'utf8'))).artifactSha256,
    modelArtifact.artifactSha256, 'canonical model envelope identity must ignore object member order');
  const reorderedEvaluationPath = path.join(temp, 'evaluation-reordered-keys.json');
  const reorderedEvaluation = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/evaluate-agg-phase2-discriminator.mjs'),
    '--dataset', inputPath, '--model', reorderedModelPath, '--output', reorderedEvaluationPath], { cwd: repoRoot, encoding: 'utf8', timeout: 15000 });
  assert.equal(reorderedEvaluation.status, 0, reorderedEvaluation.stderr);
  const reorderedSearchPath = path.join(temp, 'search-reordered-keys.json');
  const reorderedSearch = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/run-agg-phase2-shadow-search.mjs'),
    '--graph', graphPath, '--model', reorderedModelPath, '--output', reorderedSearchPath, '--beam-width', '1'], { cwd: repoRoot, encoding: 'utf8', timeout: 15000 });
  assert.equal(reorderedSearch.status, 0, reorderedSearch.stderr);
  const reorderedBenchmarkPath = path.join(temp, 'benchmark-reordered-keys.json');
  const reorderedBenchmark = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/benchmark-agg-phase2-paired.mjs'),
    '--corpus', corpusPath, '--model', reorderedModelPath, '--output', reorderedBenchmarkPath, '--beam-width', '1'], { cwd: repoRoot, encoding: 'utf8', timeout: 15000 });
  assert.equal(reorderedBenchmark.status, 0, reorderedBenchmark.stderr);
  const reorderedVerificationPath = path.join(temp, 'verification-reordered-keys.json');
  const reorderedVerification = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/verify-agg-phase2-workflow.mjs'),
    '--dataset', inputPath, '--model', reorderedModelPath, '--evaluation', reorderedEvaluationPath, '--graph', graphPath,
    '--shadow-result', reorderedSearchPath, '--corpus', corpusPath, '--benchmark', reorderedBenchmarkPath,
    '--output', reorderedVerificationPath], { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
  assert.equal(reorderedVerification.status, 0, reorderedVerification.stderr + reorderedVerification.stdout);
  assert.equal(JSON.parse(fs.readFileSync(reorderedVerificationPath, 'utf8')).verificationStatus, 'VERIFIED');

  const verificationPath = path.join(temp, 'verification.json');
  const verification = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/verify-agg-phase2-workflow.mjs'),
    '--dataset', inputPath, '--model', modelPath, '--evaluation', evaluationPath, '--graph', graphPath,
    '--shadow-result', resultPath, '--corpus', corpusPath, '--benchmark', benchmarkPath, '--output', verificationPath], {
    cwd: repoRoot, encoding: 'utf8', timeout: 15000
  });
  assert.equal(verification.status, 0, verification.stderr + verification.stdout);
  const verificationArtifact = JSON.parse(fs.readFileSync(verificationPath, 'utf8'));
  assert.equal(verificationArtifact.verificationStatus, 'VERIFIED');
  assert.equal(verificationArtifact.evidenceStatus, 'INTEGRITY_ONLY');
  assert.equal(verificationArtifact.acceptanceStatus, 'ACCEPTANCE_REQUIRED');
  assert.equal(verificationArtifact.readiness, 'BLOCKED');
  assert.equal(verificationArtifact.executionGate, 'CLOSED');
  const originalShadowResultBytes = fs.readFileSync(resultPath);
  try {
    const forgedShadow = JSON.parse(originalShadowResultBytes.toString('utf8'));
    forgedShadow.planGraphShadow.gates.executionAuthorized = true;
    fs.writeFileSync(resultPath, `${JSON.stringify(forgedShadow, null, 2)}\n`);
    const forgedShadowVerification = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/verify-agg-phase2-workflow.mjs'),
      '--dataset', inputPath, '--model', modelPath, '--evaluation', evaluationPath, '--graph', graphPath,
      '--shadow-result', resultPath, '--corpus', corpusPath, '--benchmark', benchmarkPath,
      '--output', path.join(temp, 'forged-shadow-verification.json')], { cwd: repoRoot, encoding: 'utf8', timeout: 15000 });
    assert.equal(forgedShadowVerification.status, 2, 'independent workflow verifier must reject a Plan Graph shadow draft that claims execution authority');
    assert.match(forgedShadowVerification.stdout, /PLAN_GRAPH_SHADOW_REPLAY/);
  } finally { fs.writeFileSync(resultPath, originalShadowResultBytes); }

  // The remaining workflow-pack finalization assertions compare against historical
  // RC.5 binaries, an owner-maintained Phase-1 target proposal/freeze overlay, and
  // a historical evidence pack. Those are intentionally ignored local evidence,
  // not CI source inputs. The synthetic dataset/training/search/verifier checks
  // above have already run; do not execute this local-evidence-only segment when
  // the exact archived inputs are absent, and never substitute synthetic evidence
  // for an owner-signed target or historical receipt.
  const optionalWorkflowEvidence = [
    'benchmarks/plugin-workflow-benchmark/phase1-latest-build-target-successor-proposal-20261022-v3.json',
    'docs/plugin-workflow-benchmark-phase1-freeze.md',
    'artifacts/agg-phase1-hardening-20261023T143802Z-deep-verification/runalith-1.0.9-rc.5-agg-phase1-hardened.mcpb',
    'artifacts/runalith-1.0.9-rc.5-candidate-latest-build-20261022T175328+0700.mcpb',
    'artifacts/agg-phase2-discriminator-20261024T091706+0700-final/SHA256SUMS.txt'
  ];
  const unavailableWorkflowEvidence = optionalWorkflowEvidence.filter(relative => !fs.existsSync(path.join(repoRoot, relative)));
  if (unavailableWorkflowEvidence.length) {
    t.diagnostic(`Skipping historical workflow-pack finalization sub-check because owner-maintained local evidence is unavailable: ${unavailableWorkflowEvidence.join(', ')}`);
    return;
  }
  const scratchRoot = path.join(repoRoot, '.test-tmp');
  fs.mkdirSync(scratchRoot, { recursive: true });
  const workflowDir = path.join(scratchRoot, `agg-phase2-workflow-smoke-${process.pid}`);
  const workflowSiblingPath = `${workflowDir}-sibling-finalization.txt`;
  assert.equal(fs.existsSync(workflowDir), false, 'workflow evidence directory must be new');
  assert.equal(fs.existsSync(workflowSiblingPath), false, 'sibling path used to exercise exact worktree filtering must be new');
  fs.writeFileSync(workflowSiblingPath, 'stable sibling artifact for exact path-boundary regression\n', { flag: 'wx', mode: 0o600 });
  t.after(() => fs.rmSync(workflowDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(workflowSiblingPath, { force: true }));
  const workflow = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/run-agg-phase2-workflow.mjs'),
    '--dataset', inputPath, '--corpus', corpusPath, '--graph', graphPath, '--output-dir', workflowDir,
    '--beam-width', '1', '--epochs', '50'], { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
  if (workflow.status !== 0) {
    const blockedSummary = JSON.parse(workflow.stdout);
    assert.equal(workflow.status, 2, workflow.stderr + workflow.stdout);
    assert.equal(blockedSummary.status, 'BLOCKED');
    assert.match(blockedSummary.error, /development-candidate-source-alignment/);
    assert.equal(blockedSummary.acceptance, 'PARTIAL_NOT_ACCEPTED');
    assert.equal(blockedSummary.readiness, 'BLOCKED');
    assert.equal(blockedSummary.executionGate, 'CLOSED');
    assert.equal(typeof blockedSummary.manifestSha256, 'string', 'technical evidence may be packaged while readiness remains blocked');
    return;
  }
  const workflowReport = JSON.parse(fs.readFileSync(path.join(workflowDir, 'verification.json'), 'utf8'));
  assert.equal(workflowReport.verificationStatus, 'VERIFIED');
  const workflowManifestSha256 = createHash('sha256').update(fs.readFileSync(path.join(workflowDir, 'SHA256SUMS.txt'))).digest('hex');
  const unanchoredVerificationPath = path.join(temp, 'unanchored-pack-verification.json');
  const unanchoredVerification = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/verify-agg-phase2-evidence-pack.mjs'),
    '--pack', workflowDir, '--output', unanchoredVerificationPath], { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
  assert.equal(unanchoredVerification.status, 2, 'a self-consistent manifest without an out-of-band expected digest must not report VERIFIED');
  assert.equal(JSON.parse(fs.readFileSync(unanchoredVerificationPath, 'utf8')).checks.find(item => item.id === 'EXPECTED_MANIFEST_ANCHOR')?.status, 'FAIL');
  const packVerificationPath = path.join(temp, 'pack-verification.json');
  const packVerification = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/verify-agg-phase2-evidence-pack.mjs'),
    '--pack', workflowDir, '--output', packVerificationPath, '--expected-manifest-sha256', workflowManifestSha256], { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
  assert.equal(packVerification.status, 0, packVerification.stderr + packVerification.stdout);
  const packVerificationReport = JSON.parse(fs.readFileSync(packVerificationPath, 'utf8'));
  assert.equal(packVerificationReport.verificationStatus, 'VERIFIED');
  assert.equal(packVerificationReport.evidenceStatus, 'INTEGRITY_ONLY');
  assert.equal(packVerificationReport.acceptanceStatus, 'ACCEPTANCE_REQUIRED');

  // Replaying the same immutable pack must not depend on where a prior
  // verifier receipt was published. Only a receipt whose kind, exact pack path,
  // and manifest identity match may be excluded from post-snapshot Git status.
  const verifierSidecarPath = `${workflowDir}-pack-verification-final.json`;
  assert.equal(fs.existsSync(verifierSidecarPath), false, 'verifier sidecar path must be new');
  t.after(() => fs.rmSync(verifierSidecarPath, { force: true }));
  const sidecarVerification = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/verify-agg-phase2-evidence-pack.mjs'),
    '--pack', workflowDir, '--output', verifierSidecarPath, '--expected-manifest-sha256', workflowManifestSha256], { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
  assert.equal(sidecarVerification.status, 0, sidecarVerification.stderr + sidecarVerification.stdout);
  const repeatedVerification = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/verify-agg-phase2-evidence-pack.mjs'),
    '--pack', workflowDir, '--output', path.join(temp, 'repeat-verification-outside-repo.json'), '--expected-manifest-sha256', workflowManifestSha256],
  { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
  assert.equal(repeatedVerification.status, 0, repeatedVerification.stderr + repeatedVerification.stdout,
    'a prior post-snapshot verifier report must not make subsequent replay location-dependent');
  const workflowPackRelative = path.relative(repoRoot, workflowDir);
  const workflowManifestRelative = `${workflowPackRelative}/SHA256SUMS.txt`;
  const driftReceiptPath = `${workflowDir}-final-source-drift-check.json`;
  const externalSumsPath = `${workflowDir}-FINAL-SHA256SUMS.txt`;
  assert.equal(fs.existsSync(driftReceiptPath), false, 'source-drift sidecar path must be new');
  assert.equal(fs.existsSync(externalSumsPath), false, 'external checksum sidecar path must be new');
  t.after(() => fs.rmSync(driftReceiptPath, { force: true }));
  t.after(() => fs.rmSync(externalSumsPath, { force: true }));
  const manifestBytesForReceipts = fs.readFileSync(path.join(workflowDir, 'SHA256SUMS.txt'));
  fs.writeFileSync(driftReceiptPath, `${JSON.stringify({ schemaVersion: 1, kind: 'agg_phase2_source_drift_check',
    pack: workflowPackRelative, manifestSha256: createHash('sha256').update(manifestBytesForReceipts).digest('hex'),
    status: 'PASS', executionGate: 'CLOSED' }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const externalSumTargets = [workflowManifestRelative, path.relative(repoRoot, verifierSidecarPath), path.relative(repoRoot, driftReceiptPath)].sort();
  const externalSumsBytes = Buffer.from(`${externalSumTargets.map(relative =>
    `${createHash('sha256').update(fs.readFileSync(path.join(repoRoot, relative))).digest('hex')}  ${relative}`).join('\n')}\n`);
  fs.writeFileSync(externalSumsPath, externalSumsBytes, { flag: 'wx', mode: 0o600 });
  const sidecarReplay = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/verify-agg-phase2-evidence-pack.mjs'),
    '--pack', workflowDir, '--output', path.join(temp, 'replay-with-final-sidecars.json'), '--expected-manifest-sha256', workflowManifestSha256],
  { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
  assert.equal(sidecarReplay.status, 0, sidecarReplay.stderr + sidecarReplay.stdout,
    'bound drift report and exact external checksum sidecar must not create false source drift');
  try {
    const invalidSums = externalSumsBytes.toString('utf8').replace(/^([a-f0-9])/, match => match[1] === 'f' ? 'e' : 'f');
    fs.writeFileSync(externalSumsPath, invalidSums);
    const invalidSumsReplay = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/verify-agg-phase2-evidence-pack.mjs'),
      '--pack', workflowDir, '--output', path.join(temp, 'replay-with-invalid-sidecar-sums.json'), '--expected-manifest-sha256', workflowManifestSha256],
    { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
    assert.equal(invalidSumsReplay.status, 2, 'invalid external checksum sidecar must not be excluded from worktree drift');
    const invalidSumsReport = JSON.parse(fs.readFileSync(path.join(temp, 'replay-with-invalid-sidecar-sums.json'), 'utf8'));
    assert.equal(invalidSumsReport.checks.find(item => item.id === 'WORKTREE_STABLE_SINCE_SNAPSHOT')?.status, 'FAIL');
  } finally { fs.writeFileSync(externalSumsPath, externalSumsBytes); }
  const postSnapshotDriftPath = `${workflowSiblingPath}-post-snapshot-drift`;
  fs.writeFileSync(postSnapshotDriftPath, 'unrelated post-snapshot drift\n', { flag: 'wx', mode: 0o600 });
  try {
    const driftVerification = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/verify-agg-phase2-evidence-pack.mjs'),
      '--pack', workflowDir, '--output', path.join(temp, 'drift-verification.json'), '--expected-manifest-sha256', workflowManifestSha256],
    { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
    assert.equal(driftVerification.status, 2, 'unrelated post-snapshot worktree drift must still fail verification');
    const driftReport = JSON.parse(fs.readFileSync(path.join(temp, 'drift-verification.json'), 'utf8'));
    assert.equal(driftReport.checks.find(item => item.id === 'WORKTREE_STABLE_SINCE_SNAPSHOT')?.status, 'FAIL');
  } finally { fs.rmSync(postSnapshotDriftPath, { force: true }); }

  const manifestPath = path.join(workflowDir, 'SHA256SUMS.txt');
  const originalVerificationBytes = fs.readFileSync(path.join(workflowDir, 'verification.json'));
  const originalSnapshotBytes = fs.readFileSync(path.join(workflowDir, 'source-snapshot-identity.json'));
  const originalModelArtifactBytes = fs.readFileSync(path.join(workflowDir, 'model.json'));
  const originalShadowPackBytes = fs.readFileSync(path.join(workflowDir, 'shadow-search.json'));
  const originalCommandLedgerBytes = fs.readFileSync(path.join(workflowDir, 'command-ledger.json'));
  const originalTrainStdoutBytes = fs.readFileSync(path.join(workflowDir, 'logs/01-train.stdout.log'));
  const originalManifestBytes = fs.readFileSync(manifestPath);
  assert.equal(createHash('sha256').update(originalManifestBytes).digest('hex'), workflowManifestSha256);
  const originalReadmeBytes = fs.readFileSync(path.join(workflowDir, 'README.md'));
  const rewritePackManifest = () => {
    const entries = [];
    const visit = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (entry.isFile()) { if (full !== manifestPath) entries.push(full); }
        else assert.fail(`unexpected special file in test pack: ${full}`);
      }
    };
    visit(workflowDir);
    const lines = entries.sort().map(full => `${createHash('sha256').update(fs.readFileSync(full)).digest('hex')}  ${path.relative(repoRoot, full)}`);
    fs.writeFileSync(manifestPath, `${lines.join('\n')}\n`);
  };
  const runPackVerifier = (suffix, extraArgs = []) => spawnSync(process.execPath, [path.join(repoRoot, 'scripts/verify-agg-phase2-evidence-pack.mjs'),
    '--pack', workflowDir, '--output', path.join(temp, `tamper-${suffix}.json`), '--expected-manifest-sha256', workflowManifestSha256, ...extraArgs],
  { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
  try {
    fs.writeFileSync(manifestPath, Buffer.concat([originalManifestBytes, Buffer.from('\n')]));
    const nonCanonicalManifestResult = runPackVerifier('manifest-extra-trailing-blank-line');
    assert.equal(nonCanonicalManifestResult.status, 2, 'a second trailing newline must not be normalized away during manifest parsing');
    const nonCanonicalManifestReport = JSON.parse(fs.readFileSync(path.join(temp, 'tamper-manifest-extra-trailing-blank-line.json'), 'utf8'));
    assert.ok(nonCanonicalManifestReport.blockers.some(item => item.id === 'PACK_VERIFICATION_ERROR' && /blank lines|multiple trailing newlines/.test(item.detail)));
    fs.writeFileSync(manifestPath, originalManifestBytes);

    // A self-consistent regenerated manifest is not an authenticity anchor.
    // When the caller has the original digest out of band, payload mutation
    // followed by manifest regeneration must fail the explicit anchor check.
    fs.writeFileSync(path.join(workflowDir, 'README.md'), Buffer.concat([originalReadmeBytes, Buffer.from('tampered payload\n')]));
    rewritePackManifest();
    const rehashedPayloadResult = runPackVerifier('rehash-after-payload-tamper');
    assert.equal(rehashedPayloadResult.status, 2, 'a recomputed manifest must fail against the previously trusted manifest digest');
    const rehashedPayloadReport = JSON.parse(fs.readFileSync(path.join(temp, 'tamper-rehash-after-payload-tamper.json'), 'utf8'));
    assert.equal(rehashedPayloadReport.checks.find(item => item.id === 'EXPECTED_MANIFEST_ANCHOR')?.status, 'FAIL');
    fs.writeFileSync(path.join(workflowDir, 'README.md'), originalReadmeBytes);
    rewritePackManifest();

    const forgedVerification = JSON.parse(originalVerificationBytes.toString('utf8'));
    forgedVerification.inputArtifacts['--dataset'].sha256 = 'f'.repeat(64);
    fs.writeFileSync(path.join(workflowDir, 'verification.json'), `${JSON.stringify(forgedVerification, null, 2)}\n`);
    rewritePackManifest();
    const forgedReportResult = runPackVerifier('forged-verifier-report');
    assert.equal(forgedReportResult.status, 2, 'a formally valid regenerated manifest must not legitimize a forged workflow-verifier input identity');
    assert.match(forgedReportResult.stdout, /WORKFLOW_VERIFICATION_PRESENT|WORKFLOW_VERIFICATION_REPLAYED/);

    fs.writeFileSync(path.join(workflowDir, 'verification.json'), originalVerificationBytes);
    const forgedLedger = JSON.parse(originalCommandLedgerBytes.toString('utf8'));
    forgedLedger.commands.find(command => command.label === 'train').argv = [process.execPath, '-e', 'process.exit(0)'];
    fs.writeFileSync(path.join(workflowDir, 'command-ledger.json'), `${JSON.stringify(forgedLedger, null, 2)}\n`);
    rewritePackManifest();
    const forgedArgvResult = runPackVerifier('forged-command-argv');
    assert.equal(forgedArgvResult.status, 2, 'a regenerated manifest must not legitimize an arbitrary claimed training command');
    assert.match(forgedArgvResult.stdout, /COMMAND_LEDGER/);
    fs.writeFileSync(path.join(workflowDir, 'command-ledger.json'), originalCommandLedgerBytes);
    rewritePackManifest();

    const aliasedLogLedger = JSON.parse(originalCommandLedgerBytes.toString('utf8'));
    const trainCommand = aliasedLogLedger.commands.find(command => command.label === 'train');
    const modelBytesForLogForgery = fs.readFileSync(path.join(workflowDir, 'model.json'));
    trainCommand.stdout = { path: 'model.json', sizeBytes: modelBytesForLogForgery.length,
      sha256: createHash('sha256').update(modelBytesForLogForgery).digest('hex') };
    trainCommand.stderr = { ...trainCommand.stdout };
    fs.writeFileSync(path.join(workflowDir, 'command-ledger.json'), `${JSON.stringify(aliasedLogLedger, null, 2)}\n`);
    rewritePackManifest();
    const aliasedLogResult = runPackVerifier('command-log-path-alias');
    assert.equal(aliasedLogResult.status, 2, 'command streams cannot be rebound to a payload file even when self-declared size/hash and manifest are recomputed');
    const aliasedLogReport = JSON.parse(fs.readFileSync(path.join(temp, 'tamper-command-log-path-alias.json'), 'utf8'));
    assert.equal(aliasedLogReport.checks.find(item => item.id === 'COMMAND_LEDGER')?.status, 'FAIL');
    fs.writeFileSync(path.join(workflowDir, 'command-ledger.json'), originalCommandLedgerBytes);
    rewritePackManifest();

    const invertedChronologyLedger = JSON.parse(originalCommandLedgerBytes.toString('utf8'));
    invertedChronologyLedger.commands[0].endedAt = '2000-01-01T00:00:00.000Z';
    fs.writeFileSync(path.join(workflowDir, 'command-ledger.json'), `${JSON.stringify(invertedChronologyLedger, null, 2)}\n`);
    rewritePackManifest();
    const invertedChronologyResult = runPackVerifier('command-inverted-chronology');
    assert.equal(invertedChronologyResult.status, 2, 'command ledger timestamps must be monotonic and each command must end after it starts');
    const invertedChronologyReport = JSON.parse(fs.readFileSync(path.join(temp, 'tamper-command-inverted-chronology.json'), 'utf8'));
    assert.equal(invertedChronologyReport.checks.find(item => item.id === 'COMMAND_LEDGER')?.status, 'FAIL');
    fs.writeFileSync(path.join(workflowDir, 'command-ledger.json'), originalCommandLedgerBytes);
    rewritePackManifest();

    const forgedSnapshot = JSON.parse(originalSnapshotBytes.toString('utf8'));
    forgedSnapshot.sourceIdentity = {};
    forgedSnapshot.sourceFilesCopied = 0;
    fs.writeFileSync(path.join(workflowDir, 'source-snapshot-identity.json'), `${JSON.stringify(forgedSnapshot, null, 2)}\n`);
    rewritePackManifest();
    const forgedSnapshotResult = runPackVerifier('empty-source-identity');
    assert.equal(forgedSnapshotResult.status, 2, 'an empty self-declared source identity must fail even with a valid regenerated manifest');
    assert.match(forgedSnapshotResult.stdout, /SOURCE_SNAPSHOT_BINDING|CURRENT_SOURCE_TREE_MATCHES_SNAPSHOT/);

    fs.writeFileSync(path.join(workflowDir, 'source-snapshot-identity.json'), originalSnapshotBytes);
    const forgedAuditTrace = JSON.parse(originalShadowPackBytes.toString('utf8'));
    forgedAuditTrace.result.auditTrace.eventCount += 1;
    fs.writeFileSync(path.join(workflowDir, 'shadow-search.json'), `${JSON.stringify(forgedAuditTrace, null, 2)}\n`);
    rewritePackManifest();
    const forgedAuditResult = runPackVerifier('shadow-audit-event-count');
    assert.equal(forgedAuditResult.status, 2, 'a regenerated manifest must not legitimize inconsistent search audit-event accounting');
    const forgedAuditReport = JSON.parse(fs.readFileSync(path.join(temp, 'tamper-shadow-audit-event-count.json'), 'utf8'));
    assert.equal(forgedAuditReport.checks.find(item => item.id === 'INDEPENDENT_GRAPH_SEARCH_AUDIT_PLAN_LINEAGE')?.status, 'FAIL');

    fs.writeFileSync(path.join(workflowDir, 'shadow-search.json'), originalShadowPackBytes);
    rewritePackManifest();
    const reorderedAudit = JSON.parse(originalShadowPackBytes.toString('utf8'));
    reorderedAudit.result.auditTrace.events.reverse();
    fs.writeFileSync(path.join(workflowDir, 'shadow-search.json'), `${JSON.stringify(reorderedAudit, null, 2)}\n`);
    rewritePackManifest();
    const reorderedAuditResult = runPackVerifier('audit-event-order-forgery');
    assert.equal(reorderedAuditResult.status, 2, 'a checksum-valid manifest must not legitimize a structurally plausible but non-replayable audit-event order');
    const reorderedAuditReport = JSON.parse(fs.readFileSync(path.join(temp, 'tamper-audit-event-order-forgery.json'), 'utf8'));
    assert.equal(reorderedAuditReport.checks.find(item => item.id === 'INDEPENDENT_SEARCH_DECISIONS_AND_AUDIT_REDERIVED')?.status, 'FAIL');

    fs.writeFileSync(path.join(workflowDir, 'shadow-search.json'), originalShadowPackBytes);
    rewritePackManifest();
    const forgedLedgerStatus = JSON.parse(originalCommandLedgerBytes.toString('utf8'));
    forgedLedgerStatus.status = 'PASS';
    fs.writeFileSync(path.join(workflowDir, 'command-ledger.json'), `${JSON.stringify(forgedLedgerStatus, null, 2)}\n`);
    rewritePackManifest();
    const forgedLedgerStatusResult = runPackVerifier('forged-command-ledger-status');
    assert.equal(forgedLedgerStatusResult.status, 2, 'a checksum-valid manifest must not legitimize a forged command-ledger status');
    const forgedLedgerStatusReport = JSON.parse(fs.readFileSync(path.join(temp, 'tamper-forged-command-ledger-status.json'), 'utf8'));
    assert.equal(forgedLedgerStatusReport.checks.find(item => item.id === 'COMMAND_LEDGER')?.status, 'FAIL');

    fs.writeFileSync(path.join(workflowDir, 'command-ledger.json'), originalCommandLedgerBytes);
    rewritePackManifest();
    const forgedLedgerExit = JSON.parse(originalCommandLedgerBytes.toString('utf8'));
    const forgedTrainCommand = forgedLedgerExit.commands.find(command => command.label === 'train');
    forgedTrainCommand.exitCode = 17;
    forgedTrainCommand.expectedExitCode = 17;
    fs.writeFileSync(path.join(workflowDir, 'command-ledger.json'), `${JSON.stringify(forgedLedgerExit, null, 2)}\n`);
    rewritePackManifest();
    const forgedLedgerExitResult = runPackVerifier('forged-command-exit-code');
    assert.equal(forgedLedgerExitResult.status, 2, 'a checksum-valid manifest must not legitimize a self-consistent but unauthorized exit code');
    const forgedLedgerExitReport = JSON.parse(fs.readFileSync(path.join(temp, 'tamper-forged-command-exit-code.json'), 'utf8'));
    assert.equal(forgedLedgerExitReport.checks.find(item => item.id === 'COMMAND_LEDGER')?.status, 'FAIL');

    fs.writeFileSync(path.join(workflowDir, 'command-ledger.json'), originalCommandLedgerBytes);
    rewritePackManifest();
    fs.appendFileSync(path.join(workflowDir, 'logs/01-train.stdout.log'), 'forged success marker\n');
    rewritePackManifest();
    const forgedLogResult = runPackVerifier('forged-command-log');
    assert.equal(forgedLogResult.status, 2, 'a checksum-valid manifest must not legitimize a modified raw command log whose ledger hash no longer matches');
    const forgedLogReport = JSON.parse(fs.readFileSync(path.join(temp, 'tamper-forged-command-log.json'), 'utf8'));
    assert.ok(forgedLogReport.blockers.some(item => item.id === 'RAW_LOG_HASH_MISMATCH'));

    fs.writeFileSync(path.join(workflowDir, 'logs/01-train.stdout.log'), originalTrainStdoutBytes);
    fs.writeFileSync(path.join(workflowDir, 'command-ledger.json'), originalCommandLedgerBytes);
    rewritePackManifest();
    const forgedModel = JSON.parse(originalModelArtifactBytes.toString('utf8'));
    forgedModel.model.weights.informationValue += 0.123;
    const { modelSha256: _previousModelHash, ...forgedModelBody } = forgedModel.model;
    forgedModel.model.modelSha256 = canonicalHash(forgedModelBody);
    forgedModel.validation.modelSha256 = forgedModel.model.modelSha256;
    const { artifactSha256: _previousArtifactHash, ...forgedArtifactBody } = forgedModel;
    forgedModel.artifactSha256 = canonicalHash(forgedArtifactBody);
    fs.writeFileSync(path.join(workflowDir, 'model.json'), `${JSON.stringify(forgedModel, null, 2)}\n`);
    rewritePackManifest();
    const forgedModelResult = runPackVerifier('model-content-tamper-with-valid-hashes');
    assert.equal(forgedModelResult.status, 2, 'recomputed model/envelope hashes and manifest must not legitimize coefficients that do not reproduce the declared metrics');
    const forgedModelReport = JSON.parse(fs.readFileSync(path.join(temp, 'tamper-model-content-tamper-with-valid-hashes.json'), 'utf8'));
    assert.equal(forgedModelReport.checks.find(item => item.id === 'INDEPENDENT_CONTENT_REDERIVATION')?.status, 'FAIL');

    fs.writeFileSync(path.join(workflowDir, 'model.json'), originalModelArtifactBytes);
    const extraModelField = JSON.parse(originalModelArtifactBytes.toString('utf8'));
    extraModelField.unrecognizedMetadata = { claims: 'trusted' };
    const { artifactSha256: _oldExtraFieldEnvelopeHash, ...extraModelBody } = extraModelField;
    extraModelField.artifactSha256 = canonicalHash(extraModelBody);
    fs.writeFileSync(path.join(workflowDir, 'model.json'), `${JSON.stringify(extraModelField, null, 2)}\n`);
    rewritePackManifest();
    const extraModelFieldResult = runPackVerifier('model-extra-field-with-valid-envelope-and-manifest');
    assert.equal(extraModelFieldResult.status, 2, 'strict schema verification must reject an extra model-envelope field even when envelope and manifest hashes are recomputed');
    const extraModelFieldReport = JSON.parse(fs.readFileSync(path.join(temp, 'tamper-model-extra-field-with-valid-envelope-and-manifest.json'), 'utf8'));
    assert.equal(extraModelFieldReport.checks.find(item => item.id === 'INDEPENDENT_CONTENT_REDERIVATION')?.status, 'FAIL');

    fs.writeFileSync(path.join(workflowDir, 'model.json'), originalModelArtifactBytes);
    rewritePackManifest();
    fs.unlinkSync(path.join(workflowDir, 'model.json'));
    rewritePackManifest();
    const missingArtifactResult = runPackVerifier('missing-required-model');
    assert.equal(missingArtifactResult.status, 2, 'a regenerated checksum-valid manifest must not legitimize a missing required model artifact');
    assert.match(missingArtifactResult.stdout, /WORKFLOW_VERIFICATION_REPLAYED|PACK_VERIFICATION_ERROR|CHECKSUMS_AND_INVENTORY/);
  } finally {
    fs.writeFileSync(path.join(workflowDir, 'verification.json'), originalVerificationBytes);
    fs.writeFileSync(path.join(workflowDir, 'source-snapshot-identity.json'), originalSnapshotBytes);
    fs.writeFileSync(path.join(workflowDir, 'model.json'), originalModelArtifactBytes, { flag: 'w' });
    fs.writeFileSync(path.join(workflowDir, 'shadow-search.json'), originalShadowPackBytes, { flag: 'w' });
    fs.writeFileSync(path.join(workflowDir, 'command-ledger.json'), originalCommandLedgerBytes, { flag: 'w' });
    fs.writeFileSync(path.join(workflowDir, 'logs/01-train.stdout.log'), originalTrainStdoutBytes, { flag: 'w' });
    fs.writeFileSync(manifestPath, originalManifestBytes);
  }

  const imbalancedDataset = structuredClone(dataset);
  imbalancedDataset.datasetId = 'test-imbalanced-dataset-v1';
  imbalancedDataset.trainingExamples.push(
    { id: 'train-negative-extra-1', features: features(0.025), label: 0 },
    { id: 'train-negative-extra-2', features: features(0.035), label: 0 }
  );
  const imbalancedDatasetPath = path.join(temp, 'imbalanced-dataset.json');
  const imbalancedModelPath = path.join(temp, 'imbalanced-model.json');
  const imbalancedEvaluationPath = path.join(temp, 'imbalanced-evaluation.json');
  fs.writeFileSync(imbalancedDatasetPath, JSON.stringify(imbalancedDataset));
  const imbalancedTrain = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/train-agg-phase2-discriminator.mjs'), '--input', imbalancedDatasetPath, '--output', imbalancedModelPath], {
    cwd: repoRoot, encoding: 'utf8', timeout: 15000
  });
  assert.equal(imbalancedTrain.status, 0, imbalancedTrain.stderr);
  const imbalancedEval = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/evaluate-agg-phase2-discriminator.mjs'), '--dataset', imbalancedDatasetPath, '--model', imbalancedModelPath, '--output', imbalancedEvaluationPath], {
    cwd: repoRoot, encoding: 'utf8', timeout: 15000
  });
  assert.equal(imbalancedEval.status, 0, imbalancedEval.stderr);
  const imbalanceReport = JSON.parse(fs.readFileSync(imbalancedEvaluationPath, 'utf8')).classImbalanceSensitivity;
  assert.equal(imbalanceReport.status, 'DIAGNOSTIC_RETRAIN_NO_MODEL_SELECTION');
  assert.equal(imbalanceReport.majorityToMinorityRatio, 8 / 6);
  assert.equal(imbalanceReport.holdoutUsedForSelection, false);
});

test('Phase 2 shadow beam keeps AND prerequisites and excludes conditional recovery edges', () => {
  const { model } = trainAdaptiveGoalDiscriminator(trainFixture());
  const prerequisiteGraph = {
    schemaVersion: 1, startNodeId: 'start', goalNodeId: 'goal',
    nodes: [
      { id: 'start', type: 'goal' },
      { id: 'prerequisite', type: 'task', informationValue: 0.8 },
      { id: 'dependent-step', type: 'task', informationValue: 0.9 },
      { id: 'goal', type: 'goal' }
    ],
    edges: [
      { from: 'start', to: 'dependent-step', type: 'next_step' },
      { from: 'start', to: 'prerequisite', type: 'next_step' },
      { from: 'prerequisite', to: 'dependent-step', type: 'requires_all' },
      { from: 'prerequisite', to: 'dependent-step', type: 'next_step' },
      { from: 'dependent-step', to: 'goal', type: 'next_step' }
    ]
  };
  const prerequisiteResult = searchAdaptiveGoalGraphPhase2(prerequisiteGraph, model, { beamWidth: 4 });
  assert.equal(prerequisiteResult.status, 'proposals_found');
  assert.ok(prerequisiteResult.candidates.every(candidate => candidate.pathNodeIds.includes('prerequisite')));
  assert.ok(prerequisiteResult.auditTrace.events.some(event => event.type === 'edge_rejected' && event.reason === 'prerequisite_missing'));
  const labelledExample = createAdaptiveGoalDiscriminatorExample({ graph: prerequisiteGraph,
    pathNodeIds: prerequisiteResult.candidates[0].pathNodeIds, id: 'oracle-labelled-positive', label: 1 });
  assert.equal(labelledExample.label, 1, 'the outcome label is supplied by the independent adjudicator, never inferred by the helper');
  assert.equal(Object.keys(labelledExample.features).length, 7);
  assert.throws(() => createAdaptiveGoalDiscriminatorExample({ graph: prerequisiteGraph,
    pathNodeIds: ['start', 'dependent-step', 'goal'], id: 'invalid-prerequisite-path', label: 0 }), /unsatisfied prerequisite/);

  const recoveryOnlyGraph = {
    schemaVersion: 1, startNodeId: 'start', goalNodeId: 'goal',
    nodes: [
      { id: 'start', type: 'goal' },
      { id: 'step', type: 'task' },
      { id: 'evidence', type: 'evidence', evidenceRefs: ['artifact://recovery-evidence'] },
      { id: 'goal', type: 'goal' }
    ],
    edges: [
      { from: 'start', to: 'step', type: 'next_step' },
      { from: 'step', to: 'goal', type: 'recovers_to', condition: {
        onOutcome: 'failed', requiresEvidenceNodeIds: ['evidence'], requiresAllNodeIds: []
      } }
    ]
  };
  const recoveryResult = searchAdaptiveGoalGraphPhase2(recoveryOnlyGraph, model, { beamWidth: 4 });
  assert.equal(recoveryResult.status, 'no_solution_found');
  assert.equal(recoveryResult.candidates.length, 0);
  assert.equal(recoveryResult.search.executionAuthorized, false);
});
