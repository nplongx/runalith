# WS2 continuation — current validation and A2A coordination

**Date:** 2026-11-04  
**Workstream:** WS2 — Workflow Control & Lifecycle  
**Status:** local implementation tests PASS; producer/consumer contracts remain DRAFT or accepted-with-limits; production authority and overall acceptance BLOCKED / NOT PROVEN.

This is a WS2-owned continuation evidence record. It does not amend earlier immutable candidates, ratify any contract, assign an accountable owner, or authorize production source/schema/database/manifest/service/deployment/migration/cutover changes.

## 1. Repository and ownership boundary

- Repository: `/home/long/work/chatgpt-adapter`; branch `main`; HEAD `2f3599000d9a8dd8ff61b2651478eb27ceec88f3` at discovery.
- The worktree was already heavily dirty, with modified root/Node files and untracked Rust crates, workstreams and evidence. Existing changes were preserved. No reset, clean, revert, stash, staging, commit or push occurred.
- `EIGHT_PART_PARALLEL_PLAN.md` assigns WS2 to Workflow Control & Lifecycle in deployable A. WS1 + WS2 remain one deployable; no eighth service is proposed.
- `workstreams/02-workflow-control-lifecycle.md` says implementation ownership is UNASSIGNED and limits this work package to documentation and isolated contract/test design. No production source, schema, SQL, manifest, service or deployment file was changed.
- `runalith-store` remains a mixed schema-v20 compatibility Store. No DB split, D-01/D-02 decision or cutover is inferred.

## 2. Current source facts

- `runalith-control-api::WorkerControlAuthority` declares the worker-facing ports: receive/verify claim, renew lease, publish result/provider result, deliver session message and reserve/complete execution fence.
- `ControlApi::from_store` leaves `worker_control` unset. `serve_command` does not inject a production implementation. `/v1/worker/*` therefore fails closed with HTTP 503; the test-only `StoreContractHarness` is not production authority.
- `Store::renew_task_lease` persists renewal under an IMMEDIATE transaction. Exact same renewal ID and request replay original expiry; changed content conflicts; stale/expired lease is fenced.
- Current `TaskLeaseRenewal` has renewal ID, workflow/task/lease/worker, attempt, owner epoch, previous/new expiry and persistence time. It has no `claim_id` or `receipt_id` and no production receipt authentication.
- `Store::inspect_task_attempt(workflow_id, task_id)` exposes a task-level historical snapshot, attempt ledger and a bounded event projection. There is no dedicated typed public lookup by `lease_id`, `renewal_id` or `fence_id`, no renewal receipt collection on the snapshot, and no history method/HTTP route on `WorkerControlAuthority`. Event projection is not a substitute for a typed durable receipt lookup.

## 3. Local validation run on current shared worktree

All commands below completed with the stated result. Cargo used an external target directory to avoid mutating the repository target tree.

| Command | Result |
|---|---|
| `python3 -B rust/workstreams/02-control-worker-boundary-v2.1-test.py` | PASS — 32 structural negative mutations; authority, crypto, V1 compatibility and settlement groups explicitly NOT RUN. |
| `python3 -B rust/workstreams/02-task-claim-command-request-v1.2-test.py` | PASS — 3 exact vectors (2 WS3 vectors + separate WS2 supplement) and 6 negative mutations. |
| `python3 -B rust/workstreams/02-control-route-mcp-digest-registry-v1-test.py` | PASS — 10 source pins, 8 Control routes/capabilities, 62 MCP names, 14 read-only Gateway allowlist entries and 14 distinct digest profiles. Inventory only. |
| `python3 -B rust/workstreams/02-compiled-plan-adapter-v2-test.py` | PASS — stable task ID/custom role mapping fixtures; explicitly confirms live policy compatibility still uses `TaskSpec.role=custom-task-N` rather than `custom_role_id`. W1-owned; no WS2 fix. |
| `python3 -B rust/workstreams/02-control-journal-v1-test.py` | PASS — 2 exact serialization/hash vectors; not a direct invocation of private Store hash code. |
| `python3 -B rust/workstreams/02-control-domain-error-diagnostics-v2.3.1-test.py` | PASS — exact 29-code bounded inventory and source-role distinctions. |
| `CARGO_TARGET_DIR=/dev/shm/ws2-main-validation-target CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path rust/Cargo.toml -p runalith-control-api -p runalith-recovery -p runalith-store --locked --offline --jobs 1 -- --test-threads=1` | PASS — Control API 50/50 (26 library + 8 binary + 11 standalone process + 5 route→Store); Recovery 15/15; Store 99/99; total 164/164, exit 0. |
| `CARGO_TARGET_DIR=/dev/shm/ws2-main-validation-target CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path rust/Cargo.toml -p runalith-domain --locked --offline --jobs 1 -- --test-threads=1` | PASS — Domain 62/62 (60 library + 2 integration), exit 0. Shared WS1/WS2 crate; validation only. |
| `CARGO_TARGET_DIR=/dev/shm/ws2-main-validation-target CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo check --manifest-path rust/Cargo.toml --workspace --locked --offline --jobs 1` | PASS, exit 0. |
| `cargo fmt --manifest-path rust/Cargo.toml -p runalith-control-api -p runalith-recovery -p runalith-store -- --check` | PASS, exit 0. |
| `CARGO_TARGET_DIR=/dev/shm/ws2-main-validation-target CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo clippy --manifest-path rust/Cargo.toml -p runalith-control-api -p runalith-recovery -p runalith-store --all-targets --locked --offline --jobs 1 -- -D warnings` | PASS, exit 0. |
| `node --test tests/test-workflow-m4.js tests/test-task-lease-manager.js tests/test-task-lease-expiry-race.js tests/test-workflow-terminal-failure-atomicity.js tests/test-distributed-scheduler.js tests/test-phase5-recovery.js tests/test-phase5e-recovery.js tests/test-execution-lease-fencing.js` | PASS — 8 files, 8 passed, 0 failed, exit 0. |

The combined Rust package test total includes the real temporary Store route→adapter test harness; this is not evidence that the production `WorkerControlAuthority` is wired. Crate tests and workspace check are not a deployable acceptance result.

## 4. Trust source drift — owner review required

Command:

```sh
python3 -B rust/workstreams/02-control-domain-error-diagnostics-v2.3.3-live-source-test.py
```

Result: **FAIL / source pins stale**, exit 1. The V2.3.3 fixture pins `approval_decision.rs` as `1ef7e3095f431a81e20d10e3a9974e38d860ef3d1c0e03692645113011e8181a`; live shared-worktree hash is `d6027c74b123680472f472dadad2d852c0a987da8504ef11286af324e14caac7`. The fixture also expects `lib.rs` `0b8f3bcf949e3f3eaa804aae6ccd9a3b45e60e2467cdbb48a9060c413f51218f`; live shared-worktree hash observed during this validation is `731b8ad9be33ec57ede34043849118f1ca68bbaeb4b38c6630ff19600aa31568`.

Other five V2.3.3 source pins matched at the observed check. The V2.3.2 predecessor validator fails closed on the known `governance_receipt.rs` drift; V2.3.3 wrapper expected that specific predecessor failure. WS6 separately reported a newer `lib.rs` hash `7dff6b9f3bbe6d6c7c7b64dbe5fc0a2c7bad6265d8c4f19dd25b43ba474d5847`, inconsistent with the shared-worktree `731b...` hash observed by WS2. This conflict remains unresolved; do not choose a pin by inference.

WS6 owns Trust source. WS2 requested an immutable V2.3.4 successor with exact V2.3.3 predecessor, complete changed-file list, hashes, line anchors and reproducible tests. WS2 did not edit WS6 files or repin V2.3.3. Historical V2.3.3 remains immutable and NOT fully validated against current live bytes.

## 5. A2A coordination

WS2 endpoint `437be3a9-103a-4a76-b214-a5925207df30` was ACTIVE. Endpoint discovery showed WS1/WS3/WS6/WS7/WS8 peers active. Messages below were durably queued; queueing does not prove recipient read or approval.

| Direction | Correlation / message | Status and disposition |
|---|---|---|
| WS2 → WS6, relayed WS3 trust request | `WS2-WS3-WS6-TRUST-AUTHORITY-RELAY-20261104` / `64eff80b-2f41-48ef-869e-6783040e866d` | queued/durable; WS6 replied seq1699 `DRAFT / BLOCKED / NOT RATIFIED`; WS2 replied `129a2070-ced1-42e8-9e62-9bb5a23f1bc3`, original ACKed. |
| WS6 → WS2, OpenSSL source correction | `WS6-WS2-V233-LIB-OPENSLL-CLASSIFICATION-DRIFT-20261104` / `066cc0ed-b3fa-4865-9e36-5aa3bffd00a1` | WS6 reported a narrowly scoped `lib.rs` classifier correction and requested a separate V2.3.4 successor; WS2 replied `a656e395-d57c-4ff6-baf4-c36febdd2cce`, original atomically ACKed. |
| WS2 → WS3, trust relay status | same correlation / `80555462-1292-4680-a217-4e15b04bdecd` | queued/durable; original WS3 seq1655 atomically ACKed. |
| WS2 → WS3, Worker Control boundary review | `WS2-WS3-CONTROL-AUTHORITY-RENEWAL-HISTORICAL-LOOKUP-20261104` / `10c15755-07d2-440e-9942-684ff4f26e30` | queued/durable; original WS3 seq1658 atomically ACKed; current schema/API limits and test evidence sent. |
| WS2 → WS3, follow-up on 164/164 and V2.3.3 drift | `WS2-WS3-V233-SOURCE-DRIFT-REVIEW-UPDATE-20261104` / `2b84e644-adb3-40dc-a18c-699ad039839b` | queued/durable; consumer review requested; response pending. |
| WS2 → WS1, compiled-plan role identity gap | `WS2-WS1-COMPILEDPLAN-ROLE-IDENTITY-REVIEW-20261104` / `124462fe-9856-4af0-89f8-74da95ed345d` | queued/durable; asks W1 for source disposition; response pending. |
| WS2 → WS7, Recovery evidence contract review | `WS2-WS7-RECOVERY-EVIDENCE-BOUNDARY-REVIEW-20261104` / `ef2077ca-5af2-46ca-a942-c03e6c1507a7` | queued/durable. Reciprocal WS7→WS2 ACL edge absent per existing endpoint state; no ACL change requested or made. |
| WS2 → WS8, error/route consumer review | `WS2-WS8-CONTROL-ERROR-ROUTE-CONSUMER-REVIEW-20261104` / `1218f06b-ca1b-4664-bdae-2c8da096dff5` | WS8 replied seq1702 `ACCEPTED_WITH_BLOCKERS / CONSUMER SEMANTICS ONLY`; WS2 replied `df9718e4-3e9c-4764-8382-2ab510d5de08`, original atomically ACKed. Public `McpServiceErrorV1` lacks `domain_code`/`cause_code`; end-to-end propagation remains PARTIAL / NOT PROVEN. |
| WS2 → WS6, post-review drift notice | `WS2-WS6-V2.3.3-POST-REVIEW-SOURCE-DRIFT-20261104` / `f4baead0-255d-490c-b2ce-e0f2e924957a` | queued/durable; asks for current successor evidence. |
| WS2 → WS6, source snapshot reconciliation | `WS2-WS6-V233-V234-SNAPSHOT-RECONCILIATION-20261104` / `05c49cb2-9a4d-4f0d-b779-47381096a338` | queued/durable; explicitly asks to reconcile `lib.rs` 7dff vs 731b and include `approval_decision.rs` drift. |

WS6 seq1652 provider evidence response was ACKed as `8ab14c84-eeed-4630-bb55-a217b4d1a027`. WS6's seq1699 authority response confirms Project Owner/Host Security decision authority and accountable ratifier are UNASSIGNED; no production roots, signer/key custodian, issuer/audience/scope, provider proof mode or nonce authority exist. D-01 atomic boundary unresolved, D-02 writer barrier unapproved, and v6→v7 DDL unauthorized. WS6 also explicitly prohibits assuming `GovernanceApprovalReceipt` can substitute for provider proof, worker fencing or process-stop attestation.

## 6. Contract status and unresolved dependencies

- `TaskClaimEnvelopeV4` / CommandRequestV1 mapping and `ExecutionFenceV2` / LeaseRenewalV1 projection: **DRAFT_NOT_RATIFIED**. V2.1 structural fixture checks do not exercise signed bytes, cryptographic verifier, real WorkerStore journal, or production API.
- WS3 accepted the prior receipt projection only with test-only limits. Current producer review for exact historical lookup/replay API remains pending.
- WS8 accepts the separation of outer Gateway error code from producer `domain_code` and `cause_code` only at reference-model consumer semantics. Current public MCP error DTO cannot transport those fields end-to-end.
- WS1 compiled-plan V2 fixture detects the positional `custom-task-N` role alias; W1 owns the implementation fix and runtime attachment remains NOT PROVEN.
- WS6 trust roots, signer/key custody, provider proof authority and nonce authority remain UNASSIGNED/BLOCKED; no cross-part trust contract ratified.
- WS7 evidence/attestation producer contract review remains queued; WS7 reciprocal ACL unavailable.
- Production Store-backed `WorkerControlAuthority`, authenticated claim issuer, typed historical lease/renewal lookup, cancellation settlement, recovery disposition and same-task retry remain BLOCKED.
- D-01/D-02, database split/migration, production keys, dispatch, deployment and cutover remain unauthorized or NOT PROVEN.

## 7. Final disposition

- Local Control/Recovery/Store and Domain tests, Node lifecycle tests, workspace check, scoped fmt and warning-denied Clippy: **TESTED / PASS** for the exact commands and worktree at run time.
- Source-pinned diagnostic V2.3.3 current live validation: **FAIL / BLOCKED on WS6-owned source drift**.
- A2A: relays and review requests sent with correlation/idempotency IDs; WS6 trust authority response and WS8 bounded consumer review received and processed; WS1/WS3/WS7 current responses pending.
- Contract ratification: **none** in this continuation.
- WS2 overall acceptance: **BLOCKED / NOT PROVEN**. Production/release readiness: **NOT PROVEN**.

No production source, schema, SQL, migration, API manifest, ACL, credential, database or deployment change was made. No commit/push was performed.
