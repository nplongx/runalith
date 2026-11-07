# WorkflowStatePort API and transaction contract

**Interface version:** `WORKFLOW_STATE_PORT_VERSION = 2`  
**Implementation:** [`src/runtime/workflow-state-port.js`](../../src/runtime/workflow-state-port.js)  
**Status:** implemented as an in-process boundary; not an independent service, database or separately published package.

## Purpose and ownership

`WorkflowStatePort` is the in-process Workflow-owned state interface used by Execution, recovery and domain-verification adapters, plus `AgentSessionStore` for task/event interactions. ExecutionManager uses named plan/approval, batch and local-execution methods instead of calling broad WorkflowStore methods. The factory is `createWorkflowStatePort(store)`; passing an existing `WorkflowStatePort` returns the same instance.

The implementation currently wraps the same `WorkflowStore` and same SQLite `DatabaseSync` connection. The port hides the raw database handle and does not expose a generic transaction callback. Its internal `assertSharedConnection(database)` guard verifies exact object identity for same-connection participants such as `AgentSessionStore`; it returns no handle and is not a transaction API. It is a modular-monolith boundary, not proof of independent storage or deployment.

## Public surface

The interface is grouped by capability. The exact exported method signatures and parameter defaults are defined by the implementation; this page documents the semantic contract.

| Capability | Methods |
|---|---|
| Workflow/task reads | `getJob`, `getTask`, `getLatestChildTaskForRole`, `getArtifact`, `getTaskLease`, `getEvent`, `recordEvent`, `listTasksForJob`, `listTasksForTerminalJobs`, `listJobsByState`, `listTasksWithOpenClawSession`, `clockNow` |
| Plan and approval reads used by Execution | `getExecutionPlan`, `getCurrentProposal`, `getLatestApproval`, `assertApprovalCurrent`, `compileExecutionPlan` |
| Event read models | `listEventsForJob`, `listEventsForJobPayload`, `listEventsForJobTypesPayload`, `findEventsByTypePayload` (supports bounded dotted JSON property paths), `countEventsForJobType` |
| Execution reads | `listResultsForJob`, `getResult`, `getLatestTaskResult`, `listResultsForTask`, `listSuccessfulResultsForTask`, `getExecutionBatchItemForTask`, `getExecutionBatchLineageEvidence`, `getMandatoryBatchItemForTask`, `listRunningExecutionTasks`, `getRunningExecutionSessionIds`, `listExecutionStartedEventsForJob`, `listExecutionStartedEventsForAttempt`, `listActiveTaskLeasesForTask`, `listActiveLocalAttemptsForTask` |
| Spawn authorization reads | `getExecutionBatchSpawnClaim`, `hasExecutionAttemptHistory`, `hasExecutionBatchItemHistory` |
| Evidence/readiness reads | `getAttempt`, `listApprovalsForJob`, `countTasksForJob`, `hasWorkflowPlan`, `getReport`, `listReportsForJob`, `getArtifactStorageRecord`, `getArtifactIdentity`, `listArtifactContents`, `listArtifactCreatedEvents`, `listTaskCompletionEvents`, `listActiveAgentSessionsForJob`, `listActiveExecutionBatchesForJob`, `hasSuccessfulTaskResult`, `hasTaskAttemptHistory`, `hasTaskBatchItemHistory` |
| Provider ledger reads (delegated to ExecutionPersistenceStore v1) | `getDispatchLedgerForLease`, `getProviderRun`, `getProviderDispatchIntent`, `getProviderDispatchIntentForRun`, `listProviderDispatchIntents`, `listSiblingProviderDispatchIntents`, `listProviderRunsForJob`, `hasProviderRunLedger`, `hasProviderDispatchIntentLedger`, `hasUnresolvedProviderDispatchForJob`, `hasUnresolvedProviderRunForJob`, `listProviderDispatchIntentsForProviderRun`, `listProviderDispatchIntentsForDispatchKey` |
| Lease lifecycle | `acquireTaskLease`, `heartbeatTaskLease`, `completeTaskLease`, `expireTaskLease`, `reapExpiredTaskLeases`, `listTaskLeases`, `listRunnableTasks`, `clearTaskLeaseError` |
| Provider dispatch/run state | `reserveProviderDispatchIntent`, `recordProviderDispatchOutcome`, `claimProviderDispatchForSend`, `releaseProviderDispatchSendClaim`, `bindProviderDispatchRun`, `bindReconciledProviderRun`, `persistProviderRun` |
| M12 specialist start | `ensureM12NativeSpecialistStartIntentSchema`, `getM12NativeSpecialistStartIntent`, `reserveM12NativeSpecialistStart`, `claimM12NativeSpecialistStartForSend`, `getM12NativeSpecialistRuntime`, `attachM12NativeSpecialistRuntime`, `reconcileM12NativeSpecialistResult` |
| Spawn authorization | `assertImmutablePlannedExecution`, `authorizeExecutionSpawn` (one Workflow-owned atomic command; no caller-managed transaction controls) |
| Local Execution and batch lifecycle | `prepareExecution`, `prepareExecutionForBatchClaim`, `setExecutionPid`, `finishExecution`, `getExecutionBatch`, `listExecutionBatchItems`, `verifyCompletedExecutionBatch`, `prepareExecutionBatchRetry`, `markExecutionBatchItemRunning`, `finishExecutionBatchItem`, `markExecutionBatchWaiting`, `finishExecutionBatch`, `cancelExecutionBatch`, `recoverUnstartedExecutionBatchClaims`, `recoverTerminalExecutionBatchItemFromTask` |
| Recovery lifecycle | `getRecoveryJobSnapshot`, `reconcileRunningTaskForTerminalJob`, `completeTaskByRuntime`, `repairResultEvidence`, `reconcileFailedTaskByRuntime`, `setProviderWaiting`, `clearProviderWaiting`, `createReport`, `claimDelivery`, `terminalizeJob` |
| Workflow projection updates | `updateTaskMetadata`, `cancelPendingTasksForJob`, `failOpenTask` |
| Result/recovery | `assertP3ProviderResultCollectionLease`, `persistProviderRunResultWithLeaseFence`, `applyVerifiedExecutionResult`, `hasUnresolvedDurableExecution`, `reconcileStaleJob`, `recoverStaleExecution` |
| Composition/schema | `ExecutionPersistenceStore` constructor initializes its provider-run/dispatch-intent schema; `ensureProviderExecutionSchema` remains a delegating compatibility method; M12 start-intent schema initialization remains here; `assertSharedConnection(database)` |

The module also contains narrower query helpers used by the current adapters, including `listM12NativeSpecialistRuntimesForLease` and `listDeterministicTasksInExecutingJobs`.

## Atomicity and consistency guarantees

### Spawn authorization

`authorizeExecutionSpawn` owns the complete final pre-spawn gate under one `BEGIN IMMEDIATE` transaction. It rereads the task/session/attempt and execution-boundary identity; revalidates the immutable plan against the current approved proposal; verifies the batch claim, approval/proposal identity, exact active lease owner epoch/attempt/expiry and the unique durable `execution.started` event; appends `execution.spawn_authorized`; and requires exact event readback before commit. Any failed check rolls back before returning. ExecutionManager cannot independently begin, commit or roll back this transaction. OS process creation remains outside SQLite and occurs only after this durable authorization command succeeds; a crash after commit is an uncertain spawn outcome handled by existing recovery/no-replay rules.

### Lease lifecycle

Lease lifecycle commands delegate to `WorkflowStore`'s existing atomic primitives. The port must not open a second transaction around them. Acquisition still couples parent-job liveness, active-lease exclusion, monotonic attempt and owner epoch, task compare-and-set, event append and exact readback. Heartbeat/completion/expiry retain their worker/attempt/expiry fences. Expiry checks provider dispatch claims, provider runs and native runtime records; if a remote side effect may have happened, the lease is quarantined and the task is not returned to the runnable queue.

### Dispatch intent and provider run

`reserveProviderDispatchIntent`, `recordProviderDispatchOutcome`, `bindReconciledProviderRun`, `releaseProviderDispatchSendClaim`, `persistProviderRun` and the provider-ledger-only `bindProviderDispatchRun` are physically implemented by `ExecutionPersistenceStore` v1; WorkflowStatePort keeps source-compatible named methods. Reservation persists one immutable request identity per job/task/lease/attempt/provider tuple and reads it back under a savepoint. `claimProviderDispatchForSend` remains in WorkflowStatePort because its single SQL compare-and-set also fences Workflow-owned task lease, parent job and running task rows plus sibling provider intents on the production SQLite path. A failed pre-send claim may be released only with the matching claim ID. A claim that may have crossed the network boundary is not released for retry.

`bindProviderDispatchRun` and `bindReconciledProviderRun` preserve exact request digest, dispatch key, task/lease/attempt/owner-epoch and provider-run identity. Provider-run terminal state and terminal evidence cannot be replaced by stale or conflicting observations. Provider result collection rechecks the exact active task/lease/parent and writes terminal provider-run evidence inside one encompassing WorkflowStatePort savepoint; that cross-domain fence is deliberately not moved into the provider-only store method.

### M12 native specialist start

Before `m12.specialist.start`, the bridge reserves an immutable `(task, attempt)` start intent containing lease/owner epoch, environment/node identity, Gateway idempotency key and request digest. Immediately before the RPC it obtains a one-way send claim; this rechecks the exact unexpired lease, running task and active parent under a fresh SQLite writer reservation. If the lease expired between reservation and send claim, no RPC is made. A second reservation/claim for the same task/attempt is refused with `M12_START_OUTCOME_UNKNOWN_REQUIRES_RECONCILIATION`; the bridge does not issue a replacement Gateway RPC. When actual Gateway IDs return, `WorkflowStore.attachM12NativeSpecialistRuntime` validates task/attempt/lease/owner epoch, lease expiry, parent/task liveness and the exact send claim, then changes the intent to `STARTED` in the same `BEGIN IMMEDIATE` transaction as the native runtime row and attachment event.

When Gateway may have accepted the request but the response/attachment is lost, the `STARTING` row and send claim remain durable. Workflow terminalization is deferred; lease expiry quarantines the attempt even without a returned run/session ID. Automated Gateway lookup/reconciliation is not implemented; such orphaned starts require operator/provider-side reconciliation. This prefers a blocked task over duplicate native execution.

### Result application and recovery

`applyVerifiedExecutionResult` still delegates to WorkflowStore's verification and atomic application path; structural validation alone is not authority. `hasUnresolvedDurableExecution` returns true for any active lease, unresolved dispatch claim/run, quarantined uncertain lease, pending/mismatched M12 start intent or nonterminal M12 runtime. `reconcileStaleJob` and `recoverStaleExecution` are named state operations so their task/attempt/batch/event updates remain one savepoint unit. Errors during state inspection defer recovery rather than converting uncertainty into a terminal state.

## Consumers

Current migrated consumers:

- `DistributedScheduler`
- `GitHubActionsProvider`
- `M11RunnerProvider`
- `ExecutionManager`
- `RecoveryManager`
- `LangGraphControlLoop`
- `M12NativeSpecialistBridge`
- Legacy OpenAI-compatible HTTP adapter in `server.js`
- Active versioned MCP composition in `server/index-v1.0.9-rc.71-versioned-approval-subsystem-20261030.js` for Workflow-owned queries, readbacks and projections

`ProviderAdmissionController` owns provider-admission tables through a private database reference; host composition injects that connection separately from `WorkflowStatePort`. Task lookup, child-task resolution and Workflow event writes use named port methods. It no longer retains WorkflowStore or queries `tasks`/`events`. `DistributedScheduler`, GitHubActionsProvider and M11RunnerProvider receive WorkflowStatePort explicitly from host composition; their constructor store fallback remains compatibility-only. ExecutionManager and RecoveryManager also receive the port explicitly, with Agent Session API injected separately into RecoveryManager.

`ExecutionPersistenceStore` v1 owns DDL, named read models and provider-ledger-only writes for `provider_runs` and `provider_dispatch_intents`. Host composition constructs it with the exact shared connection, passes it into WorkflowStatePort, and builds `ExecutionPersistenceParticipant` v1 from that owner. The store keeps its DB handle private and exposes no generic transaction API. `ExecutionPersistenceParticipant` is a separate internal, read-only transaction participant; WorkflowStore uses it inside existing savepoints/transactions when reconciling provider outcomes. WorkflowStatePort retains compatibility wrappers and coordinates cross-domain send/result/lease fences on that same connection. This moves logical schema/read/write ownership for provider-only operations, not physical database or independent transaction ownership; Execution/Workflow transaction partitioning remains incomplete.

The active MCP composition no longer issues SQL against Workflow-owned tables for ordinary queries: events, results, attempts, reports, approvals, task counts, plans, artifact bytes and execution-batch lineage use `WorkflowStatePort`. AGG candidate interpretation also consumes only WorkflowStatePort reads; WorkflowStore no longer parses AGG candidate payloads or owns that evidence-lineage algorithm. `AgentSessionStore` owns schema and SQL for agent sessions, ACL and session messages; `RunalithWorkflowStore` host composition creates it, injects `WorkflowStatePort` for task/event interactions and exposes a versioned Agent Session API. The constructor requires `WorkflowStatePort.assertSharedConnection(database)` to verify exact SQLite connection identity before schema initialization, preventing row/event transitions from being split across independent connections. WorkflowStore core has no AgentSessionStore import/construction or public Agent Session facade methods; the host compatibility facade preserves legacy names. WorkflowStore core retains a private domain-port injection for session projections and a separate injected internal lifecycle participant for retry/completion/terminalization transactions. `ManualInterventionStore`, `WorkspaceWriteReceiptStore` and `Case01SnapshotStore` own their tables; `WorkspaceWriteCapabilityService` and `Case01SnapshotService` own the corresponding use cases. All these boundaries still use the shared WorkflowStore database; they are source-level ownership boundaries, not independent storage. Remaining AGG proposal/sandbox coordination is use-case logic, not direct access to these private tables. Both active and legacy MCP entrypoints use host composition for Agent Session. The fresh-process SQLite check is intentionally a read-only diagnostic subprocess.

`ExecutionManager` and `RecoveryManager` no longer keep or call broad `this.store` references. Host composition injects WorkflowStatePort into ExecutionManager, RecoveryManager, DistributedScheduler and provider adapters; RecoveryManager receives Agent Session API v1 separately. WorkflowStatePort calls still delegate to the current WorkflowStore transaction owner, including `attempts`, `results`, reports/delivery, `execution_batches`, `execution_batch_items`, task `execution_*` columns and associated event writes. ExecutionPersistenceStore owns provider ledger DDL/read models/provider-only writes; WorkflowStatePort retains cross-domain send/result/lease transaction fences. Spawn authorization is already one WorkflowStatePort v2 atomic `authorizeExecutionSpawn` command; caller-managed begin/commit/rollback controls are not exposed. WorkflowStore still owns physical SQL and same-database transaction groups. A fresh-process, read-only SQLite probe remains in the workflow diagnostics tool by design.

## Explicit non-guarantees / extraction blockers

This port does not create a new database, process boundary, network API, npm package or GitHub repository. It does not remove WorkflowStore as the transaction authority. Cross-service atomicity, outbox/inbox delivery, crash recovery across databases, distributed lock custody and schema migrations between independent owners are not implemented here. M12 `STARTING` intents have no automated external lookup/reconciliation path yet; they remain quarantined until separately resolved.

Before separate deployment or repository extraction, complete the workspace file/receipt/event use-case command; move CASE-01 snapshot creation/compensation and lineage/ack verification behind one CASE-01 domain operation; extract compound AGG/sandbox transactions behind named domain operations; finish the spawn-authorization command; review M12 runtime writers and WorkflowStore internal callers; define single-owner storage semantics; then add two-connection race/crash tests and an explicit cross-boundary consistency protocol. Do not split the database while these shared transaction requirements remain.

## Contract tests

Run:

```bash
node --test tests/test-workflow-state-port.mjs
node tests/test-distributed-scheduler.js
node tests/test-provider-pre-send-recovery.js
node tests/test-provider-run-quarantine-reconciliation.js
node tests/test-recovery-active-lease-guard-20261017.js
node tests/test-recovery-hardening.js
node tests/test-deterministic-recovery-race.js
```

The wider regression list is recorded in the subsystem execution note and release/acceptance artifacts.
