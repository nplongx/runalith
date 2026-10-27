#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ADAPTIVE_GOAL_DISCRIMINATOR_FEATURES, trainAdaptiveGoalDiscriminator } from '../src/runtime/adaptive-goal-discriminator.js';
import { independentlyDeriveSearch } from '../scripts/lib/agg-phase2-independent-search-audit.mjs';
import { expectedPhase2ExternalChecksumPaths, isBoundEvidenceVerifierReceipt, isBoundSourceDriftReceipt } from '../scripts/lib/agg-phase2-evidence-receipts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const featureRow = value => Object.fromEntries(ADAPTIVE_GOAL_DISCRIMINATOR_FEATURES.map(name => [name, name === 'informationValue' ? value : 0.5]));
function modelFixture() {
  return trainAdaptiveGoalDiscriminator({
    trainingExamples: [
      ...[0.8, 0.85, 0.9, 0.95, 0.88, 0.92].map((value, i) => ({ id: `train-p-${i}`, features: featureRow(value), label: 1 })),
      ...[0.05, 0.1, 0.15, 0.2, 0.12, 0.08].map((value, i) => ({ id: `train-n-${i}`, features: featureRow(value), label: 0 }))
    ],
    validationExamples: [
      { id: 'valid-p-1', features: featureRow(0.87), label: 1 }, { id: 'valid-p-2', features: featureRow(0.91), label: 1 },
      { id: 'valid-n-1', features: featureRow(0.09), label: 0 }, { id: 'valid-n-2', features: featureRow(0.18), label: 0 }
    ]
  }).model;
}
const graphFixture = {
  schemaVersion: 1, startNodeId: 'start', goalNodeId: 'goal',
  nodes: [
    { id: 'start', type: 'task', label: 'Start' },
    { id: 'step-one', type: 'task', label: 'Review candidate', estimatedCost: 1, estimatedRisk: 0.1, estimatedSuccessConfidence: 0.9, informationValue: 0.8 },
    { id: 'goal', type: 'goal', label: 'Goal' }
  ],
  edges: [{ from: 'start', to: 'step-one', type: 'next_step' }, { from: 'step-one', to: 'goal', type: 'next_step' }]
};

test('external checksum list has an exact four-file set including the post-sidecar replay receipt', () => {
  const paths = expectedPhase2ExternalChecksumPaths('artifacts/agg-phase2-test-pack');
  assert.deepEqual([...paths].sort(), [
    'artifacts/agg-phase2-test-pack/SHA256SUMS.txt',
    'artifacts/agg-phase2-test-pack-final-source-drift-check.json',
    'artifacts/agg-phase2-test-pack-pack-verification-final.json',
    'artifacts/agg-phase2-test-pack-pack-verification-post-sidecar-replay.json'
  ].sort());
  assert.equal(paths.size, 4);
});

test('post-publication verifier receipts are accepted only at exact derived sidecar paths', () => {
  const identity = { packRelative: 'artifacts/agg-phase2-test-pack', manifestSha256: 'a'.repeat(64) };
  const receipt = { kind: 'agg_phase2_evidence_pack_verification', pack: identity.packRelative,
    manifestSha256: identity.manifestSha256, verificationStatus: 'BLOCKED',
    acceptanceStatus: 'ACCEPTANCE_REQUIRED', executionGate: 'CLOSED' };
  const finalPath = `${identity.packRelative}-pack-verification-final.json`;
  assert.equal(isBoundEvidenceVerifierReceipt(receipt, { ...identity, relative: finalPath }), true);
  assert.equal(isBoundEvidenceVerifierReceipt(receipt, { ...identity, relative: `${identity.packRelative}-pack-verification-post-sidecar-replay.json` }), true);
  assert.equal(isBoundEvidenceVerifierReceipt(receipt, { ...identity, relative: 'unrelated.txt' }), false);
  assert.equal(isBoundEvidenceVerifierReceipt({ ...receipt, pack: 'artifacts/other-pack' }, { ...identity, relative: finalPath }), false);
  assert.equal(isBoundEvidenceVerifierReceipt({ ...receipt, manifestSha256: 'b'.repeat(64) }, { ...identity, relative: finalPath }), false);
  assert.equal(isBoundEvidenceVerifierReceipt({ ...receipt, executionGate: 'OPEN' }, { ...identity, relative: finalPath }), false);
});

test('post-publication source-drift receipt binds the final receipt schema, exact pack, and manifest', () => {
  const identity = { packRelative: 'artifacts/agg-phase2-test-pack', manifestSha256: 'a'.repeat(64) };
  const receipt = { kind: 'agg_phase2_final_source_drift_check', pack: identity.packRelative,
    manifestSha256: identity.manifestSha256, status: 'PASS', executionGate: 'CLOSED' };
  assert.equal(isBoundSourceDriftReceipt(receipt, identity), true);
  assert.equal(isBoundSourceDriftReceipt({ ...receipt, pack: 'artifacts/other-pack' }, identity), false);
  assert.equal(isBoundSourceDriftReceipt({ ...receipt, manifestSha256: 'b'.repeat(64) }, identity), false);
  assert.equal(isBoundSourceDriftReceipt({ ...receipt, kind: 'agg_phase2_source_drift_check' }, identity), false);
  assert.equal(isBoundSourceDriftReceipt({ ...receipt, status: 'VERIFIED' }, identity), false);
  assert.equal(isBoundSourceDriftReceipt({ ...receipt, executionGate: 'OPEN' }, identity), false);
});

test('collector closure contains the Phase 2 learned-search and Plan Graph shadow modules', t => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-phase2-collector-closure-'));
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  const collected = spawnSync(process.execPath, [path.join(root, 'scripts/collect-plugin-runtime.mjs'), root, stage], { encoding: 'utf8' });
  assert.equal(collected.status, 0, collected.stderr || collected.stdout);
  for (const relative of [
    'src/runtime/adaptive-goal-phase2-search.js',
    'src/runtime/adaptive-goal-phase2-plan-shadow.js',
    'src/runtime/adaptive-goal-discriminator.js',
    'src/runtime/adaptive-goal-planner-telemetry.js',
    'src/runtime/adaptive-goal-graph.js',
    'src/runtime/canonical-json.js'
  ]) assert.ok(fs.statSync(path.join(stage, relative)).isFile(), `collector omitted ${relative}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin/manifest.json'), 'utf8'));
  assert.ok(manifest.tools.some(tool => tool.name === 'adaptive_goal_phase2_shadow_search'));
  const source = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
  assert.match(source, /case 'adaptive_goal_phase2_shadow_search'/);
  assert.match(source, /searchAdaptiveGoalGraphPhase2\(args\.graph, args\.model/);
  assert.match(source, /createAdaptiveGoalPlannerTelemetryStore\(workflowStore\.db/);
  assert.match(source, /searchAdaptiveGoalGraphPhase2\(args\.graph, args\.model, args\.options \|\| \{\}, telemetryContext\?\.onAuditEvent\)/);
});

test('pinned candidate archives remain byte-identical and still lack Phase 2 packaged modules', t => {
  const candidates = [
    {
      path: path.join(root, 'artifacts/agg-phase1-hardening-20261023T143802Z-deep-verification/runalith-1.0.9-rc.5-agg-phase1-hardened.mcpb'),
      archiveSha256: '7fb5f547eda71a717d10358510e1ea7baee46f5f9bcea3efc2891c6293bd3bc0',
      entrypointSha256: 'fe7a6accee6c4b7486d7661d4959b7020957c64b2909905d595e757b58b0cc15'
    },
    {
      path: path.join(root, 'artifacts/runalith-1.0.9-rc.5-candidate-latest-build-20261022T175328+0700.mcpb'),
      archiveSha256: '9d836dca9daec26b53a104f99028fb30fd11848e8c0a8764c4eb7dedd45e1c37',
      entrypointSha256: '3c8e905d0eadcdf2d2afa3588839ea97cd2dfa5c19f2f5909358ded03b670602'
    }
  ];
  const missing = candidates.filter(candidate => !fs.existsSync(candidate.path)).map(candidate => path.relative(root, candidate.path));
  if (missing.length) {
    t.skip(`historical candidate archives are local-only evidence and absent from this checkout: ${missing.join(', ')}`);
    return;
  }
  for (const candidate of candidates) {
    const archiveBytes = fs.readFileSync(candidate.path);
    assert.equal(createHash('sha256').update(archiveBytes).digest('hex'), candidate.archiveSha256);
    const entrypoint = spawnSync('unzip', ['-p', candidate.path, 'server/index.js'], { encoding: 'buffer' });
    assert.equal(entrypoint.status, 0, entrypoint.stderr?.toString());
    assert.equal(createHash('sha256').update(entrypoint.stdout).digest('hex'), candidate.entrypointSha256);
    const listing = spawnSync('unzip', ['-l', candidate.path], { encoding: 'utf8' });
    assert.equal(listing.status, 0, listing.stderr);
    assert.doesNotMatch(listing.stdout, /src\/runtime\/adaptive-goal-phase2-(?:search|plan-shadow)\.js/);
    const manifest = JSON.parse(spawnSync('unzip', ['-p', candidate.path, 'manifest.json'], { encoding: 'utf8' }).stdout);
    assert.equal(manifest.tools.some(tool => tool.name === 'adaptive_goal_phase2_shadow_search'), false);
  }
});

test('evidence-pack verifier rejects a self-computed digest as trust and validates detached Ed25519 anchor signatures', t => {
  const pack = path.join(root, 'artifacts/agg-phase2-workflow-20261024T080000Z-final-exclusive-publication-successor');
  const manifestPath = path.join(pack, 'SHA256SUMS.txt');
  if (!fs.existsSync(manifestPath)) {
    t.skip('historical Phase 2 evidence pack is local-only forensic evidence and its SHA256SUMS.txt is absent from this checkout');
    return;
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-phase2-anchor-contract-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  const verifier = path.join(root, 'scripts/verify-agg-phase2-evidence-pack.mjs');
  const untrustedOutput = path.join(temp, 'untrusted-anchor-report.json');
  const untrusted = spawnSync(process.execPath, [verifier, '--pack', pack, '--output', untrustedOutput,
    '--expected-manifest-sha256', manifestSha256], { cwd: root, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, AGG_PHASE2_TRUSTED_ANCHOR_PUBLIC_KEY_PEM: '' } });
  assert.equal(untrusted.status, 2, untrusted.stderr + untrusted.stdout);
  const untrustedReport = JSON.parse(fs.readFileSync(untrustedOutput, 'utf8'));
  assert.equal(untrustedReport.checks.find(item => item.id === 'EXPECTED_MANIFEST_ANCHOR')?.status, 'FAIL',
    'a digest recomputed from the same pack is not a trust anchor');
  assert.equal(untrustedReport.anchor.signatureVerified, false);
  assert.equal(untrustedReport.verificationStatus, 'BLOCKED');

  // Ephemeral key material here is test-only: it verifies signature plumbing,
  // not owner authority, release approval, or an operational trust root.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const signature = sign(null, Buffer.from(`agg-phase2-manifest-sha256:v1:${manifestSha256}`, 'utf8'), privateKey).toString('base64');
  const signedOutput = path.join(temp, 'signed-anchor-mechanics-report.json');
  const signed = spawnSync(process.execPath, [verifier, '--pack', pack, '--output', signedOutput,
    '--expected-manifest-sha256', manifestSha256, '--anchor-signature-base64', signature], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, AGG_PHASE2_TRUSTED_ANCHOR_PUBLIC_KEY_PEM: publicKey.export({ type: 'spki', format: 'pem' }).toString() }
  });
  assert.equal(signed.status, 2, 'synthetic test key must not remove independent source/worktree blockers');
  const signedReport = JSON.parse(fs.readFileSync(signedOutput, 'utf8'));
  assert.equal(signedReport.checks.find(item => item.id === 'EXPECTED_MANIFEST_ANCHOR')?.status, 'PASS');
  assert.equal(signedReport.anchor.signatureVerified, true);
  assert.equal(signedReport.anchor.actualManifestSha256, manifestSha256);
  assert.equal(signedReport.verificationStatus, 'BLOCKED', 'a valid signature over manifest identity is not pack acceptance');
});

test('default source runtime keeps Phase 2 opt-in and rejects direct calls while disabled', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-phase2-default-disabled-'));
  fs.chmodSync(temp, 0o700);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  for (const dir of ['home', 'data', 'workspace', 'execution-tmp']) fs.mkdirSync(path.join(temp, dir), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [path.join(root, 'server/index.js')], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: path.join(temp, 'home'), NODE_ENV: 'test', LANG: 'C.UTF-8',
      RUNALITH_DATA_DIR: path.join(temp, 'data'), RUNALITH_WORKFLOW_DB: path.join(temp, 'data/workflow.db'),
      RUNALITH_WORKSPACE: path.join(temp, 'workspace'), RUNALITH_EXECUTION_TMP_DIR: path.join(temp, 'execution-tmp'), TMPDIR: temp, TEMP: temp, TMP: temp }
  });
  let buffer = '', stderr = '', nextId = 1, exited = false;
  const pending = new Map();
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++, timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout ${method}: ${stderr}`)); }, 10000);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk; let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1); if (!line) continue;
      let message; try { message = JSON.parse(line); } catch { child.kill('SIGKILL'); return; }
      const waiter = pending.get(message.id); if (waiter) { pending.delete(message.id); waiter(message); }
    }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65536); });
  child.on('exit', () => { exited = true; });
  t.after(async () => {
    if (!exited) { child.stdin.end(); await new Promise(resolve => { const timer = setTimeout(() => { if (!exited) child.kill('SIGTERM'); resolve(); }, 1000); child.once('exit', () => { clearTimeout(timer); resolve(); }); }); }
    if (!exited) child.kill('SIGKILL');
  });
  const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'phase2-default-off-test', version: '1' } });
  assert.equal(initialized.error, undefined);
  const listed = await rpc('tools/list');
  assert.equal(listed.result.tools.length, 67, 'default source runtime preserves the pinned 67-tool surface; Phase 2/3/4 additions remain opt-in');
  assert.equal(listed.result.tools.some(tool => tool.name === 'adaptive_goal_knowledge_capture_workflow_outcome'), false);
  assert.equal(listed.result.tools.some(tool => tool.name === 'adaptive_goal_phase2_shadow_search'), false);
  assert.equal(listed.result.tools.some(tool => tool.name === 'adaptive_goal_phase3_mcts_shadow_search'), false);
  const denied = await rpc('tools/call', { name: 'adaptive_goal_phase2_shadow_search', arguments: { graph: graphFixture, model: modelFixture() } });
  assert.equal(denied.error, undefined);
  assert.equal(denied.result?.isError, true);
  assert.match(denied.result?.content?.[0]?.text || '', /opt-in and disabled in the default runtime/);
  const phase4Denied = await rpc('tools/call', { name: 'adaptive_goal_knowledge_capture_workflow_outcome', arguments: { goal_id: 'goal-a', job_id: 'job-a' } });
  assert.equal(phase4Denied.result?.isError, true);
  assert.match(phase4Denied.result?.content?.[0]?.text || '', /opt-in and disabled in the default runtime/);
});

test('actual source MCP dispatch returns deterministic shadow search and closed execution gates', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-phase2-source-mcp-'));
  fs.chmodSync(temp, 0o700);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const dirs = ['home', 'data', 'workspace', 'execution-tmp'];
  for (const dir of dirs) fs.mkdirSync(path.join(temp, dir), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [path.join(root, 'server/index.js')], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin', HOME: path.join(temp, 'home'), NODE_ENV: 'test', LANG: 'C.UTF-8',
      AGG_PHASE2_SHADOW_TOOL_ENABLED: '1',
      AGG_PHASE4_KNOWLEDGE_CAPTURE_TOOL_ENABLED: '1',
      RUNALITH_DATA_DIR: path.join(temp, 'data'), RUNALITH_WORKFLOW_DB: path.join(temp, 'data/workflow.db'),
      RUNALITH_WORKSPACE: path.join(temp, 'workspace'), RUNALITH_EXECUTION_TMP_DIR: path.join(temp, 'execution-tmp'),
      TMPDIR: temp, TEMP: temp, TMP: temp
    }
  });
  let stdoutBuffer = '', stderr = '', nextId = 1, exited = false;
  const pending = new Map();
  const rejectPending = error => {
    for (const [id, waiter] of pending) { pending.delete(id); clearTimeout(waiter.timer); waiter.reject(error); }
  };
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP RPC timeout ${method}: ${stderr.slice(-1500)}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
      if (!error) return;
      const waiter = pending.get(id); if (!waiter) return;
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
      try { message = JSON.parse(line); } catch { rejectPending(new Error(`non-JSON MCP stdout: ${line.slice(0, 500)}`)); child.kill('SIGKILL'); return; }
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message); }
    }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1024 * 1024); });
  child.on('error', rejectPending);
  child.on('exit', (code, signal) => { exited = true; rejectPending(new Error(`source MCP exited code=${code} signal=${signal}: ${stderr.slice(-1500)}`)); });
  t.after(async () => {
    if (!exited) {
      child.stdin.end();
      await new Promise(resolve => { const timer = setTimeout(() => { if (!exited) child.kill('SIGTERM'); resolve(); }, 1000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    }
    if (!exited) child.kill('SIGKILL');
  });

  const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'phase2-shadow-test', version: '1' } });
  assert.equal(initialized.error, undefined, JSON.stringify(initialized.error));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  const listed = await rpc('tools/list');
  const tool = listed.result?.tools?.find(item => item.name === 'adaptive_goal_phase2_shadow_search');
  assert.ok(tool, 'Phase 2 shadow tool is missing from the actual runtime tools/list response');
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.required, ['graph', 'model']);

  const args = { graph: graphFixture, model: modelFixture(), options: { beamWidth: 2, maxDepth: 5, maxExpansions: 20, maxAuditEvents: 100 } };
  const first = await rpc('tools/call', { name: 'adaptive_goal_phase2_shadow_search', arguments: args });
  assert.equal(first.error, undefined, JSON.stringify(first.error));
  const unpack = response => {
    const content = response.result?.content?.find(item => item.type === 'text')?.text;
    if (response.result?.structuredContent) return response.result.structuredContent;
    assert.equal(typeof content, 'string', JSON.stringify(response).slice(0, 1000));
    return JSON.parse(content);
  };
  const result = unpack(first);
  assert.equal(result.mode, 'shadow');
  assert.equal(result.status, 'proposals_found');
  assert.ok(result.candidates.length > 0);
  assert.ok(result.planGraphDrafts.length > 0);
  assert.equal(result.search.executionAuthorized, false);
  assert.equal(result.acceptance, 'offline_shadow_not_acceptance');
  assert.equal(result.modelTrust.modelSha256SelfHashValidated, true);
  assert.equal(result.modelTrust.trainingMetricsIndependentlyRecomputed, false);
  assert.equal(result.modelTrust.trustedModelAttestationPresent, false);
  const reference = independentlyDeriveSearch(graphFixture, { model: args.model }, {
    beamWidth: 2, maxDepth: 5, maxExpansions: 20, maxAuditEvents: 100, initiallyAvailableIds: []
  });
  assert.deepEqual(result.candidates, reference.candidates, 'independent reference candidate ranking/identity differs');
  assert.deepEqual(result.search, reference.search, 'independent reference search counters/bounds differ');
  assert.deepEqual(result.auditTrace, reference.auditTrace, 'independent reference ordered audit event sequence differs');
  assert.deepEqual(result.gates, {
    persisted: false, humanReviewRequired: true, workflowApprovalRequired: true,
    immutableExecutionPlanCreated: false, dispatchAllowed: false, executionAuthorized: false
  });
  for (const draft of result.planGraphDrafts) {
    assert.equal(draft.kind, 'adaptive_goal_phase2_plan_graph_shadow_draft');
    assert.equal(draft.status, 'review_required');
    assert.equal(draft.gates.dispatchAllowed, false);
    assert.equal(draft.gates.executionAuthorized, false);
    assert.equal(draft.gates.immutableExecutionPlanCreated, false);
  }
  const second = unpack(await rpc('tools/call', { name: 'adaptive_goal_phase2_shadow_search', arguments: args }));
  assert.equal(second.search.searchRunId, result.search.searchRunId);
  assert.deepEqual(second.candidates, result.candidates);
  assert.deepEqual(second.auditTrace, result.auditTrace);

  const tamperedModel = structuredClone(args.model); tamperedModel.intercept += 1;
  const rejected = await rpc('tools/call', { name: 'adaptive_goal_phase2_shadow_search', arguments: { ...args, model: tamperedModel } });
  const rejectionText = JSON.stringify(rejected.result || rejected.error || rejected);
  assert.match(rejectionText, /model hash mismatch|AdaptiveGoalDiscriminator/);
});
