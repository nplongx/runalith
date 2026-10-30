# Runalith RC.64 rollout dossier — 2026-10-29

**Decision: BLOCKED.** `canActivateNow=false`; `productionAuthorityGranted=false`. This is a local engineering and acceptance dossier, not an approval, signature, builder receipt, production attestation, or host activation request.

## Candidate identity and scope

- Local candidate: `dist/runalith-1.0.9-rc.64-bounded-stdio-backpressure-20261029.mcpb`
- SHA-256: `beb87e245de773cf15fde26d63276353f8206d36673b002543efd54a849ec112`
- Size: 951,431 bytes; 105 archive entries; 74 manifest/runtime tools.
- Selected runtime: `server/index-v1.0.9-rc.64.js` (SHA-256 `80f408b3dbbb5537821e9132624f7e524fb5ea87df6b33a3a6e48335fb530ba7`).
- Exact source-to-archive byte alignment passes for this candidate (`source-alignment-rc64-final-20261029T101430Z.json`, SHA-256 `0f31f32846441c49629c229351164708effb912174dc668858ca9abb1f4aab8e`; source snapshot SHA-256 `1a2d85844001594f538c1f510985dc9c7b693365a8a8983b0570af6d5db56683`). Its source provenance describes a dirty working tree and no authenticated build receipt; release eligibility remains blocked.
- The archive is local and has **not** been published, installed, enabled, activated, or used to dispatch production work. RC.23, RC.26, and RC.63 remain untouched historical artifacts.

## Engineering changes and CodeGraph trace

| Finding | Implementation and regression | Acceptance meaning |
|---|---|---|
| An absent current-source-aligned archive caused the inventory-builder security test to abort before exercising its positive path. | `benchmarks/plugin-workflow-benchmark/test-create-phase2-candidate-inventory.mjs`; source/archive byte guard remains in `create-phase2-candidate-inventory.mjs:134`. Without an aligned release archive, the test builds an ephemeral exact-source fixture outside `dist/`, labels it non-release, and removes it. A caller-pinned mismatched archive still fails. | `npm run test:phase2-security-regressions` passes on RC.64 and still reports `frozen_inventory_count_mismatch`: 105 entries versus the frozen 71. No trimming, inferred path list, or contract waiver. |
| Stdout backpressure could pause stdin before EOF was observable, leaving shutdown without a bounded failure path. | `server/index-v1.0.9-rc.64.js:7090-7125`; `tests/test-mcp-eof-shutdown-framing-20261017.js`; `tests/test-mcp-shutdown-backpressure-deadline-20261017.js`. The blocked write has a bounded deadline (150 ms only in the explicit test harness; 30 s otherwise) and timeout fail-stops the process. Tests still require exit code 1, no signal-based false success, and an explicit diagnostic. | Isolated regression and archive-extracted tests pass. This bounds local process lifecycle; it does not prove that any external provider effect did or did not occur. |
| Benchmark source pins must advance without rewriting historical evidence. | The active recovery benchmark now uses `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v111.json`. The graph/task identities, evidence requirements, and scoring oracle are preserved. | Benchmark provenance/negative tests pass. v108 (`c9dbc751818709abb07f7861febc07e0b1a4f38fbb4b4ddde043d7195a190cc2`), v109 (`f33d3556047172efa80a9de1ba04e87e4b84dba2d886f1ffce4b3dd3a201daf8`), and v110 (`69fcf491e8782df86dfb0ddd8db5a78db1016480961a1bd7ccfb49a3ab4b1a6f`) remain byte-for-byte preserved. The failed RC.64/v110 run with `PROVENANCE_SOURCE_HASH_MISMATCH: package.json` remains in `npm-test-rc64-20261029T100605Z.log`; v111 records the RC.64 package pins instead of rewriting v110. |
| Goal/Idea → Plan → Execution Graph security boundary must remain connected end to end. | `tests/test-adaptive-goal-current-scope-producer-e2e.mjs` and `tests/test-adaptive-goal-execution-graph-proposal.js`; the RC.64 package validation log records `AGG_THREE_GRAPH_CHAIN=PASS`, typed artifact lineage and nine actions. The full suite also passes the separate snapshot-verifier, reviewer-identity, immutable-plan, trust and proposal regression suites. Negative controls reject unverified source plans without persistence. | Local deterministic/test-root E2E passes. It does not establish production trust, release authority, or permission to dispatch production work. |

CodeGraph was synced after the code/fixture changes. Its file-mode view shows the exact RC.64 backpressure timeout and fail-stop code; its file-level dependency report does not statically connect the dynamically selected manifest runtime to the spawned-process regression tests. That graph limitation is recorded rather than represented as a missing test: the two tests above select the runtime from `plugin/manifest.json`, and the extracted-package validation ran those exact packaged bytes.

## Validation evidence

The machine-readable acceptance index and per-command logs live under `artifacts/adaptive-goal-graph/run-baseline-integrated-20261029T1535+0700/`. The index binds the actual command, exit code, artifact path/hash, freshness, and limitations. Key outcomes:

- `npm test` on package version `1.0.9-rc.64` and fixture v111: **PASS, exit 0** (`npm-test-rc64-v111-20261029T100907Z.log`).
- `node --test tests/test-adaptive-goal-benchmark.mjs`: **PASS, 15/15** (`benchmark-v111-regression-20261029T100858Z.log`).
- `npm run test:phase2-security-regressions`: **PASS, exit 0** (`phase2-security-rc64-20261029T095816Z.log`); contract result still blocked at 105 versus 71 entries.
- Local package build with archive-extracted smoke, schema, lifecycle, trust, recovery, and graph E2E checks: **PASS, exit 0** (`package-rc64-build-retry-20261029T095630Z.log`).
- `npm run test:package-reproducibility` against the current v111 source snapshot: **PASS, exit 0** (`package-reproducibility-final-20261029T101505Z.log`).
- `node tests/test-package-no-overwrite.js` against the current source snapshot: **PASS, exit 0** (`package-no-overwrite-final2-20261029T101747Z.log`).
- RC.64 source alignment: **PASS exact archive-entry bytes**, 105 entries, 74 tools (`source-alignment-rc64-final-20261029T101430Z.json`). This is not authenticated build provenance.
- RC.23 and RC.63 source-alignment negative controls: both **exit 1 as expected**, rejecting current manifest/archive byte mismatches (`source-alignment-rc23-fresh-20261029T100554Z.log`, `source-alignment-rc63-fresh-20261029T100554Z.log`).
- Pinned RC.63 candidate-inventory negative control: **exit 1 as expected**, with `source/archive bytes differ` (`pinned-rc63-lineage-negative-20261029T095918Z.log`). The byte-lineage guard was not weakened.
- Documentation/link check: **PASS, 170 Markdown files / 363 local links** (`docs-check-final3-20261029T101907Z.log`). Final `git diff --check` passes (`git-diff-check-final3-20261029T101907Z.log`); CodeGraph is up to date after the v111 fixture and dossier changes (`codegraph-sync-final-20261029T101403Z.log`).

## Fresh operational and host-trust evidence

The latest read-only workflow reconciliation is `workflow-reconciliation-current-20261029T100500Z.json` (SHA-256 `8fc0488b8e29617cfdab75346b2e58b1432dd63d07325bc04fbccd551203f2ab`). It observed 86 jobs: 60 stale candidates requiring owner reconciliation, 7 awaiting dispatch, and 19 awaiting proposal/approval. It observed 736 tasks, including 61 running tasks without active lease rows or execution metadata, and **zero authoritative terminal dispositions**. It is diagnostic-only and reports no lifecycle mutation.

The presence-only host trust snapshot is `current-host-trust-presence-20261029T100522Z.json` (SHA-256 `383d6f3a314f0a2c4d97fedb41f6cf394f6a7f1c5d913dd6eea005460cfed243`). The inspected trust environment variables are unset and the required `/etc/runalith` policy files and `/usr/local/libexec/runalith/external-checkpoint-adapter` are absent. This does not prove the state of an external checkpoint; it shows the required host-managed trust path is not available for verification here.

The final read-only rollout preflight is `preflight-rc64-final-20261029T101418Z.json` (SHA-256 `0c39d8bfea52787744ec6c603c73ce9bc80a0c3c53b515e747877b2bc2165668`); exit code 3 is the expected blocked decision. `liveMutationPerformed=false`, `workflowDatabaseMutationPerformed=false`, `externalSecurityStoreMutationPerformed=false`, and external checkpoint transition is `NOT_REQUESTED`.

## The six release blockers and accountable dependency

1. **`PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — contract owner.** Supply the authoritative, canonical 71-path manifest and its required owner signature. A count of 71 is not a path list. RC.64 has 105 entries; do not trim files or infer the contract.
2. **`INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — controlled builder and independent verifier/release approver.** Supply a signed builder receipt bound to exact RC.64 archive bytes and source snapshot, independently verified release evidence, and approval bound to the candidate, baseline, and rollback bytes. Local hashes, local tests, and this dossier are not substitutes.
3. **`PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — authorized production trust administrator.** Provision and verify the host-managed release/custody policy and distinct production verifier/reviewer roots using the supported administrator procedure. Do not reuse disposable test keys or provide secrets through MCP arguments.
4. **`PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — external checkpoint authority / host administrator.** Provision the host-managed external checkpoint adapter and trust configuration, then provide independently verifiable monotonic checkpoint continuity. No checkpoint transition was attempted.
5. **`ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — workflow/provider owners.** Reconcile all 60 flagged jobs and confirm provider/host state through the normal owner process. Seven awaiting-dispatch jobs and 19 proposal/approval jobs remain visible. Do not kill the runtime or infer that remote work stopped from local timestamps.
6. **`RUNNING_TASKS_MUST_DRAIN` — task/provider owners.** Resolve the 61 running tasks with missing active leases/execution metadata using authoritative execution/provider observations. There are zero authoritative terminal dispositions. A missing lease is not proof of worker death and does not authorize terminalization, retry, or replay.

## Safe remediation and revalidation order

1. Obtain the contract owner’s exact signed 71-path manifest; do not change the inventory guard.
2. Have the controlled builder build from the approved source snapshot and issue its signed receipt; have the independent verifier and authorized approver verify/bind the exact archive and rollback bytes.
3. Have the production trust administrator provision and independently verify the host-managed trust roots/policies and external checkpoint adapter/continuity. Do not run `--advance-external-checkpoint` during remediation until its explicit authorization and prerequisites are verified.
4. Have workflow/task owners reconcile live state. Preserve all ambiguous cases and prohibit automatic replay until terminal dispositions are authoritative.
5. Re-run source alignment, Phase 2 inventory/custody verification, acceptance consistency, and read-only rollout preflight against the exact candidate and tested rollback. Require all six blockers to clear before any separately authorized host-UI activation decision.

No production activation, live approval/dispatch, workflow mutation, trust-ledger write, external checkpoint transition, host registry/process mutation, or external candidate publication was performed in this run.
