# Runalith RC.32 rollout dossier — 2026-10-28

**Rollout verdict: `BLOCKED`. Do not install or activate RC.32.** This is a versioned successor candidate created to integrate lifecycle cancellation hardening, schema-v2 remediation-plan compatibility, and effective host trust-configuration diagnostics. RC.31 and earlier archives remain preserved. The host-managed runtime is observed as RC.26; no install, activation, restart, checkpoint advance or workflow transition was performed in this round.

## Integrated implementation changes

### Durable execution cancellation

`WorkflowStore.cancelExecutionBatch()` now refuses aggregate cancellation while **any** child item in the batch still has `tasks.execution_status='running'` or a durable `attempts.status='started'` row. It no longer depends on `execution_batch_items.status='RUNNING'` for the safety check: an inconsistent legacy/crash-window item marked `FAILED` or `CANCELLED` cannot hide an unresolved task from cancellation. The manager's abort/drain barrier remains required; the store guard is defense in depth, not proof an external process or side effect stopped. Test coverage includes a false-terminal item row with a still-running task, unresolved durable attempts, ambiguous post-spawn recovery, and drain-before-terminalization.

### Reconciliation-to-repair-plan integration

`scripts/build-agg-live-remediation-plan.mjs` now accepts supported read-only reconciliation schema v1 and v2. For v2 it requires the diagnostic-only metrics, explicit `automaticLifecycleActionsAuthorized=false`, unassessed local terminal proof, `missingLeaseDoesNotAuthorizeTerminalization=true` and `noAutomaticRecovery=true`. Unknown schema versions or any v2 report that claims lifecycle authority fail closed. The output remains a repair plan only; each mutation stays unauthorized.

### Trust configuration diagnostics

The offline trust validator now distinguishes a missing administrator file (`AGG_TRUST_CONFIG_FILE_MISSING`), invalid schema/config version (`AGG_TRUST_CONFIG_VERSION_INVALID`), ordinary schema violations (`AGG_TRUST_CONFIG_SCHEMA_INVALID`), missing effective runtime configuration, a pair that differs from the target host process (`AGG_TRUST_CONFIG_NOT_EFFECTIVE_ON_HOST`) and an entrypoint mismatch (`AGG_TRUST_CONFIG_HOST_ENTRYPOINT_MISMATCH`). Optional effective-host inspection is read-only, requires both independent domains, checks the host-parent/entrypoint binding and compares canonical config fingerprints, provider IDs and versions without printing PEMs or raw config. It explicitly does **not** establish the host ledger high-water state or the external checkpoint; rollout preflight remains authoritative for those independent checks.

## Candidate identity and validation evidence

The release successor is `dist/runalith-1.0.9-rc.32-workflow-recovery-trust-preflight-20261028.mcpb`, entrypoint `server/index-v1.0.9-rc.32.js`, package version `1.0.9-rc.32`. The actual archive is **876,858 bytes**, SHA-256 `4e6a63f24e5cd2c66eb7cf54c246f623c163dee6876f1ce177127c93c37831e5`, with **96 ZIP entries** and **74 MCP tools**. `unzip -t` passed; the projected package, manifest and versioned entrypoint agree exactly. Reproducible packaging rebuilt two validated archives with the same candidate SHA and verified all 96 ordered entries byte-for-byte. This identity does not supply an authenticated builder receipt, independent release approval or production authority.

Machine-readable evidence artifacts for this round:

- `artifacts/adaptive-goal-graph/rollout-preflight-rc32-final-20261028T122927Z.json` — SHA-256 `5156aaf965195db22f71aacf079c1f188965affca1f0f3a1f0d69ed08d079f7a`; exit 3 (`BLOCKED`), `readOnly=true`, no live/external mutation, no checkpoint transition requested.
- `artifacts/adaptive-goal-graph/live-reconciliation-v1-rc32-20261028T122452Z.json` — SHA-256 `a5261cda500b133b185b8572fdefafa24f98b81474ec55959e995830d08d024d`; current Graph-integrated reconciliation, read-only.
- `artifacts/adaptive-goal-graph/live-reconciliation-v2-rc32-final-20261028T122931Z.json` — SHA-256 `6486e11722ca1a682336442b098984ea2f6d5bd6b8522ad03e880b8097b75093`; current per-job/task recovery report, schema v2, read-only, diagnostic-only.
- `artifacts/adaptive-goal-graph/live-trust-status-rc32-final-20261028.json` — SHA-256 `2648c2250fae16ea3a7dd25420e177f85a7b5b62dc881731273b6d09f12a10f0`; direct environment-presence observation of the exact RC.26 host process; emits no config or key values and is not trust-ledger proof.
- `artifacts/adaptive-goal-graph/source-alignment-rc32-final-20261028.json` — final source-to-bundle byte-alignment report for the exact archive and finalized source snapshot.
- `artifacts/adaptive-goal-graph/agg-readiness-dossier-rc32-final-20261028.json` and `artifacts/adaptive-goal-graph/agg-live-remediation-plan-rc32-final-20261028.json` — versioned gate decision and owner-guided repair plan; neither grants lifecycle authority.
- `artifacts/adaptive-goal-graph/validation-summary-rc32-final-20261028.json` — command/exit-code/hash ledger for the final integrated validation round.

Local validation completed successfully: full `npm test` (including the batch regression suite); `npm run test:package-reproducibility`; `node tests/test-package-no-overwrite.js`; `npm run test:mcpb-candidate -- dist/runalith-1.0.9-rc.32-workflow-recovery-trust-preflight-20261028.mcpb`; `npm run docs:check`; and `npm run docs:check:external` (42 unique URLs). The benchmark successor fixture v74 passes 15/15 tests while retaining the recorded v73 hash unchanged. Exact final source alignment, `git diff --check` and the final machine-readable report are regenerated after this dossier/source update. These test results are not independent release evidence.

## Current read-only lifecycle observation

Fresh reconciliation was collected from `/home/long/.chat-on-steroids/agent-orchestrator/workflow.db` through both the Graph-integrated v1 command and diagnostic schema-v2 command. At 2026-10-28 12:29 UTC, the v2 report records 138 jobs, 5,309 events, 1,277 tasks, 908 results, 867 artifacts, 982 attempts, 0 lease rows and 119 approvals. Among 86 considered jobs, classifications are 7 awaiting dispatch, 60 stale candidates requiring per-job reconciliation, and 19 awaiting proposal/approval. There are 60 jobs needing reconciliation and 61 running tasks without active lease rows. All 86 considered jobs lack verified owner identity and persisted provider identity; 61 running tasks lack execution metadata. The report has 107 task reconciliation flags and zero verified terminal dispositions. Owner/provider/runtime identity is not verified; event references that resolve are not proof of complete lineage. All ambiguous items remain `HOLD`. A missing lease, absent PID or old activity timestamp is not proof the worker or remote side effect stopped.

The Goal/Idea snapshot `runalith-agg-e2e-20261026-clean` has hash `80001cbece6811f7e3a0c187662393f05393ed11421767b23d76548c77c32bf3`; the 12:24 UTC Graph-integrated reconciliation rechecked the same hash. It remains structurally distinct from evidence eligibility: 7 nodes, 7 edges, 7 memberships and an empty evidence manifest. The three legacy Plan Graph proposals contain 22 steps with missing supporting evidence, each proposal lacks authenticated current-snapshot binding, source evidence has not been independently revalidated, and no Execution Graph proposal or execution-plan candidate event is present in the current inventory. Historical planner source-hash mismatches remain unmodified. Candidate tests cannot create or substitute production evidence for these records.

## Six RC.23 blockers — all remain open

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED`: the Phase 2 contract owner must provide the exact canonical owner-signed 71-path manifest; the controlled builder must issue a receipt bound to the exact candidate/source; platform security must authenticate distinct, host-pinned authority roots. Do not infer or generate the manifest.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`: missing independently authenticated builder provenance, independent candidate-verification attestation, exact candidate/baseline/rollback-bound release approval, and host-issued one-time nonce. Local tests and checksums are insufficient.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`: the host must expose both authority-issued versioned configs and the exact active runtime must load those values and record matching provider/fingerprint/version rows in its own append-only trust ledger. The current RC.26 process has not established that evidence.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`: host security plus the separate checkpoint-store authority must provision and independently verify the host-owned adapter/root policy, signed current checkpoint, continuity, nonce consumption, CAS/commit receipt and anti-rollback storage. Never use the optional state-changing flag as a diagnostic.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`: each of the 60 jobs that current reconciliation flags needs a per-record decision by its authoritative owner and provider/runtime operator, backed by exact host/provider identity and durable lineage. Do not bulk-reset or terminalize.
6. `RUNNING_TASKS_MUST_DRAIN`: each of the 61 running tasks without lease rows needs authoritative attempt, runtime/provider, result/artifact, completion and fencing evidence. Keep unresolved cases on `HOLD`; do not cancel, replay or dispatch from this report.

## Safety boundary

Preflight is read-only and must remain `BLOCKED` while any required authority evidence is absent. Do not change the live workflow DB, plugin registry/config, trust ledger or external checkpoint. Do not install/activate the candidate, restart/kill the host process, dispatch workflows, or treat test-local keys/fixtures as production authority. No commit or push is part of this round.
