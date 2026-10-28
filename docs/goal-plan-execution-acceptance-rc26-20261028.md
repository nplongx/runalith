# Goal/Idea Graph → Plan Graph → Execution Graph acceptance — RC.26

**Decision: `BLOCKED` for production rollout.** RC.26 adds fail-closed reconciliation for executing jobs whose status metadata is inactive or differently cased, makes rollout lease counts depend on the durable `ACTIVE` state, and surfaces uncertain-remote-effect quarantine as a separate blocker. Targeted suites and the versioned benchmark pass. These changes do not create production authority, drain live work, or clear the six documented external/live-state gates.

## Candidate identity

| Field | Value |
|---|---|
| Candidate | `dist/runalith-1.0.9-rc.26-executing-state-reconciliation-final2-20261028.mcpb` |
| Version | `1.0.9-rc.26` |
| SHA-256 | `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a` |
| Size / archive entries | 856,171 bytes / 93 unique entries |
| Manifest/runtime tools | 74 / 74 |
| Runtime entry point | `server/index-v1.0.9-rc.26.js` |
| Source snapshot SHA-256 | `033f7220b3829db988e82ce68ee00ff98dafca872b45a99e2fc155e9bc276621` |
| Source alignment report | `/tmp/runalith-source-alignment-rc26-executing-state-reconciliation-final2-20261028.json`, SHA-256 `d2b26234fcaae237724a107e6506579293274acada82ac1f452b33fb9e66b0ed` |
| Rollback | RC.25 archive, SHA-256 `84d8ddf1fe3c55ad0d1e47a91e3fa11c7267209ffc48cc162f3e915ea03b017e` |
| Historical benchmark | v67 remains byte-for-byte preserved; SHA-256 `217c86983b17636e9ed3d14c3eae064d76ca69a158210ed0eb78e1d8871570a1` |

The final2 archive was built and verified at the exact path/digest above. Earlier RC.26 local archives were preserved rather than overwritten; final2 contains the stronger regression placing the quarantined lease outside five newer release rows. The final2 source-alignment report returns `PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT` / `PASS_EXACT_ARCHIVE_ENTRY_BYTES`, while source provenance remains `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT` and release eligibility remains `BLOCKED_AUTHENTICATED_BUILD_RECEIPT_AND_INDEPENDENT_AUTHORITY_REQUIRED`. Never overwrite RC.25 or benchmark v67. Source-to-bundle byte alignment is a local byte-identity check, not a signed builder receipt or independent release approval.

## Implementation changes

- `scripts/reconcile-active-workflows.mjs` now uses one shared job-selection predicate for the selected inventory and matching-job count: case-insensitive `active` status, case-insensitive `EXECUTING` state, or a running task.
- A job whose durable state is `EXECUTING` while status metadata is not `active` is classified as `executing_state_status_inconsistent` before any inactive/terminal-status classification. It carries `EXECUTING_STATE_STATUS_INCONSISTENT` with `HOLD` and `authorizationGranted=false`; the report does not modify its lifecycle state.
- Reconciliation independently inventories failed leases marked `REMOTE_EFFECT_UNCERTAIN_REQUIRES_RECONCILIATION` and correlates `task.lease.quarantined` events. Quarantine is reported even when its lease is outside the recent-five history window. This is a read-only signal; it does not make the remote effect safe to replay.
- `scripts/runalith-rollout.mjs` counts only durable `ACTIVE` lease rows as active leases. Failed leases and quarantine events are counted separately and add `QUARANTINED_TASK_LEASES_MUST_RECONCILE`. Thus a quarantine is not mislabeled an active lease, but it remains fail-closed until its owner/provider resolves it. An `ACTIVE` row remains a blocker even if expiry metadata is malformed or elapsed; expiry alone does not release durable ownership.
- The external-checkpoint runbook now accurately documents the host adapter bridge and warns that `--advance-external-checkpoint` is a state-changing operation that may commit before unrelated preflight blockers are returned. No checkpoint transition was requested for this candidate.
- Benchmark successor v68 refreshes the RC.26 source-identity pins while preserving the frozen graph, task identities, evidence oracle, scoring rubric, v67 and earlier fixture bytes. Source pins are local identity evidence, not independent attestation.

## Targeted validation

Results observed during this RC.26 work session:

| Command | Result |
|---|---|
| `node --test tests/test-reconcile-active-workflows.mjs` | PASS, 11/11 |
| `node --test tests/test-reconcile-active-workflows-v2.mjs` | PASS, 16/16 |
| `node --test tests/test-runalith-rollout.mjs` | PASS, 17/17 |
| `node --test tests/test-adaptive-goal-benchmark.mjs` | PASS, 15/15 with v68 |
| `npm test` | PASS, exit code 0; log `/tmp/runalith-npm-test-rc26-final2-20261028.log`, SHA-256 `1e961284f05e0f6f3d5c554923d5b33c25d1068a0a61d73567bdd10153dc584a` |
| `npm run test:package-reproducibility` | PASS, exit code 0; log `/tmp/runalith-package-reproducibility-rc26-final2-20261028.log`, SHA-256 `f7b1724c1cb6e142549b2ec433df83c7793c856bfb8852dd9305226b0b83b180` |
| `npm run pack:runalith-mcpb` targeting the final RC.26 archive | PASS; exact archive byte alignment, ZIP/archive build, extracted runtime smoke, 74/74 tool schemas and extracted regression/E2E checks |
| `npm run test:mcpb-candidate -- dist/runalith-1.0.9-rc.26-executing-state-reconciliation-final2-20261028.mcpb` | `MCPB_FAST_TEST=PASS`; SHA-256 matches the candidate above; 93 entries and 74/74 tools |
| `unzip -t` on final RC.26 archive | PASS; no compressed-data errors |
| `npm run docs:generate-reference` / `npm run docs:check` / `npm run docs:check:external` | PASS; 74 tools, 119 Markdown files, 336 local links, 31 unique external URLs checked |
| `node scripts/build-static-site.mjs` / `npm run site:check` | PASS; RC.26 entry point/version and acceptance filename verified, 12 local links and 16 unique external URLs |
| `git diff --check` | PASS |

## Fresh live read-only evidence

The final2 live read-only reconciliation report is `/tmp/runalith-live-reconcile-rc26-final2-20261028.json`, generated `2026-10-28T07:08:56.873Z`, SHA-256 `a102c97b2eb62a4b4566958d281c192dc06dcd240ceaaf79961e3761a51e5937`.

Observed counts: 137 jobs, 1,277 tasks, 5,308 events, 908 results, 867 artifacts, 982 attempts, 119 approvals and zero task-lease rows. The matching-job inventory includes 85 of 85 records without selection truncation: 60 `stale_candidate_reconciliation_required`, 18 `awaiting_proposal_or_approval`, and 7 `awaiting_dispatch`. Sixty jobs have running tasks without active lease rows. These are unresolved reconciliation records, not proof that a worker died.

The two persisted Goal/Idea graphs remain evidence-ineligible. Prior RC.25 evidence records 63 planner runs / 373 evidence records with zero verified claims, four source-invalid findings, three Plan Graph proposals / 22 steps missing supporting evidence, three proposals without authenticated current-snapshot binding, and zero persisted Execution Graph proposals. Those historical findings must be rechecked using the current report schema; the latest live graph facts have not been repaired by this code change.

## Fresh rollout preflight

The final2 candidate preflight report `/tmp/runalith-preflight-rc26-final2-20261028.json`, generated `2026-10-28T07:09:00.165Z`, has SHA-256 `5e20b87ffb51dfe8f8aac530d78087834eda82604272d4a83fdfdc395dfc0789`. It was read-only, performed no live mutation, did not change the external security store, and did not request a checkpoint transition. It returned exit code 3 and `canActivateNow=false`.

The preflight used the verified RC.25 archive as rollback baseline; package smoke passed and installed-file parity was 93/93. The six remaining blockers are:

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — the owner-signed canonical 71-path contract and candidate-bound builder receipt are not verified. The 93-entry MCPB archive cannot substitute for this contract.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — no verified candidate-bound builder provenance, independent verification and release approval chain was supplied for the exact release/baseline/rollback/nonce bindings.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — independently administered verifier/reviewer JSON configs and their effective runtime ledger history are not verified.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — host policy, adapter identity, independent monotonic store and signed continuity/CAS evidence remain external dependencies.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — live jobs still require authoritative owner/provider/runtime reconciliation.
6. `RUNNING_TASKS_MUST_DRAIN` — live running tasks still require record-level lineage and worker/provider confirmation.

The new quarantine blocker is tested in the rollout unit suite. The live database observed in this report has zero lease rows, so that report does not show an active quarantine count; this does not prove that a future or differently scoped report cannot find one.

## Safety and release boundary

No live workflow database row was repaired, no job/task was reset or terminalized, no process was killed/restarted, no production candidate was activated, and no external checkpoint was advanced in this work. Do not use `--advance-external-checkpoint` as a diagnostic or repeated smoke test; it can consume a nonce and change external security state before unrelated final gates are evaluated.

**Release remains `BLOCKED`.** Local code/test success cannot provision trust roots, authenticate an independent builder, resolve the 71-path contract, verify the external monotonic store, or substitute for owner/provider workflow disposition.
