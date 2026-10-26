#!/usr/bin/env node
// Separate development-only CASE-01 paired pilot. Never used by the official
// acceptance runner; output is always marked DEV_ONLY_NOT_ACCEPTANCE.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createScenarioWorkspace } from './scenario-basic-tools.mjs';
import { verifyScenario } from './scenario-verifiers.mjs';
import { verifyPluginStateExport } from './plugin-state-export.mjs';
import { verifyExecutorTrace } from './trace-integrity.mjs';
import { verifyPluginArtifactLineage } from './plugin-artifact-lineage.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let specPath;
let specBytes;
let spec;
let specHash;
let specVersion = 1;
const adapterPath = path.join(here, 'ollama-candidate-dev-only-case01-adapter.mjs');
const frozenBundleHash = '9d836dca9daec26b53a104f99028fb30fd11848e8c0a8764c4eb7dedd45e1c37';
const frozenV1SpecSha256 = '1d2b8997a33f8e6b6af0f59776b8d08f5b771e724001981e84ef5f9f99617f3c';
const devOnlyRoot = path.resolve(here, '../..', 'artifacts/phase1-dev-only');
const currentCandidatePath = path.resolve(here, '../..', 'artifacts/runalith-1.0.9-rc.5-candidate-latest-build-20261022T175328+0700.mcpb');
const sha256 = value => createHash('sha256').update(value).digest('hex');

function argsOf(argv) {
  const out = { caseId: null, output: null, devOnlyNotAcceptance: false, specVersion: 1 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--case') out.caseId = argv[++i];
    else if (argv[i] === '--output') out.output = argv[++i];
    else if (argv[i] === '--spec-version') out.specVersion = Number(argv[++i]);
    else if (argv[i] === '--dev-only-not-acceptance') out.devOnlyNotAcceptance = true;
    else if (argv[i] === '--help') out.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

async function invokeAdapter({ condition, scenario, runId, root, specCase, promptHash, initialHashes, timeoutMs }) {
  const workspace = path.join(root, 'workspace');
  const dataDirectory = path.join(root, 'data');
  const executionTmpDirectory = path.join(root, 'execution-tmp');
  for (const dir of [workspace, dataDirectory, executionTmpDirectory]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const adapterRequest = {
    protocol: `cos-scenario-host-v${specVersion}`, spec_version: specVersion, run_id: runId, case_id: scenario.case_id,
    condition, probe_only: false, scenario_execution_authorized: false, dev_only_not_acceptance: true,
    authorization_record_id: null,
    scenario_spec_sha256: specHash, prompt: scenario.prompt, prompt_sha256: promptHash,
    tools_profile: condition === 'plugin' ? 'basic-plus-case-plugin-allowlist' : 'basic-tools-only',
    scenario: specCase, workspace, data_directory: dataDirectory,
    execution_tmp_directory: executionTmpDirectory,
    initial_file_hashes: Object.entries(initialHashes),
    requirements: { no_workflow_approval_or_dispatch: true, no_external_network: true,
      no_external_provider_credentials: true, no_live_runtime: true },
  };
  const child = spawn(process.execPath, [adapterPath], {
    cwd: root,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC',
      COS_BENCHMARK_RUN_ID: runId, COS_BENCHMARK_CASE_ID: scenario.case_id,
      COS_BENCHMARK_CONDITION: condition, COS_BENCHMARK_SPEC_SHA256: specHash, COS_BENCHMARK_SPEC_VERSION: String(specVersion),
      COS_BENCHMARK_DEV_ONLY_NOT_ACCEPTANCE: 'YES' },
    stdio: ['pipe', 'pipe', 'pipe'], shell: false,
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  // Leave cleanup time after the tool loop's own hard condition budget so a timeout can persist its partial trace.
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2_000_000) child.kill('SIGTERM'); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-10000); });
  child.stdin.end(`${JSON.stringify(adapterRequest)}\n`);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  }).finally(() => clearTimeout(timer));
  const partialPath = path.join(workspace, 'host-native-trace.partial.json');
  const completePath = path.join(workspace, 'host-native-trace.json');
  const readTrace = () => {
    for (const candidate of [partialPath, completePath]) {
      if (!fs.existsSync(candidate)) continue;
      try { return { trace: JSON.parse(fs.readFileSync(candidate, 'utf8')), path: candidate }; }
      catch { return { trace: null, path: candidate }; }
    }
    return { trace: null, path: null };
  };
  if (timedOut || code !== 0) {
    const saved = readTrace();
    return { error: timedOut ? `adapter timed out after ${timeoutMs}ms` : `adapter exited ${code}: ${stderr.slice(-3000)}`,
      partialTrace: saved.trace, partialPath: saved.path,
      workspace, dataDirectory, executionTmpDirectory, stderr };
  }
  try {
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length, 1, `${condition} adapter must emit one JSON line`);
    const response = JSON.parse(lines[0]);
    assert.equal(response.protocol, `cos-scenario-host-v${specVersion}`);
    assert.equal(response.run_id, runId);
    assert.equal(response.case_id, scenario.case_id);
    assert.equal(response.condition, condition);
    assert.equal(response.prompt_sha256, promptHash);
    assert.equal(response.model?.id, spec.model.id);
    assert.equal(response.environment?.live_runtime_targeted, false);
    assert.equal(response.environment?.external_network_used, false);
    assert.equal(response.environment?.external_provider_credentials_used, false);
    const tracePath = path.resolve(response.raw_trace.path);
    assert.ok(tracePath.startsWith(`${fs.realpathSync(workspace)}${path.sep}`), 'raw trace must remain inside isolated workspace');
    assert.equal(sha256(fs.readFileSync(tracePath)), response.raw_trace.sha256);
    return { response, workspace, dataDirectory, executionTmpDirectory, stderr };
  } catch (error) {
    const saved = readTrace();
    return { error: `adapter response validation failed: ${String(error?.message ?? error)}`,
      partialTrace: saved.trace, partialPath: saved.path,
      workspace, dataDirectory, executionTmpDirectory, stderr };
  }
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scenario-dev-only-case01-harness.mjs --case CASE-01 --output artifacts/phase1-dev-only/<new-file>.json --dev-only-not-acceptance');
    console.log('This separate pilot is restricted to CASE-01, uses private temporary state, never opens or changes the official gate, and can never produce official acceptance evidence.');
    return;
  }
  assert.equal(args.specVersion, 1, 'the dev-only pilot is fixed to the original v1 prompt bytes only');
  specVersion = args.specVersion;
  specPath = path.join(here, 'scenario-execution-spec-v1.json');
  specBytes = fs.readFileSync(specPath);
  spec = JSON.parse(specBytes.toString('utf8'));
  specHash = createHash('sha256').update(specBytes).digest('hex');
  assert.equal(args.caseId, 'CASE-01', 'this separately fenced pilot permits CASE-01 only');
  assert.ok(args.output, '--output is required');
  const scenario = spec.cases.find(c => c.case_id === args.caseId);
  assert.ok(scenario, `unknown case ${args.caseId}`);
  const output = path.resolve(args.output);
  assert.ok(output.startsWith(`${devOnlyRoot}${path.sep}`), `dev-only evidence output must stay under ${devOnlyRoot}`);
  if (!args.devOnlyNotAcceptance) {
    writeJson(output, { protocol: `cos-scenario-paired-v${specVersion}`, spec_version: specVersion, case_id: args.caseId,
      status: 'blocked', dev_only_not_acceptance: true, official_acceptance_eligible: false,
      benchmark_scenarios_executed: false, scenario_prompt_issued: false,
      reason: 'Explicit --dev-only-not-acceptance mode marker was not supplied; no workspace was created and no prompt was issued.',
      scenario_spec_sha256: specHash, captured_at: new Date().toISOString() });
    console.log(JSON.stringify({ status: 'blocked', benchmark_scenarios_executed: false, evidence: output }, null, 2));
    process.exitCode = 2;
    return;
  }
  assert.equal(spec.status, 'prepared-not-authorized', 'the official source spec must remain its original blocked v1 revision');
  assert.equal(spec.execution_gate?.status, 'blocked', 'the official execution gate must remain blocked during the dev-only pilot');
  assert.deepEqual(spec.execution_gate?.authorized_case_ids, [], 'the official gate must not contain an authorized case');
  assert.equal(specHash, frozenV1SpecSha256, 'the official frozen v1 prompt/spec bytes changed');
  assert.equal(sha256(fs.readFileSync(currentCandidatePath)), frozenBundleHash, 'current MCPB candidate SHA-256 changed');
  if (fs.existsSync(output)) throw new Error(`evidence output already exists; refusing overwrite: ${output}`);
  if (fs.existsSync(`${output}.evidence`)) throw new Error(`evidence directory already exists; refusing overwrite: ${output}.evidence`);

  const runId = randomUUID();
  const promptHash = sha256(Buffer.from(scenario.prompt, 'utf8'));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `cos-scenario-${args.caseId.toLowerCase()}-`));
  const evidenceRoot = `${output}.evidence`;
  const conditionResults = {};
  let finalEvidence;
  let scenarioPromptIssued = false;
  try {
    for (const condition of ['plugin', 'control']) {
      const root = path.join(tempRoot, condition);
      const workspace = path.join(root, 'workspace');
      fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
      const initial = createScenarioWorkspace(workspace, scenario);
      const invoked = await invokeAdapter({ condition, scenario, runId, root, specCase: scenario,
        promptHash, initialHashes: initial.initialHashes, timeoutMs: spec.model.max_elapsed_seconds_per_condition * 1000 + 15_000 });
      const trace = invoked.response
        ? JSON.parse(fs.readFileSync(invoked.response.raw_trace.path, 'utf8'))
        : (invoked.partialTrace ?? { model_events: [], tool_events: [], adapter_error: invoked.error });
      // Count a prompt only from the persisted raw trace, not from the adapter's summary claim.
      scenarioPromptIssued ||= (trace.model_events ?? []).some(event => ['model_request', 'model_response', 'model_tool_call'].includes(event.kind));
      let pluginStateEvidence = { status: 'not-applicable', workspace_artifact_causality_proven: false };
      let pluginArtifactLineage = { status: 'not-applicable', causal_link_proven: false, checks: [] };
      if (condition === 'plugin') {
        const exportInfo = trace.plugin_state_export;
        if (invoked.response) {
          pluginStateEvidence = verifyPluginStateExport({ workspaceDirectory: workspace, exportInfo,
            expectedIdentity: { run_id: runId, case_id: scenario.case_id, condition: 'plugin',
              scenario_spec_sha256: specHash, bundle_sha256: frozenBundleHash,
              model_id: spec.model.id, prompt_sha256: promptHash } });
        } else {
          pluginStateEvidence = { status: 'missing-or-partial', sha256: exportInfo?.sha256 ?? null,
            workspace_artifact_causality_proven: false };
        }
        if (specVersion >= 2) {
          let exportDocument = null;
          try { exportDocument = JSON.parse(fs.readFileSync(path.join(workspace, 'plugin-state-export.json'), 'utf8')); } catch { /* missing export fails the independent lineage checks */ }
          pluginArtifactLineage = verifyPluginArtifactLineage({ workspace, exportDocument, trace,
            contract: scenario.execution_contract });
        }
      }
      const traceIntegrity = verifyExecutorTrace(trace);
      let verification = verifyScenario({ scenario, workspace, trace,
        initialHashes: initial.initialHashes, finalAnswer: invoked.response?.final_answer ?? '' });
      if (traceIntegrity.status !== 'verified') verification = { ...verification,
        status: 'fail-or-unverified',
        checks: [...verification.checks, { name: 'executor-trace-integrity', passed: false,
          detail: JSON.stringify({ status: traceIntegrity.status, failed_checks: traceIntegrity.failed_checks }) }],
        total_checks: verification.total_checks + 1,
        failed_checks: [...verification.failed_checks, 'executor-trace-integrity'] };
      if (condition === 'plugin' && specVersion >= 2 && pluginArtifactLineage.status !== 'verified') verification = { ...verification,
        status: 'fail-or-unverified',
        checks: [...verification.checks, { name: 'plugin-artifact-lineage', passed: false,
          detail: JSON.stringify({ status: pluginArtifactLineage.status, failed_checks: pluginArtifactLineage.failed_checks }) }],
        total_checks: verification.total_checks + 1,
        failed_checks: [...verification.failed_checks, 'plugin-artifact-lineage'] };
      const persistentRoot = path.join(evidenceRoot, runId, condition);
      fs.mkdirSync(persistentRoot, { recursive: true, mode: 0o700 });
      const workspaceCopy = path.join(persistentRoot, 'workspace');
      fs.cpSync(workspace, workspaceCopy, { recursive: true, errorOnExist: true, dereference: false });
      const dataCopy = path.join(persistentRoot, 'data');
      fs.cpSync(invoked.dataDirectory, dataCopy, { recursive: true, errorOnExist: true, dereference: false });
      const executionTmpCopy = path.join(persistentRoot, 'execution-tmp');
      fs.cpSync(invoked.executionTmpDirectory, executionTmpCopy, { recursive: true, errorOnExist: true, dereference: false });
      const traceSourceName = invoked.response ? 'host-native-trace.json'
        : path.basename(invoked.partialPath ?? 'host-native-trace.partial.json');
      const traceSource = path.join(workspaceCopy, traceSourceName);
      let durableTrace = null;
      if (fs.existsSync(traceSource)) durableTrace = { path: traceSource, sha256: sha256(fs.readFileSync(traceSource)) };
      conditionResults[condition] = { response: invoked.response ? { ...invoked.response,
        raw_trace: durableTrace,
        environment: { ...invoked.response.environment, workspace_path: workspaceCopy, data_directory: dataCopy,
          execution_tmp_directory: executionTmpCopy } } : null,
        error: invoked.error ?? null, partial_trace: durableTrace, trace_integrity: traceIntegrity,
        plugin_state_evidence: pluginStateEvidence, plugin_artifact_lineage: pluginArtifactLineage,
        verification, evidence_directory: persistentRoot };
    }
    const failed = Object.values(conditionResults).some(c => c.verification.status !== 'verified-by-independent-checks' || c.verification.hard_fail);
    const pluginBenefitCausal = specVersion >= 2
      ? conditionResults.plugin?.plugin_artifact_lineage?.causal_link_proven === true
      : conditionResults.plugin?.plugin_state_evidence?.workspace_artifact_causality_proven === true;
    finalEvidence = { protocol: `cos-scenario-paired-v${specVersion}`, spec_version: specVersion, run_id: runId, captured_at: new Date().toISOString(),
      status: 'DEV_ONLY_NOT_ACCEPTANCE', dev_only_not_acceptance: true, official_acceptance_eligible: false,
      official_gate_modified: false, official_gate_snapshot: { spec_status: spec.status,
        execution_gate_status: spec.execution_gate.status, authorized_case_ids: [...spec.execution_gate.authorized_case_ids], spec_sha256: specHash },
      candidate_bundle_sha256: frozenBundleHash,
      case_id: scenario.case_id, scenario_spec_sha256: specHash, prompt_sha256: promptHash,
      development_case_result: !scenarioPromptIssued ? 'blocked-or-incomplete'
        : failed ? 'scenario-run-recorded-with-failures-or-unverified-criteria'
        : pluginBenefitCausal ? 'scenario-run-recorded-verifiers-pass'
          : 'scenario-run-recorded-verifiers-pass-plugin-benefit-not-measurable',
      benchmark_scenarios_executed: scenarioPromptIssued, scenario_prompt_issued: scenarioPromptIssued, score: null,
      plugin_orchestration_benefit: { status: pluginBenefitCausal ? 'causally-linked' : 'not-measurable',
        reason: pluginBenefitCausal ? null : specVersion >= 2
          ? 'No independently verified plugin task/artifact lineage connects durable plugin state to the scored workspace bytes or trace evidence.'
          : 'Current plugin SQLite export is not linked to the synthetic workspace artifacts that the independent verifiers score.' },
      note: 'No rubric score is assigned automatically. Review raw traces, independent checks, hard-fail events, and answer fidelity before scoring. A verifier pass alone does not prove plugin orchestration benefit.',
      conditions: conditionResults };
  } catch (error) {
    finalEvidence = { protocol: `cos-scenario-paired-v${specVersion}`, spec_version: specVersion, run_id: runId, captured_at: new Date().toISOString(),
      status: 'DEV_ONLY_NOT_ACCEPTANCE', dev_only_not_acceptance: true, official_acceptance_eligible: false,
      official_gate_modified: false, official_gate_snapshot: { spec_status: spec.status,
        execution_gate_status: spec.execution_gate.status, authorized_case_ids: [...spec.execution_gate.authorized_case_ids], spec_sha256: specHash },
      candidate_bundle_sha256: frozenBundleHash,
      case_id: scenario.case_id, scenario_spec_sha256: specHash, prompt_sha256: promptHash,
      development_case_result: 'blocked-or-incomplete', benchmark_scenarios_executed: scenarioPromptIssued, scenario_prompt_issued: scenarioPromptIssued,
      conditions_observed: Object.keys(conditionResults), failure: String(error?.message ?? error),
      conditions: conditionResults, evidence_directory: evidenceRoot,
      note: 'A failed/partial run must not be scored as pass; inspect any partial traces before retrying.' };
    process.exitCode = 1;
  } finally {
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    writeJson(output, finalEvidence);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ status: finalEvidence.status, development_case_result: finalEvidence.development_case_result,
    dev_only_not_acceptance: true, benchmark_scenarios_executed: finalEvidence.benchmark_scenarios_executed,
    case_id: scenario.case_id, evidence: output, trace_directory: evidenceRoot }, null, 2));
}

main().catch(error => { process.stderr.write(`${error?.stack ?? String(error)}\n`); process.exitCode = 1; });
