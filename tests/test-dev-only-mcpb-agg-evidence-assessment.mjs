#!/usr/bin/env node
// Development-only MCPB integration test for the candidate-bound AGG evidence
// assessment. It never installs the bundle, creates a workflow, approves,
// dispatches, executes an action, or produces official Phase 1 evidence.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { classifyCandidateEvidenceAssessment } from './helpers/adaptive-goal-candidate-assessment-contract.mjs';

const args = process.argv.slice(2);
if (args[0] !== '--dev-only-not-acceptance' || !args[1] ||
    (args.length !== 2 && !(args.length === 4 && args[2] === '--output' && args[3]))) {
  console.error('Usage: node tests/test-dev-only-mcpb-agg-evidence-assessment.mjs --dev-only-not-acceptance <candidate.mcpb> [--output artifacts/phase1-dev-only/<new-evidence-file>.json]');
  process.exit(2);
}
const bundlePath = path.resolve(args[1]);
const evidenceOutputPath = args.length === 4 ? path.resolve(args[3]) : null;
const evidenceRoot = path.resolve('artifacts/phase1-dev-only');
if (evidenceOutputPath) {
  assert.ok(evidenceOutputPath.startsWith(`${evidenceRoot}${path.sep}`), 'evidence output must stay under artifacts/phase1-dev-only');
  assert.ok(!fs.existsSync(evidenceOutputPath) && !fs.existsSync(`${evidenceOutputPath}.sha256`), 'refusing to overwrite evidence or sidecar');
}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function runSync(command, argv, options = {}) {
  const result = spawnSync(command, argv, { encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${argv.join(' ')} failed (${result.status ?? result.signal}): ${(result.stderr || result.stdout || '').slice(0, 2500)}`);
  return result.stdout;
}

function runSyncBytes(command, argv, options = {}) {
  const result = spawnSync(command, argv, { encoding: null, timeout: 15_000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${argv.join(' ')} failed (${result.status ?? result.signal}): ${String(result.stderr || '').slice(0, 2500)}`);
  return result.stdout;
}

function unpackResult(result) {
  assert.notEqual(result?.isError, true, `MCP tool returned error: ${JSON.stringify(result).slice(0, 1800)}`);
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const text = result?.content?.find(part => part.type === 'text')?.text;
  assert.equal(typeof text, 'string', 'MCP response has no structured/text content');
  try { return JSON.parse(text); } catch { assert.fail(`MCP returned non-JSON text: ${text.slice(0, 1200)}`); }
}

async function main() {
  const lstat = fs.lstatSync(bundlePath);
  assert.ok(lstat.isFile() && !lstat.isSymbolicLink(), 'development candidate must be a regular non-symlink file');
  assert.equal(fs.realpathSync(bundlePath), bundlePath, 'candidate path must be canonical');
  assert.ok(bundlePath.endsWith('.mcpb'), 'candidate must use the .mcpb extension');
  const candidateBytes = fs.readFileSync(bundlePath);
  const candidateSha256 = hash(candidateBytes);
  runSync('unzip', ['-t', bundlePath]);
  const manifest = JSON.parse(runSync('unzip', ['-p', bundlePath, 'manifest.json']));
  const manifestSha256 = hash(runSyncBytes('unzip', ['-p', bundlePath, 'manifest.json']));
  const packagedServerSha256 = hash(runSyncBytes('unzip', ['-p', bundlePath, 'server/index.js']));
  assert.equal(manifest.name, 'runalith-agent-orchestrator');
  assert.equal(manifest.server?.entry_point, 'server/index.js');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runalith-dev-only-agg-evidence-'));
  fs.chmodSync(tempRoot, 0o700);
  const extracted = path.join(tempRoot, 'bundle');
  const home = path.join(tempRoot, 'home');
  const data = path.join(tempRoot, 'data');
  const workspace = path.join(tempRoot, 'workspace');
  const executionTmp = path.join(tempRoot, 'execution-tmp');
  for (const dir of [extracted, home, data, workspace, executionTmp]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let child = null;
  let exited = false;
  let stdoutBuffer = '';
  let stderr = '';
  let nextId = 1;
  const pending = new Map();
  const rpcTranscript = [];
  const caseResults = [];
  const assessmentDiagnostics = [];
  let childExitResolve = null;
  const exitPromise = new Promise(resolve => {
    // A listener is installed before spawn; the value is updated below through
    // the child exit listener and is only used for bounded cleanup.
    childExitResolve = resolve;
  });

  const stopChild = async () => {
    if (!child || exited) return;
    child.stdin.end();
    await Promise.race([exitPromise, new Promise(resolve => setTimeout(resolve, 1000))]);
    if (!exited) child.kill('SIGTERM');
    if (!exited) await Promise.race([exitPromise, new Promise(resolve => setTimeout(resolve, 500))]);
    if (!exited) child.kill('SIGKILL');
  };

  try {
    runSync('unzip', ['-q', bundlePath, '-d', extracted]);
    const packagedGraphBytes = fs.readFileSync(path.join(extracted, 'src/runtime/adaptive-goal-graph.js'));
    const packagedGraphSha256 = hash(packagedGraphBytes);
    child = spawn(process.execPath, [path.join(extracted, 'server/index.js')], {
      cwd: extracted,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: home, TMPDIR: tempRoot, TEMP: tempRoot, TMP: tempRoot,
        LANG: 'C.UTF-8', NODE_ENV: 'test',
        RUNALITH_DATA_DIR: data, RUNALITH_WORKFLOW_DB: path.join(data, 'workflow.db'),
        RUNALITH_WORKSPACE: workspace, RUNALITH_EXECUTION_TMP_DIR: executionTmp,
        CHAT_ON_STERIODS_DATA_DIR: data, CHAT_ON_STERIODS_WORKSPACE: workspace,
        CHAT_ON_STERIODS_WORKFLOW_DB: path.join(data, 'workflow.db'), CHAT_ON_STERIODS_EXECUTION_TMP_DIR: executionTmp,
        WORKFLOW_DATA_DIR: data, WORKFLOW_DB: path.join(data, 'workflow.db'), EXECUTION_TMP_DIR: executionTmp,
        AGG_SANDBOX_EXECUTOR_MODE: 'fixture', AGG_SANDBOX_ROOT: path.join(data, 'agg-sandbox')
      }
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk;
      let newline;
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch {
          for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`non-JSON MCP stdout: ${line.slice(0, 400)}`)); }
          pending.clear();
          child.kill('SIGKILL');
          return;
        }
        const waiter = pending.get(message.id);
        if (waiter) {
          pending.delete(message.id);
          clearTimeout(waiter.timer);
          rpcTranscript.push({ direction: 'response', message });
          waiter.resolve(message);
        }
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('exit', (code, signal) => {
      exited = true;
      childExitResolve?.();
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`packaged MCP server exited (code=${code}, signal=${signal}): ${stderr}`));
      }
      pending.clear();
    });

    const rpc = (method, params = {}) => {
      if (!child || exited) return Promise.reject(new Error(`MCP is not running for ${method}`));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timed out for ${method}: ${stderr}`)); }, 8000);
        pending.set(id, { resolve, reject, timer });
        const message = { jsonrpc: '2.0', id, method, params };
        rpcTranscript.push({ direction: 'request', message });
        child.stdin.write(`${JSON.stringify(message)}\n`);
      });
    };

    const initialized = await rpc('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dev-only-agg-evidence-replay', version: '1' }
    });
    assert.equal(initialized.error, undefined, JSON.stringify(initialized.error));
    assert.equal(initialized.result?.serverInfo?.version, manifest.version);
    const initializedNotification = { jsonrpc: '2.0', method: 'notifications/initialized', params: {} };
    rpcTranscript.push({ direction: 'notification', message: initializedNotification });
    child.stdin.write(`${JSON.stringify(initializedNotification)}\n`);
    const listed = await rpc('tools/list', {});
    assert.equal(listed.error, undefined, JSON.stringify(listed.error));
    const tools = listed.result?.tools ?? [];
    assert.equal(tools.length, manifest.tools.length);
    assert.ok(tools.some(tool => tool.name === 'adaptive_goal_graph_search'));
    const healthCall = await rpc('tools/call', { name: 'orchestrator_health', arguments: {} });
    const health = unpackResult(healthCall.result);
    assert.equal(health.status, 'ok');
    assert.equal(health.mode, 'local-only-mcp');
    assert.equal(path.resolve(health.database), path.join(data, 'workflow.db'));

    const searchGraph = async evidenceRef => ({
      schemaVersion: 1, startNodeId: 'start', goalNodeId: 'goal',
      nodes: [
        { id: 'start', type: 'goal', label: 'Inspect packaged runtime evidence' },
        { id: 'inspect-evidence', type: 'task', label: 'Assess one evidence reference', evidenceRefs: [evidenceRef] },
        { id: 'goal', type: 'goal', label: 'Retain the review-only proposal boundary' }
      ],
      edges: [{ from: 'start', to: 'inspect-evidence', type: 'next_step' }, { from: 'inspect-evidence', to: 'goal', type: 'next_step' }]
    });
    async function callSearch(label, reference) {
      const graph = await searchGraph(reference);
      const options = { beamWidth: 4, maxDepth: 5, maxExpansions: 24 };
      const response = await rpc('tools/call', {
        name: 'adaptive_goal_graph_search',
        arguments: { graph, options }
      });
      assert.equal(response.error, undefined, JSON.stringify(response.error));
      const result = unpackResult(response.result);
      caseResults.push({ label, graph, options, rpcResponse: response, result });
      return result;
    }

    function inspectAssessment(label, searchResult, expectedCategory) {
      const candidatePlanId = searchResult.candidates?.[0]?.planId;
      const assessment = classifyCandidateEvidenceAssessment({
        tools, result: searchResult, candidatePlanId, graphHash: searchResult.graphHash
      });
      const { assessment: _assessment, ...diagnostic } = assessment;
      assessmentDiagnostics.push({ label, expectedCategory, ...diagnostic, passed: assessment.category === expectedCategory });
      return assessment;
    }

    const validRef = `file:src/runtime/adaptive-goal-graph.js#sha256=${packagedGraphSha256}`;
    const exact = await callSearch('exact_source_hash', validRef);
    assert.equal(exact.status, 'proposals_found');
    assert.match(exact.graphHash, /^[a-f0-9]{64}$/);
    assert.equal(exact.candidates[0]?.verification?.verified, false);
    assert.equal(exact.candidates[0]?.evidence?.verifiedReferenceCount, 0);
    assert.equal(exact.candidates[0]?.evidence?.coverage, 0);
    const exactContract = inspectAssessment('exact_source_hash', exact, 'resolved_integrity_only_claims_unverified');
    const exactAssessment = exactContract.assessment;
    if (exactAssessment) {
      assert.equal(exactAssessment.targetBinding.graphHash, exact.graphHash);
      assert.equal(exactAssessment.targetBinding.runtimeBundleSha256, null,
        'the MCP runtime must not invent a trusted self-archive hash it cannot establish');
      assert.equal(exactAssessment.sourceIntegrityVerifiedCount, 1);
      assert.equal(exactAssessment.sourceIntegrityCoverage, 1);
      assert.equal(exactAssessment.durableArtifactLineageVerifiedCount, 0);
      assert.equal(exactAssessment.unresolvedReferenceCount, 0);
      assert.equal(exactAssessment.claimVerifiedReferenceCount, 0);
      assert.equal(exactAssessment.independentAttestationVerifiedReferenceCount, 0);
      assert.equal(exactAssessment.claimCoverage, 0);
      assert.equal(exactAssessment.independentAttestationCoverage, 0);
      assert.equal(exactAssessment.candidateVerified, false);
    }

    const stale = await callSearch('stale_source_hash', `file:src/runtime/adaptive-goal-graph.js#sha256=${'0'.repeat(64)}`);
    const staleContract = inspectAssessment('stale_source_hash', stale, 'provenance_invalid');
    const staleAssessment = staleContract.assessment;
    if (staleAssessment) {
      assert.equal(staleAssessment.sourceIntegrityVerifiedCount, 0);
      assert.equal(staleAssessment.invalidProvenanceCount, 1);
      assert.equal(staleAssessment.resolutions[0].status, 'source_hash_mismatch_or_stale');
    }
    assert.equal(stale.candidates[0].verification.verified, false);

    const unresolved = await callSearch('unresolved_durable_artifact', 'artifact://not-present-in-disposable-database');
    const unresolvedContract = inspectAssessment('unresolved_durable_artifact', unresolved, 'evidence_unresolved');
    const unresolvedAssessment = unresolvedContract.assessment;
    if (unresolvedAssessment) {
      assert.equal(unresolvedAssessment.unresolvedReferenceCount, 1);
      assert.equal(unresolvedAssessment.referenceResolutionCoverage, 0);
      assert.equal(unresolvedAssessment.resolutions[0].classification, 'durable_artifact_unverified');
      assert.equal(unresolvedAssessment.resolutions[0].resolverClassification, 'not_content_addressed');
      assert.equal(unresolvedAssessment.claimCoverage, 0);
      assert.equal(unresolvedAssessment.independentAttestationCoverage, 0);
    }

    await stopChild();
    child = null;
    const db = new DatabaseSync(path.join(data, 'workflow.db'), { readOnly: true });
    try {
      for (const table of ['jobs', 'tasks', 'approvals', 'workflow_plans', 'execution_batches']) {
        const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
        assert.equal(count, 0, `read-only AGG evidence search must not mutate ${table}`);
      }
    } finally { db.close(); }

    let evidenceOutput = null;
    if (evidenceOutputPath) {
      const evidence = {
        schemaVersion: 1,
        kind: 'dev_only_packaged_agg_evidence_assessment_rpc_trace',
        capturedAt: new Date().toISOString(),
        devOnlyNotAcceptance: true,
        officialAcceptanceEligible: false,
        source: {
          candidatePath: path.relative(process.cwd(), bundlePath),
          candidateSha256, candidateBytes: candidateBytes.length,
          manifestSha256, packagedServerSha256, packagedGraphSha256,
          packageVersion: manifest.version, manifestToolCount: manifest.tools.length, runtimeToolCount: tools.length,
          runtimeDatabase: 'private_disposable_temp_only',
          runtimeBundleSha256Trusted: false,
          note: 'The candidate archive digest is recorded by the harness but the MCP runtime does not attest a trusted self-archive digest; this record is development evidence only.'
        },
        rpcTranscript,
        caseResults,
        assessmentDiagnostics,
        finalDatabaseAssertions: {
          databasePath: '[private temporary database; deleted after test]',
          jobs: 0, tasks: 0, approvals: 0, workflowPlans: 0, executionBatches: 0,
          workflowCreated: false, approved: false, dispatched: false, actionsExecuted: false
        },
        evidencePolicy: {
          validSourceBytesProveIntegrityOnly: exactAssessment ? exactAssessment.claimVerifiedReferenceCount === 0 : null,
          staleSourceHashRejected: staleAssessment ? staleAssessment.invalidProvenanceCount === 1 : null,
          unresolvedArtifactRemainsUnresolved: unresolvedAssessment ? unresolvedAssessment.unresolvedReferenceCount === 1 : null,
          claimVerifiedReferenceCount: 0,
          independentAttestationVerifiedReferenceCount: 0,
          candidateVerified: false,
          productionAuthorityGranted: false
        }
      };
      const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
      fs.writeFileSync(evidenceOutputPath, bytes, { flag: 'wx', mode: 0o600 });
      const evidenceSha256 = hash(bytes);
      fs.writeFileSync(`${evidenceOutputPath}.sha256`, `${evidenceSha256}  ${path.basename(evidenceOutputPath)}\n`, { flag: 'wx', mode: 0o600 });
      evidenceOutput = { path: path.relative(process.cwd(), evidenceOutputPath), sha256: evidenceSha256, bytes: bytes.length };
    }

    console.log('DEV_ONLY_MCPB_AGG_EVIDENCE_ASSESSMENT_DIAGNOSTIC=COMPLETE');
    console.log(`candidate_sha256=${candidateSha256}`);
    console.log(`candidate_bytes=${candidateBytes.length}`);
    console.log(`version=${manifest.version}`);
    console.log(`manifest_tools=${manifest.tools.length}`);
    console.log(`runtime_tools=${tools.length}`);
    console.log(`packaged_graph_source_sha256=${packagedGraphSha256}`);
    console.log(`manifest_sha256=${manifestSha256}`);
    console.log(`packaged_server_sha256=${packagedServerSha256}`);
    console.log(`exact_assessment_contract=${exactContract.category}`);
    console.log(`stale_assessment_contract=${staleContract.category}`);
    console.log(`unresolved_assessment_contract=${unresolvedContract.category}`);
    console.log(`assessment_contract_failures=${assessmentDiagnostics.filter(item => !item.passed).length}`);
    if (exactAssessment) console.log(`exact_source_integrity_coverage=${exactAssessment.sourceIntegrityCoverage}`);
    if (staleAssessment) console.log(`stale_source_integrity_coverage=${staleAssessment.sourceIntegrityCoverage}`);
    if (unresolvedAssessment) console.log(`unresolved_reference_count=${unresolvedAssessment.unresolvedReferenceCount}`);
    console.log('claim_coverage=0');
    console.log('independent_attestation_coverage=0');
    console.log('candidate_verified=false');
    console.log('workflow_created=false');
    console.log('approved=false');
    console.log('dispatch_allowed=false');
    console.log('production_authority_granted=false');
    console.log('database=private_disposable_temp_only');
    if (evidenceOutput) {
      console.log(`evidence_output_path=${evidenceOutput.path}`);
      console.log(`evidence_output_sha256=${evidenceOutput.sha256}`);
      console.log(`evidence_output_bytes=${evidenceOutput.bytes}`);
    }
    assert.deepEqual(assessmentDiagnostics.filter(item => !item.passed), [],
      'packaged MCP assessment contract must distinguish exact integrity-only, stale provenance, and unresolved evidence results');
    console.log('DEV_ONLY_MCPB_AGG_EVIDENCE_ASSESSMENT=PASS');
  } finally {
    if (child) await stopChild();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`DEV_ONLY_MCPB_AGG_EVIDENCE_ASSESSMENT=FAIL\n${error?.stack || error}`);
  process.exitCode = 1;
});
