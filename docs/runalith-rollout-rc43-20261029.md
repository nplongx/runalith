# Runalith RC.43 rollout handoff

**Decision: BLOCKED. Candidate only; no installation, activation, or production rollout is authorized.**

## Candidate identity

- Package version: `1.0.9-rc.43`
- Candidate: `dist/runalith-1.0.9-rc.43-provider-run-lineage-20261029.mcpb`
- SHA-256: `dee6eb567563e0ec47b8e77b722ad001d958e902fee5641f75af577c9ccb30c0`
- Size: 935,960 bytes
- Archive: 103 entries; 74 MCP tools
- Source snapshot SHA-256 recorded by package build: `bfe34157106a3fd04b145ad140d8039ef5c7007908b186e8c945bad746616a37`
- Source provenance status: `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`
- Rollback baseline: `artifacts/runalith-1.0.9-rc.26-solo-graph-20261028.mcpb`, SHA-256 `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a`

RC.42 v2 remains unchanged and historical: `dist/runalith-1.0.9-rc.42-native-effect-reconciliation-20261029-v2.mcpb`, SHA-256 `c8066b5456534d9fc9a066b1315ad0d1cf0da2fd8c1ceccd0a34adcd583bfe9d`. RC.26 rollback bytes and historical benchmark fixture v82 remain preserved. Fixture v83 is the successor pin set; it does not rewrite v82 or establish independent provenance.

## Engineering change in RC.43

Read-only workflow reconciliation now inventories `provider_runs` where supported, includes provider/run/attempt/lease/owner-epoch bindings in the row fingerprint, flags nonterminal provider runs, and reports legacy job-only provider-run schemas as ambiguous rather than silently omitting possible remote effects. The remediation plan carries these observations and keeps every record on `HOLD_FOR_OWNER_RECONCILIATION`. Provider-run rows remain diagnostic and do not authenticate provider status or authorize terminalization, retry, cancellation, or dispatch.

The benchmark fixture advanced from v82 to v83 to refresh source pins for the implementation and package metadata changes. v82 remains byte-for-byte unchanged. Package metadata and runtime entry point advanced to RC.43; RC.42 entry point and package bytes remain unchanged.

## Current live observations

Read-only lifecycle report: `artifacts/adaptive-goal-graph/live-reconciliation-v2-rc42-integrated-20261029.json`, SHA-256 `0b6c5399635c67edef8ac0fb0f828b3000ea06b6723527746903a3b6a5666ce5`.

- Workflow DB inventory: 138 jobs, 1,277 tasks, 908 results, 867 artifacts, 982 attempts, 5,309 events, 119 approvals, 0 task-lease rows.
- 86 jobs in the reconciliation inventory; 60 stale candidates require owner/provider/runtime reconciliation.
- 61 running tasks lack active lease rows; 0 verified terminal dispositions.
- Local SQLite diagnostics cannot independently authenticate remote provider outcomes. Missing lease is not evidence of worker death.

This observation predates the RC.43 provider-run diagnostic change and must not be misrepresented as evidence that the new provider-run fields were observed live. Capture a new read-only reconciliation report after final validation.

## Six release blockers

All remain open:

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — designated custody authority must provide the signed canonical 71-path manifest bound to immutable source identity; controlled builder must provide a candidate-bound receipt.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — independent builder provenance, independent candidate verification, and release-authority approval must bind exact RC.43 and rollback bytes, policy, environment, and one-time nonce.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — host/security authority must provision and independently verify both effective trust domains, roots, scopes, versions, rotation/revocation state, and active trust-ledger continuity.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — independently administered checkpoint authority must prove signed freshness, nonce binding, monotonic sequence and previous-digest continuity for exact candidate and rollback hashes.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — workflow owners and runtime/provider operators must reconcile each executing job and verify an authorized terminal disposition.
6. `RUNNING_TASKS_MUST_DRAIN` — task owners and provider/runtime operators must reconcile every task's provider effect, attempts, results, artifacts, events, leases and fencing epoch.

The latest preflight observation is still `BLOCKED`, exit code `3`, `canActivateNow=false`. Do not install, activate, dispatch, drain, reset, terminalize, or mutate live workflow/trust/checkpoint state from this handoff. Host-managed activation remains a separate, explicitly authorized operation after all blockers close.

## Validation status

Recorded local validation:

- `npm test`: exit code `0` after RC.43 source, package and v83 fixture changes.
- `node --test tests/test-reconcile-active-workflows-v2.mjs tests/test-agg-live-remediation-plan.mjs`: passed; includes task-bound and legacy job-only provider-run regressions.
- `PLUGIN_BUNDLE_OUT=dist/runalith-1.0.9-rc.43-provider-run-lineage-20261029.mcpb npm run pack:runalith-mcpb`: exit code `0`; 74/74 tools and extracted mandatory tests passed.
- `node tests/test-package-no-overwrite.js`: passed.
- `node tests/test-package-reproducibility.js`: exit code `0`; two independent builds reproduced SHA-256 `dee6eb567563e0ec47b8e77b722ad001d958e902fee5641f75af577c9ccb30c0`; 103 ordered entries byte-verified.
- `npm run test:mcpb-candidate -- dist/runalith-1.0.9-rc.43-provider-run-lineage-20261029.mcpb`: `MCPB_FAST_TEST=PASS`; 103 entries, 74 manifest/runtime tools, `ok/local-only-mcp`.
- `unzip -t` and duplicate-entry inventory: passed; 103 entries, zero duplicate names.
- `npm run docs:generate-reference`: generated `docs/MCP_REFERENCE.md` from RC.43 runtime, 74 tools.
- `npm run docs:check`: passed; 144 Markdown files and 358 local links.
- `git diff --check`: passed.
- Read-only reconciliation, source alignment and rollout preflight are captured in versioned RC.43 reports under `artifacts/adaptive-goal-graph/`. Source alignment proves exact local byte identity only; it explicitly reports no authenticated build receipt.

The final dossier and per-record remediation plan remain `BLOCKED`; all six release gates are open. None of these local checks can close them.
