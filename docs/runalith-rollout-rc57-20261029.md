# Runalith RC.57 rollout handoff — 2026-10-29

## Candidate identity

- Candidate: `dist/runalith-1.0.9-rc.57-readonly-trust-inspection-20261029.mcpb`
- Version / entrypoint: `1.0.9-rc.57` / `server/index-v1.0.9-rc.57.js`
- SHA-256: `bf47b00c352da2ee3b5caeae61c11a15a1e550e703a08f19d6df7d40dbdf57c4`
- Archive: 939,056 bytes; 103 entries; 74 manifest/runtime MCP tools; expanded size 4,034,675 bytes.
- Rollback baseline: RC.26 archive `artifacts/runalith-1.0.9-rc.26-solo-graph-20261028.mcpb`, SHA-256 `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a`.
- RC.54, RC.55, RC.56, earlier candidates and fixture v94 are retained. Fixture v95 is the successor; prior fixture bytes were not rewritten.
- Local source/archive byte identity passes. Provenance is `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`; this is not independent release provenance or approval.

## Integrated work and verified boundaries

- Trust-sensitive MCP descriptions now clearly distinguish read-only snapshot inspection from the state-changing trust-status observation that appends to the local trust ledger. Extracted-package schema tests require manifest/runtime description parity for both operations.
- Added fixture v95 to preserve the current package/source identity while retaining v94 and older historical fixtures. The benchmark runner supports the explicit v92–v95 identities and keeps the frozen graph/evidence/path oracle unchanged.
- Updated source-alignment synthetic workspaces to include v95; the integration tests now prove the full inventory can be reconstructed from their synthetic source trees.
- RC.57 package smoke/E2E, 74/74 tool schema checks, Phase 2 security regressions, full `npm test`, focused trust/provenance/E2E regressions, source-to-bundle alignment, reproducibility, no-overwrite rerun, archive integrity and documentation/link checks passed. The first standalone no-overwrite invocation encountered a timing-sensitive extracted-package EOF/backpressure failure; the isolated rerun passed. See `artifacts/adaptive-goal-graph/acceptance-evidence-rc57-20261029.json` for exact log hashes and exit codes.
- Direct `scripts/mcpb-tools.mjs` calls against RC.57 confirmed tool schemas, health, catalog, liveness and access diagnostics. These calls used the tool's private temporary database and are explicitly **sandbox diagnostics**, not evidence of production database state.

## Current live observations (read-only)

Source: `/home/long/.chat-on-steroids/agent-orchestrator/workflow.db`; reconciliation timestamps are 2026-10-29T05:41Z. Both reconciliation reports explicitly state read-only/no mutation.

- 138 jobs, 1,277 tasks, 5,309 events, 908 results, 867 artifacts, 982 attempts, 119 approvals, zero active lease rows.
- 86 jobs considered: 7 awaiting dispatch, 60 stale/executing candidates requiring individual reconciliation, 19 awaiting proposal/approval.
- 61 running tasks; 61 have no active lease row and lack execution metadata. Missing leases do **not** prove worker death. No automatic retry, reset, terminalization, dispatch or drain was performed.
- Clean Goal/Idea snapshot `runalith-agg-e2e-20261026-clean`: 7 nodes, 7 edges, 7 memberships, hash `80001cbece6811f7e3a0c187662393f05393ed11421767b23d76548c77c32bf3`; integrity is structurally valid, but evidence manifest is empty, `verified=false`, and `eligibleForAttestation=false`. A separate graph also has no evidence manifest and remains ineligible.
- Four historical planner source-hash mismatches; 22 Plan Graph steps without supporting evidence; 3 proposals without authenticated current-snapshot binding; 0 persisted Execution Graph proposals.
- Serving host remains on RC.26 (`server/index-v1.0.9-rc.26.js`, SHA-256 `2f791884c8d2e3caf5740dedb77f1c9c26d7d0132eeb3fc4f01170e59d3fe4d1`). Verifier/reviewer JSON environment variables are present but empty; provider IDs and legacy roots are absent. Effective production trust is unverified. Trust-status MCP operation was not called because it writes to the trust ledger. External checkpoint was not queried or advanced.

## Rollout decision

**BLOCKED — `canActivateNow=false`.** Preflight exit code 3 is the expected fail-closed result, not a passing release gate. All six blockers remain open:

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — the contract owner must provide the signed canonical 71-path manifest and candidate-bound builder receipt. The current candidate has 103 entries; the contract was not inferred or weakened.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — independent builder receipt, independent byte/source verification, host-issued nonce and release approval bound to RC.57 digest and RC.26 rollback baseline are missing.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — host/security administrator and separate verifier/reviewer authorities must provision version-pinned JSON configs, distinct provider IDs, disjoint canonical SPKI roots, rotation/revocation policy, and verify the effective host-loaded configuration/ledger.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — checkpoint-store authority must provision and prove signed continuity, monotonicity, nonce consumption and compare-and-swap semantics independently of local SQLite.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — each of the 60 jobs needs owner/provider/runtime-confirmed disposition tied to event, attempt, result, artifact and fencing lineage.
6. `RUNNING_TASKS_MUST_DRAIN` — each of the 61 running tasks needs owner/provider/run identity, attempt/result/artifact and lease/fencing evidence; retain HOLD if unresolved.

No production install or activation, registry/config edit, live workflow mutation, host restart/kill, checkpoint advance, retry, dispatch, terminalization, bulk drain, commit, push, reset or rebase was performed.

## Authority handoff

Use the machine-readable preflight, readiness dossier and remediation plan alongside this document. Each owner must provide independently verifiable evidence and rerun the relevant read-only verifier/preflight against the exact RC.57 SHA-256. Do not close a blocker based on this local dossier, source hash, sandbox MCP result, local test trust root, or absent database row alone.
