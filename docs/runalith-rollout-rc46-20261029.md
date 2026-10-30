# Runalith RC.46 rollout handoff

**Decision: BLOCKED. Candidate only. No production install, activation, dispatch, trust-ledger mutation or external checkpoint transition is authorized.**

## Candidate and preserved baselines

- Package: `1.0.9-rc.46`
- Candidate: `dist/runalith-1.0.9-rc.46-mcp-reference-parity-20261029.mcpb`
- SHA-256: `d1bf10462a8712c27164823f7fd406cbbeac4e48933f8adaae75ad62f1539b0d`
- Size: 935,960 bytes; 103 unique ZIP entries; 74 MCP tools in manifest and runtime
- Source snapshot SHA-256: `66fd491ca9ecbeb0a2b389e78994b434b398c26dab9dbf16684c92333aa59e0e`
- Source provenance status: `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`
- Rollback baseline: `artifacts/runalith-1.0.9-rc.26-solo-graph-20261028.mcpb`, SHA-256 `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a`

Historical candidate archives are preserved, not overwritten:

- RC.45: `dist/runalith-1.0.9-rc.45-complete-source-alignment-20261029.mcpb`, SHA-256 `2f7b25e6804b34b99bcde1d7fe83985ba297d8d356530ac3b3e70ead1b7ca811`.
- RC.44: `dist/runalith-1.0.9-rc.44-source-alignment-acceptance-20261029.mcpb`, SHA-256 `0028619ae8b52efe01e5458b5d51cc082720bee650a28a068896095f93f303d4`.
- RC.43: SHA-256 `dee6eb567563e0ec47b8e77b722ad001d958e902fee5641f75af577c9ccb30c0`.
- RC.42 v2: SHA-256 `c8066b5456534d9fc9a066b1315ad0d1cf0da2fd8c1ceccd0a34adcd583bfe9d`.
- RC.23: SHA-256 `00804c9599454533a45418c7fe733a3ced85b07219dee71c02eb19bcc0dbdd3e`.
- Benchmark fixtures v82-v86 remain unchanged. RC.46 uses v87, SHA-256 `285d117544bc51fc6aced4c6dc63d7bec162a7457286f94df295ff6f525638d6`.

## Integrated changes

- Fixed the benchmark source-pin mismatch by creating fixture successors v84-v87 rather than rewriting historical fixtures. The RC.43 mismatch was caused by a stale `docs/MCP_REFERENCE.md` source pin; the benchmark oracle/scoring semantics were not changed to force a pass.
- Regenerated `docs/MCP_REFERENCE.md` from the exact versioned RC.46 runtime. `docs:check` now verifies all 74 registered tools against the reference.
- Expanded `scripts/verify-mcpb-source-alignment.mjs` build inputs to include RC.43-RC.46 versioned entrypoints and benchmark fixture history through v87. Updated synthetic source-alignment and Phase 1 evidence-pack test trees to supply the complete inventory.
- Kept package version, lockfile, manifest and runtime entrypoint synchronized at RC.46. RC.44/45 archive bytes were not overwritten.
- Existing producer-to-dispatch E2E and negative tests cover typed producer artifacts, exact lineage, current snapshot authentication, Plan/Execution linkage, reviewer identity/scope, immutable plan pinning, replay/tamper denial and fail-closed dispatch. Disposable test trust roots are not production authority.

## Validation

- `npm test`: exit code `0` after RC.46 metadata, source-alignment inventory, v87 fixture and MCP reference updates.
- Focused benchmark/source-alignment/Phase 1 evidence-pack/package-boundary tests: 20/20 passed.
- `PLUGIN_BUNDLE_OUT=dist/runalith-1.0.9-rc.46-mcp-reference-parity-20261029.mcpb npm run pack:runalith-mcpb`: exit code `0`; exact archive/source bytes aligned, 103 entries, 74 tools, extracted mandatory tests and local E2E passed.
- `npm run test:mcpb-candidate -- dist/runalith-1.0.9-rc.46-mcp-reference-parity-20261029.mcpb`: `MCPB_FAST_TEST=PASS`, 74/74 tools, `ok/local-only-mcp`, isolated database.
- `node tests/test-package-no-overwrite.js`: exit code `0`.
- `node tests/test-package-reproducibility.js`: exit code `0`; two-build reproducibility assertions passed.
- `unzip -t` and duplicate-name check: passed, 103 entries and no duplicates.
- `npm run docs:check`: passed after MCP reference regeneration; 146 Markdown files and 358 local links before the two RC.46 handoff documents were added. Re-run after handoff creation.
- `git diff --check`: passed before the RC.46 handoff docs were added. Re-run after handoff creation.
- Fresh read-only reports: `artifacts/adaptive-goal-graph/live-reconciliation-v1-rc46-20261029.json`, SHA-256 `5b98ed37d5106684d700b2dd825d92424663fdd85e958b8a43f1e5a694d96101`; `artifacts/adaptive-goal-graph/live-reconciliation-v2-rc46-20261029.json`, SHA-256 `3dfc13a7912eeb2b0ebf5cd9ca39b35f31e88796c4c55141eee0168bff16cfc7`.
- Fresh preflight: `artifacts/adaptive-goal-graph/rollout-preflight-rc46-final-20261029.json`, SHA-256 `47a9992e0fc7b9fcb64548e48fcb63d362655a0c5cb0fecb92e42dc86bdf4646`; exit code `3`, `BLOCKED`, `canActivateNow=false`.
- The final source-alignment report is generated separately after these handoff documents are written, so its working-tree status hash binds the final tree. Local source alignment/reproducibility does not create an authenticated build receipt.

## Live findings — read-only, timestamped observations

- 86 jobs in the reconciliation inventory: 7 awaiting dispatch, 60 stale candidates requiring reconciliation, 19 awaiting proposal/approval.
- 61 running tasks lack active lease rows; all 61 also lack execution metadata in the current diagnostic schema.
- 0 verified terminal dispositions. 736 task records observed; owner/provider identity is not verified for the current inventory.
- Four historical planner source-hash mismatch records remain unchanged.
- 22 Plan Graph steps lack supporting evidence; 3 proposals lack authenticated snapshot binding; 0 persisted Execution Graph proposals.
- The clean Goal/Idea graph still has seven nodes, seven edges and seven memberships with an empty evidence manifest; it is not verified or attestation-eligible.
- The workflow schema has no `provider_runs` table. This absence does not prove that remote provider effects did not occur.

Every unresolved job/task remains held for owner reconciliation. Missing lease, stale age or absent provider rows do not prove worker death or remote failure. No bulk reset, terminalization, retry, drain, kill or dispatch was performed.

## Six release blockers — all OPEN

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED`: Phase 2 custody authority must supply the owner-signed canonical 71-path manifest; controlled builder must sign receipt bound to exact candidate bytes and source snapshot; host security must independently pin the authority and builder roots. Do not infer the frozen contract from archive inventory.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`: independent builder provenance, independent candidate verification and release-authority approval must bind exact RC.46 bytes, source, rollback, policy, production environment, validity and one-time nonce.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`: host/platform security must provision and independently verify effective verifier/reviewer configs, distinct provider IDs and disjoint trust roots, version/change records, rotation/revocation state and active trust-ledger consistency.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`: external ledger authority must provide fresh signed checkpoint plus independent store observation/commit evidence bound to nonce, sequence, previous digest, exact candidate and rollback. No checkpoint transition was attempted.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`: workflow owners and runtime/provider operators must reconcile every job and independently attest evidence-based dispositions.
6. `RUNNING_TASKS_MUST_DRAIN`: task owners and runtime/provider operators must reconcile every task's attempts, event/result/artifact lineage, provider effect, runtime identity, lease/fencing epoch and authoritative completion evidence.

The current branch is `work/rc16-release-gates-20261027`; repository observation reported zero commits ahead and 102 behind its upstream, differing from older handoff state. No history rewrite or synchronization was attempted. The working tree remains dirty by design.

Host-managed activation is a separate operational action and remains unauthorized. Keep RC.46 blocked until every gate is independently closed for this exact candidate and rollback baseline.
