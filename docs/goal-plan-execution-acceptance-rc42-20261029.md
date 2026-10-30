# Goal/Plan/Execution Graph and lifecycle acceptance — RC.42

**Acceptance result: local engineering checks pass; production acceptance blocked.** This report is paired with the [RC.42 operator handoff](runalith-rollout-rc42-20261029.md). It distinguishes source-level correctness and reproducible packaging from independent release authority and live runtime safety.

## Candidate identity

| Field | Verified value |
|---|---|
| Candidate | `dist/runalith-1.0.9-rc.42-native-effect-reconciliation-20261029-v2.mcpb` |
| Version | `1.0.9-rc.42` |
| SHA-256 | `c8066b5456534d9fc9a066b1315ad0d1cf0da2fd8c1ceccd0a34adcd583bfe9d` |
| Bytes / expanded bytes | `934173 / 4010484` |
| Archive entries / MCP tools | `103 / 74` |
| Runtime entry point | `server/index-v1.0.9-rc.42.js` |
| Entry-point SHA-256 | `4f5b144fa4c16755c9b710923f3e9fe7d41744bb870d44111b8770e68e6b0056` |
| Source snapshot SHA-256 | `048184d6f6fcb0d1bce3781968a4b7f962fe7d3dd481e7d2b27c8db9eaebbf4b` |
| Rollback baseline | RC.26, SHA-256 `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a` |

## Code changes and regression coverage

1. `src/runtime/job-store.js`: `findUnresolvedProviderOutcome()` now checks durable quarantined-lease evidence (`REMOTE_EFFECT_UNCERTAIN_REQUIRES_RECONCILIATION` or matching `task.lease.quarantined` event). A failed lease does not prove the remote effect stopped. It also checks nonterminal M12 native-specialist runtime rows, independent of the GitHub `provider_runs` ledger, and fails closed if a legacy provider-run schema cannot bind a nonterminal run to a Job.
2. `tests/test-phase5-recovery.js`: adds stale-reaper regressions for (a) a quarantined lease with no provider intent/run rows, and (b) an ACTIVE native runtime whose lease/task metadata disagree after a simulated crash. The stale attempt remains `started`; no fabricated `attempt.timeout` event is appended.
3. `tests/test-workflow-terminal-failure-atomicity.js`: asserts workflow failure terminalization is deferred while an ACTIVE native runtime or quarantined lease remains unresolved. Job state and terminal events remain unchanged.
4. `scripts/package-runalith-mcpb.sh`, `tests/test-package-reproducibility.js`, `tests/test-package-no-overwrite.js`, source-alignment tests and `package.json`: package the new lifecycle regressions as mandatory extracted tests; verify no-overwrite and reproducible package identity.
5. `scripts/plugin-package-metadata.mjs` and `tests/test-extracted-package-tool-schemas.mjs`: preserve and require `runtimeEntryPoint` in extracted package metadata, bound to the manifest entry point, `main`, start script and version.
6. `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v82.json`: adds a successor fixture for RC.42 source pins. Historical v81 and earlier fixture bytes remain untouched.

The implementation does not fabricate owner/provider outcomes, infer death from missing lease, clear quarantines in bulk, or authorize retries. The regression tests exercise the failure states that previously could be mistaken for ordinary stale attempts.

## Executed acceptance results

| Check | Result | Evidence |
|---|---|---|
| Focused lifecycle/provider regressions | Pass | `test-phase5-recovery.js`, `test-workflow-terminal-failure-atomicity.js`, `test-provider-pre-send-recovery.js`, `test-dispatch-lease-quarantine.js`, `test-m12-native-specialist-bridge.js` |
| Full `npm test` | Pass, exit 0 | `artifacts/adaptive-goal-graph/npm-test-rc42-v2-final-20261029.log`, SHA-256 `5ac01843f8121457436c7e796c73e2425cd8ce6ee97f2c173238860c747df2b5` |
| Candidate package build and extracted validation | Pass | `artifacts/adaptive-goal-graph/package-build-rc42-v2-final-20261029.log`, SHA-256 `915640d5c72c3012102a6010933651ac7e6449b9b8653abdc720af47c801ab76` |
| Reproducible double-build | Pass; two independent builds are byte-identical | `artifacts/adaptive-goal-graph/package-reproducibility-rc42-v2-final-20261029.log`, SHA-256 `82f26ca78a360b9c8044aad81a33497032391e16c0864b2f92687b24fc9bba95` |
| Package no-overwrite | Pass | `artifacts/adaptive-goal-graph/package-no-overwrite-rc42-final-20261029.log`, SHA-256 `2cb428f3515be9f802a15fe315dfab54b0ad32b215a100c6391f6b232b4c6fd3` |
| Final MCPB smoke | Pass; 74/74 manifest/runtime tools, local-only health | `artifacts/adaptive-goal-graph/mcpb-candidate-smoke-rc42-v2-final-20261029.log`, SHA-256 `1eba5ce04dfbe89d26eb3860f29d39bb1bd510840b88b39264ac8fdb867ad613` |
| Source-to-bundle alignment | Pass; 102 exact source-byte entries + one projected metadata entry; exact candidate hash matches | `artifacts/adaptive-goal-graph/source-alignment-rc42-v2-finalization.json` |
| ZIP integrity and entry-point identity | Pass; 103 unique archive entries, 74 tools; archive entry bytes equal source runtime bytes; package/manifest/lockfile versions and all entry-point fields match | Final candidate and source-alignment report |
| Syntax, JSON and diff checks | Pass | `node --check`, `bash -n`, JSON parsing and `git diff --check` |
| Documentation links/tool inventory | Pass; 140 Markdown files, 357 local links, 74 registered tools | `npm run docs:check` |

The local source provenance status is `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`. Source/archive byte equality and reproducible builds establish integrity, not independent builder identity or release authority.

## Current graph and lifecycle acceptance

Fresh read-only observations are stored at:

- `artifacts/adaptive-goal-graph/live-reconciliation-v1-rc42-v2-finalization.json`
- `artifacts/adaptive-goal-graph/live-reconciliation-v2-rc42-v2-finalization.json`
- `artifacts/adaptive-goal-graph/live-snapshot-rc42-v2-finalization.json`
- `artifacts/adaptive-goal-graph/live-trust-status-rc42-v2-finalization.json`
- `artifacts/adaptive-goal-graph/agg-readiness-dossier-rc42-v2-finalization.json`
- `artifacts/adaptive-goal-graph/agg-remediation-plan-rc42-v2-finalization.json`
- `artifacts/adaptive-goal-graph/historical-source-mismatch-preservation-rc42-v2-finalization.json`

| Invariant / finding | Current observed state | Acceptance |
|---|---|---|
| Goal/Idea Graph snapshot | Hash `80001cbece6811f7e3a0c187662393f05393ed11421767b23d76548c77c32bf3`; 7 nodes, 7 edges, 7 memberships; evidence manifest empty | Blocked: no evidence-backed independent attestation |
| Plan Graph support evidence | 3 proposals, 22 steps; 22 steps have zero verified support evidence | Blocked: evidence must come from real producer-bound durable artifacts |
| Authenticated snapshot binding | 3 proposals lack authenticated current-snapshot binding; source remains unverified | Blocked: no caller-authored hashes or labels may self-promote trust |
| Execution Graph persistence | 0 persisted Execution Graph proposals; 0 execution-plan-candidate events | Blocked: upstream evidence and trust gates remain unmet |
| Workflow inventory | 86 jobs considered: 7 approved, 60 executing, 19 idle; 60 stale candidates require reconciliation | Blocked: every job needs owner/provider/runtime disposition |
| Running tasks / leases | 61 running tasks; zero lease rows; 61 running tasks lack active lease rows and execution metadata | Blocked: absent lease does not prove worker death |
| Terminal outcome authority | 0 verified terminal dispositions in schema-v2 diagnostic | Blocked: local SQLite observations cannot prove remote effects stopped |
| Planner source mismatches | 4 `source_hash_mismatch` records; IDs unchanged versus prior observation | Preserve history; create fresh producer evidence only through authorized path |

The machine-readable remediation plan contains 86 per-job and 61 per-task `HOLD_FOR_OWNER_RECONCILIATION` records, plus six authority-bound repair steps. `mutationAuthorized=false`; the plan is diagnostic only.

## Release decision and authority requirements

All six independent blockers remain open:

- `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED`
- `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`
- `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`
- `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`
- `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`
- `RUNNING_TASKS_MUST_DRAIN`

The latest host observation (`2026-10-29T02:31:29Z`) found PID `11598` running RC.26. Both trust JSON environment variables were present but empty; provider IDs and legacy public roots were absent. No trust ledger was mutated and the external checkpoint was not queried or advanced.

Required owners remain: Phase 2 contract owner/platform security/controlled builder; independent builder/verifier/release authority; host security and both independent trust authorities; independent checkpoint-store authority; each workflow owner plus provider/runtime operator; each task owner plus provider/runtime/lease authority. Obtain their evidence before any transition. Do not install, activate, reset, rebase, commit, push, bulk-repair, terminalize, retry, cancel, kill or redispatch live work. Preflight is expected to exit `3` with `BLOCKED` until those authorities independently close the gates.
