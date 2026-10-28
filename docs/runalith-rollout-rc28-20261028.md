# Runalith RC.28 rollout dossier — 2026-10-28

## Decision

**`BLOCKED`; do not activate RC.28 or dispatch production.** RC.28 is a versioned successor to RC.27. The runtime implementation is carried forward unchanged. Its primary change is to promote the CodeGraph-derived AGG regression set into the normal `npm test` acceptance path, so graph/evidence/trust dependencies discovered by static call-graph analysis do not remain outside the required suite.

## CodeGraph CLI investigation

The work used the installed CodeGraph CLI (`codegraph` version `1.6.0`) against `/home/long/work/chatgpt-adapter`, not a hand-derived source list.

```sh
codegraph status .
codegraph explore -p . --max-files 9 'Find runtime tool registration and dispatch for adaptive_goal_knowledge_snapshot_get and adaptive_goal_knowledge_verifier: how current graph snapshot, evidence references and manifest are read and gated; identify caller/callee path and tests'
codegraph node -p . normalizeEvidenceManifest
codegraph callers -p . -l 20 normalizeEvidenceManifest
codegraph callers -p . -l 20 resolveAdaptiveGoalSourceEvidence
codegraph impact -p . -d 4 buildAggReadinessDossier
printf '%s\n' src/runtime/adaptive-goal-knowledge-verifier.js src/runtime/adaptive-goal-source-evidence.js src/runtime/adaptive-goal-trust-configuration.js scripts/build-agg-readiness-dossier.mjs | codegraph affected -p . --stdin -d 5 -f 'tests/test-adaptive-goal-*' -j
```

Recorded index status before the RC.28 change: 480 files, 17,719 nodes and 78,502 edges; `Index is up to date`. CodeGraph traced `normalizeEvidenceManifest` to `readPersistedAttestation`, `getCurrentVerification`, `getAttestationRequest` and `attest`. The source explicitly permits an empty manifest only for diagnosis while returning `eligibleForAttestation=false` and `KNOWLEDGE_EVIDENCE_MANIFEST_EMPTY`. It also distinguishes byte integrity from claim truth and independence. The investigation found no safe software shortcut around these gates.

The focused CodeGraph affected-test prediction contained 23 tests. Ten were not explicitly referenced by the `npm test` command string; two telemetry tests were already executed by its nested `test:agg-telemetry` script. Eight additional AGG regressions were therefore added to `test:agg-codegraph-regression` and made a required part of `npm test`:

- benchmark integrity and compatibility regressions;
- local MCP knowledge-capture and knowledge-store coverage;
- local-LLM failure handling;
- sandbox executor fail-closed behavior;
- source-evidence path, hash, length and symlink boundaries.

CodeGraph is used for static symbol/dependency/test selection, not to prove runtime trust, evidence truth, release signatures or production authorization. Its `affected` command returns no test names without an explicit test glob in this repository; release automation must not interpret that empty default result as proof that no tests are affected. Full tests remain the acceptance authority for software behavior.

## Candidate identity

- Candidate output: `dist/runalith-1.0.9-rc.28-codegraph-agg-regressions-20261028.mcpb`.
- Runtime entry point: `server/index-v1.0.9-rc.28.js`.
- Installed production baseline: RC.26, not RC.27 or RC.28.
- Intended rollback archive: `artifacts/runalith-1.0.9-rc.26-solo-graph-20261028.mcpb`; verify its bytes and exact installed-baseline parity in every fresh preflight.
- The RC.27 archive and benchmark fixture v69 remain historical immutable artifacts. RC.28 uses fixture v70 as its successor.

The candidate digest, source snapshot digest, archive inventory, manifest, entrypoint, reproducible-build result, exact source-to-bundle report, package MCP fast-test output and fresh preflight report must be recorded after the RC.28 build. A byte-identical local rebuild and a clean source tree are integrity/reproducibility evidence only; they do not constitute an authenticated builder receipt or independent release approval.

## Current production blockers

The latest verified live observations remain the RC.26 runtime's observations captured by the RC.27 dossier process:

- Goal/Idea scope `runalith-agg-e2e-20261026-clean`: 7 nodes, 7 edges, 7 memberships, snapshot hash `80001cbece6811f7e3a0c187662393f05393ed11421767b23d76548c77c32bf3`, zero evidence references, empty manifest and `eligibleForAttestation=false`.
- `AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON` and `AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON` are blank in the effective runtime; both domains are unavailable and have no configured roots.
- Read-only reconciliation observes 4 source-hash mismatches, 3 Plan Graph proposals with 22/22 steps missing supporting evidence, 3 proposals without authenticated current-snapshot binding, and no persisted Execution Graph proposal.
- The latest reconciliation inventory records 138 jobs, 1,277 tasks, 5,309 events, 908 results, 867 artifacts, 982 attempts, 119 approvals and zero task-lease rows. It classifies 60 jobs for owner reconciliation and 61 running tasks without active leases. No missing lease or PID observation proves worker death.

These facts are observations from the captured source reports, not authorization to modify the live graph or lifecycle. Capture new reports before any future activation decision.

## Six RC.23 gates still open

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — Phase 2 contract owner must supply the canonical authority-signed 71-path manifest; the controlled builder must supply a candidate-bound receipt; platform security must independently provision/pin the authority roots and policy.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — independent builder, verifier and release authority must supply signatures and a fresh host-issued nonce bound to the exact candidate, installed baseline and rollback digest.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — host/security administrator and both independent trust authorities must provision exact versioned JSON configs, distinct provider identities and disjoint Ed25519 SPKI roots, and prove the effective process uses them with matching ledger versions/fingerprints.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — host/security and external checkpoint-store authorities must provision a root-owned adapter/policy and supply fresh signed, monotonic, candidate/rollback-bound continuity and CAS/commit receipts.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — every executing job requires owner/provider/runtime disposition backed by exact event/attempt/result/artifact and execution-state lineage.
6. `RUNNING_TASKS_MUST_DRAIN` — every running task requires provider/runtime and lease authority; retain `HOLD` where outcome is uncertain.

Do not bulk-reset or terminalize jobs, kill runtimes, dispatch, install/activate the candidate, or advance the external checkpoint as a diagnostic. Re-run read-only reconciliation and rollout preflight against the exact candidate and rollback once the owners' evidence is available.

## Validation commands

```sh
npm test
npm run test:agg-codegraph-regression
npm run solo:graph
npm run test:package-reproducibility
npm run test:mcpb-candidate -- dist/runalith-1.0.9-rc.28-codegraph-agg-regressions-20261028.mcpb
npm run docs:check
npm run docs:check:external
git diff --check
```

Then run `unzip -t`, `sha256sum`, source alignment, and a read-only rollout preflight with the exact installed RC.26 rollback bytes. A preflight exit code `3` is an expected blocked decision. Do not claim `READY` based on CodeGraph, tests, matching hashes or healthy runtime status.
