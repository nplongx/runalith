/**
 * Transactional SQLite implementation of the external checkpoint CAS contract.
 *
 * This module deliberately does not create, seed, migrate, or provision the
 * checkpoint tables. The host authority must provision the database and its
 * initial anchor out-of-band. A local SQLite file is not, by itself, evidence
 * of independent custody or production authority.
 */
const SHA256 = /^[a-f0-9]{64}$/;
const NONCE = /^[a-f0-9]{32,128}$/;

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

export const SQLITE_EXTERNAL_CHECKPOINT_SCHEMA = `
CREATE TABLE external_trust_checkpoint_state (
  authority_id TEXT PRIMARY KEY,
  candidate_sha256 TEXT NOT NULL,
  rollback_sha256 TEXT NOT NULL,
  high_water_sequence INTEGER NOT NULL CHECK(high_water_sequence >= 1),
  last_checkpoint_digest TEXT NOT NULL
);
CREATE TABLE external_trust_checkpoint_nonces (
  authority_id TEXT NOT NULL,
  request_nonce TEXT NOT NULL,
  checkpoint_sequence INTEGER NOT NULL,
  checkpoint_digest TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  PRIMARY KEY(authority_id, request_nonce),
  UNIQUE(authority_id, checkpoint_sequence)
);`;

/**
 * Return a synchronous callback suitable for verifyExternalTrustCheckpointResponse.
 * The caller must pass a dedicated, host-owned connection whose schema and
 * bootstrap state were independently provisioned. Every security predicate is
 * rechecked inside BEGIN IMMEDIATE, not merely against a pre-transaction read.
 */
export function createSqliteExternalCheckpointTransition(db, { now = () => Date.now() } = {}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function' || db.isTransaction === true ||
      typeof now !== 'function') {
    fail('EXTERNAL_CHECKPOINT_SQLITE_ADAPTER_INVALID', 'requires a dedicated SQLite connection outside an existing transaction');
  }
  return function commitCheckpointTransition(input) {
    if (!input || typeof input !== 'object' || !NONCE.test(input.requestNonce || '') ||
        typeof input.authorityId !== 'string' || !input.authorityId ||
        !SHA256.test(input.candidateSha256 || '') || !SHA256.test(input.rollbackSha256 || '') ||
        !Number.isSafeInteger(input.expectedHighWaterSequence) || input.expectedHighWaterSequence < 1 ||
        !SHA256.test(input.expectedPreviousCheckpointDigest || '') ||
        input.checkpointSequence !== input.expectedHighWaterSequence + 1 ||
        !SHA256.test(input.checkpointDigest || '') || input.previousCheckpointDigest !== input.expectedPreviousCheckpointDigest) {
      return false;
    }
    const observedAtMs = now();
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) return false;
    db.exec('BEGIN IMMEDIATE');
    try {
      const state = db.prepare(`SELECT authority_id,candidate_sha256,rollback_sha256,high_water_sequence,last_checkpoint_digest
        FROM external_trust_checkpoint_state WHERE authority_id=?`).get(input.authorityId);
      if (!state || state.candidate_sha256 !== input.candidateSha256 || state.rollback_sha256 !== input.rollbackSha256 ||
          state.high_water_sequence !== input.expectedHighWaterSequence ||
          state.last_checkpoint_digest !== input.expectedPreviousCheckpointDigest) {
        db.exec('ROLLBACK');
        return false;
      }
      const alreadyConsumed = db.prepare('SELECT 1 FROM external_trust_checkpoint_nonces WHERE authority_id=? AND request_nonce=?')
        .get(input.authorityId, input.requestNonce);
      if (alreadyConsumed) {
        db.exec('ROLLBACK');
        return false;
      }
      db.prepare(`INSERT INTO external_trust_checkpoint_nonces
        (authority_id,request_nonce,checkpoint_sequence,checkpoint_digest,consumed_at) VALUES(?,?,?,?,?)`)
        .run(input.authorityId, input.requestNonce, input.checkpointSequence, input.checkpointDigest, new Date(observedAtMs).toISOString());
      const changed = db.prepare(`UPDATE external_trust_checkpoint_state
        SET high_water_sequence=?,last_checkpoint_digest=?
        WHERE authority_id=? AND candidate_sha256=? AND rollback_sha256=? AND high_water_sequence=? AND last_checkpoint_digest=?`)
        .run(input.checkpointSequence, input.checkpointDigest, input.authorityId, input.candidateSha256,
          input.rollbackSha256, input.expectedHighWaterSequence, input.expectedPreviousCheckpointDigest);
      if (changed.changes !== 1) {
        db.exec('ROLLBACK');
        return false;
      }
      db.exec('COMMIT');
      return true;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      // Constraint violations (including nonce reuse) are ordinary CAS loss;
      // other storage errors propagate so callers fail closed and can query
      // the authoritative transaction outcome instead of blindly retrying.
      if (error?.code === 'ERR_SQLITE_CONSTRAINT_PRIMARYKEY' || error?.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE') return false;
      throw error;
    }
  };
}
