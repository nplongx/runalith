# Runalith RC.53 rollout decision — 2026-10-29

## Decision

**BLOCKED — do not install or activate.** RC.53 is the versioned successor to RC.52 after fixing a real benchmark provenance regression: fixture v93 correctly detected that the Phase 2 inventory harness had changed but its pinned source hash was stale. RC.53 advances to fixture v94 and keeps the prior fixture bytes unchanged. The inventory harness now selects the current source-aligned package first, verifies exact source/archive bytes, and reports the frozen 71-path count mismatch explicitly instead of failing merely because only historical candidates were searched.

Candidate: `dist/runalith-1.0.9-rc.53-phase2-inventory-acceptance-20261029.mcpb` (937,012 bytes; 103 archive entries; 74 MCP tools). SHA-256: `54826a658193f8b876756dd6cb1b6e1cd6a0693c4abe09a387e91b677f6b2a81`. Entrypoint: `server/index-v1.0.9-rc.53.js`. Runtime bytes intentionally remain identical to RC.47 because the runtime dispatch path did not change in this round; changes are in trust diagnostics, source-alignment, benchmark provenance and acceptance tooling.

## Technical changes

- Effective-host trust validation distinguishes source/version/provider/fingerprint mismatch and verifies cross-domain provider/root separation in the actual observed host process. Pair collisions are typed fail-closed blockers, not generic parse failures.
- Generated MCP reference content is stable across package version bumps while still checking the current 74-tool `tools/list` output. This removes the prior stale-version metadata churn.
- Source alignment binds `package-lock.json`, the MCP reference generator, versioned entrypoint and fixture lineage. The Phase 1 synthetic source tree includes these inputs.
- The Phase 2 candidate inventory regression now prefers the candidate whose version matches current `package.json`; it verifies exact archive inventory and keeps the 71-path count as a separate blocked contract. RC.53 has 103 entries, so this does not satisfy Phase 2.
- Fixture v94 supersedes v93 and pins the updated harness. v87–v93 remain preserved byte-for-byte; RC.47–RC.52 archives and RC.26 rollback baseline remain untouched.

## Candidate-bound evidence

- Source alignment: `artifacts/adaptive-goal-graph/source-alignment-rc53-final-handoff-20261029.json`, SHA-256 `2c6525cf2ff08f047206b324b8dc58ca197b6931c70493785969641ee00aad25`. It reports exact archive-entry byte identity but `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`.
- Preflight: `artifacts/adaptive-goal-graph/rollout-preflight-rc53-final-handoff-20261029.json`, SHA-256 `53118d5704900daa0d721ee6ff6fd34e6f97850a9bdc7e847402cc7c13f95c3e`, exit 3, `BLOCKED`, `canActivateNow=false`.
- Readiness dossier: `artifacts/adaptive-goal-graph/agg-readiness-dossier-rc53-final-handoff-20261029.json`, SHA-256 `610917d05789319d5252d064d7120641616a138fe46ac2c52c6cc1973bd1daa1`.
- Remediation plan: `artifacts/adaptive-goal-graph/agg-remediation-plan-rc53-final-handoff-20261029.json`, SHA-256 `b70d00a28ea3e4e46a8706008a862f0cc4e6361744d52ec7e731a59bcdfb447e`, `mutationAuthorized=false`.
- Machine-readable acceptance index: `artifacts/adaptive-goal-graph/acceptance-evidence-rc53-20261029.json`, SHA-256 `e286cd605215035eb9255045669864133836eacde097aee1d8f38d8a51488047`; records 20 commands, candidate/rollback identities, live observations and all six blockers.
- Graph reconciliation: `artifacts/adaptive-goal-graph/live-reconciliation-v1-rc53-rerun-20261029.json`, SHA-256 `9f3c7386b78b027e6f6cc3dc56dbd239472349249a4ca6cc9c4e6539b0e495bb`.
- Lifecycle reconciliation: `artifacts/adaptive-goal-graph/live-reconciliation-v2-rc53-rerun-20261029.json`, SHA-256 `98eb4c71635f18a9afc3775e5b9c9c05c45a199908b1e5f140496d1c974fb4e4`.
- Current snapshot readback: `artifacts/adaptive-goal-graph/live-snapshot-readback-rc53-20261029.json`, SHA-256 `5cf50965f52a9d8e36d342f421b35d40582fe340c8420983779ba11089d74b54`; full snapshot payload `artifacts/adaptive-goal-graph/live-snapshot-rc53-final-20261029.json`, SHA-256 `f86b037d1d22bd9e7ed68f65b8e85e9738c2613b28a719b4cea634fb9b6a0610`.
- Host trust environment diagnostic: `artifacts/adaptive-goal-graph/trust-diagnostic-rc53-rerun-20261029.json`, SHA-256 `0a8136eb80aa75a66e63852066074c89350b4c3c087e39824bfa383c69caf047`.
- Rollback baseline RC.26 SHA-256 remains `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a`.

## Current read-only findings

The current Goal/Idea snapshot hash remains `80001cbece6811f7e3a0c187662393f05393ed11421767b23d76548c77c32bf3`, with 7 nodes, 7 edges, 7 memberships, zero evidence-manifest entries, `verified=false`, and `eligibleForAttestation=false`. The latest graph reconciliation observes 86 jobs: 60 stale/executing candidates, 7 awaiting dispatch, 19 awaiting proposal/approval. The lifecycle reconciliation observes 61 running tasks without active lease rows. There are 4 historical planner source-hash mismatches, 22 Plan Graph steps missing supporting evidence, 3 proposals without authenticated snapshot binding and 0 persisted Execution Graph proposals. These are findings, not authorized repair instructions; missing leases do not prove worker death.

The host still runs RC.26. Verifier/reviewer JSON configuration variables are present but empty; provider and legacy-root variables are absent. The trust-status MCP operation was not called because it appends to the trust ledger; no external checkpoint was queried or changed.

Final validation: full `npm test` passed (exit 0); `npm run test:phase2-security-regressions` passed (exit 0); package no-overwrite and reproducibility passed (exit 0); MCP fast test passed 74/74; `npm run docs:check` passed with 156 Markdown files and 358 local links; `git diff --check` passed. Reproducibility verified two independent builds as bit-for-bit identical, with stable input SHA-256 `084b872e1e6b5011103b253d8a69449182cccbbe9c94b0f67b96e1878440aba0` and 103 ordered entries.

## Six open authority gates

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED`: custody/contract owner must provide the signed canonical 71-path manifest and candidate-bound builder receipt. The checked-in contract freezes only cardinality; no canonical path list is available. Do not trim RC.53 or fabricate the manifest.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`: controlled builder, independent verifier and release authority must provide authenticated provenance, exact-byte/source verification and approval bound to RC.53, rollback digest and host nonce.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`: host/security administrator must provision and verify the actual version-pinned verifier/reviewer configs, independent providers, disjoint canonical SPKI roots, rotation/revocation and host-loaded values. Use the packaged `scripts/validate-agg-trust-config.mjs --require-peer-config --effective-host-pid <PID> --effective-host-entrypoint <absolute-entrypoint>` against authority-issued files; local-only validation is insufficient.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`: independent checkpoint-store authority must supply signed checkpoint observation, continuity and CAS proof bound to candidate, rollback, config versions/fingerprints and nonce.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`: workflow owner/provider/runtime operators must verify each job outcome with event/attempt/result/artifact lineage and authorized per-record disposition.
6. `RUNNING_TASKS_MUST_DRAIN`: task owner/provider/runtime operators must establish provider run, runtime identity, attempt/result/artifact lineage and lease/fencing epoch for every running task.

No production package was installed or activated. No live plugin registry/config, workflow DB, trust ledger, external checkpoint or host process was changed. No job/task was retried, terminalized or dispatched; no commit, push, reset or rebase was performed.
