# Execution runtime subsystem

**Target boundary:** plan-bound execution, provider adapters, execution verification, leases and recovery. It is not yet safe to extract as a standalone process or independently owned database.

## Current implementation

Relevant code includes `src/runtime/execution-manager.js`, `execution-contract.js`, `execution-verifier.js`, `distributed-scheduler.js`, `recovery-manager.js`, `task-lease-manager.js`, `provider-admission.js`, `provider-dispatch-identity.js`, `github-actions-provider.js`, runner/provider adapters and `src/runtime/session-transport.js`.

The pure durable-result predicates live in [`execution-evidence.js`](../../src/runtime/execution-evidence.js). RecoveryManager consumes this contract module; it does not import the ExecutionManager process supervisor.

The production local plugin currently describes a local-first execution path. Experimental distributed-worker/provider code must not be described as enabled in the shipped local entrypoint without source and runtime evidence.

## Candidate public API

- `executeBatch(approvedExecutionBatch)`
- `inspectExecution(operationId)`
- `reconcileExecution(operationId)`
- `cancelExecution(operationId)`
- `verifyExecutionResult(request, result)`

Each operation needs plan-bound inputs, stable operation IDs, lease/attempt identity, idempotency, retry policy, timeout and explicit unknown-outcome semantics. The subsystem must not accept arbitrary commands from an untrusted API caller; command/cwd/timeout authority must remain bound to the approved immutable plan.

## Extraction blockers

- ExecutionManager and RecoveryManager now receive `WorkflowStatePort` explicitly from host composition. DistributedScheduler, GitHubActionsProvider and M11RunnerProvider also receive the port explicitly; their compatibility constructors still accept the legacy store fallback for existing callers. The port still delegates to WorkflowStore's same SQLite connection and mixes Workflow/Execution persistence operations.
- WorkflowStore remains the physical schema/mutation implementation for `attempts`, `results`, `task_leases`, `execution_batches`, `execution_batch_items`, task `execution_*` projections and the shared `events` journal. `ExecutionPersistenceStore` v1 owns `provider_runs`/`provider_dispatch_intents` DDL, read models, intent reservation, provider-only outcome writes, provider-run persistence/binding, reconciled run binding and no-send claim release. WorkflowStatePort retains compatibility wrappers and cross-domain send/result/lease fences. M12 native start intents remain in WorkflowStatePort. All use the same database connection; this is logical ownership progress, not independent Execution storage.
- Dispatch intent, provider-run binding, lease fencing and task lifecycle rely on coordinated `BEGIN IMMEDIATE` transactions and recovery checks.
- RecoveryManager reconciles Workflow state through named WorkflowStatePort commands and consumes the neutral success predicate from `execution-evidence.js`. The commands still delegate to WorkflowStore transaction owners; a service/database split without an explicit transaction/outbox/reconciliation design could create duplicate dispatch, false completion or lost/ambiguous provider outcomes.
- `execution-contract.js` delegates durable request/result validation to COS-AP package validators, while runtime-specific creation/freezing logic remains in the execution domain.

## Required seam before extraction

**Implemented:** `src/runtime/workflow-state-port.js` exposes `WorkflowStatePort` v2 over the existing `WorkflowStore` and same SQLite connection. `ExecutionPersistenceStore` v1 owns provider-run/dispatch-intent schema, read models, intent reservation, provider-only outcome writes, provider-run persistence/binding, reconciled run binding and no-send claim release; `ExecutionPersistenceParticipant` v1 exposes the narrow read contract to WorkflowStore. The port deliberately hides the `DatabaseSync` handle and exposes no generic transaction callback. It provides named operations for plan/approval readback, local execution preparation/PID/finish, batch lifecycle, lease lifecycle, one-way send claim, fenced result collection, workflow read models and stale recovery.

Migrated consumers: `DistributedScheduler`, `GitHubActionsProvider`, `M11RunnerProvider`, `ExecutionManager`, `RecoveryManager`, `LangGraphControlLoop`, `M12NativeSpecialistBridge`, legacy `server.js` and the active versioned MCP entrypoint. Host composition injects `WorkflowStatePort` instead of passing WorkflowStore to these adapters. They no longer issue direct SQL for Workflow-owned leases, event/result/attempt/report/approval read models, execution-batch evidence, recovery queries, M12 lease-to-runtime correlation or spawn-authorization readbacks. `ExecutionPersistenceStore` owns provider-run/dispatch-intent schema, read models, intent reservation, provider-only outcome/binding writes, provider-run persistence and no-send claim release; its constructor initializes its own schema. Host composition supplies the exact shared connection but does not issue Execution DDL. `ExecutionPersistenceParticipant` v1 gives WorkflowStore a narrow, read-only reconciliation surface on the same connection. Cross-domain send/result/lease fences remain coordinated by WorkflowStatePort. `ProviderAdmissionController` receives its private provider-owned database connection separately from WorkflowStatePort and queries only provider-admission tables; task/event interactions use named WorkflowStatePort methods.

Underlying atomic lease transitions remain implemented by `WorkflowStore`: acquisition groups parent liveness, active-lease exclusion, monotonic attempt/owner epoch, task CAS, event and readback; heartbeat/completion/expiry preserve their lease/task/job fences and quarantine checks. The port delegates lease lifecycle calls without nesting transactions. Provider send-claim CAS, intent/run binding and result collection fences are named port operations with their original savepoint/compare-and-set semantics. Stale Job and stale local execution recovery are also named savepoint operations.

`ExecutionManager` and `RecoveryManager` have no direct `this.store.*` calls. Plan/approval reads, compilation, batch operations, local execution preparation, PID binding, task/result recovery, report/delivery and terminal writes use named port methods; Agent Session registry/state calls use Agent Session API v1. Immutable-plan/approval validation remains orchestrated by `ExecutionManager`; the final `authorizeExecutionSpawn` call is one Workflow-owned atomic command over the existing `BEGIN IMMEDIATE` writer reservation. Callers cannot control its transaction boundaries.

**Still required before independent deployment/repository extraction:** CASE-01 snapshot/ack and Workspace Write have application services in active host composition; their stores/receipts still use WorkflowStore persistence. Manual-intervention persistence has a dedicated store. Split the mixed Workflow/Execution methods in `WorkflowStatePort` into separately versioned Workflow and Execution contracts; move provider write/CAS commands and remaining attempt/result/batch SQL to Execution-owned participant methods without weakening same-connection atomicity; formalize OpenClaw identity references separately from provider-run/M12/local process IDs; add standalone tests/build/docs/CI and compatibility policy. M12 `STARTING` intents block duplicate starts and quarantine unknown outcomes, but automated Gateway lookup/reconciliation is not implemented. Do not introduce a generic `transaction(fn)` API. A separate database/process still needs an explicit outbox/inbox, idempotency, reconciliation and unknown-outcome design. No process or database split is claimed by this change.

## Documentation

The subsystem repository must document local execution, provider capability matrix, lease/recovery state machine, command authorization boundaries, error/unknown-outcome semantics and provider contract fixtures. The host catalog remains canonical for composition and rollout blockers.
