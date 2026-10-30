# Runalith RC.42 rollout and operator handoff

**Decision: `BLOCKED`. Do not install or activate.** This handoff describes the final local RC.42 candidate and current read-only observations. Local test/build evidence is not independent release authority.

## Candidate and rollback

- Final local candidate: `dist/runalith-1.0.9-rc.42-native-effect-reconciliation-20261029-v2.mcpb`.
- Version: `1.0.9-rc.42`; SHA-256 `c8066b5456534d9fc9a066b1315ad0d1cf0da2fd8c1ceccd0a34adcd583bfe9d`; size 934,173 bytes; 4,010,484 expanded bytes; 103 archive entries; 74 manifest/runtime tools.
- Versioned entry point: `server/index-v1.0.9-rc.42.js`, SHA-256 `4f5b144fa4c16755c9b710923f3e9fe7d41744bb870d44111b8770e68e6b0056`.
- Package, lockfile, manifest version, package `main`, `runtimeEntryPoint`, `scripts.start`, manifest entry point and launch arguments agree on RC.42. Extracted package metadata preserves `runtimeEntryPoint` explicitly.
- Source snapshot SHA-256: `048184d6f6fcb0d1bce3781968a4b7f962fe7d3dd481e7d2b27c8db9eaebbf4b`.
- Final source-alignment JSON: `artifacts/adaptive-goal-graph/source-alignment-rc42-v2-finalization.json`.
- Final read-only rollout preflight: `artifacts/adaptive-goal-graph/rollout-preflight-rc42-v2-finalization.json`. Expected exit code `3`, status `BLOCKED`, `canActivateNow=false`; no live or external security-store mutation, no checkpoint transition requested.
- Rollback baseline remains RC.26: `artifacts/runalith-1.0.9-rc.26-solo-graph-20261028.mcpb`, SHA-256 `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a` (856,171 bytes).
- The earlier local RC.42 build at `dist/runalith-1.0.9-rc.42-native-effect-reconciliation-20261029.mcpb` is preserved, not overwritten, but superseded by the `-v2` bytes after the archive-level runtime-entrypoint assertion was strengthened. Use only the exact `-v2` digest above for further evaluation.
- Source alignment status is `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`. The archive matches captured source bytes; no authenticated controlled-builder receipt or independent release approval exists. Hash equality and reproducible builds do not close release gates.

## Integrated engineering

- `findUnresolvedProviderOutcome()` now treats a failed/quarantined lease with durable `REMOTE_EFFECT_UNCERTAIN_REQUIRES_RECONCILIATION` evidence as unresolved, even if provider-intent/provider-run rows are absent. A lease failure state is not proof that a remote effect stopped.
- Stale-attempt recovery and workflow terminalization now fail closed for nonterminal M12 native-specialist runtime rows. These rows use a separate durable ledger from `provider_runs`; task execution metadata or lease state cannot override unresolved runtime evidence.
- Provider-run schema inspection now fails closed when a legacy ledger cannot bind a nonterminal run to a Job, rather than silently skipping the ledger.
- Regression coverage reproduces stale task/lease metadata disagreement, quarantined lease without provider ledger rows, active native runtime with a released lease, and terminal-failure attempts while native/quarantined effects remain unresolved. Attempt status and terminal events remain unchanged when blocked.
- Package metadata now preserves `runtimeEntryPoint`; archive tests require exact agreement with manifest entry point, `main`, start script and version metadata.
- Benchmark fixture `recovery-verifier-v82.json` is a new source-identity successor to v81. v81 and earlier fixtures remain unchanged. Four historical planner source-hash mismatch records remain unchanged.

## Executed validation and evidence

| Check | Result / evidence |
|---|---|
| Full `npm test` | Pass, exit 0. `artifacts/adaptive-goal-graph/npm-test-rc42-v2-final-20261029.log`; SHA-256 `5ac01843f8121457436c7e796c73e2425cd8ce6ee97f2c173238860c747df2b5`. |
| Candidate packaging and extracted acceptance | Pass. `artifacts/adaptive-goal-graph/package-build-rc42-v2-final-20261029.log`; SHA-256 `915640d5c72c3012102a6010933651ac7e6449b9b8653abdc720af47c801ab76`. Includes 74/74 tool inventory, source alignment, ZIP integrity, MCP smoke and packaged regression suites. |
| Reproducible double-build | Pass: two independent validated builds produced SHA-256 `c8066b5456534d9fc9a066b1315ad0d1cf0da2fd8c1ceccd0a34adcd583bfe9d`; 103 ordered archive entries byte-verified. Stable input SHA-256 `d2cc4d164c9679661a362312329490e649b569dd5eb7c133c49b8a673b03d59d`. Log SHA-256 `82f26ca78a360b9c8044aad81a33497032391e16c0864b2f92687b24fc9bba95`. |
| Package no-overwrite | Pass; output aliases, existing files, dangling symlinks and validation-failure publication are covered. Log SHA-256 `2cb428f3515be9f802a15fe315dfab54b0ad32b215a100c6391f6b232b4c6fd3`. |
| Final candidate smoke | Pass; runtime `ok/local-only-mcp`, 74 manifest tools and 74 runtime tools. Log SHA-256 `1eba5ce04dfbe89d26eb3860f29d39bb1bd510840b88b39264ac8fdb867ad613`. |
| Exact source-to-bundle alignment | Pass for all 102 exact-source entries plus one projected metadata entry; 103 archive entries, 74 tools. Final JSON is linked above. Release eligibility remains blocked. |
| ZIP integrity / version identity | `unzip -t` passed; archive paths unique; package/manifest/lockfile versions match; `main`, `runtimeEntryPoint`, start script, manifest entry point and manifest launch args match; bundled runtime bytes equal source entrypoint bytes. |
| Documentation and syntax | `npm run docs:check` passed: 140 Markdown files, 357 local links, 74 registered tools matching `docs/MCP_REFERENCE.md`. `git diff --check`, JavaScript syntax, shell syntax and JSON checks passed. |

Detailed current evidence paths:

- Live graph reconciliation: `artifacts/adaptive-goal-graph/live-reconciliation-v1-rc42-v2-finalization.json`.
- Live lifecycle reconciliation: `artifacts/adaptive-goal-graph/live-reconciliation-v2-rc42-v2-finalization.json`.
- Live Goal/Idea snapshot: `artifacts/adaptive-goal-graph/live-snapshot-rc42-v2-finalization.json`.
- Read-only host trust-presence observation: `artifacts/adaptive-goal-graph/live-trust-status-rc42-v2-finalization.json`.
- Derived trust diagnostic (does not call the ledger-writing trust-status tool): `artifacts/adaptive-goal-graph/trust-diagnostic-rc42-v2-finalization.json`.
- Readiness dossier: `artifacts/adaptive-goal-graph/agg-readiness-dossier-rc42-v2-finalization.json`.
- Per-record remediation plan: `artifacts/adaptive-goal-graph/agg-remediation-plan-rc42-v2-finalization.json`.
- Historical mismatch preservation audit: `artifacts/adaptive-goal-graph/historical-source-mismatch-preservation-rc42-v2-finalization.json`.
- Acceptance summary and evidence hashes: `docs/goal-plan-execution-acceptance-rc42-20261029.md`.

## Current live findings, revalidated

Fresh schema-v1 and schema-v2 read-only reports inspect the same canonical workflow DB. The schema-v2 report explicitly states `DIAGNOSTIC_ONLY_NOT_RELEASE_EVIDENCE`, `automaticLifecycleActionsAuthorized=false`, and `terminalDispositionProof.status=NOT_ASSESSED_BY_LOCAL_SQLITE_DIAGNOSTIC`.

- 86 jobs inspected: 7 `APPROVED`, 60 `EXECUTING`, 19 `IDLE`; 60 jobs require reconciliation. All 86 have unverified owner identity and provider identity not persisted in the local diagnostic.
- 61 running tasks; zero task-lease rows; all 61 running tasks have no active lease row and lack execution metadata. `verifiedTerminalDispositions=0`. This does **not** establish that workers are dead or remote effects stopped.
- Workflow DB inventory: 138 jobs, 5,309 events, 1,277 tasks, 908 results, 867 artifacts, 982 attempts, 0 task-lease rows, 119 approvals.
- Goal/Idea Graph snapshot `80001cbece6811f7e3a0c187662393f05393ed11421767b23d76548c77c32bf3`: 7 nodes, 7 edges, 7 memberships, zero evidence-manifest entries, `verified=false`, `eligibleForAttestation=false`.
- Plan Graph: 3 persisted proposals, 22 steps, all 22 blocked for missing supporting evidence; all 3 proposals lack authenticated current-snapshot binding and have unverified source.
- Execution Graph: zero persisted proposals and zero execution-plan-candidate events.
- Planner: 65 runs, 373 evidence records, 28 evidence records self-report lineage verified, zero claim-verification records. Self-reported status is not authoritative.
- Four historical `source_hash_mismatch` records were compared with the prior read-only report; record IDs and mismatch classifications are unchanged. Preserve those records and capture fresh evidence only through the authorized producer path.

The per-record plan has 86 job dispositions and 61 running-task dispositions, each `HOLD_FOR_OWNER_RECONCILIATION`; six repair steps remain `NEEDS_OWNER_OR_AUTHORITY_ACTION`. No records were terminalized, repaired, retried, cancelled, killed or redispatched.

## Six independent release blockers — all open

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — Phase 2 contract owner, platform security and controlled builder must provide the owner-signed canonical 71-path manifest, candidate-bound builder receipt and host-pinned policy. Do not infer the frozen path list from archive entry count.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — independent builder/verifier and release authority must provide authenticated evidence bound to the exact candidate digest, source snapshot, rollback baseline and host-issued nonce. Local hashes, test results and reproducibility are insufficient.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — host/security administrator and both independent trust authorities must provision effective, versioned configs with distinct provider IDs, disjoint Ed25519 roots, exact scopes, validity/revocation state and ledger history. At `2026-10-29T02:31:29Z`, host PID `11598` served RC.26; both trust-config environment variables were present but empty, provider IDs and legacy roots absent.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — host/security authority and independent checkpoint-store authority must prove host-owned root-pinned adapter identity, separate authority/store roots, protected monotonic storage, signed continuity/CAS receipts and candidate/rollback binding. External checkpoint was not queried or advanced.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — each workflow owner and provider/runtime operator must reconcile every executing Job against authoritative owner, attempt, event, result, artifact, session/run and fencing evidence.
6. `RUNNING_TASKS_MUST_DRAIN` — each task owner plus provider/runtime/lease authority must establish actual runtime disposition for all 61 running tasks. Missing lease, PID or provider metadata is not proof of death.

## Safe next actions

1. Keep the candidate local. Obtain Phase 2 custody evidence and independent release evidence for the exact `-v2` bytes before reconsidering preflight.
2. Ask host/security owners to provision and independently verify both trust domains and the external monotonic checkpoint. Do not call `adaptive_goal_trust_configuration_status` merely to inspect state without authorization; that tool writes an observation to the trust ledger. Do not use `--advance-external-checkpoint` as a diagnostic.
3. Assign the 86 Jobs and 61 running Tasks to their actual owners/providers/runtime operators. Re-query each record immediately before any separately authorized lifecycle action; require consistent attempt/result/artifact/event and lease/owner-epoch lineage. Keep `HOLD` where identity or remote outcome is unknown.
4. After authoritative evidence is received, rerun read-only reconciliation and preflight against the exact candidate and RC.26 rollback. Any candidate-byte change requires a new immutable artifact path and fresh verification.

No install, rollout, commit, push, reset, rebase, live DB write, host-config change, trust-ledger mutation, external checkpoint transition or mass lifecycle action was performed. Repository remains dirty by design; pre-existing dirty/untracked work was preserved.
