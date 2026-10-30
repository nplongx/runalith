# Runalith RC.59 rollout handoff — 2026-10-29

> **Superseded by RC.60.** The full suite found that `package.json.main` and `npm start` still pointed to RC.57 while the manifest/runtime entry point was RC.59. The extracted plugin test failed before cleanup, so the isolated package-reproducibility harness was stopped and its temporary test child was terminated; the no-overwrite run in that combined command was not reached. RC.60 fixes package entrypoint parity and advances the source fixture to v97 without modifying v95/v96.

## Candidate identity

- Candidate: `dist/runalith-1.0.9-rc.59-trust-reconciliation-acceptance-20261029.mcpb`
- Version / entrypoint: `1.0.9-rc.59` / `server/index-v1.0.9-rc.59.js`
- SHA-256: `d06324fe7de3db0b7af1c2a7443fd4ddfa91598058b8907b9a97d97a54ab4d63`
- Size: 949,502 bytes; 105 archive entries; 74 manifest/runtime tools; expanded size 4,069,542 bytes.
- Entrypoint SHA-256: `15d64416436160150a6c6d9fb50fda08fec5a1310a4d1aa678f53e2261bd839d`.
- Rollback baseline: `artifacts/runalith-1.0.9-rc.26-solo-graph-20261028.mcpb`, SHA-256 `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a`.
- RC.57, RC.58 and all prior candidate archives are retained. RC.58's failed benchmark pin check is documented; RC.59 advances fixture v95 to v96 rather than rewriting historical fixture bytes.

## Implemented and tested boundaries

- Knowledge search is explicitly read-only with respect to the trust ledger; snapshot GET and search tests assert no trust observation is appended implicitly.
- Production effective-host trust inspection rejects a caller-supplied fake `--proc-root`. Fixture process roots are available only through the imported test API.
- Reconciliation retains unbound nonterminal provider runs, flags unmatched lease IDs even when no active lease rows exist, scopes owner-epoch comparison to the exact matching lease, and avoids attributing an unscanned event payload to every task.
- The reusable acceptance consistency verifier checks archive integrity, manifest/entrypoint identity, candidate/rollback hashes, source alignment, preflight, dossier, remediation, evidence hashes/sizes, expected validation exit codes, all six blocker codes and live-observation freshness. It does not establish independent release authority.
- Fixture v96 records refreshed source pins for the RC.59 source tree. Fixture v95 remains SHA-256 `228d515e7f117b01401be5cbef89b843fc9299ecfb8d11625ec27d4a5c4a3a1e`; fixture v96 SHA-256 is `5e5839bc6f47201426eaf66906ad5c8ac24c55f32722c8f3f12ff64da449b7f0`.

## Candidate-bound reports

- Source alignment: `artifacts/adaptive-goal-graph/source-alignment-rc59-current-20261029.json` — SHA-256 `d99e8e2f749e6c7e2e542f1d3b933fffbf6c47f5de4225386a3eecffeeb44c9a`.
- Live snapshot envelope: `artifacts/adaptive-goal-graph/live-snapshot-rc59-current-20261029.json` — SHA-256 `eaa1cb96e1e0664f5d87314cd6a4e11ad812db25b980db4aaa19433f076b69e6`; the dossier input payload is `live-snapshot-payload-rc59-current-20261029.json`.
- Host trust diagnostic: `artifacts/adaptive-goal-graph/trust-diagnostic-rc59-current-20261029.json` — SHA-256 `09e158c6dd31e41c6620f436cf3b380d55efc96c8795a0fd157ef9d9c7a707dc`.
- Graph reconciliation v1: `artifacts/adaptive-goal-graph/live-reconciliation-v1-rc59-current-20261029.json` — SHA-256 `52427ce8ee82c03c36e66748d178a894bb181fb44ff09d1664d64e5c9d8590cd`.
- Lifecycle reconciliation v2: `artifacts/adaptive-goal-graph/live-reconciliation-v2-rc59-current-20261029.json` — SHA-256 `4572e5908bed01462e2719560f4162d3158930752abcd627289f0d2a572e0973`.
- Preflight: `artifacts/adaptive-goal-graph/rollout-preflight-rc59-current-20261029.json` — SHA-256 `9bc1682a89ae29abefae10dd45811c7f471eca661a55142c804c7325a0a61bce` (exit 3 expected).
- Readiness dossier: `artifacts/adaptive-goal-graph/agg-readiness-dossier-rc59-current-20261029.json` — SHA-256 `f98c27706eff021b9f1467ede99a8ce828c63b3ce5bd80fc585e03c20b930b1a` (exit 3 expected).
- Remediation plan: `artifacts/adaptive-goal-graph/agg-remediation-plan-rc59-current-20261029.json` — SHA-256 `bb445ca46bbb3edd457b6b07df8f4adff421aef54289552e4a7f36c8f29a10b6`; mutation authorization false.
- Acceptance index: `artifacts/adaptive-goal-graph/acceptance-evidence-rc59-20261029.json`; final digest is recorded in the validation handoff.

## Current state and decision

The host remains on RC.26. The current host-connected Goal/Idea snapshot has hash `80001cbece6811f7e3a0c187662393f05393ed11421767b23d76548c77c32bf3`, but it is `verified=false`, `eligibleForAttestation=false`, and has no evidence-manifest entries. Verifier/reviewer JSON configs are present-but-empty; provider IDs and legacy roots are absent. External checkpoint continuity is not verified.

The live DB remains 138 jobs, 1,277 tasks, 5,309 events, 908 results, 867 artifacts, 982 attempts, 119 approvals and zero active lease rows. Of 86 considered jobs, 60 require individual reconciliation; 7 await dispatch and 19 await proposal/approval. There are 61 running tasks without active lease rows. Four planner source hashes mismatch; 22 Plan Graph steps lack supporting evidence; 3 proposals lack authenticated current-snapshot binding; no Execution Graph proposals are persisted.

**Decision: `BLOCKED`, `canActivateNow=false`.** All six gates remain open:

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — owner-signed canonical 71-path manifest and candidate-bound builder receipt required; 105 archive entries do not redefine the contract.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — independent builder receipt, source/candidate verification, release approval and host-issued nonce required.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — authority-provisioned version-pinned verifier/reviewer configs, separate providers, disjoint canonical SPKI roots, effective runtime config and ledger verification required.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — independent signed checkpoint continuity, monotonicity, nonce consumption and atomic CAS evidence required.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — each executing job needs owner/provider/runtime disposition and event/attempt/result/artifact lineage.
6. `RUNNING_TASKS_MUST_DRAIN` — each running task needs owner/provider/run identity and attempt/result/artifact/lease/fencing evidence.

No live workflow mutation, trust-ledger write, checkpoint transition, production install/activation, retry, dispatch, terminalization, bulk drain, host restart, commit, push, reset or rebase was performed.
