/**
 * Paired analysis helpers for the frozen Phase 1 graph benchmark.
 *
 * A generated task graph is the pairing unit. Seed variants are not treated as
 * independent production tasks: uncertainty is clustered at task-family level.
 */
import assert from 'node:assert/strict';

function rngFor(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function percentile(values, quantile) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)] : null;
}

function normalizedMethodKey(record) {
  return record.methodKey ?? `${record.method}:${record.beamWidth ?? '-'}`;
}

function normalizedTaskInstanceKey(record) {
  return record.taskInstanceId ?? `${record.taskId}::iteration-${record.iteration}::seed-${record.seed}`;
}

/**
 * Report a complete matched 2x2 success table and an exploratory 95% interval.
 * No significance or acceptance decision is inferred from this function.
 */
export function pairedOutcomeAnalysis(records, methodA, methodB, {
  bootstrapSeed = 776655,
  bootstrapSamples = 10_000
} = {}) {
  assert(Array.isArray(records), 'paired analysis requires a record array');
  assert(methodA !== methodB, 'paired methods must be different');
  assert(Number.isInteger(bootstrapSamples) && bootstrapSamples >= 1, 'bootstrapSamples must be a positive integer');

  const matchedByMethod = new Map([[methodA, new Map()], [methodB, new Map()]]);
  for (const record of records) {
    const method = normalizedMethodKey(record);
    if (!matchedByMethod.has(method)) continue;
    assert.equal(typeof record.taskOutcomeCorrect, 'boolean', `missing binary outcome for ${method}`);
    const taskInstanceId = normalizedTaskInstanceKey(record);
    const target = matchedByMethod.get(method);
    assert.ok(!target.has(taskInstanceId), `duplicate paired outcome ${taskInstanceId}/${method}`);
    target.set(taskInstanceId, record);
  }

  const mapA = matchedByMethod.get(methodA);
  const mapB = matchedByMethod.get(methodB);
  assert.ok(mapA.size > 0, `no paired records found for ${methodA}`);
  assert.equal(mapA.size, mapB.size, `paired record count differs for ${methodA} versus ${methodB}`);
  for (const taskInstanceId of mapA.keys()) {
    assert.ok(mapB.has(taskInstanceId), `missing ${methodB} counterpart for ${taskInstanceId}`);
  }

  const pairs = [...mapA.keys()].sort().map(taskInstanceId => {
    const a = mapA.get(taskInstanceId);
    const b = mapB.get(taskInstanceId);
    assert.equal(a.taskFamily, b.taskFamily, `task-family mismatch for ${taskInstanceId}`);
    assert.equal(a.taskId, b.taskId, `template mismatch for ${taskInstanceId}`);
    assert.equal(a.iteration, b.iteration, `iteration mismatch for ${taskInstanceId}`);
    assert.equal(a.seed, b.seed, `seed mismatch for ${taskInstanceId}`);
    assert.equal(a.inputGraphSha256, b.inputGraphSha256, `graph mismatch for paired task ${taskInstanceId}`);
    assert.equal(a.expectedOutcome, b.expectedOutcome, `oracle outcome mismatch for ${taskInstanceId}`);
    return { taskInstanceId, taskId: a.taskId, familyId: a.taskFamily, a: a.taskOutcomeCorrect, b: b.taskOutcomeCorrect };
  });

  const familyGroups = new Map();
  for (const pair of pairs) {
    if (!familyGroups.has(pair.familyId)) familyGroups.set(pair.familyId, []);
    familyGroups.get(pair.familyId).push(pair);
  }
  const families = [...familyGroups.keys()].sort();
  assert.ok(families.length > 0, 'paired analysis has no task-family clusters');
  const familyRows = families.map(familyId => {
    const rows = familyGroups.get(familyId);
    const bothCorrect = rows.filter(row => row.a && row.b).length;
    const aOnlyCorrect = rows.filter(row => row.a && !row.b).length;
    const bOnlyCorrect = rows.filter(row => !row.a && row.b).length;
    const bothIncorrect = rows.filter(row => !row.a && !row.b).length;
    return {
      familyId,
      pairedTaskInstances: rows.length,
      bothCorrect,
      aOnlyCorrect,
      bOnlyCorrect,
      bothIncorrect,
      successRateA: rows.filter(row => row.a).length / rows.length,
      successRateB: rows.filter(row => row.b).length / rows.length,
      differenceAminusB: rows.reduce((sum, row) => sum + Number(row.a) - Number(row.b), 0) / rows.length
    };
  });
  const bothCorrect = pairs.filter(row => row.a && row.b).length;
  const aOnlyCorrect = pairs.filter(row => row.a && !row.b).length;
  const bOnlyCorrect = pairs.filter(row => !row.a && row.b).length;
  const bothIncorrect = pairs.filter(row => !row.a && !row.b).length;
  const successRateA = pairs.filter(row => row.a).length / pairs.length;
  const successRateB = pairs.filter(row => row.b).length / pairs.length;
  const observed = familyRows.reduce((sum, row) => sum + row.differenceAminusB, 0) / familyRows.length;

  const random = rngFor(bootstrapSeed);
  const boot = Array.from({ length: bootstrapSamples }, () => {
    let total = 0;
    for (let index = 0; index < familyRows.length; index += 1) {
      total += familyRows[Math.floor(random() * familyRows.length)].differenceAminusB;
    }
    return total / familyRows.length;
  }).sort((a, b) => a - b);
  const ci = [percentile(boot, 0.025), percentile(boot, 0.975)].map(value => Number(value.toFixed(5)));

  let interpretation = 'The 95% family-cluster bootstrap interval includes zero; this is inconclusive, not evidence that the methods are equivalent.';
  if (ci[0] > 0) interpretation = 'The exploratory interval is positive on this synthetic family distribution; seven clusters are too few to treat this as confirmatory acceptance evidence.';
  else if (ci[1] < 0) interpretation = 'The exploratory interval is negative on this synthetic family distribution; seven clusters are too few to treat this as confirmatory acceptance evidence.';

  return {
    methodA,
    methodB,
    outcome: 'taskOutcomeCorrect',
    pairingKey: 'taskInstanceId (task template × fixed graph seed)',
    pairedTaskInstances: pairs.length,
    taskTemplates: new Set(pairs.map(row => row.taskId)).size,
    independentTaskFamilyClusters: families.length,
    contingency: { bothCorrect, aOnlyCorrect, bOnlyCorrect, bothIncorrect },
    successRateA: Number(successRateA.toFixed(5)),
    successRateB: Number(successRateB.toFixed(5)),
    pairedSuccessRateDifferenceAminusB: Number((successRateA - successRateB).toFixed(5)),
    familyClusterEqualWeightDifferenceAminusB: Number(observed.toFixed(5)),
    bootstrap95PercentileCI: ci,
    bootstrapSamples,
    bootstrapSeed,
    bootstrapUnit: 'task-family cluster; resample the seven synthetic family clusters with replacement and preserve all task-template/seed pairs within each selected cluster',
    familyBreakdown: familyRows.map(row => ({
      familyId: row.familyId,
      pairedTaskInstances: row.pairedTaskInstances,
      contingency: {
        bothCorrect: row.bothCorrect,
        aOnlyCorrect: row.aOnlyCorrect,
        bOnlyCorrect: row.bOnlyCorrect,
        bothIncorrect: row.bothIncorrect
      },
      successRateA: Number(row.successRateA.toFixed(5)),
      successRateB: Number(row.successRateB.toFixed(5)),
      differenceAminusB: Number(row.differenceAminusB.toFixed(5))
    })),
    powerAnalysis: {
      status: 'NOT_ESTIMATED',
      reason: 'Only seven synthetic task-family clusters are present, no approved minimum practically important AGG effect size/power target is specified, and the one-task local-model pilot is not a valid basis for a power estimate.'
    },
    interpretation
  };
}
