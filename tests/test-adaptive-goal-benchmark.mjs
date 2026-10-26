import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v22.json');
const runnerPath = path.join(root, 'benchmarks/adaptive-goal-graph/run-benchmark.mjs');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

function run() {
  const result = spawnSync(process.execPath, [runnerPath], { cwd: root, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || `runner exited ${result.status}`);
  return JSON.parse(result.stdout);
}

function stableProjection(output) {
  return {
    config: output.config,
    summaries: output.summaries.map(({ meanRuntimeMs, ...summary }) => summary),
    records: output.records.map(({ runtimeMs, ...record }) => record)
  };
}

function createIsolatedRunnerWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-recovery-provenance-'));
  const files = [
    'package.json',
    'server/index.js',
    'server/index-v1.0.9-rc.7.js',
    'server/index-v1.0.9-rc.8.js',
    'tests/test-runalith-plugin.js',
    'tests/test-adaptive-goal-source-evidence.js',
    'tests/test-adaptive-goal-candidate-assessment-contract.mjs',
    'src/runtime/adaptive-goal-sandbox-executor.js',
    'benchmarks/adaptive-goal-graph/run-benchmark.mjs',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v18.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v19.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v20.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v21.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v22.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v17.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v15.json',
    'src/runtime/adaptive-goal-graph.js',
    'src/runtime/adaptive-goal-knowledge-store.js',
    'src/runtime/adaptive-goal-knowledge-verifier.js',
    'src/runtime/adaptive-goal-plan-adapter.js',
    'src/runtime/adaptive-goal-compatibility.js',
    'src/runtime/adaptive-goal-execution-graph-proposal.js',
    'src/runtime/adaptive-goal-reviewed-task-inputs.js',
    'src/runtime/adaptive-goal-execution-plan-candidate.js',
    'src/runtime/adaptive-goal-source-evidence.js',
    'tests/test-adaptive-goal-current-scope-producer-e2e.mjs',
    'tests/test-adaptive-goal-knowledge-verifier.mjs'
  ];
  for (const relative of new Set([...files, ...fixture.provenance.map(item => item.path)])) {
    const target = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, relative), target);
  }
  return workspace;
}

function isolatedFixturePath(workspace) {
  return path.join(workspace, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v22.json');
}

function runIsolated(workspace) {
  return spawnSync(process.execPath, [path.join(workspace, 'benchmarks/adaptive-goal-graph/run-benchmark.mjs')], {
    cwd: workspace, encoding: 'utf8', timeout: 15000
  });
}

function fixtureBytes(workspace) {
  return JSON.parse(fs.readFileSync(isolatedFixturePath(workspace), 'utf8'));
}

function saveFixture(workspace, value) {
  fs.writeFileSync(isolatedFixturePath(workspace), `${JSON.stringify(value, null, 2)}\n`);
}

test('versioned provenance pins current sources and preserves the previous artifact identities', () => {
  assert.equal(fixture.schemaVersion, 22);
  assert.equal(fixture.fixtureId, 'recovery-verifier-investigation-v22');
  assert.equal(fixture.supersedesFixtureId, 'recovery-verifier-investigation-v21');
  const historicalV20 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v20.json'));
  assert.equal(createHash('sha256').update(historicalV20).digest('hex'), '5f5e4f16da60ec94a7dfd9f83abcba484b4ad072b529b48aa0344e6706bcd882',
    'v20 source-pin provenance remains byte-for-byte preserved after successor fixture updates');
  const historicalV17 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v17.json'));
  assert.equal(createHash('sha256').update(historicalV17).digest('hex'), '44f8646db18d15894f5a25b5a83e7256e8a4bb7ea75f28180d02af5a061c06b0',
    'v17 trust-pair provenance remains immutable after the checkpoint-gate hardening');
  const historicalV19 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v19.json'));
  assert.equal(createHash('sha256').update(historicalV19).digest('hex'), '9122ab7c84166eac6b150dae9192414a3a2498945bd9a852baed37ed91edc613',
    'v19 successor provenance remains immutable after RC.10 reviewer-ledger diagnostic hardening');
  const historicalV16 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v16.json'));
  assert.equal(createHash('sha256').update(historicalV16).digest('hex'), '24ea4df5b4e6af26c99b31b92bd31934dcba26b41e11a9744ccd2b2164d9d453',
    'v16 provenance must remain byte-for-byte preserved after the v18 checkpoint-gate hardening');
  const historicalV15 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v15.json'));
  assert.equal(createHash('sha256').update(historicalV15).digest('hex'), '8426c48bd5c1a583cd80a6b1e417fc837da0e89ac3d297fc71ecf7edda3e66c4',
    'v15 provenance must remain byte-for-byte preserved after successor source-pin refresh');
  const historicalV14 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v14.json'));
  assert.equal(createHash('sha256').update(historicalV14).digest('hex'), '224787fe0cc6be275217d6a55d19f988354ce90323a6db6ff46ea577aed09ac6',
    'v14 lineage/recovery provenance must remain byte-for-byte preserved');
  const historicalV13 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v13.json'));
  assert.equal(createHash('sha256').update(historicalV13).digest('hex'), '743390d3b61f4a6ff0b19811d91068ef9bb155be15cc969af662cc30307149c7',
    'v13 packaging provenance fixture must remain byte-for-byte preserved');
  const historicalV12 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v12.json'));
  assert.equal(createHash('sha256').update(historicalV12).digest('hex'), 'f4bbd5c784315400dc25ec63e7c0b683a0a1c637b242f2cdb19a9fd43974f17a',
    'v12 reconciliation provenance fixture must remain byte-for-byte preserved');
  const historicalV11 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v11.json'));
  assert.equal(createHash('sha256').update(historicalV11).digest('hex'), 'f21bf5101e7410b2dd8b92e85d9fb6af31e7667f296fe8bb8a66d90af0c59839',
    'v11 trust-hardening provenance fixture must remain byte-for-byte preserved');
  const historicalV10 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v10.json'));
  assert.equal(createHash('sha256').update(historicalV10).digest('hex'), '331911bd0b36bbbbe390ae10387a8a1172d3d1a257d9e5b1140d1e2839f4e6ee',
    'v10 is a historical source identity and must remain byte-for-byte preserved');
  assert.ok(fixture.provenance.length >= 15);
  const historicalV5 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v5.json'));
  assert.equal(createHash('sha256').update(historicalV5).digest('hex'), 'a50232e160660d655bfb6b23543d42aeb83ca742546c08b7d0a729b0de659f7d',
    'versioned v5 provenance fixture must remain byte-for-byte preserved');
  const historicalV6 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v6.json'));
  assert.equal(createHash('sha256').update(historicalV6).digest('hex'), '342358144e9ae83b4b1865652fa4400fadb36231c4f38a683897dd801ab600e1',
    'versioned v6 provenance fixture must remain byte-for-byte preserved');
  assert.equal(new Set(fixture.provenance.map(source => source.path)).size, fixture.provenance.length);
  for (const source of fixture.provenance) {
    const bytes = fs.readFileSync(path.join(root, source.path));
    const observed = createHash('sha256').update(bytes).digest('hex');
    assert.equal(observed, source.sha256, `${source.path} provenance drifted; review fixture claims and update hash deliberately`);
    if (source.previouslyPinnedSha256 !== undefined) assert.match(source.previouslyPinnedSha256, /^[a-f0-9]{64}$/);
    if (source.historicalSnapshotPath !== undefined) assert.ok(source.historicalSnapshotPath.startsWith('artifacts/'), 'historical pin must retain its prior snapshot identity');
    assert.ok(source.claim.length > 20);
    if (source.semanticScope) {
      const content = bytes.toString('utf8');
      const start = content.indexOf(source.semanticScope.startMarker);
      const end = start < 0 ? -1 : content.indexOf(source.semanticScope.endMarker, start + source.semanticScope.startMarker.length);
      assert.ok(start >= 0 && end > start, `${source.path} semantic provenance markers must resolve to one source scope`);
      assert.equal(createHash('sha256').update(content.slice(start, end), 'utf8').digest('hex'), source.semanticScope.sha256,
        `${source.path} recovery-verifier scope drifted; review behavior and the scope pin deliberately`);
    }
  }
});

test('runner rejects source-byte drift even when the modified source remains readable', () => {
  const workspace = createIsolatedRunnerWorkspace();
  try {
    fs.appendFileSync(path.join(workspace, 'server/index.js'), '\n// TEST ONLY: unauthorized source-byte change\n');
    const result = runIsolated(workspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /PROVENANCE_SOURCE_HASH_MISMATCH/);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('runner rejects a modified whole-file pin when source bytes do not match it', () => {
  const workspace = createIsolatedRunnerWorkspace();
  try {
    const copy = fixtureBytes(workspace);
    copy.provenance[1].sha256 = 'f'.repeat(64);
    saveFixture(workspace, copy);
    const result = runIsolated(workspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /PROVENANCE_SOURCE_HASH_MISMATCH/);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('semantic recovery-verifier pin detects a changed function even if the whole-file digest is refreshed', () => {
  const workspace = createIsolatedRunnerWorkspace();
  try {
    const sourcePath = path.join(workspace, 'server/index.js');
    const altered = fs.readFileSync(sourcePath, 'utf8').replace(
      "case 'workflow_recovery_verify': {",
      "case 'workflow_recovery_verify': { /* TEST ONLY: modified recovery semantics */"
    );
    assert.notEqual(altered, fs.readFileSync(sourcePath, 'utf8'), 'test mutation must target the pinned function marker');
    fs.writeFileSync(sourcePath, altered);
    const copy = fixtureBytes(workspace);
    copy.provenance[0].sha256 = createHash('sha256').update(altered).digest('hex');
    saveFixture(workspace, copy);
    const result = runIsolated(workspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /PROVENANCE_SCOPE_HASH_MISMATCH/);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('runner rejects path traversal and symlink substitutions in provenance source paths', () => {
  const traversalWorkspace = createIsolatedRunnerWorkspace();
  try {
    const copy = fixtureBytes(traversalWorkspace);
    copy.provenance[0].path = '../package.json';
    copy.provenance[0].sha256 = createHash('sha256').update(fs.readFileSync(path.join(traversalWorkspace, 'package.json'))).digest('hex');
    saveFixture(traversalWorkspace, copy);
    const result = runIsolated(traversalWorkspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /PROVENANCE_SOURCE_PATH_UNSAFE/);
  } finally { fs.rmSync(traversalWorkspace, { recursive: true, force: true }); }

  const symlinkWorkspace = createIsolatedRunnerWorkspace();
  try {
    const sourcePath = path.join(symlinkWorkspace, 'server/index.js');
    fs.unlinkSync(sourcePath);
    fs.symlinkSync(path.join(symlinkWorkspace, 'tests/test-runalith-plugin.js'), sourcePath);
    const result = runIsolated(symlinkWorkspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /PROVENANCE_SOURCE_SYMLINK/);
  } finally { fs.rmSync(symlinkWorkspace, { recursive: true, force: true }); }
});

test('runner rejects duplicate and malformed provenance records before reporting benchmark output', () => {
  const duplicateWorkspace = createIsolatedRunnerWorkspace();
  try {
    const copy = fixtureBytes(duplicateWorkspace);
    copy.provenance.push(structuredClone(copy.provenance[0]));
    saveFixture(duplicateWorkspace, copy);
    const result = runIsolated(duplicateWorkspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /PROVENANCE_SOURCE_DUPLICATE/);
  } finally { fs.rmSync(duplicateWorkspace, { recursive: true, force: true }); }

  const malformedWorkspace = createIsolatedRunnerWorkspace();
  try {
    const copy = fixtureBytes(malformedWorkspace);
    copy.provenance[0].semanticScope.startMarker = '';
    saveFixture(malformedWorkspace, copy);
    const result = runIsolated(malformedWorkspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /PROVENANCE_SCOPE_INVALID/);
  } finally { fs.rmSync(malformedWorkspace, { recursive: true, force: true }); }
});

test('offline benchmark is deterministic apart from measured wall-clock latency', () => {
  const first = run();
  const second = run();
  assert.deepEqual(stableProjection(first), stableProjection(second));
  assert.deepEqual(first.provenance, fixture.provenance, 'raw benchmark provenance must identify the exact fixture pins consumed by the runner');
  const expectedEvidenceRefs = fixture.provenance.map(source => `file:${source.path}#sha256=${source.sha256}`).sort();
  assert.deepEqual([...first.reuse.sharedNodeEvidence.evidenceRefs].sort(), expectedEvidenceRefs,
    'cross-task reuse lineage must preserve both exact source references used to construct the shared knowledge node');
  assert.equal(first.reuse.sharedNodeEvidence.verified, false, 'persisted source references are not independently verified claims');
  assert.equal(first.reuse.sharedNodeEvidence.usableForPlanning, false, 'source-reference presence cannot become planning authority');
  assert.match(first.reuse.sharedNodeEvidence.contentHash, /^[a-f0-9]{64}$/);
  assert.match(first.reuse.sharedNodeEvidence.provenanceHash, /^[a-f0-9]{64}$/);
  assert.equal(first.networkCalls, 0);
  assert.equal(first.modelCalls, 0);
  assert.equal(first.records.length, 50);
  assert.deepEqual(first.config.beamWidths, [1, 2, 4]);
});

test('compares single-path, topological ToT, and AGG beam widths on both tasks', () => {
  const output = run();
  const variants = new Set(output.summaries.map(row => row.variant));
  for (const variant of ['single-path:-', 'topological-tot:-', 'agg-beam:1', 'agg-beam:2', 'agg-beam:4']) assert.ok(variants.has(variant), `missing ${variant}`);
  assert.equal(output.reuse.taskCount, 2);
  assert.equal(output.reuse.iterations, 5);
  assert.equal(output.reuse.crossTaskReusedNodeCount, 1, 'the same stable capability key must be shared across both benchmark goals');
  assert.equal(output.reuse.reusedNodes[0].verified, false, 'cross-task reuse does not elevate unverified knowledge');
  assert.equal(output.reuse.reusedNodes[0].usableForPlanning, false, 'cross-task reuse alone does not satisfy execution readiness');
  assert.equal(output.tokenCost, null, 'without model calls token cost must be unknown/not applicable, not invented');
  assert.match(output.evidenceMetricNote, /does not mean source integrity/);
  assert.match(output.pruneMetricNote, /alternativesNotSelected is separate/);
  assert.ok(output.records.every(row => row.evidenceClaimsVerified === false), 'declared reference coverage cannot count as verified evidence');
  const topological = output.records.filter(row => row.method === 'topological-tot');
  assert.ok(topological.every(row => row.pruneCount === 0), 'full path enumeration does not count unselected alternatives as beam-pruned states');
  assert.ok(topological.some(row => row.alternativesNotSelected > 0), 'enumerated alternatives are reported separately from pruning');
  const widthOne = output.records.filter(row => row.method === 'agg-beam' && row.beamWidth === 1);
  const widthFour = output.records.filter(row => row.method === 'agg-beam' && row.beamWidth === 4);
  assert.equal(widthOne.length, 10);
  assert.equal(widthFour.length, 10);
  assert.ok(widthOne.some(row => row.pruneCount !== widthFour.find(other => other.taskId === row.taskId)?.pruneCount) ||
    widthOne.some(row => row.pathNodeIds.join(',') !== widthFour.find(other => other.taskId === row.taskId)?.pathNodeIds.join(',')),
  'fixture should expose at least one beam-width-dependent prune or selected path');
});

test('fixture contains competing branches, convergence, infeasible prerequisite, and gated recovery edge', () => {
  assert.equal(fixture.tasks.length, 2);
  for (const task of fixture.tasks) {
    assert.ok(task.edges.some(edge => edge.from === 'start' && edge.to === 'inspect-verifier'));
    assert.ok(task.edges.some(edge => edge.from === 'start' && edge.to === 'inspect-regression'));
    assert.ok(task.edges.some(edge => edge.to === 'infeasible-combined-check' && edge.type === 'requires_all'));
    assert.ok(task.edges.some(edge => edge.from === 'recovery-outcome-confirmed' && edge.to === 'blocked-check' && edge.type === 'requires_all'));
    assert.ok(task.edges.some(edge => edge.type === 'recovers_to' && edge.from === 'recovery-probe' && edge.to === 'recovery-outcome-confirmed'));
  }
  const paths = fixture.groundTruth.validGoalPaths;
  assert.equal(paths.length, 2, 'ground truth must define two competing goal paths');
  const pathValidFor = (task, ids) => ids.every((id, index) => index === 0 || task.edges.some(edge =>
    edge.from === ids[index - 1] && edge.to === id && ['next_step', 'enables', 'recovers_to'].includes(edge.type) &&
    (edge.type !== 'recovers_to' || task.recoveryOutcome === edge.condition?.onOutcome))) &&
    ids.every((id, index) => index === 0 || task.edges.filter(edge => edge.to === id && edge.type === 'requires_all').every(edge => ids.slice(0, index).includes(edge.from)));
  assert.ok(fixture.tasks.every(task => pathValidFor(task, paths[0])), 'nominal evidence branch must be valid for both tasks');
  assert.ok(pathValidFor(fixture.tasks[1], paths[1]), 'recovery branch must be valid when its outcome condition is met');
  assert.ok(!pathValidFor(fixture.tasks[0], paths[1]), 'recovery branch must be infeasible when outcome is unknown');
  const output = run();
  const unknownTaskRows = output.records.filter(row => row.taskId === 'task-verify-consistency' && row.method === 'agg-beam');
  const verifiedTaskRows = output.records.filter(row => row.taskId === 'task-verify-tamper-regression' && row.method === 'agg-beam');
  assert.ok(unknownTaskRows.every(row => !row.pathNodeIds.includes('recovery-outcome-confirmed')));
  assert.ok(verifiedTaskRows.every(row => !row.pathNodeIds.includes('recovery-outcome-confirmed')),
    'current AGG nominal-success API defers recovery edges even when fixture records the matching recovery outcome');
  assert.ok([...unknownTaskRows, ...verifiedTaskRows].every(row => row.deferredRecoveryEdges >= 1),
    'AGG should report deferred recovers_to edges rather than traverse them as nominal success');
  assert.ok(output.records.some(row => row.method === 'topological-tot' && row.taskId === 'task-verify-tamper-regression' && row.pathNodeIds.includes('recovery-outcome-confirmed')),
    'the deterministic baseline should include recovery path only when the fixture outcome gate is satisfied');
});

test('benchmark scores only paths declared by the fixture ground-truth oracle', () => {
  const workspace = createIsolatedRunnerWorkspace();
  try {
    const copy = fixtureBytes(workspace);
    // Inject a graph-valid but oracle-unsupported shortcut. A scorer that only
    // checks graph connectivity would award goal/path points to this route.
    for (const task of copy.tasks) task.edges.push({ from: task.startNodeId, to: task.goalNodeId, type: 'next_step' });
    saveFixture(workspace, copy);
    const result = runIsolated(workspace);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    const shortest = output.records.filter(row => row.method === 'topological-tot');
    assert.equal(shortest.length, 10);
    assert.ok(shortest.every(row => row.pathNodeIds.length === 2 && row.completed),
      'the injected shortcut must actually be selected so the regression exercises scoring, not just validation');
    assert.ok(shortest.every(row => row.groundTruthPathValid === false),
      'graph reachability must not substitute for the declared ground-truth oracle');
    assert.ok(shortest.every(row => row.evidenceCovered.length === 0 && row.declaredEvidenceReferenceCoverage === 0),
      'a shortcut that bypasses source inspection cannot claim the fixture evidence references');
    assert.ok(shortest.every(row => row.qualityScore <= 4),
      'oracle-invalid shortcuts must not earn the ground-truth path or evidence coverage points');
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('benchmark rejects stale per-task evidence requirements and out-of-scope evidence labels', () => {
  const staleWorkspace = createIsolatedRunnerWorkspace();
  try {
    const copy = fixtureBytes(staleWorkspace);
    copy.tasks[0].requiredEvidence = ['verifier-implementation'];
    saveFixture(staleWorkspace, copy);
    const result = runIsolated(staleWorkspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /BENCHMARK_TASK_CONTRACT_INVALID/);
  } finally { fs.rmSync(staleWorkspace, { recursive: true, force: true }); }

  const outOfScopeWorkspace = createIsolatedRunnerWorkspace();
  try {
    const copy = fixtureBytes(outOfScopeWorkspace);
    copy.tasks[0].nodes.find(node => node.id === 'inspect-verifier').evidenceRefs.push('fabricated-independent-attestation');
    saveFixture(outOfScopeWorkspace, copy);
    const result = runIsolated(outOfScopeWorkspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /BENCHMARK_EVIDENCE_REFERENCE_OUT_OF_SCOPE/);
  } finally { fs.rmSync(outOfScopeWorkspace, { recursive: true, force: true }); }
});

test('benchmark does not accept task-declared recovery outcome as ground truth', () => {
  const workspace = createIsolatedRunnerWorkspace();
  try {
    const copy = fixtureBytes(workspace);
    const task = copy.tasks[0];
    assert.equal(task.recoveryOutcome, 'unknown');
    assert.equal(task.edges.find(edge => edge.type === 'recovers_to')?.condition?.onOutcome, 'verification_failed');
    task.recoveryOutcome = 'verification_failed';
    saveFixture(workspace, copy);
    const result = runIsolated(workspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /BENCHMARK_TASK_RECOVERY_OUTCOME_MISMATCH/,
      'a self-declared result must not enable a recovery edge in the benchmark oracle');
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('benchmark pins task/node identities, causal edges, and the ground-truth oracle independently of graph connectivity', () => {
  const taskIdentityWorkspace = createIsolatedRunnerWorkspace();
  try {
    const copy = fixtureBytes(taskIdentityWorkspace);
    copy.tasks[0].id = 'task-substituted-identity';
    saveFixture(taskIdentityWorkspace, copy);
    const result = runIsolated(taskIdentityWorkspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /BENCHMARK_TASK_IDENTITY_MISMATCH/);
  } finally { fs.rmSync(taskIdentityWorkspace, { recursive: true, force: true }); }

  const edgeIdentityWorkspace = createIsolatedRunnerWorkspace();
  try {
    const copy = fixtureBytes(edgeIdentityWorkspace);
    const edge = copy.tasks[0].edges.find(item => item.from === 'start' && item.to === 'inspect-verifier' && item.type === 'next_step');
    assert.ok(edge, 'fixture must contain the pinned verifier-inspection edge');
    edge.to = 'shortcut-guess';
    saveFixture(edgeIdentityWorkspace, copy);
    const result = runIsolated(edgeIdentityWorkspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /BENCHMARK_GROUND_TRUTH_PATH_UNSATISFIABLE/);
  } finally { fs.rmSync(edgeIdentityWorkspace, { recursive: true, force: true }); }

  const oracleWorkspace = createIsolatedRunnerWorkspace();
  try {
    const copy = fixtureBytes(oracleWorkspace);
    copy.tasks[0].edges.push(
      { from: 'start', to: 'shortcut-guess', type: 'next_step' },
      { from: 'shortcut-guess', to: 'report-investigation', type: 'next_step' }
    );
    copy.groundTruth.validGoalPaths[0] = ['start', 'shortcut-guess', 'report-investigation'];
    saveFixture(oracleWorkspace, copy);
    const result = runIsolated(oracleWorkspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /BENCHMARK_FROZEN_ORACLE_MISMATCH/,
      'rewriting the oracle alongside a graph-valid shortcut must not authorize inflated scores');
  } finally { fs.rmSync(oracleWorkspace, { recursive: true, force: true }); }

  const rubricWorkspace = createIsolatedRunnerWorkspace();
  try {
    const copy = fixtureBytes(rubricWorkspace);
    copy.groundTruth.qualityRubric.validGroundTruthPath = 0;
    saveFixture(rubricWorkspace, copy);
    const result = runIsolated(rubricWorkspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /BENCHMARK_FIXTURE_RUBRIC_INVALID/);
  } finally { fs.rmSync(rubricWorkspace, { recursive: true, force: true }); }
});

test('explicit output path is exclusive and never overwrites an existing file', () => {
  const target = path.join(root, '.test-tmp', `adaptive-goal-benchmark-existing-${process.pid}.json`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'preserve-me');
  try {
    const result = spawnSync(process.execPath, [runnerPath, '--output', target], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(target, 'utf8'), 'preserve-me');
  } finally { fs.unlinkSync(target); }
});
