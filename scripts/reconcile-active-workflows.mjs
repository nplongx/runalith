#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { validateAdaptiveGoalProducerLineage } from '../src/runtime/adaptive-goal-evidence-lineage.js';
import { resolveAdaptiveGoalSourceEvidence } from '../src/runtime/adaptive-goal-source-evidence.js';
import { getAgentContract } from '../src/runtime/workflow/agent-contracts.js';

const DEFAULT_DB = path.join(process.env.HOME || '/tmp', '.chat-on-steroids', 'agent-orchestrator', 'workflow.db');
const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const EVENT_KEYS = /^(task_?id|task|attempt_?id|attempt|result_?id|artifact_?id|lease_?id|worker_?id|session_?id|run_?id|role|phase|status|decision|reason|error_?code|recovery|owner|actor|exit_?code|execution_?status)$/i;
const MAX_REPORT_JOBS = 200;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRAPH_LIMITS = Object.freeze({ nodes: 10_000, revisions: 50_000, memberships: 50_000, edges: 20_000, attestations: 5_000, plannerRuns: 500, evidencePerRun: 5_000 });
const RECONCILIATION_FINDING_GUIDANCE = Object.freeze({
  RUNNING_TASK_WITHOUT_EXECUTION_METADATA: ['tasks', 'Confirm the exact attempt, worker/process identity and provider run through host-owned records; do not infer worker death from absent metadata.'],
  ACTIVE_ATTEMPT_WITHOUT_ACTIVE_LEASE: ['attempts,task_leases', 'Ask the workflow owner to reconcile the attempt with lease fencing and provider state before any lifecycle transition.'],
  RUNNING_TASK_WITH_EXPIRED_OR_INVALID_LEASE: ['tasks,task_leases', 'Verify lease expiry semantics and current worker ownership with the lease authority; do not release or replace the lease from this report.'],
  ARTIFACT_JOB_TASK_LINEAGE_MISMATCH: ['artifacts,tasks', 'Revalidate artifact job/task IDs and producer lineage from the authoritative artifact store; do not rewrite historical artifact metadata.'],
  ARTIFACT_PRODUCER_ROLE_MISMATCH: ['artifacts,tasks', 'Compare the artifact producer role with the persisted task contract and producer output contract.'],
  SUCCESS_RESULT_WITH_NONTERMINAL_TASK: ['results,tasks', 'Reconcile the result against the exact attempt and completion event; require the owner-authorized task transition.'],
  ACTIVE_LEASE_ATTEMPT_MISMATCH: ['task_leases,tasks', 'Verify attempt fencing and owner epoch against the authoritative lease service.'],
  ACTIVE_LEASE_JOB_TASK_LINEAGE_MISMATCH: ['task_leases,jobs,tasks', 'Verify lease job/task ownership against the authoritative lease service before intervention.'],
  ACTIVE_LEASE_OWNER_EPOCH_UNAVAILABLE: ['task_leases', 'Obtain the lease owner epoch from the authoritative lease service; missing epoch is unresolved, not permission to recover.'],
  TASK_ATTEMPT_PROVIDER_RUN_ID_MISMATCH: ['tasks,attempts', 'Verify provider identity and run binding with the provider owner; do not attach a different run to this attempt.'],
  TASK_ATTEMPT_PROVIDER_RUN_ID_BINDING_INCOMPLETE: ['tasks,attempts', 'Obtain the missing provider run binding from authoritative provider records or keep the task on hold.'],
  RUNTIME_ATTEMPT_ACTIVE_TASK_MISMATCH: ['workflow_runtime_state,tasks', 'Re-read runtime and task attempt IDs and reconcile through the documented owner-authorized lifecycle path.'],
  COMPLETION_EVENT_NEWER_THAN_ACTIVE_TASK_ROW: ['events,tasks', 'Validate the completion event payload, attempt/result identity and event ordering before changing task state.'],
  EXECUTING_JOB_WITHOUT_RUNNING_TASKS: ['jobs,tasks,events', 'Reconcile the job state against all task attempts and completion events with the workflow owner.'],
  ACTIVE_TASK_POINTER_NOT_RUNNING: ['jobs,tasks', 'Verify the active-task pointer and exact task lifecycle record; do not infer dispatch or completion.'],
  RUNNING_TASKS_WITHOUT_ACTIVE_LEASES: ['tasks,task_leases', 'Confirm host/provider worker identity and lease fencing; absent leases do not prove the worker is dead.'],
  ACTIVE_TASK_POINTER_MISSING_OR_UNRESOLVED: ['jobs,tasks', 'Resolve the active task pointer from authoritative workflow state and retain HOLD until the owner confirms lineage.'],
  WORKFLOW_RUNTIME_HAS_LAST_ERROR: ['workflow_runtime_state', 'Inspect the runtime error and correlated event/attempt/result lineage; do not automatically retry or terminalize.']
});

function fail(code, message) { throw Object.assign(new Error(`${code}: ${message}`), { code }); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function parseJson(value) { try { return JSON.parse(value); } catch { return null; } }
function timestampMs(value) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function ageMs(value, nowMs) {
  const parsed = timestampMs(value);
  return parsed == null ? null : Math.max(0, nowMs - parsed);
}
function newestTimestamp(values) {
  return values.filter(value => timestampMs(value) != null).sort((a, b) => timestampMs(b) - timestampMs(a))[0] || null;
}
function firstDefined(...values) { return values.find(value => value !== undefined && value !== null && value !== '') ?? null; }

function reconciliationFinding(code, { job, taskEntry = null, eventIds = [], runtimePresent = false } = {}) {
  const [sourceTables, remediation] = RECONCILIATION_FINDING_GUIDANCE[code] ||
    ['jobs,tasks,events', 'Re-query authoritative workflow/provider records and obtain owner approval before any lifecycle transition.'];
  const task = taskEntry?.task || null;
  const recordIds = {
    jobId: job?.job_id ?? null,
    taskId: task?.taskId ?? null,
    attemptIds: taskEntry?.lineageAssessment?.attemptIds ?? [],
    resultIds: taskEntry?.lineageAssessment?.resultIds ?? [],
    artifactIds: taskEntry?.lineageAssessment?.artifactIds ?? [],
    leaseIds: taskEntry?.lineageAssessment?.leaseIds ?? [],
    eventIds: taskEntry?.eventLineage?.eventIds ?? eventIds
  };
  const evidence = {
    jobState: job?.state ?? null,
    jobStatus: job?.status ?? null,
    taskStatus: task?.status ?? null,
    executionAttempt: task?.executionAttempt ?? null,
    providerRunIdentityBinding: taskEntry?.lineageAssessment?.providerRunIdentityBinding ?? 'unavailable',
    runtimeObservationPresent: runtimePresent,
    claimTruthVerified: false,
    ownerAuthorityVerified: false
  };
  const identity = { schemaVersion: 1, code, recordIds, evidence, sourceTables, remediation };
  return {
    findingId: `reconcile-${hash(JSON.stringify(identity))}`,
    code,
    severity: 'BLOCKER',
    status: 'UNRESOLVED',
    gate: 'HOLD',
    source: { subsystem: 'read_only_workflow_reconciliation', tables: sourceTables.split(','), recordIds },
    evidence,
    remediation,
    authorizationGranted: false
  };
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}
function tableColumns(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name));
}
function requireColumns(db, table, required) {
  const available = tableColumns(db, table);
  const missing = required.filter(column => !available.has(column));
  if (missing.length) fail('RECONCILIATION_SCHEMA_UNSUPPORTED', `table ${table} is missing required columns: ${missing.join(', ')}`);
}
function selectAvailable(db, table, columns, whereSql, parameters = [], orderSql = '', limitSql = '') {
  const available = tableColumns(db, table);
  if (!available.size) return [];
  const selected = columns.filter(column => available.has(column));
  if (!selected.length) return [];
  return db.prepare(`SELECT ${selected.map(column => `"${column}"`).join(',')} FROM "${table}" ${whereSql || ''} ${orderSql} ${limitSql}`).all(...parameters);
}

function canonicalJson(value, depth = 0) {
  if (depth > 32) throw new TypeError('JSON nesting depth exceeds 32');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON numbers must be finite');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item, depth + 1)).join(',')}]`;
  if (!isRecord(value)) throw new TypeError('value is not canonical JSON');
  const keys = Object.keys(value).sort();
  if (keys.includes('__proto__')) throw new TypeError('forbidden JSON key');
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`).join(',')}}`;
}

function canonicalProvenance(value) {
  if (!isRecord(value)) throw new TypeError('provenance must be an object');
  const allowed = ['source', 'actor', 'reference', 'note'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError('provenance has unknown fields');
  for (const key of ['source', 'actor']) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > (key === 'source' ? 512 : 200)) {
      throw new TypeError(`provenance ${key} is invalid`);
    }
  }
  for (const key of ['reference', 'note']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > (key === 'reference' ? 2048 : 2000))) {
      throw new TypeError(`provenance ${key} is invalid`);
    }
  }
  const normalized = { source: value.source.trim(), actor: value.actor.trim() };
  if (value.reference !== undefined) normalized.reference = value.reference.trim();
  if (value.note !== undefined) normalized.note = value.note.trim();
  return canonicalJson(normalized);
}

function parseJsonForIntegrity(value) {
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

function lineageFailure(code) { return { code }; }

/**
 * Re-resolve a planner telemetry evidence row against current durable records.
 * This validates artifact bytes plus artifact-created and result/attempt/completion
 * lineage; it never establishes claim truth or evidence independence.
 */
export function revalidatePlannerEvidenceLineage(db, evidenceRow) {
  const blockers = [];
  const add = code => { if (!blockers.some(item => item.code === code)) blockers.push(lineageFailure(code)); };
  if (!isRecord(evidenceRow) || typeof evidenceRow.artifact_id !== 'string' || !evidenceRow.artifact_id ||
      typeof evidenceRow.source_job_id !== 'string' || !evidenceRow.source_job_id) {
    return { status: 'not_revalidated_missing_artifact_identity', valid: false,
      blockers: [{ code: 'PLANNER_EVIDENCE_ARTIFACT_IDENTITY_MISSING' }], claimTruthVerified: false, independenceVerified: false };
  }
  if (!tableExists(db, 'artifacts') || !tableExists(db, 'tasks') || !tableExists(db, 'results') ||
      !tableExists(db, 'attempts') || !tableExists(db, 'events')) {
    return { status: 'not_revalidated_required_workflow_tables_unavailable', valid: false,
      blockers: [{ code: 'PLANNER_EVIDENCE_LINEAGE_TABLES_UNAVAILABLE' }], claimTruthVerified: false, independenceVerified: false };
  }
  const artifact = db.prepare(`SELECT artifact_id,job_id,task_id,kind,uri,metadata_json,created_at,schema_version,
    producer_role,content,evidence_json,status,supersedes,content_hash FROM artifacts WHERE artifact_id=?`).get(evidenceRow.artifact_id);
  if (!artifact) {
    return { status: 'revalidation_failed_artifact_missing', valid: false,
      blockers: [{ code: 'PLANNER_EVIDENCE_ARTIFACT_MISSING' }], claimTruthVerified: false, independenceVerified: false };
  }
  if (artifact.job_id !== evidenceRow.source_job_id) add('PLANNER_EVIDENCE_SOURCE_JOB_SUBSTITUTION');
  if (evidenceRow.reference !== `artifact://${artifact.artifact_id}`) add('PLANNER_EVIDENCE_REFERENCE_SUBSTITUTION');
  const contentHash = typeof artifact.content === 'string' ? hash(artifact.content) : null;
  if (!/^[a-f0-9]{64}$/.test(String(artifact.content_hash || '')) || contentHash !== artifact.content_hash ||
      (evidenceRow.content_hash && evidenceRow.content_hash !== artifact.content_hash)) {
    add('PLANNER_EVIDENCE_ARTIFACT_CONTENT_HASH_MISMATCH');
  }
  if (!Number.isSafeInteger(artifact.schema_version) || artifact.schema_version < 1 || artifact.status !== 'active' ||
      artifact.uri !== `artifact://${artifact.artifact_id}` ||
      artifact.metadata_json !== JSON.stringify({ schema_version: artifact.schema_version })) {
    add('PLANNER_EVIDENCE_ARTIFACT_METADATA_INVALID');
  }
  let roleContract = null;
  try { roleContract = getAgentContract(artifact.producer_role); } catch {}
  const producerTask = db.prepare('SELECT task_id,job_id,role,status FROM tasks WHERE task_id=?').get(artifact.task_id);
  if (!producerTask || producerTask.job_id !== artifact.job_id || producerTask.status !== 'completed' ||
      String(producerTask.role || '').toLowerCase() !== String(artifact.producer_role || '').toLowerCase() ||
      !roleContract?.outputs?.includes(artifact.kind)) {
    add('PLANNER_EVIDENCE_PRODUCER_CONTRACT_INVALID');
  }

  const jobEvents = selectAvailable(db, 'events', ['event_id','job_id','type','payload_json','created_at'],
    'WHERE job_id=?', [artifact.job_id], 'ORDER BY created_at,rowid', 'LIMIT 10001');
  if (jobEvents.length > 10_000) add('PLANNER_EVIDENCE_EVENT_INVENTORY_TRUNCATED');
  const expectedArtifactPayload = { artifactId: artifact.artifact_id, taskId: artifact.task_id, type: artifact.kind,
    status: artifact.status, supersedes: artifact.supersedes ?? null, contentHash: artifact.content_hash };
  const expectedArtifactEventId = hash(`${artifact.job_id}|artifact.created|${artifact.artifact_id}`);
  const artifactEvents = jobEvents.filter(row => {
    const payload = parseJsonForIntegrity(row.payload_json);
    return row.event_id === expectedArtifactEventId || (row.type === 'artifact.created' && payload?.artifactId === artifact.artifact_id);
  });
  if (artifactEvents.length !== 1 || artifactEvents[0]?.event_id !== expectedArtifactEventId ||
      artifactEvents[0]?.job_id !== artifact.job_id || artifactEvents[0]?.type !== 'artifact.created' ||
      artifactEvents[0]?.payload_json !== JSON.stringify(expectedArtifactPayload)) {
    add('PLANNER_EVIDENCE_ARTIFACT_CREATED_EVENT_INVALID');
  }

  const evidenceRefs = parseJsonForIntegrity(artifact.evidence_json);
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0 || evidenceRefs.length > 64 ||
      evidenceRefs.some(reference => typeof reference !== 'string' || !reference.trim()) ||
      new Set(evidenceRefs).size !== evidenceRefs.length) {
    add('PLANNER_EVIDENCE_PRODUCER_EVIDENCE_REFERENCES_INVALID');
  }
  const successfulResults = [];
  if (Array.isArray(evidenceRefs)) for (const reference of evidenceRefs) {
    const result = typeof reference === 'string' ? db.prepare('SELECT result_id,task_id,outcome,created_at FROM results WHERE result_id=?').get(reference) : null;
    if (result) {
      if (result.task_id !== artifact.task_id || result.outcome !== 'success') add('PLANNER_EVIDENCE_PRODUCER_RESULT_BINDING_INVALID');
      else successfulResults.push(result);
      continue;
    }
    const referencedArtifact = typeof reference === 'string'
      ? db.prepare('SELECT artifact_id,job_id,status,content,content_hash FROM artifacts WHERE artifact_id=?').get(reference) : null;
    if (!referencedArtifact || referencedArtifact.job_id !== artifact.job_id || referencedArtifact.status !== 'active' ||
        referencedArtifact.artifact_id === artifact.artifact_id || typeof referencedArtifact.content !== 'string' ||
        hash(referencedArtifact.content) !== referencedArtifact.content_hash) {
      add('PLANNER_EVIDENCE_UPSTREAM_ARTIFACT_REFERENCE_INVALID');
    }
  }
  if (successfulResults.length !== 1) add('PLANNER_EVIDENCE_PRODUCER_RESULT_CARDINALITY_INVALID');

  let completion = null;
  let attempt = null;
  if (successfulResults.length === 1) {
    const result = successfulResults[0];
    let malformedCompletion = false;
    const matching = [];
    const expectedEventIds = new Set([
      hash(`${artifact.job_id}|task.local_completed|${result.result_id}`),
      hash(`${artifact.job_id}|task.completed|${artifact.task_id}|success|${result.result_id}`)
    ]);
    const completionRows = jobEvents.filter(row => expectedEventIds.has(row.event_id) ||
      ['task.completed', 'task.local_completed'].includes(row.type));
    for (const event of completionRows) {
      if (expectedEventIds.has(event.event_id) && !['task.completed', 'task.local_completed'].includes(event.type)) {
        add('PLANNER_EVIDENCE_COMPLETION_EVENT_TYPE_SUBSTITUTION');
        continue;
      }
      const payload = parseJsonForIntegrity(event.payload_json);
      if (!isRecord(payload)) { malformedCompletion = true; continue; }
      if (expectedEventIds.has(event.event_id) && (payload.taskId !== artifact.task_id || payload.resultId !== result.result_id)) {
        add('PLANNER_EVIDENCE_COMPLETION_EVENT_SUBSTITUTION');
      }
      if (payload.taskId !== artifact.task_id) continue;
      if (typeof payload.resultId !== 'string' || !payload.resultId.trim()) {
        add('PLANNER_EVIDENCE_COMPLETION_RESULT_ID_MISSING');
        continue;
      }
      const eventResult = db.prepare('SELECT result_id,task_id,outcome FROM results WHERE result_id=?').get(payload.resultId);
      if (!eventResult || eventResult.task_id !== artifact.task_id || eventResult.outcome !== 'success') {
        add('PLANNER_EVIDENCE_COMPLETION_RESULT_BINDING_INVALID');
        continue;
      }
      matching.push({ ...event, payload });
    }
    if (malformedCompletion) add('PLANNER_EVIDENCE_COMPLETION_LEDGER_MALFORMED');
    if (matching.length !== 1 || matching[0]?.payload.resultId !== result.result_id) {
      add('PLANNER_EVIDENCE_COMPLETION_EVENT_CARDINALITY_INVALID');
    } else {
      completion = matching[0];
      attempt = typeof completion.payload.attemptId === 'string' && completion.payload.attemptId.trim()
        ? db.prepare('SELECT attempt_id,task_id,status,openclaw_run_id,started_at,finished_at,error FROM attempts WHERE attempt_id=?')
          .get(completion.payload.attemptId) : null;
      const validation = validateAdaptiveGoalProducerLineage({ jobId: artifact.job_id, taskId: artifact.task_id,
        result, completion, attempt });
      if (!validation.valid) add('PLANNER_EVIDENCE_ATTEMPT_COMPLETION_LINEAGE_INVALID');
    }
  }

  return {
    status: blockers.length ? 'revalidation_failed' : 'revalidated_durable_lineage_valid',
    valid: blockers.length === 0,
    blockers,
    artifactId: artifact.artifact_id,
    sourceJobId: artifact.job_id,
    producerTaskId: artifact.task_id ?? null,
    producerRole: artifact.producer_role ?? null,
    artifactContentHashMatches: contentHash === artifact.content_hash,
    artifactCreatedEventId: artifactEvents.length === 1 ? artifactEvents[0].event_id : null,
    producerResultId: successfulResults.length === 1 ? successfulResults[0].result_id : null,
    producerCompletionEventId: completion?.event_id ?? null,
    producerAttemptId: attempt?.attempt_id ?? completion?.payload?.attemptId ?? null,
    claimTruthVerified: false,
    independenceVerified: false,
    authorityNote: 'Durable bytes/producer lineage were rechecked. This does not adjudicate claim truth or evidence independence.'
  };
}

/**
 * Read-only integrity and freshness overlay for Goal/Idea Graph state.
 * It deliberately does not verify signatures or trust roots: those require
 * independently administered host configuration, not a diagnostic report.
 */
export function buildAdaptiveGoalGraphIntegrityReport(db) {
  const graphTables = [
    'adaptive_goal_knowledge_nodes', 'adaptive_goal_knowledge_revisions',
    'adaptive_goal_knowledge_memberships', 'adaptive_goal_knowledge_edges', 'adaptive_goal_knowledge_verifications'
  ];
  const missingTables = graphTables.filter(table => !tableExists(db, table));
  if (missingTables.length) return {
    schemaVersion: 1, available: false, status: 'SCHEMA_UNAVAILABLE', missingTables,
    policy: { readOnly: true, signatureVerificationAttempted: false, planningAuthorityEstablished: false }
  };

  const findings = [];
  const addFinding = (code, recordType, recordId, detail = undefined) => findings.push({ code, recordType, recordId, ...(detail ? { detail } : {}) });
  const boundedRows = (table, select, order, limit) => {
    const total = db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count;
    const rows = db.prepare(`SELECT ${select} FROM "${table}" ${order} LIMIT ?`).all(limit + 1);
    return { rows: rows.slice(0, limit), totalCount: total, truncated: total > limit };
  };
  const nodeInventory = boundedRows('adaptive_goal_knowledge_nodes', 'id,stable_key,type,current_revision,created_at', 'ORDER BY id', GRAPH_LIMITS.nodes);
  const revisionInventory = boundedRows('adaptive_goal_knowledge_revisions', 'node_id,revision,content_json,evidence_refs_json,content_hash,status,provenance_json,created_at', 'ORDER BY node_id,revision', GRAPH_LIMITS.revisions);
  const membershipInventory = boundedRows('adaptive_goal_knowledge_memberships', 'node_id,goal_id,created_at,provenance_json', 'ORDER BY node_id,goal_id', GRAPH_LIMITS.memberships);
  const edgeInventory = boundedRows('adaptive_goal_knowledge_edges', 'edge_id,goal_id,from_id,to_id,type,condition_json,outcome_json,evidence_refs_json,provenance_json,created_at', 'ORDER BY edge_id', GRAPH_LIMITS.edges);
  const attestationInventory = boundedRows('adaptive_goal_knowledge_verifications', 'attestation_id,goal_id,snapshot_hash,provider_id,nonce,payload_json,created_at,configuration_fingerprint,trust_key_id,trust_config_version,configuration_source,config_change_reference', 'ORDER BY goal_id,created_at,attestation_id', GRAPH_LIMITS.attestations);
  const nodes = nodeInventory.rows;
  const revisions = revisionInventory.rows;
  const memberships = membershipInventory.rows;
  const edges = edgeInventory.rows;
  const attestations = attestationInventory.rows;
  const inventoryTruncated = Object.entries({ nodes: nodeInventory, revisions: revisionInventory, memberships: membershipInventory,
    edges: edgeInventory, attestations: attestationInventory }).filter(([, inventory]) => inventory.truncated).map(([name]) => name);
  if (inventoryTruncated.length) addFinding('KNOWLEDGE_INVENTORY_TRUNCATED', 'inventory', 'Goal/Idea Graph', inventoryTruncated.join(','));
  const revisionsByNode = new Map();
  for (const revision of revisions) {
    const list = revisionsByNode.get(revision.node_id) || [];
    list.push(revision);
    revisionsByNode.set(revision.node_id, list);
    const content = parseJsonForIntegrity(revision.content_json);
    const evidenceRefs = parseJsonForIntegrity(revision.evidence_refs_json);
    const provenance = parseJsonForIntegrity(revision.provenance_json);
    try {
      if (!isRecord(content) || !Array.isArray(evidenceRefs) || evidenceRefs.some(item => typeof item !== 'string' || !item.trim()) ||
          canonicalJson(content) !== revision.content_json || canonicalJson(evidenceRefs) !== revision.evidence_refs_json ||
          canonicalJson([...new Set(evidenceRefs)].sort()) !== canonicalJson(evidenceRefs) ||
          Buffer.byteLength(revision.content_json, 'utf8') > 64 * 1024 || Buffer.byteLength(revision.evidence_refs_json, 'utf8') > 64 * 1024 ||
          hash(canonicalJson({ content, evidenceRefs })) !== revision.content_hash) {
        addFinding('KNOWLEDGE_REVISION_CONTENT_HASH_MISMATCH', 'revision', `${revision.node_id}@${revision.revision}`);
      }
      if (canonicalProvenance(provenance) !== revision.provenance_json) {
        addFinding('KNOWLEDGE_REVISION_PROVENANCE_NONCANONICAL', 'revision', `${revision.node_id}@${revision.revision}`);
      }
    } catch {
      addFinding('KNOWLEDGE_REVISION_CONTENT_OR_PROVENANCE_INVALID', 'revision', `${revision.node_id}@${revision.revision}`);
    }
    if (revision.status !== 'unverified') addFinding('KNOWLEDGE_REVISION_STATUS_INVALID', 'revision', `${revision.node_id}@${revision.revision}`);
  }
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const allowedNodeTypes = new Set(['goal', 'hypothesis', 'idea', 'capability', 'experiment', 'evidence', 'condition']);
  const currentRows = new Map();
  for (const node of nodes) {
    const history = revisionsByNode.get(node.id) || [];
    const current = history.find(row => row.revision === node.current_revision) || null;
    currentRows.set(node.id, current);
    if (node.id !== `agk-${hash(`${node.type}\0${node.stable_key}`).slice(0, 40)}`) {
      addFinding('KNOWLEDGE_NODE_IDENTITY_INVALID', 'node', node.id);
    }
    if (!allowedNodeTypes.has(node.type) || typeof node.stable_key !== 'string' || !node.stable_key.trim()) {
      addFinding('KNOWLEDGE_NODE_TYPE_OR_STABLE_KEY_INVALID', 'node', node.id);
    }
    if (!Number.isSafeInteger(node.current_revision) || node.current_revision < 1 || history.length !== node.current_revision ||
        history.some((row, index) => row.revision !== index + 1) || history.at(-1)?.revision !== node.current_revision ||
        history.at(-1)?.content_hash !== current?.content_hash || history.at(-1)?.provenance_json !== current?.provenance_json) {
      addFinding('KNOWLEDGE_REVISION_HISTORY_GAP_OR_CURRENT_MISMATCH', 'node', node.id, `current_revision=${node.current_revision}; stored_revisions=${history.length}`);
    }
    if (!current) addFinding('KNOWLEDGE_CURRENT_REVISION_MISSING', 'node', node.id);
  }
  const membershipKeys = new Set();
  for (const membership of memberships) {
    membershipKeys.add(`${membership.node_id}\0${membership.goal_id}`);
    if (!nodeById.has(membership.node_id)) addFinding('KNOWLEDGE_MEMBERSHIP_NODE_MISSING', 'membership', `${membership.node_id}/${membership.goal_id}`);
    try {
      if (canonicalProvenance(parseJsonForIntegrity(membership.provenance_json)) !== membership.provenance_json) {
        addFinding('KNOWLEDGE_MEMBERSHIP_PROVENANCE_NONCANONICAL', 'membership', `${membership.node_id}/${membership.goal_id}`);
      }
    } catch {
      addFinding(membership.provenance_json ? 'KNOWLEDGE_MEMBERSHIP_PROVENANCE_INVALID' : 'KNOWLEDGE_MEMBERSHIP_PROVENANCE_MISSING',
        'membership', `${membership.node_id}/${membership.goal_id}`);
    }
  }
  const allowedEdgeTypes = new Set(['supports', 'tested_by', 'enables', 'contradicts', 'alternative_to', 'recovers_to', 'depends_on', 'requires_all']);
  for (const edge of edges) {
    const recordId = edge.edge_id;
    if (!allowedEdgeTypes.has(edge.type) || edge.from_id === edge.to_id ||
        edge.edge_id !== `age-${hash(JSON.stringify([edge.goal_id, edge.from_id, edge.to_id, edge.type, edge.condition_json, edge.outcome_json])).slice(0, 40)}`) {
      addFinding('KNOWLEDGE_EDGE_IDENTITY_INVALID', 'edge', recordId);
    }
    if (!nodeById.has(edge.from_id) || !nodeById.has(edge.to_id) ||
        !membershipKeys.has(`${edge.from_id}\0${edge.goal_id}`) || !membershipKeys.has(`${edge.to_id}\0${edge.goal_id}`)) {
      addFinding('KNOWLEDGE_EDGE_ENDPOINT_NOT_IN_GOAL', 'edge', recordId);
    }
    const condition = parseJsonForIntegrity(edge.condition_json);
    const outcome = parseJsonForIntegrity(edge.outcome_json);
    const evidenceRefs = parseJsonForIntegrity(edge.evidence_refs_json);
    const provenance = parseJsonForIntegrity(edge.provenance_json);
    const fromNode = nodeById.get(edge.from_id);
    const toNode = nodeById.get(edge.to_id);
    try {
      if ((edge.condition_json === null ? null : canonicalJson(condition)) !== edge.condition_json ||
          (edge.outcome_json === null ? null : canonicalJson(outcome)) !== edge.outcome_json ||
          canonicalJson(evidenceRefs) !== edge.evidence_refs_json || canonicalJson([...new Set(evidenceRefs)].sort()) !== canonicalJson(evidenceRefs) ||
          canonicalProvenance(provenance) !== edge.provenance_json) {
        addFinding('KNOWLEDGE_EDGE_NONCANONICAL', 'edge', recordId);
      }
      if (!Array.isArray(evidenceRefs) || evidenceRefs.length > 64 || evidenceRefs.some(reference =>
        typeof reference !== 'string' || !reference.trim() || reference.length > 2048)) {
        addFinding('KNOWLEDGE_EDGE_EVIDENCE_REFERENCE_INVALID', 'edge', recordId);
      }
    } catch { addFinding('KNOWLEDGE_EDGE_CONTENT_INVALID', 'edge', recordId); }
    if (fromNode && toNode) {
      if (edge.type === 'tested_by' && !(['hypothesis', 'idea'].includes(fromNode.type) && toNode.type === 'experiment')) {
        addFinding('KNOWLEDGE_EDGE_TYPED_CONTRACT_INVALID', 'edge', recordId);
      }
      if (edge.type === 'supports' && !(['hypothesis', 'idea', 'capability', 'experiment', 'evidence', 'goal'].includes(fromNode.type) &&
          ['hypothesis', 'idea', 'capability', 'condition', 'experiment', 'goal'].includes(toNode.type))) {
        addFinding('KNOWLEDGE_EDGE_TYPED_CONTRACT_INVALID', 'edge', recordId);
      }
      if (edge.type === 'enables' && !(['hypothesis', 'idea', 'capability', 'experiment', 'evidence', 'goal'].includes(fromNode.type) &&
          ['idea', 'capability', 'condition', 'experiment', 'goal'].includes(toNode.type))) {
        addFinding('KNOWLEDGE_EDGE_TYPED_CONTRACT_INVALID', 'edge', recordId);
      }
      if (edge.type === 'recovers_to' && !(fromNode.type === 'experiment' && ['experiment', 'idea', 'capability', 'condition'].includes(toNode.type))) {
        addFinding('KNOWLEDGE_EDGE_TYPED_CONTRACT_INVALID', 'edge', recordId);
      }
      if (['contradicts', 'alternative_to'].includes(edge.type) &&
          !(['hypothesis', 'idea', 'candidate', 'evidence', 'condition'].includes(fromNode.type) &&
            ['hypothesis', 'idea', 'candidate', 'evidence', 'condition'].includes(toNode.type))) {
        addFinding('KNOWLEDGE_EDGE_TYPED_CONTRACT_INVALID', 'edge', recordId);
      }
    }
    if (edge.type === 'recovers_to' && (!isRecord(condition) || !isRecord(outcome) ||
        Object.keys(condition || {}).sort().join(',') !== 'predicate,when' ||
        Object.keys(outcome || {}).sort().join(',') !== 'effects,evidenceRefs,state' ||
        !['failed', 'blocked', 'verification_failed', 'evidence_missing', 'contradicted'].includes(condition.when) ||
        !['required_evidence_available', 'verification_failed_with_evidence'].includes(condition.predicate) ||
        typeof outcome.state !== 'string' || !outcome.state.trim() || !Array.isArray(outcome.effects) || outcome.effects.length > 32 ||
        outcome.effects.some(effect => typeof effect !== 'string' || !effect.trim()) || !Array.isArray(outcome.evidenceRefs) ||
        !outcome.evidenceRefs.length || outcome.evidenceRefs.length > 64 || outcome.evidenceRefs.some(reference => typeof reference !== 'string' || !reference.trim()))) {
      addFinding('KNOWLEDGE_RECOVERY_EDGE_CONTRACT_INVALID', 'edge', recordId);
    }
    if (edge.type === 'recovers_to' && isRecord(outcome) && Array.isArray(outcome.evidenceRefs) &&
        nodeById.has(edge.from_id) && nodeById.has(edge.to_id)) {
      const declaredRecoveryEvidence = new Set(memberships.filter(membership => membership.goal_id === edge.goal_id)
        .filter(membership => nodeById.get(membership.node_id)?.type === 'evidence')
        .flatMap(membership => parseJsonForIntegrity(currentRows.get(membership.node_id)?.evidence_refs_json) || []));
      if (outcome.evidenceRefs.some(reference => !declaredRecoveryEvidence.has(reference))) {
        addFinding('KNOWLEDGE_RECOVERY_EVIDENCE_NOT_DECLARED', 'edge', recordId);
      }
    }
    if (edge.type !== 'recovers_to' && (edge.condition_json !== null || edge.outcome_json !== null)) {
      addFinding('KNOWLEDGE_EDGE_UNEXPECTED_CONDITION_OR_OUTCOME', 'edge', recordId);
    }
  }

  const plannerScopeGoals = tableExists(db, 'adaptive_goal_planner_run_goals')
    ? selectAvailable(db, 'adaptive_goal_planner_run_goals', ['goal_id'], 'WHERE goal_kind=?', ['knowledge_scope'], 'ORDER BY goal_id', 'LIMIT 10001')
      .map(row => row.goal_id) : [];
  const goals = new Set([...memberships.map(row => row.goal_id), ...edges.map(row => row.goal_id), ...attestations.map(row => row.goal_id), ...plannerScopeGoals]);
  const goalNodeRowsByGoal = new Map();
  for (const membership of memberships) {
    const group = goalNodeRowsByGoal.get(membership.goal_id) || [];
    group.push(membership.node_id);
    goalNodeRowsByGoal.set(membership.goal_id, group);
  }
  const nonces = new Map();
  for (const attestation of attestations) {
    if (!attestation.provider_id || !attestation.nonce) continue;
    const nonceKey = `${attestation.provider_id}\0${attestation.nonce}`;
    const previous = nonces.get(nonceKey);
    if (previous && previous !== attestation.attestation_id) {
      addFinding('KNOWLEDGE_ATTESTATION_NONCE_REPLAY', 'attestation', attestation.attestation_id, `provider=${attestation.provider_id}`);
    } else nonces.set(nonceKey, attestation.attestation_id);
  }
  const goalReports = [...goals].sort().map(goalId => {
    const goalMemberships = memberships.filter(row => row.goal_id === goalId);
    const goalNodeIds = new Set(goalMemberships.map(row => row.node_id));
    const goalNodeRows = nodes.filter(row => goalNodeIds.has(row.id));
    const revisionHistory = revisions.filter(row => goalNodeIds.has(row.node_id)).map(row => {
      const content = parseJsonForIntegrity(row.content_json);
      const evidenceRefs = parseJsonForIntegrity(row.evidence_refs_json);
      const provenance = parseJsonForIntegrity(row.provenance_json);
      return { node_id: row.node_id, revision: row.revision, content: content ?? null, evidence_refs: evidenceRefs ?? [],
        content_hash: row.content_hash, status: row.status, provenance: provenance ?? null,
        provenance_hash: row.provenance_json ? hash(row.provenance_json) : null, created_at: row.created_at };
    });
    const snapshotNodes = goalNodeRows.map(node => {
      const revision = currentRows.get(node.id);
      const content = parseJsonForIntegrity(revision?.content_json);
      const evidenceRefs = parseJsonForIntegrity(revision?.evidence_refs_json);
      const provenance = parseJsonForIntegrity(revision?.provenance_json);
      return { id: node.id, stable_key: node.stable_key, type: node.type, revision: node.current_revision,
        content: content ?? null, content_hash: revision?.content_hash ?? null, evidence_refs: evidenceRefs ?? [],
        status: revision?.status ?? null, provenance: provenance ?? null,
        provenance_hash: revision?.provenance_json ? hash(revision.provenance_json) : null,
        created_at: revision?.created_at ?? null };
    });
    const snapshotMemberships = memberships.filter(row => goalNodeIds.has(row.node_id)).map(row => {
      const provenance = parseJsonForIntegrity(row.provenance_json);
      return { node_id: row.node_id, goal_id: row.goal_id, provenance: provenance ?? null,
        provenance_hash: row.provenance_json ? hash(row.provenance_json) : null, created_at: row.created_at };
    });
    const snapshotEdges = edges.filter(row => row.goal_id === goalId).map(edge => {
      const provenance = parseJsonForIntegrity(edge.provenance_json);
      return { edge_id: edge.edge_id, goal_id: edge.goal_id, from_id: edge.from_id, to_id: edge.to_id, type: edge.type,
        condition: edge.condition_json === null ? null : parseJsonForIntegrity(edge.condition_json),
        outcome: edge.outcome_json === null ? null : parseJsonForIntegrity(edge.outcome_json),
        evidence_refs: parseJsonForIntegrity(edge.evidence_refs_json) ?? [], provenance: provenance ?? null,
        provenance_hash: edge.provenance_json ? hash(edge.provenance_json) : null, created_at: edge.created_at };
    });
    if (!goalMemberships.length || !goalNodeIds.size) addFinding('KNOWLEDGE_GOAL_GRAPH_EMPTY', 'goal', goalId);
    const graphInventoryTruncated = inventoryTruncated.some(name => ['nodes', 'revisions', 'memberships', 'edges'].includes(name));
    let snapshotHash = null;
    try {
      const snapshot = { schema_version: 1, goal_id: goalId, nodes: snapshotNodes, revision_history: revisionHistory,
        memberships: snapshotMemberships, edges: snapshotEdges };
      if (!graphInventoryTruncated) snapshotHash = hash(canonicalJson(snapshot));
    } catch { addFinding('KNOWLEDGE_SNAPSHOT_CANONICALIZATION_FAILED', 'goal', goalId); }
    const goalFindings = findings.filter(item => (item.recordType === 'goal' && item.recordId === goalId) ||
      item.recordType === 'inventory' ||
      (item.recordType === 'attestation' && goalAttestations.some(attestation => attestation.attestationId === item.recordId)) ||
      (item.recordType === 'node' && goalNodeIds.has(item.recordId)) ||
      (item.recordType === 'revision' && goalNodeIds.has(item.recordId.split('@')[0])) ||
      (item.recordType === 'membership' && goalNodeIds.has(item.recordId.split('/')[0])) ||
      (item.recordType === 'edge' && snapshotEdges.some(edge => edge.edge_id === item.recordId)));
    const goalAttestations = attestations.filter(row => row.goal_id === goalId).map(row => {
      const payload = parseJsonForIntegrity(row.payload_json);
      const expectedId = payload && [payload.goal_id, payload.snapshot_hash, payload.provider_id, payload.nonce, payload.evidence_manifest_hash]
        .every(value => typeof value === 'string')
        ? hash(`${payload.goal_id}|${payload.snapshot_hash}|${payload.provider_id}|${payload.nonce}|${payload.evidence_manifest_hash}`) : null;
      let payloadCanonical = false;
      try { payloadCanonical = isRecord(payload) && row.payload_json === canonicalJson(payload); } catch {}
      const identityValid = isRecord(payload) && row.attestation_id === expectedId && row.snapshot_hash === payload.snapshot_hash &&
        row.provider_id === payload.provider_id && row.nonce === payload.nonce && payloadCanonical;
      return { attestationId: row.attestation_id, snapshotHash: row.snapshot_hash, createdAt: row.created_at,
        identityValid, snapshotFresh: Boolean(snapshotHash && row.snapshot_hash === snapshotHash),
        bindingStatus: !identityValid ? 'invalid_durable_identity' : row.snapshot_hash !== snapshotHash ? 'stale_snapshot' : 'current_snapshot_binding_only',
        signatureVerification: 'not_attempted_requires_host_owned_trust_configuration',
        trustConfigVersion: row.trust_config_version ?? null, trustKeyId: row.trust_key_id ?? null,
        configurationSource: row.configuration_source ?? null };
    });
    const currentBindings = goalAttestations.filter(row => row.identityValid && row.snapshotFresh).length;
    return { goalId, nodeCount: goalNodeIds.size, edgeCount: snapshotEdges.length,
      membershipCount: goalMemberships.length, snapshotHash,
      graphIntegrity: graphInventoryTruncated ? 'INCOMPLETE_INVENTORY' : goalFindings.length ? 'INVALID' : 'NO_STRUCTURAL_FINDINGS',
      findingCount: goalFindings.length, attestationCount: goalAttestations.length,
      currentSnapshotBindingCount: currentBindings, staleAttestationCount: goalAttestations.filter(row => row.bindingStatus === 'stale_snapshot').length,
      attestations: goalAttestations, planningAuthority: 'NOT_ESTABLISHED_BY_READ_ONLY_DIAGNOSTICS' };
  });

  const currentSnapshotByGoal = new Map(goalReports.map(goal => [goal.goalId, goal.snapshotHash]));
  const plannerRunRecords = [];
  if (tableExists(db, 'adaptive_goal_planner_runs') && tableExists(db, 'adaptive_goal_planner_run_evidence')) {
    const runColumns = ['run_id', 'tool_name', 'status', 'started_at', 'finished_at', 'goal_id', 'input_graph_sha256', 'graph_hash',
      'candidate_count', 'partial_candidate_count', 'search_event_count_recorded', 'search_event_count_omitted', 'search_events_truncated',
      'error_code', 'provenance_json', 'process_instance_id', 'schema_version', 'goal_node_id', 'observed_node_count', 'observed_edge_count'];
    const runRows = selectAvailable(db, 'adaptive_goal_planner_runs', runColumns, '', [], 'ORDER BY started_at DESC, run_id', `LIMIT ${GRAPH_LIMITS.plannerRuns + 1}`);
    const runRowsTruncated = runRows.length > GRAPH_LIMITS.plannerRuns;
    runRows.length = Math.min(runRows.length, GRAPH_LIMITS.plannerRuns);
    const revisionByKey = new Map(revisions.map(row => [`${row.node_id}\0${row.revision}`, row]));
    const edgeById = new Map(edges.map(row => [row.edge_id, row]));
    for (const run of runRows) {
      const evidenceRows = selectAvailable(db, 'adaptive_goal_planner_run_evidence',
        ['artifact_id', 'source_job_id', 'classification', 'lineage_verified', 'claim_verified', 'content_hash', 'reference',
          'source_node_id', 'observation_source', 'kind', 'details_json'],
        'WHERE run_id=?', [run.run_id], 'ORDER BY reference', `LIMIT ${GRAPH_LIMITS.evidencePerRun + 1}`);
      const evidenceTruncated = evidenceRows.length > GRAPH_LIMITS.evidencePerRun;
      evidenceRows.length = Math.min(evidenceRows.length, GRAPH_LIMITS.evidencePerRun);
      let revalidatedArtifactCount = 0;
      let artifactLineageInvalidCount = 0;
      let sourceBytesCurrentCount = 0;
      let sourceBytesInvalidCount = 0;
      const evidence = evidenceRows.map(row => {
        const item = { evidenceReferenceSha256: hash(String(row.reference ?? '')),
          artifactId: row.artifact_id ?? null, sourceJobId: row.source_job_id ?? null,
          classification: row.classification ?? null, observationSource: row.observation_source ?? null,
          reportedLineageVerified: row.lineage_verified === 1, reportedClaimVerified: row.claim_verified === 1,
          contentHashPresent: Boolean(row.content_hash), revalidation: 'not_applicable_declared_reference', blockers: [] };
        if (row.observation_source === 'runtime_resolver' && row.artifact_id) {
          const result = revalidatePlannerEvidenceLineage(db, row);
          item.revalidation = result.status;
          item.blockers = result.blockers.map(blocker => blocker.code);
          item.revalidatedDurableLineageValid = result.valid;
          item.revalidatedArtifactContentHashMatches = result.artifactContentHashMatches ?? false;
          item.claimTruthVerified = false;
          item.independenceVerified = false;
          revalidatedArtifactCount += 1;
          if (!result.valid) artifactLineageInvalidCount += 1;
          if (row.lineage_verified === 1 && !result.valid) {
            addFinding('PLANNER_EVIDENCE_REPORTED_VERIFIED_BUT_CURRENT_LINEAGE_INVALID', 'planner_evidence',
              `${run.run_id}/${item.evidenceReferenceSha256}`, item.blockers.join(','));
          }
        } else if (row.observation_source === 'runtime_resolver' && typeof row.reference === 'string' && row.reference.startsWith('file:')) {
          let resolved;
          try { resolved = resolveAdaptiveGoalSourceEvidence([row.reference], { root: REPO_ROOT })[0]; }
          catch { resolved = { classification: 'source_resolver_failed', integrityVerified: false }; }
          const details = parseJsonForIntegrity(row.details_json) || {};
          const detailHash = typeof details.sourceBytesSha256 === 'string' ? details.sourceBytesSha256
            : typeof details.expectedSha256 === 'string' ? details.expectedSha256 : null;
          const digestMatches = detailHash === null ? null : detailHash === resolved.observedSha256 && resolved.integrityVerified === true;
          item.revalidation = resolved.classification || 'source_revalidation_unavailable';
          item.revalidatedSourceIntegrity = resolved.integrityVerified === true;
          item.revalidatedSourceHashMatchesObservedManifest = digestMatches;
          item.claimTruthVerified = false;
          item.independenceVerified = false;
          if (resolved.integrityVerified === true && digestMatches !== false) sourceBytesCurrentCount += 1;
          else sourceBytesInvalidCount += 1;
          if (row.classification === 'source_bytes_verified_claim_unverified' && resolved.integrityVerified !== true) {
            addFinding('PLANNER_SOURCE_BYTES_REPORTED_VERIFIED_BUT_CURRENT_SOURCE_INVALID', 'planner_evidence',
              `${run.run_id}/${item.evidenceReferenceSha256}`, String(resolved.classification));
          }
          item.blockers = resolved.integrityVerified === true ? [] : [String(resolved.classification || 'SOURCE_INTEGRITY_UNVERIFIED')];
        } else if (row.observation_source === 'runtime_resolver' && typeof row.reference === 'string' && row.reference.startsWith('artifact://')) {
          item.revalidation = 'not_revalidated_missing_durable_artifact_identity';
          item.blockers = ['PLANNER_EVIDENCE_ARTIFACT_IDENTITY_MISSING'];
          addFinding('PLANNER_EVIDENCE_RUNTIME_ARTIFACT_IDENTITY_MISSING', 'planner_evidence', `${run.run_id}/${item.evidenceReferenceSha256}`);
        }
        return item;
      });
      let provenance = null;
      try { provenance = parseJsonForIntegrity(run.provenance_json); } catch {}
      const runKnowledgeSnapshotHash = isRecord(provenance) ? provenance.knowledge_snapshot_hash : null;
      const currentSnapshotHash = typeof run.goal_id === 'string' ? currentSnapshotByGoal.get(run.goal_id) ?? null : null;
      const currentSnapshotBinding = !runKnowledgeSnapshotHash ? 'missing_historical_binding'
        : !currentSnapshotHash ? 'current_snapshot_unavailable'
          : runKnowledgeSnapshotHash === currentSnapshotHash ? 'matches_current_snapshot' : 'historical_snapshot_superseded';
      const runNodeRows = selectAvailable(db, 'adaptive_goal_planner_run_nodes',
        ['node_id','node_type','source_kind','knowledge_goal_id','revision','content_hash','provenance_hash','evidence_refs_json','node_snapshot_json'],
        'WHERE run_id=?', [run.run_id], 'ORDER BY node_id', 'LIMIT 10001');
      const runEdgeRows = selectAvailable(db, 'adaptive_goal_planner_run_edges',
        ['edge_id','goal_id','from_node_id','to_node_id','edge_type','source_kind','evidence_refs_json','edge_snapshot_json'],
        'WHERE run_id=?', [run.run_id], 'ORDER BY edge_key', 'LIMIT 20001');
      const runGoalRows = selectAvailable(db, 'adaptive_goal_planner_run_goals', ['goal_id','goal_kind','source_kind'],
        'WHERE run_id=?', [run.run_id], 'ORDER BY goal_id,goal_kind', 'LIMIT 1001');
      const graphFindings = [];
      for (const node of runNodeRows.slice(0, 10_000)) {
        if (node.source_kind !== 'persisted_knowledge') continue;
        const sourceRevision = revisionByKey.get(`${node.node_id}\0${node.revision}`);
        if (!sourceRevision || sourceRevision.content_hash !== node.content_hash || hash(sourceRevision.provenance_json || '') !== node.provenance_hash) {
          graphFindings.push({ code: 'PLANNER_SNAPSHOT_KNOWLEDGE_REVISION_MISSING_OR_SUBSTITUTED', recordIdSha256: hash(String(node.node_id)) });
        }
        const savedRefs = parseJsonForIntegrity(node.evidence_refs_json);
        const nodeSnapshot = parseJsonForIntegrity(node.node_snapshot_json);
        try {
          if (!Array.isArray(savedRefs) || !isRecord(nodeSnapshot) || canonicalJson(savedRefs) !== canonicalJson(nodeSnapshot.evidence_refs || [])) {
            graphFindings.push({ code: 'PLANNER_SNAPSHOT_NODE_EVIDENCE_REFERENCE_MISMATCH', recordIdSha256: hash(String(node.node_id)) });
          }
        } catch { graphFindings.push({ code: 'PLANNER_SNAPSHOT_NODE_EVIDENCE_REFERENCE_INVALID', recordIdSha256: hash(String(node.node_id)) }); }
      }
      for (const edge of runEdgeRows.slice(0, 20_000)) {
        if (edge.source_kind !== 'persisted_knowledge' || !edge.edge_id) continue;
        const sourceEdge = edgeById.get(edge.edge_id);
        let evidenceMatches = false;
        try { evidenceMatches = Boolean(sourceEdge && canonicalJson(parseJsonForIntegrity(sourceEdge.evidence_refs_json)) === canonicalJson(parseJsonForIntegrity(edge.evidence_refs_json))); } catch {}
        if (!sourceEdge || sourceEdge.goal_id !== edge.goal_id || sourceEdge.from_id !== edge.from_node_id ||
            sourceEdge.to_id !== edge.to_node_id || sourceEdge.type !== edge.edge_type || !evidenceMatches) {
          graphFindings.push({ code: 'PLANNER_SNAPSHOT_KNOWLEDGE_EDGE_MISSING_OR_SUBSTITUTED', recordIdSha256: hash(String(edge.edge_id)) });
        }
      }
      if (runNodeRows.length > 10_000) graphFindings.push({ code: 'PLANNER_SNAPSHOT_NODE_INVENTORY_TRUNCATED', recordIdSha256: hash(run.run_id) });
      if (runEdgeRows.length > 20_000) graphFindings.push({ code: 'PLANNER_SNAPSHOT_EDGE_INVENTORY_TRUNCATED', recordIdSha256: hash(run.run_id) });
      if (runGoalRows.length > 1000) graphFindings.push({ code: 'PLANNER_SNAPSHOT_GOAL_INVENTORY_TRUNCATED', recordIdSha256: hash(run.run_id) });
      plannerRunRecords.push({ ...run, provenance_json: undefined, process_instance_id: undefined,
        evidenceCount: evidenceRows.length, evidenceInventoryTruncated: evidenceTruncated,
        reportedLineageVerifiedCount: evidenceRows.filter(row => row.lineage_verified === 1).length,
        reportedClaimVerifiedCount: evidenceRows.filter(row => row.claim_verified === 1).length,
        evidenceRevalidation: { artifactRecordsRevalidated: revalidatedArtifactCount, artifactLineageInvalid: artifactLineageInvalidCount,
          sourceBytesCurrent: sourceBytesCurrentCount, sourceBytesInvalidOrUnresolved: sourceBytesInvalidCount,
          claimTruthAdjudicationPerformed: false, independenceAdjudicationPerformed: false },
        knowledgeSnapshotBinding: { recordedHashPresent: Boolean(runKnowledgeSnapshotHash), bindingToCurrentSnapshot: currentSnapshotBinding,
          currentSnapshotHashAvailable: Boolean(currentSnapshotHash), neverReinterpretsHistoricalSnapshotAsCurrent: true },
        graphSnapshotInventory: { nodeCount: runNodeRows.length, edgeCount: runEdgeRows.length, goalCount: runGoalRows.length,
          truncated: runNodeRows.length > 10_000 || runEdgeRows.length > 20_000 || runGoalRows.length > 1000 },
        graphFindings, evidence });
    }
  }
  const plannerSummary = {
    totalRuns: tableExists(db, 'adaptive_goal_planner_runs') ? db.prepare('SELECT COUNT(*) AS count FROM adaptive_goal_planner_runs').get().count : null,
    reportedFailedRuns: plannerRunRecords.filter(row => row.status === 'failed').length,
    runsWithOmittedEvents: plannerRunRecords.filter(row => Number(row.search_event_count_omitted || 0) > 0 || row.search_events_truncated === 1).length,
    evidenceRecords: plannerRunRecords.reduce((sum, row) => sum + row.evidenceCount, 0),
    evidenceLineageReportedVerified: plannerRunRecords.reduce((sum, row) => sum + row.reportedLineageVerifiedCount, 0),
    evidenceClaimsReportedVerified: plannerRunRecords.reduce((sum, row) => sum + row.reportedClaimVerifiedCount, 0),
    reportingLimit: GRAPH_LIMITS.plannerRuns, reportingTruncated: plannerRunRecords.length >= GRAPH_LIMITS.plannerRuns,
    sourceEvidenceRevalidationBoundToRepository: true, artifactLineageRevalidationUsesCurrentDurableRecords: true,
    selfReportedFlagsRemainNonAuthoritative: true
  };
  const proposalRecords = [];
  const proposalFindings = [];
  let proposalEventInventoryTruncated = false;
  let proposalEventCount = 0;
  if (tableExists(db, 'events') && tableExists(db, 'jobs')) {
    proposalEventCount = db.prepare(`SELECT COUNT(*) AS count FROM events
      WHERE type IN ('job.proposal_requested','adaptive_goal.execution_plan_candidate_created')`).get().count;
    const proposalEvents = db.prepare(`SELECT e.event_id,e.job_id,e.type,e.payload_json,e.created_at,j.state AS job_state,j.status AS job_status
      FROM events e LEFT JOIN jobs j ON j.job_id=e.job_id
      WHERE e.type IN ('job.proposal_requested','adaptive_goal.execution_plan_candidate_created')
      ORDER BY e.created_at DESC,e.rowid DESC LIMIT ?`).all(5001);
    proposalEventInventoryTruncated = proposalEventCount > 5000;
    for (const event of proposalEvents.slice(0, 5000)) {
      const payload = parseJsonForIntegrity(event.payload_json);
      if (!isRecord(payload)) {
        proposalFindings.push({ code: 'AGG_PROPOSAL_EVENT_PAYLOAD_INVALID', eventId: event.event_id, jobId: event.job_id });
        continue;
      }
      if (isRecord(payload.adaptive_goal_plan_proposal)) {
        const plan = payload.adaptive_goal_plan_proposal;
        const source = isRecord(plan.source) ? plan.source : {};
        const draft = isRecord(plan.draft) ? plan.draft : {};
        const sourceGraph = isRecord(plan.source_graph) ? plan.source_graph : {};
        const knowledgeSnapshot = isRecord(plan.knowledge_graph_snapshot) ? plan.knowledge_graph_snapshot : null;
        const draftSteps = Array.isArray(draft.steps) ? draft.steps : [];
        const sourceGraphNodes = Array.isArray(sourceGraph.nodes) ? sourceGraph.nodes : [];
        const sourceNodeById = new Map();
        const sourceLineageFindings = [];
        for (const [index, node] of sourceGraphNodes.entries()) {
          if (!isRecord(node) || typeof node.id !== 'string' || !node.id.trim()) {
            sourceLineageFindings.push({ reason: 'SOURCE_GRAPH_NODE_ID_INVALID', index });
            continue;
          }
          if (sourceNodeById.has(node.id)) {
            sourceLineageFindings.push({ reason: 'SOURCE_GRAPH_NODE_ID_DUPLICATE', index, sourceNodeId: node.id });
            continue;
          }
          sourceNodeById.set(node.id, node);
        }
        const stepIds = new Set();
        const stepIndexById = new Map();
        const stepById = new Map();
        const sourceNodeIdsUsed = new Set();
        for (const [index, step] of draftSteps.entries()) {
          if (!isRecord(step) || typeof step.id !== 'string' || !step.id.trim()) {
            sourceLineageFindings.push({ reason: 'PLAN_STEP_ID_INVALID', index });
            continue;
          }
          if (stepIds.has(step.id)) sourceLineageFindings.push({ reason: 'PLAN_STEP_ID_DUPLICATE', index, stepId: step.id });
          stepIds.add(step.id);
          if (!stepIndexById.has(step.id)) {
            stepIndexById.set(step.id, index);
            stepById.set(step.id, step);
          }
          if (typeof step.sourceNodeId !== 'string' || !sourceNodeById.has(step.sourceNodeId)) {
            sourceLineageFindings.push({ reason: 'PLAN_STEP_SOURCE_NODE_UNRESOLVED', index, stepId: step.id,
              sourceNodeId: typeof step.sourceNodeId === 'string' ? step.sourceNodeId : null });
          } else {
            const sourceNode = sourceNodeById.get(step.sourceNodeId);
            if (!['task', 'experiment'].includes(sourceNode.type)) sourceLineageFindings.push({
              reason: 'PLAN_STEP_SOURCE_NODE_NOT_ACTIONABLE', index, stepId: step.id,
              sourceNodeId: step.sourceNodeId, sourceNodeType: sourceNode.type ?? null
            });
            if (sourceNodeIdsUsed.has(step.sourceNodeId)) sourceLineageFindings.push({
              reason: 'PLAN_STEP_SOURCE_NODE_REUSED', index, stepId: step.id, sourceNodeId: step.sourceNodeId
            });
            sourceNodeIdsUsed.add(step.sourceNodeId);
          }
          if (!Array.isArray(step.dependencies)) {
            sourceLineageFindings.push({ reason: 'PLAN_STEP_DEPENDENCIES_INVALID', index, stepId: step.id });
          } else {
            const seenDependencies = new Set();
            for (const dependencyId of step.dependencies) {
              if (typeof dependencyId !== 'string' || !dependencyId.trim() || dependencyId === step.id || seenDependencies.has(dependencyId)) {
                sourceLineageFindings.push({ reason: 'PLAN_STEP_DEPENDENCY_INVALID', index, stepId: step.id,
                  dependencyId: typeof dependencyId === 'string' ? dependencyId : null });
              }
              seenDependencies.add(dependencyId);
            }
          }
        }
        for (const [index, step] of draftSteps.entries()) {
          if (!isRecord(step) || !Array.isArray(step.dependencies)) continue;
          for (const dependencyId of step.dependencies) {
            if (typeof dependencyId !== 'string') continue;
            if (!stepIds.has(dependencyId)) {
              sourceLineageFindings.push({ reason: 'PLAN_STEP_DEPENDENCY_UNRESOLVED', index, stepId: step.id, dependencyId });
              continue;
            }
            const dependencyIndex = stepIndexById.get(dependencyId);
            if (dependencyIndex >= index) sourceLineageFindings.push({
              reason: 'PLAN_STEP_DEPENDENCY_ORDER_INVALID', index, stepId: step.id, dependencyId, dependencyIndex
            });
          }
        }
        const stepIdBySourceNodeId = new Map(draftSteps.filter(step => isRecord(step) && typeof step.id === 'string' &&
          typeof step.sourceNodeId === 'string').map(step => [step.sourceNodeId, step.id]));
        const sourceGraphEdges = Array.isArray(sourceGraph.edges) ? sourceGraph.edges : [];
        for (const [index, edge] of sourceGraphEdges.entries()) {
          if (!isRecord(edge) || !['requires_all', 'depends_on'].includes(edge.type) ||
              typeof edge.from !== 'string' || typeof edge.to !== 'string') continue;
          const prerequisiteNodeId = edge.type === 'requires_all' ? edge.from : edge.to;
          const dependentNodeId = edge.type === 'requires_all' ? edge.to : edge.from;
          const prerequisiteStepId = stepIdBySourceNodeId.get(prerequisiteNodeId);
          const dependentStepId = stepIdBySourceNodeId.get(dependentNodeId);
          if (!prerequisiteStepId || !dependentStepId) continue;
          const dependentStep = stepById.get(dependentStepId);
          if (!Array.isArray(dependentStep?.dependencies) || !dependentStep.dependencies.includes(prerequisiteStepId)) {
            sourceLineageFindings.push({ reason: 'SOURCE_GRAPH_PREREQUISITE_NOT_PROJECTED', index, prerequisiteNodeId,
              dependentNodeId, prerequisiteStepId, dependentStepId });
          }
        }
        for (const finding of sourceLineageFindings) proposalFindings.push({
          code: 'AGG_PLAN_GRAPH_PROPOSAL_SOURCE_LINEAGE_INVALID', eventId: event.event_id, jobId: event.job_id,
          ...finding, authorityEstablished: false
        });
        const stepEvidenceAssessments = draftSteps.map((step, index) => {
          const refs = Array.isArray(step?.supportingEvidenceRefs)
            ? step.supportingEvidenceRefs.filter(reference => typeof reference === 'string' && reference.trim()) : [];
          const assessment = isRecord(step?.evidenceAssessment) ? step.evidenceAssessment : {};
          const missing = refs.length === 0;
          return {
            stepId: typeof step?.id === 'string' ? step.id : null,
            sourceNodeId: typeof step?.sourceNodeId === 'string' ? step.sourceNodeId : null,
            index,
            declaredReferenceCount: refs.length,
            evidenceAssessmentStatus: typeof assessment.status === 'string' ? assessment.status : 'unknown_or_absent',
            verifiedReferenceCount: Number.isSafeInteger(assessment.verifiedReferenceCount) ? assessment.verifiedReferenceCount : null,
            status: missing ? 'BLOCKED_MISSING_SUPPORTING_EVIDENCE' : 'DECLARED_REQUIRES_DURABLE_LINEAGE_REVALIDATION',
            blockerCode: missing ? 'STEP_EVIDENCE_MISSING' : null,
            claimTruthVerified: false,
            evidenceLineageRevalidated: false
          };
        });
        const missingEvidenceStepCount = stepEvidenceAssessments.filter(step => step.blockerCode === 'STEP_EVIDENCE_MISSING').length;
        const sourceVerificationStatus = source.verification?.status ?? 'unverified_or_unknown';
        const readinessFindings = [];
        readinessFindings.push({
          code: 'GOAL_IDEA_SOURCE_VERIFICATION_NOT_INDEPENDENTLY_REVALIDATED',
          message: 'The reconciliation report does not cryptographically verify the persisted source attestation; revalidate the exact current snapshot through the configured host-owned verifier.',
          observedSourceVerificationStatus: sourceVerificationStatus,
          authorityEstablished: false
        });
        if (sourceVerificationStatus !== 'verified') readinessFindings.push({
          code: 'GOAL_IDEA_SOURCE_VERIFICATION_NOT_AUTHENTICATED',
          message: 'The stored Plan Graph source is not bound to an in-process authenticated verifier result.',
          authorityEstablished: false
        });
        if (!knowledgeSnapshot || !/^[a-f0-9]{64}$/.test(String(knowledgeSnapshot.snapshot_hash || ''))) readinessFindings.push({
          code: 'GOAL_IDEA_SNAPSHOT_BINDING_MISSING',
          message: 'The stored Plan Graph proposal does not bind a canonical Goal/Idea snapshot hash and attestation identity.',
          authorityEstablished: false
        });
        for (const step of stepEvidenceAssessments.filter(item => item.blockerCode)) readinessFindings.push({
          code: step.blockerCode, stepId: step.stepId, sourceNodeId: step.sourceNodeId,
          message: 'This Plan Graph step declares no supporting evidence reference.', authorityEstablished: false
        });
        for (const finding of sourceLineageFindings) readinessFindings.push({
          code: `PLAN_GRAPH_${finding.reason}`, stepId: finding.stepId ?? null, sourceNodeId: finding.sourceNodeId ?? null,
          dependencyId: finding.dependencyId ?? null,
          message: 'Persisted Plan Graph step/source/dependency references do not form a valid mapping to the recorded Goal/Idea source graph.',
          authorityEstablished: false
        });
        const expectedFingerprintFields = {
          schemaVersion: 1, workflowId: payload.workflowId, workspace: payload.workspace,
          candidatePlanId: source.candidate_plan_id, draftHash: source.draft_hash, bindingHash: plan.binding_hash,
          projectionOptions: plan.projection_options
        };
        if (knowledgeSnapshot) {
          expectedFingerprintFields.knowledgeGraphSnapshotHash = knowledgeSnapshot.snapshot_hash;
          expectedFingerprintFields.knowledgeGraphAttestationId = knowledgeSnapshot.attestation_id;
          expectedFingerprintFields.knowledgeEvidenceManifestHash = knowledgeSnapshot.evidence_manifest_hash;
        }
        const fingerprintRecomputed = hash(JSON.stringify(expectedFingerprintFields));
        const checks = {
          schemaVersionValid: plan.schema_version === 1,
          fingerprintMatchesStoredFields: fingerprintRecomputed === plan.fingerprint,
          sourceDraftHashMatches: typeof draft.draftHash === 'string' && draft.draftHash === source.draft_hash,
          bindingHashPresent: /^[a-f0-9]{64}$/.test(String(plan.binding_hash || '')),
          sourceGraphHashPresent: /^[a-f0-9]{64}$/.test(String(source.graph_hash || '')),
          knowledgeSnapshotBound: Boolean(knowledgeSnapshot &&
            /^[a-f0-9]{64}$/.test(String(knowledgeSnapshot.snapshot_hash || '')) &&
            /^[a-f0-9]{64}$/.test(String(knowledgeSnapshot.evidence_manifest_hash || '')) &&
            typeof knowledgeSnapshot.attestation_id === 'string' && knowledgeSnapshot.attestation_id.length > 0),
          sourceVerificationMetadataComplete: Boolean(isRecord(source.verification) && source.verification.verified === true &&
            typeof source.verification.providerId === 'string' && source.verification.providerId.length > 0 &&
            typeof source.verification.attestationId === 'string' && source.verification.attestationId.length > 0 &&
            /^[a-f0-9]{64}$/.test(String(source.verification.trustRootSha256 || '')) &&
            /^[a-f0-9]{64}$/.test(String(source.verification.snapshotHash || '')) &&
            /^[a-f0-9]{64}$/.test(String(source.verification.evidenceManifestHash || '')) &&
            typeof source.verification.issuedAt === 'string' && typeof source.verification.expiresAt === 'string'),
          sourceNodeLineageValid: sourceLineageFindings.length === 0,
          signatureVerificationPerformed: false
        };
        if (!checks.schemaVersionValid || !checks.fingerprintMatchesStoredFields || !checks.sourceDraftHashMatches ||
            !checks.bindingHashPresent || !checks.sourceGraphHashPresent) {
          proposalFindings.push({ code: 'AGG_PLAN_GRAPH_PROPOSAL_INTERNAL_BINDING_INVALID', eventId: event.event_id, jobId: event.job_id,
            failedChecks: Object.entries(checks).filter(([key, value]) => key !== 'signatureVerificationPerformed' && value !== true).map(([key]) => key) });
        }
        proposalRecords.push({ kind: 'plan_graph_proposal', eventId: event.event_id, jobId: event.job_id,
          createdAt: event.created_at, workflowState: event.job_state ?? null, workflowStatus: event.job_status ?? null,
          fingerprint: typeof plan.fingerprint === 'string' ? plan.fingerprint : null,
          sourceCandidatePlanId: typeof source.candidate_plan_id === 'string' ? source.candidate_plan_id : null,
          sourceGraphHash: typeof source.graph_hash === 'string' ? source.graph_hash : null,
          draftHash: typeof source.draft_hash === 'string' ? source.draft_hash : null,
          bindingHash: typeof plan.binding_hash === 'string' ? plan.binding_hash : null,
          sourceVerificationStatus, checks,
          readinessAssessment: {
            status: readinessFindings.length ? 'BLOCKED' : 'DECLARED_EVIDENCE_REQUIRES_RUNTIME_REVALIDATION',
            findingCount: readinessFindings.length,
            missingEvidenceStepCount,
            stepCount: draftSteps.length,
            evidenceReadinessIsDiagnosticOnly: true,
            evidenceLineageRevalidationPerformed: false,
            claimTruthVerified: false,
            authorizationGranted: false
          },
          stepEvidenceAssessments, readinessFindings,
          sourceLineage: { valid: sourceLineageFindings.length === 0, findingCount: sourceLineageFindings.length,
            findings: sourceLineageFindings, sourceNodeCount: sourceGraphNodes.length,
            distinctMappedSourceNodeCount: sourceNodeIdsUsed.size, draftStepIdsUnique: stepIds.size === draftSteps.length },
          downstreamExecutionGraphProposalFoundInSameEvent: Boolean(payload.adaptive_goal_execution_graph_proposal),
          humanApprovalRequired: true, authorizationGranted: false });
      }
      if (isRecord(payload.adaptive_goal_execution_graph_proposal)) {
        const snapshot = payload.adaptive_goal_execution_graph_proposal;
        const graph = isRecord(snapshot.execution_graph_proposal) ? snapshot.execution_graph_proposal : {};
        const checks = {
          schemaVersionValid: snapshot.schema_version === 1,
          wrapperFingerprintMatchesGraph: snapshot.fingerprint === graph.fingerprint,
          wrapperHashMatchesGraph: snapshot.proposal_hash === graph.proposalHash,
          sourcePlanProposalJobIdPresent: typeof snapshot.source_plan_proposal_job_id === 'string' && Boolean(snapshot.source_plan_proposal_job_id),
          taskBindingsAreArray: Array.isArray(snapshot.task_bindings),
          signatureVerificationPerformed: false
        };
        if (!checks.schemaVersionValid || !checks.wrapperFingerprintMatchesGraph || !checks.wrapperHashMatchesGraph ||
            !checks.sourcePlanProposalJobIdPresent || !checks.taskBindingsAreArray) {
          proposalFindings.push({ code: 'AGG_EXECUTION_GRAPH_PROPOSAL_INTERNAL_BINDING_INVALID', eventId: event.event_id, jobId: event.job_id,
            failedChecks: Object.entries(checks).filter(([key, value]) => key !== 'signatureVerificationPerformed' && value !== true).map(([key]) => key) });
        }
        proposalRecords.push({ kind: 'execution_graph_proposal', eventId: event.event_id, jobId: event.job_id,
          createdAt: event.created_at, workflowState: event.job_state ?? null, workflowStatus: event.job_status ?? null,
          fingerprint: typeof snapshot.fingerprint === 'string' ? snapshot.fingerprint : null,
          proposalHash: typeof snapshot.proposal_hash === 'string' ? snapshot.proposal_hash : null,
          sourcePlanProposalJobId: snapshot.source_plan_proposal_job_id ?? null,
          sourceCandidatePlanId: graph.source?.candidatePlanId ?? null,
          checks, humanApprovalRequired: true, authorizationGranted: false,
          graphFlags: isRecord(graph.gates) ? { dispatchAllowed: graph.gates.dispatchAllowed === true,
            executionAuthorized: graph.gates.executionAuthorized === true, immutableExecutionPlanCreated: graph.gates.immutableExecutionPlanCreated === true } : null });
      }
      if (event.type === 'adaptive_goal.execution_plan_candidate_created') {
        const candidate = isRecord(payload.candidate) ? payload.candidate : {};
        proposalRecords.push({ kind: 'execution_plan_candidate_event', eventId: event.event_id, jobId: event.job_id,
          createdAt: event.created_at, workflowState: event.job_state ?? null, workflowStatus: event.job_status ?? null,
          fingerprint: payload.fingerprint ?? candidate.fingerprint ?? null, candidateHash: payload.candidate_hash ?? candidate.candidateHash ?? null,
          candidatePlanHash: candidate.executionPlan?.plan_hash ?? null,
          candidateHashMatchesPayload: Boolean(payload.candidate_hash && payload.candidate_hash === candidate.candidateHash),
          signatureVerificationPerformed: false, requiresIndependentReviewerVerificationOnConsumption: true,
          dispatchAllowedByCandidateAlone: false });
      }
    }
    if (proposalEventInventoryTruncated) proposalFindings.push({ code: 'AGG_PROPOSAL_EVENT_INVENTORY_TRUNCATED', inspected: 5000, observedAtLeast: proposalEventCount });
  }
  const proposalSummary = {
    proposalEventsObserved: proposalEventCount,
    proposalRecordsObserved: proposalRecords.length,
    planGraphProposals: proposalRecords.filter(item => item.kind === 'plan_graph_proposal').length,
    executionGraphProposals: proposalRecords.filter(item => item.kind === 'execution_graph_proposal').length,
    executionPlanCandidateEvents: proposalRecords.filter(item => item.kind === 'execution_plan_candidate_event').length,
    planGraphStepsObserved: proposalRecords.filter(item => item.kind === 'plan_graph_proposal')
      .reduce((sum, item) => sum + (item.readinessAssessment?.stepCount || 0), 0),
    planGraphStepsMissingEvidence: proposalRecords.filter(item => item.kind === 'plan_graph_proposal')
      .reduce((sum, item) => sum + (item.readinessAssessment?.missingEvidenceStepCount || 0), 0),
    planGraphProposalsWithoutAuthenticatedSnapshotBinding: proposalRecords.filter(item => item.kind === 'plan_graph_proposal')
      .filter(item => item.readinessFindings?.some(finding => finding.code === 'GOAL_IDEA_SNAPSHOT_BINDING_MISSING')).length,
    planGraphProposalsWithUnverifiedSource: proposalRecords.filter(item => item.kind === 'plan_graph_proposal')
      .filter(item => item.readinessFindings?.some(finding => finding.code === 'GOAL_IDEA_SOURCE_VERIFICATION_NOT_AUTHENTICATED')).length,
    planGraphProposalsWithoutIndependentSourceRevalidation: proposalRecords.filter(item => item.kind === 'plan_graph_proposal')
      .filter(item => item.readinessFindings?.some(finding => finding.code === 'GOAL_IDEA_SOURCE_VERIFICATION_NOT_INDEPENDENTLY_REVALIDATED')).length,
    planGraphProposalsWithInvalidSourceLineage: proposalRecords.filter(item => item.kind === 'plan_graph_proposal')
      .filter(item => item.sourceLineage?.valid === false).length,
    eventInventoryTruncated: proposalEventInventoryTruncated,
    internalBindingFindings: proposalFindings.length,
    internalFingerprintChecksAreNotAuthenticityOrApproval: true
  };
  const findingCounts = findings.reduce((counts, item) => { counts[item.code] = (counts[item.code] || 0) + 1; return counts; }, {});
  return { schemaVersion: 1, available: true, status: findings.length ? 'STRUCTURAL_FINDINGS' : 'NO_STRUCTURAL_FINDINGS',
    counts: { nodes: nodes.length, revisions: revisions.length, memberships: memberships.length, edges: edges.length,
      attestations: attestations.length, goals: goalReports.length },
    summary: { findingCount: findings.length, findingCounts,
      goalsWithCurrentSnapshotBindingOnly: goalReports.filter(goal => goal.currentSnapshotBindingCount > 0).length,
      goalsWithoutAnyAttestation: goalReports.filter(goal => goal.attestationCount === 0).length,
      planningAuthorityEstablished: false },
    goals: goalReports, findings, plannerSummary, plannerRuns: plannerRunRecords,
    proposalSummary, proposalRecords, proposalFindings,
    policy: { readOnly: true, signatureVerificationAttempted: false, selfAssertedVerificationFlagsAreNotAuthority: true,
      currentSnapshotBindingDoesNotProveSignatureValidity: true, missingAttestationBlocksPlanning: true,
      trustConfigAndExternalAnchorRequiredForPlanningAuthority: true } };
}

function summarizePayload(value, result = {}, depth = 0) {
  if (!isRecord(value) || depth > 5 || Object.keys(result).length >= 32) return result;
  for (const [key, item] of Object.entries(value)) {
    if (EVENT_KEYS.test(key)) {
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item === null) {
        result[key] = typeof item === 'string' ? item.slice(0, 240) : item;
      } else if (isRecord(item)) {
        for (const [childKey, childValue] of Object.entries(item)) {
          if (/^(id|task_?id|attempt_?id|result_?id|artifact_?id|lease_?id|status|role|type)$/i.test(childKey) &&
              (typeof childValue === 'string' || typeof childValue === 'number' || typeof childValue === 'boolean')) {
            result[`${key}.${childKey}`] = String(childValue).slice(0, 240);
          }
        }
      }
    }
    if (isRecord(item)) summarizePayload(item, result, depth + 1);
    else if (Array.isArray(item)) for (const child of item.slice(0, 5)) if (isRecord(child)) summarizePayload(child, result, depth + 1);
    if (Object.keys(result).length >= 32) break;
  }
  return result;
}

function correlatedTaskId(event) {
  const payload = parseJson(event.payload_json || '{}');
  const fields = summarizePayload(payload);
  return firstDefined(fields.task_id, fields.taskId, fields.task, fields['task.id'], fields['task.task_id'], fields['task.taskId']);
}

function processObservation(pid, procRoot) {
  if (!Number.isSafeInteger(pid) || pid < 2) return { observed: false, reason: 'no_valid_execution_pid_recorded' };
  try {
    const base = path.join(procRoot, String(pid));
    const cmdline = fs.readFileSync(path.join(base, 'cmdline'));
    const status = fs.readFileSync(path.join(base, 'status'), 'utf8');
    const statLine = fs.readFileSync(path.join(base, 'stat'), 'utf8');
    const closeParen = statLine.lastIndexOf(')');
    const statFieldsAfterCommand = closeParen >= 0 ? statLine.slice(closeParen + 2).trim().split(/\s+/) : [];
    const startTimeTicks = statFieldsAfterCommand[19] || null; // /proc/<pid>/stat field 22 (starttime)
    const processName = /^Name:\s*(.+)$/m.exec(status)?.[1] || null;
    return { observed: true, identityVerified: false, reason: 'pid_starttime_not_bound_to_persisted_execution_identity',
      pid, processName, startTimeTicks, commandHash: hash(cmdline), cmdlineBytes: cmdline.length };
  } catch (error) {
    return { observed: false, pid, reason: error?.code === 'ENOENT' ? 'proc_entry_not_found' : 'proc_entry_unreadable' };
  }
}

function listTaskRows(db, jobId, { nowMs, procRoot }) {
  const tasks = selectAvailable(db, 'tasks', [
    'task_id', 'job_id', 'role', 'status', 'openclaw_run_id', 'openclaw_session_key', 'parent_task_id',
    'dependency_json', 'metadata_json', 'created_at', 'updated_at', 'execution_session_id', 'execution_status',
    'execution_attempt', 'execution_pid', 'execution_exit_code', 'execution_started_at', 'execution_finished_at'
  ], 'WHERE job_id=?', [jobId], 'ORDER BY created_at, task_id');
  return tasks.map(task => {
    const attempts = selectAvailable(db, 'attempts', ['attempt_id', 'task_id', 'status', 'openclaw_run_id', 'started_at', 'finished_at', 'error'],
      'WHERE task_id=?', [task.task_id], 'ORDER BY started_at DESC, rowid DESC', 'LIMIT 5');
    const results = selectAvailable(db, 'results', ['result_id', 'task_id', 'outcome', 'created_at'],
      'WHERE task_id=?', [task.task_id], 'ORDER BY created_at DESC, rowid DESC', 'LIMIT 5');
    const artifacts = selectAvailable(db, 'artifacts', ['artifact_id', 'job_id', 'task_id', 'kind', 'created_at', 'schema_version',
      'producer_role', 'status', 'supersedes', 'content_hash'], 'WHERE task_id=?', [task.task_id], 'ORDER BY created_at DESC, rowid DESC', 'LIMIT 8');
    const leases = selectAvailable(db, 'task_leases', ['lease_id', 'task_id', 'job_id', 'attempt', 'worker_id', 'state', 'issued_at',
      'heartbeat_at', 'expires_at', 'released_at', 'last_error', 'owner_epoch'], 'WHERE task_id=?', [task.task_id], 'ORDER BY rowid DESC', 'LIMIT 5');
    const latestAttempt = attempts[0] || null;
    const activeLeases = leases.filter(lease => String(lease.state || '').toUpperCase() === 'ACTIVE');
    const updatedAge = ageMs(task.updated_at, nowMs);
    const flags = [];
    if (task.status === 'running' && Number(task.execution_attempt ?? 0) === 0 && !task.execution_started_at && task.execution_pid == null && !task.execution_session_id) {
      flags.push('RUNNING_TASK_WITHOUT_EXECUTION_METADATA');
    }
    if (task.status === 'running' && latestAttempt && ['started', 'running', 'executing'].includes(String(latestAttempt.status || '').toLowerCase()) && activeLeases.length === 0) {
      flags.push('ACTIVE_ATTEMPT_WITHOUT_ACTIVE_LEASE');
    }
    if (task.status === 'running' && activeLeases.length > 0 && activeLeases.every(lease =>
      timestampMs(lease.expires_at) == null || timestampMs(lease.expires_at) <= nowMs)) {
      flags.push('RUNNING_TASK_WITH_EXPIRED_OR_INVALID_LEASE');
    }
    const crossJobArtifacts = artifacts.filter(artifact => artifact.job_id && artifact.job_id !== jobId);
    if (crossJobArtifacts.length) flags.push('ARTIFACT_JOB_TASK_LINEAGE_MISMATCH');
    const producerRoleMismatches = artifacts.filter(artifact => artifact.producer_role && task.role &&
      String(artifact.producer_role).toLowerCase() !== String(task.role).toLowerCase());
    if (producerRoleMismatches.length) flags.push('ARTIFACT_PRODUCER_ROLE_MISMATCH');
    const successfulResultsWhileRunning = task.status === 'running' && results.some(result =>
      ['success', 'succeeded', 'completed'].includes(String(result.outcome || '').toLowerCase()));
    if (successfulResultsWhileRunning) flags.push('SUCCESS_RESULT_WITH_NONTERMINAL_TASK');
    const mismatchedLeases = leases.filter(lease => String(lease.state || '').toUpperCase() === 'ACTIVE' &&
      lease.attempt != null && task.execution_attempt != null && Number(lease.attempt) !== Number(task.execution_attempt));
    if (mismatchedLeases.length) flags.push('ACTIVE_LEASE_ATTEMPT_MISMATCH');
    const activeLeaseLineageMismatches = activeLeases.filter(lease =>
      (lease.job_id != null && lease.job_id !== jobId) || (lease.task_id != null && lease.task_id !== task.task_id));
    if (activeLeaseLineageMismatches.length) flags.push('ACTIVE_LEASE_JOB_TASK_LINEAGE_MISMATCH');
    const activeLeasesWithoutOwnerEpoch = activeLeases.filter(lease =>
      !Number.isSafeInteger(Number(lease.owner_epoch)) || Number(lease.owner_epoch) < 0 || lease.owner_epoch == null || lease.owner_epoch === '');
    if (activeLeasesWithoutOwnerEpoch.length) flags.push('ACTIVE_LEASE_OWNER_EPOCH_UNAVAILABLE');
    const taskRunId = typeof task.openclaw_run_id === 'string' && task.openclaw_run_id.trim() ? task.openclaw_run_id : null;
    const attemptRunId = typeof latestAttempt?.openclaw_run_id === 'string' && latestAttempt.openclaw_run_id.trim()
      ? latestAttempt.openclaw_run_id : null;
    if (taskRunId && attemptRunId && taskRunId !== attemptRunId) flags.push('TASK_ATTEMPT_PROVIDER_RUN_ID_MISMATCH');
    if ((taskRunId && !attemptRunId) || (!taskRunId && attemptRunId)) flags.push('TASK_ATTEMPT_PROVIDER_RUN_ID_BINDING_INCOMPLETE');
    const observedCounts = {
      attempts: selectAvailable(db, 'attempts', ['attempt_id'], 'WHERE task_id=?', [task.task_id]).length,
      results: selectAvailable(db, 'results', ['result_id'], 'WHERE task_id=?', [task.task_id]).length,
      artifacts: selectAvailable(db, 'artifacts', ['artifact_id'], 'WHERE task_id=?', [task.task_id]).length,
      leases: selectAvailable(db, 'task_leases', ['lease_id'], 'WHERE task_id=?', [task.task_id]).length
    };
    return {
      task: {
        taskId: task.task_id, role: task.role, status: task.status, updatedAt: task.updated_at, ageSinceUpdateMs: updatedAge,
        executionAttempt: task.execution_attempt ?? null, executionStatus: task.execution_status ?? null,
        executionStartedAt: task.execution_started_at ?? null, executionFinishedAt: task.execution_finished_at ?? null,
        executionExitCode: task.execution_exit_code ?? null, executionPid: task.execution_pid ?? null,
        executionProcess: processObservation(task.execution_pid, procRoot),
        executionSessionId: task.execution_session_id ?? null,
        openClawRunId: task.openclaw_run_id ?? null,
        openClawSessionKey: task.openclaw_session_key ?? null,
        parentTaskId: task.parent_task_id ?? null,
        dependencyIds: parseJson(task.dependency_json || '[]')
      },
      latestAttempt: latestAttempt ? {
        attemptId: latestAttempt.attempt_id, status: latestAttempt.status, runId: latestAttempt.openclaw_run_id ?? null,
        startedAt: latestAttempt.started_at, finishedAt: latestAttempt.finished_at,
        durationMs: timestampMs(latestAttempt.finished_at) != null && timestampMs(latestAttempt.started_at) != null
          ? Math.max(0, timestampMs(latestAttempt.finished_at) - timestampMs(latestAttempt.started_at)) : null,
        hasError: Boolean(latestAttempt.error)
      } : null,
      attemptsObserved: attempts.length,
      recentResults: results.map(result => ({ resultId: result.result_id, outcome: result.outcome, createdAt: result.created_at })),
      recentArtifacts: artifacts.map(artifact => ({ artifactId: artifact.artifact_id, jobId: artifact.job_id ?? null,
        taskId: artifact.task_id ?? null, kind: artifact.kind, schemaVersion: artifact.schema_version,
        producerRole: artifact.producer_role, status: artifact.status, supersedes: artifact.supersedes ?? null,
        contentHash: artifact.content_hash ?? null, createdAt: artifact.created_at })),
      leases: leases.map(lease => ({ leaseId: lease.lease_id, jobId: lease.job_id ?? null, taskId: lease.task_id ?? null,
        state: lease.state, attempt: lease.attempt, workerId: lease.worker_id ?? null, ownerEpoch: lease.owner_epoch ?? null,
        issuedAt: lease.issued_at, heartbeatAt: lease.heartbeat_at, expiresAt: lease.expires_at,
        expiredOrInvalid: String(lease.state || '').toUpperCase() === 'ACTIVE' &&
          (timestampMs(lease.expires_at) == null || timestampMs(lease.expires_at) <= nowMs), hasLastError: Boolean(lease.last_error) })),
      lineageAssessment: {
        taskId: task.task_id,
        attemptIds: attempts.map(attempt => attempt.attempt_id),
        resultIds: results.map(result => result.result_id),
        artifactIds: artifacts.map(artifact => artifact.artifact_id),
        leaseIds: leases.map(lease => lease.lease_id),
        artifactJobTaskLineage: crossJobArtifacts.length ? 'mismatch' : 'consistent_or_job_id_unavailable',
        artifactProducerRoleLineage: producerRoleMismatches.length ? 'mismatch' : 'consistent_or_role_unavailable',
        successfulResultWithRunningTask: successfulResultsWhileRunning,
        activeLeaseAttemptMismatchIds: mismatchedLeases.map(lease => lease.lease_id),
        activeLeaseJobTaskLineageMismatchIds: activeLeaseLineageMismatches.map(lease => lease.lease_id),
        activeLeaseOwnerEpochUnavailableIds: activeLeasesWithoutOwnerEpoch.map(lease => lease.lease_id),
        taskProviderRunId: taskRunId,
        latestAttemptProviderRunId: attemptRunId,
        providerRunIdentityBinding: taskRunId && attemptRunId ? (taskRunId === attemptRunId ? 'matching' : 'mismatch')
          : taskRunId || attemptRunId ? 'incomplete' : 'unavailable',
        observedCounts,
        truncated: { attempts: observedCounts.attempts > attempts.length, results: observedCounts.results > results.length,
          artifacts: observedCounts.artifacts > artifacts.length, leases: observedCounts.leases > leases.length },
        ownerAuthority: 'not_persisted_in_supported_workflow_schema',
        providerIdentity: 'not_persisted_in_supported_workflow_schema'
      },
      flags
    };
  });
}

function reportJob(db, job, { nowMs, staleAfterMs, procRoot }) {
  const tasks = listTaskRows(db, job.job_id, { nowMs, procRoot });
  // The compact latestEvents window is useful for display, but must not be
  // used as the complete event identity for reconciliation. Correlate every
  // durable event that names a task, retaining identifiers and bounded payload
  // summaries only (never result bodies or arbitrary event content).
  const allJobEvents = selectAvailable(db, 'events', ['event_id', 'job_id', 'type', 'payload_json', 'created_at'],
    'WHERE job_id=?', [job.job_id], 'ORDER BY created_at, rowid');
  const eventsByTaskId = new Map();
  for (const event of allJobEvents) {
    const taskId = correlatedTaskId(event);
    if (!taskId) continue;
    const list = eventsByTaskId.get(taskId) || [];
    list.push(event);
    eventsByTaskId.set(taskId, list);
  }
  for (const entry of tasks) {
    const correlated = eventsByTaskId.get(entry.task.taskId) || [];
    entry.eventLineage = {
      taskId: entry.task.taskId,
      eventIds: correlated.map(event => event.event_id),
      eventTypes: correlated.map(event => event.type),
      eventCount: correlated.length,
      firstEventAt: correlated[0]?.created_at || null,
      latestEventAt: correlated.at(-1)?.created_at || null,
      truncated: false,
      correlation: 'payload_task_id_exact_match'
    };
  }
  const runtime = selectAvailable(db, 'workflow_runtime_state', ['job_id', 'phase', 'attempt', 'resume_after', 'last_error', 'updated_at'],
    'WHERE job_id=?', [job.job_id], 'ORDER BY updated_at DESC', 'LIMIT 1')[0] || null;
  const events = selectAvailable(db, 'events', ['event_id', 'job_id', 'type', 'payload_json', 'created_at'],
    'WHERE job_id=?', [job.job_id], 'ORDER BY created_at DESC, rowid DESC', 'LIMIT 12');
  const completionEvents = selectAvailable(db, 'events', ['event_id', 'job_id', 'type', 'payload_json', 'created_at'],
    "WHERE job_id=? AND lower(type) LIKE '%completed%'", [job.job_id], 'ORDER BY created_at DESC, rowid DESC');
  const approvals = selectAvailable(db, 'approvals', ['approval_id', 'job_id', 'decision', 'actor', 'proposal_hash', 'created_at'],
    'WHERE job_id=?', [job.job_id], 'ORDER BY created_at DESC, rowid DESC', 'LIMIT 8');
  const activeLeases = tasks.flatMap(entry => entry.leases).filter(lease => String(lease.state || '').toUpperCase() === 'ACTIVE');
  const runningTasks = tasks.filter(entry => String(entry.task.status).toLowerCase() === 'running');
  const currentTaskEntry = tasks.find(entry => entry.task.taskId === job.active_task_id) || null;
  const taskTimes = tasks.map(entry => entry.task.updatedAt);
  const latestEventTime = events[0]?.created_at || null;
  const lastActivityAt = newestTimestamp([job.updated_at, runtime?.updated_at, latestEventTime, ...taskTimes,
    ...activeLeases.map(lease => lease.heartbeatAt)]);
  const activityAgeMs = ageMs(lastActivityAt, nowMs);
  const state = String(job.state || '').toUpperCase();
  const status = String(job.status || '').toLowerCase();
  const flags = [...new Set(tasks.flatMap(entry => entry.flags))];
  if (runtime && currentTaskEntry && runtime.attempt != null && currentTaskEntry.task.executionAttempt != null &&
      Number(runtime.attempt) !== Number(currentTaskEntry.task.executionAttempt)) {
    flags.push('RUNTIME_ATTEMPT_ACTIVE_TASK_MISMATCH');
  }
  const activeTaskCompletionAfterUpdate = currentTaskEntry && completionEvents.some(event => {
    const taskId = correlatedTaskId(event);
    return taskId === job.active_task_id && timestampMs(event.created_at) != null &&
      timestampMs(currentTaskEntry.task.updatedAt) != null && timestampMs(event.created_at) > timestampMs(currentTaskEntry.task.updatedAt);
  });
  if (activeTaskCompletionAfterUpdate) flags.push('COMPLETION_EVENT_NEWER_THAN_ACTIVE_TASK_ROW');
  if (state === 'EXECUTING' && runningTasks.length === 0) flags.push('EXECUTING_JOB_WITHOUT_RUNNING_TASKS');
  if (state === 'EXECUTING' && currentTaskEntry && currentTaskEntry.task.status !== 'running') flags.push('ACTIVE_TASK_POINTER_NOT_RUNNING');
  if (state === 'EXECUTING' && runningTasks.length && !activeLeases.length) flags.push('RUNNING_TASKS_WITHOUT_ACTIVE_LEASES');
  if (state === 'EXECUTING' && !currentTaskEntry) flags.push('ACTIVE_TASK_POINTER_MISSING_OR_UNRESOLVED');
  if (runtime?.last_error) flags.push('WORKFLOW_RUNTIME_HAS_LAST_ERROR');

  let classification = 'active_non_executing_state';
  let ownerAction = 'Inspect the current proposal/approval state; do not dispatch from diagnostics.';
  if (status !== 'active' || TERMINAL_STATES.has(state)) {
    classification = 'terminal_or_inactive';
    ownerAction = 'No lifecycle action suggested by this report.';
  } else if (state === 'PROPOSED' || state === 'IDLE') {
    classification = 'awaiting_proposal_or_approval';
  } else if (state === 'APPROVED') {
    classification = 'awaiting_dispatch';
  } else if (Number(job.provider_waiting) === 1) {
    const retryAt = timestampMs(job.provider_retry_at);
    classification = retryAt != null && retryAt <= nowMs ? 'provider_retry_due' : 'provider_waiting';
    ownerAction = 'Inspect the external provider/run ID and retry contract; do not automatically retry or dispatch.';
  } else if (state === 'EXECUTING' && flags.length) {
    classification = activityAgeMs != null && activityAgeMs >= staleAfterMs
      ? 'stale_candidate_reconciliation_required' : 'lifecycle_reconciliation_required';
    ownerAction = 'Compare current task row, attempt records, result/artifact records, completion events, active leases and host-side worker identity. Preserve evidence and require the responsible owner to choose a documented lifecycle path.';
  } else if (state === 'EXECUTING' && activeLeases.length) {
    const newestHeartbeat = newestTimestamp(activeLeases.map(lease => lease.heartbeatAt));
    if (ageMs(newestHeartbeat, nowMs) != null && ageMs(newestHeartbeat, nowMs) < staleAfterMs) {
      classification = 'live_lease_heartbeat';
      ownerAction = 'Current lease heartbeat exists; continue ordinary monitoring and re-check if progress stops.';
    } else {
      classification = 'stale_lease_heartbeat_candidate';
      ownerAction = 'Verify process identity and attempt fencing with the owner before intervention; no lease or job is changed here.';
    }
  } else if (state === 'EXECUTING' && activityAgeMs != null && activityAgeMs >= staleAfterMs) {
    classification = 'stale_candidate';
    ownerAction = 'No fresh durable activity or active lease is visible. Verify host/provider worker and exact attempt/result lineage with the owner; age alone is not proof of death.';
  } else if (state === 'EXECUTING') {
    classification = runningTasks.length ? 'executing_without_lease_recent_activity' : 'executing_idle_recent_activity';
    ownerAction = 'Monitor durable events and ask the owner to confirm worker progress; do not infer success from the active state.';
  }

  const taskFindingCodes = new Set(tasks.flatMap(entry => entry.flags));
  const findings = tasks.flatMap(entry => entry.flags.map(code => reconciliationFinding(code, {
    job, taskEntry: entry, eventIds: entry.eventLineage?.eventIds || [], runtimePresent: Boolean(runtime)
  })));
  for (const code of [...new Set(flags)].filter(value => !taskFindingCodes.has(value))) {
    findings.push(reconciliationFinding(code, { job, taskEntry: currentTaskEntry, eventIds: allJobEvents.map(event => event.event_id),
      runtimePresent: Boolean(runtime) }));
  }

  return {
    jobId: job.job_id, title: job.title, state: job.state, status: job.status, phase: runtime?.phase || null,
    createdAt: job.created_at, updatedAt: job.updated_at, lastActivityAt, activityAgeMs, staleAfterMs,
    activeTaskId: job.active_task_id || null, providerWaiting: Boolean(Number(job.provider_waiting)), providerRetryAt: job.provider_retry_at || null,
    ownerBinding: { authority: 'unresolved_owner_identity_not_persisted', conversationKeyPresent: Boolean(job.conversation_key),
      conversationKeySha256: job.conversation_key ? hash(job.conversation_key) : null,
      currentTaskHasOpenClawRunId: Boolean(currentTaskEntry?.task.openClawRunId),
      currentTaskHasOpenClawSessionKey: Boolean(currentTaskEntry?.task.openClawSessionKey),
      currentTaskExecutionPid: currentTaskEntry?.task.executionPid ?? null,
      activeLeaseWorkerIdsPresent: activeLeases.some(lease => lease.workerId) },
    runtimeObservation: runtime ? { phase: runtime.phase ?? null, attempt: runtime.attempt ?? null,
      resumeAfter: runtime.resume_after ?? null, lastErrorPresent: Boolean(runtime.last_error), updatedAt: runtime.updated_at ?? null,
      activeTaskAttemptMatchesRuntime: currentTaskEntry && runtime.attempt != null && currentTaskEntry.task.executionAttempt != null
        ? Number(runtime.attempt) === Number(currentTaskEntry.task.executionAttempt) : null,
      providerIdentity: 'not_persisted_in_workflow_runtime_state_schema' } : { status: 'missing' },
    taskCounts: tasks.reduce((acc, entry) => { acc[entry.task.status] = (acc[entry.task.status] || 0) + 1; return acc; }, {}),
    runningTaskCount: runningTasks.length, activeLeaseCount: activeLeases.length,
    resultCount: selectAvailable(db, 'results', ['result_id'], 'WHERE task_id IN (SELECT task_id FROM tasks WHERE job_id=?)', [job.job_id]).length,
    artifactCount: selectAvailable(db, 'artifacts', ['artifact_id'], 'WHERE job_id=? AND (status IS NULL OR status<>?)', [job.job_id, 'inactive']).length,
    latestApproval: approvals[0] ? { decision: approvals[0].decision, actor: approvals[0].actor, createdAt: approvals[0].created_at,
      proposalHash: approvals[0].proposal_hash ?? null } : null,
    allJobEventIds: allJobEvents.map(event => event.event_id),
    latestEvents: events.reverse().map(event => ({ type: event.type, createdAt: event.created_at, eventId: event.event_id,
      payloadSummary: summarizePayload(parseJson(event.payload_json || '{}')) })),
    completionEventEvidence: { scannedCount: completionEvents.length, truncated: false,
      matchingActiveTaskEventIds: completionEvents.filter(event => correlatedTaskId(event) === job.active_task_id).map(event => event.event_id) },
    tasks, flags: [...new Set(flags)], findings, classification, ownerAction
  };
}

export function buildActiveWorkflowReconciliationReport(db, { jobId = null, limit = 200, staleAfterMs = 900_000,
  now = new Date().toISOString(), procRoot = '/proc' } = {}) {
  if (!db || typeof db.prepare !== 'function') fail('RECONCILIATION_DB_REQUIRED', 'a SQLite read-only connection is required');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REPORT_JOBS) fail('RECONCILIATION_LIMIT_INVALID', `limit must be 1..${MAX_REPORT_JOBS}`);
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 60_000 || staleAfterMs > 7 * 24 * 60 * 60 * 1000) fail('RECONCILIATION_STALE_AFTER_INVALID', 'stale_after_ms must be 60,000..604,800,000');
  const nowMs = timestampMs(now);
  if (nowMs == null) fail('RECONCILIATION_NOW_INVALID', 'now must be a valid ISO timestamp');
  if (!tableExists(db, 'jobs') || !tableExists(db, 'tasks') || !tableExists(db, 'events')) {
    fail('RECONCILIATION_SCHEMA_UNSUPPORTED', 'database must contain jobs, tasks and events tables');
  }
  requireColumns(db, 'jobs', ['job_id', 'state', 'status', 'created_at', 'updated_at']);
  requireColumns(db, 'tasks', ['task_id', 'job_id', 'status', 'created_at', 'updated_at']);
  requireColumns(db, 'events', ['event_id', 'job_id', 'type', 'payload_json', 'created_at']);
  const jobs = jobId
    ? selectAvailable(db, 'jobs', ['job_id', 'conversation_key', 'title', 'state', 'status', 'active_task_id', 'provider_waiting', 'provider_retry_at', 'created_at', 'updated_at'],
      'WHERE job_id=?', [jobId], '', 'LIMIT 1')
    : selectAvailable(db, 'jobs', ['job_id', 'conversation_key', 'title', 'state', 'status', 'active_task_id', 'provider_waiting', 'provider_retry_at', 'created_at', 'updated_at'],
      "WHERE status='active' OR state='EXECUTING' OR job_id IN (SELECT job_id FROM tasks WHERE lower(status)='running')",
      [limit], 'ORDER BY COALESCE(updated_at,created_at) ASC', 'LIMIT ?');
  if (jobId && !jobs.length) fail('RECONCILIATION_JOB_NOT_FOUND', `job not found: ${jobId}`);
  const matchingJobCount = jobId ? 1 : db.prepare(
    "SELECT COUNT(*) AS count FROM jobs WHERE status='active' OR state='EXECUTING' OR job_id IN (SELECT job_id FROM tasks WHERE lower(status)='running')"
  ).get().count;
  const diagnostics = jobs.map(job => reportJob(db, job, { nowMs, staleAfterMs, procRoot }));
  const recoveryPlan = diagnostics.map(item => {
    const identity = {
      jobId: item.jobId, state: item.state, status: item.status, activeTaskId: item.activeTaskId,
      taskIds: item.tasks.map(entry => entry.task.taskId),
      taskLineage: item.tasks.map(entry => ({
        taskId: entry.task.taskId, status: entry.task.status, executionAttempt: entry.task.executionAttempt,
        executionStatus: entry.task.executionStatus, executionStartedAt: entry.task.executionStartedAt,
        executionFinishedAt: entry.task.executionFinishedAt,
        providerRunIdentityBinding: entry.lineageAssessment.providerRunIdentityBinding,
        latestAttempt: entry.latestAttempt ? { attemptId: entry.latestAttempt.attemptId, status: entry.latestAttempt.status,
          runId: entry.latestAttempt.runId, startedAt: entry.latestAttempt.startedAt, finishedAt: entry.latestAttempt.finishedAt } : null,
        results: entry.recentResults.map(result => ({ resultId: result.resultId, outcome: result.outcome, createdAt: result.createdAt })),
        artifacts: entry.recentArtifacts.map(artifact => ({ artifactId: artifact.artifactId, contentHash: artifact.contentHash,
          status: artifact.status, supersedes: artifact.supersedes })),
        leases: entry.leases.map(lease => ({ leaseId: lease.leaseId, jobId: lease.jobId, taskId: lease.taskId,
          state: lease.state, attempt: lease.attempt, ownerEpoch: lease.ownerEpoch, heartbeatAt: lease.heartbeatAt,
          expiresAt: lease.expiresAt })),
        eventIds: entry.eventLineage.eventIds, flags: entry.flags
      })),
      taskEventIds: item.tasks.map(entry => ({ taskId: entry.task.taskId, eventIds: entry.eventLineage.eventIds })),
      attemptIds: item.tasks.flatMap(entry => entry.lineageAssessment.attemptIds),
      resultIds: item.tasks.flatMap(entry => entry.lineageAssessment.resultIds),
      artifactIds: item.tasks.flatMap(entry => entry.lineageAssessment.artifactIds),
      leaseIds: item.tasks.flatMap(entry => entry.lineageAssessment.leaseIds),
      latestEventIds: item.latestEvents.map(event => event.eventId).sort(),
      allJobEventIds: item.allJobEventIds,
      runtimeObservation: item.runtimeObservation,
      classification: item.classification,
      flags: item.flags
    };
    return {
      jobId: item.jobId,
      action: 'HOLD_FOR_OWNER_RECONCILIATION',
      authorizationGranted: false,
      idempotencyKey: `reconcile-${hash(JSON.stringify(identity))}`,
      observedIdentity: identity,
      requiredChecks: [
        'Confirm responsible owner and provider/runtime identity through host-owned records; the workflow schema does not persist authoritative owner/provider IDs.',
        'Re-query job, task, attempt, result, artifact, event and lease rows; compare IDs and timestamps against this report.',
        'Verify worker/process identity and lease fencing with the host/provider before any intervention.',
        'Establish outcome from authoritative attempt/result/artifact lineage and review blockers/approval decision.',
        'Use only the documented owner-authorized lifecycle transition; rerun diagnostics and confirm idempotent outcome.'
      ],
      prohibitedWithoutEvidenceAndAuthority: ['reset', 'terminalize', 'retry', 'approve', 'dispatch', 'kill_process'],
      staleAfterReport: true
    };
  });
  const countBy = key => diagnostics.reduce((counts, item) => { counts[item[key]] = (counts[item[key]] || 0) + 1; return counts; }, {});
  const tableSummary = Object.fromEntries(['jobs', 'events', 'tasks', 'results', 'artifacts', 'attempts', 'task_leases', 'approvals']
    .map(table => [table, tableExists(db, table) ? db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count : null]));
  const adaptiveGoalGraph = buildAdaptiveGoalGraphIntegrityReport(db);
  return {
    schemaVersion: 1, generatedAt: new Date(nowMs).toISOString(), readOnly: true,
    purpose: 'owner-guided reconciliation; diagnostic report only; no lifecycle changes, lease changes, retries, approvals, or dispatch',
    scope: jobId ? 'single_job' : 'active_and_executing_jobs', jobFilter: jobId, limit, staleAfterMs,
    dbPath: null, tableCounts: tableSummary,
    summary: { consideredJobs: diagnostics.length, matchingJobCount, selectionTruncated: matchingJobCount > diagnostics.length,
      byClassification: countBy('classification'),
      jobsFlaggedForReconciliation: diagnostics.filter(item => item.flags.length > 0).length,
      staleCandidates: diagnostics.filter(item => item.classification === 'stale_candidate' || item.classification === 'stale_candidate_reconciliation_required').length,
      jobsWithRunningTasksButNoActiveLeases: diagnostics.filter(item => item.runningTaskCount > 0 && item.activeLeaseCount === 0).length },
    policy: { staleCandidateIsNotProofOfWorkerDeath: true, missingLeaseDoesNotAuthorizeTerminalization: true,
      callerMustVerifyHostAndProviderState: true, noAutomaticRecovery: true },
    adaptiveGoalGraph,
    diagnostics,
    recoveryPlan
  };
}

function parseArgs(argv) {
  const args = { db: DEFAULT_DB, jobId: null, limit: 200, staleAfterMs: 900_000, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    const key = ({ '--db': 'db', '--job-id': 'jobId', '--limit': 'limit', '--stale-after-ms': 'staleAfterMs', '--out': 'out' })[arg];
    if (!key) fail('RECONCILIATION_ARGUMENT_INVALID', `unknown argument: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) fail('RECONCILIATION_ARGUMENT_MISSING', `${arg} requires a value`);
    if (key === 'limit' || key === 'staleAfterMs') {
      if (!/^[0-9]+$/.test(value)) fail('RECONCILIATION_ARGUMENT_INVALID', `${arg} must be an integer`);
      args[key] = Number(value);
    } else args[key] = value;
  }
  return args;
}

function writeExclusive(outPath, contents) {
  const absolute = path.resolve(outPath);
  const parent = path.dirname(absolute);
  if (fs.realpathSync(parent) !== parent) fail('RECONCILIATION_OUTPUT_PATH_UNSAFE', 'output parent must be canonical and not symlinked');
  if (fs.existsSync(absolute)) fail('RECONCILIATION_OUTPUT_EXISTS', `refusing to overwrite ${absolute}`);
  const fd = fs.openSync(absolute, 'wx', 0o600);
  try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); }
  catch (error) { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(absolute); } catch {} throw error; }
  fs.closeSync(fd);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('Usage: node scripts/reconcile-active-workflows.mjs [--db PATH] [--job-id ID] [--limit 1..200] [--stale-after-ms 60000..604800000] [--out NEW_PATH]\nRead-only diagnostics for active job/task lineage plus Goal/Idea graph integrity, attestation freshness, and planner evidence inventory. Never mutates workflow state or attempts recovery; age or missing lease is not proof a worker is dead.\n');
    return 0;
  }
  const dbPath = path.resolve(args.db);
  const stat = fs.lstatSync(dbPath);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(dbPath) !== dbPath) {
    fail('RECONCILIATION_DB_PATH_UNSAFE', 'database path must be a canonical regular file, not a symlink');
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const report = buildActiveWorkflowReconciliationReport(db, args);
    report.dbPath = dbPath;
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (args.out) {
      writeExclusive(args.out, serialized);
      process.stdout.write(`${JSON.stringify({ result: 'PASS', readOnly: true, output: path.resolve(args.out), reportSha256: hash(serialized),
        summary: report.summary }, null, 2)}\n`);
    } else process.stdout.write(serialized);
    return 0;
  } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ result: 'FAIL', code: error?.code || 'RECONCILIATION_FAILED', message: String(error?.message || error) }, null, 2)}\n`);
    process.exitCode = 2;
  }
}
