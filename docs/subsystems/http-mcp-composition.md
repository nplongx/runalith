# HTTP/MCP composition boundary

**Scope:** legacy OpenAI-compatible HTTP adapter, active versioned stdio MCP entrypoint and domain-store composition.  
**Status:** Workflow-owned query/projection SQL migrated to `WorkflowStatePort`; CASE-01, manual interventions and workspace-write receipts have dedicated store APIs; Workspace Write is owned by `WorkspaceWriteCapabilityService`; active-MCP CASE-01 snapshot/lineage/ack orchestration is owned by `Case01SnapshotService`; AGG proposal/candidate/sandbox compound use cases remain composed in the host.

## Entry points

| Entry point | Purpose | Current boundary |
|---|---|---|
| [`server.js`](../../server.js) | Legacy OpenAI-compatible HTTP adapter | Uses `WorkflowStatePort` for Workflow events/results/provider-run/task-metadata read/write and `ProviderAdmissionController` for admission leases. No direct `store.db` access remains. |
| [`server/index-v1.0.9-rc.71-versioned-approval-subsystem-20261030.js`](../../server/index-v1.0.9-rc.71-versioned-approval-subsystem-20261030.js) | Active versioned stdio MCP runtime | Uses `WorkflowStatePort` for ordinary Workflow queries, evidence/readiness readbacks, candidate snapshots, result/attempt/report/approval reads, sandbox lineage and Workflow projection updates. Domain-specific persistence remains local. |

The MCP entrypoint no longer issues ordinary SQL for Workflow-owned tables (`jobs`, `tasks`, `events`, `results`, `artifacts`, `attempts`, `approvals`, `reports`, `workflow_plans`, execution batches/items, task leases or provider ledgers). It still performs a fresh-process read-only SQLite diagnostic in `workflow_reconciliation_check`; this is an explicit diagnostic probe, not normal query composition.

## Domain stores still embedded in the MCP composition

These tables have distinct consistency/authority responsibilities and must not be folded into `WorkflowStatePort` as arbitrary SQL methods.

| Owner candidate | Tables | Current behavior / extraction requirement |
|---|---|---|
| CASE-01 snapshot capability | [`src/runtime/workflow/case01-snapshot-service.js`](../../src/runtime/workflow/case01-snapshot-service.js) + [`case01-snapshot-store.js`](../../src/runtime/workflow/case01-snapshot-store.js) | **Application service and store API implemented for the active MCP entrypoint.** The service owns filesystem snapshot creation/compensation, reservation recovery, exact Workflow artifacts/results/tasks/attempts/events lineage, consumed-byte SHA-256 checks and idempotent acknowledgement. Store owns tables/readback and named writer transactions. Active MCP composes the service through ports and delegates. The service still holds the shared WorkflowStore writer transaction; no independent repository/database yet. Legacy `server/index.js` remains on the compatibility implementation pending separate migration. |
| Workspace write capability | [`src/runtime/workspace-write-capability-service.js`](../../src/runtime/workspace-write-capability-service.js) + [`src/runtime/workspace-write-receipt-store.js`](../../src/runtime/workspace-write-receipt-store.js) | **Application service implemented; receipt store remains persistence owner.** `WorkspaceWriteCapabilityService` owns current Workflow approval/task checks, immutable-plan recompile/hash verification, role/path authorization, preflight base-hash checks, writer-lock authorization recheck, secure filesystem mutation, receipt insert and `workflow.workspace_file_written` append. The receipt store owns schema, uniqueness, exact readback and named writer transaction lifecycle. MCP now validates the transport envelope, delegates to the service and maps its structured error into the MCP tool error. The shared SQLite writer lock still covers recheck + file mutation + receipt/event commit. Filesystem bytes are not atomic with SQLite: `workspaceMutationAttempted` plus post-rollback byte readback preserves `unreceipted/unknown`; retries require identical `patch_id` and payload; multi-file patches remain explicitly non-atomic. This is an in-process application boundary, not an independent database/process/package. |
| Manual-intervention store | [`src/runtime/manual-intervention-store.js`](../../src/runtime/manual-intervention-store.js), `manual_interventions` | **Store API implemented.** Owns schema, validated append/readback, bounded list and named transaction controls. MCP validates task belongs to supplied job and commits audit row with `manual_intervention.recorded` Workflow event in one writer transaction; each intervention has a distinct event dedupe ID. |
| AGG proposal/candidate transaction boundary | [`src/runtime/adaptive-goal-transaction-boundary.js`](../../src/runtime/adaptive-goal-transaction-boundary.js) | **Named transaction lifecycle API implemented.** Plan Graph create, Execution Graph create/read, Execution Plan Candidate create/read and Execution Readiness preview use distinct begin/commit/rollback methods. MCP retains source revalidation, build/compile, idempotency, event writes and exact readback inside the corresponding named transaction. Next: move each compound use case into `AdaptiveGoalProposalService` after pinning source freshness, lock duration and idempotency contracts. |
| AGG sandbox action claim/recovery | AGG claim/completed/failed events plus Workflow result/attempt/artifact rows | **Claim transaction lifecycle now uses `AdaptiveGoalTransactionBoundary`.** One-shot sandbox side effect is protected by a durable claim and crash-recovery lineage. Claim/readback still run in the MCP use case; action execution remains after claim commit, and result/artifact/completion writes remain a separate crash window. Next: move claim/run/recovery into `AdaptiveGoalSandboxService` without weakening no-replay semantics. |
| Provider admission | `provider_admission`, `provider_admission_leases` | Already owned by `ProviderAdmissionController`, which exposes active-lease queries and lease decisions. No SQL should be added to the MCP entrypoint for these tables. |
| Trust and knowledge stores | Separate trust DB plus AGG knowledge/telemetry stores | Already have dedicated runtime APIs; remove remaining direct `workflowDb` handle injection only after their cross-store transaction/read semantics are explicitly defined. |

## Current API calls used by composition

`WorkflowStatePort` now supplies semantic methods including:

- Event lineage: `listEventsForJob`, `listEventsForJobPayload`, `listEventsForJobTypesPayload`, `findEventsByTypePayload`, `countEventsForJobType`, `getEvent`, `recordEvent`.
- Evidence: `getResult`, `listResultsForTask`, `listSuccessfulResultsForTask`, `hasSuccessfulTaskResult`, `getAttempt`, `getReport`, `listReportsForJob`, artifact identity/content/hash readbacks.
- Workflow lifecycle/readiness: tasks, approvals, immutable plan presence, task counts, active sessions/batches and execution-batch lineage.
- Projections: task metadata update, pending-task cancellation and open-task failure.

`ProviderAdmissionController` supplies `findActiveLease` and `listActiveLeasesForJob` to the HTTP adapter. It remains the owner of admission state.

## Extraction order

1. **Workspace write capability implemented.** Keep authorization, filesystem, receipt and event ownership behind `WorkspaceWriteCapabilityService` ports; do not move transport concerns back into the service or expose the shared DB handle.
2. Move the combined CASE-01 snapshot creation/compensation + reservation + artifact/receipt lineage + consumption acknowledgement into a CASE-01 service using the new `Case01SnapshotStore`; preserve its single writer transaction and crash/restart semantics.
3. Extract AGG Plan Graph/Execution Graph/candidate commands into `AdaptiveGoalProposalService`; preserve current source freshness, immutable candidate hash, transaction and idempotency guarantees. Named SQLite transaction boundaries now exist; move the entire use cases, not only begin/commit, into the service.
4. Extract sandbox claim/run/recovery into `AdaptiveGoalSandboxService`; preserve the current claim-commit-before-side-effect boundary, one-shot semantics, result/artifact crash windows and no-replay recovery.
5. Remove remaining raw `DatabaseSync` injection into trust/knowledge/custom-role/workflow modules only after each store has a stable owner API.

## Verification

The architecture guard `tests/test-workflow-state-port-boundary.mjs` checks that HTTP/execution adapters use APIs, the active MCP entrypoint does not issue direct SQL against Workflow/domain store tables, and AGG transaction controls use named methods. Transaction lifecycle contract: `tests/test-adaptive-goal-transaction-boundary.mjs`. Store contracts: `tests/test-manual-intervention-store.mjs`, `tests/test-workspace-write-receipt-store.mjs`, `tests/test-case01-snapshot-store.mjs`. Secure filesystem post-rename failure coverage: `tests/test-secure-filesystem-boundary.js`. Focused MCP composition coverage is `tests/test-runalith-plugin.js`; CASE-01 transaction coverage is `tests/test-case01-artifact-acceptance.js` and `tests/test-case01-artifact-transaction.js`; provider admission coverage is `tests/test-provider-admission-integration-m3.js`.

This migration does not split the database or process. The current aggregate still uses shared SQLite transactions for the listed compound domain operations.
