#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { artifactSchemaForType, validateArtifactContent } from '../src/runtime/workflow/artifacts.js';
import { canonicalJson } from '../src/runtime/workflow/plan.js';
import { getAgentContract } from '../src/runtime/workflow/agent-contracts.js';
import { ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_SCOPE } from '../src/runtime/adaptive-goal-knowledge-verifier.js';
import { canonicalAdaptiveGoalActionIntentDescription, getAdaptiveGoalActionIntentSemanticPolicy } from '../src/runtime/adaptive-goal-action-intent-policy.js';
import { expectedAdaptiveGoalReviewerAttestationCandidate, ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT,
  ADAPTIVE_GOAL_REVIEWER_AUTHORIZATION_SCOPE } from '../src/runtime/adaptive-goal-reviewer-identity.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function resolveRuntimeEntryPoint(sourceRoot) {
  for (const manifestPath of ['plugin/manifest.json', 'manifest.json']) {
    const absoluteManifestPath = path.join(sourceRoot, manifestPath);
    if (!fs.existsSync(absoluteManifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(absoluteManifestPath, 'utf8'));
    const entryPoint = manifest.server?.entry_point;
    if (typeof entryPoint === 'string' && entryPoint && !path.isAbsolute(entryPoint) &&
        !entryPoint.split(/[\\/]/).some(part => part === '..')) {
      const resolved = path.resolve(sourceRoot, entryPoint);
      if (resolved.startsWith(`${path.resolve(sourceRoot)}${path.sep}`) && fs.statSync(resolved).isFile()) return resolved;
    }
    throw new Error(`${manifestPath} does not declare a safe, existing runtime entry point`);
  }
  throw new Error('no plugin runtime manifest found for the current test root');
}
const runtimeEntryPoint = resolveRuntimeEntryPoint(root);
const TOOL_TIMEOUT_MS = 20_000;
const KNOWLEDGE_VERIFIER_PROVIDER = 'isolated-agg-knowledge-verifier-e2e';
const knowledgeVerifierKeys = crypto.generateKeyPairSync('ed25519');
const knowledgeVerifierPublicPem = knowledgeVerifierKeys.publicKey.export({ type: 'spki', format: 'pem' });
const REVIEWER_IDENTITY_PROVIDER = 'isolated-agg-reviewer-identity-e2e';
const reviewerIdentityKeys = crypto.generateKeyPairSync('ed25519');
const reviewerIdentityPublicPem = reviewerIdentityKeys.publicKey.export({ type: 'spki', format: 'pem' });

const ROLE_SPECS = [
  { taskId: 'standard-product-owner', role: 'product-owner', capability: 'product.requirements', nodeId: 'define-policy-invariants', type: 'requirements' },
  { taskId: 'standard-researcher', role: 'researcher', capability: 'research.collect', nodeId: 'adversarial-regression-corpus', type: 'research' },
  { taskId: 'standard-architect', role: 'architect', capability: 'architecture.design', nodeId: 'design-recovery-contracts', type: 'architecture' },
  { taskId: 'standard-engineer', role: 'engineer', capability: 'code.modify', nodeId: 'implement-source-contracts', type: 'implementation' },
  { taskId: 'standard-security', role: 'security', capability: 'security.audit', nodeId: 'verify-lineage-failures', type: 'security-review' },
  { taskId: 'standard-qa', role: 'qa', capability: 'code.verify', nodeId: 'validate-regression-results', type: 'qa-report' },
  { taskId: 'standard-platform', role: 'platform', capability: 'infrastructure.verify', nodeId: 'assess-runtime-cutover', type: 'platform-review' },
  { taskId: 'standard-writer', role: 'writer', capability: 'documentation.write', nodeId: 'document-evidence-boundaries', type: 'documentation' },
  { taskId: 'standard-reviewer', role: 'reviewer', capability: 'change.review', nodeId: 'review-claim-and-lineage', type: 'review' }
];

const artifactContent = (role, testScope) => {
  const prefix = `[TEST-ONLY disposable producer run] ${testScope}`;
  switch (role) {
    case 'product-owner': return {
      scope: `${prefix}; verify the producer → typed artifact → Plan Graph → Execution Graph contract only.`,
      acceptance_criteria: [
        'Nine standard-engineering child tasks each emit one role-typed artifact through the real workflow completion API.',
        'Each artifact binds to its successful result, completed attempt, artifact.created event, and task.local_completed event.',
        'The source DAG maps all nine tasks with dependency branches preserved; fixture context is not an action.',
        'Missing, hash/schema-invalid, failed producer and broken event lineage block evidence readiness.'
      ],
      non_goals: ['No shared/live Idea Graph writes.', 'No current production claim is verified.', 'No plugin install, restart, approval, dispatch or execution on live state.'],
      test_only: true
    };
    case 'researcher': return {
      findings: [
        'The standard-engineering v3 template has nine mandatory specialist children and a separate CTO synthesis child.',
        'The artifact store validates typed content and content_hash; completeLocalTask commits result, artifact, task, attempt and completion event in one SQLite transaction.',
        'The resolver must reject byte hash mismatch, unsupported schema and missing/duplicate completion or invalid attempt lineage.',
        'Historical production artifacts and planner telemetry are separate data sources from outputs of this isolated producer run.'
      ],
      sources: [
        'src/runtime/workflow/catalog/standard-engineering.js',
        'src/runtime/workflow/artifacts.js',
        'src/runtime/job-store.js',
        'server/index.js'
      ],
      limitations: ['This output is a producer-contract test fixture; it is not a claim about the target product behavior or an independent review.'],
      test_only: true
    };
    case 'architect': return {
      components: ['Private source MCP process', 'Disposable workflow SQLite database', 'Role-specific completion/artifact producer API', 'Read-only lineage verifier', 'Shadow AGG search and Plan Graph projector', 'Compatibility/readiness gates', 'Review-only Execution Graph proposal API'],
      interfaces: ['workflow_create → preflight → isolated approve/dispatch → prepare_tasks', 'workflow_next_task → workflow_complete_task', 'adaptive_goal_graph_search(plan_projection_options.dependencyMode=source_edges_only)', 'adaptive_goal_plan_compatibility_check', 'adaptive_goal_execution_readiness_check', 'adaptive_goal_plan_proposal_create → adaptive_goal_execution_graph_proposal_create'],
      failure_modes: ['Missing artifact or wrong hash', 'Typed schema mismatch', 'Producer task/result/attempt failure', 'Missing or duplicate canonical event', 'Incomplete nine-task binding', 'Dependency inversion', 'Current installed runtime bytes differ from workspace candidate'],
      implementation_boundary: `${prefix}; all generated durable rows are in the private test database and are deleted with its temporary root.`,
      test_only: true
    };
    case 'engineer': return {
      summary: `${prefix}; integrated complete-task-mapping compatibility checks and a Plan Graph projection mode that derives dependencies from source prerequisite edges instead of serializing sibling actions.`,
      files_changed: [
        'server/index.js',
        'src/runtime/adaptive-goal-plan-adapter.js',
        'src/runtime/adaptive-goal-compatibility.js',
        'src/runtime/adaptive-goal-execution-readiness.js',
        'tests/test-adaptive-goal-compatibility.js',
        'tests/test-adaptive-goal-current-scope-producer-e2e.mjs'
      ],
      verification: ['Compatibility regression covers a missing task binding, all nine bindings and preserved sibling branches.', 'This producer E2E verifies role-specific typed content and real result/attempt/event lineage in a disposable DB.'],
      execution: { mode: 'chat-on-steroids-local-tools', exit_code: null, session_id: null, evidence_refs: ['test-only:source-contract-verification'] },
      test_only: true
    };
    case 'security': return {
      threats: [
        { asset: 'durable producer evidence', threat: 'a hash or task label may be presented without a completed real attempt and canonical completion event' },
        { asset: 'Plan Graph dependency contract', threat: 'missing task mapping or inverted dependency may be mistaken for complete compatibility' },
        { asset: 'runtime provenance', threat: 'workspace source changes may be described as live while the active plugin still runs different bytes' },
        { asset: 'claim truth', threat: 'lineage integrity may be promoted to independent claim attestation' }
      ],
      findings: [
        { id: 'SOURCE_RUNTIME_DRIFT', severity: 'high', status: 'open', detail: 'Active installed server/readiness bytes differ from the latest workspace; no cutover was performed.' },
        { id: 'CLAIM_ATTESTATION_ABSENT', severity: 'high', status: 'open', detail: 'No independently verified claim attestation is produced by this test.' },
        { id: 'PERSISTENCE_BOUNDARY', severity: 'info', status: 'test-covered', detail: 'This workflow and all AGG proposals are stored only in the disposable test database.' }
      ],
      decision: 'needs_changes',
      test_only: true
    };
    case 'qa': return {
      checks: ['typed content contract for all nine roles', 'exact persisted-byte SHA-256', 'single successful result per producer task', 'completed durable attempt', 'canonical artifact.created event', 'canonical task.local_completed event', 'nine-child mapping completeness', 'dependency preservation', 'readiness fail-closed when evidence is corrupted'],
      results: ['This artifact records the QA contract executed by the test process; the complete current candidate acceptance result is recorded after the package suite returns.'],
      decision: 'needs_changes',
      test_only: true
    };
    case 'platform': return {
      runtime: { mode: 'local-only-mcp', database: 'private temporary SQLite', networkRequired: false, activeInstalledRuntimeRestarted: false, activeInstalledRuntimeSourceAligned: false },
      deployment: { candidateBuildIsLocalArtifactOnly: true, installPerformed: false, releasePerformed: false, cutoverAuthorized: false },
      recovery: { temporaryStateRemovedAfterTest: true, priorAuditRowsPreserved: true, sourceHashMismatchBlocksCutover: true },
      test_only: true
    };
    case 'writer': return {
      summary: `${prefix}; output artifacts are tagged as test-only and must not be treated as current production claim evidence.`,
      user_facing_changes: ['Source-only dependency projection supports parallel security/QA/platform/writer branches after engineer.', 'Standard-engineering compatibility can require bindings for every mandatory child.', 'Planner telemetry persistence remains distinct from Idea Graph and proposal persistence.'],
      verification: ['The test suite reads back exact hashes and lineage from private SQLite rather than trusting MCP response claims.', 'Reports must retain BLOCKED until active source alignment, current-scope real evidence and independent claim review are resolved.'],
      test_only: true
    };
    case 'reviewer': return {
      requirementsSatisfied: true,
      architectureConformant: true,
      securityAccepted: false,
      qaAccepted: false,
      platformAccepted: false,
      documentationAccepted: true,
      implementationIssues: [],
      evidenceIssues: ['These nine role outputs are generated only to verify the producer contract in a disposable database; they are not admissible as production-scope evidence.'],
      securityIssues: ['Active installed source bytes are still different from workspace bytes.', 'No independent claim attestation is present.'],
      blockingIssues: ['Current runtime cutover remains unauthorized and was not attempted.', 'This test does not claim independent reviewer identity or claim truth.'],
      decision: 'needs_changes',
      test_only: true
    };
    default: throw new Error(`unsupported producer role: ${role}`);
  }
};

function sourceGraph(artifactRefs, sourceFileRef) {
  const nodes = [
    { id: 'initial-state', type: 'goal', label: 'Isolated producer contract test begins', evidenceRefs: [] },
    { id: 'hybrid-authority', type: 'idea', label: 'Keep graph evidence and execution authority separate', evidenceRefs: [] },
    { id: 'fail-closed-hypothesis', type: 'hypothesis', label: 'Missing or conflicting lineage must block readiness', evidenceRefs: [] },
    { id: 'build-monitor-test-fixture', type: 'condition', label: 'Test-only contract context; not an implementation action', evidenceRefs: [] }
  ];
  for (const spec of ROLE_SPECS) {
    // Every durable reference has one owning source node. Required inputs are
    // supplied through the real DAG's ancestor-output contracts; copying the
    // same URI onto descendant nodes would create duplicate evidence identities.
    const refs = new Set([artifactRefs[spec.taskId]]);
    if (spec.taskId === 'standard-security') refs.add(sourceFileRef);
    nodes.push({ id: spec.nodeId, type: spec.taskId === 'standard-researcher' || spec.taskId === 'standard-security' ? 'experiment' : 'task', label: `${spec.role}: ${spec.nodeId} (test-only)`, evidenceRefs: [...refs] });
  }
  nodes.push({ id: 'verified-target', type: 'goal', label: 'Evidence lineage and gates inspected; no claim acceptance implied', evidenceRefs: [] });
  const path = ['initial-state', 'hybrid-authority', 'fail-closed-hypothesis', 'build-monitor-test-fixture', ...ROLE_SPECS.map(spec => spec.nodeId), 'verified-target'];
  const edges = path.slice(0, -1).map((from, index) => ({ from, to: path[index + 1], type: 'next_step' }));
  const sourceNodeByTask = new Map(ROLE_SPECS.map(spec => [spec.taskId, spec.nodeId]));
  const dependencyPairs = [
    ['standard-product-owner', 'standard-researcher'],
    ['standard-product-owner', 'standard-architect'], ['standard-researcher', 'standard-architect'],
    ['standard-architect', 'standard-engineer'],
    ['standard-engineer', 'standard-security'], ['standard-engineer', 'standard-qa'],
    ['standard-engineer', 'standard-platform'], ['standard-engineer', 'standard-writer'],
    ['standard-security', 'standard-reviewer'], ['standard-qa', 'standard-reviewer'],
    ['standard-platform', 'standard-reviewer'], ['standard-writer', 'standard-reviewer']
  ];
  for (const [prerequisite, dependent] of dependencyPairs) {
    edges.push({ from: sourceNodeByTask.get(prerequisite), to: sourceNodeByTask.get(dependent), type: 'requires_all' });
  }
  return { schemaVersion: 1, startNodeId: 'initial-state', goalNodeId: 'verified-target', nodes, edges };
}

test('actual isolated producers → nine-node Plan Graph DAG → durable readiness/Execution Graph proposal; negatives remain fail-closed', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-current-scope-producer-e2e-'));
  fs.chmodSync(temp, 0o700);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const dirs = ['home', 'data', 'workspace', 'execution-tmp'];
  for (const dir of dirs) fs.mkdirSync(path.join(temp, dir), { recursive: true, mode: 0o700 });
  const home = path.join(temp, 'home');
  const data = path.join(temp, 'data');
  const workspace = path.join(temp, 'workspace');
  const dbPath = path.join(data, 'workflow.db');
  const child = spawn(process.execPath, [runtimeEntryPoint], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin', HOME: home, NODE_ENV: 'test', LANG: 'C.UTF-8', TMPDIR: temp, TEMP: temp, TMP: temp,
      AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID: KNOWLEDGE_VERIFIER_PROVIDER,
      AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM: knowledgeVerifierPublicPem,
      AGG_REVIEW_IDENTITY_PROVIDER_ID: REVIEWER_IDENTITY_PROVIDER,
      AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM: reviewerIdentityPublicPem,
      RUNALITH_DATA_DIR: data, RUNALITH_WORKFLOW_DB: dbPath, RUNALITH_WORKSPACE: workspace, RUNALITH_EXECUTION_TMP_DIR: path.join(temp, 'execution-tmp'),
      CHAT_ON_STEROIDS_DATA_DIR: data, CHAT_ON_STEROIDS_WORKFLOW_DB: dbPath, CHAT_ON_STEROIDS_WORKSPACE: workspace,
      CHAT_ON_STEROIDS_EXECUTION_TMP_DIR: path.join(temp, 'execution-tmp'), WORKFLOW_DATA_DIR: data, WORKFLOW_DB: dbPath,
      WORKFLOW_WORKSPACE: workspace, EXECUTION_TMP_DIR: path.join(temp, 'execution-tmp')
    }
  });
  let stdoutBuffer = '', stderr = '', nextId = 1, exited = false;
  const pending = new Map();
  const rejectPending = error => {
    for (const [id, waiter] of pending) {
      clearTimeout(waiter.timer); pending.delete(id); waiter.reject(error);
    }
  };
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP RPC timed out (${method})\n${stderr.slice(-3000)}`)); }, TOOL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
      if (!error) return;
      const waiter = pending.get(id); if (!waiter) return;
      pending.delete(id); clearTimeout(waiter.timer); waiter.reject(error);
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
      catch { rejectPending(new Error(`source MCP stdout is not JSON: ${line.slice(0, 500)}`)); child.kill('SIGKILL'); return; }
      if (message.id == null) continue;
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message); }
    }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1024 * 1024); });
  child.on('error', rejectPending);
  child.on('exit', (code, signal) => { exited = true; rejectPending(new Error(`isolated source MCP exited code=${code} signal=${signal}\n${stderr.slice(-3000)}`)); });
  t.after(async () => {
    if (!exited) {
      child.stdin.end();
      await new Promise(resolve => {
        const timer = setTimeout(() => { if (!exited) child.kill('SIGTERM'); resolve(); }, 1500);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    if (!exited) child.kill('SIGKILL');
  });

  const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agg-current-scope-producer-e2e', version: '1' } });
  assert.equal(initialized.error, undefined, JSON.stringify(initialized.error));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  const tool = async (name, args = {}) => {
    const response = await rpc('tools/call', { name, arguments: args });
    assert.equal(response.error, undefined, `${name} RPC failed: ${JSON.stringify(response.error)}`);
    assert.notEqual(response.result?.isError, true, `${name} failed: ${response.result?.content?.[0]?.text || JSON.stringify(response.result?.structuredContent)}`);
    if (response.result?.structuredContent) return response.result.structuredContent;
    const textItem = response.result?.content?.find(item => item.type === 'text');
    return textItem ? JSON.parse(textItem.text) : response.result;
  };
  const rawTool = async (name, args = {}) => {
    const response = await rpc('tools/call', { name, arguments: args });
    assert.equal(response.error, undefined, `${name} RPC failed: ${JSON.stringify(response.error)}`);
    return response.result;
  };

  const created = await tool('workflow_create', {
    title: 'Software Development: AGG current-scope producer contract test only',
    task: 'TEST ONLY. In a private disposable SQLite database, validate nine standard-engineering producer outputs and Goal/Idea Graph to Plan Graph to Execution Graph readiness contracts. Every artifact must be labelled test-only. Do not infer production claim truth, independent attestation, or execution authorization.',
    workflow: 'standard-engineering', workspace
  });
  assert.equal(created.created, true);
  const preflight = await tool('workflow_preflight', { job_id: created.job_id });
  assert.equal(preflight.ready, true, JSON.stringify(preflight.blockers, null, 2));
  const approved = await tool('workflow_approve', { job_id: created.job_id, confirmation: 'Approve only the private test fixture workflow; no live/shared state.' });
  assert.equal(approved.approved, true);
  const dispatched = await tool('workflow_dispatch', { job_id: created.job_id });
  assert.equal(dispatched.dispatched, true);
  const prepared = await tool('workflow_prepare_tasks', { job_id: created.job_id });
  assert.equal(prepared.count, 9);
  assert.equal(prepared.tasks.length, 9);

  const taskIds = new Set();
  const produced = {};
  for (let iteration = 0; iteration < ROLE_SPECS.length; iteration++) {
    const next = await tool('workflow_next_task', { job_id: created.job_id });
    assert.equal(next.stage, 'task', JSON.stringify(next));
    const task = next.task;
    const spec = ROLE_SPECS.find(item => item.taskId === task.plan_task_id);
    assert.ok(spec, `unexpected producer task ${task.plan_task_id}`);
    assert.equal(task.role, spec.role);
    assert.equal(task.status, 'running');
    assert.equal(taskIds.has(task.task_id), false, 'each immutable plan task gets one producer invocation');
    taskIds.add(task.task_id);
    const content = artifactContent(spec.role, `job=${created.job_id}; plan_task=${spec.taskId}`);
    validateArtifactContent(spec.type, content);
    const completion = await tool('workflow_complete_task', {
      task_id: task.task_id,
      content: `TEST-ONLY producer output for ${spec.role}/${spec.type}; isolated DB=${dbPath}; no live claim or authority granted.\n${JSON.stringify(content)}`,
      artifact: content,
      outcome: 'success'
    });
    assert.equal(completion.completed, true, JSON.stringify(completion));
    assert.ok(completion.result_id);
    produced[spec.taskId] = { ...spec, taskId: task.task_id, resultId: completion.result_id, output: content };
  }
  assert.equal(Object.keys(produced).length, 9);

  // Verify every producer row through an independent read-only SQLite connection.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const artifactRefs = {};
  const artifactRows = {};
  try {
    for (const spec of ROLE_SPECS) {
      const output = produced[spec.taskId];
      const task = db.prepare('SELECT * FROM tasks WHERE task_id=?').get(output.taskId);
      const result = db.prepare('SELECT * FROM results WHERE result_id=?').get(output.resultId);
      const attempts = db.prepare('SELECT * FROM attempts WHERE task_id=? ORDER BY started_at, rowid').all(output.taskId);
      const artifacts = db.prepare('SELECT * FROM artifacts WHERE task_id=? AND status=\'active\'').all(output.taskId);
      const completionRows = db.prepare("SELECT * FROM events WHERE job_id=? AND type='task.local_completed' AND json_extract(payload_json,'$.resultId')=?").all(created.job_id, output.resultId);
      assert.equal(task.status, 'completed', `${spec.taskId} task must complete through workflow completion API`);
      assert.equal(result.outcome, 'success');
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].status, 'completed');
      assert.equal(attempts[0].task_id, output.taskId);
      assert.equal(completionRows.length, 1, 'exactly one completion event must reference each result');
      const completionEvent = completionRows[0];
      assert.equal(completionEvent.event_id, crypto.createHash('sha256').update(`${created.job_id}|task.local_completed|${output.resultId}`).digest('hex'));
      const completionPayload = JSON.parse(completionEvent.payload_json);
      assert.deepEqual(completionPayload, { taskId: output.taskId, resultId: output.resultId, attemptId: attempts[0].attempt_id, executor: 'chat-on-steroids-plugin' });
      assert.equal(artifacts.length, 1, 'each successful producer must emit exactly one typed artifact');
      const artifact = artifacts[0];
      assert.equal(artifact.kind, spec.type);
      assert.equal(artifact.schema_version, 1);
      assert.equal(artifact.producer_role, spec.role);
      assert.equal(artifact.status, 'active');
      assert.equal(artifact.content_hash, crypto.createHash('sha256').update(artifact.content, 'utf8').digest('hex'), 'artifact hash must cover the exact persisted content bytes');
      const parsedContent = JSON.parse(artifact.content);
      validateArtifactContent(spec.type, parsedContent);
      assert.equal(parsedContent.test_only, true, 'test artifacts must explicitly self-identify as test-only, not production claim evidence');
      const artifactEvents = db.prepare("SELECT * FROM events WHERE job_id=? AND type='artifact.created' AND json_extract(payload_json,'$.artifactId')=?").all(created.job_id, artifact.artifact_id);
      assert.equal(artifactEvents.length, 1, 'exactly one canonical creation event must identify each artifact');
      assert.equal(artifactEvents[0].event_id, crypto.createHash('sha256').update(`${created.job_id}|artifact.created|${artifact.artifact_id}`).digest('hex'));
      const artifactPayload = JSON.parse(artifactEvents[0].payload_json);
      assert.equal(artifactPayload.taskId, output.taskId);
      assert.equal(artifactPayload.type, spec.type);
      assert.equal(artifactPayload.status, 'active');
      assert.equal(artifactPayload.contentHash, artifact.content_hash);
      assert.deepEqual(JSON.parse(artifact.evidence_json).includes(output.resultId), true, 'artifact must reference its exact producer result');
      artifactRefs[spec.taskId] = `artifact://${artifact.artifact_id}`;
      artifactRows[spec.taskId] = artifact;
    }
    const finalCounts = {
      jobs: db.prepare('SELECT COUNT(*) n FROM jobs').get().n,
      plans: db.prepare('SELECT COUNT(*) n FROM workflow_plans').get().n,
      approvals: db.prepare('SELECT COUNT(*) n FROM approvals').get().n,
      plannerRuns: db.prepare('SELECT COUNT(*) n FROM adaptive_goal_planner_runs').get().n,
      knowledgeNodes: db.prepare('SELECT COUNT(*) n FROM adaptive_goal_knowledge_nodes').get().n,
      knowledgeEdges: db.prepare('SELECT COUNT(*) n FROM adaptive_goal_knowledge_edges').get().n
    };
    assert.equal(finalCounts.knowledgeNodes, 0, 'the test graph must never persist shared Idea Graph nodes');
    assert.equal(finalCounts.knowledgeEdges, 0, 'the test graph must never persist shared Idea Graph edges');
  } finally { db.close(); }

  const sourcePath = 'src/runtime/adaptive-goal-execution-readiness.js';
  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, sourcePath))).digest('hex');
  const sourceFileRef = `file:${sourcePath}#sha256=${sourceHash}`;
  const graph = sourceGraph(artifactRefs, sourceFileRef);
  const search = await tool('adaptive_goal_graph_search', {
    graph,
    options: { beamWidth: 16, maxDepth: 24, maxExpansions: 1024, maxAuditEvents: 1000 },
    plan_projection_options: { dependencyMode: 'source_edges_only' }
  });
  assert.ok(search.telemetry?.persisted, 'search writes planner telemetry to the isolated DB');
  assert.equal(search.telemetry.persistence_scope, 'planner_telemetry_only');
  assert.equal(search.telemetry.terminal_record_persisted, true);
  assert.equal(search.knowledgeSnapshot, undefined, 'caller-supplied Goal/Idea Graph remains an in-memory input in this test');
  const draft = search.planGraphDrafts.find(item => item.steps.length === 9 && item.steps.some(step => step.sourceNodeId === 'review-claim-and-lineage'));
  assert.ok(draft, `search must project a nine-action candidate; candidates=${search.planGraphDrafts.map(item => item.steps.length).join(',')}`);
  assert.equal(draft.contextNodes.some(item => item.id === 'build-monitor-test-fixture' && item.type === 'condition'), true);
  assert.equal(draft.steps.some(item => item.sourceNodeId === 'build-monitor-test-fixture'), false);
  const expectedPrerequisites = {
    'standard-product-owner': [],
    'standard-researcher': ['standard-product-owner'],
    'standard-architect': ['standard-product-owner', 'standard-researcher'],
    'standard-engineer': ['standard-architect'],
    'standard-security': ['standard-engineer'],
    'standard-qa': ['standard-engineer'],
    'standard-platform': ['standard-engineer'],
    'standard-writer': ['standard-engineer'],
    'standard-reviewer': ['standard-security', 'standard-qa', 'standard-platform', 'standard-writer']
  };
  const bindingByTask = new Map();
  for (const spec of ROLE_SPECS) {
    const step = draft.steps.find(item => item.sourceNodeId === spec.nodeId);
    assert.ok(step, `draft missing ${spec.nodeId}`);
    bindingByTask.set(spec.taskId, step);
    const expected = expectedPrerequisites[spec.taskId].map(taskId => bindingByTask.get(taskId)?.id).filter(Boolean);
    assert.deepEqual(step.dependencies, expected, `${spec.taskId} dependencies must preserve the exact DAG, not a false linear chain`);
  }

  const taskBindings = ROLE_SPECS.map(spec => ({
    step_id: bindingByTask.get(spec.taskId).id, task_id: spec.taskId, capability: spec.capability
  }));
  const compatibility = await tool('adaptive_goal_plan_compatibility_check', {
    draft, workflow_id: 'standard-engineering', task_bindings: taskBindings.map(({ step_id, task_id }) => ({ step_id, task_id }))
  });
  assert.equal(compatibility.eligible, true, JSON.stringify(compatibility.blockers, null, 2));
  assert.equal(compatibility.bindings.length, 9);
  assert.equal(compatibility.workflow.taskCount, 9);
  assert.equal(compatibility.warnings.some(message => /additional mandatory child task/.test(message)), false);

  const incomplete = await tool('adaptive_goal_plan_compatibility_check', {
    draft, workflow_id: 'standard-engineering', task_bindings: taskBindings.slice(0, 8).map(({ step_id, task_id }) => ({ step_id, task_id }))
  });
  assert.equal(incomplete.eligible, false);
  assert.ok(incomplete.blockers.some(item => item.code === 'WORKFLOW_CHILD_TASK_UNMAPPED' && item.taskId === 'standard-reviewer'));
  assert.equal(incomplete.gates.workflowProposalCreated, false);

  const invertedBindings = taskBindings.map(({ ...item }) => item);
  const securityIdx = invertedBindings.findIndex(item => item.task_id === 'standard-security');
  const engineerIdx = invertedBindings.findIndex(item => item.task_id === 'standard-engineer');
  [invertedBindings[securityIdx].task_id, invertedBindings[engineerIdx].task_id] = [invertedBindings[engineerIdx].task_id, invertedBindings[securityIdx].task_id];
  const inverted = await tool('adaptive_goal_plan_compatibility_check', {
    draft, workflow_id: 'standard-engineering', task_bindings: invertedBindings.map(({ step_id, task_id }) => ({ step_id, task_id }))
  });
  assert.equal(inverted.eligible, false);
  assert.ok(inverted.blockers.some(item => item.code === 'DEPENDENCY_NOT_PRESERVED'));

  const readinessArgs = { draft, workflow_id: 'standard-engineering', task_bindings: taskBindings };
  const ready = await tool('adaptive_goal_execution_readiness_check', readinessArgs);
  assert.equal(ready.contractReady, true, JSON.stringify(ready.blockers, null, 2));
  assert.equal(ready.evidenceReady, true, JSON.stringify(ready.evidenceBlockers, null, 2));
  assert.equal(ready.readyForExecutionGraphReview, true);
  assert.equal(ready.gates.executionGraphCreated, false);
  assert.equal(ready.gates.dispatchAllowed, false);
  assert.equal(ready.gates.executionAuthorized, false);
  for (const action of ready.actions) {
    assert.equal(action.supportingEvidence.verified, true);
    assert.equal(action.execution.enabled, false);
  }

  const unregisteredGraph = structuredClone(graph);
  unregisteredGraph.nodes.find(node => node.id === 'review-claim-and-lineage').evidenceRefs.push('artifact://fixture-only-unregistered-output');
  const unregisteredSearch = await tool('adaptive_goal_graph_search', {
    graph: unregisteredGraph,
    options: { beamWidth: 16, maxDepth: 24, maxExpansions: 1024, maxAuditEvents: 1000 },
    plan_projection_options: { dependencyMode: 'source_edges_only' }
  });
  const unregisteredDraft = unregisteredSearch.planGraphDrafts.find(item => item.steps.length === 9);
  assert.ok(unregisteredDraft);
  const unregisteredBindings = ROLE_SPECS.map(spec => ({
    step_id: unregisteredDraft.steps.find(step => step.sourceNodeId === spec.nodeId).id,
    task_id: spec.taskId,
    capability: spec.capability
  }));
  const unregisteredReadiness = await tool('adaptive_goal_execution_readiness_check', {
    draft: unregisteredDraft, workflow_id: 'standard-engineering', task_bindings: unregisteredBindings
  });
  assert.equal(unregisteredReadiness.contractReady, true, JSON.stringify(unregisteredReadiness.blockers, null, 2));
  assert.equal(unregisteredReadiness.evidenceReady, false);
  assert.equal(unregisteredReadiness.readyForExecutionGraphReview, false);
  assert.ok(unregisteredReadiness.evidenceBlockers.some(item => item.code === 'SOURCE_EVIDENCE_UNVERIFIED'));

  // Artifact-byte mismatch: direct SQL is only applied to this private test DB and is restored byte-for-byte.
  const mutableDb = new DatabaseSync(dbPath);
  const arch = artifactRows['standard-architect'];
  const originalArch = mutableDb.prepare('SELECT * FROM artifacts WHERE artifact_id=?').get(arch.artifact_id);
  try {
    mutableDb.prepare('UPDATE artifacts SET content_hash=? WHERE artifact_id=?').run('0'.repeat(64), arch.artifact_id);
    const badHash = await tool('adaptive_goal_execution_readiness_check', readinessArgs);
    assert.equal(badHash.contractReady, true);
    assert.equal(badHash.evidenceReady, false);
    assert.ok(badHash.evidenceBlockers.some(item => item.code === 'SOURCE_ARTIFACT_CONTENT_HASH_INVALID'));
    mutableDb.prepare('UPDATE artifacts SET content=?, content_hash=? WHERE artifact_id=?').run(
      JSON.stringify({ test_only: true, invalid_content: true }), crypto.createHash('sha256').update(JSON.stringify({ test_only: true, invalid_content: true })).digest('hex'), arch.artifact_id
    );
    const badSchema = await tool('adaptive_goal_execution_readiness_check', readinessArgs);
    assert.equal(badSchema.contractReady, true);
    assert.equal(badSchema.evidenceReady, false);
    assert.ok(badSchema.evidenceBlockers.some(item => item.code === 'SOURCE_ARTIFACT_SCHEMA_INVALID'));
    mutableDb.prepare('UPDATE artifacts SET content=?, content_hash=? WHERE artifact_id=?').run(originalArch.content, originalArch.content_hash, arch.artifact_id);

    const completion = mutableDb.prepare("SELECT * FROM events WHERE job_id=? AND type='task.local_completed' AND json_extract(payload_json,'$.resultId')=?").get(created.job_id, produced['standard-architect'].resultId);
    mutableDb.prepare('DELETE FROM events WHERE event_id=?').run(completion.event_id);
    const missingCompletion = await tool('adaptive_goal_execution_readiness_check', readinessArgs);
    assert.equal(missingCompletion.evidenceReady, false);
    assert.ok(missingCompletion.evidenceBlockers.some(item => item.code === 'SOURCE_EVIDENCE_RESULT_LINEAGE_INVALID'));
    mutableDb.prepare('INSERT INTO events(event_id,job_id,type,payload_json,created_at) VALUES(?,?,?,?,?)').run(completion.event_id, completion.job_id, completion.type, completion.payload_json, completion.created_at);

    const duplicateCompletionId = crypto.createHash('sha256').update(`${created.job_id}|test-duplicate-task-completion|${produced['standard-architect'].resultId}`).digest('hex');
    mutableDb.prepare('INSERT INTO events(event_id,job_id,type,payload_json,created_at) VALUES(?,?,?,?,?)').run(
      duplicateCompletionId, completion.job_id, completion.type, completion.payload_json, completion.created_at
    );
    const duplicateCompletion = await tool('adaptive_goal_execution_readiness_check', readinessArgs);
    assert.equal(duplicateCompletion.evidenceReady, false);
    assert.ok(duplicateCompletion.evidenceBlockers.some(item => item.code === 'SOURCE_EVIDENCE_RESULT_LINEAGE_INVALID'));
    mutableDb.prepare('DELETE FROM events WHERE event_id=?').run(duplicateCompletionId);

    const attempt = mutableDb.prepare('SELECT * FROM attempts WHERE task_id=?').get(produced['standard-architect'].taskId);
    mutableDb.prepare("UPDATE attempts SET status='failed', finished_at=COALESCE(finished_at,?) WHERE attempt_id=?").run(new Date().toISOString(), attempt.attempt_id);
    const badAttempt = await tool('adaptive_goal_execution_readiness_check', readinessArgs);
    assert.equal(badAttempt.evidenceReady, false);
    assert.ok(badAttempt.evidenceBlockers.some(item => item.code === 'SOURCE_EVIDENCE_RESULT_LINEAGE_INVALID'));
    mutableDb.prepare('UPDATE attempts SET status=?, finished_at=?, error=? WHERE attempt_id=?').run(attempt.status, attempt.finished_at, attempt.error, attempt.attempt_id);

    const producerTask = mutableDb.prepare('SELECT * FROM tasks WHERE task_id=?').get(produced['standard-architect'].taskId);
    mutableDb.prepare("UPDATE tasks SET status='failed' WHERE task_id=?").run(producerTask.task_id);
    const failedProducer = await tool('adaptive_goal_execution_readiness_check', readinessArgs);
    assert.equal(failedProducer.evidenceReady, false);
    assert.ok(failedProducer.evidenceBlockers.some(item => item.code === 'SOURCE_EVIDENCE_RESULT_LINEAGE_INVALID' || item.code === 'SOURCE_EVIDENCE_NOT_ACTIVE'));
    mutableDb.prepare('UPDATE tasks SET status=? WHERE task_id=?').run(producerTask.status, producerTask.task_id);
  } finally { mutableDb.close(); }

  const readinessRestored = await tool('adaptive_goal_execution_readiness_check', readinessArgs);
  assert.equal(readinessRestored.contractReady, true);
  assert.equal(readinessRestored.evidenceReady, true);
  assert.equal(readinessRestored.readyForExecutionGraphReview, true);

  // Build a durable Goal/Idea Graph from the nine real typed producer outputs.
  // The test verifier's private key stays in this test process; only its public
  // trust root is passed to the isolated MCP server, and no live key is used.
  const knowledgeGoalId = 'agg-nine-evidence-e2e';
  const knowledgeProvenance = reference => ({
    source: 'isolated-producer-result', actor: 'isolated-knowledge-verifier-e2e', reference,
    note: 'Disposable acceptance evidence only; this fixture is not a production claim.'
  });
  const knowledgeNodeIds = new Map();
  const knowledgeNodeSave = async ({ stableKey, type, label, evidenceRef = null }) => {
    const saved = await tool('adaptive_goal_knowledge_node_save', {
      goal_id: knowledgeGoalId, stable_key: stableKey, node_type: type,
      content: { label, acceptanceFixture: true },
      provenance: knowledgeProvenance(evidenceRef || `idea-graph://${stableKey}`),
      expected_revision: 0,
      evidence_refs: evidenceRef ? [evidenceRef] : []
    });
    assert.equal(saved.verified, false, 'persistence itself must never self-verify caller-authored nodes');
    assert.equal(saved.usableForPlanning, false);
    knowledgeNodeIds.set(stableKey, saved.id);
    return saved.id;
  };
  const knowledgeStartNodeId = await knowledgeNodeSave({ stableKey: 'verified-producer-goal', type: 'idea', label: 'Start from durable producer evidence' });
  for (const spec of ROLE_SPECS) {
    const nodeId = await knowledgeNodeSave({
      stableKey: spec.nodeId, type: 'experiment', label: `${spec.role} producer output`,
      evidenceRef: artifactRefs[spec.taskId]
    });
    knowledgeNodeIds.set(spec.taskId, nodeId);
  }
  const knowledgeGoalNodeId = await knowledgeNodeSave({ stableKey: 'verified-goal-reached', type: 'goal', label: 'All nine evidence contracts validated' });
  const knowledgeEdge = async (fromKey, toKey, type) => {
    const result = await tool('adaptive_goal_knowledge_edge_add', {
      goal_id: knowledgeGoalId,
      from_id: knowledgeNodeIds.get(fromKey), to_id: knowledgeNodeIds.get(toKey), edge_type: type,
      provenance: knowledgeProvenance(`edge://${fromKey}/${type}/${toKey}`),
      evidence_refs: []
    });
    assert.ok(result.edgeId);
  };
  const nominalPathKeys = ['verified-producer-goal', ...ROLE_SPECS.map(spec => spec.nodeId), 'verified-goal-reached'];
  for (let i = 0; i < nominalPathKeys.length - 1; i++) await knowledgeEdge(nominalPathKeys[i], nominalPathKeys[i + 1], 'enables');
  const dependencyPairs = [
    ['standard-product-owner', 'standard-researcher'],
    ['standard-product-owner', 'standard-architect'], ['standard-researcher', 'standard-architect'],
    ['standard-architect', 'standard-engineer'],
    ['standard-engineer', 'standard-security'], ['standard-engineer', 'standard-qa'],
    ['standard-engineer', 'standard-platform'], ['standard-engineer', 'standard-writer'],
    ['standard-security', 'standard-reviewer'], ['standard-qa', 'standard-reviewer'],
    ['standard-platform', 'standard-reviewer'], ['standard-writer', 'standard-reviewer']
  ];
  for (const [pre, dependent] of dependencyPairs) await knowledgeEdge(pre, dependent, 'requires_all');

  const knowledgeSnapshotRequest = await tool('adaptive_goal_knowledge_snapshot_get', { goal_id: knowledgeGoalId });
  assert.equal(knowledgeSnapshotRequest.snapshot.integrity_valid, true, JSON.stringify(knowledgeSnapshotRequest.snapshot.integrity_issues));
  assert.equal(knowledgeSnapshotRequest.snapshot.nodes.length, 11);
  assert.equal(knowledgeSnapshotRequest.snapshot.edges.length, 22);
  assert.equal(knowledgeSnapshotRequest.snapshot.memberships.length, 11);
  assert.equal(knowledgeSnapshotRequest.currentVerification.verified, false, 'content hashes and producer lineage do not independently attest claim truth');
  assert.equal(knowledgeSnapshotRequest.evidenceManifest.length, 9);
  assert.equal(knowledgeSnapshotRequest.evidenceManifest.every(item => item.valid === true && item.classification === 'durable_artifact_lineage_verified_claim_unverified'), true);
  const knowledgeAttestationUnsigned = {
    schema_version: 1,
    kind: 'adaptive_goal_verified_knowledge_graph_attestation',
    provider_id: KNOWLEDGE_VERIFIER_PROVIDER,
    trust_root_sha256: crypto.createHash('sha256').update(knowledgeVerifierPublicPem, 'utf8').digest('hex'),
    nonce: crypto.randomUUID(),
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 25 * 60_000).toISOString(),
    scope: ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_SCOPE,
    goal_id: knowledgeGoalId,
    snapshot_hash: knowledgeSnapshotRequest.snapshot.snapshot_hash,
    node_ids: knowledgeSnapshotRequest.snapshot.node_ids,
    edge_ids: knowledgeSnapshotRequest.snapshot.edge_ids,
    membership_ids: knowledgeSnapshotRequest.snapshot.membership_ids,
    evidence_manifest_hash: knowledgeSnapshotRequest.evidenceManifestHash,
    claim_status: 'verified',
    independence_status: 'verified',
    signature_algorithm: 'Ed25519'
  };
  const knowledgeAttestation = {
    ...knowledgeAttestationUnsigned,
    signature: crypto.sign(null, Buffer.from(canonicalJson(knowledgeAttestationUnsigned), 'utf8'), knowledgeVerifierKeys.privateKey).toString('base64')
  };
  const knowledgeAttestationStored = await tool('adaptive_goal_knowledge_snapshot_attest', { attestation: knowledgeAttestation });
  assert.equal(knowledgeAttestationStored.verified, true);
  assert.equal(knowledgeAttestationStored.created, true);
  assert.equal(knowledgeAttestationStored.claimVerified, true);
  assert.equal(knowledgeAttestationStored.independenceVerified, true);
  const knowledgeSnapshotVerified = await tool('adaptive_goal_knowledge_snapshot_get', { goal_id: knowledgeGoalId });
  assert.equal(knowledgeSnapshotVerified.currentVerification.verified, true, 'separate durable readback must observe the trusted verifier record');
  assert.equal(knowledgeSnapshotVerified.currentVerification.snapshotHash, knowledgeSnapshotRequest.snapshot.snapshot_hash);
  const verifiedKnowledgeSearch = await tool('adaptive_goal_knowledge_graph_search', {
    goal_id: knowledgeGoalId, start_node_id: knowledgeStartNodeId, goal_node_id: knowledgeGoalNodeId,
    expected_snapshot_hash: knowledgeSnapshotRequest.snapshot.snapshot_hash,
    options: { beamWidth: 16, maxDepth: 24, maxExpansions: 1024, maxAuditEvents: 1000 },
    plan_projection_options: { dependencyMode: 'source_edges_only' }
  });
  assert.equal(verifiedKnowledgeSearch.source.claimVerified, true);
  assert.equal(verifiedKnowledgeSearch.source.independenceVerified, true);
  assert.equal(verifiedKnowledgeSearch.knowledgeSnapshot.attestationId, knowledgeAttestationStored.attestationId);
  const verifiedDraft = verifiedKnowledgeSearch.planGraphDrafts.find(item => item.steps.length === 9);
  assert.ok(verifiedDraft, `verified persisted Goal/Idea Graph must produce nine Plan Graph steps: ${JSON.stringify(verifiedKnowledgeSearch.unprojectableCandidates)}`);
  assert.equal(verifiedDraft.source.verification.verified, true);
  assert.equal(verifiedDraft.source.verification.snapshotHash, knowledgeSnapshotRequest.snapshot.snapshot_hash);
  const verifiedStepByRole = new Map(ROLE_SPECS.map(spec => [spec.taskId,
    verifiedDraft.steps.find(step => step.sourceNodeId === knowledgeNodeIds.get(spec.nodeId))]));
  assert.equal([...verifiedStepByRole.values()].every(Boolean), true);
  const verifiedTaskBindings = ROLE_SPECS.map(spec => ({
    step_id: verifiedStepByRole.get(spec.taskId).id, task_id: spec.taskId, capability: spec.capability
  }));

  const beforeBlockedProposal = new DatabaseSync(dbPath, { readOnly: true });
  const beforeJobs = beforeBlockedProposal.prepare('SELECT COUNT(*) n FROM jobs').get().n;
  beforeBlockedProposal.close();
  const planProposalArgs = {
    knowledge_goal_id: knowledgeGoalId,
    knowledge_start_node_id: knowledgeStartNodeId,
    knowledge_goal_node_id: knowledgeGoalNodeId,
    knowledge_snapshot_hash: knowledgeSnapshotRequest.snapshot.snapshot_hash,
    candidate_plan_id: verifiedDraft.source.candidatePlanId,
    options: { beamWidth: 16, maxDepth: 24, maxExpansions: 1024, maxAuditEvents: 1000 },
    plan_projection_options: { dependencyMode: 'source_edges_only' },
    workflow_id: 'standard-engineering',
    task_bindings: verifiedTaskBindings.map(({ step_id, task_id }) => ({ step_id, task_id })),
    workspace,
    title: 'TEST ONLY: nine-child Plan Graph contract proposal'
  };

  // Inject a durable write failure after createJob() has run but before the
  // proposal event can be persisted. The proposal transaction must roll back
  // the job row too; after removing the trigger, a retry must create normally.
  const rollbackDb = new DatabaseSync(dbPath);
  rollbackDb.exec(`CREATE TRIGGER test_fail_agg_plan_proposal_event BEFORE INSERT ON events
    WHEN NEW.type='job.proposal_requested' AND json_extract(NEW.payload_json,'$.adaptive_goal_plan_proposal.schema_version')=1
    BEGIN SELECT RAISE(ABORT, 'injected Plan Graph event write failure'); END`);
  rollbackDb.close();
  const injectedProposalFailure = await rawTool('adaptive_goal_plan_proposal_create', planProposalArgs);
  assert.equal(injectedProposalFailure.isError, true, `injected event persistence failure must surface as a tool error: ${JSON.stringify(injectedProposalFailure)}`);
  const afterInjectedFailureDb = new DatabaseSync(dbPath);
  assert.equal(afterInjectedFailureDb.prepare('SELECT COUNT(*) n FROM jobs').get().n, beforeJobs,
    'job row created before a failed proposal event must be rolled back atomically');
  assert.equal(afterInjectedFailureDb.prepare("SELECT COUNT(*) n FROM events WHERE type='job.proposal_requested' AND json_extract(payload_json,'$.adaptive_goal_plan_proposal.schema_version')=1").get().n, 0);
  afterInjectedFailureDb.exec('DROP TRIGGER test_fail_agg_plan_proposal_event');
  afterInjectedFailureDb.close();

  // Race two independent server processes against the same SQLite DB on the
  // first proposal creation (not merely two requests serialized by one MCP
  // process). BEGIN IMMEDIATE should yield exactly one durable proposal and
  // one safe idempotent retry, with no duplicate jobs/events.
  const secondChild = spawn(process.execPath, [runtimeEntryPoint], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin', HOME: home, NODE_ENV: 'test', LANG: 'C.UTF-8', TMPDIR: temp, TEMP: temp, TMP: temp,
      AGG_KNOWLEDGE_VERIFICATION_PROVIDER_ID: KNOWLEDGE_VERIFIER_PROVIDER,
      AGG_KNOWLEDGE_VERIFICATION_TRUST_ROOT_PUBLIC_KEY_PEM: knowledgeVerifierPublicPem,
      AGG_REVIEW_IDENTITY_PROVIDER_ID: REVIEWER_IDENTITY_PROVIDER,
      AGG_REVIEW_IDENTITY_TRUST_ROOT_PUBLIC_KEY_PEM: reviewerIdentityPublicPem,
      RUNALITH_DATA_DIR: data, RUNALITH_WORKFLOW_DB: dbPath, RUNALITH_WORKSPACE: workspace, RUNALITH_EXECUTION_TMP_DIR: path.join(temp, 'execution-tmp'),
      CHAT_ON_STEROIDS_DATA_DIR: data, CHAT_ON_STEROIDS_WORKFLOW_DB: dbPath, CHAT_ON_STEROIDS_WORKSPACE: workspace,
      CHAT_ON_STEROIDS_EXECUTION_TMP_DIR: path.join(temp, 'execution-tmp'), WORKFLOW_DATA_DIR: data, WORKFLOW_DB: dbPath,
      WORKFLOW_WORKSPACE: workspace, EXECUTION_TMP_DIR: path.join(temp, 'execution-tmp')
    }
  });
  let secondStdout = '', secondStderr = '', secondNextId = 1, secondExited = false;
  const secondPending = new Map();
  const secondRpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = secondNextId++;
    const timer = setTimeout(() => { secondPending.delete(id); reject(new Error(`second-process MCP RPC timed out (${method})\n${secondStderr.slice(-3000)}`)); }, TOOL_TIMEOUT_MS);
    secondPending.set(id, { resolve, reject, timer });
    secondChild.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
      if (!error) return;
      const waiter = secondPending.get(id); if (!waiter) return;
      secondPending.delete(id); clearTimeout(waiter.timer); waiter.reject(error);
    });
  });
  const rejectSecondPending = error => {
    for (const [id, waiter] of secondPending) { clearTimeout(waiter.timer); secondPending.delete(id); waiter.reject(error); }
  };
  secondChild.stdout.setEncoding('utf8'); secondChild.stderr.setEncoding('utf8');
  secondChild.stdout.on('data', chunk => {
    secondStdout += chunk;
    let newline;
    while ((newline = secondStdout.indexOf('\n')) >= 0) {
      const line = secondStdout.slice(0, newline).trim(); secondStdout = secondStdout.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { rejectSecondPending(new Error(`second-process MCP stdout is not JSON: ${line.slice(0, 500)}`)); secondChild.kill('SIGKILL'); return; }
      const waiter = secondPending.get(message.id);
      if (message.id != null && waiter) { secondPending.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message); }
    }
  });
  secondChild.stderr.on('data', chunk => { secondStderr = (secondStderr + chunk).slice(-1024 * 1024); });
  secondChild.on('error', rejectSecondPending);
  secondChild.on('exit', (code, signal) => { secondExited = true; rejectSecondPending(new Error(`second MCP process exited code=${code} signal=${signal}\n${secondStderr.slice(-3000)}`)); });
  t.after(async () => {
    if (!secondExited) {
      secondChild.stdin.end();
      await new Promise(resolve => {
        const timer = setTimeout(() => { if (!secondExited) secondChild.kill('SIGTERM'); resolve(); }, 1500);
        secondChild.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    if (!secondExited) secondChild.kill('SIGKILL');
  });
  const secondInit = await secondRpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agg-independent-concurrent-proposal', version: '1' } });
  assert.equal(secondInit.error, undefined, JSON.stringify(secondInit.error));
  secondChild.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  const secondTool = async (name, args = {}) => {
    const response = await secondRpc('tools/call', { name, arguments: args });
    assert.equal(response.error, undefined, `${name} second-process RPC failed: ${JSON.stringify(response.error)}`);
    assert.notEqual(response.result?.isError, true, `${name} second-process tool failed: ${response.result?.content?.[0]?.text || JSON.stringify(response.result?.structuredContent)}`);
    if (response.result?.structuredContent) return response.result.structuredContent;
    const textItem = response.result?.content?.find(item => item.type === 'text');
    return textItem ? JSON.parse(textItem.text) : response.result;
  };
  const firstCreationRace = await Promise.all([
    tool('adaptive_goal_plan_proposal_create', planProposalArgs),
    secondTool('adaptive_goal_plan_proposal_create', { ...planProposalArgs, title: 'TEST ONLY: concurrent independent process proposal' })
  ]);
  assert.equal(firstCreationRace.filter(result => result.created === true).length, 1, JSON.stringify(firstCreationRace));
  assert.equal(firstCreationRace.filter(result => result.idempotent === true).length, 1, JSON.stringify(firstCreationRace));
  const planProposal = firstCreationRace.find(result => result.created === true);
  const idempotentPlanProposal = firstCreationRace.find(result => result.idempotent === true);
  assert.equal(idempotentPlanProposal.job_id, planProposal.job_id);
  assert.equal(idempotentPlanProposal.draftHash, planProposal.draftHash);
  assert.equal(planProposal.created, true, JSON.stringify(planProposal, null, 2));
  assert.equal(planProposal.requires_explicit_approval, true);
  assert.equal(planProposal.execution_authorized, false);
  const planGet = await tool('adaptive_goal_plan_proposal_get', { job_id: planProposal.job_id });
  assert.equal(planGet.found, true);
  assert.equal(planGet.compatibility.eligible, true);
  assert.equal(planGet.compatibility.bindings.length, 9);
  const afterPlan = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(afterPlan.prepare('SELECT COUNT(*) n FROM jobs').get().n, beforeJobs + 1, 'Plan Graph proposal is a distinct durable proposal row in the private test DB');
  assert.equal(afterPlan.prepare("SELECT COUNT(*) n FROM events WHERE type='job.proposal_requested' AND json_extract(payload_json,'$.adaptive_goal_plan_proposal.schema_version')=1").get().n, 1,
    'concurrent first-create requests must persist exactly one Plan Graph proposal event');
  afterPlan.close();

  // Approval binds only the Plan Graph review checklist. It cannot dispatch
  // mapped AGG actions, even though the generic review wrapper is APPROVED.
  const planWrapperPreflight = await tool('workflow_preflight', { job_id: planProposal.job_id });
  assert.equal(planWrapperPreflight.ready, true, JSON.stringify(planWrapperPreflight.blockers || [], null, 2));
  assert.equal(planWrapperPreflight.review_only_graph_wrapper, true);
  assert.equal(planWrapperPreflight.execution_authorized, false);
  const planWrapperApproval = await tool('workflow_approve', {
    job_id: planProposal.job_id,
    confirmation: 'TEST ONLY: approve the Plan Graph review checklist in the disposable SQLite database; no mapped AGG action execution is approved.'
  });
  assert.equal(planWrapperApproval.approved, true, JSON.stringify(planWrapperApproval, null, 2));
  assert.equal(planWrapperApproval.execution_authorized, false);
  assert.equal(planWrapperApproval.execution_enabled, false);
  assert.equal(planWrapperApproval.graph_review_kind, 'plan_graph');
  const planWrapperDispatch = await rawTool('workflow_dispatch', { job_id: planProposal.job_id });
  assert.equal(planWrapperDispatch.isError, true, 'Plan Graph review wrapper must not be dispatchable after approval');
  assert.match(planWrapperDispatch.content?.map(item => item.text || '').join('\\n') || '', /Plan Graph approval pins only the review-checklist plan/);
  const planWrapperAfterDispatchDenial = await tool('workflow_get', { job_id: planProposal.job_id });
  assert.equal(planWrapperAfterDispatchDenial.job.state, 'APPROVED');
  assert.equal(planWrapperAfterDispatchDenial.tasks.length, 0);
  assert.equal(planWrapperAfterDispatchDenial.job.active_task_id, null);

  // With real producer artifacts temporarily invalid, Execution Graph proposal creation must fail without writing a proposal job.
  const corruptDb = new DatabaseSync(dbPath);
  const currentArch = corruptDb.prepare('SELECT * FROM artifacts WHERE artifact_id=?').get(arch.artifact_id);
  corruptDb.prepare('UPDATE artifacts SET content_hash=? WHERE artifact_id=?').run('f'.repeat(64), arch.artifact_id);
  corruptDb.close();
  const beforeExecutionProposalDb = new DatabaseSync(dbPath, { readOnly: true });
  const beforeExecutionJobs = beforeExecutionProposalDb.prepare('SELECT COUNT(*) n FROM jobs').get().n;
  beforeExecutionProposalDb.close();
  const blockedExecutionProposal = await tool('adaptive_goal_execution_graph_proposal_create', {
    plan_proposal_job_id: planProposal.job_id, task_bindings: taskBindings,
    title: 'TEST ONLY: blocked Execution Graph proposal'
  });
  assert.equal(blockedExecutionProposal.created, false);
  assert.ok(['evidence_pending', 'blocked'].includes(blockedExecutionProposal.status));
  assert.equal(blockedExecutionProposal.gates.executionGraphMaterialized, false);
  const afterBlockedExecutionDb = new DatabaseSync(dbPath);
  assert.equal(afterBlockedExecutionDb.prepare('SELECT COUNT(*) n FROM jobs').get().n, beforeExecutionJobs, 'blocked Execution Graph creation must not write a workflow/proposal job');
  afterBlockedExecutionDb.prepare('UPDATE artifacts SET content=?, content_hash=? WHERE artifact_id=?').run(currentArch.content, currentArch.content_hash, arch.artifact_id);
  afterBlockedExecutionDb.close();

  const executionProposal = await tool('adaptive_goal_execution_graph_proposal_create', {
    plan_proposal_job_id: planProposal.job_id, task_bindings: verifiedTaskBindings,
    title: 'TEST ONLY: fresh nine-action Execution Graph proposal'
  });
  assert.equal(executionProposal.created, true, JSON.stringify(executionProposal, null, 2));
  assert.equal(executionProposal.execution_authorized, false);
  assert.equal(executionProposal.dispatch_started, false);
  const executionDispatchBeforeCandidate = await rawTool('workflow_dispatch', { job_id: executionProposal.job_id });
  assert.equal(executionDispatchBeforeCandidate.isError, true,
    'Execution Graph review wrapper cannot dispatch before exact action-intent candidate validation and trusted reviewer identity');
  assert.match(executionDispatchBeforeCandidate.content?.map(item => item.text || '').join('\n') || '', /Execution Graph transition requires a fresh action-intent candidate/);
  const executionWrapperAfterDeniedDispatch = await tool('workflow_get', { job_id: executionProposal.job_id });
  assert.equal(executionWrapperAfterDeniedDispatch.job.state, 'IDLE');
  assert.equal(executionWrapperAfterDeniedDispatch.plan, null);
  assert.equal(executionWrapperAfterDeniedDispatch.tasks.length, 0);
  const executionGet = await tool('adaptive_goal_execution_graph_proposal_get', { job_id: executionProposal.job_id });
  assert.equal(executionGet.found, true);
  assert.equal(executionGet.status, 'fresh');
  assert.equal(executionGet.gates.executionAuthorized, false);
  assert.equal(executionGet.gates.dispatchAllowed, false);
  assert.equal(executionGet.gates.immutableExecutionPlanCreated, false);

  const beforeExecutionRetryDb = new DatabaseSync(dbPath, { readOnly: true });
  const beforeExecutionRetryJobs = beforeExecutionRetryDb.prepare('SELECT COUNT(*) n FROM jobs').get().n;
  beforeExecutionRetryDb.close();
  const concurrentExecutionRetries = await Promise.all([1, 2].map(index => tool('adaptive_goal_execution_graph_proposal_create', {
    plan_proposal_job_id: planProposal.job_id, task_bindings: verifiedTaskBindings,
    title: `TEST ONLY: concurrent retry ${index} must resolve to the same Execution Graph proposal`
  })));
  for (const retriedExecutionProposal of concurrentExecutionRetries) {
    assert.equal(retriedExecutionProposal.created, false);
    assert.equal(retriedExecutionProposal.idempotent, true);
    assert.equal(retriedExecutionProposal.job_id, executionProposal.job_id);
    assert.equal(retriedExecutionProposal.proposalHash, executionProposal.proposalHash);
    assert.equal(retriedExecutionProposal.gates.executionAuthorized, false);
    assert.equal(retriedExecutionProposal.dispatch_started, false);
  }
  const afterExecutionRetryDb = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(afterExecutionRetryDb.prepare('SELECT COUNT(*) n FROM jobs').get().n, beforeExecutionRetryJobs,
    'retrying the same graph fingerprint must not create a duplicate workflow proposal');
  afterExecutionRetryDb.close();

  // Retry the already approved Plan Graph wrapper. Approval pins the review
  // plan, but the wrapper remains permanently non-dispatchable for AGG actions.
  const approvedWrapperRetry = await tool('adaptive_goal_plan_proposal_create', planProposalArgs);
  assert.equal(approvedWrapperRetry.created, false);
  assert.equal(approvedWrapperRetry.idempotent, true);
  assert.equal(approvedWrapperRetry.job_id, planProposal.job_id);
  assert.equal(approvedWrapperRetry.approved, true);
  assert.equal(approvedWrapperRetry.immutable_plan_pinned, true);
  assert.equal(approvedWrapperRetry.execution_authorized, false,
    'approval of a Plan Graph review wrapper is not Execution Graph action authorization');
  assert.equal(approvedWrapperRetry.dispatch_started, false, 'the response flag must not imply dispatch occurred');
  const approvedExecutionGet = await tool('adaptive_goal_execution_graph_proposal_get', { job_id: executionProposal.job_id });
  assert.equal(approvedExecutionGet.status, 'fresh');
  assert.equal(approvedExecutionGet.gates.executionAuthorized, false,
    'independent Execution Graph gate remains closed despite wrapper approval');

  // Tampering with the source Plan Graph snapshot must invalidate downstream
  // Execution Graph revalidation. Restore exact bytes after this private-DB
  // adversarial probe so later assertions see valid state.
  const tamperDb = new DatabaseSync(dbPath);
  const planProposalEvent = tamperDb.prepare("SELECT event_id,payload_json FROM events WHERE job_id=? AND type='job.proposal_requested'").get(planProposal.job_id);
  const originalPlanProposalPayload = planProposalEvent.payload_json;
  const tamperedPlanProposalPayload = JSON.parse(originalPlanProposalPayload);
  tamperedPlanProposalPayload.adaptive_goal_plan_proposal.draft.draftHash = '0'.repeat(64);
  tamperDb.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(JSON.stringify(tamperedPlanProposalPayload), planProposalEvent.event_id);
  tamperDb.close();
  const tamperedPlanRetry = await rawTool('adaptive_goal_plan_proposal_create', planProposalArgs);
  assert.equal(tamperedPlanRetry.isError, true,
    'retry must fail closed rather than report idempotent success for a tampered durable Plan Graph snapshot');
  assert.match(tamperedPlanRetry.content?.map(item => item.text || '').join('\n') || '',
    /SOURCE_DRAFT_HASH_MISMATCH|AGG_PLAN_PROPOSAL_IDEMPOTENCY_MISMATCH/);
  const downstreamTamperedRead = await tool('adaptive_goal_execution_graph_proposal_get', { job_id: executionProposal.job_id });
  assert.equal(downstreamTamperedRead.status, 'stale');
  const restoreDb = new DatabaseSync(dbPath);
  restoreDb.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(originalPlanProposalPayload, planProposalEvent.event_id);
  restoreDb.close();
  const restoredExecutionRead = await tool('adaptive_goal_execution_graph_proposal_get', { job_id: executionProposal.job_id });
  assert.equal(restoredExecutionRead.status, 'fresh');

  // Complete the isolated trusted-review success path only after proving stale
  // Plan Graph tampering is rejected and the exact bytes are restored.
  const executionGraphReviewProposal = restoredExecutionRead.proposal;
  assert.equal(executionGraphReviewProposal.source.verification.verified, true);
  assert.equal(executionGraphReviewProposal.source.verification.claimVerified, true);
  assert.equal(executionGraphReviewProposal.source.verification.independenceVerified, true);
  const executionGraphReviewBindings = new Map(executionGraphReviewProposal.bindings.map(binding => [binding.stepId, binding]));
  const reviewedActionIntents = {
    schemaVersion: 1,
    kind: 'adaptive_goal_reviewed_action_intents',
    source: {
      executionGraphFingerprint: executionGraphReviewProposal.fingerprint,
      executionGraphProposalHash: executionGraphReviewProposal.proposalHash,
      sourcePlanProposalJobId: executionGraphReviewProposal.source.planProposalJobId,
      sourceGraphHash: executionGraphReviewProposal.source.graphHash,
      planGraphDraftHash: executionGraphReviewProposal.source.draftHash,
      sourceCandidateId: executionGraphReviewProposal.source.candidatePlanId
    },
    review: {
      decision: 'reviewed_for_candidate_only',
      reviewerId: 'agg-e2e-human-reviewer',
      reviewedAt: new Date().toISOString(),
      acknowledgment: 'I_REVIEWED_ACTION_INTENTS_AND_INPUT_BINDINGS_FOR_CANDIDATE_REVIEW_ONLY'
    },
    actions: executionGraphReviewProposal.nodes.map(node => {
      const binding = executionGraphReviewBindings.get(node.sourceStepId);
      assert.ok(binding, 'each persisted Execution Graph node needs a unique explicit task binding');
      const taskInputs = [...node.inputContract.requiredArtifactTypes].sort().map(inputType => {
        const evidence = node.supportingEvidence.artifacts.filter(item => item.type === inputType)
          .sort((a, b) => a.reference.localeCompare(b.reference))[0];
        if (evidence) return { inputType, source: { kind: 'evidence', reference: evidence.reference } };
        const ancestorOutput = node.inputContract.mappedAncestorOutputs.filter(item => item.artifactType === inputType)
          .sort((a, b) => a.stepId.localeCompare(b.stepId))[0];
        assert.ok(ancestorOutput, `trusted-review acceptance requires either current ${inputType} evidence or a typed ancestor output for ${binding.role}`);
        return { inputType, source: { kind: 'ancestor_output', stepId: ancestorOutput.stepId } };
      });
      const semantic = getAdaptiveGoalActionIntentSemanticPolicy(binding.role);
      const successCriteria = [...getAgentContract(binding.role).completionCriteria].sort();
      const actionIntent = {
        operation: semantic.operation,
        target: { kind: 'work_item', reference: node.sourceStepId },
        description: canonicalAdaptiveGoalActionIntentDescription({
          operation: semantic.operation,
          target: { kind: 'work_item', reference: node.sourceStepId },
          outputArtifactType: node.outputEvidenceContract.type,
          successCriteria
        }),
        successCriteria
      };
      return {
        stepId: node.sourceStepId,
        taskId: binding.taskId,
        role: binding.role,
        capability: binding.capability,
        roleContractId: binding.roleContractId,
        roleContractVersion: binding.roleContractVersion,
        actionIntent,
        taskInputs,
        dependencyStepIds: node.dependencies.map(id => executionGraphReviewProposal.nodes.find(item => item.id === id).sourceStepId).sort(),
        evidenceRefs: node.supportingEvidence.artifacts.map(item => item.reference).sort()
      };
    })
  };
  const executionPlanCandidate = await tool('adaptive_goal_execution_plan_candidate_create', {
    job_id: executionProposal.job_id, reviewed_action_intents: reviewedActionIntents
  });
  assert.equal(executionPlanCandidate.created, true, JSON.stringify(executionPlanCandidate, null, 2));
  assert.equal(executionPlanCandidate.execution_authorized, false, 'candidate construction alone is never approval or dispatch authorization');
  assert.equal(executionPlanCandidate.candidate.gates.executionAuthorized, false);
  assert.equal(executionPlanCandidate.candidate.gates.dispatchAllowed, false);
  const candidateBeforeReviewerProof = await tool('adaptive_goal_execution_plan_candidate_get', { job_id: executionProposal.job_id });
  assert.equal(candidateBeforeReviewerProof.status, 'fresh');
  assert.equal(candidateBeforeReviewerProof.sourceGraphVerification.attestationId, knowledgeAttestationStored.attestationId);
  assert.equal(candidateBeforeReviewerProof.reviewerIdentityVerified, false);
  assert.equal(candidateBeforeReviewerProof.executionReviewReady, false);
  const preReviewerPreflight = await tool('workflow_preflight', { job_id: executionProposal.job_id });
  assert.equal(preReviewerPreflight.ready, false, 'current graph attestation alone is insufficient without a trusted reviewer identity attestation');
  assert.ok(preReviewerPreflight.blockers.some(item => item.code === 'AGG_ACTION_INTENT_REVIEWER_IDENTITY_UNVERIFIED'));
  const preReviewerApproval = await rawTool('workflow_approve', {
    job_id: executionProposal.job_id,
    confirmation: 'TEST ONLY: this attempt must be denied before the separate trusted reviewer proof exists.'
  });
  assert.equal(preReviewerApproval.isError, true, 'a signed Goal/Idea snapshot and review wrapper cannot substitute for action-intent reviewer attestation');
  const preReviewerDispatch = await rawTool('workflow_dispatch', { job_id: executionProposal.job_id });
  assert.equal(preReviewerDispatch.isError, true, 'dispatch must remain blocked before trusted reviewer identity and current approval');
  const preReviewerWorkflow = await tool('workflow_get', { job_id: executionProposal.job_id });
  assert.equal(preReviewerWorkflow.job.state, 'IDLE');
  assert.equal(preReviewerWorkflow.plan, null);
  assert.equal(preReviewerWorkflow.tasks.length, 0);

  // Simulate the separately deployed identity provider in this disposable
  // test only. The runtime receives no private key and independently verifies
  // the signed subject, scope, freshness, nonce, candidate and exact plan hash.
  const reviewerCandidate = executionPlanCandidate.candidate;
  const reviewerAttestationUnsigned = {
    schema_version: 1,
    kind: 'adaptive_goal_verified_reviewer_attestation',
    provider_id: REVIEWER_IDENTITY_PROVIDER,
    trust_root_sha256: crypto.createHash('sha256').update(reviewerIdentityPublicPem, 'utf8').digest('hex'),
    nonce: crypto.randomUUID(),
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 8 * 60_000).toISOString(),
    reviewer_subject: reviewedActionIntents.review.reviewerId,
    scope: ADAPTIVE_GOAL_REVIEWER_AUTHORIZATION_SCOPE,
    decision: 'reviewed_for_candidate_only',
    candidate: expectedAdaptiveGoalReviewerAttestationCandidate(executionProposal.job_id, reviewerCandidate),
    signature_algorithm: 'Ed25519'
  };
  const reviewerAttestation = {
    ...reviewerAttestationUnsigned,
    signature: crypto.sign(null, Buffer.from(canonicalJson(reviewerAttestationUnsigned), 'utf8'), reviewerIdentityKeys.privateKey).toString('base64')
  };
  const reviewerAttestationEventId = crypto.createHash('sha256')
    .update(`${executionProposal.job_id}|${ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT}|${reviewerCandidate.fingerprint}`).digest('hex');
  const reviewerAttestationDb = new DatabaseSync(dbPath);
  try {
    reviewerAttestationDb.prepare('INSERT INTO events(event_id,job_id,type,payload_json,created_at) VALUES(?,?,?,?,?)')
      .run(reviewerAttestationEventId, executionProposal.job_id, ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT,
        JSON.stringify(reviewerAttestation), reviewerAttestationUnsigned.issued_at);
  } finally { reviewerAttestationDb.close(); }

  const candidateReadBack = await tool('adaptive_goal_execution_plan_candidate_get', { job_id: executionProposal.job_id });
  assert.equal(candidateReadBack.found, true);
  assert.equal(candidateReadBack.status, 'fresh');
  assert.equal(candidateReadBack.reviewerIdentityVerified, true);
  assert.equal(candidateReadBack.executionReviewReady, true, JSON.stringify(candidateReadBack.blockers));
  assert.equal(candidateReadBack.sourceGraphVerification.attestationId, knowledgeAttestationStored.attestationId);
  const executionPreflightReady = await tool('workflow_preflight', { job_id: executionProposal.job_id });
  assert.equal(executionPreflightReady.ready, true, JSON.stringify(executionPreflightReady.blockers, null, 2));
  assert.equal(executionPreflightReady.execution_started, false);

  const executionApproval = await tool('workflow_approve', {
    job_id: executionProposal.job_id,
    confirmation: 'TEST ONLY: explicitly approve the exact trusted-review-bound immutable Execution Graph plan in disposable SQLite; no live or production authority.'
  });
  assert.equal(executionApproval.approved, true, JSON.stringify(executionApproval, null, 2));
  assert.equal(executionApproval.graph_review_kind, 'execution_graph');
  assert.equal(executionApproval.execution_authorized, true);
  assert.equal(executionApproval.mapped_agg_action_execution_authorized, true);
  assert.equal(executionApproval.plan.plan_hash, candidateReadBack.candidate.compiler.compilerPlanHash);
  const approvedExecutionReadBack = await tool('adaptive_goal_execution_plan_candidate_get', { job_id: executionProposal.job_id });
  assert.equal(approvedExecutionReadBack.wrapperApproved, true);
  assert.equal(approvedExecutionReadBack.immutablePlanPinned, true);
  assert.equal(approvedExecutionReadBack.immutablePlanHash, candidateReadBack.candidate.compiler.compilerPlanHash);
  assert.equal(approvedExecutionReadBack.executionReviewReady, true);

  const dispatchedExecution = await tool('workflow_dispatch', { job_id: executionProposal.job_id });
  assert.equal(dispatchedExecution.dispatched, true, JSON.stringify(dispatchedExecution, null, 2));
  assert.equal(dispatchedExecution.execution_authorized, true);
  const dispatchedWorkflowReadBack = await tool('workflow_get', { job_id: executionProposal.job_id });
  assert.equal(dispatchedWorkflowReadBack.job.state, 'EXECUTING');
  assert.equal(dispatchedWorkflowReadBack.plan.plan_hash, candidateReadBack.candidate.compiler.compilerPlanHash);
  assert.equal(dispatchedWorkflowReadBack.approvals.filter(item => item.decision === 'approved').length, 1);
  assert.ok(dispatchedWorkflowReadBack.tasks.some(task => task.role === 'cto' && task.task_id === dispatchedExecution.task.task_id));

  // Verify final lifecycle and graph lineage through a separate SQLite handle;
  // don't infer durability from the handler response alone.
  const acceptanceDb = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const persistedKnowledgeAttestation = acceptanceDb.prepare('SELECT * FROM adaptive_goal_knowledge_verifications WHERE attestation_id=?')
      .get(knowledgeAttestationStored.attestationId);
    assert.ok(persistedKnowledgeAttestation);
    assert.equal(persistedKnowledgeAttestation.snapshot_hash, knowledgeSnapshotRequest.snapshot.snapshot_hash);
    assert.equal(persistedKnowledgeAttestation.payload_json, canonicalJson(knowledgeAttestation));
    const persistedPlanSnapshot = JSON.parse(acceptanceDb.prepare("SELECT payload_json FROM events WHERE job_id=? AND type='job.proposal_requested'")
      .get(planProposal.job_id).payload_json).adaptive_goal_plan_proposal;
    assert.equal(persistedPlanSnapshot.knowledge_graph_snapshot.snapshot_hash, knowledgeSnapshotRequest.snapshot.snapshot_hash);
    assert.equal(persistedPlanSnapshot.knowledge_graph_snapshot.attestation_id, knowledgeAttestationStored.attestationId);
    assert.equal(persistedPlanSnapshot.draft.source.verification.verified, true);
    const persistedExecutionSnapshot = JSON.parse(acceptanceDb.prepare("SELECT payload_json FROM events WHERE job_id=? AND type='job.proposal_requested'")
      .get(executionProposal.job_id).payload_json).adaptive_goal_execution_graph_proposal;
    assert.equal(persistedExecutionSnapshot.execution_graph_proposal.source.verification.verified, true);
    assert.equal(acceptanceDb.prepare('SELECT COUNT(*) n FROM approvals WHERE job_id=? AND decision=\'approved\'').get(executionProposal.job_id).n, 1);
    assert.equal(acceptanceDb.prepare('SELECT COUNT(*) n FROM workflow_plans WHERE job_id=?').get(executionProposal.job_id).n, 1);
    assert.equal(acceptanceDb.prepare('SELECT COUNT(*) n FROM tasks WHERE job_id=? AND role=\'cto\'').get(executionProposal.job_id).n, 1);
    assert.equal(acceptanceDb.prepare('SELECT COUNT(*) n FROM attempts WHERE task_id=?').get(dispatchedExecution.task.task_id).n, 1);
    assert.equal(acceptanceDb.prepare('SELECT COUNT(*) n FROM events WHERE job_id=? AND type=?').get(executionProposal.job_id, ADAPTIVE_GOAL_REVIEWER_ATTESTATION_EVENT).n, 1);
  } finally { acceptanceDb.close(); }

  const finalDb = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const jobs = finalDb.prepare('SELECT COUNT(*) n FROM jobs').get().n;
    const planProposalRows = finalDb.prepare("SELECT COUNT(*) n FROM events WHERE type='job.proposal_requested' AND json_extract(payload_json,'$.adaptive_goal_plan_proposal.schema_version')=1").get().n;
    const executionProposalRows = finalDb.prepare("SELECT COUNT(*) n FROM events WHERE type='job.proposal_requested' AND json_extract(payload_json,'$.adaptive_goal_execution_graph_proposal.schema_version')=1").get().n;
    const knowledgeNodes = finalDb.prepare('SELECT COUNT(*) n FROM adaptive_goal_knowledge_nodes').get().n;
    const knowledgeEdges = finalDb.prepare('SELECT COUNT(*) n FROM adaptive_goal_knowledge_edges').get().n;
    assert.equal(planProposalRows, 1);
    assert.equal(executionProposalRows, 1);
    assert.equal(knowledgeNodes, 11, 'eleven typed Goal/Idea nodes were persisted through the knowledge-store API');
    assert.equal(knowledgeEdges, 22, 'ten nominal transition edges and twelve Plan DAG prerequisites were persisted');
    const plans = finalDb.prepare('SELECT COUNT(*) n FROM workflow_plans').get().n;
    const approvals = finalDb.prepare('SELECT COUNT(*) n FROM approvals').get().n;
    assert.equal(plans, 3, 'producer, Plan review wrapper, and independently authorized Execution Graph wrapper each pin exactly one immutable plan');
    assert.equal(approvals, 3, 'the source producer plus explicit Plan and trusted Execution Graph reviews are the only approved isolated jobs');
    console.log('AGG_CURRENT_SCOPE_PRODUCERS=PASS roles=9 typedArtifacts=9 exactHashAndLineage=verified privateDb=true');
    console.log('AGG_NINE_CHILD_DAG=PASS mappings=9 dependencies=preserved missingMapping=blocked invertedDependency=blocked');
    console.log('AGG_EXECUTION_READINESS=PASS contractReady=true evidenceReady=true claimVerified=isolated-trusted-attestation independentAttestations=isolated-trusted-attestation');
    console.log('AGG_FAIL_CLOSED_NEGATIVES=PASS hash schema missingCompletion invalidAttempt failedProducer unregisteredArtifact staleSourceGraph');
    console.log(`AGG_THREE_GRAPH_CHAIN=PASS producerJob=${created.job_id} planProposal=${planProposal.job_id} executionProposal=${executionProposal.job_id} jobs=${jobs} snapshotAttested=true reviewerIdentityVerified=true immutablePlanPinned=true dispatched=true isolatedDb=true`);
  } finally { finalDb.close(); }
});
