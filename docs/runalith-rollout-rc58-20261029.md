# Runalith RC.58 rollout handoff — 2026-10-29

> **Superseded by RC.59.** Full validation of RC.58 exposed a stale v95 benchmark source pin (`package.json` bytes changed with the package-version successor). `npm test`, package reproducibility and no-overwrite did not pass on RC.58. The archive is preserved unchanged as an intermediate candidate; see [RC.59 rollout handoff](runalith-rollout-rc59-20261029.md) for the corrected v96 fixture and final validation.

## Candidate identity

- Candidate: `dist/runalith-1.0.9-rc.58-acceptance-reconciliation-hardening-20261029.mcpb`
- Version / entrypoint: `1.0.9-rc.58` / `server/index-v1.0.9-rc.58.js`
- SHA-256: `3e0ae97e4fcf953833ce15c126c4e75b5ef135756c30392b0f1269f9e58d6a36`
- Size: 949,275 bytes; 105 archive entries; 74 manifest/runtime tools; expanded size 4,069,542 bytes.
- Entrypoint SHA-256: `15d64416436160150a6c6d9fb50fda08fec5a1310a4d1aa678f53e2261bd839d`.
- Rollback baseline: `artifacts/runalith-1.0.9-rc.26-solo-graph-20261028.mcpb`, SHA-256 `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a`.
- RC.57 and older archives remain unchanged. Source/archive byte identity is exact, but `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT` remains the provenance status.

## Implementation changes in RC.58

1. Goal/Idea knowledge search no longer records trust configuration observations as a side effect. The state-changing trust-status operation remains explicit and is not used as a read-only diagnostic.
2. The production trust-config CLI cannot accept `--proc-root` to nominate a fake process tree. Tests use an injected fixture root only through the imported function API.
3. Reconciliation retains provider-run rows with missing task bindings, detects unmatched nonterminal provider-run lease IDs even if no active lease exists, and compares owner epochs only against the exact matching lease.
4. Event-correlation truncation is scoped to the tasks actually identified by the bounded scan; unattributed truncation remains a job-level flag.
5. `scripts/verify-agg-acceptance-consistency.mjs` validates candidate/archive bytes and cross-report identity/hash consistency, checks that all six authority gates remain open, and fails closed on stale live observations. It is not a signature/provenance authority.

## Candidate-bound reports

- Source alignment: `artifacts/adaptive-goal-graph/source-alignment-rc58-current-20261029.json` — SHA-256 `b82c589b02b4a58b55fd76eb7a84e27b7057a7edf36460de2d289fa24b76cef3`.
- Live snapshot envelope: `artifacts/adaptive-goal-graph/live-snapshot-rc58-current-20261029.json` — SHA-256 `05e62bcb90978611e0c0ef0f92bed0b047e93b3f73ac13877eae5a7e2e146818`. This is a current host-connected read-only snapshot response, not a signed attestation. The normalized payload used by the dossier is separately recorded as `artifacts/adaptive-goal-graph/live-snapshot-payload-rc58-current-20261029.json`.
- Host trust environment: `artifacts/adaptive-goal-graph/trust-diagnostic-rc58-current-20261029.json` — SHA-256 `001159b87758144cb4eaa49077dd00175a302a4a90236cfea8c098c9b11a1419`. PID and parent start times were pinned while inspecting `/proc`; no raw config values were emitted and no trust ledger was written.
- Schema-v1 reconciliation: `artifacts/adaptive-goal-graph/live-reconciliation-v1-rc58-current-20261029.json` — SHA-256 `98aa80a3044cbbfe8f6db634144dd5c6920dd0c932d080dabe43177c55a71aaa`.
- Schema-v2 lifecycle reconciliation: `artifacts/adaptive-goal-graph/live-reconciliation-v2-rc58-current-20261029.json` — SHA-256 `41caa267d889de1a879832edc1274a865431c50a55435197723cb498aa91d55e`.
- Preflight: `artifacts/adaptive-goal-graph/rollout-preflight-rc58-current-20261029.json` — SHA-256 `237579e3073262f11c2856f40bd8eae42390d3e4410bad5b903dedcc394eb71b` (expected exit 3).
- Readiness dossier: `artifacts/adaptive-goal-graph/agg-readiness-dossier-rc58-current-20261029.json` — SHA-256 `591aa84dab02510fae439ef83c9231cf11398b67d6825fa138f59969ed2336cd` (expected exit 3).
- Remediation plan: `artifacts/adaptive-goal-graph/agg-remediation-plan-rc58-current-20261029.json` — SHA-256 `f9bb592816b6b3be79656426c649777a97aae40e85ac2673aa7d48015cca70cc`.
- Validation limitation: RC.58 did not receive a final passing acceptance index because the benchmark fixture v95 source pin failed against the new package metadata. The failed logs are `/tmp/runalith-rc58-npm-test-20261029.log` (exit 1), `/tmp/runalith-rc58-reproducibility-20261029.log` (exit 1), and `/tmp/runalith-rc58-no-overwrite-20261029.log` (exit 1); the Phase 2 security suite passed. No failure was hidden or treated as a release pass.

## Read-only current state

The host-connected Goal/Idea snapshot for `runalith-agg-e2e-20261026-clean` has hash `80001cbece6811f7e3a0c187662393f05393ed11421767b23d76548c77c32bf3`, but `verified=false`, `eligibleForAttestation=false`, and an empty evidence manifest. Both effective verifier and reviewer JSON configs are present-but-empty; provider IDs and legacy roots are absent. The host still serves RC.26.

The paired live workflow DB reconciliation records 138 jobs, 1,277 tasks, 5,309 events, 908 results, 867 artifacts, 982 attempts, 119 approvals and no active lease rows. Of 86 jobs considered, 60 need individual reconciliation, 7 await dispatch and 19 await proposal/approval. There are 61 running tasks without active lease rows. Four planner source hashes mismatch; 22 Plan Graph steps lack supporting evidence; 3 proposals lack authenticated current-snapshot binding; 0 Execution Graph proposals are persisted.

No missing lease is treated as worker-death proof. No lifecycle transition, retry, dispatch, cancellation, terminalization, bulk drain, host restart, checkpoint advancement, trust-ledger mutation, install or activation was performed.

## Rollout decision: BLOCKED

`canActivateNow=false`. All six gates remain open:

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — owner-signed canonical 71-path manifest and candidate-bound builder receipt required; 105 entries do not redefine the contract.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — controlled builder receipt, independent source/candidate verification, release approval and host-issued nonce required.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — authority-provisioned versioned verifier/reviewer configs, distinct provider IDs, disjoint canonical SPKI roots, effective runtime and ledger verification required.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — independent signed checkpoint continuity, monotonicity, nonce consumption and atomic CAS evidence required.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — per-job owner/provider/runtime disposition and exact event/attempt/result/artifact lineage required.
6. `RUNNING_TASKS_MUST_DRAIN` — per-task owner/provider/run identity and matching attempt/result/artifact/lease/fencing evidence required.

Do not install or activate RC.58. Local tests, hashes and sandbox MCP calls do not close these gates.
