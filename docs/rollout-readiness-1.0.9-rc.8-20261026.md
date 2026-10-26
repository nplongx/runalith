# RC.8 rollout-readiness evidence — 2026-10-26

> **Latest decision (2026-10-26 07:10Z): BLOCKED for host activation.** The trust-pair v15 RC.8 candidate passes full `npm test`, extracted-package regressions, source alignment, byte-identical package reproducibility, archive integrity and MCP fast smoke. Fresh read-only preflight still blocks activation: host runtime remains RC.5, neither source-verifier nor reviewer JSON trust configuration is provisioned, the independent monotonic trust-ledger checkpoint is `NOT_CONFIGURED`, 60 jobs remain `EXECUTING`, 61 tasks are `running`, and zero active leases exist. Fresh read-only Goal/Idea queries still return zero nodes/edges/memberships/revisions and no usable verified node IDs. Planner telemetry contains 373 evidence rows and zero `claim_verified` rows. Owner/provider outcome remains unresolved; no authoritative owner/provider identity columns exist in the live workflow schema. Stale classifications are not proof of worker death or authority to terminalize. No host package install, plugin config/registry edit, process restart/kill, live workflow DB write, fabricated artifact/reviewer proof, or production dispatch was performed.

## Candidate and rollback identity

| Item | Observed identity |
|---|---|
| Current RC.8 package | `/tmp/runalith-1.0.9-rc.8-trust-pair-v15-20261026T070018Z.mcpb` |
| Archive SHA-256 | `e143e722aa46322b0ac558e0ed43cf00aa035b7e6fa4907b6919824e197998fd` |
| Size / ZIP entries | 802,410 bytes / 92 entries |
| Manifest / package version | `1.0.9-rc.8` / `1.0.9-rc.8` |
| Selected MCP entry point | `server/index-v1.0.9-rc.8.js` |
| Runtime source SHA-256 | `0d50fd4760fd2b6374980cc375e054562cc5b6d3f68895492b849bb1e190e8b` |
| Manifest / exposed tools | 74 / 74 |
| Source alignment | PASS; source snapshot SHA-256 `83e87d193d0bf45ac6c530dbb0ced90ceca28f1f6fe84b0639b9e10b9541a558`; latest alignment report SHA-256 `1cee62da43ca18fbb0306ad1cd124afe5fbebefdb9f2433e5b2c7fb398b78f00` |
| Extracted runtime byte parity | SHA-256 matches the source RC.8 entry point byte-for-byte |
| Extracted acceptance / fast candidate test | PASS; `/tmp/runalith-package-final-v15-20261026.log`, `/tmp/runalith-mcpb-fast-v15-20261026T070018Z.log`, `MCPB_FAST_TEST=PASS`, `local-only-mcp`, 74/74 tools |
| Current full-suite log | `/tmp/runalith-final-npm-test-anchor-diagnostic-v15-20261026.log`, `NPM_TEST_EXIT=0` |
| Package reproducibility | PASS; `/tmp/runalith-package-repro-v15-20261026.log`; two independent validated builds were byte-identical across umask 022/077. |
| Original rollback MCPB | `artifacts/mcpb-candidate-build-20261025T131705Z/runalith-1.0.9-rc.5-current-scope-nine-child-integration.mcpb` |
| Rollback SHA-256 | `dc11aa4a24ec26c58dbdc3c90a8e7fa73c81f94c00f1b473143fa93123b4cca1` |
| Rollback version / smoke | RC.5; isolated runtime smoke PASS; previously compared against the installed generation with `FILES_MATCH_EXACTLY` (84/84 files) |

The candidate is a deterministic build artifact for the checked-in source state. Do not substitute a rebuilt archive without recording its new SHA-256 and repeating parity/tests. A separate content-derived rollback snapshot previously existed at `/tmp/runalith-1.0.9-rc.5-installed-generation-rollback-20261026T020000Z.mcpb`, SHA-256 `78eb13a888e398be3b86c3f0866d131b6da89533de440db2173216f3b5f3ebe9`; that snapshot is not the original container bytes or publisher provenance.
An earlier RC.8 candidate built before the canonical SPKI fingerprint fix is superseded. For rollout, use only the current filename/hash from the table; do not use the earlier trust-config-hardening archive.

Historical identities remain preserved:

| Source | SHA-256 |
|---|---|
| Historical `server/index.js` | `aa2b8f45f5a98817aac019f1659ff91f0bfc22da68cdbef1d9ad1ae6ceee8cb8` |
| RC.7 entry point | `c877b42560e4c0e33d015195b44bc98fdc1ac4f240f9e8e3c55b13177a74ed69` |
| Benchmark fixture v7 | `759ff96d88d670c91549f35f8df5898b61dabac4a5dc5db4b24bfccd9372da3f` |
| Benchmark fixture v8 | `113062b7b387f883b237d7b95a0f53909d7f1e08b33b252bed4fc25510d40715` |
| Benchmark fixture v9 | `115ba9f0ab8746df59eac3440443adb1d1f38a1f51159f1447a02f0cf83dd85f` |
| Benchmark fixture v10 (historical) | `331911bd0b36bbbbe390ae10387a8a1172d3d1a257d9e5b1140d1e2839f4e6ee` |
| Benchmark fixture v11 | `f21bf5101e7410b2dd8b92e85d9fb6af31e7667f296fe8bb8a66d90af0c59839` |
| Benchmark fixture v12 | `f4bbd5c784315400dc25ec63e7c0b683a0a1c637b242f2cdb19a9fd43974f17a` |
| Benchmark fixture v13 (current) | `743390d3b61f4a6ff0b19811d91068ef9bb155be15cc969af662cc30307149c7` |
| Benchmark fixture v14 (current) | `224787fe0cc6be275217d6a55d19f988354ce90323a6db6ff46ea577aed09ac6` |
| Benchmark fixture v15 (current) | `8426c48bd5c1a583cd80a6b1e417fc837da0e89ac3d297fc71ecf7edda3e66c4` |

The v15 fixture supersedes v14 and pins the paired trust-config validator, active-runtime negative cases, anchor-report contract and updated operator runbook. v14 and v7-v13 remain byte-for-byte historical predecessors. These are checked-in synthetic/offline provenance fixtures, not evidence of a production incident, live evidence or rollout.

## RC.8 changes and acceptance evidence

RC.8 completes the verified persistent Goal/Idea → Plan Graph → Execution Graph integration in the candidate source. Main trust and lifecycle boundaries are:

1. Goal/Idea nodes and current revisions are content-hashed and append-only; the signed snapshot also binds the complete immutable revision history, cross-goal memberships and provenance, edge identities/type contracts/provenance, current node membership, and resolved artifact/source evidence manifest.
2. `adaptive_goal_knowledge_snapshot_get` returns current canonical graph and evidence-manifest hashes. `adaptive_goal_knowledge_snapshot_attest` validates an external Ed25519 signature against a host-configured trusted public key, exact scope/provider/snapshot/ID sets/manifest, nonce, issue/expiry window, and independently rechecks the durable evidence lineage before it stores an attestation. Hash integrity does not prove claim truth or evidence independence; these remain decisions by the separately trusted verifier.
3. `adaptive_goal_knowledge_graph_search` reconstructs the graph from persisted rows and requires the current signed snapshot. The Plan proposal route accepts either a caller-supplied **shadow graph** or an exact persisted-graph goal/start/hash route, not both. The shadow path remains explicitly unverified. The selected search candidate remains separate from source attestation and never receives execution authority from that attestation.
4. Plan/Execution Graph readback revalidates snapshot, attestation expiry/currentness, candidate/draft/binding hashes, typed evidence and producer completion lineage. Plan Graph review approval is review-only. Execution Graph action candidate still requires validated action semantics, a separate trusted reviewer identity proof, fresh preflight, exact immutable plan hash and current approval before dispatch.

Verification run results:

| Check | Result |
|---|---|
| Final full `npm test` | **PASS, exit 0** (`/tmp/runalith-final-npm-test-anchor-diagnostic-v15-20261026.log`) |
| `tests/test-runalith-plugin.js` | PASS, including trusted source snapshot, full nine-role candidate flow, reviewer-attestation denials, sandbox receipt/replay/tamper and process-restart recovery |
| `tests/test-adaptive-goal-current-scope-producer-e2e.mjs` | PASS: 9 typed producer artifacts → persisted Goal/Idea snapshot → external test-only signature → 9-step Plan Graph → Execution Graph → trusted test-only reviewer proof → exact immutable plan pin + approval → dispatch; independently read back through another SQLite handle |
| `tests/test-adaptive-goal-trust-configuration.mjs` | PASS (11/11): canonical SPKI fingerprints and alternate PEM encoding, pair-mode validation with `--peer-config`, distinct provider/root enforcement, rotation/revocation/window checks, anti-rollback after DB reopen, non-mutating CLI validation and parent-symlink rejection |
| `tests/test-adaptive-goal-trust-entrypoint.mjs` | PASS (1/1) against the selected runtime: two distinct disposable trust domains, MCP snapshot attestation and signature/scope/staleness/replay/provenance-tamper denials; isolated DB |
| `tests/test-adaptive-goal-knowledge-verifier.mjs` | PASS (6/6): trusted roots/scopes, false evidence lineage, signature/hash/nonce denial, full revision/membership/edge tampering, transaction rollback/idempotent retry, expiry/refresh and canonical versioned roots |
| `tests/test-adaptive-goal-reviewer-identity.js` | PASS (6/6): reviewer root rotation/revocation, exact candidate/plan binding, replay and freshness checks |
| `tests/test-adaptive-goal-benchmark.mjs` | PASS (14/14), v15 current; v14 and earlier predecessor hashes pinned |
| `tests/test-runalith-rollout.mjs` | PASS (6/6): archive identity, read-only database integrity, malformed/legacy/colliding/revoked/expired active trust negatives, host-anchor report shape/release-hash/freshness gates, active-work gates, simulated switch/rollback failpoints and non-overwriting snapshot |
| Final targeted acceptance | PASS (36/36): benchmark v15 provenance, trust config, reconciliation, rollout gate and isolated three-graph producer → Plan DAG → Execution Graph E2E (`/tmp/runalith-final-targeted-acceptance-v15-20261026.log`) |
| Producer-to-dispatch E2E | PASS (9/9 typed artifacts → persisted/signed Goal/Idea snapshot → nine-step Plan Graph → Execution Graph → test-only reviewer → exact immutable plan pin/approval/dispatch); fresh SQLite readback inside isolated test DB |
| Extracted RC.8 package regression | PASS: 92 archive entries, including `scripts/reconcile-active-workflows.mjs` and `tests/test-reconcile-active-workflows.mjs`; 74/74 manifest/runtime tools; trust checks and three-graph E2E |
| `node scripts/verify-mcpb-source-alignment.mjs --bundle ...` | PASS; archive SHA `e143e722aa46322b0ac558e0ed43cf00aa035b7e6fa4907b6919824e197998fd`; source snapshot SHA matches the table above |
| `node scripts/test-mcpb-candidate.mjs ...` | PASS: `MCPB_FAST_TEST=PASS`, `runtime=ok/local-only-mcp`, 74/74 tools |
| `npm run test:package-reproducibility` | PASS: two validated builds byte-identical across umask 022/077; exact archive membership and extracted reconciliation tests pass |
| Documentation reference/check | PASS: 74 registered tools match `docs/MCP_REFERENCE.md`; 331 Markdown files and 268 local links checked |
| `git diff --check` | PASS after latest source/test/fixture changes; rerun after this dossier update |

The Ed25519 private keys used by the integrated tests are generated inside disposable tests. Their public trust roots exist only in those test processes. The tests prove runtime protocol and lifecycle behavior; they **do not** configure a production verifier/reviewer, turn synthetic artifacts into production evidence, or authorize a production action.

## Current live host and preflight (read-only)

The host-connected `orchestrator_health` and `workflow_list` checks and a separate SQLite read-only summary agree on the active generation and workflow counts:

| Check | Live observation |
|---|---|
| Host app PID / runtime PID | 13804 / 13885; runtime child remains owned by the host process |
| Live plugin version | `1.0.9-rc.5`, health `ok`, mode `local-only-mcp` |
| Live entry point | `/home/long/.config/chat-on-steroids/plugins/83ea5bbc-ce8c-4bd3-915d-d6cc8d270fe7/g-UgFZ6G/server/index.js` |
| Running entry-point SHA-256 | `aa2b8f45f5a98817aac019f1659ff91f0bfc22da68cdbef1d9ad1ae6ceee8cb8` |
| Workflow DB | `/home/long/.chat-on-steroids/agent-orchestrator/workflow.db`, opened read-only |
| SQLite integrity / FK violations | `quick_check = ok` / 0 |
| Jobs / events / tasks | 136 / 5,304 / 1,277 |
| Artifacts / results | 867 / 908 |
| Executing jobs / running tasks / active leases | 60 / 61 / 0 |
| Active / awaiting-dispatch / completed / failed jobs | 84 / 24 / 39 / 13 |
| Current liveness diagnostics (`stale_after_ms=900000`) | 84 active jobs considered; 60 `stale_candidate_reconciliation_required`, 6 `awaiting_dispatch`, 18 `awaiting_proposal_or_approval`; 0 active leases |
| Active runtime trust settings | All six whitelisted variables absent: versioned JSON configs and legacy provider/root variables for both source verifier and action reviewer |
| Persisted Goal/Idea nodes / edges / memberships / revisions (fresh read-only DB query) | 0 / 0 / 0 / 0 |
| Current live verifier available | `false`; no trusted live verifier root is configured |
| Source graph search | 0 nodes / 0 edges; no usable verified node IDs |
| Historical planner telemetry | 48 runs, 373 evidence rows, 28 rows with verified artifact lineage but unverified claims, zero `claim_verified` rows; telemetry rows are not a persistent shared Goal/Idea graph |
| Current AGG graph/proposal event types in `events` | 0 matching `adaptive_goal`, `plan_graph`, `execution_graph` or `knowledge_graph` event types; 136 generic `job.proposal_requested` events do not prove an AGG Plan/Execution Graph chain |

The latest preflight was rerun at `2026-10-26T07:10:49.127Z` against candidate SHA `e143e722aa46322b0ac558e0ed43cf00aa035b7e6fa4907b6919824e197998fd` and the original RC.5 rollback MCPB. The report is `artifacts/adaptive-goal-graph/rollout-preflight-v15-anchor-diagnostic-20261026T071100Z.json`, SHA-256 `f1b220572569e1f9471328b1896d0069bff34121b707091a61ce65c1463cf185`. It returned exit code `3`, `readOnly = true`, `liveMutationPerformed = false`, `decision.status = BLOCKED`, `canActivateNow = false`, with these blockers:

- `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`
- `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`
- `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`
- `RUNNING_TASKS_MUST_DRAIN`

The preflight verified the candidate's 92-entry ZIP, version and selected entry point, plus rollback bundle SHA-256 `dc11aa4a24ec26c58dbdc3c90a8e7fa73c81f94c00f1b473143fa93123b4cca1`, RC.5, smoke PASS and installed-file parity `84/84`, zero mismatches. The active runtime's trust report is `BLOCKED` with `AGG_TRUST_CONFIG_NOT_CONFIGURED`; the external anchor is `NOT_CONFIGURED` and now advertises contract `host-monotonic-trust-ledger-checkpoint/v1` plus its required report fields even when trust JSON is malformed or absent. The repository validates report shape, freshness and exact candidate/rollback hash binding but does not cryptographically verify a host checkpoint. No host-provisioned monotonic service, out-of-band verification key or host UI provisioning contract is observed; local SQLite append-only history alone is insufficient for production readiness.

The latest durable read-only reconciliation report is `artifacts/adaptive-goal-graph/live-reconciliation-v15-20261026T070200Z.json`, SHA-256 `f5083bbf75ced8211a8dabe4c5cdeba987c9cb9e01fd6db53091eea3897af906`. It independently read the workflow DB and found 84 active jobs considered: 60 `stale_candidate_reconciliation_required`, 6 `awaiting_dispatch`, 18 `awaiting_proposal_or_approval`; all 60 stale candidates have running tasks without active leases. It generated 84 deterministic, non-authorizing `HOLD_FOR_OWNER_RECONCILIATION` plans. The current schema counts are 136 jobs, 5,304 events, 1,277 tasks, 867 artifacts, 908 results, 982 attempts, 118 approvals and zero lease rows. Completion-event correlation was performed from durable event records, not only a recent-event window. The schema has no authoritative owner/provider identity columns; process observations are not identity-verified. Report is read-only and does not establish worker death, task success or authority to terminalize.

The fresh read-only evidence assessment is `artifacts/adaptive-goal-graph/live-evidence-assessment-v15-20261026T071000Z.json`, SHA-256 `75b0e05f89147f00ce128eb43e2a12691d9c04ef88b45765849837845f828f9d`. Across 373 planner-telemetry evidence rows, 28 have verified artifact lineage but unverified claims, one has invalid artifact lineage, one source has a hash mismatch, four sources have verified bytes but unverified claims, and four sources are unavailable/out of scope. `claim_verified = 1` appears zero times. There are 14 distinct artifact references (13 lineage-valid, one invalid). Declared references, 64-character hash shape, and source-byte integrity do not establish claim truth. Do not promote these telemetry rows to supporting evidence for a live Plan Graph.

The host-connected `adaptive_goal_knowledge_search` was queried with unverified/recovery results included and returned zero nodes, zero edges and zero usable verified node IDs; `verifierAvailable = false`. The live `workflow_list`/`workflow_liveness_diagnostics` agreed on 84 active workflows, 60 executing/stale candidates, 6 awaiting dispatch, 18 awaiting proposal/approval and zero active leases. A read-only `adaptive_goal_execution_graph_proposal_get` check for the approved Plan Graph Draft Compatibility workflow returned `EXECUTION_GRAPH_PROPOSAL_NOT_FOUND`. A separate read-only event query found no event types matching `adaptive_goal`, `plan_graph`, `execution_graph` or `knowledge_graph` in the workflow event table. These observations do not imply that worker outcomes can be inferred or safely terminalized.

The `workflow_liveness_diagnostics` snapshot at `2026-10-26T05:21:32.127Z` is read-only. It marks the 60 executing jobs as stale **candidates**, not proven-dead workers. Representative `workflow_diagnose` inspection found two older workflows where task records were already complete yet the job remained `EXECUTING`; one has a reviewer `needs_changes` security blocker and an immutable `standard-engineering@1` plan that does not support in-place rework. This makes a generic “wait until they drain” instruction inadequate: each stale candidate needs host/owner reconciliation and its documented normal lifecycle decision. A missing lease or stale timestamp is not permission to kill a worker, fabricate completion, or write terminal state directly. No such resolution was performed.

## Evidence still missing in live Goal/Idea → Plan → Execution chain

The live Plan Graph candidate has zero `supportingEvidenceRefs`; each of the nine roles currently reports `evidenceAssessment.status = missing`, `verifiedReferenceCount = 0`. A readiness check reports `contractReady = true`, `evidenceReady = false`, `status = contract_ready_evidence_pending`, `readyForExecutionGraphReview = false`, with nine `STEP_EVIDENCE_MISSING` blockers. No live Execution Graph proposal exists (`EXECUTION_GRAPH_PROPOSAL_NOT_FOUND`), and no immutable execution plan/approval/dispatch was created for either identified review job.

The nine real artifacts required before Execution Graph creation remain:

| Role | Required typed evidence |
|---|---|
| `standard-product-owner` | `requirements`: `scope`, `acceptance_criteria`, `non_goals` |
| `standard-researcher` | `research`: `findings`, `sources`, `limitations` |
| `standard-architect` | `architecture`: `components`, `interfaces`, `failure_modes`, `implementation_boundary` |
| `standard-engineer` | `implementation`: `summary`, `files_changed`, `verification`, `execution` |
| `standard-security` | `security-review`: `threats`, `findings`, `decision` |
| `standard-qa` | `qa-report`: `checks`, `results`, `decision` |
| `standard-platform` | `platform-review`: `runtime`, `deployment`, `recovery` |
| `standard-writer` | `documentation`: `summary`, `user_facing_changes`, `verification` |
| `standard-reviewer` | `review`: `requirementsSatisfied`, `architectureConformant`, `securityAccepted`, `qaAccepted`, `platformAccepted`, `documentationAccepted`, `implementationIssues`, `evidenceIssues`, `securityIssues`, `blockingIssues`, `decision` |

Each artifact must be created by the mapped successful producer task/result/attempt and bound to exact typed artifact bytes, schema, result lineage, artifact-created event, completion event, role/workflow contract and DAG prerequisites. Then a separately administered verifier must truthfully adjudicate claim correctness and evidence independence and sign the *exact current* Goal/Idea snapshot/evidence manifest. Production reviewer identity requires a different, separately trusted provider and its own action-candidate attestation. An RC.8 test result or source hash is not any of these missing facts.

## Authorized path to activation

1. Reconcile each of the 60 `stale_candidate` jobs through `workflow_get`, `workflow_events`, `workflow_diagnose`, host-side worker inspection and the responsible workflow owner. Do not bulk-reset state or treat zero leases as proof that every in-progress execution is safe to terminalize. Preserve exact attempt/result/event lineage and use only an authorized normal lifecycle path once the underlying outcome is established.
2. Have administrators provision schema-valid versioned JSON config `AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON` and `AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON` for separately administered providers, after the host's supported plugin/process environment mechanism is confirmed. Validate the pair with `node scripts/validate-agg-trust-config.mjs --domain goal_idea_verifier --config /secure/admin/source-verifier-trust.json --peer-config /secure/admin/action-reviewer-trust.json` and repeat in the reverse domain order. A single-file `PASS` is only `SINGLE_CONFIGURATION_ONLY`. The two JSON configs must use different provider IDs and disjoint canonical DER/SPKI Ed25519 root fingerprints. Keep signing private keys with the external provider services, not in the plugin or MCP payloads.
3. Populate current typed producer evidence through the normal workflow lifecycle; obtain a fresh external signature over the current Goal/Idea snapshot and evidence manifest; then re-project/review/approve the Plan wrapper (which still does not authorize dispatch), create the Execution Graph only after all nine evidence contracts pass, review action intents, and obtain a fresh reviewer attestation for the exact candidate and plan.
4. The host administrator/security owner must publish and provision the independently protected monotonic checkpoint service and out-of-band verification key; the host plugin manager must verify the signed checkpoint and bind it to the exact candidate/rollback hashes. The repository currently has only the report-shape contract and always blocks because the cryptographic host verifier is not implemented or provisioned. Rerun preflight after both trust configs, anchor integration and lifecycle reconciliation are independently verified. Only if it reports `READY_FOR_HOST_MANAGED_ACTIVATION` may an authorized operator use the Chat On Steroids UI to install/update the MCPB. This repository has no live activation command.
5. After a host-managed update, check `verify-installed`, entry-point/version parity, live health, and before/after workflow DB baselines. If anything differs, stop and restore the verified RC.5 rollback through the host UI.

No commit/reset/cleanup was performed in this work. Existing dirty and untracked worktree contents were preserved; `server/index.js` remains at SHA-256 `aa2b8f45f5a98817aac019f1659ff91f0bfc22da68cdbef1d9ad1ae6ceee8cb8`, RC.7 remains at `c877b42560e4c0e33d015195b44bc98fdc1ac4f240f9e8e3c55b13177a74ed69`, and benchmark fixtures v7-v14 are byte-identical to their recorded historical identities. v15 is the current successor and future provenance changes should create v16.
