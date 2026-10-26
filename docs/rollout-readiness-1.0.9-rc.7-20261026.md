# RC.7 rollout-readiness evidence — 2026-10-26

> **Decision: BLOCKED for host activation.** RC.7 is built and passes isolated acceptance; the live plugin is still RC.5. The host currently owns 60 active `EXECUTING` workflows and 61 `running` tasks. No live installation, restart, registry edit, or workflow-database mutation was performed during this review.

## Candidate identity and source provenance

| Item | Observed identity |
|---|---|
| RC.7 MCPB | `/tmp/runalith-1.0.9-rc.7-plan-graph-rollout-ready-20261026T022148Z.mcpb` |
| Archive SHA-256 | `9cd9929229de8b43db6853fd5b98e17ac7252c61f75cc0d601b4aea35ff119dd` |
| Size / archive entries | 741,503 bytes / 85 entries |
| Manifest version / runtime entry | `1.0.9-rc.7` / `server/index-v1.0.9-rc.7.js` |
| RC.7 runtime SHA-256 | `c877b42560e4c0e33d015195b44bc98fdc1ac4f240f9e8e3c55b13177a74ed69` |
| Manifest tools / runtime tools | 70 / 70 |
| Source-alignment report | `PASS`; archive hash above; source snapshot SHA-256 `1235196a690a32f99d5d3401e93a6dd3b6cfa4e8bb9c26f4c6b4ab18990822e7` |
| Historical `server/index.js` SHA-256 | `aa2b8f45f5a98817aac019f1659ff91f0bfc22da68cdbef1d9ad1ae6ceee8cb8` — unchanged |
| RC.6 source SHA-256 | `e01ffc89b6d5e0f059bf0e40d54a65c2de15bc4b5eeff3ba4359bb71aa1cfee2` — preserved |
| Benchmark fixture v7 SHA-256 | `759ff96d88d670c91549f35f8df5898b61dabac4a5dc5db4b24bfccd9372da3f` — unchanged |
| Benchmark fixture v8 SHA-256 | `113062b7b387f883b237d7b95a0f53909d7f1e08b33b252bed4fc25510d40715` — unchanged |
| Benchmark fixture v9 SHA-256 | `115ba9f0ab8746df59eac3440443adb1d1f38a1f51159f1447a02f0cf83dd85f` |

Package construction ran `scripts/package-runalith-mcpb.sh`, verified source-to-archive byte alignment, ran the extracted archive's MCP initialization / `tools/list` / health check, checked 70/70 schemas, and ran the packaged regression suite. The selected runtime bytes inside the archive and the source file share the RC.7 SHA-256 above. The archive's `server/index.js` still hashes to the historical pin.

## Rollback package

The host registry points to an existing RC.5 archive at:

`artifacts/mcpb-candidate-build-20261025T131705Z/runalith-1.0.9-rc.5-current-scope-nine-child-integration.mcpb`

| Item | Observed identity |
|---|---|
| Registry-referenced archive SHA-256 (recomputed from current bytes) | `dc11aa4a24ec26c58dbdc3c90a8e7fa73c81f94c00f1b473143fa93123b4cca1` |
| Size / manifest version | 628,924 bytes / `1.0.9-rc.5` |
| Isolated extracted-runtime smoke | `PASS`; 70/70 manifest tools exposed |
| Installed generation file parity | `FILES_MATCH_EXACTLY`, 84/84 files, 0 mismatches |

The installed runtime generation's original MCPB-container hash is not stored in the host process metadata, so file parity is not proof of the original install container's byte identity. It does confirm that the current registry-referenced package has the same regular-file contents as the currently running generation and can serve as the rollback package. A separately generated content-derived fallback snapshot is available at `/tmp/runalith-1.0.9-rc.5-installed-generation-rollback-20261026T020000Z.mcpb`, SHA-256 `78eb13a888e398be3b86c3f0866d131b6da89533de440db2173216f3b5f3ebe9`; it is explicitly not the original MCPB container.

## Host process and rollout gate

Read-only inspection of `~/.config/chat-on-steroids/state/plugins.json`, `/proc`, the running generation, and the live workflow database reported:

| Check | Result |
|---|---|
| Host-owned app process | PID `13804`, `/opt/Chat On Steroids/chat-on-steroids` |
| Runalith runtime process | PID `13885`, parent PID `13804` (owner verified) |
| Currently running entry point | `/home/long/.config/chat-on-steroids/plugins/83ea5bbc-ce8c-4bd3-915d-d6cc8d270fe7/g-UgFZ6G/server/index.js` |
| Registry / installed manifest / package version | `1.0.9-rc.5` |
| Running entry-point SHA-256 | `aa2b8f45f5a98817aac019f1659ff91f0bfc22da68cdbef1d9ad1ae6ceee8cb8` |
| Database | `/home/long/.chat-on-steroids/agent-orchestrator/workflow.db`, opened read-only |
| SQLite checks | `quick_check = ok`, 0 foreign-key violations |
| Jobs / events / tasks | `136 / 5,304 / 1,277` |
| Artifacts / results | `867 / 908` |
| Active / awaiting dispatch / executing / completed / failed jobs | `84 / 24 / 60 / 39 / 13` |
| Workflow phase mismatches | `0` |
| Running tasks / active unexpired leases | `61 / 0` |

The non-mutating preflight used the exact RC.7 candidate hash and the registry-referenced RC.5 rollback bundle. Both packages passed isolated smoke, rollback file parity was exact, and the database integrity checks passed. Its exit code was `3` with `decision.status = BLOCKED`, due only to:

- `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`
- `RUNNING_TASKS_MUST_DRAIN`

The same RC.7 archive then passed private `/tmp` rollout simulations: success (`ROLLOUT_SIMULATED`), failure after staging (`switch-not-performed`), failure after switching (`rollback-performed`), and a simulated health failure (`rollback-performed`). Every failure path verified the prior RC.5 marker again. These are rollout state-machine tests, not a live host install. The plugin registry, running process, and live workflow database remain unchanged.

## Runtime/lifecycle contract covered by RC.7

The RC.7 successor entry point fixes the concrete RC.6 gap where generic review-wrapper approval could return `execution_authorized=true` and generic dispatch could start a Plan Graph review checklist. RC.7 now:

- revalidates the durable Plan Graph snapshot, draft hash, binding hash, current template and lifecycle on retries;
- requires a current approved/pinned Plan Graph before Execution Graph proposal creation;
- treats Plan Graph review approval as review-only and blocks dispatch of that wrapper;
- requires a fresh Execution Graph and, for action execution, a current trusted reviewer attestation, exact action-intent candidate, matching immutable plan and current approval before dispatch;
- compares durable candidate structures using canonical JSON rather than insertion-order-sensitive `JSON.stringify`, and retains tamper/staleness rejection;
- leaves dispatch and execution disabled for a review-only proposal.

Tests exercise concurrent first-proposal creation from independent MCP processes, database rollback on injected failure, stale/tampered snapshots, schema and evidence-lineage failures, reviewer identity/scope failures, plan pinning, concurrent approval, process interruption recovery, and no unauthorized dispatch. Reviewer attestations used by sandbox execution tests are signed under a **test-only** Ed25519 key; they are not production reviewer authority.

## Persisted Goal/Idea → Plan → Execution Graph status

The live plugin's `orchestrator_health` was independently queried over its host-connected MCP interface and reported `status=ok`, `mode=local-only-mcp`, version `1.0.9-rc.5`; it returned the same jobs/events/tasks counters as the read-only SQLite check.

| Graph / transition | Live persisted finding |
|---|---|
| Goal/Idea Graph knowledge store | `adaptive_goal_knowledge_nodes=0`, `edges=0`, `memberships=0`, `revisions=0`; read-only `adaptive_goal_knowledge_search` returned zero nodes and edges. The separate planner telemetry tables have 1,015 run nodes and 1,515 run edges, but those telemetry rows are not reusable Idea Graph knowledge or verification authority. |
| Candidate embedded in the Plan proposal | `agg-94586d4348b85b2829803c9f`, source graph hash `983b4d7586f3f264422a6d44a6d71887e1d2a2ffc5022652a1e6d4119e4247b9`, verification `unverified` / `verified=false`. It is a candidate snapshot, not a persisted verified Idea Graph node. |
| Producer workflow | `job_ff955e9d-4a95-4460-b84c-98fe2804c022` remains `IDLE / PROPOSED`, one event, no active task, no task rows, artifacts, immutable plan or approval. |
| Plan Graph proposal | `job_a3061f38-a579-4d0e-8636-9969943cf6bf` remains `IDLE / PROPOSED`, one proposal event, no tasks/artifacts/approval/immutable plan. Draft hash `c7a4bed65bf4c4b5f46c8e7893c6e9c5033efda28ade0948effd42fd2df66c39`; binding hash `3b7549e12b57d15fe31ee2913cdcdb6433079eef98574cf847d8ebffb3761a07`; fingerprint `a08a8eb801233a6e4cb6239a855a35094d21c7616dc6800652beb5048448e2f9`. |
| Evidence readiness | Structural/contract readiness `true`; evidence readiness `false`; status `contract_ready_evidence_pending`; `readyForExecutionGraphReview=false`. All 9 steps have empty `supportingEvidenceRefs`, `evidenceAssessment.status=missing`, and blocker `STEP_EVIDENCE_MISSING`. |
| Execution Graph proposal | Not present. Read-only get returned `found=false`, reason `execution_graph_snapshot_not_found`, blocker `EXECUTION_GRAPH_PROPOSAL_NOT_FOUND`. |
| Immutable execution-plan pin / action authority | No Plan Graph or Execution Graph immutable plan is pinned for the two identified jobs, no approvals, and no dispatch/task rows for them. No live approval/evidence/task/artifact has been synthesized. |

### Exact source-evidence contract still missing for each Plan Graph step

Each listed output contract is schema v1 from the live runtime readiness response. **Every one currently has zero declared evidence references, zero resolved active artifacts, and zero verified artifacts.** The required next input is a current durable artifact of the given type whose schema fields validate and whose producer task, successful result, attempt identity, artifact-created event, completion event, content hash, workflow contract and prerequisite lineage all match. A local test pass or a file hash alone does not replace that lifecycle evidence.

| Step / bound role | Required artifact (schema v1) and required content fields | Current blocker / collection requirement |
|---|---|---|
| `agg-step-c93fbc9cde5f55d9f2925daa` — `standard-product-owner` (`product.requirements`) | `requirements`: `scope`, `acceptance_criteria`, `non_goals` | `STEP_EVIDENCE_MISSING`; obtain the current-scope requirements artifact from a successful bound producer result, then verify the exact artifact/result/completion lineage. |
| `agg-step-d3a7071f012de681fb8b2d49` — `standard-researcher` (`research.collect`) | `research`: `findings`, `sources`, `limitations` | `STEP_EVIDENCE_MISSING`; collect source-backed findings with cited source references and explicit limitations; validate active artifact and producer lineage. |
| `agg-step-76e2c2014043af2f5a87a63c` — `standard-architect` (`architecture.design`) | `architecture`: `components`, `interfaces`, `failure_modes`, `implementation_boundary` | `STEP_EVIDENCE_MISSING`; collect the concrete component/interface and failure-boundary design, bound to the exact requirements/research dependencies. |
| `agg-step-d6ac97e2e825817fbc6c687f` — `standard-engineer` (`code.modify`) | `implementation`: `summary`, `files_changed`, `verification`, `execution` | `STEP_EVIDENCE_MISSING`; a future implementation artifact must report actual file changes/verification and exact successful result lineage, not this report's narrative. |
| `agg-step-acfa425dee7b297155e2231c` — `standard-security` (`security.audit`) | `security-review`: `threats`, `findings`, `decision` | `STEP_EVIDENCE_MISSING`; require a current scoped threat/finding review with explicit decision and bound implementation/dependency inputs. |
| `agg-step-ec43ed805271521924aa000c` — `standard-qa` (`code.verify`) | `qa-report`: `checks`, `results`, `decision` | `STEP_EVIDENCE_MISSING`; register exact command/result evidence and the actual QA artifact against the implementation attempt. |
| `agg-step-e1012463fde649e1be93d464` — `standard-platform` (`infrastructure.verify`) | `platform-review`: `runtime`, `deployment`, `recovery` | `STEP_EVIDENCE_MISSING`; validate the target runtime identity, host-owned rollout procedure and rollback/recovery assumptions with current evidence. |
| `agg-step-784dc815bdd71c7c6bfec85d` — `standard-writer` (`documentation.write`) | `documentation`: `summary`, `user_facing_changes`, `verification` | `STEP_EVIDENCE_MISSING`; collect the final user-facing behavior and verify exact docs/check output from the same source snapshot. |
| `agg-step-f6b9da6f3b17b2c6a21fd6c1` — `standard-reviewer` (`change.review`) | `review`: `requirementsSatisfied`, `architectureConformant`, `securityAccepted`, `qaAccepted`, `platformAccepted`, `documentationAccepted`, `implementationIssues`, `evidenceIssues`, `securityIssues`, `blockingIssues`, `decision` | `STEP_EVIDENCE_MISSING`; only a reviewer bound to the current upstream artifact lineage may accept/reject; a caller label or generic review-wrapper approval is not trusted action authorization. |

The valid next lifecycle is: (1) establish verified current-scope Idea Graph source evidence, (2) bind its real references to a freshly projected Plan Graph, (3) revalidate that snapshot and obtain explicit human approval of the *Plan review wrapper* (approval is not action execution authority), (4) rerun the durable-evidence/contract readiness check, (5) create Execution Graph only once every required reference resolves, (6) validate typed action intents and a trust-root-verified reviewer attestation, (7) preflight and explicitly approve the exact immutable action-intent execution plan, then (8) dispatch only if the current source, candidate, approval and plan hashes still match. The current live store fails at steps 1 and 5 because there are no verified Idea Graph nodes/edges and all nine Plan steps lack evidence.

## Validation record

Commands already run successfully in this candidate workspace include:

- `node --test tests/test-adaptive-goal-current-scope-producer-e2e.mjs`
- `node --test tests/test-adaptive-goal-benchmark.mjs` (14/14)
- `node --test tests/test-runalith-rollout.mjs` (5/5)
- `node tests/test-runalith-plugin.js` (full local MCP E2E, including review-wrapper dispatch denials and process-restart recovery)
- `PLUGIN_BUNDLE_OUT=/tmp/runalith-1.0.9-rc.7-plan-graph-rollout-ready-20261026T022148Z.mcpb bash scripts/package-runalith-mcpb.sh` (source alignment and extracted package/regression acceptance pass)
- `npm run docs:generate-reference` and `npm run docs:check` (70/70 registered tools; 328 Markdown files and 259 local links)
- `node scripts/runalith-rollout.mjs preflight ...` (expected exit code 3 because live work has not drained)
- `node scripts/runalith-rollout.mjs simulate ...` and failpoints `after-stage`, `after-switch`, `health-check` (success and exact prior-marker recovery)

Final validation after the last rollout-tool/test change: `npm test` exited `0`; `npm run docs:generate-reference` and `npm run docs:check` passed (70/70 tool reference, 329 Markdown files and 260 local links); `git diff --check` passed. The five rollout tests passed, the 14 benchmark/provenance tests passed, the isolated three-graph E2E passed, and the packaged RC.7 acceptance suite passed. The read-only live preflight still returns exit `3` because the active jobs/tasks have not drained. No install/restart/registry update/live workflow database write is part of this record.
