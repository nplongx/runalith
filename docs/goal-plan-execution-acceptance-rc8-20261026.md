# Goal/Idea → Plan → Execution Graph acceptance dossier — RC.8

Generated: 2026-10-26 15:05 +07:00

**Overall: BLOCKED. Production three-graph E2E: NOT VERIFIED. Activation not authorized.**

## Candidate and rollback

- Candidate: `artifacts/mcpb-candidate-build-20261026T1455+0700/runalith-1.0.9-rc.8-goal-plan-execution-verified-20261026.mcpb`
- Version: `1.0.9-rc.8`
- Candidate SHA-256: `e143e722aa46322b0ac558e0ed43cf00aa035b7e6fa4907b6919824e197998fd`
- Source snapshot SHA-256: `83e87d193d0bf45ac6c530dbb0ced90ceca28f1f6fe84b0639b9e10b9541a558`
- Source alignment: PASS; 92 ZIP entries, 74/74 MCP tools; isolated MCP fast test PASS.
- Installed generation: FILES_MATCH_EXACTLY; 92/92 files matched, zero mismatches. This proves file parity only, not live graph E2E.
- Rollback snapshot: `/tmp/runalith-1.0.9-rc.8-current-installed-baseline-rollback-20261026T1508Z.mcpb`
- Rollback SHA-256: `9ad23a622967f3a2fe2117511ab86c2d3036bd14630cfaee144a44cedec2d803`; version 1.0.9-rc.8; smoke PASS; installed file parity PASS. It is a content-derived snapshot, not original publisher MCPB bytes or publisher attestation.

## Verification

| Check | Status | Evidence |
|---|---|---|
| `npm test` | PASS | exit 0; `artifacts/adaptive-goal-graph/final-verification-20261026T1505+0700/npm-test.log` |
| Three-graph isolated E2E and negative controls | PASS | private disposable DB; test-only trust; not production dispatch |
| Rollout regression | PASS | 7/7 |
| Benchmark provenance successor v16 | PASS | 14/14; [fixture](../benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v16.json) |
| Package reproducibility | PASS | `artifacts/adaptive-goal-graph/final-verification-20261026T1455+0700/package-reproducibility.log` |
| Documentation links | PASS | 332 Markdown files, 274 local links |
| Source-to-bundle alignment | PASS | Local-only evidence: `artifacts/adaptive-goal-graph/source-alignment-20261026T1455+0700.json` (not distributed in Git) |
| MCP fast test / ZIP integrity | PASS | 74/74 tools, 92 entries |
| Historical fixture v14 | PASS | `224787fe0cc6be275217d6a55d19f988354ce90323a6db6ff46ea577aed09ac6` |
| Historical fixture v15 | PASS | `8426c48bd5c1a583cd80a6b1e417fc837da0e89ac3d297fc71ecf7edda3e66c4` |
| Successor fixture v16 | PASS | `24ea4df5b4e6af26c99b31b92bd31934dcba26b41e11a9744ccd2b2164d9d453` |
| Read-only installed parity | PASS | Local-only evidence: `artifacts/adaptive-goal-graph/verify-installed-20261026T1455+0700.json` (not distributed in Git) |
| Rollout preflight | BLOCKED | Local-only evidence: `artifacts/adaptive-goal-graph/rollout-preflight-current-baseline-rollback-20261026T1508Z.json` (not distributed in Git) |

## Live reconciliation

Read-only report (local-only evidence, not distributed in Git): `artifacts/adaptive-goal-graph/live-reconciliation-20261026T075800Z-final.json`.

- Generated: 2026-10-26T07:58:58.832Z; read-only; no lifecycle mutation.
- Counts: 136 jobs, 5304 events, 1277 tasks, 908 results, 867 artifacts, 982 attempts, 0 lease rows, 118 approvals.
- 84 active jobs considered: 6 awaiting dispatch, 60 stale candidates requiring reconciliation, 18 awaiting proposal/approval.
- All 84 owner identities remain UNKNOWN because authoritative owner/provider identity is not persisted. PID/command hash are observations only.
- 60 jobs show running tasks without active leases, missing execution metadata and active attempts without active leases. Treat as CONFLICTING lifecycle signals; not proof of worker death.

## Evidence classification

- **CONFIRMED:** host health is OK; installed RC.8 generation matches candidate files; isolated three-graph E2E and negative tests pass.
- **MISSING:** independent Goal/Idea verifier and reviewer trust configs; active lease rows; live plan/execution graph proposals for inspected existing job; verified supporting evidence and predecessor artifact lineage for live Plan Graph.
- **UNKNOWN:** worker/provider identity; external monotonic trust-ledger checkpoint authenticity; claim truth and evidence independence for caller-authored graph nodes.
- **CONFLICTING:** 60 active/executing job records report running tasks while lacking active leases and execution metadata. No automated recovery action is authorized.

## Rollout blockers

- `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`
- `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`
- `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`
- `RUNNING_TASKS_MUST_DRAIN`
- `CANDIDATE_VERSION_ALREADY_INSTALLED`

Preflight exit: 3. `readOnly=true`, `liveMutationPerformed=false`. No install, activation, restart, dispatch, registry write, or workflow DB write performed.

## Required remediation

- Host administrator must provision independently administered verifier and reviewer JSON trust configurations with distinct provider IDs and disjoint canonical Ed25519 SPKI roots; private keys stay with authorities.
- Provide a host-supported independent cryptographic verifier for monotonic trust-ledger checkpoints, including anti-rollback state and signed checkpoint evidence.
- Workflow owners must reconcile the 60 active/executing records against authoritative provider/runtime events, lease/attempt/result/artifact lineage and independently bound worker identity. Do not bulk-reset, retry, terminalize, or dispatch.
- Collect fresh trusted supporting evidence for all Plan Graph steps and verify predecessor artifact lineage; then create/revalidate a live Plan Graph and Execution Graph proposal through supported APIs.
- Candidate version is already installed with identical file bytes. Do not activate/restart solely to make the version number change; rerun preflight only after genuine release changes and blockers resolve.

The detailed trust provisioning contract, pair-validation command, rotation/revocation checklist and independent checkpoint requirements are documented in [the production trust runbook](agg-production-trust-provisioning-runbook.md). It is operator guidance only; it does not provision trust or assert that any authority has completed provisioning.

Machine-readable dossier (local-only evidence, not distributed in Git): `artifacts/adaptive-goal-graph/acceptance-dossier-20261026T1505+0700.json`.

## Follow-up verification — 2026-10-26 15:18 +07:00

The trust CLI contract was tightened with `--require-peer-config`; the compatible one-file validation mode remains available but cannot satisfy the production pair-separation check. See [the provisioning runbook](agg-production-trust-provisioning-runbook.md).

- Current candidate package: `artifacts/mcpb-candidate-build-20261026T1512+0700/runalith-1.0.9-rc.8-goal-plan-execution-trust-pair-v17.mcpb`, SHA-256 `e1f49add15aaac00fa6924abbf630e41da01e552cf4f1b72639d7eb4b77dd776`; source alignment PASS, 92 entries, 74 tools, isolated MCP fast test PASS.
- **Important parity distinction:** the new candidate contains the updated trust regression test. Read-only `verify-installed` therefore reports one package-file mismatch at `tests/test-adaptive-goal-trust-configuration.mjs`; the installed RC.8 runtime entry-point hash remains `0d50fd4760fd2b6374980cc375e054562cc5b6d3f68895492b8497bb1e190e8b`. The previous candidate's 92/92 file-parity result does not apply to this successor package. Do not activate or reinstall it: its version is already installed and rollout remains blocked.
- Full `npm test`: exit 0; log: `artifacts/adaptive-goal-graph/final-verification-20261026T1518+0700-npm-test.log`. Trust-specific suite: 11/11; benchmark provenance v17: 14/14; package reproducibility PASS; docs check PASS (333 Markdown files, 277 local links); `git diff --check` PASS.
- Fresh read-only reconciliation at `2026-10-26T08:08:37.869Z`: 136 jobs, 5304 events, 1277 tasks, 908 results, 867 artifacts, 982 attempts, 0 lease rows, 118 approvals; 60 active `EXECUTING` jobs and 61 running tasks remain without active leases. This is still conflicting lifecycle evidence, not proof of worker death.
- Fresh preflight at `2026-10-26T08:15:26.963Z`: exit 3, `BLOCKED`; trust configuration and external checkpoint remain unverified, executing jobs/tasks have not drained, and `1.0.9-rc.8` is already installed. No live workflow DB write, registry write, host restart, activation or production dispatch was performed.

Machine-readable follow-up dossier (local-only evidence, not distributed in Git): `artifacts/adaptive-goal-graph/acceptance-dossier-20261026T1518+0700.json`.

## Follow-up hardening — 2026-10-26

Three implementation gaps found during the next audit were fixed in the working tree:

- `scripts/runalith-rollout.mjs`: checkpoint report shape and caller-supplied `verified`/`signatureVerified` booleans can no longer make `evaluateRolloutGate()` READY. Until an authenticated host-owned cryptographic verifier and protected monotonic store are integrated, the validator always reports `verified: false` and `EXTERNAL_TRUST_ANCHOR_CRYPTOGRAPHIC_VERIFIER_NOT_CONFIGURED`.
- `src/runtime/adaptive-goal-knowledge-verifier.js`: the verifier constructor now requires an explicit trust-ledger connection distinct from the Goal/Idea workflow DB. The RC.8 entry point already provides its separate trust DB; a generic caller can no longer silently default anti-rollback history to the graph/workflow connection.
- `src/runtime/adaptive-goal-graph.js` and `src/runtime/adaptive-goal-evidence-lineage.js`: graph validation now rejects a non-`goal` goal endpoint and identical start/goal IDs; remote `task.completed` lineage now requires a non-empty provider run ID that exactly matches the durable attempt. Local `task.local_completed` retains its separate no-remote-run contract.

Regression coverage includes self-asserted checkpoint booleans, wrong graph endpoint type/equal endpoints, same-DB trust ledger, and absent/blank remote provider run IDs. Focused verification passed 45/45 tests across graph, verifier, evidence-lineage and rollout suites. Benchmark provenance v18 was created as a successor; v14-v17 remain immutable.

- Candidate successor: `artifacts/mcpb-candidate-build-20261026T1540+0700/runalith-1.0.9-rc.8-goal-plan-execution-checkpoint-hardening-v18.mcpb`, SHA-256 `ba138e65075d7875ccc5389e7b74bb73cbe30511b9f9af012bb91e2f80e0e44b`, source snapshot SHA-256 `ebbde4b4f7da2befb9c8e3121623025191a2c3816d1f8adc532f5ba91e0cbb47`, 92 entries / 74 tools. Package build and archive-extracted mandatory tests passed; the version remains RC.8 and must not be reinstalled.
- Benchmark provenance v18: `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v18.json`, SHA-256 `b21556ed797f94743c04a4d1e434f8e7173cb54a7764e78962d777e5f486ae4d`; benchmark suite 14/14 passed.

Production remains BLOCKED. This hardening intentionally removes the fake positive path for checkpoint JSON; only a real host-managed cryptographic/monotonic verifier can clear that blocker. Full-suite and fresh read-only preflight evidence are recorded in the v18 machine-readable dossier.

Machine-readable v18 dossier: `artifacts/adaptive-goal-graph/acceptance-dossier-20261026T1545+0700.json` (candidate SHA-256 `ba138e65075d7875ccc5389e7b74bb73cbe30511b9f9af012bb91e2f80e0e44b`). The fresh preflight at `2026-10-26T08:33:29.817Z` returned exit code 3 and `BLOCKED` with the five blockers listed above. The fresh read-only reconciliation at `2026-10-26T08:33:38.863Z` still found 60 `EXECUTING` jobs with running tasks but no active leases, plus 6 awaiting dispatch and 18 awaiting proposal/approval. It did not mutate workflow state or grant recovery authority.
