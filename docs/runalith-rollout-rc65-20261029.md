# Runalith RC.65 rollout dossier — 2026-10-29

**Decision: BLOCKED.** `canActivateNow=false`; `productionAuthorityGranted=false`. This is a local engineering and acceptance dossier, not an approval, signature, builder receipt, production attestation, or host activation request.

## Candidate identity and scope

- Local candidate: `dist/runalith-1.0.9-rc.65-bounded-stdio-backpressure-20261029.mcpb`
- SHA-256: `50a92895a867119e03f20a5dcacdba0f06cde0027f730915828a51de2e60d985`
- Size: 951,431 bytes; 105 archive entries; 74 manifest/runtime tools.
- Selected runtime: `server/index-v1.0.9-rc.65.js` (SHA-256 `80f408b3dbbb5537821e9132624f7e524fb5ea87df6b33a3a6e48335fb530ba7`).
- Exact source-to-archive byte alignment passes for this candidate (`source-alignment-rc65-final-20261029T104207Z.json`, SHA-256 `f7d85716379d74d1e004ad9e996bf5b1c569f8ffe5385d654c77b0a31d91401f`; source snapshot SHA-256 `644a820db7a66bec5b3bfd519fd3787e0c00fb0235df67850947036a1a30ad02`). Its source provenance describes a dirty working tree and no authenticated build receipt; release eligibility remains blocked.
- The archive is local and has **not** been published, installed, enabled, activated, or used to dispatch production work. RC.23, RC.26, RC.63, and RC.64 remain preserved historical artifacts. The rollback-protected tracked `server/index.js` remains byte-identical at SHA-256 `aa2b8f45f5a98817aac019f1659ff91f0bfc22da68cdbef1d9ad1ae6ceee8cb8`; the hardening is in the manifest-selected RC.65 runtime, not that historical generation.

## Engineering changes and CodeGraph trace

| Finding | Implementation and regression | Acceptance meaning |
|---|---|---|
| An absent current-source-aligned archive caused the inventory-builder security test to abort before exercising its positive path. | `benchmarks/plugin-workflow-benchmark/test-create-phase2-candidate-inventory.mjs`; source/archive byte guard remains in `create-phase2-candidate-inventory.mjs:134`. Without an aligned release archive, the test builds an ephemeral exact-source fixture outside `dist/`, labels it non-release, and removes it. A caller-pinned mismatched archive still fails. | `npm run test:phase2-security-regressions` passes on RC.65 and still reports `frozen_inventory_count_mismatch`: 105 entries versus the frozen 71. No trimming, inferred path list, or contract waiver. |
| Stdout backpressure could pause stdin before EOF was observable, leaving shutdown without a bounded failure path. | `server/index-v1.0.9-rc.65.js:7090-7125`; `tests/test-mcp-eof-shutdown-framing-20261017.js`; `tests/test-mcp-shutdown-backpressure-deadline-20261017.js`. The blocked write has a bounded deadline (150 ms only in the explicit test harness; 30 s otherwise) and timeout fail-stops the process. Tests still require exit code 1, no signal-based false success, and an explicit diagnostic. | Isolated regression and archive-extracted tests pass. This bounds local process lifecycle; it does not prove that any external provider effect did or did not occur. |
| Benchmark source pins must advance without rewriting historical evidence. | The active recovery benchmark now uses `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v117.json`. Its SHA-256 is `f0dc190bdff5d4e3a28d94fa2dd38cfc9c9e24acd71a2918e74807cf142f4b6c`. The graph/task identities, evidence requirements, and scoring oracle are preserved. | Benchmark provenance/negative tests pass. v108 (`c9dbc751818709abb07f7861febc07e0b1a4f38fbb4b4ddde043d7195a190cc2`) and all successors v109-v116 remain byte-for-byte preserved; active v117 SHA-256 is `f0dc190bdff5d4e3a28d94fa2dd38cfc9c9e24acd71a2918e74807cf142f4b6c`. The failed RC.64/v110 run with `PROVENANCE_SOURCE_HASH_MISMATCH: package.json` remains in `npm-test-rc64-20261029T100605Z.log`; v117 records the current source pins without rewriting any historical fixture. |
| Goal/Idea → Plan → Execution Graph security boundary must remain connected end to end. | `tests/test-adaptive-goal-current-scope-producer-e2e.mjs` and `tests/test-adaptive-goal-execution-graph-proposal.js`; the RC.65 package validation log records `AGG_THREE_GRAPH_CHAIN=PASS`, typed artifact lineage and nine actions. The full suite also passes the separate snapshot-verifier, reviewer-identity, immutable-plan, trust and proposal regression suites. The rollback snapshot guard rejected a temporary edit to historical `server/index.js`; that file was restored to its pinned hash before RC.65 packaging. Negative controls reject unverified source plans without persistence. | Local deterministic/test-root E2E passes. It does not establish production trust, release authority, or permission to dispatch production work. |

CodeGraph was synced after the code/fixture changes. Its file-mode view shows the exact RC.65 backpressure timeout and fail-stop code; its file-level dependency report does not statically connect the dynamically selected manifest runtime to the spawned-process regression tests. That graph limitation is recorded rather than represented as a missing test: the two tests above select the runtime from `plugin/manifest.json`, and the extracted-package validation ran those exact packaged bytes.

## Validation evidence

The machine-readable acceptance index and per-command logs live under `artifacts/adaptive-goal-graph/run-baseline-integrated-20261029T1535+0700/`. The index binds the actual command, exit code, artifact path/hash, freshness, and limitations. Key outcomes:

The final index is `artifacts/adaptive-goal-graph/run-baseline-integrated-20261029T1535+0700/acceptance-evidence-index-local-rc65-20261029T1052Z.json`; its companion SHA-256 manifest is `artifacts/adaptive-goal-graph/run-baseline-integrated-20261029T1535+0700/final-artifact-hashes-rc65-20261029T1052Z.sha256`. These are local integrity inventories, not signed release attestations.

- `npm test` on package version `1.0.9-rc.65` and fixture v117: **PASS, exit 0** (`npm-test-rc65-v117-final-20261029T103748Z.log`).
- `node --test tests/test-adaptive-goal-benchmark.mjs`: **PASS, 15/15** (`benchmark-v117-regression-20261029T103724Z.log`).
- `npm run test:phase2-security-regressions`: **PASS, exit 0** (`phase2-security-rc65-20261029T104214Z.log`); contract result still blocked at 105 versus 71 entries.
- Local package build with archive-extracted smoke, schema, lifecycle, trust, recovery, and graph E2E checks: **PASS, exit 0** (`package-rc65-build-20261029T104044Z.log`).
- `npm run test:package-reproducibility` against the current v117 source snapshot: **PASS, exit 0** (`package-reproducibility-rc65-20261029T104315Z.log`).
- `node tests/test-package-no-overwrite.js` against the current source snapshot: **PASS, exit 0** (`package-no-overwrite-rc65-20261029T104556Z.log`).
- RC.65 source alignment: **PASS exact archive-entry bytes**, 105 entries, 74 tools (`source-alignment-rc65-final-20261029T104207Z.json`, SHA-256 `f7d85716379d74d1e004ad9e996bf5b1c569f8ffe5385d654c77b0a31d91401f`). This is not authenticated build provenance.
- RC.23, RC.63, and RC.64 source-alignment negative controls: all **exit 1 as expected**, rejecting current manifest/archive byte mismatches (`source-alignment-rc23-after-rc65-20261029T104723Z.log`, `source-alignment-rc63-after-rc65-20261029T104723Z.log`, `source-alignment-rc64-after-rc65-20261029T104723Z.log`).
- Pinned RC.63 candidate-inventory negative control: **exit 1 as expected**, with `source/archive bytes differ` (`pinned-rc63-lineage-negative-after-rc65-20261029T104744Z.log`). The byte-lineage guard was not weakened.
- Final documentation/link check, `git diff --check`, and CodeGraph status are recorded in the RC.65 machine-readable acceptance index after this dossier is finalized.

## Fresh operational and host-trust evidence

The latest read-only workflow reconciliation is `workflow-reconciliation-current-rc65-20261029T104359Z.json` (SHA-256 `005806519bccbdb448b24743a4752db6e27270eb721ef59bf2fdbd3f8b055ab9`). It observed 86 jobs: 60 stale candidates requiring owner reconciliation, 7 awaiting dispatch, and 19 awaiting proposal/approval. It observed 736 tasks, including 61 running tasks without active lease rows or execution metadata, and **zero authoritative terminal dispositions**. It is diagnostic-only and reports no lifecycle mutation.

The presence-only host trust snapshot is `current-host-trust-presence-rc65-20261029T104658Z.json` (SHA-256 `97b35ab6b4501bf0769029083c3feea1d008ab08e35d1bff2992b361f5bdd11e`). The inspected trust environment variables are unset and the required `/etc/runalith` policy files and `/usr/local/libexec/runalith/external-checkpoint-adapter` are absent. This does not prove the state of an external checkpoint; it shows the required host-managed trust path is not available for verification here.

The final read-only rollout preflight is `preflight-rc65-final-20261029T104707Z.json` (SHA-256 `277ef5563940b98a033f40a53cd15014855b4be0657af199e6f4197b218938e9`); exit code 3 is the expected blocked decision. `liveMutationPerformed=false`, `workflowDatabaseMutationPerformed=false`, `externalSecurityStoreMutationPerformed=false`, and external checkpoint transition is `NOT_REQUESTED`.

## The six release blockers and accountable dependency

1. **`PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — contract owner.** Supply the authoritative, canonical 71-path manifest and its required owner signature. A count of 71 is not a path list. RC.65 has 105 entries; do not trim files or infer the contract.
2. **`INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — controlled builder and independent verifier/release approver.** Supply a signed builder receipt bound to exact RC.65 archive bytes and source snapshot, independently verified release evidence, and approval bound to the candidate, baseline, and rollback bytes. Local hashes, local tests, and this dossier are not substitutes.
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
