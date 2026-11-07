# ADR 0002: Rewrite the Runalith runtime in Rust

- **Status:** Accepted as the implementation direction; production cutover remains unapproved.
- **Date:** 2026-11-01
- **Decision owner:** Project owner / maintainers
- **Supersedes:** ADR 0001 on implementation language. Its initial modular-monolith deployment topology is superseded by ADR 0003; Rust language choice, data-ownership, compatibility, authority and migration principles remain in force.

## Context

The current Node.js runtime has accumulated workflow lifecycle, plan compilation, task and execution persistence, local process execution, provider adapters, session delivery, Adaptive Goal Graph (AGG), trust verification, recovery, and MCP transport in one large versioned entrypoint plus runtime modules. The current architecture contains important fail-closed, transaction, fencing, evidence-lineage, and compatibility behavior. Rewriting syntax without preserving those contracts would be a security and data-integrity regression.

The project owner has explicitly selected a from-scratch Rust rewrite. This is not a request for a Rust facade over the Node runtime, nor a request to split the product into microservices.

## Decision

1. **Rust is the implementation language for the new runtime**, including domain logic, protocol validation, persistence, workflow orchestration, recovery, execution supervision, provider coordination, trust/evidence verification, and MCP server.
2. The initial implementation may use an in-process modular composition root. The target is now three independently deployable parts under ADR 0003; crate boundaries alone do not prove process or data independence.
3. The old Node.js implementation remains a read-only behavioral oracle and compatibility target during migration. It is not a runtime dependency of the new Rust core. Retain JavaScript only temporarily where a specific existing host/package interface or the dashboard requires it; do not reimplement business logic in JavaScript.
4. Define public Rust APIs and contract fixtures before porting consumers. The new runtime owns its schema and migrations. Never open the existing production database with the new schema or perform an in-place rewrite.
5. Preserve COS-AP v1 wire semantics. New fields, message types, status changes, and relaxed validation require explicit protocol-version decisions and compatibility tests.
6. Every approval and dispatch operation must use a configured authority verifier bound to exact proposal, immutable plan, source snapshot, action scope, reviewer identity, and approval evidence. An absent verifier fails closed. Local tests may use test-only verifiers but cannot be packaged as production authority.
7. Preserve durable event ordering, idempotency, transaction atomicity, immutable plan hashes, lease fencing, provider-run identity, unknown-outcome quarantine, evidence lineage, and safe recovery. A missing lease is not proof that a worker or remote operation stopped.
8. Existing data is imported only into a fresh Rust database through a versioned, read-only source snapshot and verified mapping. Keep original bytes and rollback artifacts unchanged until an owner-authorized cutover.
9. No production dispatch, trust mutation, checkpoint advance, DB migration, process restart, or release activation is part of implementation without separate explicit authority.

## Target workspace

| Crate | Ownership |
|---|---|
| `runalith-domain` | Workflow/task state machines, immutable plan, typed evidence lineage, policy vocabulary, domain invariants |
| `runalith-protocol` | Strict COS-AP and durable execution wire contracts, schemas, compatibility fixtures |
| `runalith-store` | SQLite schema/migrations, event journal, transaction boundaries, workflow/task/lease/approval/evidence persistence |
| `runalith-execution-persistence` | Provider intent/reconciliation schema and SQL participant; borrows caller transaction/connection without opening a second connection |
| `runalith-workflow` | Catalog, proposal, compiler, immutable plan, policy packs, success contracts, human approval orchestration |
| `runalith-execution` | Structured local process execution, sandbox, authorization boundary, artifact capture, lease/result fencing |
| `runalith-providers` | Provider traits and adapters (OpenClaw, GitHub Actions, and other explicitly supported transports) |
| `runalith-agg` | Goal/Idea Graph, source evidence, verification, Plan Graph, Execution Graph, reviewer and policy binding |
| `runalith-trust` | Trust configuration, signature validation, reviewer identity, approval quorum, append-only ledger and external checkpoint contracts |
| `runalith-recovery` | Liveness, unknown outcome reconciliation, lease expiry, terminalization, resumability and operator intervention |
| `runalith-mcp` | MCP stdio transport, tool schemas, capability filtering, resource/prompt surface and JSON-RPC errors |
| `runalith-cli` | Local administration, diagnostics, import/export and offline verification; no implicit authority escalation |

All crates remain in the Rust workspace and one application composition root until their contracts and failure semantics are stable.

### Implemented foundation crates

At the original 2026-11-01 baseline, the workspace contained thirteen crates: `runalith-domain`, `runalith-artifacts`, `runalith-agg`, `runalith-execution`, `runalith-execution-persistence`, `runalith-providers`, `runalith-sandbox`, `runalith-protocol`, `runalith-store`, `runalith-runtime`, `runalith-recovery`, `runalith-trust`, and `runalith-mcp`. The current workspace has fourteen crates after adding `runalith-worker`. The original schema-v9 snapshot stored immutable Goal/Idea/Plan/Execution graph revisions, digest-chained snapshots, provider dispatch intents/observations, lease epochs, attempt/result history, agent sessions/ACL/messages, custom catalog versions and compiled plans. Later schema and workflow-control additions are documented in the 2026-11-02 follow-up below. The initial Rust slices were bounded in-process operations, not continuous coordinator or Node lifecycle parity; the default host did not register provider adapters, enable sandbox execution or accept approvals. They did not establish production trust roots or live-state integration.

#### Current implementation evidence (2026-11-01)

- `runalith-agg` performs deterministic bounded nominal-success path search, prerequisite/conflict pruning, unknown-aware metric aggregation, candidate digesting, and exact-search reproduction before Plan Graph projection.
- `runalith-agg::graph_contract_v1` validates the complete schema-v1 node/edge shape, Hypothesis nodes, all five metric-provenance records, typed recovery conditions and reference resolution. It sorts canonical arrays with UTF-16 ordering and computes the exact Node ordered-JSON graph hash. A Node-generated shared fixture covers fractional numbers, negative-zero normalization, Unicode ordering, metric provenance and conditional recovery. Its search projection still does not port Node candidate IDs or path-level provenance.
- Recovery edges are excluded from nominal search. Beam/depth/expansion pruning is reported as non-exhaustive. Every candidate and Plan Graph draft remains unverified, review-required, non-executable, and non-dispatchable.
- `runalith-store` schema v9 appends immutable graph node revisions, typed edges, unverified evidence, snapshots linked to predecessor snapshot digests, provider dispatch intents with exact payload, provider reconciliation observations, historical task attempt/lease/result-digest ledgers, agent sessions, session ACL, COS-AP message lifecycle, atomic recovery decision observations, immutable custom role/workflow versions, immutable compiled-plan snapshots and append-only catalog audit events. Owner epochs are independently persisted and advanced with the lease claim CAS. Session create/update, ACL grant/revoke, enqueue, claim, transport-start, receipt, ACK and uncertain transitions share workflow event transactions. An expired claim before transport-start may be reclaimed; after transport-start it becomes UNCERTAIN and is never replayed. ACK requires an exact session-bound successful receipt. Recovery decision recording rechecks exact durable lineage and the full event hash chain under `BEGIN IMMEDIATE`, invokes mandatory host verification, and appends an immutable audit event without changing lifecycle state. Schema-v5 intents migrate with no payload and cannot be dispatch-validated. Provider `UNKNOWN` outcome is terminal for automatic dispatch; lookup observations are evidence, not permission to retry. v7→v8 session state and v8→v9 custom catalogs are additive and explicit; host startup does not migrate.
- MCP exercises the complete persisted graph → snapshot → AGG candidate → Plan Graph draft path in an integration test. This does not yet compile a draft into an approved workflow or Execution Graph.
- `runalith-execution` projects durable task state, latest lease/attempt/result, all persisted provider dispatch intents, accepted provider-run IDs, and event-chain status into a content-addressed Execution Graph view. Ambiguous `UNKNOWN` outcomes remain explicit; prior non-provider attempt history and provider-run terminal status remain unavailable. Projection cannot dispatch.
- `runalith-providers` defines the adapter and lookup contracts plus exact request-to-intent and bounded payload-digest validation. Runtime revalidates approval, reserves an exact lease/plan/request-bound intent, invokes adapter once, persists accepted/rejected/unknown, and quarantines task on ambiguous response. No concrete adapter is registered or exposed through MCP.
- `runalith-protocol::agg_checkpoint_v2` implements original-byte strict JSON parsing, duplicate decoded-key rejection, numeric-token exactness, bounded materialization, UTF-16 property ordering, ECMAScript number serialization, canonical JSON and domain-separated SHA-256 digests. It passes the shared checked-in Node/Python canonicalization, strict-parse and digest vectors. It is not a trust verifier or external checkpoint custodian.
- AGG graph schema v1 uses a separate parser mode that normalizes negative zero to positive zero, matching the Node graph validator's JSON.stringify identity. The checkpoint-v2 strict JCS profile continues to reject negative zero.
- `runalith-recovery` evaluates stale-workflow terminalization preconditions without I/O or side effects and classifies one exact task attempt from authoritative lease/session/provider observations. Runtime snapshot identity, completeness and freshness are checked; missing observations remain unknown and ambiguous provider outcomes remain unresolved. Store/MCP expose a read-only current-attempt projection. There is no host runtime inventory adapter or atomic recovery manager yet; no lifecycle mutation is performed.
- `runalith-trust` parses all five administrator trust domains, validates exact scopes, Ed25519 SPKI fingerprints, key windows/revocation and cross-domain provider/root disjointness. Its separate append-only SQLite ledger enforces explicit observation, contiguous config versions, fingerprint/provider reuse and timestamp high-water; startup rejects unknown existing schemas and performs no migration. Common signed-envelope verification checks provider, scope, kind, nonce, time bounds, trusted root, canonical payload and Ed25519 signature against a Node-generated fixture. The approval decision verifier checks maker attestation and individual checker vote signatures, reviewer registry identity, maker/checker separation, distinct-domain/role quorum, veto, candidate binding, one-use nonces and contiguous append-only policy high-water inside the caller's SQLite transaction. `runalith-runtime::TrustApprovalVerifier` adapts exact Node schema-v1 evidence to Store's Initial/Revalidate modes, preserves original signed evidence and requires an injected current-snapshot candidate-binding resolver. The default host remains DenyAll; production trust configuration, MCP trust administration and external checkpoint continuity remain outstanding. No production trust config/ledger is loaded.
- Approval verification is a store-level injected capability. Store::approve accepts an untrusted ApprovalRequest rather than a preconstructed Approval and invokes the verifier inside the same SQLite IMMEDIATE transaction that persists approval. Task claim and provider-intent reservation revalidate persisted approval inside their own writer transactions. The verifier receives the active transaction so nonce/high-water writes can commit or roll back atomically with the protected operation. The default verifier rejects all approvals.
- `runalith-sandbox` provides a Bubblewrap-only backend with network namespace isolation, read-only executable roots, bounded workspace/scratch mounts, environment allowlists, timeout and output caps. It also has a one-use workspace write capability and immutable artifact receipt primitive. Path-based checks remain TOCTOU-vulnerable to hostile concurrent parent replacement; mutation and receipt persistence are not atomic; capability issuance is not yet wired to the approval/plan boundary. No unsandboxed fallback.
- `runalith-artifacts` stores immutable SHA-256-addressed output bytes with private permissions, create-only writes and verified reads. Runtime requires exact `sandbox_command` equality with immutable task inputs and `sandbox_execution` evidence before success; ambiguous process results quarantine the task.
- MCP exposes 46 tools, including read-only `workflow_compile`, `workflow_ready_tasks`, workflow inspection, ten agent-session lifecycle/ACL/message operations, `workflow_execution_graph_get`, custom role/workflow create/update/get/list and persisted preview, opt-in `workflow_sandbox_execute`, and adapter-injected `workflow_provider_reconcile`; event payloads are redacted and bounded. Custom catalog versions and compiled plan snapshots are immutable and durable, exact role-version pins are validated, unresolved skills fail closed, and preview does not authorize execution. Attempt inspection reads durable Rust task/lease/provider/session/message lineage and never treats missing lease/session metadata as worker-death proof. The default host registers no provider adapter, leaves sandbox execution disabled, and its approval verifier rejects all approvals. Full Node handler parity and coordinator semantics remain incomplete.
- Task result persistence now exposes an explicit `TaskResultProducerVerifier` capability. The MCP `workflow_record_task_result` operation is fail-closed unless the host injects this verifier; verifier execution and lease/attempt validation occur within the same Store writer transaction. An exact semantic replay for the same attempt/lease owner is acknowledged idempotently, while a conflicting replay is fenced. This is not a complete result inbox: external immutable event IDs, signed provenance envelopes, ordering/replay ledgers, production producer identity provisioning and reconciliation of out-of-order/ambiguous provider results remain outstanding.
- MCP custom role/workflow create/update/preview now require an injected `CatalogAuthorVerifier` that derives a canonical principal from host-authenticated request context. Missing verifier, malformed principal and `mcp:unattributed` fail closed before catalog mutation; Store also rejects the unattributed sentinel. This interface does not create identity authority: production host authentication and verifier wiring remain external and unconfigured.
- Full-workspace Rust test counts and warning-free Clippy evidence are recorded after the current provider-persistence extraction. Targeted tests include Node-generated custom-workflow and discriminator fixtures, maker/checker signature/quorum/replay/rollback, recovery evidence classification, scoped sandbox capability, provider lookup-only, and MCP integration. These local tests are not production parity, authority, release, or cutover evidence.

## Implementation sequence

### Recovery gate slice (2026-11-01)

The workspace includes a side-effect-free stale-workflow eligibility gate and per-attempt ownership classifier. The current task attempt can be inspected through Store/MCP without exposing provider payload or inferring worker death from missing lease/session metadata. Host runtime inventory, authoritative provider lookup, historical attempt/result lineage, atomic recovery transaction and lifecycle orchestration remain outstanding.

### R0 — Rust foundation

- Domain types and state-machine invariants.
- COS-AP v1 strict envelope validation.
- New Rust-owned SQLite store with explicit schema version.
- Proposal, exact approval binding, task dependency gating, fenced lease claim, evidence-bearing result and unknown-outcome quarantine.
- Disposable tests only; no connection to legacy data or providers.

### R1 — Full local workflow lifecycle

- Catalog and workflow definitions.
- Agent role/input/output contracts, plan compiler and immutable plan snapshots.
- Proposal, preflight, approval, dispatch authorization, task graph execution, synthesis, completion and reporting.
- SQLite transaction parity and event-level golden fixtures against legacy behavior.

### R2 — Execution and recovery

- Structured argument execution, sandbox boundaries, filesystem capabilities, artifact receipts, batch execution and result verifier.
- Worker/session identity, process boundary capture, timeout/termination and ambiguous spawn reconciliation.
- Provider-run ledger, idempotency, unknown outcome quarantine, explicit reconciliation and owner intervention.

### R3 — Providers and durable sessions

- Provider admission and rate-limit leases.
- OpenClaw session start/send/receipt lifecycle.
- GitHub Actions dispatch intent, run identity, polling and reconciliation.
- Slack projection, delivery claims and uncertain-send recovery.
- No transport retry when external side effects may already have occurred.

### R4 — AGG and authority plane

- Goal/Idea graph storage, revisioning, typed edges and source artifact lineage.
- Knowledge verification and signed snapshot attestations.
- Search/planning candidates, Plan Graph drafts and review-only Execution Graph proposals.
- Authenticated reviewer identity, signed policy packs, maker/checker quorum and exact action-intent binding.
- Trust root configuration, append-only observations, anti-rollback and external checkpoint custody.
- No local key generation or test trust promoted to production trust.

### R5 — MCP, operator tools and package integration

- Complete Rust MCP server and tool parity.
- Resource/prompt schemas, diagnostics and operator intervention tools.
- Native packaging and host compatibility. Keep only the smallest required JS/OS adapter if the host cannot launch the Rust executable directly.

### R6 — Data compatibility and cutover proof

- Snapshot the legacy database without modifying it.
- Import into a separate Rust database with explicit schema mapping and preserved IDs, event order, hashes and lineage.
- Compare workflow/task/event projections and security-critical state.
- Exercise backup, restore, rollback, crash recovery, concurrency, failover and provider-unknown scenarios.
- Shadow/read-only parity first. Cutover only after owner approval and external trust/release gates pass.

## Acceptance gates

- Every existing user-visible MCP tool is mapped to a Rust implementation or explicitly retired by product-owner decision.
- Existing protocol and behavioral fixtures pass against the Rust implementation.
- Transaction and crash-injection tests prove the required atomicity and recovery boundaries.
- Approval and dispatch negative tests prove fail-closed behavior for missing, stale, mismatched, replayed, or untrusted evidence.
- Concurrency tests prove lease fencing and idempotency under racing workers.
- Unknown provider outcomes remain quarantined until authoritative evidence resolves them.
- Import tests prove exact provenance, referential integrity, event ordering, and rollback without mutating the source database.
- Independent build, reproducibility, SBOM, signing, package, and host compatibility evidence exists before release.
- Production cutover is a separate, explicitly authorized operation.

## Consequences

### Positive

- Runtime invariants become explicit typed contracts.
- Ownership boundaries become compile-time dependencies instead of naming conventions alone.
- Memory-safe implementation is the default for the new core.
- Database, process, filesystem, provider and trust boundaries can be reviewed as focused crates.

### Costs and constraints

- The rewrite is a multi-stage replacement, not a one-shot translation. The feature surface is materially larger than the first Rust foundation slice.
- Rust does not remove domain complexity, authority dependencies, external provider ambiguity, or the need for production evidence.
- The old and new schemas coexist during migration; data import and cutover need their own gates.
- The existing dirty worktree is shared state. Preserve every pre-existing tracked and untracked change; do not stage, commit, push, rebase, reset, clean, stash, revert, or overwrite existing files.

## 2026-11-02 Part 1 implementation follow-up

The current shared Rust Store schema is v18. Additive migrations v13→v14 add immutable trusted-skill identity/version/content pins per custom-role version; v14→v15 adds local AGG checkpoint operation, event, fencing-gate and quarantine ledgers; v15→v16 adds a temporary same-file dual-connection probe used to verify workflow/Governance connection identity; v16→v17 adds Governance decision/event tables; v17→v18 adds signed Governance receipt JSON to decision rows. `StoreGovernanceDecisionBackend` persists decision, signed receipt and committed event atomically and validates exact idempotent replay. Verifier and signer remain injected; no production authentication, signing key, trust-root provisioning or external checkpoint authority is wired. These local schema additions do not provision external trust roots or checkpoint authority.

Workflow Control now persists immutable versioned policy packs with content digests, exact workflow attachments, append-only policy audit events and composed success-contract snapshots pinned to immutable plan digests. Approval, claim and completion revalidate exact policy/contract references inside writer transactions. Deterministic evaluation reports PASS/FAIL/UNRESOLVED; execution and artifact predicates without authoritative evidence remain UNRESOLVED.

Trusted skills are resolved only through injected host-owned `TrustedSkillResolver`. Exact canonical skill identity, version and content digest are persisted for each immutable role version. Role/workflow create/update and plan compilation revalidate pins and fail closed on missing, revoked, stale or substituted references. No production resolver or trust authority is configured.

Authenticated result ingestion persists immutable event ID, producer identity/provenance digest, payload digest and exact workflow/plan/task/attempt binding in the same transaction as fenced result/lifecycle/event persistence. Duplicate replay is idempotent; conflicting or stale replay is rejected. Deterministic synthesis reconstructs task, attempt, inbox, approval, policy/contract and event-chain evidence and persists the report in the append-only workflow event journal. A report is PASSED only when workflow state is COMPLETED and all persisted success predicates pass; missing/unsupported authority remains UNRESOLVED.

MCP currently registers 61 Rust tools against the pinned Node reference's 75 (`runalith-mcp --version`): 28 exact-name overlaps, 47 Node-only names (44 default-visible) and 33 Rust-only names. Counts are not semantic parity. The CLI health integration test now asserts 61 and passes. `workflow_synthesize`, read-only `workflow_validate_artifact` and partial read-only `workflow_recommend_resources` are exposed. Artifact validation covers ten Node content families but does not establish durable artifact lineage. Resource recommendations read actual custom workflow/role/policy catalog records and built-in role contracts; they calculate contract-compatible profile overlay candidates but explicitly report that Rust cannot apply Node role-profile bindings or resolve Node skill metadata. `Store::admit_workflow` persists an idempotent admission checkpoint after transactional approval/policy/contract revalidation; claim repeats verification and no worker dispatch is authorized. Duplicate result-envelope replay reauthenticates producer provenance and rechecks the immutable plan plus historical lease/worker binding before acknowledgement. Recovery inspection binds lease observations to exact immutable attempt-ledger identity; missing historical lease identity remains UNKNOWN. The coordinator remains a single atomic claim tick per invocation and does not dispatch workers. Recovery inspection is evidence-rich and read-only but does not persist an authoritative cross-part lifecycle disposition. Production host wiring for catalog identity, trusted skills, result producers, approvals and worker identity; full Node predicate semantics; continuous scheduling; Node differential lifecycle tests; independent Control API/process/database; independent CI, host startup and rollback proof remain outstanding. Part 1 remains PARTIAL; rollout remains BLOCKED.

### Part 1 follow-up — HTTP Control API and coordinator loop (2026-11-02)

`runalith-control-api` now provides a Part 1-owned HTTP/JSON boundary without importing MCP, worker or provider crates. It composes `WorkflowService` over either an explicit Store or `Store::open_existing`; opening requires an existing exact-schema Rust DB and never runs migrations. Every request is authenticated by a host-injected principal verifier and checked against host-issued capabilities. Routes cover custom role/workflow catalog mutation and reads, exact-version compile/plan reads, immutable policy CRUD/attachment, workflow proposal/read/events, approval/admission/cancellation, success-contract read, coordinator claim, authenticated result-envelope ingestion, synthesis and read-only recovery evidence. Trusted-skill resolution, approval, worker identity, result producer and cancellation remain separate host-injected verifiers. HTTP framing and payloads are bounded; the server uses a bounded connection queue/worker pool, plain HTTP loopback-only binding and cooperative shutdown. Store-native idempotency/conflict semantics remain operation-specific; a global persisted HTTP idempotency-key ledger is not implemented.

`CoordinatorLoop` repeatedly invokes the atomic Store-backed claim path with bounded claims per tick and a bounded interval. It relies on Store's approval/policy/plan revalidation, dependency readiness, concurrency ceilings, fairness and owner-epoch/attempt fencing. Each durable claim is passed to the explicit `ExecutionWorker` port; no Part 2 worker or provider dispatch is implemented. Shutdown is checked between claims. Failed/ambiguous handoff stops the loop and does not retry, replay, revoke or terminalize the lease.

This does not yet satisfy independent deployment: there is no standalone Control host binary/process, physical Control-owned schema/database extraction, production verifier composition, or cross-process crash/restart acceptance. Recovery endpoint returns read-only observations and explicit UNRESOLVED disposition; authoritative cross-part settlement remains absent. Full Node predicate/lifecycle differential, deterministic local-step orchestration, historical migration proof and production authority remain open. Part 1 remains PARTIAL; rollout remains BLOCKED.

### Part 1 follow-up — persisted predicate differential slice and HTTP validation (2026-11-02)

The persisted Store evaluator is now exercised against the checked-in Node predicate oracle for 12 cases after policy attachment, approval, admission, task claims and result persistence. Rust compares supported task/role predicate values and dispositions; seven execution/catalog/artifact cases remain UNRESOLVED because Part 1 has no authoritative typed evidence for them. Three Node-negative references (unknown task, incompatible forbidden role, unknown artifact producer role) are rejected at policy attachment instead of being deferred to evaluation; this remains an explicit compatibility difference. The fixture test is partial differential coverage, not full Node parity. Control API Bearer scheme parsing now follows HTTP case-insensitivity and rejects whitespace/control-containing credentials; malformed, duplicate and out-of-range `limit` query parameters fail with HTTP 400. Store tests pass 71/71, Control API tests 13/13, scoped Clippy and rustfmt pass. Independent process/database ownership, production host authority, full differential lifecycle and authoritative recovery disposition remain open; Part 1 remains PARTIAL and rollout BLOCKED.
