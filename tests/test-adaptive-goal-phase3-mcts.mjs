import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTIVE_GOAL_DISCRIMINATOR_FEATURES, trainAdaptiveGoalDiscriminator } from '../src/runtime/adaptive-goal-discriminator.js';
import { validateAdaptiveGoalPhase2Dataset } from '../src/runtime/adaptive-goal-phase2-dataset.js';
import { canonicalJson } from '../src/runtime/canonical-json.js';
import { searchAdaptiveGoalGraphPhase3MCTS } from '../src/runtime/adaptive-goal-phase3-mcts.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const features = informationValue => Object.fromEntries(ADAPTIVE_GOAL_DISCRIMINATOR_FEATURES.map(name => [
  name, name === 'informationValue' ? informationValue : 0.5
]));

function modelFixture() {
  return trainAdaptiveGoalDiscriminator({
    trainingExamples: [
      ...[0.8, 0.85, 0.9, 0.95, 0.88, 0.92].map((value, index) => ({ id: `train-p-${index}`, features: features(value), label: 1 })),
      ...[0.05, 0.1, 0.15, 0.2, 0.12, 0.08].map((value, index) => ({ id: `train-n-${index}`, features: features(value), label: 0 }))
    ],
    validationExamples: [
      { id: 'valid-p-1', features: features(0.87), label: 1 }, { id: 'valid-p-2', features: features(0.91), label: 1 },
      { id: 'valid-n-1', features: features(0.09), label: 0 }, { id: 'valid-n-2', features: features(0.18), label: 0 }
    ]
  }).model;
}

function graphFixture() {
  return {
    schemaVersion: 1, startNodeId: 'start', goalNodeId: 'goal',
    nodes: [
      { id: 'start', type: 'goal', label: 'Start' },
      { id: 'cheap', type: 'idea', label: 'Cheap but weak route', estimatedCost: 1, estimatedRisk: 0.4,
        estimatedSuccessConfidence: 0.4, reusePotential: 0.1, informationValue: 0.1 },
      { id: 'strong', type: 'idea', label: 'Higher-value route', estimatedCost: 2, estimatedRisk: 0.1,
        estimatedSuccessConfidence: 0.9, reusePotential: 0.7, informationValue: 0.9 },
      { id: 'goal', type: 'goal', label: 'Goal' }
    ],
    edges: [
      { from: 'start', to: 'cheap', type: 'next_step' }, { from: 'cheap', to: 'goal', type: 'next_step' },
      { from: 'start', to: 'strong', type: 'enables' }, { from: 'strong', to: 'goal', type: 'next_step' }
    ]
  };
}

function createBoundModelFiles(directory) {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const sourceHash = relative => hash(fs.readFileSync(path.join(repoRoot, relative)));
  const rows = (prefix, positiveValues, negativeValues) => [
    ...positiveValues.map((value, index) => ({ id: `${prefix}-p-${index}`, features: features(value), label: 1 })),
    ...negativeValues.map((value, index) => ({ id: `${prefix}-n-${index}`, features: features(value), label: 0 }))
  ];
  const dataset = {
    schemaVersion: 1, featureSchemaVersion: 1, datasetId: 'phase3-e2e-synthetic-dataset',
    labelProvenance: {
      kind: 'synthetic', source: 'Phase 3 deterministic test fixture',
      adjudicatorId: 'test-fixture-generator', adjudicationProtocol: 'fixed-test-fixture-v1', independent: false
    },
    trainingExamples: rows('train', [0.81, 0.84, 0.88, 0.91, 0.94, 0.97], [0.03, 0.07, 0.11, 0.14, 0.18, 0.22]),
    validationExamples: rows('validation', [0.79, 0.89], [0.04, 0.19]),
    holdoutExamples: rows('holdout', [0.76, 0.86, 0.96], [0.01, 0.13, 0.25])
  };
  const datasetPath = path.join(directory, 'dataset.json');
  const datasetBytes = Buffer.from(`${JSON.stringify(dataset, null, 2)}\n`);
  fs.writeFileSync(datasetPath, datasetBytes, { flag: 'wx', mode: 0o600 });
  const validated = validateAdaptiveGoalPhase2Dataset(dataset);
  const trained = trainAdaptiveGoalDiscriminator({
    trainingExamples: validated.trainingExamples,
    validationExamples: validated.validationExamples,
    datasetId: validated.datasetId
  });
  const artifact = {
    schemaVersion: 2, kind: 'agg_phase2_discriminator_model',
    datasetId: validated.datasetId, datasetFileSha256: hash(datasetBytes), datasetSha256: validated.datasetSha256,
    featureSchemaVersion: validated.featureSchemaVersion, labelProvenance: validated.labelProvenance,
    provenanceAssessment: validated.provenanceAssessment, splitIdentities: validated.splits,
    sourceIdentity: {
      trainerCliSha256: sourceHash('scripts/train-agg-phase2-discriminator.mjs'),
      discriminatorSha256: sourceHash('src/runtime/adaptive-goal-discriminator.js'),
      datasetValidatorSha256: sourceHash('src/runtime/adaptive-goal-phase2-dataset.js'),
      strictJsonParserSha256: sourceHash('src/runtime/strict-json.js'),
      canonicalJsonSha256: sourceHash('src/runtime/canonical-json.js')
    },
    model: trained.model, training: trained.training, validation: trained.validation,
    status: 'offline_shadow_model_not_acceptance', acceptance: 'acceptance_required',
    execution: { enabled: false, authorized: false, dispatched: false }
  };
  artifact.artifactSha256 = hash(canonicalJson(artifact));
  const modelPath = path.join(directory, 'model.json');
  fs.writeFileSync(modelPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const graphPath = path.join(directory, 'graph.json');
  fs.writeFileSync(graphPath, `${JSON.stringify(graphFixture(), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { datasetPath, modelPath, graphPath, dataset, modelArtifact: artifact };
}

function startSourceServer(t, { enabled }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-phase3-mcp-'));
  fs.chmodSync(temp, 0o700);
  const dirs = ['home', 'data', 'workspace', 'execution-tmp'];
  for (const dir of dirs) fs.mkdirSync(path.join(temp, dir), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [path.join(repoRoot, 'server/index.js')], {
    cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin', HOME: path.join(temp, 'home'), NODE_ENV: 'test', LANG: 'C.UTF-8',
      ...(enabled ? { AGG_PHASE3_MCTS_TOOL_ENABLED: '1' } : {}),
      RUNALITH_DATA_DIR: path.join(temp, 'data'), RUNALITH_WORKFLOW_DB: path.join(temp, 'data/workflow.db'),
      RUNALITH_WORKSPACE: path.join(temp, 'workspace'), RUNALITH_EXECUTION_TMP_DIR: path.join(temp, 'execution-tmp'),
      TMPDIR: temp, TEMP: temp, TMP: temp
    }
  });
  let stdoutBuffer = '', stderr = '', nextId = 1, exited = false;
  const pending = new Map();
  const rejectPending = error => {
    for (const [id, waiter] of pending) {
      pending.delete(id); clearTimeout(waiter.timer); waiter.reject(error);
    }
  };
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id); reject(new Error(`MCP RPC timeout ${method}: ${stderr.slice(-1500)}`));
    }, 7000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
      if (!error) return;
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id); clearTimeout(waiter.timer); reject(error);
    });
  });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdoutBuffer += chunk;
    let newline;
    while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim(); stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { rejectPending(new Error(`non-JSON MCP stdout: ${line.slice(0, 500)}`)); child.kill('SIGKILL'); return; }
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message); }
    }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65536); });
  child.on('error', rejectPending);
  child.on('exit', (code, signal) => { exited = true; rejectPending(new Error(`source MCP exited code=${code} signal=${signal}: ${stderr.slice(-1500)}`)); });
  t.after(async () => {
    if (!exited) {
      child.stdin.end();
      await new Promise(resolve => {
        const timer = setTimeout(() => { if (!exited) child.kill('SIGTERM'); resolve(); }, 1000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    if (!exited) child.kill('SIGKILL');
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return { rpc };
}

test('Phase 3 MCTS returns deterministic, review-only goal candidates with explicit bounded-search metadata', () => {
  const graph = graphFixture();
  const model = modelFixture();
  const options = { maxSimulations: 80, maxDepth: 6, maxExpansions: 200, seed: 20261024, candidateLimit: 4 };
  const first = searchAdaptiveGoalGraphPhase3MCTS(graph, model, options);
  const second = searchAdaptiveGoalGraphPhase3MCTS(graph, model, options);
  assert.deepEqual(first, second, 'same graph/model/options/seed must replay byte-stably');
  assert.equal(first.mode, 'shadow');
  assert.equal(first.status, 'proposals_found');
  assert.equal(first.search.rankingMode, 'discriminator_mcts_uct');
  assert.equal(first.search.discriminatorModelSha256, model.modelSha256);
  assert.equal(first.search.simulations, 80);
  assert.equal(first.search.exhaustive, false, 'MCTS must not claim exhaustive search or optimality');
  assert.ok(first.candidates.length > 0);
  assert.ok(first.candidates.every(candidate => candidate.candidateKind === 'complete_path_candidate'));
  for (const candidate of [...first.candidates, ...first.bestPartialCandidates]) {
    assert.equal(candidate.verification.status, 'unverified');
    assert.equal(candidate.verification.verified, false);
    assert.deepEqual(candidate.execution, { enabled: false, authorized: false, dispatched: false });
    assert.equal(candidate.provenance.acceptance, 'offline_shadow_not_acceptance');
    assert.equal(candidate.provenance.rankingMode, 'discriminator_mcts_uct');
  }
  assert.deepEqual(first.gates, {
    humanReviewRequired: true, workflowApprovalRequired: true,
    immutableExecutionPlanCreated: false, dispatchAllowed: false, executionAuthorized: false
  });
  assert.equal(first.search.executionAuthorized, false);
  assert.equal(first.auditTrace.deterministic, true);
  assert.ok(first.auditTrace.events.some(event => event.type === 'simulation_complete'));
});

test('MCTS enforces the edge-expansion limit and labels a truncated search', () => {
  const result = searchAdaptiveGoalGraphPhase3MCTS(graphFixture(), modelFixture(), {
    maxSimulations: 100, maxExpansions: 1, maxDepth: 10, seed: 7
  });
  assert.equal(result.status, 'budget_exhausted');
  assert.equal(result.search.budgetExhausted, true);
  assert.equal(result.search.expansions, 1);
  assert.equal(result.search.exhaustive, false);
  assert.equal(result.search.terminationReason, 'max_expansions');
  assert.ok(result.auditTrace.events.some(event => event.type === 'budget_exhausted'));
});

test('MCTS deterministically enforces work-unit and tree-node memory limits', () => {
  const graph = graphFixture();
  const model = modelFixture();
  const workLimited = searchAdaptiveGoalGraphPhase3MCTS(graph, model, {
    maxSimulations: 100, maxExpansions: 100, maxWorkUnits: 15, maxTreeNodes: 100, seed: 17
  });
  assert.equal(workLimited.search.workBudgetExhausted, true);
  assert.equal(workLimited.search.terminationReason, 'max_work_units');
  assert.ok(workLimited.search.workUnits <= 15);
  assert.equal(workLimited.search.resourceBounds.osCpuQuotaEnforced, false);
  assert.equal(workLimited.search.resourceBounds.osMemoryQuotaEnforced, false);
  assert.ok(workLimited.auditTrace.events.some(event => event.type === 'budget_exhausted' && event.budget === 'maxWorkUnits'));

  const nodeLimited = searchAdaptiveGoalGraphPhase3MCTS(graph, model, {
    maxSimulations: 100, maxExpansions: 100, maxWorkUnits: 10000, maxTreeNodes: 1, seed: 17
  });
  assert.equal(nodeLimited.search.treeNodeBudgetExhausted, true);
  assert.equal(nodeLimited.search.terminationReason, 'max_tree_nodes');
  assert.ok(nodeLimited.search.generatedStates <= 1);
  assert.ok(nodeLimited.search.workUnits <= 10000);
});

test('MCTS caps retained terminal paths independently of audit truncation', () => {
  const graph = graphFixture();
  const result = searchAdaptiveGoalGraphPhase3MCTS(graph, modelFixture(), {
    maxSimulations: 200, maxDepth: 6, maxExpansions: 500, maxWorkUnits: 50000,
    maxTerminalPaths: 1, maxAuditEvents: 20, seed: 5, candidateLimit: 10
  });
  assert.equal(result.search.maxTerminalPaths, 1);
  assert.ok(result.search.retainedTerminalPaths <= 1);
  assert.equal(result.search.terminalPathLimitReached, true);
  assert.ok(result.search.terminalPathsOmitted > 0);
  assert.equal(result.search.budgetExhausted, true);
  assert.equal(result.status, 'budget_exhausted');
  assert.equal(result.search.terminationReason, 'max_terminal_paths');
  assert.ok(result.auditTrace.events.some(event => event.type === 'terminal_path_not_retained'));
  assert.equal(result.search.exhaustive, false);
});

test('MCTS respects depth/audit caps and rejects malformed limits or tampered models', () => {
  const graph = graphFixture();
  const model = modelFixture();
  const result = searchAdaptiveGoalGraphPhase3MCTS(graph, model, {
    maxSimulations: 8, maxDepth: 1, maxExpansions: 100, maxAuditEvents: 2, seed: 0
  });
  assert.equal(result.search.simulations, 8);
  assert.equal(result.auditTrace.events.length, 2);
  assert.equal(result.auditTrace.truncated, true);
  assert.ok(result.auditTrace.omittedEventCount > 0);
  assert.equal(result.search.exhaustive, false);
  assert.throws(() => searchAdaptiveGoalGraphPhase3MCTS(graph, model, { maxSimulations: 0 }), /maxSimulations/);
  assert.throws(() => searchAdaptiveGoalGraphPhase3MCTS(graph, model, { maxWorkUnits: 1 }), /maxWorkUnits/);
  assert.throws(() => searchAdaptiveGoalGraphPhase3MCTS(graph, model, { maxTreeNodes: 10002 }), /maxTreeNodes/);
  assert.throws(() => searchAdaptiveGoalGraphPhase3MCTS(graph, model, { explorationConstant: 10.1 }), /explorationConstant/);
  assert.throws(() => searchAdaptiveGoalGraphPhase3MCTS(graph, model, { seed: -1 }), /seed/);
  const tampered = structuredClone(model);
  tampered.intercept += 1;
  assert.throws(() => searchAdaptiveGoalGraphPhase3MCTS(graph, tampered), /hash mismatch|AdaptiveGoalDiscriminator/);
});

test('MCTS does not report depth exhaustion when every successor is blocked by a prerequisite', () => {
  const graph = {
    schemaVersion: 1, startNodeId: 'start', goalNodeId: 'goal',
    nodes: [
      { id: 'start', type: 'goal' }, { id: 'dead-end', type: 'idea' },
      { id: 'prerequisite', type: 'condition' }, { id: 'goal', type: 'goal' }
    ],
    edges: [
      { from: 'start', to: 'dead-end', type: 'next_step' },
      { from: 'dead-end', to: 'goal', type: 'next_step' },
      { from: 'prerequisite', to: 'goal', type: 'requires_all' }
    ]
  };
  const result = searchAdaptiveGoalGraphPhase3MCTS(graph, modelFixture(), {
    maxSimulations: 12, maxDepth: 1, maxExpansions: 100, seed: 1
  });
  assert.equal(result.status, 'no_solution_found');
  assert.equal(result.search.maxDepthReached, false);
  assert.equal(result.search.exhaustive, false);
  assert.ok(result.auditTrace.events.some(event => event.type === 'edge_rejected' && event.reason === 'prerequisite_missing'));
});

test('MCTS considers only nominal transitions and filters prerequisites and contradictory branches', () => {
  const graph = {
    schemaVersion: 1, startNodeId: 'start', goalNodeId: 'goal',
    nodes: [
      { id: 'start', type: 'goal' }, { id: 'prerequisite', type: 'condition' },
      { id: 'left', type: 'idea', estimatedSuccessConfidence: 0.8, informationValue: 0.8 },
      { id: 'right', type: 'idea', estimatedSuccessConfidence: 0.9, informationValue: 0.9 },
      { id: 'goal', type: 'goal' }
    ],
    edges: [
      { from: 'start', to: 'left', type: 'next_step' },
      { from: 'start', to: 'prerequisite', type: 'next_step' },
      { from: 'prerequisite', to: 'left', type: 'enables' },
      { from: 'left', to: 'right', type: 'next_step' },
      { from: 'left', to: 'goal', type: 'next_step' },
      { from: 'right', to: 'goal', type: 'next_step' },
      { from: 'prerequisite', to: 'left', type: 'requires_all' },
      { from: 'left', to: 'right', type: 'contradicts' },
      { from: 'start', to: 'goal', type: 'supports' }
    ]
  };
  const result = searchAdaptiveGoalGraphPhase3MCTS(graph, modelFixture(), {
    maxSimulations: 200, maxDepth: 8, maxExpansions: 1000, seed: 99, candidateLimit: 10
  });
  assert.ok(result.candidates.length > 0);
  assert.ok(result.candidates.every(candidate => {
    const path = candidate.pathNodeIds;
    const hasPrerequisite = path.includes('prerequisite');
    if (path.includes('left')) assert.equal(hasPrerequisite, true, 'left must not be visited before its prerequisite');
    assert.equal(path.includes('left') && path.includes('right'), false, 'contradictory branches cannot co-exist');
    assert.ok(path.length >= 2);
    return path.at(-1) === 'goal';
  }));
  assert.ok(result.auditTrace.events.some(event => event.type === 'edge_rejected' && event.reason === 'prerequisite_missing'));
  assert.ok(result.auditTrace.events.some(event => event.type === 'edge_rejected' && event.reason === 'contradicts'));
});

test('Phase 3 MCP tool is hidden and denied by default, then available only with the explicit opt-in flag', async t => {
  const request = { graph: graphFixture(), model: modelFixture(), options: { maxSimulations: 12, maxDepth: 6, maxExpansions: 64, seed: 123 } };
  const defaultRuntime = startSourceServer(t, { enabled: false });
  const initialized = await defaultRuntime.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agg-phase3-test', version: '1' } });
  assert.equal(initialized.error, undefined);
  const defaultTools = await defaultRuntime.rpc('tools/list');
  assert.equal(defaultTools.result.tools.some(tool => tool.name === 'adaptive_goal_phase3_mcts_shadow_search'), false);
  const denied = await defaultRuntime.rpc('tools/call', { name: 'adaptive_goal_phase3_mcts_shadow_search', arguments: request });
  assert.equal(denied.result?.isError, true);
  assert.match(denied.result?.content?.[0]?.text || '', /opt-in and disabled in the default runtime/);

  const enabledRuntime = startSourceServer(t, { enabled: true });
  const enabledInit = await enabledRuntime.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agg-phase3-test', version: '1' } });
  assert.equal(enabledInit.error, undefined);
  const enabledTools = await enabledRuntime.rpc('tools/list');
  const tool = enabledTools.result.tools.find(item => item.name === 'adaptive_goal_phase3_mcts_shadow_search');
  assert.ok(tool);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.required, ['graph', 'model']);
  const response = await enabledRuntime.rpc('tools/call', { name: 'adaptive_goal_phase3_mcts_shadow_search', arguments: request });
  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, false);
  const result = response.result.structuredContent;
  assert.equal(result.mode, 'shadow');
  assert.equal(result.status, 'proposals_found');
  assert.equal(result.search.executionAuthorized, false);
  assert.equal(result.execution.authorized, false);
  assert.equal(result.acceptance, 'offline_shadow_not_acceptance');
  assert.equal(result.modelTrust.trustedModelAttestationPresent, false);
  assert.equal(result.gates.persisted, false);
  assert.ok(result.candidates.length > 0);
});

test('runtime collector includes the opt-in Phase 3 implementation and manifest advertises its source contract', t => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-phase3-collector-'));
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  const collected = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/collect-plugin-runtime.mjs'), repoRoot, stage], {
    cwd: repoRoot, encoding: 'utf8'
  });
  assert.equal(collected.status, 0, collected.stderr || collected.stdout);
  assert.ok(fs.statSync(path.join(stage, 'src/runtime/adaptive-goal-phase3-mcts.js')).isFile());
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'plugin/manifest.json'), 'utf8'));
  assert.ok(manifest.tools.some(tool => tool.name === 'adaptive_goal_phase3_mcts_shadow_search'));
  const source = fs.readFileSync(path.join(repoRoot, 'server/index.js'), 'utf8');
  assert.match(source, /case 'adaptive_goal_phase3_mcts_shadow_search'/);
  assert.match(source, /AGG_PHASE3_MCTS_TOOL_ENABLED/);
});

test('Phase 3 CLI validates exact dataset/model identity, writes exclusive JSON and replays the same search', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-phase3-cli-e2e-'));
  fs.chmodSync(temp, 0o700);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const input = createBoundModelFiles(temp);
  const output = path.join(temp, 'result.json');
  const command = [path.join(repoRoot, 'scripts/run-agg-phase3-mcts-shadow.mjs'),
    '--graph', input.graphPath, '--dataset', input.datasetPath, '--model', input.modelPath,
    '--output', output, '--simulations', '24', '--max-depth', '8', '--max-expansions', '96',
    '--max-work-units', '20000', '--max-tree-nodes', '128', '--max-terminal-paths', '128', '--seed', '4242'];
  const first = spawnSync(process.execPath, command, { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const artifact = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(artifact.kind, 'agg_phase3_mcts_shadow_search_result');
  assert.equal(artifact.modelIdentityAssessment.deterministicTrainingReplayMatched, true);
  assert.equal(artifact.graphFileSha256, createHash('sha256').update(fs.readFileSync(input.graphPath)).digest('hex'));
  assert.equal(artifact.datasetFileSha256, createHash('sha256').update(fs.readFileSync(input.datasetPath)).digest('hex'));
  assert.equal(artifact.execution.authorized, false);
  assert.equal(artifact.gates.executionAuthorized, false);
  const before = fs.readFileSync(output);
  const collision = spawnSync(process.execPath, command, { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
  assert.notEqual(collision.status, 0, 'existing output must cause an exclusive-publication refusal');
  assert.deepEqual(fs.readFileSync(output), before, 'output collision must preserve original bytes');

  const tamperedModelPath = path.join(temp, 'tampered-model.json');
  const tampered = structuredClone(input.modelArtifact);
  tampered.model.intercept += 1;
  fs.writeFileSync(tamperedModelPath, `${JSON.stringify(tampered, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const tamperOutput = path.join(temp, 'tamper-result.json');
  const tamper = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/run-agg-phase3-mcts-shadow.mjs'),
    '--graph', input.graphPath, '--dataset', input.datasetPath, '--model', tamperedModelPath,
    '--output', tamperOutput, '--simulations', '24', '--max-depth', '8', '--max-expansions', '96'],
  { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
  assert.notEqual(tamper.status, 0, 'tampered model must be rejected before search publication');
  assert.match(`${tamper.stderr}\n${tamper.stdout}`, /hash mismatch|AdaptiveGoalDiscriminator/i);
  assert.equal(fs.existsSync(tamperOutput), false);

  const mismatchedDataset = structuredClone(input.dataset);
  mismatchedDataset.datasetId = 'phase3-different-dataset';
  const mismatchedDatasetPath = path.join(temp, 'mismatched-dataset.json');
  fs.writeFileSync(mismatchedDatasetPath, `${JSON.stringify(mismatchedDataset, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const mismatchOutput = path.join(temp, 'mismatch-result.json');
  const mismatch = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/run-agg-phase3-mcts-shadow.mjs'),
    '--graph', input.graphPath, '--dataset', mismatchedDatasetPath, '--model', input.modelPath,
    '--output', mismatchOutput], { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
  assert.notEqual(mismatch.status, 0, 'model must bind exact dataset bytes and ID');
  assert.equal(fs.existsSync(mismatchOutput), false);
});

test('paired Phase 3 benchmark validates model/oracle, repeats seeds and marks synthetic evidence limitations', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-phase3-benchmark-e2e-'));
  fs.chmodSync(temp, 0o700);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const input = createBoundModelFiles(temp);
  const corpusPath = path.join(repoRoot, 'benchmarks/adaptive-goal-graph/fixtures/phase3-mcts-adversarial-corpus.json');
  const generatedCorpusPath = path.join(temp, 'generated-adversarial-corpus.json');
  const generated = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/create-agg-phase3-adversarial-corpus.mjs'),
    '--output', generatedCorpusPath], { cwd: repoRoot, encoding: 'utf8', timeout: 15000 });
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  assert.deepEqual(fs.readFileSync(generatedCorpusPath), fs.readFileSync(corpusPath),
    'the committed adversarial corpus must replay exactly from its deterministic generator');
  const output = path.join(temp, 'benchmark.json');
  const runArgs = [path.join(repoRoot, 'scripts/benchmark-agg-phase3-mcts-vs-beam.mjs'),
    '--corpus', corpusPath, '--dataset', input.datasetPath, '--model', input.modelPath,
    '--output', output, '--beam-width', '4', '--simulations', '12', '--seeds', '7,11',
    '--max-depth', '8', '--max-expansions', '96', '--max-work-units', '20000',
    '--max-audit-events', '128', '--max-tree-nodes', '128', '--max-terminal-paths', '128'];
  const run = spawnSync(process.execPath, runArgs, { cwd: repoRoot, encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(result.kind, 'agg_phase3_mcts_vs_phase2_beam_paired_benchmark');
  assert.equal(result.corpusAssessment.caseCount, 24);
  assert.equal(result.corpusAssessment.uniqueGraphCount, 24);
  assert.equal(result.corpusAssessment.outcomeClassCounts.goalPath, 20);
  assert.equal(result.corpusAssessment.outcomeClassCounts.noSolution, 4);
  assert.equal(result.corpusAssessment.noSolutionCasesExhaustivelyReDerived, 4);
  assert.deepEqual(result.pairedConfig.seeds, [7, 11]);
  assert.equal(result.metrics.pairedTrialCount, 48);
  assert.equal(result.metrics.goalPathOnly.caseCount, 20);
  assert.equal(result.metrics.goalPathOnly.pairedTrialCount, 40);
  assert.ok(result.metrics.goalPathOnly.phase2BeamSuccessRate >= 0 && result.metrics.goalPathOnly.phase2BeamSuccessRate <= 1);
  assert.ok(result.metrics.goalPathOnly.phase3MCTSSuccessRate >= 0 && result.metrics.goalPathOnly.phase3MCTSSuccessRate <= 1);
  assert.ok(result.metrics.goalPathOnly.phase2BeamSuccessWilson95.lower <= result.metrics.goalPathOnly.phase2BeamSuccessWilson95.upper);
  assert.ok(result.metrics.goalPathOnly.phase3MCTSSuccessWilson95.lower <= result.metrics.goalPathOnly.phase3MCTSSuccessWilson95.upper);
  assert.equal(result.metrics.noSolutionProofs.caseCount, 4);
  assert.equal(result.metrics.noSolutionProofs.pairedTrialCount, 8);
  assert.equal(result.metrics.noSolutionProofs.phase2BeamExhaustiveProofCount, 8);
  assert.equal(result.metrics.noSolutionProofs.phase3MCTSExhaustiveProofCount, 0);
  assert.equal(result.metrics.noSolutionProofs.phase3MCTSCanClaimNoSolutionProofByContract, false);
  assert.match(result.metrics.pairedComparisonInterpretation, /not a like-for-like/);
  assert.equal(result.cases.every(item => item.trials.length === 2), true);
  assert.ok(result.cases.every(item => /^[a-f0-9]{64}$/.test(item.inputGraphFileCanonicalSha256)));
  assert.equal(result.modelIdentityAssessment.deterministicTrainingReplayMatched, true);
  assert.ok(result.corpusAssessment.qualityFlags.includes('SYNTHETIC_CORPUS_NOT_OPERATIONAL_EVIDENCE'));
  assert.ok(result.corpusAssessment.qualityFlags.includes('NO_OWNER_SIGNATURE_OR_OUT_OF_BAND_TRUST_ROOT_FOR_CORPUS'));
  assert.ok(result.corpusAssessment.qualityFlags.includes('OUTCOME_CLASS_IMBALANCE_GT_80_PERCENT'));
  assert.equal(result.corpusProvenance.independentAttestationPresent, false);
  assert.equal(result.execution.authorized, false);
  assert.equal(result.gates.executionAuthorized, false);
  const digest = createHash('sha256').update(canonicalJson(Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'artifactSha256')))).digest('hex');
  assert.equal(result.artifactSha256, digest, 'benchmark artifact self-hash must bind the exact recorded result');
  const before = fs.readFileSync(output);
  const collision = spawnSync(process.execPath, runArgs, { cwd: repoRoot, encoding: 'utf8', timeout: 60000 });
  assert.notEqual(collision.status, 0);
  assert.deepEqual(fs.readFileSync(output), before, 'benchmark output collision must not overwrite the evidence');

  const duplicateCorpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  duplicateCorpus.cases[1].graph = structuredClone(duplicateCorpus.cases[0].graph);
  const duplicatePath = path.join(temp, 'duplicate-graph-corpus.json');
  fs.writeFileSync(duplicatePath, `${JSON.stringify(duplicateCorpus, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const rejectedOutput = path.join(temp, 'rejected-benchmark.json');
  const rejected = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/benchmark-agg-phase3-mcts-vs-beam.mjs'),
    '--corpus', duplicatePath, '--dataset', input.datasetPath, '--model', input.modelPath,
    '--output', rejectedOutput, '--seeds', '7', '--simulations', '4'], { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
  assert.notEqual(rejected.status, 0, 'duplicate canonical graph cases must be rejected');
  assert.equal(fs.existsSync(rejectedOutput), false);

  const forgedOracleCorpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  forgedOracleCorpus.cases[0].oracle.successfulPathNodeIds = [[
    forgedOracleCorpus.cases[0].graph.startNodeId, forgedOracleCorpus.cases[0].graph.goalNodeId
  ]];
  const forgedOraclePath = path.join(temp, 'forged-oracle-corpus.json');
  fs.writeFileSync(forgedOraclePath, `${JSON.stringify(forgedOracleCorpus, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const forgedOracleOutput = path.join(temp, 'forged-oracle-result.json');
  const forgedOracle = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/benchmark-agg-phase3-mcts-vs-beam.mjs'),
    '--corpus', forgedOraclePath, '--dataset', input.datasetPath, '--model', input.modelPath,
    '--output', forgedOracleOutput, '--seeds', '7', '--simulations', '4'], { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
  assert.notEqual(forgedOracle.status, 0, 'a declared oracle path missing a nominal edge must be rejected');
  assert.match(`${forgedOracle.stderr}\n${forgedOracle.stdout}`, /missing or non-nominal transition/);
  assert.equal(fs.existsSync(forgedOracleOutput), false);
});
