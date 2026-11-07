# WS2 Control Contract Candidate V10.27 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.26 SHA-256 `f4776a8533105cba69a36b70db7bb931604532535850e2372e48456906cd0380`  
**Purpose:** record WS1 independent review of the V10.25 legacy Node test/addendum, exact package verification, and current CR-02 closure state.

## 1. WS1 independently verified V10.25

WS1 A2A seq1266 (`74fbaac9-fe5f-4471-abaf-aee018fac650`) independently recomputed exact hashes:

- Node fixture `02-legacy-node-custom-workflow-adapter-v1.fixtures.json`: `71536215f07acc27f6d02f44404beeb8ba71cf3c2948c92ca8111814425b8a76`.
- Node source-pinned test `02-legacy-node-custom-workflow-adapter-v1-test.mjs`: `b7d35568e86c9e22f7e5ba0226192c1b61d2a541890ad8d5627ebc5b1392ffa0`.
- V10.25 addendum: `fac2922f4d0adee28004b607f240c2f3a0d9b10282714e8cd6f46e6f17823121`.

WS1 ran both:

- `node rust/workstreams/02-legacy-node-custom-workflow-adapter-v1-test.mjs`
- `node --test rust/workstreams/02-legacy-node-custom-workflow-adapter-v1-test.mjs`

Both PASS (1 test). WS1 independently confirmed stable child ID/role metadata/dependencies, alias-only renumbering under reorder, missing/duplicate ID rejection, and that policy consumes the alias. WS1 also reran `node tests/test-policy-contract.js` (PASS), targeted Rust Store policy attachment (1/1 PASS), Rust domain executor guard (1/1 PASS), and Control API principal-file authentication (1/1 PASS).

WS1 confirms V10.25 accurately preserves scope and that no source changes are approved. The earlier Node tests that failed during SQLite initialization remain environment startup failures, not assertion results. At WS1 inspection, root filesystem remained 99% utilized with 4.8 GB free; no unrelated files were cleaned or deleted.

## 2. Confirmed bounded disposition

- Typed plan mapping V1 fixture only: `ACCEPTED_WITH_BLOCKERS_FOR_TYPED_PLAN_ATTACHMENT_MAPPING; DRAFT_NOT_RATIFIED`.
- Legacy Node compiler: local behavior tested; public W1 `CompiledPlanV1` adapter is not frozen/accepted.
- Policy attachment: local Node savepoint and Rust IMMEDIATE transaction exist and are tested; cross-part revision/CAS/caller-idempotency/replay-receipt semantics remain absent.
- ExecutionManager: immutable plan metadata guard exists; authenticated executor identity producer/receipt is not connected to Control policy context; status `NOT_WIRED / NOT_PROVEN`.
- Overall CR-02: `OPEN / CHANGES_REQUESTED / BLOCKING`.

The positional `custom-task-N` role remains consumed by policy compatibility/evaluation code in Node and Rust. A future approved source change must add a stable typed role identity and migrate consumers; parsing ordinals or treating array position as identity is not acceptable.

## 3. WS8 R5.4.2 archive integrity

Final package identity independently verified by WS2 (fresh extraction + included verifier):

- `MANIFEST.sha256`: `a5e49ef7cdc9efe081d3970dbab08d650068e21ce645f9b9651017052cdcb371`, 477 entries.
- `WS8-R5.4.2-EXPORT-20261103.tar.gz`: `f1bfe1215f611157392210cc6f2d1106f3d50f1e1c4f8694fdb1dd95741c86f0`, 5,965,956 bytes.
- Sibling verification report: `e81d11fd4e036cdc91c18b0f3d27948e8144cd93b6da923775e974c50e138481`.
- Fresh extracted verifier: `EXPORT_INTEGRITY_PASS`, 477/477 manifest rows and covered files; 478 regular files including manifest; zero symlinks.

This closes package integrity only, not contract ratification, service authority, route/auth, runtime producer-consumer, deployment or production readiness.

## 4. Next ownership actions

1. Project Owner assigns accountable WS2 implementation owner and authorizes precise source/module/worktree scope.
2. Host Security/Execution owns trusted ExecutionManager identity issuer, audience/subject/attempt-bound durable receipt, expiry/revocation and replay controls.
3. WS2 may then implement Control-side stable role/task binding, revision-CAS attachment event, and receipt verification under approved authority.
4. WS1/WS2 maintain fixture-only acceptance separately from runtime acceptance. No production changes until owners and contracts are ratified.

No production Rust/Node source, schema, database, service, deployment or migration file changed. No commit or push. WS2 evidence remains untracked. WS8-owned export was not mutated by WS2.

**Overall:** R5.4.2 package integrity `PASS`; V1 typed mapping fixture narrowly accepted with blockers; public legacy adapter `NOT_FROZEN`; cross-part policy revision/CAS/idempotency `NOT_IMPLEMENTED`; authenticated ExecutionManager source `NOT_WIRED`; CR-02 `OPEN/BLOCKING`; contract `DRAFT_NOT_RATIFIED`; release readiness `NOT_PROVEN`.
