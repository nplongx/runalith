# Workstream 2 — Implementation verification and A2A handoff

**Date:** 2026-11-03  
**Workstream:** WS2 — Workflow Control & Lifecycle  
**Status:** LOCAL IMPLEMENTATION TESTED; CROSS-WORKSTREAM CONTRACTS DRAFT / ACCEPTED-WITH-BLOCKERS; FULL ACCEPTANCE BLOCKED.

This is a WS2-owned evidence addendum. It records a verification pass and A2A decisions; it does not amend the reviewed V9 candidate, ratify a contract, assign an accountable owner, or authorize source/schema/database/deployment changes.

## 1. Authority and repository boundary

- The master plan permits documentation, isolated contract fixtures and tests; it explicitly does not authorize source, schema, database, manifest, service, deployment, migration or cutover changes.
- The WS2 brief records implementation ownership as UNASSIGNED. The master plan also requires file/module ownership and a safe worktree before shared source edits.
- Repository was already heavily dirty before this pass: branch `main`, HEAD `2f3599000d9a8dd8ff61b2651478eb27ceec88f3`; Rust crates/workstream artifacts were untracked and many unrelated root/Node files were modified. No reset, clean, revert, stash, ACL change or source edit was performed.
- Existing Rust package boundaries remain mixed: `runalith-domain` is shared with WS1; `runalith-store` remains schema-v20 compatibility storage, not an extracted Control-only database. No ownership or database boundary is inferred from passing tests.

## 2. Verification run

All commands below were run against the current shared working tree on 2026-11-03.

| Command | Result |
|---|---|
| `python3 rust/workstreams/02-compiled-plan-adapter-v1-test.py` | PASS — 2 positive + 17 negative fixture checks. Isolated mapping test; no production adapter/persistence. |
| `python3 rust/workstreams/02-control-journal-v1-test.py` | PASS — 2 exact event-hash serialization vectors (389 and 380 bytes), predecessor/sequence separation. Not a direct call into private Store hash code. |
| `cargo test --manifest-path rust/Cargo.toml -p runalith-control-api --locked --offline` | PASS — 26 library + 8 binary + 11 standalone-process = 45 tests. |
| `cargo test --manifest-path rust/Cargo.toml -p runalith-recovery --locked --offline` | PASS — 15 tests. |
| `cargo test --manifest-path rust/Cargo.toml -p runalith-domain --locked --offline` | PASS — 56 tests. Shared WS1/WS2 crate. |
| `cargo test --manifest-path rust/Cargo.toml -p runalith-store --locked --offline -- --test-threads=1` | PASS — 99 tests, including independent-connection races, idempotency, fencing, crash/reopen and UNKNOWN/recovery cases. Shared mixed compatibility Store. |
| `node --test tests/test-workflow-m4.js tests/test-task-lease-manager.js tests/test-task-lease-expiry-race.js tests/test-workflow-terminal-failure-atomicity.js tests/test-distributed-scheduler.js tests/test-phase5-recovery.js tests/test-phase5e-recovery.js tests/test-execution-lease-fencing.js` | PASS — 8 files, 8 passed, 0 failed. |
| `cargo fmt --manifest-path rust/Cargo.toml -p runalith-control-api -p runalith-recovery -p runalith-domain -p runalith-store -- --check` | PASS. |
| `cargo clippy --manifest-path rust/Cargo.toml -p runalith-control-api -p runalith-recovery -p runalith-domain -p runalith-store --all-targets --locked --offline -- -D warnings` | PASS. |
| `cargo check --manifest-path rust/Cargo.toml --workspace --locked --offline` | PASS. |
| `cargo test --manifest-path rust/Cargo.toml -p runalith-trust --locked --offline` | PASS — 70 tests, including the WS6 test-only SQLite nonce adapter's independent-connection/reopen test. WS6-owned crate; validation only. |
| `cargo fmt --manifest-path rust/Cargo.toml -p runalith-trust -- --check` | PASS. |
| `cargo clippy --manifest-path rust/Cargo.toml -p runalith-trust --all-targets --locked --offline -- -D warnings` | PASS. |

`cargo fmt --manifest-path rust/Cargo.toml --all -- --check` did **not** pass: rustfmt reported formatting differences in `rust/crates/runalith-artifacts/tests/provider_lineage_w4_integration.rs`, outside WS2 ownership. It was left untouched. The WS2-owned/shared Control package formatting check passed.

These results are TESTED local evidence, not proof of extracted Control DB ownership, production authority, independent three-deployable release, or production readiness.

## 3. A2A coordination

WS2 endpoint `437be3a9-103a-4a76-b214-a5925207df30` was present and ACTIVE. Registry showed eight active Workstream endpoints. WS2 inbound ACL allowed four senders; no ACL was modified. Messages used distinct correlation IDs and idempotency keys.

### Reviews received and processed

- **WS1, seq 399 / message `2b332014-ed9c-4bbd-bda2-ac589a13d22c`:** `REVIEW_ACCEPTED` for plan/task mapping only. WS1 confirmed outer `PlanDigestV1.value`, exact `workflow_plan.task_id`, one-to-one ordered Control task mapping, role/version/dependency/typed I/O preservation, and no positional aliasing. WS2 replied with message `2688635b-52c5-4c0d-a569-c66bf2ca77a2`; original was atomically ACKed. Contract stays DRAFT; live attachment persistence, lifecycle event and policy evaluation are NOT PROVEN.
- **WS3, seq 366 / message `63992839-ae15-4f43-9c04-ed189fb05ec6`:** V9 `ACCEPTED_WITH_BLOCKERS / NOT RATIFIED`, exact candidate SHA-256 `86365876b2677ce9f99aeb23df0a1b49bcaaeb271f744731883740002f3ceec5`; WS2 replied `e3043b9c-f072-4b24-aa48-a764626c494c`, original ACKed. Earlier V8 hash-mismatch notice seq 365 was ACKed separately.
- **WS3, seq 378 / message `e2471287-1efa-44ac-b929-e4441d8b2642`:** worker observation payload mapping review request. WS2 accepted the semantics with blockers and replied `e16c219a-c7cd-4c81-ae47-54556aa7cf15`; WS3 acknowledged in seq 403 and WS2 ACKed that message. Control inbox acceptance remains distinct from evidence verification; local ProcessStop is not provider terminality or cancellation settlement; no causation/order is fabricated.
- **WS3, seq 402 / message `d8693614-e915-4038-9d8c-f307d85d5044`:** proposed ACL/renewal/ProcessStop resolutions. WS2 replied `ae15fdac-519c-4ec0-b41f-6321c913e071`, original ACKed. WS3 recommends explicit top-level `acl_sha256` in a new `TaskClaimEnvelopeV4`, with v3 unchanged; stable caller-owned renewal ID/body and complete durable receipt; unsigned local ProcessStop observation plus separately approved host attestation.
- **WS3, seq 406 / message `6aa931c9-1868-4f6a-bca1-4c01b98b957a`:** forwarded W4 authority questions. WS2 replied `3a872c49-3a76-4a23-84f9-ef880ed0fc49`, original ACKed. WS2 requires attempt as a first-class claim/fence field; request digest is supplemental. Control receipt origin needs a separate approved authority/verifier; W4 owns immutable provider-account/config binding. WS2 did not message WS4 directly because that edge is not allowed by current ACL.
- **WS6, seq 377 / message `ca60855a-e04c-4546-99f0-932104a4ecc8`:** governance receipt consumer review accepted with blockers. WS2 replied `daacb80e-a928-4540-a0e2-68bb7e8f5df4`, original ACKed. WS6 owns nonce semantics; persistence owner/transaction boundary remains unresolved. Production signer, trust root, durable nonce adapter, Control projection/commit fence and D-01 remain blocked.
- **WS6, seq 407 / message `891941a3-7ef6-4aa0-8a32-36f1b870653a`:** test-only SQLite nonce-adapter addendum. Source hash `9d81f183158a3ffe6968bbf1fe4a973d64fc3fae67aac83b86fda259925df5ab` was verified in the shared tree; WS2 reran the 70-test WS6 crate suite, fmt and Clippy successfully. WS2 replied `ffade502-e877-482a-9b15-e4d179d1c494`, original ACKed. This is test-only evidence, not a production nonce adapter or persistence-owner decision.
- WS6 prior ACKs/review receipts seqs 379, 383, 389, 390 and 391 were ACKed. No ACK was interpreted as contract ratification.

### Outbound requests

- WS2 → WS1: `74f92b89-39df-4d0c-a38f-fc11ccd04794`, queued durable; WS1 returned seq 399.
- WS2 → WS6: `24fa1feb-4f05-49f5-b100-20d2324207ff`, queued durable; WS6 review/test addenda were received and processed.
- WS2 → WS7: `51ca01d8-2d35-4858-84ee-5d4cd9c4ac3a`, queued durable; no review response received. The current ACL register permits WS2 as a sender to WS7 but does not list WS7 as an allowed sender to WS2. Reciprocal WS7 review feedback is therefore BLOCKED without an authority-approved ACL change; none was made.
- WS2 → WS8: `07b1e72f-c547-4f0a-8925-5c0cb14ab86e`, queued durable; no review response received by the final inbox read.

`queued` means durable broker enqueue only. It does not prove the recipient read or accepted a request. Latest inbox read after sequence 407 returned no additional events.

## 4. WS2 contract proposal addendum (DRAFT)

Based on the WS3 V9 follow-up, WS2 proposes the following for a future immutable revision; this is not yet in the reviewed V9 candidate and is not ratified:

1. Put `acl_sha256` at the top level of the next TaskClaim payload and include it in the canonical signed claim bytes. Map to a versioned WS3 envelope (proposed V4); keep v3 unchanged and never infer that v3 signed a field absent from its typed DTO. Require exact positive/negative golden bytes before implementation.
2. `LeaseRenewalRequestV1` carries `schema_version`, `renewal_id`, `claim_id`, workflow/task/lease/worker, attempt, owner epoch and lease duration. Same logical heartbeat retry reuses persisted exact ID/body; a new heartbeat gets a new ID. Receipt binds receipt ID, renewal ID, claim ID, full subject, previous expiry, new expiry and persisted time. Current `ControlPlane::renew_lease` and `LeaseRenewal` do not implement this full durable retry/receipt contract.
3. Keep `ProcessStopReceiptV1` as unsigned local cgroup/process-tree evidence. A separate host-authenticated attestation requires its own approved producer identity, trust domain, audience, key/revocation/replay rules and exact lineage. Do not reuse Governance approval receipts as generic Control authority. Provider terminal proof remains separate.
4. Bind `attempt` explicitly in the Control claim and execution-fence subject. A hash of the complete immutable provider dispatch request is supplemental and must match W4's durable intent; it is not a substitute for the explicit Control attempt fence. W4 owns provider-account/configuration identity and durable intent fields.

## 5. Contract states and blockers

| Contract area | Status |
|---|---|
| W1 `CompiledPlanV1` to Control attachment mapping | REVIEW_ACCEPTED for mapping only; DRAFT, runtime attachment NOT PROVEN. |
| W3 `TaskClaimV1` / lease boundary | V9 ACCEPTED_WITH_BLOCKERS; DRAFT; proposed ACL V4 and renewal updates await exact vectors and owner review. |
| W3 result/observation payload mapping | REVIEW_ACCEPTED_WITH_BLOCKERS; DRAFT; no evidence-verification or settlement authority. |
| W6 `GovernanceApprovalReceiptV1` consumer | REVIEW_ACCEPTED_WITH_BLOCKERS; DRAFT; latest nonce adapter is test-only. |
| W7 evidence/recovery producer boundary | Review request queued; response not received; additionally reciprocal ACL edge is absent. |
| W8 common envelope/wire mapping | Review request queued; response not received. |
| Cancellation settlement / `RecoveryDispositionV1` / same-task retry / D-01 projection or DB split | BLOCKED by master-plan owner/authority decisions and exact contracts. |

Primary blockers:

- WS2 accountable owner and authority owner remain UNASSIGNED; WS1/WS3/WS6 accountable owners also remain unassigned in their briefs/reviews.
- Worker claim signer/issuer, audience, key lifecycle, authenticated caller/worker identity and exact signed claim bytes are not ratified/provisioned.
- Governance nonce durable persistence owner, Control projection identity/generation/high-water and revocation-to-commit fence are not approved.
- Process-stop attestation authority and W4 provider terminal proof are separate unresolved trust domains. Provider account/config identity must be frozen by W4.
- Cancellation settlement, terminal recovery disposition and cross-deployable retry/takeover remain blocked. No lease is released from ACK, timeout, local process exit or an unsigned receipt.
- D-01 database topology/projection/cutover remains blocked. The compatibility Store is not split.
- W7 reciprocal A2A review edge and WS8 consumer review remain outstanding.

## 6. Final acceptance

**LOCAL TEST ACCEPTANCE: PASS for the commands and packages listed in §2.**  
**CROSS-WORKSTREAM CONTRACT ACCEPTANCE: PARTIAL / DRAFT.**  
**WORKSTREAM 2 OVERALL: BLOCKED / NOT PROVEN.**

No source, schema, database, manifest, service or deployment file was changed. No commit was created. Continue only after Project Owner assigns accountable WS2 authority/owner, approves exact file/worktree boundaries and resolves the required contract/ACL decisions. Keep the three-deployable architecture; do not create an eighth service or split the compatibility Store.
