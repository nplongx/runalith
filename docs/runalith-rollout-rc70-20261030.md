# Runalith 1.0.9-rc.70 rollout dossier — Execution Graph source-draft binding

## Decision

**BLOCKED — do not install, activate, publish, approve, or dispatch this candidate in production.** RC.70 is a locally built engineering successor. Tests, exact archive alignment, and reproducible local builds prove local behavior/identity only; they do not establish controlled-host builder provenance, independent release approval, production trust, external checkpoint continuity, or authoritative workflow/task drain.

- Candidate: `dist/runalith-1.0.9-rc.70-execution-graph-source-draft-binding-20261030.mcpb`
- Version: `1.0.9-rc.70`
- SHA-256: `8880f411eaeee05ecd83a664bfd17dd944787178fb1e7c82e5263fe78c9b25f2`
- Size: 957,397 bytes; 105 archive entries; 75 tools; 104 entries byte-identical to local source plus one projected metadata entry
- Entrypoint: `server/index-v1.0.9-rc.70-execution-graph-source-draft-binding-v123-20261030.js`
- Entrypoint SHA-256: `1c3e2e61600e2d87a38c6a92ad7cc00aec2171c7b4131bc5d5a270052061af5b`
- Source snapshot SHA-256: `bc39a47ee14d668511f9bcf2d2d8000508670f09ff16a741506a473cc5d4750e`
- Source alignment: `PASS_EXACT_ARCHIVE_ENTRY_BYTES`
- Source provenance: `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`
- Release eligibility: `BLOCKED_AUTHENTICATED_BUILD_RECEIPT_AND_INDEPENDENT_AUTHORITY_REQUIRED`
- Local rollback reference: `dist/runalith-1.0.9-rc.26-executing-state-reconciliation-final2-20261028.mcpb`; hash `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a`. This is local byte evidence only, not production rollback authorization.

## Engineering change in this successor

Execution Graph proposal contract is now **version 2** and includes `source.planGraphDraftSnapshot`. The serialized verifier recomputes the original Plan Graph draft hash, binds it to the pinned graph hash and candidate ID, verifies deterministic Plan Graph step IDs and requires a one-to-one mapping from source draft steps to Execution Graph nodes. Each node's `sourceNodeId`, kind, title, dependency set, role/task binding and downstream edge must match the source draft. Durable runtime readback continues independently rebuilding the proposal from the current Plan Graph and trusted Goal/Idea source; the embedded draft/hash is structural integrity, not an authentication primitive.

The new negative regression rewrites `sourceNodeId`, derives new deterministic step/node IDs, changes binding/dependency/edge references and recomputes exposed component hashes and the outer fingerprint. Contract v2 rejects that self-consistent-looking forgery because it no longer maps to the original source draft. V1 serialized Execution Graph proposals without the source-draft body fail closed and are not silently upgraded.

The previous RC.69 reviewer-attestation ingestion remains present. `adaptive_goal_reviewer_attestation_ingest` persists only an externally signed reviewer identity assertion; it does not approve, pin a plan, create tasks, dispatch or grant execution authority. The test provider key is fixture-only. The identity provider's authentication of a real human, production roots/revocation, maker-checker semantics and policy-defined quorum remain external/contract gates.

The active benchmark provenance fixture is `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v123.json`. It retains `schemaVersion: 117`, `fixtureId: recovery-verifier-investigation-v117`, `supersedesFixtureId: recovery-verifier-investigation-v116`, and the exact frozen graph/task/node/edge ground-truth/scoring oracle. Fixtures v108, v117, v118, v119, v120, v121 and v122 are preserved byte-for-byte. The failed fully re-hashed `sourceNodeId` exploration and schema/fixture identity attempts remain in separate immutable logs/artifacts.

## Validation evidence and result codes

All evidence paths below are relative to `artifacts/adaptive-goal-graph/run-baseline-integrated-20261029T1535+0700/`.

| Validation | Result | Evidence |
|---|---|---|
| `node --test tests/test-adaptive-goal-execution-graph-proposal.js tests/test-adaptive-goal-execution-plan-candidate.js` | **PASS, 21/21** | `rc70-proposal-candidate-focused-v123-20261030T0100+0700.log` |
| `node --test tests/test-adaptive-goal-benchmark.mjs` | **PASS, 15/15** | `rc70-benchmark-v123-20261030T0100+0700.log` and clean rerun `rc70-benchmark-v123-clean-rerun-20261030T0110+0700.log` |
| `node --test tests/test-adaptive-goal-current-scope-producer-e2e.mjs` | **PASS, 1/1** | `rc70-goal-plan-execution-e2e-v123-20261030T0120+0700.log` |
| `npm test` | **PASS, exit 0** | `rc70-npm-test-v123-20261030T0200+0700.log` |
| Package build + extracted package acceptance/E2E | **PASS, exit 0** | `rc70-package-build-source-draft-binding-v123-20261030T0140+0700.log` |
| `node scripts/test-mcpb-candidate.mjs ...rc.70...mcpb` | **PASS**, 75 manifest/runtime tools | `rc70-candidate-smoke-v123-20261030T0230+0700.log` |
| `node scripts/verify-mcpb-source-alignment.mjs --bundle ... --output ...` | **PASS_EXACT_ARCHIVE_ENTRY_BYTES**, 105 entries, 75 tools | `source-alignment-rc70-v123-20261030T0230+0700.json` |
| Direct MCP catalog | **PASS**, 75 tools; reviewer ingestion present | `rc70-tool-catalog-v123-20261030T0230+0700.json` |
| `node tests/test-package-reproducibility.js` | **PASS**, two bit-identical builds | `rc70-package-reproducibility-v123-20261030T0300+0700.log` |
| `node tests/test-package-no-overwrite.js` | **PASS, exit 0** | `rc70-package-no-overwrite-v123-20261030T0300+0700.log` |
| `npm run test:phase2-security-regressions` | **PASS, exit 0**; frozen 71-path contract still unresolved | `rc70-phase2-security-v123-20261030T0300+0700.log` |
| `npm run docs:check` | **PASS**, 176 Markdown files/366 local links; 75 tools documented | `rc70-docs-check-v123-20261030T0200+0700.log` |
| `git diff --check` | **PASS, exit 0** | `rc70-diff-check-v123-20261030T0200+0700.log` |
| `codegraph sync .` | **PASS**, 7 changed files synced | `rc70-codegraph-sync-v123-20261030T0200+0700.log` |
| Read-only rollout preflight with RC.26 reference | **BLOCKED, expected exit 3** | `preflight-rc70-v123-20261030T0310+0700.json`; independent correctly scoped validation `rc70-preflight-verification-v2-v123-20261030T0330+0700.log` |
| Read-only workflow/task reconciliation | **PASS as diagnostic only, exit 0** | `workflow-reconciliation-readonly-rc70-v123-20261030T0340+0700.json` |

The clean benchmark rerun returned exit 0. A preceding wrapper run printed all 15 tests as passing but returned exit 2 from a shell quoting error; that original log is preserved and is not represented as a clean pass. The preflight report itself returned the expected exit 3 and preserved the six gates. An auxiliary checker first looked for a non-existent `productionAuthorityGranted` property at an incorrect JSON level; the preflight schema has `decision.status` and `decision.canActivateNow` but not that field. That helper's failed attempt is retained; the corrected validation checks the actual schema and passes. Neither issue was fixed by altering production-readiness state.

The source-tree full suite and extracted package E2E both exercised the Goal/Idea → Plan → Execution chain, immutable-plan checks, reviewer ingestion, sandbox-only execution, crash/restart recovery, duplicate/concurrent dispatch guards, invalid/stale/tampered evidence and negative controls. These are local deterministic fixtures: claim verification and independent attestation in a test report do not mean a production authority has issued either.

## Read-only operational observation — stale diagnostic only

The latest local database report is `2026-10-29T13:46:26.160Z` UTC and reports 86 jobs considered: 60 flagged for owner reconciliation, 7 awaiting dispatch, and 19 awaiting proposal/approval. It observes 736 tasks, including 61 tasks marked running without active lease rows and without execution metadata; zero authoritative terminal dispositions were assessed. The database file mtime is `2026-10-28T16:11:32.410Z`, so this is a stale local SQLite snapshot, not current provider/host state. Missing leases do not prove worker death. No jobs, tasks, attempts, leases, approvals or providers were changed.

## Six required production gates — all still open

1. **`PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED`** — Phase 2 contract owner/platform security/controlled builder must provide the canonical owner-signed 71-path manifest and candidate-bound custody/build receipt. RC.70 has 105 archive entries; archive count and the local Phase 2 security pass do not establish which 71 paths are authoritative. Do not trim paths or weaken lineage checks by inference.
2. **`INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`** — controlled builder, independent verifier, authorized release approver and host operator must supply independently verifiable builder receipt, source/target byte proof, release decision/signatures, required host nonce and exact candidate/source/rollback binding. The two reproducible local builds are not an independent builder authority.
3. **`PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`** — authorized host/security administrator and independent Goal/Idea and reviewer-identity authorities must provision production roots, exact scopes, revocation/rotation state and host-managed runtime configuration; trust domains must be independently administered and disjoint.
4. **`PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`** — host/security authority and independent external checkpoint-store authority must provide the adapter, pinned roots, monotonic external anchor and fresh signed continuity/CAS receipts. No trust-ledger write or external checkpoint transition was attempted.
5. **`ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`** — each workflow owner plus provider/runtime operator must reconcile current job and external-effect lineage and provide an authoritative disposition. Do not infer that any worker stopped from this stale SQLite file.
6. **`RUNNING_TASKS_MUST_DRAIN`** — each task owner plus provider/runtime and lease authority must verify attempt/result/artifact/completion lineage and supply authoritative terminal dispositions for ambiguous tasks. Do not bulk-reset, retry, cancel, terminalize or redispatch uncertain remote effects.

The Approval Subsystem also remains incomplete at the policy boundary: the authoritative owner must define authenticated maker/requester identity, checker separation, quorum threshold and trust-domain constraints. RC.70 strengthens source identity mapping; it does not invent or silently set those policy decisions. Every approval and the dispatcher must continue independently verifying current policy, exact plan pin, action intent, scope and evidence immediately before execution.

Current preflight reports `decision.status=BLOCKED`, `decision.canActivateNow=false`, all six gates, `readOnly=true`, and false live/workflow/external-security mutation flags. External checkpoint state is `NOT_REQUESTED`. This local evidence is not release or production authority.

## Preservation and actions not performed

RC.23, RC.26, RC.63–RC.69, all prior MCPB candidates, prior acceptance indexes/manifests, failure logs and benchmark fixtures v108/v117/v118/v119/v120/v121/v122 remain preserved. The historical README source-pin mismatch is retained. No commit, reset/clean, history rewrite, production activation/publication, live approval/dispatch, workflow/task/lease mutation, host registry/process change, trust-ledger write, external checkpoint transition, or fabricated signature/approval/authority artifact was performed.

## Next work

Continue independent code/test work while authority handoffs proceed. The highest-value next engineering gap is to establish the documented versioned Approval Subsystem contract for authenticated maker/checker identity, policy quorum, trust-domain constraints, immutable plan/action/evidence scope, expiry/revocation and replay/concurrency safety, then exercise it via independent dispatcher revalidation. Do not claim objective completion or activate while any required gate remains open.
