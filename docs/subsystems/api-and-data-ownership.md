# Public API and data ownership rules

These rules govern subsystem APIs and future repository boundaries. They are normative for new extraction work; they do not silently rewrite existing runtime behavior.

## Public API shape

- Expose business capabilities/use cases, not internal CRUD tables or implementation objects.
- Use explicit versioned JSON-compatible request/response DTOs. Keep domain objects, SQLite rows, provider SDK objects, class instances and process handles private.
- Keep API functions cohesive and coarse enough to avoid chatty cross-package calls.
- Return stable machine-readable error codes and structured details. Human-readable messages are diagnostic and must not become compatibility contracts.
- Define idempotency keys, operation identity, timeout, cancellation, retryability and unknown-outcome semantics for state-changing operations.
- Keep trust/approval/dispatch decisions separate. A validated DTO or cryptographic signature alone does not grant workflow authority.

## Compatibility policy

Track three separate compatibility surfaces:

1. **Source compatibility:** existing imports, function names, exports and call shapes.
2. **Wire compatibility:** JSON keys/types/enums, protocol versions, schema IDs and serialized persisted records.
3. **Semantic compatibility:** behavior, defaults, ordering, state transitions, authorization meaning, retry semantics and error guarantees.

An unchanged signature can still be a breaking change when behavior or defaults change. Persisted JSON and event records are wire contracts too.

### Versioning

- Use package SemVer: MAJOR for incompatible public API changes, MINOR for backward-compatible additions, PATCH for compatible fixes.
- Version the wire protocol/schema independently from the package version.
- Keep an old major protocol available during a documented migration window when old clients remain supported.
- Do not mutate an already released package version or retroactively change a published schema.
- Treat `0.y.z` as experimental; do not promise a stable API until compatibility tests and release policy are in place.

Strict validators require special care. The current COS-AP v1 envelope rejects unknown fields and unknown message types, while its JSON Schemas declare `additionalProperties: false`. Therefore adding a field or a new message type is not automatically backward-compatible with existing consumers. The package API reference records this limitation explicitly.

## Data ownership

Each stateful subsystem owns its authoritative data. Other subsystems consume stable APIs or versioned events/read models; they do not issue SQL against private tables.

| Data category | Intended owner | Cross-boundary rule |
|---|---|---|
| Workflow proposal, approval, plan, task, event and artifact lifecycle | Workflow lifecycle | Other components use workflow commands/queries; no direct writes. |
| Goal/Idea nodes, edges, revisions and knowledge snapshots | AGG knowledge | Workflow sees only versioned proposal/evidence references. |
| Trust roots, provider configuration and trust history | Trust subsystem / administrator authority | Public keys and configuration versions are references; private key material never crosses API. |
| Reviewer identity and external verification results | Trust/evidence subsystem plus external providers | Attestations bind exact scope/hash/nonce and remain distinct from workflow approval. |
| Provider run and dispatch-intent schema, read models and provider-only writes | ExecutionPersistenceStore v1 | Execution owns provider ledger DDL, named reads, intent reservation, dispatch outcome persistence, provider-run persistence/binding, reconciled run binding and no-send claim release. WorkflowStatePort retains compatibility methods and cross-domain send/result/lease fences on the shared connection. |
| Task leases, attempts, results, execution batches and task execution projections | Execution runtime, coordinated with Workflow lifecycle | WorkflowStore remains physical DDL/transaction owner. Preserve current shared-connection atomicity until named cross-owner commands and participant writes replace mixed ownership. |
| Read-only UI projections | Projection/dashboard | Never authority for writes or security decisions. |

Do not create a cross-subsystem transaction by sharing a database handle. If a workflow spans owners, define an explicit protocol: outbox/inbox or durable event, idempotent command, compensation/reconciliation and an observable uncertain state. A saga is not a substitute for a missing external authority or exact atomicity requirement.

### Current WorkflowStatePort boundary

`src/runtime/workflow-state-port.js` is the in-process API boundary used by execution/recovery consumers. Its interface version is `WORKFLOW_STATE_PORT_VERSION = 2`. `ExecutionPersistenceStore` v1 owns provider-run/dispatch-intent schema, read models, intent reservation, provider-only outcome writes, provider-run persistence/binding, reconciled run binding and no-send claim release; `WorkflowStatePort` retains compatibility methods that delegate these operations. Cross-domain send/result/lease fences remain coordinated through WorkflowStatePort on the exact shared connection. The port also exposes named Workflow/Execution operations for plan/approval readback, batch lifecycle, local execution preparation, PID binding and terminalization. `assertSharedConnection(database)` is an internal identity guard for participants that must join the exact same SQLite transaction unit; it does not return or expose the database handle. `authorizeExecutionSpawn` is one Workflow-owned atomic command that revalidates plan/approval, batch claim, lease fencing and durable start-event identity before writing exact spawn authorization; callers cannot control its transaction boundaries. There is no generic `transaction(fn)` callback. See [WorkflowStatePort API and consistency contract](workflow-state-port.md) for signatures and consistency semantics.

AGG candidate, readiness, reviewer, approval and sandbox modules consume `workflow-plan-public-api.js` v1 for canonical JSON and authoritative execution-plan validation, and `agent-contracts-public-api.js` for role contracts/action-intent vocabulary. They no longer import private `workflow/plan.js` or `workflow/agent-contracts.js` modules. This is a stable in-monorepo dependency direction; it does not extract Workflow Runtime or move its plan compiler/persistence.

This is an adapter, not a new datastore or deployable service. It wraps the existing WorkflowStore and same `DatabaseSync` connection. The port hides the raw database handle and does not offer `transaction(fn)`. Lease and local execution mutations delegate to WorkflowStore atomic methods; provider-ledger schema and read models are owned by `ExecutionPersistenceStore` v1, while provider intent/run writes and cross-domain CAS still pass through WorkflowStatePort on the shared connection. `ExecutionManager` no longer calls broad WorkflowStore methods directly; its plan/approval, batch, local-execution and final spawn-authorization calls use this port. `DistributedScheduler`, GitHub Actions, M11, M12 and `ProviderAdmissionController` use named WorkflowStatePort operations for Workflow-owned state; provider admission retains SQL only for its own tables. WorkflowStore still owns physical SQL/transaction groups for attempts, results, batches and task execution projections. RecoveryManager consumes named WorkflowStatePort operations and the separate Agent Session API. `AgentSessionStore` owns `agent_sessions`, `session_access` and `session_messages`; the host's `RunalithWorkflowStore` composition root constructs it, injects `WorkflowStatePort` and delivery hooks, and exposes an in-process `AGENT_SESSION_API_VERSION = 1` API. The public Agent Session domain port and internal lifecycle transaction participant are separate versioned objects. The root `job-store.js` retains import compatibility. The host `RunalithWorkflowStore` compatibility facade preserves legacy Agent Session method names; WorkflowStore core declares no public Agent Session delegators. It consumes private domain-port queries and invokes the lifecycle participant only inside existing same-SQLite transactions. Session task references, Workflow event writes and foreign-key/shared-file dependencies remain; API v1 is not yet a separately released public package contract. `isVerifiedSuccessfulLocalExecution` and the response summary predicate now live in [`execution-evidence.js`](../../src/runtime/execution-evidence.js), so RecoveryManager no longer imports the ExecutionManager process supervisor. CASE-01, manual-intervention and workspace-write-receipt tables have dedicated stores; `WorkspaceWriteCapabilityService` owns workspace-write orchestration; `Case01SnapshotService` owns active-MCP snapshot creation/compensation, recovery, lineage and consumption acknowledgement. These stores/services still use the shared database. AGG proposal/candidate/sandbox transactions remain host-owned. Spawn authorization is now one WorkflowStatePort v2 command, but WorkflowStore still owns the underlying shared database and mixed Execution transaction groups. These are source-level ownership boundaries, not independent storage or process boundaries. See [HTTP/MCP composition boundary](http-mcp-composition.md).

## Physical schema owner vs intended subsystem owner

| Tables / columns | Current physical DDL and SQL owner | Intended domain owner | Current consistency boundary / blocker |
|---|---|---|---|
| `jobs`, `tasks`, `approvals`, workflow plans/policy, `artifacts`, `reports`, `events` | `src/runtime/job-store.js` (`WorkflowStore`) | Workflow | WorkflowStore owns task/job lifecycle, approvals, shared event journal and report/delivery state. Cross-subsystem event writes remain in the same journal. |
| `task_leases`, `attempts`, `results`, `execution_batches`, `execution_batch_items`, `task_checkpoints`, task `execution_*` columns | `src/runtime/job-store.js` (`WorkflowStore`) | Execution for lease/attempt/result/batch mechanics; Workflow for task lifecycle and task-owned projections | These tables/columns share WorkflowStore DDL and transaction groups. ExecutionManager uses named port methods, but physical ownership has not moved. `task_checkpoints.provider_run_id` is a provider-run reference, not the checkpoint's identity. |
| `provider_runs`, `provider_dispatch_intents` | DDL, read models and provider-only writes: `src/runtime/execution-persistence-store.js`; cross-domain send/result/lease fences: `src/runtime/workflow-state-port.js` | Execution provider dispatch/run ledger | Host composition injects the exact shared connection and does not issue Execution DDL. WorkflowStore core reads these only through `ExecutionPersistenceParticipant` v1 backed by ExecutionPersistenceStore. Cross-domain fences still share one connection and WorkflowStatePort coordinator; this is not independent Execution storage. |
| `m12_native_specialist_start_intents` | `src/runtime/workflow-state-port.js` | M12 specialist start protocol | Durable `(task_id, attempt)` intent, Gateway idempotency key and request digest share Workflow DB and task-lease fences. |
| `m12_native_specialist_runtime` | `src/runtime/job-store.js` (`WorkflowStore`) | M12 specialist runtime identity/attachment | Runtime attachment and event/task checks remain in WorkflowStore transaction; start-intent DDL/SQL is in WorkflowStatePort. M12 schema/lifecycle ownership is split. |
| `provider_admission`, `provider_admission_leases` | `src/runtime/provider-admission.js` (`ProviderAdmissionController`) | Provider admission | Controller receives private `#db` and accesses only its own tables; Workflow task/event interactions use WorkflowStatePort. Shared physical DB remains. |
| `agent_sessions`, `session_access`, `session_messages` | `src/runtime/agent-session-store.js` (`AgentSessionStore`) | Agent Session | AgentSessionStore owns DDL/SQL. `RunalithWorkflowStore` host composition constructs it; constructor verifies exact same-connection identity through WorkflowStatePort. WorkflowStore consumes separate domain and lifecycle participant ports; retry/completion/terminalization remain same-connection transactions. |

## Identity domains are not interchangeable

| Identity | Canonical field(s) | Meaning and non-equivalence |
|---|---|---|
| OpenClaw runtime | `tasks.openclaw_run_id`, `tasks.openclaw_session_key`, `attempts.openclaw_run_id` | External OpenClaw run/session references projected onto Workflow task/attempt rows. Not Agent Session `session_id`, provider `provider_run_id`, M12 Gateway `run_id` or local `execution_session_id`. |
| Agent Session | `agent_sessions.session_id`, `agent_sessions.openclaw_session_key` | `session_id` is Agent Session domain identity; `openclaw_session_key` links to the external OpenClaw session. Neither is a provider run or local process ID. |
| Provider run | `provider_runs.provider_run_id`, `provider_dispatch_intents.provider_run_id`, `task_checkpoints.provider_run_id` | External provider execution identity bound to one immutable dispatch intent/lease/attempt. `task_checkpoints.provider_run_id` is only a reference to this identity. Never substitute `tasks.openclaw_run_id`. |
| M12 native runtime | `m12_native_specialist_start_intents(task_id, attempt)`, `admission_idempotency_key`, `m12_native_specialist_runtime.run_id` | Start intent is host-side idempotency identity; `run_id` is returned by the M12/Gateway runtime. Distinct from provider-run and OpenClaw run identities. |
| Local ExecutionManager | `tasks.execution_session_id`, `tasks.execution_attempt`, `tasks.execution_pid`, `execution_batches.batch_id`, `execution_batch_items.item_id` | Local execution session/attempt and OS PID, plus local batch/item IDs. PID is process observation, not durable run identity. These fields are not OpenClaw or provider IDs. |

## Cross-owner transaction groups

- Lease acquisition/heartbeat/expiry couples `task_leases`, task status/attempt/owner-epoch projections and event append. Expiry reads provider ledgers through `ExecutionPersistenceParticipant` on the same connection; ambiguous remote effects quarantine rather than requeue.
- Local execution prepare/finish couples task `execution_*` fields, `attempts`, `results` and `events`. Batch prepare/retry/finish additionally couples `execution_batches` and `execution_batch_items`.
- `applyVerifiedExecutionResult` couples lease/task/attempt/result/checkpoint/event writes with provider-run and dispatch-intent readback through the participant, under the existing savepoint. Removing that participant or splitting the DB would break result provenance/atomicity.
- Agent Session retry/completion/terminalization couples Workflow task/job/event transitions with Agent Session lifecycle participant calls in the same transaction. The participant is not a separate commit boundary.
- Provider dispatch send claim and provider-run binding are named compare-and-set operations around an external network boundary. A claimed/ambiguous send is not replayed; provider result reconciliation still shares Workflow transaction state.
- Execution spawn authorization is one Workflow-owned `authorizeExecutionSpawn` command. It rechecks immutable-plan binding, approval/proposal identity, batch claim, active lease owner epoch/attempt/expiry and the exact `execution.started` event under one `BEGIN IMMEDIATE`, then appends and reads back `execution.spawn_authorized` before commit. Failed checks roll back before returning. OS process creation remains outside SQLite; a crash after authorization is an uncertain spawn outcome handled by recovery/no-replay rules.

These ownership maps describe current code and transaction guarantees only. No schema migration, production DB change, independent process, or standalone extraction is claimed.

## Contract testing

For every public API:

- Publish valid and invalid request/response fixtures beside the contract.
- Test the provider against its declared schema and test each consumer against the interactions it actually uses.
- Verify the previous supported client against each candidate release.
- Test unknown fields, unknown enum values, null/omitted/default behavior, integer bounds, duplicate IDs, serialization round-trips and error codes.
- Keep a compatibility matrix per package/protocol major version.
- Use integration tests for composition, not as the only evidence of API compatibility.

## Extraction gate

A subsystem is ready for a separate repository/process only when it has: one owner; a bounded API; no prohibited reverse imports; explicit storage ownership; no implicit shared transaction; standalone tests/build/docs; a security review for its trust surface; and a consumer migration plan with a rollback path.
