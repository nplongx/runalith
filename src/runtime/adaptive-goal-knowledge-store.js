import { createHash } from 'node:crypto';

export const KNOWLEDGE_NODE_TYPES = Object.freeze(['goal', 'hypothesis', 'idea', 'capability', 'experiment', 'evidence', 'condition']);
export const KNOWLEDGE_EDGE_TYPES = Object.freeze(['supports', 'tested_by', 'enables', 'contradicts', 'alternative_to', 'recovers_to', 'depends_on', 'requires_all']);
const NODE_TYPES = new Set(KNOWLEDGE_NODE_TYPES);
const EDGE_TYPES = new Set(KNOWLEDGE_EDGE_TYPES);
const MAX_JSON_BYTES = 64 * 1024;
const MAX_SNAPSHOT_JSON_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_REVISIONS = 5000;
const MAX_EDGES = 10000;

function fail(message) { throw new TypeError(`AdaptiveGoalKnowledgeStore: ${message}`); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, allowed, field) {
  if (!record(value)) fail(`${field} must be an object`);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) fail(`${field} contains unsupported fields: ${unknown.sort().join(', ')}`);
}
function text(value, field, max = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`${field} must be a non-empty string up to ${max} characters`);
  return value.trim();
}
function canonicalize(value, depth = 0) {
  if (depth > 32) fail('JSON content exceeds maximum nesting depth');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('JSON content numbers must be finite');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(item => canonicalize(item, depth + 1));
  if (!record(value)) fail('content must contain only JSON values');
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (key === '__proto__') fail('content contains a forbidden key');
    Object.defineProperty(result, key, { value: canonicalize(value[key], depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return result;
}
function canonicalJson(value, field) {
  const json = JSON.stringify(canonicalize(value));
  if (Buffer.byteLength(json, 'utf8') > MAX_JSON_BYTES) fail(`${field} exceeds ${MAX_JSON_BYTES} bytes`);
  return json;
}
function canonicalSnapshotJson(value) {
  const json = JSON.stringify(canonicalize(value));
  if (Buffer.byteLength(json, 'utf8') > MAX_SNAPSHOT_JSON_BYTES) {
    const error = new Error(`Goal/Idea snapshot exceeds ${MAX_SNAPSHOT_JSON_BYTES} bytes`);
    error.code = 'KNOWLEDGE_SNAPSHOT_SIZE_LIMIT_EXCEEDED';
    throw error;
  }
  return json;
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function provenanceJson(value, field = 'provenance') {
  exactKeys(value, ['source', 'actor', 'reference', 'note'], field);
  return canonicalJson({
    source: text(value.source, `${field}.source`, 512),
    actor: text(value.actor, `${field}.actor`, 200),
    ...(value.reference === undefined ? {} : { reference: text(value.reference, `${field}.reference`, 2048) }),
    ...(value.note === undefined ? {} : { note: text(value.note, `${field}.note`, 2000) })
  }, field);
}
function parseRow(row, memberships = []) {
  if (!row) return null;
  const provenance = JSON.parse(row.provenance_json);
  const verified = false; // No verifier path is implemented; callers cannot elevate this signal.
  return {
    id: row.id, stableKey: row.stable_key, type: row.type, revision: row.revision,
    content: JSON.parse(row.content_json), evidenceRefs: JSON.parse(row.evidence_refs_json), contentHash: row.content_hash,
    status: row.status, verified, usableForPlanning: verified,
    provenance, provenanceHash: hash(row.provenance_json), memberships,
    createdAt: row.created_at
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS adaptive_goal_knowledge_nodes (
  id TEXT PRIMARY KEY, stable_key TEXT NOT NULL, type TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK(current_revision >= 1), created_at TEXT NOT NULL,
  UNIQUE(type, stable_key)
);
CREATE TABLE IF NOT EXISTS adaptive_goal_knowledge_memberships (
  node_id TEXT NOT NULL REFERENCES adaptive_goal_knowledge_nodes(id), goal_id TEXT NOT NULL,
  created_at TEXT NOT NULL, provenance_json TEXT, PRIMARY KEY(node_id, goal_id)
);
CREATE TABLE IF NOT EXISTS adaptive_goal_knowledge_revisions (
  node_id TEXT NOT NULL REFERENCES adaptive_goal_knowledge_nodes(id), revision INTEGER NOT NULL CHECK(revision >= 1),
  content_json TEXT NOT NULL, evidence_refs_json TEXT NOT NULL, content_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status = 'unverified'),
  provenance_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(node_id, revision)
);
CREATE TABLE IF NOT EXISTS adaptive_goal_knowledge_edges (
  edge_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, from_id TEXT NOT NULL REFERENCES adaptive_goal_knowledge_nodes(id),
  to_id TEXT NOT NULL REFERENCES adaptive_goal_knowledge_nodes(id), type TEXT NOT NULL,
  condition_json TEXT, outcome_json TEXT, evidence_refs_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(goal_id, from_id, to_id, type, condition_json, outcome_json)
);
CREATE TABLE IF NOT EXISTS adaptive_goal_knowledge_verifications (
  attestation_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
  provider_id TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
  configuration_fingerprint TEXT, trust_key_id TEXT, trust_config_version INTEGER,
  configuration_source TEXT, config_change_reference TEXT,
  UNIQUE(goal_id, snapshot_hash, attestation_id)
);
CREATE INDEX IF NOT EXISTS adaptive_goal_knowledge_verification_latest ON adaptive_goal_knowledge_verifications(goal_id,snapshot_hash,created_at);
CREATE INDEX IF NOT EXISTS adaptive_goal_knowledge_membership_goal ON adaptive_goal_knowledge_memberships(goal_id, node_id);
CREATE INDEX IF NOT EXISTS adaptive_goal_knowledge_edge_goal ON adaptive_goal_knowledge_edges(goal_id, type);
CREATE TRIGGER IF NOT EXISTS adaptive_goal_knowledge_memberships_no_update BEFORE UPDATE ON adaptive_goal_knowledge_memberships BEGIN SELECT RAISE(ABORT, 'knowledge memberships are append-only'); END;
CREATE TRIGGER IF NOT EXISTS adaptive_goal_knowledge_memberships_no_delete BEFORE DELETE ON adaptive_goal_knowledge_memberships BEGIN SELECT RAISE(ABORT, 'knowledge memberships are append-only'); END;
CREATE TRIGGER IF NOT EXISTS adaptive_goal_knowledge_revisions_no_update BEFORE UPDATE ON adaptive_goal_knowledge_revisions BEGIN SELECT RAISE(ABORT, 'knowledge history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS adaptive_goal_knowledge_revisions_no_delete BEFORE DELETE ON adaptive_goal_knowledge_revisions BEGIN SELECT RAISE(ABORT, 'knowledge history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS adaptive_goal_knowledge_edges_no_update BEFORE UPDATE ON adaptive_goal_knowledge_edges BEGIN SELECT RAISE(ABORT, 'knowledge edges are append-only'); END;
CREATE TRIGGER IF NOT EXISTS adaptive_goal_knowledge_edges_no_delete BEFORE DELETE ON adaptive_goal_knowledge_edges BEGIN SELECT RAISE(ABORT, 'knowledge edges are append-only'); END;
CREATE TRIGGER IF NOT EXISTS adaptive_goal_knowledge_verifications_no_update BEFORE UPDATE ON adaptive_goal_knowledge_verifications BEGIN SELECT RAISE(ABORT, 'knowledge verifications are append-only'); END;
CREATE TRIGGER IF NOT EXISTS adaptive_goal_knowledge_verifications_no_delete BEFORE DELETE ON adaptive_goal_knowledge_verifications BEGIN SELECT RAISE(ABORT, 'knowledge verifications are append-only'); END;
`;

/** Create an append-only knowledge store over an injected node:sqlite DatabaseSync. */
export function createAdaptiveGoalKnowledgeStore(db) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') fail('db must be an injected DatabaseSync-compatible connection');
  db.exec(SCHEMA);
  const statement = sql => db.prepare(sql);
  const verificationColumns = new Set(statement('PRAGMA table_info(adaptive_goal_knowledge_verifications)').all().map(row => row.name));
  // The appended audit metadata records which administrator-provisioned trust
  // configuration and key ID accepted a signature. Historical rows stay
  // untouched and nullable when opened by an upgraded runtime.
  for (const [column, definition] of [
    ['configuration_fingerprint', 'TEXT'], ['trust_key_id', 'TEXT'], ['trust_config_version', 'INTEGER'],
    ['configuration_source', 'TEXT'], ['config_change_reference', 'TEXT']
  ]) {
    if (!verificationColumns.has(column)) db.exec(`ALTER TABLE adaptive_goal_knowledge_verifications ADD COLUMN ${column} ${definition}`);
  }
  const membershipColumns = new Set(statement('PRAGMA table_info(adaptive_goal_knowledge_memberships)').all().map(row => row.name));
  // Older stores predate explicit membership provenance. Do not backfill it
  // from a node revision: that would manufacture provenance for an old edge
  // of the graph. A legacy NULL membership remains un-verifiable until a new
  // node identity/membership is authored with explicit provenance.
  if (!membershipColumns.has('provenance_json')) {
    db.exec('ALTER TABLE adaptive_goal_knowledge_memberships ADD COLUMN provenance_json TEXT');
  }
  const currentById = statement(`SELECT n.id,n.stable_key,n.type,n.current_revision AS revision,r.content_json,r.evidence_refs_json,r.content_hash,r.status,r.provenance_json,r.created_at
    FROM adaptive_goal_knowledge_nodes n JOIN adaptive_goal_knowledge_revisions r ON r.node_id=n.id AND r.revision=n.current_revision WHERE n.id=?`);
  const currentByStable = statement(`SELECT n.id,n.stable_key,n.type,n.current_revision AS revision,r.content_json,r.evidence_refs_json,r.content_hash,r.status,r.provenance_json,r.created_at
    FROM adaptive_goal_knowledge_nodes n JOIN adaptive_goal_knowledge_revisions r ON r.node_id=n.id AND r.revision=n.current_revision WHERE n.type=? AND n.stable_key=?`);
  const membershipsFor = id => statement('SELECT goal_id FROM adaptive_goal_knowledge_memberships WHERE node_id=? ORDER BY goal_id').all(id).map(row => row.goal_id);
  const get = id => parseRow(currentById.get(id), membershipsFor(id));

  function ensureMembership(nodeId, goalId, provenance, { rejectLegacy = true, rejectDifferent = true } = {}) {
    const existingMembership = statement('SELECT provenance_json FROM adaptive_goal_knowledge_memberships WHERE node_id=? AND goal_id=?').get(nodeId, goalId);
    if (existingMembership) {
      if (existingMembership.provenance_json === null || existingMembership.provenance_json === undefined) {
        if (rejectLegacy) fail(`membership ${nodeId}/${goalId} has no explicit provenance and cannot be promoted to verified knowledge`);
      } else if (rejectDifferent && existingMembership.provenance_json !== provenance) {
        fail(`membership ${nodeId}/${goalId} already exists with different immutable provenance`);
      }
      return false;
    }
    statement('INSERT INTO adaptive_goal_knowledge_memberships(node_id,goal_id,created_at,provenance_json) VALUES(?,?,?,?)')
      .run(nodeId, goalId, new Date().toISOString(), provenance);
    return true;
  }

  function saveNode(input) {
    exactKeys(input, ['goalId', 'stableKey', 'type', 'content', 'provenance', 'expectedRevision', 'evidenceRefs'], 'node');
    const goalId = text(input.goalId, 'goalId', 200);
    const stableKey = text(input.stableKey, 'stableKey', 200);
    if (!NODE_TYPES.has(input.type)) fail(`type must be one of ${KNOWLEDGE_NODE_TYPES.join(', ')}`);
    if (!Object.hasOwn(input, 'content')) fail('content is required');
    const contentJson = canonicalJson(input.content, 'content');
    const provenance = provenanceJson(input.provenance);
    const evidenceRefs = input.evidenceRefs === undefined ? [] : input.evidenceRefs;
    if (!Array.isArray(evidenceRefs) || evidenceRefs.length > 64) fail('evidenceRefs must be an array with at most 64 entries');
    const normalizedRefs = [...new Set(evidenceRefs.map((ref, i) => text(ref, `evidenceRefs[${i}]`, 2048)))].sort();
    const evidenceRefsJson = canonicalJson(normalizedRefs, 'evidenceRefs');
    // Pin refs into the revision hash, but never interpret caller-supplied refs as verified evidence.
    const contentHash = hash(canonicalJson({ content: JSON.parse(contentJson), evidenceRefs: normalizedRefs }, 'revision content'));
    const id = `agk-${hash(`${input.type}\0${stableKey}`).slice(0, 40)}`;
    const expected = input.expectedRevision === undefined ? 0 : input.expectedRevision;
    if (!Number.isSafeInteger(expected) || expected < 0) fail('expectedRevision must be a non-negative safe integer');
    const existing = currentByStable.get(input.type, stableKey);
    if (!existing && expected !== 0) throw revisionConflict(expected, 0);
    if (existing && existing.revision !== expected) {
      // Adding a membership for an already identical concept does not create a revision.
      if (existing.content_hash !== contentHash || existing.provenance_json !== provenance || expected !== 0) throw revisionConflict(expected, existing.revision);
    }
    if (existing && existing.content_hash === contentHash && existing.provenance_json === provenance) {
      db.exec('BEGIN IMMEDIATE');
      try {
        ensureMembership(existing.id, goalId, provenance);
        db.exec('COMMIT');
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
      return get(existing.id);
    }
    if (existing && existing.revision !== expected) throw revisionConflict(expected, existing.revision);
    const now = new Date().toISOString();
    const nextRevision = expected + 1;
    db.exec('BEGIN IMMEDIATE');
    try {
      const locked = currentByStable.get(input.type, stableKey);
      if ((locked?.revision ?? 0) !== expected) throw revisionConflict(expected, locked?.revision ?? 0);
      if (!locked) statement('INSERT INTO adaptive_goal_knowledge_nodes(id,stable_key,type,current_revision,created_at) VALUES(?,?,?,1,?)').run(id, stableKey, input.type, now);
      else statement('UPDATE adaptive_goal_knowledge_nodes SET current_revision=? WHERE id=? AND current_revision=?').run(nextRevision, id, expected);
      if (!locked) ensureMembership(id, goalId, provenance);
      else {
        const hasMembership = statement('SELECT 1 AS present FROM adaptive_goal_knowledge_memberships WHERE node_id=? AND goal_id=?').get(id, goalId);
        if (!hasMembership) ensureMembership(id, goalId, provenance);
      }
      statement(`INSERT INTO adaptive_goal_knowledge_revisions(node_id,revision,content_json,evidence_refs_json,content_hash,status,provenance_json,created_at)
        VALUES(?,?,?,?,?,'unverified',?,?)`).run(id, nextRevision, contentJson, evidenceRefsJson, contentHash, provenance, now);
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    return get(id);
  }

  function revisionConflict(expected, current) {
    const error = new Error(`revision conflict: expected ${expected}, current ${current}`);
    error.code = 'ERR_KNOWLEDGE_REVISION_CONFLICT'; error.expectedRevision = expected; error.currentRevision = current;
    return error;
  }

  function addEdge(input) {
    exactKeys(input, ['goalId', 'fromId', 'toId', 'type', 'provenance', 'condition', 'outcome', 'evidenceRefs'], 'edge');
    const goalId = text(input.goalId, 'goalId', 200);
    const fromId = text(input.fromId, 'fromId', 128);
    const toId = text(input.toId, 'toId', 128);
    if (!EDGE_TYPES.has(input.type)) fail(`type must be one of ${KNOWLEDGE_EDGE_TYPES.join(', ')}`);
    if (fromId === toId) fail('self-referencing edges are forbidden');
    const provenance = provenanceJson(input.provenance);
    let conditionJson = null; let outcomeJson = null;
    if (input.type === 'recovers_to') {
      if (!Object.hasOwn(input, 'condition') || !Object.hasOwn(input, 'outcome')) fail('recovers_to requires condition and outcome contracts');
      exactKeys(input.condition, ['when', 'predicate'], 'condition');
      exactKeys(input.outcome, ['state', 'effects', 'evidenceRefs'], 'outcome');
      if (!['failed', 'blocked', 'verification_failed', 'evidence_missing', 'contradicted'].includes(input.condition.when)) {
        fail('condition.when must be a supported observed outcome');
      }
      if (!['required_evidence_available', 'verification_failed_with_evidence'].includes(input.condition.predicate)) {
        fail('condition.predicate must be a supported non-executable recovery predicate');
      }
      if (typeof input.outcome.state !== 'string' || !input.outcome.state.trim()) fail('outcome.state is required');
      if (!Array.isArray(input.outcome.effects) || input.outcome.effects.length > 32 || input.outcome.effects.some(v => typeof v !== 'string' || !v.trim())) fail('outcome.effects must be an array of at most 32 non-empty strings');
      if (!Array.isArray(input.outcome.evidenceRefs) || input.outcome.evidenceRefs.length < 1 || input.outcome.evidenceRefs.length > 64 || input.outcome.evidenceRefs.some(v => typeof v !== 'string' || !v.trim())) fail('outcome.evidenceRefs must list at least one explicit source evidence reference');
      conditionJson = canonicalJson(input.condition, 'condition'); outcomeJson = canonicalJson(input.outcome, 'outcome');
    } else if (input.condition !== undefined || input.outcome !== undefined) fail('condition/outcome contracts are only valid for recovers_to edges');
    const refs = input.evidenceRefs === undefined ? [] : input.evidenceRefs;
    if (!Array.isArray(refs) || refs.length > 64 || refs.some(ref => typeof ref !== 'string' || !ref.trim() || ref.length > 2048)) fail('evidenceRefs must be an array of at most 64 explicit non-empty references');
    const normalizedRefs = [...new Set(refs.map(ref => ref.trim()))].sort();
    const fromNode = currentById.get(fromId);
    const toNode = currentById.get(toId);
    if (!fromNode || !toNode) fail('edge references unknown nodes');
    if (input.type === 'tested_by' && !(['hypothesis', 'idea'].includes(fromNode.type) && toNode.type === 'experiment')) {
      fail('tested_by must connect a hypothesis/idea node to an experiment node');
    }
    if (input.type === 'supports' && !(['hypothesis', 'idea', 'capability', 'experiment', 'evidence', 'goal'].includes(fromNode.type) &&
        ['hypothesis', 'idea', 'capability', 'condition', 'experiment', 'goal'].includes(toNode.type))) {
      fail('supports must connect an explanatory/capability/evidence source to a target concept');
    }
    if (input.type === 'enables' && !(['hypothesis', 'idea', 'capability', 'experiment', 'evidence', 'goal'].includes(fromNode.type) &&
        ['idea', 'capability', 'condition', 'experiment', 'goal'].includes(toNode.type))) {
      fail('enables must connect a capability/idea/experiment/evidence source to a target concept or experiment');
    }
    if (input.type === 'recovers_to' && !(fromNode.type === 'experiment' &&
        ['experiment', 'idea', 'capability', 'condition'].includes(toNode.type))) {
      fail('recovers_to must connect a failed experiment to a declared recovery route, capability, or condition');
    }
    if (['contradicts', 'alternative_to'].includes(input.type) &&
        !(['hypothesis', 'idea', 'candidate', 'evidence', 'condition'].includes(fromNode.type) && ['hypothesis', 'idea', 'candidate', 'evidence', 'condition'].includes(toNode.type))) {
      fail(`${input.type} must connect claims, candidate approaches, evidence, or conditions`);
    }
    const hasMembership = statement('SELECT 1 FROM adaptive_goal_knowledge_memberships WHERE node_id=? AND goal_id=?');
    if (!hasMembership.get(fromId, goalId) || !hasMembership.get(toId, goalId)) fail('edge endpoints must belong to the specified goal');
    if (input.type === 'recovers_to') {
      const requiredRefs = input.outcome.evidenceRefs;
      const evidenceRows = statement(`SELECT r.evidence_refs_json FROM adaptive_goal_knowledge_nodes n
        JOIN adaptive_goal_knowledge_memberships m ON m.node_id=n.id
        JOIN adaptive_goal_knowledge_revisions r ON r.node_id=n.id AND r.revision=n.current_revision
        WHERE m.goal_id=? AND n.type='evidence'`).all(goalId);
      const declaredEvidence = new Set(evidenceRows.flatMap(row => JSON.parse(row.evidence_refs_json)));
      const missing = requiredRefs.filter(ref => !declaredEvidence.has(ref));
      if (missing.length) fail(`recovers_to outcome refs must point to declared evidence nodes: ${missing.join(', ')}`);
    }
    const edgeId = `age-${hash(JSON.stringify([goalId, fromId, toId, input.type, conditionJson, outcomeJson])).slice(0, 40)}`;
    const now = new Date().toISOString();
    try {
      statement(`INSERT INTO adaptive_goal_knowledge_edges(edge_id,goal_id,from_id,to_id,type,condition_json,outcome_json,evidence_refs_json,provenance_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(edgeId, goalId, fromId, toId, input.type, conditionJson, outcomeJson, JSON.stringify(normalizedRefs), provenance, now);
    } catch (error) {
      if (/UNIQUE constraint failed/.test(error.message)) {
        const existing = statement('SELECT * FROM adaptive_goal_knowledge_edges WHERE edge_id=?').get(edgeId);
        if (!existing) throw error;
        if (existing.evidence_refs_json !== JSON.stringify(normalizedRefs) || existing.provenance_json !== provenance) {
          fail('immutable edge identity already exists with different evidence refs or provenance; create a new explicit relation revision/key instead of silently replacing it');
        }
        return {
          edgeId, goalId: existing.goal_id, fromId: existing.from_id, toId: existing.to_id, type: existing.type,
          condition: existing.condition_json && JSON.parse(existing.condition_json), outcome: existing.outcome_json && JSON.parse(existing.outcome_json),
          evidenceRefs: JSON.parse(existing.evidence_refs_json), provenance: JSON.parse(existing.provenance_json),
          provenanceHash: hash(existing.provenance_json), reused: true
        };
      }
      throw error;
    }
    return { edgeId, goalId, fromId, toId, type: input.type, condition: conditionJson && JSON.parse(conditionJson), outcome: outcomeJson && JSON.parse(outcomeJson), evidenceRefs: normalizedRefs, provenance: JSON.parse(provenance), provenanceHash: hash(provenance), reused: false };
  }

  function getNode(id, options = {}) {
    exactKeys(options, ['revision'], 'getNode options');
    const nodeId = text(id, 'id', 128);
    if (options.revision === undefined) return get(nodeId);
    if (!Number.isSafeInteger(options.revision) || options.revision < 1) fail('revision must be a positive safe integer');
    const row = statement(`SELECT n.id,n.stable_key,n.type,r.revision,r.content_json,r.evidence_refs_json,r.content_hash,r.status,r.provenance_json,r.created_at
      FROM adaptive_goal_knowledge_nodes n JOIN adaptive_goal_knowledge_revisions r ON r.node_id=n.id WHERE n.id=? AND r.revision=?`).get(nodeId, options.revision);
    return parseRow(row, membershipsFor(nodeId));
  }
  function history(id) {
    const nodeId = text(id, 'id', 128);
    return statement(`SELECT n.id,n.stable_key,n.type,r.revision,r.content_json,r.evidence_refs_json,r.content_hash,r.status,r.provenance_json,r.created_at
      FROM adaptive_goal_knowledge_nodes n JOIN adaptive_goal_knowledge_revisions r ON r.node_id=n.id WHERE n.id=? ORDER BY r.revision`).all(nodeId).map(row => parseRow(row, membershipsFor(nodeId)));
  }

  function snapshotForGoal(goalIdInput) {
    const goalId = text(goalIdInput, 'goalId', 200);
    const currentRows = statement(`SELECT n.id,n.stable_key,n.type,n.current_revision AS revision,
      r.content_json,r.evidence_refs_json,r.content_hash,r.status,r.provenance_json,r.created_at
      FROM adaptive_goal_knowledge_nodes n
      JOIN adaptive_goal_knowledge_memberships goal_membership ON goal_membership.node_id=n.id AND goal_membership.goal_id=?
      LEFT JOIN adaptive_goal_knowledge_revisions r ON r.node_id=n.id AND r.revision=n.current_revision
      ORDER BY n.id`).all(goalId);
    const nodeIds = currentRows.map(row => row.id);
    const memberships = nodeIds.length
      ? statement(`SELECT node_id,goal_id,created_at,provenance_json FROM adaptive_goal_knowledge_memberships
          WHERE node_id IN (${nodeIds.map(() => '?').join(',')}) ORDER BY node_id,goal_id`).all(...nodeIds)
      : [];
    const edges = statement('SELECT * FROM adaptive_goal_knowledge_edges WHERE goal_id=? ORDER BY edge_id').all(goalId);
    const integrityIssues = [];
    const rawRevisionRows = nodeIds.length
      ? statement(`SELECT node_id,revision,content_json,evidence_refs_json,content_hash,status,provenance_json,created_at
          FROM adaptive_goal_knowledge_revisions WHERE node_id IN (${nodeIds.map(() => '?').join(',')})
          ORDER BY node_id,revision LIMIT ?`).all(...nodeIds, MAX_SNAPSHOT_REVISIONS + 1)
      : [];
    if (rawRevisionRows.length > MAX_SNAPSHOT_REVISIONS) {
      integrityIssues.push({ code: 'KNOWLEDGE_REVISION_HISTORY_LIMIT_EXCEEDED', limit: MAX_SNAPSHOT_REVISIONS });
    }
    const revisionHistory = rawRevisionRows.slice(0, MAX_SNAPSHOT_REVISIONS).map(row => {
      let content = null; let evidenceRefs = null; let provenance = null;
      try {
        content = JSON.parse(row.content_json);
        evidenceRefs = JSON.parse(row.evidence_refs_json);
        provenance = JSON.parse(row.provenance_json);
      } catch {
        integrityIssues.push({ code: 'KNOWLEDGE_REVISION_JSON_INVALID', nodeId: row.node_id, revision: row.revision });
      }
      try {
        if (!record(content) || !Array.isArray(evidenceRefs) ||
            evidenceRefs.some(ref => typeof ref !== 'string' || !ref.trim()) ||
            canonicalJson(evidenceRefs, 'revision history evidence refs') !== canonicalJson([...new Set(evidenceRefs)].sort(), 'normalized revision history evidence refs') ||
            row.content_json !== canonicalJson(content, 'revision history content') ||
            row.evidence_refs_json !== canonicalJson(evidenceRefs, 'revision history evidence refs') ||
            hash(canonicalJson({ content, evidenceRefs }, 'revision history content hash')) !== row.content_hash) {
          integrityIssues.push({ code: 'KNOWLEDGE_REVISION_CONTENT_HASH_MISMATCH', nodeId: row.node_id, revision: row.revision });
        }
        if (provenanceJson(provenance, 'revision history provenance') !== row.provenance_json) {
          integrityIssues.push({ code: 'KNOWLEDGE_REVISION_PROVENANCE_NONCANONICAL', nodeId: row.node_id, revision: row.revision });
        }
      } catch {
        integrityIssues.push({ code: 'KNOWLEDGE_REVISION_CANONICALIZATION_FAILED', nodeId: row.node_id, revision: row.revision });
      }
      if (row.status !== 'unverified') integrityIssues.push({ code: 'KNOWLEDGE_REVISION_STATUS_INVALID', nodeId: row.node_id, revision: row.revision });
      return {
        node_id: row.node_id, revision: row.revision, content: content ?? null,
        evidence_refs: evidenceRefs ?? [], content_hash: row.content_hash, status: row.status,
        provenance: provenance ?? null, provenance_hash: row.provenance_json ? hash(row.provenance_json) : null,
        created_at: row.created_at
      };
    });
    const revisionsByNode = new Map();
    for (const revision of revisionHistory) {
      const rows = revisionsByNode.get(revision.node_id) || [];
      rows.push(revision);
      revisionsByNode.set(revision.node_id, rows);
    }
    const nodes = currentRows.map(row => {
      let content; let evidenceRefs; let provenance;
      try { content = JSON.parse(row.content_json); evidenceRefs = JSON.parse(row.evidence_refs_json); provenance = JSON.parse(row.provenance_json); }
      catch { integrityIssues.push({ code: 'KNOWLEDGE_NODE_JSON_INVALID', nodeId: row.id, revision: row.revision }); }
      try {
        if (!record(content) || !NODE_TYPES.has(row.type) ||
            row.id !== `agk-${hash(`${row.type}\0${row.stable_key}`).slice(0, 40)}` ||
            !Array.isArray(evidenceRefs) || evidenceRefs.some(ref => typeof ref !== 'string' || !ref.trim()) ||
            canonicalJson(evidenceRefs, 'current revision evidence refs') !== canonicalJson([...new Set(evidenceRefs)].sort(), 'normalized current revision evidence refs') ||
            row.content_json !== canonicalJson(content, 'current revision content') ||
            row.evidence_refs_json !== canonicalJson(evidenceRefs, 'current revision evidence refs') ||
            hash(canonicalJson({ content, evidenceRefs }, 'snapshot revision')) !== row.content_hash) {
          integrityIssues.push({ code: 'KNOWLEDGE_REVISION_CONTENT_HASH_MISMATCH', nodeId: row.id, revision: row.revision });
        }
        if (provenanceJson(provenance, 'snapshot revision provenance') !== row.provenance_json) {
          integrityIssues.push({ code: 'KNOWLEDGE_REVISION_PROVENANCE_NONCANONICAL', nodeId: row.id, revision: row.revision });
        }
      } catch { integrityIssues.push({ code: 'KNOWLEDGE_REVISION_CANONICALIZATION_FAILED', nodeId: row.id, revision: row.revision }); }
      const history = revisionsByNode.get(row.id) || [];
      if (!Number.isSafeInteger(row.revision) || row.revision < 1 || history.length !== row.revision ||
          history.some((revision, index) => revision.revision !== index + 1) || history.at(-1)?.revision !== row.revision ||
          history.at(-1)?.content_hash !== row.content_hash || history.at(-1)?.provenance_hash !== (row.provenance_json ? hash(row.provenance_json) : null)) {
        integrityIssues.push({ code: 'KNOWLEDGE_REVISION_HISTORY_GAP_OR_CURRENT_MISMATCH', nodeId: row.id, currentRevision: row.revision, storedRevisionCount: history.length });
      }
      if (row.status !== 'unverified') integrityIssues.push({ code: 'KNOWLEDGE_REVISION_STATUS_INVALID', nodeId: row.id, revision: row.revision });
      return {
        id: row.id, stable_key: row.stable_key, type: row.type, revision: row.revision,
        content: content ?? null, content_hash: row.content_hash, evidence_refs: evidenceRefs ?? [],
        status: row.status, provenance: provenance ?? null, provenance_hash: hash(row.provenance_json), created_at: row.created_at
      };
    });
    const membershipRecords = memberships.map(row => {
      let provenance = null;
      if (row.provenance_json !== null && row.provenance_json !== undefined) {
        try { provenance = JSON.parse(row.provenance_json); }
        catch { integrityIssues.push({ code: 'KNOWLEDGE_MEMBERSHIP_PROVENANCE_INVALID', nodeId: row.node_id, goalId: row.goal_id }); }
      }
      if (!provenance) integrityIssues.push({ code: 'KNOWLEDGE_MEMBERSHIP_PROVENANCE_MISSING', nodeId: row.node_id, goalId: row.goal_id });
      else {
        try {
          if (provenanceJson(provenance, 'membership provenance') !== row.provenance_json) {
            integrityIssues.push({ code: 'KNOWLEDGE_MEMBERSHIP_PROVENANCE_NONCANONICAL', nodeId: row.node_id, goalId: row.goal_id });
          }
        } catch { integrityIssues.push({ code: 'KNOWLEDGE_MEMBERSHIP_PROVENANCE_INVALID', nodeId: row.node_id, goalId: row.goal_id }); }
      }
      return { node_id: row.node_id, goal_id: row.goal_id, provenance, provenance_hash: row.provenance_json ? hash(row.provenance_json) : null, created_at: row.created_at };
    });
    const edgeRecords = edges.map(row => {
      let condition = null; let outcome = null; let evidenceRefs = []; let provenance = null;
      try {
        condition = row.condition_json === null ? null : JSON.parse(row.condition_json);
        outcome = row.outcome_json === null ? null : JSON.parse(row.outcome_json);
        evidenceRefs = JSON.parse(row.evidence_refs_json);
        provenance = JSON.parse(row.provenance_json);
      } catch { integrityIssues.push({ code: 'KNOWLEDGE_EDGE_JSON_INVALID', edgeId: row.edge_id }); }
      if (!nodeIds.includes(row.from_id) || !nodeIds.includes(row.to_id)) {
        integrityIssues.push({ code: 'KNOWLEDGE_EDGE_ENDPOINT_NOT_IN_GOAL', edgeId: row.edge_id });
      }
      const fromType = currentRows.find(node => node.id === row.from_id)?.type;
      const toType = currentRows.find(node => node.id === row.to_id)?.type;
      if (!EDGE_TYPES.has(row.type) || row.from_id === row.to_id || row.edge_id !== `age-${hash(JSON.stringify([
        row.goal_id, row.from_id, row.to_id, row.type, row.condition_json, row.outcome_json
      ])).slice(0, 40)}`) {
        integrityIssues.push({ code: 'KNOWLEDGE_EDGE_IDENTITY_INVALID', edgeId: row.edge_id });
      }
      const edgeSemanticsValid = row.type === 'tested_by'
        ? ['hypothesis','idea'].includes(fromType) && toType === 'experiment'
        : row.type === 'supports'
          ? ['hypothesis','idea','capability','experiment','evidence','goal'].includes(fromType) &&
            ['hypothesis','idea','capability','condition','experiment','goal'].includes(toType)
          : row.type === 'enables'
            ? ['hypothesis','idea','capability','experiment','evidence','goal'].includes(fromType) &&
              ['idea','capability','condition','experiment','goal'].includes(toType)
            : row.type === 'recovers_to'
              ? fromType === 'experiment' && ['experiment','idea','capability','condition'].includes(toType)
              : ['contradicts','alternative_to'].includes(row.type)
                ? ['hypothesis','idea','candidate','evidence','condition'].includes(fromType) &&
                  ['hypothesis','idea','candidate','evidence','condition'].includes(toType)
                : ['requires_all','depends_on'].includes(row.type);
      if (!edgeSemanticsValid) integrityIssues.push({ code: 'KNOWLEDGE_EDGE_TYPE_SEMANTICS_INVALID', edgeId: row.edge_id, type: row.type });
      if (row.type === 'recovers_to') {
        if (!record(condition) || !record(outcome) || !['failed','blocked','verification_failed','evidence_missing','contradicted'].includes(condition.when) ||
            !['required_evidence_available','verification_failed_with_evidence'].includes(condition.predicate) ||
            typeof outcome.state !== 'string' || !outcome.state.trim() || !Array.isArray(outcome.effects) ||
            !Array.isArray(outcome.evidenceRefs) || outcome.evidenceRefs.length < 1) {
          integrityIssues.push({ code: 'KNOWLEDGE_RECOVERY_EDGE_CONTRACT_INVALID', edgeId: row.edge_id });
        }
      } else if (row.condition_json !== null || row.outcome_json !== null) {
        integrityIssues.push({ code: 'KNOWLEDGE_NON_RECOVERY_EDGE_HAS_CONDITION', edgeId: row.edge_id });
      }
      for (const [field, value, stored] of [['condition', condition, row.condition_json], ['outcome', outcome, row.outcome_json],
        ['evidence refs', evidenceRefs, row.evidence_refs_json], ['provenance', provenance, row.provenance_json]]) {
        if (stored === null && value === null) continue;
        try {
          const normalized = field === 'provenance' ? provenanceJson(value, `edge ${field}`) : canonicalJson(value, `edge ${field}`);
          if (normalized !== stored) integrityIssues.push({ code: 'KNOWLEDGE_EDGE_NONCANONICAL', edgeId: row.edge_id, field });
        }
        catch { integrityIssues.push({ code: 'KNOWLEDGE_EDGE_INVALID', edgeId: row.edge_id, field }); }
      }
      if (!Array.isArray(evidenceRefs) || evidenceRefs.some(ref => typeof ref !== 'string' || !ref.trim()) ||
          canonicalJson(evidenceRefs, 'edge evidence refs') !== canonicalJson([...new Set(evidenceRefs)].sort(), 'normalized edge evidence refs')) {
        integrityIssues.push({ code: 'KNOWLEDGE_EDGE_EVIDENCE_REFERENCES_INVALID', edgeId: row.edge_id });
      }
      return {
        edge_id: row.edge_id, goal_id: row.goal_id, from_id: row.from_id, to_id: row.to_id, type: row.type,
        condition, outcome, evidence_refs: evidenceRefs, provenance, provenance_hash: hash(row.provenance_json), created_at: row.created_at
      };
    });
    const snapshot = {
      schema_version: 1, goal_id: goalId,
      nodes, revision_history: revisionHistory, memberships: membershipRecords, edges: edgeRecords
    };
    const canonical = canonicalSnapshotJson(snapshot);
    return {
      ...snapshot,
      snapshot_hash: hash(canonical),
      node_ids: nodes.map(node => node.id).sort(),
      edge_ids: edgeRecords.map(edge => edge.edge_id).sort(),
      membership_ids: membershipRecords.map(item => `${item.node_id}\u0000${item.goal_id}`).sort(),
      evidence_refs: [...new Set([...nodes.flatMap(node => node.evidence_refs), ...edgeRecords.flatMap(edge => edge.evidence_refs)])].sort(),
      integrity_issues: integrityIssues,
      integrity_valid: integrityIssues.length === 0,
      canonical_json: canonical
    };
  }

  function search(options = {}) {
    exactKeys(options, ['goalId', 'type', 'query', 'includeUnverified', 'includeRecoveryEdges', 'limit'], 'search options');
    const goalId = options.goalId === undefined ? null : text(options.goalId, 'goalId', 200);
    if (options.type !== undefined && !NODE_TYPES.has(options.type)) fail('search type is unsupported');
    const query = options.query === undefined ? null : text(options.query, 'query', 512).toLocaleLowerCase('en');
    const includeUnverified = options.includeUnverified !== false;
    if (options.includeUnverified !== undefined && typeof options.includeUnverified !== 'boolean') fail('includeUnverified must be boolean');
    const includeRecoveryEdges = options.includeRecoveryEdges === true;
    if (options.includeRecoveryEdges !== undefined && typeof options.includeRecoveryEdges !== 'boolean') fail('includeRecoveryEdges must be boolean');
    const limit = options.limit === undefined ? 100 : options.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail('limit must be an integer from 1 to 500');
    const where = [];
    const params = [];
    if (goalId !== null) { where.push('m.goal_id=?'); params.push(goalId); }
    if (options.type) { where.push('n.type=?'); params.push(options.type); }
    if (!includeUnverified) where.push("r.status <> 'unverified'");
    if (query !== null) { where.push('lower(r.content_json) LIKE ? ESCAPE \'\\\''); params.push(`%${query.replace(/[\\%_]/g, char => `\\${char}`)}%`); }
    params.push(limit);
    const rows = statement(`SELECT DISTINCT n.id,n.stable_key,n.type,n.current_revision AS revision,r.content_json,r.evidence_refs_json,r.content_hash,r.status,r.provenance_json,r.created_at
      FROM adaptive_goal_knowledge_nodes n JOIN adaptive_goal_knowledge_memberships m ON m.node_id=n.id
      JOIN adaptive_goal_knowledge_revisions r ON r.node_id=n.id AND r.revision=n.current_revision
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY n.type,n.stable_key LIMIT ?`).all(...params);
    const nodes = rows.map(row => parseRow(row, membershipsFor(row.id)));
    const visibleIds = new Set(nodes.map(node => node.id));
    const goals = goalId === null ? [...new Set(nodes.flatMap(node => node.memberships))] : [goalId];
    let edges = [];
    if (goals.length) {
      const placeholders = goals.map(() => '?').join(',');
      const edgeRows = statement(`SELECT * FROM adaptive_goal_knowledge_edges WHERE goal_id IN (${placeholders}) ${includeRecoveryEdges ? '' : "AND type <> 'recovers_to'"} ORDER BY goal_id,from_id,to_id,type LIMIT ?`).all(...goals, MAX_EDGES);
      edges = edgeRows.filter(edge => visibleIds.has(edge.from_id) && visibleIds.has(edge.to_id)).map(edge => ({
        edgeId: edge.edge_id, goalId: edge.goal_id, fromId: edge.from_id, toId: edge.to_id, type: edge.type,
        condition: edge.condition_json && JSON.parse(edge.condition_json), outcome: edge.outcome_json && JSON.parse(edge.outcome_json),
        evidenceRefs: JSON.parse(edge.evidence_refs_json), provenance: JSON.parse(edge.provenance_json), provenanceHash: hash(edge.provenance_json), createdAt: edge.created_at
      }));
    }
    const reusedNodes = nodes.filter(node => node.memberships.length > 1).map(node => ({ id: node.id, type: node.type, stableKey: node.stableKey, memberships: node.memberships }));
    return { nodes, edges, reusedNodes, filters: { includeUnverified, includeRecoveryEdges }, planning: { verifiedOnly: true, verifierAvailable: false, usableNodeIds: [] } };
  }
  return Object.freeze({ db, saveNode, addEdge, getNode, history, search, snapshotForGoal });
}
