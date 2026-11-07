# AGG external checkpoint v2 — event query classification v0.3

**Status:** Source-level query/caller classification evidence. Not a normative event registry, accepted projection manifest, complete authorization map, deployment attestation, or issue-acceptance decision. V2-01 / #32 remains OPEN.

**Inputs:** Preserved 88-file/193-event-SQL-callsite direct-SQL inventory at `artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261030T132800Z-multi-statement-aware-v2.json`; recordEvent producer register `agg-external-checkpoint-v2-record-event-caller-register-20261030-v0.1.json`; normative specification and decision register.

**Machine register:** `agg-external-checkpoint-v2-event-query-register-20261030-v0.4.json`, SHA-256 `a878fdd149503d0fa5054f33a4af7782cba1a432dd47f0cfb2751c2713993960`.

**Preserved inventory input:** SHA-256 `45da27f66702536f2ae903813060a56e75eb548e3d48cc482472eefac357b7e1`; pinned as a separate source artifact in benchmark fixture v158.

## 1. Query-level result

The preserved inventory contains 196 event references including three scripts. Runtime filtering yields **193 unique event SQL callsites across seven source files**. The builder selectively re-extracts event SQL callsites from the configured RC.71 entrypoint because that file has accumulated source drift; six unchanged runtime files reuse their preserved inventory rows. No 88-file rescan is performed.

| Source file | Event SQL callsites |
|---|---:|
| `server/index-v1.0.9-rc.71-versioned-approval-subsystem-20261030.js` | 35 |
| `src/runtime/adaptive-goal-approval-subsystem.js` | 5 |
| `src/runtime/execution-manager.js` | 5 |
| `src/runtime/adaptive-goal-reviewer-identity.js` | 6 |
| `src/runtime/job-liveness.js` | 1 |
| `src/runtime/job-store.js` | 138 |
| `src/runtime/langgraph-control-loop.js` | 3 |
| **Total** | **193** |

Operation classification:

- 189 SQL readers.
- 3 event-row writers.
- 1 multi-statement event schema/trigger bootstrap, classified `schema-bootstrap-only` after inspecting every constituent statement. It contains schema writes and transaction-control statements; zero event-row data writes.

The 189 readers are further classified by SQL shape:

| Query purpose | Count |
|---|---:|
| Event identity lookup/readback (`WHERE event_id = ...`) | 68 |
| Job-scoped event read | 103 |
| Event existence check (`SELECT 1`) | 5 |
| Latest event / latest matching event | 4 |
| Event row count | 3 |
| Literal event-type filtered read | 3 |
| Nonce replay count | 2 |
| Global event scan/aggregate | 1 |
| **Reader total** | **189** |

`predicateColumns` is extracted lexically from the SQL `WHERE` clause only; it does not claim AST-resolved semantics and does not include `JOIN ... ON` columns. The field therefore no longer mistakes selected or ordered columns for predicates. These are SQL-shape labels, not assertions that each read is an authorization predicate. The register records literal type predicates, parameterized type predicates, WHERE-clause predicate columns, JSON payload selectors visible in SQL, ordering, SQL/source hashes, source location, nearest caller declaration and bounded transaction-marker context.

## 2. Producer/query coverage delta

The producer register has **72 distinct literal `recordEvent()` event types**. The query register observes **51 distinct literal event-type predicates**. These sets are not equivalent:

- 39 producer literals have no matching literal event-type predicate in the 193 query sites: `attempt.failed`, `attempt.started`, `batch_execution.policy_denied`, `case01.snapshot_cleanup_failed`, `execution.batch.cancelled`, `execution.batch.item_recovered_from_terminal_task`, `execution.batch.item_recovered_unstarted`, `execution.evidence_recovered`, `execution.evidence_recovery_blocked`, `execution.spawn_authorized`, `execution.spawn_reconciliation_required`, `execution.stale`, `job.runtime_reconciled`, `m12.specialist.runtime_attached`, `manual_intervention.recorded`, `provider.waiting`, `result.evidence_replaced`, `session.access_revoked`, `session.attached`, `session.created`, `session.runtime_reconciled`, `session.stale`, `session.takeover`, `task.created`, `task.execution.quarantine_collection_failed`, `task.execution.quarantine_observed`, `task.execution.quarantine_status_failed`, `task.local_started`, `task.provider.pre_send_recovery`, `task.result_reconciliation_blocked`, `task.runtime_attached`, `task.runtime_rearmed`, `task.runtime_reconciled`, `task.timeout_recoverable`, `workflow.artifacts.invalidated`, `workflow.policy.attached`, `workflow.policy.violation_detected`, `workflow.synthesis_validation_blocked`, `workflow.terminal_phase_reconciled`.
- 18 literal query predicates are not in the literal producer set: `adaptive_goal.action_intent_review_authorized`, `adaptive_goal.approval_policy_version_observed`, `adaptive_goal.execution_plan_candidate_created`, `execution.batch.completed`, `execution.cancelled`, `execution.completed`, `execution.failed`, `job.completed`, `job.proposal_refined`, `m12.specialist.completed`, `m12.specialist.failed`, `task.completed`, `task.execution.checkpointed`, `task.execution.rejected`, `task.execution.verified`, `task.failed`, `task.local_completed`, `task.local_failed`.

The deltas are review queues, not defects or allowlist decisions. Parameterized predicates, constants, direct SQL inserts, event-ID readbacks, historical rows and producers outside the scanned callsites can explain set differences. No event type is accepted, rejected or excluded from a projection based on this comparison.

The separate producer register still reports 17 computed/unresolved producer expressions. The generic `WorkflowStore.recordEvent()` writer accepts a caller-supplied event string; `transitionWorkflowPhase()` likewise accepts a caller-supplied event value. No finite allowlist or new rejection behavior is inferred or added here.

## 3. Writer/read-path semantics observed

### Event-row writers

1. `src/runtime/job-store.js:1309`, `WorkflowStore.recordEvent()` — `INSERT OR IGNORE INTO events`. Event identity is derived from job ID, event type and caller dedupe key. This is the generic writer used by lifecycle, recovery and workflow paths. The helper does not itself require an open transaction; atomicity depends on the caller's surrounding transaction/savepoint or SQLite autocommit.
2. `src/runtime/adaptive-goal-approval-subsystem.js:436`, `recordAdaptiveGoalApprovalPolicyHighWater()` — direct `INSERT INTO events`. Runtime rejects calls unless `workflowDb.isTransaction === true`. The same workflow transaction persists the human approval; exact event readback follows insert. This event records observed policy version/hash continuity; it is not host-managed trust authority.
3. `src/runtime/adaptive-goal-reviewer-identity.js:302`, `ingestAdaptiveGoalReviewerAttestation()` — direct `INSERT INTO events` inside explicit `BEGIN IMMEDIATE`; nonce precheck, candidate/attestation verification and exact persistence/readback occur before `COMMIT`. Any thrown failure while the transaction is open attempts `ROLLBACK`. The provider-signed assertion is verified locally; this source path does not authenticate a human independently or grant approval/dispatch.

No event-row `UPDATE` or `DELETE` appears among these 193 classified event SQL callsites. The schema bootstrap creates append-only protections, including reviewer security-event triggers. This is bounded lexical evidence, not proof that aliases, wrappers, generated SQL, migrations or non-SQL stores cannot mutate event state.

### Authorization and anti-replay readers

- `adaptive-goal-approval-subsystem.js:310`, `assertFreshApprovalNonces()` — scans `approval.approved` in `created_at ASC,rowid ASC` order; validates canonical stored JSON and signed-evidence structure; detects duplicate maker/checker one-use nonces. Historical approvals without the AGG signed-evidence envelope are explicitly tolerated.
- `adaptive-goal-approval-subsystem.js:344`, `readApprovalPolicyHighWater()` — parameterized type and `policy_id` query ordered by `rowid ASC`; validates canonical payload, event identity, schema, policy version/hash and continuity.
- `adaptive-goal-reviewer-identity.js:119,161`, `assertAdaptiveGoalReviewerAttestation()` — reads candidate/job-bound reviewer event and counts nonce uses across reviewer events; verifies exact event/candidate binding, trust root, scope, signature and freshness.
- `adaptive-goal-reviewer-identity.js:239,294,302,318`, `ingestAdaptiveGoalReviewerAttestation()` — checks existing record and nonce replay, inserts once, invokes the same verifier, rebuilds/readbacks current candidate and reads back exact event bytes inside the explicit transaction.
- `job-store.js:6932` and active entrypoint `:5946` — reads proposal-bound `approval.approved` rows ordered `created_at ASC,rowid ASC`; consumed during approval/transition validation.
- `execution-manager.js:989,1143,1224,1245` and `job-store.js:3149,3717,8006` — reads `execution.started` evidence by job/task/attempt or re-reads by event ID. `_assertExecutionBoundaryUnchanged()` checks durable execution-boundary evidence; `_spawnUnderAuthorizationWriteLock()` rechecks approval, proposal, lease ownership and the exact started event under a short writer transaction, appends spawn-authorization evidence, reads it back and commits before process spawn. The `execution.spawn_authorized` producer has no literal type-filtered reader among the 193 sites; the observed reader is event-ID readback.
- `job-store.js:7067` — reads `task.dispatched` evidence by job/task. Other approval, plan, task and lease authorization inputs live in their own tables and are outside this event-only query register.

The register identifies 19 parameterized event-type predicates separately from the 51 literal event-type predicates. The register deliberately leaves `authorizationPurpose` as `pending-semantic-reader-review` for all 193 rows. The bullets above are source-traced examples, not a complete authorization-purpose map for every callsite.

### Persistence and recovery readers

Source callers show event reads used for task lease acquisition/completion/expiry/quarantine, verified execution results and checkpoint/rejection evidence, execution-batch terminal/retry recovery, session message queue/delivery/receipt/ack/uncertain states, attempt retry/reconciliation, workflow terminalization, artifact/report lineage and delivery claims. Caller names and exact query predicates are retained per row in the JSON register. `job-liveness.js:121` reads the latest job event ordered `created_at DESC,rowid DESC` as an activity signal; its own comments explicitly state that lack of local activity is not proof a worker is dead. `langgraph-control-loop.js:35,54,73` reads event identity after recording quarantine observations/failures/status failures.

These reads support persistence/recovery traceability, but do not define a projection membership rule. The current register does not yet map every callsite to the state machine transition, event payload schema, or recovery invariant it serves.

## 4. Cross-table authorization coverage and explicit decisions

The event query register is only the `events`-table slice. The broader v0.12 projection inventory separately maps anti-replay and execution-authorization inputs across the active WorkflowStore and imported runtime. Keep those two projection domains distinct:

**Confirmed anti-replay inputs** (inventory v0.12 §3):

- `events` / `approval.approved` — approval event identity, ordered rows, maker/checker nonces and signed evidence; writer `WorkflowStore.approve()`; replay scan ordered `created_at ASC,rowid ASC`.
- `events` / `adaptive_goal.approval_policy_version_observed` — policy ID/version/hash, nonce and event identity; read ordered by `rowid ASC`; direct writer requires the caller-owned approval transaction.
- `events` / `adaptive_goal.action_intent_review_authorized` — exact candidate/plan/action/role/semantic binding, provider/root, reviewer subject/scope, signature, validity and one-use nonce; exact candidate lookup and global nonce uniqueness read; ingestion uses `BEGIN IMMEDIATE` and readback.
- `adaptive_goal_knowledge_verifications` — separate table, not generic `events`; nonce UNIQUE, exact signed snapshot/evidence/config binding, latest attestation order `created_at DESC,rowid DESC`.

**Confirmed execution-authorization inputs** (inventory v0.12 §4–§7) include: `jobs` and `workflow_runtime_state`; ordered proposal history and candidate/compiled-plan events; ordered `approvals` rows; `workflow_plans`; versioned policy definitions/attachments/events; referenced custom-role and custom-workflow versions; proposal role/profile bindings and validation profiles; `tasks`/`attempts`/`results`; `execution.started` and `execution.spawn_authorized`; artifact status and producer lineage; knowledge graph nodes/memberships/revisions/edges and signed verification; `task_leases` owner epochs; execution batches/items; source evidence; built-in workflow/task/role contracts; workspace-write/success contracts and normalized operation/scope inputs. The inventory records exact source entry points, selected fields, ordering and writer paths; it is the reference for non-event inputs, not this 193-row register.

**Explicit `approvals.raw_text` decision** (inventory v0.12 §6): exclude this column from the semantic authorization projection on current evidence. It is written and internally materialized by `SELECT *`, and copied as `rawText` into `approval.approved` payload; current authorization consumes `decision`/`proposal_hash` and signed evidence/nonces, not the text as a predicate. The active public workflow readback strips it. Do not claim it is never read or parsed. The replay reader does not recompute the nested event ID as a commitment to `rawText`. Re-open only if future authorization, replay or user-visible output gives the text semantic effect.

**Conditional/external state**: core `WorkflowStore` conditionally reads `provider_dispatch_intents`/`provider_runs` and actively reads M12 native runtime rows when present, even though the separate distributed scheduler/GitHub provider/admission modules are not imported by the configured RC.71 entrypoint. `task_checkpoints` has no active RC.71 reader in the inspected entrypoint. Whether external workers write provider/native state or share the DB remains unproven. The configured entrypoint constructs one WorkflowStore and one ExecutionManager, but source/import evidence does not establish installed argv, absence of legacy processes or all shared-DB users.

**Cross-database blocker**: the configured host still creates a separate `agg-trust-configuration.db` alongside WorkflowStore. This contradicts the v2 single-database design; #36 remains OPEN. No projection implementation is authorized until #32, #36 and #38 are individually accepted.

The query register’s `authorizationPurpose` remains `pending-semantic-reader-review` for all 193 rows. The cross-table inventory above identifies confirmed decision inputs and explicit `raw_text` disposition, but does not pretend every event SQL callsite has a complete state-machine/payload-consumer mapping. #32 therefore remains OPEN / Needs Evidence / Untriaged; #39 remains blocked by #32/#36/#38; #44 remains blocked by #43/#36.
## 5. Transaction and external-I/O boundaries

The register reports 116 callsites whose nearest direct caller method has transaction-control markers before and commit/rollback/release markers after the callsite; 73 with no complete such bracket observed in that direct caller; three policy high-water writer callsites whose runtime guard requires a caller-owned transaction; and one module-level schema bootstrap with no enclosing function. This is a source-layout/brace-balance heuristic, not an AST, control-flow or call-graph proof. A marker pair in one method does not prove every branch executes the matching end marker, and a helper may inherit an outer caller transaction not visible at its own callsite.

Explicitly traced examples:

- Reviewer attestation ingestion owns `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` in the same function as its insert and readback.
- Approval-policy high-water requires an already-open workflow transaction; the caller performs approval persistence and policy observation within the workflow approval transaction.
- Execution spawn performs slow filesystem identity/pinned-executable checks before opening the writer transaction. Inside the short transaction it rechecks immutable plan, approval, task and lease state, verifies the exact `execution.started` row, appends/readbacks spawn authorization, and commits. Process spawn follows commit. The traced block contains no `await` or network call.
- `recordEvent()` itself does not create or require a transaction. Its transaction boundary is inherited from each caller or autocommit.

This does not establish a global proof that every network operation is outside every SQLite writer transaction. Any future implementation must preserve the normative no-network-inside-writer-transaction rule and test it at public seams.

## 6. Source and deployment evidence boundary

The configured `package.json` entrypoint and plugin manifest select `server/index-v1.0.9-rc.71-versioned-approval-subsystem-20261030.js`. Its current source imports one `WorkflowStore` and one `ExecutionManager`; the inventory documents that no distributed scheduler/GitHub Actions provider is imported by this entrypoint. This is not evidence of installed process argv, process count, legacy entrypoints, an external worker, or all processes sharing the same DB. No current deployed reachability or production DB identity/custody evidence is established by this register.

Lexical scanner limits remain: aliases, destructuring, imported wrappers, generated/dynamic SQL, runtime-computed event types, non-SQL event stores, external worker/process reachability, historical event rows and schema/payload-version coverage. The 193 rows are the configured source inventory's event SQL callsites, not a complete database reader/writer inventory.

## 7. Validation and next acceptance work

- `node --test tests/test-agg-v2-event-callers.mjs tests/test-agg-v2-sql-mutation-audit.mjs` — 20/20 passed after query/caller/transaction classification changes (8 producer-register tests + 12 SQL audit/query-register tests); the SQL audit includes a disposable-root entrypoint-drift test proving only the changed entrypoint is re-extracted and six unchanged runtime files reuse preserved rows.
- Register v0.4 — 193 unique callsites, seven files, 189 readers / 3 writers / 1 schema-only bootstrap; all SQL and source SHA-256 fields present; one explicitly unresolved module-level caller context; `predicateColumns` contains lexical WHERE-clause references, not projected/ordered columns.

Remaining work for #32: manually resolve all 39 producer literals without literal type predicates, all 17 computed producers, all parameterized type predicates, imported wrappers and non-SQL stores; trace every query to payload/column consumers and state-machine/recovery semantics; complete authorization reader/writer coverage beyond `events`; inspect historical rows and deployed processes/shared-DB users; independently review the complete inventory. Do not turn this register into an event allowlist or projection manifest. Do not implement runtime projection until #32, #36 and #38 are individually accepted. #39 remains blocked by those gates; #44 remains blocked by #43 and #36.

No production database, trust/checkpoint/ledger/workflow/task/lease/approval/dispatch state was mutated. No host restart, checkpoint advance, package activation or release occurred. RC.23 archive and prior inventory/register artifacts remain unchanged.
