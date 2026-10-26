import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';
import { ADAPTIVE_GOAL_DISCRIMINATOR_FEATURES, ADAPTIVE_GOAL_DISCRIMINATOR_FEATURE_SCHEMA_VERSION, validateAdaptiveGoalDiscriminatorModel } from './adaptive-goal-discriminator.js';

const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
const fail = message => { throw new TypeError(`AdaptiveGoalPhase2Dataset: ${message}`); };
const exact = (value, keys, field) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  const extra = Object.keys(value).filter(key => !keys.includes(key));
  if (extra.length) fail(`${field} has unsupported fields: ${extra.sort().join(', ')}`);
};

function validateMetricsSummary(metrics, count, field) {
  const metricKeys = ['accuracy', 'balancedAccuracy', 'logLoss', 'precision', 'recall', 'f1', 'brierScore',
    'confusionMatrix', 'classBalance', 'accuracyConfidenceInterval95', 'calibration'];
  exact(metrics, metricKeys, field);
  for (const key of ['accuracy', 'balancedAccuracy', 'precision', 'recall', 'f1', 'brierScore']) {
    if (typeof metrics[key] !== 'number' || !Number.isFinite(metrics[key]) || metrics[key] < 0 || metrics[key] > 1) fail(`${field}.${key} is invalid`);
  }
  if (typeof metrics.logLoss !== 'number' || !Number.isFinite(metrics.logLoss) || metrics.logLoss < 0 || metrics.logLoss > 35) fail(`${field}.logLoss is invalid`);
  exact(metrics.confusionMatrix, ['truePositive', 'trueNegative', 'falsePositive', 'falseNegative'], `${field}.confusionMatrix`);
  const cm = metrics.confusionMatrix;
  for (const [key, value] of Object.entries(cm)) if (!Number.isSafeInteger(value) || value < 0) fail(`${field}.confusionMatrix.${key} is invalid`);
  if (Object.values(cm).reduce((sum, value) => sum + value, 0) !== count) fail(`${field}.confusionMatrix count mismatch`);
  exact(metrics.classBalance, ['negative', 'positive'], `${field}.classBalance`);
  const negative = cm.trueNegative + cm.falsePositive, positive = cm.truePositive + cm.falseNegative;
  if (metrics.classBalance.negative !== negative || metrics.classBalance.positive !== positive || negative + positive !== count || !negative || !positive) {
    fail(`${field}.classBalance does not match confusion matrix`);
  }
  const ratioEqual = (actual, expected) => Math.abs(actual - expected) <= 1e-12;
  const accuracy = (cm.truePositive + cm.trueNegative) / count;
  const precision = cm.truePositive + cm.falsePositive ? cm.truePositive / (cm.truePositive + cm.falsePositive) : 0;
  const recall = cm.truePositive + cm.falseNegative ? cm.truePositive / (cm.truePositive + cm.falseNegative) : 0;
  const negativeRecall = cm.trueNegative + cm.falsePositive ? cm.trueNegative / (cm.trueNegative + cm.falsePositive) : 0;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  if (!ratioEqual(metrics.accuracy, accuracy) || !ratioEqual(metrics.precision, precision) || !ratioEqual(metrics.recall, recall) ||
      !ratioEqual(metrics.f1, f1) || !ratioEqual(metrics.balancedAccuracy, (recall + negativeRecall) / 2)) {
    fail(`${field} classification metrics are internally inconsistent`);
  }
  exact(metrics.accuracyConfidenceInterval95, ['lower', 'upper', 'method'], `${field}.accuracyConfidenceInterval95`);
  const interval = metrics.accuracyConfidenceInterval95;
  if (typeof interval.lower !== 'number' || !Number.isFinite(interval.lower) || typeof interval.upper !== 'number' || !Number.isFinite(interval.upper) ||
      interval.lower < 0 || interval.upper > 1 || interval.lower > interval.upper || interval.method !== 'wilson_score') fail(`${field}.accuracyConfidenceInterval95 is invalid`);
  const z = 1.959963984540054, denominator = 1 + z * z / count;
  const center = (accuracy + z * z / (2 * count)) / denominator;
  const margin = z * Math.sqrt(accuracy * (1 - accuracy) / count + z * z / (4 * count ** 2)) / denominator;
  if (!ratioEqual(interval.lower, Math.max(0, center - margin)) || !ratioEqual(interval.upper, Math.min(1, center + margin))) {
    fail(`${field}.accuracyConfidenceInterval95 does not match accuracy and count`);
  }
  if (!Array.isArray(metrics.calibration) || metrics.calibration.length !== 10) fail(`${field}.calibration must contain 10 bins`);
  let calibrationCount = 0, calibrationPositiveMass = 0;
  for (let index = 0; index < metrics.calibration.length; index++) {
    const bin = metrics.calibration[index];
    exact(bin, ['bin', 'count', 'meanPredictedProbability', 'observedPositiveRate'], `${field}.calibration[${index}]`);
    if (bin.bin !== index || !Number.isSafeInteger(bin.count) || bin.count < 0 ||
        typeof bin.meanPredictedProbability !== 'number' || !Number.isFinite(bin.meanPredictedProbability) || bin.meanPredictedProbability < 0 || bin.meanPredictedProbability > 1 ||
        typeof bin.observedPositiveRate !== 'number' || !Number.isFinite(bin.observedPositiveRate) || bin.observedPositiveRate < 0 || bin.observedPositiveRate > 1 ||
        (bin.count === 0 && (bin.meanPredictedProbability !== 0 || bin.observedPositiveRate !== 0))) fail(`${field}.calibration[${index}] is invalid`);
    calibrationCount += bin.count;
    calibrationPositiveMass += bin.count * bin.observedPositiveRate;
  }
  if (calibrationCount !== count || !ratioEqual(calibrationPositiveMass, positive)) fail(`${field}.calibration does not match example count/class balance`);
}

function normalizeSplit(input, name, minCount = 2) {
  if (!Array.isArray(input) || input.length < minCount || input.length > 100000) fail(`${name} must contain ${minCount}-100000 examples`);
  const ids = new Set();
  const fingerprints = new Set();
  const examples = input.map((item, index) => {
    exact(item, ['id', 'features', 'label'], `${name}[${index}]`);
    if (typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(item.id)) fail(`${name}[${index}].id is invalid`);
    if (ids.has(item.id)) fail(`${name} contains duplicate ID ${item.id}`);
    ids.add(item.id);
    if (item.label !== 0 && item.label !== 1) fail(`${name}[${index}].label must be 0 or 1`);
    exact(item.features, ADAPTIVE_GOAL_DISCRIMINATOR_FEATURES, `${name}[${index}].features`);
    const features = {};
    for (const feature of ADAPTIVE_GOAL_DISCRIMINATOR_FEATURES) {
      const value = item.features[feature];
      if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0) || value < 0 || value > 1) fail(`${name}[${index}].features.${feature} must be finite in [0, 1] and not negative zero`);
      features[feature] = value;
    }
    const fingerprint = sha256(features);
    if (fingerprints.has(fingerprint)) fail(`${name} contains duplicate feature vectors`);
    fingerprints.add(fingerprint);
    return { id: item.id, features, label: item.label };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const counts = { negative: examples.filter(item => item.label === 0).length, positive: examples.filter(item => item.label === 1).length };
  if (!counts.negative || !counts.positive) fail(`${name} must contain both label classes`);
  return { examples, counts, sha256: sha256(examples) };
}

export function validateAdaptiveGoalPhase2Dataset(input) {
  exact(input, ['schemaVersion', 'featureSchemaVersion', 'datasetId', 'labelProvenance', 'trainingExamples', 'validationExamples', 'holdoutExamples'], 'dataset');
  if (input.schemaVersion !== 1 || input.featureSchemaVersion !== ADAPTIVE_GOAL_DISCRIMINATOR_FEATURE_SCHEMA_VERSION) fail('unsupported dataset or feature schema version');
  if (typeof input.datasetId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(input.datasetId)) fail('datasetId is invalid');
  exact(input.labelProvenance, ['kind', 'source', 'adjudicatorId', 'adjudicationProtocol', 'independent'], 'dataset.labelProvenance');
  if (typeof input.labelProvenance.source !== 'string' || !input.labelProvenance.source.trim() ||
      typeof input.labelProvenance.adjudicatorId !== 'string' || !input.labelProvenance.adjudicatorId.trim() ||
      typeof input.labelProvenance.adjudicationProtocol !== 'string' || !input.labelProvenance.adjudicationProtocol.trim() ||
      !['synthetic', 'independently_adjudicated'].includes(input.labelProvenance.kind) ||
      (input.labelProvenance.kind === 'independently_adjudicated' && input.labelProvenance.independent !== true) ||
      (input.labelProvenance.kind === 'synthetic' && input.labelProvenance.independent !== false)) {
    fail('labelProvenance must explicitly declare synthetic or independently_adjudicated with consistent independence metadata');
  }
  const training = normalizeSplit(input.trainingExamples, 'trainingExamples', 4);
  const validation = normalizeSplit(input.validationExamples, 'validationExamples', 2);
  const holdout = normalizeSplit(input.holdoutExamples, 'holdoutExamples', 2);
  const splits = [['trainingExamples', training], ['validationExamples', validation], ['holdoutExamples', holdout]];
  const ids = new Map();
  const content = new Map();
  for (const [name, split] of splits) for (const example of split.examples) {
    if (ids.has(example.id)) fail(`split leakage by ID ${example.id}: ${ids.get(example.id)} overlaps ${name}`);
    ids.set(example.id, name);
    const fingerprint = sha256(example.features);
    if (content.has(fingerprint)) fail(`split leakage by content: ${content.get(fingerprint)} overlaps ${name}`);
    content.set(fingerprint, name);
  }
  const canonical = {
    schemaVersion: 1, featureSchemaVersion: ADAPTIVE_GOAL_DISCRIMINATOR_FEATURE_SCHEMA_VERSION,
    datasetId: input.datasetId, labelProvenance: input.labelProvenance,
    trainingExamples: training.examples, validationExamples: validation.examples, holdoutExamples: holdout.examples
  };
  return {
    ...canonical,
    datasetSha256: sha256(canonical),
    splits: {
      training: { count: training.examples.length, sha256: training.sha256, classBalance: training.counts },
      validation: { count: validation.examples.length, sha256: validation.sha256, classBalance: validation.counts },
      holdout: { count: holdout.examples.length, sha256: holdout.sha256, classBalance: holdout.counts }
    },
    provenanceAssessment: { kind: input.labelProvenance.kind, declaredIndependent: input.labelProvenance.independent, groundTruthGeneratedBySearch: false, independentAttestationPresent: false }
  };
}

export function validateAdaptiveGoalPhase2ModelArtifact(input) {
  exact(input, ['schemaVersion', 'kind', 'artifactSha256', 'datasetId', 'datasetFileSha256', 'datasetSha256', 'featureSchemaVersion', 'labelProvenance',
    'provenanceAssessment', 'splitIdentities', 'sourceIdentity', 'model', 'training', 'validation', 'status', 'acceptance', 'execution'], 'modelArtifact');
  if (input.schemaVersion !== 2 || input.kind !== 'agg_phase2_discriminator_model' || !/^[a-f0-9]{64}$/.test(input.artifactSha256) ||
      typeof input.datasetId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(input.datasetId) ||
      input.featureSchemaVersion !== ADAPTIVE_GOAL_DISCRIMINATOR_FEATURE_SCHEMA_VERSION ||
      !/^[a-f0-9]{64}$/.test(input.datasetFileSha256) || !/^[a-f0-9]{64}$/.test(input.datasetSha256)) fail('model artifact envelope identity is invalid');
  const { artifactSha256, ...body } = input;
  if (sha256(body) !== artifactSha256) fail('model artifact envelope hash mismatch');
  exact(input.labelProvenance, ['kind', 'source', 'adjudicatorId', 'adjudicationProtocol', 'independent'], 'modelArtifact.labelProvenance');
  exact(input.provenanceAssessment, ['kind', 'declaredIndependent', 'groundTruthGeneratedBySearch', 'independentAttestationPresent'], 'modelArtifact.provenanceAssessment');
  if (!['synthetic', 'independently_adjudicated'].includes(input.labelProvenance.kind) ||
      typeof input.labelProvenance.source !== 'string' || !input.labelProvenance.source.trim() ||
      typeof input.labelProvenance.adjudicatorId !== 'string' || !input.labelProvenance.adjudicatorId.trim() ||
      typeof input.labelProvenance.adjudicationProtocol !== 'string' || !input.labelProvenance.adjudicationProtocol.trim() ||
      typeof input.labelProvenance.independent !== 'boolean' ||
      (input.labelProvenance.kind === 'independently_adjudicated' && input.labelProvenance.independent !== true) ||
      (input.labelProvenance.kind === 'synthetic' && input.labelProvenance.independent !== false) ||
      input.provenanceAssessment.kind !== input.labelProvenance.kind || input.provenanceAssessment.declaredIndependent !== input.labelProvenance.independent ||
      input.provenanceAssessment.groundTruthGeneratedBySearch !== false || input.provenanceAssessment.independentAttestationPresent !== false) fail('model artifact label provenance is invalid or overclaims attestation');
  exact(input.splitIdentities, ['training', 'validation', 'holdout'], 'modelArtifact.splitIdentities');
  for (const splitName of ['training', 'validation', 'holdout']) {
    const split = input.splitIdentities[splitName];
    exact(split, ['count', 'sha256', 'classBalance'], `modelArtifact.splitIdentities.${splitName}`);
    exact(split.classBalance, ['negative', 'positive'], `modelArtifact.splitIdentities.${splitName}.classBalance`);
    if (!Number.isSafeInteger(split.count) || split.count < (splitName === 'training' ? 4 : 2) || !/^[a-f0-9]{64}$/.test(split.sha256) ||
        !Number.isSafeInteger(split.classBalance.negative) || split.classBalance.negative < 1 ||
        !Number.isSafeInteger(split.classBalance.positive) || split.classBalance.positive < 1 ||
        split.classBalance.negative + split.classBalance.positive !== split.count) fail(`model artifact split identity ${splitName} is invalid`);
  }
  const requiredSourceIdentityKeys = ['trainerCliSha256', 'discriminatorSha256', 'datasetValidatorSha256', 'strictJsonParserSha256', 'canonicalJsonSha256'];
  exact(input.sourceIdentity, requiredSourceIdentityKeys, 'modelArtifact.sourceIdentity');
  if (requiredSourceIdentityKeys.some(key => !Object.hasOwn(input.sourceIdentity, key))) fail('model artifact sourceIdentity is missing a required source digest');
  for (const [name, digest] of Object.entries(input.sourceIdentity)) if (!/^[a-f0-9]{64}$/.test(digest)) fail(`modelArtifact.sourceIdentity.${name} is invalid`);
  const model = validateAdaptiveGoalDiscriminatorModel(input.model);
  if (model.datasetId !== input.datasetId || model.featureSchemaVersion !== input.featureSchemaVersion ||
      model.trainingDataSha256 !== input.splitIdentities.training.sha256 || model.validationDataSha256 !== input.splitIdentities.validation.sha256 ||
      canonicalJson(model.trainingClassCounts) !== canonicalJson(input.splitIdentities.training.classBalance)) fail('model coefficients do not match the dataset/split identity');
  exact(input.training, ['exampleCount', 'dataSha256', 'metrics'], 'modelArtifact.training');
  if (input.training.exampleCount !== model.trainingExampleCount || input.training.dataSha256 !== model.trainingDataSha256 ||
      canonicalJson(input.training.metrics) !== canonicalJson(model.trainingMetrics)) fail('model artifact training summary does not match model metadata');
  exact(input.validation, ['schemaVersion', 'modelSha256', 'evaluationDataSha256', 'evaluationExampleCount', 'metrics', 'accuracyTargetAssessment', 'classification'], 'modelArtifact.validation');
  if (input.validation.schemaVersion !== 1 || input.validation.modelSha256 !== model.modelSha256 || input.validation.evaluationDataSha256 !== model.validationDataSha256 ||
      input.validation.evaluationExampleCount !== input.splitIdentities.validation.count ||
      !['INSUFFICIENT_SAMPLE_SIZE', 'SUPPORTED_BY_95_PERCENT_CONFIDENCE_INTERVAL', 'POINT_ESTIMATE_ABOVE_80_PERCENT_ONLY', 'NOT_MET'].includes(input.validation.accuracyTargetAssessment) ||
      input.validation.classification !== 'offline_shadow_metrics_not_acceptance') fail('model artifact validation summary is invalid');
  validateMetricsSummary(input.validation.metrics, input.validation.evaluationExampleCount, 'modelArtifact.validation.metrics');
  const validationMetrics = input.validation.metrics;
  const expectedAssessment = input.validation.evaluationExampleCount < 30 ? 'INSUFFICIENT_SAMPLE_SIZE'
    : validationMetrics.accuracyConfidenceInterval95.lower > 0.8 ? 'SUPPORTED_BY_95_PERCENT_CONFIDENCE_INTERVAL'
      : validationMetrics.accuracy > 0.8 ? 'POINT_ESTIMATE_ABOVE_80_PERCENT_ONLY' : 'NOT_MET';
  if (input.validation.accuracyTargetAssessment !== expectedAssessment) fail('model artifact validation assessment does not match its metrics');
  if (input.status !== 'offline_shadow_model_not_acceptance' || input.acceptance !== 'acceptance_required') fail('model artifact must remain offline and non-acceptance');
  exact(input.execution, ['enabled', 'authorized', 'dispatched'], 'modelArtifact.execution');
  if (input.execution.enabled !== false || input.execution.authorized !== false || input.execution.dispatched !== false) fail('model artifact execution authority must remain disabled');
  return input;
}
