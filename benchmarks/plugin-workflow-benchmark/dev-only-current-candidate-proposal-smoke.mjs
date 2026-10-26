#!/usr/bin/env node
// Development-only native workflow_create smoke against an exact MCPB candidate.
// It can create at most one proposal in a private temporary DB. It never approves,
// dispatches, writes workspace files, executes tasks, or emits official benchmark evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { buildPluginSandboxLaunch } from './scenario-sandbox.mjs';
import { normalizeOllamaPluginTool } from './dev-ollama-schema-compat.mjs';
import { hasOnlySafeProposalArgumentKeys, validateSafeProposalArguments } from './dev-only-proposal-argument-guard.mjs';
import { fetchOllamaHttp } from './ollama-tool-loop.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const candidatePath = path.join(repo, 'artifacts/runalith-1.0.9-rc.5-candidate-latest-build-20261022T175328+0700.mcpb');
const expectedCandidateSha256 = '9d836dca9daec26b53a104f99028fb30fd11848e8c0a8764c4eb7dedd45e1c37';
const modelId = 'qwen3:4b-instruct';
const endpoint = 'http://127.0.0.1:11434/api/chat';
const evidenceRoot = path.join(repo, 'artifacts/phase1-dev-only');
const sha256 = value => createHash('sha256').update(value).digest('hex');

function writeExclusiveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const digest = sha256(fs.readFileSync(file));
  fs.writeFileSync(`${file}.sha256`, `${digest}  ${path.basename(file)}\n`, { flag: 'wx', mode: 0o600 });
  return digest;
}

function rpcClient(child, { timeoutMs = 10_000 } = {}) {
  let buffer = '';
  let stderr = '';
  let nextId = 0;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id === undefined || !pending.has(message.id)) continue;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  child.on('exit', code => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`isolated MCP server exited ${code}: ${stderr}`));
    }
    pending.clear();
  });
  return {
    stderr: () => stderr,
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP timeout for ${method}: ${stderr}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
  };
}

async function closeChild(child) {
  if (!child || child.exitCode !== null) return;
  child.stdin.end();
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 2_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function main() {
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex < 0 || !process.argv[outputIndex + 1]) {
    throw new Error('Usage: node dev-only-current-candidate-proposal-smoke.mjs --output artifacts/phase1-dev-only/<new-file>.json');
  }
  const outputPath = path.resolve(process.argv[outputIndex + 1]);
  assert.ok(outputPath.startsWith(`${evidenceRoot}${path.sep}`), `output must stay under ${evidenceRoot}`);
  assert.equal(fs.existsSync(outputPath), false, 'refusing to overwrite existing evidence');
  assert.equal(fs.existsSync(`${outputPath}.sha256`), false, 'refusing to overwrite existing evidence sidecar');
  assert.equal(fs.existsSync(`${outputPath}.evidence`), false, 'refusing to overwrite existing evidence directory');

  const candidateBytes = fs.readFileSync(candidatePath);
  const candidateSha256 = sha256(candidateBytes);
  assert.equal(candidateSha256, expectedCandidateSha256, 'exact candidate SHA-256 changed');
  const archiveIntegrity = execFileSync('/usr/bin/unzip', ['-t', candidatePath], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  assert.match(archiveIntegrity, /No errors detected/i, 'MCPB archive integrity check failed');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runalith-proposal-smoke-'));
  fs.chmodSync(tempRoot, 0o700);
  const extractedPlugin = path.join(tempRoot, 'plugin');
  const workspace = path.join(tempRoot, 'workspace');
  const dataDirectory = path.join(tempRoot, 'data');
  const executionTmpDirectory = path.join(tempRoot, 'execution-tmp');
  for (const directory of [extractedPlugin, workspace, dataDirectory, executionTmpDirectory]) {
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  let child;
  let dbAudit = null;
  let modelResponse = null;
  let modelRequest = null;
  let generatedArgs = null;
  let mcpToolResult = null;
  let createdJobId = null;
  let rpc = null;
  let mcpInitializeSucceeded = false;
  let toolsListed = 0;
  let sandboxPolicy = null;
  let failure = null;
  const capturedAt = new Date().toISOString();

  try {
    execFileSync('/usr/bin/unzip', ['-q', candidatePath, '-d', extractedPlugin], { stdio: 'pipe' });
    const manifestBytes = fs.readFileSync(path.join(extractedPlugin, 'manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    assert.equal(manifest.version, '1.0.9-rc.5');
    assert.equal(manifest.server?.entry_point, 'server/index.js');

    const sandbox = buildPluginSandboxLaunch({
      pluginRoot: extractedPlugin,
      workspace,
      dataDirectory,
      executionTmpDirectory,
      entryPoint: path.posix.join('/plugin', manifest.server.entry_point),
      memoryMax: '768M',
      cpuQuota: '100%',
      tasksMax: 64,
    });
    sandboxPolicy = sandbox.policy;
    child = spawn(sandbox.command, sandbox.args, {
      cwd: tempRoot, env: sandbox.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    rpc = rpcClient(child);

    const init = await rpc.call('initialize', {
      protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'runalith-dev-only-proposal-smoke', version: '1' },
    });
    assert.equal(init.error, undefined, `MCP initialize failed: ${JSON.stringify(init.error)}`);
    mcpInitializeSucceeded = true;
    const listed = await rpc.call('tools/list');
    assert.equal(listed.error, undefined, `MCP tools/list failed: ${JSON.stringify(listed.error)}`);
    assert.equal(listed.result.tools.length, 67, 'candidate must expose the pinned 67-tool manifest');
    toolsListed = listed.result.tools.length;
    const workflowCreate = listed.result.tools.find(tool => tool.name === 'workflow_create');
    assert.ok(workflowCreate?.inputSchema, 'workflow_create missing from exact candidate');
    const projection = normalizeOllamaPluginTool(workflowCreate);
    assert.equal(projection.metadata.compatibilityRule, 'workflow-create-minimal-string-fields-for-local-ollama-grammar');
    assert.deepEqual(Object.keys(projection.tool.function.parameters.properties), ['title', 'task', 'workspace', 'goal']);

    const dbPath = path.join(dataDirectory, 'workflow.db');
    assert.ok(fs.existsSync(dbPath), 'isolated candidate database was not initialized');
    const beforeDb = new DatabaseSync(dbPath, { readOnly: true });
    const baseline = {
      jobs: beforeDb.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,
      tasks: beforeDb.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,
      approvals: beforeDb.prepare('SELECT COUNT(*) AS n FROM approvals').get().n,
      workflowPlans: beforeDb.prepare('SELECT COUNT(*) AS n FROM workflow_plans').get().n,
      executionBatches: beforeDb.prepare('SELECT COUNT(*) AS n FROM execution_batches').get().n,
    };
    beforeDb.close();

    const systemPrompt = [
      'This is a development-only local MCPB smoke test. Create a workflow proposal only, using the one native tool provided.',
      'This call must persist a proposal only; it must not create tasks, write files, approve a workflow, dispatch a workflow, or execute anything.',
      'Use the exact existing sandbox workspace path /case/workspace.',
      'Do not request workspace.write, role bindings, validation profiles, success criteria, constraints, or any other optional structured settings.',
      'The task field must literally include the phrase "proposal-only", plus the exact phrases "do not execute" and "do not write files".',
      'Do not claim a proposal was created until the tool result is returned.',
    ].join(' ');
    const userPrompt = 'Make exactly one native workflow_create call now. Use a short title and a concise task about confirming this disposable local candidate can persist a proposal. In the task field, include the literal phrase "proposal-only; do not execute tasks; do not write files". Include workspace exactly /case/workspace. No approval or dispatch.';
    const modelTools = [projection.tool];
    modelRequest = {
      model: modelId, stream: false, think: false, parallel_tool_calls: false,
      options: { temperature: 0, num_ctx: 2048, num_predict: 256 },
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      tools: modelTools,
    };
    const modelRequestText = JSON.stringify(modelRequest);
    const modelStartedAt = Date.now();
    const response = await fetchOllamaHttp(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: modelRequestText, signal: AbortSignal.timeout(150_000),
    });
    const responseText = await response.text();
    modelResponse = {
      httpStatus: response.status,
      ok: response.ok,
      elapsedMs: Date.now() - modelStartedAt,
      responseSha256: sha256(responseText),
      rawText: responseText,
    };
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${responseText.slice(0, 500)}`);
    const parsed = JSON.parse(responseText);
    assert.equal(parsed.model, modelId, 'Ollama model identity mismatch');
    assert.equal(parsed.message?.role, 'assistant');
    const toolCalls = parsed.message?.tool_calls;
    assert.ok(Array.isArray(toolCalls), 'model did not emit native tool_calls');
    assert.equal(toolCalls.length, 1, 'only one native tool call is permitted for this smoke');
    assert.equal(toolCalls[0]?.function?.name, 'workflow_create', 'model requested a tool other than workflow_create');
    generatedArgs = toolCalls[0].function.arguments;
    validateSafeProposalArguments(generatedArgs);

    const responseFromTool = await rpc.call('tools/call', { name: 'workflow_create', arguments: generatedArgs });
    mcpToolResult = responseFromTool.result ?? responseFromTool.error;
    assert.equal(responseFromTool.error, undefined, `MCP RPC error: ${JSON.stringify(responseFromTool.error)}`);
    assert.notEqual(responseFromTool.result?.isError, true, `workflow_create returned isError: ${JSON.stringify(responseFromTool.result)}`);
    const structured = responseFromTool.result?.structuredContent;
    assert.equal(structured?.created, true, `workflow_create did not confirm proposal creation: ${JSON.stringify(responseFromTool.result)}`);
    assert.equal(structured?.requires_explicit_approval, true, 'candidate did not report separate explicit approval requirement');
    assert.equal(structured?.execution_authorized, undefined, 'unexpected execution authorization field in proposal result');
    assert.equal(structured?.workspace, '/case/workspace');
    createdJobId = structured.job_id;
    assert.equal(typeof createdJobId, 'string');
    assert.ok(createdJobId.length > 0);

    await closeChild(child);
    child = null;

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const job = db.prepare('SELECT job_id,title,state,status,approved_at,completed_at FROM jobs WHERE job_id=?').get(createdJobId);
      const taskCount = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE job_id=?').get(createdJobId).n;
      const approvalCount = db.prepare('SELECT COUNT(*) AS n FROM approvals WHERE job_id=?').get(createdJobId).n;
      const planCount = db.prepare('SELECT COUNT(*) AS n FROM workflow_plans WHERE job_id=?').get(createdJobId).n;
      const executionBatchCount = db.prepare('SELECT COUNT(*) AS n FROM execution_batches WHERE job_id=?').get(createdJobId).n;
      const events = db.prepare('SELECT type,payload_json FROM events WHERE job_id=? ORDER BY created_at ASC,rowid ASC').all(createdJobId);
      const eventTypes = events.map(event => event.type);
      const proposalEvent = events.find(event => event.type === 'job.proposal_requested');
      const proposalPayload = proposalEvent ? JSON.parse(proposalEvent.payload_json) : null;
      const forbiddenEventTypes = eventTypes.filter(type => /approve|dispatch|execution|task\.(?:created|started|completed)|workflow\.transition/i.test(type));
      dbAudit = {
        dbPath: '[private temporary database; removed after verification]',
        baseline,
        job,
        taskCount,
        approvalCount,
        planCount,
        executionBatchCount,
        eventTypes,
        proposalEventPayload: proposalPayload,
        forbiddenEventTypes,
        postconditions: {
          exactlyOneNewJob: db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n === baseline.jobs + 1,
          noNewTasks: db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n === baseline.tasks,
          noNewApprovals: db.prepare('SELECT COUNT(*) AS n FROM approvals').get().n === baseline.approvals,
          noNewWorkflowPlans: db.prepare('SELECT COUNT(*) AS n FROM workflow_plans').get().n === baseline.workflowPlans,
          noNewExecutionBatches: db.prepare('SELECT COUNT(*) AS n FROM execution_batches').get().n === baseline.executionBatches,
          jobExists: job?.job_id === createdJobId,
          approvalTimestampAbsent: job?.approved_at === null,
          noTasks: taskCount === 0,
          noApprovals: approvalCount === 0,
          noCompiledPlan: planCount === 0,
          noExecutionBatches: executionBatchCount === 0,
          proposalEventPresent: Boolean(proposalEvent),
          persistedWorkspaceIsSandbox: proposalPayload?.workspace === '/case/workspace',
          persistedWorkflowIsStandardEngineering: proposalPayload?.workflowId === 'standard-engineering',
          noApprovalDispatchOrExecutionEvents: forbiddenEventTypes.length === 0,
        },
      };
      assert.ok(Object.values(dbAudit.postconditions).every(Boolean), `isolated DB proposal postconditions failed: ${JSON.stringify(dbAudit.postconditions)}`);
      assert.ok(Array.isArray(eventTypes) && eventTypes.includes('job.proposal_requested'));
    } finally {
      db.close();
    }
  } catch (error) {
    failure = String(error?.stack ?? error?.message ?? error);
  } finally {
    await closeChild(child);
  }

  const baseEvidence = {
    protocol: 'runalith-dev-only-native-workflow-create-smoke@1',
    status: failure ? 'DEV_ONLY_PROPOSAL_SMOKE_FAILED' : 'DEV_ONLY_PROPOSAL_SMOKE_PASS',
    devOnlyNotAcceptance: true,
    officialAcceptanceEligible: false,
    officialPhase1GateModified: false,
    approved: false,
    dispatched: false,
    workflowTasksExecuted: false,
    capturedAt: new Date().toISOString(),
    startedAt: capturedAt,
    candidate: {
      path: path.relative(repo, candidatePath),
      sha256: candidateSha256,
      bytes: candidateBytes.length,
      archiveIntegrityPass: true,
      manifestSha256: sha256(manifestBytesFallback(candidatePath)),
      version: '1.0.9-rc.5',
      toolCount: 67,
    },
    environment: {
      osContainment: sandboxPolicy ?? sandboxEnvironmentDescriptor(),
      model: modelId,
      endpoint,
      networkPolicy: 'candidate server isolated in unshared network namespace; local Ollama request issued by host process to 127.0.0.1 only',
      workspace: 'private temporary directory mounted at /case/workspace',
      database: 'private temporary directory mounted at /case/data; removed after verification',
    },
    model: {
      requestSha256: modelRequest ? sha256(JSON.stringify(modelRequest)) : null,
      requestBytes: modelRequest ? Buffer.byteLength(JSON.stringify(modelRequest)) : null,
      modelResponse: modelResponse ? { ...modelResponse, elapsedMs: modelResponse.elapsedMs } : null,
      nativeToolCallName: generatedArgs ? 'workflow_create' : null,
      generatedArguments: generatedArgs,
      toolArgumentKeysAllowed: generatedArgs ? hasOnlySafeProposalArgumentKeys(generatedArgs) : false,
    },
    tool: {
      mcpInitializeSucceeded,
      toolsListed,
      modelVisibleSchemaCompatibility: modelRequest?.tools?.[0] ? {
        rule: 'workflow-create-minimal-string-fields-for-local-ollama-grammar',
        parameterSchemaSha256: sha256(JSON.stringify(modelRequest.tools[0].function.parameters)),
        parameterSchemaBytes: Buffer.byteLength(JSON.stringify(modelRequest.tools[0].function.parameters)),
        originalRuntimeSchemaWasNotModified: true,
      } : null,
      mcpToolResult,
      createdJobId,
      dbAudit,
    },
    failure,
  };

  let outputHash;
  try {
    outputHash = writeExclusiveJson(outputPath, baseEvidence);
    fs.writeFileSync(`${outputPath}.status`, `${baseEvidence.status}\n${outputHash}\n`, { flag: 'wx', mode: 0o600 });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ status: baseEvidence.status, output: outputPath, outputSha256: outputHash,
    candidateSha256, createdJobId, approvalCount: dbAudit?.approvalCount ?? null,
    taskCount: dbAudit?.taskCount ?? null, executionBatchCount: dbAudit?.executionBatchCount ?? null,
    failure }, null, 2));
  if (failure) process.exitCode = 1;
}

// The small helpers below make the provenance fields explicit, rather than
// trusting metadata copied from the candidate filename.
function manifestBytesFallback(file) {
  return execFileSync('/usr/bin/unzip', ['-p', file, 'manifest.json']);
}

function sandboxEnvironmentDescriptor() {
  return {
    launchMethod: 'bubblewrap+systemd-user-scope',
    unsharedNetworkNamespace: true,
    unsharedPidNamespace: true,
    pluginBundleReadOnly: true,
    hostHomeMounted: false,
    resourceLimits: { memoryMax: '768M', cpuQuota: '100%', tasksMax: 64 },
  };
}

main().catch(error => {
  console.error(String(error?.stack ?? error?.message ?? error));
  process.exitCode = 1;
});
