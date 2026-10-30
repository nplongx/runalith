# Runalith RC.29 rollout dossier — 2026-10-28

## Decision

**`BLOCKED`; do not activate RC.29, edit host configuration, or dispatch production work.** RC.29 is a versioned successor to RC.28. It adds an explicit server-side trust boundary that prevents a caller-supplied or otherwise unverified legacy Plan Graph from being promoted into a persisted Execution Graph proposal. The same requirement is applied when an existing Execution Graph proposal is read back and rebuilt. A legacy Plan Graph may remain a review-only checklist; approving that checklist does not independently attest its source or grant AGG action authority.

## What changed

- Added `adaptiveGoalExecutionGraphSourceBlocker` to `server/index-v1.0.9-rc.29.js`. It requires the Plan Graph's current Goal/Idea snapshot record and verification metadata to bind exactly: snapshot hash, attestation ID, provider, canonical trust-root fingerprint, evidence-manifest digest, issued/expiry times and a live, non-empty signed verification state. The caller re-loads the stored Plan Graph through `readAdaptiveGoalPlanProposal`, which rebuilds the current snapshot and verifies the persisted attestation/evidence before this check.
- The Execution Graph proposal creation boundary returns `EXECUTION_GRAPH_SOURCE_ATTESTATION_REQUIRED` without creating a job if the binding is absent, stale, expired, legacy/unverified or mismatched.
- Execution Graph proposal readback uses the same gate and returns stale instead of accepting a proposal whose source binding no longer satisfies the exact current-snapshot contract.
- Added test-only SQLite E2E probes for both boundaries: approving a legacy review-only Plan Graph still does not materialize an Execution Graph; changing a persisted Execution Graph's source Plan binding to that legacy proposal makes readback stale. The test restores original event bytes before continuing the positive flow. Trusted Goal/Idea attestation → Plan Graph → reviewer-bound candidate → immutable plan approval → dispatch continues to be exercised in a disposable database only.
- Added `scripts/build-agg-live-remediation-plan.mjs`, which consumes a read-only dossier/reconciliation/preflight and writes a mode-0600, non-overwriting, machine-readable repair plan. It binds input path/digests, correlates source mismatches, missing Goal/Idea evidence, Plan Graph evidence/snapshot gaps, missing Execution Graph proposals, and per-job/task lineage. It does not open the workflow database or perform a repair.
- The remediation tool and its negative tests are bound by source-alignment inputs, packaged, and run against extracted archive bytes. `npm test` includes the new tests.

## CodeGraph trace and regression selection

The installed CodeGraph CLI 1.6.0 was synced after the RC.29 runtime and E2E edits. The index reported 482 files, 18,180 nodes and 81,664 edges, up-to-date. `codegraph callers adaptiveGoalExecutionGraphSourceBlocker --limit 20` showed the two enforcement call sites: Execution Graph proposal creation in `callToolImpl`, and `readAdaptiveGoalExecutionGraphProposal`. `codegraph affected -f 'tests/test-*.mjs' server/index-v1.0.9-rc.29.js tests/test-adaptive-goal-current-scope-producer-e2e.mjs` returned `tests/test-adaptive-goal-current-scope-producer-e2e.mjs`; that test is a mandatory part of `npm test` and the package-extracted validation. The CodeGraph result is dependency guidance, not production trust or release authority.

## Candidate identity and validation record

The successor archive is built at `dist/runalith-1.0.9-rc.29-authenticated-execution-source-gate-20261028.mcpb`. Its final SHA-256, size, entry inventory, manifest version/tool count, entry point, exact source-alignment report, reproducible-build result, full-suite exit codes, archive-extracted MCP test result, documentation checks, and fresh read-only rollout preflight are recorded in the RC.29 machine-readable validation evidence and dossier under `artifacts/adaptive-goal-graph/`. Those records must be produced from the actual archive before their values are considered established; a missing report is not a passing report.

The RC.28 archive remains immutable. RC.29 must be a separate output and must be checked with `unzip -t`, exact archive-entry/source byte alignment, SHA-256, a second independent rebuild, and `npm run test:mcpb-candidate`. The frozen Phase 2 71-path contract is not reinterpreted from whatever inventory the RC.29 archive happens to contain.

## Read-only live findings

The direct runtime observations in this work session report an active RC.26 host, an empty Goal/Idea evidence manifest for `runalith-agg-e2e-20261026-clean` (7 nodes, 7 edges, 7 memberships, zero evidence references), four planner source-hash mismatches, three Plan Graph proposals with 22/22 steps missing supporting evidence and no authenticated current-snapshot binding, and no persisted Execution Graph proposal. The effective verifier and reviewer trust configurations are blank. The current read-only liveness result classifies 60 jobs as stale/executing and observes 61 running tasks without active lease rows. These conditions require record-by-record owner/provider/runtime reconciliation; absence of a lease is not proof that a worker is dead.

The detailed per-job and per-task lineage and owner actions are captured in the fresh RC.29 reconciliation report and remediation plan. The report retains `HOLD`/no-authorization semantics. No live workflow database, plugin registry/configuration, trust ledger or external security store is mutated; no production package is installed, no host process is restarted or killed, and no workflow is dispatched.

## Six external release gates

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — Phase 2 contract owner, platform security and controlled builder must provide the real signed canonical 71-path manifest, candidate-bound builder receipt and host-pinned authority policy. Do not infer the path list or trim RC.29's archive.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — independent builder, verifier and release authority must attest exact candidate/baseline/rollback bytes and bind their signed evidence to a fresh host-issued nonce.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — host/security and the two independent verifier/reviewer authorities must provision the exact versioned public-key JSON configs; prove distinct provider identities, disjoint canonical Ed25519 roots, key validity/revocation, effective host configuration and matching append-only trust-ledger history.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — host/security and an independent checkpoint-store authority must supply the root-pinned adapter/policy plus fresh signed monotonic continuity and compare-and-swap/commit receipts. Ordinary preflight must stay read-only.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — each executing workflow requires authoritative owner/provider/runtime disposition and matching durable event/attempt/result/artifact lineage.
6. `RUNNING_TASKS_MUST_DRAIN` — every running task requires provider/runtime/lease-fencing reconciliation and an approved outcome. Missing lease or PID is not death proof.

Run the preflight only in read-only mode against the actual RC.29 archive and the exact archive whose bytes/version are proven to match installed RC.26. Exit `3` means the gate remains `BLOCKED`. Do not use test-local trust, successful tests, SHA-256 matches, or source-to-bundle alignment to close any external gate. No push or activation is part of this work.
