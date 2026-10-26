#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectStoredWorkflowPolicyRow } from '../src/runtime/workflow/policy-contract.js';

function defaultDataDirectory(homeDir) {
  const current = path.join(homeDir, '.runalith', 'agent-orchestrator');
  const legacy = path.join(homeDir, '.chat-on-steroids', 'agent-orchestrator');
  return fs.existsSync(legacy) && !fs.existsSync(current) ? legacy : current;
}
const DEFAULT_DATA_DIR = path.resolve(process.env.RUNALITH_DATA_DIR || process.env.CHAT_ON_STEROIDS_DATA_DIR || process.env.WORKFLOW_DATA_DIR || defaultDataDirectory(os.homedir()));
const DEFAULT_DB_PATH = path.resolve(process.env.RUNALITH_WORKFLOW_DB || process.env.CHAT_ON_STEROIDS_WORKFLOW_DB || process.env.WORKFLOW_DB || path.join(DEFAULT_DATA_DIR, 'workflow.db'));
const MAX_LIST = 200;
const MAX_PREVIEW_CHARS = 48_000;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_URL_BYTES = 4096;
const MAX_JSON_RESPONSE_BYTES = 1_500_000;
const SAFE_TEXT_EXTENSIONS = new Set(['.log', '.txt', '.md', '.mdx', '.json', '.jsonc', '.jsonl', '.ndjson', '.out', '.err', '.stdout', '.stderr', '.csv', '.yaml', '.yml', '.toml', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.html', '.htm', '.css', '.scss', '.xml', '.sh', '.bash', '.py', '.go', '.rs', '.java', '.c', '.h', '.cc', '.cpp', '.hpp', '.sql', '.graphql', '.gql', '.env.example']);
const FORBIDDEN_FILE_RE = /(?:\.db(?:-(?:wal|shm))?|\.sqlite(?:-\w+)?|\.sqlite3?|\.mcpb|\.exe|\.dll|\.so(?:\.\d+)*|\.dylib|\.bin|\.wasm|\.zip|\.gz|\.tar|\.png|\.jpe?g|\.gif|\.webp|\.pdf)$/i;
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_GIT_RESPONSE_ENTRIES = 500;
const MAX_GIT_DIFF_BYTES = 64 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function redactSensitiveText(value, { redactLocalSkillPaths = true } = {}) {
  const redacted = String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_TOKEN]')
    .replace(/(["']?)(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization)\1(\s*[:=]\s*)(["']?)([^\s"'&,;]{6,})(["']?)/gi,
      (_match, quote, key, separator, valueQuote, _value, endQuote) => `${quote}${key}${quote}${separator}${valueQuote}[REDACTED]${endQuote}`)
    .replace(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g, '-----BEGIN PRIVATE KEY-----[REDACTED]-----END PRIVATE KEY-----');
  if (!redactLocalSkillPaths) return redacted;
  return redacted.replace(/(^|[\s"'`=()\[\]{}:,])((?:\/(?!\/)[^\s"'`<>()[\]{};,]+|[A-Za-z]:[\\/][^\s"'`<>()[\]{};,]+|\\\\[^\s"'`<>()[\]{};,]+))/g, (match, prefix, candidate) => {
    const normalized = candidate.replace(/[.,:!?]+$/, '');
    return /(?:^|[\\/])(?:\.agents|skills?(?:\.[\w-]+)?|[^\\/]*-skills?)(?:[\\/]|$)/i.test(normalized)
      ? `${prefix}[LOCAL SKILL PATH REDACTED]${candidate.slice(normalized.length)}`
      : match;
  });
}
function boundedText(value, max = 8_000) {
  if (value == null) return '';
  const text = redactSensitiveText(value);
  return text.length > max ? text.slice(0, max) : text;
}
function parseJson(value, max = 24_000, options = {}) {
  if (typeof value !== 'string' || !value) return { value: null, malformed: false, truncated: false };
  const safe = redactSensitiveText(value, options);
  if (safe.length > max) return { value: safe.slice(0, max), malformed: true, truncated: true };
  try { return { value: JSON.parse(safe), malformed: false, truncated: false }; }
  catch { return { value: safe.slice(0, max), malformed: true, truncated: safe.length > max }; }
}
function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function onlyLoopback(host) { return host === '127.0.0.1' || host === '::1'; }
function resolveDataDir(value) {
  const root = path.resolve(value || DEFAULT_DATA_DIR);
  const real = fs.realpathSync(root);
  if (!fs.statSync(real).isDirectory()) throw new Error('data root is not a directory');
  return real;
}
function isWithin(root, candidate) { return candidate === root || candidate.startsWith(root + path.sep); }
function noStoreHeaders() {
  return {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  };
}
function sendJson(res, status, payload) {
  let body = JSON.stringify(payload);
  let responseStatus = status;
  if (Buffer.byteLength(body) > MAX_JSON_RESPONSE_BYTES) {
    responseStatus = 413;
    body = JSON.stringify({error:'response exceeds dashboard size limit',limit_bytes:MAX_JSON_RESPONSE_BYTES});
  }
  res.writeHead(responseStatus, { ...noStoreHeaders(), 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function queryRows(db, sql, params = []) { return db.prepare(sql).all(...params); }
function queryOne(db, sql, params = []) { return db.prepare(sql).get(...params) || null; }
function dbHasTable(db, name) {
  return Boolean(queryOne(db, "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?", [name]));
}
function tableCount(db, table) {
  if (!dbHasTable(db, table)) return 0;
  return Number(queryOne(db, `SELECT count(*) AS n FROM ${table}`)?.n || 0);
}
function mapEvent(row) {
  const payload = parseJson(row.payload_json, 10_000);
  return { event_id: row.event_id || row.workflow_event_id, source: row.source || 'event', job_id: row.job_id, type: row.type || row.event, from_phase: row.from_phase ?? null, to_phase: row.to_phase ?? null, attempt: row.attempt ?? null, created_at: row.created_at, payload: payload.value, payload_malformed: payload.malformed, payload_truncated: payload.truncated || Number(row.payload_size || 0) > 10_000 };
}
function mapArtifact(row, includeContent = false) {
  const metadata = parseJson(row.metadata_json, 4_000);
  const evidence = parseJson(row.evidence_json, 8_000);
  const producerMetadata = parseJson(row.producer_task_metadata_json, 4_000).value;
  const producerRoleIdCandidate = typeof row.producer_custom_role_id === 'string' ? row.producer_custom_role_id : producerMetadata?.custom_role_id;
  const producerRoleId = typeof producerRoleIdCandidate === 'string' && producerRoleIdCandidate.length <= 80 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(producerRoleIdCandidate)
    ? producerRoleIdCandidate : null;
  const producerRoleVersionCandidate = row.producer_custom_role_version ?? producerMetadata?.custom_role_version;
  const parsedProducerRoleVersion = Number(producerRoleVersionCandidate);
  const producerRoleVersion = Number.isSafeInteger(parsedProducerRoleVersion) && parsedProducerRoleVersion >= 1 ? parsedProducerRoleVersion : null;
  const producerRoleName = row.producer_custom_role_name || producerMetadata?.custom_role_name;
  const customRole = producerRoleId && producerRoleVersion !== null
    ? `${boundedText(producerRoleName || producerRoleId, 120)} (${producerRoleId}@${producerRoleVersion})`
    : null;
  const content = boundedText(row.content, MAX_PREVIEW_CHARS);
  const out = {
    artifact_id: row.artifact_id, job_id: row.job_id, task_id: row.task_id, type: row.kind, producer_role: customRole || row.producer_role,
    status: row.status, schema_version: row.schema_version, uri: boundedText(row.uri, 1_000), metadata: metadata.value,
    evidence: evidence.value, content_hash: row.content_hash, supersedes: row.supersedes, created_at: row.created_at,
    content_length: Number(row.content_size ?? row.content_length_db ?? String(row.content || '').length), content_truncated: Number(row.content_size ?? row.content_length_db ?? String(row.content || '').length) > MAX_PREVIEW_CHARS
  };
  if (includeContent) {
    const parsed = parseJson(content, MAX_PREVIEW_CHARS);
    out.content = parsed.malformed ? undefined : parsed.value;
    out.content_is_json = !parsed.malformed;
    out.content_malformed = parsed.malformed;
    out.content_preview = parsed.malformed ? boundedText(content, MAX_PREVIEW_CHARS) : undefined;
  }
  return out;
}
function safeTask(row) {
  const metadataParsed = parseJson(row.metadata_json, 4_000, { redactLocalSkillPaths: false });
  const metadataSize = Number(row.metadata_size || String(row.metadata_json || '').length);
  const metadataTooLarge = metadataSize > 4_000 || metadataParsed.truncated;
  const rawMetadata = !metadataTooLarge && metadataParsed.value && typeof metadataParsed.value === 'object' && !Array.isArray(metadataParsed.value)
    ? metadataParsed.value : null;
  const roleIdCandidate = typeof row.custom_role_id === 'string' ? row.custom_role_id : rawMetadata?.custom_role_id;
  const roleId = typeof roleIdCandidate === 'string' && roleIdCandidate.length <= 80 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(roleIdCandidate)
    ? roleIdCandidate : null;
  const roleVersionCandidate = row.custom_role_version ?? rawMetadata?.custom_role_version;
  const parsedRoleVersion = Number(roleVersionCandidate);
  const roleVersion = Number.isSafeInteger(parsedRoleVersion) && parsedRoleVersion >= 1 ? parsedRoleVersion : null;
  const roleName = typeof row.custom_role_name === 'string' ? row.custom_role_name : rawMetadata?.custom_role_name;
  const customRole = roleId && roleVersion !== null
    ? { role_id: roleId, version: roleVersion, name: boundedText(roleName || roleId, 120) }
    : null;
  const metadataMalformed = !metadataTooLarge && metadataParsed.malformed;
  const metadata = metadataTooLarge || metadataMalformed || !rawMetadata
    ? {
      available: false,
      ...(metadataTooLarge ? { truncated: true } : {}),
      ...(metadataMalformed ? { malformed: true } : {}),
      ...(typeof row.workflow_plan_task_id === 'string' ? { workflow_plan_task_id: boundedText(row.workflow_plan_task_id, 100) } : {}),
      ...(customRole ? { custom_role_id: customRole.role_id, custom_role_version: customRole.version, custom_role_name: customRole.name } : {})
    }
    : {
      available: true,
      ...(typeof row.workflow_plan_task_id === 'string' ? { workflow_plan_task_id: boundedText(row.workflow_plan_task_id, 100) } : {}),
      ...(customRole ? { custom_role_id: customRole.role_id, custom_role_version: customRole.version, custom_role_name: customRole.name } : {}),
      ...(typeof rawMetadata.deterministic === 'boolean' ? { deterministic: rawMetadata.deterministic } : {}),
      ...(typeof rawMetadata.execution_mode === 'string' ? { execution_mode: boundedText(rawMetadata.execution_mode, 80) } : {}),
      ...(Number.isFinite(rawMetadata.timeout_ms) ? { timeout_ms: Math.max(0, Math.min(rawMetadata.timeout_ms, 600_000)) } : {}),
      ...(Array.isArray(rawMetadata.custom_role_skills) ? {
        custom_role_skills: rawMetadata.custom_role_skills.slice(0, 8).map(safeTaskSkill).filter(Boolean),
        custom_role_skills_truncated: rawMetadata.custom_role_skills.length > 8
      } : {})
    };
  const {
    metadata_json: _storedMetadataJson,
    metadata_size: _storedMetadataSize,
    workflow_plan_task_id: _storedWorkflowPlanTaskId,
    custom_role_id: _storedCustomRoleId,
    custom_role_version: _storedCustomRoleVersion,
    custom_role_name: _storedCustomRoleName,
    ...safeRow
  } = row;
  return {
    ...safeRow,
    description: boundedText(row.description, 5_000),
    dependency: parseJson(row.dependency_json, 4_000).value,
    dependency_malformed: parseJson(row.dependency_json, 4_000).malformed,
    metadata,
    metadata_available: Boolean(metadata.available),
    metadata_malformed: Boolean(metadata.malformed),
    metadata_truncated: Boolean(metadata.truncated),
    custom_role: customRole,
    role_display: customRole ? `${customRole.name} (${customRole.role_id}@${customRole.version ?? '?'})` : row.role,
    execution_stdout: boundedText(row.execution_stdout, 6_000),
    execution_stderr: boundedText(row.execution_stderr, 6_000)
  };
}
function safeTaskSkill(skill) {
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) return null;
  const rawFiles = Array.isArray(skill.files) ? skill.files : [];
  const instructions = typeof skill.instructions === 'string' ? skill.instructions : '';
  return {
    name: boundedText(skill.name || 'unnamed-skill', 80),
    description: boundedText(skill.description || '', 500),
    source: { kind: skill.source?.kind === 'local' ? 'local' : 'external', label: skillSourceLabel(skill.source) },
    sha256: typeof skill.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(skill.sha256) ? skill.sha256 : null,
    instruction_chars: instructions.length,
    instructions_preview: boundedText(instructions, 1_200),
    instructions_truncated: instructions.length > 1_200,
    supporting_files: rawFiles.length,
    files_truncated: rawFiles.length > 12,
    files: rawFiles.slice(0, 12).map(file => ({
      path: safeSkillFilePath(file?.path),
      sha256: typeof file?.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(file.sha256) ? file.sha256 : null,
      size_bytes: Number.isFinite(Number(file?.size_bytes)) ? Math.max(0, Math.min(Number(file.size_bytes), 10_000_000)) : 0
    }))
  };
}
function getJobs(db, params) {
  const q = boundedText(params.get('q') || '', 160).trim();
  const status = boundedText(params.get('status') || '', 40);
  const phase = boundedText(params.get('phase') || '', 80);
  const limit = clampInt(params.get('limit'), 50, 1, MAX_LIST);
  const offset = clampInt(params.get('offset'), 0, 0, 100_000);
  const where = [];
  const values = [];
  if (q) { where.push("(j.title LIKE ? OR j.job_id LIKE ? OR j.state LIKE ?)"); values.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (status) { where.push('j.status=?'); values.push(status); }
  if (phase) { where.push('COALESCE(w.phase, j.state)=?'); values.push(phase); }
  const sql = `SELECT j.job_id,j.title,j.state,j.status,j.active_task_id,j.provider_waiting,j.provider_retry_at,j.created_at,j.updated_at,j.approved_at,j.completed_at,
      COALESCE(w.phase,j.state) AS phase, w.attempt AS phase_attempt, w.last_error AS phase_error,
      (SELECT count(*) FROM tasks t WHERE t.job_id=j.job_id) AS task_total,
      (SELECT count(*) FROM tasks t WHERE t.job_id=j.job_id AND t.status='running') AS task_running,
      (SELECT count(*) FROM tasks t WHERE t.job_id=j.job_id AND t.status='completed') AS task_completed,
      (SELECT count(*) FROM tasks t WHERE t.job_id=j.job_id AND t.status='failed') AS task_failed,
      (SELECT count(*) FROM events e WHERE e.job_id=j.job_id) AS event_total,
      (SELECT count(*) FROM artifacts a WHERE a.job_id=j.job_id AND COALESCE(a.status,'active')='active') AS artifact_total
    FROM jobs j LEFT JOIN workflow_runtime_state w ON w.job_id=j.job_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY COALESCE(j.updated_at,j.created_at) DESC LIMIT ? OFFSET ?`;
  const rows = queryRows(db, sql, [...values, limit, offset]);
  const countSql = `SELECT count(*) AS n FROM jobs j LEFT JOIN workflow_runtime_state w ON w.job_id=j.job_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  const total = Number(queryOne(db, countSql, values)?.n || 0);
  return { items: rows, total, limit, offset };
}
function getOverview(db) {
  const jobStatuses = queryRows(db, 'SELECT status, count(*) AS count FROM jobs GROUP BY status ORDER BY status');
  const taskStatuses = queryRows(db, 'SELECT status, count(*) AS count FROM tasks GROUP BY status ORDER BY status');
  const phases = queryRows(db, 'SELECT phase AS name, count(*) AS count FROM workflow_runtime_state GROUP BY phase ORDER BY count DESC, phase');
  const recent = queryRows(db, `SELECT event_id,job_id,type,substr(payload_json,1,10001) AS payload_json,length(payload_json) AS payload_size,created_at,source,from_phase,to_phase,attempt FROM (
      SELECT event_id,job_id,type,payload_json,created_at,'event' AS source,NULL AS from_phase,NULL AS to_phase,NULL AS attempt FROM events
      UNION ALL SELECT workflow_event_id AS event_id,job_id,event AS type,payload_json,created_at,'workflow' AS source,from_phase,to_phase,attempt FROM workflow_events
    ) ORDER BY created_at DESC LIMIT 10`).map(mapEvent);
  const activity = queryRows(db, `SELECT substr(created_at,1,10) AS day, count(*) AS count FROM events WHERE created_at >= datetime('now','-13 days') GROUP BY substr(created_at,1,10) ORDER BY day`);
  return {
    generated_at: new Date().toISOString(),
    counts: {
      jobs: tableCount(db,'jobs'), tasks: tableCount(db,'tasks'), events: tableCount(db,'events'), workflow_events: tableCount(db,'workflow_events'), artifacts: tableCount(db,'artifacts'), results: tableCount(db,'results'), reports: tableCount(db,'reports'), approvals: tableCount(db,'approvals'), attempts: tableCount(db,'attempts'), batches: tableCount(db,'execution_batches'),
      custom_profiles: dbHasTable(db,'custom_role_versions') ? Number(queryOne(db,'SELECT COUNT(DISTINCT role_id) n FROM custom_role_versions')?.n || 0) : 0,
      role_versions: tableCount(db,'custom_role_versions'),
      custom_workflows: dbHasTable(db,'custom_workflow_versions') ? Number(queryOne(db,'SELECT COUNT(DISTINCT workflow_id) n FROM custom_workflow_versions')?.n || 0) : 0,
      individual_executions: Number(queryOne(db,'SELECT COUNT(*) n FROM tasks WHERE execution_status IS NOT NULL OR execution_session_id IS NOT NULL')?.n || 0)
    },
    job_statuses: jobStatuses, task_statuses: taskStatuses, phases,
    activity: activity.map(x => ({ day: x.day, count: Number(x.count) })),
    recent_events: recent
  };
}

const AGG_NODE_TYPES = new Set(['hypothesis','idea','capability','experiment','evidence','condition']);
const AGG_EDGE_TYPES = new Set(['supports','tested_by','enables','contradicts','alternative_to','recovers_to','depends_on','requires_all']);
function safeAggJson(value, max = 4_000) {
  const parsed = parseJson(value, max);
  return parsed.malformed ? null : parsed.value;
}
function aggContentLabel(content, stableKey) {
  if (typeof content === 'string') return boundedText(content, 110) || stableKey;
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    for (const key of ['title','name','label','statement','claim','summary','description','goal']) {
      const value = content[key];
      if (typeof value === 'string' && value.trim()) return boundedText(value.trim(), 110);
    }
  }
  return boundedText(stableKey, 110);
}
function getAggGraph(db, params) {
  const required = ['adaptive_goal_knowledge_nodes','adaptive_goal_knowledge_memberships','adaptive_goal_knowledge_revisions','adaptive_goal_knowledge_edges'];
  const missing = required.filter(name => !dbHasTable(db, name));
  if (missing.length) return {
    available: false, reason: missing.length === required.length
      ? 'AGG knowledge graph has not been initialized in this workflow database.'
      : 'AGG knowledge graph schema is incomplete; runtime initialization may not have run.',
    missing_tables: missing, generated_at: new Date().toISOString(),
    summary: { nodes: 0, edges: 0, goals: 0, reused_nodes: 0, revisions: 0, unverified_nodes: 0, usable_for_planning: 0 },
    nodes: [], edges: [], goals: [], node_types: [], edge_types: [], activity: []
  };

  const goalId = boundedText(params.get('goalId') || '', 200).trim();
  const query = boundedText(params.get('q') || '', 120).trim();
  const type = boundedText(params.get('type') || '', 40).trim();
  const includeRecovery = params.get('recovery') === '1';
  const where = [];
  const values = [];
  if (goalId) { where.push('EXISTS (SELECT 1 FROM adaptive_goal_knowledge_memberships gm WHERE gm.node_id=n.id AND gm.goal_id=?)'); values.push(goalId); }
  if (AGG_NODE_TYPES.has(type)) { where.push('n.type=?'); values.push(type); }
  if (query) {
    where.push("(n.stable_key LIKE ? ESCAPE '\\' OR n.id LIKE ? ESCAPE '\\' OR r.content_json LIKE ? ESCAPE '\\')");
    values.push(...Array(3).fill(`%${query.replace(/[\\%_]/g, char => `\\${char}`)}%`));
  }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const totalNodes = Number(queryOne(db, `SELECT COUNT(DISTINCT n.id) n FROM adaptive_goal_knowledge_nodes n JOIN adaptive_goal_knowledge_revisions r ON r.node_id=n.id AND r.revision=n.current_revision ${filter}`, values)?.n || 0);
  const nodeRows = queryRows(db, `SELECT n.id,n.stable_key,n.type,n.current_revision AS revision,n.created_at,
      r.status,r.content_hash,r.created_at AS revision_created_at,
      CASE WHEN json_valid(r.content_json) THEN COALESCE(json_extract(r.content_json,'$.title'),json_extract(r.content_json,'$.name'),json_extract(r.content_json,'$.label'),json_extract(r.content_json,'$.statement'),json_extract(r.content_json,'$.claim'),json_extract(r.content_json,'$.summary'),json_extract(r.content_json,'$.description'),json_extract(r.content_json,'$.goal')) END AS content_label,
      (SELECT COUNT(*) FROM adaptive_goal_knowledge_revisions rh WHERE rh.node_id=n.id) AS revision_count,
      (SELECT COUNT(*) FROM json_each(r.evidence_refs_json)) AS evidence_count
    FROM adaptive_goal_knowledge_nodes n JOIN adaptive_goal_knowledge_revisions r ON r.node_id=n.id AND r.revision=n.current_revision
    ${filter} ORDER BY n.type,n.stable_key LIMIT 180`, values);
  const ids = nodeRows.map(row => row.id);
  const memberships = ids.length
    ? queryRows(db, `SELECT node_id,goal_id FROM adaptive_goal_knowledge_memberships WHERE node_id IN (${ids.map(() => '?').join(',')}) ORDER BY goal_id,node_id`, ids)
    : [];
  const membersByNode = new Map();
  for (const row of memberships) {
    if (!membersByNode.has(row.node_id)) membersByNode.set(row.node_id, []);
    const items = membersByNode.get(row.node_id); if (items.length < 30) items.push(row.goal_id);
  }
  const nodes = nodeRows.map(row => ({
    id: row.id, stable_key: boundedText(row.stable_key, 200), type: row.type,
    label: aggContentLabel(row.content_label, row.stable_key), revision: Number(row.revision), revision_count: Number(row.revision_count),
    status: row.status || 'unverified', verified: false, usable_for_planning: false,
    content_hash: row.content_hash, evidence_count: Number(row.evidence_count || 0),
    memberships: membersByNode.get(row.id) || [],
    created_at: row.created_at, revision_created_at: row.revision_created_at
  }));
  const visibleIds = new Set(ids);
  let edgeRows = [];
  if (ids.length) {
    const edgeWhere = [`from_id IN (${ids.map(() => '?').join(',')})`, `to_id IN (${ids.map(() => '?').join(',')})`];
    const edgeValues = [...ids, ...ids];
    if (goalId) { edgeWhere.push('goal_id=?'); edgeValues.push(goalId); }
    if (!includeRecovery) edgeWhere.push("type <> 'recovers_to'");
    edgeRows = queryRows(db, `SELECT edge_id,goal_id,from_id,to_id,type,created_at,
        CASE WHEN condition_json IS NOT NULL THEN substr(condition_json,1,500) END AS condition_json,
        CASE WHEN outcome_json IS NOT NULL THEN substr(outcome_json,1,500) END AS outcome_json,
        (SELECT COUNT(*) FROM json_each(evidence_refs_json)) AS evidence_count
      FROM adaptive_goal_knowledge_edges WHERE ${edgeWhere.join(' AND ')} ORDER BY created_at DESC LIMIT 500`, edgeValues)
      .filter(edge => visibleIds.has(edge.from_id) && visibleIds.has(edge.to_id));
  }
  const edges = edgeRows.map(edge => ({
    id: edge.edge_id, goal_id: boundedText(edge.goal_id, 200), from: edge.from_id, to: edge.to_id,
    type: AGG_EDGE_TYPES.has(edge.type) ? edge.type : 'unknown', created_at: edge.created_at,
    condition: safeAggJson(edge.condition_json, 500), outcome: safeAggJson(edge.outcome_json, 500), evidence_count: Number(edge.evidence_count || 0)
  }));
  const summaryRow = queryOne(db, `SELECT
      (SELECT COUNT(*) FROM adaptive_goal_knowledge_nodes) AS nodes,
      (SELECT COUNT(*) FROM adaptive_goal_knowledge_edges) AS edges,
      (SELECT COUNT(DISTINCT goal_id) FROM adaptive_goal_knowledge_memberships) AS goals,
      (SELECT COUNT(*) FROM adaptive_goal_knowledge_nodes n WHERE (SELECT COUNT(DISTINCT goal_id) FROM adaptive_goal_knowledge_memberships m WHERE m.node_id=n.id)>1) AS reused_nodes,
      (SELECT COUNT(*) FROM adaptive_goal_knowledge_revisions) AS revisions,
      (SELECT COUNT(*) FROM adaptive_goal_knowledge_nodes n JOIN adaptive_goal_knowledge_revisions r ON r.node_id=n.id AND r.revision=n.current_revision WHERE r.status='unverified') AS status_unverified_nodes`);
  const goals = queryRows(db, `SELECT m.goal_id,COUNT(DISTINCT m.node_id) AS node_count,
      (SELECT COUNT(*) FROM adaptive_goal_knowledge_edges e WHERE e.goal_id=m.goal_id) AS edge_count,
      MAX(m.created_at) AS last_membership_at
    FROM adaptive_goal_knowledge_memberships m ${goalId ? 'WHERE m.goal_id=?' : ''}
    GROUP BY m.goal_id ORDER BY last_membership_at DESC,m.goal_id LIMIT 100`, goalId ? [goalId] : [])
    .map(goal => ({ id: boundedText(goal.goal_id, 200), node_count: Number(goal.node_count), edge_count: Number(goal.edge_count), last_membership_at: goal.last_membership_at }));
  const nodeTypes = queryRows(db, 'SELECT type,COUNT(*) AS count FROM adaptive_goal_knowledge_nodes GROUP BY type ORDER BY type').map(row => ({ type: row.type, count: Number(row.count) }));
  const edgeTypes = queryRows(db, `SELECT type,COUNT(*) AS count FROM adaptive_goal_knowledge_edges ${includeRecovery ? '' : "WHERE type <> 'recovers_to'"} GROUP BY type ORDER BY type`).map(row => ({ type: row.type, count: Number(row.count) }));
  const activity = queryRows(db, `SELECT created_at,kind,record_id,goal_id,detail FROM (
      SELECT r.created_at,'node_revision' AS kind,n.id AS record_id,
        (SELECT m.goal_id FROM adaptive_goal_knowledge_memberships m WHERE m.node_id=n.id ORDER BY m.created_at LIMIT 1) AS goal_id,
        n.stable_key AS detail FROM adaptive_goal_knowledge_revisions r JOIN adaptive_goal_knowledge_nodes n ON n.id=r.node_id
      UNION ALL SELECT e.created_at,'edge_added' AS kind,e.edge_id AS record_id,e.goal_id,
        e.type || ': ' || e.from_id || ' → ' || e.to_id AS detail FROM adaptive_goal_knowledge_edges e
    ) ORDER BY created_at DESC LIMIT 30`).map(item => ({ ...item, record_id: boundedText(item.record_id, 100), goal_id: boundedText(item.goal_id, 200), detail: boundedText(item.detail, 220) }));
  return {
    available: true, generated_at: new Date().toISOString(), goal_filter: goalId || null, query: query || null,
    filters: { type: AGG_NODE_TYPES.has(type) ? type : null, include_recovery: includeRecovery },
    summary: {
      nodes: Number(summaryRow.nodes), filtered_nodes: totalNodes, edges: Number(summaryRow.edges), filtered_edges: edges.length,
      goals: Number(summaryRow.goals), reused_nodes: Number(summaryRow.reused_nodes), revisions: Number(summaryRow.revisions),
      unverified_nodes: Number(summaryRow.nodes), status_unverified_nodes: Number(summaryRow.status_unverified_nodes), usable_for_planning: 0
    },
    nodes, edges, goals, node_types: nodeTypes, edge_types: edgeTypes, activity,
    truncated: totalNodes > nodes.length,
    planning: { verifier_available: false, usable_node_ids: [] },
    observability_note: 'This view reads the persisted knowledge ledger. Planner invocation lifecycle, duration, observed search steps, algorithm outcomes and errors are retained separately in adaptive_goal_planner_runs and linked run snapshot tables. Those observations do not establish claim truth, search quality, acceptance or approval.'
  };
}
function getAggNodeDetail(db, nodeId, requestedRevision = null) {
  if (!['adaptive_goal_knowledge_nodes','adaptive_goal_knowledge_memberships','adaptive_goal_knowledge_revisions','adaptive_goal_knowledge_edges'].every(name => dbHasTable(db, name))) return null;
  const current = queryOne(db, 'SELECT current_revision FROM adaptive_goal_knowledge_nodes WHERE id=?', [nodeId]);
  if (!current) return null;
  const revision = requestedRevision === null ? Number(current.current_revision) : requestedRevision;
  if (!Number.isSafeInteger(revision) || revision < 1) return null;
  const row = queryOne(db, `SELECT n.id,n.stable_key,n.type,n.current_revision,r.revision,r.content_json,r.evidence_refs_json,r.content_hash,r.status,r.provenance_json,r.created_at
    FROM adaptive_goal_knowledge_nodes n JOIN adaptive_goal_knowledge_revisions r ON r.node_id=n.id AND r.revision=? WHERE n.id=?`, [revision, nodeId]);
  if (!row) return null;
  const history = queryRows(db, `SELECT revision,content_hash,status,created_at FROM adaptive_goal_knowledge_revisions WHERE node_id=? ORDER BY revision DESC LIMIT 30`, [nodeId]).map(item => ({ revision: Number(item.revision), content_hash: item.content_hash, status: item.status, created_at: item.created_at }));
  const contentTruncated = row.content_json.length > 24_000;
  const parsedContent = safeAggJson(row.content_json, 24_000);
  const content = parsedContent === null && contentTruncated
    ? { preview: boundedText(row.content_json, 1_200), truncated: true }
    : parsedContent;
  const provenance = safeAggJson(row.provenance_json, 4_000) || {};
  const refs = safeAggJson(row.evidence_refs_json, 24_000);
  const memberships = queryRows(db, 'SELECT goal_id,created_at FROM adaptive_goal_knowledge_memberships WHERE node_id=? ORDER BY goal_id LIMIT 100', [nodeId])
    .map(item => ({ goal_id: boundedText(item.goal_id, 200), created_at: item.created_at }));
  const relations = queryRows(db, `SELECT edge_id,goal_id,from_id,to_id,type,evidence_refs_json,provenance_json,created_at FROM adaptive_goal_knowledge_edges WHERE from_id=? OR to_id=? ORDER BY created_at DESC LIMIT 100`, [nodeId,nodeId])
    .map(edge => ({ id: edge.edge_id, goal_id: boundedText(edge.goal_id, 200), from: edge.from_id, to: edge.to_id, type: edge.type, created_at: edge.created_at, evidence_count: (safeAggJson(edge.evidence_refs_json, 12_000) || []).length, provenance_hash: requireHashFromJson(edge.provenance_json) }));
  return {
    id: row.id, stable_key: boundedText(row.stable_key, 200), type: row.type, revision: Number(row.revision), current_revision: Number(row.current_revision),
    label: aggContentLabel(parsedContent, row.stable_key), content, content_truncated: contentTruncated,
    content_hash: row.content_hash, status: row.status, verified: false, usable_for_planning: false,
    evidence_refs: Array.isArray(refs) ? refs.slice(0, 12).map(ref => boundedText(ref, 500)) : [],
    evidence_refs_count: Array.isArray(refs) ? refs.length : 0,
    provenance: {
      source: boundedText(provenance.source, 200), actor: boundedText(provenance.actor, 120),
      reference: boundedText(provenance.reference, 500), note: boundedText(provenance.note, 500)
    }, memberships, history, relations, created_at: row.created_at
  };
}
function requireHashFromJson(value) {
  if (typeof value !== 'string' || value.length > 4_000) return null;
  return createHash('sha256').update(value).digest('hex');
}
const AGG_PLANNER_TOOL_NAMES = new Set([
  'adaptive_goal_graph_search', 'adaptive_goal_phase2_shadow_search', 'adaptive_goal_phase3_mcts_shadow_search'
]);
function hasAggPlannerTelemetry(db) {
  return dbHasTable(db, 'adaptive_goal_planner_runs') && dbHasTable(db, 'adaptive_goal_planner_run_events') &&
    dbHasTable(db, 'adaptive_goal_planner_run_nodes') && dbHasTable(db, 'adaptive_goal_planner_run_edges') &&
    dbHasTable(db, 'adaptive_goal_planner_run_goals') && dbHasTable(db, 'adaptive_goal_planner_run_evidence');
}
function formatAggPlannerRun(row, nowMs = Date.now()) {
  const startedMs = Date.parse(row.started_at || '');
  const terminal = row.status !== 'running' && Boolean(row.finished_at);
  const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : null;
  return {
    run_id: row.run_id, tool_name: row.tool_name, status: row.status,
    run_state: terminal ? row.status : (elapsedMs !== null && elapsedMs > 120_000 ? 'possibly_interrupted' : 'non_terminal'),
    terminal_observed: terminal,
    started_at: row.started_at, finished_at: row.finished_at,
    duration_ms: terminal ? (Number.isSafeInteger(Number(row.duration_ms)) ? Number(row.duration_ms) : null) : null,
    tool_result_observed_duration_ms: row.tool_result_observed_duration_ms === null || row.tool_result_observed_duration_ms === undefined ? null : Number(row.tool_result_observed_duration_ms),
    elapsed_ms: terminal ? null : elapsedMs,
    request_sha256: row.request_sha256, input_graph_sha256: row.input_graph_sha256,
    graph_hash: row.graph_hash, search_run_id: row.search_run_id,
    goal_id: row.goal_id, goal_node_id: row.goal_node_id,
    input_node_count: row.input_node_count === null ? null : Number(row.input_node_count),
    input_edge_count: row.input_edge_count === null ? null : Number(row.input_edge_count),
    observed_node_count: row.observed_node_count === null ? null : Number(row.observed_node_count),
    observed_edge_count: row.observed_edge_count === null ? null : Number(row.observed_edge_count),
    algorithm_status: row.algorithm_status, termination_reason: row.termination_reason,
    candidate_count: row.candidate_count === null ? null : Number(row.candidate_count),
    partial_candidate_count: row.partial_candidate_count === null ? null : Number(row.partial_candidate_count),
    search_event_count: row.search_event_count === null ? null : Number(row.search_event_count),
    search_event_count_recorded: Number(row.search_event_count_recorded || 0),
    search_event_count_omitted: Number(row.search_event_count_omitted || 0),
    search_events_truncated: Boolean(row.search_events_truncated),
    metrics: safeAggJson(row.metrics_json, 48_000) || {},
    error: row.status === 'failed' ? { code: row.error_code, name: row.error_name, message: row.error_message } : null,
    links: { run: `/?view=agg&run_id=${encodeURIComponent(row.run_id)}`, goal_id: row.goal_id, goal_node_id: row.goal_node_id }
  };
}
function getAggPlannerRuns(db, params) {
  if (!hasAggPlannerTelemetry(db)) return {
    available: false,
    reason: 'AGG planner telemetry schema is not initialized. Start the updated writable runtime once; this read-only dashboard never runs migrations.',
    items: [], total: 0, offset: 0, limit: 20,
    summary: { total: 0, completed: 0, failed: 0, non_terminal: 0, average_duration_ms: null, outcome_counts: [] }, trend: []
  };
  const q = boundedText(params.get('q') || '', 180).trim();
  const status = boundedText(params.get('status') || '', 40).trim();
  const tool = boundedText(params.get('tool') || '', 100).trim();
  const goalId = boundedText(params.get('goalId') || '', 200).trim();
  const nodeId = boundedText(params.get('nodeId') || '', 512).trim();
  const since = boundedText(params.get('since') || '', 32).trim();
  const until = boundedText(params.get('until') || '', 32).trim();
  const limit = clampInt(params.get('limit'), 20, 1, 100);
  const offset = clampInt(params.get('offset'), 0, 0, 1_000_000);
  const where = []; const values = [];
  if (['running','completed','failed'].includes(status)) { where.push('r.status=?'); values.push(status); }
  if (tool && AGG_PLANNER_TOOL_NAMES.has(tool)) { where.push('r.tool_name=?'); values.push(tool); }
  if (goalId) { where.push('(r.goal_id=? OR EXISTS (SELECT 1 FROM adaptive_goal_planner_run_goals rg WHERE rg.run_id=r.run_id AND rg.goal_id=?))'); values.push(goalId, goalId); }
  if (nodeId) { where.push('EXISTS (SELECT 1 FROM adaptive_goal_planner_run_nodes rn WHERE rn.run_id=r.run_id AND rn.node_id=?)'); values.push(nodeId); }
  if (since && /^\d{4}-\d{2}-\d{2}(?:T[^ ]+)?$/.test(since)) { where.push('r.started_at>=?'); values.push(since.length === 10 ? `${since}T00:00:00.000Z` : since); }
  if (until && /^\d{4}-\d{2}-\d{2}(?:T[^ ]+)?$/.test(until)) { where.push('r.started_at<=?'); values.push(until.length === 10 ? `${until}T23:59:59.999Z` : until); }
  if (q) {
    const escaped = `%${q.replace(/[\\%_]/g, char => `\\${char}`)}%`;
    where.push(`(r.run_id LIKE ? ESCAPE '\\' OR r.tool_name LIKE ? ESCAPE '\\' OR COALESCE(r.algorithm_status,'') LIKE ? ESCAPE '\\' OR COALESCE(r.goal_id,'') LIKE ? ESCAPE '\\' OR COALESCE(r.goal_node_id,'') LIKE ? ESCAPE '\\' OR COALESCE(r.graph_hash,'') LIKE ? ESCAPE '\\' OR COALESCE(r.input_graph_sha256,'') LIKE ? ESCAPE '\\' OR COALESCE(r.search_run_id,'') LIKE ? ESCAPE '\\' OR COALESCE(r.request_sha256,'') LIKE ? ESCAPE '\\' OR COALESCE(r.error_message,'') LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM adaptive_goal_planner_run_nodes qn WHERE qn.run_id=r.run_id AND (qn.node_id LIKE ? ESCAPE '\\' OR qn.label LIKE ? ESCAPE '\\')) OR EXISTS (SELECT 1 FROM adaptive_goal_planner_run_evidence qe WHERE qe.run_id=r.run_id AND qe.reference LIKE ? ESCAPE '\\'))`);
    values.push(...Array(13).fill(escaped));
  }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(queryOne(db, `SELECT COUNT(*) AS count FROM adaptive_goal_planner_runs r ${filter}`, values)?.count || 0);
  const rows = queryRows(db, `SELECT r.*,
      (SELECT COUNT(*) FROM adaptive_goal_planner_run_nodes n WHERE n.run_id=r.run_id) AS linked_nodes,
      (SELECT COUNT(*) FROM adaptive_goal_planner_run_edges e WHERE e.run_id=r.run_id) AS linked_edges,
      (SELECT COUNT(DISTINCT reference) FROM adaptive_goal_planner_run_evidence v WHERE v.run_id=r.run_id) AS evidence_refs,
      (SELECT COUNT(*) FROM adaptive_goal_planner_run_events ev WHERE ev.run_id=r.run_id AND ev.event_source='search_observer') AS observed_steps
    FROM adaptive_goal_planner_runs r ${filter} ORDER BY r.started_at DESC,r.run_id DESC LIMIT ? OFFSET ?`, [...values,limit,offset]);
  const allSummary = queryOne(db, `SELECT COUNT(*) AS total,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status='running' OR finished_at IS NULL THEN 1 ELSE 0 END) AS non_terminal,
      AVG(CASE WHEN status IN ('completed','failed') AND duration_ms IS NOT NULL THEN duration_ms END) AS average_duration_ms
    FROM adaptive_goal_planner_runs`);
  const outcomeCounts = queryRows(db, `SELECT algorithm_status,COUNT(*) AS count FROM adaptive_goal_planner_runs WHERE algorithm_status IS NOT NULL GROUP BY algorithm_status ORDER BY count DESC,algorithm_status LIMIT 20`)
    .map(row => ({ status: row.algorithm_status, count: Number(row.count) }));
  const trendRows = queryRows(db, `SELECT substr(started_at,1,10) AS day,
      COUNT(*) AS runs,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status='running' OR finished_at IS NULL THEN 1 ELSE 0 END) AS non_terminal
    FROM adaptive_goal_planner_runs WHERE started_at>=? GROUP BY substr(started_at,1,10) ORDER BY day`,
    [new Date(Date.now() - 13 * 24 * 60 * 60 * 1000).toISOString().slice(0,10) + 'T00:00:00.000Z']);
  const trendByDay = new Map(trendRows.map(row => [row.day, { day: row.day, runs: Number(row.runs), completed: Number(row.completed || 0), failed: Number(row.failed || 0), non_terminal: Number(row.non_terminal || 0) }]));
  const trend = [];
  const today = new Date(); today.setUTCHours(0,0,0,0);
  for (let i = 13; i >= 0; i--) {
    const day = new Date(today); day.setUTCDate(today.getUTCDate() - i);
    const key = day.toISOString().slice(0,10);
    trend.push(trendByDay.get(key) || { day: key, runs: 0, completed: 0, failed: 0, non_terminal: 0 });
  }
  return {
    available: true, generated_at: new Date().toISOString(),
    filters: { q: q || null, status: status || null, tool: tool || null, goal_id: goalId || null, node_id: nodeId || null, since: since || null, until: until || null },
    items: rows.map(row => ({ ...formatAggPlannerRun(row), linked_node_count: Number(row.linked_nodes), linked_edge_count: Number(row.linked_edges), evidence_reference_count: Number(row.evidence_refs), observed_step_count: Number(row.observed_steps) })),
    total, offset, limit, has_more: offset + rows.length < total,
    summary: { total: Number(allSummary.total || 0), completed: Number(allSummary.completed || 0), failed: Number(allSummary.failed || 0), non_terminal: Number(allSummary.non_terminal || 0), average_duration_ms: allSummary.average_duration_ms === null ? null : Math.round(Number(allSummary.average_duration_ms)), algorithm_outcome_counts: outcomeCounts },
    trend, semantics: {
      completed_means_tool_returned_result: true,
      failed_means_tool_invocation_threw: true,
      algorithm_status_is_not_acceptance_or_verified_success: true,
      non_terminal_means_no_terminal_record_observed: true,
      possibly_interrupted_is_age_heuristic_only: true
    }
  };
}
function getAggPlannerRunDetail(db, runId) {
  if (!hasAggPlannerTelemetry(db)) return null;
  const row = queryOne(db, 'SELECT * FROM adaptive_goal_planner_runs WHERE run_id=?', [runId]);
  if (!row) return null;
  const nodes = queryRows(db, 'SELECT * FROM adaptive_goal_planner_run_nodes WHERE run_id=? ORDER BY node_type,node_id LIMIT 500', [runId]).map(node => ({
    node_id: node.node_id, node_type: node.node_type, label: boundedText(node.label, 500), source_kind: node.source_kind,
    knowledge_goal_id: node.knowledge_goal_id, revision: node.revision === null ? null : Number(node.revision),
    content_hash: node.content_hash, provenance_hash: node.provenance_hash,
    evidence_refs: safeAggJson(node.evidence_refs_json, 12_000) || [], node_snapshot: safeAggJson(node.node_snapshot_json, MAX_AGG_NODE_SNAPSHOT_BYTES) || {},
    links: { node: `/?view=agg&run_id=${encodeURIComponent(runId)}&node_id=${encodeURIComponent(node.node_id)}${node.revision === null ? '' : `&revision=${encodeURIComponent(node.revision)}`}` }
  }));
  const edges = queryRows(db, 'SELECT * FROM adaptive_goal_planner_run_edges WHERE run_id=? ORDER BY edge_type,from_node_id,to_node_id LIMIT 1000', [runId]).map(edge => ({
    edge_id: edge.edge_id, goal_id: edge.goal_id, from_node_id: edge.from_node_id, to_node_id: edge.to_node_id,
    edge_type: edge.edge_type, source_kind: edge.source_kind, evidence_refs: safeAggJson(edge.evidence_refs_json, 12_000) || [],
    edge_snapshot: safeAggJson(edge.edge_snapshot_json, 4_000) || {}
  }));
  const goals = queryRows(db, 'SELECT goal_id,goal_kind,source_kind FROM adaptive_goal_planner_run_goals WHERE run_id=? ORDER BY goal_kind,goal_id LIMIT 200', [runId]);
  const evidence = queryRows(db, 'SELECT * FROM adaptive_goal_planner_run_evidence WHERE run_id=? ORDER BY reference,observation_source LIMIT 500', [runId]).map(item => ({
    reference: item.reference, source_node_id: item.source_node_id || null, observation_source: item.observation_source,
    kind: item.kind, classification: item.classification, artifact_id: item.artifact_id, source_job_id: item.source_job_id,
    content_hash: item.content_hash, lineage_verified: item.lineage_verified === null ? null : Boolean(item.lineage_verified),
    claim_verified: item.claim_verified === null ? null : Boolean(item.claim_verified), details: safeAggJson(item.details_json, 12_000) || {},
    links: { node_id: item.source_node_id || null, artifact_id: item.artifact_id || null, goal_id: row.goal_id || null }
  }));
  const events = queryRows(db, 'SELECT sequence,event_type,observed_at,event_source,payload_json,payload_truncated FROM adaptive_goal_planner_run_events WHERE run_id=? ORDER BY sequence LIMIT 80', [runId]).map(event => ({
    sequence: Number(event.sequence), event_type: event.event_type, observed_at: event.observed_at, event_source: event.event_source,
    payload: safeAggJson(event.payload_json, 24_000) || {}, payload_truncated: Boolean(event.payload_truncated)
  }));
  const counts = queryOne(db, `SELECT (SELECT COUNT(*) FROM adaptive_goal_planner_run_events WHERE run_id=?) AS events,
      (SELECT COUNT(*) FROM adaptive_goal_planner_run_events WHERE run_id=? AND event_source='search_observer') AS steps,
      (SELECT COUNT(*) FROM adaptive_goal_planner_run_nodes WHERE run_id=?) AS nodes,
      (SELECT COUNT(*) FROM adaptive_goal_planner_run_edges WHERE run_id=?) AS edges,
      (SELECT COUNT(DISTINCT reference) FROM adaptive_goal_planner_run_evidence WHERE run_id=?) AS evidence,
      (SELECT COUNT(*) FROM adaptive_goal_planner_run_evidence WHERE run_id=?) AS evidence_observations`, [runId,runId,runId,runId,runId,runId]);
  const countsAsNumbers = Object.fromEntries(Object.entries(counts).map(([key,value]) => [key,Number(value || 0)]));
  const graphSnapshotTruncated = (Number(row.observed_node_count || 0) > countsAsNumbers.nodes) ||
    (Number(row.observed_edge_count || 0) > countsAsNumbers.edges);
  return {
    available: true, run: formatAggPlannerRun(row),
    metrics: safeAggJson(row.metrics_json, 48_000) || {},
    candidates: safeAggJson(row.candidates_json, MAX_AGG_RUN_CANDIDATES_BYTES) || [],
    provenance: safeAggJson(row.provenance_json, 24_000) || {},
    nodes, edges, goals, evidence, events,
    counts: countsAsNumbers,
    events_truncated_in_response: Number(counts.events || 0) > events.length,
    nodes_truncated_in_response: countsAsNumbers.nodes > nodes.length,
    edges_truncated_in_response: countsAsNumbers.edges > edges.length,
    evidence_truncated_in_response: countsAsNumbers.evidence_observations > evidence.length,
    graph_snapshot_truncated: graphSnapshotTruncated,
    snapshot_limits: {
      graph_nodes_persisted_per_run: 500,
      graph_edges_persisted_per_run: 2000,
      distinct_evidence_references_persisted_per_run: 5000,
      node_snapshot_json_bytes: MAX_AGG_NODE_SNAPSHOT_BYTES,
      run_candidates_json_bytes: MAX_AGG_RUN_CANDIDATES_BYTES,
      node_details_returned: 500,
      edge_details_returned: 1000,
      timeline_initial_events: 80,
      timeline_page_max: 250,
      evidence_observations_returned: 500,
      note: 'Limits bound stored/returned records. A count difference indicates truncation; absence of a linked record does not prove the planner never observed it.'
    },
    trace_semantics: 'Search observer timestamps are wall-clock observations recorded at event emission. Run duration spans the full MCP tool invocation; no per-node runtime or quality score is inferred. Unfinished runs have no terminal record, so elapsed time is provisional.'
  };
}
const MAX_AGG_NODE_SNAPSHOT_BYTES = 12 * 1024;
const MAX_AGG_RUN_CANDIDATES_BYTES = 128 * 1024;
function getAggPlannerRunEvents(db, runId, params) {
  if (!hasAggPlannerTelemetry(db)) return null;
  if (!queryOne(db, 'SELECT run_id FROM adaptive_goal_planner_runs WHERE run_id=?', [runId])) return null;
  const limit = clampInt(params.get('limit'), 100, 1, 250);
  const after = clampInt(params.get('afterSequence'), 0, 0, 2_000_000_000);
  const type = boundedText(params.get('type') || '', 120).trim();
  const where = ['run_id=?','sequence>?']; const values = [runId,after];
  if (type) { where.push('event_type=?'); values.push(type); }
  const rows = queryRows(db, `SELECT sequence,event_type,observed_at,event_source,payload_json,payload_truncated FROM adaptive_goal_planner_run_events WHERE ${where.join(' AND ')} ORDER BY sequence LIMIT ?`, [...values,limit+1]);
  const hasMore = rows.length > limit; if (hasMore) rows.pop();
  return {
    available: true, run_id: runId, after_sequence: after, limit, has_more: hasMore,
    items: rows.map(event => ({ sequence: Number(event.sequence), event_type: event.event_type, observed_at: event.observed_at, event_source: event.event_source, payload: safeAggJson(event.payload_json, 24_000) || {}, payload_truncated: Boolean(event.payload_truncated) })),
    next_after_sequence: rows.length ? Number(rows.at(-1).sequence) : after
  };
}
function safeJsonArray(value, max = 24_000, options = {}) {
  const parsed = parseJson(value, max, options);
  return Array.isArray(parsed.value) ? parsed.value : [];
}
function skillSourceLabel(source) {
  if (!source || typeof source !== 'object') return 'Unknown source';
  if (source.kind === 'local') return `Local skill · ${path.posix.basename(String(source.location || 'skill').replaceAll('\\', '/'))}`;
  try {
    const url = new URL(String(source.location || ''));
    if (url.protocol !== 'https:' || url.username || url.password) return 'External source';
    return `${url.hostname}${url.pathname}`.slice(0, 240);
  } catch { return 'External source'; }
}
function safeSkillFilePath(value) {
  const raw = String(value || '').slice(0, 240).replaceAll('\\', '/');
  if (!raw) return 'supporting-file';
  if (raw.startsWith('/') || raw.startsWith('~') || /^[a-z]:\//i.test(raw) || /^https?:\/\//i.test(raw)) {
    return path.posix.basename(raw) || 'local-file';
  }
  const segments = raw.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return path.posix.basename(raw) || 'supporting-file';
  return raw;
}
function getRoles(db, params) {
  const q = boundedText(params.get('q') || '', 160).trim();
  const includeVersions = params.get('versions') === 'all';
  const limit = clampInt(params.get('limit'), 20, 1, 25);
  const builtinRoles = queryRows(db, `SELECT t.role,COUNT(*) AS task_count,COUNT(DISTINCT t.job_id) AS job_count
    FROM tasks t WHERE t.role NOT LIKE 'custom-task-%'
    GROUP BY t.role ORDER BY t.role`);

  let customRoles = [];
  if (dbHasTable(db, 'custom_role_versions')) {
    const filters = [];
    const values = [];
    if (q) {
      filters.push('(role_id LIKE ? OR name LIKE ? OR description LIKE ? OR skills_json LIKE ?)');
      values.push(...Array(4).fill(`%${q}%`));
    }
    const filter = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const sql = includeVersions
      ? `SELECT * FROM custom_role_versions ${filter} ORDER BY role_id,version DESC LIMIT ?`
      : `SELECT v.* FROM custom_role_versions v JOIN (
          SELECT role_id,MAX(version) AS version FROM custom_role_versions GROUP BY role_id
        ) latest ON latest.role_id=v.role_id AND latest.version=v.version ${filter.replaceAll('role_id','v.role_id').replaceAll('name','v.name').replaceAll('description','v.description')} ORDER BY v.role_id LIMIT ?`;
    customRoles = queryRows(db, sql, [...values, limit]).map(row => {
      const skills = safeJsonArray(row.skills_json, 180_000, { redactLocalSkillPaths: false }).map(skill => ({
        name: boundedText(skill.name || 'unnamed-skill', 80),
        description: boundedText(skill.description || '', 1_000),
        source: skillSourceLabel(skill.source),
        sha256: typeof skill.sha256 === 'string' ? skill.sha256 : null,
        supporting_files: Array.isArray(skill.files) ? skill.files.length : 0,
        instruction_chars: typeof skill.instructions === 'string' ? skill.instructions.length : 0,
        instructions_preview: boundedText(skill.instructions || '', 1_200),
        instructions_truncated: typeof skill.instructions === 'string' && skill.instructions.length > 1_200,
        files_truncated: Array.isArray(skill.files) && skill.files.length > 12,
        files: Array.isArray(skill.files) ? skill.files.slice(0, 12).map(file => ({
          path: safeSkillFilePath(file.path), sha256: typeof file.sha256 === 'string' ? file.sha256 : null,
          size_bytes: Number(file.size_bytes) || 0
        })) : []
      }));
      return {
        role_id: row.role_id, version: row.version, name: boundedText(row.name, 120),
        description: boundedText(row.description, 2_000), system_prompt: boundedText(row.system_prompt, 6_000),
        input_contract: safeJsonArray(row.input_contract_json), output_artifact_type: row.output_artifact_type,
        allowed_capabilities: safeJsonArray(row.allowed_capabilities_json), permissions: safeJsonArray(row.permissions_json),
        allowed_tools: safeJsonArray(row.allowed_tools_json), skills, created_at: row.created_at, created_by: boundedText(row.created_by, 200)
      };
    });
  }

  let customWorkflows = [];
  if (dbHasTable(db, 'custom_workflow_versions')) {
    const filters = [];
    const values = [];
    if (q) { filters.push('(workflow_id LIKE ? OR name LIKE ? OR description LIKE ? OR tasks_json LIKE ?)'); values.push(...Array(4).fill(`%${q}%`)); }
    const filter = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const sql = includeVersions
      ? `SELECT * FROM custom_workflow_versions ${filter} ORDER BY workflow_id,version DESC LIMIT ?`
      : `SELECT v.* FROM custom_workflow_versions v JOIN (
          SELECT workflow_id,MAX(version) AS version FROM custom_workflow_versions GROUP BY workflow_id
        ) latest ON latest.workflow_id=v.workflow_id AND latest.version=v.version ${filter.replaceAll('workflow_id','v.workflow_id').replaceAll('name','v.name').replaceAll('description','v.description')} ORDER BY v.workflow_id LIMIT ?`;
    customWorkflows = queryRows(db, sql, [...values, limit]).map(row => {
      const tasks = safeJsonArray(row.tasks_json, 64_000).map(task => {
        const role = dbHasTable(db, 'custom_role_versions')
          ? queryOne(db, 'SELECT role_id,version,name,output_artifact_type,skills_json FROM custom_role_versions WHERE role_id=? AND version=?', [task.role_id, task.role_version])
          : null;
        const skills = safeJsonArray(role?.skills_json, 180_000, { redactLocalSkillPaths: false }).map(skill => boundedText(skill.name || 'unnamed-skill', 80));
        return { task_id: boundedText(task.id, 80), role_id: boundedText(task.role_id, 80), role_version: Number.isSafeInteger(task.role_version) && task.role_version > 0 ? task.role_version : null,
          role_name: boundedText(role?.name || task.role_id || 'Unknown role', 120),
          output_artifact_type: boundedText(task.output_artifact_type || '', 80), input_contract: Array.isArray(task.input_contract) ? task.input_contract.slice(0, 32).map(x => boundedText(x, 80)) : [],
          depends_on: Array.isArray(task.depends_on) ? task.depends_on.slice(0, 32).map(x => boundedText(x, 80)) : [], skills };
      });
      return { workflow_id: row.workflow_id, version: row.version, name: boundedText(row.name, 120),
        description: boundedText(row.description, 2_000), input_contract: safeJsonArray(row.input_contract_json), task_count: tasks.length,
        tasks, created_at: row.created_at, created_by: boundedText(row.created_by, 200) };
    });
  }

  // Built-in role overlays are pinned by the immutable workflow proposal
  // event, not inferred from whichever custom-role version is newest.
  const builtinRoleProfilePins = [];
  if (dbHasTable(db, 'events') && dbHasTable(db, 'jobs') && dbHasTable(db, 'custom_role_versions')) {
    const proposalRows = queryRows(db, `SELECT e.job_id,j.title,j.status AS workflow_status,e.payload_json,e.created_at
      FROM events e JOIN jobs j ON j.job_id=e.job_id
      WHERE e.type IN ('job.proposal_requested','job.proposal_refined')
        AND e.rowid=(SELECT p.rowid FROM events p WHERE p.job_id=e.job_id
          AND p.type IN ('job.proposal_requested','job.proposal_refined') ORDER BY p.created_at DESC,p.rowid DESC LIMIT 1)
      ORDER BY e.created_at DESC LIMIT 500`);
    for (const row of proposalRows) {
      const parsed = parseJson(row.payload_json, 64_000);
      if (parsed.malformed || !Array.isArray(parsed.value?.role_profile_bindings)) continue;
      for (const binding of parsed.value.role_profile_bindings) {
        if (!binding || typeof binding.role !== 'string' || typeof binding.custom_role_id !== 'string' ||
            !Number.isSafeInteger(binding.custom_role_version) || binding.custom_role_version < 1) continue;
        const role = queryOne(db, 'SELECT name,output_artifact_type,skills_json FROM custom_role_versions WHERE role_id=? AND version=?', [binding.custom_role_id, binding.custom_role_version]);
        const skills = safeJsonArray(role?.skills_json, 180_000, { redactLocalSkillPaths: false }).map(skill => boundedText(skill.name || 'unnamed-skill', 80));
        const item = {
          job_id: boundedText(row.job_id, 200), workflow_name: boundedText(row.title || row.job_id, 500),
          workflow_status: boundedText(row.workflow_status || 'unknown', 40),
          workflow_id: boundedText(parsed.value.workflowId || 'standard-engineering', 80),
          built_in_role: boundedText(binding.role, 80), task_id: boundedText(`standard-${binding.role}`, 100),
          role_id: boundedText(binding.custom_role_id, 80), role_version: binding.custom_role_version,
          role_name: boundedText(role?.name || binding.custom_role_id, 120),
          output_artifact_type: boundedText(role?.output_artifact_type || '', 80), skills,
          profile_hash: /^[a-f0-9]{64}$/.test(binding.profile_hash || '') ? binding.profile_hash : null,
          created_at: row.created_at
        };
        if (!q || [item.job_id,item.workflow_name,item.workflow_id,item.built_in_role,item.role_id,item.role_name,...skills].some(value => String(value).toLowerCase().includes(q.toLowerCase()))) {
          builtinRoleProfilePins.push(item);
        }
      }
    }
  }
  const latestRoles = dbHasTable(db, 'custom_role_versions')
    ? queryRows(db, 'SELECT skills_json FROM custom_role_versions v WHERE version=(SELECT MAX(x.version) FROM custom_role_versions x WHERE x.role_id=v.role_id)')
    : [];
  return {
    mode: 'read-only registry snapshot', generated_at: new Date().toISOString(), include_versions: includeVersions,
    summary: {
      built_in_role_ids: builtinRoles.length,
      custom_profiles: dbHasTable(db, 'custom_role_versions') ? Number(queryOne(db, 'SELECT COUNT(DISTINCT role_id) n FROM custom_role_versions')?.n || 0) : 0,
      custom_role_versions: tableCount(db, 'custom_role_versions'),
      attached_skills: latestRoles.reduce((sum, row) => sum + safeJsonArray(row.skills_json, 180_000).length, 0),
      custom_workflows: dbHasTable(db, 'custom_workflow_versions') ? Number(queryOne(db, 'SELECT COUNT(DISTINCT workflow_id) n FROM custom_workflow_versions')?.n || 0) : 0,
      builtin_profile_pins: builtinRoleProfilePins.length
    },
    builtin_roles: builtinRoles.map(row => ({ role: row.role, task_count: Number(row.task_count), job_count: Number(row.job_count) })),
    custom_roles: customRoles,
    custom_workflows: customWorkflows,
    builtin_role_profile_pins: builtinRoleProfilePins,
    edit_note: 'This dashboard is deliberately GET-only. Use custom_role_create/update and custom_workflow_create/update tools to change definitions; run approval flow before execution.'
  };
}
function getBatches(db, params) {
  const q = boundedText(params.get('q') || '', 160).trim();
  const status = boundedText(params.get('status') || '', 40).trim().toUpperCase();
  const jobId = boundedText(params.get('jobId') || '', 200).trim();
  const limit = clampInt(params.get('limit'), 10, 1, 10);
  const offset = clampInt(params.get('offset'), 0, 0, 100_000);
  const executionLimit = clampInt(params.get('executionLimit'), 50, 1, 50);
  const executionOffset = clampInt(params.get('executionOffset'), 0, 0, 100_000);
  const where = [];
  const values = [];
  if (q) { where.push('(b.batch_id LIKE ? OR b.role LIKE ? OR b.job_id LIKE ? OR j.title LIKE ?)'); values.push(...Array(4).fill(`%${q}%`)); }
  if (status) { where.push('UPPER(b.status)=?'); values.push(status); }
  if (jobId) { where.push('b.job_id=?'); values.push(jobId); }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const join = 'FROM execution_batches b LEFT JOIN jobs j ON j.job_id=b.job_id';
  const rows = queryRows(db, `SELECT b.batch_id,b.job_id,b.parent_task_id,b.role,b.status,b.attempt,b.created_at,b.started_at,b.finished_at,
      substr(b.aggregate_content,1,5001) AS aggregate_content,length(b.aggregate_content) AS aggregate_size,
      j.title AS job_title,(SELECT COUNT(*) FROM execution_batch_items i WHERE i.batch_id=b.batch_id) AS item_count,
      (SELECT COUNT(*) FROM execution_batch_items i WHERE i.batch_id=b.batch_id AND UPPER(i.status)='COMPLETED') AS completed_items,
      (SELECT COUNT(*) FROM execution_batch_items i WHERE i.batch_id=b.batch_id AND UPPER(i.status)='FAILED') AS failed_items
    ${join} ${filter} ORDER BY COALESCE(b.created_at,b.started_at) DESC LIMIT ? OFFSET ?`, [...values, limit, offset]);
  const total = Number(queryOne(db, `SELECT COUNT(*) AS n ${join} ${filter}`, values)?.n || 0);
  const items = rows.map(batch => {
    const batchItems = queryRows(db, `SELECT item_id,task_id,substr(command,1,1001) AS command,substr(cwd,1,501) AS cwd,timeout_ms,attempt,status,execution_session_id,execution_pid,exit_code,
        substr(stdout,1,1501) AS stdout,length(stdout) AS stdout_size,substr(stderr,1,1501) AS stderr,length(stderr) AS stderr_size,started_at,finished_at,substr(error,1,1001) AS error
      FROM execution_batch_items WHERE batch_id=? ORDER BY item_id LIMIT 20`, [batch.batch_id]).map(item => ({
        ...item, command: boundedText(item.command, 1_000), cwd: boundedText(item.cwd, 500), stdout: boundedText(item.stdout, 1_500),
        stderr: boundedText(item.stderr, 1_500), error: boundedText(item.error, 1_000),
        stdout_truncated: Number(item.stdout_size || 0) > 1_500, stderr_truncated: Number(item.stderr_size || 0) > 1_500
      }));
    return {
      ...batch, batch_id: boundedText(batch.batch_id, 200), job_id: boundedText(batch.job_id, 200),
      parent_task_id: boundedText(batch.parent_task_id, 200), role: boundedText(batch.role, 120), status: boundedText(batch.status, 40),
      job_title: boundedText(batch.job_title || batch.job_id, 1_000), aggregate_content: boundedText(batch.aggregate_content, 2_000),
      items_total: Number(batch.item_count || 0), items_truncated: Number(batch.item_count || 0) > batchItems.length, items: batchItems
    };
  });
  const statuses = dbHasTable(db, 'execution_batches') ? queryRows(db, 'SELECT UPPER(status) AS status,COUNT(*) AS count FROM execution_batches GROUP BY UPPER(status) ORDER BY status') : [];
  const individualWhere = ['(t.execution_status IS NOT NULL OR t.execution_session_id IS NOT NULL)'];
  const individualValues = [];
  if (q) {
    individualWhere.push('(t.task_id LIKE ? OR t.job_id LIKE ? OR t.role LIKE ? OR j.title LIKE ? OR CASE WHEN json_valid(t.metadata_json) THEN CAST(json_extract(t.metadata_json,\'$.custom_role_id\') AS TEXT) ELSE \'\' END LIKE ? OR CASE WHEN json_valid(t.metadata_json) THEN CAST(json_extract(t.metadata_json,\'$.custom_role_name\') AS TEXT) ELSE \'\' END LIKE ?)');
    individualValues.push(...Array(6).fill(`%${q}%`));
  }
  if (status) { individualWhere.push('UPPER(t.execution_status)=?'); individualValues.push(status); }
  if (jobId) { individualWhere.push('t.job_id=?'); individualValues.push(jobId); }
  const individualFilter = `WHERE ${individualWhere.join(' AND ')}`;
  const individualJoin = 'FROM tasks t LEFT JOIN jobs j ON j.job_id=t.job_id';
  const individualRows = queryRows(db, `SELECT t.task_id,t.job_id,t.role,t.status AS task_status,t.execution_status,t.execution_attempt,t.execution_exit_code,
      t.execution_session_id,t.execution_pid,t.execution_started_at,t.execution_finished_at,
      substr(t.execution_stdout,1,6001) AS stdout,length(t.execution_stdout) AS stdout_size,
      substr(t.execution_stderr,1,6001) AS stderr,length(t.execution_stderr) AS stderr_size,
      CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.custom_role_id') END AS custom_role_id,
      CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.custom_role_version') END AS custom_role_version,
      CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.custom_role_name') END AS custom_role_name,
      j.title AS job_title
    ${individualJoin} ${individualFilter} ORDER BY COALESCE(t.execution_started_at,t.updated_at,t.created_at) DESC LIMIT ? OFFSET ?`, [...individualValues, executionLimit, executionOffset]);
  const individualTotal = Number(queryOne(db, `SELECT COUNT(*) AS n ${individualJoin} ${individualFilter}`, individualValues)?.n || 0);
  const individualItems = individualRows.map(row => {
    const roleId = typeof row.custom_role_id === 'string' && row.custom_role_id.length <= 80 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(row.custom_role_id)
      ? row.custom_role_id : null;
    const parsedRoleVersion = Number(row.custom_role_version);
    const roleVersion = Number.isSafeInteger(parsedRoleVersion) && parsedRoleVersion >= 1 ? parsedRoleVersion : null;
    const customRole = roleId && roleVersion !== null;
    const roleDisplay = customRole
      ? `${boundedText(row.custom_role_name || roleId, 120)} (${roleId}@${roleVersion})`
      : row.role;
    const { custom_role_id: _customRoleId, custom_role_version: _customRoleVersion, custom_role_name: _customRoleName, ...safeRow } = row;
    return { ...safeRow, role_display: roleDisplay, job_title: boundedText(row.job_title || row.job_id, 1_000),
      stdout: boundedText(row.stdout, 6_000), stderr: boundedText(row.stderr, 6_000),
      stdout_truncated: Number(row.stdout_size || 0) > 6_000, stderr_truncated: Number(row.stderr_size || 0) > 6_000 };
  });
  const individualStatuses = dbHasTable(db, 'tasks')
    ? queryRows(db, "SELECT UPPER(execution_status) AS status,COUNT(*) AS count FROM tasks WHERE execution_status IS NOT NULL OR execution_session_id IS NOT NULL GROUP BY UPPER(execution_status) ORDER BY status")
    : [];
  return {
    items, total, limit, offset, statuses,
    individual_items: individualItems, individual_total: individualTotal, individual_limit: executionLimit, individual_offset: executionOffset, individual_statuses: individualStatuses,
    summary: { batches: tableCount(db, 'execution_batches'), items: tableCount(db, 'execution_batch_items'), individual_executions: Number(queryOne(db, 'SELECT COUNT(*) AS n FROM tasks WHERE execution_status IS NOT NULL OR execution_session_id IS NOT NULL')?.n || 0) },
    empty_explanation: 'A batch is created only when the durable execute_batch path groups approved deterministic local task IDs. Standard specialist workflow tasks are normally recorded individually, so task count does not imply batch count.'
  };
}
function getJobDetail(db, jobId) {
  const job = queryOne(db, `SELECT j.*, COALESCE(w.phase,j.state) AS phase, w.attempt AS phase_attempt, w.resume_after, w.last_error AS phase_error, w.updated_at AS phase_updated_at
    FROM jobs j LEFT JOIN workflow_runtime_state w ON w.job_id=j.job_id WHERE j.job_id=?`, [jobId]);
  if (!job) return null;
  const tasks = queryRows(db, `SELECT task_id,job_id,role,substr(description,1,5001) AS description,status,openclaw_run_id,openclaw_session_key,parent_task_id,substr(dependency_json,1,4001) AS dependency_json,substr(metadata_json,1,4001) AS metadata_json,length(metadata_json) AS metadata_size,
      CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.workflow_plan_task_id') END AS workflow_plan_task_id,
      CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.custom_role_id') END AS custom_role_id,
      CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.custom_role_version') END AS custom_role_version,
      CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.custom_role_name') END AS custom_role_name,
      created_at,updated_at,execution_session_id,execution_status,execution_attempt,execution_pid,execution_exit_code,execution_started_at,execution_finished_at,substr(execution_stdout,1,6001) AS execution_stdout,substr(execution_stderr,1,6001) AS execution_stderr,length(execution_stdout) AS execution_stdout_size,length(execution_stderr) AS execution_stderr_size FROM tasks WHERE job_id=? ORDER BY created_at ASC LIMIT 300`, [jobId]).map(safeTask);
  const taskIds = tasks.map(t => t.task_id);
  const taskSet = new Set(taskIds);
  const attempts = queryRows(db, `SELECT a.attempt_id,a.task_id,a.status,a.openclaw_run_id,a.started_at,a.finished_at,substr(a.error,1,4001) AS error,t.role FROM attempts a JOIN tasks t ON t.task_id=a.task_id WHERE t.job_id=? ORDER BY a.started_at DESC LIMIT 150`, [jobId]).map(x=>({...x,error:boundedText(x.error,4000)}));
  const results = queryRows(db, `SELECT r.result_id,r.task_id,r.outcome,substr(r.content,1,6001) AS content,length(r.content) AS content_size,r.created_at,t.role FROM results r JOIN tasks t ON t.task_id=r.task_id WHERE t.job_id=? ORDER BY r.created_at DESC LIMIT 120`, [jobId]).map(x=>({...x,content:boundedText(x.content,6000),content_length:Number(x.content_size||0),content_truncated:Number(x.content_size||0)>6000}));
  const approvals = queryRows(db, 'SELECT approval_id,job_id,decision,actor,substr(raw_text,1,5001) AS raw_text,proposal_hash,created_at FROM approvals WHERE job_id=? ORDER BY created_at DESC LIMIT 50', [jobId]).map(x=>({...x,raw_text:boundedText(x.raw_text,5000)}));
  const artifacts = queryRows(db, `SELECT a.artifact_id,a.job_id,a.task_id,a.kind,a.uri,substr(a.metadata_json,1,4001) AS metadata_json,a.created_at,a.schema_version,a.producer_role,length(a.content) AS content_size,substr(a.evidence_json,1,8001) AS evidence_json,a.status,a.supersedes,a.content_hash,
      CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.custom_role_id') END AS producer_custom_role_id,
      CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.custom_role_version') END AS producer_custom_role_version,
      CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.custom_role_name') END AS producer_custom_role_name FROM artifacts a LEFT JOIN tasks t ON t.task_id=a.task_id WHERE a.job_id=? ORDER BY a.created_at DESC LIMIT 200`, [jobId]).map(x=>mapArtifact(x,false));
  const reports = queryRows(db, 'SELECT report_id,job_id,kind,substr(content,1,8001) AS content,length(content) AS content_size,delivered_at,created_at FROM reports WHERE job_id=? ORDER BY created_at DESC LIMIT 50', [jobId]).map(x=>({...x,content:boundedText(x.content,8000),content_length:Number(x.content_size||0),content_truncated:Number(x.content_size||0)>8000}));
  const events = queryRows(db, 'SELECT event_id,job_id,type,substr(payload_json,1,10001) AS payload_json,length(payload_json) AS payload_size,created_at FROM events WHERE job_id=? ORDER BY created_at DESC LIMIT 120', [jobId]).map(mapEvent);
  const transitions = queryRows(db, 'SELECT workflow_event_id,job_id,from_phase,to_phase,event,attempt,substr(payload_json,1,10001) AS payload_json,length(payload_json) AS payload_size,created_at FROM workflow_events WHERE job_id=? ORDER BY created_at DESC LIMIT 120', [jobId]).map(mapEvent);
  const batches = queryRows(db, 'SELECT batch_id,job_id,parent_task_id,role,status,attempt,created_at,started_at,finished_at,substr(aggregate_content,1,5001) AS aggregate_content,length(aggregate_content) AS aggregate_size FROM execution_batches WHERE job_id=? ORDER BY created_at DESC LIMIT 50', [jobId]).map(batch=>({
    ...batch, aggregate_content: boundedText(batch.aggregate_content,5000), items: queryRows(db, 'SELECT item_id,task_id,substr(command,1,2001) AS command,substr(cwd,1,1001) AS cwd,timeout_ms,attempt,status,execution_session_id,execution_pid,exit_code,substr(stdout,1,6001) AS stdout,length(stdout) AS stdout_size,substr(stderr,1,6001) AS stderr,length(stderr) AS stderr_size,started_at,finished_at,substr(error,1,4001) AS error FROM execution_batch_items WHERE batch_id=? ORDER BY item_id LIMIT 100',[batch.batch_id]).map(item=>({...item,command:boundedText(item.command,2000),cwd:boundedText(item.cwd,1000),stdout:boundedText(item.stdout,6000),stderr:boundedText(item.stderr,6000),error:boundedText(item.error,4000)}))
  }));
  return { job: {...job, title: boundedText(job.title,1000), conversation_key: boundedText(job.conversation_key,1000), phase_error: boundedText(job.phase_error,4000)}, tasks, orphan_results_count: results.filter(x=>!taskSet.has(x.task_id)).length, approvals, attempts, results, artifacts, reports, events, transitions, batches };
}
function getEvents(db, params) {
  const q = boundedText(params.get('q') || '', 160).trim();
  const type = boundedText(params.get('type') || '', 120);
  const jobId = boundedText(params.get('jobId') || '', 200);
  const limit = clampInt(params.get('limit'), 80, 1, MAX_LIST);
  const offset = clampInt(params.get('offset'), 0, 0, 100_000);
  const where=[]; const values=[];
  if(q){where.push('(e.type LIKE ? OR e.job_id LIKE ? OR e.payload_json LIKE ? OR e.from_phase LIKE ? OR e.to_phase LIKE ?)'); values.push(...Array(5).fill(`%${q}%`));}
  if(type){where.push('e.type=?');values.push(type);}
  if(jobId){where.push('e.job_id=?');values.push(jobId);}
  const filter = where.length?`WHERE ${where.join(' AND ')}`:'';
  const unionSql = `SELECT event_id,job_id,type,payload_json,created_at,'event' AS source,NULL AS from_phase,NULL AS to_phase,NULL AS attempt FROM events
    UNION ALL SELECT workflow_event_id AS event_id,job_id,event AS type,payload_json,created_at,'workflow' AS source,from_phase,to_phase,attempt FROM workflow_events`;
  const items=queryRows(db,`SELECT e.event_id,e.job_id,e.type,e.source,e.from_phase,e.to_phase,e.attempt,substr(e.payload_json,1,10001) AS payload_json,length(e.payload_json) AS payload_size,e.created_at FROM (${unionSql}) e ${filter} ORDER BY e.created_at DESC LIMIT ? OFFSET ?`,[...values,limit,offset]).map(mapEvent);
  const total=Number(queryOne(db,`SELECT count(*) AS n FROM (${unionSql}) e ${filter}`,values)?.n||0);
  return {items,total,limit,offset};
}
function getArtifacts(db, params) {
  const q=boundedText(params.get('q')||'',160).trim();const jobId=boundedText(params.get('jobId')||'',200);const type=boundedText(params.get('type')||'',100);
  const limit=clampInt(params.get('limit'),80,1,MAX_LIST);const offset=clampInt(params.get('offset'),0,0,100_000);
  const where=[];const values=[];
  if(q){where.push('(a.artifact_id LIKE ? OR a.job_id LIKE ? OR a.kind LIKE ? OR a.producer_role LIKE ? OR a.content_hash LIKE ?)');values.push(...Array(5).fill(`%${q}%`));}
  if(jobId){where.push('a.job_id=?');values.push(jobId);} if(type){where.push('a.kind=?');values.push(type);}
  const filter=where.length?`WHERE ${where.join(' AND ')}`:'';
  const rows=queryRows(db,`SELECT a.artifact_id,a.job_id,a.task_id,a.kind,a.uri,substr(a.metadata_json,1,4001) AS metadata_json,a.created_at,a.schema_version,a.producer_role,length(a.content) AS content_size,substr(a.evidence_json,1,8001) AS evidence_json,a.status,a.supersedes,a.content_hash,
      CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.custom_role_id') END AS producer_custom_role_id,
      CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.custom_role_version') END AS producer_custom_role_version,
      CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.custom_role_name') END AS producer_custom_role_name FROM artifacts a LEFT JOIN tasks t ON t.task_id=a.task_id ${filter} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,[...values,limit,offset]);
  const total=Number(queryOne(db,`SELECT count(*) AS n FROM artifacts a ${filter}`,values)?.n||0);
  return {items:rows.map(x=>mapArtifact(x,false)),total,limit,offset};
}
function allowedSegments(relative) {
  if (typeof relative !== 'string' || relative.length > 1024 || relative.includes('\\') || relative.startsWith('/') || relative.includes('\0')) throw new Error('invalid relative path');
  if (!relative) return [];
  const segments=relative.split('/');
  if (segments.some(s=>!s || s==='.' || s==='..' || s.startsWith('.') || s.length>200 || !/^[\w .@()+,-]+$/.test(s))) throw new Error('invalid path segment');
  return segments;
}
function checkSafeEntry(root, relative, wantDirectory = false) {
  const segments=allowedSegments(relative);
  let candidate=root;
  for (const segment of segments) {
    candidate=path.join(candidate,segment);
    const info=fs.lstatSync(candidate);
    if (info.isSymbolicLink()) throw new Error('symbolic links are not browsable');
    if (!(info.isDirectory() || info.isFile())) throw new Error('unsupported file type');
    if (info.isFile() && FORBIDDEN_FILE_RE.test(segment)) throw new Error('file type is not allowed');
  }
  const real=fs.realpathSync(candidate);
  if (!isWithin(root,real)) throw new Error('path escapes data root');
  const stat=fs.statSync(real);
  if (wantDirectory && !stat.isDirectory()) throw new Error('not a directory');
  return { path: real, stat, segments };
}
function listFiles(dataRoot, relative) {
  const checked=checkSafeEntry(dataRoot,relative,true);
  const entries=fs.readdirSync(checked.path,{withFileTypes:true}).slice(0,1000).map(entry=>{
    if(entry.name.startsWith('.') || !/^[\w .@()+,-]+$/.test(entry.name)) return null;
    const full=path.join(checked.path,entry.name);
    let stat; try { stat=fs.lstatSync(full); } catch { return null; }
    if(stat.isSymbolicLink()) return null;
    if(stat.isDirectory()) return {name:entry.name,path:[relative,entry.name].filter(Boolean).join('/'),kind:'directory',size:0,modified_at:stat.mtime.toISOString()};
    if(!stat.isFile() || FORBIDDEN_FILE_RE.test(entry.name) || !SAFE_TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) return null;
    return {name:entry.name,path:[relative,entry.name].filter(Boolean).join('/'),kind:'file',size:stat.size,modified_at:stat.mtime.toISOString()};
  }).filter(Boolean).sort((a,b)=>a.kind===b.kind?a.name.localeCompare(b.name):(a.kind==='directory'?-1:1)).slice(0,200);
  return {path:relative||'',root_label:path.basename(dataRoot),parent:relative?relative.split('/').slice(0,-1).join('/'):null,entries,truncated:entries.length>=200};
}
function previewFile(dataRoot, relative) {
  const checked=checkSafeEntry(dataRoot,relative,false);
  if(!checked.stat.isFile()) throw new Error('preview target is not a file');
  const ext=path.extname(checked.path).toLowerCase();
  if(!SAFE_TEXT_EXTENSIONS.has(ext) || FORBIDDEN_FILE_RE.test(checked.path)) throw new Error('file type is not allowed');
  const flags=fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd=fs.openSync(checked.path,flags);
  try {
    const info=fs.fstatSync(fd);
    if(!info.isFile() || info.dev !== checked.stat.dev || info.ino !== checked.stat.ino) throw new Error('file changed while being checked');
    if(info.size > 50 * 1024 * 1024) throw new Error('file exceeds maximum browse size');
    const buffer=Buffer.alloc(Math.min(info.size,MAX_FILE_BYTES));
    const read=fs.readSync(fd,buffer,0,buffer.length,0);
    const bytes=buffer.subarray(0,read);
    if(bytes.includes(0)) throw new Error('binary files cannot be previewed');
    const text=bytes.toString('utf8');
    if(text.includes('\uFFFD') && !text.startsWith('\uFEFF')) throw new Error('file is not valid UTF-8 text');
    return {path:relative,size:info.size,preview:boundedText(text,MAX_FILE_BYTES),truncated:info.size>read,limit:MAX_FILE_BYTES,modified_at:info.mtime.toISOString()};
  } finally { fs.closeSync(fd); }
}
function gitEnvironment() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^GIT_/i.test(key)) env[key] = value;
  }
  Object.assign(env, {
    GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat'
  });
  return env;
}
function runGit(cwd, args, { timeoutMs = 2_000, maxBuffer = MAX_GIT_OUTPUT_BYTES } = {}) {
  const argv = ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'color.ui=false', ...args];
  const result = spawnSync('git', argv, {
    cwd, env: gitEnvironment(), shell: false, encoding: null,
    timeout: timeoutMs, maxBuffer, windowsHide: true
  });
  if (result.error || result.signal || result.status !== 0) {
    const reason = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM'
      ? 'timeout' : result.error?.code === 'ENOBUFS' ? 'output_limit' : 'git_unavailable';
    return { ok: false, reason, stdout: Buffer.alloc(0) };
  }
  return { ok: true, reason: null, stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '') };
}
function resolveGitWorkspace(filesRoot) {
  const rootResult = runGit(filesRoot, ['rev-parse', '--show-toplevel'], { timeoutMs: 1_000, maxBuffer: 8_192 });
  if (!rootResult.ok) return { available: false, reason: 'not_git_repository' };
  let gitRoot;
  try { gitRoot = fs.realpathSync(rootResult.stdout.toString('utf8').trim()); }
  catch { return { available: false, reason: 'git_root_unavailable' }; }
  if (!fs.statSync(gitRoot).isDirectory() || !isWithin(gitRoot, filesRoot)) {
    return { available: false, reason: 'repository_outside_workspace' };
  }
  const prefix = path.relative(gitRoot, filesRoot).split(path.sep).join('/');
  if (prefix === '..' || prefix.startsWith('../') || path.posix.isAbsolute(prefix)) {
    return { available: false, reason: 'repository_outside_workspace' };
  }
  return { available: true, root: gitRoot, prefix: prefix ? `${prefix.replace(/\/$/, '')}/` : '' };
}
function pathspecForGit(context, relative = '') {
  const combined = `${context.prefix}${relative}`;
  return combined ? `:(top,literal)${combined}` : '.';
}
function statusCode(code) {
  return ({ '.': 'clean', M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type_changed', U: 'conflict' })[code] || 'unknown';
}
function safeGitRelativePath(context, gitPath) {
  if (typeof gitPath !== 'string' || !gitPath) return null;
  let relative = gitPath;
  if (context.prefix) {
    if (!relative.startsWith(context.prefix)) return null;
    relative = relative.slice(context.prefix.length);
  }
  try { allowedSegments(relative); } catch { return null; }
  if (!relative || !SAFE_TEXT_EXTENSIONS.has(path.posix.extname(relative).toLowerCase()) || FORBIDDEN_FILE_RE.test(relative)) return null;
  return relative;
}
function parseGitStatus(output, context) {
  const records = output.toString('utf8').split('\0');
  const entries = [];
  let branch = null;
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;
    if (record.startsWith('# branch.head ')) {
      const name = record.slice('# branch.head '.length);
      branch = name === '(detached)' ? 'detached HEAD' : name;
      continue;
    }
    if (record.startsWith('# ') || record.startsWith('#')) continue;
    let xy = '??';
    let gitPath = '';
    let oldGitPath = null;
    let recordKind = 'ordinary';
    if (record.startsWith('? ')) {
      recordKind = 'untracked';
      gitPath = record.slice(2);
    } else if (record.startsWith('1 ')) {
      const pieces = record.split(' ');
      xy = pieces[1] || '??';
      gitPath = record.split(' ').slice(8).join(' ');
    } else if (record.startsWith('2 ')) {
      recordKind = 'rename';
      const pieces = record.split(' ');
      xy = pieces[1] || '??';
      // Porcelain v2 emits the source path as the next NUL-delimited record.
      gitPath = record.split(' ').slice(9).join(' ');
      oldGitPath = records[i + 1] || null;
      i += 1;
    } else if (record.startsWith('u ')) {
      recordKind = 'unmerged';
      const pieces = record.split(' ');
      xy = pieces[1] || 'UU';
      gitPath = record.split(' ').slice(10).join(' ');
    } else {
      continue;
    }
    const relative = safeGitRelativePath(context, gitPath);
    if (!relative) continue;
    const x = xy[0] || '?';
    const y = xy[1] || '?';
    let kind = 'modified';
    if (recordKind === 'untracked') kind = 'untracked';
    else if (recordKind === 'unmerged' || xy.includes('U') || xy === 'AA' || xy === 'DD') kind = 'conflict';
    else if (x === 'D' || y === 'D') kind = 'deleted';
    else if (recordKind === 'rename' || x === 'R' || y === 'R') kind = 'renamed';
    else if (x === 'A' || y === 'A') kind = 'added';
    else if (x === 'C' || y === 'C') kind = 'copied';
    else if (!/[MTRCDAU]/.test(x + y)) continue;
    let oldPath = null;
    if (oldGitPath) oldPath = safeGitRelativePath(context, oldGitPath);
    entries.push({
      path: relative, index_status: recordKind === 'untracked' ? 'untracked' : statusCode(x),
      worktree_status: recordKind === 'untracked' ? 'untracked' : statusCode(y),
      kind, ...(oldPath ? { old_path: oldPath } : {})
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { branch, entries };
}
function collectGitStatus(filesRoot, relative = '') {
  let checked;
  try { checked = relative ? checkSafeEntry(filesRoot, relative, true) : checkSafeEntry(filesRoot, '', true); }
  catch (error) { return { ok: false, status: 400, reason: 'invalid_workspace_path', details: boundedText(error.message, 200) }; }
  const context = resolveGitWorkspace(filesRoot);
  if (!context.available) return { ok: true, git_available: false, reason: context.reason, branch: null, entries: [], truncated: false };
  const pathspec = pathspecForGit(context, relative);
  const status = runGit(context.root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--no-ahead-behind', '--', pathspec]);
  if (!status.ok) return { ok: true, git_available: false, reason: status.reason, branch: null, entries: [], truncated: false };
  const parsed = parseGitStatus(status.stdout, context);
  const entries = relative
    ? parsed.entries.filter(entry => entry.path === relative || entry.path.startsWith(`${relative.replace(/\/$/, '')}/`))
    : parsed.entries;
  return {
    ok: true, git_available: true, reason: null, branch: parsed.branch,
    entries: entries.slice(0, MAX_GIT_RESPONSE_ENTRIES), truncated: entries.length > MAX_GIT_RESPONSE_ENTRIES,
    generated_at: new Date().toISOString(), context, checked
  };
}
function validateGitFilePath(filesRoot, relative) {
  const segments = allowedSegments(relative);
  if (!segments.length || !SAFE_TEXT_EXTENSIONS.has(path.posix.extname(relative).toLowerCase()) || FORBIDDEN_FILE_RE.test(relative)) {
    throw new Error('file type is not allowed');
  }
  try {
    const checked = checkSafeEntry(filesRoot, relative, false);
    if (!checked.stat.isFile()) throw new Error('preview target is not a file');
    if (checked.stat.size > 50 * 1024 * 1024) throw new Error('file exceeds maximum browse size');
    return { exists: true, checked, segments };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const parent = segments.slice(0, -1).join('/');
    checkSafeEntry(filesRoot, parent, true);
    return { exists: false, checked: null, segments };
  }
}
function makeUntrackedPatch(relative, content) {
  const normalized = String(content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const patch = `diff --git a/${relative} b/${relative}\nnew file mode 100644\n--- /dev/null\n+++ b/${relative}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join('\n')}`;
  return { patch: boundedText(patch, MAX_GIT_DIFF_BYTES), truncated: Buffer.byteLength(patch) > MAX_GIT_DIFF_BYTES };
}
function getPolicies(db, params) {
  const q = boundedText(params.get('q') || '', 120).trim();
  const includeVersions = params.get('versions') === 'all';
  const limit = clampInt(params.get('limit'), 100, 1, 200);
  const hasVersions = dbHasTable(db, 'workflow_policy_versions');
  const hasAttachments = dbHasTable(db, 'workflow_policy_attachments');
  const hasEvents = dbHasTable(db, 'workflow_policy_events');
  if (!hasVersions) return {
    mode: 'read-only registry snapshot', generated_at: new Date().toISOString(), include_versions: includeVersions,
    summary: { policy_count: 0, policy_versions: 0, attachments: 0, audit_events: 0 },
    policies: [], attachments: [], events: [],
    note: 'Policy registry has not been initialized by the MCP runtime yet.'
  };
  const rows = includeVersions
    ? queryRows(db, `SELECT * FROM workflow_policy_versions WHERE (?='' OR instr(lower(policy_id),lower(?))>0 OR instr(lower(name),lower(?))>0 OR instr(lower(description),lower(?))>0) ORDER BY policy_id,version DESC LIMIT ?`, [q, q, q, q, limit])
    : queryRows(db, `SELECT v.* FROM workflow_policy_versions v JOIN (SELECT policy_id,MAX(version) AS version FROM workflow_policy_versions GROUP BY policy_id) latest ON latest.policy_id=v.policy_id AND latest.version=v.version WHERE (?='' OR instr(lower(v.policy_id),lower(?))>0 OR instr(lower(v.name),lower(?))>0 OR instr(lower(v.description),lower(?))>0) ORDER BY v.name COLLATE NOCASE,v.policy_id LIMIT ?`, [q, q, q, q, limit]);
  const policies = rows.map(row => {
    const parsed = parseJson(row.definition_json, 20_000);
    const definition = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? parsed.value : {};
    const integrity = inspectStoredWorkflowPolicyRow(row);
    const safeRule = rule => {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
      const result = {};
      for (const key of ['id','type','description','artifact_type','producer_role','field','task_id','role']) {
        if (typeof rule[key] === 'string') result[key] = redactSensitiveText(boundedText(rule[key], key === 'description' ? 1000 : 100));
      }
      if (['string','number','boolean'].includes(typeof rule.expected)) result.expected = typeof rule.expected === 'string' ? redactSensitiveText(boundedText(rule.expected, 500)) : rule.expected;
      return result;
    };
    const constraints = Array.isArray(definition.constraints) ? definition.constraints.slice(0, 32).map(safeRule).filter(Boolean) : [];
    const successCriteria = Array.isArray(definition.success_criteria) ? definition.success_criteria.slice(0, 32).map(safeRule).filter(Boolean) : [];
    return {
      policy_id: boundedText(row.policy_id, 80), version: Math.max(1, Number(row.version) || 1),
      name: redactSensitiveText(boundedText(row.name, 120)), description: redactSensitiveText(boundedText(row.description, 2000)),
      content_hash: typeof row.content_hash === 'string' && /^[a-f0-9]{64}$/.test(row.content_hash) ? row.content_hash : null,
      created_at: row.created_at, created_by: boundedText(row.created_by, 120),
      schema_version: definition.schema_version === 1 ? 1 : null,
      constraints, success_criteria: successCriteria,
      constraint_count: constraints.length, success_criteria_count: successCriteria.length,
      definition_truncated: parsed.truncated || parsed.malformed,
      validation_status: integrity.validation_status,
      validation_reason: integrity.valid ? null : redactSensitiveText(integrity.reason),
      violation_count: null
    };
  });
  const violationCounts = hasEvents ? queryRows(db,
    "SELECT policy_id,version,COUNT(*) AS n FROM workflow_policy_events WHERE event_type='violation_detected' GROUP BY policy_id,version", []).reduce((result, row) => {
      result[`${row.policy_id}@${row.version}`] = Number(row.n) || 0;
      return result;
    }, Object.create(null)) : Object.create(null);
  for (const policy of policies) policy.violation_count = violationCounts[`${policy.policy_id}@${policy.version}`] || 0;
  let attachments = [];
  if (hasAttachments) {
    const sql = `SELECT a.job_id,a.policy_id,a.version,a.content_hash,a.attached_at,a.attached_by,j.title AS job_title,j.state AS job_state,j.status AS job_status,
      v.policy_id AS version_policy_id,v.version AS stored_policy_version,v.name AS policy_name,v.description AS policy_description,
      v.definition_json AS policy_definition_json,v.content_hash AS policy_version_content_hash,v.created_at AS policy_created_at,v.created_by AS policy_created_by
      FROM workflow_policy_attachments a LEFT JOIN jobs j ON j.job_id=a.job_id
      LEFT JOIN workflow_policy_versions v ON v.policy_id=a.policy_id AND v.version=a.version
      WHERE (?='' OR instr(lower(a.policy_id),lower(?))>0 OR instr(lower(v.name),lower(?))>0 OR instr(lower(j.title),lower(?))>0 OR instr(lower(a.job_id),lower(?))>0)
      ORDER BY a.attached_at DESC,a.job_id LIMIT ?`;
    attachments = queryRows(db, sql, [q, q, q, q, q, limit]).map(row => {
      const integrity = row.version_policy_id ? inspectStoredWorkflowPolicyRow({
        policy_id: row.version_policy_id, version: row.stored_policy_version, name: row.policy_name,
        description: row.policy_description, definition_json: row.policy_definition_json,
        content_hash: row.policy_version_content_hash, created_at: row.policy_created_at, created_by: row.policy_created_by
      }) : { valid: false, validation_status: 'invalid', reason: 'pinned policy version is missing' };
      const pinMatches = integrity.valid && row.content_hash === row.policy_version_content_hash;
      return {
        job_id: boundedText(row.job_id, 200), policy_id: boundedText(row.policy_id, 80), version: Math.max(1, Number(row.version) || 1),
        content_hash: typeof row.content_hash === 'string' && /^[a-f0-9]{64}$/.test(row.content_hash) ? row.content_hash : null,
        name: redactSensitiveText(boundedText(row.policy_name || row.policy_id, 120)), attached_at: row.attached_at, attached_by: boundedText(row.attached_by, 120),
        job_title: redactSensitiveText(boundedText(row.job_title || row.job_id, 180)), job_state: boundedText(row.job_state || 'unknown', 40), job_status: boundedText(row.job_status || 'unknown', 40),
        validation_status: pinMatches ? 'valid' : 'invalid',
        validation_reason: pinMatches ? null : redactSensitiveText(integrity.reason || 'attachment hash does not match its pinned policy version')
      };
    });
  }
  const events = hasEvents ? queryRows(db,
    `SELECT event_id,policy_id,version,event_type,payload_json,created_at,created_by FROM workflow_policy_events
      WHERE (?='' OR instr(lower(policy_id),lower(?))>0) ORDER BY created_at DESC LIMIT ?`, [q, q, Math.min(limit, 100)]).map(row => ({
        event_id: boundedText(row.event_id, 80), policy_id: boundedText(row.policy_id, 80), version: Number.isSafeInteger(Number(row.version)) ? Number(row.version) : null,
        event_type: boundedText(row.event_type, 80), payload: redactPolicyEventPayload(parseJson(row.payload_json, 3000).value),
        created_at: row.created_at, created_by: boundedText(row.created_by, 120)
      })) : [];
  return {
    mode: 'read-only registry snapshot', generated_at: new Date().toISOString(), include_versions: includeVersions,
    summary: {
      policy_count: Number(queryOne(db, 'SELECT COUNT(DISTINCT policy_id) n FROM workflow_policy_versions')?.n || 0),
      policy_versions: tableCount(db, 'workflow_policy_versions'),
      attachments: tableCount(db, 'workflow_policy_attachments'),
      audit_events: tableCount(db, 'workflow_policy_events'),
      recorded_violations: hasEvents
        ? Number(queryOne(db, "SELECT COUNT(*) AS n FROM workflow_policy_events WHERE event_type='violation_detected'")?.n || 0)
        : 0
    },
    policies, attachments, events,
    enforcement_note: 'Stored rules use a closed JSON predicate catalog. Runtime enforcement is independent at immutable-plan validation and synthesis/terminalization; this dashboard is read-only and does not validate or change rules.'
  };
}
function redactPolicyEventPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const key of ['job_id','policy_id','policy_version','version','content_hash','policy_content_hash','plan_hash','predicate_id','predicate_type','reason','previous_version']) {
    const item = value[key];
    if (typeof item === 'string') result[key] = redactSensitiveText(boundedText(item, key === 'reason' ? 1000 : 200));
    else if (typeof item === 'number' && Number.isSafeInteger(item)) result[key] = item;
  }
  return result;
}
function requestHostOk(req, expectedHost, port) {
  const host = req.headers.host || '';
  if (host.toLowerCase() !== expectedHost.toLowerCase()) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      const parsed = new URL(origin);
      const originHost = parsed.hostname.replace(/^\[|\]$/g, '');
      if (parsed.protocol !== 'http:' || !onlyLoopback(originHost) || Number(parsed.port || 80) !== Number(port) || parsed.username || parsed.password) return false;
    } catch { return false; }
  }
  return true;
}

export function createDashboardServer(options = {}) {
  const host = options.host ?? '127.0.0.1';
  if (!onlyLoopback(host)) throw new Error('dashboard host must be 127.0.0.1 or ::1');
  const port = options.port ?? clampInt(process.env.RUNALITH_DASHBOARD_PORT || process.env.CHAT_ON_STEROIDS_DASHBOARD_PORT, 8318, 1, 65535);
  const dataRoot = resolveDataDir(options.dataDir || DEFAULT_DATA_DIR);
  const dbPath = path.resolve(options.dbPath || DEFAULT_DB_PATH);
  const configuredFilesRoot = options.filesRoot
    || process.env.RUNALITH_DASHBOARD_FILES_ROOT
    || process.env.CHAT_ON_STEROIDS_DASHBOARD_FILES_ROOT
    || (options.dataDir ? dataRoot : process.cwd());
  const filesRoot = resolveDataDir(configuredFilesRoot);
  let db = null;
  let dbError = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, enableForeignKeyConstraints: true });
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
  } catch (error) { dbError = boundedText(error?.message || error, 600); }
  const publicRoot = path.resolve(options.publicDir || path.join(path.dirname(fileURLToPath(import.meta.url)), 'public'));
  const expectedHost = host.includes(':') ? `[${host}]` : host;
  const server = http.createServer((req,res)=>{
    const headers = noStoreHeaders();
    for(const [key,value] of Object.entries(headers)) res.setHeader(key,value);
    if (Buffer.byteLength(req.url || '') > MAX_URL_BYTES) return sendJson(res,414,{error:'request URL too long'});
    const actualPort = server.address()?.port || port;
    if (!requestHostOk(req, `${expectedHost}:${actualPort}`, actualPort)) return sendJson(res,403,{error:'untrusted host or origin'});
    if (req.method !== 'GET') return sendJson(res,405,{error:'read-only dashboard accepts GET only'});
    let url; try { url = new URL(req.url || '/', `http://${expectedHost}:${actualPort}`); } catch { return sendJson(res,400,{error:'invalid URL'}); }
    const route = url.pathname;
    if (route.startsWith('/api/')) {
      if (!db) return sendJson(res,503,{error:'workflow database is unavailable',details:dbError,read_only:true});
      try {
        let payload;
        if (route === '/api/health') payload = { status:'ok', database:'connected', database_path:path.basename(dbPath), data_root:path.basename(dataRoot), files_root:path.basename(filesRoot), mode:'local-read-only', read_only:true, host, port:server.address()?.port || port };
        else if (route === '/api/overview') payload = getOverview(db);
        else if (route === '/api/agg/runs') payload = getAggPlannerRuns(db, url.searchParams);
        else if (route.startsWith('/api/agg/runs/')) {
          let suffix;
          try { suffix = decodeURIComponent(route.slice('/api/agg/runs/'.length)); }
          catch { return sendJson(res,400,{error:'invalid AGG run id encoding',read_only:true}); }
          const eventSuffix = '/events';
          const isEvents = suffix.endsWith(eventSuffix);
          const runId = isEvents ? suffix.slice(0,-eventSuffix.length) : suffix;
          if (!/^[a-f0-9-]{36}$/i.test(runId)) return sendJson(res,400,{error:'invalid AGG run id',read_only:true});
          if (isEvents) {
            payload = getAggPlannerRunEvents(db,runId,url.searchParams);
            if (!payload) return sendJson(res,404,{error:'AGG planner run not found or telemetry schema is unavailable',read_only:true});
          } else {
            payload = getAggPlannerRunDetail(db,runId);
            if (!payload) return sendJson(res,404,{error:'AGG planner run not found or telemetry schema is unavailable',read_only:true});
          }
        }
        else if (route === '/api/agg/graph') payload = getAggGraph(db, url.searchParams);
        else if (route.startsWith('/api/agg/nodes/')) {
          let id;
          try { id = decodeURIComponent(route.slice('/api/agg/nodes/'.length)); }
          catch { return sendJson(res,400,{error:'invalid AGG node id encoding'}); }
          if (!id || id.includes('/') || id.length > 128) return sendJson(res,400,{error:'invalid AGG node id'});
          const rawRevision = url.searchParams.get('revision');
          const requestedRevision = rawRevision === null ? null : Number(rawRevision);
          if (rawRevision !== null && (!Number.isSafeInteger(requestedRevision) || requestedRevision < 1)) return sendJson(res,400,{error:'revision must be a positive integer'});
          payload = getAggNodeDetail(db,id,requestedRevision); if (!payload) return sendJson(res,404,{error:'AGG node/revision not found or knowledge graph is not initialized'});
        }
        else if (route === '/api/roles') payload = getRoles(db,url.searchParams);
        else if (route === '/api/policies') payload = getPolicies(db,url.searchParams);
        else if (route === '/api/batches') payload = getBatches(db,url.searchParams);
        else if (route === '/api/jobs') payload = getJobs(db,url.searchParams);
        else if (route.startsWith('/api/jobs/')) {
          const id = decodeURIComponent(route.slice('/api/jobs/'.length));
          if (!id || id.includes('/')) return sendJson(res,400,{error:'invalid job id'});
          payload = getJobDetail(db,id); if (!payload) return sendJson(res,404,{error:'job not found'});
        } else if (route === '/api/events') payload = getEvents(db,url.searchParams);
        else if (route === '/api/artifacts') payload = getArtifacts(db,url.searchParams);
        else if (route.startsWith('/api/artifacts/')) {
          const id=decodeURIComponent(route.slice('/api/artifacts/'.length));
          const row=queryOne(db,"SELECT a.artifact_id,a.job_id,a.task_id,a.kind,a.uri,substr(a.metadata_json,1,4001) AS metadata_json,a.created_at,a.schema_version,a.producer_role,substr(a.content,1,48001) AS content,length(a.content) AS content_size,substr(a.evidence_json,1,8001) AS evidence_json,a.status,a.supersedes,a.content_hash,CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.custom_role_id') END AS producer_custom_role_id,CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.custom_role_version') END AS producer_custom_role_version,CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.custom_role_name') END AS producer_custom_role_name FROM artifacts a LEFT JOIN tasks t ON t.task_id=a.task_id WHERE a.artifact_id=?",[id]);
          if(!row) return sendJson(res,404,{error:'artifact not found'}); payload=mapArtifact(row,true);
        } else if (route === '/api/git/status') {
          const result = collectGitStatus(filesRoot, url.searchParams.get('path') || '');
          if (!result.ok) return sendJson(res, result.status || 400, { error: 'Git status could not be read', reason: result.reason, details: result.details });
          payload = {
            git_available: result.git_available, reason: result.reason,
            root_label: path.basename(filesRoot), branch: result.branch,
            entries: result.entries, truncated: result.truncated, generated_at: result.generated_at || new Date().toISOString()
          };
        } else if (route === '/api/git/diff') {
          const relative = url.searchParams.get('path') || '';
          const mode = url.searchParams.get('mode') || 'working-tree';
          if (!['working-tree', 'staged', 'unstaged'].includes(mode)) return sendJson(res, 400, { error: 'invalid Git diff mode' });
          let fileInfo;
          try { fileInfo = validateGitFilePath(filesRoot, relative); }
          catch (error) { return sendJson(res, 403, { error: 'Git diff denied', details: boundedText(error.message, 240) }); }
          const context = resolveGitWorkspace(filesRoot);
          if (!context.available) {
            payload = { git_available: false, reason: context.reason, path: relative, mode, status: 'unavailable', patch: '', truncated: false };
          } else {
            const gitPath = `${context.prefix}${relative}`;
            const pathspec = `:(top,literal)${gitPath}`;
            const statusResult = runGit(context.root, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-ahead-behind', '--', pathspec]);
            if (!statusResult.ok) return sendJson(res, 200, { git_available: false, reason: statusResult.reason, path: relative, mode, status: 'unavailable', patch: '', truncated: false });
            const status = parseGitStatus(statusResult.stdout, context).entries.find(entry => entry.path === relative);
            if (status?.kind === 'untracked' && mode === 'working-tree' && fileInfo.exists) {
              const preview = previewFile(filesRoot, relative);
              const untrackedPatch = makeUntrackedPatch(relative, preview.preview);
              payload = { git_available: true, path: relative, mode, status: 'untracked', patch: untrackedPatch.patch, truncated: untrackedPatch.truncated || preview.truncated };
            } else {
              const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color'];
              if (mode === 'staged') args.push('--cached', 'HEAD');
              else if (mode === 'working-tree') args.push('HEAD');
              args.push('--', pathspec);
              const diffResult = runGit(context.root, args, { timeoutMs: 2_500, maxBuffer: MAX_GIT_OUTPUT_BYTES });
              if (!diffResult.ok) {
                payload = { git_available: true, path: relative, mode, status: status?.kind || 'unavailable', patch: '', truncated: false, reason: diffResult.reason };
              } else {
                const rawPatch = diffResult.stdout.toString('utf8');
                payload = { git_available: true, path: relative, mode, status: status?.kind || (fileInfo.exists ? 'clean' : 'deleted'), patch: boundedText(rawPatch, MAX_GIT_DIFF_BYTES), truncated: Buffer.byteLength(rawPatch) > MAX_GIT_DIFF_BYTES };
              }
            }
          }
        } else if (route === '/api/files') {
          try { payload=listFiles(filesRoot,url.searchParams.get('path')||''); }
          catch(error) { return sendJson(res,400,{error:'directory cannot be browsed',details:boundedText(error.message,300)}); }
        } else if (route === '/api/files/preview') {
          try { const filePath=url.searchParams.get('path')||''; if(!filePath) return sendJson(res,400,{error:'path is required'}); payload=previewFile(filesRoot,filePath); }
          catch(error) { return sendJson(res,403,{error:'file preview denied',details:boundedText(error.message,300)}); }
        } else return sendJson(res,404,{error:'API route not found'});
        return sendJson(res,200,payload);
      } catch (error) {
        return sendJson(res,500,{error:'dashboard query failed',details:boundedText(error?.message||error,300)});
      }
    }
    const assets = new Map([['/','index.html'],['/index.html','index.html'],['/styles.css','styles.css'],['/ux-overrides.css','ux-overrides.css'],['/dashboard-overhaul.css','dashboard-overhaul.css'],['/app.js','app.js'],['/workbench.css','workbench.css'],['/workbench.js','workbench.js']]);
    const asset = assets.get(route);
    if (!asset) return sendJson(res,404,{error:'not found'});
    try {
      const filePath=path.join(publicRoot,asset); const real=fs.realpathSync(filePath);
      if(!isWithin(publicRoot,real) || !fs.statSync(real).isFile()) return sendJson(res,404,{error:'not found'});
      const body=fs.readFileSync(real);
      res.writeHead(200,{...headers,'content-type':MIME[path.extname(real)]||'application/octet-stream','content-length':body.length});
      return res.end(req.method==='HEAD'?undefined:body);
    } catch { return sendJson(res,500,{error:'dashboard asset unavailable'}); }
  });
  return {
    server, dbPath, dataRoot, filesRoot, host, port,
    listen:()=>new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(port,host,()=>{server.off('error',reject);resolve(server.address());});
    }),
    close:()=>new Promise(resolve=>{
      const done=()=>{try{db?.close();}catch{} resolve();};
      if(server.listening) server.close(done); else done();
    })
  };
}

async function main() {
  const rawHost=process.env.RUNALITH_DASHBOARD_HOST || process.env.CHAT_ON_STEROIDS_DASHBOARD_HOST || '127.0.0.1';
  if(!onlyLoopback(rawHost)) throw new Error('RUNALITH_DASHBOARD_HOST must be 127.0.0.1 or ::1; non-loopback dashboards are disabled');
  const app=createDashboardServer({host:rawHost});
  const address=await app.listen();
  const shownHost=rawHost.includes(':')?`[${rawHost}]`:rawHost;
  console.log(`Runalith Dashboard: http://${shownHost}:${address.port}`);
  console.log(`Database: ${app.dbPath}`);
  console.log('Mode: read-only; loopback only. Press Ctrl+C to stop.');
  const stop=async()=>{await app.close();process.exit(0);};
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error=>{console.error(`dashboard startup failed: ${error.message}`);process.exitCode=1;});
}
