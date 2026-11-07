# AGG external checkpoint v2 — event query classification v0.4

**Status:** Versioned source-level semantic supplement to v0.3. It adds directly inspected consumer and invariant evidence for selected authorization, execution-boundary, lease, session-delivery, quarantine and liveness paths. It is not a normative event registry, accepted projection manifest, complete authorization map, deployment attestation, independent review, or issue-acceptance decision. V2-01 / #32 remains OPEN.

**Preserved inputs (unchanged):**

- Query register: `agg-external-checkpoint-v2-event-query-register-20261030-v0.4.json`, SHA-256 `a878fdd149503d0fa5054f33a4af7782cba1a432dd47f0cfb2751c2713993960`.
- Producer register: `agg-external-checkpoint-v2-record-event-caller-register-20261030-v0.1.json`.
- Prior classification: `agg-external-checkpoint-v2-event-query-classification-20261031-v0.3.md`.
- Cross-table inventory: `agg-external-checkpoint-v2-projection-inventory-20261030-v0.12.md`.

## 1. Reconciled source and register facts

Read-only reconciliation at HEAD `6b7bc90a8b16e50be9c7331c0b2f6361cc40b8f3` confirmed branch `main`, clean index (zero staged changes), 31 modified tracked files and 57 untracked paths. All existing dirty work was preserved. RC.23 archive SHA-256 remains `00804c9599454533a45418c7fe733a3ced85b07219dee71c02eb19bcc0dbdd3e`; v157 SHA-256 `a1959e08b793f5fc566af16f1f636dc6410286a2dcede1650828402c57629db6`; v158 SHA-256 `ab7c5b3e51f57875bbfb5f41ab0193c8788d0436646352d4ebeaa7ad0dab2cf9`. v158 source-pin verification read 187 pins, found zero mismatches, revision 140. RC.23 ZIP integrity passed. These are local source/archive integrity facts, not independent provenance or release authority.

The producer register schema is `callsites`, `literalEventTypes`, `computedProducerResolutions`, `directSqlEventWriters`; it has no top-level `entries`. Recomputed comparison against query register v0.4 confirms 72 distinct literal producer types, 51 distinct literal type predicates, 39 producer literals without a literal type-filtered predicate, and 18 query literals absent from the literal producer set. These deltas are not defects, allowlists, or projection decisions. The 189-reader SQL-shape distribution remains 68 event-ID identity/readbacks, 103 job-scoped reads, 5 existence checks, 4 latest-event reads, 3 row counts, 3 literal type-filtered reads, 2 nonce replay counts and 1 global scan/aggregate.

## 2. Directly inspected authorization and anti-replay consumers

| Query source | Result/payload use | Supported invariant and boundary |
|---|---|---|
| `src/runtime/adaptive-goal-approval-subsystem.js:310`, `assertFreshApprovalNonces()` | Loads `event_id`, `job_id`, `payload_json`; parses canonical JSON; reads `approvalBinding.signedEvidence.maker_attestation.nonce` and each decision nonce. | Rejects malformed/noncanonical persisted approval evidence and duplicate one-use maker/checker nonces across approval events. Historical approval rows without this AGG envelope are explicitly skipped for nonce semantics. The reusable signed policy nonce is deliberately not included in one-use decision replay set; policy version/hash has separate high-water protection. |
| `src/runtime/adaptive-goal-approval-subsystem.js:344-369`, `readApprovalPolicyHighWater()` | Parameterized event type is bound to `APPROVAL_POLICY_OBSERVED_EVENT`; `policy_id` is JSON-filtered; rows ordered by `rowid ASC`. Consumes schema version, policy ID/version/hash, nonce, observed timestamp and event ID. | Rejects malformed/noncanonical rows, invalid event identity, version reuse and non-contiguous policy advancement. This is workflow-ledger rollback/downgrade continuity, explicitly not host-managed trust authority. |
| `src/runtime/adaptive-goal-approval-subsystem.js:427-443`, `recordAdaptiveGoalApprovalPolicyHighWater()` | Reads existing row by event ID, direct-inserts event, then reads exact row back. | Requires `workflowDb.isTransaction === true`; caller-owned approval transaction binds policy observation to approval persistence. Exact payload/job/type readback before caller commit. |
| `src/runtime/adaptive-goal-reviewer-identity.js:119-191`, `assertAdaptiveGoalReviewerAttestation()` | Parameterized job/type lookup; consumes canonical attestation payload, exact candidate binding, provider/root/scope/decision, issued/expiry, nonce and signature. A second parameterized query counts uses of the same event type + nonce globally. | Requires exactly one candidate-bound attestation and exactly one durable nonce use; verifies trust root, Ed25519 signature and freshness. This assertion is a provider-signed reviewer statement; it does not itself grant approval or dispatch. |
| `src/runtime/adaptive-goal-reviewer-identity.js:239-324`, `ingestAdaptiveGoalReviewerAttestation()` | Under `BEGIN IMMEDIATE`, reads existing job/type rows, checks nonce count, inserts direct SQL event, invokes verifier, rebuilds current candidate, then exact event readback. | Rejects ambiguous/existing conflicting rows, nonce replay, stale candidate and lifecycle already advanced. Rollback on failure. Successful result explicitly reports `approvalGranted: false`, `dispatchStarted: false`, `executionAuthorized: false`. |
| `src/runtime/job-store.js:658-693`, `actionIntentBindingsFromCandidate()` | Reads candidate-created rows by job/type and ascending creation order; parses exact candidate payload; validates candidate/plan hashes, event identity and typed action-intent bindings; calls evidence-current verifier and reviewer attestation verifier. | Requires exactly one persisted candidate; refuses absent/ambiguous candidates and mismatched caller bindings. This is a dispatch/approval input reconstruction path, not merely candidate history display. |
| `src/runtime/job-store.js:712-720`, `assertActionIntentEvidenceCurrent()` | Reads `artifact.created` rows by job and `$.artifactId`; validates exact event identity, canonical payload and equality with source evidence artifact metadata. | Binds action-intent task input evidence to a currently active artifact and its exact creation-event lineage. Artifact table state and event evidence are both consumed. |
| `src/runtime/job-store.js:6932` and active entrypoint `:5946-5985` | Proposal-bound `approval.approved` rows; active entrypoint selects by job and `$.proposalHash`, requires exactly one row, parses canonical payload and verifies signed evidence against current candidate/source/plan and current policy high-water. | Approval is bound to exact current proposal and immutable execution plan; replay and replacement are rejected. This is one component of a broader cross-table authorization decision. |
| `src/runtime/job-store.js:7066-7077`, `dispatch()` | On idempotent retry while job is already EXECUTING, reads `task.dispatched` by job and `$.taskId`; compares exact task, role, description, event ID/payload and requires exactly one started attempt. | Refuses to manufacture a new attempt or replay dispatch when durable running task/attempt/event lineage is ambiguous. Approval and plan inputs are separately revalidated before this branch. |

## 3. Execution boundary and spawn authorization

Direct source inspection confirms the following chain:

1. `src/runtime/execution-manager.js:989-1009`, `_collectExistingExecutionFromExitMarker()`: reads `execution.started` by job/task/attempt; requires exactly one row; parses strict JSON; validates exact key set, task/session/attempt/command/tmux identity and canonical execution-boundary identity before collecting an exit marker.
2. `execution-manager.js:1143-1150`, `_assertExecutionBoundaryUnchanged()`: scans bounded recent `execution.started` rows, parses payloads and matches task/attempt; compares persisted boundary identity with the freshly revalidated filesystem/executable/environment boundary. Missing evidence blocks OS spawn.
3. `execution-manager.js:1157-1255`, `_spawnUnderAuthorizationWriteLock()`: slow filesystem and pinned-executable checks happen before `BEGIN IMMEDIATE`. Under the short writer transaction it rechecks immutable plan, task/session/attempt, optional batch claim, approval/proposal identity, active lease owner/epoch/attempt/expiry, and exactly one matching `execution.started` event. It appends `execution.spawn_authorized`, reads back exact event bytes, and commits. OS process spawn follows commit. The inspected transaction block contains no `await` or network call.
4. `execution.spawn_authorized` has no literal event-type-filtered reader in the 193 query sites. Its observed readback is by returned event ID at `execution-manager.js:1245`; absence from literal predicate set is explained for this callsite, not a projection exclusion decision.
5. `job-store.js:3149`, `3717` and `8006` add `execution.started` consumers in terminal execution-batch recovery, finish-execution reconciliation and artifact lineage validation. Their full payload/state invariants still need per-callsite closure.

This is source evidence for the inspected spawn path only. It does not prove all network I/O is outside all writer transactions or establish deployed process reachability.

## 4. Lease, result, session-delivery and quarantine invariants

### Task lease lifecycle

- `job-store.js:1723-1735`, lease acquisition: event-ID readback plus job/type/`$.leaseId` uniqueness query; compares exact lease/task/worker/owner epoch/attempt/state/expiry against durable lease and task rows before commit.
- `job-store.js:1858-1885`, lease completion of an already-terminal task: selects the three terminal execution types by task/attempt, requires exactly one, parses canonical payload, checks attempt row and exact terminal type/status/session/attempt lineage, then reuses `finishExecution()` verifier before settling lease.
- `job-store.js:1902-1912`, lease completion: reads exact event ID and matching lease event; compares worker/attempt/state against persisted lease.
- `job-store.js:2066-2079`, uncertain provider outcome: writes `task.lease.quarantined`, verifies exact event and durable FAILED lease/task state; marks reconciliation required rather than asserting remote completion.
- `job-store.js:2102-2116`, expiry: writes `task.lease.expired`, verifies exact event and lease/task state; task returns to pending only when parent job is not terminal, otherwise remains failed. Compare-and-set is fenced by exact worker/attempt.

These event reads corroborate transitions whose authoritative state also resides in `task_leases`, `tasks`, `attempts`, provider-dispatch rows and parent job state. Event-only projection cannot replace those tables.

### Verified execution results

`job-store.js:2391-2403` derives expected event type from verified result outcome (`task.execution.verified`, `.checkpointed` or `.rejected`), builds exact payload from task/lease/attempt/provider run/result ID/content hash/output commit/evidence hash, requires one matching lease-scoped event, and reads exact event ID. Later callsites at `:2406`, `:2436`, `:2455`, `:2663` consume terminal task, lease and artifact lineage. The full result-reconciliation transaction and all branch paths still require a dedicated pass; do not classify these events as interchangeable success records.

### Session message delivery

- `job-store.js:4691-4729`, `assertDurableSuccessfulSessionReceipt()`: scans delivery-start and receipt events for the job, strict-parses and canonical-checks payloads, selects exact message/attempt matches, requires one start and one receipt with deterministic IDs and exact session/recipient/attempt/idempotency lineage.
- `job-store.js:4770-4801`, ACK: scans `session.message_acked` rows and checks exact idempotent ACK; requires the durable successful receipt/start proof on both live and expired-lease paths before terminal ACK.
- `job-store.js:4813-4823`: appends ACK event, rereads all ACK rows for the message, requires one exact event and exact ACKED row/attempt/timestamp/cleared lease.
- `job-store.js:4864-4910`: uncertainty recovery scans canonical uncertainty events for exact message/attempt; preserves unknown external outcome and rejects mismatched or ambiguous state.

Session delivery state is jointly represented in `session_messages`, session permission/access state, and event lineage. Event history alone is not sufficient to authorize a send or ACK.

### Quarantine and liveness

- `langgraph-control-loop.js:22-40`, `:43-59`, `:62-78`: quarantine observation, collection-failure and status-failure events are recorded with `applied: false` and `reconciliationRequired: true`; each is read back by event ID and exact payload. They record untrusted/uncertain provider observations, not accepted execution results.
- `job-liveness.js:121-134`: latest event ordered `created_at DESC,rowid DESC` contributes only to last-activity timestamp alongside job/runtime/task/lease timestamps. No local event activity is not proof that a worker is dead; this read is liveness/observability, not authorization.
- `job-store.js:8641-8652`, stats/observability: event count and bounded recent event scan feed operational reporting; these are not authorization predicates.

### Execution-batch and attempt recovery

- `job-store.js:3148-3170`, terminal batch-item recovery: selects `execution.started` by job/task/attempt and also reads deterministic event ID; requires one exact canonical start event bound to batch/item claim, command, execution session and attempt row. It then re-enters the terminal-ledger verifier before copying terminal results. Terminal-shaped task columns alone are insufficient.
- `job-store.js:3311-3338`, batch terminalization: updates the batch with an attempt-fenced compare-and-set, emits computed `execution.batch.completed` or `execution.batch.failed`, checks exactly one matching batch/attempt terminal event and reads back aggregate plus terminal item states. This explains the literal query types absent from the literal producer set for these two outcomes: producer type is selected from validated `finalStatus`.
- Active entrypoint `:1765-1833`, `assertMandatoryBatchEvidence()`: reads batch creation, retry, terminal and workspace-fingerprint events by job/batch ID. It parses the payloads and delegates retry/terminal consistency to `assertExecutionBatchRetryLineage`; it also compares final batch/item rows with immutable plan command/cwd/timeout and successful task execution. Validation fingerprint must bind plan hash, workspace and exact task set.
- Active entrypoint `:2514-2522`: writes `execution.batch.workspace_fingerprint` and reads exact event ID/payload back. `:2525-2533` revalidates the current approval binding immediately before `ExecutionManager.executeBatch()` can claim/spawn child items.
- `job-store.js:5463-5473`, `beginAgentRetry()`: on stale prior attempt, updates the exact started attempt to failed and writes `attempt.failed`; exact event ID/job/type/payload readback follows. Then it advances session attempt, task state and inserts one new started attempt before writing and validating `task.retry_started` at `:5484-5500`.
- `job-store.js:6262-6281`, `completeActiveAttempt()`: refuses multiple active attempts, compare-and-sets the sole started row to completed, writes `attempt.completed`, and checks unique attempt-ID event plus exact persisted attempt state.
- `job-store.js:8571-8610`, `reconcileStaleAttempts()`: only times out an old started attempt after checking no active lease, no execution still owned, and no unresolved provider outcome. It writes/readbacks `attempt.timeout`. For active production E2E jobs it preserves the task as running and records `task.timeout_recoverable` for RecoveryManager; other cases fail the task and transition workflow. These branches are not interchangeable terminal outcomes.

The batch and attempt events corroborate durable state in `execution_batches`, `execution_batch_items`, `tasks`, `attempts`, `task_leases`, `results` and provider state. A projection omitting these tables or collapsing retry attempts would lose recovery/fencing semantics.

## 5. Producer/query mismatch resolution status

The 18 query literals absent from the literal producer set are partly explained by source evidence:

- `adaptive_goal.approval_policy_version_observed` and `adaptive_goal.action_intent_review_authorized` are the two separately inventoried direct SQL `INSERT` writers, not `recordEvent()` producers.
- `adaptive_goal.execution_plan_candidate_created` is a computed constant producer resolved in the active entrypoint (`server/...rc.71...js:3612`); its candidate consumer is `job-store.js:658-693` and active entrypoint candidate readers.
- `execution.batch.completed`, `execution.completed`, `execution.cancelled`, `execution.failed`, `job.completed`, `task.completed`, `task.failed`, `task.execution.checkpointed`, `task.execution.rejected`, `task.execution.verified`, `task.local_completed`, `task.local_failed`, `m12.specialist.completed` and `m12.specialist.failed` are represented by recorded computed outcome branches in `computedProducerResolutions`. The exact producer sites and branch notes are preserved in the producer register; module/deployment reachability remains a separate question.
- `job.proposal_refined` remains unmatched by the literal `recordEvent()` producer set in this comparison. Its reader is source-visible, but producer path/schema-version/historical origin is not resolved by this supplement.

The 39 producer literals without literal type-filtered predicates are not necessarily unread: job-scoped reads, event-ID readbacks, parameterized predicates, broad scans or non-event-table state may consume them. `execution.spawn_authorized` is one verified event-ID-readback example. This supplement does not resolve all 39 individually. Event types associated with recovery/maintenance, quarantine, provider dispatch, session lifecycle and workflow reconciliation still need explicit reader/payload/version mapping or a documented no-reader disposition backed by broader source and historical-row evidence.

The 17 computed producer callsites retain the producer register's resolution notes. Sixteen are bounded constants/branches; `WorkflowStore.transitionWorkflowPhase()` at `job-store.js:1384` remains an unbounded caller-supplied public event parameter. Internal observed values are not exhaustive and no allowlist is inferred. Optional `distributed-scheduler.js` and `provider-admission.js` remain outside configured RC.71 imports; native specialist external deployment reachability remains unknown.

## 6. Still unresolved; no acceptance claim

- `authorizationPurpose` remains `pending-semantic-reader-review` for all 193 query rows. No v0.4 JSON register row was silently relabelled.
- The 193 callsites are not all mapped individually to selected columns, parsed payload fields, full caller chain, writer, historical payload versions and exact state-machine invariant. This supplement closes only the explicitly listed source paths.
- The 39 unmatched producer literals are not all individually resolved; `job.proposal_refined` among the 18 unmatched query literals remains unresolved.
- Parameterized type bindings and arbitrary caller-supplied `transitionWorkflowPhase()` event values remain review requirements.
- Alias/destructuring/imported wrapper/generated/dynamic SQL and non-SQL event stores are not comprehensively covered. Historical event rows, schema migrations and payload-version coverage are not established.
- External workers, installed process argv/count, legacy entrypoints, shared database users, deployed reachability, production DB identity/custody and independent checkpoint authority remain unverified.
- `agg-trust-configuration.db` remains separate from WorkflowStore DB; #36 remains OPEN. No runtime projection until #32, #36 and #38 are individually accepted. #39 remains blocked by #32/#36/#38; #44 remains blocked by #43/#36.
- No projection implementation, accepted manifest, candidate successor MCPB, production-ready/release-ready claim or issue acceptance is produced by this supplement.

## 7. Validation

Read-only checks in this iteration:

- `git rev-parse HEAD`, `git status --short --branch`, tracked/index diff stats and `git remote -v`.
- SHA-256 verification of RC.23, v157 and v158; v158 187-pin check returned zero mismatches and revision 140.
- `unzip -tq dist/runalith-1.0.9-rc.23-actionable-source-mismatch-recovery-20261028.mcpb` passed.
- Parsed producer/query JSON and independently recomputed producer/query literal-set deltas and reader category/file counts.
- Direct source inspection of approval subsystem, reviewer identity, execution manager, job store, liveness, control loop and configured RC.71 entrypoint at cited ranges.

No tests were run in this iteration. No runtime code or register builder was changed. No production state, issue status, package, archive or Git state was mutated. The supplement itself requires review and hash capture before external citation.
