# Runalith RC.38 rollout dossier — 2026-10-28

**Decision: `BLOCKED`; do not install or activate RC.38.** The RC.38 candidate is byte-aligned to the current local source tree, full local validation passes, and a fresh read-only reconciliation has been integrated into a per-record remediation plan. These facts do not establish independent build authority or production readiness. The candidate source tree is dirty and no authenticated builder receipt, independent candidate attestation, or release-authority approval exists in the evidence set.

## Candidate identity and preserved artifacts

| Item | Identity |
|---|---|
| Candidate | `dist/runalith-1.0.9-rc.38-dual-reconciliation-lineage-20261028.mcpb` |
| Candidate SHA-256 | `d8228a615f351e9d62565c3172093e02ab78e60595898684bbef8706fe0396bc` |
| Size / archive entries / tools | 916,263 bytes / 101 entries / 74 manifest tools (74 runtime tools) |
| Runtime entrypoint / version | `server/index-v1.0.9-rc.38.js` / `1.0.9-rc.38` |
| Source snapshot SHA-256 | `ee1a96c8efbcb4c50161ec5206555b07f5381e831062ba786e4a624157369a32` |
| Source alignment report SHA-256 | `4a0042038fed9a402d97bbe07087c36af381eadb7ec33fc1bc055b6a774ba47e` |
| Rollback reference | `artifacts/runalith-1.0.9-rc.26-solo-graph-20261028.mcpb`, SHA-256 `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a` |
| RC.37 predecessor | `dist/runalith-1.0.9-rc.37-reconciliation-lineage-dispatch-20261028.mcpb`, SHA-256 `88646428a59ac18b880ee20daf1124438768ef911ace5be41100b58c7bcfcb46` |
| RC.36 predecessor | `dist/runalith-1.0.9-rc.36-live-remediation-lineage-20261028.mcpb`, SHA-256 `bcf8ddbb0b76b0a4849d70d6ee6d3078e9e9bafb926dbeb782c5c57b396ade68` |

The source alignment report records `PASS_EXACT_ARCHIVE_ENTRY_BYTES`, `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`, and `BLOCKED_AUTHENTICATED_BUILD_RECEIPT_AND_INDEPENDENT_AUTHORITY_REQUIRED`. Byte alignment is a local integrity finding, not an authenticated-build attestation.

Historical fixtures are preserved byte-for-byte: v71 `feef551082323f804863f215531f280b6bd1da461b25833813e0ba0ab8bfc331`; v72 `cb1ff3f506ad9ac9bcbe03293b400614ea931c096c89aa8c8d839135b66357a6`; v73 `9213fa11782b80b14165042997ffbaad8b88228da1f3813ec761f0fa8a4d50ad`; v76 `f796fcc223ae4c098b07293eed47b92f946c40084080267bceed34f5b077e64b`; v77 `0022a8e532ab4d4264e3f1e7c01ddfbdb22dcdd1a99b84c5995511c24be24137`; v78 `5ead8f79adc14c09a3891b79868ef04e5c5c07b7cdd609bc0778c764b7ce9645`. Current benchmark fixture v79 SHA-256 is `4ebeae237a04caa1ce2f95b362013a1e158e7abb1b132bca363394186e7e83ac` (100 source pins; supersedes v78). v79 deliberately excludes this candidate-specific handoff so a fixture hash cannot become self-referential.

No host install/activation, process restart/kill, live workflow DB mutation, plugin registry/config change, trust-ledger write, external checkpoint transition, real workflow/provider dispatch, commit or push was performed.

## Integrated engineering changes

1. `scripts/build-agg-live-remediation-plan.mjs` consumes the graph-integrated schema-v1 report and schema-v2 lifecycle report as separate path/hash-bound inputs. The CLI requires lifecycle lineage for a schema-v1 graph report, rejects noncanonical or different DB paths, absent no-mutation markers, stale/future observations, unmatched/duplicate job records and conflicting task lineage. The two reports must be captured within a ten-minute window and remain fresh when the plan is built.
2. Schema-v2 output explicitly marks live, workflow DB and external security store as unmutated. Per-task lineage comes only from the explicit lifecycle report; recovery plans remain `HOLD_FOR_OWNER_RECONCILIATION`, and `mutationAuthorized=false`. A missing lease is not proof of worker death.
3. Lifecycle reconciliation binds complete job-event payload fingerprints into its deterministic recovery identity, bounds recursive task/reference scans and records truncation rather than silently implying full coverage.
4. The dispatch-negative E2E denies execution when independent reviewer trust authority is absent after candidate/immutable-plan approval, without creating a task or advancing lifecycle state. The benchmark successor preserves the semantic recovery-verifier scope and ground-truth oracle.
5. Package membership assertions and no-overwrite tests now enumerate the shipped schema-v2 reconciler, lifecycle regression, external-checkpoint contract and adapter tests. The test inventory was updated; package-membership and source-byte assertions remain strict.

## Final candidate-bound evidence — UTC `20261028T150959Z`

Every artifact below is a newly written, exclusive path; prior candidate/report archives were not overwritten.

| Evidence | Exact path | SHA-256 | Finding |
|---|---|---|---|
| Source-to-bundle alignment | `artifacts/adaptive-goal-graph/source-alignment-rc38-20261028T150959Z.json` | `4a0042038fed9a402d97bbe07087c36af381eadb7ec33fc1bc055b6a774ba47e` | Exact archive bytes; release eligibility still blocked |
| Graph reconciliation v1 | `artifacts/adaptive-goal-graph/live-reconciliation-v1-rc38-20261028T150959Z.json` | `a0973887b3acc1d00a6fbc0a633efd5af5622e29477cc5db2795bc942a088358` | Read-only graph/plan/execution inventory |
| Lifecycle reconciliation v2 | `artifacts/adaptive-goal-graph/live-reconciliation-v2-rc38-20261028T150959Z.json` | `2e6455d48ea5b2866b3c2c312dd374c822fff2a9f776ddff8464e273ff25a551` | Read-only, explicit no-mutation flags, diagnostic-only |
| Rollout preflight | `artifacts/adaptive-goal-graph/rollout-preflight-rc38-20261028T150959Z.json` | `74cf975175b169d9a42f950a97ca972dd7fa44922513c3c5d393ba3d0aa87016` | Exit 3 expected; `BLOCKED`; no checkpoint transition requested |
| Host process trust observation | `artifacts/adaptive-goal-graph/live-trust-status-rc38-current-20261028T150959Z.json` | `55a634f5088b7c8474939b2418f10175e1d8c767c738bf21c4f029f41c0a0394` | Direct `/proc` read only; host still RC.26; both trust domains blank; external anchor not configured |
| Readiness dossier | `artifacts/adaptive-goal-graph/agg-readiness-dossier-rc38-current-20261028T150959Z.json` | `33dfc7f4b5febd0814636da9a5ba24f2ddde908018d22c7ea41d32ae9ada10e4` | Exit 3 expected; six gates open, nine findings |
| Dual-report remediation plan | `artifacts/adaptive-goal-graph/agg-live-remediation-plan-rc38-current-20261028T150959Z.json` | `9ed21e83c8037e0ced0cb97d27a4756e40f369f66cddc6f5137cc94e762cd8b7` | `BLOCKED_NEEDS_OWNER_AUTHORITY_RECONCILIATION`; mutation unauthorized |
| Validation summary | `artifacts/adaptive-goal-graph/validation-summary-rc38-final-20261028T150959Z.json` | Created after the final logs and checks; path is exclusive | Command status, artifact identity and log digests for final validation |

The graph and lifecycle reports were captured at `2026-10-28T15:09:59.376Z` and `2026-10-28T15:10:00.779Z`, using the same canonical DB path. Both reported 138 jobs, 5,309 events, 1,277 tasks, 908 results, 867 artifacts, 982 attempts, zero task-lease rows and 119 approvals. Of 86 considered jobs: 7 await dispatch, 60 need reconciliation and 19 await proposal/approval. The graph report identifies three Plan Graph proposals and 22 steps with missing supporting evidence; all three proposals lack authenticated snapshot binding; no Execution Graph proposal is persisted.

The readiness dossier revalidated that the reused Goal/Idea snapshot hash exactly matches the current graph snapshot; this does not mean the snapshot is verified or attestation-eligible. It has no evidence manifest and remains ineligible. The remediation plan contains 86 job records and lineage for 61 running tasks, keeps all such tasks on `HOLD_FOR_OWNER_RECONCILIATION`, records four historical planner source-hash mismatches without fabricating their cause, and never authorizes reset, retry, terminalization, kill or redispatch.

## Validation results

| Check | Result | Evidence |
|---|---|---|
| `npm test` | PASS, exit 0 | `/tmp/runalith-npm-test-rc38-final2.log` |
| Benchmark v79 | PASS, 15/15 | `/tmp/runalith-benchmark-rc38-v79-final.log` |
| Packaging no-overwrite | PASS, exit 0 | `/tmp/runalith-no-overwrite-rc38-final3.log` |
| Package reproducibility | PASS, exit 0; two independent builds have the exact candidate digest `d8228a615f351e9d62565c3172093e02ab78e60595898684bbef8706fe0396bc`; 101 ordered entries | `/tmp/runalith-package-repro-rc38-final3.log`; stable input SHA-256 `3e124ccc22519f17f0c1ec7a1405e60427aed529540a4c3c0023bc6b327843f0` |
| Candidate MCPB smoke | PASS, 74/74 tools, `ok/local-only-mcp` | `/tmp/runalith-mcpb-smoke-rc38-final3.log` |
| ZIP integrity | PASS, 101 entries, no archive errors | `/tmp/runalith-zip-integrity-rc38-final2.log` |
| Documentation/local links | PASS, 137 Markdown files, 353 local links, 74 MCP tools match reference | `/tmp/runalith-docs-check-rc38-final2.log` |
| External documentation links | PASS, 42 unique HTTP(S) URLs inspected | `/tmp/runalith-docs-external-rc38-final4.log` |
| `git diff --check` | PASS | `/tmp/runalith-diff-check-rc38-final2.log` |
| Historical fixture pins | PASS; v71/v72/v73/v76/v77/v78 unchanged; all v79 source pins match | `/tmp/runalith-fixture-check-rc38-final2.log` |

## Six release blockers remain open

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — the designated custody owner must provide the canonical signed 71-path manifest, candidate-bound controlled-builder receipt and host-pinned custody policy.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — authenticated builder provenance, independently signed candidate verification, exact release approval bound to candidate/baseline/rollback and a host-issued one-time nonce remain missing.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — host-effective verifier/reviewer configs, distinct provider IDs, disjoint roots and verified append-only ledger state remain missing.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — host-pinned checkpoint verification and fresh independently signed monotonic-store continuity/CAS receipts remain missing.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — authoritative owner/provider/runtime outcome plus matching lineage is still required for 60 flagged jobs.
6. `RUNNING_TASKS_MUST_DRAIN` — authoritative outcome, attempt/result/artifact/completion and fencing evidence remains required for 61 running tasks without leases.

## Operator procedure and final decision

Run only read-only reconciliation against the same workflow DB, then pass both source reports to the plan builder:

```sh
node scripts/reconcile-active-workflows.mjs --db "$WORKFLOW_DB" --limit 200 --stale-after-ms 900000 --out "$GRAPH_REPORT" --include-sensitive-source-identifiers
node scripts/reconcile-active-workflows-v2.mjs --db "$WORKFLOW_DB" --limit 200 --stale-after-ms 900000 --out "$LIFECYCLE_REPORT"
node scripts/build-agg-live-remediation-plan.mjs --dossier "$DOSSIER" --reconciliation "$GRAPH_REPORT" --lifecycle-reconciliation "$LIFECYCLE_REPORT" --preflight "$PREFLIGHT" --output "$REMEDIATION_PLAN"
```

The current serving process is PID `1339708`, parent PID `1339587`, running `server/index-v1.0.9-rc.26.js`; both trust-config JSON variables, both provider IDs and both legacy-root values are absent. External checkpoint anchor status is `NOT_CONFIGURED`. This is a direct environment-presence observation only; it does not validate trust-ledger history or establish an external anti-rollback anchor.

**Final decision remains `BLOCKED`; `canActivateNow=false`.** Do not install, activate, advance a checkpoint, or mutate workflow state. The local source/test evidence is now complete for this engineering round, but the six authority and workflow-drain gates cannot be closed by code, hashes, local tests or synthetic fixtures.
