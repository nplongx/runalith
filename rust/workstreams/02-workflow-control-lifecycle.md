# Workstream 2 — Workflow Control & Lifecycle

**Deployable:** A. Workflow Control (one of the three deployables in ADR 0003).
**Status:** planning/contract-definition baseline; implementation ownership unassigned.
**Authority:** [`EIGHT_PART_PARALLEL_PLAN.md`](../EIGHT_PART_PARALLEL_PLAN.md) and accepted [ADR 0003](../../docs/adr/0003-three-part-rust-deployment.md).
**Change boundary for this work package:** documentation and isolated contract/test design only. No source, schema, database, manifest, service, deployment, migration or cutover change is authorized by the eight-workstream plan.

## 1. Mission

Decide whether a workflow or task may advance, issue the authoritative identity and fence for work, and preserve the append-only history that explains every accepted lifecycle transition.

Control is the sole authority for workflow/task/attempt/lease state. An Execution observation is evidence submitted to Control; it does not itself change Control state. A Governance receipt is external authorization evidence; it does not itself approve or advance a workflow. A timestamp, expired lease, worker exit, provider response, missing row or narrative assertion is not a substitute for the exact authority and fence required by a transition.

This workstream is an implementation domain inside the Workflow Control deployable. It is **not** a fourth service, a second orchestration engine, or a permission to split the current compatibility Store.

## 2. Ownership boundary

### 2.1 Control owns

1. **Workflow instances and lifecycle:** workflow identity, immutable plan binding, lifecycle state, accepted commands, cancellation intent and projections, event history, and synthesis over Control-owned facts.
2. **Task/dependency state:** task identity and state, dependency readiness, attempt ledger, admission/concurrency decisions, and workflow-local scheduling eligibility.
3. **Coordinator and fairness:** claim eligibility, bounded concurrency, scheduling order/fairness and coordination policy. Scheduling cannot bypass authorization, dependency, cancellation or lease fences.
4. **Claims and leases:** claim identity, lease ID, attempt number, owner epoch, worker binding, expiry/renewal and stale-owner rejection. Control alone issues claim identity and changes these records.
5. **Lifecycle event journal:** append-only events, ordering/sequence rules, exact subject binding, event-to-projection application, and replay/idempotency decisions for Control-owned transitions.
6. **Task-result inbox:** authenticated producer admission, immutable event identity/digest, durable receipt, duplicate/conflict handling, ordering and fenced application to Control state.
7. **Workflow-local policy:** attachment of a versioned policy pack to a workflow, immutable policy snapshot/digest, local enforcement and success-predicate evaluation. This does not confer trust or approval authority.
8. **Authorization references:** exact binding of Governance-signed approval/authorization evidence to workflow, candidate, plan digest, action, audience and relevant version. Control validates; Governance remains signer and source of truth.
9. **Cancellation orchestration:** durable cancellation request, admission freeze, read model and orchestration of the eventual Control-owned terminal decision after required external receipts are verified.
10. **Recovery and disposition orchestration:** read-only recovery evidence projection, completeness assessment, UNKNOWN/UNRESOLVED preservation, and (only after approval of the cross-part contract) authoritative disposition application.

### 2.2 Control does not own

| Domain | Owner | Control interaction |
|---|---|---|
| Workflow/catalog/role/typed-I/O definitions and immutable plan compiler | W1 — Workflow Catalog & Plan Compiler | Consume `CompiledPlanV1`; do not edit compiler internals or infer plan content. |
| Trust roots, reviewer registry, signer/key custody, nonce consumption, approval decision truth and global authorization policy | W6 — Governance Authority | Consume exact signed receipts/projections through a versioned authenticated contract; never query Governance tables. |
| Worker process lifecycle, sandbox, process-tree/cgroup stop, worker-local observations | W3 — Worker Runtime & Sandbox | Consume authenticated execution observations and process-stop receipts; do not terminate or inspect processes directly. |
| Provider dispatch/run identity, provider status and provider terminality | W4 — Provider Effects & Reconciliation | Consume provider observations/terminal proof; do not infer terminality from a worker result or local process exit. |
| Session ACL/delivery/message state, artifact bytes, manifests and artifact storage | W5 — Sessions & Artifacts | Consume exact session/artifact references and receipts; never open Execution storage or read artifact bytes from its private filesystem. |
| AGG graph truth, evidence verification, attestations and external checkpoint signatures/custody | W7 — AGG Evidence & Checkpoint Custody | Consume evidence/attestation references and verification outcomes; do not mint or rewrite them. |
| Northbound MCP/UI, gateway routes, wire presentation and protocol adapter composition | W8 — Gateway & Protocol | Expose Control only through its public API and versioned wire contracts; no direct database/module access. |

The quota helper remains host-security infrastructure, not a Control domain or application deployable.

## 3. Control-owned aggregates and invariants

### 3.1 Workflow aggregate

The workflow aggregate binds one workflow ID to its immutable compiled-plan identity/digest, policy snapshot, authorization references, tasks, lifecycle journal and current projection.

- A proposal is not authorization to execute. Creating, reading or compiling a proposal cannot issue claims.
- Approval/admission requires the exact current authorization evidence and the relevant Control policy checks. A valid signature over a different workflow, candidate, plan digest, action, audience or version is not applicable.
- A lifecycle projection must be explainable by its append-only events. Replaying the same event identity and digest returns its original outcome; reusing an identity with changed content is a conflict.
- Workflow completion/success is evaluated from the approved immutable plan and eligible Control-accepted task evidence. A narrative summary, artifact existence or worker assertion alone cannot satisfy a success predicate.
- Synthesis may summarize only facts Control owns or exact external observations/receipts that have passed their declared verification contract. It cannot promote an UNKNOWN observation into a terminal fact.

The complete workflow state/error vocabulary and transition table must stay aligned with the Node compatibility oracle and existing Control API. Do not create new terminal states or transition shortcuts as part of this documentation pass.

### 3.2 Task, attempt, claim and lease aggregate

Control owns task state, dependency readiness, attempt numbering, claim identity and lease ownership. At minimum, an issued claim is bound to:

- workflow ID and task ID;
- immutable plan digest and exact typed command/request digest where applicable;
- attempt number and unique claim/idempotency identity;
- lease ID, owner epoch, worker identity and expiry;
- the authorization/ACL binding required by the accepted claim contract.

The existing local implementation records a task attempt, increments owner epoch, creates the lease and appends the claim event in the same immediate transaction. Direct and coordinator claim events carry the exact lease ID, attempt, owner epoch, worker identity and expiry. This is current combined-Store behavior, not proof of an extracted Control-only database.

Required invariants:

1. Claim issuance serializes against competing claims and relevant task/lease changes; only one current owner wins.
2. Attempt and owner epoch are persisted with the claim event, not reconstructed later from a mutable projection.
3. A stale attempt, lease ID, worker or owner epoch cannot renew, publish an accepted result, deliver a session message or reserve a new side effect.
4. A timestamp/expiry check is necessary but not sufficient to prove process termination or release an uncertain side effect.
5. A renewal retry reuses the same immutable renewal ID and request. An exact replay returns its original receipt/expiry and does not extend the lease again; a new heartbeat uses a new ID.
6. Scheduling and fairness never override dependency readiness, cancellation admission freeze, authorization, active fences or owner-epoch checks.

### 3.3 Result inbox and lifecycle journal

Control accepts task/provider result messages only through authenticated producer contracts and a durable inbox. Acceptance must bind the full relevant subject: workflow, task, plan digest, attempt, lease, owner epoch, worker/producer identity, event ID, canonical payload digest and idempotency identity.

- Persist the inbox identity and lifecycle event/projection result in the same Control-owned transaction before acknowledging acceptance.
- An exact duplicate with the same identity and digest returns the original durable receipt; it must not apply the transition twice.
- Reuse of an event ID or idempotency key with changed content is a conflict, never a successful replay.
- A delayed, duplicated or out-of-order message is not automatically current. Re-evaluate its exact attempt/lease/owner epoch and contract ordering before applying it.
- A stale-owner message may receive a durable rejection receipt; it must not mutate the current task/workflow projection.
- A missing, invalid, unavailable or ambiguous external receipt remains UNKNOWN/UNRESOLVED. Do not acknowledge a message merely because it was received over HTTP.

The current Worker Control API v1 documents `/v1/worker/results` and `/v1/worker/provider-results` request/receipt behavior. It is a transport/API starting point, not evidence that the production authoritative host backend is configured.

### 3.4 Workflow-local policy and success evaluation

Control owns the attachment and enforcement snapshot for a workflow-local policy pack. The snapshot must be immutable for the workflow decision it governs and identified by a version/digest. Changes require an explicit new version/attachment event; they must not silently rewrite a previously approved workflow's semantics.

Control may evaluate dependency, concurrency, execution constraints and success predicates within that local policy snapshot. It may reference a Governance policy version/digest, but it may not redefine trust roots, reviewer quorum, signer identity, approval authority, nonce policy or global security policy. The proposed W1/W2 versus W6 policy split remains subject to architecture/contract-owner ratification; no persistence ownership change follows from this document.

### 3.5 Approval and authorization evidence

Governance (W6) alone owns approval decision truth and signing. Control must validate an authenticated, signed, versioned receipt whose exact subject includes the applicable workflow/candidate/plan digest/action/audience and relevant authority versions. Caller-supplied reviewer names, `approved=true`, local test keys or an unsigned projection are not authorization.

For the selected three-database target, Control retains only the minimum authenticated Governance authorization/high-water projection needed for a coherent local approval transaction. Governance remains canonical authority and publishes signed/versioned updates. The projection contract is **not yet frozen**: source identity, logical DB identity/generation, high-water/version, digest lineage, signer/key rotation, expiry/freshness, revocation races, nonce/replay, delivery/acknowledgement and UNKNOWN reconciliation remain open.

Fetch Governance evidence before entering the Control write transaction; validate and consume the exact signed/versioned evidence inside the Control transaction. Do not insert network calls into the current SQLite approval transaction as a substitute for a cross-part contract.

## 4. Public contract surface and dependencies

The master plan names these W2 outputs. Their names establish the intended boundary; they do **not** mean every schema, signer, version or production implementation has been approved.

| Contract | Direction | Responsibility / minimum subject binding | Status |
|---|---|---|---|
| `WorkflowCommandV1` | Client/Gateway to Control | Authenticated command, workflow subject, idempotency key and exact payload digest. | Draft boundary; wire schema/version not frozen. |
| `WorkflowViewV1` | Control to clients/Gateway | Control projection, current lifecycle facts and relevant unresolved status; no hidden cross-part data. | Draft boundary; read-model schema not frozen. |
| `TaskClaimV1` | Control to W3 | Control-issued claim identity bound to workflow/task/plan/attempt/lease/owner epoch/worker/expiry and exact command scope. | Draft boundary. Existing Worker API claim schema v3 is a related implementation contract; do not assume it is a ratified replacement for this cross-part contract. |
| `LeaseRenewalV1` | W3 to Control; receipt back to W3 | Stable renewal identity and exact claim/lease/worker/attempt/owner-epoch binding. | Draft boundary; production authority absent. |
| `TaskResultEnvelopeV1` | W3/W4 to Control | Immutable event identity/digest, producer identity, exact workflow/task/plan/attempt/lease/owner-epoch subject and evidence references. | Draft boundary; inbox semantics partly documented in Worker API v1. |
| `CancellationRequestV1` | Client/Gateway to Control | Authorized workflow subject, actor principal, reason and idempotency identity. | Request persistence exists in compatibility Store; external settlement contract blocked. |
| `RecoveryQueryV1` | Control to W3/W4/W5/W7 | Exact attempt/lease/epoch subject and required read-only observations. | Draft boundary; query/inventory composition not ratified. |
| `RecoveryDispositionV1` | Verified recovery authority to Control | Exact attempt/lease/epoch and evidence-complete disposition with an independently verifiable receipt. | Blocked; issuer, verifier, evidence composition and settlement CAS not approved. |
| Lifecycle event contracts | Control internal journal and authenticated cross-part inbox/outbox | Immutable event ID/digest, sequence/predecessor where required, producer, correlation and exact subject. | Existing local journal; cross-part versions/semantics not frozen. |

All cross-part envelopes follow the common rules in [`EIGHT_PART_PARALLEL_PLAN.md`](../EIGHT_PART_PARALLEL_PLAN.md#4-shared-contract-envelope): explicit schema version; stable immutable message/event ID; authenticated producer; canonical UTC timestamp (not sole fence); correlation ID; idempotency key; exact subject; payload digest; and sequence/predecessor when source authority defines ordering. Consumers authenticate, validate schema and subject, durably persist inbox identity before acknowledgement, and handle duplicate/delayed/missing/conflicting/out-of-order inputs. No contract claims a distributed transaction across databases.

### 4.1 Contract consumers and producer handshakes

| Upstream/downstream | W2 needs | W2 must provide |
|---|---|---|
| W1 — Catalog & Plan Compiler | Versioned `CompiledPlanV1`, plan digest/canonicalization and typed task/command shape. | Workflow-instance/plan-attachment request and exact plan binding; no compiler-private types. |
| W6 — Governance Authority | Signed approval/authorization receipt and signed projection update, including freshness/revocation/replay semantics. | Exact workflow/candidate/plan/action subject and authenticated Control caller identity. |
| W3 — Worker Runtime & Sandbox | Process observations and signed/verified process-stop evidence; worker identity and claim-bound results. | `TaskClaimV1`, lease renewals, cancellation requests and current owner/fence data via public API. |
| W4 — Provider Effects & Reconciliation | Provider observation and terminal proof bound to exact provider run/dispatch identity. | Control idempotency/fence identity and task/attempt/lease/epoch binding; no Control-state mutation permission. |
| W5 — Sessions & Artifacts | Session/artifact references and delivery/lineage observations required for exact recovery/result evaluation. | Current claim/lease scope and public Control-facing authorization facts; no direct private-store access. |
| W7 — AGG Evidence & Checkpoint Custody | Evidence/attestation references with immutable lineage and verifier outcome. | Exact workflow/task/plan subject and Control lifecycle references; no AGG truth or checkpoint authority. |
| W8 — Gateway & Protocol | No private internals; Gateway calls public service APIs only. | Stable Control API and versioned command/view/error contract. |

Contract negotiation must exchange exact artifact path, version, status, source revision, accountable owner and compatibility fixtures. A chat message or implementation claim is not owner approval.

## 5. Lifecycle rules that must remain fail-closed

### 5.1 Cancellation intent is not cancellation settlement

The current Control compatibility behavior establishes a strict distinction:

| Situation | Control behavior | Prohibited inference |
|---|---|---|
| Workflow has not issued any task attempt; authorized request passes the host verifier | May transition `PROPOSED`/`APPROVED` to terminal `CANCELLED`; settlement is `NOT_REQUIRED`. | Do not bypass the host authorization/verifier. |
| Workflow is `EXECUTING` and has an attempt/lease | Persist immutable cancellation request; retain `EXECUTING`, active lease IDs and owner epochs; block new direct/coordinator claims; report settlement `UNRESOLVED`. | Request/ACK/timeout/worker metadata/local process exit does not stop a process or release a lease. |
| Exact in-flight result arrives under current lease while cancellation is pending | May persist the result against that exact current fence. | That result alone does not terminalize the workflow while cancellation settlement remains pending. |
| Missing, stale or ambiguous process/provider/session evidence | Keep cancellation/recovery unresolved and preserve the fence. | Never infer process death, provider terminality or absence from missing rows or expired lease. |

The Execution contract must distinguish a cancellation-accepted acknowledgement from a signed process-stop/no-more-side-effects receipt. At minimum it must settle exact claim/workflow/task/attempt/lease/owner-epoch/worker/process-or-cgroup/plan identity, signer/key, event/idempotency, replay/order and durable evidence. Provider-side dispatch requires W4's provider terminal proof, not W3's local process receipt. Control must verify the approved receipts and perform the authoritative lease/task/workflow settlement CAS in its own transaction. Late-result and conflicting-terminal behavior must be part of the approved contract.

**Current status:** the standalone `runalith-control` host injects a deny-all cancellation verifier; executing cancellation remains nonterminal/unresolved. No signed process-stop contract or production settlement authority is approved/configured. Do not implement or activate terminal settlement in this work package.

### 5.2 Recovery inspection is not recovery disposition

The current `GET /v1/workflows/{workflow_id}/tasks/{task_id}/recovery` is a read-only inspection route, requires `workflow.recovery.read`, and returns `mutated: false`, disposition `UNRESOLVED` and authority `host_runtime_inventory_required`. Its `TaskAttemptSnapshot` includes current lease/owner epoch/expiry, attempt ledger, provider/session observations, bounded journal, chain head and `history_complete`.

- Incomplete history must be visible; absence of a row/lease/session/provider observation is not proof of absence or worker death.
- Process liveness/stop evidence comes from W3; provider-run truth from W4; session and artifact facts from W5; evidence/attestation references from W7.
- Control may project those facts read-only against the exact attempt/lease/owner epoch. It may not read their private tables, files or databases.
- Final disposition requires an approved issuer/verifier, authoritative evidence inventory, freshness and exact fence, replay/idempotency behavior, and atomic Control settlement. Until then, disposition stays `UNKNOWN`/`UNRESOLVED` and no lease is released.

### 5.3 Retry takeover is a separate blocked protocol

The former Node single-SQLite savepoint combines task/job updates, session takeover, active-lease exclusion, attempt supersession, session-attempt increment and retry-event persistence. That transaction cannot be copied across the three deployables. A cross-part retry needs an owner-approved reserve/settle protocol covering session owner, task/attempt/lease/owner epoch, ordering, durable outbox/inbox, idempotency, partial failure, late messages and UNKNOWN recovery. Until approved, do not add retry takeover or claim cross-store atomicity.

## 6. Persistence and deployable boundary

### 6.1 Current compatibility implementation

`runalith-store` schema v20 is a mixed compatibility aggregate. The Rust Store opens Workflow and Governance connection handles to the **same physical SQLite file** and includes records beyond Control ownership. The current standalone `runalith-control` binary opens that combined Store. Local `control.lock` protects only this Control binary; it is not a global writer barrier.

Current local tests and process behavior are useful evidence for the combined compatibility implementation. They do not prove an extracted Control database, independent deployable, complete data ownership inventory, global writer fence or production migration.

### 6.2 Target under ADR 0003

The accepted architecture has exactly three deployables and separate database ownership:

- **Workflow Control:** workflow/task/attempt/lease/journal plus the minimum authenticated Governance authorization/high-water projection needed for a local Control approval transaction.
- **Execution Workers:** worker/process/provider/session/artifact state and Execution-owned artifact storage.
- **Governance & Interface:** canonical trust/reviewer/policy/approval authority, AGG/evidence/checkpoint custody and Gateway/protocol responsibilities.

No deployable opens another deployable's DB or private filesystem. Public authenticated APIs, immutable versioned contracts and durable outbox/inbox replace shared SQL. No cross-database ACID transaction is implied.

### 6.3 D-01 and extraction gate

Option B is the selected **planning direction**, but the repository still lacks the formal versioned Project Owner decision superseding D-01 decision-register §§11.3–11.4 and the ratified contracts listed in `control-db-ownership-analysis.md`. There is no permission here to create, split, copy, mirror, migrate, restore, repoint or cut over a live database. No schema or ownership changes are part of this workstream pass.

Before extraction, owners must approve exact Control/Governance projection schemas, DB logical identity/generation/restore epoch, high-water/digest/signature lineage, signer/key rotation, freshness/expiry/revocation races, nonce/replay/idempotency/UNKNOWN behavior, outbox/inbox/acknowledgement, writer inventory/barrier, additive import, cutover and rollback. Keep the current mixed Store explicitly labelled compatibility mode until then.

## 7. Parallel work allowed now

The following can be developed independently against disposable fixtures and fake ports without changing another workstream's authority:

1. Transaction/CAS tests for Control-owned task/lease/journal behavior on a disposable test Store, including independent-connection races and single-winner assertions.
2. Lifecycle/error differential fixtures against the read-only Node oracle; preserve the exact declared scope and record known mismatches.
3. Scheduler fairness/concurrency policy tests with fake clock, deterministic ordering and no live dispatcher.
4. Result-inbox replay tests for exact duplicates, changed-digest conflicts, stale owners, delayed/out-of-order delivery, crash/reopen and durable receipt replay.
5. Read-only recovery projection tests for complete/incomplete histories, absent observations and UNKNOWN/UNRESOLVED outcomes using fake evidence providers.
6. Fake-verifier tests for receipt subject binding, audience/version/expiry failures and exact replay; test keys only, not production roots or signers.
7. Contract/schema drafts, golden fixtures, error vocabulary and producer/consumer compatibility tests after upstream owners supply concrete candidate shapes.

Use disjoint W2-owned documentation/fixture/test files. Do not concurrently edit shared `runalith-store`, `runalith-runtime`, root manifests, Cargo manifests/lockfiles or schemas. In the shared dirty worktree, default to one writer at a time; parallel code work requires isolated worktrees, a common base and reviewed integration.

## 8. Explicitly blocked work

| Work | Why blocked | Required release evidence |
|---|---|---|
| Production claim signing/verification or `WorkerControlAuthority` injection | Issuer, signer/key lifecycle, principal-to-worker binding, audience, claim scope, expiry and owner-epoch authority are not ratified/provisioned. | Versioned owner-approved claim/authority contract; signer/verifier ownership and rotation; transaction-time ACL/fence semantics; race/restart/HTTP integration evidence. |
| Cross-part cancellation settlement | ACK is not process-stop proof; provider terminality and settlement CAS contracts are missing. | Approved signed process-stop/no-more-side-effects receipt, W4 terminal proof, verifier, exact subject and atomic Control settlement/replay/late-result tests. |
| Terminal recovery disposition | Complete authoritative source inventory, evidence composition, issuer/verifier and settlement fence are missing. | Ratified `RecoveryDispositionV1` contract and independently verifiable end-to-end evidence/settlement tests. |
| Same-task retry / takeover | One Node SQLite savepoint cannot span Control and Execution DBs. | Approved reserve/settle state machine, session-owner transfer, exact fencing, durable outbox/inbox, idempotency and UNKNOWN/restart recovery tests. |
| D-01 database split/projection/cutover | Formal D-01 supersession and signed Control/Governance consistency/freshness contract remain absent. | Versioned Project Owner decision, complete writer inventory and global barrier, projection contract, export/import lineage, independent DB/process and rollback proof. |
| Deterministic local-step / timeout mapping | `TaskSpec` to `CommandRequest`, `timeout_ms` precedence, effective deadline/error semantics and digest binding are not approved. | Versioned typed mapping, explicit override/rounding/capping rules and Node differential fixtures. No command from free-form metadata. |
| Production Governance or AGG authority | Owner-controlled trust roots, reviewer identities, signer, nonce authority and external checkpoint custody are not provisioned. | Separate W6/W7 owner approvals, provisioning ceremony and independent custody/verification evidence. |

Fail-closed `503`/denial behavior is not a defect to bypass while these gates remain open.

## 9. Acceptance and verification matrix

Acceptance must be demonstrated with exact commands, exit codes, fixture identity and relevant assertions. A green unit suite or this documentation file alone does not establish deployable readiness.

| Acceptance area | Required proof | Current evidence / status |
|---|---|---|
| Lifecycle compatibility | Node oracle differential for workflow/task state transitions and error vocabulary within declared W2 scope. | Existing compatibility material exists; full W2 differential acceptance not established by this work package. |
| Claim/lease serialization | Independent-connection races; exactly one claim winner; durable attempt/lease/owner-epoch/event binding. | Local Store behavior/tests documented; extracted Control DB and production authority not established. |
| Stale-owner fencing | Old attempt, lease, worker and owner epoch rejected for renewal, result and relevant mutations. | Local API/Store test surfaces exist; production `WorkerControlAuthority` absent. |
| Inbox idempotency/replay | Exact duplicate returns original receipt; changed digest conflicts; delayed/out-of-order events do not double-apply; crash/reopen remains deterministic. | Contract/API behavior partly documented; complete cross-part acceptance not established. |
| Cancellation | Pre-execution path, executing request freeze, late exact result, retained leases, no release on ACK/timeout/local exit; settlement tests only after approved contract. | Request projection exists in schema-v20 compatibility Store; production cancellation verifier/receipt/settlement remain blocked. |
| Recovery | Complete/incomplete snapshot, `mutated:false`, UNKNOWN/UNRESOLVED, no inferred absence/death, no lease release. | Read-only API path documented; authoritative terminal disposition blocked. |
| Policy/approval | Immutable local policy binding; exact signed Governance subject; missing/stale/revoked authority fails closed. | Contract boundary identified; signed projection/freshness contract remains blocked. |
| Persistence isolation | After extraction, no Control reads/writes of Execution or canonical Governance tables; clean per-deployable DB identity and restore/rollback proof. | Current schema-v20 Store is mixed compatibility state; extraction/migration not authorized. |
| Deployable operations | Clean-checkout build/test, real separate processes/stores, auth, health, observability, partition/restart/duplicate tests and rollback rehearsal. | Three-deployable independent deployment/rollback is not proven. |

### 9.1 Local validation snapshot — 2026-11-03

The following commands were run against the current shared checkout. They establish local compatibility/test evidence only; they do not ratify cross-workstream contracts, prove the extracted Control database, or establish production authority.

| Command | Result | Scope and limit |
|---|---|---|
| `cargo test -p runalith-control-api --locked --offline` (from `rust/`) | PASS — 26 library tests, 8 binary tests, 11 standalone-process integration tests; 45 total. | Includes authenticated route/capability checks, claim subject binding, fail-closed missing authority, unresolved read-only recovery, cancellation request projection and standalone host lifecycle. |
| `cargo test -p runalith-recovery --locked --offline` (from `rust/`) | PASS — 15 tests. | Includes incomplete inventory, active lease/session, ambiguous provider outcome and missing-authority fail-closed cases. |
| `cargo test -p runalith-domain --locked --offline` (from `rust/`) | PASS — 56 tests. | Includes Node-generated job-transition and workflow-phase differential fixtures. `runalith-domain` is shared by W1/W2; this is not exclusively W2-owned code. |
| `cargo test -p runalith-store --locked --offline -- --test-threads=1` (from `rust/`) | PASS — 99 tests. | Includes independent-connection claim/renewal/cancellation races, owner-epoch fencing, result-inbox idempotency/conflict, restart/replay, recovery snapshot and unresolved cancellation. This remains the mixed schema-v20 compatibility Store, not an extracted Control DB. |
| `cargo fmt --all -- --check` (from `rust/`) | PASS. | Formatting check only. |
| `cargo clippy -p runalith-control-api -p runalith-recovery -p runalith-domain -p runalith-store --all-targets --locked --offline -- -D warnings` (from `rust/`) | PASS. | Static lint for the listed packages; not behavioral acceptance. |
| `cargo check --workspace --locked --offline` (from `rust/`) | PASS. | Workspace type/build check; not deployable integration proof. |
| `node --test tests/test-workflow-m4.js tests/test-task-lease-manager.js tests/test-task-lease-expiry-race.js tests/test-workflow-terminal-failure-atomicity.js tests/test-distributed-scheduler.js tests/test-phase5-recovery.js tests/test-phase5e-recovery.js tests/test-execution-lease-fencing.js` (repository root) | PASS — 8 files, 8 passed, 0 failed. | Read-only Node compatibility/runtime oracle tests; no Rust/Node runtime parity claim beyond covered assertions. |

No source, schema, manifest, database or deployment file was changed during this validation pass. Production claim authority, terminal cancellation settlement, authoritative recovery disposition, cross-store retry/takeover, D-01 extraction and three-deployable rollout remain blocked as described above.

Suggested focused validation order once a named owner and source/test ownership are assigned:

1. Establish Node lifecycle oracle baseline and versioned contract fixtures.
2. Run focused Rust W2 unit/integration tests with independent SQLite connections and disposable databases.
3. Run crash/reopen, duplicate/conflict, stale-owner and fault-injection tests.
4. Run cross-part contract tests using fake W1/W3/W4/W5/W6/W7 ports; only then use real public APIs after their owners approve versions.
5. Independently review final diff and evidence against the acceptance matrix. Keep production authority, migration and rollout gates open until external owner evidence is present.

## 10. Ownership and coordination record

| Field | Value |
|---|---|
| Accountable W2 owner | **UNASSIGNED** — do not infer an owner from a Chat-space post or implementation activity. |
| Lead/integrator | TBD by Project Owner. |
| Branch/worktree | TBD; must be isolated or have explicit disjoint file ownership. |
| Current write scope | This W2 workstream contract document and later explicitly assigned W2-only fixtures/tests. |
| Shared files requiring a single coordinating owner | `runalith-store`, `runalith-runtime`, Cargo manifests/lockfiles, shared schemas and deployment manifests. |
| Contract status | Master-plan outputs are named; schemas/versions/authority contracts remain draft/not frozen unless an owner supplies an approved artifact. |
| Consumer reviewers | W1, W3, W4, W5, W6, W7 and W8 accountable owners; names/ACKs pending. |
| Validation owner | TBD; independent verifier must not be the sole implementer. |
| Production/DB authority | Not granted by this document. |

Coordination requests and contract handshakes use COS Multi-Account MCP A2A endpoints under `rust/A2A_COORDINATION_PROTOCOL.md`; Google Chat is not a coordination transport or middleware. A reply must identify the accountable owner, exact contract/decision path and version, source revision, approval status, unresolved fields and acceptance evidence. A durable queue result, inbox receipt or transport ACK is not a review decision or approval. Messages authored by the coordinating account, invitations, silence or local test results are not Project Owner/authority-owner approval.

## 11. Source-of-truth references

- [`EIGHT_PART_PARALLEL_PLAN.md`](../EIGHT_PART_PARALLEL_PLAN.md) — workstream scope, contracts, ownership protocol and external blockers.
- [ADR 0003 — three-part Rust deployment](../../docs/adr/0003-three-part-rust-deployment.md) — accepted three-deployable architecture and database ownership boundary.
- [`docs/control-db-ownership-analysis.md`](../docs/control-db-ownership-analysis.md) — current mixed Store, selected Option B direction, D-01 and extraction gates.
- [`docs/worker-control-api-v1.md`](../docs/worker-control-api-v1.md) — current worker-facing claim, renewal, result, session and execution-fence API behavior.
- [`docs/control-operations.md`](../docs/control-operations.md) — current standalone Control host, cancellation request semantics, read-only recovery and operational limitations.
- [`02-control-contract-candidate-v1.md`](02-control-contract-candidate-v1.md) — WS2 producer contract candidate; DRAFT and not ratified.
- [`02-compiled-plan-adapter-v1.fixtures.json`](02-compiled-plan-adapter-v1.fixtures.json) and [`02-compiled-plan-adapter-v1-test.py`](02-compiled-plan-adapter-v1-test.py) — W1 canonical plan vectors, W2 task-binding candidate and executable fixture-level negative checks.
- [`02-control-boundary-v1.fixtures.json`](02-control-boundary-v1.fixtures.json) — claim, renewal, result and cancellation boundary examples/negative-case inventory; intentionally non-golden.
- [`02-control-journal-v1.fixtures.json`](02-control-journal-v1.fixtures.json) and [`02-control-journal-v1-test.py`](02-control-journal-v1-test.py) — observed local event hash serialization vectors; DRAFT compatibility evidence, not public ratification.
- [`PART1_ACCEPTANCE_STATUS.md`](../PART1_ACCEPTANCE_STATUS.md) — historical Part 1 acceptance record; historical Part 1 naming does not override the new W1/W2 ownership split.

This workstream document defines a bounded development contract. It does not supersede ADR 0003, amend D-01, approve the W1/W2/W6 policy boundary, assign an accountable owner, ratify a cross-part schema, authorize production credentials, or authorize database/deployment changes.
