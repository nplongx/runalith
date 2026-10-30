# Runalith RC.37 rollout dossier — 2026-10-28

**Decision: `BLOCKED`; do not install or activate RC.37.** This successor packages three evidence/recovery hardening changes: schema-v2 reconciliation task/event lineage is carried into per-record remediation rather than silently disappearing; event/task and attempt/result/artifact scans no longer silently stop at the first five/100 array elements; and a fresh runtime with reviewer trust authority absent must deny dispatch even for a structurally valid candidate with an already approved immutable plan.

## Candidate identity and preservation

- Candidate archive: `dist/runalith-1.0.9-rc.37-reconciliation-lineage-dispatch-20261028.mcpb`.
- Runtime entry point: `server/index-v1.0.9-rc.37.js`; package version `1.0.9-rc.37`.
- Archive SHA-256, byte size, entry count, tool count and source snapshot digest are recorded after the final archive is built and verified below.
- RC.36 remains preserved at `dist/runalith-1.0.9-rc.36-live-remediation-lineage-20261028.mcpb`, SHA-256 `bcf8ddbb0b76b0a4849d70d6ee6d3078e9e9bafb926dbeb782c5c57b396ade68`.
- RC.31, RC.32, RC.33, RC.34, RC.35 and rollback RC.26 remain immutable. Historical benchmark fixtures v71/v72/v73 are unchanged; v74/v75/v76 are preserved versioned successors.
- No install, activation, host restart/kill, live workflow DB mutation, plugin registry/config change, trust-ledger write, external checkpoint transition, real workflow/provider dispatch, commit or push was performed.

## Source changes and regression evidence

1. `scripts/build-agg-live-remediation-plan.mjs` now normalizes the real schema-v2 `diagnostics[].tasks` shape when compact `recoveryPlan[].observedIdentity` intentionally omits legacy `taskLineage`. Per-task plans include row/event-payload fingerprints, event IDs/types, attempt/result/artifact/lease lineage, truncation status and explicit unverified owner/provider/runtime authority. Source-hash mismatch records inherit the matching dossier evidence by exact finding code/record ID/detail; unknown owner or authority fields stay explicitly unresolved. The remediation plan schema is version 2, and every mutation remains unauthorized.
2. Schema-v2 remediation input validation now requires all four fail-closed policy assertions: stale-candidate is not worker-death proof, missing lease does not authorize terminalization, caller must verify host/provider state, and no automatic recovery is permitted.
3. `scripts/reconcile-active-workflows-v2.mjs` now performs bounded recursive task-ID correlation and lineage-reference scans across nested arrays. The previous display-summary cap is not reused for identity correlation. Arrays beyond the explicit 10,000-item or 50,000-node bounds, or payloads exceeding the depth bound, produce explicit truncation markers and `HOLD`/incomplete lineage instead of a false complete scan.
4. The end-to-end Goal/Idea → Plan → Execution Graph test runs a second disposable runtime against the same private test database with the verifier root retained but reviewer trust JSON blank. The dispatch attempt must fail and leave the already-approved workflow with zero tasks; the normal isolated success path then still succeeds.
5. The package now includes the schema-v2 reconciliation CLI and its regression suite plus their exact checkpoint-contract test dependencies. Source-to-bundle alignment includes the reconciliation source/test and the current rollout dossier as build inputs.

All cryptographic keys in the E2E test are ephemeral, process-local fixtures. They establish negative enforcement behavior only; they are not production trust roots or authority evidence.

## Candidate-bound evidence

The following reports are created fresh for RC.37, each with a unique output path and SHA-256. The current host trust observation is read-only and does not call the trust-status MCP tool because that tool may append to the local trust ledger.

| Evidence | Artifact |
|---|---|
| Exact source-to-bundle alignment | `artifacts/adaptive-goal-graph/source-alignment-rc37-20261028T{STAMP}.json` |
| Graph-integrated read-only reconciliation | `artifacts/adaptive-goal-graph/live-reconciliation-v1-rc37-20261028T{STAMP}.json` |
| Schema-v2 lifecycle reconciliation | `artifacts/adaptive-goal-graph/live-reconciliation-v2-rc37-20261028T{STAMP}.json` |
| Rollout preflight | `artifacts/adaptive-goal-graph/rollout-preflight-rc37-20261028T{STAMP}.json` |
| Direct read-only host-process trust observation | `artifacts/adaptive-goal-graph/live-trust-status-rc37-current-20261028T{STAMP}.json` |
| Acceptance dossier | `artifacts/adaptive-goal-graph/agg-readiness-dossier-rc37-current-20261028T{STAMP}.json` |
| Per-record remediation plan | `artifacts/adaptive-goal-graph/agg-live-remediation-plan-rc37-current-20261028T{STAMP}.json` |

The final exact paths, SHA-256 values, observed counts and process identity are appended after validation. A report digest proves the bytes of that report, not the truth of an owner assertion or the existence of an independent authority.

## Six release gates remain open until external evidence is verified

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — owner-signed canonical 71-path manifest, candidate-bound controlled-builder receipt and host-pinned custody policy are missing.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — authenticated builder provenance, independent candidate verification, exact release approval and host-issued one-time nonce are missing.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — host-effective verifier/reviewer configs, separate provider identities and disjoint authority-provisioned roots plus verified ledger history are missing.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — external checkpoint is not configured; independently signed monotonic-store continuity/CAS receipts are missing.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — each unresolved job needs authoritative owner/provider/runtime outcome and exact event/attempt/result/artifact lineage.
6. `RUNNING_TASKS_MUST_DRAIN` — each running task needs authoritative outcome, attempt/result/artifact/completion and fencing evidence. Missing lease rows remain indeterminate.

## Validation contract

Record the actual exit code for every command below in the final acceptance report. A passing local test, reproducible archive, SHA-256 or byte alignment does not close an external authority gate.

```sh
npm test
npm run test:package-reproducibility
node tests/test-package-no-overwrite.js
npm run test:mcpb-candidate -- dist/runalith-1.0.9-rc.37-reconciliation-lineage-dispatch-20261028.mcpb
npm run docs:check
npm run docs:check:external
unzip -t dist/runalith-1.0.9-rc.37-reconciliation-lineage-dispatch-20261028.mcpb
git diff --check
```

**Rollout stays `BLOCKED`** until all six gates have current, independently verifiable authority evidence and authoritative workflow-drain outcomes. Do not use `--advance-external-checkpoint` for diagnostics.
