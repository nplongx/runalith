# Goal / Plan / Execution Graph acceptance — RC.12 candidate

**Decision: BLOCKED — test-only candidate; no production authorization.**

Prepared 2026-10-27 from the v39 integration baseline plus a fail-closed rollout-gate correction. This document is a local acceptance dossier, not an authenticated release approval, builder attestation, host receipt, or evidence that hosted workflows ran.

## Candidate and baseline identity

- Candidate version: `1.0.9-rc.12` (test-only successor; not installed or activated).
- Candidate archive: `/tmp/runalith-provenance-integrated-v40-20261027.mcpb`.
- Candidate SHA-256: `e106b8ba16762d2f280e06cb88e10faadb7063c5416bd0bd5db73bd93dfa9adb`; size: `836984` bytes; archive entries: `93`; MCP tools: `74`.
- Candidate package integrity, ZIP integrity and extracted-runtime MCP fast smoke: PASS. These are local tests, not independent build provenance.
- RC.12 runtime entrypoint SHA-256: `ae4f2c170bdc639cd6e58662011755f75fd57ca0b9d931fab957b74bf4db44f9`; it is byte-identical to the preserved RC.11 source entrypoint.
- Installed baseline observed by read-only host inspection: `1.0.9-rc.11`, source archive `artifacts/local-test-only/runalith-1.0.9-local-test-only-20261026.mcpb`.
- The source archive was inspected and compared against the live installed generation directory: 93 archive files, exact byte parity, zero mismatches. Rollback SHA-256: `ad32acca11708314a45e82616b5d31c2fda7ae3710ff2f5c764f8fb12b1163c3`, size `827195` bytes. It is a content-matched local-test-only baseline, not a publisher attestation.
- RC.8 v17/v18 are not compatible rollback choices for the installed RC.11 generation. Preserve their historical bytes and hashes; do not relabel them.
- A separately created installed-generation snapshot also passed extracted-runtime smoke and exact parity, but is content-derived and is not the original MCPB or publisher evidence. Prefer the exact existing baseline archive when binding the rollback digest.

## Implementation change

The rollout preflight now requires signed builder provenance, independent candidate-verification evidence, and a separately signed release approval. Those DSSE/SLSA envelopes must bind the exact candidate digest, source snapshot, required tests, policy version, one-time host-issued nonce, installed baseline version/digest, and rollback version/digest. Missing or partial evidence yields `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`; caller-authored `verified` booleans are not accepted as verifier output. Local cryptographic verification still cannot authenticate host trust provisioning or the external monotonic checkpoint.

The candidate version was advanced to RC.12 to avoid reusing the installed RC.11 version. The RC.11 runtime source and historical packages are preserved. The RC.12 runtime entrypoint is initially byte-identical to the current RC.11 source runtime; this is a versioned test candidate, not a claim that an independent builder produced it.

## Required acceptance gates

1. `ROLLBACK_BUNDLE_NOT_VERIFIED` — use a rollback artifact that passes package integrity, extracted-runtime smoke and exact installed-generation file parity; release authority must independently approve the exact digest and restore exercise.
2. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — host/security administrator provisions the two versioned JSON configs through the supported protected mechanism; effective runtime config digests, distinct provider IDs, disjoint canonical SPKI roots, ownership/permissions, rotation and revocation must be independently verified.
3. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — platform security supplies a host-owned authenticated challenge/response and externally protected monotonic high-water proof bound to candidate and rollback digests.
4. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — workflow owners and runtime/provider operators reconcile every executing job against event, attempt, task, result, artifact, completion and authoritative runtime lineage.
5. `RUNNING_TASKS_MUST_DRAIN` — task owners verify each running task's exact attempt, owner/provider, lease fencing where available, result/artifact hashes and completion evidence.
6. `CANDIDATE_VERSION_ALREADY_INSTALLED` — addressed locally by creating a new RC.12 candidate identity; release approval and host preflight still need to bind its exact digest.
7. `ROLLBACK_VERSION_DOES_NOT_MATCH_INSTALLED_BASELINE` — addressed for the inspected baseline when the exact RC.11 source archive is used and exact parity remains true; the release authority must approve its digest and isolated restore compatibility.
8. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — obtain signed SLSA provenance from the controlled builder, a separately signed candidate-verification predicate, and release-authority approval. Local tests, byte alignment, local signing keys and the candidate's own claims do not satisfy this gate.

## Live graph and recovery policy

The read-only reconciliation report is the source for job/task inventory, Goal/Idea snapshot and attestation findings, planner evidence resolution and Plan/Execution Graph proposal findings. Re-query every unresolved record with its owner/provider/runtime authority. Missing leases or old timestamps are not proof of worker death. No bulk reset, retry, terminalization, approval, dispatch, lease mutation or live database write is permitted from diagnostics alone.

## Separate historical Phase 2 release gate

`npm run test:phase2-security-regressions` exits `1` at `benchmarks/plugin-workflow-benchmark/test-create-phase2-candidate-inventory.mjs` after the filesystem, worker-boundary, execution-verifier, provider and diagnostic tests pass. The inventory gate reports that none of eight historical `dist/` candidate archives has exact current-source lineage; their first mismatch is `README.md`, and additional packaged source entries are mixed/unattributed. The frozen 71-path contract explicitly remains unchanged. This is a separate historical Phase 2 release-eligibility blocker; do not rewrite the 71-path inventory or relabel old archives to make it pass. The RC.12 MCPB is evaluated under its separate 93-entry exact-source-byte contract. Full log: `/tmp/runalith-phase2-security-v40-20261027.log`; the manifest binds its exact digest and observed exit code.

## Verification boundary

Fresh read-only preflight report: `/tmp/runalith-preflight-v40-final-20261027.json`, SHA-256 `e24c063595f6e37f60bf968f75f40e8b6e763cb9e62e40911e10f419e4dacea3`, generated `2026-10-27T07:21:44.348Z`, exit code `3`, `readOnly=true`, `liveMutationPerformed=false`. It verified the RC.11 rollback archive against the installed generation (93/93 files, zero mismatches), reducing the decision to five blockers: `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`, `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`, `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`, `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`, and `RUNNING_TASKS_MUST_DRAIN`. The candidate-version conflict and rollback parity/version mismatch no longer appear in this report.

Fresh read-only reconciliation report: `/tmp/runalith-reconcile-v40-20261027.json`, SHA-256 `d2164d36009be8ee2f7c358f86e741ff3ac23cb1df2f229e4fd53a7f6619e717`, observed `2026-10-27T06:54:06.873Z`. It inventoried 137 jobs, 5,308 events, 1,277 tasks, 982 attempts, 908 results, 867 artifacts, 119 approvals and zero lease rows. Of 85 jobs inspected, 60 require owner reconciliation, seven await dispatch, and 18 await proposal/approval. The graph inventory has two goals and zero stored attestations; four current planner source references fail byte validation. There are three Plan Graph proposals with 22 steps, all 22 missing supporting evidence; all three lack authenticated snapshot binding and independent source revalidation. No Execution Graph proposal or execution-plan candidate event was observed. These remain diagnostic findings, not permission to mutate lifecycle.

Active benchmark successor: `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v40.json`, SHA-256 `9a575a74104ab153132fcb61cd212dcaeec7d29e8420aef6ef898268ae2bdd30`. The frozen benchmark tasks and ground-truth oracle are unchanged from v39, whose historical fixture SHA-256 remains `a914ba38828665a2d9190c040d2d0c5d7bfdc8d0184e8336c4e7cb9cfabdf952`. Benchmark tests pass 15/15; final generated benchmark report SHA-256 `c4130fb630efc71a399ac41cd62202c8a185f9cd79bf773dbdb1551595e8a404`.

Full `npm test` passed, exit 0; final log `/tmp/runalith-npm-test-integrated-v40-final-20261027.log`, SHA-256 `e8accd705d74a53fcae057370824cc52440bb434a5732426e7a8f49b695b62ff`. Focused trust/graph/producer/reconciliation/E2E/source-alignment suite passed 150/150; log SHA-256 `592d8c3a721a61f5ba2560c4496bd0820de80bc70b65c976a80511cb855dea24`. Package reproducibility passed; final log `/tmp/runalith-package-repro-v40-final-20261027.log`, SHA-256 `c4c40fd73b40828dd1d915ee8dc38a0ff41dbe7f2c1ab1b0d49733c62595d59c`. MCP direct tools passed 3/3; log SHA-256 `d7245438b94504bef9628b80cd2a964023e44c2bb52be8991b134d2ca331a9e1`. Documentation check passed (94 Markdown files, 331 local links), static site check passed (12 local, 19 external checks, 74 tools), and `git diff --check` passed.

The final source-to-bundle alignment report is `/tmp/runalith-alignment-v40-final5-20261027.json`. It verifies `PASS_EXACT_ARCHIVE_ENTRY_BYTES`: 92 exact source entry bytes plus one projected package-metadata entry, 93 archive entries, and 74 tools. The worktree is dirty, so its source provenance remains `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT` and release eligibility remains blocked. The exact report digest, source-snapshot digest and source-provenance digest are bound in the successor evidence manifest, avoiding recursive source-diff hashes embedded in this document.

Full tests and packaged-runtime tests establish local regression acceptance only. Exact archive-entry alignment establishes byte correspondence only. The repository remains dirty and no authenticated build receipt, independent hosted verifier attestation, release approval, host-effective trust provisioning, or authenticated external monotonic checkpoint has been supplied. Therefore the candidate remains **BLOCKED** until all gates are independently satisfied.
