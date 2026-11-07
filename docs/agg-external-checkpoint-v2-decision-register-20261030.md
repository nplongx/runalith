# AGG external anti-rollback checkpoint v2 decision register

**Date:** 2026-10-30
**Status:** Single-Owner governance, D-01 architecture direction and implementation-design choices, D-03 through D-12 design choices, the normative v2 specification, and the constrained JCS v2 I-JSON wire profile approved by the Project Owner on 2026-10-30. Not fully implemented; no production state transition authorized.
**Related:** [v2 research](agg-external-checkpoint-v2-research-20261030.md), [original v2 proposal](agg-external-checkpoint-v2-design-20261030.md), [production trust runbook](agg-production-trust-provisioning-runbook.md).

## 1. Purpose and decision boundary

This register converts the research findings into explicit project decisions and records the approval boundary for the normative implementation specification. It is a project decision record under the Single-Owner Engineering Governance model in §11. The Project Owner is the accountable decision-maker for project scope, architecture choices and project risk acceptance. External platform, authority and attestation facts still require evidence from those systems; owner approval cannot manufacture that evidence or turn a self-assessment into an independent audit.

The current v1 contract authenticates signed state-digest fields but does not compare them with independently measured local state. Its local SQLite transition callback demonstrates a local transaction only; it is not independent monotonic custody. The original v2 proposal's single-connection `ATTACH` snapshot claim and external-CAS-before-local-`COMMIT` sequence are superseded by the corrections in the research memo and must not be implemented as written.

**Hard boundary:** this work is documentation-only. No runtime, test, package, host, trust, workflow, lease, approval, database or external checkpoint state is changed. Never invoke `--advance-external-checkpoint`, including in tests or diagnostics. Production release remains `BLOCKED`.

## 2. Required security invariants

An approved v2 specification MUST preserve all of these invariants:

1. **Measured equality:** a signed checkpoint is accepted only when every signed component digest equals a digest independently measured from the exact active logical database state under the approved snapshot contract.
2. **Coherent snapshot:** every database writer affecting a projected component participates in one enforced snapshot boundary. A SQLite `ATTACH`, one SQL statement, timestamps, or a process-local mutex alone do not establish that boundary.
3. **Logical projection:** hash versioned SQL-visible state, including committed WAL content. Do not substitute main-file, WAL, SHM, inode, package or helper byte hashes for logical-state measurement.
4. **Projection completeness:** separately bind anti-replay state and full execution-authorization state. The latter covers every durable input that can change approval, candidate reconstruction, reviewer eligibility, plan validation or dispatch.
5. **Canonical bytes:** use one fully specified cross-language canonicalization profile, strict raw parsing, domain-separated component digests and published test vectors. Parsed JavaScript objects cannot reveal duplicate raw JSON keys already discarded by a parser.
6. **Independent authority:** checkpoint monotonicity, attestation verification and key custody are controlled outside the plugin and local workflow/trust databases. SHA-256 and Ed25519 alone do not prove the measurement source is trustworthy.
7. **No distributed-atomicity fiction:** remote reservation/finalization and local SQLite commits form a recoverable state machine. A remote receipt followed by a local commit is not an atomic distributed transaction.
8. **Pending is non-executable:** any local state whose external anchor is pending, unknown, expired or unreconciled MUST be rejected by low-level approval/dispatch boundaries.
9. **Recover after restore:** remote outstanding operations and the authoritative head must be discoverable even when a local database restore erased the corresponding local operation ID.
10. **Fail closed:** unknown schema, projection input, authority outcome, attestation, barrier state, operation listing, receipt, or recovery state blocks approval and dispatch.
11. **No local bootstrap:** first trust anchor is provisioned out-of-band by the independent authority; no trust-on-first-use or plugin-generated production trust.
12. **Independent release gates:** checkpoint v2 does not close any other RC.71 release blocker.

## 3. Architecture decisions requiring owners

The D-01 architecture direction and D-03 through D-12 design constraints have been approved by the Project Owner as recorded in §10. D-02 is not applicable while D-01 remains selected. Approval of a design constraint does not close its evidence gates or authorize implementation.

| ID | Decision owner | Question | Recommended default | Required evidence to close |
|---|---|---|---|---|
| D-01 | Project Owner (approved direction; implementation gates remain open) | Where does checkpointed state live? | One physical SQLite database for workflow state and all projected security-critical state. Use distinct connections/transactions where independent commit semantics are required; measure the projection from one coherent read snapshot. Keep ordinary workflow/business rows in the same file but outside the projection unless an authorization path depends on them. | Complete authorization writer inventory; same-database identity and connection-lifecycle proof; transaction-ordering/busy policy; migration/readback/rollback evidence; disposable concurrency and recovery tests; actual host/attester capability evidence before any attestation claim. |
| D-02 | Host-platform (if D-01 rejected) | How are two DB files serialized? | Host-owned global writer barrier enforced outside plugin call paths; every process/writer must acquire exclusive mode through commit, while snapshot helper holds shared mode through both pinned read transactions and digest computation. | Enumerated writer inventory, enforcement mechanism, lock ownership/lifetime, crash recovery, bypass tests and deployment proof. If any writer can bypass it, reject this option. |
| D-03 | Security + workflow | What exactly is projected and when? | Two versioned projections: `anti_replay_state_sha256` and `execution_authorization_state_sha256`; aggregate checkpoint binds both plus trust-domain and trust-ledger components. | Reviewed schemas, complete reader/writer call graph, event allowlist governance, lifecycle matrix for candidate/approval/trust/revocation/dispatch, and mutation-to-digest tests. |
| D-04 | Security + interoperability | Which canonicalization profile? | RFC 8785 JCS over strict I-JSON input, with explicit protocol/domain separation and cross-language vectors. | Approved profile/version, numeric range policy, duplicate-key and Unicode handling, vector corpus and independent implementation agreement. |
| D-05 | Host-platform security | What constitutes trusted measurement? | Use an actually available platform attestation chain; do not assume TPM/TEE availability. Bind challenge nonce, audience, operation ID, exact database identity, projection/helper version and digests into verifier-appraised evidence. | Platform inventory, measured boot/workload chain, attester/verifier identities, policy, data-binding proof, revocation and key-custody plan, and explicit root-compromise assumptions. |
| D-06 | External authority/operator | What remote API and durability contract exist? | Durable `prepare/reserve`, `finalize`, `abort`, `operation-status`, authoritative `head`, and complete paginated `outstanding-operations`; same operation ID and identical request bytes return same outcome/receipt. | API/schema, CAS linearization point, retention and pagination guarantees, nonce semantics, replication/failover model, disaster-recovery proof and signed test vectors. |
| D-07 | Security + workflow | Which local changes require an anchor? | Every mutation affecting either projection enters an explicit anchor lifecycle. No candidate/approval/trust mutation becomes executable before anchoring. | Writer inventory and lifecycle matrix; proof no mutation path bypasses pending/anchored guard. |
| D-08 | Database/platform | What durability is required? | Explicitly pin and verify SQLite durability settings appropriate to the power-loss threat model; assess WAL `synchronous=FULL` rather than assuming default durability. | Power-loss/storage assumptions, PRAGMA verification, filesystem/device guarantees and crash/power-cut test evidence. |
| D-09 | Operations + security | What happens during authority outage or emergency revocation? | Approval/dispatch fail closed; emergency revocation has a separately approved, independently auditable path and cannot silently bypass anchoring. | Availability SLO, break-glass authority, revocation propagation, operator runbook and tabletop/crash exercise. |
| D-10 | Trust administrators | How are roots bootstrapped and rotated? | Out-of-band bootstrap; checkpoint signer and store/attestation verifier independently administered; explicit key IDs, SPKI pins, validity, revocation and overlap policy. | Signed bootstrap ceremony, custody records, rotation/revocation tests and administrator separation evidence. |
| D-11 | Operations + workflow | How are pending operations recovered? | Reconcile remote head and the complete outstanding-operation set before any new transition or dispatch; unknown/missing/orphaned state quarantines. | Startup/recovery algorithm, retention and completeness proof, restore/failover tests, manual reconciliation authority and evidence retention. |
| D-12 | Security + release owner | What is the production acceptance boundary? | V2 is a separate release gate; all six existing RC.71 blockers remain independent. | Signed owner acceptance, host provisioning evidence, independently verified authority/attestation, production recovery evidence and separate closure evidence for each RC.71 blocker. |

## 4. Recommended state and digest model

The aggregate checkpoint should bind these independently versioned components:

- `trust_domain_state_sha256`: exact five effective AGG trust-domain configurations, scopes, providers, versions, fingerprints, SPKI roots, key IDs, validity and revocation state.
- `trust_ledger_state_sha256`: logical trust-ledger schema and complete relevant history/event rows, identities and audit bindings.
- `anti_replay_state_sha256`: all consumed maker/checker/reviewer nonces, approval evidence, policy high-water observations, reviewer identity/replay evidence and associated revocation/consumption state.
- `execution_authorization_state_sha256`: every durable input that can change current approval, candidate reconstruction, immutable plan, reviewer eligibility, evidence lineage, runtime/lifecycle or dispatch result. At minimum, include the relevant job/runtime rows; ordered proposal history; approval rows and ordering identities; plan and compiled-plan event; policy attachments; candidate event and action-intent bindings; source graph/evidence/lineage; relevant tasks, attempts, results, artifacts, sessions and events; custom workflow, role, validation and write-scope inputs; and the anti-replay component.
- `aggregate_state_sha256`: domain-separated canonical envelope binding schema ID/version, canonicalization profile, all component IDs/versions/digests and projection implementation identity.

Projection rules:

- Define exact tables, columns, row filters, ordering and tie-breakers. Preserve semantic ordering currently based on `created_at,rowid`, or replace it only through an explicit migration with stable immutable ordering identities.
- Include schema/contract definitions and required PRAGMA values where they affect interpretation or authorization. Exclude unstable physical layout details unless deliberately normative.
- Reject unknown authorization event types, malformed/noncanonical payloads, missing required rows, duplicate identities, inconsistent effective configuration/history and unsupported values. Never silently omit malformed state.
- Do not include private key material or emit row payloads in reports. Return bounded metadata only: projection/schema version, component digests, counts, database identity and safe blocker codes.
- Decide and prove whether `approvals.raw_text` is excluded; exclusion is valid only if no authorization/readback path depends on it.
- Any change to a projected field, row, schema, policy input or relevant code contract must either change the digest or make measurement fail closed.

The projection lifecycle must be explicit. Candidate creation, approval, reviewer attestation, policy high-water, trust-root change/revocation, execution lease/fencing and dispatch may each alter the projection. Owners must decide whether each transition requires a new anchor before becoming visible or executable; the safe default is yes for every authorization-relevant mutation.

## 5. Recommended recoverable transition protocol

This is a saga/state-machine proposal, not a distributed transaction. All steps are blocked pending approval of D-01 through D-12 and the normative specification.

### 5.1 States

Local transition states:

- `INTENT_PENDING`: durable local operation intent exists; no authorization granted.
- `REMOTE_RESERVED`: authority has durably reserved the operation; still non-executable.
- `ANCHOR_PENDING`: exact local security state is committed but not externally finalized; still non-executable.
- `ANCHORED`: exact signed final receipt is verified and durably associated with exact local projection; eligible for normal independent continuity checks.
- `ABORTED`: authority and local state agree operation was safely aborted; no authorization granted.
- `QUARANTINED`: any unknown, conflicting, incomplete, expired or unverifiable outcome; no authorization granted.

Only `ANCHORED` may satisfy the local anchor predicate. `ANCHORED` is not by itself permission to dispatch: the execution boundary must also revalidate the current projection and fresh external continuity, approval, reviewer, candidate, plan, lifecycle and all other existing guards.

### 5.2 Transition sequence

1. **Prepare locally:** under a short local transaction, validate current trust/policy/replay/candidate preconditions and persist a stable `operation_id`, request nonce, expected prior sequence/digest, intended transition descriptor and projection version. Commit the intent with explicitly selected durability. Do not hold a DB writer lock over network I/O.
2. **Reserve remotely:** send the exact operation ID and canonical request bytes. Authority atomically reserves nonce and expected prior head, records the request digest, and returns signed `PREPARED`. Identical retry returns the same result; changed bytes under same ID are rejected.
3. **Apply locally pending:** re-enter a local transaction, revalidate preconditions and intent, apply the exact authorization-relevant changes tagged to the operation, set `ANCHOR_PENDING`, compute/store the exact projection identity from that same coherent state, and commit. Low-level approval/dispatch guards reject it.
4. **Measure and finalize remotely:** trusted attester independently reads the committed state under the approved snapshot contract, computes projections, and binds challenge nonce, audience, operation ID, DB identities, projection/helper versions and digests into evidence. The authority verifies evidence and atomically finalizes CAS from the expected prior head, consuming nonce and recording immutable operation outcome plus signed `COMMITTED` receipt.
5. **Finalize locally:** verify receipt signature, authority/store identity, operation ID, nonce, prior/new sequence and digest, all component digests, candidate/rollback binding and attestation reference. In a local transaction, record receipt/reference and transition exact matching operation from `ANCHOR_PENDING` to `ANCHORED`; read back and commit.
6. **Authorize:** only after local `ANCHORED`, fresh read-only remote continuity/head verification, exact current projection equality and all existing approval/dispatch guards may execution proceed.
7. **Recover every ambiguous result:** query by the same operation ID; never infer from timeout and never retry with a new nonce. `COMMITTED` returns the same immutable receipt; verify and complete local finalization. `PREPARED` may resume or be aborted under policy. `ABORTED` is terminal only with authenticated authority evidence and matching local state. `NOT_FOUND` is meaningful only if the authority guarantees durable status retention and complete reconciliation semantics.
8. **Reconcile after restore/startup:** before any new operation or dispatch, fetch authenticated authoritative head and the complete outstanding-operation set, with authenticated pagination or equivalent completeness proof. Compare them against local anchored state, intents and pending operations. A local restore may erase an operation ID; therefore local-ID-only lookup is insufficient. Any orphan remote reservation, missing local intent, local/remote digest mismatch, stale replica, incomplete listing or unknown status quarantines the store.
9. **Trust changes:** apply the same lifecycle to trust configuration changes and emergency revocation. Define a fail-closed emergency path before implementation; do not let external unavailability silently preserve a revoked root or permit unanchored trust mutation.

If the external authority cannot provide durable reservation, idempotent finalize/status, authoritative head and complete outstanding-operation reconciliation, this protocol is not implementable safely. Owners must design a controlled maintenance-window/manual-reconciliation protocol instead; do not revert to remote-CAS-before-local-COMMIT.

## 6. Attestation contract questions that cannot be guessed

The implementation team must not select a fictitious TPM/TEE or claim software helper hashing is hardware attestation. Platform owner must identify:

- actual platform and available hardware/remote attestation capability;
- Attester, Verifier and Relying Party identities and administrative separation;
- measured boot and workload chain covering the helper and its data path;
- how the attester opens the exact active DB/WAL handles without path/descriptor replacement races;
- how the helper itself computes the logical projection rather than accepting caller-supplied digest;
- binding of authority nonce, audience, operation ID, DB identity, projection version, helper measurement and component digests into evidence;
- verifier appraisal policy, freshness, key custody, revocation, replay protection and verifier availability;
- explicit assumptions for compromised application process, host root, kernel, hypervisor, storage administrator and attestation key;
- evidence format, retention, rotation and independent audit requirements.

A root-owned helper path, SHA-256 executable pin, inode check, software signature or self-reported digest is useful defense in depth, but does not independently prove that an uncompromised measured environment computed the digest from the intended live state.

## 7. Minimum acceptance evidence before implementation

Implementation must not begin until the Project Owner has explicitly approved a normative specification, and all required external evidence has been obtained, containing:

- D-01 through D-12 decisions with the Project Owner recorded as accountable for project-controlled choices, plus identified external evidence providers where factual claims depend on them;
- full state projection schemas, event allowlists, lifecycle and writer inventory;
- chosen coherent snapshot contract and proof every writer is forced to participate;
- canonicalization profile, domain-separated envelopes, integer/string constraints and cross-language vectors;
- attestation platform, evidence claims, verifier policy and threat model;
- external API, immutable operation record, CAS linearization point, idempotency, status/head/list completeness and disaster recovery;
- local state machine, pending/anchored low-level guards and startup/restore reconciliation;
- durability and power-loss model;
- bootstrap, key rotation/revocation, emergency path, availability policy and operator runbook;
- migration/compatibility plan that preserves existing approval semantics and historical evidence.

Required disposable-test families are enumerated in research memo §5. In particular, prove concurrent writer snapshot correctness; WAL/checkpoint equivalence; restore rollback detection; projection completeness; strict raw JSON rejection; attestation nonce/data binding; every saga crash window; orphan remote reservation recovery after local restore; authority failover; and rejection of every non-`ANCHORED` state at the lowest dispatch boundary. Tests must use disposable databases and fake authority only. They do not establish production authority.

## 8. Existing RC.71 release blockers remain independent

The following six blockers remain open and must not be closed by this register, local tests, package hashes, local trust ledgers or a future v2 implementation alone:

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED`
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`
6. `RUNNING_TASKS_MUST_DRAIN`

No production trust provisioning, checkpoint advancement, approval/dispatch, workflow/task/lease mutation, host restart, package activation or release authorization is performed or implied by this document.

## 9. Primary research basis

This register relies on the primary sources and source-level findings cited in [the research memo](agg-external-checkpoint-v2-research-20261030.md), especially:

- SQLite Isolation, WAL, ATTACH, Transactions, Database Snapshot API, Online Backup API and `PRAGMA synchronous` documentation;
- RFC 8785 (JCS), RFC 8032 (Ed25519), RFC 9110 (idempotency/conditional requests), RFC 9334 (RATS architecture), RFC 9711 (EAT nonce/freshness);
- NIST FIPS 180-4 (SHA-256);
- repository implementation paths and line references recorded in the research memo §§1–3.

## 10. Project Owner decision: D-01 architecture direction

On 2026-10-30 the Project Owner approved the recommended D-01 architecture direction: consolidate checkpointed security-critical state into the same physical SQLite file as workflow state, while retaining a dedicated connection and independent commit for trust-ledger observations. D-01's **architecture direction is APPROVED** for specification work. This does not approve the normative v2 protocol, close the evidence gates below, authorize runtime changes or migration, permit production state transitions, or authorize checkpoint advancement. The Project Owner's approval is not independent Security review, host-platform certification, external-authority approval, or attestation evidence.

### 10.1 Intended connection and transaction model

- `workflow.db` remains the one physical database file. The current `agg-trust-configuration.db` is a legacy separate-file arrangement to be retired only through an approved migration.
- The workflow store continues to use its normal connection and transaction boundaries for workflow mutations, approval rows/events, approval-policy high-water events, replay/nonce checks, and authorization inputs stored in workflow tables.
- Trust configuration history and rejection events move into the same physical file, but trust observation uses a distinct `DatabaseSync` connection to that same canonical database path. It must not borrow a connection already inside an approval transaction.
- The trust-observation transaction commits independently. A later workflow approval rollback must not roll back an already committed trust configuration observation. This is transaction independence, not file independence.
- A checkpoint measurement opens/uses a read transaction over the shared database and reads every projected component from that one SQLite snapshot. Do not use `ATTACH` as a substitute for a common snapshot, and do not hash database/WAL/SHM physical bytes.
- SQLite still has one writer at a time per database file. Busy handling, transaction ordering, read-snapshot lifetime, WAL durability, and lock contention must be specified and tested. Do not hold a write transaction open across network calls to the external authority.

### 10.2 Scope boundary

The user-selected direction is not permission to treat only the two trust-history tables as the entire security projection. The projection must also cover the workflow-resident authorization inputs identified in §4, including approval events and nonce/replay evidence, policy high-water observations, candidate/plan/evidence lineage, relevant task/runtime/lifecycle inputs, reviewer attestations, and any other durable row read by an authorization or dispatch guard. Ordinary workflow/business data may remain outside the *projection*, but it remains in the same physical database file. A row is in scope whenever a current authorization path depends on it.

### 10.3 Migration and compatibility gates

Before implementation, owners must approve a migration that inventories the active trust-ledger file, validates its schema and append-only history, copies/verifies every history and rejection-event row into the shared database without loss or identity collision, proves exact readback, and defines a recoverable cutover/rollback procedure. The legacy file must not be deleted or silently ignored as part of cutover. Existing checks that currently require two different file descriptors/inodes (notably `scripts/runalith-rollout.mjs` and its tests, plus trust runbook statements) must be redesigned to prove two distinct connections to the same database identity and the required independent commit semantics. Historical server snapshots and immutable evidence artifacts must not be rewritten.

### 10.4 D-01 implementation-design choices approved on 2026-10-30

The Project Owner explicitly accepted all six recommendations in the next design round. These choices narrow the specification; they do not establish that the host or external systems can satisfy them.

1. **Platform support:** Linux is the initial supported platform for the v2 measurement path. Windows, macOS and BSD must fail closed until a platform-specific adapter can prove the required database identity, open-handle and snapshot properties. This is a support-scope decision, not proof that the current Linux host meets the contract.
2. **Database selection:** the dedicated trust connection must resolve the same canonical `WORKFLOW_DB` selected by the workflow store, rather than a hard-coded `dataDir/agg-trust-configuration.db`. Equality of path strings alone is insufficient; runtime identity checks remain mandatory.
3. **Database identity:** distinguish logical database identity from path/inode identity. The protocol must bind a `logical_db_id`, `db_generation` and `restore_epoch`; their issuer, custody and increment rules must be authoritative and resistant to plugin-only rewriting. These fields are protocol requirements, not self-authenticating proof when stored only in the SQLite file.
4. **Trust writes during checkpoint:** do not allow trust-ledger writes to interleave with a checkpoint snapshot. Specify an explicit barrier/serialization protocol or detect any relevant trust-state change and invalidate the measurement. Define bounded `SQLITE_BUSY` handling and retry semantics; never swallow acquisition errors or retry indefinitely. Exact mechanism and policy remain specification work.
5. **Migration identity:** migration must create an immutable migration record binding `migration_id`, source and target logical digests, schema versions, cutover sequence, and predecessor/successor database identities. The legacy database remains verified and read-only after cutover; it is not an authorization fallback. Deletion requires a separate retention decision.
6. **Restore and clone:** distinguish restore, copy/clone, replica promotion and fork as separate lifecycle events. A restored or cloned database is quarantined until the authoritative checkpoint head and all outstanding external operations have been reconciled. Path or inode change alone does not prove continuity or establish a new legitimate generation.

The following remain open D-01 evidence/implementation gates: safe two-connection lifecycle on the selected host; a trustworthy database identity and generation/restore-epoch issuer; the exact snapshot barrier and bounded busy/retry protocol; complete authorization writer/projection inventory; migration readback and recoverable rollback; and disposable concurrency, crash, restore, clone and recovery tests. No runtime implementation or test changes are authorized by the design decisions alone. D-02 is not applicable while the approved D-01 single-database direction stands. D-03 through D-12 are approved design constraints but their evidence gates remain open. External host, verifier and authority capabilities still require real evidence.

### 10.5 D-03 through D-08 owner decisions (2026-10-30)

The Project Owner explicitly accepted all six recommendations in the second design round. These are design constraints for the normative specification, not evidence that any external dependency or host capability currently exists.

1. **D-03 — Security projection:** define two separately versioned projections: `anti_replay_state_sha256` and `execution_authorization_state_sha256`. The latter includes every durable input actually read by authorization/dispatch paths, including relevant non-AGG rows. Unknown or unsupported schema/event inputs fail closed rather than being omitted.
2. **D-04 — Canonicalization:** use RFC 8785 JCS over strict I-JSON input, with raw duplicate-key rejection before object materialization, explicit numeric/Unicode/UTF-8 rules, domain-separated component digests, and cross-language test vectors. `JSON.stringify()` over an already parsed object is not the protocol contract.
3. **D-05 — Trusted measurement:** production trusted-measurement claims require a real, identified attestation chain and independent verifier appraisal. Evidence binds challenge nonce, audience, operation ID, database identity, projection/helper version and component digests. If the deployed platform cannot meet the contract, the capability remains disabled/unverified; software hashes or root-owned helpers alone are not hardware attestation.
4. **D-06 — External authority:** the authority contract requires durable `prepare/reserve`, `finalize`, `abort`, `operation-status`, authoritative `head`, and complete paginated `outstanding-operations`; idempotency is bound to the same `operation_id` and exact request bytes. If the actual authority cannot provide these semantics, stop this protocol and design a separately approved maintenance-window/manual-reconciliation process; do not substitute remote-CAS-before-local-COMMIT.
5. **D-07 — Anchor coverage:** every mutation that changes either security projection must enter the anchor lifecycle. No authorization-relevant mutation may become executable before its matching state is `ANCHORED`.
6. **D-08 — SQLite durability:** specify and verify SQLite durability settings against the power-loss threat model rather than relying on defaults. Evaluate/require `WAL` with `synchronous=FULL` for security-critical commits where supported by the approved filesystem/storage contract; validate actual PRAGMAs and require crash/power-loss evidence.

These approvals do not resolve the exact projection table/column inventory, canonicalization edge-case policy and vectors, available attestation chain, actual authority API/retention/failover guarantees, complete mutation lifecycle, or supported storage/filesystem durability. Those remain evidence and specification gates. No runtime or test changes are authorized by this entry.

### 10.6 D-09 through D-12 owner decisions (2026-10-30)

The Project Owner explicitly accepted all four recommendations in the final design round. These decisions complete the owner-choice round for D-01 and D-03 through D-12; they do not close implementation evidence gates.

1. **D-09 — Authority outage and emergency revocation:** new approval and dispatch fail closed when authority state is unavailable or uncertain. Emergency revocation uses a separately approved, independently auditable path; it cannot silently bypass anchoring. If revocation state cannot be verified, affected trust roots remain unusable.
2. **D-10 — Bootstrap and key lifecycle:** bootstrap trust roots out-of-band. Checkpoint signer, store administrator and attestation verifier custody/administration are separated. Define `key_id`, SPKI pinning, validity, revocation and rotation-overlap rules. Never generate or implicitly trust production roots inside the plugin.
3. **D-11 — Recovery and reconciliation:** after startup, restore or failover, reconcile authoritative head and the complete outstanding-operation set before any new transition or dispatch. Missing, incomplete, orphaned or contradictory state results in quarantine. Manual reconciliation requires an authorized procedure and retained evidence.
4. **D-12 — Production acceptance:** checkpoint v2 is an independent release gate; all six RC.71 blockers remain independent. Production enablement requires host/attestation, authority, migration/recovery and per-blocker closure evidence. Without independent external evidence, the capability remains disabled/unverified and cannot be represented as production-ready.

The following remain open: outage SLO and exact break-glass authority; revocation propagation and operator runbook; bootstrap ceremony and custody evidence; concrete key rotation/revocation protocol; authority retention/completeness guarantees for recovery; exact acceptance criteria and evidence packages for each gate. No runtime or test changes are authorized by this entry.

### 10.7 Normative v2 specification approval (2026-10-30)

- **Owner decision:** the Project Owner explicitly approved `agg-external-checkpoint-v2-normative-spec-20261030.md` on 2026-10-30 for implementation planning.
- **Approval scope:** this approves the normative protocol, invariants, saga ordering, projection requirements, fail-closed behavior, and listed acceptance/evidence gates as the project specification baseline.
- **Not authorized:** this approval does not authorize runtime or test edits, ticket/issue creation, trust provisioning, database migration, production configuration changes, checkpoint advancement, approval/dispatch, workflow/task/lease mutation, host restart, package activation, or production release.
- **Remaining gates:** all open implementation/evidence gates in the specification and all six independent RC.71 blockers remain open. Production release remains `BLOCKED`; v2 remains disabled/unverified until the required evidence and separate release approvals exist.
- **Assurance:** this is Project Owner approval of a project specification. It is not independent Security approval, external host certification, attestation appraisal, authority certification, or an independent audit.

### 10.8 JCS v2 constrained I-JSON wire profile approval (2026-10-30)

- **Owner decision:** the Project Owner explicitly confirmed the five proposed profile limits and numeric restrictions on 2026-10-30.
- **Normative raw JSON ceiling:** 1,048,576 UTF-8 bytes (1 MiB), measured before decoding and including whitespace/syntax.
- **Normative canonical output ceiling:** 1,048,576 UTF-8 bytes (1 MiB).
- **Normative structural bounds:** maximum nesting depth 256 (root depth 0) and maximum 1,000,000 JSON value nodes (root counts; member names do not).
- **Normative numeric domain:** finite IEEE-754 binary64; integer-valued numbers must be exactly represented safe integers in ±(2^53−1); finite non-integer binary64 values use RFC 8785/ECMAScript serialization; negative zero is rejected.
- **Normative text/object rules:** valid UTF-8, no BOM, no trailing content, no lone surrogates, no Unicode normalization, duplicate decoded object names rejected before materialization, UTF-16 code-unit member sorting, UTF-8 canonical output.
- **Compatibility:** these rules are mandatory for protocol version 2 and cannot be relaxed by deployment configuration. Any change requires an explicit compatibility decision and corresponding cross-language vectors.
- **Not implied:** this decision does not close V2-07; aggregate envelope, expanded boundary vectors, implementation conformance and runtime integration remain open. It does not establish independent database identity, authority, trusted attestation or production readiness.
- **Assurance:** this is a Project Owner protocol-profile decision, not independent Security approval or external certification.

## 11. Single-Owner Engineering Governance

### 11.1 Accountability and decision authority

- **Accountable Project Owner:** the sole project maintainer. The Project Owner may approve project architecture, prioritize work, define the project's supported platform boundary, accept explicitly described project risks, and authorize project releases.
- **Engineering assistant:** may inspect source, produce technical findings, propose designs, implement explicitly authorized changes, and run bounded validation. It is not an independent reviewer, Security authority, host-platform owner, attester, verifier, or release auditor. Its own analysis must not be represented as independent approval.
- **External evidence providers:** host, operating system, attestation verifier, external checkpoint authority, identity provider and other external systems remain sources of evidence for claims about their behavior. The Project Owner can accept a documented limitation or defer the feature; they cannot waive a factual requirement while continuing to claim it has been satisfied.

The absence of separate project personnel does not create fictitious approvers or an indefinite approval queue. Project-controlled decisions are made by the Project Owner and recorded here. Where independent evidence is unavailable, the corresponding capability/claim stays disabled, unverified, or explicitly out of scope; release remains blocked if that evidence is a release prerequisite.

### 11.2 Decision record format

Each material decision must record:

1. **Technical finding:** observed source facts, known limitations and evidence references, separated from assumptions.
2. **Owner decision:** the Project Owner's explicit choice and the scope/version it applies to.
3. **Risk acceptance:** the concrete residual risk accepted, the reason, compensating controls and expiry/revisit trigger. Silence or a general “approved” is not blanket acceptance of unknown risks.
4. **Evidence gate:** tests, source inventory, host measurements, external receipts or operational proof still required before implementation, enablement or release.
5. **Assurance limitation:** whether evidence is self-reviewed, locally tested, externally verified or independently audited. Never upgrade the assurance label without corresponding evidence.

### 11.3 D-01 owner decision and risk boundary

- **Technical finding:** RC.71 currently stores trust configuration history separately from workflow state. Existing approval/attestation paths can acquire a workflow writer transaction and then attempt a trust write on another connection. SQLite serializes writers per database file, so simply redirecting the trust connection to `workflow.db` without transaction-ordering changes risks writer contention and `SQLITE_BUSY`. Current rollout checks also assume distinct database files/inodes and must be redesigned.
- **Owner decision:** approve the single-physical-database direction in §10 for continued specification and implementation planning. Retain a dedicated trust `DatabaseSync` connection; trust observations must commit before entering a workflow write transaction. Trust reads inside an active workflow write transaction are read-only. Re-check the relevant trust configuration/state immediately before accepting reviewer attestation or approval; if it changes between observation and acceptance, fail closed or retry according to a specified protocol. Do not hold a writer lock during external authority calls. Preserve the legacy trust database as a verified, immutable read-only archive after cutover; it is neither an authorization source nor an automatic fallback, and deletion requires a separate retention decision.
- **Risk acceptance:** this approval accepts the architectural trade-off of colocating workflow and trust-ledger records in one SQLite file, including shared single-writer contention and the need for strict transaction ordering. It does **not** accept silent `SQLITE_BUSY` failures, incomplete authorization projections, unverified database identity, unproven host attestation, data-loss migration, or release with unresolved blockers. Those remain fail-closed gates.
- **Evidence required:** complete authorization writer/projection inventory; canonical database identity and two-connection lifecycle proof; explicit busy/retry/snapshot/WAL durability policy; migration inventory, exact readback and recoverable rollback; redesign and tests for rollout/runbook assumptions; disposable concurrency, crash, restore and recovery tests; host evidence for any claimed measurement/attestation property.
- **Assurance:** this is a Project Owner architecture decision informed by source-level analysis. It is not independent Security approval, independent host-platform review, production verification, or an attestation result.

### 11.4 Release and change-control boundary

This decision authorizes documentation/specification work only. It does not authorize implementation, test changes, trust provisioning, database migration, production configuration changes, checkpoint advancement, approval/dispatch, workflow/task/lease mutation, host restart, package activation, or release. Such work requires a separately scoped explicit authorization after its prerequisites and evidence gates are presented. The six RC.71 blockers in §8 remain open and independent.

### 11.5 D-01 six-choice owner confirmation

- **Technical finding:** the source audit and research memo identify Linux-specific descriptor inspection, configurable workflow database selection, SQLite single-writer contention, restore/clone ambiguity and the absence of an authoritative logical database identity contract. None of these facts is resolved by selecting a design direction.
- **Owner decision:** on 2026-10-30 the Project Owner responded “đồng ý với cả 6” to the six recommendations in §10.4. All six are accepted as normative design constraints for the next specification draft.
- **Risk acceptance:** the Project Owner accepts Linux-only initial support and fail-closed behavior on unsupported platforms. No risk is accepted for fabricated identity, unverified generation/restore epoch, interleaved snapshot writes, unbounded retries, incomplete migration, or treating a clone/restore as continuous without reconciliation.
- **Evidence gate:** platform adapter proof; authoritative logical identity/generation/restore-epoch custody; barrier and `SQLITE_BUSY` tests; migration digest/readback/rollback tests; and restore/clone/fork reconciliation tests remain required.
- **Assurance:** these are owner-selected design constraints based on local technical analysis, not host certification, external authority guarantees, independent review or production evidence.

### 11.6 D-03 through D-08 owner confirmation

- **Technical finding:** the current proposal needs a complete authorization projection, interoperable canonical bytes, a real measurement trust chain, recoverable external operation semantics, anchor coverage for all authorization mutations, and an explicit SQLite durability contract. These are distinct dependencies; approval of the design does not prove their availability.
- **Owner decision:** on 2026-10-30 the Project Owner responded “Đồng ý cả 6” to the D-03 through D-08 recommendations. All six are accepted as normative design constraints for the next specification draft.
- **Risk acceptance:** no risk is accepted for incomplete projection coverage, parser ambiguity, fabricated attestation, authority semantics that cannot recover ambiguous outcomes, executable unanchored mutations, or unverified durability settings. Such conditions remain fail-closed.
- **Evidence gate:** complete source-level reader/writer inventory and mutation tests; strict parser and cross-language vectors; platform/attester/verifier capability and custody evidence; authority API and recovery guarantees; anchor lifecycle coverage tests; and storage-specific PRAGMA/crash/power-loss evidence.
- **Assurance:** these are Project Owner design decisions informed by local analysis. They are not independent Security approval, platform certification, authority contract acceptance, verifier appraisal, or production test results.

### 11.7 D-09 through D-12 owner confirmation

- **Technical finding:** authority outages, emergency revocation, trust-root custody, ambiguous recovery outcomes and production acceptance are independent operational/security concerns. Local code cannot establish external authority availability, independent custody or host attestation.
- **Owner decision:** on 2026-10-30 the Project Owner responded “Đồng ý cả” to the four D-09 through D-12 recommendations in the final design round. All four are accepted as normative design constraints for the next specification draft.
- **Risk acceptance:** no risk is accepted for fail-open approval/dispatch during authority uncertainty, unanchored break-glass revocation, plugin-generated production roots, incomplete recovery listings, or release based on self-attestation alone.
- **Evidence gate:** outage/revocation tabletop and crash exercises; signed bootstrap/custody records and rotation/revocation tests; authority outstanding-operation retention and pagination proof; restore/failover/manual-reconciliation evidence; and separate closure evidence for all six RC.71 blockers.
- **Assurance:** these are Project Owner decisions informed by local analysis, not independent Security approval, authority certification, key-custody audit or production release approval.
