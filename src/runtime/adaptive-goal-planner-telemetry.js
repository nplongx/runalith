import { createHash, randomUUID } from 'node:crypto';

export const ADAPTIVE_GOAL_PLANNER_TELEMETRY_SCHEMA_VERSION = 2;
export const ADAPTIVE_GOAL_PLANNER_TOOLS = Object.freeze([
  'adaptive_goal_graph_search',
  'adaptive_goal_phase2_shadow_search',
  'adaptive_goal_phase3_mcts_shadow_search'
]);

const TOOL_SET = new Set(ADAPTIVE_GOAL_PLANNER_TOOLS);
const MAX_EVENT_JSON_BYTES = 24 * 1024;
const MAX_SNAPSHOT_JSON_BYTES = 128 * 1024;
const MAX_NODE_SNAPSHOT_JSON_BYTES = 12 * 1024;
const MAX_RUN_EVIDENCE_REFS = 5_000;
const TABLES = `
CREATE TABLE IF NOT EXISTS adaptive_goal_planner_telemetry_meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS adaptive_goal_planner_runs (
  run_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version IN (1,2)),
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
  tool_result_observed_duration_ms INTEGER CHECK(tool_result_observed_duration_ms IS NULL OR tool_result_observed_duration_ms >= 0),
  process_instance_id TEXT NOT NULL,
  request_sha256 TEXT,
  input_graph_sha256 TEXT,
  graph_hash TEXT,
  search_run_id TEXT,
  goal_id TEXT,
  goal_node_id TEXT,
  input_node_count INTEGER,
  input_edge_count INTEGER,
  observed_node_count INTEGER,
  observed_edge_count INTEGER,
  algorithm_status TEXT,
  termination_reason TEXT,
  candidate_count INTEGER,
  partial_candidate_count INTEGER,
  search_event_count INTEGER,
  search_event_count_recorded INTEGER NOT NULL DEFAULT 0,
  search_event_count_omitted INTEGER NOT NULL DEFAULT 0,
  search_events_truncated INTEGER NOT NULL DEFAULT 0 CHECK(search_events_truncated IN (0,1)),
  metrics_json TEXT NOT NULL DEFAULT '{}',
  candidates_json TEXT NOT NULL DEFAULT '[]',
  provenance_json TEXT NOT NULL,
  error_code TEXT,
  error_name TEXT,
  error_message TEXT,
  CHECK((status='running' AND finished_at IS NULL AND duration_ms IS NULL) OR
        (status IN ('completed','failed') AND finished_at IS NOT NULL AND duration_ms IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS adaptive_goal_planner_runs_started ON adaptive_goal_planner_runs(started_at DESC,run_id DESC);
CREATE INDEX IF NOT EXISTS adaptive_goal_planner_runs_status_started ON adaptive_goal_planner_runs(status,started_at DESC);
CREATE INDEX IF NOT EXISTS adaptive_goal_planner_runs_goal_started ON adaptive_goal_planner_runs(goal_id,started_at DESC);
CREATE INDEX IF NOT EXISTS adaptive_goal_planner_runs_graph_hash ON adaptive_goal_planner_runs(graph_hash);
CREATE TABLE IF NOT EXISTS adaptive_goal_planner_run_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES adaptive_goal_planner_runs(run_id),
  sequence INTEGER NOT NULL CHECK(sequence >= 1),
  event_type TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  event_source TEXT NOT NULL CHECK(event_source IN ('runtime','search_observer')),
  payload_json TEXT NOT NULL,
  payload_truncated INTEGER NOT NULL DEFAULT 0 CHECK(payload_truncated IN (0,1)),
  UNIQUE(run_id,sequence)
);
CREATE INDEX IF NOT EXISTS adaptive_goal_planner_run_events_run_sequence ON adaptive_goal_planner_run_events(run_id,sequence);
CREATE INDEX IF NOT EXISTS adaptive_goal_planner_run_events_type_observed ON adaptive_goal_planner_run_events(event_type,observed_at DESC);
CREATE TRIGGER IF NOT EXISTS adaptive_goal_planner_run_events_count_search_step AFTER INSERT ON adaptive_goal_planner_run_events
WHEN NEW.event_source='search_observer'
BEGIN
  UPDATE adaptive_goal_planner_runs SET search_event_count_recorded=search_event_count_recorded+1
  WHERE run_id=NEW.run_id AND status='running';
END;
CREATE TABLE IF NOT EXISTS adaptive_goal_planner_run_nodes (
  run_id TEXT NOT NULL REFERENCES adaptive_goal_planner_runs(run_id),
  node_id TEXT NOT NULL,
  node_type TEXT,
  label TEXT,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('caller_graph','persisted_knowledge')),
  knowledge_goal_id TEXT,
  revision INTEGER,
  content_hash TEXT,
  provenance_hash TEXT,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  node_snapshot_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(run_id,node_id)
);
CREATE INDEX IF NOT EXISTS adaptive_goal_planner_run_nodes_node ON adaptive_goal_planner_run_nodes(node_id,run_id);
CREATE INDEX IF NOT EXISTS adaptive_goal_planner_run_nodes_revision ON adaptive_goal_planner_run_nodes(node_id,revision,run_id);
CREATE TABLE IF NOT EXISTS adaptive_goal_planner_run_edges (
  run_id TEXT NOT NULL REFERENCES adaptive_goal_planner_runs(run_id),
  edge_key TEXT NOT NULL,
  edge_id TEXT,
  goal_id TEXT,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('caller_graph','persisted_knowledge','composed_graph')),
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  edge_snapshot_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(run_id,edge_key)
);
CREATE INDEX IF NOT EXISTS adaptive_goal_planner_run_edges_from ON adaptive_goal_planner_run_edges(run_id,from_node_id);
CREATE INDEX IF NOT EXISTS adaptive_goal_planner_run_edges_to ON adaptive_goal_planner_run_edges(run_id,to_node_id);
CREATE INDEX IF NOT EXISTS adaptive_goal_planner_run_edges_persisted_id ON adaptive_goal_planner_run_edges(edge_id);
CREATE TABLE IF NOT EXISTS adaptive_goal_planner_run_goals (
  run_id TEXT NOT NULL REFERENCES adaptive_goal_planner_runs(run_id),
  goal_id TEXT NOT NULL,
  goal_kind TEXT NOT NULL CHECK(goal_kind IN ('knowledge_scope','graph_goal_node','graph_goal_type')),
  source_kind TEXT NOT NULL,
  PRIMARY KEY(run_id,goal_id,goal_kind)
);
CREATE INDEX IF NOT EXISTS adaptive_goal_planner_run_goals_goal ON adaptive_goal_planner_run_goals(goal_id,run_id);
CREATE TABLE IF NOT EXISTS adaptive_goal_planner_run_evidence (
  run_id TEXT NOT NULL REFERENCES adaptive_goal_planner_runs(run_id),
  reference TEXT NOT NULL,
  source_node_id TEXT NOT NULL DEFAULT '',
  observation_source TEXT NOT NULL CHECK(observation_source IN ('declared_graph_reference','runtime_resolver')),
  kind TEXT,
  classification TEXT,
  artifact_id TEXT,
  source_job_id TEXT,
  content_hash TEXT,
  lineage_verified INTEGER,
  claim_verified INTEGER,
  details_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(run_id,reference,source_node_id,observation_source)
);
CREATE INDEX IF NOT EXISTS adaptive_goal_planner_run_evidence_reference ON adaptive_goal_planner_run_evidence(reference,run_id);
CREATE INDEX IF NOT EXISTS adaptive_goal_planner_run_evidence_artifact ON adaptive_goal_planner_run_evidence(artifact_id,run_id);
CREATE TRIGGER IF NOT EXISTS adaptive_goal_planner_events_no_update BEFORE UPDATE ON adaptive_goal_planner_run_events BEGIN SELECT RAISE(ABORT,'AGG planner telemetry events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS adaptive_goal_planner_events_no_delete BEFORE DELETE ON adaptive_goal_planner_run_events BEGIN SELECT RAISE(ABORT,'AGG planner telemetry events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS adaptive_goal_planner_run_nodes_no_update BEFORE UPDATE ON adaptive_goal_planner_run_nodes BEGIN SELECT RAISE(ABORT,'AGG planner node snapshots are append-only'); END;
CREATE TRIGGER IF NOT EXISTS adaptive_goal_planner_run_nodes_no_delete BEFORE DELETE ON adaptive_goal_planner_run_nodes BEGIN SELECT RAISE(ABORT,'AGG planner node snapshots are append-only'); END;
CREATE TRIGGER IF NOT EXISTS adaptive_goal_planner_run_edges_no_update BEFORE UPDATE ON adaptive_goal_planner_run_edges BEGIN SELECT RAISE(ABORT,'AGG planner edge snapshots are append-only'); END;
CREATE TRIGGER IF NOT EXISTS adaptive_goal_planner_run_edges_no_delete BEFORE DELETE ON adaptive_goal_planner_run_edges BEGIN SELECT RAISE(ABORT,'AGG planner edge snapshots are append-only'); END;
CREATE TRIGGER IF NOT EXISTS adaptive_goal_planner_run_goals_no_update BEFORE UPDATE ON adaptive_goal_planner_run_goals BEGIN SELECT RAISE(ABORT,'AGG planner goal links are append-only'); END;
CREATE TRIGGER IF NOT EXISTS adaptive_goal_planner_run_goals_no_delete BEFORE DELETE ON adaptive_goal_planner_run_goals BEGIN SELECT RAISE(ABORT,'AGG planner goal links are append-only'); END;
CREATE TRIGGER IF NOT EXISTS adaptive_goal_planner_run_evidence_no_update BEFORE UPDATE ON adaptive_goal_planner_run_evidence BEGIN SELECT RAISE(ABORT,'AGG planner evidence observations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS adaptive_goal_planner_run_evidence_no_delete BEFORE DELETE ON adaptive_goal_planner_run_evidence BEGIN SELECT RAISE(ABORT,'AGG planner evidence observations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS adaptive_goal_planner_runs_terminal_immutable BEFORE UPDATE ON adaptive_goal_planner_runs WHEN OLD.status <> 'running' BEGIN SELECT RAISE(ABORT,'terminal AGG planner runs are immutable'); END;
CREATE TRIGGER IF NOT EXISTS adaptive_goal_planner_runs_no_delete BEFORE DELETE ON adaptive_goal_planner_runs BEGIN SELECT RAISE(ABORT,'AGG planner runs are retained as durable history'); END;
`;
const RUNS_TABLE_V2_MIGRATION_DDL = `CREATE TABLE adaptive_goal_planner_runs_v2 (
  run_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version IN (1,2)),
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
  tool_result_observed_duration_ms INTEGER CHECK(tool_result_observed_duration_ms IS NULL OR tool_result_observed_duration_ms >= 0),
  process_instance_id TEXT NOT NULL,
  request_sha256 TEXT,
  input_graph_sha256 TEXT,
  graph_hash TEXT,
  search_run_id TEXT,
  goal_id TEXT,
  goal_node_id TEXT,
  input_node_count INTEGER,
  input_edge_count INTEGER,
  observed_node_count INTEGER,
  observed_edge_count INTEGER,
  algorithm_status TEXT,
  termination_reason TEXT,
  candidate_count INTEGER,
  partial_candidate_count INTEGER,
  search_event_count INTEGER,
  search_event_count_recorded INTEGER NOT NULL DEFAULT 0,
  search_event_count_omitted INTEGER NOT NULL DEFAULT 0,
  search_events_truncated INTEGER NOT NULL DEFAULT 0 CHECK(search_events_truncated IN (0,1)),
  metrics_json TEXT NOT NULL DEFAULT '{}',
  candidates_json TEXT NOT NULL DEFAULT '[]',
  provenance_json TEXT NOT NULL,
  error_code TEXT,
  error_name TEXT,
  error_message TEXT,
  CHECK((status='running' AND finished_at IS NULL AND duration_ms IS NULL) OR
        (status IN ('completed','failed') AND finished_at IS NOT NULL AND duration_ms IS NOT NULL))
);`;

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function safeText(value, max = 500) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
}
function stableValue(value, depth = 0) {
  if (depth > 36) throw new TypeError('telemetry request exceeds maximum JSON depth');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
  if (Array.isArray(value)) return value.map(item => stableValue(item, depth + 1));
  if (!isRecord(value)) return null;
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (key === '__proto__') throw new TypeError('telemetry digest contains a forbidden JSON key');
    Object.defineProperty(output, key, { value: stableValue(value[key], depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return output;
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function stableJson(value) { return JSON.stringify(stableValue(value)); }
function byteLength(value) { return Buffer.byteLength(value, 'utf8'); }
function jsonWithin(value, maxBytes, fallback = '{}') {
  try {
    const json = JSON.stringify(stableValue(value));
    if (byteLength(json) <= maxBytes) return { json, truncated: false };
    const reduced = JSON.stringify({ truncated: true, preview: json.slice(0, Math.max(0, maxBytes - 96)) });
    return { json: byteLength(reduced) <= maxBytes ? reduced : fallback, truncated: true };
  } catch {
    return { json: fallback, truncated: true };
  }
}
function graphOf(value) { return isRecord(value) && Array.isArray(value.nodes) && Array.isArray(value.edges) ? value : null; }
function finiteCount(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function graphLabel(node) {
  if (!isRecord(node)) return null;
  const value = [node.label, node.title, node.name, node.stableKey, node.stable_key].find(item => typeof item === 'string' && item.trim());
  return safeText(value, 500);
}
function graphEvidenceRefs(node) {
  return Array.isArray(node?.evidenceRefs) ? [...new Set(node.evidenceRefs.filter(ref => typeof ref === 'string' && ref.trim()).map(ref => ref.trim()))].slice(0, 64) : [];
}
function observedMetrics(result, durationMs) {
  const search = isRecord(result?.search) ? result.search : {};
  const trace = isRecord(result?.auditTrace) ? result.auditTrace : {};
  const counters = isRecord(trace.counters) ? trace.counters : {};
  const metrics = {
    total_duration_ms: Number.isSafeInteger(durationMs) && durationMs >= 0 ? durationMs : null,
    expansions: finiteCount(search.expansions) ?? finiteCount(counters.expansions),
    generated_states: finiteCount(search.generatedStates) ?? finiteCount(counters.generatedStates),
    expanded_states: finiteCount(search.expandedStates) ?? finiteCount(counters.expandedStates),
    pruned_states: finiteCount(search.prunedStates) ?? finiteCount(counters.prunedStates),
    explored_depth: finiteCount(search.exploredDepth),
    simulations: finiteCount(search.simulations) ?? finiteCount(counters.simulations),
    work_units: finiteCount(search.workUnits) ?? finiteCount(counters.workUnits),
    termination_reason: safeText(search.terminationReason, 160),
    exhaustive: typeof search.exhaustive === 'boolean' ? search.exhaustive : null,
    candidate_count: Array.isArray(result?.candidates) ? result.candidates.length : null,
    partial_candidate_count: Array.isArray(result?.bestPartialCandidates) ? result.bestPartialCandidates.length : null,
    audit_event_count: finiteCount(trace.eventCount),
    audit_events_omitted: finiteCount(trace.omittedEventCount),
    audit_events_truncated: typeof trace.truncated === 'boolean' ? trace.truncated : null,
    counters: Object.keys(counters).length ? counters : null,
    outcome_mode: safeText(search.outcomeMode, 120),
    ranking_mode: safeText(search.rankingMode, 120),
    heuristic_version: safeText(search.heuristicVersion, 120),
    model_sha256: /^[a-f0-9]{64}$/.test(search.discriminatorModelSha256 || '') ? search.discriminatorModelSha256 :
      (/^[a-f0-9]{64}$/.test(trace.modelSha256 || '') ? trace.modelSha256 : null)
  };
  return Object.fromEntries(Object.entries(metrics).filter(([, value]) => value !== null));
}
function candidateSummary(result) {
  const select = (candidate, kind) => ({
    plan_id: safeText(candidate?.planId || candidate?.id, 200),
    kind: safeText(candidate?.candidateKind || kind, 100),
    status: safeText(candidate?.status, 120),
    path_node_ids: Array.isArray(candidate?.pathNodeIds) ? candidate.pathNodeIds.filter(x => typeof x === 'string').slice(0, 128) : [],
    path_edge_types: Array.isArray(candidate?.pathEdgeTypes) ? candidate.pathEdgeTypes.filter(x => typeof x === 'string').slice(0, 128) : [],
    depth: finiteCount(candidate?.depth),
    metrics: isRecord(candidate?.metrics) ? candidate.metrics : null,
    verification: isRecord(candidate?.verification) ? candidate.verification : null
  });
  return [
    ...(Array.isArray(result?.candidates) ? result.candidates.slice(0, 100).map(item => select(item, 'candidate')) : []),
    ...(Array.isArray(result?.bestPartialCandidates) ? result.bestPartialCandidates.slice(0, 100).map(item => select(item, 'partial_candidate')) : [])
  ];
}
function resolverEvidenceSummary(item) {
  const allowed = new Set([
    'kind','classification','artifactId','sourceJobId','contentHash','lineageVerified','claimVerified',
    'integrityVerified','artifactType','artifactStatus','artifactCreatedEventId','schemaVersion',
    'producerContractValid','producerRole','producerTaskId','producerTaskStatus','producerTaskCompleted',
    'producerResultId','producerResultOutcome','producerResultLineageValid','producerCompletionEventId',
    'producerCompletionEventType','sourceBytesSha256','byteLength','referenceKind','sourceKind',
    'independentAttestationVerified'
  ]);
  const output = {};
  for (const [key,value] of Object.entries(isRecord(item) ? item : {})) {
    if (!allowed.has(key)) continue;
    if (typeof value === 'string') output[key] = safeText(value, 500);
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) output[key] = value;
    else if (value === null) output[key] = null;
  }
  return output;
}
function sensitiveFreeError(error) {
  let message = safeText(error?.message || String(error), 2000) || 'unknown runtime error';
  message = message.replace(/(bearer\s+)[A-Za-z0-9._~+/-]+/ig, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+/ig, '$1[REDACTED]');
  return message;
}

/** Durable instrumentation of real AGG search invocations. Uses the runtime's injected writable SQLite handle. */
export function createAdaptiveGoalPlannerTelemetryStore(db, { processInstanceId = randomUUID(), serverVersion = null } = {}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') throw new TypeError('AdaptiveGoalPlannerTelemetryStore: db must be an injected DatabaseSync-compatible connection');
  const tableExists = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const priorMeta = tableExists('adaptive_goal_planner_telemetry_meta')
    ? db.prepare("SELECT value FROM adaptive_goal_planner_telemetry_meta WHERE key='schema_version'").get() : null;
  const priorVersion = priorMeta ? Number(priorMeta.value) : 0;
  const priorRunColumns = tableExists('adaptive_goal_planner_runs')
    ? new Set(db.prepare('PRAGMA table_info(adaptive_goal_planner_runs)').all().map(column => column.name)) : new Set();
  const rebuildLegacyRunTable = priorVersion === 1 && tableExists('adaptive_goal_planner_runs') && !priorRunColumns.has('tool_result_observed_duration_ms');
  const priorForeignKeys = Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys || 0);
  if (rebuildLegacyRunTable && priorForeignKeys) db.exec('PRAGMA foreign_keys=OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(TABLES);
      const existing = db.prepare("SELECT value FROM adaptive_goal_planner_telemetry_meta WHERE key='schema_version'").get();
      const version = existing ? Number(existing.value) : 0;
      if (!Number.isSafeInteger(version) || version > ADAPTIVE_GOAL_PLANNER_TELEMETRY_SCHEMA_VERSION) {
        throw new Error(`unsupported AGG planner telemetry schema version: ${existing?.value}`);
      }
      let runColumns = new Set(db.prepare('PRAGMA table_info(adaptive_goal_planner_runs)').all().map(column => column.name));
      if (!runColumns.has('tool_result_observed_duration_ms')) {
        if (version !== 1) throw new Error(`AGG planner telemetry schema ${version} is missing tool_result_observed_duration_ms`);
        // Version 1 constrained each run row to schema_version=1. Rebuild the parent
        // table transactionally so new rows can use v2, preserving every legacy field
        // and all foreign-key-linked event/snapshot rows by ID.
        db.exec('DROP TRIGGER IF EXISTS adaptive_goal_planner_runs_terminal_immutable; DROP TRIGGER IF EXISTS adaptive_goal_planner_runs_no_delete; DROP TRIGGER IF EXISTS adaptive_goal_planner_run_events_count_search_step;');
        db.exec(RUNS_TABLE_V2_MIGRATION_DDL);
        const copiedColumns = [...runColumns].filter(name => name !== 'tool_result_observed_duration_ms');
        const columnList = copiedColumns.map(name => `"${name}"`).join(',');
        db.exec(`INSERT INTO adaptive_goal_planner_runs_v2 (${columnList}) SELECT ${columnList} FROM adaptive_goal_planner_runs`);
        db.exec('DROP TABLE adaptive_goal_planner_runs; ALTER TABLE adaptive_goal_planner_runs_v2 RENAME TO adaptive_goal_planner_runs;');
        db.exec(TABLES); // Recreate indexes and run-table guards after the rebuild.
        runColumns = new Set(db.prepare('PRAGMA table_info(adaptive_goal_planner_runs)').all().map(column => column.name));
      }
      if (!runColumns.has('tool_result_observed_duration_ms')) throw new Error('AGG planner telemetry v2 migration failed to add terminal timing fields');
      db.prepare("INSERT INTO adaptive_goal_planner_telemetry_meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(String(ADAPTIVE_GOAL_PLANNER_TELEMETRY_SCHEMA_VERSION));
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  } finally {
    if (rebuildLegacyRunTable && priorForeignKeys) db.exec('PRAGMA foreign_keys=ON');
  }

  const stmt = sql => db.prepare(sql);
  const activeRuns = new Map();
  const insertEvent = stmt(`INSERT INTO adaptive_goal_planner_run_events(run_id,sequence,event_type,observed_at,event_source,payload_json,payload_truncated)
    VALUES(?,?,?,?,?,?,?)`);
  function appendEvent(runId, event, eventSource = 'runtime', observedAt = new Date().toISOString()) {
    const active = activeRuns.get(runId);
    const next = active ? active.eventSequence + 1 : Number(stmt('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM adaptive_goal_planner_run_events WHERE run_id=?').get(runId)?.sequence || 1);
    const type = safeText(event?.event_type || event?.type, 120) || 'observed_event';
    const payload = jsonWithin(event, MAX_EVENT_JSON_BYTES);
    insertEvent.run(runId, Number(next), type, observedAt, eventSource, payload.json, payload.truncated ? 1 : 0);
    if (active) active.eventSequence = Number(next);
    return Number(next);
  }
  function buildProvenance(run) {
    return {
      source: `mcp-tool:${run.toolName}`,
      source_kind: 'runtime_observation',
      runtime_version: safeText(serverVersion, 80),
      process_instance_id: processInstanceId,
      request_sha256: run.requestSha256,
      input_graph_sha256: run.inputGraphSha256,
      input_hash_semantics: run.inputGraphSha256 ? 'sha256-of-canonicalized-received-graph-json' : 'unavailable_invalid_or_oversized_input',
      lifecycle_semantics: 'completed means the MCP tool returned a result; failed means the tool invocation threw; algorithm_status is recorded separately',
      metric_semantics: 'only explicit finite/integer fields returned by the observed search implementation are persisted; absent values remain unknown'
    };
  }
  function beginRun({ toolName, args = {}, startedMono = process.hrtime.bigint() }) {
    if (!TOOL_SET.has(toolName)) throw new TypeError(`unsupported AGG planner telemetry tool: ${toolName}`);
    const runId = randomUUID(); const startedAt = new Date().toISOString();
    const graph = graphOf(args.graph);
    let requestSha256 = null; let inputGraphSha256 = null;
    try {
      const json = stableJson({ tool_name: toolName, arguments: args ?? null });
      if (byteLength(json) <= 4 * 1024 * 1024) requestSha256 = sha256(json);
    } catch {}
    try {
      if (args.graph !== undefined) {
        const json = stableJson(args.graph);
        if (byteLength(json) <= 2 * 1024 * 1024) inputGraphSha256 = sha256(json);
      }
    } catch {}
    const goalId = safeText(args.knowledge_goal_id, 200);
    const goalNodeId = safeText(graph?.goalNodeId, 200);
    const run = {
      runId, toolName, args, graph, startedAt, startedMono,
      requestSha256, inputGraphSha256, goalId, goalNodeId, algorithmResult: null, observedGraph: graph,
      knowledgeSnapshot: null, eventSequence: 0
    };
    const provenanceJson = JSON.stringify(buildProvenance(run));
    activeRuns.set(runId,run);
    db.exec('BEGIN IMMEDIATE');
    try {
      stmt(`INSERT INTO adaptive_goal_planner_runs(run_id,schema_version,tool_name,status,started_at,process_instance_id,request_sha256,input_graph_sha256,goal_id,goal_node_id,input_node_count,input_edge_count,provenance_json)
        VALUES(?,?,?,'running',?,?,?,?,?,?,?,?,?)`)
        .run(runId, ADAPTIVE_GOAL_PLANNER_TELEMETRY_SCHEMA_VERSION, toolName, startedAt, processInstanceId, requestSha256, inputGraphSha256, goalId, goalNodeId,
          finiteCount(graph?.nodes?.length), finiteCount(graph?.edges?.length), provenanceJson);
      // Commit the received graph and its declared evidence refs before search begins.
      // If the process exits before returning, this non-terminal run still has its inputs.
      persistGraphSnapshot(run, graph, null, null, null);
      appendEvent(runId, { event_type: 'run_started', tool_name: toolName, request_sha256: requestSha256, input_graph_sha256: inputGraphSha256 }, 'runtime', startedAt);
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} activeRuns.delete(runId); throw error; }
    return { runId, startedAt };
  }

  function recordSearchEvent(runId, event) {
    if (!activeRuns.has(runId)) throw new Error('AGG planner telemetry run context is no longer active');
    const payload = { ...event };
    const eventTime = typeof payload.observedAt === 'string' ? payload.observedAt : new Date().toISOString();
    delete payload.observedAt;
    appendEvent(runId, payload, 'search_observer', eventTime);
  }

  function observeSearchInput(runId, graph, knowledgeSnapshot = null) {
    const run = activeRuns.get(runId);
    if (!run) throw new Error('AGG planner telemetry run context is no longer active');
    run.observedGraph = graphOf(graph) || run.graph;
    run.knowledgeSnapshot = isRecord(knowledgeSnapshot) ? knowledgeSnapshot : null;
    db.exec('BEGIN IMMEDIATE');
    try {
      const counts = persistGraphSnapshot(run, run.observedGraph, null, run.knowledgeSnapshot, null);
      appendEvent(runId, {
        event_type: 'search_input_observed',
        input_graph_sha256: run.inputGraphSha256,
        composed_graph_hash: /^[a-f0-9]{64}$/.test(knowledgeSnapshot?.snapshotHash || '') ? knowledgeSnapshot.snapshotHash : null,
        observed_node_count: counts.nodeCount, observed_edge_count: counts.edgeCount,
        knowledge_scope_id: run.goalId
      }, 'runtime');
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }

  function observeAlgorithmResult(runId, result, graphInput, knowledgeSnapshot = null) {
    const run = activeRuns.get(runId);
    if (!run) throw new Error('AGG planner telemetry run context is no longer active');
    run.algorithmResult = result;
    run.observedGraph = graphOf(result?.effectiveGraph) || graphOf(graphInput) || run.graph;
    run.knowledgeSnapshot = isRecord(knowledgeSnapshot) ? knowledgeSnapshot : null;
    const summary = observedMetrics(result, null);
    appendEvent(runId, {
      event_type: 'algorithm_result_observed', algorithm_status: safeText(result?.status, 120),
      graph_hash: /^[a-f0-9]{64}$/.test(result?.graphHash || '') ? result.graphHash : null,
      search_run_id: safeText(result?.search?.searchRunId || result?.auditTrace?.searchRunId, 200),
      metrics: summary
    }, 'runtime');
  }

  function persistGraphSnapshot(run, graphInput, result, knowledgeSnapshot, resolvedResult) {
    const graph = graphOf(graphInput) || run.graph;
    if (!graph) return { nodeCount: null, edgeCount: null };
    const nodeHashes = new Map((Array.isArray(knowledgeSnapshot?.nodeContentHashes) ? knowledgeSnapshot.nodeContentHashes : [])
      .filter(item => isRecord(item) && typeof item.id === 'string')
      .map(item => [item.id, item]));
    const evidenceSourceByRef = new Map();
    for (const field of ['artifactEvidence', 'sourceEvidence']) {
      for (const item of Array.isArray(resolvedResult?.[field]) ? resolvedResult[field] : []) {
        if (typeof item?.reference === 'string') evidenceSourceByRef.set(`${field}\0${item.reference}`, item);
      }
    }
    const insertNode = stmt(`INSERT OR IGNORE INTO adaptive_goal_planner_run_nodes(run_id,node_id,node_type,label,source_kind,knowledge_goal_id,revision,content_hash,provenance_hash,evidence_refs_json,node_snapshot_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    const insertEdge = stmt(`INSERT OR IGNORE INTO adaptive_goal_planner_run_edges(run_id,edge_key,edge_id,goal_id,from_node_id,to_node_id,edge_type,source_kind,evidence_refs_json,edge_snapshot_json)
      VALUES(?,?,?,?,?,?,?,?,?,?)`);
    const insertGoal = stmt('INSERT OR IGNORE INTO adaptive_goal_planner_run_goals(run_id,goal_id,goal_kind,source_kind) VALUES(?,?,?,?)');
    const insertEvidence = stmt(`INSERT OR IGNORE INTO adaptive_goal_planner_run_evidence(run_id,reference,source_node_id,observation_source,kind,classification,artifact_id,source_job_id,content_hash,lineage_verified,claim_verified,details_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    const storedEdgeIds = new Set(Array.isArray(knowledgeSnapshot?.storedEdgeIds) ? knowledgeSnapshot.storedEdgeIds : []);
    const storedEdgeRows = storedEdgeIds.size && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='adaptive_goal_knowledge_edges'").get()
      ? stmt(`SELECT edge_id,goal_id,from_id,to_id,type FROM adaptive_goal_knowledge_edges WHERE edge_id IN (${[...storedEdgeIds].map(() => '?').join(',')})`).all(...storedEdgeIds)
      : [];
    const storedEdgeByShape = new Map(storedEdgeRows.map(edge => [`${edge.from_id}\0${edge.to_id}\0${edge.type}`, edge]));
    const refsWritten = new Set();
    const observedGoalId = safeText(run.goalId || run.goalNodeId || result?.goalNodeId || graph.goalNodeId, 200);
    if (run.goalId) insertGoal.run(run.runId, run.goalId, 'knowledge_scope', 'request_arguments');
    const goalNodeId = safeText(result?.goalNodeId || graph.goalNodeId, 200);
    if (goalNodeId) insertGoal.run(run.runId, goalNodeId, 'graph_goal_node', 'validated_search_graph');
    for (const node of graph.nodes.slice(0, 500)) {
      if (!isRecord(node) || typeof node.id !== 'string' || !node.id.trim() || node.id.length > 512) continue;
      const known = nodeHashes.get(node.id);
      const refs = graphEvidenceRefs(node);
      const snapshot = jsonWithin({
        label: graphLabel(node), type: safeText(node.type, 80),
        metrics: Object.fromEntries(['estimatedCost','estimatedRisk','estimatedSuccessConfidence','reusePotential','informationValue']
          .filter(key => node[key] === null || (typeof node[key] === 'number' && Number.isFinite(node[key])))
          .map(key => [key, node[key]])),
        evidence_refs: refs
      }, MAX_NODE_SNAPSHOT_JSON_BYTES);
      insertNode.run(run.runId, node.id, safeText(node.type, 80), graphLabel(node), known ? 'persisted_knowledge' : 'caller_graph',
        known ? observedGoalId : null, known && Number.isSafeInteger(known.revision) ? known.revision : null,
        known && /^[a-f0-9]{64}$/.test(known.contentHash || '') ? known.contentHash : null,
        known && /^[a-f0-9]{64}$/.test(known.provenanceHash || '') ? known.provenanceHash : null,
        JSON.stringify(refs), snapshot.json);
      if (node.type === 'goal') insertGoal.run(run.runId, node.id, 'graph_goal_type', 'validated_search_graph');
      for (const reference of refs) {
        if (refsWritten.size < MAX_RUN_EVIDENCE_REFS) {
          refsWritten.add(`${reference}\0${node.id}`);
          insertEvidence.run(run.runId, reference.slice(0, 2048), node.id, 'declared_graph_reference', 'declared_reference', null,
            null, null, null, null, null, '{}');
        }
      }
    }
    const inputEdges = graph.edges.slice(0, 2_000);
    for (let i = 0; i < inputEdges.length; i++) {
      const edge = inputEdges[i]; if (!isRecord(edge) || typeof edge.from !== 'string' || typeof edge.to !== 'string' || typeof edge.type !== 'string') continue;
      const stored = storedEdgeByShape.get(`${edge.from}\0${edge.to}\0${edge.type}`);
      const keyPayload = JSON.stringify([i, edge.from, edge.to, edge.type]);
      const refs = Array.isArray(edge.evidenceRefs) ? [...new Set(edge.evidenceRefs.filter(x => typeof x === 'string').map(x => x.slice(0, 2048)))].slice(0, 64) : [];
      const snapshot = jsonWithin({ condition: edge.condition ?? null, outcome: edge.outcome ?? null, source_index: i }, 2_000);
      const callerEdge = (run.graph?.edges || []).some(item => item && item.from === edge.from && item.to === edge.to && item.type === edge.type);
      const sourceKind = stored ? 'persisted_knowledge' : callerEdge ? 'caller_graph' : (knowledgeSnapshot ? 'composed_graph' : 'caller_graph');
      insertEdge.run(run.runId, sha256(keyPayload), stored?.edge_id || null, stored?.goal_id || observedGoalId,
        edge.from.slice(0, 512), edge.to.slice(0, 512), edge.type.slice(0, 100), sourceKind, JSON.stringify(refs), snapshot.json);
      for (const reference of refs) {
        if (refsWritten.size < MAX_RUN_EVIDENCE_REFS) {
          refsWritten.add(`${reference}\0edge:${i}`);
          insertEvidence.run(run.runId, reference, '', 'declared_graph_reference', 'declared_edge_reference', null,
            null, null, null, null, null, '{}');
        }
      }
    }
    for (const [key, item] of evidenceSourceByRef) {
      if (refsWritten.size >= MAX_RUN_EVIDENCE_REFS) break;
      const [field, reference] = key.split('\0');
      // Keep trace metadata only. Never snapshot arbitrary resolver objects, which may
      // include source bytes, local paths, or artifact payloads.
      const details = jsonWithin(resolverEvidenceSummary(item), 4 * 1024);
      insertEvidence.run(run.runId, reference.slice(0, 2048), '', 'runtime_resolver',
        safeText(item.kind, 120), safeText(item.classification, 160), safeText(item.artifactId, 200),
        safeText(item.sourceJobId, 200), /^[a-f0-9]{64}$/.test(item.contentHash || '') ? item.contentHash : null,
        typeof item.lineageVerified === 'boolean' ? (item.lineageVerified ? 1 : 0) : null,
        typeof item.claimVerified === 'boolean' ? (item.claimVerified ? 1 : 0) : null, details.json);
      refsWritten.add(`${reference}\0${field}`);
    }
    return { nodeCount: graph.nodes.length, edgeCount: graph.edges.length };
  }

  function finishRun({ runId, result = null, observed = null, error = null, durationMs, telemetryErrors = [] }) {
    const run = activeRuns.get(runId);
    const row = stmt('SELECT status FROM adaptive_goal_planner_runs WHERE run_id=?').get(runId);
    if (!row) throw new Error(`AGG planner telemetry run not found: ${runId}`);
    if (row.status !== 'running') throw new Error(`AGG planner telemetry run is already terminal: ${runId}`);
    const algorithm = observed?.result || run.algorithmResult || result;
    const finalGraph = observed?.graph || run.observedGraph || graphOf(result?.effectiveGraph) || run.graph;
    const knowledgeSnapshot = observed?.knowledgeSnapshot || run.knowledgeSnapshot || result?.knowledgeSnapshot || null;
    const toolResultObservedDuration = Number.isSafeInteger(durationMs) && durationMs >= 0 ? durationMs : null;
    const status = error ? 'failed' : 'completed';
    const trace = isRecord(algorithm?.auditTrace) ? algorithm.auditTrace : {};
    const candidateList = candidateSummary(algorithm);
    const candidatesJson = jsonWithin(candidateList, MAX_SNAPSHOT_JSON_BYTES, '[]');
    const graphHash = /^[a-f0-9]{64}$/.test(algorithm?.graphHash || '') ? algorithm.graphHash : null;
    const searchRunId = safeText(algorithm?.search?.searchRunId || algorithm?.auditTrace?.searchRunId, 200);
    const errorCode = safeText(error?.code, 120);
    const errorName = safeText(error?.name, 120);
    const errorMessage = error ? sensitiveFreeError(error) : null;
    const captureErrors = Array.isArray(telemetryErrors) ? telemetryErrors.slice(0,20).map(item=>({
      phase:safeText(item?.phase,120)||'unknown', observed_at:safeText(item?.observed_at,80),
      error_name:safeText(item?.error?.name,120), error_code:safeText(item?.error?.code,120),
      message:sensitiveFreeError(item?.error || item?.message || 'unknown telemetry observation error')
    })) : [];
    const searchObserverErrors = Array.isArray(telemetryErrors) ? telemetryErrors.filter(item=>item?.phase==='search_observer').length : 0;
    const provenance = JSON.stringify({
      ...buildProvenance(run), graph_hash_semantics: graphHash ? 'returned-by-search-implementation' : 'not-returned-by-search-implementation',
      knowledge_snapshot_hash: /^[a-f0-9]{64}$/.test(knowledgeSnapshot?.snapshotHash || '') ? knowledgeSnapshot.snapshotHash : null,
      knowledge_nodes_verified: false, knowledge_nodes_usable_for_planning: false,
      search_outcome_is_not_acceptance: true, search_metrics_are_not_quality_attestations: true,
      telemetry_observation_error_count: Array.isArray(telemetryErrors) ? telemetryErrors.length : 0,
      telemetry_observation_errors: captureErrors
    });
    let terminalDurationMs = null;
    let terminalFinishedAt = null;
    db.exec('BEGIN IMMEDIATE');
    try {
      const snapshotCounts = finalGraph ? persistGraphSnapshot(run, finalGraph, algorithm, knowledgeSnapshot, result) : { nodeCount: null, edgeCount: null };
      // The terminal duration includes synchronous audit writes and final bounded snapshot
      // preparation, up to the terminal commit boundary. Preserve the earlier tool-result
      // observation separately so users can distinguish the measured phases.
      const duration = Math.max(toolResultObservedDuration ?? 0, Number((process.hrtime.bigint() - run.startedMono) / 1_000_000n));
      const finishedAt = new Date().toISOString();
      terminalDurationMs = duration;
      terminalFinishedAt = finishedAt;
      const metrics = observedMetrics(algorithm, duration);
      metrics.telemetry_capture_error_count = Array.isArray(telemetryErrors) ? telemetryErrors.length : 0;
      const metricsJson = jsonWithin(metrics, 48 * 1024);
      if (captureErrors.length) appendEvent(runId, {
        event_type:'telemetry_observation_degraded', error_count:telemetryErrors.length,
        search_observer_errors:searchObserverErrors, errors:captureErrors
      },'runtime',finishedAt);
      appendEvent(runId, {
        event_type: error ? 'run_failed' : 'run_completed', status, algorithm_status: safeText(algorithm?.status, 120),
        graph_hash: graphHash, search_run_id: searchRunId, duration_ms: duration,
        error_code: errorCode, error_name: errorName, error_message: errorMessage
      }, 'runtime', finishedAt);
      const persistedSteps = Number(stmt("SELECT COUNT(*) AS count FROM adaptive_goal_planner_run_events WHERE run_id=? AND event_source='search_observer'").get(runId)?.count || 0);
      const searchEventCount = finiteCount(trace.eventCount);
      const omittedEventCount = (finiteCount(trace.omittedEventCount) ?? 0) + searchObserverErrors;
      const resultStatus = safeText(algorithm?.status, 120);
      const terminationReason = safeText(algorithm?.search?.terminationReason, 160);
      const candidates = finiteCount(metrics.candidate_count);
      const partialCandidates = finiteCount(metrics.partial_candidate_count);
      const truncated = Boolean(trace.truncated || omittedEventCount > 0 || candidatesJson.truncated || metricsJson.truncated || captureErrors.length);
      stmt(`UPDATE adaptive_goal_planner_runs SET status=?,finished_at=?,duration_ms=?,tool_result_observed_duration_ms=?,graph_hash=?,search_run_id=?,goal_id=COALESCE(goal_id,?),goal_node_id=COALESCE(goal_node_id,?),
        observed_node_count=?,observed_edge_count=?,algorithm_status=?,termination_reason=?,candidate_count=?,partial_candidate_count=?,search_event_count=?,search_event_count_recorded=?,search_event_count_omitted=?,search_events_truncated=?,metrics_json=?,candidates_json=?,provenance_json=?,error_code=?,error_name=?,error_message=?
        WHERE run_id=? AND status='running'`).run(status, finishedAt, duration, toolResultObservedDuration, graphHash, searchRunId,
        safeText(run.goalId || knowledgeSnapshot?.goalId, 200), safeText(algorithm?.goalNodeId || finalGraph?.goalNodeId, 200),
        snapshotCounts.nodeCount, snapshotCounts.edgeCount, resultStatus, terminationReason, candidates, partialCandidates,
        searchEventCount, persistedSteps, omittedEventCount, truncated ? 1 : 0, metricsJson.json, candidatesJson.json, provenance,
        errorCode, errorName, errorMessage, runId);
      db.exec('COMMIT');
    } catch (finishError) { try { db.exec('ROLLBACK'); } catch {} throw finishError; }
    activeRuns.delete(runId);
    return { runId, status, startedAt: run.startedAt, finishedAt: terminalFinishedAt, durationMs: terminalDurationMs, toolResultObservedDurationMs: toolResultObservedDuration, searchRunId, graphHash };
  }

  return Object.freeze({
    schemaVersion: ADAPTIVE_GOAL_PLANNER_TELEMETRY_SCHEMA_VERSION,
    beginRun,
    recordSearchEvent,
    observeSearchInput,
    observeAlgorithmResult,
    finishRun,
    getRunContext: runId => activeRuns.get(runId) || null
  });
}
