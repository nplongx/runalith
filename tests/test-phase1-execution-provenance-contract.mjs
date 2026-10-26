import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validatePhase1ExecutionProvenanceContract
} from '../benchmarks/plugin-workflow-benchmark/phase1-protocol-runner.mjs';

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const TARGET_BUNDLE_SHA256 = 'd3be0959617efd28c95c08357cfe909ed7150a71e16d5db4e2aead1e739739b5';
const BUDGET = { maxModelTurnsPerCondition: 12, maxToolCallsPerCondition: 20, maxElapsedSecondsPerCondition: 300 };
const NULL_RESOURCES = {
  cpuTimeMs: null, peakMemoryBytes: null, modelCalls: null, inputTokens: null,
  outputTokens: null, monetaryCostUsd: null, measurementSource: null
};

function fixture({ condition = 'plugin_enabled', workflowExecutionAllowed = false, toolOverride = null, artifactProducerType = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-provenance-contract-test-'));
  const t = '2026-10-22T07:00:00.000Z';
  const runId = `run-${condition}-unit`;
  const executionId = `execution-${condition}-unit`;
  const scenarioId = 'bounded_read_only_test';
  const prompt = 'TEST FIXTURE ONLY: inspect a local synthetic fixture and report a bounded result.';
  const initialState = { fixture: 'unit-test-only' };
  const hashText = value => sha256(Buffer.from(value, 'utf8'));
  const pluginCondition = condition === 'plugin_enabled';
  const workflow = pluginCondition && workflowExecutionAllowed;
  const tool = toolOverride || (pluginCondition ? 'adaptive_goal_graph_search' : 'read_fixture');
  const producerId = pluginCondition ? `runalith-mcpb:${TARGET_BUNDLE_SHA256}` : 'basic-tools-v1';
  const producerType = pluginCondition ? (workflow ? 'mcpb_plugin_workflow' : 'mcpb_plugin_read_only') : 'basic_tools_runner';
  const method = pluginCondition ? (workflow ? 'plugin_workflow' : 'plugin_read_only') : 'basic_tools';
  const graphHash = workflow ? 'e'.repeat(64) : null;
  const planHash = workflow ? 'f'.repeat(64) : null;
  const proposalHash = workflow ? 'a'.repeat(64) : null;
  const immutablePlanHash = workflow ? 'b'.repeat(64) : null;
  const outputArtifactId = artifactProducerType ? 'test-result-artifact' : null;
  const attempt = {
    attemptId: `attempt-${condition}-1`, attemptNumber: 1, startedAt: t, endedAt: t, exitCode: 0,
    outcome: 'completed', timedOut: false, toolCallIds: ['call-1']
  };
  const execution = {
    executionId, method, seed: 'fixed-unit-test-seed', budget: BUDGET,
    candidateBundleSha256: pluginCondition ? TARGET_BUNDLE_SHA256 : null,
    sourceSnapshotSha256: '1'.repeat(64), sharedEnvironmentSha256: '2'.repeat(64),
    commonConfigurationSha256: '3'.repeat(64), configurationSha256: pluginCondition ? '4'.repeat(64) : '5'.repeat(64),
    inputSha256: hashText(prompt), initialStateSha256: hashText(JSON.stringify(initialState)),
    workspaceInstanceId: `workspace-${condition}-1`, databaseInstanceId: `database-${condition}-1`,
    producerType, producerId, workflowJobId: workflow ? 'job-unit-test-only' : null,
    sourceGraphHash: graphHash, planGraphDraftHash: planHash, executionGraphProposalHash: proposalHash,
    immutablePlanHash, startedAt: t, endedAt: t, exitCode: 0, completionStatus: 'completed',
    attemptCount: 1, retryCount: 0, timeoutObserved: false, budgetExhausted: false,
    modelTurns: 1, toolCallCount: 1, attempts: [attempt], resourceUsage: { ...NULL_RESOURCES },
    toolTraceArtifactId: 'trace-artifact', eventLedgerArtifactId: 'ledger-artifact'
  };
  const run = {
    runId, scenarioId, condition,
    conditionVersion: pluginCondition ? `mcpb:${TARGET_BUNDLE_SHA256}` : 'basic-tools-v1',
    iteration: 1, startedAt: t, endedAt: t, initialStateSha256: execution.initialStateSha256,
    status: 'passed', execution,
    actions: [{
      timestamp: t, kind: 'tool_call', tool, inputSha256: '6'.repeat(64), outputSha256: '7'.repeat(64),
      exitCode: 0, stateBeforeSha256: null, stateAfterSha256: null,
      callId: 'call-1', producerId
    }]
  };
  const scenario = {
    id: scenarioId, exactInput: prompt,
    allowedToolsByCondition: {
      plugin_enabled: ['read_fixture', 'adaptive_goal_graph_search'], basic_tools: ['read_fixture']
    },
    permissions: { workflowExecutionAllowed }
  };
  const corpus = { runSettings: { budget: BUDGET, targetBundleSha256: TARGET_BUNDLE_SHA256, basicToolsCatalog: ['read_fixture'] } };
  const call = {
    callId: 'call-1', attemptNumber: 1, tool, timestamp: t, inputSha256: '6'.repeat(64),
    outputSha256: '7'.repeat(64), exitCode: 0, producerId, producedArtifactIds: outputArtifactId ? [outputArtifactId] : []
  };
  const trace = {
    schemaVersion: 1, kind: 'phase1_tool_call_trace', executionId, runId, scenarioId, condition,
    conditionVersion: run.conditionVersion, method, seed: execution.seed, budget: BUDGET,
    candidateBundleSha256: execution.candidateBundleSha256, sourceSnapshotSha256: execution.sourceSnapshotSha256,
    sharedEnvironmentSha256: execution.sharedEnvironmentSha256, commonConfigurationSha256: execution.commonConfigurationSha256,
    configurationSha256: execution.configurationSha256, inputSha256: execution.inputSha256,
    initialStateSha256: execution.initialStateSha256, producerType, producerId, workflowJobId: execution.workflowJobId,
    startedAt: t, endedAt: t, exitCode: 0, completionStatus: 'completed',
    attemptCount: 1, retryCount: 0, timeoutObserved: false, budgetExhausted: false,
    modelTurns: 1, toolCallCount: 1, attempts: [attempt], resourceUsage: { ...NULL_RESOURCES }, calls: [call]
  };
  const ledger = {
    schemaVersion: 1,
    kind: pluginCondition ? 'phase1_plugin_runtime_event_ledger' : 'phase1_basic_tool_event_ledger',
    executionId, runId, scenarioId, condition, producerId, workflowJobId: execution.workflowJobId,
    sourceGraphHash: graphHash, planGraphDraftHash: planHash,
    executionGraphProposalHash: proposalHash, immutablePlanHash,
    toolCallIds: ['call-1'], lineageRecords: []
  };
  const artifacts = [];
  const writeArtifact = (artifactId, relativePath, kind, bytes, producerTypeValue, producerCallId = null) => {
    fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(root, relativePath), bytes, { mode: 0o600 });
    artifacts.push({ artifactId, relativePath, sha256: sha256(bytes), kind, executionId, scenarioId, condition,
      producerType: producerTypeValue, producerId: producerTypeValue === 'runner_instrumentation' ? `phase1-runner:${executionId}` : producerId,
      producerCallId, parentArtifactIds: [], workflowLineage: null });
  };
  writeArtifact('trace-artifact', 'trace.json', 'tool-call-trace', Buffer.from(JSON.stringify(trace)), 'runner_instrumentation');
  writeArtifact('ledger-artifact', 'ledger.json', 'producer-event-ledger', Buffer.from(JSON.stringify(ledger)), 'runner_instrumentation');
  if (outputArtifactId) {
    let workflowLineage = null;
    if (artifactProducerType === 'plugin_workflow_task') {
      const jobId = execution.workflowJobId;
      const taskId = 'task-unit-test-only';
      const resultId = 'result-unit-test-only';
      const attemptId = 'attempt-unit-test-only';
      const content = '{"unitTestOnly":true}';
      const contentHash = sha256(Buffer.from(JSON.stringify(content), 'utf8'));
      const eventIdentity = (type, key) => sha256(Buffer.from(`${jobId}|${type}|${key}`, 'utf8'));
      const completionPayload = {
        attemptId, failureClass: null, outcome: 'success', resultId, runId: null, sessionKey: null, taskId
      };
      const artifactPayload = {
        artifactId: 'typed-artifact-unit-test-only', taskId, type: 'implementation', status: 'active',
        supersedes: null, contentHash
      };
      workflowLineage = {
        jobId, taskId, resultId, attemptId, producerRole: 'implementer', taskStatus: 'completed',
        resultOutcome: 'success', contentHash,
        sourceGraphHash: graphHash, planGraphDraftHash: planHash,
        executionGraphProposalHash: proposalHash, immutablePlanHash,
        task: { taskId, jobId, status: 'completed', role: 'implementer' },
        attempt: { attemptId, taskId, status: 'completed', openclawRunId: null, startedAt: t, finishedAt: t, error: null },
        result: { resultId, taskId, outcome: 'success', createdAt: t, content, contentSha256: sha256(Buffer.from(content, 'utf8')) },
        completionEvent: {
          eventId: eventIdentity('task.completed', `${taskId}|success|${resultId}`), jobId,
          type: 'task.completed', createdAt: t, payload: completionPayload, payloadJson: JSON.stringify(completionPayload)
        },
        artifactRow: {
          artifactId: artifactPayload.artifactId, jobId, taskId, type: 'implementation', schemaVersion: 1,
          status: 'active', supersedes: null, contentHash, producerRole: 'implementer', evidence: [resultId], content, createdAt: t
        },
        artifactCreatedEvent: {
          eventId: eventIdentity('artifact.created', artifactPayload.artifactId), jobId, type: 'artifact.created',
          createdAt: t, payload: artifactPayload, payloadJson: JSON.stringify(artifactPayload)
        }
      };
      ledger.lineageRecords = [workflowLineage];
      call.producedArtifactIds = [outputArtifactId];
      trace.calls[0].producedArtifactIds = [outputArtifactId];
    }
    const artifact = {
      artifactId: outputArtifactId, relativePath: 'output.json', sha256: sha256(Buffer.from('{"unitTestOnly":true}')),
      kind: 'implementation', executionId, scenarioId, condition,
      producerType: artifactProducerType, producerId: artifactProducerType === 'plugin_workflow_task' ? 'task-unit-test-only' : producerId,
      producerCallId: 'call-1', parentArtifactIds: [], workflowLineage
    };
    fs.writeFileSync(path.join(root, artifact.relativePath), '{"unitTestOnly":true}', { mode: 0o600 });
    artifacts.push(artifact);
  }
  if (workflow) {
    for (const [artifactId, relativePath, value] of [
      ['trace-artifact', 'trace.json', trace], ['ledger-artifact', 'ledger.json', ledger]
    ]) {
      const bytes = Buffer.from(JSON.stringify(value));
      fs.writeFileSync(path.join(root, relativePath), bytes, { mode: 0o600 });
      const record = artifacts.find(item => item.artifactId === artifactId);
      record.sha256 = sha256(bytes);
    }
  }
  const artifactMap = new Map(artifacts.map(item => [item.artifactId, item]));
  const input = {
    run, scenario, corpus, protocolSnapshot: { candidateBundleSha256: TARGET_BUNDLE_SHA256 }, evidenceRoot: root, artifactMap,
    usedExecutionIds: new Set(), usedWorkspaceIds: new Set(), usedDatabaseIds: new Set()
  };
  return { root, input, trace, ledger, run, scenario, execution, artifacts, artifactMap, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function rewriteTraceForExecution(item) {
  const execution = item.execution;
  Object.assign(item.trace, {
    executionId: execution.executionId, runId: item.run.runId, scenarioId: item.run.scenarioId,
    condition: item.run.condition, conditionVersion: item.run.conditionVersion, method: execution.method,
    seed: execution.seed, budget: execution.budget, candidateBundleSha256: execution.candidateBundleSha256,
    sourceSnapshotSha256: execution.sourceSnapshotSha256, sharedEnvironmentSha256: execution.sharedEnvironmentSha256,
    commonConfigurationSha256: execution.commonConfigurationSha256, configurationSha256: execution.configurationSha256,
    inputSha256: execution.inputSha256, initialStateSha256: execution.initialStateSha256,
    producerType: execution.producerType, producerId: execution.producerId, workflowJobId: execution.workflowJobId,
    startedAt: execution.startedAt, endedAt: execution.endedAt, exitCode: execution.exitCode,
    completionStatus: execution.completionStatus, attemptCount: execution.attemptCount, retryCount: execution.retryCount,
    timeoutObserved: execution.timeoutObserved, budgetExhausted: execution.budgetExhausted,
    modelTurns: execution.modelTurns, toolCallCount: execution.toolCallCount, attempts: execution.attempts,
    resourceUsage: execution.resourceUsage
  });
  const bytes = Buffer.from(JSON.stringify(item.trace));
  fs.writeFileSync(path.join(item.root, 'trace.json'), bytes);
  const record = item.artifacts.find(artifact => artifact.artifactId === 'trace-artifact');
  record.sha256 = sha256(bytes);
  item.artifactMap.set('trace-artifact', record);
}

test('plugin and baseline execution provenance contracts bind real producer identity and keep measured usage explicitly null', () => {
  const plugin = fixture({ condition: 'plugin_enabled' });
  const baseline = fixture({ condition: 'basic_tools' });
  try {
    assert.deepEqual(validatePhase1ExecutionProvenanceContract(plugin.input), {
      valid: true, executionId: plugin.execution.executionId, condition: 'plugin_enabled'
    });
    assert.deepEqual(validatePhase1ExecutionProvenanceContract(baseline.input), {
      valid: true, executionId: baseline.execution.executionId, condition: 'basic_tools'
    });
    assert.equal(plugin.execution.resourceUsage.monetaryCostUsd, null,
      'no token/USD metric may be inferred without a measurement source');
  } finally { plugin.cleanup(); baseline.cleanup(); }
});

test('a plugin_enabled record using only basic tools is rejected even when its trace and hashes are internally consistent', () => {
  const item = fixture({ condition: 'plugin_enabled', toolOverride: 'read_fixture' });
  try {
    const traceBytes = Buffer.from(JSON.stringify(item.trace));
    fs.writeFileSync(path.join(item.root, 'trace.json'), traceBytes);
    item.artifactMap.get('trace-artifact').sha256 = sha256(traceBytes);
    item.run.actions[0].tool = 'read_fixture';
    assert.throws(() => validatePhase1ExecutionProvenanceContract(item.input), /PHASE1_PLUGIN_CONDITION_DID_NOT_USE_PLUGIN/);
  } finally { item.cleanup(); }
});

test('workflow-enabled artifacts cannot receive AGG credit from an assistant/basic-tool producer', () => {
  const item = fixture({ condition: 'plugin_enabled', workflowExecutionAllowed: true, artifactProducerType: 'assistant_response' });
  try {
    assert.throws(() => validatePhase1ExecutionProvenanceContract(item.input), /PHASE1_PLUGIN_ARTIFACT_MISATTRIBUTED/);
  } finally { item.cleanup(); }
});

test('workflow-enabled artifacts pass only with canonical task/result/attempt/event/typed-artifact lineage', () => {
  const item = fixture({ condition: 'plugin_enabled', workflowExecutionAllowed: true, artifactProducerType: 'plugin_workflow_task' });
  try {
    assert.deepEqual(validatePhase1ExecutionProvenanceContract(item.input), {
      valid: true, executionId: item.execution.executionId, condition: 'plugin_enabled'
    });
    const original = item.artifacts.find(artifact => artifact.artifactId === 'test-result-artifact');
    original.workflowLineage.completionEvent.payloadJson = '{"tampered":true}';
    assert.throws(() => validatePhase1ExecutionProvenanceContract({ ...item.input,
      usedExecutionIds: new Set(), usedWorkspaceIds: new Set(), usedDatabaseIds: new Set()
    }), /PHASE1_RUNTIME_EVENT_INVALID/);
  } finally { item.cleanup(); }
});

test('durable artifact bytes must equal the current typed runtime artifact content', () => {
  const item = fixture({ condition: 'plugin_enabled', workflowExecutionAllowed: true, artifactProducerType: 'plugin_workflow_task' });
  try {
    fs.writeFileSync(path.join(item.root, 'output.json'), '{"different":true}');
    item.artifactMap.get('test-result-artifact').sha256 = sha256(Buffer.from('{"different":true}'));
    assert.throws(() => validatePhase1ExecutionProvenanceContract(item.input), /PHASE1_PLUGIN_TYPED_ARTIFACT_CONTENT_MISMATCH/);
  } finally { item.cleanup(); }
});

test('two evidence wrappers cannot claim the same durable typed runtime artifact ID', () => {
  const item = fixture({ condition: 'plugin_enabled', workflowExecutionAllowed: true, artifactProducerType: 'plugin_workflow_task' });
  try {
    const original = item.artifactMap.get('test-result-artifact');
    const duplicate = { ...original, artifactId: 'duplicate-wrapper-artifact', relativePath: 'duplicate-output.json' };
    fs.writeFileSync(path.join(item.root, duplicate.relativePath), fs.readFileSync(path.join(item.root, original.relativePath)));
    item.artifactMap.set(duplicate.artifactId, duplicate);
    item.trace.calls[0].producedArtifactIds.push(duplicate.artifactId);
    rewriteTraceForExecution(item);
    assert.throws(() => validatePhase1ExecutionProvenanceContract(item.input), /PHASE1_PLUGIN_TYPED_ARTIFACT_DUPLICATE/);
  } finally { item.cleanup(); }
});

test('hash-verified artifact files are still rejected when their parent lineage forms a cycle', () => {
  const item = fixture({ condition: 'plugin_enabled' });
  try {
    const addArtifact = (artifactId, relativePath, parentArtifactId) => {
      const bytes = Buffer.from(JSON.stringify({ artifactId, fixture: 'TEST_FIXTURE_ONLY_NOT_ACCEPTANCE' }));
      fs.writeFileSync(path.join(item.root, relativePath), bytes, { mode: 0o600 });
      const record = {
        artifactId, relativePath, sha256: sha256(bytes), kind: 'intermediate-output',
        executionId: item.execution.executionId, scenarioId: item.run.scenarioId, condition: item.run.condition,
        producerType: 'assistant_response', producerId: item.execution.producerId, producerCallId: 'call-1',
        parentArtifactIds: [parentArtifactId], workflowLineage: null
      };
      item.artifacts.push(record);
      item.artifactMap.set(artifactId, record);
      item.trace.calls[0].producedArtifactIds.push(artifactId);
    };
    addArtifact('cycle-artifact-a', 'cycle-a.json', 'cycle-artifact-b');
    addArtifact('cycle-artifact-b', 'cycle-b.json', 'cycle-artifact-a');
    rewriteTraceForExecution(item);
    assert.throws(() => validatePhase1ExecutionProvenanceContract(item.input), /PHASE1_ARTIFACT_PARENT_CYCLE/);
  } finally { item.cleanup(); }
});

test('cross-condition artifact contamination and a call assigned to the wrong attempt fail closed', () => {
  const item = fixture({ condition: 'plugin_enabled' });
  try {
    item.artifactMap.get('trace-artifact').condition = 'basic_tools';
    assert.throws(() => validatePhase1ExecutionProvenanceContract(item.input), /PHASE1_ARTIFACT_EXECUTION_BINDING_MISMATCH/);
  } finally { item.cleanup(); }

  const attemptMismatch = fixture();
  try {
    attemptMismatch.execution.attempts[0].toolCallIds = [];
    rewriteTraceForExecution(attemptMismatch);
    assert.throws(() => validatePhase1ExecutionProvenanceContract(attemptMismatch.input), /PHASE1_TOOL_CALL_ATTEMPT_BINDING_INVALID/);
  } finally { attemptMismatch.cleanup(); }
});

test('retry count must agree with durable attempt identity and attempts are never silently collapsed', () => {
  const item = fixture();
  try {
    item.execution.retryCount = 1;
    assert.throws(() => validatePhase1ExecutionProvenanceContract(item.input), /PHASE1_EXECUTION_PROVENANCE_INVALID/);
  } finally { item.cleanup(); }
});

test('a real retry sequence keeps each failed attempt and tool call, then binds the terminal success to attempt two', () => {
  const item = fixture();
  const t1 = '2026-10-22T07:00:00.000Z';
  const t2 = '2026-10-22T07:00:01.000Z';
  const t3 = '2026-10-22T07:00:02.000Z';
  try {
    item.execution.endedAt = t3;
    item.execution.attemptCount = 2;
    item.execution.retryCount = 1;
    item.execution.toolCallCount = 2;
    item.execution.modelTurns = 2;
    item.execution.attempts = [
      { attemptId: 'attempt-plugin_enabled-1', attemptNumber: 1, startedAt: t1, endedAt: t2,
        exitCode: 1, outcome: 'failed', timedOut: false, toolCallIds: ['call-1'] },
      { attemptId: 'attempt-plugin_enabled-2', attemptNumber: 2, startedAt: t2, endedAt: t3,
        exitCode: 0, outcome: 'completed', timedOut: false, toolCallIds: ['call-2'] }
    ];
    item.run.endedAt = t3;
    item.trace.calls = [
      { ...item.trace.calls[0], timestamp: t1, exitCode: 1, attemptNumber: 1 },
      { ...item.trace.calls[0], callId: 'call-2', timestamp: t2, exitCode: 0, attemptNumber: 2 }
    ];
    item.run.actions = item.trace.calls.map(call => ({ timestamp: call.timestamp, kind: 'tool_call', tool: call.tool,
      inputSha256: call.inputSha256, outputSha256: call.outputSha256, exitCode: call.exitCode,
      stateBeforeSha256: null, stateAfterSha256: null, callId: call.callId, producerId: call.producerId }));
    item.ledger.toolCallIds = ['call-1', 'call-2'];
    fs.writeFileSync(path.join(item.root, 'ledger.json'), JSON.stringify(item.ledger));
    const ledgerRecord = item.artifacts.find(artifact => artifact.artifactId === 'ledger-artifact');
    ledgerRecord.sha256 = sha256(fs.readFileSync(path.join(item.root, 'ledger.json')));
    item.artifactMap.set('ledger-artifact', ledgerRecord);
    rewriteTraceForExecution(item);
    assert.deepEqual(validatePhase1ExecutionProvenanceContract(item.input), {
      valid: true, executionId: item.execution.executionId, condition: 'plugin_enabled'
    });
  } finally { item.cleanup(); }
});

test('timeout/unknown outcome or budget exhaustion cannot be reported as completed success', () => {
  const timedOut = fixture();
  try {
    timedOut.execution.completionStatus = 'timed_out';
    timedOut.execution.exitCode = 124;
    timedOut.execution.timeoutObserved = true;
    timedOut.execution.attempts[0].outcome = 'timed_out';
    timedOut.execution.attempts[0].exitCode = 124;
    timedOut.execution.attempts[0].timedOut = true;
    // Deliberately false: a timed-out execution must not be surfaced as passed.
    timedOut.run.status = 'passed';
    rewriteTraceForExecution(timedOut);
    assert.throws(() => validatePhase1ExecutionProvenanceContract(timedOut.input), /PHASE1_EXECUTION_TERMINAL_STATE_MISMATCH/);
  } finally { timedOut.cleanup(); }

  const exhausted = fixture();
  try {
    exhausted.execution.completionStatus = 'budget_exhausted';
    exhausted.execution.exitCode = 75;
    exhausted.execution.budgetExhausted = true;
    exhausted.execution.attempts[0].outcome = 'budget_exhausted';
    exhausted.execution.attempts[0].exitCode = 75;
    exhausted.run.status = 'passed';
    rewriteTraceForExecution(exhausted);
    assert.throws(() => validatePhase1ExecutionProvenanceContract(exhausted.input), /PHASE1_EXECUTION_TERMINAL_STATE_MISMATCH/);
  } finally { exhausted.cleanup(); }
});

test('missing/cross-execution trace records and reused workspaces fail closed', () => {
  const item = fixture({ condition: 'plugin_enabled' });
  const freshInput = () => ({ ...item.input, usedExecutionIds: new Set(), usedWorkspaceIds: new Set(), usedDatabaseIds: new Set() });
  try {
    const missingTraceInput = { ...freshInput(), artifactMap: new Map(item.artifactMap) };
    missingTraceInput.artifactMap.delete('trace-artifact');
    assert.throws(() => validatePhase1ExecutionProvenanceContract(missingTraceInput), /PHASE1_EXECUTION_TRACE_ARTIFACT_MISSING/);

    const crossExecutionInput = { ...freshInput(), artifactMap: new Map(item.artifactMap) };
    crossExecutionInput.artifactMap.set('trace-artifact', { ...item.artifactMap.get('trace-artifact'), executionId: 'other-execution' });
    assert.throws(() => validatePhase1ExecutionProvenanceContract(crossExecutionInput), /PHASE1_EXECUTION_TRACE_ARTIFACT_MISSING/);

    const sharedUsedSets = { usedExecutionIds: new Set(), usedWorkspaceIds: new Set(), usedDatabaseIds: new Set() };
    assert.equal(validatePhase1ExecutionProvenanceContract({ ...item.input, ...sharedUsedSets }).valid, true);
    const secondRun = fixture({ condition: 'plugin_enabled' });
    try {
      secondRun.execution.executionId = 'second-execution-id';
      secondRun.execution.workspaceInstanceId = item.execution.workspaceInstanceId;
      secondRun.input.run.runId = 'second-run-id';
      secondRun.input.usedExecutionIds = sharedUsedSets.usedExecutionIds;
      secondRun.input.usedWorkspaceIds = sharedUsedSets.usedWorkspaceIds;
      secondRun.input.usedDatabaseIds = sharedUsedSets.usedDatabaseIds;
      // Rebuilt trace must match the deliberately altered second run ID before
      // this test can reach workspace reuse detection.
      const secondTrace = { ...secondRun.trace, executionId: 'second-execution-id', runId: 'second-run-id' };
      fs.writeFileSync(path.join(secondRun.root, 'trace.json'), JSON.stringify(secondTrace));
      secondRun.artifactMap.get('trace-artifact').sha256 = sha256(Buffer.from(JSON.stringify(secondTrace)));
      secondRun.artifacts.find(item => item.artifactId === 'trace-artifact').executionId = 'second-execution-id';
      secondRun.artifactMap.set('trace-artifact', secondRun.artifacts.find(item => item.artifactId === 'trace-artifact'));
      secondRun.input.artifactMap = secondRun.artifactMap;
      assert.throws(() => validatePhase1ExecutionProvenanceContract(secondRun.input), /PHASE1_EXECUTION_PROVENANCE_INVALID/);
    } finally { secondRun.cleanup(); }
  } finally { item.cleanup(); }
});
