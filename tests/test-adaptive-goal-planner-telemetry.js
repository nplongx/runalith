import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createAdaptiveGoalKnowledgeStore } from '../src/runtime/adaptive-goal-knowledge-store.js';
import { createAdaptiveGoalPlannerTelemetryStore, ADAPTIVE_GOAL_PLANNER_TELEMETRY_SCHEMA_VERSION } from '../src/runtime/adaptive-goal-planner-telemetry.js';

const db = new DatabaseSync(':memory:');
try {
  const knowledge = createAdaptiveGoalKnowledgeStore(db);
  const node = knowledge.saveNode({
    goalId: 'goal-telemetry', stableKey: 'telemetry-evidence', type: 'idea',
    content: { title: 'Observed source reference' },
    provenance: { source: 'telemetry-test', actor: 'fixture', reference: 'fixture://node-source' },
    evidenceRefs: ['fixture://evidence-1']
  });
  const experimentNode = knowledge.saveNode({
    goalId: 'goal-telemetry', stableKey: 'telemetry-experiment', type: 'experiment',
    content: { title: 'Observed experiment' }, provenance: { source: 'telemetry-test', actor: 'fixture' }
  });
  const knowledgeEdge = knowledge.addEdge({
    goalId: 'goal-telemetry', fromId: node.id, toId: experimentNode.id, type: 'tested_by',
    provenance: { source: 'telemetry-test', actor: 'fixture' }, evidenceRefs: ['fixture://evidence-1']
  });
  const telemetry = createAdaptiveGoalPlannerTelemetryStore(db, { processInstanceId: 'test-process-1', serverVersion: 'test-version' });
  const migratedAgain = createAdaptiveGoalPlannerTelemetryStore(db, { processInstanceId: 'test-process-2', serverVersion: 'test-version' });
  assert.equal(telemetry.schemaVersion, ADAPTIVE_GOAL_PLANNER_TELEMETRY_SCHEMA_VERSION);
  assert.equal(migratedAgain.schemaVersion, ADAPTIVE_GOAL_PLANNER_TELEMETRY_SCHEMA_VERSION, 'migration is idempotent');
  assert.equal(knowledge.getNode(node.id).contentHash, node.contentHash, 'old append-only knowledge data survives telemetry migration');
  assert.equal(db.prepare("SELECT value FROM adaptive_goal_planner_telemetry_meta WHERE key='schema_version'").get().value, '2');

  const inputGraph = {
    schemaVersion: 1, startNodeId: 'caller-start', goalNodeId: 'goal-node',
    nodes: [
      { id: 'caller-start', type: 'task', label: 'Caller start', evidenceRefs: [] },
      { id: 'goal-node', type: 'goal', label: 'Goal node', evidenceRefs: [] }
    ],
    edges: [{ from: 'caller-start', to: 'goal-node', type: 'next_step' }]
  };
  const graph = { ...inputGraph,
    nodes:[...inputGraph.nodes,{id:node.id,type:'idea',label:'Persisted idea',evidenceRefs:['fixture://evidence-1'],estimatedCost:null},{id:experimentNode.id,type:'experiment',label:'Observed experiment',evidenceRefs:[]}],
    edges:[...inputGraph.edges,{from:node.id,to:experimentNode.id,type:'tested_by',evidenceRefs:['fixture://evidence-1']}]
  };
  const started = telemetry.beginRun({ toolName: 'adaptive_goal_graph_search', args: { graph:inputGraph, knowledge_goal_id: 'goal-telemetry', options: { beamWidth: 4 } } });
  const inFlight = db.prepare('SELECT status,finished_at,duration_ms FROM adaptive_goal_planner_runs WHERE run_id=?').get(started.runId);
  assert.deepEqual({ ...inFlight }, { status: 'running', finished_at: null, duration_ms: null }, 'start record is durable before the search returns');
  const searchResult = {
    status: 'proposals_found', graphHash: 'a'.repeat(64), goalNodeId: 'goal-node',
    search: { searchRunId: 'algorithm-run-1', expansions: 7, generatedStates: 9, prunedStates: 2, exploredDepth: 3, terminationReason: 'frontier_exhausted', exhaustive: false },
    candidates: [{ planId: 'candidate-1', candidateKind: 'complete_path_candidate', status: 'proposed', pathNodeIds: ['caller-start', 'goal-node'], pathEdgeTypes: ['next_step'], metrics: { estimatedCost: null }, verification: { status: 'unverified', verified: false } }],
    bestPartialCandidates: [],
    auditTrace: { searchRunId: 'algorithm-run-1', eventCount: 1, omittedEventCount: 0, truncated: false, counters: { expansions: 7, rejectedCycles: 1 }, events: [] }
  };
  const knowledgeSnapshot = {
    goalId: 'goal-telemetry', selectedNodeIds: [node.id,experimentNode.id],
    nodeContentHashes: [node,experimentNode].map(item=>({ id: item.id, contentHash: item.contentHash, provenanceHash: item.provenanceHash, revision: item.revision })),
    storedEdgeIds: [knowledgeEdge.edgeId], persistedNodesVerified: false, persistedNodesUsableForPlanning: false, snapshotHash: 'b'.repeat(64)
  };
  telemetry.observeSearchInput(started.runId, graph, knowledgeSnapshot);
  telemetry.recordSearchEvent(started.runId, { type: 'state_expanded', sequence: 1, currentNodeId: 'caller-start', observedAt: '2026-10-25T10:00:00.100Z' });
  telemetry.observeAlgorithmResult(started.runId, searchResult, graph, knowledgeSnapshot);
  const terminal = telemetry.finishRun({
    runId: started.runId,
    result: { ...searchResult, artifactEvidence: [{ reference: 'fixture://evidence-1', kind: 'durable_artifact', classification: 'durable_artifact_lineage_verified_claim_unverified', artifactId: 'artifact-1', sourceJobId: 'job-1', contentHash: 'c'.repeat(64), lineageVerified: true, claimVerified: false }] },
    observed: { result: searchResult, graph, knowledgeSnapshot }, durationMs: 23
  });
  assert.equal(terminal.status, 'completed'); assert.ok(terminal.durationMs>=23); assert.equal(terminal.toolResultObservedDurationMs,23); assert.equal(terminal.searchRunId, 'algorithm-run-1');
  const storedRun = db.prepare('SELECT * FROM adaptive_goal_planner_runs WHERE run_id=?').get(started.runId);
  assert.equal(storedRun.status, 'completed'); assert.equal(storedRun.algorithm_status, 'proposals_found');
  assert.equal(storedRun.duration_ms, terminal.durationMs); assert.equal(storedRun.tool_result_observed_duration_ms,23); assert.equal(storedRun.candidate_count, 1); assert.equal(storedRun.search_event_count, 1);
  assert.equal(storedRun.search_event_count_recorded, 1); assert.equal(storedRun.search_events_truncated, 0);
  const metrics = JSON.parse(storedRun.metrics_json);
  assert.equal(metrics.total_duration_ms,storedRun.duration_ms); assert.equal(metrics.expansions, 7); assert.equal(metrics.generated_states, 9); assert.equal(metrics.candidate_count, 1);
  assert.equal(Object.hasOwn(metrics, 'estimated_success_confidence'), false, 'an absent estimated metric is not fabricated');
  assert.match(storedRun.provenance_json, /runtime_observation/);
  assert.equal(JSON.parse(storedRun.provenance_json).knowledge_snapshot_hash, 'b'.repeat(64));
  const savedNode = db.prepare('SELECT * FROM adaptive_goal_planner_run_nodes WHERE run_id=? AND node_id=?').get(started.runId, node.id);
  assert.equal(savedNode.source_kind, 'persisted_knowledge'); assert.equal(savedNode.revision, node.revision);
  assert.equal(savedNode.content_hash, node.contentHash); assert.equal(savedNode.provenance_hash, node.provenanceHash);
  assert.ok(db.prepare('SELECT 1 FROM adaptive_goal_planner_run_edges WHERE run_id=? AND from_node_id=? AND to_node_id=? AND edge_id=?').get(started.runId,node.id,experimentNode.id,knowledgeEdge.edgeId));
  assert.ok(db.prepare("SELECT 1 FROM adaptive_goal_planner_run_goals WHERE run_id=? AND goal_id='goal-telemetry' AND goal_kind='knowledge_scope'").get(started.runId));
  assert.ok(db.prepare("SELECT 1 FROM adaptive_goal_planner_run_goals WHERE run_id=? AND goal_id='goal-node' AND goal_kind='graph_goal_node'").get(started.runId));
  const evidence = db.prepare('SELECT * FROM adaptive_goal_planner_run_evidence WHERE run_id=? AND observation_source=\'runtime_resolver\'').get(started.runId);
  assert.equal(evidence.artifact_id, 'artifact-1'); assert.equal(evidence.lineage_verified, 1); assert.equal(evidence.claim_verified, 0);
  const lifecycle = db.prepare('SELECT event_type,event_source FROM adaptive_goal_planner_run_events WHERE run_id=? ORDER BY sequence').all(started.runId);
  assert.deepEqual(lifecycle.map(event=>event.event_type), ['run_started','search_input_observed','state_expanded','algorithm_result_observed','run_completed']);
  assert.equal(lifecycle[2].event_source, 'search_observer', 'search event is recorded at its actual observer boundary');
  assert.throws(() => db.prepare('UPDATE adaptive_goal_planner_runs SET algorithm_status=\'accepted\' WHERE run_id=?').run(started.runId), /terminal AGG planner runs are immutable/);
  assert.throws(() => db.prepare('UPDATE adaptive_goal_planner_run_events SET event_type=\'accepted\' WHERE run_id=?').run(started.runId), /append-only/);

  const failed = telemetry.beginRun({ toolName: 'adaptive_goal_graph_search', args: { graph: { nodes: [], edges: [] } } });
  telemetry.finishRun({ runId: failed.runId, error: Object.assign(new Error('search failed token=secretvalue'), { code: 'ERR_SEARCH_FIXTURE' }), durationMs: 3 });
  const failedRow = db.prepare('SELECT status,error_code,error_message,algorithm_status FROM adaptive_goal_planner_runs WHERE run_id=?').get(failed.runId);
  assert.equal(failedRow.status, 'failed'); assert.equal(failedRow.error_code, 'ERR_SEARCH_FIXTURE');
  assert.match(failedRow.error_message, /token=\[REDACTED\]/); assert.equal(failedRow.algorithm_status, null, 'no algorithm outcome is inferred when search never returned one');
  assert.equal(db.prepare("SELECT event_type FROM adaptive_goal_planner_run_events WHERE run_id=? ORDER BY sequence DESC LIMIT 1").get(failed.runId).event_type, 'run_failed');

  const unfinished = telemetry.beginRun({ toolName: 'adaptive_goal_phase2_shadow_search', args: { graph:inputGraph } });
  telemetry.recordSearchEvent(unfinished.runId, { type: 'state_scored', sequence: 1, pathNodeIds: ['caller-start'] });
  const unfinishedRow = db.prepare('SELECT status,finished_at,duration_ms,search_event_count_recorded FROM adaptive_goal_planner_runs WHERE run_id=?').get(unfinished.runId);
  assert.equal(unfinishedRow.status, 'running'); assert.equal(unfinishedRow.finished_at, null); assert.equal(unfinishedRow.duration_ms, null);
  assert.equal(unfinishedRow.search_event_count_recorded, 1, 'retained step count stays current even before terminalization');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM adaptive_goal_planner_run_events WHERE run_id=? AND event_source=\'search_observer\'').get(unfinished.runId).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM adaptive_goal_planner_run_nodes WHERE run_id=?').get(unfinished.runId).n,2,'input graph snapshot persists before terminalization');
  const degraded = telemetry.beginRun({toolName:'adaptive_goal_graph_search',args:{graph:inputGraph}});
  const observerFault = new Error('synthetic telemetry disk write failure');
  db.exec(`CREATE TRIGGER fail_agg_test_observer BEFORE INSERT ON adaptive_goal_planner_run_events WHEN NEW.event_source='search_observer' BEGIN SELECT RAISE(ABORT,'synthetic telemetry disk write failure'); END`);
  assert.throws(()=>telemetry.recordSearchEvent(degraded.runId,{type:'state_expanded',sequence:1,currentNodeId:'caller-start'}),/synthetic telemetry disk write failure/);
  db.exec('DROP TRIGGER fail_agg_test_observer');
  const degradedResult={status:'proposals_found',search:{expansions:1},candidates:[],bestPartialCandidates:[],auditTrace:{eventCount:1,omittedEventCount:0,truncated:false,events:[]}};
  telemetry.observeAlgorithmResult(degraded.runId,degradedResult,inputGraph);
  telemetry.finishRun({runId:degraded.runId,result:degradedResult,observed:{result:degradedResult,graph:inputGraph},durationMs:4,telemetryErrors:[{phase:'search_observer',error:observerFault,observed_at:new Date().toISOString()}]});
  const degradedRow=db.prepare('SELECT status,search_event_count,search_event_count_recorded,search_event_count_omitted,search_events_truncated,metrics_json,provenance_json FROM adaptive_goal_planner_runs WHERE run_id=?').get(degraded.runId);
  assert.equal(degradedRow.status,'completed','a telemetry observer write fault does not fabricate an algorithm failure when the result exists');
  assert.equal(degradedRow.search_event_count,1);assert.equal(degradedRow.search_event_count_recorded,0);assert.equal(degradedRow.search_event_count_omitted,1);assert.equal(degradedRow.search_events_truncated,1);
  assert.equal(JSON.parse(degradedRow.metrics_json).telemetry_capture_error_count,1);assert.equal(JSON.parse(degradedRow.provenance_json).telemetry_observation_error_count,1);
  assert.equal(db.prepare("SELECT event_type FROM adaptive_goal_planner_run_events WHERE run_id=? AND event_type='telemetry_observation_degraded'").get(degraded.runId).event_type,'telemetry_observation_degraded');
  assert.throws(() => telemetry.beginRun({ toolName: 'not-an-agg-tool', args: {} }), /unsupported AGG planner telemetry tool/);
  console.log('PASS AGG planner telemetry: schema migration, immutable knowledge linkage, event timing, observed metrics, provenance, failures, unfinished runs, and append-only history');
} finally {
  db.close();
}

// Upgrade a real v1-shaped run table without discarding its terminal records or linked-table references.
const legacyDb = new DatabaseSync(':memory:');
try {
  legacyDb.exec(`
    CREATE TABLE adaptive_goal_planner_telemetry_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO adaptive_goal_planner_telemetry_meta(key,value) VALUES('schema_version','1');
    CREATE TABLE adaptive_goal_planner_runs (
      run_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL CHECK(schema_version=1),
      tool_name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
      started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms>=0),
      process_instance_id TEXT NOT NULL, goal_id TEXT, graph_hash TEXT, provenance_json TEXT NOT NULL,
      search_event_count_recorded INTEGER NOT NULL DEFAULT 0,search_event_count_omitted INTEGER NOT NULL DEFAULT 0,
      search_events_truncated INTEGER NOT NULL DEFAULT 0 CHECK(search_events_truncated IN (0,1)),
      CHECK((status='running' AND finished_at IS NULL AND duration_ms IS NULL) OR (status IN ('completed','failed') AND finished_at IS NOT NULL AND duration_ms IS NOT NULL))
    );
    CREATE TABLE adaptive_goal_planner_run_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES adaptive_goal_planner_runs(run_id),
      sequence INTEGER NOT NULL,event_type TEXT NOT NULL,observed_at TEXT NOT NULL,event_source TEXT NOT NULL,
      payload_json TEXT NOT NULL,payload_truncated INTEGER NOT NULL DEFAULT 0,UNIQUE(run_id,sequence)
    );
    INSERT INTO adaptive_goal_planner_runs(run_id,schema_version,tool_name,status,started_at,finished_at,duration_ms,process_instance_id,goal_id,graph_hash,provenance_json)
      VALUES('legacy-completed-run',1,'adaptive_goal_graph_search','completed','2026-10-24T08:00:00.000Z','2026-10-24T08:00:00.025Z',25,'legacy-process','legacy-goal','${'d'.repeat(64)}','{"source":"pre-telemetry-v2"}');
    INSERT INTO adaptive_goal_planner_run_events(run_id,sequence,event_type,observed_at,event_source,payload_json,payload_truncated)
      VALUES('legacy-completed-run',1,'legacy_terminal_event','2026-10-24T08:00:00.025Z','runtime','{"legacy":true}',0);
  `);
  const upgraded = createAdaptiveGoalPlannerTelemetryStore(legacyDb,{processInstanceId:'v2-process',serverVersion:'test-version'});
  assert.equal(upgraded.schemaVersion,2);
  assert.equal(legacyDb.prepare("SELECT value FROM adaptive_goal_planner_telemetry_meta WHERE key='schema_version'").get().value,'2');
  const oldRow=legacyDb.prepare('SELECT run_id,schema_version,status,started_at,finished_at,duration_ms,process_instance_id,goal_id,graph_hash,tool_result_observed_duration_ms FROM adaptive_goal_planner_runs WHERE run_id=\'legacy-completed-run\'').get();
  assert.deepEqual({...oldRow},{run_id:'legacy-completed-run',schema_version:1,status:'completed',started_at:'2026-10-24T08:00:00.000Z',finished_at:'2026-10-24T08:00:00.025Z',duration_ms:25,process_instance_id:'legacy-process',goal_id:'legacy-goal',graph_hash:'d'.repeat(64),tool_result_observed_duration_ms:null});
  assert.equal(legacyDb.prepare('PRAGMA foreign_keys').get().foreign_keys,1,'foreign keys are restored after the parent-table rebuild');
  const newRun=upgraded.beginRun({toolName:'adaptive_goal_graph_search',args:{graph:{nodes:[],edges:[]}}});
  assert.equal(legacyDb.prepare('SELECT schema_version FROM adaptive_goal_planner_runs WHERE run_id=?').get(newRun.runId).schema_version,2);
  upgraded.finishRun({runId:newRun.runId,error:new Error('migration fixture terminal'),durationMs:1});
  assert.deepEqual({...legacyDb.prepare('SELECT run_id,sequence,event_type,payload_json FROM adaptive_goal_planner_run_events WHERE run_id=\'legacy-completed-run\'').get()},{run_id:'legacy-completed-run',sequence:1,event_type:'legacy_terminal_event',payload_json:'{"legacy":true}'},'linked legacy event IDs/payload survive the parent-table rebuild without being rewritten');
  assert.equal(legacyDb.prepare('PRAGMA foreign_key_check').all().length,0,'linked history satisfies restored foreign-key enforcement');
  console.log('PASS AGG planner telemetry migration: v1 table rebuilt transactionally, terminal row preserved, FK setting restored, new records use v2');
} finally {
  legacyDb.close();
}
