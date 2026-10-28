# Runalith RC.19 rollout dossier — 2026-10-28

## Decision

**BLOCKED — do not activate or dispatch production workflows.** RC.19 improves read-only Goal/Idea evidence eligibility diagnostics and adds regression coverage. Its runtime entrypoint is byte-identical to RC.18; no runtime behavior change justifies host reinstall/restart. The current host remains on RC.17 with the previously verified exact installed-file parity. No activation was attempted.

## Candidate identity and validation

| Item | Verified value |
|---|---|
| Candidate | `dist/runalith-1.0.9-rc.19-evidence-eligibility-20261028.mcpb` |
| SHA-256 | `d555e5c7e5665cbf584adce6b98c0320ad060695f5e968697a4c5df9bda64050` |
| Size / archive entries | 846,471 bytes / 93 |
| Manifest/runtime tools | 74 / 74 |
| Source snapshot SHA-256 | `8cafba2c7990e0fa8e41cb88520bb6d0744d6904b22c92d32ff64b40b7915086` |
| Source alignment report SHA-256 | `a54943d035878cdf9974562e5ad392e87cac4329446f855ae9ec492339eca347` |
| Full `npm test` log SHA-256 | `77e5846fc311253f63a9739f2c140f9578443a7c3fb668d4ec0071df8f2ef6ce` |
| Benchmark fixture | `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v61.json` |
| Fixture SHA-256 | `d008e8576de48aeeabc8eace7dd90e32c057252b07bd2ac8923c22ed7a30366e` |

Verified results:

- `npm test`: exit 0.
- `npm run test:package-reproducibility`: exit 0.
- `npm run test:mcpb-candidate -- dist/runalith-1.0.9-rc.19-evidence-eligibility-20261028.mcpb`: `MCPB_FAST_TEST=PASS`, isolated DB, 93 entries, 74/74 tools.
- `npm run pack:runalith-mcpb`: source alignment pass, ZIP integrity pass, extracted MCP initialize/tools-list 74/74, all mandatory extracted regression/E2E tests pass.
- Source alignment: `PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT`, 92 exact source entries plus one documented generated package metadata projection.
- Local source provenance is still `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`; release eligibility is not established by local hash verification.

## Current live state

The latest read-only reconciliation report is `/tmp/runalith-live-reconcile-rc19-evidence-eligibility-20261028.json`, SHA-256 `04792b7385391fae484cb9b4f8533399dd60fa51ce22a98e7cd214c5089d9a5b`. It reports:

- Two Goal/Idea Graphs, both structurally valid but evidence-ineligible, with zero evidence references and zero attestations.
- Three Plan Graph proposals / 22 steps missing `supportingEvidenceRefs`; three proposals lack authenticated current-snapshot binding; zero Execution Graph proposals.
- Four historical planner source-hash mismatches, which remain invalid.
- 60 jobs needing owner/provider/runtime reconciliation and 61 running tasks across those jobs; zero active task leases. No lease absence proves worker death.
- Verifier/reviewer JSON configs are still blank in the live host; test-local keys are not production trust roots.

## Preflight and blockers

Read-only preflight: `/tmp/runalith-preflight-rc19-evidence-eligibility-20261028.json`.

SHA-256: `9f0e97a2389edde57cfffc65918bdab5b5ae28220be2b00443ba8856d43f2daf`.

The command exited `3` (`BLOCKED`), with `canActivateNow=false`, `readOnly=true`, `liveMutationPerformed=false`, and external checkpoint transition `NOT_REQUESTED`. The six blockers remain:

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED`
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`
6. `RUNNING_TASKS_MUST_DRAIN`

The 71-path gate requires the real owner-signed canonical path manifest, host-pinned independent authority, and a builder receipt for the exact candidate/source snapshot. RC.19's 93 archive entries cannot be trimmed or relabelled to satisfy that contract. Release evidence must be signed and candidate/baseline/rollback-bound. Both JSON trust configs must come from separately administered authorities and be effective in the host process. The external checkpoint needs a host-owned adapter, independently protected monotonic state, signed observation and nonce-consuming CAS receipt. Every executing job and running task needs owner/provider/runtime reconciliation before any lifecycle action.

## Authority-owned next actions

Follow the detailed contracts in [RC.19 acceptance](goal-plan-execution-acceptance-rc19-20261028.md) and `docs/agg-production-trust-provisioning-runbook.md`. The required inputs must be supplied by the Phase 2 contract owner, controlled builder, independent release verifier/release authority, verifier/reviewer administrators, platform security/checkpoint authority and workflow owners. Do not generate replacement trust roots or signatures locally.

No live workflow DB write, graph mutation, host configuration change, runtime restart, package activation, external checkpoint transition or production dispatch was performed. Keep rollout blocked until each gate is independently verified.
