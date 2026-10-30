# Runalith RC.66 rollout dossier — 2026-10-29

**Decision: BLOCKED.** `canActivateNow=false`; `productionAuthorityGranted=false`. RC.66 is a local non-production successor only. No publication, installation, activation, live approval/dispatch, workflow/task mutation, trust-ledger write, external checkpoint transition, or host registry/process mutation occurred.

## Candidate and exact-byte identity

- Candidate: `dist/runalith-1.0.9-rc.66-dispatch-retry-fail-closed-20261029.mcpb`
- SHA-256: `8fdfae968c3dcf047fe8aedff6298e79d167f381403f5489eb73ae1d5ed53df7`
- Size: 952,051 bytes; 105 archive entries; 74 manifest/runtime tools.
- Entry point: `server/index-v1.0.9-rc.66.js`; SHA-256 `80f408b3dbbb5537821e9132624f7e524fb5ea87df6b33a3a6e48335fb530ba7`.
- Source snapshot SHA-256: `b9175b3cca6ad7d0c7fc131f9da76678dbad125dc81a54dfa7d59a0e22bdc3db`.
- Source-alignment report: `artifacts/adaptive-goal-graph/run-baseline-integrated-20261029T1535+0700/source-alignment-rc66-20261029T113943Z.json`, SHA-256 `6bfb25773cb36bf9ba2acc67c8a875c709416ba98ebfa540f64db930fcfcf5ee`.
- Exact archive/source byte alignment passes. The verifier explicitly reports `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT` and `BLOCKED_AUTHENTICATED_BUILD_RECEIPT_AND_INDEPENDENT_AUTHORITY_REQUIRED`. Byte identity is not builder provenance, independent release evidence, or production trust.
- RC.65 remains preserved at SHA-256 `50a92895a867119e03f20a5dcacdba0f06cde0027f730915828a51de2e60d985`; RC.23/26/63/64 and their failure evidence remain untouched. Tracked historical `server/index.js` remains pinned at `aa2b8f45f5a98817aac019f1659ff91f0bfc22da68cdbef1d9ad1ae6ceee8cb8`.

## Substantive engineering change

`src/runtime/job-store.js` now treats repeat dispatch of an `EXECUTING` job as an idempotency/lifecycle boundary. After normal dispatch guard validation, a retry returns the exact already-running task only when its job/role/status match and exactly one durable `started` attempt exists. Otherwise it fails closed with an explicit lifecycle-uncertain error. It does not create another dispatch event or silently manufacture an attempt after a crash between dispatch commit and attempt creation.

Regression coverage in `tests/test-phase5-recovery.js` proves: repeat dispatch returns the same task, creates no duplicate `task.dispatched` event, and preserves one active attempt; simulated missing active-attempt lineage causes fail-closed retry with no additional dispatch event. The original workflow terminal-failure atomicity suite also passed. The runtime entry point was versioned as RC.66 without modifying historical RC.65 or `server/index.js`.

The benchmark provenance successor is `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v118.json`, SHA-256 `13b9cea8e410420fcc5bac94c1d9aeddffec60d5f28f282f8871bf684fa8c803`. v117 remains byte-for-byte preserved at `f0dc190bdff5d4e3a28d94fa2dd38cfc9c9e24acd71a2918e74807cf142f4b6c`; fixture v108 remains unchanged at `c9dbc751818709abb07f7861febc07e0b1a4f38fbb4b4ddde043d7195a190cc2`. v118 records predecessor pins for changed sources. Historical README `PROVENANCE_SOURCE_HASH_MISMATCH` evidence remains preserved: historical pin `e956f53344de2963427ab07baa711f164d2c3bb28301ff606647702eb86e548e`, current README SHA-256 `c75048013f56412f8ea89122045348ed8b6f8983c28db01fb01647d677195854`.

## Validation

- `npm test`: PASS, exit 0 after RC.65/v118 source-pin transition and before the final package-version bump. After RC.66 metadata/versioning, targeted benchmark/source-alignment/rollout tests passed, `test:package-reproducibility` passed, `test-package-no-overwrite.js` passed, and the RC.66 package build ran extracted-package lifecycle, trust, recovery, graph E2E and MCP schema/smoke checks successfully.
- `node --test tests/test-adaptive-goal-benchmark.mjs tests/test-mcpb-source-alignment.mjs tests/test-runalith-rollout.mjs`: PASS, 34/34 after RC.66 versioning.
- `node tests/test-phase5-recovery.js` and `node --test tests/test-adaptive-goal-benchmark.mjs`: PASS; captured at `artifacts/adaptive-goal-graph/run-baseline-integrated-20261029T1535+0700/rc66-dispatch-retry-regressions-20261029T114102Z.log` with exit-code sidecar.
- `npm run test:phase2-security-regressions`: PASS, exit 0; captured at `phase2-security-rc66-20261029T113943Z.log`. The test preserves the Phase 2 source/archive byte-lineage guard and still reports the frozen 71-path contract unresolved: candidate has 105 entries; no canonical owner-signed path list exists. No trimming or inferred manifest.
- Source alignment: PASS exact archive-entry bytes, 105 entries, 74 tools; report and log above. This does not satisfy independent release authority.
- `npm run test:package-reproducibility`: PASS. `node tests/test-package-no-overwrite.js`: PASS.
- `npm run docs:check`: PASS, 171 Markdown files and 363 local links. `git diff --check`: PASS. CodeGraph synced after changes; status is up to date. Timestamped logs/exit sidecars are in the evidence directory.

## Fresh read-only preflight and stale operational evidence

- RC.66 preflight: `artifacts/adaptive-goal-graph/run-baseline-integrated-20261029T1535+0700/preflight-rc66-20261029T113857Z.json`, SHA-256 `11b126dcc310fe718e47bb80c807512663fffb0fbe15846c9b5e3f761ce4dd7f`; command exit 3, expected `BLOCKED`. `readOnly=true`, `canActivateNow=false`, `liveMutationPerformed=false`, `externalSecurityStoreMutationPerformed=false`, external checkpoint transition `NOT_REQUESTED`.
- The latest prior operational snapshot remains historical, not freshly authoritative: 86 jobs, 60 needing owner reconciliation, 7 awaiting dispatch, 19 awaiting proposal/approval, 736 task records, 61 running tasks without active lease rows/execution metadata, zero authoritative terminal dispositions. No authoritative workflow/task connector was available in this run to refresh owner evidence. Missing lease metadata does not prove worker death and never authorizes terminalization, retry, replay, process killing, or task mutation.
- Host trust snapshot is also historical. Production trust configuration and external checkpoint continuity are not verified here. No host trust/ledger/checkpoint state was mutated.

## Six blockers remain open

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — Phase 2 contract owner must supply the authoritative canonical 71-path manifest and required signature. Count-only contract is not a path list.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — controlled builder, independent verifier, and authorized release approver must supply and verify evidence bound to exact RC.66 bytes/source snapshot/rollback.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — authorized production trust administrator must provision and verify host-managed trust policies and distinct production identities.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — external checkpoint authority/host administrator must provide verifiable monotonic continuity through the approved host path.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — workflow/provider owners must reconcile active and ambiguous jobs authoritatively.
6. `RUNNING_TASKS_MUST_DRAIN` — task/provider owners must reconcile running tasks and supply authoritative terminal dispositions.

## Safe next action

Obtain the signed canonical 71-path manifest and independent release evidence in parallel with authorized host trust/checkpoint provisioning and workflow/task-owner reconciliation. Then rerun exact-source alignment, acceptance consistency, and read-only preflight against the exact candidate and rollback bytes. Do not activate, publish, approve, dispatch, mutate live state, or advance the external checkpoint while any blocker remains.

Machine-readable successor index and SHA-256 inventory are under `artifacts/adaptive-goal-graph/run-baseline-integrated-20261029T1535+0700/`. Prior RC.65 dossier/index/manifests remain preserved.
