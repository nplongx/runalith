# Runalith RC.34 rollout dossier — 2026-10-28

**Decision: `BLOCKED`; do not install or activate RC.34.** This successor integrates machine-readable recovery preconditions/authority requirements/post-repair verification and an E2E negative test proving that an approved immutable plan plus a structurally valid candidate is still not dispatchable when the independent reviewer record is missing. It does not grant production authority or repair live state.

## Candidate and preservation

- Candidate: `dist/runalith-1.0.9-rc.34-live-remediation-lineage-20261028.mcpb`, entry point `server/index-v1.0.9-rc.34.js`, package version `1.0.9-rc.34`.
- Archive: 878,612 bytes, SHA-256 `d9291b57dfed273f8d59a6f58630971d549b7e17a2245557134adcfa1929236d`; 96 ZIP entries and 74 MCP tools. The package build completed extracted-runtime smoke and mandatory validation tests, including the new reviewer-missing dispatch regression.
- Source alignment is exact archive-entry byte identity, not authenticated provenance: `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`; release eligibility remains blocked pending an authenticated builder receipt and independent authority.
- Preserved without overwrite: RC.31 SHA-256 `ea807c3fb71c5cf9f826fa7d6e0dc69693a9c4d6027e2462b92294db2ba6dfe6`; RC.32 SHA-256 `4e6a63f24e5cd2c66eb7cf54c246f623c163dee6876f1ce177127c93c37831e5`; intermediate RC.33 SHA-256 `24bdfcc61b3a53cbb06c205a43f77ed2afa70b10866ea749fd1567aabfec8c3a`; rollback RC.26 SHA-256 `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a`.
- Historical recovery fixtures v71/v72/v73 remain unchanged; v73 SHA-256 is `9213fa11782b80b14165042997ffbaad8b88228da1f3813ec761f0fa8a4d50ad`. v74 remains a separate successor fixture.
- The host remains on RC.26. No installation, activation, process restart/kill, workflow dispatch, live DB mutation, plugin registry/config change, trust-ledger write or external checkpoint transition was performed. No commit/push was made.

## Integrated changes and regression evidence

`scripts/build-agg-live-remediation-plan.mjs` no longer hard-codes historical counts in its source-mismatch and Plan Graph summaries. It attaches the reconciliation source artifact to each job/task recovery record and emits explicit machine-readable preconditions, owner-evidence requirements, and fresh-read post-repair verification criteria. Those records explicitly remain unverified and cannot close a release gate; `mutationAuthorized` and lifecycle authorization remain `false`.

The disposable Goal/Idea → Plan Graph → Execution Graph E2E now removes the trusted reviewer attestation after candidate creation and immutable-plan approval, calls the actual `workflow_dispatch` boundary, verifies rejection and zero task creation, then restores the exact event bytes. This complements existing rejection coverage for unauthenticated source snapshots, expired reviewer attestations, mutated evidence after approval, stale source snapshots, replay and trust-root failures. All generated keys/database state are test-only; none is production evidence.

Focused checks passed:

- `node --test tests/test-agg-live-remediation-plan.mjs` — 4/4.
- `node --test tests/test-adaptive-goal-current-scope-producer-e2e.mjs` — 1/1; the negative dispatch probe passed and the positive path remained confined to disposable SQLite.
- `npm run pack:runalith-mcpb` — PASS; 96 entries, 74 tools, extracted runtime and mandatory package tests passed.

## Fresh read-only evidence set

The following reports all refer to the exact RC.34 candidate above. The two reconciliation reports were freshly collected read-only from the workflow DB. The trust-status input is the previously captured environment observation for the same still-serving RC.26 process; the trust-status MCP operation was not re-run because it can append to the local trust ledger. That observation does not establish ledger continuity or an external anchor.

| Report | SHA-256 | Result / scope |
|---|---|---|
| `artifacts/adaptive-goal-graph/source-alignment-rc34-20261028T130951Z.json` | `124c271546e39768940ff03b069a6f69735b385be675c5b60743e208a5b15c72` | Exact source-to-bundle entry-byte alignment; source provenance still unauthenticated |
| `artifacts/adaptive-goal-graph/live-reconciliation-v1-rc34-20261028T130951Z.json` | `b22136aa352f0aec81e8785d40be7f7f666887c5b1b6f01632e79a8c5dc8abed` | Read-only Graph-integrated report; 86 considered jobs, 60 flagged for reconciliation |
| `artifacts/adaptive-goal-graph/live-reconciliation-v2-rc34-20261028T130951Z.json` | `7abda7e8d06e4d5aeaf6a91bfe9eba626f99b7f5cb939c2a46a28e128bcd7340` | Read-only lifecycle diagnostics; missing leases remain non-authoritative |
| `artifacts/adaptive-goal-graph/rollout-preflight-rc34-20261028T130951Z.json` | `b61ec4d46b7f724ad4c4b6c791141a0708d535f4935e23cb41579593c468c396` | Exit 3 expected; `BLOCKED`, `canActivateNow=false`; no checkpoint transition requested |
| `artifacts/adaptive-goal-graph/agg-readiness-dossier-rc34-20261028T130951Z.json` | `1c6a314e5ac21a77b12a4ea8bb37892e811c647445c60bb265b097eb93c64e9a` | `BLOCKED`; all six RC.23 gates open |
| `artifacts/adaptive-goal-graph/agg-live-remediation-plan-rc34-20261028T130951Z.json` | `ad71d1105e098acf6ae617c52f7873202ae29868795943a1bf03a85b06b9852a` | Diagnostic only; 4 source-hash mismatches, 22 missing Plan-step evidence items, 3 missing snapshot bindings, 0 Execution Graph proposals, 60 executing jobs, 61 running tasks without leases; mutation unauthorized |

The read-only reconciliation records 138 jobs, 5,309 events, 1,277 tasks, 908 results, 867 artifacts, 982 attempts, 0 lease rows and 119 approvals. These totals are triage evidence only. All 60 flagged jobs and 61 running tasks require authoritative, per-record owner/provider/runtime reconciliation; no absent lease or stale timestamp is treated as proof of worker death.

## Six blockers — all open

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — requires the designated custody owner's canonical signed 71-path manifest, candidate-bound controlled-builder receipt, and host-pinned authority policy.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — requires authenticated builder provenance, an independently signed candidate-verification attestation, exact candidate/baseline/rollback-bound release approval, and host-issued one-time nonce.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — requires authority-issued verifier/reviewer configs, distinct providers and disjoint roots, and proof that the active host runtime loaded them and its append-only ledger reflects their current versions/fingerprints.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — requires a host-pinned adapter/policy and independently signed fresh checkpoint/continuity/CAS receipts from a separately administered monotonic store.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — requires authoritative owner/provider/runtime disposition for each of the 60 flagged jobs, with exact run identity and correlated durable lineage.
6. `RUNNING_TASKS_MUST_DRAIN` — requires authoritative outcome and attempt/result/artifact/completion/fencing evidence for each of the 61 running tasks; ambiguous outcomes remain `HOLD`/`INDETERMINATE`.

## Reproduction commands

```sh
node --test tests/test-agg-live-remediation-plan.mjs
node --test tests/test-adaptive-goal-current-scope-producer-e2e.mjs
npm test
npm run test:package-reproducibility
node tests/test-package-no-overwrite.js
npm run test:mcpb-candidate -- dist/runalith-1.0.9-rc.34-live-remediation-lineage-20261028.mcpb
npm run docs:check
npm run docs:check:external
unzip -t dist/runalith-1.0.9-rc.34-live-remediation-lineage-20261028.mcpb
git diff --check
```

Fresh read-only preflight/reconciliation/dossier/repair-plan outputs are versioned under `artifacts/adaptive-goal-graph/` as listed above. Do not use `--advance-external-checkpoint` for diagnostics. Rollout stays **BLOCKED** until external authorities provide the missing evidence and every unresolved workflow/task is authoritatively reconciled.
