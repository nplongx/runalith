import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';

export const ADAPTIVE_GOAL_DISCRIMINATOR_SCHEMA_VERSION = 2;
export const ADAPTIVE_GOAL_DISCRIMINATOR_FEATURE_SCHEMA_VERSION = 1;
export const ADAPTIVE_GOAL_DISCRIMINATOR_FEATURES = Object.freeze([
  'successConfidence', 'riskSafety', 'costEfficiency', 'reusePotential',
  'informationValue', 'testedHypothesisRatio', 'supportEdgeRatio'
]);

const HASH = /^[a-f0-9]{64}$/;
const VALIDATED_MODELS = new WeakSet();
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
const MAX_TRAINING_EXAMPLE_EPOCHS = 5_000_000;

function fail(message) {
  throw new TypeError(`AdaptiveGoalDiscriminator: ${message}`);
}

function exactRecord(value, keys, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  const extra = Object.keys(value).filter(key => !keys.includes(key));
  if (extra.length) fail(`${field} has unsupported fields: ${extra.sort().join(', ')}`);
}

function canonicalFeatures(input, field = 'features') {
  exactRecord(input, ADAPTIVE_GOAL_DISCRIMINATOR_FEATURES, field);
  const result = {};
  for (const key of ADAPTIVE_GOAL_DISCRIMINATOR_FEATURES) {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0) || value < 0 || value > 1) {
      fail(`${field}.${key} must be a finite number in [0, 1]`);
    }
    result[key] = value;
  }
  return result;
}

function canonicalExamples(input, field, minimum = 1) {
  if (!Array.isArray(input) || input.length < minimum || input.length > 100000) {
    fail(`${field} must contain ${minimum}-100000 examples`);
  }
  const examples = input.map((example, index) => {
    exactRecord(example, ['id', 'features', 'label'], `${field}[${index}]`);
    if (typeof example.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(example.id)) {
      fail(`${field}[${index}].id is invalid`);
    }
    if (example.label !== 0 && example.label !== 1) fail(`${field}[${index}].label must be 0 or 1`);
    return { id: example.id, features: canonicalFeatures(example.features, `${field}[${index}].features`), label: example.label };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const fingerprints = new Set();
  for (const example of examples) {
    const fingerprint = sha256(example.features);
    if (fingerprints.has(fingerprint)) fail(`${field} contains duplicate feature vectors`);
    fingerprints.add(fingerprint);
  }
  return examples;
}

function validateModelBody(model) {
  exactRecord(model, ['schemaVersion', 'featureSchemaVersion', 'modelType', 'featureNames', 'datasetId', 'trainingConfig', 'trainingDataSha256', 'validationDataSha256', 'means', 'scales', 'weights', 'intercept', 'trainingExampleCount', 'trainingClassCounts', 'trainingMetrics', 'modelSha256'], 'model');
  if (model.schemaVersion !== ADAPTIVE_GOAL_DISCRIMINATOR_SCHEMA_VERSION || model.modelType !== 'standardized-logistic-regression') {
    fail('unsupported schemaVersion or modelType');
  }
  if (model.featureSchemaVersion !== ADAPTIVE_GOAL_DISCRIMINATOR_FEATURE_SCHEMA_VERSION) fail('unsupported feature schema version');
  if (typeof model.datasetId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(model.datasetId)) fail('datasetId is invalid');
  exactRecord(model.trainingConfig, ['learningRate', 'epochs', 'l2', 'seed'], 'model.trainingConfig');
  if (!Number.isFinite(model.trainingConfig.learningRate) || model.trainingConfig.learningRate <= 0 || model.trainingConfig.learningRate > 1 ||
      !Number.isInteger(model.trainingConfig.epochs) || model.trainingConfig.epochs < 1 || model.trainingConfig.epochs > 100000 ||
      !Number.isFinite(model.trainingConfig.l2) || model.trainingConfig.l2 < 0 || model.trainingConfig.l2 > 10 ||
      !Number.isSafeInteger(model.trainingConfig.seed) || model.trainingConfig.seed < 0) fail('trainingConfig is invalid');
  if (!HASH.test(model.trainingDataSha256) || !HASH.test(model.validationDataSha256)) fail('train/validation split identity is invalid');
  if (canonicalJson(model.featureNames) !== canonicalJson(ADAPTIVE_GOAL_DISCRIMINATOR_FEATURES)) fail('featureNames mismatch');
  for (const key of ['means', 'scales', 'weights']) {
    exactRecord(model[key], ADAPTIVE_GOAL_DISCRIMINATOR_FEATURES, `model.${key}`);
    for (const name of ADAPTIVE_GOAL_DISCRIMINATOR_FEATURES) {
      if (typeof model[key][name] !== 'number' || !Number.isFinite(model[key][name])) fail(`model.${key}.${name} must be finite`);
      if (key === 'scales' && model[key][name] <= 0) fail(`model.scales.${name} must be positive`);
      if (key === 'means' && (model[key][name] < 0 || model[key][name] > 1)) fail(`model.means.${name} must be in [0, 1]`);
      if (key === 'scales' && (model[key][name] < 1e-6 || model[key][name] > 1)) fail(`model.scales.${name} must be in [1e-6, 1]`);
      if (key === 'weights' && Math.abs(model[key][name]) > 1e6) fail(`model.weights.${name} exceeds the numeric safety bound`);
    }
  }
  if (typeof model.intercept !== 'number' || !Number.isFinite(model.intercept) || Math.abs(model.intercept) > 1e6) fail('model.intercept must be finite and within the numeric safety bound');
  if (!HASH.test(model.trainingDataSha256) || !Number.isSafeInteger(model.trainingExampleCount) || model.trainingExampleCount < 4) fail('training provenance is invalid');
  exactRecord(model.trainingClassCounts, ['negative', 'positive'], 'model.trainingClassCounts');
  if (!Number.isSafeInteger(model.trainingClassCounts.negative) || !Number.isSafeInteger(model.trainingClassCounts.positive) ||
      model.trainingClassCounts.negative < 1 || model.trainingClassCounts.positive < 1 ||
      model.trainingClassCounts.negative + model.trainingClassCounts.positive !== model.trainingExampleCount) fail('training class counts mismatch');
  exactRecord(model.trainingMetrics, ['accuracy', 'balancedAccuracy', 'logLoss', 'precision', 'recall', 'f1', 'brierScore', 'confusionMatrix', 'classBalance', 'accuracyConfidenceInterval95', 'calibration'], 'model.trainingMetrics');
  for (const key of ['accuracy', 'balancedAccuracy', 'logLoss', 'precision', 'recall', 'f1', 'brierScore']) {
    if (typeof model.trainingMetrics[key] !== 'number' || !Number.isFinite(model.trainingMetrics[key]) || model.trainingMetrics[key] < 0 ||
        (key === 'logLoss' ? model.trainingMetrics[key] > 35 : model.trainingMetrics[key] > 1)) fail(`model.trainingMetrics.${key} is invalid`);
  }
  exactRecord(model.trainingMetrics.confusionMatrix, ['truePositive', 'trueNegative', 'falsePositive', 'falseNegative'], 'model.trainingMetrics.confusionMatrix');
  exactRecord(model.trainingMetrics.classBalance, ['negative', 'positive'], 'model.trainingMetrics.classBalance');
  exactRecord(model.trainingMetrics.accuracyConfidenceInterval95, ['lower', 'upper', 'method'], 'model.trainingMetrics.accuracyConfidenceInterval95');
  if (!Array.isArray(model.trainingMetrics.calibration) || model.trainingMetrics.calibration.length !== 10) fail('model.trainingMetrics.calibration must contain 10 bins');
  for (const key of ['truePositive', 'trueNegative', 'falsePositive', 'falseNegative']) {
    if (!Number.isSafeInteger(model.trainingMetrics.confusionMatrix[key]) || model.trainingMetrics.confusionMatrix[key] < 0) fail(`model.trainingMetrics.confusionMatrix.${key} is invalid`);
  }
  const cm = model.trainingMetrics.confusionMatrix;
  if (cm.truePositive + cm.trueNegative + cm.falsePositive + cm.falseNegative !== model.trainingExampleCount) fail('training confusion matrix count mismatch');
  for (const key of ['negative', 'positive']) if (!Number.isSafeInteger(model.trainingMetrics.classBalance[key]) || model.trainingMetrics.classBalance[key] < 1) fail(`model.trainingMetrics.classBalance.${key} is invalid`);
  if (model.trainingMetrics.classBalance.negative + model.trainingMetrics.classBalance.positive !== model.trainingExampleCount) fail('training metric class balance mismatch');
  const metricEqual = (actual, expected) => Math.abs(actual - expected) <= 1e-12;
  const expectedPositive = cm.truePositive + cm.falseNegative;
  const expectedNegative = cm.trueNegative + cm.falsePositive;
  const expectedPrecision = cm.truePositive + cm.falsePositive ? cm.truePositive / (cm.truePositive + cm.falsePositive) : 0;
  const expectedRecall = expectedPositive ? cm.truePositive / expectedPositive : 0;
  const expectedNegativeRecall = expectedNegative ? cm.trueNegative / expectedNegative : 0;
  const expectedF1 = expectedPrecision + expectedRecall ? 2 * expectedPrecision * expectedRecall / (expectedPrecision + expectedRecall) : 0;
  if (model.trainingMetrics.classBalance.positive !== expectedPositive || model.trainingMetrics.classBalance.negative !== expectedNegative ||
      !metricEqual(model.trainingMetrics.accuracy, (cm.truePositive + cm.trueNegative) / model.trainingExampleCount) ||
      !metricEqual(model.trainingMetrics.precision, expectedPrecision) || !metricEqual(model.trainingMetrics.recall, expectedRecall) ||
      !metricEqual(model.trainingMetrics.f1, expectedF1) || !metricEqual(model.trainingMetrics.balancedAccuracy, (expectedRecall + expectedNegativeRecall) / 2)) {
    fail('training classification metrics are internally inconsistent');
  }
  const interval = model.trainingMetrics.accuracyConfidenceInterval95;
  if (typeof interval.lower !== 'number' || typeof interval.upper !== 'number' || interval.lower < 0 || interval.upper > 1 || interval.lower > interval.upper || interval.method !== 'wilson_score') fail('training accuracy confidence interval is invalid');
  const z = 1.959963984540054, accuracy = model.trainingMetrics.accuracy, count = model.trainingExampleCount;
  const denominator = 1 + z * z / count;
  const center = (accuracy + z * z / (2 * count)) / denominator;
  const margin = z * Math.sqrt(accuracy * (1 - accuracy) / count + z * z / (4 * count ** 2)) / denominator;
  if (!metricEqual(interval.lower, Math.max(0, center - margin)) || !metricEqual(interval.upper, Math.min(1, center + margin))) fail('training accuracy confidence interval does not match accuracy and count');
  let calibrationPositiveMass = 0;
  for (let index = 0; index < model.trainingMetrics.calibration.length; index++) {
    const bin = model.trainingMetrics.calibration[index];
    exactRecord(bin, ['bin', 'count', 'meanPredictedProbability', 'observedPositiveRate'], `model.trainingMetrics.calibration[${index}]`);
    if (bin.bin !== index || !Number.isSafeInteger(bin.count) || bin.count < 0 ||
        !Number.isFinite(bin.meanPredictedProbability) || bin.meanPredictedProbability < 0 || bin.meanPredictedProbability > 1 ||
        !Number.isFinite(bin.observedPositiveRate) || bin.observedPositiveRate < 0 || bin.observedPositiveRate > 1 ||
        (bin.count === 0 && (bin.meanPredictedProbability !== 0 || bin.observedPositiveRate !== 0))) fail(`model.trainingMetrics.calibration[${index}] is invalid`);
    calibrationPositiveMass += bin.count * bin.observedPositiveRate;
  }
  if (model.trainingMetrics.calibration.reduce((sum, bin) => sum + bin.count, 0) !== model.trainingExampleCount) fail('training calibration bins do not account for all examples');
  if (!metricEqual(calibrationPositiveMass, expectedPositive)) fail('training calibration positive rates do not match class balance');
  if (typeof model.modelSha256 !== 'string' || !HASH.test(model.modelSha256)) fail('modelSha256 is invalid');
  const { modelSha256, ...body } = model;
  if (sha256(body) !== modelSha256) fail('model hash mismatch');
  return model;
}

export function validateAdaptiveGoalDiscriminatorModel(model) {
  if (model && typeof model === 'object' && VALIDATED_MODELS.has(model)) return model;
  const clone = structuredClone(validateModelBody(model));
  const freezeDeep = value => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) freezeDeep(child);
      Object.freeze(value);
    }
    return value;
  };
  freezeDeep(clone);
  VALIDATED_MODELS.add(clone);
  return clone;
}

export function extractAdaptiveGoalDiscriminatorFeatures(state) {
  const metrics = state?.metrics || {};
  const semantics = state?.semantics || {};
  const success = metrics.estimatedSuccessConfidence;
  const risk = metrics.estimatedRisk;
  const cost = metrics.estimatedCost;
  const reuse = metrics.reusePotential;
  const information = metrics.informationValue;
  const hypotheses = Number.isFinite(semantics.hypothesisCount) ? semantics.hypothesisCount : 0;
  const tested = Number.isFinite(semantics.testedHypothesisCount) ? semantics.testedHypothesisCount : 0;
  const support = Number.isFinite(semantics.supportEdgeCount) ? semantics.supportEdgeCount : 0;
  const pathLength = Array.isArray(state?.pathNodeIds) ? Math.max(1, state.pathNodeIds.length - 1) : 1;
  return canonicalFeatures({
    successConfidence: success === null || success === undefined ? 0 : clamp(success),
    riskSafety: risk === null || risk === undefined ? 0 : clamp(1 - risk),
    costEfficiency: cost === null || cost === undefined ? 0 : clamp(1 / (1 + Math.max(0, cost))),
    reusePotential: reuse === null || reuse === undefined ? 0 : clamp(reuse),
    informationValue: information === null || information === undefined ? 0 : clamp(information),
    testedHypothesisRatio: clamp(tested / Math.max(1, hypotheses)),
    supportEdgeRatio: clamp(support / pathLength)
  });
}

export function scoreAdaptiveGoalDiscriminator(modelInput, featuresInput) {
  const model = validateAdaptiveGoalDiscriminatorModel(modelInput);
  const features = canonicalFeatures(featuresInput);
  let logit = model.intercept;
  for (const name of ADAPTIVE_GOAL_DISCRIMINATOR_FEATURES) {
    logit += model.weights[name] * ((features[name] - model.means[name]) / model.scales[name]);
  }
  const probability = logit >= 0 ? 1 / (1 + Math.exp(-Math.min(logit, 709))) : Math.exp(Math.max(logit, -745)) / (1 + Math.exp(Math.max(logit, -745)));
  return { probability: clamp(probability), features, modelSha256: model.modelSha256, classification: 'model_estimate_unverified' };
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-Math.min(value, 709)));
  const exp = Math.exp(Math.max(value, -745));
  return exp / (1 + exp);
}

function metricsFor(examples, predict) {
  let correct = 0;
  let truePositive = 0, trueNegative = 0, falsePositive = 0, falseNegative = 0;
  let positiveRecallNumerator = 0;
  let positiveRecallDenominator = 0;
  let negativeRecallNumerator = 0;
  let negativeRecallDenominator = 0;
  let logLoss = 0;
  let brierScore = 0;
  const calibration = Array.from({ length: 10 }, (_, index) => ({ bin: index, count: 0, meanPredictedProbability: 0, observedPositiveRate: 0 }));
  for (const example of examples) {
    const probability = clamp(predict(example.features), 1e-15, 1 - 1e-15);
    const predicted = probability >= 0.5 ? 1 : 0;
    if (predicted === example.label) correct += 1;
    if (predicted === 1 && example.label === 1) truePositive += 1;
    else if (predicted === 0 && example.label === 0) trueNegative += 1;
    else if (predicted === 1) falsePositive += 1;
    else falseNegative += 1;
    if (example.label === 1) { positiveRecallDenominator += 1; if (predicted === 1) positiveRecallNumerator += 1; }
    else { negativeRecallDenominator += 1; if (predicted === 0) negativeRecallNumerator += 1; }
    logLoss -= example.label * Math.log(probability) + (1 - example.label) * Math.log(1 - probability);
    brierScore += (probability - example.label) ** 2;
    const bin = calibration[Math.min(9, Math.floor(probability * 10))];
    bin.count += 1;
    bin.meanPredictedProbability += probability;
    bin.observedPositiveRate += example.label;
  }
  const positiveRecall = positiveRecallDenominator ? positiveRecallNumerator / positiveRecallDenominator : 0;
  const negativeRecall = negativeRecallDenominator ? negativeRecallNumerator / negativeRecallDenominator : 0;
  for (const bin of calibration) if (bin.count) {
    bin.meanPredictedProbability /= bin.count;
    bin.observedPositiveRate /= bin.count;
  }
  const precision = truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : 0;
  const recall = positiveRecall;
  const accuracy = correct / examples.length;
  const z = 1.959963984540054;
  const denominator = 1 + z * z / examples.length;
  const center = (accuracy + z * z / (2 * examples.length)) / denominator;
  const margin = z * Math.sqrt(accuracy * (1 - accuracy) / examples.length + z * z / (4 * examples.length ** 2)) / denominator;
  return {
    accuracy, balancedAccuracy: (positiveRecall + negativeRecall) / 2, logLoss: logLoss / examples.length,
    precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0,
    brierScore: brierScore / examples.length,
    confusionMatrix: { truePositive, trueNegative, falsePositive, falseNegative },
    classBalance: { negative: negativeRecallDenominator, positive: positiveRecallDenominator },
    accuracyConfidenceInterval95: { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin), method: 'wilson_score' },
    calibration
  };
}

export function evaluateAdaptiveGoalDiscriminator(modelInput, examplesInput) {
  const model = validateAdaptiveGoalDiscriminatorModel(modelInput);
  const examples = canonicalExamples(examplesInput, 'evaluationExamples', 1);
  if (new Set(examples.map(item => item.id)).size !== examples.length) fail('evaluation example IDs must be unique');
  const metrics = metricsFor(examples, features => scoreAdaptiveGoalDiscriminator(model, features).probability);
  const accuracyTargetAssessment = examples.length < 30 ? 'INSUFFICIENT_SAMPLE_SIZE'
    : metrics.accuracyConfidenceInterval95.lower > 0.8 ? 'SUPPORTED_BY_95_PERCENT_CONFIDENCE_INTERVAL'
      : metrics.accuracy > 0.8 ? 'POINT_ESTIMATE_ABOVE_80_PERCENT_ONLY' : 'NOT_MET';
  return {
    schemaVersion: 1,
    modelSha256: model.modelSha256,
    evaluationDataSha256: sha256(examples),
    evaluationExampleCount: examples.length,
    metrics,
    accuracyTargetAssessment,
    classification: 'offline_shadow_metrics_not_acceptance'
  };
}

/** Train only on caller-supplied labelled examples; validation examples are never used for fitting. */
export function trainAdaptiveGoalDiscriminator({ trainingExamples: trainingInput, validationExamples: validationInput, learningRate = 0.15, epochs = 1500, l2 = 0.01, seed = 0, datasetId = 'unspecified-dataset' }) {
  const training = canonicalExamples(trainingInput, 'trainingExamples', 4);
  const validation = canonicalExamples(validationInput, 'validationExamples', 2);
  if (new Set(training.map(item => item.id)).size !== training.length || new Set(validation.map(item => item.id)).size !== validation.length) fail('example IDs must be unique within each split');
  const allIds = new Set(training.map(item => item.id));
  if (validation.some(item => allIds.has(item.id))) fail('training/validation split leakage: example IDs overlap');
  const trainingFingerprints = new Set(training.map(item => sha256(item.features)));
  if (validation.some(item => trainingFingerprints.has(sha256(item.features)))) {
    fail('training/validation split leakage: identical feature vector appears in both splits');
  }
  const positives = training.filter(item => item.label === 1).length;
  const negatives = training.length - positives;
  if (!positives || !negatives || !validation.some(item => item.label === 1) || !validation.some(item => item.label === 0)) fail('both classes must be present in training and validation splits');
  if (typeof learningRate !== 'number' || !Number.isFinite(learningRate) || learningRate <= 0 || learningRate > 1) fail('learningRate must be in (0, 1]');
  if (!Number.isInteger(epochs) || epochs < 1 || epochs > 100000) fail('epochs must be an integer in [1, 100000]');
  if (epochs * training.length > MAX_TRAINING_EXAMPLE_EPOCHS) {
    fail(`training work exceeds the ${MAX_TRAINING_EXAMPLE_EPOCHS} example-epoch budget`);
  }
  if (typeof l2 !== 'number' || !Number.isFinite(l2) || l2 < 0 || l2 > 10) fail('l2 must be in [0, 10]');
  if (!Number.isSafeInteger(seed) || seed < 0) fail('seed must be a non-negative safe integer');
  if (typeof datasetId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(datasetId)) fail('datasetId is invalid');

  const means = {}, scales = {}, weights = {};
  // A tiny seeded initialization makes the recorded seed an actual training
  // input while keeping the convex optimizer deterministic for a fixed seed.
  let randomState = BigInt(seed);
  const mask64 = (1n << 64n) - 1n;
  const random = () => {
    randomState = (randomState + 0x9e3779b97f4a7c15n) & mask64;
    let value = randomState;
    value = ((value ^ (value >> 30n)) * 0xbf58476d1ce4e5b9n) & mask64;
    value = ((value ^ (value >> 27n)) * 0x94d049bb133111ebn) & mask64;
    value ^= value >> 31n;
    return Number(value >> 11n) / 9007199254740992;
  };
  for (const name of ADAPTIVE_GOAL_DISCRIMINATOR_FEATURES) {
    means[name] = training.reduce((sum, item) => sum + item.features[name], 0) / training.length;
    const variance = training.reduce((sum, item) => sum + (item.features[name] - means[name]) ** 2, 0) / training.length;
    scales[name] = Math.max(Math.sqrt(variance), 1e-6);
    // Constant features start at exactly zero: a tiny coefficient multiplied by
    // the minimum scale can otherwise dominate predictions far outside training.
    weights[name] = variance < 1e-12 ? 0 : (random() - 0.5) * 2e-8;
  }
  let intercept = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradients = Object.fromEntries(ADAPTIVE_GOAL_DISCRIMINATOR_FEATURES.map(name => [name, 0]));
    let interceptGradient = 0;
    for (const example of training) {
      let logit = intercept;
      for (const name of ADAPTIVE_GOAL_DISCRIMINATOR_FEATURES) logit += weights[name] * ((example.features[name] - means[name]) / scales[name]);
      const error = sigmoid(logit) - example.label;
      interceptGradient += error;
      for (const name of ADAPTIVE_GOAL_DISCRIMINATOR_FEATURES) gradients[name] += error * ((example.features[name] - means[name]) / scales[name]);
    }
    const rate = learningRate / Math.sqrt(1 + epoch / 100);
    intercept -= rate * interceptGradient / training.length;
    if (!Number.isFinite(intercept) || Math.abs(intercept) > 1e6) fail('training diverged: intercept exceeded the numeric safety bound');
    for (const name of ADAPTIVE_GOAL_DISCRIMINATOR_FEATURES) {
      weights[name] -= rate * (gradients[name] / training.length + l2 * weights[name]);
      if (!Number.isFinite(weights[name]) || Math.abs(weights[name]) > 1e6) fail(`training diverged: weight ${name} exceeded the numeric safety bound`);
    }
  }
  const predict = features => {
    let logit = intercept;
    for (const name of ADAPTIVE_GOAL_DISCRIMINATOR_FEATURES) logit += weights[name] * ((features[name] - means[name]) / scales[name]);
    return sigmoid(logit);
  };
  const body = {
    schemaVersion: ADAPTIVE_GOAL_DISCRIMINATOR_SCHEMA_VERSION,
    featureSchemaVersion: ADAPTIVE_GOAL_DISCRIMINATOR_FEATURE_SCHEMA_VERSION,
    modelType: 'standardized-logistic-regression',
    featureNames: [...ADAPTIVE_GOAL_DISCRIMINATOR_FEATURES], datasetId,
    trainingConfig: { learningRate, epochs, l2, seed },
    trainingDataSha256: sha256(training), validationDataSha256: sha256(validation), means, scales, weights, intercept,
    trainingExampleCount: training.length,
    trainingClassCounts: { negative: negatives, positive: positives },
    trainingMetrics: metricsFor(training, predict)
  };
  const model = { ...body, modelSha256: sha256(body) };
  validateAdaptiveGoalDiscriminatorModel(model);
  const evaluation = evaluateAdaptiveGoalDiscriminator(model, validation);
  return { model, evaluation, training: { exampleCount: training.length, dataSha256: model.trainingDataSha256, metrics: model.trainingMetrics }, validation: evaluation };
}
