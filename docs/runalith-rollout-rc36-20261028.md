# Runalith RC.36 rollout dossier — 2026-10-28

**Decision: `BLOCKED`; do not install or activate RC.36.** RC.36 carries forward the recovery-lineage repair-plan changes and adds a versioned benchmark source-pin successor plus an end-to-end negative test at the real dispatch boundary: a candidate and immutable plan that were previously approved are still denied when the independent reviewer attestation is absent. The test uses only a disposable SQLite database and restores the exact event bytes after the negative probe.

## Candidate identity and preserved history

- Candidate: `dist/runalith-1.0.9-rc.36-live-remediation-lineage-20261028.mcpb`; entry point `server/index-v1.0.9-rc.36.js`; package version `1.0.9-rc.36`.
- Archive size: 878,613 bytes. SHA-256: `bcf8ddbb0b76b0a4849d70d6ee6d3078e9e9bafb926dbeb782c5c57b396ade68`. Inventory: 96 archive entries, 74 MCP tools.
- Source snapshot SHA-256: `0325a613a578b4b66212c7b5f2e7ab2534a7b140d6ff0f1cf061efb4a48221f4`. The report proves exact archive-entry byte alignment only: `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`. It is not an authenticated build receipt or independent approval.
- Preserved candidate archives: RC.31 `ea807c3fb71c5cf9f826fa7d6e0dc69693a9c4d6027e2462b92294db2ba6dfe6`; RC.32 `4e6a63f24e5cd2c66eb7cf54c246f623c163dee6876f1ce177127c93c37831e5`; RC.33 `24bdfcc61b3a53cbb06c205a43f77ed2afa70b10866ea749fd1567aabfec8c3a`; RC.34 `d9291b57dfed273f8d59a6f58630971d549b7e17a2245557134adcfa1929236d`; RC.35 `c7787989b9a108cad677de4dde6ea9f105d6240d16d468731c54ab81c463b01d`.
- Rollback RC.26 remains `artifacts/runalith-1.0.9-rc.26-solo-graph-20261028.mcpb`, SHA-256 `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a`.
- Historical benchmark fixtures v71/v72/v73 are unchanged: SHA-256 values `feef551082323f804863f215531f280b6bd1da461b25833813e0ba0ab8bfc331`, `cb1ff3f506ad9ac9bcbe03293b400614ea931c096c89aa8c8d839135b66357a6`, and `9213fa11782b80b14165042997ffbaad8b88228da1f3813ec761f0fa8a4d50ad`. Successor fixture v76 SHA-256 is `f796fcc223ae4c098b07293eed47b92f946c40084080267bceed34f5b077e64b`; v74/v75 remain preserved as earlier successors.
- Host remains on RC.26. No installation, activation, restart/kill, live workflow DB mutation, plugin registry/config change, trust-ledger write, external checkpoint transition or real workflow/provider dispatch was performed. No commit/push was made.

## Engineering changes and regression coverage

`scripts/build-agg-live-remediation-plan.mjs` derives mismatch/missing-evidence counts from the observed records rather than hard-coded counts. Every repair step now has explicit preconditions, owner-authority evidence requirements, and fresh-read post-repair verification records. Job/task recovery items bind to the reconciliation report and enumerate the owner/provider/runtime, attempt/result/artifact/event and lease/fencing checks required before a transition. All authority fields remain unverified; the plan is diagnostic-only and `mutationAuthorized=false`.

The benchmark source-pin refresh is a new v76 fixture; v71/v72/v73 and prior v74/v75 files were not overwritten. Full-suite test execution initially surfaced that the old v74 pin was incompatible with the versioned package metadata; v75/v76 successors now pin the current source instead of weakening the negative-test assertions.

The end-to-end producer → typed artifact → Plan Graph → Execution Graph test removes reviewer evidence after immutable-plan approval, attempts the actual dispatch tool, asserts an error and zero tasks, restores the exact event bytes, and then confirms the valid isolated path still works. Existing regressions also cover unauthenticated source snapshots, expired reviewer attestations, evidence mutation after approval, stale snapshot binding, malformed/missing evidence, trust-root separation, rotation/revocation, replay, cancellation/recovery races and immutable source-to-bundle alignment.

## Fresh evidence set

All reports below are bound to RC.36 and were created without live mutation.

| Artifact | SHA-256 | Interpretation |
|---|---|---|
| `artifacts/adaptive-goal-graph/source-alignment-rc36-20261028T132018Z.json` | `2557452bc326f1b02f6e2b867645a82a8501ee7712df4e03f9261b6047202410` | Exact archive-entry byte alignment; provenance not authenticated |
| `artifacts/adaptive-goal-graph/live-reconciliation-v1-rc36-20261028T132018Z.json` | `7116ec75415734e1aaddf4f77cf3b8847aa5c422e08edea523a1b89025e0dc44` | Read-only graph-integrated observation; 86 jobs considered, 60 flagged |
| `artifacts/adaptive-goal-graph/live-reconciliation-v2-rc36-20261028T132018Z.json` | `20a5f1d837fb433e34447e10a422bd4c5fd3b92b8758e4b18b3d1f570cacf332` | Read-only lifecycle lineage inventory |
| `artifacts/adaptive-goal-graph/rollout-preflight-rc36-20261028T132018Z.json` | `5bbf5fe4a5ec7dee6b5c8a5a1e98f8d38077810e213447f659d7e69d81850073` | Exit 3 expected; `BLOCKED`, `canActivateNow=false`, no checkpoint transition requested |
| `artifacts/adaptive-goal-graph/live-trust-status-rc36-current-20261028T132018Z.json` | `149dd4856de64d0e6f2739fb34e4f6d096f460649aa2e2cf44feee95c2ba571e` | Direct read-only `/proc` observation of current RC.26 PID 1339708; both domains blank; no trust-ledger mutation |
| `artifacts/adaptive-goal-graph/agg-readiness-dossier-rc36-current-trust-20261028T132922Z.json` | `bf531709c8602946046d59a0ef592d2fc864f7462df719e24fb00deb86d215ca` | `BLOCKED`, six gates open, nine findings; uses current host-process trust observation |
| `artifacts/adaptive-goal-graph/agg-live-remediation-plan-rc36-current-trust-20261028T132922Z.json` | `ac5decfc5ccb5cb54ead75c2e44a029c9415819ab288255b4f7dc15708295be5` | Diagnostic-only; mutation unauthorized |

The reconciliation totals remain 138 jobs, 5,309 events, 1,277 tasks, 908 results, 867 artifacts, 982 attempts, zero lease rows and 119 approvals. The current report identifies 60 executing jobs and 61 running tasks without leases. These are unresolved records, not evidence of worker death or permission to cancel, replay or terminalize them.

The refreshed trust-status input is a direct read-only `/proc` environment observation of the exact host-managed RC.26 process selected by current preflight (PID 1339708; entry point under `g-2pyEZV`). Both versioned trust JSON values are empty and both provider/public-root values are unset. This observation intentionally avoids the trust-status MCP operation because that operation can append to the local trust ledger. It does not verify ledger high-water rows or prove external checkpoint continuity; preflight independently reports the external anchor as `NOT_CONFIGURED`.

## Six open release blockers

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — needs the custody owner's canonical signed 71-path manifest, candidate-bound controlled-builder receipt and host-pinned custody policy.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — needs authenticated builder provenance, independent candidate verification, exact candidate/baseline/rollback-bound release approval and host-issued one-time nonce.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — needs authority-issued verifier/reviewer configs, disjoint trust roots/providers and verified effective host configuration plus ledger history.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — needs host-pinned adapter/policy and fresh independently signed continuity/CAS receipts from a separately administered monotonic store.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — needs authoritative per-job owner/provider/runtime outcome and exact event/attempt/result/artifact lineage.
6. `RUNNING_TASKS_MUST_DRAIN` — needs authoritative per-task outcome and attempt/result/artifact/completion/fencing evidence. Missing lease or telemetry remains `HOLD`/`INDETERMINATE`.

## Validation record

- `npm test` — PASS, exit 0; includes the v76 benchmark pin suite and integrated Goal/Idea → Plan → Execution E2E.
- `npm run docs:generate-reference` — PASS; 74 tools reflected in `docs/MCP_REFERENCE.md`.
- `npm run docs:check` — PASS; 134 Markdown files and 350 local links checked.
- `npm run docs:check:external` — PASS; 42 unique HTTP(S) URLs checked.
- Package build — PASS; 96 entries, 74 tools, extracted runtime smoke and package-contained trust/reconciliation/recovery/E2E tests passed.
- `unzip -t` — PASS.
- `npm run test:package-reproducibility` — PASS; independent rebuilds matched the expected archive identity.
- `node tests/test-package-no-overwrite.js` — PASS; existing candidate/archive paths were not overwritten.
- `npm run test:mcpb-candidate -- dist/runalith-1.0.9-rc.36-live-remediation-lineage-20261028.mcpb` — PASS; 74/74 manifest tools and runtime tools, isolated local-only MCP runtime.
- `git diff --check` — PASS.

These checks establish local engineering and byte-level integrity only. None can close an external authority gate by itself.

## Reproduction

```sh
npm test
npm run test:package-reproducibility
node tests/test-package-no-overwrite.js
npm run test:mcpb-candidate -- dist/runalith-1.0.9-rc.36-live-remediation-lineage-20261028.mcpb
npm run docs:check
npm run docs:check:external
unzip -t dist/runalith-1.0.9-rc.36-live-remediation-lineage-20261028.mcpb
git diff --check
```

Rollout remains **BLOCKED** until all six external authority and workflow-drain gates have current, independently verifiable evidence. Do not use `--advance-external-checkpoint` for diagnostics.
