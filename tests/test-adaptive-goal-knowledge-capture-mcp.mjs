#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('local MCP capture tool records a terminal workflow and exposes it to knowledge search', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-phase4-mcp-capture-'));
  fs.chmodSync(temp, 0o700);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  for (const directory of ['home', 'data', 'workspace', 'execution-tmp']) {
    fs.mkdirSync(path.join(temp, directory), { recursive: true, mode: 0o700 });
  }
  const stagedRuntime = path.join(temp, 'runtime-closure');
  const collected = spawnSync(process.execPath, [path.join(root, 'scripts/collect-plugin-runtime.mjs'), root, stagedRuntime], {
    cwd: root, encoding: 'utf8', timeout: 10000
  });
  assert.equal(collected.status, 0, collected.stderr || collected.stdout);
  assert.ok(fs.statSync(path.join(stagedRuntime, 'src/runtime/adaptive-goal-knowledge-capture.js')).isFile(),
    'the Phase 4 capture module must be included in the explicit plugin runtime closure');

  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin', HOME: path.join(temp, 'home'), NODE_ENV: 'test', LANG: 'C.UTF-8',
    AGG_PHASE4_KNOWLEDGE_CAPTURE_TOOL_ENABLED: '1',
    RUNALITH_DATA_DIR: path.join(temp, 'data'), RUNALITH_WORKFLOW_DB: path.join(temp, 'data/workflow.db'),
    WORKFLOW_DATA_DIR: path.join(temp, 'data'), WORKFLOW_DB: path.join(temp, 'data/workflow.db'),
    RUNALITH_WORKSPACE: path.join(temp, 'workspace'), RUNALITH_EXECUTION_TMP_DIR: path.join(temp, 'execution-tmp'),
    TMPDIR: temp, TEMP: temp, TMP: temp
  };
  const seedScript = `
    import { WorkflowStore } from './src/runtime/job-store.js';
    const store = new WorkflowStore();
    const job = store.createJob({ conversationKey: 'phase4-capture', title: 'Phase 4 MCP capture smoke' });
    store.transition(job.job_id, 'PROPOSED');
    store.approve(job.job_id, 'approved');
    store.dispatch(job.job_id, { role: 'cto', description: 'Capture integration fixture' });
    store.startAttempt(job.job_id, { openclawRunId: 'local-run-phase4' });
    store.attachOpenClawRun(job.job_id, { runId: 'local-run-phase4', sessionKey: 'agent:cto:subagent:phase4-capture' });
    store.complete(job.job_id, 'PASS', 'success');
    const active = store.createJob({ conversationKey: 'phase4-capture-active', title: 'Must not be captured while active' });
    process.stdout.write(JSON.stringify({ jobId: job.job_id, activeJobId: active.job_id, transitionJobId: active.job_id }) + '\\n');
  `;
  const seeded = spawnSync(process.execPath, ['--input-type=module', '-e', seedScript], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);
  const { jobId, activeJobId, transitionJobId } = JSON.parse(seeded.stdout.trim());
  assert.ok(jobId);

  const child = spawn(process.execPath, [path.join(root, 'server/index.js')], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdoutBuffer = '', stderr = '', nextId = 1, exited = false;
  const pending = new Map();
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP RPC timeout ${method}: ${stderr.slice(-2000)}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
      if (!error) return;
      const waiter = pending.get(id);
      if (waiter) { pending.delete(id); clearTimeout(waiter.timer); waiter.reject(error); }
    });
  });
  const rejectPending = error => {
    for (const [id, waiter] of pending) {
      pending.delete(id); clearTimeout(waiter.timer); waiter.reject(error);
    }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
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
  child.on('exit', (code, signal) => {
    exited = true;
    rejectPending(new Error(`source MCP exited code=${code} signal=${signal}: ${stderr.slice(-2000)}`));
  });
  t.after(async () => {
    if (!exited) {
      child.stdin.end();
      await new Promise(resolve => {
        const timer = setTimeout(() => { if (!exited) child.kill('SIGTERM'); resolve(); }, 1000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    if (!exited) child.kill('SIGKILL');
  });

  const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agg-phase4-capture-test', version: '1' } });
  assert.equal(initialized.error, undefined, initialized.error?.message);
  const listed = await rpc('tools/list');
  const captureTool = listed.result.tools.find(tool => tool.name === 'adaptive_goal_knowledge_capture_workflow_outcome');
  assert.equal(listed.result.tools.length, 68, 'opt-in exposes only the Phase 4 capture tool while Phase 2/3 remain hidden');
  assert.ok(captureTool, 'the source MCP runtime must expose the Phase 4 capture tool');
  assert.equal(listed.result.tools.some(tool => tool.name === 'adaptive_goal_phase2_shadow_search'), false,
    'Phase 4 capture must not enable the Phase 2 shadow tool in the default runtime');
  assert.equal(listed.result.tools.some(tool => tool.name === 'adaptive_goal_phase3_mcts_shadow_search'), false,
    'Phase 4 capture must not enable the Phase 3 MCTS shadow tool in the default runtime');
  assert.deepEqual(captureTool.inputSchema.required, ['goal_id', 'job_id']);
  assert.equal(captureTool.inputSchema.additionalProperties, false);
  assert.equal(captureTool.inputSchema.properties.lesson.maxLength, 2000);
  const packageManifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin/manifest.json'), 'utf8'));
  assert.ok(packageManifest.tools.some(tool => tool.name === 'adaptive_goal_knowledge_capture_workflow_outcome'));

  const captured = await rpc('tools/call', { name: 'adaptive_goal_knowledge_capture_workflow_outcome', arguments: {
    goal_id: 'phase4-capture-smoke', job_id: jobId,
    lesson: 'Keep the first implementation bounded and make incomplete evidence visible.'
  } });
  assert.equal(captured.error, undefined, captured.error?.message);
  assert.equal(captured.result.isError, false, captured.result.content?.[0]?.text);
  assert.equal(captured.result.structuredContent.status, 'unverified');
  assert.equal(captured.result.structuredContent.verified, false);
  assert.equal(captured.result.structuredContent.usableForPlanning, false);
  assert.equal(captured.result.structuredContent.executionAuthorized, false);
  assert.equal(captured.result.structuredContent.capture.resultCount, 1);
  assert.equal(captured.result.structuredContent.reviewStatus, 'review_required');
  assert.match(captured.result.structuredContent.summary, /tasks: completed=1/);
  assert.match(captured.result.structuredContent.summary, /results: success=1/);

  const retries = await Promise.all([1, 2].map(() => rpc('tools/call', { name: 'adaptive_goal_knowledge_capture_workflow_outcome', arguments: {
    goal_id: 'phase4-capture-smoke', job_id: jobId,
    lesson: 'Keep the first implementation bounded and make incomplete evidence visible.'
  } })));
  for (const retry of retries) {
    assert.equal(retry.result.isError, false, retry.result.content?.[0]?.text);
    assert.equal(retry.result.structuredContent.id, captured.result.structuredContent.id);
    assert.equal(retry.result.structuredContent.revision, 1);
  }

  const revisionRace = await Promise.all(['Concurrent note A', 'Concurrent note B'].map(lesson => rpc('tools/call', {
    name: 'adaptive_goal_knowledge_capture_workflow_outcome', arguments: {
      goal_id: 'phase4-capture-smoke', job_id: jobId, lesson, expected_revision: 1
    }
  })));
  assert.equal(revisionRace.filter(result => result.result?.isError === false).length, 1,
    'only one concurrent update with the same expected revision may win');
  assert.equal(revisionRace.filter(result => result.result?.isError === true).length, 1,
    'stale concurrent update must report a revision conflict');
  assert.match(revisionRace.find(result => result.result?.isError === true).result.content[0].text, /revision conflict/i);
  assert.equal(revisionRace.find(result => result.result?.isError === true).result.structuredContent.error.code, 'ERR_KNOWLEDGE_REVISION_CONFLICT');
  assert.equal(revisionRace.find(result => result.result?.isError === true).result.structuredContent.error.category, 'invalid_state');

  const isolated = await rpc('tools/call', { name: 'adaptive_goal_knowledge_capture_workflow_outcome', arguments: {
    goal_id: 'phase4-other-goal', job_id: jobId,
    lesson: 'A separate goal-scoped note about bounded execution.'
  } });
  assert.equal(isolated.result.isError, false, isolated.result.content?.[0]?.text);
  assert.notEqual(isolated.result.structuredContent.id, captured.result.structuredContent.id,
    'the same job captured under another goal must not reuse the original goal node');

  const active = await rpc('tools/call', { name: 'adaptive_goal_knowledge_capture_workflow_outcome', arguments: {
    goal_id: 'phase4-capture-smoke', job_id: activeJobId
  } });
  assert.equal(active.result.isError, true);
  assert.match(active.result.content[0].text, /only terminal workflows/i);
  assert.equal(active.result.structuredContent.error.code, 'ERR_AGG_KNOWLEDGE_CAPTURE_JOB_NOT_TERMINAL');
  assert.equal(active.result.structuredContent.error.next_actions.length, 1);

  const advanceScript = `
    import { WorkflowStore } from './src/runtime/job-store.js';
    const store = new WorkflowStore();
    const jobId = process.env.PHASE4_TRANSITION_JOB_ID;
    store.transition(jobId, 'PROPOSED');
    store.approve(jobId, 'approved');
    store.dispatch(jobId, { role: 'cto', description: 'Sensitive prompt-like task text must not be captured' });
    store.startAttempt(jobId, { openclawRunId: 'local-run-phase4-transition' });
    store.attachOpenClawRun(jobId, { runId: 'local-run-phase4-transition', sessionKey: 'agent:cto:subagent:phase4-transition' });
    store.complete(jobId, 'PASS', 'success');
    process.stdout.write(store.getJob(jobId).status + '\\n');
  `;
  const advanced = spawnSync(process.execPath, ['--input-type=module', '-e', advanceScript], {
    cwd: root, env: { ...env, PHASE4_TRANSITION_JOB_ID: transitionJobId }, encoding: 'utf8', timeout: 10000
  });
  assert.equal(advanced.status, 0, advanced.stderr || advanced.stdout);
  assert.equal(advanced.stdout.trim(), 'completed');
  const capturedAfterTransition = await rpc('tools/call', { name: 'adaptive_goal_knowledge_capture_workflow_outcome', arguments: {
    goal_id: 'phase4-transition-goal', job_id: transitionJobId
  } });
  assert.equal(capturedAfterTransition.result.isError, false, capturedAfterTransition.result.content?.[0]?.text);
  assert.equal(capturedAfterTransition.result.structuredContent.content.terminalStatus, 'completed');
  assert.equal(JSON.stringify(capturedAfterTransition.result.structuredContent.content).includes('Sensitive prompt-like task text'), false);
  assert.equal(capturedAfterTransition.result.structuredContent.content.results.length, 1);

  const missing = await rpc('tools/call', { name: 'adaptive_goal_knowledge_capture_workflow_outcome', arguments: {
    goal_id: 'phase4-capture-smoke', job_id: 'does-not-exist'
  } });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /workflow job not found/i);
  assert.equal(missing.result.structuredContent.error.code, 'ERR_AGG_KNOWLEDGE_CAPTURE_JOB_NOT_FOUND');

  const unicodeLesson = 'Tóm tắt an toàn: không lưu prompt hay hội thoại.';
  const unicode = await rpc('tools/call', { name: 'adaptive_goal_knowledge_capture_workflow_outcome', arguments: {
    goal_id: 'phase4-unicode-goal', job_id: jobId, lesson: unicodeLesson
  } });
  assert.equal(unicode.result.isError, false, unicode.result.content?.[0]?.text);

  const runDbScript = source => spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root, env, encoding: 'utf8', timeout: 10000
  });
  const createFailureTrigger = runDbScript(`
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.env.WORKFLOW_DB);
    db.exec("CREATE TRIGGER phase4_capture_write_failure BEFORE INSERT ON adaptive_goal_knowledge_revisions WHEN NEW.provenance_json LIKE '%adaptive-goal-knowledge-capture%' BEGIN SELECT RAISE(ABORT, 'phase4 forced DB error'); END;");
    db.close();
  `);
  assert.equal(createFailureTrigger.status, 0, createFailureTrigger.stderr || createFailureTrigger.stdout);
  const dbFailure = await rpc('tools/call', { name: 'adaptive_goal_knowledge_capture_workflow_outcome', arguments: {
    goal_id: 'phase4-db-error-goal', job_id: jobId, lesson: 'This capture must roll back entirely.'
  } });
  assert.equal(dbFailure.result.isError, true);
  assert.match(dbFailure.result.content[0].text, /phase4 forced DB error/i);
  assert.equal(typeof dbFailure.result.structuredContent.error.code, 'string', 'database errors should be machine-readable MCP tool errors');
  assert.match(dbFailure.result.structuredContent.error.code, /SQLITE/i);
  assert.equal(dbFailure.result.structuredContent.error.category, 'validation_failure', 'retain the existing closed WorkflowToolError category vocabulary');
  assert.equal(dbFailure.result.structuredContent.error.details.failureClass, 'sqlite_write_failure');
  assert.equal(dbFailure.result.structuredContent.error.details.transactionOutcome, 'rolled_back');
  assert.match(dbFailure.result.structuredContent.error.next_actions.join(' '), /retry after resolving the storage error/i);

  const partialWriteSearch = await rpc('tools/call', { name: 'adaptive_goal_knowledge_search', arguments: {
    goal_id: 'phase4-db-error-goal', limit: 10
  } });
  assert.equal(partialWriteSearch.result.isError, false, partialWriteSearch.result.content?.[0]?.text);
  assert.equal(partialWriteSearch.result.structuredContent.nodes.length, 0,
    'a failed SQLite insert must not leave a partial node or membership');
  const dropFailureTrigger = runDbScript(`
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.env.WORKFLOW_DB);
    db.exec('DROP TRIGGER phase4_capture_write_failure');
    db.close();
  `);
  assert.equal(dropFailureTrigger.status, 0, dropFailureTrigger.stderr || dropFailureTrigger.stdout);
  const dbFailureRetry = await rpc('tools/call', { name: 'adaptive_goal_knowledge_capture_workflow_outcome', arguments: {
    goal_id: 'phase4-db-error-goal', job_id: jobId, lesson: 'This capture must roll back entirely.'
  } });
  assert.equal(dbFailureRetry.result.isError, false, dbFailureRetry.result.content?.[0]?.text);
  assert.equal(dbFailureRetry.result.structuredContent.revision, 1,
    'retry after clearing a transient test fault should create the first complete revision');

  const searched = await rpc('tools/call', { name: 'adaptive_goal_knowledge_search', arguments: {
    goal_id: 'phase4-capture-smoke', query: jobId, limit: 10
  } });
  assert.equal(searched.error, undefined, searched.error?.message);
  assert.equal(searched.result.isError, false, searched.result.content?.[0]?.text);
  assert.equal(searched.result.structuredContent.nodes.length, 1);
  assert.ok(['Concurrent note A', 'Concurrent note B'].includes(searched.result.structuredContent.nodes[0].content.lesson));
  assert.equal(searched.result.structuredContent.nodes[0].content.lessonAuthorship, 'caller_supplied_unverified');
  assert.deepEqual(searched.result.structuredContent.planning.usableNodeIds, []);

  const unicodeSearch = await rpc('tools/call', { name: 'adaptive_goal_knowledge_search', arguments: {
    goal_id: 'phase4-unicode-goal', query: 'hội thoại', limit: 10
  } });
  assert.equal(unicodeSearch.result.isError, false, unicodeSearch.result.content?.[0]?.text);
  assert.equal(unicodeSearch.result.structuredContent.nodes.length, 1);
  assert.equal(unicodeSearch.result.structuredContent.nodes[0].content.lesson, unicodeLesson);
  const otherGoalSearch = await rpc('tools/call', { name: 'adaptive_goal_knowledge_search', arguments: {
    goal_id: 'phase4-other-goal', query: 'separate goal-scoped', limit: 10
  } });
  assert.equal(otherGoalSearch.result.structuredContent.nodes.length, 1);
  assert.equal(otherGoalSearch.result.structuredContent.nodes[0].id, isolated.result.structuredContent.id);
});
