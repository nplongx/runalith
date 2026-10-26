import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(root, 'benchmarks/plugin-workflow-benchmark/scenario-dev-only-case01-harness.mjs');
const evidenceRoot = path.join(root, 'artifacts/phase1-dev-only');
const officialSpecPath = path.join(root, 'benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v1.json');
const candidatePath = path.join(root, 'artifacts/runalith-1.0.9-rc.5-candidate-latest-build-20261022T175328+0700.mcpb');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function uniqueOutput(suffix) {
  return path.join(evidenceRoot, `test-dev-harness-${process.pid}-${Date.now()}-${suffix}.json`);
}

test('dev-only pilot blocks before a prompt unless the explicit non-acceptance marker is supplied', () => {
  fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
  const output = uniqueOutput('missing-marker');
  const officialSpecBefore = fs.readFileSync(officialSpecPath);
  const candidateBefore = fs.readFileSync(candidatePath);
  try {
    const result = spawnSync(process.execPath, [runner, '--case', 'CASE-01', '--output', output], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 2, `${result.stderr}\n${result.stdout}`);
    const evidence = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(evidence.status, 'blocked');
    assert.equal(evidence.dev_only_not_acceptance, true);
    assert.equal(evidence.official_acceptance_eligible, false);
    assert.equal(evidence.benchmark_scenarios_executed, false);
    assert.equal(evidence.scenario_prompt_issued, false);
    assert.equal(sha256(fs.readFileSync(officialSpecPath)), sha256(officialSpecBefore));
    assert.equal(sha256(fs.readFileSync(candidatePath)), sha256(candidateBefore));
  } finally {
    fs.rmSync(output, { force: true });
    fs.rmSync(`${output}.evidence`, { recursive: true, force: true });
  }
});

test('dev-only pilot refuses CASE-02 and spec-version overrides before workspace or model invocation', () => {
  fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
  const invalidCaseOutput = uniqueOutput('case-02');
  const invalidSpecOutput = uniqueOutput('spec-2');
  try {
    const invalidCase = spawnSync(process.execPath, [runner, '--case', 'CASE-02', '--output', invalidCaseOutput, '--dev-only-not-acceptance'], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(invalidCase.status, 1, `${invalidCase.stderr}\n${invalidCase.stdout}`);
    assert.match(invalidCase.stderr, /permits CASE-01 only/);
    assert.equal(fs.existsSync(invalidCaseOutput), false);

    const invalidSpec = spawnSync(process.execPath, [runner, '--case', 'CASE-01', '--spec-version', '2', '--output', invalidSpecOutput, '--dev-only-not-acceptance'], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(invalidSpec.status, 1, `${invalidSpec.stderr}\n${invalidSpec.stdout}`);
    assert.match(invalidSpec.stderr, /fixed to the original v1 prompt bytes only/);
    assert.equal(fs.existsSync(invalidSpecOutput), false);
  } finally {
    for (const output of [invalidCaseOutput, invalidSpecOutput]) {
      fs.rmSync(output, { force: true });
      fs.rmSync(`${output}.evidence`, { recursive: true, force: true });
    }
  }
});
