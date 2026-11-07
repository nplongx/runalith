# AGG external anti-rollback checkpoint v2 — normative specification

**Status:** Normative specification and JCS v2 constrained I-JSON wire profile approved by the Project Owner on 2026-10-30. A standalone v2 strict-JSON/JCS/domain-digest module, JavaScript tests and an independent Python golden-vector verifier are implemented in the working tree (`src/runtime/agg-checkpoint-jcs-v2.js`, `tests/test-agg-checkpoint-jcs-v2.mjs`, `tests/verify-agg-checkpoint-v2-jcs-vectors.py`, `tests/fixtures/agg-checkpoint-v2-jcs-vectors.json`). The latest local run passes 14 JCS JavaScript tests plus 1 shared strict-JSON regression (15 total), and the independent Python verifier reproduces all 27 canonicalization, parse and generated-boundary/digest vectors. This component is not yet integrated into an authority, measurement, projection or anchor lifecycle. The v2 system is not provisioned and is not authorized for production state transition; all open evidence and implementation gates remain binding.
**Date:** 2026-10-30
**Authority:** `agg-external-checkpoint-v2-decision-register-20261030.md` is the decision source. Where this document does not settle an implementation mapping, the mapping is an explicit open gate, not permission to guess.
**Scope:** AGG trust configuration, anti-replay state, execution-authorization state, local SQLite persistence, host measurement, external checkpoint authority, recovery and the low-level workflow authorization/dispatch boundary.

## 1. Conformance language and assurance boundary

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

This specification defines a recoverable protocol and its acceptance contract. It does not assert that the current host has a trustworthy TPM/TEE, that an external authority already provides the required API, or that any current database projection is complete. Those are evidence gates. A software hash, root-owned helper, process identity, filesystem inode, SQLite trigger, valid signature, or Project Owner approval is not by itself independent proof of trusted measurement or monotonic custody.

Until all required evidence gates and the separate RC.71 release gates are closed, v2 MUST remain disabled/unverified for production authorization. No v1 response may satisfy a v2 anchor requirement.

## 2. Architecture and trust boundaries

### 2.1 Local storage

1. Workflow state and all checkpointed security-critical state MUST reside in one physical SQLite database selected by the canonical `WORKFLOW_DB` configuration.
2. The workflow store and trust subsystem MUST use two separately managed SQLite connections to that same database identity. A dedicated trust connection is not a second database and MUST NOT resolve a hard-coded `dataDir/agg-trust-configuration.db` path.
3. Equality of path strings is insufficient. At open and throughout connection lifetime, the host adapter MUST establish that both handles refer to the same canonical database object and generation under the approved Linux adapter contract.
4. Initial supported platform is Linux. Other platforms MUST fail closed until a platform-specific adapter demonstrates equivalent identity, open-handle, snapshot, durability and recovery properties.
5. The legacy trust database MUST be preserved as an immutable, read-only migration archive after cutover. It MUST NOT be consulted as an authorization fallback. Archive deletion is a separate retention decision.

### 2.2 Connection and transaction roles

- The workflow connection owns workflow transactions and the low-level authorization/dispatch boundary.
- The dedicated trust connection owns trust-configuration observations and writes. It MUST commit any required trust observation before the workflow writer starts its write transaction.
- Trust reads performed while a workflow write transaction is active MUST be read-only. A trust write MUST NOT attempt to acquire a second writer reservation while the workflow connection holds `BEGIN IMMEDIATE`.
- No SQLite writer lock may be held while calling the external checkpoint authority, attester, verifier, identity provider, or other network service.
- Connection creation, PRAGMAs, ownership, error handling, close and startup unwind MUST be specified and tested. A partially initialized pair MUST never be exposed as ready.

### 2.3 Highest enforcement seam

`WorkflowStore` approval and dispatch authorization guards are the highest local enforcement seam. They MUST reject approval, task preparation that can make work executable, and dispatch unless the exact relevant security projection is in state `ANCHORED`, the local database identity is current, and the required fresh authority continuity check succeeds.

This seam is necessary but not sufficient. Every writer that can change either security projection MUST enter the same anchor lifecycle. Handler preflight, tool descriptions, UI state, or a caller-side check MUST NOT substitute for the low-level guard. No writer may mutate projected state through a path that bypasses lifecycle enforcement.

## 3. Database identity and generation

Every measured local database MUST have an authenticated identity tuple:

```text
logical_db_id       opaque stable identity for one logical database lineage
db_generation       monotonically advanced generation for a replacement/fork boundary
restore_epoch       monotonically advanced epoch for each authorized restore/recovery boundary
identity_issuer     independently provisioned issuer identity
identity_record     authenticated issuer-signed or equivalently protected record
```

The issuer/custody mechanism MUST be outside plugin-only writable SQLite state. Values stored solely in the database being measured are not self-authenticating. Path, inode, device number, file descriptor, WAL filename, timestamps, or a database UUID stored only in SQLite MUST NOT alone establish continuity or a new generation.

The authenticated identity record MUST bind the tuple, schema contract, issuance/transition reason, predecessor identity where applicable, and issuer key identity. Increment, restore, clone, promotion and fork rules MUST be deterministic and independently auditable. If the issuer cannot establish the correct tuple, the database MUST be quarantined.

## 4. Security projections

V2 MUST compute separately versioned component projections. The aggregate checkpoint MUST bind at least the trust-domain configuration component, trust-ledger component, anti-replay projection and full execution-authorization projection. Component versions and the exact projection contract MUST be included in the digest envelope.

### 4.1 Trust-domain configuration projection

The trust-domain component MUST represent exactly the five configured AGG trust domains and their effective authorization scopes:

1. `goal_idea_verifier` / `agg.goal_idea_graph.verify`
2. `action_intent_reviewer` / `agg.action_intent.review`
3. `execution_approval_policy` / `agg.approval.policy`
4. `action_intent_maker` / `agg.action_intent.propose`
5. `execution_approval` / `agg.execution.approve`

For each domain include domain ID, exact scope, provider ID, configuration version, canonical configuration fingerprint, sorted SPKI public-root fingerprints, key IDs, validity windows and revocation timestamps. Missing/duplicate domains, provider collisions, SPKI collisions, invalid key windows, unknown fields or unsupported schema MUST fail the projection. Private keys and raw PEM MUST NOT be included.

### 4.2 Trust-ledger projection

The trust-ledger component MUST include the schema/contract identity; every row of trust configuration history; every append-only trust-configuration event; stable row/event identity; version, fingerprint, provider, observed time, audit binding and all fields required to interpret the ledger. Relevant schema objects and constraints MUST be versioned as part of the interpretation contract. The effective five-domain configuration MUST match the latest durable observations exactly. Test-local state MUST NOT qualify as production evidence.

### 4.3 Anti-replay projection

`anti_replay_state_sha256` MUST cover every durable input used to detect or reject replay, including consumed reviewer/maker/checker nonces, policy high-water observations, replay identifiers, expiry/revocation state and the durable event/row identity needed to establish uniqueness and ordering. Its exact table/column/event mapping MUST be published in a versioned projection manifest before implementation. Unknown replay-relevant event types or schema versions MUST fail closed.

### 4.4 Execution-authorization projection

`execution_authorization_state_sha256` MUST cover every durable input actually read by any path that can change whether a candidate, reviewer, policy, approval, immutable execution plan, task preparation or dispatch is authorized. This includes relevant non-AGG workflow rows and events, current approval rows, proposal/candidate reconstruction inputs, reviewer attestations, trust configuration, policy state, plan data, role/capability contracts, source evidence bindings, and durable task/lease/attempt state wherever consumed by an authorization decision.

The projection MUST be derived from a complete source-level reader/writer inventory, not merely the currently known AGG event allowlist. Every authorization read MUST map to one or more projected fields. Every projection writer MUST map to an anchor lifecycle transition. Unmapped reads, writes, unknown schema/event versions, malformed records, missing rows required by a contract, or unsupported interpretations MUST fail closed.

### 4.5 Projection manifest and versioning

Before code implementation, a checked-in manifest MUST enumerate for each component: schema version, tables/views, columns, event types, stable identity/order keys, normalization rules, nullable-field semantics, query definition, writer entry points, authorization readers, and change classification. The manifest MUST state whether a change affects anti-replay, execution authorization, both, or neither, with rationale.

Projection changes MUST increment the relevant projection version and update cross-language vectors. An unknown version MUST never be interpreted as the previous version. The final digest envelope MUST bind the manifest digest and projection versions.

## 5. Snapshot boundary, transition gate and transaction ordering

### 5.1 Single-database snapshot and transition serialization

The selected D-01 architecture has one physical SQLite database. A checkpoint measurement MUST read every component from one SQLite read transaction on that database. SQLite's transaction snapshot provides a coherent logical view of committed rows (including committed WAL content); the implementation MUST verify the actual journal/connection contract and MUST NOT mix reads from separate transactions or database files. `ATTACH` is not part of this design.

Snapshot coherence and multi-step saga serialization are distinct requirements:

- **Snapshot boundary:** one read transaction over the canonical `WORKFLOW_DB` MUST materialize the complete versioned projections. Writers may commit outside that read transaction, but the resulting measurement describes only the pinned snapshot. Before a receipt can make local state `ANCHORED`, the implementation MUST prove the current projection still equals the measured target; otherwise it MUST quarantine/reconcile rather than attach a stale receipt to newer state.
- **Transition gate:** at most one security-projection mutation may be in the active external-anchor saga for a logical database generation. All processes/connections capable of projected writes MUST acquire the same host-enforced or database-enforced exclusive transition gate below individual tool handlers. The gate MUST be durable/fenced across process crashes, prevent a second projection writer from starting while an operation is unresolved, and be released only after `ANCHORED`, safely `ABORTED` with the original projection restored, or store-wide `QUARANTINED` is durably recorded. A process-local mutex is insufficient.

The exact transition-gate primitive, ownership/fencing, timeout, crash recovery and bypass resistance are implementation gates and MUST be evidenced on Linux. If any writer can bypass the gate, or if a coherent single-database snapshot/current-state equality cannot be proven, the measurement MUST fail with `SNAPSHOT_NOT_ATOMIC` or an equivalent stable blocker and authorization MUST remain blocked. Timestamps, sequential reads, one SQL statement across attached databases, SQLite `ATTACH`, or unrelated read transactions do not establish the required guarantees.

### 5.2 Bounded contention policy

SQLite `BUSY`/`LOCKED`, barrier contention and snapshot invalidation MUST use explicit bounded retry budgets with jitter/backoff appropriate to the operation. Exhaustion MUST produce a stable fail-closed result and observable diagnostic. Errors MUST NOT be swallowed, converted to success, or retried indefinitely. Transaction acquisition errors MUST be handled inside the operation's error boundary so rejection/audit handling remains consistent.

### 5.3 Mutation ordering

For a security-projection mutation, the implementation MUST follow this recoverable saga; it MUST NOT combine remote calls with an open SQLite writer transaction:

1. Acquire exclusive transition-gate ownership and verify database identity/generation/restore epoch. Reconcile the authoritative head and the complete outstanding-operation set before starting a new operation.
2. In a short local transaction, validate current preconditions and persist a stable `operation_id`, nonce, expected prior sequence/digest, exact intended transition descriptor and projection version as `INTENT_PENDING`. Commit this intent durably. Do not yet apply the authorization-relevant mutation.
3. Call authority `prepare/reserve` with the exact canonical request bytes. Verify the authenticated `PREPARED` result. The authority reservation MUST NOT advance the public anchored head or authorize execution.
4. In a second short local transaction, revalidate the intent and all preconditions, apply the exact authorization-relevant mutation tagged to the operation, mark it `ANCHOR_PENDING`, compute/store its exact logical projection identity from the coherent transaction state, and commit. Low-level authorization/dispatch MUST reject it.
5. After local commit, the trusted attester measures that exact committed state under the approved snapshot contract. The authority verifies appraisal and finalizes the reserved operation against the expected prior head, returning an immutable authenticated `COMMITTED` receipt.
6. Verify the receipt and, in a short local transaction, store its digest/reference (or full receipt where safe), read back exact bindings, and transition the matching operation from `ANCHOR_PENDING` to `ANCHORED`. Commit durably.
7. Release the transition gate only after the operation has been durably recorded as `ANCHORED`, safely `ABORTED` with the original projection restored, or `QUARANTINED`. `QUARANTINED` MUST also set a store-wide quarantine condition that prevents every new projected writer, approval and dispatch until recovery explicitly clears it. Normal approval/dispatch additionally requires a fresh read-only authority continuity/head check and all existing guards.

If local application fails before any projected row changes, query the same operation ID and abort the reservation under policy; never infer its status. If the local `ANCHOR_PENDING` mutation has already committed, an authority abort alone MUST NOT restore executability: the store MUST remain quarantined while a separately identified compensating operation restores the exact prior logical projection through the full intent/reserve/apply/attest/finalize/anchor lifecycle. The original operation may be recorded as authority-aborted, but the store-wide quarantine MUST NOT clear until the compensating projection is independently `ANCHORED` and current-state equality is proven. If authority finalization succeeds but local finalization fails, reconcile the same operation ID and exact receipt. Any uncertain result remains non-executable and MUST be quarantined. The transition-gate ownership/fencing contract MUST ensure no other projected writer can pass while this saga is unresolved; if the process crashes, recovery MUST reacquire the gate and reconcile before any new mutation or dispatch.

The detailed SQLite transaction choreography MUST avoid a writer lock during network I/O. If the selected schema/connection design cannot durably stage a non-executable intent and safely release the writer lock while retaining transition-gate exclusion, implementation MUST stop and return for a design revision; it MUST NOT approximate distributed atomicity.

## 6. Canonicalization and digest protocol

1. All JSON protocol payloads MUST use RFC 8785 JSON Canonicalization Scheme over the explicitly constrained I-JSON data model.
2. Production adapters MUST parse raw UTF-8 bytes with a strict parser before object materialization. Duplicate decoded member names, including escaped aliases, invalid UTF-8, BOM, trailing content, unsupported numeric tokens, unsafe integers, excessive size/depth/node counts and invalid Unicode MUST be rejected.
3. A verifier receiving an already materialized JavaScript object MUST document that duplicate raw keys are no longer detectable. Every production caller MUST prove strict raw parsing occurred upstream.
4. Numeric domain restrictions, integer ranges, treatment of negative zero, exponent forms, Unicode normalization policy (no implicit normalization), UTF-8 encoding, string escaping and property ordering MUST be explicit in the projection manifest and test vectors.
5. Each component digest MUST use SHA-256 over a domain-separated canonical byte sequence. Domain labels MUST be unique, versioned and unambiguous; concatenation MUST use a specified length-prefix or canonical envelope, never ambiguous raw concatenation.
6. The aggregate envelope MUST include protocol ID/version, database identity tuple, projection manifest digest, component versions and component digests. The aggregate digest MUST be computed over the JCS bytes of that envelope.
7. Cross-language test vectors MUST include canonical input bytes, expected canonical output bytes, component digests and aggregate digest. Vectors MUST cover UTF-16 property ordering, escaping, supplementary Unicode, numeric boundaries, null/omitted distinctions, arrays, empty values and rejected malformed inputs.
8. `JSON.stringify(parsedObject)` MUST NOT be treated as the canonical protocol. Physical `.db`, `-wal`, `.shm`, package or helper file hashes MUST NOT be substituted for logical projection digests.

### 6.1 Normative constrained I-JSON profile (owner decision 2026-10-30)

The Project Owner explicitly confirmed the following values as normative for protocol version 2. They are wire compatibility constraints, not tunable local defaults:

| Constraint | Normative rule |
|---|---|
| Raw JSON size | At most **1,048,576 UTF-8 bytes (1 MiB)**, measured on the original byte sequence before decoding; the limit includes whitespace and all JSON syntax. |
| Canonical JSON size | At most **1,048,576 UTF-8 bytes (1 MiB)** for the canonical UTF-8 output. |
| Nesting depth | Root value has depth 0; a value at depth **256** is permitted; any value deeper than 256 is rejected. |
| Node count | At most **1,000,000 JSON value nodes**; the root counts as one, every array element/object member value counts as one, and object member names do not count as separate nodes. |
| Numbers | Values must be finite IEEE-754 binary64 numbers. Every integer-valued number must be an exactly represented JavaScript safe integer in `[-9007199254740991, 9007199254740991]`. Non-integer finite binary64 values are permitted and serialized using RFC 8785 / ECMAScript number serialization. |
| Negative zero | The raw numeric token `-0` (including exponent/fraction spellings that parse to negative zero) and any materialized negative-zero value are rejected. |
| Unicode | Input must be valid UTF-8; strings and member names must contain well-formed Unicode scalar sequences (no lone surrogates). No Unicode normalization is performed. |
| Object names | Duplicate decoded member names are rejected before materialization, including escaped aliases. |
| Canonical ordering | Object member names are sorted by UTF-16 code units as specified by RFC 8785. Canonical output is UTF-8. |

The parser must consume the original byte sequence, reject a UTF-8 BOM and trailing non-whitespace content, and must not accept a larger caller-supplied limit than the normative 1 MiB ceiling. Implementations must apply the same limits to all v2 protocol payloads and component envelopes. A future change to these limits or numeric/Unicode rules requires an explicit protocol compatibility decision; it must not be introduced as an implementation-only configuration change.

The standalone implementation is in `src/runtime/agg-checkpoint-jcs-v2.js` and delegates raw parsing to `src/runtime/strict-json.js`, whose byte/depth/node constraints are aligned with this profile. The shared JavaScript/Python corpus currently contains 27 canonicalization, strict-parse, generated boundary and component-digest vectors, including the exact numeric-token-to-binary64 checks required by `strict-json.js`. The aggregate-envelope vector remains open until database identity and projection-manifest contracts are fixed. Approval of this profile and completion of these vectors do not close V2-07: aggregate-envelope coverage and runtime integration remain outstanding.

## 7. Trusted measurement and attestation

Production `VERIFIED` measurement requires an actual identified attestation chain and independent verifier appraisal. The evidence MUST bind at least:

- fresh challenge nonce with at least 256 bits of entropy;
- intended audience and relying-party identity;
- unique authority `operation_id`;
- `logical_db_id`, `db_generation`, `restore_epoch`;
- projection manifest/version and host adapter/helper identity;
- all component digests and aggregate digest;
- boot/workload measurement claims and relevant platform state;
- attester identity, verifier identity, appraisal policy/version and appraisal result;
- freshness, expiry and revocation status.

The attester MUST obtain measurement from the exact active database under the approved snapshot and transition-gate contract; it MUST NOT accept caller-supplied digests as measurement. The verifier MUST be independent of the plugin process and MUST authenticate the attestation chain, evaluate an identified policy, enforce nonce/audience/context binding and return an authenticated appraisal result. The relying party MUST validate the appraisal and all digest bindings.

If a supported platform cannot produce the required chain, the capability MUST remain disabled/unverified. Software helper hashes, root ownership, inode checks, signatures over caller-provided values, or a successful local test do not qualify as hardware/host attestation. The threat model MUST state assumptions and limitations for compromised application process, local root, kernel, host administrator, firmware and attestation verifier.

## 8. External checkpoint authority contract

The authority MUST be independently administered and provide durable, authenticated, monotonic operations with these capabilities:

| Operation | Required semantics |
|---|---|
| `prepare/reserve` | Durably reserve exact operation ID, request bytes/hash, prior authoritative head, intended transition descriptor/target commitment, nonce, database identity and expiry. The final measured target digest is bound at finalize. Idempotent for same ID and exact bytes. |
| `finalize` | Durably finalize only the exact prepared operation after all required attestation/appraisal checks; bind the measured target digest/component set and return an authenticated receipt bound to exact request and new authoritative head. |
| `abort` | Durably abort only a valid prepared operation under explicit policy; return authenticated terminal status. |
| `operation-status` | Read-only authenticated lookup by operation ID; same committed operation MUST return the same receipt. |
| `head` | Return authenticated authoritative current head, sequence, digest, identity and generation. |
| `outstanding-operations` | Return a complete, authenticated, paginated listing of all nonterminal operations for the external store identity, with stable pagination/snapshot semantics and proof of completeness. |

Idempotency MUST be keyed by the same `operation_id` and exact canonical request bytes. Reuse of an operation ID with different bytes MUST be rejected. Sequence and prior-head comparison MUST have a documented linearization point. The authority MUST define retention, pagination, nonce consumption, expiry, replication/failover, backup/restore, disaster recovery, key rotation and receipt-verification semantics.

If the authority cannot provide these semantics, this protocol MUST NOT be approximated with remote CAS before local COMMIT. Stop and design a separately approved maintenance-window/manual-reconciliation protocol. The local SQLite database MUST NOT be treated as the independent authority.

### 8.1 Authority state machine

The durable local operation state is one of:

```text
ABSENT -> INTENT_PENDING -> REMOTE_RESERVED -> ANCHOR_PENDING -> ANCHORED
                       \-> ABORTED
                       \-> QUARANTINED
REMOTE_RESERVED -> ABORTED
REMOTE_RESERVED -> QUARANTINED
ANCHOR_PENDING -> QUARANTINED
```

`ANCHORED` and `ABORTED` are terminal outcomes for an individual local operation; `QUARANTINED` requires explicit reconciliation and is never executable. Authority-side states are `PREPARED`, `COMMITTED`, and `ABORTED`. The authenticated `operation-status` response MUST additionally support `NOT_FOUND`, with a documented distinction between never accepted and expired/purged. The protocol mapping MUST be explicit: authority `PREPARED` maps to local `REMOTE_RESERVED`; authority `COMMITTED` maps to receipt verification and local `ANCHORED`; authority `ABORTED` permits local `ABORTED` only when the exact local mutation was not applied or its compensation has completed; `NOT_FOUND` is not terminal unless retention/completeness guarantees prove the operation was never accepted. `NOT_FOUND` may be treated as proof of no reservation only if the authority guarantees durable retention/completeness for the relevant operation horizon; otherwise it is uncertain and MUST quarantine. An expired or uncertain reservation is not equivalent to `ABORTED`; it remains unresolved until the authority returns an authenticated terminal status. Authority transitions MUST be monotonic and idempotent. The wire schema and retention proof remain open gates in §17.

## 9. Local anchor lifecycle and authorization gate

Each local security-projection operation MUST have an explicit durable lifecycle state:

```text
ANCHORED -> INTENT_PENDING -> REMOTE_RESERVED -> ANCHOR_PENDING -> ANCHORED
                           \-> ABORTED
                           \-> QUARANTINED
REMOTE_RESERVED -> ABORTED
REMOTE_RESERVED -> QUARANTINED
ANCHOR_PENDING -> QUARANTINED
ANCHORED -> QUARANTINED
```

`INTENT_PENDING`, `REMOTE_RESERVED`, `ANCHOR_PENDING`, and `QUARANTINED` are non-executable. Any timeout, missing receipt, authority outage, uncertain operation status, invalid attestation, identity mismatch, incomplete outstanding-operation listing, stale head, projection drift or unsupported version MUST remain in a non-executable state or transition to `QUARANTINED`; it MUST NOT revert optimistically to `ANCHORED`. `ABORTED` is permitted only when local state and authenticated authority status agree that the operation was safely aborted. If an already-committed `ANCHOR_PENDING` mutation must be compensated, the compensating mutation is itself a new projection-changing operation subject to the full anchor lifecycle; the store remains quarantined until the restored projection is anchored.

Every mutation affecting either projection MUST enter this lifecycle, including trust-root add/change/revoke, trust observation/high-water updates, reviewer attestation ingestion, maker/checker nonce consumption, candidate/approval/policy/plan changes, and any non-AGG workflow mutation found by the authorization reader inventory. A mutation that does not require a new external anchor MUST have a documented proof that it changes neither projection.

The `WorkflowStore` approval and dispatch guards MUST read the durable anchor state and enforce it at the lowest shared authorization boundary, inside the same synchronization boundary that protects the relevant workflow transition. They MUST validate current database identity and required authority continuity. No task preparation or other lower-level transition may bypass these checks. A preflight result is advisory and cannot grant authority.

No execution/dispatch may begin before state `ANCHORED`. The guard MUST fail closed for unknown state, missing anchor row, schema mismatch, stale projection, incomplete recovery, unsupported platform, authority outage or any verification error.

## 10. Migration and rollback

Migration MUST be a separately identified, recoverable operation. Its immutable record MUST bind:

- `migration_id` and operation ID;
- source and target logical database IDs, generations and restore epochs;
- source/target logical projection digests and manifest versions;
- source/target schema versions;
- cutover sequence and timestamps;
- predecessor/successor identity records;
- exact legacy archive identity and read-only status;
- authority prepare/finalize receipts and recovery status.

The legacy trust database MUST be opened read-only for verification and archival. Migration MUST verify exact row/event counts and content mappings, all five trust domains, history/audit continuity and workflow security projection continuity. No fallback authorization read from legacy storage is allowed after cutover.

Rollback MUST be a new explicit migration/recovery transition with a new generation/epoch and fresh authority reconciliation; it MUST NOT silently restore old files and pretend continuity. The migration MUST be idempotent and recoverable after crashes at every durable boundary. Source/target mismatch or missing archive evidence MUST quarantine the target.

## 11. Restore, clone, promotion and fork

These are distinct lifecycle operations and MUST NOT be inferred from path or inode changes:

- **Restore:** return a database to an earlier backup point. Increment `restore_epoch` through the independent identity issuer, reconcile against the current authority head and all outstanding operations, and quarantine until exact state is resolved.
- **Clone/copy:** create a second physical copy. It MUST receive a distinct logical identity or be explicitly registered as a non-authoritative replica; copied identity metadata alone does not confer authority.
- **Replica promotion:** require an authority-issued promotion record, fencing of the former writer, a new generation/epoch as specified by issuer policy, and full reconciliation before writes/dispatch.
- **Fork:** create a new logical lineage with a distinct identity and explicit authority registration. It MUST NOT inherit production execution authority by copying a database.

Startup, restore, failover and promotion MUST reconcile authoritative head plus the complete outstanding-operation set before any new security transition, approval or dispatch. Missing, orphaned, contradictory, expired-but-unresolved or incomplete records MUST quarantine the database. Manual reconciliation requires an authorized operator action and durable evidence of decision, inputs and resulting head.

## 12. Durability and SQLite requirements

The implementation MUST declare and verify the actual SQLite durability configuration for every connection. WAL mode and `synchronous=FULL` SHOULD be required for security-critical commits where the supported filesystem/runtime contract provides the required guarantees. The exact policy MUST state journal mode, synchronous level, busy timeout, locking mode, foreign-key behavior, checkpoint policy, filesystem assumptions and sidecar handling. Merely issuing PRAGMA statements is insufficient; read back and validate effective values.

The acceptance evidence MUST include process crash, abrupt termination, simulated power-loss/storage failure where feasible, WAL recovery, checkpoint/reopen, long-reader, disk-full, I/O error, permission and sidecar loss/replacement tests on the supported host/filesystem. If the filesystem or host cannot provide the declared durability, production anchoring MUST remain disabled.

## 13. Availability, revocation and emergency operation

New approval and dispatch MUST fail closed whenever the authority is unavailable, stale, uncertain or unable to prove continuity. No local cache may extend authorization beyond its explicitly specified freshness/expiry policy.

Emergency revocation is a separate, explicitly approved and independently auditable operation. It MUST NOT silently bypass anchoring. If external authority cannot verify the revocation transition, affected roots MUST be treated as unusable and the affected authorization domain quarantined. The runbook MUST define who can invoke emergency revocation, how evidence is retained, how propagation is verified, and how normal anchoring resumes.

## 14. Bootstrap and key custody

The first production checkpoint MUST be provisioned out-of-band by the independent authority. No trust-on-first-use, plugin-generated production root, local self-approval, or bootstrap derived solely from the database being measured is permitted.

The checkpoint signer, external store administrator, host attester, attestation verifier and trust-configuration administrator MUST have explicitly documented custody separation. The contract MUST define `key_id`, SPKI pinning, algorithm/encoding, validity, revocation, rotation overlap, compromise response, backup/recovery and audit evidence. Private key material MUST never be stored in the plugin database or exposed in diagnostics. Test-local keys and fake authorities are for protocol tests only.

## 15. Fail-closed matrix

| Condition | Required result |
|---|---|
| Unsupported platform/adapter | Disabled; no approval/dispatch |
| DB identity/generation/epoch unknown or mismatched | Quarantine |
| Writer bypasses barrier or snapshot not coherent | `SNAPSHOT_NOT_ATOMIC`; quarantine |
| SQLite BUSY/LOCKED after bounded retries | Operation fails; no partial authorization |
| Unknown projection/schema/event version | Reject measurement; quarantine |
| Strict JSON/JCS violation or digest mismatch | Reject measurement/receipt |
| Attestation absent, stale, wrong audience/nonce, untrusted verifier | Disabled/unverified; quarantine |
| Authority unavailable or operation status uncertain | Pending/quarantined; no approval/dispatch |
| Outstanding-operation listing incomplete | Quarantine |
| Local/remote head or receipt conflict | Quarantine; manual reconciliation |
| Restore/clone/fork/promotion not registered | Quarantine |
| Emergency revocation cannot be verified | Affected roots unusable |
| Legacy DB needed to authorize after cutover | Reject; migration incomplete |

No failure row in this matrix may be converted into a warning-only condition on a production authorization path.

## 16. Verification and acceptance evidence

The v2 implementation MUST NOT be considered complete until a versioned evidence package contains:

1. Complete authorization reader/writer inventory and reviewed projection manifest, including all non-AGG inputs.
2. Linux adapter evidence for same physical DB identity, connection lifecycle, barrier enforcement, crash recovery and unsupported-platform fail-closed behavior.
3. Barrier/snapshot concurrency tests, including writer interleaving attempts, WAL behavior, `BUSY`/`LOCKED`, invalidation and bounded retries.
4. Migration, exact readback, archive immutability, rollback, restore, clone, promotion and fork tests.
5. RFC 8785/JCS and raw-parser adversarial vectors, domain-separated digest vectors and cross-language reproduction.
6. Actual host attestation chain, identified verifier, appraisal policy, nonce/audience binding, custody and revocation evidence. Test fixtures do not qualify.
7. Actual authority API contract and evidence for durable prepare/finalize/abort/status/head/outstanding operations, idempotency, linearization, pagination completeness, retention, failover and disaster recovery.
8. End-to-end proof that every projection writer is anchored and `WorkflowStore` approval/dispatch rejects every non-`ANCHORED`/uncertain state.
9. SQLite effective PRAGMA readback and supported-filesystem crash/power-loss durability evidence.
10. Outage, emergency revocation, bootstrap, key rotation, compromise and manual reconciliation runbooks with custody evidence.
11. Independent closure evidence for all six existing RC.71 blockers; v2 completion does not waive them.

Tests MUST use disposable databases and fake authorities only for protocol-state-machine tests. They MUST NOT invoke `--advance-external-checkpoint`, mutate production trust/ledger state, or perform approval/dispatch operations. No test result from a fake authority may be described as production authority evidence.

## 17. Open implementation gates (must be resolved before tickets are implementation-ready)

The following are intentionally not guessed in this specification:

- Exact SQL table/column/event inventory for both projections, especially the full execution-authorization read set; this includes resolving whether fields such as `approvals.raw_text` are actually consumed by any authorization/dispatch reader and therefore belong in the projection.
- Exact database-enforced or host-enforced transition-gate primitive, cross-process ownership/fencing and crash recovery on supported Linux deployments; the snapshot contract itself is one SQLite read transaction over the consolidated database, with current-state equality rechecked before anchoring.
- Exact independent issuer mechanism and custody for `logical_db_id`, `db_generation` and `restore_epoch`.
- Exact schema-level encoding, fencing and crash-recovery details for staged intents/compensations, while preserving the normative ordering in §5.3 and never holding SQLite writer locks across network calls.
- Exact schema and canonical request/receipt bytes for authority operations, status wire mapping (including `PREPARED`, `COMMITTED`, `ABORTED`, `NOT_FOUND` and expiry), pagination proof and retention guarantees.
- Actual supported attestation technology, claims, verifier, policy, revocation and threat-model limitations.
- Exact filesystem/storage support matrix and power-loss guarantees.
- Emergency revocation authority, availability objectives and operator runbooks.
- Per-gate evidence owner, artifact format, reproducibility and acceptance threshold.

Each gate MUST become a concrete design sub-decision or externally evidenced dependency before its implementation ticket is marked ready. A builder MUST NOT invent a value where a wrong choice changes security semantics.

## 18. Release boundary and change control

This document and its JCS v2 constrained I-JSON profile were approved by the Project Owner on 2026-10-30. That approval establishes the normative design/profile and does not authorize production provisioning, production trust transitions, approval, dispatch, host restart, package activation or release. External identity, authority, attestation, projection-completeness and recovery evidence gates remain independently required.

Production release remains `BLOCKED` until every v2 evidence gate and every independent RC.71 blocker is closed with the required evidence. Project Owner acceptance records project risk decisions but does not substitute for independent host, verifier, authority or custody evidence.

The implementation MUST preserve the prohibition on `--advance-external-checkpoint` in diagnostics and tests.

## 19. Normative references

- [RFC 8785 — JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)
- [RFC 8032 — Edwards-Curve Digital Signature Algorithm (EdDSA)](https://www.rfc-editor.org/rfc/rfc8032)
- [RFC 9334 — Remote ATtestation procedureS (RATS) Architecture](https://www.rfc-editor.org/rfc/rfc9334)
- [RFC 9711 — The Entity Attestation Token (EAT)](https://www.rfc-editor.org/rfc/rfc9711)
- [SQLite Isolation](https://www.sqlite.org/isolation.html)
- [SQLite Write-Ahead Logging](https://www.sqlite.org/wal.html)
- [SQLite ATTACH DATABASE](https://www.sqlite.org/lang_attach.html)
- [SQLite PRAGMA synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous)
