# Runalith RC.47 rollout decision — 2026-10-29

## Decision

**BLOCKED — do not install or activate.** RC.47 is a versioned successor to RC.46 because the packaged owner-guided remediation planner now reports Goal/Idea counts, evidence-reference counts, snapshot identity, and attestation eligibility only when they are present in the current reconciliation. Missing observations remain `null`; the planner no longer substitutes fixed counts.

Candidate: `dist/runalith-1.0.9-rc.47-goal-evidence-remediation-20261029.mcpb` (936,424 bytes; 103 ZIP entries; 74 registered MCP tools). Direct SHA-256: `c96827a6f94822d917153dcdb4be69315b9e51e33ae61b9ef2c152aab9d753aa`. Source snapshot SHA-256: `a2a3933be114cdd2822054f4d9a68f99b7bf4f027802534b21ec5cd705f71580`. Source alignment is exact for packaged bytes, but provenance remains `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`; this is not an authenticated release build.

This change affects diagnostics and recovery planning only. It does not create a Phase 2 contract, establish production trust, grant lifecycle authority, or authorize dispatch. Host-managed activation remains mandatory.

## Safety boundaries

- No production plugin registry/configuration, workflow database, trust ledger, external checkpoint, or host process was changed.
- Reconciliation is read-only. Missing lease rows are not proof of worker death.
- Do not bulk-reset, terminalize, retry, cancel, drain, approve, or dispatch live jobs/tasks from this report.
- Keep all historical archives, hashes, fixtures, and release records unchanged.

## Current live observation

The fresh read-only reports are `artifacts/adaptive-goal-graph/live-reconciliation-v1-rc47-rerun-20261029.json` (SHA-256 `d455f299bffcb28bf460a613392f8a2e73fbb24a4b7506eb41316a9887f50f36`) and `artifacts/adaptive-goal-graph/live-reconciliation-v2-rc47-rerun-20261029.json` (SHA-256 `704c43a8fac81fa255c42de17c1502c952d42f2e4b92ed25a2c54f9d10dd7002`). They observed 86 jobs in scope: 60 stale/executing reconciliation candidates, 7 awaiting dispatch, and 19 awaiting proposal/approval. The task-level reconciliation observed 61 running tasks without active lease rows. The graph reconciliation reports 60 jobs with running tasks lacking active leases; these are different job-level and task-level counts, not a contradiction. There are zero verified terminal dispositions in the local diagnostic. These observations do not establish remote execution outcomes.

The fresh read-only snapshot `artifacts/adaptive-goal-graph/live-snapshot-rc47-final-20261029.json` (SHA-256 `2a8c26d25b16f7a5fd4580fc9a9e360d6fb8c9e677d6592e200acb772aea9844`) confirms snapshot hash `80001cbece6811f7e3a0c187662393f05393ed11421767b23d76548c77c32bf3`, 7 nodes, 7 edges, 7 memberships and zero evidence-manifest entries; it remains unverified and ineligible for attestation. The current read-only process/config diagnostic is `artifacts/adaptive-goal-graph/trust-diagnostic-rc47-rerun-20261029.json` (SHA-256 `5fd9297624392d42e7538ac4c43abbe65d841d26bf01388751d6aa8efc3faf4d`). It observes the active host still running RC.26 and both JSON trust-config environment variables present but empty, with provider/root variables absent. It deliberately did not call the trust-status MCP operation because that operation appends to the trust ledger; no external checkpoint was queried.

## RC.47 engineering delta

`scripts/build-agg-live-remediation-plan.mjs` now reads the target Goal/Idea graph counts and evidence eligibility from the graph record in the supplied reconciliation. The repair step and summary use the same observed counts and snapshot hash. If the graph is absent, counts and eligibility are explicitly unknown rather than fabricated. Regression coverage tests both observed and missing-goal cases.

## Authority required to unblock

1. **Phase 2 contract:** the contract owner must provide the signed canonical 71-path manifest and candidate-bound builder receipt under host-pinned custody policy. Do not synthesize either locally.
2. **Independent release evidence:** controlled builder provenance, independent verification of exact RC.47 bytes/source, and release-authority approval bound to candidate, installed rollback baseline, and one-time host nonce.
3. **Production trust:** host/security administrators must provision and demonstrate both effective versioned verifier/reviewer configs, distinct providers, disjoint canonical SPKI roots, version-pinned append-only ledger history, rotation/revocation and anti-rollback.
4. **External checkpoint:** the independently operated checkpoint authority must supply signed fresh continuity and compare-and-swap evidence bound to the candidate/rollback and host-issued nonce. Local SQLite is not the monotonic external anchor.
5. **Workflow drain:** each of the 60 job candidates requires owner/provider/runtime-backed disposition and consistent event/attempt/result/artifact lineage.
6. **Task drain:** each of the 61 running tasks requires task owner, provider run, current runtime, result/artifact lineage and lease/fencing evidence. Missing leases alone do not authorize terminalization or replay.

## Revalidation

The candidate-bound source alignment is `artifacts/adaptive-goal-graph/source-alignment-rc47-final-20261029.json` (SHA-256 `a4a7d76f8cb27a0a572b525eee72bb38f55d3b856cecfadd7ecb53a763f0320f`). The readiness dossier is `artifacts/adaptive-goal-graph/agg-readiness-dossier-rc47-final-20261029.json` (SHA-256 `78c1ebbe034703026802fbbdd1ffb34d303ac26e6937d0e97b0aaa3935c66a5f`); the owner-authorized remediation plan is `artifacts/adaptive-goal-graph/agg-remediation-plan-rc47-final-20261029.json` (SHA-256 `a6eb785ffe3b220936712e26e483ca47d265e3f1f2353671a1e3d44952ff976a`). The machine-readable acceptance index is `artifacts/adaptive-goal-graph/acceptance-evidence-rc47-20261029.json` (SHA-256 `29d637d560539d423dc052a45dc7671e9b1cbc50bbfdcb91b7cba98dfef6edf5`); it records command exit codes, candidate/rollback hashes, live observations and the six blockers. Fresh preflight is `artifacts/adaptive-goal-graph/rollout-preflight-rc47-rerun-20261029.json` (SHA-256 `b7c3381310d6dde708225fb6f491a3724d9dd36c992ecb0ac272347372ffa90e`), exit code 3, `canActivateNow=false`, with all six blockers open. Rollback baseline RC.26 SHA-256 remains `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a`.

The full `npm test`, package validation suite, extracted-package acceptance, MCP fast test and reproducibility checks were run for RC.47. The source-alignment report confirms byte identity but explicitly does not provide an authenticated build receipt. Any changed candidate bytes invalidate candidate-bound release evidence and require fresh independent verification.

The rollout gate must remain `BLOCKED`, with `canActivateNow=false`, until all six authority-dependent gates are verified from trusted evidence and current workflow/task outcomes are resolved.
