import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createEnvelope, validateEnvelope, validatePayload } from '../../protocol/cos-ap-v1/index.js';
import { assertSessionGrantAuthority, assertSessionRevokeAuthority, normalizeGovernanceRole } from './agent-session-policy.js';
import { AGENT_SESSION_DELIVERY_HOOKS } from './agent-session-api.js';
import { parseStrictJson } from './strict-json.js';

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function eventId(jobId, type, dedupeKey = '') { return hash(`${jobId}|${type}|${dedupeKey}`); }

const AGENT_SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_sessions (
  session_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  role TEXT NOT NULL,
  openclaw_session_key TEXT NOT NULL UNIQUE,
  parent_session_key TEXT,
  state TEXT NOT NULL CHECK (state IN ('CREATED','ACTIVE','PAUSED','STALE','FAILED','TERMINATED')),
  current_turn_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_job ON agent_sessions(job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_task ON agent_sessions(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_activity ON agent_sessions(state, last_activity_at);
CREATE TABLE IF NOT EXISTS session_access (
  access_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(session_id),
  accessor_role TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('OBSERVE','MESSAGE','EXECUTE','TAKEOVER')),
  granted_by TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_access_active
  ON session_access(session_id, accessor_role, permission) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_session_access_session ON session_access(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_session_access_accessor ON session_access(accessor_role, session_id, revoked_at);
CREATE TABLE IF NOT EXISTS session_messages (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(session_id),
  sender_role TEXT NOT NULL,
  recipient_role TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'legacy',
  protocol_version INTEGER NOT NULL DEFAULT 0,
  message_type TEXT NOT NULL DEFAULT 'MESSAGE',
  payload_json TEXT NOT NULL,
  correlation_id TEXT,
  dedupe_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('QUEUED','DELIVERED','ACKED','FAILED')),
  attempt INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_until TEXT,
  delivered_at TEXT,
  acked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_messages_dedupe
  ON session_messages(session_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_session_messages_inbox
  ON session_messages(session_id, recipient_role, status, available_at, created_at);
CREATE INDEX IF NOT EXISTS idx_session_messages_correlation
  ON session_messages(session_id, correlation_id, created_at);
`;

function initializeAgentSessionStore(db, workflowPort) {
  db.exec(AGENT_SESSION_SCHEMA);
  for (const sql of [
    "ALTER TABLE session_messages ADD COLUMN protocol TEXT NOT NULL DEFAULT 'legacy'",
    "ALTER TABLE session_messages ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 0"
  ]) {
    try { db.exec(sql); } catch (error) {
      if (!String(error?.message || error).toLowerCase().includes('duplicate column')) throw error;
    }
  }
  // Compatibility backfill only reconstructs registry rows from existing task runtime keys.
  // It never creates, resumes, or terminates external runtimes.
  try {
    const insert = db.prepare(`INSERT OR IGNORE INTO agent_sessions(
      session_id, job_id, task_id, role, openclaw_session_key, parent_session_key,
      state, current_turn_id, attempt, created_at, updated_at, last_activity_at
    ) VALUES(?, ?, ?, ?, ?, NULL, ?, NULL, 1, ?, ?, ?)`);
    for (const task of workflowPort.listTasksWithOpenClawSession()) {
      if (typeof task.openclaw_session_key !== 'string' || !task.openclaw_session_key.trim()) continue;
      const state = task.status === 'running' ? 'ACTIVE' : task.status === 'pending' ? 'CREATED' : 'PAUSED';
      insert.run(id('session'), task.job_id, task.task_id, task.role || 'unknown', task.openclaw_session_key,
        state, task.created_at, task.updated_at, task.updated_at);
    }
  } catch (error) {
    console.warn('[AgentSessionStore] legacy registry backfill skipped:', error?.message || error);
  }
}

/** Agent-owned session registry, ACL and durable inter-agent message queue.
 * Shares the Workflow SQLite connection so session/event transitions remain atomic.
 * Workflow task and event state is accessed only through the injected port.
 */
export class AgentSessionStore {
  #db;
  #workflowPort;
  #deliveryHooks;
  constructor({ database, workflowPort, deliveryHooks } = {}) {
    if (!database || typeof database.exec !== 'function' || typeof database.prepare !== 'function') {
      throw new TypeError('AgentSessionStore requires an injected DatabaseSync-compatible connection');
    }
    for (const method of ['getTask','lockTaskForAgentSession','recordEvent','getEvent','listEventsForJob','countEventsForJobType','listTasksWithOpenClawSession']) {
      if (typeof workflowPort?.[method] !== 'function') throw new TypeError(`AgentSessionStore workflowPort.${method} must be a function`);
    }
    if (typeof workflowPort.assertSharedConnection !== 'function') {
      throw new TypeError('AgentSessionStore workflowPort.assertSharedConnection must be a function');
    }
    workflowPort.assertSharedConnection(database);
    for (const method of AGENT_SESSION_DELIVERY_HOOKS) {
      if (typeof deliveryHooks?.[method] !== 'function') throw new TypeError(`AgentSessionStore deliveryHooks.${method} must be a function`);
    }
    this.#db = database;
    this.#workflowPort = workflowPort;
    this.#deliveryHooks = deliveryHooks;
    initializeAgentSessionStore(database, workflowPort);
  }

  listEventsForJob(jobId, type) {
    const rows = this.#workflowPort.listEventsForJob(jobId, { type, limit: 50_000 });
    const total = this.#workflowPort.countEventsForJobType(jobId, type);
    if (total > rows.length) {
      throw new Error(`AgentSessionStore event scan exceeded 50000 rows for ${type}; refusing incomplete lineage verification`);
    }
    return rows;
  }

  updateRetryAttempt(sessionId, nextAttempt, timestamp) {
    return this.#db.prepare("UPDATE agent_sessions SET attempt = ?, updated_at = ?, last_activity_at = ? WHERE session_id = ? AND state='ACTIVE'")
      .run(nextAttempt, timestamp, timestamp, sessionId);
  }

  lockSession(sessionId) {
    return this.#db.prepare('UPDATE agent_sessions SET updated_at=updated_at WHERE session_id=?').run(sessionId);
  }

  terminateSessionsForTask(taskId, state, timestamp) {
    if (!['TERMINATED','FAILED'].includes(state)) throw new TypeError('terminal agent session state must be TERMINATED or FAILED');
    return this.#db.prepare("UPDATE agent_sessions SET state = ?, updated_at = ?, last_activity_at = ? WHERE task_id = ? AND state IN ('CREATED','ACTIVE','PAUSED')")
      .run(state, timestamp, timestamp, taskId);
  }

  listActiveAgentSessionsForJob(jobId) {
    return this.#db.prepare("SELECT session_id,task_id,role,state FROM agent_sessions WHERE job_id=? AND state IN ('CREATED','ACTIVE','PAUSED') ORDER BY created_at,rowid")
      .all(jobId);
  }

  getSessionTraceForJob(jobId) {
    const sessions = this.#db.prepare('SELECT * FROM agent_sessions WHERE job_id = ? ORDER BY created_at, rowid').all(jobId);
    const sessionIds = sessions.map(session => session.session_id);
    const sessionMessages = sessionIds.length
      ? this.#db.prepare(`SELECT * FROM session_messages WHERE session_id IN (${sessionIds.map(() => '?').join(',')}) ORDER BY created_at, rowid`).all(...sessionIds)
      : [];
    return { sessions, sessionMessages };
  }

  getSession(sessionId) { return this.#db.prepare('SELECT * FROM agent_sessions WHERE session_id = ?').get(sessionId) || null; }
  getSessionByOpenClawKey(sessionKey) { return this.#db.prepare('SELECT * FROM agent_sessions WHERE openclaw_session_key = ?').get(sessionKey) || null; }
  getSessionByTask(taskId) { return this.#db.prepare('SELECT * FROM agent_sessions WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(taskId) || null; }
  createAgentSession(taskId, { sessionKey, role = null, parentSessionKey = null, attempt = 1, state = 'CREATED', currentTurnId = null } = {}) {
    if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('taskId must be a non-empty string');
    if (typeof sessionKey !== 'string' || !sessionKey.trim()) throw new Error('openclaw session key must be a non-empty string');
    if (role !== null && role !== undefined && (typeof role !== 'string' || !role.trim())) throw new Error('session role must be a non-empty string or null');
    if (parentSessionKey !== null && parentSessionKey !== undefined && (typeof parentSessionKey !== 'string' || !parentSessionKey.trim())) {
      throw new Error('parentSessionKey must be a non-empty string or null');
    }
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('session attempt must be a positive safe integer');
    if (typeof state !== 'string' || !['CREATED', 'ACTIVE', 'PAUSED', 'STALE', 'FAILED', 'TERMINATED'].includes(state)) {
      throw new Error('invalid agent session state');
    }
    if (currentTurnId !== null && currentTurnId !== undefined && (typeof currentTurnId !== 'string' || !currentTurnId.trim())) {
      throw new Error('currentTurnId must be a non-empty string or null');
    }
    this.#db.exec('SAVEPOINT create_agent_session_transition');
    try {
      const taskLock = this.#workflowPort.lockTaskForAgentSession(taskId);
      if (taskLock.changes !== 1) {
        this.#db.exec('RELEASE SAVEPOINT create_agent_session_transition');
        return null;
      }
      const task = this.#workflowPort.getTask(taskId);
      if (!task) throw new Error(`task disappeared during session creation: ${taskId}`);
      const normalizedRole = role || task.role || 'unknown';
      const existing = this.getSessionByOpenClawKey(sessionKey);
      if (existing) {
        if (existing.task_id !== taskId || existing.job_id !== task.job_id || existing.role !== normalizedRole ||
            (parentSessionKey != null && existing.parent_session_key !== parentSessionKey)) {
          throw new Error(`OpenClaw session key is already bound to a different task/session identity: ${sessionKey}`);
        }
        this.#db.exec('RELEASE SAVEPOINT create_agent_session_transition');
        return existing;
      }
      const sessionId = id('session'); const ts = now();
      this.#db.prepare(`INSERT INTO agent_sessions(
        session_id, job_id, task_id, role, openclaw_session_key, parent_session_key,
        state, current_turn_id, attempt, created_at, updated_at, last_activity_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(sessionId, task.job_id, task.task_id, normalizedRole, sessionKey,
          parentSessionKey ?? null, state, currentTurnId ?? null, attempt, ts, ts, ts);
      const payload = {
        sessionId, taskId: task.task_id, role: normalizedRole, sessionKey,
        parentSessionKey: parentSessionKey ?? null, state, attempt
      };
      const eventIdValue = this.#workflowPort.recordEvent(task.job_id, 'session.created', payload, sessionId);
      const event = this.#workflowPort.getEvent(eventIdValue);
      const persisted = this.getSession(sessionId);
      if (!event || event.event_id !== eventId(task.job_id, 'session.created', sessionId) || event.job_id !== task.job_id ||
          event.type !== 'session.created' || event.payload_json !== JSON.stringify(payload) ||
          !persisted || persisted.task_id !== taskId || persisted.openclaw_session_key !== sessionKey || persisted.attempt !== attempt || persisted.state !== state) {
        throw new Error('agent session creation row/event lineage readback failed');
      }
      this.#db.exec('RELEASE SAVEPOINT create_agent_session_transition');
      return persisted;
    } catch (error) {
      try { this.#db.exec('ROLLBACK TO SAVEPOINT create_agent_session_transition'); } catch {}
      try { this.#db.exec('RELEASE SAVEPOINT create_agent_session_transition'); } catch {}
      throw error;
    }
  }
  updateAgentSession(sessionId, { state, currentTurnId, heartbeat = false, attempt, parentSessionKey } = {}) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('sessionId must be a non-empty string');
    if (state !== undefined && (typeof state !== 'string' || !['CREATED', 'ACTIVE', 'PAUSED', 'STALE', 'FAILED', 'TERMINATED'].includes(state))) {
      throw new Error('invalid agent session state');
    }
    if (typeof heartbeat !== 'boolean') throw new Error('heartbeat must be a boolean');
    if (currentTurnId !== undefined && currentTurnId !== null && (typeof currentTurnId !== 'string' || !currentTurnId.trim())) {
      throw new Error('currentTurnId must be a non-empty string or null');
    }
    if (attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt < 1)) {
      throw new Error('session attempt must be a positive safe integer');
    }
    if (parentSessionKey !== undefined && parentSessionKey !== null && (typeof parentSessionKey !== 'string' || !parentSessionKey.trim())) {
      throw new Error('parentSessionKey must be a non-empty string or null');
    }
    this.#db.exec('SAVEPOINT update_agent_session_transition');
    try {
      const sessionLock = this.#db.prepare('UPDATE agent_sessions SET updated_at=updated_at WHERE session_id=?').run(sessionId);
      if (sessionLock.changes !== 1) {
        this.#db.exec('RELEASE SAVEPOINT update_agent_session_transition');
        return null;
      }
      const existing = this.getSession(sessionId);
      if (!existing || !Number.isSafeInteger(existing.attempt) || existing.attempt < 1) {
        throw new Error('agent session is missing or has malformed durable attempt identity');
      }
      const nextState = state === undefined ? existing.state : state;
      const allowedNext = {
        CREATED: new Set(['CREATED', 'ACTIVE', 'PAUSED', 'STALE', 'FAILED', 'TERMINATED']),
        ACTIVE: new Set(['ACTIVE', 'PAUSED', 'STALE', 'FAILED', 'TERMINATED']),
        PAUSED: new Set(['PAUSED', 'ACTIVE', 'STALE', 'FAILED', 'TERMINATED']),
        STALE: new Set(['STALE', 'ACTIVE', 'FAILED', 'TERMINATED']),
        FAILED: new Set(['FAILED', 'ACTIVE', 'TERMINATED']),
        TERMINATED: new Set(['TERMINATED']),
      };
      if (!allowedNext[existing.state]?.has(nextState)) {
        throw new Error(`invalid agent session state transition: ${existing.state} -> ${nextState}`);
      }
      const nextTurn = currentTurnId === undefined ? existing.current_turn_id : currentTurnId;
      const nextAttempt = attempt === undefined ? existing.attempt : attempt;
      if (nextAttempt < existing.attempt) throw new Error('agent session attempt must not move backwards');
      const nextParent = parentSessionKey === undefined ? existing.parent_session_key : parentSessionKey;
      const ts = now();
      const update = this.#db.prepare(`UPDATE agent_sessions
        SET state = ?, current_turn_id = ?, attempt = ?, parent_session_key = ?,
            updated_at = ?, last_activity_at = CASE WHEN ? THEN ? ELSE last_activity_at END
        WHERE session_id = ? AND state = ? AND attempt = ?`)
        .run(nextState, nextTurn, nextAttempt, nextParent, ts, heartbeat ? 1 : 0, ts, sessionId, existing.state, existing.attempt);
      if (update.changes !== 1) throw new Error('agent session update lost its state/attempt compare-and-set');
      let eventType = null;
      let eventPayload = null;
      let eventKey = null;
      if (nextState !== existing.state) {
        eventType = 'session.state_changed';
        eventPayload = {
          sessionId, taskId: existing.task_id, from: existing.state, to: nextState,
          previousAttempt: existing.attempt, attempt: nextAttempt,
          currentTurnId: nextTurn, parentSessionKey: nextParent
        };
        // A session can legitimately transition STALE/FAILED -> ACTIVE more
        // than once. Keying only by target state aliases later ownership epochs
        // to an earlier event, so bind each distinct transition to its time and
        // prior state/attempt while the savepoint guarantees atomicity.
        eventKey = `${sessionId}|transition|${crypto.randomUUID()}`;
      } else if (heartbeat) {
        eventType = 'session.heartbeat';
        eventPayload = {
          sessionId, taskId: existing.task_id, state: nextState, currentTurnId: nextTurn,
          attempt: nextAttempt, parentSessionKey: nextParent
        };
        eventKey = `${sessionId}|${ts}`;
      } else if (nextAttempt !== existing.attempt || nextTurn !== existing.current_turn_id || nextParent !== existing.parent_session_key) {
        eventType = 'session.updated';
        eventPayload = {
          sessionId, taskId: existing.task_id, state: nextState,
          previousAttempt: existing.attempt, attempt: nextAttempt,
          previousTurnId: existing.current_turn_id, currentTurnId: nextTurn,
          previousParentSessionKey: existing.parent_session_key, parentSessionKey: nextParent
        };
        eventKey = `${sessionId}|updated|${hash(JSON.stringify(eventPayload))}`;
      }
      if (eventType) {
        const eventIdValue = this.#workflowPort.recordEvent(existing.job_id, eventType, eventPayload, eventKey);
        const event = this.#workflowPort.getEvent(eventIdValue);
        if (!event || event.event_id !== eventId(existing.job_id, eventType, eventKey) || event.job_id !== existing.job_id ||
            event.type !== eventType || event.payload_json !== JSON.stringify(eventPayload)) {
          throw new Error('agent session update/event lineage readback failed');
        }
      }
      const persisted = this.getSession(sessionId);
      if (!persisted || persisted.state !== nextState || persisted.attempt !== nextAttempt ||
          persisted.current_turn_id !== nextTurn || persisted.parent_session_key !== nextParent) {
        throw new Error('agent session update durable readback failed');
      }
      this.#db.exec('RELEASE SAVEPOINT update_agent_session_transition');
      return persisted;
    } catch (error) {
      try { this.#db.exec('ROLLBACK TO SAVEPOINT update_agent_session_transition'); } catch {}
      try { this.#db.exec('RELEASE SAVEPOINT update_agent_session_transition'); } catch {}
      throw error;
    }
  }
  heartbeatAgentSession(sessionId, { currentTurnId = null } = {}) {
    return this.updateAgentSession(sessionId, { heartbeat: true, currentTurnId });
  }
  listAgentSessions({ jobId = null, taskId = null, state = null, limit = 100 } = {}) {
    const clauses = []; const params = [];
    if (jobId) { clauses.push('job_id = ?'); params.push(jobId); }
    if (taskId) { clauses.push('task_id = ?'); params.push(taskId); }
    if (state) { clauses.push('state = ?'); params.push(state); }
    params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
    return this.#db.prepare(`SELECT * FROM agent_sessions ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...params);
  }
  getSessionAccess(accessId) {
    return this.#db.prepare('SELECT * FROM session_access WHERE access_id = ?').get(accessId) || null;
  }
  listSessionAccess(sessionId, { includeRevoked = false } = {}) {
    return this.#db.prepare(`SELECT * FROM session_access WHERE session_id = ? ${includeRevoked ? '' : 'AND revoked_at IS NULL'} ORDER BY created_at`).all(sessionId);
  }
  grantSessionAccess(sessionId, { accessorRole, permission = 'OBSERVE', grantedBy = null, expiresAt = null } = {}) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('sessionId must be a non-empty string');
    if (typeof accessorRole !== 'string' || !accessorRole.trim()) throw new Error('accessorRole must be a non-empty string');
    if (typeof permission !== 'string' || !permission.trim()) throw new Error('permission must be a non-empty string');
    if (typeof grantedBy !== 'string' || !grantedBy.trim()) throw new Error('grantedBy must be a non-empty string');
    if (expiresAt !== null) {
      if (typeof expiresAt !== 'string') throw new Error('expiresAt must be a canonical UTC timestamp or null');
      const expiryMs = Date.parse(expiresAt);
      if (!Number.isFinite(expiryMs) || new Date(expiryMs).toISOString() !== expiresAt) {
        throw new Error('expiresAt must be a canonical UTC timestamp or null');
      }
    }
    this.#db.exec('SAVEPOINT grant_session_access_transition');
    try {
      // Serialize grant decisions against revokes/renewals and ensure the row
      // change cannot survive if its audit event or readback fails.
      const sessionLock = this.#db.prepare('UPDATE agent_sessions SET updated_at=updated_at WHERE session_id=?').run(sessionId);
      if (sessionLock.changes !== 1) throw new Error(`Unknown agent session: ${sessionId}`);
      const session = this.getSession(sessionId);
      if (!session) throw new Error(`Unknown agent session: ${sessionId}`);
      const role = normalizeGovernanceRole(accessorRole);
      const perm = permission.toUpperCase();
      if (!role) throw new Error('accessorRole is required');
      if (!['OBSERVE', 'MESSAGE', 'EXECUTE', 'TAKEOVER'].includes(perm)) throw new Error(`Invalid session permission: ${perm}`);
      assertSessionGrantAuthority(grantedBy, role, perm);
      const existing = this.#db.prepare(`SELECT * FROM session_access
        WHERE session_id = ? AND accessor_role = ? AND permission = ? AND revoked_at IS NULL
        ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(sessionId, role, perm);
      let accessId;
      let eventType;
      let payload;
      let dedupeKey;
      if (existing) {
        if (existing.granted_by === grantedBy && existing.expires_at === expiresAt) {
          this.#db.exec('RELEASE SAVEPOINT grant_session_access_transition');
          return existing;
        }
        const update = this.#db.prepare('UPDATE session_access SET granted_by=?,expires_at=? WHERE access_id=? AND revoked_at IS NULL')
          .run(grantedBy, expiresAt, existing.access_id);
        if (update.changes !== 1) throw new Error('session access renewal lost its active-grant compare-and-set');
        accessId = existing.access_id;
        eventType = 'session.access_updated';
        payload = {
          accessId, sessionId, taskId: session.task_id, accessorRole: role, permission: perm,
          previousGrantedBy: existing.granted_by, previousExpiresAt: existing.expires_at,
          grantedBy, expiresAt
        };
        dedupeKey = `${accessId}|updated|${hash(JSON.stringify(payload))}`;
      } else {
        accessId = id('access'); const ts = now();
        this.#db.prepare(`INSERT INTO session_access(access_id, session_id, accessor_role, permission, granted_by, expires_at, created_at, revoked_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, NULL)`).run(accessId, sessionId, role, perm, grantedBy, expiresAt, ts);
        eventType = 'session.access_granted';
        payload = { accessId, sessionId, taskId: session.task_id, accessorRole: role, permission: perm, grantedBy, expiresAt };
        dedupeKey = accessId;
      }
      const eventIdValue = this.#workflowPort.recordEvent(session.job_id, eventType, payload, dedupeKey);
      const event = this.#workflowPort.getEvent(eventIdValue);
      const persisted = this.getSessionAccess(accessId);
      if (!event || event.event_id !== eventId(session.job_id, eventType, dedupeKey) || event.job_id !== session.job_id ||
          event.type !== eventType || event.payload_json !== JSON.stringify(payload) ||
          !persisted || persisted.session_id !== sessionId || persisted.accessor_role !== role || persisted.permission !== perm ||
          persisted.granted_by !== grantedBy || persisted.expires_at !== expiresAt || persisted.revoked_at !== null) {
        throw new Error('session access grant/event lineage readback failed');
      }
      this.#db.exec('RELEASE SAVEPOINT grant_session_access_transition');
      return persisted;
    } catch (error) {
      try { this.#db.exec('ROLLBACK TO SAVEPOINT grant_session_access_transition'); } catch {}
      try { this.#db.exec('RELEASE SAVEPOINT grant_session_access_transition'); } catch {}
      throw error;
    }
  }
  revokeSessionAccess(accessId, { actor = null } = {}) {
    if (typeof accessId !== 'string' || !accessId.trim()) throw new Error('accessId must be a non-empty string');
    if (typeof actor !== 'string' || !actor.trim()) throw new Error('revoke actor must be a non-empty string');
    this.#db.exec('SAVEPOINT revoke_session_access_transition');
    try {
      const accessLock = this.#db.prepare('UPDATE session_access SET revoked_at=revoked_at WHERE access_id=?').run(accessId);
      if (accessLock.changes !== 1) {
        this.#db.exec('RELEASE SAVEPOINT revoke_session_access_transition');
        return null;
      }
      const access = this.getSessionAccess(accessId);
      if (!access) throw new Error('session access disappeared during revoke');
      if (access.revoked_at) {
        this.#db.exec('RELEASE SAVEPOINT revoke_session_access_transition');
        return access;
      }
      const session = this.getSession(access.session_id);
      if (!session) throw new Error('session access refers to a missing session');
      assertSessionRevokeAuthority(actor, session.role, access.accessor_role, access.permission);
      const ts = now();
      const update = this.#db.prepare('UPDATE session_access SET revoked_at=? WHERE access_id=? AND revoked_at IS NULL').run(ts, accessId);
      if (update.changes !== 1) throw new Error('session access revoke lost its active-grant compare-and-set');
      const payload = {
        accessId, sessionId: session.session_id, taskId: session.task_id,
        accessorRole: access.accessor_role, permission: access.permission, actor, revokedAt: ts
      };
      const eventIdValue = this.#workflowPort.recordEvent(session.job_id, 'session.access_revoked', payload, accessId);
      const event = this.#workflowPort.getEvent(eventIdValue);
      const persisted = this.getSessionAccess(accessId);
      if (!event || event.event_id !== eventId(session.job_id, 'session.access_revoked', accessId) || event.job_id !== session.job_id ||
          event.type !== 'session.access_revoked' || event.payload_json !== JSON.stringify(payload) || persisted?.revoked_at !== ts) {
        throw new Error('session access revoke/event lineage readback failed');
      }
      this.#db.exec('RELEASE SAVEPOINT revoke_session_access_transition');
      return persisted;
    } catch (error) {
      try { this.#db.exec('ROLLBACK TO SAVEPOINT revoke_session_access_transition'); } catch {}
      try { this.#db.exec('RELEASE SAVEPOINT revoke_session_access_transition'); } catch {}
      throw error;
    }
  }
  hasSessionPermission(sessionId, accessorRole, permission, { at = new Date().toISOString() } = {}) {
    const session = this.getSession(sessionId); if (!session) return false;
    if (typeof accessorRole !== 'string' || !accessorRole.trim() || typeof permission !== 'string' || !permission.trim()) return false;
    const role = String(accessorRole || '').trim(); const perm = String(permission || '').toUpperCase();
    // Owner has implicit OBSERVE/MESSAGE/EXECUTE access. TAKEOVER is deliberately
    // never implicit: it changes ownership and requires an explicit grant.
    if (role === session.role && ['OBSERVE', 'MESSAGE', 'EXECUTE'].includes(perm)) return true;
    // SQLite's lexical timestamp comparison is unsafe for malformed durable
    // grant expiry values (e.g. 'zzzz' sorts after today's ISO timestamp and
    // accidentally grants an unbounded permission). Parse canonical UTC values
    // and compare epoch milliseconds; malformed time inputs fail closed.
    if (typeof at !== 'string') return false;
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) return false;
    try { if (new Date(atMs).toISOString() !== at) return false; } catch { return false; }
    const rows = this.#db.prepare(`SELECT expires_at FROM session_access
      WHERE session_id = ? AND accessor_role = ? AND permission = ? AND revoked_at IS NULL`)
      .all(sessionId, role, perm);
    for (const row of rows) {
      if (row.expires_at === null) return true;
      if (typeof row.expires_at !== 'string') continue;
      const expiryMs = Date.parse(row.expires_at);
      if (!Number.isFinite(expiryMs)) continue;
      try { if (new Date(expiryMs).toISOString() !== row.expires_at) continue; }
      catch { continue; }
      if (expiryMs > atMs) return true;
    }
    return false;
  }
  assertSessionPermission(sessionId, accessorRole, permission, options = {}) {
    if (!this.hasSessionPermission(sessionId, accessorRole, permission, options)) {
      throw new Error(`Session access denied: role=${accessorRole} permission=${String(permission).toUpperCase()} session=${sessionId}`);
    }
    return this.getSession(sessionId);
  }
  attachAgentSession(sessionId, { actorRole, mode = 'observe' } = {}) {
    const normalized = String(mode || 'observe').toUpperCase();
    const permission = normalized === 'INTERACT' ? 'MESSAGE' : normalized === 'TAKEOVER' ? 'TAKEOVER' : 'OBSERVE';
    const session = this.assertSessionPermission(sessionId, actorRole, permission);
    this.#workflowPort.recordEvent(session.job_id, 'session.attached', {
      sessionId, taskId: session.task_id, actorRole, mode: normalized, permission
    }, `${sessionId}|${actorRole}|${normalized}`);
    return { session, mode: normalized, permission };
  }
  takeoverAgentSession(sessionId, { actorRole, reason = 'session takeover' } = {}) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('sessionId must be a non-empty string');
    if (typeof actorRole !== 'string' || !actorRole.trim()) throw new Error('takeover actorRole must be a non-empty string');
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('takeover reason must be a non-empty string');
    this.#db.exec('SAVEPOINT takeover_agent_session_transition');
    try {
      // Hold the SQLite writer reservation before checking the TAKEOVER grant.
      // Without this lock, another process could revoke/expire the grant after
      // the check but before ownership is changed.
      const lock = this.#db.prepare('UPDATE agent_sessions SET updated_at=updated_at WHERE session_id=?').run(sessionId);
      if (lock.changes !== 1) throw new Error(`Unknown agent session: ${sessionId}`);
      const session = this.assertSessionPermission(sessionId, actorRole, 'TAKEOVER');
      if (normalizeGovernanceRole(session.role) === normalizeGovernanceRole(actorRole)) {
        throw new Error('Session owner cannot takeover its own session');
      }
      if (!['STALE', 'FAILED', 'PAUSED'].includes(session.state)) {
        throw new Error(`Session takeover requires PAUSED, STALE, or FAILED state; got ${session.state}`);
      }
      const updated = this.updateAgentSession(sessionId, { state: 'ACTIVE', heartbeat: true });
      const payload = { sessionId, taskId: session.task_id, fromRole: session.role, actorRole, reason };
      const eventKey = `${sessionId}|${actorRole}|takeover|${crypto.randomUUID()}`;
      const eventIdValue = this.#workflowPort.recordEvent(session.job_id, 'session.takeover', payload, eventKey);
      const event = this.#workflowPort.getEvent(eventIdValue);
      const persisted = this.getSession(sessionId);
      if (!event || event.event_id !== eventId(session.job_id, 'session.takeover', eventKey) || event.job_id !== session.job_id ||
          event.type !== 'session.takeover' || event.payload_json !== JSON.stringify(payload) || persisted?.state !== 'ACTIVE') {
        throw new Error('session takeover row/event lineage readback failed');
      }
      this.#db.exec('RELEASE SAVEPOINT takeover_agent_session_transition');
      return updated;
    } catch (error) {
      try { this.#db.exec('ROLLBACK TO SAVEPOINT takeover_agent_session_transition'); } catch {}
      try { this.#db.exec('RELEASE SAVEPOINT takeover_agent_session_transition'); } catch {}
      throw error;
    }
  }
  enqueueSessionMessage(sessionId, { senderRole, recipientRole, payload = {}, messageType = 'session.message', correlationId = null, dedupeKey = null, availableAt = null } = {}) {
    const sender = String(senderRole || '').trim();
    if (!sender) throw new Error('senderRole is required');
    const recipient = String(recipientRole || '').trim();
    if (!recipient) throw new Error('recipientRole is required');
    const type = String(messageType || 'session.message').trim();
    if (!type) throw new Error('messageType is required');
    if (correlationId != null && (typeof correlationId !== 'string' || !correlationId.trim())) throw new Error('correlationId must be a non-empty string or null');
    if (dedupeKey != null && (typeof dedupeKey !== 'string' || !dedupeKey.trim())) throw new Error('dedupeKey must be a non-empty string or null');
    if (availableAt != null && (typeof availableAt !== 'string' || !Number.isFinite(Date.parse(availableAt)) ||
        new Date(Date.parse(availableAt)).toISOString() !== availableAt)) throw new Error('availableAt must be a canonical UTC ISO-8601 timestamp');
    let detachedPayload;
    let detachedPayloadJson;
    try {
      detachedPayloadJson = JSON.stringify(payload);
      if (typeof detachedPayloadJson !== 'string') throw new Error('payload is not JSON serializable');
      detachedPayload = parseStrictJson(detachedPayloadJson);
    } catch (error) { throw new Error(`session message payload must be detached JSON: ${error.message}`); }
    if (!detachedPayload || typeof detachedPayload !== 'object' || Array.isArray(detachedPayload)) {
      throw new Error('session message payload must be a JSON object');
    }
    validatePayload(type, detachedPayload);

    // Pause competing callers immediately before writer reservation in tests.
    // The actual durable dedupe lookup deliberately happens only after the
    // writer reservation and a fresh permission/session read below.
    if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_SESSION_ENQUEUE_BARRIER_DIR) {
      const barrierDirectory = path.resolve(process.env.CHAT_ON_STEROIDS_TEST_SESSION_ENQUEUE_BARRIER_DIR);
      const readyPath = path.join(barrierDirectory, `${process.pid}.ready`);
      const releasePath = path.join(barrierDirectory, 'release');
      fs.writeFileSync(readyPath, `${sessionId}|${dedupeKey || ''}\n`, { flag: 'wx', mode: 0o600 });
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(releasePath)) {
        if (Date.now() >= deadline) throw new Error('test session-message enqueue barrier timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }

    this.#db.exec('SAVEPOINT enqueue_session_message_transition');
    try {
      const reservation = this.#db.prepare('UPDATE agent_sessions SET updated_at=updated_at WHERE session_id=?').run(sessionId);
      if (reservation.changes !== 1) throw new Error(`session not found while enqueueing durable message: ${sessionId}`);
      const session = this.getSession(sessionId);
      if (!session) throw new Error(`session not found while enqueueing durable message: ${sessionId}`);
      this.assertSessionPermission(sessionId, sender, 'MESSAGE');
      const ts = now();
      const readyAt = availableAt ?? ts;
      const makeQueuedPayload = messageId => ({
        messageId, sessionId, taskId: session.task_id, senderRole: sender, recipientRole: recipient,
        messageType: type, correlationId, dedupeKey
      });
      const validateOrRepairQueueEvent = row => {
        const expectedPayload = makeQueuedPayload(row.message_id);
        const expectedEventId = eventId(session.job_id, 'session.message_queued', row.message_id);
        const rows = this.listEventsForJob(session.job_id, 'session.message_queued');
        const matches = [];
        for (const event of rows) {
          let eventPayload;
          try { eventPayload = parseStrictJson(event.payload_json); }
          catch { throw new Error('session queue contains malformed session.message_queued event JSON'); }
          if (event.payload_json !== JSON.stringify(eventPayload)) throw new Error('session queue contains non-canonical session.message_queued event JSON');
          if (eventPayload?.messageId === row.message_id) matches.push({ event, payload: eventPayload });
        }
        if (matches.length > 1) throw new Error('session enqueue found duplicate logical session.message_queued events');
        if (matches.length === 0) {
          const occupied = this.#workflowPort.getEvent(expectedEventId);
          if (occupied) throw new Error('session queue deterministic event ID is occupied by conflicting durable evidence');
          this.#workflowPort.recordEvent(session.job_id, 'session.message_queued', expectedPayload, row.message_id);
          if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_MESSAGE_EVENT_INSERT === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
        } else if (matches[0].event.event_id !== expectedEventId || matches[0].event.job_id !== session.job_id ||
            matches[0].event.type !== 'session.message_queued' || matches[0].event.payload_json !== JSON.stringify(expectedPayload)) {
          throw new Error('existing session.message_queued event conflicts with the exact durable message identity');
        }
        const finalRows = this.listEventsForJob(session.job_id, 'session.message_queued');
        const finalMatches = finalRows.filter(event => {
          try { return parseStrictJson(event.payload_json)?.messageId === row.message_id; } catch { return false; }
        });
        if (finalMatches.length !== 1 || finalMatches[0].event_id !== expectedEventId || finalMatches[0].job_id !== session.job_id ||
            finalMatches[0].type !== 'session.message_queued' || finalMatches[0].payload_json !== JSON.stringify(expectedPayload)) {
          throw new Error('session enqueue row/event readback or cardinality failed');
        }
        return expectedPayload;
      };

      const existingRows = dedupeKey == null ? [] : this.#db.prepare('SELECT * FROM session_messages WHERE session_id=? AND dedupe_key=? ORDER BY rowid').all(sessionId, dedupeKey);
      if (existingRows.length > 1) throw new Error('session enqueue found multiple rows for one dedupe key');
      if (existingRows.length === 1) {
        const existing = existingRows[0];
        const sameContract = existing.session_id === sessionId && existing.sender_role === sender &&
          existing.recipient_role === recipient && existing.protocol === 'cos-ap' && Number(existing.protocol_version) === 1 &&
          existing.message_type === type && existing.payload_json === detachedPayloadJson &&
          existing.correlation_id === correlationId && existing.dedupe_key === dedupeKey &&
          (availableAt == null || existing.available_at === availableAt);
        if (!sameContract) throw new Error('session enqueue dedupe key conflicts with existing durable message payload/sender/recipient contract');
        validateOrRepairQueueEvent(existing);
        const persisted = this.getSessionMessage(existing.message_id);
        if (!persisted || persisted.message_id !== existing.message_id || persisted.session_id !== sessionId ||
            persisted.sender_role !== sender || persisted.recipient_role !== recipient || persisted.message_type !== type ||
            persisted.payload_json !== detachedPayloadJson || persisted.dedupe_key !== dedupeKey) {
          throw new Error('session enqueue idempotent row readback failed');
        }
        this.#db.exec('RELEASE SAVEPOINT enqueue_session_message_transition');
        return persisted;
      }

      const messageId = id('msg');
      const envelope = createEnvelope({ messageId, messageType: type, jobId: session.job_id, taskId: session.task_id || null,
        attempt: 1, sender, recipient, correlationId, payload: detachedPayload, createdAt: ts });
      validateEnvelope(envelope);
      const persistedPayloadJson = JSON.stringify(envelope.payload);
      if (persistedPayloadJson !== detachedPayloadJson) throw new Error('session enqueue envelope changed exact payload bytes during validation');
      this.#db.prepare(`INSERT INTO session_messages(
        message_id,session_id,sender_role,recipient_role,protocol,protocol_version,message_type,payload_json,
        correlation_id,dedupe_key,status,attempt,available_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,'QUEUED',0,?,?,?)`)
        .run(messageId, sessionId, sender, recipient, envelope.protocol, envelope.version, envelope.message_type,
          persistedPayloadJson, correlationId, dedupeKey, readyAt, ts, ts);
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_MESSAGE_INSERT === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
      validateOrRepairQueueEvent({ message_id: messageId });
      const persisted = this.getSessionMessage(messageId);
      if (!persisted || persisted.message_id !== messageId || persisted.session_id !== sessionId || persisted.sender_role !== sender ||
          persisted.recipient_role !== recipient || persisted.protocol !== envelope.protocol || persisted.protocol_version !== envelope.version ||
          persisted.message_type !== type || persisted.payload_json !== persistedPayloadJson || persisted.correlation_id !== correlationId ||
          persisted.dedupe_key !== dedupeKey || persisted.status !== 'QUEUED' || typeof persisted.attempt !== 'number' || persisted.attempt !== 0 ||
          persisted.available_at !== readyAt || persisted.created_at !== ts || persisted.updated_at !== ts) {
        throw new Error('session enqueue exact durable row readback failed');
      }
      this.#db.exec('RELEASE SAVEPOINT enqueue_session_message_transition');
      return persisted;
    } catch (failure) {
      try { this.#db.exec('ROLLBACK TO SAVEPOINT enqueue_session_message_transition'); } catch {}
      try { this.#db.exec('RELEASE SAVEPOINT enqueue_session_message_transition'); } catch {}
      throw failure;
    }
  }
  getSessionMessage(messageId) {
    return this.#db.prepare('SELECT * FROM session_messages WHERE message_id = ?').get(messageId) || null;
  }
  listSessionMessages(sessionId, { recipientRole = null, status = null, limit = 100 } = {}) {
    const clauses = ['session_id = ?']; const params = [sessionId];
    if (recipientRole) { clauses.push('recipient_role = ?'); params.push(recipientRole); }
    if (status) { clauses.push('status = ?'); params.push(String(status).toUpperCase()); }
    params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
    return this.#db.prepare(`SELECT * FROM session_messages WHERE ${clauses.join(' AND ')} ORDER BY created_at, rowid LIMIT ?`).all(...params);
  }
  claimSessionMessage(messageId, { recipientRole, leaseMs = 60_000 } = {}) {
    const message = this.getSessionMessage(messageId);
    if (!message) return null;
    if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_SESSION_CLAIM_BARRIER_DIR) {
      const barrierDirectory = path.resolve(process.env.CHAT_ON_STEROIDS_TEST_SESSION_CLAIM_BARRIER_DIR);
      const readyPath = path.join(barrierDirectory, `${process.pid}.ready`);
      const releasePath = path.join(barrierDirectory, 'release');
      fs.writeFileSync(readyPath, `${messageId}|${message.status}|${message.attempt}\n`, { flag: 'wx', mode: 0o600 });
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(releasePath)) {
        if (Date.now() >= deadline) throw new Error('test session-message claim barrier timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    this.#db.exec('SAVEPOINT claim_session_message_transition');
    try {
      // Acquire SQLite's writer reservation before checking recipient permission,
      // status or lease. The old read-then-update flow let two processes observe
      // QUEUED and both increment attempt + dispatch the external transport.
      const reservation = this.#db.prepare('UPDATE session_messages SET updated_at=updated_at WHERE message_id=?').run(messageId);
      if (reservation.changes !== 1) {
        this.#db.exec('RELEASE SAVEPOINT claim_session_message_transition');
        return null;
      }
      const current = this.getSessionMessage(messageId);
      if (!current) throw new Error(`session message disappeared during claim: ${messageId}`);
      if (typeof current.attempt !== 'number' || !Number.isSafeInteger(current.attempt) || current.attempt < 0) {
        throw new Error(`session message has a malformed durable attempt: ${messageId}`);
      }
      this.assertSessionPermission(current.session_id, recipientRole, 'MESSAGE');
      if (current.recipient_role !== recipientRole) throw new Error(`Message recipient mismatch: expected=${current.recipient_role} got=${recipientRole}`);
      const ts = now();
      if (current.status === 'ACKED' || current.status === 'FAILED' || current.last_error?.startsWith('DELIVERY_UNCERTAIN:')) {
        this.#db.exec('RELEASE SAVEPOINT claim_session_message_transition');
        return { ...current, claimAcquired: false };
      }
      if (current.status === 'DELIVERED' && current.lease_until && current.lease_until > ts) {
        this.#db.exec('RELEASE SAVEPOINT claim_session_message_transition');
        return { ...current, claimAcquired: false };
      }
      if (current.status === 'DELIVERED' && (!current.lease_until || current.lease_until <= ts)) {
        const session = this.getSession(current.session_id);
        if (!session) throw new Error(`session missing while reclaiming an expired lease: ${messageId}`);
        const startKey = `${messageId}|${current.attempt}`;
        const expectedStartId = eventId(session.job_id, 'session.message_delivery_started', startKey);
        const startRows = this.listEventsForJob(session.job_id, 'session.message_delivery_started');
        const started = [];
        let corruptStartLedger = false;
        for (const row of startRows) {
          let payload;
          try { payload = parseStrictJson(row.payload_json); }
          catch { corruptStartLedger = true; break; }
          if (row.payload_json !== JSON.stringify(payload)) { corruptStartLedger = true; break; }
          if (payload?.messageId === messageId && typeof payload.attempt === 'number' && payload.attempt === current.attempt) started.push({ row, payload });
        }
        const exactStart = started.length === 1 && started[0].row.event_id === expectedStartId &&
          started[0].row.job_id === session.job_id && started[0].row.type === 'session.message_delivery_started' &&
          Object.keys(started[0].payload).sort().join(',') === 'attempt,idempotencyKey,leaseUntil,messageId,recipientRole,sessionId,startedAt' &&
          started[0].payload.sessionId === current.session_id && started[0].payload.recipientRole === current.recipient_role &&
          started[0].payload.idempotencyKey === messageId && typeof started[0].payload.startedAt === 'string' &&
          started[0].payload.attempt === current.attempt;
        if (corruptStartLedger || started.length > 0) {
          // An expired lease with a durable transport-start marker (or a
          // malformed marker ledger) may already have produced an external
          // side effect. Never hand that attempt to another sender.
          const uncertain = this.#deliveryHooks.markSessionMessageDeliveryUncertain(messageId, {
            attempt: current.attempt, leaseUntil: current.lease_until,
            phase: corruptStartLedger || !exactStart ? 'claim_found_corrupt_transport_start_ledger' : 'expired_lease_after_transport_start',
            error: corruptStartLedger || !exactStart
              ? 'transport-start event ledger is malformed, duplicated, or detached'
              : 'delivery lease expired after durable transport-start intent; external outcome may be unknown'
          });
          this.#db.exec('RELEASE SAVEPOINT claim_session_message_transition');
          return { ...uncertain, claimAcquired: false };
        }
      }
      if (!['QUEUED', 'DELIVERED'].includes(current.status) || current.available_at > ts) {
        this.#db.exec('RELEASE SAVEPOINT claim_session_message_transition');
        return { ...current, claimAcquired: false };
      }
      const leaseUntil = new Date(Date.now() + Math.max(1, Number(leaseMs) || 60_000)).toISOString();
      const updatedClaim = this.#db.prepare(`UPDATE session_messages
        SET status='DELIVERED',attempt=attempt+1,delivered_at=?,lease_until=?,updated_at=?
        WHERE message_id=? AND status=? AND attempt=? AND available_at<=?
          AND (status='QUEUED' OR lease_until IS NULL OR lease_until<=?)`)
        .run(ts, leaseUntil, ts, messageId, current.status, current.attempt, ts, ts);
      if (updatedClaim.changes !== 1) {
        const latest = this.getSessionMessage(messageId);
        this.#db.exec('RELEASE SAVEPOINT claim_session_message_transition');
        return latest ? { ...latest, claimAcquired: false } : null;
      }
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_CLAIM_UPDATE === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
      const updated = this.getSessionMessage(messageId);
      const session = this.getSession(updated.session_id);
      if (!session) throw new Error(`session message session no longer exists: ${messageId}`);
      const payload = { messageId, sessionId: updated.session_id, recipientRole, attempt: updated.attempt, leaseUntil };
      const expectedEventId = eventId(session.job_id, 'session.message_delivered', `${messageId}|${updated.attempt}`);
      this.#workflowPort.recordEvent(session.job_id, 'session.message_delivered', payload, `${messageId}|${updated.attempt}`);
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_CLAIM_EVENT === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
      const matchingEvents = [];
      for (const row of this.listEventsForJob(session.job_id, 'session.message_delivered')) {
        let existingPayload;
        try { existingPayload = parseStrictJson(row.payload_json); }
        catch { throw new Error('session delivery claim found malformed durable delivery event'); }
        if (row.payload_json !== JSON.stringify(existingPayload)) throw new Error('session delivery claim found non-canonical delivery event JSON');
        if (existingPayload?.messageId === messageId && typeof existingPayload.attempt === 'number' && existingPayload.attempt === updated.attempt) {
          matchingEvents.push({ row, payload: existingPayload });
        }
      }
      const persisted = this.getSessionMessage(messageId);
      if (typeof updated.attempt !== 'number' || !Number.isSafeInteger(updated.attempt) || updated.attempt !== current.attempt + 1 ||
          matchingEvents.length !== 1 || matchingEvents[0].row.event_id !== expectedEventId ||
          matchingEvents[0].row.job_id !== session.job_id || matchingEvents[0].row.type !== 'session.message_delivered' ||
          matchingEvents[0].row.payload_json !== JSON.stringify(payload) || persisted?.status !== 'DELIVERED' ||
          typeof persisted.attempt !== 'number' || persisted.attempt !== updated.attempt || persisted.lease_until !== leaseUntil ||
          persisted.session_id !== updated.session_id || persisted.recipient_role !== recipientRole) {
        throw new Error('session delivery claim did not reconcile one exact lease row and canonical delivery event');
      }
      this.#db.exec('RELEASE SAVEPOINT claim_session_message_transition');
      return { ...persisted, claimAcquired: true };
    } catch (failure) {
      try { this.#db.exec('ROLLBACK TO SAVEPOINT claim_session_message_transition'); } catch {}
      try { this.#db.exec('RELEASE SAVEPOINT claim_session_message_transition'); } catch {}
      throw failure;
    }
  }
  claimNextSessionMessage(sessionId, { recipientRole, leaseMs = 60_000 } = {}) {
    this.assertSessionPermission(sessionId, recipientRole, 'MESSAGE');
    const ts = now();
    const message = this.#db.prepare(`SELECT * FROM session_messages
      WHERE session_id = ? AND recipient_role = ? AND status IN ('QUEUED','DELIVERED')
        AND available_at <= ? AND (status = 'QUEUED' OR lease_until IS NULL OR lease_until <= ?)
      ORDER BY created_at ASC, rowid ASC LIMIT 1`).get(sessionId, recipientRole, ts, ts);
    return message ? this.claimSessionMessage(message.message_id, { recipientRole, leaseMs }) : null;
  }
  deliverNextSessionMessage(sessionId, { recipientRole, transport, deliveryOptions = {} } = {}) {
    if (typeof transport !== 'function') throw new TypeError('session delivery transport must be a function');
    this.assertSessionPermission(sessionId, recipientRole, 'MESSAGE');
    // Select without claiming: deliverSessionMessage owns the single atomic
    // claim immediately before recording transport-start intent. Pre-claiming
    // here would leave a live DELIVERED lease that the managed sender then
    // correctly refuses to claim a second time, silently suppressing delivery.
    const message = this.#db.prepare(`SELECT * FROM session_messages
      WHERE session_id = ? AND recipient_role = ? AND status = 'QUEUED' AND available_at <= ?
      ORDER BY created_at ASC, rowid ASC LIMIT 1`).get(sessionId, recipientRole, now());
    if (!message) return Promise.resolve(null);
    return this.deliverSessionMessage(message.message_id, transport, deliveryOptions);
  }
  assertDurableSuccessfulSessionReceipt(message, session, { allowClearedLease = false } = {}) {
    if (typeof message.attempt !== 'number' || !Number.isSafeInteger(message.attempt) || message.attempt < 1) {
      throw new Error('session successful receipt has a malformed durable delivery attempt');
    }
    const startKey = `${message.message_id}|${message.attempt}`;
    const startId = eventId(session.job_id, 'session.message_delivery_started', startKey);
    const allStarts = this.listEventsForJob(session.job_id, 'session.message_delivery_started');
    const startMatches = [];
    for (const row of allStarts) {
      let payload;
      try { payload = parseStrictJson(row.payload_json); }
      catch { throw new Error('session delivery started ledger contains malformed JSON'); }
      if (row.payload_json !== JSON.stringify(payload)) throw new Error('session delivery started ledger is non-canonical');
      if (payload?.messageId === message.message_id && typeof payload.attempt === 'number' && payload.attempt === message.attempt) startMatches.push({ row, payload });
    }
    if (startMatches.length !== 1 || startMatches[0].row.event_id !== startId ||
        startMatches[0].row.job_id !== session.job_id || startMatches[0].row.type !== 'session.message_delivery_started' ||
        Object.keys(startMatches[0].payload).sort().join(',') !== 'attempt,idempotencyKey,leaseUntil,messageId,recipientRole,sessionId,startedAt' ||
        startMatches[0].payload.messageId !== message.message_id || startMatches[0].payload.sessionId !== message.session_id ||
        startMatches[0].payload.recipientRole !== message.recipient_role || startMatches[0].payload.attempt !== message.attempt ||
        startMatches[0].payload.idempotencyKey !== message.message_id || typeof startMatches[0].payload.leaseUntil !== 'string' ||
        (!allowClearedLease && startMatches[0].payload.leaseUntil !== message.lease_until) ||
        typeof startMatches[0].payload.startedAt !== 'string') {
      throw new Error('session successful receipt lacks one exact canonical transport-start lineage event');
    }

    const allReceipts = this.listEventsForJob(session.job_id, 'session.message_receipt');
    const receiptMatches = [];
    for (const row of allReceipts) {
      let payload;
      try { payload = parseStrictJson(row.payload_json); }
      catch { throw new Error('session delivery receipt ledger contains malformed JSON'); }
      if (row.payload_json !== JSON.stringify(payload)) throw new Error('session delivery receipt ledger is non-canonical');
      if (payload?.messageId === message.message_id && typeof payload.attempt === 'number' && payload.attempt === message.attempt) receiptMatches.push({ row, payload });
    }
    if (receiptMatches.length !== 1) throw new Error('session successful receipt recovery requires exactly one durable receipt for the current attempt');
    const { row, payload } = receiptMatches[0];
    const receiptId = eventId(session.job_id, 'session.message_receipt', `${message.message_id}|${message.attempt}|${payload.status}`);
    const receiptKeys = 'attempt,error,messageId,recordedAt,response,runId,sessionKey,status';
    const hasRunId = (typeof payload.runId === 'string' && payload.runId.trim().length > 0) ||
      (typeof payload.runId === 'number' && Number.isFinite(payload.runId));
    const recordedAt = Date.parse(payload.recordedAt);
    const startedAt = Date.parse(startMatches[0].payload.startedAt);
    const eventOrder = Date.parse(row.created_at) >= Date.parse(startMatches[0].row.created_at);
    if (row.event_id !== receiptId || row.job_id !== session.job_id || row.type !== 'session.message_receipt' ||
        Object.keys(payload).sort().join(',') !== receiptKeys || payload.messageId !== message.message_id ||
        typeof payload.attempt !== 'number' || payload.attempt !== message.attempt || payload.status !== 'OK' ||
        !hasRunId || payload.error !== null || payload.sessionKey !== session.openclaw_session_key ||
        !Number.isFinite(recordedAt) || new Date(recordedAt).toISOString() !== payload.recordedAt ||
        !Number.isFinite(startedAt) || !eventOrder || Date.parse(row.created_at) < Date.parse(startMatches[0].row.created_at)) {
      throw new Error('session success receipt does not bind exact message/session/attempt and chronological transport-start lineage');
    }
    return payload;
  }

  ackSessionMessage(messageId, { recipientRole, correlationId = null, expectedAttempt = null, expectedLeaseUntil = null,
    allowExpiredLeaseWithDurableReceipt = false } = {}) {
    this.#db.exec('SAVEPOINT ack_session_message_transition');
    try {
      const reservation = this.#db.prepare('UPDATE session_messages SET updated_at=updated_at WHERE message_id=?').run(messageId);
      if (reservation.changes !== 1) {
        this.#db.exec('RELEASE SAVEPOINT ack_session_message_transition');
        return null;
      }
      const message = this.getSessionMessage(messageId);
      if (!message) throw new Error(`session message not found: ${messageId}`);
      if (typeof message.attempt !== 'number' || !Number.isSafeInteger(message.attempt) || message.attempt < 0) {
        throw new Error(`session message ACK refuses a malformed durable attempt: ${messageId}`);
      }
      this.assertSessionPermission(message.session_id, recipientRole, 'MESSAGE');
      if (message.recipient_role !== recipientRole) throw new Error(`Message recipient mismatch: expected=${message.recipient_role} got=${recipientRole}`);
      const session = this.getSession(message.session_id);
      if (!session) throw new Error(`session not found for ACKed message: ${messageId}`);
      const expectedPayload = {
        messageId, sessionId: message.session_id, recipientRole, attempt: message.attempt,
        correlationId: correlationId || message.correlation_id
      };
      const expectedId = eventId(session.job_id, 'session.message_acked', messageId);
      const matchingEvents = [];
      for (const row of this.listEventsForJob(session.job_id, 'session.message_acked')) {
        let payload;
        try { payload = parseStrictJson(row.payload_json); }
        catch { throw new Error('session message ACK found malformed durable ACK event'); }
        if (row.payload_json !== JSON.stringify(payload)) throw new Error('session message ACK found non-canonical ACK event JSON');
        if (payload?.messageId === messageId) matchingEvents.push({ row, payload });
      }
      if (message.status === 'ACKED') {
        if (matchingEvents.length !== 1 || matchingEvents[0].row.event_id !== expectedId ||
            matchingEvents[0].row.payload_json !== JSON.stringify(expectedPayload)) {
          throw new Error('idempotent ACK readback is missing or conflicts with exact durable ACK lineage');
        }
        this.assertDurableSuccessfulSessionReceipt(message, session, { allowClearedLease: true });
        this.#db.exec('RELEASE SAVEPOINT ack_session_message_transition');
        return { ...message, ackAcquired: false };
      }
      if (message.status !== 'DELIVERED') throw new Error(`Message cannot be ACKed from state ${message.status}`);
      if (expectedAttempt !== null && (typeof expectedAttempt !== 'number' || !Number.isSafeInteger(expectedAttempt) || expectedAttempt !== message.attempt)) {
        throw new Error('message ACK belongs to a stale or malformed delivery attempt');
      }
      if (expectedLeaseUntil !== null && message.lease_until !== expectedLeaseUntil) {
        throw new Error('message ACK belongs to a replaced delivery lease');
      }
      const leaseExpired = !message.lease_until || message.lease_until <= now();
      if (leaseExpired) {
        if (allowExpiredLeaseWithDurableReceipt !== true) throw new Error('message ACK delivery lease expired before durable acknowledgement');
      }
      // ACK is a terminal delivery transition, not a caller assertion. Require
      // the exact successful receipt and transport-start lineage for both the
      // live fast path and expired-lease recovery; previously only recovery
      // validated this proof, allowing direct callers to ACK an unreceipted send.
      this.assertDurableSuccessfulSessionReceipt(message, session);
      const ts = now();
      const ackUpdate = leaseExpired
        ? this.#db.prepare(`UPDATE session_messages SET status='ACKED',acked_at=?,lease_until=NULL,updated_at=?
            WHERE message_id=? AND status='DELIVERED' AND attempt=? AND lease_until=?`)
          .run(ts, ts, messageId, message.attempt, message.lease_until)
        : this.#db.prepare(`UPDATE session_messages SET status='ACKED',acked_at=?,lease_until=NULL,updated_at=?
            WHERE message_id=? AND status='DELIVERED' AND attempt=? AND lease_until=? AND lease_until>?`)
          .run(ts, ts, messageId, message.attempt, message.lease_until, ts);
      const updatedCount = ackUpdate.changes;
      if (updatedCount !== 1) throw new Error('message ACK lost compare-and-set ownership of its exact lease');
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_ACK_UPDATE === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
      this.#workflowPort.recordEvent(session.job_id, 'session.message_acked', expectedPayload, messageId);
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_ACK_EVENT === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
      const rows = this.listEventsForJob(session.job_id, 'session.message_acked');
      const finalMatches = rows.filter(row => {
        try { return parseStrictJson(row.payload_json)?.messageId === messageId; } catch { return false; }
      });
      const persisted = this.getSessionMessage(messageId);
      if (finalMatches.length !== 1 || finalMatches[0].event_id !== expectedId || finalMatches[0].job_id !== session.job_id ||
          finalMatches[0].type !== 'session.message_acked' || finalMatches[0].payload_json !== JSON.stringify(expectedPayload) ||
          persisted?.status !== 'ACKED' || typeof persisted.attempt !== 'number' || persisted.attempt !== message.attempt || persisted.acked_at !== ts || persisted.lease_until !== null) {
        throw new Error('session message ACK row/event exact readback failed');
      }
      this.#db.exec('RELEASE SAVEPOINT ack_session_message_transition');
      return { ...persisted, ackAcquired: true };
    } catch (failure) {
      try { this.#db.exec('ROLLBACK TO SAVEPOINT ack_session_message_transition'); } catch {}
      try { this.#db.exec('RELEASE SAVEPOINT ack_session_message_transition'); } catch {}
      throw failure;
    }
  }

  markSessionMessageDeliveryUncertain(messageId, { attempt, leaseUntil = null, phase, error } = {}) {
    if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1) {
      throw new Error('delivery uncertainty requires an exact positive safe-integer attempt');
    }
    const normalizedPhase = String(phase || 'delivery_outcome_unknown');
    const errorText = String(error?.message || error || 'external delivery outcome is unknown').slice(0, 1000);
    const uncertainError = `DELIVERY_UNCERTAIN: phase=${normalizedPhase}; attempt=${attempt}; ${errorText}`;
    this.#db.exec('SAVEPOINT session_delivery_uncertain_transition');
    try {
      const reservation = this.#db.prepare('UPDATE session_messages SET updated_at=updated_at WHERE message_id=?').run(messageId);
      if (reservation.changes !== 1) throw new Error(`cannot mark missing session message delivery uncertain: ${messageId}`);
      const message = this.getSessionMessage(messageId);
      if (typeof message?.attempt !== 'number' || !Number.isSafeInteger(message.attempt) || message.attempt < 1) {
        throw new Error(`cannot quarantine uncertain delivery with malformed durable message attempt: ${messageId}`);
      }
      const session = this.getSession(message.session_id);
      if (!session) throw new Error(`cannot mark uncertain delivery without its session: ${messageId}`);
      if (message.status === 'ACKED') {
        // A late uncertainty callback is a no-op only if the already-terminal
        // ACK and its successful receipt still reconcile exactly.
        this.#deliveryHooks.ackSessionMessage(messageId, { recipientRole: message.recipient_role });
        this.#db.exec('RELEASE SAVEPOINT session_delivery_uncertain_transition');
        return message;
      }
      if (message.attempt !== attempt || !['DELIVERED', 'FAILED'].includes(message.status)) {
        throw new Error(`cannot mark a replaced session delivery attempt uncertain: ${messageId}`);
      }
      if (leaseUntil !== null && message.lease_until !== leaseUntil) {
        throw new Error(`cannot mark a replaced session delivery lease uncertain: ${messageId}`);
      }
      if (message.status === 'FAILED' && message.last_error?.startsWith('DELIVERY_UNCERTAIN:')) {
        const expectedId = eventId(session.job_id, 'session.message_delivery_uncertain', `${messageId}|${attempt}`);
        const rows = this.listEventsForJob(session.job_id, 'session.message_delivery_uncertain');
        const matches = [];
        for (const row of rows) {
          let payload;
          try { payload = parseStrictJson(row.payload_json); }
          catch { throw new Error('existing delivery-uncertain ledger contains malformed JSON'); }
          if (row.payload_json !== JSON.stringify(payload)) throw new Error('existing delivery-uncertain ledger is non-canonical');
          if (payload?.messageId === messageId && typeof payload.attempt === 'number' && payload.attempt === attempt) matches.push({ row, payload });
        }
        if (matches.length !== 1 || matches[0].row.event_id !== expectedId || matches[0].row.job_id !== session.job_id ||
            matches[0].row.type !== 'session.message_delivery_uncertain' ||
            Object.keys(matches[0].payload).sort().join(',') !== 'attempt,error,idempotencyKey,markedAt,messageId,outcome,phase,recipientRole,sessionId' ||
            matches[0].payload.sessionId !== message.session_id || matches[0].payload.recipientRole !== message.recipient_role ||
            matches[0].payload.idempotencyKey !== message.message_id || matches[0].payload.outcome !== 'unknown' ||
            message.last_error !== `DELIVERY_UNCERTAIN: phase=${matches[0].payload.phase}; attempt=${attempt}; ${matches[0].payload.error}`) {
          throw new Error('existing delivery-uncertain status does not reconcile to one exact durable uncertainty event');
        }
        this.#db.exec('RELEASE SAVEPOINT session_delivery_uncertain_transition');
        return message;
      }
      const ts = now();
      const changed = this.#db.prepare(`UPDATE session_messages SET status='FAILED',last_error=?,lease_until=NULL,updated_at=?
        WHERE message_id=? AND status=? AND attempt=? AND lease_until IS ?`)
        .run(uncertainError, ts, messageId, message.status, message.attempt, message.lease_until ?? null);
      if (changed.changes !== 1) throw new Error(`delivery-uncertain marking lost ownership of message ${messageId}`);
      const payload = {
        messageId, sessionId: message.session_id, recipientRole: message.recipient_role,
        attempt, phase: normalizedPhase, outcome: 'unknown',
        idempotencyKey: message.message_id, error: errorText, markedAt: ts
      };
      const key = `${messageId}|${attempt}`;
      const expectedId = eventId(session.job_id, 'session.message_delivery_uncertain', key);
      this.#workflowPort.recordEvent(session.job_id, 'session.message_delivery_uncertain', payload, key);
      const rows = this.listEventsForJob(session.job_id, 'session.message_delivery_uncertain');
      const matches = [];
      for (const row of rows) {
        let existing;
        try { existing = parseStrictJson(row.payload_json); }
        catch { throw new Error('delivery-uncertain event ledger contains malformed JSON'); }
        if (row.payload_json !== JSON.stringify(existing)) throw new Error('delivery-uncertain event ledger contains non-canonical JSON');
        if (existing?.messageId === messageId && typeof existing.attempt === 'number' && existing.attempt === attempt) matches.push({ row, payload: existing });
      }
      const persisted = this.getSessionMessage(messageId);
      if (matches.length !== 1 || matches[0].row.event_id !== expectedId || matches[0].row.job_id !== session.job_id ||
          matches[0].row.type !== 'session.message_delivery_uncertain' || matches[0].row.payload_json !== JSON.stringify(payload) ||
          persisted?.status !== 'FAILED' ||
          persisted.last_error !== uncertainError || persisted.lease_until !== null || typeof persisted.attempt !== 'number' || persisted.attempt !== attempt) {
        throw new Error('delivery-uncertain state/event readback failed');
      }
      this.#db.exec('RELEASE SAVEPOINT session_delivery_uncertain_transition');
      return persisted;
    } catch (failure) {
      try { this.#db.exec('ROLLBACK TO SAVEPOINT session_delivery_uncertain_transition'); } catch {}
      try { this.#db.exec('RELEASE SAVEPOINT session_delivery_uncertain_transition'); } catch {}
      // Best-effort fail-closed fallback: even if the uncertainty event itself
      // cannot be written, durably prevent automatic replay of the attempt whose
      // external side effect may already have happened. This is not joint
      // transactionality across SQLite and the external transport.
      try {
        const current = this.getSessionMessage(messageId);
        if (current && typeof current.attempt === 'number' && current.attempt === attempt && current.status === 'DELIVERED') {
          const fallbackError = `DELIVERY_UNCERTAIN: phase=${normalizedPhase}; durable uncertainty event failed; ${errorText}; ledgerError=${String(failure?.message || failure).slice(0, 300)}`;
          this.#db.prepare("UPDATE session_messages SET status='FAILED',last_error=?,lease_until=NULL,updated_at=? WHERE message_id=? AND status='DELIVERED' AND attempt=?")
            .run(fallbackError, now(), messageId, attempt);
        }
      } catch {}
      throw failure;
    }
  }

  retrySessionMessage(messageId, { error = 'delivery lease expired', delayMs = null, maxAttempts = 5, baseDelayMs = 1000, maxDelayMs = 60_000 } = {}) {
    this.#db.exec('SAVEPOINT retry_session_message_transition');
    try {
      const reservation = this.#db.prepare('UPDATE session_messages SET updated_at=updated_at WHERE message_id=?').run(messageId);
      if (reservation.changes !== 1) {
        this.#db.exec('RELEASE SAVEPOINT retry_session_message_transition');
        return null;
      }
      const message = this.getSessionMessage(messageId);
      if (!message) {
        this.#db.exec('RELEASE SAVEPOINT retry_session_message_transition');
        return null;
      }
      if (message.status === 'ACKED') {
        // Stale retry/reaper callbacks must not silently bless a corrupted
        // terminal ACK projection; reuse the exact idempotent ACK verifier.
        this.#deliveryHooks.ackSessionMessage(messageId, { recipientRole: message.recipient_role });
        this.#db.exec('RELEASE SAVEPOINT retry_session_message_transition');
        return message;
      }
      if (message.last_error?.startsWith('DELIVERY_UNCERTAIN:') || !['DELIVERED', 'FAILED'].includes(message.status)) {
        this.#db.exec('RELEASE SAVEPOINT retry_session_message_transition');
        return message;
      }
      if (typeof message.attempt !== 'number' || !Number.isSafeInteger(message.attempt) || message.attempt < 1) {
        throw new Error(`session retry refuses a malformed durable delivery attempt: ${messageId}`);
      }
      const session = this.getSession(message.session_id);
      if (!session) throw new Error(`session missing during delivery retry: ${messageId}`);
      const logicalEvent = (type, key, payload) => {
        const expectedId = eventId(session.job_id, type, key);
        const rows = this.listEventsForJob(session.job_id, type);
        const matches = [];
        for (const row of rows) {
          let eventPayload;
          try { eventPayload = parseStrictJson(row.payload_json); }
          catch { throw new Error(`session retry found malformed ${type} event JSON`); }
          if (row.payload_json !== JSON.stringify(eventPayload)) throw new Error(`session retry found non-canonical ${type} event JSON`);
          const sameLogicalTransition = eventPayload?.messageId === messageId &&
            typeof eventPayload.attempt === 'number' && eventPayload.attempt === payload.attempt &&
            (type !== 'session.message_retry' || eventPayload?.availableAt === payload.availableAt);
          if (sameLogicalTransition) matches.push({ row, payload: eventPayload });
        }
        if (matches.length > 1) throw new Error(`session retry found duplicate logical ${type} events`);
        if (matches.length === 1) {
          const { row, payload: storedPayload } = matches[0];
          if (row.event_id !== expectedId || row.job_id !== session.job_id || row.type !== type ||
              row.payload_json !== JSON.stringify(payload) || JSON.stringify(storedPayload) !== JSON.stringify(payload)) {
            throw new Error(`session retry existing ${type} event conflicts with exact durable transition payload`);
          }
        } else {
          const occupied = this.#workflowPort.getEvent(expectedId);
          if (occupied) throw new Error(`session retry deterministic ${type} event ID is occupied by conflicting evidence`);
          this.#workflowPort.recordEvent(session.job_id, type, payload, key);
          if (process.env.NODE_ENV === 'test' && type === 'session.message_retry' &&
              process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_RETRY_EVENT_INSERT === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
        }
        const finalRows = this.listEventsForJob(session.job_id, type);
        const finalMatches = finalRows.filter(row => {
          try {
            const stored = parseStrictJson(row.payload_json);
            return stored?.messageId === messageId && typeof stored.attempt === 'number' && stored.attempt === payload.attempt &&
              (type !== 'session.message_retry' || stored?.availableAt === payload.availableAt);
          } catch { return false; }
        });
        if (finalMatches.length !== 1 || finalMatches[0].event_id !== expectedId || finalMatches[0].job_id !== session.job_id ||
            finalMatches[0].type !== type || finalMatches[0].payload_json !== JSON.stringify(payload)) {
          throw new Error(`session retry ${type} event readback/cardinality failed`);
        }
      };

      const max = Math.max(1, Number(maxAttempts) || 5);
      if (message.attempt >= max) {
        const failureReason = message.last_error || error;
        const failedAt = now();
        const update = this.#db.prepare(`UPDATE session_messages SET status='FAILED',last_error=?,lease_until=NULL,updated_at=?
          WHERE message_id=? AND status=? AND attempt=? AND COALESCE(last_error,'') NOT LIKE 'DELIVERY_UNCERTAIN:%'`)
          .run(failureReason, failedAt, messageId, message.status, message.attempt);
        if (update.changes !== 1) throw new Error(`session message failure terminalization lost attempt ownership: ${messageId}`);
        if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_RETRY_STATE_UPDATE === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
        const current = this.getSessionMessage(messageId);
        logicalEvent('session.message_failed', `${messageId}|${current.attempt}`, {
          messageId, sessionId: session.session_id, attempt: current.attempt, error: failureReason
        });
        const persisted = this.getSessionMessage(messageId);
        if (persisted?.status !== 'FAILED' || typeof persisted.attempt !== 'number' || persisted.attempt !== message.attempt ||
            persisted.last_error !== failureReason || persisted.lease_until !== null) {
          throw new Error(`session failed-message exact state readback failed: ${messageId}`);
        }
        this.#db.exec('RELEASE SAVEPOINT retry_session_message_transition');
        return persisted;
      }

      const ts = now();
      const attempt = message.attempt;
      const explicitDelay = delayMs === null || delayMs === undefined ? null : Math.max(0, Number(delayMs) || 0);
      const base = Math.max(0, Number(baseDelayMs) || 0);
      const cap = Math.max(base, Number(maxDelayMs) || 60_000);
      const retryDelay = explicitDelay === null ? Math.min(cap, base * (2 ** Math.max(0, attempt - 1))) : explicitDelay;
      const availableAt = new Date(Date.now() + retryDelay).toISOString();
      const changed = this.#db.prepare(`UPDATE session_messages SET status='QUEUED',available_at=?,lease_until=NULL,last_error=?,updated_at=?
        WHERE message_id=? AND status=? AND attempt=? AND COALESCE(last_error,'') NOT LIKE 'DELIVERY_UNCERTAIN:%'`)
        .run(availableAt, error, ts, messageId, message.status, message.attempt);
      if (changed.changes !== 1) throw new Error(`session retry lost compare-and-set ownership of ${messageId}`);
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_RETRY_STATE_UPDATE === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
      const updated = this.getSessionMessage(messageId);
      logicalEvent('session.message_retry', `${messageId}|${updated.attempt}|${availableAt}`, {
        messageId, sessionId: session.session_id, attempt: updated.attempt, availableAt, error
      });
      const persisted = this.getSessionMessage(messageId);
      if (persisted?.status !== 'QUEUED' || typeof persisted.attempt !== 'number' || persisted.attempt !== message.attempt ||
          persisted.available_at !== availableAt || persisted.lease_until !== null || persisted.last_error !== error) {
        throw new Error(`session retry exact state readback failed: ${messageId}`);
      }
      this.#db.exec('RELEASE SAVEPOINT retry_session_message_transition');
      return persisted;
    } catch (failure) {
      try { this.#db.exec('ROLLBACK TO SAVEPOINT retry_session_message_transition'); } catch {}
      try { this.#db.exec('RELEASE SAVEPOINT retry_session_message_transition'); } catch {}
      throw failure;
    }
  }
  retryExpiredSessionMessages({ sessionId = null, maxAttempts = 5, baseDelayMs = 0, maxDelayMs = 60_000 } = {}) {
    const ts = now();
    const rows = this.#db.prepare(`SELECT message_id,session_id,recipient_role,attempt,lease_until FROM session_messages
      WHERE status = 'DELIVERED' AND lease_until IS NOT NULL AND lease_until <= ? ${sessionId ? 'AND session_id = ?' : ''}
      ORDER BY updated_at, rowid`).all(...(sessionId ? [ts, sessionId] : [ts]));
    for (const row of rows) {
      if (typeof row.attempt !== 'number' || !Number.isSafeInteger(row.attempt) || row.attempt < 1) {
        throw new Error(`expired session message has a malformed durable attempt; recovery refuses retry: ${row.message_id}`);
      }
      const session = this.getSession(row.session_id);
      if (!session) continue;
      const startKey = `${row.message_id}|${row.attempt}`;
      const expectedStartId = eventId(session.job_id, 'session.message_delivery_started', startKey);
      const startRows = this.listEventsForJob(session.job_id, 'session.message_delivery_started');
      const starts = [];
      let malformed = false;
      for (const event of startRows) {
        let payload;
        try { payload = parseStrictJson(event.payload_json); }
        catch { malformed = true; break; }
        if (event.payload_json !== JSON.stringify(payload)) { malformed = true; break; }
        if (payload?.messageId === row.message_id && typeof payload.attempt === 'number' && payload.attempt === row.attempt) starts.push({ event, payload });
      }
      if (malformed || starts.length > 1 || (starts.length === 1 &&
          (starts[0].event.event_id !== expectedStartId || starts[0].event.job_id !== session.job_id ||
           starts[0].event.type !== 'session.message_delivery_started'))) {
        this.#deliveryHooks.markSessionMessageDeliveryUncertain(row.message_id, { attempt: row.attempt,
          phase: 'recovery_found_corrupt_delivery_started_ledger', error: 'delivery-start event lineage is malformed or duplicated' });
        continue;
      }
      if (starts.length === 1) {
        const current = this.getSessionMessage(row.message_id);
        if (current?.status === 'DELIVERED' && typeof current.attempt === 'number' && current.attempt === row.attempt) {
          try {
            const recoveredAck = this.#deliveryHooks.ackSessionMessage(row.message_id, {
              recipientRole: row.recipient_role, expectedAttempt: row.attempt, expectedLeaseUntil: row.lease_until,
              allowExpiredLeaseWithDurableReceipt: true
            });
            if (recoveredAck?.status === 'ACKED') continue;
          } catch (error) {
            // A valid durable successful transport receipt may let recovery
            // finalize ACK locally without reissuing the remote side effect.
            // If that lineage is absent/corrupt, fall through to uncertain.
            row.recoveryReceiptError = String(error?.message || error).slice(0, 500);
          }
        }
        // Once the transport-start intent is durable, a process crash/timeout
        // cannot prove whether the external service accepted the request.
        // Fail closed rather than blindly retrying a possible duplicate side effect.
        this.#deliveryHooks.markSessionMessageDeliveryUncertain(row.message_id, { attempt: row.attempt, leaseUntil: row.lease_until,
          phase: 'delivery_lease_expired_after_transport_start',
          error: row.recoveryReceiptError || 'worker lease expired after transport start; external outcome not durably acknowledged' });
      } else {
        // No transport-start marker means the managed delivery method never
        // crossed the side-effect boundary; this lease can be safely reclaimed.
        this.#deliveryHooks.retrySessionMessage(row.message_id, { error: 'delivery lease expired before transport start', maxAttempts, baseDelayMs, maxDelayMs });
      }
    }
    return rows.length;
  }
  reconcileSessionDelivery({ sessionId = null, maxAttempts = 5, baseDelayMs = 0, maxDelayMs = 60_000 } = {}) {
    return this.retryExpiredSessionMessages({ sessionId, maxAttempts, baseDelayMs, maxDelayMs });
  }
  recordSessionDeliveryReceipt(messageId, { attempt, status, runId = null, sessionKey = null, response = null, error = null } = {}) {
    this.#db.exec('SAVEPOINT session_delivery_receipt_transition');
    try {
      if (!['OK', 'EMPTY', 'ERROR'].includes(status)) throw new Error(`unsupported session delivery receipt status: ${status}`);
      const reservation = this.#db.prepare('UPDATE session_messages SET updated_at=updated_at WHERE message_id=?').run(messageId);
      if (reservation.changes !== 1) throw new Error(`session message missing during delivery receipt: ${messageId}`);
      const message = this.getSessionMessage(messageId);
      const exactAttempt = attempt == null ? message?.attempt : attempt;
      if (typeof message?.attempt !== 'number' || !Number.isSafeInteger(message.attempt) || message.attempt < 1 ||
          typeof exactAttempt !== 'number' || !Number.isSafeInteger(exactAttempt) || exactAttempt !== message.attempt ||
          !['DELIVERED', 'ACKED'].includes(message.status)) {
        throw new Error(`session delivery receipt belongs to stale attempt or message state: ${messageId}`);
      }
      if (status === 'OK' && !(typeof runId === 'string' && runId.trim().length > 0)) {
        throw new Error('successful session delivery receipt requires a correlated non-empty string runId; sessionKey alone is not delivery proof');
      }
      if (sessionKey !== null && sessionKey !== undefined && (typeof sessionKey !== 'string' || !sessionKey.trim())) {
        throw new Error('session delivery receipt sessionKey must be a non-empty opaque string or null');
      }
      const session = this.getSession(message.session_id);
      if (!session) throw new Error(`session missing during delivery receipt: ${messageId}`);
      if (status === 'OK' && runId !== null && runId !== undefined && String(runId).trim()) {
        for (const prior of this.listEventsForJob(session.job_id, 'session.message_receipt')) {
          let priorPayload;
          try { priorPayload = parseStrictJson(prior.payload_json); }
          catch { throw new Error('session delivery receipt replay check found malformed receipt event'); }
          if (prior.payload_json !== JSON.stringify(priorPayload)) throw new Error('session delivery receipt replay check found non-canonical receipt event');
          if (String(priorPayload?.runId ?? '') === String(runId) &&
              (priorPayload.messageId !== messageId || typeof priorPayload.attempt !== 'number' || priorPayload.attempt !== exactAttempt)) {
            throw new Error(`OpenClaw run ID ${String(runId)} was replayed across distinct session delivery attempts`);
          }
        }
      }
      const key = `${messageId}|${exactAttempt}|${status}`;
      const expectedId = eventId(session.job_id, 'session.message_receipt', key);
      const rows = this.listEventsForJob(session.job_id, 'session.message_receipt');
      const matches = [];
      for (const row of rows) {
        let payload;
        try { payload = parseStrictJson(row.payload_json); }
        catch { throw new Error('session delivery receipt found malformed receipt event'); }
        if (row.payload_json !== JSON.stringify(payload)) throw new Error('session delivery receipt found non-canonical receipt event JSON');
        if (payload?.messageId === messageId && typeof payload.attempt === 'number' && payload.attempt === exactAttempt && payload?.status === status) matches.push({ row, payload });
      }
      if (matches.length > 1) throw new Error('session delivery receipt has duplicate durable logical events');
      const expectedFields = { messageId, attempt: exactAttempt, status, runId, sessionKey, response, error };
      if (matches.length === 1) {
        const { row, payload } = matches[0];
        if (row.event_id !== expectedId || row.job_id !== session.job_id || row.type !== 'session.message_receipt' ||
            Object.keys(payload).sort().join(',') !== 'attempt,error,messageId,recordedAt,response,runId,sessionKey,status' ||
            payload.messageId !== expectedFields.messageId || payload.attempt !== expectedFields.attempt || payload.status !== expectedFields.status ||
            payload.runId !== expectedFields.runId || payload.sessionKey !== expectedFields.sessionKey ||
            JSON.stringify(payload.response) !== JSON.stringify(expectedFields.response) || payload.error !== expectedFields.error ||
            typeof payload.recordedAt !== 'string' || !Number.isFinite(Date.parse(payload.recordedAt)) ||
            new Date(Date.parse(payload.recordedAt)).toISOString() !== payload.recordedAt) {
          throw new Error('session delivery receipt replay conflicts with exact durable receipt lineage');
        }
        this.#db.exec('RELEASE SAVEPOINT session_delivery_receipt_transition');
        return payload;
      }
      const receipt = { ...expectedFields, recordedAt: now() };
      this.#workflowPort.recordEvent(session.job_id, 'session.message_receipt', receipt, key);
      const row = this.#workflowPort.getEvent(expectedId);
      if (!row || row.job_id !== session.job_id || row.type !== 'session.message_receipt' || row.payload_json !== JSON.stringify(receipt)) {
        throw new Error('session delivery receipt exact event readback failed');
      }
      this.#db.exec('RELEASE SAVEPOINT session_delivery_receipt_transition');
      return receipt;
    } catch (failure) {
      try { this.#db.exec('ROLLBACK TO SAVEPOINT session_delivery_receipt_transition'); } catch {}
      try { this.#db.exec('RELEASE SAVEPOINT session_delivery_receipt_transition'); } catch {}
      throw failure;
    }
  }
  recordSessionDeliveryStarted(messageId, { attempt, leaseUntil = null } = {}) {
    this.#db.exec('SAVEPOINT session_delivery_started_transition');
    try {
      const reservation = this.#db.prepare('UPDATE session_messages SET updated_at=updated_at WHERE message_id=?').run(messageId);
      if (reservation.changes !== 1) throw new Error(`session message missing before transport start: ${messageId}`);
      const message = this.getSessionMessage(messageId);
      if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1 ||
          typeof message?.attempt !== 'number' || !Number.isSafeInteger(message.attempt) || message.attempt < 1 ||
          message.status !== 'DELIVERED' || message.attempt !== attempt ||
          !message.lease_until || message.lease_until <= now() || (leaseUntil !== null && message.lease_until !== leaseUntil)) {
        throw new Error(`session transport start does not own the exact live delivery lease: ${messageId}`);
      }
      const session = this.getSession(message.session_id);
      if (!session) throw new Error(`session not found before transport start: ${messageId}`);
      const key = `${messageId}|${attempt}`;
      const expectedId = eventId(session.job_id, 'session.message_delivery_started', key);
      const prior = this.#workflowPort.getEvent(expectedId);
      if (prior) {
        let priorPayload;
        try { priorPayload = parseStrictJson(prior.payload_json); }
        catch { throw new Error('session transport-start idempotency key contains malformed durable event'); }
        if (prior.job_id !== session.job_id || prior.type !== 'session.message_delivery_started' ||
            prior.payload_json !== JSON.stringify(priorPayload) ||
            Object.keys(priorPayload).sort().join(',') !== 'attempt,idempotencyKey,leaseUntil,messageId,recipientRole,sessionId,startedAt' ||
            priorPayload.messageId !== messageId || typeof priorPayload.attempt !== 'number' || priorPayload.attempt !== attempt ||
            priorPayload.sessionId !== message.session_id || priorPayload.recipientRole !== message.recipient_role ||
            priorPayload.leaseUntil !== message.lease_until || priorPayload.idempotencyKey !== message.message_id ||
            typeof priorPayload.startedAt !== 'string') throw new Error('session transport-start idempotency key conflicts with durable event');
        this.#db.exec('RELEASE SAVEPOINT session_delivery_started_transition');
        return priorPayload;
      }
      this.assertSessionPermission(message.session_id, message.recipient_role, 'MESSAGE');
      const payload = { messageId, sessionId: message.session_id, recipientRole: message.recipient_role,
        attempt, leaseUntil: message.lease_until, idempotencyKey: message.message_id, startedAt: now() };
      this.#workflowPort.recordEvent(session.job_id, 'session.message_delivery_started', payload, key);
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_DELIVERY_STARTED_EVENT === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
      const event = this.#workflowPort.getEvent(expectedId);
      if (!event || event.job_id !== session.job_id || event.type !== 'session.message_delivery_started' ||
          event.payload_json !== JSON.stringify(payload)) throw new Error('session transport-start event exact readback failed');
      this.#db.exec('RELEASE SAVEPOINT session_delivery_started_transition');
      return payload;
    } catch (failure) {
      try { this.#db.exec('ROLLBACK TO SAVEPOINT session_delivery_started_transition'); } catch {}
      try { this.#db.exec('RELEASE SAVEPOINT session_delivery_started_transition'); } catch {}
      throw failure;
    }
  }
  deliverSessionMessage(messageId, transport, { maxAttempts = 5, retryDelayMs = 1000, retryMaxDelayMs = 60_000, timeoutSeconds = 120, leaseMs = null } = {}) {
    const message = this.getSessionMessage(messageId);
    if (!message) return Promise.resolve(null);
    const session = this.getSession(message.session_id);
    if (!session) return Promise.reject(new Error(`Session not found: ${message.session_id}`));
    const recipientRole = message.recipient_role;
    // The OpenClaw transport's effective timeout is max(5s, timeoutSeconds+5s),
    // followed by a termination grace period before its promise settles. The
    // lease must outlive that complete local deadline or another process can
    // quarantine an in-flight send before it returns its receipt. Keep an
    // additional 5s scheduling/SQLite margin; this fences local recovery only
    // and cannot make the remote side effect atomic with SQLite.
    const requestedTimeoutSeconds = Number(timeoutSeconds);
    const effectiveTimeoutSeconds = Number.isFinite(requestedTimeoutSeconds) && requestedTimeoutSeconds > 0
      ? requestedTimeoutSeconds : 120;
    const transportDeadlineMs = Math.max(5_000, effectiveTimeoutSeconds * 1000 + 5_000);
    const minimumLeaseMs = transportDeadlineMs + 5_000;
    const requestedLeaseMs = Number(leaseMs);
    const effectiveLeaseMs = Number.isFinite(requestedLeaseMs) && requestedLeaseMs > 0
      ? Math.max(minimumLeaseMs, requestedLeaseMs) : minimumLeaseMs;
    const claimed = this.claimSessionMessage(messageId, { recipientRole, leaseMs: effectiveLeaseMs });
    if (!claimed || claimed.status !== 'DELIVERED' || claimed.claimAcquired !== true) return Promise.resolve(claimed);
    const context = { timeoutSeconds: effectiveTimeoutSeconds, idempotencyKey: message.message_id,
      deliveryAttempt: claimed.attempt, leaseUntil: claimed.lease_until };
    return Promise.resolve().then(async () => {
      try {
        this.recordSessionDeliveryStarted(messageId, { attempt: claimed.attempt, leaseUntil: claimed.lease_until });
      } catch (error) {
        // The transport has not been called yet, so no external side effect has
        // occurred in this managed path. A safely retriable local setup failure
        // may release the lease; if reconciliation cannot prove pre-send state,
        // keep the failure explicit and avoid issuing the external request.
        try {
          return this.#deliveryHooks.retrySessionMessage(messageId, { error: `transport start ledger failed before send: ${error?.message || error}`,
            maxAttempts, baseDelayMs: retryDelayMs, maxDelayMs: retryMaxDelayMs });
        } catch (retryError) {
          throw new AggregateError([error, retryError], `transport was not invoked but lease recovery failed: ${messageId}`);
        }
      }
      let receipt;
      try {
        receipt = await transport(session, claimed, context);
      } catch (error) {
        const transportCode = error?.transportCode || error?.code || 'TRANSPORT_ERROR';
        const messageText = `${transportCode}: ${error?.message || error}`;
        // Retrying is safe only when the transport explicitly certifies that no
        // remote side effect occurred. A timeout/disconnect after request send
        // is ambiguous and must not silently replay the external operation.
        if (error?.deliveryOutcome === 'not_sent' || error?.externalSideEffectCommitted === false) {
          try { this.#deliveryHooks.recordSessionDeliveryReceipt(messageId, { attempt: claimed.attempt, status: 'ERROR', runId: null,
            sessionKey: session.openclaw_session_key, response: null, error: messageText }); } catch {}
          return this.#deliveryHooks.retrySessionMessage(messageId, { error: messageText, maxAttempts,
            baseDelayMs: retryDelayMs, maxDelayMs: retryMaxDelayMs });
        }
        try {
          return this.#deliveryHooks.markSessionMessageDeliveryUncertain(messageId, { attempt: claimed.attempt, leaseUntil: claimed.lease_until,
            phase: 'transport_outcome_unknown', error: messageText });
        } catch (ledgerError) {
          throw new AggregateError([error, ledgerError], `external delivery outcome is unknown and could not be durably marked: ${messageId}`);
        }
      }
      const reportedReceiptStatus = receipt && typeof receipt === 'object' && !Array.isArray(receipt)
        ? String(receipt.status || '').toUpperCase() : '';
      let receiptStatus = ['OK', 'ERROR', 'EMPTY'].includes(reportedReceiptStatus)
        ? reportedReceiptStatus : 'ERROR';
      let receiptValidationError = null;
      if (receiptStatus === 'OK') {
        const returnedRunId = receipt.runId;
        const hasSessionKey = receipt.sessionKey !== null && receipt.sessionKey !== undefined;
        const returnedSessionKey = typeof receipt.sessionKey === 'string' && receipt.sessionKey.trim() ? receipt.sessionKey : null;
        const hasRunId = typeof returnedRunId === 'string' && returnedRunId.trim().length > 0;
        if (hasSessionKey && !returnedSessionKey) {
          receiptStatus = 'ERROR';
          receiptValidationError = 'OpenClaw receipt sessionKey must be a non-empty opaque string; remote outcome is ambiguous';
        } else if (returnedSessionKey && returnedSessionKey !== session.openclaw_session_key) {
          receiptStatus = 'ERROR';
          receiptValidationError = 'OpenClaw receipt sessionKey does not match the target session; remote outcome is ambiguous';
        } else if (!hasRunId) {
          receiptStatus = 'ERROR';
          receiptValidationError = 'OpenClaw success receipt lacks a valid non-empty string runId; sessionKey alone does not prove this delivery attempt and remote outcome is ambiguous';
        }
      }
      if (receiptStatus === 'ERROR' || receiptStatus === 'EMPTY') {
        const receiptError = receipt?.error || receiptValidationError || (receiptStatus === 'EMPTY'
          ? 'transport returned an empty response; remote acceptance is not established'
          : 'transport returned a missing, malformed, unknown, or explicit error receipt; remote side effects are not ruled out');
        try {
          this.#deliveryHooks.recordSessionDeliveryReceipt(messageId, {
            attempt: claimed.attempt, status: receiptStatus,
            runId: typeof receipt?.runId === 'string' && receipt.runId.trim() ? receipt.runId : null,
            sessionKey: typeof receipt?.sessionKey === 'string' && receipt.sessionKey.trim() ? receipt.sessionKey : session.openclaw_session_key,
            response: receipt?.result ?? receipt?.payload ?? receipt?.raw ?? null, error: receiptError
          });
        } catch (recordError) {
          // A returned error/empty receipt does not prove that the remote side
          // effect did not occur. Preserve fail-closed uncertainty even if its
          // diagnostic receipt cannot be committed.
          try {
            return this.#deliveryHooks.markSessionMessageDeliveryUncertain(messageId, { attempt: claimed.attempt, leaseUntil: claimed.lease_until,
              phase: 'non_success_receipt_persistence_failed', error: `${receiptError}; receiptError=${recordError?.message || recordError}` });
          } catch (ledgerError) {
            throw new AggregateError([recordError, ledgerError], `non-success transport receipt and uncertainty could not be persisted: ${messageId}`);
          }
        }
        return this.#deliveryHooks.markSessionMessageDeliveryUncertain(messageId, { attempt: claimed.attempt, leaseUntil: claimed.lease_until,
          phase: 'transport_returned_non_success_receipt', error: receiptError });
      }
      try {
        this.#deliveryHooks.recordSessionDeliveryReceipt(messageId, {
          attempt: claimed.attempt, status: receipt?.status || 'OK', runId: receipt?.runId || null,
          sessionKey: receipt?.sessionKey || session.openclaw_session_key,
          response: receipt?.result ?? receipt?.payload ?? receipt?.raw ?? null, error: null
        });
      } catch (error) {
        try {
          return this.#deliveryHooks.markSessionMessageDeliveryUncertain(messageId, { attempt: claimed.attempt, leaseUntil: claimed.lease_until,
            phase: 'success_receipt_persistence_failed', error });
        } catch (ledgerError) {
          throw new AggregateError([error, ledgerError], `delivery succeeded remotely but receipt/uncertainty persistence failed: ${messageId}`);
        }
      }
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_RECEIPT_COMMIT === 'SIGKILL') {
        process.kill(process.pid, 'SIGKILL');
      }
      try {
        return this.#deliveryHooks.ackSessionMessage(messageId, { recipientRole, expectedAttempt: claimed.attempt, expectedLeaseUntil: claimed.lease_until });
      } catch (error) {
        try {
          return this.#deliveryHooks.markSessionMessageDeliveryUncertain(messageId, { attempt: claimed.attempt, leaseUntil: claimed.lease_until,
            phase: 'ack_persistence_failed_after_remote_success', error });
        } catch (ledgerError) {
          throw new AggregateError([error, ledgerError], `delivery succeeded remotely but ACK/uncertainty persistence failed: ${messageId}`);
        }
      }
    });
  }
  markStaleAgentSessions(maxAgeMs = 5 * 60 * 1000) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const rows = this.#db.prepare("SELECT * FROM agent_sessions WHERE state = 'ACTIVE' AND last_activity_at < ?").all(cutoff);
    const ts = now();
    for (const row of rows) {
      this.#db.prepare("UPDATE agent_sessions SET state = 'STALE', updated_at = ? WHERE session_id = ? AND state = 'ACTIVE'").run(ts, row.session_id);
      this.#workflowPort.recordEvent(row.job_id, 'session.stale', { sessionId: row.session_id, taskId: row.task_id, lastActivityAt: row.last_activity_at }, row.session_id);
    }
    return rows.length;
  }
  markAgentSessionStale(sessionId, { reason = 'runtime session no longer active' } = {}) {
    const session = this.getSession(sessionId); if (!session) return null;
    if (['TERMINATED', 'FAILED', 'STALE'].includes(session.state)) return session;
    const ts = now();
    this.#db.prepare("UPDATE agent_sessions SET state = 'STALE', updated_at = ? WHERE session_id = ? AND state IN ('ACTIVE','CREATED','PAUSED')").run(ts, sessionId);
    const updated = this.getSession(sessionId);
    if (updated?.state === 'STALE') {
      this.#workflowPort.recordEvent(updated.job_id, 'session.stale', {
        sessionId, taskId: updated.task_id, lastActivityAt: updated.last_activity_at, reason
      }, `${sessionId}|stale|${reason}`);
    }
    return updated;
  }
  updateAgentSessionRetryAttempt(sessionId, nextAttempt, timestamp) {
    return this.updateRetryAttempt(sessionId, nextAttempt, timestamp);
  }
}

export function createAgentSessionStore(dependencies) {
  return new AgentSessionStore(dependencies);
}
