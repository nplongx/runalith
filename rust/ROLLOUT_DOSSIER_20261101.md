# RC.23 Rust engineering dossier — 2026-11-01

**Status: BLOCKED**

This dossier records one integrated engineering slice. It is not a release approval, cutover request, parity claim, or substitute for host-managed authority evidence.

## Repository integrity

- HEAD: `6b7bc90a8b16e50be9c7331c0b2f6361cc40b8f3`
- Branch: `main`
- Dirty entries: `314` before and after this slice
- Git index/history: untouched; no stage, commit, push, reset, clean, stash or revert
- Rust workspace: 13 crates, Store schema v8, MCP 36/75 Node tools

## Integrated implementation

1. **Session lifecycle and operations**
   - Added read-only, bounded `list_agent_sessions` and `inspect_agent_session` store APIs.
   - Session inspection runs in one deferred SQLite read transaction, requires OBSERVE permission, returns bounded chronological messages plus ACL records, and explicitly marks truncated history.
   - Runtime and MCP now expose `agent_session_list` and `agent_session_inspect`; MCP redacts message content.
   - ACL renewal events include previous grantor/expiry; exact duplicate grants remain idempotent.
   - Existing attach/takeover APIs are wired through runtime/MCP. Takeover remains limited to non-owner TAKEOVER grants on PAUSED/STALE/FAILED sessions.

2. **GitHub Actions provider**
   - Added opt-in HTTP transport backed by bounded curl execution.
   - Bearer token and JSON request body travel through curl config stdin, not process argv. No retries occur inside transport.
   - Runtime derives the durable intent marker from marker-free payload identity, inserts `inputs.runalith_intent_id`, then hashes/persists the final payload. This removes a self-referential idempotency digest.
   - Lookup requires complete pagination and exact repository/workflow/ref/event/intent marker/input commit/run attempt/status/conclusion identity.
   - An exact intent marker with conflicting immutable run identity yields UNKNOWN, never absence. Ambiguous POST outcomes are never replayed.
   - Default MCP host registers no provider adapter and cannot dispatch provider work.

3. **Recovery ordering**
   - Unresolved provider evidence now takes precedence over live session/lease evidence. A live session cannot mask an ambiguous remote provider effect.
   - Missing lease remains insufficient evidence of worker death.
   - Added E2E coverage from approved workflow and task lease through authenticated session binding, GitHub provider intent, persistence, repeated-call idempotency and unresolved recovery classification.

## Validation evidence

| Command | Result |
|---|---|
| `cargo fmt --all -- --check` | PASS, exit 0 |
| `cargo test --workspace --offline` | PASS, 202 tests, 0 failed |
| `cargo clippy --workspace --all-targets --offline -- -D warnings` | PASS, exit 0 |
| `npm run docs:check` | PASS, 241 Markdown files, 591 local links, Node MCP reference 75/75 |
| `git diff --check` | PASS, exit 0 |

Not established: independent CI execution, actionlint (binary unavailable), clean-clone build, Node regression rerun, production host startup, external provider dispatch, complete acceptance, or rollback proof. The Node source was not changed in this slice; no Node test claim is made.

Machine-readable evidence, including source SHA-256 values and exact current host/gate observations: [`evidence/engineering-slice-20261101.json`](evidence/engineering-slice-20261101.json).

## Current host and workflow state — read-only

- Active host remains Node.js `1.0.9-rc.71`; plugin reports enabled/ready.
- Workflow DB quick check `ok`; 0 foreign-key violations.
- 61 EXECUTING jobs; 62 RUNNING tasks; 75 STARTED attempts.
- All 62 RUNNING tasks lack `execution_session_id`, `openclaw_session_key`, `execution_status` and `execution_pid`.
- All 75 STARTED attempts lack `openclaw_run_id`.
- 0 task lease rows, 0 agent session rows, 0 M12 runtime rows.
- Missing lease/session metadata does **not** prove worker death. No task/job lifecycle mutation was performed; each remains unresolved pending authoritative owner/provider/runtime evidence.
- Host trust status is `BLOCKED` with `AGG_TRUST_CONFIG_NOT_CONFIGURED`.

## Candidate integrity and alignment

Candidate inspected read-only:

- `dist/runalith-1.0.9-rc.72-engineering-successor-v7-20261031.mcpb`
- SHA-256: `81c14838b18f787eb84ec497da35e3e956799d0c63e3c1b744d81f9eb701c01b`
- Archive integrity: verified
- Package: `1.0.9-rc.72`, 75 tools
- Entrypoint: Node `server/index-v1.0.9-rc.71-versioned-approval-subsystem-20261030.js`
- Source/archive alignment: `BLOCKED_CURRENT_SOURCE_IDENTITY_MISMATCH`; exact archive-entry byte match false
- Candidate smoke and rollback proof were not evaluated after alignment failure

No historical archive or fixture was rewritten. No new release archive was produced. Candidate preflight report: `/tmp/runalith-preflight-rust-e2e-20261101.json`, SHA-256 `21987e78f369c668afa132793d90fa9a76d7509f69ef0d68467424c8f95eaba7`.

## Six authority gates

| Gate | Current status | Evidence still required |
|---|---|---|
| `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` | OPEN | Phase 2 contract owner must provide signed canonical sorted 71-path manifest, controlled builder receipt bound to exact candidate/source commit/tree, and host-pinned contract-owner/builder roots. `/etc/runalith/phase2-custody-trust.json` absent. |
| `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` | OPEN | Independent builder provenance, independent candidate verification, separate release-authority approval, and host-issued nonce bound to exact candidate/source/rollback/policy/environment. Preflight skipped evaluation after source mismatch. |
| `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` | OPEN | Authorized trust administrator must provision five versioned domains with distinct providers/disjoint roots, rotation/revocation and host-observed ledger state. `AGG_TRUST_CONFIG_NOT_CONFIGURED`; `/etc/runalith/release-policy.json` absent. |
| `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` | OPEN | External checkpoint authority and host administrator must provide root-pinned adapter, independent monotonic store, fresh signed checkpoint/continuity and post-CAS receipts. `/etc/runalith/external-checkpoint-trust.json` and `/usr/local/libexec/runalith/external-checkpoint-adapter` absent. |
| `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` | OPEN | Each of 61 workflow owners plus provider/runtime operators must supply authoritative reconciliation and owner-approved lifecycle disposition. No bulk drain/reset/replay/terminalization performed. |
| `RUNNING_TASKS_MUST_DRAIN` | OPEN | For each of 62 running tasks and 75 started attempts, owners/providers/runtime operators must provide lease epoch, result/artifact lineage and owner-approved outcome. Missing lease alone is not proof of worker death. |

## Decision and non-actions

**Rollout remains BLOCKED. Node remains the active host. Rust rewrite and behavioral parity are not complete.**

No live workflow DB writes, trust writes, production migration, trust provisioning, checkpoint advance, dispatch, retry, replay, terminalization, drain, package install/publish, deployment, host restart/kill, or Git history/index operation was performed. No signatures, approvals, roots, receipts, provenance or external checkpoint evidence were fabricated.

## Part 1 follow-up — transactional coordinator slice

This addendum supersedes the earlier schema-v8 / 36-tool implementation snapshot above for current source status. It does not alter the historical host observations, candidate hash, or authority-gate decisions.

- Store schema remains v9; migration v8→v9 is additive. No production database was opened or migrated.
- `Store::coordinator_claim_next` and `WorkflowService::coordinator_claim_next` execute one atomic scheduling tick: current approval revalidation and injected worker identity authentication under `BEGIN IMMEDIATE`, dependency readiness, host-supplied global/per-workflow concurrency ceilings, oldest-workflow-update fairness, fenced lease/attempt ledger and event append. At most one task is claimed per call; no provider dispatch or worker invocation. Scheduling limits are not yet persisted/versioned policy packs.
- `Store::cancel_workflow` and `WorkflowService::cancel_workflow` require an injected host `WorkflowCancellationVerifier`, persist an idempotent cancellation request and retain running lease/attempt evidence. They do not kill workers or infer their state.
- Store tests cover coordinator fairness/concurrency/approval/worker-authentication/dependency projection and cancellation authorization/idempotency, including retention of a running lease after cancellation. Existing Node `workflow_coordinator_step` E2E was run as oracle, but no Node-to-Rust differential lifecycle suite exists.
- Part 1 remains **PARTIAL**: persisted policy packs/success contracts and scheduling policy, production host wiring for authenticated catalog identity, trusted skill resolver, continuous coordinator/local deterministic-step loop, task cancellation acknowledgement, authenticated/idempotent result-event inbox, synthesis/reporting, recovery disposition orchestration and isolated Control persistence/deployable are not implemented.

### Follow-up validation

| Command | Result |
|---|---|
| `cargo fmt --all -- --check` | PASS, exit 0 |
| `cargo test --workspace --offline` | PASS, 222 tests, 0 failed |
| `cargo clippy --workspace --all-targets --offline -- -D warnings` | PASS, exit 0 |
| `node --test --test-name-pattern='workflow_coordinator_step' tests/test-runalith-plugin.js` | PASS, 1 top-level test; existing Node coordinator/local MCP E2E assertions ran. This is Node oracle evidence, not Rust differential parity. |
| `npm run docs:check` | PASS, 245 Markdown files, 602 local links, Node MCP reference 75/75 |
| `git diff --check` | PASS, exit 0 |

Current repository identity: HEAD `6b7bc90a8b16e50be9c7331c0b2f6361cc40b8f3`, branch `main`, dirty entries `315`, staged entries `0`. No independent CI execution, clean-clone build, full differential suite, Control service process, production host startup or rollback proof was established. Source hashes are recorded in `evidence/engineering-slice-20261101.json`.


## Part 1 follow-up — coordinator worker authentication and current validation

- `CoordinatorWorkerVerifier` now authenticates the asserted coordinator worker inside the same `BEGIN IMMEDIATE` transaction used for approval revalidation, candidate selection and lease/attempt/event persistence. Empty canonical identity is rejected; forged worker identity and unavailable approval authority are negative-tested.
- Added `TaskResultProducerVerifier` as an explicit host-owned capability. Authenticated Store/Runtime ingestion invokes it inside the same writer transaction as task/attempt/lease validation and result persistence. MCP `workflow_record_task_result` fails closed if host verifier is absent; a negative test covers this boundary.
- Identical semantic result replay for the same attempt and lease owner now returns the persisted workflow projection without appending another result event; conflicting replay is rejected as lease-fenced. Tests cover both idempotency and conflicting replay, plus forged producer rejection before state mutation. This remains an authenticated service ingress, not a durable external inbox with event IDs, provenance envelope, ordering ledger or production authority implementation.
- Cancellation E2E verifies authenticated cancellation is idempotent and does not erase or revoke a running task lease/attempt; coordinator does not reclaim cancelled workflow work.
- MCP catalog create/update/preview now require `CatalogAuthorVerifier`, injected only by the host. Missing verifier and `mcp:unattributed` reject before mutation; successful catalog writes persist the verifier-returned principal. Tests cover missing verifier, sentinel rejection and authorized catalog CRUD/preview. No production host verifier or identity authority is provisioned.
- Earlier AGG custody slice corrected its replayed-weak-nonce fixture and passed the then-current workspace suite; the later schema-v18 validation below supersedes that result.
- Validation snapshot for the earlier coordinator-only slice: `cargo test --workspace --offline` passed 336 tests; formatting and targeted checks passed at that point. This snapshot is superseded by the schema-v18 validation below.
- The earlier workspace Clippy run already reported three Part 2 `clippy::field_reassign_with_default` warnings in `runalith-sandbox` test code (`src/cgroup.rs:269`, `src/lib.rs:1042`, `src/lib.rs:1076`). Current validation and the Part 2 worker heartbeat test failure are recorded below.
- Part 1 remains **PARTIAL**. Policy packs, success-contract snapshots, trusted-skill pins, authenticated result inbox and synthesis events now exist, but full Node predicate parity is incomplete; execution/artifact predicates without authoritative evidence remain UNRESOLVED. No continuous coordinator loop, deterministic local-step orchestration, task cancellation acknowledgement, authoritative cross-part recovery disposition, Node-to-Rust differential lifecycle suite or standalone Control API/database has been delivered. Producer envelopes do not carry a separate monotonic sequence; append-only workflow event sequence records durable ingestion order.

## Part 1 follow-up — policy, trusted skills, result inbox and synthesis (2026-11-02)

- This addendum supersedes earlier coordinator-only statements above for current schema, tool count, policy, skill, result-ingestion, synthesis and validation status. Earlier host observations and release-gate evidence remain historical.
- Current Store schema is **v18**. v13→v14 adds immutable exact trusted-skill pins per role version; v14→v15 adds local AGG checkpoint operation/event/fencing/quarantine ledgers; v15→v16 adds same-file dual-connection verification probes; v16→v17 adds Governance decision/event tables; v17→v18 adds nullable signed-receipt JSON to decision rows. A transaction-aware Store Governance decision backend now verifies, signs and persists receipts under the decision transaction through injected verifier/signer contracts; no production authority is wired. The previously populated v13→v17 fixture remains historical evidence only; no populated v18 migration fixture or production migration was run.
- Policy packs are immutable/versioned with SHA-256 content integrity, exact workflow attachments, append-only audit events and deterministic composition into success-contract snapshots. The composed contract is pinned to the immutable plan at approval and revalidated during claim/completion transactions. Unsupported execution/artifact predicates remain UNRESOLVED; no client projection can declare success.
- Trusted skills require host-owned `TrustedSkillResolver`. Exact role skill references resolve to canonical identity/version/content digest and are persisted against immutable role versions. Workflow create/update and plan compilation revalidate current trust pins; missing resolver, revocation, stale identity or substitution fails closed. No production resolver is wired.
- Result ingestion now requires immutable event ID, producer identity/provenance digest and payload digest. Producer authentication, payload binding, workflow/plan/task/attempt/lease fencing, immutable inbox insert, result/lifecycle update and event journal append share one IMMEDIATE transaction. Exact duplicate is idempotent; conflicting event/result replay is rejected.
- Synthesis reconstructs task state, attempt ledger, result inbox provenance, approval, policy/contract and source event-chain evidence. The deterministic report is retained as `workflow.synthesis_reported` in the append-only event journal. PASSED requires workflow COMPLETED and all persisted success predicates PASS; unsupported or missing evidence remains UNRESOLVED. MCP exposes `workflow_synthesize`.
- MCP currently registers 59 Rust tools; Node reference remains 75. This is a count only, not behavioral parity. Coordinator still claims at most one task per atomic tick and never dispatches. Recovery joins local task/attempt/provider/session/event evidence read-only but does not persist an authoritative cross-part recovery disposition. No independent Control API/process/database or executable Node-to-Rust differential lifecycle suite exists.
- External host wiring remains absent for `CatalogAuthorVerifier`, `TrustedSkillResolver`, `TaskResultProducerVerifier`, approval authority and worker identity. No production trust roots, approvals, receipts or authenticated identities were fabricated. Part 1 remains **PARTIAL**; rollout remains **BLOCKED**.

### Follow-up validation and evidence

- `cargo test -p runalith-store --offline`: PASS, 52/52.
- `cargo test -p runalith-runtime --offline`: PASS, 24/24.
- `cargo test -p runalith-mcp --offline`: PASS, 37/37 (33 library + 1 binary + 3 CLI integration).
- `cargo test -p runalith-sandbox --offline`: PASS, 36/36.
- `cargo test --workspace --offline` and isolated `cargo test -p runalith-worker --offline`: FAIL, `supervisor::tests::provider_reservation_error_stops_and_joins_lease_heartbeat` (`left: 1`, `right: 2`) in Part 2 `runalith-worker/src/supervisor.rs:1451`. No Part 2 implementation was modified.
- `cargo fmt --all -- --check`: FAIL, formatting in Part 2 `runalith-sandbox/src/cgroup.rs`; targeted Store/Runtime/MCP formatting check passes.
- `cargo clippy --workspace --lib --offline -- -D warnings`: PASS. `cargo clippy --workspace --all-targets --offline -- -D warnings`: FAIL, three `clippy::field_reassign_with_default` findings in Part 2 sandbox test targets.
- `npm run docs:check`: PASS, 247 Markdown files, 608 local links, Node MCP reference 75/75.
- Node-generated golden fixtures `workflow-policy-v1-node.json` and `success-contract-v1-node.json` verify policy snapshot/composition plus four persisted PASS predicates (`all_tasks_completed`, task status, role present/absent). A new regression persists all remaining Node predicate families and proves `workflow_id_equals`, `local_execution_only`, `execution_exit_code_equals` and artifact predicates remain UNRESOLVED rather than being rejected or falsely passed without authoritative typed evidence. Rust success-contract predicate IDs honor Node's 80-character slug bound while policy rule IDs retain their independent 39-character namespace bound.
- `concurrent_policy_updates_serialize_to_distinct_immutable_versions` exercises two independent SQLite Store connections; concurrent policy updates serialize to versions 2 and 3 with three append-only audit events.
- `node --test --test-name-pattern='workflow_coordinator_step|workflow_policy|workflow_synthesize|custom_role_workflow_catalog' tests/test-runalith-plugin.js`: PASS, one top-level local MCP E2E test. This is Node oracle coverage, not full differential parity.
- `git diff --check`, `git diff --cached --check`: PASS. HEAD remains `6b7bc90a8b16e50be9c7331c0b2f6361cc40b8f3`, branch `main`, 317 dirty entries, 0 staged entries. Rust core files remain untracked; no staging was performed.
- Machine-readable current evidence: `evidence/engineering-slice-20261102.json`, SHA-256 `a48b24639d5e24672eef2f08fb89c531806736d978b67bfda54531e64dc85364`. It records source SHA-256 values, exact validation outcomes, limitations and unchanged BLOCKED authority gates. No independent CI run, clean-clone build, production host startup, production verifier wiring, external checkpoint receipt or rollback proof was established.

## Part 1 follow-up — result replay authentication and recovery lineage (2026-11-02)

- Duplicate `workflow_result_inbox` event handling now invokes the host `TaskResultProducerVerifier` before acknowledging an existing event. A matching event ID/payload digest alone is insufficient: replay must re-establish producer identity, re-hash and match stored inbox payload bytes, verify the task result projection against its immutable attempt-result digest and task-result journal event, match the persisted provenance digest, match the current immutable plan digest, match the historical attempt's exact lease ID and canonical worker ID, find the exact corresponding inbox journal event/payload, and verify the complete workflow event chain. Changed payload/result/provenance, missing/tampered journal evidence or unavailable verifier rejects replay. The checks run inside the same `BEGIN IMMEDIATE` transaction; no task/result/event mutation occurs on replay.
- Regression coverage now proves verifier invocation on duplicate delivery, rejection when producer verification becomes unavailable, rejection when provenance changes, and continued idempotent acknowledgement when all bindings match.
- Recovery classification no longer treats `LeaseObservation::Absent` as authoritative if immutable attempt lineage lacks the exact lease ID. `WorkflowService` now sources the exact lease ID from the immutable historical attempt ledger for the matching attempt/owner epoch, rather than relying only on the cleared current-lease projection. Missing or inconsistent historical identity returns UNKNOWN.
- Recovery regression tests cover absent/blank lease identity. Runtime regressions confirm terminal task classification and ambiguous provider outcome behavior still work when exact historical lease identity is present.
- Focused validation: `cargo test -p runalith-recovery --offline` PASS 15/15; `cargo test -p runalith-store --offline` PASS 53/53; `cargo test -p runalith-runtime --offline` PASS 24/24; `cargo test -p runalith-mcp --offline` PASS 37/37; `cargo test -p runalith-sandbox --offline` PASS 41/41.
- Full workspace validation: `cargo test --workspace --offline` PASS 353 tests, 0 failed; `cargo fmt --all -- --check` PASS; `cargo clippy --workspace --lib --offline -- -D warnings` PASS; `cargo clippy --workspace --all-targets --offline -- -D warnings` PASS. The earlier worker heartbeat failure and Part 2 sandbox formatting/lint failures did not reproduce; no Part 2 source was modified.
- `npm run docs:check` PASS, 247 Markdown files, 608 local links, Node MCP reference 75/75.
- Node local MCP E2E command `node --test --test-name-pattern='workflow_coordinator_step|workflow_policy|workflow_synthesize|custom_role_workflow_catalog' tests/test-runalith-plugin.js` FAIL, one top-level test, at `tests/test-runalith-plugin.js:4639`: expected workspace-write receipt outcome `already_present`, actual `reconciled_after_restart`. This is a Node scoped-write/Part 2 test path; no Node or Part 2 source was modified. The prior handoff's PASS is superseded by this current failure. It is not Rust differential evidence.
- Part 1 remains **PARTIAL**. Full Node predicate parity, continuous coordinator loop/local-step execution, authoritative recovery disposition, independent Control API/process/database, full Node-to-Rust differential lifecycle suite and production verifier wiring remain incomplete. Six external authority gates remain OPEN; rollout remains **BLOCKED**.
- Updated machine-readable evidence: `evidence/engineering-slice-20261102.json`, SHA-256 `a48b24639d5e24672eef2f08fb89c531806736d978b67bfda54531e64dc85364`. HEAD/branch/index are not changed by this work; no stage, commit, deployment, production migration or live-state mutation was performed.


## Part 1 follow-up — unresolved predicate boundary and acceptance refresh (2026-11-02)

- Rust success-contract attachment no longer rejects Node-defined `workflow_id_equals`, `local_execution_only` or `execution_exit_code_equals` merely because Rust lacks the corresponding authoritative typed evidence. Evaluation keeps these plus artifact predicates `UNRESOLVED`; `workflow_id_equals` is specifically not compared against `job_*` workflow instance identity. This avoids both false FAIL from comparing different identity domains and false PASS.
- Node oracle fixture `success-contract-predicate-v1-node.json` was generated from the real `evaluateSuccessPredicate` export and records 15 scenarios across all 11 Node predicate types. It is reference evidence only; it does not establish Rust differential parity.
- Regression `unsupported_artifact_success_predicate_keeps_workflow_unresolved_not_completed` persists all seven unresolved families (`workflow_id_equals`, `local_execution_only`, `execution_exit_code_equals`, `artifact_exists`, `artifact_field_equals`, `artifact_field_includes`, `artifact_field_non_empty`) and asserts each is `UNRESOLVED`. It does not claim Node evaluator parity for artifact/execution evidence.
- Rust MCP handler count is 59 (Node reference 75). The CLI health assertion now tracks 59. Name counts remain non-semantic and require fresh full inventory before parity claims.
- `cargo test --workspace --offline`: PASS, 366 tests, 0 failed. `cargo test -p runalith-store --offline`: PASS, 65/65. `cargo test -p runalith-mcp --offline`: PASS, 38/38. `cargo clippy --workspace --all-targets --offline -- -D warnings`: PASS. `cargo check --workspace --offline`: PASS. `cargo fmt --all -- --check`: PASS. Scoped rustfmt check: PASS.
- `npm run docs:check`: PASS, 247 Markdown files and 608 local links. `git diff --check && git diff --cached --check`: PASS.
- Node scoped regression remains FAIL at `tests/test-runalith-plugin.js:4639`: expected `already_present`, actual `reconciled_after_restart`. No Node or Part 2 source changed.
- Current repository identity remains HEAD `6b7bc90a8b16e50be9c7331c0b2f6361cc40b8f3`, branch `main`, 317 dirty entries, 0 staged entries.
- Machine evidence: `evidence/engineering-slice-20261102.json`, SHA-256 `a48b24639d5e24672eef2f08fb89c531806736d978b67bfda54531e64dc85364`. Source SHA-256 map refreshed, including the Rust fixture-consumption test and MCP health assertion. Dossier is excluded from the source map to avoid circular hashing.

### Part 1 follow-up — predicate fixture guard and MCP inventory refresh (2026-11-02)

- Rust now consumes `success-contract-predicate-v1-node.json` in a fixture-integrity test. It asserts 15 unique scenarios, 11 predicate types and the seven explicitly unresolved families. This is not a Rust-vs-Node evaluator differential test and does not change the PARTIAL parity assessment.
- The live Rust MCP definition count is 59 (Node reference 75); CLI health assertion and README/parity/evidence records now use 59. No claim of name/schema/behavioral parity is made.
- `cargo test --workspace --offline -q`: 367 tests passed. Workspace Clippy, check, fmt, docs check (248 Markdown files/610 local links) and diff checks passed.
- Scoped Node test remains failed at `tests/test-runalith-plugin.js:4639`: expected `already_present`, actual `reconciled_after_restart`. Root cause is in Node `WorkspaceWriteCapabilityService`: `applyWrite` calls pending-intent recovery before same-request receipt lookup; after the failed receipt transaction releases intent ownership, immediate retry enters recovery path and is labelled `reconciled_after_restart`. Node/Part 2 source was not modified.
- Part 1 remains PARTIAL; rollout remains BLOCKED. Independent Control API, continuous coordinator, authoritative recovery disposition, full predicate/lifecycle differential, host trust wiring and migration proof remain open.
- Part 1 remains **PARTIAL**; rollout remains **BLOCKED**. Full Node predicate/differential parity, standalone Control API and independent persistence, continuous coordinator, authoritative recovery disposition, production host verifier wiring, and populated v17→v18 migration proof remain outstanding.

### Part 1 follow-up — transactional admission checkpoint (2026-11-02)

- Added `Store::admit_workflow` and `WorkflowService::admit_workflow`. Admission verifies exact current approval, immutable policy attachments and plan-bound success-contract integrity inside `BEGIN IMMEDIATE`; it appends one idempotent `workflow.admitted` event bound to plan digest, approval ID and exact policy pins.
- Repeated admission for the same plan/pins is idempotent. Missing approval authority fails before any event mutation. Existing claim path independently revalidates approval and policy/contract pins; admission is not a worker dispatch authorization.
- Regression `workflow_policy_versions_attach_exactly_and_pin_composed_contract_at_approval` now checks admission success, idempotency and missing-authority rollback.
- Focused Store test, Runtime tests, full workspace tests, all-target Clippy, workspace check, fmt and diff checks pass. Independent Control API, continuous scheduler, full differential/E2E, authoritative recovery disposition, production host wiring and historical migration proof remain open. Part 1 remains PARTIAL; rollout remains BLOCKED.
- Refreshed machine evidence: `evidence/engineering-slice-20261102.json`, SHA-256 `3824158c2819c178a4d008d2559faa5386a4f4ba7afeae1778911fbfc1f7830c`. Its source SHA-256 map covers the changed Store/runtime sources and synchronized docs; dossier is excluded to avoid circular hashing.
- Final evidence refresh: `evidence/engineering-slice-20261102.json`, SHA-256 `8447c9103d768cd95bbde8555492dd6656eeb9dac3ead0d0b19c1adb2d5b68ab`. Current workspace-wide `cargo fmt --all -- --check` now reports an unrelated rustfmt-only discrepancy in untracked `crates/runalith-protocol/src/mcp_service_v1.rs:107`. The file is outside this Part 1 change set and was left untouched. Scoped rustfmt checks for the modified Store/runtime sources and worker Rust sources pass.

### Part 1 follow-up — Control API, policy routes and continuous coordinator (2026-11-02)

- Added `runalith-control-api` as a Part 1 HTTP/JSON crate, independent of MCP and Part 2 dependencies. It opens only an existing Rust Store via `Store::open_existing`; no implicit create or migration. Host principal authentication and per-route capabilities are mandatory.
- Routes now cover custom role/workflow catalog read/write, exact-version workflow compilation and plan read, immutable policy create/update/read/attach, workflow proposal/read/events, approval, admission, success-contract read, cancellation, coordinator claim, authenticated result-envelope ingestion, synthesis and read-only recovery evidence. Catalog mutation/compile requires injected `TrustedSkillResolver`; approval, worker, result-producer and cancellation authority remain separately injected.
- HTTP mutations preserve underlying Store idempotency/conflict semantics, but there is no global persisted HTTP `Idempotency-Key` ledger; this remains an API acceptance gap.
- HTTP server bounds body/header sizes, socket timeouts, eight connection workers and 64 queued connections; plain HTTP binds loopback only, rejects duplicate/framing ambiguity and supports `serve_until` cooperative shutdown. TLS must terminate at a trusted local proxy.
- Added bounded `CoordinatorLoop`: max claims per tick, bounded interval, shutdown checks between claims, atomic Store claim, worker identity verifier and explicit `ExecutionWorker::accept_claim` handoff. It does not implement Part 2 execution/provider dispatch and never retries/replays an ambiguous handoff. Handoff failure leaves the durable lease unresolved for host reconciliation.
- `cargo test -p runalith-control-api --offline`: PASS, 11 tests. Includes real HTTP request, auth/capability denial, missing trust authority, no-create DB boundary, exact policy version parsing, persisted policy/workflow routes, graceful shutdown and one approved/admitted task claim with exact `attempt=1` and `owner_epoch=1` handoff.
- `cargo test --workspace --offline`: PASS, 388 tests, 0 failed. `cargo check --workspace --offline`: PASS. `cargo clippy --workspace --all-targets --offline -- -D warnings`: PASS. `cargo fmt --all -- --check`: PASS. Scoped rustfmt checks for API/runtime and the previously discrepant untracked protocol module: PASS. `npm run docs:check`: PASS, 248 Markdown files/610 local links; 75 Node MCP reference tools match docs. `git diff --check && git diff --cached --check`: PASS.
- The previous formatting discrepancy in untracked `crates/runalith-protocol/src/mcp_service_v1.rs:107` no longer reproduces; direct rustfmt check passes. This Part 1 task did not modify that protocol file.
- Node regression still FAILS at `tests/test-runalith-plugin.js:4639`: expected `already_present`, actual `reconciled_after_restart`. Ownership is Node/Part 2 `src/runtime/workspace-write-capability-service.js`, not Part 1. `applyWrite` runs pending-intent recovery before same-request receipt lookup; the failed receipt path calls `releaseIntentOwner`, clearing process identity, so immediate retry is treated as restart recovery. No Node/Part 2 source or oracle was modified.
- Migration inspection confirms an additive v8→v9 migration block exists for custom role/workflow catalog tables, compiled plans and catalog events. No populated historical v8 fixture or exact external v8 database snapshot was available; no populated v8→v9 compatibility claim is made. Existing populated v13→v18 and v17→v18 fixture tests remain the proven migration evidence.
- Part 1 remains **PARTIAL**: no standalone Control host binary/process, physical Control-owned schema/database extraction, production verifier composition, deterministic local-step orchestration, full Node differential lifecycle suite or authoritative cross-part recovery disposition. Rollout remains **BLOCKED**.
- Final machine evidence refreshed: `evidence/engineering-slice-20261102.json`, SHA-256 `77883f58d065af460864e83fd55b331bd5ece6087fc104bdeeb734043c2b5633`; 17 source hashes, 0 mismatches. Repository remains HEAD `6b7bc90a8b16e50be9c7331c0b2f6361cc40b8f3`, branch `main`, 317 dirty entries, 0 staged. No stage/commit/push/reset/clean/stash/revert or deployment action occurred.

### Part 1 follow-up — reconstructed populated v8 migration fixture (2026-11-02)

- Added `populated_schema_v8_migrates_catalog_ddl_without_losing_session_or_workflow_history`. It reconstructs the exact v8 schema boundary by removing only v9..v18 migration objects from a current-schema test database, then inserts real workflow/session/ACL/message rows before calling the explicit migration API.
- Test PASS: `cargo test -p runalith-store --offline populated_schema_v8_migrates_catalog_ddl_without_losing_session_or_workflow_history -- --nocapture` — 1 passed, 0 failed. Confirms v18 reached, one workflow and each v8 session/ACL/message row retained, exact row identities retained and workflow event-chain integrity valid.
- This is a reconstructed populated v8 fixture from the repository's migration DDL, not an externally sourced historical Node database, production migration, or rollback proof. No production DB was opened or modified.
- CodeGraph executable is present at `/home/long/.local/bin/codegraph` (v1.6.0); `codegraph status .` reports 643 files, 32,509 nodes, 169,463 edges and index up to date. `node spawnSync('codegraph',['--version'])` exits 0 in this shell. No sync was needed or run. Agent messaging still hits send preflight `spawnSync codegraph ENOENT`; message to worker-1 was not queued. No preflight bypass or fabricated sync evidence.

### Part 1 follow-up — persisted predicate differential slice and HTTP input validation (2026-11-02)

- Added `node_predicate_fixture_drives_persisted_rust_evaluation_for_supported_evidence`: drives Node oracle cases through persisted policy creation/attachment, approval, admission, two task claims and durable task results, then compares actual `evaluate_persisted_success_contract` dispositions/values with Node for the cases Rust can authoritatively evaluate. Seven authority-dependent families remain UNRESOLVED; three Node-negative references (unknown task, forbidden plan role, unknown artifact producer role) are rejected earlier by Rust policy attachment. These are explicit compatibility differences, not full parity.
- Hardened Control API Bearer parsing to accept case-insensitive HTTP auth schemes and reject empty/whitespace/control-containing credentials. `limit` query parsing now rejects duplicate, malformed and out-of-range values with HTTP 400 rather than silently falling back to a default.
- Validation: `cargo test -p runalith-store --offline` PASS 71/71; `cargo test -p runalith-control-api --offline` PASS 13/13; `cargo clippy -p runalith-store -p runalith-runtime -p runalith-control-api --all-targets --offline -- -D warnings` PASS; scoped rustfmt for Store/runtime/Control API PASS; `git diff --check && git diff --cached --check` PASS.
- Workspace-wide validation, Node lifecycle regression and full differential/E2E have not been rerun by this scoped change. Previously recorded Part 2/Part 3 failures and CodeGraph agent-message preflight remain unresolved. Rust subtree remains untracked in parent Git; no index mutation was performed.
- Part 1 remains **PARTIAL**; rollout remains **BLOCKED**. Standalone Control process/isolated DB, production host authority wiring, execution/artifact evidence contracts, recovery disposition, full lifecycle differential, external historical v8 fixture and cross-part acceptance remain open.

### Part 1 follow-up — persisted predicate differential and complete workspace validation (2026-11-02)

- Added `node_predicate_fixture_drives_persisted_rust_evaluation_for_supported_evidence`. It drives 12 applicable Node oracle cases through persisted policy attachment, approval, admission, two task claims and durable task results, then checks actual Store evaluator dispositions/values. Three negative references are rejected at Rust attachment time (unknown task, incompatible forbidden role, unknown artifact producer role); seven execution/catalog/artifact cases remain UNRESOLVED. This is partial fixture-driven differential coverage, not full parity.
- Ran the actual Node `evaluateSuccessPredicate` export against all fixture cases: `NODE_PREDICATE_ORACLE_PASS cases=15 types=11`.
- Control API now handles Bearer scheme case-insensitively and rejects empty/whitespace/control-containing credentials. Duplicate, malformed and out-of-range `limit` query parameters return HTTP 400 rather than silently defaulting.
- Targeted validation: `cargo test -p runalith-store --offline` PASS 71/71; `cargo test -p runalith-control-api --offline` PASS 13/13; scoped all-target Clippy PASS; scoped rustfmt PASS.
- Workspace validation: `cargo test --workspace --offline` PASS 403/403; `cargo check --workspace --offline` PASS; `cargo clippy --workspace --all-targets --offline -- -D warnings` PASS; `cargo fmt --all -- --check` PASS. `npm run docs:check` PASS, 248 Markdown files, 610 local links and 75 Node MCP reference tools. `git diff --check && git diff --cached --check` PASS.
- An initial workspace test attempt observed stale MCP CLI expected count 60 while the binary reported 61. The current shared `cli_health.rs` now expects 61 and the subsequent full workspace run passes. No Part 3 source/test was modified by this Part 1 work. `runalith-mcp --version` independently reports 61; old exact-name inventory counts must be regenerated before use.
- Repository remains HEAD `6b7bc90a8b16e50be9c7331c2b0f6361cc40b8f3`, branch `main`, 317 dirty entries, 0 staged; Rust subtree remains untracked in parent Git. No index/history operation occurred. Agent cross-part coordination remains blocked by CodeGraph send preflight `spawnSync codegraph ENOENT`; no message was queued and no bypass was attempted.
- Part 1 remains **PARTIAL**; rollout remains **BLOCKED**. Full Node lifecycle differential/E2E, three-part process/database ownership, production authority wiring, authoritative recovery disposition, external historical v8 fixture and rollback proof remain unestablished.
- Machine evidence refreshed: `evidence/engineering-slice-20261102.json`, SHA-256 `f8ac7a35014cff8312cf559d48480d82e35b94af1c3481ed9c94233e67314577`; source SHA-256 map refreshed. Dossier excluded from source map to avoid circular hashing.

### Part 1 follow-up — resumed acceptance and validation reconciliation (2026-11-02)

- Recovered pending validation session `45454`; no replacement batch was launched. The recorded `cargo test --workspace --offline -q` exited 1: workspace doctest for `runalith-agg` could not locate the `runalith_domain` rlib during the concurrent build. This is not a clean workspace PASS.
- The same batch recorded `cargo check --workspace --offline` and all-target Clippy exit 101, blocked by compilation errors in Part 3-owned `runalith-domain/src/artifact_contract.rs` (`Option<&Value>`/`&Value` mismatch and unsupported `const fn` string matching). `cargo fmt --all -- --check` exited 1 on formatting differences in that file and Part 3-owned `src/lib.rs`. These files were not modified to mask cross-part failures.
- Independent Part 1 validation subsequently passed: `cargo test -p runalith-control-api --offline` 11/11; `cargo test -p runalith-store --offline` 69/69; scoped rustfmt for Store, Runtime and Control API; `npm run docs:check` (248 Markdown files, 610 local links, 75 Node MCP reference tools); and `git diff --check && git diff --cached --check`.
- Reconstructed populated schema-v8 migration regression passed: `cargo test -p runalith-store --offline populated_schema_v8_migrates_catalog_ddl_without_losing_session_or_workflow_history -- --nocapture` (1/1). It reaches schema v18 and retains workflow/session/ACL/message history plus event-chain integrity. It is not an external historical Node DB, isolated v8→v9 fixture, production migration or rollback proof.
- Agent coordination remains unavailable. Local CodeGraph v1.6.0 is executable and reports its index current, but agent-runner preflight still reports `spawnSync codegraph ENOENT`; the attempted worker message was not queued. No preflight bypass or fabricated sync/coordination evidence.
- Current acceptance gaps remain: no standalone Control host process or independent Control-owned schema/database; no global HTTP idempotency ledger; no production host verifier composition; no deterministic local-step orchestration; no full Node predicate/lifecycle differential; no authoritative cross-part recovery disposition; no external historical migration/rollback proof. Node regression at `tests/test-runalith-plugin.js:4639` remains Part 2-owned and unchanged.
- Part 1 remains **PARTIAL**; rollout remains **BLOCKED**. No stage, commit, push, reset, clean, stash, revert, production DB/trust mutation, deployment, host restart, dispatch, replay, retry or terminalization was performed.

- Machine evidence refreshed: `evidence/engineering-slice-20261102.json`, SHA-256 `df1fd9369938120aa9f750253aa801e229929eb4b65d9072c99dcf57d46434f7`; 0 source hashes refreshed. Dossier and evidence artifact excluded from source hash map to avoid circular hashing.

- Final machine evidence SHA-256: `400fada571e6a9a51c27fc04e90e547e0b34e64008b55e53ef94662b870bfd8a`; source hash entries: 17. Evidence and dossier excluded from source map to avoid circular hashing.
