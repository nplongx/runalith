# AGG external anti-rollback checkpoint v2 design

**Status:** design proposal only; not a production contract, not provisioned, and not authorized for an external state transition.

**Applies to:** the five AGG trust domains, the dedicated trust-configuration ledger, and the workflow database records that enforce maker/checker replay protection and approval-policy high-water.

## 1. Why v1 is insufficient

The v1 response contains signed `ledger_state_sha256` and `trust_domain_state_sha256` fields. The v1 verifier authenticates the response, recomputes the remote checkpoint digest, checks release hashes, nonce freshness, sequence continuity and the previous checkpoint digest. It does not compare those two signed state hashes to locally measured state. A well-formed signed hash can therefore describe a different local state.

The local anti-replay state is also split across two SQLite databases:

- `agg-trust-configuration.db` stores the five trust-domain configuration-history rows and append-only trust-configuration audit events.
- `workflow.db.events` stores maker/checker nonces inside `approval.approved` events and the `adaptive_goal.approval_policy_version_observed` policy high-water events. `workflow.db.approvals` stores the matching approval-state rows used by `WorkflowStore.isApprovalCurrent()`.

A restore of `workflow.db` can roll back the policy high-water or reintroduce an already-consumed maker/checker nonce even when the separate trust-configuration database has not been restored. Row-level UPDATE/DELETE guards are useful defense in depth, but cannot detect restoring an older database file, removing triggers, or replacing the database and its WAL together.

## 2. Required v2 state model

V2 must bind three distinct deterministic state digests. Do not hash only the SQLite main database file: committed WAL pages are part of the logical database state and must be represented.

### 2.1 `trust_domain_state_sha256`

Hash a canonical, sorted projection of all five currently effective administrator configurations:

- domain and exact authorization scope;
- provider ID;
- configuration version and canonical configuration fingerprint;
- sorted canonical SPKI public-root fingerprints;
- key IDs, validity windows and revocation timestamps.

Require exactly these five domains and no duplicates:

1. `goal_idea_verifier` / `agg.goal_idea_graph.verify`
2. `action_intent_reviewer` / `agg.action_intent.review`
3. `execution_approval_policy` / `agg.approval.policy`
4. `action_intent_maker` / `agg.action_intent.propose`
5. `execution_approval` / `agg.execution.approve`

The digest must not include or expose private keys or raw PEM content. Canonical SPKI fingerprints are the root identity.

### 2.2 `trust_ledger_state_sha256`

Hash the logical state of the active trust ledger, including:

- schema/contract identity;
- every row in `adaptive_goal_trust_configuration_history` for the five domains, including row identity, version, fingerprint, provider, observed timestamp and audit binding;
- every row in the append-only `adaptive_goal_trust_configuration_events` table, including its event identity and canonical payload;
- relevant indexes/triggers/schema identifiers needed to interpret the ledger contract.

A current configuration is not sufficient unless its exact five version/fingerprint/provider tuples match the latest durable observations. Do not use a test-local ledger as production evidence.

### 2.3 `approval_security_state_sha256`

Hash the logical security state in `workflow.db`, at minimum:

- all `adaptive_goal.approval_policy_version_observed` events;
- all `approval.approved` events that contain signed AGG maker/checker evidence, including complete canonical event identity and payload bytes (the payload contains the one-use nonces and policy/candidate bindings);
- all reviewer-identity attestation events used by the AGG action-intent verifier;
- all `adaptive_goal.execution_plan_candidate_created` records used to reconstruct the current action-intent candidate;
- all `approvals` rows (`approval_id`, `job_id`, `decision`, `actor`, `proposal_hash`, `created_at`) because current approval status is read from this table.

Rows must be canonically ordered and include their stable row/event identity and every security-relevant field. Malformed or non-canonical rows must fail the snapshot, not be omitted. Do not store raw prompts or expose signed payload content in reports; emit only the final digest and bounded counts.

The event allowlist must be versioned. Any new event type that participates in authorization, replay detection, revocation, reviewer identity or immutable-plan binding must be added to the state projection before it can authorize execution.

### 2.4 Aggregate `ledger_state_sha256`

Define one canonical envelope containing the schema version and all three digests above. `ledger_state_sha256` is the SHA-256 of that canonical envelope. Keep the individual component digests in the signed v2 response so a mismatch is diagnosable without exposing row content.

## 3. Snapshot consistency and WAL handling

A snapshot is valid only when it is obtained from the exact database files used by the active host process.

1. Discover exactly one active open descriptor for `agg-trust-configuration.db` and exactly one for `workflow.db`.
2. Pin descriptor and canonical path identity (device/inode); reject deleted, replaced, symbolic-link or ambiguous descriptors.
3. Open read-only SQLite connections to those exact files, set `PRAGMA query_only=ON`, and read through SQLite so committed WAL content is included. Never hash only the main database file or copy a live main file without its WAL/SHM context.
4. Capture each logical projection within a read transaction. The adapter must report database identity and transaction/snapshot metadata with the digests.
5. The two databases do not share one native SQLite transaction. V2 must therefore define and test a cross-database consistency barrier. The preferred implementation is a host-owned snapshot helper using one read-only SQLite connection with both exact database files attached and a single read statement that materializes both projections under one read transaction. If the host/runtime cannot guarantee a common snapshot, report `SNAPSHOT_NOT_ATOMIC` and keep the gate blocked; do not silently combine observations from unrelated times.
6. Recheck descriptor/path identity after reading. A changed inode or a database/WAL mutation that invalidates the captured snapshot blocks the observation.

The helper must be pinned by a root-owned host policy and byte hash, and must not accept caller-supplied state digests as its source of truth. It computes the state from the live database files itself.

## 4. Signed v2 request and response

The v2 challenge binds:

- authority ID and external store ID;
- one-time request nonce and request timestamp;
- candidate SHA-256 and rollback SHA-256;
- installed baseline identity;
- the three locally measured component digests and aggregate digest;
- the snapshot contract/version and host-helper identity.

The authority-signed response must echo the exact challenge and exact state digests, and contain:

- monotonic checkpoint sequence;
- current checkpoint digest and previous checkpoint digest;
- candidate and rollback hashes;
- all four state digests (`trust_domain_state_sha256`, `trust_ledger_state_sha256`, `approval_security_state_sha256`, `ledger_state_sha256`);
- freshness timestamp and signature.

Verification must compare every echoed state digest to the independently measured local digest, not merely check that it is 64-character hex or included in a valid signature. The external store must compare expected previous sequence/digest/state digests to its protected high-water record and reject rollback, skipped sequence, replayed nonce or an unapproved state transition.

A remote service signing arbitrary hashes supplied by the plugin is not sufficient. The host-owned helper must compute the hashes from the exact local DB state and authenticate its measurement to the external authority using separately provisioned host credentials or a separately signed measurement receipt. The external store and its administrator must be independent of both the application operator and the local SQLite custody boundary.

V1 responses must never satisfy the v2 production-anchor gate. No fallback from a missing v2 measurement to v1 format is allowed.

## 5. Safe state advancement

A signed checkpoint observation is not automatically permission to advance the external high-water. V2 needs an explicit, separately authorized state-transition protocol.

For approval-policy high-water and maker/checker nonce changes, the workflow writer must not make the new state executable until the exact post-write security-state digest has an external commit receipt. The preferred sequence is:

1. Start the local workflow writer transaction (`BEGIN IMMEDIATE`).
2. Validate the current trust roots, policy, maker attestation, checker quorum and replay state.
3. Stage the exact append-only event/approval changes inside the uncommitted transaction.
4. Compute the post-write `approval_security_state_sha256` from that transaction and the exact current trust-ledger snapshot.
5. Request an external compare-and-swap bound to the previously anchored digest, the new digest, nonce, candidate/rollback and policy authority.
6. Verify the authority-signed commit receipt and its exact state-digest binding.
7. Commit the local transaction only after the receipt is accepted.

An ambiguous outcome after the external CAS must quarantine the transition. Never blindly retry with a new nonce or infer success from local state. Recovery must query the external monotonic store read-only and reconcile the exact staged digest. Trust-configuration observations require the same protection or a separately specified equivalent protocol.

The first checkpoint must be bootstrapped out of band by the independent authority. No local first-use/TOFU initialization is permitted.

## 6. Required v2 regressions

Before enabling v2, add tests for:

- exact five-domain effective configuration produces a stable digest; any single provider, version, SPKI, validity or revocation change changes it;
- missing or duplicate domain, provider collision or SPKI collision blocks the snapshot;
- approval-policy high-water event mutation/removal changes the digest or is denied by append-only constraints;
- removal/rewrite of a maker/checker nonce event changes the digest or is denied;
- rollback to a prior `workflow.db` state is rejected against the external high-water digest;
- rollback to a prior trust-ledger state is rejected;
- committed WAL rows are included in the logical digest;
- malformed event payloads fail closed rather than being silently excluded;
- snapshot identity changes during capture fail closed;
- mismatched v2 response digests are rejected even when the remote signature is valid;
- stale nonce, repeated nonce, previous-digest mismatch, sequence rollback, skipped sequence and ambiguous CAS outcome remain blocked;
- a failed external commit leaves the local approval transaction uncommitted;
- v1 response cannot be used to mark the v2 anchor verified.

## 7. Ownership and rollout boundary

The following are owner/admin dependencies, not data the application may manufacture:

- root-owned host snapshot helper and immutable helper hash;
- host measurement credential and its independent provisioning/rotation/revocation policy;
- external authority key and separate external-store attestation key;
- independent monotonic store with durable CAS, nonce-consumption and recovery/query semantics;
- signed out-of-band bootstrap checkpoint;
- security-owner approval of the v2 schema and state-transition protocol.

Until those dependencies exist, the current v1 adapter must not be described as proving local state equality. Keep `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` open. Do not run `--advance-external-checkpoint` as a diagnostic or during implementation tests.
