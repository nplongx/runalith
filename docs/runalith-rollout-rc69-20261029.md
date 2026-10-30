# Runalith 1.0.9-rc.69 local rollout dossier — 2026-10-29

## Decision

**BLOCKED — do not install, activate, publish, approve or dispatch in production.** RC.69 is a locally built engineering successor. Its tests and byte-alignment evidence do not establish independent release provenance, production trust, external checkpoint continuity, or authoritative workflow/task drain.

- Candidate: `dist/runalith-1.0.9-rc.69-reviewer-attestation-ingestion-provenance-v121-20261029.mcpb`
- Version: `1.0.9-rc.69`
- SHA-256: `54f7f2204d0278d355f375a00cf06eb057355a97e59b262425d798e8437c5c5f`
- Size: 956,725 bytes; 105 archive entries; 75 tool definitions; 4,106,937 expanded bytes
- Entry point: `server/index-v1.0.9-rc.69-reviewer-attestation-ingestion-provenance-v120-20261029.js`
- Selected source snapshot SHA-256: `140cd5bb268078d75417f37e1ca41945d52d4bd1befc0b29cfb7ecc0b0307aa6`
- Source alignment: `PASS_EXACT_ARCHIVE_ENTRY_BYTES`
- Source provenance: `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`
- Release eligibility: `BLOCKED_AUTHENTICATED_BUILD_RECEIPT_AND_INDEPENDENT_AUTHORITY_REQUIRED`
- Local rollback reference: `dist/runalith-1.0.9-rc.26-executing-state-reconciliation-final2-20261028.mcpb`; this is a local reference, not production rollback authorization.

Exact archive-entry byte identity establishes that the selected bundled files match the current local sources. It does not authenticate the builder, independent verifier, release approver, production trust roots, host runtime, or provider state.

## RC.69 engineering delta

RC.69 adds `adaptive_goal_reviewer_attestation_ingest`, a versioned MCP contract for ingestion of an **externally issued** Ed25519 reviewer-identity assertion. The runtime ingestion function acquires a workflow-database writer transaction, rebuilds the current candidate, checks source freshness and exact candidate/plan/action-intent/task-input/semantic-policy/role-contract bindings, delegates signature/trust/scope/expiry/replay checks to the verifier shared by approval/dispatch, persists one event, and requires exact readback before commit. Failed validation rolls back the inserted event. An exact retry is idempotent; conflicting assertions, nonce replay, stale snapshots, signature or subject mismatch, and lifecycle advancement fail closed.

Ingestion is evidence-only: it does **not** grant workflow approval, pin a plan, create tasks, dispatch, or authorize execution. The identity provider—not Runalith or the MCP caller—must authenticate the actual human reviewer and authorize `agg.action_intent.review` before signing. A locally signed fixture proves only test behavior; it is not production reviewer identity evidence. The implementation intentionally does not invent maker-checker identity semantics or quorum thresholds absent an authoritative policy contract.

The Goal/Idea → Plan → Execution E2E path now goes through the ingestion MCP tool instead of inserting a reviewer event directly with SQL. It verifies that an invalid signer creates no durable reviewer event, a valid isolated test signature binds to the candidate, and review evidence remains distinct from workflow approval and execution authority. Graph chain test output still reports `claimVerified=0` and `independentAttestations=0`; those are not promoted to verified production claims.

The active benchmark provenance fixture is `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v121.json`. It retains the runner's frozen `schemaVersion:117`, `fixtureId:recovery-verifier-investigation-v117`, v117 graph/task identities, ground-truth oracle and scoring. Historical v108, v117, v118 and v119 remain unchanged. V120 is retained as an immutable intermediate artifact for a rejected fixture-identity attempt; it is not the active fixture.

## Validation evidence

| Check | Result | Evidence |
|---|---|---|
| `npm test` | **PASS, exit 0** | `artifacts/adaptive-goal-graph/run-baseline-integrated-20261029T1535+0700/rc69-npm-test-v121-20261029T2120+0700.log` |
| `node --test tests/test-adaptive-goal-benchmark.mjs` | **PASS, 15/15** | `.../rc69-benchmark-v121-20261029T2110+0700.log` |
| Package build and extracted validation/E2E | **PASS, exit 0** | `.../rc69-package-build-v121-20261029T2140+0700.log` |
| `node scripts/test-mcpb-candidate.mjs ...rc69...mcpb` | **PASS**, 75 manifest/runtime tools | `.../rc69-candidate-smoke-20261029T2200+0700.log` |
| `node scripts/verify-mcpb-source-alignment.mjs --bundle ... --output ...` | **PASS_EXACT_ARCHIVE_ENTRY_BYTES**, 105 entries, 75 tools | `.../source-alignment-rc69-v121-20261029T2200+0700.json` |
| Direct MCP catalog read | **PASS**, 75 tools; reviewer-ingestion tool present | `.../rc69-tool-catalog-direct-20261029T2210+0700.json` |
| `node tests/test-package-reproducibility.js` | **PASS, exit 0** | `.../rc69-package-reproducibility-v121-20261029T2220+0700.log` |
| `node tests/test-package-no-overwrite.js` | **PASS, exit 0** | `.../rc69-package-no-overwrite-v121-20261029T2220+0700.log` |
| `npm run test:phase2-security-regressions` | **PASS, exit 0** | `.../rc69-phase2-security-v121-20261029T2220+0700-retry.log` |
| Read-only rollout preflight with RC.26 local rollback reference | **BLOCKED, expected exit 3** | `.../preflight-rc69-v121-20261029T2230+0700.json` |
| Read-only active-workflow/task reconciliation | **PASS as diagnostic only, exit 0** | `.../workflow-reconciliation-readonly-rc69-v121-20261029T2235+0700.json` |

All log paths above are relative to `artifacts/adaptive-goal-graph/run-baseline-integrated-20261029T1535+0700/`. The full test suite includes current reviewer identity/ingestion tests, end-to-end Goal/Idea → Plan → Execution integration, fail-closed negative controls, package boundaries, workflow recovery/idempotency, trust contracts, telemetry, benchmark, rollout, documentation-linked policy checks, and acceptance-consistency regressions.

The first RC.68 package-build attempt failed because an extracted test still hard-coded 71 default tools after the runtime catalog advanced to 72; the failure note/log is retained. An earlier full test attempt exposed stale v119 source pins after source changes; its log is retained. V120 benchmark validation failed because a filename-level fixture identity conflicted with the runner's frozen schemaVersion 117 identity; that failure log and v120 fixture are retained. V121 corrects the fixture identity while preserving the graph/scoring oracle. These failures have not been overwritten or relabeled as successes.

## Read-only operational observation — diagnostic only

The latest local SQLite reconciliation report is generated at `2026-10-29T13:07:01.390Z` (UTC). It reports 86 active jobs considered: 60 flagged for owner reconciliation, 7 awaiting dispatch and 19 awaiting proposal/approval. Of 736 relevant tasks observed, 61 are marked running without active lease rows and without execution metadata; zero authoritative terminal dispositions were assessed by this local diagnostic. The database file mtime was `2026-10-28T16:11:32.410Z`, so the underlying local snapshot is stale relative to this report time. The report explicitly labels its metrics diagnostic-only and states that it cannot establish current provider execution state or that external effects have stopped. **Do not infer worker death from missing leases or act on these counts as live provider truth.** No jobs, tasks, attempts, leases, approvals or providers were mutated.

## Six unresolved production blockers and handoff

1. **`PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED`** — Phase 2 contract owner/platform security/controlled builder must provide the canonical owner-signed 71-path manifest, exact candidate-bound build receipt and host-pinned policy. The current archive has 105 entries; no local path list or count may substitute for the contract owner's signed path set.
2. **`INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`** — controlled builder, independent verifier, authorized release approver and host operator must provide independently verifiable receipts/signatures bound to the exact RC.69 archive/source snapshot and approved rollback bytes, including required host-issued nonce and release decision.
3. **`PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`** — authorized host/security administrator and both independent trust authorities must provision the production Goal/Idea verifier and reviewer identity policies, valid authority-issued roots, exact scopes and revocation/rotation state; verify disjoint trust domains and runtime ledger bindings.
4. **`PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`** — host/security authority and independently operated checkpoint-store authority must provision and verify the host-managed adapter, distinct authority/store roots, monotonic external anchor and current signed continuity/CAS receipts. No ledger write or checkpoint transition was attempted.
5. **`ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`** — each workflow owner plus provider/runtime operator must reconcile all active/executing jobs and give authoritative disposition evidence. Missing lease rows and stale local timestamps do not prove a worker stopped.
6. **`RUNNING_TASKS_MUST_DRAIN`** — each task owner plus provider/runtime and lease authority must verify task/attempt/result/artifact/completion lineage and external execution state, and supply authoritative terminal dispositions for all ambiguous running tasks. Do not bulk-reset, retry, cancel, terminalize or redispatch uncertain effects.

The current preflight records `readinessDecision=BLOCKED`, `canActivateNow=false`, and `productionAuthorityGranted=false`. All live/workflow/external security mutation flags are false and external checkpoint transition is `NOT_REQUESTED`. Candidate creation, local hashes, E2E results, and this dossier are not independent authority evidence.

## Preservation and actions not performed

RC.23, RC.26, RC.63–RC.68, their archives, previous evidence indexes/manifests, prior run logs and fixture v108/v117/v118/v119 remain preserved. The historical README hash mismatch remains visible. No commit, clean/reset, production activation or publication, live approval/dispatch, workflow/task/lease mutation, host process/registry change, trust-ledger write, external checkpoint transition, synthetic production signature, or authority fabrication was performed.

## Next highest-value step

Continue independent engineering only where a concrete source/test gap exists. In parallel, hand off the six named evidence/authority requirements to their owners and wait for signed, candidate-bound or provider-authoritative evidence before any readiness claim. After any such evidence arrives, verify its provenance and freshness and rerun the read-only preflight against the exact candidate and rollback identities. Do not activate while a required gate remains open.
