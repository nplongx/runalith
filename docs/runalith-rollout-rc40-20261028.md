# Runalith RC.40 rollout dossier — 2026-10-28

**Decision: `BLOCKED`; do not install or activate RC.40.** RC.39 added the explicit external-security-store non-mutation marker to the schema-v2 remediation contract, but its archive was rejected by rollout preflight because manifest `mcp_config.args` still referenced RC.38. RC.40 aligns that argument with its versioned runtime, adds a packager-side pre-publication check and a runtime regression, and passes the final local validation suite.

## Candidate identity

- Candidate: `dist/runalith-1.0.9-rc.40-mcp-config-entrypoint-contract-20261028.mcpb`.
- SHA-256: `23bc39db503d80f3f2fea3c3d871da56ad6a764d4fac7783dd9495851d31ecac`.
- Size / archive entries / tools: 916,432 bytes / 101 entries / 74 manifest and runtime tools.
- Version / runtime entry: `1.0.9-rc.40` / `server/index-v1.0.9-rc.40.js`.
- Source snapshot SHA-256: `d939b57274ccb4759bde0873a46992bd92251e444d6e8bb978add50de17e2738`.
- Source-alignment report SHA-256: `918678a32631527e21d6cb0b5765920a33be62bff04be6beb27b3dc3ad774939`.
- Source state: `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`. Source-to-bundle byte identity passes, but release eligibility remains `BLOCKED_AUTHENTICATED_BUILD_RECEIPT_AND_INDEPENDENT_AUTHORITY_REQUIRED`.
- RC.39 rejected candidate is preserved: `dist/runalith-1.0.9-rc.39-external-mutation-marker-20261028.mcpb`, SHA-256 `3d25bddfb2d7ab73187e91d66a0711767d7a32b6bca03f8d0786bd680a7bfe4a`.
- RC.38 is preserved at SHA-256 `d8228a615f351e9d62565c3172093e02ab78e60595898684bbef8706fe0396bc`.
- Rollback reference remains `artifacts/runalith-1.0.9-rc.26-solo-graph-20261028.mcpb`, SHA-256 `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a`.

## Implemented hardening

`package.json` (`main`, `runtimeEntryPoint`, `scripts.start`), `plugin/manifest.json` (`server.entry_point`, `server.mcp_config.args`) and `package-lock.json` versions now agree on RC.40. `scripts/package-runalith-mcpb.sh` rejects an incorrect MCP argument array before staging/publication; `tests/test-runalith-plugin.js` asserts that the manifest launch argument identifies the same versioned runtime. The remediation compiler also requires `liveMutationPerformed`, `workflowDatabaseMutationPerformed`, and `externalSecurityStoreMutationPerformed` all explicitly equal `false` on separate schema-v2 lifecycle input.

## Fresh evidence — UTC `20261028T154336Z`

| Evidence | Path | SHA-256 | Result |
|---|---|---|---|
| Source alignment | `artifacts/adaptive-goal-graph/source-alignment-rc40-20261028T154336Z.json` | `918678a32631527e21d6cb0b5765920a33be62bff04be6beb27b3dc3ad774939` | Exact archive-byte alignment passes; source provenance remains unauthenticated |
| Graph reconciliation v1 | `artifacts/adaptive-goal-graph/live-reconciliation-v1-rc40-20261028T154336Z.json` | `dbeb1d2a057a6278090f936e12b7179803b90b190969d1254dace67e17e0467b` | Read-only graph and proposal inventory |
| Lifecycle reconciliation v2 | `artifacts/adaptive-goal-graph/live-reconciliation-v2-rc40-20261028T154336Z.json` | `97e6c44beeeca72ef7a014b33324cabb7fa20dbf044c934456ddfb0f6c8862c9` | Same canonical DB; all three mutation markers false |
| Rollout preflight | `artifacts/adaptive-goal-graph/rollout-preflight-rc40-20261028T154336Z.json` | `002085156b0fcae2434d89875f6239092df833b7b382abc10dfda7641f3ea1b7` | Exit 3; `BLOCKED`; no checkpoint transition requested |
| Direct host trust observation | `artifacts/adaptive-goal-graph/live-trust-status-rc40-current-20261028T154336Z.json` | `06ba24060ec789d82d1bfc5794eae07b80c2a4a9f30751d9116fe6db1299aa48` | Read-only `/proc` observation; serving process remains RC.26; both trust domains blank; external anchor not configured |
| Readiness dossier | `artifacts/adaptive-goal-graph/agg-readiness-dossier-rc40-current-20261028T154336Z.json` | `11a023230a84561ff0717c3b5b1644d493d1443d1734158927663c1d69e0f0fe` | Exit 3; six gates open, nine findings |
| Dual-source remediation plan | `artifacts/adaptive-goal-graph/agg-live-remediation-plan-rc40-current-20261028T154336Z.json` | `d38ed7bfff497b5d463e1b2943a545c73b68fdcd4139f523a9e09c94adce2352` | `BLOCKED_NEEDS_OWNER_AUTHORITY_RECONCILIATION`; mutation unauthorized |
| Validation summary (final corrected record) | `artifacts/adaptive-goal-graph/validation-summary-rc40-final3-20261028T154336Z.json` | `6f9d2731a66703f7994a498051fb9ad83f96a0ef38f9565954847519e143de2e` | 22,631 bytes; exact artifact/report/log hashes, command statuses and no-mutation flags; direct repository check records 3 local-only commits |

Both reconciliation reports use `/home/long/.chat-on-steroids/agent-orchestrator/workflow.db` and were captured at `2026-10-28T15:43:37.202Z` and `2026-10-28T15:43:38.847Z`. They recorded 138 jobs, 5,309 events, 1,277 tasks, 908 results, 867 artifacts, 982 attempts, zero task-lease rows and 119 approvals. Of 86 considered jobs, 7 await dispatch, 60 require reconciliation and 19 await proposal/approval. The graph inventory shows 3 Plan Graph proposals, 22 steps with missing supporting evidence, 3 proposals without authenticated snapshot binding and zero persisted Execution Graph proposals.

The readiness dossier confirms the reused Goal/Idea snapshot hash matches the current graph hash, but the snapshot evidence manifest is empty and it remains unverified/ineligible for attestation. The remediation plan includes 86 job records and 61 running-task lineage records; every task stays `HOLD_FOR_OWNER_RECONCILIATION`. Four historical planner source-hash mismatches remain unresolved without an invented cause.

## Final validation

| Check | Status | Evidence |
|---|---|---|
| Full `npm test` | PASS, exit 0 | `/tmp/runalith-npm-test-rc40-final2.log` |
| Focused reconciliation/trust/dispatch regressions | PASS, 39/39 | `/tmp/runalith-targeted-rc40-final1.log` |
| Focused source-alignment/benchmark/remediation suite on final source | PASS, 21/21 | `/tmp/runalith-targeted-rc40-final2.log` |
| Packaging no-overwrite adversarial test | PASS | `/tmp/runalith-no-overwrite-rc40-final1.log` |
| Package reproducibility | PASS; two independent builds identical to RC.40, 101 ordered entries | `/tmp/runalith-package-repro-rc40-final1.log`; input SHA-256 `c4acfad1074664666eeb0f7c93cd9bf97c305b8b7442fe1dc9a2b22fd2b18c6c` |
| Candidate MCPB smoke | PASS; 74/74 tools, `ok/local-only-mcp` | `/tmp/runalith-mcpb-smoke-rc40-final1.log` |
| ZIP integrity | PASS; 101 entries | `/tmp/runalith-zip-integrity-rc40-final2.log` |
| Documentation/internal links | PASS; 139 Markdown files, 355 links, 74 tools | `/tmp/runalith-docs-check-rc40-final5.log` |
| External links | PASS; 42 URLs | `/tmp/runalith-docs-external-rc40-final5.log` |
| `git diff --check` | PASS | `/tmp/runalith-diff-check-rc40-final5.log` |
| Syntax/metadata/fixture pins | PASS; v71/v72/v73/v76/v77/v78/v79/v80 immutable, v81 current pins match | `/tmp/runalith-syntax-check-rc40-final1.log`, `/tmp/runalith-metadata-consistency-rc40-final2.log`, `/tmp/runalith-fixture-check-rc40-final1.log` |

## Release decision and guardrails

All six release gates remain open:

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED`
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`
6. `RUNNING_TASKS_MUST_DRAIN`

The serving host remains RC.26. There was no installation/activation, process restart/kill, workflow database mutation, registry/configuration mutation, trust-ledger write, external checkpoint transition, real workflow/provider dispatch, commit or push. The preflight exit code 3 is the expected `BLOCKED` decision. Local hashes, tests, and byte alignment do not supply the missing owner authority, independent build approval or external workflow outcomes.

The initial `validation-summary-rc40-final-20261028T154336Z.json` and corrected `validation-summary-rc40-final2-20261028T154336Z.json` are preserved as historical records. `validation-summary-rc40-final3-20261028T154336Z.json` is the final validation summary: it updates log hashes to the newest full test/documentation checks and records a direct `git rev-list --left-right --count @{upstream}...HEAD` result (`0 3`: no upstream-only commits, three local-only commits). Neither summary authorizes rollout.
