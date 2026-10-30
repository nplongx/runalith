# Runalith RC.52 rollout decision — 2026-10-29

## Decision

**BLOCKED — do not install or activate.** RC.52 is the versioned successor after integrating typed effective-host trust diagnostics, source-alignment coverage for `package-lock.json` and the MCP reference generator, and stable generated MCP-reference metadata. The reference now describes current `tools/list` schemas without embedding version-specific entrypoint/version text, so package bumps do not force reference-only churn. Tool/schema parity is still checked against the exact current source runtime.

Candidate: `dist/runalith-1.0.9-rc.52-stable-mcp-reference-trust-preflight-20261029.mcpb` (937,012 bytes; 103 ZIP entries; 74 registered MCP tools). Direct SHA-256: `d47f25a7daec01c02c5e2d07528b9d40e115cc6a9f0c28be9c2ee2696d7079e9`. Entrypoint: `server/index-v1.0.9-rc.52.js`. Its bytes intentionally match the prior runtime entrypoint because the runtime dispatch code did not change; the integrated changes are in trust/operator validation, source-alignment and acceptance tooling.

Source alignment confirms exact candidate archive-entry bytes, but reports `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`. This is not an authenticated builder receipt or independent release approval.

## Engineering delta

- The trust validator distinguishes invalid supplied files from production blockers and emits specific codes for host JSON source, schema/config version, provider, fingerprint and cross-domain root collisions. It checks that the actual observed host verifier/reviewer configs are mutually separated, not merely that each matches a supplied file independently.
- Negative tests cover offline root collision, effective host root collision even when the supplied files are disjoint, wrong host version, provider and fingerprint. Authority-dependent checks remain fail-closed.
- The source-alignment inventory includes the lockfile, MCP reference generator, current versioned runtime entrypoint and fixture lineage. The Phase 1 synthetic source tree now includes all required source inputs, including the package lockfile.
- Benchmark fixture v93 is a successor to v92; all earlier fixtures and candidate archives are preserved.
- The MCP reference generator no longer embeds the package version and versioned entrypoint path, preventing repeated package bumps from leaving the documentation stale when the tool schemas did not change.

## Current read-only observations

Latest graph reconciliation: `artifacts/adaptive-goal-graph/live-reconciliation-v1-rc52-rerun-20261029.json` (SHA-256 `5ea0b0aff7378f5c1e69f2055eefb485ba3b3e161ab4bf9060afa56c4ce5aac6`). Latest lifecycle reconciliation: `artifacts/adaptive-goal-graph/live-reconciliation-v2-rc52-rerun-20261029.json` (SHA-256 `cbe6e88d0fcd9db1c0237640bf2461926908b1055f35f05527b681e57918be23`). Both are read-only observations of 86 jobs: 60 stale/executing candidates, 7 awaiting dispatch, 19 awaiting proposal/approval; 61 running tasks have no active lease rows. No per-record terminal outcome has been verified by these aggregate counts. Missing lease is not proof of worker death.

Current Goal/Idea snapshot readback is `artifacts/adaptive-goal-graph/live-snapshot-readback-rc52-20261029.json` (SHA-256 `2230f0e5b0fb0965b808e01977002b754dff2d4ab07e0850213e2e72719f9ed0`); the full preserved payload used by the dossier is `artifacts/adaptive-goal-graph/live-snapshot-rc52-final-20261029.json` (SHA-256 `e2c1953d26ff0a25bbac678afe3b30bf88608442a502139074e26f16b070df06`). Snapshot hash remains `80001cbece6811f7e3a0c187662393f05393ed11421767b23d76548c77c32bf3`, with 7 nodes, 7 edges, 7 memberships and zero evidence-manifest entries; `verified=false`, `eligibleForAttestation=false`.

Read-only host environment diagnostic: `artifacts/adaptive-goal-graph/trust-diagnostic-rc52-rerun-20261029.json` (SHA-256 `60c9c3fba5f872cd4feddaf0a2656497a05af225dd0b12b8e6b5f4465400f387`). The host still runs RC.26; verifier/reviewer JSON config variables are present but empty, provider and legacy-root variables are absent. The trust-status MCP operation was not called because it appends to the local trust ledger. No external checkpoint was queried or changed.

## Candidate-bound evidence

- Source alignment: `artifacts/adaptive-goal-graph/source-alignment-rc52-post-inventory-20261029.json` (SHA-256 `22a6bd7b59ce9c007a2362ccbfa07e385ae946eca037ebe2088377247e3a1b2e`). The JSON binds exact candidate bytes and the current dirty-tree source snapshot.
- Preflight: `artifacts/adaptive-goal-graph/rollout-preflight-rc52-post-inventory-20261029.json` (SHA-256 `9024c11ae60598324000eb3c78e891390fe783b14d76767a9aa7386defd378ff`), exit 3, `BLOCKED`, `canActivateNow=false`.
- Readiness dossier: `artifacts/adaptive-goal-graph/agg-readiness-dossier-rc52-post-inventory-20261029.json` (SHA-256 `13846f17670a51e0c543d5e5f2ea5308ba3a0f6c5c0fcf95cd19d78944c5f3d1`).
- Remediation plan: `artifacts/adaptive-goal-graph/agg-remediation-plan-rc52-post-inventory-20261029.json` (SHA-256 `9c438340cb1eba179a9f09847c2579e16e2d05e2fb49183792302e67ae6874f9`); `mutationAuthorized=false`.
- Machine-readable acceptance index: `artifacts/adaptive-goal-graph/acceptance-evidence-rc52-20261029.json`.
- Rollback baseline RC.26: `artifacts/runalith-1.0.9-rc.26-solo-graph-20261028.mcpb`, SHA-256 `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a`.

## Six open authority gates

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED`: the contract/custody owner must provide the signed canonical 71-path manifest and candidate-bound builder receipt. Local verification can validate supplied evidence but cannot create the authority contract or pin the root on its own.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`: the controlled builder, independent verifier and release authority must provide authenticated provenance, verification of exact RC.52 bytes/source and approval bound to candidate, rollback digest and host-issued nonce.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`: host/security administrators must provision version-pinned verifier/reviewer configs, distinct providers and disjoint canonical SPKI roots, and prove the exact host loaded them. Validate authority-issued files with the packaged `scripts/validate-agg-trust-config.mjs --require-peer-config --effective-host-pid <PID> --effective-host-entrypoint <absolute-entrypoint>`; offline file validation alone is insufficient.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`: independent checkpoint-store authority must provide signed checkpoint observation, continuity and CAS proof bound to candidate, rollback, config versions/fingerprints and nonce.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`: workflow owner/provider/runtime operators must provide verified disposition and consistent event/attempt/result/artifact lineage for each of the 60 job candidates.
6. `RUNNING_TASKS_MUST_DRAIN`: task owner/provider/runtime operators must establish the outcome, runtime identity, provider run, attempt/result/artifact lineage and lease/fencing epoch for each of the 61 running tasks.

RC.51 is preserved as a historical candidate but is superseded for handoff because its generated reference still carried stale version-specific metadata. RC.52 removes that churn at the generator level; it does not change the underlying 74-tool schema. The Phase 2 inventory regression now prioritizes the current source-aligned RC.52 package, verifies exact inventory bytes, and reports its 103 entries as a frozen-count blocker rather than failing because only historical 71-path candidates were searched. This does not create or infer the missing canonical 71-path manifest. No live plugin registry/config, workflow DB, trust ledger, external checkpoint or host process was changed. No package was installed/activated; no job/task was retried, terminalized or dispatched; no commit, push, reset or rebase was performed.
