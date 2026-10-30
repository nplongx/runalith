# Runalith RC.50 rollout decision — 2026-10-29

## Decision

**BLOCKED — do not install or activate.** RC.50 integrates typed trust-preflight diagnostics for effective host verifier/reviewer configuration and extends source-alignment inputs to include the package lockfile and complete versioned fixture/runtime inventory. It does not manufacture trust, release provenance, Phase 2 custody, or workflow lifecycle authority.

Candidate: `dist/runalith-1.0.9-rc.50-trust-preflight-source-alignment-20261029.mcpb` (937,012 bytes; 103 archive entries; 74 registered MCP tools). Direct SHA-256: `90161f161e111d1d21ef5709eb0dd5b04146dbac3b10a0071b858a43449abb9d`. The versioned runtime entrypoint is `server/index-v1.0.9-rc.50.js`; its byte identity with RC.47 is intentional because this round changes operator trust diagnostics and source-alignment/acceptance tooling, not runtime dispatch behavior.

Source alignment passes exact archive-entry byte comparison, but the state remains `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`. Local byte alignment is not authenticated builder provenance or independent release approval.

## Engineering delta

- `scripts/validate-agg-trust-config.mjs` emits typed fail-closed results for verifier/reviewer provider collisions, canonical SPKI root collisions, unavailable peer configuration, effective host source/version/provider/fingerprint mismatch, and effective cross-domain trust-root collisions. Root/provider collisions are reported as `BLOCKED` (exit 3), not generic input errors.
- `tests/test-adaptive-goal-trust-configuration.mjs` covers offline pair collision and actual effective-host pair collision separately, plus wrong version/provider/fingerprint. The validator still does not claim trust-ledger high-water or external checkpoint continuity.
- `scripts/verify-mcpb-source-alignment.mjs` now binds `package-lock.json` and the current versioned fixture/entrypoint inventory. Its Phase 1 synthetic source tree is kept complete; the initial full-suite run caught the missing lockfile in that fixture, which was fixed and retested before RC.50 packaging.
- Benchmark fixture v91 is a successor to v90. Earlier fixtures, RC.47/48/49 archives and RC.26 rollback baseline are preserved.

## Current read-only observations

The latest graph reconciliation `artifacts/adaptive-goal-graph/live-reconciliation-v1-rc50-rerun-20261029.json` (SHA-256 `8fa2b60d28365eb597d42a29cb2276712edb696144b824dc4ffaa5c40e625294`) and lifecycle reconciliation `artifacts/adaptive-goal-graph/live-reconciliation-v2-rc50-rerun-20261029.json` (SHA-256 `e42e6a1457b6e32ece3cceacd19c075886d7be9456a5e155f281b163bef111fb`) were run against the same workflow DB in read-only mode. They observe 86 jobs in scope: 60 stale/executing reconciliation candidates, 7 awaiting dispatch, 19 awaiting proposal/approval; 61 running tasks have no active lease rows. Missing lease rows do not establish worker death or authorize recovery.

The direct read-only Goal/Idea snapshot re-read returned snapshot hash `80001cbece6811f7e3a0c187662393f05393ed11421767b23d76548c77c32bf3`, matching the preserved full snapshot payload. It has 7 nodes, 7 edges, 7 memberships, zero evidence-manifest entries, `verified=false` and `eligibleForAttestation=false`. The current compact readback summary is `artifacts/adaptive-goal-graph/live-snapshot-readback-rc49-20261029.json` (SHA-256 `2b1bd5a848a1aed1c25ad264b7c95e8248a9a4cda0093167b8de4bc7ab3542df`); the full payload used by the dossier is `artifacts/adaptive-goal-graph/live-snapshot-rc49-final-20261029.json` (SHA-256 `e05d696af594e3f3e278c8a45d626fbb6bc22baedbe3016fb9beffeddc21f6fd`).

The current direct `/proc` diagnostic `artifacts/adaptive-goal-graph/trust-diagnostic-rc50-rerun-20261029.json` (SHA-256 `c311e5c1c40fc72b5b5a451a4b09a16d08e5408bddac891da48acf482ec94f11`) observes the host still running RC.26. Both verifier/reviewer JSON config variables are present but empty; provider and legacy-root variables are absent. The trust-status MCP operation was not called because it appends to the local trust ledger; the external checkpoint was not queried.

## Candidate-bound evidence

- Source alignment: `artifacts/adaptive-goal-graph/source-alignment-rc50-final-20261029.json` (SHA-256 `fa03d0825532c8b19639ee6c6a418c4c9d3ef4f7a10166961d53194afc71ecaa`). This is the report-file digest; the report's source-snapshot digest is separately recorded inside that JSON.
- Readiness dossier: `artifacts/adaptive-goal-graph/agg-readiness-dossier-rc50-final-20261029.json` (SHA-256 `6a29930027d99fdbe34c435efc4391c8c198130cf97cc2c6ea91987a1344d63f`).
- Remediation plan: `artifacts/adaptive-goal-graph/agg-remediation-plan-rc50-final-20261029.json` (SHA-256 `a850a4706b71bf8071f8bbf53b424071b8bf2e19e34a9b29d019a78353bac708`). It grants no mutation authority.
- Preflight: `artifacts/adaptive-goal-graph/rollout-preflight-rc50-rerun-20261029.json` (SHA-256 `337f5a64893905a73cc237af7de7fbfc1ae6ebac8f9cf8e209e5f593671ac956`), exit 3, `BLOCKED`, `canActivateNow=false`.
- Rollback baseline: `artifacts/runalith-1.0.9-rc.26-solo-graph-20261028.mcpb`, SHA-256 `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a`.

## Six open authority gates

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED`: custody owner must supply the signed canonical 71-path manifest and candidate-bound builder receipt. The verifier can check submitted evidence; it cannot supply the contract or authenticate caller-supplied root pins.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`: controlled builder, separate verifier and release authority must provide signed candidate-bound provenance, independent byte/source verification, and approval bound to RC.50, rollback digest and host nonce.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`: host/security administrator must provision and verify the effective version-pinned verifier/reviewer configs, independent providers, disjoint canonical SPKI roots, rotation/revocation and host-loaded values. Run the packaged `scripts/validate-agg-trust-config.mjs` with both authority-issued files and `--require-peer-config --effective-host-pid <PID> --effective-host-entrypoint <absolute-entrypoint>`; an offline `PASS` alone is insufficient.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`: independent checkpoint-store authority must provide signed checkpoint/store observation, continuity and atomic CAS proof bound to candidate, rollback, versions/fingerprints and nonce.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`: workflow owner and provider/runtime operator must give a verified disposition for each of the 60 job candidates, with event/attempt/result/artifact lineage and fresh readback.
6. `RUNNING_TASKS_MUST_DRAIN`: task owner and provider/runtime operator must establish each of the 61 running task outcomes, runtime identity, provider run, attempt/result/artifact lineage and lease/fencing epoch. Missing lease is not terminal evidence.

No live workflow, plugin registry/config, trust ledger, external checkpoint or host process was changed. No package was installed/activated, no task was retried/terminalized/dispatched, and no Git commit/push/reset/rebase was performed. Rollout must remain blocked until the six gates are satisfied by appropriate authority and preflight is rerun against the exact candidate.
