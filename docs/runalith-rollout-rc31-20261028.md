# Runalith RC.31 rollout dossier — 2026-10-28

**Rollout verdict: `BLOCKED`. Do not install or activate RC.31.** The active host is still RC.26; RC.31 is a local candidate successor to the preserved RC.30 archive. This successor formats read-only Plan Graph source-revalidation failures as structured stale blockers without bypassing validation or mutating stored proposals.

## Source and runtime change

In `server/index-v1.0.9-rc.31.js`, `adaptive_goal_plan_proposal_get` returns `found:false`, `status:stale`, `reason:source_revalidation_failed`, and a stable blocker for coded `SOURCE_*` failures. This includes historical proposals that no longer match a compiled workflow-template plan hash. Unexpected non-source errors are re-thrown. The source revalidation and fail-closed behavior are unchanged; this is an API diagnostic improvement only.

The E2E regression forces a source revalidation failure in a disposable database, confirms the structured response, restores the exact original event payload bytes, and verifies the proposal is again readable. It never edits the live database. Benchmark fixture v73 is a new immutable successor to v72; v68-v72 and RC.28/RC.29 archives are preserved.

## Candidate identity and actual validation

Exact candidate: `dist/runalith-1.0.9-rc.31-structured-plan-readback-20261028.mcpb`; SHA-256 `ea807c3fb71c5cf9f826fa7d6e0dc69693a9c4d6027e2462b92294db2ba6dfe6`; 869,921 bytes; 95 unique archive entries; 74/74 registered tools; entrypoint `server/index-v1.0.9-rc.31.js`. Packager and `npm run test:mcpb-candidate -- dist/runalith-1.0.9-rc.31-structured-plan-readback-20261028.mcpb` both passed on extracted bytes, including MCP initialize/tools/list, schema checks, trust/reviewer/replay/rotation/revocation tests, current-scope producer E2E, and isolated legacy-source rejection. `npm run test:package-reproducibility` passed; no-overwrite protection passed on rerun after updating the test fixture to follow the package's versioned runtime entrypoint. `docs/MCP_REFERENCE.md` was regenerated from the 74 registered tools; `npm run docs:check` and `npm run docs:check:external` passed (130 Markdown files, 339 local links, 31 external URLs). Final full suite output is `/tmp/agg-npm-test-rc31-release-final-20261028.log` (exit 0; digest in the validation summary). Actual command statuses and log digests are collected in `artifacts/adaptive-goal-graph/rc31-validation-summary-final-20261028.json`.

Fresh source alignment is `artifacts/adaptive-goal-graph/source-alignment-rc31-final-20261028T110440Z.json` (SHA-256 `9d28ac3d9efae2977aa76b1f54a10c1d4933040a91a53c833f980c22e5d2c324`) and reports `PASS_EXACT_ARCHIVE_ENTRY_BYTES` while retaining `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`. This distinction is intentional: hash alignment and same-worktree reproducibility do not authenticate an independent builder or release approver.

## Live observations and authority blockers

Fresh read-only reconciliation `artifacts/adaptive-goal-graph/live-reconciliation-rc31-followup-20261028T110204Z.json` (SHA-256 `4f3ce2346880832c7cf556e7a115593e2259d22fba3869c8caedd6eb0726e95e`) observed 138 jobs, 5,309 events, 1,277 tasks, 908 results, 867 artifacts, 982 attempts, zero lease rows, and 119 approvals. Of 86 active/executing jobs, 60 require owner/provider/runtime reconciliation; 61 running tasks lack active leases. Recovery records remain `HOLD_FOR_OWNER_RECONCILIATION` and `authorizationGranted=false`. A task without a lease or process observation must not be declared dead or terminalized.

The current graph `runalith-agg-e2e-20261026-clean` has 7 nodes, 7 edges, 7 memberships and 0 evidence references. It is not verified or eligible for attestation; `KNOWLEDGE_EVIDENCE_MANIFEST_EMPTY` and `KNOWLEDGE_VERIFIER_NOT_CONFIGURED` remain. Three legacy Plan Graph proposals have 22 missing supporting-evidence steps and no authenticated current-snapshot binding; no Execution Graph proposal is persisted. One older proposal also fails current workflow-template compatibility (`WORKFLOW_CHILD_TASK_UNMAPPED`); the old row is retained unchanged.

The latest read-only rollout preflight is `artifacts/adaptive-goal-graph/rollout-preflight-rc31-final-20261028T110332Z.json` (SHA-256 `655aff6bac01b0f049c5787c05615007b27d42f015590bd0ed95141f67d73977`; expected exit code 3). It reports `BLOCKED`, `canActivateNow=false`, no live/host/workflow DB/external-store mutation and confirms the tested rollback artifact matches the installed RC.26 generation. Fresh dossier: `artifacts/adaptive-goal-graph/agg-readiness-dossier-rc31-final-20261028T110440Z.json` (SHA-256 `9afef404c57ea321a464d03778cd7c9fc9dec79e3f9edd0ee970b44602b136f2`). Fresh machine-readable remediation plan: `artifacts/adaptive-goal-graph/agg-live-remediation-plan-rc31-final-20261028T110440Z.json` (SHA-256 `f996f0f37fb5d96cca5a13c554bbd7261df9b09c3eccdf5a97d5ce63b626a8d6`), which authorizes no mutation.

All six release gates remain unresolved:

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — Phase 2 contract owner must supply the real canonical owner-signed 71-path manifest; the controlled builder must supply its candidate/source-bound signed receipt; platform security must authenticate independently provisioned, distinct trust roots. Do not infer or trim the path list.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — independent builder/reviewer provenance and the exact candidate/source approval are absent.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — host-managed verifier and reviewer JSON trust configurations and identities are not verified.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — independent external checkpoint continuity and anti-rollback proof are absent.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — 60 job records need individually authorized owner/provider/runtime/outcome reconciliation.
6. `RUNNING_TASKS_MUST_DRAIN` — 61 running tasks without active leases require authoritative identity/fencing/outcome reconciliation; missing lease is not death evidence.

No signed authoritative Phase 2 manifest or builder receipt was found in the inspected repository/Git object sources. That search does not prove an organization-controlled custody store is empty. The contract owner, controlled builder, and platform-security administrator are the relevant authority dependencies; the user should not guess 71 paths.

No live workflow database, plugin registry/configuration, trust ledger, external checkpoint, or production workflow was mutated. No production package was installed or activated, no host process was restarted/killed, no lifecycle transition was dispatched, and no commit or push was made. Rollout remains `BLOCKED`.
