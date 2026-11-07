# WS2 Control Contract Candidate V10.26 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.25 SHA-256 `fac2922f4d0adee28004b607f240c2f3a0d9b10282714e8cd6f46e6f17823121`  
**Purpose:** record WS1 independent verification of V10.24, WS2 Node compiler runtime evidence, exact CR-02 split disposition, and final independently verified WS8 package identity.

## 1. WS1 independent verification and bounded acceptance

WS1 A2A seq1254 (`479c31f0-93ed-431a-bc06-1a441720b39f`) independently verified WS2 V10.24:

- Rust mapping V2 fixture SHA `8bf47bc8f67c428cbe6a0d57bed43320ade5a518fa1fd9ef3a3f0917552523b2`.
- V2 validator SHA `d8da4407ba304a2d8aa135ca679ab8e4dddf62785d9a27f1590585bd0183b575`.
- V10.24 addendum SHA `486eded28425084d5834cf5b88e97e08453699ed570eda5d2c966ff6e3fc5ea5`.
- Exact V2 validator command PASS.
- Targeted Rust Store policy attachment test 1/1 PASS.
- Targeted Rust domain executor guard test 1/1 PASS.
- Targeted Control API auth-file principal test 1/1 PASS.

WS1 independently confirms these prove local transaction, evaluator guard and bearer principal-file authentication only. It explicitly confirms CR-02 remains `CHANGES_REQUESTED/BLOCKING`; source-level role-alias leak remains; no public `WorkflowPlanAttachment` DTO/live W1 plan-revision event; no caller CAS/idempotency/original replay receipt; bearer `ControlPrincipal` is not wired to `PolicyPlanContext.executor`; Store returns `UNRESOLVED` for execution evidence.

WS1's bounded disposition remains `ACCEPTED_WITH_BLOCKERS_FOR_TYPED_PLAN_ATTACHMENT_MAPPING; DRAFT_NOT_RATIFIED` for V1 fixture only. This accepts only exact explicit Control-task ID to W1 plan-task-ID mapping fixture coverage. No runtime adapter, policy event or executor identity is accepted or ratified.

## 2. Legacy Node custom-workflow compiler runtime evidence

WS2 added source-pinned Node test:

- Fixture `02-legacy-node-custom-workflow-adapter-v1.fixtures.json` SHA `71536215f07acc27f6d02f44404beeb8ba71cf3c2948c92ca8111814425b8a76`.
- Test `02-legacy-node-custom-workflow-adapter-v1-test.mjs` SHA `b7d35568e86c9e22f7e5ba0226192c1b61d2a541890ad8d5627ebc5b1392ffa0`.
- Command `node rust/workstreams/02-legacy-node-custom-workflow-adapter-v1-test.mjs` PASS.

It imports and runs actual `compileWorkflowPlan`, pins compiler/state-port/policy-consumer source hashes, proves child ID + custom role ID/version + dependency retention, demonstrates reorder leaves stable ID/metadata pairs intact while positional `custom-task-N` labels change, and rejects missing/duplicate child IDs.

This is local legacy compiler behavior only. It does not freeze a public legacy Node -> W1 `CompiledPlanV1` adapter. The legacy alias is semantically consumed by policy role predicates in Node and Rust; it is not globally display-only. V10.25 records exact source evidence and test limits.

## 3. CR-02 disposition by sub-item

| Sub-item | Verified local state | Remaining disposition |
|---|---|---|
| Typed plan mapping | WS1 accepted V1 fixture only; 2 positive +17 negative; W2 V2 oracle PASS | `ACCEPTED_WITH_BLOCKERS_FOR_TYPED_PLAN_ATTACHMENT_MAPPING; DRAFT_NOT_RATIFIED` |
| Legacy Node custom plan | Compiler runtime tested; child ID and explicit role metadata retained; positional role alias persists | Public W1 adapter `NOT_FROZEN / NOT_ACCEPTED` |
| Policy attachment | Node savepoint + Rust IMMEDIATE transaction persist immutable pre-approval attachments and events; targeted tests pass | Caller event identity, expected prior head/revision CAS, idempotent replay receipt and changed-body conflict `NOT_IMPLEMENTED / BLOCKING` |
| ExecutionManager identity | Deterministic plan metadata and evaluator guard exist; bearer principal-file auth exists independently | Trusted executor identity producer/receipt not wired into policy context; `NOT_WIRED / NOT_PROVEN / BLOCKING` |
| Overall CR-02 | No source successor approved; no owner assigned | `OPEN / CHANGES_REQUESTED / BLOCKING` |

Ownership: Project Owner must assign accountable WS2 implementation owner and approve source/module/worktree boundaries. Host Security/Execution owns the trusted executor identity issuer and durable receipt. WS2 may implement Control-side verification after explicit authorization. Until then, docs/isolated tests only.

## 4. Final WS8 R5.4.2 package identity independently verified

WS2 independently fetched the exact WS8 final A2A identity (seq1208), freshly extracted its archive and ran the included verifier:

- Manifest SHA-256: `a5e49ef7cdc9efe081d3970dbab08d650068e21ce645f9b9651017052cdcb371` (477 entries).
- Archive SHA-256: `f1bfe1215f611157392210cc6f2d1106f3d50f1e1c4f8694fdb1dd95741c86f0` (5,965,956 bytes).
- Verification report `/home/long/work/WS8-R5.4.2-EXPORT-20261103-VERIFICATION.md` SHA-256 `e81d11fd4e036cdc91c18b0f3d27948e8144cd93b6da923775e974c50e138481`.
- Fresh extraction: 477 manifest rows, 477 covered regular files, `EXPORT_INTEGRITY_PASS`; 478 regular files including manifest; zero symlinks.
- Changelog line 38 records WS5's exact R5.9 acceptance scope only; it does not imply broader R5.9/production acceptance.
- Active packaged WS2 snapshot validator V2 SHA `7ed09e6ef8f1b11f2dd733375bd2fc067872e331b3a49ab5cf6dddae091e1974` PASS. Legacy broken copied validator is explicitly historical/superseded.

This closes the R5.4.2 **package integrity** gate only. It does not ratify WS8 mapping, W2 CR-02, producer/consumer runtime, authority, route/auth, deployment or production cutover.

## 5. Test limits and repository boundary

`node tests/test-policy-contract.js` PASS. Broader `node tests/test-execution-plan-binding.js`, `node tests/test-workflow-plan-m2.js`, and `node tests/test-workflow-plan-structural-contract.js` did not reach assertions because global SQLite initialization failed with `ERR_SQLITE_ERROR: disk I/O error`; do not count them as passes. Targeted Rust commands and exact results are recorded in V10.25. Isolated Node compiler V1 and Rust mapping V2 tests passed separately.

No production Rust/Node source, API schema, database, service, deployment or migration file changed. No commit/push. All new WS2 files remain untracked evidence. WS8 export was not mutated by WS2.

**Overall status:** package integrity PASS; typed mapping fixture narrowly accepted with blockers; public legacy Node adapter NOT FROZEN; attachment revision/CAS/idempotency NOT IMPLEMENTED; authenticated ExecutionManager identity NOT WIRED; CR-02 OPEN/BLOCKING; contract `DRAFT_NOT_RATIFIED`; release readiness `NOT_PROVEN`.
