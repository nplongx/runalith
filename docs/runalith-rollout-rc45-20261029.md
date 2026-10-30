# Runalith RC.45 rollout handoff

**Decision: BLOCKED. Candidate only. No installation, activation, production dispatch, trust mutation, or external checkpoint transition is authorized.**

## Candidate identity

- Package version: `1.0.9-rc.45`
- Candidate: `dist/runalith-1.0.9-rc.45-complete-source-alignment-20261029.mcpb`
- SHA-256: `2f7b25e6804b34b99bcde1d7fe83985ba297d8d356530ac3b3e70ead1b7ca811`
- Size: 935,959 bytes; ZIP entries: 103; MCP tools: 74
- Source snapshot SHA-256: `81d798d0007db37af073879dcc0b1a66a4b76ced02a232d8db22d604e31f80b3`
- Provenance status: `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`
- Rollback baseline: `artifacts/runalith-1.0.9-rc.26-solo-graph-20261028.mcpb`, SHA-256 `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a`

RC.44 remains preserved as historical candidate: `dist/runalith-1.0.9-rc.44-source-alignment-acceptance-20261029.mcpb`, SHA-256 `0028619ae8b52efe01e5458b5d51cc082720bee650a28a068896095f93f303d4`. RC.43 remains preserved: SHA-256 `dee6eb567563e0ec47b8e77b722ad001d958e902fee5641f75af577c9ccb30c0`. RC.42 v2 remains preserved: SHA-256 `c8066b5456534d9fc9a066b1315ad0d1cf0da2fd8c1ceccd0a34adcd583bfe9d`. RC.23 and RC.26 archives remain unchanged.

## Engineering delta

- Corrected benchmark provenance drift by creating immutable fixture successors v84, v85 and v86; preserved v82/v83/v84/v85 bytes. The observed RC.43 failure was a stale `docs/MCP_REFERENCE.md` pin in v83, not a benchmark scoring/graph implementation regression. After pin refresh, benchmark negative and determinism tests passed.
- Expanded source-alignment build inputs to include RC.43/RC.44/RC.45 versioned entrypoints and benchmark fixture lineage through v86. Source-alignment unit tests and the Phase 1 evidence-pack synthetic source tree now model the complete required input inventory.
- Bumped package/manifest/lockfile/runtime entrypoint coherently to RC.45. RC.44's archive bytes were not overwritten.
- Existing Goal/Idea → Plan → Execution producer-to-dispatch tests, typed artifact lineage, reviewer signature/scope/replay checks, immutable plan binding, trust-root separation/rotation/revocation/anti-rollback and lifecycle fail-closed tests remain required acceptance coverage. Test-local trust is not production authority.

## Validation

- `npm test`: exit code `0` after RC.45 source, metadata and v86 fixture changes.
- Focused benchmark, source-alignment and Phase 1 evidence-pack/package-boundary suite: 20/20 tests passed.
- `PLUGIN_BUNDLE_OUT=dist/runalith-1.0.9-rc.45-complete-source-alignment-20261029.mcpb npm run pack:runalith-mcpb`: exit code `0`; exact source/archive bytes aligned; extracted mandatory acceptance/E2E tests passed; 74/74 manifest/runtime tools.
- `npm run test:mcpb-candidate -- dist/runalith-1.0.9-rc.45-complete-source-alignment-20261029.mcpb`: `MCPB_FAST_TEST=PASS`, `ok/local-only-mcp`, isolated database.
- `node tests/test-package-no-overwrite.js`: exit code `0`.
- `node tests/test-package-reproducibility.js`: exit code `0`; the reproducibility assertions passed.
- Direct ZIP integrity and duplicate-entry check passed for RC.45: 103 entries, no duplicate names.
- Fresh read-only reconciliation reports are saved as `artifacts/adaptive-goal-graph/live-reconciliation-v1-rc44-20261029.json` (SHA-256 `8064ea78a6245d531bbe8af67b1c0aee7f50e5f301d9d074b9e576123b24e3b9`) and `artifacts/adaptive-goal-graph/live-reconciliation-v2-rc44-20261029.json` (SHA-256 `7427c7bd4f75928b8cc6c3d46c40e72dd21e419bcf99f06f5a2de736b81328e7`). These are read-only observations, not owner/provider attestations.
- RC.45 preflight: `artifacts/adaptive-goal-graph/rollout-preflight-rc45-final-20261029.json`, SHA-256 `fbd84f0e6619e7a0153a2d7eaa1af5a21b5ae4149a8d236f32da60bc006ae217`; exit code `3`, `BLOCKED`, `canActivateNow=false`.
- Documentation and final source-alignment report must be checked after this handoff is written. The candidate has no authenticated build receipt; local byte alignment/reproducibility is not authenticated provenance.

## Current read-only workflow findings

The refreshed reports observe 86 jobs in the reconciliation inventory, 60 stale candidates, 61 running tasks without active lease rows, 0 verified terminal dispositions, 4 historical planner source-hash mismatches, 22 Plan Graph steps lacking supporting evidence, 3 proposals without authenticated snapshot bindings, and 0 persisted Execution Graph proposals. The local workflow schema does not expose a `provider_runs` table; this is not evidence that remote provider effects did not occur. The seven-node clean Goal/Idea snapshot still has an empty evidence manifest and is not verified/attestation-eligible.

All remediation remains per-record and owner-held. A missing lease is not proof of worker death. Do not bulk reset, terminalize, retry, drain, kill, or dispatch jobs/tasks based on local diagnostics.

## Six release blockers — all OPEN

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — Phase 2 custody owner must supply the owner-signed canonical sorted 71-path manifest; controlled builder must sign a receipt bound to exact candidate bytes and immutable source commit/tree/snapshot; host security must independently pin the authority and builder roots. Do not infer paths from archive count.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — independently controlled builder provenance, independent candidate verification and release-authority approval must bind RC.45 bytes, source, rollback, policy, environment, validity and one-time nonce.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — host/platform security must provide both effective verifier/reviewer configurations, distinct providers and disjoint roots, version/change records, rotation/revocation state, and active trust-ledger consistency evidence.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — external ledger authority must provide fresh signed checkpoint and independent store observation/commit evidence with nonce, sequence, previous digest and candidate/rollback binding. No checkpoint transition was attempted.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — workflow owners and runtime/provider operators must independently reconcile each job and approve evidence-based dispositions.
6. `RUNNING_TASKS_MUST_DRAIN` — task owners and provider/runtime operators must reconcile each task's attempts, event/result/artifact lineage, provider effect, runtime identity, lease/fencing epoch and completion evidence.

The source alignment and test results do not close these authority-dependent gates. Host-managed activation remains separate and unauthorized. Keep rollout blocked until all six are independently closed for this exact candidate and rollback baseline.
