#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchAdaptiveGoalGraph } from '../../src/runtime/adaptive-goal-graph.js';
import { computeTaskOracle, verifySelectedPath } from './oracle.mjs';
import { pairedOutcomeAnalysis } from './phase1-statistics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DEFAULT_INPUT = path.join(ROOT, 'artifacts/phase1-benchmark-raw-20261022T1024Z.json');
const DEFAULT_MODEL = 'qwen3:4b-instruct';
const LOCAL_API = 'http://127.0.0.1:11434';
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['solution', 'no_solution'] },
    path: { type: 'array', items: { type: 'string' } }
  },
  required: ['status', 'path'],
  additionalProperties: false
};

function sha256(input) { return crypto.createHash('sha256').update(input).digest('hex'); }
function validateLoopbackEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('--endpoint must be a valid local HTTP URL'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('--endpoint must be an HTTP URL on literal localhost, 127.0.0.1 or ::1, without path/query/credentials');
  }
  if (!url.port || !Number.isInteger(Number(url.port)) || Number(url.port) < 1 || Number(url.port) > 65535) {
    throw new Error('--endpoint must specify an explicit valid loopback port');
  }
  return url.origin;
}
function parseArgs(argv) {
  const args = { input: DEFAULT_INPUT, model: DEFAULT_MODEL, endpoint: LOCAL_API, limit: null, timeoutMs: 240_000, output: null, report: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--help') {
      process.stdout.write('Usage: node benchmarks/adaptive-goal-graph/run-local-llm-phase1-benchmark.mjs --output NEW.json [--report NEW.md] [--input RAW.json] [--limit N] [--model NAME] [--timeout-ms N] [--endpoint http://127.0.0.1:11434]\n\nUses only an HTTP service on a literal loopback address; --endpoint exists for isolated local mock tests. Runs chain-style and one-shot ToT-style prompts plus AGG beam-4 on the same graph-only task input. Oracle metadata is excluded from prompts and used only for scoring. Existing output files are never overwritten.\n');
      process.exit(0);
    }
    if (!['--input', '--output', '--report', '--limit', '--model', '--timeout-ms', '--endpoint'].includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error(`Invalid or missing CLI argument: ${key}`);
    }
    const value = argv[++i];
    if (key === '--input') args.input = path.resolve(value);
    else if (key === '--output') args.output = path.resolve(value);
    else if (key === '--report') args.report = path.resolve(value);
    else if (key === '--model') args.model = value;
    else if (key === '--endpoint') args.endpoint = validateLoopbackEndpoint(value);
    else if (key === '--limit') args.limit = Number(value);
    else if (key === '--timeout-ms') args.timeoutMs = Number(value);
  }
  if (!args.output) throw new Error('--output NEW.json is required (exclusive create; no overwrite)');
  if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 28)) throw new Error('--limit must be an integer from 1 through 28');
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1000 || args.timeoutMs > 600_000) throw new Error('--timeout-ms must be between 1000 and 600000');
  if (path.resolve(args.input) === args.output || args.input === args.report || args.output === args.report) throw new Error('input/output/report paths must be distinct');
  return args;
}

async function localJson(endpoint, body, timeoutMs = 10_000, baseUrl = LOCAL_API) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Local Ollama ${endpoint} returned HTTP ${response.status}`);
  try { return JSON.parse(text); } catch { throw new Error(`Local Ollama ${endpoint} returned malformed JSON`); }
}

function makePrompt(graph, mode, index) {
  const role = mode === 'llm-chain'
    ? 'Use a direct chain-style planning approach: follow one candidate route from start to goal and check its constraints.'
    : 'Use a one-shot Tree-of-Thoughts-style approach: internally compare up to three candidate routes, reject routes that break graph constraints, and return the best remaining route. This is one model call, not a multi-round search.';
  // Route selection does not require numeric scoring metadata. Keep graph
  // topology, labels and evidence refs, but exclude caller estimates and every
  // oracle/scoring field to reduce prompt length and prevent answer leakage.
  const compactGraph = {
    schemaVersion: graph.schemaVersion,
    startNodeId: graph.startNodeId,
    goalNodeId: graph.goalNodeId,
    nodes: graph.nodes.map(({ id, type, label, evidenceRefs }) => ({
      id, type, ...(label === undefined ? {} : { label }), ...(evidenceRefs?.length ? { evidenceRefs } : {})
    })),
    edges: graph.edges.map(({ from, to, type }) => ({ from, to, type }))
  };
  return `You are a constrained graph planner. ${role}
Rules:
- The graph is the complete task input. Only next_step and enables edges are nominal route transitions.
- requires_all means every edge.from node must appear before edge.to; depends_on means edge.to must appear before edge.from.
- Never use recovers_to as a nominal transition.
- Nodes joined by contradicts or alternative_to cannot coexist on the route.
- A solution starts at startNodeId, ends at goalNodeId, uses existing node IDs, never repeats a node and obeys all prerequisites/conflicts.
- Cover the necessary evidenceRefs from appropriate source-inspection nodes. Do not invent IDs. If no valid route exists, return status=no_solution and path=[].
- Output only JSON with exactly two fields: status (solution or no_solution) and path (array of node IDs). Do not output intermediate reasoning.
Task ${index + 1}. Graph JSON:
${JSON.stringify(compactGraph)}`;
}

function parseFinalResponse(data) {
  const response = typeof data.response === 'string' ? data.response.trim() : '';
  const finalText = response.includes('</think>') ? response.slice(response.lastIndexOf('</think>') + '</think>'.length).trim() : response;
  let answer = null;
  let parseFailure = null;
  try { answer = JSON.parse(finalText); } catch { parseFailure = 'invalid_json'; }
  if (!answer || typeof answer !== 'object' || Array.isArray(answer) ||
      Object.keys(answer).sort().join(',') !== 'path,status' ||
      !['solution', 'no_solution'].includes(answer.status) || !Array.isArray(answer.path) ||
      answer.path.some(id => typeof id !== 'string')) {
    return { answer: null, parseFailure: parseFailure || 'schema_mismatch', outputSha256: sha256(finalText) };
  }
  return { answer, parseFailure: null, outputSha256: sha256(finalText) };
}

function scoreAnswer(task, oracle, parsed) {
  const answer = parsed.answer;
  const pathCheck = answer?.status === 'solution'
    ? verifySelectedPath(task, answer.path)
    : { valid: false, reasons: answer?.status === 'no_solution' ? ['model_claimed_no_solution'] : ['missing_or_invalid_answer'] };
  const validSolution = answer?.status === 'solution' && pathCheck.valid;
  const correctNoSolution = answer?.status === 'no_solution' && oracle.outcome === 'no_solution' && oracle.validPathCount === 0 && oracle.exhaustive;
  const correct = oracle.outcome === 'solution' ? validSolution : correctNoSolution;
  const outcomeCheck = answer?.status === 'no_solution'
    ? { valid: correctNoSolution, reasons: correctNoSolution ? [] : ['model_claimed_no_solution'] }
    : pathCheck;
  return {
    answerFormatValid: answer !== null,
    answerStatus: answer?.status ?? null,
    pathNodeIds: answer?.path ?? [],
    outputSha256: parsed.outputSha256,
    parseFailure: parsed.parseFailure,
    validSolution,
    correctNoSolution,
    taskOutcomeCorrect: correct,
    pathValidation: outcomeCheck,
    oracleOutcome: oracle.outcome,
    oracleValidPathCount: oracle.validPathCount
  };
}

function mean(values) { return values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : null; }
function completeSum(values) { return values.length && values.every(Number.isFinite) ? values.reduce((sum, n) => sum + n, 0) : null; }
function completeMean(values) { return values.length && values.every(Number.isFinite) ? mean(values) : null; }
function percentile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}
function summarize(records) {
  const methods = [...new Set(records.map(row => row.method))];
  return methods.map(method => {
    const rows = records.filter(row => row.method === method);
    const modelRows = rows.filter(row => row.method !== 'agg-beam:4');
    const validRouteCosts = rows.filter(row => row.validSolution && row.estimatedPathCost !== null).map(row => row.estimatedPathCost);
    const latencies = rows.map(row => row.runtimeMs).filter(Number.isFinite);
    return {
      method,
      tasks: rows.length,
      taskOutcomeAccuracy: mean(rows.map(row => row.taskOutcomeCorrect ? 1 : 0)),
      validSolutionRateOnSolvableTasks: mean(rows.filter(row => row.oracleOutcome === 'solution').map(row => row.validSolution ? 1 : 0)),
      correctNoSolutionRate: mean(rows.filter(row => row.oracleOutcome === 'no_solution').map(row => row.correctNoSolution ? 1 : 0)),
      validSolutionCount: rows.filter(row => row.validSolution).length,
      formatFailureCount: rows.filter(row => row.answerFormatValid === false).length,
      meanEstimatedPathCost: mean(validRouteCosts),
      meanRuntimeMs: mean(latencies),
      p95RuntimeMs: percentile(latencies, 0.95),
      totalPromptTokens: completeSum(modelRows.map(row => row.promptEvalCount)),
      totalOutputTokens: completeSum(modelRows.map(row => row.outputEvalCount)),
      meanPromptTokens: completeMean(modelRows.map(row => row.promptEvalCount)),
      meanOutputTokens: completeMean(modelRows.map(row => row.outputEvalCount)),
      meanModelTotalDurationMs: modelRows.length ? mean(modelRows.map(row => row.modelTotalDurationMs || 0)) : null,
      meanModelPromptEvalDurationMs: modelRows.length ? mean(modelRows.map(row => row.modelPromptEvalDurationMs || 0)) : null,
      meanModelOutputEvalDurationMs: modelRows.length ? mean(modelRows.map(row => row.modelOutputEvalDurationMs || 0)) : null
    };
  });
}

function makeReport(result) {
  const lines = [
    '# Local LLM graph-selection benchmark (supplemental; not acceptance sign-off)', '',
    `- Protocol: ${result.protocol}`, `- Model: ${result.model.name} (${result.model.digest})`,
    `- Local inference engine: Ollama ${result.ollamaVersion}`, `- Endpoint: \`${result.endpoint}\``, `- Input SHA-256: ${result.inputSha256}`,
    `- Tasks per method: ${result.taskCount}`, `- Model calls attempted: ${result.modelCalls}; local HTTP requests: ${result.localHttpRequests}; remote network calls: ${result.externalNetworkCalls}`,
    '- Prompt exposure: each model receives only the graph topology, node types/labels and evidence reference labels (estimated metric values are omitted). Oracle answers, expected paths, required-stage sets, forbidden-node lists and scoring metadata are not in the prompt.',
    '- Disclosure: `llm-tot-prompted` is a one-shot ToT-style prompt, not a canonical multi-call ToT implementation. The AGG / LLM comparison selects from a supplied graph, so it does not measure model-driven Idea Graph generation or total end-to-end task cost.',
    '- Costs: token counts are the local model engine’s prompt/output tokens. `meanEstimatedPathCost` is only a synthetic caller-estimate sum, not monetary cost. No USD value is inferred.', '',
    '| Method | Correct task outcomes | Valid solutions (solvable tasks) | Correct no-solution | Format failures | Mean prompt tokens | Mean output tokens | Mean estimated path cost* | Mean end-to-end latency (ms) | P95 latency (ms) |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
  ];
  for (const row of result.summaries) {
    lines.push(`| ${row.method} | ${(100 * row.taskOutcomeAccuracy).toFixed(1)}% | ${(100 * row.validSolutionRateOnSolvableTasks).toFixed(1)}% | ${row.correctNoSolutionRate == null ? 'n/a' : `${(100 * row.correctNoSolutionRate).toFixed(1)}%`} | ${row.formatFailureCount} | ${row.meanPromptTokens ?? 'n/a'} | ${row.meanOutputTokens ?? 'n/a'} | ${row.meanEstimatedPathCost?.toFixed(4) ?? 'n/a'} | ${row.meanRuntimeMs?.toFixed(2) ?? 'n/a'} | ${row.p95RuntimeMs?.toFixed(2) ?? 'n/a'} |`);
  }
  lines.push('', '## Paired outcomes', '',
    '| Contrast (A − B) | Matched graph instances | Both correct | Only A correct | Only B correct | Both incorrect | Success-rate difference | Family-cluster bootstrap 95% CI | Family clusters |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of result.inference.pairedSuccessComparisons) {
    lines.push(`| ${row.methodA} − ${row.methodB} | ${row.pairedTaskInstances} | ${row.contingency.bothCorrect} | ${row.contingency.aOnlyCorrect} | ${row.contingency.bOnlyCorrect} | ${row.contingency.bothIncorrect} | ${row.pairedSuccessRateDifferenceAminusB} | [${row.bootstrap95PercentileCI.join(', ')}] | ${row.independentTaskFamilyClusters} |`);
  }
  lines.push('', '* Only valid selected solution paths contribute to estimated path cost. Synthetic estimates are uncalibrated and should not be read as currency. Actual model token counts are provider-reported; USD costs are not measured.', '',
    '## Per-run records', '', 'See the raw JSON ledger for each graph hash, prompt hash, independent oracle outcome, validation reasons, path IDs, prompt/output token counts and inference durations. Chain-of-thought / model thinking text is deliberately not retained.', '',
    '## Acceptance interpretation', '',
    'This is supplemental evidence only. It cannot replace the frozen protocol, the wider representative task corpus, independent approval, or real operational A/B measurement. A higher graph-selection rate alone is not enough if cost and latency do not improve; the task graph is already supplied to all methods here. The local model is sampled once per task template and seven families are still a small cluster count; intervals are exploratory and not a basis for statistical acceptance.', '');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.output.startsWith(`${ROOT}${path.sep}`) || (args.report && !args.report.startsWith(`${ROOT}${path.sep}`))) {
    throw new Error('Output artifacts must stay within the repository (artifacts/ is recommended)');
  }
  for (const destination of [args.output, args.report].filter(Boolean)) {
    if (path.relative(ROOT, destination).split(path.sep)[0] === 'dist') throw new Error('benchmark outputs must not be written to dist/');
  }
  const manifestPath = `${args.output}.manifest.json`;
  const partialPath = `${args.output}.partial.jsonl`;
  const partialManifestPath = `${args.output}.partial.manifest.json`;
  for (const destination of [args.output, args.report, manifestPath, partialPath, partialManifestPath].filter(Boolean)) {
    if (fs.existsSync(destination) || fs.existsSync(`${destination}.partial.jsonl`)) throw new Error(`Refusing to overwrite existing output: ${destination}`);
  }
  const inputBytes = fs.readFileSync(args.input);
  const input = JSON.parse(inputBytes.toString('utf8'));
  if (!Array.isArray(input.taskCatalog) || input.taskCatalog.length !== 28 || ![4, 5].includes(input.schemaVersion)) {
    throw new Error('Input must be a schema-v4/v5, 28-task Phase 1 catalog-backed raw ledger');
  }
  const tasks = args.limit ? input.taskCatalog.slice(0, args.limit) : input.taskCatalog;
  const [ollamaVersion, tags] = await Promise.all([
    localJson('/api/version', undefined, 10_000, args.endpoint),
    localJson('/api/tags', undefined, 10_000, args.endpoint)
  ]);
  const modelInfo = tags.models?.find(item => item.name === args.model || item.model === args.model);
  if (!modelInfo) throw new Error(`Requested local model is not present in Ollama tags: ${args.model}`);
  const progressPath = partialPath;
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  const progressFd = fs.openSync(progressPath, 'wx', 0o600);
  let progressOpen = true;
  const startedAt = new Date().toISOString();
  const records = [];
  const runnerPath = fileURLToPath(import.meta.url);
  const oraclePath = path.join(HERE, 'oracle.mjs');
  const graphRuntimePath = path.join(ROOT, 'src/runtime/adaptive-goal-graph.js');
  const sourceHashes = {
    runnerSha256: sha256(fs.readFileSync(runnerPath)),
    oracleSha256: sha256(fs.readFileSync(oraclePath)),
    graphRuntimeSha256: sha256(fs.readFileSync(graphRuntimePath)),
    inputLedgerSha256: sha256(inputBytes)
  };
  const realizedDataset = tasks.map(task => ({
    taskId: task.id, familyId: task.familyId, variant: task.variant, seed: task.seed,
    expectedOutcome: task.expectedOutcome, graph: task.graph,
    requiredEvidenceRefs: task.requiredEvidenceRefs, requiredStageNodeIds: task.requiredStageNodeIds,
    acceptableRouteStageSets: task.acceptableRouteStageSets, forbiddenNodeIds: task.forbiddenNodeIds
  }));
  const datasetSha256 = sha256(JSON.stringify(realizedDataset));
  const modelOptions = { temperature: 0, seed: 20261022, num_predict: 256, num_ctx: 4096, thinkingEnabled: true };
  const modelConfiguration = {
    protocol: 'agg-local-llm-graph-selection@1',
    provider: 'ollama-local', providerVersion: ollamaVersion.version,
    modelName: modelInfo.name, modelDigest: modelInfo.digest,
    endpoint: args.endpoint, endpointHost: new URL(args.endpoint).hostname,
    promptStrategy: 'graph-only; chain style and one-shot ToT-style; oracle fields excluded from prompt',
    modelOptions, outputSchema: OUTPUT_SCHEMA, timeoutMs: args.timeoutMs,
    taskIds: tasks.map(task => task.id), datasetSha256,
    retryPolicy: 'no retries; one /api/generate attempt per model trial',
    budget: { modelCallsPerTask: 2, toolCallsPerTask: 0, maxOutputTokens: 256, requestTimeoutMs: args.timeoutMs }
  };
  const configurationSha256 = sha256(JSON.stringify(modelConfiguration));
  const sourceSetSha256 = sha256(JSON.stringify(sourceHashes));
  const provenance = {
    schemaVersion: 1, protocol: 'agg-local-llm-graph-selection@1', startedAt,
    inputSchemaVersion: input.schemaVersion,
    model: { name: modelInfo.name, digest: modelInfo.digest, sizeBytes: modelInfo.size, details: modelInfo.details },
    ollamaVersion: ollamaVersion.version, endpoint: args.endpoint, inputPath: path.relative(ROOT, args.input), inputSha256: sha256(inputBytes),
    promptStrategy: 'graph-only; chain style and one-shot ToT style share output schema, temperature, seed, output cap and model; fixed catalog graph tasks only',
    modelOptions, modelConfiguration, configurationSha256,
    datasetSha256, sourceSetSha256, graderSha256: sourceHashes.oracleSha256,
    sourceHashes,
    sourcePaths: {
      runner: path.relative(ROOT, runnerPath),
      oracle: path.relative(ROOT, oraclePath),
      graphRuntime: path.relative(ROOT, graphRuntimePath)
    },
    datasetDesign: {
      taskTemplates: tasks.length,
      independentTaskFamilyClusters: new Set(tasks.map(task => task.familyId)).size,
      repeatSeedsPerTemplate: 1,
      taskRole: 'selected synthetic development fixtures from the frozen 28-template catalog; not an approved holdout',
      holdout: 'not used or claimed',
      inputScope: 'complete graph is preconstructed and provided; graph-generation cost is excluded',
      modelCallsPerTask: 2,
      toolCallsPerTask: 0,
      retryPolicy: 'no retries; provider failure is persisted in JSONL and stops the run',
      timeoutMs: args.timeoutMs
    },
    localOnly: true, endpointHost: new URL(args.endpoint).hostname, modelThinkingTextPersisted: false, taskCount: tasks.length
  };
  const writeProgress = value => fs.writeSync(progressFd, `${JSON.stringify(value)}\n`);
  const describeFile = filePath => ({
    path: path.relative(ROOT, filePath),
    sha256: sha256(fs.readFileSync(filePath)),
    bytes: fs.statSync(filePath).size
  });
  writeProgress({ type: 'run_started', ...provenance });
  try {
    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
      const task = tasks[taskIndex];
      const oracle = computeTaskOracle(task);
      if (oracle.outcome !== task.expectedOutcome) throw new Error(`Independent oracle disagrees with frozen fixture for ${task.id}`);
      const graphHash = task.graph.graphHash || sha256(JSON.stringify(task.graph));
      for (const method of ['llm-chain', 'llm-tot-prompted']) {
        const taskInstanceId = `${task.id}::catalog-seed-${input.catalogSeed}`;
        const prompt = makePrompt(task.graph, method, taskIndex);
        const promptSha256 = sha256(prompt);
        const start = process.hrtime.bigint();
        let data;
        try {
          data = await localJson('/api/generate', {
            model: args.model, prompt, stream: false, think: true, format: OUTPUT_SCHEMA,
            options: { temperature: 0, seed: 20261022, num_predict: 256, num_ctx: 4096 }
          }, args.timeoutMs, args.endpoint);
        } catch (error) {
          const runtimeMs = Number((Number(process.hrtime.bigint() - start) / 1e6).toFixed(3));
          const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
          const failedRecord = {
            taskId: task.id, taskTemplateId: task.id, taskInstanceId,
            trialId: `${taskInstanceId}::${method}`, methodKey: method, trialKind: 'single_model_trial_per_frozen_template',
            familyId: task.familyId, variant: task.variant, iteration: 1, method,
            taskFamily: task.familyId, taskSeed: task.seed, seed: task.seed, expectedOutcome: oracle.outcome,
            configurationSha256, datasetSha256, sourceSetSha256, graderSha256: sourceHashes.oracleSha256,
            budget: { requestTimeoutMs: args.timeoutMs, numPredict: 256, maxModelCalls: 1, maxToolCalls: 0, retryBudget: 0 },
            inputGraphSha256: graphHash, promptSha256,
            provider: 'ollama-local', providerVersion: ollamaVersion.version,
            modelName: modelInfo.name, modelDigest: modelInfo.digest,
            attemptCount: 1, retryCount: 0, retryBudget: 0, trialExitCode: 1,
            trialError: { name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 1000) },
            timedOut: timeout, status: 'failed', answerStatus: 'unknown', taskOutcomeCorrect: null,
            validSolution: false, pathNodeIds: [], runtimeMs,
            modelCallAttempts: 1, promptEvalCount: null, outputEvalCount: null,
            tokenCost: null, monetaryCost: null,
            costStatus: 'NOT_AVAILABLE_FOR_FAILED_CALL',
            failurePolicy: 'fail-fast, no retry; persist this failure in partial JSONL and stop the run'
          };
          records.push(failedRecord);
          writeProgress({ type: 'run_failure', record: failedRecord });
          throw new Error(`Model trial failed for ${task.id}/${method}; recorded in partial JSONL (${timeout ? 'timeout' : 'call_error'}, no retries): ${failedRecord.trialError.message}`);
        }
        const runtimeMs = Number(process.hrtime.bigint() - start) / 1e6;
        const parsed = parseFinalResponse(data);
        const scored = scoreAnswer(task, oracle, parsed);
        const record = {
          taskId: task.id, taskTemplateId: task.id, taskInstanceId,
          trialId: `${taskInstanceId}::${method}`, methodKey: method, trialKind: 'single_model_trial_per_frozen_template',
          familyId: task.familyId, variant: task.variant, iteration: 1, method,
          taskFamily: task.familyId, taskSeed: task.seed, seed: task.seed, expectedOutcome: oracle.outcome,
          configurationSha256, datasetSha256, sourceSetSha256, graderSha256: sourceHashes.oracleSha256,
          budget: { requestTimeoutMs: args.timeoutMs, numPredict: 256, maxModelCalls: 1, maxToolCalls: 0, retryBudget: 0 },
          provider: 'ollama-local', providerVersion: ollamaVersion.version,
          modelName: modelInfo.name, modelDigest: modelInfo.digest,
          attemptCount: 1, retryCount: 0, retryBudget: 0, trialExitCode: 0, trialError: null, timedOut: false,
          status: 'completed', modelCallAttempts: 1,
          inputGraphSha256: graphHash, promptSha256, ...scored,
          runtimeMs: Number(runtimeMs.toFixed(3)), promptEvalCount: Number.isFinite(data.prompt_eval_count) ? data.prompt_eval_count : null,
          outputEvalCount: Number.isFinite(data.eval_count) ? data.eval_count : null,
          modelTotalDurationMs: Number.isFinite(data.total_duration) ? Number((data.total_duration / 1e6).toFixed(3)) : null,
          modelLoadDurationMs: Number.isFinite(data.load_duration) ? Number((data.load_duration / 1e6).toFixed(3)) : null,
          modelPromptEvalDurationMs: Number.isFinite(data.prompt_eval_duration) ? Number((data.prompt_eval_duration / 1e6).toFixed(3)) : null,
          modelOutputEvalDurationMs: Number.isFinite(data.eval_duration) ? Number((data.eval_duration / 1e6).toFixed(3)) : null,
          oracleExpandedEdges: oracle.oracleExpandedEdges,
          tokenCost: null, monetaryCost: null, costStatus: 'NOT_MEASURED_LOCAL_INFERENCE'
        };
        record.estimatedPathCost = scored.validSolution
          ? Number(scored.pathNodeIds.slice(1).reduce((sum, id) => sum + (task.graph.nodes.find(node => node.id === id)?.estimatedCost ?? 0), 0).toFixed(4))
          : null;
        // Do not persist raw prompts, generated answer text, or thinking traces.
        records.push(record);
        writeProgress({ type: 'run_record', record });
        process.stdout.write(`LOCAL_LLM_PHASE1 task=${taskIndex + 1}/${tasks.length} method=${method} correct=${record.taskOutcomeCorrect} valid=${record.validSolution} tokens=${record.promptEvalCount ?? '?'}+${record.outputEvalCount ?? '?'} latency_ms=${record.runtimeMs.toFixed(1)}\n`);
      }
      const aggStart = process.hrtime.bigint();
      const agg = searchAdaptiveGoalGraph(task.graph, { maxDepth: 10, maxExpansions: 80, beamWidth: 4, maxAuditEvents: 100 });
      const aggRuntimeMs = Number(process.hrtime.bigint() - aggStart) / 1e6;
      const aggPath = agg.candidates[0]?.pathNodeIds ?? agg.bestPartialCandidates[0]?.pathNodeIds ?? [];
      const aggCheck = agg.candidates.length ? verifySelectedPath(task, aggPath) : { valid: false, reasons: ['no_complete_candidate'] };
      const aggCorrectNoSolution = agg.status === 'no_solution_found' && agg.search.exhaustive === true && oracle.outcome === 'no_solution' && oracle.validPathCount === 0;
      const aggValid = agg.candidates.length > 0 && aggCheck.valid;
      const taskInstanceId = `${task.id}::catalog-seed-${input.catalogSeed}`;
      const aggRecord = {
        taskId: task.id, taskTemplateId: task.id, taskInstanceId,
        trialId: `${taskInstanceId}::agg-beam:4`, methodKey: 'agg-beam:4', trialKind: 'algorithmic_comparator_trial',
        familyId: task.familyId, variant: task.variant, iteration: 1, method: 'agg-beam:4',
        taskFamily: task.familyId, taskSeed: task.seed, seed: task.seed, expectedOutcome: oracle.outcome,
        configurationSha256, datasetSha256, sourceSetSha256, graderSha256: sourceHashes.oracleSha256,
        inputGraphSha256: graphHash, budget: { maxDepth: 10, maxExpansions: 80, maxModelCalls: 0, maxToolCalls: 0, retryBudget: 0 },
        provider: null, providerVersion: null, modelName: null, modelDigest: null,
        attemptCount: 1, retryCount: 0, retryBudget: 0, trialExitCode: 0, trialError: null, timedOut: false,
        status: 'completed',
        inputGraphSha256: graphHash, promptSha256: null, answerFormatValid: true,
        answerStatus: aggValid ? 'solution' : aggCorrectNoSolution ? 'no_solution' : agg.status,
        pathNodeIds: aggPath, outputSha256: null, parseFailure: null, validSolution: aggValid,
        correctNoSolution: aggCorrectNoSolution, taskOutcomeCorrect: oracle.outcome === 'solution' ? aggValid : aggCorrectNoSolution,
        pathValidation: aggValid ? aggCheck : aggCorrectNoSolution ? { valid: true, reasons: [] } : aggCheck,
        oracleOutcome: oracle.outcome, oracleValidPathCount: oracle.validPathCount,
        runtimeMs: Number(aggRuntimeMs.toFixed(3)), expansionCount: agg.search.expansions,
        budgetExhausted: agg.status === 'budget_exhausted', exhaustive: agg.search.exhaustive,
        estimatedPathCost: aggValid ? Number(aggPath.slice(1).reduce((sum, id) => sum + (task.graph.nodes.find(node => node.id === id)?.estimatedCost ?? 0), 0).toFixed(4)) : null,
        oracleExpandedEdges: oracle.oracleExpandedEdges
      };
      records.push(aggRecord);
      writeProgress({ type: 'run_record', record: aggRecord });
    }
    const pairedSuccessComparisons = [
      pairedOutcomeAnalysis(records, 'llm-chain', 'agg-beam:4', { bootstrapSeed: 992201, bootstrapSamples: 10_000 }),
      pairedOutcomeAnalysis(records, 'llm-tot-prompted', 'agg-beam:4', { bootstrapSeed: 992202, bootstrapSamples: 10_000 })
    ];
    const modelCalls = records.reduce((sum, row) => sum + (Number.isInteger(row.modelCallAttempts) ? row.modelCallAttempts : 0), 0);
    const modelRows = records.filter(row => row.method !== 'agg-beam:4');
    const inputTokens = completeSum(modelRows.map(row => row.promptEvalCount));
    const outputTokens = completeSum(modelRows.map(row => row.outputEvalCount));
    const result = {
      ...provenance, completedAt: new Date().toISOString(), decision: 'SUPPLEMENTAL_EVIDENCE_NOT_ACCEPTANCE',
      taskIds: tasks.map(task => task.id), taskCount: tasks.length,
      methods: ['llm-chain', 'llm-tot-prompted', 'agg-beam:4'], records, summaries: summarize(records),
      modelCalls, modelCallFailures: records.filter(row => row.method !== 'agg-beam:4' && row.trialExitCode !== 0).length,
      localHttpRequests: 2 + modelCalls, externalNetworkCalls: 0, toolCalls: 0,
      measuredInputTokens: inputTokens, measuredOutputTokens: outputTokens,
      tokenMeasurementCompleteness: {
        modelTrialCount: modelRows.length,
        inputTokenCountsReported: modelRows.filter(row => Number.isFinite(row.promptEvalCount)).length,
        outputTokenCountsReported: modelRows.filter(row => Number.isFinite(row.outputEvalCount)).length
      },
      tokenCost: null, monetaryCost: null, monetaryCostStatus: 'NOT_MEASURED_NO_VERIFIED_PRICE_SOURCE',
      costAccounting: 'model durations and token counts use local provider response fields; no USD/service price was applied; failed calls remain charged as latency and call attempts with unknown token usage',
      inference: { pairedSuccessComparisons },
      caveats: [
        'Synthetic graph tasks only; seven family clusters do not establish production representativeness.',
        'LLM tasks receive a complete, pre-generated graph; this does not measure LLM idea-graph creation or end-to-end orchestration.',
        'One-shot ToT-style prompting is not a multi-call canonical ToT search implementation.',
        'Estimated path cost values are uncalibrated caller estimates, not token cost or USD.',
        'One model trial per task template and only seven task-family clusters mean the paired intervals are exploratory; power-based sample size is not estimated.',
        'Independent oracle validates graph/path constraints and required declared evidence refs, not external truth of claims.',
        'The operational plugin_enabled/basic_tools Phase 1 benchmark and production reviewer/trust gates remain separate.'
      ]
    };
    result.configuration = modelConfiguration;
    const raw = `${JSON.stringify(result, null, 2)}\n`;
    const report = args.report ? makeReport(result) : null;
    const outFd = fs.openSync(args.output, 'wx', 0o600);
    try { fs.writeFileSync(outFd, raw, 'utf8'); } finally { fs.closeSync(outFd); }
    if (args.report) {
      const reportFd = fs.openSync(args.report, 'wx', 0o600);
      try { fs.writeFileSync(reportFd, report, 'utf8'); } finally { fs.closeSync(reportFd); }
    }
    writeProgress({ type: 'run_completed', completedAt: result.completedAt, records: records.length, outputSha256: sha256(raw), decision: result.decision });
    fs.closeSync(progressFd);
    progressOpen = false;
    const manifest = {
      manifestSchemaVersion: 1,
      runId: `agg-local-llm-${sha256(`${startedAt}|${raw}`).slice(0, 24)}`,
      startedAt,
      completedAt: result.completedAt,
      status: 'COMPLETE',
      exitCode: 0,
      decision: 'SUPPLEMENTAL_EVIDENCE_NOT_ACCEPTANCE',
      command: [process.execPath, ...process.argv.slice(1)],
      nodeVersion: process.version,
      protocol: result.protocol,
      model: result.model,
      counts: {
        taskTemplates: result.taskCount,
        taskFamilyClusters: result.datasetDesign.independentTaskFamilyClusters,
        records: result.records.length,
        modelCalls: result.modelCalls,
        modelCallFailures: result.modelCallFailures,
        localHttpRequests: result.localHttpRequests,
        toolCalls: result.toolCalls
      },
      hashes: {
        rawSha256: sha256(Buffer.from(raw)),
        configurationSha256,
        datasetSha256,
        sourceSetSha256,
        graderSha256: sourceHashes.oracleSha256,
        inputLedgerSha256: sourceHashes.inputLedgerSha256
      },
      outputs: {
        raw: describeFile(args.output),
        ...(args.report ? { report: describeFile(args.report) } : {})
      },
      provenance: { ...provenance, records: undefined }
    };
    const manifestFd = fs.openSync(manifestPath, 'wx', 0o600);
    try { fs.writeFileSync(manifestFd, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'); } finally { fs.closeSync(manifestFd); }
    fs.unlinkSync(progressPath);
    process.stdout.write(`LOCAL_LLM_PHASE1=COMPLETE records=${records.length} tasks=${tasks.length} raw=${args.output}\n`);
    if (args.report) process.stdout.write(`report=${args.report}\n`);
    process.stdout.write(`${JSON.stringify(result.summaries, null, 2)}\n`);
  } catch (error) {
    if (progressOpen) {
      fs.closeSync(progressFd);
      progressOpen = false;
    }
    try {
      const partialBytes = fs.existsSync(progressPath) ? fs.readFileSync(progressPath) : Buffer.alloc(0);
      const events = partialBytes.toString('utf8').split(/\r?\n/).filter(Boolean);
      const manifest = {
        manifestSchemaVersion: 1,
        runId: `agg-local-llm-incomplete-${sha256(`${startedAt}|${partialBytes}`).slice(0, 24)}`,
        startedAt,
        failedAt: new Date().toISOString(),
        status: 'INCOMPLETE',
        exitCode: 1,
        decision: 'INCOMPLETE_NOT_ACCEPTANCE',
        command: [process.execPath, ...process.argv.slice(1)],
        nodeVersion: process.version,
        protocol: provenance.protocol,
        failure: { name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 1500) },
        completedProgressEvents: events.length,
        failureRecords: events.reduce((sum, line) => {
          try { return sum + (JSON.parse(line).type === 'run_failure' ? 1 : 0); } catch { return sum; }
        }, 0),
        hashes: {
          configurationSha256,
          datasetSha256,
          sourceSetSha256,
          graderSha256: sourceHashes.oracleSha256,
          inputLedgerSha256: sourceHashes.inputLedgerSha256
        },
        outputs: fs.existsSync(progressPath) ? { partialJsonl: describeFile(progressPath) } : {},
        note: 'No final benchmark raw JSON or completed report is written for an incomplete run. JSONL partial records preserve completed attempts, failures and actual counters without synthetic replacements.'
      };
      const manifestFd = fs.openSync(partialManifestPath, 'wx', 0o600);
      try { fs.writeFileSync(manifestFd, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'); } finally { fs.closeSync(manifestFd); }
    } catch (manifestError) {
      process.stderr.write(`LOCAL_LLM_PARTIAL_MANIFEST_WRITE_FAILED=${manifestError?.message ?? manifestError}\n`);
    }
    process.stderr.write(`LOCAL_LLM_PHASE1=INCOMPLETE progress=${progressPath}\n${error?.stack || error}\n`);
    throw error;
  }
}

main().catch(error => { console.error(error.message || error); process.exitCode = 1; });
